import { spawnSync } from "node:child_process";
import { readConfig, writeConfig, editText } from "./config.mjs";

/* ---- Parse Shell Command String into Arguments Array ---- */

export function parseCommandString(cmd) {
  if (Array.isArray(cmd)) return cmd.map(String);
  if (typeof cmd !== "string") return [];
  const trimmed = cmd.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fallback to normal parsing */ }
  }
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const matches = [];
  let match;
  while ((match = regex.exec(trimmed)) !== null) {
    if (match[1] !== undefined) matches.push(match[1]);
    else if (match[2] !== undefined) matches.push(match[2]);
    else matches.push(match[0]);
  }
  return matches.length ? matches : [trimmed];
}

/* ---- System Path Executable Check ---- */

export function checkLocalExecutable(binaryName) {
  if (!binaryName) return { ok: false, error: "No executable specified" };
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  try {
    const res = spawnSync(cmd, [binaryName], { encoding: "utf8", timeout: 2500, windowsHide: true });
    if (res.status === 0 && res.stdout.trim()) {
      const firstPath = res.stdout.trim().split(/\r?\n/)[0];
      return { ok: true, path: firstPath };
    }
    return { ok: false, error: `Executable '${binaryName}' not found on system PATH.` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---- Remote MCP Connectivity Test ---- */

export async function testRemoteMcp(url, headers = {}) {
  const started = Date.now();
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) {
      return { ok: false, latencyMs: 0, error: "URL must start with http:// or https://" };
    }
    let res;
    try {
      res = await fetch(url, {
        method: "HEAD",
        headers,
        signal: AbortSignal.timeout(3500)
      });
      if (res.status === 405) {
        res = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(3500)
        });
      }
    } catch {
      res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(3500)
      });
    }

    const latencyMs = Date.now() - started;
    const isReachable = res.status < 500;
    return {
      ok: isReachable,
      status: res.status,
      statusText: res.statusText,
      latencyMs,
      error: isReachable ? null : `HTTP ${res.status}: ${res.statusText || "Server error"}`
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err.name === "TimeoutError" ? "Connection timed out (3.5s)" : (err.message || "Failed to reach endpoint")
    };
  }
}

/* ---- Local MCP Runtime Test ---- */

export function testLocalMcp(command = []) {
  const args = Array.isArray(command) ? command : parseCommandString(command);
  if (!args.length) {
    return { ok: false, error: "No command specified" };
  }
  const binary = args[0];
  const result = checkLocalExecutable(binary);
  if (!result.ok) {
    return { ok: false, error: result.error, binary };
  }
  return {
    ok: true,
    message: `Runtime '${binary}' is available at ${result.path}`,
    binary,
    path: result.path
  };
}

/* ---- Universal MCP Test ---- */

export async function testMcpServer(config) {
  if (!config || typeof config !== "object") {
    return { ok: false, error: "Invalid MCP server config." };
  }
  const type = config.type || (config.url ? "remote" : "local");
  if (type === "remote") {
    if (!config.url) return { ok: false, error: "Missing remote URL." };
    return await testRemoteMcp(config.url, config.headers || {});
  } else {
    return testLocalMcp(config.command);
  }
}

/* ---- Curated Community MCP Presets ---- */

