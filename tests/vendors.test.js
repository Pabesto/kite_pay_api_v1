/**
 * Vendor accounts (vendors.js) — pins:
 *   • the authenticateToken gate: a vendor login reaches /api/vendors only
 *   • listing → admin approval copies the rate card (overrides win); modes land in active / sold / rented
 *   • assignment: admin → subadmin, subadmin → own merchants; a funded account can never change merchant
 *   • claims: vendor approves exactly once (ledger + daily summary once, second approve 409); locks fail
 *     closed with nothing written; min/max 422; UTR unique; admin override approve / reverse (409 once withdrawn)
 *   • withdrawals: fees ceil'd in paise and echoed; request reserves amount + fees; paid moves nothing;
 *     confirm (exactly once) turns the reservation into payout + admin/vendor earnings; cancel / reject /
 *     reverse give everything back; every transition under the account lock
 *   • rent/sale earnings due vs paid; dashboards derive from the ledgers; each role sees only its fields
 */
const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');
const moment = require('moment-timezone');

const META = {};
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async (id) => META[id] || null), invalidate: jest.fn() }));

const vendors = require('../vendors.js');
const COLS = { rateCards: 'rc', accounts: 'va', txns: 'vt', withdrawals: 'vw', commissions: 'vc', earnings: 've', audit: 'vau', daily: 'vd' };
const USERS = 'users_meta';
const today = () => moment().tz('Asia/Kolkata').format('YYYY-MM-DD');

/** In-memory Appwrite: equal (scalar or array) + limit honoured; explicit ids kept, duplicates → 409. */
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
        getDocument: jest.fn(async (_d, c, id) => { const d = col(c).find((x) => x.$id === id); if (!d) throw Object.assign(new Error('not found'), { code: 404 }); return { ...d }; }),
        createDocument: jest.fn(async (_d, c, id, data) => {
            const $id = id === 'unique' ? `${c}_${++seq}` : id;
            if (col(c).some((x) => x.$id === $id)) throw Object.assign(new Error('exists'), { code: 409 });
            const doc = { $id, ...data }; col(c).push(doc); return { ...doc };
        }),
        updateDocument: jest.fn(async (_d, c, id, data) => { const d = col(c).find((x) => x.$id === id); Object.assign(d, data); return { ...d }; }),
    };
}
const makeRedis = () => ({ set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) });

