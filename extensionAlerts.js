// extensionAlerts.js — health/ops channel for the PhonePe & BharatPe browser capture extensions.
// Contract: ALERT-ENDPOINT-SPEC.md. Panel contract: EXTENSION_ALERTS_FRONTEND.md.
//
// NOT a money path. It never touches webhook_data, QR ledgers, summaries, counters, sockets or
// partner webhooks — it writes one Appwrite collection and one Redis key family. Do not add
// crediting here.
//
// AUTH: the SAME static key as the matching capture route — `X-API-Key` compared constant-time
// against <PROVIDER>_EXTENSION_API_KEY (PHONEPE_EXTENSION_API_KEY / BHARATPE_EXTENSION_API_KEY).
// Fails closed (503) when the env var is unset.
//
//   POST /phonepe-capture/alert    alerts + heartbeats from a PhonePe laptop
//   POST /bharatpe-capture/alert   same, BharatPe key
//   GET  /api/admin/extension-alerts/devices   live fleet, from Redis (admin) — the panel's main view
//   GET  /api/admin/extension-alerts           alert log, cursor-paginated (admin)
//
// WHERE STATE LIVES — deliberately split:
//
//   Device state → REDIS ONLY (`extdev:<provider>:<instanceId>`, JSON, TTL refreshed per write).
//     It is pure current-state and self-healing: lose Redis and the next heartbeat (≤1 min)
//     rebuilds every row. Same treatment as the hold-reset job state in admin.js. Heartbeats —
//     ~1440/device/day, 99% of the traffic — update ONLY this and are never written to Appwrite.
//     When Redis is down the fleet read reports `degraded:true` with an EMPTY list rather than a
//     false "everything offline" screen, and alerts still record fine.
//
//   Alert log → APPWRITE (`extension_alerts`) by default, durable, capped at MAX_LOG_PER_DEVICE
//     rows per (provider, instanceId). Heartbeats are excluded, so what remains is the evidence
//     worth keeping: catchup_unverified / row_rejected mean payments may be missing or uncredited,
//     and the extension never retries, so this is the only copy.
//
//     EXTENSION_ALERT_STORE=redis moves that log to capped per-device lists (`extlog:…`) and writes
//     NOTHING to Appwrite at all — no collection needed. Same 50-row cap, same response shape; the
//     trade is durability (a Redis wipe takes the evidence with it) and cursors become offsets.
//     Default and fallback for any unrecognised value is 'appwrite', so the safe mode is the one
//     you get by accident.
//
// Offline detection is DERIVED ON READ from lastSeenAt (EXTENSION_ALERT_OFFLINE_MS, default 3 min
// ≈ 3× the heartbeat interval) — no watchdog job.
// ponytail: no push-notification channel; the panel polls. Add a notifier only when someone must
// be woken up without the panel open.

const express = require('express');
const crypto = require('crypto');

