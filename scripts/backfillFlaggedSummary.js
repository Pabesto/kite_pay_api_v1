// backfillFlaggedSummary.js — one-off backfill for the daily_flagged_summary collection.
//
// Scans the transactions (webhook data) collection for every txn whose status is one of
// cyber/refund/chargeback/failed/suspicious, then aggregates the amounts per
//   date (transaction created_at, IST)  ->  qrCodeId  ->  status
// and writes them into daily_flagged_summary using the SAME shape the live status route writes:
//   totalsJson = { "<qrId>": { "cyber": <paise>, "refund": <paise>, ... } }
//
// The aggregate is recomputed from the transactions (the source of truth) and OVERWRITES each
// date's totalsJson, so the script is idempotent — running it twice gives the same result and
// never double-counts.
//
// Usage (from the project root, so .env is picked up):
//   node scripts/backfillFlaggedSummary.js            # DRY RUN — prints the plan, writes nothing
//   node scripts/backfillFlaggedSummary.js --write     # actually upserts into daily_flagged_summary
//
// Options:
//   --include-deleted   also count soft-deleted (deleted === true) transactions (default: skip them)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const moment = require('moment-timezone');
const { Client, Databases, Query, ID } = require('node-appwrite');

// ----- config / flags -----
const DRY_RUN = !process.argv.includes('--write');
const INCLUDE_DELETED = process.argv.includes('--include-deleted');
const FLAGGED_STATUSES = ['cyber', 'refund', 'chargeback', 'failed', 'suspicious'];
const PAGE_SIZE = 100;

const {
    APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID,
    APPWRITE_API_KEY,
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
    APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID,
} = process.env;

function assertEnv(name, val) {
    if (!val) throw new Error(`Missing env var ${name} — run from the project root so .env is loaded.`);
}
assertEnv('APPWRITE_ENDPOINT', APPWRITE_ENDPOINT);
assertEnv('APPWRITE_PROJECT_ID', APPWRITE_PROJECT_ID);
assertEnv('APPWRITE_API_KEY', APPWRITE_API_KEY);
assertEnv('APPWRITE_DATABASE_ID', APPWRITE_DATABASE_ID);
assertEnv('APPWRITE_WEBHOOK_DATA_COLLECTION_ID', APPWRITE_WEBHOOK_DATA_COLLECTION_ID);
assertEnv('APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID', APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID);

const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);
const databases = new Databases(client);

// Fetch every flagged transaction using cursor pagination.
async function fetchFlaggedTransactions() {
    const txns = [];
    let cursor = null;
    while (true) {
        const queries = [
            Query.equal('status', FLAGGED_STATUSES), // status IN (...) — matches the lowercased values the app writes
            Query.limit(PAGE_SIZE),
        ];
        if (cursor) queries.push(Query.cursorAfter(cursor));

        const res = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            queries
        );
        if (!res.documents.length) break;
        txns.push(...res.documents);
        if (res.documents.length < PAGE_SIZE) break;
        cursor = res.documents[res.documents.length - 1].$id;
    }
    return txns;
}

// Build { date: { qrId: { status: amountPaise } } } from the transactions.
function aggregate(txns) {
    const byDate = {};
    const stats = { counted: 0, skippedDeleted: 0, skippedNoDate: 0, byStatus: {} };

    for (const tx of txns) {
        const status = String(tx.status || '').trim().toLowerCase();
        if (!FLAGGED_STATUSES.includes(status)) continue; // defensive — query already filtered

        if (!INCLUDE_DELETED && tx.deleted === true) {
            stats.skippedDeleted++;
            continue;
        }

        const when = tx.created_at || tx.$createdAt; // prefer the business date, fall back to system field
        if (!when) {
            stats.skippedNoDate++;
            continue;
        }
        const dayString = moment.tz(when, 'Asia/Kolkata').format('YYYY-MM-DD');
        const qrKey = tx.qrCodeId || 'no_qr';
        const amt = Number(tx.amount || 0);

        const day = (byDate[dayString] ||= {});
        const bucket = (day[qrKey] ||= {});
        bucket[status] = Number(bucket[status] || 0) + amt;

        stats.counted++;
        stats.byStatus[status] = (stats.byStatus[status] || 0) + amt;
    }
    return { byDate, stats };
}

// Upsert one date's totalsJson — overwrite if a doc exists, create otherwise.
async function upsertDate(dayString, totalsObj) {
    const existing = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID,
        [Query.equal('date', dayString), Query.limit(1)]
    );
    const totalsJson = JSON.stringify(totalsObj);
    if (existing.total > 0) {
        await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID,
            existing.documents[0].$id,
            { totalsJson }
        );
        return 'updated';
    }
    await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID,
        ID.unique(),
        { date: dayString, totalsJson }
    );
    return 'created';
}

(async () => {
    console.log(`\n=== Backfill daily_flagged_summary ${DRY_RUN ? '(DRY RUN — no writes)' : '(WRITING)'} ===`);
    console.log(`Statuses: ${FLAGGED_STATUSES.join(', ')}`);
    console.log(`Soft-deleted txns: ${INCLUDE_DELETED ? 'INCLUDED' : 'skipped'}\n`);

    const txns = await fetchFlaggedTransactions();
    console.log(`Fetched ${txns.length} flagged transaction(s).`);

    const { byDate, stats } = aggregate(txns);
    const dates = Object.keys(byDate).sort();

    console.log(`Counted: ${stats.counted} | skipped (deleted): ${stats.skippedDeleted} | skipped (no date): ${stats.skippedNoDate}`);
    console.log('Totals by status (paise):', stats.byStatus);
    console.log(`Dates to upsert: ${dates.length}\n`);

    for (const d of dates) {
        const qrCount = Object.keys(byDate[d]).length;
        console.log(`  ${d} — ${qrCount} QR bucket(s): ${JSON.stringify(byDate[d])}`);
    }

    if (DRY_RUN) {
        console.log('\nDRY RUN complete. Re-run with --write to persist these into daily_flagged_summary.');
        return;
    }

    console.log('\nWriting...');
    let created = 0, updated = 0;
    for (const d of dates) {
        const result = await upsertDate(d, byDate[d]);
        result === 'created' ? created++ : updated++;
        console.log(`  ${result}: ${d}`);
    }
    console.log(`\nDone. ${created} created, ${updated} updated.`);
})().catch((err) => {
    console.error('\n❌ Backfill failed:', err.message || err);
    process.exit(1);
});
