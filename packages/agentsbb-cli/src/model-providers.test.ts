import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  modelsUrl,
  parseCodebuddyProviderConfig,
  parseCodexConfig,
  parseHermesConfig,
  parseMcodeConfig,
  parseModelIds,
  parseOpenclawConfig,
  parseOpencodeConfig,
  parseQwenConfig,
  planCodexCredential,
  probeProviderModels,
  readAgentConfig,
} from "./model-providers.js";

function fakeResponse(body: string, ok = true): Response {
  return { ok, status: ok ? 200 : 500, text: async () => body } as unknown as Response;
}

describe("parseModelIds", () => {
  it("reads the OpenAI {data:[{id}]} envelope", () => {
    expect(parseModelIds(JSON.stringify({ data: [{ id: "glm-5.2" }, { id: "k3" }] }))).toEqual([
      "glm-5.2",
      "k3",
    ]);
  });

  it("reads openclaw-style {models:[{key}]} and plain arrays", () => {
    expect(parseModelIds(JSON.stringify({ models: [{ key: "openai/gpt-5" }] }))).toEqual([
      "openai/gpt-5",
    ]);
    expect(parseModelIds(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseModelIds(JSON.stringify([{ id: "x" }, "y", { nope: 1 }, 7]))).toEqual(["x", "y"]);
  });

  it("returns null when the body is not a model list", () => {
    expect(parseModelIds("not json")).toBeNull();
    expect(parseModelIds(JSON.stringify({ error: "nope" }))).toBeNull();
    expect(parseModelIds(JSON.stringify("glm-5.2"))).toBeNull();
  });

  it("drops blank ids", () => {
    expect(parseModelIds(JSON.stringify({ data: [{ id: "  " }, { id: " ok " }] }))).toEqual(["ok"]);
  });

  it("drops models a chat turn cannot use (embedding/rerank/tts/vl)", () => {
    const body = JSON.stringify({
      data: [
        { id: "glm-5.2" },
        { id: "BGE-m3" },
        { id: "Text-Embedding-V4-A" },
        { id: "Qwen3-Rerank-A" },
        { id: "Qwen-VL-Chat" },
        { id: "kimi-k2.7-code" },
        { id: "MiniMax-M3-A" },
        { id: "whisper-large-v3" },
      ],
    });
    expect(parseModelIds(body)).toEqual(["glm-5.2", "kimi-k2.7-code", "MiniMax-M3-A"]);
  });
});

describe("probeProviderModels", () => {
  it("GETs {base}/models with the configured bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(JSON.stringify({ data: [{ id: "k3" }] })));
    const ids = await probeProviderModels(
      { id: "quukk", baseUrl: "https://llmapi.quukk.com/v1/", apiKey: "sk-1" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(ids).toEqual(["k3"]);
    expect(modelsUrl("https://llmapi.quukk.com/v1/")).toBe("https://llmapi.quukk.com/v1/models");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://llmapi.quukk.com/v1/models");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-1" });
  });

  it("never rejects: HTTP errors and throws both yield null", async () => {
    const notOk = vi.fn().mockResolvedValue(fakeResponse("", false));
    expect(await probeProviderModels(
      { id: "p", baseUrl: "http://127.0.0.1:1/v1" },
      { fetchImpl: notOk as unknown as typeof fetch },
    )).toBeNull();

    const boom = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await probeProviderModels(
      { id: "p", baseUrl: "http://127.0.0.1:1/v1" },
      { fetchImpl: boom as unknown as typeof fetch },
    )).toBeNull();
  });
});

describe("parseOpenclawConfig", () => {
  it("reads models.providers baseUrl/apiKey", () => {
    const config = parseOpenclawConfig(JSON.stringify({
      models: { providers: { openai: { baseUrl: "http://127.0.0.1:49830/v1", apiKey: "sk-local-proxy" } } },
    }));
    expect(config.endpoints).toEqual([
      { id: "openai", baseUrl: "http://127.0.0.1:49830/v1", apiKey: "sk-local-proxy" },
    ]);
    // openclaw keeps its default in the model list, not in the config file.
    expect(config.defaultModel).toBeNull();
  });

  it("honours a models.default route and skips providers without a baseUrl", () => {
    const config = parseOpenclawConfig(JSON.stringify({
      models: { default: "openai/glm-5.2", providers: { broken: { apiKey: "x" } } },
    }));
    expect(config.endpoints).toEqual([]);
    expect(config.defaultModel).toBe("openai/glm-5.2");
  });

  it("returns nothing for junk", () => {
    expect(parseOpenclawConfig("not json").endpoints).toEqual([]);
    expect(parseOpenclawConfig(JSON.stringify({})).endpoints).toEqual([]);
  });
});

describe("parseCodexConfig", () => {
  const TOML = [
    'model = "glm-5.2"',
    'model_provider = "quukk_direct"',
    'model_reasoning_effort = "medium"',
    "",
    '[model_providers.quukk_direct]',
    'name = "Quukk Direct"',
    'base_url = "http://127.0.0.1:49830/v1"   # local gateway',
    'wire_api = "responses"',
    "",
    '[marketplaces.openai-bundled]',
    "source_type = 'local'",
    "",
  ].join("\n");

  it("reads the active provider and the table it points at", () => {
    const config = parseCodexConfig(TOML);
    expect(config.endpoints).toEqual([
      { id: "quukk_direct", name: "Quukk Direct", baseUrl: "http://127.0.0.1:49830/v1" },
    ]);
    expect(config.defaultModel).toBe("quukk_direct/glm-5.2");
  });

  it("ignores model_providers-named keys and a hash inside a quoted url", () => {
    const config = parseCodexConfig('base_url = "http://h/v1"\nmodel_providers = "x"\n');
    expect(config.endpoints).toEqual([]);
    expect(config.defaultModel).toBeNull();
  });

  // WEB-048：ChatGPT 账号登录（不写 model_providers）是 codex 最常见的配置形态，
  // 没有端点可 probe。至少要把它正在用的 `model` 交进目录，否则面板永远是
  // 「设备模型目录 · 0」，用户连当前模型都看不到。
  it("把配置里正在用的 model 作为可选项交出去（无 model_providers 的 OAuth 形态）", () => {
    const config = parseCodexConfig(['model = "gpt-5.6-codex"', 'model_reasoning_effort = "high"'].join("\n"));
    expect(config.endpoints).toEqual([]);
    expect(config.defaultModel).toBe("openai/gpt-5.6-codex");
    expect(config.declaredModels).toEqual({ openai: ["gpt-5.6-codex"] });
  });

  it("有 model_providers 时把 model 归到该 provider 名下", () => {
    const config = parseCodexConfig(TOML);
    expect(config.declaredModels).toEqual({ quukk_direct: ["glm-5.2"] });
  });

  it("keeps every declared provider, not just the active one", () => {
    const config = parseCodexConfig([
      '[model_providers."a.b"]',
      'base_url = "http://a/v1"',
      "[model_providers.second]",
      'base_url = "http://b/v1"',
      'api_key = "k"',
    ].join("\n"));
    expect(config.endpoints.map((e) => e.id)).toEqual(["a.b", "second"]);
    expect(config.endpoints[1].apiKey).toBe("k");
  });

  // codex 0.169 起 `api_key` 被忽略（`api_key is ignored`），真正生效的是
  // `env_key` 与 `http_headers`。这些用例锁住新形状的解析，缺一个面板就空态。
  it("resolves env_key from the process environment", () => {
    const config = parseCodexConfig([
      'model = "glm-5.2"',
      'model_provider = "quukk_direct"',
      "[model_providers.quukk_direct]",
      'base_url = "https://llmapi.quukk.com/v1"',
      'env_key = "QUUKK_API_KEY"',
    ].join("\n"), { QUUKK_API_KEY: "sk-env" });
    expect(config.endpoints).toEqual([{
      id: "quukk_direct",
      baseUrl: "https://llmapi.quukk.com/v1",
      apiKey: "sk-env",
      envKey: "QUUKK_API_KEY",
    }]);
  });

  it("reads an inline http_headers table and strips the Bearer prefix", () => {
    const config = parseCodexConfig([
      "[model_providers.quukk_direct]",
      'base_url = "https://llmapi.quukk.com/v1"',
      'api_key = "sk-stale"',
      'http_headers = { Authorization = "Bearer sk-live", X-Trace = "off" }',
    ].join("\n"));
    expect(config.endpoints[0].apiKey).toBe("sk-live");
    expect(config.endpoints[0].authHeader).toBe("sk-live");
  });

  it("reads a [model_providers.<id>.http_headers] sub-table", () => {
    const config = parseCodexConfig([
      "[model_providers.quukk_direct]",
      'base_url = "https://llmapi.quukk.com/v1"',
      "",
      "[model_providers.quukk_direct.http_headers]",
      'Authorization = "Bearer sk-sub"',
    ].join("\n"));
    expect(config.endpoints).toHaveLength(1);
    expect(config.endpoints[0].authHeader).toBe("sk-sub");
    expect(config.endpoints[0].apiKey).toBe("sk-sub");
  });
});

describe("planCodexCredential", () => {
  const apiKeyOnly = {
    endpoints: [{ id: "quukk_direct", baseUrl: "https://llmapi.quukk.com/v1", apiKey: "sk-x" }],
    defaultModel: "quukk_direct/glm-5.2",
  };

  it("injects via a config override when the file only has api_key", () => {
    const plan = planCodexCredential(apiKeyOnly, { env: {} });
    expect(plan).toEqual({
      provider: "quukk_direct",
      envKey: "AGENTSBB_CODEX_API_KEY",
      apiKey: "sk-x",
      needsConfigOverride: true,
      args: ["-c", 'model_providers.quukk_direct.env_key="AGENTSBB_CODEX_API_KEY"'],
    });
  });

  it("reuses the declared env_key name instead of adding a -c override", () => {
    const plan = planCodexCredential({
      endpoints: [{
        id: "quukk_direct",
        baseUrl: "https://llmapi.quukk.com/v1",
        apiKey: "sk-x",
        envKey: "QUUKK_API_KEY",
        authHeader: "sk-x",
      }],
      defaultModel: null,
    }, { env: {} });
    // 有内联头时 codex 自己能带上，完全不插手。
    expect(plan).toBeNull();

    const envOnly = planCodexCredential({
      endpoints: [{
        id: "quukk_direct",
        baseUrl: "https://llmapi.quukk.com/v1",
        apiKey: "sk-x",
        envKey: "QUUKK_API_KEY",
      }],
      defaultModel: null,
    }, { env: {} });
    expect(envOnly?.envKey).toBe("QUUKK_API_KEY");
    expect(envOnly?.args).toEqual([]);
  });

  it("stays out of the way when the key is already in the environment", () => {
    expect(planCodexCredential({
      endpoints: [{
        id: "quukk_direct",
        baseUrl: "https://llmapi.quukk.com/v1",
        apiKey: "sk-x",
        envKey: "QUUKK_API_KEY",
      }],
      defaultModel: null,
    }, { env: { QUUKK_API_KEY: "sk-x" } })).toBeNull();
    expect(planCodexCredential({ endpoints: [], defaultModel: null })).toBeNull();
    expect(planCodexCredential(null)).toBeNull();
  });

  it("only plans for the provider the turn actually uses", () => {
    const config = {
      endpoints: [
        { id: "a", baseUrl: "http://a/v1", apiKey: "ka" },
        { id: "b", baseUrl: "http://b/v1", apiKey: "kb" },
      ],
      defaultModel: null,
    };
    expect(planCodexCredential(config, { provider: "b", env: {} })?.apiKey).toBe("kb");
    expect(planCodexCredential(config, { provider: "missing", env: {} })).toBeNull();
  });
});

describe("parseHermesConfig", () => {
  const YAML = [
    "onboarding:",
    "  seen:",
    "    openclaw_residue_cleanup: true",
    "custom_providers:",
    "  - name: quukk",
    "    base_url: https://llmapi.quukk.com/v1",
    "    api_key: sk-Txc",
    "    api_mode: chat_completions",
    "    model: glm-5.3",
    "model:",
    "  default: glm-5.3",
    "  base_url: https://llmapi.quukk.com/v1",
    "  provider: quukk",
    "",
  ].join("\n");

  it("reads custom_providers and the default provider/model", () => {
    const config = parseHermesConfig(YAML);
    expect(config.endpoints).toEqual([
      { id: "quukk", name: "quukk", baseUrl: "https://llmapi.quukk.com/v1", apiKey: "sk-Txc" },
    ]);
    expect(config.defaultModel).toBe("quukk/glm-5.3");
  });

  it("returns nothing when there is no endpoint to probe", () => {
    const config = parseHermesConfig("model:\n  default: glm-5.3\n");
    expect(config.endpoints).toEqual([]);
    expect(config.defaultModel).toBeNull();
  });
});

describe("parseQwenConfig", () => {
  const SETTINGS = JSON.stringify({
    security: { auth: { selectedType: "openai" } },
    env: {
      OPENAI_API_KEY: "sk-Txc",
      OPENAI_BASE_URL: "https://llmapi.quukk.com/v1",
      OPENAI_MODEL: "glm-5.2",
    },
    model: { name: "glm-5.2" },
  });

  it("reads the OpenAI-compatible endpoint from settings.env", () => {
    const config = parseQwenConfig(SETTINGS);
    expect(config.endpoints).toEqual([
      { id: "quukk", baseUrl: "https://llmapi.quukk.com/v1", apiKey: "sk-Txc" },
    ]);
    expect(config.defaultModel).toBe("quukk/glm-5.2");
  });

  it("returns nothing when the endpoint is missing or the file is not JSON", () => {
    expect(parseQwenConfig(JSON.stringify({ env: { OPENAI_MODEL: "glm-5.2" } })).endpoints).toEqual([]);
    expect(parseQwenConfig("{not json")).toEqual({ endpoints: [], defaultModel: null });
  });
});

describe("parseCodebuddyProviderConfig", () => {
  const PROVIDER = JSON.stringify({
    provider: "quukk",
    name: "Quukk AI",
    baseUrl: "https://llmapi.quukk.com/v1",
    apiKey: "sk-Txc",
    defaultModel: "glm-5.2",
  });

  it("reads the self-hosted gateway described in agentsbb-provider.json", () => {
    const config = parseCodebuddyProviderConfig(PROVIDER);
    expect(config.endpoints).toEqual([
      { id: "quukk", name: "Quukk AI", baseUrl: "https://llmapi.quukk.com/v1", apiKey: "sk-Txc" },
    ]);
    expect(config.defaultModel).toBe("quukk/glm-5.2");
  });

  it("derives the provider id from the host when it is not written out", () => {
    const config = parseCodebuddyProviderConfig(JSON.stringify({
      baseUrl: "https://llmapi.quukk.com/v1",
    }));
    expect(config.endpoints[0]?.id).toBe("quukk");
    expect(config.defaultModel).toBeNull();
  });

  it("returns nothing without a baseUrl", () => {
    expect(parseCodebuddyProviderConfig(JSON.stringify({ apiKey: "sk" }))).toEqual({
      endpoints: [],
      defaultModel: null,
    });
    expect(parseCodebuddyProviderConfig("nope")).toEqual({ endpoints: [], defaultModel: null });
  });
});

// 固定 fixture（形状取自真实的 ~/.config/opencode/opencode.json，但**不是**
// 读本机文件）：opencode 把模型清单本身写在配置里，所以这一份既是端点来源，
// 也是 declaredModels 来源。测试不许碰跑测试那台机器的 home。
const OPENCODE_JSON = JSON.stringify({
  model: "quukk/glm-5.2",
  provider: {
    quukk: {
      name: "Quukk AI",
      options: { baseURL: "https://llmapi.example.com/v1", apiKey: "sk-test" },
      models: { "glm-5.2": {}, "glm-5.3": {}, k3: {} },
    },
    "empty-provider": {
      name: "No Models",
      options: { baseURL: "https://b.example.com/v1" },
    },
    "no-url": { name: "No URL", models: { x: {} } },
  },
});

describe("parseOpencodeConfig", () => {
  it("reads endpoints and the models each provider declares", () => {
    const config = parseOpencodeConfig(OPENCODE_JSON);
    // `provider` 的 key 就是 id；`options.baseURL` 决定它是不是可 probe 的端点。
    expect(config.endpoints).toEqual([
      {
        id: "quukk",
        name: "Quukk AI",
        baseUrl: "https://llmapi.example.com/v1",
        apiKey: "sk-test",
      },
      // 没有 models 但有 baseURL：端点仍然要报（目录靠 probe 补）。
      { id: "empty-provider", name: "No Models", baseUrl: "https://b.example.com/v1" },
    ]);
    // 没有 baseURL 的 provider 不是一个可连的端点。
    expect(config.endpoints.map((e) => e.id)).not.toContain("no-url");
  });

  it("declares models for every provider, including ones we cannot probe", () => {
    const config = parseOpencodeConfig(OPENCODE_JSON);
    // 顺序按配置书写顺序，不去重排序 —— 目录层自己会排。
    expect(config.declaredModels?.quukk).toEqual(["glm-5.2", "glm-5.3", "k3"]);
    // 没写 models 的 provider 不产生空清单（空清单会白白触发一次 probe）。
    expect(config.declaredModels?.["empty-provider"]).toBeUndefined();
    // 无 baseURL ≠ 不可用：opencode 的内置 provider 走 SDK 默认端点（如
    // `opencode/*-free`），模型是真能跑的，只是我们**无法 probe** 它。
    // 剔掉等于替用户隐藏可选项，所以它照样进 declaredModels（只是不进 endpoints）。
    expect(config.declaredModels?.["no-url"]).toEqual(["x"]);
    expect(config.endpoints.map((endpoint) => endpoint.id)).not.toContain("no-url");
  });

  it("returns the top-level model verbatim instead of re-assembling it", () => {
    // 顶层 model 本来就是 `provider/slug` 路由；再拼一次会得到 `quukk/quukk/...`。
    expect(parseOpencodeConfig(OPENCODE_JSON).defaultModel).toBe("quukk/glm-5.2");
  });

  it("leaves declaredModels out entirely when no provider declares any", () => {
    const config = parseOpencodeConfig(JSON.stringify({
      provider: { p: { options: { baseURL: "https://p.example.com/v1" } } },
    }));
    expect(config.endpoints.map((e) => e.id)).toEqual(["p"]);
    expect("declaredModels" in config).toBe(false);
    expect(config.defaultModel).toBeNull();
  });

  // opencode 的配置允许注释（真实 .jsonc 就带）。剥注释最容易写错的地方是
  // **字符串里的 `//`**：`"baseURL": "https://a//b"` 一旦被当成行注释，baseURL
  // 连同后面半份配置都会被吞掉，provider 全部消失。
  it("strips // and /* */ comments but never a // inside a string", () => {
    const jsonc = [
      "// opencode 配置支持注释",
      "{",
      '  "model": "quukk/glm-5.2",   // 行尾注释',
      '  "provider": {',
      '    "quukk": {',
      '      "name": "Quukk AI",',
      '      /* 块注释：端点与密钥',
      "         跨两行 */",
      '      "options": { "baseURL": "https://a//b", "apiKey": "sk-test" },',
      '      "models": { "glm-5.2": {}, "k3": {} }',
      "    },",
      '    "after": { "name": "After", "options": { "baseURL": "https://after.example.com/v1" } }',
      "  }",
      "}",
    ].join("\n");
    const config = parseOpencodeConfig(jsonc);
    expect(config.endpoints).toEqual([
      {
        id: "quukk",
        name: "Quukk AI",
        // 双斜杠必须原样保留，不能被当成注释的起点。
        baseUrl: "https://a//b",
        apiKey: "sk-test",
      },
      // 注释之后声明的 provider 也必须还在：注释若吞掉换行，后面的 token 会粘连。
      { id: "after", name: "After", baseUrl: "https://after.example.com/v1" },
    ]);
    expect(config.declaredModels).toEqual({ quukk: ["glm-5.2", "k3"] });
    expect(config.defaultModel).toBe("quukk/glm-5.2");
  });

  it("returns an empty config (never throws) for unusable input", () => {
    for (const text of ["", "not json", "[]", "null"]) {
      expect(parseOpencodeConfig(text)).toEqual({ endpoints: [], defaultModel: null });
    }
  });

  // 2026-11-16 现场（小久，opencode 2.1.4）：官方安装器装的 2.x 读 **V2 形态**
  // （providers 复数 + package + settings）；V1 引擎遇到 providers 段会整段
  // 丢弃并打 compatibility WARN。解析器必须两代都收，否则 2.x 机器的目录
  // 永远缺配置里声明的供应商。
  it("reads the V2 shape: providers + package + settings", () => {
    const config = parseOpencodeConfig(JSON.stringify({
      model: "quukk/glm-5.2",
      providers: {
        quukk: {
          name: "Quukk AI",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "https://llmapi.example.com/v1", apiKey: "sk-v2" },
          models: { "glm-5.2": { name: "GLM 5.2" }, "k3": { name: "K3" } },
        },
        "no-url": { name: "No URL", models: { x: {} } },
      },
    }));
    expect(config.endpoints).toEqual([
      { id: "quukk", name: "Quukk AI", baseUrl: "https://llmapi.example.com/v1", apiKey: "sk-v2" },
    ]);
    expect(config.declaredModels).toEqual({ quukk: ["glm-5.2", "k3"], "no-url": ["x"] });
    expect(config.defaultModel).toBe("quukk/glm-5.2");
  });

  it("prefers the V2 providers entry wholesale when both shapes declare the same id", () => {
    const config = parseOpencodeConfig(JSON.stringify({
      provider: {
        quukk: { name: "V1 Name", options: { baseURL: "https://v1.example.com/v1", apiKey: "sk-v1" } },
        v1only: { options: { baseURL: "https://v1only.example.com/v1" } },
      },
      providers: {
        quukk: {
          name: "V2 Name",
          settings: { baseURL: "https://v2.example.com/v1", apiKey: "sk-v2" },
          models: { "glm-5.2": {} },
        },
      },
    }));
    const quukk = config.endpoints.filter((e) => e.id === "quukk");
    // 同 id 只留 V2 条目，不并字段、不重复。
    expect(quukk).toEqual([
      { id: "quukk", name: "V2 Name", baseUrl: "https://v2.example.com/v1", apiKey: "sk-v2" },
    ]);
    expect(config.endpoints.map((e) => e.id)).toContain("v1only");
    expect(config.declaredModels).toEqual({ quukk: ["glm-5.2"] });
  });
});

