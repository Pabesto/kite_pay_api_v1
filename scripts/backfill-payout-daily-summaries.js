// backfill-payout-daily-summaries.js — rebuild `daily_payout_summaries` (the rollup behind
// GET /api/payout/admin/payout-summary) from the paid rows in `customer_payouts`.
//
// RECOMPUTE-AND-OVERWRITE, never increment: every day in range is rebuilt from scratch, so
// re-running is always safe and a half-applied live write (the CRITICAL log at mark-paid) is
// repaired simply by running this for that day. Days in range with no paid payouts are written
// as {} so stale data cannot survive.
//
// Day key = IST day of `paidAt` (falls back to processedAt) — the same key the live writer uses,
// so the backfill always lands on the same doc the route reads.
//
// Dry-run by default; nothing is written without --write.
//
//   node scripts/backfill-payout-daily-summaries.js                          # plan, all time
//   node scripts/backfill-payout-daily-summaries.js --from 2026-09-01 --to 2026-09-30
//   node scripts/backfill-payout-daily-summaries.js --write                  # rebuild every day
//
// Run scripts/setup-payout-schema.js first (it creates the collection).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, ID, Query } = require('node-appwrite');
const moment = require('moment-timezone');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const FROM = arg('--from'), TO = arg('--to');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const {
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID,
    APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID = 'customer_payouts',
    APPWRITE_DAILY_PAYOUT_SUMMARIES_COLLECTION_ID = 'daily_payout_summaries',
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID })) {
    if (!v) { console.error(`❌ Missing required env var ${k} — check the .env at the project root.`); process.exit(1); }
}
if ((FROM && !DAY_RE.test(FROM)) || (TO && !DAY_RE.test(TO)) || (!!FROM !== !!TO)) {
    console.error('❌ --from and --to must be given together as YYYY-MM-DD (IST days).');
    process.exit(1);
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID, PAYOUTS = APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID, DAILY = APPWRITE_DAILY_PAYOUT_SUMMARIES_COLLECTION_ID;
const istDay = (ts) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');

async function main() {
    console.log(`Backfill daily payout summaries — ${WRITE ? 'WRITE' : 'DRY RUN (pass --write to apply)'}`);
    console.log(`  source=${PAYOUTS}  target=${DAILY}  range=${FROM ? `${FROM}..${TO}` : 'all time'}\n`);

    // 1) Scan every paid payout (paged; status is the only filter, so this is O(all paid rows)).
    const totals = {};  // day → { userId → { paidPaise, commissionPaise, count } }
    let scanned = 0, skipped = 0, cursor = null;
    for (let page = 0; page < 5000; page++) { // ponytail: 500k paid rows — raise if the fleet ever gets there
        const q = [Query.equal('status', 'paid'), Query.orderAsc('$id'), Query.limit(100)];
        if (cursor) q.push(Query.cursorAfter(cursor));
        const r = await db.listDocuments(DB, PAYOUTS, q);
        for (const p of r.documents) {
            scanned++;
            const ts = p.paidAt || p.processedAt;
            if (!ts || !p.userId) { skipped++; continue; }
            const day = istDay(ts);
            if (FROM && (day < FROM || day > TO)) continue;
            const row = (totals[day] = totals[day] || {})[p.userId] || { paidPaise: 0, commissionPaise: 0, count: 0 };
            row.paidPaise += Number(p.amountPaise || 0);
            row.commissionPaise += Number(p.commissionPaise || 0);
            row.count += 1;
            totals[day][p.userId] = row;
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

    console.log(`Scanned ${scanned} paid payouts (${skipped} skipped: no timestamp/userId). Days to write: ${days.length}\n`);
    let created = 0, updated = 0, unchanged = 0, failed = 0;
    for (const day of days) {
        const json = JSON.stringify(totals[day] || {});
        const merchants = Object.keys(totals[day] || {}).length;
        const paid = Object.values(totals[day] || {}).reduce((t, r) => t + r.paidPaise, 0);
        let existing = null;
        try { existing = (await db.listDocuments(DB, DAILY, [Query.equal('date', day), Query.limit(1)])).documents[0] || null; }
        catch (e) { failed++; console.error(`  [ERR]  ${day}: lookup failed — ${e.message}`); continue; }

        const same = existing && existing.totalsJson === json;
        const verb = same ? 'SAME  ' : existing ? 'UPDATE' : 'CREATE';
        console.log(`  [${verb}] ${day}  merchants=${merchants}  paid=₹${(paid / 100).toFixed(2)}`);
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
