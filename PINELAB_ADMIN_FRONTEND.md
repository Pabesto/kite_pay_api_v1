# PineLabs Accounts — Frontend Integration Guide

> Audience: the Flutter (client) developer/AI agent building the admin "PineLabs" settings page.
> Backend is complete. This document is the full contract: mental model, REST API, screen design,
> and edge cases. Everything here is implemented.

---

## 1. What this feature is (mental model)

PineLabs payments are **not** delivered by webhook. A background **poller** inside the API wakes up
on a timer, asks each configured PineLabs merchant account for its recent successful transactions,
and credits them. **Polling is the only way a PineLabs payment ever reaches the system** — if the
poller is not running, those payments are simply not credited until it starts again.

Until now the merchant credentials were hardcoded in the server and changing them meant a code
deploy. They now live in a `pinelab_accounts` collection, and this page is how an admin manages them.

There are two separate concepts, and the UI must keep them visually distinct:

- **The account list** — stored config. Editing it changes the database *only*.
- **The running poller** — a live process holding a snapshot of that list from when it last started.

**Saving an account does not change what is being polled.** The poller keeps using its old snapshot
until someone calls **reload**. This is deliberate — restarting a money-collecting process is an
explicit act, not a side effect of a text field losing focus. The UI's main job is to make that gap
obvious and easy to close.

The UI has **three jobs**:
1. **Show** whether the poller is running right now, and on which accounts.
2. **Edit** the account list (add, enable/disable, rotate credentials).
3. **Apply** changes by reloading the poller, and confirm it came back up.

---

## 2. Conventions (read first)

- **Do NOT use the Appwrite SDK for this collection.** `pinelab_accounts` has **no permissions and
  row security off** — it holds live payment-gateway credentials, so only the server's API key can
  read it. A client-side `databases.listDocuments` will fail no matter which user is signed in.
  Every read and write goes through the REST endpoints below. This is the single most common
  mistake to avoid.
- **Auth: every endpoint here is admin-only — role `admin`, nothing else.** There is no subadmin,
  employee, or label-based access to any of them, and no read-only variant. Gate the whole page on
  `role == 'admin'` and do not render an entry point for anyone else; a non-admin who reaches it can
  only collect 403s.

  Send the same Appwrite JWT you already use for other admin calls:
  `Authorization: Bearer <jwt>`.

  | Status | Meaning | What the UI should do |
  |---|---|---|
  | `401` | `Authentication token is required.` / `Invalid or expired token.` | Refresh the JWT and retry once, then send to login |
  | `403` | `Not authorized: Admin required.` | Not an admin — leave the page |
  | `404` | `User metadata not found` | Account exists in Appwrite but has no `users_meta` row; surface as a config problem, not a login failure |
  | `503` | `Service temporarily unavailable. Please retry.` | **Transient** — retry with backoff |
  | `504` | `Authentication service timed out. Please retry.` | **Transient** — retry with backoff |

  Treat `503`/`504` as retryable rather than logging the user out: they come from the auth
  dependency being slow, not from a bad token.
- **Base path is `/admin/pinelabs`, NOT `/api/admin/...`.** These endpoints sit at the server root.
  Getting this wrong yields a 404 that looks like a deploy problem.
- **`clientSecret` is write-only.** No endpoint ever returns it, for anyone. Reads return
  `clientSecretSet: true/false` instead. Your UI can never display or pre-fill a secret — design for
  that from the start.
- **Times are ISO-8601 UTC strings.** Parse with `DateTime.parse(...).toLocal()`.

---

## 3. REST API

### 3.1 `GET /admin/pinelabs/running` — is the poller alive?

The health widget. Cheap; safe to poll every 10–15s while the page is open.

```json
{
  "running": true,
  "enabledByFlag": true,
  "accountIds": ["scanserve_ai", "beast_arena_club"],
  "loadedAt": "2026-08-10T09:12:44.101Z",
  "loadError": null
}
```

