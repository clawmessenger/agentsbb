// 设备端「模型目录来源 × 模型注入方式」能力矩阵（单一事实源）。
//
// 为什么要有这张表：目录发现（panel 能不能看到模型）与模型注入（选了之后下一轮
// 是否真的生效）是两条独立链路，历史上每加一家 agent 都只改了一半 —— 出现过
// 「目录有内容但选了没用」和反过来「能注入却看不到目录」两种半残状态。这张表
// 把两件事钉在同一个地方：
//
//   * catalogSource  —— 目录从哪来：
//       'cli'        跑 agent 自己的列举子命令（AGENT_MODEL_LIST，model-catalog.ts）
//       'config'     读 agent 自己的配置文件 / probe 端点（model-providers.ts）
//       'static'     设备端内置的静态兜底目录（model-static-catalogs.ts）
//       'none'       不提供目录（面板显示解释文案，不是报错）
//   * modelInjection —— savedDefaultModel 如何作用到下一轮 CLI 调用：
//       'argv'        buildModelArgs 拼进命令行
//       'stdin-frame' 随 stdin 协议帧携带（目前只有 dsh 的 execute 帧）
//       'env'         子进程环境变量（codebuddy 的 CODEBUDDY_MODEL）
//       'none'        无法可靠注入 —— 这类 agent **绝不给目录**（设计 D：
//                     「选了没用」比「看不到」更糟）
//
// 证据来源逐家标注（Go 服务端权威实现 server/pkg/agent/*.go 的行号，以及本包
// agents.ts 的注入分支）。新加 agent 时必须先在这里登记，再动 AGENT_MODEL_LIST /
// buildModelArgs / model-static-catalogs.ts。

export type CatalogSource = "cli" | "config" | "static" | "none";
export type ModelInjection = "argv" | "stdin-frame" | "env" | "none";

export interface AgentModelCapability {
  /** 目录来源（可多路并集时写主要来源；并集细节见 model-catalog.ts）。 */
  catalogSource: CatalogSource;
  /** 模型注入方式。'none' = 不提供目录、不注入。 */
  modelInjection: ModelInjection;
}

