# KitePay API — Engineering Standards

This is a **production payments API** (India, UPI/QR pay-ins, withdrawals, partner API) handling real money for live merchants. It runs as a **single Node process** (Render, `kite-pay-api-v2.onrender.com`). There is no staging environment, no CI, and no linter — **the only gates are this document and `npm test`**. The bar for every change: *money totals must never be corrupted, credited twice, or silently lost.* When a rule below conflicts with "cleaner code", the rule wins.

## Repo map — what is live and what is dead

Live code (all flat in this directory):

- `server.js` — entrypoint. Boot, middleware, auth middlewares, the 3 inbound payment webhooks (`/razorpay-webhook`, `/webhook`, `/payment-webhook`), shared money helpers (`updateQrTotalAtomic`, `updateDailyQrTotal`), lock primitives, counter flush, interval jobs, graceful shutdown, PineLabs poller wiring.
- `admin.js` — admin panel router (users, transactions, edits/deletes/status flags, manual review control plane + sweeper, summaries, config CRUD, QR hold-and-reset).
- `qrcode.js`, `qrOwnerCache.js`, `userMetaCache.js`, `dashboardCounters.js` — QR lifecycle + caches.
- `withdraw.js`, `wallet.js`, `withdrawalAccounts.js` — payouts, wallet, saved accounts.
- `payout.js` — Customer Payout: per-user **payout wallet** (funded by `mode:'wallet'` withdrawals — no commission, exempt from time windows and the max-pending cap), saved customer beneficiary accounts (optional `upiId`, required for UPI payouts), customer payout requests (admin marks paid/rejected; subadmins read their own users' rows), admin manual wallet adjustments, separate payout-commission ledger (daily/monthly/all-time rollups). Frontend contract: `CUSTOMER_PAYOUT_FRONTEND.md`. Schema: `scripts/setup-payout-schema.js`. (The older `wallet.js` rupee wallet is unrelated — do not mix them.)
- `partnerApi.js`, `partnerWebhooks.js` — external partner API + outbound signed webhooks. Contract doc: `PARTNER_API.md` (must be kept in sync).
- `pineLabMulti.js` + `pinelabMultiPoller.js` — the **live** Pine Labs ingestion path.
- `reviewMode.js`, `reviewResolve.js`, `transactionFinalize.js` — manual-review gate, exactly-once resolver, centralized finalize pipeline. Frontend contract: `MANUAL_REVIEW_FRONTEND.md`.
- `configManager.js`, `socketServer.js`, `apiMerchants.js` — runtime config, Socket.io, merchant API.
- `scripts/` — idempotent one-off schema/backfill tools. `tests/` — Jest suite.

**Dead code — never edit, extend, call, or copy patterns from:**

- `ALL BKUP/`, `BKUP SERVER/`, `not_used/` — old snapshots (git-tracked, still dead).
- `pinelabPoller.js`, `pineLabTest.js`, `pineLabTest_only.js` — superseded pollers; nothing requires them. Pine Labs changes go in `pinelabMultiPoller.js`/`pineLabMulti.js` only (verify with the `require` at the bottom of server.js).
- `server.js:260–484` (`fetchAllTransactions`, `fetchAllManualHolds`, `calucateQrs`) — scratch analysis code with real bugs (loop-mutated queries, undeclared globals).
- `assignQrToUser` / `assignQrToUserNew` in qrcode.js — the live assignment logic is inline in `PUT /assign-qr-user/:qrId`.

## Stack & running

- Node.js + **Express 5** (not 4 — check v5 semantics before copying Express-4 idioms), CommonJS, no TypeScript, no build step.
- Data: **Appwrite** (node-appwrite; all collection IDs from `APPWRITE_*_COLLECTION_ID` env vars — never hardcode, except documented string-literal fallbacks). **Redis** (locks, counters, caches) — always optional-at-runtime: every feature must degrade to Appwrite/in-memory when Redis is down.
- Realtime: Socket.io (websocket transport only). Auth: Appwrite JWTs + bcrypt (cost 12) for API keys.
- Run: `node server.js` from this directory (`.env` here). Test: `npm test` (Jest + supertest, fully stubbed Appwrite/Redis, no network needed).
- Deployment assumes **exactly one instance**. In-memory lock fallback, reviewMode windows, the webhook retry worker, and counter dirty/stale flags all break under horizontal scaling — do not "make it scale" casually.

## Money rules (highest-priority section)

Every amount field is either integer **paise** or float **rupees**. Identify the unit before touching any amount. Getting this wrong corrupts balances by 100×.

| Storage / value | Unit |
|---|---|
| `webhook_data.amount` (all transactions, all providers) | paise |
| QR doc ledger: `totalPayInAmount`, `withdrawalApprovedAmount`, `withdrawalRequestedAmount`, `amountOnHold`, `commissionOnHold`, `commissionPaid`, `amountAvailableForWithdrawal` | paise |
| `commission_transactions.amount`, rollup `totalCommissionPaise`, daily-summary `totalsJson` values, Redis `counter:totalAmountReceived`, dashboard counter amounts, `api_merchants_requests.amount` | paise |
| Withdrawal-request docs: `amount`, `preAmount`, `commission` | **rupees** |
| Wallet collection (`balance`, `holdBalance`) and wallet transactions | **rupees** |
| Payout feature (payout.js): `payout_wallets.balancePaise/holdPaise`, `payout_wallet_transactions.*Paise`, `customer_payouts.amountPaise/commissionPaise/totalPaise`, `payout_commission_transactions.amount`, `daily_payout_commission_summaries.commissionsJson`, `monthly_/all_time_payout_commission_totals.totalCommissionPaise` | paise (`*Rs` keys in responses are derived) |
| `users_meta.commission` / `users_meta.payoutCommission` | percent rates (0–100), not money. A **missing** `payoutCommission` (null/undefined) means the config default `default_payout_commission` (fallback 1.5) — read it with `??`, never `\|\|`, because an explicit 0 is a real rate |
| Client/request inputs: admin edit amount, merchant `qr_generate`, partner `searchField=amount`, withdrawal request bodies | rupees — convert at the boundary |

Conversion and arithmetic rules:

- Rupees→paise only via `Math.round(Number(rupees) * 100)` (`toPaise` helpers). Ezetap flat webhooks send rupees — convert only with `rupeesToPaiseStrict()` (string-based, server.js). Razorpay nested webhooks send paise — use as-is; converting again overcounts 100×. Pine Labs sends rupee strings — `Math.round(parseFloat(x) * 100)` exactly once.
- Commission is computed in integer paise, rounded **up**: `calculateCommissionPaise` (`Math.ceil`). Never compute commission in floating-point rupees outside the legacy preview wrapper.
- Rupees appear in responses only as derived values (`totalRs = paise / 100`) next to the paise field — never stored.
- Never trust client-sent totals: recompute commission/total server-side in paise and reject mismatches with 400 (see `/withdraw_new`).
- `amountAvailableForWithdrawal` is **derived, never set directly**: `totalPayInAmount − withdrawalApprovedAmount − withdrawalRequestedAmount − amountOnHold − commissionOnHold − commissionPaid`. Every ledger write recomputes it from fresh component values. Debit/adjust paths (withdrawal approve/reject, admin edits/moves/deletes) run under `lock:qr` and block negative results (409 there; `/withdraw_new` returns 400 for insufficient balance). Credit paths (`updateQrTotalAtomic`) have **no** negative guard and silently return `null` after 3 retries — never rely on them to validate anything.

## Concurrency: locks are the correctness mechanism

Appwrite has no transactions. All money read-modify-writes are serialized with Redis `SET key value NX EX ttl` locks. Rules:

1. Acquire via the existing helpers — and know which family you are in. server.js's shared `acquireLock` (used by the 3 webhooks, `updateDailyQrTotal`'s daily lock on every finalize, and the Pine Labs poller) deliberately **falls back to in-memory `memLocks`** on Redis errors (availability over strictness; valid only single-instance). The **local** helpers in admin.js, withdraw.js, and apiMerchants.js **fail closed**: on contention or Redis error they treat the lock as not acquired and the route returns 409/423 — never proceed unlocked. New code fails closed unless it is an ingest path already built on the shared helper. (Known deviation — do not copy: the admin manual-transaction path logs a warning and proceeds with the QR-ledger write when its `lock:qr` acquire fails.)
2. Release **only** via the Lua compare-and-delete (`releaseLock`) in a `finally` block — plain `DEL` can free another holder's lock.
3. Locking multiple QRs/dates in one operation: sort keys before acquiring (deadlock prevention).
4. Pick TTLs that outlast the operation; keep the work under a lock bounded (never iterate an unbounded transaction set while holding one).

