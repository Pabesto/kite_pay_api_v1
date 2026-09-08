// dedupe-config.js — one-off cleanup for duplicate keys in the app config collection.
//
// Cause: ConfigManager.getConfig() used to list the config collection without a
// Query.limit, so only Appwrite's default 25 docs were cached. getRawDoc() returned
// null for every key past #25, and set() / admin POST /config then CREATED a second
// row instead of updating the existing one (e.g. payout_max_pending as both 100 and 200).
// The read path is fixed in configManager.js; this removes the rows already written.
//
// Keeps, per key, the most recently updated doc — a doc carrying a `type` wins over one
// without, since set() writes no type and would otherwise leave the key unparsed.
// Deletes the rest.
//
// Dry run (default):  node scripts/dedupe-config.js
// Apply:              node scripts/dedupe-config.js --write

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Databases, Query } = require('node-appwrite');

const {
  APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID,
} = process.env;

for (const [k, v] of Object.entries({
  APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID,
})) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

const WRITE = process.argv.includes('--write');

const databases = new Databases(
  new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY)
);

// Same ranking the fixed getConfig() uses, plus the type tie-break.
const better = (a, b) => {
  const aType = !!a.type, bType = !!b.type;
  if (aType !== bType) return aType ? a : b;
  return String(a.$updatedAt || '') >= String(b.$updatedAt || '') ? a : b;
};

(async () => {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const q = [Query.limit(100), Query.orderAsc('$id')];
    if (cursor) q.push(Query.cursorAfter(cursor));
    const res = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID, q);
    all.push(...res.documents);
    if (res.documents.length < 100) break;
    cursor = res.documents[res.documents.length - 1].$id;
  }

  const groups = new Map();
  for (const doc of all) {
    if (!groups.has(doc.key)) groups.set(doc.key, []);
    groups.get(doc.key).push(doc);
  }

  const dupeKeys = [...groups.entries()].filter(([, docs]) => docs.length > 1);
  console.log(`Scanned ${all.length} config docs / ${groups.size} distinct keys.`);
  if (!dupeKeys.length) { console.log('No duplicates found. Nothing to do.'); return; }

  let deleted = 0, failed = 0;
  for (const [key, docs] of dupeKeys) {
    const keep = docs.reduce(better);
    const drop = docs.filter((d) => d.$id !== keep.$id);
    console.log(`\n${key}  (${docs.length} rows)`);
    console.log(`  KEEP  ${keep.$id}  val=${JSON.stringify(keep.val ?? keep.value)} type=${keep.type || '(none)'} updated=${keep.$updatedAt}`);
    for (const d of drop) {
      console.log(`  DROP  ${d.$id}  val=${JSON.stringify(d.val ?? d.value)} type=${d.type || '(none)'} updated=${d.$updatedAt}`);
      if (!WRITE) continue;
      try {
        await databases.deleteDocument(APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID, d.$id);
        deleted++;
      } catch (err) { failed++; console.error(`  ! delete failed: ${err.message}`); }
    }
  }

  console.log(`\n${WRITE ? 'Applied' : 'DRY RUN'} — keys with duplicates: ${dupeKeys.length}, rows deleted: ${deleted}, failed: ${failed}`);
  if (!WRITE) console.log('Re-run with --write to apply.');
})().catch((err) => { console.error(err); process.exit(1); });