const DEVICE_LOCK_TTL_SECONDS = 10;
const REDIS_TIMEOUT_MS = 3000;
const OFFLINE_MS = Number(process.env.EXTENSION_ALERT_OFFLINE_MS) || 180000;
// A laptop that has not reported for this long drops out of the fleet entirely (retired, not
// just offline). Refreshed on every request, so an in-use device never expires.
const DEVICE_TTL_SECONDS = Number(process.env.EXTENSION_DEVICE_TTL_SECONDS) || 604800; // 7 days
// Alert rows kept per (provider, instanceId) — 50, 100, 200, whatever the deployment wants. In
// appwrite mode older rows are deleted after each insert; in redis mode LTRIM enforces it.
// Practical ceiling comes from the redis-mode global feed, which merges every device list in
// memory: cap × fleet size objects per request (200 × 50 laptops = 10k, still trivial).
// Clamped: a negative or garbage value would make LTRIM cut from the WRONG end of the list.
const MAX_LOG_PER_DEVICE = Math.max(1, Math.floor(Number(process.env.EXTENSION_ALERT_LOG_PER_DEVICE)) || 50);
// Rolling per-device ping ring in Redis (LPUSH + LTRIM) — the "was this laptop reporting?"
// timeline behind the device detail screen. Holds every report (heartbeats and alerts alike,
// each tagged with `event`), so gaps in it are real outages. At 1 heartbeat/min the value is
// roughly the minutes of timeline you keep: 80 ≈ 80 min, 1440 ≈ a day. Clamped for the same
// LTRIM reason as the log cap above.
const HISTORY_PER_DEVICE = Math.max(1, Math.floor(Number(process.env.EXTENSION_DEVICE_HISTORY)) || 80);
// Where the alert log lives: 'appwrite' (default — durable, survives a Redis restart) or 'redis'
// (nothing is written to Appwrite at all; the log becomes a capped per-device list with the same
// 50-row cap, and is lost on a Redis wipe). Same cap either way, so the difference is durability,
// not volume. Unknown values fall back to 'appwrite' — the safe mode is the accidental one.
const ALERT_STORE = String(process.env.EXTENSION_ALERT_STORE || 'appwrite').trim().toLowerCase();
const REDIS_LOG = ALERT_STORE === 'redis';
// Every key family gets its own prefix. The fleet SCAN matches `extdev:*` and MGETs the hits, so
// a list or a different shape sharing that namespace would blow up with WRONGTYPE.
const DEVICE_KEY_PREFIX = 'extdev:';   // string  — current device state
const HISTORY_KEY_PREFIX = 'exthist:'; // list    — ping ring
const LOG_KEY_PREFIX = 'extlog:';      // list    — alert log, REDIS_LOG mode only
const SEEN_KEY_PREFIX = 'extseen:';    // string  — alertId idempotency, REDIS_LOG mode only
const MAX_DEVICES_SCANNED = 500;
const MAX_LOG_KEYS_SCANNED = 500;

// Column caps — MUST stay in sync with scripts/setup-extension-alerts-schema.js.
const CAPS = { detailJson: 16384, statsJson: 8192, message: 512, label: 128, id: 128, short: 64 };

// Types that open an incident, and how ops should route them (§2 of the spec).
const SEVERITY = {
    heartbeat: 'info', recovering: 'info', recovered: 'info', catchup_verified: 'info', test: 'info',
    row_rejected: 'high', recovered_txns: 'high', unmapped_qr: 'high', error: 'high',
    logged_out: 'critical', stale: 'critical', wrong_merchant: 'critical', catchup_unverified: 'critical',
};
const OPENS_INCIDENT = new Set(['logged_out', 'stale', 'error', 'wrong_merchant', 'catchup_unverified']);

// Constant-time compare (same construction as extensionCapture.js/uatWebhook.js — hash first
// so lengths always match).
function secretEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

const str = (v, cap) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, cap));

