# AroFlo API v2 Invoices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add every currently documented AroFlo API v2 invoice read, invoice creation, and existing-line update operation to the local connector while preserving all legacy tools and enforcing server-side confirmation for financial writes.

**Architecture:** Keep the legacy HMAC client unchanged and add an isolated JSON/bearer-token client under src/aroflo-v2. Register explicitly prefixed v2 tools only when AROFLO_V2_API_TOKEN is configured, share the existing conservative request budget across both clients, and bind each financial write to a short-lived single-use in-memory confirmation.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Zod 4, Model Context Protocol SDK 2.0, Vitest 4, native fetch.

**Spec:** docs/plans/2026-09-24-aroflo-v2-invoices-design.md

## Global Constraints

- Preserve the existing legacy HMAC client, tool names, contracts, and passing tests.
- Read AROFLO_V2_API_TOKEN only from the process environment; never store or return its value.
- Fix the production v2 origin to https://api.aroflo.com/v2; permit baseUrl injection only through the client constructor used by tests.
- Register v2 tools only when a non-blank v2 token exists.
- Require AROFLO_WRITE_ENABLED=true, invoices in AROFLO_WRITABLE_AREAS, and AROFLO_FINANCIAL_WRITES_ENABLED=true before a v2 execution tool is discoverable or callable.
- Require an exact preview plus a ten-minute, single-use confirmation ID for POST and PATCH operations.
- Never automatically retry POST or PATCH.
- Do not expose invoice deletion, sending, approval, payment mutation, or add/remove-line tools.
- Keep the codex/public-cloud-design worktree untouched.
- Add no production dependency; use native crypto, URL, fetch, AbortController, and the existing redaction/error classes.
- Bump package.json and .codex-plugin/plugin.json from 0.1.0 to 0.2.0 so the personal plugin update is distinguishable from the installed 0.1.0 build.
- In this Windows environment, initialise each implementation shell with:

~~~powershell
$env:PATH = 'C:\Users\repai\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;C:\Users\repai\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;' + $env:PATH
~~~

## Review Focus

1. Invoice listing combinations: reject missing status unless allStatus is 1, reject taskId plus workOrderId, and encode every accepted filter exactly once.
2. Path safety: encode invoice and line IDs as single URL path segments so slashes, question marks, percent signs, and Unicode cannot alter the endpoint.
3. Confirmation races: an expired, unknown, already-used, or concurrently consumed confirmation ID must never produce a write.
4. Hostile upstream responses: cap bodies at 3.5 MB and redact bearer tokens from malformed JSON, error messages, headers, and returned tool content.
5. Ambiguous writes: accept a documented 204 as success, but consume the confirmation and perform only one network request on timeout, 409, 422, 429, or 5xx.

## File Structure

### New source files

- src/aroflo-v2/contracts.ts — v2 invoice enums, query/input types, and safe query encoding.
- src/aroflo-v2/client.ts — bearer-token JSON transport, bounded reads, status mapping, read retries, and non-retrying writes.
- src/aroflo-v2/confirmation-store.ts — canonical operation storage with opaque single-use ten-minute IDs.
- src/tools/dependencies.ts — shared dependency interface for legacy and optional v2 clients.
- src/tools/v2-invoice-schemas.ts — strict MCP input schemas and cross-field validation.
- src/tools/v2-invoice-read-tools.ts — five read-only v2 tool definitions.
- src/tools/v2-invoice-write-tools.ts — two preview tools and two guarded execution tools.
- src/mcp/dependencies.ts — production assembly with one shared request budget.
- scripts/v2-read-only-smoke-test.ts — live health/list/detail/recipient/line read checks with no mutation path.

### New tests

- tests/integration/v2-client.test.ts
- tests/unit/v2-confirmation-store.test.ts
- tests/unit/v2-invoice-schemas.test.ts
- tests/unit/v2-invoice-read-tools.test.ts
- tests/unit/v2-invoice-write-tools.test.ts
- tests/integration/mcp-v2-invoice-tools.test.ts
- tests/unit/v2-read-only-smoke-test.test.ts

### Existing files to modify

- src/config.ts — optional v2 token.
- src/aroflo/client.ts and src/aroflo/rate-limiter.ts — injectable shared request-budget interface.
- src/tools/read-tools.ts and src/tools/write-tools.ts — import the moved shared dependency type and include the v2 token in redaction.
- src/mcp/sdk-adapter.ts and src/mcp/build-server.ts — register the v2 tool sets.
- src/transports/stdio.ts and src/transports/http.ts — use the shared production dependency factory and redact the v2 token.
- src/index.ts — export the supported v2 programmatic surface.
- tests/integration/fake-aroflo-server.ts — record redirects safely and support 204 responses, disconnects, and large/chunked bodies.
- tests/unit/config.test.ts, tests/integration/client.test.ts, tests/integration/mcp-write-gates.test.ts, tests/unit/scaffold.test.ts, and tests/unit/operator-docs.test.ts — pin compatibility and new policy.
- skills/aroflo-operator/SKILL.md — v2 selection, confirmation, and unsupported-operation rules.
- .env.example, README.md, DEPLOYMENT.md, package.json — configuration, tool reference, live read-only command, and rollout instructions.

---

### Task 1: Optional v2 configuration and shared request budget

**Files:**
- Modify: src/config.ts
- Modify: src/aroflo/rate-limiter.ts
- Modify: src/aroflo/client.ts
- Modify: tests/unit/config.test.ts
- Modify: tests/integration/client.test.ts

