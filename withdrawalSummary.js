// withdrawalSummary.js — the day-wise WITHDRAWAL report rollup, the withdrawal twin of
// daily_qr_summaries (pay-in) and daily_payout_summaries (customer payouts).
//
// One doc per IST day in `daily_withdrawal_summaries`:
//   { date, totalsJson: { [qrId]: { direct: { paidPaise, commissionPaise, count },
//                                   wallet: { paidPaise, commissionPaise, count } } } }
//   direct = mode upi/bank (money left to the merchant's bank/UPI)
//   wallet = mode 'wallet' (moved into the merchant's payout wallet, payout.js)
//   paidPaise       = the withdrawal's preAmount — what the merchant received
//   commissionPaise = the payin commission charged on it
//   (the QR ledger was debited paidPaise + commissionPaise)
// Withdrawal docs store RUPEES (CLAUDE.md unit table) — converted to paise here, exactly once.
//
// Written by withdraw.js at approve, the one commit point where money leaves a QR. Approve is
// exactly-once (status pending→approved under lock:qr; a second approve is refused), so a re-run
// can never double-count. Rejects never touch it. A later revert-to-QR of a wallet withdrawal is
// NOT netted: the report is "what was approved that day" (the reverted amount stays visible on
// the withdrawal row as walletRevertedPaise).
//
// Day key = IST day of `processedAt` — the same key the backfill uses, so a recompute always lands
// on the doc the route reads. Merged under lock:withdrawal:daily:<day> (10s, fails closed).
//
// Report-only, never money: a failed write is logged CRITICAL by the caller and repaired by
// scripts/backfill-withdrawal-daily-summaries.js (recompute-and-overwrite). Read by
// GET /api/admin/withdrawal-summary (admin.js). Init'd from server.js like qrSettlement.js.

const moment = require('moment-timezone');

let _db = null, _Query = null, _ID = null, _redis = null, _dbId = null, _col = null;

function init({ databases, Query, ID, redisClient, APPWRITE_DATABASE_ID, APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID }) {
    _db = databases;
    _Query = Query;
    _ID = ID;
    _redis = redisClient;
    _dbId = APPWRITE_DATABASE_ID;
    _col = APPWRITE_DAILY_WITHDRAWAL_SUMMARIES_COLLECTION_ID;
}

