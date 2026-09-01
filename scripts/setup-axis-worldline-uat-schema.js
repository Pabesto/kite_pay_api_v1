// setup-axis-worldline-uat-schema.js — creates the `axis_worldline_uat` collection that backs
// POST /uat/axis-worldline-webhook (Worldline "Aggregator Transaction Notification" V1 UAT receiver).
//
//   node scripts/setup-axis-worldline-uat-schema.js            # dry run
//   node scripts/setup-axis-worldline-uat-schema.js --write    # create it
//
// Idempotent — every create tolerates "already exists", so re-running is a clean no-op.
//
// The columns deliberately MIRROR webhook_data's struct (payload, qrCodeId, paymentId,
// rrnNumber, amount-in-paise, vpa, provider, created_at, status, ownerSubadminId + review
// fields) so that once Worldline UAT passes, moving ingestion into the main webhook_data
// table is a straight copy — no remapping. Worldline-only fields (mid, tr_id, time_stamp,
// transaction_type, …) live inside the raw `payload` JSON, exactly like the other providers.
//
// This collection is a CAPTURE LOG, not a money path. Nothing here feeds QR ledgers, daily
// summaries, counters, or partner webhooks. Column sizes must stay in sync with the CAPS
// map in axisWorldlineUat.js (the route truncates to these before writing).
//
// idx_paymentId is a KEY index, NOT unique: a Worldline retry must never make Appwrite throw
// and turn a UAT post into a FAILED response. Dedup is a best-effort lookup in the route.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, TablesDB, Query } = require('node-appwrite');

const ENDPOINT    = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID  = process.env.APPWRITE_PROJECT_ID;
const API_KEY     = process.env.APPWRITE_API_KEY;
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID    = process.env.APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID || 'axis_worldline_uat';

const WRITE = process.argv.includes('--write');

for (const [name, val] of Object.entries({ APPWRITE_ENDPOINT: ENDPOINT, APPWRITE_PROJECT_ID: PROJECT_ID, APPWRITE_API_KEY: API_KEY, APPWRITE_DATABASE_ID: DATABASE_ID })) {
  if (!val) {
    console.error(`Missing required env var ${name} — check the .env at the project root.`);
    process.exit(1);
  }
}

// webhook_data-shaped columns (see the createDocument payloads in server.js webhooks +
// the review fields from setup-review-schema.js), plus a warningsJson/sourceIp capture tail.
const COLUMNS = [
  { key: 'payload',         kind: 'string',  size: 1000000, required: false, note: 'full raw notification JSON — source of truth (encrypted `data` or decrypted object)' },
  { key: 'qrCodeId',        kind: 'string',  size: 64,  required: false, note: 'tid, else mid — terminal/QR identifier' },
  { key: 'paymentId',       kind: 'string',  size: 64,  required: false, note: 'Worldline primary_id (spec max 40) — dedup key' },
  { key: 'rrnNumber',       kind: 'string',  size: 64,  required: false, note: 'ref_no (RRN as sent by issuer)' },
  { key: 'amount',          kind: 'integer',            required: false, note: 'paise — txn_amount rupees converted once at the boundary' },
  { key: 'vpa',             kind: 'string',  size: 255, required: false, note: 'customer_vpa (UPI) — null on BQR card txns' },
  { key: 'provider',        kind: 'string',  size: 32,  required: false, note: "always 'axis_worldline'" },
  { key: 'created_at',      kind: 'string',  size: 40,  required: false, note: 'UTC ISO — when WE received it (Worldline time_stamp stays in payload)' },
  { key: 'status',          kind: 'string',  size: 24,  required: false, note: "always 'normal' here — the money-status enum" },
  { key: 'ownerSubadminId', kind: 'string',  size: 64,  required: false, note: 'null in UAT — no owner resolution runs on the capture path' },
  { key: 'deleted',         kind: 'boolean',            required: false, note: 'webhook_data review-field parity — never set here' },
  { key: 'reviewStatus',    kind: 'string',  size: 32,  required: false, note: 'webhook_data review-field parity — never set here' },
  { key: 'reviewMode',      kind: 'string',  size: 16,  required: false, note: 'webhook_data review-field parity — never set here' },
  { key: 'reviewExpiresAt', kind: 'string',  size: 40,  required: false, note: 'webhook_data review-field parity — never set here' },
  { key: 'warningsJson',    kind: 'string',  size: 4096, required: false, note: 'JSON array of mapping warnings (UAT diagnostics)' },
  { key: 'sourceIp',        kind: 'string',  size: 64,  required: false, note: 'req.ip of the poster' },
];

const INDEXES = [
  { key: 'idx_paymentId',  type: 'key', columns: ['paymentId'] },   // dedup lookup — key, never unique
  { key: 'idx_created_at', type: 'key', columns: ['created_at'] },  // list ordering
  { key: 'idx_rrnNumber',  type: 'key', columns: ['rrnNumber'] },   // reconciliation by RRN
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

  console.log('Axis Worldline UAT webhook capture collection setup');
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
      name: 'Axis Worldline UAT',
      permissions: [],       // server API key only — captures echo whatever Worldline posts
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
      } else if (c.kind === 'boolean') {
        await db.createBooleanColumn({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: c.key, required: !!c.required });
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
  console.log(`  1. Set APPWRITE_AXIS_WORLDLINE_UAT_COLLECTION_ID=${TABLE_ID} in .env (and on Render).`);
  console.log('  2. Give Worldline/bank:  POST https://<host>/prod/axis-worldline-webhook');
  console.log('     (application/json — the spec defines no auth header; the endpoint is rate-limited)');
  console.log('  3. Read captures back at  GET /prod/axis-worldline-webhook/captures  (admin auth).');
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
