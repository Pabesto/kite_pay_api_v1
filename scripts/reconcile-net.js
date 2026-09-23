// reconcile-net.js — READ-ONLY. Explains the dashboard's `netBreakdown.unexplainedPaise` by recomputing
// every figure that feeds `netFlow` from its source-of-truth collection and comparing it with the
// counter the dashboard uses and with the ledgers. Nothing is written.
//
//   node scripts/reconcile-net.js            # full report
//   node scripts/reconcile-net.js --top 30   # show the 30 worst QR/bank ledger mismatches (default 15)
//
// netFlow = (counter:totalAmountReceived + counter:totalBankAmountReceived)
//         − (totalAmountPaid − totalPayoutWalletFunded + totalCustomerPayoutPaid)
// explained = Σ QR ledger balance + Σ bank ledger balance + totalPayoutWalletBalance + commission counters
//
// Every line of that formula is a counter that is incremented forever and can drift from the rows it
// describes: a counter increment that failed while the row was written, rows written before a counter
// existed, a QR deleted with balance on it, a pay-in to a QR id that has no ledger doc, a ledger write
// that failed after 3 retries (updateQrTotalAtomic returns null and the webhook still answers 200).
// This script measures each of those gaps so you can see which one is the ₹ you are missing.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client, Query } = require('node-appwrite');

const E = process.env;
const req = (k) => { if (!E[k]) { console.error(`❌ Missing env ${k}`); process.exit(1); } return E[k]; };
const DB = req('APPWRITE_DATABASE_ID');
const COL = {
    qr: req('APPWRITE_QRCODE_COLLECTION_ID'), txns: req('APPWRITE_WEBHOOK_DATA_COLLECTION_ID'),
    wd: req('APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID'), comm: req('APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID'),
    counters: req('APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID'),
    bank: E.APPWRITE_BANK_ACCOUNTS_COLLECTION_ID || 'bank_accounts', bankTxns: E.APPWRITE_BANK_TRANSACTIONS_COLLECTION_ID || 'bank_transactions',
    wallets: E.APPWRITE_PAYOUT_WALLETS_COLLECTION_ID || 'payout_wallets', payouts: E.APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID || 'customer_payouts',
    payoutComm: E.APPWRITE_PAYOUT_COMMISSION_TRANSACTIONS_COLLECTION_ID || 'payout_commission_transactions',
};
const TOP = Number((process.argv.find((a) => a.startsWith('--top=')) || '').split('=')[1] || (process.argv[process.argv.indexOf('--top') + 1] || 15)) || 15;

