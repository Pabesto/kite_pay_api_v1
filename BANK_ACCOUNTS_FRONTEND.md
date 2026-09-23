# Bank Accounts — frontend contract

A second pay-in channel next to QR codes. An admin uploads bank accounts, assigns them to subadmins and
users the same way as QRs, and the assigned user tells us "I paid ₹X into this account, reference UTR…".
An admin (or an employee holding the `approve_bank_txns` label) checks the bank statement and approves or
rejects. **Approval is the moment money exists**: it credits the account's ledger, and from there
withdrawals, payout-wallet transfers, T+1 settlement, early release, day-wise reports and hold-and-reset
all behave exactly like a QR.

Base path: `/api/bank-acs`. Auth: the normal Appwrite JWT bearer. Every amount in a request body is
**rupees**; every amount in a response is **paise** with a `…Rs` twin where it helps display.

Nothing bank-related appears under `/api/qr-codes`, `webhook_data`, or the QR reports. The account
number is the id everywhere (`bankAcId`): withdrawal docs, summary keys, socket payloads, lock keys.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| `bankAcId` | The account number, trimmed, 6–24 letters/digits. Immutable. Unique. |
| ledger | The seven paise fields on the account: `totalTransactions`, `totalPayInAmount`, `withdrawalRequestedAmount`, `withdrawalApprovedAmount`, `amountAvailableForWithdrawal` (derived), `amountOnHold`, `commissionOnHold`, `commissionPaid` — identical to a QR doc |
| claim / transaction | A `bank_transactions` row: `pending` → `approved` \| `rejected` \| `cancelled`. Only `approved` rows are money. |
| `referenceNumber` | The UTR / bank reference the payer sees. Upper-cased, 6–40 chars `[A-Z0-9-]`. Unique across **all** accounts while a claim is pending or approved; a rejected/cancelled reference may be re-submitted. |
| `created_at` | Set at **approval**. It is the ledger/T+1 day. `paidAt` (what the user typed) is information only and can never backdate money into "withdrawable today". |
| `_hold[N]` | An archived generation after hold-and-reset (`123456789012_hold`, `_hold2`, …). Returned in lists with `archived: true`; show them as archives, not as accounts. |

Roles: **admin** everything. **subadmin** sees accounts assigned to their users / managed by them, files
claims for their users, assigns within accounts they manage, cannot approve. **employee** needs the
labels below. **user** sees and claims on their own accounts only.

### 1.1 Employee labels (new)

Employees get nothing on this feature by default. Grant each label as needed through the existing
`PUT /api/admin/edit-user/:id` with `{ "labels": [ …existing labels…, "<label>" ] }` (send the full
array — it replaces the old one). Every label is tenant-scoped: an employee only acts inside the
subadmins they are `assigned_to`, whatever labels they hold.

| Label | Grants | Endpoints |
|---|---|---|
| `view_bank_acs` | list bank accounts of their assigned subadmins' tenants (plus unassigned ones) | `GET /` |
| `assign_bank_acs` | assign an account to a user or a manager | `PUT /:bankAcId/assign-user`, `PUT /:bankAcId/assign-manager` |
| `toggle_bank_acs` | activate / deactivate an account | `PUT /:bankAcId/status` |
| `approve_bank_txns` | approve or reject payment claims — money moves on approve | `POST /transactions/:id/approve`, `POST /transactions/:id/reject` |

Not label-gated for employees: creating, editing or deleting accounts, deleting an approved claim,
early release, hold-and-reset, and reports beyond their own scope — those are admin-only.
`GET /transactions` needs no label; an employee simply sees the claims of their assigned tenants.
Add the labels to the employee-edit screen's checklist next to the payout labels
(`view_payouts`, `edit_payouts`, `view_payout_commissions`).

---

## 2. Account object

