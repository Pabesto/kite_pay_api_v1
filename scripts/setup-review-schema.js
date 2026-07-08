// setup-review-schema.js — one-off, idempotent schema setup for the manual-review feature.
//
// Adds the review lifecycle attributes to the transactions (webhook data) collection:
//   reviewStatus, reviewExpiresAt, reviewMode, reviewedBy, reviewedAt
// plus an index the sweeper / pending-review queries use (reviewStatus, reviewExpiresAt).
//
// The `deleted` boolean already exists and is reused (pending & rejected = true).
//
// AUTO-mode ingest never writes these fields, so running this is only a prerequisite
// for turning MANUAL mode ON. Still — run it before deploying the gate.
//
// Safe to run multiple times — every create tolerates "already exists" (409).
//
// Usage (from project root so .env is loaded):
//   node scripts/setup-review-schema.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Databases } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID,
    APPWRITE_API_KEY,
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
    APPWRITE_REJECTED_TRANSACTIONS_COLLECTION_ID = 'rejected_transactions',
    APPWRITE_DAILY_REJECTED_SUMMARY_COLLECTION_ID = 'daily_rejected_summary',
} = process.env;

if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID || !APPWRITE_WEBHOOK_DATA_COLLECTION_ID) {
    console.error('❌ Missing required env vars (APPWRITE_ENDPOINT/PROJECT_ID/API_KEY/DATABASE_ID/WEBHOOK_DATA_COLLECTION_ID).');
    process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);

const DB = APPWRITE_DATABASE_ID;
const TXNS = APPWRITE_WEBHOOK_DATA_COLLECTION_ID;
const REJECTED = APPWRITE_REJECTED_TRANSACTIONS_COLLECTION_ID;
const DAILY_REJECTED = APPWRITE_DAILY_REJECTED_SUMMARY_COLLECTION_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safe(label, fn) {
    try {
        await fn();
        console.log(`  ✅ ${label}`);
    } catch (e) {
        if (e?.code === 409) console.log(`  ↩︎  ${label} — already exists, skipped`);
        else { console.error(`  ❌ ${label}:`, e?.message || e); throw e; }
    }
}

async function main() {
    console.log(`\nSetting up review schema on transactions collection "${TXNS}" in database ${DB}\n`);

    // Review lifecycle attributes (all optional — AUTO docs simply omit them).
    await safe('attr reviewStatus (string 16)',    () => db.createStringAttribute(DB, TXNS, 'reviewStatus', 16, false));
    await safe('attr reviewExpiresAt (string 40)', () => db.createStringAttribute(DB, TXNS, 'reviewExpiresAt', 40, false));
    await safe('attr reviewMode (string 16)',      () => db.createStringAttribute(DB, TXNS, 'reviewMode', 16, false));
    await safe('attr reviewedBy (string 64)',      () => db.createStringAttribute(DB, TXNS, 'reviewedBy', 64, false));
    await safe('attr reviewedAt (string 40)',      () => db.createStringAttribute(DB, TXNS, 'reviewedAt', 40, false));

    console.log('  …waiting for attributes to become available');
    await sleep(4000);

    // Sweeper + pending-review list query: reviewStatus (+ reviewExpiresAt for the timeout scan).
    await safe('index reviewStatus+reviewExpiresAt (key)', () =>
        db.createIndex(DB, TXNS, 'idx_review_status_expires', 'key', ['reviewStatus', 'reviewExpiresAt']));

    // rejected_transactions — detailed per-rejection log.
    console.log('\nrejected_transactions collection:');
    await safe(`create collection "${REJECTED}"`, () =>
        db.createCollection(DB, REJECTED, 'Rejected Transactions', undefined, true, true));

    await safe('attr txnId (string 64)',            () => db.createStringAttribute(DB, REJECTED, 'txnId', 64, false));
    await safe('attr qrId (string 64)',             () => db.createStringAttribute(DB, REJECTED, 'qrId', 64, false));
    await safe('attr paymentId (string 128)',       () => db.createStringAttribute(DB, REJECTED, 'paymentId', 128, false));
    await safe('attr amount (integer)',             () => db.createIntegerAttribute(DB, REJECTED, 'amount', false));
    await safe('attr provider (string 16)',         () => db.createStringAttribute(DB, REJECTED, 'provider', 16, false));
    await safe('attr vpa (string 255)',             () => db.createStringAttribute(DB, REJECTED, 'vpa', 255, false));
    await safe('attr rrnNumber (string 64)',        () => db.createStringAttribute(DB, REJECTED, 'rrnNumber', 64, false));
    await safe('attr ownerSubadminId (string 64)',  () => db.createStringAttribute(DB, REJECTED, 'ownerSubadminId', 64, false));
    await safe('attr originalCreatedAt (string 40)',() => db.createStringAttribute(DB, REJECTED, 'originalCreatedAt', 40, false));
    await safe('attr rejectedAt (string 40)',       () => db.createStringAttribute(DB, REJECTED, 'rejectedAt', 40, false));
    await safe('attr adminId (string 64)',          () => db.createStringAttribute(DB, REJECTED, 'adminId', 64, false));
    await safe('attr adminName (string 255)',       () => db.createStringAttribute(DB, REJECTED, 'adminName', 255, false));
    await safe('attr reason (string 1024)',         () => db.createStringAttribute(DB, REJECTED, 'reason', 1024, false));

    console.log('  …waiting for attributes to become available');
    await sleep(4000);

    await safe('index qrId (key)',     () => db.createIndex(DB, REJECTED, 'idx_qrId', 'key', ['qrId']));
    await safe('index provider (key)', () => db.createIndex(DB, REJECTED, 'idx_provider', 'key', ['provider']));
    await safe('index rejectedAt (key)', () => db.createIndex(DB, REJECTED, 'idx_rejectedAt', 'key', ['rejectedAt']));

    // daily_rejected_summary — date × QR rollup (same shape as daily_deleted_summary).
    console.log('\ndaily_rejected_summary collection:');
    await safe(`create collection "${DAILY_REJECTED}"`, () =>
        db.createCollection(DB, DAILY_REJECTED, 'Daily Rejected Summary', undefined, true, true));

    await safe('attr date (string 16)',          () => db.createStringAttribute(DB, DAILY_REJECTED, 'date', 16, true));
    await safe('attr totalsJson (string large)', () => db.createStringAttribute(DB, DAILY_REJECTED, 'totalsJson', 1000000, false));

    console.log('  …waiting for attributes to become available');
    await sleep(3000);

    await safe('index date (key)', () => db.createIndex(DB, DAILY_REJECTED, 'idx_date', 'key', ['date']));

    console.log('\n✅ Review schema setup complete.');
    console.log('   AUTO ingest is unaffected; you can now enable MANUAL mode safely.');
    console.log('   Reminder — if you use non-default collection IDs, set these in .env:');
    console.log(`     APPWRITE_REJECTED_TRANSACTIONS_COLLECTION_ID=${REJECTED}`);
    console.log(`     APPWRITE_DAILY_REJECTED_SUMMARY_COLLECTION_ID=${DAILY_REJECTED}\n`);
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