| Field | Meaning |
|---|---|
| `running` | A poller process is currently active. **This is the headline status.** |
| `enabledByFlag` | Server-level kill switch. If `false`, the poller will never start regardless of accounts — show "Disabled on server" and disable the reload button. |
| `accountIds` | The accounts the **running** poller is actually using — its snapshot, not the stored list. Diffing this against the stored list is how you detect unapplied changes. |
| `loadedAt` | When that snapshot was taken. |
| `loadError` | Non-null if the last start attempt failed (e.g. the database was unreachable). Show it verbatim — it is the operator's only clue. |

`running: false` with `loadError: null` and an empty `accountIds` normally means **no accounts are
enabled**. That is a valid state, not an error — say so plainly rather than showing a red alarm.

### 3.2 `GET /admin/pinelabs/accounts` — the stored list

```json
{
  "success": true,
  "accounts": [
    {
      "$id": "6a7f…",
      "accountId": "scanserve_ai",
      "clientId": "SCANSERVE_AI_PRIVATE_LIMIT_…",
      "label": "ScanServe AI",
      "enabled": true,
      "clientSecretSet": true
    }
  ]
}
```

`accountId` is the stable business key used in every other call and in the poller's internal metric
keys. **It cannot be changed after creation** — there is no rename endpoint, because the id is baked
into stored watermarks. Present it as read-only once saved; `label` is the field users rename.

### 3.3 `POST /admin/pinelabs/accounts` — add

```json
{ "accountId": "pabesto_tech", "clientId": "…", "clientSecret": "…",
  "label": "Pabesto Tech", "enabled": true }
```

`accountId`, `clientId`, `clientSecret` are required. `label` and `enabled` are optional
(`enabled` defaults to `true`).

**`accountId` must match `^[a-zA-Z0-9_-]{1,64}$`.** Validate this client-side before sending so the
user gets an inline field error rather than a snackbar. It becomes part of an internal key, which is
why punctuation is refused.

`201` returns the created account (redacted) plus a `note` reminding you to reload.

| Status | Meaning | UI |
|---|---|---|
| `400` | Missing field, or bad `accountId` charset | Inline field error |
| `409` | `Account "<id>" already exists` | Inline error on the id field |

### 3.4 `PATCH /admin/pinelabs/accounts/:accountId` — edit

Send **only the keys you are changing**. Accepted: `clientId`, `clientSecret`, `label`, `enabled`.
Anything else is ignored. Sending an empty body returns `400`.

This is the endpoint behind three different UI actions:

```jsonc
{ "enabled": false }                 // toggle off — stops polling this account on next reload
{ "label": "ScanServe AI (prod)" }   // rename
{ "clientSecret": "…" }              // rotate the secret, leave everything else alone
```

**Omitting `clientSecret` leaves the stored one untouched.** This is what makes an edit form
workable: show the secret field empty with a hint like *"Leave blank to keep the current secret"*,
and only include the key in your request body when the user actually typed something. Never send an
empty string — that would overwrite a live credential with nothing and silently break collection for
that merchant.

`404` if no account has that `accountId`.

### 3.5 `POST /admin/pinelabs/reload` — apply changes

Empty body. Stops the running poller and starts a fresh one from the current stored list.

```json
{ "success": true, "started": true, "accountIds": ["scanserve_ai", "beast_arena_club"] }
```

When it does not start, `started` is `false` and `reason` explains why:

```json
{ "success": true, "started": false, "accountIds": [], "reason": "no enabled accounts" }
```

Note `success: true` even when `started: false` — the reload *worked*, the outcome was "nothing to
run". **Branch on `started`, not on `success`.**

Reload is safe to call repeatedly. It always stops before starting, so it can never leave two
pollers running against the same account.

### 3.6 `GET /admin/pinelabs/status` — per-account metrics

Powers the per-row "last poll" subtitle.

**The response is a bare map keyed by `accountId`, with no `success` envelope:**

