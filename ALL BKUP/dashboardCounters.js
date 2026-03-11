const {ID, Query } = require('node-appwrite');

async function updateDashboardCounter(databases, APPWRITE_DATABASE_ID, counterName, delta = 1) {
     // Ensure delta is a number
    if (typeof delta !== 'number' || isNaN(delta)) {
        throw new Error(`Delta must be a valid number. Received: ${delta}`);
    }
    // console.log(`Updating counter ${counterName} by ${delta}`);
    // Fetch the current value
    const list = await databases.listDocuments(APPWRITE_DATABASE_ID, 'dashboard_counters', [
        Query.equal('id', counterName),
        Query.limit(1)
    ]);
    let doc = list.documents[0];
    if (doc) {
        await databases.updateDocument(APPWRITE_DATABASE_ID, 'dashboard_counters', doc.$id, {
            totals: (Number(doc.totals) || 0) + delta
        });
    } else {
        await databases.createDocument(APPWRITE_DATABASE_ID, 'dashboard_counters', ID.unique(), {
            id: counterName,
            totals: delta
        });
    }
}

module.exports = { updateDashboardCounter };