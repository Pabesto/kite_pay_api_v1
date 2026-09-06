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
// socket emitter stub (payout.js calls it fire-and-forget)
const mockEmit = jest.fn();
const emitted = () => mockEmit.mock.calls.map((c) => c[0]);

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
            // Minimal evaluator for the Query methods the module uses (nested `or` included).
            const matches = (d, q) => {
                const v = d[q.attribute];
                switch (q.method) {
                    case 'equal': return q.values.includes(v);
                    case 'notEqual': return v !== q.values[0];
                    case 'startsWith': return String(v ?? '').startsWith(q.values[0]);
                    case 'search': return String(v ?? '').toLowerCase().includes(String(q.values[0]).toLowerCase());
                    case 'between': return v >= q.values[0] && v <= q.values[1];
                    case 'greaterThanEqual': return v >= q.values[0];
                    case 'lessThanEqual': return v <= q.values[0];
                    case 'isNull': return v == null;
                    case 'isNotNull': return v != null;
                    case 'or': return q.values.some((inner) => matches(d, typeof inner === 'string' ? parse(inner) : inner)); // Query.or stores parsed objects
                    default: return true;
                }
            };
            for (const raw of queries) {
                const q = parse(raw);
                if (!q) continue;
                if (q.method === 'limit') limit = q.values[0];
                else if (q.method === 'orderDesc') docs.sort((a, b) => (a[q.attribute] < b[q.attribute] ? 1 : a[q.attribute] > b[q.attribute] ? -1 : 0));
                else if (q.method === 'orderAsc') docs.sort((a, b) => (a[q.attribute] > b[q.attribute] ? 1 : a[q.attribute] < b[q.attribute] ? -1 : 0));
                else if (!['cursorAfter', 'select'].includes(q.method)) docs = docs.filter((d) => matches(d, q));
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
    MONTHLY: 'monthly_payout_comm', ALLTIME: 'alltime_payout_comm', QRS: 'qr_col', SOURCES: 'source_accounts',
};

// `label` = the authenticateAdminOrLabel factory; defaults to injecting admin1.
function buildPayout(db, redis, auth = asUser('user1'), label = adminOrLabel) {
    let mod;
    jest.isolateModules(() => {
        const factory = require('../payout.js');
        mod = factory(db, { unique: () => 'uid' }, Query, 'db1',
            COLS.USERS, COLS.WD, COLS.WALLETS, COLS.TXNS, COLS.ACCOUNTS, COLS.PAYOUTS, COLS.COMM, COLS.DAILY,
            auth, label, redis, COLS.MONTHLY, COLS.ALLTIME, COLS.QRS, mockEmit, COLS.SOURCES);
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

describe('default payout commission', () => {
    test('missing payoutCommission on user and parent → default 1.5% each (3% total); explicit 0 stays 0', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis());
        userMetaCache.getUserMeta.mockImplementation(async (id) => ({
            user1: { userId: 'user1', role: 'user', parentId: 'sub1' },            // no payoutCommission field
            sub1: { userId: 'sub1', role: 'subadmin', parentId: null },            // none either
        })[id] || null);
        const a = await request(app).get('/commission-preview?amount=100');
        expect(a.body).toMatchObject({ commissionRate: 3, commissionPaise: 300 });

        userMetaCache.getUserMeta.mockImplementation(async (id) => ({
            user1: { userId: 'user1', role: 'user', parentId: 'sub1', payoutCommission: 0 },
            sub1: { userId: 'sub1', role: 'subadmin', parentId: null, payoutCommission: null },
        })[id] || null);
        const b = await request(app).get('/commission-preview?amount=100');
        expect(b.body).toMatchObject({ commissionRate: 1.5, commissionPaise: 150 }); // 0 + default parent
    });

    test('config key default_payout_commission overrides the 1.5 fallback', async () => {
        mockConfig.default_payout_commission = 2;
        try {
            const { app } = buildPayout(makeDb(), makeRedis());
            userMetaCache.getUserMeta.mockResolvedValue({ userId: 'user1', role: 'user', parentId: null });
            expect((await request(app).get('/commission-preview?amount=100')).body.commissionRate).toBe(2);
        } finally { delete mockConfig.default_payout_commission; }
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
            // pending rows carry a server-clock wait; the list carries serverTime for drift-free ticking
            const queue = await request(adminApp).get('/admin/requests?status=pending');
            expect(queue.body.serverTime).toBe('2026-09-06T10:12:00.000Z');
            expect(queue.body.payouts[0].waitingMinutes).toBe(12);
            const tag = await request(adminApp).patch(`/admin/accounts/${created.body.payout.accountId}/banking-status`).send({ bankingStatus: 'added' });
            expect(tag.status).toBe(200);
            expect(tag.body.stampedRequests).toBe(1);

            jest.setSystemTime(new Date('2026-09-06T10:30:30.000Z'));
            const paid = await request(adminApp).post(`/admin/requests/${created.body.payout.id}/paid`).send({ referenceNumber: 'UTR12345' });
            expect(paid.body.payout).toMatchObject({
                addedToBankingAt: '2026-09-06T10:12:00.000Z', addedInMinutes: 12,
                paidAt: '2026-09-06T10:30:30.000Z', paidInMinutes: 31, rejectedAt: null, rejectedInMinutes: null,
                waitingMinutes: null, // resolved → no live wait
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

describe('paidVia (staff-only) + lookup by unique id', () => {
    const seed = () => ({
        [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }, { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1' }],
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 10300 }],
        [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', bankingStatus: 'added' }],
        [COLS.PAYOUTS]: [{ $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'acc1', customerName: 'Ravi', accountNumber: '1', mode: 'IMPS', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, userCommissionRate: 3, parentCommissionRate: 0, status: 'pending', createdAt: '2026-09-01T00:00:00.000Z' }],
    });

    test('paid stores paidVia; admin sees it everywhere, user and subadmin never do', async () => {
        const db = makeDb(seed());
        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const paid = await request(adminApp).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345', paidVia: 'HDFC current a/c ****4321' });
        expect(paid.status).toBe(200);
        expect(paid.body.payout.paidVia).toBe('HDFC current a/c ****4321');
        expect(db.store[COLS.PAYOUTS][0].paidVia).toBe('HDFC current a/c ****4321');

        expect((await request(adminApp).get('/admin/requests?status=paid')).body.payouts[0].paidVia).toBe('HDFC current a/c ****4321');
        expect((await request(adminApp).get('/admin/requests/cpo_1')).body.payout.paidVia).toBe('HDFC current a/c ****4321');
        expect((await request(adminApp).get('/admin/accounts/acc1/payouts')).body.payouts[0].paidVia).toBe('HDFC current a/c ****4321');
        expect((await request(adminApp).get('/admin/requests?paidVia=HDFC current a/c ****4321')).body.payouts.map((p) => p.id)).toEqual(['cpo_1']);
        expect((await request(adminApp).get('/admin/requests?paidVia=other')).body.payouts).toEqual([]);

        const { app: userApp } = buildPayout(db, makeRedis(), asUser('user1'));
        const own = await request(userApp).get('/requests/cpo_1');
        expect(own.status).toBe(200);
        expect(own.body.payout.id).toBe('cpo_1');
        expect(own.body.payout).not.toHaveProperty('paidVia');
        expect((await request(userApp).get('/requests')).body.payouts[0]).not.toHaveProperty('paidVia');
        expect((await request(userApp).get('/accounts/acc1/payouts')).body.payouts[0]).not.toHaveProperty('paidVia');

        const sub = asUser('sub1', 'subadmin');
        const { app: subApp } = buildPayout(db, makeRedis(), sub, () => sub);
        const subRow = await request(subApp).get('/admin/requests/cpo_1');
        expect(subRow.status).toBe(200);
        expect(subRow.body.payout).not.toHaveProperty('paidVia');
        expect((await request(subApp).get('/admin/requests?status=paid')).body.payouts[0]).not.toHaveProperty('paidVia');
        // paidVia filter is ignored for a subadmin (they cannot see the field)
        expect((await request(subApp).get('/admin/requests?paidVia=other')).body.payouts).toHaveLength(1);
    });

    test('paidVia is optional; lookups: unknown id → 404, foreign user → 404, subadmin foreign → 404, bad id → 400', async () => {
        const db = makeDb(seed());
        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const paid = await request(adminApp).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(paid.status).toBe(200);
        expect(paid.body.payout.paidVia).toBeNull();
        expect((await request(adminApp).get('/admin/requests/cpo_404')).status).toBe(404);
        expect((await request(adminApp).get('/admin/requests/bad id!')).status).toBe(400);
        expect((await request(buildPayout(db, makeRedis(), asUser('user2')).app).get('/requests/cpo_1')).status).toBe(404);
        const other = asUser('subOther', 'subadmin');
        expect((await request(buildPayout(db, makeRedis(), other, () => other).app).get('/admin/requests/cpo_1')).status).toBe(404);
    });
});

describe('disable customer payouts (platform + per user)', () => {
    const ConfigManager = require('../configManager');
    const wallet = () => ({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });

    test('platform switch blocks new requests with the configured message; viewing still works', async () => {
        mockConfig.customer_payouts_enabled = 'false';
        mockConfig.customer_payouts_disabled_message = 'Bank maintenance till 6 PM';
        try {
            const { app } = buildPayout(makeDb(wallet()), makeRedis());
            const st = await request(app).get('/status');
            expect(st.body).toMatchObject({ enabled: false, platformEnabled: false, userEnabled: true, message: 'Bank maintenance till 6 PM' });
            const r = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
            expect(r.status).toBe(403);
            expect(r.body.error).toBe('Bank maintenance till 6 PM');
            expect((await request(app).get('/requests')).status).toBe(200);
            expect((await request(app).get('/wallet')).body.access.enabled).toBe(false);
        } finally { delete mockConfig.customer_payouts_enabled; delete mockConfig.customer_payouts_disabled_message; }
    });

    test('boolean true/false and string "false" are both honoured; default message when none set', async () => {
        mockConfig.customer_payouts_enabled = false;
        try {
            const { app } = buildPayout(makeDb(wallet()), makeRedis());
            const st = await request(app).get('/status');
            expect(st.body.enabled).toBe(false);
            expect(st.body.message).toMatch(/temporarily disabled/i);
        } finally { delete mockConfig.customer_payouts_enabled; }
        mockConfig.customer_payouts_enabled = true;
        try {
            const { app } = buildPayout(makeDb(wallet()), makeRedis());
            expect((await request(app).get('/status')).body.enabled).toBe(true);
        } finally { delete mockConfig.customer_payouts_enabled; }
    });

    test('per-user flag blocks that user only, with the reason', async () => {
        userMetaCache.getUserMeta.mockImplementation(async (id) => ({
            user1: { userId: 'user1', role: 'user', parentId: null, payoutCommission: 1, payoutDisabled: true, payoutDisabledReason: 'KYC pending' },
            user2: { userId: 'user2', role: 'user', parentId: null, payoutCommission: 1 },
        })[id] || null);
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }, { $id: 'w2', userId: 'user2', balancePaise: 100000, holdPaise: 0 }] });
        const { app } = buildPayout(db, makeRedis());
        const r = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('Customer payouts are disabled for your account: KYC pending');
        expect((await request(app).get('/status')).body).toMatchObject({ enabled: false, platformEnabled: true, userEnabled: false });
        const { app: app2 } = buildPayout(db, makeRedis(), asUser('user2'));
        expect((await request(app2).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 })).status).toBe(201);
    });

    test('admin endpoints: settings read/write, per-user access write + cache invalidate; admin role only', async () => {
        const db = makeDb({ [COLS.USERS]: [{ $id: 'user1', userId: 'user1', role: 'user' }, { $id: 'admin1', userId: 'admin1', role: 'admin' }] });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).get('/admin/settings')).body.customerPayouts).toEqual({ enabled: true, message: expect.stringMatching(/temporarily disabled/i) });
        const set = await request(app).patch('/admin/settings').send({ enabled: false, message: 'Back at 6 PM' });
        expect(set.status).toBe(200);
        expect(ConfigManager.set).toHaveBeenCalledWith('customer_payouts_enabled', 'false');
        expect(ConfigManager.set).toHaveBeenCalledWith('customer_payouts_disabled_message', 'Back at 6 PM');
        expect((await request(app).patch('/admin/settings').send({ enabled: 'no' })).status).toBe(400);

        const off = await request(app).patch('/admin/users/user1/payout-access').send({ enabled: false, reason: 'KYC pending' });
        expect(off.status).toBe(200);
        expect(db.store[COLS.USERS][0]).toMatchObject({ payoutDisabled: true, payoutDisabledReason: 'KYC pending' });
        expect(userMetaCache.invalidate).toHaveBeenCalledWith('user1');
        const on = await request(app).patch('/admin/users/user1/payout-access').send({ enabled: true });
        expect(db.store[COLS.USERS][0]).toMatchObject({ payoutDisabled: false, payoutDisabledReason: null });
        expect(on.body.payoutDisabled).toBe(false);
        expect((await request(app).patch('/admin/users/admin1/payout-access').send({ enabled: false })).status).toBe(400);
        expect((await request(app).patch('/admin/users/nobody/payout-access').send({ enabled: false })).status).toBe(404);

        // labelled employee passes adminEdit but is not admin → 403 on both switches
        const emp = asUser('emp1', 'employee');
        const { app: empApp } = buildPayout(db, makeRedis(), emp, () => emp);
        expect((await request(empApp).patch('/admin/settings').send({ enabled: true })).status).toBe(403);
        expect((await request(empApp).get('/admin/settings')).status).toBe(403);
        expect((await request(empApp).patch('/admin/users/user1/payout-access').send({ enabled: true })).status).toBe(403);
        const sub = asUser('sub1', 'subadmin');
        expect((await request(buildPayout(db, makeRedis(), sub, () => sub).app).get('/admin/settings')).status).toBe(403);
    });
});

