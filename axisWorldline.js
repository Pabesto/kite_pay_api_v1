// axisWorldline.js — LIVE ingest for the Worldline "Aggregator Transaction Notification" API V1
// (Axis Bank BQR/UPI). Spec: "Aggregator Transaction Notification V1" PDF. The UAT rehearsal
// for this mapping is axisWorldlineUat.js; decrypt + field mapping are shared from there.
//
// THIS IS A MONEY PATH. Every notification runs the full 7-step ingest choreography from
// CLAUDE.md: validate → lock:qr → dedup under lock → review gate → create webhook_data →
// finalizeTransaction → release. Nothing here credits money any other way.
//
// AUTH: the spec has no auth header. Authenticity comes from the AES-256-GCM auth tag — only
// a holder of AXIS_WL_AES_KEY can produce a `data` string that decrypts. So this route accepts
// ONLY the encrypted envelope `{ "data": "<IV||ciphertext||tag>" }`; a plaintext body is
// rejected with 400 (send those to the UAT router instead).
//
// MAPPING (decrypted §1.1.1 → webhook_data):
//   mid → qrCodeId  (the QR doc must be registered with qrId = mid, else the txn is stored but
//                    never credited — same as every provider; see updateQrTotalAtomic)
//   primary_id → paymentId (dedup key)   ref_no → rrnNumber   customer_vpa → vpa
//   txn_amount "1.00" rupee string → amount 100 paise (rupeesToPaiseStrict, exactly once)
//   time_stamp yyyymmddHHmmss IST → created_at UTC ISO   provider 'axis_worldline'   status 'normal'
//   payload = JSON { data: <raw envelope>, decrypted: {...} }
//
// RESPONSE (§1.2): JSON `{ status: 'SUCCESS'|'FAILED', errorMsg }` — never plain text.
//   200 SUCCESS   saved, held for review, or duplicate (a duplicate is success: it stops retries)
//   400 FAILED    not an encrypted envelope / cannot decrypt / mandatory field missing
//   503 FAILED    lock:qr busy after retries, or no decryption key configured
//   500 FAILED    Appwrite write failed
// Anything that is not ingested (400/503 before the lock) is ALSO captured raw into the UAT
// collection so a bad notification can be replayed once the cause is fixed.

const express = require('express');
const { loadAesKey, decryptWorldlineData, normalizeWorldline } = require('./axisWorldlineUat');

const PROVIDER = 'axis_worldline';
const LOCK_TTL_SECONDS = 15;
// Worldline retries only when it gets NO response, and a FAILED answer may end the retries —
// so give a contended lock a few local retries before giving up.
const LOCK_ATTEMPTS = 3;
const LOCK_RETRY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failed = (res, code, errorMsg) => res.status(code).json({ status: 'FAILED', errorMsg });
const success = (res) => res.status(200).json({ status: 'SUCCESS', errorMsg: '' });

