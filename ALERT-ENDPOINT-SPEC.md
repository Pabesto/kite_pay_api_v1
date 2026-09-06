# Alert Endpoint Spec — `POST /phonepe-capture/alert` and `POST /bharatpe-capture/alert`

**Status: IMPLEMENTED** in `extensionAlerts.js` (mounted in server.js for both providers).
Panel/frontend contract: `EXTENSION_ALERTS_FRONTEND.md`. Schema: `scripts/setup-extension-alerts-schema.js`.

**Audience:** whoever maintains the Alert URL that the PhonePe / BharatPe capture extensions POST
to. Sections 1-2 are written from the extension source (v5.17), so the payloads are exact;
section 4 describes what this backend actually does with them.

**Purpose.** The extension already pushes transactions to `/phonepe-capture` and
`/bharatpe-capture`. The Alert URL is the *operational* channel: it tells the platform when a
laptop's capture is unhealthy (logged out, stale, wrong account, rejected rows, recovery results)
and, via heartbeats, whether the laptop is alive at all. The platform's job is to **record,
de-duplicate, and track per-device state** — it never has to reply with anything meaningful.

**Not a money path.** These routes are given no `finalizeTransaction`, no QR lock, and no
money-path collection id. They write only `extension_alerts` and `extension_devices`. An alert
never credits, corrects, or reconciles a transaction — it only tells a human to go look.

---

## 1. Request

```
POST <alertUrl>          e.g. https://<host>/phonepe-capture/alert
Content-Type: application/json
X-API-Key: <key>         header name configurable per extension (default X-API-Key)
```

- **The key is the same one as the capture route** — `PHONEPE_EXTENSION_API_KEY` on
  `/phonepe-capture/alert`, `BHARATPE_EXTENSION_API_KEY` on `/bharatpe-capture/alert`. There is
  no separate alert key. In the extension, either leave "Alert API key" empty (it then sends the
  push key) or paste the same value. Wrong key → 401; env var unset → 503 (fails closed).
  Constant-time compare, and the PhonePe key does **not** open the BharatPe route.
- Fire-and-forget: the extension logs the HTTP status and **never retries** an alert. So the
  handler must be fast and must not depend on downstream work (notify asynchronously).
- Expect bursts: `alertRepeatSeconds` (user-set, min 30, default 300) re-sends the *same*
  active alert while a bad condition persists; heartbeats every `heartbeatMinutes`.

### 1.1 Body — every request, alerts and heartbeats alike

| Field | Type | Meaning |
|---|---|---|
| `event` | `"alert"` \| `"heartbeat"` | Heartbeats have `type: "heartbeat"` too |
| `alertId` | uuid v4 | Unique per request — use as idempotency key |
| `instanceId` | string, e.g. `pp-k3x9q2ab` | Stable id of this extension install (per Chrome profile). **Primary device key.** |
| `deviceLabel` | string \| null | Human name the user typed, e.g. `"Reception laptop – Pabesto 00"` |
| `expectedMerchantId` | string \| null | Merchant this profile is bound to, e.g. `M22M2JAFUNSB2` |
| `loggedInMerchantId` | string \| null | Merchant currently detected on the dashboard |
| `merchantOk` | boolean \| null | `false` = wrong account logged in on this laptop; `null` = not yet known |
| `type` | string | One of the types in §2 |
| `message` | string | Human-readable default text for `type` |
| `state` | string | Extension health at send time: `unknown` `live` `stale` `logged_out` `error` `recovering` `paused` |
| `detail` | object \| null | Type-specific, see §2 |
| `at` | number | Epoch **ms** on the laptop clock |
| `stats` | object | Counters since install/reset — see §1.2 |

### 1.2 `stats`

```json
{
  "captured": 412, "saved": 405, "held": 0, "duplicate": 4, "skipped": 3, "rejected": 0,
  "busy": 1, "debugSkipped": 0, "filtered": 29, "recovered": 5,
  "lastTxn": { "id": "T2609…", "amount": "1.00", "status": "SUCCESS", "vpa": "…", "qrRef": "Q699089992", "ppKey": "Q699089992" },
  "lastPushAt": 1788436820606, "startedAt": 1788380000000,
  "unmappedHeld": 0,          // rows held locally with no qrRef
  "lastPollAt": 1788436818000,// last successful live poll (ms)
  "since": 1788436700000      // when the current state began (ms)
}
```
All counters are cumulative and reset only if the user presses "Reset counters". Don't
diff them for money; they are for dashboards and sanity checks.

---

## 2. Alert types and their `detail`

Severity is a recommendation for ops routing.

