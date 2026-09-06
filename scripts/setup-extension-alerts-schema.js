// setup-extension-alerts-schema.js — creates the `extension_alerts` collection behind the
// browser-extension alert channel (POST /phonepe-capture/alert, POST /bharatpe-capture/alert —
// extensionAlerts.js).
//
//   node scripts/setup-extension-alerts-schema.js            # dry run
//   node scripts/setup-extension-alerts-schema.js --write    # create it
//
// Idempotent — every create tolerates "already exists", so re-running is a clean no-op.
//
// NOT NEEDED AT ALL if you deploy with EXTENSION_ALERT_STORE=redis: that mode keeps the alert log
// in capped Redis lists and writes nothing to Appwrite. Run this only for the default
// EXTENSION_ALERT_STORE=appwrite (durable) mode.
//
// ONE collection, on purpose. Live device state and the per-device ping ring are REDIS-ONLY
// (`extdev:<provider>:<instanceId>` and `exthist:<provider>:<instanceId>`, both TTL'd): that state
// is self-healing — lose Redis and the next heartbeat rebuilds it — so it does not belong in a
// durable store. Heartbeats (~1440/device/day) are never written here at all; only real alerts
// are, capped at EXTENSION_ALERT_LOG_PER_DEVICE (default 50) rows per laptop per extension, which
// the route trims after each insert. Nothing here is a money path.
//
// If you ran an earlier version of this script, it also created an `extension_devices` collection.
// Nothing reads or writes it any more — delete it in the Appwrite console at your leisure.
//
// idx_alertId is UNIQUE on purpose: the extension never retries, but a proxy re-delivery must be
// idempotent — the route catches the 409 and answers 200 { ok:true, duplicate:true }.
// idx_device_time backs BOTH the per-device history query and the trim (filter by
// provider+instanceId, order by created_at) — without it those degrade to a scan.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, TablesDB, Query } = require('node-appwrite');

const ENDPOINT    = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID  = process.env.APPWRITE_PROJECT_ID;
const API_KEY     = process.env.APPWRITE_API_KEY;
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID    = process.env.APPWRITE_EXTENSION_ALERTS_COLLECTION_ID || 'extension_alerts';

const WRITE = process.argv.includes('--write');

for (const [name, val] of Object.entries({ APPWRITE_ENDPOINT: ENDPOINT, APPWRITE_PROJECT_ID: PROJECT_ID, APPWRITE_API_KEY: API_KEY, APPWRITE_DATABASE_ID: DATABASE_ID })) {
  if (!val) {
    console.error(`Missing required env var ${name} — check the .env at the project root.`);
    process.exit(1);
  }
}

const COLUMNS = [
  { key: 'provider',           kind: 'string',  size: 32,    required: false, note: "'phonepe' | 'bharatpe' — from the route, not the body" },
  { key: 'alertId',            kind: 'string',  size: 128,   required: false, note: 'uuid v4 from the extension — idempotency key' },
  { key: 'event',              kind: 'string',  size: 32,    required: false, note: "always 'alert' — heartbeats are Redis-only" },
  { key: 'type',               kind: 'string',  size: 64,    required: false, note: 'logged_out | stale | error | wrong_merchant | …' },
  { key: 'severity',           kind: 'string',  size: 16,    required: false, note: 'derived: info | high | critical (ops routing)' },
  { key: 'instanceId',         kind: 'string',  size: 128,   required: false, note: 'stable per Chrome profile — the device key' },
  { key: 'deviceLabel',        kind: 'string',  size: 128,   required: false, note: 'human name the user typed for this laptop' },
  { key: 'expectedMerchantId', kind: 'string',  size: 64,    required: false, note: 'merchant this profile is bound to' },
  { key: 'loggedInMerchantId', kind: 'string',  size: 64,    required: false, note: 'merchant currently on the dashboard' },
  { key: 'merchantOk',         kind: 'boolean',              required: false, note: 'false = wrong account logged in' },
  { key: 'state',              kind: 'string',  size: 64,    required: false, note: 'unknown|live|stale|logged_out|error|recovering|paused' },
  { key: 'message',            kind: 'string',  size: 512,   required: false, note: 'human-readable text from the extension' },
  { key: 'detailJson',         kind: 'string',  size: 16384, required: false, note: 'type-specific detail object, JSON' },
  { key: 'statsJson',          kind: 'string',  size: 8192,  required: false, note: 'cumulative counters snapshot, JSON' },
  { key: 'deviceAt',           kind: 'string',  size: 40,    required: false, note: 'UTC ISO from the laptop clock (body.at)' },
  { key: 'created_at',         kind: 'string',  size: 40,    required: false, note: 'UTC ISO — when WE received it; the ordering key' },
];

