# Customer Payout & Payout Wallet — Frontend Integration Guide

> Audience: the Flutter developer/AI agent building the **user** screens (Payout Wallet, Customer
> Payout requests, saved customer accounts) and the **admin** screens (approve wallet withdrawals,
> mark payouts PAID/REJECTED, tag accounts, manual wallet adjustments, payout commission reports).
> Backend is complete. This document is the full contract. **This is real money — follow the
> money rules in §2 exactly.**

---

## 1. What this feature is (mental model)

Today a user withdraws QR balance with a **withdrawal request** that admin pays out by UPI/bank
("Direct"). This feature adds a second destination and a new flow on top of it:

```
                       ┌──────────────────────┐
  QR balance ──withdraw (mode:'wallet', NO commission)──▶ │  PAYOUT WALLET (per user)  │
                       │  balance / hold / available │
                       └──────────┬───────────┘
                                  │  customer payout request (amount + payout commission is HELD)
                                  ▼
                  admin marks PAID (reference no.) ─▶ wallet debited, commission earned
                  admin REJECTS (reason)           ─▶ hold released, nothing debited
                  admin manual credit/debit (notes + reference no.) ─▶ shows in wallet history
```

1. **Withdrawal request now has two destinations.** `mode: 'upi' | 'bank'` = **Direct** (unchanged).
   `mode: 'wallet'` = **Payout Wallet**: admin approves, the QR balance moves into the user's
   payout wallet, **no commission is cut**, no bank details are needed, **no time-window restriction
   and no max-pending cap** (wallet requests also never count toward the direct cap).
2. **Payout Wallet** — one per user. `balance` = money in the wallet, `hold` = money reserved by
   pending customer payout requests, `available = balance − hold`.
3. **Customer Payout** — from the wallet, the user asks admin to pay one of *their customers*
   via NEFT / IMPS / RTGS / UPI. Required: customer name, bank name, IFSC, account number (+ confirm),
   amount, optional notes. **UPI mode additionally needs the customer's UPI ID (VPA)** — it is stored
   on the saved account and required before a UPI payout can be requested. The customer account is
   saved for reuse, can be searched by name or account number, and can be deleted when it has no
   pending request.
4. Each saved customer account has a tag **`bankingStatus`**: `not_added` (default) → admin flips to
   `added` once the beneficiary is added in the payout banking portal. Show it as a chip.
5. **Payout commission** — a separate rate per user (`payoutCommission`, % — set by admin in Edit
   User, next to the existing withdrawal `commission`). It is **computed and held at request time**
   and **charged only when admin marks PAID**. Rejected requests charge nothing.
6. Admin can **manually credit/debit** a wallet with mandatory notes and an optional reference number
   (e.g. "customer paid outside platform"). These appear in the user's wallet history.

Statuses of a customer payout request: `pending` → `paid` | `rejected` | `cancelled` (all final).
A rejected request carries `rejectionReason`; `cancelled` means the user withdrew it themself
(§5.4); in both cases the user simply creates a new request.

---

## 2. Conventions (read first)

- **Who has what:** the *user-side* feature (own payout wallet, own customer accounts, requesting
  customer payouts, §3–§5) is for **users and subadmins only**. **Admins never have a wallet or
  requests of their own** — do not show the wallet card, "New payout", "My customer accounts" or the
  wallet-destination toggle to an admin; the server also refuses admin `POST /accounts` and
  `POST /requests` with 403. Admin uses §6 exclusively.
- **Auth:** same Bearer token as every other `/api/...` call. User endpoints are for any logged-in
  user and are always scoped to the caller. Who sees / does what on `/api/payout/admin/...`:

  | role | sees | may do |
  |---|---|---|
  | `admin` | everything | everything |
  | `employee` with `view_payouts` / `edit_payouts` | **only the subadmins assigned to them** (`assigned_to`) and those subadmins' users | queue actions on those users: mark paid, reject, tag banking status, verify accounts, delete accounts, recompute stats; `paidVia` visible |
  | `subadmin` | their own users (parent = them) plus themself | read-only |
  | anyone else | — | 401/403 |

  **Admin-role only** (403 for everyone else, including labelled employees): wallet adjust, revert-to-QR,
  retry-credit, statement export, pause switches, per-user limits, settings, integrity check,
  deactivating a source account. Hide those controls unless the role is `admin`.
- **Base paths:** payout endpoints are under **`/api/payout`**. Withdrawal endpoints stay under
  `/api/user`. Edit-user stays under `/api/admin`.
- **Money:**
  - Every amount **you send** is in **rupees** (e.g. `"amount": 1250.50`) — same as `/withdraw_new`.
  - Every amount **you receive** is in **integer paise** (`amountPaise`, `balancePaise`, …) with a
    derived rupee twin (`amountRs`, `balanceRs`, …) for display. Never do arithmetic on the `Rs`
    values; if you must compute, use paise and divide by 100 only for display:
    `'₹${(paise / 100).toStringAsFixed(2)}'`.
  - Commission is rounded **up** to the paise on the server. Always show the server's preview
    (`GET /commission-preview`) rather than computing locally.
- **Times:** ISO-8601 UTC strings (`2026-09-06T10:00:30.000Z`). `DateTime.parse(s).toLocal()`.
  Date filters (`from`, `to`) are **IST calendar days** `YYYY-MM-DD`.
- **Lists:** cursor pagination. Send `limit` (default 25, max 100) and `cursor` (the `nextCursor`
  from the previous page). `nextCursor == null` ⇒ last page. Bad cursor ⇒ `400`. Implement
  infinite scroll (or "Load more") on **every** endpoint below — none of them returns everything:

  | endpoint | list key |
  |---|---|
  | `GET /wallet/transactions`, `GET /admin/wallet/transactions` | `transactions` |
  | `GET /accounts`, `GET /admin/accounts` | `accounts` |
  | `GET /requests`, `GET /admin/requests` | `payouts` |
  | `GET /accounts/:id/payouts`, `GET /admin/accounts/:id/payouts` | `payouts` (the `account` object is repeated on every page) |
  | `GET /admin/wallets` (without `userId`) | `wallets` |
  | `GET /admin/commissions` (max 50/page) | `commissions` |
  | `GET /admin/commissions/monthly`, `…/all-time` | `totals` |

  Changing any filter or sort resets the cursor — start again from page one. `total` is the count
  matching the current filters (use it for "n results", not for paging).
- **Errors:** `{ "error": "<message>" }`. Show `error` verbatim to the user for 400/409/422.
  - `400` validation · `403` not allowed · `404` not found · `409` busy lock / insufficient balance /
    already resolved · `422` commission rate misconfigured (tell user to contact support) · `500` server.
  - On **409 "busy"** (`Payout wallet is busy…`) retry once after ~1s. On **409 already resolved**
    just refresh the list.
- **Idempotency / double taps:** disable the submit button while a request is in flight. For the admin
  manual adjustment send a client-generated `refId` (UUID) — resending the same `refId` is a safe no-op.

---

## 3. Withdrawal request → Payout Wallet (existing endpoints, one new mode)

### 3.1 `POST /api/user/withdraw_new` — user, unchanged except `mode: 'wallet'`
Add a destination selector **Direct / Payout Wallet** to the existing withdrawal form.

