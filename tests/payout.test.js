/**
 * Customer Payout (payout.js) — money-path tests.
 *   • request holds amount+commission in the wallet (paise, ceil commission), 409 when insufficient
 *   • lock fails closed (contention / Redis error → 409), lock always released (Lua eval)
 *   • paid is exactly-once (re-read under lock; idempotent ledger row), reject releases hold only
 *   • admin adjust: debit blocked below zero, refId idempotency
 *   • creditWalletFromWithdrawal idempotent on withdrawal id
 *   • withdraw.js approve_new mode:'wallet' → credit called, no UTR needed, no commission docs
 */
const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');

jest.mock('../userMetaCache', () => ({
    getUserMeta: jest.fn(),
    invalidate: jest.fn(),
}));
// Dashboard counters are a 2s in-memory batcher — mock so tests can assert deltas without timers.
jest.mock('../dashboardCounters', () => ({ updateDashboardCounter: jest.fn().mockResolvedValue() }));
const { updateDashboardCounter } = require('../dashboardCounters');
const counterDeltas = () => updateDashboardCounter.mock.calls.map((c) => [c[2], c[3]]);

// withdraw.js reads max_withdrawal_requests via ConfigManager (uninitialised here → known TDZ).
const mockConfig = { max_withdrawal_requests: 2 };
jest.mock('../configManager', () => ({
    get: jest.fn((key, def = null) => (key in mockConfig ? mockConfig[key] : def)),
    refresh: jest.fn().mockResolvedValue({}),
    getConfig: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(),
}));
const userMetaCache = require('../userMetaCache');

const asUser = (userId = 'user1', role = 'user') => (req, _res, next) => {
    req.user = { userId, role, $id: userId, labels: [] };
    next();
};
const adminOrLabel = () => asUser('admin1', 'admin');

function makeRedis(overrides = {}) {
    return { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1), ...overrides };
}

/** In-memory Appwrite stub: enough listDocuments filtering for the payout module's queries. */
function makeDb(seed = {}) {
    const store = {};
    for (const [col, docs] of Object.entries(seed)) store[col] = docs.map((d) => ({ ...d }));
    let seq = 0;
    const col = (c) => (store[c] = store[c] || []);
    // Parse the Query JSON strings the module builds.
    const parse = (q) => { try { return JSON.parse(q); } catch { return null; } };
    const db = {
        store,
        listDocuments: jest.fn(async (_db, c, queries = []) => {
            let docs = col(c).slice();
            let limit = 25;
            for (const raw of queries) {
                const q = parse(raw);
                if (!q) continue;
                if (q.method === 'equal') {
                    const vals = q.values;
                    docs = docs.filter((d) => vals.includes(d[q.attribute]));
                } else if (q.method === 'notEqual') {
                    docs = docs.filter((d) => d[q.attribute] !== q.values[0]);
                } else if (q.method === 'limit') limit = q.values[0];
            }
            return { documents: docs.slice(0, limit), total: docs.length };
        }),
        getDocument: jest.fn(async (_db, c, id) => {
            const d = col(c).find((x) => x.$id === id);
            if (!d) { const e = new Error('Document with the requested ID could not be found'); e.code = 404; throw e; }
            return { ...d };
        }),
        createDocument: jest.fn(async (_db, c, _id, data) => {
            const doc = { $id: `${c}_${++seq}`, ...data };
            col(c).push(doc);
            return { ...doc };
        }),
        updateDocument: jest.fn(async (_db, c, id, data) => {
            const d = col(c).find((x) => x.$id === id);
            if (!d) throw new Error('not found');
            Object.assign(d, data);
            return { ...d };
        }),
        deleteDocument: jest.fn(async (_db, c, id) => {
            const arr = col(c);
            const i = arr.findIndex((x) => x.$id === id);
            if (i >= 0) arr.splice(i, 1);
            return {};
        }),
    };
    return db;
}

const COLS = {
    USERS: 'users_meta', WD: 'withdrawals', WALLETS: 'wallets', TXNS: 'wallet_txns',
    ACCOUNTS: 'accounts', PAYOUTS: 'payouts', COMM: 'payout_comm', DAILY: 'daily_payout_comm',
    MONTHLY: 'monthly_payout_comm', ALLTIME: 'alltime_payout_comm',
};

// `label` = the authenticateAdminOrLabel factory; defaults to injecting admin1.
function buildPayout(db, redis, auth = asUser('user1'), label = adminOrLabel) {
    let mod;
    jest.isolateModules(() => {
        const factory = require('../payout.js');
        mod = factory(db, { unique: () => 'uid' }, Query, 'db1',
            COLS.USERS, COLS.WD, COLS.WALLETS, COLS.TXNS, COLS.ACCOUNTS, COLS.PAYOUTS, COLS.COMM, COLS.DAILY,
            auth, label, redis, COLS.MONTHLY, COLS.ALLTIME);
    });
    const app = express();
    app.use(express.json());
    app.use('/', mod.router);
    return { app, mod };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.max_withdrawal_requests = 2;
    delete mockConfig.withdrawal_time_windows_enabled;
    // user1 pays 2% payout commission, parent sub1 adds 1%; admin1 is the admin
    userMetaCache.getUserMeta.mockImplementation(async (id) => ({
        user1: { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1', payoutCommission: 2 },
        sub1: { $id: 'sub1', userId: 'sub1', role: 'subadmin', parentId: null, payoutCommission: 1 },
        admin1: { $id: 'admin1', userId: 'admin1', role: 'admin', parentId: null },
    })[id] || null);
});

const ACCOUNT = { customerName: 'Ravi Kumar', bankName: 'SBI', ifscCode: 'SBIN0001234', accountNumber: '12345678901', confirmAccountNumber: '12345678901' };

