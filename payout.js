// payout.js — Customer Payout feature.
//
//   • Payout wallet per user (funded by approved withdrawals with mode:'wallet' — no commission cut)
//   • Saved customer beneficiary accounts (bankingStatus: not_added → added, set by admin)
//   • Customer payout requests: user requests → admin marks PAID (reference number) or REJECTED (reason)
//   • Admin manual wallet credit/debit with notes + reference number
//   • Separate payout-commission ledger (txns + daily rollup), charged when a payout is PAID
//
// Money: every stored amount in this module is INTEGER PAISE. Request bodies take rupees
// (same convention as /withdraw_new) and are converted exactly once with toPaise().
// Locks: every wallet balance/hold read-modify-write runs under lock:payoutwallet:<userId>
// (fails closed — Redis error or contention → 409). Wallet ledger rows carry (type, refId) so
// credits/debits are idempotent on retry.
//
// Mounted at /api/payout (server.js). Returns { router, creditWalletFromWithdrawal } — the
// latter is called by withdraw.js /withdrawals/approve_new for mode:'wallet' withdrawals.

const express = require('express');
const moment = require('moment-timezone');
const userMetaCache = require('./userMetaCache');
const ConfigManager = require('./configManager');
const { updateDashboardCounter } = require('./dashboardCounters');

// Applied when a users_meta doc has no payoutCommission at all (null/undefined). An explicit 0 stays 0.
// Admin-tunable via config key `default_payout_commission` (type double); fallback 1.5%.
const DEFAULT_PAYOUT_COMMISSION = 1.5;
const defaultPayoutCommission = () => {
  const v = Number(ConfigManager.get('default_payout_commission', DEFAULT_PAYOUT_COMMISSION));
  return isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_PAYOUT_COMMISSION;
};

const CURSOR_RE = /^[a-zA-Z0-9_:-]{1,255}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCT_RE = /^\d{8,18}$/;
const UPI_RE = /^[a-zA-Z0-9.\-_+]+@[a-zA-Z0-9]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const PAYOUT_MODES = ['NEFT', 'IMPS', 'RTGS', 'UPI'];
const BANKING_STATUSES = ['not_added', 'added'];
const WALLET_TXN_TYPES = ['withdrawal_credit', 'payout_paid', 'admin_credit', 'admin_debit', 'revert_to_qr'];

const LOCK_TTL_REQUEST = 15;
const LOCK_TTL_RESOLVE = 30;
const LOCK_TTL_QR = 30; // revert-to-QR holds lock:qr (same key as withdraw approve/reject and the webhooks)