For **Payout Wallet** send:
```jsonc
{
  "userId": "u1",
  "qrId": "QR123",
  "mode": "wallet",
  "preAmount": 5000,       // rupees
  "amount": 5000,          // MUST equal preAmount (no commission)
  "commission": 0          // MUST be 0
}
```
No `holderName`, `upiId`, bank fields needed (they are ignored / defaulted). Wallet requests are
**not** subject to withdrawal time windows or the max-pending-requests cap (so skip the
`/withdrawal_time_check` gate for this mode). The QR balance check and the 400-on-mismatch rules
still apply. Response: `{ success: true, data: <withdrawal doc> }` with `mode: "wallet"`.

Skip the `/withdraw_commission_preview` call for wallet mode — commission is always 0.

### 3.2 Withdrawal lists
`GET /api/user/withdrawals_paginated` and `GET /api/user/user_withdrawals_paginated` return
`mode: "wallet"` rows exactly like `upi`/`bank` rows. Display them as **"To Payout Wallet"**. When
approved, `utrNumber` holds the wallet ledger id (`pwt_…`) instead of a bank UTR.

### 3.3 `POST /api/user/withdrawals/approve_new` — admin
For a `mode: "wallet"` row **`utrNumber` is not required** — send just `{ "id": "wdh_…" }`.
Success: `{ success: true, message: "Withdrawal approved and credited to payout wallet" }`.
If you get **500 `Withdrawal approved but payout wallet credit failed…`**: the QR was debited and the
withdrawal is approved, but the wallet credit did not land. Show a "Retry wallet credit" action that
calls `POST /api/payout/admin/wallet/retry-credit` (§6.4). For `upi`/`bank` rows nothing changed
(UTR still required).

`POST /withdrawals/reject_new` works unchanged for wallet rows.

---

## 4. User — Payout Wallet

### 4.1 `GET /api/payout/wallet`
```jsonc
{
  "success": true,
  "wallet": {
    "userId": "u1",
    "balancePaise": 500000, "holdPaise": 103000, "availablePaise": 397000,
    "balanceRs": 5000, "holdRs": 1030, "availableRs": 3970,
    "totalCreditedPaise": 1200000,        // lifetime: wallet withdrawals + admin credits
    "totalPaidOutPaise": 600000,          // lifetime: customer payouts paid (excl. commission)
    "totalPayoutCommissionPaise": 18000,  // lifetime: payout commission charged
    "totalAdminDebitPaise": 0,            // lifetime: admin debits
    "totalRevertedToQrPaise": 0,          // lifetime: moved back to QR codes by admin
    "paidCount": 3,                       // lifetime: customer payouts paid
    "updatedAt": "2026-09-06T10:00:30.000Z"      // null if the wallet has never been used
  }
}
```
Show **Available** big, with Balance and On hold underneath. A user with no wallet yet gets zeros.
The lifetime fields also appear in the admin wallet views (§6.4).

### 4.3 User dashboard — `GET /api/admin/dashboard/user/:userId` (existing endpoint, new keys)
The user's existing dashboard call now also returns the payout block, so the home screen can show
it without a second request. All values are **paise** unless the key ends in `Count`:

| key | meaning |
|---|---|
| `payoutWalletBalance` / `payoutWalletHold` / `payoutWalletAvailable` | same as §4.1 (`available = balance − hold`) |
| `payoutWalletTotalCredited` | lifetime money added to the wallet (wallet withdrawals + admin credits) |
| `payoutWalletTotalAdminDebit` | lifetime admin debits |
| `payoutWalletTotalReverted` | lifetime amount admin moved back to the user's QR codes |
| `customerPayoutPendingCount` / `customerPayoutPendingAmount` | requests awaiting admin (amount excludes commission; the hold is amount + commission) |
| `customerPayoutPaidCount` / `customerPayoutPaidAmount` | requests paid |
| `customerPayoutCommissionPaid` | payout commission the user has paid so far |
| `customerPayoutRejectedCount` | requests rejected (user can re-request) |

Suggested tiles under the existing QR/withdrawal tiles: "Payout wallet available" (tap → §4 screen),
"Customer payouts pending (n · ₹)", "Customer payouts paid (n · ₹)", "Payout commission paid".
Same authorization as before: the user themself, their subadmin, admin, or employee.

The wallet response also carries `access` (same object as §4.1a) so one call drives both the card
and the "New payout" button.

### 4.1a Status: switched on? limits? usage? — `GET /api/payout/status`
Call it when the payout screens open and on app resume; admins change these without notice.
```jsonc
{ "success": true,
  "enabled": false,             // may this user create a request right now?
  "platformEnabled": false,     // false = paused for everyone
  "userEnabled": true,          // false = paused for this user only
  "message": "Bank maintenance till 6 PM",  // null when enabled; show verbatim when disabled
  "limits": {                   // effective for THIS user; 0 = no limit
    "maxPerRequestPaise": 50000, "dailyLimitPaise": 500000, "maxPending": 2 },
  "modes": { "NEFT": true, "IMPS": true, "RTGS": false, "UPI": true },   // false = admin switched it off (§6.5a)
  "usage": {                    // today = IST calendar day; pending/paid requests count, rejected/cancelled do not
    "usedTodayPaise": 120000, "requestedTodayCount": 3, "pendingCount": 1 },
  "preferences": { "realtime": true },     // this user's own opt-in to live socket updates (§9)
  "realtimeEnabled": true,                 // platform switch for live updates
  "requireVerifiedAccount": false          // when true, only accounts with verificationStatus "verified" can receive payouts (§5.6)
}
```
UI rules:
- `enabled == false` → disable "New payout", show `message` in a banner above the requests list.
  `POST /requests` while disabled returns `403 { error: <same message> }` — treat as a refresh trigger.
- **Modes** — render the NEFT / IMPS / RTGS / UPI selector from `modes`: a `false` mode stays visible
  but disabled with a "Not available right now" hint, and can never be pre-selected (if the account's
  last-used mode is off, fall back to the first enabled one). Sending a disabled mode returns
  `400 <MODE> payouts are not available right now. Please choose another mode.` — refresh `/status`.
  Existing pending requests in a mode that was later switched off are unaffected (admin can still
  pay them).
- **Limits — `0` means no limit, for every parameter.** Show the non-zero ones on the New Payout form
  ("Max ₹500 per payout · ₹1,200 left today · 1 of 2 pending"). Pre-validate the amount against
  `maxPerRequestPaise` and `dailyLimitPaise − usedTodayPaise`; the server re-checks and answers
  `400` with a precise message (`Amount exceeds your per-payout limit of ₹500.00`, `You already have
  the maximum number of pending customer payouts (2)`, `This payout would exceed your daily limit of
  ₹1200.00 (used ₹1000.00 today)`) — show it verbatim.

### 4.2 `GET /api/payout/wallet/transactions?limit&cursor&type&from&to`
`type` optional: `withdrawal_credit` | `payout_paid` | `admin_credit` | `admin_debit` | `revert_to_qr`.
```jsonc
{
  "success": true, "total": 12, "nextCursor": "abc…" | null,
  "transactions": [{
    "$id": "…", "id": "pwt_1725600000000123", "userId": "u1",
    "type": "payout_paid", "direction": "debit",
    "amountPaise": 100000, "commissionPaise": 3000, "totalPaise": 103000,
    "amountRs": 1000, "totalRs": 1030,
    "balanceAfterPaise": 397000, "holdAfterPaise": 0,
    "refType": "customer_payout", "refId": "cpo_1725600000000456",
    "referenceNumber": "UTR12345", "notes": "IMPS payout to Ravi Kumar (12345678901)",
    "createdBy": "adminId" | null, "createdAt": "…"
  }]
}
```
Rendering rules per `type`:

