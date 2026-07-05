# Partner Transactions API

This document describes how a partner system fetches the transactions that belong to it,
using an API key. It covers authentication, every filter, cursor-based pagination, the
response format, error handling, and complete code examples.

---

## 1. Overview

- You are issued **one API key** by the platform admin. It is tied to your account and
  scopes every request to **only your transactions** — you can never see another partner's data.
- The API is **read-only**. There is a single data endpoint: `GET /api/partner/transactions`.
- Results are returned newest-first and paginated with an opaque **cursor**.
- All timestamps are ISO-8601 UTC. All money amounts are integers in **paise** (₹1 = 100 paise).

**Base URL**

```
https://kite-pay-api-v2.onrender.com/api/partner
```

Every path below is relative to this base.

---

## 2. Authentication

Every request must include your API key in the **`X-API-Key`** header.

```
X-API-Key: pk_AB12CD34.a1b2c3d4e5f6...
```

The key has two parts joined by a dot: `pk_XXXXXXXX` (public id) + `.` + a long secret.
Send the **whole string** exactly as issued.

> An `Authorization: Bearer <key>` header is also accepted with the same value, if that is
> easier for your HTTP client. Use one or the other — `X-API-Key` is preferred.

### Getting / rotating your key
- The key is shown to you (via the admin) **once** at creation. Store it in a secrets
  manager — it cannot be retrieved again.
- If it is lost or compromised, ask the admin to **rotate** it. Rotation issues a new key and
  **immediately invalidates the old one**.

### Auth failures
| HTTP | `error` | Meaning |
|------|---------|---------|
| 401 | `Missing or malformed API key` | Header absent, or not in `id.secret` form |
| 401 | `Invalid API key` | Unknown id or wrong secret |
| 403 | `Partner account suspended` | Your access was disabled by the admin |
| 403 | `Partner is not linked to a user` | Misconfiguration — contact the admin |

### Health check
Confirm your key works and see who you are:

```
GET /api/partner/me
X-API-Key: pk_AB12CD34.<secret>
```
```json
{ "success": true, "partner": { "partnerId": "pk_AB12CD34", "userId": "...", "name": "Acme Corp" } }
```

---

## 3. Fetch transactions

```
GET /api/partner/transactions
X-API-Key: pk_AB12CD34.<secret>
```

Returns your transactions, newest first, one page at a time.

