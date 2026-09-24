// setup-vendor-schema.js — one-off, idempotent schema for Vendor accounts (vendors.js, mounted at /api/vendors).
// Creates the eight vendor collections (see the header of vendors.js) and, if users_meta.role is an ENUM
// attribute, adds 'vendor' to it (a plain string attribute needs nothing).
//
// Safe to run multiple times: every create tolerates an "already exists" (409). Attributes provision
// asynchronously, so indexes are created after a fixed sleep (same mitigation as the other scripts).
//
//   node scripts/setup-vendor-schema.js
//
// Deploy order: run this BEFORE deploying vendors.js. No backfill: every collection is new. Then set the
// rate card (PUT /api/vendors/admin/rate-cards/:accountType) and create vendor logins with
// POST /api/admin/create-user { role: 'vendor' }.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
    APPWRITE_VENDOR_RATE_CARDS_COLLECTION_ID = 'vendor_rate_cards',
    APPWRITE_VENDOR_ACCOUNTS_COLLECTION_ID = 'vendor_accounts',
    APPWRITE_VENDOR_TRANSACTIONS_COLLECTION_ID = 'vendor_transactions',
    APPWRITE_VENDOR_WITHDRAWALS_COLLECTION_ID = 'vendor_withdrawals',
    APPWRITE_VENDOR_COMMISSIONS_COLLECTION_ID = 'vendor_commissions',
    APPWRITE_VENDOR_EARNINGS_COLLECTION_ID = 'vendor_earnings',
    APPWRITE_VENDOR_AUDIT_COLLECTION_ID = 'vendor_audit',
    APPWRITE_DAILY_VENDOR_SUMMARIES_COLLECTION_ID = 'daily_vendor_summaries',
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID })) {
    if (!v) { console.error(`❌ Missing required env var ${k} — check the .env at the project root.`); process.exit(1); }
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID;
const RC = APPWRITE_VENDOR_RATE_CARDS_COLLECTION_ID, AC = APPWRITE_VENDOR_ACCOUNTS_COLLECTION_ID, TX = APPWRITE_VENDOR_TRANSACTIONS_COLLECTION_ID;
const WD = APPWRITE_VENDOR_WITHDRAWALS_COLLECTION_ID, CM = APPWRITE_VENDOR_COMMISSIONS_COLLECTION_ID, EA = APPWRITE_VENDOR_EARNINGS_COLLECTION_ID;
const AU = APPWRITE_VENDOR_AUDIT_COLLECTION_ID, DY = APPWRITE_DAILY_VENDOR_SUMMARIES_COLLECTION_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safe(label, fn) {
    try { await fn(); console.log(`  ✅ ${label}`); }
    catch (e) {
        if (e?.code === 409) console.log(`  ↩︎  ${label} — already exists, skipped`);
        else { console.error(`  ❌ ${label}:`, e?.message || e); throw e; }
    }
}
const collection = (id, name) => safe(`create collection "${id}"`, () => db.createCollection(DB, id, name, undefined, true, true));
const str = (col, key, size, required = false) => safe(`${col}.${key} (string ${size}${required ? ', required' : ''})`, () => db.createStringAttribute(DB, col, key, size, required));
const int = (col, key, required = false) => safe(`${col}.${key} (integer${required ? ', required' : ''})`, () => db.createIntegerAttribute(DB, col, key, required));
const bool = (col, key) => safe(`${col}.${key} (boolean)`, () => db.createBooleanAttribute(DB, col, key, false));
const dbl = (col, key) => safe(`${col}.${key} (double)`, () => db.createFloatAttribute(DB, col, key, false));
const idx = (col, key, type, cols) => safe(`${col} index ${key} (${type} [${cols.join(', ')}])`, () => db.createIndex(DB, col, key, type, cols));
const strs = async (col, list) => { for (const [k, n] of list) await str(col, k, n); };
const LEDGER = ['totalTransactions', 'totalPayInAmount', 'withdrawalRequestedAmount', 'withdrawalCompletedAmount', 'commissionOnHold', 'adminCommissionEarned', 'vendorCommissionEarned', 'amountAvailableForWithdrawal'];

async function main() {
    console.log(`\nSetting up the Vendor schema in database ${DB}\n`);

    await collection(RC, 'Vendor Rate Cards');
    await str(RC, 'accountType', 20, true);
    await dbl(RC, 'adminPercent'); await dbl(RC, 'vendorPercent');
    await int(RC, 'salePricePaise'); await int(RC, 'rentPerMonthPaise');
    await strs(RC, [['updatedAt', 40], ['updatedBy', 64]]);

    await collection(AC, 'Vendor Accounts');
    await str(AC, 'accountNumber', 64, true); await str(AC, 'vendorId', 64, true); await str(AC, 'state', 20, true);
    await strs(AC, [['bankName', 100], ['accountHolderName', 120], ['ifscCode', 20], ['accountType', 20], ['mode', 20], ['upiId', 100], ['notes', 500],
        ['assignedUserId', 64], ['managedByUserId', 64], ['reviewedBy', 64], ['reviewedAt', 40], ['rejectReason', 300],
        ['rentStartDate', 40], ['rentEndDate', 40], ['delistRequestedAt', 40], ['createdAt', 40]]);
    for (const k of ['minTxnPaise', 'perTxnLimitPaise', 'dailyLimitPaise', 'salePricePaise', 'rentPerMonthPaise', ...LEDGER]) await int(AC, k);
    await dbl(AC, 'adminPercent'); await dbl(AC, 'vendorPercent');
    await bool(AC, 'delistRequested');

    await collection(TX, 'Vendor Transactions');
    await str(TX, 'accountId', 64, true); await str(TX, 'vendorId', 64, true); await str(TX, 'userId', 64, true); await str(TX, 'referenceNumber', 64, true);
    await int(TX, 'amountPaise', true); await int(TX, 'approvedAmountPaise');
    await strs(TX, [['ownerSubadminId', 64], ['requestedBy', 64], ['payerName', 120], ['paidAt', 40], ['remarks', 500], ['status', 20],
        ['reviewedBy', 64], ['reviewedAt', 40], ['reviewNotes', 500], ['rejectReason', 300], ['approvedAt', 40], ['reversedAt', 40], ['createdAt', 40]]);

    await collection(WD, 'Vendor Withdrawals');
    await str(WD, 'accountId', 64, true); await str(WD, 'vendorId', 64, true); await str(WD, 'userId', 64, true);
    for (const k of ['amountPaise', 'adminFeePaise', 'vendorFeePaise', 'totalPaise']) await int(WD, k, true);
    await dbl(WD, 'adminPercent'); await dbl(WD, 'vendorPercent');
    await strs(WD, [['ownerSubadminId', 64], ['mode', 10], ['holderName', 120], ['payeeAccountNumber', 64], ['ifscCode', 20], ['upiId', 100], ['status', 20],
        ['utr', 64], ['paidAt', 40], ['confirmedAt', 40], ['completedAt', 40], ['disputeReason', 300], ['rejectReason', 300],
        ['resolveReason', 300], ['resolvedBy', 64], ['createdAt', 40]]);

    await collection(CM, 'Vendor Commissions');
    await str(CM, 'withdrawalId', 64, true); await str(CM, 'accountId', 64, true); await str(CM, 'vendorId', 64, true); await str(CM, 'earner', 10, true);
    await int(CM, 'amountPaise', true); await str(CM, 'createdAt', 40);

    await collection(EA, 'Vendor Earnings');
    await str(EA, 'accountId', 64, true); await str(EA, 'vendorId', 64, true); await str(EA, 'type', 10, true); await str(EA, 'period', 10, true);
    await int(EA, 'amountPaise', true);
    await strs(EA, [['utr', 64], ['notes', 300], ['paidBy', 64], ['paidAt', 40]]);

    await collection(AU, 'Vendor Audit');
    await strs(AU, [['entityType', 20], ['entityId', 64], ['action', 40], ['actorId', 64], ['reason', 500], ['createdAt', 40]]);

    await collection(DY, 'Daily Vendor Summaries');
    await str(DY, 'date', 30, true); await str(DY, 'totalsJson', 999999);

    // users_meta.role: a string attribute takes 'vendor' as-is; an enum must list it.
    try {
        const attr = await db.getAttribute(DB, APPWRITE_USERS_META_COLLECTION_ID, 'role');
        if (Array.isArray(attr?.elements)) {
            if (attr.elements.includes('vendor')) console.log('  ↩︎  users_meta.role already allows vendor');
            else await safe("add 'vendor' to users_meta.role", () => db.updateEnumAttribute(DB, APPWRITE_USERS_META_COLLECTION_ID, 'role', [...attr.elements, 'vendor'], attr.required, attr.required ? null : attr.default ?? null));
        } else console.log('  ↩︎  users_meta.role is a plain string — nothing to change');
    } catch (e) { console.warn(`  ⚠️  could not inspect users_meta.role (${e?.message || e}) — if it is an enum, add 'vendor' in the console before creating vendors`); }

    console.log('\n  …waiting for attributes to become available');
    await sleep(4000);

    await idx(RC, 'idx_accountType', 'unique', ['accountType']);
    await idx(AC, 'idx_vendorId', 'key', ['vendorId']);
    await idx(AC, 'idx_accountNumber', 'key', ['accountNumber']);   // uniqueness is app-level: a rejected/delisted number may be re-listed
    await idx(AC, 'idx_state', 'key', ['state']);
    await idx(AC, 'idx_assignedUserId', 'key', ['assignedUserId']);
    await idx(AC, 'idx_managedByUserId', 'key', ['managedByUserId']);
    await idx(AC, 'idx_createdAt', 'key', ['createdAt']);
    for (const col of [TX, WD]) {
        for (const k of ['accountId', 'vendorId', 'userId', 'ownerSubadminId', 'status', 'createdAt']) await idx(col, `idx_${k}`, 'key', [k]);
    }
    await idx(TX, 'idx_referenceNumber', 'key', ['referenceNumber']);
    await idx(CM, 'idx_withdrawal_earner', 'unique', ['withdrawalId', 'earner']);
    await idx(CM, 'idx_vendorId', 'key', ['vendorId']);
    await idx(EA, 'idx_account_period', 'unique', ['accountId', 'period']);
    await idx(EA, 'idx_vendorId', 'key', ['vendorId']);
    await idx(AU, 'idx_entityId', 'key', ['entityId']);
    await idx(DY, 'idx_date', 'unique', ['date']);

    console.log('\n✅ Vendor schema setup complete.\n');
    console.log('Optional .env overrides (the defaults below are what server.js uses):');
    for (const [k, v] of [['APPWRITE_VENDOR_RATE_CARDS_COLLECTION_ID', RC], ['APPWRITE_VENDOR_ACCOUNTS_COLLECTION_ID', AC], ['APPWRITE_VENDOR_TRANSACTIONS_COLLECTION_ID', TX],
        ['APPWRITE_VENDOR_WITHDRAWALS_COLLECTION_ID', WD], ['APPWRITE_VENDOR_COMMISSIONS_COLLECTION_ID', CM], ['APPWRITE_VENDOR_EARNINGS_COLLECTION_ID', EA],
        ['APPWRITE_VENDOR_AUDIT_COLLECTION_ID', AU], ['APPWRITE_DAILY_VENDOR_SUMMARIES_COLLECTION_ID', DY]]) console.log(`  ${k}=${v}`);
    console.log('\nNext: deploy, set the rate card, then create vendor logins (create-user with role "vendor").\n');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
