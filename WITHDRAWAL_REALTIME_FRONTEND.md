# Withdrawal Requests — Realtime (Socket.io) Frontend Contract

Socket events for **QR withdrawal requests** (the `withdraw.js` flow: a merchant asks to withdraw
from a QR; an admin or an employee with `edit_withdrawals` approves or rejects). This is the
withdrawal counterpart of the customer-payout events in `CUSTOMER_PAYOUT_FRONTEND.md` §9 and is
built on the same machinery — same connection, same "rooms are joined for you" model, same
`{ type, userId, …, at }` payload convention — so a client that already handles `payout:update`
adds this with one more listener.

**Scope of this document:** only the new `withdrawal:update` event and the rooms behind it. The
REST endpoints (`/withdraw_new`, `/withdrawals_paginated`, `/withdrawals/approve_new`,
`/withdrawals/reject_new`) are unchanged and remain the source of truth for the list.

---

## 1. Connection and rooms

Connect exactly as for everything else: Appwrite JWT in `auth: { token }`, websocket transport.
**There is nothing to subscribe to** — the server puts each socket into its rooms on connect:

| Who you are | Rooms joined (withdrawal-relevant) | You receive |
|---|---|---|
| any user | `room:user:<userId>` | events about **your own** withdrawals |
| `role: 'admin'` | `room:admins` | **every** withdrawal event, all tenants |
| `role: 'subadmin'` | `room:withdrawal_sub:<own userId>` | events about your own users' withdrawals (and your own) |
| `role: 'employee'` (**no label needed**) | one `room:withdrawal_sub:<subadminId>` per subadmin assigned to you | events about those subadmins' users |

This mirrors `GET /withdrawals_paginated` exactly: whoever that route would show a request to,
receives the event for it — and nobody else. Note the difference from payouts: **employees need
no label** to receive withdrawal events, because they need none to list withdrawals. Approving
still requires `edit_withdrawals`; the event only tells them something happened.

> Staff room joins land a tick after `connect`. Load the list once on screen mount and treat
> every event as a **"refresh now" hint, never the source of truth** — re-fetch the list rather
> than mutating local state from the payload.

---

## 2. The event: `withdrawal:update`

One socket event, discriminated by `payload.type`. Exactly one event per state change, sent
**after** the withdrawal document is committed — a client can safely re-fetch on receipt and
will see the new state.

| `payload.type` | Fired when | Who acted (`actor`) | Suggested treatment |
|---|---|---|---|
| `requested` | a withdrawal request is created (by the merchant, or by admin/subadmin on their behalf) | the requester | **dialog + sound** for admins/employees — this is the one that needs a human |
| `approved` | admin/employee approves; UTR recorded | the approver | toast; the merchant's own device should show it prominently |
| `rejected` | admin/employee rejects with a reason | the rejecter | toast with the reason; prominent on the merchant's device |

### 2.1 Payload

```json
{
  "type": "requested",
  "userId": "user_8f2…",
  "withdrawalId": "wdh_1788436820606417",
  "userName": "Ramesh Stores",
  "parentId": "sub_3a1…",
  "actor": { "userId": "admin_1", "role": "admin", "name": "Ops Admin" },
  "withdrawal": {
    "withdrawalId": "wdh_1788436820606417",
    "docId": "68c3…",
    "userId": "user_8f2…",
    "qrId": "qr-reception-01",
    "holderName": "Ramesh Kumar",
    "companyName": "Ramesh Stores",
    "mode": "upi",
    "status": "pending",
    "utrNumber": null,
    "rejectionReason": null,
    "amountRs": 1022.0,
    "preAmountRs": 1000.0,
    "commissionRs": 22.0,
    "amountPaise": 102200,
    "preAmountPaise": 100000,
    "commissionPaise": 2200,
    "walletCreditFailed": false,
    "createdAt": "2026-09-13T09:14:02.113Z",
    "processedAt": null
  },
  "at": "2026-09-13T09:14:02.400Z"
}
```

