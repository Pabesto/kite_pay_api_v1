// migrateAppwriteDb.js — copies the Appwrite database schema (tables + columns +
// indexes) from a source project into a target project, plus row data for the two
// tables that must carry over: app_config (verbatim) and dashboard_counters (with
// every `totals` reset to 0). Finally, creates a bootstrap admin in the target
// project's Auth and its matching users_meta row.
//
// Dry-run by default. Nothing is written without --write.
//
//   node scripts/migrateAppwriteDb.js             # plan only, writes nothing
//   node scripts/migrateAppwriteDb.js --write     # perform the migration
//   node scripts/migrateAppwriteDb.js --selftest  # offline logic check, no creds
//
// Standalone — reads no .env and imports nothing from this project. Fill in the
// SOURCE and TARGET blocks below before running.
//
// SECURITY: once filled in, this file holds live Appwrite API keys. It is tracked
// by git. Do not commit it with real values — keep the keys local, or add the file
// to .gitignore. Blank the blocks again when you are done migrating.
//
// Safe to re-run: every create treats Appwrite's 409 "already exists" as a skip.

// =====================  EDIT THESE  =====================

const SOURCE = {
  endpoint:   'https://sgp.cloud.appwrite.io/v1',
  projectId:  '69fbf3d100025d91e8d5',
  apiKey:     'standard_cbe1d7b44195f9ddd89443d29adfdce5bce20bece882e0702037f71832c69915d5e6e89b1edfe1f944eac197b22289f7190895e2bd3dbca5fdf68d29123106ae70674ac2b0ba70b2b5bfa8eeeb504b39eca5054d81db7edcb27ca6ada6dc4ae93949d0fb1c623cc585090cfb21a3bb2c527ab6773037b837de2e33f11cdf3854',
  databaseId: '69fbf49100207103019a',
};

const TARGET = {
  endpoint:   'https://sgp.cloud.appwrite.io/v1',
  projectId:  '6a788fcd001d540868ef',
  apiKey:     'standard_0e2204b5f230c3d9c08735b1afedb9a86aa64f90765f3b0dde25efd15c5cf504c522c7081e2974e829796c65f107dc3bb987ef798c00cdf4986fff2a2ed945f5636f4a051bfa4e28e49c353a4e4b9c2c664622f873429a46e83f851106c19d01e2c5d895f364ac63b1aa288726a5f8eeb6a7a3d99c84c8d74f860a3d9aaf9170',
  databaseId: '6a789095000fcaf71dd7',
};

// The only two tables whose rows are copied. Everything else is schema-only.
const CONFIG_TABLE_ID = '68a73217002ed987b246';   // app_config — copied verbatim
const COUNTERS_TABLE_ID = 'dashboard_counters';   // copied with every `totals` set to 0
const USERS_META_TABLE_ID = 'users_meta_test';    // live users table, despite the name

// Bootstrap admin created in the TARGET project as the final step. Appwrite
// generates the auth user id; that same id becomes both users_meta.userId and the
// row's $id, which is what every ownership check in the app compares against.
const ADMIN = {
  email:    'admin@kitepay3.com',
  password: 'Batman1234@A',   // min 8 chars — Appwrite requires one at creation
  name:     'Admin',
};

// ========================================================

const { Client, TablesDB, Users, Query, ID } = require('node-appwrite');

const WRITE = process.argv.includes('--write');

// ---------------------------------------------------------------- credentials

function creds() {
  const blank = [];
  for (const [label, c] of [['SOURCE', SOURCE], ['TARGET', TARGET]]) {
    for (const k of ['endpoint', 'projectId', 'apiKey', 'databaseId']) {
      if (!c[k] || String(c[k]).startsWith('PUT_')) blank.push(`${label}.${k}`);
    }
  }
  if (!ADMIN.password || String(ADMIN.password).startsWith('PUT_')) blank.push('ADMIN.password');
  if (blank.length) {
    throw new Error(`Not filled in:\n  - ${blank.join('\n  - ')}\nEdit the SOURCE/TARGET/ADMIN block at the top of this file.`);
  }
  if (SOURCE.endpoint === TARGET.endpoint && SOURCE.projectId === TARGET.projectId && SOURCE.databaseId === TARGET.databaseId) {
    throw new Error('Source and target resolve to the same database — refusing to run.');
  }
  return { src: SOURCE, dst: TARGET };
}

