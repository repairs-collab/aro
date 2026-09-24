# AroFlo Connector

This plugin gives Codex and compatible ChatGPT clients structured AroFlo access over MCP. It supports local Windows stdio and provider-neutral hosted HTTP from the same codebase. Reads are always available; create and update tools are built in but absent unless their safety gates are enabled.

Invoice API v2 support targets AroFlo's open beta API and may need adjustment as that upstream contract evolves. Use the exact `aroflo_v2` tool prefix. Never use `arfoflo_v2`; it is a typo.

> **Credential safety:** AroFlo credentials were shared during initial setup. Rotate them after the first private connection check and before any public hosting. Never place credentials in this repository, MCP configuration, logs, images, or archives.

## Prerequisites

- Node.js 20 or newer and pnpm
- PowerShell for the local Windows launcher
- Four established AroFlo HMAC API credentials and an API user with suitable read permissions
- Docker or another OCI-compatible builder for hosted deployment

## Configuration

Set secrets in the environment or a deployment provider's secret store. `.mcp.json` contains no credentials. The local launcher inherits environment variables from the process that starts Codex; after setting or rotating them, fully restart Codex so the MCP child process receives the new values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `AROFLO_UENCODED` | Yes | Issued encoded API user value |
| `AROFLO_PENCODED` | Yes | Issued encoded API key value |
| `AROFLO_ORG_ENCODED` | Yes | Issued encoded organization value |
| `AROFLO_SECRET_KEY` | Yes | Issued API signing secret |
| `AROFLO_HOST_IP` | No | Optional fixed source IP included in signing; leave unset unless AroFlo requires it |
| `AROFLO_V2_API_TOKEN` | For API v2 | Bearer token for the Invoice API v2 tools and smoke check |
| `AROFLO_V2_SMOKE_BUSINESS_UNIT_ID` | No | Optional business unit for the bounded v2 invoice smoke reads |
| `AROFLO_WRITE_ENABLED` | No | Exact `true` enables the ordinary write gate; default `false` |
| `AROFLO_WRITABLE_AREAS` | No | Comma-separated allowlist of writable areas; default empty |
| `AROFLO_FINANCIAL_WRITES_ENABLED` | No | Exact `true` adds the invoice gate; default `false` |
| `MCP_TRANSPORT` | No | `stdio` locally or `http` when hosted |
| `MCP_ACCESS_TOKEN` | Hosted | Strong bearer token for `/mcp` |
| `MCP_BIND_HOST` | Hosted | Listener host; default `127.0.0.1` |
| `MCP_ALLOWED_HOSTS` | Public host | Comma-separated request Host allowlist |
| `PORT` | Hosted | Listener port; default `3000` |
| `AROFLO_REQUEST_TIMEOUT_MS` | No | Upstream timeout below 60 seconds; default `30000` |

Keep both write flags exactly `false` for setup and acceptance.

## Local build and launch