| Lock key | TTL | Serializes |
|---|---|---|
| `lock:qr:<qrId>` | 15s webhooks/requests, 30s withdraw approve/reject, 20s admin edits, 180s hold-and-reset | QR-ledger writes on the webhook, admin edit/delete, manual-txn, and withdrawal paths — all share this key. **Known gap:** review-approve → `finalizeTransaction` → `updateQrTotalAtomic` runs *without* `lock:qr` (optimistic 3-retry RMW) and can race a concurrent webhook — accepted today; do not widen it |
| `lock:daily:<YYYY-MM-DD>` (prefixes `del:`, `flag:`, `rej:` for those summaries) | 10s | daily-summary `totalsJson` read-merge-write; retry up to 20× with `50 + attempt*40`ms backoff, throw if never acquired |
| `lock:review:<txnId>` | 20s | exactly-once manual-review resolution |
| `lock:pinelabs:tid:<tid>` | 15s | Pine Labs per-terminal dedup |
| `rrnProcessing:<rrn>` | 30s | manual-transaction duplicate guard |
| `lock:verify:<rrn>` | 15s | merchant payment verification |
| `lock:commission:daily:<day>` / `monthly:<userId>:<YYYY-MM>` / `alltime:<userId>` | 10s | commission rollup upserts |
| `lock:payoutwallet:<userId>` | 15s request/adjust/withdrawal-credit, 30s paid/reject | every payout-wallet `balancePaise`/`holdPaise` RMW (payout.js `moveWallet`); fails closed. Lock order when nested: `lock:qr` → `lock:payoutwallet` (approve of a `mode:'wallet'` withdrawal). Ledger rows are idempotent on `(type, refId)` (unique index) |
| `lock:payoutcommission:daily:<day>` / `monthly:<userId>:<YYYY-MM>` / `alltime:<userId>` | 10s | payout-commission rollup upserts (daily JSON map, monthly and all-time per-user totals) |
| `holdreset:txnjob:lock:<qrId>` | 600s, refreshed per batch | migration single-runner |

