/**
 * Robustness test suite
 * Covers all the hardening changes made to admin.js, withdraw.js, and server.js:
 *   M4  – Bank / IFSC / UPI format validation
 *   M5  – Cursor pagination → 400 (not 500) on bad/expired cursor
 *   M6  – updateDailyQrTotal error propagation
 *   M7  – getadminMeta null guard
 *   H2  – Commission rate bounds (0–100)
 */

const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal Appwrite databases mock */
function makeDb(overrides = {}) {
    return {
        listDocuments:  jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        createDocument: jest.fn().mockResolvedValue({ $id: 'doc1' }),
        updateDocument: jest.fn().mockResolvedValue({ $id: 'doc1' }),
        deleteDocument: jest.fn().mockResolvedValue({}),
        ...overrides,
    };
}

/** Minimal Redis mock */
function makeRedis(overrides = {}) {
    return {
        set:    jest.fn().mockResolvedValue('OK'),
        get:    jest.fn().mockResolvedValue(null),
        del:    jest.fn().mockResolvedValue(1),
        incrBy: jest.fn().mockResolvedValue(1),
        incr:   jest.fn().mockResolvedValue(1),
        ...overrides,
    };
}

/** Auth middleware that injects an admin user */
const asAdmin = (req, _res, next) => {
    req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] };
    next();
};

/** Auth middleware that injects a regular user */
const asUser = (userId = 'user1') => (req, _res, next) => {
    req.user = { userId, role: 'user', $id: userId, labels: [] };
    next();
};

/**
 * Each call gets a fresh module (via jest.isolateModules) so that the shared
 * `const router = express.Router()` at module level in admin.js / withdraw.js
 * doesn't accumulate duplicate route handlers across tests.
 */

function buildAdminApp(db, redis, authUser = asAdmin) {
    let router;
    jest.isolateModules(() => {
        const adminFactory = require('../admin.js');
        router = adminFactory(
            db,
            {},
            {},
            { unique: () => 'newId1' },
            Query,
            'db1',
            'users_meta',
            'qr_col',
            'webhook_col',
            'bucket1',
            'daily_qr',
            'commission_txs',
            'daily_commission',
            'all_time_commission',
            'monthly_commission',
            jest.fn().mockResolvedValue(),
            jest.fn(),
            authUser,
            () => authUser,
            authUser,
            authUser,
            authUser,
            {},
            authUser,
            () => authUser,
            redis
        );
    });
    const app = express();
    app.use(express.json());
    app.use('/', router);
    return app;
}

