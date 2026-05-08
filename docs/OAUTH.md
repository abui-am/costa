# Frontend integration (Costa API)

This backend is an Express app with **Supabase Auth** and **Bearer JWT** access on cost routes. Use it from browsers, mobile apps, or server-side callers.

## Quick reference

| Method & path | Auth | Purpose |
|---------------|------|---------|
| `GET /` | No | Plain-text welcome string (not JSON). |
| `GET /docs` | No | Swagger UI. |
| `GET /openapi.json` | No | OpenAPI 3 JSON spec. |
| `GET /api/health/supabase` | No | Which Supabase env vars are set. |
| `POST /api/auth/login` | No | Email/password → `LoginResponse`. |
| `POST /api/auth/logout` | Bearer | Global sign-out. |
| `GET /api/auth/oauth/google` | No | Start Google OAuth (302 chain). |
| `GET /api/auth/oauth/google/link` | No | OAuth authorize URL as JSON. |
| `GET /api/auth/oauth/google/callback` | No* | Code exchange; *requires prior OAuth cookies. |
| `POST /api/auth/mobile/exchange` | No | Trade one-time nonce → `LoginResponse` (native apps). |
| `GET /api/expenses` | Bearer | List expenses with nested costs (`?month=`, `?draft=`). |
| `POST /api/expenses` | Bearer | Create expense + line items atomically. |
| `GET /api/expenses/:id` | Bearer | Single expense with nested costs. |
| `PATCH /api/expenses/:id` | Bearer | Update expense fields including `is_draft`. |
| `DELETE /api/expenses/:id` | Bearer | Delete expense (cascades to costs). |
| `GET /api/cost/summary/daily` | Bearer | Daily spending totals (`?days=7&currency=IDR&include_drafts=false`). |
| `GET /api/cost/categories` | Bearer | List user expense categories. |
| `PATCH /api/cost/categories/:id` | Bearer | Update category `emoji`, `name`, `color`. |
| `GET /api/cost` | Bearer | Flat list of cost line items (`?month=` optional). |
| `GET /api/cost/:id` | Bearer | Single cost. |
| `POST /api/cost` | Bearer | Create one cost + parent expense (shim). |
| `PATCH /api/cost/:id` | Bearer | Update cost line fields only. |
| `DELETE /api/cost/:id` | Bearer | Delete cost line. |
| `POST /api/cost/from-bill` | Bearer | Multipart image → AI → draft expense + nested costs. |
| `POST /api/cost/from-text` | Bearer | JSON text → AI → draft expense + nested costs. |

There is **no** version prefix (e.g. `/v1`). All JSON bodies use **`Content-Type: application/json`** unless noted.

## Base URL and discovery

| Resource | Path |
|----------|------|
| Default local server | `http://localhost:3222` (override with `PORT`) |
| OpenAPI (machine-readable) | `GET /openapi.json` |
| Swagger UI | `GET /docs` |
| Health (Supabase env flags) | `GET /api/health/supabase` |

Set **`PUBLIC_BACKEND_URL`** on the server to your public API origin (no trailing slash), e.g. `https://api.example.com`. Some OpenAPI `servers` entries use this value.

For local development, the process listens on **`HOST`** (default `0.0.0.0`) and **`PORT`** (default **3222**); use `http://localhost:3222` from the simulator or browser.

## CORS and cookies

- **CORS** is enabled with **`origin: true`** (echoes the request’s `Origin` header) and **`credentials: true`**. From a browser, call the API with:
  - `fetch(url, { credentials: 'include' })` **if** you rely on cookies (Google OAuth to this host), and
  - your web app’s origin must be allowed by your deployment (this server does not maintain a fixed allowlist; it reflects the caller origin).
