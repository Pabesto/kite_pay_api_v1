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
/**
 * PineLabs Multi-Account Transaction Poller
 */

const { PineOneMultiClient } = require('./pineLabMulti');
const qrOwnerCache = require('./qrOwnerCache');
const partnerWebhooks = require('./partnerWebhooks');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function fmtIst(d) {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19);
}

function parsePineDate(s) {
  if (!s) return new Date();
  return new Date(s.replace(' ', 'T') + '+05:30');
}

function startPinelabMultiPoller(deps, opts = {}) {
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
  const intervalMs        = opts.intervalMs        || 2 * 60 * 1000;
  const bufferMin         = opts.bufferMinutes    ?? 5;
  const maxLookbackMin    = opts.maxLookbackMinutes ?? 60;
  const pageSize          = opts.pageSize          || 100;
  const maxPagesPerTick   = opts.maxPagesPerTick   || 50;
  const dryRun            = !!opts.dryRun;
  const notFoundCacheMs   = opts.notFoundCacheMs   || 5 * 60 * 1000;

  // Expecting an array of accounts in opts: 
  // accounts: [{ id: 'merchant_a', clientId: '...', clientSecret: '...' }]
  const accountsConfig = opts.accounts || [];

  // Initialize clients for each provided account config
  const activeAccounts = accountsConfig.map(acc => {
    if (!acc.id) throw new Error("Each account config must provide a unique 'id' string.");
    return {
      id: acc.id,
      client: new PineOneMultiClient(env, { clientId: acc.clientId, clientSecret: acc.clientSecret })
    };
  });

  // Dynamic key helpers to isolate metrics by account ID
  const getKeys = (id) => ({
    watermarkKey:    `pinelabs:poller:${id}:latestTxnAt`,
    mLastRunAt:      `pinelabs:poller:${id}:lastRunAt`,
    mLastTxnsSeen:   `pinelabs:poller:${id}:lastTxnsSeen`,
    mLastTxnsSaved:  `pinelabs:poller:${id}:lastTxnsSaved`,
    mConsecFails:    `pinelabs:poller:${id}:consecutiveFailures`,
    mLastError:      `pinelabs:poller:${id}:lastError`,
    mLastDurationMs: `pinelabs:poller:${id}:lastDurationMs`,
  });

  let running  = false;
  let stopped  = false;
  let intervalHandle = null;
  let bootTimeoutHandle = null;

  const tidNotFoundCache = new Map();

  const log = (accountSpec, step, msg, extra) => {
    const ts = new Date().toISOString();
    const tag = `[PINELAB-POLL][${accountSpec}]`;
    if (extra !== undefined) console.log(`${tag}[${ts}] ${step}: ${msg}`, extra);
    else                     console.log(`${tag}[${ts}] ${step}: ${msg}`);
  };

  async function setMetric(key, value) {
    try { await redisClient.set(key, String(value)); }
    catch (e) { /* metrics are best-effort */ }
  }

  async function processTransaction(accountSpec, txn) {
    const transactionId = txn.transactionId;
    const tid           = txn.tid;

    if (!transactionId) { log(accountSpec, 'TXN', 'skipped — no transactionId'); return false; }
    if (!tid)           { log(accountSpec, 'TXN', 'skipped — no tid', { transactionId }); return false; }

    if (txn.txnType && txn.txnType !== 'SALE') {
      log(accountSpec, 'TXN', 'skipped — non-SALE', { transactionId, txnType: txn.txnType });
      return false;
    }
    if (txn.currency && !String(txn.currency).toUpperCase().endsWith('INR')) {
      log(accountSpec, 'TXN', 'skipped — non-INR', { transactionId, currency: txn.currency });
      return false;
    }

    const amountRupees = parseFloat(txn.amount || '0');
    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      log(accountSpec, 'TXN', 'skipped — invalid amount', { transactionId, amount: txn.amount });
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
      log(accountSpec, 'TXN', 'lock busy — will catch on next poll', { tid, transactionId });
      return false;
    }

    try {
      const existing = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        [Query.equal('paymentId', transactionId), Query.limit(1)]
      );
      if (existing.total > 0) return false;

      if (dryRun) {
        log(accountSpec, 'TXN', '[dry-run] would save', { transactionId, tid, amountPaise, isoDate });
        return true;
      }

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
          ownerSubadminId: await qrOwnerCache.resolve(tid),
        }
      );
      log(accountSpec, 'TXN', 'saved ✅', { docId: created.$id, transactionId, tid, amountPaise });
      partnerWebhooks.dispatch(created, 'payment.created'); // fire-and-forget outbound webhook

      const cachedNotFoundAt = tidNotFoundCache.get(tid);
      let qrDoc = null;

      if (cachedNotFoundAt && cachedNotFoundAt > Date.now()) {
        log(accountSpec, 'TXN', '⚠️  tid in not-found cache — raw saved, totals skipped', { tid });
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
          log(accountSpec, 'TXN', '⚠️  no QR doc for tid — raw saved, totals skipped', { tid });
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
          console.error(`[PINELAB-POLL][${accountSpec}] updateDailyQrTotal failed (non-fatal):`, e.message);
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

      try {
        await Promise.all([
          redisClient.incrBy('counter:totalTxCount', 1),
          redisClient.incrBy('counter:totalApiTx', 1),
          redisClient.incrBy('counter:totalAmountReceived', amountPaise),
        ]);
        redisClient.countersDirty = true;
      } catch (e) {
        redisClient.countersStale = true;
        console.error(`[PINELAB-POLL][${accountSpec}] counter update failed:`, e.message);
      }
      return true;
    } catch (e) {
      console.error(`[PINELAB-POLL][${accountSpec}] processTransaction error:`, e);
      return false;
    } finally {
      await releaseLock(lockKey, transactionId);
    }
  }

  async function resolveResumeFromDb(accountSpec) {
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
        log(accountSpec, 'RESUME', 'recovered from DB — latest pinelabs txn', { created_at: result.documents[0].created_at });
        return d;
      }
      log(accountSpec, 'RESUME', 'no prior pinelabs txns in DB — cold start');
    } catch (e) {
      console.error(`[PINELAB-POLL][${accountSpec}] resolveResumeFromDb failed:`, e.message);
    }
    return null;
  }

  async function fetchWindowForAccount(accountObj, from, to, { advanceWatermark } = { advanceWatermark: true }) {
    const { id: accountSpec, client } = accountObj;
    const keys = getKeys(accountSpec);

    const startedAt = Date.now();
    const fromDate = fmtIst(from);
    const toDate   = fmtIst(to);
    log(accountSpec, 'RUN', 'fetching', { fromDate, toDate, dryRun });

    let page = 0;
    let totalPages = 1;
    let totalSeen  = 0;
    let totalSaved = 0;
    let hitPageCap = false;
    let maxSeenMs  = 0;

    do {
      if (stopped) { log(accountSpec, 'RUN', 'stopped mid-run — aborting'); return { totalSeen, totalSaved, aborted: true }; }

      const resp = await client.getTransactionSummary(
        { fromDate, toDate, txnStatus: ['SUCCESS'] },
        page,
        pageSize
      );

      if (resp.statusCode !== 200) {
        const err = `HTTP ${resp.statusCode}`;
        log(accountSpec, 'RUN', '⚠️  non-200 from PineLab — aborting run', { statusCode: resp.statusCode, data: resp.data });
        await setMetric(keys.mLastError, `${new Date().toISOString()} ${err}`);
        throw new Error(err);
      }

      const data = resp.data || {};
      totalPages = parseInt(data.totalPages || '1', 10) || 1;
      const txns = Array.isArray(data.transactions) ? data.transactions : [];
      totalSeen += txns.length;

      for (const txn of txns) {
        const ts = parsePineDate(txn.transactionDate).getTime();
        if (Number.isFinite(ts) && ts > maxSeenMs) maxSeenMs = ts;

        const saved = await processTransaction(accountSpec, txn);
        if (saved) totalSaved += 1;
      }
      page += 1;

      if (page >= maxPagesPerTick && page < totalPages) {
        hitPageCap = true;
        log(accountSpec, 'RUN', '⚠️  hit maxPagesPerTick — will resume on next tick', { maxPagesPerTick, totalPages });
        break;
      }
    } while (page < totalPages);

    if (advanceWatermark && maxSeenMs > 0) {
      try {
        const existing = await redisClient.get(keys.watermarkKey);
        const existingMs = existing ? new Date(existing).getTime() : 0;
        if (maxSeenMs > existingMs) {
          await redisClient.set(keys.watermarkKey, new Date(maxSeenMs).toISOString());
        }
      } catch (e) {
        console.error(`[PINELAB-POLL][${accountSpec}] redis watermark update failed:`, e.message);
      }
    }

    const durationMs = Date.now() - startedAt;
    await setMetric(keys.mLastRunAt, new Date().toISOString());
    await setMetric(keys.mLastTxnsSeen, totalSeen);
    await setMetric(keys.mLastTxnsSaved, totalSaved);
    await setMetric(keys.mLastDurationMs, durationMs);

    log(accountSpec, 'RUN', 'done ✅', { totalSeen, totalSaved, durationMs, hitPageCap });
    return { totalSeen, totalSaved, hitPageCap, durationMs, fromDate, toDate };
  }

  async function resolveWindowForAccount(accountObj) {
    const { id: accountSpec } = accountObj;
    const keys = getKeys(accountSpec);
    const now = new Date();

    let anchorIso = null;
    try { anchorIso = await redisClient.get(keys.watermarkKey); }
    catch (e) { console.error(`[PINELAB-POLL][${accountSpec}] redis.get watermark failed:`, e.message); }

    let anchor = anchorIso ? new Date(anchorIso) : null;
    if (!anchor) anchor = await resolveResumeFromDb(accountSpec);

    const cap = new Date(now.getTime() - maxLookbackMin * 60 * 1000);
    const capped = (anchor && anchor.getTime() > cap.getTime()) ? anchor : cap;

    const from = new Date(capped.getTime() - bufferMin * 60 * 1000);
    return { from, to: now };
  }

  async function tick() {
    if (running) { log('GLOBAL', 'SKIP', 'previous tick still running across accounts'); return; }
    if (stopped) return;
    running = true;

    try {
      // Processes accounts consecutively to mitigate parallel API strain and overlapping database locks
      for (const accountObj of activeAccounts) {
        if (stopped) break;
        const keys = getKeys(accountObj.id);
        try {
          const { from, to } = await resolveWindowForAccount(accountObj);
          await fetchWindowForAccount(accountObj, from, to, { advanceWatermark: true });
          try { await redisClient.set(keys.mConsecFails, '0'); } catch (_) {}
        } catch (e) {
          console.error(`[PINELAB-POLL][${accountObj.id}] tick error:`, e);
          try { await redisClient.incrBy(keys.mConsecFails, 1); } catch (_) {}
          await setMetric(keys.mLastError, `${new Date().toISOString()} ${e.message || e}`);
        }
      }
    } finally {
      running = false;
    }
  }

  // Manual run for admin backfill / testing. Accepts explicit window OR uses each
  // account's default watermark window. Runs accounts one-by-one and returns a
  // per-account results map. Does NOT advance watermarks for an explicit window
  // (so a backfill can't poison the live schedule).
  async function runOnce({ from, to } = {}) {
    // Explicit window strings are naive IST wall-time (e.g. "2026-06-19T04:20:00").
    // A bare date-time with no offset is parsed by `new Date()` in the SERVER's
    // local timezone — IST locally but UTC on Render — which then double-shifts
    // through fmtIst(). Pin a naive string to IST so the result is server-TZ-independent.
    const toIstDate = (v) =>
      typeof v === 'string' && !/[zZ]|[+\-]\d{2}:?\d{2}$/.test(v)
        ? new Date(v.replace(' ', 'T') + '+05:30')
        : new Date(v);

    const results = {};
    for (const accountObj of activeAccounts) {
      if (stopped) break;
      try {
        if (from && to) {
          results[accountObj.id] = await fetchWindowForAccount(
            accountObj, toIstDate(from), toIstDate(to), { advanceWatermark: false });
        } else {
          const window = await resolveWindowForAccount(accountObj);
          results[accountObj.id] = await fetchWindowForAccount(
            accountObj, window.from, window.to, { advanceWatermark: true });
        }
      } catch (e) {
        console.error(`[PINELAB-POLL][${accountObj.id}] runOnce error:`, e);
        results[accountObj.id] = { error: e.message || String(e) };
      }
    }
    return results;
  }

  function stop() {
    stopped = true;
    if (intervalHandle)    { clearInterval(intervalHandle);    intervalHandle = null; }
    if (bootTimeoutHandle) { clearTimeout(bootTimeoutHandle);  bootTimeoutHandle = null; }
    log('GLOBAL', 'STOP', 'poller stopped');
  }

  log('GLOBAL', 'BOOT', 'starting multi-account poller', { 
    env, 
    intervalMs, 
    accountsCount: activeAccounts.length,
    activeIds: activeAccounts.map(a => a.id) 
  });
  
  if (activeAccounts.length === 0) {
    log('GLOBAL', 'BOOT', '⚠️ No accounts provided to the PineLabs poller options.');
  }

  bootTimeoutHandle = setTimeout(tick, 10_000);
  intervalHandle    = setInterval(tick, intervalMs);

  return { stop, runOnce, accountIds: activeAccounts.map(a => a.id) };
}

module.exports = { startPinelabMultiPoller };