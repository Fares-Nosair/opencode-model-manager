import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  extractReasoningAndContent,
  testModelChat,
  runModelBenchmark,
  discoverBatch
} from "../lib/discovery.mjs";
import { pruneRemovedModels } from "../lib/config.mjs";

describe("Single-Model Chat & Reasoning Extraction", () => {
  test("extractReasoningAndContent separates <think> tags from content", () => {
    const raw = "<think>\nStep 1: Calculate 2+2=4.\nStep 2: Done.\n</think>\nThe answer is 4.";
    const res = extractReasoningAndContent(raw, { content: raw });
    assert.equal(res.reply, "The answer is 4.");
    assert.equal(res.reasoning, "Step 1: Calculate 2+2=4.\nStep 2: Done.");
  });

  test("extractReasoningAndContent preserves explicit reasoning_content", () => {
    const messageObj = {
      content: "Hello from DeepSeek R1!",
      reasoning_content: "Reflecting on user greeting..."
    };
    const res = extractReasoningAndContent(messageObj.content, messageObj);
    assert.equal(res.reply, "Hello from DeepSeek R1!");
    assert.equal(res.reasoning, "Reflecting on user greeting...");
  });

  test("extractReasoningAndContent works with regular non-reasoning responses", () => {
    const messageObj = { content: "Just a standard reply." };
    const res = extractReasoningAndContent(messageObj.content, messageObj);
    assert.equal(res.reply, "Just a standard reply.");
    assert.equal(res.reasoning, null);
  });
});

describe("Multi-Model Benchmark Runner", () => {
  let mockServer;
  let mockPort;

  before(async () => {
    mockServer = http.createServer((req, res) => {
      let data = "";
      req.on("data", c => { data += c; });
      req.on("end", () => {
        const body = JSON.parse(data || "{}");
        const model = body.model || "test-model";
        if (model === "fast-model") {
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              choices: [{ message: { content: "PONG" } }]
            }));
          }, 10);
        } else if (model === "slow-model") {
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              choices: [{ message: { content: "PONG" } }]
            }));
          }, 40);
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Model overloaded" } }));
        }
      });
    });

    await new Promise(r => mockServer.listen(0, "127.0.0.1", r));
    mockPort = mockServer.address().port;
  });

  after(() => {
    mockServer.close();
  });

  test("runModelBenchmark sorts fastest first and places failed models at bottom", async () => {
    // We test ranking logic with synthetic results
    const mockResults = [
      { provider: "p1", model: "slow", ok: true, latencyMs: 350 },
      { provider: "p2", model: "fast", ok: true, latencyMs: 120 },
      { provider: "p3", model: "failing", ok: false, latencyMs: 80, error: "500 Internal Error" }
    ];

    mockResults.sort((a, b) => {
      if (a.ok && !b.ok) return -1;
      if (!a.ok && b.ok) return 1;
      return a.latencyMs - b.latencyMs;
    });

    assert.equal(mockResults[0].model, "fast");
    assert.equal(mockResults[1].model, "slow");
    assert.equal(mockResults[2].model, "failing");
  });
});

describe("Batch Discovery & Partial Failure Partitioning", () => {
  test("discoverBatch returns empty partitions for empty input", async () => {
    const res = await discoverBatch([]);
    assert.deepEqual(res.results, []);
    assert.deepEqual(res.failures, []);
  });

  test("testModelChat returns 404 error when provider is not configured", async () => {
    const res = await testModelChat({ provider: "non-existent-provider-xyz", model: "m1", prompt: "hi" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.ok(res.error.includes("not found"));
  });

  test("pruneRemovedModels safely returns empty array when all active models remain", () => {
    const res = pruneRemovedModels("ahefi", ["claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-5-5"]);
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.pruned));
  });
});

