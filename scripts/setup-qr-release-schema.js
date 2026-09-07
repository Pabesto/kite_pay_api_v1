// setup-qr-release-schema.js — one-off, idempotent schema for T+0 early release of QR pay-ins.
//
// Creates the `qr_daily_releases` collection: one row per (qrId, IST day) recording how much of that
// day's pay-in an admin released early. A release is a GATE, never money — it changes what may be
// withdrawn, never a stored balance — so this collection holds no ledger and no totals.
//
// Safe to run multiple times: every create tolerates an "already exists" (409).
//
// Usage (from the project root so .env is loaded):
//   node scripts/setup-qr-release-schema.js
//
// After running, set the ceiling in the config collection (admin-tunable at runtime):
//   qr_daily_release_max_percent = 50      type: integer
// NOTE: here 0 means NOTHING may be released (a kill switch), and 100 means all of a day's pay-in.
// This is deliberately unlike the payout limits, where 0 means "no limit".

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Databases } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID = 'qr_daily_releases',
} = process.env;

if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID) {
    console.error('❌ Missing required env vars (APPWRITE_ENDPOINT/PROJECT_ID/API_KEY/DATABASE_ID).');
    process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const DB = APPWRITE_DATABASE_ID;
const COL = APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safe(label, fn) {
    try { await fn(); console.log(`  ✅ ${label}`); }
    catch (e) {
        if (e?.code === 409) console.log(`  ↩︎  ${label} — already exists, skipped`);
        else { console.error(`  ❌ ${label}:`, e?.message || e); throw e; }
    }
}

async function main() {
    console.log(`\nSetting up the QR early-release schema in database ${DB}\n`);
    console.log(`${COL}:`);
    await safe(`create collection "${COL}"`, () => db.createCollection(DB, COL, 'QR Daily Releases', undefined, true, true));

    await safe('attr qrId (string, required)', () => db.createStringAttribute(DB, COL, 'qrId', 128, true));
    await safe('attr date (string, required)', () => db.createStringAttribute(DB, COL, 'date', 10, true));   // IST day, YYYY-MM-DD
    await safe('attr releasedPaise (integer, required)', () => db.createIntegerAttribute(DB, COL, 'releasedPaise', true));
    await safe('attr todayPayInAtSetPaise (integer)', () => db.createIntegerAttribute(DB, COL, 'todayPayInAtSetPaise', false));
    await safe('attr maxPercentAtSet (double)', () => db.createFloatAttribute(DB, COL, 'maxPercentAtSet', false));
    await safe('attr percentAtSet (double)', () => db.createFloatAttribute(DB, COL, 'percentAtSet', false));   // null when set by exact amount
    await safe('attr reason (string)', () => db.createStringAttribute(DB, COL, 'reason', 300, false));
    await safe('attr changeCount (integer)', () => db.createIntegerAttribute(DB, COL, 'changeCount', false));
    await safe('attr historyJson (string)', () => db.createStringAttribute(DB, COL, 'historyJson', 20000, false));   // last 20 changes, newest first
    await safe('attr releasedBy (string)', () => db.createStringAttribute(DB, COL, 'releasedBy', 64, false));
    await safe('attr createdAt (string)', () => db.createStringAttribute(DB, COL, 'createdAt', 40, false));
    await safe('attr updatedAt (string)', () => db.createStringAttribute(DB, COL, 'updatedAt', 40, false));

    console.log('  …waiting for attributes to become available');
    await sleep(4000);

    // One release row per QR per day. The unique index is what makes "set" idempotent under a race.
    await safe('index qrId+date (unique)', () => db.createIndex(DB, COL, 'idx_qr_date', 'unique', ['qrId', 'date']));
    await safe('index date (key)', () => db.createIndex(DB, COL, 'idx_date', 'key', ['date']));
    await safe('index qrId (key)', () => db.createIndex(DB, COL, 'idx_qrId', 'key', ['qrId']));

    console.log('\n✅ QR early-release schema setup complete.\n');
    console.log('Optional .env override (the default below is what server.js uses):');
    console.log(`  APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID=${COL}`);
    console.log('\nNext: add the config key `qr_daily_release_max_percent` (type integer) and set it to 50.');
    console.log('Until that key exists the server uses its built-in default of 50%.\n');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
