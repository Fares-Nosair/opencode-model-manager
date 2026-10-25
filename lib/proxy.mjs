import crypto from "node:crypto";
import {
  PORT,
  getAdapter,
  resolveSecret,
  readConfig,
  allProviders
} from "./config.mjs";
import { addLogEntry } from "./logs.mjs";

const AUTH_HEADER_NAMES = ["authorization", "x-goog-api-key", "x-api-key", "api-key", "x-goog-key"];

export function resolveTemplate(value) {
  return String(value)
    .replace(/\{\{uuid\}\}/g, () => crypto.randomUUID())
    .replace(/\{\{node_version\}\}/g, () => process.version)
    .replace(/\{\{timestamp\}\}/g, () => String(Date.now()));
}

export function bearerKey(headerValue) {
  if (typeof headerValue !== "string") return "";
  return headerValue.replace(/^Bearer\s+/i, "").trim();
}

export function resolveAdapterKey(adapter, incomingAuth) {
  const source = adapter.apiKeySource || "incoming";
  if (source.startsWith("env:")) return process.env[source.slice(4)] || "";
  if (source === "stored") return adapter.storedApiKey || "";
  return bearerKey(incomingAuth);
}

export function adapterKeyForServer(adapter, provider) {
  const source = adapter.apiKeySource || "incoming";
  if (source.startsWith("env:")) return process.env[source.slice(4)] || "";
  if (source === "stored") return adapter.storedApiKey || "";
  const settings = { ...(provider.settings || {}), ...(provider.options || {}) };
  return resolveSecret(settings.apiKey);
}

export function buildAdapterHeaders(adapter, key) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  for (const [k, v] of Object.entries(adapter.headers || {})) headers[k] = v;
  for (const [k, v] of Object.entries(adapter.dynamicHeaders || {})) headers[k] = resolveTemplate(v);
  return headers;
}

export function adapterDiscoveryHeaders(adapter, key) {
  const headers = buildAdapterHeaders(adapter, key || "dummy");
  const declared = Object.keys(adapter.headers || {}).some(k => AUTH_HEADER_NAMES.includes(k.toLowerCase()));
  if (!declared) delete headers.Authorization;
  return { headers, key: declared ? "" : (key || "") };
}

export function buildChatBody(adapter, incomingBody) {
  return {
    ...incomingBody,
    model: incomingBody.model || adapter.defaultModel,
    ...(adapter.bodyOverrides || {})
  };
}

export function logProxy(providerId, model, status, latencyMs, endpoint = "", error = "") {
  console.log(`${new Date().toISOString()} [adapter] provider=${providerId} model=${model || "-"} status=${status} latencyMs=${latencyMs}${error ? ` error=${error}` : ""}`);
  addLogEntry({ providerId, model: model || "-", status, latencyMs, endpoint, error });
}

export function adapterError(res, status, message, type, code, sendJson) {
  const body = { error: { message, type, code } };
  if (res.headersSent) {
    try { res.write(`data: ${JSON.stringify(body)}\n\n`); res.end(); } catch { /* client gone */ }
    return;
  }
  sendJson(res, status, body);
}