| `type` | Severity | Meaning | `detail` |
|---|---|---|---|
| `heartbeat` | info | Laptop + extension alive. `event: "heartbeat"` | `null` |
| `logged_out` | **critical** | Dashboard session lost (sustained 401s or login page). Live capture stopped. | `{ kind: "auth", status: 401, consecutive: n }` or `{ reason: "login page", path: "/login" }` |
| `stale` | **critical** | Live page not polling (tab closed / crashed / stuck) and self-heal failed | `{ lastPollAt, silentFor: "95s", hidden: bool, keepAlive: "running"\|"needs-gesture"\|…, healAttempts: n }` |
| `error` | high | Live poll returning 5xx / network errors | `{ kind: "http"\|"network", status, extra }` |
| `recovering` | info | User logged back in; extension is returning to live + starting catch-up | `{ path }` |
| `recovered` | info | Feed is back to `live` (or merchant is correct again) | `{ from: "stale" }` or `{ what: "merchant", merchantId }` |
| `catchup_verified` | info | Post-outage history sweep completed and **proved** the gap is covered | `{ reason, recovered: n, scanned: n }` |
| `catchup_unverified` | **critical** | Sweep could not prove the gap is covered — **possible missing payments** | `{ reason, error, scanned, pages }` |
| `recovered_txns` | high | A sweep found txns the live feed had missed; they were just pushed | `{ reason, scanned, recovered }` |
| `wrong_merchant` | **critical** | A different PhonePe account is logged in on this laptop | `{ expected, found, source: "txn"\|"dom:…", deviceLabel }` |
| `row_rejected` | high | Server answered `invalid`/`error` for a SUCCESS row — money not credited | `{ count, rows: [{ paymentId, amount, status, qrRef, result:{…server row…}, at }] }` (max 5 rows) |
| `unmapped_qr` | high | Row held locally: PhonePe sent no QR/terminal/store id | `{ keys: [ppKey…], held: n }` |
| `test` | info | User pressed "Test alert" | `{ manual: true }` |

Repeat semantics: while `logged_out` / `stale` / `error` persists, the **same type** is
re-sent every `alertRepeatSeconds` with `detail.repeat: true` and `detail.since`. Treat
those as *still open*, not new incidents.

---

## 3. Response

Return **`200 {"ok":true}`** as soon as the row is stored. Anything else is only logged on
the laptop (`alert API (stale) -> HTTP 500`); nothing is retried, so a failing endpoint
silently loses alerts. Keep it a thin insert + enqueue.

```json
200 { "ok": true }
401 { "error": "Unauthorized" }        // bad / missing key
400 { "error": "…" }                    // schema failure — log the body, still return fast
```

---

## 4. What this backend does with them

Appwrite, not SQL — two collections created by `node scripts/setup-extension-alerts-schema.js --write`.

### 4.1 `extension_alerts` — append-only log

Every request (alert *and* heartbeat) is stored: `provider` (from the route, never the body),
`alertId`, `event`, `type`, `severity` (derived, section 2), `instanceId`, `deviceLabel`,
`expectedMerchantId`, `loggedInMerchantId`, `merchantOk`, `state`, `message`, `detailJson`,
`statsJson`, `deviceAt` (UTC ISO from `body.at`), `created_at` (UTC ISO, when we received it).

- `idx_alertId` is **unique** → a re-delivery hits a 409, which the route answers
  `200 {"ok":true,"duplicate":true}` and skips the device upsert. Idempotent by construction.
- `detail` / `stats` are stored as JSON strings, capped (16 KB / 8 KB). Over-cap payloads are
  replaced by `{"_truncated":true,"size":N}` — never a half-parsed object.
- Timestamps are UTC ISO strings, per the repo-wide rule. `deviceAt` is the laptop clock and can
  drift; `created_at` is authoritative for ordering.

### 4.2 `extension_devices` — one row per (provider, instanceId)

Upserted on every request under `lock:extdevice:<provider>:<instanceId>` (10 s) so two alerts
arriving together cannot create two rows for one laptop. If the lock is busy the row is simply
left for the next alert — the log row is already durable, and alerts repeat.

Fields: `deviceLabel` / `expectedMerchantId` / `merchantOk` (sticky — kept when a later alert
omits them), `lastState`, `lastType`, `lastMessage`, `lastSeenAt` (**any** request),
`lastHeartbeatAt`, `lastIncidentAt`, `lastAlertId`, `openIncident`, `openSince`, `statsJson`.

Incident rules, exactly as implemented:

- `logged_out` / `stale` / `error` / `wrong_merchant` / `catchup_unverified` → `openIncident = type`
  and `openSince = deviceAt` (only when the type actually changes, so a repeat does not reset it).
- `recovered`, `catchup_verified`, or any request with `state: "live"` → clear the incident.
- **Exception:** an open `wrong_merchant` clears *only* on `recovered` with
  `detail.what === "merchant"` — a `live` heartbeat from the wrong account must not clear it.

### 4.3 Offline detection — derived on read, not a watchdog job

If the laptop sleeps or Chrome closes, no alert ever arrives. Rather than a cron job, the devices
endpoint computes it: a device is `offline` when `now - lastSeenAt >= EXTENSION_ALERT_OFFLINE_MS`
(default 180000 ms, about 3x a 1-minute heartbeat). `lastSeenAt` counts any request, so a device
stuck in a `stale` repeat loop is still *online*, just unhealthy.

**Set `heartbeatMinutes = 1` in every extension** — the default 3-minute threshold assumes it.

### 4.4 Deliberately NOT implemented

