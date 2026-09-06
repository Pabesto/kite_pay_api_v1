// extensionAlerts.js — health/ops channel for the PhonePe & BharatPe browser capture extensions.
// Contract: ALERT-ENDPOINT-SPEC.md. Panel contract: EXTENSION_ALERTS_FRONTEND.md.
//
// NOT a money path. It never touches webhook_data, QR ledgers, summaries, counters, sockets or
// partner webhooks — it only writes its own two collections. Do not add crediting here.
//
// AUTH: the SAME static key as the matching capture route — `X-API-Key` compared constant-time
// against <PROVIDER>_EXTENSION_API_KEY (PHONEPE_EXTENSION_API_KEY / BHARATPE_EXTENSION_API_KEY).
// Fails closed (503) when the env var is unset.
//
//   POST /phonepe-capture/alert    alerts + heartbeats from a PhonePe laptop
//   POST /bharatpe-capture/alert   same, BharatPe key
//   GET  /api/admin/extension-alerts/devices   one row per laptop (admin) — the panel's main view
//   GET  /api/admin/extension-alerts           append-only alert log, cursor-paginated (admin)
//
// The extension NEVER retries an alert and only logs the status code, so the POST must stay a
// thin insert + upsert and answer 200 fast. Duplicate `alertId` is success (200), not an error.
//
// Offline detection ("laptop asleep / Chrome closed") is DERIVED ON READ from lastSeenAt rather
// than run as a watchdog job: a device is offline when it has not reported for
// EXTENSION_ALERT_OFFLINE_MS (default 3 min ≈ 3× the heartbeat interval).
// ponytail: no cron, no push notification channel — the panel polls. Add a watchdog + notifier
// only when someone needs to be woken up without the panel open.

const express = require('express');
const crypto = require('crypto');

