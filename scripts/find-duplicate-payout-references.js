// find-duplicate-payout-references.js — READ-ONLY. Lists every `customer_payouts.referenceNumber` that
// appears on more than one payout, with the payouts sharing it, so a UTR entered twice (two payouts
// marked paid with the same bank reference) can be checked against the bank statement.
//
//   node scripts/find-duplicate-payout-references.js
//   node scripts/find-duplicate-payout-references.js --json           # machine-readable
//   DOTENV_CONFIG_PATH=.env.v3 node scripts/find-duplicate-payout-references.js
//
// Comparison is case-insensitive and ignores surrounding whitespace, so "utr123 " and "UTR123" count as the
// same reference. Only paid rows carry a reference (reject/cancel clear it), so these are all paid payouts.

const path = require('path');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH ? path.resolve(process.env.DOTENV_CONFIG_PATH) : path.join(__dirname, '..', '.env') });
const { Client, Query } = require('node-appwrite');

const E = process.env;
const req = (k) => { if (!E[k]) { console.error(`❌ Missing env ${k}`); process.exit(1); } return E[k]; };
const DB = req('APPWRITE_DATABASE_ID');
const PAYOUTS = E.APPWRITE_CUSTOMER_PAYOUTS_COLLECTION_ID || 'customer_payouts';
const USERS = req('APPWRITE_USERS_META_COLLECTION_ID');
const JSON_OUT = process.argv.includes('--json');
const db = require('../appwriteDb')(new Client().setEndpoint(req('APPWRITE_ENDPOINT')).setProject(req('APPWRITE_PROJECT_ID')).setKey(req('APPWRITE_API_KEY')));
const rs = (p) => `₹${(Number(p || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

async function scan(col, filters = []) {
    const out = []; let cursor = null;
    for (let p = 0; p < 10000; p++) {
        const q = [...filters, Query.orderAsc('$id'), Query.limit(100)];
        if (cursor) q.push(Query.cursorAfter(cursor));
        const r = await db.listDocuments(DB, col, q);
        out.push(...r.documents);
        if (r.documents.length < 100) break;
        cursor = r.documents[r.documents.length - 1].$id;
    }
    return out;
}

(async () => {
    if (!JSON_OUT) console.log(`target: ${new URL(E.APPWRITE_ENDPOINT).host} project ${String(E.APPWRITE_PROJECT_ID).slice(0, 4)}…${String(E.APPWRITE_PROJECT_ID).slice(-3)}\n`);
    const [payouts, users] = await Promise.all([scan(PAYOUTS), scan(USERS)]);
    const name = Object.fromEntries(users.map((u) => [u.userId, u.name || u.email || u.userId]));
    const groups = {};
    for (const p of payouts) {
        const ref = String(p.referenceNumber || '').trim();
        if (!ref) continue;
        (groups[ref.toUpperCase()] = groups[ref.toUpperCase()] || []).push(p);
    }
    const dups = Object.entries(groups).filter(([, rows]) => rows.length > 1)
        .map(([key, rows]) => ({ referenceNumber: key, count: rows.length, totalPaise: rows.reduce((s, r) => s + Number(r.amountPaise || 0), 0),
            payouts: rows.sort((a, b) => String(a.paidAt || a.processedAt || '').localeCompare(String(b.paidAt || b.processedAt || ''))).map((r) => ({
                id: r.id, status: r.status, amountPaise: Number(r.amountPaise || 0), customerName: r.customerName, accountNumber: r.accountNumber, mode: r.mode,
                merchant: name[r.userId] || r.userId, paidAt: r.paidAt || r.processedAt || null, processedBy: name[r.processedBy] || r.processedBy || null, paidVia: r.paidVia || null, referenceAsStored: r.referenceNumber,
            })) }))
        .sort((a, b) => b.count - a.count || b.totalPaise - a.totalPaise);

    if (JSON_OUT) { console.log(JSON.stringify({ scanned: payouts.length, withReference: Object.values(groups).flat().length, duplicateReferences: dups.length, duplicates: dups }, null, 2)); return; }
    console.log(`payouts scanned: ${payouts.length} | with a reference: ${Object.values(groups).flat().length} | references used more than once: ${dups.length}\n`);
    for (const d of dups) {
        const same = new Set(d.payouts.map((p) => `${p.accountNumber}|${p.amountPaise}`)).size === 1;
        console.log(`${d.referenceNumber}  ×${d.count}  ${rs(d.totalPaise)} total${same ? '   ⚠ same account + same amount (likely one bank transfer, two payouts)' : ''}`);
        for (const p of d.payouts) console.log(`    ${p.id.padEnd(22)} ${p.status.padEnd(9)} ${rs(p.amountPaise).padStart(14)}  ${String(p.customerName || '').slice(0, 20).padEnd(20)} ${String(p.accountNumber || '').padEnd(18)} ${p.mode || ''}  merchant=${p.merchant}  paid ${String(p.paidAt || '').slice(0, 16)} by ${p.processedBy}${p.paidVia ? '  via ' + p.paidVia : ''}`);
    }
    if (!dups.length) console.log('No duplicate reference numbers.');
    console.log('\nRead-only. Nothing was written.');
})().catch((e) => { console.error('failed:', e?.message || e); process.exit(1); });
