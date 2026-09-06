/**
 * extensionAlerts.test.js — POST /<provider>-capture/alert + the admin panel reads.
 * Pins: per-provider static-key auth, idempotency on alertId, incident open/close rules,
 * device upsert (update not duplicate), device-failure never fails the alert, offline derivation.
 */
const express = require('express');
const request = require('supertest');
const { Query } = require('node-appwrite');

const PP_KEY = 'pp-alert-key';
const BP_KEY = 'bp-alert-key';
const ALERTS = 'alerts_col';
const DEVICES = 'devices_col';

function build({ db = {}, lockOk = true } = {}) {
    const created = [];
    const updated = [];
    const databases = {
        listDocuments: jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        createDocument: jest.fn().mockImplementation((_d, col, _id, data) => { created.push({ col, data }); return Promise.resolve({ $id: 'doc1', ...data }); }),
        updateDocument: jest.fn().mockImplementation((_d, col, id, data) => { updated.push({ col, id, data }); return Promise.resolve({ $id: id, ...data }); }),
        ...db,
    };
    const deps = {
        databases, created, updated,
        acquireLock: jest.fn().mockResolvedValue(lockOk),
        releaseLock: jest.fn().mockResolvedValue(true),
        authenticateAdmin: (_req, _res, next) => next(),
    };
    let app;
    jest.isolateModules(() => {
        const factory = require('../extensionAlerts.js');
        const router = factory(databases, { unique: () => 'newId' }, Query, 'db1', ALERTS, DEVICES,
            deps.acquireLock, deps.releaseLock, deps.authenticateAdmin);
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
const post = (app, body, { path = '/phonepe-capture/alert', key = PP_KEY } = {}) => {
    const r = request(app).post(path);
    if (key !== null) r.set('X-API-Key', key);
    return r.send(body);
};
const deviceWrite = (deps) => (deps.updated[0]?.data) || (deps.created.find((c) => c.col === DEVICES)?.data);

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
        expect(deps.created.filter((c) => c.col === ALERTS)).toHaveLength(1);
        expect(deps.created.find((c) => c.col === ALERTS).data.provider).toBe('bharatpe');
    });
});

describe('store', () => {
    test('200 {ok:true}, writes the alert row with derived severity and UTC times', async () => {
        const { app, deps } = build();
        const res = await post(app, ALERT);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        const row = deps.created.find((c) => c.col === ALERTS).data;
        expect(row).toMatchObject({
            provider: 'phonepe', alertId: ALERT.alertId, event: 'alert', type: 'stale',
            severity: 'critical', instanceId: 'pp-k3x9q2ab', merchantOk: true, state: 'stale',
        });
        expect(row.deviceAt).toBe(new Date(ALERT.at).toISOString());
        expect(JSON.parse(row.detailJson)).toEqual(ALERT.detail);
        expect(JSON.parse(row.statsJson)).toEqual(ALERT.stats);
    });

    test('duplicate alertId (unique-index 409) → 200 duplicate, no device write', async () => {
        const conflict = Object.assign(new Error('already exists'), { code: 409 });
        const { app, deps } = build({ db: { createDocument: jest.fn().mockRejectedValue(conflict) } });
        const res = await post(app, ALERT);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, duplicate: true });
        expect(deps.acquireLock).not.toHaveBeenCalled();
    });

    test('400 on missing required fields, nothing stored', async () => {
        const { app, deps } = build();
        for (const bad of [{ ...ALERT, alertId: '' }, { ...ALERT, instanceId: '' }, { ...ALERT, type: '' }, { ...ALERT, at: 'nope' }, { ...ALERT, event: 'weird' }]) {
            expect((await post(app, bad)).status).toBe(400);
        }
        expect(deps.databases.createDocument).not.toHaveBeenCalled();
    });

    test('device upsert failure still returns 200 (the alert row is already durable)', async () => {
        const { app, deps } = build({ db: { listDocuments: jest.fn().mockRejectedValue(new Error('appwrite down')) } });
        expect((await post(app, ALERT)).status).toBe(200);
        expect(deps.releaseLock).toHaveBeenCalled();
    });

    test('oversized detail is replaced by a marker, never stored half-parsed', async () => {
        const { app, deps } = build();
        await post(app, { ...ALERT, detail: { blob: 'x'.repeat(40000) } });
        expect(JSON.parse(deps.created.find((c) => c.col === ALERTS).data.detailJson)).toMatchObject({ _truncated: true });
    });
});

