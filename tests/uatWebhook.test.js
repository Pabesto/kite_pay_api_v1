/**
 * uatWebhook.test.js — POST /uat/razorpay-webhook + GET /uat/razorpay-webhook/captures
 *
 * Fixtures are the VERBATIM sample payloads from Razorpay Notification API v4.0:
 *   §5.10 Sample JSON for UPI Payment
 *   §5.11 Sample JSON for Bharat QR Payment
 * They are the reason this endpoint exists — both lack `tid`, and the Bharat QR one also
 * lacks `id`, which is exactly what the live /razorpay-webhook mapping assumes is present.
 *
 * The load-bearing test in this file is "never touches the money path". If that one ever
 * fails, the UAT endpoint has grown a way to move real money.
 */

const express = require('express');
const request = require('supertest');
const { Query } = require('node-appwrite');

const UAT_COL = 'uat_col';
const PROD_WEBHOOK_COL = 'webhook_col'; // must never be written to from here
const TOKEN = 'test-uat-token-abc123';

/** Minimal Appwrite databases mock (same shape as robustness.test.js). */
function makeDb(overrides = {}) {
    return {
        listDocuments: jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        createDocument: jest.fn().mockResolvedValue({ $id: 'uat1' }),
        updateDocument: jest.fn().mockResolvedValue({ $id: 'uat1' }),
        deleteDocument: jest.fn().mockResolvedValue({}),
        ...overrides,
    };
}

/** Auth middleware that injects an admin user. */
const asAdmin = (req, _res, next) => {
    req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] };
    next();
};