export function readProxyBody(req, limit = 25 * 1024 * 1024) {
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

export function aggregateSse(sseText, model) {
  let content = "";
  let reasoningContent = "";
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
    const rc = delta.reasoning_content ?? delta.reasoning ?? delta.thought;
    if (typeof rc === "string") reasoningContent += rc;
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
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }
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

export async function fetchChatUpstream(adapter, key, body) {
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

export async function upstreamErrorBody(response) {
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

export async function handleProxyChat(req, res, providerId, sendJson) {
  const started = Date.now();
  const adapter = getAdapter(providerId);
  if (!adapter?.enabled) {
    return adapterError(res, 404, `No enabled adapter for provider "${providerId}"`, "invalid_request_error", 404, sendJson);
  }
  let raw;
  try { raw = await readProxyBody(req); }
  catch (e) { return adapterError(res, 400, e.message, "invalid_request_error", 400, sendJson); }
  let incoming;
  try { incoming = JSON.parse(raw.toString("utf8") || "{}"); }
  catch { return adapterError(res, 400, "Invalid request body: not valid JSON", "invalid_request_error", 400, sendJson); }
  if (!incoming || !Array.isArray(incoming.messages)) {
    return adapterError(res, 400, "Invalid request body: missing messages", "invalid_request_error", 400, sendJson);
  }
  const key = resolveAdapterKey(adapter, req.headers.authorization);
  if (!key || key === "dummy") {
    return adapterError(res, 401, "Missing API key", "authentication_error", 401, sendJson);
  }
  const body = buildChatBody(adapter, incoming);
  const clientWantsJson = incoming.stream === false;
  let upstream;
  try {
    upstream = await fetchChatUpstream(adapter, key, body);
  } catch (e) {
    logProxy(providerId, body.model, 500, Date.now() - started, "/chat/completions", e.message);
    return adapterError(res, 500, e.message, "proxy_error", 500, sendJson);
  }
  if (!upstream.ok) {
    const err = await upstreamErrorBody(upstream);
    logProxy(providerId, body.model, upstream.status, Date.now() - started, "/chat/completions", err.message);
    return adapterError(res, upstream.status, err.message, err.type, upstream.status, sendJson);
  }
  if (clientWantsJson) {
    let text;
    try { text = await upstream.text(); }
    catch (e) {
      logProxy(providerId, body.model, 500, Date.now() - started, "/chat/completions", e.message);
      return adapterError(res, 500, e.message, "proxy_error", 500, sendJson);
    }
    logProxy(providerId, body.model, 200, Date.now() - started, "/chat/completions");
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
    logProxy(providerId, body.model, 500, Date.now() - started, "/chat/completions", e.message);
    return adapterError(res, 500, e.message || "Streaming failed", "proxy_error", 500, sendJson);
  } finally {
    req.off?.("close", abortClient);
  }
  res.write("data: [DONE]\n\n");
  res.end();
  logProxy(providerId, body.model, 200, Date.now() - started, "/chat/completions");
}

export async function handleProxyModels(req, res, providerId, sendJson, modelsUrlCandidates, fetchModelsBody, modelRowsFromBody, authAttempts) {
  const started = Date.now();
  const adapter = getAdapter(providerId);
  if (!adapter?.enabled) {
    return adapterError(res, 404, `No enabled adapter for provider "${providerId}"`, "invalid_request_error", 404, sendJson);
  }
  const key = resolveAdapterKey(adapter, req.headers.authorization);
  if (!key || key === "dummy") {
    return adapterError(res, 401, "Missing API key", "authentication_error", 401, sendJson);
  }
  const timeoutMs = adapter.timeoutMs || 120000;
  let candidates;
  try { candidates = modelsUrlCandidates(adapter.upstreamBaseURL); }
  catch (e) {
    logProxy(providerId, "-", 500, Date.now() - started, "/models", e.message);
    return adapterError(res, 500, e.message, "proxy_error", 500, sendJson);
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
        if (!e.authFailure) break;
      }
    }
    if (payload) break;
  }
  if (!payload) {
    const status = failure?.status >= 400 ? failure.status : 502;
    logProxy(providerId, "-", status, Date.now() - started, "/models", failure?.message || "Failed to load model list");
    return adapterError(res, status, failure?.message || "Could not load the upstream model list.", "proxy_error", status, sendJson);
  }
  logProxy(providerId, "-", 200, Date.now() - started, "/models");
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

export async function handleProxyEmbeddings(req, res, providerId, sendJson) {
  const started = Date.now();
  const adapter = getAdapter(providerId);
  if (!adapter?.enabled) {
    return adapterError(res, 404, `No enabled adapter for provider "${providerId}"`, "invalid_request_error", 404, sendJson);
  }
  let raw;
  try { raw = await readProxyBody(req); }
  catch (e) { return adapterError(res, 400, e.message, "invalid_request_error", 400, sendJson); }
  let incoming;
  try { incoming = JSON.parse(raw.toString("utf8") || "{}"); }
  catch { return adapterError(res, 400, "Invalid request body: not valid JSON", "invalid_request_error", 400, sendJson); }
  const key = resolveAdapterKey(adapter, req.headers.authorization);
  if (!key || key === "dummy") {
    return adapterError(res, 401, "Missing API key", "authentication_error", 401, sendJson);
  }
  const url = adapter.upstreamBaseURL.replace(/\/$/, "") + "/embeddings";
  const headers = buildAdapterHeaders(adapter, key);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), adapter.timeoutMs || 120000);
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(incoming),
      signal: abort.signal
    });
  } catch (e) {
    clearTimeout(timeout);
    logProxy(providerId, incoming.model || "-", 500, Date.now() - started, "/embeddings", e.message);
    if (e.name === "AbortError") return adapterError(res, 500, `Upstream timed out after ${adapter.timeoutMs || 120000}ms.`, "proxy_error", 500, sendJson);
    return adapterError(res, 500, `Could not reach upstream: ${e.message}`, "proxy_error", 500, sendJson);
  }
  clearTimeout(timeout);
  if (!upstream.ok) {
    const err = await upstreamErrorBody(upstream);
    logProxy(providerId, incoming.model || "-", upstream.status, Date.now() - started, "/embeddings", err.message);
    return adapterError(res, upstream.status, err.message, err.type, upstream.status, sendJson);
  }
  let text;
  try { text = await upstream.text(); }
  catch (e) {
    logProxy(providerId, incoming.model || "-", 500, Date.now() - started, "/embeddings", e.message);
    return adapterError(res, 500, e.message, "proxy_error", 500, sendJson);
  }
  logProxy(providerId, incoming.model || "-", 200, Date.now() - started, "/embeddings");
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

export async function testAdapterChat(providerId) {
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
    logProxy(providerId, body.model, upstream.status, Date.now() - started, "/chat/completions (test)", err.message);
    return { ok: false, status: upstream.status, reply: "", error: err.message, latencyMs: Date.now() - started };
  }
  let text;
  try { text = await upstream.text(); }
  catch (e) {
    return { ok: false, status: 500, reply: "", error: e.message, latencyMs: Date.now() - started };
  }
  const agg = aggregateSse(text, body.model);
  logProxy(providerId, body.model, 200, Date.now() - started, "/chat/completions (test)");
  return {
    ok: true,
    status: 200,
    reply: agg.choices?.[0]?.message?.content ?? "",
    reasoning_content: agg.choices?.[0]?.message?.reasoning_content ?? "",
    usage: agg.usage,
    latencyMs: Date.now() - started,
    error: ""
  };
}