- **Google OAuth (PKCE)** stores verifier state in **httpOnly** cookies whose names are derived by Supabase (`sb_o_` + hash). Those cookies are **scoped to this API’s host** and **`Path: /`**, **`SameSite=Lax`**, **`Secure` in production**, ~**10 minutes** TTL.
- **Native post-login target** uses a separate cookie **`costa_oauth_post_redirect`** (same cookie options) when you pass **`redirect_to`** on `GET /api/auth/oauth/google` (see [Native iOS](#native-ios-costa-app)). It is cleared when the callback runs.

Cookie-based flows only work if the **first** OAuth hop (this API) and the **callback** see the **same cookie jar** for the API host (same browser / `ASWebAuthenticationSession` session, no blocking of third-party cookies on that navigation).

## Authentication model

Protected routes expect:

```http
Authorization: Bearer <supabase_access_token>
```

The header value is the raw JWT string (no extra quotes). The token is the Supabase **`session.access_token`** from `LoginResponse`.

### `LoginResponse` shape (JSON)

Use this as your single “logged-in” contract for password login, OAuth JSON callback, and OAuth **fragment** payload on success.

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "app_metadata": {},
    "user_metadata": {}
  },
  "session": {
    "access_token": "eyJ…",
    "refresh_token": "…",
    "expires_in": 3600,
    "expires_at": 1712345678,
    "token_type": "bearer"
  }
}
```

- **`expires_at`** may be `null` in edge cases; prefer **`expires_in`** (seconds) when present.
- **`app_metadata` / `user_metadata`** are opaque objects from Supabase; do not assume fixed keys.

### Error shape

Most failures return JSON:

```json
{ "error": "human-readable message" }
```

Some **`POST /api/cost/from-bill`** and **`POST /api/cost/from-text`** responses add **`extraction`** (model metadata) on **400** or **422**; see [AI extraction routes](#ai-extraction-routes) below.

**Typical status codes**

| Code | When |
|------|------|
| **400** | Bad request body, validation, or DB error surfaced as message. |
| **401** | Missing/invalid `Authorization`, bad OAuth/provider error, failed code exchange. |
| **404** | Cost id not found (or reserved path segment). |
| **422** | AI ran but produced **no** line items / no quantifiable expenses. |
| **502** | Upstream auth/OAuth failure (e.g. provider URL missing). |
| **503** | Supabase not configured on server (`SUPABASE_*` missing). |
| **204** | Successful `POST /api/auth/logout` (empty body). |

`GET /` returns **plain text**, not JSON.

---

## Auth endpoints

### Password login

`POST /api/auth/login`  
**Body (JSON):** `{ "email": "...", "password": "..." }` — both required non-empty strings.

| Status | Body |
|--------|------|
| **200** | `LoginResponse` |
| **400** | `{ "error": "email and password are required" }` |
| **401** | `{ "error": "<Supabase message>" }` |
| **500** | Session missing after sign-in (rare) |
| **503** | `{ "error": "Supabase is not configured" }` |

This is the most straightforward path for SPAs that post JSON from their own origin (no cookies required).

### Logout

`POST /api/auth/logout`  
**Headers:** `Authorization: Bearer <access_token>` (required).

| Status | Body |
|--------|------|
| **204** | Empty |
| **400** | Sign-out failed (`error` message) |
| **401** | Missing Bearer token |
| **503** | Supabase not configured |

### Google OAuth

This BFF acts as the OAuth intermediary so **any HTTP client** (iOS, Android, React Native, Flutter, web) can complete Google sign-in without a platform-specific SDK. Tokens travel **only over HTTPS in a POST response body** — never in a URL.

**Full flow (native clients)**

```
App                       BFF                  Google / Supabase
 |                         |                         |
 |-- GET /oauth/google?redirect_to=costa://oauth ---->|
 |                         |-- signInWithOAuth PKCE ->|
 |<-- 302 to Google --------|                         |
 |--- (user signs in) ------------------------------>|
 |                         |<-- ?code= callback ------|
 |                         |-- exchangeCodeForSession ->|
 |                         |<-- session (server-side) -|
 |                         |-- store nonce (60 s)      |
 |<-- 302 costa://oauth?code=<nonce> ------------------|
 |-- POST /api/auth/mobile/exchange { code } -------->|
 |<-- 200 { user, session } (HTTPS body) -------------|
```

**Step 1 — `GET /api/auth/oauth/google`**

Sets PKCE cookies, then **302** redirect to Google.

| Query | Notes |
|-------|-------|
| `redirect_to` *(optional)* | `costa://…` scheme only; max 2048 chars decoded. Invalid values silently ignored — callback falls back to web JSON. |