const buildClient = ({ endpoint, projectId, apiKey }) =>
  new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);

const buildDb = (c) => new TablesDB(buildClient(c));

// ---------------------------------------------------------------- error helpers

const isAlreadyExists = (err) => {
  if (!err) return false;
  if (err.code === 409) return true;
  const m = String(err.message || '').toLowerCase();
  return m.includes('already exists');
};

function describeErr(err) {
  if (!err) return 'unknown error';
  return [err.code && `code=${err.code}`, err.type && `type=${err.type}`, err.message]
    .filter(Boolean)
    .join(' | ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Appwrite Cloud rate-limits; a 429 mid-run would otherwise abandon that one item
// and leave a hole that is easy to miss in a 300-call run.
async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e && (e.code === 429 || e.code >= 500);
      if (!retryable || attempt >= 3) throw e;
      const wait = 1000 * attempt;
      console.warn(`     [RETRY ${attempt}/2] ${label}: ${describeErr(e)} — waiting ${wait}ms`);
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------- source reads

async function listAllTables(db, databaseId) {
  const out = [];
  let cursor;
  for (;;) {
    const queries = [Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const res = await db.listTables({ databaseId, queries });
    if (!res.tables.length) break;
    out.push(...res.tables);
    if (res.tables.length < 100) break;
    cursor = res.tables[res.tables.length - 1].$id;
  }
  return out;
}

const listAllColumns = async (db, databaseId, tableId) =>
  (await db.listColumns({ databaseId, tableId, queries: [Query.limit(5000)] })).columns || [];

const listAllIndexes = async (db, databaseId, tableId) =>
  (await db.listIndexes({ databaseId, tableId, queries: [Query.limit(500)] })).indexes || [];

// ---------------------------------------------------------------- column create

// Appwrite rejects an explicit null on an optional field; it wants the key absent.
const u = (v) => (v === null ? undefined : v);

function createColumn(db, databaseId, tableId, col) {
  const t = (col.type || '').toLowerCase();
  const fmt = (col.format || '').toLowerCase();
  const base = { databaseId, tableId, key: col.key, required: !!col.required, xdefault: u(col.default), array: !!col.array };

  if (t === 'string') {
    if (fmt === 'email') return db.createEmailColumn(base);
    if (fmt === 'url') return db.createUrlColumn(base);
    if (fmt === 'ip') return db.createIpColumn(base);
    if (fmt === 'enum') return db.createEnumColumn({ ...base, elements: col.elements || [] });
    return db.createStringColumn({ ...base, size: col.size, encrypt: !!col.encrypt });
  }
  if (t === 'integer') return db.createIntegerColumn({ ...base, min: u(col.min), max: u(col.max) });
  if (t === 'double' || t === 'float') return db.createFloatColumn({ ...base, min: u(col.min), max: u(col.max) });
  if (t === 'boolean') return db.createBooleanColumn(base);
  if (t === 'datetime') return db.createDatetimeColumn(base);
  if (t === 'varchar') return db.createVarcharColumn({ ...base, size: col.size, encrypt: !!col.encrypt });
  if (t === 'text') return db.createTextColumn({ ...base, encrypt: !!col.encrypt });
  if (t === 'mediumtext') return db.createMediumtextColumn({ ...base, encrypt: !!col.encrypt });
  if (t === 'longtext') return db.createLongtextColumn({ ...base, encrypt: !!col.encrypt });
  if (t === 'point') return db.createPointColumn({ databaseId, tableId, key: col.key, required: !!col.required, xdefault: u(col.default) });
  if (t === 'line') return db.createLineColumn({ databaseId, tableId, key: col.key, required: !!col.required, xdefault: u(col.default) });
  if (t === 'polygon') return db.createPolygonColumn({ databaseId, tableId, key: col.key, required: !!col.required, xdefault: u(col.default) });

  throw new Error(`Unsupported column type "${col.type}" for column "${col.key}"`);
}

async function waitForColumns(db, databaseId, tableId, expectedKeys, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
  if (!expectedKeys.length) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cols = await listAllColumns(db, databaseId, tableId);
    const broken = cols.filter((c) => c.status === 'failed' || c.status === 'stuck');
    if (broken.length) {
      throw new Error(`Columns failed on ${tableId}: ${broken.map((c) => `${c.key}(${c.status}: ${c.error || ''})`).join(', ')}`);
    }
    const ready = new Set(cols.filter((c) => c.status === 'available').map((c) => c.key));
    if (expectedKeys.every((k) => ready.has(k))) return;
    await sleep(intervalMs);
  }
  // Name the offenders — "timed out on <table>" alone gives nothing to act on.
  const cols = await listAllColumns(db, databaseId, tableId);
  const status = new Map(cols.map((c) => [c.key, c.status]));
  const pending = expectedKeys.filter((k) => status.get(k) !== 'available');
  throw new Error(
    `Timed out waiting for columns on ${tableId}: ${pending.map((k) => `${k}(${status.get(k) || 'missing'})`).join(', ')}`
  );
}

// ---------------------------------------------------------------- index shaping

// Appwrite reports lengths as [0,0,...] meaning "index the full column"; echoing
// those zeros back is not the same as omitting the field. Same for empty orders,
// and the source mixes "ASC"/"asc" casing across tables.
const indexLengths = (idx) => (Array.isArray(idx.lengths) && idx.lengths.some((n) => n > 0) ? idx.lengths : undefined);
const indexOrders = (idx) =>
  Array.isArray(idx.orders) && idx.orders.length ? idx.orders.map((o) => String(o).toUpperCase()) : undefined;

// ---------------------------------------------------------------- row shaping

const SYSTEM_FIELDS = new Set([
  '$id', '$createdAt', '$updatedAt', '$permissions',
  '$databaseId', '$tableId', '$collectionId', '$sequence',
]);

function stripSystemFields(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SYSTEM_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// dashboard_counters carries its counter names and types forward, but the target
// starts with no transactions — so every total must start at 0 or the dashboard
// reports money that has no rows behind it.
function rowDataFor(tableId, row) {
  const data = stripSystemFields(row);
  if (tableId === COUNTERS_TABLE_ID) data.totals = 0;
  return data;
}

// ---------------------------------------------------------------- admin bootstrap

// parentId and assigned_to are omitted rather than sent as null: both are optional
// with no default, so an absent key stores exactly the same null value and avoids
// Appwrite's rejection of explicit nulls.
const adminRowData = (userId) => ({
  userId,
  email: ADMIN.email,
  name: ADMIN.name,
  role: 'admin',
  status: true,
  labels: ['admin'],
  commission: 2,
});

// ---------------------------------------------------------------- migration

async function migrate(srcDb, srcDbId, dstDb, dstDbId, dstUsers) {
  const stats = { tables: [0, 0, 0], columns: [0, 0, 0], indexes: [0, 0, 0], rows: [0, 0, 0], admin: [0, 0, 0] };
  const bump = (k, i) => stats[k][i]++;
  const OK = 0, SKIP = 1, FAIL = 2;
  const notReady = new Set();   // tables whose columns never finished provisioning

  console.log('\n--- Reading source schema ---');
  const tables = await listAllTables(srcDb, srcDbId);
  const schema = [];
  for (const t of tables) {
    const columns = await listAllColumns(srcDb, srcDbId, t.$id);
    const indexes = await listAllIndexes(srcDb, srcDbId, t.$id);
    schema.push({ table: t, columns, indexes });
  }
  const totalCols = schema.reduce((n, s) => n + s.columns.length, 0);
  const totalIdx = schema.reduce((n, s) => n + s.indexes.length, 0);
  console.log(`Found ${tables.length} table(s), ${totalCols} column(s), ${totalIdx} index(es).`);

  // There are none today. If one ever appears, dropping it silently would corrupt
  // the copied schema in a way nobody would notice until a query returned nothing.
  const rels = schema.flatMap(({ table, columns }) =>
    columns.filter((c) => (c.type || '').toLowerCase() === 'relationship').map((c) => `${table.$id}.${c.key}`)
  );
  if (rels.length) {
    throw new Error(
      `Source contains relationship column(s) this script does not handle: ${rels.join(', ')}\n` +
      'Relationships need parent/child ordering — extend the script before migrating.'
    );
  }

  // Step 1 — tables
  console.log(`\n--- Step 1: tables (${tables.length}) ---`);
  for (const { table: t } of schema) {
    if (!WRITE) {
      console.log(`  [PLAN] ${t.$id} (${t.name}) rowSecurity=${!!t.rowSecurity} perms=${JSON.stringify(t.$permissions || [])}`);
      bump('tables', OK);
      continue;
    }
    try {
      await withRetry(() => dstDb.createTable({
        databaseId: dstDbId,
        tableId: t.$id,
        name: t.name,
        permissions: t.$permissions || [],
        rowSecurity: !!t.rowSecurity,
        enabled: t.enabled !== false,
      }), `table ${t.$id}`);
      console.log(`  [OK]   ${t.$id}`);
      bump('tables', OK);
    } catch (e) {
      if (isAlreadyExists(e)) { console.log(`  [SKIP] ${t.$id} already exists`); bump('tables', SKIP); }
      else { console.error(`  [ERR]  ${t.$id}: ${describeErr(e)}`); bump('tables', FAIL); }
    }
  }

  // Step 2 — columns
  console.log(`\n--- Step 2: columns (${totalCols}) ---`);
  for (const { table: t, columns } of schema) {
    console.log(`  ${t.$id}: ${columns.length} column(s)`);
    for (const col of columns) {
      const label = `${col.key} (${col.type}${col.format ? '/' + col.format : ''}${col.array ? '[]' : ''})`;
      if (!WRITE) { console.log(`     [PLAN] ${label}`); bump('columns', OK); continue; }
      try {
        await withRetry(() => createColumn(dstDb, dstDbId, t.$id, col), `${t.$id}.${col.key}`);
        console.log(`     [OK]   ${label}`);
        bump('columns', OK);
      } catch (e) {
        if (isAlreadyExists(e)) { console.log(`     [SKIP] ${col.key} already exists`); bump('columns', SKIP); }
        else { console.error(`     [ERR]  ${label}: ${describeErr(e)}`); bump('columns', FAIL); }
      }
    }
    // Indexes cannot be built over attributes that are still provisioning.
    if (WRITE) {
      try {
        await waitForColumns(dstDb, dstDbId, t.$id, columns.map((c) => c.key));
      } catch (e) {
        // Appwrite occasionally wedges a single column in `processing` forever. That
        // must not abort the whole migration — skip this table's indexes and keep
        // going, so a re-run has only this one table left to repair.
        console.error(`     [ERR]  ${e.message}`);
        console.error(`     [ERR]  skipping indexes for ${t.$id} — delete the stuck column in the Appwrite console, then re-run this script.`);
        notReady.add(t.$id);
        bump('columns', FAIL);
      }
    }
  }

  // Step 3 — indexes
  console.log(`\n--- Step 3: indexes (${totalIdx}) ---`);
  for (const { table: t, indexes } of schema) {
    if (!indexes.length) continue;
    if (notReady.has(t.$id)) {
      console.error(`  ${t.$id}: SKIPPED ${indexes.length} index(es) — columns not ready`);
      indexes.forEach(() => bump('indexes', FAIL));
      continue;
    }
    console.log(`  ${t.$id}: ${indexes.length} index(es)`);
    for (const idx of indexes) {
      const label = `${idx.key} (${idx.type}) on [${idx.columns.join(',')}]`;
      if (!WRITE) { console.log(`     [PLAN] ${label}`); bump('indexes', OK); continue; }
      try {
        await withRetry(() => dstDb.createIndex({
          databaseId: dstDbId,
          tableId: t.$id,
          key: idx.key,
          type: idx.type,
          columns: idx.columns,
          orders: indexOrders(idx),
          lengths: indexLengths(idx),
        }), `${t.$id}.${idx.key}`);
        console.log(`     [OK]   ${label}`);
        bump('indexes', OK);
      } catch (e) {
        if (isAlreadyExists(e)) { console.log(`     [SKIP] ${idx.key} already exists`); bump('indexes', SKIP); }
        else { console.error(`     [ERR]  ${label}: ${describeErr(e)}`); bump('indexes', FAIL); }
      }
    }
  }

  // Step 4 — rows (only the two tables that must carry data)
  console.log('\n--- Step 4: rows ---');
  for (const tableId of [CONFIG_TABLE_ID, COUNTERS_TABLE_ID]) {
    const zeroed = tableId === COUNTERS_TABLE_ID;
    console.log(`  ${tableId}${zeroed ? '  (totals forced to 0)' : '  (verbatim)'}`);

    let cursor;
    for (;;) {
      const queries = [Query.limit(100)];
      if (cursor) queries.push(Query.cursorAfter(cursor));

      let page;
      try {
        page = await srcDb.listRows({ databaseId: srcDbId, tableId, queries });
      } catch (e) {
        console.error(`     [ERR]  could not read source rows: ${describeErr(e)}`);
        bump('rows', FAIL);
        break;
      }
      if (!page.rows || !page.rows.length) break;

      for (const row of page.rows) {
        const data = rowDataFor(tableId, row);
        const shown = zeroed ? `${data.id} (${data.type}) totals=0` : data.key;
        if (!WRITE) { console.log(`     [PLAN] ${row.$id} ${shown}`); bump('rows', OK); continue; }
        try {
          await withRetry(() => dstDb.createRow({
            databaseId: dstDbId,
            tableId,
            rowId: row.$id,
            data,
            permissions: Array.isArray(row.$permissions) ? row.$permissions : undefined,
          }), `row ${tableId}/${row.$id}`);
          console.log(`     [OK]   ${row.$id} ${shown}`);
          bump('rows', OK);
        } catch (e) {
          if (isAlreadyExists(e)) { console.log(`     [SKIP] ${row.$id} already exists`); bump('rows', SKIP); }
          else { console.error(`     [ERR]  ${row.$id}: ${describeErr(e)}`); bump('rows', FAIL); }
        }
      }

      if (page.rows.length < 100) break;
      cursor = page.rows[page.rows.length - 1].$id;
    }
  }

  // Step 5 — bootstrap admin in the target project's Auth, then its users_meta row
  console.log('\n--- Step 5: bootstrap admin ---');
  if (!WRITE) {
    console.log(`  [PLAN] auth user ${ADMIN.email} (name="${ADMIN.name}", labels=["admin"])`);
    console.log(`  [PLAN] ${USERS_META_TABLE_ID} row, $id = the generated auth user id, role=admin commission=2`);
    bump('admin', OK);
    bump('admin', OK);
  } else {
    let userId = null;
    try {
      // Re-runs must not create a second admin. Appwrite would reject the duplicate
      // email anyway, but looking it up first also recovers the id we need.
      const existing = await withRetry(
        () => dstUsers.list({ queries: [Query.equal('email', ADMIN.email), Query.limit(1)] }),
        'lookup admin user'
      );
      if (existing.users.length) {
        userId = existing.users[0].$id;
        console.log(`  [SKIP] auth user ${ADMIN.email} already exists (${userId})`);
        bump('admin', SKIP);
      } else {
        const created = await withRetry(() => dstUsers.create({
          userId: ID.unique(),
          email: ADMIN.email,
          password: ADMIN.password,
          name: ADMIN.name,
        }), 'create admin user');
        userId = created.$id;
        console.log(`  [OK]   auth user ${ADMIN.email} created — userId=${userId}`);
        bump('admin', OK);
      }
      // Idempotent: sets the label list outright rather than appending.
      await withRetry(() => dstUsers.updateLabels({ userId, labels: ['admin'] }), 'set admin labels');
      console.log(`  [OK]   labels ["admin"] applied to ${userId}`);
    } catch (e) {
      console.error(`  [ERR]  admin auth user: ${describeErr(e)}`);
      bump('admin', FAIL);
    }

    if (userId) {
      try {
        await withRetry(() => dstDb.createRow({
          databaseId: dstDbId,
          tableId: USERS_META_TABLE_ID,
          rowId: userId,          // $id must equal userId — ownership checks compare both
          data: adminRowData(userId),
        }), `users_meta row ${userId}`);
        console.log(`  [OK]   ${USERS_META_TABLE_ID} row ${userId} (role=admin)`);
        bump('admin', OK);
      } catch (e) {
        if (isAlreadyExists(e)) { console.log(`  [SKIP] ${USERS_META_TABLE_ID} row ${userId} already exists`); bump('admin', SKIP); }
        else { console.error(`  [ERR]  ${USERS_META_TABLE_ID} row ${userId}: ${describeErr(e)}`); bump('admin', FAIL); }
      }
      console.log(`\n  Admin login: ${ADMIN.email}  (userId ${userId})`);
    }
  }

  return stats;
}

// ---------------------------------------------------------------- self test

function selftest() {
  const assert = require('assert');

  const cfgRow = {
    $id: 'abc', $createdAt: 'x', $updatedAt: 'x', $permissions: [], $databaseId: 'd',
    $tableId: 't', $collectionId: 't', $sequence: 7n,
    key: 'min_commission', type: 'integer', description: 'd', val: '0',
  };
  assert.deepStrictEqual(
    rowDataFor(CONFIG_TABLE_ID, cfgRow),
    { key: 'min_commission', type: 'integer', description: 'd', val: '0' },
    'config rows must copy verbatim with all $-prefixed system fields stripped'
  );

  const counterRow = { $id: 'c1', $sequence: 3n, id: 'totalAmountReceived', totals: 11996679739, type: 'amount' };
  assert.deepStrictEqual(
    rowDataFor(COUNTERS_TABLE_ID, counterRow),
    { id: 'totalAmountReceived', totals: 0, type: 'amount' },
    'counter rows must keep id/type but reset totals to 0'
  );
  assert.strictEqual(rowDataFor(COUNTERS_TABLE_ID, { id: 'x', totals: 0, type: 'count' }).totals, 0);

  // Index shaping: all-zero lengths and empty orders mean "unset", not "send [0]".
  assert.strictEqual(indexLengths({ lengths: [0, 0] }), undefined);
  assert.deepStrictEqual(indexLengths({ lengths: [0, 64] }), [0, 64]);
  assert.strictEqual(indexLengths({}), undefined);
  assert.strictEqual(indexOrders({ orders: [] }), undefined);
  assert.deepStrictEqual(indexOrders({ orders: ['asc', 'desc'] }), ['ASC', 'DESC']);

  // Optional columns must omit the default, not send null.
  assert.strictEqual(u(null), undefined);
  assert.strictEqual(u(0), 0);
  assert.strictEqual(u(false), false);

  // Admin row: $id === userId is the whole point, and nullable fields stay absent.
  const admin = adminRowData('abc123');
  assert.strictEqual(admin.userId, 'abc123');
  assert.strictEqual(admin.role, 'admin');
  assert.strictEqual(admin.status, true);
  assert.strictEqual(admin.commission, 2);
  assert.deepStrictEqual(admin.labels, ['admin']);
  assert.ok(!('parentId' in admin), 'parentId must be omitted, not sent as null');
  assert.ok(!('assigned_to' in admin), 'assigned_to must be omitted, not sent as null');

  console.log('selftest: all assertions passed');
}

// ---------------------------------------------------------------- main

(async () => {
  if (process.argv.includes('--selftest')) return selftest();

  const { src, dst } = creds();

  console.log('Appwrite DB migration — schema for all tables, rows for app_config + dashboard_counters.');
  console.log(WRITE ? '\nMODE: WRITE — changes will be made to the target.' : '\nMODE: DRY RUN — nothing will be written. Re-run with --write to apply.');
  console.log(`  SOURCE: ${src.endpoint}  project=${src.projectId}  db=${src.databaseId}`);
  console.log(`  TARGET: ${dst.endpoint}  project=${dst.projectId}  db=${dst.databaseId}`);

  const srcDb = buildDb(src);
  const dstDb = buildDb(dst);
  const dstUsers = new Users(buildClient(dst));

  try {
    await dstDb.get({ databaseId: dst.databaseId });
  } catch (e) {
    throw new Error(`Target database "${dst.databaseId}" is not reachable: ${describeErr(e)}\nCreate the database in the Appwrite console first — this script will not create it.`);
  }

  const stats = await migrate(srcDb, src.databaseId, dstDb, dst.databaseId, dstUsers);

  console.log('\n--- Summary ---');
  for (const [k, [ok, skipped, failed]] of Object.entries(stats)) {
    console.log(`  ${k.padEnd(8)} ${WRITE ? 'created' : 'planned'}=${ok} skipped=${skipped} failed=${failed}`);
  }

  const failures = Object.values(stats).reduce((n, [, , f]) => n + f, 0);
  if (failures) {
    console.error(`\nFinished with ${failures} failure(s) — review the [ERR] lines above, then re-run (existing items are skipped).`);
    process.exitCode = 1;
  } else if (!WRITE) {
    console.log('\nDry run complete. Re-run with --write to apply.');
  } else {
    console.log('\nDone. Re-run without --write: everything should report [SKIP].');
  }
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
