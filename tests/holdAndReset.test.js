/**
 * POST /admin/qr/:qrId/hold-and-reset — pins what the reset moves to "<qrId>_hold" and, just as
 * importantly, what it leaves alone:
 *   • pending-review transactions follow the archived ledger (a later approve credits _hold)
 *   • finalized / already-resolved transactions stay on the original id (moved out-of-band)
 *   • rejected log rows + the daily rejected summary key move
 *   • today's T+0 release row moves (qrSettlement.repointReleases)
 *   • dry run reports all of the above and mutates nothing
 */

const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');

jest.mock('../scripts/transactionStatusMailer', () => ({ sendMerchantHoldEmail: jest.fn() }));
jest.mock('../configManager', () => ({
    get: jest.fn((_key, def = null) => def),
    refresh: jest.fn().mockResolvedValue({}),
    getConfig: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(),
}));
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async () => null), invalidate: jest.fn() }));
jest.mock('../qrOwnerCache', () => ({ reload: jest.fn().mockResolvedValue(null), invalidateQr: jest.fn(), resolve: jest.fn().mockResolvedValue(null), get: jest.fn() }));

const QRS = 'qr_col', TXNS = 'webhook_col', DAILY = 'daily_qr', DELETED = 'daily_deleted', FLAGGED = 'daily_flagged',
    WD = 'withdrawal_col', HOLDS = 'manual_hold', REJECTED = 'rejected_txns', DAILY_REJ = 'daily_rejected', RELEASES = 'qr_daily_releases';
const SRC = '193893', HOLD = '193893_hold';
const today = () => require('moment-timezone')().tz('Asia/Kolkata').format('YYYY-MM-DD');

/** In-memory Appwrite: equal/limit honoured; ordering and cursors ignored (every fixture fits one page). */
function makeDb(seed) {
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
        getDocument: jest.fn(async (_d, c, id) => ({ ...col(c).find((x) => x.$id === id) })),
        createDocument: jest.fn(async (_d, c, id, data) => { const doc = { $id: id === 'unique' ? `${c}_${++seq}` : id, ...data }; col(c).push(doc); return { ...doc }; }),
        updateDocument: jest.fn(async (_d, c, id, data) => { const d = col(c).find((x) => x.$id === id); Object.assign(d, data); return { ...d }; }),
        deleteDocument: jest.fn(async (_d, c, id) => { store[c] = col(c).filter((x) => x.$id !== id); return {}; }),
    };
}

const makeRedis = () => ({
    set: jest.fn().mockResolvedValue('OK'), get: jest.fn().mockResolvedValue(null), del: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1), incrBy: jest.fn().mockResolvedValue(1), incr: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [] }), sAdd: jest.fn().mockResolvedValue(1),
});
const storage = {
    getFile: jest.fn().mockResolvedValue({ name: 'qr.png', mimeType: 'image/png' }),
    getFileDownload: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
    createFile: jest.fn().mockResolvedValue({ $id: 'file_fresh' }),
};
const asAdmin = (req, _res, next) => { req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] }; next(); };

function seed() {
    return {
        [QRS]: [{ $id: 'q1', qrId: SRC, fileId: 'f1', type: 'upi', companyName: 'Shop', assignedUserId: 'u1', isActive: true,
            totalTransactions: 3, totalPayInAmount: 5000, amountAvailableForWithdrawal: 5000, amountOnHold: 0 }],
        [TXNS]: [
            { $id: 't_final', qrCodeId: SRC, amount: 1000, status: 'normal' },
            { $id: 't_pending', qrCodeId: SRC, amount: 2000, deleted: true, reviewStatus: 'pending_review', reviewMode: 'manual' },
            { $id: 't_approved', qrCodeId: SRC, amount: 3000, reviewStatus: 'approved', deleted: false },
            { $id: 't_other_pending', qrCodeId: 'other', amount: 1, reviewStatus: 'pending_review' },
        ],
        [DAILY]: [{ $id: 'd1', date: today(), totalsJson: JSON.stringify({ [SRC]: 5000, other: 1 }) }],
        [DELETED]: [], [FLAGGED]: [], [WD]: [{ $id: 'w1', qrId: SRC }], [HOLDS]: [],
        [REJECTED]: [{ $id: 'rj1', qrId: SRC }, { $id: 'rj2', qrId: 'other' }],
        [DAILY_REJ]: [{ $id: 'r1', date: today(), totalsJson: JSON.stringify({ [SRC]: 700, other: 5 }) }],
        [RELEASES]: [{ $id: 'rel1', qrId: SRC, date: today(), releasedPaise: 2000, changeCount: 1, historyJson: '[]' }],
    };
}