describe('POST /requests — hold + validation', () => {
    test('holds amount+commission (ceil, paise) and snapshots the account', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis());
        // 333.33 → 33333 paise; 3% → ceil(999.99) = 1000 paise
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'imps', amount: 333.33, notes: 'rent' });
        expect(res.status).toBe(201);
        expect(res.body.payout).toMatchObject({ amountPaise: 33333, commissionPaise: 1000, totalPaise: 34333, commissionRate: 3, mode: 'IMPS', status: 'pending', accountBankingStatus: 'not_added', ifscCode: 'SBIN0001234' });
        expect(db.store[COLS.WALLETS][0]).toMatchObject({ balancePaise: 100000, holdPaise: 34333 });
        expect(db.store[COLS.ACCOUNTS]).toHaveLength(1);
        expect(db.store[COLS.TXNS] || []).toHaveLength(0); // holds write no ledger row
    });

    test('409 when available (balance - hold) is insufficient; nothing written', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 10000, holdPaise: 5000 }] });
        const { app } = buildPayout(db, makeRedis());
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 50 }); // 5000 + 150 > 5000
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/insufficient/i);
        expect(db.store[COLS.PAYOUTS] || []).toHaveLength(0);
        expect(db.store[COLS.WALLETS][0].holdPaise).toBe(5000);
    });

    test('rolls back the hold when the payout doc create fails', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const origCreate = db.createDocument.getMockImplementation();
        db.createDocument.mockImplementation(async (d, c, id, data) => {
            if (c === COLS.PAYOUTS) throw new Error('appwrite down');
            return origCreate(d, c, id, data);
        });
        const { app } = buildPayout(db, makeRedis());
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 100 });
        expect(res.status).toBe(500);
        expect(db.store[COLS.WALLETS][0].holdPaise).toBe(0);
    });

    test.each([
        [{ ...ACCOUNT, confirmAccountNumber: '999', mode: 'NEFT', amount: 10 }, /do not match/i],
        [{ ...ACCOUNT, ifscCode: 'BAD', mode: 'NEFT', amount: 10 }, /ifsc/i],
        [{ ...ACCOUNT, mode: 'CASH', amount: 10 }, /mode/i],
        [{ ...ACCOUNT, mode: 'UPI', amount: -1 }, /amount/i],
    ])('400 on bad input %#', async (body, re) => {
        const { app } = buildPayout(makeDb(), makeRedis());
        const res = await request(app).post('/requests').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(re);
    });

    test('accountId belonging to another user → 404', async () => {
        const db = makeDb({ [COLS.ACCOUNTS]: [{ $id: 'acc9', userId: 'someoneElse', ...ACCOUNT }] });
        const { app } = buildPayout(db, makeRedis());
        const res = await request(app).post('/requests').send({ accountId: 'acc9', mode: 'NEFT', amount: 10 });
        expect(res.status).toBe(404);
    });

    test('UPI mode requires a UPI ID on the account; invalid VPA → 400; valid VPA is snapshotted', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis());
        const noVpa = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'UPI', amount: 10 });
        expect(noVpa.status).toBe(400);
        expect(noVpa.body.error).toMatch(/upi id/i);
        expect(db.store[COLS.WALLETS][0].holdPaise).toBe(0);
        const bad = await request(app).post('/requests').send({ ...ACCOUNT, upiId: 'not-a-vpa', mode: 'UPI', amount: 10 });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/invalid upi/i);
        const ok = await request(app).post('/requests').send({ ...ACCOUNT, upiId: 'ravi@okaxis', mode: 'upi', amount: 10 });
        expect(ok.status).toBe(201);
        expect(ok.body.payout).toMatchObject({ mode: 'UPI', upiId: 'ravi@okaxis' });
        // the reused account got its missing upiId filled in (never overwritten afterwards)
        expect(db.store[COLS.ACCOUNTS][0].upiId).toBe('ravi@okaxis');
        const other = await request(app).post('/requests').send({ ...ACCOUNT, upiId: 'other@ybl', mode: 'NEFT', amount: 10 });
        expect(other.status).toBe(201);
        expect(db.store[COLS.ACCOUNTS][0].upiId).toBe('ravi@okaxis');
    });

    test('UPI mode with accountId: upiId in body fills a missing one on the saved account', async () => {
        const db = makeDb({
            [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }],
            [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', customerName: 'Ravi', bankName: 'SBI', ifscCode: 'SBIN0001234', accountNumber: '12345678901', upiId: null }],
        });
        const { app } = buildPayout(db, makeRedis());
        expect((await request(app).post('/requests').send({ accountId: 'acc1', mode: 'UPI', amount: 10 })).status).toBe(400);
        const ok = await request(app).post('/requests').send({ accountId: 'acc1', upiId: 'ravi@okaxis', mode: 'UPI', amount: 10 });
        expect(ok.status).toBe(201);
        expect(ok.body.payout.upiId).toBe('ravi@okaxis');
        expect(db.store[COLS.ACCOUNTS][0].upiId).toBe('ravi@okaxis');
    });

    test('invalid rate / insufficient balance are rejected BEFORE any account is created', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis());
        const poor = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
        expect(poor.status).toBe(409);
        userMetaCache.getUserMeta.mockResolvedValue({ userId: 'user1', parentId: null, payoutCommission: 150 });
        const bad = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 0.5 });
        expect(bad.status).toBe(422);
        expect(db.store[COLS.ACCOUNTS] || []).toHaveLength(0);
        expect(db.store[COLS.PAYOUTS] || []).toHaveLength(0);
    });

    test('concurrent add of the same account: unique-index rejection falls back to the winner', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const origCreate = db.createDocument.getMockImplementation();
        let first = true;
        db.createDocument.mockImplementation(async (d, c, id, data) => {
            if (c === COLS.ACCOUNTS && first) {
                first = false;
                db.store[COLS.ACCOUNTS] = [{ $id: 'accWinner', userId: 'user1', ...data }]; // the other request won the race
                const e = new Error('Document with the requested ID already exists'); e.code = 409; throw e;
            }
            return origCreate(d, c, id, data);
        });
        const { app } = buildPayout(db, makeRedis());
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
        expect(res.status).toBe(201);
        expect(res.body.payout.accountId).toBe('accWinner');
        expect(db.store[COLS.ACCOUNTS]).toHaveLength(1);
    });

    test('reuses an existing account for the same userId+accountNumber', async () => {
        const db = makeDb({
            [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }],
            [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', customerName: 'Old Name', bankName: 'SBI', ifscCode: 'SBIN0001234', accountNumber: '12345678901', bankingStatus: 'added' }],
        });
        const { app } = buildPayout(db, makeRedis());
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'RTGS', amount: 10 });
        expect(res.status).toBe(201);
        expect(res.body.payout).toMatchObject({ accountId: 'acc1', customerName: 'Old Name', accountBankingStatus: 'added' });
        expect(db.store[COLS.ACCOUNTS]).toHaveLength(1);
    });
});