| type | direction | title | detail |
|---|---|---|---|
| `withdrawal_credit` | credit | "Added from QR withdrawal" | `refId` = withdrawal id |
| `payout_paid` | debit | "Customer payout paid" | show `amountRs` + `commissionPaise/100` as "incl. ₹x commission"; `referenceNumber` |
| `admin_credit` | credit | "Adjustment by admin" | `notes`, `referenceNumber` |
| `admin_debit` | debit | "Adjustment by admin" | `notes`, `referenceNumber` |
| `revert_to_qr` | debit | "Returned to QR" | `referenceNumber` = the original withdrawal id, `notes` = "Reverted to QR … : <admin note>". Tell the user the money is back on that QR and can be withdrawn normally |

`totalPaise` is what moved the balance; `balanceAfterPaise` is the running balance — use it for a
statement-style list. Holds (pending requests) do **not** create rows; they are visible through the
pending requests list and `holdPaise`.

---

## 5. User — Customer Payout

### 5.1 Saved customer accounts
`GET /api/payout/accounts?search=&limit&cursor` — own accounts, newest first.
`search`: digits ⇒ account-number prefix match; text ⇒ customer-name search. Use it for the
"select existing account" picker with a search box.
```jsonc
{ "success": true, "total": 3, "nextCursor": null,
  "accounts": [{
    "$id": "acc_docid", "userId": "u1",
    "customerName": "Ravi Kumar", "bankName": "SBI", "ifscCode": "SBIN0001234", "accountNumber": "12345678901",
    "upiId": "ravi@okaxis" | null,
    "bankingStatus": "not_added" | "added",
    "notes": null, "createdAt": "…", "bankingStatusUpdatedAt": null, "bankingStatusUpdatedBy": null,
    // per-customer stats (paise / counts) — maintained by the server
    "requestCount": 5, "paidCount": 4, "rejectedCount": 1, "pendingCount": 0,
    "totalPaidPaise": 450000, "totalPaidRs": 4500, "totalCommissionPaise": 13500,
    "lastRequestedAt": "…" | null, "lastPaidAt": "…" | null
  }] }
```
Show the stats on the account card ("Paid 4 times · ₹4,500 total · last paid 2 Sep"). Tapping a card
opens the history: `GET /api/payout/accounts/:accountId/payouts` → `{ success, account, total,
payouts, nextCursor }` — the account (with stats) plus every request to that customer, newest first,
paginated with `limit`/`cursor`; accepts the row filters of §5.4 (`status`, `mode`, `sort`,
`from`/`to`, …). 404 if not yours.

`POST /api/payout/accounts` — add a customer account without requesting a payout yet.
```jsonc
{ "customerName": "Ravi Kumar", "bankName": "SBI", "ifscCode": "SBIN0001234",
  "accountNumber": "12345678901", "confirmAccountNumber": "12345678901",
  "upiId": "ravi@okaxis",          // optional; required later for UPI-mode payouts
  "notes": "optional" }
```
`201 { success, created: true, account }`; `200 { success, created: false, account }` if the same
account number already exists for this user (it is reused, never duplicated — but a missing `upiId`
is filled in if you send one).
Validation (400 with message): name 2–100 chars; bank 2–100; IFSC `AAAA0XXXXXX`; account number
8–18 digits; `accountNumber !== confirmAccountNumber` → `Account numbers do not match`; `upiId`
must look like `handle@provider` → `Invalid UPI ID format…`.
Client-side: uppercase the IFSC, digits-only keyboard for account number, paste-blocked confirm field.

`DELETE /api/payout/accounts/:accountId` — remove a saved account (`:accountId` = its `$id`).
`200 { success, message }`. `404` if it is not yours; `409 Account has a pending payout request` —
resolve/cancel that first. Paid/rejected history keeps its own snapshot of the bank details, so
deleting never alters old requests.

### 5.2 `GET /api/payout/commission-preview?amount=1000` — call on amount change (debounced)
```jsonc
{ "success": true,
  "amountPaise": 100000, "commissionPaise": 3000, "totalPaise": 103000, "commissionRate": 3,
  "amountRs": 1000, "commissionRs": 30, "totalRs": 1030,
  "availablePaise": 397000, "sufficient": true }
```
Show: "Payout ₹1000.00 · Commission (3%) ₹30.00 · Total deducted ₹1030.00". Disable submit when
`sufficient == false`. `422` ⇒ commission rate misconfigured — show the message, contact support.

### 5.3 `POST /api/payout/requests` — create a customer payout
Either pick a saved account **or** enter a new one (it is saved automatically):
```jsonc
// A) existing account
{ "accountId": "acc_docid", "mode": "IMPS", "amount": 1000, "notes": "Order #4521" }

// A') existing account that has no UPI ID yet, UPI payout — send the VPA, it is saved on the account
{ "accountId": "acc_docid", "upiId": "ravi@okaxis", "mode": "UPI", "amount": 1000 }

// B) new account (all five bank fields required; upiId required only when mode is UPI)
{ "customerName": "Ravi Kumar", "bankName": "SBI", "ifscCode": "SBIN0001234",
  "accountNumber": "12345678901", "confirmAccountNumber": "12345678901",
  "upiId": "ravi@okaxis",
  "mode": "UPI", "amount": 1000, "notes": "optional, ≤500 chars" }
```
`mode` ∈ `NEFT | IMPS | RTGS | UPI` (case-insensitive; stored uppercase).

**Mode selector rules (mandatory):** fetch `GET /status` when the New Payout form opens and build
the selector from its `modes` map. A mode whose value is `false` must be rendered **greyed out and
not selectable** (visible, disabled, with a "Not available right now" label or tooltip) — never
hidden, so the user understands it exists but is off, and never submittable. Default the selection
to the first `true` mode; if the account's last-used mode is `false`, do not pre-select it. Re-fetch
`/status` on app resume; if the currently selected mode has become `false`, clear the selection and
show the label. Should a stale form still submit a disabled mode, the server answers
`400 <MODE> payouts are not available right now. Please choose another mode.` — show it and rebuild
the selector from a fresh `/status`.

Choosing **UPI** with an account that has no `upiId` (and none in the body) →
`400 UPI ID is required for a UPI payout` — show the UPI ID field whenever mode is UPI and prefill it
from the selected account.
Response `201`:
```jsonc
{ "success": true, "payout": {
    "$id": "…", "id": "cpo_1725600000000456", "userId": "u1", "accountId": "acc_docid",
    "customerName": "Ravi Kumar", "bankName": "SBI", "ifscCode": "SBIN0001234", "accountNumber": "12345678901",
    "upiId": "ravi@okaxis" | null,
    "mode": "IMPS",
    "amountPaise": 100000, "commissionPaise": 3000, "totalPaise": 103000,
    "amountRs": 1000, "commissionRs": 30, "totalRs": 1030, "commissionRate": 3,
    "notes": "Order #4521", "status": "pending",
    "referenceNumber": null, "rejectionReason": null,
    "createdAt": "…", "processedAt": null, "processedBy": null,
    "accountBankingStatus": "not_added",

    // Service timeline (UTC ISO) — see §5.5
    "requestedAt": "2026-09-06T10:00:00.000Z",
    "addedToBankingAt": null,      // set when admin tags the account `added` (or inherited if already added)
    "paidAt": null,
    "rejectedAt": null,
    "addedInMinutes": null,        // whole minutes requestedAt → addedToBankingAt (null until stamped)
    "paidInMinutes": null,         // requestedAt → paidAt
    "rejectedInMinutes": null,     // requestedAt → rejectedAt
    "cancelledInMinutes": null,    // requestedAt → cancelledAt
    "waitingMinutes": 0            // PENDING ONLY: minutes waited so far, by the SERVER clock; null once resolved
} }
```
Every list response also carries `"serverTime": "<ISO>"` (the moment the page was produced).
Effects: `holdPaise += totalPaise` immediately (refresh the wallet card). Errors:
`400` validation · `404` accountId not yours · `409 Insufficient payout wallet balance` ·
`409 Payout wallet is busy…` (retry once) · `422` rate misconfigured.

