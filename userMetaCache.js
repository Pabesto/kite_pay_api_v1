// userMetaCache.js
// Redis-backed cache for users_meta lookups.
// Reads: cached with short TTL. Writes: invalidate immediately.

const CACHE_TTL = 60; // seconds
const KEY_PREFIX = 'usermeta:';

let _redisClient = null;
let _databases = null;
let _dbId = null;
let _collectionId = null;
let _Query = null;

// Race a promise against a timeout
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Redis op timed out after ${ms}ms`)), ms)),
    ]);
}

function init({ redisClient, databases, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Query }) {
    _redisClient = redisClient;
    _databases = databases;
    _dbId = APPWRITE_DATABASE_ID;
    _collectionId = APPWRITE_USERS_META_COLLECTION_ID;
    _Query = Query;
}

// Get user meta by userId — cache-first, falls back to Appwrite
async function getUserMeta(userId) {
    if (!userId) return null;
    const cacheKey = KEY_PREFIX + userId;

    // Try cache (with 2s timeout to prevent hanging on broken Redis connections)
    try {
        if (_redisClient?.isOpen) {
            const cached = await withTimeout(_redisClient.get(cacheKey), 2000);
            if (cached) return JSON.parse(cached);
        }
    } catch (e) {
        console.error('userMetaCache read error:', e.message);
        // fall through to DB
    }

    // Cache miss — try direct doc fetch first (docId === userId), fall back to query
    let doc = null;
    try {
        doc = await _databases.getDocument(_dbId, _collectionId, userId);
    } catch (e) {
        // docId may not match userId for older users — fall back to query
        if (e?.code === 404) {
            const list = await _databases.listDocuments(
                _dbId, _collectionId,
                [_Query.equal('userId', userId), _Query.limit(1)]
            );
            doc = list.documents[0] || null;
        } else {
            throw e;
        }
    }

    // Populate cache (best-effort, don't block on write)
    if (doc && _redisClient?.isOpen) {
        withTimeout(_redisClient.set(cacheKey, JSON.stringify(doc), { EX: CACHE_TTL }), 2000)
            .catch(e => console.error('userMetaCache write error:', e.message));
    }

    return doc;
}

// Invalidate cache after create/update/delete
async function invalidate(userId) {
    if (!userId) return;
    try { await _redisClient.del(KEY_PREFIX + userId); }
    catch (e) { console.error('userMetaCache invalidate error:', e.message); }
}

module.exports = { init, getUserMeta, invalidate };