describe("readAgentConfig", () => {
  const OPENCLAW_JSON = JSON.stringify({
    models: { providers: { openai: { baseUrl: "http://127.0.0.1:49830/v1" } } },
  });

  it("reads openclaw.json from the agent's config directory", () => {
    const home = join("/", "home", "u");
    const path = join(home, ".openclaw", "openclaw.json");
    const readFile = vi.fn((p: string) => {
      if (p === path) return OPENCLAW_JSON;
      throw new Error("ENOENT");
    });
    const config = readAgentConfig("openclaw", { home, env: {}, readFile });
    expect(config?.endpoints).toHaveLength(1);
    expect(readFile).toHaveBeenCalledWith(path);
  });

  it("prefers CODEX_HOME and returns null when the file is missing", () => {
    const home = join("/", "home", "u");
    const codexHome = join("/", "opt", "codex");
    const path = join(codexHome, "config.toml");
    const readFile = vi.fn((p: string) => {
      if (p === path) return 'model = "glm-5.2"\nmodel_provider = "quukk_direct"\n';
      throw new Error("ENOENT");
    });
    const config = readAgentConfig("codex", { home, env: { CODEX_HOME: codexHome }, readFile });
    expect(config?.defaultModel).toBe("quukk_direct/glm-5.2");
    expect(readAgentConfig("codex", { home, env: {}, readFile: () => { throw new Error("ENOENT"); } })).toBeNull();
  });

  it("reads opencode.json from ~/.config/opencode", () => {
    const home = join("/", "home", "u");
    const path = join(home, ".config", "opencode", "opencode.json");
    const readFile = vi.fn((p: string) => {
      if (p === path) return OPENCODE_JSON;
      throw new Error("ENOENT");
    });
    const config = readAgentConfig("opencode", { home, env: {}, readFile });
    expect(config?.endpoints.map((endpoint) => endpoint.id)).toEqual(["quukk", "empty-provider"]);
    expect(config?.defaultModel).toBe("quukk/glm-5.2");
    expect(config?.declaredModels?.quukk).toEqual(["glm-5.2", "glm-5.3", "k3"]);
    expect(readFile).toHaveBeenCalledWith(path);
  });

  it("tries XDG_CONFIG_HOME and the .jsonc fallback before giving up", () => {
    const home = join("/", "home", "u");
    const xdg = join("/", "xdg");
    const jsoncPath = join(xdg, "opencode", "opencode.jsonc");
    const readFile = vi.fn((p: string) => {
      if (p === jsoncPath) return `// jsonc\n${OPENCODE_JSON}`;
      throw new Error("ENOENT");
    });
    const config = readAgentConfig("opencode", { home, env: { XDG_CONFIG_HOME: xdg }, readFile });
    expect(config?.defaultModel).toBe("quukk/glm-5.2");
    // 先试 XDG 的 .json，再试 .jsonc —— 顺序固定，不能反过来先吃 .json。
    expect(readFile.mock.calls.map(([p]) => p)).toEqual([
      join(xdg, "opencode", "opencode.json"),
      jsoncPath,
    ]);
  });

  it("reads DevEco's official user config path (~/.config/deveco/deveco.jsonc)", () => {
    const home = mkdtempSync(join(tmpdir(), "deveco-cfg-"));
    const path = join(home, ".config", "deveco", "deveco.jsonc");
    mkdirSync(join(home, ".config", "deveco"), { recursive: true });
    // 官方文件带 $schema 和 JSONC 注释，parseOpencodeConfig 必须照单全收。
    writeFileSync(path, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "quukk/glm-5.2",
      provider: {
        quukk: {
          name: "Quukk AI",
          options: { baseURL: "https://example.invalid/v1", apiKey: "sk-test" },
          models: { "glm-5.2": { tool_call: true } },
        },
      },
    }, null, 2).replace('"model"', '// user models\n  "model"'));

    const config = readAgentConfig("deveco", { home, cwd: join(home, "empty-project") });
    expect(config?.defaultModel).toBe("quukk/glm-5.2");
    expect(config?.declaredModels?.quukk).toEqual(["glm-5.2"]);
    expect(config?.endpoints[0].baseUrl).toBe("https://example.invalid/v1");
  });

  it("prefers a project-level .deveco/deveco.jsonc over the user config", () => {
    const home = mkdtempSync(join(tmpdir(), "deveco-cfg-"));
    const project = join(home, "project");
    mkdirSync(join(home, ".config", "deveco"), { recursive: true });
    mkdirSync(join(project, ".deveco"), { recursive: true });
    writeFileSync(join(home, ".config", "deveco", "deveco.jsonc"), JSON.stringify({
      model: "user/m",
    }));
    writeFileSync(join(project, ".deveco", "deveco.jsonc"), JSON.stringify({
      model: "project/m",
    }));

    expect(readAgentConfig("deveco", { home, cwd: project })?.defaultModel).toBe("project/m");
  });

  it("returns null when no opencode config exists", () => {
    const home = join("/", "home", "u");
    expect(readAgentConfig("opencode", {
      home,
      env: {},
      readFile: () => { throw new Error("ENOENT"); },
    })).toBeNull();
  });

  it("has nothing for agents with no config reader", () => {
    // kimi 没有配置解析器（本机无字段样本，不猜）——不读任何文件，直接 null。
    const readFile = vi.fn(() => { throw new Error("should not read"); });
    expect(readAgentConfig("kimi", { home: "/home/u", env: {}, readFile })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(readAgentConfig(undefined, {})).toBeNull();
  });
});