describe('revert payout wallet → QR', () => {
    const WD = () => ({ $id: 'wd1', id: 'wdh_1', userId: 'user1', qrId: 'qr1', mode: 'wallet', status: 'approved', amount: 500, preAmount: 500, commission: 0 });
    const seed = (over = {}) => ({
        [COLS.WD]: [WD()],
        [COLS.QRS]: [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 200000, withdrawalApprovedAmount: 50000, withdrawalRequestedAmount: 10000, amountOnHold: 0, commissionOnHold: 500, commissionPaid: 1000, amountAvailableForWithdrawal: 138500 }],
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 0, totalRevertedToQrPaise: 0 }],
        [COLS.TXNS]: [{ $id: 't0', id: 'pwt_0', type: 'withdrawal_credit', refId: 'wdh_1', userId: 'user1', amountPaise: 50000 }],
        ...over,
    });
    const admin = () => asUser('admin1', 'admin');
    const body = { withdrawalId: 'wdh_1', notes: 'Payout service withdrawn, returning funds' };

    test('full revert: wallet debited with ledger row, QR approved reduced + available recomputed, withdrawal tracks it, counters reversed', async () => {
        const db = makeDb(seed());
        const redis = makeRedis();
        const { app } = buildPayout(db, redis, admin());
        const res = await request(app).post('/admin/wallet/revert-to-qr').send(body);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ duplicate: false, withdrawalId: 'wdh_1', qrId: 'qr1', userId: 'user1', amountPaise: 50000, remainingPaise: 0, qrAvailablePaise: 188500 });
        expect(db.store[COLS.WALLETS][0]).toMatchObject({ balancePaise: 0, holdPaise: 0, totalRevertedToQrPaise: 50000 });
        expect(db.store[COLS.QRS][0]).toMatchObject({ withdrawalApprovedAmount: 0, amountAvailableForWithdrawal: 188500, withdrawalRequestedAmount: 10000, commissionPaid: 1000 });
        expect(db.store[COLS.WD][0].walletRevertedPaise).toBe(50000);
        const row = db.store[COLS.TXNS].find((t) => t.type === 'revert_to_qr');
        expect(row).toMatchObject({ direction: 'debit', amountPaise: 50000, totalPaise: 50000, refType: 'withdrawal_revert', referenceNumber: 'wdh_1', createdBy: 'admin1', balanceAfterPaise: 0 });
        expect(row.notes).toContain('Payout service withdrawn');
        expect(res.body.transaction.type).toBe('revert_to_qr');
        expect(counterDeltas()).toEqual([['totalPayoutWalletBalance', -50000], ['totalPayoutWalletFunded', -50000], ['totalAmountPaid', -50000]]);
        // lock order qr → wallet, both released
        expect(redis.set.mock.calls.map((c) => c[0])).toEqual(['lock:qr:qr1', 'lock:payoutwallet:user1']);
        expect(redis.eval).toHaveBeenCalledTimes(2);
    });

    test('partial reverts are bounded by what the withdrawal credited', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), admin());
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, amount: 200 })).body).toMatchObject({ amountPaise: 20000, remainingPaise: 30000 });
        const over = await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, amount: 300.01 });
        expect(over.status).toBe(409);
        expect(over.body.error).toMatch(/exceeds/i);
        expect((await request(app).post('/admin/wallet/revert-to-qr').send(body)).body).toMatchObject({ amountPaise: 30000, remainingPaise: 0 }); // default = remaining
        const none = await request(app).post('/admin/wallet/revert-to-qr').send(body);
        expect(none.status).toBe(409);
        expect(none.body.error).toMatch(/nothing left/i);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(0);
        expect(db.store[COLS.QRS][0].withdrawalApprovedAmount).toBe(0);
        expect(db.store[COLS.WD][0].walletRevertedPaise).toBe(50000);
    });

    test('wallet money already held by pending payouts cannot be reverted', async () => {
        const db = makeDb(seed({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 30000 }] }));
        const { app } = buildPayout(db, makeRedis(), admin());
        const res = await request(app).post('/admin/wallet/revert-to-qr').send(body); // wants 50000, available 20000
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/insufficient/i);
        expect(db.store[COLS.QRS][0].withdrawalApprovedAmount).toBe(50000);
        expect(db.store[COLS.TXNS]).toHaveLength(1);
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, amount: 200 })).status).toBe(200);
    });

    test('QR update failure compensates the wallet (ledger row removed, balance restored) and returns 500', async () => {
        const db = makeDb(seed());
        const origUpdate = db.updateDocument.getMockImplementation();
        db.updateDocument.mockImplementation(async (d, c, id, data) => { if (c === COLS.QRS) throw new Error('appwrite down'); return origUpdate(d, c, id, data); });
        const { app } = buildPayout(db, makeRedis(), admin());
        const res = await request(app).post('/admin/wallet/revert-to-qr').send(body);
        expect(res.status).toBe(500);
        expect(db.store[COLS.WALLETS][0]).toMatchObject({ balancePaise: 50000, totalRevertedToQrPaise: 0 });
        expect(db.store[COLS.TXNS].map((t) => t.type)).toEqual(['withdrawal_credit']);
        expect(db.store[COLS.WD][0].walletRevertedPaise).toBeUndefined();
        expect(counterDeltas()).toEqual([['totalPayoutWalletBalance', -50000], ['totalPayoutWalletBalance', 50000]]);
    });

    test('revertable list for the wallet screen: per-withdrawal numbers, capped by available, admin only', async () => {
        const db = makeDb(seed({
            [COLS.WD]: [WD(), { ...WD(), $id: 'wd2', id: 'wdh_2', preAmount: 100, walletRevertedPaise: 10000 }, { ...WD(), $id: 'wd3', id: 'wdh_3', mode: 'bank' }, { ...WD(), $id: 'wd4', id: 'wdh_4', status: 'pending' }],
            [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 30000 }], // available 20000
        }));
        const { app } = buildPayout(db, makeRedis(), admin());
        const res = await request(app).get('/admin/wallet/revertable?userId=user1');
        expect(res.status).toBe(200);
        expect(res.body.withdrawals).toEqual([expect.objectContaining({ withdrawalId: 'wdh_1', qrId: 'qr1', creditedPaise: 50000, revertedPaise: 0, revertablePaise: 50000, revertablePaise_capped: 20000, walletCreditFailed: false })]);
        expect(res.body).toMatchObject({ pageTotalRevertablePaise: 50000, maxSingleRevertPaise: 20000, wallet: { availablePaise: 20000 } });
        const all = await request(app).get('/admin/wallet/revertable?userId=user1&onlyRevertable=false');
        expect(all.body.withdrawals.map((w) => [w.withdrawalId, w.revertablePaise])).toEqual([['wdh_1', 50000], ['wdh_2', 0]]); // bank + pending excluded
        expect((await request(app).get('/admin/wallet/revertable')).status).toBe(400);
        const emp = asUser('emp1', 'employee');
        expect((await request(buildPayout(db, makeRedis(), emp, () => emp).app).get('/admin/wallet/revertable?userId=user1')).status).toBe(403);
        // and the flow the screen drives: revert the capped amount from that row
        const rv = await request(app).post('/admin/wallet/revert-to-qr').send({ withdrawalId: 'wdh_1', amount: 200, notes: 'from wallet screen' });
        expect(rv.status).toBe(200);
        expect((await request(app).get('/admin/wallet/revertable?userId=user1')).body.withdrawals[0]).toMatchObject({ revertedPaise: 20000, revertablePaise: 30000, revertablePaise_capped: 0 });
    });

    test('same refId twice → duplicate no-op', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), admin());
        const b = { ...body, amount: 100, refId: 'client-uuid-9' };
        expect((await request(app).post('/admin/wallet/revert-to-qr').send(b)).body.duplicate).toBe(false);
        const again = await request(app).post('/admin/wallet/revert-to-qr').send(b);
        expect(again.body.duplicate).toBe(true);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(40000);
        expect(db.store[COLS.QRS][0].withdrawalApprovedAmount).toBe(40000);
    });

    test('validation + guards: notes required, admin role only, not wallet / not approved / never credited / QR lock busy', async () => {
        const db = makeDb(seed({ [COLS.WD]: [WD(), { ...WD(), $id: 'wd2', id: 'wdh_2', mode: 'bank' }, { ...WD(), $id: 'wd3', id: 'wdh_3', status: 'pending' }, { ...WD(), $id: 'wd4', id: 'wdh_4' }] }));
        const { app } = buildPayout(db, makeRedis(), admin());
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ withdrawalId: 'wdh_1' })).status).toBe(400);
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, amount: -5 })).status).toBe(400);
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, withdrawalId: 'wdh_2' })).status).toBe(400);
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, withdrawalId: 'wdh_3' })).status).toBe(400);
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, withdrawalId: 'nope' })).status).toBe(404);
        const never = await request(app).post('/admin/wallet/revert-to-qr').send({ ...body, withdrawalId: 'wdh_4' }); // no withdrawal_credit row for wdh_4
        expect(never.status).toBe(409);
        expect(never.body.error).toMatch(/never credited/i);
        const emp = asUser('emp1', 'employee');
        expect((await request(buildPayout(db, makeRedis(), emp, () => emp).app).post('/admin/wallet/revert-to-qr').send(body)).status).toBe(403);
        const busy = await request(buildPayout(makeDb(seed()), makeRedis({ set: jest.fn().mockResolvedValue(null) }), admin()).app).post('/admin/wallet/revert-to-qr').send(body);
        expect(busy.status).toBe(409);
        expect(busy.body.error).toMatch(/QR is currently being processed/i);
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(50000);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Batch 3: employee scoping, limits, self-cancel, source accounts, export, stats,
//          alerts, verification, realtime, integrity check, withdraw ownership
// ═══════════════════════════════════════════════════════════════════════════
const ISO = () => new Date().toISOString();
const clearCfg = (...keys) => keys.forEach((k) => delete mockConfig[k]);

