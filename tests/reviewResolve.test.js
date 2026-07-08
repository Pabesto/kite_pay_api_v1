/**
 * reviewResolve — the pending-review exactly-once state machine.
 * Verifies approve → finalize, reject → rejection record + daily summary, and the
 * guards (already-resolved no-op, not-found, lock-busy) that make an admin action and
 * the timeout sweeper mutually exclusive.
 */

const createReviewResolve = require('../reviewResolve');

const PENDING_DOC = {
    $id: 't1',
    reviewStatus: 'pending_review',
    qrCodeId: 'QR1',
    amount: 5000,
    paymentId: 'pay_1',
    provider: 'razorpay',
    vpa: 'x@upi',
    rrnNumber: 'RRN1',
    ownerSubadminId: 'S1',
    created_at: '2026-07-08T10:00:00.000Z',
};

function makeDeps(overrides = {}) {
    const databases = {
        getDocument: jest.fn().mockResolvedValue({ ...PENDING_DOC }),
        updateDocument: jest.fn((db, col, id, data) =>
            Promise.resolve({ ...PENDING_DOC, $id: id, ...data })),
        createDocument: jest.fn().mockResolvedValue({ $id: 'new' }),
        listDocuments: jest.fn().mockResolvedValue({ total: 0, documents: [] }),
        ...(overrides.databases || {}),
    };
    return {
        databases,
        Query: { equal: jest.fn(() => ({})), limit: jest.fn(() => ({})) },
        ID: { unique: () => 'uid' },
        DB: 'db', WEBHOOK_COL: 'wh', REJECTED_COL: 'rej', DAILY_REJECTED_COL: 'drej',
        finalizeTransaction: jest.fn().mockResolvedValue(undefined),
        acquireLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined),
        acquireDailyLock: jest.fn().mockResolvedValue({ key: 'lk', val: 'lv' }),
        nowIso: () => '2026-07-08T10:00:30.000Z',
        todayStr: () => '2026-07-08',
        emitReviewResolved: jest.fn(),
        ...overrides,
    };
}

describe('approve', () => {
    test('flips to approved/deleted:false and runs finalizeTransaction', async () => {
        const deps = makeDeps();
        const { resolveReview } = createReviewResolve(deps);

        const r = await resolveReview('t1', 'approve', { id: 'admin1', name: 'Admin' });

        expect(r.status).toBe('approved');
        const upd = deps.databases.updateDocument.mock.calls[0][3];
        expect(upd).toMatchObject({ reviewStatus: 'approved', deleted: false, reviewedBy: 'admin1' });
        expect(deps.finalizeTransaction).toHaveBeenCalledTimes(1);
        // finalize receives the UPDATED doc (deleted:false), not the stale pending one
        expect(deps.finalizeTransaction.mock.calls[0][0]).toMatchObject({ $id: 't1', deleted: false });
        expect(deps.releaseLock).toHaveBeenCalledTimes(1);
        // admins notified with the outcome
        expect(deps.emitReviewResolved).toHaveBeenCalledTimes(1);
        expect(deps.emitReviewResolved.mock.calls[0][0]).toMatchObject({ $id: 't1', outcome: 'approved' });
    });
});

