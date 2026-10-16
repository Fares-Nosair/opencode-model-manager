import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const defaultConfig = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
const configPath = process.env.OPENCODE_CONFIG || defaultConfig;
const adaptersPath = process.env.ADAPTERS_FILE || path.join(__dirname, "adapters.json");

function readConfig() {
  if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  const text = fs.readFileSync(configPath, "utf8");
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error("Could not parse opencode.jsonc. Check its JSON/JSONC syntax.");
  return { text, config: config || {} };
}
function editText(text, segments, value) {
  return applyEdits(text, modify(text, segments, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
  }));
}
function writeConfig(oldText, newText) {
  if (oldText === newText) return false;
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, newText, "utf8");
  fs.renameSync(tmp, configPath);
  return true;
}
function safeId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Provider ID must start with a letter/number and contain only letters, numbers, dots, underscores, or hyphens (max 64 characters).");
  }
  return id;
}
function providersRootKey(config) {
  if (config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)) return "provider";
  if (config.providers && typeof config.providers === "object" && !Array.isArray(config.providers)) return "providers";
  return "provider";
}
function allProviders(config) {
  const out = new Map();
  for (const key of ["provider", "providers"]) {
    const bucket = config[key];
    if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
      for (const [id, p] of Object.entries(bucket)) {
        if (!out.has(id)) out.set(id, { data: p, rootKey: key });
      }
    }
  }
  return out;
}
function providerBaseURL(p) {
  return p?.options?.baseURL || p?.settings?.baseURL || "";
}
function providerPackage(p) {
  return p?.npm || p?.package || "@opencode-ai/ai/providers/openai-compatible";
}
function providerApiKeyRaw(p) {
  return p?.options?.apiKey ?? p?.settings?.apiKey ?? "";
}
function getDisabledSet(config) {
  const arr = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
  return new Set(arr.filter(x => typeof x === "string"));
}
function getEnabledList(config) {
  if (!Array.isArray(config.enabled_providers)) return null;
  return config.enabled_providers.filter(x => typeof x === "string");
}
function isProviderDisabled(config, id) {
  const disabled = getDisabledSet(config);
  if (disabled.has(id)) return true;
  const enabled = getEnabledList(config);
  if (enabled && !enabled.includes(id)) return true;
  return false;
}
function getProviders() {
  const { config } = readConfig();
  let adapterStates = {};
  try { adapterStates = loadAdapters(); } catch { adapterStates = {}; }
  return [...allProviders(config).entries()].map(([id, { data: p }]) => {
    const adapterOn = !!adapterStates[id]?.enabled;
    const upstream = adapterOn ? String(adapterStates[id].upstreamBaseURL || "") : "";
    return {
      id, name: p?.name || id,
      // Adapter-enabled providers show the real upstream URL. The proxy URL
      // in opencode.jsonc is derived and reported separately as proxyUrl.
      baseURL: adapterOn && upstream && !isLocalProxyUrl(upstream) ? upstream : providerBaseURL(p),
      package: providerPackage(p),
      modelCount: Object.keys(p?.models || {}).length,
      disabled: isProviderDisabled(config, id),
      hasApiKey: !!providerApiKeyRaw(p),
      adapterEnabled: adapterOn,
      proxyUrl: proxyBaseURL(id)
    };
  }).sort((a,b) => a.name.localeCompare(b.name));
}
function getProviderEntry(id) {
  const { config } = readConfig();
  const entry = allProviders(config).get(id);
  if (!entry) throw new Error(`Provider "${id}" not found in config.`);
  return entry;
}
function getProvider(id) {
  return getProviderEntry(id).data;
}
function getProviderDetails(id) {
  const { config } = readConfig();
  const entry = allProviders(config).get(id);
  if (!entry) throw new Error(`Provider "${id}" not found in config.`);
  const { rootKey, data: p } = entry;
  let adapterStates = {};
  try { adapterStates = loadAdapters(); } catch { adapterStates = {}; }
  const adapterOn = !!adapterStates[id]?.enabled;
  const upstream = adapterOn ? String(adapterStates[id].upstreamBaseURL || "") : "";
  return {
    id, rootKey,
    name: p?.name || id,
    baseURL: adapterOn && upstream && !isLocalProxyUrl(upstream) ? upstream : providerBaseURL(p),
    package: providerPackage(p),
    headersText: p?.headers && typeof p.headers === "object" ? JSON.stringify(p.headers, null, 2) : "",
    hasApiKey: !!providerApiKeyRaw(p),
    modelCount: Object.keys(p?.models || {}).length,
    disabled: isProviderDisabled(config, id),
    adapterEnabled: adapterOn,
    proxyUrl: proxyBaseURL(id)
  };
}
function resolveSecret(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ||
                value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match ? (process.env[match[1]] || "") : value;
}
/* ---------------------------------------------------------------------------
 * Model-list discovery.
 *
 * Providers publish their model list at wildly different paths, so instead of
 * guessing one URL we build an ordered list of candidates and take the first
 * that answers with real JSON:
 *   - the base URL's path is preserved   (OpenRouter: /api/v1/models)
 *   - a path that 404s is walked up one segment at a time, which is how
 *     Google's /v1beta/openai finds the real /v1beta/models
 *   - a bare origin tries /v1/models before /models
 * Auth is escalated too: Bearer, then x-goog-api-key, then ?key= — only when
 * the endpoint answers 401/403, so it costs nothing for normal providers.
 * ------------------------------------------------------------------------- */
const VERSION_SEGMENT = /^v\d+[a-z0-9.]*$/i;
const AUTH_HEADER_NAMES = ["authorization", "x-goog-api-key", "x-api-key", "api-key", "x-goog-key"];

function uniqueList(list) { return [...new Set(list)]; }

