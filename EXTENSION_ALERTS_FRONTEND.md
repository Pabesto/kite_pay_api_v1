# Extension Alerts — Frontend / Flutter Panel Contract

The backend contract for the **capture-extension health panel**. Everything a Flutter (or web)
client needs to build the "are my capture laptops alive?" screen. Backend: `extensionAlerts.js`.
Wire protocol from the extensions themselves: `ALERT-ENDPOINT-SPEC.md`.

**What this feature is.** PhonePe and BharatPe give us no webhook, so a Chrome extension on a
physical laptop scrapes the merchant dashboard and POSTs transactions to `/<provider>-capture`.
If that laptop sleeps, logs out, or gets pointed at the wrong merchant account, **payments stop
being captured and nobody finds out**. The extension therefore also posts *alerts* and
*heartbeats* to `/<provider>-capture/alert`. This panel shows that stream.

**Nothing in this panel moves money.** It is read-only telemetry: no amounts to credit, no
approvals, no actions. Amounts that do appear (`stats.lastTxn.amount`) are display strings copied
from the provider dashboard, not ledger values — never total them, never treat them as balances.

**Two data sources, and the difference is visible to you.** Live device state and the ping
timeline live in **Redis** (fast, self-healing, expiring); the alert log lives in **Appwrite**
(durable, capped). Consequences you must handle:

- The fleet endpoint can answer `degraded: true` with an **empty** list when Redis is unreachable.
  That is *not* "all laptops are offline" — render a banner, never an all-red fleet (§2.1).
- Heartbeats are **never** in the alert log. The log holds real alerts only, capped at the newest
  N per laptop per extension. Older rows are deleted, so the log is a recent window, not a full
  history. **N is a server setting (default 50, often raised to 100–200): read it from
  `keptPerDevice` in the response — never hardcode a number in the UI copy.**
- The ping ring holds the last N reports (heartbeats *and* alerts) per laptop — that is your
  "was it reporting?" timeline, on the device detail endpoint (§3), with its own `historyKept`.
- A laptop that has not reported for 7 days disappears from the fleet entirely (retired, not
  offline). Show "no devices" honestly rather than inventing a row for it.
- The alert log's backend is a deploy-time switch (`store` in the response: `"appwrite"` or
  `"redis"`). The response shape is identical either way — **you do not branch on it** — but it is
  why cursors and `id`s are opaque values you must never parse or construct (§4).

---

## 1. Auth

All three endpoints are **admin-only**, standard app auth — the same Appwrite JWT the rest of the panel
uses:

```
Authorization: Bearer <appwrite JWT>
```

| Status | Meaning | What the UI should do |
|---|---|---|
| 401 | missing/invalid token | send to login |
| 403 | `{"error":"Not authorized: Admin required."}` — logged in, not an admin | hide the panel entirely for non-admins |
| 503 | `{"error":"Service temporarily unavailable. Please retry."}` | retry with backoff; do not log the user out |

Subadmins and employees have **no** access. Don't build a scoped variant without asking the
backend — device rows are not tenant-scoped.

---

## 2. `GET /api/admin/extension-alerts/devices` — the fleet (main screen)

One row per laptop, read straight from Redis. This is the screen people will actually keep open.
Small payload; **poll it every 15–30 s** while the screen is visible (there is no websocket for
this feature).

Query params (all optional): `provider` (`phonepe` | `bharatpe`), `instanceId`.

### Response

```json
{
  "devices": [ /* see below, worst-first */ ],
  "degraded": false,
  "offlineAfterMs": 180000,
  "serverTime": "2026-09-07T09:14:02.113Z"
}
```

### 2.1 `degraded: true` — handle this before anything else

```json
{ "devices": [], "degraded": true, "offlineAfterMs": 180000,
  "serverTime": "…",
  "error": "Device state store unavailable — devices reappear within one heartbeat once it recovers." }
```

Still **HTTP 200**. It means the state store is down, not that the laptops are. Show a neutral
banner ("device status unavailable, retrying"), keep the last good fleet on screen if you have
one, and keep polling — devices repopulate within a minute of recovery. Capture and alerting are
unaffected while this is showing, so do **not** escalate it as a payments incident.

### Device object