export const MCP_PRESETS = [
  {
    id: "filesystem",
    name: "Filesystem",
    type: "local",
    category: "Development",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "{workspace}"],
    description: "Read, write, list, and search files inside approved directories.",
    icon: "folder"
  },
  {
    id: "fetch",
    name: "Web Fetch",
    type: "local",
    category: "Web",
    command: ["npx", "-y", "@modelcontextprotocol/server-fetch"],
    description: "Fetch web pages and convert HTML into clean markdown for agent context.",
    icon: "globe"
  },
  {
    id: "puppeteer",
    name: "Puppeteer Browser",
    type: "local",
    category: "Web",
    command: ["npx", "-y", "@modelcontextprotocol/server-puppeteer"],
    description: "Headless Chrome browser automation: click elements, navigate, and take screenshots.",
    icon: "browser"
  },
  {
    id: "git",
    name: "Git Repository",
    type: "local",
    category: "Development",
    command: ["uvx", "mcp-server-git"],
    description: "Direct Git operations: inspect commit logs, branch status, and file diffs.",
    icon: "git"
  },
  {
    id: "github",
    name: "GitHub API",
    type: "local",
    category: "Development",
    command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    environment: { "GITHUB_PERSONAL_ACCESS_TOKEN": "" },
    description: "Search repos, inspect code, review PRs, and manage issues.",
    icon: "github"
  },
  {
    id: "memory",
    name: "Persistent Memory",
    type: "local",
    category: "Core",
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
    description: "Graph-based persistent memory to remember project concepts across conversations.",
    icon: "brain"
  },
  {
    id: "brave-search",
    name: "Brave Search",
    type: "local",
    category: "Web",
    command: ["npx", "-y", "@modelcontextprotocol/server-brave-search"],
    environment: { "BRAVE_API_KEY": "" },
    description: "Real-time web search and location search powered by Brave Search API.",
    icon: "search"
  },
  {
    id: "sqlite",
    name: "SQLite Database",
    type: "local",
    category: "Database",
    command: ["uvx", "mcp-server-sqlite", "--db-path", "./data.db"],
    description: "Inspect schemas, tables, and run analytical SQL queries on SQLite databases.",
    icon: "database"
  },
  {
    id: "everything",
    name: "Everything Sandbox",
    type: "local",
    category: "Testing",
    command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
    description: "Official reference test server with sample tools, resources, and prompts.",
    icon: "box"
  },
  {
    id: "context7",
    name: "Context7 Remote",
    type: "remote",
    category: "Remote",
    url: "https://mcp.context7.com/mcp",
    description: "Remote cloud-hosted developer context service with live documentation tools.",
    icon: "cloud"
  }
];

/* ---- List MCP Servers ---- */

export function listMcpServers() {
  const { config } = readConfig();
  const mcp = config.mcp || {};
  const rawServers = mcp.servers || {};
  const servers = {};

  if (typeof rawServers === "object" && rawServers !== null && !Array.isArray(rawServers)) {
    for (const [id, s] of Object.entries(rawServers)) {
      if (!s || typeof s !== "object") continue;
      const type = s.type || (s.url ? "remote" : "local");
      servers[id] = {
        id,
        name: s.name || id,
        type,
        command: Array.isArray(s.command) ? s.command : (typeof s.command === "string" ? parseCommandString(s.command) : []),
        url: typeof s.url === "string" ? s.url : "",
        cwd: typeof s.cwd === "string" ? s.cwd : "",
        environment: (typeof s.environment === "object" && s.environment) ? s.environment : {},
        headers: (typeof s.headers === "object" && s.headers) ? s.headers : {},
        enabled: s.enabled !== false
      };
    }
  }

  // Also support direct mcp[id] configuration if present
  for (const [id, s] of Object.entries(mcp)) {
    if (id === "servers" || id === "timeout") continue;
    if (s && typeof s === "object" && !Array.isArray(s) && (s.type || s.command || s.url)) {
      if (!servers[id]) {
        const type = s.type || (s.url ? "remote" : "local");
        servers[id] = {
          id,
          name: s.name || id,
          type,
          command: Array.isArray(s.command) ? s.command : (typeof s.command === "string" ? parseCommandString(s.command) : []),
          url: typeof s.url === "string" ? s.url : "",
          cwd: typeof s.cwd === "string" ? s.cwd : "",
          environment: (typeof s.environment === "object" && s.environment) ? s.environment : {},
          headers: (typeof s.headers === "object" && s.headers) ? s.headers : {},
          enabled: s.enabled !== false
        };
      }
    }
  }

  return {
    servers,
    presets: MCP_PRESETS
  };
}

/* ---- Save / Update MCP Server ---- */

