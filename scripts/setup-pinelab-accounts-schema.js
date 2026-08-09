// setup-pinelab-accounts-schema.js — creates the `pinelab_accounts` collection that
// holds PineLabs merchant credentials, replacing the hardcoded PINELAB_ACCOUNTS
// array in server.js.
//
//   node scripts/setup-pinelab-accounts-schema.js            # dry run
//   node scripts/setup-pinelab-accounts-schema.js --write     # create it
//
// This script creates the SCHEMA ONLY — it deliberately seeds no credentials, so no
// secret is ever written into a tracked file. Add accounts afterwards through the
// admin API:
//
//   POST /admin/pinelabs/accounts
//   { "accountId": "scanserve_ai", "clientId": "...", "clientSecret": "...",
//     "label": "ScanServe AI", "enabled": true }
//
// Security posture of this collection:
//   * NO table permissions and rowSecurity=false  -> unreachable by any client SDK;
//     only the server's API key can read it. It must never get read("guests") the
//     way app_config has, because that would publish live gateway credentials.
//   * clientSecret is stored with encrypt:true (encrypted at rest by Appwrite).
//     Encrypted attributes cannot be indexed or filtered — that is fine, nothing
//     queries by secret.
//   * The admin read endpoint never returns clientSecret.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, TablesDB, Query } = require('node-appwrite');

const ENDPOINT    = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID  = process.env.APPWRITE_PROJECT_ID;
const API_KEY     = process.env.APPWRITE_API_KEY;
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID    = process.env.APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID || 'pinelab_accounts';

const WRITE = process.argv.includes('--write');

for (const [name, val] of Object.entries({ APPWRITE_ENDPOINT: ENDPOINT, APPWRITE_PROJECT_ID: PROJECT_ID, APPWRITE_API_KEY: API_KEY, APPWRITE_DATABASE_ID: DATABASE_ID })) {
  if (!val) {
    console.error(`Missing required env var ${name} — check the .env at the project root.`);
    process.exit(1);
  }
}

const COLUMNS = [
  { key: 'accountId',    kind: 'string',  size: 64,  required: true,  note: "poller id, e.g. 'scanserve_ai' — used in Redis keys pinelabs:poller:<id>:*" },
  { key: 'clientId',     kind: 'string',  size: 255, required: true,  note: 'PineLabs client id' },
  { key: 'clientSecret', kind: 'string',  size: 255, required: true,  note: 'PineLabs client secret — ENCRYPTED at rest', encrypt: true },
  { key: 'label',        kind: 'string',  size: 128, required: false, note: 'human-readable name for the admin UI' },
  { key: 'enabled',      kind: 'boolean',            required: false, note: 'only enabled accounts are polled', xdefault: true },
];

// accountId only — clientSecret is encrypted and cannot be indexed.
const INDEXES = [
  { key: 'idx_accountId_unique', type: 'unique', columns: ['accountId'] },
  { key: 'idx_enabled',          type: 'key',    columns: ['enabled'] },
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

  console.log('PineLabs accounts collection setup');
  console.log(WRITE ? '\nMODE: WRITE' : '\nMODE: DRY RUN — nothing will be written. Re-run with --write to apply.');
  console.log(`  endpoint=${ENDPOINT}  project=${PROJECT_ID}  db=${DATABASE_ID}`);
  console.log(`  table=${TABLE_ID}\n`);

  console.log(`Table "${TABLE_ID}" — permissions=[] rowSecurity=false (server API key only)`);
  for (const c of COLUMNS) {
    console.log(`  column ${c.key.padEnd(14)} ${c.kind}${c.size ? `(${c.size})` : ''}${c.required ? ' required' : ''}${c.encrypt ? ' ENCRYPTED' : ''}  — ${c.note}`);
  }
  for (const i of INDEXES) console.log(`  index  ${i.key.padEnd(24)} ${i.type} on [${i.columns.join(', ')}]`);

  if (!WRITE) {
    console.log('\nDry run complete. Re-run with --write to apply.');
    return;
  }

  console.log('\n--- creating ---');
  try {
    await db.createTable({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      name: 'PineLabs Accounts',
      permissions: [],        // never expose to client SDKs — this holds live credentials
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
      if (c.kind === 'boolean') {
        await db.createBooleanColumn({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: c.key, required: !!c.required, xdefault: c.xdefault });
      } else {
        await db.createStringColumn({ databaseId: DATABASE_ID, tableId: TABLE_ID, key: c.key, size: c.size, required: !!c.required, encrypt: !!c.encrypt });
      }
      console.log(`  [OK]   column ${c.key}`);
    } catch (e) {
      if (isAlreadyExists(e)) console.log(`  [SKIP] column ${c.key} already exists`);
      else console.error(`  [ERR]  column ${c.key}: ${describeErr(e)}`);
    }
  }

  // Indexes cannot be built over attributes that are still provisioning.
  await waitForColumns(db, COLUMNS.map((c) => c.key));

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
  console.log(`  1. Set APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID=${TABLE_ID} in .env (and on Render).`);
  console.log('  2. POST each account to /admin/pinelabs/accounts (admin auth).');
  console.log('  3. GET /admin/pinelabs/accounts to confirm both appear with enabled:true.');
  console.log('  4. Only then remove the hardcoded PINELAB_ACCOUNTS array from server.js.');
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
