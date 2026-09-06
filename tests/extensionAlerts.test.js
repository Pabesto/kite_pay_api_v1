/**
 * extensionAlerts.test.js — POST /<provider>-capture/alert + the admin panel reads.
 * Pins: per-provider static-key auth, idempotency on alertId, heartbeats never reaching Appwrite,
 * the per-device log cap, the Redis ping ring, incident open/close rules, and that neither a
 * Redis outage nor a trim failure can fail an alert.
 */
const express = require('express');
const request = require('supertest');
const { Query } = require('node-appwrite');

const PP_KEY = 'pp-alert-key';
const BP_KEY = 'bp-alert-key';
const ALERTS = 'alerts_col';

// Minimal in-memory stand-in for the bits of node-redis this module uses.
function fakeRedis() {
    const store = new Map();  // key → string
    const lists = new Map();  // key → string[]
    const api = {
        store, lists,
        get: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
        set: jest.fn(async (k, v, opts) => {
            if (opts?.NX && store.has(k)) return null; // SET NX — the idempotency guard
            store.set(k, v);
            return 'OK';
        }),
        mGet: jest.fn(async (keys) => keys.map((k) => (store.has(k) ? store.get(k) : null))),
        scan: jest.fn(async (_cursor, { MATCH }) => {
            const re = new RegExp(`^${MATCH.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '.*' : `\\${m}`))}$`);
            return { cursor: '0', keys: [...store.keys(), ...lists.keys()].filter((k) => re.test(k)) };
        }),
        lRange: jest.fn(async (k, start, stop) => (lists.get(k) || []).slice(start, stop + 1)),
        multi: jest.fn(() => {
            const ops = [];
            const chain = {
                lPush: (k, v) => { ops.push(() => lists.set(k, [v, ...(lists.get(k) || [])])); return chain; },
                lTrim: (k, s, e) => { ops.push(() => lists.set(k, (lists.get(k) || []).slice(s, e + 1))); return chain; },
                expire: () => chain,
                exec: jest.fn(async () => { ops.forEach((op) => op()); return []; }),
            };
            return chain;
        }),
    };
    return api;
}

function build({ db = {}, lockOk = true, redis } = {}) {
    const created = [];
    const deleted = [];
    const databases = {
        listDocuments: jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        createDocument: jest.fn().mockImplementation((_d, col, _id, data) => { created.push({ col, data }); return Promise.resolve({ $id: 'doc1', ...data }); }),
        deleteDocument: jest.fn().mockImplementation((_d, col, id) => { deleted.push({ col, id }); return Promise.resolve(); }),
        ...db,
    };
    const redisClient = redis || fakeRedis();
    const deps = {
        databases, created, deleted, redisClient,
        withRedisTimeout: (p) => p,
        acquireLock: jest.fn().mockResolvedValue(lockOk),
        releaseLock: jest.fn().mockResolvedValue(true),
        authenticateAdmin: (_req, _res, next) => next(),
    };
    let app;
    jest.isolateModules(() => {
        const factory = require('../extensionAlerts.js');
        const router = factory(databases, { unique: () => 'newId' }, Query, 'db1', ALERTS,
            redisClient, deps.withRedisTimeout, deps.acquireLock, deps.releaseLock, deps.authenticateAdmin);
        app = express();
        app.use(express.json());
        app.use('/', router);
    });
    return { app, deps };
}

const ALERT = {
    event: 'alert', alertId: '6f1d0000-0000-4000-8000-000000000001', instanceId: 'pp-k3x9q2ab',
    deviceLabel: 'Reception laptop', expectedMerchantId: 'M22M2JAFUNSB2', loggedInMerchantId: 'M22M2JAFUNSB2',
    merchantOk: true, type: 'stale', message: 'No live polling', state: 'stale',
    detail: { repeat: true, silentFor: '95s' }, at: 1788436820606, stats: { captured: 412, saved: 405 },
};
const HEARTBEAT = { ...ALERT, event: 'heartbeat', alertId: 'hb-1', type: 'heartbeat', state: 'live', message: 'heartbeat', detail: null };