const db = require('../appwriteDb')(new Client().setEndpoint(req('APPWRITE_ENDPOINT')).setProject(req('APPWRITE_PROJECT_ID')).setKey(req('APPWRITE_API_KEY')));
const rs = (p) => `₹${(Number(p || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rsToPaise = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const family = (id) => String(id || '').replace(/_hold\d*$/, '');

/** Page a whole collection. `select` trims the payload; retried without it on servers that reject it. */
async function scan(col, fields, filters = [], label = col) {
    const out = []; let cursor = null, useSelect = !!fields;
    for (let page = 0; page < 100000; page++) {
        const q = [...filters, Query.orderAsc('$id'), Query.limit(100)];
        if (cursor) q.push(Query.cursorAfter(cursor));
        if (useSelect) q.push(Query.select(['$id', ...fields]));
        let r;
        try { r = await db.listDocuments(DB, col, q); }
        catch (e) {
            if (useSelect) { useSelect = false; page--; continue; }
            if (e?.code === 404) { console.warn(`  ⚠️  ${label}: collection not found — treated as empty`); return out; }
            throw e;
        }
        out.push(...r.documents);
        if (page % 50 === 49) process.stdout.write(`  …${label}: ${out.length} rows\r`);
        if (r.documents.length < 100) break;
        cursor = r.documents[r.documents.length - 1].$id;
    }
    process.stdout.write(`  ${label}: ${out.length} rows\n`);
    return out;
}
const sum = (rows, f) => rows.reduce((s, d) => s + Number(f(d) || 0), 0);
const line = (label, a, b, note = '') => {
    const d = Number(a) - Number(b);
    console.log(`  ${label.padEnd(58)} ${rs(a).padStart(18)} ${rs(b).padStart(18)} ${(d === 0 ? '0' : rs(d)).padStart(18)}  ${note}`);
    return d;
};

async function counters() {
    const map = {};
    for (const d of await scan(COL.counters, ['id', 'totals'], [], 'dashboard_counters')) map[d.id || d.$id] = Number(d.totals || 0);
    // Appwrite only — the Redis-maintained pay-in counters are read from their flushed Appwrite copies
    // (dashboard_counters, refreshed every minute by server.js), so this script never opens Redis.
    return (k) => Number(map[k] || 0);
}

async function main() {
    console.log('\n=== net reconciliation (read-only) ===\n');
    const get = await counters();

    // ── ledgers ─────────────────────────────────────────────────────────────
    const ledger = async (col, key, label) => {
        const docs = await scan(col, [key, 'totalPayInAmount', 'withdrawalApprovedAmount', 'withdrawalRequestedAmount', 'amountOnHold', 'commissionOnHold', 'commissionPaid', 'amountAvailableForWithdrawal', 'isActive'], [], label);
        const t = { count: docs.length, byId: new Map(), byFamily: new Map() };
        for (const f of ['totalPayInAmount', 'withdrawalApprovedAmount', 'withdrawalRequestedAmount', 'amountOnHold', 'commissionOnHold', 'commissionPaid', 'amountAvailableForWithdrawal']) t[f] = sum(docs, (d) => d[f]);
        t.balance = t.amountAvailableForWithdrawal + t.withdrawalRequestedAmount + t.amountOnHold + t.commissionOnHold;
        t.identity = t.totalPayInAmount - t.withdrawalApprovedAmount - t.withdrawalRequestedAmount - t.amountOnHold - t.commissionOnHold - t.commissionPaid - t.amountAvailableForWithdrawal;
        for (const d of docs) { t.byId.set(d[key], d); t.byFamily.set(family(d[key]), (t.byFamily.get(family(d[key])) || 0) + Number(d.totalPayInAmount || 0)); }
        return t;
    };
    const qr = await ledger(COL.qr, 'qrId', 'qr_codes');
    const bank = await ledger(COL.bank, 'bankAcId', 'bank_accounts');

    // ── sources of truth ────────────────────────────────────────────────────
    const txns = await scan(COL.txns, ['amount', 'qrCodeId', 'deleted', 'status', 'reviewStatus', 'provider'], [], 'webhook_data');
    const live = txns.filter((t) => t.deleted !== true && t.reviewStatus !== 'pending_review' && t.reviewStatus !== 'rejected');
    const txLive = sum(live, (t) => t.amount);
    const txByFamily = new Map(); const orphans = new Map();
    for (const t of live) {
        const fam = family(t.qrCodeId); txByFamily.set(fam, (txByFamily.get(fam) || 0) + Number(t.amount || 0));
        if (!qr.byId.has(t.qrCodeId) && !qr.byFamily.has(fam)) orphans.set(t.qrCodeId || '(none)', (orphans.get(t.qrCodeId || '(none)') || 0) + Number(t.amount || 0));
    }
    const nonNormal = live.filter((t) => t.status && t.status !== 'normal');

    const bankTxns = await scan(COL.bankTxns, ['bankAcId', 'amountPaise', 'approvedAmountPaise', 'status', 'deleted'], [], 'bank_transactions');
    const bankLive = bankTxns.filter((t) => t.status === 'approved' && t.deleted !== true);
    const bankTx = sum(bankLive, (t) => t.approvedAmountPaise ?? t.amountPaise);

    const wds = await scan(COL.wd, ['qrId', 'bankAcId', 'status', 'mode', 'preAmount', 'amount', 'commission', 'earlyReleaseCommission', 'walletRevertedPaise', 'walletRevertedCommissionPaise'], [], 'withdrawal_requests');
    const approved = wds.filter((w) => w.status === 'approved'), pending = wds.filter((w) => w.status === 'pending');
    const wdDirect = sum(approved.filter((w) => w.mode !== 'wallet'), (w) => rsToPaise(w.preAmount));
    const wdWallet = sum(approved.filter((w) => w.mode === 'wallet'), (w) => rsToPaise(w.preAmount));
    const wdReverted = sum(approved, (w) => w.walletRevertedPaise);
    const wdCommission = sum(approved, (w) => rsToPaise(w.commission)) + sum(approved, (w) => rsToPaise(w.earlyReleaseCommission)) - sum(approved, (w) => w.walletRevertedCommissionPaise);
    const wdPendingHeld = sum(pending, (w) => rsToPaise(w.preAmount)) + sum(pending, (w) => rsToPaise(w.commission)) + sum(pending, (w) => rsToPaise(w.earlyReleaseCommission));
    const wdApprovedQr = sum(approved.filter((w) => !w.bankAcId), (w) => rsToPaise(w.preAmount)) - sum(approved.filter((w) => !w.bankAcId), (w) => w.walletRevertedPaise);
    const wdApprovedBank = sum(approved.filter((w) => w.bankAcId), (w) => rsToPaise(w.preAmount)) - sum(approved.filter((w) => w.bankAcId), (w) => w.walletRevertedPaise);

    const payouts = await scan(COL.payouts, ['status', 'amountPaise', 'commissionPaise'], [], 'customer_payouts');
    const paid = payouts.filter((p) => p.status === 'paid');
    const payoutPaid = sum(paid, (p) => p.amountPaise), payoutCommissionRows = sum(paid, (p) => p.commissionPaise);
    const wallets = await scan(COL.wallets, ['balancePaise', 'holdPaise'], [], 'payout_wallets');
    const walletBalance = sum(wallets, (w) => w.balancePaise);

    const comm = await scan(COL.comm, ['userId', 'amount', 'earningType', 'commissionType'], [], 'commission_transactions');
    const cSum = (pred) => sum(comm.filter(pred), (c) => c.amount);
    const payinAdmin = cSum((c) => c.commissionType !== 'early_release' && c.earningType === 'admin');
    const payinMerchant = cSum((c) => c.commissionType !== 'early_release' && c.earningType !== 'admin');
    const earlyAdmin = cSum((c) => c.commissionType === 'early_release' && c.earningType === 'admin');
    const earlyMerchant = cSum((c) => c.commissionType === 'early_release' && c.earningType !== 'admin');
    const pcomm = await scan(COL.payoutComm, ['amount', 'earningType'], [], 'payout_commission_transactions');
    const payoutAdmin = sum(pcomm.filter((c) => c.earningType === 'admin'), (c) => c.amount);
    const payoutMerchant = sum(pcomm.filter((c) => c.earningType !== 'admin'), (c) => c.amount);

    // ── report ──────────────────────────────────────────────────────────────
    console.log(`\n${'figure'.padEnd(60)} ${'dashboard counter'.padStart(18)} ${'recomputed'.padStart(18)} ${'delta'.padStart(18)}`);
    console.log('  ' + '-'.repeat(118));
    const gaps = {};
    console.log('  PAY-INS');
    gaps.qrIn = line('QR received: counter vs Σ live webhook_data', get('totalAmountReceived'), txLive, '(counter − rows)');
    line('QR received: counter vs Σ qr_codes.totalPayInAmount', get('totalAmountReceived'), qr.totalPayInAmount, '(counter − ledgers)');
    gaps.qrLedger = line('QR ledgers: Σ totalPayInAmount vs Σ live webhook_data', qr.totalPayInAmount, txLive, '(ledgers − rows)');
    gaps.bankIn = line('Bank received: counter vs Σ approved bank_transactions', get('totalBankAmountReceived'), bankTx);
    line('Bank ledgers: Σ totalPayInAmount vs Σ approved bank_transactions', bank.totalPayInAmount, bankTx);
    console.log('  MONEY OUT');
    gaps.paid = line('totalAmountPaid vs Σ approved preAmount − reverted (all modes)', get('totalAmountPaid'), wdDirect + wdWallet - wdReverted);
    gaps.funded = line('totalPayoutWalletFunded vs Σ approved wallet preAmount − reverted', get('totalPayoutWalletFunded'), wdWallet - wdReverted);
    gaps.payoutPaid = line('totalCustomerPayoutPaid vs Σ paid customer_payouts.amountPaise', get('totalCustomerPayoutPaid'), payoutPaid);
    line('QR ledgers: Σ withdrawalApprovedAmount vs Σ approved QR withdrawals', qr.withdrawalApprovedAmount, wdApprovedQr);
    line('Bank ledgers: Σ withdrawalApprovedAmount vs Σ approved bank withdrawals', bank.withdrawalApprovedAmount, wdApprovedBank);
    line('Ledgers: Σ (requested + commissionOnHold) vs Σ pending withdrawals', qr.withdrawalRequestedAmount + qr.commissionOnHold + bank.withdrawalRequestedAmount + bank.commissionOnHold, wdPendingHeld);
    console.log('  COMMISSION');
    gaps.payinAdmin = line('totalAdminProfit vs Σ commission rows (payin, admin)', get('totalAdminProfit'), payinAdmin);
    gaps.payinMerchant = line('totalMerchantProfit vs Σ commission rows (payin, subadmin)', get('totalMerchantProfit'), payinMerchant);
    gaps.earlyAdmin = line('totalEarlyReleaseAdminProfit vs Σ early-release rows (admin)', get('totalEarlyReleaseAdminProfit'), earlyAdmin);
    line('totalEarlyReleaseMerchantProfit vs Σ early-release rows (subadmin)', get('totalEarlyReleaseMerchantProfit'), earlyMerchant);
    gaps.payoutAdmin = line('totalPayoutAdminProfit vs Σ payout commission rows (admin)', get('totalPayoutAdminProfit'), payoutAdmin);
    gaps.payoutMerchant = line('totalPayoutMerchantProfit vs Σ payout commission rows (subadmin)', get('totalPayoutMerchantProfit'), payoutMerchant);
    line('Σ ledger commissionPaid (QR + bank) vs Σ approved withdrawal commission', qr.commissionPaid + bank.commissionPaid, wdCommission);
    line('Σ approved withdrawal commission vs Σ commission rows (payin + early)', wdCommission, payinAdmin + payinMerchant + earlyAdmin + earlyMerchant);
    line('Σ paid payout commissionPaise vs Σ payout commission rows', payoutCommissionRows, payoutAdmin + payoutMerchant);
    console.log('  WALLETS');
    gaps.wallet = line('totalPayoutWalletBalance vs Σ payout_wallets.balancePaise', get('totalPayoutWalletBalance'), walletBalance);
    console.log('  LEDGER SELF-CHECK (each must be 0: available is derived from the other six)');
    line('QR ledgers: total − approved − requested − onHold − commOnHold − commPaid − available', qr.identity, 0);
    line('Bank ledgers: same identity', bank.identity, 0);

    // ── the gap, attributed ────────────────────────────────────────────────
    const received = get('totalAmountReceived') + get('totalBankAmountReceived');
    const paidOut = get('totalAmountPaid') - get('totalPayoutWalletFunded') + get('totalCustomerPayoutPaid');
    const netFlow = received - paidOut;
    const commissionCounters = get('totalAdminProfit') + get('totalMerchantProfit') + get('totalPayoutAdminProfit') + get('totalPayoutMerchantProfit') + get('totalEarlyReleaseAdminProfit') + get('totalEarlyReleaseMerchantProfit');
    const explained = qr.balance + bank.balance + get('totalPayoutWalletBalance') + commissionCounters;
    const unexplained = netFlow - explained;
    console.log('\n=== the gap ===');
    console.log(`  netFlow (counters)                 ${rs(netFlow).padStart(18)}`);
    console.log(`  explained (ledgers + counters)     ${rs(explained).padStart(18)}`);
    console.log(`  UNEXPLAINED                        ${rs(unexplained).padStart(18)}\n`);

    // What the same formula gives when every counter is replaced by its recomputed value.
    const netFlowRows = (txLive + bankTx) - (wdDirect + wdWallet - wdReverted - (wdWallet - wdReverted) + payoutPaid);
    const explainedRows = qr.balance + bank.balance + walletBalance + payinAdmin + payinMerchant + earlyAdmin + earlyMerchant + payoutAdmin + payoutMerchant;
    console.log(`  netFlow from rows                  ${rs(netFlowRows).padStart(18)}`);
    console.log(`  explained from rows                ${rs(explainedRows).padStart(18)}`);
    console.log(`  gap from rows                      ${rs(netFlowRows - explainedRows).padStart(18)}   ← what remains after every counter is corrected\n`);

    console.log('  contribution of each counter drift to the unexplained gap (+ inflates net / − deflates explained):');
    const contrib = [
        ['QR received counter above its rows', gaps.qrIn],
        ['bank received counter above its rows', gaps.bankIn],
        ['totalAmountPaid counter below its rows', -gaps.paid],
        ['totalPayoutWalletFunded counter above its rows', gaps.funded],
        ['totalCustomerPayoutPaid counter below its rows', -gaps.payoutPaid],
        ['commission counters below their rows (payin)', -(gaps.payinAdmin + gaps.payinMerchant)],
        ['commission counters below their rows (payout)', -(gaps.payoutAdmin + gaps.payoutMerchant)],
        ['commission counters below their rows (early release)', -gaps.earlyAdmin],
        ['wallet balance counter below its rows', -gaps.wallet],
        ['QR ledgers below their rows (missed/failed ledger credits, deleted QRs)', -gaps.qrLedger],
    ].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [l, v] of contrib) if (v) console.log(`    ${l.padEnd(72)} ${rs(v).padStart(16)}`);

    if (orphans.size) {
        const total = [...orphans.values()].reduce((a, b) => a + b, 0);
        console.log(`\n  pay-ins to qrCodeIds with NO qr_codes doc (counted in the counter, on no ledger): ${rs(total)} across ${orphans.size} ids`);
        for (const [id, v] of [...orphans.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`    ${String(id).padEnd(40)} ${rs(v).padStart(16)}`);
    }
    if (nonNormal.length) console.log(`\n  live transactions with a non-normal status (their amount sits in amountOnHold, included in balance): ${nonNormal.length} rows, ${rs(sum(nonNormal, (t) => t.amount))}`);

    const rows = [];
    for (const [fam, ledgerTotal] of qr.byFamily) { const tx = txByFamily.get(fam) || 0; if (tx !== ledgerTotal) rows.push([fam, ledgerTotal, tx, ledgerTotal - tx]); }
    for (const [fam, tx] of txByFamily) if (!qr.byFamily.has(fam)) rows.push([fam + ' (no doc)', 0, tx, -tx]);
    rows.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
    if (rows.length) {
        console.log(`\n  QR families where the ledger's totalPayInAmount ≠ Σ live webhook_data (top ${TOP} of ${rows.length}; "_hold" generations folded together):`);
        console.log(`    ${'qrId'.padEnd(40)} ${'ledger'.padStart(16)} ${'rows'.padStart(16)} ${'ledger − rows'.padStart(16)}`);
        for (const [fam, l, t, d] of rows.slice(0, TOP)) console.log(`    ${fam.padEnd(40)} ${rs(l).padStart(16)} ${rs(t).padStart(16)} ${rs(d).padStart(16)}`);
    }
    console.log('\nDone. Nothing was written.\n');
}

main().catch((e) => { console.error('\nreconcile failed:', e?.message || e); process.exit(1); });