- **No push notifications** (WhatsApp / Telegram / Slack) and no de-dup throttle for them: this
  repo has no ops notification channel. The panel polls `/devices` and shows the fleet.
  Add a notifier only when someone must be woken without the panel open.
- **No retention job.** `extension_alerts` grows forever (one heartbeat row per device per minute
  is about 43k rows/device/month). Add a sweeper before the fleet grows.
- **No money cross-checks.** `catchup_unverified` and `row_rejected` are recorded and surfaced;
  reconciling them against settlement reports is a human job today.
- **No rejection of rows from the wrong merchant.** With `wrongMerchantMode = "continue"` the
  extension keeps pushing the other merchant's transactions and the capture route still accepts
  them. Guarding that is a change to the capture route, not to alerts — ask first.

### 4.5 Reading it back

Both admin-only (`authenticateAdmin`), both projected through explicit pick functions:

- `GET /api/admin/extension-alerts/devices` — the fleet, worst-first, with derived `online` /
  `status` / `severity`.
- `GET /api/admin/extension-alerts` — the log, cursor-paginated, filterable by `provider`,
  `instanceId`, `type`, `event`, `severity`.

Full request/response shapes for panel builders: **`EXTENSION_ALERTS_FRONTEND.md`**.

---

## 5. Examples

Stale alert (repeat):
```json
{ "event":"alert", "alertId":"6f1d…", "instanceId":"pp-k3x9q2ab",
  "deviceLabel":"Reception laptop – Pabesto 00", "expectedMerchantId":"M22M2JAFUNSB2",
  "loggedInMerchantId":"M22M2JAFUNSB2", "merchantOk":true,
  "type":"stale", "message":"No live polling from PhonePe page — tab closed / crashed / stuck?",
  "state":"stale",
  "detail":{ "repeat":true, "since":1788436700000, "lastError":{ "lastPollAt":1788436610000, "silentFor":"95s", "hidden":true, "keepAlive":"needs-gesture", "healAttempts":2 } },
  "at":1788436820606,
  "stats":{ "captured":412, "saved":405, "rejected":0, "unmappedHeld":0, "lastPollAt":1788436610000, "since":1788436700000 } }
```

Heartbeat:
```json
{ "event":"heartbeat", "alertId":"9b2c…", "instanceId":"pp-k3x9q2ab",
  "deviceLabel":"Reception laptop – Pabesto 00", "expectedMerchantId":"M22M2JAFUNSB2",
  "loggedInMerchantId":"M22M2JAFUNSB2", "merchantOk":true,
  "type":"heartbeat", "message":"heartbeat", "state":"live", "detail":null,
  "at":1788436880000, "stats":{ … } }
```

Curl smoke test:
```bash
curl -s -X POST https://<host>/phonepe-capture/alert \
  -H 'Content-Type: application/json' -H 'X-API-Key: <key>' \
  -d '{"event":"alert","alertId":"00000000-0000-4000-8000-000000000001","instanceId":"pp-test","deviceLabel":"curl","type":"test","message":"Test alert","state":"live","detail":{"manual":true},"at":1788436880000,"stats":{}}'
# expect: {"ok":true}   — the SAME alertId again returns {"ok":true,"duplicate":true}
# BharatPe: same body against /bharatpe-capture/alert with BHARATPE_EXTENSION_API_KEY
# fleet:    curl -s https://<host>/api/admin/extension-alerts/devices -H "Authorization: Bearer <admin JWT>"
```

---

## 6. Checklist — state of play

- [x] Route per provider: `/phonepe-capture/alert`, `/bharatpe-capture/alert`; same key as the push route
- [x] `X-API-Key` → 401 / 503; minimal schema (`event`, `alertId`, `instanceId`, `type`, `at`) → 400 with the raw body logged
- [x] Insert into `extension_alerts` (unique `alertId` → 200 duplicate); upsert `extension_devices` under a per-device lock
- [x] `200 {"ok":true}` even when the device upsert fails — the log row is already durable
- [x] Incident open/close rules (4.2), including the `wrong_merchant` exception
- [x] Offline devices derived on read (4.3) — no cron
- [x] Admin reads for the panel (4.5) + `EXTENSION_ALERTS_FRONTEND.md`
- [x] Tests: `tests/extensionAlerts.test.js`
- [ ] Ops push notifications with throttling (4.4) — not built
- [ ] Retention sweeper for `extension_alerts` (4.4) — not built
- [ ] Extension side: Alert URL + `heartbeatMinutes = 1` + a distinct `deviceLabel` per profile

### Deploy order

1. `node scripts/setup-extension-alerts-schema.js` (dry run), then `--write`.
2. Set `APPWRITE_EXTENSION_ALERTS_COLLECTION_ID` / `APPWRITE_EXTENSION_DEVICES_COLLECTION_ID`
   (and optionally `EXTENSION_ALERT_OFFLINE_MS`) in `.env` and on Render. Defaults match the script.
3. Deploy, then smoke-test with the curl in section 5.
4. Point each extension at its Alert URL with the same key it already uses for pushes.