| Field | Notes |
|---|---|
| `type` | `requested` \| `approved` \| `rejected` |
| `userId` | the **merchant** whose withdrawal this is (never the actor) |
| `withdrawalId` | business id `wdh_…` — the id every withdrawal REST endpoint takes. **De-dupe on `withdrawalId` + `type`.** |
| `userName` / `parentId` | merchant's display name and their subadmin — for the dialog title and for grouping |
| `actor` | who performed the action: `{ userId, role, name }`. On `requested` this is the requester (may be the merchant themself, or an admin/subadmin acting for them). May be `null` if unknown |
| `withdrawal.mode` | `upi` \| `bank` \| `wallet` (`wallet` = internal transfer to the merchant's payout wallet, no bank details involved) |
| `withdrawal.status` | `pending` \| `approved` \| `rejected` — the state **after** this event |
| `withdrawal.utrNumber` | set on `approved`. For `mode:'wallet'` it is the literal `PAYOUT_WALLET` |
| `withdrawal.rejectionReason` | set on `rejected` |
| `withdrawal.*Rs` / `*Paise` | **both are provided.** Withdrawal documents store rupees (the one place in this API that does), so `*Rs` is the stored value and `*Paise` is derived. Use whichever your screen already uses; never mix them in one sum |
| `withdrawal.preAmountRs` | what the merchant receives; `amountRs` = `preAmountRs` + `commissionRs` is what leaves the QR |
| `withdrawal.createdAt` / `processedAt` | UTC ISO. Render in IST (`Asia/Kolkata`) |
| `at` | UTC ISO, when the event was emitted |

### 2.2 What is deliberately NOT in the payload

**No `upiId`, `accountNumber`, `ifscCode`, or `bankName`.** Rooms are broadcast channels and the
dialog does not need account details to say "Ramesh Stores requested ₹1,000 — open". When the
operator opens the request to pay it, fetch the row from `/withdrawals_paginated` (or the detail
your screen already uses) — that path is authenticated per request and is where account details
belong. Do not build a "pay from the dialog" flow that expects them in the event.

---

## 3. Dialog behaviour that matters

1. **De-duplicate.** A single action emits once, but reconnects and multi-device sessions can
   surface the same event twice. Key your notification centre on `withdrawalId + type`.
2. **`requested` is the actionable one.** Popup + sound for admins and for employees holding
   `edit_withdrawals`; a quieter toast for employees who can only view. `approved` / `rejected`
   are informational for staff — the merchant is the one who cares, and they receive it in their
   own room.
3. **Re-fetch, don't patch.** After any event, refresh the withdrawals list / badge count from
   REST. The payload is enough to *render the notification*, not to keep a list consistent.
4. **`mode:'wallet'` approvals.** The `approved` event fires when the withdrawal is approved,
   *before* the payout-wallet credit runs. If that credit later fails, no second withdrawal event
   is sent — the approval stands and admin retries the credit from the payout screen. On success
   a `payout:update` `wallet_changed` (`reason: 'withdrawal_credit'`) follows for anyone in the
   payout rooms. Don't wait on it to mark the withdrawal approved.
5. **Merchant-side.** A merchant only ever receives events about their own requests
   (`room:user:<userId>`). If admin created the request on their behalf, they still get
   `requested` — show it, since they didn't press the button.

---

## 4. Kill switch

`withdrawal_realtime_enabled` (ConfigManager, default **on**). When set to `false`, no
`withdrawal:update` events are emitted at all; every REST endpoint behaves identically. There is
no per-user opt-out for withdrawal events (unlike `payoutRealtimeDisabled` for payouts) — if one
is needed, that is a backend change; ask first.

---

## 5. Not available (don't design around these)

| Wanted | Status |
|---|---|
| Acknowledge / assign / "I'm handling this" | no endpoint — every staffer sees the same open request until it is approved or rejected |
| Per-user mute for withdrawal events | none (payouts have one, withdrawals don't) |
| Platform-wide withdrawal notices (windows opened/closed, limits changed) | none — no `room:withdrawal_staff` exists |
| Bank/UPI details in the event | never — see §2.2 |
| Events from admin-side edits that bypass `/withdraw_new`, `approve_new`, `reject_new` | none — only those three routes emit |
| Backfill / replay of missed events after reconnect | none — refresh the list on reconnect |

---

## 6. Quick client checklist

- [ ] One `socket.on('withdrawal:update', …)` handler; branch on `payload.type`
- [ ] Notification centre keyed on `withdrawalId + type`
- [ ] `requested` → dialog + sound for admins and `edit_withdrawals` employees; toast otherwise
- [ ] Every event triggers a REST re-fetch of the list / pending badge
- [ ] Amounts rendered from `*Rs` or `*Paise` consistently — never both in one figure
- [ ] Account details fetched from REST on open, never expected in the event
- [ ] `mode:'wallet'` approvals not held waiting for the wallet credit
- [ ] Reconnect → reload the list (no replay)
