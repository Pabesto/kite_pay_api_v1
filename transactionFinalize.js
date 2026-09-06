// transactionFinalize.js
//
// CENTRALIZED TRANSACTION FINALIZE — the single "increment everywhere" pipeline.
//
// Given a freshly-persisted WEBHOOK_DATA doc (`created`), runs every downstream
// side-effect that makes a transaction "live":
//   1. QR-doc totals (totalTransactions, totalPayInAmount, amountAvailableForWithdrawal)
//   2. daily QR summary
//   3. real-time socket emit (assigned user's room + QR room)
//   4. outbound partner webhook
//   5. dashboard counters
//
// This is the SINGLE source of truth for finalize. Ingest webhooks call it right
// after persisting; the manual-review approve path calls it on approval so the two
// modes can never drift. Dependencies are injected so the pipeline is unit-testable
// in isolation and reusable from both server.js and admin.js.
//
// Factory: pass the live dependencies once, get back the `finalizeTransaction` fn.
module.exports = function createFinalizeTransaction(deps) {
    const {
        updateQrTotalAtomic,  // async (qrCodeId, amountPaise) => qrDoc | null
        updateDailyQrTotal,   // async (qrCodeId, isoDate, amountPaise) => void
        emitTxnNew,           // ({ assignedUserId, qrCodeId, payload }) => void
        partnerWebhooks,      // { dispatch(created, event) => void }
        withRedisTimeout,     // (promise, ms) => promise
        redisClient,          // Redis client (incrBy, flags)
    } = deps;

    // Pass `emitPayload` to control the exact socket payload (shape/ids differ slightly
    // per provider); omit it to build a default from `created`.
    return async function finalizeTransaction(created, { emitPayload = null } = {}) {
        const qrCodeId    = created.qrCodeId;
        const amountPaise = created.amount;
        const isoDate     = created.created_at;

        // 1. QR-doc totals (robust: retry + fresh recompute). Returns the QR doc, or null if not found.
        const qrDoc = await updateQrTotalAtomic(qrCodeId, amountPaise);

        // 2. Daily QR summary — non-fatal; the raw record is already the source of truth.
        try {
            await updateDailyQrTotal(qrCodeId, isoDate, amountPaise);
        } catch (e) {
            console.error('❌ Error updating daily QR total:', e?.message || e);
        }

        // 3. Real-time emit — to the assigned user's room (if resolvable) and the QR room.
        emitTxnNew({
            assignedUserId: qrDoc?.assignedUserId || '',
            qrCodeId,
            payload: {
                // Reaching finalize means the txn is live: either it was never held for review,
                // or review approved it (held docs emit `review:pending` only and never get here).
                // Injected for every caller so each ingest path doesn't have to remember it —
                // clients key their "Success" vs "HOLD" label off this field. An explicit
                // status in emitPayload still wins.
                status: created.status || 'normal',
                ...(emitPayload || {
                    $id:        created.$id,
                    qrCodeId,
                    paymentId:  created.paymentId,
                    amount:     amountPaise,
                    rrnNumber:  created.rrnNumber || null,
                    vpa:        created.vpa || null,
                    provider:   created.provider,
                    created_at: isoDate,
                }),
            },
        });

        // 4. Outbound partner webhook (fire-and-forget).
        partnerWebhooks.dispatch(created, 'payment.created');

        // 5. Dashboard counters (non-critical, timeout-guarded).
        withRedisTimeout(Promise.all([
            redisClient.incrBy('counter:totalTxCount', 1),
            redisClient.incrBy('counter:totalApiTx', 1),
            redisClient.incrBy('counter:totalAmountReceived', amountPaise),
        ]), 3000).then(() => { redisClient.countersDirty = true; })
          .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed:', e?.message || e); });

        return qrDoc;
    };
};