const post = (app, body, { path = '/phonepe-capture/alert', key = PP_KEY } = {}) => {
    const r = request(app).post(path);
    if (key !== null) r.set('X-API-Key', key);
    return r.send(body);
};
const alertRows = (deps) => deps.created.filter((c) => c.col === ALERTS);
const deviceState = (deps, provider = 'phonepe', instanceId = 'pp-k3x9q2ab') =>
    JSON.parse(deps.redisClient.store.get(`extdev:${provider}:${instanceId}`));

beforeEach(() => {
    process.env.PHONEPE_EXTENSION_API_KEY = PP_KEY;
    process.env.BHARATPE_EXTENSION_API_KEY = BP_KEY;
});

describe('auth', () => {
    test('503 unconfigured, 401 wrong/missing key, keys are per provider', async () => {
        delete process.env.PHONEPE_EXTENSION_API_KEY;
        const { app, deps } = build();
        expect((await post(app, ALERT)).status).toBe(503);
        process.env.PHONEPE_EXTENSION_API_KEY = PP_KEY;
        expect((await post(app, ALERT, { key: 'nope' })).status).toBe(401);
        expect((await post(app, ALERT, { key: null })).status).toBe(401);
        // The PhonePe key must not open the BharatPe route.
        expect((await post(app, ALERT, { path: '/bharatpe-capture/alert', key: PP_KEY })).status).toBe(401);
        expect((await post(app, ALERT, { path: '/bharatpe-capture/alert', key: BP_KEY })).status).toBe(200);
        expect(alertRows(deps)).toHaveLength(1);
        expect(alertRows(deps)[0].data.provider).toBe('bharatpe');
    });
});

describe('store', () => {
    test('200 {ok:true}, alert row carries derived severity and UTC times', async () => {
        const { app, deps } = build();
        const res = await post(app, ALERT);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        const row = alertRows(deps)[0].data;
        expect(row).toMatchObject({ provider: 'phonepe', alertId: ALERT.alertId, event: 'alert', type: 'stale', severity: 'critical', merchantOk: true });
        expect(row.deviceAt).toBe(new Date(ALERT.at).toISOString());
        expect(JSON.parse(row.detailJson)).toEqual(ALERT.detail);
    });

    test('heartbeats never reach Appwrite — Redis state only', async () => {
        const { app, deps } = build();
        expect((await post(app, HEARTBEAT)).status).toBe(200);
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
        expect(deviceState(deps).lastHeartbeatAt).toBeTruthy();
        expect(deps.redisClient.lists.get('exthist:phonepe:pp-k3x9q2ab')).toHaveLength(1);
    });

    test('duplicate alertId (unique-index 409) → 200 duplicate, no state change', async () => {
        const conflict = Object.assign(new Error('already exists'), { code: 409 });
        const { app, deps } = build({ db: { createDocument: jest.fn().mockRejectedValue(conflict) } });
        const res = await post(app, ALERT);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, duplicate: true });
        expect(deps.acquireLock).not.toHaveBeenCalled();
        expect(deps.redisClient.store.size).toBe(0);
    });

    test('400 on missing required fields, nothing stored', async () => {
        const { app, deps } = build();
        for (const bad of [{ ...ALERT, alertId: '' }, { ...ALERT, instanceId: '' }, { ...ALERT, type: '' }, { ...ALERT, at: 'nope' }, { ...ALERT, event: 'weird' }]) {
            expect((await post(app, bad)).status).toBe(400);
        }
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
    });

    test('Redis down → alert still recorded, request still 200', async () => {
        const redis = fakeRedis();
        redis.get.mockRejectedValue(new Error('redis down'));
        redis.multi.mockImplementation(() => { throw new Error('redis down'); });
        const { app, deps } = build({ redis });
        expect((await post(app, ALERT)).status).toBe(200);
        expect(alertRows(deps)).toHaveLength(1);
    });

    test('oversized detail is replaced by a marker, never stored half-parsed', async () => {
        const { app, deps } = build();
        await post(app, { ...ALERT, detail: { blob: 'x'.repeat(40000) } });
        expect(JSON.parse(alertRows(deps)[0].data.detailJson)).toMatchObject({ _truncated: true });
    });
});