## Ingest & the finalize pipeline (exactly-once crediting)

The three HTTP webhooks in server.js follow this exact choreography; the Pine Labs poller follows the same skeleton (lock → dedup-under-lock → create → review gate → finalize) with `lock:pinelabs:tid:<tid>` instead of the QR lock and silent skip-and-retry-next-poll instead of HTTP codes; manual-review approve joins only at step 6 (its doc already exists). Any **new** ingest path must implement the full sequence:

1. Validate payload (400 before any lock).
2. `acquireLock('lock:qr:<qrCodeId>', paymentId)` — on contention return **503 plain text** (provider retries).
3. Idempotency check on `paymentId` **under the lock** — on duplicate return **200** (provider stops retrying; a duplicate is success, not an error).
4. Resolve `ownerSubadminId` via `qrOwnerCache.resolve()` and review fields via `reviewMode.reviewFieldsFor(...)` (window from `ConfigManager.get('txn_review_window_ms', ...)`).
5. Create the `webhook_data` doc: raw provider payload JSON-stringified in `payload` (source of truth), `amount` in paise, `created_at` UTC ISO, `provider`, `status:'normal'`, `ownerSubadminId`, plus spread review fields.
6. If held for review: emit `review:pending` only — **no increments of any kind**. Otherwise `await finalizeTransaction(created)`.
7. `releaseLock` in `finally`.