export const AGENT_MODEL_CAPABILITIES: Readonly<Record<string, AgentModelCapability>> = {
  // claude：Go 有 stream-json 控制协议目录（claude_models.go:215），但设备端
  // 复刻整套控制协议成本不成比例；静态表来自 models.go:586-599
  // claudeStaticModels。注入：`--model` 收裸模型 id（claude_models.go:340-344
  // —— daemon 落库并传给 --model 的是 catalog 的裸 ResolvedModel），provider
  // 前缀只是给前端分组的 anthropic（agents.ts buildModelArgs claude 分支剥掉）。
  claude: { catalogSource: "static", modelInjection: "argv" },

  // codex：目录走 ~/.codex/config.toml 的端点 probe（parseCodexConfig）；Go 的
  // debug models 输出裸 slug 且不全部可跑（model-providers.ts:17-19），不做静态。
  // 注入：`-c model_provider=<id> -m <slug>`（agents.ts:204-208）——静态目录会在
  // 配置缺失时注入一个不存在的 provider，所以 codex 刻意不给静态。
  codex: { catalogSource: "config", modelInjection: "argv" },

  // opencode：`opencode models` + 配置 declaredModels + 端点 probe 三路并集
  // （model-catalog.ts / parseOpencodeConfig）。注入：--model 必须带 provider
  // 前缀（models.go:348-353 ModelSelectorMustBeProviderQualified）。
  opencode: { catalogSource: "cli", modelInjection: "argv" },

  // codebuddy：目录走 agentsbb-provider.json（旧名文件兜底）端点 probe；probe 失败时用
  // codebuddyStaticModels 兜底（models.go:2974-2982）——但只在端点配置存在时
  // 才给：注入走 CODEBUDDY_MODEL（agents.ts agentRuntimeEnv），没有网关配置时
  // 该变量根本不会被设置，选了等于没选。
  codebuddy: { catalogSource: "config", modelInjection: "env" },

  // codearts：Go 走 ACP session/new（models.go:270-273），设备端无 ACP 客户端；
  // 注入被 agents.ts:230-241 明确禁用（模型走它家账户/配置）。
  codearts: { catalogSource: "none", modelInjection: "none" },

  // deveco：Go 走 ACP（models.go:274-277）；deveco 的 -m 虽自称收 provider/model
  // 但凭据为 0 时注入只会把「没登录」报错提前（agents.ts:230-241）。
  deveco: { catalogSource: "none", modelInjection: "none" },

  // openclaw：`openclaw models list --json` + 配置 + probe 并集（AGENT_MODEL_LIST /
  // parseOpenclawConfig）。注入：--model 整段路由（agents.ts 默认分支）。
  openclaw: { catalogSource: "cli", modelInjection: "argv" },

  // hermes：Go 走 ACP（models.go:1520-1539）；设备端走 config.yaml 端点 probe
  // （parseHermesConfig）。注入：`-m <slug> --provider <id>`（agents.ts:209-211）。
  hermes: { catalogSource: "config", modelInjection: "argv" },

  // pi：`pi --list-models`（models.go:1232-1247 discoverPiModelsTable 的兜底路；
  // RPC 路是私有协议，设备端不做）。注入：--model 整段透传，按首斜杠拆反而是
  // 硬错误（agents.ts:220-225，pi.go:1001-1010）。
  pi: { catalogSource: "cli", modelInjection: "argv" },

  // omp：Go 按 builtin runtime 走 descriptor 的 ModelDiscovery，无则空目录
  // （models.go:203-209）；设备端没有已验证的列举命令。注入同 pi 家族（argv
  // 整段路由，agents.ts:223-225）——能注入但没有目录来源，面板走解释文案。
  omp: { catalogSource: "none", modelInjection: "argv" },

  // cursor-agent：抓包 init 的 model 是 "Auto"，模型选择走 cursor 账户配置
  // （agents.ts:212-215）；Go 走 ACP（models.go:234-237）。
  "cursor-agent": { catalogSource: "none", modelInjection: "none" },

  // kimi：`kimi provider list --json`（2026-11 真机实测，exit 0）—— models 的
  // key 就是 `provider/model` 路由，逐项带 displayName，直接可映射。⚠️ 同一份
  // 输出里 providers.*.apiKey 是明文真实密钥，解析器只读 models 段（安全红线）。
  // 注入：`-m/--model` 收的正是这种 alias（`kimi --help` 自述 "LLM model alias"，
  // 默认值来自 config.toml 的 default_model），整段路由直接注入 —— 旧代码
  // 「kimi 一律不注入」是 ACP 目录时代的保守假设，已被 provider list 推翻。
  kimi: { catalogSource: "cli", modelInjection: "argv" },

  // reasonix：Go 走 ACP（models.go:250-253）；注入禁用（agents.ts:230-241）。
  reasonix: { catalogSource: "none", modelInjection: "none" },

  // dsh：`dsh --profile multica --list-models` 输出版本化 JSONL 的 models 帧
  // （dsh.go:436-479 discoverDshModels；profile 常量 dsh.go:19，设备端启动参数
  // 同款 —— agents.test.ts:277-279）。注入：模型随 stdin 的 execute 帧携带，
  // 协议字段就是 {provider,id} 形（dsh.go:36-40、111-117；agents.ts:2452-2465）。
  dsh: { catalogSource: "cli", modelInjection: "stdin-frame" },

  // kiro-cli：Go 走 ACP（models.go:258-261）；设备端无 ACP，无注入证据。
  "kiro-cli": { catalogSource: "none", modelInjection: "none" },

  // agy（Antigravity）：`agy models` 本地枚举（models.go:2407-2425，MUL-3125）；
  // 输出是「id\tlabel」行、条目无 provider 字段（models.go:2427-2452），设备端
  // 用自造的 `agy` 前缀分组。注入：agy 1.0.6 起 --model 收目录里的裸 id。
  agy: { catalogSource: "cli", modelInjection: "argv" },

  // qodercli / qoderclicn：Go 走 ACP（models.go:262-265）；官方参数表没有可注入
  // 的模型参数（agents.ts:216-219）。
  "qodercli": { catalogSource: "none", modelInjection: "none" },
  "qoderclicn": { catalogSource: "none", modelInjection: "none" },

  // traecli：官方 CLI 是 ACP-native，目录来自 session/new（models.go:227-233）；
  // 模型由服务端配置（agents.ts:216-219）。
  traecli: { catalogSource: "none", modelInjection: "none" },

  // grok：`grok models`（2026-11 真机实测，exit 0，人类可读文本）给出目录：
  // 连字符 id（`quukk-glm-5.2`）+ 裸 id（`grok-4.7`），头部 `Default model:` 行
  // 给默认值。wire 只认单斜杠，所以 parseGrokModelsList 把「第一个 `-` 前」当
  // provider（裸 id `grok-4.7` → `grok`+`4.7`；**不用白名单猜 `xai`**）；注入
  // `-m` 用 grokCliModelId 把路由转回连字符形状 —— 双射，round-trip 无损。
  // 已知展示局限：`grok-4.7` 在面板里显示为 `grok/4.7`，功能不受影响。
  grok: { catalogSource: "cli", modelInjection: "argv" },

  // qwen：无账号无关的 headless 目录（models.go:293-297 明确返回空）；设备端走
  // ~/.qwen/settings.json 端点 probe（parseQwenConfig）。注入：--model 裸 slug
  // （agents.ts:191-199）。
  qwen: { catalogSource: "config", modelInjection: "argv" },

  // qwenpaw / mcode / zeroclaw：set_model 不支持 session 粒度 / 无目录 / 无
  // set_model（models.go:298-309、325-331、433-452 ModelSelectionSupported）。
  qwenpaw: { catalogSource: "none", modelInjection: "none" },
  mcode: { catalogSource: "none", modelInjection: "none" },
  zeroclaw: { catalogSource: "none", modelInjection: "none" },

  // dim：Go 走 ACP（models.go:317-324），需 OAuth 登录；设备端无 ACP。
  dim: { catalogSource: "none", modelInjection: "none" },
};

// 未知 agent 名一律按「无目录、无注入」保守处理：宁缺毋滥，绝不猜参数。
const UNKNOWN: AgentModelCapability = { catalogSource: "none", modelInjection: "none" };

/** Capability lookup; unknown agent names degrade to the conservative default. */
export function agentModelCapability(agentName: string | undefined): AgentModelCapability {
  if (!agentName) return UNKNOWN;
  return AGENT_MODEL_CAPABILITIES[agentName] ?? UNKNOWN;
}