```json
{
  "scanserve_ai": {
    "latestTxnAt": "2026-08-10T09:14:02.000Z",
    "lastRunAt": "2026-08-10T09:15:01.482Z",
    "lastTxnsSeen": "12",
    "lastTxnsSaved": "3",
    "lastDurationMs": "845",
    "consecutiveFailures": "0",
    "lastError": null
  },
  "beast_arena_club": { "…same seven keys…" }
}
```

**Trap 1 — every value is a string or `null`, never a number.** These are raw Redis values. Use
`int.tryParse(v ?? '')`, not a cast. `lastTxnsSeen` is `"12"`, not `12`.

| Key | Format | Meaning |
|---|---|---|
| `latestTxnAt` | **UTC ISO-8601** | Timestamp of the newest transaction ingested — the polling watermark |
| `lastRunAt` | **UTC ISO-8601** | When the last poll cycle finished. This is your "last poll" subtitle |
| `lastTxnsSeen` | string int | Transactions returned by PineLabs on that cycle |
| `lastTxnsSaved` | string int | How many were new and actually credited |
| `lastDurationMs` | string int | Cycle duration |
| `consecutiveFailures` | string int | Resets to `"0"` after any success. **> 0 means collection is degrading** |
| `lastError` | `"<UTC ISO> <message>"` | Timestamp then message, space-separated — not JSON |

`latestTxnAt` and `lastRunAt` are genuine UTC ISO strings, so `DateTime.parse(v).toLocal()` is
correct for both.

To split `lastError`, take the first space-separated token as the timestamp and the remainder as the
message:

```dart
final i = raw.indexOf(' ');
final when = DateTime.parse(raw.substring(0, i)).toLocal();
final message = raw.substring(i + 1);
```

**Which accounts appear:** only those the **currently running** poller holds. So:

- poller not running → the response is `{}` (empty object), *not* an error
- a stored-but-disabled account → absent from this response entirely
- an account that has never completed a cycle → present with all-`null` values

**Trap 2 — all-`null` values do not necessarily mean "never ran".** Each metric read falls back to
`null` if Redis is unavailable, so a Redis outage looks identical to a fresh account. Don't render
"never polled" from `/status` alone; cross-check `running` from `GET /admin/pinelabs/running` first,
and if the poller is running but every metric is null, show "metrics unavailable" instead.

Suggested subtitle logic, in priority order:

1. `consecutiveFailures > 0` → red: `"Failing — N consecutive errors"` + `lastError` message
2. `lastRunAt` present → `"Last poll {relative time} · {lastTxnsSaved} saved"`
3. account absent from the map but `enabled` → grey: `"Not being polled — apply changes"`
4. present, all null, poller running → grey: `"Metrics unavailable"`

### 3.7 `POST /admin/pinelabs/poll` — run one poll now

Optional body. Omit both fields for a normal cycle using the stored watermark:

```json
{}
{ "from": "2026-08-10T09:00:00", "to": "2026-08-10T18:30:00" }
{ "from": "2026-08-10", "to": "2026-08-10" }
```

Send both or neither — one without the other is a `400`.

#### Sending `from` / `to` from Flutter

**Both values are IST wall-time.** The string you send is the local Indian clock time you want,
with **no timezone suffix**.

| What you send | Accepted | Window the server actually uses |
|---|---|---|
| `"2026-08-09T14:30:00"` | yes | 14:30 IST ✅ |
| `"2026-08-09T14:30:00.000"` — `toIso8601String()` on a **local** `DateTime` | yes | 14:30 IST ✅ |
| `"2026-08-09 14:30:00"` — `DateTime.toString()` | yes | 14:30 IST ✅ |
| `"2026-08-09T14:30:00+05:30"` — explicit IST offset | yes | 14:30 IST ✅ |
| `"2026-08-09T14:30:00.000Z"` — `toIso8601String()` on a **UTC** `DateTime` | yes | **20:00 IST ❌ — shifted 5.5h** |
| `"2026-08-09"` — date only | yes | expands to that whole IST day |

