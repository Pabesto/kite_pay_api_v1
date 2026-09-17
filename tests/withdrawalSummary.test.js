/**
 * Day-wise withdrawal report (withdrawalSummary.js + GET /admin/withdrawal-summary) — pins:
 *   • per-row math: rupees → paise once, direct (upi/bank) vs wallet buckets, legacy docs without preAmount
 *   • record(): lock acquire/Lua release, create-then-merge, fail-closed on a busy lock or a corrupt doc,
 *     silent no-op when the rollup is not configured
 *   • approve_new writes the day's doc, and a rollup failure never fails the approval
 *   • the admin report: QR + company grouping, direct/wallet split, mode / companyName filters, scoping
 */

const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');
const moment = require('moment-timezone');

jest.mock('../scripts/transactionStatusMailer', () => ({ sendMerchantHoldEmail: jest.fn() }));
jest.mock('../dashboardCounters', () => ({ updateDashboardCounter: jest.fn().mockResolvedValue() }));
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async () => null), invalidate: jest.fn() }));
jest.mock('../qrOwnerCache', () => ({ reload: jest.fn().mockResolvedValue(null), invalidateQr: jest.fn(), resolve: jest.fn().mockResolvedValue(null), get: jest.fn() }));
const mockConfig = { max_withdrawal_requests: 2, company_names: { 'SCANSERVE AI PRIVATE LIMITED': 'x@y.z', 'PABESTO TECH PVT. LTD.': '' } };
jest.mock('../configManager', () => ({
    get: jest.fn((key, def = null) => (key in mockConfig ? mockConfig[key] : def)),
    refresh: jest.fn().mockResolvedValue({}), getConfig: jest.fn().mockResolvedValue({}), set: jest.fn().mockResolvedValue(),
}));

const QRS = 'qr_col', WD = 'withdrawal_col', DAILY_WD = 'daily_withdrawal';
const today = () => moment().tz('Asia/Kolkata').format('YYYY-MM-DD');

/** In-memory Appwrite: equal/limit honoured; ordering and cursors ignored (every fixture fits one page). */
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
        createDocument: jest.fn(async (_d, c, _id, data) => { const doc = { $id: `${c}_${++seq}`, ...data }; col(c).push(doc); return { ...doc }; }),
        updateDocument: jest.fn(async (_d, c, id, data) => { const d = col(c).find((x) => x.$id === id); Object.assign(d, data); return { ...d }; }),
        getDocument: jest.fn(async (_d, c, id) => ({ ...col(c).find((x) => x.$id === id) })),
    };
}
const makeRedis = (o = {}) => ({ set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1), ...o });
const dailyDoc = (db) => db.store[DAILY_WD]?.[0];
const totalsOf = (db) => JSON.parse(dailyDoc(db).totalsJson);

/** Fresh module registry: the withdrawalSummary singleton + whichever router the test needs, init'd against the same db. */
function build(db, redis, { withdraw = false, admin = false, auth } = {}) {
    const out = {};
    jest.isolateModules(() => {
        const ws = require('../withdrawalSummary');
        ws.init({ databases: db, Query, ID: { unique: () => 'unique' }, redisClient: redis, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID: DAILY_WD });
        out.ws = ws;
        const asAdmin = auth || ((req, _res, next) => { req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] }; next(); });
        if (withdraw) {
            // Positional args mirror the app.use('/api/user', withdrawRoutes(...)) mount in server.js.
            out.withdraw = require('../withdraw.js')(db, {}, {}, { unique: () => 'newId1' }, Query, 'db1', 'users_meta', QRS, WD, 'bucket1',
                'daily_qr', 'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'config_col',
                jest.fn().mockResolvedValue(), jest.fn(), asAdmin, () => asAdmin, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin, redis, jest.fn());
        }
        if (admin) {
            require('../qrSettlement').init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: 'daily_qr', APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: 'releases' });
            // Positional args mirror the app.use('/api/admin', adminRoutes(...)) mount in server.js (42 args).
            out.admin = require('../admin.js')(
                'https://appwrite.test/v1', 'proj1', db, {}, {}, { unique: () => 'unique' }, Query, 'db1',
                'users_meta', QRS, 'webhook_col', 'bucket1', 'daily_qr', 'daily_deleted', 'daily_flagged',
                'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'dashboard_counters', 'manual_hold', 'config_col',
                jest.fn().mockResolvedValue(), jest.fn(), asAdmin, () => asAdmin, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin, redis, jest.fn(),
                WD, jest.fn().mockResolvedValue(), 'rejected_txns', 'daily_rejected', jest.fn(), 'alltime_payout_comm', 'payout_wallets', 'customer_payouts'
            );
        }
    });
    for (const k of ['withdraw', 'admin']) if (out[k]) { const app = express(); app.use(express.json()); app.use('/', out[k]); out[k] = app; }
    return out;
}

