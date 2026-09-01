// axisWorldlineUat.js — UAT receiver for the Worldline "Aggregator Transaction Notification"
// API V1 (Axis Bank BQR/UPI). Spec: "Aggregator Transaction Notification V1" PDF.
//
// WHAT THIS IS FOR
// Worldline's server POSTs successful transactions to a URL we provide. This is that URL for
// UAT. It CAPTURES AND VALIDATES ONLY, into the `axis_worldline_uat` collection, whose columns
// mirror webhook_data so post-UAT integration into the main table is a straight copy.
//
//   Give Worldline:
//     URL     https://<host>/prod/axis-worldline-webhook    (HTTP POST, application/JSON)
//   The /prod prefix is only the mount path (see server.js) — this router stays capture-only.
//
// HARD SAFETY RULES — same contract as uatWebhook.js, do not relax:
//   1. NO LOCKS. Never acquire `lock:qr:<id>` or any production lock key here.
//   2. Its only write target is the Axis Worldline UAT collection. It never touches
//      webhook_data, QR ledgers, daily summaries, Redis counters, sockets, or partner webhooks.
//   3. `finalizeTransaction` is not among its injected dependencies — no code path here can
//      credit money even by accident. Real ingest belongs in the finalize pipeline.
//
// RESPONSE CONTRACT (§1.2 — differs from every other webhook in this repo):
// Worldline expects JSON `{ "status": "SUCCESS", "errorMsg": "" }` and retries the same call
// 2 more times when no response is received. So: anything parseable as a JSON object is
// recorded and answered SUCCESS (a duplicate retry is also SUCCESS — that stops the retries);
// only a genuinely failed save answers `{ "status": "FAILED", "errorMsg": "…" }`.
//
// ENCRYPTION (§1.1): the real request is `{ "data": "<encrypted string>" }`. Until the bank
// shares the decryption key/algorithm, an encrypted-only body is captured raw with every
// parsed field null and a warning — nothing is dropped. Decrypted/flat sample payloads
// (§1.3.1–1.3.3) are parsed field-by-field.

const express = require('express');
const rateLimit = require('express-rate-limit');

// Max stored length per attribute — MUST stay in sync with
// scripts/setup-axis-worldline-uat-schema.js. Values are truncated before writing so an
// oversized field can never turn a UAT post into a FAILED (Appwrite rejects over-length strings).
const CAPS = {
    payload: 1000000,
    qrCodeId: 64,
    paymentId: 64,
    rrnNumber: 64,
    vpa: 255,
    provider: 32,
    created_at: 40,
    status: 24,
    ownerSubadminId: 64,
    warningsJson: 4096,
    sourceIp: 64,
};

// The spec defines no auth header, so rate limiting is the only brute-force guard on this
// public POST (capture-only table — worst case is junk rows, never money).
const AXIS_WL_RATE_LIMIT_PER_MIN = Number(process.env.AXIS_WL_RATE_LIMIT_PER_MIN) || 60;
const wlLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: AXIS_WL_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    handler: (req, res) => res.status(429).json({ status: 'FAILED', errorMsg: 'Rate limit exceeded' }),
});

// Truncate-and-stringify. Returns null for absent values so Appwrite stores nothing.
function cap(value, max) {
    if (value === undefined || value === null) return null;
    const s = String(value);
    return s.length > max ? s.slice(0, max) : s;
}

