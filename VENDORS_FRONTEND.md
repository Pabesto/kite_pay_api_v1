# Vendor Accounts — frontend contract

Vendors list their own bank accounts. Admin approves each one; it is then **sold**, **rented**, or run on
**commission**. Commission accounts take merchant pay-ins (the vendor confirms them) and the vendor pays
merchant withdrawals himself.

The vendor system is **fully separate**: its own tables, its own routes, its own dashboards. Nothing here
appears under `/api/admin/dashboard/counters`, the QR/bank reports, `withdrawals_paginated`, or commissions —
and none of those appear here. Merchants see vendor accounts in a separate **Vendor accounts** section.

Base path: `/api/vendors`. Auth: the normal Appwrite JWT bearer. Request amounts are **rupees**; response
amounts are **paise** with an `…Rs` twin for display. Lists: `?limit (≤100) &cursor` → `{ <items>, nextCursor }`.
Errors: `{ error }` (sometimes with extra fields, listed below).

Building the Flutter UI? Screen-by-screen guide with Dart models, action matrices and the full error
catalogue: [`VENDORS_FLUTTER_UI.md`](VENDORS_FLUTTER_UI.md). Design overview: https://claude.ai/artifact/Ez7UokqRmrmtHiFGehXRHY

---

## 1. Roles

| Role | In the vendor system |
|---|---|
| `vendor` | Lists accounts, approves/rejects claims on them, pays withdrawals (enters UTR), sees his dashboard. **A vendor login can use `/api/vendors` only** — every other API answers `403 Vendor logins can only use the vendor portal.` Build the vendor app on `GET /me` + the routes below. |
| `admin` | Rate card, approve/reject listings, edit/deactivate/delist, assign to subadmins, override claims, resolve withdrawals, record rent/sale payments, every dashboard. |
| `subadmin` | Sees accounts assigned to them; assigns them to **their own** merchants; may file claims for them. |
| `user` (merchant) | Sees assigned accounts, files claims, withdraws, confirms or disputes payouts. |
| `employee` | No access (403). |

Create a vendor with the existing `POST /api/admin/create-user { name, email, password, role: "vendor" }` (admin only).
A vendor who still has live accounts (under review / active / inactive / rented) cannot be deleted (400).

**Field visibility.** A vendor never sees merchant identities (`userId`, `assignedUserId`, `managedByUserId`,
`ownerSubadminId`, `managerName`, `assignedUserName`). A merchant or subadmin never sees the vendor (`vendorId`, `vendorName`), the admin/vendor fee split, or
sale/rent terms — they get `feePercent` / `feePaise` / `feesPaidPaise` (the combined fee) instead.

---

## 2. Rate card (admin)

One card per account type. Copied onto an account **at approval**; admin can override per account then.
Changing the card later never touches approved accounts.

| Method & path | Who | Body | Response |
|---|---|---|---|
| `GET /rate-cards` | admin, vendor | — | `{ rateCards: [{ accountType, adminPercent, vendorPercent, salePricePaise, salePriceRs, rentPerMonthPaise, rentPerMonthRs, updatedAt }] }` |
| `PUT /admin/rate-cards/:accountType` | admin | any of `adminPercent`, `vendorPercent` (0–100), `salePrice`, `rentPerMonth` (rupees) | `{ message, rateCard }` |

`accountType`: `savings` · `current` · `corporate`.

---

## 3. Accounts

### Object (admin view — other roles get the subset described in §1)

```json
{
  "$id": "va_1", "accountNumber": "998877665544", "bankName": "SBI", "accountHolderName": "Ven", "ifscCode": "SBIN0001234",
  "accountType": "savings", "upiId": null, "notes": null, "mode": "commission", "state": "active",
  "vendorId": "ven1", "assignedUserId": "user1", "managedByUserId": "sub1",
  "vendorName": "Ravi Traders", "managerName": "Sub One", "assignedUserName": "Merchant One",
  "minTxnPaise": 10000, "minTxnRs": 100, "perTxnLimitPaise": 5000000, "perTxnLimitRs": 50000, "dailyLimitPaise": 0, "dailyLimitRs": 0,
  "adminPercent": 2, "vendorPercent": 1, "feePercent": 3,
  "salePricePaise": null, "salePriceRs": null, "rentPerMonthPaise": null, "rentPerMonthRs": null, "rentStartDate": null, "rentEndDate": null,
  "reviewedBy": "admin1", "reviewedAt": "…", "rejectReason": null, "delistRequested": false, "createdAt": "…",
  "totalTransactions": 3, "totalPayInAmount": 500000, "withdrawalRequestedAmount": 0, "withdrawalCompletedAmount": 100000,
  "commissionOnHold": 0, "adminCommissionEarned": 2000, "vendorCommissionEarned": 1000, "feesPaidPaise": 3000,
  "amountAvailableForWithdrawal": 397000, "amountAvailableForWithdrawalRs": 3970
}
```

