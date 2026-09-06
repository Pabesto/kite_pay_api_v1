// setup-extension-alerts-schema.js — creates the two collections behind the browser-extension
// alert channel (POST /phonepe-capture/alert, POST /bharatpe-capture/alert — extensionAlerts.js).
//
//   node scripts/setup-extension-alerts-schema.js            # dry run
//   node scripts/setup-extension-alerts-schema.js --write    # create them
//
// Idempotent — every create tolerates "already exists", so re-running is a clean no-op.
//
// Neither collection is a money path: they hold device health, not transactions.
// Column sizes must stay in sync with the CAPS map in extensionAlerts.js (the route truncates
// to these before writing).
//
// idx_alertId is UNIQUE on purpose: the extension never retries, but a proxy re-delivery must
// be idempotent — the route catches the 409 and answers 200 { ok:true, duplicate:true }.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, TablesDB, Query } = require('node-appwrite');

const ENDPOINT    = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID  = process.env.APPWRITE_PROJECT_ID;
const API_KEY     = process.env.APPWRITE_API_KEY;
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const ALERTS_ID   = process.env.APPWRITE_EXTENSION_ALERTS_COLLECTION_ID  || 'extension_alerts';
const DEVICES_ID  = process.env.APPWRITE_EXTENSION_DEVICES_COLLECTION_ID || 'extension_devices';

const WRITE = process.argv.includes('--write');

for (const [name, val] of Object.entries({ APPWRITE_ENDPOINT: ENDPOINT, APPWRITE_PROJECT_ID: PROJECT_ID, APPWRITE_API_KEY: API_KEY, APPWRITE_DATABASE_ID: DATABASE_ID })) {
  if (!val) {
    console.error(`Missing required env var ${name} — check the .env at the project root.`);
    process.exit(1);
  }
}

