// backfill-early-release-fees.js — charge the early-release fee on every QR release that was made
// BEFORE the fee existed (or failed to charge): same money rules as the live path
// (withdraw.js chargeEarlyReleaseFee), applied once per release row.
//
// For every `qr_daily_releases` row with releasedPaise > 0, no fee yet (feePaise empty/0) and
// chargeCommission !== false:
//   1. rate  = the QR's assigned user's rate, resolved like live: a user under a subadmin → the SUBADMIN's
//              earlyReleaseCommission; a parentless user → their own; else --rate / config default (1%)
//   2. fee   = ceil(releasedPaise × rate)             (the row's total released amount)
//   3. under lock:qr:<qrId> (Redis, fails closed): QR.commissionPaid += fee, available recomputed
//              (skipped, never written, if that would go negative)
//   4. one commission_transactions row to ADMIN (commissionType 'early_release',
//              sourceWithdrawalId 'release:<rowId>', createdAt = the release's own time → its own day)
//   5. the release row is stamped: feePaise, feeRate, payer / subadmin / releasedBy names
// Then, once, recompute-and-overwrite (the sanctioned backfill style, so re-runs never double count):
//   6. the three early-release rollups (daily map, monthly per admin, all-time per admin) from ALL
//      early_release commission rows, and the dashboard counter totalEarlyReleaseAdminProfit.
//
// Idempotent: a row that already carries feePaise > 0 is skipped. Dry-run by default; --write to apply.
//
//   node scripts/backfill-early-release-fees.js                      # plan only
//   node scripts/backfill-early-release-fees.js --write              # apply
//   node scripts/backfill-early-release-fees.js --from 2026-09-01 --to 2026-09-30 --rate 1 --write
//
// --rate overrides ONLY the fallback (users/subadmins with their own rate keep it). Needs REDIS_URL for
// --write (the QR ledger lock); a Redis outage refuses to write rather than write unlocked.

const path = require('path');
// DOTENV_CONFIG_PATH=.env.v3 picks another env file; on Render the dashboard variables already win.
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH ? path.resolve(process.env.DOTENV_CONFIG_PATH) : path.join(__dirname, '..', '.env') });
const { Client, Query } = require('node-appwrite');
const moment = require('moment-timezone');

const E = process.env;
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const WRITE = argv.includes('--write');
const FROM = flag('--from'), TO = flag('--to'), RATE_OVERRIDE = flag('--rate');
const req = (k) => { if (!E[k]) { console.error(`❌ Missing env ${k}`); process.exit(1); } return E[k]; };
const DB = req('APPWRITE_DATABASE_ID');
const COL = {
    qr: req('APPWRITE_QRCODE_COLLECTION_ID'), users: req('APPWRITE_USERS_META_COLLECTION_ID'),
    comm: req('APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID'), counters: req('APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID'), config: req('APPWRITE_CONFIG_COLLECTION_ID'),
    releases: E.APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID || 'qr_daily_releases',
    daily: E.APPWRITE_DAILY_EARLY_RELEASE_COMMISSION_SUMMARIES_COLLECTION_ID || 'daily_early_release_commissions',
    monthly: E.APPWRITE_MONTHLY_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID || 'monthly_early_release_totals',
    allTime: E.APPWRITE_ALL_TIME_EARLY_RELEASE_COMMISSION_TOTALS_COLLECTION_ID || 'all_time_early_release_totals',
};
const db = require('../appwriteDb')(new Client().setEndpoint(req('APPWRITE_ENDPOINT')).setProject(req('APPWRITE_PROJECT_ID')).setKey(req('APPWRITE_API_KEY')));
const { ID } = require('node-appwrite');
const rs = (p) => `₹${(Number(p || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const ceilPct = (paise, pct) => Math.ceil(paise * Math.round(pct * 100) / 10000);   // = calculateCommissionPaise
const istDay = (ts) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');
const istMonth = (ts) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM');

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
const one = async (col, filters) => (await db.listDocuments(DB, col, [...filters, Query.limit(1)])).documents[0] || null;

// ── Redis lock (fail closed) ────────────────────────────────────────────────
let redis = null;
const RELEASE_LUA = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
async function withQrLock(qrId, fn) {
    const key = `lock:qr:${qrId}`, val = `backfill:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) { ok = (await redis.set(key, val, { NX: true, EX: 20 })) === 'OK'; if (!ok) await new Promise((r) => setTimeout(r, 200)); }
    if (!ok) throw new Error(`lock busy: ${key}`);
    try { return await fn(); } finally { await redis.eval(RELEASE_LUA, { keys: [key], arguments: [val] }).catch(() => {}); }
}