| Field | Type | Notes |
|---|---|---|
| `id` | string | `"<provider>:<instanceId>"` — stable list key, and the path pair for the detail call |
| `provider` | `"phonepe"` \| `"bharatpe"` | comes from the route the extension posted to, so it is trustworthy |
| `instanceId` | string | stable per Chrome profile, e.g. `pp-k3x9q2ab` — the real device identity |
| `deviceLabel` | string \| null | what the human typed, e.g. `"Reception laptop – Pabesto 00"`. **Show this first**; fall back to `instanceId` |
| `expectedMerchantId` | string \| null | merchant this laptop is bound to |
| `loggedInMerchantId` | string \| null | merchant actually logged in right now |
| `merchantOk` | bool \| null | `false` = wrong account. `null` = not known yet — render as unknown, never as OK |
| `lastState` | string \| null | `unknown` `live` `stale` `logged_out` `error` `recovering` `paused` |
| `lastType` | string | last alert type received (heartbeats included) |
| `lastMessage` | string \| null | human text from the extension — good subtitle |
| `lastSeenAt` | UTC ISO \| null | any request. Drives `online` |
| `lastHeartbeatAt` | UTC ISO \| null | last heartbeat only |
| `lastIncidentAt` | UTC ISO \| null | when an incident-opening alert last arrived |
| `openIncident` | string \| null | unresolved problem type, or `null` |
| `openSince` | UTC ISO \| null | **laptop clock** — see §6 on clock drift |
| `stats` | object \| null | counters snapshot, §5 |
| `online` | bool | `now - lastSeenAt < offlineAfterMs` |
| `offlineForMs` | int \| null | ms since `lastSeenAt` |
| `status` | string | **the one field to render**: `offline` \| `<openIncident>` \| `ok` |
| `severity` | `critical` \| `high` \| `info` | already computed — drive colour from this, don't re-derive |

The list is already sorted worst-first (critical → high → info, then by label). Render in the
order given.

### `status` → UI

| `status` | severity | Badge | Meaning to a non-technical operator |
|---|---|---|---|
| `ok` | info | green | Capturing normally |
| `offline` | critical | grey/red | Laptop asleep, Chrome closed, or no internet. **Nothing is being captured.** |
| `logged_out` | critical | red | Dashboard session lost — log in on that laptop |
| `stale` | critical | red | Page stopped polling (tab closed/crashed) |
| `wrong_merchant` | critical | red | A different merchant account is logged in there |
| `catchup_unverified` | critical | red | Post-outage sweep could not prove the gap was covered — **possible missing payments** |
| `error` | high | amber | Dashboard returning errors |

`offline` outranks everything: a device that stopped reporting *while* stale shows `offline`,
because the older incident can no longer be trusted to be current.

Suggested card:

```
[🔴]  Reception laptop – Pabesto 00              PhonePe
      LOGGED OUT · since 17:38 · last seen 12s ago
      merchant M22M2JAFUNSB2 · 405 saved / 412 captured
```

Empty state: no devices means **no extension has ever posted an alert** — show "no capture
devices reporting yet" plus the setup hint (Alert URL + `heartbeatMinutes = 1`), not a spinner.

---

## 3. `GET /api/admin/extension-alerts/devices/:provider/:instanceId` — one device + timeline

The detail screen. Deliberately **not** part of the fleet poll, so open it on tap and poll it at
the same 15–30 s cadence only while it is on screen.

```json
{
  "device": { /* the same device object as §2 */ },
  "history": [
    { "at":"2026-09-07T09:14:02.113Z", "deviceAt":"2026-09-07T09:14:01.980Z",
      "event":"heartbeat", "type":"heartbeat", "state":"live", "severity":"info" },
    { "at":"2026-09-07T09:13:01.044Z", "deviceAt":"2026-09-07T09:13:00.900Z",
      "event":"alert", "type":"stale", "state":"stale", "severity":"critical" }
  ],
  "historyKept": 80,
  "serverTime": "2026-09-07T09:14:05.001Z"
}
```

- `history` is **newest first**, at most `historyKept` (80) entries, and holds *every* report —
  heartbeats and alerts alike. Filter on `event` client-side if you want one or the other.
