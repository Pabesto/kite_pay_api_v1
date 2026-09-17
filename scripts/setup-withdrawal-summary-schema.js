// setup-withdrawal-summary-schema.js — creates `daily_withdrawal_summaries`, the day-wise
// withdrawal REPORT rollup behind GET /api/admin/withdrawal-summary (withdrawalSummary.js).
// Mirrors daily_qr_summaries / daily_payout_summaries: one doc per IST day,
//   { date, totalsJson: { [qrId]: { direct: { paidPaise, commissionPaise, count }, wallet: {…} } } }
//
// Idempotent: 409 (already exists) is a skip. Attributes provision asynchronously in Appwrite, so
// the index is created after a fixed sleep (same mitigation as the other setup scripts).
//
// Deploy order: run this, deploy, then `node scripts/backfill-withdrawal-daily-summaries.js --write`
// so history before the deploy shows up in the report.
//
//   node scripts/setup-withdrawal-summary-schema.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID = 'daily_withdrawal_summaries',
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID })) {
    if (!v) { console.error(`❌ Missing required env var ${k} — check the .env at the project root.`); process.exit(1); }
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID, COL = APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safe(label, fn) {
    try { await fn(); console.log(`  ✅ ${label}`); }
    catch (e) {
        if (e?.code === 409) console.log(`  ↩︎  ${label} — already exists, skipped`);
        else { console.error(`  ❌ ${label}:`, e?.message || e); throw e; }
    }
}

async function main() {
    console.log(`${COL}:`);
    await safe(`create collection "${COL}"`, () => db.createCollection(DB, COL, 'Daily Withdrawal Summaries', undefined, true, true));
    await safe('attr date (string 30, required)', () => db.createStringAttribute(DB, COL, 'date', 30, true));
    await safe('attr totalsJson (string 999999)', () => db.createStringAttribute(DB, COL, 'totalsJson', 999999, false));
    await sleep(4000);
    await safe('index idx_date (unique ["date"])', () => db.createIndex(DB, COL, 'idx_date', 'unique', ['date']));
    console.log('\nDone. Next: node scripts/backfill-withdrawal-daily-summaries.js --write');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
