// setup-uat-webhook-schema.js — creates the `uat_webhook_data` collection that backs
// POST /uat/razorpay-webhook (Razorpay Notification API v4.0 UAT receiver).
//
//   node scripts/setup-uat-webhook-schema.js            # dry run
//   node scripts/setup-uat-webhook-schema.js --write    # create it
//
// Idempotent — every create tolerates "already exists", so re-running is a clean no-op.
//
// This collection is a CAPTURE LOG, not a money path. Nothing here feeds QR ledgers, daily
// summaries, counters, or partner webhooks. Column sizes must stay in sync with the CAPS
// map in uatWebhook.js (the route truncates to these before writing).
//
// idx_txnId is a KEY index, NOT unique: a duplicate retry must never make Appwrite throw
// and turn a UAT post into a 500. Dedup is a best-effort lookup in the route.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, TablesDB, Query } = require('node-appwrite');

const ENDPOINT    = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID  = process.env.APPWRITE_PROJECT_ID;
const API_KEY     = process.env.APPWRITE_API_KEY;
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID    = process.env.APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID || 'uat_webhook_data';

const WRITE = process.argv.includes('--write');

for (const [name, val] of Object.entries({ APPWRITE_ENDPOINT: ENDPOINT, APPWRITE_PROJECT_ID: PROJECT_ID, APPWRITE_API_KEY: API_KEY, APPWRITE_DATABASE_ID: DATABASE_ID })) {
  if (!val) {
    console.error(`Missing required env var ${name} — check the .env at the project root.`);
    process.exit(1);
  }
}

const COLUMNS = [
  { key: 'payload',           kind: 'string',  size: 1000000, required: false, note: 'full raw notification JSON — source of truth' },
  { key: 'txnId',             kind: 'string',  size: 64,  required: false, note: 'Razorpay unique txn id (§5.3) — dedup key' },
  { key: 'qrCodeId',          kind: 'string',  size: 64,  required: false, note: 'tid, or username when tid is absent (UPI/BharatQR)' },
  { key: 'rrnNumber',         kind: 'string',  size: 64,  required: false, note: 'rrNumber from the notification' },
  { key: 'paymentMode',       kind: 'string',  size: 16,  required: false, note: 'UPI | BHARATQR | CARD | …' },
  { key: 'providerStatus',    kind: 'string',  size: 24,  required: false, note: "Razorpay's status — NOT the money-status enum" },
  { key: 'txnType',           kind: 'string',  size: 16,  required: false, note: 'CHARGE | REFUND | REMOTE_PAY | …' },
  { key: 'settlementStatus',  kind: 'string',  size: 16,  required: false, note: 'PENDING | SETTLED | POSTED' },
  { key: 'currencyCode',      kind: 'string',  size: 8,   required: false, note: 'ISO 4217, expected INR' },
  { key: 'amountPaise',       kind: 'integer',            required: false, note: 'rupees→paise, converted once at the boundary' },
  { key: 'amountRupeesRaw',   kind: 'string',  size: 32,  required: false, note: 'amount exactly as Razorpay sent it' },
  { key: 'vpa',               kind: 'string',  size: 255, required: false, note: 'payerName, else customerName' },
  { key: 'externalRefNumber', kind: 'string',  size: 64,  required: false, note: 'merchant reference (§5.3)' },
  { key: 'merchantCode',      kind: 'string',  size: 64,  required: false, note: 'merchantCode, else orgCode' },
  { key: 'username',          kind: 'string',  size: 32,  required: false, note: "merchant user / terminal login" },
  { key: 'postingDate',       kind: 'string',  size: 40,  required: false, note: 'UTC ISO, parsed from epoch ms' },
  { key: 'created_at',        kind: 'string',  size: 40,  required: false, note: 'UTC ISO — when WE received it' },
  { key: 'warningsJson',      kind: 'string',  size: 4096, required: false, note: 'JSON array of mapping warnings' },
  { key: 'sourceIp',          kind: 'string',  size: 64,  required: false, note: 'req.ip of the poster' },
];

