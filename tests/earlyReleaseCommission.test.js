/**
 * Early-release fee (withdraw.js earlyFeeFor) + bank-account insta credit (qrSettlement holdEnabled) — pins:
 *   • the fee is priced ONLY on the slice of a withdrawal that today's admin release makes withdrawable
 *     (min(released, requested − withdrawable-without-release)), rounded up, at ONE rate that is admin's:
 *     the user's own earlyReleaseCommission (admin-set) or the platform default — a subadmin never earns a share
 *   • preview and /withdraw_new agree; the client must echo the fee (400 on mismatch); it is held in
 *     commissionOnHold with the payin commission, earned at approve, freed at reject
 *   • approve writes SEPARATE commission rows (commissionType 'early_release'), separate counters and
 *     separate rollup collections — the payin rollups never see the fee; the withdrawal report shows it apart
 *   • a release with chargeCommission:false, or a 0 rate (the default until admin sets one), charges nothing
 *     and the old client contract (amount = preAmount + commission) keeps working unchanged
 *   • bank_account_insta_credit ON: bank pay-ins are withdrawable at once, nothing is held, early release is
 *     refused; OFF: plain T+1 like a QR
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
const makeRedis = () => ({ set: jest.fn().mockResolvedValue('OK'), get: jest.fn().mockResolvedValue(null), eval: jest.fn().mockResolvedValue(1), incrBy: jest.fn().mockResolvedValue(1) });
const asUser = (req, res, next) => { const u = META[req.headers['x-user'] || 'admin1']; if (!u) return res.status(401).json({ error: 'nope' }); req.user = { $id: u.$id, userId: u.userId, role: u.role, labels: u.labels || [], parentId: u.parentId || null }; next(); };
const asAdminOrLabel = (label, { isSubadminAllowed = false } = {}) => (req, res, next) => asUser(req, res, () => {
    const { role, labels } = req.user;
    if (role === 'admin' || (isSubadminAllowed && role === 'subadmin') || (role === 'employee' && labels.includes(label))) return next();
    return res.status(403).json({ error: 'Not authorized for this action.' });
});
const asAdmin = (req, res, next) => asUser(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin required' })));

function build(seed = {}) {
    const db = makeDb({ [USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }], ...seed });
    const redis = makeRedis();
    let withdrawRouter, bankRouter;
    jest.isolateModules(() => {
        const qrSettlement = require('../qrSettlement');
        const withdrawalSummary = require('../withdrawalSummary');
        qrSettlement.init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY_QR, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: QR_RELEASES });
        withdrawalSummary.init({ databases: db, Query, ID: { unique: () => 'unique' }, redisClient: redis, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID: DAILY_QR_WD });
        const bankSettlement = qrSettlement.create({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', dailySummariesCollectionId: DAILY_BANK, releasesCollectionId: BANK_RELEASES, keyField: 'bankAcId', label: 'bank account', instaCreditKey: 'bank_account_insta_credit' });
        const bankWd = withdrawalSummary.create({ databases: db, Query, ID: { unique: () => 'unique' }, redisClient: redis, APPWRITE_DATABASE_ID: 'db1', collectionId: DAILY_BANK_WD, keyField: 'bankAcId', lockPrefix: 'lock:bankac:withdrawal:daily:' });
        // 31 positional args — mirrors the withdraw.js mount in server.js.
        withdrawRouter = require('../withdraw.js')(db, {}, {}, { unique: () => 'w1' }, Query, 'db1', USERS, QRS, WD, 'b',
            DAILY_QR, COMM, DAILY_COMM, ALLTIME_COMM, MONTHLY_COMM, 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asUser, asAdminOrLabel, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin,
            redis, jest.fn(), jest.fn(), { collectionId: ACCOUNTS, settlement: bankSettlement, withdrawalSummary: bankWd },
            { daily: EARLY_DAILY, monthly: EARLY_MONTHLY, allTime: EARLY_ALLTIME });
        bankRouter = require('../bankAccounts.js')(db, { unique: () => 'unique' }, Query, 'db1', USERS, ACCOUNTS, TXNS, DAILY_BANK, WD, redis, asUser, asAdminOrLabel, asAdmin, jest.fn(), bankSettlement, bankWd);
    });
    const app = express(); app.use(express.json()); app.use('/user', withdrawRouter); app.use('/bank-acs', bankRouter);
    return { db, app, redis };
}
const as = (who) => ({ 'x-user': who });
const qr = (db) => db.store[QRS][0];
const seedQr = (release = { releasedPaise: 100000 }) => ({
    // ₹2,000 available, ₹1,500 of it arrived today, admin released ₹1,000 of that → withdrawable ₹1,500;
    // without the release only ₹500 would be withdrawable.
    [QRS]: [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 200000, amountAvailableForWithdrawal: 200000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0 }],
    [DAILY_QR]: [{ $id: 'd1', date: today(), totalsJson: JSON.stringify({ qr1: 150000 }) }],
    [QR_RELEASES]: release ? [{ $id: 'r1', qrId: 'qr1', date: today(), changeCount: 1, historyJson: '[]', ...release }] : [],
});
// ₹1,000 out; payin 3% (user 1 + parent 2) = ₹30. The early slice = min(₹1,000 released, ₹1,030 − ₹500) = ₹530;
// admin's early-release rate for user1 is 2% → ceil(53000 × 2%) = 1060 paise = ₹10.60, all of it admin's.
const preview = (app) => request(app).post('/user/withdraw_commission_preview').set(as('user1')).send({ userId: 'user1', qrId: 'qr1', preAmount: 1000 });
const wd = (app, over = {}) => request(app).post('/user/withdraw_new').set(as('user1')).send({ userId: 'user1', qrId: 'qr1', mode: 'upi', upiId: 'a@ybl', holderName: 'A', preAmount: 1000, commission: 30, amount: 1030, ...over });
const approve = (app, id) => request(app).post('/user/withdrawals/approve_new').set(as('admin1')).send({ id, utrNumber: 'UTR123456' });
const rows = (db) => (db.store[COMM] || []).map((c) => ({ userId: c.userId, amount: c.amount, rate: c.commissionRate, type: c.earningType, kind: c.commissionType || null }));

beforeEach(() => {
    for (const k of Object.keys(META)) delete META[k];
    for (const k of Object.keys(mockConfig)) delete mockConfig[k];
    counters.length = 0;
    mockConfig.max_withdrawal_requests = 99;
    META.admin1 = { $id: 'admin1', userId: 'admin1', role: 'admin' };
    // sub1's own earlyReleaseCommission is irrelevant to user1's fee — it is admin's rate for user1 (2%).
    META.sub1 = { $id: 'sub1', userId: 'sub1', role: 'subadmin', parentId: null, commission: 2, earlyReleaseCommission: 9 };
    META.user1 = { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1', commission: 1, earlyReleaseCommission: 2 };
});

describe('early-release fee on withdrawals', () => {
    test('preview prices the fee on the released slice only; /withdraw_new requires the client to echo it', async () => {
        const { app, db } = build(seedQr());
        const p = await preview(app);
        expect(p.status).toBe(200);
        expect(p.body).toMatchObject({ commissionRs: 30, earlyReleaseCommissionPaise: 1060, earlyReleaseCommissionRs: 10.6, earlyReleaseRate: 2, earlyReleasePortionPaise: 53000, totalAmount: 1040.6 });

        const stale = await wd(app);                                             // old contract: no fee echoed
        expect(stale.status).toBe(400);
        expect(stale.body.error).toMatch(/Early release commission mismatch/);
        expect(qr(db).commissionOnHold).toBe(0);

        const wrongTotal = await wd(app, { earlyReleaseCommission: 10.6 });    // fee ok, total not updated
        expect(wrongTotal.status).toBe(400);
        expect(wrongTotal.body.error).toMatch(/Amount mismatch/);

        const ok = await wd(app, { earlyReleaseCommission: 10.6, amount: 1040.6 });
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ commission: 30, earlyReleaseCommission: 10.6, earlyReleasePortionPaise: 53000, earlyUserRate: 2, earlyParentRate: 0 });
        expect(qr(db)).toMatchObject({ withdrawalRequestedAmount: 100000, commissionOnHold: 4060, amountAvailableForWithdrawal: 95940 });
    });

    test('approve earns the fee separately: own rows, own counters, own rollups; the report shows it apart', async () => {
        const { app, db } = build({ ...seedQr(), [DAILY_QR_WD]: [], [DAILY_COMM]: [], [EARLY_DAILY]: [] });
        const created = await wd(app, { earlyReleaseCommission: 10.6, amount: 1040.6 });
        expect((await approve(app, created.body.data.id)).status).toBe(200);
        expect(qr(db)).toMatchObject({ withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 100000, commissionOnHold: 0, commissionPaid: 4060, amountAvailableForWithdrawal: 95940 });
        expect(rows(db)).toEqual([
            { userId: 'sub1', amount: 1000, rate: 1, type: 'subadmin', kind: null },
            { userId: 'admin1', amount: 2000, rate: 2, type: 'admin', kind: null },
            { userId: 'admin1', amount: 1060, rate: 2, type: 'admin', kind: 'early_release' },     // the whole fee, admin only — sub1 gets no early row
        ]);
        expect(counters).toEqual(expect.arrayContaining([['totalMerchantProfit', 1000], ['totalAdminProfit', 2000], ['totalEarlyReleaseAdminProfit', 1060]]));
        expect(counters.find(([k]) => k === 'totalEarlyReleaseMerchantProfit')).toBeUndefined();
        // payin rollups untouched by the fee; the fee has its own three rollups
        expect(JSON.parse(db.store[DAILY_COMM][0].commissionsJson)).toEqual({ sub1: 1000, admin1: 2000 });
        expect(JSON.parse(db.store[EARLY_DAILY][0].commissionsJson)).toEqual({ admin1: 1060 });
        expect(db.store[EARLY_ALLTIME].map((r) => [r.userId, r.totalCommissionPaise])).toEqual([['admin1', 1060]]);
        expect(db.store[EARLY_MONTHLY].map((r) => [r.userId, r.totalCommissionPaise])).toEqual([['admin1', 1060]]);
        expect(db.store[ALLTIME_COMM].map((r) => [r.userId, r.totalCommissionPaise])).toEqual([['sub1', 1000], ['admin1', 2000]]);
        expect(JSON.parse(db.store[DAILY_QR_WD][0].totalsJson)).toEqual({ qr1: { direct: { paidPaise: 100000, commissionPaise: 3000, earlyReleaseCommissionPaise: 1060, count: 1 } } });
    });

    test('reject frees the held fee with the payin commission', async () => {
        const { app, db } = build(seedQr());
        const created = await wd(app, { earlyReleaseCommission: 10.6, amount: 1040.6 });
        const res = await request(app).post('/user/withdrawals/reject_new').set(as('admin1')).send({ id: created.body.data.id, reason: 'nope' });
        expect(res.status).toBe(200);
        expect(qr(db)).toMatchObject({ withdrawalRequestedAmount: 0, commissionOnHold: 0, commissionPaid: 0, amountAvailableForWithdrawal: 200000 });
    });

    test('chargeCommission:false on the release → no fee, old contract unchanged', async () => {
        const { app, db } = build(seedQr({ releasedPaise: 100000, chargeCommission: false }));
        expect((await preview(app)).body).toMatchObject({ earlyReleaseCommissionPaise: 0, totalAmount: 1030 });
        const ok = await wd(app);
        expect(ok.status).toBe(200);
        expect(ok.body.data.earlyReleaseCommission).toBeUndefined();
        expect(qr(db).commissionOnHold).toBe(3000);
    });

    test('no rate on the user → config default (0 = fee off); the subadmin\'s own rate never matters', async () => {
        delete META.user1.earlyReleaseCommission;            // sub1 still has 9% — must be ignored
        const { app } = build(seedQr());
        expect((await preview(app)).body.earlyReleaseCommissionPaise).toBe(0);
        expect((await wd(app)).status).toBe(200);

        mockConfig.default_early_release_commission = 1;     // admin sets 1% platform-wide → ceil(53000 × 1%) = 530
        const { app: app2 } = build(seedQr());
        expect((await preview(app2)).body).toMatchObject({ earlyReleaseCommissionPaise: 530, earlyReleaseRate: 1 });
    });

    test('a request fully covered without the release pays nothing; one that dips into it pays only on the dip', async () => {
        const { app } = build(seedQr());
        const small = await request(app).post('/user/withdraw_commission_preview').set(as('user1')).send({ userId: 'user1', qrId: 'qr1', preAmount: 400 }); // ₹412 total ≤ ₹500 without release
        expect(small.body.earlyReleaseCommissionPaise).toBe(0);
        const dip = await request(app).post('/user/withdraw_commission_preview').set(as('user1')).send({ userId: 'user1', qrId: 'qr1', preAmount: 600 }); // ₹618 → ₹118 early → ceil(11800 × 2%) = 236
        expect(dip.body).toMatchObject({ earlyReleasePortionPaise: 11800, earlyReleaseCommissionPaise: 236 });
    });
});

describe('bank_account_insta_credit', () => {
    const account = () => ({ $id: 'ac1', bankAcId: AC, bankName: 'HDFC', accountHolderName: 'Shop', ifscCode: 'HDFC0001234', accountType: 'current', isActive: true,
        assignedUserId: 'user1', managedByUserId: 'sub1', totalTransactions: 1, totalPayInAmount: 100000, withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 0, amountAvailableForWithdrawal: 100000, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0 });
    const seed = () => ({ [ACCOUNTS]: [account()], [DAILY_BANK]: [{ $id: 'bd1', date: today(), totalsJson: JSON.stringify({ [AC]: 100000 }) }], [BANK_RELEASES]: [] });
    const bankWd = (app) => request(app).post('/user/withdraw_new').set(as('user1')).send({ userId: 'user1', bankAcId: AC, mode: 'upi', upiId: 'a@ybl', holderName: 'A', preAmount: 500, commission: 15, amount: 515 });

    test('OFF (default): today\'s bank pay-in is held like a QR', async () => {
        const { app } = build(seed());
        const list = await request(app).get('/bank-acs/user/user1').set(as('user1'));
        expect(list.body.bankAccounts[0]).toMatchObject({ todayTotalPayIn: 100000, heldTodayPaise: 100000, canWithdrawTodayPaise: 0, t1HoldApplies: true });
        expect((await bankWd(app)).status).toBe(400);
    });

    test('ON: withdrawable at once, nothing held, early release refused; QRs are unaffected', async () => {
        mockConfig.bank_account_insta_credit = 'true';
        const { app, db } = build({ ...seed(), ...seedQr() });
        const list = await request(app).get('/bank-acs/user/user1').set(as('user1'));
        expect(list.body.bankAccounts[0]).toMatchObject({ todayTotalPayIn: 100000, heldTodayPaise: 0, releasedTodayPaise: 0, canWithdrawTodayPaise: 100000, t1HoldApplies: false });
        const rel = await request(app).put(`/bank-acs/${AC}/release`).set(as('admin1')).send({ amount: 100, reason: 'test release' });
        expect(rel.status).toBe(400); expect(rel.body.error).toMatch(/bank_account_insta_credit/);
        expect((await bankWd(app)).status).toBe(200);
        expect(db.store[ACCOUNTS][0]).toMatchObject({ withdrawalRequestedAmount: 50000, commissionOnHold: 1500 });
        // the QR instance still holds T+1 (its own release row governs, and it still charges the fee)
        expect((await preview(app)).body.earlyReleaseCommissionPaise).toBe(1060);
    });
});