### 5.4 `GET /api/payout/requests?status&from&to&limit&cursor` — own requests, newest first
`status` optional: `pending | paid | rejected`. Also accepts `mode`, `search` (+`searchField`),
`minAmount`/`maxAmount` (rupees), `bankingStatus`, `accountId`, `sort`/`order` — same semantics as
the admin queue table in §6.1. Rows have the shape above. Per status show:
- **pending** — "Awaiting admin", amount, total on hold, `accountBankingStatus` chip.
- **paid** — green, `referenceNumber` (copyable), `processedAt`.
- **rejected** — red, `rejectionReason` prominently, `processedAt`, a **"Request again"** button that
  opens the form pre-filled from this row (`accountId`, `mode`, `amountRs`, `notes`).

### 5.4 (cont.) Cancel your own pending request — `POST /api/payout/requests/:id/cancel`
No body. Only the owner, only while `status == "pending"`. The hold is released (balance untouched,
no ledger row, no commission), the row becomes `status: "cancelled"` with `cancelledAt` /
`cancelledInMinutes`, and it can never be paid afterwards. `400` if not pending, `404` if not yours,
`409` if admin resolved it at the same moment (refresh). Show a "Cancel request" action on pending
rows with a confirmation; add a **Cancelled** tab/filter (`?status=cancelled`) — grey, "Cancelled by
you", with "Request again". Admin queue rows show cancelled requests the same way.

### 5.4a Unique request id + lookup
Every customer payout has a **unique, permanent id** `id` (format `cpo_<digits>`, e.g.
`cpo_1725600000000456`) — distinct from the Appwrite `$id`. Show it on every row/detail with a copy
button; it is what users quote to support and what admin types to find a request.

- Search in any list: `?search=cpo_1725600000000456&searchField=id`.
- Direct lookup (deep links, notifications, "open request"):
  - user: `GET /api/payout/requests/:id` → `{ success, payout }` — own requests only, `404` otherwise.
  - admin/subadmin: `GET /api/payout/admin/requests/:id` → `{ success, payout }` — subadmins get
    `404` for requests of users that are not theirs. `400` if the id is malformed.
  Both return the same row shape as the lists (with the live `accountBankingStatus`).

### 5.5 Service timeline on every request row
Every payout row carries four timestamps and three server-computed durations so the user can see
how fast they were served. **Never compute the minutes on the device** — use the `*InMinutes`
fields (whole minutes, clamped at 0, `null` when that step has not happened).

| step | timestamp | duration (from `requestedAt`) | shown as |
|---|---|---|---|
| Requested | `requestedAt` | — | "Requested 10:00 AM" |
| Account added in banking | `addedToBankingAt` | `addedInMinutes` | "Added to banking in 12 min" · while `null`: "Waiting for account to be added" (only if `accountBankingStatus == "not_added"`) |
| Paid | `paidAt` | `paidInMinutes` | "Paid in 31 min" (green) |
| Rejected | `rejectedAt` | `rejectedInMinutes` | "Rejected after 5 min" (red) |
| Cancelled (by the user) | `cancelledAt` | `cancelledInMinutes` | "Cancelled after 2 min" (grey) |

### 5.6 Beneficiary verification (set by staff, shown to the user)
Every saved account carries `verificationStatus`: `unverified` (default) · `verified` ·
`name_mismatch` · `failed`, plus `verifiedName` (the name the bank returned), `verifiedAt`,
`verifiedBy`, `verificationNote`. Show it as a chip on account cards and on each request row
(`accountVerificationStatus`, live value). When `GET /status` says `requireVerifiedAccount == true`,
only `verified` accounts can be paid to — grey out the others in the picker and explain
("Waiting for verification"); the server answers `400 This customer account is not verified yet…`.
Both account lists accept `?verificationStatus=…`; the request lists too.

Notes:
- If the customer account was **already** `added` when the request was made, `addedToBankingAt`
  is the account's tag time (which may be earlier than the request) and `addedInMinutes` is `0` —
  show "Account already added".
- `processedAt` still exists and equals `paidAt` or `rejectedAt`; prefer the specific field.
- A pending row gets `addedToBankingAt` filled in the moment admin taps "Mark added" (§6.3) —
  refresh the list after that action. Render the timeline as a vertical stepper: Requested →
  Added to banking → Paid/Rejected, each with its local time and the minutes badge.
- For long waits show hours: `m >= 60 ? '${m ~/ 60} h ${m % 60} min' : '$m min'`.

---

## 6. Admin (and subadmin read-only)

Labels: employees need `view_payouts` for the lists and `edit_payouts` for actions
(`paid`, `reject`, `banking-status`, `adjust`, `retry-credit`, `delete`). Admin role needs nothing.
**Subadmins** can call every `GET` in this section; results are automatically limited to their own
users (+ themselves) and `?userId=` of anyone else returns `403`. Give subadmins a read-only version
of the queue/wallet screens (no action buttons) so they can see their users' payout requests, the
commission each request paid (`commissionPaise`), and their own payout-commission earnings (§6.5).

### 6.1 Customer payout queue — `GET /api/payout/admin/requests?…`
Same row shape as §5.3 plus every row carries `userId`. Default view: `status=pending`, oldest at the
bottom (server returns newest first). All filters combine (AND). Build a filter sheet with these:

| query param | values | notes |
|---|---|---|
| `status` | `pending` `paid` `rejected` | tabs |
| `userId` | user id | one user |
| `subadminId` | subadmin id | that subadmin's users **and** the subadmin themself. Subadmins may only pass their own id (else 403) |
| `qrId` | QR code id | the user the QR is assigned to. Unknown QR → empty list. Combines with the two above by intersection |
| `mode` | `NEFT` `IMPS` `RTGS` `UPI` | case-insensitive |
| `bankingStatus` | `added` `not_added` | the beneficiary account's **current** tag — use `not_added` as the "to be added in banking" worklist |
| `accountId` | account `$id` | all requests for one saved account |
| `processedBy` | admin/employee user id | who marked it paid/rejected |
| `search` (+ `searchField`) | text | `searchField` ∈ `customerName` (default; word search), `accountNumber` (prefix), `upiId`, `referenceNumber`, `id` (exact). Digits-only `search` without a field = account-number prefix |
| `paidVia` | text (exact) | admin / labelled employee only — which of our accounts paid it; silently ignored for subadmins |
| `minAmount` / `maxAmount` | **rupees** | on the payout amount (excl. commission) |
| `from` / `to` | `YYYY-MM-DD` (IST) | on request time |
| `sort` / `order` | `createdAt` (default) `processedAt` `amount` / `desc` (default) `asc` | `processedAt` sorts pending rows last |
| `limit` / `cursor` | | pagination as in §2 |

Bad values return `400 { error }` (e.g. `Invalid mode`, `Invalid searchField`, `maxAmount must be >=
minAmount`). The same row filters (everything except `userId` / `subadminId` / `qrId`) also work on the
user's own list `GET /api/payout/requests` (§5.4), so the user can search their history too.
`GET /admin/accounts` and `GET /admin/wallets` accept `subadminId` as well. Show the **`accountBankingStatus`** chip; when it is
`not_added` show an inline **"Mark added"** action (§6.3) — the admin adds the beneficiary in the bank
portal first, tags it, then pays. For `mode: "UPI"` rows show `upiId` as the payee instead of the
account number.

