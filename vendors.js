// vendors.js — Vendor accounts: a self-contained channel where VENDORS (users_meta role 'vendor', created by
// admin) list their own bank accounts. Mounted at /api/vendors (server.js). It never reads or writes
// qr_codes, bank_accounts, webhook_data, withdrawal_requests, commission_transactions or the dashboard
// counters — nothing here shows up in the existing pay-in / payout / netFlow figures, and vice versa.
// Frontend contract: VENDORS_FRONTEND.md. Schema: scripts/setup-vendor-schema.js.
//
//   vendor_rate_cards        one doc per accountType ($id `rc_<type>`): adminPercent, vendorPercent,
//                            salePricePaise, rentPerMonthPaise — copied onto an account at approval
//   vendor_accounts          listing + state + limits + copied rates + assignment + the ledger (paise):
//                            totalTransactions, totalPayInAmount, withdrawalRequestedAmount,
//                            withdrawalCompletedAmount, commissionOnHold, adminCommissionEarned,
//                            vendorCommissionEarned, amountAvailableForWithdrawal (DERIVED, never set directly)
//   vendor_transactions      merchant pay-in claims; the VENDOR approves (he sees his own statement)
//   vendor_withdrawals       merchant withdrawals the VENDOR pays: requested → paid (UTR) → completed
//                            (merchant confirms) | disputed → admin resolves
//   vendor_commissions       one row per completed withdrawal per earner ('admin' | 'vendor')
//   vendor_earnings          rent / sale payments admin marked paid (period 'sale' or 'YYYY-MM'; unique per account)
//   vendor_audit             admin overrides and resolutions
//   daily_vendor_summaries   { date, totalsJson: { accountId: { payInPaise, payoutPaise, adminCommissionPaise, vendorCommissionPaise, count } } }
//
// Modes: 'commission' accounts take claims and withdrawals and earn fees on every completed withdrawal
// (adminFee + vendorFee on top of what the merchant receives, both ceil'd paise). 'sell' / 'rent' accounts
// are listing-only: never assigned, no claims, no withdrawals — they only accrue the vendor's sale price /
// monthly rent (due is computed on read; admin marks payments).
//
// Money is withdrawable the moment a claim is approved (no T+1 here).
//
// Locks (all fail closed — a Redis error counts as busy):
//   lock:vendorac:<accountId>          every ledger write and every withdrawal state change (one key, so a
//                                      cancel can never race a confirm on the same withdrawal)
//   lock:vendorac:review:<txnId>       exactly-once claim resolution (inside the account lock when crediting)
//   lock:vendorac:ref:<referenceNumber> duplicate-UTR guard on claim submit
//   lock:vendorac:daily:<day>          daily_vendor_summaries RMW (report-only; failure logged, never fails a request)
//   lock:vendorearn:<accountId>        rent/sale payment recording
//
// Positional factory (server.js mount + tests/vendors.test.js must match; append only):
//   1 databases, 2 ID, 3 Query, 4 DB, 5 USERS_META, 6 cols { rateCards, accounts, txns, withdrawals,
//   commissions, earnings, audit, daily }, 7 redisClient, 8 authenticateToken, 9 authenticateAdmin

const express = require('express');
const moment = require('moment-timezone');
const userMetaCache = require('./userMetaCache');

const ACCOUNT_RE = /^[A-Za-z0-9]{6,24}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_RE = /^[a-zA-Z0-9.\-_+]+@[a-zA-Z0-9]+$/;
const REF_RE = /^[A-Z0-9-]{6,40}$/;
const UTR_RE = /^[A-Za-z0-9-]{5,40}$/;
const CURSOR_RE = /^[a-zA-Z0-9_:-]{1,255}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;
const ACCOUNT_TYPES = ['savings', 'current', 'corporate'];
const MODES = ['commission', 'sell', 'rent'];
const STATES = ['under_review', 'rejected', 'active', 'inactive', 'sold', 'rented', 'rent_ended', 'delisted'];
const LIVE_STATES = ['under_review', 'active', 'inactive', 'sold', 'rented', 'rent_ended']; // the account number is taken
const TXN_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'reversed'];
const WD_STATUSES = ['requested', 'cancelled', 'rejected', 'paid', 'disputed', 'completed', 'reversed'];
const OPEN_WD = ['requested', 'paid', 'disputed'];
const LEDGER = ['totalTransactions', 'totalPayInAmount', 'withdrawalRequestedAmount', 'withdrawalCompletedAmount', 'commissionOnHold', 'adminCommissionEarned', 'vendorCommissionEarned'];
const DAILY_KEYS = ['payInPaise', 'payoutPaise', 'adminCommissionPaise', 'vendorCommissionPaise', 'count'];
const BUSY_ACCOUNT = 'Vendor account is currently being processed. Please try again in a moment.';

// server.js authenticateToken: a vendor login may use /api/vendors only — every other route family was
// written for admin/subadmin/employee/user and treats an unknown role unpredictably.
const VENDOR_PATH_RE = /^\/api\/vendors(\/|\?|$)/;
const isVendorBlocked = (role, url) => role === 'vendor' && !VENDOR_PATH_RE.test(String(url || ''));

// Rent is due at the START of each monthly period, counted from rentStartDate (IST), until rentEndDate.
function rentPeriodsDue(d, now = new Date()) {
    if (!d.rentStartDate || !(Number(d.rentPerMonthPaise) > 0)) return [];
    const start = moment.tz(d.rentStartDate, 'Asia/Kolkata');
    const end = moment.tz(d.rentEndDate || now, 'Asia/Kolkata');
    const out = [];
    for (let k = 0; k < 1200; k++) {
        const p = start.clone().add(k, 'months');
        if (p.isAfter(end)) break;
        out.push(p.format('YYYY-MM'));
    }
    return out;
}
const feeFor = (amountPaise, percent) => Math.ceil(amountPaise * Math.round(Number(percent || 0) * 100) / 10000); // integer math, rounded up

