// setup-early-release-commission-schema.js — one-off, idempotent schema for the EARLY-RELEASE FEE
// (withdraw.js earlyFeeFor): a third commission, separate from the payin and payout ones, charged only
// on the slice of a withdrawal that an admin's T+0 release made withdrawable.
//
// Adds:
//   users_meta.earlyReleaseCommission (double, %)              per-user rate; null = config default
//   withdrawal_requests: earlyReleaseCommission (double, Rs), earlyReleasePortionPaise (int),
//                        earlyUserRate (double), earlyParentRate (double)      request-time snapshot
//   commission_transactions.commissionType (string)            'early_release' on the fee rows
//   qr_daily_releases.chargeCommission / bankac_daily_releases.chargeCommission (boolean)   admin's per-release switch
//   daily_early_release_commissions   { date, commissionsJson }        (unique date)
//   monthly_early_release_totals    { userId, month, totalCommissionPaise } (unique userId+month)
//   all_time_early_release_totals   { userId, totalCommissionPaise }        (unique userId)
//
// Safe to run multiple times (409 = skip). Attributes provision asynchronously, so indexes are created
// after a fixed sleep, like every other setup script.
//
//   node scripts/setup-early-release-commission-schema.js
//
// Deploy order: run this BEFORE deploying, then set the config keys (admin panel → payout settings):
//   default_early_release_commission = <percent>   (0 = fee off; the default until you set it)
//   bank_account_insta_credit        = true|false  (true = bank pay-ins withdrawable at once, no T+1)
// Rollups start empty and fill from the first fee charged after the deploy — no backfill needed.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID,
    APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID = 'qr_daily_releases',
    APPWRITE_BANKAC_DAILY_RELEASES_COLLECTION_ID = 'bankac_daily_releases',
    APPWRITE_DAILY_EARLY_RELEASE_COMMISSION_SUMMARIES_COLLECTION_ID = 'daily_early_release_commissions',
    APPWRITE_MONTHLY_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID = 'monthly_early_release_totals',
    APPWRITE_ALL_TIME_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID = 'all_time_early_release_totals',
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID })) {
    if (!v) { console.error(`❌ Missing required env var ${k} — check the .env at the project root.`); process.exit(1); }
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID;
const DAILY = APPWRITE_DAILY_EARLY_RELEASE_COMMISSION_SUMMARIES_COLLECTION_ID, MONTHLY = APPWRITE_MONTHLY_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID, ALLTIME = APPWRITE_ALL_TIME_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID;
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
const dbl = (col, key) => safe(`attr ${key} (double)`, () => db.createFloatAttribute(DB, col, key, false));
const bool = (col, key) => safe(`attr ${key} (boolean)`, () => db.createBooleanAttribute(DB, col, key, false));
const idx = (col, key, type, cols) => safe(`index ${key} (${type} [${cols.join(', ')}])`, () => db.createIndex(DB, col, key, type, cols));

async function main() {
    console.log(`\nSetting up the early-release commission schema in database ${DB}\n`);

    console.log(`${APPWRITE_USERS_META_COLLECTION_ID}:`);
    await dbl(APPWRITE_USERS_META_COLLECTION_ID, 'earlyReleaseCommission');

    console.log(`\n${APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID}:`);
    await dbl(APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, 'earlyReleaseCommission');
    await int(APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, 'earlyReleasePortionPaise');
    await dbl(APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, 'earlyUserRate');
    await dbl(APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, 'earlyParentRate');

    console.log(`\n${APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID}:`);
    await str(APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, 'commissionType', 30);

    for (const col of [APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID, APPWRITE_BANKAC_DAILY_RELEASES_COLLECTION_ID]) {
        console.log(`\n${col}:`);
        await bool(col, 'chargeCommission').catch((e) => console.warn(`  ⚠️  ${col}: ${e?.message || e} (skip if this collection does not exist yet)`));
    }

    console.log(`\n${DAILY}:`);
    await safe(`create collection "${DAILY}"`, () => db.createCollection(DB, DAILY, 'Daily Early Release Commission Summaries', undefined, true, true));
    await str(DAILY, 'date', 30, true); await str(DAILY, 'commissionsJson', 999999);

    console.log(`\n${MONTHLY}:`);
    await safe(`create collection "${MONTHLY}"`, () => db.createCollection(DB, MONTHLY, 'Monthly Early Release Commission Totals', undefined, true, true));
    await str(MONTHLY, 'userId', 64, true); await str(MONTHLY, 'month', 10, true); await int(MONTHLY, 'totalCommissionPaise', true);

    console.log(`\n${ALLTIME}:`);
    await safe(`create collection "${ALLTIME}"`, () => db.createCollection(DB, ALLTIME, 'All Time Early Release Commission Totals', undefined, true, true));
    await str(ALLTIME, 'userId', 64, true); await int(ALLTIME, 'totalCommissionPaise', true);

    console.log('\n  …waiting for attributes to become available');
    await sleep(4000);

    await idx(DAILY, 'idx_date', 'unique', ['date']);
    await idx(MONTHLY, 'idx_user_month', 'unique', ['userId', 'month']);
    await idx(MONTHLY, 'idx_userId', 'key', ['userId']);
    await idx(ALLTIME, 'idx_userId', 'unique', ['userId']);
    await idx(APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, 'idx_commissionType', 'key', ['commissionType']).catch(() => {});

    console.log('\n✅ Early-release commission schema setup complete.\n');
    console.log('Optional .env overrides (the defaults below are what server.js uses):');
    for (const [k, v] of [['APPWRITE_DAILY_EARLY_RELEASE_COMMISSION_SUMMARIES_COLLECTION_ID', DAILY], ['APPWRITE_MONTHLY_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID', MONTHLY], ['APPWRITE_ALL_TIME_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID', ALLTIME]]) console.log(`  ${k}=${v}`);
    console.log('\nNext: deploy, then set default_early_release_commission (%) and bank_account_insta_credit via PATCH /api/payout/admin/settings.\n');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