`vendorName` / `managerName` / `assignedUserName` are display names (users_meta `name`, falling back to email; `null` when unassigned) with the same visibility as their ids: a vendor gets `vendorName` only, a merchant or subadmin gets `managerName` and `assignedUserName` only. `accountHolderName` is the name on the bank account itself.

`amountAvailableForWithdrawal` is what the merchant can withdraw **right now** (no T+1 hold on vendor
accounts). Limits: `0` = none. `minTxn` and `perTxnLimit` **block** a claim (422); `dailyLimit` only warns.

### Modes and states

- `commission` → `active` ⇄ `inactive` → `delisted`. Takes claims and withdrawals.
- `sell` → `sold`. `rent` → `rented` → `rent_ended`. Listing only: never assigned, no claims, no withdrawals.
- `under_review` (new listing) → approved into one of the above, or `rejected`.

### Endpoints

| Method & path | Who | Body / query | Response |
|---|---|---|---|
| `GET /me` | anyone logged in | — | `{ userId, name, email, role, status }` |
| `POST /accounts` | vendor | `{ accountNumber, bankName, accountHolderName, ifscCode, accountType, mode: "commission"\|"sell"\|"rent", upiId?, notes?, minTxn?, perTxnLimit?, dailyLimit? }` | `201 { message, account }` · `409` number already listed |
| `GET /accounts` | all (scoped) | `?state &mode &accountType`; admin also `&vendorId &managedByUserId &assignedUserId`; subadmin also `&assignedUserId`. `managedByUserId` / `assignedUserId` take `none` = not assigned. Filters stack. | `{ accounts, nextCursor }` |
| `GET /accounts/:id` | all (scoped) | — | `{ account }` |
| `PATCH /accounts/:id` | vendor while `under_review`; admin any time | vendor: listing fields; admin: also `adminPercent, vendorPercent, salePrice, rentPerMonth`. `accountNumber` is immutable (400). `mode`/`accountType` only while under review. | `{ message, account }` |
| `POST /accounts/:id/delist-request` | vendor | — | `{ message }` (sets `delistRequested`) |
| `POST /admin/accounts/:id/approve` | admin | optional overrides `adminPercent, vendorPercent, salePrice, rentPerMonth` | `{ message, account }` · `400` no rate for that mode · `409` not under review |
| `POST /admin/accounts/:id/reject` | admin | `{ reason }` (≥ 4) | `{ message, account }` |
| `PUT /admin/accounts/:id/status` | admin | `{ active: boolean }` | `{ message, account }` |
| `POST /admin/accounts/:id/delist` | admin | `{ reason? }` | `{ message, account }` · `409` balance / open withdrawals / pending claims |
| `POST /admin/accounts/:id/end-rental` | admin | `{ reason? }` | `{ message, account }` (stops rent accruing) |
| `PUT /admin/accounts/:id/assign-manager` | admin | `{ managedByUserId: subadminId \| null }` | `{ message, account }` · `400` not a subadmin · `409` merchant not under the new subadmin |
| `PUT /accounts/:id/assign-user` | admin, the managing subadmin | `{ assignedUserId: merchantId \| null }` — a merchant (`role: user`) under the account's subadmin; never the subadmin itself | `{ message, account }` · `409` no subadmin yet / not a merchant under it / **account still holds money or pending claims** |

The ledger belongs to the account, so the merchant on a funded account can never be changed — settle
(withdraw, or reverse) first.

---

## 4. Pay-in claims

```json
{ "$id": "vt_1", "accountId": "va_1", "userId": "user1", "ownerSubadminId": "sub1", "requestedBy": "user1",
  "referenceNumber": "UTR12345678", "amountPaise": 100000, "amountRs": 1000, "approvedAmountPaise": 99950, "approvedAmountRs": 999.5,
  "payerName": null, "paidAt": null, "remarks": null, "status": "approved",
  "reviewedAt": "…", "reviewNotes": null, "rejectReason": null, "approvedAt": "…", "reversedAt": null, "createdAt": "…" }
```

