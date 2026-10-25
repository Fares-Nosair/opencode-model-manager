import {
  getProvider,
  providerBaseURL,
  providerApiKeyRaw,
  resolveSecret,
  readConfig,
  allProviders,
  getAdapter,
  pruneRemovedModels
} from "./config.mjs";
import {
  adapterDiscoveryHeaders,
  adapterKeyForServer,
  aggregateSse
} from "./proxy.mjs";

const VERSION_SEGMENT = /^v\d+[a-z0-9.]*$/i;
const AUTH_HEADER_NAMES = ["authorization", "x-goog-api-key", "x-api-key", "api-key", "x-goog-key"];

export function uniqueList(list) { return [...new Set(list)]; }

export function modelsUrlCandidates(baseURL, endpointOverride) {
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

export function endpointUrl(baseURL, endpoint) {
  return modelsUrlCandidates(baseURL, endpoint)[0];
}

export function modelRowsFromBody(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  for (const key of ["data", "models", "items"]) if (Array.isArray(body[key])) return body[key];
  return null;
}

export async function fetchModelsBody(url, headers, timeoutMs) {
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
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || "";
    } catch {
      if (text && /<html|<head|<body/i.test(text)) {
        const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
        detail = titleMatch ? titleMatch[1].trim() : `HTTP ${response.status} (HTML error page)`;
      } else {
        detail = String(text).slice(0, 200);
      }
    }
    const err = new Error(detail || (response.status === 404 ? "HTTP 404 (no model list here)" : `HTTP ${response.status}`));
    err.status = response.status;
    err.authFailure = response.status === 401 || response.status === 403;
    throw err;
  }
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error("response was not JSON"); }
}

export function authAttempts(url, headers, apiKey) {
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

export function shortEndpoint(url) {
  try { const u = new URL(url); return u.pathname + (u.search ? "?key=…" : ""); } catch { return String(url); }
}

export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const name of ["key", "api_key", "api-key", "access_token", "apiKey"]) {
      if (u.searchParams.has(name)) u.searchParams.set(name, "***");
    }
    return u.toString();
  } catch { return String(url); }
}

export function discoveryHeaders(provider) {
  const headers = { Accept: "application/json" };
  if (provider?.headers && typeof provider.headers === "object") {
    for (const [k, v] of Object.entries(provider.headers)) if (typeof v === "string") headers[k] = v;
  }
  return headers;
}

export function inferCapabilities(id, item = {}) {
  const lower = `${id} ${item?.name || ""} ${item?.description || ""}`.toLowerCase();
  const tags = [];
  const isEmbedding = /\b(embed|embedding|bge|text-embedding)\b/i.test(lower);
  const isReasoning = /\b(r1|o1|o3|qwq|deepseek-r1|reasoning|thinking)\b/i.test(lower) || id.toLowerCase().includes("-r1");
  const isVision = /\b(vision|vl|4o|gemini|claude-3|pixtral|llava)\b/i.test(lower);
  const isTools = !isEmbedding && /\b(chat|instruct|gpt|claude|gemini|qwen|deepseek|llama|mistral|command)\b/i.test(lower);

  if (isEmbedding) tags.push("EMBED");
  if (isReasoning) tags.push("REASONING");
  if (isVision) tags.push("VISION");
  if (isTools) tags.push("TOOLS");

  return {
    tags,
    capabilities: {
      reasoning: isReasoning,
      vision: isVision,
      tools: isTools,
      embedding: isEmbedding
    }
  };
}

