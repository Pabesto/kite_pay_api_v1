# Customer Payout — Flutter change request: "Not received" objections on paid payouts

**Audience:** the Flutter agent working on the KitePay / NycPay / CityPay apps (customer payout screens for
users, and the payout queue + notification centre for admin / employees).
**Contract:** [`CUSTOMER_PAYOUT_FRONTEND.md`](CUSTOMER_PAYOUT_FRONTEND.md) §5.4b (user), §6.2c (staff),
§5.5 (timeline rows), §9.1 (events), §6.5c (`openObjections`). This file lists the UI edits; the contract
is the source of truth for field names and error text.

## Why

A merchant could not tell us when a *paid* customer payout never reached the customer. Now they can raise
an **objection** on a paid row with a remark; staff see it in realtime, check it, and resolve it as
**Cleared** (the transfer was fine) or **Repaid** (we sent the money again under a new UTR, naming the
company and employee as in the Paid dialog). The payout's accounting status never changes.

## The one rule that drives every screen

`status` stays `"paid"` for the whole objection lifecycle. **Render the badge from `displayStatus`, not
`status`.** `displayStatus` is one of:

| `displayStatus` | Meaning | Badge |
|---|---|---|
| `pending` / `rejected` / `cancelled` | unchanged, equals `status` | as today |
| `paid` | paid, no objection ever, or none open | green "Paid" (as today) |
| `objection_received` | merchant says not received, staff has not resolved yet | orange "Objection received" |
| `cleared` | staff checked, the original transfer was fine | green "Cleared" (sub-label "Paid") |
| `repaid` | staff re-sent the money under a new reference | green "Repaid" (sub-label "Paid again") |

Keep `?status=paid` as the filter that lists all four paid-family rows. Add the objection filter on top
(below).

## New fields on every payout row (user and staff)

```jsonc
"displayStatus": "objection_received",
"objection": {                       // null when never objected
  "status": "open",                  // open | resolved
  "remark": "Customer says not received",
  "raisedAt": "2026-10-20T06:10:00.000Z", "raisedBy": "<userId>",
  "outcome": null,                   // cleared | repaid once resolved
  "resolveRemark": null, "resolvedAt": null, "resolvedBy": null,
  "count": 1                         // how many times this payout was objected
},
"objectionInMinutes": 95,            // paidAt → raisedAt
"objectionResolvedInMinutes": null,  // raisedAt → resolvedAt
"repaidAt": null,                    // set when resolved as repaid
"originalReferenceNumber": null      // the FIRST UTR, kept once a repaid resolve overwrote referenceNumber
```

Model changes: add these to the payout model (`objection` as a nullable sub-model), parse `displayStatus`
with a fallback of `status` so the app still works against an older server.

## User app (merchant)

1. **Row badge** uses `displayStatus` (table above).
2. **Paid row detail → "Not received?" action.** Visible only when `status == "paid"` and
   `objection == null || objection.status == "resolved"`. Opens a bottom sheet with one multiline field
   "What happened?" (4–500 chars, counter) and a "Raise objection" button. Call
   `POST /api/payout/requests/:id/objection { remark }`. On 200 replace the row with `payout` from the
   response. Errors: `409` "An objection is already open on this payout" → refresh the row; `400` → show
   `error` under the field.
3. **Objection card on the detail screen** (when `objection != null`): remark, "Raised {raisedAt}
   ({objectionInMinutes} min after payment)", and once resolved: outcome chip, `resolveRemark`,
   "Resolved {resolvedAt} ({objectionResolvedInMinutes} min)". When `outcome == "repaid"` show the new
   `referenceNumber` with "Original ref: {originalReferenceNumber}" under it and `repaidAt`.
4. **Timeline** (§5.5) gets two rows: "Objection raised" and "Cleared / Repaid". Use the server minutes,
   never compute on device.
5. **Filter chips** on the requests list: add "Objections" → `?objection=any` (and optionally
   "Open objections" → `?objection=open`). Stacks with the existing status chips.
6. **Realtime:** on `payout:update` with `type == "objection_resolved"` for one of my payouts: toast
   "Payout {payoutId}: {outcome == 'repaid' ? 'repaid with new reference ' + referenceNumber : 'checked and cleared'}"
   and refresh that row. `objection_raised` on my own device = silent row refresh.

## Staff app (admin / employee with `edit_payouts`; subadmin read-only)

1. **Queue badge** from `displayStatus`; `objection_received` rows get the orange badge plus an
   exclamation icon. Add a queue filter "Objections: open / resolved / any" → `?objection=open|resolved|any`.
2. **Detail screen objection card:** merchant remark, raised time, waiting minutes
   (`now - raisedAt` on the staff side is fine for a live counter, but show the server
   `objectionInMinutes` for the paid→raised gap), `objection.count` when > 1 ("2nd objection").
