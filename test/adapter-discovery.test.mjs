import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANAGER_PORT = 18772;
const BASE = `http://127.0.0.1:${MANAGER_PORT}`;

let tmpDir;
let configPath;
let adaptersPath;
let mock;
let mockPort;
let server;
let modelsMode = "data";
const seen = [];

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
        if (req.method === "GET" && req.url === "/v1/models") {
          const payload = modelsMode === "models"
            ? { models: [{ id: "m1", name: "M1" }] }
            : { data: [{ id: "m1", name: "M1" }] };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found here" }));
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
  return { status: r.status, json };
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

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function readAdapters() {
  return JSON.parse(fs.readFileSync(adaptersPath, "utf8"));
}

async function saveAdapter(patch) {
  const r = await managerApi("PUT", "/api/adapters", {
    provider: "t1",
    enabled: true,
    upstreamBaseURL: `http://127.0.0.1:${mockPort}/v1`,
    headers: { "X-Ahefi-Mode": "architect", "X-Title": "Ahefi" },
    dynamicHeaders: { "X-Ahefi-Task-ID": "{{uuid}}" },
    bodyOverrides: { stream: true },
    defaultModel: "m1",
    timeoutMs: 10000,
    apiKeySource: "stored",
    storedApiKey: "k",
    ...patch
  });
  assert.equal(r.status, 200, `save adapter failed: ${JSON.stringify(r.json)}`);
  return r.json;
}

before(async () => {
  await startMock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omm-adapter-disc-"));
  configPath = path.join(tmpDir, "opencode.jsonc");
  adaptersPath = path.join(tmpDir, "adapters.json");
  fs.writeFileSync(configPath, JSON.stringify({
    provider: {
      t1: {
        name: "T1",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://orig.example.com/v1", apiKey: "k" },
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

describe("adapter discovery (upstream is source of truth)", () => {
  it("calls upstream /v1/models with the identity headers", async () => {
    seen.length = 0;
    const r = await managerApi("GET", "/api/models?provider=t1");
    assert.equal(r.status, 200, `discovery failed: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.count, 1);
    const hit = seen.find((s) => s.url === "/v1/models");
    assert.ok(hit, `upstream /v1/models was called, got: ${JSON.stringify(seen)}`);
    assert.ok(hit.headers["x-ahefi-task-id"], "fresh task id header present");
    assert.equal(hit.headers["x-ahefi-mode"], "architect");
    assert.equal(hit.headers.authorization, "Bearer k");
  });

  it("still works after the provider baseURL was switched to the proxy URL", async () => {
    const base = readConfig().provider.t1.options.baseURL;
    assert.ok(base.includes("/proxy/t1/"), `expected proxy baseURL, got ${base}`);
    seen.length = 0;
    const r = await managerApi("GET", "/api/models?provider=t1");
    assert.equal(r.status, 200, `discovery failed: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.count, 1);
    assert.ok(seen.some((s) => s.url === "/v1/models"), "went to upstream, not the proxy");
    assert.ok(!seen.some((s) => s.url === "/models"), "must not strip the /v1 base path");
  });

  it("still parses the {models} response format", async () => {
    modelsMode = "models";
    try {
      const r = await managerApi("GET", "/api/models?provider=t1");
      assert.equal(r.status, 200, `discovery failed: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.count, 1);
      assert.equal(r.json.models[0].id, "m1");
    } finally {
      modelsMode = "data";
    }
  });

  it("edit-form save writes the Base URL to adapters.json, not the proxy URL", async () => {
    const r = await managerApi("PUT", "/api/providers", {
      id: "t1",
      name: "T1",
      baseURL: "https://new.example.com/v1",
      package: "@ai-sdk/openai-compatible",
      headersText: "",
      apiKey: "",
      clearApiKey: false
    });
    assert.equal(r.status, 200, `edit save failed: ${JSON.stringify(r.json)}`);
    assert.equal(readAdapters().t1.upstreamBaseURL, "https://new.example.com/v1");
    const base = readConfig().provider.t1.options.baseURL;
    assert.ok(base.includes("/proxy/t1/"), `opencode.jsonc must keep the proxy URL, got ${base}`);
  });

  it("rejects a proxy URL in the edit form", async () => {
    const proxy = `http://127.0.0.1:${MANAGER_PORT}/proxy/t1/v1`;
    const r = await managerApi("PUT", "/api/providers", {
      id: "t1", name: "T1", baseURL: proxy, package: "@ai-sdk/openai-compatible", headersText: ""
    });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /real upstream URL/);
    assert.equal(readAdapters().t1.upstreamBaseURL, "https://new.example.com/v1", "upstream untouched");
  });

  it("rejects a proxy URL as the adapter upstream", async () => {
    const proxy = `http://127.0.0.1:${MANAGER_PORT}/proxy/t1/v1`;
    const r = await managerApi("PUT", "/api/adapters", {
      provider: "t1", enabled: true, upstreamBaseURL: proxy,
      headers: {}, dynamicHeaders: {}, bodyOverrides: {},
      defaultModel: "m1", timeoutMs: 10000, apiKeySource: "stored", storedApiKey: "k"
    });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /real upstream URL/);
  });

  it("disabling the adapter restores the original baseURL", async () => {
    const r = await managerApi("PUT", "/api/adapters", {
      provider: "t1", enabled: false,
      upstreamBaseURL: "https://new.example.com/v1",
      headers: {}, dynamicHeaders: {}, bodyOverrides: {},
      defaultModel: "m1", timeoutMs: 10000, apiKeySource: "stored", storedApiKey: "k"
    });
    assert.equal(r.status, 200, `disable failed: ${JSON.stringify(r.json)}`);
    assert.equal(readConfig().provider.t1.options.baseURL, "https://orig.example.com/v1");
  });
});