export function normalizeDiscoveredModels(rows, provider) {
  const existing = provider?.models || {};
  const unique = new Map();
  for (const item of rows) {
    const raw = typeof item === "string" ? item : (item?.id ?? item?.model ?? item?.modelId ?? item?.name);
    if (typeof raw !== "string" || !raw.trim()) continue;
    let id = raw.trim();
    if (/^models\/[^/]+$/.test(id)) id = id.slice("models/".length);
    if (unique.has(id)) continue;
    let name = typeof item === "string" ? id
      : String(item?.displayName || item?.display_name || item?.label || item?.name || id);
    if (name === raw || name.startsWith("models/")) name = id;
    const { tags, capabilities } = inferCapabilities(id, item);
    unique.set(id, {
      id,
      name,
      owned_by: typeof item === "object" && item ? String(item.owned_by || item.publisher || item.ownedBy || "") : "",
      description: typeof item === "object" && item?.description ? String(item.description) : "",
      tags,
      capabilities
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

export async function discover(id, endpointOverride) {
  const p = getProvider(id);
  const settings = { ...(p.settings || {}), ...(p.options || {}) };
  const adapter = getAdapter(id);
  let baseURL, headers, apiKey, timeoutMs;
  if (adapter?.enabled) {
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
        const pruneRes = pruneRemovedModels(id, models.map(m => m.id));
        const pruned = pruneRes?.pruned || [];
        return { provider: id, endpoint: redactUrl(attempt.url), count: models.length, models, pruned };
      } catch (e) {
        tried.push(`${shortEndpoint(attempt.url)} [${attempt.label}] → ${truncate(e.message, 140)}`);
        if (!e.authFailure) break;
      }
    }
  }
  throw discoveryFailure(tried);
}

export async function testProvider(id) {
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

export async function checkProviders(ids) {
  const { config } = readConfig();
  const allIds = [...allProviders(config).keys()];
  const targets = Array.isArray(ids) && ids.length ? ids.filter(x => allIds.includes(x)) : allIds;
  const results = await Promise.all(targets.map(t => testProvider(t)));
  const map = new Map(results.map(r => [r.id, r]));
  return allIds.map(id => map.get(id) || { id, ok: false, count: 0, endpoint: "", latencyMs: 0, error: "Provider not found." });
}

/* ---- Direct Provider Chat Completion Test (without adapter) ---- */

export async function testProviderCompletion(id, modelId = null) {
  const result = await testModelChat({ provider: id, model: modelId, prompt: "hi", maxTokens: 15 });
  return {
    ok: result.ok,
    status: result.status,
    reply: result.reply,
    error: result.error,
    latencyMs: result.latencyMs,
    model: result.model
  };
}

export function extractReasoningAndContent(rawText, messageObj = null) {
  let reply = messageObj?.content ?? (typeof rawText === "string" ? rawText : "");
  let reasoning = messageObj?.reasoning_content || messageObj?.reasoning || messageObj?.thought || null;

  if (typeof reply === "string") {
    const thinkMatch = reply.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      if (!reasoning) reasoning = thinkMatch[1].trim();
      reply = reply.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
    }
  }

  return {
    reply: typeof reply === "string" ? reply.trim() : "",
    reasoning: reasoning ? String(reasoning).trim() : null
  };
}

export async function testModelChat({ provider, model, prompt, maxTokens = 150 }) {
  const started = Date.now();
  let p;
  try {
    p = getProvider(provider);
  } catch (e) {
    return { ok: false, status: 404, reply: "", reasoning: null, error: e.message || `Provider ${provider} not found`, latencyMs: 0, model, provider };
  }

  const adapter = getAdapter(provider);
  let baseURL, headers, apiKey;

  if (adapter?.enabled && adapter.upstreamBaseURL) {
    baseURL = adapter.upstreamBaseURL;
    const built = adapterDiscoveryHeaders(adapter, adapterKeyForServer(adapter, p));
    headers = { ...built.headers, "Content-Type": "application/json" };
    if (built.key && !Object.keys(headers).some(k => AUTH_HEADER_NAMES.includes(k.toLowerCase()))) {
      headers.Authorization = `Bearer ${built.key}`;
    }
  } else {
    baseURL = providerBaseURL(p);
    if (!baseURL) {
      return { ok: false, status: 400, reply: "", reasoning: null, error: "Provider has no baseURL configured.", latencyMs: 0, model, provider };
    }
    const apiKeyRaw = providerApiKeyRaw(p);
    apiKey = resolveSecret(apiKeyRaw);
    headers = { "Content-Type": "application/json", ...discoveryHeaders(p) };
    if (apiKey && !Object.keys(headers).some(k => AUTH_HEADER_NAMES.includes(k.toLowerCase()))) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  let base;
  try {
    base = new URL(baseURL);
  } catch {
    return { ok: false, status: 400, reply: "", reasoning: null, error: "Provider baseURL is not a valid URL.", latencyMs: 0, model, provider };
  }

  const targetModel = model || Object.keys(p?.models || {})[0] || "gpt-3.5-turbo";
  const pathClean = base.pathname.replace(/\/+$/, "");
  const chatUrl = `${base.origin}${pathClean}/chat/completions`;

  const abort = new AbortController();
  const timeoutMs = 25000;
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: "user", content: prompt || "Say hello and describe yourself in 1-2 sentences." }],
        max_tokens: Number(maxTokens) || 150
      }),
      signal: abort.signal
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let errMsg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        errMsg = parsed?.error?.message || parsed?.message || errMsg;
      } catch {
        if (text && /<html|<head|<body/i.test(text)) {
          const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
          errMsg = titleMatch ? titleMatch[1].trim() : `HTTP ${res.status} (HTML error page)`;
        } else if (text) {
          errMsg = text.slice(0, 200);
        }
      }
      return { ok: false, status: res.status, reply: "", reasoning: null, error: errMsg, latencyMs, model: targetModel, provider };
    }

    const text = await res.text();
    let messageObj = null;
    try {
      const parsed = JSON.parse(text);
      messageObj = parsed?.choices?.[0]?.message || null;
    } catch {
      // Possible SSE stream returned
      const agg = aggregateSse(text, targetModel);
      messageObj = agg?.choices?.[0]?.message || null;
    }

    const { reply, reasoning } = extractReasoningAndContent(messageObj?.content || text.slice(0, 200), messageObj);
    return {
      ok: true,
      status: 200,
      reply,
      reasoning,
      latencyMs,
      model: targetModel,
      provider
    };
  } catch (e) {
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    const msg = e.name === "AbortError" ? "Request timed out after 25s" : (e.message || "Failed to reach provider");
    return { ok: false, status: 500, reply: "", reasoning: null, error: msg, latencyMs, model: targetModel, provider };
  }
}

