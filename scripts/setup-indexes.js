// setup-indexes.js — creates the missing indexes identified by auditing every
// listDocuments() call in this codebase against the indexes that actually exist.
//
// Dry-run by default. Nothing is written without --write.
//
//   node scripts/setup-indexes.js                    # plan only, writes nothing
//   node scripts/setup-indexes.js --write            # create everything
//   node scripts/setup-indexes.js --tier=P0 --write  # just the broken-today fixes
//   node scripts/setup-indexes.js --selftest         # offline logic check, no creds
//
// Tiers:
//   P0  fixes queries that are broken or full-scanning ~51k rows on a money path
//   P1  hot list endpoints with no usable index
//   P2  unique constraints that close known duplicate bugs
//   P3  small tables today, but they only grow
//
// Run this against the NEW project first, while its tables are empty — every index
// builds instantly. On the live database the six webhook_data indexes build over
// ~51k rows, so run that during low traffic.
//
// Safe to re-run: an existing index (Appwrite 409) is treated as a skip.

// =====================  EDIT THIS  =====================
// The database to index. Swap these four values to point at the other project.

const TARGET = {
  endpoint:   'https://sgp.cloud.appwrite.io/v1',
  projectId:  '6a788fcd001d540868ef',
  apiKey:     'standard_0e2204b5f230c3d9c08735b1afedb9a86aa64f90765f3b0dde25efd15c5cf504c522c7081e2974e829796c65f107dc3bb987ef798c00cdf4986fff2a2ed945f5636f4a051bfa4e28e49c353a4e4b9c2c664622f873429a46e83f851106c19d01e2c5d895f364ac63b1aa288726a5f8eeb6a7a3d99c84c8d74f860a3d9aaf9170',
  databaseId: '6a789095000fcaf71dd7',
};

// ========================================================

// Table ids are identical across projects (the migration preserves them).
const WEBHOOK_DATA     = '688cf5920023475022df';
const QR_CODES         = '688f6b46002963a163aa';
const WITHDRAWALS      = '68920fba001e27b604c9';
const USERS_META       = 'users_meta_test';
const DAILY_QR_SUMM    = 'daily_qr_summaries';
const WALLET           = 'wallet';
const WD_ACCOUNTS      = 'withdrawal_accounts';
const MANUAL_HOLD      = 'manual_hold_transactions';
const API_MERCHANTS    = 'api_merchants';
const API_MERCH_REQ    = 'api_merchants_requests';
const PARTNER_DELIVERY = 'partner_webhook_deliveries';

