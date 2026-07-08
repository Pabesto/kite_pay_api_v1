/**
 * finalizeTransaction — regression suite for the centralized "increment everywhere"
 * pipeline (transactionFinalize.js). Locks in the 5 side-effects every ingest path
 * and the manual-review approve path must run, so the pipeline can't silently drift:
 *   1. QR-doc totals   2. daily QR summary   3. socket emit
 *   4. partner webhook 5. dashboard counters
 */

const createFinalizeTransaction = require('../transactionFinalize');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fully-stubbed dependency set; override any piece per test. */
function makeDeps(overrides = {}) {
    const redisClient = {
        incrBy: jest.fn().mockResolvedValue(1),
        countersDirty: false,
        countersStale: false,
    };
    return {
        updateQrTotalAtomic: jest.fn().mockResolvedValue({ $id: 'qr1', assignedUserId: 'user-42' }),
        updateDailyQrTotal:  jest.fn().mockResolvedValue(undefined),
        emitTxnNew:          jest.fn(),
        partnerWebhooks:     { dispatch: jest.fn() },
        withRedisTimeout:    jest.fn((p) => p), // pass-through so the counter chain runs
        redisClient,
        ...overrides,
    };
}

/** Let fire-and-forget counter promises settle. */
const flush = () => new Promise((r) => setImmediate(r));

const sampleCreated = {
    $id:        'txn-doc-1',
    qrCodeId:   'QR123',
    paymentId:  'pay_abc',
    amount:     50000, // paise
    rrnNumber:  'RRN9',
    vpa:        'payer@upi',
    provider:   'razorpay',
    created_at: '2026-07-08T10:00:00.000Z',
};

let errSpy;
beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errSpy.mockRestore(); });

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('finalizeTransaction — happy path', () => {
    test('runs all five side-effects with correct arguments', async () => {
        const deps = makeDeps();
        const finalizeTransaction = createFinalizeTransaction(deps);

        const ret = await finalizeTransaction(sampleCreated);
        await flush();

        // 1. QR-doc totals
        expect(deps.updateQrTotalAtomic).toHaveBeenCalledWith('QR123', 50000);
        // 2. daily QR summary
        expect(deps.updateDailyQrTotal).toHaveBeenCalledWith('QR123', '2026-07-08T10:00:00.000Z', 50000);
        // 3. socket emit — assignedUserId resolved from the QR doc
        expect(deps.emitTxnNew).toHaveBeenCalledTimes(1);
        expect(deps.emitTxnNew.mock.calls[0][0]).toEqual({
            assignedUserId: 'user-42',
            qrCodeId: 'QR123',
            payload: {
                $id: 'txn-doc-1',
                qrCodeId: 'QR123',
                paymentId: 'pay_abc',
                amount: 50000,
                rrnNumber: 'RRN9',
                vpa: 'payer@upi',
                provider: 'razorpay',
                created_at: '2026-07-08T10:00:00.000Z',
            },
        });
        // 4. partner webhook — the raw created doc, once
        expect(deps.partnerWebhooks.dispatch).toHaveBeenCalledWith(sampleCreated, 'payment.created');
        // 5. counters — three exact increments, timeout-guarded
        expect(deps.withRedisTimeout).toHaveBeenCalledTimes(1);
        expect(deps.redisClient.incrBy).toHaveBeenCalledWith('counter:totalTxCount', 1);
        expect(deps.redisClient.incrBy).toHaveBeenCalledWith('counter:totalApiTx', 1);
        expect(deps.redisClient.incrBy).toHaveBeenCalledWith('counter:totalAmountReceived', 50000);
        expect(deps.redisClient.countersDirty).toBe(true);
        // returns the QR doc
        expect(ret).toEqual({ $id: 'qr1', assignedUserId: 'user-42' });
    });

    test('uses an explicit emitPayload verbatim when provided', async () => {
        const deps = makeDeps();
        const finalizeTransaction = createFinalizeTransaction(deps);
        const custom = { $id: 'x', qrCodeId: 'QR123', paymentId: 'pay_abc', amount: 50000, provider: 'pinelabs', foo: 'bar' };

        await finalizeTransaction(sampleCreated, { emitPayload: custom });
        await flush();

        expect(deps.emitTxnNew.mock.calls[0][0].payload).toBe(custom);
    });
});

describe('finalizeTransaction — QR not found', () => {
    test('emits with empty assignedUserId and still records daily total + counters', async () => {
        const deps = makeDeps({ updateQrTotalAtomic: jest.fn().mockResolvedValue(null) });
        const finalizeTransaction = createFinalizeTransaction(deps);

        const ret = await finalizeTransaction(sampleCreated);
        await flush();

        expect(deps.emitTxnNew.mock.calls[0][0].assignedUserId).toBe('');
        expect(deps.updateDailyQrTotal).toHaveBeenCalledTimes(1);
        expect(deps.partnerWebhooks.dispatch).toHaveBeenCalledTimes(1);
        expect(deps.redisClient.incrBy).toHaveBeenCalledTimes(3);
        expect(ret).toBeNull();
    });
});

describe('finalizeTransaction — non-fatal failures', () => {
    test('daily-total failure does not abort emit / webhook / counters', async () => {
        const deps = makeDeps({
            updateDailyQrTotal: jest.fn().mockRejectedValue(new Error('daily summary corrupt')),
        });
        const finalizeTransaction = createFinalizeTransaction(deps);

        await expect(finalizeTransaction(sampleCreated)).resolves.toBeDefined();
        await flush();

        expect(deps.emitTxnNew).toHaveBeenCalledTimes(1);
        expect(deps.partnerWebhooks.dispatch).toHaveBeenCalledTimes(1);
        expect(deps.redisClient.incrBy).toHaveBeenCalledTimes(3);
    });

    test('counter failure flags countersStale and never throws', async () => {
        const deps = makeDeps({
            withRedisTimeout: jest.fn(() => Promise.reject(new Error('redis down'))),
        });
        const finalizeTransaction = createFinalizeTransaction(deps);

        await expect(finalizeTransaction(sampleCreated)).resolves.toBeDefined();
        await flush();

        expect(deps.redisClient.countersStale).toBe(true);
        expect(deps.redisClient.countersDirty).toBe(false);
    });
});