```json
{
  "$id": "…", "bankAcId": "123456789012",
  "bankName": "HDFC Bank", "accountHolderName": "Shop Pvt Ltd", "ifscCode": "HDFC0001234",
  "accountType": "current", "upiId": null, "notes": null,
  "perTxnLimitPaise": 0, "perTxnLimitRs": 0, "dailyLimitPaise": 500000, "dailyLimitRs": 5000,
  "isActive": true, "archived": false,
  "assignedUserId": "u1", "managedByUserId": "sub1", "createdByUserId": "admin1", "createdAt": "2026-09-22T05:00:00.000Z",
  "totalTransactions": 3, "totalPayInAmount": 300000, "withdrawalRequestedAmount": 0, "withdrawalApprovedAmount": 100000,
  "amountAvailableForWithdrawal": 197000, "amountOnHold": 0, "commissionOnHold": 0, "commissionPaid": 3000,
  "todayTotalPayIn": 100000, "yesterdayTotalPayIn": 200000,
  "releasedTodayPaise": 0, "heldTodayPaise": 100000, "canWithdrawTodayPaise": 97000,
  "t1HoldApplies": true
}
```

`canWithdrawTodayPaise` is computed server-side (T+1 minus any early release). Display it; never
recompute it. `t1HoldApplies` is `false` while the admin switch `bank_account_insta_credit` is on: then
`heldTodayPaise` and `releasedTodayPaise` are always 0 and `canWithdrawTodayPaise` equals
`amountAvailableForWithdrawal` — hide the "held until tomorrow" and "release" UI for bank accounts in that state. Limits: `0` = unlimited. `perTxnLimit` **blocks** a claim (422). `dailyLimit` only
**warns** (socket `bankac:limitWarning` + `dailyLimitWarning` in the response) — the claim goes through.

---

## 3. Account endpoints

| Method & path | Who | Body / query | Response |
|---|---|---|---|
| `GET /` | admin, employee `view_bank_acs`, subadmin | `?limit≤100 &cursor &isActive=true|false &assignedUserId &bankAcId` | `{ bankAccounts: [Account], nextCursor }` |
| `GET /user/:userId` | the user themselves, their subadmin, admin, employee | `?limit &cursor` | `{ bankAccounts, nextCursor }` |
| `POST /` | admin | `{ bankAcId, bankName, accountHolderName, ifscCode, accountType: "savings"\|"current"\|"corporate", upiId?, notes?, perTxnLimit?, dailyLimit? }` (limits in rupees; accountType is case-insensitive, stored lower-case) | `201 { message, bankAccount }` · `409` duplicate number |
| `PATCH /:bankAcId` | admin | any of `bankName, accountHolderName, ifscCode, accountType, upiId, notes, perTxnLimit, dailyLimit` — **not** `bankAcId` (400) | `{ message, bankAccount }` |
| `PUT /:bankAcId/status` | admin, employee `toggle_bank_acs` | `{ isActive: boolean }` | `{ message, isActive }` |
| `DELETE /:bankAcId` | admin | — | `{ message }` · `400` while assigned, claims/withdrawals pending, or balance > 0 |
| `PUT /:bankAcId/assign-user` | admin, employee `assign_bank_acs`, the managing subadmin | `{ assignedUserId: id \| null }` | `{ message, assignedUserId }` · `409` assignee not under the manager |
| `PUT /:bankAcId/assign-manager` | admin, employee `assign_bank_acs` | `{ managedByUserId: id \| null }` | `{ message, bankAccount }` · `409` codes `UNLINK_BLOCKED_ASSIGNED`, `ASSIGNEE_NOT_FOUND`, `ASSIGNEE_OUT_OF_SCOPE` |

Assignment rules are the QR rules: unlinking a manager needs the account unassigned first; a transfer
to another manager is admin-only and needs the assignee under the new manager; assigning a manager to an
unassigned account also assigns it to that manager.

---

## 4. Claims (payment requests)

### Transaction object

```json
{
  "$id": "bank_txns_17", "bankAcId": "123456789012", "userId": "u1", "ownerSubadminId": "sub1", "requestedBy": "u1",
  "referenceNumber": "UTR123456789", "amountPaise": 100000, "amountRs": 1000,
  "approvedAmountPaise": null, "approvedAmountRs": null,
  "payerName": "Ravi", "paidAt": "2026-09-22T04:10:00.000Z", "remarks": null, "proofFileId": null,
  "status": "pending", "reviewedBy": null, "reviewedAt": null, "reviewNotes": null, "rejectReason": null,
  "deleted": false, "createdAt": "2026-09-22T04:12:00.000Z", "created_at": null
}
```

