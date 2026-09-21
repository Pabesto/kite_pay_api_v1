/**
 * commissionRouting.test.js — who EARNS a withdrawal's commission at approve time.
 * Pins: earners come from the request-time snapshot (userCommissionRate / parentCommissionRate on the
 * doc), never from whoever the user's parent happens to be at approve time. A parent that vanished or
 * appeared between request and approve can neither strand commission (charged to the QR, booked to
 * nobody) nor hand admin's share to a subadmin. The normal split is byte-identical to before.
 */
const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');

const mockConfig = {};
jest.mock('../configManager', () => ({
    get: jest.fn((key, def = null) => (key in mockConfig ? mockConfig[key] : def)),
    refresh: jest.fn().mockResolvedValue({}),
    getConfig: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(),
}));
jest.mock('../scripts/transactionStatusMailer', () => ({ sendMerchantHoldEmail: jest.fn() }));
const counters = [];
jest.mock('../dashboardCounters', () => ({ init: jest.fn(), updateDashboardCounter: jest.fn(async (_db, _id, name, delta) => { counters.push([name, delta]); }) }));
// Mutable so a test can change the user's parent BETWEEN request and approve.
const META = {};
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async (id) => META[id] || null), invalidate: jest.fn() }));

const DAILY = 'daily_qr', RELEASES = 'qr_daily_releases', QRS = 'qr_col', WD = 'withdrawal_col', USERS = 'users_meta', COMM = 'commission_txs';

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
            return { documents: docs.slice(0, limit), total: docs.length };
        }),
        createDocument: jest.fn(async (_d, c, _id, data) => { const doc = { $id: `${c}_${++seq}`, ...data }; col(c).push(doc); return { ...doc }; }),
        updateDocument: jest.fn(async (_d, c, id, data) => { const d = col(c).find((x) => x.$id === id); Object.assign(d, data); return { ...d }; }),
        deleteDocument: jest.fn(async () => ({})),
        getDocument: jest.fn(async (_d, c, id) => col(c).find((x) => x.$id === id) || Promise.reject(Object.assign(new Error('nf'), { code: 404 }))),
    };
}
const istToday = () => require('moment-timezone')().tz('Asia/Kolkata').format('YYYY-MM-DD');

function build() {
    mockConfig.max_withdrawal_requests = 99;
    const db = makeDb({
        [QRS]: [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 500000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0, amountAvailableForWithdrawal: 500000 }],
        [DAILY]: [{ $id: 'd1', date: istToday(), totalsJson: JSON.stringify({}) }],
        [USERS]: [{ $id: 'admin1', userId: 'admin1', role: 'admin' }],
    });
    const asAdmin = (req, _r, next) => { req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] }; next(); };
    let router;
    jest.isolateModules(() => {
        require('../qrSettlement').init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: RELEASES });
        router = require('../withdraw.js')(db, {}, {}, { unique: () => 'w1' }, Query, 'db1', USERS, QRS, WD, 'b',
            DAILY, COMM, 'daily_commission', 'all_time_commission', 'monthly_commission', 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asAdmin, () => asAdmin, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin,
            { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) }, jest.fn());
    });
    const app = express(); app.use(express.json()); app.use('/', router);
    return { db, app };
}

// ₹1,000 request; commission body must match what the server recomputes from the CURRENT rates
const requestAt = (app, ratePct) => request(app).post('/withdraw_new')
    .send({ userId: 'user1', qrId: 'qr1', mode: 'upi', upiId: 'a@ybl', holderName: 'A', preAmount: 1000, amount: 1000 * (1 + ratePct / 100), commission: 1000 * ratePct / 100 });
const approve = (app, id) => request(app).post('/withdrawals/approve_new').send({ id, utrNumber: 'UTR123456' });
const rows = (db) => (db.store[COMM] || []).map((c) => ({ userId: c.userId, amount: c.amount, rate: c.commissionRate, type: c.earningType }));

beforeEach(() => {
    for (const k of Object.keys(META)) delete META[k];
    counters.length = 0;
    META.admin1 = { $id: 'admin1', userId: 'admin1', role: 'admin' };
    META.sub1 = { $id: 'sub1', userId: 'sub1', role: 'subadmin', parentId: null, commission: 2 };
});

describe('approve-time commission routing', () => {
    test('normal split is unchanged: user rate → subadmin, parent rate → admin', async () => {
        META.user1 = { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1', commission: 1 };
        const { db, app } = build();
        const created = await requestAt(app, 3);
        expect(created.status).toBe(200);
        expect((await approve(app, created.body.data.id)).status).toBe(200);
        expect(rows(db)).toEqual([
            { userId: 'sub1', amount: 1000, rate: 1, type: 'subadmin' },
            { userId: 'admin1', amount: 2000, rate: 2, type: 'admin' },
        ]);
        expect(counters).toEqual(expect.arrayContaining([['totalMerchantProfit', 1000], ['totalAdminProfit', 2000]]));
    });

    test('parent removed between request and approve → the whole charged commission goes to admin, nothing stranded', async () => {
        META.user1 = { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1', commission: 1 };
        const { db, app } = build();
        const created = await requestAt(app, 3);
        expect(created.status).toBe(200);
        META.user1.parentId = null;                              // unassigned before approve
        expect((await approve(app, created.body.data.id)).status).toBe(200);
        expect(rows(db)).toEqual([{ userId: 'admin1', amount: 3000, rate: 3, type: 'admin' }]); // = exactly what the QR was debited
        expect(db.store[QRS][0].commissionPaid).toBe(3000);
        expect(counters).toEqual(expect.arrayContaining([['totalAdminProfit', 3000]]));
        expect(counters.find(([n]) => n === 'totalMerchantProfit')).toBeUndefined();
    });

    test('parent deleted (doc missing) at approve → same: all to admin', async () => {
        META.user1 = { $id: 'user1', userId: 'user1', role: 'user', parentId: 'sub1', commission: 1 };
        const { db, app } = build();
        const created = await requestAt(app, 3);
        delete META.sub1;                                        // subadmin doc gone
        expect((await approve(app, created.body.data.id)).status).toBe(200);
        expect(rows(db)).toEqual([{ userId: 'admin1', amount: 3000, rate: 3, type: 'admin' }]);
    });

    test("parent gained between request and approve → admin keeps what was admin's share; the new subadmin earns nothing", async () => {
        META.user1 = { $id: 'user1', userId: 'user1', role: 'user', parentId: null, commission: 2.2 }; // admin-created
        const { db, app } = build();
        const created = await requestAt(app, 2.2);
        expect(created.status).toBe(200);
        META.user1.parentId = 'sub1';                            // assigned to a subadmin before approve
        expect((await approve(app, created.body.data.id)).status).toBe(200);
        expect(rows(db)).toEqual([{ userId: 'admin1', amount: 2200, rate: 2.2, type: 'admin' }]);
        expect(counters.find(([n]) => n === 'totalMerchantProfit')).toBeUndefined();
    });

    test('subadmin withdrawing for itself: its own rate → admin', async () => {
        META.user1 = { $id: 'user1', userId: 'user1', role: 'subadmin', parentId: null, commission: 2.2 };
        const { db, app } = build();
        const created = await requestAt(app, 2.2);
        expect(created.status).toBe(200);
        expect((await approve(app, created.body.data.id)).status).toBe(200);
        expect(rows(db)).toEqual([{ userId: 'admin1', amount: 2200, rate: 2.2, type: 'admin' }]);
    });
});
