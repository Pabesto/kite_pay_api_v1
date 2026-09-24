# Vendor Accounts — Flutter UI build guide

**Audience:** the Flutter frontend team.
**Status:** backend built (`vendors.js`, mounted at `/api/vendors`). It goes live after the deploy steps in §2.

This guide covers what to build and how it behaves: screens, the calls each screen makes, the buttons each
state allows, validation, error handling and Dart models. It is the only document you need to build the UI.

| Related doc | What it's for |
|---|---|
| [Design overview (artifact)](https://claude.ai/artifact/Ez7UokqRmrmtHiFGehXRHY) | The why: roles, lifecycles and state diagrams on one page. Read it once before starting. |
| [`VENDORS_FRONTEND.md`](VENDORS_FRONTEND.md) | The compact API contract. If it and this guide ever disagree, `VENDORS_FRONTEND.md` wins. |

---

## Contents

1. [What you are building](#1-what-you-are-building)
2. [Before you start](#2-before-you-start)
3. [Login and role routing](#3-login-and-role-routing)
4. [Conventions: money, dates, pagination, errors, refresh](#4-conventions)
5. [Dart models](#5-dart-models)
6. [API client: every endpoint](#6-api-client)
7. [Status chips and action matrices](#7-status-chips-and-action-matrices)
8. [Vendor app screens](#8-vendor-app-new-role)
9. [Admin panel screens](#9-admin-panel-additions)
10. [Subadmin screens](#10-subadmin-additions)
11. [Merchant screens](#11-merchant-additions)
12. [Form validation rules](#12-form-validation-rules)
13. [Error catalogue](#13-error-catalogue)
14. [QA scenarios](#14-qa-scenarios)
15. [Not in this version](#15-not-in-this-version)

---

## 1. What you are building

The vendor system is **fully separate** from QR codes, bank accounts, withdrawals, payouts and the main
dashboard. Vendor money never appears on existing screens, and existing data never appears on vendor screens.
Build it as a **new section** in each app. Don't reuse the QR or bank-account screens.

| Surface | Who | What's new |
|---|---|---|
| **Vendor app** | `role: "vendor"` (new) | A whole new shell: dashboard, my accounts, list an account, claims to approve, withdrawals to pay, rent/sale earnings |
| **Admin panel** | `role: "admin"` | A new **Vendors** menu: dashboard, vendor list and detail, review queue, account actions, rate card, claim overrides, withdrawal resolution, rent/sale payments, audit log |
| **Subadmin** | `role: "subadmin"` | A new **Vendor accounts** menu: accounts assigned to them, assign/unassign their merchants, file claims, view claims and withdrawals |
| **Merchant** | `role: "user"` | A new **Vendor accounts** section: balance, submit payment claims, withdraw, confirm or dispute payouts |
| Employee | `role: "employee"` | Nothing. Hide the menu. The API answers 403. |

### Vocabulary

| Term | Meaning |
|---|---|
| **Vendor** | A person who supplies bank accounts. Logs in to the vendor app. |
| **Vendor account** | One bank account listed by a vendor. Has a **type** (`savings`/`current`/`corporate`) and a **mode**. |
| **Mode** | `commission`: merchants pay into it and withdraw from it, and admin and the vendor each earn a fee on every withdrawal. `sell`: sold to admin once. `rent`: rented to admin monthly. Sell and rent accounts are **listing only**: no merchants, claims or withdrawals. |
| **Claim** | A merchant saying "I paid ₹X into this account, UTR …". The **vendor** checks his bank statement and approves it. Approved money is **withdrawable immediately**. |
| **Withdrawal** | The merchant takes money out. The **vendor** sends it from his bank and enters the UTR. The merchant confirms receipt. |
| **Fee** | Charged on every withdrawal from a commission account, on top of the amount the merchant receives: admin % + vendor %. |
| **Rate card** | Admin's default rates per account type, copied onto an account when admin approves it. |

---

## 2. Before you start

Backend team, in this order:

1. `node scripts/setup-vendor-schema.js` creates the eight vendor tables.
2. Deploy the API.
3. Admin sets a rate card for each account type (your admin screen §9.7, or the API directly).
4. Admin creates vendor logins with the **existing** create-user screen or API, using `role: "vendor"`:
   `POST /api/admin/create-user { name, email, password, role: "vendor" }`. Add `vendor` to the role picker in
   the admin "create user" screen (admin only; subadmins and employees can't create vendors).

Base URL: `https://kite-pay-api-v3.onrender.com/api/vendors`. Every call sends
`Authorization: Bearer <Appwrite JWT>`, the same JWT the app already uses.

**Test accounts to request from backend:** 1 admin, 2 vendors, 2 subadmins, 2 merchants under each subadmin.
With two of each you can test that one vendor or subadmin can't see another's data.

---

## 3. Login and role routing

Login is unchanged (Appwrite email/password → JWT). What changes is where a `vendor` goes afterwards.

```
login ─► Appwrite account.get()  ─► labels contains "vendor"? ──yes──► Vendor app shell
                                         │
                                         no ─► existing role routing (admin / subadmin / employee / user)
```

- `create-user` writes the role into the Appwrite account's **labels**, so `account.get().labels` contains
  `"vendor"` for a vendor. You don't need an extra call.
- To confirm (or if labels aren't available in your flow), call **`GET /api/vendors/me`**. It works for
  **every** role and returns `{ userId, name, email, role, status }`.
- **A vendor login can call `/api/vendors/*` only.** Every other API (`/api/admin/*`, `/api/user/*`,
  `/api/bank-acs/*`, …) answers **403 `Vendor logins can only use the vendor portal.`**. The vendor shell
  must not reuse any existing startup call (config, dashboard counters, QR lists, sockets). If a vendor
  somehow reaches the old shell, treat that 403 message as "route to the vendor app".
- **Sockets:** a vendor may connect but receives nothing. **Don't open a socket in the vendor app.** Vendor
  screens refresh by polling (§4.6).
- `status: false` means the login is disabled. Show "Your account is disabled, contact admin" and log out.

```dart
Future<void> routeAfterLogin() async {
  final user = await account.get();
  if (user.labels.contains('vendor')) {
    return router.go('/vendor');
  }
  // …existing routing unchanged
}
```

---

## 4. Conventions

### 4.1 Money: paise in, rupees out

- **Requests** send **rupees** as numbers (`1000`, `999.5`).
- **Responses** carry **integer paise** (`100000`) and usually a `…Rs` twin (`1000`). Use paise for
  arithmetic and comparisons, and never do float maths on rupees. Use the `…Rs` twin or `formatPaise` for display.
- Never compute fees on the device. The preview endpoint returns them (§11.4).

```dart
import 'package:intl/intl.dart';

final _inr = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);

String formatPaise(int paise) => _inr.format(paise / 100);   // 12345678 → ₹1,23,456.78

num toRupeesInput(String text) => num.parse(text.trim());   // what you put in request bodies
```

### 4.2 Dates and time

- Every timestamp is a **UTC ISO string** (`2026-09-24T06:10:00.000Z`). Show it in **IST**.
- Filters (`from`, `to`) are **IST calendar days** as `YYYY-MM-DD`.
- Rent periods are `YYYY-MM` strings. Show them as "Sep 2026".

```dart
DateTime toIst(String iso) => DateTime.parse(iso).toUtc().add(const Duration(hours: 5, minutes: 30));

String showIst(String? iso) =>
    iso == null ? '—' : DateFormat('dd MMM yyyy, hh:mm a').format(toIst(iso));

String dayParam(DateTime istDay) => DateFormat('yyyy-MM-dd').format(istDay);
```

### 4.3 Pagination

Every list uses `?limit=25&cursor=<id>` and returns `{ <items>: [...], nextCursor }`.
`nextCursor == null` means there are no more pages. Use infinite scroll: load the next page with
`cursor = nextCursor`. When a filter changes, reset the cursor to null and clear the list.

A `400 Invalid or expired pagination cursor` means the list changed underneath you. Reset and reload from
the top.

### 4.4 Errors

Every error body is `{ "error": "<message>" }`, sometimes with extra fields (listed in §13). **Show `error`
as-is.** The messages are written for end users and are stable.

| Status | Meaning | UI |
|---|---|---|
| 400 | validation | Show the message under the form or as a snackbar. Keep user input. |
| 401 | JWT expired | Refresh the JWT once and retry, then log out. |
| 403 | wrong role | Shouldn't happen if menus are role-gated. Show the message. |
| 404 | not found **or not yours** | "Not found". Pop back to the list and refresh. |
| 409 `… already <status>` | someone else acted first | **Not an error.** Refresh the row or screen and show a neutral "Already <status>" toast. |
| 409 busy (`…being processed…`, `…being resolved…`) | lock held for a moment | Auto-retry once after 1.5 s, then show the message with a Retry button. |
| 409 other | business rule (balance, pending claims…) | Show the message in a dialog. |
| 422 | amount outside the account's limits | Show under the amount field. |
| 500 | server | "Something went wrong, try again". |

```dart
class ApiError implements Exception {
  final int status;
  final String message;
  final Map<String, dynamic> body;
  ApiError(this.status, this.message, this.body);

  bool get isAlreadyResolved => status == 409 && message.contains(' already ');
  bool get isBusy => status == 409 && (message.contains('being processed') || message.contains('being resolved'));
}
```

### 4.5 Idempotency and double taps

Every money action (approve, reject, mark paid, confirm, withdraw…) is exactly-once on the server. A second
tap gets a `409 … already …`. Still, **disable the button while its request is in flight**, and treat
"already" 409s as success-plus-refresh.

### 4.6 Refresh (there are no sockets)

| Screen | Poll every | Also refresh on |
|---|---|---|
| Vendor: claims inbox, withdrawals to pay | 20 s while visible | pull-to-refresh, return to screen |
| Merchant: my withdrawals (while any is `paid`) | 20 s while visible | pull-to-refresh |
| Dashboards | 60 s while visible | pull-to-refresh |
| Everything else | none | pull-to-refresh, after any action on that screen |

Stop polling when the screen isn't visible or the app is backgrounded.

---

## 5. Dart models

Every field that one role can't see is **absent** from the JSON for that role (not null), so all of those are
nullable. Parse with `json['x'] as T?`. Enums fall back to `unknown` so a new server value never crashes the app.

```dart
enum AccountType { savings, current, corporate, unknown }
enum AccountMode { commission, sell, rent, unknown }
enum AccountState { under_review, rejected, active, inactive, sold, rented, rent_ended, delisted, unknown }
enum ClaimStatus { pending, approved, rejected, cancelled, reversed, unknown }
enum WithdrawalStatus { requested, cancelled, rejected, paid, disputed, completed, reversed, unknown }

T enumOf<T extends Enum>(List<T> values, String? name, T fallback) =>
    values.firstWhere((v) => v.name == name, orElse: () => fallback);

int paise(dynamic v) => (v as num?)?.toInt() ?? 0;
```

### 5.1 VendorAccount

```dart
class VendorAccount {
  final String id;                    // $id: use it in every /accounts/:id call
  final String accountNumber, accountType, mode, state;
  final String? bankName, accountHolderName, ifscCode, upiId, notes;
  // Visible to: admin (all) · vendor (not merchant ids) · subadmin/merchant (not vendor, not split, not sale/rent)
  final String? vendorId, assignedUserId, managedByUserId;
  // Display names for the ids above (null = unassigned / unknown). Same visibility as the ids.
  final String? vendorName, managerName, assignedUserName;
  final int minTxnPaise, perTxnLimitPaise, dailyLimitPaise;      // 0 = no limit
  final num? adminPercent, vendorPercent;                          // admin + vendor
  final num? feePercent;                                           // commission accounts, every role
  final int? salePricePaise, rentPerMonthPaise;                    // admin + vendor
  final String? rentStartDate, rentEndDate;
  final String? reviewedAt, rejectReason, createdAt;
  final bool delistRequested;
  // ledger (paise)
  final int totalTransactions, totalPayInAmount, withdrawalRequestedAmount, withdrawalCompletedAmount,
      commissionOnHold, feesPaidPaise, amountAvailableForWithdrawal;
  final int? adminCommissionEarned, vendorCommissionEarned;       // admin + vendor
  final RentSale? rentSale;                                        // only inside dashboard accountsTable

  VendorAccount.fromJson(Map<String, dynamic> j)
      : id = j[r'$id'],
        accountNumber = j['accountNumber'],
        accountType = j['accountType'],
        mode = j['mode'],
        state = j['state'],
        bankName = j['bankName'],
        accountHolderName = j['accountHolderName'],
        ifscCode = j['ifscCode'],
        upiId = j['upiId'],
        notes = j['notes'],
        vendorId = j['vendorId'],
        assignedUserId = j['assignedUserId'],
        managedByUserId = j['managedByUserId'],
        vendorName = j['vendorName'],
        managerName = j['managerName'],
        assignedUserName = j['assignedUserName'],
        minTxnPaise = paise(j['minTxnPaise']),
        perTxnLimitPaise = paise(j['perTxnLimitPaise']),
        dailyLimitPaise = paise(j['dailyLimitPaise']),
        adminPercent = j['adminPercent'],
        vendorPercent = j['vendorPercent'],
        feePercent = j['feePercent'],
        salePricePaise = (j['salePricePaise'] as num?)?.toInt(),
        rentPerMonthPaise = (j['rentPerMonthPaise'] as num?)?.toInt(),
        rentStartDate = j['rentStartDate'],
        rentEndDate = j['rentEndDate'],
        reviewedAt = j['reviewedAt'],
        rejectReason = j['rejectReason'],
        createdAt = j['createdAt'],
        delistRequested = j['delistRequested'] == true,
        totalTransactions = paise(j['totalTransactions']),
        totalPayInAmount = paise(j['totalPayInAmount']),
        withdrawalRequestedAmount = paise(j['withdrawalRequestedAmount']),
        withdrawalCompletedAmount = paise(j['withdrawalCompletedAmount']),
        commissionOnHold = paise(j['commissionOnHold']),
        feesPaidPaise = paise(j['feesPaidPaise']),
        amountAvailableForWithdrawal = paise(j['amountAvailableForWithdrawal']),
        adminCommissionEarned = (j['adminCommissionEarned'] as num?)?.toInt(),
        vendorCommissionEarned = (j['vendorCommissionEarned'] as num?)?.toInt(),
        rentSale = j['rentSale'] == null ? null : RentSale.fromJson(j['rentSale']);
}

class RentSale {
  final int duePaise, paidPaise, outstandingPaise;
  final List<String>? periodsDue;       // rent accounts: ["2026-08","2026-09"]; sale: null
  RentSale.fromJson(Map<String, dynamic> j)
      : duePaise = paise(j['duePaise']),
        paidPaise = paise(j['paidPaise']),
        outstandingPaise = paise(j['outstandingPaise']),
        periodsDue = (j['periodsDue'] as List?)?.cast<String>();
}
```

**Names on an account:** `accountHolderName` is the name printed on the bank account. `vendorName`,
`managerName` (subadmin) and `assignedUserName` (merchant) are the people in the system. Show each where the
role receives it, and "Unassigned" when the id is null.

**Two account fields to be careful with:**

| Field | Show as |
|---|---|
| `amountAvailableForWithdrawal` | The merchant's **withdrawable balance now**. There's no T+1 hold. |
| `withdrawalRequestedAmount` | Money reserved for open withdrawals (requested / paid / disputed). |

### 5.2 VendorClaim

```dart
class VendorClaim {
  final String id, accountId, referenceNumber, status;
  final int amountPaise;                 // what the merchant typed
  final int? approvedAmountPaise;        // what was actually credited (the vendor may correct it)
  final String? userId, ownerSubadminId, requestedBy, vendorId;   // hidden from vendor / merchant as per §1
  final String? payerName, paidAt, remarks, reviewNotes, rejectReason,
      reviewedAt, approvedAt, reversedAt, createdAt;

  VendorClaim.fromJson(Map<String, dynamic> j)
      : id = j[r'$id'],
        accountId = j['accountId'],
        referenceNumber = j['referenceNumber'],
        status = j['status'],
        amountPaise = paise(j['amountPaise']),
        approvedAmountPaise = (j['approvedAmountPaise'] as num?)?.toInt(),
        userId = j['userId'],
        ownerSubadminId = j['ownerSubadminId'],
        requestedBy = j['requestedBy'],
        vendorId = j['vendorId'],
        payerName = j['payerName'],
        paidAt = j['paidAt'],
        remarks = j['remarks'],
        reviewNotes = j['reviewNotes'],
        rejectReason = j['rejectReason'],
        reviewedAt = j['reviewedAt'],
        approvedAt = j['approvedAt'],
        reversedAt = j['reversedAt'],
        createdAt = j['createdAt'];

  int get creditedPaise => approvedAmountPaise ?? amountPaise;
}
```

### 5.3 VendorWithdrawal

```dart
class VendorWithdrawal {
  final String id, accountId, status, mode;       // mode: "bank" | "upi"
  final int amountPaise;                          // what the merchant RECEIVES
  final int feePaise;                             // admin + vendor fee combined
  final int totalPaise;                           // amount + fee: what left the balance
  final int? adminFeePaise, vendorFeePaise;       // admin + vendor only
  final num? adminPercent, vendorPercent;
  final String? holderName, payeeAccountNumber, ifscCode, upiId;   // payee: vendor pays to this
  final String? utr, paidAt, confirmedAt, completedAt, disputeReason,
      rejectReason, resolveReason, createdAt;
  final String? userId, vendorId, ownerSubadminId, resolvedBy;

  VendorWithdrawal.fromJson(Map<String, dynamic> j)
      : id = j[r'$id'],
        accountId = j['accountId'],
        status = j['status'],
        mode = j['mode'],
        amountPaise = paise(j['amountPaise']),
        feePaise = paise(j['feePaise']),
        totalPaise = paise(j['totalPaise']),
        adminFeePaise = (j['adminFeePaise'] as num?)?.toInt(),
        vendorFeePaise = (j['vendorFeePaise'] as num?)?.toInt(),
        adminPercent = j['adminPercent'],
        vendorPercent = j['vendorPercent'],
        holderName = j['holderName'],
        payeeAccountNumber = j['payeeAccountNumber'],
        ifscCode = j['ifscCode'],
        upiId = j['upiId'],
        utr = j['utr'],
        paidAt = j['paidAt'],
        confirmedAt = j['confirmedAt'],
        completedAt = j['completedAt'],
        disputeReason = j['disputeReason'],
        rejectReason = j['rejectReason'],
        resolveReason = j['resolveReason'],
        createdAt = j['createdAt'],
        userId = j['userId'],
        vendorId = j['vendorId'],
        ownerSubadminId = j['ownerSubadminId'],
        resolvedBy = j['resolvedBy'];
}
```

### 5.4 RateCard, Earning, AuditEntry

```dart
class RateCard {
  final String accountType;
  final num? adminPercent, vendorPercent;
  final int? salePricePaise, rentPerMonthPaise;
  final String? updatedAt;
  RateCard.fromJson(Map<String, dynamic> j)
      : accountType = j['accountType'],
        adminPercent = j['adminPercent'],
        vendorPercent = j['vendorPercent'],
        salePricePaise = (j['salePricePaise'] as num?)?.toInt(),
        rentPerMonthPaise = (j['rentPerMonthPaise'] as num?)?.toInt(),
        updatedAt = j['updatedAt'];
}

class Earning {                 // one recorded rent or sale payment
  final String id, accountId, type, period;   // type "sale"|"rent"; period "sale" or "YYYY-MM"
  final int amountPaise;
  final String? vendorId, utr, notes, paidAt;
  Earning.fromJson(Map<String, dynamic> j)
      : id = j[r'$id'],
        accountId = j['accountId'],
        type = j['type'],
        period = j['period'],
        amountPaise = paise(j['amountPaise']),
        vendorId = j['vendorId'],
        utr = j['utr'],
        notes = j['notes'],
        paidAt = j['paidAt'];
}

class AuditEntry {
  final String id, entityType, entityId, action, actorId;   // entityType: account|transaction|withdrawal
  final String? reason, createdAt;
  AuditEntry.fromJson(Map<String, dynamic> j)
      : id = j[r'$id'],
        entityType = j['entityType'],
        entityId = j['entityId'],
        action = j['action'],
        actorId = j['actorId'],
        reason = j['reason'],
        createdAt = j['createdAt'];
}
```

`AuditEntry.action` values: `approve`, `reject`, `delist`, `end_rental`, `assign_manager`, `unassign_manager`
(accounts); `approve`, `reject`, `override_approve`, `override_reverse` (claims, admin only); `resolve_complete`,
`resolve_reverse` (withdrawals).

### 5.5 VendorDashboard

```dart
class VendorDashboard {
  final int? vendors;                          // admin dashboard only
  final int accountsTotal;
  final Map<String, int> accountsByState;      // every AccountState name → count (zeros included)
  final int payInPaise, payoutPaise, pendingPayoutPaise, pendingClaims;
  final int payoutsRequested, payoutsPaid, payoutsDisputed;
  final int adminCommissionPaise, vendorCommissionPaise, merchantBalancePaise, heldByVendorsPaise;
  final int saleDuePaise, salePaidPaise, rentDuePaise, rentPaidPaise, outstandingPaise;
  final DashboardRange? range;                 // only when from/to were sent
  final List<VendorAccount>? accountsTable;    // per-vendor dashboards only

  VendorDashboard.fromJson(Map<String, dynamic> j)
      : vendors = j['vendors'],
        accountsTotal = paise(j['accounts']['total']),
        accountsByState = Map<String, int>.from(j['accounts']['byState']),
        payInPaise = paise(j['payInPaise']),
        payoutPaise = paise(j['payoutPaise']),
        pendingPayoutPaise = paise(j['pendingPayoutPaise']),
        pendingClaims = paise(j['pendingClaims']),
        payoutsRequested = paise(j['pendingPayouts']['requested']),
        payoutsPaid = paise(j['pendingPayouts']['paid']),
        payoutsDisputed = paise(j['pendingPayouts']['disputed']),
        adminCommissionPaise = paise(j['adminCommissionPaise']),
        vendorCommissionPaise = paise(j['vendorCommissionPaise']),
        merchantBalancePaise = paise(j['merchantBalancePaise']),
        heldByVendorsPaise = paise(j['heldByVendorsPaise']),
        saleDuePaise = paise(j['rentSale']['saleDuePaise']),
        salePaidPaise = paise(j['rentSale']['salePaidPaise']),
        rentDuePaise = paise(j['rentSale']['rentDuePaise']),
        rentPaidPaise = paise(j['rentSale']['rentPaidPaise']),
        outstandingPaise = paise(j['rentSale']['outstandingPaise']),
        range = j['range'] == null ? null : DashboardRange.fromJson(j['range']),
        accountsTable = (j['accountsTable'] as List?)?.map((e) => VendorAccount.fromJson(e)).toList();
}

class DashboardRange {            // sums of daily summaries between from and to (IST days)
  final String from, to;
  final int payInPaise, payoutPaise, adminCommissionPaise, vendorCommissionPaise, count;  // count = approved claims
  DashboardRange.fromJson(Map<String, dynamic> j)
      : from = j['from'],
        to = j['to'],
        payInPaise = paise(j['payInPaise']),
        payoutPaise = paise(j['payoutPaise']),
        adminCommissionPaise = paise(j['adminCommissionPaise']),
        vendorCommissionPaise = paise(j['vendorCommissionPaise']),
        count = paise(j['count']);
}
```

**What each dashboard number means** (use these as tile subtitles or info tooltips):

| Field | Tile label | Meaning |
|---|---|---|
| `payInPaise` | Pay-in | All approved claims, all time |
| `payoutPaise` | Paid out | Completed withdrawals: what merchants actually received |
| `pendingPayoutPaise` + `pendingPayouts` | Payouts pending | Withdrawals still open (requested / paid / disputed) |
| `pendingClaims` | Claims to review | Claims waiting for a vendor decision |
| `adminCommissionPaise` | Admin commission | Admin's fees on completed withdrawals. **This money physically sits with the vendor.** |
| `vendorCommissionPaise` | Vendor commission | The vendor's fees on completed withdrawals |
| `merchantBalancePaise` | Merchant balance | What merchants can still withdraw |
| `heldByVendorsPaise` | Held by vendors | Pay-in − paid out = merchant balances + both fees, all in vendors' banks. **This is the risk exposure.** Highlight it on the admin dashboard. |
| `rentSale.*` | Rent / Sale | Due vs paid vs outstanding for sold and rented accounts |

---

## 6. API client

All paths are relative to `/api/vendors`. "Scoped" means the server filters rows by the caller's role, so the
same call works for everyone.

| # | Method & path | Roles | Body / query | Returns |
|---|---|---|---|---|
| 1 | `GET /me` | all | — | `{ userId, name, email, role, status }` |
| 2 | `GET /rate-cards` | admin, vendor | — | `{ rateCards: [RateCard] }` |
| 3 | `PUT /admin/rate-cards/:accountType` | admin | `{ adminPercent?, vendorPercent?, salePrice?, rentPerMonth? }` | `{ message, rateCard }` |
| 4 | `POST /accounts` | vendor | listing form (§8.4) | `201 { message, account }` |
| 5 | `GET /accounts` | all, scoped | `?state &mode &accountType &limit &cursor`; admin: `&vendorId &managedByUserId &assignedUserId`; subadmin: `&assignedUserId` (`none` = unassigned) | `{ accounts, nextCursor }` |
| 6 | `GET /accounts/:id` | all, scoped | — | `{ account }` |
| 7 | `PATCH /accounts/:id` | vendor (under review), admin | changed fields only | `{ message, account }` |
| 8 | `POST /accounts/:id/delist-request` | vendor | — | `{ message }` |
| 9 | `POST /admin/accounts/:id/approve` | admin | `{ adminPercent?, vendorPercent?, salePrice?, rentPerMonth? }` | `{ message, account }` |
| 10 | `POST /admin/accounts/:id/reject` | admin | `{ reason }` | `{ message, account }` |
| 11 | `PUT /admin/accounts/:id/status` | admin | `{ active: true\|false }` | `{ message, account }` |
| 12 | `POST /admin/accounts/:id/delist` | admin | `{ reason? }` | `{ message, account }` |
| 13 | `POST /admin/accounts/:id/end-rental` | admin | `{ reason? }` | `{ message, account }` |
| 14 | `PUT /admin/accounts/:id/assign-manager` | admin | `{ managedByUserId: id\|null }` | `{ message, account }` |
| 15 | `PUT /accounts/:id/assign-user` | admin, managing subadmin | `{ assignedUserId: id\|null }` | `{ message, account }` |
| 16 | `POST /accounts/:id/transactions` | merchant, their subadmin, admin | `{ referenceNumber, amount, payerName?, paidAt?, remarks? }` | `201 { success, transaction, dailyLimitWarning }` |
| 17 | `GET /transactions` | all, scoped | `?accountId &status &from &to &limit &cursor` | `{ transactions, nextCursor }` |
| 18 | `POST /transactions/:id/approve` | owning vendor, admin | `{ amount?, notes? }` | `{ success, transaction, ledgerUpdated }` |
| 19 | `POST /transactions/:id/reject` | owning vendor, admin | `{ reason }` | `{ success, transaction }` |
| 20 | `POST /transactions/:id/cancel` | merchant / requester, admin | — | `{ success, transaction }` |
| 21 | `POST /admin/transactions/:id/override` | admin | `{ action: "approve"\|"reverse", reason }` | `{ success, transaction }` |
| 22 | `POST /accounts/:id/withdraw/preview` | merchant | `{ amount }` | preview (§11.4) |
| 23 | `POST /accounts/:id/withdraw` | merchant | `{ amount, fee, total, mode, holderName, accountNumber+ifscCode \| upiId }` | `201 { success, withdrawal }` |
| 24 | `GET /withdrawals` | all, scoped | `?accountId &status &from &to &limit &cursor` | `{ withdrawals, nextCursor }` |
| 25 | `POST /withdrawals/:id/cancel` | merchant | — | `{ success, withdrawal }` |
| 26 | `POST /withdrawals/:id/reject` | owning vendor | `{ reason }` | `{ success, withdrawal }` |
| 27 | `POST /withdrawals/:id/paid` | owning vendor | `{ utr }` | `{ success, withdrawal }` |
| 28 | `POST /withdrawals/:id/confirm` | merchant | — | `{ success, withdrawal }` |
| 29 | `POST /withdrawals/:id/dispute` | merchant | `{ reason }` | `{ success, withdrawal }` |
| 30 | `POST /admin/withdrawals/:id/resolve` | admin | `{ action: "complete"\|"reverse", reason }` | `{ success, withdrawal }` |
| 31 | `POST /admin/accounts/:id/earnings` | admin | `{ period, amount, utr?, notes? }` | `201 { success, earning }` |
| 32 | `GET /earnings` | admin (`?vendorId`), vendor (own) | `?accountId &limit &cursor` | `{ earnings, nextCursor }` |
| 33 | `GET /admin/dashboard` | admin | `?from &to` | dashboard + `vendors` |
| 34 | `GET /admin/vendors` | admin | `?limit &cursor` | `{ vendors: [VendorRow], nextCursor }` |
| 35 | `GET /admin/vendors/:vendorId` | admin | `?from &to` | dashboard + `vendor` + `accountsTable` |
| 36 | `GET /me/dashboard` | vendor | `?from &to` | dashboard + `accountsTable` |
| 37 | `GET /admin/audit` | admin | `?entityId &limit &cursor` | `{ entries: [AuditEntry], nextCursor }` |

`VendorRow` (row 34): `{ userId, name, email, status, accounts: { total, byState }, payInPaise, payoutPaise,
adminCommissionPaise, vendorCommissionPaise, heldByVendorPaise }`.

Client skeleton (use your existing HTTP layer or interceptor; this only shows the shape):

```dart
class VendorApi {
  VendorApi(this._http);
  final ApiHttp _http;                         // adds Authorization, base URL, JSON, ApiError mapping
  static const _b = '/api/vendors';

  Future<Map<String, dynamic>> me() => _http.get('$_b/me');

  Future<Page<VendorAccount>> accounts({String? state, String? mode, String? accountType, String? vendorId,
      String? managedByUserId, String? assignedUserId, String? cursor}) async {
    final j = await _http.get('$_b/accounts', query: {
      if (state != null) 'state': state,
      if (mode != null) 'mode': mode,
      if (accountType != null) 'accountType': accountType,
      if (vendorId != null) 'vendorId': vendorId,                        // admin
      if (managedByUserId != null) 'managedByUserId': managedByUserId,  // admin; 'none' = no subadmin
      if (assignedUserId != null) 'assignedUserId': assignedUserId,     // admin + subadmin; 'none' = no merchant
      if (cursor != null) 'cursor': cursor,
      'limit': '25',
    });
    return Page((j['accounts'] as List).map((e) => VendorAccount.fromJson(e)).toList(), j['nextCursor']);
  }

  Future<VendorClaim> approveClaim(String id, {num? amountRs, String? notes}) async {
    final j = await _http.post('$_b/transactions/$id/approve', body: {
      if (amountRs != null) 'amount': amountRs,
      if (notes != null && notes.isNotEmpty) 'notes': notes,
    });
    return VendorClaim.fromJson(j['transaction']);
  }

  Future<VendorWithdrawal> markPaid(String id, String utr) async =>
      VendorWithdrawal.fromJson((await _http.post('$_b/withdrawals/$id/paid', body: {'utr': utr}))['withdrawal']);

  // …one method per row of the table above
}

class Page<T> {
  final List<T> items;
  final String? nextCursor;
  Page(this.items, this.nextCursor);
}
```

---

## 7. Status chips and action matrices

### 7.1 Chip colours and labels

| Value | Label | Colour |
|---|---|---|
| account `under_review` | Under review | amber |
| account `active` | Active | green |
| account `inactive` | Inactive | grey |
| account `rejected` | Rejected | red |
| account `sold` | Sold | blue |
| account `rented` | Rented | blue |
| account `rent_ended` | Rental ended | grey |
| account `delisted` | Delisted | grey (outlined) |
| claim `pending` | Pending | amber |
| claim `approved` | Approved | green |
| claim `rejected` | Rejected | red |
| claim `cancelled` | Cancelled | grey |
| claim `reversed` | Reversed | red (outlined) |
| withdrawal `requested` | Requested (merchant) / **To pay** (vendor) | amber |
| withdrawal `paid` | Paid, confirm receipt (merchant) / **Awaiting confirmation** (vendor) | blue |
| withdrawal `disputed` | Disputed | red |
| withdrawal `completed` | Completed | green |
| withdrawal `cancelled` / `rejected` / `reversed` | Cancelled / Rejected / Reversed | grey |

Mode badges: `commission` → "Commission", `sell` → "For sale", `rent` → "For rent".

### 7.2 Account actions (show only these buttons)

| State | Vendor (owner) | Admin | Subadmin (manager) | Merchant (assigned) |
|---|---|---|---|---|
| `under_review` | Edit · Request delist | Approve · Reject · Edit · Delist | — | — |
| `active` | Request delist | Deactivate · Edit · Assign subadmin · Delist | Assign / change merchant | New claim · Withdraw |
| `inactive` | Request delist | Activate · Edit · Assign subadmin · Delist | Assign / change merchant | Withdraw (no new claims) |
| `sold` | — | Record sale payment · Edit | — | — |
| `rented` | Request delist | Record rent payment · End rental · Edit | — | — |
| `rent_ended` | — | Record rent payment (outstanding) · Edit | — | — |
| `rejected` / `delisted` | — | — | — | — |

Show a "Delist requested" badge to admin when `delistRequested == true`. Delist and change-merchant are
refused (409) while the account holds money or has pending claims. Show the server message.

### 7.3 Claim actions

| Status | Vendor | Admin | Merchant / requester | Subadmin |
|---|---|---|---|---|
| `pending` | Approve (amount editable) · Reject | Approve · Reject | Cancel | Cancel (only the ones they filed) |
| `rejected` | — | **Override: approve** | — | — |
| `approved` | — | **Override: reverse** | — | — |
| other | — | — | — | — |

### 7.4 Withdrawal actions

| Status | Merchant | Vendor | Admin |
|---|---|---|---|
| `requested` | Cancel | **Mark paid** (UTR) · Reject | Reverse |
| `paid` | **Confirm received** · Dispute | — (waiting) | Complete · Reverse |
| `disputed` | Confirm received | — | Complete · Reverse |
| `completed` / `cancelled` / `rejected` / `reversed` | — | — | — |

---

## 8. Vendor app (new role)

Bottom navigation: **Home** · **Accounts** · **Claims** · **Payouts** · **Earnings**. Profile and logout go in
the app bar.

### 8.1 Home: `GET /me/dashboard`

- **Header:** vendor name (from `/me`).
- **Tiles:**
  - Pay-in
  - Paid out
  - **Payouts to make** (`pendingPayouts.requested`, tap → Payouts tab)
  - **Claims to review** (`pendingClaims`, tap → Claims tab)
  - My commission (`vendorCommissionPaise`)
  - Admin commission held (`adminCommissionPaise`, subtitle "collected by admin offline")
  - Rent/Sale outstanding (`rentSale.outstandingPaise`)
- **Date filter chip:** Today / 7 days / 30 days / Custom. Sends `from`/`to` and shows the `range` block
  (pay-in, paid out and commission for the period).
- **Accounts strip:** `accountsTable` as cards (§8.2 card design).
- Poll every 60 s.

### 8.2 Accounts: `GET /accounts` (scoped to the vendor)

- Filter chips by state: All · Under review · Active · Inactive · Sold · Rented · Rejected.
- **Card:** account holder name, bank name + masked number (`•••• 5544`), type, mode badge, state chip.
  The vendor sees no subadmin or merchant names; only admin and the account's subadmin/merchant do.
  - Commission accounts also show available balance and pay-in.
  - Rent/sale accounts show the monthly rent or price.
- **FAB:** "List an account" → §8.4.
- Tap a card → Account detail.

### 8.3 Account detail: `GET /accounts/:id`

| Section | Contents |
|---|---|
| Details | holder, number, IFSC, UPI, type, mode, notes |
| Limits | min / max per transaction / daily ("No limit" when 0) |
| Rates | commission accounts: my % (`vendorPercent`) and admin % · sell: price · rent: monthly rent, start date, rent due/paid (from `rentSale` if you came from the dashboard, otherwise from `GET /earnings?accountId=`) |
| Ledger (commission) | pay-in, paid out, open payouts, fees held, my commission, admin commission |
| Review | if `rejected`: `rejectReason` in a red banner · if `under_review`: amber "Waiting for admin approval" banner |

Actions follow §7.2. **Edit** (under review only) opens the listing form pre-filled; send only changed fields
via `PATCH`. `accountNumber` can't be edited, so make it read-only. **Request delist** opens a confirm dialog
→ `delist-request` → toast "Delist requested".

### 8.4 List an account: `POST /accounts`

Before showing the form, load `GET /rate-cards` so the vendor sees what each choice pays.

| Field | Widget | Rule |
|---|---|---|
| Account number | text, digits/letters | 6–24 alphanumerics, required |
| Bank name | text | required, ≤ 100 |
| Account holder name | text | required, ≤ 120 |
| IFSC | text, force uppercase | `^[A-Z]{4}0[A-Z0-9]{6}$`, required |
| Account type | segmented: Savings / Current / Corporate | required |
| Mode | radio cards: **Commission** / **Sell** / **Rent** | required. Under each option show the rate card for the chosen type: commission → "You earn X% on every merchant withdrawal"; sell → "Sale price ₹…"; rent → "Rent ₹…/month". If the card has no value, show "Rate set by admin on approval". |
| UPI ID | text | optional, `handle@provider` |
| Minimum per transaction (₹) | number | optional, ≥ 0, 0 = none. Commission mode only. |
| Maximum per transaction (₹) | number | optional, ≥ 0, must be ≥ minimum when both are > 0. Commission mode only. |
| Daily total limit (₹) | number | optional, ≥ 0. Warning only, never blocks. Commission mode only. |
| Notes | multiline | optional, ≤ 500 |

Submit → `201`: go to Account detail with the "Waiting for admin approval" banner. `409 This account number
is already listed.` goes under the account number field.

Body example:

```json
{ "accountNumber": "998877665544", "bankName": "SBI", "accountHolderName": "Ravi Kumar", "ifscCode": "SBIN0001234",
  "accountType": "savings", "mode": "commission", "upiId": "ravi@sbi", "minTxn": 100, "perTxnLimit": 50000, "dailyLimit": 200000 }
```

### 8.5 Claims: `GET /transactions?status=pending` (tab "To review")

Tabs: **To review** (`status=pending`) · **Approved** · **Rejected** · **All**. Optional account filter
(`accountId`). Poll "To review" every 20 s.

**Claim card:** amount (large), UTR (monospace, copy button), payer name, paid-at, remarks, the account
(bank + masked number, looked up from the accounts list by `accountId`), submitted time.
**The vendor never sees who the merchant is.** Don't try to show it.

**Approve sheet:**

1. "Check your bank statement for **₹1,000.00** with reference **UTR12345678**."
2. **Amount received** (₹), pre-filled from `amountPaise / 100` and editable. If the statement shows a
   different amount, the vendor corrects it. The server credits this figure (`approvedAmountPaise`).
3. Notes (optional).
4. Button **Approve & credit**. On success, toast "Approved: ₹… credited" and remove the card from To review.

**Reject sheet:** a reason is required (≥ 4 chars, e.g. "Not in statement"). Button **Reject**.

A `409 Transaction already approved` (or rejected/cancelled) means someone else (admin, or a merchant cancel)
acted first. Refresh and show a neutral toast.

### 8.6 Payouts: `GET /withdrawals`

Tabs:
- **To pay** (`status=requested`): poll every 20 s.
- **Awaiting confirmation** (`status=paid`)
- **Disputed** (`status=disputed`)
- **Done** (`status=completed`)
- **All**

**To-pay card (the most important vendor screen):**

```
┌────────────────────────────────────────────┐
│ Pay ₹1,000.00                     To pay   │
│ to  Ravi Kumar                             │
│ UPI ravi@ybl                        [copy] │
│   — or —                                   │
│ A/C 123456789012  IFSC HDFC0001234  [copy] │
│ from your account SBI •••• 5544            │
│ Your commission on this: ₹10.00            │
│ Requested 24 Sep, 11:02 AM                 │
│ [ Reject ]              [ I've paid → ]    │
└────────────────────────────────────────────┘
```

- **Pay exactly `amountPaise`.** That's what the merchant receives. The fee is not paid out.
- Show `vendorFeePaise` as "Your commission on this".
- **I've paid** opens a sheet asking for the **UTR / bank reference** (5–40 letters, digits, dashes; force
  uppercase). Submit → `POST /withdrawals/:id/paid` → the card moves to "Awaiting confirmation".
  Explain in the sheet: "Money is released to you as earnings once the merchant confirms receipt."
- **Reject** needs a reason (≥ 4 chars). Use it when the vendor can't pay. The merchant's money goes back to
  their balance.

**Awaiting confirmation / Disputed:** read-only for the vendor. Show UTR, paid-at, and for disputed the
`disputeReason` with "Admin will resolve this".

### 8.7 Earnings (rent / sale): `GET /earnings` + `GET /me/dashboard`

- **Summary** (from the dashboard `rentSale`): sale due / paid, rent due / paid, **outstanding**.
- **Per account** (from `accountsTable` where mode is sell/rent): due, paid, outstanding, and for rent the
  list of `periodsDue` with a ✓ on each period that has an `Earning` row.
- **History list:** `GET /earnings`, showing period ("Sep 2026" or "Sale"), amount, UTR, paid date.

---

## 9. Admin panel additions

New side-menu group **Vendors**:
- Dashboard
- Vendors
- Review queue *(badge: count of `under_review`)*
- Accounts
- Claims
- Withdrawals *(badge: `pendingPayouts.disputed`)*
- Rate card
- Audit log

### 9.1 Vendors dashboard: `GET /admin/dashboard`

- **Row 1:** Vendors · Accounts total, with a stacked bar by state (`accounts.byState`).
- **Row 2 (money):**
  - Pay-in
  - Paid out
  - Payouts pending (amount + `requested/paid/disputed` counts)
  - **Held by vendors** (highlight it; this is the exposure)
- **Row 3 (earnings):**
  - Admin commission earned
  - Vendor commission earned
  - Rent/sale: due · paid · outstanding
- **Row 4 (queues, each tappable):**
  - Accounts under review → Review queue
  - Claims pending → Claims (pending)
  - Disputed payouts → Withdrawals (disputed)
- **Date range picker** → `from`/`to` → shows the `range` block for the period. Maximum 366 days.

### 9.2 Vendors list: `GET /admin/vendors`

Table / cards per vendor: name, email, enabled, accounts (total + small state breakdown), pay-in, paid out,
admin commission, vendor commission, **held**. Tap → Vendor detail. The "Add vendor" button opens the
existing create-user form with role preset to `vendor`.

### 9.3 Vendor detail: `GET /admin/vendors/:vendorId`

The same tiles as the dashboard for this one vendor, then an **accounts table** (`accountsTable`, admin view,
so assigned merchant and subadmin are included):

| Column | Source |
|---|---|
| Account | bank + number |
| Type · Mode · State | chips |
| Merchant / Subadmin | `assignedUserName` / `managerName` ("Unassigned" when null) |
| Pay-in / Paid out / Available | ledger |
| Admin % / Vendor % | rates |
| Rent/Sale due · paid · outstanding | `rentSale` |

Shortcuts: "Claims of this vendor" → Claims filtered client-side by the vendor's account ids (or by
`accountId`); "Earnings" → `GET /earnings?vendorId=`.

### 9.4 Review queue: `GET /accounts?state=under_review`

For each listing: vendor, account details, type, mode, limits, `delistRequested`, created time.

**Approve dialog** (`POST /admin/accounts/:id/approve`). Pre-fill from `GET /rate-cards` for the account's type:

| Mode | Fields | Result |
|---|---|---|
| commission | Admin % · Vendor % (both editable) · live "merchant pays X% total" | `active` |
| sell | Sale price (₹) | `sold` |
| rent | Monthly rent (₹) · note "Rent starts today" | `rented` |

Send only the fields the admin changed from the card. If there's no card and no value, the server answers
`400 No commission rates for savings: set the rate card or send adminPercent and vendorPercent`, so make the
fields required when the card is empty.

**Reject dialog:** reason (≥ 4 chars) → `rejected`. The vendor sees the reason.

### 9.5 Accounts: `GET /accounts` (admin sees all)

**List columns:** account holder (`accountHolderName`) + bank + masked number · **Vendor** (`vendorName`) ·
**Subadmin** (`managerName`) · **Merchant** (`assignedUserName`) · type · mode · state · available · pay-in.
Show "Unassigned" in grey when a name is null.

**Filter bar** (filters stack; each change resets the cursor):

| Filter | Query | Options source |
|---|---|---|
| Vendor | `vendorId=<id>` | `GET /api/vendors/admin/vendors` (name + userId) |
| Subadmin | `managedByUserId=<id>` or `none` ("No subadmin") | your existing subadmin list |
| Merchant | `assignedUserId=<id>` or `none` ("No merchant") | merchants of the chosen subadmin (your existing user list filtered by `parentId`) |
| State · Mode · Type | `state` · `mode` · `accountType` | fixed enums |

Useful presets: "Approved but not given to a subadmin" = `state=active&managedByUserId=none`; "With a
subadmin, no merchant yet" = `managedByUserId=<sub>&assignedUserId=none`.

 Account detail (admin) shows everything in §8.3 plus the
assigned merchant and subadmin, `reviewedAt`, and the audit trail (`GET /admin/audit?entityId=<accountId>`).

Admin actions per §7.2:

| Action | Call | Notes |
|---|---|---|
| Edit | `PATCH /accounts/:id` | Any of: bank name, holder, IFSC, UPI, notes, limits, `adminPercent`, `vendorPercent`, `salePrice`, `rentPerMonth`. Mode and type only while under review. **New rates apply to future withdrawals only.** |
| Activate / Deactivate | `PUT /admin/accounts/:id/status { active }` | Deactivated = no new claims; the merchant can still withdraw their balance. |
| Assign subadmin | `PUT /admin/accounts/:id/assign-manager { managedByUserId }` | Picker lists **subadmins only**. `null` = remove (only possible after the merchant is removed). Moving to another subadmin requires the current merchant to be under the new one, else 409. |
| Assign merchant | `PUT /accounts/:id/assign-user { assignedUserId }` | Picker lists merchants (`role: user`) under the account's subadmin. Refused while the account holds money or pending claims. |
| Delist | `POST /admin/accounts/:id/delist` | Confirm dialog. Refused while money or pending claims remain. Clears assignments. |
| End rental | `POST /admin/accounts/:id/end-rental` | Rent stops accruing from now. |
| Record payment | §9.8 | sold / rented / rent_ended |

### 9.6 Claims: `GET /transactions`

Tabs: Pending · Approved · Rejected · Reversed · All. Filters: account, date range. Admin sees merchant,
subadmin and vendor ids.

- **Pending:** admin can **Approve** / **Reject** exactly like the vendor (§8.5). Use it when a vendor is
  unresponsive.
- **Rejected → "Override: approve"** → `POST /admin/transactions/:id/override { action: "approve", reason }`.
  Credits the original claimed amount.
- **Approved → "Override: reverse"** → `{ action: "reverse", reason }`. Removes the credit. If the merchant
  already withdrew or requested it: `409 Cannot reverse: the money has already been withdrawn or requested.
  Resolve those withdrawals first.` (with `currentAvailablePaise`). Show the amount and point admin to
  Withdrawals.
- Every override asks for a reason (≥ 4 chars) and is written to the audit log.

### 9.7 Rate card: `GET /rate-cards` + `PUT /admin/rate-cards/:accountType`

Three cards: Savings / Current / Corporate. Fields: Admin %, Vendor %, Sale price (₹), Monthly rent (₹).
Each saves independently and only sends changed fields. Show "Last updated …". Explain in the header: "Copied
onto an account when you approve it. Changing it doesn't affect approved accounts."

### 9.8 Record rent / sale payment: `POST /admin/accounts/:id/earnings`

From a sold or rented account:

- **Sold:** amount (pre-fill the sale price), UTR, notes. Sends `period: "sale"`. Hide the button after it's
  recorded (`409 Payment for sale is already recorded`).
- **Rented / rent ended:** show the `periodsDue` list. Each unpaid period has a **Mark paid** button → amount
  (pre-fill the monthly rent), UTR, notes, with `period: "YYYY-MM"`. Future periods aren't offered (the server
  answers 400).

### 9.9 Withdrawals: `GET /withdrawals`

Tabs: **Disputed** (default when count > 0) · Paid (awaiting merchant) · Requested · Completed · All.

**Resolve dialog** (`POST /admin/withdrawals/:id/resolve`):

| Action | Allowed from | Effect |
|---|---|---|
| **Complete** | paid, disputed | As if the merchant confirmed: payout recorded, both fees earned |
| **Reverse** | requested, paid, disputed | Everything goes back to the merchant's balance; nobody earns a fee |

Show the payee, amount, fee split, vendor UTR, dispute reason and timestamps. A reason is required. Typical
use: the merchant confirms by phone → Complete; the vendor never paid → Reverse.

### 9.10 Audit log: `GET /admin/audit`

A chronological list: time, actor, action, entity (tap → that account, claim or withdrawal), reason. Filter
by entity id.

---

## 10. Subadmin additions

Menu item **Vendor accounts**.

| Screen | Call | Notes |
|---|---|---|
| Accounts list | `GET /accounts` | Only accounts admin gave to this subadmin. Columns: account holder, bank + number, merchant (`assignedUserName`, "Unassigned" when null), balance, fee % (`feePercent`). No vendor identity, no split. Filter: merchant (`assignedUserId=<id>` or `none`). |
| Assign merchant | `PUT /accounts/:id/assign-user { assignedUserId }` | Picker = this subadmin's own merchants (`role: user`). "Remove merchant" sends `null`. 409 while the account holds money or pending claims: show the message. |
| File claim for a merchant | `POST /accounts/:id/transactions` | Same form as the merchant (§11.3). |
| Claims | `GET /transactions` | Claims on their accounts. Cancel only the ones they filed. |
| Withdrawals | `GET /withdrawals` | Read-only. Subadmins can't withdraw, confirm or dispute. |

---

## 11. Merchant additions

A new section **Vendor accounts**, separate from QR and bank accounts. Its balance is **not** part of the
merchant's existing totals.

### 11.1 List: `GET /accounts`

Cards: bank + masked number, holder name, UPI, **Available ₹…** (`amountAvailableForWithdrawal`), fee
% (`feePercent`), state. An `inactive` account shows "Not accepting new payments. You can still withdraw."

### 11.2 Account detail

- **Pay-in details to share with payers:** holder, account number, IFSC, UPI, with copy buttons.
- **Limits:** "Min ₹… · Max ₹… per payment" (hide when 0).
- **Balance:** available · open withdrawals (`withdrawalRequestedAmount`) · total received · total withdrawn ·
  fees paid (`feesPaidPaise`).
- **Buttons:** **I've made a payment** (active only) · **Withdraw**.
- **Tabs:** Claims (`GET /transactions?accountId=`) · Withdrawals (`GET /withdrawals?accountId=`).

### 11.3 Submit a claim: `POST /accounts/:id/transactions`

| Field | Rule |
|---|---|
| Amount (₹) | > 0; within min/max if set (validate on device using `minTxnPaise`/`perTxnLimitPaise`; the server re-checks with 422) |
| UTR / reference | 6–40, letters/digits/dashes, force uppercase |
| Payer name | optional, ≤ 120 |
| Paid at | optional date-time picker, not in the future |
| Remarks | optional, ≤ 500 |

On `201`:
- Toast "Submitted, waiting for confirmation".
- If `dailyLimitWarning != null`, show an info banner: "This account passed its daily limit
  (₹used / ₹limit). Your payment was still recorded."

On `409 Reference number already used`, show it under the UTR field.

**Pending** claims show a **Cancel** button (`POST /transactions/:id/cancel`).

### 11.4 Withdraw (three steps)

**Step 1: amount.** The merchant enters what they want to **receive**. On change (debounced 400 ms) call
`POST /accounts/:id/withdraw/preview { amount }`:

```json
{ "success": true, "amountPaise": 100000, "amountRs": 1000, "feePercent": 3,
  "feePaise": 3000, "feeRs": 30, "totalPaise": 103000, "totalRs": 1030,
  "availablePaise": 500000, "availableRs": 5000, "sufficient": true }
```

Show:
- You receive ₹1,000.00
- Fee (3%) ₹30.00
- **Deducted from balance ₹1,030.00**
- Available ₹5,000.00

When `sufficient == false`, disable Continue and show "Not enough balance". Offer a **Max** helper: keep
lowering the amount until the preview's `sufficient` is true. Don't compute fees on the device.

**Step 2: payee.** Mode toggle **UPI** / **Bank**.
- UPI: holder name + UPI ID.
- Bank: holder name + account number + IFSC.
- Remember the last payee locally (per account) for convenience. It's not stored on the server.

**Step 3: confirm and submit.** `POST /accounts/:id/withdraw`, **echoing the preview's figures**:

```json
{ "amount": 1000, "fee": 30, "total": 1030, "mode": "upi", "holderName": "Ravi Kumar", "upiId": "ravi@ybl" }
```

- `400 Fee mismatch…` / `Amount mismatch…`: the rate changed. Re-run the preview, show the new figures, ask
  the merchant to confirm again. The body carries the correct `feePaise`/`totalPaise`.
- `400 Insufficient balance` (with `availablePaise`): refresh the balance.
- `201`: go to the withdrawal detail with status **Requested**: "The account owner will send the money and
  enter a reference. You'll be asked to confirm receipt."

### 11.5 My withdrawals: `GET /withdrawals`

Card: amount, fee, status chip, payee, created time, and once paid: **UTR** + paid time.

| Status | Merchant sees | Buttons |
|---|---|---|
| requested | "Waiting for payment" | **Cancel** |
| paid | "Sent with UTR XXXX on … Check your bank." | **Yes, I received it** · **I didn't receive it** |
| disputed | "Under review by admin" + your reason | **I received it after all** (confirm) |
| completed | "Received" + confirmed time | — |
| cancelled / rejected / reversed | the reason if any (`rejectReason` / `resolveReason`) | — |

- **Confirm** (`POST /withdrawals/:id/confirm`): use a confirm dialog, "Only confirm after the money shows in
  your bank. This can't be undone."
- **Dispute** (`POST /withdrawals/:id/dispute { reason }`): a reason is required (≥ 4 chars).
- Poll every 20 s while any withdrawal is `paid`.

---

## 12. Form validation rules

Validate on the device with the same rules the server uses, so the user sees errors before submitting:

| Field | Regex / rule | Server message |
|---|---|---|
| Account number (listing, bank payee) | `^[A-Za-z0-9]{6,24}$` (trim) | `Invalid accountNumber: 6–24 letters/digits` |
| IFSC | `^[A-Z]{4}0[A-Z0-9]{6}$` (uppercase first) | `Invalid IFSC code format (e.g. SBIN0001234)` |
| UPI ID | `^[a-zA-Z0-9.\-_+]+@[a-zA-Z0-9]+$` | `Invalid UPI ID format (expected handle@provider)` |
| Claim reference (UTR) | `^[A-Z0-9-]{6,40}$` (uppercase first) | `Invalid referenceNumber (6–40 letters, digits or dashes)` |
| Vendor payout UTR | `^[A-Za-z0-9-]{5,40}$` | `Invalid UTR (5–40 letters, digits or dashes)` |
| Money amounts | number > 0 | `Invalid amount` |
| Limits, prices, rent | number ≥ 0 (0 = none) | `Invalid minTxn (rupees, 0 = no limit)` etc. |
| Percent | 0 – 100 | `Invalid adminPercent (0–100)` |
| Min vs max | min ≤ max when both > 0 | `minTxn cannot be above perTxnLimit` |
| Bank name | 1–100 chars | `bankName is required (max 100 chars)` |
| Holder name | 1–120 chars | `accountHolderName is required (max 120 chars)` / `holderName is required` |
| Reasons (reject, dispute, override, resolve) | ≥ 4 chars after trim | `Reason too short` |
| Paid-at | valid date, not in the future | `Invalid paidAt (ISO date, not in the future)` |
| Rent period | `YYYY-MM`, must be a due period | `period must be YYYY-MM for a rented account` / `Rent for 2026-12 is not due on this account` |
| Date filters | `YYYY-MM-DD`, from ≤ to, ≤ 366 days | `Dates must be YYYY-MM-DD` / `from must be on or before to` / `Date range cannot exceed 366 days` |

---

## 13. Error catalogue

Show `error` verbatim unless the UI column says otherwise.

### Accounts

| Status | Message | Where / UI |
|---|---|---|
| 400 | `bankName is required …`, `Invalid IFSC …`, `accountType must be one of: savings, current, corporate`, `mode must be one of: commission, sell, rent` | form field |
| 400 | `accountNumber cannot be changed; list a new account instead` | shouldn't happen: the field is read-only |
| 400 | `Nothing to update` | nothing changed: disable Save until something changes |
| 400 | `No commission rates for <type>: set the rate card or send adminPercent and vendorPercent` (also `No sale price…`, `No monthly rent…`) | approve dialog: make the rate fields required |
| 400 | `Manager must be an existing subadmin.` | picker should only list subadmins |
| 404 | `Vendor account not found.` | also returned when the account isn't yours: pop back |
| 409 | `This account number is already listed.` | listing form, under account number |
| 409 | `Account is <state>` | action no longer valid: refresh |
| 409 | `Approved accounts can only be changed by admin.` | vendor edit after approval: hide Edit |
| 409 | `mode and accountType can only change while the account is under review` | admin edit: lock those fields after approval |
| 409 | `Only commission accounts that are active or inactive can be assigned (this one is <state>).` | hide Assign on other states |
| 409 | `Unassign the merchant first: they are not under the new subadmin.` | dialog |
| 409 | `Assign the account to a subadmin first.` | subadmin/admin merchant picker |
| 409 | `Merchant is not under this account’s subadmin.` | picker should only list that subadmin's merchants |
| 409 | `This account still holds ₹… available and ₹… in open withdrawals for its current merchant. Settle it before reassigning.` | dialog |
| 409 | `Cannot reassign: N payment claim(s) are still pending.` / `Cannot delist: …` | dialog |
| 409 | `End the rental instead.` | delist on a rented account |

### Claims

| Status | Message | UI |
|---|---|---|
| 400 | `Vendor account is not active` | hide "I've made a payment" on inactive accounts |
| 400 | `Invalid referenceNumber …`, `Invalid amount`, `Invalid paidAt …`, `Reason too short` | form field |
| 403 | `You can only cancel your own payment claims` | hide Cancel on claims you didn't file |
| 404 | `Transaction not found` | refresh list |
| 409 | `Vendor account is not assigned to any merchant` | refresh |
| 409 | `Reference number already used` | UTR field |
| 409 | `Transaction already <status>` | **neutral**: refresh the row |
| 409 | `Transaction is being resolved. Please try again.` / `This reference number is being processed. Please try again.` | auto-retry once |
| 409 | `Cannot reverse: the money has already been withdrawn or requested. Resolve those withdrawals first.` + `currentAvailablePaise` | admin override dialog |
| 422 | `Amount is below this account's minimum of ₹…` / `Amount exceeds this account's per-transaction limit of ₹…` | amount field |

### Withdrawals

| Status | Message | UI |
|---|---|---|
| 400 | `This account does not support withdrawals` | sell/rent or delisted: hide Withdraw |
| 400 | `Fee mismatch. Refresh the withdrawal preview and try again.` / `Amount mismatch. …` + `feePaise`, `totalPaise` | re-run preview, re-confirm |
| 400 | `Insufficient balance` + `availablePaise`, `totalPaise` | refresh balance |
| 400 | `mode must be 'bank' or 'upi'`, `holderName is required`, `Invalid UTR …`, `Invalid UPI ID …`, `Invalid accountNumber …`, `Invalid IFSC …` | form field |
| 404 | `Withdrawal not found` (also when it isn't yours) | refresh |
| 409 | `Withdrawal already <status>` | **neutral**: refresh |
| 409 | `Vendor account is currently being processed. Please try again in a moment.` | auto-retry once |

### Rent / sale, dashboards

| Status | Message | UI |
|---|---|---|
| 400 | `period must be 'sale' for a sold account` / `period must be YYYY-MM for a rented account` / `Rent for … is not due on this account` / `Commission accounts have no rent or sale earnings` | shouldn't happen if you only offer due periods |
| 409 | `Payment for <period> is already recorded` | refresh the period list |
| 400 | date-filter messages (§12) | date picker |
| 404 | `Vendor not found` | admin vendor detail with a bad id |

### Anywhere

| Status | Message | UI |
|---|---|---|
| 403 | `Vendor logins can only use the vendor portal.` | a vendor hit a non-vendor API: route to the vendor app |
| 403 | `Not authorized for this action.` / `Not authorized: Admin required.` | menu gating bug: hide the entry point |
| 400 | `Invalid or expired pagination cursor` / `Invalid cursor format` | reset the list |

---

## 14. QA scenarios

Run these end to end on staging data before release.

1. **Onboarding:** admin creates a vendor → the vendor logs in → lands in the vendor app → any old-app API
   call returns 403 → `/me` shows role `vendor`.
2. **Listing:** the vendor lists a savings/commission account → admin sees it in the review queue with
   rate-card values pre-filled → approve → the vendor sees it Active with his % → the vendor can no longer edit it.
3. **Duplicate:** a second vendor lists the same number → "already listed".
4. **Assignment:** admin assigns subadmin A → subadmin A assigns merchant A1 → subadmin B can't see it →
   merchant A1 sees it under Vendor accounts, **not** in QR or bank totals.
5. **Claim happy path:** A1 submits ₹1,000 → the vendor sees it (no merchant name) → approves with ₹999.50 →
   A1's available = ₹999.50 immediately.
6. **Claim limits:** below the minimum → 422 · above the max → 422 · over the daily limit → accepted + warning banner.
7. **Claim race:** the vendor approves while A1 cancels → one wins, the other gets "already …" as a neutral toast.
8. **Override:** the vendor rejects → admin override-approves → balance credited → admin reverses → balance
   back to 0 → the audit log shows both.
9. **Reverse blocked:** approve ₹1,000, A1 requests a withdrawal, admin tries to reverse the claim → 409 with
   the explanation.
10. **Withdrawal happy path:** at 2% + 1%, A1 previews ₹1,000 → fee ₹30, total ₹1,030 → submits → the vendor
    sees "Pay ₹1,000 to …" with commission ₹10 → marks paid with a UTR → A1 sees the UTR → confirms →
    completed → the dashboard shows admin commission +₹20, vendor +₹10, paid out +₹1,000.
11. **Fee change mid-flow:** admin edits the account's % between A1's preview and submit → "Fee mismatch" →
    the app re-previews and re-confirms.
12. **Cancel / reject:** A1 cancels a requested withdrawal → balance restored · the vendor rejects one →
    balance restored, reason shown to A1.
13. **Dispute:** vendor marks paid → A1 disputes → the admin Withdrawals badge shows 1 → admin reverses →
    A1's balance restored.
14. **Reassign guard:** subadmin A tries to remove A1 while A1 has a balance → 409 message.
15. **Sell:** a sell listing → admin approves at ₹25,000 → admin records the sale payment → the vendor's
    earnings show paid; a second record → 409.
16. **Rent:** a rent listing → approve → the vendor sees period 1 due → admin marks it paid → next month two
    periods, one outstanding → end rental → no new periods accrue.
17. **Delist:** the vendor requests a delist → admin sees the badge → delist is refused while there's a
    balance → after it's withdrawn, delist works and assignments clear.
18. **Employee:** an employee login sees no Vendors menu; a direct call gets 403.
19. **Units:** check every amount on every screen against paise ÷ 100, with Indian digit grouping.

---

## 15. Not in this version

| Not included | What to do instead |
|---|---|
| Realtime sockets for vendor events | Poll (§4.6) |
| Employee access | Hide the Vendors menu for employees |
| T+1 hold | None: money is withdrawable once a claim is approved |
| Saved payee accounts on the server | Remember the last payee locally |
| Partial rent payments | One recorded payment per month |
| Pending-claim cap per merchant | None |
| Tracking collection of admin's commission from vendors | Shown as a figure only |
| Proof uploads (screenshots) for claims or payouts | UTR text only |

Ask backend before building anything that depends on these.