const INDEXES = [
  { key: 'idx_txnId',      type: 'key', columns: ['txnId'] },       // dedup lookup — key, never unique
  { key: 'idx_created_at', type: 'key', columns: ['created_at'] },  // list ordering
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlreadyExists = (e) => e && (e.code === 409 || String(e.message || '').toLowerCase().includes('already exists'));
const describeErr = (e) => [e?.code && `code=${e.code}`, e?.message].filter(Boolean).join(' | ');

async function waitForColumns(db, keys, { timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cols = (await db.listColumns({ databaseId: DATABASE_ID, tableId: TABLE_ID, queries: [Query.limit(100)] })).columns || [];
    const broken = cols.filter((c) => c.status === 'failed' || c.status === 'stuck');
    if (broken.length) throw new Error(`columns failed: ${broken.map((c) => `${c.key}(${c.status})`).join(', ')}`);
    const ready = new Set(cols.filter((c) => c.status === 'available').map((c) => c.key));
    if (keys.every((k) => ready.has(k))) return;
    await sleep(1000);
  }
  throw new Error('timed out waiting for columns to become available');
}

(async () => {
  const db = new TablesDB(new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY));

  console.log('Razorpay UAT webhook capture collection setup');
  console.log(WRITE ? '\nMODE: WRITE' : '\nMODE: DRY RUN — nothing will be written. Re-run with --write to apply.');
  console.log(`  endpoint=${ENDPOINT}  project=${PROJECT_ID}  db=${DATABASE_ID}`);
  console.log(`  table=${TABLE_ID}\n`);

  console.log(`Table "${TABLE_ID}" — permissions=[] rowSecurity=false (server API key only)`);
  for (const c of COLUMNS) {
    console.log(`  column ${c.key.padEnd(18)} ${c.kind}${c.size ? `(${c.size})` : ''}  — ${c.note}`);
  }
  for (const i of INDEXES) console.log(`  index  ${i.key.padEnd(18)} ${i.type} on [${i.columns.join(', ')}]`);

  if (!WRITE) {
    console.log('\nDry run complete. Re-run with --write to apply.');
    return;
  }

  console.log('\n--- creating ---');
  try {
    await db.createTable({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      name: 'UAT Webhook Data',
      permissions: [],       // server API key only — captures echo whatever Razorpay posts
      rowSecurity: false,
      enabled: true,
    });
    console.log(`  [OK]   table ${TABLE_ID}`);
  } catch (e) {
    if (isAlreadyExists(e)) console.log(`  [SKIP] table ${TABLE_ID} already exists`);
    else throw e;
  }

  for (const c of COLUMNS) {
    try {
      if (c.kind === 'integer') {
        await db.createIntegerColumn({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: c.key, required: !!c.required });
      } else {
        await db.createStringColumn({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: c.key, size: c.size, required: !!c.required });
      }
      console.log(`  [OK]   column ${c.key}`);
    } catch (e) {
      if (isAlreadyExists(e)) console.log(`  [SKIP] column ${c.key} already exists`);
      else console.error(`  [ERR]  column ${c.key}: ${describeErr(e)}`);
    }
  }

  // Indexes cannot be built over attributes that are still provisioning.
  await waitForColumns(db, INDEXES.flatMap((i) => i.columns));

  for (const i of INDEXES) {
    try {
      await db.createIndex({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: i.key, type: i.type, columns: i.columns });
      console.log(`  [OK]   index ${i.key}`);
    } catch (e) {
      if (isAlreadyExists(e)) console.log(`  [SKIP] index ${i.key} already exists`);
      else console.error(`  [ERR]  index ${i.key}: ${describeErr(e)}`);
    }
  }

  console.log('\nDone. Next steps:');
  console.log(`  1. Set APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID=${TABLE_ID} in .env (and on Render).`);
  console.log('  2. Set UAT_WEBHOOK_TOKEN in .env — generate with:  openssl rand -hex 32');
  console.log('     (without it the endpoint fails closed with 503 on every request)');
  console.log('  3. Give Razorpay:  POST https://<host>/uat/razorpay-webhook');
  console.log('     with header      Authorization: Bearer <UAT_WEBHOOK_TOKEN>');
  console.log('  4. Read captures back at  GET /uat/razorpay-webhook/captures  (admin auth).');
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
