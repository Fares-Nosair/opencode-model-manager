import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";

const __dirname = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8765);
const defaultConfig = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
export function getConfigPath() {
  return process.env.OPENCODE_CONFIG || defaultConfig;
}
const configPath = process.env.OPENCODE_CONFIG || defaultConfig;
const adaptersPath = process.env.ADAPTERS_FILE || path.join(__dirname, "adapters.json");

export { PORT, defaultConfig, configPath, adaptersPath };

export function readConfig() {
  const currentPath = getConfigPath();
  if (!fs.existsSync(currentPath)) throw new Error(`Config file not found: ${currentPath}`);
  const text = fs.readFileSync(currentPath, "utf8");
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error("Could not parse opencode.jsonc. Check its JSON/JSONC syntax.");
  return { text, config: config || {} };
}

export function editText(text, segments, value) {
  return applyEdits(text, modify(text, segments, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
  }));
}

/* ---- Rolling backup system ---- */

function backupsDir() {
  return path.join(path.dirname(getConfigPath()), ".backups");
}

export function createBackup() {
  const currentPath = getConfigPath();
  if (!fs.existsSync(currentPath)) return;
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const ts = now.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
  const dest = path.join(dir, `opencode.jsonc.${ts}.bak`);
  fs.copyFileSync(currentPath, dest);
  // Keep only the last 5 backups
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith("opencode.jsonc.") && f.endsWith(".bak"))
    .sort()
    .reverse();
  for (const old of files.slice(5)) {
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
  }
}

export function listBackups() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith("opencode.jsonc.") && f.endsWith(".bak"))
    .map(filename => {
      const full = path.join(dir, filename);
      let stat;
      try { stat = fs.statSync(full); } catch { return null; }
      const tsMatch = filename.match(/opencode\.jsonc\.(.+)\.bak$/);
      let timestamp = "";
      if (tsMatch) {
        const raw = tsMatch[1];
        timestamp = raw.replace(/-(\d{2})-(\d{2})-(\d{2})$/, (_, h, m, s) => `${h}:${m}:${s}`);
      }
      return { filename, timestamp, size: stat.size };
    })
    .filter(Boolean)
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

export function restoreBackup(filename) {
  if (typeof filename !== "string" || !filename.startsWith("opencode.jsonc.") || !filename.endsWith(".bak")) {
    throw new Error("Invalid backup filename.");
  }
  const dir = backupsDir();
  const src = path.join(dir, filename);
  if (!fs.existsSync(src)) throw new Error(`Backup file not found: ${filename}`);
  const text = fs.readFileSync(src, "utf8");
  const errors = [];
  parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error("Backup file contains invalid JSONC and cannot be restored.");
  try { createBackup(); } catch { /* best effort */ }
  const currentPath = getConfigPath();
  const tmp = `${currentPath}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, currentPath);
  return { ok: true, restored: filename, configPath: currentPath };
}

export function writeConfig(oldText, newText) {
  if (oldText === newText) return false;
  try { createBackup(); } catch { /* best effort */ }
  const currentPath = getConfigPath();
  const tmp = `${currentPath}.tmp`;
  fs.writeFileSync(tmp, newText, "utf8");
  fs.renameSync(tmp, currentPath);
  return true;
}

export function safeId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Provider ID must start with a letter/number and contain only letters, numbers, dots, underscores, or hyphens (max 64 characters).");
  }
  return id;
}

export function providersRootKey(config) {
  if (config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)) return "provider";
  if (config.providers && typeof config.providers === "object" && !Array.isArray(config.providers)) return "providers";
  return "provider";
}

export function allProviders(config) {
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

export function providerBaseURL(p) {
  return p?.options?.baseURL || p?.settings?.baseURL || "";
}

export function providerPackage(p) {
  return p?.npm || p?.package || "@opencode-ai/ai/providers/openai-compatible";
}

export function providerApiKeyRaw(p) {
  return p?.options?.apiKey ?? p?.settings?.apiKey ?? "";
}

export function getDisabledSet(config) {
  const arr = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
  return new Set(arr.filter(x => typeof x === "string"));
}

export function getEnabledList(config) {
  if (!Array.isArray(config.enabled_providers)) return null;
  return config.enabled_providers.filter(x => typeof x === "string");
}

export function isProviderDisabled(config, id) {
  const disabled = getDisabledSet(config);
  if (disabled.has(id)) return true;
  const enabled = getEnabledList(config);
  if (enabled && !enabled.includes(id)) return true;
  return false;
}

export function resolveSecret(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ||
                value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match ? (process.env[match[1]] || "") : value;
}

export function proxyBaseURL(providerId) {
  return `http://127.0.0.1:${PORT}/proxy/${providerId}/v1`;
}

