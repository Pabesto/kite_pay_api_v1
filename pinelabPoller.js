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
 *
 * Returns { stop, runOnce } so callers can wire the disposer into
 * graceful shutdown and expose a manual backfill endpoint.
 */

const { PineOneClient } = require('./pineLabTest');

// PineLab timestamps (transactionDate) are naive IST wall-time.
// The API's fromDate/toDate filter is compared against the same naive IST
// values, so both ends of the conversation MUST be formatted in IST — not UTC.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Format a Date as naive IST wall-time "YYYY-MM-DDTHH:mm:ss" for the API.
function fmtIst(d) {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19);
}

// "2026-04-11 00:30:28.993" (naive IST) → proper UTC Date
function parsePineDate(s) {
  if (!s) return new Date();
  return new Date(s.replace(' ', 'T') + '+05:30');
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

  const env               = opts.env               || 'production';
  const intervalMs        = opts.intervalMs        || 2 * 60 * 1000;  // 2 min
  const bufferMin         = opts.bufferMinutes    ?? 5;               // small guard against micro-delays (txn anchor is ground truth)
  const maxLookbackMin    = opts.maxLookbackMinutes ?? 60;            // ceiling on window size during quiet periods
  const pageSize          = opts.pageSize          || 25;             // PineOne's default is 10, but we can go higher to reduce pages (and thus API calls) per tick
  const maxPagesPerTick   = opts.maxPagesPerTick   || 50;             // safety cap
  const dryRun            = !!opts.dryRun;
  const notFoundCacheMs   = opts.notFoundCacheMs   || 5 * 60 * 1000;  // 5 min

  // Watermark: ISO timestamp of the latest txn we've successfully saved.
  // Advanced only when a tick actually finds new txns. During quiet periods
  // it stays put, and the maxLookback cap prevents the window from growing.
  const watermarkKey      = 'pinelabs:poller:latestTxnAt';
  const mLastRunAt        = 'pinelabs:poller:lastRunAt';
  const mLastTxnsSeen     = 'pinelabs:poller:lastTxnsSeen';
  const mLastTxnsSaved    = 'pinelabs:poller:lastTxnsSaved';
  const mConsecFails      = 'pinelabs:poller:consecutiveFailures';
  const mLastError        = 'pinelabs:poller:lastError';
  const mLastDurationMs   = 'pinelabs:poller:lastDurationMs';

  const client = new PineOneClient(env);
  let running  = false;
  let stopped  = false;
  let intervalHandle = null;
  let bootTimeoutHandle = null;

  // In-memory cache of TIDs we've recently failed to map to a QR doc,
  // to avoid hammering Appwrite for every tick.
  const tidNotFoundCache = new Map(); // tid → expiresAtMs

  const log = (step, msg, extra) => {
    const ts = new Date().toISOString();
    if (extra !== undefined) console.log(`[PINELAB-POLL][${ts}] ${step}: ${msg}`, extra);
    else                     console.log(`[PINELAB-POLL][${ts}] ${step}: ${msg}`);
  };

  async function setMetric(key, value) {
    try { await redisClient.set(key, String(value)); }
    catch (e) { /* metrics are best-effort */ }
  }

  async function processTransaction(txn) {
    const transactionId = txn.transactionId;
    const tid           = txn.tid;

    if (!transactionId) { log('TXN', 'skipped — no transactionId'); return false; }
    if (!tid)           { log('TXN', 'skipped — no tid', { transactionId }); return false; }

    // Filter: only credit real sales in INR.
    if (txn.txnType && txn.txnType !== 'SALE') {
      log('TXN', 'skipped — non-SALE', { transactionId, txnType: txn.txnType });
      return false;
    }
    if (txn.currency && !String(txn.currency).toUpperCase().endsWith('INR')) {
      log('TXN', 'skipped — non-INR', { transactionId, currency: txn.currency });
      return false;
    }

    const amountRupees = parseFloat(txn.amount || '0');
    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      log('TXN', 'skipped — invalid amount', { transactionId, amount: txn.amount });
      return false;
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
      return false;
    }

    try {
      // 1. Idempotency — paymentId stores PineLab transactionId
      const existing = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        [Query.equal('paymentId', transactionId), Query.limit(1)]
      );
      if (existing.total > 0) return false;

      if (dryRun) {
        log('TXN', '[dry-run] would save', { transactionId, tid, amountPaise, isoDate });
        return true;
      }

      // 2. Save raw record
      const created = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        ID.unique(),
        {
          payload: payloadString,
          qrCodeId: tid,
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

      // 3. Find QR doc where qrId === tid (with negative-result cache)
      const cachedNotFoundAt = tidNotFoundCache.get(tid);
      let qrDoc = null;

      if (cachedNotFoundAt && cachedNotFoundAt > Date.now()) {
        log('TXN', '⚠️  tid in not-found cache — raw saved, totals skipped', { tid });
      } else {
        const qrResult = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          APPWRITE_QRCODE_COLLECTION_ID,
          [Query.equal('qrId', tid), Query.limit(1)]
        );
        if (qrResult.documents.length > 0) {
          qrDoc = qrResult.documents[0];
          tidNotFoundCache.delete(tid);
        } else {
          tidNotFoundCache.set(tid, Date.now() + notFoundCacheMs);
          log('TXN', '⚠️  no QR doc for tid — raw saved, totals skipped', { tid });
        }
      }

      if (qrDoc) {
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
      return true;
    } catch (e) {
      console.error('[PINELAB-POLL] processTransaction error:', e);
      return false;
    } finally {
      await releaseLock(lockKey, transactionId);
    }
  }

  // Resume point when Redis watermark is missing (fresh deploy, Redis flush, etc.).
  // Returns the latest saved pinelabs txn timestamp, or null if the DB has none.
  async function resolveResumeFromDb() {
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
    return null;
  }

  // Fetch and process a single explicit [from, to] window.
  // Shared by scheduled ticks and manual runOnce() calls.
  //
  // Watermark model: tracks the max `created_at` of every txn SEEN in this
  // window (saved or dedup'd — both represent points we've processed).
  // On success, advances the Redis watermark to max(existing, maxSeen).
  async function fetchWindow(from, to, { advanceWatermark } = { advanceWatermark: true }) {
    const startedAt = Date.now();
    const fromDate = fmtIst(from);
    const toDate   = fmtIst(to);
    log('RUN', 'fetching', { fromDate, toDate, dryRun });

    let page = 0;
    let totalPages = 1;
    let totalSeen  = 0;
    let totalSaved = 0;
    let hitPageCap = false;
    let maxSeenMs  = 0; // max txn created_at (ms) across all pages

    do {
      if (stopped) { log('RUN', 'stopped mid-run — aborting'); return { totalSeen, totalSaved, aborted: true }; }

      const resp = await client.getTransactionSummary(
        { fromDate, toDate, txnStatus: ['SUCCESS'] },
        page,
        pageSize
      );

      if (resp.statusCode !== 200) {
        const err = `HTTP ${resp.statusCode}`;
        log('RUN', '⚠️  non-200 from PineLab — aborting run', { statusCode: resp.statusCode, data: resp.data });
        await setMetric(mLastError, `${new Date().toISOString()} ${err}`);
        throw new Error(err);
      }

      const data = resp.data || {};
      totalPages = parseInt(data.totalPages || '1', 10) || 1;
      const txns = Array.isArray(data.transactions) ? data.transactions : [];
      totalSeen += txns.length;

      for (const txn of txns) {
        const ts = parsePineDate(txn.transactionDate).getTime();
        if (Number.isFinite(ts) && ts > maxSeenMs) maxSeenMs = ts;

        const saved = await processTransaction(txn);
        if (saved) totalSaved += 1;
      }
      page += 1;

      if (page >= maxPagesPerTick && page < totalPages) {
        hitPageCap = true;
        log('RUN', '⚠️  hit maxPagesPerTick — will resume on next tick', { maxPagesPerTick, totalPages });
        break;
      }
    } while (page < totalPages);

    // Advance watermark to the latest txn timestamp we actually saw.
    // If zero txns came back, leave the watermark untouched — the next tick's
    // maxLookback cap keeps the window bounded during quiet periods.
    // If we hit the page cap we still advance, because every txn up to maxSeenMs
    // HAS been processed (we just stopped fetching more).
    if (advanceWatermark && maxSeenMs > 0) {
      try {
        const existing = await redisClient.get(watermarkKey);
        const existingMs = existing ? new Date(existing).getTime() : 0;
        if (maxSeenMs > existingMs) {
          await redisClient.set(watermarkKey, new Date(maxSeenMs).toISOString());
        }
      } catch (e) {
        console.error('[PINELAB-POLL] redis watermark update failed:', e.message);
      }
    }

    const durationMs = Date.now() - startedAt;
    await setMetric(mLastRunAt, new Date().toISOString());
    await setMetric(mLastTxnsSeen, totalSeen);
    await setMetric(mLastTxnsSaved, totalSaved);
    await setMetric(mLastDurationMs, durationMs);

    log('RUN', 'done ✅', { totalSeen, totalSaved, durationMs, hitPageCap });
    return { totalSeen, totalSaved, hitPageCap, durationMs, fromDate, toDate };
  }

  // Resolve the [from, to] window for a scheduled / default run.
  //
  // anchor = latest saved txn timestamp (Redis watermark, fallback to DB query)
  // from   = max(anchor, now − maxLookback) − bufferMin
  //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ceiling prevents window growth
  //                                         during quiet periods
  // to     = now
  async function resolveDefaultWindow() {
    const now = new Date();
    let anchorIso = null;
    try { anchorIso = await redisClient.get(watermarkKey); }
    catch (e) { console.error('[PINELAB-POLL] redis.get watermark failed:', e.message); }

    let anchor = anchorIso ? new Date(anchorIso) : null;
    if (!anchor) anchor = await resolveResumeFromDb();

    // Ceiling: never look back further than maxLookbackMin from now.
    const cap = new Date(now.getTime() - maxLookbackMin * 60 * 1000);
    const capped = (anchor && anchor.getTime() > cap.getTime()) ? anchor : cap;

    const from = new Date(capped.getTime() - bufferMin * 60 * 1000);
    return { from, to: now };
  }

  async function tick() {
    if (running) { log('SKIP', 'previous tick still running'); return; }
    if (stopped) return;
    running = true;
    try {
      const { from, to } = await resolveDefaultWindow();
      await fetchWindow(from, to, { advanceWatermark: true });
      try { await redisClient.set(mConsecFails, '0'); } catch (_) {}
    } catch (e) {
      console.error('[PINELAB-POLL] tick error:', e);
      try { await redisClient.incrBy(mConsecFails, 1); } catch (_) {}
      await setMetric(mLastError, `${new Date().toISOString()} ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  // Manual run for admin backfill / testing. Accepts explicit Date window OR
  // uses the default tick window if both omitted. Does NOT advance the watermark
  // when given an explicit window (so it can't poison the live schedule).
  async function runOnce({ from, to } = {}) {
    if (from && to) {
      return fetchWindow(new Date(from), new Date(to), { advanceWatermark: false });
    }
    const window = await resolveDefaultWindow();
    return fetchWindow(window.from, window.to, { advanceWatermark: true });
  }

  function stop() {
    stopped = true;
    if (intervalHandle)    { clearInterval(intervalHandle);    intervalHandle = null; }
    if (bootTimeoutHandle) { clearTimeout(bootTimeoutHandle);  bootTimeoutHandle = null; }
    log('STOP', 'poller stopped');
  }

  log('BOOT', 'starting poller', { env, intervalMs, bufferMin, maxLookbackMin, pageSize, maxPagesPerTick, dryRun });
  bootTimeoutHandle = setTimeout(tick, 10_000);
  intervalHandle    = setInterval(tick, intervalMs);

  return { stop, runOnce };
}

module.exports = { startPinelabPoller };
