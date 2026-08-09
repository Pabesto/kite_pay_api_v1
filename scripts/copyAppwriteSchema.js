// copyAppwriteSchema.js — copies tables, columns, and indexes from one Appwrite
// database into another. Optionally also copies rows for tables you list in
// TABLES_TO_COPY_ROWS. Standalone — does not import anything from this project.
//     node scripts/copyAppwriteSchema.js

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

// Tables for which rows should be copied (in addition to schema).
// Paste the table IDs (the same value as $id, e.g. "users", "transactions").
// Leave the array empty to skip row copying entirely.
const TABLES_TO_COPY_ROWS = [
  '68a73217002ed987b246',
  'dashboard_counters',
  // 'tableId1',
  // 'tableId2',
];
// ========================================================

const {
  Client,
  TablesDB,
  Query,
  RelationMutate,
} = require('node-appwrite');

function validateCreds(label, c) {
  for (const k of ['endpoint', 'projectId', 'apiKey', 'databaseId']) {
    if (!c[k] || String(c[k]).startsWith('PUT_')) {
      throw new Error(`${label}.${k} is not set — fill in the SOURCE/TARGET block at the top of the script.`);
    }
  }
}

function buildClient({ endpoint, projectId, apiKey }) {
  const c = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  return new TablesDB(c);
}

function isAlreadyExists(err) {
  if (!err) return false;
  if (err.code === 409) return true;
  const m = String(err.message || '').toLowerCase();
  return m.includes('already exists') || m.includes('attribute_already_exists') || m.includes('index_already_exists');
}

function describeErr(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.code)     parts.push(`code=${err.code}`);
  if (err.type)     parts.push(`type=${err.type}`);
  if (err.message)  parts.push(err.message);
  if (err.response) parts.push(`response=${JSON.stringify(err.response)}`);
  return parts.join(' | ');
}

async function listAllTables(db, databaseId) {
  const out = [];
  let cursor;
  while (true) {
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

async function listAllColumns(db, databaseId, tableId) {
  const res = await db.listColumns({ databaseId, tableId, queries: [Query.limit(5000)] });
  return res.columns || [];
}

async function listAllIndexes(db, databaseId, tableId) {
  const res = await db.listIndexes({ databaseId, tableId, queries: [Query.limit(500)] });
  return res.indexes || [];
}

const req = (col) => !!col.required;
const arr = (col) => !!col.array;
const u   = (v) => (v === null ? undefined : v); // null -> undefined (Appwrite API rejects null on optional fields)
const def = (col) => u(col.default);

async function createColumn(db, databaseId, tableId, col) {
  const t   = (col.type   || '').toLowerCase();
  const fmt = (col.format || '').toLowerCase();

  if (t === 'string') {
    if (fmt === 'email') {
      return db.createEmailColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col) });
    }
    if (fmt === 'url') {
      return db.createUrlColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col) });
    }
    if (fmt === 'ip') {
      return db.createIpColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col) });
    }
    if (fmt === 'enum') {
      return db.createEnumColumn({ databaseId, tableId, key: col.key, elements: col.elements || [], required: req(col), xdefault: def(col), array: arr(col) });
    }
    return db.createStringColumn({
      databaseId, tableId,
      key: col.key,
      size: col.size,
      required: req(col),
      xdefault: def(col),
      array: arr(col),
      encrypt: !!col.encrypt,
    });
  }
  if (t === 'integer') {
    return db.createIntegerColumn({
      databaseId, tableId,
      key: col.key, required: req(col),
      min: u(col.min), max: u(col.max), xdefault: def(col), array: arr(col),
    });
  }
  if (t === 'double' || t === 'float') {
    return db.createFloatColumn({
      databaseId, tableId,
      key: col.key, required: req(col),
      min: u(col.min), max: u(col.max), xdefault: def(col), array: arr(col),
    });
  }
  if (t === 'boolean') {
    return db.createBooleanColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col) });
  }
  if (t === 'datetime') {
    return db.createDatetimeColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col) });
  }
  if (t === 'point') {
    return db.createPointColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col) });
  }
  if (t === 'line') {
    return db.createLineColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col) });
  }
  if (t === 'polygon') {
    return db.createPolygonColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col) });
  }
  if (t === 'varchar') {
    return db.createVarcharColumn({ databaseId, tableId, key: col.key, size: col.size, required: req(col), xdefault: def(col), array: arr(col), encrypt: !!col.encrypt });
  }
  if (t === 'text') {
    return db.createTextColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col), encrypt: !!col.encrypt });
  }
  if (t === 'mediumtext') {
    return db.createMediumtextColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col), encrypt: !!col.encrypt });
  }
  if (t === 'longtext') {
    return db.createLongtextColumn({ databaseId, tableId, key: col.key, required: req(col), xdefault: def(col), array: arr(col), encrypt: !!col.encrypt });
  }
  throw new Error(`Unsupported column type "${col.type}" for column "${col.key}"`);
}