// `lengths` is required only for columns whose Appwrite type is `text` (MariaDB
// TEXT cannot be indexed without a prefix length), and for very wide varchars that
// would otherwise blow the 3072-byte index key limit. Plain string(<=255) columns
// must NOT carry a length — Appwrite rejects it.
//
// Verified against a live run: `key` indexes over `text` columns build fine with a
// prefix length, but a `unique` index over a `text` column always fails. Never pair
// type:'unique' with a text column here.
const INDEXES = [
  // ── P0 ──────────────────────────────────────────────────────────────────────
  // searchField=qrCodeId is advertised by admin AND partner /transactions and routed
  // to Query.search, but qrCodeId has no index at all — Appwrite rejects the query.
  { tier: 'P0', table: WEBHOOK_DATA, key: 'idx_qrCodeId_ft', type: 'fulltext', columns: ['qrCodeId'],
    why: 'searchField=qrCodeId — currently errors, no index exists' },

  // payment_id_index is type `key`: it serves Query.equal (the webhook idempotency
  // check) but cannot serve Query.search. Both index types are needed.
  { tier: 'P0', table: WEBHOOK_DATA, key: 'idx_paymentId_ft', type: 'fulltext', columns: ['paymentId'],
    why: 'searchField=paymentId — existing payment_id_index is `key`, not fulltext' },

  // rrn_number_index is fulltext, which cannot satisfy an equality predicate. Both
  // apiMerchants.js:288 (payment verification) and admin.js:2771 (duplicate guard)
  // do Query.equal on rrnNumber and full-scan ~51k rows while holding a lock.
  { tier: 'P0', table: WEBHOOK_DATA, key: 'idx_rrnNumber_key', type: 'key', columns: ['rrnNumber'],
    why: 'Query.equal(rrnNumber) on the verify + duplicate-guard money paths' },

  // ── P1 ──────────────────────────────────────────────────────────────────────
  { tier: 'P1', table: WEBHOOK_DATA, key: 'idx_qrCodeId_createdAt', type: 'key',
    columns: ['qrCodeId', 'created_at'], orders: ['ASC', 'DESC'],
    why: 'admin txn list by qr/user, employee scoping, hold-and-reset scans' },

  { tier: 'P1', table: WEBHOOK_DATA, key: 'idx_owner_createdAt', type: 'key',
    columns: ['ownerSubadminId', 'created_at'], orders: ['ASC', 'DESC'],
    why: 'partner GET /transactions — filter + sort together (supersedes idx_ownerSubadminId)' },

  { tier: 'P1', table: WEBHOOK_DATA, key: 'idx_createdAt', type: 'key',
    columns: ['created_at'], orders: ['DESC'],
    why: 'default admin list — unfiltered orderDesc(created_at) over the whole table' },

  // ── P2 ──────────────────────────────────────────────────────────────────────
  // Verified duplicate-free against live data before proposing these.
  { tier: 'P2', table: WALLET, key: 'idx_userId_unique', type: 'unique', columns: ['userId'],
    why: 'closes the known "wallet get-or-create can duplicate wallet docs" bug' },

  { tier: 'P2', table: DAILY_QR_SUMM, key: 'idx_date_unique', type: 'unique', columns: ['date'],
    why: 'equal(date) on every finalize; enforces one summary per day' },

  { tier: 'P2', table: QR_CODES, key: 'idx_qrId_unique', type: 'unique', columns: ['qrId'],
    why: 'business key used in ~27 query sites; a duplicate would split a QR ledger' },

  { tier: 'P2', table: USERS_META, key: 'idx_userId_unique', type: 'unique', columns: ['userId'],
    why: 'one meta doc per user' },

  // NO INDEX on daily_deleted_summary.date — deliberately dropped, twice proven.
  // The column is `text`, so Appwrite must emit a prefix length: `date(32)`. MySQL
  // parses DATE(...) as the built-in function rather than a column prefix, and the
  // build fails with the misleading "Invalid index attribute date not found" — as
  // both `unique` and `key` did. Text columns index fine otherwise (manual_hold.qrId
  // and users_meta.assigned_to both build with a prefix); it is this column *name*
  // combined with the text type. Its sibling daily_qr_summaries.date is string(30),
  // hence no parens and no problem.
  // Not worth fixing: the table grows one row per day (29 rows after ~2 years), so
  // a scan is free. If you ever want parity, recreate `date` as string(30) — trivial
  // while the table is empty — and add a unique index then.

  { tier: 'P2', table: WITHDRAWALS, key: 'idx_id', type: 'key', columns: ['id'],
    why: 'wdh_… business id, single-doc lookup at withdraw.js:978 and 1232' },

  // ── P3 ──────────────────────────────────────────────────────────────────────
  { tier: 'P3', table: MANUAL_HOLD, key: 'idx_assignedUserId_createdAt', type: 'key',
    columns: ['assignedUserId', '$createdAt'], orders: ['ASC', 'DESC'], lengths: [64, 0], text: true,
    why: 'admin.js:3720 list; append-only audit log, 2.2k rows and growing' },

  { tier: 'P3', table: MANUAL_HOLD, key: 'idx_qrId', type: 'key', columns: ['qrId'], lengths: [64], text: true,
    why: 'per-QR hold history + hold-and-reset countBy' },

  { tier: 'P3', table: WITHDRAWALS, key: 'idx_userId_createdAt', type: 'key',
    columns: ['userId', '$createdAt'], orders: ['ASC', 'DESC'], why: 'user withdrawal history' },

  { tier: 'P3', table: WITHDRAWALS, key: 'idx_status_createdAt', type: 'key',
    columns: ['status', '$createdAt'], orders: ['ASC', 'DESC'], why: 'admin pending list' },

  { tier: 'P3', table: WITHDRAWALS, key: 'idx_userId_status', type: 'key',
    columns: ['userId', 'status'], why: 'pending-count guard at withdraw.js:320' },

  { tier: 'P3', table: WD_ACCOUNTS, key: 'idx_userId_createdAt', type: 'key',
    columns: ['userId', '$createdAt'], orders: ['ASC', 'DESC'],
    why: 'exactly the query at withdrawalAccounts.js:24' },

  // Composite leads with assignedUserId, so a separate single-column index on it
  // would be a redundant prefix — deliberately not created.
  { tier: 'P3', table: QR_CODES, key: 'idx_assignedUserId_createdAt', type: 'key',
    columns: ['assignedUserId', 'createdAt'], orders: ['ASC', 'DESC'], why: 'role-scoped QR listing' },

  { tier: 'P3', table: QR_CODES, key: 'idx_managedByUserId', type: 'key', columns: ['managedByUserId'],
    why: 'subadmin-managed QR listing' },

  { tier: 'P3', table: QR_CODES, key: 'idx_createdByUserId', type: 'key', columns: ['createdByUserId'],
    why: 'creator-scoped QR listing' },

  { tier: 'P3', table: USERS_META, key: 'idx_parentId_role', type: 'key', columns: ['parentId', 'role'],
    why: 'dominant scoping pair — parentId x14, role x10 across the codebase' },

  { tier: 'P3', table: USERS_META, key: 'idx_assigned_to', type: 'key', columns: ['assigned_to'],
    lengths: [64], text: true, why: 'employee scoping; `assigned_to` is a text column' },

  { tier: 'P3', table: API_MERCHANTS, key: 'idx_merchantId_unique', type: 'unique',
    columns: ['merchantId'], lengths: [255],
    why: 'empty table, free to add; string(999) needs a prefix to stay under the key-size limit' },

  { tier: 'P3', table: API_MERCH_REQ, key: 'idx_merchantId_orderId', type: 'key',
    columns: ['merchantId', 'orderId'], why: 'apiMerchants.js:245 lookup' },

  { tier: 'P3', table: PARTNER_DELIVERY, key: 'idx_status_createdAt', type: 'key',
    columns: ['status', 'createdAt'], why: 'retention sweep at partnerWebhooks.js:269' },
];