describe('wallet lock', () => {
    test('contention → 409 and no writes', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis({ set: jest.fn().mockResolvedValue(null) }));
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
        expect(res.status).toBe(409);
        expect(db.updateDocument).not.toHaveBeenCalled();
    });

    test('Redis error fails closed → 409', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis({ set: jest.fn().mockRejectedValue(new Error('ECONNRESET')) }));
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
        expect(res.status).toBe(409);
        expect(db.updateDocument).not.toHaveBeenCalled();
    });

    test('lock released via Lua eval even when the body throws', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        db.createDocument.mockImplementation(async (d, c) => { if (c === COLS.PAYOUTS) throw new Error('appwrite down'); return { $id: 'x' }; });
        const redis = makeRedis();
        const { app } = buildPayout(db, redis);
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
        expect(res.status).toBe(500);
        expect(redis.set).toHaveBeenCalledWith('lock:payoutwallet:user1', expect.any(String), { NX: true, EX: 15 });
        expect(redis.eval).toHaveBeenCalledTimes(1);
        expect(redis.eval.mock.calls[0][1].keys).toEqual(['lock:payoutwallet:user1']);
    });
});

describe('admin paid / reject', () => {
    const pending = () => ({
        $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'acc1', customerName: 'Ravi', accountNumber: '12345678901', mode: 'IMPS',
        amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, commissionRate: 3, userCommissionRate: 2, parentCommissionRate: 1, status: 'pending',
    });
    const seed = () => ({
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 10300 }],
        [COLS.PAYOUTS]: [pending()],
        [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }],
    });

    test('paid: debits balance+hold, writes ledger row, records split commission + daily rollup', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(res.status).toBe(200);
        expect(res.body.payout).toMatchObject({ status: 'paid', referenceNumber: 'UTR12345', processedBy: 'admin1' });
        expect(res.body.payout.processedAt).toBeTruthy();
        expect(db.store[COLS.WALLETS][0]).toMatchObject({ balancePaise: 39700, holdPaise: 0 });
        expect(db.store[COLS.TXNS]).toHaveLength(1);
        expect(db.store[COLS.TXNS][0]).toMatchObject({ type: 'payout_paid', direction: 'debit', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, refId: 'cpo_1', balanceAfterPaise: 39700, referenceNumber: 'UTR12345' });
        // 2% of 10000 → sub1 (200), 1% → admin1 (100)
        expect(db.store[COLS.COMM].map((c) => [c.userId, c.amount, c.earningType]).sort()).toEqual([['admin1', 100, 'admin'], ['sub1', 200, 'subadmin']]);
        expect(JSON.parse(db.store[COLS.DAILY][0].commissionsJson)).toEqual({ sub1: 200, admin1: 100 });
        const month = new Date().toISOString().slice(0, 7); // IST month == UTC month except a few hours; assert shape via the row itself
        expect(db.store[COLS.MONTHLY].map((r) => [r.userId, r.totalCommissionPaise]).sort()).toEqual([['admin1', 100], ['sub1', 200]]);
        expect(db.store[COLS.MONTHLY][0].month).toMatch(/^\d{4}-\d{2}$/);
        expect(db.store[COLS.ALLTIME].map((r) => [r.userId, r.totalCommissionPaise]).sort()).toEqual([['admin1', 100], ['sub1', 200]]);
        void month;
    });

    test('paid twice for two requests accumulates monthly/all-time totals (merge, not overwrite)', async () => {
        const s = seed();
        s[COLS.PAYOUTS].push({ ...pending(), $id: 'p2', id: 'cpo_2' });
        s[COLS.WALLETS][0].holdPaise = 20600;
        const db = makeDb(s);
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        await request(app).post('/admin/requests/cpo_2/paid').send({ referenceNumber: 'UTR67890' });
        expect(db.store[COLS.MONTHLY]).toHaveLength(2);
        expect(db.store[COLS.ALLTIME].find((r) => r.userId === 'sub1').totalCommissionPaise).toBe(400);
        expect(db.store[COLS.MONTHLY].find((r) => r.userId === 'admin1').totalCommissionPaise).toBe(200);
        expect(JSON.parse(db.store[COLS.DAILY][0].commissionsJson)).toEqual({ sub1: 400, admin1: 200 });
    });

    test('rollup failure flags commissionRollupFailed but keeps the payout paid', async () => {
        const db = makeDb(seed());
        const origCreate = db.createDocument.getMockImplementation();
        db.createDocument.mockImplementation(async (d, c, id, data) => {
            if (c === COLS.MONTHLY) throw new Error('rollup down');
            return origCreate(d, c, id, data);
        });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(res.status).toBe(200);
        expect(db.store[COLS.PAYOUTS][0]).toMatchObject({ status: 'paid', commissionRollupFailed: true });
        expect(db.store[COLS.COMM]).toHaveLength(2); // raw txns (source of truth) still written
    });

    test('parent subadmin no longer exists → whole held commission goes to admin', async () => {
        userMetaCache.getUserMeta.mockImplementation(async (id) => ({
            user1: { userId: 'user1', role: 'user', parentId: 'ghost', payoutCommission: 2 },
            admin1: { userId: 'admin1', role: 'admin' },
        })[id] || null);
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' })).status).toBe(200);
        expect(db.store[COLS.COMM].map((c) => [c.userId, c.amount])).toEqual([['admin1', 300]]); // 2% + 1% of 10000
    });

    test('UPI payout ledger note shows the VPA', async () => {
        const s = seed();
        s[COLS.PAYOUTS][0] = { ...pending(), mode: 'UPI', upiId: 'ravi@okaxis' };
        const db = makeDb(s);
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(db.store[COLS.TXNS][0].notes).toBe('UPI payout to Ravi (ravi@okaxis)');
    });

    test('paid is exactly-once: second call → 400, wallet untouched', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR99999' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/paid/i);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(39700);
        expect(db.store[COLS.TXNS]).toHaveLength(1);
    });

    test('paid: status flipped by a racing admin between pre-check and lock → 409, no debit', async () => {
        const db = makeDb(seed());
        db.getDocument.mockImplementationOnce(async () => ({ ...pending(), status: 'paid' }));
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(res.status).toBe(409);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(50000);
    });

    test('paid: existing ledger row (crash after debit) → skips debit, still flips status', async () => {
        const s = seed();
        s[COLS.WALLETS][0] = { $id: 'w1', userId: 'user1', balancePaise: 39700, holdPaise: 0 };
        s[COLS.TXNS] = [{ $id: 't1', type: 'payout_paid', refId: 'cpo_1', userId: 'user1' }];
        const db = makeDb(s);
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(res.status).toBe(200);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(39700);
        expect(db.store[COLS.TXNS]).toHaveLength(1);
        expect(db.store[COLS.PAYOUTS][0].status).toBe('paid');
    });

    test('paid: short reference number → 400 before any write', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: '12' });
        expect(res.status).toBe(400);
        expect(db.updateDocument).not.toHaveBeenCalled();
    });

    test('commission failure never fails the paid response', async () => {
        const db = makeDb(seed());
        const origCreate = db.createDocument.getMockImplementation();
        db.createDocument.mockImplementation(async (d, c, id, data) => {
            if (c === COLS.COMM) throw new Error('boom');
            return origCreate(d, c, id, data);
        });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(res.status).toBe(200);
        expect(db.store[COLS.PAYOUTS][0].status).toBe('paid');
    });

    test('reject: releases hold only, no ledger row, no commission, reason saved', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/requests/cpo_1/reject').send({ reason: 'Wrong IFSC' });
        expect(res.status).toBe(200);
        expect(res.body.payout).toMatchObject({ status: 'rejected', rejectionReason: 'Wrong IFSC', referenceNumber: null });
        expect(db.store[COLS.WALLETS][0]).toMatchObject({ balancePaise: 50000, holdPaise: 0 });
        expect(db.store[COLS.TXNS] || []).toHaveLength(0);
        expect(db.store[COLS.COMM] || []).toHaveLength(0);
    });

    test('reject then paid → 400', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await request(app).post('/admin/requests/cpo_1/reject').send({ reason: 'Wrong IFSC' });
        const res = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(res.status).toBe(400);
    });
});

