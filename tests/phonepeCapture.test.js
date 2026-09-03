/**
 * phonepeCapture.test.js — POST /phonepe-capture (browser-extension ingest, LIVE money path)
 * Pins: static-key auth, exactly-once per paymentId, lock acquire/release incl. error path,
 * held-for-review never finalizes, non-SUCCESS rows skipped, per-row result reporting.
 */
const express = require('express');
const request = require('supertest');
const { Query } = require('node-appwrite');

const KEY = 'test-extension-key';
const WEBHOOK_COL = 'webhook_col';

function rupeesToPaiseStrict(rupees) {
    const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
    const frac = (fracPart + '00').slice(0, 2);
    return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

function build({ db = {}, manual = false, lockOk = true } = {}) {
    const databases = {
        listDocuments: jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        createDocument: jest.fn().mockImplementation((_d, _c, _id, data) => Promise.resolve({ $id: 'doc1', ...data })),
        ...db,
    };
    const deps = {
        databases,
        acquireLock: jest.fn().mockResolvedValue(lockOk),
        releaseLock: jest.fn().mockResolvedValue(true),
        resolveReviewOwners: jest.fn().mockResolvedValue({ ownerSubadminId: 'sub1', ownerIds: ['sub1'] }),
        reviewMode: { reviewFieldsFor: jest.fn().mockReturnValue(manual
            ? { manual: true, fields: { deleted: true, reviewStatus: 'pending_review', reviewMode: 'manual', reviewExpiresAt: '2026-09-03T10:01:00.000Z' } }
            : { manual: false, fields: {} }) },
        ConfigManager: { get: (_k, d) => d },
        finalizeTransaction: jest.fn().mockResolvedValue(undefined),
        emitPendingReview: jest.fn(),
    };
    let app;
    jest.isolateModules(() => {
        const factory = require('../phonepeCapture.js');
        const router = factory(databases, { unique: () => 'newId' }, Query, 'db1', WEBHOOK_COL, rupeesToPaiseStrict,
            deps.acquireLock, deps.releaseLock, deps.resolveReviewOwners, deps.reviewMode, deps.ConfigManager, deps.finalizeTransaction, deps.emitPendingReview);
        app = express();
        app.use(express.json());
        app.use('/', router);
    });
    return { app, deps };
}

const ROW = { paymentId: 'T250903001', utr: '525012345678', amount: '1,250.50', payerVpa: 'ramesh@ybl', qrRef: 'QR-01', txnTime: '2026-09-03T15:30:12+05:30', status: 'SUCCESS', raw: { a: 1 } };
const post = (app, body, key = KEY) => {
    const r = request(app).post('/phonepe-capture');
    if (key !== null) r.set('X-API-Key', key);
    return r.send(body);
};

beforeEach(() => { process.env.PHONEPE_EXTENSION_API_KEY = KEY; });

describe('auth', () => {
    test('503 when key unconfigured, 401 wrong/missing key', async () => {
        delete process.env.PHONEPE_EXTENSION_API_KEY;
        const { app, deps } = build();
        expect((await post(app, { transactions: [ROW] })).status).toBe(503);
        process.env.PHONEPE_EXTENSION_API_KEY = KEY;
        expect((await post(app, { transactions: [ROW] }, 'nope')).status).toBe(401);
        expect((await post(app, { transactions: [ROW] }, null)).status).toBe(401);
        expect(deps.acquireLock).not.toHaveBeenCalled();
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
    });
});

describe('ping', () => {
    test('200 ok with key, 401 without', async () => {
        const { app } = build();
        const good = await request(app).get('/phonepe-capture/ping').set('X-API-Key', KEY);
        expect(good.status).toBe(200);
        expect(good.body).toEqual({ ok: true });
        expect((await request(app).get('/phonepe-capture/ping').set('X-API-Key', 'nope')).status).toBe(401);
    });
});

describe('ingest', () => {
    test('saves in paise with UTC created_at, finalizes once, releases lock', async () => {
        const { app, deps } = build();
        const res = await post(app, { transactions: [ROW] });
        expect(res.status).toBe(200);
        expect(res.body.results).toEqual([{ paymentId: 'T250903001', result: 'saved' }]);
        const data = deps.databases.createDocument.mock.calls[0][3];
        expect(data).toMatchObject({ qrCodeId: 'QR-01', paymentId: 'T250903001', rrnNumber: '525012345678', amount: 125050, vpa: 'ramesh@ybl', provider: 'phonepe', status: 'normal', ownerSubadminId: 'sub1', created_at: '2026-09-03T10:00:12.000Z' });
        expect(JSON.parse(data.payload)).toEqual(ROW);
        expect(deps.acquireLock).toHaveBeenCalledWith('lock:qr:QR-01', 'T250903001', 15);
        expect(deps.finalizeTransaction).toHaveBeenCalledTimes(1);
        expect(deps.releaseLock).toHaveBeenCalledWith('lock:qr:QR-01', 'T250903001');
    });

    test('duplicate paymentId → duplicate, no create, no finalize', async () => {
        const { app, deps } = build({ db: { listDocuments: jest.fn().mockResolvedValue({ documents: [{ $id: 'x' }], total: 1 }) } });
        const res = await post(app, { transactions: [ROW] });
        expect(res.body.results[0].result).toBe('duplicate');
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
        expect(deps.releaseLock).toHaveBeenCalledTimes(1);
    });

    test('lock busy → busy, nothing written', async () => {
        const { app, deps } = build({ lockOk: false });
        const res = await post(app, { transactions: [ROW] });
        expect(res.body.results[0].result).toBe('busy');
        expect(deps.databases.listDocuments).not.toHaveBeenCalled();
        expect(deps.releaseLock).not.toHaveBeenCalled();
    });

    test('held for review → held, review fields written, no finalize', async () => {
        const { app, deps } = build({ manual: true });
        const res = await post(app, { transactions: [ROW] });
        expect(res.body.results[0].result).toBe('held');
        expect(deps.databases.createDocument.mock.calls[0][3]).toMatchObject({ deleted: true, reviewStatus: 'pending_review' });
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
        expect(deps.emitPendingReview).toHaveBeenCalledTimes(1);
    });

    test('create throws → error row, lock still released, batch continues', async () => {
        const createDocument = jest.fn().mockRejectedValueOnce(new Error('boom')).mockImplementation((_d, _c, _id, data) => Promise.resolve({ $id: 'doc2', ...data }));
        const { app, deps } = build({ db: { createDocument } });
        const res = await post(app, { transactions: [ROW, { ...ROW, paymentId: 'T2' }] });
        expect(res.body.results.map(r => r.result)).toEqual(['error', 'saved']);
        expect(deps.releaseLock).toHaveBeenCalledTimes(2);
        expect(deps.finalizeTransaction).toHaveBeenCalledTimes(1);
    });

    test('invalid / non-SUCCESS rows never touch the lock', async () => {
        const { app, deps } = build();
        const res = await post(app, { transactions: [
            { ...ROW, status: 'FAILED' },
            { ...ROW, amount: '12.345' },
            { ...ROW, qrRef: '' },
            { ...ROW, txnTime: 'yesterday' },
        ] });
        expect(res.body.results.map(r => r.result)).toEqual(['skipped', 'invalid', 'invalid', 'invalid']);
        expect(deps.acquireLock).not.toHaveBeenCalled();
    });

    test('400 on empty or oversized batch', async () => {
        const { app } = build();
        expect((await post(app, { transactions: [] })).status).toBe(400);
        expect((await post(app, { transactions: Array(101).fill(ROW) })).status).toBe(400);
    });
});