module.exports = (
  databases, ID, Query, DB,
  USERS_META, WITHDRAWALS,
  WALLETS, WALLET_TXNS, ACCOUNTS, PAYOUTS, COMMISSION_TXNS, DAILY_COMMISSION,
  authenticateToken, authenticateAdminOrLabel, redisClient,
  MONTHLY_COMMISSION, ALLTIME_COMMISSION, // appended: monthly / all-time payout-commission rollups
  QRCODES, // appended: QR collection — lets the admin queue filter by qrId (→ the QR's assigned user)
  emitPayoutEvent, // appended: socketServer helper ({ userId, event, payload, toAdmins }) — optional
  SOURCE_ACCOUNTS, // appended: payout_source_accounts — "paid via" quick-pick list
) => {
  const router = express.Router();

  // ─── helpers ───────────────────────────────────────────────────────────────
  function fail(status, message) { const e = new Error(message); e.status = status; return e; }
  // Admin dashboard counters (paise / counts). Fire-and-forget: never fails the money operation.
  //   totalPayoutWalletBalance        — sum of all payout wallets' balancePaise (platform liability)
  //   totalCustomerPayoutPendingAmount / Count — customer payouts awaiting admin (amount excl. commission)
  //   totalCustomerPayoutPaid / Count — customer payouts marked PAID (amount excl. commission)
  //   totalPayoutAdminProfit / totalPayoutMerchantProfit — payout commission earned (admin / subadmins)
  //   totalPayoutWalletFunded         — written by withdraw.js when a mode:'wallet' withdrawal is approved
  const inc = (key, delta) => updateDashboardCounter(databases, DB, key, delta).catch((e) => console.error(`Error updating ${key}:`, e));
  const nowIso = () => new Date().toISOString();
  const istDay = (ts = new Date()) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');
  const istMonth = (ts = new Date()) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM');
  const toPaise = (v) => { const n = Number(v); return (isFinite(n) && n > 0) ? Math.round(n * 100) : null; };
  const genId = (prefix) => `${prefix}${Date.now()}${Math.floor(100 + Math.random() * 900)}`;
  function calculateCommissionPaise(amountPaise, ratePercent) {
    return Math.ceil(amountPaise * Math.round(ratePercent * 100) / 10000); // integer math, rounded up
  }
  function isCursorError(err) {
    const msg = (err?.message || '').toLowerCase();
    return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
  }
  function sendError(res, err, fallback) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    if (isCursorError(err)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
    console.error(`❌ payout: ${fallback}:`, err);
    return res.status(500).json({ error: fallback });
  }
  function parseLimit(q, cap = 100) { return Math.min(Math.max(parseInt(q ?? 25, 10) || 25, 1), cap); }
  function cursorQuery(cursor) {
    if (!cursor) return [];
    if (!CURSOR_RE.test(cursor)) throw fail(400, 'Invalid cursor format');
    return [Query.cursorAfter(cursor)];
  }
  // IST day range → UTC ISO bounds on `createdAt` (same idiom as withdrawals_paginated)
  function dateQueries(from, to) {
    const bound = (d, edge) => {
      if (!DAY_RE.test(d)) throw fail(400, 'Dates must be YYYY-MM-DD');
      return moment.tz(d, 'Asia/Kolkata')[edge]('day').utc().toISOString();
    };
    if (from && to) return [Query.between('createdAt', bound(from, 'startOf'), bound(to, 'endOf'))];
    if (from) return [Query.between('createdAt', bound(from, 'startOf'), bound(from, 'endOf'))];
    if (to) return [Query.lessThanEqual('createdAt', bound(to, 'endOf'))];
    return [];
  }
  const nextCursorOf = (docs, limit) => (docs.length === limit ? docs[docs.length - 1].$id : null);

  const RELEASE_LOCK = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
  async function withLock(key, ttl, fn, busyMessage) {
    const val = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let acquired = false;
    try { acquired = (await redisClient.set(key, val, { NX: true, EX: ttl })) === 'OK'; }
    catch (e) { console.error(`payout lock error for ${key} (failing closed):`, e.message); }
    if (!acquired) throw fail(409, busyMessage);
    try { return await fn(); }
    finally {
      try { await redisClient.eval(RELEASE_LOCK, { keys: [key], arguments: [val] }); }
      catch (e) { console.error(`releaseLock failed for ${key} — lock will expire after TTL:`, e.message); }
    }
  }
  const withWalletLock = (userId, ttl, fn) =>
    withLock(`lock:payoutwallet:${userId}`, ttl, fn, 'Payout wallet is busy. Please try again in a moment.');

  // Rollup locks: short retry loop (same shape as withdraw.js commission rollups). Returns the
  // lock value on success, null if never acquired.
  async function acquireRetry(key, ttl = 10, tries = 10) {
    const val = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < tries; i++) {
      if ((await redisClient.set(key, val, { NX: true, EX: ttl }).catch(() => null)) === 'OK') return val;
      await new Promise((r) => setTimeout(r, 50 + i * 40));
    }
    return null;
  }
  const releaseQuiet = (key, val) => redisClient.eval(RELEASE_LOCK, { keys: [key], arguments: [val] }).catch(() => {});

  async function getAdminMeta() {
    const r = await databases.listDocuments(DB, USERS_META, [Query.equal('role', 'admin'), Query.limit(1)]);
    return r.documents[0] || null;
  }

  // Who can this caller see/act on?  admin → null (everyone); subadmin → self + their users;
  // employee → the subadmins assigned to them (users_meta.assigned_to) + those subadmins' users;
  // anyone else → nobody.
  async function visibleUserIds(req) {
    if (req.user.role === 'admin') return null;
    if (req.user.role === 'subadmin') return usersUnder(req.user.userId);
    if (req.user.role === 'employee') {
      const keys = [...new Set([req.user.$id, req.user.userId].filter(Boolean))]; // older docs stamp either id
      const r = await databases.listDocuments(DB, USERS_META, [Query.equal('assigned_to', keys), Query.equal('role', 'subadmin'), Query.limit(100)]);
      const ids = [];
      for (const s of r.documents) if (s.userId) ids.push(...(await usersUnder(s.userId)));
      return [...new Set(ids)];
    }
    return [];
  }
  // 403 unless the caller may act on this user's data (admin always may).
  async function assertCanAct(req, userId) {
    const allowed = await visibleUserIds(req);
    if (allowed && !allowed.includes(userId)) throw fail(403, 'Not authorized for this user');
  }

  // A subadmin's visible users = themselves + every user whose parentId is them (paged, not one page).
  async function usersUnder(subadminId) {
    const ids = [subadminId];
    let cursor = null;
    for (let page = 0; page < 10; page++) { // ponytail: 1,000-user ceiling per subadmin; raise the page cap if it matters
      const q = [Query.equal('parentId', subadminId), Query.orderAsc('$id'), Query.limit(100)];
      if (cursor) q.push(Query.cursorAfter(cursor));
      const r = await databases.listDocuments(DB, USERS_META, q);
      for (const d of r.documents) if (d.userId) ids.push(d.userId);
      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
    return ids;
  }
  // Appwrite caps a single equal() at 100 values, so larger id sets are OR-ed in chunks.
  function idsQuery(attr, ids) {
    if (ids.length <= 100) return Query.equal(attr, ids);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(Query.equal(attr, ids.slice(i, i + 100)));
    return Query.or(chunks);
  }
  // Resolves the userId scope for admin/subadmin list routes from ?userId, ?subadminId (that
  // subadmin's users), ?qrId (the QR's assigned user), intersected, then intersected again with a
  // subadmin caller's own users. Returns [] (unrestricted), [query], or null (provably empty).
  // 403 when a subadmin names a foreign user/subadmin.
  async function userScope(req, q = {}) {
    const allowed = await visibleUserIds(req);
    let target = null; // null = unrestricted
    const narrow = (ids) => { target = target ? target.filter((x) => ids.includes(x)) : [...new Set(ids)]; };
    if (q.userId) {
      if (allowed && !allowed.includes(String(q.userId))) throw fail(403, 'Not authorized for this user');
      narrow([String(q.userId)]);
    }
    if (q.subadminId) {
      if (allowed && !allowed.includes(String(q.subadminId))) throw fail(403, 'Not authorized for this subadmin');
      narrow(await usersUnder(String(q.subadminId)));
    }
    if (q.qrId) {
      const qr = (await databases.listDocuments(DB, QRCODES, [Query.equal('qrId', String(q.qrId)), Query.limit(1)])).documents[0];
      narrow(qr?.assignedUserId ? [qr.assignedUserId] : []);
    }
    if (allowed) narrow(allowed);
    if (!target) return [];
    if (!target.length) return null;
    return [idsQuery('userId', target)];
  }

  // ─── wallet primitives (paise) ─────────────────────────────────────────────
  async function getWallet(userId) {
    const r = await databases.listDocuments(DB, WALLETS, [Query.equal('userId', userId), Query.limit(1)]);
    return r.documents[0] || null;
  }
  async function getOrCreateWallet(userId) { // call only under the wallet lock
    const w = await getWallet(userId);
    if (w) return w;
    try {
      return await databases.createDocument(DB, WALLETS, ID.unique(), { userId, balancePaise: 0, holdPaise: 0, ...ZERO_LIFETIME, updatedAt: nowIso() });
    } catch (e) {
      const again = await getWallet(userId); // unique-index race fallback
      if (again) return again;
      throw e;
    }
  }
  // Lifetime totals kept on the wallet doc (paise / counts), maintained by moveWallet under the
  // wallet lock so dashboards never scan the ledger. Read with `|| 0` — wallets created before
  // the fields existed lack them.
  const ZERO_LIFETIME = { totalCreditedPaise: 0, totalPaidOutPaise: 0, totalPayoutCommissionPaise: 0, totalAdminDebitPaise: 0, totalRevertedToQrPaise: 0, paidCount: 0 };
  function lifetimeDelta(txn) {
    if (!txn) return {};
    const amount = Number(txn.amountPaise || 0);
    switch (txn.type) {
      case 'withdrawal_credit':
      case 'admin_credit': return { totalCreditedPaise: amount };
      case 'payout_paid': return { totalPaidOutPaise: amount, totalPayoutCommissionPaise: Number(txn.commissionPaise || 0), paidCount: 1 };
      case 'admin_debit': return { totalAdminDebitPaise: amount };
      case 'revert_to_qr': return { totalRevertedToQrPaise: amount };
      default: return {};
    }
  }
  function walletView(userId, w) {
    const balancePaise = Number(w?.balancePaise || 0);
    const holdPaise = Number(w?.holdPaise || 0);
    const availablePaise = balancePaise - holdPaise;
    return {
      userId, balancePaise, holdPaise, availablePaise,
      balanceRs: balancePaise / 100, holdRs: holdPaise / 100, availableRs: availablePaise / 100,
      totalCreditedPaise: Number(w?.totalCreditedPaise || 0),
      totalPaidOutPaise: Number(w?.totalPaidOutPaise || 0),
      totalPayoutCommissionPaise: Number(w?.totalPayoutCommissionPaise || 0),
      totalAdminDebitPaise: Number(w?.totalAdminDebitPaise || 0),
      totalRevertedToQrPaise: Number(w?.totalRevertedToQrPaise || 0),
      paidCount: Number(w?.paidCount || 0),
      updatedAt: w?.updatedAt || null,
    };
  }

  // ─── enable / disable customer payouts (platform-wide config + per-user flag) ──
  // Only NEW requests are blocked; viewing history, wallet, accounts stays open.
  const parseBool = (v, def) => (v == null ? def : !['false', '0', 'no', ''].includes(String(v).toLowerCase()));
  const DEFAULT_DISABLED_MESSAGE = 'Customer payouts are temporarily disabled. Please try again later.';
  function platformStatus() {
    return {
      enabled: parseBool(ConfigManager.get('customer_payouts_enabled', true), true),
      message: String(ConfigManager.get('customer_payouts_disabled_message', '') || '').trim() || DEFAULT_DISABLED_MESSAGE,
    };
  }
  async function payoutAccessFor(userId) {
    const platform = platformStatus();
    const user = await userMetaCache.getUserMeta(userId);
    const userDisabled = !!user?.payoutDisabled;
    const reason = user?.payoutDisabledReason || null;
    const enabled = platform.enabled && !userDisabled;
    return {
      enabled, platformEnabled: platform.enabled, userEnabled: !userDisabled,
      message: !platform.enabled ? platform.message : userDisabled ? `Customer payouts are disabled for your account${reason ? `: ${reason}` : ''}` : null,
    };
  }
  // ─── admin-tunable settings (config keys) ───────────────────────────────────
  const cfgRupeesPaise = (key) => { const v = Number(ConfigManager.get(key, 0)); return isFinite(v) && v > 0 ? Math.round(v * 100) : 0; }; // 0 = off
  const cfgInt = (key) => { const v = parseInt(ConfigManager.get(key, 0), 10); return isFinite(v) && v > 0 ? v : 0; };
  function settingsView() {
    return {
      customerPayouts: platformStatus(),
      realtimeEnabled: parseBool(ConfigManager.get('payout_realtime_enabled', true), true),
      requireVerifiedAccount: parseBool(ConfigManager.get('payout_require_verified_account', false), false),
      alerts: {
        enabled: parseBool(ConfigManager.get('payout_alerts_enabled', false), false),
        lowBalanceThresholdPaise: cfgRupeesPaise('payout_low_balance_threshold'),
        pendingAlertMinutes: cfgInt('payout_pending_alert_minutes'),
      },
      limits: { maxPerRequestPaise: cfgRupeesPaise('payout_max_per_request'), dailyLimitPaise: cfgRupeesPaise('payout_daily_limit'), maxPending: cfgInt('payout_max_pending') },
    };
  }

  // ─── per-user limits: user value (null = inherit platform, 0 = unlimited) over platform config ──
  function limitsFor(user) {
    const s = settingsView().limits;
    const pick = (userVal, cfgVal) => (userVal != null && isFinite(Number(userVal)) && Number(userVal) >= 0 ? Number(userVal) : cfgVal);
    return {
      maxPerRequestPaise: pick(user?.payoutMaxPerRequestPaise, s.maxPerRequestPaise),
      dailyLimitPaise: pick(user?.payoutDailyLimitPaise, s.dailyLimitPaise),
      maxPending: pick(user?.payoutMaxPending, s.maxPending),
    };
  }
  // Today's (IST) requested amount excluding rejected/cancelled, plus the current pending count.
  async function usageFor(userId) {
    const day = istDay();
    const q = [Query.equal('userId', userId), ...dateQueries(day, day), Query.orderAsc('$id'), Query.limit(100)];
    let usedTodayPaise = 0, requestedTodayCount = 0, cursor = null;
    for (let page = 0; page < 5; page++) { // ponytail: 500 requests/day/user ceiling for the daily-limit sum
      const r = await databases.listDocuments(DB, PAYOUTS, cursor ? [...q, Query.cursorAfter(cursor)] : q);
      for (const p of r.documents) if (p.status === 'pending' || p.status === 'paid') { usedTodayPaise += Number(p.amountPaise || 0); requestedTodayCount++; }
      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
    const pending = await databases.listDocuments(DB, PAYOUTS, [Query.equal('userId', userId), Query.equal('status', 'pending'), Query.limit(1)]);
    return { usedTodayPaise, requestedTodayCount, pendingCount: Number(pending.total || 0) };
  }
  const rs = (paise) => `₹${(paise / 100).toFixed(2)}`;
  function enforceLimits(limits, usage, amountPaise) {
    if (limits.maxPerRequestPaise && amountPaise > limits.maxPerRequestPaise) throw fail(400, `Amount exceeds your per-payout limit of ${rs(limits.maxPerRequestPaise)}`);
    if (limits.maxPending && usage.pendingCount >= limits.maxPending) throw fail(400, `You already have the maximum number of pending customer payouts (${limits.maxPending})`);
    if (limits.dailyLimitPaise && usage.usedTodayPaise + amountPaise > limits.dailyLimitPaise) throw fail(400, `This payout would exceed your daily limit of ${rs(limits.dailyLimitPaise)} (used ${rs(usage.usedTodayPaise)} today)`);
  }

  // ─── realtime (socket) — platform toggle + per-user opt-out; never throws ──
  async function notify(userId, payload, { toAdmins = true } = {}) {
    try {
      if (typeof emitPayoutEvent !== 'function' || !settingsView().realtimeEnabled) return;
      const user = userId ? await userMetaCache.getUserMeta(userId) : null;
      emitPayoutEvent({ userId: user && user.payoutRealtimeDisabled === true ? null : userId, event: 'payout:update', payload: { ...payload, at: nowIso() }, toAdmins });
    } catch (e) { console.error('payout notify failed:', e?.message); }
  }
  // Low-balance alert when a wallet's available drops below the configured threshold (admin toggle).
  function lowBalanceAlert(userId, availableBefore, availableAfter) {
    try {
      const s = settingsView().alerts;
      if (!s.enabled || !s.lowBalanceThresholdPaise || typeof emitPayoutEvent !== 'function') return;
      if (availableAfter < s.lowBalanceThresholdPaise && availableBefore >= s.lowBalanceThresholdPaise) {
        emitPayoutEvent({ userId, event: 'payout:alert', toAdmins: true, payload: { type: 'low_balance', userId, availablePaise: availableAfter, thresholdPaise: s.lowBalanceThresholdPaise, at: nowIso() } });
      }
    } catch (e) { console.error('payout low-balance alert failed:', e?.message); }
  }

  // ─── "paid via" source accounts (quick-pick list) ───────────────────────────
  const pickSource = (d) => ({ $id: d.$id, label: d.label, useCount: Number(d.useCount || 0), totalPaidPaise: Number(d.totalPaidPaise || 0), totalPaidRs: Number(d.totalPaidPaise || 0) / 100, lastUsedAt: d.lastUsedAt || null, addedBy: d.addedBy || null, createdAt: d.createdAt || null, active: d.active !== false });
  async function findSource(label) {
    const r = await databases.listDocuments(DB, SOURCE_ACCOUNTS, [Query.equal('labelKey', label.toLowerCase()), Query.limit(1)]);
    return r.documents[0] || null;
  }
  async function upsertSource(label, by) {
    const existing = await findSource(label);
    if (existing) return existing;
    try {
      return await databases.createDocument(DB, SOURCE_ACCOUNTS, ID.unique(), { label, labelKey: label.toLowerCase(), addedBy: by || null, createdAt: nowIso(), lastUsedAt: null, useCount: 0, totalPaidPaise: 0, active: true });
    } catch (e) {
      const again = await findSource(label);
      if (again) return again;
      throw e;
    }
  }
  // Best-effort usage bump at "paid" time — never fails the payout. Serialized per label so two
  // admins paying from the same source at once cannot lose a count (read-modify-write).
  async function touchSource(label, amountPaise, by) {
    if (!SOURCE_ACCOUNTS || !label) return;
    const key = `lock:payoutsource:${label.toLowerCase()}`;
    let val = null;
    try {
      val = await acquireRetry(key, 5, 5);
      if (!val) { console.error(`payout: source account bump skipped (lock busy) for "${label}"`); return; }
      const s = await upsertSource(label, by);
      await databases.updateDocument(DB, SOURCE_ACCOUNTS, s.$id, { useCount: Number(s.useCount || 0) + 1, totalPaidPaise: Number(s.totalPaidPaise || 0) + amountPaise, lastUsedAt: nowIso(), active: true });
    } catch (e) { console.error(`payout: source account bump failed for "${label}":`, e?.message); }
    finally { if (val) await releaseQuiet(key, val); }
  }

  // users_meta doc by userId (docId === userId for new docs; older docs need the query fallback)
  async function findUserMetaDoc(userId) {
    const direct = await databases.getDocument(DB, USERS_META, userId).catch(() => null);
    if (direct && direct.userId === userId) return direct;
    const r = await databases.listDocuments(DB, USERS_META, [Query.equal('userId', userId), Query.limit(1)]);
    return r.documents[0] || null;
  }
  async function findWalletTxn(type, refId) {
    const r = await databases.listDocuments(DB, WALLET_TXNS, [Query.equal('type', type), Query.equal('refId', refId), Query.limit(1)]);
    return r.documents[0] || null;
  }

  // Apply balance/hold deltas to a user's wallet. MUST be called under withWalletLock.
  // Guards every field and `available` against going negative (409). When `txn` is given a
  // ledger row is written first and rolled back if the wallet write fails (same
  // doc-first/rollback pattern as /withdraw_new).
  async function moveWallet(userId, { deltaBalance = 0, deltaHold = 0, txn = null }) {
    const w = await getOrCreateWallet(userId);
    const balancePaise = Number(w.balancePaise || 0) + deltaBalance;
    const holdPaise = Number(w.holdPaise || 0) + deltaHold;
    if (balancePaise < 0 || holdPaise < 0 || balancePaise - holdPaise < 0) {
      throw fail(409, 'Insufficient payout wallet balance');
    }
    let row = null;
    if (txn) {
      row = await databases.createDocument(DB, WALLET_TXNS, ID.unique(), {
        id: genId('pwt_'), ...txn, balanceAfterPaise: balancePaise, holdAfterPaise: holdPaise, createdAt: nowIso(),
      });
    }
    const lifetime = {};
    for (const [k, d] of Object.entries(lifetimeDelta(txn))) lifetime[k] = Number(w[k] || 0) + d;
    const availableBefore = Number(w.balancePaise || 0) - Number(w.holdPaise || 0);
    try {
      await databases.updateDocument(DB, WALLETS, w.$id, { balancePaise, holdPaise, ...lifetime, updatedAt: nowIso() });
    } catch (e) {
      if (row) {
        await databases.deleteDocument(DB, WALLET_TXNS, row.$id)
          .catch((e2) => console.error(`CRITICAL: payout wallet update failed AND ledger rollback failed. Orphan txn ${row.$id} user=${userId}`, e2));
      }
      throw e;
    }
    if (deltaBalance) await inc('totalPayoutWalletBalance', deltaBalance);
    lowBalanceAlert(userId, availableBefore, balancePaise - holdPaise);
    return { wallet: { ...w, balancePaise, holdPaise, ...lifetime }, txn: row };
  }

  // Credit an approved mode:'wallet' withdrawal into the user's payout wallet. Idempotent on
  // (type:'withdrawal_credit', refId: withdrawal business id). Throws on lock/DB failure.
  async function creditWalletFromWithdrawal(w) {
    const amountPaise = Math.round(Number(w.preAmount) * 100);
    if (!(amountPaise > 0)) throw fail(400, 'Invalid withdrawal amount for wallet credit');
    return withWalletLock(w.userId, LOCK_TTL_REQUEST, async () => {
      const existing = await findWalletTxn('withdrawal_credit', w.id);
      if (existing) return { skipped: true, txn: existing };
      const r = await moveWallet(w.userId, {
        deltaBalance: amountPaise,
        txn: {
          userId: w.userId, type: 'withdrawal_credit', direction: 'credit',
          amountPaise, commissionPaise: 0, totalPaise: amountPaise,
          refType: 'withdrawal', refId: w.id, referenceNumber: null,
          notes: `Withdrawal ${w.id} from QR ${w.qrId}`, createdBy: null,
        },
      });
      await notify(w.userId, { type: 'wallet_changed', userId: w.userId, reason: 'withdrawal_credit', withdrawalId: w.id, amountPaise, wallet: walletView(w.userId, r.wallet) });
      return { skipped: false, txn: r.txn };
    });
  }

  // ─── projections ───────────────────────────────────────────────────────────
  const pickWalletTxn = (d) => ({
    $id: d.$id, id: d.id, userId: d.userId, type: d.type, direction: d.direction,
    amountPaise: d.amountPaise, commissionPaise: d.commissionPaise || 0, totalPaise: d.totalPaise,
    amountRs: Number(d.amountPaise || 0) / 100, totalRs: Number(d.totalPaise || 0) / 100,
    balanceAfterPaise: d.balanceAfterPaise, holdAfterPaise: d.holdAfterPaise,
    refType: d.refType, refId: d.refId, referenceNumber: d.referenceNumber || null,
    notes: d.notes || null, createdBy: d.createdBy || null, createdAt: d.createdAt,
  });
  // Per-account payout stats live on the account doc (paise / counts), bumped inside the same
  // wallet-locked operations that create/pay/reject a request. Read with `|| 0`.
  const VERIFICATION_STATUSES = ['unverified', 'verified', 'name_mismatch', 'failed'];
  const pickAccount = (d) => {
    const requestCount = Number(d.requestCount || 0), paidCount = Number(d.paidCount || 0), rejectedCount = Number(d.rejectedCount || 0), cancelledCount = Number(d.cancelledCount || 0);
    const totalPaidPaise = Number(d.totalPaidPaise || 0), totalCommissionPaise = Number(d.totalCommissionPaise || 0);
    return {
      $id: d.$id, userId: d.userId, customerName: d.customerName, bankName: d.bankName,
      ifscCode: d.ifscCode, accountNumber: d.accountNumber, upiId: d.upiId || null, bankingStatus: d.bankingStatus || 'not_added',
      notes: d.notes || null, createdAt: d.createdAt,
      bankingStatusUpdatedAt: d.bankingStatusUpdatedAt || null, bankingStatusUpdatedBy: d.bankingStatusUpdatedBy || null,
      // beneficiary verification (set by staff)
      verificationStatus: d.verificationStatus || 'unverified', verifiedName: d.verifiedName || null,
      verifiedAt: d.verifiedAt || null, verifiedBy: d.verifiedBy || null, verificationNote: d.verificationNote || null,
      // stats
      requestCount, paidCount, rejectedCount, cancelledCount, pendingCount: Math.max(0, requestCount - paidCount - rejectedCount - cancelledCount),
      totalPaidPaise, totalPaidRs: totalPaidPaise / 100, totalCommissionPaise,
      lastRequestedAt: d.lastRequestedAt || null, lastPaidAt: d.lastPaidAt || null,
    };
  };
  // Best-effort counter bump on the account doc; never fails the money operation (repair: recompute-stats).
  async function bumpAccountStats(accountId, deltas, stamps = {}) {
    try {
      const a = await databases.getDocument(DB, ACCOUNTS, accountId);
      const patch = { ...stamps };
      for (const [k, d] of Object.entries(deltas)) patch[k] = Number(a[k] || 0) + d;
      await databases.updateDocument(DB, ACCOUNTS, accountId, patch);
    } catch (e) {
      console.error(`payout: account stats bump failed for ${accountId} (run recompute-stats):`, e?.message);
    }
  }
  // Recompute-and-overwrite from the account's payout rows (idempotent repair path).
  async function recomputeAccountStats(accountId) {
    const stats = { requestCount: 0, paidCount: 0, rejectedCount: 0, cancelledCount: 0, totalPaidPaise: 0, totalCommissionPaise: 0, lastRequestedAt: null, lastPaidAt: null };
    let cursor = null;
    for (let page = 0; page < 100; page++) { // ponytail: 10k rows per account; nobody has that many
      const q = [Query.equal('accountId', accountId), Query.orderAsc('$id'), Query.limit(100)];
      if (cursor) q.push(Query.cursorAfter(cursor));
      const r = await databases.listDocuments(DB, PAYOUTS, q);
      for (const p of r.documents) {
        stats.requestCount++;
        if (!stats.lastRequestedAt || p.createdAt > stats.lastRequestedAt) stats.lastRequestedAt = p.createdAt;
        if (p.status === 'paid') {
          stats.paidCount++;
          stats.totalPaidPaise += Number(p.amountPaise || 0);
          stats.totalCommissionPaise += Number(p.commissionPaise || 0);
          const at = p.paidAt || p.processedAt || null;
          if (at && (!stats.lastPaidAt || at > stats.lastPaidAt)) stats.lastPaidAt = at;
        } else if (p.status === 'rejected') stats.rejectedCount++;
        else if (p.status === 'cancelled') stats.cancelledCount++;
      }
      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
    return databases.updateDocument(DB, ACCOUNTS, accountId, stats);
  }
  // Whole minutes between two ISO stamps, clamped at 0; null when either is missing/invalid.
  function minutesBetween(startIso, endIso) {
    if (!startIso || !endIso) return null;
    const a = Date.parse(startIso), b = Date.parse(endIso);
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.round((b - a) / 60000));
  }
  // `staff` = admin / labelled employee view: adds paidVia (which of OUR accounts paid it) — never
  // shown to users or subadmins.
  const pickPayout = (d, staff = false) => ({
    $id: d.$id, id: d.id, userId: d.userId, accountId: d.accountId,
    ...(staff ? { paidVia: d.paidVia || null } : {}),
    // Service timeline (UTC ISO) + derived durations for "added in X min / paid in Y min" badges
    requestedAt: d.createdAt,
    addedToBankingAt: d.addedToBankingAt || null,
    paidAt: d.paidAt || null,
    rejectedAt: d.rejectedAt || null,
    cancelledAt: d.cancelledAt || null,
    addedInMinutes: minutesBetween(d.createdAt, d.addedToBankingAt),
    paidInMinutes: minutesBetween(d.createdAt, d.paidAt),
    rejectedInMinutes: minutesBetween(d.createdAt, d.rejectedAt),
    cancelledInMinutes: minutesBetween(d.createdAt, d.cancelledAt),
    customerName: d.customerName, bankName: d.bankName, ifscCode: d.ifscCode, accountNumber: d.accountNumber, upiId: d.upiId || null,
    mode: d.mode, amountPaise: d.amountPaise, commissionPaise: d.commissionPaise, totalPaise: d.totalPaise,
    amountRs: Number(d.amountPaise || 0) / 100, commissionRs: Number(d.commissionPaise || 0) / 100, totalRs: Number(d.totalPaise || 0) / 100,
    commissionRate: d.commissionRate, notes: d.notes || null, status: d.status,
    referenceNumber: d.referenceNumber || null, rejectionReason: d.rejectionReason || null,
    createdAt: d.createdAt, processedAt: d.processedAt || null, processedBy: d.processedBy || null,
    accountBankingStatus: d.accountBankingStatus || null,
    accountVerificationStatus: d.accountVerificationStatus || null,
  });
  const pickCommission = (d) => ({
    $id: d.$id, id: d.$id, userId: d.userId, sourcePayoutId: d.sourcePayoutId, amount: d.amount,
    commissionRate: d.commissionRate, earningType: d.earningType, createdAt: d.createdAt,
  });

  // Attach the CURRENT bankingStatus of each payout's beneficiary account (the payout row only
  // snapshots bank details; the not_added/added tag must reflect the live account).
  async function attachBankingStatus(payouts) {
    const ids = [...new Set(payouts.map((p) => p.accountId).filter(Boolean))];
    if (!ids.length) return payouts;
    const r = await databases.listDocuments(DB, ACCOUNTS, [Query.equal('$id', ids), Query.limit(ids.length)]);
    const byId = Object.fromEntries(r.documents.map((a) => [a.$id, a]));
    return payouts.map((p) => {
      const a = byId[p.accountId];
      return { ...p, accountBankingStatus: a ? (a.bankingStatus || 'not_added') : null, accountVerificationStatus: a ? (a.verificationStatus || 'unverified') : null };
    });
  }

  // ─── commission (mirrors withdraw.js: user rate → parent earns, parent rate → admin earns) ──
  async function payoutRatesFor(userId) {
    const user = await userMetaCache.getUserMeta(userId);
    if (!user) throw fail(404, 'User not found');
    const def = defaultPayoutCommission();
    const userRate = Number(user.payoutCommission ?? def);
    const parent = user.parentId ? await userMetaCache.getUserMeta(user.parentId) : null;
    const parentRate = parent ? Number(parent.payoutCommission ?? def) : 0;
    const bad = (r) => !isFinite(r) || r < 0 || r > 100;
    if (bad(userRate)) throw fail(422, 'Your payout commission rate is invalid. Please contact support.');
    if (bad(parentRate)) throw fail(422, 'Parent payout commission rate is invalid. Please contact support.');
    if (userRate + parentRate > 100) throw fail(422, 'Combined payout commission rate exceeds 100%. Please contact support.');
    return { user, parentId: user.parentId || null, userRate, parentRate, totalRate: userRate + parentRate };
  }

  async function recordPayoutCommission(p) {
    const user = await userMetaCache.getUserMeta(p.userId);
    const admin = await getAdminMeta();
    if (!admin) console.warn('Admin metadata not found — admin payout commission will be skipped');
    const txs = [];
    const push = (userId, rate) => {
      const amount = calculateCommissionPaise(Number(p.amountPaise), Number(rate || 0));
      if (amount > 0) txs.push({ userId, sourcePayoutId: p.id, amount, commissionRate: Number(rate), earningType: userId === admin?.userId ? 'admin' : 'subadmin', createdAt: nowIso() });
    };
    const parent = user?.parentId ? await userMetaCache.getUserMeta(user.parentId) : null;
    if (parent) {
      push(parent.userId, p.userCommissionRate);            // user's rate → their subadmin
      if (admin) push(admin.userId, p.parentCommissionRate); // parent's rate → admin
    } else if (admin) {
      // No (live) parent: the whole held commission goes to admin — never silently dropped.
      push(admin.userId, Number(p.userCommissionRate || 0) + Number(p.parentCommissionRate || 0));
    }
    for (const tx of txs) {
      await databases.createDocument(DB, COMMISSION_TXNS, ID.unique(), tx); // source of truth
      await inc(tx.earningType === 'admin' ? 'totalPayoutAdminProfit' : 'totalPayoutMerchantProfit', tx.amount);
    }
    try {
      await upsertDailyPayoutCommission(txs);
      await upsertPeriodTotals(txs);
    } catch (e) {
      console.error(`CRITICAL: payout commission rollup failed for ${p.id}. Raw tx docs saved. Needs reconciliation.`, e);
      await databases.updateDocument(DB, PAYOUTS, p.$id, { commissionRollupFailed: true })
        .catch((e2) => console.error(`CRITICAL: Could not mark commissionRollupFailed on payout ${p.id}`, e2));
    }
  }

  async function upsertDailyPayoutCommission(txs) {
    const perUser = {};
    for (const { userId, amount } of txs) perUser[userId] = (perUser[userId] || 0) + Number(amount || 0);
    if (!Object.keys(perUser).length) return;
    const day = istDay();
    const key = `lock:payoutcommission:daily:${day}`;
    const val = await acquireRetry(key);
    if (!val) throw new Error(`Could not acquire daily payout commission lock for ${day}`);
    try {
      const existing = await databases.listDocuments(DB, DAILY_COMMISSION, [Query.equal('date', day), Query.limit(1)]);
      const doc = existing.documents[0] || null;
      let obj = {};
      try { obj = doc ? (JSON.parse(doc.commissionsJson || '{}') || {}) : {}; } catch { obj = {}; }
      for (const [uid, amt] of Object.entries(perUser)) obj[uid] = (obj[uid] || 0) + amt;
      const payload = { date: day, commissionsJson: JSON.stringify(obj) };
      if (doc) await databases.updateDocument(DB, DAILY_COMMISSION, doc.$id, payload);
      else await databases.createDocument(DB, DAILY_COMMISSION, ID.unique(), payload);
    } finally {
      await releaseQuiet(key, val);
    }
  }

  // One row per (userId, month) and one per userId; totalCommissionPaise merged under a lock,
  // create-then-reread on unique collision (mirrors withdraw.js monthly/all-time rollups).
  async function upsertTotal({ collection, match, base, lockKey, delta }) {
    const val = await acquireRetry(lockKey);
    if (!val) throw new Error(`Could not acquire ${lockKey}`);
    try {
      const find = () => databases.listDocuments(DB, collection, [...match, Query.limit(1)]);
      const bump = async (row) => {
        const total = Number(row.totalCommissionPaise || 0) + delta;
        if (total < 0) throw new Error(`Negative payout commission total for ${lockKey}`);
        await databases.updateDocument(DB, collection, row.$id, { totalCommissionPaise: total });
      };
      const row = (await find()).documents[0];
      if (row) return bump(row);
      try {
        await databases.createDocument(DB, collection, ID.unique(), { ...base, totalCommissionPaise: delta });
      } catch (e) {
        const again = (await find()).documents[0];
        if (!again) throw e;
        await bump(again);
      }
    } finally {
      await releaseQuiet(lockKey, val);
    }
  }
  async function upsertPeriodTotals(txs) {
    const perUser = {};
    for (const { userId, amount } of txs) perUser[userId] = (perUser[userId] || 0) + Number(amount || 0);
    const month = istMonth();
    for (const [userId, delta] of Object.entries(perUser)) {
      if (!delta) continue;
      await upsertTotal({ collection: MONTHLY_COMMISSION, match: [Query.equal('userId', userId), Query.equal('month', month)], base: { userId, month }, lockKey: `lock:payoutcommission:monthly:${userId}:${month}`, delta });
      await upsertTotal({ collection: ALLTIME_COMMISSION, match: [Query.equal('userId', userId)], base: { userId }, lockKey: `lock:payoutcommission:alltime:${userId}`, delta });
    }
  }

  // ─── beneficiary account helpers ───────────────────────────────────────────
  function validateUpiId(upiId) {
    const upi = String(upiId || '').trim();
    if (upi && !UPI_RE.test(upi)) throw fail(400, 'Invalid UPI ID format (expected handle@provider)');
    return upi || null;
  }
  function validateAccountInput({ customerName, bankName, ifscCode, accountNumber, confirmAccountNumber, upiId }) {
    const name = String(customerName || '').trim();
    const bank = String(bankName || '').trim();
    const ifsc = String(ifscCode || '').trim().toUpperCase();
    const acct = String(accountNumber ?? '').trim();
    const confirm = String(confirmAccountNumber ?? '').trim();
    if (name.length < 2 || name.length > 100) throw fail(400, 'Customer name is required (2–100 characters)');
    if (bank.length < 2 || bank.length > 100) throw fail(400, 'Bank name is required (2–100 characters)');
    if (!IFSC_RE.test(ifsc)) throw fail(400, 'Invalid IFSC code format (e.g. SBIN0001234)');
    if (!ACCT_RE.test(acct)) throw fail(400, 'Invalid account number (must be 8–18 digits)');
    if (acct !== confirm) throw fail(400, 'Account numbers do not match');
    return { customerName: name, bankName: bank, ifscCode: ifsc, accountNumber: acct, upiId: validateUpiId(upiId) };
  }
  // Reuse an existing (userId, accountNumber) account rather than duplicating it — admin may
  // already have tagged it `added`. Existing details are never overwritten, except a missing
  // upiId which is filled in when supplied.
  async function findOrCreateAccount(userId, input, notes) {
    const fields = validateAccountInput(input);
    const find = async () => (await databases.listDocuments(DB, ACCOUNTS, [Query.equal('userId', userId), Query.equal('accountNumber', fields.accountNumber), Query.limit(1)])).documents[0] || null;
    const existing = await find();
    if (existing) return { account: await fillUpiId(existing, fields.upiId), created: false };
    try {
      const account = await databases.createDocument(DB, ACCOUNTS, ID.unique(), {
        userId, ...fields, bankingStatus: 'not_added', notes: notes ? String(notes).trim().slice(0, 500) : null, createdAt: nowIso(),
      });
      return { account, created: true };
    } catch (e) {
      const again = await find(); // two concurrent adds of the same account: unique index rejects one → reuse the winner
      if (!again) throw e;
      return { account: await fillUpiId(again, fields.upiId), created: false };
    }
  }
  async function fillUpiId(account, upiId) {
    if (account.upiId || !upiId) return account;
    return databases.updateDocument(DB, ACCOUNTS, account.$id, { upiId });
  }
  async function loadOwnAccount(userId, accountId) {
    const account = await databases.getDocument(DB, ACCOUNTS, String(accountId)).catch(() => null);
    if (!account || account.userId !== userId) throw fail(404, 'Customer payout account not found');
    return account;
  }
  async function deleteAccount(account) {
    const pending = await databases.listDocuments(DB, PAYOUTS, [Query.equal('accountId', account.$id), Query.equal('status', 'pending'), Query.limit(1)]);
    if (pending.documents[0]) throw fail(409, 'Account has a pending payout request');
    await databases.deleteDocument(DB, ACCOUNTS, account.$id); // paid/rejected rows keep their snapshot
  }
  function rupeesFilter(v, label) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!isFinite(n) || n < 0) throw fail(400, `Invalid ${label}`);
    return Math.round(n * 100);
  }
  function accountSearchQueries(search) {
    const s = String(search || '').trim();
    if (!s) return [];
    if (/^\d+$/.test(s)) return [Query.startsWith('accountNumber', s)];
    return [Query.search('customerName', s)]; // fulltext index on customerName
  }
  async function loadPayoutByBusinessId(id) {
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw fail(400, 'Invalid payout id');
    const r = await databases.listDocuments(DB, PAYOUTS, [Query.equal('id', id), Query.limit(1)]);
    if (!r.documents[0]) throw fail(404, 'Customer payout request not found');
    return r.documents[0];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USER ROUTES (authenticateToken; always scoped to req.user.userId)
  // ═══════════════════════════════════════════════════════════════════════════

  router.get('/wallet', authenticateToken, async (req, res) => {
    try {
      const [wallet, access] = await Promise.all([getWallet(req.user.userId), payoutAccessFor(req.user.userId)]);
      res.json({ success: true, wallet: walletView(req.user.userId, wallet), access });
    } catch (e) { sendError(res, e, 'Failed to fetch payout wallet'); }
  });

  // Can this user create a new customer payout right now, and within what limits?
  // { enabled, platformEnabled, userEnabled, message, limits, usage, preferences, requireVerifiedAccount }
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const [access, user, usage] = await Promise.all([payoutAccessFor(req.user.userId), userMetaCache.getUserMeta(req.user.userId), usageFor(req.user.userId)]);
      res.json({
        success: true, ...access, limits: limitsFor(user), usage,
        preferences: { realtime: !(user?.payoutRealtimeDisabled === true) }, realtimeEnabled: settingsView().realtimeEnabled,
        requireVerifiedAccount: settingsView().requireVerifiedAccount,
      });
    } catch (e) { sendError(res, e, 'Failed to fetch payout status'); }
  });

  // Own UI preferences. Body: { realtime: boolean } — opt out of live socket updates for this user.
  router.patch('/me/preferences', authenticateToken, async (req, res) => {
    try {
      if (typeof req.body.realtime !== 'boolean') throw fail(400, 'realtime must be true or false');
      const doc = await findUserMetaDoc(req.user.userId);
      if (!doc) throw fail(404, 'User not found');
      await databases.updateDocument(DB, USERS_META, doc.$id, { payoutRealtimeDisabled: !req.body.realtime });
      await userMetaCache.invalidate(req.user.userId);
      res.json({ success: true, preferences: { realtime: req.body.realtime } });
    } catch (e) { sendError(res, e, 'Failed to update preferences'); }
  });

  async function listWalletTxns(userId, q) {
    const limit = parseLimit(q.limit);
    const queries = [Query.equal('userId', userId)];
    if (q.type) {
      if (!WALLET_TXN_TYPES.includes(q.type)) throw fail(400, 'Invalid type');
      queries.push(Query.equal('type', q.type));
    }
    queries.push(...dateQueries(q.from, q.to), Query.orderDesc('createdAt'), ...cursorQuery(q.cursor), Query.limit(limit));
    const r = await databases.listDocuments(DB, WALLET_TXNS, queries);
    return { success: true, total: r.total, transactions: r.documents.map(pickWalletTxn), nextCursor: nextCursorOf(r.documents, limit) };
  }

  router.get('/wallet/transactions', authenticateToken, async (req, res) => {
    try { res.json(await listWalletTxns(req.user.userId, req.query)); }
    catch (e) { sendError(res, e, 'Failed to fetch payout wallet transactions'); }
  });

  // Commission + balance preview for the request form. amount in rupees.
  router.get('/commission-preview', authenticateToken, async (req, res) => {
    try {
      const amountPaise = toPaise(req.query.amount);
      if (amountPaise == null) throw fail(400, 'Invalid amount');
      const { totalRate } = await payoutRatesFor(req.user.userId);
      const commissionPaise = calculateCommissionPaise(amountPaise, totalRate);
      const totalPaise = amountPaise + commissionPaise;
      const wallet = walletView(req.user.userId, await getWallet(req.user.userId));
      res.json({
        success: true, amountPaise, commissionPaise, totalPaise, commissionRate: totalRate,
        amountRs: amountPaise / 100, commissionRs: commissionPaise / 100, totalRs: totalPaise / 100,
        availablePaise: wallet.availablePaise, sufficient: totalPaise <= wallet.availablePaise,
      });
    } catch (e) { sendError(res, e, 'Failed to preview payout commission'); }
  });

  // Account lists: search, bankingStatus, from/to (createdAt, IST days), minTotalPaid (rupees),
  // sort (createdAt | totalPaid | paidCount | requestCount | lastPaidAt), order (asc | desc)
  const ACCOUNT_SORTS = { createdAt: '$createdAt', totalPaid: 'totalPaidPaise', paidCount: 'paidCount', requestCount: 'requestCount', lastPaidAt: 'lastPaidAt' };
  async function listAccounts(q, scopeQueries) {
    const limit = parseLimit(q.limit);
    if (scopeQueries === null) return { success: true, total: 0, accounts: [], nextCursor: null };
    const queries = [...scopeQueries, ...accountSearchQueries(q.search)];
    if (q.bankingStatus) {
      if (!BANKING_STATUSES.includes(q.bankingStatus)) throw fail(400, 'Invalid bankingStatus');
      queries.push(Query.equal('bankingStatus', q.bankingStatus));
    }
    if (q.verificationStatus) {
      if (!VERIFICATION_STATUSES.includes(q.verificationStatus)) throw fail(400, 'Invalid verificationStatus');
      // legacy rows have no value → treat as unverified
      queries.push(q.verificationStatus === 'unverified' ? Query.or([Query.equal('verificationStatus', 'unverified'), Query.isNull('verificationStatus')]) : Query.equal('verificationStatus', q.verificationStatus));
    }
    const minPaid = rupeesFilter(q.minTotalPaid, 'minTotalPaid');
    if (minPaid != null) queries.push(Query.greaterThanEqual('totalPaidPaise', minPaid));
    const sortAttr = ACCOUNT_SORTS[q.sort || 'createdAt'];
    if (!sortAttr) throw fail(400, 'Invalid sort');
    if (q.order && !['asc', 'desc'].includes(q.order)) throw fail(400, 'Invalid order');
    queries.push(...dateQueries(q.from, q.to), q.order === 'asc' ? Query.orderAsc(sortAttr) : Query.orderDesc(sortAttr), ...cursorQuery(q.cursor), Query.limit(limit));
    const r = await databases.listDocuments(DB, ACCOUNTS, queries);
    return { success: true, total: r.total, accounts: r.documents.map(pickAccount), nextCursor: nextCursorOf(r.documents, limit) };
  }
  // Account detail: the account (with stats) + its payout history (status/mode/sort/etc. filters apply)
  async function accountWithPayouts(account, q, staff = false) {
    const list = await listPayouts({ ...q, accountId: account.$id }, [Query.equal('userId', account.userId)], staff);
    return { success: true, account: pickAccount(account), total: list.total, payouts: list.payouts, nextCursor: list.nextCursor };
  }
  // Single request by business id (cpo_…) with the live account tag attached
  async function payoutView(doc, staff) {
    return pickPayout((await attachBankingStatus([doc]))[0], staff);
  }

  router.get('/accounts', authenticateToken, async (req, res) => {
    try { res.json(await listAccounts(req.query, [Query.equal('userId', req.user.userId)])); }
    catch (e) { sendError(res, e, 'Failed to fetch customer payout accounts'); }
  });

  // Customer payouts are a user/subadmin feature — admin manages them, never holds a wallet of their own.
  const notForAdmin = (req) => { if (req.user.role === 'admin') throw fail(403, 'Customer payouts are for users and subadmins only'); };

  router.get('/accounts/:accountId/payouts', authenticateToken, async (req, res) => {
    try { res.json(await accountWithPayouts(await loadOwnAccount(req.user.userId, req.params.accountId), req.query)); }
    catch (e) { sendError(res, e, 'Failed to fetch customer payout account history'); }
  });

  router.post('/accounts', authenticateToken, async (req, res) => {
    try {
      notForAdmin(req);
      const { account, created } = await findOrCreateAccount(req.user.userId, req.body, req.body.notes);
      res.status(created ? 201 : 200).json({ success: true, created, account: pickAccount(account) });
    } catch (e) { sendError(res, e, 'Failed to save customer payout account'); }
  });

  router.delete('/accounts/:accountId', authenticateToken, async (req, res) => {
    try {
      await deleteAccount(await loadOwnAccount(req.user.userId, req.params.accountId));
      res.json({ success: true, message: 'Customer payout account deleted' });
    } catch (e) { sendError(res, e, 'Failed to delete customer payout account'); }
  });

  // Create a customer payout request. Holds amount+commission in the wallet until admin resolves it.
  // Body: { accountId, upiId? } OR { customerName, bankName, ifscCode, accountNumber, confirmAccountNumber, upiId? },
  //       plus mode (NEFT|IMPS|RTGS|UPI — UPI requires the account to have a upiId), amount (rupees), notes?
  router.post('/requests', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
      notForAdmin(req);
      const access = await payoutAccessFor(userId);
      if (!access.enabled) throw fail(403, access.message);
      const mode = String(req.body.mode || '').toUpperCase();
      if (!PAYOUT_MODES.includes(mode)) throw fail(400, 'Invalid mode. Must be NEFT, IMPS, RTGS or UPI.');
      const amountPaise = toPaise(req.body.amount);
      if (amountPaise == null) throw fail(400, 'Invalid amount');
      const notes = req.body.notes ? String(req.body.notes).trim().slice(0, 500) : null;

      // Order: validate input (400) → rates (422) + affordability (409) → only then create/fill the
      // account, so a rejected request never leaves a freshly created account behind.
      let account = null;
      let upiId = null;
      if (req.body.accountId) {
        account = await loadOwnAccount(userId, req.body.accountId);
        upiId = validateUpiId(req.body.upiId);
        if (mode === 'UPI' && !account.upiId && !upiId) throw fail(400, 'UPI ID is required for a UPI payout');
      } else {
        upiId = validateAccountInput(req.body).upiId;
        if (mode === 'UPI' && !upiId) throw fail(400, 'UPI ID is required for a UPI payout');
      }

      const { user, userRate, parentRate, totalRate } = await payoutRatesFor(userId);
      const limits = limitsFor(user);
      if (limits.maxPerRequestPaise || limits.dailyLimitPaise || limits.maxPending) enforceLimits(limits, await usageFor(userId), amountPaise); // skip the usage scans when nothing is limited
      const commissionPaise = calculateCommissionPaise(amountPaise, totalRate);
      const totalPaise = amountPaise + commissionPaise;
      if (walletView(userId, await getWallet(userId)).availablePaise < totalPaise) throw fail(409, 'Insufficient payout wallet balance');

      account = account ? await fillUpiId(account, upiId) : (await findOrCreateAccount(userId, req.body, null)).account;
      if (mode === 'UPI' && !account.upiId) throw fail(400, 'UPI ID is required for a UPI payout'); // reused account without VPA
      if (settingsView().requireVerifiedAccount && (account.verificationStatus || 'unverified') !== 'verified') throw fail(400, 'This customer account is not verified yet. Please wait for verification.');
      const id = genId('cpo_');

      const payout = await withWalletLock(userId, LOCK_TTL_REQUEST, async () => {
        await moveWallet(userId, { deltaHold: totalPaise }); // 409 if available < total
        try {
          const doc = await databases.createDocument(DB, PAYOUTS, ID.unique(), {
            id, userId, accountId: account.$id,
            customerName: account.customerName, bankName: account.bankName, ifscCode: account.ifscCode, accountNumber: account.accountNumber,
            upiId: account.upiId || null,
            mode, amountPaise, commissionPaise, totalPaise,
            commissionRate: totalRate, userCommissionRate: userRate, parentCommissionRate: parentRate,
            notes, status: 'pending', referenceNumber: null, rejectionReason: null,
            createdAt: nowIso(), processedAt: null, processedBy: null,
            // Beneficiary already in the banking portal → no wait; otherwise stamped when admin tags it `added`.
            addedToBankingAt: account.bankingStatus === 'added' ? (account.bankingStatusUpdatedAt || nowIso()) : null,
            paidAt: null, rejectedAt: null,
          });
          await bumpAccountStats(account.$id, { requestCount: 1 }, { lastRequestedAt: doc.createdAt });
          return doc;
        } catch (e) {
          await moveWallet(userId, { deltaHold: -totalPaise })
            .catch((e2) => console.error(`CRITICAL: payout doc create failed AND hold rollback failed. user=${userId} hold=${totalPaise}`, e2));
          throw e;
        }
      });
      await inc('totalCustomerPayoutPendingAmount', amountPaise);
      await inc('totalCustomerPayoutPendingCount', 1);
      await notify(userId, { type: 'request_created', userId, payoutId: payout.id, status: 'pending', amountPaise });
      res.status(201).json({ success: true, payout: pickPayout({ ...payout, accountBankingStatus: account.bankingStatus || 'not_added', accountVerificationStatus: account.verificationStatus || 'unverified' }) });
    } catch (e) { sendError(res, e, 'Failed to create customer payout request'); }
  });

  // User cancels their own PENDING request: releases the hold, no money moves, no commission.
  router.post('/requests/:id/cancel', authenticateToken, async (req, res) => {
    try {
      const found = await loadPayoutByBusinessId(req.params.id);
      if (found.userId !== req.user.userId) throw fail(404, 'Customer payout request not found');
      if (found.status !== 'pending') throw fail(400, `Cannot cancel a ${found.status} request`);
      const updated = await withWalletLock(found.userId, LOCK_TTL_RESOLVE, async () => {
        const p = await databases.getDocument(DB, PAYOUTS, found.$id);
        if (p.status !== 'pending') throw fail(409, 'Request was already resolved');
        await moveWallet(p.userId, { deltaHold: -Number(p.totalPaise) });
        const at = nowIso();
        const doc = await databases.updateDocument(DB, PAYOUTS, p.$id, {
          status: 'cancelled', rejectionReason: null, referenceNumber: null, processedAt: at, cancelledAt: at, processedBy: req.user.userId,
        });
        await bumpAccountStats(p.accountId, { cancelledCount: 1 });
        return doc;
      });
      await inc('totalCustomerPayoutPendingAmount', -Number(updated.amountPaise || 0));
      await inc('totalCustomerPayoutPendingCount', -1);
      await notify(updated.userId, { type: 'request_cancelled', userId: updated.userId, payoutId: updated.id, status: 'cancelled' });
      res.json({ success: true, message: 'Payout request cancelled', payout: await payoutView(updated, false) });
    } catch (e) { sendError(res, e, 'Failed to cancel payout request'); }
  });

  // Filters shared by the user list and the admin queue. `scopeQueries` = userId scope
  // ([] unrestricted, [query], or null = provably empty).
  //   status, mode, accountId, processedBy, from/to (IST days), minAmount/maxAmount (rupees),
  //   search + searchField (customerName | accountNumber | upiId | referenceNumber | id),
  //   bankingStatus (current tag of the beneficiary account), sort (createdAt | processedAt | amount), order (asc | desc)
  const PAYOUT_SORTS = { createdAt: 'createdAt', processedAt: 'processedAt', amount: 'amountPaise' };
  const PAYOUT_SEARCH_FIELDS = ['customerName', 'accountNumber', 'upiId', 'referenceNumber', 'id'];
  async function listPayouts(q, scopeQueries, staff = false) {
    const limit = parseLimit(q.limit);
    const empty = { success: true, total: 0, payouts: [], nextCursor: null };
    if (scopeQueries === null) return empty;
    const queries = [...scopeQueries];
    if (staff && q.paidVia) queries.push(Query.equal('paidVia', String(q.paidVia).trim()));
    if (q.status) {
      if (!['pending', 'paid', 'rejected', 'cancelled'].includes(q.status)) throw fail(400, 'Invalid status');
      queries.push(Query.equal('status', q.status));
    }
    if (q.mode) {
      const mode = String(q.mode).toUpperCase();
      if (!PAYOUT_MODES.includes(mode)) throw fail(400, 'Invalid mode');
      queries.push(Query.equal('mode', mode));
    }
    if (q.accountId) queries.push(Query.equal('accountId', String(q.accountId)));
    if (q.processedBy) queries.push(Query.equal('processedBy', String(q.processedBy)));
    const minP = rupeesFilter(q.minAmount, 'minAmount');
    const maxP = rupeesFilter(q.maxAmount, 'maxAmount');
    if (minP != null && maxP != null) {
      if (maxP < minP) throw fail(400, 'maxAmount must be >= minAmount');
      queries.push(Query.between('amountPaise', minP, maxP));
    } else if (minP != null) queries.push(Query.greaterThanEqual('amountPaise', minP));
    else if (maxP != null) queries.push(Query.lessThanEqual('amountPaise', maxP));
    const search = String(q.search || '').trim();
    if (search) {
      const field = q.searchField || (/^\d+$/.test(search) ? 'accountNumber' : 'customerName');
      if (!PAYOUT_SEARCH_FIELDS.includes(field)) throw fail(400, 'Invalid searchField');
      if (field === 'customerName') queries.push(Query.search('customerName', search));       // fulltext index
      else if (field === 'accountNumber') queries.push(Query.startsWith('accountNumber', search));
      else queries.push(Query.equal(field, search));
    }
    if (q.bankingStatus || q.verificationStatus) {
      if (q.bankingStatus && !BANKING_STATUSES.includes(q.bankingStatus)) throw fail(400, 'Invalid bankingStatus');
      if (q.verificationStatus && !VERIFICATION_STATUSES.includes(q.verificationStatus)) throw fail(400, 'Invalid verificationStatus');
      // Tags live on the account: resolve matching accounts (same userId scope), then filter by accountId.
      // ponytail: 500-account ceiling per filter call; add a status snapshot on the request if it matters
      const tagQ = [];
      if (q.bankingStatus) tagQ.push(Query.equal('bankingStatus', q.bankingStatus));
      if (q.verificationStatus) tagQ.push(q.verificationStatus === 'unverified' ? Query.or([Query.equal('verificationStatus', 'unverified'), Query.isNull('verificationStatus')]) : Query.equal('verificationStatus', q.verificationStatus));
      const ids = [];
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const aq = [...scopeQueries, ...tagQ, Query.orderAsc('$id'), Query.limit(100)];
        if (cursor) aq.push(Query.cursorAfter(cursor));
        const r = await databases.listDocuments(DB, ACCOUNTS, aq);
        for (const a of r.documents) ids.push(a.$id);
        if (r.documents.length < 100) break;
        cursor = r.documents[r.documents.length - 1].$id;
      }
      if (!ids.length) return empty;
      queries.push(idsQuery('accountId', ids));
    }
    const sortAttr = PAYOUT_SORTS[q.sort || 'createdAt'];
    if (!sortAttr) throw fail(400, 'Invalid sort');
    if (q.order && !['asc', 'desc'].includes(q.order)) throw fail(400, 'Invalid order');
    const orderQ = q.order === 'asc' ? Query.orderAsc(sortAttr) : Query.orderDesc(sortAttr);
    queries.push(...dateQueries(q.from, q.to), orderQ, ...cursorQuery(q.cursor), Query.limit(limit));
    const r = await databases.listDocuments(DB, PAYOUTS, queries);
    const payouts = (await attachBankingStatus(r.documents)).map((d) => pickPayout(d, staff));
    return { success: true, total: r.total, payouts, nextCursor: nextCursorOf(r.documents, limit) };
  }
  // Admin / labelled employee (not subadmin) may see staff-only fields such as paidVia.
  const isStaff = (req) => req.user.role !== 'subadmin' && req.user.role !== 'user';

  router.get('/requests', authenticateToken, async (req, res) => {
    try { res.json(await listPayouts(req.query, [Query.equal('userId', req.user.userId)])); }
    catch (e) { sendError(res, e, 'Failed to fetch customer payout requests'); }
  });

  // Deep link / search by unique id — own requests only
  router.get('/requests/:id', authenticateToken, async (req, res) => {
    try {
      const p = await loadPayoutByBusinessId(req.params.id);
      if (p.userId !== req.user.userId) throw fail(404, 'Customer payout request not found');
      res.json({ success: true, payout: await payoutView(p, false) });
    } catch (e) { sendError(res, e, 'Failed to fetch customer payout request'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN ROUTES — views: admin, labelled employee, or subadmin (scoped to their own users);
  //                actions: admin or labelled employee only.
  // ═══════════════════════════════════════════════════════════════════════════
  const adminView = authenticateAdminOrLabel('view_payouts', { isSubadminAllowed: true });
  const adminEdit = authenticateAdminOrLabel('edit_payouts');

  router.get('/admin/wallets', adminView, async (req, res) => {
    try {
      const scope = await userScope(req, { userId: req.query.userId, subadminId: req.query.subadminId });
      if (req.query.userId) {
        return res.json({ success: true, wallet: walletView(req.query.userId, await getWallet(req.query.userId)) });
      }
      const limit = parseLimit(req.query.limit);
      if (scope === null) return res.json({ success: true, total: 0, wallets: [], nextCursor: null });
      const r = await databases.listDocuments(DB, WALLETS, [...scope, Query.orderDesc('$createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit)]);
      res.json({ success: true, total: r.total, wallets: r.documents.map((w) => walletView(w.userId, w)), nextCursor: nextCursorOf(r.documents, limit) });
    } catch (e) { sendError(res, e, 'Failed to fetch payout wallets'); }
  });

  router.get('/admin/wallet/transactions', adminView, async (req, res) => {
    try {
      if (!req.query.userId) throw fail(400, 'userId is required');
      await userScope(req, { userId: req.query.userId }); // 403 for a subadmin asking about a foreign user
      res.json(await listWalletTxns(req.query.userId, req.query));
    } catch (e) { sendError(res, e, 'Failed to fetch payout wallet transactions'); }
  });

  // Manual credit/debit (admin role only). Body: { userId, direction:'credit'|'debit', amount (rupees),
  // notes (required), referenceNumber?, refId? (client idempotency key — resend the same refId to retry safely) }
  router.post('/admin/wallet/adjust', adminEdit, async (req, res) => {
    try {
      adminOnly(req);
      const { userId, direction, referenceNumber, refId } = req.body;
      if (!userId) throw fail(400, 'userId is required');
      if (!['credit', 'debit'].includes(direction)) throw fail(400, 'direction must be credit or debit');
      const amountPaise = toPaise(req.body.amount);
      if (amountPaise == null) throw fail(400, 'Invalid amount');
      const notes = String(req.body.notes || '').trim();
      if (notes.length < 3) throw fail(400, 'notes are required (min 3 characters)');
      if (refId && !/^[a-zA-Z0-9_-]{1,64}$/.test(refId)) throw fail(400, 'Invalid refId');
      if (!(await userMetaCache.getUserMeta(userId))) throw fail(404, 'User not found');
      const type = direction === 'credit' ? 'admin_credit' : 'admin_debit';
      const ref = refId || genId('adj_');

      const result = await withWalletLock(userId, LOCK_TTL_REQUEST, async () => {
        const existing = refId ? await findWalletTxn(type, ref) : null;
        if (existing) return { wallet: await getWallet(userId), txn: existing, duplicate: true };
        return moveWallet(userId, {
          deltaBalance: direction === 'credit' ? amountPaise : -amountPaise,
          txn: {
            userId, type, direction, amountPaise, commissionPaise: 0, totalPaise: amountPaise,
            refType: 'manual', refId: ref, referenceNumber: referenceNumber ? String(referenceNumber).trim().slice(0, 100) : null,
            notes: notes.slice(0, 500), createdBy: req.user.userId,
          },
        });
      });
      if (!result.duplicate) await notify(userId, { type: 'wallet_changed', userId, reason: type, wallet: walletView(userId, result.wallet) });
      res.json({ success: true, duplicate: !!result.duplicate, wallet: walletView(userId, result.wallet), transaction: pickWalletTxn(result.txn) });
    } catch (e) { sendError(res, e, 'Failed to adjust payout wallet'); }
  });

  // ─── settings: platform switch + per-user access (admin role only, not labels) ──
  const adminOnly = (req) => { if (req.user.role !== 'admin') throw fail(403, 'Admin only'); };

  router.get('/admin/settings', adminView, async (req, res) => {
    try { adminOnly(req); res.json({ success: true, ...settingsView() }); }
    catch (e) { sendError(res, e, 'Failed to fetch payout settings'); }
  });

  // Every field optional; only the ones sent are written. Amount-type fields in RUPEES (0 = off/unlimited).
  //   enabled, message                        → customer_payouts_enabled / customer_payouts_disabled_message
  //   realtimeEnabled                          → payout_realtime_enabled
  //   requireVerifiedAccount                   → payout_require_verified_account
  //   alertsEnabled, lowBalanceThreshold, pendingAlertMinutes → payout_alerts_enabled / payout_low_balance_threshold / payout_pending_alert_minutes
  //   maxPerRequest, dailyLimit, maxPending    → payout_max_per_request / payout_daily_limit / payout_max_pending
  router.patch('/admin/settings', adminEdit, async (req, res) => {
    try {
      adminOnly(req);
      const b = req.body || {};
      const bool = (k) => { if (b[k] === undefined) return null; if (typeof b[k] !== 'boolean') throw fail(400, `${k} must be true or false`); return b[k] ? 'true' : 'false'; };
      const nonNeg = (k) => { if (b[k] === undefined || b[k] === null) return null; const n = Number(b[k]); if (!isFinite(n) || n < 0) throw fail(400, `${k} must be a number >= 0`); return String(n); };
      const writes = {
        customer_payouts_enabled: bool('enabled'),
        customer_payouts_disabled_message: b.message !== undefined ? String(b.message || '').trim().slice(0, 200) : null,
        payout_realtime_enabled: bool('realtimeEnabled'),
        payout_require_verified_account: bool('requireVerifiedAccount'),
        payout_alerts_enabled: bool('alertsEnabled'),
        payout_low_balance_threshold: nonNeg('lowBalanceThreshold'),
        payout_pending_alert_minutes: nonNeg('pendingAlertMinutes'),
        payout_max_per_request: nonNeg('maxPerRequest'),
        payout_daily_limit: nonNeg('dailyLimit'),
        payout_max_pending: nonNeg('maxPending'),
      };
      const entries = Object.entries(writes).filter(([, v]) => v !== null);
      if (!entries.length) throw fail(400, 'No settings provided');
      for (const [key, val] of entries) await ConfigManager.set(key, val);
      res.json({ success: true, ...settingsView() });
    } catch (e) { sendError(res, e, 'Failed to update payout settings'); }
  });

  // Per-user limits (admin role only). Body: { maxPerRequest?, dailyLimit? (rupees), maxPending? }
  // null = inherit platform default, 0 = unlimited for this user.
  router.get('/admin/users/:userId/payout-limits', adminView, async (req, res) => {
    try {
      await assertCanAct(req, req.params.userId);
      const user = await userMetaCache.getUserMeta(req.params.userId);
      if (!user) throw fail(404, 'User not found');
      res.json({
        success: true, userId: req.params.userId,
        userValues: { maxPerRequestPaise: user.payoutMaxPerRequestPaise ?? null, dailyLimitPaise: user.payoutDailyLimitPaise ?? null, maxPending: user.payoutMaxPending ?? null },
        effective: limitsFor(user), platform: settingsView().limits, usage: await usageFor(req.params.userId),
      });
    } catch (e) { sendError(res, e, 'Failed to fetch payout limits'); }
  });
  router.patch('/admin/users/:userId/payout-limits', adminEdit, async (req, res) => {
    try {
      adminOnly(req);
      const doc = await findUserMetaDoc(req.params.userId);
      if (!doc) throw fail(404, 'User not found');
      const b = req.body || {};
      const patch = {};
      const rupees = (k, field) => { if (b[k] === undefined) return; if (b[k] === null) { patch[field] = null; return; } const n = Number(b[k]); if (!isFinite(n) || n < 0) throw fail(400, `${k} must be a number >= 0 or null`); patch[field] = Math.round(n * 100); };
      rupees('maxPerRequest', 'payoutMaxPerRequestPaise');
      rupees('dailyLimit', 'payoutDailyLimitPaise');
      if (b.maxPending !== undefined) { if (b.maxPending === null) patch.payoutMaxPending = null; else { const n = parseInt(b.maxPending, 10); if (!isFinite(n) || n < 0) throw fail(400, 'maxPending must be an integer >= 0 or null'); patch.payoutMaxPending = n; } }
      if (!Object.keys(patch).length) throw fail(400, 'No limits provided');
      await databases.updateDocument(DB, USERS_META, doc.$id, patch);
      await userMetaCache.invalidate(req.params.userId);
      const user = { ...doc, ...patch };
      res.json({ success: true, userId: req.params.userId, userValues: { maxPerRequestPaise: user.payoutMaxPerRequestPaise ?? null, dailyLimitPaise: user.payoutDailyLimitPaise ?? null, maxPending: user.payoutMaxPending ?? null }, effective: limitsFor(user) });
    } catch (e) { sendError(res, e, 'Failed to update payout limits'); }
  });

  // ─── "paid via" source accounts — staff quick-pick list (admin / labelled employee) ──
  const staffOnly = (req) => { if (!isStaff(req)) throw fail(403, 'Not authorized'); };
  router.get('/admin/source-accounts', adminView, async (req, res) => {
    try {
      staffOnly(req);
      const limit = parseLimit(req.query.limit);
      const queries = [];
      const s = String(req.query.search || '').trim().toLowerCase();
      if (s) queries.push(Query.startsWith('labelKey', s));
      if (!parseBool(req.query.includeInactive, false)) queries.push(Query.equal('active', true));
      const sort = { useCount: 'useCount', lastUsedAt: 'lastUsedAt', label: 'labelKey', totalPaid: 'totalPaidPaise' }[req.query.sort || 'useCount'];
      if (!sort) throw fail(400, 'Invalid sort');
      queries.push(sort === 'labelKey' ? Query.orderAsc(sort) : Query.orderDesc(sort), ...cursorQuery(req.query.cursor), Query.limit(limit));
      const r = await databases.listDocuments(DB, SOURCE_ACCOUNTS, queries);
      res.json({ success: true, total: r.total, sourceAccounts: r.documents.map(pickSource), nextCursor: nextCursorOf(r.documents, limit) });
    } catch (e) { sendError(res, e, 'Failed to fetch source accounts'); }
  });
  router.post('/admin/source-accounts', adminEdit, async (req, res) => {
    try {
      const label = String(req.body.label || '').trim().slice(0, 100);
      if (label.length < 2) throw fail(400, 'label is required (2–100 characters)');
      const existing = await findSource(label);
      const doc = existing ? (existing.active === false ? await databases.updateDocument(DB, SOURCE_ACCOUNTS, existing.$id, { active: true }) : existing) : await upsertSource(label, req.user.userId);
      res.status(existing ? 200 : 201).json({ success: true, created: !existing, sourceAccount: pickSource(doc) });
    } catch (e) { sendError(res, e, 'Failed to add source account'); }
  });
  router.delete('/admin/source-accounts/:id', adminEdit, async (req, res) => { // deactivate (history keeps the label text)
    try {
      adminOnly(req);
      const doc = await databases.getDocument(DB, SOURCE_ACCOUNTS, req.params.id).catch(() => null);
      if (!doc) throw fail(404, 'Source account not found');
      await databases.updateDocument(DB, SOURCE_ACCOUNTS, doc.$id, { active: false });
      res.json({ success: true, message: 'Source account deactivated' });
    } catch (e) { sendError(res, e, 'Failed to deactivate source account'); }
  });

  // ─── wallet statement export (admin role only) — CSV, from/to IST days ──
  router.get('/admin/wallet/export', adminView, async (req, res) => {
    try {
      adminOnly(req);
      const { userId, from, to } = req.query;
      if (!userId) throw fail(400, 'userId is required');
      if (!from || !to) throw fail(400, 'from and to are required (YYYY-MM-DD)');
      const base = [Query.equal('userId', String(userId)), ...dateQueries(from, to), Query.orderAsc('createdAt'), Query.limit(100)];
      const rows = [];
      let cursor = null, truncated = false;
      for (let page = 0; page < 50; page++) { // ponytail: 5,000-row ceiling per export
        const r = await databases.listDocuments(DB, WALLET_TXNS, cursor ? [...base, Query.cursorAfter(cursor)] : base);
        rows.push(...r.documents);
        if (r.documents.length < 100) break;
        cursor = r.documents[r.documents.length - 1].$id;
        if (page === 49) truncated = true;
      }
      const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const header = ['createdAt', 'id', 'type', 'direction', 'amountRs', 'commissionRs', 'totalRs', 'balanceAfterRs', 'holdAfterRs', 'refType', 'refId', 'referenceNumber', 'notes', 'createdBy'];
      const lines = [header.join(',')];
      for (const d of rows) {
        lines.push([d.createdAt, d.id, d.type, d.direction, Number(d.amountPaise || 0) / 100, Number(d.commissionPaise || 0) / 100, Number(d.totalPaise || 0) / 100,
          d.balanceAfterPaise == null ? '' : Number(d.balanceAfterPaise) / 100, d.holdAfterPaise == null ? '' : Number(d.holdAfterPaise) / 100,
          d.refType, d.refId, d.referenceNumber, d.notes, d.createdBy].map(esc).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="payout-wallet-${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}-${from}-${to}.csv"`);
      res.setHeader('X-Row-Count', String(rows.length));
      if (truncated) res.setHeader('X-Truncated', 'true');
      res.send(`﻿${lines.join('\r\n')}\r\n`);
    } catch (e) { sendError(res, e, 'Failed to export wallet statement'); }
  });

  // ─── daily time series for the admin dashboard (scoped like the queue) ──
  // GET /admin/stats/daily?from&to&userId&subadminId  → per IST day: requested, paid, rejected, cancelled
  router.get('/admin/stats/daily', adminView, async (req, res) => {
    try {
      const from = req.query.from || istDay(), to = req.query.to || from;
      if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw fail(400, 'Dates must be YYYY-MM-DD');
      const start = moment.tz(from, 'Asia/Kolkata'), end = moment.tz(to, 'Asia/Kolkata');
      if (!start.isValid() || !end.isValid() || end.isBefore(start)) throw fail(400, 'Invalid date range');
      if (end.diff(start, 'days') > 366) throw fail(400, 'Range too large (max 366 days)');
      const scope = await userScope(req, { userId: req.query.userId, subadminId: req.query.subadminId });
      const days = [];
      for (let d = start.clone(); !d.isAfter(end); d.add(1, 'day')) {
        days.push({ date: d.format('YYYY-MM-DD'), requestedCount: 0, requestedAmountPaise: 0, paidCount: 0, paidAmountPaise: 0, paidCommissionPaise: 0, paidMinutesTotal: 0, rejectedCount: 0, cancelledCount: 0 });
      }
      const idx = new Map(days.map((x, i) => [x.date, i]));
      let truncated = false;
      const scan = async (attr, onDoc) => {
        if (scope === null) return;
        const bounds = dateQueries(from, to).map((q) => q.replace('"createdAt"', `"${attr}"`)); // same IST bounds on another attribute
        const base = [...scope, ...bounds, Query.orderAsc('$id'), Query.limit(100)];
        let cursor = null;
        for (let page = 0; page < 100; page++) { // ponytail: 10k rows per scan per call
          const r = await databases.listDocuments(DB, PAYOUTS, cursor ? [...base, Query.cursorAfter(cursor)] : base);
          for (const p of r.documents) onDoc(p);
          if (r.documents.length < 100) break;
          cursor = r.documents[r.documents.length - 1].$id;
          if (page === 99) truncated = true;
        }
      };
      const bucket = (ts) => { const i = idx.get(istDay(ts)); return i === undefined ? null : days[i]; };
      await scan('createdAt', (p) => { const b = bucket(p.createdAt); if (b) { b.requestedCount++; b.requestedAmountPaise += Number(p.amountPaise || 0); } });
      await scan('processedAt', (p) => {
        const b = bucket(p.processedAt); if (!b) return;
        if (p.status === 'paid') { b.paidCount++; b.paidAmountPaise += Number(p.amountPaise || 0); b.paidCommissionPaise += Number(p.commissionPaise || 0); b.paidMinutesTotal += minutesBetween(p.createdAt, p.paidAt || p.processedAt) || 0; }
        else if (p.status === 'rejected') b.rejectedCount++;
        else if (p.status === 'cancelled') b.cancelledCount++;
      });
      const out = days.map(({ paidMinutesTotal, ...d }) => ({ ...d, avgPaidInMinutes: d.paidCount ? Math.round(paidMinutesTotal / d.paidCount) : null }));
      const totals = out.reduce((t, d) => ({ requestedCount: t.requestedCount + d.requestedCount, requestedAmountPaise: t.requestedAmountPaise + d.requestedAmountPaise, paidCount: t.paidCount + d.paidCount, paidAmountPaise: t.paidAmountPaise + d.paidAmountPaise, paidCommissionPaise: t.paidCommissionPaise + d.paidCommissionPaise, rejectedCount: t.rejectedCount + d.rejectedCount, cancelledCount: t.cancelledCount + d.cancelledCount }), { requestedCount: 0, requestedAmountPaise: 0, paidCount: 0, paidAmountPaise: 0, paidCommissionPaise: 0, rejectedCount: 0, cancelledCount: 0 });
      res.json({ success: true, range: { from, to }, days: out, totals, truncated });
    } catch (e) { sendError(res, e, 'Failed to fetch payout daily stats'); }
  });

  // ─── alerts (on demand; admin toggles thresholds in settings) ──
  // GET /admin/alerts → low-balance wallets + stale pending requests, scoped like the queue
  router.get('/admin/alerts', adminView, async (req, res) => {
    try {
      const s = settingsView().alerts;
      const scope = await userScope(req, { userId: req.query.userId, subadminId: req.query.subadminId });
      const lowBalance = [], stalePending = [];
      if (s.enabled && scope !== null) {
        if (s.lowBalanceThresholdPaise) {
          const base = [...scope, Query.orderAsc('$id'), Query.limit(100)];
          let cursor = null;
          for (let page = 0; page < 5; page++) { // ponytail: 500 wallets per call
            const r = await databases.listDocuments(DB, WALLETS, cursor ? [...base, Query.cursorAfter(cursor)] : base);
            for (const w of r.documents) { const v = walletView(w.userId, w); if (v.availablePaise < s.lowBalanceThresholdPaise) lowBalance.push({ userId: w.userId, availablePaise: v.availablePaise, balancePaise: v.balancePaise, holdPaise: v.holdPaise }); }
            if (r.documents.length < 100) break;
            cursor = r.documents[r.documents.length - 1].$id;
          }
        }
        if (s.pendingAlertMinutes) {
          const cutoff = new Date(Date.now() - s.pendingAlertMinutes * 60000).toISOString();
          const r = await databases.listDocuments(DB, PAYOUTS, [...scope, Query.equal('status', 'pending'), Query.lessThanEqual('createdAt', cutoff), Query.orderAsc('createdAt'), Query.limit(100)]);
          for (const p of r.documents) stalePending.push({ payoutId: p.id, userId: p.userId, amountPaise: Number(p.amountPaise || 0), customerName: p.customerName, requestedAt: p.createdAt, waitingMinutes: minutesBetween(p.createdAt, nowIso()) });
        }
      }
      res.json({ success: true, enabled: s.enabled, thresholds: { lowBalancePaise: s.lowBalanceThresholdPaise, pendingMinutes: s.pendingAlertMinutes }, lowBalance, stalePending, counts: { lowBalance: lowBalance.length, stalePending: stalePending.length } });
    } catch (e) { sendError(res, e, 'Failed to fetch payout alerts'); }
  });

  // ─── beneficiary verification (staff) ──
  // Body: { status: unverified|verified|name_mismatch|failed, verifiedName?, note? }
  router.patch('/admin/accounts/:accountId/verification', adminEdit, async (req, res) => {
    try {
      const { status } = req.body;
      if (!VERIFICATION_STATUSES.includes(status)) throw fail(400, 'status must be unverified, verified, name_mismatch or failed');
      const account = await databases.getDocument(DB, ACCOUNTS, req.params.accountId).catch(() => null);
      if (!account) throw fail(404, 'Customer payout account not found');
      await assertCanAct(req, account.userId);
      const updated = await databases.updateDocument(DB, ACCOUNTS, account.$id, {
        verificationStatus: status,
        verifiedName: req.body.verifiedName ? String(req.body.verifiedName).trim().slice(0, 100) : null,
        verificationNote: req.body.note ? String(req.body.note).trim().slice(0, 300) : null,
        verifiedAt: status === 'unverified' ? null : nowIso(), verifiedBy: status === 'unverified' ? null : req.user.userId,
      });
      await notify(account.userId, { type: 'account_verification', userId: account.userId, accountId: account.$id, verificationStatus: status }, { toAdmins: false });
      res.json({ success: true, account: pickAccount(updated) });
    } catch (e) { sendError(res, e, 'Failed to update verification'); }
  });

  // ─── ledger integrity check (admin role only) — READ-ONLY report, never modifies or restricts ──
  async function pageAll(col, queries, cap = 5000) {
    const docs = []; let cursor = null;
    for (let page = 0; page < cap / 100; page++) {
      const r = await databases.listDocuments(DB, col, cursor ? [...queries, Query.limit(100), Query.cursorAfter(cursor)] : [...queries, Query.limit(100)]);
      docs.push(...r.documents);
      if (r.documents.length < 100) return { docs, truncated: false };
      cursor = r.documents[r.documents.length - 1].$id;
    }
    return { docs, truncated: true };
  }
  async function checkWallet(userId) {
    const issues = [];
    const add = (severity, code, message, data = {}) => issues.push({ severity, code, message, ...data });
    const wallet = await getWallet(userId);
    const [rowsR, payoutsR, wdR, accountsR] = await Promise.all([
      pageAll(WALLET_TXNS, [Query.equal('userId', userId), Query.orderAsc('createdAt'), Query.orderAsc('$id')]), // $id tiebreak: two rows in one ms must not read as a chain break
      pageAll(PAYOUTS, [Query.equal('userId', userId), Query.orderAsc('createdAt')]),
      pageAll(WITHDRAWALS, [Query.equal('userId', userId), Query.equal('mode', 'wallet'), Query.orderAsc('$createdAt')]),
      pageAll(ACCOUNTS, [Query.equal('userId', userId), Query.orderAsc('$id')]),
    ]);
    const rows = rowsR.docs, payouts = payoutsR.docs, withdrawals = wdR.docs, accounts = accountsR.docs;
    const truncated = rowsR.truncated || payoutsR.truncated || wdR.truncated || accountsR.truncated;

    // 1. ledger arithmetic: balance = credits − debits; running balanceAfter chain; duplicate (type, refId)
    let credits = 0, debits = 0, running = 0, chainBreaks = 0;
    const byType = {}, seen = new Set(), rowsByKey = new Map();
    for (const r of rows) {
      const total = Number(r.totalPaise || 0);
      if (!['credit', 'debit'].includes(r.direction)) add('error', 'LEDGER_BAD_DIRECTION', `Ledger row ${r.id} has direction "${r.direction}"`, { rowId: r.id });
      if (!(total >= 0)) add('error', 'LEDGER_BAD_AMOUNT', `Ledger row ${r.id} has invalid totalPaise ${r.totalPaise}`, { rowId: r.id });
      if (r.direction === 'credit') credits += total; else debits += total;
      byType[r.type] = (byType[r.type] || 0) + Number(r.amountPaise || 0);
      const key = `${r.type}:${r.refId}`;
      if (r.refId) { if (seen.has(key)) add('error', 'LEDGER_DUPLICATE_REF', `Duplicate ledger row for ${key} (double credit/debit?)`, { rowId: r.id, key }); seen.add(key); rowsByKey.set(key, r); }
      running += r.direction === 'credit' ? total : -total;
      if (r.balanceAfterPaise != null && Number(r.balanceAfterPaise) !== running) {
        if (chainBreaks++ < 5) add('error', 'LEDGER_CHAIN_BREAK', `Row ${r.id}: balanceAfter ${r.balanceAfterPaise} but running sum is ${running}`, { rowId: r.id, expected: running, actual: Number(r.balanceAfterPaise) });
        running = Number(r.balanceAfterPaise); // resync so one break is reported once, not for every later row
      }
    }
    if (chainBreaks > 5) add('error', 'LEDGER_CHAIN_BREAK', `${chainBreaks - 5} more balanceAfter chain breaks not listed`);
    const expectedBalance = credits - debits;
    const balance = Number(wallet?.balancePaise || 0), hold = Number(wallet?.holdPaise || 0);
    if (balance !== expectedBalance) add('error', 'BALANCE_MISMATCH', `Wallet balance ${balance} ≠ ledger credits − debits ${expectedBalance} (drift ${balance - expectedBalance})`, { walletPaise: balance, ledgerPaise: expectedBalance, driftPaise: balance - expectedBalance });

    // 2. hold = Σ pending totalPaise; available ≥ 0
    const pending = payouts.filter((p) => p.status === 'pending');
    const expectedHold = pending.reduce((s, p) => s + Number(p.totalPaise || 0), 0);
    if (hold !== expectedHold) add('error', 'HOLD_MISMATCH', `Wallet hold ${hold} ≠ Σ pending requests ${expectedHold} (${pending.length} pending)`, { walletPaise: hold, expectedPaise: expectedHold, driftPaise: hold - expectedHold });
    if (balance - hold < 0) add('error', 'NEGATIVE_AVAILABLE', `Available is negative (${balance - hold})`, { availablePaise: balance - hold });

    // 3. lifetime totals on the wallet doc vs ledger
    const lt = { totalCreditedPaise: (byType.withdrawal_credit || 0) + (byType.admin_credit || 0), totalPaidOutPaise: byType.payout_paid || 0, totalAdminDebitPaise: byType.admin_debit || 0, totalRevertedToQrPaise: byType.revert_to_qr || 0,
      totalPayoutCommissionPaise: rows.filter((r) => r.type === 'payout_paid').reduce((s, r) => s + Number(r.commissionPaise || 0), 0), paidCount: rows.filter((r) => r.type === 'payout_paid').length };
    for (const [k, v] of Object.entries(lt)) if (wallet && Number(wallet[k] || 0) !== v) add('warning', 'LIFETIME_MISMATCH', `Wallet ${k} ${Number(wallet[k] || 0)} ≠ ledger ${v}`, { field: k, walletValue: Number(wallet[k] || 0), ledgerValue: v });

    // 4. wallet withdrawals ↔ credit rows; reverts ↔ walletRevertedPaise
    for (const w of withdrawals) {
      if (w.status !== 'approved') continue;
      const credited = Math.round(Number(w.preAmount) * 100);
      const row = rowsByKey.get(`withdrawal_credit:${w.id}`);
      if (!row) add(w.walletCreditFailed ? 'warning' : 'error', 'WITHDRAWAL_NOT_CREDITED', `Approved wallet withdrawal ${w.id} (${credited} paise) has no wallet credit row${w.walletCreditFailed ? ' (flagged walletCreditFailed — use retry-credit)' : ''}`, { withdrawalId: w.id, amountPaise: credited });
      else if (Number(row.amountPaise) !== credited) add('error', 'WITHDRAWAL_CREDIT_AMOUNT', `Withdrawal ${w.id}: credited ${row.amountPaise} but preAmount is ${credited}`, { withdrawalId: w.id });
      const reverted = rows.filter((r) => r.type === 'revert_to_qr' && r.referenceNumber === w.id).reduce((s, r) => s + Number(r.amountPaise || 0), 0);
      if (Number(w.walletRevertedPaise || 0) !== reverted) add('warning', 'REVERT_TRACKING', `Withdrawal ${w.id}: walletRevertedPaise ${Number(w.walletRevertedPaise || 0)} ≠ Σ revert rows ${reverted}`, { withdrawalId: w.id });
      if (reverted > credited) add('error', 'REVERT_EXCEEDS_CREDIT', `Withdrawal ${w.id}: reverted ${reverted} > credited ${credited}`, { withdrawalId: w.id });
    }
    for (const r of rows) if (r.type === 'withdrawal_credit' && !withdrawals.some((w) => w.id === r.refId)) add('error', 'ORPHAN_CREDIT', `Credit row ${r.id} references unknown wallet withdrawal ${r.refId}`, { rowId: r.id });

    // 5. paid payouts ↔ payout_paid rows (exactly one each way, same total)
    const paidById = new Map(payouts.filter((p) => p.status === 'paid').map((p) => [p.id, p]));
    for (const p of paidById.values()) {
      const row = rowsByKey.get(`payout_paid:${p.id}`);
      if (!row) add('error', 'PAID_NOT_DEBITED', `Paid request ${p.id} (${p.totalPaise} paise) has no wallet debit row`, { payoutId: p.id });
      else if (Number(row.totalPaise) !== Number(p.totalPaise)) add('error', 'PAID_AMOUNT_MISMATCH', `Request ${p.id}: debited ${row.totalPaise} but request total is ${p.totalPaise}`, { payoutId: p.id });
    }
    for (const r of rows) {
      if (r.type !== 'payout_paid') continue;
      const p = payouts.find((x) => x.id === r.refId);
      if (!p) add('error', 'ORPHAN_DEBIT', `Debit row ${r.id} references unknown request ${r.refId}`, { rowId: r.id });
      else if (p.status !== 'paid') add('error', 'DEBIT_ON_UNPAID', `Request ${p.id} is ${p.status} but has a payout_paid debit row`, { payoutId: p.id });
    }

    // 6. commission txns per paid request (ceil split may exceed the request's commission by ≤1 paise per share)
    const paidIds = [...paidById.keys()];
    if (paidIds.length) {
      const sums = {};
      for (let i = 0; i < paidIds.length; i += 100) {
        const r = await pageAll(COMMISSION_TXNS, [Query.equal('sourcePayoutId', paidIds.slice(i, i + 100))], 2000);
        for (const c of r.docs) sums[c.sourcePayoutId] = (sums[c.sourcePayoutId] || 0) + Number(c.amount || 0);
      }
      for (const p of paidById.values()) {
        const expected = Number(p.commissionPaise || 0), got = sums[p.id] || 0;
        if (expected > 0 && (got < expected || got > expected + 2)) add('warning', 'COMMISSION_MISMATCH', `Request ${p.id}: commission txns total ${got} vs request commission ${expected}`, { payoutId: p.id, expectedPaise: expected, recordedPaise: got });
      }
    }

    // 7. account stats vs requests
    const perAcc = {};
    for (const p of payouts) {
      const a = perAcc[p.accountId] = perAcc[p.accountId] || { requestCount: 0, paidCount: 0, rejectedCount: 0, cancelledCount: 0, totalPaidPaise: 0 };
      a.requestCount++;
      if (p.status === 'paid') { a.paidCount++; a.totalPaidPaise += Number(p.amountPaise || 0); }
      else if (p.status === 'rejected') a.rejectedCount++;
      else if (p.status === 'cancelled') a.cancelledCount++;
    }
    for (const acc of accounts) {
      const exp = perAcc[acc.$id] || { requestCount: 0, paidCount: 0, rejectedCount: 0, cancelledCount: 0, totalPaidPaise: 0 };
      for (const k of Object.keys(exp)) if (Number(acc[k] || 0) !== exp[k]) add('warning', 'ACCOUNT_STATS_MISMATCH', `Account ${acc.$id} (${acc.customerName}): ${k} ${Number(acc[k] || 0)} ≠ ${exp[k]} (fix: recompute-stats)`, { accountId: acc.$id, field: k });
    }

    const errors = issues.filter((i) => i.severity === 'error').length, warnings = issues.filter((i) => i.severity === 'warning').length;
    return {
      userId, checkedAt: nowIso(), ok: errors === 0, errors, warnings, truncated,
      wallet: walletView(userId, wallet),
      ledger: { rows: rows.length, creditsPaise: credits, debitsPaise: debits, expectedBalancePaise: expectedBalance, expectedHoldPaise: expectedHold, byTypePaise: byType },
      counts: { payouts: payouts.length, pending: pending.length, paid: paidById.size, walletWithdrawals: withdrawals.length, accounts: accounts.length },
      issues,
    };
  }
  router.get('/admin/integrity/wallet/:userId', adminView, async (req, res) => {
    try { adminOnly(req); res.json({ success: true, report: await checkWallet(req.params.userId) }); }
    catch (e) { sendError(res, e, 'Failed to run integrity check'); }
  });
  // Page through wallets (≤ 25 per call — each is a full check) → summaries; drill into one with the route above.
  router.get('/admin/integrity/wallets', adminView, async (req, res) => {
    try {
      adminOnly(req);
      const limit = parseLimit(req.query.limit ?? 10, 25);
      const r = await databases.listDocuments(DB, WALLETS, [Query.orderAsc('$id'), ...cursorQuery(req.query.cursor), Query.limit(limit)]);
      const reports = [];
      for (const w of r.documents) {
        const rep = await checkWallet(w.userId);
        reports.push({ userId: rep.userId, ok: rep.ok, errors: rep.errors, warnings: rep.warnings, truncated: rep.truncated, balancePaise: rep.wallet.balancePaise, holdPaise: rep.wallet.holdPaise, driftPaise: rep.wallet.balancePaise - rep.ledger.expectedBalancePaise, issueCodes: [...new Set(rep.issues.map((i) => i.code))] });
      }
      res.json({ success: true, checkedAt: nowIso(), reports, summary: { wallets: reports.length, withErrors: reports.filter((x) => !x.ok).length, withWarnings: reports.filter((x) => x.ok && x.warnings).length }, nextCursor: nextCursorOf(r.documents, limit) });
    } catch (e) { sendError(res, e, 'Failed to run integrity check'); }
  });

  // Body: { enabled: boolean, reason?: string ≤200 } — sets users_meta.payoutDisabled (+reason), invalidates the meta cache
  router.patch('/admin/users/:userId/payout-access', adminEdit, async (req, res) => {
    try {
      adminOnly(req);
      if (typeof req.body.enabled !== 'boolean') throw fail(400, 'enabled must be true or false');
      const doc = await findUserMetaDoc(req.params.userId);
      if (!doc) throw fail(404, 'User not found');
      if (doc.role === 'admin') throw fail(400, 'Admins have no customer payouts');
      const reason = req.body.enabled ? null : (String(req.body.reason || '').trim().slice(0, 200) || null);
      await databases.updateDocument(DB, USERS_META, doc.$id, { payoutDisabled: !req.body.enabled, payoutDisabledReason: reason });
      await userMetaCache.invalidate(req.params.userId);
      res.json({ success: true, userId: req.params.userId, payoutDisabled: !req.body.enabled, payoutDisabledReason: reason });
    } catch (e) { sendError(res, e, 'Failed to update user payout access'); }
  });

  // What can be reverted from this wallet? The user's approved mode:'wallet' withdrawals with
  // credited / reverted / revertable paise, plus the wallet (available caps any single revert).
  // GET /admin/wallet/revertable?userId&onlyRevertable=true&limit&cursor   (admin role only)
  router.get('/admin/wallet/revertable', adminView, async (req, res) => {
    try {
      adminOnly(req);
      const userId = String(req.query.userId || '');
      if (!userId) throw fail(400, 'userId is required');
      const limit = parseLimit(req.query.limit);
      const onlyRevertable = parseBool(req.query.onlyRevertable, true);
      const queries = [Query.equal('userId', userId), Query.equal('mode', 'wallet'), Query.equal('status', 'approved'), Query.orderDesc('$createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit)];
      const r = await databases.listDocuments(DB, WITHDRAWALS, queries);
      const wallet = walletView(userId, await getWallet(userId));
      const rows = r.documents.map((w) => {
        const creditedPaise = Math.round(Number(w.preAmount || 0) * 100);
        const revertedPaise = Number(w.walletRevertedPaise || 0);
        const revertablePaise = Math.max(0, creditedPaise - revertedPaise);
        return {
          withdrawalId: w.id, qrId: w.qrId, approvedAt: w.processedAt || null, requestedAt: w.createdAt || null,
          creditedPaise, revertedPaise, revertablePaise, creditedRs: creditedPaise / 100, revertablePaise_capped: Math.min(revertablePaise, Math.max(0, wallet.availablePaise)),
          walletCreditFailed: w.walletCreditFailed === true,
        };
      }).filter((x) => !onlyRevertable || x.revertablePaise > 0);
      res.json({
        success: true, userId, wallet,
        withdrawals: rows,
        pageTotalRevertablePaise: rows.reduce((s, x) => s + x.revertablePaise, 0),
        maxSingleRevertPaise: Math.max(0, wallet.availablePaise), // money held by pending payouts cannot be reverted
        nextCursor: nextCursorOf(r.documents, limit),
      });
    } catch (e) { sendError(res, e, 'Failed to fetch revertable withdrawals'); }
  });

  // ─── revert payout-wallet money back to the QR it was withdrawn from (admin role only) ──
  // Body: { withdrawalId (mode:'wallet', approved), amount? (rupees; default = everything not yet
  //         reverted from this withdrawal), notes (REQUIRED), refId? (client idempotency key) }
  // Money path (all paise), lock order lock:qr → lock:payoutwallet (same as approve):
  //   1. re-read withdrawal under lock; remaining = preAmount − walletRevertedPaise; amount ≤ remaining
  //   2. wallet debit (moveWallet, 409 if available < amount) + ledger row type 'revert_to_qr'
  //   3. QR: withdrawalApprovedAmount −= amount, available recomputed (guard ≥ 0) — on failure the
  //      wallet debit is compensated (ledger row deleted, balance restored)
  //   4. withdrawal.walletRevertedPaise += amount; counters totalPayoutWalletFunded / totalAmountPaid −= amount
  router.post('/admin/wallet/revert-to-qr', adminEdit, async (req, res) => {
    try {
      adminOnly(req);
      const { withdrawalId, refId } = req.body;
      if (!withdrawalId) throw fail(400, 'withdrawalId is required');
      const notes = String(req.body.notes || '').trim();
      if (notes.length < 3) throw fail(400, 'notes are required (min 3 characters)');
      if (refId && !/^[a-zA-Z0-9_-]{1,64}$/.test(refId)) throw fail(400, 'Invalid refId');
      const requested = req.body.amount == null || req.body.amount === '' ? null : toPaise(req.body.amount);
      if (req.body.amount != null && req.body.amount !== '' && requested == null) throw fail(400, 'Invalid amount');

      const found = (await databases.listDocuments(DB, WITHDRAWALS, [Query.equal('id', String(withdrawalId)), Query.limit(1)])).documents[0];
      if (!found) throw fail(404, 'Withdrawal request not found');
      if (found.mode !== 'wallet') throw fail(400, 'Withdrawal is not a payout-wallet withdrawal');
      if (found.status !== 'approved') throw fail(400, `Cannot revert a ${found.status} withdrawal`);
      if (!found.qrId || !found.userId) throw fail(400, 'Invalid withdrawal document data');
      const ref = refId || genId('rvt_');

      const result = await withLock(`lock:qr:${found.qrId}`, LOCK_TTL_QR, async () => withWalletLock(found.userId, LOCK_TTL_RESOLVE, async () => {
        const existing = refId ? await findWalletTxn('revert_to_qr', ref) : null;
        if (existing) return { duplicate: true, txn: existing, wallet: await getWallet(found.userId) };

        // 1. fresh withdrawal under lock — bound the revert by what this withdrawal actually credited
        const w = await databases.getDocument(DB, WITHDRAWALS, found.$id);
        if (w.status !== 'approved') throw fail(409, 'Withdrawal is no longer approved');
        if (!(await findWalletTxn('withdrawal_credit', w.id))) throw fail(409, 'This withdrawal was never credited to the payout wallet');
        const creditedPaise = Math.round(Number(w.preAmount) * 100);
        const revertedSoFar = Number(w.walletRevertedPaise || 0);
        const remaining = creditedPaise - revertedSoFar;
        if (remaining <= 0) throw fail(409, 'Nothing left to revert on this withdrawal');
        const amountPaise = requested ?? remaining;
        if (amountPaise > remaining) throw fail(409, `Amount exceeds the revertable balance of this withdrawal (${remaining} paise)`);

        // 2. QR fresh read + new ledger values (computed before any write so both guards run first)
        const qr = (await databases.listDocuments(DB, QRCODES, [Query.equal('qrId', w.qrId), Query.limit(1)])).documents[0];
        if (!qr) throw fail(404, 'QR not found for withdrawal');
        const total = Number(qr.totalPayInAmount || 0), approved = Number(qr.withdrawalApprovedAmount || 0);
        const requestedW = Number(qr.withdrawalRequestedAmount || 0), onHold = Number(qr.amountOnHold || 0);
        const commissionOnHold = Number(qr.commissionOnHold || 0), commissionPaid = Number(qr.commissionPaid || 0);
        const newApproved = approved - amountPaise;
        const newAvailable = total - newApproved - requestedW - onHold - commissionOnHold - commissionPaid;
        if (newApproved < 0) throw fail(409, 'Ledger computation error: QR approved-withdrawal total would go negative');

        // 3. wallet debit (409 if available < amount; hold is respected)
        const moved = await moveWallet(w.userId, {
          deltaBalance: -amountPaise,
          txn: {
            userId: w.userId, type: 'revert_to_qr', direction: 'debit', amountPaise, commissionPaise: 0, totalPaise: amountPaise,
            refType: 'withdrawal_revert', refId: ref, referenceNumber: w.id,
            notes: `Reverted to QR ${w.qrId} (withdrawal ${w.id}): ${notes}`.slice(0, 500), createdBy: req.user.userId,
          },
        });

        // 4. QR credit-back; compensate the wallet if it fails
        try {
          await databases.updateDocument(DB, QRCODES, qr.$id, { withdrawalApprovedAmount: newApproved, amountAvailableForWithdrawal: newAvailable });
        } catch (qrErr) {
          try {
            await databases.deleteDocument(DB, WALLET_TXNS, moved.txn.$id);
            await databases.updateDocument(DB, WALLETS, moved.wallet.$id, { balancePaise: Number(moved.wallet.balancePaise) + amountPaise, totalRevertedToQrPaise: Number(moved.wallet.totalRevertedToQrPaise || 0) - amountPaise, updatedAt: nowIso() });
            await inc('totalPayoutWalletBalance', amountPaise);
          } catch (compErr) {
            console.error(`CRITICAL: revert-to-qr QR update failed AND wallet compensation failed. user=${w.userId} withdrawal=${w.id} amount=${amountPaise} txn=${moved.txn.$id}`, compErr);
          }
          throw qrErr;
        }

        // 5. bound tracking + counters (never fail the response; ledgers are already consistent)
        await databases.updateDocument(DB, WITHDRAWALS, w.$id, { walletRevertedPaise: revertedSoFar + amountPaise })
          .catch((e) => console.error(`CRITICAL: revert-to-qr could not record walletRevertedPaise on ${w.id} (+${amountPaise})`, e));
        await inc('totalPayoutWalletFunded', -amountPaise);
        await inc('totalAmountPaid', -amountPaise);
        return { duplicate: false, txn: moved.txn, wallet: moved.wallet, amountPaise, remainingPaise: remaining - amountPaise, qrId: w.qrId, newQrAvailablePaise: newAvailable };
      }), 'QR is currently being processed. Please try again in a moment.');

      if (!result.duplicate) await notify(found.userId, { type: 'wallet_changed', userId: found.userId, reason: 'revert_to_qr', qrId: found.qrId, amountPaise: result.amountPaise, wallet: walletView(found.userId, result.wallet) });
      res.json({
        success: true, duplicate: !!result.duplicate, withdrawalId: found.id, qrId: found.qrId, userId: found.userId,
        amountPaise: result.amountPaise ?? Number(result.txn.amountPaise), remainingPaise: result.remainingPaise ?? null,
        qrAvailablePaise: result.newQrAvailablePaise ?? null,
        wallet: walletView(found.userId, result.wallet), transaction: pickWalletTxn(result.txn),
      });
    } catch (e) { sendError(res, e, 'Failed to revert payout wallet amount to QR'); }
  });

  // Recovery path: re-run the idempotent wallet credit for an approved mode:'wallet' withdrawal
  // whose credit failed (withdrawal doc has walletCreditFailed:true).
  router.post('/admin/wallet/retry-credit', adminEdit, async (req, res) => {
    try {
      adminOnly(req);
      const { withdrawalId } = req.body;
      if (!withdrawalId) throw fail(400, 'withdrawalId is required');
      const r = await databases.listDocuments(DB, WITHDRAWALS, [Query.equal('id', String(withdrawalId)), Query.limit(1)]);
      const w = r.documents[0];
      if (!w) throw fail(404, 'Withdrawal request not found');
      if (w.mode !== 'wallet') throw fail(400, 'Withdrawal is not a payout-wallet withdrawal');
      if (w.status !== 'approved') throw fail(400, `Cannot credit a ${w.status} withdrawal`);
      const result = await creditWalletFromWithdrawal(w);
      if (w.walletCreditFailed) await databases.updateDocument(DB, WITHDRAWALS, w.$id, { walletCreditFailed: false });
      res.json({ success: true, skipped: result.skipped, transaction: pickWalletTxn(result.txn) });
    } catch (e) { sendError(res, e, 'Failed to retry payout wallet credit'); }
  });

  router.get('/admin/accounts', adminView, async (req, res) => {
    try { res.json(await listAccounts(req.query, await userScope(req, { userId: req.query.userId, subadminId: req.query.subadminId }))); }
    catch (e) { sendError(res, e, 'Failed to fetch customer payout accounts'); }
  });

  // Account detail for admin/subadmin: stats + every payout to this customer (filters as in listPayouts)
  router.get('/admin/accounts/:accountId/payouts', adminView, async (req, res) => {
    try {
      const account = await databases.getDocument(DB, ACCOUNTS, req.params.accountId).catch(() => null);
      if (!account) throw fail(404, 'Customer payout account not found');
      await userScope(req, { userId: account.userId }); // 403 for a subadmin on a foreign user's account
      res.json(await accountWithPayouts(account, req.query, isStaff(req)));
    } catch (e) { sendError(res, e, 'Failed to fetch customer payout account history'); }
  });

  // Repair path: rebuild one account's stats from its payout rows (idempotent overwrite)
  router.post('/admin/accounts/:accountId/recompute-stats', adminEdit, async (req, res) => {
    try {
      const account = await databases.getDocument(DB, ACCOUNTS, req.params.accountId).catch(() => null);
      if (!account) throw fail(404, 'Customer payout account not found');
      await assertCanAct(req, account.userId);
      res.json({ success: true, account: pickAccount(await recomputeAccountStats(account.$id)) });
    } catch (e) { sendError(res, e, 'Failed to recompute account stats'); }
  });

  router.delete('/admin/accounts/:accountId', adminEdit, async (req, res) => {
    try {
      const account = await databases.getDocument(DB, ACCOUNTS, req.params.accountId).catch(() => null);
      if (!account) throw fail(404, 'Customer payout account not found');
      await assertCanAct(req, account.userId);
      await deleteAccount(account);
      res.json({ success: true, message: 'Customer payout account deleted' });
    } catch (e) { sendError(res, e, 'Failed to delete customer payout account'); }
  });

  router.patch('/admin/accounts/:accountId/banking-status', adminEdit, async (req, res) => {
    try {
      const { bankingStatus } = req.body;
      if (!BANKING_STATUSES.includes(bankingStatus)) throw fail(400, 'bankingStatus must be added or not_added');
      const account = await databases.getDocument(DB, ACCOUNTS, req.params.accountId).catch(() => null);
      if (!account) throw fail(404, 'Customer payout account not found');
      await assertCanAct(req, account.userId);
      const at = nowIso();
      const updated = await databases.updateDocument(DB, ACCOUNTS, account.$id, {
        bankingStatus, bankingStatusUpdatedAt: at, bankingStatusUpdatedBy: req.user.userId,
      });
      // Timeline: stamp every pending request for this beneficiary that was waiting on the tag.
      // Best-effort — the tag itself is already saved.
      let stamped = 0;
      if (bankingStatus === 'added') {
        try {
          const pending = await databases.listDocuments(DB, PAYOUTS, [Query.equal('accountId', account.$id), Query.equal('status', 'pending'), Query.limit(100)]);
          for (const p of pending.documents) {
            if (p.addedToBankingAt) continue;
            await databases.updateDocument(DB, PAYOUTS, p.$id, { addedToBankingAt: at });
            stamped++;
          }
        } catch (e) { console.error(`banking-status: could not stamp pending payouts for account ${account.$id}:`, e?.message); }
      }
      await notify(account.userId, { type: 'account_banking_status', userId: account.userId, accountId: account.$id, bankingStatus, stampedRequests: stamped }, { toAdmins: false });
      res.json({ success: true, account: pickAccount(updated), stampedRequests: stamped });
    } catch (e) { sendError(res, e, 'Failed to update banking status'); }
  });

  // Admin queue. Scope filters: userId, subadminId (their users + themselves), qrId (the QR's assigned
  // user) — combinable, intersected. Row filters: see listPayouts.
  router.get('/admin/requests', adminView, async (req, res) => {
    try { res.json(await listPayouts(req.query, await userScope(req, req.query), isStaff(req))); }
    catch (e) { sendError(res, e, 'Failed to fetch customer payout requests'); }
  });

  // Single request by unique id (cpo_…). Subadmins: only their users' requests (404 otherwise).
  router.get('/admin/requests/:id', adminView, async (req, res) => {
    try {
      const p = await loadPayoutByBusinessId(req.params.id);
      const scope = await userScope(req, { userId: p.userId }).catch(() => null);
      if (scope === null) throw fail(404, 'Customer payout request not found');
      res.json({ success: true, payout: await payoutView(p, isStaff(req)) });
    } catch (e) { sendError(res, e, 'Failed to fetch customer payout request'); }
  });

  // Mark PAID: debits amount+commission from the wallet (releasing the hold), stamps the payout
  // reference number, then records payout commission. Exactly-once via wallet lock + re-read +
  // idempotent ledger row.
  // Body: { referenceNumber (required), paidVia? (staff-only note: which of our accounts paid it, ≤100) }
  router.post('/admin/requests/:id/paid', adminEdit, async (req, res) => {
    try {
      const referenceNumber = String(req.body.referenceNumber || '').trim();
      if (referenceNumber.length < 5 || referenceNumber.length > 100) throw fail(400, 'Payout reference number is required (5–100 characters)');
      const paidVia = String(req.body.paidVia || '').trim().slice(0, 100) || null;
      const found = await loadPayoutByBusinessId(req.params.id);
      await assertCanAct(req, found.userId); // employees: only their assigned subadmins' users
      if (found.status !== 'pending') throw fail(400, `Cannot mark a ${found.status} request as paid`);

      const updated = await withWalletLock(found.userId, LOCK_TTL_RESOLVE, async () => {
        const p = await databases.getDocument(DB, PAYOUTS, found.$id); // fresh read under lock
        if (p.status !== 'pending') throw fail(409, 'Request was already resolved');
        const total = Number(p.totalPaise);
        if (!(await findWalletTxn('payout_paid', p.id))) {
          await moveWallet(p.userId, {
            deltaBalance: -total, deltaHold: -total,
            txn: {
              userId: p.userId, type: 'payout_paid', direction: 'debit',
              amountPaise: Number(p.amountPaise), commissionPaise: Number(p.commissionPaise), totalPaise: total,
              refType: 'customer_payout', refId: p.id, referenceNumber,
              notes: `${p.mode} payout to ${p.customerName} (${p.mode === 'UPI' && p.upiId ? p.upiId : p.accountNumber})`, createdBy: req.user.userId,
            },
          });
        }
        const at = nowIso();
        const doc = await databases.updateDocument(DB, PAYOUTS, p.$id, {
          status: 'paid', referenceNumber, paidVia, rejectionReason: null, processedAt: at, paidAt: at, processedBy: req.user.userId,
        });
        await bumpAccountStats(p.accountId, { paidCount: 1, totalPaidPaise: Number(p.amountPaise || 0), totalCommissionPaise: Number(p.commissionPaise || 0) }, { lastPaidAt: at });
        return doc;
      });

      const paidAmount = Number(updated.amountPaise || 0);
      await inc('totalCustomerPayoutPendingAmount', -paidAmount);
      await inc('totalCustomerPayoutPendingCount', -1);
      await inc('totalCustomerPayoutPaid', paidAmount);
      await inc('totalCustomerPayoutPaidCount', 1);

      // Commission is derived from the paid payout — never blocks the response (mirrors withdraw approve).
      try { await recordPayoutCommission(updated); }
      catch (e) { console.error(`CRITICAL: payout commission failed for ${updated.id}. Needs reconciliation.`, e); }
      await touchSource(paidVia, paidAmount, req.user.userId);
      await notify(updated.userId, { type: 'request_paid', userId: updated.userId, payoutId: updated.id, status: 'paid', amountPaise: paidAmount, referenceNumber });

      res.json({ success: true, message: 'Payout marked as paid', payout: pickPayout(updated, true) });
    } catch (e) { sendError(res, e, 'Failed to mark payout as paid'); }
  });

  router.post('/admin/requests/:id/reject', adminEdit, async (req, res) => {
    try {
      const reason = String(req.body.reason || '').trim();
      if (reason.length < 4 || reason.length > 500) throw fail(400, 'Rejection reason is required (4–500 characters)');
      const found = await loadPayoutByBusinessId(req.params.id);
      await assertCanAct(req, found.userId);
      if (found.status !== 'pending') throw fail(400, `Cannot reject a ${found.status} request`);

      const updated = await withWalletLock(found.userId, LOCK_TTL_RESOLVE, async () => {
        const p = await databases.getDocument(DB, PAYOUTS, found.$id);
        if (p.status !== 'pending') throw fail(409, 'Request was already resolved');
        await moveWallet(p.userId, { deltaHold: -Number(p.totalPaise) }); // release the hold, balance untouched
        const at = nowIso();
        const doc = await databases.updateDocument(DB, PAYOUTS, p.$id, {
          status: 'rejected', rejectionReason: reason, referenceNumber: null, processedAt: at, rejectedAt: at, processedBy: req.user.userId,
        });
        await bumpAccountStats(p.accountId, { rejectedCount: 1 });
        return doc;
      });
      await inc('totalCustomerPayoutPendingAmount', -Number(updated.amountPaise || 0));
      await inc('totalCustomerPayoutPendingCount', -1);
      await notify(updated.userId, { type: 'request_rejected', userId: updated.userId, payoutId: updated.id, status: 'rejected', reason });
      res.json({ success: true, message: 'Payout rejected', payout: pickPayout(updated, true) });
    } catch (e) { sendError(res, e, 'Failed to reject payout'); }
  });

  // ─── payout commission (separate from withdrawal commission) ───────────────
  const commissionAuth = authenticateAdminOrLabel('view_payout_commissions', { isSubadminAllowed: true });

  router.get('/admin/commissions', commissionAuth, async (req, res) => {
    try {
      const q = req.query;
      const limit = parseLimit(q.limit, 50);
      const queries = [];
      if (req.user.role === 'subadmin') queries.push(Query.equal('userId', req.user.userId)); // own earnings only
      else if (q.userId) queries.push(Query.equal('userId', q.userId));
      if (q.earningType) {
        if (!['admin', 'subadmin'].includes(q.earningType)) throw fail(400, 'Invalid earningType');
        queries.push(Query.equal('earningType', q.earningType));
      }
      if (q.sourcePayoutId) queries.push(Query.equal('sourcePayoutId', q.sourcePayoutId));
      queries.push(...dateQueries(q.from, q.to), Query.orderDesc('createdAt'), ...cursorQuery(q.cursor), Query.limit(limit));
      const r = await databases.listDocuments(DB, COMMISSION_TXNS, queries);
      res.json({ commissions: r.documents.map(pickCommission), nextCursor: nextCursorOf(r.documents, limit) });
    } catch (e) { sendError(res, e, 'Failed to fetch payout commissions'); }
  });

  // Daily payout-commission summary from the rollup. ?from&to (IST days, default today), ?userId
  router.get('/admin/commissions/summary', commissionAuth, async (req, res) => {
    try {
      const from = req.query.from || istDay();
      const to = req.query.to || from;
      if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw fail(400, 'Dates must be YYYY-MM-DD');
      const start = moment.tz(from, 'Asia/Kolkata'), end = moment.tz(to, 'Asia/Kolkata');
      if (!start.isValid() || !end.isValid() || end.isBefore(start)) throw fail(400, 'Invalid date range');
      if (end.diff(start, 'days') > 366) throw fail(400, 'Range too large (max 366 days)');
      const userId = req.user.role === 'subadmin' ? req.user.userId : (req.query.userId || null);

      const days = [];
      for (let d = start.clone(); !d.isAfter(end); d.add(1, 'day')) days.push({ date: d.format('YYYY-MM-DD'), commissionPaise: 0 });
      const idx = new Map(days.map((x, i) => [x.date, i]));
      const perUser = {};
      const r = await databases.listDocuments(DB, DAILY_COMMISSION, [Query.between('date', from, to), Query.orderAsc('date'), Query.limit(400)]);
      for (const doc of r.documents) {
        const i = idx.get(String(doc.date));
        if (i === undefined) continue;
        let obj = {};
        try { obj = JSON.parse(doc.commissionsJson || '{}') || {}; } catch { obj = {}; }
        for (const [uid, v] of Object.entries(obj)) {
          if (userId && uid !== userId) continue;
          const paise = Number(v || 0);
          days[i].commissionPaise += paise;
          perUser[uid] = (perUser[uid] || 0) + paise;
        }
      }
      const totalPaise = days.reduce((s, d) => s + d.commissionPaise, 0);
      res.json({ success: true, range: { from, to }, userId, totalPaise, totalRs: totalPaise / 100, days, perUser });
    } catch (e) { sendError(res, e, 'Failed to fetch payout commission summary'); }
  });

  // Monthly / all-time rollup rows. ?userId (subadmin forced to self), ?month=YYYY-MM (monthly, default current)
  const pickTotal = (d) => ({ $id: d.$id, userId: d.userId, month: d.month || null, totalCommissionPaise: Number(d.totalCommissionPaise || 0), totalRs: Number(d.totalCommissionPaise || 0) / 100 });
  async function listTotals(req, res, collection, monthly) {
    try {
      const q = req.query;
      const limit = parseLimit(q.limit);
      const userId = req.user.role === 'subadmin' ? req.user.userId : (q.userId || null);
      const queries = [];
      let month = null;
      if (monthly) {
        month = q.month || istMonth();
        if (!MONTH_RE.test(month)) throw fail(400, 'month must be YYYY-MM');
        queries.push(Query.equal('month', month));
      }
      if (userId) queries.push(Query.equal('userId', userId));
      queries.push(Query.orderDesc('totalCommissionPaise'), ...cursorQuery(q.cursor), Query.limit(limit));
      const r = await databases.listDocuments(DB, collection, queries);
      const totals = r.documents.map(pickTotal);
      res.json({ success: true, month, userId, grandTotalPaise: totals.reduce((s, t) => s + t.totalCommissionPaise, 0), totals, nextCursor: nextCursorOf(r.documents, limit) });
    } catch (e) { sendError(res, e, 'Failed to fetch payout commission totals'); }
  }
  router.get('/admin/commissions/monthly', commissionAuth, (req, res) => listTotals(req, res, MONTHLY_COMMISSION, true));
  router.get('/admin/commissions/all-time', commissionAuth, (req, res) => listTotals(req, res, ALLTIME_COMMISSION, false));

  return { router, creditWalletFromWithdrawal };
};
