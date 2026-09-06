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

State is split on purpose: **durable evidence in Appwrite, live device state in Redis.**

| | Store | Why |
|---|---|---|
| Alert rows (`event: "alert"`) | Appwrite `extension_alerts`, capped per device — **or Redis, see 4.1.1** | Evidence. `catchup_unverified` / `row_rejected` mean payments may be missing or uncredited, and the extension never retries — this is the only copy |
| Heartbeats | Redis only | ~1440/device/day, 99% of traffic, zero value once the device row absorbs them |
| Live device state | Redis `extdev:<provider>:<instanceId>` | Pure current-state, self-healing: lose it and the next heartbeat rebuilds it in ≤1 min |
| Ping timeline | Redis list `exthist:<provider>:<instanceId>`, last N | Shows *when* a laptop was reporting; gaps are outages |

Both caps are env-tunable and apply identically to either backend:

| Var | Default | Meaning |
|---|---|---|
| `EXTENSION_ALERT_LOG_PER_DEVICE` | 50 | alert rows kept per laptop per extension — raise to 100/200/500 for a longer incident history |
| `EXTENSION_DEVICE_HISTORY` | 80 | ping-ring entries per laptop per extension; at 1 heartbeat/min ≈ that many minutes of timeline |

Both are clamped to ≥ 1 and fall back to the default on garbage — a negative would make `LTRIM`
cut from the wrong end of the list. The live values are echoed to clients as `keptPerDevice` and
`historyKept`, so raising them needs no frontend change.

Create the one collection with `node scripts/setup-extension-alerts-schema.js --write`.

### 4.1 `extension_alerts` — the durable log

Stores `provider` (from the route, never the body), `alertId`, `event`, `type`, `severity`
(derived, section 2), `instanceId`, `deviceLabel`, `expectedMerchantId`, `loggedInMerchantId`,
`merchantOk`, `state`, `message`, `detailJson`, `statsJson`, `deviceAt` (UTC ISO from `body.at`),
`created_at` (UTC ISO, when we received it).

- `idx_alertId` is **unique** → a re-delivery hits a 409, which the route answers
  `200 {"ok":true,"duplicate":true}` and applies nothing further. Idempotent by construction.
- **Capped per laptop per extension.** After each insert the route deletes rows past
  `EXTENSION_ALERT_LOG_PER_DEVICE` (default 50) for that `(provider, instanceId)`, ordered by
  `created_at` desc. One trim per insert in the steady state, bounded at 25 deletes per call, and
  a trim failure never fails the alert. `idx_device_time` backs it. Raising the cap mid-life is
  safe and takes effect immediately; *lowering* it trims the excess gradually, one alert at a time
  per device, since the trim only runs on insert.
- **Heartbeats are never written here.** Every row is a real alert.
- `detail` / `stats` are JSON strings, capped (16 KB / 8 KB). Over-cap payloads become
  `{"_truncated":true,"size":N}` — never a half-parsed object.

#### 4.1.1 `EXTENSION_ALERT_STORE` — moving the log off Appwrite entirely

`EXTENSION_ALERT_STORE=redis` makes the alert log Redis-native: **nothing is written to Appwrite at
all**, and the collection (and the schema script) become unnecessary. `appwrite` is the default,
and any unrecognised value falls back to it, so the durable mode is the one you get by accident.

| | `appwrite` (default) | `redis` |
|---|---|---|
| Storage | `extension_alerts` collection | `extlog:<provider>:<instanceId>` list |
| Per-device cap | `EXTENSION_ALERT_LOG_PER_DEVICE`, by a trim query + deletes after each insert | same value, by `LTRIM` — free, no query, no deletes |
| Idempotency | unique index on `alertId` → 409 | `SET extseen:<alertId> NX EX 7d` |
| Pagination | Appwrite document cursor | numeric offset (still an opaque cursor string to clients) |
| Survives a Redis wipe | **yes** | no — the whole log goes |
| Appwrite writes per alert | 1 create + 1 list + 0–1 deletes | **zero** |
| TTL | none (cap only) | 7 days idle, refreshed per alert |

Both modes return the identical response shape from `GET /api/admin/extension-alerts`, plus a
`store` field naming the active backend. The one visible difference: in `redis` mode a row's `id`
is its `alertId` (there is no Appwrite document id).

What you give up in `redis` mode is narrower than it first looks — the log is a rolling
`EXTENSION_ALERT_LOG_PER_DEVICE` rows per device in both modes, so it was never a full audit
history. What you actually lose is that
`row_rejected` and `catchup_unverified` rows stop surviving a Redis restart. If Redis on this
deployment is not persistent, treat those two alert types as ephemeral and act on them the day
they arrive.

### 4.2 Redis device state — `extdev:<provider>:<instanceId>`

One JSON value per laptop, rewritten on every request under `lock:extdevice:<provider>:<instanceId>`
(10 s) because the incident fields carry forward. TTL `EXTENSION_DEVICE_TTL_SECONDS` (default
7 days) refreshed on every write, so a laptop in daily use never expires and a retired one drops
out of the fleet by itself.

Fields: `deviceLabel` / `expectedMerchantId` / `merchantOk` (sticky — kept when a later report
omits them), `lastState`, `lastType`, `lastMessage`, `lastSeenAt` (**any** request),
`lastHeartbeatAt`, `lastIncidentAt`, `lastAlertId`, `openIncident`, `openSince`, `stats`.

