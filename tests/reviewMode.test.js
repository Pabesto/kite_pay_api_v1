/**
 * reviewMode — in-memory manual-review-mode registry.
 * Verifies scope matching (global / qr / user), activation & reset/extend,
 * time-boxed expiry, clearing, and input validation. Uses fake timers to drive
 * the epoch-ms deadlines deterministically.
 */

const reviewMode = require('../reviewMode');

const T0 = new Date('2026-07-08T00:00:00.000Z').getTime();

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    reviewMode.clearManual({ all: true }); // reset the shared singleton between tests
});
afterEach(() => {
    jest.useRealTimers();
});

// advance the mocked clock by N ms
const advance = (ms) => jest.setSystemTime(Date.now() + ms);

describe('default state', () => {
    test('everything is auto with no windows', () => {
        expect(reviewMode.isManual('QR1', 'U1')).toBe(false);
        expect(reviewMode.effectiveMode('QR1', 'U1')).toBe('auto');
        expect(reviewMode.listActive()).toEqual([]);
    });
});

describe('global scope', () => {
    test('covers every transaction while active, then expires', () => {
        reviewMode.setManual({ scope: 'global', minutes: 5, setBy: 'admin1' });

        expect(reviewMode.isManual('ANY', 'ANYONE')).toBe(true);
        expect(reviewMode.effectiveMode('QR9', null)).toBe('manual');

        const active = reviewMode.listActive();
        expect(active).toHaveLength(1);
        expect(active[0]).toMatchObject({ scope: 'global', setBy: 'admin1' });
        expect(active[0].remainingMs).toBe(5 * 60 * 1000);

        advance(5 * 60 * 1000 + 1); // just past the deadline
        expect(reviewMode.isManual('ANY', 'ANYONE')).toBe(false);
        expect(reviewMode.listActive()).toEqual([]); // pruned
    });
});

describe('qr scope', () => {
    test('matches only the targeted QR', () => {
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 3 });
        expect(reviewMode.isManual('QR1', 'U1')).toBe(true);
        expect(reviewMode.isManual('QR2', 'U1')).toBe(false);
    });
});

describe('user scope', () => {
    test('matches only transactions owned by the targeted user', () => {
        reviewMode.setManual({ scope: 'user', userId: 'U1', minutes: 3 });
        expect(reviewMode.isManual('QRx', 'U1')).toBe(true);
        expect(reviewMode.isManual('QRx', 'U2')).toBe(false);
        expect(reviewMode.isManual('QRx', null)).toBe(false);
    });
});

describe('user scope — multiple owner ids', () => {
    test('matches if the window targets ANY provided owner id (subadmin OR direct user)', () => {
        reviewMode.setManual({ scope: 'user', userId: 'SUBADMIN1', minutes: 3 });
        // txn owned by SUBADMIN1, operated by USER9 → passing both should match on the subadmin
        expect(reviewMode.isManual('QRx', ['SUBADMIN1', 'USER9'])).toBe(true);
        // window on the direct user instead
        reviewMode.clearManual({ all: true });
        reviewMode.setManual({ scope: 'user', userId: 'USER9', minutes: 3 });
        expect(reviewMode.isManual('QRx', ['SUBADMIN1', 'USER9'])).toBe(true);
        // neither targeted → no match
        expect(reviewMode.isManual('QRx', ['SUBADMIN2', 'USER8'])).toBe(false);
    });

    test('hasActiveUserWindows reflects only user-scope windows', () => {
        expect(reviewMode.hasActiveUserWindows()).toBe(false);
        reviewMode.setManual({ scope: 'global', minutes: 3 });
        expect(reviewMode.hasActiveUserWindows()).toBe(false); // global is not a user window
        reviewMode.setManual({ scope: 'user', userId: 'U1', minutes: 3 });
        expect(reviewMode.hasActiveUserWindows()).toBe(true);
        advance(3 * 60 * 1000 + 1);
        expect(reviewMode.hasActiveUserWindows()).toBe(false); // expired
    });
});

describe('reset / extend', () => {
    test('re-activating the same scope replaces the deadline', () => {
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 1 });
        advance(30 * 1000); // 30s in
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 5 }); // reset to 5 min
        const [w] = reviewMode.listActive();
        expect(w.remainingMs).toBe(5 * 60 * 1000);
    });
});

