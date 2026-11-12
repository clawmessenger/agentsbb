// 设备端内置的**静态兜底目录**（面板永远有内容的最后防线）。
//
// 只收录 modelInjection !== 'none' 的 agent（见 agent-model-capabilities.ts）：
// 给一个选了不生效的目录，比空态更糟 —— 用户会以为设置成功了（设计 D 的红线）。
// 每份清单都从 Go 服务端的静态表**逐条抄写**（行号见各表注释），不臆造 id。
//
// wire 形状必须严格匹配 web 的 normalizeCatalog（node-model-catalog.ts）：
// provider/model 的 id 都要能拼成单斜杠 `provider/model` 路由，defaultModel 必须
// 在目录里 —— 否则前端整包判非法，面板从「空目录」变红色报错。
//
// 注意这里只 import 类型：model-catalog.ts 会反过来 import 本文件（加载器合并
// 静态目录），值级循环依赖会让模块初始化顺序变得脆弱。

import type { DiscussionModelCatalog } from "./model-catalog.js";

// claude：models.go:586-599 claudeStaticModels（逐条对应，含 Label 与 Default）。
// provider 统一 anthropic —— Claude Code 的 --model 收裸 id，前缀只用于前端分组
// （注入时由 agents.ts 的 claude 分支剥掉）。
function claudeStaticCatalog(): DiscussionModelCatalog {
  const models: Array<{ id: string; name: string }> = [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ];
  return {
    defaultModel: "anthropic/claude-sonnet-4-6",
    providers: [{ id: "anthropic", name: "Anthropic", models }],
  };
}

// codebuddy：models.go:2974-2982 codebuddyStaticModels（逐条对应）。仅当
// clawmessenger-provider.json 存在（端点已配置）时才会被加载器采用 —— 注入走
// CODEBUDDY_MODEL（agents.ts agentRuntimeEnv），没有网关配置时选了等于没选；
// provider 分组按 models.go:2934-2955 codebuddyModelProvider 的前缀规则。
function codebuddyStaticCatalog(): DiscussionModelCatalog {
  return {
    defaultModel: null,
    providers: [
      {
        id: "anthropic",
        name: "anthropic",
        models: [
          { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
        ],
      },
      { id: "google", name: "google", models: [{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }] },
      { id: "openai", name: "openai", models: [{ id: "gpt-5.5", name: "GPT 5.5" }] },
      {
        id: "deepseek",
        name: "deepseek",
        models: [{ id: "deepseek-v3-2-volc-ioa", name: "Deepseek V3 2 Volc IOA" }],
      },
    ],
  };
}

const STATIC_CATALOGS: Readonly<Record<string, () => DiscussionModelCatalog>> = {
  claude: claudeStaticCatalog,
  codebuddy: codebuddyStaticCatalog,
};

export interface StaticCatalogGate {
  /** agent 的 provider 端点配置是否可用（codebuddy 的静态目录以此为门槛）。 */
  hasProviderConfig: boolean;
}

/**
 * 返回该 agent 的静态兜底目录；`null` = 不提供（无清单或门槛不满足）。
 *
 * 门槛规则同样写死在这里而不是调用方：codebuddy 需要 hasProviderConfig，
 * claude 无条件可用。调用方只需保证 agent 的 modelInjection !== 'none'
 * （那一层闸门在加载器里，依据 agent-model-capabilities.ts）。
 */
export function staticModelCatalogFor(
  agentName: string | undefined,
  gate: StaticCatalogGate = { hasProviderConfig: false },
): DiscussionModelCatalog | null {
  if (!agentName) return null;
  const build = STATIC_CATALOGS[agentName];
  if (!build) return null;
  if (agentName === "codebuddy" && !gate.hasProviderConfig) return null;
  return build();
}