const INDEXES = [
  { key: 'idx_alertId',     type: 'unique', columns: ['alertId'] },                            // idempotency — re-delivery 409s
  { key: 'idx_created_at',  type: 'key',    columns: ['created_at'] },                         // global list ordering
  { key: 'idx_device_time', type: 'key',    columns: ['provider', 'instanceId', 'created_at'] }, // per-device history + the trim
  { key: 'idx_type',        type: 'key',    columns: ['type'] },                               // filter by alert type
  { key: 'idx_severity',    type: 'key',    columns: ['severity'] },                           // "show me criticals"
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

  console.log('Browser-extension alert log setup');
  console.log(WRITE ? '\nMODE: WRITE' : '\nMODE: DRY RUN — nothing will be written. Re-run with --write to apply.');
  console.log(`  endpoint=${ENDPOINT}  project=${PROJECT_ID}  db=${DATABASE_ID}`);
  console.log(`  table=${TABLE_ID}\n`);
  console.log('  (device state + ping history are Redis-only — no collection for those)\n');

  console.log(`Table "${TABLE_ID}" — permissions=[] rowSecurity=false (server API key only)`);
  for (const c of COLUMNS) console.log(`  column ${c.key.padEnd(20)} ${c.kind}${c.size ? `(${c.size})` : ''}  — ${c.note}`);
  for (const i of INDEXES) console.log(`  index  ${i.key.padEnd(20)} ${i.type} on [${i.columns.join(', ')}]`);

  if (!WRITE) {
    console.log('\nDry run complete. Re-run with --write to apply.');
    return;
  }

  console.log('\n--- creating ---');
  try {
    await db.createTable({ databaseId: DATABASE_ID, tableId: TABLE_ID, name: 'Extension Alerts', permissions: [], rowSecurity: false, enabled: true });
    console.log(`  [OK]   table ${TABLE_ID}`);
  } catch (e) {
    if (isAlreadyExists(e)) console.log(`  [SKIP] table ${TABLE_ID} already exists`);
    else throw e;
  }

  for (const c of COLUMNS) {
    try {
      if (c.kind === 'boolean') await db.createBooleanColumn({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: c.key, required: !!c.required });
      else await db.createStringColumn({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: c.key, size: c.size, required: !!c.required });
      console.log(`  [OK]   column ${c.key}`);
    } catch (e) {
      if (isAlreadyExists(e)) console.log(`  [SKIP] column ${c.key} already exists`);
      else console.error(`  [ERR]  column ${c.key}: ${describeErr(e)}`);
    }
  }

  // Indexes cannot be built over attributes that are still provisioning.
  await waitForColumns(db, [...new Set(INDEXES.flatMap((i) => i.columns))]);

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
  console.log(`  1. Set APPWRITE_EXTENSION_ALERTS_COLLECTION_ID=${TABLE_ID} in .env (and on Render).`);
  console.log('     Optional tuning: EXTENSION_ALERT_LOG_PER_DEVICE (50), EXTENSION_DEVICE_HISTORY (80),');
  console.log('     EXTENSION_ALERT_OFFLINE_MS (180000), EXTENSION_DEVICE_TTL_SECONDS (604800).');
  console.log('  2. In each extension: Alert URL = https://<host>/<provider>-capture/alert,');
  console.log('     Alert API key = the same <PROVIDER>_EXTENSION_API_KEY as the push route,');
  console.log('     heartbeatMinutes = 1, and a distinct deviceLabel per laptop.');
  console.log('  3. Panel reads:  GET /api/admin/extension-alerts/devices  (fleet, from Redis),');
  console.log('     GET /api/admin/extension-alerts/devices/<provider>/<instanceId>  (detail + ping ring),');
  console.log('     GET /api/admin/extension-alerts  (log). All admin auth.');
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