function modelsUrlCandidates(baseURL, endpointOverride) {
  if (!baseURL) throw new Error("This provider has no settings.baseURL.");
  let base;
  try { base = new URL(baseURL); } catch { throw new Error("Provider baseURL is not a valid URL."); }
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Only HTTP and HTTPS API endpoints are supported.");

  const build = (path) => new URL(path.replace(/\/{2,}/g, "/"), base.origin).toString();

  if (endpointOverride) {
    if (/^https?:\/\//i.test(endpointOverride)) return [endpointOverride];
    const dir = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return [new URL(endpointOverride.replace(/^\//, ""), base.origin + dir).toString()];
  }

  const segments = base.pathname.split("/").filter(Boolean);
  if (!segments.length) return uniqueList([build("/v1/models"), build("/models")]);

  const candidates = [];
  if (segments[segments.length - 1].toLowerCase() === "models") {
    candidates.push(build(`/${segments.join("/")}`));
    segments.pop();
  }
  for (let i = segments.length; i >= 0; i--) {
    const prefix = segments.slice(0, i).join("/");
    candidates.push(build(prefix ? `/${prefix}/models` : "/models"));
  }
  if (!segments.some(s => VERSION_SEGMENT.test(s))) {
    candidates.push(build(`/${[...segments, "v1", "models"].join("/")}`));
  }
  return uniqueList(candidates);
}
function endpointUrl(baseURL, endpoint) { return modelsUrlCandidates(baseURL, endpoint)[0]; }

function modelRowsFromBody(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  for (const key of ["data", "models", "items"]) if (Array.isArray(body[key])) return body[key];
  return null;
}

async function fetchModelsBody(url, headers, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { headers, signal: abort.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`unreachable (${e.message})`);
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = "";
    try { const parsed = JSON.parse(text); detail = parsed?.error?.message || parsed?.message || ""; } catch { detail = String(text).slice(0, 200); }
    const err = new Error(detail || (response.status === 404 ? "HTTP 404 (no model list here)" : `HTTP ${response.status}`));
    err.status = response.status;
    err.authFailure = response.status === 401 || response.status === 403;
    throw err;
  }
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error("response was not JSON"); }
}

function authAttempts(url, headers, apiKey) {
  const customAuth = Object.keys(headers).some(k => AUTH_HEADER_NAMES.includes(k.toLowerCase()));
  if (customAuth || !apiKey) return [{ url, headers: { ...headers }, label: customAuth ? "configured auth" : "no key" }];
  const withKey = new URL(url);
  withKey.searchParams.set("key", apiKey);
  return [
    { url, headers: { ...headers, Authorization: `Bearer ${apiKey}` }, label: "Bearer" },
    { url, headers: { ...headers, "x-goog-api-key": apiKey }, label: "x-goog-api-key" },
    { url: withKey.toString(), headers: { ...headers }, label: "?key=" }
  ];
}

function shortEndpoint(url) {
  try { const u = new URL(url); return u.pathname + (u.search ? "?key=…" : ""); } catch { return String(url); }
}

// The endpoint is shown in the UI, so never echo a key that was passed as a
// query parameter back to the browser.
function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const name of ["key", "api_key", "api-key", "access_token", "apiKey"]) {
      if (u.searchParams.has(name)) u.searchParams.set(name, "***");
    }
    return u.toString();
  } catch { return String(url); }
}

function discoveryHeaders(provider) {
  const headers = { Accept: "application/json" };
  if (provider?.headers && typeof provider.headers === "object") {
    for (const [k, v] of Object.entries(provider.headers)) if (typeof v === "string") headers[k] = v;
  }
  return headers;
}

function adapterDiscoveryHeaders(adapter, key) {
  const headers = buildAdapterHeaders(adapter, key || "dummy");
  // buildAdapterHeaders always injects a Bearer token. Drop it so the auth
  // escalation below can pick the right style — unless the adapter declares
  // its own auth header, which we must leave alone.
  const declared = Object.keys(adapter.headers || {}).some(k => AUTH_HEADER_NAMES.includes(k.toLowerCase()));
  if (!declared) delete headers.Authorization;
  return { headers, key: declared ? "" : (key || "") };
}

