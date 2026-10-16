import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const MANAGER_PORT = 18765;
const BASE = `http://127.0.0.1:${MANAGER_PORT}`;

let tmpDir;
let configPath;
let adaptersPath;
let mock;
let mockPort;
let server;
const seen = [];

function sseCompletion(content = "Hello") {
  return [
    `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{ index: 0, delta: { role: "assistant", content: content.slice(0, 3) }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{ index: 0, delta: { content: content.slice(3) }, finish_reason: "stop" }] })}`,
    "",
    `data: ${JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}`,
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n");
}

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: parsed });
        if (req.method === "GET" && req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "mock-1", name: "Mock 1" }] }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/chat/completions") {
          if (parsed?.model === "boom") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "upstream blew up", type: "server_error", code: 500 } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(sseCompletion());
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
    mock.listen(0, "127.0.0.1", () => {
      mockPort = mock.address().port;
      resolve();
    });
  });
}

async function managerApi(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}

async function waitForManager() {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("manager server did not start in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const STATIC_HEADERS = {
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
};

async function saveAdapter(patch) {
  const r = await managerApi("PUT", "/api/adapters", {
    provider: "t1",
    enabled: true,
    upstreamBaseURL: `http://127.0.0.1:${mockPort}/v1`,
    headers: STATIC_HEADERS,
    dynamicHeaders: { "X-Ahefi-Task-ID": "{{uuid}}", "X-Stainless-Runtime-Version": "{{node_version}}" },
    bodyOverrides: { stream: true, stream_options: { include_usage: true } },
    defaultModel: "dflt-model",
    timeoutMs: 10000,
    apiKeySource: "stored",
    storedApiKey: "test-key-123",
    ...patch
  });
  assert.equal(r.status, 200, `save adapter failed: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function proxyChat(body, extraHeaders = {}) {
  const r = await fetch(`${BASE}/proxy/t1/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body)
  });
  return r;
}

before(async () => {
  await startMock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omm-adapter-test-"));
  configPath = path.join(tmpDir, "opencode.jsonc");
  adaptersPath = path.join(tmpDir, "adapters.json");
  fs.writeFileSync(configPath, JSON.stringify({
    provider: {
      t1: {
        name: "T1",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${mockPort}/v1` },
        models: {}
      }
    }
  }, null, 2));
  fs.writeFileSync(adaptersPath, JSON.stringify({}));
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(MANAGER_PORT), OPENCODE_CONFIG: configPath, ADAPTERS_FILE: adaptersPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  await waitForManager();
  await saveAdapter({});
});

after(() => {
  server?.kill();
  mock?.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("request adapter", () => {
  it("lists adapters without exposing keys", async () => {
    const r = await managerApi("GET", "/api/adapters");
    assert.equal(r.status, 200);
    const entry = r.json.adapters.find((a) => a.provider === "t1");
    assert.ok(entry, "adapter entry for t1 exists");
    assert.equal(entry.hasKey, true);
    assert.ok(!("storedApiKey" in entry), "storedApiKey must not be returned");
  });

  it("sends a fresh X-Ahefi-Task-ID on every request", async () => {
    seen.length = 0;
    const m1 = { model: "dflt-model", messages: [{ role: "user", content: "hi" }], stream: true };
    const r1 = await proxyChat(m1);
    assert.equal(r1.status, 200);
    await r1.text();
    const r2 = await proxyChat(m1);
    assert.equal(r2.status, 200);
    await r2.text();
    const ids = seen.filter((s) => s.url === "/v1/chat/completions").map((s) => s.headers["x-ahefi-task-id"]);
    assert.equal(ids.length, 2);
    assert.ok(ids[0], "first task id present");
    assert.ok(ids[1], "second task id present");
    assert.notEqual(ids[0], ids[1], "task ids must differ per request");
  });

  it("forces stream:true and include_usage even when the client sends stream:false", async () => {
    seen.length = 0;
    const r = await proxyChat({ messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(r.status, 200);
    const last = seen.filter((s) => s.url === "/v1/chat/completions").at(-1);
    assert.equal(last.body.stream, true);
    assert.equal(last.body.stream_options?.include_usage, true);
  });

  it("applies the default model when none is sent", async () => {
    seen.length = 0;
    const r = await proxyChat({ messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(r.status, 200);
    await r.text();
    const last = seen.filter((s) => s.url === "/v1/chat/completions").at(-1);
    assert.equal(last.body.model, "dflt-model");
  });

  it("sends the static identity headers and node version", async () => {
    seen.length = 0;
    const r = await proxyChat({ model: "dflt-model", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(r.status, 200);
    await r.text();
    const h = seen.filter((s) => s.url === "/v1/chat/completions").at(-1).headers;
    assert.equal(h["http-referer"], STATIC_HEADERS["HTTP-Referer"]);
    assert.equal(h["x-title"], "Ahefi");
    assert.equal(h["user-agent"], "Ahefi/1.0.24");
    assert.equal(h["x-stainless-os"], "Windows");
    assert.equal(h["x-ahefi-mode"], "architect");
    assert.equal(h["x-stainless-runtime-version"], process.version);
    assert.equal(h.authorization, "Bearer test-key-123");
  });

  it("passes SSE through and ends with [DONE]", async () => {
    const r = await proxyChat({ model: "dflt-model", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
    const text = await r.text();
    assert.ok(text.includes("data: "), "contains SSE data events");
    assert.ok(text.trimEnd().endsWith("data: [DONE]"), "ends with [DONE]");
  });

  it("aggregates chunks into one JSON response for stream:false clients", async () => {
    const r = await proxyChat({ messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /application\/json/);
    const json = await r.json();
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].message.content, "Hello");
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.deepEqual(json.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  });

  it("proxies the models endpoint as JSON", async () => {
    const r = await fetch(`${BASE}/proxy/t1/v1/models`);
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.deepEqual(json.data.map((m) => m.id), ["mock-1"]);
  });

  it("rejects bodies without messages with 400", async () => {
    const r = await proxyChat({ model: "dflt-model" });
    assert.equal(r.status, 400);
    const json = await r.json();
    assert.equal(json.error.type, "invalid_request_error");
  });

  it("returns 404 for providers without an enabled adapter", async () => {
    const r = await fetch(`${BASE}/proxy/nope/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(r.status, 404);
  });

  it("passes an upstream 500 through as a JSON error", async () => {
    const r = await proxyChat({ model: "boom", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(r.status, 500);
    const json = await r.json();
    assert.equal(json.error.message, "upstream blew up");
  });

  it("returns 401 for dummy or empty keys", async () => {
    await saveAdapter({ storedApiKey: "dummy" });
    const r = await proxyChat({ model: "dflt-model", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 401);
    const json = await r.json();
    assert.equal(json.error.type, "authentication_error");
    assert.equal(json.error.code, 401);
  });
});