describe('service timeline', () => {
    test('request on a not-added account: addedToBankingAt null → stamped when admin tags the account added', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(new Date('2026-09-06T10:00:00.000Z'));
        try {
            const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
            const { app } = buildPayout(db, makeRedis());
            const created = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
            expect(created.body.payout).toMatchObject({ requestedAt: '2026-09-06T10:00:00.000Z', addedToBankingAt: null, addedInMinutes: null, paidAt: null, paidInMinutes: null });

            jest.setSystemTime(new Date('2026-09-06T10:12:00.000Z'));
            const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
            const tag = await request(adminApp).patch(`/admin/accounts/${created.body.payout.accountId}/banking-status`).send({ bankingStatus: 'added' });
            expect(tag.status).toBe(200);
            expect(tag.body.stampedRequests).toBe(1);

            jest.setSystemTime(new Date('2026-09-06T10:30:30.000Z'));
            const paid = await request(adminApp).post(`/admin/requests/${created.body.payout.id}/paid`).send({ referenceNumber: 'UTR12345' });
            expect(paid.body.payout).toMatchObject({
                addedToBankingAt: '2026-09-06T10:12:00.000Z', addedInMinutes: 12,
                paidAt: '2026-09-06T10:30:30.000Z', paidInMinutes: 31, rejectedAt: null, rejectedInMinutes: null,
            });
            // tagging again must not re-stamp a resolved request
            expect((await request(adminApp).patch(`/admin/accounts/${created.body.payout.accountId}/banking-status`).send({ bankingStatus: 'added' })).body.stampedRequests).toBe(0);
        } finally { jest.useRealTimers(); }
    });

    test('request on an already-added account inherits the tag time; reject stamps rejectedAt', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(new Date('2026-09-06T09:00:00.000Z'));
        try {
            const db = makeDb({
                [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }],
                [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', customerName: 'R', bankName: 'SBI', ifscCode: 'SBIN0001234', accountNumber: '12345678901', bankingStatus: 'added', bankingStatusUpdatedAt: '2026-09-01T00:00:00.000Z' }],
            });
            const { app } = buildPayout(db, makeRedis());
            const created = await request(app).post('/requests').send({ accountId: 'acc1', mode: 'NEFT', amount: 10 });
            expect(created.body.payout).toMatchObject({ addedToBankingAt: '2026-09-01T00:00:00.000Z', addedInMinutes: 0 }); // clamped, never negative
            jest.setSystemTime(new Date('2026-09-06T09:05:00.000Z'));
            const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
            const rej = await request(adminApp).post(`/admin/requests/${created.body.payout.id}/reject`).send({ reason: 'Wrong IFSC' });
            expect(rej.body.payout).toMatchObject({ rejectedAt: '2026-09-06T09:05:00.000Z', rejectedInMinutes: 5, paidAt: null });
        } finally { jest.useRealTimers(); }
    });
});

