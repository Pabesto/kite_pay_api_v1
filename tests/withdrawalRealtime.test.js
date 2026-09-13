/**
 * withdrawalRealtime.test.js — `withdrawal:update` socket events from withdraw.js.
 * Pins: one event per commit point (requested / approved / rejected) with the tenant audience
 * [parentId, userId]; fired only AFTER the doc is written; no bank/UPI details in the payload;
 * the kill switch; and that a broken or absent emitter can never fail a withdrawal.
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
jest.mock('../dashboardCounters', () => ({ init: jest.fn(), updateDashboardCounter: jest.fn().mockResolvedValue() }));
const META = {
    user1: { $id: 'user1', userId: 'user1', role: 'user', name: 'Ramesh Stores', parentId: 'sub1', commission: 0 },
    admin1: { $id: 'admin1', userId: 'admin1', role: 'admin', name: 'Ops Admin' },
    sub1: { $id: 'sub1', userId: 'sub1', role: 'subadmin', name: 'Sub One', parentId: null, commission: 0 },
};
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async (id) => META[id] || null), invalidate: jest.fn() }));

const DAILY = 'daily_qr', RELEASES = 'qr_daily_releases', QRS = 'qr_col', WD = 'withdrawal_col', USERS = 'users_meta';

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

// `emit` may be a jest.fn, a throwing fn, or undefined (the 28-arg constructors the older tests use).
function build(emit) {
    mockConfig.max_withdrawal_requests = 99;
    const db = makeDb({
        [QRS]: [{ $id: 'q1', qrId: 'qr1', totalPayInAmount: 500000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0, amountAvailableForWithdrawal: 500000 }],
        [DAILY]: [{ $id: 'd1', date: istToday(), totalsJson: JSON.stringify({}) }], // no pay-in today → nothing held back
        [USERS]: [META.admin1, META.sub1, META.user1],
    });
    const asAdmin = (req, _r, next) => { req.user = { ...META.admin1, labels: [] }; next(); };
    let router;
    jest.isolateModules(() => {
        require('../qrSettlement').init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: RELEASES });
        router = require('../withdraw.js')(db, {}, {}, { unique: () => 'w1' }, Query, 'db1', USERS, QRS, WD, 'b',
            DAILY, 'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asAdmin, () => asAdmin, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin,
            { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) }, jest.fn(), emit);
    });
    const app = express(); app.use(express.json()); app.use('/', router);
    return { db, app };
}
const ask = (app, rs = 1000) => request(app).post('/withdraw_new')
    .send({ userId: 'user1', qrId: 'qr1', mode: 'upi', upiId: 'ramesh@ybl', holderName: 'Ramesh', preAmount: rs, amount: rs, commission: 0 });

beforeEach(() => { for (const k of Object.keys(mockConfig)) delete mockConfig[k]; });

describe('withdrawal:update', () => {
    test('requested → one event to the user + tenant staff, full sanitized row, no bank/UPI details', async () => {
        const emit = jest.fn();
        const { app } = build(emit);
        const res = await ask(app);
        expect(res.status).toBe(200);

        expect(emit).toHaveBeenCalledTimes(1);
        const call = emit.mock.calls[0][0];
        expect(call).toMatchObject({ userId: 'user1', staffRooms: ['sub1', 'user1'], event: 'withdrawal:update' });
        expect(call.payload).toMatchObject({
            type: 'requested', userId: 'user1', withdrawalId: res.body.data.id, userName: 'Ramesh Stores', parentId: 'sub1',
            actor: { userId: 'admin1', role: 'admin', name: 'Ops Admin' },
        });
        expect(call.payload.withdrawal).toMatchObject({
            withdrawalId: res.body.data.id, userId: 'user1', qrId: 'qr1', mode: 'upi', status: 'pending',
            amountRs: 1000, preAmountRs: 1000, commissionRs: 0, amountPaise: 100000, preAmountPaise: 100000, commissionPaise: 0,
            holderName: 'Ramesh',
        });
        for (const secret of ['upiId', 'accountNumber', 'ifscCode', 'bankName']) expect(call.payload.withdrawal).not.toHaveProperty(secret);
        expect(typeof call.payload.at).toBe('string');
    });

    test('approved → event carries utrNumber and status, and fires only after the doc is approved', async () => {
        let statusAtEmit = null;
        const { app, db } = build(jest.fn(() => { statusAtEmit = db.store[WD][0].status; }));
        const created = await ask(app);
        const res = await request(app).post('/withdrawals/approve_new').send({ id: created.body.data.id, utrNumber: 'UTR123456' });
        expect(res.status).toBe(200);
        expect(statusAtEmit).toBe('approved'); // the last emit (approved) saw the committed doc
    });

    test('approved payload', async () => {
        const emit = jest.fn();
        const { app } = build(emit);
        const created = await ask(app);
        await request(app).post('/withdrawals/approve_new').send({ id: created.body.data.id, utrNumber: 'UTR123456' });
        const approved = emit.mock.calls.find((c) => c[0].payload.type === 'approved')[0];
        expect(approved).toMatchObject({ userId: 'user1', staffRooms: ['sub1', 'user1'] });
        expect(approved.payload.withdrawal).toMatchObject({ withdrawalId: created.body.data.id, status: 'approved', utrNumber: 'UTR123456', rejectionReason: null, preAmountPaise: 100000 });
        expect(approved.payload.withdrawal.processedAt).toBeTruthy();
    });

    test('rejected → event carries the reason', async () => {
        const emit = jest.fn();
        const { app } = build(emit);
        const created = await ask(app);
        const res = await request(app).post('/withdrawals/reject_new').send({ id: created.body.data.id, reason: 'Name mismatch on UPI' });
        expect(res.status).toBe(200);
        const rejected = emit.mock.calls.find((c) => c[0].payload.type === 'rejected')[0];
        expect(rejected.payload.withdrawal).toMatchObject({ status: 'rejected', rejectionReason: 'Name mismatch on UPI', utrNumber: null });
        expect(rejected.payload.actor.userId).toBe('admin1');
    });

    test('kill switch: withdrawal_realtime_enabled=false → no events, requests still succeed', async () => {
        mockConfig.withdrawal_realtime_enabled = 'false';
        const emit = jest.fn();
        const { app } = build(emit);
        const created = await ask(app);
        expect(created.status).toBe(200);
        expect((await request(app).post('/withdrawals/approve_new').send({ id: created.body.data.id, utrNumber: 'UTR123456' })).status).toBe(200);
        expect(emit).not.toHaveBeenCalled();
    });

    test('a throwing emitter never fails the withdrawal', async () => {
        const { app, db } = build(() => { throw new Error('socket exploded'); });
        const created = await ask(app);
        expect(created.status).toBe(200);
        expect(db.store[WD]).toHaveLength(1);
        expect((await request(app).post('/withdrawals/approve_new').send({ id: created.body.data.id, utrNumber: 'UTR123456' })).status).toBe(200);
        expect(db.store[WD][0].status).toBe('approved');
    });

    test('no emitter injected (older 28-arg constructors) → silently off', async () => {
        const { app } = build(undefined);
        expect((await ask(app)).status).toBe(200);
    });
});
