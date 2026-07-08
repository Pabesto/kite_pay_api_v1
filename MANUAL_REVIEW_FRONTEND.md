# Manual Transaction Review — Frontend Integration Guide

> Audience: the Flutter (client) developer/AI agent building the admin "Transaction Review" page.
> Backend is complete. This document is the full contract: mental model, REST API, realtime
> events, screen designs, and edge cases. Everything here is implemented and stable.

---

## 1. What this feature is (mental model)

The backend normally auto-processes every incoming payment ("**auto mode**"). An **admin can
switch on "manual mode"** for a short, timed window (**1–10 minutes**), scoped to:

- **global** — every incoming payment,
- **qr** — one specific QR code,
- **user** — all QRs belonging to one user (their managing subadmin *or* the QR's direct assigned user).

While a matching window is active, incoming payments are **held** (not counted yet) and wait for the
admin to **Approve** or **Reject**. If the admin does nothing, each held payment **auto-approves
after ~60 seconds** (a safety backstop, configurable server-side).

Manual mode lives in server memory and **resets to auto on server restart** — this is by design.

The UI has **three jobs**:
1. **Control** manual-mode windows (turn on/off/extend, see time left).
2. **Act** on the live queue of held payments (approve/reject, with a per-item countdown).
3. **Review** rejected payments (detailed list + daily summary).

---

## 2. Conventions (read first)

- **Auth:** All endpoints are **admin-only**. Send the **same auth token you already use for other
  `/api/admin/...` calls**. Non-admins get 401/403 — hide this whole section for them.
- **Base path:** every endpoint below is under `/api/admin`.
- **Money is in paise (integers).** Rupees = `amount / 100`. Display as `₹{(amount/100).toStringAsFixed(2)}`.
  Never show the raw paise value.
- **Times are ISO-8601 UTC strings** (e.g. `2026-07-08T10:00:30.000Z`). Parse with
  `DateTime.parse(...).toLocal()`.
- **`reviewExpiresAt`** = the moment a held txn will auto-approve. Drive a per-item countdown from it.
- **`remainingMs`** (manual windows) = milliseconds left on that window. Use it directly for a
  countdown and re-sync it on each poll to avoid device-clock drift.

---

## 3. REST API reference

### 3.1 Control plane — manual-mode windows

#### `POST /api/admin/manual-mode` — turn on / extend / reset a window
Request body:
```jsonc
{
  "scope": "global" | "qr" | "user",  // required
  "qrId": "QR123",                     // required only when scope = "qr"
  "userId": "u1",                      // required only when scope = "user"
  "minutes": 5                         // required, 1–10
}
```
Re-POSTing the same scope **replaces/extends** its timer (this is how "reset time" works).

Response `200`:
```jsonc
{
  "success": true,
  "mode": "manual",
  "window": {
    "scope": "qr", "qrId": "QR123", "userId": null,
    "until": 1751967630000, "untilIso": "2026-07-08T10:20:30.000Z",
    "remainingMs": 300000,
    "setBy": "admin1", "setAt": 1751967330000, "setAtIso": "2026-07-08T10:15:30.000Z"
  },
  "active": [ /* every active window, same shape */ ]
}
```
Errors: `400 { "error": "minutes must be a number between 1 and 10" }` (also for bad scope / missing qrId/userId).

#### `DELETE /api/admin/manual-mode` — turn off (back to auto)
Body **or** query params (both accepted):
```jsonc
{ "scope": "qr", "qrId": "QR123" }   // clear one window
// or
{ "all": true }                       // clear everything → full auto
```
Response `200`: `{ "success": true, "cleared": [ ...windows removed... ], "active": [ ...still active... ] }`

#### `GET /api/admin/manual-mode` — current state (poll on page open)
Response `200`:
```jsonc
{
  "success": true,
  "manualActive": true,      // any window active?
  "globalManual": false,     // is a global window active?
  "active": [
    { "scope": "qr", "qrId": "QR123", "userId": null,
      "until": 1751967630000, "untilIso": "...", "remainingMs": 247000,
      "setBy": "admin1", "setAt": 1751967330000, "setAtIso": "..." }
  ]
}
```

### 3.2 Data plane — the live held queue

#### `GET /api/admin/pending-review` — held transactions
Query params: `qrId` (optional filter), `cursor` (pagination), `limit` (default 25, max 100).
Poll this **on page open and on every socket reconnect**.
```jsonc
{
  "success": true, "total": 3, "nextCursor": "doc3" | null,
  "records": [
    { "$id": "doc1", "qrCodeId": "QR123", "paymentId": "pay_x", "amount": 50000,
      "provider": "razorpay", "vpa": "user@upi", "rrnNumber": "RRN1",
      "created_at": "2026-07-08T10:00:30.000Z",
      "reviewExpiresAt": "2026-07-08T10:01:30.000Z", "ownerSubadminId": "s1" }
  ]
}
```

#### `POST /api/admin/transactions/{id}/review-approve` — approve (make it live)
No body.
```jsonc
// 200 { "success": true, "status": "approved" }
// 404 { "error": "Transaction not found" }
// 409 { "error": "Already approved", "reviewStatus": "approved" }   // already handled (admin/timeout)
// 503 { "error": "Busy resolving, retry" }
```

#### `POST /api/admin/transactions/{id}/review-reject` — reject
```jsonc
// body (optional):  { "reason": "suspicious" }
// 200 { "success": true, "status": "rejected" }
// same 404 / 409 / 503 responses as approve
```

### 3.3 Reporting — rejections

#### `GET /api/admin/rejected-transactions` — detailed rejection log
Query params: `qrId`, `provider`, `cursor`, `limit` (default 25, max 100).
```jsonc
{
  "success": true, "total": 12, "nextCursor": null,
  "records": [
    { "$id": "r1", "txnId": "doc1", "qrId": "QR123", "paymentId": "pay_x", "amount": 50000,
      "provider": "razorpay", "vpa": "user@upi", "rrnNumber": "RRN1", "ownerSubadminId": "s1",
      "originalCreatedAt": "...", "rejectedAt": "...", "adminId": "admin1",
      "adminName": "Admin", "reason": "suspicious" }
  ]
}
```

#### `GET /api/admin/rejected-summary` — daily × QR rollup
Query params: `from` (`YYYY-MM-DD`), `to` (`YYYY-MM-DD`), `qrId`. Defaults to today.
```jsonc
{
  "days": [
    { "date": "2026-07-08", "totalPaise": 150000, "totalRs": 1500,
      "qrs": { "QR123": 100000, "QR9": 50000 } }
  ],
  "grandTotalPaise": 150000, "grandTotalRs": 1500
}
```

---

## 4. Realtime — Socket.IO events

Use the **existing admin socket connection** (the same one used for `txn:new`). Admins are
**auto-subscribed** to review events on connect — **no `emit`/subscribe call is required**.

| Event | When | Payload | UI action |
|-------|------|---------|-----------|
| `review:pending` | a payment was just held | `{ $id, qrCodeId, paymentId, amount, provider, vpa, rrnNumber, created_at, reviewExpiresAt, ownerSubadminId }` | prepend to queue, start countdown, sound/vibrate/badge |
| `review:resolved` | a held payment was approved/rejected (by an admin **or** the timeout) | `{ $id, qrCodeId, paymentId, amount, provider, outcome: "approved"\|"rejected", reviewedBy, reviewedAt }` | remove `$id` from queue; if `reviewedBy === "system-timeout"` show a subtle "auto-approved" toast |

---

## 5. Screens

Recommended: one **"Transaction Review"** area with 3 tabs.

### Tab 1 — Manual Mode Control
```
┌──────────────────────────────────────────────┐
│  Manual Review Mode              ● AUTO / MANUAL│  ← big status pill (green AUTO / amber MANUAL)
├──────────────────────────────────────────────┤
│  Active windows                                │
│   🌐 Global           04:12 left      [ Stop ] │  ← live countdown from remainingMs
│   🔳 QR QR123         02:47 left      [ Stop ] │
│   👤 User u1          00:31 left      [ Stop ] │
│                                                │
│  Turn on manual mode:                          │
│   Scope:  ( Global ) ( This QR ) ( A User )    │  ← segmented control
│   [ QR / User picker shown for qr|user scope ] │
│   Duration:  [1]───●──── [10] min   (slider)   │
│              [   Activate manual mode   ]       │
│                                    [ Stop all ] │
└──────────────────────────────────────────────┘
```
- On open: `GET /manual-mode`; tick countdowns locally each second; re-fetch every ~15s.
- Activate → `POST /manual-mode`. Stop → `DELETE /manual-mode {scope,...}`. Stop all → `DELETE {all:true}`.
- Show a persistent banner whenever `manualActive` so the admin never forgets it's on.

### Tab 2 — Pending Review (main action screen) ⭐
```
┌──────────────────────────────────────────────┐
│  Pending Review               3 held    🔔     │
├──────────────────────────────────────────────┤
│  ₹500.00    QR123 · razorpay                   │
│  user@upi · RRN1 · 10:01:05                    │
│  ◔ auto-approves in 0:42                       │  ← countdown ring from reviewExpiresAt (red near 0)
│         [  ✓ Approve  ]   [  ✕ Reject  ]        │
│  … more cards, newest on top …                 │
└──────────────────────────────────────────────┘
```
- On open: `GET /pending-review`. Then keep in sync via socket + reconcile on reconnect.
- Per-card countdown from `reviewExpiresAt`; when it passes 0, disable buttons and show
  "auto-approving…" (the `review:resolved` timeout event will remove it shortly).
- Approve → `POST …/review-approve`. Reject → sheet with optional reason → `POST …/review-reject`.
- On `200` remove card; on `409` remove silently + toast "Already handled"; on `503` toast "busy, retry".
- Empty state: "No transactions waiting. Manual mode is {on/off}."
- **Alert on new items** (sound + vibration + optional local notification) — this is time-critical (60s).

### Tab 3 — Rejected (reporting)
- Top: summary card from `GET /rejected-summary` (today by default, with a date-range picker) —
  grand total ₹ plus per-day / per-QR breakdown.
- Below: paginated list from `GET /rejected-transactions` (infinite scroll via `nextCursor`).
  Row: ₹amount, QR, provider, VPA/RRN, rejectedAt, adminName, reason. Filters: QR, provider, date.

---

## 6. Realtime + reconnect rules
- Keep the pending list synced from **both** the socket **and** an initial/reconnect poll of
  `GET /pending-review` — socket events can be missed during disconnects.
- On every socket reconnect → re-fetch the queue and reconcile by `$id`.
- De-dupe by `$id` (a `review:pending` for an id already present = no-op).
- Countdowns are UI-only timers; the server is source of truth (a `review:resolved` event or a
  re-poll always wins).

## 7. Edge cases
- **409 on approve/reject** → already resolved (another device or the timeout). Remove the item; do
  **not** show an error.
- **Manual window expires while items are still pending** → those items still resolve (by admin or
  their own 60s timeout). Never tie a pending card's lifetime to the window's lifetime.
- **Clock drift** → prefer server `remainingMs`; for `reviewExpiresAt`, let the countdown reach 0 and
  rely on the `review:resolved` event to remove the card.
- **Amounts are paise** — always divide by 100 for display.
- **Admin-only** — gate the whole section behind the admin role.

## 8. Acceptance criteria
1. Toggling manual mode (each scope) reflects immediately and shows a live countdown.
2. A payment made during an active window appears in Pending within ~1s (socket) with a working countdown.
3. Approve removes the card and the txn then appears in normal transaction lists/totals.
4. Reject removes the card and the txn appears under Rejected + rejected-summary.
5. Doing nothing for ~60s auto-removes the card (timeout approve) via `review:resolved`.
6. Killing & reopening the app rebuilds the pending queue from `GET /pending-review`.