`status`: `pending` → `approved` | `rejected` | `cancelled`; admin can turn `rejected` → `approved` and
`approved` → `reversed`.

| Method & path | Who | Body / query | Response |
|---|---|---|---|
| `POST /accounts/:id/transactions` | the merchant, their subadmin, admin | `{ referenceNumber, amount, payerName?, paidAt? (ISO, not future), remarks? }` | `201 { success, transaction, dailyLimitWarning: null \| { dailyLimitPaise, usedPaise } }` |
| `GET /transactions` | all (scoped) | `?accountId &status &from &to (YYYY-MM-DD, IST)` | `{ transactions, nextCursor }` |
| `POST /transactions/:id/approve` | the account's vendor, admin | `{ amount? (what the statement shows, rupees), notes? }` | `{ success, transaction, ledgerUpdated }` — money is withdrawable immediately |
| `POST /transactions/:id/reject` | the account's vendor, admin | `{ reason }` (≥ 4) | `{ success, transaction }` |
| `POST /transactions/:id/cancel` | the merchant / requester, admin | — | `{ success, transaction }` |
| `POST /admin/transactions/:id/override` | admin | `{ action: "approve" \| "reverse", reason }` | `{ success, transaction }` · `409` reverse after the money was withdrawn/requested (`currentAvailablePaise`) |

Errors: `400` account not active / bad reference / bad amount · `409` account unassigned, `Reference number
already used`, `Transaction already <status>` (a no-op — refresh the row), busy (`Transaction is being
resolved…` / `Vendor account is currently being processed…`) · `422` below minimum / over per-transaction limit.

---

## 5. Withdrawals

The merchant asks for the amount they want to **receive**. Fees go on top, each rounded **up** to the paisa:

```
fee   = ceil(amount × adminPercent / 100) + ceil(amount × vendorPercent / 100)
total = amount + fee        ← what leaves the account's balance
```

```json
{ "$id": "vw_1", "accountId": "va_1", "amountPaise": 100000, "amountRs": 1000, "feePaise": 3000, "feeRs": 30, "totalPaise": 103000, "totalRs": 1030,
  "mode": "upi", "holderName": "Ravi", "payeeAccountNumber": null, "ifscCode": null, "upiId": "ravi@ybl",
  "status": "paid", "utr": "UTR555555", "paidAt": "…", "confirmedAt": null, "completedAt": null,
  "disputeReason": null, "rejectReason": null, "resolveReason": null, "createdAt": "…" }
```

Admin also sees `adminFeePaise`, `vendorFeePaise`, `adminPercent`, `vendorPercent`, `vendorId`, `userId`,
`resolvedBy`; the vendor also sees the fee split.

### Lifecycle

| From | Action | Who | To | Money |
|---|---|---|---|---|
| — | request | merchant | `requested` | `total` reserved |
| `requested` | cancel | merchant | `cancelled` | released |
| `requested` | reject `{ reason }` | vendor | `rejected` | released |
| `requested` | paid `{ utr }` | vendor | `paid` | nothing moves |
| `paid` | confirm | merchant | `completed` | payout recorded, fees earned by admin + vendor |
| `paid` | dispute `{ reason }` | merchant | `disputed` | nothing moves |
| `disputed` | confirm | merchant | `completed` | as above |
| `paid` / `disputed` | resolve `complete` | admin | `completed` | as above |
| any open | resolve `reverse` | admin | `reversed` | released |

A `paid` withdrawal the merchant never confirms simply stays `paid` — admin sees it in the dashboard's
pending payouts and resolves it.

