// setup-payout-schema.js — one-off, idempotent schema setup for the Customer Payout feature (payout.js).
//
// Creates / alters:
//   1. payout_wallets                      — one row per user: balancePaise, holdPaise (INTEGER PAISE)
//   2. payout_wallet_transactions          — wallet ledger (credits/debits), idempotent on (type, refId)
//   3. customer_payout_accounts            — saved customer beneficiaries, bankingStatus not_added|added
//   4. customer_payouts                    — customer payout requests (pending|paid|rejected)
//   5. payout_commission_transactions      — payout commission earned (admin/subadmin), paise
//   6. daily_payout_commission_summaries   — per-IST-day rollup { date, commissionsJson }
//      + monthly_payout_commission_totals / all_time_payout_commission_totals (per-user rollups)
//   7. users_meta.payoutCommission (double) — per-user payout commission rate (%)
//   8. withdrawal_requests: `mode` enum gains 'wallet'; `walletCreditFailed` (boolean) added
//
// Safe to run multiple times — every create tolerates 409 (already exists).
// Run BEFORE deploying the payout code:  node scripts/setup-payout-schema.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Databases } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID,
    APPWRITE_PAYOUT_WALLETS_COLLECTION_ID = 'payout_wallets',
    APPWRITE_PAYOUT_WALLET_TRANSACTIONS_COLLECTION_ID = 'payout_wallet_transactions',
    APPWRITE_CUSTOMER_PAYOUT_ACCOUNTS_COLLECTION_ID = 'customer_payout_accounts',
    APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID = 'customer_payouts',
    APPWRITE_PAYOUT_COMMISSION_TRANSACTIONS_COLLECTION_ID = 'payout_commission_transactions',
    APPWRITE_DAILY_PAYOUT_COMMISSION_SUMMARIES_COLLECTION_ID = 'daily_payout_commission_summaries',
    APPWRITE_MONTHLY_PAYOUT_COMMISSION_TOTALS_COLLECTION_ID = 'monthly_payout_commission_totals',
    APPWRITE_ALL_TIME_PAYOUT_COMMISSION_TOTALS_COLLECTION_ID = 'all_time_payout_commission_totals',
} = process.env;

