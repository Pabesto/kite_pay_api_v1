// phonepeCapture.js — ingest for PhonePe transactions scraped by our browser extension.
//
// PhonePe gives us a dashboard only (no webhook), so the extension reads the dashboard and
// POSTs rows here. This IS a money path: every row runs the full 7-step ingest choreography
// from CLAUDE.md (validate → lock:qr → dedup under lock → review gate → create → finalize).
//
// AUTH: static key in `X-API-Key`, compared constant-time against PHONEPE_EXTENSION_API_KEY.
// Fails closed (503) when the env var is unset. Rotate by changing the env var and the
// extension setting together.
//
// REQUEST  POST /phonepe-capture   { transactions: [ { paymentId, utr, amount, payerVpa, qrRef, txnTime, status, raw } ] }
//   amount   rupee string exactly as displayed ("1250.00") — converted here, exactly once
//   qrRef    our qrId (the extension maps store/terminal → qrId; server does not guess)
//   txnTime  ISO-8601 with offset ("2026-09-03T15:30:12+05:30") or epoch ms
//   status   only "SUCCESS" is ingested; other rows are reported as `skipped`
// GET /phonepe-capture/ping  → 200 { ok:true } with a valid key (401/503 otherwise). Extension "test key" button.
// RESPONSE 200 { results: [ { paymentId, result: saved|held|duplicate|skipped|busy|invalid|error, error? } ] }
//   Per-row outcome instead of HTTP codes because one batch mixes outcomes. `busy` rows must be
//   re-sent by the extension on its next scrape; `duplicate`/`saved`/`held` are terminal.

const express = require('express');
const crypto = require('crypto');

const MAX_BATCH = 100;
const LOCK_TTL_SECONDS = 15;

// Constant-time compare (same construction as uatWebhook.js — hash first so lengths match).
function secretEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Returns { ok:true, ... } or { ok:false, error }. Never throws.
function normalize(row, rupeesToPaiseStrict) {
    if (!row || typeof row !== 'object') return { ok: false, error: 'row must be an object' };
    const paymentId = String(row.paymentId || '').trim();
    const qrCodeId = String(row.qrRef || '').trim();
    if (!paymentId) return { ok: false, error: 'paymentId required' };
    if (!qrCodeId) return { ok: false, error: 'qrRef required' };
    if (String(row.status || '').toUpperCase() !== 'SUCCESS') return { ok: false, skipped: true, error: `status ${row.status || 'missing'}` };
    if (!/^\d+(\.\d{1,2})?$/.test(String(row.amount || '').trim().replace(/,/g, ''))) return { ok: false, error: 'amount must be a rupee string like "1250.00"' };
    const amountPaise = rupeesToPaiseStrict(String(row.amount).trim().replace(/,/g, ''));
    if (!(amountPaise > 0)) return { ok: false, error: 'amount must be > 0' };
    const t = typeof row.txnTime === 'number' ? new Date(row.txnTime) : new Date(String(row.txnTime || ''));
    if (Number.isNaN(t.getTime())) return { ok: false, error: 'txnTime must be ISO-8601 or epoch ms' };
    return {
        ok: true,
        paymentId, qrCodeId, amountPaise,
        isoDate: t.toISOString(),
        rrnNumber: row.utr ? String(row.utr).trim() : null,
        vpa: row.payerVpa ? String(row.payerVpa).trim() : null,
    };
}

module.exports = (
    databases, ID, Query,
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
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

    if (!process.env.PHONEPE_EXTENSION_API_KEY) {
        console.warn('⚠️  PHONEPE_EXTENSION_API_KEY is not set — POST /phonepe-capture will refuse every request (503).');
    }

    function requireExtensionKey(req, res, next) {
        const expected = process.env.PHONEPE_EXTENSION_API_KEY;
        if (!expected) return res.status(503).json({ error: 'PhonePe capture not configured' });
        if (!secretEquals(req.headers['x-api-key'], expected)) return res.status(401).json({ error: 'Unauthorized' });
        next();
    }

    // Steps 2–7 of the ingest choreography for one row. Returns a result string.
    async function ingest(n, raw) {
        const lockKey = `lock:qr:${n.qrCodeId}`;
        if (!(await acquireLock(lockKey, n.paymentId, LOCK_TTL_SECONDS))) return 'busy';
        try {
            const existing = await databases.listDocuments(
                APPWRITE_DATABASE_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
                [Query.equal('paymentId', n.paymentId), Query.limit(1)]
            );
            if (existing.documents.length) return 'duplicate';

            const { ownerSubadminId, ownerIds } = await resolveReviewOwners(n.qrCodeId);
            const reviewWindowMs = Number(ConfigManager.get('txn_review_window_ms', 10000)) || 10000;
            const { manual, fields: reviewFields } = reviewMode.reviewFieldsFor(n.qrCodeId, ownerIds, n.amountPaise, reviewWindowMs);

            const created = await databases.createDocument(
                APPWRITE_DATABASE_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, ID.unique(),
                {
                    payload: JSON.stringify(raw),
                    qrCodeId: n.qrCodeId,
                    paymentId: n.paymentId,
                    rrnNumber: n.rrnNumber,
                    amount: n.amountPaise,
                    vpa: n.vpa,
                    provider: 'phonepe',
                    created_at: n.isoDate,
                    status: 'normal',
                    ownerSubadminId,
                    ...reviewFields,
                }
            );

            if (manual) {
                emitPendingReview({
                    $id: created.$id, qrCodeId: n.qrCodeId, paymentId: n.paymentId, amount: n.amountPaise,
                    provider: 'phonepe', vpa: n.vpa, rrnNumber: n.rrnNumber, created_at: n.isoDate,
                    reviewExpiresAt: reviewFields.reviewExpiresAt, ownerSubadminId,
                });
                return 'held';
            }
            await finalizeTransaction(created);
            return 'saved';
        } finally {
            await releaseLock(lockKey, n.paymentId);
        }
    }

    router.get('/phonepe-capture/ping', requireExtensionKey, (_req, res) => res.status(200).json({ ok: true }));

    router.post('/phonepe-capture', requireExtensionKey, async (req, res) => {
        const rows = req.body?.transactions;
        if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'transactions must be a non-empty array' });
        if (rows.length > MAX_BATCH) return res.status(400).json({ error: `transactions must have at most ${MAX_BATCH} items` });

        const results = [];
        // Sequential on purpose: rows from one store share lock:qr, parallel would just spin on `busy`.
        for (const row of rows) {
            const n = normalize(row, rupeesToPaiseStrict);
            const paymentId = row?.paymentId ?? null;
            if (!n.ok) { results.push({ paymentId, result: n.skipped ? 'skipped' : 'invalid', error: n.error }); continue; }
            try {
                results.push({ paymentId, result: await ingest(n, row) });
            } catch (e) {
                console.error('[phonepe-capture] ingest error', paymentId, e?.message || e);
                results.push({ paymentId, result: 'error', error: 'Failed to record transaction' });
            }
        }
        return res.status(200).json({ results });
    });

    return router;
};
