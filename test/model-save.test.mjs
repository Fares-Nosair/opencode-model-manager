import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANAGER_PORT = 18773;
const BASE = `http://127.0.0.1:${MANAGER_PORT}`;

let tmpDir;
let configPath;
let server;

function writeConfig(obj) {
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

async function save(provider, discoveredIds, selectedIds) {
  const r = await fetch(`${BASE}/api/models/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      discoveredIds,
      selectedIds,
      metadata: Object.fromEntries(discoveredIds.map((id) => [id, { name: id }]))
    })
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

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omm-model-save-"));
  configPath = path.join(tmpDir, "opencode.jsonc");
  writeConfig({
    provider: {
      t1: {
        name: "T1",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://up.example.com/v1", apiKey: "k" },
        models: {}
      }
    }
  });
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(MANAGER_PORT), OPENCODE_CONFIG: configPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  await waitForManager();
});

after(() => {
  server?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("instant model save (one checkbox toggle)", () => {
  it("checking a model adds it to the config without creating a backup", async () => {
    const r = await save("t1", ["m1", "m2"], ["m1", "m2"]);
    assert.equal(r.status, 200);
    assert.equal(r.json.backup, undefined);
    assert.equal(r.json.modelCount, 2);
    assert.deepEqual(fs.readdirSync(tmpDir).filter((f) => f.includes(".bak")), []);
    const models = readConfig().provider.t1.models;
    assert.deepEqual(Object.keys(models).sort(), ["m1", "m2"]);
    assert.equal(models.m1.name, "m1");
  });

  it("unchecking removes only that model and keeps the rest", async () => {
    const r = await save("t1", ["m1", "m2"], ["m1"]);
    assert.equal(r.status, 200);
    assert.equal(r.json.modelCount, 1);
    assert.deepEqual(Object.keys(readConfig().provider.t1.models), ["m1"]);
  });

  it("leaves models outside the discovery result untouched", async () => {
    writeConfig({
      provider: {
        t1: {
          name: "T1",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://up.example.com/v1", apiKey: "k" },
          models: { elsewhere: { name: "elsewhere" }, m1: { name: "m1" } }
        }
      }
    });
    const r = await save("t1", ["m1", "m2"], []);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(readConfig().provider.t1.models), ["elsewhere"]);
  });

  it("rejects selections outside the discovery result", async () => {
    const r = await save("t1", ["m1"], ["nope"]);
    assert.equal(r.status, 500);
    assert.match(r.json.error, /latest discovery/);
  });

  it("saves fine for disabled providers (selection is preserved, UI greys it)", async () => {
    writeConfig({
      provider: {
        t1: {
          name: "T1",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://up.example.com/v1", apiKey: "k" },
          models: { m1: { name: "m1" } }
        }
      },
      disabled_providers: ["t1"]
    });
    const r = await save("t1", ["m1"], ["m1"]);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(readConfig().provider.t1.models), ["m1"]);
  });
});
