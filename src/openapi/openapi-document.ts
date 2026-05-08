/**
 * OpenAPI 3 document for Swagger UI (`/docs`).
 * Keep in sync with route handlers in `src/routes/`.
 */
import 'dotenv/config'

/** Swagger needs an absolute URL; '/' breaks fetch with "scheme must be http or https". */
function openapiServerBaseUrl(): string {
  const u = process.env.PUBLIC_BACKEND_URL?.trim()?.replace(/\/$/, '')
  if (u) {
    return u
  }
  return `http://localhost:${process.env.PORT || '3222'}`
}

/** Shared extraction metadata shape (reused across from-bill and from-text responses). */
const ExtractionMeta = {
  type: 'object',
  properties: {
    merchant: { type: 'string', nullable: true },
    summary: { type: 'string', nullable: true },
    transaction_date: { type: 'string', nullable: true },
    location: { type: 'string', nullable: true },
    payment_method: { type: 'string', nullable: true },
  },
} as const

const ExtractionMetaWithCount = {
  type: 'object',
  properties: {
    ...ExtractionMeta.properties,
    line_count: { type: 'integer' },
  },
} as const

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Costa API',
    version: '1.0.0',
    description:
      'Express + Supabase auth and cost tracking. Use **POST /api/auth/login** (or Google OAuth) to obtain `session.access_token`, then **Authorize** with `Bearer <token>`.',
  },
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Expense' },
    { name: 'Cost' },
  ],
  servers: [
    {
      url: openapiServerBaseUrl(),
      description:
        'From PUBLIC_BACKEND_URL, or localhost + PORT (default 3222). Open Swagger on the same host/port.',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Supabase `access_token` from login or OAuth callback.',
      },
    },
    schemas: {
      ErrorMessage: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
      SupabaseConfigStatus: {
        type: 'object',
        properties: {
          url: { type: 'boolean' },
          anonKey: { type: 'boolean' },
          publishableKey: { type: 'boolean' },
          serviceRoleKey: { type: 'boolean' },
          ready: { type: 'boolean' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', format: 'password' },
        },
      },
      AuthUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', nullable: true },
          app_metadata: { type: 'object', additionalProperties: true },
          user_metadata: { type: 'object', additionalProperties: true },
        },
      },
      AuthSession: {
        type: 'object',
        properties: {
          access_token: { type: 'string' },
          refresh_token: { type: 'string' },
          expires_in: { type: 'integer' },
          expires_at: { type: 'integer', nullable: true },
          token_type: { type: 'string' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/AuthUser' },
          session: { $ref: '#/components/schemas/AuthSession' },
        },
      },
      DailyPoint: {
        type: 'object',
        required: ['date', 'total', 'currency'],
        description:
          'One data point representing aggregate spending for a single UTC day. ' +
          'Draft expenses are excluded unless `include_drafts=true` is passed.',
        properties: {
          date: { type: 'string', format: 'date', example: '2026-05-05', description: 'UTC date (YYYY-MM-DD)' },
          total: { type: 'number', example: 10000, description: 'Sum of all matching costs for this day' },
          currency: {
            type: 'string',
            example: 'IDR',
            description: 'ISO 4217 code, or `"MIXED"` when costs span multiple currencies and no filter is applied',
          },
          breakdown: {
            type: 'object',
            additionalProperties: { type: 'number' },
            description: 'Present only when `currency` is `"MIXED"`. Keys are currency codes, values are per-currency totals.',
            example: { IDR: 10000, USD: 2 },
          },
        },
      },
      CostCategory: {
        type: 'object',
        description:
          'Joined from `cost_categories` when `category_id` is set.',
        properties: {
          id: { type: 'string', format: 'uuid', nullable: true },
          emoji: { type: 'string' },
          name: { type: 'string' },
          color: {
            type: 'string',
            description: 'UI tint: `#RGB`, `#RRGGBB`, or `#RRGGBBAA`; empty string when unset.',
            example: '#2d7ef7',
          },
          is_generated_by_ai: {
            type: 'boolean',
            description: 'True when the category row was created by extraction (not manual).',
          },
        },
      },
      CostCategoryRecord: {
        type: 'object',
        description: 'Row from `cost_categories` (GET list / PATCH response).',
        required: ['id', 'emoji', 'name', 'is_generated_by_ai', 'color'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          emoji: { type: 'string' },
          name: { type: 'string' },
          color: {
            type: 'string',
            description: 'Hex color or empty.',
            example: '#2d7ef7',
          },
          is_generated_by_ai: { type: 'boolean' },
        },
      },
      CostCategoryPatch: {
        type: 'object',
        properties: {
          emoji: { type: 'string' },
          name: { type: 'string' },
          color: {
            type: 'string',
            nullable: true,
            description:
              'Hex `#RGB`, `#RRGGBB`, `#RRGGBBAA`, empty string, or null to clear.',
          },
        },
      },
      PaymentMethod: {
        type: 'string',
        enum: ['UNSPECIFIED', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'E_WALLET', 'QR_PAY', 'OTHER'],
        description: 'How the expense was paid. `UNSPECIFIED` = unknown / not set. Matches Postgres `public.payment_method` enum.',
        example: 'CREDIT_CARD',
      },
      /**
       * ExpenseHeader — expense fields only, no nested costs array.
       * Used as the embedded `expense` on Cost objects to avoid a circular ref.
       */
      ExpenseHeader: {
        type: 'object',
        description:
          'Expense header fields (no nested costs). Embedded on Cost as `.expense` to avoid circular references. ' +
          'Use GET /api/expenses for the full expense + costs shape.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          name: {
            type: 'string',
            description: 'Whole-expense title (merchant or user label). Distinct from `costs.name`.',
          },
          date: {
            type: 'string',
            format: 'date',
            example: '2026-05-08',
            description: 'Transaction / spend calendar day (`YYYY-MM-DD`). Reporting month = `date_trunc(\'month\', date)`.',
          },
          location: { type: 'string', description: 'Venue / city / address (may be empty).' },
          payment_method: { $ref: '#/components/schemas/PaymentMethod' },
          notes: { type: 'string', nullable: true },
          is_draft: {
            type: 'boolean',
            description:
              'True while the expense is under review (AI-extracted, not yet confirmed). ' +
              'False = posted and counted in reports. Draft expenses are excluded from `summary/daily` by default.',
          },
          confidence_score: {
            type: 'number',
            nullable: true,
            minimum: 0,
            maximum: 1,
            description: 'Model-estimated extraction confidence in [0,1]. Null for manual or unknown.',
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      /** Full expense — includes optional nested costs array (GET /api/expenses). */
      Expense: {
        type: 'object',
        description:
          'One logical spend event (receipt / transaction). ' +
          'The `costs` array is embedded when fetched via GET /api/expenses or extraction routes.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          name: {
            type: 'string',
            description: 'Whole-expense title (merchant or user label). Distinct from `costs.name`.',
          },
          date: {
            type: 'string',
            format: 'date',
            example: '2026-05-08',
            description: 'Transaction / spend calendar day (`YYYY-MM-DD`). Reporting month = `date_trunc(\'month\', date)`.',
          },
          location: { type: 'string', description: 'Venue / city / address (may be empty).' },
          payment_method: { $ref: '#/components/schemas/PaymentMethod' },
          notes: { type: 'string', nullable: true },
          is_draft: {
            type: 'boolean',
            description:
              'True while the expense is under review (AI-extracted, not yet confirmed). ' +
              'False = posted and counted in reports.',
          },
          confidence_score: {
            type: 'number',
            nullable: true,
            minimum: 0,
            maximum: 1,
            description: 'Model-estimated extraction confidence in [0,1]. Null for manual or unknown.',
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          costs: {
            type: 'array',
            description: 'Embedded when fetched via GET /api/expenses or extraction routes.',
            items: { $ref: '#/components/schemas/Cost' },
          },
          charges: {
            type: 'array',
            description: 'Tax / service charges attached to this expense.',
            items: { $ref: '#/components/schemas/ExpenseCharge' },
          },
        },
      },
      ExpenseCreate: {
        type: 'object',
        required: ['date', 'costs'],
        properties: {
          date: {
            type: 'string',
            format: 'date',
            example: '2026-05-08',
            description: '`YYYY-MM-DD` (or `YYYY-MM` → day 1). Required.',
          },
          name: { type: 'string', description: 'Merchant / receipt title.', example: 'Starbucks' },
          location: { type: 'string', maxLength: 500 },
          notes: { type: 'string', nullable: true, maxLength: 8000 },
          payment_method: { $ref: '#/components/schemas/PaymentMethod' },
          is_draft: {
            type: 'boolean',
            default: false,
            description: 'Mark as draft on creation. Defaults to `false` (posted immediately).',
          },
          confidence_score: {
            type: 'number',
            nullable: true,
            minimum: 0,
            maximum: 1,
            description: 'Model-estimated extraction confidence in [0,1]. Optional; null for manual entries.',
          },
          costs: {
            type: 'array',
            minItems: 1,
            description: 'Line items (at least one required).',
            items: { $ref: '#/components/schemas/CostLineCreate' },
          },
          charges: {
            type: 'array',
            description: 'Optional tax / service charges.',
            items: { $ref: '#/components/schemas/ExpenseChargeInput' },
          },
        },
      },
      ExpensePatch: {
        type: 'object',
        description: 'Fields that can be patched on an expense.',
        properties: {
          date: { type: 'string', format: 'date', description: '`YYYY-MM-DD` or `YYYY-MM` (→ day 1).' },
          name: { type: 'string' },
          location: { type: 'string', maxLength: 500 },
          notes: { type: 'string', nullable: true, maxLength: 8000 },
          payment_method: { $ref: '#/components/schemas/PaymentMethod' },
          is_draft: {
            type: 'boolean',
            description: 'Set `false` to confirm/post a draft expense, or `true` to revert to draft.',
          },
          confidence_score: {
            type: 'number',
            nullable: true,
            minimum: 0,
            maximum: 1,
            description: 'Override or clear the extraction confidence score.',
          },
          charges: {
            type: 'array',
            nullable: true,
            description: 'Replace all charges on this expense. Empty array clears all. Omit to leave unchanged.',
            items: { $ref: '#/components/schemas/ExpenseChargeInput' },
          },
        },
      },
      ExpenseChargeType: {
        type: 'string',
        enum: ['tax', 'service_charge'],
        description: 'Category of surcharge attached to an expense.',
      },
      ExpenseChargeAmountType: {
        type: 'string',
        enum: ['percentage', 'fix_amount'],
        description: 'How the charge amount is expressed: percentage (0–100) or a fixed monetary amount.',
      },
      ExpenseCharge: {
        type: 'object',
        description: 'A tax or service charge attached to an expense.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          expense_id: { type: 'string', format: 'uuid' },
          type: { $ref: '#/components/schemas/ExpenseChargeType' },
          amount_type: { $ref: '#/components/schemas/ExpenseChargeAmountType' },
          amount: {
            type: 'number',
            minimum: 0,
            description: 'Charge value. For `percentage`: 0–100 (e.g. 11 = 11%). For `fix_amount`: major currency units.',
          },
          currency: {
            type: 'string',
            nullable: true,
            description: 'ISO 4217 code; relevant when `amount_type = fix_amount`. Null means same currency as parent expense.',
          },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ExpenseChargeInput: {
        type: 'object',
        required: ['type', 'amount_type', 'amount'],
        description: 'Input shape for creating or replacing an expense charge.',
        properties: {
          type: { $ref: '#/components/schemas/ExpenseChargeType' },
          amount_type: { $ref: '#/components/schemas/ExpenseChargeAmountType' },
          amount: {
            type: 'number',
            minimum: 0,
            description: 'For `percentage`: 0–100. For `fix_amount`: major currency units.',
          },
          currency: {
            type: 'string',
            nullable: true,
            description: 'ISO 4217; used when `amount_type = fix_amount`.',
          },
        },
      },
      CostLineCreate: {
        type: 'object',
        required: ['name', 'category_id', 'amount'],
        description: 'One line item inside an expense creation request.',
        properties: {
          name: { type: 'string', example: 'Cappuccino' },
          category_id: { type: 'string', format: 'uuid', description: 'FK to `cost_categories` owned by the user.' },
          qty: {
            type: 'number',
            exclusiveMinimum: 0,
            default: 1,
            description: 'Purchase quantity (e.g. 3 coffees, 1.5 kg). Defaults to 1.',
          },
          amount: { type: 'number', minimum: 0, example: 5.5, description: 'Line total in major currency units regardless of qty.' },
          currency: { type: 'string', default: 'USD', example: 'USD' },
        },
      },
      Cost: {
        type: 'object',
        description: 'Line item linked to a parent `expenses` row.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          expense_id: { type: 'string', format: 'uuid', description: 'FK to `expenses`.' },
          name: { type: 'string', description: 'Line-item label.' },
          category: { $ref: '#/components/schemas/CostCategory' },
          category_id: { type: 'string', format: 'uuid', description: 'FK to cost_categories.' },
          qty: {
            type: 'number',
            exclusiveMinimum: 0,
            default: 1,
            description: 'Purchase quantity. 1 for single-unit items.',
          },
          amount: { type: 'number', description: 'Line total in major currency units.' },
          currency: { type: 'string', example: 'USD' },
          expense: {
            description:
              'Parent expense context (date, location, payment_method, notes, is_draft, confidence_score). ' +
              'Uses ExpenseHeader (no nested costs) to avoid circular references.',
            nullable: true,
            allOf: [{ $ref: '#/components/schemas/ExpenseHeader' }],
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      CostCreate: {
        type: 'object',
        required: ['name', 'category_id', 'amount'],
        description:
          'Create a single cost line (implicitly creates a parent expense). ' +
          'Prefer POST /api/expenses for full control or multi-line receipts.',
        properties: {
          name: { type: 'string', description: 'Line-item label.' },
          category_id: { type: 'string', format: 'uuid', description: 'FK to cost_categories.' },
          qty: {
            type: 'number',
            exclusiveMinimum: 0,
            default: 1,
            description: 'Purchase quantity. Defaults to 1.',
          },
          amount: { type: 'number', minimum: 0 },
          currency: { type: 'string', default: 'USD' },
          date: {
            type: 'string',
            format: 'date',
            example: '2026-05-08',
            description: '`YYYY-MM-DD` spend date. Required (or use `billing_month` as legacy fallback).',
          },
          billing_month: {
            type: 'string',
            description: 'Legacy fallback when `date` is absent. `YYYY-MM` or date.',
            example: '2026-05',
          },
          expense_name: {
            type: 'string',
            description: 'Title for the auto-created parent expense (defaults to line name).',
          },
          location: { type: 'string', maxLength: 500 },
          notes: { type: 'string', nullable: true },
          payment_method: { $ref: '#/components/schemas/PaymentMethod' },
        },
      },
      CostPatch: {
        type: 'object',
        description:
          'Patchable fields on a cost line. ' +
          'To update date, location, notes, payment_method, or is_draft, use PATCH /api/expenses/:id.',
        properties: {
          name: { type: 'string' },
          category_id: { type: 'string', format: 'uuid', description: 'Update the line category.' },
          qty: { type: 'number', exclusiveMinimum: 0, description: 'Update the purchase quantity.' },
          amount: { type: 'number', minimum: 0 },
          currency: { type: 'string' },
        },
      },
      CostFromTextRequest: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            maxLength: 12000,
            description:
              'Informal description of spending (amounts + what they were for). Model normalizes text and derives line items.',
          },
          billing_month: {
            type: 'string',
            description:
              'Optional default month (`YYYY-MM` or date) for items when the text does not specify a date',
            example: '2026-04',
          },
          default_currency: {
            type: 'string',
            description: 'Optional ISO 4217 hint when the text does not name a currency (e.g. USD)',
            example: 'USD',
          },
        },
      },
    },
  },
  paths: {
    '/': {
      get: {
        tags: ['Health'],
        summary: 'Welcome',
        responses: {
          '200': {
            description: 'Plain text',
            content: {
              'text/plain': {
                schema: { type: 'string' },
              },
            },
          },
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['Health'],
        summary: 'OpenAPI JSON',
        responses: {
          '200': {
            description: 'Spec',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/api/health/supabase': {
      get: {
        tags: ['Health'],
        summary: 'Supabase env readiness',
        responses: {
          '200': {
            description: 'Which keys / URL are configured',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SupabaseConfigStatus' },
              },
            },
          },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Password login',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Tokens',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' },
              },
            },
          },
          '401': {
            description: 'Bad credentials',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Sign out (invalidates refresh server-side)',
        security: [{ bearerAuth: [] }],
        responses: {
          '204': { description: 'Signed out' },
          '401': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/auth/mobile/exchange': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange one-time code for session (native apps)',
        description:
          'Trades the short-lived **`code`** nonce (received in the `costa://oauth?code=…` redirect) for a full **`LoginResponse`** over HTTPS.\n\nThe nonce is **single-use** and expires in **60 seconds**. Tokens never travel in a URL — returned only in this JSON response body. This is the platform-agnostic pattern for any native client (iOS, Android, React Native, Flutter) completing Google OAuth via this BFF.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code'],
                properties: {
                  code: {
                    type: 'string',
                    description: 'One-time nonce from `costa://oauth?code=…`',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Session',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' },
              },
            },
          },
          '400': {
            description: '`code` missing from body',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': {
            description: 'Nonce unknown, expired (> 60 s), or already used',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/auth/oauth/google': {
      get: {
        tags: ['Auth'],
        summary:
          '[Browser] Start Google OAuth (302 redirect — not Swagger Try it)',
        description:
          'Sets PKCE cookies then **302** to Google.**Swagger "Try it out" fails here** (`fetch` + cross-origin redirects = CORS). Use **GET `/api/auth/oauth/google/link`** in Swagger instead, then paste the returned `url` in this browser\'s address bar.\n\n**Native clients (iOS, Android, React Native, Flutter):** pass **`redirect_to`** (URL-encoded), e.g. `costa%3A%2F%2Foauth`. Only **`costa:`** URLs are accepted. After code exchange, the callback **302** redirects to `{redirect_to}?code=<nonce>` (60 s, single-use). The client then calls **`POST /api/auth/mobile/exchange`** to receive the full session over HTTPS — **no tokens in URLs**.',
        parameters: [
          {
            name: 'redirect_to',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'costa://oauth' },
            description:
              'Optional. Post-login target for native clients (`costa://…` only). Stored in a short-lived cookie and echoed on the Supabase `redirectTo` so it survives cookie loss.',
          },
        ],
        responses: {
          '302': {
            description: 'Redirect to Supabase / Google',
            headers: {
              Location: {
                schema: { type: 'string' },
              },
              'Set-Cookie': {
                schema: { type: 'string' },
              },
            },
          },
          '500': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/auth/oauth/google/link': {
      get: {
        tags: ['Auth'],
        summary:
          '[Swagger-safe] Google OAuth — returns authorize URL (JSON)',
        description:
          'Same PKCE cookies as **`/oauth/google`**, but returns **`{ url }`** JSON so Swagger\'s `fetch` succeeds. Copy `url` into the **same browser** (cookies must match origin). Then complete login; callback hits **`/api/auth/oauth/google/callback`**.\n\nSupports the same optional **`redirect_to`** query param as **`/oauth/google`** (native **`costa:`** URLs).',
        parameters: [
          {
            name: 'redirect_to',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'costa://oauth' },
            description: 'Same as **`GET /api/auth/oauth/google?redirect_to=`**.',
          },
        ],
        responses: {
          '200': {
            description: 'Supabase/Google authorize URL',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url', 'hint'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    hint: { type: 'string' },
                  },
                },
              },
            },
          },
          '500': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/auth/oauth/google/callback': {
      get: {
        tags: ['Auth'],
        summary: 'Google OAuth callback',
        description:
          'Supabase redirects here with `?code=` after Google. PKCE cookies must be set first via **`GET /api/auth/oauth/google`** or **`GET /api/auth/oauth/google/link`** (same browser / origin).\n\n**Native (`costa://`):** When the client started with **`redirect_to=costa://…`**, this server registers Supabase **`redirectTo`** as …`/callback?redirect_to=…` so the callback can read **`redirect_to`** from the query even if the short-lived cookie was dropped (`localhost` vs `127.0.0.1`, embedded browsers). The server also sets a **`costa_oauth_post_redirect`** cookie as a fallback. Native completion is either **`302`** to `{redirect_to}#encodeURIComponent(JSON.stringify(…))` ( **`LoginResponse`** or **`{ error }`** ) or, if **`OAUTH_NATIVE_HTML_COMPLETE=1`**, **`200 text/html`** that runs **`location.replace(…same URL…)`**.\n\n**Web:** no native target → **200** **`application/json`** **`LoginResponse`** (or JSON error).',
        parameters: [
          {
            name: 'redirect_to',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'costa://oauth' },
            description:
              'Echoed from Supabase `redirectTo` when the native flow started; used with or instead of the `costa_oauth_post_redirect` cookie.',
          },
          {
            name: 'code',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Authorization code',
          },
          {
            name: 'error',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '302': {
            description:
              'Native app flow (default): redirect to `costa://…` with session or error in the URL fragment',
            headers: {
              Location: {
                schema: {
                  type: 'string',
                  example:
                    'costa://oauth#%7B%22user%22%3A%7B%22id%22%3A%22…%22%7D%2C%22session%22%3A%7B%22access_token%22%3A%22…%22%7D%7D',
                },
              },
            },
          },
          '200': {
            description:
              'Web: JSON session. Native with **`OAUTH_NATIVE_HTML_COMPLETE`**: minimal HTML that navigates to `costa://…#…`.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' },
              },
              'text/html': {
                schema: { type: 'string', description: 'HTML redirect shim when env OAUTH_NATIVE_HTML_COMPLETE is set' },
              },
            },
          },
          '400': {
            description: 'JSON error (no native `redirect_to` cookie)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/cost/summary/daily': {
      get: {
        tags: ['Cost'],
        summary: 'Daily spending totals (line chart data)',
        description:
          'Returns per-day spending totals over a rolling window of `days` days ending today (UTC). ' +
          'All days in the range are always present — days with no spend have `total: 0`. ' +
          'Draft expenses are excluded from totals by default; pass `include_drafts=true` to include them. ' +
          'Totals bucket by **parent expense `date`**, not `cost.created_at`. ' +
          'When costs span multiple currencies and no `currency` filter is provided, each point ' +
          'includes a `breakdown` object keyed by currency code and `currency` is `"MIXED"`.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'days',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 90, default: 7, example: 7 },
            description: 'Number of days to include (1–90, default 7)',
          },
          {
            name: 'currency',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'IDR' },
            description:
              'Filter to a single ISO 4217 currency code (case-insensitive). ' +
              'When provided, only costs in that currency are summed.',
          },
          {
            name: 'include_drafts',
            in: 'query',
            required: false,
            schema: { type: 'boolean', default: false },
            description:
              'When `true`, draft expenses are included in the daily totals. Default `false` (drafts excluded).',
          },
        ],
        responses: {
          200: {
            description: 'Daily totals',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['points', 'from', 'to', 'days'],
                  properties: {
                    points: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DailyPoint' },
                    },
                    from: { type: 'string', format: 'date', example: '2026-04-29', description: 'First day of range (inclusive, UTC)' },
                    to: { type: 'string', format: 'date', example: '2026-05-05', description: 'Last day of range (today UTC)' },
                    days: { type: 'integer', example: 7 },
                  },
                },
              },
            },
          },
          401: { description: 'Missing or invalid Bearer token' },
          502: { description: 'Database error' },
        },
      },
    },
    '/api/cost/categories': {
      get: {
        tags: ['Cost'],
        summary: 'List expense categories',
        description: 'Returns the authenticated user\'s `cost_categories` rows (emoji, name, color).',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Categories',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['categories'],
                  properties: {
                    categories: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/CostCategoryRecord' },
                    },
                  },
                },
              },
            },
          },
          '401': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/cost/categories/{categoryId}': {
      patch: {
        tags: ['Cost'],
        summary: 'Update expense category',
        description: 'Patch `emoji`, `name`, and/or `color` on a category you own.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'categoryId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CostCategoryPatch' },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['category'],
                  properties: {
                    category: { $ref: '#/components/schemas/CostCategoryRecord' },
                  },
                },
              },
            },
          },
          '400': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '404': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/cost': {
      get: {
        tags: ['Cost'],
        summary: 'List cost line items',
        description:
          'Returns cost line items ordered by `created_at` descending (most recent first). ' +
          'Each cost includes an embedded `expense` header (date, location, payment_method, etc.) ' +
          'and a joined `category`. ' +
          'The optional `?month=YYYY-MM` filter restricts results to line items whose **parent expense `date`** ' +
          'falls within that calendar month (half-open range on `expenses.date`, not `cost.created_at`). ' +
          'For an expense-centric view with nested costs, use GET /api/expenses instead.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'month',
            in: 'query',
            required: false,
            schema: { type: 'string', example: '2026-04' },
            description:
              'Filter by parent expense date: `YYYY-MM`. Half-open range on `expenses.date`.',
          },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    costs: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Cost' },
                    },
                  },
                },
              },
            },
          },
          '401': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
      post: {
        tags: ['Cost'],
        summary: 'Create cost (single-line shim)',
        description:
          'Creates one cost line item and its parent expense in a single request. ' +
          'Returns both `cost` and `expense`. ' +
          'For multi-line receipts or explicit expense control, use POST /api/expenses.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CostCreate' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created cost line and its parent expense',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    cost: { $ref: '#/components/schemas/Cost' },
                    expense: { $ref: '#/components/schemas/ExpenseHeader' },
                  },
                },
              },
            },
          },
          '400': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/cost/from-bill': {
      post: {
        tags: ['Cost'],
        summary: 'Upload bill image → GPT vision → insert expense (draft)',
        security: [{ bearerAuth: [] }],
        description:
          '**Authorize** first. Then under request body expand **multipart** and attach a file — field name **`image`** (recommended in Swagger UI). Alternate name **`file`** is also accepted. Only image MIME types.\n\n' +
          'Creates a **draft** expense (`is_draft: true`) with nested costs. ' +
          'Use PATCH /api/expenses/:id with `{ "is_draft": false }` to confirm it.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  image: {
                    type: 'string',
                    format: 'binary',
                    description: 'Receipt / invoice photo (preferred field for Swagger)',
                  },
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Same as image; use if client sends `file` instead',
                  },
                },
                description: 'Include one part: **`image`** (Swagger) or **`file`**.',
              },
              encoding: {
                image: {
                  contentType:
                    'image/jpeg, image/png, image/webp, image/gif, image/heic, image/heif',
                },
                file: {
                  contentType:
                    'image/jpeg, image/png, image/webp, image/gif, image/heic, image/heif',
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description:
              'Draft expense created with nested costs. `expense.is_draft` is `true`. ' +
              'Access line items via `expense.costs[]`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    expense: { $ref: '#/components/schemas/Expense' },
                    extraction: ExtractionMetaWithCount,
                  },
                },
              },
            },
          },
          '400': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    extraction: ExtractionMeta,
                  },
                },
              },
            },
          },
          '422': {
            description: 'Could not parse line items',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    extraction: ExtractionMeta,
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/cost/from-text': {
      post: {
        tags: ['Cost'],
        summary: 'Natural language → GPT → insert expense (draft)',
        security: [{ bearerAuth: [] }],
        description:
          'Send free-form text describing expenses. The model normalizes wording, infers line items, ' +
          'then creates a **draft** expense (`is_draft: true`) with nested costs. ' +
          'Access line items via `expense.costs[]`. ' +
          'Use PATCH /api/expenses/:id with `{ "is_draft": false }` to confirm.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CostFromTextRequest' },
            },
          },
        },
        responses: {
          '201': {
            description:
              'Draft expense created with nested costs. `expense.is_draft` is `true`. ' +
              'Access line items via `expense.costs[]`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    expense: { $ref: '#/components/schemas/Expense' },
                    extraction: ExtractionMetaWithCount,
                  },
                },
              },
            },
          },
          '400': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    extraction: ExtractionMeta,
                  },
                },
              },
            },
          },
          '422': {
            description: 'No quantifiable expenses in text',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    extraction: ExtractionMeta,
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/cost/{id}': {
      get: {
        tags: ['Cost'],
        summary: 'Get one cost',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    cost: { $ref: '#/components/schemas/Cost' },
                  },
                },
              },
            },
          },
          '404': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
      patch: {
        tags: ['Cost'],
        summary: 'Update cost line fields',
        description:
          'Patch `name`, `category_id`, `amount`, and/or `currency` on a cost line. ' +
          'To update expense-level fields (date, location, notes, payment_method, is_draft), use PATCH /api/expenses/:id.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CostPatch' },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    cost: { $ref: '#/components/schemas/Cost' },
                  },
                },
              },
            },
          },
          '404': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Cost'],
        summary: 'Delete cost',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '204': { description: 'Deleted' },
          '404': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/api/expenses': {
      get: {
        tags: ['Expense'],
        summary: 'List expenses with nested costs',
        description:
          'Primary endpoint for expense-centric screens. ' +
          'Returns expenses ordered by `date` descending, then `created_at` descending. ' +
          'Each expense includes its `costs[]` array of line items. ' +
          'For a flat line-item feed use GET /api/cost. ' +
          'Use `?draft=true` to review pending AI extractions, `?draft=false` for posted expenses.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'month',
            in: 'query',
            required: false,
            schema: { type: 'string', example: '2026-05' },
            description: 'Filter to a single calendar month (`YYYY-MM`). Matches `expenses.date`.',
          },
          {
            name: 'draft',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false'] },
            description:
              '`true` = draft expenses only | `false` = posted expenses only | omit = all expenses.',
          },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    expenses: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Expense' },
                    },
                  },
                },
              },
            },
          },
          '401': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorMessage' } } },
          },
        },
      },
      post: {
        tags: ['Expense'],
        summary: 'Create expense with line items',
        description:
          'Create one `expenses` row plus one or more `costs` line items in a single request. ' +
          'If the costs insert fails the expense is rolled back. ' +
          'Defaults to `is_draft: false` (posted immediately). ' +
          'Pass `is_draft: true` to create a draft for later review.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ExpenseCreate' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created expense and cost lines',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    expense: { $ref: '#/components/schemas/Expense' },
                    costs: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Cost' },
                    },
                  },
                },
              },
            },
          },
          '400': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorMessage' } } },
          },
          '401': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorMessage' } } },
          },
        },
      },
    },
    '/api/expenses/{id}': {
      get: {
        tags: ['Expense'],
        summary: 'Get one expense (with embedded costs)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { expense: { $ref: '#/components/schemas/Expense' } },
                },
              },
            },
          },
          '404': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorMessage' } } },
          },
        },
      },
      patch: {
        tags: ['Expense'],
        summary: 'Update expense fields',
        description:
          'Patch `date`, `name`, `location`, `notes`, `payment_method`, and/or `is_draft`. ' +
          'Set `is_draft: false` to confirm/post a draft expense. ' +
          'Returns the full expense with embedded costs.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ExpensePatch' },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { expense: { $ref: '#/components/schemas/Expense' } },
                },
              },
            },
          },
          '400': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorMessage' } } },
          },
          '404': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorMessage' } } },
          },
        },
      },
      delete: {
        tags: ['Expense'],
        summary: 'Delete expense (cascades to costs)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Deleted (costs removed via cascade)' },
          '404': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorMessage' } } },
          },
        },
      },
    },
  },
}