**Step 2 — `GET /api/auth/oauth/google/link`** *(Swagger / debug)*

Same PKCE setup but returns **200** JSON `{ "url": "…" }` instead of following the 302. Use in Swagger or any context where `fetch()` cannot follow a redirect.

**Step 3 — `GET /api/auth/oauth/google/callback`** *(called by Supabase — app never calls this)*

Exchanges `?code=` server-to-server with Supabase.

- **Native path** (`redirect_to` present): **302** to `costa://oauth?code=<nonce>`. On error: `302 costa://oauth?error=<message>`. Nonce is **60 s**, **single-use**, stored server-side — **no tokens in the URL**.
- **Web path** (no `redirect_to`): **200** `application/json` `LoginResponse` or `{ "error": "…" }`.

The BFF embeds `redirect_to` in Supabase's `redirectTo` URL so the server detects the native path even if cookies were dropped (different host, `localhost` vs `127.0.0.1`, etc.).

**Step 4 — `POST /api/auth/mobile/exchange`** *(native only)*

Consumes the nonce and returns the session in the **HTTPS response body**.

```http
POST /api/auth/mobile/exchange
Content-Type: application/json

{ "code": "<nonce-from-costa://oauth?code=…>" }
```

```json
// 200 — success
{ "user": { "id": "…", "email": "…" }, "session": { "access_token": "…", "refresh_token": "…" } }

// 401 — expired or already used
{ "error": "Invalid or expired code" }
```

**Supabase URL configuration** (Dashboard → Authentication → URL configuration)

- **Redirect URLs** must include:
  - `{PUBLIC_BACKEND_URL}/api/auth/oauth/google/callback`
  - `{PUBLIC_BACKEND_URL}/api/auth/oauth/google/callback?redirect_to=costa%3A%2F%2Foauth`
- Add **`costa://oauth`** if Supabase validates custom schemes.
- Make sure **Site URL** does not route to `GET /` (API root) — the `/callback` path must be in allowed redirects.

`PUBLIC_BACKEND_URL` must be the same host used in your native session and Supabase config. Mixing `localhost` and `127.0.0.1` breaks the PKCE cookie.

**For SPAs:** Without `redirect_to`, the callback returns **200 JSON** directly. The simplest SPA auth is **`POST /api/auth/login`** (email/password).

### Native client integration (platform-agnostic)

Any HTTP client uses the same two-step pattern — no platform SDK required.

**iOS / Swift (`ASWebAuthenticationSession`)**

```swift
let startURL = URL(string: "\(API)/api/auth/oauth/google?redirect_to=costa%3A%2F%2Foauth")!
let session = ASWebAuthenticationSession(
    url: startURL,
    callbackURLScheme: "costa"
) { callbackURL, error in
    guard let url = callbackURL, error == nil else { return }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    if let err = items?.first(where: { $0.name == "error" })?.value {
        // show err
        return
    }
    guard let code = items?.first(where: { $0.name == "code" })?.value else { return }
    Task {
        var req = URLRequest(url: URL(string: "\(API)/api/auth/mobile/exchange")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code])
        let (data, _) = try await URLSession.shared.data(for: req)
        let loginResponse = try JSONDecoder().decode(LoginResponse.self, from: data)
        // store loginResponse.session.access_token for cost API Authorization header
    }
}
session.presentationContextProvider = self
session.start()
```

**Android / Kotlin (Chrome Custom Tabs + intent filter for `costa://`)**

```kotlin
// Start OAuth in a Custom Tab
val uri = Uri.parse("$API/api/auth/oauth/google?redirect_to=costa%3A%2F%2Foauth")
CustomTabsIntent.Builder().build().launchUrl(context, uri)

// In the Activity that receives the costa:// intent
val code = intent.data?.getQueryParameter("code") ?: return
val error = intent.data?.getQueryParameter("error")
if (error != null) { /* show error */; return }

val body = """{"code":"$code"}""".toRequestBody("application/json".toMediaType())
val resp = OkHttpClient().newCall(
    Request.Builder().url("$API/api/auth/mobile/exchange").post(body).build()
).execute()
// parse resp.body for access_token
```

