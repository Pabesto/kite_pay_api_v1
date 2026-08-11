# UAT endpoint for Razorpay Notification API (UPI + Bharat QR)

## Context

Razorpay's Notification API (v4.0) requires the merchant to hand over a **UAT URL with
authorization details** so Razorpay can post test notifications from their Demo
environment before production go-live (§4.3, 2-business-day TAT). We have no such
endpoint — the three live webhooks in `server.js` write straight into the money path.

This adds a **capture-and-validate-only** UAT endpoint in its own file, writing to its own
Appwrite collection. It records every notification Razorpay's UAT sends, returns the
normalized field mapping so we can eyeball it against the doc, and **touches no money,
no locks, and no production collection.**

Two concrete mapping bugs the doc exposes in the live `/razorpay-webhook`, which the UAT
endpoint must handle correctly (and which the UAT captures will confirm against real
Razorpay UAT traffic):

- Live maps `paymentId = data.Id`. The **Bharat QR sample (§5.11) has no `id`/`Id` field
  at all.** `txnId` is the field §5.3 documents as "Unique Transaction ID at Razorpay"
  (String 25) and it is present in every sample.
- Live maps `qrCodeId = data.tid`. §5.3 marks `tid` as **Card-only**, and neither the UPI
  (§5.10) nor Bharat QR (§5.11) sample contains `tid`. `username` is present in both.

Fixing live is **out of scope** — the point of UAT is to find out what Razorpay actually
sends us before we touch production.

## Decisions (confirmed with user)

| | |
|---|---|
| Scope | Capture + validate only. No `finalizeTransaction`, no QR ledger, no daily summary, no counters, no partner webhooks, no sockets. |
| Auth (inbound) | Static token header (PDF §4.2 option 2), env `UAT_WEBHOOK_TOKEN`. |
| Read-back | Admin-authenticated, cursor-paginated list endpoint. |

## Safety rules for this endpoint (non-negotiable)

1. **Never acquire `lock:qr:<id>` or any production lock key.** A UAT payload carrying a
   real `tid` would otherwise block a live payment for up to 15s. UAT takes **no locks at
   all** — dedup is best-effort (see below).
2. **Never write to `APPWRITE_WEBHOOK_DATA_COLLECTION_ID`** or any collection in the money
   path. Its only write target is the new UAT collection.
3. **Never call `finalizeTransaction`.** It is not passed into the factory, so it cannot be.

## Files

### 1. `uatWebhook.js` (new) — router factory

Follow **`partnerApi.js`** as the template, not `admin.js`: `express`/`rateLimit`/`crypto`
required at module top, and `const router = express.Router()` **inside** the factory
(partnerApi.js:52) so the module is re-requirable and tests need no `jest.isolateModules`.

```js
module.exports = (
    databases, ID, Query,
    APPWRITE_DATABASE_ID,
    APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID,
    rupeesToPaiseStrict,
    authenticateAdmin
) => { ... return router; }
```

`rupeesToPaiseStrict` is **injected, not re-implemented** (server.js:913, string-based, the
only sanctioned rupee→paise converter for this flat Ezetap shape).

#### `POST /uat/razorpay-webhook`

Route-scoped middleware, in order:

- `express.json({ type: '*/*', limit: '1mb' })` — no-ops when the global parser at
  server.js:700 already parsed; catches the case where Razorpay's UAT sends a non-JSON
  `Content-Type`, which would otherwise leave `req.body` empty and waste a setup cycle.
- `uatLimiter` — 60/min, `express-rate-limit` (already a dependency), copied from
  `partnerLimiter` (partnerApi.js:25–41) minus the per-partner keyGenerator. Brute-force
  guard on the token.
- `requireUatToken` — accepts `Authorization: Bearer <t>` **or** `X-UAT-Token: <t>`.
  Compare with `crypto.timingSafeEqual` over **SHA-256 digests of both sides** (equal
  length by construction — raw `timingSafeEqual` throws on length mismatch and leaks
  length). Missing/bad → `401 { error: 'Unauthorized' }`. `UAT_WEBHOOK_TOKEN` unset →
  **fails closed**: `503 { error: 'UAT endpoint not configured' }` + one boot-time
  `console.warn`. Never log or echo the token.

Handler:

1. Reject only a non-object / empty body → `400 { error: 'Empty or unparseable body' }`.
2. Normalize (see mapping table). Collect non-fatal problems into `warnings[]` rather than
   rejecting.
3. Best-effort dedup: `listDocuments(..., [Query.equal('txnId', txnId), Query.limit(1)])`.
   Hit → respond `200 { received: true, duplicate: true, docId: <existing.$id> }` without
   writing. `// ponytail: unlocked dedup — a simultaneous retry can double-insert into the
   UAT log. Harmless (no money), and a lock here would be worse. Add a lock only if UAT
   volume ever makes duplicates confusing.`
