const {ID, Query } = require('node-appwrite');

// In-memory queue: batch counter deltas and flush periodically.
// This avoids the read-modify-write race condition where two concurrent requests
// both read the same value, both add their delta, and one overwrites the other.
const pendingDeltas = {};
let flushTimer = null;
let dbRef = null;
let dbIdRef = null;
let collectionIdRef = 'dashboard_counters';

// Set the collection ID once from server.js so the module doesn't carry a
// magic-string. Safe to call multiple times.
function init({ APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID }) {
    if (APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID) {
        collectionIdRef = APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID;
    }
}

async function updateDashboardCounter(databases, APPWRITE_DATABASE_ID, counterName, delta = 1) {
    // Ensure delta is a number
    if (typeof delta !== 'number' || isNaN(delta)) {
        throw new Error(`Delta must be a valid number. Received: ${delta}`);
    }

    // Store refs for flush
    dbRef = databases;
    dbIdRef = APPWRITE_DATABASE_ID;

    // Accumulate delta in memory (atomic in single-threaded Node.js)
    pendingDeltas[counterName] = (pendingDeltas[counterName] || 0) + delta;

    // Start flush timer if not already running (flush every 2 seconds)
    if (!flushTimer) {
        flushTimer = setTimeout(flushCounters, 2000);
    }
}

async function flushCounters() {
    flushTimer = null;
    if (!dbRef || !dbIdRef) return;

    // Snapshot and clear pending deltas atomically (single-threaded)
    const snapshot = { ...pendingDeltas };
    for (const key of Object.keys(snapshot)) {
        pendingDeltas[key] = 0;
    }

    for (const [counterName, delta] of Object.entries(snapshot)) {
        if (delta === 0) continue;
        try {
            const list = await dbRef.listDocuments(dbIdRef, collectionIdRef, [
                Query.equal('id', counterName),
                Query.limit(1)
            ]);
            let doc = list.documents[0];
            if (doc) {
                await dbRef.updateDocument(dbIdRef, collectionIdRef, doc.$id, {
                    totals: (Number(doc.totals) || 0) + delta
                });
            } else {
                await dbRef.createDocument(dbIdRef, collectionIdRef, ID.unique(), {
                    id: counterName,
                    totals: delta
                });
            }
        } catch (e) {
            // Put failed delta back so it's retried on next flush
            pendingDeltas[counterName] = (pendingDeltas[counterName] || 0) + delta;
            console.error(`Dashboard counter flush failed for ${counterName}:`, e.message);
        }
    }

    // If there are still pending deltas (from failures or new writes during flush), schedule another
    if (Object.values(pendingDeltas).some(v => v !== 0) && !flushTimer) {
        flushTimer = setTimeout(flushCounters, 2000);
    }
}

module.exports = { init, updateDashboardCounter };