describe('addWithdrawal — the one place rupees become paise', () => {
    const { addWithdrawal } = require('../withdrawalSummary');
    test('buckets by mode, converts once, tolerates legacy docs without preAmount', () => {
        const t = {};
        addWithdrawal(t, { qrId: 'A', mode: 'bank', preAmount: 100.10, commission: 2.5 });
        addWithdrawal(t, { qrId: 'A', mode: 'upi', preAmount: 50, commission: 1.25 });
        addWithdrawal(t, { qrId: 'A', mode: 'wallet', preAmount: 200, commission: 0 });
        addWithdrawal(t, { qrId: 'B', mode: 'bank', amount: 103, commission: 3 });   // legacy: gross − commission
        expect(t).toEqual({
            A: { direct: { paidPaise: 15010, commissionPaise: 375, count: 2 }, wallet: { paidPaise: 20000, commissionPaise: 0, count: 1 } },
            B: { direct: { paidPaise: 10000, commissionPaise: 300, count: 1 } },
        });
    });
});

describe('record()', () => {
    const w = { id: 'wdh_1', qrId: 'A', mode: 'bank', preAmount: 100, commission: 2, processedAt: `${today()}T04:00:00.000Z` };

    test('creates the day doc under lock:withdrawal:daily:<day>, then merges into it; lock released via Lua', async () => {
        const db = makeDb(), redis = makeRedis();
        const { ws } = build(db, redis);
        expect(await ws.record(w)).toBe(today());
        expect(redis.set).toHaveBeenCalledWith(`lock:withdrawal:daily:${today()}`, expect.any(String), { NX: true, EX: 10 });
        expect(redis.eval).toHaveBeenCalledTimes(1);
        expect(totalsOf(db)).toEqual({ A: { direct: { paidPaise: 10000, commissionPaise: 200, count: 1 } } });

        await ws.record({ ...w, id: 'wdh_2', mode: 'wallet', preAmount: 40, commission: 0 });
        expect(db.store[DAILY_WD]).toHaveLength(1);
        expect(totalsOf(db)).toEqual({ A: { direct: { paidPaise: 10000, commissionPaise: 200, count: 1 }, wallet: { paidPaise: 4000, commissionPaise: 0, count: 1 } } });
        expect(redis.eval).toHaveBeenCalledTimes(2);
    });

    test('fails closed: busy lock → throws without touching the DB; Redis error counts as busy', async () => {
        const db = makeDb(), redis = makeRedis({ set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
        const { ws } = build(db, redis);
        await expect(ws.record(w)).rejects.toThrow(/Could not acquire lock:withdrawal:daily/);
        expect(db.listDocuments).not.toHaveBeenCalled();
        expect(db.createDocument).not.toHaveBeenCalled();
    }, 10000);

    test('a corrupt day doc is never overwritten (would drop every other QR)', async () => {
        const db = makeDb({ [DAILY_WD]: [{ $id: 'd1', date: today(), totalsJson: '{not json' }] }), redis = makeRedis();
        const { ws } = build(db, redis);
        await expect(ws.record(w)).rejects.toThrow(/Corrupt totalsJson/);
        expect(db.updateDocument).not.toHaveBeenCalled();
        expect(redis.eval).toHaveBeenCalledTimes(1);   // lock still released
    });

    test('not configured → null, no Redis, no DB', async () => {
        let ws;
        jest.isolateModules(() => { ws = require('../withdrawalSummary'); });
        expect(await ws.record(w)).toBeNull();
    });
});

describe('approve_new writes the rollup', () => {
    const seed = () => ({
        [WD]: [{ $id: 'wd1', id: 'wdh_1', userId: 'user1', qrId: 'qr1', mode: 'bank', status: 'pending', amount: 102, preAmount: 100, commission: 2 }],
        [QRS]: [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 100000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 10000, amountOnHold: 0, commissionOnHold: 200, commissionPaid: 0 }],
    });

    test('approved direct withdrawal lands in today\'s direct bucket (rupees → paise once)', async () => {
        const db = makeDb(seed());
        const { withdraw } = build(db, makeRedis(), { withdraw: true });
        const res = await request(withdraw).post('/withdrawals/approve_new').send({ id: 'wdh_1', utrNumber: 'UTR12345' });
        expect(res.status).toBe(200);
        expect(db.store[WD][0]).toMatchObject({ status: 'approved' });
        expect(dailyDoc(db).date).toBe(today());
        expect(totalsOf(db)).toEqual({ qr1: { direct: { paidPaise: 10000, commissionPaise: 200, count: 1 } } });
    });

    test('rollup failure is logged CRITICAL and never fails the approval', async () => {
        const db = makeDb(seed());
        db.createDocument.mockImplementation(async (_d, c) => { if (c === DAILY_WD) throw new Error('appwrite down'); return { $id: 'x' }; });
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { withdraw } = build(db, makeRedis(), { withdraw: true });
        const res = await request(withdraw).post('/withdrawals/approve_new').send({ id: 'wdh_1', utrNumber: 'UTR12345' });
        expect(res.status).toBe(200);
        expect(db.store[WD][0]).toMatchObject({ status: 'approved' });
        expect(err.mock.calls.some((c) => String(c[0]).includes('CRITICAL: daily withdrawal summary failed for wdh_1'))).toBe(true);
        err.mockRestore();
    });
});

describe('GET /withdrawal-summary', () => {
    const seed = () => ({
        [QRS]: [
            { $id: 'q1', qrId: 'A', companyName: 'scanserve ai private limited', assignedUserId: 'u1' },   // lower-case on the QR → config spelling
            { $id: 'q2', qrId: 'B', companyName: 'Other Shop', assignedUserId: 'u2' },                     // not in config → own bucket
            { $id: 'q3', qrId: 'C', assignedUserId: 'u2' },                                                // blank → (no company)
        ],
        [DAILY_WD]: [{ $id: 'd1', date: today(), totalsJson: JSON.stringify({
            A: { direct: { paidPaise: 10000, commissionPaise: 200, count: 1 }, wallet: { paidPaise: 4000, commissionPaise: 0, count: 1 } },
            B: { wallet: { paidPaise: 5000, commissionPaise: 0, count: 2 } },
            C: { direct: { paidPaise: 100, commissionPaise: 1, count: 1 } },
        }) }],
    });
    const row = (paidPaise, commissionPaise, count, direct, wallet) => ({ paidPaise, commissionPaise, count, direct, wallet });
    const R = (paidPaise = 0, commissionPaise = 0, count = 0) => ({ paidPaise, commissionPaise, count });

    test('admin: QR rows, company rows (config spelling, zero rows kept), direct/wallet split, grand totals', async () => {
        const { admin } = build(makeDb(seed()), makeRedis(), { admin: true });
        const res = await request(admin).get('/withdrawal-summary');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            grandTotalPaise: 19100, grandTotalRs: 191, grandCommissionPaise: 201, grandCommissionRs: 2.01, grandCount: 5,
            direct: R(10100, 201, 2), wallet: R(9000, 0, 3), todayPaise: 19100, yesterdayPaise: 0,
        });
        expect(res.body.days).toHaveLength(1);
        expect(res.body.days[0]).toMatchObject({ date: today(), totalPaise: 19100, commissionPaise: 201, count: 5, direct: R(10100, 201, 2), wallet: R(9000, 0, 3) });
        expect(res.body.days[0].qrs).toEqual({
            A: row(14000, 200, 2, R(10000, 200, 1), R(4000, 0, 1)),
            B: row(5000, 0, 2, R(), R(5000, 0, 2)),
            C: row(100, 1, 1, R(100, 1, 1), R()),
        });
        expect(res.body.days[0].companies).toEqual({
            'SCANSERVE AI PRIVATE LIMITED': row(14000, 200, 2, R(10000, 200, 1), R(4000, 0, 1)),
            'Other Shop': row(5000, 0, 2, R(), R(5000, 0, 2)),
            '(no company)': row(100, 1, 1, R(100, 1, 1), R()),
        });
        expect(res.body.companies.map((c) => [c.companyName, c.totalPaise, c.totalRs, c.commissionPaise, c.count])).toEqual([
            ['SCANSERVE AI PRIVATE LIMITED', 14000, 140, 200, 2],
            ['Other Shop', 5000, 50, 0, 2],
            ['(no company)', 100, 1, 1, 1],
            ['PABESTO TECH PVT. LTD.', 0, 0, 0, 0],
        ]);
    });

    test('?mode=wallet drops QRs with no wallet activity; ?companyName= narrows; bad mode → 400', async () => {
        const { admin } = build(makeDb(seed()), makeRedis(), { admin: true });
        const wallet = await request(admin).get('/withdrawal-summary').query({ mode: 'wallet' });
        expect(wallet.status).toBe(200);
        expect(Object.keys(wallet.body.days[0].qrs)).toEqual(['A', 'B']);
        expect(wallet.body).toMatchObject({ grandTotalPaise: 9000, grandCount: 3, direct: R(), wallet: R(9000, 0, 3) });

        const co = await request(admin).get('/withdrawal-summary').query({ companyName: ' scanserve AI private limited ' });
        expect(co.status).toBe(200);
        expect(Object.keys(co.body.days[0].qrs)).toEqual(['A']);
        expect(co.body.grandTotalPaise).toBe(14000);

        expect((await request(admin).get('/withdrawal-summary').query({ mode: 'neft' })).status).toBe(400);
    });

    test('regular user only sees their own QRs; a foreign qrId is 403', async () => {
        const asUser = (req, _res, next) => { req.user = { userId: 'u2', role: 'user', $id: 'u2', labels: [] }; next(); };
        const { admin } = build(makeDb(seed()), makeRedis(), { admin: true, auth: asUser });
        const res = await request(admin).get('/withdrawal-summary');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.days[0].qrs).sort()).toEqual(['B', 'C']);
        expect(res.body.grandTotalPaise).toBe(5100);
        expect((await request(admin).get('/withdrawal-summary').query({ qrId: 'A' })).status).toBe(403);
    });

    test('not configured → 500 with the contractual message', async () => {
        let app;
        jest.isolateModules(() => {
            const db = makeDb(seed());
            require('../qrSettlement').init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: 'daily_qr', APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: 'releases' });
            const asAdmin = (req, _res, next) => { req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] }; next(); };
            const router = require('../admin.js')(
                'https://appwrite.test/v1', 'proj1', db, {}, {}, { unique: () => 'unique' }, Query, 'db1',
                'users_meta', QRS, 'webhook_col', 'bucket1', 'daily_qr', 'daily_deleted', 'daily_flagged',
                'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'dashboard_counters', 'manual_hold', 'config_col',
                jest.fn().mockResolvedValue(), jest.fn(), asAdmin, () => asAdmin, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin, makeRedis(), jest.fn(),
                WD, jest.fn().mockResolvedValue(), 'rejected_txns', 'daily_rejected', jest.fn(), 'alltime_payout_comm', 'payout_wallets', 'customer_payouts'
            );
            app = express(); app.use('/', router);
        });
        const res = await request(app).get('/withdrawal-summary');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Daily withdrawal summaries are not configured');
    });
});