**Interfaces:**
- Produces: AppConfig.v2ApiToken?: string
- Produces: RequestBudget with acquire(), getDailyUsed(), and getDailyLimit()
- Produces: AroFloClientOptions.requestBudget?: RequestBudget
- Consumes: existing RateLimiter and AppConfig

- [ ] **Step 1: Write failing configuration and budget-injection tests**

Add these cases to tests/unit/config.test.ts:

~~~ts
it('loads and trims an optional v2 token without requiring it for legacy use', () => {
  expect(loadConfig(base).v2ApiToken).toBeUndefined();
  expect(loadConfig({ ...base, AROFLO_V2_API_TOKEN: '  fake-v2-token  ' }).v2ApiToken)
    .toBe('fake-v2-token');
  expect(loadConfig({ ...base, AROFLO_V2_API_TOKEN: '   ' }).v2ApiToken).toBeUndefined();
});
~~~

Add a client test that supplies a fake RequestBudget, performs one legacy GET against the fake service, and asserts acquire ran once and the returned rateBudget uses getDailyUsed() and getDailyLimit().

~~~ts
const requestBudget = {
  acquire: vi.fn(async () => undefined),
  getDailyUsed: vi.fn(() => 7),
  getDailyLimit: vi.fn(() => 1900)
};
const client = new AroFloClient({
  config,
  baseUrl: server.baseUrl,
  now: fixedNow,
  requestBudget
});
~~~

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

~~~powershell
pnpm exec vitest run tests/unit/config.test.ts tests/integration/client.test.ts
~~~

Expected: FAIL because v2ApiToken and requestBudget do not exist.

- [ ] **Step 3: Implement the optional token and budget interface**

In src/aroflo/rate-limiter.ts, export:

~~~ts
export interface RequestBudget {
  acquire(): Promise<void>;
  getDailyUsed(): number;
  getDailyLimit(): number;
}
~~~

RateLimiter already satisfies this interface. In src/aroflo/client.ts, type the limiter as RequestBudget, add requestBudget?: RequestBudget to AroFloClientOptions, and initialise it with:

~~~ts
this.limiter = options.requestBudget ?? new RateLimiter({
  now: this.now,
  sleep: this.sleep,
  limits: options.rateLimits ?? { ...DEFAULT_RATE_LIMITS }
});
~~~

In src/config.ts, parse AROFLO_V2_API_TOKEN with optionalNonBlankString and conditionally add v2ApiToken to AppConfig and the loadConfig result.

- [ ] **Step 4: Run focused and compatibility tests**

Run:

~~~powershell
pnpm exec vitest run tests/unit/config.test.ts tests/unit/rate-limiter.test.ts tests/integration/client.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add src/config.ts src/aroflo/rate-limiter.ts src/aroflo/client.ts tests/unit/config.test.ts tests/integration/client.test.ts
git commit -m "feat: prepare shared budget for AroFlo v2"
~~~

---

### Task 2: V2 invoice contracts and bearer client

**Files:**
- Create: src/aroflo-v2/contracts.ts
- Create: src/aroflo-v2/client.ts
- Modify: tests/integration/fake-aroflo-server.ts
- Create: tests/integration/v2-client.test.ts

**Interfaces:**
- Consumes: AppConfig.v2ApiToken, RequestBudget, ConnectorError, redact()
- Produces: InvoiceListQuery, CreateInvoiceInput, InvoiceLinePatch, InvoiceLineListQuery
- Produces: AroFloV2Client.healthcheck(), listInvoices(), getInvoice(), getDefaultRecipients(), createInvoice(), listInvoiceLineItems(), updateInvoiceLineItem()

- [ ] **Step 1: Write failing endpoint, authentication, and path-safety tests**

Create tests/integration/v2-client.test.ts with a config containing fake-v2-token and a fake RequestBudget. Pin these requests:

~~~ts
await client.healthcheck();
await client.listInvoices({
  businessUnitId: 'bu/one',
  allStatus: 1,
  paymentStatus: 0,
  sortBy: 'invoiceNo',
  orderBy: 'desc',
  page: 2,
  limit: 30,
  fields: ['id', 'client[id,name]']
});
await client.getInvoice('inv/?% ü', ['id', 'status']);
await client.getDefaultRecipients('inv-1');
await client.listInvoiceLineItems('inv-1', { page: 1, limit: 30, fields: ['id', 'description'] });
~~~

Assert Authorization is exactly Bearer fake-v2-token, GET has no content-type, redirect mode is error through the injected fetch assertion, path IDs are encoded as one segment, and list query parameters occur once.

Add write cases:

~~~ts
await client.createInvoice({
  businessUnitId: 'bu-1',
  taskId: 'task-1',
  type: 'FINAL_INVOICE',
  defaultLayout: 'DETAILED',
  taxInclusive: true
});
await client.updateInvoiceLineItem('inv-1', 'line-1', {
  description: 'Service labour',
  quantity: 2,
  sell: 125
});
~~~

Assert POST /v2/invoices sends the documented JSON object and PATCH /v2/invoices/inv-1/lineitems/line-1 sends:

~~~json
{"lineItems":[{"id":"line-1","description":"Service labour","quantity":2,"sell":125}]}
~~~

- [ ] **Step 2: Add failing resilience cases**

Cover:

