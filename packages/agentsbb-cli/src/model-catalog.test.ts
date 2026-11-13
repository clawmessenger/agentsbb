import { describe, expect, it, vi } from "vitest";
import {
  agentModelCapability,
  AGENT_MODEL_CAPABILITIES,
} from "./agent-model-capabilities.js";
import {
  buildModelCatalogResponse,
  catalogFromRoutes,
  createModelCatalogLoader,
  dshModelsFrameComplete,
  EMPTY_MODEL_CATALOG,
  modelListSpec,
  parseAgyModelsList,
  parseDshModelListJsonl,
  parseGrokModelsList,
  parseKimiProviderListJson,
  parseModelCatalogOutput,
  parseModelCatalogRequest,
  parseModelListText,
  parseOpenclawModelListJson,
  parsePiModelsList,
} from "./model-catalog.js";
import { KNOWN_AGENT_CLIS } from "./agents.js";
import { staticModelCatalogFor } from "./model-static-catalogs.js";
import { MessageDispatcher, type InboundIMMessage } from "./im.js";

const OPENCODE_OUTPUT = [
  "opencode/big-pickle",
  "opencode/exo-free",
  "agent-plan/glm-5.3",
  "agent-plan/kimi-k3",
  "quukk/deepseek-v4-pro",
  "",
].join("\n");

// Real shape from OpenClaw 2026.9.2 (`openclaw models list`).
const OPENCLAW_TABLE = [
  "Config warnings: plugins.entries.pcmgr: plugin not found (stale config entry ignored)",
  "Model                                      Input      Ctx         Local Auth  Tags",
  "openai/gpt-5.6-sol                         -          -           yes   yes   default",
  "openai/gpt-5.6-mini                        -          -           yes   yes",
].join("\n");