4. `createDocument(ID.unique(), {...})` into the UAT collection.
5. `200 { received: true, duplicate: false, docId, parsed: {...}, warnings }`.
6. `catch` → `500 { error: 'Failed to record UAT notification' }`.

**Deliberate divergence from the production webhooks:** prod returns `400` on a bad
payload; UAT returns `200` for *anything* it can parse as an object, including
`status: 'FAILED' | 'PENDING' | 'VOIDED' | 'REFUNDED'` and unknown `paymentMode`. §4.4
requires a 200 within 1–2s and stops all further posting after 3 non-200s — a 400 during
UAT would burn the integration attempt and hide the payloads we are trying to see.
Non-AUTHORIZED and non-UPI/BHARATQR payloads are recorded with a warning, not rejected.
This must be commented in the file so nobody "fixes" it to match prod.

Response is **JSON**, not the plain text the production webhooks use — this is a
developer-facing UAT tool and the parsed echo is the whole point.

#### Field mapping (PDF §5.3 + samples §5.10, §5.11)

| Output | Source | Notes |
|---|---|---|
| `txnId` | `txnId \|\| id \|\| Id` | §5.3 documents `txnId` as the unique id; warn if it came from a fallback |
| `qrCodeId` | `tid \|\| username` | warn `no tid — fell back to username` when `tid` absent (expected for UPI/BharatQR) |
| `amountRupeesRaw` | `amount` | stored as sent, as a string |
| `amountPaise` | `rupeesToPaiseStrict(amount)` | `null` + warning if not `Number.isFinite` |
| `providerStatus` | `status` | `AUTHORIZED`/`FAILED`/`PENDING`/`VOIDED`/`REFUNDED`/… — **named `providerStatus`, not `status`**, so it is never confused with the money-status enum |
| `paymentMode` | `paymentMode` | warn if not `UPI`/`BHARATQR` |
| `txnType` | `txnType` | CHARGE / REFUND / … |
| `settlementStatus` | `settlementStatus` | |
| `rrnNumber` | `rrNumber` | doc spelling is `rrNumber` |
| `vpa` | `payerName \|\| customerName` | UPI sample carries the VPA in `payerName` (`ppriya1486@kotak`); Bharat QR has neither → `null`. Live `/razorpay-webhook` reads `customerName` only. |
| `postingDate` | `new Date(postingDate).toISOString()` | epoch **ms** in both samples; `null` + warning on invalid date |
| `currencyCode` | `currencyCode` | warn if not `INR` |
| `externalRefNumber`, `merchantCode`, `username` | as-is | identity/reconciliation |
| `created_at` | `new Date().toISOString()` | our receipt time, UTC ISO per the Time rules |

#### `GET /uat/razorpay-webhook/captures`

`authenticateAdmin` (server.js:783). Follows the cursor rules and the
`partnerApi.js` `GET /transactions` shape (partnerApi.js:184–213) verbatim in style:

- validate `cursor` against `/^[a-zA-Z0-9_:-]{1,255}$/` → 400 `Invalid cursor format`
- clamp `limit` (default 25, cap 100)
- `Query.orderDesc('created_at')`, explicit `Query.limit`, `Query.cursorAfter`
- optional `txnId` exact filter
- project through a `pickCapture(d)` whitelist — never raw docs
- `nextCursor = docs.length === limitNum ? last.id : null`
- reuse the `isCursorError` predicate (partnerApi.js:53–56) → 400
  `Invalid or expired pagination cursor`
- response `{ captures, nextCursor, limit }`

### 2. `scripts/setup-uat-webhook-schema.js` (new)

Copy **`scripts/setup-pinelab-accounts-schema.js`** — the newest and strictly better of the
two competing script idioms: `TablesDB` (not `Databases`), `--write` gate so **dry-run is
the default**, declarative `COLUMNS`/`INDEXES` arrays, `isAlreadyExists` (409 *or* message
match), and a real `waitForColumns()` readiness poll instead of the `sleep(3000)` guess
used by `setup-partner-schema.js`. Standard header: `dotenv` from `../.env` before any
project require, env assertions with `process.exit(1)`.

Table `uat_webhook_data`, `permissions: []`, `rowSecurity: false` (server API key only):

- `payload` string 1000000 — full raw JSON, source of truth
- `txnId` string 64, `qrCodeId` string 64, `rrnNumber` string 64
- `paymentMode` string 16, `providerStatus` string 24, `txnType` string 16,
  `settlementStatus` string 16, `currencyCode` string 8
- `amountPaise` integer (nullable), `amountRupeesRaw` string 32
- `vpa` string 255, `externalRefNumber` string 64, `merchantCode` string 64,
  `username` string 32
