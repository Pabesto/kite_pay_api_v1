/**
 * axisWorldlineUat.test.js — POST /prod/axis-worldline-webhook + GET captures
 *
 * Fixtures are the VERBATIM decrypted samples from the Worldline
 * "Aggregator Transaction Notification V1" spec (§1.3.1–1.3.3), plus the
 * encrypted-envelope shape (§1.3 "Sample Encrypted Request").
 *
 * The load-bearing test is "never touches the money path" — same contract as
 * uatWebhook.test.js. Response shape is Worldline's §1.2 contract:
 * { status: 'SUCCESS'|'FAILED', errorMsg }.
 */

const express = require('express');
const request = require('supertest');
const { Query } = require('node-appwrite');

const WL_COL = 'axis_wl_uat_col';
const PROD_WEBHOOK_COL = 'webhook_col'; // must never be written to from here

function makeDb(overrides = {}) {
    return {
        listDocuments: jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        createDocument: jest.fn().mockResolvedValue({ $id: 'wl1' }),
        updateDocument: jest.fn().mockResolvedValue({ $id: 'wl1' }),
        deleteDocument: jest.fn().mockResolvedValue({}),
        ...overrides,
    };
}

const asAdmin = (req, _res, next) => {
    req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] };
    next();
};

/** The one sanctioned rupees→paise converter, copied from server.js as the injected dep. */
function rupeesToPaiseStrict(rupees) {
    const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
    const frac = (fracPart + '00').slice(0, 2);
    return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

function buildApp(db, auth = asAdmin) {
    let app;
    jest.isolateModules(() => {
        const factory = require('../axisWorldlineUat.js');
        const router = factory(db, { unique: () => 'newWlId' }, Query, 'db1', WL_COL, rupeesToPaiseStrict, auth);
        app = express();
        app.use('/prod', router);
    });
    return app;
}

const post = (app, body) =>
    request(app).post('/prod/axis-worldline-webhook').set('Content-Type', 'application/json').send(body);

// ── PDF §1.3.1 — UPI without CC on UPI ───────────────────────────────────────
const UPI_SAMPLE = {
    bank_code: '00099',
    aggregator_id: 'EZETAP',
    time_stamp: '20231222002458',
    mid: '037111016290183',
    customer_vpa: 'kapilayush81@okbank',
    ref_no: '335601834589',
    txn_amount: '500.00',
    tr_id: 'AGU0009976378167EA2312211854E180008',
    transaction_type: '2',
    txn_currency: '356',
    merchant_vpa: 'mab.037111016290178@bank',
    secondary_id: '2312211854E180008',
    settlement_amount: '500.00',
    primary_id: 'AGU0009976378167EA2312211854E180008',
};

// ── PDF §1.3.3 — BQR card transaction (no VPA, no tr_id) ─────────────────────
const BQR_SAMPLE = {
    bank_code: '00099',
    aggregator_id: 'PINLAB',
    mpan: '4604901037523736',
    time_stamp: '20231228154031',
    mid: '037244001370350',
    ref_no: '336215000718',
    txn_amount: '77611.00',
    transaction_type: '1',
    auth_code: '176005',
    consumer_pan: 'c5dd2d9a3afaf60ee34639f4082cc42b2b43e9aa53436867959dcc3661986f54',
    txn_currency: '356',
    secondary_id: '000000',
    settlement_amount: '0.00',
    primary_id: '27579509',
    customer_name: ' ',
};

// ── PDF §1.3 — encrypted envelope (no key configured yet) ────────────────────
const ENCRYPTED_SAMPLE = { data: 'uH5ndiE3MFJwbn%2FJDlU7Kyr5qPJzmyKpra%2F55IYEb7WD' };

describe('POST /prod/axis-worldline-webhook', () => {
    test('UPI sample: 200 SUCCESS, saved webhook_data-shaped with paise amount', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), UPI_SAMPLE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'SUCCESS', errorMsg: '' });

        expect(db.createDocument).toHaveBeenCalledTimes(1);
        const [dbId, colId, , doc] = db.createDocument.mock.calls[0];
        expect(dbId).toBe('db1');
        expect(colId).toBe(WL_COL);
        expect(doc.paymentId).toBe('AGU0009976378167EA2312211854E180008');
        expect(doc.qrCodeId).toBe('037111016290183'); // no tid → mid fallback
        expect(doc.rrnNumber).toBe('335601834589');
        expect(doc.amount).toBe(50000); // "500.00" rupees → paise, exactly once
        expect(doc.vpa).toBe('kapilayush81@okbank');
        expect(doc.provider).toBe('axis_worldline');
        expect(doc.status).toBe('normal');
        expect(JSON.parse(doc.payload)).toEqual(UPI_SAMPLE);
    });

    test('BQR card sample: saved, no vpa, paise amount from rupee string', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), BQR_SAMPLE);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        const doc = db.createDocument.mock.calls[0][3];
        expect(doc.paymentId).toBe('27579509');
        expect(doc.amount).toBe(7761100);
        expect(doc.vpa).toBeNull();
    });

    test('duplicate primary_id: 200 SUCCESS (stops Worldline retries), no second insert', async () => {
        const db = makeDb({
            listDocuments: jest.fn().mockResolvedValue({ documents: [{ $id: 'existing1' }], total: 1 }),
        });
        const res = await post(buildApp(db), UPI_SAMPLE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'SUCCESS', errorMsg: '' });
        expect(db.createDocument).not.toHaveBeenCalled();
    });

    test('encrypted-only body: captured raw with null fields and a warning, still SUCCESS', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), ENCRYPTED_SAMPLE);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        const doc = db.createDocument.mock.calls[0][3];
        expect(doc.paymentId).toBeNull();
        expect(doc.amount).toBeNull();
        expect(JSON.parse(doc.payload)).toEqual(ENCRYPTED_SAMPLE);
        expect(JSON.parse(doc.warningsJson).join(' ')).toMatch(/encrypted/);
    });

    test('empty body: 400 FAILED per §1.2 shape', async () => {
        const res = await post(buildApp(makeDb()), {});
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('FAILED');
    });

    test('save failure: 500 FAILED (Worldline will retry)', async () => {
        const db = makeDb({ createDocument: jest.fn().mockRejectedValue(new Error('boom')) });
        const res = await post(buildApp(db), UPI_SAMPLE);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ status: 'FAILED', errorMsg: 'Failed to record notification' });
    });

    test('never touches the money path: only the WL UAT collection is ever written', async () => {
        const db = makeDb();
        await post(buildApp(db), UPI_SAMPLE);
        for (const call of db.createDocument.mock.calls) {
            expect(call[1]).toBe(WL_COL);
            expect(call[1]).not.toBe(PROD_WEBHOOK_COL);
        }
        expect(db.updateDocument).not.toHaveBeenCalled();
        expect(db.deleteDocument).not.toHaveBeenCalled();
    });
});

