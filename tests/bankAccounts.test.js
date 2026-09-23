/**
 * Bank Account pay-ins (bankAccounts.js) + the bank-account source in withdraw.js — pins:
 *   • account create/edit validation (IFSC upper-cased, immutable id, 409 duplicates) and the zero ledger
 *   • claim request: ownership, reference uniqueness (409), per-txn limit (422), daily limit WARNS only
 *   • approve is exactly-once: second approve → 409; ledger credited once; daily summary keyed by bankAcId;
 *     the two bank Redis counters (never the QR ones); created_at = approval instant; amount override
 *   • lock discipline: contention and a Redis error both fail closed (409) with nothing written
 *   • reject/cancel never credit; employee approvers are tenant-scoped by assigned subadmin + label
 *   • delete of an approved claim reverses the ledger and refuses (409) when the money was withdrawn
 *   • /withdraw_new with bankAcId debits bank_accounts (never qr_codes), stores bankAcId on the doc,
 *     honours T+1 on today's bank pay-in, and approve writes the bank withdrawal-summary row
 *   • hold-and-reset moves claims, withdrawals, daily keys, releases and the withdrawal rollup; 409 while pending
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

const USERS = 'users_meta', ACCOUNTS = 'bank_accounts', TXNS = 'bank_txns', DAILY = 'daily_bankac', WD = 'withdrawals', RELEASES = 'bankac_releases', DAILY_WD = 'daily_bankac_wd';
const QRS = 'qr_col', DAILY_QR = 'daily_qr', QR_RELEASES = 'qr_releases', DAILY_QR_WD = 'daily_qr_wd', COMM = 'commission_txs';
const AC = '123456789012';
const today = () => moment().tz('Asia/Kolkata').format('YYYY-MM-DD');

/** In-memory Appwrite: equal/limit honoured, other query methods ignored (fixtures fit one page). */
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
        createDocument: jest.fn(async (_d, c, _id, data) => { const doc = { $id: `${c}_${++seq}`, ...data }; col(c).push(doc); return { ...doc }; }),
        updateDocument: jest.fn(async (_d, c, id, data) => { const d = col(c).find((x) => x.$id === id); Object.assign(d, data); return { ...d }; }),
        deleteDocument: jest.fn(async (_d, c, id) => { store[c] = col(c).filter((x) => x.$id !== id); return {}; }),
    };
}
const makeRedis = () => ({
    set: jest.fn().mockResolvedValue('OK'), get: jest.fn().mockResolvedValue(null), eval: jest.fn().mockResolvedValue(1),
    incrBy: jest.fn().mockResolvedValue(1), del: jest.fn().mockResolvedValue(1),
});