### Endpoints

| Method & path | Who | Body / query | Response |
|---|---|---|---|
| `POST /:bankAcId/transactions` | assigned user, their subadmin, admin | `{ referenceNumber, amount (rupees), payerName?, paidAt? (ISO, not future), remarks?, proofFileId? }` | `201 { success, transaction, dailyLimitWarning: null \| { dailyLimitPaise, usedPaise } }` |
| `GET /transactions` | any logged-in (role-scoped) | `?bankAcId &status &userId &from &to (YYYY-MM-DD, IST) &includeDeleted=true &limit &cursor` | `{ transactions, nextCursor }` |
| `POST /transactions/:id/approve` | admin, employee `approve_bank_txns` | `{ amount? (rupees override), notes? }` | `{ success, transaction, ledgerUpdated, bankAccount, dailyLimitWarning }` |
| `POST /transactions/:id/reject` | same | `{ reason }` (≥ 4 chars) | `{ success, transaction }` |
| `POST /transactions/:id/cancel` | the requester (or admin) | — | `{ success, transaction }` |
| `DELETE /transactions/:id` | admin | `{ reason? }` | `{ success, transaction }` — undoes a **wrong approval**: soft-delete + full ledger reversal |

Errors you must handle:

| Status | When | Text |
|---|---|---|
| 400 | inactive account / bad reference / bad amount | `Bank account is inactive`, `Invalid referenceNumber (6–40 letters, digits or dashes)`, `Invalid amount` |
| 400 | too many pending claims (config `bankac_max_pending_claims`, default 20) | `You already have the maximum number of pending payment claims (N).` |
| 403 | not the assigned user / not your user / employee filing | — |
| 409 | account unassigned | `Bank account is not assigned to any user` |
| 409 | reference reused | `Reference number already used` |
| 409 | already resolved (second approve, reject after approve, cancel after resolve) | `Transaction already approved` (…`rejected` / `cancelled`) — a no-op for the UI, refresh the row |
| 409 | busy | `Transaction is being resolved. Please try again.` / `Bank account is currently being processed. Please try again in a moment.` |
| 409 | delete would go negative (money already withdrawn) | `Cannot reverse this transaction: the available withdrawal balance would go negative…` + `currentAvailable`, `withdrawalRequested`, `withdrawalApproved` |
| 422 | over per-transaction limit | `Amount exceeds this bank account's per-transaction limit of ₹…` |

Approve flow for the reviewer screen: show `amountRs`, `referenceNumber`, `payerName`, `paidAt`,
`remarks`, the proof image (`proofFileId` in the shared storage bucket) and the account's
`dailyLimitWarning` state. The amount field is editable — what the admin sees on the statement wins and
is stored as `approvedAmountPaise`; the user's figure stays in `amountPaise`.

---

## 5. Withdrawals from a bank account

Use the **existing** withdrawal endpoints; send `bankAcId` instead of `qrId`. Nothing else changes —
same `mode` (`upi` \| `bank` \| `wallet`), same commission preview, same 400/422 rules, same approve /
reject, same realtime `withdrawal:update`.

```http
POST /api/user/withdraw_commission_preview   { userId, bankAcId, preAmount, mode? }
POST /api/user/withdraw_new                  { userId, bankAcId, mode, holderName, preAmount, amount, commission, … }
GET  /api/user/withdrawals_paginated?bankAcId=123456789012
```

Withdrawal rows and `withdrawal:update` payloads now carry both `qrId` and `bankAcId` (one of them null).
`POST /api/payout/admin/wallet/revert-to-qr` on a bank-funded wallet withdrawal returns the money to the
bank account ledger (response and `payout:update` carry `bankAcId`). Sending both `qrId` and `bankAcId`
is a 400 (`Send either qrId or bankAcId, not both`).