From the plugin directory:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm scan:secrets
```

Codex launches the connector through `.mcp.json` and `scripts/start-local.ps1`. The launcher resolves Node from `AROFLO_NODE_PATH`, then the command path, then the bundled Codex runtime. For direct diagnostics, run `pnpm start:stdio` from an environment containing the required variables. Do not type credentials into command arguments.

The secret scanner reads UTF-8 plus BOM-marked UTF-16LE/BE text. It fails closed on missing paths, unsupported text, archives, and files larger than 2 MiB; findings contain filenames and categories only. Extract delivery archives first and pass each extracted tree as an additional scan path.

## Tool catalog

| Tool | Availability |
| --- | --- |
| `aroflo_connection_status` | Always; minimal read |
| `aroflo_describe_area` | Always; local contract description |
| `aroflo_search_records` | Always; bounded structured search |
| `aroflo_get_record` | Always; one record by identifier |
| `aroflo_list_changes` | Always; bounded change feed |
| `aroflo_preview_change` | Always; local validation only |
| `aroflo_create_record` | Appears jointly with update when any allowed write operation is enabled |
| `aroflo_update_record` | Appears jointly with create when any allowed write operation is enabled |
| `aroflo_v2_connection_status` | With `AROFLO_V2_API_TOKEN`; v2 healthcheck |
| `aroflo_v2_list_invoices` | With `AROFLO_V2_API_TOKEN`; bounded invoice list |
| `aroflo_v2_get_invoice` | With `AROFLO_V2_API_TOKEN`; one invoice |
| `aroflo_v2_get_invoice_default_recipients` | With `AROFLO_V2_API_TOKEN`; default recipients |
| `aroflo_v2_list_invoice_line_items` | With `AROFLO_V2_API_TOKEN`; bounded line list |
| `aroflo_v2_preview_create_invoice` | With `AROFLO_V2_API_TOKEN`; preview only, never writes |
| `aroflo_v2_preview_update_invoice_line_item` | With `AROFLO_V2_API_TOKEN`; preview only, never writes |
| `aroflo_v2_create_invoice` | Only when all invoice write gates pass; consumes one exact confirmation |
| `aroflo_v2_update_invoice_line_item` | Only when all invoice write gates pass; consumes one exact confirmation |

There is no delete or archive capability. Raw query strings and raw XML are never accepted from callers.

The supported API v2 mutation boundary is deliberately narrow: create one invoice or update one existing invoice line item, each only after its matching preview and explicit confirmation. Delete, send, approve, payment, add-line, remove-line, and other invoice mutations are not supported. Preview tools require a v2 token but are non-writing. Execution tools additionally require both write gates (`AROFLO_WRITE_ENABLED=true` and `AROFLO_FINANCIAL_WRITES_ENABLED=true`) plus `invoices` in `AROFLO_WRITABLE_AREAS`.

When any enabled writable operation exists, both `aroflo_create_record` and `aroflo_update_record` appear together in discovery. Each selected area still validates whether create or update is supported before any request.

## Read-only acceptance

Confirm both write flags are `false`, restart the connector, then run:

```powershell
pnpm smoke:read-only
```

The command refuses to start if either flag is exactly `true`. It performs only three small reads: connection status, one task, and one client. Output contains only PASS/failure codes, connection state, and counts, not records, requests, or environment values.

For the separate API v2 check, configure `AROFLO_V2_API_TOKEN` and run:

```powershell
pnpm smoke:v2-read-only
```

`AROFLO_V2_SMOKE_BUSINESS_UNIT_ID` is optional. Without it, the command stops after `GET /v2/healthcheck`. With it, the command lists at most one invoice and, when one is present, reads that invoice's details, recipients, and lines. Every request is GET-only, and output is a status summary without tokens or invoice/customer bodies.

## Enabling and rolling back writes

Enable ordinary writes only after separate user approval: set `AROFLO_WRITE_ENABLED` to exact `true`, list only approved areas in `AROFLO_WRITABLE_AREAS`, and restart. Preview and explicitly confirm each change before one create/update call.

Enable invoice writes in a second, separate approved change by also setting `AROFLO_FINANCIAL_WRITES_ENABLED` to exact `true`, including `invoices` in the area allowlist, and restarting. The API user must also have permission.

To roll back, reset both write flags to `false` and restart. Disabled tools disappear from MCP discovery.

## Hosted access

ChatGPT access from other devices requires deploying the hosted container over HTTPS. Local stdio is available only to the computer running the process. Follow [DEPLOYMENT.md](DEPLOYMENT.md).

## Rate limits

The connector defaults to one request per second, 60 per minute, and a 1,900-call daily soft limit (Sydney date), below the documented ceilings of 3 per second, 120 per minute, and 2,000 per day. GET requests may retry transient failures; POST requests are never retried automatically.

## Troubleshooting

- **Missing environment variables:** set all four AroFlo credentials in the parent environment and restart Codex.
- **Authentication failure:** verify the HMAC API is enabled, rotate expired/shared credentials, confirm system time, and check optional Host IP configuration.
- **Permission failure:** grant the API user the required AroFlo read or mutation permission; connector flags cannot override AroFlo permissions.
- **Write tools absent:** this is expected until the global flag, area allowlist, operation support, and invoice gate (when applicable) all pass at startup.
- **Hosted startup refused:** provide a strong MCP token and, for non-loopback binding, an explicit Host allowlist.
- **Rate-limit response:** wait for the reported allowance to recover; do not bypass the limiter.
- **Node not found locally:** set `AROFLO_NODE_PATH` to a Node 20+ executable or install Node on the command path, then restart.