export function saveMcpServer(rawId, serverConfig) {
  if (typeof rawId !== "string" || !rawId.trim()) {
    throw new Error("Server ID is required.");
  }
  const id = rawId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Server ID must start with an alphanumeric character and contain only letters, numbers, dots, dashes, or underscores.");
  }

  if (!serverConfig || typeof serverConfig !== "object") {
    throw new Error("Invalid server configuration.");
  }

  const type = serverConfig.type === "remote" ? "remote" : "local";
  const clean = { type };

  if (type === "remote") {
    if (typeof serverConfig.url !== "string" || !/^https?:\/\//i.test(serverConfig.url.trim())) {
      throw new Error("Remote MCP server requires a valid HTTP or HTTPS URL.");
    }
    clean.url = serverConfig.url.trim();
    if (serverConfig.headers && typeof serverConfig.headers === "object" && Object.keys(serverConfig.headers).length > 0) {
      clean.headers = serverConfig.headers;
    }
  } else {
    const cmd = Array.isArray(serverConfig.command)
      ? serverConfig.command.filter(x => typeof x === "string" && x.trim() !== "")
      : parseCommandString(serverConfig.command);
    if (!cmd.length) {
      throw new Error("Local MCP server requires a command (e.g. npx -y @modelcontextprotocol/server-filesystem).");
    }
    clean.command = cmd;
    if (typeof serverConfig.cwd === "string" && serverConfig.cwd.trim()) {
      clean.cwd = serverConfig.cwd.trim();
    }
    if (serverConfig.environment && typeof serverConfig.environment === "object" && Object.keys(serverConfig.environment).length > 0) {
      clean.environment = serverConfig.environment;
    }
  }

  if (serverConfig.enabled === false) {
    clean.enabled = false;
  }

  const { text, config } = readConfig();
  let updatedText = text;

  // Ensure "mcp" block exists
  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
    updatedText = editText(updatedText, ["mcp"], { servers: {} });
  }

  // Ensure "mcp.servers" block exists
  const parsedMcp = (config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)) ? config.mcp : {};
  if (!parsedMcp.servers || typeof parsedMcp.servers !== "object" || Array.isArray(parsedMcp.servers)) {
    updatedText = editText(updatedText, ["mcp", "servers"], {});
  }

  // Write the server configuration
  updatedText = editText(updatedText, ["mcp", "servers", id], clean);
  writeConfig(text, updatedText);

  return { ok: true, id, server: clean };
}

/* ---- Toggle Enable / Disable MCP Server ---- */

export function toggleMcpServer(id, enabled) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Server ID is required.");
  }
  const { text, config } = readConfig();
  const inServers = Boolean(config.mcp?.servers && Object.prototype.hasOwnProperty.call(config.mcp.servers, id));
  const inRoot = Boolean(config.mcp && Object.prototype.hasOwnProperty.call(config.mcp, id) && id !== "servers" && id !== "timeout");

  if (!inServers && !inRoot) {
    throw new Error(`MCP server '${id}' not found in configuration.`);
  }

  const targetPath = inServers ? ["mcp", "servers", id, "enabled"] : ["mcp", id, "enabled"];
  const updatedText = editText(text, targetPath, Boolean(enabled));
  writeConfig(text, updatedText);
  return { ok: true, id, enabled: Boolean(enabled) };
}

/* ---- Delete MCP Server ---- */

export function deleteMcpServer(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Server ID is required.");
  }
  const { text, config } = readConfig();
  const inServers = Boolean(config.mcp?.servers && Object.prototype.hasOwnProperty.call(config.mcp.servers, id));
  const inRoot = Boolean(config.mcp && Object.prototype.hasOwnProperty.call(config.mcp, id) && id !== "servers" && id !== "timeout");

  if (!inServers && !inRoot) {
    throw new Error(`MCP server '${id}' not found in configuration.`);
  }

  let updatedText = text;
  if (inServers) {
    updatedText = editText(updatedText, ["mcp", "servers", id], undefined);
  }
  if (inRoot) {
    updatedText = editText(updatedText, ["mcp", id], undefined);
  }
  writeConfig(text, updatedText);
  return { ok: true, deleted: id };
}