describe('employee scoping (assigned subadmins → their users)', () => {
    const seed = () => ({
        [COLS.USERS]: [
            { $id: 'emp1', userId: 'emp1', role: 'employee' },
            { $id: 'sub1', userId: 'sub1', role: 'subadmin', assigned_to: 'emp1' },
            { $id: 'subOther', userId: 'subOther', role: 'subadmin', assigned_to: 'empOther' },
            { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1' },
            { $id: 'userX', userId: 'userX', role: 'user', parentId: 'subOther' },
            { $id: 'admin1', userId: 'admin1', role: 'admin' },
        ],
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 10300 }, { $id: 'wX', userId: 'userX', balancePaise: 50000, holdPaise: 10300 }],
        [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', bankingStatus: 'not_added' }, { $id: 'accX', userId: 'userX', bankingStatus: 'not_added' }],
        [COLS.PAYOUTS]: [
            { $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'acc1', customerName: 'R', accountNumber: '1', mode: 'IMPS', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, userCommissionRate: 3, parentCommissionRate: 0, status: 'pending', createdAt: ISO() },
            { $id: 'pX', id: 'cpo_X', userId: 'userX', accountId: 'accX', customerName: 'X', accountNumber: '2', mode: 'IMPS', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, userCommissionRate: 3, parentCommissionRate: 0, status: 'pending', createdAt: ISO() },
        ],
    });
    const emp = () => { const e = asUser('emp1', 'employee'); return [e, () => e]; };

    test('employee sees only assigned subadmins\' users and can pay/reject/tag those; foreign → 403', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), ...emp());
        expect((await request(app).get('/admin/requests')).body.payouts.map((p) => p.id)).toEqual(['cpo_1']);
        expect((await request(app).get('/admin/requests?userId=userX')).status).toBe(403);
        expect((await request(app).get('/admin/requests?subadminId=subOther')).status).toBe(403);
        expect((await request(app).get('/admin/accounts')).body.accounts.map((a) => a.$id)).toEqual(['acc1']);
        expect((await request(app).get('/admin/wallets')).body.wallets.map((w) => w.userId)).toEqual(['user1']);
        expect((await request(app).patch('/admin/accounts/accX/banking-status').send({ bankingStatus: 'added' })).status).toBe(403);
        expect((await request(app).patch('/admin/accounts/acc1/banking-status').send({ bankingStatus: 'added' })).status).toBe(200);
        expect((await request(app).post('/admin/requests/cpo_X/paid').send({ referenceNumber: 'UTR12345' })).status).toBe(403);
        expect((await request(app).post('/admin/requests/cpo_X/reject').send({ reason: 'nope' })).status).toBe(403);
        const paid = await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345', paidVia: 'HDFC ****1' });
        expect(paid.status).toBe(200);
        expect(paid.body.payout.paidVia).toBe('HDFC ****1'); // employees are staff: they see paidVia
        expect(db.store[COLS.WALLETS][0].balancePaise).toBe(39700);
        expect(db.store[COLS.WALLETS][1].balancePaise).toBe(50000);
    });

    test('employee cannot touch wallets or settings (admin role only) and an unassigned employee sees nothing', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), ...emp());
        expect((await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'credit', amount: 1, notes: 'abc' })).status).toBe(403);
        expect((await request(app).post('/admin/wallet/retry-credit').send({ withdrawalId: 'x' })).status).toBe(403);
        expect((await request(app).post('/admin/wallet/revert-to-qr').send({ withdrawalId: 'x', notes: 'abc' })).status).toBe(403);
        expect((await request(app).patch('/admin/settings').send({ enabled: true })).status).toBe(403);
        expect((await request(app).get('/admin/wallet/export?userId=user1&from=2026-09-01&to=2026-09-02')).status).toBe(403);
        expect((await request(app).get('/admin/integrity/wallet/user1')).status).toBe(403);
        const lonely = asUser('emp9', 'employee');
        const { app: lonelyApp } = buildPayout(db, makeRedis(), lonely, () => lonely);
        expect((await request(lonelyApp).get('/admin/requests')).body.payouts).toEqual([]);
        expect((await request(lonelyApp).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' })).status).toBe(403);
    });
});