// --- small_model 对齐主模型（2026-11-05 现场） ------------------------------

import { buildDeviceOpencodeConfig, LEAN_AGENT_SYSTEM_PROMPT, TERSE_AGENT_SYSTEM_PROMPT } from "./model-providers.js";

describe("buildDeviceOpencodeConfig small_model 对齐", () => {
  it("small_model 与主 model 不一致时对齐到主 model（防小模型欠费拖慢 title 生成）", () => {
    const raw = JSON.stringify({
      model: "quukk/glm-5.2",
      small_model: "quukk/deepseek-v4-flash",
      provider: { quukk: { models: {} } },
      plugin: ["x"],
      mcp: { y: {} },
    });
    const built = buildDeviceOpencodeConfig(raw, {});
    expect(built).not.toBeNull();
    const parsed = JSON.parse(built!.text);
    expect(parsed.small_model).toBe("quukk/glm-5.2");
    expect(parsed.model).toBe("quukk/glm-5.2");
    expect(built!.dropped).toContain("plugin");
    expect(built!.dropped).toContain("mcp");
    expect(built!.dropped.some((d) => d.startsWith("small_model:"))).toBe(true);
  });

  it("small_model 与主 model 一致 / 未配置时不动", () => {
    const same = buildDeviceOpencodeConfig(
      JSON.stringify({ model: "a/x", small_model: "a/x" }), {},
    );
    expect(JSON.parse(same!.text).small_model).toBe("a/x");
    expect(same!.dropped.some((d) => d.startsWith("small_model:"))).toBe(false);

    const absent = buildDeviceOpencodeConfig(JSON.stringify({ model: "a/x" }), {});
    expect(JSON.parse(absent!.text).small_model).toBeUndefined();
  });
});