**React Native / Expo (`expo-web-browser`)**

```ts
import * as WebBrowser from 'expo-web-browser'

const result = await WebBrowser.openAuthSessionAsync(
  `${API}/api/auth/oauth/google?redirect_to=${encodeURIComponent('costa://oauth')}`,
  'costa://oauth',
)
if (result.type !== 'success') return

const url = new URL(result.url)
const code = url.searchParams.get('code')
const error = url.searchParams.get('error')
if (error || !code) { /* show error */ return }

const res = await fetch(`${API}/api/auth/mobile/exchange`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code }),
})
const { session } = await res.json()
// session.access_token → Authorization: Bearer for all cost API calls
```

### Nonce security properties

| Property | Value |
|----------|-------|
| Entropy | 32 bytes (`crypto.randomBytes`) — 256-bit, URL-safe base64 |
| TTL | **60 seconds** — just enough for the exchange call |
| Single-use | Deleted on first successful read |
| Token exposure in URLs | **None** — tokens travel only in HTTPS response bodies |
| Multi-instance note | ⚠️ In-memory store; replace with Redis or a DB row for multi-server deployments |

### Symptoms and fixes

| What you see | Cause | Fix |
|--------------|-------|-----|
| Plain text `"Costa API — OpenAPI…"` at `GET /` | Supabase **Site URL** redirected to API root (no path) | Add full `/callback` path to Supabase **Redirect URLs** |
| `200 JSON LoginResponse` in the sign-in sheet | `redirect_to` missing from callback URL query and cookie dropped | Use consistent host everywhere; add `?redirect_to=…` variant in Supabase |
| `401 Invalid or expired code` on exchange | > 60 s since callback, or nonce consumed twice | Restart the OAuth flow |
| `costa://oauth?error=…` | Auth / provider failure | `decodeURIComponent(url.searchParams.get('error'))` and show to user |

### Session refresh

This repo does **not** expose `POST /api/auth/refresh`. Options:

- **Supabase client on device:** initialize `@supabase/supabase-js` / Swift SDK with the same project URL + anon key, call `refreshSession` with the stored `refresh_token`.
- **BFF-only:** when cost API returns **401**, repeat the OAuth flow or prompt email/password login.

Use `session.expires_at` (Unix seconds) or `expires_in` to schedule proactive refresh.


---

## Cost API (all require Bearer token)

Base path: `/api/cost`  
Every handler runs **`requireAuth`**. Without a valid Bearer JWT:

```json
{ "error": "Authorization Bearer access token required" }
```

or after verification failure:

```json
{ "error": "Invalid or expired access token" }
```

(**401** in both cases.)

### Data model

One **expense** = one transaction header (`date`, `name`, `location`, `payment_method`, `notes`, `is_draft`). One or more **costs** = line items (`name`, `category_id`, `amount`, `currency`, `expense_id`). Reporting month is derived from `expense.date`.

`is_draft: true` = AI-extracted, pending user confirmation. Draft expenses are excluded from daily totals by default.

### List expenses — `GET /api/expenses`

Primary receipt / transaction view. Returns expenses ordered by `date` desc. Each expense includes nested `costs[]`.

**Query (optional):** `month=YYYY-MM`, `draft=true|false`.

**200:** `{ "expenses": [ { …, "costs": [ … ] } ] }`

### Create expense — `POST /api/expenses`

Creates an expense and its line items atomically.

**Body (JSON):** `date` (required, `YYYY-MM-DD`), `costs[]` (required, ≥1 line: `name`, `category_id`, `amount`). Optional: `name`, `location`, `notes`, `payment_method`, `is_draft` (default `false`).

**201:** `{ "expense": { … }, "costs": [ … ] }`

### Update expense — `PATCH /api/expenses/:id`

Patch any subset of `date`, `name`, `location`, `notes`, `payment_method`, `is_draft`. Set `is_draft: false` to confirm a draft.

**200:** `{ "expense": { …, "costs": [ … ] } }`

### List cost line items — `GET /api/cost`

Flat feed of cost line items ordered by `created_at` desc. Each cost embeds an `expense` header object.

**Query (optional):** `month=YYYY-MM` — filters by parent `expense.date` in that month.