describe('per-user limits (0 = unlimited, null = inherit platform)', () => {
    const rich = () => ({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000000, holdPaise: 0 }] });
    const meta = (extra = {}) => userMetaCache.getUserMeta.mockImplementation(async (id) => (id === 'user1' ? { userId: 'user1', role: 'user', parentId: null, payoutCommission: 0, ...extra } : id === 'admin1' ? { userId: 'admin1', role: 'admin' } : null));
    const req = (app, amount) => request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount });

    test('platform limits: per request, max pending, daily total; 0 switches each off', async () => {
        meta();
        Object.assign(mockConfig, { payout_max_per_request: 500, payout_max_pending: 2, payout_daily_limit: 1200 });
        try {
            const { app } = buildPayout(makeDb(rich()), makeRedis());
            const big = await req(app, 500.01);
            expect(big.status).toBe(400); expect(big.body.error).toMatch(/per-payout limit of ₹500.00/);
            expect((await req(app, 500)).status).toBe(201);
            expect((await req(app, 500)).status).toBe(201);
            const third = await req(app, 100);
            expect(third.status).toBe(400); expect(third.body.error).toMatch(/maximum number of pending customer payouts \(2\)/);
            mockConfig.payout_max_pending = 0; // unlimited pending → daily limit is next
            const daily = await req(app, 200.01);
            expect(daily.status).toBe(400); expect(daily.body.error).toMatch(/daily limit of ₹1200.00 \(used ₹1000.00 today\)/);
            expect((await req(app, 200)).status).toBe(201);
            mockConfig.payout_daily_limit = 0; mockConfig.payout_max_per_request = 0;
            expect((await req(app, 5000)).status).toBe(201); // everything off
            const st = await request(app).get('/status');
            expect(st.body.limits).toEqual({ maxPerRequestPaise: 0, dailyLimitPaise: 0, maxPending: 0 });
            expect(st.body.usage).toMatchObject({ pendingCount: 4, usedTodayPaise: 620000, requestedTodayCount: 4 });
        } finally { clearCfg('payout_max_per_request', 'payout_max_pending', 'payout_daily_limit'); }
    });

    test('user values override platform: null inherits, 0 = unlimited for that user', async () => {
        mockConfig.payout_max_per_request = 100;
        try {
            meta({ payoutMaxPerRequestPaise: null });
            expect((await req(buildPayout(makeDb(rich()), makeRedis()).app, 150)).status).toBe(400);
            meta({ payoutMaxPerRequestPaise: 0 });
            expect((await req(buildPayout(makeDb(rich()), makeRedis()).app, 150)).status).toBe(201);
            meta({ payoutMaxPerRequestPaise: 20000 }); // 200 rupees, above platform 100
            const { app } = buildPayout(makeDb(rich()), makeRedis());
            expect((await req(app, 150)).status).toBe(201);
            expect((await req(app, 250)).status).toBe(400);
        } finally { clearCfg('payout_max_per_request'); }
    });

    test('admin limits endpoints: rupees in, paise stored, null clears, admin role only, cache invalidated', async () => {
        const db = makeDb({ [COLS.USERS]: [{ $id: 'user1', userId: 'user1', role: 'user' }] });
        userMetaCache.getUserMeta.mockImplementation(async (id) => db.store[COLS.USERS].find((u) => u.userId === id) || null);
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const set = await request(app).patch('/admin/users/user1/payout-limits').send({ maxPerRequest: 250.5, dailyLimit: 0, maxPending: 3 });
        expect(set.status).toBe(200);
        expect(db.store[COLS.USERS][0]).toMatchObject({ payoutMaxPerRequestPaise: 25050, payoutDailyLimitPaise: 0, payoutMaxPending: 3 });
        expect(set.body.effective).toEqual({ maxPerRequestPaise: 25050, dailyLimitPaise: 0, maxPending: 3 });
        expect(userMetaCache.invalidate).toHaveBeenCalledWith('user1');
        expect((await request(app).patch('/admin/users/user1/payout-limits').send({ maxPerRequest: null })).status).toBe(200);
        expect(db.store[COLS.USERS][0].payoutMaxPerRequestPaise).toBeNull();
        expect((await request(app).patch('/admin/users/user1/payout-limits').send({ maxPending: -1 })).status).toBe(400);
        expect((await request(app).patch('/admin/users/user1/payout-limits').send({})).status).toBe(400);
        const get = await request(app).get('/admin/users/user1/payout-limits');
        expect(get.body).toMatchObject({ userValues: { maxPerRequestPaise: null, dailyLimitPaise: 0, maxPending: 3 }, effective: { maxPerRequestPaise: 0, dailyLimitPaise: 0, maxPending: 3 } });
        const emp = asUser('emp1', 'employee');
        expect((await request(buildPayout(db, makeRedis(), emp, () => emp).app).patch('/admin/users/user1/payout-limits').send({ maxPending: 1 })).status).toBe(403);
    });
});

describe('user self-cancel', () => {
    const seed = () => ({
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 50000, holdPaise: 10300 }],
        [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', requestCount: 1 }],
        [COLS.PAYOUTS]: [{ $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'acc1', customerName: 'R', accountNumber: '1', mode: 'IMPS', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, status: 'pending', createdAt: ISO() }],
        [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }],
    });

    test('cancel releases the hold only, stamps cancelledAt, bumps account stats and counters, emits; then paid → 400', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis());
        const res = await request(app).post('/requests/cpo_1/cancel');
        expect(res.status).toBe(200);
        expect(res.body.payout).toMatchObject({ status: 'cancelled', processedBy: 'user1', rejectionReason: null });
        expect(res.body.payout.cancelledAt).toBeTruthy();
        expect(res.body.payout.cancelledInMinutes).toBe(0);
        expect(db.store[COLS.WALLETS][0]).toMatchObject({ balancePaise: 50000, holdPaise: 0 });
        expect(db.store[COLS.TXNS] || []).toHaveLength(0);
        expect(db.store[COLS.ACCOUNTS][0].cancelledCount).toBe(1);
        expect(counterDeltas()).toEqual([['totalCustomerPayoutPendingAmount', -10000], ['totalCustomerPayoutPendingCount', -1]]);
        expect(emitted().at(-1)).toMatchObject({ userId: 'user1', event: 'payout:update', payload: { type: 'request_cancelled', payoutId: 'cpo_1' } });
        expect((await request(app).post('/requests/cpo_1/cancel')).status).toBe(400);
        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const paid = await request(adminApp).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
        expect(paid.status).toBe(400); expect(paid.body.error).toMatch(/cancelled/);
        expect((await request(app).get('/requests?status=cancelled')).body.payouts.map((p) => p.id)).toEqual(['cpo_1']);
        expect((await request(adminApp).get('/admin/accounts')).body.accounts[0]).toMatchObject({ cancelledCount: 1, pendingCount: 0 });
    });

    test('someone else\'s request → 404; racing resolve → 409', async () => {
        const db = makeDb(seed());
        expect((await request(buildPayout(db, makeRedis(), asUser('user2')).app).post('/requests/cpo_1/cancel')).status).toBe(404);
        db.getDocument.mockImplementationOnce(async () => ({ ...db.store[COLS.PAYOUTS][0], status: 'paid' }));
        expect((await request(buildPayout(db, makeRedis()).app).post('/requests/cpo_1/cancel')).status).toBe(409);
        expect(db.store[COLS.WALLETS][0].holdPaise).toBe(10300);
    });
});

describe('"paid via" source accounts', () => {
    const seed = () => ({
        [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }],
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 90000, holdPaise: 30900 }],
        [COLS.PAYOUTS]: ['1', '2', '3'].map((n) => ({ $id: `p${n}`, id: `cpo_${n}`, userId: 'user1', accountId: 'acc1', customerName: 'R', accountNumber: '1', mode: 'IMPS', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, userCommissionRate: 3, parentCommissionRate: 0, status: 'pending', createdAt: ISO() })),
    });

    test('paid with paidVia upserts the source (case-insensitive) and bumps use/total; list, search, sort, create, deactivate', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR00001', paidVia: 'HDFC Current ****4321' });
        await request(app).post('/admin/requests/cpo_2/paid').send({ referenceNumber: 'UTR00002', paidVia: 'hdfc current ****4321' });
        await request(app).post('/admin/requests/cpo_3/paid').send({ referenceNumber: 'UTR00003', paidVia: 'ICICI ****9' });
        expect(db.store[COLS.SOURCES]).toHaveLength(2);
        const list = await request(app).get('/admin/source-accounts');
        expect(list.body.sourceAccounts.map((s) => [s.label, s.useCount, s.totalPaidPaise])).toEqual([['HDFC Current ****4321', 2, 20000], ['ICICI ****9', 1, 10000]]);
        expect(list.body.sourceAccounts[0].lastUsedAt).toBeTruthy();
        expect((await request(app).get('/admin/source-accounts?search=ici')).body.sourceAccounts.map((s) => s.label)).toEqual(['ICICI ****9']);
        expect((await request(app).get('/admin/source-accounts?sort=label')).body.sourceAccounts.map((s) => s.label)).toEqual(['HDFC Current ****4321', 'ICICI ****9']);
        const add = await request(app).post('/admin/source-accounts').send({ label: 'SBI ****7' });
        expect(add.status).toBe(201); expect(add.body.created).toBe(true);
        expect((await request(app).post('/admin/source-accounts').send({ label: 'sbi ****7' })).body.created).toBe(false);
        expect((await request(app).post('/admin/source-accounts').send({ label: 'x' })).status).toBe(400);
        const del = await request(app).delete(`/admin/source-accounts/${add.body.sourceAccount.$id}`);
        expect(del.status).toBe(200);
        expect((await request(app).get('/admin/source-accounts')).body.sourceAccounts.map((s) => s.label)).not.toContain('SBI ****7');
        expect((await request(app).get('/admin/source-accounts?includeInactive=true')).body.sourceAccounts.map((s) => s.label)).toContain('SBI ****7');
        expect((await request(app).post('/admin/source-accounts').send({ label: 'SBI ****7' })).body.sourceAccount.active).toBe(true); // re-adding reactivates
        const sub = asUser('sub1', 'subadmin');
        expect((await request(buildPayout(db, makeRedis(), sub, () => sub).app).get('/admin/source-accounts')).status).toBe(403);
    });

    test('a failing source bump never fails the paid response', async () => {
        const db = makeDb(seed());
        const origCreate = db.createDocument.getMockImplementation();
        db.createDocument.mockImplementation(async (d, c, id, data) => { if (c === COLS.SOURCES) throw new Error('down'); return origCreate(d, c, id, data); });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR00001', paidVia: 'HDFC' })).status).toBe(200);
        expect(db.store[COLS.PAYOUTS][0].status).toBe('paid');
    });
});