function normalizeDiscoveredModels(rows, provider) {
  const existing = provider?.models || {};
  const unique = new Map();
  for (const item of rows) {
    const raw = typeof item === "string" ? item : (item?.id ?? item?.model ?? item?.modelId ?? item?.name);
    if (typeof raw !== "string" || !raw.trim()) continue;
    let id = raw.trim();
    // Google's native API returns resource names like "models/gemini-2.5-flash".
    if (/^models\/[^/]+$/.test(id)) id = id.slice("models/".length);
    if (unique.has(id)) continue;
    let name = typeof item === "string" ? id
      : String(item?.displayName || item?.display_name || item?.label || item?.name || id);
    if (name === raw || name.startsWith("models/")) name = id;
    unique.set(id, {
      id,
      name,
      owned_by: typeof item === "object" && item ? String(item.owned_by || item.publisher || item.ownedBy || "") : "",
      description: typeof item === "object" && item?.description ? String(item.description) : ""
    });
  }
  return [...unique.values()]
    .map(m => ({ ...m, alreadyConfigured: Object.prototype.hasOwnProperty.call(existing, m.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function discoveryFailure(tried) {
  // One line per endpoint path — the auth variants are just noise.
  const seen = new Set();
  const summary = [];
  for (const entry of tried) {
    const path = entry.split(" [")[0];
    if (seen.has(path)) continue;
    seen.add(path);
    summary.push(entry);
  }
  return new Error(`Could not load the model list. Tried ${summary.length} endpoint(s): ${summary.join(" · ")}`);
}

async function discover(id, endpointOverride) {
  const p = getProvider(id);
  const settings = { ...(p.settings || {}), ...(p.options || {}) };
  const adapter = getAdapter(id);
  let baseURL, headers, apiKey, timeoutMs;
  if (adapter?.enabled) {
    // The real upstream URL lives in adapters.json; the provider's baseURL in
    // opencode.jsonc points at our local proxy and must never be fetched.
    baseURL = adapter.upstreamBaseURL;
    timeoutMs = adapter.timeoutMs || 120000;
    const built = adapterDiscoveryHeaders(adapter, adapterKeyForServer(adapter, p));
    headers = built.headers;
    apiKey = built.key;
  } else {
    baseURL = settings.baseURL;
    timeoutMs = 15000;
    apiKey = resolveSecret(settings.apiKey);
    headers = discoveryHeaders(p);
  }

  const tried = [];
  for (const url of modelsUrlCandidates(baseURL, endpointOverride)) {
    for (const attempt of authAttempts(url, headers, apiKey)) {
      try {
        const body = await fetchModelsBody(attempt.url, attempt.headers, timeoutMs);
        const rows = modelRowsFromBody(body);
        if (!rows) throw new Error("unrecognized JSON shape");
        const models = normalizeDiscoveredModels(rows, p);
        return { provider: id, endpoint: redactUrl(attempt.url), count: models.length, models };
      } catch (e) {
        tried.push(`${shortEndpoint(attempt.url)} [${attempt.label}] → ${truncate(e.message, 140)}`);
        if (!e.authFailure) break; // wrong path — move on to the next candidate
      }
    }
  }
  throw discoveryFailure(tried);
}

async function testProvider(id) {
  const started = Date.now();
  try {
    const r = await discover(id);
    return { id, ok: true, count: r.count, endpoint: r.endpoint, latencyMs: Date.now() - started };
  } catch (e) {
    let endpoint = "";
    try { endpoint = endpointUrl(providerBaseURL(getProvider(id)), "/v1/models"); } catch { endpoint = ""; }
    return { id, ok: false, count: 0, endpoint, latencyMs: Date.now() - started, error: e.message || "Test failed." };
  }
}
async function checkProviders(ids) {
  const { config } = readConfig();
  const allIds = [...allProviders(config).keys()];
  const targets = Array.isArray(ids) && ids.length ? ids.filter(x => allIds.includes(x)) : allIds;
  const results = await Promise.all(targets.map(t => testProvider(t)));
  const map = new Map(results.map(r => [r.id, r]));
  return allIds.map(id => map.get(id) || { id, ok: false, count: 0, endpoint: "", latencyMs: 0, error: "Provider not found." });
}
function setProviderEnabled(id, enabled) {
  const clean = safeId(String(id || "").trim());
  const { text, config } = readConfig();
  if (!allProviders(config).has(clean)) throw new Error(`Provider "${clean}" not found in config.`);
  let updated = text;
  const disabled = getDisabledSet(config);
  if (enabled) {
    disabled.delete(clean);
  } else {
    disabled.add(clean);
  }
  updated = editText(updated, ["disabled_providers"], [...disabled].sort());
  if (enabled) {
    const enabledList = getEnabledList(config);
    if (enabledList && !enabledList.includes(clean)) {
      updated = editText(updated, ["enabled_providers"], [...enabledList, clean].sort());
    }
  }
  writeConfig(text, updated);
  const next = readConfig().config;
  return { ok: true, provider: clean, disabled: !enabled, effectiveDisabled: isProviderDisabled(next, clean), configPath };
}
function parseHeadersText(headersText) {
  let headers = {};
  if (String(headersText || "").trim()) {
    try { headers = JSON.parse(headersText); } catch { throw new Error("Extra headers must be valid JSON."); }
    if (!headers || Array.isArray(headers) || typeof headers !== "object" ||
        Object.values(headers).some(v => typeof v !== "string")) {
      throw new Error("Extra headers must be a JSON object with string values.");
    }
  }
  return headers;
}
function addProvider(input) {
  const id = safeId(input.id?.trim());
  const name = String(input.name || id).trim();
  const baseURL = String(input.baseURL || "").trim();
  const pkg = String(input.package || input.npm || "@opencode-ai/ai/providers/openai-compatible").trim();
  if (!name) throw new Error("Provider display name is required.");
  if (!pkg) throw new Error("Provider package is required.");
  if (baseURL) {
    let parsed;
    try { parsed = new URL(baseURL); } catch { throw new Error("Base URL must be a valid URL."); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS base URLs are supported.");
  }
  const headers = parseHeadersText(input.headersText);
  const { text, config } = readConfig();
  if (config.provider?.[id] || config.providers?.[id]) throw new Error(`Provider ID "${id}" already exists.`);
  const rootKey = providersRootKey(config);
  let provider;
  if (rootKey === "provider") {
    provider = { name, npm: pkg, options: {} };
    if (baseURL) provider.options.baseURL = baseURL;
  } else {
    provider = { name, package: pkg, settings: {} };
    if (baseURL) provider.settings.baseURL = baseURL;
  }
  const apiKey = String(input.apiKey || "");
  if (apiKey) {
    if (provider.options) provider.options.apiKey = apiKey;
    else provider.settings.apiKey = apiKey;
  }
  if (Object.keys(headers).length) provider.headers = headers;
  const newText = editText(text, [rootKey, id], provider);
  writeConfig(text, newText);
  return { ok: true, provider: id, configPath };
}
function remapIdInList(text, config, key, from, to) {
  const arr = config[key];
  if (!Array.isArray(arr) || !arr.includes(from)) return text;
  const next = [...new Set(arr.map(x => (x === from ? to : x)))].sort();
  return editText(text, [key], next);
}
function updateProvider(input) {
  // Renaming: `originalId` is the key that exists in config right now,
  // `id` is the requested (possibly changed) provider id.
  const originalId = safeId(String(input.originalId || input.id || "").trim());
  const id = safeId(String(input.id || originalId).trim());
  const { text, config } = readConfig();
  const entry = allProviders(config).get(originalId);
  if (!entry) throw new Error(`Provider "${originalId}" not found in config.`);
  const renaming = id !== originalId;
  if (renaming && allProviders(config).has(id)) throw new Error(`Provider ID "${id}" already exists.`);
  const { rootKey, data: existing } = entry;
  let adapters = {};
  let adapterOn = false;
  try { adapters = loadAdapters(); adapterOn = !!adapters[originalId]?.enabled; } catch { adapters = {}; adapterOn = false; }
  let adaptersDirty = false;
  if (adapterOn) {
    // The Base URL field edits the real upstream URL in adapters.json;
    // opencode.jsonc keeps pointing at the derived local proxy URL.
    const newUpstream = String(input.baseURL ?? "").trim();
    if (!newUpstream) throw new Error("Base URL is required. Enter the real upstream URL.");
    if (isLocalProxyUrl(newUpstream)) {
      throw new Error("Enter the real upstream URL, not the local proxy URL. The proxy URL is derived and stays in opencode.jsonc automatically.");
    }
    let parsedUpstream;
    try { parsedUpstream = new URL(newUpstream); }
    catch { throw new Error("Base URL must be a valid URL."); }
    if (!["http:", "https:"].includes(parsedUpstream.protocol)) {
      throw new Error("Only HTTP and HTTPS base URLs are supported.");
    }
    adapters[originalId] = { ...defaultAdapterSettings(), ...adapters[originalId], upstreamBaseURL: newUpstream };
    // The proxy URL is derived from the id, so point the config at the new one.
    input = { ...input, baseURL: proxyBaseURL(id) };
    adaptersDirty = true;
  }
  const name = String(input.name ?? existing.name ?? id).trim();
  if (!name) throw new Error("Provider display name is required.");
  const baseURL = String(input.baseURL ?? providerBaseURL(existing) ?? "").trim();
  const pkg = String(input.package || input.npm || providerPackage(existing)).trim();
  if (!pkg) throw new Error("Provider package is required.");
  if (baseURL) {
    let parsed;
    try { parsed = new URL(baseURL); } catch { throw new Error("Base URL must be a valid URL."); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS base URLs are supported.");
  }
  const headers = parseHeadersText(input.headersText);
  const clearKey = input.clearApiKey === true || input.clearApiKey === "true" || input.clearApiKey === "on";
  const newApiKey = String(input.apiKey || "");
  const updated = { ...existing, name };
  const hadNpm = Object.prototype.hasOwnProperty.call(existing, "npm");
  const hadPkg = Object.prototype.hasOwnProperty.call(existing, "package");
  if (hadNpm && hadPkg) { updated.npm = pkg; updated.package = pkg; }
  else if (hadNpm) { updated.npm = pkg; }
  else if (hadPkg) { updated.package = pkg; }
  else if (rootKey === "provider") { updated.npm = pkg; }
  else { updated.package = pkg; }
  const applyToOpts = (opts) => {
    const next = { ...(opts || {}) };
    if (baseURL) next.baseURL = baseURL;
    else delete next.baseURL;
    if (clearKey) delete next.apiKey;
    else if (newApiKey) next.apiKey = newApiKey;
    return next;
  };
  const hadOptions = existing.options && typeof existing.options === "object" && !Array.isArray(existing.options);
  const hadSettings = existing.settings && typeof existing.settings === "object" && !Array.isArray(existing.settings);
  if (hadOptions && hadSettings) {
    updated.options = applyToOpts(existing.options);
    updated.settings = applyToOpts(existing.settings);
  } else if (hadOptions) {
    updated.options = applyToOpts(existing.options);
  } else if (hadSettings) {
    updated.settings = applyToOpts(existing.settings);
  } else if (rootKey === "provider") {
    updated.options = applyToOpts({});
  } else {
    updated.settings = applyToOpts({});
  }
  if (Object.keys(headers).length) updated.headers = headers;
  else delete updated.headers;

  // A renamed provider moves its adapter settings to the new id too.
  if (renaming && adapters[originalId]) {
    adapters[id] = { ...adapters[originalId] };
    delete adapters[originalId];
    adaptersDirty = true;
  }
  if (adaptersDirty) saveAdaptersFile(adapters);

  let newText;
  if (renaming) {
    newText = editText(text, [rootKey, id], updated);
    newText = editText(newText, [rootKey, originalId], undefined);
    // Keep enable/disable bookkeeping pointing at the renamed provider.
    newText = remapIdInList(newText, config, "disabled_providers", originalId, id);
    newText = remapIdInList(newText, config, "enabled_providers", originalId, id);
  } else {
    newText = editText(text, [rootKey, originalId], updated);
  }
  writeConfig(text, newText);
  return { ok: true, provider: id, renamedFrom: renaming ? originalId : undefined, configPath };
}
function deleteProvider(id) {
  const clean = safeId(String(id || "").trim());
  const { text, config } = readConfig();
  const entry = allProviders(config).get(clean);
  if (!entry) throw new Error(`Provider "${clean}" not found in config.`);
  const newText = editText(text, [entry.rootKey, clean], undefined);
  writeConfig(text, newText);
  return { ok: true, provider: clean, configPath };
}
function saveModels(id, discoveredIds, selectedIds, metadata = {}) {
  if (!Array.isArray(discoveredIds) || !Array.isArray(selectedIds) ||
      [...discoveredIds, ...selectedIds].some(x => typeof x !== "string")) {
    throw new Error("Invalid model selection.");
  }
  const { text, config } = readConfig();
  const entry = allProviders(config).get(id);
  if (!entry) throw new Error(`Provider "${id}" not found in config.`);
  const provider = entry.data;
  const rootKey = entry.rootKey;
  const discovered = [...new Set(discoveredIds)];
  const selected = new Set(selectedIds);
  if ([...selected].some(x => !discovered.includes(x))) throw new Error("Selected models must come from the latest discovery result.");
  let updated = text;
  let modelConfig = { ...(provider.models || {}) };
  for (const modelId of discovered) {
    if (selected.has(modelId)) {
      if (!Object.prototype.hasOwnProperty.call(modelConfig, modelId)) {
        modelConfig[modelId] = { name: String(metadata[modelId]?.name || modelId) };
      } else {
        // Preserve existing metadata but update a missing display name if needed.
        if (!modelConfig[modelId].name) modelConfig[modelId] = { ...modelConfig[modelId], name: String(metadata[modelId]?.name || modelId) };
      }
    } else {
      // Remove only discovered IDs that the user explicitly unchecked. Other models remain untouched.
      delete modelConfig[modelId];
    }
  }
  updated = editText(updated, [rootKey, id, "models"], Object.keys(modelConfig).length ? modelConfig : {});
  writeConfig(text, updated);
  return { ok: true, provider: id, selectedCount: selected.size, discoveredCount: discovered.length, modelCount: Object.keys(modelConfig).length, configPath };
}

function removeDiscoveryPlugin() {
  const { text, config } = readConfig();
  let updated = text;
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const kept = plugins.filter(item => {
    const name = typeof item === "string" ? item : (item?.package || item?.npm || "");
    return !String(name).includes("opencode-models-discovery");
  });
  if (Array.isArray(config.plugins) && kept.length !== plugins.length) {
    updated = editText(updated, ["plugins"], kept);
  }
  for (const [providerId, { rootKey }] of allProviders(config).entries()) {
    updated = editText(updated, [rootKey, providerId, "settings", "modelsDiscovery"], undefined);
    updated = editText(updated, [rootKey, providerId, "options", "modelsDiscovery"], undefined);
  }
  writeConfig(text, updated);
  return { ok: true, removedPluginEntries: plugins.length - kept.length, configPath };
}

/* ---------- request adapters (local OpenAI-compatible proxy) ---------- */

function loadAdapters() {
  if (!fs.existsSync(adaptersPath)) return {};
  let raw;
  try { raw = fs.readFileSync(adaptersPath, "utf8"); }
  catch (e) { throw new Error(`Could not read adapters file: ${e.message}`); }
  if (!raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Could not parse adapters.json. Check its JSON syntax."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("adapters.json must be a JSON object keyed by provider id.");
  }
  return parsed;
}
function saveAdaptersFile(adapters) {
  const tmp = `${adaptersPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(adapters, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, adaptersPath);
}
function getAdapter(providerId) {
  const adapters = loadAdapters();
  const a = adapters[providerId];
  return a && typeof a === "object" ? a : null;
}
function publicAdapter(providerId, adapter) {
  const { storedApiKey, ...rest } = adapter || {};
  return { provider: providerId, hasKey: !!storedApiKey, ...rest };
}
function ahefiPreset() {
  return {
    upstreamBaseURL: "https://ahefi.com/v1",
    headers: {
      "HTTP-Referer": "https://github.com/AhefiVetGit/Ahefi-Ahefi",
      "X-Title": "Ahefi",
      "User-Agent": "Ahefi/1.0.24",
      "X-Stainless-Arch": "x64",
      "X-Stainless-Lang": "js",
      "X-Stainless-OS": "Windows",
      "X-Stainless-Package-Version": "5.12.2",
      "X-Stainless-Retry-Count": "0",
      "X-Stainless-Runtime": "node",
      "X-Ahefi-Mode": "architect"
    },
    dynamicHeaders: {
      "X-Ahefi-Task-ID": "{{uuid}}",
      "X-Stainless-Runtime-Version": "{{node_version}}"
    },
    bodyOverrides: { stream: true, stream_options: { include_usage: true } },
    defaultModel: "deepseek-v4.1-flash",
    timeoutMs: 120000,
    apiKeySource: "incoming"
  };
}
function defaultAdapterSettings() {
  return {
    enabled: false,
    upstreamBaseURL: "",
    originalBaseURL: "",
    headers: {},
    dynamicHeaders: {},
    bodyOverrides: { stream: true, stream_options: { include_usage: true } },
    defaultModel: "",
    timeoutMs: 120000,
    apiKeySource: "incoming",
    storedApiKey: ""
  };
}
function resolveTemplate(value) {
  return String(value)
    .replace(/\{\{uuid\}\}/g, () => crypto.randomUUID())
    .replace(/\{\{node_version\}\}/g, () => process.version)
    .replace(/\{\{timestamp\}\}/g, () => String(Date.now()));
}
function bearerKey(headerValue) {
  if (typeof headerValue !== "string") return "";
  return headerValue.replace(/^Bearer\s+/i, "").trim();
}
function resolveAdapterKey(adapter, incomingAuth) {
  const source = adapter.apiKeySource || "incoming";
  if (source.startsWith("env:")) return process.env[source.slice(4)] || "";
  if (source === "stored") return adapter.storedApiKey || "";
  return bearerKey(incomingAuth);
}
function adapterKeyForServer(adapter, provider) {
  const source = adapter.apiKeySource || "incoming";
  if (source.startsWith("env:")) return process.env[source.slice(4)] || "";
  if (source === "stored") return adapter.storedApiKey || "";
  const settings = { ...(provider.settings || {}), ...(provider.options || {}) };
  return resolveSecret(settings.apiKey);
}
function buildAdapterHeaders(adapter, key) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  for (const [k, v] of Object.entries(adapter.headers || {})) headers[k] = v;
  for (const [k, v] of Object.entries(adapter.dynamicHeaders || {})) headers[k] = resolveTemplate(v);
  return headers;
}
function buildChatBody(adapter, incomingBody) {
  return {
    ...incomingBody,
    model: incomingBody.model || adapter.defaultModel,
    ...(adapter.bodyOverrides || {})
  };
}
function proxyBaseURL(providerId) {
  return `http://127.0.0.1:${PORT}/proxy/${providerId}/v1`;
}
function isProxyBaseURL(value, providerId) {
  return typeof value === "string" && value.includes(`/proxy/${providerId}/`);
}
function isLocalProxyUrl(value) {
  // Any URL pointing at this manager's local proxy routes. Such URLs are
  // derived (written into opencode.jsonc on enable) and must never be stored
  // as a provider's real upstream URL in adapters.json.
  return typeof value === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/proxy\//.test(value.trim());
}
function logProxy(providerId, model, status, latencyMs) {
  console.log(`${new Date().toISOString()} [adapter] provider=${providerId} model=${model || "-"} status=${status} latencyMs=${latencyMs}`);
}
function adapterError(res, status, message, type, code) {
  const body = { error: { message, type, code } };
  if (res.headersSent) {
    try { res.write(`data: ${JSON.stringify(body)}\n\n`); res.end(); } catch { /* client gone */ }
    return;
  }
  sendJson(res, status, body);
}
function asObject(value, field) {
  if (value === undefined || value === null || String(value).trim?.() === "") return {};
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return parsed;
}
function validateAdapterPayload(input) {
  let headers, dynamicHeaders, bodyOverrides;
  try { headers = asObject(input.headers, "headers"); }
  catch { throw new Error("headers must be valid JSON."); }
  try { dynamicHeaders = asObject(input.dynamicHeaders, "dynamicHeaders"); }
  catch { throw new Error("dynamicHeaders must be valid JSON."); }
  try { bodyOverrides = asObject(input.bodyOverrides, "bodyOverrides"); }
  catch { throw new Error("bodyOverrides must be valid JSON."); }
  for (const [k, v] of Object.entries(headers)) {
    if (!k.trim()) throw new Error("headers must not contain empty names.");
    if (typeof v !== "string") throw new Error(`headers["${k}"] must be a string.`);
  }
  for (const [k, v] of Object.entries(dynamicHeaders)) {
    if (!k.trim()) throw new Error("dynamicHeaders must not contain empty names.");
    if (typeof v !== "string") throw new Error(`dynamicHeaders["${k}"] must be a string template.`);
  }
  const upstreamBaseURL = String(input.upstreamBaseURL || "").trim();
  let parsedUrl;
  try { parsedUrl = new URL(upstreamBaseURL); }
  catch { throw new Error("upstreamBaseURL must be a valid URL."); }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("upstreamBaseURL must use http or https.");
  }
  const defaultModel = String(input.defaultModel ?? "").trim();
  const timeoutMs = Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new Error("timeoutMs must be an integer between 1000 and 300000.");
  }
  const apiKeySource = String(input.apiKeySource || "incoming");
  if (apiKeySource !== "incoming" && apiKeySource !== "stored" && !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeySource)) {
    throw new Error('apiKeySource must be "incoming", "stored", or "env:NAME".');
  }
  if (typeof input.enabled !== "boolean") throw new Error("enabled must be true or false.");
  return { headers, dynamicHeaders, bodyOverrides, upstreamBaseURL, defaultModel, timeoutMs, apiKeySource, enabled: input.enabled };
}
function saveAdapterSettings(providerId, input) {
  const id = safeId(String(providerId || "").trim());
  const { text, config } = readConfig();
  const entry = allProviders(config).get(id);
  if (!entry) throw new Error(`Provider "${id}" not found in config.`);
  const adapters = loadAdapters();
  const existing = (adapters[id] && typeof adapters[id] === "object") ? adapters[id] : defaultAdapterSettings();
  const wasEnabled = !!existing.enabled;
  const enabling = input.enabled === true;
  const currentBaseURL = providerBaseURL(entry.data);
  // Heal old data: a proxy URL must never live in these fields.
  let originalBaseURL = isLocalProxyUrl(existing.originalBaseURL) ? "" : (existing.originalBaseURL || "");
  if (enabling && !wasEnabled && !isLocalProxyUrl(currentBaseURL)) {
    originalBaseURL = currentBaseURL;
  }
  let upstream = String(input.upstreamBaseURL ?? "").trim();
  if (isLocalProxyUrl(upstream)) {
    throw new Error("Enter the real upstream URL, not the local proxy URL. Proxy URLs are derived and never stored.");
  }
  if (!upstream && enabling && !wasEnabled) upstream = originalBaseURL;
  if (!upstream) upstream = isLocalProxyUrl(existing.upstreamBaseURL) ? "" : (existing.upstreamBaseURL || "");
  const validated = validateAdapterPayload({ ...input, upstreamBaseURL: upstream });
  let storedApiKey = existing.storedApiKey || "";
  if (input.clearStoredKey === true || input.clearStoredKey === "true") storedApiKey = "";
  else if (typeof input.storedApiKey === "string" && input.storedApiKey !== "") storedApiKey = input.storedApiKey;
  adapters[id] = { ...validated, storedApiKey, originalBaseURL };
  saveAdaptersFile(adapters);
  if (validated.enabled && !wasEnabled) {
    const proxyURL = proxyBaseURL(id);
    let updated = text;
    const optsKey = entry.data.options && typeof entry.data.options === "object" ? "options" : "settings";
    const settings = { ...(entry.data[optsKey] || {}) };
    settings.baseURL = proxyURL;
    if (!resolveSecret(settings.apiKey)) settings.apiKey = "dummy";
    const next = { ...entry.data, [optsKey]: settings };
    if (!next.options && !next.settings) {
      next[entry.rootKey === "provider" ? "options" : "settings"] = settings;
    }
    updated = editText(updated, [entry.rootKey, id], next);
    writeConfig(text, updated);
  } else if (!validated.enabled && wasEnabled && isProxyBaseURL(currentBaseURL, id)) {
    // Restore the pre-adapter URL. validated.upstreamBaseURL is always a real
    // URL here, so there is always something sane to restore.
    const restoreTo = originalBaseURL || validated.upstreamBaseURL;
    let updated = text;
    const optsKey = entry.data.options && typeof entry.data.options === "object" ? "options" : "settings";
    const settings = { ...(entry.data[optsKey] || {}) };
    settings.baseURL = restoreTo;
    const next = { ...entry.data, [optsKey]: settings };
    updated = editText(updated, [entry.rootKey, id], next);
    writeConfig(text, updated);
  }
  return { ok: true, adapter: publicAdapter(id, adapters[id]), configPath, proxyUrl: proxyBaseURL(id) };
}
function readProxyBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Request body too large.")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function aggregateSse(sseText, model) {
  let content = "";
  const toolCalls = new Map();
  let finishReason = null;
  let usage;
  let id = "";
  let created = Math.floor(Date.now() / 1000);
  for (const line of String(sseText).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    const choice = chunk.choices?.[0];
    if (!choice) {
      if (chunk.usage) usage = chunk.usage;
      continue;
    }
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = toolCalls.get(idx) || { index: idx, function: { name: "", arguments: "" } };
      if (tc.id) cur.id = tc.id;
      if (tc.type) cur.type = tc.type;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") cur.function.arguments += tc.function.arguments;
      toolCalls.set(idx, cur);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  const message = { role: "assistant", content };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.values()].map(tc => ({
      id: tc.id, type: tc.type || "function", function: tc.function
    }));
  }
  const out = {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || "stop" }]
  };
  if (usage) out.usage = usage;
  return out;
}
async function fetchChatUpstream(adapter, key, body) {
  const url = adapter.upstreamBaseURL.replace(/\/$/, "") + "/chat/completions";
  const headers = buildAdapterHeaders(adapter, key);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), adapter.timeoutMs || 120000);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abort.signal
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Upstream timed out after ${adapter.timeoutMs || 120000}ms.`);
    throw new Error(`Could not reach upstream: ${e.message}`);
  } finally { clearTimeout(timeout); }
}
async function upstreamErrorBody(response) {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    const err = parsed?.error || {};
    return {
      message: err.message || text.slice(0, 300) || `Upstream HTTP ${response.status}`,
      type: err.type || "proxy_error"
    };
  } catch {
    return { message: text.slice(0, 300) || `Upstream HTTP ${response.status}`, type: "proxy_error" };
  }
}
async function handleProxyChat(req, res, providerId) {
  const started = Date.now();
  const adapter = getAdapter(providerId);
  if (!adapter?.enabled) {
    return adapterError(res, 404, `No enabled adapter for provider "${providerId}"`, "invalid_request_error", 404);
  }
  let raw;
  try { raw = await readProxyBody(req); }
  catch (e) { return adapterError(res, 400, e.message, "invalid_request_error", 400); }
  let incoming;
  try { incoming = JSON.parse(raw.toString("utf8") || "{}"); }
  catch { return adapterError(res, 400, "Invalid request body: not valid JSON", "invalid_request_error", 400); }
  if (!incoming || !Array.isArray(incoming.messages)) {
    return adapterError(res, 400, "Invalid request body: missing messages", "invalid_request_error", 400);
  }
  const key = resolveAdapterKey(adapter, req.headers.authorization);
  if (!key || key === "dummy") {
    return adapterError(res, 401, "Missing API key", "authentication_error", 401);
  }
  const body = buildChatBody(adapter, incoming);
  const clientWantsJson = incoming.stream === false;
  let upstream;
  try {
    upstream = await fetchChatUpstream(adapter, key, body);
  } catch (e) {
    logProxy(providerId, body.model, 500, Date.now() - started);
    return adapterError(res, 500, e.message, "proxy_error", 500);
  }
  if (!upstream.ok) {
    const err = await upstreamErrorBody(upstream);
    logProxy(providerId, body.model, upstream.status, Date.now() - started);
    return adapterError(res, upstream.status, err.message, err.type, upstream.status);
  }
  if (clientWantsJson) {
    let text;
    try { text = await upstream.text(); }
    catch (e) {
      logProxy(providerId, body.model, 500, Date.now() - started);
      return adapterError(res, 500, e.message, "proxy_error", 500);
    }
    logProxy(providerId, body.model, 200, Date.now() - started);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(aggregateSse(text, body.model)));
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const abortClient = () => { try { upstream.body?.cancel?.(); } catch { /* ignore */ } };
  req.on("close", abortClient);
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (e) {
    logProxy(providerId, body.model, 500, Date.now() - started);
    return adapterError(res, 500, e.message || "Streaming failed", "proxy_error", 500);
  } finally {
    req.off?.("close", abortClient);
  }
  res.write("data: [DONE]\n\n");
  res.end();
  logProxy(providerId, body.model, 200, Date.now() - started);
}
async function handleProxyModels(req, res, providerId) {
  const started = Date.now();
  const adapter = getAdapter(providerId);
  if (!adapter?.enabled) {
    return adapterError(res, 404, `No enabled adapter for provider "${providerId}"`, "invalid_request_error", 404);
  }
  const key = resolveAdapterKey(adapter, req.headers.authorization);
  if (!key || key === "dummy") {
    return adapterError(res, 401, "Missing API key", "authentication_error", 401);
  }
  const timeoutMs = adapter.timeoutMs || 120000;
  let candidates;
  try { candidates = modelsUrlCandidates(adapter.upstreamBaseURL); }
  catch (e) {
    logProxy(providerId, "-", 500, Date.now() - started);
    return adapterError(res, 500, e.message, "proxy_error", 500);
  }
  const built = adapterDiscoveryHeaders(adapter, key);
  let payload = null;
  let failure = null;
  for (const url of candidates) {
    for (const attempt of authAttempts(url, built.headers, built.key)) {
      try {
        const body = await fetchModelsBody(attempt.url, attempt.headers, timeoutMs);
        if (!modelRowsFromBody(body)) throw new Error("Upstream did not return a model list.");
        payload = JSON.stringify(body);
        break;
      } catch (e) {
        failure = e;
        if (!e.authFailure) break; // wrong path — try the next candidate
      }
    }
    if (payload) break;
  }
  if (!payload) {
    const status = failure?.status >= 400 ? failure.status : 502;
    logProxy(providerId, "-", status, Date.now() - started);
    return adapterError(res, status, failure?.message || "Could not load the upstream model list.", "proxy_error", status);
  }
  logProxy(providerId, "-", 200, Date.now() - started);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}
async function testAdapterChat(providerId) {
  const started = Date.now();
  const { config } = readConfig();
  const entry = allProviders(config).get(providerId);
  if (!entry) return { ok: false, status: 404, reply: "", error: `Provider "${providerId}" not found.` };
  const adapter = getAdapter(providerId);
  if (!adapter?.enabled) {
    return { ok: false, status: 404, reply: "", error: `No enabled adapter for provider "${providerId}".` };
  }
  const key = adapterKeyForServer(adapter, entry.data);
  if (!key || key === "dummy") {
    return { ok: false, status: 401, reply: "", error: "Missing API key", latencyMs: Date.now() - started };
  }
  const body = buildChatBody(adapter, { messages: [{ role: "user", content: "hi" }] });
  let upstream;
  try {
    upstream = await fetchChatUpstream(adapter, key, body);
  } catch (e) {
    return { ok: false, status: 500, reply: "", error: e.message, latencyMs: Date.now() - started };
  }
  if (!upstream.ok) {
    const err = await upstreamErrorBody(upstream);
    logProxy(providerId, body.model, upstream.status, Date.now() - started);
    return { ok: false, status: upstream.status, reply: "", error: err.message, latencyMs: Date.now() - started };
  }
  let text;
  try { text = await upstream.text(); }
  catch (e) {
    return { ok: false, status: 500, reply: "", error: e.message, latencyMs: Date.now() - started };
  }
  const agg = aggregateSse(text, body.model);
  logProxy(providerId, body.model, 200, Date.now() - started);
  return {
    ok: true,
    status: 200,
    reply: agg.choices?.[0]?.message?.content ?? "",
    usage: agg.usage,
    latencyMs: Date.now() - started,
    error: ""
  };
}

/* ---------- end request adapters ---------- */

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; if (data.length > 2_000_000) { reject(new Error("Request body too large.")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("Invalid JSON request.")); } });
    req.on("error", reject);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/api/status") {
      const { config } = readConfig();
      return sendJson(res, 200, {
        ok: true, configPath, providerCount: allProviders(config).size, pluginRequired: false,
        pluginPresent: Array.isArray(config.plugins) && config.plugins.some(x => (typeof x === "string" ? x : x?.package || "").includes("opencode-models-discovery"))
      });
    }
    if (req.method === "GET" && url.pathname === "/api/providers") {
      const single = url.searchParams.get("provider");
      if (single) return sendJson(res, 200, { provider: getProviderDetails(single) });
      return sendJson(res, 200, { providers: getProviders() });
    }
    if (req.method === "POST" && url.pathname === "/api/disable-discovery-plugin") {
      return sendJson(res, 200, removeDiscoveryPlugin());
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      const id = url.searchParams.get("provider");
      if (!id) return sendJson(res, 400, { error: "Missing provider query parameter." });
      return sendJson(res, 200, await discover(id, url.searchParams.get("endpoint") || undefined));
    }
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
    if (req.method === "GET" && url.pathname === "/api/adapters/preset") {
      return sendJson(res, 200, { preset: ahefiPreset() });
    }
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
    if (req.method === "POST" && url.pathname === "/api/providers/test-chat") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      return sendJson(res, 200, await testAdapterChat(body.provider));
    }
    {
      const proxyMatch = url.pathname.match(/^\/proxy\/([^/]+)\/v1\/(chat\/completions|models)$/);
      if (proxyMatch) {
        const providerId = decodeURIComponent(proxyMatch[1]);
        if (proxyMatch[2] === "chat/completions") {
          if (req.method !== "POST") {
            return sendJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error", code: 405 } });
          }
          return await handleProxyChat(req, res, providerId);
        }
        if (req.method !== "GET") {
          return sendJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error", code: 405 } });
        }
        return await handleProxyModels(req, res, providerId);
      }
    }
    if (req.method === "PUT" && url.pathname === "/api/providers") {
      return sendJson(res, 200, updateProvider(await readBody(req)));
    }
    if (req.method === "DELETE" && url.pathname === "/api/providers") {
      const id = url.searchParams.get("provider");
      if (!id) return sendJson(res, 400, { error: "Missing provider query parameter." });
      return sendJson(res, 200, deleteProvider(id));
    }
    if (req.method === "POST" && url.pathname === "/api/models/save") {
      const body = await readBody(req);
      if (typeof body.provider !== "string") return sendJson(res, 400, { error: "Missing provider." });
      return sendJson(res, 200, saveModels(body.provider, body.discoveredIds, body.selectedIds, body.metadata || {}));
    }
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
  } catch (e) { return sendJson(res, 500, { error: e.message || "Unexpected error." }); }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenCode Model Manager running at http://127.0.0.1:${PORT}`);
  console.log(`Config: ${configPath}`);
  console.log("Direct registration mode: no discovery plugin required. Localhost only. Press Ctrl+C to stop.");
});
