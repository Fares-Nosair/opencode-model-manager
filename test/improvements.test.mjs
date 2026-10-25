import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { aggregateSse } from "../lib/proxy.mjs";
import { inferCapabilities } from "../lib/discovery.mjs";
import { getPresets } from "../lib/presets.mjs";
import { addLogEntry, getLogEntries, clearLogEntries } from "../lib/logs.mjs";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANAGER_PORT = 18788;
const BASE = `http://127.0.0.1:${MANAGER_PORT}`;

let tmpDir;
let configPath;
let adaptersPath;
let server;
let mock;
let mockPort;
const mockSeen = [];

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        mockSeen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: parsed });

        if (req.method === "POST" && req.url === "/v1/chat/completions") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "mock-direct-chat",
            choices: [{ message: { role: "assistant", content: "Hello from direct provider!" } }]
          }));
          return;
        }

        if (req.method === "POST" && req.url === "/v1/embeddings") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
            model: parsed?.model || "mock-embed"
          }));
          return;
        }

        if (req.method === "GET" && req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "mock-model-1", name: "Mock Model 1" }] }));
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

async function waitForManager() {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return;
    } catch { /* wait */ }
    if (Date.now() > deadline) throw new Error("manager did not start in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  await startMock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omm-improvements-test-"));
  configPath = path.join(tmpDir, "opencode.jsonc");
  adaptersPath = path.join(tmpDir, "adapters.json");

  fs.writeFileSync(configPath, JSON.stringify({
    provider: {
      testprov: {
        name: "Test Provider",
        npm: "@opencode-ai/ai/providers/openai-compatible",
        options: {
          baseURL: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: "test-secret-key"
        },
        models: {
          "mock-model-1": { name: "Mock Model 1" }
        }
      }
    }
  }, null, 2));

  fs.writeFileSync(adaptersPath, JSON.stringify({
    testprov: {
      enabled: true,
      upstreamBaseURL: `http://127.0.0.1:${mockPort}/v1`,
      originalBaseURL: `http://127.0.0.1:${mockPort}/v1`,
      headers: { "X-Custom-Proxy": "unit-test" },
      dynamicHeaders: {},
      bodyOverrides: { stream: true },
      defaultModel: "mock-model-1",
      timeoutMs: 10000,
      apiKeySource: "incoming",
      storedApiKey: ""
    }
  }, null, 2));

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: PROJECT,
    env: {
      ...process.env,
      PORT: String(MANAGER_PORT),
      OPENCODE_CONFIG: configPath,
      ADAPTERS_FILE: adaptersPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  await waitForManager();
});

after(() => {
  server?.kill();
  mock?.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("Reasoning / Thinking Model SSE Aggregation", () => {
  it("captures delta.reasoning_content and preserves it in message.reasoning_content", () => {
    const sse = [
      `data: ${JSON.stringify({ id: "chunk-1", choices: [{ delta: { reasoning_content: "Let us calculate " } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chunk-2", choices: [{ delta: { reasoning_content: "2 + 2." } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chunk-3", choices: [{ delta: { content: "The answer is 4." } }] })}`,
      "",
      "data: [DONE]",
      ""
    ].join("\n");

    const result = aggregateSse(sse, "deepseek-r1");
    assert.equal(result.choices[0].message.role, "assistant");
    assert.equal(result.choices[0].message.content, "The answer is 4.");
    assert.equal(result.choices[0].message.reasoning_content, "Let us calculate 2 + 2.");
  });

  it("handles alternative thought and reasoning delta keys", () => {
    const sse = [
      `data: ${JSON.stringify({ id: "chunk-1", choices: [{ delta: { thought: "Thinking about life... " } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chunk-2", choices: [{ delta: { content: "42" } }] })}`,
      "",
      "data: [DONE]",
      ""
    ].join("\n");

    const result = aggregateSse(sse, "qwq-32b");
    assert.equal(result.choices[0].message.content, "42");
    assert.equal(result.choices[0].message.reasoning_content, "Thinking about life... ");
  });
});

describe("Model Capability Tag & Capability Auto-detection", () => {
  it("detects reasoning models", () => {
    const r1 = inferCapabilities("deepseek-r1");
    assert.ok(r1.capabilities.reasoning);
    assert.ok(r1.tags.includes("REASONING"));

    const o3 = inferCapabilities("o3-mini");
    assert.ok(o3.capabilities.reasoning);
    assert.ok(o3.tags.includes("REASONING"));
  });

  it("detects vision and multimodal models", () => {
    const gpt4o = inferCapabilities("gpt-4o");
    assert.ok(gpt4o.capabilities.vision);
    assert.ok(gpt4o.tags.includes("VISION"));

    const gemini = inferCapabilities("gemini-2.5-flash");
    assert.ok(gemini.capabilities.vision);
    assert.ok(gemini.tags.includes("VISION"));
  });

  it("detects embedding models", () => {
    const embed = inferCapabilities("text-embedding-3-small");
    assert.ok(embed.capabilities.embedding);
    assert.ok(embed.tags.includes("EMBED"));
    assert.equal(embed.capabilities.tools, false);
  });
});

describe("Proxy Embeddings Endpoint", () => {
  it("proxies POST /proxy/:providerId/v1/embeddings with headers and auth", async () => {
    const res = await fetch(`${BASE}/proxy/testprov/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-key"
      },
      body: JSON.stringify({
        input: "hello world",
        model: "text-embedding-3-small"
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, "list");
    assert.ok(Array.isArray(data.data));
    assert.equal(data.data[0].embedding.length, 3);

    const call = mockSeen.find((c) => c.url === "/v1/embeddings");
    assert.ok(call);
    assert.equal(call.headers["x-custom-proxy"], "unit-test");
  });
});

describe("Direct Provider Chat Test (without adapter)", () => {
  it("successfully tests completion directly against provider baseURL", async () => {
    const res = await fetch(`${BASE}/api/providers/test-completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "testprov" })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.reply, "Hello from direct provider!");
    assert.ok(typeof data.latencyMs === "number");

    const directCall = mockSeen.find((c) => c.url === "/v1/chat/completions" && c.headers.authorization === "Bearer test-secret-key");
    assert.ok(directCall);
  });
});