describe('dashboard counters', () => {
    test('request → paid: pending in/out, paid, wallet balance, commission profits', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }], [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }] });
        const { app } = buildPayout(db, makeRedis());
        const created = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 100 }); // 10000 + 300 commission
        expect(created.status).toBe(201);
        expect(counterDeltas()).toEqual([['totalCustomerPayoutPendingAmount', 10000], ['totalCustomerPayoutPendingCount', 1]]);
        updateDashboardCounter.mockClear();

        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(adminApp).post(`/admin/requests/${created.body.payout.id}/paid`).send({ referenceNumber: 'UTR12345' })).status).toBe(200);
        expect(counterDeltas()).toEqual([
            ['totalPayoutWalletBalance', -10300],
            ['totalCustomerPayoutPendingAmount', -10000], ['totalCustomerPayoutPendingCount', -1],
            ['totalCustomerPayoutPaid', 10000], ['totalCustomerPayoutPaidCount', 1],
            ['totalPayoutMerchantProfit', 200], ['totalPayoutAdminProfit', 100],
        ]);
    });

    test('reject reverses pending only; adjust and withdrawal credit move the wallet balance', async () => {
        const db = makeDb({
            [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 10300 }],
            [COLS.PAYOUTS]: [{ $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'a', status: 'pending', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300 }],
        });
        const { app, mod } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).post('/admin/requests/cpo_1/reject').send({ reason: 'Wrong IFSC' })).status).toBe(200);
        expect(counterDeltas()).toEqual([['totalCustomerPayoutPendingAmount', -10000], ['totalCustomerPayoutPendingCount', -1]]);
        updateDashboardCounter.mockClear();

        await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'debit', amount: 5, notes: 'manual' });
        await mod.creditWalletFromWithdrawal({ $id: 'wd', id: 'wdh_9', userId: 'user1', qrId: 'qr1', preAmount: 20 });
        expect(counterDeltas()).toEqual([['totalPayoutWalletBalance', -500], ['totalPayoutWalletBalance', 2000]]);
    });

    test('wallet doc keeps lifetime totals (credited / paid out / commission / admin debit / paidCount)', async () => {
        const db = makeDb({ [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }] });
        const { app, mod } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await mod.creditWalletFromWithdrawal({ $id: 'wd', id: 'wdh_1', userId: 'user1', qrId: 'qr1', preAmount: 1000 }); // +100000
        await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'credit', amount: 50, notes: 'bonus' });   // +5000
        await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'debit', amount: 10, notes: 'fix' });      // -1000
        db.store[COLS.PAYOUTS] = [{ $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'a', customerName: 'R', accountNumber: '1', mode: 'NEFT', amountPaise: 20000, commissionPaise: 600, totalPaise: 20600, userCommissionRate: 3, parentCommissionRate: 0, status: 'pending' }];
        db.store[COLS.WALLETS][0].holdPaise = 20600;
        expect((await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' })).status).toBe(200);
        expect(db.store[COLS.WALLETS][0]).toMatchObject({
            balancePaise: 100000 + 5000 - 1000 - 20600, holdPaise: 0,
            totalCreditedPaise: 105000, totalAdminDebitPaise: 1000, totalPaidOutPaise: 20000, totalPayoutCommissionPaise: 600, paidCount: 1,
        });
        const view = (await request(app).get('/admin/wallets?userId=user1')).body.wallet;
        expect(view).toMatchObject({ totalCreditedPaise: 105000, totalPaidOutPaise: 20000, paidCount: 1 });
    });

    test('a failing counter never fails the money operation', async () => {
        updateDashboardCounter.mockRejectedValueOnce(new Error('counters down'));
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis());
        const res = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 100 });
        expect(res.status).toBe(201);
        expect(db.store[COLS.WALLETS][0].holdPaise).toBe(10300);
    });
});

describe('admin wallet adjust', () => {
    test('credit creates wallet if missing and writes ledger row', async () => {
        const db = makeDb();
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'credit', amount: 250.5, notes: 'Paid outside platform', referenceNumber: 'REF1' });
        expect(res.status).toBe(200);
        expect(res.body.wallet).toMatchObject({ balancePaise: 25050, holdPaise: 0, availablePaise: 25050 });
        expect(res.body.transaction).toMatchObject({ type: 'admin_credit', direction: 'credit', amountPaise: 25050, referenceNumber: 'REF1', notes: 'Paid outside platform', createdBy: 'admin1' });
    });

    test('debit below available → 409', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 10000, holdPaise: 8000 }] });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'debit', amount: 50, notes: 'oops' });
        expect(res.status).toBe(409);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(10000);
    });

    test('same refId twice → second is a no-op duplicate', async () => {
        const db = makeDb();
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const body = { userId: 'user1', direction: 'credit', amount: 10, notes: 'manual', refId: 'client-uuid-1' };
        await request(app).post('/admin/wallet/adjust').send(body);
        const res = await request(app).post('/admin/wallet/adjust').send(body);
        expect(res.status).toBe(200);
        expect(res.body.duplicate).toBe(true);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(1000);
        expect(db.store[COLS.TXNS]).toHaveLength(1);
    });

    test('notes required', async () => {
        const { app } = buildPayout(makeDb(), makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'credit', amount: 10 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/notes/i);
    });
});

describe('creditWalletFromWithdrawal', () => {
    const w = { $id: 'wd1', id: 'wdh_1', userId: 'user1', qrId: 'qr1', preAmount: 500, amount: 500, mode: 'wallet', status: 'approved' };

    test('credits preAmount in paise and is idempotent on withdrawal id', async () => {
        const db = makeDb();
        const { mod } = buildPayout(db, makeRedis());
        const first = await mod.creditWalletFromWithdrawal(w);
        const second = await mod.creditWalletFromWithdrawal(w);
        expect(first.skipped).toBe(false);
        expect(second.skipped).toBe(true);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(50000);
        expect(db.store[COLS.TXNS]).toHaveLength(1);
        expect(db.store[COLS.TXNS][0]).toMatchObject({ type: 'withdrawal_credit', refId: 'wdh_1', amountPaise: 50000 });
    });

    test('throws (409) when the wallet lock cannot be taken', async () => {
        const { mod } = buildPayout(makeDb(), makeRedis({ set: jest.fn().mockResolvedValue(null) }));
        await expect(mod.creditWalletFromWithdrawal(w)).rejects.toMatchObject({ status: 409 });
    });

    test('retry-credit endpoint re-runs the credit for a flagged approved wallet withdrawal', async () => {
        const db = makeDb({ [COLS.WD]: [{ ...w, walletCreditFailed: true }] });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).post('/admin/wallet/retry-credit').send({ withdrawalId: 'wdh_1' });
        expect(res.status).toBe(200);
        expect(res.body.skipped).toBe(false);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(50000);
        expect(db.store[COLS.WD][0].walletCreditFailed).toBe(false);
    });

    test('retry-credit refuses a non-wallet or pending withdrawal', async () => {
        const db = makeDb({ [COLS.WD]: [{ ...w, mode: 'bank' }, { ...w, $id: 'wd2', id: 'wdh_2', status: 'pending' }] });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).post('/admin/wallet/retry-credit').send({ withdrawalId: 'wdh_1' })).status).toBe(400);
        expect((await request(app).post('/admin/wallet/retry-credit').send({ withdrawalId: 'wdh_2' })).status).toBe(400);
        expect(db.store[COLS.WALLETS] || []).toHaveLength(0);
    });
});

