// reviewResolve.js
//
// The pending-review state machine — the single, exactly-once resolver shared by the
// admin approve/reject endpoints AND the durable timeout sweeper.
//
// A held transaction (reviewStatus:'pending_review', deleted:true) resolves to exactly
// one terminal state:
//   • approve → reviewStatus:'approved', deleted:false, then finalizeTransaction() (increments everywhere)
//   • reject  → reviewStatus:'rejected', stays deleted:true, then a rejection record + daily rejected summary
//
// Exactly-once is guaranteed by (a) a per-txn distributed lock and (b) re-reading the
// doc under that lock and acting only while it is still 'pending_review'. So an admin
// action and the timeout sweeper can never both apply — whoever flips the status first
// wins; the loser sees a non-pending status and no-ops.
//
// Dependencies are injected so this is unit-testable without a live Appwrite/Redis.
module.exports = function createReviewResolve(deps) {
    const {
        databases, Query, ID,
        DB, WEBHOOK_COL, REJECTED_COL, DAILY_REJECTED_COL,
        finalizeTransaction,
        acquireLock, releaseLock, acquireDailyLock,
        nowIso,     // () => ISO timestamp string
        todayStr,   // () => 'YYYY-MM-DD' (IST)
        emitReviewResolved = () => {}, // optional: notify admins a held txn was resolved
    } = deps;

    function notifyResolved(doc, outcome, reviewedBy) {
        try {
            emitReviewResolved({
                $id: doc.$id,
                qrCodeId: doc.qrCodeId,
                paymentId: doc.paymentId,
                amount: doc.amount,
                provider: doc.provider,
                outcome, // 'approved' | 'rejected'
                reviewedBy,
                reviewedAt: doc.reviewedAt,
            });
        } catch (e) {
            console.error('emitReviewResolved failed (non-fatal):', e?.message || e);
        }
    }

    // Write the detailed rejection record + roll it into the daily rejected summary.
    async function recordRejection(doc, actor) {
        const qrId = doc.qrCodeId || null;
        const amountPaise = Number(doc.amount || 0);
        const adminId = typeof actor === 'string' ? actor : (actor?.id || null);
        const adminName = typeof actor === 'string' ? actor : (actor?.name || null);
        const reason = (actor && typeof actor === 'object' && actor.reason) ? actor.reason : null;

        // 1. Detailed per-rejection record.
        await databases.createDocument(DB, REJECTED_COL, ID.unique(), {
            txnId: doc.$id,
            qrId,
            paymentId: doc.paymentId || null,
            amount: amountPaise,
            provider: doc.provider || null,
            vpa: doc.vpa || null,
            rrnNumber: doc.rrnNumber || null,
            ownerSubadminId: doc.ownerSubadminId || null,
            originalCreatedAt: doc.created_at || null,
            rejectedAt: nowIso(),
            adminId,
            adminName,
            reason,
        });

        // 2. Daily rejected summary (date × QR) — same read-modify-write pattern as daily_deleted_summary.
        const dayString = todayStr();
        const lock = await acquireDailyLock(`rej:${dayString}`);
        try {
            const existing = await databases.listDocuments(DB, DAILY_REJECTED_COL, [Query.equal('date', dayString), Query.limit(1)]);
            const key = qrId || 'no_qr';
            if (existing.total > 0) {
                const d = existing.documents[0];
                let totals = {};
                try {
                    totals = JSON.parse(d.totalsJson || '{}');
                } catch (e) {
                    throw new Error('Daily rejected summary JSON is corrupted — manual fix required');
                }
                totals[key] = Number(totals[key] || 0) + amountPaise;
                await databases.updateDocument(DB, DAILY_REJECTED_COL, d.$id, { totalsJson: JSON.stringify(totals) });
            } else {
                await databases.createDocument(DB, DAILY_REJECTED_COL, ID.unique(), {
                    date: dayString,
                    totalsJson: JSON.stringify({ [key]: amountPaise }),
                });
            }
        } finally {
            await releaseLock(lock.key, lock.val);
        }
    }

    // Resolve a pending transaction. `outcome` = 'approve' | 'reject'.
    // `actor` = { id, name, reason? } for an admin, or a string like 'system-timeout'.
    // Returns { status: 'approved' | 'rejected' | 'already_resolved' | 'not_found' | 'locked', ... }.
    async function resolveReview(txnId, outcome, actor) {
        if (!['approve', 'reject'].includes(outcome)) {
            throw new Error("outcome must be 'approve' or 'reject'");
        }

        const lockKey = `lock:review:${txnId}`;
        const lockVal = `review:${outcome}:${nowIso()}`;
        const acquired = await acquireLock(lockKey, lockVal, 20);
        if (!acquired) return { status: 'locked' };

        try {
            let doc;
            try {
                doc = await databases.getDocument(DB, WEBHOOK_COL, txnId);
            } catch (e) {
                if (e?.code === 404) return { status: 'not_found' };
                throw e;
            }

            // The exactly-once guard: only a still-pending doc may be resolved.
            if (doc.reviewStatus !== 'pending_review') {
                return { status: 'already_resolved', reviewStatus: doc.reviewStatus || 'normal' };
            }

            const reviewedBy = typeof actor === 'string' ? actor : (actor?.id || 'unknown');
            const reviewedAt = nowIso();

            if (outcome === 'approve') {
                // Flip status FIRST (this is the commit point), then run the increments.
                const updated = await databases.updateDocument(DB, WEBHOOK_COL, txnId, {
                    reviewStatus: 'approved',
                    deleted: false,
                    reviewedBy,
                    reviewedAt,
                });
                await finalizeTransaction(updated);
                notifyResolved(updated, 'approved', reviewedBy);
                return { status: 'approved', doc: updated };
            }

            // reject — stays deleted:true, no increments; log to rejected table + summary.
            const updated = await databases.updateDocument(DB, WEBHOOK_COL, txnId, {
                reviewStatus: 'rejected',
                deleted: true,
                reviewedBy,
                reviewedAt,
            });
            await recordRejection(updated, actor);
            notifyResolved(updated, 'rejected', reviewedBy);
            return { status: 'rejected', doc: updated };
        } finally {
            await releaseLock(lockKey, lockVal);
        }
    }

    return { resolveReview, recordRejection };
};
