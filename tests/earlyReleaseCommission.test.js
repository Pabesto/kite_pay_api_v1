/**
 * Early-release fee (charged AT RELEASE, withdraw.js chargeEarlyReleaseFee via admin.js
 * PUT /qr-settlement/:qrId/release) + bank-account insta credit (qrSettlement holdEnabled) — pins:
 *   • releasing ₹X charges ceil(X × rate) right then: QR commissionPaid += fee, available −= fee, one
 *     commission row to ADMIN (commissionType 'early_release', sourceWithdrawalId 'release:<row>'), the
 *     early-release counter, the three early-release rollups — the payin rollups never see it
 *   • the fee lands on the release row (feePaise/feeRate/feePayerUserId) and in the route response
 *   • a top-up charges only the increment; a reduction or revoke charges nothing and refunds nothing
 *   • chargeCommission:false, an unassigned QR, or a 0 rate → no fee
 *   • rate = the subadmin's for a user under one (own value ignored), own for a parentless user, else default
 *   • the release row and the ledger write happen under lock:qr; lock busy → 423, nothing written
 *   • withdrawals are exactly as before the fee existed: no fee priced, no fee held, old contract
 *   • bank releases never charge; bank_account_insta_credit ON holds nothing and refuses release
 */
const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');
const moment = require('moment-timezone');

const mockConfig = {};
jest.mock('../configManager', () => ({
    get: jest.fn((key, def = null) => (key in mockConfig ? mockConfig[key] : def)),
    refresh: jest.fn().mockResolvedValue({}), getConfig: jest.fn().mockResolvedValue({}), set: jest.fn().mockResolvedValue(),
}));
jest.mock('../scripts/transactionStatusMailer', () => ({ sendMerchantHoldEmail: jest.fn() }));
const counters = [];
jest.mock('../dashboardCounters', () => ({ init: jest.fn(), updateDashboardCounter: jest.fn(async (_db, _id, name, delta) => { counters.push([name, delta]); }) }));
const META = {};
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async (id) => META[id] || null), invalidate: jest.fn() }));
jest.mock('../qrOwnerCache', () => ({ reload: jest.fn().mockResolvedValue(null), invalidateQr: jest.fn(), resolve: jest.fn().mockResolvedValue(null), get: jest.fn() }));

const USERS = 'users_meta', QRS = 'qr_col', WD = 'withdrawals', COMM = 'commission_txs';
const DAILY_QR = 'daily_qr', QR_RELEASES = 'qr_releases', DAILY_QR_WD = 'daily_qr_wd';
const DAILY_COMM = 'daily_commission', MONTHLY_COMM = 'monthly_commission', ALLTIME_COMM = 'all_time_commission';
const EARLY_DAILY = 'daily_early', EARLY_MONTHLY = 'monthly_early', EARLY_ALLTIME = 'all_time_early';
const ACCOUNTS = 'bank_accounts', TXNS = 'bank_txns', DAILY_BANK = 'daily_bankac', BANK_RELEASES = 'bankac_releases', DAILY_BANK_WD = 'daily_bankac_wd';
const AC = '123456789012';
const today = () => moment().tz('Asia/Kolkata').format('YYYY-MM-DD');