describe('accounts + lists', () => {
    test('POST /accounts validates and dedupes; admin PATCH banking-status', async () => {
        const db = makeDb();
        const { app } = buildPayout(db, makeRedis());
        const a = await request(app).post('/accounts').send(ACCOUNT);
        expect(a.status).toBe(201);
        expect(a.body.account.bankingStatus).toBe('not_added');
        const b = await request(app).post('/accounts').send(ACCOUNT);
        expect(b.status).toBe(200);
        expect(b.body.created).toBe(false);

        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const p = await request(adminApp).patch(`/admin/accounts/${a.body.account.$id}/banking-status`).send({ bankingStatus: 'added' });
        expect(p.status).toBe(200);
        expect(p.body.account).toMatchObject({ bankingStatus: 'added', bankingStatusUpdatedBy: 'admin1' });
        expect((await request(adminApp).patch(`/admin/accounts/${a.body.account.$id}/banking-status`).send({ bankingStatus: 'weird' })).status).toBe(400);
    });

    test('GET /wallet returns zeros with no wallet doc; invalid cursor → 400', async () => {
        const { app } = buildPayout(makeDb(), makeRedis());
        const res = await request(app).get('/wallet');
        expect(res.body.wallet).toMatchObject({ balancePaise: 0, holdPaise: 0, availablePaise: 0, availableRs: 0 });
        expect((await request(app).get('/requests?cursor=bad cursor!')).status).toBe(400);
        expect((await request(app).get('/wallet/transactions?type=nope')).status).toBe(400);
    });

    test('GET /commission-preview reports sufficiency', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 10300, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis());
        const ok = await request(app).get('/commission-preview?amount=100');
        expect(ok.body).toMatchObject({ amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, commissionRate: 3, sufficient: true });
        const no = await request(app).get('/commission-preview?amount=100.01');
        expect(no.body.sufficient).toBe(false);
    });

    test('subadmin commission list / monthly / all-time are scoped to own userId', async () => {
        const db = makeDb({
            [COLS.COMM]: [{ $id: 'c1', userId: 'sub1', amount: 200, sourcePayoutId: 'cpo_1', earningType: 'subadmin', createdAt: 'x' }, { $id: 'c2', userId: 'admin1', amount: 100, sourcePayoutId: 'cpo_1', earningType: 'admin', createdAt: 'x' }],
            [COLS.MONTHLY]: [{ $id: 'm1', userId: 'sub1', month: '2026-09', totalCommissionPaise: 200 }, { $id: 'm2', userId: 'admin1', month: '2026-09', totalCommissionPaise: 100 }],
            [COLS.ALLTIME]: [{ $id: 'a1', userId: 'sub1', totalCommissionPaise: 900 }, { $id: 'a2', userId: 'admin1', totalCommissionPaise: 450 }],
        });
        const sub = asUser('sub1', 'subadmin');
        const { app } = buildPayout(db, makeRedis(), sub, () => sub);
        const res = await request(app).get('/admin/commissions?userId=admin1');
        expect(res.status).toBe(200);
        expect(res.body.commissions.map((c) => c.userId)).toEqual(['sub1']);
        const m = await request(app).get('/admin/commissions/monthly?month=2026-09&userId=admin1');
        expect(m.body).toMatchObject({ month: '2026-09', userId: 'sub1', grandTotalPaise: 200 });
        expect(m.body.totals).toEqual([{ $id: 'm1', userId: 'sub1', month: '2026-09', totalCommissionPaise: 200, totalRs: 2 }]);
        const a = await request(app).get('/admin/commissions/all-time');
        expect(a.body.totals.map((t) => t.userId)).toEqual(['sub1']);
        expect((await request(app).get('/admin/commissions/monthly?month=bad')).status).toBe(400);
    });

    test('admin monthly/all-time list all users (or one with ?userId)', async () => {
        const db = makeDb({
            [COLS.MONTHLY]: [{ $id: 'm1', userId: 'sub1', month: '2026-09', totalCommissionPaise: 200 }, { $id: 'm2', userId: 'admin1', month: '2026-09', totalCommissionPaise: 100 }, { $id: 'm3', userId: 'sub1', month: '2026-08', totalCommissionPaise: 50 }],
            [COLS.ALLTIME]: [{ $id: 'a1', userId: 'sub1', totalCommissionPaise: 900 }, { $id: 'a2', userId: 'admin1', totalCommissionPaise: 450 }],
        });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const m = await request(app).get('/admin/commissions/monthly?month=2026-09');
        expect(m.body.grandTotalPaise).toBe(300);
        expect(m.body.totals).toHaveLength(2);
        const one = await request(app).get('/admin/commissions/all-time?userId=sub1');
        expect(one.body.totals).toEqual([{ $id: 'a1', userId: 'sub1', month: null, totalCommissionPaise: 900, totalRs: 9 }]);
    });
});

