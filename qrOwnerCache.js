// qrOwnerCache.js
// In-memory cache mapping each QR code -> the single subadmin who "owns" it, so we can
// stamp an `ownerSubadminId` onto every transaction at write time and then serve a
// partner's transactions with one indexed query (no per-request QR lookups). "Owns"
// mirrors admin.js getQrIdsForSubadmin: a subadmin S owns a QR if the QR was (a) assigned
// directly to S, (b) assigned to a user whose parentId is S, or (c) created by S.
// Each QR resolves to exactly one owner (assignment wins over creator).
//
// Freshness strategy:
//   - Full build at startup (buildAll).
//   - Periodic full refresh (server schedules refresh() on an interval).
//   - Lazy self-heal: resolve() falls back to a direct DB read on a cache miss and
//     populates the map, so brand-new QRs get attributed immediately.
// A QR reassignment propagates to *future* transactions within the refresh interval;
// already-written transactions keep the owner they had at payment time (re-stamp them
// with scripts/backfill-owner.js if you need historical re-attribution).

let _databases = null;
let _Query = null;
let _dbId = null;
let _qrColId = null;
let _usersMetaColId = null;

// qrId -> owning subadmin userId (string), or null if none
let qrToSubadmin = new Map();
let _ready = false;

function init({ databases, Query, APPWRITE_DATABASE_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_USERS_META_COLLECTION_ID }) {
    _databases = databases;
    _Query = Query;
    _dbId = APPWRITE_DATABASE_ID;
    _qrColId = APPWRITE_QRCODE_COLLECTION_ID;
    _usersMetaColId = APPWRITE_USERS_META_COLLECTION_ID;
    console.log('qrOwnerCache: initialised');
}

// Page through an entire collection with a cursor (stable for large collections).
async function _listAll(collectionId, extraQueries = []) {
    const out = [];
    let cursor = null;
    // Hard ceiling so a runaway never spins forever (10k pages * 100 = 1M docs).
    for (let page = 0; page < 10000; page++) {
        const queries = [...extraQueries, _Query.limit(100)];
        if (cursor) queries.push(_Query.cursorAfter(cursor));
        const res = await _databases.listDocuments(_dbId, collectionId, queries);
        out.push(...res.documents);
        if (res.documents.length < 100) break;
        cursor = res.documents[res.documents.length - 1].$id;
    }
    return out;
}

// Given the two candidate user ids on a QR and a userMeta lookup, return the single
// owning subadmin id (or null). `getMeta(userId)` returns { role, parentId } or null.
// Assignment reflects current ownership, so it wins over the creator.
function _ownerFor(assignedUserId, createdByUserId, getMeta) {
    if (assignedUserId) {
        const a = getMeta(assignedUserId);
        if (a && a.role === 'subadmin') return assignedUserId;   // (a) assigned to a subadmin
        if (a && a.parentId) return a.parentId;                  // (b) assigned to a user under a subadmin
    }
    if (createdByUserId) {
        const c = getMeta(createdByUserId);
        if (c && c.role === 'subadmin') return createdByUserId;  // (c) created by a subadmin
    }
    return null;
}

// Full rebuild of the map from Appwrite.
async function buildAll() {
    if (!_databases) { console.warn('qrOwnerCache.buildAll called before init'); return; }
    try {
        // 1. Load all users_meta into a lookup: userId -> { role, parentId }
        const metaDocs = await _listAll(_usersMetaColId);
        const metaByUser = new Map();
        for (const m of metaDocs) {
            if (m.userId) metaByUser.set(m.userId, { role: m.role, parentId: m.parentId || null });
        }
        const getMeta = (uid) => metaByUser.get(uid) || null;

        // 2. Load all QR docs and compute the owner for each.
        const qrDocs = await _listAll(_qrColId);
        const next = new Map();
        for (const qr of qrDocs) {
            if (!qr.qrId) continue;
            next.set(qr.qrId, _ownerFor(qr.assignedUserId, qr.createdByUserId, getMeta));
        }

        qrToSubadmin = next;
        _ready = true;
        console.log(`qrOwnerCache: built map for ${qrToSubadmin.size} QR codes (${metaByUser.size} users_meta)`);
    } catch (e) {
        console.error('qrOwnerCache.buildAll error:', e.message);
    }
}

// Alias used by the scheduled refresh.
async function refresh() { return buildAll(); }

// Synchronous read from the in-memory map (may be stale). Returns owner id or null.
function get(qrCodeId) {
    return qrToSubadmin.get(qrCodeId) ?? null;
}

// Read with lazy self-heal: on a miss, fetch the QR (+ the relevant users) from
// Appwrite, cache it, and return. Always returns an owner id or null.
async function resolve(qrCodeId) {
    if (!qrCodeId) return null;
    if (qrToSubadmin.has(qrCodeId)) return qrToSubadmin.get(qrCodeId);
    if (!_databases) return null;

    try {
        const qrRes = await _databases.listDocuments(
            _dbId, _qrColId,
            [_Query.equal('qrId', qrCodeId), _Query.limit(1)]
        );
        const qr = qrRes.documents[0];
        if (!qr) { qrToSubadmin.set(qrCodeId, null); return null; }

        const metaByUser = new Map();
        const loadMeta = async (uid) => {
            if (!uid || metaByUser.has(uid)) return;
            try {
                let doc = null;
                try {
                    doc = await _databases.getDocument(_dbId, _usersMetaColId, uid);
                } catch (e) {
                    if (e?.code === 404) {
                        const list = await _databases.listDocuments(_dbId, _usersMetaColId, [_Query.equal('userId', uid), _Query.limit(1)]);
                        doc = list.documents[0] || null;
                    } else throw e;
                }
                if (doc) metaByUser.set(uid, { role: doc.role, parentId: doc.parentId || null });
            } catch (_) { /* leave unknown */ }
        };

        await loadMeta(qr.assignedUserId);
        await loadMeta(qr.createdByUserId);
        // The assigned user's parent may itself be the owning subadmin.
        const assignedMeta = metaByUser.get(qr.assignedUserId);
        if (assignedMeta && assignedMeta.parentId) await loadMeta(assignedMeta.parentId);

        const owner = _ownerFor(qr.assignedUserId, qr.createdByUserId, (uid) => metaByUser.get(uid) || null);
        qrToSubadmin.set(qrCodeId, owner);
        return owner;
    } catch (e) {
        console.error('qrOwnerCache.resolve error:', e.message);
        return null;
    }
}

// Drop a QR from the cache so the next resolve() re-reads it (use after reassignment).
function invalidateQr(qrCodeId) { qrToSubadmin.delete(qrCodeId); }

function isReady() { return _ready; }
function size() { return qrToSubadmin.size; }

module.exports = { init, buildAll, refresh, get, resolve, invalidateQr, isReady, size, _ownerFor };