// Store JSON, but never a half-object: over-cap payloads become a marker the panel can render.
function jsonCapped(value, cap) {
    if (value === null || value === undefined) return null;
    let s;
    try { s = JSON.stringify(value); } catch { return JSON.stringify({ _unserializable: true }); }
    if (typeof s !== 'string') return null;
    return s.length > cap ? JSON.stringify({ _truncated: true, size: s.length }) : s;
}

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Returns { ok:true, doc } or { ok:false, error }. Never throws.
function normalize(body, provider) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
    const event = String(body.event || 'alert');
    if (event !== 'alert' && event !== 'heartbeat') return { ok: false, error: 'event must be "alert" or "heartbeat"' };
    const alertId = String(body.alertId || '').trim();
    const instanceId = String(body.instanceId || '').trim();
    const type = String(body.type || '').trim();
    if (!alertId) return { ok: false, error: 'alertId required' };
    if (!instanceId) return { ok: false, error: 'instanceId required' };
    if (!type) return { ok: false, error: 'type required' };
    const at = Number(body.at);
    // Laptop clocks drift and can be badly wrong; keep the value, just refuse unusable ones.
    if (!Number.isFinite(at) || at <= 0) return { ok: false, error: 'at must be epoch ms' };
    const deviceAt = new Date(at);
    if (Number.isNaN(deviceAt.getTime())) return { ok: false, error: 'at must be epoch ms' };

    return {
        ok: true,
        doc: {
            provider,
            alertId: alertId.slice(0, CAPS.id),
            event,
            type: type.slice(0, CAPS.short),
            severity: SEVERITY[type] || 'info',
            instanceId: instanceId.slice(0, CAPS.id),
            deviceLabel: str(body.deviceLabel, CAPS.label),
            expectedMerchantId: str(body.expectedMerchantId, CAPS.short),
            loggedInMerchantId: str(body.loggedInMerchantId, CAPS.short),
            merchantOk: typeof body.merchantOk === 'boolean' ? body.merchantOk : null,
            state: str(body.state, CAPS.short),
            message: str(body.message, CAPS.message),
            detailJson: jsonCapped(body.detail, CAPS.detailJson),
            statsJson: jsonCapped(body.stats, CAPS.statsJson),
            deviceAt: deviceAt.toISOString(),
            created_at: new Date().toISOString(),
        },
        detail: (body.detail && typeof body.detail === 'object') ? body.detail : null,
    };
}

const isConflict = (e) => e?.code === 409 || String(e?.message || '').toLowerCase().includes('already exists');

