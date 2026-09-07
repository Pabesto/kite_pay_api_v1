# QR Settlement (T+1 hold and T+0 early release) — Frontend Integration Guide

> Audience: the Flutter developer/AI agent building the QR screens, the withdrawal screen, and the
> admin "release funds early" tool. Backend is complete and live-safe. This document is the full
> contract. **This is real money. The single most important rule is in §2: stop computing the
> withdrawable figure on the device.**

---

## 1. What this is (mental model)

Money that arrives on a QR code is **not withdrawable the same day**. It settles **T+1**: today's
pay-in becomes available tomorrow. There is no job and no timer behind this. The server derives it on
every read, so at IST midnight yesterday's money simply becomes available on its own.

```
withdrawable = amountAvailableForWithdrawal − heldToday
heldToday    = max(0, todayTotalPayIn − releasedToday)
```

**Early release (T+0) is the exception.** An admin can release part of one QR's pay-in for one IST
day, so the merchant can withdraw it the same day. It is capped at a configurable percentage of that
QR's pay-in for that day, **50% by default**.

Three properties worth knowing, because they shape the UI:

- A release **expires by itself** at IST midnight. It applies to one day only. There is nothing to
  clean up and nothing that can leak into tomorrow.
- A release **can never create balance**. It only stops today's pay-in from being held. The QR's
  available balance is still the hard ceiling, so releasing more than the day's pay-in simply unlocks
  all of it and no more.
- A release is **not a payment**. No ledger entry, no commission, no balance changes. It only changes
  what the user is allowed to withdraw.

---

## 2. ⚠️ The one thing you must change

**Delete any device-side calculation of what can be withdrawn today.** If your model does something
like this, remove it:

```dart
// WRONG — delete this. It will disagree with the server the moment a release exists.
int? canWithdrawToday = amountAvailableForWithdrawal! - todayTotalPayIn!;
```

The server now returns the answer directly as **`canWithdrawTodayPaise`** on every QR. Display that
field and nothing else. The rule lives in exactly one place on the server, and it is what the
withdrawal endpoint enforces, so any local copy is guaranteed to drift, show money the server will
refuse, or hide money the user is entitled to.

Every future settlement change, per-QR rules, holds, standing T+0 merchants, then ships without a
coordinated app release.

Clamp at zero for display only. `canWithdrawTodayPaise` can be negative when a QR's balance is already
below what arrived today. Show `₹0.00`, never a negative amount.

---

## 3. Conventions

- **Money is integer paise.** Rupees for display only: `'₹${(paise / 100).toStringAsFixed(2)}'`.
  Fields ending in `Paise` are paise. The older `todayTotalPayIn` and `amountAvailableForWithdrawal`
  on the QR object are also paise, unchanged.
- **Days are IST calendar days**, `YYYY-MM-DD`. "Today" always means the IST day, whatever the
  device's timezone is. Never compute the day locally for these endpoints.
- **Auth**: the admin release endpoints are **admin role only**. Not a label, not a subadmin, not an
  employee. Everyone else gets `403`. Hide the entire tool unless the role is `admin`.
- **Errors**: `{ "error": "<message>" }`. Show the message verbatim for `400`, it contains the exact
  numbers the admin needs.

---

## 4. QR objects (user and admin lists)

`GET /api/qr-codes`, `GET /api/qr-codes/user/:userId` and `GET /api/qr-codes/user_assigned/:userId`
now return four extra fields on every QR:

```jsonc
{
  // …existing QR fields…
  "amountAvailableForWithdrawal": 500000,   // paise, unchanged
  "todayTotalPayIn": 400000,                // paise, unchanged
  "yesterdayTotalPayIn": 120000,            // paise, unchanged

  "releasedTodayPaise": 200000,             // released early by admin for today (0 when none)
  "heldTodayPaise": 200000,                 // today's pay-in still held back = max(0, todayPayIn − released)
  "canWithdrawTodayPaise": 300000           // ← DISPLAY THIS. available − held
}
```

Suggested QR card:

| Line | Source |
|---|---|
| **Available to withdraw now** | `canWithdrawTodayPaise`, clamped at 0 |
| Total balance | `amountAvailableForWithdrawal` |
| Received today | `todayTotalPayIn` |
| Held until tomorrow | `heldTodayPaise`, hide the row when it is 0 |
| "₹2,000 released early by admin" | show only when `releasedTodayPaise > 0` |

The released badge matters. Without it a merchant sees more money than yesterday's rules allowed and
has no idea why.

---

## 5. Dashboards

`GET /api/admin/dashboard/user/:userId` adds two fields next to the existing `withdrawableAmount`:

```jsonc
{ "withdrawableAmount": 300000,    // already accounts for releases — do not adjust it
  "heldTodayPaise": 200000,        // still held across this user's QRs
  "releasedTodayPaise": 200000 }   // released early across this user's QRs
```

`GET /api/admin/dashboard/subadmin/:merchantId` adds the same three-way split it already uses:
`totalHeldToday` / `totalReleasedToday`, `selfHeldToday` / `selfReleasedToday`, and
`userHeldToday` / `userReleasedToday`. The existing `withdrawableAmount`, `selfWithdrawableAmount`
and `userWithdrawableAmount` already include releases, so use them as they are.

---

## 6. Admin: the early-release tool (admin role only)

### 6.1 Open the dialog — `GET /api/admin/qr-settlement/:qrId`
Optional `?date=YYYY-MM-DD` to inspect another IST day; defaults to today.

```jsonc
{ "success": true,
  "qrId": "QR123", "date": "2026-09-07",
  "availablePaise": 500000,          // the QR's balance
  "todayPayInPaise": 400000,         // what arrived on this day
  "releasedPaise": 200000,           // released so far for this day
  "heldPaise": 200000,               // still held
  "withdrawablePaise": 300000,       // what the merchant can take right now
  "maxReleasablePaise": 200000,      // the ceiling: maxPercent% of todayPayInPaise, rounded down
  "maxPercent": 50,
  "assignedUserId": "u1",
  "release": {                       // null when nothing has been released for this day
    "$id": "…", "qrId": "QR123", "date": "2026-09-07",
    "releasedPaise": 200000, "releasedRs": 2000,
    "todayPayInAtSetPaise": 400000,  // what the day's pay-in was when it was set (audit)
    "maxPercentAtSet": 50,
    "percentAtSet": 50,              // the slider value used, or null when set by exact amount
    "reason": "merchant needs same-day funds",
    "releasedBy": "admin1", "createdAt": "…", "updatedAt": "…" } }
```

**Keep the whole response.** You will send three of its numbers back on submit (§6.2), so hold onto
`todayPayInPaise`, `releasedPaise` and `maxPercent` exactly as received.

### 6.2 Set the release — `PUT /api/admin/qr-settlement/:qrId/release`

Send **exactly one** of `percent` or `amount`.

**The slider (recommended).** Range `0` to `maxPercent`, stepping in whole percent. Show the rupee
value live as `todayPayInPaise × percent ÷ 100`, rounded **down**, which is exactly what the server
computes, so the preview and the result always agree.

```jsonc
{ "percent": 50,                               // 0…maxPercent
  "expectedTodayPayInPaise": 400000,           // REQUIRED with percent — the figure your slider used
  "expectedReleasedPaise": 0,                  // recommended — what §6.1 showed as already released
  "reason": "merchant needs same-day funds",   // required, min 4 characters
  "date": "2026-09-07" }                       // optional, defaults to today
```

**Exact amount** (for a specific figure, and for revoking with `0`):

```jsonc
{ "amount": 2000,                              // RUPEES. 0 revokes.
  "expectedReleasedPaise": 0,                  // optional here, still recommended
  "reason": "merchant needs same-day funds" }
```

Returns the same shape as §6.1, with the updated numbers and the saved `release` (which also records
`percentAtSet`, null when set by exact amount).

#### The two safety rules, and why they exist

**1. It is absolute, never a top-up.** Sending `percent: 50` twice leaves the release at 50%, never
100%. Sending `amount: 2000` twice leaves it at ₹2,000, never ₹4,000. A double tap, a retry after a
timeout, or a resubmitted form can therefore never release twice. Always send the total you want the
release to be, and prefill the control from the current `releasedPaise`.

**2. The figures you were shown must still be true.** `expectedTodayPayInPaise` and
`expectedReleasedPaise` are checked against the server before anything is written. This matters most
for the slider: if ₹1,00,000 was on screen and the admin picks 50%, they approved ₹50,000. If another
₹1,00,000 arrived while the dialog was open, applying 50% blindly would release ₹1,00,000, double what
was approved. The server refuses instead:

```jsonc
// 409
{ "error": "This QR changed while the release dialog was open: today's pay-in is now ₹2,00,000.00, you were shown ₹1,00,000.00. Check the new figures and confirm again.",
  "code": "STALE_SETTLEMENT",
  "current": { "todayPayInPaise": 200000, "releasedPaise": 0, "maxPercent": 50, "maxReleasablePaise": 100000 } }
```

Handle `code: "STALE_SETTLEMENT"` by re-rendering the dialog **in place** from `current`, without a
second network call, keeping the admin's chosen percent and showing the new rupee value. Then require
one more tap to confirm. Do not retry automatically, the whole point is that a human re-approves the
new number.

