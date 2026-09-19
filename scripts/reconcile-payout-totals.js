// reconcile-payout-totals.js — READ-ONLY. Explains the gap between the day-wise withdrawal report
// (Σ preAmount of approved withdrawals, direct + wallet) and the dashboard "Total Payout"
// (withdrawalsToBank + customer payouts paid) by recomputing every input from the source rows and
// printing it next to the stored dashboard counters. Writes nothing.
//
//   node scripts/reconcile-payout-totals.js                 # all time
//   node scripts/reconcile-payout-totals.js --days 30       # withdrawals/payouts processed in the last N IST days

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Query } = require('node-appwrite');
const moment = require('moment-timezone');

const args = process.argv.slice(2);
const DAYS = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : null;

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID,
    APPWRITE_PAYOUT_WALLETS_COLLECTION_ID, APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID = 'dashboard_counters',
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID, APPWRITE_PAYOUT_WALLETS_COLLECTION_ID })) {
    if (!v) { console.error(`❌ Missing required env var ${k}`); process.exit(1); }
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID;
const rsToPaise = (rs) => Math.round(Number(rs || 0) * 100);
const rs = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (label, p) => console.log(`  ${label.padEnd(44)} ${String(p).padStart(14)}  ${rs(p)}`);
const sinceIso = DAYS ? moment.tz('Asia/Kolkata').startOf('day').subtract(DAYS - 1, 'days').utc().toISOString() : null;
const inRange = (ts) => !sinceIso || (ts && ts >= sinceIso);

async function scan(col, filters, onDoc) {
    let cursor = null;
    for (let page = 0; page < 5000; page++) { // ponytail: 500k rows cap
        const q = [...filters, Query.orderAsc('$id'), Query.limit(100)];
        if (cursor) q.push(Query.cursorAfter(cursor));
        const r = await db.listDocuments(DB, col, q);
        r.documents.forEach(onDoc);
        if (r.documents.length < 100) return;
        cursor = r.documents[r.documents.length - 1].$id;
    }
    console.warn(`⚠️  page cap hit on ${col} — INCOMPLETE`);
}

async function main() {
    console.log(`Reconcile payout totals — ${DAYS ? `last ${DAYS} IST days (since ${sinceIso})` : 'all time'}\n`);

    // 1) stored dashboard counters
    const counters = {};
    await scan(APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID, [], (d) => { counters[d.id || d.$id] = Number(d.totals) || 0; });
    const c = (k) => counters[k] || 0;

    // 2) approved withdrawals: direct vs wallet, preAmount (= paid) and commission; reverted wallet amounts
    const w = { direct: 0, wallet: 0, directCommission: 0, walletCommission: 0, count: 0, reverted: 0, creditFailed: 0 };
    await scan(APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, [Query.equal('status', 'approved')], (d) => {
        if (!inRange(d.processedAt)) return;
        const paid = d.preAmount != null ? rsToPaise(d.preAmount) : rsToPaise(d.amount) - rsToPaise(d.commission);
        w.count++;
        if (d.mode === 'wallet') {
            w.wallet += paid; w.walletCommission += rsToPaise(d.commission);
            w.reverted += Number(d.walletRevertedPaise || 0);
            if (d.walletCreditFailed) w.creditFailed += paid;
        } else { w.direct += paid; w.directCommission += rsToPaise(d.commission); }
    });

    // 3) customer payouts
    const p = { paid: 0, paidCommission: 0, paidCount: 0, pending: 0, pendingCount: 0 };
    await scan(APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID, [Query.equal('status', ['paid', 'pending'])], (d) => {
        if (d.status === 'pending') { p.pending += Number(d.amountPaise || 0); p.pendingCount++; return; }
        if (!inRange(d.processedAt || d.paidAt)) return;
        p.paid += Number(d.amountPaise || 0); p.paidCommission += Number(d.commissionPaise || 0); p.paidCount++;
    });

    // 4) wallet float (point-in-time, never ranged)
    let walletBalance = 0, walletHold = 0;
    await scan(APPWRITE_PAYOUT_WALLETS_COLLECTION_ID, [], (d) => { walletBalance += Number(d.balancePaise || 0); walletHold += Number(d.holdPaise || 0); });

    const reportTotal = w.direct + w.wallet;                       // what /withdrawal-summary grandTotalPaise sums
    const dashboardPaidOut = w.direct + p.paid;                    // what deriveDashboardTotals computes, from source rows
    const walletFundedNet = w.wallet - w.reverted;

    console.log('DAY-WISE WITHDRAWAL REPORT (recomputed from approved withdrawals)');
    fmt('direct (bank/UPI) paid  [preAmount]', w.direct);
    fmt('wallet funded           [preAmount]', w.wallet);
    fmt('= grandTotalPaise', reportTotal);
    fmt('  (commission charged, not in total)', w.directCommission + w.walletCommission);
    console.log(`  approved withdrawals: ${w.count}\n`);

    console.log('DASHBOARD TOTAL PAYOUT (recomputed from source rows)');
    fmt('withdrawalsToBank = direct', w.direct);
    fmt('+ customer payouts paid [amountPaise]', p.paid);
    fmt('= totalPaidOut', dashboardPaidOut);
    console.log();

    console.log('WHERE THE GAP GOES  (report − dashboard = wallet funded − customer payouts paid)');
    fmt('report − dashboard', reportTotal - dashboardPaidOut);
    fmt('  payout wallet balance (float, now)', walletBalance);
    fmt('    of which on hold for pending payouts', walletHold);
    fmt('  payout commission on paid payouts', p.paidCommission);
    fmt('  wallet withdrawals reverted to QR', w.reverted);
    fmt('  = explained', walletBalance + p.paidCommission + w.reverted);
    fmt('  unexplained residual', (reportTotal - dashboardPaidOut) - (walletBalance + p.paidCommission + w.reverted));
    if (DAYS) console.log('  (residual is expected when ranged: wallet float/pending are all-time, and wallet funding before the range can be paid out inside it)');
    console.log();

    console.log('STORED DASHBOARD COUNTERS vs RECOMPUTED (all-time — counters are incremental, never ranged)');
    const cmp = (name, recomputed, stored = c(name)) => { console.log(`  ${name.padEnd(36)} stored ${String(stored).padStart(12)}  recomputed ${String(recomputed).padStart(12)}  drift ${String(stored - recomputed).padStart(10)}  ${rs(stored - recomputed)}`); };
    if (DAYS) console.log('  (you passed --days; the recomputed side below is ranged, so drift here is NOT meaningful — rerun without --days)');
    cmp('totalAmountPaid', w.direct + walletFundedNet);
    cmp('totalPayoutWalletFunded', walletFundedNet);
    cmp('totalCustomerPayoutPaid', p.paid);
    cmp('totalCustomerPayoutPendingAmount', p.pending);
    cmp('totalPayoutWalletBalance', walletBalance);
    cmp('payout profit (admin+merchant)', p.paidCommission, c('totalPayoutAdminProfit') + c('totalPayoutMerchantProfit'));
    const storedPaidOut = (c('totalAmountPaid') - c('totalPayoutWalletFunded')) + c('totalCustomerPayoutPaid');
    console.log();
    fmt('dashboard totalPaidOut (from stored counters)', storedPaidOut);
    fmt('dashboard totalPaidOut (recomputed)', dashboardPaidOut);
    if (w.creditFailed) fmt('⚠ wallet withdrawals flagged walletCreditFailed', w.creditFailed);
}

main().catch((e) => { console.error('❌', e.message || e); process.exit(1); });