// --- 精简回合：换掉 build 系统提示 + 关全部工具（2026-11-12 实测 2.9万 → 1.7千 token）

describe("buildDeviceOpencodeConfig lean 回合", () => {
  const raw = JSON.stringify({
    model: "quukk/glm-5.2",
    provider: { quukk: { models: {} } },
    agent: { "my-helper": { prompt: "用户自己的子 agent" } },
  });

  it("把 build 换成只输出 JSON 的人格，并用通配符关掉全部工具", () => {
    const built = buildDeviceOpencodeConfig(raw, { lean: true });
    expect(built).not.toBeNull();
    const parsed = JSON.parse(built!.text);
    expect(parsed.agent.build.prompt).toBe(LEAN_AGENT_SYSTEM_PROMPT);
    // 通配符而不是逐条枚举：opencode 新加的工具不必跟着改这张表。
    expect(parsed.agent.build.tools).toEqual({ "*": false });
    // 用户自己的 agent 必须原样保留 —— 精简回合只改 build 这一个人格。
    expect(parsed.agent["my-helper"]).toEqual({ prompt: "用户自己的子 agent" });
    // 模型与 provider 不受影响。
    expect(parsed.model).toBe("quukk/glm-5.2");
    expect(parsed.provider).toEqual({ quukk: { models: {} } });
  });

  it("不带 lean 时不碰 agent：聊天轮次的人格与工具保持原样", () => {
    const built = buildDeviceOpencodeConfig(raw, {});
    const parsed = JSON.parse(built!.text);
    expect(parsed.agent).toEqual({ "my-helper": { prompt: "用户自己的子 agent" } });
    expect(parsed.agent.build).toBeUndefined();
  });

  it("lean 与 fsRestricted 叠加时两套键都在", () => {
    const built = buildDeviceOpencodeConfig(raw, { lean: true, fsRestricted: true });
    const parsed = JSON.parse(built!.text);
    expect(parsed.agent.build.tools).toEqual({ "*": false });
    expect(parsed.tools.read).toBe(false);
    expect(parsed.permission.bash).toBe("deny");
  });
});