describe("In-Dashboard Live Proxy Logs & Activity Monitor", () => {
  it("stores rolling logs in memory and provides API endpoints to get and clear", async () => {
    // Test local in-memory log buffer functions
    clearLogEntries();
    addLogEntry({ providerId: "local-p1", model: "m1", status: 200, latencyMs: 50 });
    addLogEntry({ providerId: "local-p2", model: "m2", status: 500, latencyMs: 120, error: "fail" });
    const localLogs = getLogEntries();
    assert.equal(localLogs.length, 2);
    assert.equal(localLogs[0].providerId, "local-p2");
    clearLogEntries();
    assert.equal(getLogEntries().length, 0);

    // Test server child process logging via HTTP
    const getRes = await fetch(`${BASE}/api/proxy/logs`);
    assert.equal(getRes.status, 200);
    const data = await getRes.json();
    assert.ok(Array.isArray(data.logs));
    // The previous test called /proxy/testprov/v1/embeddings, so at least 1 log entry was captured on server
    assert.ok(data.logs.length >= 1);

    const delRes = await fetch(`${BASE}/api/proxy/logs`, { method: "DELETE" });
    assert.equal(delRes.status, 200);

    const afterRes = await fetch(`${BASE}/api/proxy/logs`);
    const afterData = await afterRes.json();
    assert.equal(afterData.logs.length, 0);
  });
});

describe("Automatic Rolling Backups & Restore", () => {
  it("creates rolling backups in .backups/ when config is modified and restores cleanly", async () => {
    // Perform an edit to trigger writeConfig
    const toggleRes = await fetch(`${BASE}/api/providers/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "testprov", enabled: false })
    });
    assert.equal(toggleRes.status, 200);

    const listRes = await fetch(`${BASE}/api/backups`);
    assert.equal(listRes.status, 200);
    const backupsData = await listRes.json();
    assert.ok(Array.isArray(backupsData.backups));
    assert.ok(backupsData.backups.length >= 1);

    const latest = backupsData.backups[0].filename;
    const restoreRes = await fetch(`${BASE}/api/backups/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: latest })
    });
    assert.equal(restoreRes.status, 200);
    const restoreData = await restoreRes.json();
    assert.equal(restoreData.ok, true);
    assert.equal(restoreData.restored, latest);
  });
});

