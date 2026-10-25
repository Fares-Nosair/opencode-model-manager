function ahefiPreset() {
  return {
    upstreamBaseURL: "https://ahefi.com/v1",
    headers: {
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
    },
    dynamicHeaders: {
      "X-Ahefi-Task-ID": "{{uuid}}",
      "X-Stainless-Runtime-Version": "{{node_version}}"
    },
    bodyOverrides: { stream: true, stream_options: { include_usage: true } },
    defaultModel: "deepseek-v4.1-flash",
    timeoutMs: 120000,
    apiKeySource: "incoming"
  };
}

export { ahefiPreset };

export function getPresets() {
  return {
    ahefi: {
      id: "ahefi",
      name: "Ahefi",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Ahefi provider with architect mode, task ID, and Stainless headers",
      ...ahefiPreset()
    },
    ollama: {
      id: "ollama",
      name: "Ollama (Local)",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Local Ollama server running at port 11434",
      upstreamBaseURL: "http://localhost:11434/v1",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "llama3.2",
      timeoutMs: 300000,
      apiKeySource: "incoming"
    },
    lmstudio: {
      id: "lmstudio",
      name: "LM Studio (Local)",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Local LM Studio server running at port 1234",
      upstreamBaseURL: "http://localhost:1234/v1",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "",
      timeoutMs: 300000,
      apiKeySource: "incoming"
    },
    vllm: {
      id: "vllm",
      name: "vLLM",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "vLLM server running OpenAI-compatible completions",
      upstreamBaseURL: "http://localhost:8000/v1",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "",
      timeoutMs: 120000,
      apiKeySource: "incoming"
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "OpenRouter gateway with HTTP-Referer and X-Title headers",
      upstreamBaseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://opencode.ai",
        "X-Title": "OpenCode"
      },
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "anthropic/claude-3.5-sonnet",
      timeoutMs: 120000,
      apiKeySource: "incoming"
    },
    groq: {
      id: "groq",
      name: "Groq",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Ultra-fast LPU inference API",
      upstreamBaseURL: "https://api.groq.com/openai/v1",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "llama-3.3-70b-versatile",
      timeoutMs: 60000,
      apiKeySource: "incoming"
    },
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Official DeepSeek API endpoint",
      upstreamBaseURL: "https://api.deepseek.com/v1",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "deepseek-chat",
      timeoutMs: 120000,
      apiKeySource: "incoming"
    },
    gemini: {
      id: "gemini",
      name: "Google Gemini (OpenAI compat)",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Google Gemini via native OpenAI-compatible endpoint",
      upstreamBaseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "gemini-2.5-flash",
      timeoutMs: 120000,
      apiKeySource: "incoming"
    },
    together: {
      id: "together",
      name: "Together AI",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Together AI cloud inference platform",
      upstreamBaseURL: "https://api.together.xyz/v1",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      timeoutMs: 120000,
      apiKeySource: "incoming"
    },
    mistral: {
      id: "mistral",
      name: "Mistral",
      package: "@opencode-ai/ai/providers/openai-compatible",
      description: "Official Mistral AI API platform",
      upstreamBaseURL: "https://api.mistral.ai/v1",
      headers: {},
      dynamicHeaders: {},
      bodyOverrides: { stream: true, stream_options: { include_usage: true } },
      defaultModel: "mistral-large-latest",
      timeoutMs: 120000,
      apiKeySource: "incoming"
    }
  };
}

export function getPreset(name) {
  return getPresets()[name] || null;
}
