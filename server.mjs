import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORT,
  configPath,
  readConfig,
  allProviders,
  getProviders,
  getProviderDetails,
  addProvider,
  updateProvider,
  deleteProvider,
  setProviderEnabled,
  saveModels,
  removeDiscoveryPlugin,
  listBackups,
  restoreBackup,
  exportConfig,
  importConfig,
  loadAdapters,
  saveAdapterSettings,
  defaultAdapterSettings,
  publicAdapter,
  proxyBaseURL,
  providerBaseURL,
  isProxyBaseURL
} from "./lib/config.mjs";

import { getPresets, ahefiPreset } from "./lib/presets.mjs";

import {
  listMcpServers,
  saveMcpServer,
  toggleMcpServer,
  deleteMcpServer,
  testMcpServer
} from "./lib/mcp.mjs";

import {
  discover,
  testProvider,
  checkProviders,
  testProviderCompletion,
  testModelChat,
  runModelBenchmark,
  discoverBatch,
  modelsUrlCandidates,
  fetchModelsBody,
  modelRowsFromBody,
  authAttempts
} from "./lib/discovery.mjs";

import {
  handleProxyChat,
  handleProxyModels,
  handleProxyEmbeddings,
  testAdapterChat
} from "./lib/proxy.mjs";

import { getLogEntries, clearLogEntries } from "./lib/logs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 10_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON request."));
      }
    });
    req.on("error", reject);
  });
}

