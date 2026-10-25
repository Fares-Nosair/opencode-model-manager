# OpenCode Model Manager v4

<img width="1296" height="731" alt="OpenCode Model Manager dashboard" src="https://github.com/user-attachments/assets/913c2b39-91e6-46b5-b84d-5f0b066f4a98" />

**Add OpenAI-compatible providers, pick the models you actually want, and get back to coding.**
A local Windows dashboard for OpenCode config — no discovery plugin, no manual JSON editing.

`Windows 10/11` · `Node 18+` · `localhost only` · `MIT`

## Quick start

```bash
npm install
npm start
```

Open **http://127.0.0.1:8765** — or double-click `start-dashboard.bat`. Stop with `Ctrl+C`.

Your config lives at `%USERPROFILE%\.config\opencode\opencode.jsonc`.

## What's inside

| Tab | What it does |
|-----|--------------|
| **Models** | Discover models, tick the ones you want, and save instantly. Includes capability badges, a playground, and a speed benchmark. |
| **Providers** | Add, edit, delete, toggle, test, export and import providers. |
| **Adapters** | Run a local OpenAI-compatible proxy with dynamic headers, forced streaming and body overrides. |
| **Activity** | Live log of the last 20 proxied requests, with status, latency and upstream errors. |
| **MCP** | Manage `mcp.servers` in `opencode.jsonc` with presets and connection tests. |

## How model registration works

- **Tick** a model → it is added to the provider's `models` object immediately.
- **Untick** it → it is removed. No save button.
- On every save, models the provider no longer returns are pruned too.
- Existing model metadata is preserved.

That's it. To pick up new upstream models later, reopen the dashboard and hit **Discover all providers**.

> Coming from `opencode-models-discovery`? Once direct registration works, click **Remove discovery plugin** to strip its global plugin entry and per-provider settings.

## Adapters in 30 seconds

Point a provider at its real API, then enable its adapter. The provider's `baseURL` is rewritten to:

```
http://127.0.0.1:8765/proxy/<provider-id>/v1
```

From there the proxy handles:

- Dynamic header tokens: `{{uuid}}`, `{{node_version}}`, `{{timestamp}}`
- Forced streaming and JSON body overrides
- API keys from the incoming request, `env:NAME`, or a stored key
- `chat/completions`, `models` and `embeddings`

**Apply preset** fills everything in: Ahefi · Ollama · LM Studio · vLLM · OpenRouter · Groq · DeepSeek · Gemini · Together AI · Mistral

`Send hi` on the Adapters tab tests the full proxy (adapter must be enabled). `Send hi` on the Providers tab talks to the provider directly.

## MCP servers

Add local or remote MCP servers, toggle them, and test them — all written to `mcp.servers`.

Presets: Filesystem · Web Fetch · Puppeteer · Git · GitHub · Memory · Brave Search · SQLite · Everything · Context7

Tests check that a local runtime exists on `PATH` or that a remote URL responds; they don't run a full MCP handshake.

## Backups & portability

- A timestamped backup is created before every write. The last **5** are kept.
- **Backups** in the topbar restores any snapshot in one click.
- **Export / Import** moves providers and adapter settings as JSON.
- ⚠️ Export files include API keys. Treat them like secrets.

## A look around

<img width="1247" height="632" alt="Providers tab" src="https://github.com/user-attachments/assets/a211caae-9af6-494f-8655-5b5de526613b" />

<img width="1104" height="713" alt="Adapters tab" src="https://github.com/user-attachments/assets/d84d8eee-e4b6-4cfa-8e60-92b6d4721159" />

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8765` | Local server port, also used in proxy URLs. |
| `OPENCODE_CONFIG` | `%USERPROFILE%\.config\opencode\opencode.jsonc` | OpenCode config file. |
| `ADAPTERS_FILE` | `adapters.json` beside `server.mjs` | Adapter settings file. |

## Good to know

- **Localhost only.** Host and origin checks block cross-site requests; API keys are masked in normal UI responses and never logged.
- **Restart OpenCode** after changes (`opencode service restart` for the v2 service).
- Capability badges are guesses based on model names, not written to config. Add reasoning/context/image metadata manually if a model needs it.
- Discovery supports the common OpenAI, OpenRouter and Google model-list shapes.
- `Ctrl+K` or `/` searches models; `Esc` closes dialogs and clears search.

This is an independent helper, not an official OpenCode UI. MIT licensed.
