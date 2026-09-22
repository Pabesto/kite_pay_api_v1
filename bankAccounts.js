// bankAccounts.js — Bank Account pay-ins: a second pay-in channel next to QR codes, with its OWN
// tables and routes (mounted at /api/bank-acs, server.js). Nothing here touches qr_codes or
// webhook_data. Frontend contract: BANK_ACCOUNTS_FRONTEND.md.
//
//   bank_accounts               one doc per account. `bankAcId` = the trimmed account number (the business
//                               key; immutable), plus the SAME seven ledger fields a QR doc carries
//                               (paise; amountAvailableForWithdrawal is derived, never set directly).
//   bank_transactions           one row per "I paid into this account" claim. Born `pending`; an admin or
//                               a labelled employee checks the bank statement and approves (credits the
//                               ledger) or rejects (nothing moves). No manual-review windows here — every
//                               row is a manual hold by nature. `referenceNumber` (UTR) is unique across
//                               every account while a claim is pending/approved.
//   daily_bankac_summaries      { date, totalsJson: { bankAcId: paise } } — the bank twin of daily_qr_summaries
//   bankac_daily_releases       T+0 early-release gate rows (qrSettlement instance, keyField bankAcId)
//   daily_bankac_withdrawal_summaries — day-wise withdrawal report (withdrawalSummary instance)
//
// Money leaves an account through withdraw.js exactly like a QR: the client sends `bankAcId` instead of
// `qrId` on /withdraw_new and the same commission, 422 zero-share rule, T+1 settlement, wallet credit
// and revert-to-QR apply (withdraw.js sourceOf(), payout.js ledgerSourceOf()). The lock family is
// `lock:bankac:<bankAcId>` and this module takes it for every ledger write, so — unlike the QR
// review-approve gap — a bank approve can never race a withdrawal on the same ledger.
//
// Approve choreography (exactly-once):
//   lock:bankac:<bankAcId> (outer, 15s) → lock:bankac:review:<txnId> (inner, 20s) → re-read → proceed only
//   while status === 'pending' → flip status FIRST (commit point) → ledger RMW → daily summary (non-fatal)
//   → Redis counters (non-fatal) → release both in finally. Losers see a non-pending status → 409.
//
// Dashboard: two Redis counters of its own (counter:totalBankAcTxCount, counter:totalBankAmountReceived —
// flushed/re-seeded by server.js with the QR ones) and `updateDashboardCounter` figures for the rest.
// The QR counters are never touched, so their re-seed from webhook_data stays exact.
//
// Positional factory (server.js mount + tests/bankAccounts.test.js must match; append only):
//   1 databases, 2 ID, 3 Query, 4 DB, 5 USERS_META, 6 ACCOUNTS, 7 TXNS, 8 DAILY, 9 WITHDRAWALS,
//   10 redisClient, 11 authenticateToken, 12 authenticateAdminOrLabel, 13 authenticateAdmin,
//   14 emitWithdrawalEvent (socketServer; optional), 15 settlement (qrSettlement.create instance),
//   16 wdSummary (withdrawalSummary.create instance)

const express = require('express');
const moment = require('moment-timezone');
const { updateDashboardCounter } = require('./dashboardCounters');
const ConfigManager = require('./configManager');
const userMetaCache = require('./userMetaCache');

const ACCOUNT_RE = /^[A-Za-z0-9]{6,24}$/;          // trimmed account number; some banks issue alphanumerics
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;           // RBI standard, always stored upper-case
const REF_RE = /^[A-Z0-9-]{6,40}$/;                 // UTR / reference number, stored upper-case
const CURSOR_RE = /^[a-zA-Z0-9_:-]{1,255}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_ID_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const ACCOUNT_TYPES = ['savings', 'current'];
const TXN_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const LOCK_TTL_LEDGER = 15, LOCK_TTL_REVIEW = 20, LOCK_TTL_DELETE = 20, LOCK_TTL_HOLD_RESET = 180;
const LEDGER_FIELDS = ['totalTransactions', 'totalPayInAmount', 'withdrawalRequestedAmount', 'withdrawalApprovedAmount', 'amountAvailableForWithdrawal', 'amountOnHold', 'commissionOnHold', 'commissionPaid'];