- `postingDate` string 40, `created_at` string 40
- `warningsJson` string 4096
- `sourceIp` string 64

Indexes: `idx_txnId` (key — dedup lookup; **key, not unique**, so a duplicate can never
throw and 500 a UAT post), `idx_created_at` (key — list ordering).

### 3. `server.js` (edit, 3 lines)

- require near line 44: `const uatWebhookRoutes = require('./uatWebhook');`
- env const near line 90:
  `const APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID = process.env.APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID || 'uat_webhook_data';`
  (documented string-literal fallback matching the setup script, same precedent as
  `APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID` at server.js:93)
- mount **appended at the end** of the 890–911 block:
  ```js
  app.use('/uat', uatWebhookRoutes(databases, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID, rupeesToPaiseStrict, authenticateAdmin));
  ```

`rupeesToPaiseStrict` is declared at server.js:913 — *after* the mount block — but it is a
**function declaration and therefore hoisted**, exactly like `updateDailyQrTotal`
(declared 1782, passed to mounts at 890). Safe; worth a one-line comment so a reviewer
doesn't "fix" it.

### 4. `.env.example` (edit)

Add `APPWRITE_UAT_WEBHOOK_DATA_COLLECTION_ID=uat_webhook_data` and
`UAT_WEBHOOK_TOKEN=<placeholder>`. **Placeholder only** — never a real secret. Generate
the live value with `openssl rand -hex 32` into `.env` only.

### 5. `tests/uatWebhook.test.js` (new)

supertest + the Appwrite/Redis stub helpers from `tests/robustness.test.js:17–53`
(`makeDb`, `asAdmin`), real `Query` from `node-appwrite`. No `jest.isolateModules` needed
— the router is built inside the factory. Uses the **verbatim UPI (§5.10) and Bharat QR
(§5.11) sample payloads from the PDF** as fixtures. Assertions:

- 401 with no/wrong token; 503 when `UAT_WEBHOOK_TOKEN` is unset
- UPI sample → `amountPaise === 100`, `qrCodeId === '2222110001'` (from `username`),
  `vpa === 'ppriya1486@kotak'`, warning present for the missing `tid`
- Bharat QR sample → `amountPaise === 310` (the 3.1 case that catches float rounding),
  `txnId === '180831151229453E010058794'` **with no `id` field in the body**
- `status: 'FAILED'` body → still `200`, recorded with a warning
- second post of the same `txnId` → `200 { duplicate: true }`, `createDocument` called once
- **`createDocument` is never called with the production webhook collection id**, and no
  QR/daily/counter stub is touched — the guardrail test for the whole feature

## Verification

1. `node scripts/setup-uat-webhook-schema.js` → read the printed plan; then
   `node scripts/setup-uat-webhook-schema.js --write`. Re-run it — must be a clean no-op
   (all 409s skipped).
2. `npm test`. **Baseline:** `robustness.test.js` already fails 24 tests
   ("argument handler must be a function" at withdraw.js:550 — a pre-existing positional
   drift in the *test's* `buildWithdrawApp` call, not production). This change must not
   increase that count; the new suite must be fully green.
3. `node server.js`, then locally:
   ```sh
   curl -i -X POST localhost:$PORT/uat/razorpay-webhook \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $UAT_WEBHOOK_TOKEN" \
     -d @upi-sample.json      # PDF §5.10 verbatim
   ```
   Expect `200` with the `parsed` block and the `no tid` warning. Repeat → `duplicate: true`.
   Same with the §5.11 Bharat QR sample → `amountPaise: 310`.
   Then `curl -i localhost:$PORT/uat/razorpay-webhook` with no token → `401`.
4. `GET /uat/razorpay-webhook/captures?limit=2` with an admin JWT → both captures,
   newest first, `nextCursor` set; replay the cursor and confirm no overlap; a garbage
   cursor → `400`.
5. **Confirm isolation:** after the curls, the production `webhook_data` collection row
   count and every QR doc's `totalPayInAmount` are unchanged, and
   `redis-cli get counter:totalTxCount` is unchanged.
6. Hand Razorpay the deployed URL `https://kite-pay-api-v2.onrender.com/uat/razorpay-webhook`
   plus the header name and token value (out-of-band, never in git).

## Explicitly not doing

- Not fixing the `tid`/`Id` mapping in the live `/razorpay-webhook` — that is a
  production money path and the UAT captures are the evidence needed to change it. Separate
  change, on request.
- No replay-into-production path for captured UAT payloads (YAGNI).
- No `UAT_WEBHOOK.md`; the handover details live in the `uatWebhook.js` header comment.
  Say the word if you want a doc to send Razorpay.
- No HTTP Basic support — add ~10 lines if Razorpay's UAT team insists on §4.2 option 1.