const { Client, TablesDB, Query } = require('node-appwrite');

const WRITE = process.argv.includes('--write');

// --tier=P0 or --tier=P0,P1 — omit to run every tier.
function selectedTiers() {
  const arg = process.argv.find((a) => a.startsWith('--tier='));
  if (!arg) return null;
  const tiers = arg.slice('--tier='.length).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const valid = new Set(['P0', 'P1', 'P2', 'P3']);
  const bad = tiers.filter((t) => !valid.has(t));
  if (bad.length) throw new Error(`Unknown tier(s): ${bad.join(', ')} — valid values are P0, P1, P2, P3.`);
  return tiers;
}

const filterByTier = (specs, tiers) => (tiers ? specs.filter((s) => tiers.includes(s.tier)) : specs);

// ---------------------------------------------------------------- helpers

function creds() {
  const blank = ['endpoint', 'projectId', 'apiKey', 'databaseId']
    .filter((k) => !TARGET[k] || String(TARGET[k]).startsWith('PUT_'))
    .map((k) => `TARGET.${k}`);
  if (blank.length) {
    throw new Error(`Not filled in:\n  - ${blank.join('\n  - ')}\nEdit the TARGET block at the top of this file.`);
  }
  return TARGET;
}

const isAlreadyExists = (err) => {
  if (!err) return false;
  if (err.code === 409) return true;
  return String(err.message || '').toLowerCase().includes('already exists');
};