describe('log cap (per laptop per extension)', () => {
    test('trims rows past the cap for that device, and only that device', async () => {
        const overflow = [{ $id: 'old1' }, { $id: 'old2' }];
        const { app, deps } = build({ db: { listDocuments: jest.fn().mockResolvedValue({ documents: overflow, total: 2 }) } });
        await post(app, ALERT);

        const trimQuery = deps.databases.listDocuments.mock.calls[0][2];
        expect(JSON.stringify(trimQuery)).toContain('\\"offset\\",\\"values\\":[50]');
        expect(JSON.stringify(trimQuery)).toContain('pp-k3x9q2ab');
        expect(JSON.stringify(trimQuery)).toContain('phonepe');
        expect(deps.deleted.map((d) => d.id)).toEqual(['old1', 'old2']);
    });

    test('trim failure never fails the alert', async () => {
        const { app, deps } = build({ db: { listDocuments: jest.fn().mockRejectedValue(new Error('appwrite down')) } });
        expect((await post(app, ALERT)).status).toBe(200);
        expect(alertRows(deps)).toHaveLength(1);
    });
});

describe('device state (Redis)', () => {
    test('opens an incident on stale, clears it on recovered', async () => {
        const { app, deps } = build();
        await post(app, ALERT);
        expect(deviceState(deps)).toMatchObject({ openIncident: 'stale', openSince: new Date(ALERT.at).toISOString() });

        await post(app, { ...ALERT, alertId: 'r1', type: 'recovered', state: 'live', detail: { from: 'stale' } });
        expect(deviceState(deps).openIncident).toBeNull();
    });

    test('a repeat of the same incident does not reset openSince', async () => {
        const { app, deps } = build();
        await post(app, ALERT);
        const since = deviceState(deps).openSince;
        await post(app, { ...ALERT, alertId: 'rep1', at: ALERT.at + 300000, detail: { repeat: true } });
        expect(deviceState(deps).openSince).toBe(since);
    });

    test('wrong_merchant is NOT cleared by a live heartbeat, only by a merchant recovery', async () => {
        const { app, deps } = build();
        await post(app, { ...ALERT, type: 'wrong_merchant', state: 'live', merchantOk: false, detail: { expected: 'A', found: 'B' } });
        expect(deviceState(deps).openIncident).toBe('wrong_merchant');

        await post(app, HEARTBEAT);
        expect(deviceState(deps).openIncident).toBe('wrong_merchant');

        await post(app, { ...ALERT, alertId: 'm1', type: 'recovered', state: 'live', detail: { what: 'merchant', merchantId: 'A' } });
        expect(deviceState(deps).openIncident).toBeNull();
    });

    test('deviceLabel is sticky when a later alert omits it', async () => {
        const { app, deps } = build();
        await post(app, ALERT);
        await post(app, { ...ALERT, alertId: 'n1', deviceLabel: null });
        expect(deviceState(deps).deviceLabel).toBe('Reception laptop');
    });

    test('lock not acquired → alert stored and ping still ringed, state left for the next report', async () => {
        const { app, deps } = build({ lockOk: false });
        expect((await post(app, ALERT)).status).toBe(200);
        expect(deps.redisClient.store.size).toBe(0);
        expect(deps.redisClient.lists.get('exthist:phonepe:pp-k3x9q2ab')).toHaveLength(1);
        expect(deps.releaseLock).not.toHaveBeenCalled();
    });
});

