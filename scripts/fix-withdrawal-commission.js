// fix-withdrawal-commission.js — retro-apply the ADMIN payin commission to an approved withdrawal that
// was charged 0 (e.g. a subadmin withdrawing for itself before its `commission` rate was set).
//
// Does, per withdrawal, exactly what /withdrawals/approve_new would have done with a non-zero rate
// (money first, then the ledgers, mirroring withdraw.js so a mid-way failure is reconcilable):
//   1. QR ledger  (lock:qr):        commissionPaid += c, amountAvailableForWithdrawal recomputed — refuses if it would go negative
//   2. withdrawal doc:              commission, amount = preAmount + commission, userCommissionRate/totalCommissionRate, audit note
//   3. commission_transactions:     one 'admin' earning row, sourceWithdrawalId = the withdrawal
//   4. rollups at the ORIGINAL day/month of processedAt (lock:commission:daily/monthly/alltime)
//   5. dashboard counter:           totalAdminProfit += c
// Untouched on purpose: the payout wallet (it received the principal, which is correct — the commission
// comes out of the QR), totalAmountPaid / totalPayoutWalletFunded (they count preAmount).
// Afterwards run the day-wise report rebuild so its commissionPaise agrees:
//   node scripts/backfill-withdrawal-daily-summaries.js --from <day> --to <day> --write
//
// Idempotent: skips a withdrawal that already has commission > 0 or any commission_transactions row.
// Refuses a withdrawal that was (partly) reverted to the QR. All locks fail closed. Dry-run by default.
//
//   node scripts/fix-withdrawal-commission.js --id wdh_1 --id wdh_2 --rate 2.2
//   node scripts/fix-withdrawal-commission.js --id wdh_1 --id wdh_2 --rate 2.2 --write
//   … --write --no-lock   # no Redis: skips every lock. ONLY when the QR is quiet (no pay-ins/withdrawals
//                         # on it for the ~2 s this runs) — a concurrent ledger write could be clobbered.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, ID, Query } = require('node-appwrite');
const { createClient } = require('redis');
const moment = require('moment-timezone');
const dashboardCounters = require('../dashboardCounters');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const NO_LOCK = args.includes('--no-lock');
const IDS = args.flatMap((a, i) => (a === '--id' ? [args[i + 1]] : []));
const RATE = args.includes('--rate') ? Number(args[args.indexOf('--rate') + 1]) : NaN;
if (!IDS.length || !(RATE > 0 && RATE <= 100)) { console.error('usage: --id wdh_… [--id …] --rate <percent 0<r<=100> [--write]'); process.exit(1); }

const {
  APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, REDIS_URL,
  APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_USERS_META_COLLECTION_ID,
  APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
  APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID,
  APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID,
} = process.env;
for (const [k, v] of Object.entries({ APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, REDIS_URL, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID })) {
  if (!v) { console.error(`❌ Missing required env var ${k}`); process.exit(1); }
}

const db = require('../appwriteDb')(new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY));
const DB = APPWRITE_DATABASE_ID;
// Locks are only needed for --write. REDIS_URL in .env is Render's internal host — from a laptop run
// this from the Render shell, or pass the external URL: REDIS_URL=rediss://… node scripts/fix-… --write
const redis = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false } });
redis.on('error', () => {});

const rsToPaise = (rs) => Math.round(Number(rs || 0) * 100);
// same rounding as withdraw.js calculateCommissionPaise: integer paise, rounded UP
const commissionPaiseFor = (preAmountPaise, rate) => Math.ceil(preAmountPaise * Math.round(rate * 100) / 10000);
const istDay = (ts) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');
const istMonth = (ts) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM');
const RELEASE = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

