// backfill-withdrawal-daily-summaries.js — rebuild `daily_withdrawal_summaries` (the rollup behind
// GET /api/admin/withdrawal-summary) from the approved rows in the withdrawal-requests collection.
//
// RECOMPUTE-AND-OVERWRITE, never increment: every day in range is rebuilt from scratch, so
// re-running is always safe and a half-applied live write (the CRITICAL log at approve) is
// repaired simply by running this for that day. Days in range with no approved withdrawals are
// written as {} so stale data cannot survive.
//
// Day key = IST day of `processedAt` — the same key the live writer uses — and the per-row math is
// withdrawalSummary.addWithdrawal, the same function, so backfill and live always agree.
//
// Dry-run by default; nothing is written without --write.
//
//   node scripts/backfill-withdrawal-daily-summaries.js                          # plan, all time
//   node scripts/backfill-withdrawal-daily-summaries.js --from 2026-09-01 --to 2026-09-30
//   node scripts/backfill-withdrawal-daily-summaries.js --write                  # rebuild every day
//
// Run scripts/setup-withdrawal-summary-schema.js first (it creates the collection).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, ID, Query } = require('node-appwrite');
const moment = require('moment-timezone');
const { addWithdrawal, istDay } = require('../withdrawalSummary');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const FROM = arg('--from'), TO = arg('--to');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID,
    APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID = 'daily_withdrawal_summaries',
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID })) {
    if (!v) { console.error(`❌ Missing required env var ${k} — check the .env at the project root.`); process.exit(1); }
}
if ((FROM && !DAY_RE.test(FROM)) || (TO && !DAY_RE.test(TO)) || (!!FROM !== !!TO)) {
    console.error('❌ --from and --to must be given together as YYYY-MM-DD (IST days).');
    process.exit(1);
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID, WITHDRAWALS = APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, DAILY = APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID;

async function main() {
    console.log(`Backfill daily withdrawal summaries — ${WRITE ? 'WRITE' : 'DRY RUN (pass --write to apply)'}`);
    console.log(`  source=${WITHDRAWALS}  target=${DAILY}  range=${FROM ? `${FROM}..${TO}` : 'all time'}\n`);

    // 1) Scan every approved withdrawal (paged; status is the only filter, so this is O(all approved rows)).
    const totals = {};  // day → { qrId → { direct: {…}, wallet: {…} } }
    let scanned = 0, skipped = 0, cursor = null;
    for (let page = 0; page < 5000; page++) { // ponytail: 500k approved rows — raise if the fleet ever gets there
        const q = [Query.equal('status', 'approved'), Query.orderAsc('$id'), Query.limit(100)];
        if (cursor) q.push(Query.cursorAfter(cursor));
        const r = await db.listDocuments(DB, WITHDRAWALS, q);
        for (const w of r.documents) {
            scanned++;
            if (!w.processedAt || !w.qrId) { skipped++; continue; }
            const day = istDay(w.processedAt);
            if (FROM && (day < FROM || day > TO)) continue;
            addWithdrawal(totals[day] = totals[day] || {}, w);
        }
        if (r.documents.length < 100) break;
        cursor = r.documents[r.documents.length - 1].$id;
        if (page === 4999) console.warn('⚠️  page cap hit — results are INCOMPLETE; raise the cap.');
    }

    // 2) The set of days to (re)write: every day in the explicit range, or every day seen.
    const days = [];
    if (FROM) {
        for (let d = moment.tz(FROM, 'Asia/Kolkata'); !d.isAfter(moment.tz(TO, 'Asia/Kolkata')); d.add(1, 'day')) days.push(d.format('YYYY-MM-DD'));
    } else {
        days.push(...Object.keys(totals).sort());
    }

    console.log(`Scanned ${scanned} approved withdrawals (${skipped} skipped: no processedAt/qrId). Days to write: ${days.length}\n`);
    let created = 0, updated = 0, unchanged = 0, failed = 0;
    for (const day of days) {
        const json = JSON.stringify(totals[day] || {});
        const rows = Object.values(totals[day] || {});
        const sum = (mode) => rows.reduce((t, q) => t + Number(q[mode]?.paidPaise || 0), 0);
        let existing = null;
        try { existing = (await db.listDocuments(DB, DAILY, [Query.equal('date', day), Query.limit(1)])).documents[0] || null; }
        catch (e) { failed++; console.error(`  [ERR]  ${day}: lookup failed — ${e.message}`); continue; }

        const same = existing && existing.totalsJson === json;
        const verb = same ? 'SAME  ' : existing ? 'UPDATE' : 'CREATE';
        console.log(`  [${verb}] ${day}  qrs=${rows.length}  direct=₹${(sum('direct') / 100).toFixed(2)}  wallet=₹${(sum('wallet') / 100).toFixed(2)}`);
        if (same) { unchanged++; continue; }
        if (!WRITE) continue;
        try {
            if (existing) { await db.updateDocument(DB, DAILY, existing.$id, { date: day, totalsJson: json }); updated++; }
            else { await db.createDocument(DB, DAILY, ID.unique(), { date: day, totalsJson: json }); created++; }
        } catch (e) { failed++; console.error(`  [ERR]  ${day}: write failed — ${e.message}`); }
    }

    console.log(`\n${WRITE ? 'Done' : 'Dry run complete'}: created=${created} updated=${updated} unchanged=${unchanged} failed=${failed}`);
    if (!WRITE) console.log('Re-run with --write to apply.');
    if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('\nBackfill failed:', e?.message || e); process.exit(1); });
