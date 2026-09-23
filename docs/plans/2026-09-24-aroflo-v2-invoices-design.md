# AroFlo API v2 invoice support design

**Status:** Approved on 2026-09-24

**Scope:** Local `aroflo-connector` plugin only

**Publisher:** Swan Hill Appliance Repairs Pty Ltd

## Goal

Add all invoice operations currently documented by AroFlo API v2 without replacing or changing the connector's working legacy HMAC API. The local plugin must remain useful for existing AroFlo areas while gaining bearer-token invoice reads and guarded financial writes.

The v2 integration uses `AROFLO_V2_API_TOKEN` from the process environment. Credentials must never be stored in the repository, plugin package, test fixtures, tool output, or logs.

## Supported boundary

The connector will expose the following documented API v2 operations:

| Capability | Method and path | Connector behaviour |
| --- | --- | --- |
| Connection check | `GET /healthcheck` | Read-only credential and availability check |
| List invoices | `GET /invoices` | Bounded documented filtering and pagination only |
| Retrieve invoice | `GET /invoices/:invoiceId` | Read one invoice by its encoded ID |
| Resolve default recipients | `GET /invoices/:invoiceId/defaultrecipients` | Read resolved `to`, `cc`, and `bcc` defaults |
| Create invoice | `POST /invoices` | Create a `PART_INVOICE` or `FINAL_INVOICE` after preview and confirmation |
| List invoice lines | `GET /invoices/:invoiceId/lineitems` | Bounded documented pagination only |
| Update an invoice line | `PATCH /invoices/:invoiceId/lineitems/:invoiceLineItemId` | Partially update one existing line after preview and confirmation |

The API reference currently has no documented operation for adding or deleting an individual invoice line. It also does not document invoice deletion, sending, approval, or payment mutation in the invoice endpoints. These actions are out of scope and must be rejected rather than approximated with guessed endpoints or browser automation.

Primary references:

