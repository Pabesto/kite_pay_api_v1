// uatWebhook.js — UAT (Demo-environment) receiver for the Razorpay Notification API v4.0,
// covering the UPI (§5.10) and Bharat QR (§5.11) payload shapes.
//
// WHAT THIS IS FOR
// Razorpay requires the merchant to hand over a static URL + authorization details so their
// Demo environment can post test notifications before production go-live (§4.3). This is that
// URL. It CAPTURES AND VALIDATES ONLY.
//
//   Give Razorpay:
//     URL     https://<host>/uat/razorpay-webhook          (HTTP POST, application/json)
//     Auth    Authorization: Bearer <UAT_WEBHOOK_TOKEN>    (§4.2 option 2 — static token)
//             or  X-UAT-Token: <UAT_WEBHOOK_TOKEN>
//   Generate the token with `openssl rand -hex 32` into .env — never into a tracked file.
//
// HARD SAFETY RULES — do not relax any of these:
//   1. NO LOCKS. This endpoint must never acquire `lock:qr:<id>` or any other production
//      lock key. A UAT payload carrying a real `tid` would otherwise stall a live payment
//      for the full 15s TTL. Dedup here is deliberately best-effort and unlocked.
//   2. Its only write target is the UAT collection. It never touches webhook_data, QR
//      ledgers, daily summaries, Redis counters, sockets, or partner webhooks.
//   3. `finalizeTransaction` is not among its injected dependencies, so no code path here
//      can credit money even by accident.
//   4. This router is mounted at MORE THAN ONE PATH (`/uat` and `/prod` — see server.js).
//      All of them are capture-only. The no-money guarantee comes from the dependencies the
//      factory is given, NOT from the path, so `/prod` is not "the real one". Do not add
//      crediting here for one path: real ingest belongs in the finalize pipeline.
//
// WHY IT RETURNS 200 FOR ALMOST EVERYTHING (deliberate divergence from the live webhooks)
// The production webhooks in server.js return 400 on an unexpected payload. This one does not.
// §4.4: Razorpay expects HTTP 200 within 1–2s, retries every 15 min a maximum of 3 times, and
// after 3 non-200s "no further notification posting will be attempted for such transactions".
// A 400 during UAT therefore burns the integration attempt and hides the very payloads we are
// running UAT to see. §4.4 also states notifications arrive for VOIDED / REFUNDED / PENDING
// states, not just successful ones. So: anything parseable as a JSON object is recorded with
// a 200 and a `warnings` list. Do not "fix" this to match production.
//
// TWO MAPPING TRAPS THE DOC EXPOSES (both handled below)
//   * §5.11 Bharat QR carries NO `id`/`Id` field. Live /razorpay-webhook reads `data.Id`.
//     §5.3 documents `txnId` as the unique 25-char transaction id — use that first.
//   * §5.3 marks `tid` (Terminal ID) as CARD-ONLY, and neither the UPI nor the Bharat QR
//     sample contains it. Live /razorpay-webhook reads `data.tid` as the QR id. Here we fall
//     back to `username` and record a warning, so the captures tell us what Razorpay really
//     sends before anyone changes the production mapping.

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Max stored length per attribute — MUST stay in sync with scripts/setup-uat-webhook-schema.js.
// Values are truncated to these before writing so a freak oversized field can never 500 a
// UAT post (Appwrite rejects over-length strings).
const CAPS = {
    payload: 1000000,
    txnId: 64,
    qrCodeId: 64,
    tid: 32,
    mid: 32,
    rrnNumber: 64,
    paymentMode: 16,
    providerStatus: 24,
    txnType: 16,
    settlementStatus: 16,
    currencyCode: 8,
    amountRupeesRaw: 32,
    vpa: 255,
    externalRefNumber: 64,
    merchantCode: 64,
    username: 32,
    postingDate: 40,
    created_at: 40,
    warningsJson: 4096,
    sourceIp: 64,
};

// Rate limit on the public POST — the token is the only gate, so this is the brute-force guard.
const UAT_RATE_LIMIT_PER_MIN = Number(process.env.UAT_RATE_LIMIT_PER_MIN) || 60;
const uatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: UAT_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    handler: (req, res) => res.status(429).json({ error: 'Rate limit exceeded. Slow down and retry shortly.' }),
});

// Constant-time secret comparison. Hashing both sides first makes the buffers equal-length by
// construction — raw timingSafeEqual throws on a length mismatch and leaks the token length.
function secretEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Truncate-and-stringify. Returns null for absent values so Appwrite stores nothing.
function cap(value, max) {
    if (value === undefined || value === null) return null;
    const s = String(value);
    return s.length > max ? s.slice(0, max) : s;
}