The **early-release fee** applies to bank withdrawals exactly as to QR ones: the preview returns
`earlyReleaseCommissionRs` and `totalAmount` including it, and `/withdraw_new` needs
`earlyReleaseCommission` echoed with `amount = preAmount + commission + earlyReleaseCommission`. Full
rules, rates and where it shows: `QR_SETTLEMENT_FRONTEND.md` §6.5. With `bank_account_insta_credit` on
there is never a release on a bank account, so the fee is always 0 there.

---

## 6. Reports

Same shapes as `/api/admin/payin-summary` and `/withdrawal-summary`, keyed by account and grouped by
bank name instead of company/integration.

`GET /payin-summary?from&to&userId&bankAcId&bankName` →

```json
{ "days": [ { "date": "2026-09-22", "totalPaise": 300000, "totalRs": 3000, "bankAccounts": { "123456789012": 300000 }, "banks": { "HDFC Bank": 300000 } } ],
  "grandTotalPaise": 300000, "grandTotalRs": 3000, "todayPaise": 300000, "todayRs": 3000, "yesterdayPaise": 0, "yesterdayRs": 0,
  "banks": [ { "bankName": "HDFC Bank", "totalPaise": 300000, "totalRs": 3000 } ] }
```

`GET /withdrawal-summary?from&to&userId&bankAcId&bankName&mode=direct|wallet` → the same rows as the QR
withdrawal summary (`paidPaise`, `commissionPaise`, `count`, `direct`, `wallet`), with `bankAccounts`
and `banks` maps in place of `qrs`/`companies`/`integrations`.

Scoping: admin all; subadmin their tenant; user their own; `userId` filters (403 outside your scope);
range ≤ 366 days; dates are IST days.

---

## 7. T+0 early release (admin only) and the insta-credit switch

**`bank_account_insta_credit`** (admin setting, `PATCH /api/payout/admin/settings { "bankAccountInstaCredit": true }`,
default **false**):

- **false** — an approved bank pay-in is held T+1 exactly like a QR pay-in, and the admin may release it
  early with the endpoints below (with the early-release fee, §5).
- **true** — an approved claim is withdrawable the moment it is approved. Nothing is held, every account
  reports `t1HoldApplies: false`, and the release endpoints answer
  `400 Early release is not applicable: bank_account_insta_credit is on…`. QR codes are unaffected.

The switch is read live: flipping it changes every bank account's `canWithdrawTodayPaise` at once,
with no restart and no data change. Same dialog and rules as QR early release
(`QR_SETTLEMENT_FRONTEND.md`, including `chargeCommission` and the fee in §6.5), same config cap
`qr_daily_release_max_percent`, own rows keyed by `bankAcId`:

| Method & path | Notes |
|---|---|
| `GET /:bankAcId/settlement?date=` | `{ success, bankAcId, date, availablePaise, todayPayInPaise, releasedPaise, heldPaise, withdrawablePaise, maxReleasablePaise, maxPercent, assignedUserId, release }` |
| `PUT /:bankAcId/release` | body exactly one of `percent` (needs `expectedTodayPayInPaise`), `amount` (rupees, absolute), `addAmount` (rupees, needs `expectedReleasedPaise`) + `reason` (≥ 4) + `date?` → 409 `STALE_SETTLEMENT` with `current` when the figures moved |
| `DELETE /:bankAcId/release?date=` | revoke (sets 0) |
| `GET /releases?date&bankAcId&limit&cursor` | audit list |

---

## 8. Hold-and-reset (admin only)

`POST /:bankAcId/hold-and-reset` `{ dryRun?, confirm, allowIncrement?, allowPending? }`

Archives the account as `<bankAcId>_hold[N]` (inactive, keeps its assignment, balances and history) and
creates a fresh, empty, unassigned, active account under the same number. Unlike QR, **every**
transaction moves synchronously — claims are hand-approved so the set is small; there is no background
migration job or status URL.