describe("Config Export and Import", () => {
  it("exports configuration and imports it successfully", async () => {
    const expRes = await fetch(`${BASE}/api/config/export`);
    assert.equal(expRes.status, 200);
    const expData = await expRes.json();
    assert.equal(expData.version, 4);
    assert.ok(expData.providers.testprov);

    const impRes = await fetch(`${BASE}/api/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          importedprov: {
            name: "Imported Provider",
            npm: "@opencode-ai/ai/providers/openai-compatible",
            options: { baseURL: "http://localhost:9999/v1" }
          }
        }
      })
    });
    assert.equal(impRes.status, 200);
    const impData = await impRes.json();
    assert.equal(impData.ok, true);
    assert.equal(impData.importedProviders, 1);

    const checkRes = await fetch(`${BASE}/api/providers?provider=importedprov`);
    assert.equal(checkRes.status, 200);
    const checkData = await checkRes.json();
    assert.equal(checkData.provider.id, "importedprov");
  });
});

describe("Provider and Adapter Presets", () => {
  it("serves comprehensive preset list via GET /api/presets", async () => {
    const res = await fetch(`${BASE}/api/presets`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.presets.ahefi);
    assert.ok(data.presets.ollama);
    assert.ok(data.presets.openrouter);
    assert.ok(data.presets.deepseek);
    assert.ok(data.presets.gemini);
    assert.ok(data.presets.groq);
  });
});

describe("Model Official Logos and SVG Glyph Rendering", () => {
  it("contains clean official vector SVGs for all major model families", async () => {
    const fs = await import("node:fs");
    const appJs = fs.readFileSync("public/app.js", "utf8");

    // Ensure getModelLogoSvg and MODEL_LOGOS exist in app.js
    assert.ok(appJs.includes("const MODEL_LOGOS = {"));
    assert.ok(appJs.includes("function getModelLogoSvg("));

    // Extract MODEL_LOGOS and getModelLogoSvg using vm
    const vm = await import("node:vm");
    const matchLogos = appJs.match(/const MODEL_LOGOS = \{[\s\S]*?\n\};/);
    const matchFn = appJs.match(/function getModelLogoSvg\([\s\S]*?\n\}/);
    assert.ok(matchLogos, "MODEL_LOGOS block found");
    assert.ok(matchFn, "getModelLogoSvg function found");

    const { MODEL_LOGOS, getModelLogoSvg } = vm.runInContext(
      `(() => {
        ${matchLogos[0]}
        ${matchFn[0]}
        return { MODEL_LOGOS, getModelLogoSvg };
      })()`,
      vm.createContext({})
    );
    const expectedFamilies = [
      "openai", "claude", "gemini", "deepseek", "meta", "mistral",
      "qwen", "cohere", "groq", "ollama", "stability", "microsoft", "default"
    ];

    for (const fam of expectedFamilies) {
      assert.ok(MODEL_LOGOS[fam], `Logo for ${fam} exists`);
      assert.ok(MODEL_LOGOS[fam].startsWith("<svg"), `${fam} is an SVG`);
      assert.ok(MODEL_LOGOS[fam].endsWith("</svg>"), `${fam} ends with </svg>`);
      assert.ok(MODEL_LOGOS[fam].includes('viewBox="0 0 24 24"'), `${fam} uses standard 24x24 viewBox`);
      assert.ok(MODEL_LOGOS[fam].includes('fill="currentColor"'), `${fam} uses fill=currentColor for uniform theme`);
    }

    // Verify model identification
    assert.equal(getModelLogoSvg("claude-3-5-sonnet-20241022", "anthropic"), MODEL_LOGOS.claude);
    assert.equal(getModelLogoSvg("gpt-4o", "openai"), MODEL_LOGOS.openai);
    assert.equal(getModelLogoSvg("o1-preview", "openai"), MODEL_LOGOS.openai);
    assert.equal(getModelLogoSvg("o3-mini", "openai"), MODEL_LOGOS.openai);
    assert.equal(getModelLogoSvg("gemini-2.0-flash", "google"), MODEL_LOGOS.gemini);
    assert.equal(getModelLogoSvg("deepseek-r1", "deepseek"), MODEL_LOGOS.deepseek);
    assert.equal(getModelLogoSvg("deepseek-chat", "deepseek"), MODEL_LOGOS.deepseek);
    assert.equal(getModelLogoSvg("llama-3.1-70b-instruct", "meta"), MODEL_LOGOS.meta);
    assert.equal(getModelLogoSvg("mistral-large-2407", "mistral"), MODEL_LOGOS.mistral);
    assert.equal(getModelLogoSvg("qwen2.5-coder-32b", "alibaba"), MODEL_LOGOS.qwen);
    assert.equal(getModelLogoSvg("command-r-plus", "cohere"), MODEL_LOGOS.cohere);
    assert.equal(getModelLogoSvg("mixtral-8x7b", "groq"), MODEL_LOGOS.mistral);
    assert.equal(getModelLogoSvg("groq/model", "groq"), MODEL_LOGOS.groq);
    assert.equal(getModelLogoSvg("qwen2.5:7b", "ollama"), MODEL_LOGOS.qwen);
    assert.equal(getModelLogoSvg("mysterious-llm", "ollama"), MODEL_LOGOS.ollama);
    assert.equal(getModelLogoSvg("phi-3.5-mini", "microsoft"), MODEL_LOGOS.microsoft);
    assert.equal(getModelLogoSvg("stable-diffusion-xl", "stability"), MODEL_LOGOS.stability);
    assert.equal(getModelLogoSvg("my-custom-fine-tuned-model", "local"), MODEL_LOGOS.default);
  });
});
