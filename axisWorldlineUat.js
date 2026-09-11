// axisWorldlineUat.js — UAT receiver for the Worldline "Aggregator Transaction Notification"
// API V1 (Axis Bank BQR/UPI). Spec: "Aggregator Transaction Notification V1" PDF.
//
// WHAT THIS IS FOR
// Worldline's server POSTs successful transactions to a URL we provide. This is that URL for
// UAT. It CAPTURES AND VALIDATES ONLY, into the `axis_worldline_uat` collection, whose columns
// mirror webhook_data so post-UAT integration into the main table is a straight copy.
//
//   Worldline's URL https://<host>/prod/axis-worldline-webhook is served by axisWorldline.js
//   (the LIVE money path) — this router lives at /uat/axis-worldline-webhook and also receives
//   the raw copy of every notification the live route rejects (decrypt/validation failure).
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
// ENCRYPTION (§1.1): the real request is `{ "data": "<encrypted string>" }` —
// AES-256-GCM (AES/GCM/NoPadding), the 16 random IV bytes prefixed to the Java-style
// ciphertext, i.e. IV || ciphertext || 16-byte auth tag, transport-encoded (base64, possibly
// percent-encoded as in the spec's own sample; hex accepted too). Key comes from
// AXIS_WL_AES_KEY (64 hex chars, base64, or 32 raw chars — must be 32 bytes). With no key
// configured, or on any decrypt failure, the body is still captured raw with every parsed
// field null and a warning — nothing is dropped, nothing is rejected. Decrypted/flat sample
// payloads (§1.3.1–1.3.3) are parsed field-by-field.

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const moment = require('moment-timezone');

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

const IV_LEN = 16;
const TAG_LEN = 16; // Java's AES/GCM/NoPadding appends the 128-bit tag to the ciphertext

// AXIS_WL_AES_KEY as 64 hex chars, base64, or 32 raw chars. Returns null when unset;
// throws nothing — a bad key must not stop the server booting.
function loadAesKey(log = console.warn) {
    const raw = (process.env.AXIS_WL_AES_KEY || '').trim();
    if (!raw) return null;
    const candidates = [
        /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : null,
        Buffer.from(raw, 'base64'),
        Buffer.from(raw, 'utf8'),
    ];
    const key = candidates.find((b) => b && b.length === 32);
    if (!key) log('⚠️  AXIS_WL_AES_KEY is set but does not decode to 32 bytes — Worldline payloads will be captured encrypted.');
    return key || null;
}

// base64, percent-encoded base64 (as in the spec's own sample), or hex → bytes.
function decodeTransport(str) {
    let text = String(str).trim();
    if (text.includes('%')) { try { text = decodeURIComponent(text); } catch { /* not percent-encoded */ } }
    return /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0
        ? Buffer.from(text, 'hex')
        : Buffer.from(text, 'base64');
}

// How many bytes the transport string decodes to — for the failure log only.
function decodedByteLength(str) {
    try { return decodeTransport(str).length; } catch { return null; }
}

// IV || ciphertext || tag → parsed JSON object. Throws on any tampering (GCM auth failure).
function decryptWorldlineData(str, key) {
    const buf = decodeTransport(str);
    if (buf.length <= IV_LEN + TAG_LEN) throw new Error(`encrypted payload too short (${buf.length} bytes, need > ${IV_LEN + TAG_LEN})`);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN));
    decipher.setAuthTag(buf.subarray(buf.length - TAG_LEN));
    const plain = Buffer.concat([
        decipher.update(buf.subarray(IV_LEN, buf.length - TAG_LEN)),
        decipher.final(),
    ]).toString('utf8');

    const obj = JSON.parse(plain);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('decrypted payload is not a JSON object');
    return obj;
}

