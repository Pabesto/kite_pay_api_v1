// appwriteDb.js — legacy Databases-shaped adapter over TablesDB.
// Pins: every legacy name forwards positionally to its TablesDB twin, list
// results come back as { total, documents }, and rows are reshaped to the
// legacy Document shape ($tableId → $collectionId) on every row-returning call.

const calls = [];
const fakeTables = {};

jest.mock('node-appwrite', () => ({
    TablesDB: jest.fn().mockImplementation(() => fakeTables),
}));

const legacyDatabases = require('../appwriteDb');
const { RENAME, toDoc } = legacyDatabases;

const row = (id) => ({ $id: id, $sequence: 1, $tableId: 'tbl', $databaseId: 'db', $createdAt: 'c', $updatedAt: 'u', $permissions: [], amount: 100 });

beforeEach(() => {
    calls.length = 0;
    for (const modern of new Set(Object.values(RENAME))) {
        fakeTables[modern] = jest.fn(async (...args) => {
            calls.push([modern, args]);
            if (modern === 'listRows') return { total: 2, rows: [row('a'), row('b')] };
            if (['getRow', 'createRow', 'updateRow'].includes(modern)) return row(args[2]);
            return { ok: modern };
        });
    }
});

test('toDoc renames $tableId to $collectionId and leaves everything else alone', () => {
    const doc = toDoc(row('x'));
    expect(doc.$collectionId).toBe('tbl');
    expect('$tableId' in doc).toBe(false);
    expect(doc).toMatchObject({ $id: 'x', $databaseId: 'db', amount: 100 });
    // Projected rows (Query.select) and non-objects pass through untouched.
    expect(toDoc({ amount: 1 })).toEqual({ amount: 1 });
    expect(toDoc(null)).toBeNull();
});

test('listDocuments returns { total, documents } with legacy-shaped docs', async () => {
    const databases = legacyDatabases({});
    const res = await databases.listDocuments('db', 'tbl', ['q1']);
    expect(calls).toEqual([['listRows', ['db', 'tbl', ['q1']]]]);
    expect(res.total).toBe(2);
    expect(res.rows).toBeUndefined();
    expect(res.documents.map((d) => d.$id)).toEqual(['a', 'b']);
    expect(res.documents.every((d) => d.$collectionId === 'tbl' && !('$tableId' in d))).toBe(true);
});

test('get/create/update forward positionally and reshape the returned row', async () => {
    const databases = legacyDatabases({});
    const got = await databases.getDocument('db', 'tbl', 'id1');
    const made = await databases.createDocument('db', 'tbl', 'id2', { amount: 5 }, ['perm']);
    const upd = await databases.updateDocument('db', 'tbl', 'id3', { amount: 6 });
    expect(calls).toEqual([
        ['getRow', ['db', 'tbl', 'id1']],
        ['createRow', ['db', 'tbl', 'id2', { amount: 5 }, ['perm']]],
        ['updateRow', ['db', 'tbl', 'id3', { amount: 6 }]],
    ]);
    for (const d of [got, made, upd]) {
        expect(d.$collectionId).toBe('tbl');
        expect('$tableId' in d).toBe(false);
    }
});

test('every other legacy method forwards positionally to its TablesDB twin', async () => {
    const databases = legacyDatabases({});
    const plain = Object.entries(RENAME).filter(([legacy]) => !['listDocuments', 'getDocument', 'createDocument', 'updateDocument'].includes(legacy));
    for (const [legacy, modern] of plain) {
        const res = await databases[legacy]('db', 'tbl', 'k', 'x', 'y', 'z');
        expect(res).toEqual({ ok: modern });
        expect(calls.pop()).toEqual([modern, ['db', 'tbl', 'k', 'x', 'y', 'z']]);
    }
});

test('no legacy Databases method is left unmapped for the code that uses the adapter', () => {
    const expected = [
        'listDocuments', 'getDocument', 'createDocument', 'updateDocument', 'deleteDocument',
        'createCollection', 'createStringAttribute', 'createIntegerAttribute', 'createFloatAttribute',
        'createBooleanAttribute', 'createEnumAttribute', 'createDatetimeAttribute',
        'updateEnumAttribute', 'getAttribute', 'createIndex',
    ];
    const databases = legacyDatabases({});
    for (const m of expected) expect(typeof databases[m]).toBe('function');
    expect(databases.tablesDB).toBe(fakeTables);
});