/** The one sanctioned rupees→paise converter, copied from server.js:913 as the injected dep. */
function rupeesToPaiseStrict(rupees) {
    const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
    const frac = (fracPart + '00').slice(0, 2);
    return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

function buildApp(db, auth = asAdmin) {
    const factory = require('../uatWebhook.js');
    const router = factory(db, { unique: () => 'newUatId' }, Query, 'db1', UAT_COL, rupeesToPaiseStrict, auth);
    const app = express();
    app.use('/uat', router);
    return app;
}

const post = (app, body, token = TOKEN) => {
    const r = request(app).post('/uat/razorpay-webhook').set('Content-Type', 'application/json');
    if (token !== null) r.set('Authorization', `Bearer ${token}`);
    return r.send(body);
};

// ── PDF §5.10 — UPI Payment ──────────────────────────────────────────────────
// Note: no `tid`. Payer VPA is in `payerName`. `id` is present here but NOT in §5.11.
const UPI_SAMPLE = {
    success: true,
    username: '2222110001',
    setting: {},
    apps: [],
    taskList: [],
    amount: 1,
    amountOriginal: 1,
    currencyCode: 'INR',
    customerName: 'ppriya1486@kotak',
    customerReceiptUrl: 'http://eze.cc/r/o/Ri02JMOR',
    externalRefNumber: 'EZ201809120455203469',
    txnId: '180912045520146E020071016',
    merchantName: 'Demo_LIC',
    nonceStatus: 'OPEN',
    orgCode: 'DEMOLIC_41229300',
    merchantCode: 'DEMOLIC_41229300',
    payerName: 'ppriya1486@kotak',
    paymentCardType: 'UNKNOWN',
    paymentMode: 'UPI',
    postingDate: 1536728120140,
    processCode: '_DEF_PROC',
    rrNumber: '824315098694',
    settlementStatus: 'SETTLED',
    signatureId: 'NR',
    status: 'AUTHORIZED',
    states: ['SETTLED'],
    txnType: 'CHARGE',
    dccOpted: false,
    chargeSlipDate: '2018-09-12T10:25:20+0530',
    readableChargeSlipDate: '12/09/2018 10:25:20',
    id: '180912045520146E020071016',
    paymentGateway: 'UPIHDFC',
    txnRequestId: '180912045520146E020071016',
    acquirerCode: 'NONE',
    createdTime: 1536728120184,
    callbackEnabled: true,
    orderNumber: 'EZ201809120455203469',
    totalAmount: 1,
    nameOnCard: 'ppriya1486@kotak',
    txnMetadata: [],
    taxPresent: false,
};

// ── PDF §5.11 — Bharat QR Payment ────────────────────────────────────────────
// Note: no `tid`, NO `id`/`Id`, and no payerName/customerName. Amount 3.1 rupees.
const BHARATQR_SAMPLE = {
    success: true,
    sessionKey: 'b1919edf-facb-4395-ac77-9e0e2b3373a1',
    username: '356477083598334',
    setting: {},
    apps: [],
    taskList: [],
    amount: 3.1,
    amountOriginal: 3.1,
    authCode: 'UG0521',
    currencyCode: 'INR',
    customerReceiptUrl: 'http://eze.cc/r/o/Ri02JMOR',
    externalRefNumber: 'LLN2U6BHLQ986NCEPJ31',
    txnId: '180831151229453E010058794',
    merchantName: 'Amazon Seller Services Pvt Ltd',
    nonceStatus: 'OPEN',
    orgCode: ' DEMOLIC_41229300',
    merchantCode: ' DEMOLIC_41229300',
    paymentCardType: 'UNKNOWN',
    paymentMode: 'BHARATQR',
    postingDate: 1535728349000,
    processCode: '_DEF_PROC',
    rrNumber: '824315098694',
    settlementStatus: 'SETTLED',
    signatureId: 'NR',
    status: 'AUTHORIZED',
    states: ['SETTLED'],
    txnType: 'CHARGE',
    dccOpted: false,
    chargeSlipDate: '2018-08-31T20:42:29+0530',
    readableChargeSlipDate: '31/08/2018 20:42:29',
    settlementTime: 1535728647000,
    acquirerCode: 'NONE',
    createdTime: 1535728349000,
    callbackEnabled: true,
    orderNumber: 'LLN2U6BHLQ986NCEPJ31',
    reverseReferenceNumber: '824315098694',
    totalAmount: 3.1,
    txnMetadata: [],
};

beforeEach(() => {
    process.env.UAT_WEBHOOK_TOKEN = TOKEN;
});

describe('POST /uat/razorpay-webhook — auth (§4.2 static token)', () => {
    test('401 with no credential', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), UPI_SAMPLE, null);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized' });
        expect(db.createDocument).not.toHaveBeenCalled();
    });

    test('401 with a wrong token', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), UPI_SAMPLE, 'not-the-token');
        expect(res.status).toBe(401);
        expect(db.createDocument).not.toHaveBeenCalled();
    });

    test('accepts the X-UAT-Token header form', async () => {
        const db = makeDb();
        const res = await request(buildApp(db))
            .post('/uat/razorpay-webhook')
            .set('X-UAT-Token', TOKEN)
            .send(UPI_SAMPLE);
        expect(res.status).toBe(200);
    });

    test('fails closed with 503 when UAT_WEBHOOK_TOKEN is unset', async () => {
        delete process.env.UAT_WEBHOOK_TOKEN;
        const db = makeDb();
        const res = await post(buildApp(db), UPI_SAMPLE);
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'UAT endpoint not configured' });
        expect(db.createDocument).not.toHaveBeenCalled();
    });
});