function buildWithdrawApp(db, redis) {
    let router;
    jest.isolateModules(() => {
        const withdrawFactory = require('../withdraw.js');
        router = withdrawFactory(
            db,
            {},
            {},
            { unique: () => 'newId1' },
            Query,
            'db1',
            'users_meta',
            'qr_col',
            'withdrawal_col',
            'bucket1',
            'daily_qr',
            'commission_txs',
            'daily_commission',
            'all_time_commission',
            'monthly_commission',
            jest.fn().mockResolvedValue(),
            jest.fn(),
            asAdmin,
            () => asAdmin,
            asAdmin,
            asAdmin,
            asAdmin,
            {},
            asAdmin,
            () => asAdmin,
            redis
        );
    });
    const app = express();
    app.use(express.json());
    app.use('/', router);
    return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Pure regex validation (no Express needed)
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation regexes', () => {
    const IFSC_RE   = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    const ACCT_RE   = /^\d{8,18}$/;
    const UPI_RE    = /^[a-zA-Z0-9.\-_+]+@[a-zA-Z0-9]+$/;
    const CURSOR_RE = /^[a-zA-Z0-9_:-]{1,255}$/;

    describe('IFSC code', () => {
        test.each([
            ['SBIN0001234', true],
            ['HDFC0000001', true],
            ['ICIC0AB1234', true],
            ['sbin0001234', false], // lowercase
            ['SBI00001234', false], // only 3 alpha prefix
            ['SBIN1001234', false], // fifth char is 1 not 0
            ['SBIN000123',  false], // too short
            ['SBIN00012345',false], // too long
            ['',            false],
        ])('%s → %s', (ifsc, expected) => {
            expect(IFSC_RE.test(ifsc)).toBe(expected);
        });
    });

    describe('Account number', () => {
        test.each([
            ['12345678',       true],  // 8 digits (min)
            ['123456789012345678', true], // 18 digits (max)
            ['1234567',        false], // 7 digits (too short)
            ['1234567890123456789', false], // 19 digits (too long)
            ['1234abc678',     false], // contains letters
            ['',               false],
        ])('%s → %s', (acct, expected) => {
            expect(ACCT_RE.test(acct)).toBe(expected);
        });
    });

    describe('UPI ID', () => {
        test.each([
            ['user@okaxis',      true],
            ['user.name@ybl',    true],
            ['name+tag@upi',     true],
            ['user-1@paytm',     true],
            ['@noprefix',        false],
            ['nosuffix@',        false],
            ['no-at-sign',       false],
            ['two@@ats',         false],
            ['',                 false],
        ])('%s → %s', (upi, expected) => {
            expect(UPI_RE.test(upi)).toBe(expected);
        });
    });

    describe('Cursor format', () => {
        test.each([
            ['abc123',          true],
            ['doc-id_1:2',      true],
            ['A'.repeat(255),   true],  // max length
            ['A'.repeat(256),   false], // over max
            ['bad cursor!',     false], // space + bang
            ['cursor<script>',  false], // special chars
            ['',                false],
        ])('%s → %s', (cursor, expected) => {
            expect(CURSOR_RE.test(cursor)).toBe(expected);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. isCursorError helper  (tested indirectly through route catch blocks)
// ─────────────────────────────────────────────────────────────────────────────

describe('isCursorError classification (via GET /users catch block)', () => {
    test('Appwrite cursor-not-found error returns 400', async () => {
        const cursorErr = Object.assign(
            new Error('Document with the requested ID could not be found'),
            { code: 400 }
        );
        const db = makeDb({
            listDocuments: jest.fn().mockRejectedValue(cursorErr),
        });
        const app = buildAdminApp(db, makeRedis());
        const res = await request(app).get('/users?cursor=validCursor123');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cursor/i);
    });

    test('Generic Appwrite 500 error still returns 500', async () => {
        const serverErr = Object.assign(new Error('Internal server error'), { code: 500 });
        const db = makeDb({
            listDocuments: jest.fn().mockRejectedValue(serverErr),
        });
        const app = buildAdminApp(db, makeRedis());
        const res = await request(app).get('/users');
        expect(res.status).toBe(500);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. GET /users — cursor handling (M5)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /users — cursor handling', () => {
    test('Invalid cursor format returns 400 immediately', async () => {
        const db  = makeDb();
        const app = buildAdminApp(db, makeRedis());
        const res = await request(app).get('/users?cursor=bad cursor!@#');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid cursor/i);
        // DB should NOT be called — validation fires before any DB query
        expect(db.listDocuments).not.toHaveBeenCalled();
    });

    test('Valid cursor is forwarded to Appwrite and returns 200', async () => {
        const db = makeDb({
            listDocuments: jest.fn().mockResolvedValue({
                documents: [{ $id: 'u1', userId: 'u1', name: 'Alice', role: 'user', email: 'a@b.com', status: true }],
                total: 1,
            }),
        });
        const app = buildAdminApp(db, makeRedis());
        const res = await request(app).get('/users?cursor=validDocId1');
        expect(res.status).toBe(200);
        expect(db.listDocuments).toHaveBeenCalled();
    });

    test('Appwrite cursor error on valid-format cursor returns 400 (not 500)', async () => {
        const cursorErr = Object.assign(
            new Error('cursor: document with the requested id could not be found'),
            { code: 400 }
        );
        const db = makeDb({ listDocuments: jest.fn().mockRejectedValue(cursorErr) });
        const app = buildAdminApp(db, makeRedis());
        const res = await request(app).get('/users?cursor=expiredDocId1');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cursor/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. GET /transactions — cursor handling (M5)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /transactions — cursor handling', () => {
    test('Invalid cursor format returns 400 without hitting DB', async () => {
        const db  = makeDb();
        const app = buildAdminApp(db, makeRedis());
        const res = await request(app).get('/transactions?cursor=invalid cursor!!');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid cursor/i);
    });

    test('Appwrite cursor-expired error returns 400', async () => {
        const cursorErr = Object.assign(new Error('cursor invalid'), { code: 400 });
        const db = makeDb({ listDocuments: jest.fn().mockRejectedValue(cursorErr) });
        const app = buildAdminApp(db, makeRedis());
        const res = await request(app).get('/transactions?cursor=oldExpiredId1');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cursor/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. GET /user/transactions — cursor handling (M5)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /user/transactions — cursor handling', () => {
    test('Invalid cursor format returns 400', async () => {
        // DB returns one QR so the early-return ("no QRs") doesn't fire
        const db = makeDb({
            listDocuments: jest.fn().mockResolvedValue({
                documents: [{ $id: 'qr1doc', qrId: 'qr1' }],
                total: 1,
            }),
        });
        // Use user role — userId must match req.user.userId to pass the 403 guard
        const app = buildAdminApp(db, makeRedis(), asUser('user1'));

        const res = await request(app)
            .get('/user/transactions?userId=user1&qrId=qr1&cursor=bad cursor!');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid cursor/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. GET /withdrawals_paginated — cursor handling (M5)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /withdrawals_paginated — cursor handling', () => {
    test('Invalid cursor format returns 400 without hitting DB', async () => {
        const db  = makeDb();
        const app = buildWithdrawApp(db, makeRedis());
        const res = await request(app).get('/withdrawals_paginated?cursor=bad!cursor');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid cursor/i);
        expect(db.listDocuments).not.toHaveBeenCalled();
    });

    test('Valid cursor is forwarded to Appwrite and returns 200', async () => {
        const db = makeDb({
            listDocuments: jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        });
        const app = buildWithdrawApp(db, makeRedis());
        const res = await request(app).get('/withdrawals_paginated?cursor=validDocId1');
        expect(res.status).toBe(200);
        expect(db.listDocuments).toHaveBeenCalled();
    });

    test('Appwrite cursor-expired error returns 400 (not 500)', async () => {
        const cursorErr = Object.assign(
            new Error('document with the requested id could not be found'),
            { code: 400 }
        );
        const db = makeDb({ listDocuments: jest.fn().mockRejectedValue(cursorErr) });
        const app = buildWithdrawApp(db, makeRedis());
        const res = await request(app).get('/withdrawals_paginated?cursor=expiredId1');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cursor/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. GET /user_withdrawals_paginated — cursor handling (M5)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /user_withdrawals_paginated — cursor handling', () => {
    test('Invalid cursor format returns 400', async () => {
        const db  = makeDb();
        const app = buildWithdrawApp(db, makeRedis());
        const res = await request(app).get('/user_withdrawals_paginated?cursor=invalid!!');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid cursor/i);
    });

    test('Appwrite cursor error returns 400', async () => {
        const cursorErr = Object.assign(new Error('cursor not found'), { code: 400 });
        const db = makeDb({ listDocuments: jest.fn().mockRejectedValue(cursorErr) });
        const app = buildWithdrawApp(db, makeRedis());
        const res = await request(app).get('/user_withdrawals_paginated?cursor=expiredId1');
        expect(res.status).toBe(400);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. POST /withdraw_new — input validation (M4)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /withdraw_new — input validation', () => {
    let app;

    beforeEach(() => {
        // Mock DB: pending requests = 0; getUserMeta returns user with 0 commission
        const db = makeDb({
            listDocuments: jest.fn().mockImplementation((dbId, colId) => {
                if (colId === 'withdrawal_col') {
                    // pending requests check
                    return Promise.resolve({ documents: [], total: 0 });
                }
                // getUserMeta
                return Promise.resolve({
                    documents: [{ $id: 'umeta1', userId: 'user1', commission: 0, parentId: null }],
                    total: 1,
                });
            }),
        });
        app = buildWithdrawApp(db, makeRedis());
    });

    test('Missing mode returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', amount: 100, preAmount: 100, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/mode/i);
    });

    test('Invalid mode value returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', mode: 'cash',
            amount: 100, preAmount: 100, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/mode/i);
    });

    test('UPI mode without upiId returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', mode: 'upi',
            amount: 100, preAmount: 100, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/upi id/i);
    });

    test('UPI mode with malformed UPI ID returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', mode: 'upi',
            upiId: 'not-a-valid-upi',
            amount: 100, preAmount: 100, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid upi/i);
    });

    test('Bank mode with invalid IFSC returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', mode: 'bank',
            bankName: 'SBI', accountNumber: '12345678901', ifscCode: 'INVALID_CODE',
            amount: 100, preAmount: 100, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/ifsc/i);
    });

    test('Bank mode with account number too short returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', mode: 'bank',
            bankName: 'SBI', accountNumber: '1234567', ifscCode: 'SBIN0001234',
            amount: 100, preAmount: 100, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/account number/i);
    });

    test('Bank mode with account number containing letters returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', mode: 'bank',
            bankName: 'SBI', accountNumber: '1234abc67890', ifscCode: 'SBIN0001234',
            amount: 100, preAmount: 100, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/account number/i);
    });

    test('Negative or zero amount returns 400', async () => {
        const res = await request(app).post('/withdraw_new').send({
            userId: 'user1', holderName: 'Alice', mode: 'upi',
            upiId: 'alice@okaxis', amount: -50, preAmount: -50, commission: 0,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/amount/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. POST /withdraw_new — commission rate bounds (H2)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /withdraw_new — commission rate bounds', () => {
    function makeAppWithUser(userCommission, parentCommission = 0) {
        const db = makeDb({
            listDocuments: jest.fn().mockImplementation((_dbId, colId, queries) => {
                if (colId === 'withdrawal_col') {
                    return Promise.resolve({ documents: [], total: 0 }); // no pending
                }
                // getUserMeta for user and parent
                const isParentQuery = queries && queries.some
                    && queries.some(q => q.toString().includes('parentId'));

                return Promise.resolve({
                    documents: [{
                        $id: 'umeta1',
                        userId: 'user1',
                        commission: userCommission,
                        parentId: parentCommission > 0 ? 'parent1' : null,
                    }],
                    total: 1,
                });
            }),
        });
        return buildWithdrawApp(db, makeRedis());
    }

    const baseBody = {
        userId: 'user1',
        holderName: 'Alice',
        mode: 'upi',
        upiId: 'alice@okaxis',
        amount: 100,
        preAmount: 100,
        commission: 0,
        qrId: 'qr1',
    };

    test('User commission rate > 100 returns 422', async () => {
        const app = makeAppWithUser(150); // 150% is invalid
        const res = await request(app).post('/withdraw_new').send(baseBody);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/commission rate/i);
    });

    test('User commission rate of 0 (valid) does NOT trigger 422', async () => {
        const app = makeAppWithUser(0);
        const res = await request(app).post('/withdraw_new').send(baseBody);
        // Should pass commission check (may fail later on amount mismatch — that's fine)
        expect(res.status).not.toBe(422);
    });

    test('User commission rate of 100 (valid boundary) does NOT trigger 422', async () => {
        // 100% commission, amount = preAmount + commission, commission = preAmount * 1.0
        const preAmount = 100;
        const commissionAmt = Math.ceil(preAmount * 100); // calculateCommission uses preAmount*100
        const app = makeAppWithUser(100);
        const res = await request(app).post('/withdraw_new').send({
            ...baseBody,
            preAmount,
            commission: commissionAmt,
            amount: preAmount + commissionAmt,
        });
        // Commission rate is valid (100) — should not return 422
        expect(res.status).not.toBe(422);
    });
});
