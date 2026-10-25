# OpenCode Model Manager v4 — Direct registration + request adapters
<img width="1296" height="731" alt="Screenshot 2026-10-16 210646" src="https://github.com/user-attachments/assets/913c2b39-91e6-46b5-b84d-5f0b066f4a98" />

This is a local Windows dashboard for OpenCode v2-style config. It can add custom OpenAI-compatible providers, query their model endpoints, and register selected model IDs directly in `providers.<id>.models`. It does not require `opencode-models-discovery`. The Adapters tab runs a local OpenAI-compatible proxy per provider for dynamic headers, forced streaming and body overrides. The same UI also manages MCP servers in `opencode.jsonc`, benchmarks model latency, tests models in a playground, shows live proxy activity, and keeps rolling config backups.

## Requirements
- Windows 10/11
- Node.js 18+ (Node 20+ recommended)
- OpenCode config at `%USERPROFILE%\.config\opencode\opencode.jsonc`

## Start
1. Clone or extract this repository to a folder, e.g. `C:\Tools\opencode-model-manager`.
2. Open CMD in that folder.
3. Run `npm install`
4. Run `npm start`
5. Open `http://127.0.0.1:8765`

Stop with Ctrl+C.

## Use

### Models tab
- Select a provider (or all providers) and click **Discover provider** / **Discover all providers**.
- Tick/untick model IDs — each change is written to `opencode.jsonc` immediately. No save button.
- Disabled providers show their models greyed out; their previous selection is kept.
- Capability badges (**REASONING**, **VISION**, **TOOLS**, **EMBED**) are inferred from model IDs and names. The tag chips filter the list and the sort control reorders it.
- **Playground** sends a chat completion to one model and shows the reply, latency, usage and any reasoning output.
- **Benchmark speed** sends a short prompt to every registered model and ranks them by latency (failed models last).

### Providers tab
<img width="1247" height="632" alt="Screenshot 2026-10-16 211135" src="https://github.com/user-attachments/assets/a211caae-9af6-494f-8655-5b5de526613b" />

- **Add provider** — enter ID, name, base URL, optional API key, provider package, and optional extra headers. A preset can fill these in.
- **Edit** — change any field; renaming the ID also renames the provider in config.
- **Test** — checks the provider's model-list endpoint and reports latency and model count.
- **Send hi** — sends a direct chat completion to the provider, bypassing adapters.
- **Delete** — removes the provider and its registered models from `opencode.jsonc`.
- **Toggle** — enable/disable providers (writes to `disabled_providers`).
- **Export** downloads providers, enabled/disabled lists and adapter settings as JSON. **Import** merges that JSON back into config and adapters.

### Adapters tab
<img width="1104" height="713" alt="Screenshot 2026-10-16 210909" src="https://github.com/user-attachments/assets/d84d8eee-e4b6-4cfa-8e60-92b6d4721159" />

The Adapters tab runs a local OpenAI-compatible proxy per provider:

1. Select a provider and set its **upstream base URL** (the real API, not the proxy URL).
2. Configure static headers, dynamic headers (with `{{uuid}}`, `{{node_version}}`, `{{timestamp}}` tokens), body overrides, default model, and timeout.
3. Choose the **API key source**: incoming Bearer key, `env:NAME`, or a stored key.
4. Optionally click **Apply preset** to fill in Ahefi, Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek, Gemini, Together AI or Mistral settings.
5. Toggle **Enabled** and save — the provider's base URL in `opencode.jsonc` is rewritten to the local proxy URL (`http://127.0.0.1:8765/proxy/<id>/v1`). Disabling restores the original URL.
6. Click **Send hi** to test the full proxy pipeline. An adapter must be enabled first.

Adapter settings live in `adapters.json` (override with `ADAPTERS_FILE` env var) and are never written into `opencode.jsonc`.

### Activity tab
Shows the last 20 proxied requests with status, latency, model and upstream error details. **Refresh** reloads the list; **Clear** empties the ring buffer.