const OPENCLAW_JSON = JSON.stringify({
  count: 2,
  models: [
    { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", tags: ["default"], local: true },
    { key: "openai/gpt-5.6-mini", name: "GPT-5.6 Mini", tags: [] },
  ],
});

// 真实输出（2026-11 真机实测 `dsh --profile multica --list-models`，单行 JSONL 帧）。
// 关键事实：版本字段是 `v`；`id` 已经是 `provider/model` 路由；`provider` 是展示名
// （"Quukk AI"/"DeepSeek"，含空格）；`thinking` 档位在 wire 协议里无对应字段。
const DSH_OUTPUT = [
  '{"v":1,"type":"ready","runtime":"dsh"}',
  JSON.stringify({
    v: 1,
    type: "models",
    models: [
      {
        id: "deepseek-official/deepseek-v4-flash",
        label: "DeepSeek-V4-Flash",
        provider: "DeepSeek",
        default: false,
        thinking: {
          supported_levels: [
            { value: "off", label: "Off" },
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
            { value: "max", label: "Max" },
          ],
          default_level: "high",
        },
      },
      {
        id: "deepseek-official/deepseek-v4-pro",
        label: "DeepSeek-V4-Pro",
        provider: "DeepSeek",
        default: false,
      },
      { id: "quukk/glm-5.2", label: "GLM 5.2", provider: "Quukk AI", default: true },
      { id: "quukk/glm-5.3", label: "GLM 5.3", provider: "Quukk AI", default: false },
      { id: "quukk/deepseek-v4-pro", label: "DeepSeek-V4-Pro", provider: "Quukk AI" },
      { id: "quukk/deepseek-v4-flash", label: "DeepSeek-V4-Flash", provider: "Quukk AI" },
      { id: "quukk/k3", label: "Kimi K3", provider: "Quukk AI" },
      { id: "quukk/kimi-k2.7-code", label: "Kimi K2.7 Code", provider: "Quukk AI" },
    ],
  }),
].join("\n");

// 真实输出（2026-11 真机实测 `grok models`，exit 0，人类可读文本）。
const GROK_OUTPUT = [
  "Model 'quukk-glm-5.2' is using its own API key.",
  "",
  "Default model: quukk-glm-5.2",
  "",
  "Available models:",
  "  - grok-4.7",
  "  * quukk-glm-5.2 (default)",
  "  - quukk-glm-5.3",
  "  - quukk-deepseek-v4-pro",
  "  - quukk-kimi-k2-7-code",
].join("\n");

// 真实形状（2026-11 真机实测 `kimi provider list --json`，exit 0）。
// ⚠️ providers.*.apiKey 是明文真实密钥：fixture 用假值，并断言它绝不进 catalog。
const KIMI_PROVIDER_JSON = JSON.stringify({
  providers: {
    quukk: { baseUrl: "https://llmapi.example.com/v1", type: "openai", apiKey: "sk-fake-not-real" },
  },
  models: {
    "quukk/glm-5.2": {
      provider: "quukk",
      model: "glm-5.2",
      displayName: "GLM 5.2",
      maxContextSize: 131072,
      capabilities: ["tool_use", "thinking"],
    },
    "quukk/kimi-for-coding-highspeed": {
      provider: "quukk",
      model: "kimi-for-coding-highspeed",
      displayName: "Kimi for Coding Highspeed",
    },
  },
});

describe("parseModelCatalogRequest", () => {
  it("accepts the web's v2 request", () => {
    const request = parseModelCatalogRequest(
      JSON.stringify({
        msg_type: "discussion_model_catalog_request",
        protocolVersion: 2,
        requestId: "req-1",
        timestamp: 1_700_000_000_000,
      }),
    );
    expect(request).toEqual({
      msg_type: "discussion_model_catalog_request",
      protocolVersion: 2,
      requestId: "req-1",
      timestamp: 1_700_000_000_000,
    });
  });

  it("accepts a request without a timestamp and rejects a malformed one", () => {
    expect(parseModelCatalogRequest(JSON.stringify({
      msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "req-2",
    }))).toEqual({
      msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "req-2",
    });
    expect(parseModelCatalogRequest(JSON.stringify({
      msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "req-3", timestamp: "soon",
    }))).toBeNull();
    expect(parseModelCatalogRequest(JSON.stringify({
      msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "req-4", timestamp: 1.5,
    }))).toBeNull();
  });

  it("rejects other commands, wrong versions, bad ids and junk", () => {
    expect(parseModelCatalogRequest("not json")).toBeNull();
    expect(parseModelCatalogRequest(JSON.stringify({ request_id: "r", service: "discussion", action: "your_turn" }))).toBeNull();
    expect(parseModelCatalogRequest(JSON.stringify({
      msg_type: "discussion_model_catalog_request", protocolVersion: 3, requestId: "r",
    }))).toBeNull();
    expect(parseModelCatalogRequest(JSON.stringify({
      msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "",
    }))).toBeNull();
    expect(parseModelCatalogRequest(JSON.stringify({
      msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "x".repeat(129),
    }))).toBeNull();
  });
});

describe("catalogFromRoutes", () => {
  it("groups by provider, sorts and dedupes", () => {
    const catalog = catalogFromRoutes(["b/two", "a/one", "b/two", "a/one", "b/one"]);
    expect(catalog.providers.map((p) => p.id)).toEqual(["a", "b"]);
    expect(catalog.providers[0].models.map((m) => m.id)).toEqual(["one"]);
    expect(catalog.providers[1].models.map((m) => m.id)).toEqual(["one", "two"]);
  });

  it("drops malformed routes and unreachable defaults", () => {
    const catalog = catalogFromRoutes(["no-slash", "a/b/c", " / ", "ok/fine"], "missing/model");
    expect(catalog.providers).toEqual([
      { id: "ok", name: "ok", models: [{ id: "fine", name: "fine" }] },
    ]);
    expect(catalog.defaultModel).toBeNull();
  });

  it("keeps a default that is present in the catalog", () => {
    expect(catalogFromRoutes(["a/one", "a/two"], "a/two").defaultModel).toBe("a/two");
  });
});

describe("parseModelListText", () => {
  it("reads a flat provider/model list (opencode)", () => {
    const catalog = parseModelListText(OPENCODE_OUTPUT);
    expect(catalog.providers.map((p) => p.id)).toEqual(["agent-plan", "opencode", "quukk"]);
    expect(catalog.providers[1].models).toEqual([
      { id: "big-pickle", name: "big-pickle" },
      { id: "exo-free", name: "exo-free" },
    ]);
    expect(catalog.defaultModel).toBeNull();
  });

  it("reads the openclaw table including its default tag", () => {
    const catalog = parseModelListText(OPENCLAW_TABLE);
    expect(catalog.defaultModel).toBe("openai/gpt-5.6-sol");
    expect(catalog.providers).toEqual([
      {
        id: "openai",
        name: "openai",
        models: [
          { id: "gpt-5.6-mini", name: "gpt-5.6-mini" },
          { id: "gpt-5.6-sol", name: "gpt-5.6-sol" },
        ],
      },
    ]);
  });

  it("reads a labelled Default line", () => {
    const catalog = parseModelListText("Default       : openai/gpt-5.6-sol\nProvider      : openai");
    expect(catalog.defaultModel).toBe("openai/gpt-5.6-sol");
  });

  it("strips ANSI colour codes", () => {
    const catalog = parseModelListText("\u001b[32mopencode/big-pickle\u001b[0m");
    expect(catalog.providers[0].models[0].id).toBe("big-pickle");
  });
});

describe("parseOpenclawModelListJson", () => {
  it("parses the JSON envelope and keeps display names", () => {
    const catalog = parseOpenclawModelListJson(OPENCLAW_JSON);
    expect(catalog?.defaultModel).toBe("openai/gpt-5.6-sol");
    expect(catalog?.providers[0].models).toEqual([
      { id: "gpt-5.6-mini", name: "GPT-5.6 Mini" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
  });

  it("skips leading stderr noise before the JSON body", () => {
    const catalog = parseOpenclawModelListJson(`Config warnings: something\n${OPENCLAW_JSON}`);
    expect(catalog?.providers.length).toBe(1);
  });

  it("returns null for non-JSON output", () => {
    expect(parseOpenclawModelListJson("opencode/big-pickle")).toBeNull();
    expect(parseOpenclawModelListJson("{")).toBeNull();
  });
});

describe("parseModelCatalogOutput", () => {
  it("prefers openclaw JSON, falls back to the table", () => {
    expect(parseModelCatalogOutput("openclaw", OPENCLAW_JSON).defaultModel).toBe("openai/gpt-5.6-sol");
    expect(parseModelCatalogOutput("openclaw", OPENCLAW_TABLE).defaultModel).toBe("openai/gpt-5.6-sol");
    expect(parseModelCatalogOutput("opencode", OPENCODE_OUTPUT).providers.length).toBe(3);
  });
});

describe("buildModelCatalogResponse", () => {
  it("emits exactly the keys the web normalizer accepts", () => {
    const request = { msg_type: "discussion_model_catalog_request" as const, protocolVersion: 2 as const, requestId: "req-1" };
    const body = JSON.parse(
      buildModelCatalogResponse(request, catalogFromRoutes(["a/one"]), () => 42),
    );
    expect(Object.keys(body).sort()).toEqual([
      "defaultModel", "msg_type", "protocolVersion", "providers", "requestId", "timestamp",
    ]);
    expect(body).toEqual({
      msg_type: "discussion_model_catalog_response",
      protocolVersion: 2,
      requestId: "req-1",
      defaultModel: null,
      providers: [{ id: "a", name: "a", models: [{ id: "one", name: "one" }] }],
      timestamp: 42,
    });
  });
});

describe("modelListSpec", () => {
  it("knows the agents with a provider/model catalog command", () => {
    expect(modelListSpec("opencode")?.argv).toEqual(["models"]);
    expect(modelListSpec("openclaw")?.argv).toEqual(["models", "list", "--json"]);
    expect(modelListSpec("codex")).toBeNull();
    expect(modelListSpec(undefined)).toBeNull();
  });

  it("knows the dsh / agy / pi listing commands added for the 2026-11 catalog fix", () => {
    // profile 必须与设备端自身启动参数一致（dsh.go:19 dshProfile="multica"）；
    // **不能带 --stdio**（2026-11 实测：与 --list-models 互斥）。
    expect(modelListSpec("dsh")?.argv).toEqual(["--profile", "multica", "--list-models"]);
    expect(modelListSpec("agy")?.argv).toEqual(["models"]);
    expect(modelListSpec("pi")?.argv).toEqual(["--list-models"]);
    expect(modelListSpec("grok")?.argv).toEqual(["models"]);
    expect(modelListSpec("kimi")?.argv).toEqual(["provider", "list", "--json"]);
  });

  // dsh 列完帧不退出：必须带 stopWhen，否则 runAgentCommand 只能等到超时。
  it("gives dsh a stopWhen predicate because its listing command never exits", () => {
    const spec = modelListSpec("dsh");
    expect(spec?.stopWhen).toBeTypeOf("function");
    expect(spec?.stopWhen?.('{"v":1,"type":"ready","runtime":"dsh"}')).toBe(false);
    expect(spec?.stopWhen?.(DSH_OUTPUT)).toBe(true);
    // 其它 agent 的命令自己会退出，不需要判据
    expect(modelListSpec("grok")?.stopWhen).toBeUndefined();
  });
});

describe("dshModelsFrameComplete", () => {
  it("needs a complete v:1 models frame with at least one model", () => {
    expect(dshModelsFrameComplete("")).toBe(false);
    expect(dshModelsFrameComplete('{"v":1,"type":"models","models":[{"id":"q/m"}]}\n')).toBe(true);
    expect(dshModelsFrameComplete('{"v":1,"type":"models","models":[]}')).toBe(false);
    // 版本不符 / 半行 / 其它帧都不算完成
    expect(dshModelsFrameComplete('{"v":2,"type":"models","models":[{"id":"q/m"}]}')).toBe(false);
    expect(dshModelsFrameComplete('{"v":1,"type":"models","models":[{"id":"q/')).toBe(false);
    expect(dshModelsFrameComplete('{"v":1,"type":"ready","runtime":"dsh"}')).toBe(false);
  });
});

describe("parseDshModelListJsonl", () => {
  it("maps the real frame: id is already a route, provider is a DISPLAY name", () => {
    const catalog = parseDshModelListJsonl(DSH_OUTPUT);
    // default === true 的那条就是 defaultModel（本机是 quukk/glm-5.2）
    expect(catalog.defaultModel).toBe("quukk/glm-5.2");
    // provider id 取 id 的斜杠前段（不是帧里的 "Quukk AI"/"DeepSeek"，那两个含空格，
    // 直接当 id 会被前端 normalizeCatalog 判非法）；帧里的 provider 只做展示名。
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "deepseek-official", "quukk",
    ]);
    expect(catalog.providers[0].name).toBe("DeepSeek");
    expect(catalog.providers[1].name).toBe("Quukk AI");
    expect(catalog.providers[1].models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "glm-5.3", "k3", "kimi-k2.7-code",
    ]);
    expect(catalog.providers[1].models).toContainEqual({ id: "glm-5.2", name: "GLM 5.2" });
  });

  it("never leaks the thinking block into the wire catalog", () => {
    // 前端白名单只认 {id,name}，多一个字段整包被拒 —— 帧里的 thinking 必须丢弃。
    const catalog = parseDshModelListJsonl(DSH_OUTPUT);
    for (const provider of catalog.providers) {
      expect(Object.keys(provider).sort()).toEqual(["id", "models", "name"]);
      for (const model of provider.models) {
        expect(Object.keys(model).sort()).toEqual(["id", "name"]);
      }
    }
    expect(JSON.stringify(catalog)).not.toContain("supported_levels");
  });

  it("drops frames with a wrong protocol version and non-JSON noise", () => {
    const catalog = parseDshModelListJsonl(
      '{"version":1,"type":"models","models":[{"id":"x/y"}]}\nnot json\n{"v":2,"type":"models","models":[{"id":"a/b"}]}',
    );
    // `version`（错字段名）与 v:2 的帧都必须丢弃
    expect(catalog).toEqual(EMPTY_MODEL_CATALOG);
  });

  it("drops items whose id cannot form a provider/model route", () => {
    const catalog = parseDshModelListJsonl(
      '{"v":1,"type":"models","models":[' +
        '{"id":"bad id"},' +
        '{"id":"noslash"},' +
        '{"id":""},' +
        '{"id":"p/good"}]}',
    );
    expect(catalog.providers).toEqual([
      { id: "p", name: "p", models: [{ id: "good", name: "good" }] },
    ]);
  });

  it("is wired into parseModelCatalogOutput for dsh", () => {
    expect(parseModelCatalogOutput("dsh", DSH_OUTPUT).defaultModel).toBe("quukk/glm-5.2");
  });
});

describe("parseAgyModelsList", () => {
  // agy 1.1.11 输出 `id\tlabel`；旧版一行一个裸 id（models.go:2427-2452）。
  it("reads tab-separated id/label rows into the synthetic agy provider", () => {
    const catalog = parseAgyModelsList("gemini-3-pro\tGemini 3 Pro\ngemini-3-flash\tGemini 3 Flash");
    expect(catalog.providers).toEqual([
      {
        id: "agy",
        name: "agy",
        models: [
          { id: "gemini-3-flash", name: "Gemini 3 Flash" },
          { id: "gemini-3-pro", name: "Gemini 3 Pro" },
        ],
      },
    ]);
    expect(catalog.defaultModel).toBeNull();
  });

  it("falls back to the bare-id form of older builds and dedupes", () => {
    const catalog = parseAgyModelsList("gemini-3-pro\ngemini-3-pro\n");
    expect(catalog.providers[0].models).toEqual([{ id: "gemini-3-pro", name: "gemini-3-pro" }]);
  });

  it("is wired into parseModelCatalogOutput for agy (the generic route parser cannot read bare ids)", () => {
    expect(parseModelCatalogOutput("agy", "gemini-3-pro\tGemini 3 Pro").providers[0].id).toBe("agy");
  });
});

describe("parsePiModelsList", () => {
  it("reads the legacy provider:model rows", () => {
    const catalog = parsePiModelsList("anthropic:claude-opus-5\nopenai:gpt-5.5");
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["anthropic", "openai"]);
    expect(catalog.providers[0].models[0].id).toBe("claude-opus-5");
  });

  it("reads the multi-column table and skips the header row", () => {
    const catalog = parsePiModelsList(
      [
        "provider      model                context",
        "anthropic     claude-opus-5        200k",
        "openai        gpt-5.5              128k",
      ].join("\n"),
    );
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["anthropic", "openai"]);
  });

  // pi 会在目录行之间夹杂诊断文案（models.go:1264-1271，#3729）——
  // 不跳过的话字段切分会把 prose 铸成 No/models 这种假模型。
  it("skips diagnostic prose between catalog rows", () => {
    const catalog = parsePiModelsList(
      [
        'Warning: No models match pattern "opencode-go/mimo-v2-omni"',
        "anthropic claude-opus-5 200k",
      ].join("\n"),
    );
    expect(catalog.providers).toEqual([
      { id: "anthropic", name: "anthropic", models: [{ id: "claude-opus-5", name: "claude-opus-5" }] },
    ]);
  });

  it("is wired into parseModelCatalogOutput for pi (colon rows never fit the generic parser)", () => {
    expect(parseModelCatalogOutput("pi", "anthropic:claude-opus-5").providers[0].id).toBe("anthropic");
  });
});