3. **Resolve dialog** (only when `objection.status == "open"`, only for `edit_payouts`): two radio options.
   - **Checked & cleared** → optional remark (≤500) → `POST /api/payout/admin/requests/:id/objection/resolve
     { outcome: "cleared", remark }`.
   - **Repaid with new reference** → reuse the **Paid dialog widgets**: reference number (5–100, must
     differ from the current one), From company (pick list), Paid by (pick list), Paid via
     (type-to-search source accounts), optional remark → `{ outcome: "repaid", referenceNumber,
     fromCompany, paidBy, paidVia, remark }`. Pick lists come from `GET /api/payout/admin/payment-options`
     exactly as the Paid dialog does.
   - On 200 replace the row with `payout` from the response and close. Errors to surface inline:
     `400 New reference number must differ from the current one`, `400 fromCompany is required` /
     `paidBy is required` / "must be one of the configured …", `409 Reference number already used on
     payout cpo_… ` (show with a link to `conflictPayoutId`), `409 Objection was already resolved` (refresh),
     `400 No open objection on this payout` (refresh).
4. **Repaid rows** show the new `referenceNumber` as the main reference and "Original: {originalReferenceNumber}"
   beneath it, plus `repaidAt`, the new `fromCompany` / `paidBy` / `paidVia`. The duplicate-reference and
   export screens need no change (they already read `referenceNumber`; export rows now also carry the
   fields above).
5. **Realtime + notification centre:**
   - `payout:alert` with `type == "objection_raised"` → **dialog + sound**, same treatment as
     `stale_pending`: title "Payout objection", body "{customerName} · ₹{amountPaise/100} · ref
     {referenceNumber}", the merchant's `remark`, and an "Open" button that deep-links to `payoutId`.
     This alert is always on (not behind the alerts toggle), so do not gate it on `alertsEnabled`.
   - `payout:update` with `type == "objection_raised"` → refresh the queue row + bump the badge;
     `type == "objection_resolved"` → refresh the row.
   - Add the event to the per-event sound/popup settings screen (§9.2) as "Payout objection".
6. **Badge on load:** `GET /api/payout/admin/alerts` now returns `openObjections` (oldest first) and
   `counts.openObjections`. Show the count on the queue tab / bell, and list them in the alerts screen
   as a third section under low-balance and stale-pending, each row deep-linking to the payout.

## Do not

- Do not change wallet balances, totals or report numbers on the client when an objection is raised or
  resolved. Nothing moves on the server either; the row is still a paid payout.
- Do not treat `objection_received` as a distinct `status` filter value; the server rejects it (400).
- Do not build a "Refunded" outcome. Bank refunds are handled off-system for now; the server has no such
  outcome and returns 400 for it.
- Do not compute minutes on device for the timeline; use the `*InMinutes` fields.

## Before you start

- The API must be deployed with this change. On an older server `displayStatus` is absent (fall back to
  `status`), `objection` is absent (treat as null), and the two new routes return 404. Check:
  `GET /api/payout/requests?limit=1` must include `"displayStatus"`.
- Pull the current `CUSTOMER_PAYOUT_FRONTEND.md` into the app repo root; the copy there predates this.

---

## Prompt for the UI agent (copy as-is)

```
You are working in the Flutter app for the KitePay payments platform. Implement the "Not received" objection
flow for customer payouts, exactly as specified in CUSTOMER_PAYOUT_OBJECTIONS_FLUTTER.md (the change list)
and CUSTOMER_PAYOUT_FRONTEND.md §5.4b, §6.2c, §5.5, §9.1, §6.5c (the API contract). Both files are at the
repo root; read both fully before editing anything.

Scope:
1. Payout model: add displayStatus (fallback: status), nullable objection sub-model (status, remark,
   raisedAt, raisedBy, outcome, resolveRemark, resolvedAt, resolvedBy, count), objectionInMinutes,
   objectionResolvedInMinutes, repaidAt, originalReferenceNumber.
2. Everywhere a payout status badge is rendered (user list, user detail, staff queue, staff detail,
   notification rows), render from displayStatus with the mapping: paid=green "Paid",
   objection_received=orange "Objection received", cleared=green "Cleared", repaid=green "Repaid";
   other values unchanged.
3. User app: "Not received?" action on paid rows (hidden while an objection is open) → bottom sheet with a
   4–500 char remark → POST /api/payout/requests/:id/objection. Objection card + two timeline rows on the
   detail screen. "Objections" filter chip (?objection=any). Toast on payout:update type
   objection_resolved.
4. Staff app: queue filter objection=open|resolved|any; objection card on detail; Resolve dialog with two
   radios — "Checked & cleared" (optional remark) and "Repaid with new reference" (reuse the existing Paid
   dialog fields: reference number, From company, Paid by, Paid via, remark; pick lists from
   GET /api/payout/admin/payment-options) → POST /api/payout/admin/requests/:id/objection/resolve.
   Surface the exact server error strings listed in the change doc inline. Repaid rows show the new
   reference with "Original: <originalReferenceNumber>" under it.
5. Realtime: payout:alert type objection_raised → dialog + sound (same component as stale_pending), deep
   link to the payout, not gated by the alerts toggle; payout:update type objection_raised /
   objection_resolved → refresh the row and badge. Add "Payout objection" to the per-event notification
   settings. Use GET /api/payout/admin/alerts → openObjections + counts.openObjections for the badge on
   load and a third section in the alerts screen.

Rules: never compute minutes on device (use the *InMinutes fields); never change any amount or total on the
client for an objection; do not add a "Refunded" outcome; do not add objection_received as a status filter
value. Reuse the existing Paid-dialog widgets and the existing alert dialog component rather than building
new ones. Keep the app working against an older server (displayStatus/objection absent → fall back).
When done, list every file you touched and any contract field you could not find on the server.
```