// --- 发言回合：只换 build 系统提示、工具照旧（讨论组/群聊 2026-11-24）

describe("buildDeviceOpencodeConfig terse 回合", () => {
  const raw = JSON.stringify({
    model: "quukk/glm-5.2",
    agent: { build: { tools: { bash: true } }, "my-helper": { prompt: "用户自己的子 agent" } },
  });

  it("换掉 build 提示但保留用户声明的工具配置", () => {
    const built = buildDeviceOpencodeConfig(raw, { terse: true });
    const parsed = JSON.parse(built!.text);
    expect(parsed.agent.build.prompt).toBe(TERSE_AGENT_SYSTEM_PROMPT);
    // 关键差异：terse 不写 tools 覆盖，用户原有的工具开关原样保留 —— 讨论组里
    // 用户仍然可以让 agent 读文件、跑命令。
    expect(parsed.agent.build.tools).toEqual({ bash: true });
    expect(parsed.agent.build.tools["*"]).toBeUndefined();
    expect(parsed.agent["my-helper"]).toEqual({ prompt: "用户自己的子 agent" });
  });

  it("lean 优先于 terse：需要 JSON 的回合不能被发言提示覆盖", () => {
    const built = buildDeviceOpencodeConfig(raw, { lean: true, terse: true });
    const parsed = JSON.parse(built!.text);
    expect(parsed.agent.build.prompt).toBe(LEAN_AGENT_SYSTEM_PROMPT);
    expect(parsed.agent.build.tools).toEqual({ "*": false });
  });

  it("不带 terse 时不动 agent（私聊轮次保持 build 原人格）", () => {
    const built = buildDeviceOpencodeConfig(raw, {});
    expect(JSON.parse(built!.text).agent.build).toEqual({ tools: { bash: true } });
  });
});

