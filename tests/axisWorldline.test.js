/**
 * axisWorldline.test.js — POST /prod/axis-worldline-webhook (LIVE money path)
 * Pins: encrypted-envelope-only auth, exactly-once per ref_no (RRN), lock acquire/release incl.
 * error path, held-for-review never finalizes, mapping to webhook_data columns, raw capture of
 * rejected notifications, Worldline's §1.2 JSON response shape.
 */
const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { Query } = require('node-appwrite');

const WEBHOOK_COL = 'webhook_col';
const UAT_COL = 'axis_wl_uat_col';
const KEY = Buffer.alloc(32, 5);

function rupeesToPaiseStrict(rupees) {
    const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
    const frac = (fracPart + '00').slice(0, 2);
    return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

/** Java AES/GCM/NoPadding on the bank's side: IV(16) || ciphertext || tag(16), base64. */
function encrypt(obj, key = KEY) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

// The real decrypted notification from Worldline UAT (2026-09-11).
const LIVE_SAMPLE = {
    bank_code: '00031', aggregator_id: '00031DINEQRX', time_stamp: '20260911160240',
    mid: '037216061150011', customer_vpa: '8826005071-2@ybl', ref_no: '758103148736',
    txn_amount: '1.00', tr_id: 'T2609111602372587513907', transaction_type: '2', txn_currency: '356',
    merchant_vpa: 'mab.037216061150011@axisbank', secondary_id: '13907', settlement_amount: '1.00',
    primary_id: 'T2609111602372587513907',
};

function build({ db = {}, manual = false, lockOk = true, key = KEY.toString('hex'), opts } = {}) {
    if (key === null) delete process.env.AXIS_WL_AES_KEY; else process.env.AXIS_WL_AES_KEY = key;
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
            ? { manual: true, fields: { deleted: true, reviewStatus: 'pending_review', reviewMode: 'manual', reviewExpiresAt: '2026-09-11T10:01:00.000Z' } }
            : { manual: false, fields: {} }) },
        ConfigManager: { get: (_k, d) => d },
        finalizeTransaction: jest.fn().mockResolvedValue(undefined),
        emitPendingReview: jest.fn(),
    };
    let app;
    jest.isolateModules(() => {
        const factory = require('../axisWorldline.js');
        const router = factory(databases, { unique: () => 'newId' }, Query, 'db1', WEBHOOK_COL, UAT_COL, rupeesToPaiseStrict,
            deps.acquireLock, deps.releaseLock, deps.resolveReviewOwners, deps.reviewMode, deps.ConfigManager, deps.finalizeTransaction, deps.emitPendingReview,
            ...(opts ? [opts] : []));
        app = express();
        app.use('/prod', router);
    });
    return { app, deps };
}

const post = (app, body) => request(app).post('/prod/axis-worldline-webhook').set('Content-Type', 'application/json').send(body);
const webhookWrites = (db) => db.createDocument.mock.calls.filter((c) => c[1] === WEBHOOK_COL);
const uatWrites = (db) => db.createDocument.mock.calls.filter((c) => c[1] === UAT_COL);

afterEach(() => { delete process.env.AXIS_WL_AES_KEY; delete process.env.AXIS_WL_AES_KEY_SCAN_SERVE; });

describe('second merchant account: /axis-worldline-webhook-scan-serve with its own key', () => {
    const KEY2 = Buffer.alloc(32, 9);
    const SCAN = { path: '/axis-worldline-webhook-scan-serve', aesKeyEnv: 'AXIS_WL_AES_KEY_SCAN_SERVE' };
    const postScan = (app, body) => request(app).post('/prod/axis-worldline-webhook-scan-serve').set('Content-Type', 'application/json').send(body);

    test('decrypts with AXIS_WL_AES_KEY_SCAN_SERVE only; the first account\'s key is refused; same mapping + finalize', async () => {
        process.env.AXIS_WL_AES_KEY_SCAN_SERVE = KEY2.toString('hex');
        const { app, deps } = build({ opts: SCAN });                       // AXIS_WL_AES_KEY is also set — must be ignored here
        const ok = await postScan(app, { data: encrypt(LIVE_SAMPLE, KEY2) });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ status: 'SUCCESS', errorMsg: '' });
        expect(webhookWrites(deps.databases)[0][3]).toMatchObject({ qrCodeId: '037216061150011', paymentId: '758103148736', amount: 100, provider: 'axis_worldline' });
        expect(deps.finalizeTransaction).toHaveBeenCalledTimes(1);
        expect(deps.acquireLock).toHaveBeenCalledWith('lock:qr:037216061150011', '758103148736', 15);

        const wrongKey = await postScan(app, { data: encrypt(LIVE_SAMPLE, KEY) });
        expect(wrongKey.status).toBe(400);
        expect(wrongKey.body).toEqual({ status: 'FAILED', errorMsg: 'Unable to decrypt notification' });
        expect(uatWrites(deps.databases)).toHaveLength(1);                 // captured raw, tagged with the route
        expect(JSON.parse(uatWrites(deps.databases)[0][3].warningsJson)[0]).toBe('LIVE route rejected (/axis-worldline-webhook-scan-serve)');
        expect(deps.finalizeTransaction).toHaveBeenCalledTimes(1);

        // the old path does not exist on this mount
        expect((await post(app, { data: encrypt(LIVE_SAMPLE, KEY2) })).status).toBe(404);
    });

    test('scan-serve key unset → 503 FAILED, never falls back to AXIS_WL_AES_KEY', async () => {
        const { app, deps } = build({ opts: SCAN });                       // only AXIS_WL_AES_KEY set
        const res = await postScan(app, { data: encrypt(LIVE_SAMPLE, KEY) });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ status: 'FAILED', errorMsg: 'Decryption key not configured' });
        expect(JSON.parse(uatWrites(deps.databases)[0][3].warningsJson)).toContain('AXIS_WL_AES_KEY_SCAN_SERVE not configured');
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
    });

    test('the first account\'s mount ignores the scan-serve key', async () => {
        process.env.AXIS_WL_AES_KEY_SCAN_SERVE = KEY2.toString('hex');
        const { app } = build();
        expect((await post(app, { data: encrypt(LIVE_SAMPLE, KEY2) })).status).toBe(400);
        expect((await post(app, { data: encrypt(LIVE_SAMPLE, KEY) })).status).toBe(200);
    });
});