module.exports = (
    databases, ID, Query,
    APPWRITE_DATABASE_ID,
    APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID,
    rupeesToPaiseStrict,
    authenticateAdmin
) => {
    const router = express.Router();

    // Matches partnerApi.js — Appwrite reports a bad/expired cursor as a 400, not a 404.
    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
    }

    // Map a decrypted Worldline notification onto webhook_data field names (§1.1.1).
    // Never throws — every problem becomes a warning. An encrypted-only body
    // ({ data: "<string>" }) yields all-null fields plus a warning.
    function normalize(body) {
        const warnings = [];

        const encryptedOnly = typeof body.data === 'string' && !body.primary_id && !body.ref_no;
        if (encryptedOnly) {
            warnings.push('encrypted payload only — no decryption key configured, captured raw');
            return { paymentId: null, qrCodeId: null, rrnNumber: null, amountPaise: null, vpa: null, warnings };
        }

        // §1.1.1: primary_id is the mandatory unique id; tr_id is the UPI txn id.
        const paymentId = body.primary_id || body.tr_id || null;
        if (!paymentId) warnings.push('no primary_id/tr_id — cannot dedup this notification');

        // tid is optional in the spec; mid is mandatory. qrCodeId is the derived identifier
        // the rest of the system would key on — the captures tell us what Worldline really
        // sends before anyone writes the production mapping.
        const qrCodeId = body.tid || body.mid || null;
        if (!body.tid) warnings.push(qrCodeId ? 'no tid — fell back to mid' : 'no tid and no mid — QR unidentifiable');

        const rrnNumber = body.ref_no || null;
        if (!rrnNumber) warnings.push('no ref_no (RRN)');

        // §1.1.1: txn_amount is a RUPEE string ("500.00"). Convert exactly once, string-based.
        let amountPaise = null;
        const amountNum = Number(body.txn_amount);
        if (body.txn_amount === undefined || body.txn_amount === null || body.txn_amount === '' || !Number.isFinite(amountNum)) {
            warnings.push('txn_amount missing or not numeric');
        } else {
            amountPaise = rupeesToPaiseStrict(body.txn_amount);
            if (!Number.isFinite(amountPaise)) {
                amountPaise = null;
                warnings.push('txn_amount could not be converted to paise');
            } else if (amountPaise < 0) {
                warnings.push('negative txn_amount');
            }
        }

        // customer_vpa is mandatory for UPI (transaction_type 2), absent on BQR card (type 1).
        const vpa = body.customer_vpa || null;
        if (!vpa && body.transaction_type === '2') warnings.push('UPI txn without customer_vpa');

        if (body.txn_currency && body.txn_currency !== '356') warnings.push(`non-INR currency: ${body.txn_currency}`);
        if (!body.transaction_type) warnings.push('no transaction_type field');
        else if (body.transaction_type !== '1' && body.transaction_type !== '2') warnings.push(`unexpected transaction_type: ${body.transaction_type}`);
        if (!body.time_stamp) warnings.push('no time_stamp field');

        return { paymentId, qrCodeId, rrnNumber, amountPaise, vpa, warnings };
    }

    // ── POST /uat/axis-worldline-webhook ─────────────────────────────────────
    router.post(
        '/axis-worldline-webhook',
        // No-ops when the global parser already handled it; catches a non-JSON Content-Type,
        // which would otherwise leave req.body empty and burn one of Worldline's 3 attempts.
        express.json({ type: '*/*', limit: '1mb' }),
        wlLimiter,
        async (req, res) => {
            console.log('📩 Axis Worldline UAT webhook received from', req.ip);
            const body = req.body;
            console.log('📩 Axis Worldline UAT webhook body:', JSON.stringify(body));
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
                return res.status(400).json({ status: 'FAILED', errorMsg: 'Empty or unparseable body' });
            }

            const parsed = normalize(body);
            const receivedAt = new Date().toISOString();

            try {
                // ponytail: unlocked dedup — two simultaneous retries of the same primary_id can
                // both insert. Harmless (no money is moved, the raw payload is identical); a lock
                // here would be worse than a duplicate row in a capture log.
                if (parsed.paymentId) {
                    const existing = await databases.listDocuments(
                        APPWRITE_DATABASE_ID,
                        APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID,
                        [Query.equal('paymentId', parsed.paymentId), Query.limit(1)]
                    );
                    if (existing.documents.length) {
                        // §1: WL retries when unacknowledged — SUCCESS stops the retries.
                        return res.status(200).json({ status: 'SUCCESS', errorMsg: '' });
                    }
                }

                await databases.createDocument(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID,
                    ID.unique(),
                    {
                        payload: cap(JSON.stringify(body), CAPS.payload),
                        qrCodeId: cap(parsed.qrCodeId, CAPS.qrCodeId),
                        paymentId: cap(parsed.paymentId, CAPS.paymentId),
                        rrnNumber: cap(parsed.rrnNumber, CAPS.rrnNumber),
                        amount: parsed.amountPaise,
                        vpa: cap(parsed.vpa, CAPS.vpa),
                        provider: 'axis_worldline',
                        created_at: cap(receivedAt, CAPS.created_at),
                        status: 'normal',
                        // ownerSubadminId deliberately unset — no owner resolution on the capture path
                        warningsJson: cap(JSON.stringify(parsed.warnings), CAPS.warningsJson),
                        sourceIp: cap(req.ip, CAPS.sourceIp),
                    }
                );

                // §1.2 response contract — exactly this shape, nothing extra.
                return res.status(200).json({ status: 'SUCCESS', errorMsg: '' });
            } catch (error) {
                console.error('❌ Failed to record Axis Worldline UAT notification:', error?.message || error);
                return res.status(500).json({ status: 'FAILED', errorMsg: 'Failed to record notification' });
            }
        }
    );

    // ── GET /uat/axis-worldline-webhook/captures ─────────────────────────────
    // Admin-only read-back of what Worldline actually posted. Cursor-paginated.
    router.get('/axis-worldline-webhook/captures', authenticateAdmin, async (req, res) => {
        const { limit = 25, cursor, paymentId } = req.query;
        const limitNum = Math.min(parseInt(limit, 10) || 25, 100);

        if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
            return res.status(400).json({ error: 'Invalid cursor format' });
        }

        try {
            const queries = [Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (paymentId) queries.push(Query.equal('paymentId', paymentId));
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const result = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID,
                queries
            );

            const pickCapture = (d) => ({
                id: d.$id,
                paymentId: d.paymentId,
                qrCodeId: d.qrCodeId,
                rrnNumber: d.rrnNumber,
                amount: d.amount,
                amountRs: typeof d.amount === 'number' ? d.amount / 100 : null,
                vpa: d.vpa,
                provider: d.provider,
                created_at: d.created_at,
                warnings: (() => { try { return JSON.parse(d.warningsJson || '[]'); } catch { return []; } })(),
                payload: d.payload,
            });

            const docs = result.documents.map(pickCapture);
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].id : null;

            return res.status(200).json({ captures: docs, nextCursor, limit: limitNum });
        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('Axis Worldline UAT captures error:', error);
            return res.status(500).json({ error: 'Failed to fetch UAT captures' });
        }
    });

    // Body-parse failures raised by this router's own parser come back as the spec's FAILED
    // shape rather than Express's default HTML error page.
    router.use((err, req, res, next) => {
        if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
            return res.status(400).json({ status: 'FAILED', errorMsg: 'Empty or unparseable body' });
        }
        return next(err);
    });

    return router;
};