describe("parseMcodeConfig（mcode ~/.minimax/config.yaml）", () => {
  // 2026-11-17 本机真机配置的结构（密钥换成占位，模型/键名保留）。
  const YAML = [
    "logLevel: info",
    "defaultModel: custom_provider:quukkai/glm-5.2",
    "provider:",
    "  minimax:",
    "    name: MiniMax",
    "    options:",
    "      apiKey: sk-xxx",
    "      baseURL: https://agent.minimaxi.com/v1",
    "    models:",
    "      MiniMax-M3:",
    "        name: M3",
    "        limit:",
    "          context: 512000",
    "      MiniMax-M3.1-Flash:",
    "        name: M3.1-Flash",
    "custom_provider:",
    "  quukkai:",
    "    name: QuukkAI",
    "    options:",
    "      apiKey: sk-real",
    "      baseURL: https://llmapi.quukk.com/v1",
    "    models:",
    "      glm-5.2:",
    "        reasoning: true",
    "        thinking_config:",
    "          mode: switchable",
    "      glm-5.3:",
    "        reasoning: true",
  ].join("\n");

  it("strips custom_provider: from default and reads both provider namespaces", () => {
    const cfg = parseMcodeConfig(YAML);
    // 只看模型行（缩进 6），不把 limit/thinking_config 等子键当模型。
    expect(cfg.defaultModel).toBe("quukkai/glm-5.2");
    expect(cfg.declaredModels).toEqual({
      minimax: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
      quukkai: ["glm-5.2", "glm-5.3"],
    });
    expect(cfg.endpoints).toEqual([
      { id: "minimax", baseUrl: "https://agent.minimaxi.com/v1", apiKey: "sk-xxx" },
      { id: "quukkai", baseUrl: "https://llmapi.quukk.com/v1", apiKey: "sk-real" },
    ]);
  });

  it("degrades to empty config on junk", () => {
    expect(parseMcodeConfig("not yaml at all")).toEqual({
      endpoints: [], defaultModel: null,
    });
  });
});