**200:** `{ "costs": [ /* Cost */ ] }`

### Get one cost

`GET /api/cost/:id`  
**200:** `{ "cost": { ... } }`  
**404:** not found.

### Create cost (single-line shim) — `POST /api/cost`

Creates one cost line + parent expense. For multi-line receipts, use `POST /api/expenses`.

**Body (JSON):** required `name`, `category_id` (UUID), `amount`, and `date` (`YYYY-MM-DD`) or `billing_month` (`YYYY-MM`). Optional: `currency`, `expense_name`, `location`, `notes`, `payment_method`.

**201:** `{ "cost": { … }, "expense": { … } }`

### Update cost — `PATCH /api/cost/:id`

Patch **line-item fields only**: `name`, `category_id`, `amount`, `currency`. For `date`, `location`, `notes`, `payment_method`, `is_draft` — use `PATCH /api/expenses/:id`.

**200:** `{ "cost": { ... } }`

### Delete cost

`DELETE /api/cost/:id`  
**204:** success.

### AI extraction routes

`POST /api/cost/from-bill` — multipart image → GPT → **draft** expense + nested costs  
`POST /api/cost/from-text` — JSON text → GPT → **draft** expense + nested costs

Both create `is_draft: true`. Confirm with `PATCH /api/expenses/:id { "is_draft": false }`.

**`from-bill`:** `multipart/form-data`, field `image` or `file` (JPEG/PNG/WebP/GIF/HEIC, max 12 MB).

**`from-text`:** `{ "text": "…" }` (max 12 000 chars). Optional: `billing_month`, `default_currency`.

**201** (both routes):

```json
{
  "expense": {
    "id": "uuid",
    "name": "Indomaret",
    "date": "2026-05-08",
    "is_draft": true,
    "costs": [
      { "name": "Air mineral", "amount": 5000, "currency": "IDR", "category": { "emoji": "💧", "name": "Drinks" } }
    ]
  },
  "extraction": { "merchant": "Indomaret", "summary": "…", "line_count": 3 }
}
```

Read line items from `response.expense.costs[]` — there is **no** top-level `costs` key.

| Status | Meaning |
|--------|---------|
| **201** | Draft expense + nested costs inserted. |
| **400** | Upload/validation error or Postgres error; may include `extraction`. |
| **422** | Model ran but zero items; includes `error` and `extraction`. |
| **502** / **503** | Upstream model or config errors. |

---

## Object shapes

### `Expense`

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID | |
| `name` | string | Merchant / title (may be empty) |
| `date` | string (`YYYY-MM-DD`) | Transaction day; drives monthly reporting |
| `location` | string | Venue (may be empty) |
| `payment_method` | enum | `UNSPECIFIED \| CASH \| CREDIT_CARD \| DEBIT_CARD \| BANK_TRANSFER \| E_WALLET \| QR_PAY \| OTHER` |
| `notes` | string or null | |
| `is_draft` | boolean | `true` = under review; `false` = posted |
| `costs` | `Cost[]` | Embedded on `/api/expenses` and extraction routes |

### `Cost` object shape

| Field | Notes |
|-------|--------|
| `id` | UUID |
| `expense_id` | UUID — FK to parent `expenses` |
| `name` | Line-item label |
| `category` | Joined `CostCategory` object |
| `category_id` | UUID |
| `amount` | number |
| `currency` | ISO 4217 |
| `expense` | `ExpenseHeader` (no nested costs) — embedded on `GET /api/cost` |
| `created_at` / `updated_at` | ISO 8601 |

**Example:**

```json
{
  "id": "…",
  "user_id": "…",
  "expense_id": "…",
  "name": "Cappuccino",
  "category": { "id": "…", "emoji": "☕", "name": "Coffee", "color": "#9c5c1a", "is_generated_by_ai": false },
  "category_id": "…",
  "amount": 65000,
  "currency": "IDR",
  "expense": {
    "id": "…", "name": "Starbucks", "date": "2026-05-08",
    "location": "Jakarta", "payment_method": "CREDIT_CARD",
    "notes": null, "is_draft": false
  },
  "created_at": "2026-05-08T10:00:00.000Z",
  "updated_at": "2026-05-08T10:00:00.000Z"
}
```