The same 409 fires when another admin released first and `expectedReleasedPaise` no longer matches.
That one is not a correctness problem, because the absolute semantics already prevent stacking, but it
stops one admin silently overwriting another's decision.

#### Other rejections

`400` with the real numbers when the request is above the cap, for example `Cannot release ₹3,000.00.
The limit is 50% of this QR's pay-in for 2026-09-07 (₹4,000.00), which is ₹2,000.00.` Show it
verbatim. Also `400` for a percent above `maxPercent` or outside 0 to 100, a negative amount, a reason
under 4 characters, sending both or neither of `percent` and `amount`, omitting
`expectedTodayPayInPaise` alongside a percent, or the feature being switched off entirely.

### 6.3 Revoke — `DELETE /api/admin/qr-settlement/:qrId/release`
Optional `?date=`. Identical to setting the amount to zero, and returns the same shape.

Revoking does **not** claw back money the merchant already withdrew. It only re-holds whatever is
still sitting in the QR. Say so in the confirmation dialog, because admins will assume otherwise.

### 6.4 Audit list — `GET /api/admin/qr-releases?date=&qrId=&limit=&cursor=`
```jsonc
{ "success": true, "date": "2026-09-07", "maxPercent": 50, "total": 3,
  "releases": [ /* the release shape from §6.1 */ ],
  "totalReleasedPaise": 450000,
  "nextCursor": null }
```
Cursor pagination, default 25 and max 100 per page, same as every other list. Use it for a "released
today" screen so there is one place to review the day's decisions.

---

## 7. The cap, and one gotcha

The ceiling is the config key `qr_daily_release_max_percent`, admin-tunable, **default 50**.

> **`0` means nothing may be released. It does NOT mean "unlimited".**
> This is the opposite of the payout limits, where `0` means no limit. Here the value is a percentage,
> so zero percent is zero. Setting it to `0` is the kill switch for the whole feature, and `100`
> allows a full day's pay-in to be released.

When the cap is `0`, `maxReleasablePaise` comes back as `0` and any attempt returns
`400 Early release is switched off`. Disable the release button in that state rather than letting the
admin type an amount and get rejected.

The cap is checked **when the release is set**, against that day's pay-in at that moment. If more
money arrives later the same day, the existing release stays valid and the admin can raise it up to
the new, larger ceiling.

---

## 8. Screens

**Merchant side** (no new screens, only corrected numbers)
1. *QR list and QR detail* — show `canWithdrawTodayPaise` as the headline, with held and released
   rows underneath. Remove the local subtraction.
2. *Withdrawal form* — validate the amount against `canWithdrawTodayPaise` for the chosen QR. The
   server enforces the same figure, so a rejection here means the screen is stale; re-fetch the QR.

**Admin side**
3. *QR detail* — a "Release funds early" action opening the dialog in §6.1 and §6.2, visible only for
   role `admin`, and only when `maxPercent > 0`. The dialog is a **slider from 0 to `maxPercent`**
   with the rupee value shown live, the resulting withdrawable figure previewed, a required reason,
   and a confirm button. Send the percent together with the figures the dialog was built from, and be
   ready to re-render in place on a `STALE_SETTLEMENT` reply.
4. *Released today* — the §6.4 list with the day's total, each row showing the QR, the amount, who
   released it and why, with a revoke action.

---

## 9. Edge cases

- **Negative `canWithdrawTodayPaise`** happens when a QR's balance is already below what arrived
  today. Display `₹0.00`. Do not hide the card and do not show a minus sign.
- **A release larger than the day's pay-in** cannot be created through the API, but an older row could
  exceed a cap that was lowered afterwards. The maths still holds, held clamps at zero, and the
  dialog will show a release above the current `maxReleasablePaise`. Show it as it is; the admin can
  lower it.
- **Nothing arrived today.** `maxReleasablePaise` is `0`, so there is nothing to release. Disable the
  action with "No pay-in today".
- **A stale screen after midnight.** A release shown at 11:59 pm no longer applies at 12:01 am, but
  by then that money is withdrawable anyway because it is no longer "today's" pay-in. The user never
  loses access. Re-fetch on resume so the badge disappears.
- **The release lookup failing on the server** falls back to full T+1 holding, never to releasing
  everything. If a merchant reports that released money vanished briefly, this is why, and a refresh
  will bring it back.
- **A busy QR can reject the slider repeatedly.** Every payment that lands changes the basis, so on a
  high-volume QR the confirm may come back `STALE_SETTLEMENT` more than once. That is the guard doing
  its job. Re-render from `current` and let the admin confirm the new figure; do not weaken the check
  or drop the expected fields to make it go away.
- **There is no realtime event for a release yet.** After an admin sets one, the merchant's screen
  updates on its next fetch, so make sure the QR screen re-fetches on resume and on pull-to-refresh.