- [AroFlo API v2 getting started](https://docs.api.aroflo.com/guides/getting-started/)
- [Create new invoice](https://docs.api.aroflo.com/api/invoices-create/)
- [Resolve default invoice recipients](https://docs.api.aroflo.com/api/invoices-get-default-recipient-by-invoice-id/)
- [List invoice line items](https://docs.api.aroflo.com/api/invoices-list-line-items/)
- [Update invoice line item](https://docs.api.aroflo.com/api/invoices-update-line-items-invoice-by-line-item-id/)

Because API v2 is in open beta, the implemented contract will be isolated and covered by schema and transport tests so future upstream changes can be adopted without disturbing the legacy client.

## Architecture

### Separate clients, shared connector

The existing `AroFloClient` remains the legacy HMAC client. A new `AroFloV2Client` owns v2 JSON transport, bearer authentication, response parsing, and v2 error mapping. The production v2 base URL is fixed to `https://api.aroflo.com/v2`; a base URL override exists only as an injected test option.

The MCP server receives both clients. Existing legacy tools keep their names and behaviour. V2 tools use an `aroflo_v2_` prefix so their authentication model and contract are unambiguous.

When `AROFLO_V2_API_TOKEN` is absent, v2 tools are not registered. Legacy startup and tools continue to work. When the token is present, the complete v2 read set is registered; write execution tools additionally depend on the existing write gates.

Both clients share one conservative request-budget coordinator so concurrent legacy and v2 use cannot silently double the connector's outbound AroFlo request rate. Read requests may retry bounded transient failures. Financial writes are never automatically retried because their upstream completion state can be ambiguous.

### Configuration

`AppConfig` gains an optional, trimmed, non-blank `v2ApiToken`. Existing legacy credentials and configuration remain unchanged. The v2 token is added to every sensitive-value collection used for result and error redaction.

The following existing gates are both required for v2 invoice writes:

- `AROFLO_WRITE_ENABLED=true`
- `AROFLO_FINANCIAL_WRITES_ENABLED=true`

The `invoices` entry must also remain present in `AROFLO_WRITABLE_AREAS`. A missing gate prevents registration or execution of the affected write tools; it never triggers a fallback to legacy writes.

## MCP tools

### Read tools

- `aroflo_v2_connection_status`
- `aroflo_v2_list_invoices`
- `aroflo_v2_get_invoice`
- `aroflo_v2_get_invoice_default_recipients`
- `aroflo_v2_list_invoice_line_items`

Inputs use strict schemas with bounded encoded IDs, page sizes, and only query parameters explicitly documented by AroFlo. There is no raw URL, arbitrary query-string, header, or JSON escape hatch. Outputs pass through the connector's size limits and secret redaction.

### Create invoice tools

- `aroflo_v2_preview_create_invoice`
- `aroflo_v2_create_invoice`

Creation requires `businessUnitId`, `taskId`, and an explicit `type` of `PART_INVOICE` or `FINAL_INVOICE`. It may accept only the documented optional fields: `defaultLayout`, `expenseTrackingCenterId`, `labourTrackingCenterId`, `materialTrackingCenterId`, `overrideQuote`, and `taxInclusive`. Layout values are restricted to the published enum. If layout is omitted, the preview identifies AroFlo's current documented default (`DETAILED`) without adding an unrequested field to the outbound body.

### Update invoice-line tools

- `aroflo_v2_preview_update_invoice_line_item`
- `aroflo_v2_update_invoice_line_item`

The preview flow first retrieves the current line collection, verifies that the target line belongs to the specified invoice, and displays the precise before/after values. Only fields documented as part of the v2 line-item update body are accepted. The request represents exactly one path-selected line item; any body identifier must match the path identifier.

The connector does not expose add-line or delete-line tools while AroFlo has no published endpoints for those operations.

## Confirmation binding

V2 financial writes use a server-enforced two-stage flow rather than relying only on conversational instructions.

1. A preview tool validates and normalises the proposed payload without writing.
2. The server stores the exact canonical operation and payload in memory under a cryptographically random, opaque confirmation ID.
3. The preview result displays human-readable changes and a short expiry time.
4. After the user explicitly confirms that exact preview, the execution tool accepts only the confirmation ID.
5. The server consumes the stored payload once. Confirmation IDs are single-use, expire after ten minutes, and are invalidated by process restart.

The write tool cannot substitute new fields at execution time. Any changed proposal requires a new preview and confirmation. Failed upstream writes also consume the confirmation ID so an ambiguous result cannot be replayed accidentally.

## Transport and error handling

The v2 client sends `Authorization: Bearer <token>` and `Accept: application/json`, adding `Content-Type: application/json` only when a body is present. It uses the configured request timeout, bounded response reading, and redirect refusal. It does not place credentials or request bodies in errors.

HTTP errors map into the connector's existing error categories:

- `401` -> authentication
- `403` -> permission
- `404` -> validation/not found with a safe message
- `408` -> timeout
- `409` and `422` -> validation/conflict with a safe message
- `429` -> rate limit
- `5xx` -> upstream failure

Only read requests may use bounded retry behaviour for timeouts, rate limits, and upstream failures. Returned error details are length-bounded and scrubbed for bearer headers, tokens, IDs explicitly marked sensitive by the connector, and raw response bodies.

## Operator experience

The `aroflo-operator` skill will describe the v2 tool selection and preserve its current safety order:

1. Reads can run directly.
2. Creates and updates must be previewed.
3. The exact preview must be shown to the user.
4. One execution call may follow only after explicit confirmation.
5. Unsupported delete, archive, send, approve, payment, and add/remove-line requests are refused without a workaround.

The skill will clearly explain that invoice creation and editing existing lines are supported, while adding or removing individual invoice lines is not currently exposed by AroFlo API v2.

## Testing and rollout

Automated coverage will include:

- optional-token configuration and missing-token legacy compatibility;
- bearer headers and token redaction;
- fixed production origin and test-only base URL injection;
- strict schemas for IDs, pagination, invoice type, layouts, and update fields;
- every documented endpoint mapping;
- response size limits, malformed JSON, timeouts, status mapping, and read-only retries;
- all three financial-write gates;
- exact-payload confirmation binding, expiry, single use, changed-payload rejection, and restart invalidation;
- no automatic retry for `POST` or `PATCH`;
- MCP registration with and without the v2 token and write gates;
- operator documentation and secret scanning.

The fake AroFlo integration service will cover all v2 read and write behaviours. Live verification is read-only at first: health check, invoice listing, invoice retrieval, recipient resolution, and line-item listing. No real invoice will be created or changed unless the connector presents the exact live preview and the user gives a separate confirmation.

After automated and live read-only checks pass, the local plugin cache will be updated from this branch and Codex will be restarted or reloaded so MCP discovery reflects the new tools. The paused `codex/public-cloud-design` worktree is outside this change and must not be modified.

## Acceptance criteria

- All existing legacy tests and tools remain unchanged in behaviour.
- A valid `AROFLO_V2_API_TOKEN` enables the documented v2 read tools.
- V2 invoice creation and existing-line updates require all write gates plus a fresh, single-use confirmed preview.
- The connector never stores or returns the v2 token.
- Unsupported invoice operations are absent and explicitly documented.
- Automated tests, type checking, build, and secret scanning pass.
- Live validation performs reads only until a separately approved real write test.
