// qrSettlement.js
// THE single definition of "how much of a QR's balance may be withdrawn right now".
//
// Default settlement is T+1: money that arrived today is held until tomorrow. It is DERIVED, never
// stored — at IST midnight "today" moves on and yesterday's pay-in becomes withdrawable by itself,
// with no job to run and nothing to fail.
//
// An admin may release part (or all) of today's pay-in for ONE QR for ONE IST day — a T+0 exception —
// capped by the config percentage `qr_daily_release_max_percent`.
//
//     heldPaise         = max(0, todayPayInPaise − releasedPaise)
//     withdrawablePaise = amountAvailableForWithdrawal − heldPaise
//
// A release is a GATE, never money. It changes what may be withdrawn, never a stored balance, so it
// takes no lock, touches no ledger and cannot corrupt a total. It can never raise
// `amountAvailableForWithdrawal`, so the most any release can unlock is today's own pay-in, and the
// available balance is still the hard ceiling above it.
//
// With no release the formula is byte-identical to the previous behaviour (released = 0 →
// held = todayPayIn), so every existing figure is unchanged until an admin acts.
//
// EVERY caller must use this module. The rule previously lived in five places (withdraw.js request
// validation, the user and subadmin dashboards, the QR list projections); duplicating it again is how
// the screen and the server start disagreeing.

const moment = require('moment-timezone');
const ConfigManager = require('./configManager');

let _db = null, _Query = null, _dbId = null, _dailyQrCol = null, _releasesCol = null;

function init({ databases, Query, APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID }) {
    _db = databases;
    _Query = Query;
    _dbId = APPWRITE_DATABASE_ID;
    _dailyQrCol = APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID;
    _releasesCol = APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID;
}

/** IST business day key, matching every other daily bucket in the codebase. */
const istDay = (ts = new Date()) => moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD');

/**
 * Ceiling on how much of one day's pay-in an admin may release, as a percentage.
 * NOTE: unlike the payout limits, **0 does NOT mean "no limit" here — it means nothing may be
 * released at all** (a kill switch). 100 means all of today's pay-in may be released.
 */
function maxPercent() {
    const v = Number(ConfigManager.get('qr_daily_release_max_percent', 50));
    if (!isFinite(v) || v < 0) return 0;   // fail closed on a bad value
    return Math.min(100, v);
}

/** Most that may be released for a QR today, in paise. Rounded DOWN so the cap is never exceeded. */
function maxReleasablePaise(todayPayInPaise) {
    return Math.floor(Math.max(0, Number(todayPayInPaise) || 0) * maxPercent() / 100);
}

/** Today's pay-in still held back from withdrawal. Never negative. */
function heldPaise(todayPayInPaise, releasedPaise) {
    return Math.max(0, (Number(todayPayInPaise) || 0) - (Number(releasedPaise) || 0));
}

/**
 * What may be withdrawn from this QR right now.
 * Can be negative when a QR's available balance is already below what arrived today; that is the
 * pre-existing behaviour and the aggregates depend on it, so it is deliberately NOT clamped here.
 * Clamp at zero for display only.
 */
function withdrawablePaise(availablePaise, todayPayInPaise, releasedPaise) {
    return (Number(availablePaise) || 0) - heldPaise(todayPayInPaise, releasedPaise);
}

/** { qrId: paise } of everything that arrived on `day`. Empty map when the summary is missing. */
async function todayPayIns(day = istDay()) {
    if (!_db || !_dailyQrCol) return {};
    try {
        const r = await _db.listDocuments(_dbId, _dailyQrCol, [_Query.equal('date', day), _Query.limit(1)]);
        if (!r.total) return {};
        return JSON.parse(r.documents[0].totalsJson || '{}') || {};
    } catch (e) {
        console.error('qrSettlement: could not read the daily pay-in summary —', e.message);
        return {};
    }
}