- It is the uptime strip: at one heartbeat a minute, `historyKept` entries ≈ that many minutes
  (default 80, may be configured higher). **Gaps between
  consecutive `at` values are real outages** — that is the whole point of the ring. Draw it as a
  timeline/sparkline of `severity` per entry rather than a text list.
- `404 {"error":"Device not reporting (never seen, or expired)"}` — the device has never posted, or
  went quiet for over 7 days and expired. Send the user back to the fleet; do not retry in a loop.
- `503` — Redis unreachable. Same posture as `degraded` in §2.1: transient, keep the last view.

---

## 4. `GET /api/admin/extension-alerts` — the alert log

Newest first, cursor-paginated. Use it for a per-device incident list (`?instanceId=…`) or a
global "what happened today" feed.

**Two things that are not obvious.** Heartbeats are never in here — every row is a real alert, so
you do not need to filter them out. And the log is **capped per laptop per extension** — the live
cap is `keptPerDevice` in the response (default 50, deployments may set 100/200); older rows are
deleted permanently. Treat it as a recent-incidents window, never as a complete audit history, and
render the number from `keptPerDevice` rather than writing it into a string.

Query params: `limit` (default 25, max 100), `cursor`, `provider`, `instanceId`, `type`,
`severity` (`info` | `high` | `critical`). There is no `event` filter — everything here is an alert.

```json
{
  "alerts": [
    {
      "id": "68be…", "provider": "phonepe",
      "alertId": "6f1d0000-0000-4000-8000-000000000001",
      "event": "alert", "type": "stale", "severity": "critical",
      "instanceId": "pp-k3x9q2ab", "deviceLabel": "Reception laptop – Pabesto 00",
      "expectedMerchantId": "M22M2JAFUNSB2", "loggedInMerchantId": "M22M2JAFUNSB2",
      "merchantOk": true, "state": "stale",
      "message": "No live polling from PhonePe page — tab closed / crashed / stuck?",
      "detail": { "repeat": true, "silentFor": "95s" },
      "stats": { "captured": 412, "saved": 405 },
      "deviceAt": "2026-09-06T17:20:20.606Z",
      "created_at": "2026-09-06T17:20:21.004Z"
    }
  ],
  "nextCursor": "68be…",
  "limit": 25,
  "keptPerDevice": 50,
  "store": "appwrite"
}
```

`store` names the backend the deployment is configured with (`appwrite` or `redis`). It is
informational — surface it in a debug/settings view if you like, never branch UI on it.

Pagination — the standard rule in this API:

- `nextCursor` is non-null **only when there is more to fetch**. Null = end of list, stop.
- Pass it back **verbatim** as `?cursor=<nextCursor>`. It is opaque: a document id on one backend
  and a numeric offset on the other. Never parse it, do arithmetic on it, or build one yourself.
- `id` is likewise opaque — an Appwrite document id or the `alertId`, depending on the backend.
  Use it as a list key only; when you need the extension's own identifier, read `alertId`.
- A stale cursor returns **400** `{"error":"Invalid or expired pagination cursor"}` — drop the
  cursor and reload from the top, don't show an error dialog.

Order by `created_at` (server receive time) — **not** `deviceAt`.

---

## 5. `detail` and `stats`

`detail` is free-form per alert type and may be `null`. Render it as a key/value list; never
require a field. Its shape per type is tabulated in `ALERT-ENDPOINT-SPEC.md` §2. The two worth
special-casing:

- `row_rejected` → `detail.rows[]` (max 5) — each has `paymentId`, `amount`, `status`, `qrRef`
  and the server's `result`. **Money did not get credited for these rows.** Show them as a list
  and make `paymentId` copyable so ops can search the transaction screen.
- `wrong_merchant` → `detail.expected` vs `detail.found`. Show both ids side by side.

Either object may instead be `{"_truncated": true, "size": 41233}` when the extension sent
something oversized — render "payload too large to store" rather than crashing on a missing key.

`stats` counters (cumulative since install, reset only by the user pressing "Reset counters"):