describe('subadmin scoping on admin views', () => {
    // sub1 owns user1 and user2; userX belongs to someone else
    const seed = () => ({
        [COLS.USERS]: [
            { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1' },
            { $id: 'user2', userId: 'user2', role: 'user', parentId: 'sub1' },
            { $id: 'userX', userId: 'userX', role: 'user', parentId: 'subOther' },
        ],
        [COLS.PAYOUTS]: [
            { $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'acc1', status: 'pending', amountPaise: 1, commissionPaise: 0, totalPaise: 1, createdAt: 'x' },
            { $id: 'p2', id: 'cpo_2', userId: 'user2', accountId: 'acc2', status: 'paid', amountPaise: 1, commissionPaise: 0, totalPaise: 1, createdAt: 'x' },
            { $id: 'p3', id: 'cpo_3', userId: 'userX', accountId: 'acc3', status: 'pending', amountPaise: 1, commissionPaise: 0, totalPaise: 1, createdAt: 'x' },
            { $id: 'p4', id: 'cpo_4', userId: 'sub1', accountId: 'acc4', status: 'pending', amountPaise: 1, commissionPaise: 0, totalPaise: 1, createdAt: 'x' },
        ],
        [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', accountNumber: '1' }, { $id: 'acc3', userId: 'userX', accountNumber: '3' }],
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 5, holdPaise: 0 }, { $id: 'wX', userId: 'userX', balancePaise: 7, holdPaise: 0 }],
        [COLS.TXNS]: [{ $id: 't1', userId: 'user1', type: 'admin_credit', createdAt: 'x' }, { $id: 'tX', userId: 'userX', type: 'admin_credit', createdAt: 'x' }],
    });
    const asSub = () => { const sub = asUser('sub1', 'subadmin'); return [sub, () => sub]; };

    test('requests: only own users (plus self); ?userId of a foreign user → 403', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), ...asSub());
        const res = await request(app).get('/admin/requests');
        expect(res.status).toBe(200);
        expect(res.body.payouts.map((p) => p.id).sort()).toEqual(['cpo_1', 'cpo_2', 'cpo_4']);
        expect((await request(app).get('/admin/requests?userId=user2')).body.payouts.map((p) => p.id)).toEqual(['cpo_2']);
        expect((await request(app).get('/admin/requests?userId=userX')).status).toBe(403);
    });

    test('accounts, wallets, wallet transactions are scoped the same way', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), ...asSub());
        expect((await request(app).get('/admin/accounts')).body.accounts.map((a) => a.$id)).toEqual(['acc1']);
        expect((await request(app).get('/admin/wallets')).body.wallets.map((w) => w.userId)).toEqual(['user1']);
        expect((await request(app).get('/admin/wallets?userId=userX')).status).toBe(403);
        expect((await request(app).get('/admin/wallet/transactions?userId=user1')).body.transactions).toHaveLength(1);
        expect((await request(app).get('/admin/wallet/transactions?userId=userX')).status).toBe(403);
    });

    test('subadmin with more than 100 users gets a chunked OR scope (no silent drop)', async () => {
        const users = Array.from({ length: 150 }, (_, i) => ({ $id: `u${i}`, userId: `u${i}`, role: 'user', parentId: 'sub1' }));
        const db = makeDb({ [COLS.USERS]: users, [COLS.PAYOUTS]: [{ $id: 'p', id: 'cpo_x', userId: 'u149', accountId: 'a', status: 'pending', amountPaise: 1, commissionPaise: 0, totalPaise: 1, createdAt: 'x' }] });
        // mock paginates by limit only; emulate cursor pages by slicing on cursorAfter
        const origList = db.listDocuments.getMockImplementation();
        db.listDocuments.mockImplementation(async (d, c, queries) => {
            if (c !== COLS.USERS) return origList(d, c, queries);
            const cur = queries.map((q) => JSON.parse(q)).find((q) => q.method === 'cursorAfter');
            const start = cur ? users.findIndex((u) => u.$id === cur.values[0]) + 1 : 0;
            return { documents: users.slice(start, start + 100), total: users.length };
        });
        const { app } = buildPayout(db, makeRedis(), ...asSub());
        const res = await request(app).get('/admin/requests');
        expect(res.status).toBe(200);
        // the scope query reached the payouts collection as an OR of two equal() chunks
        const payoutCall = db.listDocuments.mock.calls.find((c) => c[1] === COLS.PAYOUTS);
        const orQ = payoutCall[2].map((q) => JSON.parse(q)).find((q) => q.method === 'or');
        expect(orQ).toBeTruthy();
        expect(orQ.values).toHaveLength(2);
    });

    test('admin sees everything', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).get('/admin/requests')).body.payouts).toHaveLength(4);
        expect((await request(app).get('/admin/wallets')).body.wallets).toHaveLength(2);
    });
});

describe('delete customer accounts', () => {
    const seed = () => ({
        [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', accountNumber: '1' }, { $id: 'acc2', userId: 'user1', accountNumber: '2' }, { $id: 'accX', userId: 'userX', accountNumber: '3' }],
        [COLS.PAYOUTS]: [{ $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'acc2', status: 'pending' }, { $id: 'p0', id: 'cpo_0', userId: 'user1', accountId: 'acc1', status: 'paid' }],
    });

    test('user deletes own account; paid history is untouched; pending → 409; foreign → 404', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis());
        expect((await request(app).delete('/accounts/acc1')).status).toBe(200);
        expect(db.store[COLS.ACCOUNTS].map((a) => a.$id)).toEqual(['acc2', 'accX']);
        expect(db.store[COLS.PAYOUTS]).toHaveLength(2);
        const pending = await request(app).delete('/accounts/acc2');
        expect(pending.status).toBe(409);
        expect(pending.body.error).toMatch(/pending/i);
        expect((await request(app).delete('/accounts/accX')).status).toBe(404);
        expect((await request(app).delete('/accounts/nope')).status).toBe(404);
    });

    test('admin can delete any account (same pending guard)', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).delete('/admin/accounts/accX')).status).toBe(200);
        expect((await request(app).delete('/admin/accounts/acc2')).status).toBe(409);
        expect((await request(app).delete('/admin/accounts/accX')).status).toBe(404);
    });
});