async function main() {
    console.log(`\n=== early-release fee backfill (${WRITE ? 'WRITE' : 'dry run'}) ===`);
    console.log(`target: ${new URL(E.APPWRITE_ENDPOINT).host} project ${String(E.APPWRITE_PROJECT_ID).slice(0, 4)}…${String(E.APPWRITE_PROJECT_ID).slice(-3)} | redis: ${E.REDIS_URL ? new URL(E.REDIS_URL).host : '(none)'}\n`);
    const cfg = await one(COL.config, [Query.equal('key', 'default_early_release_commission')]);
    const defaultRate = RATE_OVERRIDE != null ? Number(RATE_OVERRIDE) : Number(cfg?.val ?? 0);
    if (!isFinite(defaultRate) || defaultRate < 0 || defaultRate > 100) { console.error('❌ bad fallback rate', defaultRate); process.exit(1); }
    console.log(`fallback rate: ${defaultRate}% (${RATE_OVERRIDE != null ? '--rate' : 'config default_early_release_commission'})`);

    const users = await scan(COL.users); const U = Object.fromEntries(users.map((u) => [u.userId, u]));
    const admin = users.find((u) => u.role === 'admin');
    if (!admin) { console.error('❌ no admin user in users_meta — nowhere to book the fee'); process.exit(1); }
    const rateFor = (userId) => {
        const u = U[userId]; if (!u) return { rate: defaultRate, from: 'default' };
        if (u.parentId) { const p = U[u.parentId]; return p?.earlyReleaseCommission != null ? { rate: Number(p.earlyReleaseCommission), from: 'subadmin' } : { rate: defaultRate, from: 'default' }; }
        return u.earlyReleaseCommission != null ? { rate: Number(u.earlyReleaseCommission), from: 'own' } : { rate: defaultRate, from: 'default' };
    };

    const filters = [];
    if (FROM) filters.push(Query.greaterThanEqual('date', FROM));
    if (TO) filters.push(Query.lessThanEqual('date', TO));
    const rows = (await scan(COL.releases, filters)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    console.log(`release rows scanned: ${rows.length}\n`);

    const plan = []; const skipped = {};
    const skip = (why, r) => { (skipped[why] = skipped[why] || []).push(`${r.date} ${r.qrId}`); };
    for (const r of rows) {
        const released = Number(r.releasedPaise || 0);
        if (!(released > 0)) { skip('released 0', r); continue; }
        if (Number(r.feePaise || 0) > 0) { skip('fee already charged', r); continue; }
        if (r.chargeCommission === false) { skip('chargeCommission:false', r); continue; }
        const qr = await one(COL.qr, [Query.equal('qrId', r.qrId)]);
        if (!qr) { skip('QR doc not found', r); continue; }
        if (!qr.assignedUserId) { skip('QR unassigned (nobody to charge)', r); continue; }
        const { rate, from } = rateFor(qr.assignedUserId);
        const fee = ceilPct(released, rate);
        if (fee <= 0) { skip(`rate 0 (${from})`, r); continue; }
        const l = (k) => Number(qr[k] || 0);
        const newAvailable = l('totalPayInAmount') - l('withdrawalApprovedAmount') - l('withdrawalRequestedAmount') - l('amountOnHold') - l('commissionOnHold') - (l('commissionPaid') + fee);
        if (newAvailable < 0) { skip(`would make QR balance negative (available ${rs(l('amountAvailableForWithdrawal'))} < fee ${rs(fee)})`, r); continue; }
        const payer = U[qr.assignedUserId], sub = payer?.parentId ? U[payer.parentId] : null;
        plan.push({ r, qr, fee, rate, from, payer, sub });
    }

    console.log('date        qrId                        released         rate   fee          payer                 subadmin');
    for (const p of plan) console.log(`${p.r.date}  ${String(p.r.qrId).padEnd(26)} ${rs(p.r.releasedPaise).padStart(14)}  ${String(p.rate + '%').padStart(5)} ${rs(p.fee).padStart(12)}  ${String(p.payer?.name || p.qr.assignedUserId).slice(0, 20).padEnd(20)}  ${String(p.sub?.name || '-').slice(0, 20)}`);
    const totalFee = plan.reduce((s, p) => s + p.fee, 0);
    console.log(`\nto charge: ${plan.length} rows, ${rs(totalFee)} → all to admin ${admin.userId}`);
    for (const [why, list] of Object.entries(skipped)) console.log(`skipped (${why}): ${list.length}${list.length <= 6 ? '  ' + list.join(', ') : ''}`);
    if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write to apply.\n'); return; }
    if (!plan.length) { console.log('\nNothing to charge; rebuilding rollups/counter from existing rows only.'); }

    if (!E.REDIS_URL) { console.error('❌ REDIS_URL is required for --write (QR ledger lock).'); process.exit(1); }
    const { createClient } = require('redis');
    redis = createClient({ url: E.REDIS_URL }); redis.on('error', () => {});
    try { await redis.connect(); } catch (e) { console.error('❌ Redis unreachable — refusing to write unlocked:', e.message); process.exit(1); }

    let charged = 0, failed = 0;
    for (const p of plan) {
        try {
            await withQrLock(p.r.qrId, async () => {
                const qr = await one(COL.qr, [Query.equal('qrId', p.r.qrId)]);        // fresh under lock
                const rel = await db.getDocument(DB, COL.releases, p.r.$id);
                if (Number(rel.feePaise || 0) > 0) { console.log(`  ↩︎  ${p.r.date} ${p.r.qrId}: fee appeared meanwhile, skipped`); return; }
                const l = (k) => Number(qr[k] || 0);
                const commissionPaid = l('commissionPaid') + p.fee;
                const newAvailable = l('totalPayInAmount') - l('withdrawalApprovedAmount') - l('withdrawalRequestedAmount') - l('amountOnHold') - l('commissionOnHold') - commissionPaid;
                if (newAvailable < 0) throw new Error('would go negative under lock');
                const at = rel.createdAt || rel.updatedAt || `${rel.date}T12:00:00.000Z`;
                // 1. commission row FIRST (the durable record), 2. ledger, 3. stamp the release row
                await db.createDocument(DB, COL.comm, ID.unique(), { userId: admin.userId, sourceWithdrawalId: `release:${rel.$id}`, amount: p.fee, commissionRate: p.rate, earningType: 'admin', commissionType: 'early_release', createdAt: at });
                await db.updateDocument(DB, COL.qr, qr.$id, { commissionPaid, amountAvailableForWithdrawal: newAvailable });
                await db.updateDocument(DB, COL.releases, rel.$id, { feePaise: p.fee, feeRate: p.rate, feePayerUserId: qr.assignedUserId, feePayerName: p.payer?.name || null, payerSubadminId: p.payer?.parentId || null, payerSubadminName: p.sub?.name || null, releasedByName: U[rel.releasedBy]?.name || null });
                charged++; console.log(`  ✅ ${p.r.date} ${p.r.qrId}: ${rs(p.fee)} (${p.rate}% ${p.from})`);
            });
        } catch (e) { failed++; console.error(`  ❌ ${p.r.date} ${p.r.qrId}: ${e.message}`); }
    }

    // ── rollups + counter: recompute-and-overwrite from every early_release row ──────────────────
    const all = await scan(COL.comm, [Query.equal('commissionType', 'early_release')]);
    const daily = {}, monthly = {}, allTime = {}; let grand = 0;
    for (const c of all) { const a = Number(c.amount || 0); grand += a; (daily[istDay(c.createdAt)] = daily[istDay(c.createdAt)] || {})[c.userId] = ((daily[istDay(c.createdAt)] || {})[c.userId] || 0) + a; const mk = `${c.userId}|${istMonth(c.createdAt)}`; monthly[mk] = (monthly[mk] || 0) + a; allTime[c.userId] = (allTime[c.userId] || 0) + a; }
    for (const [date, map] of Object.entries(daily)) { const d = await one(COL.daily, [Query.equal('date', date)]); const payload = { date, commissionsJson: JSON.stringify(map) }; if (d) await db.updateDocument(DB, COL.daily, d.$id, payload); else await db.createDocument(DB, COL.daily, ID.unique(), payload); }
    for (const [k, v] of Object.entries(monthly)) { const [userId, month] = k.split('|'); const d = await one(COL.monthly, [Query.equal('userId', userId), Query.equal('month', month)]); if (d) await db.updateDocument(DB, COL.monthly, d.$id, { totalCommissionPaise: v }); else await db.createDocument(DB, COL.monthly, ID.unique(), { userId, month, totalCommissionPaise: v }); }
    for (const [userId, v] of Object.entries(allTime)) { const d = await one(COL.allTime, [Query.equal('userId', userId)]); if (d) await db.updateDocument(DB, COL.allTime, d.$id, { totalCommissionPaise: v }); else await db.createDocument(DB, COL.allTime, ID.unique(), { userId, totalCommissionPaise: v }); }
    const cdoc = await one(COL.counters, [Query.equal('id', 'totalEarlyReleaseAdminProfit')]);
    if (cdoc) await db.updateDocument(DB, COL.counters, cdoc.$id, { totals: grand }); else await db.createDocument(DB, COL.counters, ID.unique(), { id: 'totalEarlyReleaseAdminProfit', totals: grand });

    await redis.quit().catch(() => {});
    console.log(`\ncharged ${charged}, failed ${failed}. Rollups rebuilt from ${all.length} early-release rows: ${Object.keys(daily).length} days, ${Object.keys(monthly).length} month rows, counter totalEarlyReleaseAdminProfit = ${rs(grand)}.\n`);
}

main().catch((e) => { console.error('\nbackfill failed:', e?.message || e); process.exit(1); });