describe('happy path', () => {
    test('encrypted notification → webhook_data row mapped per spec, finalized once, 200 SUCCESS', async () => {
        const { app, deps } = build();
        const data = encrypt(LIVE_SAMPLE);
        const res = await post(app, { data });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'SUCCESS', errorMsg: '' });

        expect(webhookWrites(deps.databases)).toHaveLength(1);
        const doc = webhookWrites(deps.databases)[0][3];
        expect(doc).toMatchObject({
            qrCodeId: '037216061150011',              // mid
            paymentId: '758103148736',                // ref_no (RRN) — primary_id repeats on a static QR
            rrnNumber: '758103148736',                // ref_no
            amount: 100,                              // "1.00" rupees → paise, once
            vpa: '8826005071-2@ybl',                  // customer_vpa
            provider: 'axis_worldline',
            status: 'normal',
            ownerSubadminId: 'sub1',
            created_at: '2026-09-11T10:32:40.000Z',   // 20260911160240 IST → UTC
        });
        expect(doc.reviewStatus).toBeUndefined();      // AUTO mode writes no review fields
        expect(JSON.parse(doc.payload)).toEqual({ data, decrypted: LIVE_SAMPLE });

        expect(deps.finalizeTransaction).toHaveBeenCalledTimes(1);
        expect(deps.finalizeTransaction.mock.calls[0][0].$id).toBe('doc1');
        expect(deps.emitPendingReview).not.toHaveBeenCalled();
        expect(uatWrites(deps.databases)).toHaveLength(0);
    });

    test('lock is taken on lock:qr:<mid> with paymentId and released in finally', async () => {
        const { app, deps } = build();
        await post(app, { data: encrypt(LIVE_SAMPLE) });
        expect(deps.acquireLock).toHaveBeenCalledWith('lock:qr:037216061150011', '758103148736', 15);
        expect(deps.releaseLock).toHaveBeenCalledWith('lock:qr:037216061150011', '758103148736');
    });
});

describe('exactly-once', () => {
    test('duplicate ref_no: 200 SUCCESS, no insert, no finalize', async () => {
        const { app, deps } = build({ db: { listDocuments: jest.fn().mockResolvedValue({ documents: [{ $id: 'old' }], total: 1 }) } });
        const res = await post(app, { data: encrypt(LIVE_SAMPLE) });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
        expect(deps.releaseLock).toHaveBeenCalledTimes(1);
    });

    test('lock busy after retries: 503 FAILED, nothing written, no release of a lock we never held', async () => {
        const { app, deps } = build({ lockOk: false });
        const res = await post(app, { data: encrypt(LIVE_SAMPLE) });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ status: 'FAILED', errorMsg: 'Processing conflict, retry' });
        expect(deps.acquireLock).toHaveBeenCalledTimes(3);
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
        expect(deps.releaseLock).not.toHaveBeenCalled();
    });

    test('createDocument throws: 500 FAILED, lock still released, no finalize', async () => {
        const { app, deps } = build({ db: { createDocument: jest.fn().mockRejectedValue(new Error('appwrite down')) } });
        const res = await post(app, { data: encrypt(LIVE_SAMPLE) });
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ status: 'FAILED', errorMsg: 'Failed to record notification' });
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
        expect(deps.releaseLock).toHaveBeenCalledTimes(1);
    });
});