async function createRelationship(db, databaseId, tableId, col) {
  if (col.side && col.side !== 'parent') {
    return { skipped: true, reason: 'child side — created by parent automatically' };
  }
  return db.createRelationshipColumn({
    databaseId,
    tableId,
    relatedTableId: col.relatedTable,
    type: col.relationType,
    twoWay: !!col.twoWay,
    key: col.key,
    twoWayKey: col.twoWayKey || undefined,
    onDelete: col.onDelete || RelationMutate.Restrict,
  });
}

async function waitForColumns(db, databaseId, tableId, expectedKeys, { timeoutMs = 90000, intervalMs = 1000 } = {}) {
  if (!expectedKeys.length) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cols = await listAllColumns(db, databaseId, tableId);
    const ready = new Set(cols.filter((c) => c.status === 'available').map((c) => c.key));
    const failed = cols.filter((c) => c.status === 'failed' || c.status === 'stuck');
    if (failed.length) {
      throw new Error(`Columns failed on ${tableId}: ${failed.map((c) => `${c.key}(${c.status}: ${c.error || ''})`).join(', ')}`);
    }
    if (expectedKeys.every((k) => ready.has(k))) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for columns to become available on ${tableId}`);
}

async function copySchema(srcDb, srcDbId, dstDb, dstDbId) {
  console.log('\n--- Listing tables in source ---');
  const tables = await listAllTables(srcDb, srcDbId);
  console.log(`Found ${tables.length} table(s).`);
  tables.forEach((t) => console.log(`  - ${t.$id}  (${t.name})`));

  // 1) create tables
  console.log('\n--- Step 1: create tables on target ---');
  for (const t of tables) {
    try {
      await dstDb.createTable({
        databaseId: dstDbId,
        tableId: t.$id,
        name: t.name,
        permissions: t.$permissions || [],
        rowSecurity: !!t.rowSecurity,
        enabled: t.enabled !== false,
      });
      console.log(`  [OK]   table ${t.$id}`);
    } catch (e) {
      if (isAlreadyExists(e)) console.log(`  [SKIP] table ${t.$id} already exists`);
      else throw e;
    }
  }

  // 2) non-relationship columns
  console.log('\n--- Step 2: create non-relationship columns ---');
  const deferred = [];
  for (const t of tables) {
    const cols = await listAllColumns(srcDb, srcDbId, t.$id);
    const nonRel = cols.filter((c) => (c.type || '').toLowerCase() !== 'relationship');
    cols
      .filter((c) => (c.type || '').toLowerCase() === 'relationship')
      .forEach((r) => deferred.push({ tableId: t.$id, col: r }));

    console.log(`  ${t.$id}: ${nonRel.length} column(s)`);
    for (const col of nonRel) {
      try {
        await createColumn(dstDb, dstDbId, t.$id, col);
        console.log(`     [OK]   ${col.key}  (${col.type}${col.format ? '/' + col.format : ''}${arr(col) ? '[]' : ''})`);
      } catch (e) {
        if (isAlreadyExists(e)) console.log(`     [SKIP] ${col.key} already exists`);
        else console.error(`     [ERR]  ${col.key} (${col.type}${col.format ? '/' + col.format : ''}): ${describeErr(e)}`);
      }
    }
    await waitForColumns(dstDb, dstDbId, t.$id, nonRel.map((c) => c.key));
  }

  // 3) relationship columns (after all tables + base columns exist)
  if (deferred.length) {
    console.log('\n--- Step 3: create relationship columns ---');
    for (const { tableId, col } of deferred) {
      try {
        const r = await createRelationship(dstDb, dstDbId, tableId, col);
        if (r && r.skipped) {
          console.log(`     [SKIP] ${tableId}.${col.key} (${r.reason})`);
        } else {
          console.log(`     [OK]   ${tableId}.${col.key} -> ${col.relatedTable} (${col.relationType}${col.twoWay ? ', two-way' : ''})`);
        }
      } catch (e) {
        if (isAlreadyExists(e)) console.log(`     [SKIP] ${tableId}.${col.key} already exists`);
        else console.error(`     [ERR]  ${tableId}.${col.key}: ${describeErr(e)}`);
      }
    }
    for (const t of tables) {
      const expected = (await listAllColumns(srcDb, srcDbId, t.$id)).map((c) => c.key);
      try {
        await waitForColumns(dstDb, dstDbId, t.$id, expected, { timeoutMs: 120000 });
      } catch (e) {
        console.warn(`  [WARN] ${t.$id}: ${e.message}`);
      }
    }
  }

  // 4) indexes
  console.log('\n--- Step 4: create indexes ---');
  for (const t of tables) {
    const indexes = await listAllIndexes(srcDb, srcDbId, t.$id);
    if (!indexes.length) continue;
    console.log(`  ${t.$id}: ${indexes.length} index(es)`);
    for (const idx of indexes) {
      try {
        await dstDb.createIndex({
          databaseId: dstDbId,
          tableId: t.$id,
          key: idx.key,
          type: idx.type,
          columns: idx.columns,
          orders: idx.orders && idx.orders.length ? idx.orders : undefined,
          lengths: idx.lengths && idx.lengths.length ? idx.lengths : undefined,
        });
        console.log(`     [OK]   ${idx.key} (${idx.type}) on [${idx.columns.join(',')}]`);
      } catch (e) {
        if (isAlreadyExists(e)) console.log(`     [SKIP] ${idx.key} already exists`);
        else console.error(`     [ERR]  ${idx.key}: ${describeErr(e)}`);
      }
    }
  }
}

// Strip Appwrite-managed system fields out of a row's data before writing it back.
// Keep only the user-defined column values. $id and $permissions are passed
// separately on createRow.
const SYSTEM_FIELDS = new Set([
  '$id', '$createdAt', '$updatedAt', '$permissions',
  '$databaseId', '$tableId', '$collectionId', '$sequence',
]);

function stripSystemFields(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    if (SYSTEM_FIELDS.has(k)) continue;
    const v = row[k];
    // Skip resolved relationship payloads — they come back as nested row objects
    // (or arrays of them). Recreating them on the target would fail because the
    // related row doesn't exist yet; the relationship is rebuilt by the
    // relationship column itself once both sides exist.
    if (v && typeof v === 'object' && !Array.isArray(v) && '$id' in v) continue;
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && '$id' in v[0]) continue;
    out[k] = v;
  }
  return out;
}

async function copyRows(srcDb, srcDbId, dstDb, dstDbId, tableIds) {
  if (!tableIds || !tableIds.length) {
    console.log('\n--- Step 5: copy rows --- (skipped, TABLES_TO_COPY_ROWS is empty)');
    return;
  }

  console.log(`\n--- Step 5: copy rows for ${tableIds.length} table(s) ---`);

  for (const tableId of tableIds) {
    console.log(`\n  Table: ${tableId}`);

    let total = 0;
    try {
      const head = await srcDb.listRows({ databaseId: srcDbId, tableId, queries: [Query.limit(1)] });
      total = head.total || 0;
    } catch (e) {
      console.error(`     [ERR]  could not read source table "${tableId}": ${describeErr(e)}`);
      continue;
    }
    console.log(`     source has ${total} row(s)`);

    let copied = 0, skipped = 0, failed = 0;
    let cursor;
    const PAGE = 100;

    while (true) {
      const queries = [Query.limit(PAGE)];
      if (cursor) queries.push(Query.cursorAfter(cursor));

      let page;
      try {
        page = await srcDb.listRows({ databaseId: srcDbId, tableId, queries });
      } catch (e) {
        console.error(`     [ERR]  listRows failed: ${describeErr(e)}`);
        break;
      }
      if (!page.rows || !page.rows.length) break;

      for (const row of page.rows) {
        const rowId = row.$id;
        const data = stripSystemFields(row);
        const permissions = Array.isArray(row.$permissions) ? row.$permissions : undefined;
        try {
          await dstDb.createRow({
            databaseId: dstDbId,
            tableId,
            rowId,
            data,
            permissions,
          });
          copied++;
        } catch (e) {
          if (isAlreadyExists(e)) {
            skipped++;
          } else {
            failed++;
            console.error(`     [ERR]  row ${rowId}: ${describeErr(e)}`);
          }
        }
      }

      // progress every page
      console.log(`     ...progress: copied=${copied} skipped=${skipped} failed=${failed} (of ${total})`);

      if (page.rows.length < PAGE) break;
      cursor = page.rows[page.rows.length - 1].$id;
    }

    console.log(`     done: copied=${copied} skipped=${skipped} failed=${failed}`);
  }
}

(async () => {
  try {
    console.log('Appwrite schema copy — tables + columns + indexes (rows only for tables you list).');

    validateCreds('SOURCE', SOURCE);
    validateCreds('TARGET', TARGET);

    if (
      SOURCE.endpoint   === TARGET.endpoint   &&
      SOURCE.projectId  === TARGET.projectId  &&
      SOURCE.databaseId === TARGET.databaseId
    ) {
      throw new Error('Source and target point to the same database — refusing to run.');
    }

    console.log('\nCopying:');
    console.log(`  SOURCE: ${SOURCE.endpoint}  project=${SOURCE.projectId}  db=${SOURCE.databaseId}`);
    console.log(`  TARGET: ${TARGET.endpoint}  project=${TARGET.projectId}  db=${TARGET.databaseId}`);

    const srcDb = buildClient(SOURCE);
    const dstDb = buildClient(TARGET);

    await copySchema(srcDb, SOURCE.databaseId, dstDb, TARGET.databaseId);

    await copyRows(srcDb, SOURCE.databaseId, dstDb, TARGET.databaseId, TABLES_TO_COPY_ROWS);

    console.log('\nDone.');
  } catch (e) {
    console.error('\nFailed:', e.message);
    process.exitCode = 1;
  }
})();
