// setup-partner-schema.js — one-off, idempotent schema setup for the partner-transactions feature.
//
// Creates:
//   1. The `api_partners` collection (partner API keys linked to a subadmin userId).
//   2. An `ownerSubadminId` string attribute + index on the transactions (webhook data)
//      collection, used to serve a partner's transactions with one indexed query.
//
// Safe to run multiple times — every create is wrapped so an "already exists" (409) is skipped.
//
// Usage (from project root so .env is loaded):
//   node scripts/setup-partner-schema.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Databases } = require('node-appwrite');

const {
    APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID,
    APPWRITE_API_KEY,
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
    APPWRITE_API_PARTNERS_COLLECTION_ID = 'api_partners',
} = process.env;

if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID || !APPWRITE_WEBHOOK_DATA_COLLECTION_ID) {
    console.error('❌ Missing required env vars (APPWRITE_ENDPOINT/PROJECT_ID/API_KEY/DATABASE_ID/WEBHOOK_DATA_COLLECTION_ID).');
    process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);

const DB = APPWRITE_DATABASE_ID;
const PARTNERS = APPWRITE_API_PARTNERS_COLLECTION_ID;
const TXNS = APPWRITE_WEBHOOK_DATA_COLLECTION_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run an Appwrite create op, tolerating "already exists" (409).
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
    console.log(`\nSetting up partner schema in database ${DB}\n`);

    // 1. api_partners collection
    console.log('api_partners collection:');
    await safe(`create collection "${PARTNERS}"`, () =>
        db.createCollection(DB, PARTNERS, 'API Partners', undefined, true, true));

    await safe('attr partnerId (string, required)', () => db.createStringAttribute(DB, PARTNERS, 'partnerId', 64, true));
    await safe('attr apiKeyHash (string, required)', () => db.createStringAttribute(DB, PARTNERS, 'apiKeyHash', 255, true));
    await safe('attr userId (string, required)', () => db.createStringAttribute(DB, PARTNERS, 'userId', 64, true));
    await safe('attr name (string)', () => db.createStringAttribute(DB, PARTNERS, 'name', 255, false));
    await safe('attr status (boolean, default true)', () => db.createBooleanAttribute(DB, PARTNERS, 'status', false, true));

    // Attributes must finish provisioning before an index can reference them.
    console.log('  …waiting for attributes to become available');
    await sleep(3000);

    await safe('index partnerId (unique)', () => db.createIndex(DB, PARTNERS, 'idx_partnerId', 'unique', ['partnerId']));
    await safe('index userId (key)', () => db.createIndex(DB, PARTNERS, 'idx_userId', 'key', ['userId']));

    // 2. ownerSubadminId on the transactions collection (one owner per txn)
    console.log('\ntransactions (webhook data) collection:');
    await safe('attr ownerSubadminId (string)', () =>
        db.createStringAttribute(DB, TXNS, 'ownerSubadminId', 64, false));

    console.log('  …waiting for attribute to become available');
    await sleep(3000);

    await safe('index ownerSubadminId (key)', () =>
        db.createIndex(DB, TXNS, 'idx_ownerSubadminId', 'key', ['ownerSubadminId']));

    console.log('\n✅ Partner schema setup complete.\n');
    console.log(`Reminder: ensure APPWRITE_API_PARTNERS_COLLECTION_ID=${PARTNERS} is set in .env`);
    console.log('Next: run  node scripts/backfill-owner.js --write  to stamp existing transactions.\n');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
