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
//
// INSTANCES: the module export is the QR instance (init'd from server.js, keyed by `qrId`). Bank
// accounts (bankAccounts.js) get their own instance via `create({ ..., keyField: 'bankAcId',
// label: 'bank account' })` over their own daily-summary and release collections — same formula, same
// cap key, different tables. Nothing about the arithmetic is per-instance.

const moment = require('moment-timezone');
const ConfigManager = require('./configManager');

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

function fail(status, message) { return Object.assign(new Error(message), { status }); }
const rs = (paise) => `₹${(paise / 100).toFixed(2)}`;
const HISTORY_LIMIT = 20;   // newest-first trail of changes kept on the single row for a (QR, day)

/** One independent settlement instance (its own tables, key field and label). */
function build() {
    let _db = null, _Query = null, _dbId = null, _dailyCol = null, _releasesCol = null;
    let _key = 'qrId', _label = 'QR', _instaCreditKey = null;

    function init({ databases, Query, APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID,
        dailySummariesCollectionId, releasesCollectionId, keyField, label, instaCreditKey }) {
        _db = databases;
        _Query = Query;
        _dbId = APPWRITE_DATABASE_ID;
        _dailyCol = dailySummariesCollectionId || APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID;
        _releasesCol = releasesCollectionId || APPWRITE_QR_DAILY_RELEASES_COLLECTION_ID;
        if (keyField) _key = keyField;
        if (label) _label = label;
        if (instaCreditKey !== undefined) _instaCreditKey = instaCreditKey;
    }

    /**
     * Does the T+1 hold apply to this instance right now? The QR instance: always. The bank instance is
     * built with `instaCreditKey: 'bank_account_insta_credit'`: while that config key is true, an approved
     * bank pay-in is withdrawable at once — nothing is held, so there is nothing to release and early
     * release is refused. The flag is read live on every call, so flipping the key needs no restart.
     */
    function holdEnabled() {
        if (!_instaCreditKey) return true;
        const v = ConfigManager.get(_instaCreditKey, false);
        return v == null ? true : ['false', '0', 'no', ''].includes(String(v).toLowerCase());
    }

    /** { id: paise } of everything that arrived on `day`. Empty map when the summary is missing. */
    async function todayPayIns(day = istDay()) {
        if (!_db || !_dailyCol) return {};
        try {
            const r = await _db.listDocuments(_dbId, _dailyCol, [_Query.equal('date', day), _Query.limit(1)]);
            if (!r.total) return {};
            return JSON.parse(r.documents[0].totalsJson || '{}') || {};
        } catch (e) {
            console.error(`qrSettlement(${_key}): could not read the daily pay-in summary —`, e.message);
            return {};
        }
    }

    /**
     * { id: releasedPaise } for `day`. **Fails closed**: any error returns an empty map, which means
     * full T+1 holding. Never fail open here — that would let money out early on an infrastructure blip.
     */
    async function releasesFor(ids, day = istDay()) {
        const out = {};
        if (!_db || !_releasesCol) return out;
        const list = [...new Set((ids || []).filter(Boolean))];
        if (!list.length) return out;
        try {
            for (let i = 0; i < list.length; i += 100) {   // Appwrite caps one equal() at 100 values
                const chunk = list.slice(i, i + 100);
                const r = await _db.listDocuments(_dbId, _releasesCol, [
                    _Query.equal('date', day), _Query.equal(_key, chunk), _Query.limit(100),
                ]);
                for (const d of r.documents) out[d[_key]] = Number(d.releasedPaise || 0);
            }
            return out;
        } catch (e) {
            console.error(`qrSettlement(${_key}): release lookup failed, holding everything (fail closed) —`, e.message);
            return {};
        }
    }

    function row(id, availablePaise, todayPayInPaise, releasedPaise, day = istDay()) {
        const available = Number(availablePaise) || 0;
        const hold = holdEnabled();   // insta-credit ON → nothing is held, nothing can be released
        return {
            [_key]: id, date: day,
            availablePaise: available,
            todayPayInPaise: Number(todayPayInPaise) || 0,
            releasedPaise: hold ? Number(releasedPaise) || 0 : 0,
            heldPaise: hold ? heldPaise(todayPayInPaise, releasedPaise) : 0,
            withdrawablePaise: hold ? withdrawablePaise(available, todayPayInPaise, releasedPaise) : available,
            maxReleasablePaise: hold ? maxReleasablePaise(todayPayInPaise) : 0,
            t1HoldApplies: hold,
        };
    }

    /**
     * One QR, with the caller's freshly computed available balance (never the stored field). Also carries
     * the release row's `chargeCommission` flag, which withdraw.js needs to price the early-release fee.
     * Fails closed like releasesFor: a failed lookup = no release = full hold = no fee.
     */
    async function forQr(id, availablePaise, day = istDay()) {
        const [payins, release] = await Promise.all([todayPayIns(day), getRelease(id, day).catch((e) => {
            console.error(`qrSettlement(${_key}): release lookup failed, holding everything (fail closed) —`, e.message); return null;
        })]);
        return { ...row(id, availablePaise, Number(payins[id] || 0), Number(release?.releasedPaise || 0), day), chargeCommission: !!release && release.chargeCommission !== false };
    }

    /** Many QR docs, using each doc's stored `amountAvailableForWithdrawal`. One pair of reads total. */
    async function forQrDocs(docs, day = istDay()) {
        const qrs = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
        const [payins, released] = await Promise.all([todayPayIns(day), releasesFor(qrs.map((q) => q[_key]), day)]);
        const rows = qrs.map((q) => row(q[_key], Number(q.amountAvailableForWithdrawal || 0), Number(payins[q[_key]] || 0), Number(released[q[_key]] || 0), day));
        return { day, maxPercent: maxPercent(), rows, byQrId: Object.fromEntries(rows.map((r) => [r[_key], r])), totals: totalsOf(rows) };
    }

    // ─── writes (admin only; the route enforces the role, this module enforces the money rules) ──────

    /** The release row for one QR on one day, or null. */
    async function getRelease(id, day = istDay()) {
        if (!_db || !_releasesCol) return null;
        const r = await _db.listDocuments(_dbId, _releasesCol, [_Query.equal(_key, id), _Query.equal('date', day), _Query.limit(1)]);
        return r.documents[0] || null;
    }

    /**
     * SET (not add) how much of today's pay-in is released for one QR.
     *
     * Give exactly ONE of:
     *   percent        — a share of that day's pay-in. Absolute: 50% twice is still 50%.
     *   releasedPaise  — the total the release should become. Absolute: ₹2,000 twice is still ₹2,000.
     *   addPaise       — release this much MORE on top of what is already released. Additive, for an
     *                    admin topping up several times a day. Requires `expectedReleasedPaise`, so a
     *                    retried request adds once and the second attempt is rejected as stale.
     *
     * Whatever the mode, what is STORED is always the absolute total, and the cap is always checked
     * against that total — so ten small top-ups can never add up past the ceiling.
     *
     * Optimistic concurrency — `expectedTodayPayInPaise` / `expectedReleasedPaise`:
     * the numbers the admin was looking at must still be true on the server, otherwise the write is
     * rejected with 409 and the fresh figures. This is REQUIRED for a percentage, because "50%" is
     * meaningless without knowing 50% of what: if more money arrived while the dialog was open, 50% now
     * means a bigger amount than the admin approved. It is optional but recommended for an absolute
     * amount, where it serves as an "someone else changed this" warning rather than a correctness fix.
     *
     * Then enforces the `qr_daily_release_max_percent` ceiling against that day's pay-in, rejecting
     * rather than clamping so an admin always knows exactly what was granted.
     * `ID` is passed in by the caller (node-appwrite's ID helper). The row id is `qrId` (or `id`).
     */
    async function setRelease({ ID, qrId, id, releasedPaise = null, percent = null, addPaise = null, expectedTodayPayInPaise = null, expectedReleasedPaise = null, reason, byUserId, day = istDay(), chargeCommission }) {
        const rowId = id ?? qrId;
        if (!_db || !_releasesCol) throw fail(500, `${_label === 'QR' ? 'QR' : 'Bank account'} release storage is not configured on this server`);
        if (!rowId) throw fail(400, `${_key} is required`);
        if (!holdEnabled()) throw fail(400, `Early release is not applicable: ${_instaCreditKey} is on, so ${_label} pay-ins are credited instantly and nothing is held`);
        if (chargeCommission !== undefined && typeof chargeCommission !== 'boolean') throw fail(400, 'chargeCommission must be true or false');
        const note = String(reason || '').trim();
        if (note.length < 4) throw fail(400, 'A reason is required (min 4 characters)');

        const has = (v) => v !== null && v !== undefined && v !== '';
        const byPercent = has(percent), byAmount = has(releasedPaise), byAdd = has(addPaise);
        if ([byPercent, byAmount, byAdd].filter(Boolean).length !== 1) throw fail(400, 'Send exactly one of percent, amount or addAmount');
        if (byPercent && !has(expectedTodayPayInPaise)) {
            throw fail(400, 'expectedTodayPayInPaise is required when releasing by percent, so the percentage is applied to the figure you were shown');
        }
        if (byAdd && !has(expectedReleasedPaise)) {
            throw fail(400, 'expectedReleasedPaise is required when adding to a release, so a retried request cannot add the same amount twice');
        }

        // Current server state — the basis for BOTH the percentage and the staleness check.
        const payins = await todayPayIns(day);
        const todayPayInPaise = Number(payins[rowId] || 0);
        const existing = await getRelease(rowId, day);
        const currentReleasedPaise = Number(existing?.releasedPaise || 0);
        const current = { todayPayInPaise, releasedPaise: currentReleasedPaise, maxPercent: maxPercent(), maxReleasablePaise: maxReleasablePaise(todayPayInPaise) };
        const stale = (label, shown, actual) => Object.assign(
            fail(409, `This ${_label} changed while the release dialog was open: ${label} is now ${rs(actual)}, you were shown ${rs(shown)}. Check the new figures and confirm again.`),
            { code: 'STALE_SETTLEMENT', current });
        if (has(expectedTodayPayInPaise) && Number(expectedTodayPayInPaise) !== todayPayInPaise) throw stale("today's pay-in", Number(expectedTodayPayInPaise), todayPayInPaise);
        if (has(expectedReleasedPaise) && Number(expectedReleasedPaise) !== currentReleasedPaise) throw stale('the already released amount', Number(expectedReleasedPaise), currentReleasedPaise);

        let amount, percentAtSet = null;
        if (byPercent) {
            const p = Number(percent);
            if (!isFinite(p) || p < 0 || p > 100) throw fail(400, 'percent must be between 0 and 100');
            if (p > maxPercent()) {
                throw fail(400, maxPercent() === 0
                    ? 'Early release is switched off (qr_daily_release_max_percent is 0)'
                    : `Cannot release ${p}% — the limit is ${maxPercent()}% of this ${_label}'s pay-in for ${day}.`);
            }
            percentAtSet = p;
            amount = Math.floor(todayPayInPaise * p / 100);   // floor: the cap is never exceeded by rounding
        } else if (byAdd) {
            const add = Number(addPaise);
            if (!Number.isInteger(add) || add <= 0) throw fail(400, 'The amount to add must be greater than zero');
            amount = currentReleasedPaise + add;              // stored absolute; the cap below checks the TOTAL
        } else {
            amount = Number(releasedPaise);
            if (!Number.isInteger(amount) || amount < 0) throw fail(400, 'Invalid release amount');
        }

        // The ceiling always applies to the resulting TOTAL, so repeated top-ups can never creep past it.
        const cap = maxReleasablePaise(todayPayInPaise);
        if (amount > cap) {
            throw fail(400, maxPercent() === 0
                ? 'Early release is switched off (qr_daily_release_max_percent is 0)'
                : byAdd
                    ? `Cannot add ${rs(Number(addPaise))}. That would take the release to ${rs(amount)}, and the limit is ${maxPercent()}% of this ${_label}'s pay-in for ${day} (${rs(todayPayInPaise)}), which is ${rs(cap)}. ${rs(Math.max(0, cap - currentReleasedPaise))} is still available to release.`
                    : `Cannot release ${rs(amount)}. The limit is ${maxPercent()}% of this ${_label}'s pay-in for ${day} (${rs(todayPayInPaise)}), which is ${rs(cap)}.`);
        }

        const at = new Date().toISOString();
        // Each change overwrites the single row for this (QR, day), so keep a bounded trail of the steps
        // that got here — an admin topping up through the day would otherwise leave no history.
        let history = [];
        try { history = JSON.parse(existing?.historyJson || '[]') || []; } catch { history = []; }
        history.unshift({ at, by: byUserId || null, fromPaise: currentReleasedPaise, toPaise: amount, mode: byPercent ? 'percent' : byAdd ? 'add' : 'set', reason: note.slice(0, 200) });
        history = history.slice(0, HISTORY_LIMIT);

        const payload = {
            [_key]: rowId, date: day, releasedPaise: amount,
            todayPayInAtSetPaise: todayPayInPaise, maxPercentAtSet: maxPercent(), percentAtSet,
            changeCount: Number(existing?.changeCount || 0) + 1,
            historyJson: JSON.stringify(history),
            reason: note.slice(0, 300), releasedBy: byUserId || null, updatedAt: at,
            // Early-release fee switch (withdraw.js prices the fee only while this is not false). Written only
            // when the admin sent it, so a schema without the attribute still accepts a plain release.
            ...(chargeCommission !== undefined ? { chargeCommission } : {}),
        };
        if (existing) return _db.updateDocument(_dbId, _releasesCol, existing.$id, payload);   // read above, under the staleness check
        try {
            return await _db.createDocument(_dbId, _releasesCol, ID.unique(), { ...payload, createdAt: payload.updatedAt });
        } catch (e) {
            const again = await getRelease(rowId, day);          // unique (id,date) race: reuse the winner
            if (!again) throw e;
            return _db.updateDocument(_dbId, _releasesCol, again.$id, payload);
        }
    }

    /**
     * Move every release row from one id to another — used by admin hold-and-reset, which archives a QR
     * under "<qrId>_hold" and stands up a fresh QR with the original id. Today's pay-in moves to the hold
     * with the summary key, so the gate that was granted against it must follow; left behind it would let
     * the FRESH QR withdraw new money on T+0 under a decision made for the old one, while the archived QR
     * fell back to full T+1 (safe, but not what the admin decided). Bounded: at most one row per day.
     *
     * Idempotent and resumable. The unique (id, date) index means the target may already hold a row for
     * a date (an admin released on "_hold" between an interrupted run and its retry): then the amounts are
     * merge-added, a history entry records it, and the source row is deleted. `dryRun` only counts.
     * Errors propagate — the caller's retry hint covers it.
     */
    async function repointReleases(fromId, toId, { dryRun = false } = {}) {
        if (!_db || !_releasesCol) return { scanned: 0, moved: 0, merged: 0 };
        let scanned = 0, moved = 0, merged = 0;
        const seen = new Set();   // a row that comes back after we handled it means no progress — stop, don't spin
        for (let page = 0; page < 1000; page++) {
            // Mutating the filter field drops each moved row out of the next query — no cursor needed.
            // In dryRun nothing is mutated, so one page is counted and we stop.
            const r = await _db.listDocuments(_dbId, _releasesCol, [_Query.equal(_key, fromId), _Query.limit(100)]);
            if (dryRun) { scanned = r.total ?? r.documents.length; break; }
            const todo = r.documents.filter((d) => !seen.has(d.$id));
            if (!todo.length) break;
            for (const src of todo) {
                seen.add(src.$id);
                scanned++;
                const dst = await getRelease(toId, src.date);
                if (!dst) {
                    await _db.updateDocument(_dbId, _releasesCol, src.$id, { [_key]: toId });
                    moved++;
                    continue;
                }
                const fromPaise = Number(dst.releasedPaise || 0), addPaise = Number(src.releasedPaise || 0);
                let history = [];
                try { history = JSON.parse(dst.historyJson || '[]') || []; } catch { history = []; }
                history.unshift({ at: new Date().toISOString(), by: null, fromPaise, toPaise: fromPaise + addPaise, mode: 'hold-reset-merge',
                    reason: `merged release of ${rs(addPaise)} from ${fromId} (hold-and-reset)`.slice(0, 200) });
                // Delete FIRST, then add. A crash in between loses the source amount (the hold QR simply holds
                // more — fails closed, an admin can re-release). The other order would double-add on retry and
                // release MORE than was ever decided, past the cap.
                await _db.deleteDocument(_dbId, _releasesCol, src.$id);
                await _db.updateDocument(_dbId, _releasesCol, dst.$id, {
                    releasedPaise: fromPaise + addPaise,
                    changeCount: Number(dst.changeCount || 0) + 1,
                    historyJson: JSON.stringify(history.slice(0, HISTORY_LIMIT)),
                    updatedAt: new Date().toISOString(),
                });
                merged++;
            }
        }
        return { scanned, moved, merged };
    }

    /** Releases for one day, newest first. Cursor-paginated like every other list endpoint. */
    async function listReleases({ day = istDay(), qrId = null, id = null, limit = 25, cursor = null } = {}) {
        if (!_db || !_releasesCol) return { total: 0, documents: [] };
        const rowId = id ?? qrId;
        const q = [_Query.equal('date', day)];
        if (rowId) q.push(_Query.equal(_key, rowId));
        q.push(_Query.orderDesc('$createdAt'));
        if (cursor) q.push(_Query.cursorAfter(cursor));
        q.push(_Query.limit(limit));
        return _db.listDocuments(_dbId, _releasesCol, q);
    }

    /** Response shape for a release row. */
    const pickRelease = (d) => (!d ? null : {
        $id: d.$id, [_key]: d[_key], date: d.date,
        releasedPaise: Number(d.releasedPaise || 0), releasedRs: Number(d.releasedPaise || 0) / 100,
        todayPayInAtSetPaise: Number(d.todayPayInAtSetPaise || 0), maxPercentAtSet: Number(d.maxPercentAtSet || 0),
        percentAtSet: d.percentAtSet == null ? null : Number(d.percentAtSet),
        changeCount: Number(d.changeCount || 0),
        chargeCommission: d.chargeCommission !== false,   // early-release fee applies unless the admin switched it off
        history: (() => { try { return JSON.parse(d.historyJson || '[]') || []; } catch { return []; } })(),
        reason: d.reason || null, releasedBy: d.releasedBy || null,
        createdAt: d.createdAt || d.$createdAt || null, updatedAt: d.updatedAt || null,
    });

    return {
        init, istDay, maxPercent, maxReleasablePaise,
        heldPaise, withdrawablePaise, todayPayIns, releasesFor,
        forQr, forQrDocs, row, totalsOf,
        getRelease, setRelease, listReleases, pickRelease, repointReleases,
        keyField: () => _key, holdEnabled,
    };
}

// The QR instance (module singleton, init'd from server.js) + a factory for further instances.
const qrInstance = build();
module.exports = qrInstance;
module.exports.create = (cfg) => { const i = build(); i.init(cfg); return i; };