function vendorsRouter(databases, ID, Query, DB, USERS_META, cols, redisClient, authenticateToken, authenticateAdmin) {
    const router = express.Router();

    // ─── helpers ───────────────────────────────────────────────────────────────
    function fail(status, message, extra) { return Object.assign(new Error(message), { status, ...(extra || {}) }); }
    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
    }
    function sendError(res, err, fallback) {
        if (err?.status) return res.status(err.status).json({ error: err.message, ...(err.body || {}) });
        if (isCursorError(err)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
        console.error(`❌ vendors: ${fallback}:`, err);
        return res.status(500).json({ error: fallback });
    }
    const only = (...roles) => (req, res, next) => (roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Not authorized for this action.' }));
    const parseLimit = (q, cap = 100) => Math.min(Math.max(parseInt(q ?? 25, 10) || 25, 1), cap);
    function cursorQuery(cursor) {
        if (!cursor) return [];
        if (!CURSOR_RE.test(cursor)) throw fail(400, 'Invalid cursor format');
        return [Query.cursorAfter(cursor)];
    }
    const page = (docs, limit) => (docs.length === limit ? docs[docs.length - 1].$id : null);
    const nowIso = () => moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');
    const istDay = (ts = new Date()) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');
    const dayBounds = (d, edge) => { if (!DAY_RE.test(d)) throw fail(400, 'Dates must be YYYY-MM-DD'); return moment.tz(d, 'Asia/Kolkata')[edge]('day').utc().toISOString(); };
    const toPaise = (v) => { const n = Number(v); return v !== '' && v != null && isFinite(n) && n > 0 ? Math.round(n * 100) : null; };
    const toLimitPaise = (v) => { const n = Number(v); return v !== '' && v != null && isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
    const toPercent = (v) => { const n = Number(v); return v !== '' && v != null && isFinite(n) && n >= 0 && n <= 100 ? n : null; };
    const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
    const rs = (p) => (p == null ? null : Number(p) / 100);

    const RELEASE_LOCK = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
    async function withLock(key, ttl, fn, busyMessage, busyStatus = 409) {
        const val = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let acquired = false;
        try { acquired = (await redisClient.set(key, val, { NX: true, EX: ttl })) === 'OK'; }
        catch (e) { console.error(`vendors lock error for ${key} (failing closed):`, e.message); }
        if (!acquired) throw fail(busyStatus, busyMessage);
        try { return await fn(); }
        finally {
            try { await redisClient.eval(RELEASE_LOCK, { keys: [key], arguments: [val] }); }
            catch (e) { console.error(`releaseLock failed for ${key} — lock will expire after TTL:`, e.message); }
        }
    }
    const withAccountLock = (accountId, ttl, fn) => withLock(`lock:vendorac:${accountId}`, ttl, fn, BUSY_ACCOUNT);
    async function withDayLock(day, fn) {
        const key = `lock:vendorac:daily:${day}`;
        const val = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let acquired = false;
        for (let i = 0; i < 20 && !acquired; i++) {
            acquired = (await redisClient.set(key, val, { NX: true, EX: 10 }).catch(() => null)) === 'OK';
            if (!acquired) await new Promise((r) => setTimeout(r, 50 + i * 40));
        }
        if (!acquired) throw new Error(`Could not acquire ${key}`);
        try { return await fn(); }
        finally { await redisClient.eval(RELEASE_LOCK, { keys: [key], arguments: [val] }).catch(() => {}); }
    }

    async function listAll(col, queries = [], maxPages = 100) {
        const out = []; let cursor = null;
        for (let p = 0; p < maxPages; p++) {
            const q = [...queries, Query.orderAsc('$id'), Query.limit(100)];
            if (cursor) q.push(Query.cursorAfter(cursor));
            const r = await databases.listDocuments(DB, col, q);
            out.push(...r.documents);
            if (r.documents.length < 100) break;
            cursor = r.documents[r.documents.length - 1].$id;
        }
        return out;
    }
    async function getDoc(col, id, notFound) {
        if (!CURSOR_RE.test(String(id || ''))) throw fail(404, notFound);
        try { return await databases.getDocument(DB, col, String(id)); }
        catch (e) { if (e?.code === 404) throw fail(404, notFound); throw e; }
    }
    const getAccount = (id) => getDoc(cols.accounts, id, 'Vendor account not found.');
    const getTxn = (id) => getDoc(cols.txns, id, 'Transaction not found');
    const getWithdrawal = (id) => getDoc(cols.withdrawals, id, 'Withdrawal not found');
    const count = async (col, filters) => (await databases.listDocuments(DB, col, [...filters, Query.limit(1)])).total;
    async function getRateCard(type) {
        try { return await databases.getDocument(DB, cols.rateCards, `rc_${type}`); }
        catch (e) { if (e?.code === 404) return null; throw e; }
    }

    // ─── ledger (paise) ────────────────────────────────────────────────────────
    const ledgerOf = (d) => Object.fromEntries(LEDGER.map((k) => [k, Number(d[k] || 0)]));
    const availableOf = (l) => l.totalPayInAmount - l.withdrawalRequestedAmount - l.withdrawalCompletedAmount - l.commissionOnHold - l.adminCommissionEarned - l.vendorCommissionEarned;
    // Fresh read → add deltas → recompute available → write. Callers hold lock:vendorac:<id>. Refuses (409)
    // any result with a negative field or a negative available. Transport errors retry 3× then throw.
    async function applyLedger(accountId, deltas) {
        for (let attempt = 1; ; attempt++) {
            try {
                const doc = await databases.getDocument(DB, cols.accounts, accountId);
                const l = ledgerOf(doc);
                for (const [k, v] of Object.entries(deltas)) l[k] += v;
                const available = availableOf(l);
                if (available < 0 || Object.values(l).some((v) => v < 0)) {
                    throw fail(409, 'This change would take the vendor account balance negative.', { body: { currentAvailablePaise: Number(doc.amountAvailableForWithdrawal || 0) } });
                }
                const patch = { amountAvailableForWithdrawal: available };
                for (const k of Object.keys(deltas)) patch[k] = l[k];
                return await databases.updateDocument(DB, cols.accounts, accountId, patch);
            } catch (e) {
                if (e.status || attempt >= 3) throw e;
                await new Promise((r) => setTimeout(r, 50));
            }
        }
    }
    // Post-commit ledger write: the status already flipped, so a failure is logged for manual repair.
    async function applyLedgerAfterCommit(accountId, deltas, what) {
        try { return await applyLedger(accountId, deltas); }
        catch (e) { console.error(`CRITICAL: vendors ledger write failed after commit (${what}) on ${accountId} ${JSON.stringify(deltas)} — reconcile manually:`, e?.message || e); return null; }
    }
    // daily_vendor_summaries[day][accountId] += delta. Report-only: never throws.
    async function bumpDaily(accountId, iso, delta) {
        const day = istDay(iso);
        try {
            await withDayLock(day, async () => {
                const doc = (await databases.listDocuments(DB, cols.daily, [Query.equal('date', day), Query.limit(1)])).documents[0];
                let totals = {};
                if (doc) { try { totals = JSON.parse(doc.totalsJson || '{}') || {}; } catch { throw new Error(`Corrupt totalsJson for ${day} — manual fix required`); } }
                const row = totals[accountId] || {};
                for (const [k, v] of Object.entries(delta)) {
                    row[k] = Number(row[k] || 0) + v;
                    if (row[k] < 0) throw new Error(`${k} would go negative`);
                }
                totals[accountId] = row;
                if (doc) await databases.updateDocument(DB, cols.daily, doc.$id, { totalsJson: JSON.stringify(totals) });
                else await databases.createDocument(DB, cols.daily, ID.unique(), { date: day, totalsJson: JSON.stringify(totals) });
            });
        } catch (e) { console.error(`CRITICAL: vendors daily summary ${day} ${accountId} ${JSON.stringify(delta)} not recorded:`, e?.message || e); }
    }
    async function audit(entityType, entityId, action, req, reason) {
        try { await databases.createDocument(DB, cols.audit, ID.unique(), { entityType, entityId, action, actorId: req.user.userId, reason: text(reason, 500), createdAt: nowIso() }); }
        catch (e) { console.error('vendors audit write failed:', e?.message || e); }
    }

    // ─── projections (who sees what) ───────────────────────────────────────────
    // A vendor never sees merchant identities; a merchant / subadmin never sees the vendor or the fee split.
    const HIDE = {
        vendor: ['assignedUserId', 'managedByUserId', 'userId', 'ownerSubadminId', 'requestedBy', 'reviewedBy', 'resolvedBy'],
        subadmin: ['vendorId', 'adminPercent', 'vendorPercent', 'adminCommissionEarned', 'vendorCommissionEarned', 'adminFeePaise', 'vendorFeePaise',
            'salePricePaise', 'salePriceRs', 'rentPerMonthPaise', 'rentPerMonthRs', 'rentStartDate', 'rentEndDate', 'reviewedBy', 'resolvedBy', 'delistRequested'],
    };
    HIDE.user = HIDE.subadmin;
    const view = (obj, role) => { for (const k of HIDE[role] || []) delete obj[k]; return obj; };
    const pickAccount = (d, role) => {
        const l = ledgerOf(d);
        return view({
            $id: d.$id, accountNumber: d.accountNumber, bankName: d.bankName || null, accountHolderName: d.accountHolderName || null,
            ifscCode: d.ifscCode || null, accountType: d.accountType, upiId: d.upiId || null, notes: d.notes || null, mode: d.mode, state: d.state,
            vendorId: d.vendorId, assignedUserId: d.assignedUserId || null, managedByUserId: d.managedByUserId || null,
            minTxnPaise: Number(d.minTxnPaise || 0), minTxnRs: rs(d.minTxnPaise || 0),
            perTxnLimitPaise: Number(d.perTxnLimitPaise || 0), perTxnLimitRs: rs(d.perTxnLimitPaise || 0),
            dailyLimitPaise: Number(d.dailyLimitPaise || 0), dailyLimitRs: rs(d.dailyLimitPaise || 0),
            adminPercent: d.adminPercent ?? null, vendorPercent: d.vendorPercent ?? null,
            feePercent: d.mode === 'commission' ? Number(d.adminPercent || 0) + Number(d.vendorPercent || 0) : null,
            salePricePaise: d.salePricePaise ?? null, salePriceRs: rs(d.salePricePaise), rentPerMonthPaise: d.rentPerMonthPaise ?? null, rentPerMonthRs: rs(d.rentPerMonthPaise),
            rentStartDate: d.rentStartDate || null, rentEndDate: d.rentEndDate || null,
            reviewedBy: d.reviewedBy || null, reviewedAt: d.reviewedAt || null, rejectReason: d.rejectReason || null,
            delistRequested: d.delistRequested === true, createdAt: d.createdAt || null,
            ...l, feesPaidPaise: l.adminCommissionEarned + l.vendorCommissionEarned,
            amountAvailableForWithdrawal: Number(d.amountAvailableForWithdrawal || 0), amountAvailableForWithdrawalRs: rs(d.amountAvailableForWithdrawal || 0),
        }, role);
    };
    const pickTxn = (d, role) => view({
        $id: d.$id, accountId: d.accountId, vendorId: d.vendorId, userId: d.userId, ownerSubadminId: d.ownerSubadminId || null, requestedBy: d.requestedBy || null,
        referenceNumber: d.referenceNumber, amountPaise: Number(d.amountPaise || 0), amountRs: rs(d.amountPaise || 0),
        approvedAmountPaise: d.approvedAmountPaise ?? null, approvedAmountRs: rs(d.approvedAmountPaise),
        payerName: d.payerName || null, paidAt: d.paidAt || null, remarks: d.remarks || null, status: d.status,
        reviewedBy: d.reviewedBy || null, reviewedAt: d.reviewedAt || null, reviewNotes: d.reviewNotes || null, rejectReason: d.rejectReason || null,
        approvedAt: d.approvedAt || null, reversedAt: d.reversedAt || null, createdAt: d.createdAt || null,
    }, role);
    const pickWithdrawal = (d, role) => view({
        $id: d.$id, accountId: d.accountId, vendorId: d.vendorId, userId: d.userId, ownerSubadminId: d.ownerSubadminId || null,
        amountPaise: Number(d.amountPaise || 0), amountRs: rs(d.amountPaise || 0),
        feePaise: Number(d.adminFeePaise || 0) + Number(d.vendorFeePaise || 0), feeRs: rs(Number(d.adminFeePaise || 0) + Number(d.vendorFeePaise || 0)),
        adminFeePaise: Number(d.adminFeePaise || 0), vendorFeePaise: Number(d.vendorFeePaise || 0), adminPercent: d.adminPercent ?? null, vendorPercent: d.vendorPercent ?? null,
        totalPaise: Number(d.totalPaise || 0), totalRs: rs(d.totalPaise || 0),
        mode: d.mode, holderName: d.holderName || null, payeeAccountNumber: d.payeeAccountNumber || null, ifscCode: d.ifscCode || null, upiId: d.upiId || null,
        status: d.status, utr: d.utr || null, paidAt: d.paidAt || null, confirmedAt: d.confirmedAt || null, completedAt: d.completedAt || null,
        disputeReason: d.disputeReason || null, rejectReason: d.rejectReason || null, resolveReason: d.resolveReason || null, resolvedBy: d.resolvedBy || null,
        createdAt: d.createdAt || null,
    }, role);

    const pickEarning = (d) => ({ $id: d.$id, accountId: d.accountId, vendorId: d.vendorId, type: d.type, period: d.period,
        amountPaise: Number(d.amountPaise || 0), amountRs: rs(d.amountPaise || 0), utr: d.utr || null, notes: d.notes || null, paidAt: d.paidAt || null });

    // ─── scoping ───────────────────────────────────────────────────────────────
    function scopeQueries(user, kind) {   // kind: 'account' | 'row' (claims and withdrawals)
        switch (user.role) {
            case 'admin': return [];
            case 'vendor': return [Query.equal('vendorId', user.userId)];
            case 'subadmin': return [Query.equal(kind === 'account' ? 'managedByUserId' : 'ownerSubadminId', user.userId)];
            case 'user': return [Query.equal(kind === 'account' ? 'assignedUserId' : 'userId', user.userId)];
            default: throw fail(403, 'Not authorized for this action.');
        }
    }
    function canSeeAccount(user, d) {
        return user.role === 'admin' || (user.role === 'vendor' && d.vendorId === user.userId)
            || (user.role === 'subadmin' && d.managedByUserId === user.userId) || (user.role === 'user' && d.assignedUserId === user.userId);
    }
    function dateRange(q, field) {
        if (q.from && q.to) return [Query.between(field, dayBounds(q.from, 'startOf'), dayBounds(q.to, 'endOf'))];
        if (q.from) return [Query.greaterThanEqual(field, dayBounds(q.from, 'startOf'))];
        if (q.to) return [Query.lessThanEqual(field, dayBounds(q.to, 'endOf'))];
        return [];
    }

    // ─── summaries ─────────────────────────────────────────────────────────────
    // Rent/sale due vs paid, per account and totalled.
    function earningsOf(accounts, rows, now = new Date()) {
        const paidBy = {};
        for (const r of rows) paidBy[r.accountId] = (paidBy[r.accountId] || 0) + Number(r.amountPaise || 0);
        const perAccount = {};
        const totals = { saleDuePaise: 0, salePaidPaise: 0, rentDuePaise: 0, rentPaidPaise: 0 };
        for (const a of accounts) {
            if (a.mode === 'commission' || !['sold', 'rented', 'rent_ended'].includes(a.state)) continue;
            const isSale = a.mode === 'sell';
            const due = isSale ? Number(a.salePricePaise || 0) : rentPeriodsDue(a, now).length * Number(a.rentPerMonthPaise || 0);
            const paid = paidBy[a.$id] || 0;
            perAccount[a.$id] = { duePaise: due, paidPaise: paid, outstandingPaise: due - paid, periodsDue: isSale ? null : rentPeriodsDue(a, now) };
            totals[isSale ? 'saleDuePaise' : 'rentDuePaise'] += due;
            totals[isSale ? 'salePaidPaise' : 'rentPaidPaise'] += paid;
        }
        totals.outstandingPaise = totals.saleDuePaise + totals.rentDuePaise - totals.salePaidPaise - totals.rentPaidPaise;
        return { perAccount, totals };
    }
    // Every figure derives from the ledgers, day summaries and earnings rows — no counters to drift.
    async function buildSummary({ vendorId = null, from, to }) {
        const byVendor = vendorId ? [Query.equal('vendorId', vendorId)] : [];
        const accounts = await listAll(cols.accounts, byVendor);
        const sum = (k) => accounts.reduce((s, a) => s + Number(a[k] || 0), 0);
        const accountsByState = Object.fromEntries(STATES.map((s) => [s, 0]));
        for (const a of accounts) accountsByState[a.state] = (accountsByState[a.state] || 0) + 1;
        const [requested, paid, disputed] = await Promise.all(OPEN_WD.map((s) => count(cols.withdrawals, [...byVendor, Query.equal('status', s)])));
        const pendingClaims = await count(cols.txns, [...byVendor, Query.equal('status', 'pending')]);
        const earnings = earningsOf(accounts, await listAll(cols.earnings, byVendor));
        const payIn = sum('totalPayInAmount'), payout = sum('withdrawalCompletedAmount');
        const out = {
            accounts: { total: accounts.length, byState: accountsByState },
            payInPaise: payIn, payInRs: rs(payIn), payoutPaise: payout, payoutRs: rs(payout),
            pendingPayoutPaise: sum('withdrawalRequestedAmount'), pendingPayoutRs: rs(sum('withdrawalRequestedAmount')),
            pendingPayouts: { requested, paid, disputed, total: requested + paid + disputed },
            pendingClaims,
            adminCommissionPaise: sum('adminCommissionEarned'), adminCommissionRs: rs(sum('adminCommissionEarned')),
            vendorCommissionPaise: sum('vendorCommissionEarned'), vendorCommissionRs: rs(sum('vendorCommissionEarned')),
            merchantBalancePaise: sum('amountAvailableForWithdrawal'), merchantBalanceRs: rs(sum('amountAvailableForWithdrawal')),
            // Everything that came in minus what merchants actually received: merchant balances + both fees,
            // all physically sitting in vendors' banks.
            heldByVendorsPaise: payIn - payout, heldByVendorsRs: rs(payIn - payout),
            rentSale: earnings.totals,
            range: null,
        };
        if (from || to) {
            const f = from || to, t = to || from;
            if (!DAY_RE.test(f) || !DAY_RE.test(t)) throw fail(400, 'Dates must be YYYY-MM-DD');
            if (f > t) throw fail(400, 'from must be on or before to');
            if (moment(t).diff(moment(f), 'days') > 366) throw fail(400, 'Date range cannot exceed 366 days');
            const ids = new Set(accounts.map((a) => a.$id));
            const range = { from: f, to: t, ...Object.fromEntries(DAILY_KEYS.map((k) => [k, 0])) };
            for (const d of await listAll(cols.daily, [Query.greaterThanEqual('date', f), Query.lessThanEqual('date', t)], 5)) {
                let totals = {};
                try { totals = JSON.parse(d.totalsJson || '{}') || {}; } catch { continue; }
                for (const [id, row] of Object.entries(totals)) if (ids.has(id)) for (const k of DAILY_KEYS) range[k] += Number(row[k] || 0);
            }
            out.range = range;
        }
        return { summary: out, accounts, earnings };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PROFILE + RATE CARD
    // ═══════════════════════════════════════════════════════════════════════════

    // GET /me — the caller's own profile (a vendor login can reach nothing outside /api/vendors).
    router.get('/me', authenticateToken, (req, res) => {
        const u = req.user;
        return res.json({ userId: u.userId, name: u.name || null, email: u.email || null, role: u.role, status: u.status !== false });
    });

    router.get('/rate-cards', authenticateToken, only('admin', 'vendor'), async (req, res) => {
        try {
            const r = await databases.listDocuments(DB, cols.rateCards, [Query.limit(10)]);
            const rateCards = r.documents.map((d) => ({
                accountType: d.accountType, adminPercent: d.adminPercent ?? null, vendorPercent: d.vendorPercent ?? null,
                salePricePaise: d.salePricePaise ?? null, salePriceRs: rs(d.salePricePaise), rentPerMonthPaise: d.rentPerMonthPaise ?? null, rentPerMonthRs: rs(d.rentPerMonthPaise),
                updatedAt: d.updatedAt || null,
            })).map((c) => (req.user.role === 'vendor' ? view(c, 'vendor') : c));
            return res.json({ rateCards });
        } catch (e) { return sendError(res, e, 'Failed to fetch rate cards'); }
    });

    // PUT /admin/rate-cards/:accountType { adminPercent?, vendorPercent?, salePrice?, rentPerMonth? } — upsert
    // on the deterministic $id rc_<type> (two admins can never mint duplicates). Money in rupees.
    router.put('/admin/rate-cards/:accountType', authenticateAdmin, async (req, res) => {
        try {
            const type = String(req.params.accountType || '').toLowerCase();
            if (!ACCOUNT_TYPES.includes(type)) throw fail(400, `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`);
            const patch = {};
            for (const k of ['adminPercent', 'vendorPercent']) if (req.body[k] !== undefined) { const p = toPercent(req.body[k]); if (p == null) throw fail(400, `Invalid ${k} (0–100)`); patch[k] = p; }
            for (const [k, f] of [['salePrice', 'salePricePaise'], ['rentPerMonth', 'rentPerMonthPaise']]) if (req.body[k] !== undefined) { const p = toLimitPaise(req.body[k]); if (p == null) throw fail(400, `Invalid ${k} (rupees)`); patch[f] = p; }
            if (!Object.keys(patch).length) throw fail(400, 'Send at least one of adminPercent, vendorPercent, salePrice, rentPerMonth');
            patch.updatedAt = nowIso(); patch.updatedBy = req.user.userId;
            let doc;
            try { doc = await databases.createDocument(DB, cols.rateCards, `rc_${type}`, { accountType: type, adminPercent: null, vendorPercent: null, salePricePaise: null, rentPerMonthPaise: null, ...patch }); }
            catch (e) { if (e?.code !== 409) throw e; doc = await databases.updateDocument(DB, cols.rateCards, `rc_${type}`, patch); }
            return res.json({ message: 'Rate card saved.', rateCard: { accountType: type, adminPercent: doc.adminPercent ?? null, vendorPercent: doc.vendorPercent ?? null, salePricePaise: doc.salePricePaise ?? null, rentPerMonthPaise: doc.rentPerMonthPaise ?? null } });
        } catch (e) { return sendError(res, e, 'Failed to save rate card'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCOUNTS
    // ═══════════════════════════════════════════════════════════════════════════

    function validateAccount(body, { partial = false, admin = false } = {}) {
        const out = {};
        const has = (k) => body[k] !== undefined;
        if (!partial || has('bankName')) { const v = String(body.bankName || '').trim(); if (!v || v.length > 100) throw fail(400, 'bankName is required (max 100 chars)'); out.bankName = v; }
        if (!partial || has('accountHolderName')) { const v = String(body.accountHolderName || '').trim(); if (!v || v.length > 120) throw fail(400, 'accountHolderName is required (max 120 chars)'); out.accountHolderName = v; }
        if (!partial || has('ifscCode')) { const v = String(body.ifscCode || '').trim().toUpperCase(); if (!IFSC_RE.test(v)) throw fail(400, 'Invalid IFSC code format (e.g. SBIN0001234)'); out.ifscCode = v; }
        if (!partial || has('accountType')) { const v = String(body.accountType || '').trim().toLowerCase(); if (!ACCOUNT_TYPES.includes(v)) throw fail(400, `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`); out.accountType = v; }
        if (!partial || has('mode')) { const v = String(body.mode || '').trim().toLowerCase(); if (!MODES.includes(v)) throw fail(400, `mode must be one of: ${MODES.join(', ')}`); out.mode = v; }
        if (has('upiId')) { const v = text(body.upiId, 100); if (v && !UPI_RE.test(v)) throw fail(400, 'Invalid UPI ID format (expected handle@provider)'); out.upiId = v; }
        if (has('notes')) out.notes = text(body.notes, 500);
        for (const [k, f] of [['minTxn', 'minTxnPaise'], ['perTxnLimit', 'perTxnLimitPaise'], ['dailyLimit', 'dailyLimitPaise']]) {
            if (has(k)) { const p = toLimitPaise(body[k]); if (p == null) throw fail(400, `Invalid ${k} (rupees, 0 = no limit)`); out[f] = p; }
        }
        if (admin) {
            for (const k of ['adminPercent', 'vendorPercent']) if (has(k)) { const p = toPercent(body[k]); if (p == null) throw fail(400, `Invalid ${k} (0–100)`); out[k] = p; }
            for (const [k, f] of [['salePrice', 'salePricePaise'], ['rentPerMonth', 'rentPerMonthPaise']]) if (has(k)) { const p = toLimitPaise(body[k]); if (p == null) throw fail(400, `Invalid ${k} (rupees)`); out[f] = p; }
        }
        return out;
    }
    function assertLimits(d) {
        if (Number(d.minTxnPaise) > 0 && Number(d.perTxnLimitPaise) > 0 && Number(d.minTxnPaise) > Number(d.perTxnLimitPaise)) throw fail(400, 'minTxn cannot be above perTxnLimit');
    }

    // POST /accounts — a vendor lists an account. Born under_review; admin approves.
    router.post('/accounts', authenticateToken, only('vendor'), async (req, res) => {
        try {
            const accountNumber = String(req.body.accountNumber ?? '').trim();
            if (!ACCOUNT_RE.test(accountNumber)) throw fail(400, 'Invalid accountNumber: 6–24 letters/digits');
            const fields = validateAccount(req.body);
            const doc = { minTxnPaise: 0, perTxnLimitPaise: 0, dailyLimitPaise: 0, upiId: null, notes: null, ...fields };
            assertLimits(doc);
            const dup = await count(cols.accounts, [Query.equal('accountNumber', accountNumber), Query.equal('state', LIVE_STATES)]);
            if (dup > 0) throw fail(409, 'This account number is already listed.');
            const created = await databases.createDocument(DB, cols.accounts, ID.unique(), {
                accountNumber, ...doc, vendorId: req.user.userId, state: 'under_review',
                adminPercent: null, vendorPercent: null, salePricePaise: null, rentPerMonthPaise: null, rentStartDate: null, rentEndDate: null,
                assignedUserId: null, managedByUserId: null, delistRequested: false, createdAt: nowIso(),
                ...Object.fromEntries(LEDGER.map((k) => [k, 0])), amountAvailableForWithdrawal: 0,
            });
            return res.status(201).json({ message: 'Account submitted for review.', account: pickAccount(created, 'vendor') });
        } catch (e) { return sendError(res, e, 'Failed to list account'); }
    });

    // GET /accounts — role-scoped. ?state ?mode ?accountType ?vendorId(admin) ?limit ?cursor
    router.get('/accounts', authenticateToken, async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const q = scopeQueries(req.user, 'account');
            for (const [k, list] of [['state', STATES], ['mode', MODES], ['accountType', ACCOUNT_TYPES]]) {
                if (req.query[k]) { const v = String(req.query[k]).toLowerCase(); if (!list.includes(v)) throw fail(400, `Invalid ${k}. Must be one of: ${list.join(', ')}`); q.push(Query.equal(k, v)); }
            }
            if (req.query.vendorId && req.user.role === 'admin') q.push(Query.equal('vendorId', String(req.query.vendorId)));
            q.push(Query.orderDesc('createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit));
            const r = await databases.listDocuments(DB, cols.accounts, q);
            return res.json({ accounts: r.documents.map((d) => pickAccount(d, req.user.role)), nextCursor: page(r.documents, limit) });
        } catch (e) { return sendError(res, e, 'Failed to fetch vendor accounts'); }
    });

    router.get('/accounts/:id', authenticateToken, async (req, res) => {
        try {
            const d = await getAccount(req.params.id);
            if (!canSeeAccount(req.user, d)) throw fail(404, 'Vendor account not found.');
            return res.json({ account: pickAccount(d, req.user.role) });
        } catch (e) { return sendError(res, e, 'Failed to fetch vendor account'); }
    });

    // PATCH /accounts/:id — the vendor while under_review (details, limits, mode); admin any time before
    // rejected/delisted (plus rates). The account number is immutable.
    router.patch('/accounts/:id', authenticateToken, only('admin', 'vendor'), async (req, res) => {
        try {
            if (req.body.accountNumber !== undefined) throw fail(400, 'accountNumber cannot be changed; list a new account instead');
            const isAdmin = req.user.role === 'admin';
            const fields = validateAccount(req.body, { partial: true, admin: isAdmin });
            if (!Object.keys(fields).length) throw fail(400, 'Nothing to update');
            if (!isAdmin && (await getAccount(req.params.id)).vendorId !== req.user.userId) throw fail(404, 'Vendor account not found.');
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (!isAdmin && d.vendorId !== req.user.userId) throw fail(404, 'Vendor account not found.');
                if (!isAdmin && d.state !== 'under_review') throw fail(409, 'Approved accounts can only be changed by admin.');
                if (['rejected', 'delisted'].includes(d.state)) throw fail(409, `Account is ${d.state}`);
                if ((fields.mode && fields.mode !== d.mode) || (fields.accountType && fields.accountType !== d.accountType)) {
                    if (d.state !== 'under_review') throw fail(409, 'mode and accountType can only change while the account is under review');
                }
                assertLimits({ ...d, ...fields });
                return databases.updateDocument(DB, cols.accounts, d.$id, fields);
            });
            return res.json({ message: 'Vendor account updated.', account: pickAccount(updated, req.user.role) });
        } catch (e) { return sendError(res, e, 'Failed to update vendor account'); }
    });

    // POST /accounts/:id/delist-request — the owning vendor asks admin to delist.
    router.post('/accounts/:id/delist-request', authenticateToken, only('vendor'), async (req, res) => {
        try {
            const d = await getAccount(req.params.id);
            if (d.vendorId !== req.user.userId) throw fail(404, 'Vendor account not found.');
            if (['rejected', 'delisted'].includes(d.state)) throw fail(409, `Account is ${d.state}`);
            await databases.updateDocument(DB, cols.accounts, d.$id, { delistRequested: true, delistRequestedAt: nowIso() });
            return res.json({ message: 'Delist requested. Admin will process it.' });
        } catch (e) { return sendError(res, e, 'Failed to request delist'); }
    });

    // POST /admin/accounts/:id/approve { adminPercent?, vendorPercent?, salePrice?, rentPerMonth? } — copies the
    // rate card (overrides win) onto the account; commission → active, sell → sold, rent → rented.
    router.post('/admin/accounts/:id/approve', authenticateAdmin, async (req, res) => {
        try {
            const overrides = validateAccount(req.body, { partial: true, admin: true });
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (d.state !== 'under_review') throw fail(409, `Account is ${d.state}`);
                const card = await getRateCard(d.accountType);
                const rate = (k) => overrides[k] ?? card?.[k] ?? null;
                const patch = { reviewedBy: req.user.userId, reviewedAt: nowIso(), rejectReason: null };
                if (d.mode === 'commission') {
                    patch.adminPercent = rate('adminPercent'); patch.vendorPercent = rate('vendorPercent');
                    if (patch.adminPercent == null || patch.vendorPercent == null) throw fail(400, `No commission rates for ${d.accountType}: set the rate card or send adminPercent and vendorPercent`);
                    patch.state = 'active';
                } else if (d.mode === 'sell') {
                    patch.salePricePaise = rate('salePricePaise');
                    if (!(patch.salePricePaise > 0)) throw fail(400, `No sale price for ${d.accountType}: set the rate card or send salePrice`);
                    patch.state = 'sold';
                } else {
                    patch.rentPerMonthPaise = rate('rentPerMonthPaise');
                    if (!(patch.rentPerMonthPaise > 0)) throw fail(400, `No monthly rent for ${d.accountType}: set the rate card or send rentPerMonth`);
                    patch.state = 'rented'; patch.rentStartDate = nowIso();
                }
                return databases.updateDocument(DB, cols.accounts, d.$id, patch);
            });
            await audit('account', updated.$id, 'approve', req, null);
            return res.json({ message: 'Account approved.', account: pickAccount(updated, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to approve account'); }
    });

    router.post('/admin/accounts/:id/reject', authenticateAdmin, async (req, res) => {
        try {
            const reason = String(req.body.reason || '').trim();
            if (reason.length < 4) throw fail(400, 'Reason too short');
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (d.state !== 'under_review') throw fail(409, `Account is ${d.state}`);
                return databases.updateDocument(DB, cols.accounts, d.$id, { state: 'rejected', rejectReason: reason.slice(0, 300), reviewedBy: req.user.userId, reviewedAt: nowIso() });
            });
            await audit('account', updated.$id, 'reject', req, reason);
            return res.json({ message: 'Account rejected.', account: pickAccount(updated, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to reject account'); }
    });

    // PUT /admin/accounts/:id/status { active: boolean } — commission accounts only: active ⇄ inactive.
    router.put('/admin/accounts/:id/status', authenticateAdmin, async (req, res) => {
        try {
            if (typeof req.body.active !== 'boolean') throw fail(400, "Invalid value for 'active'.");
            const next = req.body.active ? 'active' : 'inactive';
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (!['active', 'inactive'].includes(d.state)) throw fail(409, `Account is ${d.state}`);
                return d.state === next ? d : databases.updateDocument(DB, cols.accounts, d.$id, { state: next });
            });
            return res.json({ message: 'Account status updated.', account: pickAccount(updated, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to update account status'); }
    });

    // POST /admin/accounts/:id/delist { reason? } — refuses while money or claims are open on the account.
    router.post('/admin/accounts/:id/delist', authenticateAdmin, async (req, res) => {
        try {
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (!['under_review', 'active', 'inactive'].includes(d.state)) throw fail(409, d.state === 'rented' ? 'End the rental instead.' : `Account is ${d.state}`);
                const l = ledgerOf(d);
                if (availableOf(l) > 0 || l.withdrawalRequestedAmount > 0 || l.commissionOnHold > 0) throw fail(409, 'Cannot delist: the account still holds a merchant balance or open withdrawals.');
                const pending = await count(cols.txns, [Query.equal('accountId', d.$id), Query.equal('status', 'pending')]);
                if (pending > 0) throw fail(409, `Cannot delist: ${pending} payment claim(s) are still pending.`);
                return databases.updateDocument(DB, cols.accounts, d.$id, { state: 'delisted', assignedUserId: null, managedByUserId: null, delistRequested: false });
            });
            await audit('account', updated.$id, 'delist', req, req.body?.reason);
            return res.json({ message: 'Account delisted.', account: pickAccount(updated, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to delist account'); }
    });

    router.post('/admin/accounts/:id/end-rental', authenticateAdmin, async (req, res) => {
        try {
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (d.state !== 'rented') throw fail(409, `Account is ${d.state}`);
                return databases.updateDocument(DB, cols.accounts, d.$id, { state: 'rent_ended', rentEndDate: nowIso() });
            });
            await audit('account', updated.$id, 'end_rental', req, req.body?.reason);
            return res.json({ message: 'Rental ended.', account: pickAccount(updated, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to end rental'); }
    });

    // The ledger is per ACCOUNT, so whoever is assigned owns its balance: never hand a funded account to
    // somebody else.
    async function assertNoOpenMoney(d) {
        const l = ledgerOf(d);
        if (availableOf(l) > 0 || l.withdrawalRequestedAmount > 0 || l.commissionOnHold > 0) {
            throw fail(409, `This account still holds ₹${(availableOf(l) / 100).toFixed(2)} available and ₹${(l.withdrawalRequestedAmount / 100).toFixed(2)} in open withdrawals for its current merchant. Settle it before reassigning.`);
        }
        const pending = await count(cols.txns, [Query.equal('accountId', d.$id), Query.equal('status', 'pending')]);
        if (pending > 0) throw fail(409, `Cannot reassign: ${pending} payment claim(s) are still pending.`);
    }

    // PUT /admin/accounts/:id/assign-manager { managedByUserId | null } — admin only.
    router.put('/admin/accounts/:id/assign-manager', authenticateAdmin, async (req, res) => {
        try {
            const raw = req.body.managedByUserId;
            const managedByUserId = raw === '' || raw == null ? null : String(raw);
            if (managedByUserId) {
                const m = await userMetaCache.getUserMeta(managedByUserId).catch(() => null);
                if (!m || m.role !== 'subadmin') throw fail(400, 'Manager must be an existing subadmin.');
            }
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (!['active', 'inactive'].includes(d.state)) throw fail(409, `Only commission accounts that are active or inactive can be assigned (this one is ${d.state}).`);
                if (d.assignedUserId && managedByUserId !== d.managedByUserId) {
                    const assignee = await userMetaCache.getUserMeta(d.assignedUserId).catch(() => null);
                    const stays = managedByUserId && (d.assignedUserId === managedByUserId || assignee?.parentId === managedByUserId);
                    if (!stays) throw fail(409, 'Unassign the merchant first: they are not under the new subadmin.');
                }
                return databases.updateDocument(DB, cols.accounts, d.$id, { managedByUserId });
            });
            await audit('account', updated.$id, managedByUserId ? 'assign_manager' : 'unassign_manager', req, managedByUserId);
            return res.json({ message: 'Manager updated.', account: pickAccount(updated, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to update manager'); }
    });

    // PUT /accounts/:id/assign-user { assignedUserId | null } — admin, or the managing subadmin for their own merchants.
    router.put('/accounts/:id/assign-user', authenticateToken, only('admin', 'subadmin'), async (req, res) => {
        try {
            const raw = req.body.assignedUserId;
            const assignedUserId = raw === '' || raw == null ? null : String(raw);
            if (req.user.role === 'subadmin' && (await getAccount(req.params.id)).managedByUserId !== req.user.userId) throw fail(404, 'Vendor account not found.');
            const updated = await withAccountLock(String(req.params.id), 15, async () => {
                const d = await getAccount(req.params.id);
                if (req.user.role === 'subadmin' && d.managedByUserId !== req.user.userId) throw fail(404, 'Vendor account not found.');
                if (!['active', 'inactive'].includes(d.state)) throw fail(409, `Account is ${d.state}`);
                if (!d.managedByUserId) throw fail(409, 'Assign the account to a subadmin first.');
                if ((d.assignedUserId || null) === assignedUserId) return d;
                if (assignedUserId) {
                    const u = await userMetaCache.getUserMeta(assignedUserId).catch(() => null);
                    // Merchants (role 'user') only: withdraw/confirm/cancel are merchant actions, so any other
                    // assignee would leave the account's money with nobody able to withdraw it.
                    if (!u || !(u.role === 'user' && u.parentId === d.managedByUserId)) throw fail(409, 'Merchant is not under this account’s subadmin.');
                }
                if (d.assignedUserId) await assertNoOpenMoney(d);
                return databases.updateDocument(DB, cols.accounts, d.$id, { assignedUserId });
            });
            return res.json({ message: 'Merchant updated.', account: pickAccount(updated, req.user.role) });
        } catch (e) { return sendError(res, e, 'Failed to update merchant'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // PAY-IN CLAIMS
    // ═══════════════════════════════════════════════════════════════════════════

    async function todayUsagePaise(accountId) {
        const day = istDay();
        const docs = await listAll(cols.txns, [Query.equal('accountId', accountId), Query.equal('status', ['pending', 'approved']), Query.between('createdAt', dayBounds(day, 'startOf'), dayBounds(day, 'endOf'))], 5);
        return docs.reduce((s, d) => s + Number(d.approvedAmountPaise ?? d.amountPaise ?? 0), 0);
    }

    // POST /accounts/:id/transactions — the assigned merchant (or their subadmin, or admin) says "I paid".
    router.post('/accounts/:id/transactions', authenticateToken, only('admin', 'subadmin', 'user'), async (req, res) => {
        try {
            const a = await getAccount(req.params.id);
            if (!canSeeAccount(req.user, a)) throw fail(404, 'Vendor account not found.');
            if (a.state !== 'active') throw fail(400, 'Vendor account is not active');
            if (!a.assignedUserId) throw fail(409, 'Vendor account is not assigned to any merchant');
            const referenceNumber = String(req.body.referenceNumber ?? '').trim().toUpperCase();
            if (!REF_RE.test(referenceNumber)) throw fail(400, 'Invalid referenceNumber (6–40 letters, digits or dashes)');
            const amountPaise = toPaise(req.body.amount);
            if (amountPaise == null) throw fail(400, 'Invalid amount');
            if (Number(a.minTxnPaise) > 0 && amountPaise < Number(a.minTxnPaise)) throw fail(422, `Amount is below this account's minimum of ₹${(Number(a.minTxnPaise) / 100).toFixed(2)}`);
            if (Number(a.perTxnLimitPaise) > 0 && amountPaise > Number(a.perTxnLimitPaise)) throw fail(422, `Amount exceeds this account's per-transaction limit of ₹${(Number(a.perTxnLimitPaise) / 100).toFixed(2)}`);
            let paidAt = null;
            if (req.body.paidAt != null && req.body.paidAt !== '') {
                const d = new Date(req.body.paidAt);
                if (isNaN(d.getTime()) || d.getTime() > Date.now() + 5 * 60 * 1000) throw fail(400, 'Invalid paidAt (ISO date, not in the future)');
                paidAt = d.toISOString();
            }
            const created = await withLock(`lock:vendorac:ref:${referenceNumber}`, 15, async () => {
                const dup = await count(cols.txns, [Query.equal('referenceNumber', referenceNumber), Query.equal('status', ['pending', 'approved'])]);
                if (dup > 0) throw fail(409, 'Reference number already used');
                return databases.createDocument(DB, cols.txns, ID.unique(), {
                    accountId: a.$id, vendorId: a.vendorId, userId: a.assignedUserId, ownerSubadminId: a.managedByUserId || null, requestedBy: req.user.userId,
                    referenceNumber, amountPaise, approvedAmountPaise: null, payerName: text(req.body.payerName, 120), paidAt, remarks: text(req.body.remarks, 500),
                    status: 'pending', createdAt: nowIso(),
                });
            }, 'This reference number is being processed. Please try again.');
            let dailyLimitWarning = null;
            if (Number(a.dailyLimitPaise) > 0) {   // WARNS only — the claim is already accepted
                const usedPaise = await todayUsagePaise(a.$id).catch(() => 0);
                if (usedPaise > Number(a.dailyLimitPaise)) dailyLimitWarning = { dailyLimitPaise: Number(a.dailyLimitPaise), usedPaise };
            }
            return res.status(201).json({ success: true, transaction: pickTxn(created, req.user.role), dailyLimitWarning });
        } catch (e) { return sendError(res, e, 'Failed to submit payment claim'); }
    });

    router.get('/transactions', authenticateToken, async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const q = scopeQueries(req.user, 'row');
            if (req.query.accountId) q.push(Query.equal('accountId', String(req.query.accountId)));
            if (req.query.status) {
                if (!TXN_STATUSES.includes(String(req.query.status))) throw fail(400, `Invalid status. Must be one of: ${TXN_STATUSES.join(', ')}`);
                q.push(Query.equal('status', String(req.query.status)));
            }
            q.push(...dateRange(req.query, 'createdAt'), Query.orderDesc('$createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit));
            const r = await databases.listDocuments(DB, cols.txns, q);
            return res.json({ transactions: r.documents.map((d) => pickTxn(d, req.user.role)), nextCursor: page(r.documents, limit) });
        } catch (e) { return sendError(res, e, 'Failed to fetch vendor transactions'); }
    });

    // Credit a claim exactly once: account lock (outer) → review lock (inner) → re-read → proceed only from
    // `fromStatus` → flip status FIRST (commit point) → ledger → daily summary.
    async function creditClaim(id, fromStatus, req, overridePaise, notes) {
        const txn = await getTxn(id);
        return withAccountLock(txn.accountId, 15, () => withLock(`lock:vendorac:review:${id}`, 20, async () => {
            const fresh = await getTxn(id);
            if (fresh.status !== fromStatus) throw fail(409, `Transaction already ${fresh.status}`);
            const amountPaise = overridePaise ?? Number(fresh.amountPaise);
            const at = nowIso();
            const approved = await databases.updateDocument(DB, cols.txns, id, {
                status: 'approved', approvedAmountPaise: amountPaise, approvedAt: at, reviewedBy: req.user.userId, reviewedAt: at, reviewNotes: notes, rejectReason: null,
            });
            const ledger = await applyLedgerAfterCommit(fresh.accountId, { totalPayInAmount: amountPaise, totalTransactions: 1 }, `claim ${id} approve`);
            await bumpDaily(fresh.accountId, at, { payInPaise: amountPaise, count: 1 });
            return { approved, ledger };
        }, 'Transaction is being resolved. Please try again.'));
    }
    const assertClaimOwner = async (req, id) => {
        const txn = await getTxn(id);
        if (req.user.role === 'vendor' && txn.vendorId !== req.user.userId) throw fail(404, 'Transaction not found');
        return txn;
    };

    // POST /transactions/:id/approve { amount? (rupees — what the statement shows), notes? } — the owning vendor, or admin.
    router.post('/transactions/:id/approve', authenticateToken, only('admin', 'vendor'), async (req, res) => {
        try {
            const id = String(req.params.id);
            await assertClaimOwner(req, id);
            const override = req.body.amount == null || req.body.amount === '' ? null : toPaise(req.body.amount);
            if (req.body.amount != null && req.body.amount !== '' && override == null) throw fail(400, 'Invalid amount');
            const r = await creditClaim(id, 'pending', req, override, text(req.body.notes, 500));
            if (req.user.role === 'admin') await audit('transaction', id, 'approve', req, req.body.notes);
            return res.json({ success: true, transaction: pickTxn(r.approved, req.user.role), ledgerUpdated: !!r.ledger });
        } catch (e) { return sendError(res, e, 'Failed to approve transaction'); }
    });

    router.post('/transactions/:id/reject', authenticateToken, only('admin', 'vendor'), async (req, res) => {
        try {
            const id = String(req.params.id);
            const reason = String(req.body.reason || '').trim();
            if (reason.length < 4) throw fail(400, 'Reason too short');
            await assertClaimOwner(req, id);
            const rejected = await withLock(`lock:vendorac:review:${id}`, 20, async () => {
                const fresh = await getTxn(id);
                if (fresh.status !== 'pending') throw fail(409, `Transaction already ${fresh.status}`);
                return databases.updateDocument(DB, cols.txns, id, { status: 'rejected', rejectReason: reason.slice(0, 300), reviewedBy: req.user.userId, reviewedAt: nowIso() });
            }, 'Transaction is being resolved. Please try again.');
            if (req.user.role === 'admin') await audit('transaction', id, 'reject', req, reason);
            return res.json({ success: true, transaction: pickTxn(rejected, req.user.role) });
        } catch (e) { return sendError(res, e, 'Failed to reject transaction'); }
    });

    router.post('/transactions/:id/cancel', authenticateToken, only('admin', 'subadmin', 'user'), async (req, res) => {
        try {
            const id = String(req.params.id);
            const txn = await getTxn(id);
            if (req.user.role !== 'admin' && txn.userId !== req.user.userId && txn.requestedBy !== req.user.userId) throw fail(403, 'You can only cancel your own payment claims');
            const cancelled = await withLock(`lock:vendorac:review:${id}`, 20, async () => {
                const fresh = await getTxn(id);
                if (fresh.status !== 'pending') throw fail(409, `Transaction already ${fresh.status}`);
                return databases.updateDocument(DB, cols.txns, id, { status: 'cancelled', reviewedBy: req.user.userId, reviewedAt: nowIso() });
            }, 'Transaction is being resolved. Please try again.');
            return res.json({ success: true, transaction: pickTxn(cancelled, req.user.role) });
        } catch (e) { return sendError(res, e, 'Failed to cancel transaction'); }
    });

    // POST /admin/transactions/:id/override { action: 'approve' | 'reverse', reason } — admin corrects a vendor:
    // approve a rejected claim, or reverse an approved one (409 when the money is already withdrawn).
    router.post('/admin/transactions/:id/override', authenticateAdmin, async (req, res) => {
        try {
            const id = String(req.params.id);
            const reason = String(req.body.reason || '').trim();
            if (reason.length < 4) throw fail(400, 'Reason too short');
            let result;
            if (req.body.action === 'approve') {
                result = (await creditClaim(id, 'rejected', req, null, `admin override: ${reason}`.slice(0, 500))).approved;
            } else if (req.body.action === 'reverse') {
                const txn = await getTxn(id);
                result = await withAccountLock(txn.accountId, 20, () => withLock(`lock:vendorac:review:${id}`, 20, async () => {
                    const fresh = await getTxn(id);
                    if (fresh.status !== 'approved') throw fail(409, `Transaction already ${fresh.status}`);
                    const amountPaise = Number(fresh.approvedAmountPaise ?? fresh.amountPaise ?? 0);
                    // Authoritative pre-check under the account lock (every ledger writer holds it), then commit.
                    const l = ledgerOf(await getAccount(fresh.accountId));
                    if (availableOf(l) < amountPaise) throw fail(409, 'Cannot reverse: the money has already been withdrawn or requested. Resolve those withdrawals first.', { body: { currentAvailablePaise: availableOf(l) } });
                    const reversed = await databases.updateDocument(DB, cols.txns, id, { status: 'reversed', reversedAt: nowIso(), reviewedBy: req.user.userId, reviewNotes: `reversed: ${reason}`.slice(0, 500) });
                    await applyLedgerAfterCommit(fresh.accountId, { totalPayInAmount: -amountPaise, totalTransactions: -1 }, `claim ${id} reverse`);
                    await bumpDaily(fresh.accountId, fresh.approvedAt || fresh.reviewedAt, { payInPaise: -amountPaise, count: -1 });
                    return reversed;
                }, 'Transaction is being resolved. Please try again.'));
            } else throw fail(400, "action must be 'approve' or 'reverse'");
            await audit('transaction', id, `override_${req.body.action}`, req, reason);
            return res.json({ success: true, transaction: pickTxn(result, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to override transaction'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAWALS (merchant → vendor pays → merchant confirms)
    // ═══════════════════════════════════════════════════════════════════════════

    function quote(a, amountPaise) {
        const adminFeePaise = feeFor(amountPaise, a.adminPercent), vendorFeePaise = feeFor(amountPaise, a.vendorPercent);
        return { amountPaise, adminFeePaise, vendorFeePaise, feePaise: adminFeePaise + vendorFeePaise, totalPaise: amountPaise + adminFeePaise + vendorFeePaise };
    }
    const assertMerchant = (req, a) => { if (a.assignedUserId !== req.user.userId) throw fail(404, 'Vendor account not found.'); };

    // POST /accounts/:id/withdraw/preview { amount (rupees the merchant receives) }
    router.post('/accounts/:id/withdraw/preview', authenticateToken, only('user'), async (req, res) => {
        try {
            const a = await getAccount(req.params.id);
            assertMerchant(req, a);
            if (a.mode !== 'commission') throw fail(400, 'This account does not support withdrawals');
            const amountPaise = toPaise(req.body.amount);
            if (amountPaise == null) throw fail(400, 'Invalid amount');
            const qt = quote(a, amountPaise);
            const availablePaise = availableOf(ledgerOf(a));
            return res.json({ success: true, amountPaise, amountRs: rs(amountPaise), feePercent: Number(a.adminPercent || 0) + Number(a.vendorPercent || 0),
                feePaise: qt.feePaise, feeRs: rs(qt.feePaise), totalPaise: qt.totalPaise, totalRs: rs(qt.totalPaise),
                availablePaise, availableRs: rs(availablePaise), sufficient: availablePaise >= qt.totalPaise });
        } catch (e) { return sendError(res, e, 'Failed to preview withdrawal'); }
    });

    // POST /accounts/:id/withdraw { amount, fee, total (rupees, echoed from the preview), mode: 'bank'|'upi',
    // holderName, accountNumber+ifscCode | upiId } — reserves amount + fees on the ledger.
    router.post('/accounts/:id/withdraw', authenticateToken, only('user'), async (req, res) => {
        try {
            const amountPaise = toPaise(req.body.amount);
            if (amountPaise == null) throw fail(400, 'Invalid amount');
            const mode = String(req.body.mode || '').toLowerCase();
            if (!['bank', 'upi'].includes(mode)) throw fail(400, "mode must be 'bank' or 'upi'");
            const holderName = text(req.body.holderName, 120);
            if (!holderName) throw fail(400, 'holderName is required');
            const payee = { mode, holderName, payeeAccountNumber: null, ifscCode: null, upiId: null };
            if (mode === 'bank') {
                payee.payeeAccountNumber = String(req.body.accountNumber || '').trim();
                payee.ifscCode = String(req.body.ifscCode || '').trim().toUpperCase();
                if (!ACCOUNT_RE.test(payee.payeeAccountNumber)) throw fail(400, 'Invalid accountNumber: 6–24 letters/digits');
                if (!IFSC_RE.test(payee.ifscCode)) throw fail(400, 'Invalid IFSC code format (e.g. SBIN0001234)');
            } else {
                payee.upiId = String(req.body.upiId || '').trim();
                if (!UPI_RE.test(payee.upiId)) throw fail(400, 'Invalid UPI ID format (expected handle@provider)');
            }
            assertMerchant(req, await getAccount(req.params.id));   // before the lock: nobody else may hold it
            const created = await withAccountLock(String(req.params.id), 15, async () => {
                const a = await getAccount(req.params.id);
                assertMerchant(req, a);
                if (a.mode !== 'commission' || !['active', 'inactive'].includes(a.state)) throw fail(400, 'This account does not support withdrawals');
                const qt = quote(a, amountPaise);
                if (Math.round(Number(req.body.fee) * 100) !== qt.feePaise) throw fail(400, 'Fee mismatch. Refresh the withdrawal preview and try again.', { body: { feePaise: qt.feePaise, totalPaise: qt.totalPaise } });
                if (Math.round(Number(req.body.total) * 100) !== qt.totalPaise) throw fail(400, 'Amount mismatch. Refresh the withdrawal preview and try again.', { body: { feePaise: qt.feePaise, totalPaise: qt.totalPaise } });
                const availablePaise = availableOf(ledgerOf(a));
                if (availablePaise < qt.totalPaise) throw fail(400, 'Insufficient balance', { body: { availablePaise, totalPaise: qt.totalPaise } });
                const hold = { withdrawalRequestedAmount: qt.amountPaise, commissionOnHold: qt.feePaise };
                await applyLedger(a.$id, hold);
                try {
                    return await databases.createDocument(DB, cols.withdrawals, ID.unique(), {
                        accountId: a.$id, vendorId: a.vendorId, userId: a.assignedUserId, ownerSubadminId: a.managedByUserId || null,
                        amountPaise: qt.amountPaise, adminFeePaise: qt.adminFeePaise, vendorFeePaise: qt.vendorFeePaise, totalPaise: qt.totalPaise,
                        adminPercent: Number(a.adminPercent || 0), vendorPercent: Number(a.vendorPercent || 0),
                        ...payee, status: 'requested', createdAt: nowIso(),
                    });
                } catch (e) {   // the hold is ours and we still hold the lock — put it back
                    await applyLedger(a.$id, { withdrawalRequestedAmount: -qt.amountPaise, commissionOnHold: -qt.feePaise })
                        .catch((e2) => console.error(`CRITICAL: vendors withdrawal doc failed AND hold release failed on ${a.$id} ${JSON.stringify(hold)}:`, e2?.message || e2));
                    throw e;
                }
            });
            return res.status(201).json({ success: true, withdrawal: pickWithdrawal(created, 'user') });
        } catch (e) { return sendError(res, e, 'Failed to request withdrawal'); }
    });

    router.get('/withdrawals', authenticateToken, async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const q = scopeQueries(req.user, 'row');
            if (req.query.accountId) q.push(Query.equal('accountId', String(req.query.accountId)));
            if (req.query.status) {
                if (!WD_STATUSES.includes(String(req.query.status))) throw fail(400, `Invalid status. Must be one of: ${WD_STATUSES.join(', ')}`);
                q.push(Query.equal('status', String(req.query.status)));
            }
            q.push(...dateRange(req.query, 'createdAt'), Query.orderDesc('$createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit));
            const r = await databases.listDocuments(DB, cols.withdrawals, q);
            return res.json({ withdrawals: r.documents.map((d) => pickWithdrawal(d, req.user.role)), nextCursor: page(r.documents, limit) });
        } catch (e) { return sendError(res, e, 'Failed to fetch vendor withdrawals'); }
    });

    // Every withdrawal transition runs under the ACCOUNT lock, re-reads, and proceeds only from `from`.
    async function transition(id, from, who, fn) {
        const w0 = await getWithdrawal(id);
        who(w0);
        return withAccountLock(w0.accountId, 20, async () => {
            const w = await getWithdrawal(id);
            if (!from.includes(w.status)) throw fail(409, `Withdrawal already ${w.status}`);
            return fn(w);
        });
    }
    const feesOf = (w) => Number(w.adminFeePaise || 0) + Number(w.vendorFeePaise || 0);
    // Give the reserved money back (cancel / vendor reject / admin reverse). Status first, then the ledger.
    async function release(w, patch) {
        const updated = await databases.updateDocument(DB, cols.withdrawals, w.$id, patch);
        await applyLedgerAfterCommit(w.accountId, { withdrawalRequestedAmount: -Number(w.amountPaise), commissionOnHold: -feesOf(w) }, `withdrawal ${w.$id} ${patch.status}`);
        return updated;
    }
    // The merchant got the money: the reservation becomes a payout, the held fees become earnings.
    async function complete(w, patch) {
        const at = nowIso();
        const updated = await databases.updateDocument(DB, cols.withdrawals, w.$id, { ...patch, status: 'completed', completedAt: at });
        const amountPaise = Number(w.amountPaise), adminFee = Number(w.adminFeePaise || 0), vendorFee = Number(w.vendorFeePaise || 0);
        await applyLedgerAfterCommit(w.accountId, {
            withdrawalRequestedAmount: -amountPaise, withdrawalCompletedAmount: amountPaise, commissionOnHold: -(adminFee + vendorFee),
            adminCommissionEarned: adminFee, vendorCommissionEarned: vendorFee,
        }, `withdrawal ${w.$id} complete`);
        for (const [earner, amt] of [['admin', adminFee], ['vendor', vendorFee]]) {
            if (amt > 0) {
                await databases.createDocument(DB, cols.commissions, ID.unique(), { withdrawalId: w.$id, accountId: w.accountId, vendorId: w.vendorId, earner, amountPaise: amt, createdAt: at })
                    .catch((e) => console.error(`CRITICAL: vendors ${earner} commission row for withdrawal ${w.$id} (${amt} paise) not written:`, e?.message || e));
            }
        }
        await bumpDaily(w.accountId, at, { payoutPaise: amountPaise, adminCommissionPaise: adminFee, vendorCommissionPaise: vendorFee });
        return updated;
    }
    const merchantOnly = (req) => (w) => { if (w.userId !== req.user.userId) throw fail(404, 'Withdrawal not found'); };
    const vendorOnly = (req) => (w) => { if (w.vendorId !== req.user.userId) throw fail(404, 'Withdrawal not found'); };

    router.post('/withdrawals/:id/cancel', authenticateToken, only('user'), async (req, res) => {
        try {
            const w = await transition(String(req.params.id), ['requested'], merchantOnly(req), (x) => release(x, { status: 'cancelled' }));
            return res.json({ success: true, withdrawal: pickWithdrawal(w, 'user') });
        } catch (e) { return sendError(res, e, 'Failed to cancel withdrawal'); }
    });

    router.post('/withdrawals/:id/reject', authenticateToken, only('vendor'), async (req, res) => {
        try {
            const reason = String(req.body.reason || '').trim();
            if (reason.length < 4) throw fail(400, 'Reason too short');
            const w = await transition(String(req.params.id), ['requested'], vendorOnly(req), (x) => release(x, { status: 'rejected', rejectReason: reason.slice(0, 300) }));
            return res.json({ success: true, withdrawal: pickWithdrawal(w, 'vendor') });
        } catch (e) { return sendError(res, e, 'Failed to reject withdrawal'); }
    });

    // POST /withdrawals/:id/paid { utr } — the vendor sent the money. Nothing moves until the merchant confirms.
    router.post('/withdrawals/:id/paid', authenticateToken, only('vendor'), async (req, res) => {
        try {
            const utr = String(req.body.utr || '').trim().toUpperCase();
            if (!UTR_RE.test(utr)) throw fail(400, 'Invalid UTR (5–40 letters, digits or dashes)');
            const w = await transition(String(req.params.id), ['requested'], vendorOnly(req),
                (x) => databases.updateDocument(DB, cols.withdrawals, x.$id, { status: 'paid', utr, paidAt: nowIso() }));
            return res.json({ success: true, withdrawal: pickWithdrawal(w, 'vendor') });
        } catch (e) { return sendError(res, e, 'Failed to mark withdrawal paid'); }
    });

    router.post('/withdrawals/:id/confirm', authenticateToken, only('user'), async (req, res) => {
        try {
            const w = await transition(String(req.params.id), ['paid', 'disputed'], merchantOnly(req), (x) => complete(x, { confirmedAt: nowIso() }));
            return res.json({ success: true, withdrawal: pickWithdrawal(w, 'user') });
        } catch (e) { return sendError(res, e, 'Failed to confirm withdrawal'); }
    });

    router.post('/withdrawals/:id/dispute', authenticateToken, only('user'), async (req, res) => {
        try {
            const reason = String(req.body.reason || '').trim();
            if (reason.length < 4) throw fail(400, 'Reason too short');
            const w = await transition(String(req.params.id), ['paid'], merchantOnly(req),
                (x) => databases.updateDocument(DB, cols.withdrawals, x.$id, { status: 'disputed', disputeReason: reason.slice(0, 300) }));
            return res.json({ success: true, withdrawal: pickWithdrawal(w, 'user') });
        } catch (e) { return sendError(res, e, 'Failed to dispute withdrawal'); }
    });

    // POST /admin/withdrawals/:id/resolve { action: 'complete' | 'reverse', reason } — complete needs the vendor's
    // UTR on file (paid/disputed); reverse gives everything back to the merchant from any open state.
    router.post('/admin/withdrawals/:id/resolve', authenticateAdmin, async (req, res) => {
        try {
            const reason = String(req.body.reason || '').trim();
            if (reason.length < 4) throw fail(400, 'Reason too short');
            const id = String(req.params.id);
            const stamp = { resolvedBy: req.user.userId, resolveReason: reason.slice(0, 300) };
            let w;
            if (req.body.action === 'complete') w = await transition(id, ['paid', 'disputed'], () => {}, (x) => complete(x, stamp));
            else if (req.body.action === 'reverse') w = await transition(id, OPEN_WD, () => {}, (x) => release(x, { ...stamp, status: 'reversed' }));
            else throw fail(400, "action must be 'complete' or 'reverse'");
            await audit('withdrawal', id, `resolve_${req.body.action}`, req, reason);
            return res.json({ success: true, withdrawal: pickWithdrawal(w, 'admin') });
        } catch (e) { return sendError(res, e, 'Failed to resolve withdrawal'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // RENT / SALE EARNINGS
    // ═══════════════════════════════════════════════════════════════════════════

    // POST /admin/accounts/:id/earnings { period: 'sale' | 'YYYY-MM', amount (rupees), utr?, notes? }
    router.post('/admin/accounts/:id/earnings', authenticateAdmin, async (req, res) => {
        try {
            const amountPaise = toPaise(req.body.amount);
            if (amountPaise == null) throw fail(400, 'Invalid amount');
            const period = String(req.body.period || '').trim();
            const created = await withLock(`lock:vendorearn:${req.params.id}`, 15, async () => {
                const a = await getAccount(req.params.id);
                if (a.mode === 'sell') {
                    if (period !== 'sale') throw fail(400, "period must be 'sale' for a sold account");
                    if (a.state !== 'sold') throw fail(409, `Account is ${a.state}`);
                } else if (a.mode === 'rent') {
                    if (!PERIOD_RE.test(period)) throw fail(400, 'period must be YYYY-MM for a rented account');
                    if (!rentPeriodsDue(a).includes(period)) throw fail(400, `Rent for ${period} is not due on this account`);
                } else throw fail(400, 'Commission accounts have no rent or sale earnings');
                const dup = await count(cols.earnings, [Query.equal('accountId', a.$id), Query.equal('period', period)]);
                if (dup > 0) throw fail(409, `Payment for ${period} is already recorded`);
                return databases.createDocument(DB, cols.earnings, ID.unique(), {
                    accountId: a.$id, vendorId: a.vendorId, type: a.mode === 'sell' ? 'sale' : 'rent', period, amountPaise,
                    utr: text(req.body.utr, 64), notes: text(req.body.notes, 300), paidBy: req.user.userId, paidAt: nowIso(),
                });
            }, 'This account is being updated. Please try again.');
            return res.status(201).json({ success: true, earning: pickEarning(created) });
        } catch (e) { return sendError(res, e, 'Failed to record payment'); }
    });

    router.get('/earnings', authenticateToken, only('admin', 'vendor'), async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const q = req.user.role === 'vendor' ? [Query.equal('vendorId', req.user.userId)] : (req.query.vendorId ? [Query.equal('vendorId', String(req.query.vendorId))] : []);
            if (req.query.accountId) q.push(Query.equal('accountId', String(req.query.accountId)));
            q.push(Query.orderDesc('$createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit));
            const r = await databases.listDocuments(DB, cols.earnings, q);
            return res.json({ earnings: r.documents.map(pickEarning), nextCursor: page(r.documents, limit) });
        } catch (e) { return sendError(res, e, 'Failed to fetch earnings'); }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // DASHBOARDS
    // ═══════════════════════════════════════════════════════════════════════════

    router.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
        try {
            const { summary } = await buildSummary({ from: req.query.from, to: req.query.to });
            const vendors = await count(USERS_META, [Query.equal('role', 'vendor')]);
            return res.json({ success: true, vendors, ...summary });
        } catch (e) { return sendError(res, e, 'Failed to build vendor dashboard'); }
    });

    // GET /admin/vendors — vendor logins with headline figures. Cursor over users_meta.
    router.get('/admin/vendors', authenticateAdmin, async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const r = await databases.listDocuments(DB, USERS_META, [Query.equal('role', 'vendor'), Query.orderAsc('$id'), ...cursorQuery(req.query.cursor), Query.limit(limit)]);
            const ids = r.documents.map((d) => d.userId).filter(Boolean);
            const accounts = ids.length ? await listAll(cols.accounts, [Query.equal('vendorId', ids)]) : [];
            const vendors = r.documents.map((u) => {
                const mine = accounts.filter((a) => a.vendorId === u.userId);
                const sum = (k) => mine.reduce((s, a) => s + Number(a[k] || 0), 0);
                const byState = Object.fromEntries(STATES.map((s) => [s, mine.filter((a) => a.state === s).length]));
                return { userId: u.userId, name: u.name || null, email: u.email || null, status: u.status !== false, accounts: { total: mine.length, byState },
                    payInPaise: sum('totalPayInAmount'), payoutPaise: sum('withdrawalCompletedAmount'), adminCommissionPaise: sum('adminCommissionEarned'),
                    vendorCommissionPaise: sum('vendorCommissionEarned'), heldByVendorPaise: sum('totalPayInAmount') - sum('withdrawalCompletedAmount') };
            });
            return res.json({ vendors, nextCursor: page(r.documents, limit) });
        } catch (e) { return sendError(res, e, 'Failed to fetch vendors'); }
    });

    async function vendorDashboard(vendorId, role, q) {
        const { summary, accounts, earnings } = await buildSummary({ vendorId, from: q.from, to: q.to });
        return { success: true, vendorId, ...summary,
            accountsTable: accounts.map((a) => ({ ...pickAccount(a, role), rentSale: earnings.perAccount[a.$id] || null })) };
    }
    router.get('/admin/vendors/:vendorId', authenticateAdmin, async (req, res) => {
        try {
            const u = await userMetaCache.getUserMeta(String(req.params.vendorId)).catch(() => null);
            if (!u || u.role !== 'vendor') throw fail(404, 'Vendor not found');
            return res.json({ vendor: { userId: u.userId, name: u.name || null, email: u.email || null, status: u.status !== false }, ...(await vendorDashboard(u.userId, 'admin', req.query)) });
        } catch (e) { return sendError(res, e, 'Failed to build vendor dashboard'); }
    });
    router.get('/me/dashboard', authenticateToken, only('vendor'), async (req, res) => {
        try { return res.json(await vendorDashboard(req.user.userId, 'vendor', req.query)); }
        catch (e) { return sendError(res, e, 'Failed to build vendor dashboard'); }
    });

    router.get('/admin/audit', authenticateAdmin, async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const q = [];
            if (req.query.entityId) q.push(Query.equal('entityId', String(req.query.entityId)));
            q.push(Query.orderDesc('$createdAt'), ...cursorQuery(req.query.cursor), Query.limit(limit));
            const r = await databases.listDocuments(DB, cols.audit, q);
            const entries = r.documents.map((d) => ({ $id: d.$id, entityType: d.entityType, entityId: d.entityId, action: d.action, actorId: d.actorId, reason: d.reason || null, createdAt: d.createdAt }));
            return res.json({ entries, nextCursor: page(r.documents, limit) });
        } catch (e) { return sendError(res, e, 'Failed to fetch audit log'); }
    });

    return router;
}

module.exports = vendorsRouter;
module.exports.isVendorBlocked = isVendorBlocked;
module.exports.rentPeriodsDue = rentPeriodsDue;
module.exports.feeFor = feeFor;
