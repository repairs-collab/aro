---
name: aroflo-operator
description: Use when inspecting AroFlo records, describing AroFlo fields or filters, or preparing a create or update request through the AroFlo connector.
---

# Operate AroFlo Safely

## Core boundary

Use only tool names actually present in MCP discovery. Never invent aliases or generic write calls.

Never preview, simulate, or call delete, archive, send, approve, payment, add-line, remove-line, raw-query, or raw-XML behavior. Refuse that part of a mixed request and continue only with a separately supported read, create, or update.

Use the exact `aroflo_v2` prefix for Invoice API v2 tools. Never use `arfoflo_v2`; it is a typo.

## Decision order

Follow this order exactly:

1. Call a read tool directly when the area and identifier are clear.
2. Call `aroflo_describe_area` before using unfamiliar filters, joins, or fields.
3. For a requested supported create or update, call `aroflo_preview_change` and show its exact preview to the user. Do not preview unsupported behavior.
4. If write tools are absent, explain that writes are disabled by policy. Do not seek a bypass.
5. If write tools are present, obtain explicit user confirmation for that exact preview, then make one call to the discovered `aroflo_create_record` or `aroflo_update_record` tool. A changed proposal requires a new preview and confirmation.
6. Never attempt delete, archive, raw query, or raw XML behavior.

## Invoice API v2 decision order

1. For a v2 invoice read, select the matching discovered `aroflo_v2` read tool.
2. For a supported invoice create or line-item update, call the matching preview tool.
3. Show the exact preview and ask for explicit confirmation of that exact preview. Any change requires a new preview.
4. After confirmation, pass only the returned `confirmationId` to exactly one matching execution tool.
5. Refuse delete, send, approve, payment, add-line, remove-line, and every other undocumented invoice mutation.

The five read tools are:

- `aroflo_v2_connection_status`
- `aroflo_v2_list_invoices`
- `aroflo_v2_get_invoice`
- `aroflo_v2_get_invoice_default_recipients`
- `aroflo_v2_list_invoice_line_items`

The two preview tools are `aroflo_v2_preview_create_invoice` and `aroflo_v2_preview_update_invoice_line_item`. The corresponding execution tools are `aroflo_v2_create_invoice` and `aroflo_v2_update_invoice_line_item`. Preview tools never write. Execution tools must be absent unless every write gate is enabled, and a missing tool is never a reason to seek a bypass.

## Tool selection

| Intent | Discovered tool |
| --- | --- |
| Check access | `aroflo_connection_status` |
| Learn an area contract | `aroflo_describe_area` |
| Find records | `aroflo_search_records` |
| Read a known record | `aroflo_get_record` |
| Find recent changes | `aroflo_list_changes` |
| Validate a create/update | `aroflo_preview_change` |
| Apply a confirmed create/update | Use only the discovered create/update tool |

Treat a missing write tool as an intentional policy boundary, even under urgency or when the user offers raw XML or asks for a workaround.

## Confirmation example

After showing a supported update preview, ask: "Confirm this exact update to record T-1?" Call the discovered update tool once only after an explicit yes. Refuse any accompanying archive request without previewing it.

## Red flags

- A request mixes an allowed update with archive or delete.
- A proposed tool name is absent from discovery.
- Confirmation refers to something other than the displayed preview.
- A workaround uses raw query parameters or XML.
- An invoice request asks to delete, send, approve, record a payment, add a line, or remove a line.

Stop at the policy boundary; do not reinterpret these as supported changes.