// Map a decrypted Worldline notification onto webhook_data field names (§1.1.1).
// Never throws — every problem becomes a warning. A body still encrypted at this point
// (no key, or decrypt failed) yields all-null fields plus a warning.
function normalizeWorldline(body, rupeesToPaiseStrict) {
    const warnings = [];

    const encryptedOnly = typeof body.data === 'string' && !body.primary_id && !body.ref_no;
    if (encryptedOnly) {
        warnings.push('payload still encrypted — captured raw, no fields parsed');
        return { paymentId: null, qrCodeId: null, rrnNumber: null, amountPaise: null, vpa: null, createdAtIso: null, warnings };
    }

    // §1.1.1: primary_id is the mandatory unique id; tr_id is the UPI txn id.
    const paymentId = body.primary_id || body.tr_id || null;
    if (!paymentId) warnings.push('no primary_id/tr_id — cannot dedup this notification');

    // mid IS our qrCodeId for Worldline (decided; tid is optional in the spec and absent
    // from the live UPI notifications — it stays in the raw payload). mid is mandatory,
    // so a missing one is a malformed notification.
    const qrCodeId = body.mid || null;
    if (!qrCodeId) warnings.push('no mid — QR unidentifiable');

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

    // §1.1.1 time_stamp is `yyyymmddHHmmss` IST WALL TIME (the §1.3.1 sample's
    // 20231222002458 IST == 20231221185458 UTC, which is exactly the timestamp embedded
    // in its own secondary_id). Store the transaction time like every other provider —
    // Appwrite's $createdAt already records when we received it.
    let createdAtIso = null;
    if (body.time_stamp) {
        const m = moment.tz(String(body.time_stamp), 'YYYYMMDDHHmmss', true, 'Asia/Kolkata');
        if (m.isValid()) createdAtIso = m.toISOString();
        else warnings.push(`unparseable time_stamp: ${body.time_stamp}`);
    }

    if (body.txn_currency && body.txn_currency !== '356') warnings.push(`non-INR currency: ${body.txn_currency}`);
    if (!body.transaction_type) warnings.push('no transaction_type field');
    else if (body.transaction_type !== '1' && body.transaction_type !== '2') warnings.push(`unexpected transaction_type: ${body.transaction_type}`);
    if (!body.time_stamp) warnings.push('no time_stamp field');

    return { paymentId, qrCodeId, rrnNumber, amountPaise, vpa, createdAtIso, warnings };
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
    APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID,
    rupeesToPaiseStrict,
    authenticateAdmin
) => {
    const router = express.Router();
    const AES_KEY = loadAesKey();

    // Matches partnerApi.js — Appwrite reports a bad/expired cursor as a 400, not a 404.
    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
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

            // §1.1: decrypt `{ data: "<IV+ciphertext+tag>" }` before mapping. Failures are
            // warnings, never rejections — the raw envelope is still captured.
            let mapped = body;
            let payloadJson = JSON.stringify(body);
            const cryptoWarnings = [];
            if (typeof body.data === 'string' && !body.primary_id && !body.ref_no) {
                if (!AES_KEY) {
                    cryptoWarnings.push('encrypted payload — AXIS_WL_AES_KEY not configured, captured raw');
                    console.warn('🔐 Axis Worldline: encrypted payload but AXIS_WL_AES_KEY is not set — captured raw. data.length=', body.data.length);
                } else {
                    try {
                        mapped = decryptWorldlineData(body.data, AES_KEY);
                        payloadJson = JSON.stringify({ data: body.data, decrypted: mapped });
                        console.log('🔓 Axis Worldline: decrypted OK:', JSON.stringify(mapped));
                    } catch (e) {
                        mapped = body;
                        cryptoWarnings.push(`decryption failed: ${e?.message || e}`);
                        // UAT diagnostics: everything needed to compare notes with the bank —
                        // the raw string, how it decoded, sizes. NEVER the key itself.
                        console.error('🔐 Axis Worldline DECRYPTION FAILED', JSON.stringify({
                            error: e?.message || String(e),
                            sourceIp: req.ip,
                            rawData: body.data,
                            rawLength: body.data.length,
                            percentEncoded: body.data.includes('%'),
                            decodedBytes: decodedByteLength(body.data),
                            keyBytes: AES_KEY.length,
                            ivLen: IV_LEN,
                            tagLen: TAG_LEN,
                            fullBody: body,
                        }, null, 2));
                        // Handled — the request is still answered SUCCESS and the row is still
                        // stored. Printed only so the failing line is visible in Render logs.
                        console.error('🔐 (handled, response is still SUCCESS) stack:', e?.stack || e);
                    }
                }
            }

            const parsed = normalizeWorldline(mapped, rupeesToPaiseStrict);
            parsed.warnings = [...cryptoWarnings, ...parsed.warnings];
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
                        payload: cap(payloadJson, CAPS.payload),
                        qrCodeId: cap(parsed.qrCodeId, CAPS.qrCodeId),
                        paymentId: cap(parsed.paymentId, CAPS.paymentId),
                        rrnNumber: cap(parsed.rrnNumber, CAPS.rrnNumber),
                        amount: parsed.amountPaise,
                        vpa: cap(parsed.vpa, CAPS.vpa),
                        provider: 'axis_worldline',
                        created_at: cap(parsed.createdAtIso || receivedAt, CAPS.created_at),
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

// Shared with axisWorldline.js (the LIVE ingest path) so both routes decrypt and map the
// notification identically — the UAT capture is the rehearsal for exactly this mapping.
module.exports.loadAesKey = loadAesKey;
module.exports.decryptWorldlineData = decryptWorldlineData;
module.exports.normalizeWorldline = normalizeWorldline;