### `PATCH /api/cost/:id` notes

Send **at least one** of: `name`, `category_id`, `amount`, `currency`. Omit keys you do not change. For expense-level fields (`date`, `location`, `notes`, `payment_method`, `is_draft`) — use `PATCH /api/expenses/:id`. Empty patch object → **400**.

---

## Minimal fetch examples

Replace `API` with your base URL (e.g. `http://localhost:3222`).

### Shared helper (TypeScript)

```ts
async function apiJson<T>(
  path: string,
  init: RequestInit & { accessToken?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.accessToken) {
    headers.set('Authorization', `Bearer ${init.accessToken}`)
  }
  const res = await fetch(`${API}${path}`, { ...init, headers })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  }
  return data as T
}
```

### Login

```ts
const res = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
const data = await res.json()
if (!res.ok) throw new Error(data.error ?? res.statusText)
const accessToken = data.session.access_token
```

### Google OAuth entry URL (native)

Use this as the **initial** URL for `ASWebAuthenticationSession` (not the Supabase URL directly):

```txt
GET {API}/api/auth/oauth/google?redirect_to=costa%3A%2F%2Foauth
```

### List this month's expenses

```ts
const res = await fetch(`${API}/api/expenses?month=2026-05`, {
  headers: { Authorization: `Bearer ${accessToken}` },
})
const { expenses } = await res.json()
// Each expense has .costs[] — ready for a receipt list screen
```

### Create a multi-line expense

```ts
const res = await fetch(`${API}/api/expenses`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    date: '2026-05-08',
    name: 'Starbucks',
    payment_method: 'CREDIT_CARD',
    costs: [
      { name: 'Cappuccino', category_id: '<uuid>', amount: 65000, currency: 'IDR' },
      { name: 'Muffin',     category_id: '<uuid>', amount: 35000, currency: 'IDR' },
    ],
  }),
})
const { expense, costs } = await res.json()
```

### Bill upload + confirm draft

```ts
const form = new FormData()
form.append('image', file) // or 'file'

const res = await fetch(`${API}/api/cost/from-bill`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: form,
})
const { expense, extraction } = await res.json()
// expense.is_draft === true; expense.costs[] has extracted items

// After user review, confirm:
await fetch(`${API}/api/expenses/${expense.id}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ is_draft: false }),
})
```

### From text

```ts
const res = await fetch(`${API}/api/cost/from-text`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    text: 'Spent Rp50k on coffee and $12 on lunch',
    default_currency: 'USD',
  }),
})
const { expense } = await res.json()
// expense.is_draft === true; read items from expense.costs[]
```

### Logout

```ts
const res = await fetch(`${API}/api/auth/logout`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
})
if (res.status !== 204) {
  const data = await res.json().catch(() => ({}))
  throw new Error(data.error ?? res.statusText)
}
```

---

## Health: Supabase configuration

`GET /api/health/supabase` returns JSON (no auth) so deploy scripts or the app can sanity-check the server:

```json
{
  "url": true,
  "anonKey": true,
  "publishableKey": false,
  "serviceRoleKey": true,
  "ready": true
}
```

**`ready`** is `true` when **`SUPABASE_URL`** is set and at least one of anon/publishable **or** service-role key is set. This does **not** prove RLS or Google OAuth are configured correctly.

---

## Codegen and types

- Import **`GET /openapi.json`** into OpenAPI generators (e.g. `openapi-typescript`, Orval) to produce clients and types.
- After changing routes, update `src/openapi/openapi-document.ts` if you rely on the checked-in spec matching handlers.

---

## Environment notes (backend only)

Frontend developers usually only need the **public API URL**. Server operators need Supabase keys, `PUBLIC_BACKEND_URL`, and `OPENAI_API_KEY` for AI routes — see `.env.example` in the repo root.

**OAuth (native):** Optional **`OAUTH_NATIVE_HTML_COMPLETE=1`** — see [Google OAuth](#google-oauth) / [Native iOS](#native-ios-costa-app). The mobile or web app **does not** need `OPENAI_API_KEY`; bill and text extraction are server-side only.
