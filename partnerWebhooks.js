// partnerWebhooks.js
// Outbound webhook system: when a transaction is created or its status changes, POST a
// signed event to the webhook URL of every partner that owns it. Modeled on Razorpay/Stripe:
//   - never blocks the payment write path (dispatch is fire-and-forget),
//   - each event is persisted as a delivery row (partner_webhook_deliveries),
//   - a background worker retries failures with exponential backoff and dead-letters,
//   - every POST is HMAC-SHA256 signed with the partner's webhookSecret.
//
// Ownership: a partner's `userId` is a subadmin id, and each transaction carries
// `ownerSubadminId` (stamped at write time by qrOwnerCache). So the partners to notify are
// exactly those whose userId === txn.ownerSubadminId and who have webhooks enabled.

const crypto = require('crypto');
const axios = require('axios');

let _databases = null;
let _Query = null;
let _ID = null;
let _dbId = null;
let _partnersColId = null;
let _deliveriesColId = null;

// Delivery tuning
const TIMEOUT_MS = 10000;
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600]; // 1m, 5m, 30m, 2h, 6h
const MAX_ATTEMPTS = 1 + BACKOFF_SECONDS.length;       // 1 immediate + 5 retries = 6
const WORKER_BATCH = 25;
// New deliveries are stamped due this far in the future so the inline first attempt runs
// before the worker could pick the same row (avoids a double-send race). If the process
// dies before the inline attempt finishes, the worker still redelivers after this grace.
const PENDING_GRACE_MS = 120000;

// In-memory indexes, rebuilt from api_partners.
let bySubadmin = new Map();      // userId -> [{ partnerId, url, secret }]
let secretByPartner = new Map(); // partnerId -> { url, secret }
let _workerRunning = false;

function init({ databases, Query, ID, APPWRITE_DATABASE_ID, APPWRITE_API_PARTNERS_COLLECTION_ID, APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID }) {
    _databases = databases;
    _Query = Query;
    _ID = ID;
    _dbId = APPWRITE_DATABASE_ID;
    _partnersColId = APPWRITE_API_PARTNERS_COLLECTION_ID;
    _deliveriesColId = APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID;
    console.log('partnerWebhooks: initialised');
}

// ── Index of enabled webhook partners ────────────────────────────────────────
async function reloadIndex() {
    if (!_databases) return;
    try {
        const nextBySub = new Map();
        const nextByPartner = new Map();
        let cursor = null;
        for (let page = 0; page < 1000; page++) {
            const q = [_Query.limit(100)];
            if (cursor) q.push(_Query.cursorAfter(cursor));
            const res = await _databases.listDocuments(_dbId, _partnersColId, q);
            for (const p of res.documents) {
                if (!p.webhookEnabled || !p.webhookUrl || !p.webhookSecret || !p.userId || !p.status) continue;
                const entry = { partnerId: p.partnerId, url: p.webhookUrl, secret: p.webhookSecret };
                if (!nextBySub.has(p.userId)) nextBySub.set(p.userId, []);
                nextBySub.get(p.userId).push(entry);
                nextByPartner.set(p.partnerId, { url: p.webhookUrl, secret: p.webhookSecret });
            }
            if (res.documents.length < 100) break;
            cursor = res.documents[res.documents.length - 1].$id;
        }
        bySubadmin = nextBySub;
        secretByPartner = nextByPartner;
        console.log(`partnerWebhooks: index built — ${secretByPartner.size} webhook-enabled partner(s)`);
    } catch (e) {
        console.error('partnerWebhooks.reloadIndex error:', e.message);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

// Basic SSRF guard: require https and reject obvious internal/loopback/link-local hosts.
// (Does not resolve DNS; a hostname that resolves to a private IP is not caught here.)
function isSafeUrl(raw) {
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:') return false;
        const h = u.hostname.toLowerCase();
        if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) return false;
        if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return false;
        if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return false;
        return true;
    } catch { return false; }
}