// Auth stubs: the caller is whoever `x-user` names in META (role + labels drive the real checks).
const asUser = (req, res, next) => { const u = META[req.headers['x-user'] || 'admin1']; if (!u) return res.status(401).json({ error: 'nope' }); req.user = { $id: u.$id, userId: u.userId, role: u.role, labels: u.labels || [], parentId: u.parentId || null, name: u.name || null }; next(); };
const asAdminOrLabel = (label, { isSubadminAllowed = false } = {}) => (req, res, next) => asUser(req, res, () => {
    const { role, labels } = req.user;
    if (role === 'admin' || (isSubadminAllowed && role === 'subadmin') || (role === 'employee' && labels.includes(label))) return next();
    return res.status(403).json({ error: 'Not authorized for this action.' });
});
const asAdmin = (req, res, next) => asUser(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Not authorized: Admin required.' })));

function account(over = {}) {
    return { $id: 'ac1', bankAcId: AC, bankName: 'HDFC', accountHolderName: 'Shop', ifscCode: 'HDFC0001234', accountType: 'current', isActive: true,
        assignedUserId: 'user1', managedByUserId: 'sub1', createdByUserId: 'admin1', perTxnLimitPaise: 0, dailyLimitPaise: 0,
        totalTransactions: 0, totalPayInAmount: 0, withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 0, amountAvailableForWithdrawal: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0, ...over };
}

function build(seed = {}, redis = makeRedis()) {
    const db = makeDb(seed);
    const emit = jest.fn();
    let router, withdrawRouter;
    jest.isolateModules(() => {
        const qrSettlement = require('../qrSettlement');
        const withdrawalSummary = require('../withdrawalSummary');
        qrSettlement.init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY_QR, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: QR_RELEASES });
        withdrawalSummary.init({ databases: db, Query, ID: { unique: () => 'unique' }, redisClient: redis, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID: DAILY_QR_WD });
        const settlement = qrSettlement.create({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', dailySummariesCollectionId: DAILY, releasesCollectionId: RELEASES, keyField: 'bankAcId', label: 'bank account' });
        const wdSummary = withdrawalSummary.create({ databases: db, Query, ID: { unique: () => 'unique' }, redisClient: redis, APPWRITE_DATABASE_ID: 'db1', collectionId: DAILY_WD, keyField: 'bankAcId', lockPrefix: 'lock:bankac:withdrawal:daily:' });
        // 16 positional args — mirrors the app.use('/api/bank-acs', …) mount in server.js.
        router = require('../bankAccounts.js')(db, { unique: () => 'unique' }, Query, 'db1', USERS, ACCOUNTS, TXNS, DAILY, WD, redis, asUser, asAdminOrLabel, asAdmin, emit, settlement, wdSummary);
        // withdraw.js with the 30th `bankAc` arg (server.js mount).
        withdrawRouter = require('../withdraw.js')(db, {}, {}, { unique: () => 'w1' }, Query, 'db1', USERS, QRS, WD, 'b',
            DAILY_QR, COMM, 'daily_commission', 'all_time_commission', 'monthly_commission', 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asUser, asAdminOrLabel, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin,
            redis, jest.fn(), emit, { collectionId: ACCOUNTS, settlement, withdrawalSummary: wdSummary });
    });
    const app = express(); app.use(express.json()); app.use('/bank-acs', router); app.use('/user', withdrawRouter);
    return { db, app, emit, redis };
}
const as = (who) => ({ 'x-user': who });
const ac = (db) => db.store[ACCOUNTS].find((d) => d.bankAcId === AC);
const claim = (app, over = {}, who = 'user1') => request(app).post(`/bank-acs/${AC}/transactions`).set(as(who)).send({ referenceNumber: 'utr12345678', amount: 1000, ...over });

beforeEach(() => {
    for (const k of Object.keys(META)) delete META[k];
    for (const k of Object.keys(mockConfig)) delete mockConfig[k];
    counters.length = 0;
    mockConfig.max_withdrawal_requests = 99;
    META.admin1 = { $id: 'admin1', userId: 'admin1', role: 'admin' };
    META.sub1 = { $id: 'sub1', userId: 'sub1', role: 'subadmin', parentId: null, commission: 2 };
    META.sub2 = { $id: 'sub2', userId: 'sub2', role: 'subadmin', parentId: null, commission: 2 };
    META.user1 = { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1', commission: 1 };
    META.user2 = { $id: 'user2', userId: 'user2', role: 'user', parentId: 'sub2', commission: 1 };
    META.emp1 = { $id: 'emp1', userId: 'emp1', role: 'employee', labels: ['approve_bank_txns'] };
    META.emp0 = { $id: 'emp0', userId: 'emp0', role: 'employee', labels: [] };
});

describe('accounts', () => {
    test('create: validates, upper-cases IFSC, starts a zero ledger; duplicate number → 409; id immutable on edit', async () => {
        const { app, db } = build({ [USERS]: [] });
        const bad = await request(app).post('/bank-acs').set(as('admin1')).send({ bankAcId: AC, bankName: 'HDFC', accountHolderName: 'Shop', ifscCode: 'bad', accountType: 'current' });
        expect(bad.status).toBe(400);
        const ok = await request(app).post('/bank-acs').set(as('admin1')).send({ bankAcId: ` ${AC} `, bankName: 'HDFC', accountHolderName: 'Shop', ifscCode: 'hdfc0001234', accountType: 'Current', dailyLimit: 5000 });
        expect(ok.status).toBe(201);
        expect(ok.body.bankAccount).toMatchObject({ bankAcId: AC, ifscCode: 'HDFC0001234', accountType: 'current', dailyLimitPaise: 500000, isActive: true, amountAvailableForWithdrawal: 0, totalPayInAmount: 0 });
        expect((await request(app).post('/bank-acs').set(as('admin1')).send({ bankAcId: AC, bankName: 'X', accountHolderName: 'Y', ifscCode: 'HDFC0001234', accountType: 'savings' })).status).toBe(409);
        expect((await request(app).patch(`/bank-acs/${AC}`).set(as('admin1')).send({ bankAcId: '999' })).status).toBe(400);
        const edit = await request(app).patch(`/bank-acs/${AC}`).set(as('admin1')).send({ notes: 'main' });
        expect(edit.status).toBe(200); expect(ac(db).notes).toBe('main');
        expect((await request(app).post('/bank-acs').set(as('user1')).send({})).status).toBe(403);
    });

    test('delete refuses while assigned / pending claims / balance; user list is scoped', async () => {
        const { app } = build({ [ACCOUNTS]: [account()], [TXNS]: [] });
        expect((await request(app).delete(`/bank-acs/${AC}`).set(as('admin1'))).status).toBe(400);
        const mine = await request(app).get('/bank-acs/user/user1').set(as('user1'));
        expect(mine.status).toBe(200); expect(mine.body.bankAccounts).toHaveLength(1);
        expect(mine.body.bankAccounts[0]).toMatchObject({ bankAcId: AC, canWithdrawTodayPaise: 0, todayTotalPayIn: 0 });
        expect((await request(app).get('/bank-acs/user/user1').set(as('user2'))).status).toBe(403);
    });

    test('list filters by accountType (case-insensitive, 400 on an unknown type)', async () => {
        const { app } = build({ [ACCOUNTS]: [account(), account({ $id: 'ac2', bankAcId: '999999999999', accountType: 'corporate' })], [TXNS]: [] });
        const corp = await request(app).get('/bank-acs?accountType=Corporate').set(as('admin1'));
        expect(corp.status).toBe(200);
        expect(corp.body.bankAccounts.map((a) => a.bankAcId)).toEqual(['999999999999']);
        expect((await request(app).get('/bank-acs?accountType=current').set(as('admin1'))).body.bankAccounts.map((a) => a.bankAcId)).toEqual([AC]);
        expect((await request(app).get('/bank-acs?accountType=nre').set(as('admin1'))).status).toBe(400);
    });
});

describe('claims', () => {
    test('request: only the assigned user/their subadmin; reference upper-cased and unique while pending/approved; per-txn limit 422', async () => {
        const { app, db, emit } = build({ [ACCOUNTS]: [account({ perTxnLimitPaise: 200000 })], [TXNS]: [] });
        expect((await claim(app, {}, 'user2')).status).toBe(403);
        expect((await claim(app, {}, 'sub2')).status).toBe(403);
        expect((await claim(app, {}, 'emp1')).status).toBe(403);
        expect((await claim(app, { amount: 5000 })).status).toBe(422);
        const ok = await claim(app);
        expect(ok.status).toBe(201);
        expect(ok.body.transaction).toMatchObject({ bankAcId: AC, userId: 'user1', ownerSubadminId: 'sub1', referenceNumber: 'UTR12345678', amountPaise: 100000, status: 'pending', created_at: null });
        expect((await claim(app, { referenceNumber: 'utr12345678' }, 'sub1')).status).toBe(409);     // same UTR, any caller
        expect((await claim(app, { referenceNumber: 'UTR-OTHER-1' }, 'sub1')).status).toBe(201);      // the subadmin may file for their user
        expect(db.store[TXNS]).toHaveLength(2);
        expect(counters).toEqual(expect.arrayContaining([['totalBankAcTxPendingCount', 1], ['totalBankAcTxPendingAmount', 100000]]));
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'bankac:txn', userId: 'user1', staffRooms: ['sub1', 'user1'] }));
    });

    test('daily limit only warns (socket) — the claim is still accepted', async () => {
        const { app, emit } = build({ [ACCOUNTS]: [account({ dailyLimitPaise: 150000 })], [TXNS]: [] });
        expect((await claim(app)).body.dailyLimitWarning).toBeNull();
        const second = await claim(app, { referenceNumber: 'UTR22222222' });
        expect(second.status).toBe(201);
        expect(second.body.dailyLimitWarning).toEqual({ dailyLimitPaise: 150000, usedPaise: 200000 });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'bankac:limitWarning', payload: expect.objectContaining({ bankAcId: AC, overByPaise: 50000 }) }));
    });

    test('a rejected reference may be re-submitted', async () => {
        const { app } = build({ [ACCOUNTS]: [account()], [TXNS]: [{ $id: 't0', bankAcId: AC, userId: 'user1', referenceNumber: 'UTR12345678', amountPaise: 1, status: 'rejected' }] });
        expect((await claim(app)).status).toBe(201);
    });
});

