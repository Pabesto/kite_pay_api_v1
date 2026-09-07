/**
 * QR settlement: the T+1 hold and the admin T+0 early release.
 *
 * The rule under test, and the ONLY place it may be defined (qrSettlement.js):
 *     heldPaise         = max(0, todayPayIn − released)
 *     withdrawablePaise = amountAvailableForWithdrawal − heldPaise
 *
 * Money-critical properties pinned here:
 *   • with no release the numbers are byte-identical to the old behaviour
 *   • a release can never raise the available balance — the most it unlocks is today's own pay-in
 *   • the percentage cap is enforced on write, and rejects rather than silently clamping
 *   • setting a release is absolute, so a double submit cannot double-release
 *   • a release expires by itself: yesterday's row never affects today
 *   • a failed release lookup falls back to FULL holding, never to "everything is available"
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
let mockMetaDoc = { userId: 'user1', role: 'user', parentId: null, commission: 0 };
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async () => mockMetaDoc), invalidate: jest.fn() }));

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
            let docs = col(c).slice();
            let limit = 25;
            for (const raw of queries) {
                const q = parse(raw);
                if (!q) continue;
                if (q.method === 'limit') limit = q.values[0];
                else if (q.method === 'equal') docs = docs.filter((d) => q.values.includes(d[q.attribute]));
                else if (['orderAsc', 'orderDesc', 'cursorAfter'].includes(q.method)) continue;
            }
            return { documents: docs.slice(0, limit), total: docs.length };
        }),
        createDocument: jest.fn(async (_d, c, _id, data) => { const doc = { $id: `${c}_${++seq}`, ...data }; col(c).push(doc); return { ...doc }; }),
        updateDocument: jest.fn(async (_d, c, id, data) => { const d = col(c).find((x) => x.$id === id); Object.assign(d, data); return { ...d }; }),
        deleteDocument: jest.fn(async () => ({})),
        getDocument: jest.fn(async (_d, c, id) => col(c).find((x) => x.$id === id) || Promise.reject(Object.assign(new Error('nf'), { code: 404 }))),
    };
}
const daily = (totals) => [{ $id: 'd1', date: require('moment-timezone')().tz('Asia/Kolkata').format('YYYY-MM-DD'), totalsJson: JSON.stringify(totals) }];
const istToday = () => require('moment-timezone')().tz('Asia/Kolkata').format('YYYY-MM-DD');

/** Fresh module instance, initialised against `db`. */
function freshSettlement(db) {
    let s;
    jest.isolateModules(() => {
        s = require('../qrSettlement');
        s.init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: RELEASES });
    });
    return s;
}

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockConfig)) delete mockConfig[k];
    mockMetaDoc = { userId: 'user1', role: 'user', parentId: null, commission: 0 };
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the formula (pure, no IO)', () => {
    const s = require('../qrSettlement');

    test('held never goes negative and withdrawable is available minus held', () => {
        expect(s.heldPaise(100000, 0)).toBe(100000);
        expect(s.heldPaise(100000, 40000)).toBe(60000);
        expect(s.heldPaise(100000, 100000)).toBe(0);
        expect(s.heldPaise(100000, 250000)).toBe(0);           // over-release clamps, never negative
        expect(s.heldPaise(0, 50000)).toBe(0);
        expect(s.withdrawablePaise(500000, 100000, 0)).toBe(400000);
        expect(s.withdrawablePaise(500000, 100000, 40000)).toBe(440000);
        expect(s.withdrawablePaise(500000, 100000, 999999)).toBe(500000);  // capped by available, never above
    });

    test('a release can never raise the available balance', () => {
        // the ceiling is `available` no matter how large the release
        for (const released of [0, 1, 50000, 100000, 10 ** 9]) {
            expect(s.withdrawablePaise(300000, 100000, released)).toBeLessThanOrEqual(300000);
        }
    });

    test('with no release the result is identical to the old available − todayPayIn rule', () => {
        for (const [avail, payin] of [[500000, 0], [500000, 120000], [0, 50000], [120000, 500000]]) {
            expect(s.withdrawablePaise(avail, payin, 0)).toBe(avail - payin);
        }
    });

    test('the cap is a percentage of that day\'s pay-in, rounded down; 0 disables, 100 allows all', () => {
        mockConfig.qr_daily_release_max_percent = 50;
        expect(s.maxPercent()).toBe(50);
        expect(s.maxReleasablePaise(100000)).toBe(50000);
        expect(s.maxReleasablePaise(12345)).toBe(6172);        // floor(6172.5)
        expect(s.maxReleasablePaise(0)).toBe(0);
        mockConfig.qr_daily_release_max_percent = 0;
        expect(s.maxReleasablePaise(100000)).toBe(0);          // kill switch, NOT "unlimited"
        mockConfig.qr_daily_release_max_percent = 100;
        expect(s.maxReleasablePaise(100000)).toBe(100000);
        mockConfig.qr_daily_release_max_percent = 250;         // out of range clamps to 100
        expect(s.maxPercent()).toBe(100);
        mockConfig.qr_daily_release_max_percent = 'nonsense';  // unparseable fails CLOSED
        expect(s.maxPercent()).toBe(0);
        delete mockConfig.qr_daily_release_max_percent;
        expect(s.maxPercent()).toBe(50);                       // built-in default
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reading settlement', () => {
    test('a release for today lifts withdrawable by exactly that amount', async () => {
        const db = makeDb({
            [DAILY]: daily({ qr1: 100000 }),
            [RELEASES]: [{ $id: 'r1', qrId: 'qr1', date: istToday(), releasedPaise: 40000 }],
        });
        const s = freshSettlement(db);
        const r = await s.forQr('qr1', 500000);
        expect(r).toMatchObject({ availablePaise: 500000, todayPayInPaise: 100000, releasedPaise: 40000, heldPaise: 60000, withdrawablePaise: 440000 });
    });

    test('a release from ANOTHER day is ignored — it expires by itself at IST midnight', async () => {
        const db = makeDb({
            [DAILY]: daily({ qr1: 100000 }),
            [RELEASES]: [{ $id: 'r1', qrId: 'qr1', date: '2020-01-01', releasedPaise: 100000 }],
        });
        const s = freshSettlement(db);
        const r = await s.forQr('qr1', 500000);
        expect(r).toMatchObject({ releasedPaise: 0, heldPaise: 100000, withdrawablePaise: 400000 });
    });

    test('a release for ANOTHER QR is ignored', async () => {
        const db = makeDb({
            [DAILY]: daily({ qr1: 100000, qr2: 80000 }),
            [RELEASES]: [{ $id: 'r1', qrId: 'qr2', date: istToday(), releasedPaise: 80000 }],
        });
        const s = freshSettlement(db);
        expect((await s.forQr('qr1', 500000)).withdrawablePaise).toBe(400000);
        expect((await s.forQr('qr2', 500000)).withdrawablePaise).toBe(500000);
    });

    test('FAILS CLOSED: a broken release lookup holds everything rather than releasing it', async () => {
        const db = makeDb({ [DAILY]: daily({ qr1: 100000 }), [RELEASES]: [{ $id: 'r1', qrId: 'qr1', date: istToday(), releasedPaise: 100000 }] });
        const s = freshSettlement(db);
        const real = db.listDocuments.getMockImplementation();
        db.listDocuments.mockImplementation(async (d, c, q) => { if (c === RELEASES) throw new Error('appwrite down'); return real(d, c, q); });
        const r = await s.forQr('qr1', 500000);
        expect(r).toMatchObject({ releasedPaise: 0, heldPaise: 100000, withdrawablePaise: 400000 });
    });

    test('batch: per-QR rows and totals that a dashboard can sum', async () => {
        const db = makeDb({
            [DAILY]: daily({ qr1: 100000, qr2: 50000 }),
            [RELEASES]: [{ $id: 'r1', qrId: 'qr1', date: istToday(), releasedPaise: 100000 }],
        });
        const s = freshSettlement(db);
        const out = await s.forQrDocs([
            { qrId: 'qr1', amountAvailableForWithdrawal: 300000 },
            { qrId: 'qr2', amountAvailableForWithdrawal: 200000 },
            { qrId: 'qr3', amountAvailableForWithdrawal: 70000 },
        ]);
        expect(out.byQrId.qr1).toMatchObject({ heldPaise: 0, withdrawablePaise: 300000 });
        expect(out.byQrId.qr2).toMatchObject({ heldPaise: 50000, withdrawablePaise: 150000 });
        expect(out.byQrId.qr3).toMatchObject({ todayPayInPaise: 0, heldPaise: 0, withdrawablePaise: 70000 });
        expect(out.totals).toMatchObject({ availablePaise: 570000, todayPayInPaise: 150000, releasedPaise: 100000, heldPaise: 50000, withdrawablePaise: 520000 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('setting a release', () => {
    const ID = { unique: () => 'newid' };
    const setup = (payin = 100000, releases = []) => {
        mockConfig.qr_daily_release_max_percent = 50;
        const db = makeDb({ [DAILY]: daily({ qr1: payin }), [RELEASES]: releases });
        return { db, s: freshSettlement(db) };
    };

    test('within the cap it stores the amount plus an audit snapshot', async () => {
        const { db, s } = setup();
        const doc = await s.setRelease({ ID, qrId: 'qr1', releasedPaise: 50000, reason: 'merchant needs same-day funds', byUserId: 'admin1' });
        expect(doc).toMatchObject({ qrId: 'qr1', date: istToday(), releasedPaise: 50000, todayPayInAtSetPaise: 100000, maxPercentAtSet: 50, releasedBy: 'admin1' });
        expect(db.store[RELEASES]).toHaveLength(1);
        expect((await s.forQr('qr1', 500000)).withdrawablePaise).toBe(450000);
    });

    test('above the cap is REJECTED with the numbers, and nothing is written', async () => {
        const { db, s } = setup();
        await expect(s.setRelease({ ID, qrId: 'qr1', releasedPaise: 50001, reason: 'too much', byUserId: 'admin1' }))
            .rejects.toMatchObject({ status: 400, message: expect.stringContaining('₹500.00') });
        expect(db.store[RELEASES] || []).toHaveLength(0);
    });

    test('SET is absolute: submitting twice does not double-release, and it can be lowered or revoked', async () => {
        const { db, s } = setup();
        const args = { ID, qrId: 'qr1', releasedPaise: 40000, reason: 'same-day funds', byUserId: 'admin1' };
        await s.setRelease(args);
        await s.setRelease(args);
        await s.setRelease(args);
        expect(db.store[RELEASES]).toHaveLength(1);
        expect(db.store[RELEASES][0].releasedPaise).toBe(40000);      // NOT 120000
        await s.setRelease({ ...args, releasedPaise: 10000, reason: 'reduced' });
        expect((await s.forQr('qr1', 500000)).withdrawablePaise).toBe(410000);
        await s.setRelease({ ...args, releasedPaise: 0, reason: 'revoked' });
        expect((await s.forQr('qr1', 500000)).withdrawablePaise).toBe(400000);  // back to full T+1
    });

    test('validation: negative or fractional amounts, a missing reason, and the 0% kill switch', async () => {
        const { s } = setup();
        const base = { ID, qrId: 'qr1', reason: 'a valid reason', byUserId: 'admin1' };
        await expect(s.setRelease({ ...base, releasedPaise: -1 })).rejects.toMatchObject({ status: 400 });
        await expect(s.setRelease({ ...base, releasedPaise: 1.5 })).rejects.toMatchObject({ status: 400 });
        await expect(s.setRelease({ ...base, releasedPaise: 100, reason: 'x' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/reason/i) });
        mockConfig.qr_daily_release_max_percent = 0;
        await expect(s.setRelease({ ...base, releasedPaise: 1 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/switched off/i) });
    });

    test('a QR with no pay-in today has a cap of zero, so nothing can be released', async () => {
        const { s } = setup(0);
        await expect(s.setRelease({ ID, qrId: 'qr1', releasedPaise: 1, reason: 'nothing came in', byUserId: 'admin1' }))
            .rejects.toMatchObject({ status: 400 });
        expect(await s.getRelease('qr1')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the withdrawal endpoint honours the release', () => {
    const QR = () => ({ $id: 'q1', qrId: 'qr1', totalPayInAmount: 500000, withdrawalApprovedAmount: 0, withdrawalRequestedAmount: 0, amountOnHold: 0, commissionOnHold: 0, commissionPaid: 0, amountAvailableForWithdrawal: 500000 });

    // available 500000, today's pay-in 400000 → only 100000 withdrawable under plain T+1
    function build(releases = []) {
        mockConfig.qr_daily_release_max_percent = 50;
        mockConfig.max_withdrawal_requests = 99;
        const db = makeDb({ [QRS]: [QR()], [DAILY]: daily({ qr1: 400000 }), [RELEASES]: releases, [USERS]: [{ $id: 'u', userId: 'user1', commission: 0 }] });
        const asUser = (req, _r, next) => { req.user = { userId: 'user1', role: 'user', $id: 'user1', labels: [] }; next(); };
        let router;
        jest.isolateModules(() => {
            require('../qrSettlement').init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: RELEASES });
            router = require('../withdraw.js')(db, {}, {}, { unique: () => 'w1' }, Query, 'db1', USERS, QRS, WD, 'b',
                DAILY, 'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'config_col',
                jest.fn().mockResolvedValue(), jest.fn(), asUser, () => asUser, asUser, asUser, asUser, {}, asUser, () => asUser,
                { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) }, jest.fn());
        });
        const app = express(); app.use(express.json()); app.use('/', router);
        return { db, app };
    }
    const ask = (app, rs) => request(app).post('/withdraw_new').send({ userId: 'user1', qrId: 'qr1', mode: 'upi', upiId: 'a@ybl', holderName: 'A', preAmount: rs, amount: rs, commission: 0 });

    test('without a release, today\'s pay-in is held back', async () => {
        const { app } = build();
        expect((await ask(app, 1000)).status).toBe(200);              // ₹1,000 ≤ ₹1,000 free
        const over = await ask(app, 1000.01);
        expect(over.status).toBe(400);
        expect(over.body.error).toMatch(/exceeds available balance/i);
    });

    test('with a release, exactly that much more becomes withdrawable — and not a paise beyond', async () => {
        const { app } = build([{ $id: 'r1', qrId: 'qr1', date: istToday(), releasedPaise: 200000 }]);
        expect((await ask(app, 3000)).status).toBe(200);              // ₹1,000 + ₹2,000 released
        const over = await ask(app, 0.01);                            // ledger now has ₹3,000 requested
        expect(over.status).toBe(400);
    });

    test('a release can never let more out than the QR actually holds', async () => {
        // released far beyond today's pay-in: the ceiling is still the available balance
        const { app } = build([{ $id: 'r1', qrId: 'qr1', date: istToday(), releasedPaise: 99999999 }]);
        expect((await ask(app, 5000)).status).toBe(200);              // the whole ₹5,000 available
        const over = await ask(app, 0.01);
        expect(over.status).toBe(400);
    });

    test('a release for yesterday does not loosen today', async () => {
        const { app } = build([{ $id: 'r1', qrId: 'qr1', date: '2020-01-01', releasedPaise: 400000 }]);
        expect((await ask(app, 1000)).status).toBe(200);
        expect((await ask(app, 0.01)).status).toBe(400);
    });
});