describe('wallet statement export (CSV, admin only)', () => {
    test('rows in range, escaped, rupee columns, headers; validation', async () => {
        const db = makeDb({ [COLS.TXNS]: [
            { $id: 't1', id: 'pwt_1', userId: 'user1', type: 'withdrawal_credit', direction: 'credit', amountPaise: 50000, commissionPaise: 0, totalPaise: 50000, balanceAfterPaise: 50000, holdAfterPaise: 0, refType: 'withdrawal', refId: 'wdh_1', notes: 'Plain', createdAt: '2026-09-02T05:00:00.000Z' },
            { $id: 't2', id: 'pwt_2', userId: 'user1', type: 'payout_paid', direction: 'debit', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, balanceAfterPaise: 39700, holdAfterPaise: 0, refType: 'customer_payout', refId: 'cpo_1', referenceNumber: 'UTR1', notes: 'IMPS payout to "Ravi, Kumar"', createdBy: 'admin1', createdAt: '2026-09-03T05:00:00.000Z' },
            { $id: 't3', id: 'pwt_3', userId: 'user1', type: 'admin_credit', direction: 'credit', amountPaise: 1, totalPaise: 1, createdAt: '2026-10-01T05:00:00.000Z' },
            { $id: 't4', id: 'pwt_4', userId: 'user2', type: 'admin_credit', direction: 'credit', amountPaise: 1, totalPaise: 1, createdAt: '2026-09-02T05:00:00.000Z' },
        ] });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).get('/admin/wallet/export?userId=user1&from=2026-09-01&to=2026-09-30');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.headers['content-disposition']).toBe('attachment; filename="payout-wallet-user1-2026-09-01-2026-09-30.csv"');
        expect(res.headers['x-row-count']).toBe('2');
        const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
        expect(lines[0]).toBe('createdAt,id,type,direction,amountRs,commissionRs,totalRs,balanceAfterRs,holdAfterRs,refType,refId,referenceNumber,notes,createdBy');
        expect(lines[1]).toBe('2026-09-02T05:00:00.000Z,pwt_1,withdrawal_credit,credit,500,0,500,500,0,withdrawal,wdh_1,,Plain,');
        expect(lines[2]).toBe('2026-09-03T05:00:00.000Z,pwt_2,payout_paid,debit,100,3,103,397,0,customer_payout,cpo_1,UTR1,"IMPS payout to ""Ravi, Kumar""",admin1');
        expect(lines).toHaveLength(3);
        expect((await request(app).get('/admin/wallet/export?userId=user1')).status).toBe(400);
        expect((await request(app).get('/admin/wallet/export?from=2026-09-01&to=2026-09-02')).status).toBe(400);
    });
});

describe('daily stats time series', () => {
    test('buckets requested by createdAt and paid/rejected/cancelled by processedAt (IST days), avg paid minutes, totals; subadmin scoped', async () => {
        const db = makeDb({
            [COLS.USERS]: [{ $id: 'user1', userId: 'user1', parentId: 'sub1' }, { $id: 'userX', userId: 'userX', parentId: 'subOther' }],
            [COLS.PAYOUTS]: [
                { $id: 'a', id: 'cpo_a', userId: 'user1', amountPaise: 10000, commissionPaise: 300, status: 'paid', createdAt: '2026-09-02T04:00:00.000Z', processedAt: '2026-09-02T04:30:00.000Z', paidAt: '2026-09-02T04:30:00.000Z' },
                { $id: 'b', id: 'cpo_b', userId: 'user1', amountPaise: 20000, commissionPaise: 600, status: 'paid', createdAt: '2026-09-02T05:00:00.000Z', processedAt: '2026-09-03T05:10:00.000Z', paidAt: '2026-09-03T05:10:00.000Z' }, // requested day 2, paid day 3
                { $id: 'c', id: 'cpo_c', userId: 'user1', amountPaise: 5000, status: 'rejected', createdAt: '2026-09-03T05:00:00.000Z', processedAt: '2026-09-03T06:00:00.000Z' },
                { $id: 'd', id: 'cpo_d', userId: 'user1', amountPaise: 7000, status: 'cancelled', createdAt: '2026-09-03T05:00:00.000Z', processedAt: '2026-09-03T06:00:00.000Z' },
                { $id: 'e', id: 'cpo_e', userId: 'user1', amountPaise: 1000, status: 'pending', createdAt: '2026-09-03T07:00:00.000Z' },
                { $id: 'x', id: 'cpo_x', userId: 'userX', amountPaise: 99000, commissionPaise: 1, status: 'paid', createdAt: '2026-09-02T04:00:00.000Z', processedAt: '2026-09-02T04:05:00.000Z', paidAt: '2026-09-02T04:05:00.000Z' },
            ],
        });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).get('/admin/stats/daily?from=2026-09-01&to=2026-09-03');
        expect(res.status).toBe(200);
        expect(res.body.days).toEqual([
            { date: '2026-09-01', requestedCount: 0, requestedAmountPaise: 0, paidCount: 0, paidAmountPaise: 0, paidCommissionPaise: 0, rejectedCount: 0, cancelledCount: 0, avgPaidInMinutes: null },
            { date: '2026-09-02', requestedCount: 3, requestedAmountPaise: 129000, paidCount: 2, paidAmountPaise: 109000, paidCommissionPaise: 301, rejectedCount: 0, cancelledCount: 0, avgPaidInMinutes: 18 },
            { date: '2026-09-03', requestedCount: 3, requestedAmountPaise: 13000, paidCount: 1, paidAmountPaise: 20000, paidCommissionPaise: 600, rejectedCount: 1, cancelledCount: 1, avgPaidInMinutes: 1450 },
        ]);
        expect(res.body.totals).toEqual({ requestedCount: 6, requestedAmountPaise: 142000, paidCount: 3, paidAmountPaise: 129000, paidCommissionPaise: 901, rejectedCount: 1, cancelledCount: 1 });
        const sub = asUser('sub1', 'subadmin');
        const scoped = await request(buildPayout(db, makeRedis(), sub, () => sub).app).get('/admin/stats/daily?from=2026-09-02&to=2026-09-02');
        expect(scoped.body.days[0]).toMatchObject({ requestedCount: 2, paidCount: 1, paidAmountPaise: 10000 });
        expect((await request(app).get('/admin/stats/daily?from=2026-09-03&to=2026-09-01')).status).toBe(400);
    });
});

describe('alerts (admin toggle)', () => {
    test('low-balance emit when a debit crosses the threshold; alerts endpoint lists low wallets + stale pending; off → nothing', async () => {
        const stale = new Date(Date.now() - 3 * 3600000).toISOString();
        const db = makeDb({
            [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }],
            [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 60000, holdPaise: 10300 }, { $id: 'w2', userId: 'user2', balancePaise: 500, holdPaise: 0 }],
            [COLS.PAYOUTS]: [
                { $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'a', customerName: 'R', accountNumber: '1', mode: 'IMPS', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, userCommissionRate: 3, parentCommissionRate: 0, status: 'pending', createdAt: stale },
                { $id: 'p2', id: 'cpo_2', userId: 'user2', accountId: 'b', amountPaise: 1, totalPaise: 1, status: 'pending', createdAt: ISO() },
            ],
        });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).get('/admin/alerts')).body).toMatchObject({ enabled: false, lowBalance: [], stalePending: [] });
        Object.assign(mockConfig, { payout_alerts_enabled: 'true', payout_low_balance_threshold: 450, payout_pending_alert_minutes: 60 }); // 45000 paise
        try {
            const al = await request(app).get('/admin/alerts');
            expect(al.body.lowBalance).toEqual([{ userId: 'user2', availablePaise: 500, balancePaise: 500, holdPaise: 0 }]);
            expect(al.body.stalePending.map((s) => s.payoutId)).toEqual(['cpo_1']);
            expect(al.body.stalePending[0].waitingMinutes).toBeGreaterThanOrEqual(179);
            mockEmit.mockClear();
            // paid does NOT move available (hold was taken at request time): no alert
            await request(app).post('/admin/requests/cpo_1/paid').send({ referenceNumber: 'UTR12345' });
            expect(emitted().filter((e) => e.event === 'payout:alert')).toHaveLength(0);
            // user1 available 49700 → admin debit ₹50 → 44700: crosses 45000 → one alert to user + admins
            await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'debit', amount: 50, notes: 'crossing' });
            const alerts = emitted().filter((e) => e.event === 'payout:alert');
            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatchObject({ userId: 'user1', toAdmins: true, payload: { type: 'low_balance', availablePaise: 44700, thresholdPaise: 45000 } });
            mockEmit.mockClear();
            await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'debit', amount: 10, notes: 'below already → no second alert' });
            expect(emitted().filter((e) => e.event === 'payout:alert')).toHaveLength(0);
            // a new request whose hold crosses the threshold alerts too (that is where available really drops)
            await request(app).post('/admin/wallet/adjust').send({ userId: 'user1', direction: 'credit', amount: 100, notes: 'back above' }); // 53700
            mockEmit.mockClear();
            userMetaCache.getUserMeta.mockResolvedValue({ userId: 'user1', role: 'user', parentId: null, payoutCommission: 0 });
            expect((await request(buildPayout(db, makeRedis()).app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 100 })).status).toBe(201); // hold 10000 → 43700
            expect(emitted().filter((e) => e.event === 'payout:alert')).toHaveLength(1);
        } finally { clearCfg('payout_alerts_enabled', 'payout_low_balance_threshold', 'payout_pending_alert_minutes'); }
    });
});