`finalizeTransaction` (transactionFinalize.js) is the canonical "make it live" pipeline — QR totals, daily summary, socket emit, partner webhook dispatch, Redis counters. Never inline these side effects in new code, never run it twice for one transaction, never `await partnerWebhooks.dispatch` (fire-and-forget by contract). Error posture: daily summary and counters swallow errors; `updateQrTotalAtomic` also never throws in live wiring — it retries 3× then logs and returns `null`, and the pipeline (and the webhook's 200) continue even when the QR-total write permanently failed.

**Known legacy exception — do not copy, do not assume away:** `POST /api/admin/transactions/manual` (admin.js) bypasses `finalizeTransaction` and inlines its own side effects (daily total, hand-rolled QR-ledger update, `emitTxnNew`, bare counter `incrBy`). It fires **no partner webhook** and stamps **no `ownerSubadminId`** — so a side effect added only to `finalizeTransaction` will not reach manual admin transactions.

Every transaction must be stamped with `ownerSubadminId` at write time — it is the partner API's entire tenancy boundary. A missed stamp makes the transaction invisible to its partner and fires no webhook.

## Manual review state machine

- Windows (1–10 min, scope global/qr/user) live **in process memory** (reviewMode.js) and reset to AUTO on restart — by design; never persist them.
- Held docs are written with exactly `{ deleted:true, reviewStatus:'pending_review', reviewMode:'manual', reviewExpiresAt:<ISO> }`; AUTO mode writes none of these fields (no schema dependency).
- Resolution is exactly-once via `resolveReview`: acquire `lock:review:<txnId>` → re-read doc → proceed only if `reviewStatus === 'pending_review'` → **flip status first (commit point: `reviewStatus:'approved'`, `deleted:false`)** → then `finalizeTransaction` with the **updated** doc → release in finally. Reject keeps `deleted:true`, never finalizes, logs to `rejected_transactions` + daily rejected rollup (under `rej:` daily lock).
- Losers of the race return `already_resolved` → HTTP 409 (a no-op for clients, not an error). Busy lock → 503.
- A window expiring does NOT resolve its held docs — each doc resolves by admin action or its own `reviewExpiresAt` sweep (durable; the sweeper interval in admin.js, `REVIEW_SWEEP_MS`, skipped when `NODE_ENV==='test'`).

## Caches — invalidation is mandatory, not optional

| After writing… | You must call… | Or else |
|---|---|---|
| any `users_meta` doc | `await userMetaCache.invalidate(userId)` | auth/scope checks use stale roles for up to 60s |
| QR assignment fields (`assignedUserId`, `managedByUserId`, `createdByUserId`) or qrId renames | `qrOwnerCache.reload(qrId).catch(log)` — both old **and** new ids on rename; `invalidateQr(qrId)` on delete | live payments stamped with wrong `ownerSubadminId` for up to 10 min — permanent misattribution |
| config collection | go through `ConfigManager.set()` (self-refreshes); never write config docs directly | in-process cache is stale forever (no TTL) |
| any `api_partners` doc | `await partnerWebhooks.reloadIndex().catch(log)` | webhooks keep using old URL/secret/enabled state up to 10 min |

On transaction-attribution paths use `await qrOwnerCache.resolve(id)` (self-healing), not `get()` (returns null for both "no owner" and "not cached").

## Appwrite query rules

- Single doc by business key: `listDocuments(db, col, [Query.equal(field, value), Query.limit(1)])`, then mutate by the returned `$id`. Never assume business id === `$id` (withdrawals use `wdh_…` business ids; older `users_meta` docs have `$id !== userId` — getDocument-then-query fallback).
- Always pass an explicit `Query.limit(N)`. Full scans: page with `Query.limit(100)` + `Query.cursorAfter(lastId)` + stable explicit ordering, stop when a page is short, cap iterations. Never treat a single `Query.limit(N)` call as "all rows" — role-scoped filter builders that fetch only one page silently drop data (known latent bug: QR listings for subadmins/employees with >100 downstream users).
- Cursor pagination — the standard for every **new** list endpoint (followed by the transaction/user/QR/withdrawal families and partner `GET /transactions`): validate cursor with `/^[a-zA-Z0-9_:-]{1,255}$/` → 400; clamp `limit` (default 25, cap 100 unless the route says otherwise); explicit `orderDesc`/`orderAsc` always (cursors break without consistent order); `nextCursor = docs.length === limit ? lastDoc.$id : null` (full-page rule — partner endpoint depends on it); map Appwrite cursor errors to 400 `Invalid or expired pagination cursor` via `isCursorError`, never 500. Legacy lists are looser — partner admin lists emit `nextCursor` even on a short final page; `GET /admin/merchants` skips validation/clamping, returns the key `cursor`, and returns raw docs — don't copy them.
- Transaction list queries must exclude soft-deleted rows with `Query.or([Query.equal('deleted', false), Query.isNull('deleted')])` (legacy docs lack the field), and filter status `'normal'` as the tri-state `Query.or([equal('status','normal'), equal('status',''), isNull('status')])`.
- `Query.or` requires ≥ 2 conditions — branch: 0 ids → early return, 1 → plain `Query.equal`, 2+ → `Query.or`.
- Fulltext `Query.search` only on indexed fields (`vpa`, `paymentId`, `qrCodeId`, user `name`); `amount`/`rrnNumber` are exact `Query.equal`; any other searchField → 400.
- Status enum (lowercase, exact): `normal, cyber, refund, chargeback, failed, suspicious`. Status changes only via `PATCH /transactions/:id/status` — the generic edit endpoint rejects a `status` key.
- Soft delete only (`deleted: true`); never hard-delete transactions.
- Never put `$`-prefixed keys in create/update payloads (Appwrite system fields).
- Schema changes: Appwrite attributes provision **asynchronously** — creating an index in the same tick as its attributes fails. The setup scripts mitigate with fixed `sleep(3000–4000)` between attribute and index creation (no status polling exists); keep at least that, or poll attribute status until `available` for robustness.

## Time & dates

- **Stored timestamps are UTC ISO-8601 strings** (`created_at`, `createdAt`, `processedAt`, `reviewExpiresAt`, …). `getISTDateTime()` / `istDateTimeNow()` are **misleadingly named — they return UTC on purpose**. Never "fix" them: string comparisons (review sweep) and every date filter depend on the format.
- **Business days are IST.** Day keys: `moment.tz(ts, 'Asia/Kolkata').format('YYYY-MM-DD')` (or the `toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' })` idiom in qrcode.js); months `'YYYY-MM'`. User-supplied dates expand to IST-day boundaries converted to UTC for querying. Never bucket days in UTC.
- Prefer the business field `created_at` over Appwrite `$createdAt` (ingest can lag payment time); fall back only when missing.
- moment-timezone is the standard; dayjs appears only in admin commissions parsing — don't spread it. Pine Labs is special: naive IST wall-time both directions — use `fmtIst`/`parsePineDate`/`toIstDate`, never raw `new Date(string)` (server TZ is UTC on Render; double-shift bug).
- node-cron jobs always pass `{ timezone: 'Asia/Kolkata' }`.

## API conventions

Auth — choose the injected middleware; never ship an unauthenticated endpoint (existing ones are legacy, not license):

| Middleware | Grants |
|---|---|
| `authenticateToken` | any logged-in user; `req.user` = the **full cached users_meta doc** (key fields: `userId`, `role`, `name`, `labels`, plus `$id`, `parentId`, `assigned_to`, …). Employee scoping compares against `req.user.$id`, which can differ from `userId` on older docs |
| `authenticateAdmin` / `…OrSubAdmin` / `…OrSubAdminOrEmployee` | role gates |
| `authenticateAdminOrLabel(label, { isSubadminAllowed })` | admin always; employee needs label; subadmin if flag. Payout labels: `view_payouts`, `edit_payouts`, `view_payout_commissions` (subadmin allowed, scoped to own earnings) |
| `authenticatePartner` (partnerApi.js) | `X-API-Key: <partnerId>.<secret>`, bcrypt-checked; `req.partner` |
| `authenticateMerchant` (apiMerchants.js) | Bearer secret + `merchantId` in body; `req.merchant`, `req.vpa` |

Middleware is not enough: repeat ownership checks in the handler (subadmin acts only on docs with `parentId === req.user.userId`; employee only on their assigned subadmins; admin users can never be edited/deleted/reset by anyone). `authenticateToken`/`req.user` is the canonical stack — do not extend the parallel `roleAuth`/`req.userMeta` system or mix the two.

Response shapes — there is deliberately **no single envelope**; match the nearest neighbor in the same file/family and do not unify:

- Errors: `{ error: '<message>' }` with proper status — 400 validation/cursor, 401 auth, 403 ownership, 404 missing, 409 conflict/duplicate/negative-balance/already-resolved, 422 semantic (commission bounds), 423/503 lock busy, 500 generic. Error wording is asserted by tests — treat text as contractual.
- Inbound payment webhooks respond **plain text** (`res.send`), never JSON: 200 saved **and** 200 duplicate, 400 validation, 503 lock contention.
- Lists: `{ <pluralNoun>: docs, nextCursor }` or `{ success, total, nextCursor, records }` per family. Summaries: `{ days, grandTotalPaise, grandTotalRs, … }`. Merchant API: `{ success: bool, message/error, data }`.
- Always project documents through an explicit pick/whitelist function before responding (`pickTxn`, `simplifiedUsers`, …) — never return raw Appwrite docs from list endpoints.

Route modules are factory functions taking long **positional** dependency lists from server.js (9–42 args; admin.js takes 42, payout.js 17, withdraw.js 28). New dependency = **append to the end** of the factory signature. Any signature change (even an append) must update, in the same commit: the `app.use(...)` mount in server.js **and every test file that constructs the router** (grep `require('../<file>` under `tests/`). Inserting mid-list silently shifts every later argument — this has already broken the test suite once (see Testing bar).

## Sockets

Emit only through the helpers returned by `initSocket` (socketServer.js) — never a second io server, never raw `io.emit` from feature code. Server must listen on the returned `httpServer` (not `app.listen`). Events: `txn:new` and `txn:statusChange` → `room:user:<userId>` + `room:qr:<qrId>`; `review:pending` / `review:resolved` → `room:admins`; `qrLimitAlert` → QR room; `forceRefresh` → global. Known gaps (don't build on them, don't extend without fixing): `subscribe:qrs` does not validate QR ownership; `qrsAlert` room/`send:qrsAlert` have no role check.

## Config layers

- Env vars = deploy-time: numbers as `Number(process.env.X) || default`, booleans default-on unless the literal string `'false'`.
- `ConfigManager` (Appwrite-backed, in-memory cache) = admin-tunable at runtime: `ConfigManager.get(key, default)` sync-cached; `await ConfigManager.getConfig()` when you must guarantee load; writes only via `set()`. Config docs are `{ key, val, type }` — new keys need `type` set for parsing (integer/double/boolean/json/array). **`getConfig()` reads without `Query.limit` → only the first 25 docs are cached**; add pagination before growing the collection past ~25 keys. `get()` defaults are fail-safe values — choose defaults that fail closed.

## Background jobs & shutdown

- Intervals/crons must catch their own errors (`.catch(console.error)`) so one failure never kills the timer; guard reentrancy with a `running` boolean; skip under `NODE_ENV==='test'` if they'd leak Jest handles.
- Long-running admin work is fire-and-forget: validate → Redis NX single-runner lock → persist a Redis state doc → start worker **without awaiting** → return 202 + statusUrl; worker refreshes its lock per batch and never throws out (all outcomes land in the state doc). Destructive admin ops take `dryRun`/`confirm:true` (+ extra ack flags for repeats) and must be idempotent/resumable.
- Every new worker/interval must be stopped inside `gracefulShutdown` (SIGTERM/SIGINT path in server.js). Never remove `redisClient.on('error')` or the process-level `uncaughtException`/`unhandledRejection` handlers — they prevent crash-loops during Redis outages.
- Redis counters (`counter:totalTxCount`, `counter:totalApiTx`, `counter:totalAmountReceived`, paise): increment with `incrBy`. The universal rules: on success set `redisClient.countersDirty = true`, on failure `countersStale = true`; **never fail the request** on counter errors; never flush to Appwrite while stale (flush re-seeds from Appwrite instead). The finalize pipeline additionally wraps its increments in `withRedisTimeout(…, 3000)` — prefer that wrapper for new hot-path counter writes (the admin.js delete/un-delete/manual sites call bare `incrBy` with `.catch`). On soft-delete: decrement counters **before** setting `deleted:true`; on un-delete: restore counters **before** clearing the flag — this ordering is load-bearing for recovery.
- Other dashboard counters go only through `updateDashboardCounter(...)` (2s in-memory batcher) — never read-modify-write counter docs directly. There is no recompute endpoint: counters are incremental forever, so every new money path that changes a dashboard figure must increment it (payout.js: `totalPayoutWalletBalance` inside `moveWallet`, pending/paid/profit counters at the route level; withdraw.js: `totalPayoutWalletFunded` on wallet approvals).

## Scripts (`scripts/`)

- Load env at the top, before any project requires: `const path = require('path'); require('dotenv').config({ path: path.join(__dirname, '..', '.env') });` so the project-root `.env` is used regardless of cwd. Assert required env vars and `process.exit(1)` with a clear message. (`copyAppwriteSchema.js` is the standalone exception — no dotenv, hardcoded blocks; see Secrets.)
- Data-mutating scripts are **dry-run by default**, write only with `--write`, print a plan + scanned/changed/skipped/failed counts.
- Idempotent by construction: schema creates treat Appwrite 409 as skip; backfills **recompute-and-overwrite** aggregates from the source transactions (never increment — re-runs would double-count). Live incremental writers, by contrast, **merge-add under the daily lock** — the two write styles are intentionally different.
- Deploy ordering: `setup-review-schema.js` before enabling manual review; `setup-partner-schema.js` then `backfill-owner.js --write` before the partner API serves history; `setup-payout-schema.js` before deploying payout.js (it also extends the withdrawal `mode` enum with `wallet` and adds `users_meta.payoutCommission`), then optionally `backfill-payout-commission.js --write` to stamp the default rate on existing users (runtime falls back to the default anyway).
- `transactionStatusMailer.js` sends real email via Hostinger on direct invocation — treat as production side effect.

## Testing bar & ship checklist

`npm test` runs Jest over `tests/` with fully stubbed Appwrite/Redis. All four suites green is the bar before any change ships; a change may never increase the failure count.

> Any "argument handler must be a function" / "X is not a function" failure from a router factory means positional-arg drift — diff the factory signature against the test's call site (and the server.js mount) before debugging anything else. Tests that build admin.js/withdraw.js must `jest.mock` `../scripts/transactionStatusMailer` (top-level `return`, real email), `../configManager` (uninitialised → the known `MAX_PENDING_WITHDRAWALS` TDZ), and `../userMetaCache` (see `robustness.test.js`).

Test patterns that are mandatory to copy:

- Build router factories inside `jest.isolateModules(...)` — requiring admin.js/withdraw.js twice otherwise accumulates duplicate handlers with stale mocks.
- Fire-and-forget effects (Redis counters) need a `setImmediate`-based `flush()` before asserting.
- `reviewMode` is a shared singleton: `clearManual({ all: true })` in `beforeEach`, with `jest.useFakeTimers()`/`setSystemTime`.
- New money-path logic (ingest, resolve, ledger math, summary writes) requires a test pinning: exactly-once behavior, lock acquire/release (including error paths), and that non-fatal side-effect failures don't abort the operation.

Before shipping any change, verify every line of this checklist:

1. **Units**: every touched amount identified as paise or rupees per the table; conversions only at the boundary.
2. **Locks**: every QR-ledger / `totalsJson` / review / verify RMW under its lock from the table; released via Lua in `finally`; fails closed on Redis errors.
3. **Exactly-once**: new ingest paths follow the 7-step webhook choreography and gate through `reviewFieldsFor`; `finalizeTransaction` runs exactly once per transaction, never at hold time.
4. **Caches**: every write matched against the invalidation table.
5. **Queries**: deleted-exclusion OR-clause, tri-state `normal`, `Query.limit`, cursor rules, pick-function projection.
6. **Auth**: middleware + in-handler ownership scoping on every new/changed endpoint.
7. **Response shape** copied from the nearest sibling endpoint; error text stable.
8. **Docs**: partner-visible changes mirrored in `PARTNER_API.md` (`pickTxn` + `txnView` + field table move together); review-UI changes in `MANUAL_REVIEW_FRONTEND.md`; payout API changes in `CUSTOMER_PAYOUT_FRONTEND.md`.
9. **Lifecycle**: workers registered in `gracefulShutdown`; intervals self-catching; test-env guards.
10. **Secrets**: nothing from the secrets list echoed, moved, or committed; no new hardcoded credentials.
11. `npm test` green; new tests for money logic.
12. Factory positional arg counts match at the mount site.

## Do-not-"fix" list (intentional or load-bearing oddities)

- `getISTDateTime()`/`istDateTimeNow()` return UTC — intentional (see Time & dates).
- `GET /users` (admin.js) returns its list under the key `transactions` — clients depend on the misnamed key.
- `ENABLE_PINELAB_POLLER` is hardcoded `true` in server.js and its adjacent comment claims the opposite — this toggles a production money poller; do not change either without explicit instruction.
- The commented-out Razorpay HMAC verification block on `/webhook` must stay (rawBody capture + `RAZORPAY_WEBHOOK_SECRET` exist to re-enable it). Consequence: **webhook payloads are unauthenticated input — validate everything.**
- `webhookLimiter` is defined but applied to nothing; helmet is commented out. Only the global 1000/min limiter is active. Don't claim otherwise; keep `app.set('trust proxy', 1)` as-is.
- reviewMode windows resetting to AUTO on restart is by design.
- `/qr_generate`'s `expiry` and `txnId` are returned but never stored/enforced — don't build logic assuming they exist.
- The `/pinelabs` DigiQR routes point at Pine Labs **TEST** hosts and the callback is a no-op stub — polling is the only crediting path.
- PineLabs admin endpoints live at root `/admin/pinelabs/*` (not `/api/admin`) — keep paths stable.
- Known latent bugs to not copy (fix only with explicit instruction): edit-qr writes `qrType` while the schema attribute is `type`; the `MAX_PENDING_WITHDRAWALS` TDZ self-reference in withdraw.js (keep the `max_withdrawal_requests` config key populated); `GET /users` employee branch pushes conflicting order clauses; wallet get-or-create can duplicate wallet docs; admin withdrawal-account update mass-assigns `req.body`.
- Unauthenticated legacy endpoints (`/commission/totals*`, `/get_daily_qr_summaries`, `/inc_test`, `/test_*`, `GET /api/admin/config`, admin commissions summaries, `GET /user_withdrawals_paginated` — the last one leaks bank details): never model new endpoints on them, never expand them; adding auth is a behavior change — ask first.

## Secrets — locations and handling

Live credentials exist **in tracked files**. Never print, quote, copy, commit, or log their values — refer to them by location/env-var name only. Any refactor moves them to env vars without duplicating them anywhere:

- `.env.example` and the tracked file `env copy` currently contain real-looking live values (Razorpay live key/secret, webhook secret, Appwrite API key, Hostinger token, Redis URL). Treat as compromised until rotated; when editing `.env.example`, replace values with placeholders, never fresh secrets.
- `scripts/copyAppwriteSchema.js` — hardcoded Appwrite API keys/project IDs in its SOURCE/TARGET blocks.
- `server.js` `PINELAB_ACCOUNTS` (+ a webhook secret in a comment near `/webhook`), and CONFIG blocks in `pineLabMulti.js`/`pineLabTest*.js` — live Pine Labs client credentials.
- Generated secrets are returned exactly once at create/rotate and never listed or logged afterwards. Partner API-key secrets and merchant `apiSecret`s are bcrypt-hashed (cost 12) at rest. The partner **webhook secret (`whsec_…`) is stored in plaintext by necessity** (it is the HMAC signing key read on every dispatch) — treat the `api_partners` collection as secret-bearing; never add code that lists or logs `webhookSecret`.

## Unresolved questions — ask the user before acting on these

1. Disabled Razorpay HMAC verification and the unauthenticated endpoints: intentional exposure or debt to fix? (Either change alters live provider/client behavior.)
2. Single-instance deployment: permanent assumption or is scaling planned? (Redesign needed before >1 instance.)
3. Wallet crediting: `wallet.js` only creates *pending* recharges — no code in this repo updates `wallet.balance`. Where does the credit happen?
4. Withdrawal time windows: enforced window is 12:01 PM–7:00 PM IST but user-facing messages describe different windows — which is authoritative?
5. Partner API supports `status` filtering and `isSortByUpdatedAt` that `PARTNER_API.md` doesn't document — undocumented-by-design or doc drift?
6. `/inc_test`'s optimistic-insert + `incrementRowColumn` pattern targets a TEST collection — intended future replacement for lock-based `updateDailyQrTotal`?
7. Rotation status of every credential in the Secrets section (all appear live and tracked in git).
8. `POST /api/admin/transactions/manual` bypasses `finalizeTransaction` — no partner webhook fires and no `ownerSubadminId` is stamped, so manual transactions are invisible to partners. Intentional carve-out or gap to fix?
9. Review-approve credits QR totals without `lock:qr` (optimistic retry only) — accepted race or should it take the QR lock like every other ledger writer?