describe('approve / reject', () => {
    test('approve credits the ledger exactly once, writes the daily key, bumps only the bank Redis counters; second approve → 409', async () => {
        const { app, db, redis, emit } = build({ [ACCOUNTS]: [account()], [TXNS]: [], [DAILY]: [] });
        const id = (await claim(app)).body.transaction.$id;
        const res = await request(app).post(`/bank-acs/transactions/${id}/approve`).set(as('admin1')).send({ notes: 'seen in statement' });
        expect(res.status).toBe(200);
        expect(res.body.transaction).toMatchObject({ status: 'approved', approvedAmountPaise: 100000, reviewedBy: 'admin1' });
        expect(res.body.transaction.created_at).toBeTruthy();
        expect(ac(db)).toMatchObject({ totalTransactions: 1, totalPayInAmount: 100000, amountAvailableForWithdrawal: 100000 });
        expect(JSON.parse(db.store[DAILY][0].totalsJson)).toEqual({ [AC]: 100000 });
        expect(db.store[DAILY][0].date).toBe(today());
        await new Promise((r) => setImmediate(r));
        expect(redis.incrBy).toHaveBeenCalledWith('counter:totalBankAcTxCount', 1);
        expect(redis.incrBy).toHaveBeenCalledWith('counter:totalBankAmountReceived', 100000);
        expect(redis.incrBy).not.toHaveBeenCalledWith('counter:totalAmountReceived', expect.anything());
        expect(redis.incrBy).not.toHaveBeenCalledWith('counter:totalTxCount', expect.anything());
        // both locks taken (account outer, review inner) and released via Lua
        expect(redis.set).toHaveBeenCalledWith(`lock:bankac:${AC}`, expect.any(String), { NX: true, EX: 15 });
        expect(redis.set).toHaveBeenCalledWith(`lock:bankac:review:${id}`, expect.any(String), { NX: true, EX: 20 });
        expect(redis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'bankac:txn', payload: expect.objectContaining({ type: 'approved' }) }));

        const again = await request(app).post(`/bank-acs/transactions/${id}/approve`).set(as('admin1')).send({});
        expect(again.status).toBe(409);
        expect(ac(db).totalPayInAmount).toBe(100000);   // still once
        expect((await request(app).post(`/bank-acs/transactions/${id}/reject`).set(as('admin1')).send({ reason: 'late' })).status).toBe(409);
    });

    test('approve with an amount override credits the override and keeps the claimed amount', async () => {
        const { app, db } = build({ [ACCOUNTS]: [account()], [TXNS]: [] });
        const id = (await claim(app)).body.transaction.$id;
        const res = await request(app).post(`/bank-acs/transactions/${id}/approve`).set(as('admin1')).send({ amount: 999.5 });
        expect(res.body.transaction).toMatchObject({ amountPaise: 100000, approvedAmountPaise: 99950 });
        expect(ac(db).totalPayInAmount).toBe(99950);
    });

    test('lock busy and Redis error both fail closed with nothing written', async () => {
        const { app, db, redis } = build({ [ACCOUNTS]: [account()], [TXNS]: [] });
        const id = (await claim(app)).body.transaction.$id;
        redis.set.mockResolvedValueOnce(null);
        expect((await request(app).post(`/bank-acs/transactions/${id}/approve`).set(as('admin1')).send({})).status).toBe(409);
        redis.set.mockRejectedValueOnce(new Error('redis down'));
        expect((await request(app).post(`/bank-acs/transactions/${id}/approve`).set(as('admin1')).send({})).status).toBe(409);
        expect(db.store[TXNS][0].status).toBe('pending');
        expect(ac(db).totalPayInAmount).toBe(0);
    });

    test('reject needs a reason and credits nothing; cancel only by the requester while pending', async () => {
        const { app, db } = build({ [ACCOUNTS]: [account()], [TXNS]: [] });
        const id = (await claim(app)).body.transaction.$id;
        expect((await request(app).post(`/bank-acs/transactions/${id}/reject`).set(as('admin1')).send({ reason: 'no' })).status).toBe(400);
        expect((await request(app).post(`/bank-acs/transactions/${id}/cancel`).set(as('user2')).send({})).status).toBe(403);
        const rej = await request(app).post(`/bank-acs/transactions/${id}/reject`).set(as('admin1')).send({ reason: 'not in statement' });
        expect(rej.status).toBe(200); expect(rej.body.transaction).toMatchObject({ status: 'rejected', rejectReason: 'not in statement' });
        expect(ac(db).totalPayInAmount).toBe(0);
        expect((await request(app).post(`/bank-acs/transactions/${id}/cancel`).set(as('user1')).send({})).status).toBe(409);
        const id2 = (await claim(app, { referenceNumber: 'UTR99999999' })).body.transaction.$id;
        expect((await request(app).post(`/bank-acs/transactions/${id2}/cancel`).set(as('user1')).send({})).status).toBe(200);
    });

    test('employees: label required and scoped to their assigned subadmins; subadmins cannot approve', async () => {
        const { app } = build({ [ACCOUNTS]: [account(), account({ $id: 'ac2', bankAcId: '999999999999', assignedUserId: 'user2', managedByUserId: 'sub2' })], [TXNS]: [],
            [USERS]: [{ $id: 'sub1', userId: 'sub1', role: 'subadmin', assigned_to: 'emp1' }, { $id: 'sub2', userId: 'sub2', role: 'subadmin', assigned_to: 'other' }] });
        const mine = (await claim(app)).body.transaction.$id;
        const theirs = (await request(app).post('/bank-acs/999999999999/transactions').set(as('user2')).send({ referenceNumber: 'UTR-B-000001', amount: 10 })).body.transaction.$id;
        expect((await request(app).post(`/bank-acs/transactions/${mine}/approve`).set(as('emp0')).send({})).status).toBe(403);
        expect((await request(app).post(`/bank-acs/transactions/${mine}/approve`).set(as('sub1')).send({})).status).toBe(403);
        expect((await request(app).post(`/bank-acs/transactions/${theirs}/approve`).set(as('emp1')).send({})).status).toBe(403);
        expect((await request(app).post(`/bank-acs/transactions/${mine}/approve`).set(as('emp1')).send({})).status).toBe(200);
    });

    test('list is role-scoped: user sees own, subadmin their tenant, admin all', async () => {
        const { app } = build({ [ACCOUNTS]: [account()], [TXNS]: [
            { $id: 't1', bankAcId: AC, userId: 'user1', ownerSubadminId: 'sub1', referenceNumber: 'A', amountPaise: 1, status: 'pending' },
            { $id: 't2', bankAcId: 'x', userId: 'user2', ownerSubadminId: 'sub2', referenceNumber: 'B', amountPaise: 1, status: 'pending' },
        ] });
        expect((await request(app).get('/bank-acs/transactions').set(as('user1'))).body.transactions.map((t) => t.$id)).toEqual(['t1']);
        expect((await request(app).get('/bank-acs/transactions').set(as('sub2'))).body.transactions.map((t) => t.$id)).toEqual(['t2']);
        expect((await request(app).get('/bank-acs/transactions').set(as('admin1'))).body.transactions).toHaveLength(2);
        expect((await request(app).get('/bank-acs/transactions?status=weird').set(as('admin1'))).status).toBe(400);
    });
});

