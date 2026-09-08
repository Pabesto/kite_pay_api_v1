// Pins the derived dashboard roll-ups, above all the double-count rule: totalPayoutWalletFunded
// is already inside totalAmountPaid, so money that left the platform must subtract it before
// adding the customer payouts it funded.
// admin.js pulls these in at require time — see the Testing bar in CLAUDE.md.
jest.mock('../scripts/transactionStatusMailer', () => ({}));   // top-level return + sends real email
jest.mock('../configManager', () => ({ get: (_k, d) => d, refresh: jest.fn() }));
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(), invalidate: jest.fn() }));

const { deriveDashboardTotals } = require('../admin.js');

const derive = (counters) => deriveDashboardTotals((k) => counters[k] || 0);

describe('deriveDashboardTotals', () => {
    // 1,000 in pay-ins; 600 withdrawn of which 200 only moved into payout wallets;
    // 150 of that wallet money was actually paid out to customers.
    const base = {
        totalAmountReceived: 100000, totalTxCount: 4,
        totalAmountPaid: 60000, totalPayoutWalletFunded: 20000,
        totalCustomerPayoutPaid: 15000, totalCustomerPayoutPendingAmount: 3000,
        totalAdminProfit: 1000, totalPayoutAdminProfit: 500,
        totalMerchantProfit: 700, totalPayoutMerchantProfit: 300,
    };

    test('excludes wallet funding from money that left the platform', () => {
        const d = derive(base);
        expect(d.withdrawalsToBank).toBe(40000);          // 60000 − 20000
        expect(d.totalPaidOut).toBe(55000);               // 40000 + 15000, NOT 60000 + 15000
        expect(d.totalPaidOut).not.toBe(base.totalAmountPaid + base.totalCustomerPayoutPaid);
        expect(d.netFlow).toBe(45000);                    // 100000 − 55000
    });

    test('netFlow may go negative', () => {
        expect(derive({ ...base, totalAmountReceived: 10000 }).netFlow).toBe(-45000);
    });

    test('rolls up the two disjoint commission pots', () => {
        const d = derive(base);
        expect(d.totalAdminProfitAll).toBe(1500);
        expect(d.totalMerchantProfitAll).toBe(1000);
        expect(d.totalPlatformProfit).toBe(2500);
        expect(d.totalCustomerPayoutAll).toBe(18000);     // paid + pending
    });

    test('avgTxAmount is integer paise and never divides by zero', () => {
        expect(derive(base).avgTxAmount).toBe(25000);
        expect(derive({ ...base, totalTxCount: 0 }).avgTxAmount).toBe(0);
        expect(derive({ ...base, totalTxCount: 3 }).avgTxAmount).toBe(33333); // rounded, not fractional
    });

    test('adminMarginPercent is a 2dp number, 0 when nothing was received', () => {
        expect(derive(base).adminMarginPercent).toBe(1.5);
        expect(derive({ ...base, totalAdminProfit: 2140, totalPayoutAdminProfit: 0 }).adminMarginPercent).toBe(2.14);
        expect(derive({ ...base, totalAmountReceived: 0 }).adminMarginPercent).toBe(0);
    });

    test('an empty counter collection yields all zeros, not NaN', () => {
        for (const v of Object.values(derive({}))) expect(v).toBe(0);
    });
});