function makeDb(seed = {}) {
    const store = {};
    for (const [c, docs] of Object.entries(seed)) store[c] = docs.map((d) => ({ ...d }));
    let seq = 0;
    const col = (c) => (store[c] = store[c] || []);
    const parse = (q) => { try { return JSON.parse(q); } catch { return null; } };
    return {
        store,
        listDocuments: jest.fn(async (_d, c, queries = []) => {
            let docs = col(c).slice(), limit = 25;
            for (const raw of queries) {
                const q = parse(raw);
                if (!q) continue;
                if (q.method === 'limit') limit = q.values[0];
                else if (q.method === 'equal') docs = docs.filter((d) => q.values.includes(d[q.attribute]));
            }
            return { documents: docs.slice(0, limit).map((d) => ({ ...d })), total: docs.length };
        }),
        getDocument: jest.fn(async (_d, c, id) => { const d = col(c).find((x) => x.$id === id); if (!d) throw Object.assign(new Error('nf'), { code: 404 }); return { ...d }; }),
        createDocument: jest.fn(async (_d, c, _id, data) => { const doc = { $id: `${c}_${++seq}`, ...data }; col(c).push(doc); return { ...doc }; }),
        updateDocument: jest.fn(async (_d, c, id, data) => { const d = col(c).find((x) => x.$id === id); Object.assign(d, data); return { ...d }; }),
        deleteDocument: jest.fn(async (_d, c, id) => { store[c] = col(c).filter((x) => x.$id !== id); return {}; }),
    };
}
const makeRedis = () => ({ set: jest.fn().mockResolvedValue('OK'), get: jest.fn().mockResolvedValue(null), eval: jest.fn().mockResolvedValue(1), incrBy: jest.fn().mockResolvedValue(1), scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [] }) });
const asUser = (req, res, next) => { const u = META[req.headers['x-user'] || 'admin1']; if (!u) return res.status(401).json({ error: 'nope' }); req.user = { $id: u.$id, userId: u.userId, role: u.role, labels: u.labels || [], parentId: u.parentId || null, name: u.name || null }; next(); };
const asAdminOrLabel = (label, { isSubadminAllowed = false } = {}) => (req, res, next) => asUser(req, res, () => {
    const { role, labels } = req.user;
    if (role === 'admin' || (isSubadminAllowed && role === 'subadmin') || (role === 'employee' && labels.includes(label))) return next();
    return res.status(403).json({ error: 'Not authorized for this action.' });
});
const asAdmin = (req, res, next) => asUser(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin required' })));

function build(seed = {}, redis = makeRedis()) {
    const db = makeDb({ [USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }], ...seed });
    let withdrawRouter, adminRouter, bankRouter;
    jest.isolateModules(() => {
        const qrSettlement = require('../qrSettlement');
        const withdrawalSummary = require('../withdrawalSummary');
        qrSettlement.init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY_QR, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: QR_RELEASES });
        withdrawalSummary.init({ databases: db, Query, ID: { unique: () => 'unique' }, redisClient: redis, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID: DAILY_QR_WD });
        const bankSettlement = qrSettlement.create({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', dailySummariesCollectionId: DAILY_BANK, releasesCollectionId: BANK_RELEASES, keyField: 'bankAcId', label: 'bank account', instaCreditKey: 'bank_account_insta_credit' });
        const bankWd = withdrawalSummary.create({ databases: db, Query, ID: { unique: () => 'unique' }, redisClient: redis, APPWRITE_DATABASE_ID: 'db1', collectionId: DAILY_BANK_WD, keyField: 'bankAcId', lockPrefix: 'lock:bankac:withdrawal:daily:' });
        // 31 positional args — mirrors the withdraw.js construction in server.js.
        withdrawRouter = require('../withdraw.js')(db, {}, {}, { unique: () => 'w1' }, Query, 'db1', USERS, QRS, WD, 'b',
            DAILY_QR, COMM, DAILY_COMM, ALLTIME_COMM, MONTHLY_COMM, 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asUser, asAdminOrLabel, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin,
            redis, jest.fn(), jest.fn(), { collectionId: ACCOUNTS, settlement: bankSettlement, withdrawalSummary: bankWd },
            { daily: EARLY_DAILY, monthly: EARLY_MONTHLY, allTime: EARLY_ALLTIME });
        // 46 positional args — mirrors the app.use('/api/admin', adminRoutes(...)) mount; the 46th is the fee charger.
        adminRouter = require('../admin.js')(
            'https://appwrite.test/v1', 'proj1', db, {}, {}, { unique: () => 'unique' }, Query, 'db1',
            USERS, QRS, 'webhook_col', 'bucket1', DAILY_QR, 'daily_deleted', 'daily_flagged',
            COMM, DAILY_COMM, ALLTIME_COMM, MONTHLY_COMM, 'dashboard_counters', 'manual_hold', 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asUser, asAdminOrLabel, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin, redis, jest.fn(),
            WD, jest.fn().mockResolvedValue(), 'rejected_txns', 'daily_rejected', jest.fn(), 'alltime_payout_comm', 'payout_wallets', 'customer_payouts',
            EARLY_ALLTIME, ACCOUNTS, 'vendor_accounts', withdrawRouter.chargeEarlyReleaseFee);
        bankRouter = require('../bankAccounts.js')(db, { unique: () => 'unique' }, Query, 'db1', USERS, ACCOUNTS, TXNS, DAILY_BANK, WD, redis, asUser, asAdminOrLabel, asAdmin, jest.fn(), bankSettlement, bankWd);
    });
    const app = express(); app.use(express.json()); app.use('/user', withdrawRouter); app.use('/admin', adminRouter); app.use('/bank-acs', bankRouter);
    return { db, app, redis };
}
const as = (who) => ({ 'x-user': who });
const qr = (db) => db.store[QRS][0];
// ₹2,000 on the QR, ₹1,500 of it arrived today (held); nothing released yet.
const seedQr = () => ({
    [QRS]: [{ $id: 'q1', qrId: 'qr1', assignedUserId: 'user1', totalPayInAmount: 200000, amountAvailableForWithdrawal: 200000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0 }],
    [DAILY_QR]: [{ $id: 'd1', date: today(), totalsJson: JSON.stringify({ qr1: 150000 }) }],
    [QR_RELEASES]: [], [COMM]: [], [EARLY_DAILY]: [],
});
const release = (app, body) => request(app).put('/admin/qr-settlement/qr1/release').set(as('admin1')).send({ reason: 'same-day funds', ...body });
const preview = (app) => request(app).post('/user/withdraw_commission_preview').set(as('user1')).send({ userId: 'user1', qrId: 'qr1', preAmount: 1000 });
const wd = (app, over = {}) => request(app).post('/user/withdraw_new').set(as('user1')).send({ userId: 'user1', qrId: 'qr1', mode: 'upi', upiId: 'a@ybl', holderName: 'A', preAmount: 1000, commission: 30, amount: 1030, ...over });
const earlyRows = (db) => (db.store[COMM] || []).filter((c) => c.commissionType === 'early_release').map((c) => ({ userId: c.userId, amount: c.amount, rate: c.commissionRate, type: c.earningType, src: c.sourceWithdrawalId }));