module.exports = (
    databases, ID, Query,
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
    APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID,
    rupeesToPaiseStrict,
    acquireLock,
    releaseLock,
    resolveReviewOwners,
    reviewMode,
    ConfigManager,
    finalizeTransaction,
    emitPendingReview
) => {
    const router = express.Router();
    const AES_KEY = loadAesKey();
    if (!AES_KEY) console.warn('⚠️  AXIS_WL_AES_KEY is not set — POST /axis-worldline-webhook (LIVE) will answer 503 FAILED to every notification.');

    // Best-effort raw capture of a notification we could not ingest. Never throws.
    async function captureRaw(req, warnings) {
        try {
            await databases.createDocument(
                APPWRITE_DATABASE_ID, APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID, ID.unique(),
                {
                    payload: JSON.stringify(req.body).slice(0, 1000000),
                    provider: PROVIDER,
                    created_at: new Date().toISOString(),
                    status: 'normal',
                    warningsJson: JSON.stringify(['LIVE route rejected', ...warnings]).slice(0, 4096),
                    sourceIp: String(req.ip || '').slice(0, 64),
                }
            );
        } catch (e) {
            console.error('❌ Axis Worldline: raw capture of rejected notification failed:', e?.message || e);
        }
    }

    router.post(
        '/axis-worldline-webhook',
        express.json({ type: '*/*', limit: '1mb' }),
        async (req, res) => {
            const body = req.body;
            console.log('📩 Axis Worldline LIVE webhook received from', req.ip);

            // 1. Validate — encrypted envelope only (see AUTH above).
            if (!body || typeof body !== 'object' || typeof body.data !== 'string' || !body.data) {
                return failed(res, 400, 'Expected encrypted { data } envelope');
            }
            if (!AES_KEY) {
                await captureRaw(req, ['AXIS_WL_AES_KEY not configured']);
                return failed(res, 503, 'Decryption key not configured');
            }
            let decrypted;
            try {
                decrypted = decryptWorldlineData(body.data, AES_KEY);
            } catch (e) {
                console.error('🔐 Axis Worldline LIVE DECRYPTION FAILED', JSON.stringify({
                    error: e?.message || String(e), sourceIp: req.ip, rawData: body.data, rawLength: body.data.length, keyBytes: AES_KEY.length,
                }));
                await captureRaw(req, [`decryption failed: ${e?.message || e}`]);
                return failed(res, 400, 'Unable to decrypt notification');
            }
            console.log('🔓 Axis Worldline LIVE decrypted:', JSON.stringify(decrypted));

            const n = normalizeWorldline(decrypted, rupeesToPaiseStrict);
            const missing = !n.paymentId ? 'primary_id' : !n.qrCodeId ? 'mid' : !(n.amountPaise > 0) ? 'txn_amount' : null;
            if (missing) {
                await captureRaw(req, [`mandatory field missing/invalid: ${missing}`, ...n.warnings]);
                return failed(res, 400, `Missing or invalid ${missing}`);
            }
            if (n.warnings.length) console.warn('⚠️  Axis Worldline LIVE mapping warnings:', n.paymentId, n.warnings);

            const { paymentId, qrCodeId, rrnNumber, amountPaise, vpa } = n;
            const isoDate = n.createdAtIso || new Date().toISOString();

            // 2. lock:qr — serializes dedup + create + credit for this QR.
            const lockKey = `lock:qr:${qrCodeId}`;
            let acquired = false;
            for (let i = 0; i < LOCK_ATTEMPTS && !acquired; i++) {
                if (i) await sleep(LOCK_RETRY_MS);
                acquired = await acquireLock(lockKey, paymentId, LOCK_TTL_SECONDS);
            }
            if (!acquired) return failed(res, 503, 'Processing conflict, retry');

            try {
                // 3. Idempotency under the lock — a retry of a saved notification is SUCCESS.
                const existing = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
                    [Query.equal('paymentId', paymentId), Query.limit(1)]
                );
                if (existing.documents.length) return success(res);

                // 4. Owner + review gate.
                const { ownerSubadminId, ownerIds } = await resolveReviewOwners(qrCodeId);
                const reviewWindowMs = Number(ConfigManager.get('txn_review_window_ms', 10000)) || 10000;
                const { manual, fields: reviewFields } = reviewMode.reviewFieldsFor(qrCodeId, ownerIds, amountPaise, reviewWindowMs);

                // 5. Source-of-truth record.
                const created = await databases.createDocument(
                    APPWRITE_DATABASE_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, ID.unique(),
                    {
                        payload: JSON.stringify({ data: body.data, decrypted }),
                        qrCodeId,
                        paymentId,
                        rrnNumber,
                        amount: amountPaise,
                        vpa,
                        provider: PROVIDER,
                        created_at: isoDate,
                        status: 'normal',
                        ownerSubadminId,
                        ...reviewFields,
                    }
                );

                // 6. Held → notify admins only, no increments. Else make it live, exactly once.
                if (manual) {
                    emitPendingReview({
                        $id: created.$id, qrCodeId, paymentId, amount: amountPaise, provider: PROVIDER,
                        vpa, rrnNumber, created_at: isoDate, reviewExpiresAt: reviewFields.reviewExpiresAt, ownerSubadminId,
                    });
                    return success(res);
                }
                await finalizeTransaction(created);
                return success(res);
            } catch (error) {
                console.error('❌ Axis Worldline LIVE ingest failed:', paymentId, error?.message || error);
                return failed(res, 500, 'Failed to record notification');
            } finally {
                // 7. Always release — Lua compare-and-delete, never a plain DEL.
                await releaseLock(lockKey, paymentId);
            }
        }
    );

    // JSON parse failures from this router's own parser → spec's FAILED shape, not HTML.
    router.use((err, req, res, next) => {
        if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return failed(res, 400, 'Empty or unparseable body');
        return next(err);
    });

    return router;
};
