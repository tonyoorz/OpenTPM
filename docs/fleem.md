# Fleem MCP

LibreChat keeps **Fleem** (`vizion-fleem`), the existing read-only local connector, as its default. **Fleem Official** (`integrate-fleem`) is temporarily removed from LibreChat's active server list because shared-Web authorization is blocked. The official server is configured separately in this workspace's `.vscode/mcp.json` for direct use in VS Code.

## Official MCP

The [BMW Skills Marketplace entry](https://skills.bmwgroup.net/mcp-configurations/dx/scp-apps-fleem-mcp?q=fleem) configures `https://integrate.bmwgroup.net/fleem/mcp` over Streamable HTTP. Its description lists vehicle/platform lookups, schedules, cluster milestones, Lifebook changes, and SVK/FA readout history. Access requires the BMW network and an SCP.apps role in FleeM; queries run with the signed-in user's own roles.

For VS Code, open `.vscode/mcp.json`, select **Start** for `integrate-fleem`, confirm trust in the official server, and complete the BMW authorization flow when prompted. Enable its discovered tools in Copilot Agent chat. This uses each user's own BMW account; no shared token or manual token field is configured. Installation of the server definition does not by itself establish a successful authenticated connection.

Its public discovery metadata advertises authorization-code and refresh-token grants, PKCE S256, and dynamic client registration. The following LibreChat migration steps apply only after the provider approves shared-Web access and the `integrate-fleem` entry is restored with `requiresOAuth: true` and `startup: false`.

1. Reload the backend configuration, refresh LibreChat, and open **Fleem Official** in MCP settings.
2. Select **Initialize** or **Reinitialize** and complete BMW sign-in and consent in the authorization page when prompted. Keep passwords, cookies, and tokens in the local authentication flow, never in chat or tool arguments. A Marketplace sign-in alone does not authorize LibreChat's MCP connection.
3. Inspect the discovered tool schemas before choosing query arguments. The Marketplace description does not establish support for arbitrary IQL, fleet filtering, complete pagination, or every native Fleem field.
4. Before replacing the local connector, verify both `DTSV_China_C` and `DTSV_China_R` with the same **Active** status scope, complete pagination, and representative VIN/detail lookups. Deduplicate platform IDs when comparing the union of fleets; one platform may belong to both. Successful initialization is not a successful fleet-data query.
5. Preserve the local VIN-to-market mapping for HK/TW/CN filtering and statistics unless an equivalent source and classification have been verified. This is derived local logic, not an advertised official MCP capability.
6. Only after these checks pass, switch default tool pins and any agent selections to the official server's discovered tools. Existing local tool names are not aliases for the official tools. Retain the local connector as a rollback option until the migration is accepted.

When re-enabled in LibreChat, the official connection needs a server-scoped corporate `proxy` and the exact `integrate.bmwgroup.net:443` address exemption; that now-unused exemption was removed with the active entry. Keep TLS certificate verification enabled and preserve system CA trust for the backend. Do not disable SSRF protection globally or reuse the local connector's token as an OAuth credential.

Integration status (2026-11-18): the server-scoped OAuth proxy fix is implemented and the compiled discovery reached official Fleem successfully with TLS verification enabled. The live connection then reached dynamic client registration and was rejected with `Only http loopback and VS Code redirect URIs are allowed`. This is a provider registration policy, not a DTSV query result. The unfinished localhost callback experiment has been removed; the original callback security boundary is restored and its seven unsafe-override cases plus the full proxy lifecycle regression passed. Official BMW authorization, tool discovery, and DTSV coverage remain blocked; the local connector and default tool pins are unchanged.

## Shared Web Deployment

The public Marketplace configuration targets VS Code and Copilot CLI. It does not document a shared Web client registration procedure. Its public OAuth metadata advertises authorization-code and refresh-token grants, not a device-authorization flow. Whether the service offers an approved, pre-registered Web client must be confirmed with the service team.

A shared LibreChat installation needs one stable server callback, with each user signing in using their own BMW account. A callback to `localhost` is not a shared-server solution: a colleague's browser would send it to their own computer. Do not copy a VS Code client ID, share one user's token, weaken callback checks, or create a relay to circumvent the provider's registration policy.

The current configured callback is `http://10.165.22.10:3080/api/mcp/integrate-fleem/oauth/callback`. This development HTTP address is diagnostic context, not a requested production callback. The deployment administrator must confirm an approved shared HTTPS origin before requesting production registration. With this checkout's callback enforcement, that origin must match `DOMAIN_SERVER`; setting `oauth.redirect_uri` is not an approved override.

The Marketplace lists [Dominik Marx](mailto:Dominik.Marx@bmw.de) as the artifact publisher. Ask the publisher to confirm the supported shared-Web integration route or identify the service owner who can approve it. Do not assume the publisher has registration authority.

### Registration Request

Subject: Official Fleem MCP access from shared LibreChat Web deployment

We want to connect a shared internal LibreChat installation to `https://integrate.bmwgroup.net/fleem/mcp`. Each user must authenticate with their own BMW account and retain their own FleeM roles; we do not want a shared user's bearer token.

Public resource and authorization-server discovery now work through the corporate proxy with TLS verification enabled. Dynamic registration rejects our current server callback with `Only http loopback and VS Code redirect URIs are allowed`. The development callback is `http://10.165.22.10:3080/api/mcp/integrate-fleem/oauth/callback`; we will confirm an approved shared HTTPS origin before requesting production registration.

Please confirm:

1. Is a shared Web MCP client supported, and what is the approved registration procedure?
2. Can a fixed internal HTTPS callback be approved, and which deployment or application prerequisites apply?
3. If pre-registration is supported, how do we obtain the approved client ID and token-endpoint authentication requirements? Any client secret must use an approved secure delivery channel, not chat or source control.
4. If shared Web clients are not supported, what supported alternative should our deployment use?

After the service team approves a client and callback, restore the LibreChat `integrate-fleem` entry with that client, complete a per-user BMW authorization, and inspect its actual tool schemas before accepting DTSV coverage. Until then, keep the existing local connector selected; no vehicle-query feature has been added to the official service.

## Local Connector Setup

The read-only local MCP reuses Vizion Lab's existing `backend.fleem_client` Python module. Its implementation is in `packages/api/src/mcp/fleem.ts`; `api/server/mcp/fleem.js` only starts the compiled stdio entry. The remaining sections describe this local connector, not the official server's tool contract.

1. Build the backend package from the repository root:

   ```powershell
   npm run build --workspace @librechat/api
   ```

2. Keep `VIZION_LAB_ROOT` and the launcher path in the `vizion-fleem` entry of `librechat.yaml` aligned with the local installation. By default the reader uses Vizion Lab's `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` elsewhere. Set `FLEEM_PYTHON_PATH` in the server's environment to override it. The existing Vizion Lab environment must already support `python -m backend.fleem_client`, including its `--view` option.
3. Reload LibreChat's backend configuration if it has not already restarted. In LibreChat's MCP settings, open **Fleem**, enter the bearer token from your own authorized Fleem session directly in the sensitive credential field, and initialize/reconnect the server. Never put credentials in chat, source files, view URLs, or tool arguments.
4. Select **Fleem** in the conversation's MCP tool menu or enable its tools on the agent. Example requests: "List active vehicles in a fleet" or "Group the configured view by market".

The server uses `startup: false` and per-user `customUserVars`, so no shared application-level authenticated connection is initialized. The main configuration is intentional: the Agent Plugins MCP manifest format does not accept `customUserVars`. Credentials use LibreChat's existing per-user encrypted credential storage. When a token expires, update it in MCP settings and reconnect; this implementation does not automatically renew sessions.

## Temporary Manual Login

1. Open **Fleem** in LibreChat's MCP settings. The **Fleem Access Token** field includes a **Sign in to Fleem** link, which opens the official Fleem page in a separate tab.
2. Complete the usual enterprise login in Fleem. Open browser developer tools with **F12**, then select **Application > Local Storage > `https://integrate.bmwgroup.net`**.
3. Find the **token** entry and copy its value only. Do not include quotes or the `Bearer` prefix. This is the Fleem access token, not a separately generated PAT.
4. Return to LibreChat, paste the value into the masked **Fleem Access Token** field, and select **Save**. Then use **Initialize** or **Reinitialize** in the same dialog to connect the MCP.
5. Enable Fleem for the conversation or agent. If the session expires, repeat the login/copy/save/reconnect steps.

This temporary flow does not read another site's browser storage or automatically capture credentials. The user copies the value directly between the official Fleem page and LibreChat's sensitive credential field; it must not be sent through chat. A successful MCP initialization discovers tools but does not by itself prove that the access token can read Fleem data.

## Corporate Network

The Fleem server's environment configures `HTTPS_PROXY` for the proxy selected by the local Windows PAC. Python `requests` does not automatically inherit the browser's PAC routing. Keep this setting scoped to Fleem, and update it if the corporate proxy changes; never put proxy credentials in repository files.

With `FLEEM_USE_SYSTEM_CA: 'true'`, the Node launcher exports its default and operating-system trusted CA certificates into a temporary PEM file and passes that file to Python through `REQUESTS_CA_BUNDLE`. An existing `REQUESTS_CA_BUNDLE` or `CURL_CA_BUNDLE` takes precedence. The PEM file is removed with the temporary snapshot directory after the request, including failure paths. TLS certificate verification stays enabled; no system certificate store is modified.

The connector returns safe error codes without raw child-process stderr:

- `NETWORK_TIMEOUT`: Check the Fleem-specific proxy and corporate network access.
- `TLS_VERIFY_FAILED`: Check system trust or the configured CA bundle. Do not disable TLS verification.
- `AUTH_REJECTED`: The server returned HTTP 401. Update the access token in Fleem MCP settings and reconnect.
- `ACCESS_DENIED`: The server returned HTTP 403. Check account permissions and access to the configured view.
- `REQUEST_FAILED`: An unclassified request or environment failure; raw stderr and credentials are not returned to the model.

After changing proxy settings or rebuilding the connector, reload backend configuration and reinitialize the Fleem MCP connection so it uses a new child process.

## Tools

| Tool                          | Inputs                                                                                                             | Behavior                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `fleem_query_platforms`       | Optional exact `vin`, `fleet`, `market`; `limit` 1-50, `offset`, `refresh`                                         | A bounded summary page, full matching total, and next offset. Native fleet arrays are preserved.                    |
| `fleem_get_platform`          | Exactly one of `vin` or `platform_id`; optional `refresh`                                                          | One exact match with a bounded detail preview, or an explicit not-found result. Ambiguous matches are errors.       |
| `fleem_list_platform_fields`  | Exactly one identifier; optional JSON Pointer `path`, `limit` 1-100, `offset`, `expected_sha256`, `refresh`        | Names, paths, and types of every non-sensitive child field at the selected path, with bounded pagination.           |
| `fleem_read_platform_details` | Exactly one identifier; optional JSON Pointer `path`, `chunk_size` 1-12000, `offset`, `expected_sha256`, `refresh` | Lossless JSON-text chunks of the selected native details, without string, array, object-field, or depth shortening. |
| `fleem_summarize_platforms`   | Optional exact `vin`, `fleet`, `market`; `group_by` of `market` or `fleet`; `refresh`                              | Counts computed over every matching record, not over a result page.                                                 |

Filters are case-insensitive. Fleet filters match membership in native arrays, not a joined display string. For fleet statistics, a platform contributes once to each distinct fleet it belongs to, so group counts can sum above `matched_total`. Legacy string fleet values remain strings; array fleet values remain arrays.

Tools cannot submit arbitrary IQL, URLs, GraphQL, view names, or writes. All successful results include `fetched_at`, `source_url`, configured query/status/view scope, source completeness, and matching totals. `source_complete` means that all rows in the configured view were fetched; it does not assert that every Fleem field, view, history, attachment, or other API is exposed. Summary market classifications come from Vizion Lab's VIN mapping asset, not a live Fleem market field; absent mappings are `UNMAPPED`. Any native market field returned by Fleem remains available in the native details independently of that summary classification.

## Reading Complete Details

1. Call `fleem_list_platform_fields` with one VIN or platform ID. The default empty `path` lists root fields. Follow the returned `path` values to discover children of objects or arrays. If a generated path would exceed the 4096-character input limit, the directory returns `path: null` and `read_parent`; read that parent through the detail reader instead. The directory reflects actual returned data, not a predefined field allowlist or a schema of all Fleem capabilities. `size` reports string length or array length where applicable.
2. Call `fleem_read_platform_details` with the same identifier. An empty `path` selects the entire native platform record; a path such as `/ids`, `/fa/current`, or `/pm/svk` selects only that subtree. JSON Pointer escapes `/` as `~1` and `~` as `~0`; numeric segments address array indices.
3. If `has_more` is true, continue using `next_offset` and set `expected_sha256` to the previous response's `content_sha256`. Keep the identifier and path unchanged. Both the field directory and detail reader require this digest for nonzero offsets. A changed or disappeared selection returns `CONTENT_CHANGED`; restart at offset 0. `refresh: true` remains supported, but avoid forcing refresh on every continuation.
4. For complete detail reads, concatenate the `json_chunk` strings in offset order, then parse the resulting JSON. Individual chunks are JSON-text fragments and are not necessarily valid standalone JSON. Detail offsets count JavaScript UTF-16 code units, not bytes; field-directory offsets count child fields. Always use the returned offset instead of calculating it yourself.

For example, the first detail request can use these tool arguments:

```json
{
  "vin": "YOUR_AUTHORIZED_VIN",
  "path": "/ids",
  "chunk_size": 8000,
  "refresh": true
}
```

`found: false` means no platform matched the configured view. `found: true, path_found: false` means the platform exists but the selected field is absent or redacted. A native `null` value instead has `path_found: true`, `value_type: "null"`, and JSON text `null`.

The familiar `fleem_get_platform` returns full non-sensitive details when they fit its 24000-character preview budget. Larger top-level values are omitted from this preview, setting `details_truncated: true`; they are still accessible through the detail reader. `details_redacted` separately indicates sensitive-field removal. Redaction alone does not imply truncation or prove that Fleem has additional fields. Neither new tool bypasses recursive credential-field redaction.

## Source View Selection

`FLEEM_VIEW_URL` selects the authorized IQL and platform-status scope. `FLEEM_DATA_VIEW` selects the upstream data projection and is passed to the existing Python client's `--view` option; its default remains `platform-EEK_Export`. Changing only the URL does not change this data projection.

An administrator can set `FLEEM_DATA_VIEW` in the Fleem MCP server's environment to another view name verified in their authorized Fleem environment. This connector does not enumerate all upstream view names or guess a full-access view. Alternate views must return compatible platform records with unique `_id` values and identifiers suitable for the existing VIN classification. The snapshot's reported view must match the configured view, or the connector rejects it.

The existing upstream client saves the raw `platforms` returned by its GraphQL query, without a native-field allowlist. Complete detail reads therefore expose every non-sensitive field that this query and selected projection actually return, including previously unrecognized fields. They cannot establish whether absent country, region, contract, software-history, or other fields exist behind a different Fleem interface. Supporting additional upstream operations requires their verified contracts and account authorization; it is not achieved by removing MCP output limits.

After rebuilding the connector, reinitialize the Fleem MCP connection to discover all five tools and start a process using the new code. If environment configuration also changed, reload backend configuration before reinitializing. Existing authenticated processes do not hot-reload this module.

## Scope And Limits

- The default configured view contains **Active** platforms in **DTSV_China_C** and **DTSV_China_R**, matching the existing client's example scope. Change `FLEEM_VIEW_URL` in backend configuration for a different authorized scope. A not-found result only means absent from that configured view/snapshot, not absent from all Fleem.
- Each cache miss retrieves all pages of the configured view using the existing client. `limit` restricts MCP output, not upstream retrieval. Narrow the configured view for large inventories.
- Validated snapshots are cached only in the owning MCP process for 60 seconds; concurrent reads share one request. `refresh: true` bypasses an existing cache. `FLEEM_CACHE_TTL_MS` can be 0-300000.
- Child processes time out after 120 seconds by default; `FLEEM_TIMEOUT_MS` can override this up to 300000. Keep the MCP configuration's `timeout` longer than this value.
- Snapshots larger than 25 MiB, incomplete snapshots, mismatched source scopes, missing/duplicate platform IDs, and inconsistent market classifications are rejected. Temporary snapshot files are removed on success and failure. No persistent mirror or vector index is created.
- List responses contain identifiers, fleet, and derived market only. The original detail tool remains a bounded preview; check `details_truncated` and use the new tools for complete native data. All detail paths are resolved only after recursive sensitive-field redaction. Each JSON data payload is capped at 32000 characters; detail chunks and field pages shrink as necessary to fit. A field name too large for the directory produces an explicit `OUTPUT_LIMIT` with guidance to use the JSON detail reader instead.
- Browser profile authentication is deliberately not enabled here: sharing a personal browser profile would bypass per-user authorization. This integration does not change the existing Vizion Lab client or its authentication behavior.

## Verification

From the repository root:

```powershell
npx jest --config packages/api/jest.config.mjs --rootDir packages/api --runTestsByPath packages/api/src/mcp/fleem.spec.ts --runInBand --coverage=false
npm run build --workspace @librechat/api
```

The focused tests exercise real SDK clients/transports and local files, with only the external Python execution interface substituted. They cover fleet arrays, complete native values, field navigation, chunk reconstruction, credential redaction, digest-pinned continuations, refresh propagation, and configured source projections. They do not access production Fleem data. A real authorized Fleem query still requires the user's session credential and network access.