module.exports = (databases, ID, Query, DB, USERS_META, ACCOUNTS, TXNS, DAILY, WITHDRAWALS, redisClient, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, emitWithdrawalEvent, settlement, wdSummary) => {
    const router = express.Router();

    // ─── helpers ───────────────────────────────────────────────────────────────
    function fail(status, message, extra) { return Object.assign(new Error(message), { status, ...(extra || {}) }); }
    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
    }
    function sendError(res, err, fallback) {
        if (err?.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.current ? { current: err.current } : {}), ...(err.body || {}) });
        if (isCursorError(err)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
        console.error(`❌ bank-acs: ${fallback}:`, err);
        return res.status(500).json({ error: fallback });
    }
    const parseLimit = (q, cap = 100) => Math.min(Math.max(parseInt(q ?? 25, 10) || 25, 1), cap);
    function cursorQuery(cursor) {
        if (!cursor) return [];
        if (!CURSOR_RE.test(cursor)) throw fail(400, 'Invalid cursor format');
        return [Query.cursorAfter(cursor)];
    }
    const nowIso = () => moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]'); // UTC ISO, like every other stored timestamp
    const istDay = (ts = new Date()) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');
    const dayBounds = (d, edge) => { if (!DAY_RE.test(d)) throw fail(400, 'Dates must be YYYY-MM-DD'); return moment.tz(d, 'Asia/Kolkata')[edge]('day').utc().toISOString(); };
    // rupees → paise at the boundary. toPaise: > 0 only (money); toLimitPaise: ≥ 0 (0 = unlimited).
    const toPaise = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? Math.round(n * 100) : null; };
    const toLimitPaise = (v) => { const n = Number(v); return isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
    const inc = (key, delta) => updateDashboardCounter(databases, DB, key, delta).catch((e) => console.error(`Error updating ${key}:`, e));
    function cfgBool(key, def) { const v = ConfigManager.get(key, def); return v == null ? def : !['false', '0', 'no', ''].includes(String(v).toLowerCase()); }
    const cfgInt = (key, def) => { const n = Number(ConfigManager.get(key, def)); return isFinite(n) && n >= 0 ? Math.floor(n) : def; };
    const isHoldId = (id) => /_hold\d*$/.test(id);

    // Fail-closed Redis lock (payout.js shape): contention or a Redis error = not acquired.
    const RELEASE_LOCK = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
    async function withLock(key, ttl, fn, busyMessage, busyStatus = 409) {
        const val = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let acquired = false;
        try { acquired = (await redisClient.set(key, val, { NX: true, EX: ttl })) === 'OK'; }
        catch (e) { console.error(`bank-acs lock error for ${key} (failing closed):`, e.message); }
        if (!acquired) throw fail(busyStatus, busyMessage);
        try { return await fn(); }
        finally {
            try { await redisClient.eval(RELEASE_LOCK, { keys: [key], arguments: [val] }); }
            catch (e) { console.error(`releaseLock failed for ${key} — lock will expire after TTL:`, e.message); }
        }
    }
    const withAccountLock = (bankAcId, ttl, fn, status) => withLock(`lock:bankac:${bankAcId}`, ttl, fn, 'Bank account is currently being processed. Please try again in a moment.', status);
    // Daily totalsJson lock — retried like updateDailyQrTotal, fails closed.
    async function withDayLock(day, fn) {
        const lockKey = `lock:bankac:daily:${day}`;
        const lockVal = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let acquired = false;
        for (let i = 0; i < 20 && !acquired; i++) {
            acquired = (await redisClient.set(lockKey, lockVal, { NX: true, EX: 10 }).catch(() => null)) === 'OK';
            if (!acquired) await new Promise((r) => setTimeout(r, 50 + i * 40));
        }
        if (!acquired) throw new Error(`Could not acquire ${lockKey}`);
        try { return await fn(); }
        finally { await redisClient.eval(RELEASE_LOCK, { keys: [lockKey], arguments: [lockVal] }).catch(() => {}); }
    }

    async function listAll(col, queries = [], maxPages = 100) {
        const out = []; let cursor = null;
        for (let page = 0; page < maxPages; page++) {
            const q = [...queries, Query.orderAsc('$id'), Query.limit(100)];
            if (cursor) q.push(Query.cursorAfter(cursor));
            const r = await databases.listDocuments(DB, col, q);
            out.push(...r.documents);
            if (r.documents.length < 100) break;
            cursor = r.documents[r.documents.length - 1].$id;
        }
        return out;
    }
    async function findAccount(bankAcId) {
        const r = await databases.listDocuments(DB, ACCOUNTS, [Query.equal('bankAcId', String(bankAcId)), Query.limit(1)]);
        return r.documents[0] || null;
    }
    async function getTxn(id) {
        try { return await databases.getDocument(DB, TXNS, id); }
        catch (e) { if (e?.code === 404) throw fail(404, 'Transaction not found'); throw e; }
    }
    const getUserMeta = (id) => userMetaCache.getUserMeta(id);
    // Subadmins an employee is assigned to (older docs stamp either id). ponytail: one page, like every sibling.
    async function assignedSubadminIds(req) {
        const keys = [...new Set([req.user.$id, req.user.userId].filter(Boolean))];
        const r = await databases.listDocuments(DB, USERS_META, [Query.equal('assigned_to', keys), Query.equal('role', 'subadmin'), Query.limit(100)]);
        return r.documents.map((d) => d.userId).filter(Boolean);
    }
    async function usersUnder(subadminId) {
        const r = await databases.listDocuments(DB, USERS_META, [Query.equal('parentId', subadminId), Query.limit(100)]); // ponytail: >100 users under one subadmin needs paging
        return r.documents.map((d) => d.userId).filter(Boolean);
    }
    // The subadmin who "owns" an account's money for tenancy/scoping (mirrors qrOwnerCache._ownerFor).
    async function ownerSubadminFor(assignedUserId, managedByUserId) {
        if (assignedUserId) {
            const a = await getUserMeta(assignedUserId).catch(() => null);
            if (a?.role === 'subadmin') return assignedUserId;
            if (a?.parentId) return a.parentId;
        }
        return managedByUserId || null;
    }
    const orEqual = (field, ids) => (ids.length === 1 ? Query.equal(field, ids[0]) : Query.or(ids.map((id) => Query.equal(field, id))));

    // ─── projections ───────────────────────────────────────────────────────────
    const ledgerOf = (d) => Object.fromEntries(LEDGER_FIELDS.map((k) => [k, Number(d[k] || 0)]));
    const pickAccount = (d) => ({
        $id: d.$id, bankAcId: d.bankAcId, bankName: d.bankName || null, accountHolderName: d.accountHolderName || null,
        ifscCode: d.ifscCode || null, accountType: d.accountType || null, upiId: d.upiId || null, notes: d.notes || null,
        perTxnLimitPaise: Number(d.perTxnLimitPaise || 0), perTxnLimitRs: Number(d.perTxnLimitPaise || 0) / 100,
        dailyLimitPaise: Number(d.dailyLimitPaise || 0), dailyLimitRs: Number(d.dailyLimitPaise || 0) / 100,
        isActive: d.isActive !== false, archived: isHoldId(String(d.bankAcId || '')),
        assignedUserId: d.assignedUserId || null, managedByUserId: d.managedByUserId || null, createdByUserId: d.createdByUserId || null,
        createdAt: d.createdAt || null, ...ledgerOf(d),
    });
    const pickTxn = (d) => ({
        $id: d.$id, bankAcId: d.bankAcId, userId: d.userId, ownerSubadminId: d.ownerSubadminId || null, requestedBy: d.requestedBy || null,
        referenceNumber: d.referenceNumber, amountPaise: Number(d.amountPaise || 0), amountRs: Number(d.amountPaise || 0) / 100,
        approvedAmountPaise: d.approvedAmountPaise == null ? null : Number(d.approvedAmountPaise),
        approvedAmountRs: d.approvedAmountPaise == null ? null : Number(d.approvedAmountPaise) / 100,
        payerName: d.payerName || null, paidAt: d.paidAt || null, remarks: d.remarks || null, proofFileId: d.proofFileId || null,
        status: d.status, reviewedBy: d.reviewedBy || null, reviewedAt: d.reviewedAt || null, reviewNotes: d.reviewNotes || null,
        rejectReason: d.rejectReason || null, deleted: d.deleted === true, createdAt: d.createdAt || null, created_at: d.created_at || null,
    });
    // Settlement columns for a list of account docs (today/yesterday pay-in, T+1 hold, what may be withdrawn now).
    async function withSettlement(docs) {
        const day = istDay(), yday = moment.tz('Asia/Kolkata').subtract(1, 'day').format('YYYY-MM-DD');
        const [settle, yesterday] = await Promise.all([settlement.forQrDocs(docs, day), settlement.todayPayIns(yday)]);
        return docs.map((d) => {
            const row = settle.byQrId[d.bankAcId] || settlement.row(d.bankAcId, d.amountAvailableForWithdrawal, 0, 0, day);
            return {
                ...pickAccount(d),
                todayTotalPayIn: row.todayPayInPaise, yesterdayTotalPayIn: Number(yesterday[d.bankAcId] || 0),
                releasedTodayPaise: row.releasedPaise, heldTodayPaise: row.heldPaise, canWithdrawTodayPaise: row.withdrawablePaise,
                t1HoldApplies: row.t1HoldApplies !== false, // false while config bank_account_insta_credit is on
            };
        });
    }

    // ─── money primitives (all paise) ──────────────────────────────────────────
    // Ledger credit/debit on the account doc: fresh read, recompute available, write. Callers hold
    // lock:bankac:<id>. 3 tries on transport errors; a permanent failure returns null and is logged
    // CRITICAL (the txn is already approved — same posture as updateQrTotalAtomic).
    async function adjustLedger(bankAcId, amountPaise, countDelta) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const doc = await findAccount(bankAcId);
                if (!doc) { console.error(`bank-acs: account ${bankAcId} not found for ledger adjust`); return null; }
                const l = ledgerOf(doc);
                const newTotal = l.totalPayInAmount + amountPaise;
                const newAvailable = newTotal - l.withdrawalApprovedAmount - l.withdrawalRequestedAmount - l.amountOnHold - l.commissionOnHold - l.commissionPaid;
                if (amountPaise < 0 && (newTotal < 0 || newAvailable < 0)) throw fail(409, 'Cannot reverse this transaction: the available withdrawal balance would go negative. Cancel or reject pending withdrawals on this bank account first.', { body: { currentAvailable: l.amountAvailableForWithdrawal, withdrawalRequested: l.withdrawalRequestedAmount, withdrawalApproved: l.withdrawalApprovedAmount } });
                return await databases.updateDocument(DB, ACCOUNTS, doc.$id, {
                    totalTransactions: Math.max(0, l.totalTransactions + countDelta), totalPayInAmount: newTotal, amountAvailableForWithdrawal: newAvailable,
                });
            } catch (e) {
                if (e.status) throw e;
                if (attempt === 3) { console.error(`CRITICAL: bank-acs ledger adjust failed for ${bankAcId} (${amountPaise} paise) after 3 attempts`, e); return null; }
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        return null;
    }
    // daily_bankac_summaries[date][bankAcId] += delta, under lock:bankac:daily:<day>. Never negative.
    async function bumpDailyTotal(bankAcId, isoDate, delta) {
        const day = istDay(isoDate);
        return withDayLock(day, async () => {
            const doc = (await databases.listDocuments(DB, DAILY, [Query.equal('date', day), Query.limit(1)])).documents[0];
            let totals = {};
            if (doc) { try { totals = JSON.parse(doc.totalsJson || '{}') || {}; } catch { throw new Error(`Corrupt totalsJson for ${day} — manual fix required`); } }
            const next = Number(totals[bankAcId] || 0) + delta;
            if (next < 0) throw new Error('Total amount cannot be negative');
            totals[bankAcId] = next;
            if (doc) await databases.updateDocument(DB, DAILY, doc.$id, { totalsJson: JSON.stringify(totals) });
            else await databases.createDocument(DB, DAILY, ID.unique(), { date: day, totalsJson: JSON.stringify(totals) });
        });
    }
    // The two bank-only Redis counters (server.js flushes/re-seeds them with the QR ones). Never fails a request.
    function bumpRedisCounters(countDelta, amountDelta) {
        Promise.all([redisClient.incrBy('counter:totalBankAcTxCount', countDelta), redisClient.incrBy('counter:totalBankAmountReceived', amountDelta)])
            .then(() => { redisClient.countersDirty = true; })
            .catch((e) => { redisClient.countersStale = true; console.error('Redis bank counter update failed:', e?.message || e); });
    }
    // Sum of today's pending + approved claims on one account (IST day of the request). For the daily-limit WARNING only.
    async function todayUsagePaise(bankAcId) {
        const day = istDay();
        const docs = await listAll(TXNS, [Query.equal('bankAcId', bankAcId), Query.equal('status', ['pending', 'approved']), Query.between('createdAt', dayBounds(day, 'startOf'), dayBounds(day, 'endOf'))], 5);
        return docs.reduce((s, d) => s + Number(d.approvedAmountPaise ?? d.amountPaise ?? 0), 0);
    }

    // ─── realtime (never throws; fires after the commit point) ─────────────────
    async function notify(type, txn, actor, extra = {}) {
        try {
            if (typeof emitWithdrawalEvent !== 'function' || !cfgBool('bankac_realtime_enabled', true)) return;
            emitWithdrawalEvent({
                userId: txn.userId, staffRooms: [txn.ownerSubadminId || null, txn.userId], event: 'bankac:txn',
                payload: { type, bankAcId: txn.bankAcId, transactionId: txn.$id, userId: txn.userId, ownerSubadminId: txn.ownerSubadminId || null,
                    actor: actor ? { userId: actor.userId || null, role: actor.role || null, name: actor.name || null } : null,
                    transaction: pickTxn(txn), ...extra, at: new Date().toISOString() },
            });
        } catch (e) { console.error('bank-acs notify failed:', e?.message); }
    }
    // Daily limit is a WARNING, never a block: admins + the owner subadmin get told, the request goes through.
    async function warnDailyLimit(account, txn) {
        try {
            const limit = Number(account.dailyLimitPaise || 0);
            if (!(limit > 0) || typeof emitWithdrawalEvent !== 'function' || !cfgBool('bankac_realtime_enabled', true)) return null;
            const usedPaise = await todayUsagePaise(account.bankAcId);
            if (usedPaise <= limit) return null;
            emitWithdrawalEvent({
                userId: null, staffRooms: [txn.ownerSubadminId || null], event: 'bankac:limitWarning',
                payload: { bankAcId: account.bankAcId, date: istDay(), dailyLimitPaise: limit, usedPaise, overByPaise: usedPaise - limit, transactionId: txn.$id, at: new Date().toISOString() },
            });
            return { dailyLimitPaise: limit, usedPaise };
        } catch (e) { console.error('bank-acs daily-limit warning failed:', e?.message); return null; }
    }

    // ─── scoping ───────────────────────────────────────────────────────────────
    // Which account ids the caller may see in an account-keyed report. null = every account.
    async function scopeAccountIds(actor, filterUserId, filterBankAcId) {
        let allowed = null;
        const idsAssignedTo = async (userIds) => (userIds.length ? (await listAll(ACCOUNTS, [orEqual('assignedUserId', userIds)])).map((d) => d.bankAcId) : []);
        if (actor.role === 'admin' || actor.role === 'employee') {
            if (filterUserId) allowed = await idsAssignedTo([filterUserId]);
        } else if (actor.role === 'subadmin') {
            const mine = await usersUnder(actor.userId);
            if (filterUserId) {
                if (filterUserId !== actor.userId && !mine.includes(filterUserId)) throw fail(403, 'You can only view your own users');
                allowed = await idsAssignedTo([filterUserId]);
            } else {
                const managed = (await listAll(ACCOUNTS, [Query.equal('managedByUserId', actor.userId)])).map((d) => d.bankAcId);
                allowed = [...new Set([...(await idsAssignedTo([actor.userId, ...mine])), ...managed])];
            }
        } else {
            allowed = await idsAssignedTo([actor.userId]);
        }
        if (filterBankAcId) {
            if (allowed && !allowed.includes(filterBankAcId)) throw fail(403, 'You do not have access to this bank account');
            allowed = [filterBankAcId];
        }
        return allowed;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCOUNTS
    // ═══════════════════════════════════════════════════════════════════════════

    function validateAccountBody(body, { partial = false } = {}) {
        const out = {};
        const has = (k) => body[k] !== undefined;
        if (!partial || has('bankName')) { const v = String(body.bankName || '').trim(); if (!v || v.length > 100) throw fail(400, 'bankName is required (max 100 chars)'); out.bankName = v; }
        if (!partial || has('accountHolderName')) { const v = String(body.accountHolderName || '').trim(); if (!v || v.length > 120) throw fail(400, 'accountHolderName is required (max 120 chars)'); out.accountHolderName = v; }
        if (!partial || has('ifscCode')) { const v = String(body.ifscCode || '').trim().toUpperCase(); if (!IFSC_RE.test(v)) throw fail(400, 'Invalid IFSC code format (e.g. SBIN0001234)'); out.ifscCode = v; }
        if (!partial || has('accountType')) { const v = String(body.accountType || '').trim().toLowerCase(); if (!ACCOUNT_TYPES.includes(v)) throw fail(400, `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`); out.accountType = v; }
        if (has('upiId')) {
            const v = body.upiId == null || body.upiId === '' ? null : String(body.upiId).trim();
            if (v && !/^[a-zA-Z0-9.\-_+]+@[a-zA-Z0-9]+$/.test(v)) throw fail(400, 'Invalid UPI ID format (expected handle@provider)');
            out.upiId = v;
        }
        if (has('notes')) { const v = body.notes == null ? null : String(body.notes).trim().slice(0, 500); out.notes = v || null; }
        for (const [k, field] of [['perTxnLimit', 'perTxnLimitPaise'], ['dailyLimit', 'dailyLimitPaise']]) {
            if (has(k)) { const p = toLimitPaise(body[k]); if (p == null) throw fail(400, `Invalid ${k} (rupees, 0 = unlimited)`); out[field] = p; }
        }
        return out;
    }

    // GET /  — admin: all; employee (label view_bank_acs): accounts of their assigned subadmins' tenants +
    // unassigned; subadmin: accounts assigned to their users or managed by them. ?isActive, ?assignedUserId,
    // ?bankAcId, cursor pagination. Archived "<id>_hold[N]" rows are returned with archived:true.
    router.get('/', authenticateAdminOrLabel('view_bank_acs', { isSubadminAllowed: true }), async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit, 100);
            const queries = [];
            if (req.user.role === 'employee') {
                const subs = await assignedSubadminIds(req);
                if (!subs.length) return res.status(500).json({ message: 'Failed to fetch bank accounts No Merchants assigned.' });
                const users = (await listAll(USERS_META, [orEqual('parentId', subs)])).map((d) => d.userId).filter(Boolean);
                queries.push(Query.or([
                    ...[...subs, ...users].map((id) => Query.equal('assignedUserId', id)),
                    Query.and([Query.isNull('assignedUserId'), Query.isNull('managedByUserId')]),
                ]));
            } else if (req.user.role === 'subadmin') {
                const mine = await usersUnder(req.user.userId);
                queries.push(Query.or([...[req.user.userId, ...mine].map((id) => Query.equal('assignedUserId', id)), Query.equal('managedByUserId', req.user.userId)]));
            }
            if (req.query.isActive === 'true' || req.query.isActive === 'false') queries.push(Query.equal('isActive', req.query.isActive === 'true'));
            if (req.query.assignedUserId) queries.push(Query.equal('assignedUserId', String(req.query.assignedUserId)));
            if (req.query.bankAcId) queries.push(Query.equal('bankAcId', String(req.query.bankAcId).trim()));
            queries.push(Query.orderDesc('createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit));
            const r = await databases.listDocuments(DB, ACCOUNTS, queries);
            const bankAccounts = await withSettlement(r.documents);
            return res.json({ bankAccounts, nextCursor: r.documents.length === limit ? r.documents[r.documents.length - 1].$id : null });
        } catch (e) { return sendError(res, e, 'Failed to fetch bank accounts'); }
    });

    // GET /user/:userId — accounts assigned to one user. A user sees only their own; a subadmin only
    // themselves or their own users; admin/employee anyone.
    router.get('/user/:userId', authenticateToken, async (req, res) => {
        try {
            const userId = String(req.params.userId || '');
            if (req.user.role === 'user' && userId !== req.user.userId) throw fail(403, 'You can only view your own bank accounts');
            if (req.user.role === 'subadmin' && userId !== req.user.userId) {
                const target = await getUserMeta(userId).catch(() => null);
                if (!target || target.parentId !== req.user.userId) throw fail(403, 'You can only view your own users');
            }
            const limit = parseLimit(req.query.limit, 100);
            const r = await databases.listDocuments(DB, ACCOUNTS, [Query.equal('assignedUserId', userId), Query.orderDesc('createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit)]);
            const bankAccounts = await withSettlement(r.documents);
            return res.json({ bankAccounts, nextCursor: r.documents.length === limit ? r.documents[r.documents.length - 1].$id : null });
        } catch (e) { return sendError(res, e, 'Failed to fetch user bank accounts'); }
    });

    // POST / — create (admin). Body: bankAcId (account number), bankName, accountHolderName, ifscCode,
    // accountType, upiId?, notes?, perTxnLimit? (rupees), dailyLimit? (rupees). 409 on a duplicate number.
    router.post('/', authenticateAdmin, async (req, res) => {
        try {
            const bankAcId = String(req.body.bankAcId ?? req.body.accountNumber ?? '').trim();
            if (!ACCOUNT_RE.test(bankAcId)) throw fail(400, 'Invalid bankAcId: the account number must be 6–24 letters/digits');
            if (isHoldId(bankAcId)) throw fail(400, 'bankAcId cannot end in _hold');
            const fields = validateAccountBody(req.body);
            if (await findAccount(bankAcId)) throw fail(409, `Bank account "${bankAcId}" already exists.`);
            const doc = await databases.createDocument(DB, ACCOUNTS, ID.unique(), {
                bankAcId, ...fields, upiId: fields.upiId ?? null, notes: fields.notes ?? null,
                perTxnLimitPaise: fields.perTxnLimitPaise ?? 0, dailyLimitPaise: fields.dailyLimitPaise ?? 0,
                isActive: true, assignedUserId: null, managedByUserId: null, createdByUserId: req.user.userId, createdAt: nowIso(),
                totalTransactions: 0, totalPayInAmount: 0, withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 0,
                amountAvailableForWithdrawal: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0,
            });
            await inc('totalBankAcsUploaded', 1); await inc('bankAcsActive', 1);
            return res.status(201).json({ message: 'Bank account created successfully.', bankAccount: pickAccount(doc) });
        } catch (e) { return sendError(res, e, 'Failed to create bank account'); }
    });

    // PATCH /:bankAcId — edit descriptive fields and limits (admin). The account number itself is immutable.
    router.patch('/:bankAcId', authenticateAdmin, async (req, res) => {
        try {
            if (req.body.bankAcId !== undefined || req.body.accountNumber !== undefined) throw fail(400, 'bankAcId cannot be changed; create a new account or use hold-and-reset');
            const fields = validateAccountBody(req.body, { partial: true });
            if (!Object.keys(fields).length) throw fail(400, 'At least one field (bankName, accountHolderName, ifscCode, accountType, upiId, notes, perTxnLimit, dailyLimit) must be provided for update.');
            const doc = await findAccount(String(req.params.bankAcId).trim());
            if (!doc) throw fail(404, 'Bank account not found.');
            const updated = await databases.updateDocument(DB, ACCOUNTS, doc.$id, fields);
            return res.json({ message: 'Bank account updated successfully.', bankAccount: pickAccount(updated) });
        } catch (e) { return sendError(res, e, 'Failed to update bank account'); }
    });

    // PUT /:bankAcId/status { isActive } — admin or employee label toggle_bank_acs.
    router.put('/:bankAcId/status', authenticateAdminOrLabel('toggle_bank_acs'), async (req, res) => {
        try {
            const { isActive } = req.body;
            if (typeof isActive !== 'boolean') throw fail(400, "Invalid value for 'isActive'.");
            const doc = await findAccount(String(req.params.bankAcId).trim());
            if (!doc) throw fail(404, 'Bank account not found.');
            if ((doc.isActive !== false) === isActive) return res.json({ message: 'Bank account status unchanged.', isActive });
            await databases.updateDocument(DB, ACCOUNTS, doc.$id, { isActive });
            await inc('bankAcsActive', isActive ? 1 : -1); await inc('bankAcsDisabled', isActive ? -1 : 1);
            return res.json({ message: 'Bank account status updated successfully.', isActive });
        } catch (e) { return sendError(res, e, 'Failed to update bank account status'); }
    });

    // DELETE /:bankAcId — admin. Refused while assigned, while claims or withdrawals are pending, or while
    // the ledger still holds withdrawable money (a deleted ledger would strand it).
    router.delete('/:bankAcId', authenticateAdmin, async (req, res) => {
        try {
            const bankAcId = String(req.params.bankAcId).trim();
            const doc = await findAccount(bankAcId);
            if (!doc) throw fail(404, 'Bank account not found.');
            if (doc.assignedUserId) throw fail(400, 'Cannot delete a bank account assigned to a user. Please unassign it first.');
            const pendingTxns = (await databases.listDocuments(DB, TXNS, [Query.equal('bankAcId', bankAcId), Query.equal('status', 'pending'), Query.limit(1)])).total;
            if (pendingTxns > 0) throw fail(400, `Cannot delete: ${pendingTxns} payment claim(s) are still pending on this bank account.`);
            const pendingWd = (await databases.listDocuments(DB, WITHDRAWALS, [Query.equal('bankAcId', bankAcId), Query.equal('status', 'pending'), Query.limit(1)])).total;
            if (pendingWd > 0) throw fail(400, `Cannot delete: ${pendingWd} withdrawal request(s) are still pending on this bank account.`);
            if (Number(doc.amountAvailableForWithdrawal || 0) > 0 || Number(doc.withdrawalRequestedAmount || 0) > 0) throw fail(400, 'Cannot delete: this bank account still holds withdrawable balance. Withdraw it or use hold-and-reset.');
            await databases.deleteDocument(DB, ACCOUNTS, doc.$id);
            await inc('totalBankAcsUploaded', -1); await inc(doc.isActive !== false ? 'bankAcsActive' : 'bankAcsDisabled', -1);
            return res.json({ message: 'Bank account deleted successfully.' });
        } catch (e) { return sendError(res, e, 'Failed to delete bank account'); }
    });

    // PUT /:bankAcId/assign-user { assignedUserId | null } — admin, employee label assign_bank_acs, or the
    // managing subadmin. Mirrors /assign-qr-user, plus: a subadmin may only touch accounts they manage.
    router.put('/:bankAcId/assign-user', authenticateAdminOrLabel('assign_bank_acs', { isSubadminAllowed: true }), async (req, res) => {
        try {
            const doc = await findAccount(String(req.params.bankAcId).trim());
            if (!doc) throw fail(404, 'Bank account not found.');
            if (req.user.role === 'subadmin' && doc.managedByUserId !== req.user.userId) throw fail(403, 'You can only assign bank accounts you manage');
            const raw = req.body.assignedUserId;
            const assignedUserId = raw === '' || raw == null ? null : String(raw);
            if (assignedUserId) {
                const assignee = await getUserMeta(assignedUserId).catch(() => null);
                if (!assignee) throw fail(400, 'Assignee not found.');
                if (doc.managedByUserId && assignee.parentId !== doc.managedByUserId && assignedUserId !== doc.managedByUserId) throw fail(409, 'Assignee not under bank account’s manager.');
            }
            const prev = doc.assignedUserId || null;
            await databases.updateDocument(DB, ACCOUNTS, doc.$id, { assignedUserId });
            if (!prev && assignedUserId) await inc('totalBankAcsAssignedToMerchant', 1);
            else if (prev && !assignedUserId) await inc('totalBankAcsAssignedToMerchant', -1);
            return res.json({ message: 'Assignee updated.', assignedUserId });
        } catch (e) { return sendError(res, e, 'Failed to update assignee'); }
    });

    // PUT /:bankAcId/assign-manager { managedByUserId | null } — mirrors /assign-qr-manager (unlink blocked
    // while assigned; transfer blocked unless the assignee is under the new manager; only admin may transfer).
    router.put('/:bankAcId/assign-manager', authenticateAdminOrLabel('assign_bank_acs'), async (req, res) => {
        try {
            const doc = await findAccount(String(req.params.bankAcId).trim());
            if (!doc) throw fail(404, 'Bank account not found.');
            const raw = req.body.managedByUserId;
            const managedByUserId = raw === '' || raw == null ? null : String(raw);
            if (managedByUserId === null) {
                if (doc.assignedUserId) throw fail(409, 'Cannot clear manager while bank account is assigned; unassign first.', { body: { code: 'UNLINK_BLOCKED_ASSIGNED' } });
                await databases.updateDocument(DB, ACCOUNTS, doc.$id, { managedByUserId: null });
                return res.json({ message: 'Manager unlinked.' });
            }
            if (doc.managedByUserId && doc.managedByUserId !== managedByUserId && req.user.role !== 'admin') throw fail(403, 'Only admin can transfer a bank account to a different manager.');
            const manager = await getUserMeta(managedByUserId).catch(() => null);
            if (!manager) throw fail(400, 'Manager not found.');
            if (doc.assignedUserId) {
                const assignee = await getUserMeta(doc.assignedUserId).catch(() => null);
                if (!assignee) throw fail(409, 'Existing assignee not found; reassign or unassign first.', { body: { code: 'ASSIGNEE_NOT_FOUND' } });
                if (assignee.parentId !== managedByUserId && doc.assignedUserId !== managedByUserId) throw fail(409, 'Assignee not under new manager; reassign or unassign first.', { body: { code: 'ASSIGNEE_OUT_OF_SCOPE' } });
            }
            const prev = doc.assignedUserId || null;
            const payload = { managedByUserId, ...(doc.assignedUserId ? {} : { assignedUserId: managedByUserId }) };
            const updated = await databases.updateDocument(DB, ACCOUNTS, doc.$id, payload);
            if (!prev && updated.assignedUserId) await inc('totalBankAcsAssignedToMerchant', 1);
            return res.json({ message: 'Manager updated.', bankAccount: pickAccount(updated) });
        } catch (e) { return sendError(res, e, 'Failed to update manager'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // TRANSACTIONS (payment claims)
    // ═══════════════════════════════════════════════════════════════════════════

    // Employees resolve claims only inside their assigned subadmins' tenants; admin anywhere.
    async function assertReviewerScope(req, txn) {
        if (req.user.role === 'admin') return;
        const subs = await assignedSubadminIds(req);
        if (!txn.ownerSubadminId || !subs.includes(txn.ownerSubadminId)) throw fail(403, 'Not authorized for this bank account’s transactions');
    }

    // POST /:bankAcId/transactions — the assigned user (or their subadmin, or admin) says "I paid this".
    // Body: referenceNumber (UTR), amount (rupees), payerName?, paidAt? (ISO), remarks?, proofFileId?
    router.post('/:bankAcId/transactions', authenticateToken, async (req, res) => {
        try {
            const bankAcId = String(req.params.bankAcId).trim();
            const account = await findAccount(bankAcId);
            if (!account) throw fail(404, 'Bank account not found.');
            if (account.isActive === false) throw fail(400, 'Bank account is inactive');
            if (!account.assignedUserId) throw fail(409, 'Bank account is not assigned to any user');
            if (req.user.role === 'user' && account.assignedUserId !== req.user.userId) throw fail(403, 'You can only submit payments for your own bank accounts');
            if (req.user.role === 'subadmin' && account.assignedUserId !== req.user.userId) {
                const target = await getUserMeta(account.assignedUserId).catch(() => null);
                if (!target || target.parentId !== req.user.userId) throw fail(403, 'You can only submit payments for your own users');
            }
            if (req.user.role === 'employee') throw fail(403, 'Employees cannot submit payment claims');

            const referenceNumber = String(req.body.referenceNumber ?? req.body.utr ?? '').trim().toUpperCase();
            if (!REF_RE.test(referenceNumber)) throw fail(400, 'Invalid referenceNumber (6–40 letters, digits or dashes)');
            const amountPaise = toPaise(req.body.amount);
            if (amountPaise == null) throw fail(400, 'Invalid amount');
            const payerName = req.body.payerName == null ? null : String(req.body.payerName).trim().slice(0, 120) || null;
            const remarks = req.body.remarks == null ? null : String(req.body.remarks).trim().slice(0, 500) || null;
            let paidAt = null;
            if (req.body.paidAt != null && req.body.paidAt !== '') {
                const d = new Date(req.body.paidAt);
                if (isNaN(d.getTime()) || d.getTime() > Date.now() + 5 * 60 * 1000) throw fail(400, 'Invalid paidAt (ISO date, not in the future)');
                paidAt = d.toISOString();
            }
            const proofFileId = req.body.proofFileId ? String(req.body.proofFileId).trim() : null;
            if (proofFileId && !FILE_ID_RE.test(proofFileId)) throw fail(400, 'Invalid proofFileId');
            if (Number(account.perTxnLimitPaise || 0) > 0 && amountPaise > Number(account.perTxnLimitPaise)) {
                throw fail(422, `Amount exceeds this bank account's per-transaction limit of ₹${(Number(account.perTxnLimitPaise) / 100).toFixed(2)}`);
            }
            const maxPending = cfgInt('bankac_max_pending_claims', 20);
            if (maxPending > 0) {
                const pending = (await databases.listDocuments(DB, TXNS, [Query.equal('userId', account.assignedUserId), Query.equal('status', 'pending'), Query.limit(1)])).total;
                if (pending >= maxPending) throw fail(400, `You already have the maximum number of pending payment claims (${maxPending}).`);
            }

            // Reference numbers are unique across every account while a claim is pending/approved. The NX lock
            // serializes two simultaneous submits of the same UTR; the query is the durable check behind it.
            const created = await withLock(`lock:bankac:ref:${referenceNumber}`, 15, async () => {
                const dup = (await databases.listDocuments(DB, TXNS, [Query.equal('referenceNumber', referenceNumber), Query.equal('status', ['pending', 'approved']), Query.limit(1)])).total;
                if (dup > 0) throw fail(409, 'Reference number already used');
                const ownerSubadminId = await ownerSubadminFor(account.assignedUserId, account.managedByUserId);
                return databases.createDocument(DB, TXNS, ID.unique(), {
                    bankAcId, userId: account.assignedUserId, ownerSubadminId, requestedBy: req.user.userId,
                    referenceNumber, amountPaise, approvedAmountPaise: null, payerName, paidAt, remarks, proofFileId,
                    status: 'pending', deleted: false, createdAt: nowIso(), created_at: null,
                });
            }, 'This reference number is being processed. Please try again.');

            await inc('totalBankAcTxPendingCount', 1); await inc('totalBankAcTxPendingAmount', amountPaise);
            const warning = await warnDailyLimit(account, created);
            notify('requested', created, req.user);
            return res.status(201).json({ success: true, transaction: pickTxn(created), dailyLimitWarning: warning });
        } catch (e) { return sendError(res, e, 'Failed to submit payment claim'); }
    });

    // GET /transactions — role-scoped list. ?bankAcId ?status ?userId ?from ?to ?includeDeleted, cursor.
    router.get('/transactions', authenticateToken, async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const queries = [];
            const { role } = req.user;
            if (role === 'employee') {
                const subs = await assignedSubadminIds(req);
                if (!subs.length) return res.json({ transactions: [], nextCursor: null });
                queries.push(orEqual('ownerSubadminId', subs));
            } else if (role === 'subadmin') {
                queries.push(Query.equal('ownerSubadminId', req.user.userId));
            } else if (role !== 'admin') {
                queries.push(Query.equal('userId', req.user.userId));
            }
            if (req.query.userId && role !== 'user') queries.push(Query.equal('userId', String(req.query.userId)));
            if (req.query.bankAcId) queries.push(Query.equal('bankAcId', String(req.query.bankAcId).trim()));
            if (req.query.status) {
                if (!TXN_STATUSES.includes(String(req.query.status))) throw fail(400, `Invalid status. Must be one of: ${TXN_STATUSES.join(', ')}`);
                queries.push(Query.equal('status', String(req.query.status)));
            }
            if (req.query.from && req.query.to) queries.push(Query.between('createdAt', dayBounds(req.query.from, 'startOf'), dayBounds(req.query.to, 'endOf')));
            else if (req.query.from) queries.push(Query.between('createdAt', dayBounds(req.query.from, 'startOf'), dayBounds(req.query.from, 'endOf')));
            else if (req.query.to) queries.push(Query.lessThanEqual('createdAt', dayBounds(req.query.to, 'endOf')));
            if (req.query.includeDeleted !== 'true') queries.push(Query.or([Query.equal('deleted', false), Query.isNull('deleted')]));
            queries.push(Query.orderDesc('$createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit));
            const r = await databases.listDocuments(DB, TXNS, queries);
            return res.json({ transactions: r.documents.map(pickTxn), nextCursor: r.documents.length === limit ? r.documents[r.documents.length - 1].$id : null });
        } catch (e) { return sendError(res, e, 'Failed to fetch bank transactions'); }
    });

    // POST /transactions/:id/approve { amount? (rupees override), notes? } — admin or employee label
    // approve_bank_txns (tenant-scoped). Exactly-once; credits the ledger; see the header choreography.
    router.post('/transactions/:id/approve', authenticateAdminOrLabel('approve_bank_txns'), async (req, res) => {
        try {
            const id = String(req.params.id);
            const txn = await getTxn(id);
            await assertReviewerScope(req, txn);
            if (txn.status !== 'pending') throw fail(409, `Transaction already ${txn.status}`);
            const override = req.body.amount == null || req.body.amount === '' ? null : toPaise(req.body.amount);
            if (req.body.amount != null && req.body.amount !== '' && override == null) throw fail(400, 'Invalid amount');
            const reviewNotes = req.body.notes == null ? null : String(req.body.notes).trim().slice(0, 500) || null;

            const result = await withAccountLock(txn.bankAcId, LOCK_TTL_LEDGER, () => withLock(`lock:bankac:review:${id}`, LOCK_TTL_REVIEW, async () => {
                const fresh = await getTxn(id);
                if (fresh.status !== 'pending') throw fail(409, `Transaction already ${fresh.status}`);
                const account = await findAccount(fresh.bankAcId);
                if (!account) throw fail(404, 'Bank account not found.');
                const approvedAmountPaise = override ?? Number(fresh.amountPaise);
                const at = nowIso();
                // COMMIT POINT — flip first, so a crash after this can never credit twice on retry.
                // created_at (the ledger/T+1 day) is the approval instant: the admin verified it now, and a
                // user-supplied paidAt can never backdate money into "withdrawable today".
                const approved = await databases.updateDocument(DB, TXNS, id, {
                    status: 'approved', approvedAmountPaise, reviewedBy: req.user.userId, reviewedAt: at, reviewNotes, created_at: at,
                });
                const ledger = await adjustLedger(fresh.bankAcId, approvedAmountPaise, 1);
                if (!ledger) console.error(`CRITICAL: bank txn ${id} approved but ledger credit of ${approvedAmountPaise} paise to ${fresh.bankAcId} failed — reconcile manually`);
                try { await bumpDailyTotal(fresh.bankAcId, at, approvedAmountPaise); }
                catch (e) { console.error(`bank-acs: daily summary update failed for ${fresh.bankAcId} (${approvedAmountPaise} paise):`, e?.message || e); }
                bumpRedisCounters(1, approvedAmountPaise);
                await inc('totalBankAcTxPendingCount', -1); await inc('totalBankAcTxPendingAmount', -Number(fresh.amountPaise || 0));
                return { approved, account, ledger };
            }, 'Transaction is being resolved. Please try again.'));

            const warning = await warnDailyLimit(result.account, result.approved);
            notify('approved', result.approved, req.user);
            return res.json({ success: true, transaction: pickTxn(result.approved), ledgerUpdated: !!result.ledger, dailyLimitWarning: warning,
                bankAccount: result.ledger ? pickAccount(result.ledger) : null });
        } catch (e) { return sendError(res, e, 'Failed to approve transaction'); }
    });

    // POST /transactions/:id/reject { reason } — same auth as approve. Nothing is credited.
    router.post('/transactions/:id/reject', authenticateAdminOrLabel('approve_bank_txns'), async (req, res) => {
        try {
            const id = String(req.params.id);
            const reason = String(req.body.reason || '').trim();
            if (reason.length < 4) throw fail(400, 'Invalid ID or reason too short');
            const txn = await getTxn(id);
            await assertReviewerScope(req, txn);
            if (txn.status !== 'pending') throw fail(409, `Transaction already ${txn.status}`);
            const rejected = await withLock(`lock:bankac:review:${id}`, LOCK_TTL_REVIEW, async () => {
                const fresh = await getTxn(id);
                if (fresh.status !== 'pending') throw fail(409, `Transaction already ${fresh.status}`);
                return databases.updateDocument(DB, TXNS, id, { status: 'rejected', rejectReason: reason.slice(0, 300), reviewedBy: req.user.userId, reviewedAt: nowIso() });
            }, 'Transaction is being resolved. Please try again.');
            await inc('totalBankAcTxPendingCount', -1); await inc('totalBankAcTxPendingAmount', -Number(txn.amountPaise || 0));
            notify('rejected', rejected, req.user);
            return res.json({ success: true, transaction: pickTxn(rejected) });
        } catch (e) { return sendError(res, e, 'Failed to reject transaction'); }
    });

    // POST /transactions/:id/cancel — the requesting user withdraws a still-pending claim.
    router.post('/transactions/:id/cancel', authenticateToken, async (req, res) => {
        try {
            const id = String(req.params.id);
            const txn = await getTxn(id);
            if (req.user.role !== 'admin' && txn.userId !== req.user.userId && txn.requestedBy !== req.user.userId) throw fail(403, 'You can only cancel your own payment claims');
            if (txn.status !== 'pending') throw fail(409, `Transaction already ${txn.status}`);
            const cancelled = await withLock(`lock:bankac:review:${id}`, LOCK_TTL_REVIEW, async () => {
                const fresh = await getTxn(id);
                if (fresh.status !== 'pending') throw fail(409, `Transaction already ${fresh.status}`);
                return databases.updateDocument(DB, TXNS, id, { status: 'cancelled', reviewedBy: req.user.userId, reviewedAt: nowIso() });
            }, 'Transaction is being resolved. Please try again.');
            await inc('totalBankAcTxPendingCount', -1); await inc('totalBankAcTxPendingAmount', -Number(txn.amountPaise || 0));
            notify('cancelled', cancelled, req.user);
            return res.json({ success: true, transaction: pickTxn(cancelled) });
        } catch (e) { return sendError(res, e, 'Failed to cancel transaction'); }
    });

    // DELETE /transactions/:id — admin undoes a WRONG approval: soft-delete with full ledger reversal under
    // the account lock; 409 if the money was already withdrawn. Pending claims are rejected, not deleted.
    router.delete('/transactions/:id', authenticateAdmin, async (req, res) => {
        try {
            const id = String(req.params.id);
            const txn = await getTxn(id);
            if (txn.deleted === true) throw fail(400, 'Transaction is already deleted');
            if (txn.status !== 'approved') throw fail(400, `Only approved transactions can be deleted; this one is ${txn.status}. Use reject for pending claims.`);
            const deleted = await withAccountLock(txn.bankAcId, LOCK_TTL_DELETE, async () => {
                const fresh = await getTxn(id);
                if (fresh.deleted === true || fresh.status !== 'approved') throw fail(409, 'Transaction changed while deleting; reload and retry');
                const amountPaise = Number(fresh.approvedAmountPaise ?? fresh.amountPaise ?? 0);
                const ledger = await adjustLedger(fresh.bankAcId, -amountPaise, -1);   // throws 409 on a negative result
                if (!ledger) throw fail(500, 'Ledger reversal failed; nothing was deleted');
                try { await bumpDailyTotal(fresh.bankAcId, fresh.created_at || fresh.reviewedAt || fresh.createdAt, -amountPaise); }
                catch (e) { console.error(`bank-acs: daily summary reversal failed for ${fresh.bankAcId} (-${amountPaise} paise):`, e?.message || e); }
                bumpRedisCounters(-1, -amountPaise);   // before the flag flips, so a Redis failure leaves the row intact for a retry
                return databases.updateDocument(DB, TXNS, id, { deleted: true, deletedBy: req.user.userId, deletedAt: nowIso(),
                    reviewNotes: `${fresh.reviewNotes ? fresh.reviewNotes + ' | ' : ''}deleted: ${String(req.body?.reason || '').trim().slice(0, 200)}`.slice(0, 500) });
            });
            notify('deleted', deleted, req.user);
            return res.json({ success: true, transaction: pickTxn(deleted) });
        } catch (e) { return sendError(res, e, 'Failed to delete transaction'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // REPORTS
    // ═══════════════════════════════════════════════════════════════════════════

    async function reportRange(req) {
        const todayStr = istDay(), yesterdayStr = moment.tz('Asia/Kolkata').subtract(1, 'day').format('YYYY-MM-DD');
        const from = req.query.from || todayStr, to = req.query.to || todayStr;
        const start = moment.tz(from, 'Asia/Kolkata'), end = moment.tz(to, 'Asia/Kolkata');
        if (!start.isValid() || !end.isValid() || end.isBefore(start)) throw fail(400, 'Invalid date range');
        if (end.diff(start, 'days') > 366) throw fail(400, 'Range too large (max 366 days)');
        const allowed = await scopeAccountIds(req.user, req.query.userId || null, req.query.bankAcId ? String(req.query.bankAcId).trim() : null);
        const filterBank = String(req.query.bankName || '').trim().toLowerCase() || null;
        const bankOf = {};
        for (const d of await listAll(ACCOUNTS)) bankOf[d.bankAcId] = String(d.bankName || '').trim() || '(no bank)';
        const days = []; for (const c = start.clone(); c.isSameOrBefore(end, 'day'); c.add(1, 'day')) days.push(c.format('YYYY-MM-DD'));
        const visible = (id) => (!allowed || allowed.includes(id)) && (!filterBank || (bankOf[id] || '(no bank)').toLowerCase() === filterBank);
        return { todayStr, yesterdayStr, days, visible, bankOf: (id) => bankOf[id] || '(no bank)' };
    }

    // GET /payin-summary?from&to&userId&bankAcId&bankName — day-wise pay-in per account, grouped by bank.
    router.get('/payin-summary', authenticateToken, async (req, res) => {
        try {
            const { todayStr, yesterdayStr, days: dayKeys, visible, bankOf } = await reportRange(req);
            const days = []; const rangeBanks = {}; let grandTotalPaise = 0, todayPaise = 0, yesterdayPaise = 0;
            for (const date of dayKeys) {
                const totals = await settlement.todayPayIns(date);
                let dayTotal = 0; const bankAccounts = {}, banks = {};
                for (const [id, paise] of Object.entries(totals)) {
                    if (!visible(id)) continue;
                    const amount = parseInt(paise || 0, 10);
                    bankAccounts[id] = amount; dayTotal += amount;
                    const b = bankOf(id); banks[b] = (banks[b] || 0) + amount; rangeBanks[b] = (rangeBanks[b] || 0) + amount;
                }
                days.push({ date, totalPaise: dayTotal, totalRs: dayTotal / 100, bankAccounts, banks });
                grandTotalPaise += dayTotal;
                if (date === todayStr) todayPaise = dayTotal;
                if (date === yesterdayStr) yesterdayPaise = dayTotal;
            }
            return res.json({ days, grandTotalPaise, grandTotalRs: grandTotalPaise / 100, todayPaise, todayRs: todayPaise / 100, yesterdayPaise, yesterdayRs: yesterdayPaise / 100,
                banks: Object.entries(rangeBanks).sort((a, b) => b[1] - a[1]).map(([bankName, totalPaise]) => ({ bankName, totalPaise, totalRs: totalPaise / 100 })) });
        } catch (e) { return sendError(res, e, 'Failed to fetch bank payin summary'); }
    });

    // GET /withdrawal-summary?from&to&userId&bankAcId&bankName&mode=direct|wallet — the withdrawal twin.
    router.get('/withdrawal-summary', authenticateToken, async (req, res) => {
        try {
            const mode = req.query.mode ? String(req.query.mode) : null;
            if (mode && !wdSummary.MODES.includes(mode)) throw fail(400, 'Invalid mode. Must be direct or wallet.');
            const modes = mode ? [mode] : wdSummary.MODES;
            const { todayStr, yesterdayStr, days: dayKeys, visible, bankOf } = await reportRange(req);
            const { emptyRow, addRow } = wdSummary;
            const newAgg = () => ({ ...emptyRow(), direct: emptyRow(), wallet: emptyRow() });
            const fold = (agg, day) => { for (const m of modes) { addRow(agg, day?.[m]); addRow(agg[m], day?.[m]); } return agg; };
            const withRs = (row) => ({ ...row, totalPaise: row.paidPaise, totalRs: row.paidPaise / 100, commissionRs: row.commissionPaise / 100 });
            const days = [], grand = newAgg(), rangeBanks = {}; let todayPaise = 0, yesterdayPaise = 0;
            for (const date of dayKeys) {
                const totals = await wdSummary.readDay(date);
                const dayAgg = newAgg(), bankAccounts = {}, banks = {};
                for (const [id, entry] of Object.entries(totals)) {
                    if (!visible(id)) continue;
                    const row = fold(newAgg(), entry);
                    if (!row.count) continue;
                    bankAccounts[id] = row;
                    const b = bankOf(id);
                    fold(banks[b] = banks[b] || newAgg(), entry); fold(rangeBanks[b] = rangeBanks[b] || newAgg(), entry);
                    fold(dayAgg, entry); fold(grand, entry);
                }
                days.push({ date, totalPaise: dayAgg.paidPaise, totalRs: dayAgg.paidPaise / 100, commissionPaise: dayAgg.commissionPaise, commissionRs: dayAgg.commissionPaise / 100,
                    count: dayAgg.count, direct: dayAgg.direct, wallet: dayAgg.wallet, bankAccounts, banks });
                if (date === todayStr) todayPaise = dayAgg.paidPaise;
                if (date === yesterdayStr) yesterdayPaise = dayAgg.paidPaise;
            }
            return res.json({ days, grandTotalPaise: grand.paidPaise, grandTotalRs: grand.paidPaise / 100, grandCommissionPaise: grand.commissionPaise, grandCommissionRs: grand.commissionPaise / 100,
                grandCount: grand.count, direct: grand.direct, wallet: grand.wallet, todayPaise, todayRs: todayPaise / 100, yesterdayPaise, yesterdayRs: yesterdayPaise / 100,
                banks: Object.entries(rangeBanks).sort((a, b) => b[1].paidPaise - a[1].paidPaise).map(([bankName, row]) => ({ bankName, ...withRs(row) })) });
        } catch (e) { return sendError(res, e, 'Failed to fetch bank withdrawal summary'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // T+0 EARLY RELEASE (admin role only — mirrors /api/admin/qr-settlement/*)
    // ═══════════════════════════════════════════════════════════════════════════
    const dayParam = (v) => (DAY_RE.test(String(v || '')) ? String(v) : settlement.istDay());

    router.get('/releases', authenticateAdmin, async (req, res) => {
        try {
            const day = dayParam(req.query.date), limit = parseLimit(req.query.limit);
            const r = await settlement.listReleases({ day, id: req.query.bankAcId ? String(req.query.bankAcId).trim() : null, limit, cursor: cursorQuery(req.query.cursor).length ? req.query.cursor : null });
            const docs = r.documents || [];
            return res.json({ success: true, date: day, maxPercent: settlement.maxPercent(), total: r.total, releases: docs.map(settlement.pickRelease),
                totalReleasedPaise: docs.reduce((s, d) => s + Number(d.releasedPaise || 0), 0), nextCursor: docs.length === limit ? docs[docs.length - 1].$id : null });
        } catch (e) { return sendError(res, e, 'Failed to fetch bank account releases'); }
    });
    router.get('/:bankAcId/settlement', authenticateAdmin, async (req, res) => {
        try {
            const day = dayParam(req.query.date);
            const ac = await findAccount(String(req.params.bankAcId).trim());
            if (!ac) throw fail(404, 'Bank account not found.');
            const settle = await settlement.forQrDocs([ac], day);
            return res.json({ success: true, ...settle.rows[0], maxPercent: settle.maxPercent, assignedUserId: ac.assignedUserId || null, release: settlement.pickRelease(await settlement.getRelease(ac.bankAcId, day)) });
        } catch (e) { return sendError(res, e, 'Failed to fetch bank account settlement'); }
    });
    router.put('/:bankAcId/release', authenticateAdmin, async (req, res) => {
        try {
            const day = dayParam(req.body.date);
            const ac = await findAccount(String(req.params.bankAcId).trim());
            if (!ac) throw fail(404, 'Bank account not found.');
            const given = (v) => v !== undefined && v !== null && v !== '';
            const rsToPaise = (v, label) => { const n = Number(v); if (!isFinite(n) || n < 0) throw fail(400, `Invalid ${label}`); return Math.round(n * 100); };
            const saved = await settlement.setRelease({ ID, id: ac.bankAcId, releasedPaise: given(req.body.amount) ? rsToPaise(req.body.amount, 'amount') : null,
                addPaise: given(req.body.addAmount) ? rsToPaise(req.body.addAmount, 'addAmount') : null, percent: req.body.percent,
                expectedTodayPayInPaise: req.body.expectedTodayPayInPaise, expectedReleasedPaise: req.body.expectedReleasedPaise, reason: req.body.reason, byUserId: req.user.userId, day,
                chargeCommission: req.body.chargeCommission }); // optional: false = no early-release fee on this release
            const settle = await settlement.forQrDocs([ac], day);
            return res.json({ success: true, message: 'Release updated', ...settle.rows[0], maxPercent: settle.maxPercent, release: settlement.pickRelease(saved) });
        } catch (e) { return sendError(res, e, 'Failed to update bank account release'); }
    });
    router.delete('/:bankAcId/release', authenticateAdmin, async (req, res) => {
        try {
            const day = dayParam(req.query.date);
            const ac = await findAccount(String(req.params.bankAcId).trim());
            if (!ac) throw fail(404, 'Bank account not found.');
            const saved = await settlement.setRelease({ ID, id: ac.bankAcId, releasedPaise: 0, reason: String(req.body?.reason || 'Release revoked'), byUserId: req.user.userId, day });
            const settle = await settlement.forQrDocs([ac], day);
            return res.json({ success: true, message: 'Release revoked', ...settle.rows[0], maxPercent: settle.maxPercent, release: settlement.pickRelease(saved) });
        } catch (e) { return sendError(res, e, 'Failed to revoke bank account release'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // HOLD-AND-RESET (admin) — archive "<id>" as "<id>_hold[N]", stand up a fresh empty account under the
    // same number, and move EVERY reference (bank_transactions included — the set is bounded because every
    // row is hand-approved, so the QR path's out-of-band migration job is not needed here). Holds
    // lock:bankac:<id> for the whole run so no approve/withdrawal can write mid-move. Idempotent and
    // resumable: a retry finishes an interrupted run. Body: { dryRun, confirm, allowIncrement, allowPending }.
    // ═══════════════════════════════════════════════════════════════════════════
    async function resolveHoldSlots(src) {
        const slotId = (n) => (n <= 1 ? `${src}_hold` : `${src}_hold${n}`);
        let highest = null, n = 1;
        while (n < 1000) { const doc = await findAccount(slotId(n)); if (!doc) break; highest = { n, id: slotId(n), doc }; n++; }
        return { highest, nextId: slotId(n) };
    }
    router.post('/:bankAcId/hold-and-reset', authenticateAdmin, async (req, res) => {
        const src = String(req.params.bankAcId || '').trim();
        const dryRun = req.body?.dryRun === true, allowIncrement = req.body?.allowIncrement === true, allowPending = req.body?.allowPending === true;
        try {
            if (!src) throw fail(400, 'bankAcId is required');
            if (isHoldId(src)) throw fail(400, 'bankAcId is already a _hold id');
            if (!dryRun && req.body?.confirm !== true) throw fail(400, 'Refusing to run without confirm:true. Use dryRun:true to preview.');

            const countBy = async (col, extra = []) => (await databases.listDocuments(DB, col, [Query.equal('bankAcId', src), ...extra, Query.limit(1)])).total;
            let holdId = null;
            const repointField = async (col, label, extra = []) => {
                let moved = 0;
                for (let page = 0; page < 100000; page++) {
                    const r = await databases.listDocuments(DB, col, [Query.equal('bankAcId', src), ...extra, Query.limit(100)]);
                    if (!r.documents.length) break;
                    let progressed = 0;
                    for (const doc of r.documents) {
                        try { await databases.updateDocument(DB, col, doc.$id, { bankAcId: holdId }); moved++; progressed++; }
                        catch (e) { console.error(`bank hold-and-reset: failed to re-point ${label} doc ${doc.$id}:`, e.message); }
                    }
                    if (!progressed) throw new Error(`Could not re-point any ${label} docs (all updates failing) — aborting`);
                }
                return moved;
            };
            const moveDailyKeys = async () => {
                let moved = 0, cursor = null;
                for (let page = 0; page < 100000; page++) {
                    const q = [Query.orderAsc('$id'), Query.limit(100)]; if (cursor) q.push(Query.cursorAfter(cursor));
                    const r = await databases.listDocuments(DB, DAILY, q);
                    if (!r.documents.length) break;
                    for (const doc of r.documents) {
                        let obj; try { obj = JSON.parse(doc.totalsJson || '{}'); } catch { console.error(`bank hold-and-reset: CORRUPT totalsJson in ${DAILY} doc ${doc.$id} — skipping`); continue; }
                        if (!Object.prototype.hasOwnProperty.call(obj, src)) continue;
                        await withDayLock(doc.date, async () => {
                            const fresh = await databases.getDocument(DB, DAILY, doc.$id);
                            let f; try { f = JSON.parse(fresh.totalsJson || '{}'); } catch { console.error(`bank hold-and-reset: CORRUPT totalsJson (locked) in doc ${doc.$id} — skipping`); return; }
                            if (!Object.prototype.hasOwnProperty.call(f, src)) return;
                            f[holdId] = Number(f[holdId] || 0) + Number(f[src] || 0); delete f[src];
                            await databases.updateDocument(DB, DAILY, doc.$id, { totalsJson: JSON.stringify(f) }); moved++;
                        });
                    }
                    cursor = r.documents[r.documents.length - 1].$id;
                    if (r.documents.length < 100) break;
                }
                return moved;
            };

            let srcDoc = await findAccount(src);
            const { highest, nextId } = await resolveHoldSlots(src);
            let holdDoc = null, isRepeatReset = false;
            if (!srcDoc) {
                if (!highest) throw fail(404, `Bank account "${src}" not found.`);
                holdId = highest.id; holdDoc = highest.doc;            // finish an interrupted run
            } else if (!highest) {
                holdId = nextId;
            } else {
                isRepeatReset = true; holdId = nextId;
                if (!dryRun && !allowIncrement) {
                    return res.status(409).json({ needsHoldConfirmation: true, existingHoldId: highest.id, nextHoldId: nextId,
                        message: `Bank account "${src}" was already archived to "${highest.id}". To reset it again, its current history will be archived to "${nextId}".`,
                        hint: 'Re-send with { confirm:true, allowIncrement:true } to proceed.' });
                }
            }

            if (dryRun) {
                const [transactions, pendingTxns, withdrawals, releases] = await Promise.all([
                    countBy(TXNS), countBy(TXNS, [Query.equal('status', 'pending')]), countBy(WITHDRAWALS), settlement.repointReleases(src, holdId, { dryRun: true }).then((r) => r.scanned),
                ]);
                return res.json({ dryRun: true, sourceBankAcId: src, holdBankAcId: holdId,
                    state: { finishingInterruptedRun: !srcDoc, isRepeatReset, needsHoldConfirmation: isRepeatReset && !allowIncrement, needsPendingConfirmation: pendingTxns > 0 && !allowPending, existingHoldId: highest ? highest.id : null },
                    willMove: { transactions, pendingTxns, withdrawalRequests: withdrawals, releases, note: 'daily pay-in and withdrawal summary keys are moved day-by-day; counts are reported on the real run.' },
                    sourceAccount: srcDoc ? pickAccount(srcDoc) : null });
            }

            const report = await withAccountLock(src, LOCK_TTL_HOLD_RESET, async () => {
                const rep = { sourceBankAcId: src, holdBankAcId: holdId, isRepeatReset, finishingInterruptedRun: !srcDoc, steps: {} };
                const pending = await countBy(TXNS, [Query.equal('status', 'pending')]);
                if (pending > 0 && !allowPending) {
                    throw fail(409, `Bank account "${src}" has ${pending} payment claim(s) still pending. Approve or reject them first so none can be credited to the fresh account mid-reset.`,
                        { body: { needsPendingConfirmation: true, pendingTxns: pending, hint: 'Re-send with { confirm:true, allowPending:true } to reset anyway — they will be moved to the hold and credit the archived ledger when approved.' } });
                }
                rep.steps.pendingTxnsAtStart = pending;
                if (!holdDoc) {
                    await databases.updateDocument(DB, ACCOUNTS, srcDoc.$id, { bankAcId: holdId, isActive: false });
                    holdDoc = { ...srcDoc, bankAcId: holdId, isActive: false }; srcDoc = null; rep.steps.archivedAccountDoc = true;
                    await inc('bankAcsActive', -1); await inc('bankAcsDisabled', 1);
                }
                if (!srcDoc) {
                    srcDoc = await databases.createDocument(DB, ACCOUNTS, ID.unique(), {
                        bankAcId: src, bankName: holdDoc.bankName, accountHolderName: holdDoc.accountHolderName, ifscCode: holdDoc.ifscCode, accountType: holdDoc.accountType,
                        upiId: holdDoc.upiId || null, notes: holdDoc.notes || null, perTxnLimitPaise: Number(holdDoc.perTxnLimitPaise || 0), dailyLimitPaise: Number(holdDoc.dailyLimitPaise || 0),
                        isActive: true, assignedUserId: null, managedByUserId: null, createdByUserId: req.user.userId, createdAt: nowIso(),
                        totalTransactions: 0, totalPayInAmount: 0, withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 0, amountAvailableForWithdrawal: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0,
                    });
                    rep.steps.createdFreshAccountDoc = true;
                    await inc('totalBankAcsUploaded', 1); await inc('bankAcsActive', 1);
                }
                rep.steps.transactionsMoved = await repointField(TXNS, 'bank-transaction');   // ALL rows, pending included — bounded
                rep.steps.withdrawalRequestsMoved = await repointField(WITHDRAWALS, 'withdrawal-request');
                rep.steps.dailySummaryDocsMoved = await moveDailyKeys();
                rep.steps.releasesMoved = await settlement.repointReleases(src, holdId);
                rep.steps.withdrawalSummaryDocsMoved = await wdSummary.repoint(src, holdId);
                return rep;
            }, 423);
            return res.json({ success: true, message: `Bank account "${src}" archived to "${holdId}" and reset to a fresh, unassigned account.`, ...report });
        } catch (e) {
            if (e?.status) return sendError(res, e, 'hold-and-reset failed');
            console.error('❌ bank hold-and-reset error:', e.message || e);
            return res.status(500).json({ error: e.message || 'hold-and-reset failed', hint: 'The operation is idempotent — retry the same request; a missing fresh account is auto-detected and the interrupted run is finished.' });
        }
    });

    return router;
};