describe('clearing', () => {
    test('clear a specific window returns to auto', () => {
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 5 });
        const cleared = reviewMode.clearManual({ scope: 'qr', qrId: 'QR1' });
        expect(cleared).toHaveLength(1);
        expect(reviewMode.isManual('QR1', null)).toBe(false);
    });

    test('clear all wipes every scope', () => {
        reviewMode.setManual({ scope: 'global', minutes: 5 });
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 5 });
        reviewMode.setManual({ scope: 'user', userId: 'U1', minutes: 5 });
        const cleared = reviewMode.clearManual({ all: true });
        expect(cleared).toHaveLength(3);
        expect(reviewMode.listActive()).toEqual([]);
    });
});

describe('reviewFieldsFor (ingest gate helper)', () => {
    // signature: reviewFieldsFor(qrId, ownerUserId, amountPaise, windowMs)
    test('auto: manual=false and no fields (no schema dependency)', () => {
        const r = reviewMode.reviewFieldsFor('QR1', 'S1', 5000, 60000);
        expect(r.manual).toBe(false);
        expect(r.fields).toEqual({});
    });

    test('manual: returns held fields with a computed reviewExpiresAt', () => {
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 5 });
        const r = reviewMode.reviewFieldsFor('QR1', 'S1', 5000, 60000);
        expect(r.manual).toBe(true);
        expect(r.fields).toMatchObject({
            deleted: true,
            reviewStatus: 'pending_review',
            reviewMode: 'manual',
        });
        expect(r.fields.reviewExpiresAt).toBe(new Date(T0 + 60000).toISOString());
    });

    test('manual by owner (user scope) also holds', () => {
        reviewMode.setManual({ scope: 'user', userId: 'S9', minutes: 5 });
        expect(reviewMode.reviewFieldsFor('QRx', 'S9', 1000, 60000).manual).toBe(true);
        expect(reviewMode.reviewFieldsFor('QRx', 'S8', 1000, 60000).manual).toBe(false);
    });
});

describe('min-amount threshold (per window)', () => {
    test('holds only txns at/above the window minAmount', () => {
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 5, minAmount: 10000 }); // ₹100
        expect(reviewMode.isManual('QR1', null, 5000)).toBe(false);   // below → auto
        expect(reviewMode.isManual('QR1', null, 10000)).toBe(true);   // at → manual
        expect(reviewMode.isManual('QR1', null, 25000)).toBe(true);   // above → manual
    });

    test('reviewFieldsFor respects the threshold', () => {
        reviewMode.setManual({ scope: 'global', minutes: 5, minAmount: 50000 }); // ₹500
        expect(reviewMode.reviewFieldsFor('ANY', null, 49999, 60000).manual).toBe(false);
        expect(reviewMode.reviewFieldsFor('ANY', null, 50000, 60000).manual).toBe(true);
    });

    test('minAmount 0 (default) holds every amount', () => {
        reviewMode.setManual({ scope: 'global', minutes: 5 }); // no threshold
        expect(reviewMode.isManual('X', null, 1)).toBe(true);
    });

    test('descriptor exposes minAmount + minAmountRs', () => {
        reviewMode.setManual({ scope: 'qr', qrId: 'QR1', minutes: 5, minAmount: 12345 });
        const [w] = reviewMode.listActive();
        expect(w).toMatchObject({ minAmount: 12345, minAmountRs: 123.45 });
    });
});

describe('validation', () => {
    test('rejects bad scope', () => {
        expect(() => reviewMode.setManual({ scope: 'nope', minutes: 5 })).toThrow(/scope/);
    });
    test('rejects out-of-range minutes', () => {
        expect(() => reviewMode.setManual({ scope: 'global', minutes: 0 })).toThrow(/minutes/);
        expect(() => reviewMode.setManual({ scope: 'global', minutes: 61 })).toThrow(/minutes/);
        expect(() => reviewMode.setManual({ scope: 'global', minutes: 'x' })).toThrow(/minutes/);
    });
    test('rejects negative minAmount', () => {
        expect(() => reviewMode.setManual({ scope: 'global', minutes: 5, minAmount: -1 })).toThrow(/minAmount/);
    });
    test('requires qrId / userId for their scopes', () => {
        expect(() => reviewMode.setManual({ scope: 'qr', minutes: 5 })).toThrow(/qrId/);
        expect(() => reviewMode.setManual({ scope: 'user', minutes: 5 })).toThrow(/userId/);
    });
});