describe('ping ring', () => {
    test('keeps only the newest 80 reports, newest first', async () => {
        const { app, deps } = build();
        for (let i = 0; i < 85; i++) await post(app, { ...HEARTBEAT, alertId: `hb-${i}`, at: ALERT.at + i * 60000 });
        const ring = deps.redisClient.lists.get('exthist:phonepe:pp-k3x9q2ab');
        expect(ring).toHaveLength(80);
        expect(JSON.parse(ring[0]).deviceAt).toBe(new Date(ALERT.at + 84 * 60000).toISOString());
    });

    test('detail endpoint returns the device plus its ring; 404 when never seen', async () => {
        const { app } = build();
        await post(app, ALERT);
        await post(app, HEARTBEAT);

        const res = await request(app).get('/api/admin/extension-alerts/devices/phonepe/pp-k3x9q2ab');
        expect(res.status).toBe(200);
        expect(res.body.device).toMatchObject({ instanceId: 'pp-k3x9q2ab', status: 'ok' });
        expect(res.body.history).toHaveLength(2);
        expect(res.body.history[0].event).toBe('heartbeat');
        expect(res.body.historyKept).toBe(80);

        expect((await request(app).get('/api/admin/extension-alerts/devices/phonepe/ghost')).status).toBe(404);
    });
});

describe('EXTENSION_ALERT_STORE=redis (no Appwrite writes at all)', () => {
    const logList = (deps, provider = 'phonepe', instanceId = 'pp-k3x9q2ab') =>
        deps.redisClient.lists.get(`extlog:${provider}:${instanceId}`) || [];

    beforeEach(() => { process.env.EXTENSION_ALERT_STORE = 'redis'; });
    afterEach(() => { delete process.env.EXTENSION_ALERT_STORE; });

    test('alert goes to a Redis list; Appwrite is never touched', async () => {
        const { app, deps } = build();
        expect((await post(app, ALERT)).status).toBe(200);
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
        expect(deps.databases.listDocuments).not.toHaveBeenCalled();
        expect(logList(deps)).toHaveLength(1);
        expect(JSON.parse(logList(deps)[0])).toMatchObject({ alertId: ALERT.alertId, id: ALERT.alertId, severity: 'critical' });
    });

    test('duplicate alertId is rejected by SET NX, list stays at one entry', async () => {
        const { app, deps } = build();
        await post(app, ALERT);
        const again = await post(app, ALERT);
        expect(again.body).toEqual({ ok: true, duplicate: true });
        expect(logList(deps)).toHaveLength(1);
    });

    test('same 50-per-device cap, enforced by LTRIM', async () => {
        const { app, deps } = build();
        for (let i = 0; i < 55; i++) await post(app, { ...ALERT, alertId: `a-${i}`, at: ALERT.at + i * 1000 });
        expect(logList(deps)).toHaveLength(50);
    });

    test('EXTENSION_ALERT_LOG_PER_DEVICE raises the cap and is reported to the panel', async () => {
        process.env.EXTENSION_ALERT_LOG_PER_DEVICE = '200';
        try {
            const { app, deps } = build();
            for (let i = 0; i < 205; i++) await post(app, { ...ALERT, alertId: `b-${i}`, at: ALERT.at + i * 1000 });
            expect(logList(deps)).toHaveLength(200);
            expect((await request(app).get('/api/admin/extension-alerts?limit=5')).body.keptPerDevice).toBe(200);
        } finally {
            delete process.env.EXTENSION_ALERT_LOG_PER_DEVICE;
        }
    });

    test('a garbage or negative cap falls back instead of trimming the wrong end', async () => {
        for (const bad of ['-5', 'lots', '0']) {
            process.env.EXTENSION_ALERT_LOG_PER_DEVICE = bad;
            const { app, deps } = build();
            await post(app, ALERT);
            expect(logList(deps)).toHaveLength(1);
            expect(JSON.parse(logList(deps)[0]).alertId).toBe(ALERT.alertId);
        }
        delete process.env.EXTENSION_ALERT_LOG_PER_DEVICE;
    });

    test('heartbeats are still never logged', async () => {
        const { app, deps } = build();
        await post(app, HEARTBEAT);
        expect(logList(deps)).toHaveLength(0);
        expect(deps.redisClient.lists.get('exthist:phonepe:pp-k3x9q2ab')).toHaveLength(1);
    });

    test('read merges every device newest-first, filters, and pages by offset', async () => {
        const { app } = build();
        await post(app, { ...ALERT, alertId: 'p1', instanceId: 'pp-a', type: 'stale' });
        await post(app, { ...ALERT, alertId: 'p2', instanceId: 'pp-b', type: 'row_rejected' });
        await post(app, { ...ALERT, alertId: 'p3', instanceId: 'pp-a', type: 'logged_out' });

        const all = await request(app).get('/api/admin/extension-alerts');
        expect(all.body.store).toBe('redis');
        expect(all.body.alerts).toHaveLength(3);
        expect(all.body.alerts.map((a) => a.created_at)).toEqual([...all.body.alerts.map((a) => a.created_at)].sort().reverse());
        expect(all.body.alerts[0].detail).toEqual(ALERT.detail); // objects survive the round trip

        expect((await request(app).get('/api/admin/extension-alerts?severity=high')).body.alerts.map((a) => a.alertId)).toEqual(['p2']);
        expect((await request(app).get('/api/admin/extension-alerts?instanceId=pp-a')).body.alerts).toHaveLength(2);

        const page1 = await request(app).get('/api/admin/extension-alerts?limit=2');
        expect(page1.body.nextCursor).toBe('2');
        const page2 = await request(app).get(`/api/admin/extension-alerts?limit=2&cursor=${page1.body.nextCursor}`);
        expect(page2.body.alerts).toHaveLength(1);
        expect(page2.body.nextCursor).toBeNull();
    });

    test('unrecognised value falls back to Appwrite', async () => {
        process.env.EXTENSION_ALERT_STORE = 'postgres';
        const { app, deps } = build();
        await post(app, ALERT);
        expect(alertRows(deps)).toHaveLength(1);
    });
});