function isAllowedHost(host) {
  if (!host) return true;
  const clean = host.split(":")[0].toLowerCase();
  return clean === "127.0.0.1" || clean === "localhost";
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      return sendJson(res, 403, { error: "Forbidden: cross-site requests to local dashboard are blocked." });
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    // Status
    if (req.method === "GET" && url.pathname === "/api/status") {
      const { config } = readConfig();
      return sendJson(res, 200, {
        ok: true,
        configPath,
        providerCount: allProviders(config).size,
        pluginRequired: false,
        pluginPresent: Array.isArray(config.plugins) && config.plugins.some(x => (typeof x === "string" ? x : x?.package || "").includes("opencode-models-discovery"))
      });
    }

    // Backups
    if (req.method === "GET" && url.pathname === "/api/backups") {
      return sendJson(res, 200, { backups: listBackups() });
    }
    if (req.method === "POST" && url.pathname === "/api/backups/restore") {
      const body = await readBody(req);
      if (typeof body.filename !== "string") return sendJson(res, 400, { error: "Missing filename." });
      return sendJson(res, 200, restoreBackup(body.filename));
    }

    // Config export & import
    if (req.method === "GET" && url.pathname === "/api/config/export") {
      return sendJson(res, 200, exportConfig());
    }
    if (req.method === "POST" && url.pathname === "/api/config/import") {
      const body = await readBody(req);
      return sendJson(res, 200, importConfig(body));
    }

    // Activity / Proxy Logs
    if (req.method === "GET" && url.pathname === "/api/proxy/logs") {
      return sendJson(res, 200, { logs: getLogEntries() });
    }
    if (req.method === "DELETE" && url.pathname === "/api/proxy/logs") {
      clearLogEntries();
      return sendJson(res, 200, { ok: true });
    }

    // Presets
    if (req.method === "GET" && url.pathname === "/api/presets") {
      return sendJson(res, 200, { presets: getPresets() });
    }
    if (req.method === "GET" && url.pathname === "/api/adapters/preset") {
      return sendJson(res, 200, { preset: ahefiPreset() });
    }

    // Providers
    if (req.method === "GET" && url.pathname === "/api/providers") {
      const single = url.searchParams.get("provider");
      if (single) return sendJson(res, 200, { provider: getProviderDetails(single) });
      return sendJson(res, 200, { providers: getProviders() });
    }
    if (req.method === "POST" && url.pathname === "/api/providers/toggle") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      const enabled = body.enabled === true || body.disabled === false;
      if (body.enabled !== true && body.enabled !== false && body.disabled !== true && body.disabled !== false) {
        return sendJson(res, 400, { error: "Provide enabled:true/false (or disabled:true/false)." });
      }
      return sendJson(res, 200, setProviderEnabled(body.provider, enabled));
    }
    if (req.method === "POST" && url.pathname === "/api/providers") {
      return sendJson(res, 200, addProvider(await readBody(req)));
    }
    if (req.method === "PUT" && url.pathname === "/api/providers") {
      return sendJson(res, 200, updateProvider(await readBody(req)));
    }
    if (req.method === "DELETE" && url.pathname === "/api/providers") {
      const id = url.searchParams.get("provider");
      if (!id) return sendJson(res, 400, { error: "Missing provider query parameter." });
      return sendJson(res, 200, deleteProvider(id));
    }

    // Provider Testing
    if (req.method === "GET" && url.pathname === "/api/providers/test") {
      const id = url.searchParams.get("provider");
      if (!id) return sendJson(res, 400, { error: "Missing provider query parameter." });
      return sendJson(res, 200, await testProvider(id));
    }
    if (req.method === "POST" && url.pathname === "/api/providers/check") {
      const body = await readBody(req).catch(() => ({}));
      const ids = Array.isArray(body.providers) ? body.providers.filter(x => typeof x === "string") : undefined;
      return sendJson(res, 200, { results: await checkProviders(ids) });
    }
    if (req.method === "POST" && url.pathname === "/api/providers/test-completion") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      return sendJson(res, 200, await testProviderCompletion(body.provider, body.model || null));
    }
    if (req.method === "POST" && url.pathname === "/api/providers/test-chat") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      return sendJson(res, 200, await testAdapterChat(body.provider));
    }

    // Models
    if (req.method === "GET" && url.pathname === "/api/models") {
      const id = url.searchParams.get("provider");
      if (!id) return sendJson(res, 400, { error: "Missing provider query parameter." });
      return sendJson(res, 200, await discover(id, url.searchParams.get("endpoint") || undefined));
    }
    if (req.method === "POST" && url.pathname === "/api/models/discover-batch") {
      const body = await readBody(req);
      if (!Array.isArray(body.providers)) return sendJson(res, 400, { error: "Missing providers array." });
      return sendJson(res, 200, await discoverBatch(body.providers));
    }
    if (req.method === "POST" && url.pathname === "/api/models/test-chat") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      return sendJson(res, 200, await testModelChat(body));
    }
    if (req.method === "POST" && url.pathname === "/api/models/benchmark") {
      const body = await readBody(req).catch(() => ({}));
      return sendJson(res, 200, await runModelBenchmark(body));
    }
    if (req.method === "POST" && url.pathname === "/api/models/save") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      return sendJson(res, 200, saveModels(body.provider, body.discoveredIds, body.selectedIds, body.metadata || {}));
    }

    // Discovery plugin removal
    if (req.method === "POST" && url.pathname === "/api/disable-discovery-plugin") {
      return sendJson(res, 200, removeDiscoveryPlugin());
    }

    // MCP Servers
    if (req.method === "GET" && url.pathname === "/api/mcp") {
      return sendJson(res, 200, listMcpServers());
    }
    if (req.method === "POST" && url.pathname === "/api/mcp") {
      const body = await readBody(req);
      if (typeof body.name !== "string" || !body.config) {
        return sendJson(res, 400, { error: "Missing name or config." });
      }
      return sendJson(res, 200, saveMcpServer(body.name, body.config));
    }
    if (req.method === "POST" && url.pathname === "/api/mcp/toggle") {
      const body = await readBody(req);
      if (typeof body.name !== "string") {
        return sendJson(res, 400, { error: "Missing name." });
      }
      return sendJson(res, 200, toggleMcpServer(body.name, body.enabled !== false));
    }
    if (req.method === "DELETE" && url.pathname === "/api/mcp") {
      const name = url.searchParams.get("name");
      if (!name) return sendJson(res, 400, { error: "Missing name query parameter." });
      return sendJson(res, 200, deleteMcpServer(name));
    }
    if (req.method === "POST" && url.pathname === "/api/mcp/test") {
      const body = await readBody(req);
      return sendJson(res, 200, await testMcpServer(body));
    }

    // Adapters
    if (req.method === "GET" && url.pathname === "/api/adapters") {
      const { config: listConfig } = readConfig();
      let stored;
      try { stored = loadAdapters(); }
      catch (e) { return sendJson(res, 500, { error: e.message || "Could not load adapters." }); }
      const entries = allProviders(listConfig);
      const adapters = [...entries.keys()].map(pid => {
        const s = (stored[pid] && typeof stored[pid] === "object") ? stored[pid] : {};
        const merged = { ...defaultAdapterSettings(), ...s };
        const currentBase = providerBaseURL(entries.get(pid).data);
        return {
          ...publicAdapter(pid, merged),
          upstreamBaseURL: merged.upstreamBaseURL || (!isProxyBaseURL(currentBase, pid) ? currentBase : ""),
          proxyUrl: proxyBaseURL(pid),
          routed: isProxyBaseURL(currentBase, pid)
        };
      }).sort((a, b) => a.provider.localeCompare(b.provider));
      return sendJson(res, 200, { adapters });
    }
    if (req.method === "PUT" && url.pathname === "/api/adapters") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      return sendJson(res, 200, saveAdapterSettings(body.provider, body));
    }

    // Proxy routes: /proxy/:providerId/v1/(chat/completions|models|embeddings)
    {
      const proxyMatch = url.pathname.match(/^\/proxy\/([^/]+)\/v1\/(chat\/completions|models|embeddings)$/);
      if (proxyMatch) {
        const providerId = decodeURIComponent(proxyMatch[1]);
        const endpoint = proxyMatch[2];
        if (endpoint === "chat/completions") {
          if (req.method !== "POST") {
            return sendJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error", code: 405 } });
          }
          return await handleProxyChat(req, res, providerId, sendJson);
        }
        if (endpoint === "models") {
          if (req.method !== "GET") {
            return sendJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error", code: 405 } });
          }
          return await handleProxyModels(req, res, providerId, sendJson, modelsUrlCandidates, fetchModelsBody, modelRowsFromBody, authAttempts);
        }
        if (endpoint === "embeddings") {
          if (req.method !== "POST") {
            return sendJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error", code: 405 } });
          }
          return await handleProxyEmbeddings(req, res, providerId, sendJson);
        }
      }
    }

    // Static Assets
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", "app.js")));
    }
    if (req.method === "GET" && url.pathname === "/styles.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", "styles.css")));
    }

    return sendJson(res, 404, { error: "Not found." });
  } catch (e) {
    return sendJson(res, 500, { error: e.message || "Unexpected error." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenCode Model Manager running at http://127.0.0.1:${PORT}`);
  console.log(`Config: ${configPath}`);
  console.log("Direct registration mode: no discovery plugin required. Localhost only. Press Ctrl+C to stop.");
});