const asUser = (req, res, next) => { const u = META[req.headers['x-user'] || 'admin1']; if (!u) return res.status(401).json({ error: 'nope' }); req.user = { ...u }; next(); };
const asAdmin = (req, res, next) => asUser(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Not authorized: Admin required.' })));

function build(seed = {}, redis = makeRedis()) {
    const db = makeDb(seed);
    let router;
    // 9 positional args — mirrors the app.use('/api/vendors', …) mount in server.js.
    jest.isolateModules(() => { router = require('../vendors.js')(db, { unique: () => 'unique' }, Query, 'db1', USERS, COLS, redis, asUser, asAdmin); });
    const app = express(); app.use(express.json()); app.use('/v', router);
    return { db, app, redis };
}
const as = (who) => ({ 'x-user': who });
const acct = (over = {}) => ({
    $id: 'a1', accountNumber: '123456789012', bankName: 'HDFC', accountHolderName: 'Ven', ifscCode: 'HDFC0001234', accountType: 'current', mode: 'commission',
    state: 'active', vendorId: 'ven1', assignedUserId: 'user1', managedByUserId: 'sub1', minTxnPaise: 0, perTxnLimitPaise: 0, dailyLimitPaise: 0,
    adminPercent: 2, vendorPercent: 1, totalTransactions: 0, totalPayInAmount: 0, withdrawalRequestedAmount: 0, withdrawalCompletedAmount: 0,
    commissionOnHold: 0, adminCommissionEarned: 0, vendorCommissionEarned: 0, amountAvailableForWithdrawal: 0, ...over,
});
const funded = (paise, over = {}) => acct({ totalPayInAmount: paise, amountAvailableForWithdrawal: paise, ...over });
const A = (db) => db.store[COLS.accounts].find((d) => d.$id === 'a1');
const claim = (app, over = {}, who = 'user1') => request(app).post('/v/accounts/a1/transactions').set(as(who)).send({ referenceNumber: 'utr12345678', amount: 1000, ...over });
const withdraw = (app, over = {}) => request(app).post('/v/accounts/a1/withdraw').set(as('user1'))
    .send({ amount: 1000, fee: 30, total: 1030, mode: 'upi', holderName: 'Ravi', upiId: 'ravi@ybl', ...over });
const listing = { accountNumber: '998877665544', bankName: 'SBI', accountHolderName: 'Ven', ifscCode: 'sbin0001234', accountType: 'Savings', mode: 'commission', minTxn: 100, perTxnLimit: 50000 };

beforeEach(() => {
    for (const k of Object.keys(META)) delete META[k];
    Object.assign(META, {
        admin1: { $id: 'admin1', userId: 'admin1', role: 'admin' },
        ven1: { $id: 'ven1', userId: 'ven1', role: 'vendor', name: 'Vendor One' },
        ven2: { $id: 'ven2', userId: 'ven2', role: 'vendor' },
        sub1: { $id: 'sub1', userId: 'sub1', role: 'subadmin' },
        sub2: { $id: 'sub2', userId: 'sub2', role: 'subadmin' },
        user1: { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1' },
        user2: { $id: 'user2', userId: 'user2', role: 'user', parentId: 'sub2' },
        emp1: { $id: 'emp1', userId: 'emp1', role: 'employee', labels: [] },
    });
});

describe('pure helpers', () => {
    test('isVendorBlocked: vendors reach /api/vendors only; other roles are never blocked', () => {
        expect(vendors.isVendorBlocked('vendor', '/api/vendors/me')).toBe(false);
        expect(vendors.isVendorBlocked('vendor', '/api/vendors?x=1')).toBe(false);
        expect(vendors.isVendorBlocked('vendor', '/api/vendors')).toBe(false);
        expect(vendors.isVendorBlocked('vendor', '/api/admin/users')).toBe(true);
        expect(vendors.isVendorBlocked('vendor', '/api/vendorsX')).toBe(true);
        expect(vendors.isVendorBlocked('vendor', '/api/bank-acs/transactions')).toBe(true);
        expect(vendors.isVendorBlocked('user', '/api/admin/users')).toBe(false);
    });
    test('feeFor is integer paise rounded up; rent is due at the start of each monthly period', () => {
        expect(vendors.feeFor(100000, 2)).toBe(2000);
        expect(vendors.feeFor(100001, 1.5)).toBe(1501);   // 1500.015 → up
        expect(vendors.feeFor(33333, 0)).toBe(0);
        const d = { rentStartDate: '2026-01-31T06:00:00.000Z', rentPerMonthPaise: 100 };
        expect(vendors.rentPeriodsDue(d, new Date('2026-01-31T07:00:00Z'))).toEqual(['2026-01']);
        expect(vendors.rentPeriodsDue(d, new Date('2026-03-30T07:00:00Z'))).toEqual(['2026-01', '2026-02']);
        expect(vendors.rentPeriodsDue({ ...d, rentEndDate: '2026-02-01T00:00:00Z' }, new Date('2027-01-01'))).toEqual(['2026-01']);
    });
});

describe('listing and approval', () => {
    test('vendor lists (under_review); duplicate 409; approval copies the rate card; only admin approves', async () => {
        const { app, db } = build({ [COLS.rateCards]: [] });
        expect((await request(app).post('/v/accounts').set(as('user1')).send(listing)).status).toBe(403);
        const res = await request(app).post('/v/accounts').set(as('ven1')).send(listing);
        expect(res.status).toBe(201);
        expect(res.body.account).toMatchObject({ state: 'under_review', accountType: 'savings', ifscCode: 'SBIN0001234', minTxnPaise: 10000, perTxnLimitPaise: 5000000, amountAvailableForWithdrawal: 0 });
        expect(res.body.account.assignedUserId).toBeUndefined();   // vendor view never carries merchant ids
        const id = res.body.account.$id;
        expect((await request(app).post('/v/accounts').set(as('ven2')).send(listing)).status).toBe(409);

        expect((await request(app).post(`/v/admin/accounts/${id}/approve`).set(as('admin1')).send({})).status).toBe(400);   // no card, no overrides
        expect((await request(app).put('/v/admin/rate-cards/savings').set(as('ven1')).send({ adminPercent: 2 })).status).toBe(403);
        expect((await request(app).put('/v/admin/rate-cards/savings').set(as('admin1')).send({ adminPercent: 2, vendorPercent: 1 })).status).toBe(200);
        expect((await request(app).put('/v/admin/rate-cards/savings').set(as('admin1')).send({ vendorPercent: 1.5 })).status).toBe(200);   // upsert, same doc
        expect(db.store[COLS.rateCards]).toHaveLength(1);
        expect((await request(app).post(`/v/admin/accounts/${id}/approve`).set(as('ven1')).send({})).status).toBe(403);
        const ok = await request(app).post(`/v/admin/accounts/${id}/approve`).set(as('admin1')).send({ adminPercent: 2.5 });
        expect(ok.status).toBe(200);
        expect(ok.body.account).toMatchObject({ state: 'active', adminPercent: 2.5, vendorPercent: 1.5 });
        expect((await request(app).post(`/v/admin/accounts/${id}/approve`).set(as('admin1')).send({})).status).toBe(409);
        expect((await request(app).patch(`/v/accounts/${id}`).set(as('ven1')).send({ notes: 'x' })).status).toBe(409);   // admin-only once approved
        expect((await request(app).patch(`/v/accounts/${id}`).set(as('admin1')).send({ dailyLimit: 20000 })).status).toBe(200);
    });

    test('sell and rent approve into sold / rented with their terms; employees have no access', async () => {
        const { app } = build({ [COLS.accounts]: [acct({ $id: 's1', mode: 'sell', state: 'under_review', assignedUserId: null, managedByUserId: null }), acct({ $id: 'r1', mode: 'rent', state: 'under_review', assignedUserId: null, managedByUserId: null })] });
        const s = await request(app).post('/v/admin/accounts/s1/approve').set(as('admin1')).send({ salePrice: 25000 });
        expect(s.body.account).toMatchObject({ state: 'sold', salePricePaise: 2500000 });
        const r = await request(app).post('/v/admin/accounts/r1/approve').set(as('admin1')).send({ rentPerMonth: 3000 });
        expect(r.body.account).toMatchObject({ state: 'rented', rentPerMonthPaise: 300000 });
        expect(r.body.account.rentStartDate).toBeTruthy();
        expect((await request(app).get('/v/accounts').set(as('emp1'))).status).toBe(403);
        expect((await request(app).put('/v/admin/accounts/s1/assign-manager').set(as('admin1')).send({ managedByUserId: 'sub1' })).status).toBe(409);   // listing-only
    });
});

describe('assignment', () => {
    test('admin → subadmin → own merchant; a funded account never changes merchant', async () => {
        const { app, db } = build({ [COLS.accounts]: [acct({ assignedUserId: null, managedByUserId: null })], [COLS.txns]: [] });
        expect((await request(app).put('/v/admin/accounts/a1/assign-manager').set(as('sub1')).send({ managedByUserId: 'sub1' })).status).toBe(403);
        expect((await request(app).put('/v/admin/accounts/a1/assign-manager').set(as('admin1')).send({ managedByUserId: 'user1' })).status).toBe(400);
        expect((await request(app).put('/v/accounts/a1/assign-user').set(as('admin1')).send({ assignedUserId: 'user1' })).status).toBe(409);   // no subadmin yet
        expect((await request(app).put('/v/admin/accounts/a1/assign-manager').set(as('admin1')).send({ managedByUserId: 'sub1' })).status).toBe(200);
        expect((await request(app).put('/v/accounts/a1/assign-user').set(as('sub2')).send({ assignedUserId: 'user2' })).status).toBe(404);
        expect((await request(app).put('/v/accounts/a1/assign-user').set(as('sub1')).send({ assignedUserId: 'user2' })).status).toBe(409);
        expect((await request(app).put('/v/accounts/a1/assign-user').set(as('sub1')).send({ assignedUserId: 'sub1' })).status).toBe(409);   // merchants only: a subadmin could never withdraw
        expect((await request(app).put('/v/accounts/a1/assign-user').set(as('sub1')).send({ assignedUserId: 'user1' })).status).toBe(200);
        expect((await request(app).put('/v/admin/accounts/a1/assign-manager').set(as('admin1')).send({ managedByUserId: 'sub2' })).status).toBe(409);   // merchant not under sub2
        Object.assign(A(db), { totalPayInAmount: 500, amountAvailableForWithdrawal: 500 });
        const blocked = await request(app).put('/v/accounts/a1/assign-user').set(as('sub1')).send({ assignedUserId: null });
        expect(blocked.status).toBe(409);
        expect(A(db).assignedUserId).toBe('user1');
    });
});

describe('claims', () => {
    test('limits and UTR uniqueness; only the assigned merchant side may claim', async () => {
        const { app } = build({ [COLS.accounts]: [acct({ minTxnPaise: 50000, perTxnLimitPaise: 200000, dailyLimitPaise: 150000 })], [COLS.txns]: [] });
        expect((await claim(app, {}, 'user2')).status).toBe(404);
        expect((await claim(app, {}, 'ven1')).status).toBe(403);
        expect((await claim(app, { amount: 100 })).status).toBe(422);
        expect((await claim(app, { amount: 5000 })).status).toBe(422);
        const ok = await claim(app);
        expect(ok.status).toBe(201);
        expect(ok.body.transaction).toMatchObject({ accountId: 'a1', userId: 'user1', ownerSubadminId: 'sub1', referenceNumber: 'UTR12345678', amountPaise: 100000, status: 'pending' });
        expect(ok.body.transaction.vendorId).toBeUndefined();
        expect((await claim(app, {}, 'sub1')).status).toBe(409);
        const over = await claim(app, { referenceNumber: 'UTR22222222' }, 'sub1');
        expect(over.status).toBe(201);
        expect(over.body.dailyLimitWarning).toEqual({ dailyLimitPaise: 150000, usedPaise: 200000 });   // warns, never blocks
    });

    test('vendor approves exactly once: ledger + daily summary once, locks released; other vendors cannot touch it', async () => {
        const { app, db, redis } = build({ [COLS.accounts]: [acct()], [COLS.txns]: [], [COLS.daily]: [] });
        const id = (await claim(app)).body.transaction.$id;
        expect((await request(app).post(`/v/transactions/${id}/approve`).set(as('ven2')).send({})).status).toBe(404);
        const res = await request(app).post(`/v/transactions/${id}/approve`).set(as('ven1')).send({ amount: 999.5 });
        expect(res.status).toBe(200);
        expect(res.body.transaction).toMatchObject({ status: 'approved', amountPaise: 100000, approvedAmountPaise: 99950 });
        expect(res.body.transaction.userId).toBeUndefined();
        expect(A(db)).toMatchObject({ totalTransactions: 1, totalPayInAmount: 99950, amountAvailableForWithdrawal: 99950 });
        expect(JSON.parse(db.store[COLS.daily][0].totalsJson)).toEqual({ a1: { payInPaise: 99950, count: 1 } });
        expect(db.store[COLS.daily][0].date).toBe(today());
        expect(redis.set).toHaveBeenCalledWith('lock:vendorac:a1', expect.any(String), { NX: true, EX: 15 });
        expect(redis.set).toHaveBeenCalledWith(`lock:vendorac:review:${id}`, expect.any(String), { NX: true, EX: 20 });
        expect(redis.eval.mock.calls.length).toBeGreaterThanOrEqual(3);   // review + account + daily, all via Lua
        expect((await request(app).post(`/v/transactions/${id}/approve`).set(as('ven1')).send({})).status).toBe(409);
        expect((await request(app).post(`/v/transactions/${id}/reject`).set(as('ven1')).send({ reason: 'late' })).status).toBe(409);
        expect(A(db).totalPayInAmount).toBe(99950);
    });

    test('lock busy and Redis error both fail closed with nothing written', async () => {
        const { app, db, redis } = build({ [COLS.accounts]: [acct()], [COLS.txns]: [] });
        const id = (await claim(app)).body.transaction.$id;
        redis.set.mockResolvedValueOnce(null);
        expect((await request(app).post(`/v/transactions/${id}/approve`).set(as('ven1')).send({})).status).toBe(409);
        redis.set.mockRejectedValueOnce(new Error('redis down'));
        expect((await request(app).post(`/v/transactions/${id}/approve`).set(as('ven1')).send({})).status).toBe(409);
        expect(db.store[COLS.txns][0].status).toBe('pending');
        expect(A(db).totalPayInAmount).toBe(0);
    });

    test('admin override: approve a rejected claim; reverse refuses once withdrawn, otherwise undoes the credit', async () => {
        const { app, db } = build({ [COLS.accounts]: [acct()], [COLS.txns]: [], [COLS.daily]: [], [COLS.audit]: [] });
        const id = (await claim(app)).body.transaction.$id;
        expect((await request(app).post(`/v/transactions/${id}/reject`).set(as('ven1')).send({ reason: 'not seen' })).status).toBe(200);
        expect(A(db).totalPayInAmount).toBe(0);
        expect((await request(app).post(`/v/admin/transactions/${id}/override`).set(as('ven1')).send({ action: 'approve', reason: 'seen it' })).status).toBe(403);
        const ok = await request(app).post(`/v/admin/transactions/${id}/override`).set(as('admin1')).send({ action: 'approve', reason: 'statement shows it' });
        expect(ok.status).toBe(200);
        expect(A(db).totalPayInAmount).toBe(100000);
        Object.assign(A(db), { withdrawalRequestedAmount: 60000, amountAvailableForWithdrawal: 40000 });
        const refused = await request(app).post(`/v/admin/transactions/${id}/override`).set(as('admin1')).send({ action: 'reverse', reason: 'fraud' });
        expect(refused.status).toBe(409);
        expect(db.store[COLS.txns][0].status).toBe('approved');
        Object.assign(A(db), { withdrawalRequestedAmount: 0, amountAvailableForWithdrawal: 100000 });
        expect((await request(app).post(`/v/admin/transactions/${id}/override`).set(as('admin1')).send({ action: 'reverse', reason: 'fraud' })).status).toBe(200);
        expect(A(db)).toMatchObject({ totalTransactions: 0, totalPayInAmount: 0, amountAvailableForWithdrawal: 0 });
        expect(JSON.parse(db.store[COLS.daily][0].totalsJson)).toEqual({ a1: { payInPaise: 0, count: 0 } });
        expect(db.store[COLS.audit].map((a) => a.action)).toEqual(['override_approve', 'override_reverse']);
    });
});

describe('withdrawals', () => {
    test('fees echoed; request reserves; paid moves nothing; confirm completes exactly once', async () => {
        const { app, db } = build({ [COLS.accounts]: [funded(500000)], [COLS.withdrawals]: [], [COLS.commissions]: [], [COLS.daily]: [] });
        const pv = await request(app).post('/v/accounts/a1/withdraw/preview').set(as('user1')).send({ amount: 1000 });
        expect(pv.body).toMatchObject({ amountPaise: 100000, feePaise: 3000, totalPaise: 103000, feePercent: 3, sufficient: true });
        expect((await withdraw(app, { fee: 20 })).status).toBe(400);
        expect((await withdraw(app, { total: 1020 })).status).toBe(400);
        expect((await withdraw(app, { amount: 5000, fee: 150, total: 5150 })).status).toBe(400);   // insufficient
        expect((await request(app).post('/v/accounts/a1/withdraw').set(as('user2')).send({})).status).toBe(400);
        const res = await withdraw(app);
        expect(res.status).toBe(201);
        expect(res.body.withdrawal).toMatchObject({ status: 'requested', amountPaise: 100000, feePaise: 3000, totalPaise: 103000 });
        expect(res.body.withdrawal.vendorFeePaise).toBeUndefined();   // merchant never sees the split
        const id = res.body.withdrawal.$id;
        expect(A(db)).toMatchObject({ withdrawalRequestedAmount: 100000, commissionOnHold: 3000, amountAvailableForWithdrawal: 397000 });

        expect((await request(app).post(`/v/withdrawals/${id}/confirm`).set(as('user1')).send({})).status).toBe(409);   // not paid yet
        expect((await request(app).post(`/v/withdrawals/${id}/paid`).set(as('ven2')).send({ utr: 'UTR555555' })).status).toBe(404);
        const paid = await request(app).post(`/v/withdrawals/${id}/paid`).set(as('ven1')).send({ utr: 'utr555555' });
        expect(paid.body.withdrawal).toMatchObject({ status: 'paid', utr: 'UTR555555', payeeAccountNumber: null, upiId: 'ravi@ybl' });
        expect(paid.body.withdrawal.userId).toBeUndefined();
        expect(A(db)).toMatchObject({ withdrawalRequestedAmount: 100000, commissionOnHold: 3000 });

        const done = await request(app).post(`/v/withdrawals/${id}/confirm`).set(as('user1')).send({});
        expect(done.status).toBe(200);
        expect(A(db)).toMatchObject({ withdrawalRequestedAmount: 0, withdrawalCompletedAmount: 100000, commissionOnHold: 0,
            adminCommissionEarned: 2000, vendorCommissionEarned: 1000, amountAvailableForWithdrawal: 397000 });
        expect(db.store[COLS.commissions].map((c) => [c.earner, c.amountPaise])).toEqual([['admin', 2000], ['vendor', 1000]]);
        expect(JSON.parse(db.store[COLS.daily][0].totalsJson)).toEqual({ a1: { payoutPaise: 100000, adminCommissionPaise: 2000, vendorCommissionPaise: 1000 } });
        expect((await request(app).post(`/v/withdrawals/${id}/confirm`).set(as('user1')).send({})).status).toBe(409);
        expect(db.store[COLS.commissions]).toHaveLength(2);
    });

    test('cancel, vendor reject and admin reverse each give back amount + fees; dispute is admin-resolved', async () => {
        const { app, db } = build({ [COLS.accounts]: [funded(500000)], [COLS.withdrawals]: [], [COLS.commissions]: [], [COLS.audit]: [] });
        const idOf = async () => (await withdraw(app)).body.withdrawal.$id;
        const back = () => expect(A(db)).toMatchObject({ withdrawalRequestedAmount: 0, commissionOnHold: 0, amountAvailableForWithdrawal: 500000 });

        const c = await idOf();
        expect((await request(app).post(`/v/withdrawals/${c}/cancel`).set(as('user1')).send({})).body.withdrawal.status).toBe('cancelled'); back();
        const r = await idOf();
        expect((await request(app).post(`/v/withdrawals/${r}/reject`).set(as('ven1')).send({ reason: 'cannot pay today' })).body.withdrawal.status).toBe('rejected'); back();

        const d = await idOf();
        await request(app).post(`/v/withdrawals/${d}/paid`).set(as('ven1')).send({ utr: 'UTR777777' });
        expect((await request(app).post(`/v/withdrawals/${d}/cancel`).set(as('user1')).send({})).status).toBe(409);   // paid can't be cancelled
        expect((await request(app).post(`/v/withdrawals/${d}/dispute`).set(as('user1')).send({ reason: 'not received' })).body.withdrawal.status).toBe('disputed');
        expect((await request(app).post(`/v/admin/withdrawals/${d}/resolve`).set(as('user1')).send({ action: 'reverse', reason: 'x'.repeat(5) })).status).toBe(403);
        const rev = await request(app).post(`/v/admin/withdrawals/${d}/resolve`).set(as('admin1')).send({ action: 'reverse', reason: 'vendor never paid' });
        expect(rev.body.withdrawal).toMatchObject({ status: 'reversed', resolveReason: 'vendor never paid' }); back();
        expect(db.store[COLS.commissions]).toHaveLength(0);

        const q = await idOf();
        expect((await request(app).post(`/v/admin/withdrawals/${q}/resolve`).set(as('admin1')).send({ action: 'complete', reason: 'no utr yet' })).status).toBe(409);
        await request(app).post(`/v/withdrawals/${q}/paid`).set(as('ven1')).send({ utr: 'UTR888888' });
        expect((await request(app).post(`/v/admin/withdrawals/${q}/resolve`).set(as('admin1')).send({ action: 'complete', reason: 'merchant confirmed by phone' })).status).toBe(200);
        expect(A(db)).toMatchObject({ withdrawalCompletedAmount: 100000, adminCommissionEarned: 2000, vendorCommissionEarned: 1000 });
    });

    test('a busy account lock refuses the request with nothing reserved', async () => {
        const { app, db, redis } = build({ [COLS.accounts]: [funded(500000)], [COLS.withdrawals]: [] });
        redis.set.mockResolvedValueOnce(null);
        expect((await withdraw(app)).status).toBe(409);
        expect(A(db).withdrawalRequestedAmount).toBe(0);
        expect(db.store[COLS.withdrawals]).toHaveLength(0);
    });
});

describe('earnings, delist and dashboards', () => {
    test('rent is recorded once per due period; sale once; dashboard shows due vs paid', async () => {
        const start = moment().tz('Asia/Kolkata').subtract(1, 'month').toISOString();
        const { app } = build({ [COLS.accounts]: [acct({ $id: 'r1', mode: 'rent', state: 'rented', rentPerMonthPaise: 300000, rentStartDate: start, assignedUserId: null }),
            acct({ $id: 's1', mode: 'sell', state: 'sold', salePricePaise: 2500000, assignedUserId: null })], [COLS.earnings]: [], [COLS.withdrawals]: [], [COLS.txns]: [] });
        const period = moment().tz('Asia/Kolkata').format('YYYY-MM');
        const future = moment().tz('Asia/Kolkata').add(2, 'month').format('YYYY-MM');
        expect((await request(app).post('/v/admin/accounts/r1/earnings').set(as('admin1')).send({ period: future, amount: 3000 })).status).toBe(400);
        expect((await request(app).post('/v/admin/accounts/r1/earnings').set(as('admin1')).send({ period, amount: 3000, utr: 'U1' })).status).toBe(201);
        expect((await request(app).post('/v/admin/accounts/r1/earnings').set(as('admin1')).send({ period, amount: 3000 })).status).toBe(409);
        expect((await request(app).post('/v/admin/accounts/s1/earnings').set(as('admin1')).send({ period: '2026-01', amount: 1 })).status).toBe(400);
        expect((await request(app).post('/v/admin/accounts/s1/earnings').set(as('admin1')).send({ period: 'sale', amount: 25000 })).status).toBe(201);
        const dash = await request(app).get('/v/me/dashboard').set(as('ven1'));
        expect(dash.status).toBe(200);
        expect(dash.body.rentSale).toMatchObject({ saleDuePaise: 2500000, salePaidPaise: 2500000, rentDuePaise: 600000, rentPaidPaise: 300000, outstandingPaise: 300000 });
        expect(dash.body.accountsTable.find((a) => a.$id === 'r1').rentSale).toMatchObject({ duePaise: 600000, paidPaise: 300000, outstandingPaise: 300000 });
    });

    test('delist refuses while money is on the account', async () => {
        const { app, db } = build({ [COLS.accounts]: [funded(100)], [COLS.txns]: [], [COLS.audit]: [] });
        expect((await request(app).post('/v/admin/accounts/a1/delist').set(as('admin1')).send({})).status).toBe(409);
        Object.assign(A(db), { totalPayInAmount: 0, amountAvailableForWithdrawal: 0 });
        const ok = await request(app).post('/v/admin/accounts/a1/delist').set(as('admin1')).send({});
        expect(ok.body.account).toMatchObject({ state: 'delisted', assignedUserId: null, managedByUserId: null });
    });

    test('admin dashboard derives every figure from the ledgers; vendor views hide merchant ids', async () => {
        const { app } = build({
            [COLS.accounts]: [
                acct({ totalPayInAmount: 500000, withdrawalCompletedAmount: 100000, adminCommissionEarned: 2000, vendorCommissionEarned: 1000, amountAvailableForWithdrawal: 397000 }),
                acct({ $id: 'a2', vendorId: 'ven2', state: 'under_review', assignedUserId: null }),
            ],
            [COLS.withdrawals]: [{ $id: 'w1', vendorId: 'ven1', status: 'paid' }], [COLS.txns]: [{ $id: 't1', vendorId: 'ven1', status: 'pending' }], [COLS.earnings]: [],
            [USERS]: [{ $id: 'ven1', userId: 'ven1', role: 'vendor' }, { $id: 'ven2', userId: 'ven2', role: 'vendor' }],
        });
        const d = await request(app).get('/v/admin/dashboard').set(as('admin1'));
        expect(d.status).toBe(200);
        expect(d.body).toMatchObject({ vendors: 2, payInPaise: 500000, payoutPaise: 100000, adminCommissionPaise: 2000, vendorCommissionPaise: 1000,
            heldByVendorsPaise: 400000, merchantBalancePaise: 397000, pendingClaims: 1, pendingPayouts: { requested: 0, paid: 1, disputed: 0, total: 1 } });
        expect(d.body.accounts.byState).toMatchObject({ active: 1, under_review: 1 });
        expect((await request(app).get('/v/admin/dashboard').set(as('ven1'))).status).toBe(403);
        const list = await request(app).get('/v/admin/vendors').set(as('admin1'));
        expect(list.body.vendors.find((v) => v.userId === 'ven1')).toMatchObject({ payInPaise: 500000, adminCommissionPaise: 2000, heldByVendorPaise: 400000 });
        const one = await request(app).get('/v/admin/vendors/ven1').set(as('admin1'));
        expect(one.body.accountsTable).toHaveLength(1);
        expect(one.body.accountsTable[0].assignedUserId).toBe('user1');
        const mine = await request(app).get('/v/me/dashboard').set(as('ven1'));
        expect(mine.body.accountsTable[0].assignedUserId).toBeUndefined();
        const merchant = await request(app).get('/v/accounts').set(as('user1'));
        expect(merchant.body.accounts).toHaveLength(1);
        expect(merchant.body.accounts[0]).toMatchObject({ feePercent: 3, feesPaidPaise: 3000 });
        expect(merchant.body.accounts[0].vendorId).toBeUndefined();
        expect(merchant.body.accounts[0].adminCommissionEarned).toBeUndefined();
    });
});