beforeEach(() => {
    for (const k of Object.keys(META)) delete META[k];
    for (const k of Object.keys(mockConfig)) delete mockConfig[k];
    counters.length = 0;
    mockConfig.max_withdrawal_requests = 99;
    mockConfig.qr_daily_release_max_percent = 100;
    META.admin1 = { $id: 'admin1', userId: 'admin1', role: 'admin', name: 'Head Admin' };
    // user1 is under sub1 → pays sub1's early-release rate (2%); user1's own 7 is ignored. Admin earns it.
    META.sub1 = { $id: 'sub1', userId: 'sub1', role: 'subadmin', parentId: null, commission: 2, earlyReleaseCommission: 2, name: 'Sub One' };
    META.user1 = { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1', commission: 1, earlyReleaseCommission: 7, name: 'Ravi Shop' };
});

describe('early-release fee is charged when admin releases', () => {
    test('release ₹1,000 at 2% → ₹20 debited from the QR right away, one admin row, counter, early rollups; payin rollups untouched', async () => {
        const { app, db, redis } = build(seedQr());
        const res = await release(app, { amount: 1000 });
        expect(res.status).toBe(200);
        expect(res.body.fee).toMatchObject({ feePaise: 2000, feeRs: 20, rate: 2, rateFrom: 'subadmin', payerUserId: 'user1', skipped: null });
        expect(res.body.release).toMatchObject({ releasedPaise: 100000, feePaise: 2000, feeRs: 20, feeRate: 2, chargeCommission: true,
            feePayerUserId: 'user1', feePayerName: 'Ravi Shop', payerSubadminId: 'sub1', payerSubadminName: 'Sub One', releasedBy: 'admin1', releasedByName: 'Head Admin' });
        // the audit list carries the same details, no lookups needed
        const list = await request(app).get('/admin/qr-releases').set(as('admin1'));
        expect(list.status).toBe(200);
        expect(list.body.releases[0]).toMatchObject({ qrId: 'qr1', releasedPaise: 100000, feePaise: 2000, feePayerName: 'Ravi Shop', payerSubadminName: 'Sub One', releasedByName: 'Head Admin' });
        expect(list.body).toMatchObject({ totalReleasedPaise: 100000, totalFeePaise: 2000 });
        // range list + per-day summary with range totals
        expect((await request(app).get(`/admin/qr-releases?from=${today()}&to=${today()}`).set(as('admin1'))).body.releases).toHaveLength(1);
        expect((await request(app).get(`/admin/qr-releases?from=${today()}`).set(as('admin1'))).status).toBe(400);
        const sum = await request(app).get(`/admin/early-release-summary?from=${today()}&to=${today()}`).set(as('admin1'));
        expect(sum.status).toBe(200);
        expect(sum.body).toMatchObject({ from: today(), to: today(), grandReleasedPaise: 100000, grandReleasedRs: 1000, grandFeePaise: 2000, grandFeeRs: 20, grandCount: 1, todayReleasedPaise: 100000, todayFeePaise: 2000 });
        expect(sum.body.days).toHaveLength(1);
        expect(sum.body.days[0]).toMatchObject({ date: today(), releasedPaise: 100000, feePaise: 2000, count: 1, qrs: { qr1: { releasedPaise: 100000, feePaise: 2000 } } });
        expect(sum.body.days[0].releases[0]).toMatchObject({ qrId: 'qr1', feePayerName: 'Ravi Shop' });
        expect(sum.body.qrs).toEqual([expect.objectContaining({ qrId: 'qr1', releasedPaise: 100000, feePaise: 2000, count: 1, payerName: 'Ravi Shop' })]);
        // ledger: fee taken now; withdrawable = available − held = (200000−2000) − (150000−100000)
        expect(qr(db)).toMatchObject({ commissionPaid: 2000, amountAvailableForWithdrawal: 198000, totalPayInAmount: 200000, earlyReleasedTotalPaise: 100000, earlyReleaseFeePaidPaise: 2000 });
        expect(counters).toEqual(expect.arrayContaining([['totalEarlyReleasedAmount', 100000]]));
        expect(res.body).toMatchObject({ availablePaise: 198000, releasedPaise: 100000, heldPaise: 50000, withdrawablePaise: 148000 });
        expect(earlyRows(db)).toEqual([{ userId: 'admin1', amount: 2000, rate: 2, type: 'admin', src: `release:${res.body.release.$id}` }]);
        expect(counters).toEqual(expect.arrayContaining([['totalEarlyReleaseAdminProfit', 2000]]));
        expect(counters.find(([k]) => k === 'totalEarlyReleaseMerchantProfit')).toBeUndefined();
        expect(JSON.parse(db.store[EARLY_DAILY][0].commissionsJson)).toEqual({ admin1: 2000 });
        expect(db.store[EARLY_ALLTIME].map((r) => [r.userId, r.totalCommissionPaise])).toEqual([['admin1', 2000]]);
        expect(db.store[DAILY_COMM] || []).toHaveLength(0);
        // under lock:qr, released via Lua
        expect(redis.set).toHaveBeenCalledWith('lock:qr:qr1', expect.any(String), { NX: true, EX: 20 });
        expect(redis.eval).toHaveBeenCalled();
    });

    test('top-up charges only the increment; lowering or revoking charges nothing and refunds nothing', async () => {
        const { app, db } = build(seedQr());
        expect((await release(app, { amount: 1000 })).body.fee.feePaise).toBe(2000);
        const up = await release(app, { addAmount: 500, expectedReleasedPaise: 100000 });     // +₹500 → +₹10
        expect(up.body.fee.feePaise).toBe(1000);
        expect(up.body.release).toMatchObject({ releasedPaise: 150000, feePaise: 3000 });       // running total on the row
        expect(qr(db)).toMatchObject({ commissionPaid: 3000, earlyReleasedTotalPaise: 150000, earlyReleaseFeePaidPaise: 3000 });
        const down = await release(app, { amount: 200 });                                       // reduction
        expect(down.status).toBe(200); expect(down.body.fee).toMatchObject({ feePaise: 0, skipped: 'no newly released amount' });
        const revoke = await request(app).delete('/admin/qr-settlement/qr1/release').set(as('admin1')).send({});
        expect(revoke.status).toBe(200);
        expect(qr(db)).toMatchObject({ commissionPaid: 3000, earlyReleasedTotalPaise: 150000 }); // nothing given back, lifetime total untouched by a reduction
        expect(earlyRows(db)).toHaveLength(2);
    });

    test('chargeCommission:false, an unassigned QR, or a 0 rate → release works, no fee', async () => {
        const { app, db } = build(seedQr());
        const off = await release(app, { amount: 1000, chargeCommission: false });
        expect(off.body.fee).toMatchObject({ feePaise: 0, skipped: 'fee disabled for this release' });
        expect(off.body.release).toMatchObject({ feePaise: 0, feePayerName: 'Ravi Shop', releasedByName: 'Head Admin' });   // names stamped even with no fee
        expect(qr(db).commissionPaid).toBe(0);

        const { app: app2, db: db2 } = build({ ...seedQr(), [QRS]: [{ ...seedQr()[QRS][0], assignedUserId: null }] });
        expect((await release(app2, { amount: 1000 })).body.fee).toMatchObject({ feePaise: 0, skipped: 'QR is not assigned to any user' });
        expect(db2.store[QRS][0].commissionPaid).toBe(0);

        META.sub1.earlyReleaseCommission = 0;
        const { app: app3, db: db3 } = build(seedQr());
        expect((await release(app3, { amount: 1000 })).body.fee).toMatchObject({ feePaise: 0, skipped: 'rate is 0' });
        expect(db3.store[QRS][0].commissionPaid).toBe(0);
        expect(earlyRows(db) .concat(earlyRows(db2), earlyRows(db3))).toHaveLength(0);
    });

    test('rate: subadmin\'s for a user under one (own ignored, even 0); own for a parentless user; else the config default', async () => {
        META.user1.earlyReleaseCommission = 0; META.sub1.earlyReleaseCommission = 9;
        expect((await release(build(seedQr()).app, { amount: 1000 })).body.fee).toMatchObject({ feePaise: 9000, rate: 9, rateFrom: 'subadmin' });

        delete META.sub1.earlyReleaseCommission; META.user1.earlyReleaseCommission = 5;    // subadmin unset → default (0 = off)
        expect((await release(build(seedQr()).app, { amount: 1000 })).body.fee).toMatchObject({ feePaise: 0, skipped: 'rate is 0' });
        mockConfig.default_early_release_commission = 1;
        expect((await release(build(seedQr()).app, { amount: 1000 })).body.fee).toMatchObject({ feePaise: 1000, rate: 1, rateFrom: 'default' });

        META.user1.parentId = null; META.user1.earlyReleaseCommission = 3;                  // parentless → own
        expect((await release(build(seedQr()).app, { amount: 1000 })).body.fee).toMatchObject({ feePaise: 3000, rate: 3, rateFrom: 'own' });
    });

    test('lock busy → 423 and nothing written (release row, ledger, rows)', async () => {
        const redis = makeRedis(); redis.set.mockResolvedValueOnce(null);
        const { app, db } = build(seedQr(), redis);
        expect((await release(app, { amount: 1000 })).status).toBe(423);
        expect(db.store[QR_RELEASES]).toHaveLength(0);
        expect(qr(db).commissionPaid).toBe(0);
        expect(earlyRows(db)).toHaveLength(0);
    });

    test('withdrawals are exactly as before: no fee priced, none held, old contract; a non-zero echo is refused', async () => {
        const { app, db } = build(seedQr());
        await release(app, { amount: 1000 });                                                   // ₹20 fee already taken
        const p = await preview(app);
        expect(p.status).toBe(200);
        expect(p.body).toMatchObject({ commissionRs: 30, totalAmount: 1030, earlyReleaseCommissionPaise: 0 });
        expect((await wd(app, { earlyReleaseCommission: 10.6, amount: 1040.6 })).status).toBe(400);
        const ok = await wd(app);
        expect(ok.status).toBe(200);
        expect(ok.body.data.earlyReleaseCommission).toBeUndefined();
        expect(qr(db)).toMatchObject({ withdrawalRequestedAmount: 100000, commissionOnHold: 3000, commissionPaid: 2000, amountAvailableForWithdrawal: 95000 });
        const approve = await request(app).post('/user/withdrawals/approve_new').set(as('admin1')).send({ id: ok.body.data.id, utrNumber: 'UTR123456' });
        expect(approve.status).toBe(200);
        expect(qr(db)).toMatchObject({ commissionOnHold: 0, commissionPaid: 5000, withdrawalApprovedAmount: 100000 });
        expect(earlyRows(db)).toHaveLength(1);                                                   // approve adds no early row
    });
});

describe('bank accounts', () => {
    const account = () => ({ $id: 'ac1', bankAcId: AC, bankName: 'HDFC', accountHolderName: 'Shop', ifscCode: 'HDFC0001234', accountType: 'current', isActive: true,
        assignedUserId: 'user1', managedByUserId: 'sub1', totalTransactions: 1, totalPayInAmount: 100000, withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 0, amountAvailableForWithdrawal: 100000, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0 });
    const seed = () => ({ [ACCOUNTS]: [account()], [DAILY_BANK]: [{ $id: 'bd1', date: today(), totalsJson: JSON.stringify({ [AC]: 100000 }) }], [BANK_RELEASES]: [], [COMM]: [] });
    const bankWd = (app) => request(app).post('/user/withdraw_new').set(as('user1')).send({ userId: 'user1', bankAcId: AC, mode: 'upi', upiId: 'a@ybl', holderName: 'A', preAmount: 500, commission: 15, amount: 515 });

    test('a bank release never charges the fee (QR-only); insta credit OFF holds T+1 like a QR', async () => {
        const { app, db } = build(seed());
        const rel = await request(app).put(`/bank-acs/${AC}/release`).set(as('admin1')).send({ amount: 1000, reason: 'test release' });
        expect(rel.status).toBe(200); expect(rel.body.fee).toBeUndefined();
        expect(db.store[ACCOUNTS][0].commissionPaid).toBe(0); expect(earlyRows(db)).toHaveLength(0);
        expect((await bankWd(app)).status).toBe(200);                                            // fully released → passes T+1
        const { app: held } = build(seed());
        const list = await request(held).get('/bank-acs/user/user1').set(as('user1'));
        expect(list.body.bankAccounts[0]).toMatchObject({ todayTotalPayIn: 100000, heldTodayPaise: 100000, canWithdrawTodayPaise: 0, t1HoldApplies: true });
        expect((await bankWd(held)).status).toBe(400);
    });

    test('insta credit ON: withdrawable at once, nothing held, early release refused; QRs are unaffected', async () => {
        mockConfig.bank_account_insta_credit = 'true';
        const { app, db } = build({ ...seed(), ...seedQr() });
        const list = await request(app).get('/bank-acs/user/user1').set(as('user1'));
        expect(list.body.bankAccounts[0]).toMatchObject({ todayTotalPayIn: 100000, heldTodayPaise: 0, releasedTodayPaise: 0, canWithdrawTodayPaise: 100000, t1HoldApplies: false });
        const rel = await request(app).put(`/bank-acs/${AC}/release`).set(as('admin1')).send({ amount: 100, reason: 'test release' });
        expect(rel.status).toBe(400); expect(rel.body.error).toMatch(/bank_account_insta_credit/);
        expect((await bankWd(app)).status).toBe(200);
        expect(db.store[ACCOUNTS][0]).toMatchObject({ withdrawalRequestedAmount: 50000, commissionOnHold: 1500 });
        expect((await release(app, { amount: 1000 })).body.fee.feePaise).toBe(2000);            // the QR still charges
    });
});