### 3.1 Query parameters (all optional)

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | `25` | Page size. **Max 100** (values above 100 are clamped to 100). |
| `cursor` | string | — | Pagination cursor. Omit for the first page; then pass the `nextCursor` from the previous response. See [Pagination](#4-pagination). |
| `from` | date `YYYY-MM-DD` | — | Start date (inclusive), interpreted in **IST (Asia/Kolkata)**. See [Date filtering](#33-date-filtering). |
| `to` | date `YYYY-MM-DD` | — | End date (inclusive), IST. |
| `status` | string | — | Filter by transaction status. One of `normal`, `cyber`, `refund`, `chargeback`, `failed`, `suspicious`. |
| `qrId` | string | — | Restrict to a single QR code id. |
| `searchField` | string | — | Field to search. Must be paired with `searchValue`. See [Search](#34-search). |
| `searchValue` | string | — | Value to search for. |
| `isSortByUpdatedAt` | boolean | `false` | `true` sorts by last-updated instead of creation time. See [Sorting](#35-sorting). |

Parameters combine with **AND** — e.g. `status=normal&from=2026-07-01` returns normal
transactions on/after 1 Jul.

### 3.2 Response

```json
{
  "transactions": [
    {
      "id": "6543ab...",
      "qrCodeId": "TID12345",
      "paymentId": "pay_abc123",
      "rrnNumber": "123456789012",
      "amount": 150000,
      "vpa": "customer@okhdfcbank",
      "provider": "razorpay",
      "created_at": "2026-07-06T09:15:00.000Z",
      "updatedAt": "2026-07-06T09:15:02.000Z",
      "status": "normal"
    }
  ],
  "nextCursor": "6543ab...",
  "limit": 25
}
```

**Transaction fields**

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Unique transaction id. **Use this value as the `cursor`** for the next page. |
| `qrCodeId` | string | The QR code / terminal id the payment was made to. |
| `paymentId` | string | Provider payment id. |
| `rrnNumber` | string | Bank RRN / UTR reference (may be empty for some providers). |
| `amount` | integer | Amount in **paise**. Divide by 100 for rupees (`150000` = ₹1,500.00). |
| `vpa` | string | Payer UPI id, when available. |
| `provider` | string | `razorpay`, `paytm`, `pinelabs`, etc. |
| `created_at` | string | Payment time, ISO-8601 UTC. |
| `updatedAt` | string | Last modification time, ISO-8601 UTC. |
| `status` | string | `normal` for a clean payment; others (`refund`, `chargeback`, `failed`, `cyber`, `suspicious`) are flagged states. |

**Top-level fields**

| Field | Type | Notes |
|-------|------|-------|
| `transactions` | array | The page of results (may be empty). |
| `nextCursor` | string \| null | Cursor for the next page, or `null` when there are no more results. |
| `limit` | integer | The effective page size used. |

### 3.3 Date filtering

Dates are `YYYY-MM-DD` and are resolved to full **IST day boundaries**:

| Params | Meaning |
|--------|---------|
| `from=2026-07-06` only | The whole day 6 Jul (IST). |
| `to=2026-07-06` only | Everything up to end of 6 Jul (IST). |
| `from=2026-07-01&to=2026-07-06` | 1 Jul 00:00 → 6 Jul 23:59:59 (IST), inclusive. |
| `from=2026-07-06&to=2026-07-06` | Just that single day. |

> Example: `from=2026-07-01&to=2026-07-31` returns the whole of July in IST, regardless of
> the server's timezone.

### 3.4 Search

Provide **both** `searchField` and `searchValue`. Behaviour depends on the field:

| `searchField` | Match type | `searchValue` example | Notes |
|---------------|-----------|-----------------------|-------|
| `vpa` | full-text | `customer@okhdfc` | Partial match on payer VPA. |
| `paymentId` | full-text | `pay_abc123` | Partial match on provider payment id. |
| `qrCodeId` | full-text | `TID12345` | Partial match on QR id. (For an exact single QR, prefer the `qrId` param.) |
| `amount` | exact | `1500` | **In rupees, whole numbers only.** `1500` matches ₹1,500.00 (150000 paise). |
| `rrnNumber` | exact | `123456789012` | Exact RRN/UTR match. |

Any other `searchField` → `400 { "error": "Invalid searchField parameter" }`.
A non-numeric `amount` → `400 { "error": "Amount must be an integer value" }`.

### 3.5 Sorting

- Default: newest **created** first (`created_at` descending).
- `isSortByUpdatedAt=true`: newest **updated** first — useful to poll for records that
  recently changed status (e.g. a payment that later became a `refund`).

> Keep the sort order **consistent across a pagination run**. Don't change
> `isSortByUpdatedAt` midway through walking cursors, or pages may overlap/skip.

---

## 4. Pagination

Pagination is **cursor-based** (not page numbers). The flow:

1. Request the first page **without** a `cursor`.
2. Read `nextCursor` from the response.
3. If `nextCursor` is not `null`, request the next page with `cursor=<nextCursor>` (keep all
   other filters identical).
4. Repeat until `nextCursor` is `null` — that's the end.

Notes:
- A page is "full" when it returns exactly `limit` rows; only then is `nextCursor` set.
- The cursor is the `id` of the last transaction on the page — opaque; don't construct it yourself.
- Cursors are only valid against the **same filter set**. Changing `from`/`status`/etc.
  means starting again without a cursor.
- An expired/invalid cursor → `400 { "error": "Invalid or expired pagination cursor" }`.
  On that error, restart from page one.

---

## 5. Rate limits

Requests are limited **per API key** (not per IP), so your quota is yours alone.

- **Limit:** 120 requests per minute per key (rolling 60-second window).
- Applies to `GET /transactions` and `GET /me`.

Every response includes standard rate-limit headers:

| Header | Meaning |
|--------|---------|
| `RateLimit-Limit` | Max requests allowed in the window (e.g. `120`). |
| `RateLimit-Remaining` | Requests left in the current window. |
| `RateLimit-Reset` | Seconds until the window resets. |
| `Retry-After` | (On `429` only) seconds to wait before retrying. |

If you exceed the limit you get:

```
HTTP 429 Too Many Requests
{ "error": "Rate limit exceeded. Slow down and retry shortly.", "retryAfterSeconds": 60 }
```

**Handling it:** when you receive a `429`, pause for `Retry-After` seconds (or 60s) and
retry. For bulk pulls, requesting `limit=100` keeps you well within quota — 120 pages/min is
up to ~12,000 rows/min. If you need a higher limit for a specific integration, ask the admin.

---

## 6. Errors

| HTTP | Body | Cause |
|------|------|-------|
| 400 | `{ "error": "Invalid status filter" }` | `status` not in the allowed set |
| 400 | `{ "error": "Invalid searchField parameter" }` | Unsupported `searchField` |
| 400 | `{ "error": "Amount must be an integer value" }` | `searchField=amount` with non-numeric `searchValue` |
| 400 | `{ "error": "Invalid cursor format" }` | `cursor` contains illegal characters |
| 400 | `{ "error": "Invalid or expired pagination cursor" }` | Stale cursor — restart pagination |
| 401 / 403 | see [Authentication](#2-authentication) | Key problems |
| 500 | `{ "error": "Failed to fetch transactions" }` | Server error — retry with backoff |

Always check the HTTP status; error bodies are `{ "error": "..." }`.

---

## 7. Examples

### 6.1 cURL

First page — normal transactions in July, 50 per page:
```bash
curl -s "https://kite-pay-api-v2.onrender.com/api/partner/transactions?status=normal&from=2026-07-01&to=2026-07-31&limit=50" \
  -H "X-API-Key: pk_AB12CD34.<secret>"
```

Next page (using the returned `nextCursor`):
```bash
curl -s "https://kite-pay-api-v2.onrender.com/api/partner/transactions?status=normal&from=2026-07-01&to=2026-07-31&limit=50&cursor=6543ab..." \
  -H "X-API-Key: pk_AB12CD34.<secret>"
```

Find one transaction by RRN:
```bash
curl -s "https://kite-pay-api-v2.onrender.com/api/partner/transactions?searchField=rrnNumber&searchValue=123456789012" \
  -H "X-API-Key: pk_AB12CD34.<secret>"
```

### 6.2 Node.js — fetch every page

```js
const BASE = 'https://kite-pay-api-v2.onrender.com/api/partner';
const API_KEY = process.env.PARTNER_API_KEY; // "pk_AB12CD34.<secret>"

async function fetchAllTransactions(filters = {}) {
  const all = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ limit: '100', ...filters });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${BASE}/transactions?${params}`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}: ${body.error || 'request failed'}`);
    }

    const { transactions, nextCursor } = await res.json();
    all.push(...transactions);
    cursor = nextCursor;          // null → loop ends
  } while (cursor);

  return all;
}

// Usage: all normal transactions for July
fetchAllTransactions({ status: 'normal', from: '2026-07-01', to: '2026-07-31' })
  .then(txns => console.log(`Fetched ${txns.length} transactions`))
  .catch(console.error);
```

### 6.3 Python — fetch every page

```python
import os
import requests

BASE = "https://kite-pay-api-v2.onrender.com/api/partner"
API_KEY = os.environ["PARTNER_API_KEY"]  # "pk_AB12CD34.<secret>"

def fetch_all_transactions(**filters):
    out, cursor = [], None
    while True:
        params = {"limit": 100, **filters}
        if cursor:
            params["cursor"] = cursor

        r = requests.get(f"{BASE}/transactions", params=params,
                         headers={"X-API-Key": API_KEY}, timeout=30)
        if not r.ok:
            raise RuntimeError(f"HTTP {r.status_code}: {r.json().get('error')}")

        data = r.json()
        out.extend(data["transactions"])
        cursor = data["nextCursor"]
        if not cursor:              # None → done
            return out

# `from` is a Python keyword, so pass the filters as a dict:
txns = fetch_all_transactions(**{"status": "normal", "from": "2026-07-01", "to": "2026-07-31"})
print(f"Fetched {len(txns)} transactions")
```

---

## 8. Best practices

- **Store the key securely** (env var / secrets manager), never in client-side code or git.
- **Use `limit=100`** for bulk pulls to minimize round-trips; smaller pages for interactive UIs.
- **Poll incrementally**: to catch new payments, request `from=<today>` sorted by default
  (`created_at`); to catch status changes on older payments, use `isSortByUpdatedAt=true`.
- **Handle `nextCursor: null`** as the definitive end of results.
- **Respect rate limits**: watch `RateLimit-Remaining`; on `429`, back off for `Retry-After` seconds. Don't fire parallel bursts — sequential paged requests stay within quota.
- **Retry 5xx** with exponential backoff; **do not retry 4xx** without fixing the request.
- Only transactions from the current setup onward are guaranteed attributed to you; ask the
  admin if you need older history included.
```