const DEVICE_LOCK_TTL_SECONDS = 10;
const OFFLINE_MS = Number(process.env.EXTENSION_ALERT_OFFLINE_MS) || 180000;

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
    APPWRITE_EXTENSION_DEVICES_COLLECTION_ID,
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

    // One row per (provider, instanceId). Serialized on a per-device lock so two alerts arriving
    // together cannot create two device rows. Never throws — the alert is already stored.
    async function upsertDevice(doc, detail) {
        const lockKey = `lock:extdevice:${doc.provider}:${doc.instanceId}`;
        if (!(await acquireLock(lockKey, doc.alertId, DEVICE_LOCK_TTL_SECONDS))) return; // next alert refreshes it
        try {
            const found = await databases.listDocuments(
                APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_DEVICES_COLLECTION_ID,
                [Query.equal('provider', doc.provider), Query.equal('instanceId', doc.instanceId), Query.limit(1)]
            );
            const prev = found.documents[0] || null;

            const data = {
                provider: doc.provider,
                instanceId: doc.instanceId,
                deviceLabel: doc.deviceLabel ?? prev?.deviceLabel ?? null,
                expectedMerchantId: doc.expectedMerchantId ?? prev?.expectedMerchantId ?? null,
                loggedInMerchantId: doc.loggedInMerchantId ?? prev?.loggedInMerchantId ?? null,
                merchantOk: doc.merchantOk === null ? (prev?.merchantOk ?? null) : doc.merchantOk,
                lastState: doc.state ?? prev?.lastState ?? null,
                lastType: doc.type,
                lastMessage: doc.message,
                lastSeenAt: doc.created_at,           // ANY request — an alert repeat loop still means "online"
                lastAlertId: doc.alertId,
                statsJson: doc.statsJson ?? prev?.statsJson ?? null,
                openIncident: prev?.openIncident ?? null,
                openSince: prev?.openSince ?? null,
                lastHeartbeatAt: doc.event === 'heartbeat' ? doc.created_at : (prev?.lastHeartbeatAt ?? null),
                lastIncidentAt: prev?.lastIncidentAt ?? null,
            };

            // Incident open/close rules — §4.2 of the spec.
            if (OPENS_INCIDENT.has(doc.type)) {
                if (data.openIncident !== doc.type) { data.openIncident = doc.type; data.openSince = doc.deviceAt; }
                data.lastIncidentAt = doc.created_at;
            } else if (data.openIncident === 'wrong_merchant') {
                // Only an explicit merchant recovery clears it — a `live` heartbeat must not.
                if (doc.type === 'recovered' && detail?.what === 'merchant') { data.openIncident = null; data.openSince = null; }
            } else if (doc.type === 'recovered' || doc.type === 'catchup_verified' || doc.state === 'live') {
                data.openIncident = null; data.openSince = null;
            }

            if (prev) await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_DEVICES_COLLECTION_ID, prev.$id, data);
            else await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_DEVICES_COLLECTION_ID, ID.unique(), data);
        } finally {
            await releaseLock(lockKey, doc.alertId);
        }
    }

    async function handleAlert(provider, req, res) {
        const n = normalize(req.body, provider);
        if (!n.ok) {
            // Log the raw body: a schema failure here is an extension bug we cannot see otherwise.
            console.warn(`[${provider}-alert] rejected: ${n.error} — body:`, JSON.stringify(req.body || null).slice(0, 1000));
            return res.status(400).json({ error: n.error });
        }
        try {
            await databases.createDocument(
                APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_ALERTS_COLLECTION_ID, ID.unique(), n.doc
            );
        } catch (e) {
            // Unique index on alertId — a re-delivery is harmless success, and must not re-upsert.
            if (isConflict(e)) return res.status(200).json({ ok: true, duplicate: true });
            console.error(`[${provider}-alert] store failed`, n.doc.alertId, e?.message || e);
            return res.status(500).json({ error: 'Failed to record alert' });
        }
        try {
            await upsertDevice(n.doc, n.detail);
        } catch (e) {
            // The alert row is already durable; a device-row failure must never fail the request.
            console.error(`[${provider}-alert] device upsert failed`, n.doc.instanceId, e?.message || e);
        }
        return res.status(200).json({ ok: true });
    }

    for (const provider of providers) {
        router.post(`/${provider}-capture/alert`, keyMiddleware(provider), (req, res) => handleAlert(provider, req, res));
    }

    // ── Admin panel reads ────────────────────────────────────────────────────
    // Device fleet. Small collection (one row per laptop) — paged to a hard cap, never assumed
    // to fit in one page.
    router.get('/api/admin/extension-alerts/devices', authenticateAdmin, async (req, res) => {
        const { provider, instanceId } = req.query;
        try {
            const base = [Query.orderAsc('$id'), Query.limit(100)];
            if (provider) base.push(Query.equal('provider', String(provider)));
            if (instanceId) base.push(Query.equal('instanceId', String(instanceId)));

            const docs = [];
            let cursor = null;
            for (let page = 0; page < 5; page++) { // cap: 500 devices is far beyond the real fleet
                const queries = cursor ? [...base, Query.cursorAfter(cursor)] : base;
                const result = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_DEVICES_COLLECTION_ID, queries);
                docs.push(...result.documents);
                if (result.documents.length < 100) break;
                cursor = result.documents[result.documents.length - 1].$id;
            }

            const now = Date.now();
            const devices = docs.map((d) => {
                const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
                const offlineForMs = Number.isNaN(seen) ? null : Math.max(0, now - seen);
                const online = offlineForMs !== null && offlineForMs < OFFLINE_MS;
                return {
                    id: d.$id,
                    provider: d.provider,
                    instanceId: d.instanceId,
                    deviceLabel: d.deviceLabel,
                    expectedMerchantId: d.expectedMerchantId,
                    loggedInMerchantId: d.loggedInMerchantId,
                    merchantOk: d.merchantOk,
                    lastState: d.lastState,
                    lastType: d.lastType,
                    lastMessage: d.lastMessage,
                    lastSeenAt: d.lastSeenAt,
                    lastHeartbeatAt: d.lastHeartbeatAt,
                    lastIncidentAt: d.lastIncidentAt,
                    openIncident: d.openIncident,
                    openSince: d.openSince,
                    stats: parseJson(d.statsJson),
                    online,
                    offlineForMs,
                    // What the panel should show as the device's single status.
                    status: !online ? 'offline' : (d.openIncident ? d.openIncident : 'ok'),
                    severity: !online ? 'critical' : (d.openIncident ? (SEVERITY[d.openIncident] || 'high') : 'info'),
                };
            });
            // Worst first: offline/critical at the top of the panel.
            const rank = { critical: 0, high: 1, info: 2 };
            devices.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.deviceLabel || a.instanceId).localeCompare(String(b.deviceLabel || b.instanceId)));

            return res.status(200).json({ devices, offlineAfterMs: OFFLINE_MS, serverTime: new Date().toISOString() });
        } catch (error) {
            console.error('extension devices error:', error);
            return res.status(500).json({ error: 'Failed to fetch devices' });
        }
    });

    // Append-only alert log. Cursor-paginated per the CLAUDE.md list rules.
    router.get('/api/admin/extension-alerts', authenticateAdmin, async (req, res) => {
        const { limit = 25, cursor, provider, instanceId, type, event, severity } = req.query;
        const limitNum = Math.min(parseInt(limit, 10) || 25, 100);
        if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) return res.status(400).json({ error: 'Invalid cursor format' });

        try {
            const queries = [Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (provider) queries.push(Query.equal('provider', String(provider)));
            if (instanceId) queries.push(Query.equal('instanceId', String(instanceId)));
            if (type) queries.push(Query.equal('type', String(type)));
            if (event) queries.push(Query.equal('event', String(event)));
            if (severity) queries.push(Query.equal('severity', String(severity)));
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const result = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_EXTENSION_ALERTS_COLLECTION_ID, queries);
            const alerts = result.documents.map((d) => ({
                id: d.$id,
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
            }));
            const nextCursor = alerts.length === limitNum ? alerts[alerts.length - 1].id : null;
            return res.status(200).json({ alerts, nextCursor, limit: limitNum });
        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('extension alerts error:', error);
            return res.status(500).json({ error: 'Failed to fetch alerts' });
        }
    });

    return router;
};
