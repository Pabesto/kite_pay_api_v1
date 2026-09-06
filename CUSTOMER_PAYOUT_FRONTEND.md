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

Statuses of a customer payout request: `pending` → `paid` | `rejected` (final). A rejected request
carries `rejectionReason`; the user simply creates a new request.

---

## 2. Conventions (read first)

- **Who has what:** the *user-side* feature (own payout wallet, own customer accounts, requesting
  customer payouts, §3–§5) is for **users and subadmins only**. **Admins never have a wallet or
  requests of their own** — do not show the wallet card, "New payout", "My customer accounts" or the
  wallet-destination toggle to an admin; the server also refuses admin `POST /accounts` and
  `POST /requests` with 403. Admin uses §6 exclusively.
- **Auth:** same Bearer token as every other `/api/...` call. User endpoints are for any logged-in
  user and are always scoped to the caller. Admin **views** (`GET /api/payout/admin/...`) are open to
  role `admin`, an employee with the `view_payouts` label, and **subadmins — who only ever see their
  own users (users whose parent is them) plus themselves**. Admin **actions** (paid / reject /
  banking-status / adjust / retry-credit / delete) need `admin` or the `edit_payouts` label;
  subadmins get 403 — hide the buttons for them. Non-authorized → 401/403.
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

### 4.1a Is the feature switched on? — `GET /api/payout/status`
Customer payouts can be paused **platform-wide** (admin) or **for one user** (admin). While paused
the user can still see the wallet, history and accounts, but cannot create a new request.
```jsonc
{ "success": true,
  "enabled": false,             // may this user create a request right now?
  "platformEnabled": false,     // false = paused for everyone
  "userEnabled": true,          // false = paused for this user only
  "message": "Bank maintenance till 6 PM"   // null when enabled; show verbatim when disabled
}
```
UI: when `enabled == false` disable the "New payout" button and show `message` in a banner above the
requests list. `POST /requests` while disabled returns `403 { error: <same message> }` — treat it as
a refresh trigger, not a crash. Also call this on app resume; admins flip it without notice.

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
`mode` ∈ `NEFT | IMPS | RTGS | UPI` (case-insensitive; stored uppercase). Choosing **UPI** with an
account that has no `upiId` (and none in the body) → `400 UPI ID is required for a UPI payout` —
show the UPI ID field whenever mode is UPI and prefill it from the selected account.
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
    "rejectedInMinutes": null      // requestedAt → rejectedAt
} }
```
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
internal record of the source account. Offer the last few distinct values as quick-pick chips.
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

### 6.5a Pause customer payouts — platform-wide and per user (admin role only)
`GET /api/payout/admin/settings` → `{ success, customerPayouts: { enabled, message } }`
`PATCH /api/payout/admin/settings`
```jsonc
{ "enabled": false, "message": "Bank maintenance till 6 PM" }   // message optional (≤200), shown to users while paused
```
`PATCH /api/payout/admin/users/:userId/payout-access`
```jsonc
{ "enabled": false, "reason": "KYC pending" }    // reason optional (≤200); { "enabled": true } re-enables
```
→ `{ success, userId, payoutDisabled, payoutDisabledReason }`. The user lists (`GET /api/admin/users`
etc.) now include `payoutDisabled` and `payoutDisabledReason` — show a "Payouts paused" chip and a
toggle in the user detail. Both switches return `403` for labelled employees; only role `admin` may
pause. Pausing never touches money or existing requests — admin can still pay/reject the queue.

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
   optional UPI ID); step 2 mode segmented control (NEFT/IMPS/RTGS/UPI — selecting UPI reveals a
   required UPI ID field prefilled from the account), amount, notes, live preview (§5.2), submit.
5. *Customer accounts* — list with `bankingStatus` chips, UPI ID if present, paid count / total paid,
   tap → per-customer history (§5.1), swipe-to-delete (disabled/409-toast while a pending request
   exists).

**Admin**
1. *Withdrawals* — existing screen; wallet rows labelled "To Payout Wallet", approve without UTR.
2. *Customer payout queue* — pending list with account chip, "Mark added", "Paid…" (reference dialog),
   "Reject…" (reason dialog); Paid/Rejected tabs. Show "waiting N min" on pending rows (compute
   from `requestedAt` to now — this is the only place the device does date math) so the oldest
   requests stand out; paid/rejected rows show the server's `paidInMinutes` / `rejectedInMinutes`.
3. *Wallets* — list, per-user drill-down with history and "Adjust…" dialog.
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
- Never show paise integers raw; never compute commission client-side.
