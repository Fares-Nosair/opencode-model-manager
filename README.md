# OpenCode Model Manager v4

A local Windows dashboard for OpenCode v2-style configuration. Add custom OpenAI-compatible providers, query their model endpoints, and register selected model IDs directly in `providers.<id>.models` — no `opencode-models-discovery` plugin required.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/Windows-10/11-blue?logo=windows)](https://www.microsoft.com/windows)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Localhost only](https://img.shields.io/badge/Scope-localhost%20only-red)](#security)

---

## What it does

| Feature | Description |
|---------|-------------|
| **Add providers** | Register any OpenAI-compatible API by ID, name, base URL, API key, package, and extra headers. |
| **Discover models** | Walks up to 5+ candidate model-list URLs per provider (preserved path, walked-up segments, `/v1/models`, `/models`), escalating auth (Bearer → `x-goog-api-key` → `?key=`) only on 401/403. |
| **Direct registration** | Writes selected model IDs straight into `opencode.jsonc` under `providers.<id>.models`. No discovery plugin, no background refresh. |
| **Enable/disable** | Toggle providers on/off via `disabled_providers` / `enabled_providers`. |
| **Request adapters** | Per-provider local OpenAI-compatible proxy with dynamic headers (`{{uuid}}`, `{{node_version}}`, `{{timestamp}}`), forced streaming, body overrides, and API key sources (incoming Bearer, `env:NAME`, or stored). |
| **Test connections** | Test individual providers or check all at once; health dots show reachable/failed/unknown. |
| **Remove discovery plugin** | Strips `opencode-models-discovery` from the global `plugins` array and provider-level `modelsDiscovery` keys. |

---

## Requirements

- **Windows 10/11**
- **Node.js 18+** (Node 20+ recommended)
- OpenCode config at `%USERPROFILE%\.config\opencode\opencode.jsonc`

---

## Quick start

```bash
# 1. Clone or extract the repository
git clone https://github.com/your-username/opencode-model-manager.git
cd opencode-model-manager

# 2. Install the single dependency
npm install

# 3. Start the local dashboard
npm start

# 4. Open http://127.0.0.1:8765
```

Or on Windows, double-click `start-dashboard.bat`.

Stop the server with `Ctrl+C`.

---

## Usage

### Models tab
1. Select a provider (or "All providers") and click **Discover provider** / **Discover all providers**.
2. Tick the models you want registered in OpenCode. Changes are written to `opencode.jsonc` immediately — no save button.
3. Disabled providers show greyed-out models that keep their previous selection.

### Providers tab
- **Add provider** — enter ID, name, base URL, optional API key, provider package, and optional extra headers.
- **Edit** — change any field; renaming the ID also renames the provider in config.
- **Test** — checks the provider's model-list endpoint and reports latency and model count.
- **Delete** — removes the provider and its registered models from `opencode.jsonc`.
- **Toggle** — enable/disable providers (writes to `disabled_providers`).

### Adapters tab
The Adapters tab runs a local OpenAI-compatible proxy per provider:

1. Select a provider and set its **upstream base URL** (the real API, not the proxy URL).
2. Configure static headers, dynamic headers (with `{{uuid}}`, `{{node_version}}`, `{{timestamp}}` tokens), body overrides, default model, and timeout.
3. Choose the **API key source**: incoming Bearer key, `env:NAME`, or a stored key.
4. Toggle **Enabled** — the provider's base URL in `opencode.jsonc` is rewritten to the local proxy URL (`http://127.0.0.1:8765/proxy/<id>/v1`). Disabling restores the original URL.
5. Click **Send hi** to test the full proxy pipeline.

Adapter settings live in `adapters.json` (override with `ADAPTERS_FILE` env var) and are never written into `opencode.jsonc`.

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Local server port. |
| `OPENCODE_CONFIG` | `%USERPROFILE%\.config\opencode\opencode.jsonc` | Path to OpenCode's JSONC config. |
| `ADAPTERS_FILE` | `adapters.json` next to `server.mjs` | Path to the adapter settings file. |

### Direct registration format

Selected models are written as minimal entries:

```jsonc
{
  "provider": {
    "my-provider": {
      "name": "My Provider",
      "models": {
        "model-id-1": { "name": "model-id-1" },
        "model-id-2": { "name": "Model 2" }
      }
    }
  }
}
```

Existing metadata for already-configured models is preserved. Discovered-but-unchecked IDs are removed from that provider's model object; models not returned by the endpoint are left alone.

---

## Security

- The server binds to `127.0.0.1` only — never exposed to the network.
- API keys entered in the Add Provider form are stored in **plaintext** in OpenCode's JSONC config. This matches normal OpenCode config behavior; use environment variables if you prefer not to store a literal key.
- Adapter stored keys are never sent to the browser or written to logs. The adapter API returns `hasKey: true/false` only, never the key value.
- URLs passed as query parameters (e.g. `?key=`) are redacted before being shown in the UI.
- **Do not** expose this app through a tunnel, port forward, or reverse proxy.
- Rotate any key that was accidentally pasted into chats or logs.

---

## Backups

Config writes go straight to `opencode.jsonc` — the app does **not** create backups. Keep your own copy or use version control if you want a history.

---

## Project structure

```
opencode-model-manager/
├── server.mjs            # Local HTTP server + API (ES modules)
├── adapters.json.example # Template for adapter settings (not committed)
├── adapters.json         # User-specific adapter settings (gitignored)
├── package.json          # Node manifest (jsonc-parser dependency)
├── package-lock.json
├── start-dashboard.bat   # Windows launcher
├── .gitignore
├── LICENSE               # MIT
├── README.md
├── public/
│   ├── index.html        # Dashboard UI
│   ├── app.js            # Frontend application logic
│   └── styles.css        # Dark-theme styles
└── test/
    ├── adapter.test.mjs
    ├── adapter-discovery.test.mjs
    └── model-save.test.mjs
```

---

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Start in development
npm start
```

Tests use Node's built-in test runner (`node:test`) and spin up mock upstream servers on ephemeral ports.

---

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m "Add your feature"`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a pull request.

Please keep changes consistent with the existing code style (ES modules, `node:http`, `jsonc-parser`).

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Disclaimer

This is an independent helper tool, not an official OpenCode product. It modifies your OpenCode configuration file directly — review changes before restarting OpenCode.
