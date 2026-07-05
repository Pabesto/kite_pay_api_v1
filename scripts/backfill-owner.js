// backfill-owner.js — stamps `ownerSubadminId` onto existing transactions so the
// partner-transactions endpoint can serve historical data (not just new payments).
//
// It rebuilds the same qrCode -> owning-subadmin map that qrOwnerCache builds at
// runtime (owner rules mirror admin.js getQrIdsForSubadmin), then walks transactions and
// updates the ones whose stored owner differs from the computed one.
// By default it only fetches un-stamped transactions (ownerSubadminId is null), so re-runs
// stay cheap and never re-scan rows that already have an owner. (The --qr re-stamp path is
// exempt so a reassignment can overwrite an already-set owner.)
// Idempotent: re-running only writes rows that are actually out of date.
//
// By default it only touches the CURRENT MONTH's transactions (IST). Pass --all for full history.
//
// Usage (from project root so .env is loaded):
//   node scripts/backfill-owner.js               # DRY RUN, current month — prints what would change
//   node scripts/backfill-owner.js --write        # write, current month only
//   node scripts/backfill-owner.js --write --all  # write, ALL transactions (full history)
//   node scripts/backfill-owner.js --write --qr <qrId>          # re-stamp one QR's txns (this month)
//   node scripts/backfill-owner.js --write --all --qr <qrId>    # re-stamp one QR's full history

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const moment = require('moment-timezone');
const { Client, Databases, Query } = require('node-appwrite');
const qrOwnerCache = require('../qrOwnerCache');

const DRY_RUN = !process.argv.includes('--write');
const qrFlagIdx = process.argv.indexOf('--qr');
const ONLY_QR = qrFlagIdx !== -1 ? process.argv[qrFlagIdx + 1] : null;
// By default only stamp the CURRENT MONTH's transactions (IST). Pass --all for full history.
const ALL_TIME = process.argv.includes('--all');
const MONTH_START_ISO = moment.tz('Asia/Kolkata').startOf('month').utc().toISOString();
const PAGE = 100;

const {
    APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID,
    APPWRITE_API_KEY,
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
    APPWRITE_QRCODE_COLLECTION_ID,
    APPWRITE_USERS_META_COLLECTION_ID,
} = process.env;

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);

async function listAll(collectionId, extraQueries = []) {
    const out = [];
    let cursor = null;
    while (true) {
        const queries = [...extraQueries, Query.limit(PAGE)];
        if (cursor) queries.push(Query.cursorAfter(cursor));
        const res = await db.listDocuments(APPWRITE_DATABASE_ID, collectionId, queries);
        out.push(...res.documents);
        if (res.documents.length < PAGE) break;
        cursor = res.documents[res.documents.length - 1].$id;
    }
    return out;
}

async function main() {
    console.log(`\nBackfill ownerSubadminId — ${DRY_RUN ? 'DRY RUN' : 'WRITE'}${ONLY_QR ? ` (qr=${ONLY_QR})` : ''}`);
    console.log(ALL_TIME ? 'Scope: all dates (--all)' : `Scope: current month only (created_at >= ${MONTH_START_ISO})`);
    console.log(ONLY_QR ? `Rows: qrCodeId=${ONLY_QR} (re-stamp, includes already-set)` : 'Rows: only un-stamped (ownerSubadminId is null)');
    console.log('');

    // 1. Build users_meta lookup
    const metaDocs = await listAll(APPWRITE_USERS_META_COLLECTION_ID);
    const metaByUser = new Map();
    for (const m of metaDocs) if (m.userId) metaByUser.set(m.userId, { role: m.role, parentId: m.parentId || null });
    const getMeta = (uid) => metaByUser.get(uid) || null;
    console.log(`Loaded ${metaByUser.size} users_meta`);

    // 2. Build qrId -> owner map (reuses the exact runtime rule set)
    const qrDocs = await listAll(APPWRITE_QRCODE_COLLECTION_ID);
    const ownerByQr = new Map();
    for (const qr of qrDocs) {
        if (!qr.qrId) continue;
        ownerByQr.set(qr.qrId, qrOwnerCache._ownerFor(qr.assignedUserId, qr.createdByUserId, getMeta));
    }
    console.log(`Computed owner for ${ownerByQr.size} QR codes`);

    // 3. Walk transactions and update those that are out of date.
    // Default: only fetch transactions not yet stamped (ownerSubadminId is null) — this is
    // the "fill in the blanks" pass. The --qr re-stamp path (reassignment) is exempt, since
    // it must overwrite an already-set owner.
    const txnFilters = [];
    if (ONLY_QR) txnFilters.push(Query.equal('qrCodeId', ONLY_QR));
    else txnFilters.push(Query.isNull('ownerSubadminId'));
    if (!ALL_TIME) txnFilters.push(Query.greaterThanEqual('created_at', MONTH_START_ISO));
    let scanned = 0, changed = 0, skipped = 0, failed = 0;

    const txns = await listAll(APPWRITE_WEBHOOK_DATA_COLLECTION_ID, txnFilters);
    console.log(`Scanning ${txns.length} transactions…\n`);

    for (const t of txns) {
        scanned++;
        const desired = ownerByQr.get(t.qrCodeId) ?? null;
        const current = t.ownerSubadminId ?? null;
        if (desired === current) { skipped++; continue; }

        if (DRY_RUN) {
            changed++;
            if (changed <= 20) console.log(`  would set ${t.$id} (qr=${t.qrCodeId}): ${current} -> ${desired}`);
            continue;
        }
        try {
            await db.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, t.$id, { ownerSubadminId: desired });
            changed++;
            if (changed % 200 === 0) console.log(`  …updated ${changed}`);
        } catch (e) {
            failed++;
            console.error(`  ❌ ${t.$id}:`, e?.message || e);
        }
    }

    console.log(`\nDone. scanned=${scanned} changed=${changed} unchanged=${skipped} failed=${failed}`);
    if (DRY_RUN) console.log('Re-run with --write to apply.\n');
}

main().catch((e) => { console.error('\nBackfill failed:', e?.message || e); process.exit(1); });