describe('beneficiary verification', () => {
    test('staff sets status/name/note; payouts carry accountVerificationStatus; require-verified blocks unverified; filters', async () => {
        const db = makeDb({
            [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }],
            [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }],
            [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', customerName: 'Ravi', bankName: 'SBI', ifscCode: 'SBIN0001234', accountNumber: '12345678901' }, { $id: 'acc2', userId: 'user1', customerName: 'Sita', bankName: 'SBI', ifscCode: 'SBIN0001234', accountNumber: '22222222222' }],
        });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const { app: userApp } = buildPayout(db, makeRedis());
        const v = await request(app).patch('/admin/accounts/acc1/verification').send({ status: 'verified', verifiedName: 'RAVI KUMAR', note: 'penny drop ok' });
        expect(v.status).toBe(200);
        expect(v.body.account).toMatchObject({ verificationStatus: 'verified', verifiedName: 'RAVI KUMAR', verificationNote: 'penny drop ok', verifiedBy: 'admin1' });
        expect(v.body.account.verifiedAt).toBeTruthy();
        expect((await request(app).patch('/admin/accounts/acc1/verification').send({ status: 'weird' })).status).toBe(400);
        expect((await request(app).get('/admin/accounts?verificationStatus=verified')).body.accounts.map((a) => a.$id)).toEqual(['acc1']);
        expect((await request(app).get('/admin/accounts?verificationStatus=unverified')).body.accounts.map((a) => a.$id)).toEqual(['acc2']);
        expect((await request(userApp).get('/accounts?verificationStatus=unverified')).body.accounts.map((a) => a.$id)).toEqual(['acc2']);

        mockConfig.payout_require_verified_account = 'true';
        try {
            const blocked = await request(userApp).post('/requests').send({ accountId: 'acc2', mode: 'NEFT', amount: 10 });
            expect(blocked.status).toBe(400); expect(blocked.body.error).toMatch(/not verified/i);
            expect(db.store[COLS.WALLETS][0].holdPaise).toBe(0);
            const ok = await request(userApp).post('/requests').send({ accountId: 'acc1', mode: 'NEFT', amount: 10 });
            expect(ok.status).toBe(201);
            expect(ok.body.payout.accountVerificationStatus).toBe('verified');
            expect((await request(userApp).get('/status')).body.requireVerifiedAccount).toBe(true);
        } finally { clearCfg('payout_require_verified_account'); }
        expect((await request(userApp).post('/requests').send({ accountId: 'acc2', mode: 'NEFT', amount: 10 })).status).toBe(201); // off again
        expect((await request(app).get('/admin/requests?verificationStatus=verified')).body.payouts.map((p) => p.accountId)).toEqual(['acc1']);
        const back = await request(app).patch('/admin/accounts/acc1/verification').send({ status: 'unverified' });
        expect(back.body.account).toMatchObject({ verificationStatus: 'unverified', verifiedAt: null, verifiedBy: null });
    });
});

describe('realtime events (platform toggle + user opt-out)', () => {
    const seed = () => ({
        [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }, { $id: 'user1', userId: 'user1', role: 'user' }],
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }],
    });

    test('request → paid emits to the user room and admins with typed payloads', async () => {
        const db = makeDb(seed());
        const { app } = buildPayout(db, makeRedis());
        const r = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 100 });
        expect(emitted().at(-1)).toMatchObject({ userId: 'user1', event: 'payout:update', toAdmins: true, payload: { type: 'request_created', payoutId: r.body.payout.id, status: 'pending', amountPaise: 10000 } });
        mockEmit.mockClear();
        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await request(adminApp).post(`/admin/requests/${r.body.payout.id}/paid`).send({ referenceNumber: 'UTR12345' });
        expect(emitted().map((e) => e.payload.type)).toEqual(['request_paid']);
        expect(emitted()[0].payload).toMatchObject({ userId: 'user1', status: 'paid', referenceNumber: 'UTR12345', amountPaise: 10000 });
        expect(emitted()[0].payload.at).toBeTruthy();
    });

    test('platform toggle off → no emits; user opt-out → admins only; preferences endpoint', async () => {
        const db = makeDb(seed());
        userMetaCache.getUserMeta.mockImplementation(async (id) => db.store[COLS.USERS].find((u) => u.userId === id) ? { ...db.store[COLS.USERS].find((u) => u.userId === id), parentId: null, payoutCommission: 1 } : null);
        const { app } = buildPayout(db, makeRedis());
        mockConfig.payout_realtime_enabled = 'false';
        try {
            await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 1 });
            expect(emitted()).toEqual([]);
        } finally { clearCfg('payout_realtime_enabled'); }
        const pref = await request(app).patch('/me/preferences').send({ realtime: false });
        expect(pref.status).toBe(200);
        expect(db.store[COLS.USERS][1].payoutRealtimeDisabled).toBe(true);
        expect(userMetaCache.invalidate).toHaveBeenCalledWith('user1');
        mockEmit.mockClear();
        await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 1 });
        expect(emitted().at(-1)).toMatchObject({ userId: null, toAdmins: true, payload: { type: 'request_created' } });
        expect((await request(app).get('/status')).body.preferences).toEqual({ realtime: false });
        expect((await request(app).patch('/me/preferences').send({ realtime: 'yes' })).status).toBe(400);
    });

    test('payout modes: admin disables a mode → users see it off and cannot request it; partial merge; validation', async () => {
        const ConfigManager = require('../configManager');
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }] });
        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const { app } = buildPayout(db, makeRedis());
        expect((await request(app).get('/status')).body.modes).toEqual({ NEFT: true, IMPS: true, RTGS: true, UPI: true });

        const set = await request(adminApp).patch('/admin/settings').send({ modes: { rtgs: false, UPI: false } });
        expect(set.status).toBe(200);
        expect(ConfigManager.set).toHaveBeenCalledWith('payout_disabled_modes', 'RTGS,UPI');
        mockConfig.payout_disabled_modes = 'RTGS,UPI';
        try {
            expect((await request(app).get('/status')).body.modes).toEqual({ NEFT: true, IMPS: true, RTGS: false, UPI: false });
            expect((await request(adminApp).get('/admin/settings')).body.modes).toEqual({ NEFT: true, IMPS: true, RTGS: false, UPI: false });
            const blocked = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'rtgs', amount: 10 });
            expect(blocked.status).toBe(400);
            expect(blocked.body.error).toBe('RTGS payouts are not available right now. Please choose another mode.');
            expect(db.store[COLS.WALLETS][0].holdPaise).toBe(0);
            expect((await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 })).status).toBe(201);
            // partial update merges: re-enable UPI only → RTGS stays off
            ConfigManager.set.mockClear();
            await request(adminApp).patch('/admin/settings').send({ modes: { UPI: true } });
            expect(ConfigManager.set).toHaveBeenCalledWith('payout_disabled_modes', 'RTGS');
        } finally { clearCfg('payout_disabled_modes'); }
        expect((await request(adminApp).patch('/admin/settings').send({ modes: { CASH: false } })).status).toBe(400);
        expect((await request(adminApp).patch('/admin/settings').send({ modes: { NEFT: 'no' } })).status).toBe(400);
        expect((await request(adminApp).patch('/admin/settings').send({ modes: ['NEFT'] })).status).toBe(400);
        const sub = asUser('sub1', 'subadmin');
        expect((await request(buildPayout(db, makeRedis(), sub, () => sub).app).patch('/admin/settings').send({ modes: { NEFT: false } })).status).toBe(403);
    });

    test('admin settings PATCH writes every toggle/limit key; GET reflects them', async () => {
        const ConfigManager = require('../configManager');
        const { app } = buildPayout(makeDb(), makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).patch('/admin/settings').send({ realtimeEnabled: false, requireVerifiedAccount: true, alertsEnabled: true, lowBalanceThreshold: 500, pendingAlertMinutes: 30, maxPerRequest: 1000, dailyLimit: 0, maxPending: 3 });
        expect(res.status).toBe(200);
        const written = Object.fromEntries(ConfigManager.set.mock.calls);
        expect(written).toMatchObject({ payout_realtime_enabled: 'false', payout_require_verified_account: 'true', payout_alerts_enabled: 'true', payout_low_balance_threshold: '500', payout_pending_alert_minutes: '30', payout_max_per_request: '1000', payout_daily_limit: '0', payout_max_pending: '3' });
        expect((await request(app).patch('/admin/settings').send({ lowBalanceThreshold: -1 })).status).toBe(400);
        expect((await request(app).patch('/admin/settings').send({})).status).toBe(400);
        Object.assign(mockConfig, { payout_alerts_enabled: 'true', payout_low_balance_threshold: 500, payout_max_pending: 3 });
        try {
            expect((await request(app).get('/admin/settings')).body).toMatchObject({ realtimeEnabled: true, alerts: { enabled: true, lowBalanceThresholdPaise: 50000, pendingAlertMinutes: 0 }, limits: { maxPerRequestPaise: 0, dailyLimitPaise: 0, maxPending: 3 } });
        } finally { clearCfg('payout_alerts_enabled', 'payout_low_balance_threshold', 'payout_max_pending'); }
    });
});