describe('withdrawals against a bank account (withdraw.js source = bankAcId)', () => {
    const wd = (app, over = {}) => request(app).post('/user/withdraw_new').set(as('user1'))
        .send({ userId: 'user1', bankAcId: AC, mode: 'upi', upiId: 'a@ybl', holderName: 'A', preAmount: 1000, amount: 1030, commission: 30, ...over });

    test('request debits bank_accounts (never qr_codes), stores bankAcId, and approve writes the bank rollup', async () => {
        const { app, db, redis } = build({ [ACCOUNTS]: [account({ totalPayInAmount: 500000, amountAvailableForWithdrawal: 500000 })], [QRS]: [], [DAILY]: [], [DAILY_WD]: [],
            [USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }] });
        const res = await wd(app);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ bankAcId: AC, qrId: null, status: 'pending' });
        expect(ac(db)).toMatchObject({ withdrawalRequestedAmount: 100000, commissionOnHold: 3000, amountAvailableForWithdrawal: 397000 });
        expect(db.store[QRS] || []).toHaveLength(0);
        expect(redis.set).toHaveBeenCalledWith(`lock:bankac:${AC}`, expect.any(String), expect.objectContaining({ NX: true }));
        expect(redis.set).not.toHaveBeenCalledWith(expect.stringMatching(/^lock:qr:/), expect.anything(), expect.anything());

        const approve = await request(app).post('/user/withdrawals/approve_new').set(as('admin1')).send({ id: res.body.data.id, utrNumber: 'UTR123456' });
        expect(approve.status).toBe(200);
        expect(ac(db)).toMatchObject({ withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 100000, commissionOnHold: 0, commissionPaid: 3000, amountAvailableForWithdrawal: 397000 });
        expect(JSON.parse(db.store[DAILY_WD][0].totalsJson)).toEqual({ [AC]: { direct: { paidPaise: 100000, commissionPaise: 3000, count: 1 } } });
        expect(db.store[DAILY_QR_WD] || []).toHaveLength(0);
        const list = await request(app).get(`/user/withdrawals_paginated?bankAcId=${AC}`).set(as('admin1'));
        expect(list.body.withdrawals).toHaveLength(1); expect(list.body.withdrawals[0].bankAcId).toBe(AC);
    });

    test("today's approved bank pay-in is held (T+1) exactly like a QR", async () => {
        const { app } = build({ [ACCOUNTS]: [account()], [TXNS]: [], [DAILY]: [] });
        const id = (await claim(app, { amount: 5000 })).body.transaction.$id;
        expect((await request(app).post(`/bank-acs/transactions/${id}/approve`).set(as('admin1')).send({})).status).toBe(200);
        const res = await wd(app);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/exceeds available balance/);
    });

    test('both ids → 400; bankAcId with the source not configured → 400', async () => {
        const { app } = build({ [ACCOUNTS]: [account()] });
        expect((await wd(app, { qrId: 'q1' })).status).toBe(400);
    });
});