describe("新增四家的 config 路径与能力登记", () => {
  it("codearts / deveco / mcode 都有 config parser + path", () => {
    const home = mkdtempSync(join(tmpdir(), "mcode-cfg-"));
    // mcode: ~/.minimax/config.yaml
    mkdirSync(join(home, ".minimax"), { recursive: true });
    writeFileSync(join(home, ".minimax", "config.yaml"), [
      "defaultModel: custom_provider:q/g",
      "custom_provider:",
      "  q:",
      "    options:",
      "      baseURL: https://example.invalid/v1",
      "    models:",
      "      g:",
      "        reasoning: true",
    ].join("\n"));
    const cfg = readAgentConfig("mcode", { home });
    expect(cfg?.defaultModel).toBe("q/g");
    expect(cfg?.declaredModels?.q).toEqual(["g"]);
  });

  it("qwenpaw / mcode 的能力矩阵是 cli/config + argv（可发现且可注入）", async () => {
    const { agentModelCapability } = await import("./agent-model-capabilities.js");
    expect(agentModelCapability("qwenpaw")).toEqual({ catalogSource: "cli", modelInjection: "argv" });
    expect(agentModelCapability("mcode")).toEqual({ catalogSource: "config", modelInjection: "argv" });
    expect(agentModelCapability("deveco")).toEqual({ catalogSource: "cli", modelInjection: "argv" });
    expect(agentModelCapability("codearts")).toEqual({ catalogSource: "cli", modelInjection: "argv" });
  });
});
