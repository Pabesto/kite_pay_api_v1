// userMetaCache.js
// Redis-backed cache for users_meta lookups.
// Reads: cached with short TTL. Writes: invalidate immediately.
//
// Resilience: every call checks `_redisClient?.isReady`. When Redis is unavailable
// (down, mid-reconnect, or never connected) that is false, so the call goes straight to
// Appwrite — the cache is a pure accelerator, never a hard dependency. The moment the
// shared client becomes ready again (node-redis auto-reconnects on drops, and server.js
// runs a periodic reconnect for boot-time outages), the very next call transparently
// resumes using Redis — no state to flip here.
//
// Toggle via env: set USE_USER_META_CACHE=false to disable Redis caching
// entirely. All calls fall through to direct Appwrite reads — useful for
// local dev when Redis isn't running. Default: enabled.

const CACHE_TTL = 60; // seconds
const KEY_PREFIX = 'usermeta:';
const ENABLED = String(process.env.USE_USER_META_CACHE ?? 'true').toLowerCase() !== 'false';

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
    console.log(`userMetaCache: ${ENABLED ? 'enabled' : 'disabled (USE_USER_META_CACHE=false)'}`);
}

// Get user meta by userId — cache-first, falls back to Appwrite
async function getUserMeta(userId) {
    if (!userId) return null;
    const cacheKey = KEY_PREFIX + userId;

    // Try cache (with 2s timeout to prevent hanging on broken Redis connections)
    try {
        if (ENABLED && _redisClient?.isReady) {
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
    if (doc && ENABLED && _redisClient?.isReady) {
        withTimeout(_redisClient.set(cacheKey, JSON.stringify(doc), { EX: CACHE_TTL }), 2000)
            .catch(e => console.error('userMetaCache write error:', e.message));
    }

    return doc;
}

// Invalidate cache after create/update/delete
async function invalidate(userId) {
    if (!userId || !ENABLED || !_redisClient?.isReady) return;
    try { await _redisClient.del(KEY_PREFIX + userId); }
    catch (e) { console.error('userMetaCache invalidate error:', e.message); }
}

module.exports = { init, getUserMeta, invalidate };