### 6.2 Resolve
`POST /api/payout/admin/requests/:id/paid` — `:id` is the business id `cpo_…`.
```jsonc
{ "referenceNumber": "UTR1234567890",        // required, 5–100 chars — the bank/payout reference (the user sees this)
  "paidVia": "HDFC current a/c ****4321" }   // ≤100 chars — which of OUR accounts paid it. STAFF-ONLY.
```
`paidVia` is optional on the server, but **make it a required field in the Paid dialog** — it is the
internal record of the source account. Build the field as a **type-to-search dropdown backed by the
source-account list (§6.2a)**: as the admin types, call `GET /admin/source-accounts?search=<text>`
and offer matches; picking one fills the field; typing a new value is allowed and is saved to the
list automatically the moment the payout is marked paid.

#### 6.2a Source accounts (the "paid via" list) — staff
`GET /api/payout/admin/source-accounts?search&sort&includeInactive&limit&cursor`
→ `{ success, total, sourceAccounts: [{ $id, label, useCount, totalPaidPaise, totalPaidRs, lastUsedAt, addedBy, createdAt, active }], nextCursor }`
- `search` = prefix match on the label (case-insensitive); `sort` ∈ `useCount` (default, most used
  first) `lastUsedAt` `totalPaid` `label`; `includeInactive=true` shows deactivated ones.
- `useCount` / `totalPaidPaise` are bumped every time a payout is marked paid with that label, so the
  list doubles as "how much went out of each of our accounts".
- `POST /api/payout/admin/source-accounts { "label": "HDFC current ****4321" }` → `201 { success, created: true, sourceAccount }`
  (`200 created: false` if it already exists; re-adding a deactivated label reactivates it).
- `DELETE /api/payout/admin/source-accounts/:id` (admin role only) → deactivates; history keeps the text.
- Subadmins get 403 on all of these (the list is staff-only, like `paidVia`).
`200 { success, message: "Payout marked as paid", payout }`. Effects: wallet `balance −= total`,
`hold −= total`, ledger row `payout_paid`, payout commission recorded for admin/subadmin.

**Visibility of `paidVia`:** it is returned only to role `admin` and labelled employees (on the queue,
the single-request lookup, the account history, and the paid response). **Users and subadmins never
receive the key at all** — do not render a "Paid via" row from a missing key, and never copy it into
anything the user can see.
Errors: `400` short reference / not pending (`Cannot mark a paid request as paid`) ·
`409 Request was already resolved` (someone else won — refresh) · `409` wallet busy (retry).

`POST /api/payout/admin/requests/:id/reject`
```jsonc
{ "reason": "IFSC does not match the bank" }   // required, 4–500 chars; the user sees this text
```
`200 { success, message: "Payout rejected", payout }`. Effect: hold released, no money moves.

Both are exactly-once on the server; a double tap returns 400/409, never a double debit.

### 6.3 Customer accounts — all customers, how much we paid each
`GET /api/payout/admin/accounts?…` lists **every** saved customer account (admin) or the caller's
users' accounts (subadmin). Rows have the §5.1 shape including the stats block. Filters (AND):

| query param | values | notes |
|---|---|---|
| `userId` / `subadminId` | ids | per user, or per subadmin (their users + themself) |
| `search` | text | digits → account-number prefix, otherwise customer-name word search |
| `bankingStatus` | `added` `not_added` | `not_added` = the "to be added in banking" worklist |
| `minTotalPaid` | **rupees** | only customers we have paid at least this much |
| `from` / `to` | `YYYY-MM-DD` (IST) | account creation date |
| `sort` / `order` | `createdAt` (default) `totalPaid` `paidCount` `requestCount` `lastPaidAt` / `desc` (default) `asc` | e.g. `sort=totalPaid` = biggest payees first |
| `limit` / `cursor` | | pagination |

Suggested list row: name · bank/account (or UPI) · owner user · `bankingStatus` chip ·
"Paid n × ₹total" · last paid. Tapping opens the detail:

`GET /api/payout/admin/accounts/:accountId/payouts?status&mode&sort&order&from&to&limit&cursor`
→ `{ success, account, total, payouts, nextCursor }`: the account with stats plus the full list of
requests to that customer (each with its timeline, reference number and status). Default sort newest
first; `status=paid` gives "everything we paid to this customer". Subadmins get 403 for accounts of
users that are not theirs.

`POST /api/payout/admin/accounts/:accountId/recompute-stats` (admin / `edit_payouts`) → rebuilds the
stats block from the request rows and returns `{ success, account }`. Only needed if a stats figure
ever looks wrong (the server logs when a stats update fails); safe to call any time.

`PATCH /api/payout/admin/accounts/:accountId/verification` (admin / `edit_payouts`, within scope)
```jsonc
{ "status": "verified",                 // unverified | verified | name_mismatch | failed
  "verifiedName": "RAVI KUMAR",         // optional, what the bank returned
  "note": "Penny drop OK 06-Sep" }      // optional ≤300
```
→ `{ success, account }`. Setting `unverified` clears `verifiedAt`/`verifiedBy`. Put a "Verify…" dialog
on the account detail with the four statuses; the user sees the resulting chip (§5.6).
`PATCH /api/payout/admin/accounts/:accountId/banking-status`
```jsonc
{ "bankingStatus": "added" }        // or "not_added" to revert
```
`200 { success, account, stampedRequests }` (`bankingStatusUpdatedAt/By` filled). `:accountId` is
the account's `$id`. `stampedRequests` = how many of this account's **pending** requests just got
their `addedToBankingAt` set (their "Added to banking in X min" badge starts showing) — refresh the
queue after tagging.

`DELETE /api/payout/admin/accounts/:accountId` — delete any user's account. `409` while a pending
request references it.

### 6.4 Wallets
`GET /api/payout/admin/wallets` → `{ success, total, wallets: [walletView…], nextCursor }`
`GET /api/payout/admin/wallets?userId=u1` → `{ success, wallet }` (zeros if none).
`GET /api/payout/admin/wallet/transactions?userId=u1&type&from&to&limit&cursor` → same as §4.2.

`POST /api/payout/admin/wallet/adjust` — manual credit/debit
```jsonc
{ "userId": "u1", "direction": "credit" | "debit", "amount": 250.50,
  "notes": "Customer paid outside platform",          // required, 3–500 chars
  "referenceNumber": "CASH-0906-01",                   // optional, ≤100
  "refId": "3f9e…-uuid" }                              // optional client idempotency key — send one!
```
`200 { success, duplicate: false, wallet, transaction }`. `duplicate: true` means this `refId` was
already applied (nothing changed). Debit below available → `409 Insufficient payout wallet balance`.
Show a confirmation dialog with the resulting available balance before sending.

**"Revert to QR" from the wallet screen** (admin role only). On the per-user wallet drill-down add a
**Revert to QR…** button. It opens a sheet fed by:

