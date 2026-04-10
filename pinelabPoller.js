/**
 * PineLabs Transaction Poller
 *
 * Periodically fetches SUCCESS transactions via PineOne's
 * getTransactionSummary and persists them through the same pipeline
 * used by the Razorpay /webhook handler in server.js:
 *   dedup → save webhook doc → update QR totals → daily summary
 *   → socket emit → dashboard counters.
 *
 * Mapping: PineLab `tid` is used as the QR document's `qrId`
 * (one synthetic QR doc per terminal ID, with an `assignedUserId`).
 */

const { PineOneClient } = require('./pineLabTest');

// PineLab expects "YYYY-MM-DDTHH:mm:ss" (no timezone suffix)
function fmt(d) {
  return d.toISOString().slice(0, 19);
}

// "2026-04-11 00:30:28.993" → Date
function parsePineDate(s) {
  if (!s) return new Date();
  return new Date(s.replace(' ', 'T'));
}

function startPinelabPoller(deps, opts = {}) {
  const {
    databases,
    Query,
    ID,
    redisClient,
    acquireLock,
    releaseLock,
    emitTxnNew,
    updateDailyQrTotal,
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
    APPWRITE_QRCODE_COLLECTION_ID,
    LOCK_TTL_SECONDS = 15,
  } = deps;

  const env          = opts.env          || 'production';
  const intervalMs   = opts.intervalMs   || 2 * 60 * 1000; // 2 min
  const overlapMin   = opts.overlapMinutes ?? 30;          // lookback buffer
  const pageSize     = opts.pageSize     || 100;
  const watermarkKey = 'pinelabs:poller:lastPolledAt';

  const client = new PineOneClient(env);
  let running = false;

  const log = (step, msg, extra) => {
    const ts = new Date().toISOString();
    if (extra !== undefined) console.log(`[PINELAB-POLL][${ts}] ${step}: ${msg}`, extra);
    else                     console.log(`[PINELAB-POLL][${ts}] ${step}: ${msg}`);
  };

  async function processTransaction(txn) {
    const transactionId = txn.transactionId;
    const tid           = txn.tid;

    if (!transactionId) { log('TXN', 'skipped — no transactionId'); return; }
    if (!tid)           { log('TXN', 'skipped — no tid', { transactionId }); return; }

    const amountRupees = parseFloat(txn.amount || '0');
    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      log('TXN', 'skipped — invalid amount', { transactionId, amount: txn.amount });
      return;
    }
    const amountPaise   = Math.round(amountRupees * 100);
    const isoDate       = parsePineDate(txn.transactionDate).toISOString();
    const rrnNumber     = txn.rrn || null;
    const vpa           = txn.upiPayerVpa || null;
    const payloadString = JSON.stringify(txn);

    const lockKey = `lock:pinelabs:tid:${tid}`;
    const acquired = await acquireLock(lockKey, transactionId, LOCK_TTL_SECONDS);
    if (!acquired) {
      log('TXN', 'lock busy — will catch on next poll', { tid, transactionId });
      return;
    }

    try {
      // 1. Idempotency — paymentId stores PineLab transactionId
      const existing = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        [Query.equal('paymentId', transactionId), Query.limit(1)]
      );
      if (existing.total > 0) return;

      // 2. Save raw record
      const created = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        ID.unique(),
        {
          payload: payloadString,
          qrCodeId: tid, // tid is used as qrId
          paymentId: transactionId,
          rrnNumber,
          amount: amountPaise,
          vpa,
          provider: 'pinelabs',
          created_at: isoDate,
          status: 'normal',
        }
      );
      log('TXN', 'saved ✅', { docId: created.$id, transactionId, tid, amountPaise });

      // 3. Find QR doc where qrId === tid
      const qrResult = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_QRCODE_COLLECTION_ID,
        [Query.equal('qrId', tid), Query.limit(1)]
      );

      if (qrResult.documents.length > 0) {
        const qrDoc   = qrResult.documents[0];
        const newCount = (qrDoc.totalTransactions || 0) + 1;
        const newTotal = (qrDoc.totalPayInAmount || 0) + amountPaise;

        const approved         = Number(qrDoc.withdrawalApprovedAmount || 0);
        const requested        = Number(qrDoc.withdrawalRequestedAmount || 0);
        const onHold           = Number(qrDoc.amountOnHold || 0);
        const commissionOnHold = Number(qrDoc.commissionOnHold || 0);
        const commissionPaid   = Number(qrDoc.commissionPaid || 0);
        const newAvailable     = newTotal - approved - requested - onHold - commissionOnHold - commissionPaid;

        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          APPWRITE_QRCODE_COLLECTION_ID,
          qrDoc.$id,
          {
            totalTransactions: newCount,
            totalPayInAmount: newTotal,
            amountAvailableForWithdrawal: newAvailable,
          }
        );

        try {
          await updateDailyQrTotal(tid, isoDate, amountPaise);
        } catch (e) {
          console.error('[PINELAB-POLL] updateDailyQrTotal failed (non-fatal):', e.message);
        }

        const assignedUserId = qrDoc.assignedUserId || '';
        emitTxnNew({
          assignedUserId,
          qrCodeId: tid,
          payload: {
            $id: created.$id,
            qrCodeId: tid,
            paymentId: transactionId,
            amount: amountPaise,
            rrnNumber,
            vpa,
            provider: 'pinelabs',
            created_at: isoDate,
          },
        });
      } else {
        log('TXN', '⚠️  no QR doc for tid — saved raw record but totals NOT updated', { tid });
      }

      // 4. Dashboard counters (same as /webhook)
      try {
        await Promise.all([
          redisClient.incrBy('counter:totalTxCount', 1),
          redisClient.incrBy('counter:totalApiTx', 1),
          redisClient.incrBy('counter:totalAmountReceived', amountPaise),
        ]);
        redisClient.countersDirty = true;
      } catch (e) {
        redisClient.countersStale = true;
        console.error('[PINELAB-POLL] counter update failed:', e.message);
      }
    } catch (e) {
      console.error('[PINELAB-POLL] processTransaction error:', e);
    } finally {
      await releaseLock(lockKey, transactionId);
    }
  }

  // Resume point when Redis watermark is missing (fresh deploy, Redis flush, etc.).
  // Looks up the most recent provider='pinelabs' doc and uses its created_at.
  // This keeps the poller durable across restarts even if Redis state is lost.
  async function resolveResumeFromDb(now) {
    try {
      const result = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        [
          Query.equal('provider', 'pinelabs'),
          Query.orderDesc('created_at'),
          Query.limit(1),
        ]
      );
      if (result.documents.length > 0 && result.documents[0].created_at) {
        const d = new Date(result.documents[0].created_at);
        log('RESUME', 'recovered from DB — latest pinelabs txn', { created_at: result.documents[0].created_at });
        return d;
      }
      log('RESUME', 'no prior pinelabs txns in DB — cold start');
    } catch (e) {
      console.error('[PINELAB-POLL] resolveResumeFromDb failed:', e.message);
    }
    // Cold start (or DB query failed) — go back overlapMin
    return new Date(now.getTime() - overlapMin * 60 * 1000);
  }

  async function tick() {
    if (running) { log('SKIP', 'previous tick still running'); return; }
    running = true;
    try {
      let lastIso = null;
      try { lastIso = await redisClient.get(watermarkKey); }
      catch (e) { console.error('[PINELAB-POLL] redis.get watermark failed:', e.message); }

      const now = new Date();
      const fromBase = lastIso ? new Date(lastIso) : await resolveResumeFromDb(now);
      // Lookback overlap catches late-arriving txns; dedup handles duplicates.
      const from = new Date(fromBase.getTime() - overlapMin * 60 * 1000);
      const to   = now;

      const fromDate = fmt(from);
      const toDate   = fmt(to);
      log('TICK', 'fetching', { fromDate, toDate });

      let page = 0;
      let totalPages = 1;
      let totalSeen = 0;

      do {
        const resp = await client.getTransactionSummary(
          { fromDate, toDate, txnStatus: ['SUCCESS'] },
          page,
          pageSize
        );

        if (resp.statusCode !== 200) {
          log('TICK', '⚠️  non-200 from PineLab — aborting tick, watermark NOT advanced', {
            statusCode: resp.statusCode,
            data: resp.data,
          });
          return;
        }

        const data = resp.data || {};
        totalPages = parseInt(data.totalPages || '1', 10) || 1;
        const txns = Array.isArray(data.transactions) ? data.transactions : [];
        totalSeen += txns.length;

        for (const txn of txns) {
          await processTransaction(txn);
        }
        page += 1;
      } while (page < totalPages);

      // Advance watermark only after full success
      try { await redisClient.set(watermarkKey, to.toISOString()); }
      catch (e) { console.error('[PINELAB-POLL] redis.set watermark failed:', e.message); }

      log('TICK', 'done ✅', { totalSeen });
    } catch (e) {
      console.error('[PINELAB-POLL] tick error:', e);
    } finally {
      running = false;
    }
  }

  log('BOOT', 'starting poller', { env, intervalMs, overlapMin, pageSize });
  // First run after a short delay so server finishes booting
  setTimeout(tick, 10_000);
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

module.exports = { startPinelabPoller };