| Key | Meaning |
|---|---|
| `captured` / `saved` / `held` / `duplicate` / `skipped` | rows seen and their push outcomes |
| `rejected` | rows the server refused — **the number to surface**, red if > 0 |
| `busy` / `debugSkipped` / `filtered` / `recovered` | operational counters |
| `unmappedHeld` | rows stuck locally with no QR mapping — needs a human |
| `lastTxn` | `{ id, amount, status, vpa, qrRef }` — display only, `amount` is a string |
| `lastPushAt` / `lastPollAt` / `startedAt` / `since` | **epoch ms**, not ISO |

Never diff these counters to compute money. They are a dashboard, not a ledger.

---

## 6. Time handling (read this before formatting anything)

- Every `*At` / `created_at` / `deviceAt` string is **UTC ISO-8601**. Parse as UTC, then render in
  IST (`Asia/Kolkata`) — that is the business timezone for this product.
- Inside `stats`, times are **epoch ms integers**, not strings. Different type, same instant.
- `created_at`, `lastSeenAt`, `lastHeartbeatAt`, `lastIncidentAt` come from the **server** clock —
  trust these for "how long ago".
- `deviceAt` and `openSince` come from the **laptop** clock, which can be minutes or hours wrong.
  Show them, but compute "for how long" from server fields, and use `serverTime` from the devices
  response as `now` rather than the phone's clock.

---

## 7. Panel behaviour worth getting right

1. **Poll `/devices` every 15–30 s** while visible; stop when backgrounded. No sockets, no
   push — a laptop that dies is only detected by the *absence* of heartbeats, so freshness comes
   from polling, not from an event.
2. **`degraded: true` is not an outage of the laptops.** It is the single most misleading state
   this API can return if you render it wrong — see §2.1. Banner, not red fleet.
3. `offlineAfterMs` is returned by the API. Use it; don't hardcode 3 minutes.
4. **Never auto-refresh into a spinner.** Keep the last good list on screen and swap in new data —
   this screen is meant to be watched.
5. A device stuck repeating `stale` is still *online*: `lastSeenAt` keeps moving. Don't let the
   "last seen 4s ago" line imply health — `status` is the truth.
6. Alerts are **fire-and-forget by the extension**: it never retries. A gap in the log means the
   laptop or the network was down, which is exactly what `offline` reports.
7. No acknowledge / resolve / mute action exists server-side. Incidents clear only when the
   extension reports recovery. If the panel needs an "ack" button, that is a backend change —
   ask first, don't fake it in local state.

---

## 8. Not available (don't design around these)

| Wanted | Status |
|---|---|
| Realtime push / websocket for alerts | not implemented — poll |
| WhatsApp / Telegram / Slack notification when a laptop dies | not implemented (no ops channel in this backend) |
| Ack / snooze / resolve an incident from the panel | no endpoint |
| Rename a device from the panel | no endpoint — `deviceLabel` is set in the extension's own settings |
| Per-subadmin scoping | none — admin-only, whole fleet |
| Full alert history | no — only the newest `keptPerDevice` alerts per laptop per extension are kept |
| Heartbeat history beyond the ring | no — the ring holds the last `historyKept` reports, then drops them |
| Device state surviving a Redis restart | no — it rebuilds itself within one heartbeat |

---

## 9. Quick client checklist

- [ ] Admin-only route guard; 403 hides the feature
- [ ] `/devices` poll loop with visibility pause, last-good-data retention
- [ ] Card driven by `status` + `severity` (never re-derive severity client-side)
- [ ] `deviceLabel` first, `instanceId` as fallback and as the detail key
- [ ] Device detail = `/api/admin/extension-alerts?instanceId=…&event=alert` with cursor paging
- [ ] 400 on cursor → reset to first page silently
- [ ] All ISO timestamps parsed as UTC, rendered IST; `stats.*At` parsed as epoch ms
- [ ] `detail` / `stats` rendered defensively (may be `null`, may be `{_truncated:true}`)
- [ ] `degraded: true` renders as a banner, never as an offline fleet
- [ ] Device detail screen with the ping ring drawn as a timeline (gaps = outages), 404 handled
- [ ] Log presented as "recent alerts (last `keptPerDevice`)", from the response — not a hardcoded 50, and not framed as complete history
- [ ] `stats.rejected > 0` and `unmappedHeld > 0` surfaced — those are un-credited payments