describe('static-QR primary_id reuse (live 2026-09-18)', () => {
    test('same primary_id, different ref_no → both stored as separate payments', async () => {
        const { app, deps } = build();
        const second = { ...LIVE_SAMPLE, ref_no: '288692485751', time_stamp: '20260911160324' };
        await post(app, { data: encrypt(LIVE_SAMPLE) });
        await post(app, { data: encrypt(second) });
        const ids = webhookWrites(deps.databases).map((c) => c[3].paymentId);
        expect(ids).toEqual(['758103148736', '288692485751']);
        expect(deps.finalizeTransaction).toHaveBeenCalledTimes(2);
        // dedup is keyed on the RRN, never on primary_id
        for (const call of deps.databases.listDocuments.mock.calls) {
            expect(JSON.stringify(call[2])).not.toContain(LIVE_SAMPLE.primary_id);
        }
    });

    test('missing ref_no: 400 FAILED naming ref_no, captured raw', async () => {
        const { app, deps } = build();
        const { ref_no, ...noRrn } = LIVE_SAMPLE;
        const res = await post(app, { data: encrypt(noRrn) });
        expect(res.status).toBe(400);
        expect(res.body.errorMsg).toBe('Missing or invalid ref_no');
        expect(uatWrites(deps.databases)).toHaveLength(1);
    });
});

describe('manual review gate', () => {
    test('held: review fields written, review:pending emitted, finalize NOT called, still SUCCESS', async () => {
        const { app, deps } = build({ manual: true });
        const res = await post(app, { data: encrypt(LIVE_SAMPLE) });
        expect(res.body.status).toBe('SUCCESS');
        const doc = webhookWrites(deps.databases)[0][3];
        expect(doc).toMatchObject({ deleted: true, reviewStatus: 'pending_review', reviewMode: 'manual' });
        expect(deps.emitPendingReview).toHaveBeenCalledTimes(1);
        expect(deps.emitPendingReview.mock.calls[0][0]).toMatchObject({ $id: 'doc1', qrCodeId: '037216061150011', amount: 100, provider: 'axis_worldline' });
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
    });
});

describe('rejections — never touch webhook_data, captured raw', () => {
    test('plaintext body (no envelope): 400, not captured, nothing locked', async () => {
        const { app, deps } = build();
        const res = await post(app, LIVE_SAMPLE);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ status: 'FAILED', errorMsg: 'Expected encrypted { data } envelope' });
        expect(deps.acquireLock).not.toHaveBeenCalled();
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
    });

    test('wrong key / tampered: 400 FAILED, raw envelope captured to UAT collection, no lock', async () => {
        const { app, deps } = build();
        const res = await post(app, { data: encrypt(LIVE_SAMPLE, Buffer.alloc(32, 9)) });
        expect(res.status).toBe(400);
        expect(res.body.errorMsg).toBe('Unable to decrypt notification');
        expect(webhookWrites(deps.databases)).toHaveLength(0);
        expect(uatWrites(deps.databases)).toHaveLength(1);
        expect(JSON.parse(uatWrites(deps.databases)[0][3].warningsJson).join(' ')).toMatch(/decryption failed/);
        expect(deps.acquireLock).not.toHaveBeenCalled();
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
    });

    test('mandatory field missing (no mid): 400 FAILED naming the field, captured raw', async () => {
        const { app, deps } = build();
        const { mid, ...noMid } = LIVE_SAMPLE;
        const res = await post(app, { data: encrypt(noMid) });
        expect(res.status).toBe(400);
        expect(res.body.errorMsg).toBe('Missing or invalid mid');
        expect(webhookWrites(deps.databases)).toHaveLength(0);
        expect(uatWrites(deps.databases)).toHaveLength(1);
    });

    test('zero amount: 400 FAILED', async () => {
        const { app } = build();
        const res = await post(app, { data: encrypt({ ...LIVE_SAMPLE, txn_amount: '0.00' }) });
        expect(res.body.errorMsg).toBe('Missing or invalid txn_amount');
    });

    test('no key configured: 503 FAILED, captured raw', async () => {
        const { app, deps } = build({ key: null });
        const res = await post(app, { data: encrypt(LIVE_SAMPLE) });
        expect(res.status).toBe(503);
        expect(res.body.errorMsg).toBe('Decryption key not configured');
        expect(uatWrites(deps.databases)).toHaveLength(1);
        expect(webhookWrites(deps.databases)).toHaveLength(0);
    });

    test('raw-capture failure does not change the response', async () => {
        const createDocument = jest.fn().mockRejectedValue(new Error('uat col down'));
        const { app } = build({ db: { createDocument } });
        const res = await post(app, { data: encrypt(LIVE_SAMPLE, Buffer.alloc(32, 9)) });
        expect(res.status).toBe(400);
    });

    test('unparseable JSON: 400 FAILED in the spec shape', async () => {
        const { app } = build();
        const res = await request(app).post('/prod/axis-worldline-webhook').set('Content-Type', 'application/json').send('{not json');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ status: 'FAILED', errorMsg: 'Empty or unparseable body' });
    });
});

test('factory arity stays at 14 — positional-arg drift guard (see CLAUDE.md)', () => {
    expect(require('../axisWorldline.js').length).toBe(14);
});