// Fail-closed lock: any Redis error or contention aborts this withdrawal (same posture as withdraw.js).
async function withLock(key, ttl, fn) {
  if (NO_LOCK) return fn();
  const val = `fix:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let ok = null;
  for (let i = 0; i < 10 && ok !== 'OK'; i++) {
    ok = await redis.set(key, val, { NX: true, EX: ttl }).catch(() => null);
    if (ok !== 'OK') await new Promise((r) => setTimeout(r, 50 + i * 40));
  }
  if (ok !== 'OK') throw new Error(`could not acquire ${key}`);
  try { return await fn(); }
  finally { await redis.eval(RELEASE, { keys: [key], arguments: [val] }).catch(() => {}); }
}

async function one(col, queries) { const r = await db.listDocuments(DB, col, [...queries, Query.limit(1)]); return r.documents[0] || null; }

async function upsertDaily(day, userId, delta) {
  await withLock(`lock:commission:daily:${day}`, 10, async () => {
    const doc = await one(APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, [Query.equal('date', day)]);
    let map = {};
    try { map = (doc && JSON.parse(doc.commissionsJson)) || {}; } catch { map = {}; }
    map[userId] = (map[userId] || 0) + delta;
    const payload = { date: day, commissionsJson: JSON.stringify(map) };
    if (doc) await db.updateDocument(DB, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, doc.$id, payload);
    else await db.createDocument(DB, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, ID.unique(), payload);
  });
}
async function upsertTotal(col, match, base, lockKey, delta) {
  await withLock(lockKey, 10, async () => {
    const row = await one(col, match);
    if (row) await db.updateDocument(DB, col, row.$id, { totalCommissionPaise: Number(row.totalCommissionPaise || 0) + delta });
    else await db.createDocument(DB, col, ID.unique(), { ...base, totalCommissionPaise: delta });
  });
}

async function fix(id, admin) {
  const w = await one(APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, [Query.equal('id', id)]);
  if (!w) return console.log(`✗ ${id}: not found`);
  const preAmountPaise = rsToPaise(w.preAmount);
  const c = commissionPaiseFor(preAmountPaise, RATE);
  const day = istDay(w.processedAt), month = istMonth(w.processedAt);
  console.log(`\n${id}: qr=${w.qrId} user=${w.userId} mode=${w.mode} status=${w.status} preAmount=₹${w.preAmount} commission=₹${w.commission} processedAt=${w.processedAt} (IST day ${day})`);

  if (w.status !== 'approved') return console.log(`  ✗ skip: status is ${w.status}`);
  if (rsToPaise(w.commission) > 0) return console.log(`  ✗ skip: already carries commission ₹${w.commission}`);
  if (Number(w.walletRevertedPaise || 0) > 0) return console.log(`  ✗ skip: partly reverted to QR (${w.walletRevertedPaise} paise) — handle by hand`);
  if (!(preAmountPaise > 0) || !(c > 0)) return console.log(`  ✗ skip: nothing to charge`);
  const existing = await db.listDocuments(DB, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, [Query.equal('sourceWithdrawalId', id), Query.limit(1)]);
  if (existing.total > 0) return console.log(`  ✗ skip: commission_transactions already has ${existing.total} row(s) for this withdrawal`);

  const qr = await one(APPWRITE_QRCODE_COLLECTION_ID, [Query.equal('qrId', w.qrId)]);
  if (!qr) return console.log(`  ✗ skip: QR ${w.qrId} not found`);
  const available = Number(qr.amountAvailableForWithdrawal || 0);
  console.log(`  plan: charge ${c} paise (₹${c / 100}) at ${RATE}% → admin ${admin.userId}; QR available ${available} → ${available - c}; rollups on ${day} / ${month}`);
  if (available - c < 0) return console.log(`  ✗ skip: QR available balance would go negative`);
  if (!WRITE) return console.log('  (dry run)');

  // 1) QR ledger under lock:qr — fresh read, every component re-derived (never trust the cached doc)
  await withLock(`lock:qr:${w.qrId}`, 30, async () => {
    const q = await one(APPWRITE_QRCODE_COLLECTION_ID, [Query.equal('qrId', w.qrId)]);
    const total = Number(q.totalPayInAmount || 0), approved = Number(q.withdrawalApprovedAmount || 0), requested = Number(q.withdrawalRequestedAmount || 0);
    const onHold = Number(q.amountOnHold || 0), commissionOnHold = Number(q.commissionOnHold || 0), commissionPaid = Number(q.commissionPaid || 0) + c;
    const newAvailable = total - approved - requested - onHold - commissionOnHold - commissionPaid;
    if (newAvailable < 0) throw new Error(`QR ${w.qrId} would go negative (${newAvailable}) — aborted before any write`);
    await db.updateDocument(DB, APPWRITE_QRCODE_COLLECTION_ID, q.$id, { commissionPaid, amountAvailableForWithdrawal: newAvailable });
    console.log(`  ✓ QR ledger: commissionPaid ${commissionPaid - c} → ${commissionPaid}, available → ${newAvailable}`);
  });

  // 2) withdrawal doc — what approve would have stored for a parent-less account (admin earns userCommissionRate)
  const note = `${w.notes ? w.notes + ' | ' : ''}commission ${RATE}% backfilled by scripts/fix-withdrawal-commission.js on ${new Date().toISOString()}`;
  await db.updateDocument(DB, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, w.$id, {
    commission: c / 100, amount: (preAmountPaise + c) / 100, userCommissionRate: RATE, totalCommissionRate: RATE, notes: note,
  });
  console.log(`  ✓ withdrawal doc: commission ₹${c / 100}, amount ₹${(preAmountPaise + c) / 100}`);

  // 3) commission ledger row (source of truth)
  await db.createDocument(DB, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, ID.unique(), {
    userId: admin.userId, sourceWithdrawalId: id, amount: c, commissionRate: RATE, earningType: 'admin', createdAt: new Date().toISOString(),
  });
  console.log('  ✓ commission_transactions row');

  // 4) rollups on the original period
  await upsertDaily(day, admin.userId, c);
  await upsertTotal(APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, [Query.equal('userId', admin.userId), Query.equal('month', month)], { userId: admin.userId, month }, `lock:commission:monthly:${admin.userId}:${month}`, c);
  await upsertTotal(APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, [Query.equal('userId', admin.userId)], { userId: admin.userId }, `lock:commission:alltime:${admin.userId}`, c);
  console.log(`  ✓ rollups: daily ${day}, monthly ${month}, all-time`);

  // 5) dashboard counter (2s batcher, flushed before exit)
  await dashboardCounters.updateDashboardCounter(db, DB, 'totalAdminProfit', c);
  console.log('  ✓ totalAdminProfit queued');
  return day;
}

(async () => {
  console.log(`Fix withdrawal commission — ${WRITE ? 'WRITE' : 'DRY RUN (pass --write to apply)'} — rate ${RATE}%`);
  if (WRITE && NO_LOCK) console.warn('⚠️  --no-lock: writing WITHOUT Redis locks. Make sure nothing else is touching these QRs right now.');
  if (WRITE && !NO_LOCK) {
    try { await redis.connect(); }
    catch (e) { console.error(`❌ Redis unreachable (${e.message}) — --write needs the locks. Run from the Render shell or set REDIS_URL to the external URL.`); process.exit(1); }
  }
  dashboardCounters.init({ APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID });
  const admin = await one(APPWRITE_USERS_META_COLLECTION_ID, [Query.equal('role', 'admin')]);
  if (!admin) throw new Error('admin users_meta not found');
  const days = new Set();
  for (const id of IDS) {
    try { const d = await fix(id, admin); if (d) days.add(d); }
    catch (e) { console.error(`  ❌ ${id}: ${e.message} — check which of the numbered steps printed ✓ and reconcile the rest by hand`); }
  }
  if (WRITE) { await new Promise((r) => setTimeout(r, 3500)); if (!NO_LOCK) await redis.quit(); } // let the counter batcher flush
  if (days.size) console.log(`\nNow rebuild the day-wise withdrawal report:\n  node scripts/backfill-withdrawal-daily-summaries.js --from ${[...days].sort()[0]} --to ${[...days].sort().pop()} --write`);
})().catch((e) => { console.error('❌', e.message || e); process.exit(1); });