- dry run → `{ dryRun: true, sourceBankAcId, holdBankAcId, state: { finishingInterruptedRun, isRepeatReset, needsHoldConfirmation, needsPendingConfirmation, existingHoldId }, willMove: { transactions, pendingTxns, withdrawalRequests, releases }, sourceAccount }`
- `409 { needsPendingConfirmation, pendingTxns }` while claims are pending → resolve them or re-send with `allowPending: true` (they move to the hold and credit the archived ledger when approved)
- `409 { needsHoldConfirmation, existingHoldId, nextHoldId }` on a repeat reset → re-send with `allowIncrement: true`
- `423` while the account is locked by another operation → retry shortly
- success → `{ success, message, sourceBankAcId, holdBankAcId, steps: { archivedAccountDoc, createdFreshAccountDoc, transactionsMoved, withdrawalRequestsMoved, dailySummaryDocsMoved, releasesMoved, withdrawalSummaryDocsMoved } }`

Retrying after a failure finishes the interrupted run.

---

## 9. Realtime

Socket rooms are the withdrawal-staff rooms (`room:user:<userId>`, `room:admins`,
`room:withdrawal_sub:<subadminId>`), so whoever can see a tenant's withdrawals sees its bank claims.
Gate: config `bankac_realtime_enabled` (default on).

`bankac:txn`
```json
{ "type": "requested" | "approved" | "rejected" | "cancelled" | "deleted",
  "bankAcId": "123456789012", "transactionId": "bank_txns_17", "userId": "u1", "ownerSubadminId": "sub1",
  "actor": { "userId": "admin1", "role": "admin", "name": "…" } | null,
  "transaction": { …Transaction object… }, "at": "2026-09-22T04:12:00.000Z" }
```

`bankac:limitWarning` (admins + the owner subadmin; never blocks anything)
```json
{ "bankAcId": "123456789012", "date": "2026-09-22", "dailyLimitPaise": 500000, "usedPaise": 620000, "overByPaise": 120000, "transactionId": "bank_txns_18", "at": "…" }
```

Withdrawals on bank accounts still emit the normal `withdrawal:update` (with `bankAcId` set).

---

## 10. Dashboard counters (`GET /api/admin/dashboard/counters`)