const MODES = ['direct', 'wallet'];
const istDay = (ts = new Date()) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');
const rsToPaise = (rs) => { const n = Number(rs); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const emptyRow = () => ({ paidPaise: 0, commissionPaise: 0, count: 0 });
const modeOf = (w) => (w.mode === 'wallet' ? 'wallet' : 'direct');

/** target += row (mutates and returns target). */
function addRow(target, row) {
    target.paidPaise += Number(row?.paidPaise || 0);
    target.commissionPaise += Number(row?.commissionPaise || 0);
    target.count += Number(row?.count || 0);
    return target;
}

/**
 * Merge one approved withdrawal doc into a totals map (mutates and returns it).
 * Shared by the live writer and the backfill so both compute exactly the same numbers.
 */
function addWithdrawal(totals, w) {
    const qr = (totals[w.qrId] = totals[w.qrId] || {});
    const row = (qr[modeOf(w)] = { ...emptyRow(), ...(qr[modeOf(w)] || {}) });
    // preAmount is the net paid; legacy docs without it fall back to gross − commission.
    row.paidPaise += w.preAmount != null ? rsToPaise(w.preAmount) : rsToPaise(w.amount) - rsToPaise(w.commission);
    row.commissionPaise += rsToPaise(w.commission);
    row.count += 1;
    return totals;
}

const RELEASE_LUA = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

/** Run fn while holding lock:withdrawal:daily:<day> (10s, 10 tries, fails closed — a Redis error counts as busy). */
async function withDayLock(day, fn) {
    const lockKey = `lock:withdrawal:daily:${day}`;
    const lockVal = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let acquired = false;
    for (let i = 0; i < 10 && !acquired; i++) {
        acquired = (await _redis.set(lockKey, lockVal, { NX: true, EX: 10 }).catch(() => null)) === 'OK';
        if (!acquired) await new Promise((r) => setTimeout(r, 50 + i * 40));
    }
    if (!acquired) throw new Error(`Could not acquire ${lockKey}`);
    try { return await fn(); }
    finally { await _redis.eval(RELEASE_LUA, { keys: [lockKey], arguments: [lockVal] }).catch(() => {}); }
}

/**
 * Live writer: fold one just-approved withdrawal into its day's doc. Returns the day key, or null
 * when the rollup is not configured (the report simply stays empty). Throws on lock/DB failure —
 * the caller logs CRITICAL and never fails the approval.
 */
async function record(w) {
    if (!_col) return null;
    if (!w?.qrId) throw new Error('withdrawal has no qrId');
    const day = istDay(w.processedAt || new Date());
    return withDayLock(day, async () => {
        const doc = (await _db.listDocuments(_dbId, _col, [_Query.equal('date', day), _Query.limit(1)])).documents[0] || null;
        let totals = {};
        if (doc) {
            // A corrupt doc must not be overwritten with a partial map — that would silently drop every other QR's day.
            try { totals = JSON.parse(doc.totalsJson || '{}') || {}; }
            catch { throw new Error(`Corrupt totalsJson for ${day} — rebuild it with the backfill`); }
        }
        addWithdrawal(totals, w);
        const payload = { date: day, totalsJson: JSON.stringify(totals) };
        if (doc) await _db.updateDocument(_dbId, _col, doc.$id, payload);
        else await _db.createDocument(_dbId, _col, _ID.unique(), payload);
        return day;
    });
}

/**
 * Hold-and-reset (admin.js): move every day's `fromQrId` entry to `toQrId`, merging per mode when the
 * hold id already has one (same rule as the other summary collections; a backfill after the reset
 * reads the repointed withdrawal docs and lands on exactly these keys). Serialized per day with
 * the live writer. Returns the number of day docs changed.
 */
async function repointQr(fromQrId, toQrId) {
    if (!_col) return 0;
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const mergeQr = (existing, incoming) => {
        const out = {};
        for (const m of MODES) if (existing?.[m] || incoming?.[m]) out[m] = addRow(addRow(emptyRow(), existing?.[m]), incoming?.[m]);
        return out;
    };
    let moved = 0, cursor = null;
    for (let page = 0; page < 200; page++) { // ponytail: 20k day docs (~55 years)
        const q = [_Query.orderAsc('$id'), _Query.limit(100)];
        if (cursor) q.push(_Query.cursorAfter(cursor));
        const r = await _db.listDocuments(_dbId, _col, q);
        if (!r.documents.length) break;
        for (const doc of r.documents) {
            let obj;
            try { obj = JSON.parse(doc.totalsJson || '{}') || {}; }
            catch { console.error(`hold-and-reset: CORRUPT totalsJson in daily_withdrawal_summaries doc ${doc.$id} — skipping`); continue; }
            if (!hasOwn(obj, fromQrId)) continue;
            await withDayLock(doc.date, async () => {
                // Re-read under the lock so a concurrent approve's write is never clobbered.
                const fresh = await _db.getDocument(_dbId, _col, doc.$id);
                let f;
                try { f = JSON.parse(fresh.totalsJson || '{}') || {}; }
                catch { console.error(`hold-and-reset: CORRUPT totalsJson (locked) in daily_withdrawal_summaries doc ${doc.$id} — skipping`); return; }
                if (!hasOwn(f, fromQrId)) return;
                f[toQrId] = mergeQr(f[toQrId], f[fromQrId]);
                delete f[fromQrId];
                await _db.updateDocument(_dbId, _col, doc.$id, { totalsJson: JSON.stringify(f) });
                moved++;
            });
        }
        cursor = r.documents[r.documents.length - 1].$id;
        if (r.documents.length < 100) break;
    }
    return moved;
}

/** Reader: the parsed totals map for one IST day ({} when there is no doc; a corrupt doc logs and reads as {}). */
async function readDay(day) {
    if (!_col) throw Object.assign(new Error('Daily withdrawal summaries are not configured'), { status: 500 });
    const doc = (await _db.listDocuments(_dbId, _col, [_Query.equal('date', day), _Query.limit(1)])).documents[0];
    if (!doc) return {};
    try { return JSON.parse(doc.totalsJson || '{}') || {}; }
    catch (e) { console.error('WARNING: corrupted totalsJson for withdrawal day', day, '—', e.message); return {}; }
}

module.exports = { init, istDay, MODES, emptyRow, addRow, addWithdrawal, record, readDay, repointQr };