describe('repointQr() — hold-and-reset moves a QR key to the _hold id', () => {
    test('merges per mode into an existing hold entry, leaves other QRs alone, locks each day', async () => {
        const db = makeDb({ [DAILY_WD]: [
            { $id: 'd1', date: '2026-09-01', totalsJson: JSON.stringify({ A: { direct: { paidPaise: 100, commissionPaise: 1, count: 1 } }, Z: { wallet: { paidPaise: 5, commissionPaise: 0, count: 1 } } }) },
            { $id: 'd2', date: '2026-09-02', totalsJson: JSON.stringify({ A: { wallet: { paidPaise: 200, commissionPaise: 0, count: 2 } }, A_hold: { direct: { paidPaise: 10, commissionPaise: 1, count: 1 }, wallet: { paidPaise: 1, commissionPaise: 0, count: 1 } } }) },
            { $id: 'd3', date: '2026-09-03', totalsJson: JSON.stringify({ Z: { direct: { paidPaise: 7, commissionPaise: 0, count: 1 } } }) },
        ] });
        const redis = makeRedis();
        const { ws } = build(db, redis);
        expect(await ws.repointQr('A', 'A_hold')).toBe(2);
        expect(JSON.parse(db.store[DAILY_WD][0].totalsJson)).toEqual({ Z: { wallet: { paidPaise: 5, commissionPaise: 0, count: 1 } }, A_hold: { direct: { paidPaise: 100, commissionPaise: 1, count: 1 } } });
        expect(JSON.parse(db.store[DAILY_WD][1].totalsJson)).toEqual({ A_hold: { direct: { paidPaise: 10, commissionPaise: 1, count: 1 }, wallet: { paidPaise: 201, commissionPaise: 0, count: 3 } } });
        expect(JSON.parse(db.store[DAILY_WD][2].totalsJson)).toEqual({ Z: { direct: { paidPaise: 7, commissionPaise: 0, count: 1 } } });
        expect(redis.set.mock.calls.map((c) => c[0])).toEqual(['lock:withdrawal:daily:2026-09-01', 'lock:withdrawal:daily:2026-09-02']);
        expect(redis.eval).toHaveBeenCalledTimes(2);
    });
});
