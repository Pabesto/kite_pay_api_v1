// setup-bank-accounts-schema.js — one-off, idempotent schema for the Bank Account pay-in channel
// (bankAccounts.js, mounted at /api/bank-acs). Creates:
//
//   bank_accounts                       one doc per account; `bankAcId` = the account number (unique) + the
//                                       same seven ledger fields as a QR doc (paise)
//   bank_transactions                   payment claims: pending → approved | rejected | cancelled
//   daily_bankac_summaries              { date, totalsJson: { bankAcId: paise } } — bank twin of daily_qr_summaries
//   bankac_daily_releases               T+0 early-release rows (qrSettlement instance keyed by bankAcId)
//   daily_bankac_withdrawal_summaries   day-wise withdrawal report (withdrawalSummary instance)
//
// and ADDS `bankAcId` (nullable string) to the withdrawal-request collection, making `qrId` optional
// there if it is currently required (a bank withdrawal stores qrId: null).
//
// Safe to run multiple times: every create tolerates an "already exists" (409). Attributes provision
// asynchronously, so indexes are created after a fixed sleep (same mitigation as the other scripts).
//
//   node scripts/setup-bank-accounts-schema.js
//
// Deploy order: run this BEFORE deploying bankAccounts.js. No backfill is needed — the collections are
// new and every writer is live from day one. Then add the (optional) config keys:
//   bankac_max_pending_claims = 20   (integer; 0 = unlimited)
//   bankac_realtime_enabled  = true  (boolean)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID,
    APPWRITE_BANK_ACCOUNTS_COLLECTION_ID = 'bank_accounts',
    APPWRITE_BANK_TRANSACTIONS_COLLECTION_ID = 'bank_transactions',
    APPWRITE_DAILY_BANKAC_SUMMARIES_COLLECTION_ID = 'daily_bankac_summaries',
    APPWRITE_BANKAC_DAILY_RELEASES_COLLECTION_ID = 'bankac_daily_releases',
    APPWRITE_DAILY_BANKAC_WITHDRAWAL_SUMMARIES_COLLECTION_ID = 'daily_bankac_withdrawal_summaries',
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID })) {
    if (!v) { console.error(`❌ Missing required env var ${k} — check the .env at the project root.`); process.exit(1); }
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID;
const ACCOUNTS = APPWRITE_BANK_ACCOUNTS_COLLECTION_ID, TXNS = APPWRITE_BANK_TRANSACTIONS_COLLECTION_ID, DAILY = APPWRITE_DAILY_BANKAC_SUMMARIES_COLLECTION_ID;
const RELEASES = APPWRITE_BANKAC_DAILY_RELEASES_COLLECTION_ID, DAILY_WD = APPWRITE_DAILY_BANKAC_WITHDRAWAL_SUMMARIES_COLLECTION_ID, WD = APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safe(label, fn) {
    try { await fn(); console.log(`  ✅ ${label}`); }
    catch (e) {
        if (e?.code === 409) console.log(`  ↩︎  ${label} — already exists, skipped`);
        else { console.error(`  ❌ ${label}:`, e?.message || e); throw e; }
    }
}
const str = (col, key, size, required = false) => safe(`attr ${key} (string ${size}${required ? ', required' : ''})`, () => db.createStringAttribute(DB, col, key, size, required));
const int = (col, key, required = false) => safe(`attr ${key} (integer${required ? ', required' : ''})`, () => db.createIntegerAttribute(DB, col, key, required));
const bool = (col, key) => safe(`attr ${key} (boolean)`, () => db.createBooleanAttribute(DB, col, key, false));
const dbl = (col, key) => safe(`attr ${key} (double)`, () => db.createFloatAttribute(DB, col, key, false));
const idx = (col, key, type, cols) => safe(`index ${key} (${type} [${cols.join(', ')}])`, () => db.createIndex(DB, col, key, type, cols));
const LEDGER = ['totalTransactions', 'totalPayInAmount', 'withdrawalRequestedAmount', 'withdrawalApprovedAmount', 'amountAvailableForWithdrawal', 'amountOnHold', 'commissionOnHold', 'commissionPaid'];

async function main() {
    console.log(`\nSetting up the Bank Account schema in database ${DB}\n`);

    console.log(`${ACCOUNTS}:`);
    await safe(`create collection "${ACCOUNTS}"`, () => db.createCollection(DB, ACCOUNTS, 'Bank Accounts', undefined, true, true));
    await str(ACCOUNTS, 'bankAcId', 64, true);
    for (const [k, n] of [['bankName', 100], ['accountHolderName', 120], ['ifscCode', 20], ['accountType', 20], ['upiId', 100], ['notes', 500], ['assignedUserId', 64], ['managedByUserId', 64], ['createdByUserId', 64], ['createdAt', 40]]) await str(ACCOUNTS, k, n);
    await int(ACCOUNTS, 'perTxnLimitPaise'); await int(ACCOUNTS, 'dailyLimitPaise');
    await bool(ACCOUNTS, 'isActive');
    for (const k of LEDGER) await int(ACCOUNTS, k);

    console.log(`\n${TXNS}:`);
    await safe(`create collection "${TXNS}"`, () => db.createCollection(DB, TXNS, 'Bank Transactions', undefined, true, true));
    await str(TXNS, 'bankAcId', 64, true);
    await str(TXNS, 'userId', 64, true);
    await str(TXNS, 'referenceNumber', 64, true);
    await int(TXNS, 'amountPaise', true);
    await int(TXNS, 'approvedAmountPaise');
    for (const [k, n] of [['ownerSubadminId', 64], ['requestedBy', 64], ['payerName', 120], ['paidAt', 40], ['remarks', 500], ['proofFileId', 64], ['status', 20], ['reviewedBy', 64], ['reviewedAt', 40], ['reviewNotes', 500], ['rejectReason', 300], ['deletedBy', 64], ['deletedAt', 40], ['createdAt', 40], ['created_at', 40]]) await str(TXNS, k, n);
    await bool(TXNS, 'deleted');

    console.log(`\n${DAILY}:`);
    await safe(`create collection "${DAILY}"`, () => db.createCollection(DB, DAILY, 'Daily Bank Account Summaries', undefined, true, true));
    await str(DAILY, 'date', 30, true); await str(DAILY, 'totalsJson', 999999);

    console.log(`\n${RELEASES}:`);
    await safe(`create collection "${RELEASES}"`, () => db.createCollection(DB, RELEASES, 'Bank Account Daily Releases', undefined, true, true));
    await str(RELEASES, 'bankAcId', 128, true); await str(RELEASES, 'date', 10, true);
    await int(RELEASES, 'releasedPaise', true); await int(RELEASES, 'todayPayInAtSetPaise'); await dbl(RELEASES, 'maxPercentAtSet'); await dbl(RELEASES, 'percentAtSet');
    await str(RELEASES, 'reason', 300); await int(RELEASES, 'changeCount'); await str(RELEASES, 'historyJson', 20000); await str(RELEASES, 'releasedBy', 64); await str(RELEASES, 'createdAt', 40); await str(RELEASES, 'updatedAt', 40);

    console.log(`\n${DAILY_WD}:`);
    await safe(`create collection "${DAILY_WD}"`, () => db.createCollection(DB, DAILY_WD, 'Daily Bank Account Withdrawal Summaries', undefined, true, true));
    await str(DAILY_WD, 'date', 30, true); await str(DAILY_WD, 'totalsJson', 999999);

    console.log(`\n${WD} (withdrawal requests):`);
    await str(WD, 'bankAcId', 64);
    // A bank withdrawal stores qrId: null, so qrId must be optional. Attribute updates are supported by
    // Appwrite ≥ 1.4; on an older server this logs and you flip "required" off in the console by hand.
    try {
        const attr = await db.getAttribute(DB, WD, 'qrId');
        if (attr?.required) {
            await safe('make qrId optional', () => db.updateStringAttribute(DB, WD, 'qrId', false, null));
        } else console.log('  ↩︎  qrId is already optional');
    } catch (e) { console.warn(`  ⚠️  could not inspect/alter ${WD}.qrId (${e?.message || e}) — make sure it is NOT required before enabling bank withdrawals`); }

    console.log('\n  …waiting for attributes to become available');
    await sleep(4000);

    await idx(ACCOUNTS, 'idx_bankAcId', 'unique', ['bankAcId']);
    await idx(ACCOUNTS, 'idx_assignedUserId', 'key', ['assignedUserId']);
    await idx(ACCOUNTS, 'idx_managedByUserId', 'key', ['managedByUserId']);
    await idx(ACCOUNTS, 'idx_createdAt', 'key', ['createdAt']);
    await idx(TXNS, 'idx_bankAcId', 'key', ['bankAcId']);
    await idx(TXNS, 'idx_referenceNumber', 'key', ['referenceNumber']);   // uniqueness is app-level: a rejected claim may be re-submitted
    await idx(TXNS, 'idx_status', 'key', ['status']);
    await idx(TXNS, 'idx_userId', 'key', ['userId']);
    await idx(TXNS, 'idx_ownerSubadminId', 'key', ['ownerSubadminId']);
    await idx(TXNS, 'idx_createdAt', 'key', ['createdAt']);
    await idx(DAILY, 'idx_date', 'unique', ['date']);
    await idx(RELEASES, 'idx_bankac_date', 'unique', ['bankAcId', 'date']);
    await idx(RELEASES, 'idx_date', 'key', ['date']);
    await idx(RELEASES, 'idx_bankAcId', 'key', ['bankAcId']);
    await idx(DAILY_WD, 'idx_date', 'unique', ['date']);
    await idx(WD, 'idx_bankAcId', 'key', ['bankAcId']);

    console.log('\n✅ Bank Account schema setup complete.\n');
    console.log('Optional .env overrides (the defaults below are what server.js uses):');
    for (const [k, v] of [['APPWRITE_BANK_ACCOUNTS_COLLECTION_ID', ACCOUNTS], ['APPWRITE_BANK_TRANSACTIONS_COLLECTION_ID', TXNS], ['APPWRITE_DAILY_BANKAC_SUMMARIES_COLLECTION_ID', DAILY], ['APPWRITE_BANKAC_DAILY_RELEASES_COLLECTION_ID', RELEASES], ['APPWRITE_DAILY_BANKAC_WITHDRAWAL_SUMMARIES_COLLECTION_ID', DAILY_WD]]) console.log(`  ${k}=${v}`);
    console.log('\nNext: deploy, then (optionally) add config keys bankac_max_pending_claims (integer) and bankac_realtime_enabled (boolean).\n');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