if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID || !APPWRITE_USERS_META_COLLECTION_ID || !APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID) {
    console.error('❌ Missing required env vars (APPWRITE_ENDPOINT/PROJECT_ID/API_KEY/DATABASE_ID/USERS_META_COLLECTION_ID/WITHDRAWAL_REQUEST_COLLECTION_ID).');
    process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const DB = APPWRITE_DATABASE_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safe(label, fn) {
    try { await fn(); console.log(`  ✅ ${label}`); }
    catch (e) {
        if (e?.code === 409) console.log(`  ↩︎  ${label} — already exists, skipped`);
        else { console.error(`  ❌ ${label}:`, e?.message || e); throw e; }
    }
}
const str = (col, key, size, required = false) => safe(`attr ${key} (string ${size}${required ? ', required' : ''})`, () => db.createStringAttribute(DB, col, key, size, required));
const int = (col, key, required = false) => safe(`attr ${key} (integer)`, () => db.createIntegerAttribute(DB, col, key, required));
const dbl = (col, key) => safe(`attr ${key} (double)`, () => db.createFloatAttribute(DB, col, key, false));
const bool = (col, key, def = false) => safe(`attr ${key} (boolean)`, () => db.createBooleanAttribute(DB, col, key, false, def));
const idx = (col, key, type, attrs) => safe(`index ${key} (${type} ${JSON.stringify(attrs)})`, () => db.createIndex(DB, col, key, type, attrs));
const collection = (id, name) => safe(`create collection "${id}"`, () => db.createCollection(DB, id, name, undefined, true, true));

async function main() {
    console.log(`\nSetting up Customer Payout schema in database ${DB}\n`);

    // 1. payout_wallets
    const WALLETS = APPWRITE_PAYOUT_WALLETS_COLLECTION_ID;
    console.log(`${WALLETS}:`);
    await collection(WALLETS, 'Payout Wallets');
    await str(WALLETS, 'userId', 64, true);
    await int(WALLETS, 'balancePaise');
    await int(WALLETS, 'holdPaise');
    // lifetime totals for the user dashboard (maintained by payout.js moveWallet)
    await int(WALLETS, 'totalCreditedPaise');
    await int(WALLETS, 'totalPaidOutPaise');
    await int(WALLETS, 'totalPayoutCommissionPaise');
    await int(WALLETS, 'totalAdminDebitPaise');
    await int(WALLETS, 'totalRevertedToQrPaise');   // admin revert-to-QR debits
    await int(WALLETS, 'paidCount');
    await str(WALLETS, 'updatedAt', 40);
    await sleep(3000);
    await idx(WALLETS, 'idx_userId', 'unique', ['userId']);

    // 2. payout_wallet_transactions
    const TXNS = APPWRITE_PAYOUT_WALLET_TRANSACTIONS_COLLECTION_ID;
    console.log(`\n${TXNS}:`);
    await collection(TXNS, 'Payout Wallet Transactions');
    await str(TXNS, 'id', 64, true);
    await str(TXNS, 'userId', 64, true);
    await str(TXNS, 'type', 32, true);            // withdrawal_credit | payout_paid | admin_credit | admin_debit
    await str(TXNS, 'direction', 8, true);        // credit | debit
    await int(TXNS, 'amountPaise', true);
    await int(TXNS, 'commissionPaise');
    await int(TXNS, 'totalPaise', true);          // what actually moved the balance
    await int(TXNS, 'balanceAfterPaise');
    await int(TXNS, 'holdAfterPaise');
    await str(TXNS, 'refType', 32);               // withdrawal | customer_payout | manual
    await str(TXNS, 'refId', 64);
    await str(TXNS, 'referenceNumber', 100);
    await str(TXNS, 'notes', 500);
    await str(TXNS, 'createdBy', 64);
    await str(TXNS, 'createdAt', 40, true);
    await sleep(4000);
    await idx(TXNS, 'idx_id', 'unique', ['id']);
    await idx(TXNS, 'idx_type_refId', 'unique', ['type', 'refId']);   // idempotency guard
    await idx(TXNS, 'idx_user_createdAt', 'key', ['userId', 'createdAt']);
    await idx(TXNS, 'idx_user_type', 'key', ['userId', 'type']);

    // 3. customer_payout_accounts
    const ACCOUNTS = APPWRITE_CUSTOMER_PAYOUT_ACCOUNTS_COLLECTION_ID;
    console.log(`\n${ACCOUNTS}:`);
    await collection(ACCOUNTS, 'Customer Payout Accounts');
    await str(ACCOUNTS, 'userId', 64, true);
    await str(ACCOUNTS, 'customerName', 100, true);
    await str(ACCOUNTS, 'bankName', 100, true);
    await str(ACCOUNTS, 'ifscCode', 11, true);
    await str(ACCOUNTS, 'accountNumber', 18, true);
    await str(ACCOUNTS, 'upiId', 100);             // required only for mode UPI payouts
    await str(ACCOUNTS, 'bankingStatus', 16);      // not_added | added
    await str(ACCOUNTS, 'notes', 500);
    await str(ACCOUNTS, 'createdAt', 40);
    await str(ACCOUNTS, 'bankingStatusUpdatedAt', 40);
    await str(ACCOUNTS, 'bankingStatusUpdatedBy', 64);
    // per-customer payout stats (maintained by payout.js; repair: POST /admin/accounts/:id/recompute-stats)
    await int(ACCOUNTS, 'requestCount');
    await int(ACCOUNTS, 'paidCount');
    await int(ACCOUNTS, 'rejectedCount');
    await int(ACCOUNTS, 'totalPaidPaise');
    await int(ACCOUNTS, 'totalCommissionPaise');
    await str(ACCOUNTS, 'lastRequestedAt', 40);
    await str(ACCOUNTS, 'lastPaidAt', 40);
    await sleep(4000);
    await idx(ACCOUNTS, 'idx_user_account', 'unique', ['userId', 'accountNumber']);
    await idx(ACCOUNTS, 'idx_userId', 'key', ['userId']);
    await idx(ACCOUNTS, 'idx_accountNumber', 'key', ['accountNumber']);
    await idx(ACCOUNTS, 'idx_bankingStatus', 'key', ['bankingStatus']);
    await idx(ACCOUNTS, 'idx_customerName_ft', 'fulltext', ['customerName']);
    await idx(ACCOUNTS, 'idx_totalPaidPaise', 'key', ['totalPaidPaise']);   // sort/filter by amount paid
    await idx(ACCOUNTS, 'idx_paidCount', 'key', ['paidCount']);
    await idx(ACCOUNTS, 'idx_requestCount', 'key', ['requestCount']);
    await idx(ACCOUNTS, 'idx_lastPaidAt', 'key', ['lastPaidAt']);
    await idx(ACCOUNTS, 'idx_createdAt', 'key', ['createdAt']);

    // 4. customer_payouts
    const PAYOUTS = APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID;
    console.log(`\n${PAYOUTS}:`);
    await collection(PAYOUTS, 'Customer Payouts');
    await str(PAYOUTS, 'id', 64, true);
    await str(PAYOUTS, 'userId', 64, true);
    await str(PAYOUTS, 'accountId', 64, true);
    await str(PAYOUTS, 'customerName', 100);
    await str(PAYOUTS, 'bankName', 100);
    await str(PAYOUTS, 'ifscCode', 11);
    await str(PAYOUTS, 'accountNumber', 18);
    await str(PAYOUTS, 'upiId', 100);
    await str(PAYOUTS, 'mode', 8);                 // NEFT | IMPS | RTGS | UPI
    await int(PAYOUTS, 'amountPaise', true);
    await int(PAYOUTS, 'commissionPaise');
    await int(PAYOUTS, 'totalPaise', true);
    await dbl(PAYOUTS, 'commissionRate');
    await dbl(PAYOUTS, 'userCommissionRate');
    await dbl(PAYOUTS, 'parentCommissionRate');
    await str(PAYOUTS, 'notes', 500);
    await str(PAYOUTS, 'status', 16, true);        // pending | paid | rejected
    await str(PAYOUTS, 'referenceNumber', 100);
    await str(PAYOUTS, 'paidVia', 100);            // staff-only: which of OUR accounts paid it
    await str(PAYOUTS, 'rejectionReason', 500);
    await str(PAYOUTS, 'createdAt', 40, true);
    await str(PAYOUTS, 'processedAt', 40);
    await str(PAYOUTS, 'processedBy', 64);
    // service timeline (UTC ISO): requestedAt == createdAt; the rest are stamped by admin actions
    await str(PAYOUTS, 'addedToBankingAt', 40);
    await str(PAYOUTS, 'paidAt', 40);
    await str(PAYOUTS, 'rejectedAt', 40);
    await bool(PAYOUTS, 'commissionRollupFailed');
    await sleep(4000);
    await idx(PAYOUTS, 'idx_id', 'unique', ['id']);
    await idx(PAYOUTS, 'idx_user_createdAt', 'key', ['userId', 'createdAt']);
    await idx(PAYOUTS, 'idx_status_createdAt', 'key', ['status', 'createdAt']);
    await idx(PAYOUTS, 'idx_user_status', 'key', ['userId', 'status']);
    await idx(PAYOUTS, 'idx_account_status', 'key', ['accountId', 'status']);   // delete-account pending guard
    // admin queue filters / sorts
    await idx(PAYOUTS, 'idx_customerName_ft', 'fulltext', ['customerName']);
    await idx(PAYOUTS, 'idx_mode', 'key', ['mode']);
    await idx(PAYOUTS, 'idx_amountPaise', 'key', ['amountPaise']);
    await idx(PAYOUTS, 'idx_processedAt', 'key', ['processedAt']);
    await idx(PAYOUTS, 'idx_processedBy', 'key', ['processedBy']);
    await idx(PAYOUTS, 'idx_referenceNumber', 'key', ['referenceNumber']);
    await idx(PAYOUTS, 'idx_paidVia', 'key', ['paidVia']);

    // 5. payout_commission_transactions (mirrors commission_transactions)
    const COMM = APPWRITE_PAYOUT_COMMISSION_TRANSACTIONS_COLLECTION_ID;
    console.log(`\n${COMM}:`);
    await collection(COMM, 'Payout Commission Transactions');
    await str(COMM, 'userId', 128, true);
    await str(COMM, 'sourcePayoutId', 128, true);
    await int(COMM, 'amount', true);               // paise
    await dbl(COMM, 'commissionRate');
    await str(COMM, 'earningType', 25, true);      // admin | subadmin
    await str(COMM, 'createdAt', 40, true);
    await sleep(3000);
    await idx(COMM, 'idx_user_createdAt', 'key', ['userId', 'createdAt']);
    await idx(COMM, 'idx_createdAt', 'key', ['createdAt']);
    await idx(COMM, 'idx_sourcePayoutId', 'key', ['sourcePayoutId']);

    // 6. daily_payout_commission_summaries (mirrors daily_commission_summaries)
    const DAILY = APPWRITE_DAILY_PAYOUT_COMMISSION_SUMMARIES_COLLECTION_ID;
    console.log(`\n${DAILY}:`);
    await collection(DAILY, 'Daily Payout Commission Summaries');
    await str(DAILY, 'date', 30, true);
    await str(DAILY, 'commissionsJson', 999999);
    await sleep(3000);
    await idx(DAILY, 'idx_date', 'unique', ['date']);

    // 6b. monthly / all-time totals (mirror monthly_commission_totals / all_time_commission_totals)
    const MONTHLY = APPWRITE_MONTHLY_PAYOUT_COMMISSION_TOTALS_COLLECTION_ID;
    console.log(`\n${MONTHLY}:`);
    await collection(MONTHLY, 'Monthly Payout Commission Totals');
    await str(MONTHLY, 'userId', 128, true);
    await str(MONTHLY, 'month', 7, true);           // YYYY-MM (IST)
    await int(MONTHLY, 'totalCommissionPaise', true);
    await sleep(3000);
    await idx(MONTHLY, 'idx_user_month', 'unique', ['userId', 'month']);
    await idx(MONTHLY, 'idx_month_total', 'key', ['month', 'totalCommissionPaise']);

    const ALLTIME = APPWRITE_ALL_TIME_PAYOUT_COMMISSION_TOTALS_COLLECTION_ID;
    console.log(`\n${ALLTIME}:`);
    await collection(ALLTIME, 'All Time Payout Commission Totals');
    await str(ALLTIME, 'userId', 128, true);
    await int(ALLTIME, 'totalCommissionPaise', true);
    await sleep(3000);
    await idx(ALLTIME, 'idx_userId', 'unique', ['userId']);
    await idx(ALLTIME, 'idx_total', 'key', ['totalCommissionPaise']);

    // 7. users_meta: payoutCommission (%), per-user payout kill switch
    console.log(`\n${APPWRITE_USERS_META_COLLECTION_ID}:`);
    await dbl(APPWRITE_USERS_META_COLLECTION_ID, 'payoutCommission');
    await bool(APPWRITE_USERS_META_COLLECTION_ID, 'payoutDisabled');
    await str(APPWRITE_USERS_META_COLLECTION_ID, 'payoutDisabledReason', 200);

    // 8. withdrawal_requests: mode enum + walletCreditFailed
    const WD = APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID;
    console.log(`\n${WD}:`);
    await safe("enum mode += 'wallet'", async () => {
        const attr = await db.getAttribute(DB, WD, 'mode');
        const elements = attr.elements || [];
        if (elements.includes('wallet')) { const e = new Error('exists'); e.code = 409; throw e; }
        // node-appwrite requires xdefault to be passed explicitly (null = no default)
        await db.updateEnumAttribute(DB, WD, 'mode', [...elements, 'wallet'], !!attr.required, attr.default ?? null);
    });
    await bool(WD, 'walletCreditFailed');
    await int(WD, 'walletRevertedPaise');          // paise already reverted from the payout wallet back to the QR

    console.log('\n✅ Customer Payout schema setup complete.\n');
    console.log('Optional .env overrides (defaults shown are what server.js uses):');
    for (const [k, v] of Object.entries({
        APPWRITE_PAYOUT_WALLETS_COLLECTION_ID: WALLETS, APPWRITE_PAYOUT_WALLET_TRANSACTIONS_COLLECTION_ID: TXNS,
        APPWRITE_CUSTOMER_PAYOUT_ACCOUNTS_COLLECTION_ID: ACCOUNTS, APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID: PAYOUTS,
        APPWRITE_PAYOUT_COMMISSION_TRANSACTIONS_COLLECTION_ID: COMM, APPWRITE_DAILY_PAYOUT_COMMISSION_SUMMARIES_COLLECTION_ID: DAILY,
        APPWRITE_MONTHLY_PAYOUT_COMMISSION_TOTALS_COLLECTION_ID: MONTHLY, APPWRITE_ALL_TIME_PAYOUT_COMMISSION_TOTALS_COLLECTION_ID: ALLTIME,
    })) console.log(`  ${k}=${v}`);
    console.log('\nNext: set payoutCommission (%) per user via PUT /api/admin/edit-user/:id, then deploy.\n');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