describe("parseGrokModelsList", () => {
  // 严格双射：第一个 `-` 前是 provider，其余是 model。provider 按 id 字典序
  // 输出（finalizeCatalog 排序），所以 `grok` 在 `quukk` 之前。
  it("reads the bullet list and the Default model header", () => {
    const catalog = parseGrokModelsList(GROK_OUTPUT);
    expect(catalog.defaultModel).toBe("quukk/glm-5.2");
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["grok", "quukk"]);
    // 裸 id `grok-4.7` 切成 `grok` + `4.7`（分组不完美但可逆，注入还原成 `grok-4.7`）
    expect(catalog.providers[0]).toEqual({
      id: "grok",
      name: "grok",
      models: [{ id: "4.7", name: "grok-4.7" }],
    });
    expect(catalog.providers[1].models.map((model) => model.id)).toEqual([
      "deepseek-v4-pro", "glm-5.2", "glm-5.3", "kimi-k2-7-code",
    ]);
    // 展示名保留 CLI 原始 id（`quukk-kimi-k2-7-code`），便于用户对上号
    expect(catalog.providers[1].models).toContainEqual({
      id: "kimi-k2-7-code", name: "quukk-kimi-k2-7-code",
    });
  });

  it("ignores the API-key noise line and the section header", () => {
    const catalog = parseGrokModelsList(
      ["Model 'p-m' is using its own API key.", "Available models:", "  - p-m"].join("\n"),
    );
    expect(catalog.providers).toEqual([
      { id: "p", name: "p", models: [{ id: "m", name: "p-m" }] },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("API key");
  });

  it("takes the default from the `* … (default)` marker when the header is absent", () => {
    const catalog = parseGrokModelsList("Available models:\n  * p-m (default)\n  - p-n");
    expect(catalog.defaultModel).toBe("p/m");
  });

  it("is wired into parseModelCatalogOutput for grok", () => {
    expect(parseModelCatalogOutput("grok", GROK_OUTPUT).defaultModel).toBe("quukk/glm-5.2");
  });
});

describe("parseKimiProviderListJson", () => {
  it("maps the models map key (already a route) and keeps displayName", () => {
    const catalog = parseKimiProviderListJson(KIMI_PROVIDER_JSON);
    expect(catalog).not.toBeNull();
    expect(catalog?.defaultModel).toBeNull();
    expect(catalog?.providers).toEqual([
      {
        id: "quukk",
        name: "quukk",
        models: [
          { id: "glm-5.2", name: "GLM 5.2" },
          { id: "kimi-for-coding-highspeed", name: "Kimi for Coding Highspeed" },
        ],
      },
    ]);
  });

  // 安全红线：同一份输出里 providers.*.apiKey 是明文真实密钥，绝不能进 catalog
  // （否则会被回传到 web、写进日志/快照）。测试 fixture 用假值，断言整包不含它。
  it("never lets the providers section (apiKey) reach the catalog", () => {
    const catalog = parseKimiProviderListJson(KIMI_PROVIDER_JSON);
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("sk-fake-not-real");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("llmapi.example.com");
  });

  it("falls back to entry.provider/model when the key is not a route, and skips junk", () => {
    const catalog = parseKimiProviderListJson(JSON.stringify({
      models: {
        "bad key with spaces": { provider: "quukk", model: "glm-5.2", displayName: "GLM 5.2" },
        "also bad": { provider: "quukk", model: "has/slash" },
      },
    }));
    expect(catalog?.providers).toEqual([
      { id: "quukk", name: "quukk", models: [{ id: "glm-5.2", name: "GLM 5.2" }] },
    ]);
  });

  it("returns null for non-JSON or a payload without a models map", () => {
    expect(parseKimiProviderListJson("not json")).toBeNull();
    expect(parseKimiProviderListJson('{"providers":{}}')).toBeNull();
    expect(parseKimiProviderListJson('{"models":{}}')).toBeNull();
    // 分派层把它降级成空目录（而不是抛错）
    expect(parseModelCatalogOutput("kimi", "not json")).toBe(EMPTY_MODEL_CATALOG);
    expect(parseModelCatalogOutput("kimi", KIMI_PROVIDER_JSON).providers[0].id).toBe("quukk");
  });
});

describe("createModelCatalogLoader", () => {
  // `readConfig: () => null` 不是可选项：opencode 现在有配置解析器，不注入就会
  // 读**跑测试那台机器**的 ~/.config/opencode/opencode.json，测试结果取决于
  // 开发者的 home（CI 与本机结论不一致）。
  const noConfig = () => null;

  it("runs the agent command once and then serves the cache", async () => {
    const runCommand = vi.fn().mockResolvedValue(OPENCODE_OUTPUT);
    const loader = createModelCatalogLoader({ agentName: "opencode", runCommand, readConfig: noConfig });

    const first = await loader.load();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toEqual(["models"]);

    const second = await loader.load();
    expect(second).toBe(first);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("serves a warm cache without refetching until the ttl expires", async () => {
    let clock = 1_000;
    const runCommand = vi.fn().mockResolvedValue(OPENCODE_OUTPUT);
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand,
      readConfig: noConfig,
      ttlMs: 60_000,
      now: () => clock,
    });

    await loader.load();
    expect(runCommand).toHaveBeenCalledTimes(1);

    clock += 30_000;
    await loader.load();
    expect(runCommand).toHaveBeenCalledTimes(1);

    clock += 60_000;
    await loader.load();
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("never rejects and stays empty for agents without a list command", async () => {
    const runCommand = vi.fn();
    const loader = createModelCatalogLoader({
      agentName: "codex",
      runCommand,
      readConfig: () => null,
    });
    await expect(loader.load()).resolves.toBe(EMPTY_MODEL_CATALOG);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("falls back to the empty catalog when the command fails", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("boom"));
    const logger = vi.fn();
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand,
      readConfig: noConfig,
      logger,
    });
    await expect(loader.load()).resolves.toBe(EMPTY_MODEL_CATALOG);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("deduplicates concurrent requests", async () => {
    const runCommand = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(OPENCODE_OUTPUT), 5)));
    const loader = createModelCatalogLoader({ agentName: "opencode", runCommand, readConfig: noConfig });
    const [first, second] = await Promise.all([loader.load(), loader.load()]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

describe("createModelCatalogLoader with provider endpoints", () => {
  // openclaw's own list is the *built-in* openai catalogue, which is fiction
  // for a provider that points at a local gateway. Only one entry here so the
  // replacement is easy to see.
  const BOGUS_OPENCLAW_LIST = JSON.stringify({
    count: 1,
    models: [{ key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", tags: ["default"] }],
  });
  const OPENCLAW_ENDPOINT = { id: "openai", baseUrl: "http://127.0.0.1:49830/v1" };

  it("unions the CLI list with the endpoint's live models", async () => {
    const runCommand = vi.fn().mockResolvedValue(BOGUS_OPENCLAW_LIST);
    const loader = createModelCatalogLoader({
      agentName: "openclaw",
      runCommand,
      readConfig: () => ({ endpoints: [OPENCLAW_ENDPOINT], defaultModel: null }),
      probe: async () => ["glm-5.2", "deepseek-v4-pro", "kimi-k2.7-code"],
    });

    const catalog = await loader.load();
    // The CLI's configured/OAuth entry survives (with its display name) and
    // the endpoint's pass-through models are added alongside it.
    expect(catalog.providers).toEqual([
      {
        id: "openai",
        name: "openai",
        models: [
          { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
          { id: "glm-5.2", name: "glm-5.2" },
          { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { id: "kimi-k2.7-code", name: "kimi-k2.7-code" },
        ],
      },
    ]);
  });

  it("lets the agent's configured display name win over the raw provider id", async () => {
    const loader = createModelCatalogLoader({
      agentName: "openclaw",
      runCommand: vi.fn().mockResolvedValue(BOGUS_OPENCLAW_LIST),
      readConfig: () => ({
        endpoints: [{ ...OPENCLAW_ENDPOINT, name: "Local Gateway" }],
        defaultModel: null,
      }),
      probe: async () => ["glm-5.2"],
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].name).toBe("Local Gateway");
  });

  it("serves codex/hermes purely from their configured endpoint", async () => {
    const runCommand = vi.fn();
    const loader = createModelCatalogLoader({
      agentName: "codex",
      runCommand,
      readConfig: () => ({
        endpoints: [{ id: "quukk_direct", name: "Quukk Direct", baseUrl: "http://127.0.0.1:49830/v1" }],
        defaultModel: "quukk_direct/glm-5.2",
      }),
      probe: async () => ["glm-5.2", "k3"],
    });

    const catalog = await loader.load();
    expect(runCommand).not.toHaveBeenCalled();
    expect(catalog.defaultModel).toBe("quukk_direct/glm-5.2");
    expect(catalog.providers).toEqual([
      {
        id: "quukk_direct",
        name: "Quukk Direct",
        models: [
          { id: "glm-5.2", name: "glm-5.2" },
          { id: "k3", name: "k3" },
        ],
      },
    ]);
  });

  it("keeps the CLI list when the endpoint is unreachable", async () => {
    const loader = createModelCatalogLoader({
      agentName: "openclaw",
      runCommand: vi.fn().mockResolvedValue(BOGUS_OPENCLAW_LIST),
      readConfig: () => ({ endpoints: [OPENCLAW_ENDPOINT], defaultModel: null }),
      probe: async () => null,
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].models.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("keeps the CLI list when the endpoint answers with no usable ids", async () => {
    const loader = createModelCatalogLoader({
      agentName: "openclaw",
      runCommand: vi.fn().mockResolvedValue(BOGUS_OPENCLAW_LIST),
      readConfig: () => ({ endpoints: [OPENCLAW_ENDPOINT], defaultModel: null }),
      probe: async () => [],
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].models.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("drops endpoint ids that cannot form a provider/model route", async () => {
    const loader = createModelCatalogLoader({
      agentName: "codex",
      runCommand: vi.fn(),
      readConfig: () => ({ endpoints: [{ id: "p", baseUrl: "http://127.0.0.1:1/v1" }], defaultModel: null }),
      probe: async () => ["good", "bad model", "has/slash", "", "also-good"],
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].models.map((m) => m.id)).toEqual(["also-good", "good"]);
  });

  it("still yields the empty catalog when only an unusable endpoint exists", async () => {
    const loader = createModelCatalogLoader({
      agentName: "hermes",
      runCommand: vi.fn(),
      readConfig: () => ({
        endpoints: [{ id: "quukk", baseUrl: "https://llmapi.quukk.com/v1" }],
        defaultModel: "quukk/glm-5.3",
      }),
      probe: async () => null,
    });

    await expect(loader.load()).resolves.toBe(EMPTY_MODEL_CATALOG);
  });

  it("discards a configured default that is not in the catalog", async () => {
    const loader = createModelCatalogLoader({
      agentName: "codex",
      runCommand: vi.fn(),
      readConfig: () => ({
        endpoints: [{ id: "quukk_direct", baseUrl: "http://127.0.0.1:1/v1" }],
        defaultModel: "quukk_direct/not-served",
      }),
      probe: async () => ["glm-5.2"],
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].models.map((m) => m.id)).toEqual(["glm-5.2"]);
    expect(catalog.defaultModel).toBeNull();
  });
});

// 配置文件里**显式声明**的模型清单（opencode 的 `provider.<id>.models`）。
// 这是本轮的根因修复：现场「私有设备拿不到模型目录 + 对话报进程异常退出」，
// 因为目录只能靠 `opencode models`（3-5s 冷启，可能超时/失败）和端点 probe
// （最多 8s 空等）两条网络路径 —— 而 web 只等 8s。
describe("createModelCatalogLoader with config-declared models", () => {
  const QUUKK_ENDPOINT = { id: "quukk", baseUrl: "https://llmapi.example.com/v1" };

  it("serves the declared models without probing the declared endpoint", async () => {
    const probe = vi.fn(async () => {
      throw new Error("declared providers must not be probed");
    });
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand: vi.fn().mockResolvedValue(""),
      readConfig: () => ({
        endpoints: [QUUKK_ENDPOINT],
        defaultModel: "quukk/glm-5.2",
        declaredModels: { quukk: ["glm-5.2", "k3"] },
      }),
      probe,
    });

    const catalog = await loader.load();
    // 声明即事实：再 probe 一遍只可能拿到同一份清单的子集，白等最多 8s。
    expect(probe).not.toHaveBeenCalled();
    expect(catalog.providers).toEqual([
      {
        id: "quukk",
        name: "quukk",
        models: [
          { id: "glm-5.2", name: "glm-5.2" },
          { id: "k3", name: "k3" },
        ],
      },
    ]);
    expect(catalog.defaultModel).toBe("quukk/glm-5.2");
  });

  it("probes only the endpoints that declare no models of their own", async () => {
    const probe = vi.fn(async (endpoint: { id: string }) => [`${endpoint.id}-model`]);
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand: vi.fn().mockResolvedValue(""),
      readConfig: () => ({
        endpoints: [QUUKK_ENDPOINT, { id: "other", baseUrl: "https://other.example.com/v1" }],
        defaultModel: null,
        declaredModels: { quukk: ["glm-5.2"] },
      }),
      probe,
    });

    const catalog = await loader.load();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ id: "other" }));
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["other", "quukk"]);
    expect(catalog.providers[1].models.map((model) => model.id)).toEqual(["glm-5.2"]);
  });

  // 声明清单是**下限**，不是上限。
  //
  // 现场（2026-11-05，运维对话「切换模型」）：配置只声明 quukk 6 个 + agent-plan
  // 14 个，而 `opencode models` 实际列 32 条 —— 多出来的是 10 个内置
  // `opencode/*` 免费模型与 2 个 `deepseek/*`。以前「有声明就整个跳过 CLI」，
  // 这 12 个永远不进面板，用户看到的就是「模型列表获取不全」。
  it("declaration is a floor: CLI cannot shrink it, and its extra providers are merged", async () => {
    // 真实现场：配置声明 6 个，`opencode models` 只回报其中 2 个。整组替换会把
    // 面板从 6 个缩成 2 个 —— 所以只能是并集，不能覆盖。
    const runCommand = vi.fn().mockResolvedValue(
      "quukk/glm-5.2\nopencode/beam-free\ndeepseek/deepseek-v4-pro\n",
    );
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand,
      readConfig: () => ({
        endpoints: [],
        defaultModel: "quukk/glm-5.2",
        declaredModels: { quukk: ["glm-5.2", "glm-5.3", "k3"] },
      }),
    });

    const catalog = await loader.load();
    expect(runCommand).toHaveBeenCalledTimes(1);

    const quukk = catalog.providers.find((provider) => provider.id === "quukk");
    // 配置里的三个一个都不能少（CLI 只回报了其中一个）
    expect(quukk?.models.map((model) => model.id)).toEqual(["glm-5.2", "glm-5.3", "k3"]);
    // CLI 独有、配置里没有的 provider 照样进面板（这正是「不全」的那一块）
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "deepseek", "opencode", "quukk",
    ]);
    expect(catalog.defaultModel).toBe("quukk/glm-5.2");
  });

  // 这条钉的是**延迟语义**：CLI 必须跑（否则目录永远缺块），但预算只有 4s。
  // 两个方向都要钉死 ——
  //   · 改回「整个跳过」→ 模型列表重新变不全（见上一条）；
  //   · 改回 `spec.timeoutMs`（30s）→ web 的 8s 窗口被拖死，面板直接超时。
  // 断言参数而不是墙钟时间：注入的 runCommand 不一定自己执行超时，用耗时断言
  // 只会测到 mock 的睡眠。
  it("runs the list command with a 4s budget when models are already declared", async () => {
    // 显式声明参数类型：默认推断是空 tuple，取 calls[0][1] 会被 tsc 挡下
    const runCommand = vi.fn(
      async (_argv: string[], _timeoutMs: number, _maxBytes: number): Promise<string> => {
        throw new Error("spawn opencode models ETIMEDOUT");
      },
    );
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand,
      readConfig: () => ({
        endpoints: [],
        defaultModel: "quukk/glm-5.2",
        declaredModels: { quukk: ["glm-5.2"] },
      }),
    });

    const catalog = await loader.load();

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toEqual(["models"]);
    // 第二个参数是超时预算，第三个是输出上限
    expect(runCommand.mock.calls[0][1]).toBe(4_000);
    expect(runCommand.mock.calls[0][2]).toBe(256 * 1024);
    // 超时/失败不等于没有目录：声明清单照常交付（旧行为等价，不倒退）
    expect(catalog.providers).toEqual([
      { id: "quukk", name: "quukk", models: [{ id: "glm-5.2", name: "glm-5.2" }] },
    ]);
    expect(catalog.defaultModel).toBe("quukk/glm-5.2");
  });

  it("uses the command's own 30s budget when nothing is declared", async () => {
    const runCommand = vi.fn().mockResolvedValue("quukk/glm-5.2\n");
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand,
      readConfig: () => ({ endpoints: [], defaultModel: null }),
    });

    await loader.load();
    expect(runCommand.mock.calls[0][1]).toBe(30_000);
  });

  // 配置是用户手写的，provider key 里带空格完全可能。wire 上的 id 必须能拼成
  // `provider/model` 路由（与 groupRoutes / mergeEndpointModels 同一把尺子），
  // 否则前端既存不下也回传不了。
  it("drops declared providers whose key cannot form a route", async () => {
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand: vi.fn().mockResolvedValue(""),
      readConfig: () => ({
        endpoints: [],
        defaultModel: null,
        declaredModels: { "my provider": ["glm-5.2"] },
      }),
    });

    await expect(loader.load()).resolves.toBe(EMPTY_MODEL_CATALOG);
  });

  it("drops declared slugs that cannot form a route", async () => {
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand: vi.fn().mockResolvedValue(""),
      readConfig: () => ({
        endpoints: [],
        defaultModel: null,
        declaredModels: { p: ["bad model", "has/slash", "", "good"] },
      }),
    });

    const catalog = await loader.load();
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["p"]);
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual(["good"]);
  });

  it("keeps every valid declared slug, in order", async () => {
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand: vi.fn().mockResolvedValue(""),
      readConfig: () => ({
        endpoints: [],
        defaultModel: "quukk/k3",
        declaredModels: { quukk: ["glm-5.2", "k3"] },
      }),
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual(["glm-5.2", "k3"]);
    expect(catalog.defaultModel).toBe("quukk/k3");
  });

  it("caps a single declared provider at 500 models", async () => {
    // MAX_MODELS_PER_PROVIDER（model-catalog.ts:40），与 probe/CLI 路径同一个上限：
    // 一份手写错的配置不能把整帧撑爆。
    const slugs = Array.from({ length: 600 }, (_, i) => `m${i}`);
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand: vi.fn().mockResolvedValue(""),
      readConfig: () => ({ endpoints: [], defaultModel: null, declaredModels: { p: slugs } }),
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].models).toHaveLength(500);
    expect(catalog.providers[0].models.map((model) => model.id)).toContain("m0");
    expect(catalog.providers[0].models.map((model) => model.id)).toContain("m499");
    expect(catalog.providers[0].models.map((model) => model.id)).not.toContain("m500");
  });

  it("discards a declared default that the declaration itself does not contain", async () => {
    const loader = createModelCatalogLoader({
      agentName: "opencode",
      runCommand: vi.fn().mockResolvedValue(""),
      readConfig: () => ({
        endpoints: [],
        defaultModel: "quukk/not-declared",
        declaredModels: { quukk: ["glm-5.2"] },
      }),
    });

    const catalog = await loader.load();
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual(["glm-5.2"]);
    expect(catalog.defaultModel).toBeNull();
  });
});