describe('ledger integrity check (read-only report)', () => {
    const clean = () => ({
        [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }],
        [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 39700, holdPaise: 10300, totalCreditedPaise: 50000, totalPaidOutPaise: 10000, totalPayoutCommissionPaise: 300, totalAdminDebitPaise: 0, totalRevertedToQrPaise: 0, paidCount: 1 }],
        [COLS.WD]: [{ $id: 'wd1', id: 'wdh_1', userId: 'user1', qrId: 'qr1', mode: 'wallet', status: 'approved', preAmount: 500, walletRevertedPaise: 0 }],
        [COLS.TXNS]: [
            { $id: 't1', id: 'pwt_1', userId: 'user1', type: 'withdrawal_credit', direction: 'credit', amountPaise: 50000, totalPaise: 50000, balanceAfterPaise: 50000, refType: 'withdrawal', refId: 'wdh_1', createdAt: '2026-09-01T00:00:00.000Z' },
            { $id: 't2', id: 'pwt_2', userId: 'user1', type: 'payout_paid', direction: 'debit', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, balanceAfterPaise: 39700, refType: 'customer_payout', refId: 'cpo_1', createdAt: '2026-09-02T00:00:00.000Z' },
        ],
        [COLS.PAYOUTS]: [
            { $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'acc1', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, status: 'paid', createdAt: '2026-09-02T00:00:00.000Z' },
            { $id: 'p2', id: 'cpo_2', userId: 'user1', accountId: 'acc1', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, status: 'pending', createdAt: '2026-09-03T00:00:00.000Z' },
        ],
        [COLS.COMM]: [{ $id: 'c1', userId: 'admin1', sourcePayoutId: 'cpo_1', amount: 300 }],
        [COLS.ACCOUNTS]: [{ $id: 'acc1', userId: 'user1', customerName: 'Ravi', requestCount: 2, paidCount: 1, rejectedCount: 0, cancelledCount: 0, totalPaidPaise: 10000 }],
    });

    test('a consistent wallet reports ok with detailed ledger sums and zero issues, and writes nothing', async () => {
        const db = makeDb(clean());
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).get('/admin/integrity/wallet/user1');
        expect(res.status).toBe(200);
        expect(res.body.report).toMatchObject({ userId: 'user1', ok: true, errors: 0, warnings: 0, truncated: false, issues: [],
            ledger: { rows: 2, creditsPaise: 50000, debitsPaise: 10300, expectedBalancePaise: 39700, expectedHoldPaise: 10300, byTypePaise: { withdrawal_credit: 50000, payout_paid: 10000 } },
            counts: { payouts: 2, pending: 1, paid: 1, walletWithdrawals: 1, accounts: 1 } });
        expect(db.updateDocument).not.toHaveBeenCalled();
        expect(db.createDocument).not.toHaveBeenCalled();
        expect(db.deleteDocument).not.toHaveBeenCalled();
    });

    test('every drift type is reported with a code, severity and numbers; nothing is modified or restricted', async () => {
        const s = clean();
        s[COLS.WALLETS][0].balancePaise = 40000;                 // BALANCE_MISMATCH (+300 drift)
        s[COLS.WALLETS][0].holdPaise = 0;                        // HOLD_MISMATCH
        s[COLS.WALLETS][0].totalPaidOutPaise = 0;                // LIFETIME_MISMATCH
        s[COLS.TXNS][1].balanceAfterPaise = 39000;               // LEDGER_CHAIN_BREAK
        s[COLS.TXNS].push({ $id: 't3', id: 'pwt_3', userId: 'user1', type: 'payout_paid', direction: 'debit', amountPaise: 10000, commissionPaise: 300, totalPaise: 10300, refType: 'customer_payout', refId: 'cpo_1', createdAt: '2026-09-02T01:00:00.000Z' }); // LEDGER_DUPLICATE_REF
        s[COLS.TXNS].push({ $id: 't4', id: 'pwt_4', userId: 'user1', type: 'payout_paid', direction: 'debit', amountPaise: 1, totalPaise: 1, refId: 'cpo_ghost', createdAt: '2026-09-02T02:00:00.000Z' }); // ORPHAN_DEBIT
        s[COLS.WD].push({ $id: 'wd2', id: 'wdh_2', userId: 'user1', qrId: 'qr1', mode: 'wallet', status: 'approved', preAmount: 100, walletCreditFailed: true }); // WITHDRAWAL_NOT_CREDITED (warning, flagged)
        s[COLS.WD].push({ $id: 'wd3', id: 'wdh_3', userId: 'user1', qrId: 'qr1', mode: 'wallet', status: 'approved', preAmount: 100 }); // WITHDRAWAL_NOT_CREDITED (error)
        s[COLS.COMM][0].amount = 100;                            // COMMISSION_MISMATCH
        s[COLS.ACCOUNTS][0].totalPaidPaise = 999;                // ACCOUNT_STATS_MISMATCH
        const db = makeDb(s);
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const rep = (await request(app).get('/admin/integrity/wallet/user1')).body.report;
        expect(rep.ok).toBe(false);
        const codes = rep.issues.map((i) => `${i.severity}:${i.code}`);
        for (const c of ['error:BALANCE_MISMATCH', 'error:HOLD_MISMATCH', 'warning:LIFETIME_MISMATCH', 'error:LEDGER_CHAIN_BREAK', 'error:LEDGER_DUPLICATE_REF', 'error:ORPHAN_DEBIT', 'warning:WITHDRAWAL_NOT_CREDITED', 'error:WITHDRAWAL_NOT_CREDITED', 'warning:COMMISSION_MISMATCH', 'warning:ACCOUNT_STATS_MISMATCH']) expect(codes).toContain(c);
        const bal = rep.issues.find((i) => i.code === 'BALANCE_MISMATCH');
        expect(bal).toMatchObject({ walletPaise: 40000, ledgerPaise: 50000 - 10300 - 10300 - 1, driftPaise: 40000 - (50000 - 10300 - 10300 - 1) });
        expect(bal.message).toMatch(/drift/);
        expect(rep.issues.find((i) => i.code === 'HOLD_MISMATCH')).toMatchObject({ walletPaise: 0, expectedPaise: 10300 });
        expect(rep.issues.find((i) => i.code === 'ACCOUNT_STATS_MISMATCH').message).toMatch(/recompute-stats/);
        expect(db.updateDocument).not.toHaveBeenCalled();
        // and the user is NOT restricted: they can still create a request
        expect((await request(buildPayout(db, makeRedis()).app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 1 })).status).toBe(201);
    });

    test('wallets pager summarises each wallet; admin role only', async () => {
        const s = clean();
        s[COLS.WALLETS].push({ $id: 'w2', userId: 'user2', balancePaise: 5, holdPaise: 0 }); // no ledger rows → drift 5
        const db = makeDb(s);
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        const res = await request(app).get('/admin/integrity/wallets?limit=10');
        expect(res.status).toBe(200);
        expect(res.body.reports).toEqual([
            { userId: 'user1', ok: true, errors: 0, warnings: 0, truncated: false, balancePaise: 39700, holdPaise: 10300, driftPaise: 0, issueCodes: [] },
            { userId: 'user2', ok: false, errors: 1, warnings: 0, truncated: false, balancePaise: 5, holdPaise: 0, driftPaise: 5, issueCodes: ['BALANCE_MISMATCH'] },
        ]);
        expect(res.body.summary).toEqual({ wallets: 2, withErrors: 1, withWarnings: 0 });
        const emp = asUser('emp1', 'employee');
        expect((await request(buildPayout(db, makeRedis(), emp, () => emp).app).get('/admin/integrity/wallets')).status).toBe(403);
    });
});