function describeErr(err) {
  if (!err) return 'unknown error';
  return [err.code && `code=${err.code}`, err.type && `type=${err.type}`, err.message].filter(Boolean).join(' | ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Appwrite rejects `orders`/`lengths` when they are empty, and treats an all-zero
// lengths array differently from an absent one.
const shapeOrders = (spec) =>
  Array.isArray(spec.orders) && spec.orders.length ? spec.orders.map((o) => String(o).toUpperCase()) : undefined;

const shapeLengths = (spec) =>
  Array.isArray(spec.lengths) && spec.lengths.some((n) => n > 0) ? spec.lengths : undefined;

const describeSpec = (spec) =>
  `${spec.key} (${spec.type}) on [${spec.columns.join(', ')}]` +
  (spec.orders ? ` ${JSON.stringify(spec.orders)}` : '') +
  (spec.lengths ? ` lengths=${JSON.stringify(spec.lengths)}` : '');

async function indexStatus(db, databaseId, tableId, key) {
  try {
    const res = await db.listIndexes({ databaseId, tableId, queries: [Query.limit(500)] });
    return (res.indexes || []).find((i) => i.key === key)?.status || null;
  } catch {
    return null;
  }
}

// Appwrite builds indexes asynchronously. A `failed` index throws no error at query
// time — it simply never gets used — so this must be confirmed, not assumed.
async function waitForIndex(db, databaseId, tableId, key, { timeoutMs = 300000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await db.listIndexes({ databaseId, tableId, queries: [Query.limit(500)] });
    const idx = (res.indexes || []).find((i) => i.key === key);
    if (!idx) throw new Error(`index ${key} vanished from ${tableId} while building`);
    if (idx.status === 'available') return;
    if (idx.status === 'failed' || idx.status === 'stuck') {
      throw new Error(`index ${key} on ${tableId} is ${idx.status}: ${idx.error || 'no detail'}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for index ${key} on ${tableId} to become available`);
}

// ---------------------------------------------------------------- main run

async function run(db, databaseId, specs) {
  const stats = { created: 0, skipped: 0, failed: 0 };
  let currentTable = null;

  for (const spec of specs) {
    if (spec.table !== currentTable) {
      currentTable = spec.table;
      console.log(`\n  ${spec.table}`);
    }

    const label = `[${spec.tier}] ${describeSpec(spec)}`;

    if (!WRITE) {
      console.log(`     [PLAN] ${label}`);
      console.log(`            └─ ${spec.why}`);
      stats.created++;
      continue;
    }

    try {
      await withRetry(() => db.createIndex({
        databaseId,
        tableId: spec.table,
        key: spec.key,
        type: spec.type,
        columns: spec.columns,
        orders: shapeOrders(spec),
        lengths: shapeLengths(spec),
      }), `${spec.table}.${spec.key}`);
    } catch (e) {
      if (isAlreadyExists(e)) {
        // A failed index still occupies its key, so a bare "already exists → skip"
        // would report success forever and never repair it. Check what is actually
        // sitting there before calling it a skip.
        const existing = await indexStatus(db, databaseId, spec.table, spec.key);
        if (existing && existing !== 'available') {
          console.error(`     [ERR]  ${label} — an index with this key already exists but is ${existing}.`);
          console.error(`            Delete it in the Appwrite console, then re-run.`);
          stats.failed++;
        } else {
          console.log(`     [SKIP] ${label} — already exists`);
          stats.skipped++;
        }
      } else {
        console.error(`     [ERR]  ${label}: ${describeErr(e)}`);
        stats.failed++;
      }
      continue;
    }

    try {
      await waitForIndex(db, databaseId, spec.table, spec.key);
      console.log(`     [OK]   ${label}`);
      stats.created++;
    } catch (e) {
      console.error(`     [ERR]  ${e.message}`);
      stats.failed++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------- self test

function selftest() {
  const assert = require('assert');

  // Empty/absent orders and all-zero lengths must be omitted, not sent.
  assert.strictEqual(shapeOrders({}), undefined);
  assert.strictEqual(shapeOrders({ orders: [] }), undefined);
  assert.deepStrictEqual(shapeOrders({ orders: ['asc', 'desc'] }), ['ASC', 'DESC']);
  assert.strictEqual(shapeLengths({}), undefined);
  assert.strictEqual(shapeLengths({ lengths: [0, 0] }), undefined);
  assert.deepStrictEqual(shapeLengths({ lengths: [64, 0] }), [64, 0]);

  // Tier filtering.
  const specs = [{ tier: 'P0' }, { tier: 'P1' }, { tier: 'P3' }];
  assert.strictEqual(filterByTier(specs, null).length, 3);
  assert.strictEqual(filterByTier(specs, ['P0']).length, 1);
  assert.strictEqual(filterByTier(specs, ['P0', 'P3']).length, 2);

  // Every spec must be well-formed, and orders/lengths must match column arity —
  // a mismatch is rejected by Appwrite only at create time, one index into the run.
  const seen = new Set();
  for (const s of INDEXES) {
    assert.ok(s.table && s.key && s.type && s.columns?.length, `malformed spec: ${s.key}`);
    assert.ok(['key', 'unique', 'fulltext'].includes(s.type), `bad type on ${s.key}: ${s.type}`);
    assert.ok(s.why, `spec ${s.key} is missing its rationale`);
    if (s.orders) assert.strictEqual(s.orders.length, s.columns.length, `orders arity on ${s.key}`);
    if (s.lengths) assert.strictEqual(s.lengths.length, s.columns.length, `lengths arity on ${s.key}`);
    const id = `${s.table}::${s.key}`;
    assert.ok(!seen.has(id), `duplicate index key ${id}`);
    seen.add(id);
  }

  // Fulltext indexes are single-column here; a multi-column fulltext is a mistake.
  for (const s of INDEXES.filter((x) => x.type === 'fulltext')) {
    assert.strictEqual(s.columns.length, 1, `fulltext ${s.key} must be single-column`);
  }

  // Appwrite cannot build a unique index over a `text` column — it fails async with
  // a misleading "attribute not found". Catch it here rather than one index into a
  // live run. (A prefix length alone is not the tell: api_merchants.merchantId is
  // string(999) and needs one, yet takes a unique index fine.)
  for (const s of INDEXES.filter((x) => x.text)) {
    assert.ok(s.lengths, `${s.key}: text column needs a prefix length`);
    assert.notStrictEqual(s.type, 'unique',
      `${s.table}.${s.key}: Appwrite cannot build a unique index over a text column — use type 'key'`);
  }

  console.log(`selftest: all assertions passed (${INDEXES.length} index specs validated)`);
}

// ---------------------------------------------------------------- entrypoint

(async () => {
  if (process.argv.includes('--selftest')) return selftest();

  const tiers = selectedTiers();
  const specs = filterByTier(INDEXES, tiers);
  if (!specs.length) throw new Error('No indexes selected.');

  const t = creds();

  console.log('Appwrite index setup.');
  console.log(WRITE ? '\nMODE: WRITE — indexes will be created.' : '\nMODE: DRY RUN — nothing will be written. Re-run with --write to apply.');
  console.log(`  TARGET: ${t.endpoint}  project=${t.projectId}  db=${t.databaseId}`);
  console.log(`  TIERS:  ${tiers ? tiers.join(', ') : 'all (P0, P1, P2, P3)'} — ${specs.length} index(es)`);

  const db = new TablesDB(new Client().setEndpoint(t.endpoint).setProject(t.projectId).setKey(t.apiKey));

  try {
    await db.get({ databaseId: t.databaseId });
  } catch (e) {
    throw new Error(`Target database "${t.databaseId}" is not reachable: ${describeErr(e)}`);
  }

  const stats = await run(db, t.databaseId, specs);

  console.log('\n--- Summary ---');
  console.log(`  ${WRITE ? 'created' : 'planned'}=${stats.created}  skipped=${stats.skipped}  failed=${stats.failed}`);

  if (stats.failed) {
    console.error(`\nFinished with ${stats.failed} failure(s) — review the [ERR] lines above, then re-run (existing indexes are skipped).`);
    process.exitCode = 1;
  } else if (!WRITE) {
    console.log('\nDry run complete. Re-run with --write to apply.');
  } else {
    console.log('\nDone. Re-run without --write: everything should report [SKIP].');
    console.log('Note: idx_ownerSubadminId on webhook_data is now a redundant prefix of');
    console.log('idx_owner_createdAt and can be dropped — but only after confirming the new one is available.');
  }
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
});