/**
 * { qrId: releasedPaise } for `day`. **Fails closed**: any error returns an empty map, which means
 * full T+1 holding. Never fail open here — that would let money out early on an infrastructure blip.
 */
async function releasesFor(qrIds, day = istDay()) {
    const out = {};
    if (!_db || !_releasesCol) return out;
    const ids = [...new Set((qrIds || []).filter(Boolean))];
    if (!ids.length) return out;
    try {
        for (let i = 0; i < ids.length; i += 100) {   // Appwrite caps one equal() at 100 values
            const chunk = ids.slice(i, i + 100);
            const r = await _db.listDocuments(_dbId, _releasesCol, [
                _Query.equal('date', day), _Query.equal('qrId', chunk), _Query.limit(100),
            ]);
            for (const d of r.documents) out[d.qrId] = Number(d.releasedPaise || 0);
        }
        return out;
    } catch (e) {
        console.error('qrSettlement: release lookup failed, holding everything (fail closed) —', e.message);
        return {};
    }
}

/** One QR, with the caller's freshly computed available balance (never the stored field). */
async function forQr(qrId, availablePaise, day = istDay()) {
    const [payins, released] = await Promise.all([todayPayIns(day), releasesFor([qrId], day)]);
    return row(qrId, availablePaise, Number(payins[qrId] || 0), Number(released[qrId] || 0), day);
}

/** Many QR docs, using each doc's stored `amountAvailableForWithdrawal`. One pair of reads total. */
async function forQrDocs(qrDocs, day = istDay()) {
    const qrs = (Array.isArray(qrDocs) ? qrDocs : [qrDocs]).filter(Boolean);
    const [payins, released] = await Promise.all([todayPayIns(day), releasesFor(qrs.map((q) => q.qrId), day)]);
    const rows = qrs.map((q) => row(q.qrId, Number(q.amountAvailableForWithdrawal || 0), Number(payins[q.qrId] || 0), Number(released[q.qrId] || 0), day));
    return { day, maxPercent: maxPercent(), rows, byQrId: Object.fromEntries(rows.map((r) => [r.qrId, r])), totals: totalsOf(rows) };
}

function row(qrId, availablePaise, todayPayInPaise, releasedPaise, day = istDay()) {
    const available = Number(availablePaise) || 0;
    return {
        qrId, date: day,
        availablePaise: available,
        todayPayInPaise: Number(todayPayInPaise) || 0,
        releasedPaise: Number(releasedPaise) || 0,
        heldPaise: heldPaise(todayPayInPaise, releasedPaise),
        withdrawablePaise: withdrawablePaise(available, todayPayInPaise, releasedPaise),
        maxReleasablePaise: maxReleasablePaise(todayPayInPaise),
    };
}

/** Sums for a dashboard. `withdrawablePaise` is the sum of the raw per-QR values, matching the
 *  aggregate the dashboards produced before releases existed. */
function totalsOf(rows) {
    return rows.reduce((t, r) => ({
        availablePaise: t.availablePaise + r.availablePaise,
        todayPayInPaise: t.todayPayInPaise + r.todayPayInPaise,
        releasedPaise: t.releasedPaise + r.releasedPaise,
        heldPaise: t.heldPaise + r.heldPaise,
        withdrawablePaise: t.withdrawablePaise + r.withdrawablePaise,
    }), { availablePaise: 0, todayPayInPaise: 0, releasedPaise: 0, heldPaise: 0, withdrawablePaise: 0 });
}

// ─── writes (admin only; the route enforces the role, this module enforces the money rules) ──────

function fail(status, message) { return Object.assign(new Error(message), { status }); }
const rs = (paise) => `₹${(paise / 100).toFixed(2)}`;

/** The release row for one QR on one day, or null. */
async function getRelease(qrId, day = istDay()) {
    if (!_db || !_releasesCol) return null;
    const r = await _db.listDocuments(_dbId, _releasesCol, [_Query.equal('qrId', qrId), _Query.equal('date', day), _Query.limit(1)]);
    return r.documents[0] || null;
}

