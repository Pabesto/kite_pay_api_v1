// backfill-payout-commission.js — set users_meta.payoutCommission for existing users.
//
// Default behaviour: fills only docs where payoutCommission is missing (null/undefined) — an
// explicitly set value (including 0) is left alone. `--force` overwrites every non-admin doc.
// Dry-run by default; nothing is written without --write.
//
// Usage (from project root so .env is loaded):
//   node scripts/backfill-payout-commission.js                # plan only
//   node scripts/backfill-payout-commission.js --write        # fill missing with 1.5
//   node scripts/backfill-payout-commission.js --write --rate 2 --force   # set everyone to 2
//
// Run scripts/setup-payout-schema.js first (it creates the attribute).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Databases, Query } = require('node-appwrite');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
const rateArg = args[args.indexOf('--rate') + 1];
const RATE = args.includes('--rate') ? Number(rateArg) : 1.5;

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID || !APPWRITE_USERS_META_COLLECTION_ID) {
    console.error('❌ Missing required env vars (APPWRITE_ENDPOINT/PROJECT_ID/API_KEY/DATABASE_ID/USERS_META_COLLECTION_ID).');
    process.exit(1);
}
if (!isFinite(RATE) || RATE < 0 || RATE > 100) {
    console.error('❌ --rate must be a number between 0 and 100');
    process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const DB = APPWRITE_DATABASE_ID;
const COL = APPWRITE_USERS_META_COLLECTION_ID;

async function main() {
    console.log(`\n${WRITE ? 'WRITE' : 'DRY RUN'} — payoutCommission = ${RATE}% for ${FORCE ? 'ALL non-admin users (--force)' : 'users with no value'}\n`);
    const counts = { scanned: 0, changed: 0, skipped: 0, failed: 0 };
    let cursor = null;
    for (let page = 0; page < 1000; page++) {
        const q = [Query.limit(100), Query.orderAsc('$id')];
        if (cursor) q.push(Query.cursorAfter(cursor));
        const r = await db.listDocuments(DB, COL, q);
        for (const d of r.documents) {
            counts.scanned++;
            const missing = d.payoutCommission === null || d.payoutCommission === undefined;
            if (d.role === 'admin' || (!missing && !FORCE) || (!missing && Number(d.payoutCommission) === RATE)) { counts.skipped++; continue; }
            console.log(`  ${WRITE ? 'set' : 'would set'} ${d.userId || d.$id} (${d.role}) ${missing ? '<none>' : d.payoutCommission} → ${RATE}`);
            if (!WRITE) { counts.changed++; continue; }
            try {
                await db.updateDocument(DB, COL, d.$id, { payoutCommission: RATE });
                counts.changed++;
            } catch (e) {
                counts.failed++;
                console.error(`  ❌ ${d.$id}: ${e?.message || e}`);
            }
        }
        if (r.documents.length < 100) break;
        cursor = r.documents[r.documents.length - 1].$id;
    }
    console.log(`\nscanned=${counts.scanned} changed=${counts.changed} skipped=${counts.skipped} failed=${counts.failed}`);
    if (WRITE && counts.changed) console.log('\nNote: users_meta is cached in Redis for up to 60s — new rates apply within a minute.');
    if (!WRITE) console.log('\nDry run — re-run with --write to apply.');
}

main().catch((e) => { console.error('\nBackfill failed:', e?.message || e); process.exit(1); });