describe('delete an approved claim', () => {
    test('reverses the ledger and daily key; refuses when the money was already withdrawn', async () => {
        const { app, db } = build({ [ACCOUNTS]: [account()], [TXNS]: [], [DAILY]: [] });
        const id = (await claim(app)).body.transaction.$id;
        await request(app).post(`/bank-acs/transactions/${id}/approve`).set(as('admin1')).send({});
        // simulate an approved withdrawal that consumed the balance
        Object.assign(ac(db), { withdrawalApprovedAmount: 100000, amountAvailableForWithdrawal: 0 });
        expect((await request(app).delete(`/bank-acs/transactions/${id}`).set(as('admin1')).send({ reason: 'oops' })).status).toBe(409);
        expect(db.store[TXNS][0].deleted).toBeFalsy();
        Object.assign(ac(db), { withdrawalApprovedAmount: 0, amountAvailableForWithdrawal: 100000 });
        const del = await request(app).delete(`/bank-acs/transactions/${id}`).set(as('admin1')).send({ reason: 'oops' });
        expect(del.status).toBe(200);
        expect(ac(db)).toMatchObject({ totalTransactions: 0, totalPayInAmount: 0, amountAvailableForWithdrawal: 0 });
        expect(JSON.parse(db.store[DAILY][0].totalsJson)).toEqual({ [AC]: 0 });
        expect(db.store[TXNS][0]).toMatchObject({ deleted: true, status: 'approved' });
        expect((await request(app).delete(`/bank-acs/transactions/${id}`).set(as('admin1')).send({})).status).toBe(400);
    });
});