describe('device row', () => {
    test('created once, then updated — never a second row for the same instance', async () => {
        const { app, deps } = build();
        await post(app, ALERT);
        expect(deps.created.filter((c) => c.col === DEVICES)).toHaveLength(1);

        deps.databases.listDocuments.mockResolvedValue({ documents: [{ $id: 'dev1', ...deviceWrite(deps) }], total: 1 });
        await post(app, { ...ALERT, alertId: 'second-id' });
        expect(deps.created.filter((c) => c.col === DEVICES)).toHaveLength(1);
        expect(deps.updated[0].id).toBe('dev1');
    });

    test('opens an incident on stale, clears it on recovered', async () => {
        const { app, deps } = build();
        await post(app, ALERT);
        const opened = deviceWrite(deps);
        expect(opened.openIncident).toBe('stale');
        expect(opened.openSince).toBe(new Date(ALERT.at).toISOString());

        deps.databases.listDocuments.mockResolvedValue({ documents: [{ $id: 'dev1', ...opened }], total: 1 });
        await post(app, { ...ALERT, alertId: 'r1', type: 'recovered', state: 'live', detail: { from: 'stale' } });
        expect(deps.updated[0].data.openIncident).toBeNull();
    });

    test('wrong_merchant is NOT cleared by a live heartbeat, only by a merchant recovery', async () => {
        const { app, deps } = build();
        await post(app, { ...ALERT, type: 'wrong_merchant', state: 'live', merchantOk: false, detail: { expected: 'A', found: 'B' } });
        const opened = deviceWrite(deps);
        expect(opened.openIncident).toBe('wrong_merchant');

        deps.databases.listDocuments.mockResolvedValue({ documents: [{ $id: 'dev1', ...opened }], total: 1 });
        await post(app, { ...ALERT, alertId: 'hb1', event: 'heartbeat', type: 'heartbeat', state: 'live', detail: null });
        expect(deps.updated[0].data.openIncident).toBe('wrong_merchant');
        expect(deps.updated[0].data.lastHeartbeatAt).toBeTruthy();

        deps.databases.listDocuments.mockResolvedValue({ documents: [{ $id: 'dev1', ...deps.updated[0].data }], total: 1 });
        await post(app, { ...ALERT, alertId: 'm1', type: 'recovered', state: 'live', detail: { what: 'merchant', merchantId: 'A' } });
        expect(deps.updated[1].data.openIncident).toBeNull();
    });

    test('deviceLabel is sticky when a later alert omits it', async () => {
        const { app, deps } = build();
        deps.databases.listDocuments.mockResolvedValue({ documents: [{ $id: 'dev1', deviceLabel: 'Reception laptop', provider: 'phonepe', instanceId: 'pp-k3x9q2ab' }], total: 1 });
        await post(app, { ...ALERT, alertId: 'n1', deviceLabel: null });
        expect(deps.updated[0].data.deviceLabel).toBe('Reception laptop');
    });

    test('lock not acquired → alert still stored, device row left for the next alert', async () => {
        const { app, deps } = build({ lockOk: false });
        expect((await post(app, ALERT)).status).toBe(200);
        expect(deps.created.filter((c) => c.col === DEVICES)).toHaveLength(0);
        expect(deps.releaseLock).not.toHaveBeenCalled();
    });
});

describe('admin reads', () => {
    test('devices: offline derived from lastSeenAt, worst first', async () => {
        const now = Date.now();
        const docs = [
            { $id: 'd1', provider: 'phonepe', instanceId: 'a', deviceLabel: 'Healthy', lastSeenAt: new Date(now - 5000).toISOString(), openIncident: null, statsJson: '{"captured":1}' },
            { $id: 'd2', provider: 'phonepe', instanceId: 'b', deviceLabel: 'Asleep', lastSeenAt: new Date(now - 600000).toISOString(), openIncident: null },
        ];
        const { app } = build({ db: { listDocuments: jest.fn().mockResolvedValue({ documents: docs, total: 2 }) } });
        const res = await request(app).get('/api/admin/extension-alerts/devices');
        expect(res.status).toBe(200);
        expect(res.body.devices.map((d) => d.status)).toEqual(['offline', 'ok']);
        expect(res.body.devices[0].online).toBe(false);
        expect(res.body.devices[1].stats).toEqual({ captured: 1 });
    });

    test('alerts: cursor validated, nextCursor only on a full page', async () => {
        const rows = Array.from({ length: 2 }, (_, i) => ({ $id: `a${i}`, provider: 'phonepe', alertId: `x${i}`, type: 'stale', detailJson: '{"repeat":true}', created_at: '2026-09-06T00:00:00.000Z' }));
        const { app } = build({ db: { listDocuments: jest.fn().mockResolvedValue({ documents: rows, total: 2 }) } });
        expect((await request(app).get('/api/admin/extension-alerts?cursor=bad cursor!')).status).toBe(400);

        const full = await request(app).get('/api/admin/extension-alerts?limit=2');
        expect(full.body.nextCursor).toBe('a1');
        expect(full.body.alerts[0].detail).toEqual({ repeat: true });

        const short = await request(app).get('/api/admin/extension-alerts?limit=25');
        expect(short.body.nextCursor).toBeNull();
    });
});
