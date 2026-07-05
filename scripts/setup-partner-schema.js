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
    APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID = 'partner_webhook_deliveries',
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
const DELIVERIES = APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID;

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
    // Outbound webhook config
    await safe('attr webhookUrl (string)', () => db.createStringAttribute(DB, PARTNERS, 'webhookUrl', 2048, false));
    await safe('attr webhookSecret (string)', () => db.createStringAttribute(DB, PARTNERS, 'webhookSecret', 128, false));
    await safe('attr webhookEnabled (boolean, default false)', () => db.createBooleanAttribute(DB, PARTNERS, 'webhookEnabled', false, false));

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

    // 3. partner_webhook_deliveries collection (outbound webhook queue + log)
    console.log('\npartner_webhook_deliveries collection:');
    await safe(`create collection "${DELIVERIES}"`, () =>
        db.createCollection(DB, DELIVERIES, 'Partner Webhook Deliveries', undefined, true, true));

    await safe('attr deliveryId (string, required)', () => db.createStringAttribute(DB, DELIVERIES, 'deliveryId', 64, true));
    await safe('attr partnerId (string, required)', () => db.createStringAttribute(DB, DELIVERIES, 'partnerId', 64, true));
    await safe('attr eventType (string)', () => db.createStringAttribute(DB, DELIVERIES, 'eventType', 32, false));
    await safe('attr txnId (string)', () => db.createStringAttribute(DB, DELIVERIES, 'txnId', 64, false));
    await safe('attr url (string)', () => db.createStringAttribute(DB, DELIVERIES, 'url', 2048, false));
    await safe('attr payloadJson (string, large)', () => db.createStringAttribute(DB, DELIVERIES, 'payloadJson', 100000, false));
    await safe('attr status (string)', () => db.createStringAttribute(DB, DELIVERIES, 'status', 16, false));
    await safe('attr attempts (integer)', () => db.createIntegerAttribute(DB, DELIVERIES, 'attempts', false));
    await safe('attr maxAttempts (integer)', () => db.createIntegerAttribute(DB, DELIVERIES, 'maxAttempts', false));
    await safe('attr nextAttemptAt (string)', () => db.createStringAttribute(DB, DELIVERIES, 'nextAttemptAt', 40, false));
    await safe('attr lastAttemptAt (string)', () => db.createStringAttribute(DB, DELIVERIES, 'lastAttemptAt', 40, false));
    await safe('attr responseCode (integer)', () => db.createIntegerAttribute(DB, DELIVERIES, 'responseCode', false));
    await safe('attr error (string)', () => db.createStringAttribute(DB, DELIVERIES, 'error', 2048, false));
    await safe('attr createdAt (string)', () => db.createStringAttribute(DB, DELIVERIES, 'createdAt', 40, false));

    console.log('  …waiting for attributes to become available');
    await sleep(4000);

    await safe('index deliveryId (unique)', () => db.createIndex(DB, DELIVERIES, 'idx_deliveryId', 'unique', ['deliveryId']));
    await safe('index partnerId (key)', () => db.createIndex(DB, DELIVERIES, 'idx_partnerId', 'key', ['partnerId']));
    // Worker query: status + nextAttemptAt (find due deliveries, oldest first).
    await safe('index status+nextAttemptAt (key)', () =>
        db.createIndex(DB, DELIVERIES, 'idx_status_next', 'key', ['status', 'nextAttemptAt']));

    console.log('\n✅ Partner schema setup complete.\n');
    console.log('Reminder: ensure these are set in .env:');
    console.log(`  APPWRITE_API_PARTNERS_COLLECTION_ID=${PARTNERS}`);
    console.log(`  APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID=${DELIVERIES}`);
    console.log('Next: run  node scripts/backfill-owner.js --write  to stamp existing transactions.\n');
}

main().catch((e) => { console.error('\nSetup failed:', e?.message || e); process.exit(1); });