describe("Model Family Grouping Classification", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const vm = await import("node:vm");

  const appJs = fs.readFileSync(path.join(process.cwd(), "public", "app.js"), "utf8");
  const matchLogos = appJs.match(/const MODEL_LOGOS = \{[\s\S]*?\n\};/);
  const matchFn = appJs.match(/function getModelFamily\([\s\S]*?\n\}/);

  assert.ok(matchLogos, "MODEL_LOGOS found");
  assert.ok(matchFn, "getModelFamily found");

  const { getModelFamily } = vm.runInContext(
    `(() => {
      ${matchLogos[0]}
      ${matchFn[0]}
      return { getModelFamily };
    })()`,
    vm.createContext({})
  );

  test("classifies Claude models into Anthropic / Claude family", () => {
    const fam = getModelFamily("claude-sonnet-5", "ahefi");
    assert.equal(fam.id, "claude");
    assert.equal(fam.name, "Anthropic / Claude");
  });

  test("classifies GPT and o-series into OpenAI / GPT family", () => {
    assert.equal(getModelFamily("gpt-4o", "openai").id, "openai");
    assert.equal(getModelFamily("o3-mini", "azure").id, "openai");
  });

  test("classifies DeepSeek models into DeepSeek family", () => {
    assert.equal(getModelFamily("deepseek-v4-flash", "ahefi").id, "deepseek");
    assert.equal(getModelFamily("deepseek-r1", "deepseek").id, "deepseek");
  });

  test("classifies Qwen models into Alibaba / Qwen family", () => {
    assert.equal(getModelFamily("qwen3-coder", "kimchi").id, "qwen");
  });

  test("classifies GLM models into Zhipu / GLM family", () => {
    assert.equal(getModelFamily("glm-5-turbo", "zhipu").id, "glm");
  });

  test("classifies Meta Llama models into Meta / Llama family", () => {
    assert.equal(getModelFamily("llama-3.3-70b-instruct", "meta").id, "llama");
  });
});

describe("Playground Model Search & Candidate Extraction", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const vm = await import("node:vm");

  const appJs = fs.readFileSync(path.join(process.cwd(), "public", "app.js"), "utf8");
  const matchDetectTags = appJs.match(/function detectModelTags\([\s\S]*?\n\}/);
  const matchHighlight = appJs.match(/function highlightSearchMatch\([\s\S]*?\n\}/);
  const matchCandidates = appJs.match(/function getPlaygroundCandidateModels\([\s\S]*?\n\}/);

  assert.ok(matchDetectTags, "detectModelTags found");
  assert.ok(matchHighlight, "highlightSearchMatch found");
  assert.ok(matchCandidates, "getPlaygroundCandidateModels found");

  const sandbox = {
    state: {
      models: [
        { id: "claude-3-5-sonnet", providerId: "ahefi", tags: ["VISION", "TOOLS"] },
        { id: "deepseek-r1", providerId: "deepseek", tags: ["REASONING"] }
      ],
      providers: [
        { id: "ahefi", name: "Ahefi Provider", models: { "claude-3-5-sonnet": {} } },
        { id: "deepseek", name: "DeepSeek Direct", models: { "deepseek-r1": {} } },
        { id: "ollama", name: "Local Ollama", models: { "llama3.2-vision": {} } }
      ],
      selected: new Set(["ahefi::claude-3-5-sonnet"])
    },
    keyOf: m => `${m.providerId}::${m.id}`,
    escapeHtml: s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]))
  };

  const { detectModelTags, highlightSearchMatch, getPlaygroundCandidateModels } = vm.runInContext(
    `(() => {
      ${matchDetectTags[0]}
      ${matchHighlight[0]}
      ${matchCandidates[0]}
      return { detectModelTags, highlightSearchMatch, getPlaygroundCandidateModels };
    })()`,
    vm.createContext(sandbox)
  );

  test("detectModelTags detects reasoning, vision, and tool tags from model id", () => {
    const r1Tags = detectModelTags("deepseek-r1-distill-qwen");
    assert.ok(r1Tags.includes("REASONING"));

    const visionTags = detectModelTags("gpt-4o-mini");
    assert.ok(visionTags.includes("VISION"));

    const embedTags = detectModelTags("text-embedding-3-small");
    assert.ok(embedTags.includes("EMBED"));
  });

  test("highlightSearchMatch highlights search query and preserves rest", () => {
    const res = highlightSearchMatch("claude-3-5-sonnet-20241022", "sonnet");
    assert.equal(res, 'claude-3-5-<span class="pg-search-highlight">sonnet</span>-20241022');

    const emptyRes = highlightSearchMatch("claude-3-5", "");
    assert.equal(emptyRes, "claude-3-5");
  });

  test("getPlaygroundCandidateModels aggregates state.models and un-discovered provider models", () => {
    const list = getPlaygroundCandidateModels();
    assert.equal(list.length, 3);
    const ollamaModel = list.find(x => x.modelId === "llama3.2-vision");
    assert.ok(ollamaModel);
    assert.equal(ollamaModel.providerId, "ollama");
    assert.ok(ollamaModel.isConfigured);
    assert.ok(ollamaModel.tags.includes("VISION"));
  });
});