const TABLES = [
  {
    id: ALERTS_ID,
    name: 'Extension Alerts',
    note: 'append-only log of every alert + heartbeat posted by the capture extensions',
    columns: [
      { key: 'provider',           kind: 'string',  size: 32,    required: false, note: "'phonepe' | 'bharatpe' — from the route, not the body" },
      { key: 'alertId',            kind: 'string',  size: 128,   required: false, note: 'uuid v4 from the extension — idempotency key' },
      { key: 'event',              kind: 'string',  size: 32,    required: false, note: "'alert' | 'heartbeat'" },
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
      { key: 'created_at',         kind: 'string',  size: 40,    required: false, note: 'UTC ISO — when WE received it' },
    ],
    indexes: [
      { key: 'idx_alertId',    type: 'unique', columns: ['alertId'] },     // idempotency — re-delivery 409s, route returns 200
      { key: 'idx_created_at', type: 'key',    columns: ['created_at'] },  // list ordering
      { key: 'idx_instanceId', type: 'key',    columns: ['instanceId'] },  // per-device history
      { key: 'idx_type',       type: 'key',    columns: ['type'] },        // filter by alert type
    ],
  },
  {
    id: DEVICES_ID,
    name: 'Extension Devices',
    note: 'one row per (provider, instanceId) — the panel fleet view; upserted on every alert',
    columns: [
      { key: 'provider',           kind: 'string',  size: 32,   required: false, note: "'phonepe' | 'bharatpe'" },
      { key: 'instanceId',         kind: 'string',  size: 128,  required: false, note: 'device key — unique with provider' },
      { key: 'deviceLabel',        kind: 'string',  size: 128,  required: false, note: 'sticky: kept when a later alert omits it' },
      { key: 'expectedMerchantId', kind: 'string',  size: 64,   required: false, note: 'merchant this laptop should be on' },
      { key: 'loggedInMerchantId', kind: 'string',  size: 64,   required: false, note: 'merchant last seen on the dashboard' },
      { key: 'merchantOk',         kind: 'boolean',             required: false, note: 'false = wrong account logged in' },
      { key: 'lastState',          kind: 'string',  size: 64,   required: false, note: 'extension state on the latest request' },
      { key: 'lastType',           kind: 'string',  size: 64,   required: false, note: 'latest alert type (heartbeat included)' },
      { key: 'lastMessage',        kind: 'string',  size: 512,  required: false, note: 'latest human-readable message' },
      { key: 'lastSeenAt',         kind: 'string',  size: 40,   required: false, note: 'UTC ISO of ANY request — drives offline detection' },
      { key: 'lastHeartbeatAt',    kind: 'string',  size: 40,   required: false, note: 'UTC ISO of the last heartbeat' },
      { key: 'lastIncidentAt',     kind: 'string',  size: 40,   required: false, note: 'UTC ISO of the last incident-opening alert' },
      { key: 'lastAlertId',        kind: 'string',  size: 128,  required: false, note: 'alertId of the latest request' },
      { key: 'openIncident',       kind: 'string',  size: 64,   required: false, note: 'unresolved critical type, or null' },
      { key: 'openSince',          kind: 'string',  size: 40,   required: false, note: 'UTC ISO (device clock) the incident opened' },
      { key: 'statsJson',          kind: 'string',  size: 8192, required: false, note: 'latest counters snapshot, JSON' },
    ],
    indexes: [
      { key: 'idx_device',      type: 'key', columns: ['provider', 'instanceId'] }, // the upsert lookup
      { key: 'idx_lastSeenAt',  type: 'key', columns: ['lastSeenAt'] },             // "who went quiet"
    ],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlreadyExists = (e) => e && (e.code === 409 || String(e.message || '').toLowerCase().includes('already exists'));
const describeErr = (e) => [e?.code && `code=${e.code}`, e?.message].filter(Boolean).join(' | ');

async function waitForColumns(db, tableId, keys, { timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cols = (await db.listColumns({ databaseId: DATABASE_ID, tableId, queries: [Query.limit(100)] })).columns || [];
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

  console.log('Browser-extension alert channel setup');
  console.log(WRITE ? '\nMODE: WRITE' : '\nMODE: DRY RUN — nothing will be written. Re-run with --write to apply.');
  console.log(`  endpoint=${ENDPOINT}  project=${PROJECT_ID}  db=${DATABASE_ID}\n`);

  for (const t of TABLES) {
    console.log(`Table "${t.id}" — ${t.note} (permissions=[] rowSecurity=false, server API key only)`);
    for (const c of t.columns) console.log(`  column ${c.key.padEnd(20)} ${c.kind}${c.size ? `(${c.size})` : ''}  — ${c.note}`);
    for (const i of t.indexes) console.log(`  index  ${i.key.padEnd(20)} ${i.type} on [${i.columns.join(', ')}]`);
    console.log('');
  }

  if (!WRITE) {
    console.log('Dry run complete. Re-run with --write to apply.');
    return;
  }

  for (const t of TABLES) {
    console.log(`--- creating ${t.id} ---`);
    try {
      await db.createTable({ databaseId: DATABASE_ID, tableId: t.id, name: t.name, permissions: [], rowSecurity: false, enabled: true });
      console.log(`  [OK]   table ${t.id}`);
    } catch (e) {
      if (isAlreadyExists(e)) console.log(`  [SKIP] table ${t.id} already exists`);
      else throw e;
    }

    for (const c of t.columns) {
      try {
        if (c.kind === 'boolean') await db.createBooleanColumn({ databaseId: DATABASE_ID, tableId: t.id, key: c.key, required: !!c.required });
        else await db.createStringColumn({ databaseId: DATABASE_ID, tableId: t.id, key: c.key, size: c.size, required: !!c.required });
        console.log(`  [OK]   column ${c.key}`);
      } catch (e) {
        if (isAlreadyExists(e)) console.log(`  [SKIP] column ${c.key} already exists`);
        else console.error(`  [ERR]  column ${c.key}: ${describeErr(e)}`);
      }
    }

    // Indexes cannot be built over attributes that are still provisioning.
    await waitForColumns(db, t.id, [...new Set(t.indexes.flatMap((i) => i.columns))]);

    for (const i of t.indexes) {
      try {
        await db.createIndex({ databaseId: DATABASE_ID, tableId: t.id, key: i.key, type: i.type, columns: i.columns });
        console.log(`  [OK]   index ${i.key}`);
      } catch (e) {
        if (isAlreadyExists(e)) console.log(`  [SKIP] index ${i.key} already exists`);
        else console.error(`  [ERR]  index ${i.key}: ${describeErr(e)}`);
      }
    }
    console.log('');
  }

  console.log('Done. Next steps:');
  console.log(`  1. Set APPWRITE_EXTENSION_ALERTS_COLLECTION_ID=${ALERTS_ID} and`);
  console.log(`     APPWRITE_EXTENSION_DEVICES_COLLECTION_ID=${DEVICES_ID} in .env (and on Render).`);
  console.log('  2. In each extension: Alert URL = https://<host>/<provider>-capture/alert,');
  console.log('     Alert API key = the same <PROVIDER>_EXTENSION_API_KEY as the push route,');
  console.log('     heartbeatMinutes = 1, and a distinct deviceLabel per laptop.');
  console.log('  3. Panel reads:  GET /api/admin/extension-alerts/devices  and  GET /api/admin/extension-alerts  (admin auth).');
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