describe('POST /uat/razorpay-webhook — §5.10 UPI sample', () => {
    test('normalizes the documented fields and records the missing-tid fallback', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), UPI_SAMPLE);

        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.duplicate).toBe(false);

        const p = res.body.parsed;
        expect(p.txnId).toBe('180912045520146E020071016');
        expect(p.qrCodeId).toBe('2222110001');           // from username — no tid in the sample
        expect(p.amountPaise).toBe(100);                  // 1 rupee
        expect(p.amountRupeesRaw).toBe('1');
        expect(p.vpa).toBe('ppriya1486@kotak');           // payerName, not customerName
        expect(p.rrnNumber).toBe('824315098694');
        expect(p.paymentMode).toBe('UPI');
        expect(p.providerStatus).toBe('AUTHORIZED');
        expect(p.txnType).toBe('CHARGE');
        expect(p.settlementStatus).toBe('SETTLED');
        expect(p.currencyCode).toBe('INR');
        expect(p.postingDate).toBe('2018-09-12T04:55:20.140Z'); // epoch ms → UTC ISO
        expect(p.merchantCode).toBe('DEMOLIC_41229300');

        expect(res.body.warnings).toContain('no tid — fell back to username');
    });

    test('writes the raw payload plus the normalized columns to the UAT collection', async () => {
        const db = makeDb();
        await post(buildApp(db), UPI_SAMPLE);

        expect(db.createDocument).toHaveBeenCalledTimes(1);
        const [dbId, colId, docId, data] = db.createDocument.mock.calls[0];
        expect(dbId).toBe('db1');
        expect(colId).toBe(UAT_COL);
        expect(docId).toBe('newUatId');
        expect(JSON.parse(data.payload)).toEqual(UPI_SAMPLE); // raw payload is the source of truth
        expect(data.amountPaise).toBe(100);
        expect(data.qrCodeId).toBe('2222110001');
        expect(JSON.parse(data.warningsJson)).toContain('no tid — fell back to username');
        expect(typeof data.created_at).toBe('string');
    });
});

describe('POST /uat/razorpay-webhook — §5.11 Bharat QR sample', () => {
    test('uses txnId when the payload has no id field at all', async () => {
        const db = makeDb();
        expect(BHARATQR_SAMPLE.id).toBeUndefined(); // the trap the live webhook falls into
        expect(BHARATQR_SAMPLE.tid).toBeUndefined();

        const res = await post(buildApp(db), BHARATQR_SAMPLE);
        expect(res.status).toBe(200);
        expect(res.body.parsed.txnId).toBe('180831151229453E010058794');
        expect(res.body.parsed.qrCodeId).toBe('356477083598334');
    });

    test('converts a fractional rupee amount exactly (3.1 → 310 paise, no float drift)', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), BHARATQR_SAMPLE);
        expect(res.body.parsed.amountPaise).toBe(310);
        expect(res.body.parsed.amountRupeesRaw).toBe('3.1');
    });

    test('vpa is null when neither payerName nor customerName is present', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), BHARATQR_SAMPLE);
        expect(res.body.parsed.vpa).toBeNull();
        expect(res.body.parsed.postingDate).toBe('2018-08-31T15:12:29.000Z');
    });
});

describe('tid / mid — Razorpay confirmed both are sent for our account', () => {
    const WITH_IDS = { ...UPI_SAMPLE, txnId: 'TIDMID_1', tid: '10000002', mid: '22100002' };

    test('tid and mid are stored as their own columns, and tid drives qrCodeId', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), WITH_IDS);

        expect(res.status).toBe(200);
        expect(res.body.parsed.tid).toBe('10000002');
        expect(res.body.parsed.mid).toBe('22100002');
        expect(res.body.parsed.qrCodeId).toBe('10000002');   // derived from tid, not username
        expect(res.body.parsed.username).toBe('2222110001'); // username still recorded separately
        expect(res.body.warnings).toEqual([]);               // nothing missing → clean capture

        const data = db.createDocument.mock.calls[0][3];
        expect(data.tid).toBe('10000002');
        expect(data.mid).toBe('22100002');
        expect(data.qrCodeId).toBe('10000002');
    });

    test('a missing mid is flagged now that Razorpay says it will be present', async () => {
        const db = makeDb();
        const { mid, ...noMid } = WITH_IDS;
        const res = await post(buildApp(db), noMid);
        expect(res.status).toBe(200);
        expect(res.body.parsed.mid).toBeNull();
        expect(res.body.warnings).toContain('no mid — Razorpay confirmed this should be present');
    });

    test('the username fallback still works if tid ever goes missing again', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), { ...UPI_SAMPLE, txnId: 'NOTID_1', mid: '22100002' });
        expect(res.status).toBe(200);
        expect(res.body.parsed.tid).toBeNull();
        expect(res.body.parsed.qrCodeId).toBe('2222110001');
        expect(res.body.warnings).toContain('no tid — fell back to username');
    });

    test('the complete raw payload is stored verbatim, undocumented fields included', async () => {
        // §5.3 warns that Razorpay may add/remove undocumented fields at any time. The raw
        // payload is the source of truth precisely so a future field is never lost.
        const db = makeDb();
        const body = { ...WITH_IDS, someFieldRazorpayAddsLater: { nested: [1, 2, 3] } };
        await post(buildApp(db), body);

        const stored = JSON.parse(db.createDocument.mock.calls[0][3].payload);
        expect(stored).toEqual(body);
        expect(Object.keys(stored)).toHaveLength(Object.keys(body).length);
        expect(stored.someFieldRazorpayAddsLater).toEqual({ nested: [1, 2, 3] });
        expect(stored.setting).toEqual({});   // empty object preserved, not dropped
        expect(stored.states).toEqual(['SETTLED']);
    });
});