module.exports = (
    databases, ID, Query,
    APPWRITE_DATABASE_ID,
    APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID,
    rupeesToPaiseStrict,
    authenticateAdmin
) => {
    const router = express.Router();

    if (!process.env.UAT_WEBHOOK_TOKEN) {
        console.warn('⚠️  UAT_WEBHOOK_TOKEN is not set — POST /uat/razorpay-webhook will refuse every request (503).');
    }

    // Matches partnerApi.js — Appwrite reports a bad/expired cursor as a 400, not a 404.
    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
    }

    // §4.2 option 2 — static token in the header. Fails closed when unconfigured.
    function requireUatToken(req, res, next) {
        const expected = process.env.UAT_WEBHOOK_TOKEN;
        if (!expected) {
            return res.status(503).json({ error: 'UAT endpoint not configured' });
        }
        const presented = req.headers['x-uat-token']
            || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!secretEquals(presented, expected)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    }

    // Map a flat Razorpay notification body onto our field names, per §5.3 and the
    // §5.10 / §5.11 samples. Never throws — every problem becomes a warning.
    function normalize(body) {
        const warnings = [];

        // §5.3: txnId is the documented unique id and is present in every sample; `id` is
        // undocumented and absent from the Bharat QR sample.
        const txnId = body.txnId || body.id || body.Id || null;
        if (!txnId) warnings.push('no txnId/id — cannot dedup this notification');
        else if (!body.txnId) warnings.push('no txnId — fell back to the undocumented id field');

        // §5.3 marks `tid` card-only and the UPI/Bharat QR samples omit it, but Razorpay have
        // since confirmed they will send `tid` and `mid` for our account. Both are kept as
        // their own fields — `tid`/`mid` record what actually arrived, `qrCodeId` is the
        // derived identifier the rest of the system would key on. The fallback stays so a
        // notification that arrives without `tid` is still captured rather than dropped.
        const tid = body.tid || null;
        const mid = body.mid || null;
        let qrCodeId = tid;
        if (!qrCodeId) {
            qrCodeId = body.username || null;
            warnings.push(qrCodeId ? 'no tid — fell back to username' : 'no tid and no username — QR unidentifiable');
        }
        if (!mid) warnings.push('no mid — Razorpay confirmed this should be present');

        // §5.3: amount is Double(15,2) in RUPEES. Convert exactly once, string-based.
        let amountPaise = null;
        const amountNum = Number(body.amount);
        if (body.amount === undefined || body.amount === null || body.amount === '' || !Number.isFinite(amountNum)) {
            warnings.push('amount missing or not numeric');
        } else {
            amountPaise = rupeesToPaiseStrict(body.amount);
            if (!Number.isFinite(amountPaise)) {
                amountPaise = null;
                warnings.push('amount could not be converted to paise');
            } else if (amountPaise < 0) {
                warnings.push('negative amount');
            }
        }

        // §5.3: AUTHORIZED is the only successful value. The rest are recorded, not rejected.
        const providerStatus = body.status || null;
        if (!providerStatus) warnings.push('no status field');
        else if (providerStatus !== 'AUTHORIZED') warnings.push(`non-AUTHORIZED status: ${providerStatus}`);

        const paymentMode = body.paymentMode || null;
        if (!paymentMode) warnings.push('no paymentMode field');
        else if (paymentMode !== 'UPI' && paymentMode !== 'BHARATQR') warnings.push(`unexpected paymentMode: ${paymentMode}`);

        const currencyCode = body.currencyCode || null;
        if (currencyCode && currencyCode !== 'INR') warnings.push(`non-INR currency: ${currencyCode}`);

        // §5.10 puts the payer VPA in payerName ("ppriya1486@kotak"); §5.11 has neither field.
        // Live /razorpay-webhook reads customerName only, hence the explicit order here.
        const vpa = body.payerName || body.customerName || null;

        // Epoch MILLISECONDS in both samples (1536728120140 / 1535728349000).
        let postingDate = null;
        if (body.postingDate !== undefined && body.postingDate !== null) {
            const d = new Date(body.postingDate);
            if (isNaN(d.getTime())) warnings.push('postingDate is not a valid date');
            else postingDate = d.toISOString();
        } else {
            warnings.push('no postingDate field');
        }

        return {
            txnId,
            qrCodeId,
            tid,
            mid,
            amountRupeesRaw: body.amount === undefined ? null : String(body.amount),
            amountPaise,
            providerStatus,
            paymentMode,
            txnType: body.txnType || null,
            settlementStatus: body.settlementStatus || null,
            rrnNumber: body.rrNumber || null,          // doc spelling: rrNumber
            vpa,
            currencyCode,
            externalRefNumber: body.externalRefNumber || null,
            merchantCode: body.merchantCode || body.orgCode || null,
            username: body.username || null,
            postingDate,
            warnings,
        };
    }

    // ── POST /uat/razorpay-webhook ───────────────────────────────────────────
    // Capture + validate. Responds JSON (not the plain text the live webhooks use) because
    // the normalized echo is the whole point of running UAT.
    router.post(
        '/razorpay-webhook',
        // No-ops when the global parser already handled it; catches a non-JSON Content-Type,
        // which would otherwise leave req.body empty and waste a Razorpay setup cycle.
        express.json({ type: '*/*', limit: '1mb' }),
        uatLimiter,
        requireUatToken,
        async (req, res) => {
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
                return res.status(400).json({ error: 'Empty or unparseable body' });
            }

            const parsed = normalize(body);
            const receivedAt = new Date().toISOString();

            try {
                // ponytail: unlocked dedup — two simultaneous retries of the same txnId can both
                // insert. Harmless (no money is moved, the raw payload is identical) and taking a
                // lock here would be far worse than a duplicate row. Add one only if UAT volume
                // ever makes the log confusing.
                if (parsed.txnId) {
                    const existing = await databases.listDocuments(
                        APPWRITE_DATABASE_ID,
                        APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID,
                        [Query.equal('txnId', parsed.txnId), Query.limit(1)]
                    );
                    if (existing.documents.length) {
                        return res.status(200).json({
                            received: true,
                            duplicate: true,
                            docId: existing.documents[0].$id,
                            parsed,
                            warnings: parsed.warnings,
                        });
                    }
                }

                const created = await databases.createDocument(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID,
                    ID.unique(),
                    {
                        payload: cap(JSON.stringify(body), CAPS.payload),
                        txnId: cap(parsed.txnId, CAPS.txnId),
                        qrCodeId: cap(parsed.qrCodeId, CAPS.qrCodeId),
                        tid: cap(parsed.tid, CAPS.tid),
                        mid: cap(parsed.mid, CAPS.mid),
                        rrnNumber: cap(parsed.rrnNumber, CAPS.rrnNumber),
                        paymentMode: cap(parsed.paymentMode, CAPS.paymentMode),
                        providerStatus: cap(parsed.providerStatus, CAPS.providerStatus),
                        txnType: cap(parsed.txnType, CAPS.txnType),
                        settlementStatus: cap(parsed.settlementStatus, CAPS.settlementStatus),
                        currencyCode: cap(parsed.currencyCode, CAPS.currencyCode),
                        amountPaise: parsed.amountPaise,
                        amountRupeesRaw: cap(parsed.amountRupeesRaw, CAPS.amountRupeesRaw),
                        vpa: cap(parsed.vpa, CAPS.vpa),
                        externalRefNumber: cap(parsed.externalRefNumber, CAPS.externalRefNumber),
                        merchantCode: cap(parsed.merchantCode, CAPS.merchantCode),
                        username: cap(parsed.username, CAPS.username),
                        postingDate: cap(parsed.postingDate, CAPS.postingDate),
                        created_at: cap(receivedAt, CAPS.created_at),
                        warningsJson: cap(JSON.stringify(parsed.warnings), CAPS.warningsJson),
                        sourceIp: cap(req.ip, CAPS.sourceIp),
                    }
                );

                return res.status(200).json({
                    received: true,
                    duplicate: false,
                    docId: created.$id,
                    parsed,
                    warnings: parsed.warnings,
                });
            } catch (error) {
                console.error('❌ Failed to record UAT notification:', error?.message || error);
                return res.status(500).json({ error: 'Failed to record UAT notification' });
            }
        }
    );

    // ── GET /uat/razorpay-webhook/captures ───────────────────────────────────
    // Admin-only read-back of what Razorpay's UAT actually posted. Cursor-paginated.
    router.get('/razorpay-webhook/captures', authenticateAdmin, async (req, res) => {
        const { limit = 25, cursor, txnId } = req.query;
        const limitNum = Math.min(parseInt(limit, 10) || 25, 100);

        if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
            return res.status(400).json({ error: 'Invalid cursor format' });
        }

        try {
            const queries = [Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (txnId) queries.push(Query.equal('txnId', txnId));
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const result = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID,
                queries
            );

            const pickCapture = (d) => ({
                id: d.$id,
                txnId: d.txnId,
                qrCodeId: d.qrCodeId,
                tid: d.tid,
                mid: d.mid,
                rrnNumber: d.rrnNumber,
                paymentMode: d.paymentMode,
                providerStatus: d.providerStatus,
                txnType: d.txnType,
                settlementStatus: d.settlementStatus,
                currencyCode: d.currencyCode,
                amountPaise: d.amountPaise,
                amountRupeesRaw: d.amountRupeesRaw,
                vpa: d.vpa,
                externalRefNumber: d.externalRefNumber,
                merchantCode: d.merchantCode,
                username: d.username,
                postingDate: d.postingDate,
                created_at: d.created_at,
                warnings: (() => { try { return JSON.parse(d.warningsJson || '[]'); } catch { return []; } })(),
                payload: d.payload,
            });

            const docs = result.documents.map(pickCapture);
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].id : null;

            return res.status(200).json({ captures: docs, nextCursor, limit: limitNum });
        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('UAT captures error:', error);
            return res.status(500).json({ error: 'Failed to fetch UAT captures' });
        }
    });

    // Body-parse failures raised by this router's own parser (e.g. text/plain garbage) come
    // back as a clean JSON 400 rather than Express's default HTML error page.
    router.use((err, req, res, next) => {
        if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
            return res.status(400).json({ error: 'Empty or unparseable body' });
        }
        return next(err);
    });

    return router;
};