describe('withdraw_new ownership check', () => {
    function buildWithdraw(db, auth) {
        let router;
        jest.isolateModules(() => {
            router = require('../withdraw.js')(db, {}, {}, { unique: () => 'newId1' }, Query, 'db1', 'users_meta', 'qr_col', 'withdrawal_col', 'bucket1',
                'daily_qr', 'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'config_col',
                jest.fn().mockResolvedValue(), jest.fn(), auth, () => auth, auth, auth, auth, {}, auth, () => auth, makeRedis(), jest.fn());
        });
        const app = express(); app.use(express.json()); app.use('/', router);
        return app;
    }
    const body = (userId) => ({ userId, qrId: 'qr1', mode: 'wallet', amount: 1, preAmount: 1, commission: 0 });
    const db = () => makeDb({ 'qr_col': [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 100000 }] });

    test('user: only self; subadmin: self or own users; admin: anyone', async () => {
        userMetaCache.getUserMeta.mockImplementation(async (id) => ({ user1: { userId: 'user1', parentId: 'sub1', commission: 0 }, userX: { userId: 'userX', parentId: 'subOther', commission: 0 }, sub1: { userId: 'sub1', commission: 0 } })[id] || null);
        const u = await request(buildWithdraw(db(), asUser('user1', 'user'))).post('/withdraw_new').send(body('userX'));
        expect(u.status).toBe(403); expect(u.body.error).toMatch(/own account/);
        expect((await request(buildWithdraw(db(), asUser('user1', 'user'))).post('/withdraw_new').send(body('user1'))).status).toBe(200);
        expect((await request(buildWithdraw(db(), asUser('sub1', 'subadmin'))).post('/withdraw_new').send(body('user1'))).status).toBe(200);
        const s = await request(buildWithdraw(db(), asUser('sub1', 'subadmin'))).post('/withdraw_new').send(body('userX'));
        expect(s.status).toBe(403); expect(s.body.error).toMatch(/own users/);
        expect((await request(buildWithdraw(db(), asUser('admin1', 'admin'))).post('/withdraw_new').send(body('userX'))).status).toBe(200);
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

describe('admin queue filters', () => {
    const row = (o) => ({ status: 'pending', amountPaise: 1, commissionPaise: 0, totalPaise: 1, createdAt: '2026-09-01T00:00:00.000Z', ...o });
    const seed = () => ({
        [COLS.USERS]: [
            { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1' },
            { $id: 'user2', userId: 'user2', role: 'user', parentId: 'sub1' },
            { $id: 'userX', userId: 'userX', role: 'user', parentId: 'subOther' },
        ],
        [COLS.QRS]: [{ $id: 'q1', qrId: 'QR001', assignedUserId: 'user2' }],
        [COLS.ACCOUNTS]: [
            { $id: 'accA', userId: 'user1', accountNumber: '11110000', bankingStatus: 'added' },
            { $id: 'accB', userId: 'user2', accountNumber: '22220000', bankingStatus: 'not_added' },
        ],
        [COLS.PAYOUTS]: [
            row({ $id: 'p1', id: 'cpo_1', userId: 'user1', accountId: 'accA', customerName: 'Ravi Kumar', accountNumber: '11110000', mode: 'IMPS', amountPaise: 50000, createdAt: '2026-09-01T00:00:00.000Z' }),
            row({ $id: 'p2', id: 'cpo_2', userId: 'user2', accountId: 'accB', customerName: 'Sita Devi', accountNumber: '22220000', upiId: 'sita@ybl', mode: 'UPI', amountPaise: 150000, status: 'paid', referenceNumber: 'UTR777', processedBy: 'admin1', processedAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-09-02T00:00:00.000Z' }),
            row({ $id: 'p3', id: 'cpo_3', userId: 'userX', accountId: 'accX', customerName: 'Ravi Shankar', accountNumber: '33330000', mode: 'NEFT', amountPaise: 99000, createdAt: '2026-09-03T00:00:00.000Z' }),
        ],
    });
    const ids = (res) => res.body.payouts.map((p) => p.id).sort();
    let app;
    beforeEach(() => { app = buildPayout(makeDb(seed()), makeRedis(), asUser('admin1', 'admin')).app; });

    test('subadminId → that subadmin\'s users; qrId → the QR\'s assigned user; both intersect', async () => {
        expect(ids(await request(app).get('/admin/requests?subadminId=sub1'))).toEqual(['cpo_1', 'cpo_2']);
        expect(ids(await request(app).get('/admin/requests?qrId=QR001'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?qrId=QR001&subadminId=sub1'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?qrId=QR001&userId=user1'))).toEqual([]); // disjoint → empty
        expect(ids(await request(app).get('/admin/requests?qrId=NOPE'))).toEqual([]);
    });

    test('mode, amount range (rupees), processedBy, accountId', async () => {
        expect(ids(await request(app).get('/admin/requests?mode=upi'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?minAmount=600'))).toEqual(['cpo_2', 'cpo_3']);
        expect(ids(await request(app).get('/admin/requests?minAmount=600&maxAmount=1000'))).toEqual(['cpo_3']);
        expect(ids(await request(app).get('/admin/requests?maxAmount=500'))).toEqual(['cpo_1']);
        expect(ids(await request(app).get('/admin/requests?processedBy=admin1'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?accountId=accA'))).toEqual(['cpo_1']);
        expect((await request(app).get('/admin/requests?mode=CASH')).status).toBe(400);
        expect((await request(app).get('/admin/requests?minAmount=10&maxAmount=5')).status).toBe(400);
    });

    test('search: name (default), digits → account number, upiId / referenceNumber / id explicit', async () => {
        expect(ids(await request(app).get('/admin/requests?search=ravi'))).toEqual(['cpo_1', 'cpo_3']);
        expect(ids(await request(app).get('/admin/requests?search=2222'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?search=sita@ybl&searchField=upiId'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?search=UTR777&searchField=referenceNumber'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?search=cpo_3&searchField=id'))).toEqual(['cpo_3']);
        expect((await request(app).get('/admin/requests?search=x&searchField=notes')).status).toBe(400);
    });

    test('bankingStatus filters by the account\'s current tag; sort by amount asc', async () => {
        expect(ids(await request(app).get('/admin/requests?bankingStatus=not_added'))).toEqual(['cpo_2']);
        expect(ids(await request(app).get('/admin/requests?bankingStatus=added&subadminId=sub1'))).toEqual(['cpo_1']);
        const sorted = await request(app).get('/admin/requests?sort=amount&order=asc');
        expect(sorted.body.payouts.map((p) => p.id)).toEqual(['cpo_1', 'cpo_3', 'cpo_2']);
        expect((await request(app).get('/admin/requests?sort=notes')).status).toBe(400);
    });

    test('subadmin: subadminId of someone else → 403; own users only even with qrId', async () => {
        const sub = asUser('sub1', 'subadmin');
        const { app: subApp } = buildPayout(makeDb(seed()), makeRedis(), sub, () => sub);
        expect((await request(subApp).get('/admin/requests?subadminId=subOther')).status).toBe(403);
        expect(ids(await request(subApp).get('/admin/requests?subadminId=sub1&mode=IMPS'))).toEqual(['cpo_1']);
        expect(ids(await request(subApp).get('/admin/requests?search=ravi'))).toEqual(['cpo_1']); // cpo_3 belongs to another subadmin
    });

    test('user list accepts the row filters but stays scoped to self', async () => {
        const { app: userApp } = buildPayout(makeDb(seed()), makeRedis(), asUser('user1'));
        expect(ids(await request(userApp).get('/requests?search=ravi'))).toEqual(['cpo_1']);
        expect(ids(await request(userApp).get('/requests?userId=user2&subadminId=sub1'))).toEqual(['cpo_1']); // scope params ignored
    });
});

describe('customer account stats + detail', () => {
    test('request → paid / reject bump the account stats; pickAccount exposes them', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }], [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }] });
        const { app } = buildPayout(db, makeRedis());
        const r1 = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 100 }); // 10000 + 300
        const r2 = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'IMPS', amount: 50 });  // 5000 + 150
        const r3 = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'RTGS', amount: 20 });
        expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);
        const accId = r1.body.payout.accountId;
        expect(db.store[COLS.ACCOUNTS][0]).toMatchObject({ requestCount: 3, lastRequestedAt: r3.body.payout.createdAt });

        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        await request(adminApp).post(`/admin/requests/${r1.body.payout.id}/paid`).send({ referenceNumber: 'UTR00001' });
        await request(adminApp).post(`/admin/requests/${r2.body.payout.id}/paid`).send({ referenceNumber: 'UTR00002' });
        await request(adminApp).post(`/admin/requests/${r3.body.payout.id}/reject`).send({ reason: 'Wrong IFSC' });
        expect(db.store[COLS.ACCOUNTS][0]).toMatchObject({ requestCount: 3, paidCount: 2, rejectedCount: 1, totalPaidPaise: 15000, totalCommissionPaise: 450 });
        expect(db.store[COLS.ACCOUNTS][0].lastPaidAt).toBeTruthy();

        const list = await request(adminApp).get('/admin/accounts');
        expect(list.body.accounts[0]).toMatchObject({ $id: accId, requestCount: 3, paidCount: 2, rejectedCount: 1, pendingCount: 0, totalPaidPaise: 15000, totalPaidRs: 150, totalCommissionPaise: 450 });

        // detail: account + its payouts (filters apply)
        const detail = await request(adminApp).get(`/admin/accounts/${accId}/payouts?status=paid&sort=amount&order=asc`);
        expect(detail.status).toBe(200);
        expect(detail.body.account.$id).toBe(accId);
        expect(detail.body.payouts.map((p) => [p.id, p.status])).toEqual([[r2.body.payout.id, 'paid'], [r1.body.payout.id, 'paid']]);
        expect(detail.body.total).toBe(2);
        // user sees their own account history; someone else's → 404
        const own = await request(app).get(`/accounts/${accId}/payouts`);
        expect(own.body.total).toBe(3);
        expect((await request(buildPayout(db, makeRedis(), asUser('user2')).app).get(`/accounts/${accId}/payouts`)).status).toBe(404);
    });

    test('a failing stats bump never fails the money operation; recompute-stats repairs it', async () => {
        const db = makeDb({ [COLS.WALLETS]: [{ $id: 'w1', userId: 'user1', balancePaise: 100000, holdPaise: 0 }], [COLS.USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }] });
        const origUpdate = db.updateDocument.getMockImplementation();
        db.updateDocument.mockImplementation(async (d, c, id, data) => {
            if (c === COLS.ACCOUNTS && 'requestCount' in data) throw new Error('stats down');
            return origUpdate(d, c, id, data);
        });
        const { app } = buildPayout(db, makeRedis());
        const r = await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 100 });
        expect(r.status).toBe(201);
        expect(db.store[COLS.ACCOUNTS][0].requestCount).toBeUndefined();
        const { app: adminApp } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(adminApp).post(`/admin/requests/${r.body.payout.id}/paid`).send({ referenceNumber: 'UTR00001' })).status).toBe(200);
        db.updateDocument.mockImplementation(origUpdate);
        const fixed = await request(adminApp).post(`/admin/accounts/${r.body.payout.accountId}/recompute-stats`);
        expect(fixed.status).toBe(200);
        expect(fixed.body.account).toMatchObject({ requestCount: 1, paidCount: 1, rejectedCount: 0, pendingCount: 0, totalPaidPaise: 10000, totalCommissionPaise: 300 });
        expect(fixed.body.account.lastPaidAt).toBeTruthy();
    });

    test('accounts list: sort by totalPaid, minTotalPaid, subadminId scope, invalid sort → 400', async () => {
        const db = makeDb({
            [COLS.USERS]: [{ $id: 'user1', userId: 'user1', parentId: 'sub1' }, { $id: 'userX', userId: 'userX', parentId: 'subOther' }],
            [COLS.ACCOUNTS]: [
                { $id: 'a1', userId: 'user1', customerName: 'A', accountNumber: '1', totalPaidPaise: 5000, paidCount: 1, createdAt: '2026-09-01T00:00:00.000Z' },
                { $id: 'a2', userId: 'user1', customerName: 'B', accountNumber: '2', totalPaidPaise: 90000, paidCount: 4, createdAt: '2026-09-02T00:00:00.000Z' },
                { $id: 'aX', userId: 'userX', customerName: 'X', accountNumber: '3', totalPaidPaise: 20000, paidCount: 2, createdAt: '2026-09-03T00:00:00.000Z' },
            ],
        });
        const { app } = buildPayout(db, makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).get('/admin/accounts?sort=totalPaid')).body.accounts.map((a) => a.$id)).toEqual(['a2', 'aX', 'a1']);
        expect((await request(app).get('/admin/accounts?sort=paidCount&order=asc')).body.accounts.map((a) => a.$id)).toEqual(['a1', 'aX', 'a2']);
        expect((await request(app).get('/admin/accounts?minTotalPaid=150')).body.accounts.map((a) => a.$id).sort()).toEqual(['a2', 'aX']);
        expect((await request(app).get('/admin/accounts?subadminId=sub1&sort=totalPaid')).body.accounts.map((a) => a.$id)).toEqual(['a2', 'a1']);
        expect((await request(app).get('/admin/accounts?sort=nope')).status).toBe(400);
        const sub = asUser('sub1', 'subadmin');
        const { app: subApp } = buildPayout(db, makeRedis(), sub, () => sub);
        expect((await request(subApp).get('/admin/accounts/aX/payouts')).status).toBe(403);
        expect((await request(subApp).get('/admin/accounts/a2/payouts')).status).toBe(200);
    });

    test('admin cannot create requests or accounts for themself', async () => {
        const { app } = buildPayout(makeDb(), makeRedis(), asUser('admin1', 'admin'));
        expect((await request(app).post('/accounts').send(ACCOUNT)).status).toBe(403);
        expect((await request(app).post('/requests').send({ ...ACCOUNT, mode: 'NEFT', amount: 10 })).status).toBe(403);
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
