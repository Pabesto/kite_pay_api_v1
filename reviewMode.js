// reviewMode.js
//
// In-memory manual-review-mode registry (SINGLE-PROCESS only — shared via the
// Node require cache).
//
// Default is AUTO everywhere. An admin can switch on MANUAL mode for a bounded
// window (1–MAX_MINUTES) scoped to:
//   • 'global' — every incoming transaction
//   • 'qr'     — a single QR (by qrId)
//   • 'user'   — all QRs owned by a user (matched via the QR's assignedUserId)
//
// Windows live only in process memory, so a server restart wipes them and the
// system boots fresh in AUTO — by design. Transactions already persisted as
// pending are recovered separately by the durable sweeper (they are NOT tracked
// here).

const MAX_MINUTES = 60;

// Active windows. `until` is an epoch-ms deadline.
const manualWindows = {
    global: null,       // { until, setBy, setAt } | null
    qr:   new Map(),    // qrId   -> { until, setBy, setAt }
    user: new Map(),    // userId -> { until, setBy, setAt }
};

function isActive(w) {
    return !!w && w.until > Date.now();
}

function describe(scope, qrId, userId, w) {
    return {
        scope,
        qrId: qrId || null,
        userId: userId || null,
        until: w.until,
        untilIso: new Date(w.until).toISOString(),
        remainingMs: Math.max(0, w.until - Date.now()),
        setBy: w.setBy || null,
        setAt: w.setAt || null,
        setAtIso: w.setAt ? new Date(w.setAt).toISOString() : null,
    };
}

// Normalize an owner argument (string | array | null) to a clean array of ids.
function toOwnerList(ownerUserIds) {
    if (!ownerUserIds) return [];
    return (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
}

// True if a matching, non-expired manual window covers this transaction.
// `ownerUserIds` may be a single id or an array — a 'user' window matches if it
// targets ANY of them (e.g. the QR's direct assignedUserId OR its managing subadmin).
function isManual(qrId, ownerUserIds) {
    if (isActive(manualWindows.global)) return true;
    if (qrId && isActive(manualWindows.qr.get(qrId))) return true;
    for (const uid of toOwnerList(ownerUserIds)) {
        if (isActive(manualWindows.user.get(uid))) return true;
    }
    return false;
}

// True if there is at least one active 'user'-scope window. Callers use this to
// decide whether it's worth resolving the QR's direct assignedUserId (an extra DB
// read) — skipped entirely when no user-scope window is active.
function hasActiveUserWindows() {
    for (const w of manualWindows.user.values()) {
        if (isActive(w)) return true;
    }
    return false;
}

// 'manual' | 'auto' for a given transaction context.
function effectiveMode(qrId, ownerUserId) {
    return isManual(qrId, ownerUserId) ? 'manual' : 'auto';
}

// Ingest-gate helper — single source of truth shared by every ingest path.
// Given a transaction's QR + resolved owner, returns whether it must be HELD for
// review and, if so, the extra fields to merge into the WEBHOOK_DATA document.
// In AUTO mode `fields` is empty, so normal ingest writes exactly the same document
// as before (no schema dependency on the review attributes).
//   windowMs = per-transaction auto-approve backstop (ms).
function reviewFieldsFor(qrId, ownerUserId, windowMs) {
    if (!isManual(qrId, ownerUserId)) {
        return { manual: false, fields: {} };
    }
    return {
        manual: true,
        fields: {
            deleted: true,
            reviewStatus: 'pending_review',
            reviewMode: 'manual',
            reviewExpiresAt: new Date(Date.now() + windowMs).toISOString(),
        },
    };
}

// Activate OR reset/extend a manual window. Throws on invalid input.
// Returns the stored window descriptor.
function setManual({ scope, qrId = null, userId = null, minutes, setBy = null }) {
    if (!['global', 'qr', 'user'].includes(scope)) {
        throw new Error("scope must be 'global', 'qr', or 'user'");
    }
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0 || mins > MAX_MINUTES) {
        throw new Error(`minutes must be a number between 1 and ${MAX_MINUTES}`);
    }
    if (scope === 'qr' && !qrId) throw new Error('qrId is required for scope "qr"');
    if (scope === 'user' && !userId) throw new Error('userId is required for scope "user"');

    const win = { until: Date.now() + mins * 60 * 1000, setBy, setAt: Date.now() };

    if (scope === 'global') manualWindows.global = win;
    else if (scope === 'qr') manualWindows.qr.set(qrId, win);
    else manualWindows.user.set(userId, win);

    return describe(scope, qrId, userId, win);
}

// Deactivate a manual window (back to auto). `all:true` clears everything.
// Returns the list of windows that were cleared.
function clearManual({ scope, qrId = null, userId = null, all = false } = {}) {
    const cleared = [];

    if (all) {
        if (manualWindows.global) cleared.push(describe('global', null, null, manualWindows.global));
        for (const [id, w] of manualWindows.qr) cleared.push(describe('qr', id, null, w));
        for (const [id, w] of manualWindows.user) cleared.push(describe('user', null, id, w));
        manualWindows.global = null;
        manualWindows.qr.clear();
        manualWindows.user.clear();
        return cleared;
    }

    if (!['global', 'qr', 'user'].includes(scope)) {
        throw new Error("scope must be 'global', 'qr', or 'user' (or pass all:true)");
    }

    if (scope === 'global') {
        if (manualWindows.global) cleared.push(describe('global', null, null, manualWindows.global));
        manualWindows.global = null;
    } else if (scope === 'qr') {
        if (!qrId) throw new Error('qrId is required for scope "qr"');
        const w = manualWindows.qr.get(qrId);
        if (w) { cleared.push(describe('qr', qrId, null, w)); manualWindows.qr.delete(qrId); }
    } else {
        if (!userId) throw new Error('userId is required for scope "user"');
        const w = manualWindows.user.get(userId);
        if (w) { cleared.push(describe('user', null, userId, w)); manualWindows.user.delete(userId); }
    }

    return cleared;
}

// List all currently ACTIVE windows (prunes expired entries as a side effect).
function listActive() {
    const out = [];

    if (manualWindows.global) {
        if (isActive(manualWindows.global)) out.push(describe('global', null, null, manualWindows.global));
        else manualWindows.global = null;
    }
    for (const [id, w] of manualWindows.qr) {
        if (isActive(w)) out.push(describe('qr', id, null, w));
        else manualWindows.qr.delete(id);
    }
    for (const [id, w] of manualWindows.user) {
        if (isActive(w)) out.push(describe('user', null, id, w));
        else manualWindows.user.delete(id);
    }

    return out;
}

module.exports = {
    MAX_MINUTES,
    isManual,
    hasActiveUserWindows,
    effectiveMode,
    reviewFieldsFor,
    setManual,
    clearManual,
    listActive,
};