describe('reject', () => {
    test('stays deleted:true, writes rejection record + daily summary, no finalize', async () => {
        const deps = makeDeps();
        const { resolveReview } = createReviewResolve(deps);

        const r = await resolveReview('t1', 'reject', { id: 'admin1', name: 'Admin', reason: 'fraud' });

        expect(r.status).toBe('rejected');
        expect(deps.databases.updateDocument.mock.calls[0][3]).toMatchObject({ reviewStatus: 'rejected', deleted: true });
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();

        // rejection record written to REJECTED_COL with the reason + amount
        const recCall = deps.databases.createDocument.mock.calls.find(c => c[1] === 'rej');
        expect(recCall).toBeTruthy();
        expect(recCall[3]).toMatchObject({ txnId: 't1', qrId: 'QR1', amount: 5000, reason: 'fraud', adminId: 'admin1' });

        // daily summary created (none existed) under the daily lock
        expect(deps.acquireDailyLock).toHaveBeenCalledWith('rej:2026-07-08');
        const sumCall = deps.databases.createDocument.mock.calls.find(c => c[1] === 'drej');
        expect(sumCall).toBeTruthy();
        expect(JSON.parse(sumCall[3].totalsJson)).toEqual({ QR1: 5000 });
        expect(deps.releaseLock).toHaveBeenCalled();
        expect(deps.emitReviewResolved.mock.calls[0][0]).toMatchObject({ $id: 't1', outcome: 'rejected' });
    });

    test('merges into an existing daily summary doc', async () => {
        const deps = makeDeps({
            databases: {
                getDocument: jest.fn().mockResolvedValue({ ...PENDING_DOC }),
                updateDocument: jest.fn((db, col, id, data) => Promise.resolve({ ...PENDING_DOC, $id: id, ...data })),
                createDocument: jest.fn().mockResolvedValue({ $id: 'new' }),
                listDocuments: jest.fn().mockResolvedValue({
                    total: 1,
                    documents: [{ $id: 'sum1', totalsJson: JSON.stringify({ QR1: 1000, QR2: 200 }) }],
                }),
            },
        });
        const { resolveReview } = createReviewResolve(deps);

        await resolveReview('t1', 'reject', { id: 'a', name: 'A' });

        const sumUpdate = deps.databases.updateDocument.mock.calls.find(c => c[1] === 'drej');
        expect(sumUpdate).toBeTruthy();
        expect(JSON.parse(sumUpdate[3].totalsJson)).toEqual({ QR1: 6000, QR2: 200 }); // 1000 + 5000
    });
});

describe('exactly-once guards', () => {
    test('already-resolved doc is a no-op (no update, no finalize)', async () => {
        const deps = makeDeps({
            databases: {
                getDocument: jest.fn().mockResolvedValue({ ...PENDING_DOC, reviewStatus: 'approved' }),
                updateDocument: jest.fn(),
                createDocument: jest.fn(),
                listDocuments: jest.fn(),
            },
        });
        const { resolveReview } = createReviewResolve(deps);

        const r = await resolveReview('t1', 'approve', { id: 'a', name: 'A' });

        expect(r).toEqual({ status: 'already_resolved', reviewStatus: 'approved' });
        expect(deps.databases.updateDocument).not.toHaveBeenCalled();
        expect(deps.finalizeTransaction).not.toHaveBeenCalled();
        expect(deps.releaseLock).toHaveBeenCalledTimes(1);
    });

    test('not-found returns not_found', async () => {
        const err = new Error('missing'); err.code = 404;
        const deps = makeDeps({
            databases: { getDocument: jest.fn().mockRejectedValue(err), updateDocument: jest.fn(), createDocument: jest.fn(), listDocuments: jest.fn() },
        });
        const { resolveReview } = createReviewResolve(deps);
        const r = await resolveReview('t1', 'approve', 'system-timeout');
        expect(r.status).toBe('not_found');
        expect(deps.releaseLock).toHaveBeenCalledTimes(1);
    });

    test('lock busy returns locked without touching the doc', async () => {
        const deps = makeDeps({ acquireLock: jest.fn().mockResolvedValue(false) });
        const { resolveReview } = createReviewResolve(deps);
        const r = await resolveReview('t1', 'approve', 'system-timeout');
        expect(r.status).toBe('locked');
        expect(deps.databases.getDocument).not.toHaveBeenCalled();
        expect(deps.releaseLock).not.toHaveBeenCalled();
    });

    test('rejects an invalid outcome', async () => {
        const { resolveReview } = createReviewResolve(makeDeps());
        await expect(resolveReview('t1', 'bogus', 'x')).rejects.toThrow(/outcome/);
    });
});