export async function runModelBenchmark({ models = [], prompt = "Respond with 'PONG' in 1 word." } = {}) {
  let targets = Array.isArray(models) && models.length ? [...models] : [];

  if (!targets.length) {
    const { config } = readConfig();
    const providers = allProviders(config);
    const disabled = new Set(Array.isArray(config.disabled_providers) ? config.disabled_providers : []);

    for (const [pid, entry] of providers.entries()) {
      if (disabled.has(pid)) continue;
      const p = entry.data || entry;
      const modelKeys = Object.keys(p.models || {});
      for (const mId of modelKeys.slice(0, 2)) {
        targets.push({ provider: pid, model: mId });
        if (targets.length >= 16) break;
      }
      if (targets.length >= 16) break;
    }
  }

  if (!targets.length) {
    return { ok: false, error: "No configured models found to benchmark. Please configure at least one model." };
  }

  // Execute in parallel
  const results = await Promise.all(
    targets.map(t => testModelChat({
      provider: t.provider,
      model: t.model,
      prompt,
      maxTokens: 10
    }))
  );

  // Sort: OK first by latencyMs ascending, then failed by latencyMs ascending
  results.sort((a, b) => {
    if (a.ok && !b.ok) return -1;
    if (!a.ok && b.ok) return 1;
    return a.latencyMs - b.latencyMs;
  });

  const fastest = results.find(r => r.ok) || null;
  return {
    ok: true,
    count: results.length,
    fastest,
    results
  };
}

export async function discoverBatch(providerIds = []) {
  if (!Array.isArray(providerIds) || !providerIds.length) {
    return { results: [], failures: [] };
  }

  const outcomes = await Promise.all(
    providerIds.map(async id => {
      try {
        const r = await discover(id);
        return { provider: id, ok: true, ...r };
      } catch (e) {
        return { provider: id, ok: false, error: e.message || "Discovery failed" };
      }
    })
  );

  return {
    results: outcomes.filter(o => o.ok),
    failures: outcomes.filter(o => !o.ok)
  };
}
