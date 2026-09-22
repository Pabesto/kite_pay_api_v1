// appwriteDb.js — the whole app is written against Appwrite's legacy Databases
// API (listDocuments / createDocument / …), which Appwrite has deprecated behind
// the `documents.*` / `collections.*` / `attributes.*` API-key scopes in favour
// of TablesDB (listRows / createRow / …, scopes `rows.*` / `tables.*` /
// `columns.*`). Same storage, same positional argument order — only the names
// and two response fields differ. This adapter keeps every call site and every
// test on the legacy shape while the wire calls hit the non-deprecated endpoints.
//
// Usage: `const databases = require('./appwriteDb')(client);` — the only way a
// Databases-shaped client is built in this repo. Never `new Databases(client)`.

const { TablesDB } = require('node-appwrite');

// Legacy name → TablesDB name. Every pair takes the same positional arguments
// (verified against node-appwrite's dist: databaseId, collection/table id, …).
const RENAME = {
  listDocuments: 'listRows',
  getDocument: 'getRow',
  createDocument: 'createRow',
  updateDocument: 'updateRow',
  deleteDocument: 'deleteRow',
  createCollection: 'createTable',
  createStringAttribute: 'createStringColumn',
  createIntegerAttribute: 'createIntegerColumn',
  createFloatAttribute: 'createFloatColumn',
  createBooleanAttribute: 'createBooleanColumn',
  createEnumAttribute: 'createEnumColumn',
  createDatetimeAttribute: 'createDatetimeColumn',
  updateEnumAttribute: 'updateEnumColumn',
  updateStringAttribute: 'updateStringColumn',
  getAttribute: 'getColumn',
  createIndex: 'createIndex',
};

// Row → Document: the only field that differs is `$tableId` vs `$collectionId`.
// Renamed (not duplicated) so the object is byte-for-byte the legacy shape —
// response projections that strip `$collectionId` keep working unchanged.
function toDoc(row) {
  if (!row || typeof row !== 'object' || !('$tableId' in row)) return row;
  const { $tableId, ...doc } = row;
  doc.$collectionId = $tableId;
  return doc;
}

const RETURNS_DOC = new Set(['getDocument', 'createDocument', 'updateDocument']);

function legacyDatabases(client) {
  const tables = new TablesDB(client);
  const api = { tablesDB: tables };
  for (const [legacy, modern] of Object.entries(RENAME)) {
    if (legacy === 'listDocuments') {
      api.listDocuments = async (...args) => {
        const { rows, ...rest } = await tables.listRows(...args);
        return { ...rest, documents: (rows || []).map(toDoc) };
      };
    } else if (RETURNS_DOC.has(legacy)) {
      api[legacy] = async (...args) => toDoc(await tables[modern](...args));
    } else {
      api[legacy] = (...args) => tables[modern](...args);
    }
  }
  return api;
}

module.exports = legacyDatabases;
module.exports.toDoc = toDoc;
module.exports.RENAME = RENAME;