### MCP tab
- Lists MCP servers from `mcp.servers.<id>` in `opencode.jsonc` (legacy root-level `mcp.<id>` entries are also shown).
- **Add MCP server** creates a local (command) or remote (URL) server. Presets fill in common ones: Filesystem, Web Fetch, Puppeteer, Git, GitHub, Memory, Brave Search, SQLite, Everything and Context7.
- **Test** checks that a local command's executable exists on `PATH`, or that a remote URL answers. **Test all** checks every server.
- **Toggle** writes `enabled`; **Delete** removes the entry. Restart OpenCode to apply changes.

### Backups
Click **Backups** in the topbar to list recent config snapshots and restore one with a single click. A rolling backup is created before every write and the last 5 are kept.

### Discovery plugin
If `opencode-models-discovery` is listed in this global config, click **Remove discovery plugin** after you've confirmed direct model registration works. This removes that package entry from the global `plugins` array and removes provider-level `settings.modelsDiscovery` keys. It does not uninstall npm cache files or alter project-level configs.

After changes, restart/reload OpenCode (for the v2 background service, `opencode service restart`) and check the model selector.

## Direct registration
The app writes selected IDs to the provider's `models` object, creating minimal `{ "name": "model-id" }` entries for new models and preserving metadata for existing entries. The selection is authoritative for that provider: unchecking a model removes it, and on every save any registered model that was not returned by the latest discovery result is removed too. So when a provider deletes a model upstream, the next discovery prunes it from config as well.

This is direct static registration, not automatic background refresh. To discover newly added upstream models later, reopen the dashboard and click Discover all providers again.

## Endpoint behavior
- The dashboard works out the model-list URL instead of assuming one. It keeps the path from the provider's base URL (so `https://openrouter.ai/api/v1` becomes `/api/v1/models`), walks up one path segment when a path 404s (so Google's `https://generativelanguage.googleapis.com/v1beta/openai/` finds the real `/v1beta/models`), and falls back to `/v1/models` then `/models`.
- Auth is escalated only when the endpoint answers 401/403: `Authorization: Bearer`, then the `x-goog-api-key` header, then a `?key=` query parameter. A key passed as a query parameter is redacted (`?key=***`) before the resolved URL is shown in the UI.
- A response is only accepted when it parses as JSON in a recognised shape — an HTML page returned with HTTP 200 is rejected and the next candidate is tried.
- Supports response arrays, `{ "data": [...] }`, `{ "models": [...] }`, or `{ "items": [...] }`. Google-style resource names (`models/gemini-2.5-flash`) are shortened to `gemini-2.5-flash` and `displayName` is used as the label.
- Extra headers are supported. If an auth header is set manually, the dashboard will not override it with Bearer API key.
- The endpoint that actually answered is shown in the ENDPOINT row, and a failed discovery lists every URL it tried.

## Features & Capabilities
- **Direct Model Registration:** Register discovered model IDs directly into OpenCode's configuration without needing discovery plugins.
- **Automatic Rolling Backups:** Every configuration change creates a timestamped backup in `.config/opencode/.backups/` (retaining the last 5). Easily restore any previous backup via the topbar "Backups" dropdown.
- **Provider & Adapter Presets:** 1-click presets for popular providers and local engines: Ahefi, Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek, Google Gemini (OpenAI compat), Together AI, and Mistral.
- **MCP Server Management:** List, add, edit, enable/disable, test and delete MCP servers in `opencode.jsonc`, with 1-click presets for common community servers.
- **Playground & Speed Benchmark:** Chat with any registered model from the UI, and rank all registered models by latency using a short benchmark prompt.
- **Reasoning / Thinking Model Support:** Preserves `reasoning_content` and `<think>` output (DeepSeek-R1, Qwen reasoning models, o1/o3-series) during proxy SSE stream aggregation and model tests.
- **Live Activity Monitor:** Ring buffer tracking the last 20 requests in the "Activity" tab with real-time status dots, latency, model names, and upstream error details.
- **Proxied Endpoints:** Proxies `/chat/completions`, `/models`, and `/embeddings` with dynamic custom headers and authentication.
- **Chat Testing:** Test chat completion connectivity directly against any configured provider (`Send hi` on the Providers tab), or through an enabled adapter (Adapters tab).
- **Model Capability Badges & Filtering:** Infers capability tags (`REASONING`, `VISION`, `TOOLS`, `EMBED`) from model IDs/names, with tag filters and sorting options.
- **Export & Import:** Export and import entire provider and adapter setups as portable JSON files.
- **Keyboard Shortcuts:** `/` or `Ctrl+K` to focus model search; `Esc` to clear search or close modals/dropdowns.

## Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Local server port. Also used in generated proxy URLs. |
| `OPENCODE_CONFIG` | `%USERPROFILE%\.config\opencode\opencode.jsonc` | Path to OpenCode's JSONC config. |
| `ADAPTERS_FILE` | `adapters.json` next to `server.mjs` | Path to the adapter settings file. |

## Security
- Server binds to `127.0.0.1` only with host and origin verification to block cross-site browser requests.
- Provider and adapter listings expose only a `hasApiKey` flag; key values are not returned by normal UI endpoints.
- Stored adapter keys live in `adapters.json` and are never logged or echoed to the client.
- **Export contains secrets:** the JSON export intentionally includes provider API keys and stored adapter keys so a setup can be moved between machines. Treat exported files as sensitive.

## Backups
- Automatic rolling backups are saved to `.config/opencode/.backups/` before any file write.
- The topbar "Backups" dropdown allows 1-click restoration of any recent backup.

## Limitations
- Discovery only reads model-list endpoints; it covers the common OpenAI, OpenRouter and Google listing shapes.
- Capability badges are heuristics based on model IDs and names, and are not written into `opencode.jsonc`. New models are registered with their name only; if a model requires special reasoning, context, image, or tool-call metadata, add that metadata separately in OpenCode config.
- MCP testing only verifies that a local runtime is installed or a remote URL responds; it does not perform a full MCP handshake.
- Restart/reload OpenCode after saving. Changes are not guaranteed to be hot-applied.
- This is an independent helper, not an official OpenCode UI.


## v4 selection behavior
- Select all applies only to models currently visible after search and provider filtering.
- Select none clears only currently visible models that are selected. Other providers and hidden search results retain their selections.
- The custom provider form supports static extra HTTP headers. Dynamic per-request headers (such as generating a new task ID for each chat completion), forced streaming, and response rewriting are handled by a request adapter in the Adapters tab (local proxy), not by static provider configuration alone.

## Request adapters
- The Adapters tab lists every provider with its adapter state (enabled/disabled, local proxy URL, upstream URL). Selecting a provider opens its adapter form: enable toggle, upstream base URL, static headers (JSON), dynamic headers (JSON), body overrides (JSON), default model, timeout, and API key source (incoming Bearer key, `env:NAME`, or a stored key). The "Apply preset" dropdown fills in a provider preset (including Ahefi's headers, task-ID header, streaming overrides and default model) with one click.
- Adapter settings live in `adapters.json` next to `server.mjs` (override with env `ADAPTERS_FILE`). They are never written into `opencode.jsonc`. Stored keys are never sent to the browser or written to logs.
- Dynamic header values support template tokens, resolved fresh on every request: `{{uuid}}`, `{{node_version}}`, `{{timestamp}}`.
- Local proxy routes (same server and port, localhost only):
  - `POST /proxy/:providerId/v1/chat/completions` — forces the adapter body overrides (e.g. `stream:true`), builds headers from scratch (key + static + dynamic), pipes upstream SSE ending with `data: [DONE]`, and aggregates chunks into one JSON response when the client sent `stream:false`. Reasoning output is preserved for non-streaming clients.
  - `GET /proxy/:providerId/v1/models` — same header builder, returns the upstream JSON.
  - `POST /proxy/:providerId/v1/embeddings` — same header builder, returns the upstream embeddings JSON.
- The "Send hi" button calls `POST /api/providers/test-chat { provider }`, which sends a single "hi" message through the same proxy code path and shows reply, usage, latency and any error. It requires the provider's adapter to be enabled; the "Send hi" button on the Providers tab uses `POST /api/providers/test-completion` instead and bypasses adapters.
- One log line is written per proxied request (time, provider id, model, status, latency). Headers and keys are never logged.

## MCP server format
The MCP tab writes servers under `mcp.servers` and leaves the rest of `opencode.jsonc` untouched:

```jsonc
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\workspace"],
        "enabled": true
      },
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp"
      }
    }
  }
}
```

Existing root-level `mcp.<id>` entries (without the `servers` wrapper) are listed and can be toggled or deleted as well.