export function isProxyBaseURL(value, providerId) {
  return typeof value === "string" && value.includes(`/proxy/${providerId}/`);
}

export function isLocalProxyUrl(value) {
  return typeof value === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/proxy\//.test(value.trim());
}

export function loadAdapters() {
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

export function saveAdaptersFile(adapters) {
  const tmp = `${adaptersPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(adapters, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, adaptersPath);
}

export function getAdapter(providerId) {
  const adapters = loadAdapters();
  const a = adapters[providerId];
  return a && typeof a === "object" ? a : null;
}

export function publicAdapter(providerId, adapter) {
  const { storedApiKey, ...rest } = adapter || {};
  return { provider: providerId, hasKey: !!storedApiKey, ...rest };
}

export function defaultAdapterSettings() {
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

export function asObject(value, field) {
  if (value === undefined || value === null || String(value).trim?.() === "") return {};
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return parsed;
}

export function validateAdapterPayload(input) {
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

export function saveAdapterSettings(providerId, input) {
  const id = safeId(String(providerId || "").trim());
  const { text, config } = readConfig();
  const entry = allProviders(config).get(id);
  if (!entry) throw new Error(`Provider "${id}" not found in config.`);
  const adapters = loadAdapters();
  const existing = (adapters[id] && typeof adapters[id] === "object") ? adapters[id] : defaultAdapterSettings();
  const wasEnabled = !!existing.enabled;
  const enabling = input.enabled === true;
  const currentBaseURL = providerBaseURL(entry.data);
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

export function getProviders() {
  const { config } = readConfig();
  let adapterStates = {};
  try { adapterStates = loadAdapters(); } catch { adapterStates = {}; }
  return [...allProviders(config).entries()].map(([id, { data: p }]) => {
    const adapterOn = !!adapterStates[id]?.enabled;
    const upstream = adapterOn ? String(adapterStates[id].upstreamBaseURL || "") : "";
    return {
      id, name: p?.name || id,
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

export function getProviderEntry(id) {
  const { config } = readConfig();
  const entry = allProviders(config).get(id);
  if (!entry) throw new Error(`Provider "${id}" not found in config.`);
  return entry;
}

export function getProvider(id) {
  return getProviderEntry(id).data;
}

export function getProviderDetails(id) {
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

export function setProviderEnabled(id, enabled) {
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

export function parseHeadersText(headersText) {
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

export function addProvider(input) {
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

export function remapIdInList(text, config, key, from, to) {
  const arr = config[key];
  if (!Array.isArray(arr) || !arr.includes(from)) return text;
  const next = [...new Set(arr.map(x => (x === from ? to : x)))].sort();
  return editText(text, [key], next);
}

export function updateProvider(input) {
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
    newText = remapIdInList(newText, config, "disabled_providers", originalId, id);
    newText = remapIdInList(newText, config, "enabled_providers", originalId, id);
  } else {
    newText = editText(text, [rootKey, originalId], updated);
  }
  writeConfig(text, newText);
  return { ok: true, provider: id, renamedFrom: renaming ? originalId : undefined, configPath };
}

export function deleteProvider(id) {
  const clean = safeId(String(id || "").trim());
  const { text, config } = readConfig();
  const entry = allProviders(config).get(clean);
  if (!entry) throw new Error(`Provider "${clean}" not found in config.`);
  const newText = editText(text, [entry.rootKey, clean], undefined);
  writeConfig(text, newText);
  return { ok: true, provider: clean, configPath };
}

export function pruneRemovedModels(id, activeDiscoveredIds) {
  const { text, config } = readConfig();
  const entry = allProviders(config).get(id);
  if (!entry) return { ok: false, pruned: [] };
  const provider = entry.data;
  const existingModels = provider.models || {};
  const activeSet = new Set(activeDiscoveredIds);
  const removed = Object.keys(existingModels).filter(k => !activeSet.has(k));
  if (!removed.length) return { ok: true, pruned: [], provider: id, remainingCount: Object.keys(existingModels).length };

  let modelConfig = { ...existingModels };
  for (const k of removed) {
    delete modelConfig[k];
  }
  const updated = editText(text, [entry.rootKey, id, "models"], Object.keys(modelConfig).length ? modelConfig : {});
  writeConfig(text, updated);
  return { ok: true, pruned: removed, provider: id, remainingCount: Object.keys(modelConfig).length };
}

export function saveModels(id, discoveredIds, selectedIds, metadata = {}, pruneRemoved = true) {
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

  // By default, if a provider removed models (not returned in latest discovery), remove them from config
  if (pruneRemoved) {
    for (const modelId of Object.keys(modelConfig)) {
      if (!discovered.includes(modelId)) {
        delete modelConfig[modelId];
      }
    }
  }

  for (const modelId of discovered) {
    if (selected.has(modelId)) {
      if (!Object.prototype.hasOwnProperty.call(modelConfig, modelId)) {
        modelConfig[modelId] = { name: String(metadata[modelId]?.name || modelId) };
      } else {
        if (!modelConfig[modelId].name) modelConfig[modelId] = { ...modelConfig[modelId], name: String(metadata[modelId]?.name || modelId) };
      }
    } else {
      delete modelConfig[modelId];
    }
  }
  updated = editText(updated, [rootKey, id, "models"], Object.keys(modelConfig).length ? modelConfig : {});
  writeConfig(text, updated);
  return { ok: true, provider: id, selectedCount: selected.size, discoveredCount: discovered.length, modelCount: Object.keys(modelConfig).length, configPath };
}

export function removeDiscoveryPlugin() {
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

/* ---- Export and Import ---- */

export function exportConfig() {
  const { config } = readConfig();
  const rootKey = providersRootKey(config);
  const providersObj = config[rootKey] || {};
  let adapters = {};
  try { adapters = loadAdapters(); } catch { adapters = {}; }
  return {
    version: 4,
    exportedAt: new Date().toISOString(),
    rootKey,
    providers: providersObj,
    disabled_providers: config.disabled_providers || [],
    enabled_providers: config.enabled_providers || [],
    adapters
  };
}

export function importConfig(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid import data: must be a JSON object.");
  }
  const { text, config } = readConfig();
  const rootKey = providersRootKey(config);
  let updated = text;
  let importedProviders = 0;
  let importedAdapters = 0;

  const incomingProviders = payload.providers || payload.provider || {};
  if (typeof incomingProviders === "object" && !Array.isArray(incomingProviders)) {
    const currentBucket = config[rootKey] || {};
    const mergedProviders = { ...currentBucket, ...incomingProviders };
    updated = editText(updated, [rootKey], mergedProviders);
    importedProviders = Object.keys(incomingProviders).length;
  }

  if (Array.isArray(payload.disabled_providers)) {
    const existingDisabled = getDisabledSet(config);
    for (const id of payload.disabled_providers) {
      if (typeof id === "string") existingDisabled.add(id);
    }
    updated = editText(updated, ["disabled_providers"], [...existingDisabled].sort());
  }

  writeConfig(text, updated);

  if (payload.adapters && typeof payload.adapters === "object" && !Array.isArray(payload.adapters)) {
    const currentAdapters = loadAdapters();
    const mergedAdapters = { ...currentAdapters, ...payload.adapters };
    saveAdaptersFile(mergedAdapters);
    importedAdapters = Object.keys(payload.adapters).length;
  }

  return { ok: true, importedProviders, importedAdapters, configPath };
}