describe('POST /uat/razorpay-webhook — §4.4 retry/status handling', () => {
    test('non-AUTHORIZED statuses are recorded with a warning, never rejected', async () => {
        // §4.4: Razorpay also posts VOIDED / REFUNDED / PENDING. A 400 here would count
        // against the 3-attempt limit and abort the integration.
        for (const status of ['FAILED', 'PENDING', 'VOIDED', 'REFUNDED']) {
            const db = makeDb();
            const res = await post(buildApp(db), { ...UPI_SAMPLE, status });
            expect(res.status).toBe(200);
            expect(res.body.warnings).toContain(`non-AUTHORIZED status: ${status}`);
            expect(db.createDocument).toHaveBeenCalledTimes(1);
        }
    });

    test('an unexpected paymentMode is warned about, not rejected', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), { ...UPI_SAMPLE, paymentMode: 'CARD' });
        expect(res.status).toBe(200);
        expect(res.body.warnings).toContain('unexpected paymentMode: CARD');
    });

    test('a missing amount is warned about and stored as null paise', async () => {
        const db = makeDb();
        const { amount, ...noAmount } = UPI_SAMPLE;
        const res = await post(buildApp(db), noAmount);
        expect(res.status).toBe(200);
        expect(res.body.parsed.amountPaise).toBeNull();
        expect(res.body.warnings).toContain('amount missing or not numeric');
        expect(db.createDocument.mock.calls[0][3].amountPaise).toBeNull();
    });

    test('a repost of the same txnId returns duplicate:true and writes nothing', async () => {
        const db = makeDb({
            listDocuments: jest.fn().mockResolvedValue({ documents: [{ $id: 'existing1' }], total: 1 }),
        });
        const res = await post(buildApp(db), UPI_SAMPLE);
        expect(res.status).toBe(200);
        expect(res.body.duplicate).toBe(true);
        expect(res.body.docId).toBe('existing1');
        expect(db.createDocument).not.toHaveBeenCalled();
    });

    test('empty body → 400', async () => {
        const db = makeDb();
        const res = await post(buildApp(db), {});
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Empty or unparseable body' });
        expect(db.createDocument).not.toHaveBeenCalled();
    });

    test('an Appwrite failure returns 500 without leaking the error', async () => {
        const db = makeDb({ createDocument: jest.fn().mockRejectedValue(new Error('appwrite exploded')) });
        const res = await post(buildApp(db), UPI_SAMPLE);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to record UAT notification' });
    });
});