describe('GET /prod/axis-worldline-webhook/captures', () => {
    test('admin list returns picked captures with nextCursor', async () => {
        const rows = Array.from({ length: 2 }, (_, i) => ({
            $id: `c${i}`, paymentId: `p${i}`, qrCodeId: 'q', rrnNumber: 'r', amount: 50000,
            vpa: 'v@bank', provider: 'axis_worldline', created_at: '2026-01-01T00:00:00.000Z',
            warningsJson: '[]', payload: '{}',
        }));
        const db = makeDb({ listDocuments: jest.fn().mockResolvedValue({ documents: rows, total: 2 }) });
        const res = await request(buildApp(db)).get('/prod/axis-worldline-webhook/captures?limit=25');

        expect(res.status).toBe(200);
        expect(res.body.captures).toHaveLength(2);
        expect(res.body.captures[0].amountRs).toBe(500);
        expect(res.body.nextCursor).toBeNull(); // short page → no cursor
    });

    test('bad cursor format: 400', async () => {
        const res = await request(buildApp(makeDb())).get('/prod/axis-worldline-webhook/captures?cursor=%2F%2Fbad%20cursor');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid cursor format');
    });
});

test('factory arity stays at 7 — positional-arg drift guard (see CLAUDE.md)', () => {
    expect(require('../axisWorldlineUat.js').length).toBe(7);
});