describe('admin reads', () => {
    test('devices: offline derived from lastSeenAt, worst first', async () => {
        const redis = fakeRedis();
        const now = Date.now();
        redis.store.set('extdev:phonepe:a', JSON.stringify({ provider: 'phonepe', instanceId: 'a', deviceLabel: 'Healthy', lastSeenAt: new Date(now - 5000).toISOString(), openIncident: null, stats: { captured: 1 } }));
        redis.store.set('extdev:phonepe:b', JSON.stringify({ provider: 'phonepe', instanceId: 'b', deviceLabel: 'Asleep', lastSeenAt: new Date(now - 600000).toISOString(), openIncident: null }));
        const { app } = build({ redis });

        const res = await request(app).get('/api/admin/extension-alerts/devices');
        expect(res.status).toBe(200);
        expect(res.body.degraded).toBe(false);
        expect(res.body.devices.map((d) => d.status)).toEqual(['offline', 'ok']);
        expect(res.body.devices[1].stats).toEqual({ captured: 1 });
    });

    test('devices: Redis down → 200 degraded with an empty list, never a false all-offline screen', async () => {
        const redis = fakeRedis();
        redis.scan.mockRejectedValue(new Error('redis down'));
        const { app } = build({ redis });
        const res = await request(app).get('/api/admin/extension-alerts/devices');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ degraded: true, devices: [] });
    });

    test('alerts: cursor validated, nextCursor only on a full page', async () => {
        const rows = Array.from({ length: 2 }, (_, i) => ({ $id: `a${i}`, provider: 'phonepe', alertId: `x${i}`, type: 'stale', detailJson: '{"repeat":true}', created_at: '2026-09-06T00:00:00.000Z' }));
        const { app } = build({ db: { listDocuments: jest.fn().mockResolvedValue({ documents: rows, total: 2 }) } });
        expect((await request(app).get('/api/admin/extension-alerts?cursor=bad cursor!')).status).toBe(400);

        const full = await request(app).get('/api/admin/extension-alerts?limit=2');
        expect(full.body.nextCursor).toBe('a1');
        expect(full.body.alerts[0].detail).toEqual({ repeat: true });
        expect(full.body.keptPerDevice).toBe(50);

        expect((await request(app).get('/api/admin/extension-alerts?limit=25')).body.nextCursor).toBeNull();
    });
});