| Key | Meaning (paise unless `…Count`) |
|---|---|
| `totalAmountReceived` | **QR + bank** together (unchanged meaning for existing tiles) |
| `totalQrAmountReceived` | QR/API channel only |
| `totalBankAmountReceived` | bank channel only |
| `totalBankAcTxCount` | approved bank claims (live, Redis) |
| `totalBankAcsUploaded`, `totalBankAcsAssignedToMerchant`, `bankAcsActive`, `bankAcsDisabled` | account counts |
| `totalBankAcTxPendingCount`, `totalBankAcTxPendingAmount` | open claims |
| `unregisteredQrAmountReceived`, `unregisteredQrIdCount` | money received on QR ids that were **never uploaded** (no QR doc exists), and how many such ids. Inside `totalAmountReceived`, on no ledger, so no merchant can withdraw it. Tile: "Received on unregistered QRs" — tap → the transactions list with `?unregisteredQr=true` |
| `preUploadQrAmountReceived`, `preUploadQrCount` | money that arrived on registered QRs **before they were uploaded** (the QR's ledger started at 0 afterwards and never picked those payments up), and how many QRs are affected. Also inside `totalAmountReceived`, also on no ledger. Tile: "Received before QR upload" |

`avgTxAmount`, `netFlow` and the other derived roll-ups now include the bank channel.

### 10.1 What `netFlow` is, and `netBreakdown`

`netFlow = totalAmountReceived − totalPaidOut` — every rupee that came in through QR **and** bank
pay-ins, minus every rupee that actually left the platform (direct withdrawals to merchants' banks or
UPI, plus customer payouts). Money moved into payout wallets is *not* "left" until a customer payout is
paid. So `netFlow` is **everything still on the platform**: merchant balances *and* our commissions.

`netBreakdown` says exactly where that money sits, summed live from the QR and bank-account ledgers:

```jsonc
"netBreakdown": {
  "netFlowPaise": 12345600, "netFlowRs": 123456,
  "qr":   { "count": 42, "totalPayInPaise": …, "withdrawalApprovedPaise": …, "pendingWithdrawalPaise": …, "onHoldPaise": …,
            "commissionOnHoldPaise": …, "commissionPaidPaise": …, "availablePaise": …, "balancePaise": … },
  "bank": { …same keys over bank_accounts… },
  "payoutWallet": { "balancePaise": …, "customerPayoutPendingPaise": … },
  "commission": { "payinAdminPaise": …, "payinMerchantPaise": …, "payoutAdminPaise": …, "payoutMerchantPaise": …,
                  "earlyReleaseAdminPaise": …, "earlyReleaseMerchantPaise": …,
                  "adminTotalPaise": …, "merchantTotalPaise": …, "totalPaise": … },
  "unregisteredQr": { "idCount": 3, "amountPaise": …, "amountRs": … },   // received on QR ids with no QR doc
  "preUploadPayments": { "qrCount": 67, "amountPaise": …, "amountRs": …, "ledgerOverDailyPaise": 0 },   // received before the QR was uploaded
  "merchantBalancePaise": …,        // qr.balance + bank.balance + payoutWallet.balance
  "explainedPaise": …, "explainedRs": …,   // merchantBalance + commission.total + unregisteredQr.amount + preUploadPayments.amount
  "unexplainedPaise": 0             // netFlow − explained
}
```

Two lines are money that is inside `netFlow` but on no ledger, shown on their own rather than left in the
unexplained gap:

- `unregisteredQr` — came in on QR ids nobody uploaded.
- `preUploadPayments` — came in on QRs that **were** uploaded, but after the payment; the ledger started at
  zero and never picked it up. `ledgerOverDailyPaise` is the opposite case (a ledger above what the daily
  summaries say it received) and should stay 0.

Neither line is withdrawable by anyone until the backend credits it explicitly.

| Piece | Meaning |
|---|---|
| `qr.balancePaise` / `bank.balancePaise` | merchant money still on those ledgers = `availablePaise` (withdrawable, subject to T+1) + `pendingWithdrawalPaise` (requested, not yet approved) + `onHoldPaise` (flagged transactions) + `commissionOnHoldPaise` (commission reserved for pending withdrawals) |
| `qr.commissionPaidPaise` / `bank.commissionPaidPaise` | commission already earned from that ledger (payin + early-release); shown for reference, already inside `commission.totalPaise` |
| `payoutWallet.balancePaise` | float sitting in payout wallets (including amounts held for pending customer payouts) |
| `commission.*` | the three earnings pots split admin / subadmin: payin (withdrawals), customer payout, early release |
| `merchantBalancePaise` | what we owe merchants in total |
| `explainedPaise` | `merchantBalancePaise + commission.totalPaise` — should equal `netFlowPaise` |
| `unexplainedPaise` | the gap. 0 or a few paise of rounding is normal. A large value means a counter and a ledger disagree (a failed counter increment, a manual ledger edit, a deleted transaction whose reversal went wrong) — surface it as a warning tile |

Suggested tile: **Net on platform** = `netFlowRs`, with a drill-down showing QR balance, bank balance,
wallet float, commission, and the unexplained gap.

---

## 11. Config keys (admin, `POST /api/admin/config`)

| Key | Type | Default | Effect |
|---|---|---|---|
| `bankac_max_pending_claims` | integer | 20 | open claims one user may have; 0 = unlimited |
| `bankac_realtime_enabled` | boolean | true | `bankac:*` socket events |
| `qr_daily_release_max_percent` | integer | 50 | shared with QR: cap on T+0 release; 0 = nothing may be released |
| `bank_account_insta_credit` | boolean | false | true = approved bank pay-ins withdrawable at once, no T+1, release endpoints refused (§7). Set via `PATCH /api/payout/admin/settings { bankAccountInstaCredit }` |
| `default_early_release_commission` | double (%) | 0 | early-release fee rate for users without their own `earlyReleaseCommission` (QR and bank alike); 0 = fee off. Set via `PATCH /api/payout/admin/settings { defaultEarlyReleaseCommission }` |
