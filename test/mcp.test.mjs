import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseCommandString,
  checkLocalExecutable,
  testLocalMcp,
  testRemoteMcp,
  testMcpServer,
  listMcpServers,
  saveMcpServer,
  toggleMcpServer,
  deleteMcpServer,
  MCP_PRESETS
} from "../lib/mcp.mjs";

describe("MCP Command Parsing & Execution Checks", () => {
  test("parseCommandString splits arguments correctly and preserves quotes", () => {
    const raw = 'npx -y @modelcontextprotocol/server-filesystem "C:\\Users\\test\\my workspace" --read-only';
    const parsed = parseCommandString(raw);
    assert.deepEqual(parsed, [
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "C:\\Users\\test\\my workspace",
      "--read-only"
    ]);
  });

  test("parseCommandString handles already parsed arrays or single command", () => {
    assert.deepEqual(parseCommandString(["uvx", "mcp-server-git"]), ["uvx", "mcp-server-git"]);
    assert.deepEqual(parseCommandString("node"), ["node"]);
    assert.deepEqual(parseCommandString(""), []);
  });

  test("checkLocalExecutable detects system binaries (node)", () => {
    const res = checkLocalExecutable("node");
    assert.ok(res.ok);
    assert.ok(typeof res.path === "string" && res.path.length > 0);
  });

  test("testLocalMcp validates executable on path", () => {
    const res = testLocalMcp(["node", "-v"]);
    assert.ok(res.ok);
    assert.equal(res.binary, "node");

    const bad = testLocalMcp(["nonexistent-binary-12345-xyz"]);
    assert.equal(bad.ok, false);
    assert.ok(bad.error.includes("not found"));
  });

  test("testRemoteMcp validates bad protocols", async () => {
    const bad = await testRemoteMcp("ftp://example.com");
    assert.equal(bad.ok, false);
    assert.ok(bad.error.includes("http:// or https://"));
  });
});

describe("MCP Presets & Server Management", () => {
  let tmpConfig;
  const originalConfigEnv = process.env.OPENCODE_CONFIG;

  before(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
    tmpConfig = path.join(tmpDir, "opencode.jsonc");
    fs.writeFileSync(
      tmpConfig,
      `{\n  "provider": {},\n  "mcp": {\n    "servers": {\n      "test-burp": {\n        "type": "remote",\n        "url": "http://127.0.0.1:9876"\n      }\n    }\n  }\n}\n`,
      "utf8"
    );
    process.env.OPENCODE_CONFIG = tmpConfig;
  });

  after(() => {
    process.env.OPENCODE_CONFIG = originalConfigEnv;
    try {
      fs.rmSync(path.dirname(tmpConfig), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  test("MCP_PRESETS contains essential community servers", () => {
    assert.ok(Array.isArray(MCP_PRESETS));
    assert.ok(MCP_PRESETS.length >= 8);
    const ids = MCP_PRESETS.map(p => p.id);
    assert.ok(ids.includes("filesystem"));
    assert.ok(ids.includes("github"));
    assert.ok(ids.includes("git"));
    assert.ok(ids.includes("puppeteer"));
    assert.ok(ids.includes("fetch"));
  });

  test("listMcpServers reads servers from opencode.jsonc", () => {
    const { servers, presets } = listMcpServers();
    assert.ok(servers["test-burp"]);
    assert.equal(servers["test-burp"].type, "remote");
    assert.equal(servers["test-burp"].url, "http://127.0.0.1:9876");
    assert.equal(servers["test-burp"].enabled, true);
    assert.ok(Array.isArray(presets));
  });

  test("saveMcpServer adds a new local server with AST preservation", () => {
    const res = saveMcpServer("test-local-git", {
      type: "local",
      command: ["uvx", "mcp-server-git"],
      cwd: "C:\\projects",
      environment: { "GIT_LOG_LEVEL": "info" }
    });
    assert.ok(res.ok);
    assert.equal(res.id, "test-local-git");

    const { servers } = listMcpServers();
    assert.ok(servers["test-local-git"]);
    assert.equal(servers["test-local-git"].type, "local");
    assert.deepEqual(servers["test-local-git"].command, ["uvx", "mcp-server-git"]);
    assert.equal(servers["test-local-git"].environment.GIT_LOG_LEVEL, "info");
  });

  test("toggleMcpServer sets enabled to false and true", () => {
    toggleMcpServer("test-local-git", false);
    let { servers } = listMcpServers();
    assert.equal(servers["test-local-git"].enabled, false);

    toggleMcpServer("test-local-git", true);
    servers = listMcpServers().servers;
    assert.equal(servers["test-local-git"].enabled, true);
  });

  test("deleteMcpServer removes server cleanly", () => {
    const res = deleteMcpServer("test-local-git");
    assert.ok(res.ok);
    const { servers } = listMcpServers();
    assert.equal(servers["test-local-git"], undefined);
    assert.ok(servers["test-burp"]); // Existing server remains untouched
  });

  test("saveMcpServer rejects invalid input", () => {
    assert.throws(() => saveMcpServer("invalid name with spaces", { type: "local", command: ["node"] }), /Server ID/);
    assert.throws(() => saveMcpServer("bad-remote", { type: "remote", url: "not-a-url" }), /URL/);
    assert.throws(() => saveMcpServer("bad-local", { type: "local", command: [] }), /command/);
  });
});