**The one trap: never send a trailing `Z`.** If your `DateTime` is UTC (or you called `.toUtc()`
before serialising), `toIso8601String()` appends `Z`, the server honours it as UTC, and your window
silently lands 5½ hours late. Nothing errors — you just get the wrong transactions.

The safe formatter, given whatever `DateTime` your pickers produce:

```dart
String istParam(DateTime dt) {
  final d = dt.isUtc ? dt.add(const Duration(hours: 5, minutes: 30)) : dt;
  String p(int n, [int w = 2]) => n.toString().padLeft(w, '0');
  return '${p(d.year, 4)}-${p(d.month)}-${p(d.day)}'
         'T${p(d.hour)}:${p(d.minute)}:${p(d.second)}';
}
```

If your picker only gives dates, either send the bare `YYYY-MM-DD` (the server expands `from` to
`00:00:00` and `to` to `23:59:59` IST) or append those times yourself — both give an identical
window.

The response echoes back the resolved window as `"window"`, so you can assert you got what you
intended:

```json
{ "ok": true, "window": { "from": "2026-08-09T00:00:00", "to": "2026-08-09T23:59:59" }, … }
```

For a watermark run (no `from`/`to`) it is the string `"watermark"`.

Extra `400`s from validation: an unparseable value, or `from` later than `to`.

Response — note the per-account results are spread **flat at the top level**, next to `ok`:

```json
{
  "ok": true,
  "scanserve_ai": {
    "totalSeen": 12, "totalSaved": 3, "hitPageCap": false, "durationMs": 845,
    "fromDate": "2026-08-10T14:40:00", "toDate": "2026-08-10T14:45:00"
  },
  "beast_arena_club": { "error": "Request failed with status code 502" }
}
```

Iterate the keys excluding `ok`. A per-account entry is either a result object **or** `{ "error": … }` —
one account failing does not fail the request, so check for `error` on each entry individually.

**Unlike `/status`, these are real JSON numbers**, not strings.

**Trap 3 — `fromDate`/`toDate` are naive IST wall-time, with no timezone suffix.**
`"2026-08-10T14:40:00"` means 14:40 **India time**. Do **not** call
`DateTime.parse(...).toLocal()` on them — Dart parses an offset-less string as local time, which
double-shifts for any non-IST device. Either display them verbatim with an "IST" suffix, or parse
explicitly as `DateTime.parse('$value+05:30')`. The same rule applies to the `from`/`to` you send:
they are interpreted as IST wall-time.

| Status | Meaning |
|---|---|
| `400` | `Provide both from and to, or neither` |
| `503` | `PineLabs poller is disabled` — not running; reload first |

Two behavioural notes worth surfacing in the UI:

- **An explicit `from`/`to` window does not advance the watermark**, so a backfill can't disturb the
  live schedule. A no-argument poll *does* advance it. Label the two actions differently — "Poll
  now" vs "Backfill range".
- A manual poll can take seconds to tens of seconds and credits real money. Disable the button while
  in flight, show a spinner, and don't add a client timeout short enough to leave the user unsure
  whether it ran. Report `totalSaved` in the result toast.

---