`GET /api/payout/admin/wallet/revertable?userId=u1&onlyRevertable=true&limit&cursor`
```jsonc
{ "success": true, "userId": "u1",
  "wallet": { …walletView… },                 // availablePaise = the most that can leave the wallet right now
  "withdrawals": [{
      "withdrawalId": "wdh_…", "qrId": "QR123", "requestedAt": "…", "approvedAt": "…",
      "creditedPaise": 50000, "revertedPaise": 20000, "revertablePaise": 30000, "creditedRs": 500,
      "revertablePaise_capped": 20000,       // min(revertablePaise, wallet available) — the max for THIS row right now
      "walletCreditFailed": false }],
  "pageTotalRevertablePaise": 30000,
  "maxSingleRevertPaise": 20000,             // = wallet available; money held by pending payouts cannot be reverted
  "nextCursor": null }
```
Sheet layout: one row per wallet withdrawal ("QR123 · credited ₹500 · reverted ₹200 · revertable
₹300"), a selected row, an amount field pre-filled with `revertablePaise_capped` and capped at it,
a "Revert all" shortcut (sends no `amount`), the **required note**, then a confirmation showing
amount → QR id. Submit with `POST …/revert-to-qr` below, then refresh the wallet card, history and
this list. `onlyRevertable=false` also lists fully reverted withdrawals (greyed). If
`maxSingleRevertPaise` is 0, explain "all wallet money is held by pending customer payouts".

`POST /api/payout/admin/wallet/revert-to-qr` — **admin role only.** Moves payout-wallet money back to
the QR it was withdrawn from, so the user can request a normal (direct) withdrawal instead.
```jsonc
{ "withdrawalId": "wdh_…",      // the approved mode:'wallet' withdrawal that funded the wallet
  "amount": 250.50,              // rupees, OPTIONAL — omit to revert everything still revertable from it
  "notes": "Payout service withdrawn, returning funds",   // REQUIRED, min 3 chars — shown in the user's wallet history
  "refId": "uuid" }              // client idempotency key — send one
```
`200`:
```jsonc
{ "success": true, "duplicate": false, "withdrawalId": "wdh_…", "qrId": "QR123", "userId": "u1",
  "amountPaise": 25050, "remainingPaise": 24950,     // still revertable from this withdrawal
  "qrAvailablePaise": 188500,                        // the QR's available balance after the credit-back
  "wallet": { …walletView… }, "transaction": { …type "revert_to_qr"… } }
```
Rules the UI must respect:
- Pick the withdrawal from the user's wallet-mode withdrawals (`mode: "wallet"`, `status: "approved"`);
  each row now carries `walletRevertedPaise` — show "revertable = preAmount − reverted".
- **Partial reverts are supported**: send `amount` (rupees) for part of it, or omit it to revert the
  rest. Offer a "Revert all (₹X)" button plus an amount field capped at the revertable balance. Every
  partial revert is its own ledger row (`type: "revert_to_qr"`, `referenceNumber` = withdrawal id,
  `notes` = your note, `createdBy` = you) and the withdrawal's `walletRevertedPaise` accumulates —
  the user's wallet history and `GET /admin/wallet/transactions?userId=…&type=revert_to_qr` list
  every revert with time, amount and note.
- Money that is **held by pending customer payouts cannot be reverted** (`409 Insufficient payout
  wallet balance`) — resolve or reject those requests first.
- `409 Amount exceeds…` / `409 Nothing left to revert…` — refresh the row. `409 QR is currently being
  processed…` — retry once. `403` for anyone who is not role admin.
- Show a confirmation with: amount, the QR it goes back to, and the note. The user sees the note.
- Effects: wallet balance −amount (ledger row `revert_to_qr`), QR available +amount, the wallet
  withdrawal keeps status `approved` but `walletRevertedPaise` grows; dashboard "wallet funded" and
  "total paid" both decrease by the amount.

`GET /api/payout/admin/wallet/export?userId=u1&from=2026-09-01&to=2026-09-30` — **admin role only.**
Returns a CSV file (`Content-Type: text/csv`, `Content-Disposition: attachment; filename="payout-wallet-<userId>-<from>-<to>.csv"`)
of that user's wallet ledger rows in the IST date range, oldest first. Columns:
`createdAt,id,type,direction,amountRs,commissionRs,totalRs,balanceAfterRs,holdAfterRs,refType,refId,referenceNumber,notes,createdBy`
(amounts in **rupees** here, since it is a human statement). Headers `X-Row-Count` and, if the range
exceeded 5,000 rows, `X-Truncated: true` (narrow the dates). `400` if `userId`, `from` or `to` is
missing. Use the platform share/save-file flow; the response is a plain download.

`POST /api/payout/admin/wallet/retry-credit` — `{ "withdrawalId": "wdh_…" }` → re-runs the wallet
credit for an approved `mode:'wallet'` withdrawal (safe to call repeatedly; `skipped: true` means it was
already credited). Surface it on withdrawal rows with `walletCreditFailed == true`.

### 6.5 Payout commission (separate from withdrawal commission)
`GET /api/payout/admin/commissions?userId&earningType&sourcePayoutId&from&to&limit(≤50)&cursor`
→ `{ commissions: [{ $id, id, userId, sourcePayoutId, amount /*paise*/, commissionRate, earningType: "admin"|"subadmin", createdAt }], nextCursor }`.
Subadmins may call it (label `view_payout_commissions` is subadmin-allowed) and always get only
their own rows.

`GET /api/payout/admin/commissions/summary?from=2026-09-01&to=2026-09-06&userId=` (defaults: today)
```jsonc
{ "success": true, "range": { "from": "2026-09-01", "to": "2026-09-06" }, "userId": null,
  "totalPaise": 45000, "totalRs": 450,
  "days": [{ "date": "2026-09-01", "commissionPaise": 3000 }, …],
  "perUser": { "adminId": 30000, "subadminId": 15000 } }
```
Max range 366 days. Same split rule as withdrawals: the user's own rate goes to their subadmin (parent),
the parent's rate goes to admin; users without a parent pay everything to admin.

`GET /api/payout/admin/commissions/monthly?month=2026-09&userId=&limit&cursor` (month defaults to the
current IST month) and `GET /api/payout/admin/commissions/all-time?userId=&limit&cursor`:
```jsonc
{ "success": true, "month": "2026-09" | null, "userId": null,
  "grandTotalPaise": 45000,                       // sum of the rows on this page
  "totals": [{ "$id": "…", "userId": "adminId", "month": "2026-09" | null, "totalCommissionPaise": 30000, "totalRs": 300 }, …],
  "nextCursor": null }
```
Rows are sorted highest earner first. Subadmins always get just their own row. Use these for the
"This month" / "All time" tiles; use `summary` for the per-day chart.

### 6.5a Settings — pause switches, limits, alerts, realtime, verification (admin role only)
`GET /api/payout/admin/settings`
```jsonc
{ "success": true,
  "customerPayouts": { "enabled": true, "message": "Customer payouts are temporarily disabled…" },
  "modes": { "NEFT": true, "IMPS": true, "RTGS": false, "UPI": true },   // per-mode availability
  "realtimeEnabled": true,
  "requireVerifiedAccount": false,
  "alerts": { "enabled": false, "lowBalanceThresholdPaise": 0, "pendingAlertMinutes": 0 },
  "limits":  { "maxPerRequestPaise": 0, "dailyLimitPaise": 0, "maxPending": 0 } }   // platform defaults; 0 = no limit
```
`PATCH /api/payout/admin/settings` — send only the fields you change; amounts in **rupees**:
```jsonc
{ "enabled": false, "message": "Bank maintenance till 6 PM",   // pause everyone (message ≤200 shown to users)
  "modes": { "RTGS": false },                                   // partial: only the modes you send change; keys NEFT/IMPS/RTGS/UPI, boolean
  "realtimeEnabled": true,                                      // live socket updates on/off for the whole platform
  "requireVerifiedAccount": false,                              // only verified beneficiaries may be paid
  "alertsEnabled": true, "lowBalanceThreshold": 500, "pendingAlertMinutes": 60,   // §6.8; 0 = that alert off
  "maxPerRequest": 1000, "dailyLimit": 0, "maxPending": 2 }     // platform limits; 0 = no limit
```
→ the same shape as GET. `400` on a wrong type or a negative number. Build a settings screen with
toggles and number fields; label every numeric field "0 = no limit". Add a "Payout modes" row with
four switches (NEFT / IMPS / RTGS / UPI) bound to `modes`; switching one off hides nothing for admin
but greys the mode out for users and subadmins (§4.1a). Switching all four off is allowed and
behaves like a pause with a per-mode message.

**Per-user limits** (override the platform values):
`GET /api/payout/admin/users/:userId/payout-limits` → `{ success, userId, userValues, effective, platform, usage }`
`PATCH /api/payout/admin/users/:userId/payout-limits`
```jsonc
{ "maxPerRequest": 250.5, "dailyLimit": null, "maxPending": 0 }   // rupees / count. null = inherit platform, 0 = no limit for this user
```
→ `{ success, userId, userValues: { maxPerRequestPaise, dailyLimitPaise, maxPending }, effective }`.
Show three fields on the user detail, each with an "inherit" state (null) and the note "0 = no limit".

**Pause one user** (`PATCH …/payout-access`, below) and **per-user limits** are both admin-role only.
`PATCH /api/payout/admin/users/:userId/payout-access`
```jsonc
{ "enabled": false, "reason": "KYC pending" }    // reason optional (≤200); { "enabled": true } re-enables
```
→ `{ success, userId, payoutDisabled, payoutDisabledReason }`. The user lists (`GET /api/admin/users`
etc.) now include `payoutDisabled` and `payoutDisabledReason` — show a "Payouts paused" chip and a
toggle in the user detail. Both switches return `403` for labelled employees; only role `admin` may
pause. Pausing never touches money or existing requests — admin can still pay/reject the queue.

### 6.5b Daily time series — `GET /api/payout/admin/stats/daily?from&to&userId&subadminId`
Scoped like the queue (subadmins/employees see their users). Defaults to today; max 366 days.
```jsonc
{ "success": true, "range": { "from": "2026-09-01", "to": "2026-09-07" },
  "days": [{ "date": "2026-09-02",
             "requestedCount": 3, "requestedAmountPaise": 129000,     // by request time
             "paidCount": 2, "paidAmountPaise": 109000, "paidCommissionPaise": 301, "avgPaidInMinutes": 18,  // by paid time
             "rejectedCount": 0, "cancelledCount": 0 }, …],           // by resolution time
  "totals": { "requestedCount": …, "requestedAmountPaise": …, "paidCount": …, "paidAmountPaise": …, "paidCommissionPaise": …, "rejectedCount": …, "cancelledCount": … },
  "truncated": false }   // true = more than 10,000 rows in range were skipped; narrow the range
```
Chart ideas: paid amount per day (bars), avg minutes to pay (line), requested vs paid counts.

### 6.5c Alerts — `GET /api/payout/admin/alerts?userId&subadminId` (admin toggles in §6.5a)
```jsonc
{ "success": true, "enabled": true, "thresholds": { "lowBalancePaise": 50000, "pendingMinutes": 60 },
  "lowBalance":   [{ "userId": "u1", "availablePaise": 500, "balancePaise": 500, "holdPaise": 0 }],
  "stalePending": [{ "payoutId": "cpo_…", "userId": "u1", "amountPaise": 10000, "customerName": "Ravi", "requestedAt": "…", "waitingMinutes": 183 }],
  "counts": { "lowBalance": 1, "stalePending": 1 } }
```
Computed on demand (no background job) — poll it for a badge on the admin home, and list both
sections on an "Alerts" screen. When alerts are enabled and a low-balance threshold is set, the
server also pushes a realtime `payout:alert` (§9) the moment a wallet's available balance crosses
below the threshold (on a new request hold, an admin debit or a revert).

### 6.5d Ledger integrity check — `GET /api/payout/admin/integrity/...` (admin role only)
**Read-only.** It recomputes what every balance *should* be from the raw ledger and reports
differences. It never modifies data and never restricts a user — it is a report for humans.

`GET /api/payout/admin/integrity/wallets?limit=10&cursor=` — pages through wallets (≤ 25 per call,
each is a full check) and returns one summary per wallet:
```jsonc
{ "success": true, "checkedAt": "…",
  "reports": [{ "userId": "u1", "ok": true, "errors": 0, "warnings": 0, "truncated": false,
                "balancePaise": 39700, "holdPaise": 10300, "driftPaise": 0, "issueCodes": [] }, …],
  "summary": { "wallets": 10, "withErrors": 1, "withWarnings": 2 }, "nextCursor": "…" }
```
`GET /api/payout/admin/integrity/wallet/:userId` — the full report for one wallet:
```jsonc
{ "success": true, "report": {
    "userId": "u1", "checkedAt": "…", "ok": false, "errors": 2, "warnings": 1, "truncated": false,
    "wallet":  { …walletView… },
    "ledger":  { "rows": 12, "creditsPaise": 500000, "debitsPaise": 460300, "expectedBalancePaise": 39700, "expectedHoldPaise": 10300, "byTypePaise": { "withdrawal_credit": 500000, "payout_paid": 450000, … } },
    "counts":  { "payouts": 45, "pending": 1, "paid": 43, "walletWithdrawals": 5, "accounts": 6 },
    "issues":  [ { "severity": "error", "code": "BALANCE_MISMATCH", "message": "Wallet balance 40000 ≠ ledger credits − debits 39700 (drift 300)", "walletPaise": 40000, "ledgerPaise": 39700, "driftPaise": 300 }, … ] } }
```
Issue codes (severity in brackets): `BALANCE_MISMATCH` (E) wallet balance ≠ Σ ledger ·
`HOLD_MISMATCH` (E) hold ≠ Σ pending requests · `NEGATIVE_AVAILABLE` (E) ·
`LEDGER_CHAIN_BREAK` (E) a row's `balanceAfter` does not follow the running sum ·
`LEDGER_DUPLICATE_REF` (E) two rows for the same (type, refId) — a possible double credit/debit ·
`LEDGER_BAD_DIRECTION` / `LEDGER_BAD_AMOUNT` (E) · `WITHDRAWAL_NOT_CREDITED` (E, or W if already
flagged for retry) · `WITHDRAWAL_CREDIT_AMOUNT` (E) · `ORPHAN_CREDIT` / `ORPHAN_DEBIT` (E) ·
`PAID_NOT_DEBITED` / `PAID_AMOUNT_MISMATCH` / `DEBIT_ON_UNPAID` (E) · `REVERT_EXCEEDS_CREDIT` (E) ·
`REVERT_TRACKING` (W) · `LIFETIME_MISMATCH` (W) wallet lifetime totals ≠ ledger ·
`COMMISSION_MISMATCH` (W) commission rows ≠ request commission · `ACCOUNT_STATS_MISMATCH` (W, fix
with recompute-stats). Each issue carries the numbers it compared (`walletPaise`, `ledgerPaise`,
`driftPaise`, `rowId`, `payoutId`, `withdrawalId`, `accountId`, …) so the screen can show them.
UI: an "Integrity" screen listing wallets red/amber/green with drift, tap → the issue list grouped by
severity, with a "Re-check" button. `truncated: true` means the wallet has more than 5,000 rows in one
collection and the check stopped early — say so.

### 6.6 Dashboard tiles (existing endpoints, new keys)
`GET /api/admin/dashboard/counters` (admin) now also returns, all **paise** unless the name ends in `Count`:

| key | meaning |
|---|---|
| `totalPayoutWalletFunded` | QR balance moved into payout wallets via wallet withdrawals (this amount is also inside `totalAmountPaid`) |
| `totalPayoutWalletBalance` | current float sitting in all payout wallets (platform liability) |
| `totalCustomerPayoutPendingAmount` / `totalCustomerPayoutPendingCount` | customer payouts awaiting admin (amount excludes commission) |
| `totalCustomerPayoutPaid` / `totalCustomerPayoutPaidCount` | customer payouts marked PAID (amount excludes commission) |
| `totalPayoutAdminProfit` | payout commission earned by admin |
| `totalPayoutMerchantProfit` | payout commission earned by subadmins |

`GET /api/admin/dashboard/subadmin/:merchantId` now also returns `totalPayoutMerchantProfit` (paise) —
show it beside the existing `totalMerchantProfit` (withdrawal commission). Suggested tiles: "Payout
wallet float", "Customer payouts pending (n / ₹)", "Customer payouts paid (n / ₹)", "Payout commission".

### 6.7 Set a user's payout commission — `PUT /api/admin/edit-user/:id` (existing)
```jsonc
{ "payoutCommission": 2.5 }     // percent, 0–100; independent of "commission"
```
`GET /api/admin/users` (and the subadmin/employee lists) now return `payoutCommission` next to
`commission`. Add a second field in the Edit User form. **Default is 1.5 %**: a user with no value
set is charged 1.5 (and their subadmin's missing value also counts as 1.5), so the lists always show
the effective rate — never blank. Setting it to `0` explicitly means 0.

---

## 7. Suggested screens

**User and subadmin** (hide all of these for role `admin`)
1. *Withdraw* — destination toggle **Direct / Payout Wallet**; wallet mode hides bank fields and the
   commission line ("No commission for wallet transfers").
2. *Payout Wallet* — balance card (§4.1) + history list (§4.2) with type filter chips.
3. *Customer Payouts* — tabs Pending / Paid / Rejected (§5.4) + FAB "New payout".
4. *New payout* — step 1 pick account (search list, §5.1) or "Add new" (five fields + confirm,
   optional UPI ID); step 2 mode segmented control (NEFT/IMPS/RTGS/UPI built from `/status.modes` —
   **disabled modes greyed out and unselectable, never pre-selected**, see §5.3; selecting UPI reveals a
   required UPI ID field prefilled from the account), amount, notes, live preview (§5.2), submit.
5. *Customer accounts* — list with `bankingStatus` chips, UPI ID if present, paid count / total paid,
   tap → per-customer history (§5.1), swipe-to-delete (disabled/409-toast while a pending request
   exists).

**Admin**
1. *Withdrawals* — existing screen; wallet rows labelled "To Payout Wallet", approve without UTR.
2. *Customer payout queue* — pending list with account chip, "Mark added", "Paid…" (reference dialog),
   "Reject…" (reason dialog); Paid/Rejected tabs. Show "waiting N min" on pending rows so the oldest
   stand out: render the server's `waitingMinutes` and tick it forward locally using the elapsed
   time since the response's `serverTime` (never from the device's own idea of `requestedAt − now`,
   which drifts on wrong clocks). Re-fetch to resync; paid/rejected rows show the server's
   `paidInMinutes` / `rejectedInMinutes`. Only `requestedAt` is stored — waits are never persisted.
3. *Wallets* — list, per-user drill-down with history, "Adjust…" dialog, "Revert to QR…" sheet
   (§6.4), "Export statement" (date range), and the integrity badge.
3b. *Customer accounts* — all customers across users (§6.3) with the filter sheet (user, subadmin,
   search, tag, min paid, sort by total paid / paid count / last paid), tap → detail with stats and
   the list of payouts we made to that customer, "Mark added" and "Delete" actions.
4. *Payout commission* — "This month" / "All time" tiles (§6.5 monthly/all-time), summary chart by
   day, transactions list.
5. *Edit user* — add "Payout commission %".

**Subadmin** — the same queue, wallets, and commission screens in read-only mode (server scopes the
data; hide Paid/Reject/Adjust/Mark-added/Delete).

---

## 8. Edge cases to handle in the UI

- Wallet card should refresh after: withdrawal approval (admin), request create, paid/reject, adjust.
- `409 Payout wallet is busy…` — transient (a concurrent operation on the same wallet). Retry once.
- `409 Request was already resolved` — another admin got there first; refresh the row.
- `422` on preview/request — commission rate misconfigured for this user or their parent; block submit.
- Rejected request: the hold is gone, so "Request again" must go through the normal create flow
  (re-checks balance and current commission).
- The withdrawal `utrNumber` for wallet rows is a `pwt_…` ledger id — label it "Wallet ref", not "UTR".
- `accountBankingStatus` on a payout row is the account's **current** tag; older rows may change from
  `not_added` to `added` over time — read it from the row, don't cache it.
- Deleting a saved account never touches paid/rejected history; a `409` on delete means a pending
  request still references it.
- Subadmin on an admin screen: a `403` on `?userId=` means that user is not theirs — don't retry.
- A payout mode can be switched off by admin at any moment: build the mode selector from
  `/status.modes` every time the form opens, grey out and disable `false` modes, and never keep a
  disabled mode selected from a cached form state (§5.3).
- Never show paise integers raw; never compute commission client-side.

---

## 9. Realtime updates (Socket.io, optional at both ends)

The app already has a Socket.io connection that joins `room:user:<userId>` (and `room:admins` for
admins). Two new events arrive there — **treat them as "refresh now" hints, never as the source of
truth**; always re-fetch the affected list/wallet.

| event | to whom | `payload.type` values |
|---|---|---|
| `payout:update` | the affected user's room **and** admins (admins always, even if the user opted out) | `request_created` `request_paid` `request_rejected` `request_cancelled` `wallet_changed` (`reason`: `withdrawal_credit` \| `admin_credit` \| `admin_debit` \| `revert_to_qr`, includes `wallet`) `account_banking_status` `account_verification` (user only) |
| `payout:alert` | user room + admins | `low_balance` (`availablePaise`, `thresholdPaise`) |

Every payload has `userId`, `at` (ISO) and, where relevant, `payoutId`, `status`, `amountPaise`.

Toggles:
- **Platform** (admin settings §6.5a, `realtimeEnabled`): off = the server emits nothing.
- **Per user**: `PATCH /api/payout/me/preferences { "realtime": false }` → `{ success, preferences }`;
  the user then receives no `payout:update` events (admins still do). Read it back from
  `GET /status` (`preferences.realtime`). Put a "Live updates" switch in the user's settings; when
  off, fall back to pull-to-refresh / polling.

## 10. Withdrawal ownership (existing endpoint, tightened)
`POST /api/user/withdraw_new` now rejects a `userId` that the caller is not allowed to act for:
a **user** may only send their own `userId` (403 `You can only request withdrawals for your own
account`); a **subadmin** may send their own or one of their own users' ids (403 otherwise); admin and
employees are unrestricted. The app already sends the logged-in user's id, so nothing changes for a
correct client — but do not reuse a cached id from another session.

## 11. One-line summary of "0 means no limit"
Every numeric limit in this feature — platform `maxPerRequest`, `dailyLimit`, `maxPending`, the
per-user overrides, the alert thresholds — uses **`0` = off / no limit**. Per-user values additionally
accept **`null` = inherit the platform value**. Never display `0` as "₹0 limit"; display "No limit".