/** Fresh admin router + the qrSettlement singleton it requires, both inside one isolateModules registry. */
function buildApp(db, redis = makeRedis()) {
    let router;
    jest.isolateModules(() => {
        require('../qrSettlement').init({ databases: db, Query, APPWRITE_DATABASE_ID: 'db1', APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID: DAILY, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID: RELEASES });
        // Positional args mirror the app.use('/api/admin', adminRoutes(...)) mount in server.js (42 args).
        router = require('../admin.js')(
            'https://appwrite.test/v1', 'proj1', db, storage, {}, { unique: () => 'unique' }, Query, 'db1',
            'users_meta', QRS, TXNS, 'bucket1', DAILY, DELETED, FLAGGED,
            'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'dashboard_counters', HOLDS, 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asAdmin, () => asAdmin, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin, redis, jest.fn(),
            WD, jest.fn().mockResolvedValue(), REJECTED, DAILY_REJ, jest.fn(), 'alltime_payout_comm', 'payout_wallets', 'customer_payouts'
        );
    });
    const app = express();
    app.use(express.json());
    app.use('/', router);
    return app;
}

const byId = (db, c, id) => db.store[c].find((d) => d.$id === id);

describe('hold-and-reset moves the later-added QR references', () => {
    test('real run: pending-review txns, rejected log/summary and the release row follow the hold; finalized txns do not', async () => {
        const db = makeDb(seed());
        const res = await request(buildApp(db)).post(`/qr/${SRC}/hold-and-reset`).send({ confirm: true, allowPendingReview: true });
        expect(res.status).toBe(200);
        expect(res.body.holdQrId).toBe(HOLD);
        expect(res.body.steps).toMatchObject({
            archivedQrDoc: true, createdFreshQrDoc: true, transactionsMoved: 'skipped (intentional)',
            pendingReviewTxnsAtStart: 1, pendingReviewTxnsMoved: 1, rejectedTxnsMoved: 1, rejectedSummaryDocsMoved: 1,
            releasesMoved: { scanned: 1, moved: 1, merged: 0 },
        });

        // QR docs: original archived, fresh one live and unassigned.
        expect(byId(db, QRS, 'q1')).toMatchObject({ qrId: HOLD, isActive: false, assignedUserId: 'u1', totalPayInAmount: 5000 });
        const fresh = db.store[QRS].find((d) => d.qrId === SRC);
        expect(fresh).toMatchObject({ isActive: true, assignedUserId: null, totalPayInAmount: 0, amountAvailableForWithdrawal: 0, fileId: 'file_fresh' });

        // Only the pending-review doc moved; finalized/approved history stays for the out-of-band job.
        expect(byId(db, TXNS, 't_pending').qrCodeId).toBe(HOLD);
        expect(byId(db, TXNS, 't_final').qrCodeId).toBe(SRC);
        expect(byId(db, TXNS, 't_approved').qrCodeId).toBe(SRC);
        expect(byId(db, TXNS, 't_other_pending').qrCodeId).toBe('other');

        // Rejected log + its daily key; other QRs untouched.
        expect(byId(db, REJECTED, 'rj1').qrId).toBe(HOLD);
        expect(byId(db, REJECTED, 'rj2').qrId).toBe('other');
        expect(JSON.parse(byId(db, DAILY_REJ, 'r1').totalsJson)).toEqual({ [HOLD]: 700, other: 5 });
        expect(JSON.parse(byId(db, DAILY, 'd1').totalsJson)).toEqual({ [HOLD]: 5000, other: 1 });

        // The T+0 gate follows today's pay-in to the hold — the fresh QR starts fully T+1.
        expect(byId(db, RELEASES, 'rel1')).toMatchObject({ qrId: HOLD, releasedPaise: 2000 });
        expect(db.store[RELEASES].some((r) => r.qrId === SRC)).toBe(false);
    });

    test('dry run counts every category and writes nothing', async () => {
        const db = makeDb(seed());
        const res = await request(buildApp(db)).post(`/qr/${SRC}/hold-and-reset`).send({ dryRun: true });
        expect(res.status).toBe(200);
        expect(res.body.dryRun).toBe(true);
        expect(res.body.willMove).toMatchObject({ withdrawalRequests: 1, manualHolds: 0, pendingReviewTxns: 1, rejectedTxns: 1, releases: 1 });
        expect(res.body.state.needsPendingReviewConfirmation).toBe(true);
        expect(res.body.willNOTMove.transactions).toBe(3); // every webhook row on this QR, pending included
        expect(db.updateDocument).not.toHaveBeenCalled();
        expect(db.createDocument).not.toHaveBeenCalled();
        expect(db.deleteDocument).not.toHaveBeenCalled();
    });

    test('re-run after completion is a no-op for the new categories (idempotent)', async () => {
        const db = makeDb(seed());
        const app = buildApp(db);
        await request(app).post(`/qr/${SRC}/hold-and-reset`).send({ confirm: true, allowPendingReview: true });
        // The fresh QR is live and a hold exists → a plain repeat is refused until acknowledged; the
        // dry run shows nothing left to move for the new categories.
        const again = await request(app).post(`/qr/${SRC}/hold-and-reset`).send({ dryRun: true });
        expect(again.body.state.isRepeatReset).toBe(true);
        expect(again.body.willMove).toMatchObject({ pendingReviewTxns: 0, rejectedTxns: 0, releases: 0 });
        expect(again.body.state.needsPendingReviewConfirmation).toBe(false);
    });

    test('REFUSES (409) while payments are held for review — checked under lock:qr, nothing mutated, lock released', async () => {
        const db = makeDb(seed());
        const redis = makeRedis();
        const res = await request(buildApp(db, redis)).post(`/qr/${SRC}/hold-and-reset`).send({ confirm: true });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ needsPendingReviewConfirmation: true, pendingReviewTxns: 1 });
        expect(byId(db, QRS, 'q1').qrId).toBe(SRC);                       // not renamed
        expect(db.updateDocument).not.toHaveBeenCalled();
        expect(db.createDocument).not.toHaveBeenCalled();
        expect(redis.set).toHaveBeenCalledWith(`lock:qr:${SRC}`, expect.any(String), expect.objectContaining({ NX: true }));
        expect(redis.eval).toHaveBeenCalledTimes(1);                        // Lua compare-and-delete in finally
        expect(redis.eval.mock.calls[0][1].keys).toEqual([`lock:qr:${SRC}`]);
    });

    test('with no held payments the real run needs no acknowledgement', async () => {
        const data = seed();
        data[TXNS] = data[TXNS].filter((t) => t.reviewStatus !== 'pending_review');
        const db = makeDb(data);
        const res = await request(buildApp(db)).post(`/qr/${SRC}/hold-and-reset`).send({ confirm: true });
        expect(res.status).toBe(200);
        expect(res.body.steps).toMatchObject({ pendingReviewTxnsAtStart: 0, pendingReviewTxnsMoved: 0 });
    });
});
