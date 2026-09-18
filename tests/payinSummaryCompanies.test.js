/**
 * GET /admin/payin-summary — company breakdown: QR pay-in rolls up under qr_codes.companyName, matched
 * case-insensitively to the company_names config (config spelling wins, every configured company is
 * listed even at 0), and ?companyName= narrows the report to that company's QRs.
 */

const request = require('supertest');
const express = require('express');
const { Query } = require('node-appwrite');

jest.mock('../scripts/transactionStatusMailer', () => ({ sendMerchantHoldEmail: jest.fn() }));
jest.mock('../configManager', () => ({
    get: jest.fn((key, def = null) => ({
        company_names: { 'SCANSERVE AI PRIVATE LIMITED': 'scanserve2@gmail.com', 'PABESTO TECH PVT. LTD.': '' },
        integrations: ['Razorpay', 'Paytm', 'PhonePe'],
    })[key] ?? def),
    refresh: jest.fn().mockResolvedValue({}),
    getConfig: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(),
}));
jest.mock('../userMetaCache', () => ({ getUserMeta: jest.fn(async () => null), invalidate: jest.fn() }));
jest.mock('../qrOwnerCache', () => ({ reload: jest.fn().mockResolvedValue(null), invalidateQr: jest.fn(), resolve: jest.fn().mockResolvedValue(null), get: jest.fn() }));

const QRS = 'qr_col', DAILY = 'daily_qr';
const today = () => require('moment-timezone')().tz('Asia/Kolkata').format('YYYY-MM-DD');

/** In-memory Appwrite: equal/limit honoured; ordering and cursors ignored (every fixture fits one page). */
function makeDb(seed) {
    const parse = (q) => { try { return JSON.parse(q); } catch { return null; } };
    return {
        listDocuments: jest.fn(async (_d, c, queries = []) => {
            let docs = (seed[c] || []).slice(), limit = 25;
            for (const raw of queries) {
                const q = parse(raw);
                if (!q) continue;
                if (q.method === 'limit') limit = q.values[0];
                else if (q.method === 'equal') docs = docs.filter((d) => q.values.includes(d[q.attribute]));
            }
            return { documents: docs.slice(0, limit).map((d) => ({ ...d })), total: docs.length };
        }),
    };
}
const asAdmin = (req, _res, next) => { req.user = { userId: 'admin1', role: 'admin', $id: 'admin1', labels: [] }; next(); };

function buildApp(db) {
    let router;
    jest.isolateModules(() => {
        // Positional args mirror the app.use('/api/admin', adminRoutes(...)) mount in server.js (42 args).
        router = require('../admin.js')(
            'https://appwrite.test/v1', 'proj1', db, {}, {}, { unique: () => 'unique' }, Query, 'db1',
            'users_meta', QRS, 'webhook_col', 'bucket1', DAILY, 'daily_deleted', 'daily_flagged',
            'commission_txs', 'daily_commission', 'all_time_commission', 'monthly_commission', 'dashboard_counters', 'manual_hold', 'config_col',
            jest.fn().mockResolvedValue(), jest.fn(), asAdmin, () => asAdmin, asAdmin, asAdmin, asAdmin, {}, asAdmin, () => asAdmin, {}, jest.fn(),
            'withdrawal_col', jest.fn().mockResolvedValue(), 'rejected_txns', 'daily_rejected', jest.fn(), 'alltime_payout_comm', 'payout_wallets', 'customer_payouts'
        );
    });
    const app = express();
    app.use('/', router);
    return app;
}

const db = makeDb({
    [QRS]: [
        { $id: 'q1', qrId: 'A', companyName: 'scanserve ai private limited', integrationName: 'razorpay' },   // lower-case on the QR → config spelling
        { $id: 'q2', qrId: 'B', companyName: 'Other Shop', integrationName: 'Razorpay' },                     // company not in config → own bucket
        { $id: 'q3', qrId: 'C', integrationName: 'Pinelabs' },                                                // blank company; integration not in config
    ],
    [DAILY]: [{ $id: 'd1', date: today(), totalsJson: JSON.stringify({ A: 1000, B: 500, C: 250, ghost: 5 }) }],
});

test('company breakdown: config spelling, zero rows for unused companies, unknown QRs bucketed', async () => {
    const res = await request(buildApp(db)).get('/payin-summary');
    expect(res.status).toBe(200);
    expect(res.body.grandTotalPaise).toBe(1755);
    expect(res.body.companies).toEqual([
        { companyName: 'SCANSERVE AI PRIVATE LIMITED', totalPaise: 1000, totalRs: 10 },
        { companyName: 'Other Shop', totalPaise: 500, totalRs: 5 },
        { companyName: '(no company)', totalPaise: 255, totalRs: 2.55 },
        { companyName: 'PABESTO TECH PVT. LTD.', totalPaise: 0, totalRs: 0 },
    ]);
    expect(res.body.days[0].companies).toEqual({ 'SCANSERVE AI PRIVATE LIMITED': 1000, 'Other Shop': 500, '(no company)': 255 });
    // integrations: A+B → Razorpay (config spelling), C → Pinelabs (own bucket), ghost → (no integration); Paytm/PhonePe at 0
    expect(res.body.integrations).toEqual([
        { integrationName: 'Razorpay', totalPaise: 1500, totalRs: 15 },
        { integrationName: 'Pinelabs', totalPaise: 250, totalRs: 2.5 },
        { integrationName: '(no integration)', totalPaise: 5, totalRs: 0.05 },
        { integrationName: 'Paytm', totalPaise: 0, totalRs: 0 },
        { integrationName: 'PhonePe', totalPaise: 0, totalRs: 0 },
    ]);
    expect(res.body.days[0].integrations).toEqual({ Razorpay: 1500, Pinelabs: 250, '(no integration)': 5 });
});

test('?integrationName= narrows (case-insensitive) and stacks with ?companyName=', async () => {
    const rz = await request(buildApp(db)).get('/payin-summary').query({ integrationName: 'RAZORPAY' });
    expect(rz.status).toBe(200);
    expect(rz.body.days[0].qrs).toEqual({ A: 1000, B: 500 });
    const both = await request(buildApp(db)).get('/payin-summary').query({ integrationName: 'razorpay', companyName: 'other shop' });
    expect(both.body.days[0].qrs).toEqual({ B: 500 });
    expect(both.body.grandTotalPaise).toBe(500);
});

test('?companyName= narrows to that company (case-insensitive)', async () => {
    const res = await request(buildApp(db)).get('/payin-summary').query({ companyName: '  Scanserve AI Private Limited ' });
    expect(res.status).toBe(200);
    expect(res.body.grandTotalPaise).toBe(1000);
    expect(res.body.days[0].qrs).toEqual({ A: 1000 });
    expect(res.body.companies[0]).toEqual({ companyName: 'SCANSERVE AI PRIVATE LIMITED', totalPaise: 1000, totalRs: 10 });
});