- GET retries at most three times after 429 and respects Retry-After.
- POST and PATCH make one request after 429 or 500 and return retryable false.
- 204 returns a success value without parsing JSON.
- 400/404/409/422 map to VALIDATION; 401 to AUTHENTICATION; 403 to PERMISSION; 408 to TIMEOUT; 429 to RATE_LIMIT; 5xx to UPSTREAM.
- malformed success JSON returns MALFORMED_RESPONSE.
- declared and streamed bodies over 3,500,000 bytes return RESPONSE_TOO_LARGE.
- an upstream body containing fake-v2-token never appears in the thrown message.
- a stalled request aborts at requestTimeoutMs.
- a concurrent legacy request and v2 request using the same fake budget call the same acquire mock twice.

- [ ] **Step 3: Run the new tests and verify failure**

~~~powershell
pnpm exec vitest run tests/integration/v2-client.test.ts
~~~

Expected: FAIL because src/aroflo-v2/client.ts and contracts.ts do not exist.

- [ ] **Step 4: Implement contracts and safe query encoding**

In src/aroflo-v2/contracts.ts, define the published enums and exact public inputs:

~~~ts
export const INVOICE_TYPES = ['FINAL_INVOICE', 'PART_INVOICE'] as const;
export const INVOICE_LAYOUTS = [
  'SIMPLE',
  'LAB_AND_MAT_ITEMS',
  'DETAILED',
  'LAB_AND_MAT_SIMPLE',
  'ITEMISED',
  'ITEMISED_MAT',
  'ITEMISED_QTY',
  'SIMPLE_IMP',
  'SIMPLE_MAT_AND_EXP'
] as const;

export interface CreateInvoiceInput {
  businessUnitId: string;
  taskId: string;
  type: (typeof INVOICE_TYPES)[number];
  defaultLayout?: (typeof INVOICE_LAYOUTS)[number];
  expenseTrackingCenterId?: string;
  labourTrackingCenterId?: string;
  materialTrackingCenterId?: string;
  overrideQuote?: boolean;
  taxInclusive?: boolean;
}

export interface InvoiceLinePatch {
  accountCode?: string;
  costEx?: number;
  description?: string;
  discount?: number;
  id?: string;
  listOrder?: number;
  markup?: number;
  partNumber?: string;
  quantity?: number;
  sell?: number;
  taxCode?: string;
  totalEx?: number;
  trackingCentre?: string;
}
~~~

Define InvoiceListQuery with businessUnitId required and the documented zoneName, taskId, workOrderId, status, allStatus, clientId, paymentStatus, type, userBuAccessType, sortBy, orderBy, allowSubInv, page, limit, and fields properties. Define InvoiceLineListQuery with page, limit, and fields. Export an encodeV2Query() that appends only known properties to URLSearchParams and joins the validated fields array into _fields.

- [ ] **Step 5: Implement AroFloV2Client**

Use this public shape in src/aroflo-v2/client.ts:

~~~ts
export interface AroFloV2ClientOptions {
  config: AppConfig;
  requestBudget: RequestBudget;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseUrl?: string;
}

export class AroFloV2Client {
  healthcheck(): Promise<unknown>;
  listInvoices(query: InvoiceListQuery): Promise<unknown>;
  getInvoice(invoiceId: string, fields?: readonly string[]): Promise<unknown>;
  getDefaultRecipients(invoiceId: string): Promise<unknown>;
  createInvoice(input: CreateInvoiceInput): Promise<unknown>;
  listInvoiceLineItems(invoiceId: string, query: InvoiceLineListQuery): Promise<unknown>;
  updateInvoiceLineItem(
    invoiceId: string,
    invoiceLineItemId: string,
    fields: InvoiceLinePatch
  ): Promise<unknown>;
}
~~~

Construct paths with encodeURIComponent for each ID. The private request method must use redirect: 'error', AbortController, bounded streaming JSON reads, the shared budget, and the existing ConnectorError codes. Retry only GET for timeout, 429, and 5xx. Build PATCH JSON as one lineItems entry and force its id to equal invoiceLineItemId.

- [ ] **Step 6: Run the new client tests**

~~~powershell
pnpm exec vitest run tests/integration/v2-client.test.ts
~~~

Expected: PASS.

- [ ] **Step 7: Run legacy client regression tests**

~~~powershell
pnpm exec vitest run tests/integration/client.test.ts tests/unit/auth.test.ts tests/unit/rate-limiter.test.ts
~~~

Expected: PASS.

- [ ] **Step 8: Commit**

~~~powershell
git add src/aroflo-v2 tests/integration/v2-client.test.ts tests/integration/fake-aroflo-server.ts
git commit -m "feat: add AroFlo v2 invoice client"
~~~

---

### Task 3: Single-use confirmation store

**Files:**
- Create: src/aroflo-v2/confirmation-store.ts
- Create: tests/unit/v2-confirmation-store.test.ts

**Interfaces:**
- Consumes: CreateInvoiceInput and InvoiceLinePatch
- Produces: V2InvoiceOperation discriminated union
- Produces: V2ConfirmationStore.issue(operation) and consume(confirmationId)

- [ ] **Step 1: Write failing lifecycle and race tests**

Create tests/unit/v2-confirmation-store.test.ts. Use an injected clock and deterministic random ID factory. Cover issue/consume, ten-minute expiry, unknown ID, second consume, concurrent Promise.all consumes, and a maximum of 100 pending confirmations that evicts the oldest.