describe('UAT endpoint never touches the money path', () => {
    test('writes only to the UAT collection, for every sample and status', async () => {
        const db = makeDb();
        const app = buildApp(db);
        await post(app, UPI_SAMPLE);
        await post(app, BHARATQR_SAMPLE);
        await post(app, { ...UPI_SAMPLE, txnId: 'X1', status: 'REFUNDED' });

        expect(db.createDocument).toHaveBeenCalledTimes(3);
        for (const call of db.createDocument.mock.calls) {
            expect(call[1]).toBe(UAT_COL);
            expect(call[1]).not.toBe(PROD_WEBHOOK_COL);
        }
        for (const call of db.listDocuments.mock.calls) {
            expect(call[1]).toBe(UAT_COL);
        }
        // No ledger write, no status flip, no soft delete anywhere.
        expect(db.updateDocument).not.toHaveBeenCalled();
        expect(db.deleteDocument).not.toHaveBeenCalled();
    });

    test('the factory accepts no finalize/lock dependency, so crediting is unreachable', () => {
        // 7 positional args, none of which can move money. Guards against someone widening
        // the signature to sneak finalizeTransaction or a lock helper in later.
        expect(require('../uatWebhook.js').length).toBe(7);
    });
});

describe('GET /uat/razorpay-webhook/captures', () => {
    const rows = [
        { $id: 'c2', txnId: 'T2', qrCodeId: 'Q2', amountPaise: 310, created_at: '2026-08-11T10:00:00.000Z', warningsJson: '["no tid — fell back to username"]', payload: '{}' },
        { $id: 'c1', txnId: 'T1', qrCodeId: 'Q1', amountPaise: 100, created_at: '2026-08-11T09:00:00.000Z', warningsJson: '[]', payload: '{}' },
    ];

    test('returns captures newest-first through a pick whitelist', async () => {
        const db = makeDb({ listDocuments: jest.fn().mockResolvedValue({ documents: rows, total: 2 }) });
        const res = await request(buildApp(db)).get('/uat/razorpay-webhook/captures?limit=25');

        expect(res.status).toBe(200);
        expect(res.body.captures).toHaveLength(2);
        expect(res.body.captures[0].id).toBe('c2');
        expect(res.body.captures[0].warnings).toEqual(['no tid — fell back to username']);
        expect(res.body.captures[0].$id).toBeUndefined();      // raw Appwrite doc never leaks
        expect(res.body.captures[0].warningsJson).toBeUndefined();
        expect(res.body.nextCursor).toBeNull();                // short page
        expect(res.body.limit).toBe(25);
    });

    test('nextCursor is set only on a full page', async () => {
        const db = makeDb({ listDocuments: jest.fn().mockResolvedValue({ documents: rows, total: 2 }) });
        const res = await request(buildApp(db)).get('/uat/razorpay-webhook/captures?limit=2');
        expect(res.body.nextCursor).toBe('c1');
    });

    test('limit is clamped to 100', async () => {
        const db = makeDb();
        const res = await request(buildApp(db)).get('/uat/razorpay-webhook/captures?limit=9999');
        expect(res.body.limit).toBe(100);
    });

    test('a malformed cursor is a 400, not a 500', async () => {
        const db = makeDb();
        const res = await request(buildApp(db)).get('/uat/razorpay-webhook/captures?cursor=bad%20cursor!');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid cursor format' });
        expect(db.listDocuments).not.toHaveBeenCalled();
    });

    test('an expired cursor from Appwrite maps to 400, not 500', async () => {
        const err = Object.assign(new Error('Invalid query: Document with the requested ID could not be found'), { code: 400 });
        const db = makeDb({ listDocuments: jest.fn().mockRejectedValue(err) });
        const res = await request(buildApp(db)).get('/uat/razorpay-webhook/captures?cursor=deadbeef');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid or expired pagination cursor' });
    });

    test('requires admin auth', async () => {
        const db = makeDb();
        const deny = (_req, res) => res.status(403).json({ error: 'Not authorized: Admin required.' });
        const res = await request(buildApp(db, deny)).get('/uat/razorpay-webhook/captures');
        expect(res.status).toBe(403);
        expect(db.listDocuments).not.toHaveBeenCalled();
    });
});
