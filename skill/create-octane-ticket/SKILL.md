---
name: create-octane-ticket
description: Create a reviewed ALM Octane Defect ticket. Use when the user asks to create, draft, report, or file an Octane defect, bug, issue, ticket, or 缺陷; always show the complete ticket preview and use human approval before the production write.
metadata:
  version: 1.0.0
---

# Create Octane Defect Ticket

Create a real ALM Octane `defect` only through the `vizion-testcase` MCP tools. The workflow has two separate stages: safe draft validation and a human-approved production write.

## Required Draft Fields

Collect these fields before creating a preview:

- `name`: concise Defect title.
- `description_html`: complete HTML description containing the observed behavior, expected behavior, reproduction conditions, impact, and evidence links or trace references when available.
- `severity`: an Octane reference with `type` and `id`.
- `phase`: an Octane phase reference with `type` and `id`.
- `owner`: an Octane `workspace_user` reference with `type` and `id`.

Never invent a reference ID. Ask the user for the ID or obtain it from a trusted Octane response. Do not expose or request cookie values, API keys, or other credentials in chat.

## Optional Fields

Use typed references when the user has supplied them:

- `team`
- `problem_finder_team`
- `detected_in_release`
- `assigned_ecu`
- `lead_model`
- `product_areas`

Use plain strings for `software_version` and `vin`. Use `custom_text_fields`, `custom_reference_fields`, or `custom_multi_reference_fields` only for workspace-specific UDFs whose field names and reference IDs are known. For example, a `requirements` relation is a `custom_multi_reference_fields` entry with an array of `requirement` references.

## Procedure

1. Gather the required values and any optional context. If a required reference is missing, ask for it instead of guessing.
2. Call `validate_defect_ticket` with the complete structured draft. This does not write to Octane.
3. Show the returned `octane_fields` as the ticket preview. Explain missing optional fields or validation errors plainly. Do not call the production tool at this stage.
4. Wait until the user explicitly requests creation of the reviewed draft.
5. Call `commit_defect_ticket` with the same reviewed values. LibreChat pauses before this tool executes and presents native Approve, Reject, and Edit controls. The Octane POST happens only after the user approves that control.
6. Report the returned `defect_id` and `octane_url`. If Octane returns `400` or `403`, surface the error and stop. Do not retry with guessed field IDs or altered values.

## Production Safety Rules

- `validate_defect_ticket` is safe and may be called repeatedly while the draft is revised.
- `commit_defect_ticket` is a production write. Never use it before the user has reviewed the preview and explicitly asked to create the ticket.
- Do not use raw HTTP for Octane. The MCP client supplies cookie and XSRF handling.
- Keep all final field values visible in the approval request so the user can reject or edit the exact payload before it is written.