module.exports = (
    databases, ID, Query,
    APPWRITE_DATABASE_ID,
    APPWRITE_EXTENSION_ALERTS_COLLECTION_ID,
    redisClient,
    withRedisTimeout,
    acquireLock,
    releaseLock,
    authenticateAdmin,
    providers = ['phonepe', 'bharatpe']
) => {
    const router = express.Router();

    for (const p of providers) {
        if (!process.env[`${p.toUpperCase()}_EXTENSION_API_KEY`]) {
            console.warn(`⚠️  ${p.toUpperCase()}_EXTENSION_API_KEY is not set — POST /${p}-capture/alert will refuse every request (503).`);
        }
    }
    if (REDIS_LOG) {
        console.warn('⚠️  EXTENSION_ALERT_STORE=redis — the extension alert log is Redis-only. Nothing is written to Appwrite, and the log (including row_rejected / catchup_unverified evidence) is lost on a Redis wipe.');
    } else if (ALERT_STORE !== 'appwrite') {
        console.warn(`⚠️  EXTENSION_ALERT_STORE="${ALERT_STORE}" is not recognised — falling back to 'appwrite'.`);
    }

    // Matches partnerApi.js/uatWebhook.js — Appwrite reports a bad/expired cursor as a 400.
    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
    }

    function keyMiddleware(provider) {
        return function requireExtensionKey(req, res, next) {
            const expected = process.env[`${provider.toUpperCase()}_EXTENSION_API_KEY`];
            if (!expected) return res.status(503).json({ error: `${provider} alerts not configured` });
            if (!secretEquals(req.headers['x-api-key'], expected)) return res.status(401).json({ error: 'Unauthorized' });
            next();
        };
    }

    const deviceKey = (provider, instanceId) => `${DEVICE_KEY_PREFIX}${provider}:${instanceId}`;
    const historyKey = (provider, instanceId) => `${HISTORY_KEY_PREFIX}${provider}:${instanceId}`;

    // Ring of the last HISTORY_PER_DEVICE reports. Deliberately outside the device lock: LPUSH is
    // atomic, and a busy lock must not cost us a ping in the timeline. One round trip.
    async function pushHistory(doc) {
        const key = historyKey(doc.provider, doc.instanceId);
        const entry = JSON.stringify({
            at: doc.created_at, deviceAt: doc.deviceAt, event: doc.event,
            type: doc.type, state: doc.state, severity: doc.severity,
        });
        await withRedisTimeout(
            redisClient.multi()
                .lPush(key, entry)
                .lTrim(key, 0, HISTORY_PER_DEVICE - 1)
                .expire(key, DEVICE_TTL_SECONDS)
                .exec(),
            REDIS_TIMEOUT_MS
        );
    }

    // ── Device state (Redis only) ────────────────────────────────────────────
    // Read-modify-write: openIncident/openSince and the sticky label carry forward, so this is
    // serialized on a short per-device lock. Never throws — Redis being down must not fail an
    // alert, it just means the fleet view is degraded until the next heartbeat lands.
    async function updateDeviceState(doc, detail) {
        const key = deviceKey(doc.provider, doc.instanceId);
        const lockKey = `lock:extdevice:${doc.provider}:${doc.instanceId}`;
        if (!(await acquireLock(lockKey, doc.alertId, DEVICE_LOCK_TTL_SECONDS))) return; // next request refreshes it
        try {
            const prev = parseJson(await withRedisTimeout(redisClient.get(key), REDIS_TIMEOUT_MS)) || {};

            const state = {
                provider: doc.provider,
                instanceId: doc.instanceId,
                deviceLabel: doc.deviceLabel ?? prev.deviceLabel ?? null,
                expectedMerchantId: doc.expectedMerchantId ?? prev.expectedMerchantId ?? null,
                loggedInMerchantId: doc.loggedInMerchantId ?? prev.loggedInMerchantId ?? null,
                merchantOk: doc.merchantOk === null ? (prev.merchantOk ?? null) : doc.merchantOk,
                lastState: doc.state ?? prev.lastState ?? null,
                lastType: doc.type,
                lastMessage: doc.message,
                lastSeenAt: doc.created_at,          // ANY request — an alert repeat loop still means "online"
                lastAlertId: doc.alertId,
                stats: parseJson(doc.statsJson) ?? prev.stats ?? null,
                openIncident: prev.openIncident ?? null,
                openSince: prev.openSince ?? null,
                lastHeartbeatAt: doc.event === 'heartbeat' ? doc.created_at : (prev.lastHeartbeatAt ?? null),
                lastIncidentAt: prev.lastIncidentAt ?? null,
            };

            // Incident open/close rules — §4.2 of the spec.
            if (OPENS_INCIDENT.has(doc.type)) {
                if (state.openIncident !== doc.type) { state.openIncident = doc.type; state.openSince = doc.deviceAt; }
                state.lastIncidentAt = doc.created_at;
            } else if (state.openIncident === 'wrong_merchant') {
                // Only an explicit merchant recovery clears it — a `live` heartbeat must not.
                if (doc.type === 'recovered' && detail?.what === 'merchant') { state.openIncident = null; state.openSince = null; }
            } else if (doc.type === 'recovered' || doc.type === 'catchup_verified' || doc.state === 'live') {
                state.openIncident = null; state.openSince = null;
            }

            // TTL refreshed on every write: a laptop in daily use never expires, a retired one
            // falls out of the fleet on its own.
            await withRedisTimeout(redisClient.set(key, JSON.stringify(state), { EX: DEVICE_TTL_SECONDS }), REDIS_TIMEOUT_MS);
        } finally {
            await releaseLock(lockKey, doc.alertId);
        }
    }

    const logKey = (provider, instanceId) => `${LOG_KEY_PREFIX}${provider}:${instanceId}`;

    // ── Alert log write — one of two backends (EXTENSION_ALERT_STORE) ────────
    // Returns 'stored' or 'duplicate'. Throws only on a real store failure (→ 500).
    async function storeAlert(doc) {
        if (!REDIS_LOG) {
            try {
                await databases.createDocument(
                    APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_ALERTS_COLLECTION_ID, ID.unique(), doc
                );
            } catch (e) {
                // Unique index on alertId — a re-delivery is harmless success, not an error.
                if (isConflict(e)) return 'duplicate';
                throw e;
            }
            try {
                await trimLog(doc.provider, doc.instanceId);
            } catch (e) {
                // Over-cap rows are clutter, never a failure — the alert itself is already stored.
                console.error(`[${doc.provider}-alert] log trim failed`, doc.instanceId, e?.message || e);
            }
            return 'stored';
        }

        // Redis mode. SET NX on the alertId is the idempotency guard the unique index gives us in
        // Appwrite; LTRIM enforces the same per-device cap with no trim query and no deletes.
        const fresh = await withRedisTimeout(
            redisClient.set(`${SEEN_KEY_PREFIX}${doc.alertId}`, '1', { NX: true, EX: DEVICE_TTL_SECONDS }),
            REDIS_TIMEOUT_MS
        );
        if (fresh !== 'OK') return 'duplicate';

        const key = logKey(doc.provider, doc.instanceId);
        await withRedisTimeout(
            redisClient.multi()
                .lPush(key, JSON.stringify({ ...doc, id: doc.alertId }))
                .lTrim(key, 0, MAX_LOG_PER_DEVICE - 1)
                .expire(key, DEVICE_TTL_SECONDS)
                .exec(),
            REDIS_TIMEOUT_MS
        );
        return 'stored';
    }

    // ── Alert log read — same response shape from either backend ─────────────
    // Appwrite pages by document cursor; Redis pages by numeric offset (still an opaque string to
    // the client, and it passes the same cursor regex).
    async function readAlerts({ limitNum, cursor, provider, instanceId, type, severity }) {
        if (!REDIS_LOG) {
            const queries = [Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (provider) queries.push(Query.equal('provider', String(provider)));
            if (instanceId) queries.push(Query.equal('instanceId', String(instanceId)));
            if (type) queries.push(Query.equal('type', String(type)));
            if (severity) queries.push(Query.equal('severity', String(severity)));
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const result = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_ALERTS_COLLECTION_ID, queries);
            const alerts = result.documents.map((d) => pickAlert(d, d.$id));
            return { alerts, nextCursor: alerts.length === limitNum ? alerts[alerts.length - 1].id : null };
        }

        // At 50 rows × a fleet of tens, merging every device list in memory is far cheaper than
        // maintaining a second global list that could drift out of sync with the per-device caps.
        const match = `${LOG_KEY_PREFIX}${provider || '*'}:${instanceId || '*'}`;
        const keys = [];
        let scanCursor = '0'; // node-redis v5 SCAN takes/returns a STRING cursor — a number throws
        do {
            const scan = await withRedisTimeout(redisClient.scan(scanCursor, { MATCH: match, COUNT: 200 }), REDIS_TIMEOUT_MS);
            scanCursor = String(scan.cursor);
            keys.push(...scan.keys);
        } while (scanCursor !== '0' && keys.length < MAX_LOG_KEYS_SCANNED);

        const lists = await Promise.all(keys.map((k) =>
            withRedisTimeout(redisClient.lRange(k, 0, MAX_LOG_PER_DEVICE - 1), REDIS_TIMEOUT_MS)));

        let all = lists.flat().map(parseJson).filter(Boolean);
        if (type) all = all.filter((a) => a.type === String(type));
        if (severity) all = all.filter((a) => a.severity === String(severity));
        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); // newest first

        const offset = cursor ? (parseInt(cursor, 10) || 0) : 0;
        const page = all.slice(offset, offset + limitNum);
        return {
            alerts: page.map((d) => pickAlert(d, d.id || d.alertId)),
            nextCursor: offset + limitNum < all.length ? String(offset + limitNum) : null,
        };
    }

    // Redis rows carry `detail`/`stats` as objects, Appwrite rows as JSON strings — normalize.
    function pickAlert(d, id) {
        return {
            id,
            provider: d.provider,
            alertId: d.alertId,
            event: d.event,
            type: d.type,
            severity: d.severity,
            instanceId: d.instanceId,
            deviceLabel: d.deviceLabel,
            expectedMerchantId: d.expectedMerchantId,
            loggedInMerchantId: d.loggedInMerchantId,
            merchantOk: d.merchantOk,
            state: d.state,
            message: d.message,
            detail: parseJson(d.detailJson),
            stats: parseJson(d.statsJson),
            deviceAt: d.deviceAt,
            created_at: d.created_at,
        };
    }

    // Keep only the newest MAX_LOG_PER_DEVICE rows for this (provider, instanceId). Runs after
    // the insert; trimming one row per insert in the steady state. Never throws.
    // Appwrite mode only — the Redis backend gets the same cap for free from LTRIM.
    async function trimLog(provider, instanceId) {
        const stale = await databases.listDocuments(
            APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_ALERTS_COLLECTION_ID,
            [
                Query.equal('provider', provider),
                Query.equal('instanceId', instanceId),
                Query.orderDesc('created_at'),
                Query.offset(MAX_LOG_PER_DEVICE),
                Query.limit(25), // bounded: catches a backlog over a few alerts without a long loop
            ]
        );
        for (const doc of stale.documents) {
            await databases.deleteDocument(APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_ALERTS_COLLECTION_ID, doc.$id);
        }
        return stale.documents.length;
    }

    async function handleAlert(provider, req, res) {
        const n = normalize(req.body, provider);
        if (!n.ok) {
            // Log the raw body: a schema failure here is an extension bug we cannot see otherwise.
            console.warn(`[${provider}-alert] rejected: ${n.error} — body:`, JSON.stringify(req.body || null).slice(0, 1000));
            return res.status(400).json({ error: n.error });
        }

        // Heartbeats are device state only — 99% of the traffic, zero evidentiary value.
        if (n.doc.event === 'alert') {
            try {
                if (await storeAlert(n.doc) === 'duplicate') return res.status(200).json({ ok: true, duplicate: true });
            } catch (e) {
                console.error(`[${provider}-alert] store failed`, n.doc.alertId, e?.message || e);
                return res.status(500).json({ error: 'Failed to record alert' });
            }
        }

        try {
            await pushHistory(n.doc);
            await updateDeviceState(n.doc, n.detail);
        } catch (e) {
            // Redis down: the fleet view degrades, the alert channel keeps working.
            console.error(`[${provider}-alert] device state failed`, n.doc.instanceId, e?.message || e);
        }
        return res.status(200).json({ ok: true });
    }

    for (const provider of providers) {
        router.post(`/${provider}-capture/alert`, keyMiddleware(provider), (req, res) => handleAlert(provider, req, res));
    }

    // ── Admin panel reads ────────────────────────────────────────────────────
    // The fleet, straight out of Redis. SCAN + MGET: the fleet is tens of laptops, and a device
    // that stops reporting expires on its own.
    router.get('/api/admin/extension-alerts/devices', authenticateAdmin, async (req, res) => {
        const { provider, instanceId } = req.query;
        // Both segments are globbed independently — filtering by instanceId alone must not
        // collapse the provider segment out of the pattern.
        const match = `${DEVICE_KEY_PREFIX}${provider || '*'}:${instanceId || '*'}`;

        let raw = [];
        try {
            const keys = [];
            let cursor = '0'; // node-redis v5 SCAN takes/returns a STRING cursor — a number throws
            do {
                const scan = await withRedisTimeout(redisClient.scan(cursor, { MATCH: match, COUNT: 200 }), REDIS_TIMEOUT_MS);
                cursor = String(scan.cursor);
                keys.push(...scan.keys);
            } while (cursor !== '0' && keys.length < MAX_DEVICES_SCANNED);
            if (keys.length) raw = await withRedisTimeout(redisClient.mGet(keys), REDIS_TIMEOUT_MS);
        } catch (error) {
            // Never render a false "everything offline" screen — say the state store is down.
            console.error('extension devices (redis) error:', error?.message || error);
            return res.status(200).json({
                devices: [], degraded: true, offlineAfterMs: OFFLINE_MS,
                serverTime: new Date().toISOString(),
                error: 'Device state store unavailable — devices reappear within one heartbeat once it recovers.',
            });
        }

        const now = Date.now();
        const devices = raw.map(parseJson).filter(Boolean).map((d) => pickDevice(d, now));
        // Worst first: offline/critical at the top of the panel.
        const rank = { critical: 0, high: 1, info: 2 };
        devices.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.deviceLabel || a.instanceId).localeCompare(String(b.deviceLabel || b.instanceId)));

        return res.status(200).json({
            devices, degraded: false, offlineAfterMs: OFFLINE_MS, serverTime: new Date().toISOString(),
        });
    });

    // One device plus its ping ring — the detail screen. Kept off the fleet poll so the common
    // case stays a single SCAN+MGET.
    router.get('/api/admin/extension-alerts/devices/:provider/:instanceId', authenticateAdmin, async (req, res) => {
        const { provider, instanceId } = req.params;
        try {
            const [rawState, rawHistory] = await Promise.all([
                withRedisTimeout(redisClient.get(deviceKey(provider, instanceId)), REDIS_TIMEOUT_MS),
                withRedisTimeout(redisClient.lRange(historyKey(provider, instanceId), 0, HISTORY_PER_DEVICE - 1), REDIS_TIMEOUT_MS),
            ]);
            const state = parseJson(rawState);
            if (!state) return res.status(404).json({ error: 'Device not reporting (never seen, or expired)' });
            return res.status(200).json({
                device: pickDevice(state, Date.now()),
                history: (rawHistory || []).map(parseJson).filter(Boolean), // newest first
                historyKept: HISTORY_PER_DEVICE,
                serverTime: new Date().toISOString(),
            });
        } catch (error) {
            console.error('extension device detail error:', error?.message || error);
            return res.status(503).json({ error: 'Device state store unavailable' });
        }
    });

    function pickDevice(d, now) {
        const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
        const offlineForMs = Number.isNaN(seen) ? null : Math.max(0, now - seen);
        const online = offlineForMs !== null && offlineForMs < OFFLINE_MS;
        return {
            id: `${d.provider}:${d.instanceId}`,
            provider: d.provider,
            instanceId: d.instanceId,
            deviceLabel: d.deviceLabel ?? null,
            expectedMerchantId: d.expectedMerchantId ?? null,
            loggedInMerchantId: d.loggedInMerchantId ?? null,
            merchantOk: d.merchantOk ?? null,
            lastState: d.lastState ?? null,
            lastType: d.lastType ?? null,
            lastMessage: d.lastMessage ?? null,
            lastSeenAt: d.lastSeenAt ?? null,
            lastHeartbeatAt: d.lastHeartbeatAt ?? null,
            lastIncidentAt: d.lastIncidentAt ?? null,
            openIncident: d.openIncident ?? null,
            openSince: d.openSince ?? null,
            stats: d.stats ?? null,
            online,
            offlineForMs,
            // What the panel should show as the device's single status.
            status: !online ? 'offline' : (d.openIncident ? d.openIncident : 'ok'),
            severity: !online ? 'critical' : (d.openIncident ? (SEVERITY[d.openIncident] || 'high') : 'info'),
        };
    }

    // Alert log — newest first, cursor-paginated, capped per device (heartbeats are never here).
    router.get('/api/admin/extension-alerts', authenticateAdmin, async (req, res) => {
        const { limit = 25, cursor, provider, instanceId, type, severity } = req.query;
        const limitNum = Math.min(parseInt(limit, 10) || 25, 100);
        if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) return res.status(400).json({ error: 'Invalid cursor format' });

        try {
            const { alerts, nextCursor } = await readAlerts({ limitNum, cursor, provider, instanceId, type, severity });
            return res.status(200).json({ alerts, nextCursor, limit: limitNum, keptPerDevice: MAX_LOG_PER_DEVICE, store: ALERT_STORE });
        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('extension alerts error:', error);
            return res.status(500).json({ error: 'Failed to fetch alerts' });
        }
    });

    return router;
};