~~~ts
const store = new V2ConfirmationStore({
  now: () => nowMs,
  createId: () => 'confirmation-1'
});
const issued = store.issue({
  kind: 'createInvoice',
  input: { businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE' }
});
expect(issued).toEqual({
  confirmationId: 'confirmation-1',
  expiresAt: '2026-09-24T00:10:00.000Z'
});
expect(store.consume('confirmation-1')).toMatchObject({ kind: 'createInvoice' });
expect(() => store.consume('confirmation-1')).toThrow(/invalid or expired/i);
~~~

Also prove issue() deep-copies and deep-freezes the stored operation so mutating the caller's input after preview cannot alter the consumed payload.

- [ ] **Step 2: Run the store test and verify failure**

~~~powershell
pnpm exec vitest run tests/unit/v2-confirmation-store.test.ts
~~~

Expected: FAIL because V2ConfirmationStore does not exist.

- [ ] **Step 3: Implement the store**

Use:

~~~ts
export type V2InvoiceOperation =
  | { kind: 'createInvoice'; input: CreateInvoiceInput }
  | {
      kind: 'updateInvoiceLineItem';
      invoiceId: string;
      invoiceLineItemId: string;
      fields: InvoiceLinePatch;
    };

export interface V2ConfirmationStoreOptions {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
  maxPending?: number;
}
~~~

Default createId to randomBytes(24).toString('base64url'), ttlMs to 600000, and maxPending to 100. issue() must structuredClone the operation, recursively freeze it, remove expired entries, and evict the oldest entry before adding beyond the cap. consume() must delete before returning so synchronous and concurrent calls cannot replay it.

- [ ] **Step 4: Run the store tests**

~~~powershell
pnpm exec vitest run tests/unit/v2-confirmation-store.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add src/aroflo-v2/confirmation-store.ts tests/unit/v2-confirmation-store.test.ts
git commit -m "feat: bind v2 writes to single-use confirmations"
~~~

---

### Task 4: Strict v2 schemas and read tools

**Files:**
- Create: src/tools/dependencies.ts
- Create: src/tools/v2-invoice-schemas.ts
- Create: src/tools/v2-invoice-read-tools.ts
- Modify: src/tools/read-tools.ts
- Modify: src/tools/write-tools.ts
- Create: tests/unit/v2-invoice-schemas.test.ts
- Create: tests/unit/v2-invoice-read-tools.test.ts

**Interfaces:**
- Consumes: AppConfig, AroFloClient, optional AroFloV2Client, optional V2ConfirmationStore
- Produces: ToolDependencies
- Produces: five v2 read tool definitions

- [ ] **Step 1: Write failing schema tests**

Pin strict validation for:

~~~ts
expect(invoiceListSchema.safeParse({
  businessUnitId: 'bu-1',
  allStatus: 1,
  page: 1,
  limit: 100
}).success).toBe(true);

expect(invoiceListSchema.safeParse({ businessUnitId: 'bu-1' }).success).toBe(false);
expect(invoiceListSchema.safeParse({
  businessUnitId: 'bu-1',
  status: 1,
  taskId: 'task-1',
  workOrderId: 'wo-1'
}).success).toBe(false);
expect(invoiceListSchema.safeParse({
  businessUnitId: 'bu-1',
  allStatus: 1,
  unexpected: true
}).success).toBe(false);
~~~

Test status 0 through 3, allStatus 0 or 1, paymentStatus 0 through 2, type task, the three access types, four sort fields, asc/desc, allowSubInv 0 or 1, page 1 through 10, limit 1 through 100, IDs of 1 through 256 trimmed characters, and fields projections matching bounded names/bracket notation without &, =, ?, #, whitespace, or more than 50 entries.

- [ ] **Step 2: Write failing read-tool tests**

Construct dependencies with a fake v2 client and assert these definitions and calls:

~~~ts
[
  'aroflo_v2_connection_status',
  'aroflo_v2_list_invoices',
  'aroflo_v2_get_invoice',
  'aroflo_v2_get_invoice_default_recipients',
  'aroflo_v2_list_invoice_line_items'
]
~~~

Assert no v2 read definitions when v2Client is absent, strict invalid inputs produce INVALID_INPUT without a client call, annotations are read-only/non-destructive/idempotent, and a fake response containing fake-v2-token is redacted.

- [ ] **Step 3: Run the focused tests and verify failure**

~~~powershell
pnpm exec vitest run tests/unit/v2-invoice-schemas.test.ts tests/unit/v2-invoice-read-tools.test.ts
~~~

Expected: FAIL because the new schema, dependency, and tool files do not exist.

- [ ] **Step 4: Implement ToolDependencies and migrate imports**

Create src/tools/dependencies.ts:

~~~ts
export interface ToolDependencies {
  config: AppConfig;
  client: AroFloClient;
  v2Client?: AroFloV2Client;
  v2Confirmations?: V2ConfirmationStore;
}
~~~

Update legacy read-tools.ts, write-tools.ts, build-server.ts, sdk-adapter.ts, and stdio.ts to import this type without changing their runtime behaviour. Extend their sensitive-value helpers with config.v2ApiToken when present.

- [ ] **Step 5: Implement strict schemas**

Create the exported Zod schemas:

~~~ts
export const v2ConnectionStatusSchema = z.strictObject({});
export const invoiceListSchema = z.strictObject({
  zoneName: z.enum(['TASKS', 'QUOTES', 'WORK_ORDERS']).optional(),
  businessUnitId: boundedId,
  taskId: boundedId.optional(),
  workOrderId: boundedId.optional(),
  status: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  allStatus: z.union([z.literal(0), z.literal(1)]).optional(),
  clientId: boundedId.optional(),
  paymentStatus: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  type: z.literal('task').optional(),
  userBuAccessType: z.enum(['childbus', 'thisbu', 'allbus']).optional(),
  sortBy: z.enum(['invoiceNo', 'invoicedDate', 'dueDate', 'clientName']).optional(),
  orderBy: z.enum(['asc', 'desc']).optional(),
  allowSubInv: z.union([z.literal(0), z.literal(1)]).optional(),
  page: z.number().int().min(1).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  fields: projection.optional()
})
  .superRefine(validateInvoiceListCombination);
export const invoiceGetSchema = z.strictObject({ invoiceId: boundedId, fields: projection.optional() });
export const invoiceRecipientsSchema = z.strictObject({ invoiceId: boundedId });
export const invoiceLineListSchema = z.strictObject({
  invoiceId: boundedId,
  page: z.number().int().min(1).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  fields: projection.optional()
});
~~~

No record catch-all is allowed. validateInvoiceListCombination must require status unless allStatus equals 1 and reject simultaneous taskId/workOrderId.

- [ ] **Step 6: Implement read definitions**

Each definition must parse with its schema, call exactly one matching AroFloV2Client method, and return asToolResult using all configured sensitive values. connection status returns:

~~~ts
{
  success: true,
  apiVersion: 'v2',
  checkedAt: new Date().toISOString()
}
~~~

List tools return the upstream count/items/page envelope without inventing fields; get and recipient tools return their upstream objects; line listing returns its upstream pagination envelope.

- [ ] **Step 7: Run focused and legacy tool tests**

~~~powershell
pnpm exec vitest run tests/unit/v2-invoice-schemas.test.ts tests/unit/v2-invoice-read-tools.test.ts tests/unit/read-tools.test.ts tests/unit/write-tools.test.ts
~~~

Expected: PASS.

- [ ] **Step 8: Commit**

~~~powershell
git add src/tools tests/unit/v2-invoice-schemas.test.ts tests/unit/v2-invoice-read-tools.test.ts tests/unit/read-tools.test.ts tests/unit/write-tools.test.ts
git commit -m "feat: add AroFlo v2 invoice read tools"
~~~

---

### Task 5: Preview-bound v2 invoice write tools

**Files:**
- Modify: src/tools/v2-invoice-schemas.ts
- Create: src/tools/v2-invoice-write-tools.ts
- Create: tests/unit/v2-invoice-write-tools.test.ts

**Interfaces:**
- Consumes: AroFloV2Client, V2ConfirmationStore, canWriteArea(config, 'invoices')
- Produces: preview-create, create, preview-line-update, and line-update definitions
- Produces: execution schemas accepting only confirmationId

- [ ] **Step 1: Write failing create preview and execution tests**

Assert preview accepts only the documented create fields and explicit type, returns a human-readable normalised preview plus confirmationId/expiresAt, and makes no network call. Assert omitted layout is displayed as AroFlo default DETAILED but remains absent from the stored outbound input.

~~~ts
const preview = await byName(definitions, 'aroflo_v2_preview_create_invoice').execute({
  businessUnitId: 'bu-1',
  taskId: 'task-1',
  type: 'FINAL_INVOICE',
  taxInclusive: true
});
expect(preview.structuredContent).toMatchObject({
  operation: 'createInvoice',
  preview: {
    businessUnitId: 'bu-1',
    taskId: 'task-1',
    type: 'FINAL_INVOICE',
    effectiveLayout: 'DETAILED',
    taxInclusive: true
  }
});
~~~

Consume the returned confirmation through a write-enabled execution definition and assert createInvoice receives the stored payload once. Invalid, expired, or reused IDs must return VALIDATION without a client call.

- [ ] **Step 2: Write failing line preview and execution tests**

Fake listInvoiceLineItems as:

~~~ts
{
  count: 1,
  items: [{
    id: 'line-1',
    description: 'Old description',
    quantity: 1,
    sell: 100
  }],
  page: { current: 1, total: 1 }
}
~~~

Preview an update to description and quantity. Assert it fetches current lines, rejects a missing target, rejects body id not matching the path ID, reports before/after only for changed fields, and stores exactly one update operation. Execute by confirmationId and assert one updateInvoiceLineItem call.

Add a two-page fixture where the target is on page 2. The preview must follow the documented page metadata, stop immediately after finding the target, and never request more than ten pages or 100 lines per page.

- [ ] **Step 3: Write failing gate and non-retry tests**

Cover all discovery rows:

~~~ts
[
  { writeEnabled: false, invoicesAllowed: true, financial: true, executionTools: [] },
  { writeEnabled: true, invoicesAllowed: false, financial: true, executionTools: [] },
  { writeEnabled: true, invoicesAllowed: true, financial: false, executionTools: [] },
  { writeEnabled: true, invoicesAllowed: true, financial: true,
    executionTools: ['aroflo_v2_create_invoice', 'aroflo_v2_update_invoice_line_item'] }
]
~~~

Preview tools remain discoverable when the v2 client/store exist, but execution tools appear only in the final row. Recheck canWriteArea immediately before consuming a confirmation. Simulate an upstream failure and assert the confirmation cannot be replayed.

- [ ] **Step 4: Run the new tests and verify failure**

~~~powershell
pnpm exec vitest run tests/unit/v2-invoice-write-tools.test.ts
~~~

Expected: FAIL because v2-invoice-write-tools.ts does not exist.

- [ ] **Step 5: Implement write schemas**

Add:

~~~ts
export const createInvoiceSchema = z.strictObject({
  businessUnitId: boundedId,
  taskId: boundedId,
  type: z.enum(INVOICE_TYPES),
  defaultLayout: z.enum(INVOICE_LAYOUTS).optional(),
  expenseTrackingCenterId: boundedId.optional(),
  labourTrackingCenterId: boundedId.optional(),
  materialTrackingCenterId: boundedId.optional(),
  overrideQuote: z.boolean().optional(),
  taxInclusive: z.boolean().optional()
});

export const invoiceLinePatchSchema = z.strictObject({
  accountCode: boundedShortText.optional(),
  costEx: finiteNumber.optional(),
  description: z.string().max(10000).optional(),
  discount: finiteNumber.optional(),
  id: boundedId.optional(),
  listOrder: z.number().int().min(0).optional(),
  markup: finiteNumber.optional(),
  partNumber: boundedShortText.optional(),
  quantity: finiteNumber.optional(),
  sell: finiteNumber.optional(),
  taxCode: boundedShortText.optional(),
  totalEx: finiteNumber.optional(),
  trackingCentre: boundedShortText.optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one line field is required');

export const executeV2WriteSchema = z.strictObject({
  confirmationId: z.string().min(20).max(200)
});
~~~

Define preview update input as invoiceId, invoiceLineItemId, and fields. Its refinement requires fields.id, when supplied, to equal invoiceLineItemId.

- [ ] **Step 6: Implement preview and execution definitions**

Export:

~~~ts
export const V2_PREVIEW_TOOL_NAMES = [
  'aroflo_v2_preview_create_invoice',
  'aroflo_v2_preview_update_invoice_line_item'
] as const;

export const V2_WRITE_TOOL_NAMES = [
  'aroflo_v2_create_invoice',
  'aroflo_v2_update_invoice_line_item'
] as const;
~~~

Preview tools issue operations through V2ConfirmationStore. Execution tools call consume() before the network request, dispatch only the stored discriminated union, and return a minimal receipt with operation, invoiceId or created upstream id when present, and success true. Do not return raw upstream bodies.

- [ ] **Step 7: Run focused write tests**

~~~powershell
pnpm exec vitest run tests/unit/v2-invoice-write-tools.test.ts tests/unit/v2-confirmation-store.test.ts
~~~

Expected: PASS.

- [ ] **Step 8: Commit**

~~~powershell
git add src/tools/v2-invoice-schemas.ts src/tools/v2-invoice-write-tools.ts tests/unit/v2-invoice-write-tools.test.ts
git commit -m "feat: add confirmed AroFlo v2 invoice writes"
~~~

---

### Task 6: MCP registration and production dependency assembly

**Files:**
- Create: src/mcp/dependencies.ts
- Modify: src/mcp/sdk-adapter.ts
- Modify: src/mcp/build-server.ts
- Modify: src/transports/stdio.ts
- Modify: src/transports/http.ts
- Modify: tests/integration/mcp-write-gates.test.ts
- Create: tests/integration/mcp-v2-invoice-tools.test.ts

**Interfaces:**
- Consumes: AppConfig, RateLimiter, AroFloClient, AroFloV2Client, V2ConfirmationStore
- Produces: createToolDependencies(config): ToolDependencies
- Produces: MCP discovery for legacy plus optional v2 tools

- [ ] **Step 1: Write failing MCP discovery tests**

Using InMemoryTransport, assert:

- no token: only the exact legacy tool set appears;
- token plus writes off: five v2 reads and two v2 previews appear, but no v2 execution tools;
- token plus all invoice write gates: all nine v2 tools appear;
- no delete, archive, send, approve, payment, add-line, remove-line, raw URL, raw query, or raw JSON tool appears;
- all input schemas have additionalProperties false;
- annotations match read, preview, and write policy.

Call each v2 read against the fake service and exercise a preview/confirm create plus preview/confirm line update. Assert the HTTP methods and paths are exactly GET, POST, and PATCH with no duplicate write.

- [ ] **Step 2: Write failing dependency and transport tests**

Assert createToolDependencies() creates one RateLimiter instance and passes that same RequestBudget object to both clients. Assert it omits v2Client/v2Confirmations when no token exists.

Extend stdio and HTTP tests so a fake-v2-token embedded in a thrown startup or transport error is redacted. Assert existing MCP_ACCESS_TOKEN constant-time authentication is unchanged.

- [ ] **Step 3: Run the integration tests and verify failure**

~~~powershell
pnpm exec vitest run tests/integration/mcp-v2-invoice-tools.test.ts tests/integration/mcp-write-gates.test.ts tests/integration/stdio.test.ts tests/integration/http.test.ts
~~~

Expected: FAIL because the server does not register or assemble v2 dependencies.

- [ ] **Step 4: Implement the shared dependency factory**

Create src/mcp/dependencies.ts:

~~~ts
export function createToolDependencies(config: AppConfig): ToolDependencies {
  const requestBudget = new RateLimiter();
  const client = new AroFloClient({ config, requestBudget });
  if (config.v2ApiToken === undefined) return { config, client };
  return {
    config,
    client,
    v2Client: new AroFloV2Client({ config, requestBudget }),
    v2Confirmations: new V2ConfirmationStore()
  };
}
~~~

Allow an internal test-only options argument for injected fetch, clock, sleep, base URLs, and requestBudget; do not expose any environment-controlled base URL.

- [ ] **Step 5: Register v2 tools**

In sdk-adapter.ts, add registerV2InvoiceReadTools() and registerV2InvoiceWriteTools() using registerConnectorTool(). In build-server.ts, call legacy read, legacy write, v2 read, then v2 preview/write registration in that order. Update server instructions to name the exact preview/confirmation rule and unsupported invoice operations.

Replace direct client construction in stdio.ts and http.ts with createToolDependencies(config). Add AROFLO_V2_API_TOKEN to their secret environment key arrays and config-sensitive values.

- [ ] **Step 6: Run integration and full legacy discovery tests**

~~~powershell
pnpm exec vitest run tests/integration/mcp-v2-invoice-tools.test.ts tests/integration/mcp-read-tools.test.ts tests/integration/mcp-write-gates.test.ts tests/integration/stdio.test.ts tests/integration/http.test.ts
~~~

Expected: PASS.

- [ ] **Step 7: Commit**

~~~powershell
git add src/mcp src/transports src/tools/dependencies.ts tests/integration
git commit -m "feat: register AroFlo v2 invoice MCP tools"
~~~

---

### Task 7: Operator instructions, exports, and read-only smoke command

**Files:**
- Create: scripts/v2-read-only-smoke-test.ts
- Create: tests/unit/v2-read-only-smoke-test.test.ts
- Modify: skills/aroflo-operator/SKILL.md
- Modify: src/index.ts
- Modify: .env.example
- Modify: README.md
- Modify: DEPLOYMENT.md
- Modify: package.json
- Modify: .codex-plugin/plugin.json
- Modify: tests/unit/operator-docs.test.ts
- Modify: tests/unit/scaffold.test.ts
- Modify: tests/unit/secret-scan.test.ts

**Interfaces:**
- Consumes: AROFLO_V2_API_TOKEN and optional AROFLO_V2_SMOKE_BUSINESS_UNIT_ID
- Produces: pnpm smoke:v2-read-only
- Produces: public exports for AroFloV2Client and v2 contract types

- [ ] **Step 1: Write failing documentation and scaffold tests**

Assert .env.example contains only empty or safe defaults:

~~~ts
expect(sample).toContain('AROFLO_V2_API_TOKEN=');
expect(sample).toContain('AROFLO_V2_SMOKE_BUSINESS_UNIT_ID=');
expect(sample).not.toMatch(/AROFLO_V2_API_TOKEN=\S+/);
~~~

Assert the operator skill names all five read tools, both preview tools, and both execution tools; requires exact preview confirmation; and explicitly refuses delete/send/approve/payment/add-line/remove-line. Assert README documents API v2 open-beta status, environment variables, supported boundary, and both write gates.

Assert src/index.ts exports AroFloV2Client, V2ConfirmationStore, INVOICE_TYPES, and INVOICE_LAYOUTS without starting a server.

Assert package.json and .codex-plugin/plugin.json both report version 0.2.0.

- [ ] **Step 2: Write failing smoke-script tests**

Mock fetch and import the script's exported runV2ReadOnlySmoke(). Assert:

- token missing produces a safe configuration error;
- no business-unit ID runs only GET /v2/healthcheck;
- a business-unit ID runs healthcheck then GET /v2/invoices with allStatus=1, page=1, limit=1;
- when the first list item has an id, it performs GET detail, GET defaultrecipients, and GET lineitems;
- every request method is GET;
- output contains only operation names/counts and never the token or full invoice/customer body.

- [ ] **Step 3: Run focused tests and verify failure**

~~~powershell
pnpm exec vitest run tests/unit/operator-docs.test.ts tests/unit/scaffold.test.ts tests/unit/v2-read-only-smoke-test.test.ts tests/unit/secret-scan.test.ts
~~~

Expected: FAIL because documentation, exports, and the smoke script are not updated.

- [ ] **Step 4: Implement the read-only smoke script**

Export:

~~~ts
export interface V2SmokeSummary {
  healthcheck: 'ok';
  invoiceList?: 'ok';
  invoiceDetail?: 'ok' | 'skipped-empty-list';
  defaultRecipients?: 'ok' | 'skipped-empty-list';
  lineItems?: 'ok' | 'skipped-empty-list';
}

export async function runV2ReadOnlySmoke(
  env: NodeJS.ProcessEnv,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<V2SmokeSummary>;
~~~

Load normal config, create a v2 client with a RateLimiter, call only the GET methods described in Step 2, and print JSON.stringify(summary) only when invoked as the entrypoint. Add:

~~~json
"smoke:v2-read-only": "tsc -p tsconfig.json && node dist/scripts/v2-read-only-smoke-test.js"
~~~

- [ ] **Step 5: Update operator and deployment documentation**

Add an Invoice API v2 section to the skill's decision order:

1. select an aroflo_v2 read tool for v2 invoice reads;
2. call the matching preview tool for create/update;
3. show its exact preview and ask for explicit confirmation;
4. pass only confirmationId to exactly one execution tool;
5. refuse undocumented invoice mutations.

Add a documentation test that rejects the misspelling arfoflo_v2.

Document that AROFLO_V2_SMOKE_BUSINESS_UNIT_ID is optional: without it the live check stops after healthcheck; with it the script lists one invoice and, when present, reads that invoice's details, recipients, and lines.

- [ ] **Step 6: Run focused tests**

~~~powershell
pnpm exec vitest run tests/unit/operator-docs.test.ts tests/unit/scaffold.test.ts tests/unit/v2-read-only-smoke-test.test.ts tests/unit/secret-scan.test.ts
~~~

Expected: PASS.

- [ ] **Step 7: Commit**

~~~powershell
git add scripts/v2-read-only-smoke-test.ts tests/unit/v2-read-only-smoke-test.test.ts skills/aroflo-operator/SKILL.md src/index.ts .env.example README.md DEPLOYMENT.md package.json .codex-plugin/plugin.json tests/unit/operator-docs.test.ts tests/unit/scaffold.test.ts tests/unit/secret-scan.test.ts
git commit -m "docs: add safe AroFlo v2 invoice operation flow"
~~~

---

### Task 8: Full verification, local installation, and live read-only validation

**Files:**
- Verify: entire repository
- Deploy from: C:/Users/repai/Documents/Codex/2026-09-10/hi/work/aroflo-connector
- Preserve current local package: C:/Users/repai/plugins/aroflo-connector
- Install through: personal AroFlo Connector plugin entry

**Interfaces:**
- Consumes: completed Tasks 1 through 7 and Windows user environment variables
- Produces: tested local plugin with legacy plus v2 invoice tools

- [ ] **Step 1: Run the full automated verification suite**

~~~powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run scan:secrets
git diff --check
~~~

Expected: every command exits 0 and the secret scan reports PASS.

- [ ] **Step 2: Inspect the built plugin without exposing credentials**

~~~powershell
rg --pcre2 -n --hidden --glob '!node_modules/**' --glob '!dist/**/*.map' 'AROFLO_V2_API_TOKEN\s*=\s*\S+|Authorization:\s*Bearer\s+(?!<token>)' .
~~~

Expected: no populated credential assignment or real bearer value. Environment-variable names, redaction patterns, and the documented sentinel Bearer <token> are acceptable.

- [ ] **Step 3: Preserve the current installed package**

Create a timestamped, non-destructive backup before changing the active local package:

~~~powershell
$installed = 'C:\Users\repai\plugins\aroflo-connector'
$backup = 'C:\Users\repai\plugins\aroflo-connector-backup-20260924'
if (-not (Test-Path -LiteralPath $backup)) {
  Copy-Item -LiteralPath $installed -Destination $backup -Recurse
}
~~~

Verify the backup has .codex-plugin/plugin.json, .mcp.json, scripts/start-local.ps1, and dist/src/transports/stdio.js. If any are absent, stop before deployment and restore nothing because the active package has not yet changed.

- [ ] **Step 4: Stage a clean deployment directory**

Build a separate staging folder and copy only the distributable files:

~~~powershell
$source = 'C:\Users\repai\Documents\Codex\2026-09-10\hi\work\aroflo-connector'
$staging = 'C:\Users\repai\Documents\Codex\2026-09-10\hi\work\aroflo-connector-release'
if (Test-Path -LiteralPath $staging) {
  throw 'Release staging directory already exists; inspect it before continuing.'
}
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -LiteralPath (Join-Path $source '.codex-plugin') -Destination $staging -Recurse
Copy-Item -LiteralPath (Join-Path $source '.mcp.json') -Destination $staging
Copy-Item -LiteralPath (Join-Path $source 'dist') -Destination $staging -Recurse
Copy-Item -LiteralPath (Join-Path $source 'scripts') -Destination $staging -Recurse
Copy-Item -LiteralPath (Join-Path $source 'skills') -Destination $staging -Recurse
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $staging
Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination $staging
Copy-Item -LiteralPath (Join-Path $source 'DEPLOYMENT.md') -Destination $staging
~~~

Run pnpm scan:secrets -- C:\Users\repai\Documents\Codex\2026-09-10\hi\work\aroflo-connector-release and require PASS before installation.

- [ ] **Step 5: Update the personal plugin from the staged folder**

Use the plugin-management workflow to replace the personal AroFlo Connector from the exact staging path. Keep the backup from Step 3 until the v2 read-only smoke test and legacy connection test both pass. Reload Codex so tool discovery refreshes.

- [ ] **Step 6: Verify MCP discovery from the installed package**

List tools through the installed local MCP server. Require all legacy tools plus:

~~~text
aroflo_v2_connection_status
aroflo_v2_list_invoices
aroflo_v2_get_invoice
aroflo_v2_get_invoice_default_recipients
aroflo_v2_list_invoice_line_items
aroflo_v2_preview_create_invoice
aroflo_v2_create_invoice
aroflo_v2_preview_update_invoice_line_item
aroflo_v2_update_invoice_line_item
~~~

If an execution tool is absent, report which of the three write gates is off; do not bypass it.

- [ ] **Step 7: Run live read-only checks**

~~~powershell
pnpm run smoke:read-only
pnpm run smoke:v2-read-only
~~~

Expected: legacy smoke passes; v2 healthcheck passes. If AROFLO_V2_SMOKE_BUSINESS_UNIT_ID exists, invoice list/detail/recipient/line reads pass. If it is absent, the v2 summary explicitly shows that only healthcheck ran; obtain the business-unit ID before claiming all live reads passed.

- [ ] **Step 8: Prove no live write occurred**

Review the smoke summary and fake-service request assertions. Every live v2 request must be GET. Do not call either execution tool. Record that live creation and line update remain awaiting a separately displayed preview and explicit user approval.

- [ ] **Step 9: Final branch verification and commit any rollout-only documentation adjustment**

~~~powershell
git status --short
git log --oneline --decorate -10
~~~

Expected: working tree clean. If execution revealed a documentation-only correction, add its exact file, rerun the full verification suite, and commit it with:

~~~powershell
git commit -m "docs: clarify local AroFlo v2 rollout"
~~~

Do not modify or commit files under .worktrees/public-cloud.
