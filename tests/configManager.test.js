// Pins the config-cache pagination fix: a bare listDocuments() returned only Appwrite's
// default 25 docs, so getRawDoc() missed every key past #25 and set() created duplicate
// rows instead of updating (payout_max_pending existing as both 100 and 200).

const ConfigManager = require('../configManager');

const DB = 'db1';
const COL = 'config1';

// Minimal Appwrite stub: honours Query.limit + Query.cursorAfter so pagination is real.
function makeDb(docs) {
  const db = {
    docs: [...docs],
    createDocument: jest.fn(async (_d, _c, _id, data) => {
      const doc = { $id: `new_${db.docs.length}`, $updatedAt: '2026-01-09T00:00:00.000Z', ...data };
      db.docs.push(doc);
      return doc;
    }),
    updateDocument: jest.fn(async (_d, _c, id, data) => {
      const doc = db.docs.find((x) => x.$id === id);
      Object.assign(doc, data);
      return doc;
    }),
    listDocuments: jest.fn(async (_d, _c, queries = []) => {
      const joined = queries.join(' ');
      const limit = Number(/"limit","values":\[(\d+)\]/.exec(joined)?.[1] ?? 25);
      const eq = /"method":"equal","attribute":"key","values":\["([^"]+)"\]/.exec(joined)?.[1];
      const after = /"cursorAfter","values":\["([^"]+)"\]/.exec(joined)?.[1];

      let rows = [...db.docs].sort((a, b) => a.$id.localeCompare(b.$id));
      if (eq) rows = rows.filter((r) => r.key === eq);
      if (after) rows = rows.slice(rows.findIndex((r) => r.$id === after) + 1);
      return { documents: rows.slice(0, limit) };
    }),
  };
  return db;
}

const pad = (n) => String(n).padStart(3, '0');

describe('ConfigManager cache pagination', () => {
  test('caches every key past the 25-doc default page', async () => {
    // 40 keys — key_030 lives well past Appwrite's default page.
    const docs = Array.from({ length: 40 }, (_, i) => ({
      $id: `id_${pad(i)}`, $updatedAt: '2026-01-01T00:00:00.000Z',
      key: `key_${pad(i)}`, val: String(i), type: 'integer',
    }));
    const db = makeDb(docs);
    ConfigManager.init({ databases: db, APPWRITE_DATABASE_ID: DB, APPWRITE_CONFIG_COLLECTION_ID: COL });
    await ConfigManager.refresh();

    expect(ConfigManager.get('key_030')).toBe(30);
    expect(ConfigManager.getRawDoc('key_030')).not.toBeNull();
    expect(ConfigManager.getRawDocs()).toHaveLength(40);
  });

  test('set() on a key past #25 updates the existing row, never creates a duplicate', async () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({
      $id: `id_${pad(i)}`, $updatedAt: '2026-01-01T00:00:00.000Z',
      key: `key_${pad(i)}`, val: String(i), type: 'integer',
    }));
    const db = makeDb(docs);
    ConfigManager.init({ databases: db, APPWRITE_DATABASE_ID: DB, APPWRITE_CONFIG_COLLECTION_ID: COL });
    await ConfigManager.refresh();

    await ConfigManager.set('key_030', 200);

    expect(db.createDocument).not.toHaveBeenCalled();
    expect(db.updateDocument).toHaveBeenCalledWith(DB, COL, 'id_030', { val: '200' });
    expect(db.docs.filter((d) => d.key === 'key_030')).toHaveLength(1);
    expect(ConfigManager.get('key_030')).toBe(200);
  });

  test('set() still creates a genuinely new key exactly once', async () => {
    const db = makeDb([{ $id: 'id_000', $updatedAt: '2026-01-01T00:00:00.000Z', key: 'a', val: '1', type: 'integer' }]);
    ConfigManager.init({ databases: db, APPWRITE_DATABASE_ID: DB, APPWRITE_CONFIG_COLLECTION_ID: COL });
    await ConfigManager.refresh();

    await ConfigManager.set('brand_new_key', 'x');
    expect(db.createDocument).toHaveBeenCalledTimes(1);
    expect(db.docs.filter((d) => d.key === 'brand_new_key')).toHaveLength(1);
  });

  test('existing duplicate rows collapse to the newest, and get()/getRawDoc agree', async () => {
    // The reported state: payout_max_pending written twice, 100 then 200.
    const db = makeDb([
      { $id: 'id_a', $updatedAt: '2026-01-01T00:00:00.000Z', key: 'payout_max_pending', val: '100' },
      { $id: 'id_b', $updatedAt: '2026-02-01T00:00:00.000Z', key: 'payout_max_pending', val: '200' },
    ]);
    ConfigManager.init({ databases: db, APPWRITE_DATABASE_ID: DB, APPWRITE_CONFIG_COLLECTION_ID: COL });
    await ConfigManager.refresh();

    expect(ConfigManager.get('payout_max_pending')).toBe('200');
    // Cache and write-target must be the same doc, or a saved value appears not to stick.
    expect(ConfigManager.getRawDoc('payout_max_pending').$id).toBe('id_b');

    await ConfigManager.set('payout_max_pending', 5);
    expect(db.createDocument).not.toHaveBeenCalled();
    expect(db.updateDocument).toHaveBeenCalledWith(DB, COL, 'id_b', { val: '5' });
  });
});