describe("MessageDispatcher model catalog request", () => {
  function inbound(content: unknown): InboundIMMessage {
    return {
      objectName: "command",
      fromUserId: "web-user",
      toUserId: "node-user",
      targetId: "node-user",
      conversationType: 1,
      content: JSON.stringify(content),
    };
  }

  const turns = { runTurn: async () => "unused" };

  it("replies with the catalog to the requester", async () => {
    const sent: Array<{ to: string; objectName: string; content: string }> = [];
    const dispatcher = new MessageDispatcher({
      send: async (to, objectName, content) => {
        sent.push({ to, objectName, content });
      },
      loadModelCatalog: async () => catalogFromRoutes(["opencode/big-pickle"]),
    });

    await dispatcher.handle(
      inbound({
        msg_type: "discussion_model_catalog_request",
        protocolVersion: 2,
        requestId: "req-9",
        // Must be a live timestamp: the dispatcher drops requests the web has
        // already timed out on (see handleModelCatalogRequest).
        timestamp: Date.now(),
      }),
      turns,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("web-user");
    expect(sent[0].objectName).toBe("command");
    const body = JSON.parse(sent[0].content);
    expect(body.msg_type).toBe("discussion_model_catalog_response");
    expect(body.requestId).toBe("req-9");
    expect(body.providers[0].id).toBe("opencode");
    expect(typeof body.timestamp).toBe("number");
    expect(Number.isSafeInteger(body.timestamp)).toBe(true);
  });

  it("still answers an empty catalog when no loader is wired", async () => {
    const sent: string[] = [];
    const dispatcher = new MessageDispatcher({
      send: async (_to, _objectName, content) => {
        sent.push(content);
      },
    });

    await dispatcher.handle(
      inbound({
        msg_type: "discussion_model_catalog_request",
        protocolVersion: 2,
        requestId: "req-10",
      }),
      turns,
    );

    expect(JSON.parse(sent[0])).toMatchObject({
      msg_type: "discussion_model_catalog_response",
      requestId: "req-10",
      defaultModel: null,
      providers: [],
    });
  });

  it("survives a loader failure and still answers", async () => {
    const sent: string[] = [];
    const dispatcher = new MessageDispatcher({
      send: async (_to, _objectName, content) => {
        sent.push(content);
      },
      loadModelCatalog: async () => {
        throw new Error("device exploded");
      },
    });

    await dispatcher.handle(
      inbound({
        msg_type: "discussion_model_catalog_request",
        protocolVersion: 2,
        requestId: "req-11",
      }),
      turns,
    );

    expect(JSON.parse(sent[0]).providers).toEqual([]);
  });
});

// 静态兜底（model-static-catalogs.ts）：面板空态的最后防线。准入闸门是
// agent-model-capabilities.ts —— modelInjection 'none' 的 agent 一律不给目录，
// 否则会从「看不到」变成「选了没用」。
describe("createModelCatalogLoader with static fallback catalogs", () => {
  const noConfig = () => null;

  it("serves claude purely from the static catalog (no CLI list, no config)", async () => {
    const runCommand = vi.fn();
    const loader = createModelCatalogLoader({
      agentName: "claude",
      runCommand,
      readConfig: noConfig,
    });

    const catalog = await loader.load();
    expect(runCommand).not.toHaveBeenCalled();
    expect(catalog.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0].id).toBe("anthropic");
    // models.go:586-599 claudeStaticModels 的条数（2026-11 抄写基线）
    expect(catalog.providers[0].models).toHaveLength(11);
  });

  it("unions the static catalog with whatever the config/probe paths find", async () => {
    const loader = createModelCatalogLoader({
      agentName: "claude",
      runCommand: vi.fn(),
      readConfig: () => ({
        endpoints: [{ id: "gateway", baseUrl: "http://127.0.0.1:1/v1" }],
        defaultModel: null,
      }),
      probe: async () => ["via-gateway"],
    });

    const catalog = await loader.load();
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["anthropic", "gateway"]);
    expect(catalog.providers[1].models.map((model) => model.id)).toEqual(["via-gateway"]);
  });

  it("gives codebuddy the static catalog only when its provider config exists", async () => {
    // 注入走 CODEBUDDY_MODEL（agentRuntimeEnv），没有网关配置时该变量不会被
    // 设置 —— 目录给出来也选了没用，所以必须为空。
    const withoutConfig = createModelCatalogLoader({
      agentName: "codebuddy",
      runCommand: vi.fn(),
      readConfig: noConfig,
    });
    await expect(withoutConfig.load()).resolves.toBe(EMPTY_MODEL_CATALOG);

    const withConfig = createModelCatalogLoader({
      agentName: "codebuddy",
      runCommand: vi.fn(),
      readConfig: () => ({
        endpoints: [{ id: "quukk", baseUrl: "https://llmapi.example.com/v1" }],
        defaultModel: null,
      }),
      // probe 失败（网关暂不可达）：静态目录兜底，面板不至于空着
      probe: async () => null,
    });
    const catalog = await withConfig.load();
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "anthropic", "deepseek", "google", "openai",
    ]);
    expect(catalog.defaultModel).toBeNull();
  });

  // 能力闸门的负向测试：injection 'none' 的 agent 即使将来有人往
  // STATIC_CATALOGS 里塞了清单，也不许漏出来；也没有任何列举命令可跑。
  it("never serves a catalog for agents that cannot inject a model", async () => {
    for (const agentName of ["qwenpaw", "mcode", "zeroclaw", "deveco", "traecli"]) {
      const runCommand = vi.fn();
      const loader = createModelCatalogLoader({
        agentName,
        runCommand,
        readConfig: noConfig,
      });
      await expect(loader.load()).resolves.toBe(EMPTY_MODEL_CATALOG);
      expect(runCommand, `${agentName} must not spawn a listing command`).not.toHaveBeenCalled();
    }
  });

  // dsh：列举命令打完帧不退出，加载器必须把 spec.stopWhen 透传给 runCommand
  // （否则真机实现只能等超时 → 空目录）。同时把实测 argv 钉死。
  it("passes dsh's listing spec (argv + stopWhen) through to runCommand", async () => {
    const runCommand = vi.fn(
      async (
        _argv: string[],
        _timeoutMs: number,
        _maxBytes: number,
        _stopWhen?: (partial: string) => boolean,
      ): Promise<string> => DSH_OUTPUT,
    );
    const loader = createModelCatalogLoader({
      agentName: "dsh",
      runCommand,
      readConfig: noConfig,
    });

    const catalog = await loader.load();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toEqual(["--profile", "multica", "--list-models"]);
    expect(runCommand.mock.calls[0][3]).toBeTypeOf("function");
    expect(catalog.defaultModel).toBe("quukk/glm-5.2");
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["deepseek-official", "quukk"]);
  });

  it("serves grok and kimi from their measured listing commands", async () => {
    const grokLoader = createModelCatalogLoader({
      agentName: "grok",
      runCommand: vi.fn(async () => GROK_OUTPUT),
      readConfig: noConfig,
    });
    const grokCatalog = await grokLoader.load();
    expect(grokCatalog.defaultModel).toBe("quukk/glm-5.2");
    expect(grokCatalog.providers.map((provider) => provider.id)).toEqual(["grok", "quukk"]);

    const kimiLoader = createModelCatalogLoader({
      agentName: "kimi",
      runCommand: vi.fn(async () => KIMI_PROVIDER_JSON),
      readConfig: noConfig,
    });
    const kimiCatalog = await kimiLoader.load();
    expect(kimiCatalog.providers).toEqual([
      {
        id: "quukk",
        name: "quukk",
        models: [
          { id: "glm-5.2", name: "GLM 5.2" },
          { id: "kimi-for-coding-highspeed", name: "Kimi for Coding Highspeed" },
        ],
      },
    ]);
  });

  // 安全：命令失败信息里可能夹带 agent 原始 stderr（kimi 的输出含明文 apiKey），
  // 日志必须打码 —— 失败路径也绝不把密钥写进日志。
  it("redacts sk-… tokens out of the failure log", async () => {
    const logger = vi.fn();
    const loader = createModelCatalogLoader({
      agentName: "kimi",
      runCommand: vi.fn(async () => {
        throw new Error('agent command exited with code 1: {"apiKey":"sk-realsecret-1234567890"}');
      }),
      readConfig: noConfig,
      logger,
    });
    await expect(loader.load()).resolves.toBe(EMPTY_MODEL_CATALOG);
    const logged = logger.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("sk-***");
    expect(logged).not.toContain("sk-realsecret-1234567890");
  });
});