Incident rules, exactly as implemented:

- `logged_out` / `stale` / `error` / `wrong_merchant` / `catchup_unverified` → `openIncident = type`
  and `openSince = deviceAt` (only when the type actually changes, so a repeat does not reset it).
- `recovered`, `catchup_verified`, or any request with `state: "live"` → clear the incident.
- **Exception:** an open `wrong_merchant` clears *only* on `recovered` with
  `detail.what === "merchant"` — a `live` heartbeat from the wrong account must not clear it.

If the lock is busy the state write is skipped entirely — the next report (≤1 min) refreshes it.

### 4.3 Redis ping ring — `exthist:<provider>:<instanceId>`

`LPUSH` + `LTRIM 0 79` + `EXPIRE`, one round trip, **outside** the device lock so a busy lock never
costs a ping. Holds the last `EXTENSION_DEVICE_HISTORY` (default 80) reports — heartbeats *and*
alerts, each tagged with `event` — newest first:

```json
{ "at":"2026-09-07T09:14:02.113Z", "deviceAt":"2026-09-07T09:14:01.980Z",
  "event":"heartbeat", "type":"heartbeat", "state":"live", "severity":"info" }
```

At one heartbeat a minute the entry count is roughly the minutes of timeline you keep (80 ≈ 80 min,
1440 ≈ a day). Read it from the device detail endpoint, which echoes the live value as
`historyKept`.

### 4.4 Offline detection — derived on read, not a watchdog job

A device is `offline` when `now - lastSeenAt >= EXTENSION_ALERT_OFFLINE_MS` (default 180000 ms,
about 3x a 1-minute heartbeat). `lastSeenAt` counts any request, so a device stuck in a `stale`
repeat loop is still *online*, just unhealthy.

**Set `heartbeatMinutes = 1` in every extension** — the default 3-minute threshold assumes it.

### 4.5 When Redis is down

The alert channel keeps working: rows still land in Appwrite and the POST still answers 200. Only
the fleet view degrades — `GET /devices` returns `200 {"devices":[],"degraded":true,...}` rather
than a false "everything offline" screen, and every device reappears within one heartbeat of Redis
coming back. This is the deliberate trade for keeping heartbeats out of the database.

### 4.6 Deliberately NOT implemented

- **No push notifications** (WhatsApp / Telegram / Slack) and no de-dup throttle for them: this
  repo has no ops notification channel. The panel polls `/devices` and shows the fleet.
  Add a notifier only when someone must be woken without the panel open.
- **No money cross-checks.** `catchup_unverified` and `row_rejected` are recorded and surfaced;
  reconciling them against settlement reports is a human job today.
- **No rejection of rows from the wrong merchant.** With `wrongMerchantMode = "continue"` the
  extension keeps pushing the other merchant's transactions and the capture route still accepts
  them. Guarding that is a change to the capture route, not to alerts — ask first.
- **No retention job needed.** The Appwrite cap and the Redis TTLs bound everything already.

### 4.7 Reading it back

All admin-only (`authenticateAdmin`), all projected through explicit pick functions:

- `GET /api/admin/extension-alerts/devices` — the fleet from Redis, worst-first, with derived
  `online` / `status` / `severity` and a `degraded` flag.
- `GET /api/admin/extension-alerts/devices/:provider/:instanceId` — one device plus its ping ring.
- `GET /api/admin/extension-alerts` — the durable log, cursor-paginated, filterable by `provider`,
  `instanceId`, `type`, `severity`.

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
- [x] Alerts → Appwrite (unique `alertId` → 200 duplicate), capped per laptop per extension (`EXTENSION_ALERT_LOG_PER_DEVICE`, default 50)
- [x] Heartbeats → Redis device state + ping ring only; never written to Appwrite
- [x] `200 {"ok":true}` even when Redis is down or the trim fails — the alert row is what matters
- [x] Incident open/close rules (4.2), including the `wrong_merchant` exception
- [x] Ping ring of the last `EXTENSION_DEVICE_HISTORY` (default 80) reports per device (4.3)
- [x] Offline derived on read (4.4) — no cron; `degraded` instead of a false all-offline screen (4.5)
- [x] Admin reads for the panel (4.7) + `EXTENSION_ALERTS_FRONTEND.md`
- [x] Tests: `tests/extensionAlerts.test.js`
- [ ] Ops push notifications with throttling (4.6) — not built
- [ ] Extension side: Alert URL + `heartbeatMinutes = 1` + a distinct `deviceLabel` per profile

### Deploy order

1. `node scripts/setup-extension-alerts-schema.js` (dry run), then `--write`.
   Skip this entirely if you are running `EXTENSION_ALERT_STORE=redis` — no collection is used.
2. Set `APPWRITE_EXTENSION_ALERTS_COLLECTION_ID` in `.env` and on Render. Optional tuning:
   `EXTENSION_ALERT_STORE` (`appwrite`),
   `EXTENSION_ALERT_LOG_PER_DEVICE` (50), `EXTENSION_DEVICE_HISTORY` (80),
   `EXTENSION_ALERT_OFFLINE_MS` (180000), `EXTENSION_DEVICE_TTL_SECONDS` (604800).
3. Deploy, then smoke-test with the curl in section 5.
4. Point each extension at its Alert URL with the same key it already uses for pushes.

Upgrading from the first cut of this feature: an `extension_devices` collection may exist from the
earlier schema script. Nothing reads or writes it any more — drop it whenever convenient.