// ─── withdraw.js integration: mode:'wallet' ──────────────────────────────────
describe('withdraw.js — mode:wallet', () => {
    function buildWithdraw(db, redis, credit, auth = asUser('admin1', 'admin')) {
        let router;
        jest.isolateModules(() => {
            router = require('../withdraw.js')(db, {}, {}, { unique: () => 'newId1' }, Query, 'db1', 'users_meta', 'qr_col', 'withdrawal_col', 'bucket1',
                'daily_qr', 'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'config_col',
                jest.fn().mockResolvedValue(), jest.fn(), auth, () => auth, auth, auth, auth,
                {}, auth, () => auth, redis, credit);
        });
        const app = express(); app.use(express.json()); app.use('/', router);
        return app;
    }
    const QR = () => ({ $id: 'q1', qrId: 'qr1', totalPayInAmount: 100000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0 });
    const pendingBank = (id) => ({ $id: id, id: `wdh_${id}`, userId: 'user1', qrId: 'qr1', mode: 'bank', status: 'pending', amount: 10, preAmount: 10, commission: 0 });

    test('wallet withdrawal ignores time windows and the max-pending cap (as a normal user)', async () => {
        mockConfig.withdrawal_time_windows_enabled = true; // whatever the clock says, wallet mode must pass
        const db = makeDb({ 'qr_col': [QR()], 'withdrawal_col': [pendingBank('a'), pendingBank('b')] }); // already at the cap of 2
        userMetaCache.getUserMeta.mockResolvedValue({ $id: 'user1', userId: 'user1', commission: 5, parentId: null });
        const app = buildWithdraw(db, makeRedis(), jest.fn(), asUser('user1', 'user'));
        const res = await request(app).post('/withdraw_new').send({ userId: 'user1', qrId: 'qr1', mode: 'wallet', amount: 200, preAmount: 200, commission: 0 });
        expect(res.status).toBe(200);
        expect(db.store['withdrawal_col']).toHaveLength(3);
    });

    test('direct withdrawal is still capped, and pending wallet rows do not count toward the cap', async () => {
        const db = makeDb({ 'qr_col': [QR()], 'withdrawal_col': [pendingBank('a'), { ...pendingBank('w'), mode: 'wallet' }] }); // 1 direct + 1 wallet pending
        userMetaCache.getUserMeta.mockResolvedValue({ $id: 'user1', userId: 'user1', commission: 0, parentId: null });
        const app = buildWithdraw(db, makeRedis(), jest.fn());
        const body = { userId: 'user1', qrId: 'qr1', holderName: 'A', mode: 'upi', upiId: 'a@ybl', amount: 10, preAmount: 10, commission: 0 };
        expect((await request(app).post('/withdraw_new').send(body)).status).toBe(200); // 1 direct pending < cap 2
        const capped = await request(app).post('/withdraw_new').send(body);            // now 2 direct pending
        expect(capped.status).toBe(400);
        expect(capped.body.error).toMatch(/maximum number of pending/i);
    });

    test('withdraw_new mode:wallet — no commission, no bank fields, ledger holds preAmount', async () => {
        const db = makeDb({
            'qr_col': [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 100000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0 }],
            'users_meta': [{ $id: 'user1', userId: 'user1', commission: 5, parentId: null }],
        });
        userMetaCache.getUserMeta.mockResolvedValue({ $id: 'user1', userId: 'user1', commission: 5, parentId: null }); // 5% direct rate must NOT apply
        const app = buildWithdraw(db, makeRedis(), jest.fn());
        const res = await request(app).post('/withdraw_new').send({ userId: 'user1', qrId: 'qr1', mode: 'wallet', amount: 200, preAmount: 200, commission: 0 });
        expect(res.status).toBe(200);
        expect(db.store['withdrawal_col'][0]).toMatchObject({ mode: 'wallet', commission: 0, totalCommissionRate: 0, holderName: 'Payout Wallet', upiId: null, accountNumber: null });
        expect(db.store['qr_col'][0]).toMatchObject({ withdrawalRequestedAmount: 20000, commissionOnHold: 0, amountAvailableForWithdrawal: 80000 });
    });

    test('withdraw_new mode:wallet rejects a non-zero commission', async () => {
        const db = makeDb({ 'qr_col': [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 100000 }] });
        userMetaCache.getUserMeta.mockResolvedValue({ $id: 'user1', userId: 'user1', commission: 5, parentId: null });
        const app = buildWithdraw(db, makeRedis(), jest.fn());
        const res = await request(app).post('/withdraw_new').send({ userId: 'user1', qrId: 'qr1', mode: 'wallet', amount: 210, preAmount: 200, commission: 10 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/mismatch/i);
    });

    test('approve_new mode:wallet — no UTR needed, credits wallet, no commission docs', async () => {
        const db = makeDb({
            'withdrawal_col': [{ $id: 'wd1', id: 'wdh_1', userId: 'user1', qrId: 'qr1', mode: 'wallet', status: 'pending', amount: 200, preAmount: 200, commission: 0 }],
            'qr_col': [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 100000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 20000, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0 }],
        });
        const credit = jest.fn().mockResolvedValue({ skipped: false, txn: { id: 'pwt_9' } });
        const app = buildWithdraw(db, makeRedis(), credit);
        const res = await request(app).post('/withdrawals/approve_new').send({ id: 'wdh_1' });
        expect(res.status).toBe(200);
        expect(credit).toHaveBeenCalledWith(expect.objectContaining({ id: 'wdh_1', userId: 'user1' }));
        expect(db.store['withdrawal_col'][0]).toMatchObject({ status: 'approved', utrNumber: 'pwt_9', walletCreditFailed: false });
        expect(db.store['qr_col'][0]).toMatchObject({ withdrawalRequestedAmount: 0, withdrawalApprovedAmount: 20000, commissionPaid: 0 });
        expect(db.store['commission_txs'] || []).toHaveLength(0);
        expect(counterDeltas()).toEqual(expect.arrayContaining([['totalAmountPaid', 20000], ['totalWithdrawalPendingAmount', -20000], ['totalPayoutWalletFunded', 20000]]));
    });

    test('approve_new mode:wallet — credit failure flags the withdrawal and returns 500 (QR already debited)', async () => {
        const db = makeDb({
            'withdrawal_col': [{ $id: 'wd1', id: 'wdh_1', userId: 'user1', qrId: 'qr1', mode: 'wallet', status: 'pending', amount: 200, preAmount: 200, commission: 0 }],
            'qr_col': [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 100000, withdrawalRequestedAmount: 20000 }],
        });
        const app = buildWithdraw(db, makeRedis(), jest.fn().mockRejectedValue(new Error('wallet busy')));
        const res = await request(app).post('/withdrawals/approve_new').send({ id: 'wdh_1' });
        expect(res.status).toBe(500);
        expect(db.store['withdrawal_col'][0]).toMatchObject({ status: 'approved', walletCreditFailed: true });
    });

    test('withdrawal lists expose walletCreditFailed so the admin UI can offer retry-credit', async () => {
        const db = makeDb({ 'withdrawal_col': [{ $id: 'wd1', id: 'wdh_1', userId: 'user1', mode: 'wallet', status: 'approved', amount: 200, walletCreditFailed: true }, { $id: 'wd2', id: 'wdh_2', userId: 'user1', mode: 'bank', status: 'pending', amount: 5 }] });
        const app = buildWithdraw(db, makeRedis(), jest.fn());
        const res = await request(app).get('/withdrawals_paginated');
        expect(res.status).toBe(200);
        expect(res.body.withdrawals.map((w) => [w.id, w.walletCreditFailed])).toEqual([['wdh_1', true], ['wdh_2', false]]);
    });

    test('approve_new direct (bank) still requires a UTR', async () => {
        const db = makeDb({ 'withdrawal_col': [{ $id: 'wd1', id: 'wdh_1', userId: 'user1', qrId: 'qr1', mode: 'bank', status: 'pending', amount: 200, preAmount: 200, commission: 0 }] });
        const app = buildWithdraw(db, makeRedis(), jest.fn());
        const res = await request(app).post('/withdrawals/approve_new').send({ id: 'wdh_1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/utr/i);
    });
});
