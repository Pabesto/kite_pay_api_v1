// seed-pinelab-accounts.js — inserts/updates PineLabs merchant credentials in the
// `pinelab_accounts` collection created by setup-pinelab-accounts-schema.js.
//
//   node scripts/seed-pinelab-accounts.js                  # dry run
//   node scripts/seed-pinelab-accounts.js --write          # apply
//   node scripts/seed-pinelab-accounts.js --file ./x.json  # non-default source
//
// Credentials are NEVER hardcoded here and never echoed to the console — this file
// is tracked by git. They are read at run time from, in order of precedence:
//
//   1. --file <path>
//   2. $PINELAB_SEED_ACCOUNTS  (a JSON array in the environment)
//   3. ./pinelab-seed.json     (default; gitignored)
//
// Expected shape — an array of:
//   [
//     { "id": "<account_id>", "clientId": "<client id>", "clientSecret": "<secret>",
//       "label": "<optional display name>", "enabled": true }
//   ]
//
// Idempotent: an account whose `id` already exists is UPDATED (so this doubles as a
// credential-rotation tool), never duplicated.
//
// Delete the source file once you are done — it holds live gateway credentials.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, TablesDB, Query, ID } = require('node-appwrite');

const ENDPOINT    = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID  = process.env.APPWRITE_PROJECT_ID;
const API_KEY     = process.env.APPWRITE_API_KEY;
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID    = process.env.APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID || 'pinelab_accounts';

const WRITE = process.argv.includes('--write');
const DEFAULT_FILE = path.join(__dirname, '..', 'pinelab-seed.json');

for (const [name, val] of Object.entries({ APPWRITE_ENDPOINT: ENDPOINT, APPWRITE_PROJECT_ID: PROJECT_ID, APPWRITE_API_KEY: API_KEY, APPWRITE_DATABASE_ID: DATABASE_ID })) {
  if (!val) {
    console.error(`Missing required env var ${name} — check the .env at the project root.`);
    process.exit(1);
  }
}

// Show enough to identify a value, never enough to use it.
function mask(v) {
  const s = String(v ?? '');
  if (s.length <= 4) return `${'*'.repeat(s.length)} (len ${s.length})`;
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-2)} (len ${s.length})`;
}

function loadAccounts() {
  const fileArgIdx = process.argv.indexOf('--file');
  const fileArg = fileArgIdx !== -1 ? process.argv[fileArgIdx + 1] : null;

  let raw, source;
  if (fileArg) {
    if (!fs.existsSync(fileArg)) throw new Error(`--file ${fileArg} does not exist`);
    raw = fs.readFileSync(fileArg, 'utf8');
    source = fileArg;
  } else if (process.env.PINELAB_SEED_ACCOUNTS) {
    raw = process.env.PINELAB_SEED_ACCOUNTS;
    source = '$PINELAB_SEED_ACCOUNTS';
  } else if (fs.existsSync(DEFAULT_FILE)) {
    raw = fs.readFileSync(DEFAULT_FILE, 'utf8');
    source = DEFAULT_FILE;
  } else {
    throw new Error(
      `No credentials source found. Create ${DEFAULT_FILE} (it is gitignored) containing a JSON array of\n` +
      `  { "id", "clientId", "clientSecret", "label"?, "enabled"? }\n` +
      `or set $PINELAB_SEED_ACCOUNTS, or pass --file <path>.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${source} must contain a JSON array`);
  if (!parsed.length) throw new Error(`${source} contains an empty array`);

  parsed.forEach((a, i) => {
    if (!a || typeof a !== 'object') throw new Error(`entry ${i} is not an object`);
    if (!a.id || !a.clientId || !a.clientSecret) {
      throw new Error(`entry ${i} (${a.id || 'no id'}) must have id, clientId and clientSecret`);
    }
    // `id` becomes a Redis key segment (pinelabs:poller:<id>:*) — same charset rule
    // the admin POST endpoint enforces, so both paths agree.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(a.id)) {
      throw new Error(`entry ${i} id "${a.id}" must match ^[a-zA-Z0-9_-]{1,64}$`);
    }
  });

  const ids = parsed.map((a) => a.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`duplicate id(s) in ${source}: ${[...new Set(dupes)].join(', ')}`);

  return { accounts: parsed, source };
}

(async () => {
  const { accounts, source } = loadAccounts();
  const db = new TablesDB(new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY));

  console.log('PineLabs account seed');
  console.log(WRITE ? '\nMODE: WRITE' : '\nMODE: DRY RUN — nothing will be written. Re-run with --write to apply.');
  console.log(`  endpoint=${ENDPOINT}  project=${PROJECT_ID}  db=${DATABASE_ID}  table=${TABLE_ID}`);
  console.log(`  source=${source}  accounts=${accounts.length}\n`);

  // Fail early and clearly if the schema step has not been run against this project.
  let existing;
  try {
    existing = await db.listRows({ databaseId: DATABASE_ID, tableId: TABLE_ID, queries: [Query.limit(100)] });
  } catch (e) {
    console.error(`Cannot read table "${TABLE_ID}": ${e.message}`);
    console.error('Run `node scripts/setup-pinelab-accounts-schema.js --write` against THIS project first.');
    process.exitCode = 1;
    return;
  }
  const byAccountId = new Map(existing.rows.map((r) => [r.accountId, r]));

  let created = 0, updated = 0, failed = 0;

  for (const a of accounts) {
    const found = byAccountId.get(a.id);
    const action = found ? 'UPDATE' : 'CREATE';
    console.log(`  [${action}] ${a.id}`);
    console.log(`             clientId     = ${mask(a.clientId)}`);
    console.log(`             clientSecret = ${mask(a.clientSecret)}`);
    console.log(`             enabled      = ${a.enabled !== false}`);

    if (!WRITE) { found ? updated++ : created++; continue; }

    const data = {
      accountId: a.id,
      clientId: a.clientId,
      clientSecret: a.clientSecret,
      label: a.label || null,
      enabled: a.enabled !== false,
    };

    try {
      if (found) {
        await db.updateRow({ databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: found.$id, data });
        updated++;
      } else {
        await db.createRow({ databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: ID.unique(), data });
        created++;
      }
      console.log(`             -> ok`);
    } catch (e) {
      failed++;
      console.error(`             -> FAILED: ${e.message}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`  ${WRITE ? 'created' : 'would create'}=${created}  ${WRITE ? 'updated' : 'would update'}=${updated}  failed=${failed}`);

  if (WRITE && !failed) {
    // Read back so the operator sees the stored state, not just what we sent.
    const after = await db.listRows({ databaseId: DATABASE_ID, tableId: TABLE_ID, queries: [Query.limit(100), Query.orderAsc('accountId')] });
    console.log('\nStored accounts (secrets never printed):');
    for (const r of after.rows) {
      console.log(`  ${r.accountId.padEnd(20)} enabled=${r.enabled !== false}  clientSecretSet=${!!r.clientSecret}  label=${r.label || '-'}`);
    }
    console.log('\nNext:');
    console.log('  1. POST /admin/pinelabs/reload   (admin auth) to restart the poller');
    console.log('  2. GET  /admin/pinelabs/running  to confirm running:true with both accountIds');
    console.log(`  3. Delete ${source === '$PINELAB_SEED_ACCOUNTS' ? 'the env var' : source} — it holds live credentials.`);
  } else if (!WRITE) {
    console.log('\nDry run complete. Re-run with --write to apply.');
  }

  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