## 4. Screen design

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  PineLabs Accounts                                      │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ ● Polling active — 2 accounts                     │  │
│  │   Started 09:12 · scanserve_ai, beast_arena_club  │  │
│  │                                    [ Reload now ] │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ ⚠ 1 change not applied yet                        │  │
│  │   The poller is still using the previous list.    │  │
│  │                                 [ Apply changes ] │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ScanServe AI                          [●] Enabled  ⋮   │
│  scanserve_ai · secret set · last poll 09:14            │
│  ─────────────────────────────────────────────────────  │
│  Beast Arena Club                      [●] Enabled  ⋮   │
│  beast_arena_club · secret set · last poll 09:14        │
│                                                         │
│                                      [ + Add account ]  │
└─────────────────────────────────────────────────────────┘
```

### The status banner

Drive it from `GET /admin/pinelabs/running`:

| Condition | Colour | Text |
|---|---|---|
| `running: true` | green | "Polling active — N accounts" |
| `running: false`, `loadError != null` | **red** | "Poller stopped — {loadError}" + Retry |
| `running: false`, no enabled accounts | amber | "No accounts enabled — nothing is being polled" |
| `enabledByFlag: false` | grey | "Disabled on server" (hide reload) |

The red state means **PineLabs payments are not being collected right now**. It deserves a
persistent banner, not a toast.

### The "unapplied changes" banner

This is the piece that makes the two-step model comprehensible. After any successful
POST/PATCH, set a local `hasUnappliedChanges` flag and show the banner until a reload succeeds.

Cross-check it against the server too, so the flag survives an app restart or a second admin's
edits: compare the enabled `accountId`s from `GET /accounts` with `accountIds` from
`GET /running`. If the sets differ, changes are pending regardless of local state.

### Save behaviour

Prefer an **explicit Save button** in an edit sheet over autosave. Each save is one PATCH. On
success, close the sheet, refresh the list, and raise the unapplied-changes banner.

The `enabled` toggle is the one reasonable exception — toggling it can PATCH immediately, since it
is a single unambiguous field. Show an inline spinner on the row and revert the switch if the call
fails.

### Add / edit form

| Field | Add | Edit |
|---|---|---|
| `accountId` | required, validated `^[a-zA-Z0-9_-]{1,64}$`, helper "letters, numbers, `_` and `-` only" | **read-only** |
| `label` | optional | editable |
| `clientId` | required | editable |
| `clientSecret` | required, obscured | **empty**, "Leave blank to keep the current secret" |
| `enabled` | switch, default on | switch |

On edit, build the PATCH body from changed fields only — and include `clientSecret` **only if the
field is non-empty**.

### Confirmations

- **Disabling an account** stops collecting that merchant's payments once applied. Confirm with
  wording that says so: *"Payments for ScanServe AI will stop being collected after you apply
  changes. Continue?"*
- **Rotating a secret** breaks collection if the new value is wrong, and the failure is invisible
  until transactions stop arriving. After applying, point the user at `GET /admin/pinelabs/status`
  and suggest watching `consecutiveFailures` and `lastError` for that account.

---

## 5. Suggested flow

```
open page
  └─ GET /running  +  GET /accounts        (parallel)
       └─ render banner + list, start 15s poll of /running

edit an account
  └─ PATCH /accounts/:accountId
       └─ 200 → refresh /accounts, show "changes not applied" banner

apply
  └─ POST /reload
       ├─ started:true  → success toast, refresh /running, clear banner
       └─ started:false → show `reason`, keep banner
```

---

## 6. Edge cases

- **Two admins editing at once.** There is no locking. Last write wins, and the second admin's
  `GET /accounts` will show the other's changes. Refresh the list after every mutation rather than
  trusting local state.
- **Reload while a poll is mid-flight.** Safe. The running poll is signalled to stop and aborts at
  its next checkpoint; nothing is double-credited, because crediting is deduplicated server-side by
  payment id.
- **Deleting an account.** There is no delete endpoint, by design — removing credentials would
  orphan the stored polling watermarks. Use `enabled: false` instead, and present it as "Disable"
  rather than "Delete".
- **`clientSecretSet: false`.** Should not happen for a live account (the secret is required at
  creation). If you see it, flag the row as misconfigured and prompt for a rotation.
- **Reload returns `started: false` with `reason: "no enabled accounts"`.** Not an error — the admin
  disabled everything. Amber banner, no red.
- **Rate limiting.** The API applies a global 1000 requests/minute limit. A 15s status poll is
  nowhere near it, but do not poll `/running` on a sub-second timer.
- **Empty list on first load.** Before any account is seeded the list is empty and the poller is
  stopped. Show an empty state that explains PineLabs collection is inactive, with a primary
  "Add account" action.