/**
 * SET (not add) how much of today's pay-in is released for one QR. Absolute semantics: sending the
 * same value twice changes nothing, so a double submit can never double-release.
 *
 * Enforces, in order: a non-negative integer amount, and the `qr_daily_release_max_percent` ceiling
 * against the QR's pay-in for that day. Rejects rather than clamping, so an admin always knows
 * exactly what was granted. `ID` is passed in by the caller (node-appwrite's ID helper).
 */
async function setRelease({ ID, qrId, releasedPaise, reason, byUserId, day = istDay() }) {
    if (!_db || !_releasesCol) throw fail(500, 'QR release storage is not configured on this server');
    if (!qrId) throw fail(400, 'qrId is required');
    const amount = Number(releasedPaise);
    if (!Number.isInteger(amount) || amount < 0) throw fail(400, 'Invalid release amount');
    const note = String(reason || '').trim();
    if (note.length < 4) throw fail(400, 'A reason is required (min 4 characters)');

    const payins = await todayPayIns(day);
    const todayPayInPaise = Number(payins[qrId] || 0);
    const cap = maxReleasablePaise(todayPayInPaise);
    if (amount > cap) {
        throw fail(400, maxPercent() === 0
            ? 'Early release is switched off (qr_daily_release_max_percent is 0)'
            : `Cannot release ${rs(amount)}. The limit is ${maxPercent()}% of this QR's pay-in for ${day} (${rs(todayPayInPaise)}), which is ${rs(cap)}.`);
    }

    const payload = {
        qrId, date: day, releasedPaise: amount,
        todayPayInAtSetPaise: todayPayInPaise, maxPercentAtSet: maxPercent(),
        reason: note.slice(0, 300), releasedBy: byUserId || null, updatedAt: new Date().toISOString(),
    };
    const existing = await getRelease(qrId, day);
    if (existing) return _db.updateDocument(_dbId, _releasesCol, existing.$id, payload);
    try {
        return await _db.createDocument(_dbId, _releasesCol, ID.unique(), { ...payload, createdAt: payload.updatedAt });
    } catch (e) {
        const again = await getRelease(qrId, day);          // unique (qrId,date) race: reuse the winner
        if (!again) throw e;
        return _db.updateDocument(_dbId, _releasesCol, again.$id, payload);
    }
}

/** Releases for one day, newest first. Cursor-paginated like every other list endpoint. */
async function listReleases({ day = istDay(), qrId = null, limit = 25, cursor = null } = {}) {
    if (!_db || !_releasesCol) return { total: 0, documents: [] };
    const q = [_Query.equal('date', day)];
    if (qrId) q.push(_Query.equal('qrId', qrId));
    q.push(_Query.orderDesc('$createdAt'));
    if (cursor) q.push(_Query.cursorAfter(cursor));
    q.push(_Query.limit(limit));
    return _db.listDocuments(_dbId, _releasesCol, q);
}

/** Response shape for a release row. */
const pickRelease = (d) => (!d ? null : {
    $id: d.$id, qrId: d.qrId, date: d.date,
    releasedPaise: Number(d.releasedPaise || 0), releasedRs: Number(d.releasedPaise || 0) / 100,
    todayPayInAtSetPaise: Number(d.todayPayInAtSetPaise || 0), maxPercentAtSet: Number(d.maxPercentAtSet || 0),
    reason: d.reason || null, releasedBy: d.releasedBy || null,
    createdAt: d.createdAt || d.$createdAt || null, updatedAt: d.updatedAt || null,
});

module.exports = {
    init, istDay, maxPercent, maxReleasablePaise,
    heldPaise, withdrawablePaise, todayPayIns, releasesFor,
    forQr, forQrDocs, row, totalsOf,
    getRelease, setRelease, listReleases, pickRelease,
};