describe('hold-and-reset', () => {
    const HOLD = `${AC}_hold`;
    const seed = () => ({
        [ACCOUNTS]: [account({ totalPayInAmount: 5000, amountAvailableForWithdrawal: 5000 })],
        [TXNS]: [{ $id: 't1', bankAcId: AC, userId: 'user1', status: 'approved', amountPaise: 5000, referenceNumber: 'A' }, { $id: 't2', bankAcId: AC, userId: 'user1', status: 'pending', amountPaise: 1, referenceNumber: 'B' }, { $id: 't3', bankAcId: 'other', status: 'pending', amountPaise: 1, referenceNumber: 'C' }],
        [WD]: [{ $id: 'w1', bankAcId: AC }, { $id: 'w2', qrId: 'q' }],
        [DAILY]: [{ $id: 'd1', date: today(), totalsJson: JSON.stringify({ [AC]: 5000, other: 1 }) }],
        [RELEASES]: [{ $id: 'r1', bankAcId: AC, date: today(), releasedPaise: 2000, changeCount: 1, historyJson: '[]' }],
        [DAILY_WD]: [{ $id: 'wd1', date: today(), totalsJson: JSON.stringify({ [AC]: { direct: { paidPaise: 9, commissionPaise: 1, count: 1 } } }) }],
    });
    test('dry run mutates nothing; real run refuses while claims are pending; allowPending moves everything', async () => {
        const { app, db } = build(seed());
        const dry = await request(app).post(`/bank-acs/${AC}/hold-and-reset`).set(as('admin1')).send({ dryRun: true });
        expect(dry.status).toBe(200);
        expect(dry.body).toMatchObject({ dryRun: true, holdBankAcId: HOLD, willMove: { transactions: 2, pendingTxns: 1, withdrawalRequests: 1, releases: 1 }, state: { needsPendingConfirmation: true } });
        expect(db.store[ACCOUNTS]).toHaveLength(1);
        expect((await request(app).post(`/bank-acs/${AC}/hold-and-reset`).set(as('admin1')).send({})).status).toBe(400);
        const refused = await request(app).post(`/bank-acs/${AC}/hold-and-reset`).set(as('admin1')).send({ confirm: true });
        expect(refused.status).toBe(409); expect(refused.body.needsPendingConfirmation).toBe(true);
        expect(db.store[ACCOUNTS]).toHaveLength(1);

        const run = await request(app).post(`/bank-acs/${AC}/hold-and-reset`).set(as('admin1')).send({ confirm: true, allowPending: true });
        expect(run.status).toBe(200);
        expect(run.body.steps).toMatchObject({ archivedAccountDoc: true, createdFreshAccountDoc: true, transactionsMoved: 2, withdrawalRequestsMoved: 1, dailySummaryDocsMoved: 1, releasesMoved: { moved: 1, merged: 0, scanned: 1 }, withdrawalSummaryDocsMoved: 1 });
        const hold = db.store[ACCOUNTS].find((d) => d.bankAcId === HOLD), fresh = ac(db);
        expect(hold).toMatchObject({ isActive: false, assignedUserId: 'user1', totalPayInAmount: 5000 });
        expect(fresh).toMatchObject({ isActive: true, assignedUserId: null, managedByUserId: null, totalPayInAmount: 0, amountAvailableForWithdrawal: 0, bankName: 'HDFC', ifscCode: 'HDFC0001234' });
        expect(db.store[TXNS].map((t) => t.bankAcId)).toEqual([HOLD, HOLD, 'other']);
        expect(db.store[WD][0].bankAcId).toBe(HOLD); expect(db.store[WD][1].qrId).toBe('q');
        expect(JSON.parse(db.store[DAILY][0].totalsJson)).toEqual({ [HOLD]: 5000, other: 1 });
        expect(db.store[RELEASES][0].bankAcId).toBe(HOLD);
        expect(JSON.parse(db.store[DAILY_WD][0].totalsJson)).toEqual({ [HOLD]: { direct: { paidPaise: 9, commissionPaise: 1, count: 1 } } });
        // a repeat needs allowIncrement and goes to _hold2
        const again = await request(app).post(`/bank-acs/${AC}/hold-and-reset`).set(as('admin1')).send({ confirm: true });
        expect(again.status).toBe(409); expect(again.body.nextHoldId).toBe(`${AC}_hold2`);
    });
});