| Method & path | Who | Body | Response |
|---|---|---|---|
| `POST /accounts/:id/withdraw/preview` | merchant | `{ amount }` | `{ amountPaise, feePercent, feePaise, totalPaise, availablePaise, sufficient, …Rs }` |
| `POST /accounts/:id/withdraw` | merchant | `{ amount, fee, total, mode: "bank"\|"upi", holderName, accountNumber + ifscCode \| upiId }` (fee/total echoed from the preview, rupees) | `201 { success, withdrawal }` · `400 Fee mismatch…` / `Amount mismatch…` (with `feePaise`, `totalPaise`) / `Insufficient balance` (with `availablePaise`) |
| `GET /withdrawals` | all (scoped) | `?accountId &status &from &to` | `{ withdrawals, nextCursor }` |
| `POST /withdrawals/:id/cancel` | merchant | — | `{ success, withdrawal }` |
| `POST /withdrawals/:id/reject` | vendor | `{ reason }` | same |
| `POST /withdrawals/:id/paid` | vendor | `{ utr }` (5–40 letters/digits/dashes) | same |
| `POST /withdrawals/:id/confirm` | merchant | — | same |
| `POST /withdrawals/:id/dispute` | merchant | `{ reason }` | same |
| `POST /admin/withdrawals/:id/resolve` | admin | `{ action: "complete" \| "reverse", reason }` | same |

A transition from the wrong state answers `409 Withdrawal already <status>` — refresh the row.

---

## 6. Rent and sale earnings

- Sale: `salePricePaise` is due once, from approval.
- Rent: `rentPerMonthPaise` is due at the **start** of each monthly period from `rentStartDate` (the approval
  instant, IST) until `rentEndDate`. Periods are labelled `YYYY-MM`.
- Admin records each payment; one row per `(account, period)`.

| Method & path | Who | Body | Response |
|---|---|---|---|
| `POST /admin/accounts/:id/earnings` | admin | `{ period: "sale" \| "YYYY-MM", amount, utr?, notes? }` | `201 { success, earning }` · `400` period not due / wrong mode · `409` already recorded |
| `GET /earnings` | admin (`?vendorId`), vendor (own) | `?accountId` | `{ earnings: [{ accountId, type, period, amountPaise, amountRs, utr, notes, paidAt }], nextCursor }` |

---

## 7. Dashboards

Every figure is computed live from the account ledgers, the day summaries and the earnings rows.

| Method & path | Who |
|---|---|
| `GET /admin/dashboard?from&to` | admin — all vendors |
| `GET /admin/vendors` | admin — one row per vendor: `{ userId, name, email, status, accounts: { total, byState }, payInPaise, payoutPaise, adminCommissionPaise, vendorCommissionPaise, heldByVendorPaise }` |
| `GET /admin/vendors/:vendorId?from&to` | admin — one vendor, plus `vendor` and `accountsTable` |
| `GET /me/dashboard?from&to` | vendor — himself, plus `accountsTable` (vendor view) |
| `GET /admin/audit?entityId` | admin — overrides and resolutions `{ entries: [{ entityType, entityId, action, actorId, reason, createdAt }] }` |

Dashboard body:

```jsonc
{
  "vendors": 12,                                   // admin dashboard only
  "accounts": { "total": 40, "byState": { "under_review": 3, "rejected": 1, "active": 25, "inactive": 2, "sold": 4, "rented": 4, "rent_ended": 1, "delisted": 0 } },
  "payInPaise": …,             // approved claims, all time
  "payoutPaise": …,            // completed withdrawals (what merchants received)
  "pendingPayoutPaise": …,     // requested + paid + disputed amounts
  "pendingPayouts": { "requested": 2, "paid": 1, "disputed": 0, "total": 3 },
  "pendingClaims": 5,
  "adminCommissionPaise": …, "vendorCommissionPaise": …,
  "merchantBalancePaise": …,   // withdrawable by merchants now
  "heldByVendorsPaise": …,     // payIn − payout: merchant balances + both fees, all in vendors' banks
  "rentSale": { "saleDuePaise", "salePaidPaise", "rentDuePaise", "rentPaidPaise", "outstandingPaise" },
  "range": null | { "from", "to", "payInPaise", "payoutPaise", "adminCommissionPaise", "vendorCommissionPaise", "count" },  // with ?from&to (≤ 366 days, IST)
  "accountsTable": [ { …Account, "rentSale": null | { "duePaise", "paidPaise", "outstandingPaise", "periodsDue" } } ]   // per-vendor views
}
```

Admin commission physically stays with the vendor (he pays merchants the net amount); the dashboard shows it
as earned. Collecting it is offline.

---

## 8. Not in this version

Employee access, realtime socket events (poll instead), partner API / webhooks, T+1 hold, and reuse of
merchants' saved withdrawal accounts (payee details are entered on each request).