function sign(payloadString, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

function txnView(txn) {
    return {
        id: txn.$id,
        qrCodeId: txn.qrCodeId,
        paymentId: txn.paymentId,
        rrnNumber: txn.rrnNumber,
        amount: txn.amount,
        vpa: txn.vpa,
        provider: txn.provider,
        created_at: txn.created_at,
        updatedAt: txn.$updatedAt,
        status: txn.status,
    };
}

// ── Dispatch (called from the txn write path; fire-and-forget) ────────────────
// Never await this in the payment pipeline — it schedules its own async work.
function dispatch(txn, eventType, extra = {}) {
    try {
        const ownerSubadminId = txn?.ownerSubadminId;
        if (!ownerSubadminId) return;
        const partners = bySubadmin.get(ownerSubadminId);
        if (!partners || !partners.length) return;

        for (const partner of partners) {
            _enqueueAndAttempt(partner, txn, eventType, extra)
                .catch(e => console.error('partnerWebhooks dispatch error:', e.message));
        }
    } catch (e) {
        console.error('partnerWebhooks.dispatch error:', e.message);
    }
}

async function _enqueueAndAttempt(partner, txn, eventType, extra) {
    const deliveryId = 'whd_' + _ID.unique();
    const payloadObj = {
        event: eventType,
        deliveryId,
        createdAt: nowIso(),
        data: { transaction: txnView(txn), ...extra },
    };
    const payloadJson = JSON.stringify(payloadObj);

    const doc = await _databases.createDocument(_dbId, _deliveriesColId, _ID.unique(), {
        deliveryId,
        partnerId: partner.partnerId,
        eventType,
        txnId: txn.$id,
        url: partner.url,
        payloadJson,
        status: 'pending',
        attempts: 0,
        maxAttempts: MAX_ATTEMPTS,
        nextAttemptAt: new Date(Date.now() + PENDING_GRACE_MS).toISOString(),
        createdAt: nowIso(),
    });

    await attemptDelivery(doc, partner.secret);
}

// Perform one delivery attempt and persist the outcome (success / failed+retry / dead).
async function attemptDelivery(doc, secret) {
    const attempts = (doc.attempts || 0) + 1;

    if (!secret) {
        // Partner no longer has a usable secret (disabled/removed) — stop trying.
        return _update(doc.$id, { status: 'dead', attempts, lastAttemptAt: nowIso(), error: 'No webhook secret for partner' });
    }
    if (!isSafeUrl(doc.url)) {
        return _update(doc.$id, { status: 'dead', attempts, lastAttemptAt: nowIso(), error: 'Unsafe or non-https webhook URL' });
    }

    try {
        const res = await axios.post(doc.url, doc.payloadJson, {
            headers: {
                'Content-Type': 'application/json',
                'X-Kitepay-Event': doc.eventType,
                'X-Kitepay-Delivery': doc.deliveryId,
                'X-Kitepay-Signature': sign(doc.payloadJson, secret),
            },
            timeout: TIMEOUT_MS,
            maxRedirects: 0,
            validateStatus: () => true, // we inspect the code ourselves
        });

        if (res.status >= 200 && res.status < 300) {
            return _update(doc.$id, { status: 'success', attempts, lastAttemptAt: nowIso(), responseCode: res.status, error: null });
        }
        return _fail(doc, attempts, res.status, `HTTP ${res.status}`);
    } catch (e) {
        return _fail(doc, attempts, 0, (e.code || e.message || 'request failed').slice(0, 2000));
    }
}

function _fail(doc, attempts, responseCode, error) {
    if (attempts >= (doc.maxAttempts || MAX_ATTEMPTS)) {
        return _update(doc.$id, { status: 'dead', attempts, lastAttemptAt: nowIso(), responseCode, error });
    }
    const delaySec = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
    const next = new Date(Date.now() + delaySec * 1000).toISOString();
    return _update(doc.$id, { status: 'failed', attempts, lastAttemptAt: nowIso(), nextAttemptAt: next, responseCode, error });
}

async function _update(id, fields) {
    try { return await _databases.updateDocument(_dbId, _deliveriesColId, id, fields); }
    catch (e) { console.error('partnerWebhooks._update error:', e.message); }
}

// ── Retry worker ─────────────────────────────────────────────────────────────
// Picks due deliveries (pending/failed with nextAttemptAt <= now) and re-attempts them.
async function processQueue() {
    if (!_databases || _workerRunning) return;
    _workerRunning = true;
    try {
        const due = await _databases.listDocuments(_dbId, _deliveriesColId, [
            _Query.or([_Query.equal('status', 'pending'), _Query.equal('status', 'failed')]),
            _Query.lessThanEqual('nextAttemptAt', nowIso()),
            _Query.orderAsc('nextAttemptAt'),
            _Query.limit(WORKER_BATCH),
        ]);

        for (const doc of due.documents) {
            const partner = secretByPartner.get(doc.partnerId);
            await attemptDelivery(doc, partner?.secret);
        }
        if (due.documents.length) console.log(`partnerWebhooks: processed ${due.documents.length} due deliver(ies)`);
    } catch (e) {
        console.error('partnerWebhooks.processQueue error:', e.message);
    } finally {
        _workerRunning = false;
    }
}

function startWorker(intervalMs = 60 * 1000) {
    setInterval(() => { processQueue().catch(e => console.error('partnerWebhooks worker tick:', e.message)); }, intervalMs);
    console.log(`partnerWebhooks: retry worker started (every ${Math.round(intervalMs / 1000)}s)`);
}

// Requeue a delivery for an immediate attempt (admin manual retry). Resets it to due-now.
async function requeue(deliveryId) {
    const list = await _databases.listDocuments(_dbId, _deliveriesColId, [_Query.equal('deliveryId', deliveryId), _Query.limit(1)]);
    const doc = list.documents[0];
    if (!doc) return null;
    await _update(doc.$id, { status: 'pending', nextAttemptAt: nowIso() });
    const partner = secretByPartner.get(doc.partnerId);
    const fresh = await _databases.getDocument(_dbId, _deliveriesColId, doc.$id);
    await attemptDelivery(fresh, partner?.secret);
    return _databases.getDocument(_dbId, _deliveriesColId, doc.$id);
}

// Generate a webhook signing secret (given to the partner so they can verify signatures).
function generateSecret() {
    return 'whsec_' + crypto.randomBytes(32).toString('hex');
}

// Retention: delete terminal deliveries (success/dead) older than the given windows, so the
// collection stays a bounded log rather than growing forever. Live rows (pending/failed) are
// never pruned. Run on a daily schedule. Returns how many of each were deleted.
const DAY_MS = 24 * 60 * 60 * 1000;
async function pruneOld({ successDays = 30, deadDays = 90 } = {}) {
    const counts = { success: 0, dead: 0 };
    if (!_databases) return counts;

    const plans = [
        { status: 'success', cutoff: new Date(Date.now() - successDays * DAY_MS).toISOString() },
        { status: 'dead',    cutoff: new Date(Date.now() - deadDays * DAY_MS).toISOString() },
    ];

    for (const plan of plans) {
        try {
            // Always fetch the oldest matching rows; deleting shrinks the set, so no cursor
            // is needed. The page cap is just a runaway guard.
            for (let page = 0; page < 100000; page++) {
                const res = await _databases.listDocuments(_dbId, _deliveriesColId, [
                    _Query.equal('status', plan.status),
                    _Query.lessThan('createdAt', plan.cutoff),
                    _Query.orderAsc('createdAt'),
                    _Query.limit(100),
                ]);
                if (!res.documents.length) break;
                for (const d of res.documents) {
                    try { await _databases.deleteDocument(_dbId, _deliveriesColId, d.$id); counts[plan.status]++; }
                    catch (e) { console.error('partnerWebhooks.pruneOld delete error:', e.message); }
                }
                if (res.documents.length < 100) break;
            }
        } catch (e) {
            console.error(`partnerWebhooks.pruneOld (${plan.status}) error:`, e.message);
        }
    }

    console.log(`partnerWebhooks: pruned ${counts.success} success + ${counts.dead} dead deliver(ies)`);
    return counts;
}

module.exports = {
    init, reloadIndex, dispatch, processQueue, startWorker, requeue, pruneOld,
    generateSecret, isSafeUrl, sign, MAX_ATTEMPTS,
};
