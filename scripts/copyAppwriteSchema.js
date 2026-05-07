// copyAppwriteSchema.js — copies tables, columns, and indexes from one Appwrite
// database into another. Does NOT copy any rows. Standalone — does not import
// anything from this project. Fill in SOURCE and TARGET below, then:
//     node scripts/copyAppwriteSchema.js

// =====================  EDIT THESE  =====================
const SOURCE = {
  endpoint:   'https://fra.cloud.appwrite.io/v1',
  projectId:  '688c98fd002bfe3cf596',
  apiKey:     'standard_b2443fedac19c0903a7a280fbb0d121ea52353d7d81533f1b8a76dab54721871a595a87624511da1ad635336e50946caf684a8650bfe4fd4f5d9839cb916e595314f8b2921cc78dcd477e468393bcd4932616d3412da4e5cc5d6d79a4b31e391d2d5e1172eaa08a2fafc3b2b8615bc9ec57b17d70884c7b48957ccdc7d8d803a',
  databaseId: '688ca9f3003e593a6227',
};

const TARGET = {
  endpoint:   'https://fra.cloud.appwrite.io/v1',
  projectId:  '688c98fd002bfe3cf596',
  apiKey:     'standard_b2443fedac19c0903a7a280fbb0d121ea52353d7d81533f1b8a76dab54721871a595a87624511da1ad635336e50946caf684a8650bfe4fd4f5d9839cb916e595314f8b2921cc78dcd477e468393bcd4932616d3412da4e5cc5d6d79a4b31e391d2d5e1172eaa08a2fafc3b2b8615bc9ec57b17d70884c7b48957ccdc7d8d803a',
  databaseId: '69fbe5c00035ef79aae4',
};
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
const def = (col) => col.default;

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
      min: col.min, max: col.max, xdefault: def(col), array: arr(col),
    });
  }
  if (t === 'double' || t === 'float') {
    return db.createFloatColumn({
      databaseId, tableId,
      key: col.key, required: req(col),
      min: col.min, max: col.max, xdefault: def(col), array: arr(col),
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
        else console.error(`     [ERR]  ${col.key}: ${e.message}`);
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
        else console.error(`     [ERR]  ${tableId}.${col.key}: ${e.message}`);
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
        else console.error(`     [ERR]  ${idx.key}: ${e.message}`);
      }
    }
  }
}

(async () => {
  try {
    console.log('Appwrite schema copy — tables + columns + indexes only (no rows).');

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

    console.log('\nDone.');
  } catch (e) {
    console.error('\nFailed:', e.message);
    process.exitCode = 1;
  }
})();