// 能力矩阵完整性：agent-model-capabilities.ts 是单一事实源 —— 25 家 KNOWN_AGENT_CLIS
// 一家都不能漏；有列举命令的必须登记为 'cli'；静态目录只发给能注入的 agent。
describe("AGENT_MODEL_CAPABILITIES", () => {
  it("covers every known agent CLI", () => {
    for (const agentName of KNOWN_AGENT_CLIS) {
      expect(AGENT_MODEL_CAPABILITIES[agentName], `missing capability: ${agentName}`)
        .toBeDefined();
    }
  });

  it("keeps the matrix and the list-command table in sync", () => {
    for (const agentName of Object.keys(AGENT_MODEL_CAPABILITIES)) {
      const hasListCommand = modelListSpec(agentName) !== null;
      if (hasListCommand) {
        expect(AGENT_MODEL_CAPABILITIES[agentName].catalogSource).toBe("cli");
      }
    }
  });

  it("only serves static catalogs for the agents registered with one", () => {
    for (const agentName of ["claude", "codebuddy"]) {
      const capability = agentModelCapability(agentName);
      expect(capability.modelInjection).not.toBe("none");
      expect(staticModelCatalogFor(agentName, { hasProviderConfig: true })).not.toBeNull();
    }
    // grok/kimi 有实测的列举命令，不需要静态兜底（目录来自 CLI）
    expect(staticModelCatalogFor("grok", { hasProviderConfig: true })).toBeNull();
    expect(staticModelCatalogFor("kimi", { hasProviderConfig: true })).toBeNull();
    expect(staticModelCatalogFor(undefined)).toBeNull();
  });

  // 静态目录的 wire 合法性：provider/model 的 id 必须能过 web 的 segment 规则
  // （单斜杠路由），defaultModel 必须真的在目录里 —— 否则前端 normalizeCatalog
  // 整包判非法，面板从「空目录」变红色报错。
  it("emits wire-legal static catalogs", () => {
    const ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    for (const agentName of ["claude", "codebuddy"]) {
      const catalog = staticModelCatalogFor(agentName, { hasProviderConfig: true })!;
      expect(catalog.providers.length).toBeGreaterThan(0);
      const routes = new Set<string>();
      for (const provider of catalog.providers) {
        expect(provider.id).not.toContain("/");
        expect(provider.models.length).toBeGreaterThan(0);
        for (const model of provider.models) {
          expect(model.id).not.toContain("/");
          const route = `${provider.id}/${model.id}`;
          expect(route).toMatch(ROUTE_RE);
          routes.add(route);
        }
      }
      if (catalog.defaultModel !== null) {
        expect(routes.has(catalog.defaultModel)).toBe(true);
      }
    }
  });
});
