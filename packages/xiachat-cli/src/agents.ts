import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  type ActivityStep,
  classifyTool,
  createActivityTracker,
} from "./agent-activity.js";
import { ensureCodexBehaviorPrompt, ensureCodexOutputStyle, ensureCodexFastStart, ensureQwenFastStart } from "./agent-instructions.js";
import {
  fsGateExempt,
  fsRestriction,
  loadPermissionSnapshot,
  opencodeBehaviorPath,
  sanitizeAgentId,
  writeOpencodeBehaviorFile,
  type PermissionSnapshot,
} from "./agent-permissions.js";
import {
  buildDeviceOpencodeConfig,
  discoverOpencodeConfigPath,
  readAgentConfig,
  type AgentConfig,
} from "./model-providers.js";
import { isSessionId } from "./agent-sessions.js";
import {
  isServeStartupFailure,
  parseServeListeningUrl,
  parseServePassword,
  runServerSession,
} from "./opencode-server.js";
import { TurnIncompleteError } from "./turn-error.js";

// Mirrors knownAgentCLIs in server/internal/integrations/rongcloud/
// discussion_bridge.go — keep both lists in sync.
export const KNOWN_AGENT_CLIS: readonly string[] = [
  "claude", "codex", "opencode", "codebuddy", "codearts", "deveco",
  "openclaw", "hermes", "pi", "omp", "cursor-agent", "kimi",
  "reasonix", "dsh", "kiro-cli", "agy", "qodercli", "qoderclicn",
  "traecli", "grok", "qwen", "qwenpaw", "mcode", "dim", "zeroclaw",
];

export interface AgentInfo {
  name: string;
  path: string;
}

export interface RunAgentTurnOpts {
  execPath: string;
  // Agent CLI name (as in KNOWN_AGENT_CLIS); selects the invocation
  // strategy. When omitted, the prompt always goes via stdin.
  agentName?: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  // 原始缓冲上限（只影响「留不留原始 stdout」，不影响解析）。
  maxOutputBytes?: number;
  // 真止损：读到这个量级就掐进程并以 output_truncated 失败收尾。
  // 默认 HARD_OUTPUT_BYTES；测试用它把阈值调到可复现的规模。
  hardOutputBytes?: number;
  // Working directory for the agent CLI process. The ops agent sets this to
  // its workdir so `opencode run` picks up the ops AGENTS.md system prompt.
  cwd?: string;
  onChunk?: (chunk: string) => void;
  // 思考流增量（可选）：claude/codex 的 stream-json 模式下，agent 的
  // thinking/reasoning 过程文本与正文分道回调。不支持思考流的 agent
  // 不调用它，调用方天然降级为纯正文流。
  onReasoningChunk?: (chunk: string) => void;
  // 过程流（可选）：agent 本轮的工具调用步骤。回调的是**全量快照**而非增量，
  // 与 text/reasoning 同语义 —— 调用方只管存最新的那份。仅 stream-json 型
  // agent（claude/codex）会产生，其余 agent 一次都不回调。
  onActivity?: (steps: ActivityStep[]) => void;
  signal?: AbortSignal;
  // 会话隔离键（可选）。多个会话形态共用同一个 agent 二进制，而 agent CLI
  // 默认把它们全塞进自己的「主会话」：openclaw 的默认键就是 agent:main:main，
  // 于是讨论组、普通群聊、私聊共享一串上下文。讨论组里达成过的共识（例如
  // 「没有主题就回『等待主题发布』占位」）会被后续群聊继承，群聊于是答非
  // 所问。支持显式会话键的 agent（当前只有 openclaw 的 --session-key）按
  // 「会话形态 + 会话 id」分桶；不支持的 agent 忽略此参数。
  sessionKey?: string;
  /**
   * 上一轮该 sessionKey 对应的 agent 原生会话 id（见 agent-sessions.ts）。
   * 空 = 开新会话；不支持续接的 agent 会忽略它。
   */
  resumeSessionId?: string;
  /**
   * 本轮事件流里出现的 agent 会话 id（可能是新建的，也可能是续接的那个）。
   * 调用方负责按 sessionKey 落盘，供下一轮 resume。
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * 本轮要注入的**行为规范**（仅私聊非空）。
   *
   * 群聊/讨论组/聊天室的行为准则由服务端拼进 role_prompt，设备端不能再注入一遍；
   * 私聊没有服务端注入点，所以只有私聊轮次会带上它。落在**指令层**（codex 的
   * AGENTS.md 标记块 / opencode 的 instructions 文件），绝不拼进用户消息 ——
   * 见 agent-instructions.ts 顶部的设计说明。
   */
  behaviorPrompt?: string;
  /**
   * 本轮的**权限身份**（缺省 = agentName）。
   *
   * 执行器名和身份名不是一回事：内置运维助手（`ops`）跑的是 opencode 这个
   * 可执行文件，`agentName` 因此是 "opencode"，但它的权限身份是 "ops"。
   * 不分开就会踩两个坑（现场 2026-11-04 22:29）：
   *   · `FS_GATE_EXEMPT_AGENTS` 里的 ops 豁免永远命不中 —— 同机任一对话
   *     agent 关掉读写（本机 hermes 就是 allowFs=false），整机进入限制态，
   *     运维轮次跟着被禁；
   *   · 限制态下会走 opencode 的**对话用派生配置**（permission.bash=deny、
   *     tools.bash=false），于是运维轮次连 bash 工具都没有，只能回用户
   *     「会话未提供 bash 工具，请在本机运行」。
   */
  agentIdentity?: string;
  /**
   * 内部用：本轮是否处于「文件读写禁止」限制态。由 runAgentTurn 从权限快照算出，
   * 递归回退（disableServerMode）时沿用同一个值。
   */
  fsRestricted?: boolean;
  // 内部用：serve 模式起不来时退回 run --format json，递归进来时置 true，
  // 避免二次分流。外部调用方不该传。
  disableServerMode?: boolean;
}

// Agents known to reject or hang on stdin-mode invocation get an argv
// strategy: the prompt rides as a CLI argument instead of stdin.
//   claude:   print mode (-p), non-interactive
//   codex:    `exec` subcommand (stdin-mode invocation is rejected)
//   opencode: `run` subcommand (stdin-mode invocation hangs)
//   openclaw: `agent --local --json -m` one-shot message; --json emits a
//             clean result envelope (plain stdout interleaves ANSI-colored
//             log lines with the answer — see parseOpenclawJsonOutput)
//   hermes:   `-z` one-shot prompt (stdin-mode unsupported)
// Keep in sync with agentArgvArgs in server discussion_bridge.go.
export interface AgentArgvContext {
  /** 本轮处于「文件读写禁止」限制态（见 agent-permissions.ts fsRestriction）。 */
  fsRestricted?: boolean;
  /**
   * 上一轮该会话的 **agent 原生会话 id**：能续接的 agent 在这里接上同一个会话
   * （见 agent-sessions.ts 的说明）。空 = 开新会话。
   *
   * 位置敏感：各家的续接参数必须放在它自己的子命令之后、prompt 之前，
   * 所以注入点写在每条策略里，而不是统一拼在 argv 末尾。
   */
  resumeSessionId?: string;
}
type AgentArgvStrategy = (
  prompt: string,
  model?: string,
  sessionKey?: string,
  ctx?: AgentArgvContext,
) => string[];

// The web stores a model as a `provider/model` route. Most agent CLIs take
// that verbatim, but two split it:
//   codex  — `-m` takes a bare slug; the provider comes from config, so the
//            route's provider is applied via `-c model_provider=<id>`.
//            (`-m quukk_direct/glm-5.2` fails with model_not_found.)
//   hermes — `-m <slug> --provider <id>`.
// Verified against codex 0.x and hermes with the 127.0.0.1:49830 gateway.
const MODEL_ROUTE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

export function splitModelRoute(route: string): { provider: string; model: string } | null {
  const match = MODEL_ROUTE_RE.exec(route);
  return match ? { provider: match[1], model: match[2] } : null;
}

// `agentArgvStrategies` 在本文件里定义于 buildModelArgs **之后**。它是 const，
// 直接写 `agentArgvStrategies[name]` 在可读性上像 TDZ 陷阱（实际调用发生在模块
// 初始化完成后，是安全的），所以统一经这个惰性函数判断：谁在前谁在后都不影响。
function agentHasArgvStrategy(name: string): boolean {
  return agentArgvStrategies[name] !== undefined;
}

/** Renders the model-selection flags for one agent. */
export function buildModelArgs(name: string, model: string | undefined): string[] {
  // codebuddy 的 `--model` 只认它自己的模型 id（`custom-local:<m>` 或云端托管
  // 模型）；传裸模型名会直接要求登录，传自定义网关的 slug 则无意义 —— 它的
  // 模型选择必须走 `CODEBUDDY_MODEL` 环境变量（见 agentRuntimeEnv）。这里只留
  // `--port 0`：不给它固定端口，多个 agent 实例并发时会撞 EADDRINUSE。
  if (name === "codebuddy") return ["--port", "0"];
  // kimi 的 `-m` 只认自己的模型别名（`kimi-code/kimi-for-coding` 这类），
  // 我们的 `provider/model` 路由会被它当成未知模型拒绝。模型选择交给它自己的
  // 配置（`default_model`），这里不注入。
  if (name === "kimi") return [];
  if (!model) return [];
  const route = splitModelRoute(model);
  // qwen 走 OpenAI 兼容网关，`--model` 只接受上游的裸模型名（`quukk/glm-5.2`
  // 会被它当成未知模型名发给上游）。
  //
  // 它必须留在下面那道「无策略不注入」的守卫**之前**：qwen 在设备端没有 argv
  // 策略（提示词走 stdin），但 `--model` 是它确实支持的参数，守卫先行会把
  // stdin 模式下选好的模型静默丢掉。
  if (name === "qwen") {
    return route ? ["--model", route.model] : ["--model", model];
  }
  // 没有 argv 策略的 agent 会退化成「裸进程名」（buildAgentArgs 返回 []），给它
  // 追加 `--model` 只会让不认这个参数的 CLI 更早退出（opencode 未知参数就是
  // usage dump + exit 1）。模型选择对这些 agent 本来就无效，不要注入。
  if (!agentHasArgvStrategy(name)) return [];
  if (name === "codex") {
    return route
      ? ["-c", `model_provider=${route.provider}`, "-m", route.model]
      : ["-m", model];
  }
  if (name === "hermes") {
    return route ? ["-m", route.model, "--provider", route.provider] : ["-m", model];
  }
  // cursor-agent：抓包（testdata/cursor-agent-2026.07.20-stream-json.jsonl:1）
  // 里 init 的 model 是 "Auto"，模型选择走 cursor 账户自己的配置；我们不认的
  // 路由塞给它只会让它在启动时退出。不注入，模型跟随账户默认。
  if (name === "cursor-agent") return [];
  // traecli / qodercli / qoderclicn：官方 CLI 文档的参数表没有可注入的模型
  // 选择参数（traecli 的模型由服务端配置；qoder 的模型走它自己的账号体系），
  // 设备端不猜参数名。没有证据就不注入。
  if (name === "traecli" || name === "qodercli" || name === "qoderclicn") return [];
  // pi / omp：pi 的模型选择器原生接受 `provider/id` 与裸 id 整段透传
  // （pi.go:1001-1010，GH #7300）——按首斜杠拆 provider 反而是硬错误
  // （"Unknown provider"），所以整段传，不拆路由。
  if (name === "pi" || name === "omp") {
    return ["--model", model];
  }
  // dsh：协议的模型字段是 {provider,id} 对（dsh.go:36-40），JSONL 命令在
  // stdin 里拼装（runAgentTurn 的 dsh 专用分支），argv 里没有 --model 这个
  // 旗标——这里返回空，模型信息由 stdin 命令携带。
  if (name === "dsh") return [];
  // B 类第二批（2026-11-10）：deveco / mcode / qwenpaw / dim / grok /
  // reasonix / zeroclaw 的模型选择都走各家自己的账户或配置文件（deveco 的
  // auth.json、kimi 同款目录型配置、zeroclaw 的 [providers.models.custom]），
  // 我们的 provider/model 路由它们并不认识——deveco 的 -m 虽然自称收
  // provider/model，但凭据为 0 时注入只会把「没登录」报错提前；qwenpaw 的
  // -m 要的是 `anthropic/claude-sonnet-4-5` 形的它家路由。没有证据就不注入，
  // 模型跟随各家默认配置。
  if (
    name === "deveco" || name === "mcode" || name === "qwenpaw"
    || name === "dim" || name === "grok" || name === "reasonix"
    || name === "zeroclaw"
  ) return [];
  return ["--model", model];
}

// Subprocess environment overrides per agent. Returns the full env to hand to
// spawn() (the caller's env already merged in), or `null` when the agent needs
// no change and should simply inherit.
//
// codebuddy is the only one today: its CLI dropped ANTHROPIC_BASE_URL support
// and only honours the self-hosted-gateway switches `CODEBUDDY_BASE_URL` /
// `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_MODEL` (OpenAI-compatible
// `/v1/chat/completions`, verified against quukk). Without these it falls back
// to the WorkBuddy-hosted channel, which answers `Authentication required`
// or 429 weekly-quota once the account limit is hit.
export function agentRuntimeEnv(
  agentName: string | undefined,
  model: string | undefined,
  opts: { env?: NodeJS.ProcessEnv; config?: AgentConfig | null } = {},
): NodeJS.ProcessEnv | null {
  // qwenpaw（Python CLI）：Windows 管道上 Python 的 stdout 默认编码跟随
  // locale（GBK），回复里的中文会以 GBK 字节流出而我们按 UTF-8 解码 ——
  // 整段正文乱码。PYTHONUTF8=1 强制 Python 进程全程 UTF-8（stdout/stderr/
  // 文件系统），是唯一无需改它源码的修法。
  if (agentName === "qwenpaw") {
    const baseEnv = opts.env ?? process.env;
    return { ...baseEnv, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  }
  if (agentName !== "codebuddy") return null;
  const config = opts.config === undefined ? readAgentConfig("codebuddy") : opts.config;
  const endpoint = config?.endpoints[0];
  if (!endpoint) return null;
  const baseEnv = opts.env ?? process.env;
  const route = model ? splitModelRoute(model) : null;
  const chosen = route?.model
    ?? (config?.defaultModel ? splitModelRoute(config.defaultModel)?.model : undefined)
    ?? model;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CODEBUDDY_BASE_URL: endpoint.baseUrl,
    ...(endpoint.apiKey ? { CODEBUDDY_AUTH_TOKEN: endpoint.apiKey } : {}),
    ...(chosen ? { CODEBUDDY_MODEL: chosen } : {}),
  };
  return env;
}

// 结构化事件流可用性：这些 agent 都能以「逐行 JSON 事件」模式运行，正文增量
// 与工具步骤可被解析（见 parseStreamJsonLine / agent-activity.ts）。claude /
// codex / opencode 原生上报 thinking/reasoning；hermes 上游的 stream_json.py
// 只把 text 与 tool_use/tool_result 写进协议（-q 静默模式还会把 reasoning
// 回调置空），需要跑 scripts/patch-hermes-reasoning.py 把思考接进来 ——
// 没打补丁时它只贡献「逐字正文 + 工具过程」。
// 其余 agent（stdin 模式、或只吐一次性 JSON 信封如 openclaw）不在此列；
// openclaw 的信封里没有 reasoning payload（实测 2026.9.2），只有 toolSummary。
//
// qwen（2026-11-04 加入）：Qwen Code 0.25.3 `-o stream-json
// --include-partial-messages` 的事件协议与 claude 同构（thinking_delta /
// text_delta / assistant / result），解析复用 claude 分支，无需专属映射。
//
// B 类十家（2026-11-04 批量接入，逐家的协议依据见 agentArgvStrategies 与
// parseStreamJsonLine 的分支注释）：
//   - cursor-agent：官方 stream-json 的顶层 `{"type":"thinking","subtype":
//     "delta","text":…}` 事件，仓内真实抓包
//     server/pkg/agent/testdata/cursor-agent-2026.07.20-stream-json.jsonl。
//   - codebuddy：Claude Code fork，`-p --output-format stream-json --verbose`
//     的事件形状与 claude 完全同形，解析复用 claude 分支。
//   - pi / omp：pi 家族 `--mode json` 的 `message_update` 事件携带
//     assistantMessageEvent {type:"thinking_delta", delta:…}（上游 pi.go:555）；
//     omp 是同协议家族的衍生 CLI（上游 builtin_runtimes.go:86-100），共用解析。
//   - kimi：官方文档明确 stream-json 模式「thinking 内容不写入 JSONL」——
//     升级为逐字正文流（text 通道），思考拿不到，如实不虚构。
//   - traecli / qodercli / qoderclicn：一次性 headless 事件流（官方文档自述
//     支持 reasoning 输出），字段按证据优先级实现并标注置信度。
//   - dsh：版本化 stdio JSONL 的原生 thinking 帧（上游 dsh.go:394-396）。
//   - agy：1.1.8 起 `--output-format stream-json`；thought 字段名未实测，用
//     宽松匹配（thinking/thought/reasoning 任一 delta 都当思考），置信度中。
const STREAM_JSON_AGENTS = new Set([
  "claude", "codex", "opencode", "hermes", "qwen",
  "cursor-agent", "codebuddy", "pi", "omp", "kimi",
  "traecli", "qodercli", "qoderclicn", "dsh", "agy",
]);

export function agentSupportsReasoning(name: string | undefined): boolean {
  return name !== undefined && STREAM_JSON_AGENTS.has(name);
}

const agentArgvStrategies: Readonly<Record<string, AgentArgvStrategy>> = {
  // kimi 的策略在下方 qwen 之后（stream-json 升级版，含完整协议依据注释）。
  claude: (prompt, model, _sessionKey, ctx) => [
    "-p", prompt,
    // stream-json：逐行 JSON 事件流（thinking_delta / text_delta 可解析，
    // 同时是思考流数据源）。--verbose 是 stream-json 的前置要求。
    "--output-format", "stream-json", "--verbose",
    // 会话续接：同一个群/单聊/讨论组里的下一轮接在上一条会话后面（见
    // agent-sessions.ts）。id 由上一轮的 result/system.init 事件带回来。
    ...(ctx?.resumeSessionId ? ["--resume", ctx.resumeSessionId] : []),
    ...buildModelArgs("claude", model),
  ],
  codex: (prompt, model, _sessionKey, ctx) => [
    // 续接要换成 `exec resume <id> <prompt>` 的子命令形态（prompt 必须跟在 id
    // 后面）。实测 0.144.6：`codex exec resume <uuid> "hi" --json` 会被正常接受，
    // 不存在的 id 报 `no rollout found for thread id …`（见 agent-sessions.ts 的
    // isStaleSessionError，那条错误会被识别并自动改用新会话重跑）。
    ...(ctx?.resumeSessionId
      ? ["exec", "resume", ctx.resumeSessionId, prompt]
      : ["exec", prompt]),
    // --json：JSONL 事件流（reasoning.item_start/delta 等可解析）。实测
    // codex 0.144：未信任目录需 --skip-git-repo-check；stdin 模式会挂起
    // 等输入，必须保持 argv 模式（runAgentTurn argvMode 下 stdin 已 end）。
    "--json", "--skip-git-repo-check",
    // 文件读写禁止：codex 的 `-s/--sandbox read-only` 是**官方**沙箱策略
    // （0.144.6 的 `codex exec --help` 实测：read-only / workspace-write /
    // danger-full-access）。read-only 挡写入与联网，但**仍允许读取** ——
    // 这是 codex 侧能做到的最强限制，做不到「连读都不许」，报告里如实写了。
    ...(ctx?.fsRestricted ? ["--sandbox", "read-only"] : []),
    ...buildModelArgs("codex", model),
  ],
  // --format json --thinking：opencode 1.19 起支持逐行 JSON 事件（reasoning /
  // tool_use / text / step_start / step_finish），是思考流与过程流的数据源。
  // 不传这两个参数时它只输出「格式化好的纯文本」，思考与工具步骤全都拿不到
  // ——私聊里「AI 答了但看不到它想了什么、调了什么」就是这么来的。
  // ⚠️ `--format` 是 1.19 才有的参数；更老的 opencode 收到未知参数会直接退出。
  opencode: (prompt, model, _sessionKey, ctx) => [
    "run", prompt,
    "--format", "json", "--thinking",
    // `-s/--session <id>`：续接该会话（`-c/--continue` 是「目录里最近一个」，
    // 会把不同群聊串成一条，这里绝不能用）。
    ...(ctx?.resumeSessionId ? ["-s", ctx.resumeSessionId] : []),
    ...buildModelArgs("opencode", model),
  ],
  // --session-key 把这一轮绑到「会话形态 + 会话 id」的独立会话上。不带它时
  // openclaw 一律走默认主会话（agent:main:main），群聊会被讨论组的上下文
  // 带跑（见 RunAgentTurnOpts.sessionKey）。
  openclaw: (prompt, model, sessionKey) => [
    "agent", "--local", "--json", "-m", prompt,
    ...(sessionKey ? ["--session-key", sessionKey] : []),
    ...buildModelArgs("openclaw", model),
  ],
  // hermes chat -q … --format stream-json：1.0+ 的 one-shot 结构化事件流
  // （system/init → text 增量 / tool_use / tool_result → result）。旧的
  // `-z <prompt>` 只有「最后一坨正文」，工具过程与逐字上屏都拿不到，群聊里
  // 就只能等整包落地。--oneshot 保证非 TTY 下也是「答完即退」。
  hermes: (prompt, model, _sessionKey, ctx) => [
    "chat", "-q", prompt, "--oneshot", "--format", "stream-json",
    // 会话续接（`-r/--resume`）：hermes 的会话文件按 id 落盘，跨进程可续。
    ...(ctx?.resumeSessionId ? ["--resume", ctx.resumeSessionId] : []),
    ...buildModelArgs("hermes", model),
  ],
  // qwen（Qwen Code 0.25.3，gemini-cli 分支）：`-p` 官方定义是「Appended to
  // input on stdin (if any)」——argv 与 stdin 共存，不是 kimi 那种「-p 即非交互
  // 唯一入口」的二选一。所以策略成立时 prompt 走 argv（8000 字内），超长仍可
  // 退回 stdin 模式（buildAgentArgs 的老逻辑），两种形态都能答，不会挂起。
  //
  // `-o stream-json --include-partial-messages`：逐行 JSON 事件流，事件形状与
  // claude **完全同构**（本机 0.25.3 + quukk 网关 glm-5.2 实测，2026-11-04）：
  //   {"type":"stream_event","event":{"type":"content_block_delta",…,
  //     "delta":{"type":"thinking_delta","thinking":"…"}}}   ← 思考流
  //   {"type":"stream_event",…,"delta":{"type":"text_delta","text":"…"}}  ← 正文流
  //   {"type":"assistant","message":{"content":[…]}}        ← 含 thinking/text 块
  //   {"type":"result","result":"全文"}                     ← 权威全文
  // 现有 parseStreamJsonLine 的 claude 分支可直接消化，无需 qwen 专属映射；
  // 工具过程也顺带接通（content_block_start tool_use / assistant tool_use 块）。
  //
  // --include-partial-messages 是思考流的前置条件：不带它时 stream_event 里
  // 只有 goal_state / message_start / message_stop 这几个壳事件，thinking_delta
  // 与 text_delta 都不会上报（实测抓取确认）。qwen 自己还有 `-y/--yolo`，但
  // 设备端不需要工具自动批准——聊天场景模型几乎不调工具，真实调用时它会以
  // permission_denials 记录并继续文本回合（实测），保持默认即可。
  //
  // `--model` 注入仍在 buildModelArgs 的 qwen 专属分支（只收上游裸 slug），
  // 与本策略互不干扰。
  qwen: (prompt, model, _sessionKey, ctx) => [
    "-p", prompt,
    "--output-format", "stream-json", "--include-partial-messages",
    // `-r/--resume <id>`：按会话 id 续接（`-c` 是「本项目最近一个」，会串台）。
    ...(ctx?.resumeSessionId ? ["-r", ctx.resumeSessionId] : []),
    ...buildModelArgs("qwen", model),
  ],
  // cursor-agent（官方 headless：cursor.com/docs/cli/headless）：`-p <prompt>
  // --output-format stream-json` 是官方文档的一行式非交互入口；`-p` 的 prompt
  // 走 argv（与 claude 同形），超长时退回 stdin 模式由通用兜底接住。
  //
  // 事件协议字段零猜测：仓内有真实抓包
  // server/pkg/agent/testdata/cursor-agent-2026.07.20-stream-json.jsonl ——
  // 顶层 `{"type":"thinking","subtype":"delta","text":…}` 即思考流（cursor.go:186-203
  // 同款消费方式），正文在 `assistant` 消息与末尾 `result`。不加
  // --stream-partial-output：抓包证明不带它思考增量也逐条上报，正文的
  // assistant/result 全文语义更稳（partial 模式会引入需要去重的增量正文块）。
  // 不注入 --model：抓包显示 init 事件 model 为 "Auto"，cursor-agent 的模型
  // 选择走它自己的账户配置，我们的 provider/model 路由它不认。
  "cursor-agent": (prompt) => [
    "-p", prompt,
    "--output-format", "stream-json",
  ],
  // codebuddy（Claude Code fork）：argv 形状完整对齐上游 daemon
  // （server/pkg/agent/codebuddy.go:38-61）：`-p` 非交互 + stream-json 双向 +
  // --verbose。与 claude 完全同形的协议意味着思考解析直接复用 claude 分支。
  //
  // ⚠️ 不注入 --model：codebuddy 的 `--model` 只认它自己的模型 id，传裸模型名
  // 会直接要求登录（见 buildModelArgs 的 codebuddy 分支——只保留 `--port 0`）。
  // 模型选择继续走它专属的 CODEBUDDY_MODEL 网关 env（agentRuntimeEnv，
  // agents.ts:192-213），argv 策略的加入不改变那条 env 链路。
  //
  // 不带上游的 --permission-mode bypassPermissions / --disallowedTools：聊天
  // 场景模型几乎不调工具，设备端也没有 ACP 权限桥需要 bypass；少传参数降低
  // 对 CLI 版本的耦合。
  codebuddy: (prompt, _model, _sessionKey, ctx) => [
    "-p", prompt,
    "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
    // 会话续接：与 claude 同族（Claude Code fork），--resume 语义一致。
    ...(ctx?.resumeSessionId ? ["--resume", ctx.resumeSessionId] : []),
    ...buildModelArgs("codebuddy", undefined),
  ],
  // pi / omp（pi 协议家族，上游 builtin_runtimes.go:86-100 把 omp 派发给 pi
  // backend）：上游 buildPiArgs（pi.go:980-1029）的一次性形态是
  // `pi -p --mode json`，prompt 官方语义走 stdin 管道（"Pi reads piped stdin
  // to EOF as its initial prompt in print/JSON mode"，pi.go:421）——这是
  // 设备端「一次 spawn + stdin 收提示词」模型的天然契合点，不需要 ACP/RPC
  // 长驻会话（报告 §4 的判断：`--mode rpc` 是 JSON-RPC 长驻进程，为它引入
  // 会话生命周期管理成本过高；`--mode json` 的一次性事件流同源且够用）。
  //
  // 事件：`message_update` 携带 assistantMessageEvent {type:"thinking_delta",
  // delta:…} / {type:"text_delta", delta:…}（pi.go:545-559），thinking_delta
  // 即思考流。prompt 必须留在 stdin：pi 的 npm shim 在 Windows 上会把 argv
  // 里的提示词重新分词（pi.go:421-425 注释），所以这条策略不携带 prompt。
  //
  // buildModelArgs 对 pi/omp 走默认 `--model <整个路由>`：pi 自己的解析器
  // 接受 `provider/id` 与裸 id（pi.go:1001-1010，GH #7300——按首斜杠拆
  // provider 反而是硬错误），所以整段透传是正确形态。
  pi: (_prompt, model) => [
    "-p", "--mode", "json",
    ...buildModelArgs("pi", model),
  ],
  omp: (_prompt, model) => [
    "-p", "--mode", "json",
    ...buildModelArgs("omp", model),
  ],
  // kimi：官方唯一「不打开 TUI」的非交互入口是 `-p/--prompt`（kimi Command
  // 参考原文："Run a single prompt non-interactively and stream the Assistant
  // output to stdout. This mode does not open the TUI"）。
  //
  // ⚠️ 这条策略是必须的，不是优化：过去 kimi 没有策略 → buildAgentArgs 返回 []
  // → 实际 spawn 的是**裸 `kimi`**（交互式 TUI）。TUI 在 Windows 上拿不到
  // console 时直接退出，stderr 只有一句
  // `No Windows console found. Are you running cmd.exe?`（生产事故实证，
  // 设备端由 VBS 自启、没有 console，所以 100% 复现）。
  //
  // 把既有的 `-p` 策略从 `--output-format text` 升级为 stream-json（官方文档
  // moonshotai.github.io/kimi-code /reference/kimi-command：`--output-format`
  // 只能与 `-p` 同用，取值 text / stream-json）。stream-json 模式下官方明确
  // 「thinking 内容不会写入 JSONL」（text 模式下思考走 stderr）——所以这次
  // 升级拿到的是**逐字正文流 + result 权威全文**，思考通道在 kimi 上预期为空，
  // 如实降级，不虚构思考。
  //
  // stdout 从「答完一整包」变成逐行事件后，正文增量与工具过程（activity）
  // 全链路复用 stream-json 管线（Kimi Code 是 Claude Code 协议族的实现，
  // 事件形状同构，claude 分支直接消化）。仍不注入 --model（它的 -m 只认自家
  // 别名，见 buildModelArgs 的 kimi 分支）。
  kimi: (prompt) => ["-p", prompt, "--output-format", "stream-json"],
  // traecli：官方一次性 headless 入口是 `exec [PROMPT] --json`（docs.trae.cn
  // cli_command-line-parameters），事件流与它的 ACP 模式同源。不为它引入
  // `traecli acp serve` 的 ACP 会话管理（报告 §4：优先一次性 headless）。
  //
  // ⚠️ 置信度标注：exec JSONL 事件的 thought 字段名**待装机实测**（本机未装）。
  // 本仓上游对 traecli 走的是 ACP（traecli.go:111），ACP 侧的思考事件
  // `agent_thought_chunk` 有真实测试桩（traecli_test.go:55，traecli v0.120.42
  // 真实抓包格式）。exec JSONL 的解析按「宽松匹配 thought/thinking/reasoning
  // 增量」实现（见 parseStreamJsonLine），命中任何一种都当思考——字段名确认
  // 后收窄即可，方向不会错。
  traecli: (prompt) => [
    "exec", prompt, "--json",
  ],
  // qodercli：官方自述 `-p <prompt> --output-format stream-json` 可在脚本里
  // observe reasoning process（docs.qoder.com/cli/run-in-scripts +
  // cli-reference）。上游走的是 ACP（qoder.go:22-30），stream-json 是设备端
  // 更合算的一次性入口。
  //
  // ⚠️ 置信度标注：stream-json 模式的 thought 字段名**待装机实测**（官方文档
  // 描述了能力但没给事件样例），解析同样走宽松匹配（thinking/thought/
  // reasoning 任一 delta 都当思考），并在 system/init 后的 assistant 事件里
  // 兼容 claude 同形的 content 块——Qoder 与 Claude Code 系出同门的形态不少，
  // claude 分支先兜住正文。
  qodercli: (prompt) => [
    "-p", prompt, "--output-format", "stream-json",
  ],
  // qoderclicn：CN 区独立分发的同一 backend（qoder.go:34-38），argv 与解析
  // 与 qodercli 完全共享，纯注册。
  qoderclicn: (prompt) => [
    "-p", prompt, "--output-format", "stream-json",
  ],
  // dsh（DeepSeek DSH bundle）：上游 Multica 走的是版本化 stdio JSONL 协议
  // （DshProtocolVersion=1，dsh.go:13-30）。设备端复用同一条一次性 spawn
  // 模型：`--profile multica --stdio` 启动、提示词作为 execute 命令写进
  // stdin、stdout 逐行吐 JSONL 帧——thinking 帧是协议原生
  // （dsh.go:394-396 `case "thinking": MessageThinking`）。
  //
  // stdin 里发 {"v":1,"type":"execute","prompt":…}：协议是「启动后等 ready
  // 再收命令」的行式协议，不是 claude 那种裸文本 stdin。模型选择带
  // provider/model（协议的 model 字段就是 {provider,id} 形，dsh.go:36-40），
  // reasoning_effort 不注入（设备端没有档位选择）。
  dsh: (_prompt, model) => [
    "--profile", "multica", "--stdio",
    ...buildModelArgs("dsh", model),
  ],
  // agy（Antigravity，Gemini CLI 血统）：上游 buildAntigravityArgs
  // （antigravity.go:780-806）的一次性形态是
  // `agy -p <prompt> --dangerously-skip-permissions --output-format
  // stream-json`。1.1.8 起支持 stream-json（antigravity.go:22-24）。
  //
  // ⚠️ 置信度标注（报告三点存疑之一）：stream-json 事件里的思考字段名
  // **需实测**——上游 backend 只消费了 step_update 的 text_delta 与 usage
  // （antigravity.go:46 只有 thinking_tokens 统计），没透传思考正文。解析按
  // 宽松匹配实现：thinking/thought/reasoning 任一 delta 事件都当思考，绝不
  // 硬猜单一字段名。--dangerously-skip-permissions 是上游同款（聊天场景
  // 没有交互确认通道，不传它会卡在权限询问）。
  agy: (prompt, model) => [
    "-p", prompt, "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    ...buildModelArgs("agy", model),
  ],
  // B 类第二批（2026-11-10 全量真机接入，逐家实机验证过 headless 入口）。
  // 这一批统一走**纯文本输出**而不是各家的事件流：deveco/grok/dim 的事件或
  // 格式化输出没有稳定协议文档，mcode/reasonix 的 stream-json 事件形状未经
  // 真机抓包确认 —— 拿不到证据就不上解析分支，stdout 即正文（raw 通道），
  // 思考通道如实为空。模型选择都走各家自己的账户/配置文件，不注入 --model
  //（见 buildModelArgs 的对应分支），避免把不认的路由塞给 CLI 导致启动即退。
  //
  // deveco（华为 DevEco CodeGenie，opencode 血统）：`deveco run [message..]`
  // 是官方一次性入口（deveco run --help：不进 TUI，跑完退出）；默认 --format
  // default 输出格式化正文。裸 `deveco` 是交互 TUI —— 2026-11-10 现场：TUI
  // 在无 console 的 spawn 下喷 80 万字节进度条后被掐，整个回合 agent_failed。
  deveco: (prompt) => [
    "run", prompt,
  ],
  // mcode（Minimax Code）：`mcode exec [prompt]` 官方自述「Run one prompt
  // without starting the TUI」；不带 --output-format 时默认 text。裸 `mcode`
  // 在无 TTY 下直接拒绝（"interactive mode requires a TTY"）。
  mcode: (prompt) => [
    "exec", prompt, "--output-format", "text",
  ],
  // qwenpaw（QwenPaw，Python venv CLI）：`qwenpaw task -i <instruction>` 是
  // 官方 headless 单任务入口（task --help：Run a single task instruction
  // headlessly）。stdout 是「INFO 日志行 + 末尾一个 JSON 信封
  // {status, elapsed_seconds, response, usage}」，信封由 extractQwenpawReply
  // 在收尾时整段提取（见 emitsJsonEnvelope / close 分支）。
  // ⚠️ 中文经 .cmd shim + cmd.exe 的 %* 透传本身是 UTF-16 安全的，但 Python
  // 在 Windows 管道上的 stdout 默认编码是 locale（GBK），回复正文会整体乱码
  // —— agentRuntimeEnv 给 qwenpaw 注入 PYTHONUTF8=1 强制 UTF-8 输出。
  qwenpaw: (prompt) => [
    "task", "-i", prompt,
  ],
  // dim（DimAgent）：`dim exec [prompt]` 官方一次性入口；裸 `dim` 是 TUI，
  // 且在未信任目录直接退出（"not a trusted folder"，设备 workdir 需先跑一次
  // 交互式 dim 完成信任）。stdout 为正文文本。
  dim: (prompt) => [
    "exec", prompt,
  ],
  // grok（xAI Grok Build）：`-p/--single <PROMPT>` 官方 headless 单轮
  // （grok --help：Single-turn prompt. Prints the response to stdout and
  // exits），默认 --output-format plain 即纯正文。裸 `grok [PROMPT]` 是 TUI。
  grok: (prompt) => [
    "-p", prompt,
  ],
  // reasonix：`-p/--print <task>` 官方非交互入口，--output-format text 输出
  // 纯正文（json/stream-json 的事件形状未抓包，先不上解析）。裸 `reasonix`
  // 是 TUI；无参数时它打印 usage help —— 2026-11-10 现场 reasonix/zeroclaw
  // 的「回复」就是这份 help。
  reasonix: (prompt) => [
    "-p", prompt, "--output-format", "text",
  ],
  // zeroclaw（ZeroClaw，Rust）：`agent` 子命令是唯一的对话入口，且**必须**
  // 带 `-a/--agent <alias>`（没有默认 agent，缺别名直接打 usage help 退出）
  // 与 `-m/--message`（单条消息模式，不进交互会话）。输出为纯正文。
  // 设备约定别名固定为 "default"（~/.zeroclaw/config.toml 的 [agents.default]）。
  zeroclaw: (prompt) => [
    "agent", "-a", "default", "-m", prompt,
  ],
};

// Windows CreateProcess caps the whole command line near 32k chars (and
// .cmd wrappers shrink that further), so very long prompts cannot ride as
// argv — past this cap every agent falls back to stdin mode regardless of
// strategy.
//
// Exported because the html_revise path (im.ts) has to decide between
// inlining the previous page and handing over a file path: it must use
// exactly this threshold, or the prompt it builds still lands on the stdin
// fallback that codex/opencode/hermes reject or hang on.
export const ARGV_PROMPT_MAX_CHARS = 8000;

// Returns the argv for an agent turn; an empty array means stdin mode
// (unknown agent, or a prompt too long for argv).
export function buildAgentArgs(
  name: string,
  prompt: string,
  model?: string,
  sessionKey?: string,
  ctx?: AgentArgvContext,
): string[] {
  const strategy = agentArgvStrategies[name];
  if (!strategy || prompt.length > ARGV_PROMPT_MAX_CHARS) return [];
  return strategy(prompt, model, sessionKey, ctx);
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
// stream-json（claude/codex/opencode/hermes）的事件流含元数据行与思考流，同回答
// 体积约为纯文本 2-3 倍；opencode 还是「整段 part 全文」重复上报，一次带工具的
// 长回合轻松几十万字节。
//
// ⚠️ 这个上限现在只是**原始缓冲**的上限，不再是「这一轮到此为止」：超出后我们
// 停止攒原始字节，但**继续解析**事件流（正文照样上屏，最终正文由解析累积给出）。
// 过去在超限处直接 return，工具输出一洪峰，后半轮（含最终回答）就整段丢了，
// 前端却拿到一个 completed 终帧 —— 用户看到的就是「话说一半就结束了」。
const STREAM_JSON_MAX_OUTPUT_BYTES = 512 * 1024;
// openclaw 这类「一次性 JSON 信封」必须整份留存才能解析，没有流式正文可退，
// 所以给足额度（以前的 64KB 连一份带思考 payload 的正常回答都装不下）。
const ENVELOPE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
// 真止损：读到这个量级说明 agent 在喷日志/输出结果，这一轮不可能再有用，
// 直接掐进程并以 output_truncated 失败收尾（绝不假装答完）。
const HARD_OUTPUT_BYTES = 16 * 1024 * 1024;

function isWindowsScript(execPath: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(execPath);
}

// npm 生成的 .cmd/.bat shim 只是个转发器：openclaw.cmd → node openclaw.mjs，
// opencode.cmd → node_modules/opencode-ai/bin/opencode.exe。
//
// 为什么要穿透它：Node ≥18.20/20.12 拒绝直接 spawn .cmd（CVE-2024-27980），
// 于是命令行必须经 cmd.exe，而 cmd.exe 把命令里的**换行当命令分隔符**，还会
// 解释 & | ^ % 等元字符。2026-10-14 实测（openclaw 的 transcript_events 里存的
// 提示词只剩第一行）后果是：
//   · 多行提示词只到第一行就断 —— 群聊/讨论的 your_turn 因此只带着
//     `[discussion] round=1 speaking_order=1` 这一行进了 agent，用户的问题、
//     角色人设全部丢失，agent 只能回「等待主题发布」；
//   · 断点之后的参数一起丢 —— 包括 --session-key、--model，于是会话隔离失效；
//   · 用户正文里的 & 会被 cmd 当成命令分隔符。
// 所以能解析出真实目标时直接 spawn 它，shell 完全不经手。
export function resolveWindowsShim(
  execPath: string,
): { file: string; prefixArgs: string[] } | null {
  const cached = shimTargetCache.get(execPath);
  if (cached !== undefined) return cached;
  const resolved = parseWindowsShim(execPath);
  shimTargetCache.set(execPath, resolved);
  return resolved;
}

const shimTargetCache = new Map<string, { file: string; prefixArgs: string[] } | null>();

function parseWindowsShim(execPath: string): { file: string; prefixArgs: string[] } | null {
  let text: string;
  try {
    text = readFileSync(execPath, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(execPath);
  // shim 末行一定是 `"<目标>" %*`。取**最后一个**带可执行扩展名的引号路径，
  // 前面探测用的 "%dp0%\node.exe" 与 "%_prog%" 因此不会被误取。
  const matches = [...text.matchAll(/"([^"\r\n]+\.(?:exe|mjs|cjs|js))"/gi)];
  const raw = matches.at(-1)?.[1];
  if (!raw) return null;
  const target = raw.replace(/%~?dp0%?\\?/gi, dir.endsWith("\\") ? dir : `${dir}\\`);
  if (!existsSync(target)) return null;
  if (/\.exe$/i.test(target)) return { file: target, prefixArgs: [] };
  // 脚本目标要用 node 跑：优先 shim 同目录的 node.exe（nvm 的布局），否则交给
  // PATH 上的 node。**不能用 process.execPath** —— 那是本 CLI 自己的 SEA 二进制。
  const nodeExe = join(dir, "node.exe");
  return { file: existsSync(nodeExe) ? nodeExe : "node", prefixArgs: [target] };
}

// 兜底（shim 解析不出来时仍走 cmd.exe）：把参数里的换行抹掉 —— cmd 会把换行
// 当命令分隔符，一条多行提示词只到第一行就断。
function sanitizeForCmdArgs(args: string[]): string[] {
  return args.map((arg) => arg.replace(/\r?\n/g, "⏎"));
}

// Node >= 18.20/20.12 refuses to spawn .cmd/.bat directly (CVE-2024-27980),
// so those go through cmd.exe like a shell would — unless the shim's real
// target can be resolved, which we prefer for the reasons above. Everything
// else spawns directly, POSIX included.
export function buildSpawnInvocation(
  execPath: string,
  args: string[],
): { file: string; args: string[] } {
  if (isWindowsScript(execPath)) {
    const real = resolveWindowsShim(execPath);
    if (real) return { file: real.file, args: [...real.prefixArgs, ...args] };
    return { file: "cmd.exe", args: ["/d", "/s", "/c", execPath, ...sanitizeForCmdArgs(args)] };
  }
  return { file: execPath, args };
}

// On Windows, child.kill() only terminates the immediate wrapper process;
// the agent lives in a descendant. taskkill /T tears down the whole tree.
function killProcessTree(child: { pid?: number; kill: () => void }): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      // fall through to child.kill()
    }
  }
  child.kill();
}

// Drops trailing incomplete UTF-8 sequences (lead byte without its
// continuation bytes) so a byte-cap cut never decodes to U+FFFD. Exported
// for direct unit testing (pure function).
export function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  // Scan back over trailing continuation bytes (max 3) to find the last
  // sequence's lead byte; cut before that lead if the sequence is
  // incomplete within the buffer.
  const end = buf.length;
  for (let i = 1; i <= Math.min(4, end); i++) {
    const byte = buf[end - i];
    if ((byte & 0x80) === 0) {
      // ASCII: the sequence before it is complete; nothing to trim.
      return buf;
    }
    if ((byte & 0xe0) === 0xc0 || (byte & 0xf0) === 0xe0 || (byte & 0xf8) === 0xf0) {
      // Lead byte i-1 bytes from the end; incomplete → cut before the lead.
      const need = utf8SequenceLength(byte);
      return i < need ? buf.subarray(0, end - i) : buf;
    }
    // Continuation byte (0b10xxxxxx): keep walking back.
  }
  // Walked past 4 bytes with no lead byte: not valid UTF-8; drop the
  // trailing continuation run.
  return buf.subarray(0, Math.max(0, end - 4));
}

function utf8SequenceLength(lead: number): number {
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

// --- openclaw output extraction -------------------------------------------
// `openclaw agent --local` without --json interleaves ANSI-colored log
// lines ([model-fetch] start …, [agent] run … ended with stopReason=stop)
// with the answer on stdout. With --json (preferred) it emits one clean
// envelope instead. These helpers turn either shape into the plain reply.

// ANSI CSI/SGR escape sequences (colors, cursor moves) — openclaw colors
// its log lines even when piped.
// eslint-disable-next-line no-control-regex -- 这里匹配的就是 ESC/BEL 控制符本身
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

// Log lines look like `[model-fetch] start …` / `[agents/agent-command] …`
// — a leading bracket tag of word chars, dashes and slashes, NOT followed
// by `(` (markdown links `[label](url)` must survive).
const OPENCLAW_LOG_LINE_RE = /^\[[A-Za-z0-9_\-/]+\](?!\()/;

export function normalizeOpenclawOutput(raw: string): string {
  const lines = stripAnsiCodes(raw).split("\n");
  const kept = lines.filter((line) => !OPENCLAW_LOG_LINE_RE.test(line.trimStart()));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Parses the `openclaw agent --json` result envelope. Returns the reply
// text, or undefined when the output is not a recognizable envelope.
export function parseOpenclawJsonOutput(raw: string): string | undefined {
  const text = stripAnsiCodes(raw).trim();
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const envelope = parsed as {
    payloads?: unknown;
    meta?: { finalAssistantVisibleText?: unknown } | null;
  };
  if (Array.isArray(envelope.payloads)) {
    const texts = envelope.payloads
      // 思考（isReasoning）与错误（isError）payload 不是正文：混进气泡就是
      // 把模型的内心独白当成回答。它们走 extractOpenclawEnvelopeDetails。
      .filter((p) => !(typeof p === "object" && p !== null
        && ((p as { isReasoning?: unknown }).isReasoning === true
          || (p as { isError?: unknown }).isError === true)))
      .map((p) => (typeof p === "object" && p !== null ? (p as { text?: unknown }).text : undefined))
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  const visible = envelope.meta?.finalAssistantVisibleText;
  if (typeof visible === "string" && visible.length > 0) return visible;
  return undefined;
}

/**
 * openclaw 信封里的「这一轮到底有没有正常收尾」。
 *
 * 只看信封自己给出的权威字段，不做文案猜测：
 *   - meta.aborted === true            → 运行时把这轮掐了；
 *   - completion.finishReason（缺省取 stopReason）为 length / max_tokens /
 *     content_filter / error / tool_error → 回答被截断或被上游判废。
 * 这两种情况下正文通常只剩「我这就去查…：」这半句，绝不能当完整回答上屏。
 */
export interface OpenclawTurnHealth {
  incomplete: boolean;
  detail?: string;
}

const INCOMPLETE_FINISH_REASONS: ReadonlySet<string> = new Set([
  "length", "max_tokens", "max_output_tokens", "content_filter", "error", "tool_error",
]);

export function openclawTurnHealth(raw: string): OpenclawTurnHealth {
  const text = stripAnsiCodes(raw).trim();
  if (!text.startsWith("{")) return { incomplete: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { incomplete: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { incomplete: false };
  const meta = (parsed as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return { incomplete: false };
  const m = meta as {
    aborted?: unknown;
    stopReason?: unknown;
    completion?: { stopReason?: unknown; finishReason?: unknown } | null;
  };
  if (m.aborted === true) return { incomplete: true, detail: "aborted" };
  const finish = m.completion?.finishReason
    ?? m.completion?.stopReason
    ?? m.stopReason;
  if (typeof finish === "string" && INCOMPLETE_FINISH_REASONS.has(finish.trim().toLowerCase())) {
    return { incomplete: true, detail: `finishReason=${finish}` };
  }
  return { incomplete: false };
}

// Extracts the clean reply from an openclaw agent turn: the --json
// envelope when present, otherwise the ANSI/log-stripped plain stdout.
// Falls back to the raw trimmed text when both extractions come up empty
// so a turn never yields a blank reply.
export function extractOpenclawReply(raw: string): string {  const fromJson = parseOpenclawJsonOutput(raw);
  if (fromJson !== undefined && fromJson.trim().length > 0) return fromJson.trim();
  const normalized = normalizeOpenclawOutput(raw);
  if (normalized.length > 0) return normalized;
  return raw.trim();
}

// 有些 agent 的 stdout 是「一次性 JSON 信封」，而不是逐段正文：openclaw 的
// `agent --local --json` 把输入提示词、最终回复、执行 trace 打包成一个 JSON
// 一次吐出。这类 agent 绝不能参与增量回调 —— 原始增量是整份信封（含提示词
// 全文），web 的打字气泡里会出现一整坨 JSON；而终帧与兜底广播走的是
// extractOpenclawReply 提取后的正文，两者内容不等，web 按内容相等去重的
// streamEchoIndex（ai-message-lifecycle.ts）就失效，聊天里于是出现一对
// 「内容重复」的气泡（一条 JSON、一条正文）。
// 它们只发「处理中 → 完成」两端：终帧本身携带完整正文，气泡照样填满。
export function emitsJsonEnvelope(agentName: string | undefined): boolean {
  return agentName === "openclaw" || agentName === "qwenpaw";
}

// qwenpaw `task -i` 的 stdout 是「INFO 日志行 + 末尾一个 JSON 信封」，信封形如
// {"status":"success","elapsed_seconds":2.31,"response":"\n\nOK","usage":{}}。
// 提取策略：从最后一个「行首 {」起整段尝试 JSON.parse（qwenpaw 用 indent=2
// 打印信封，第一行必然是单独的 "{"），成功且带 response 字符串字段即正文；
// 失败（日志混进花括号、或 status 非 success 的错误信封）时退回原文去掉
// INFO 日志行 —— 绝不让这一轮变成空白回复。
export function extractQwenpawReply(raw: string): string {
  const start = raw.lastIndexOf("\n{");
  const candidate = start >= 0 ? raw.slice(start + 1) : raw.trim();
  if (candidate.startsWith("{")) {
    try {
      const parsed = JSON.parse(candidate) as { status?: unknown; response?: unknown; error?: unknown };
      if (typeof parsed.response === "string") {
        const reply = parsed.response.trim();
        if (reply.length > 0) return reply;
      }
      if (parsed.status === "error" && typeof parsed.error === "string") {
        return `qwenpaw task failed: ${parsed.error}`;
      }
    } catch {
      // 不是完整 JSON（信封后面可能还有日志）——落到底部按原文清理。
    }
  }
  // 兜底：去掉 qwenpaw 的 INFO/WARNING 日志行后返回剩余正文。
  const cleaned = raw
    .split("\n")
    .filter((line) => !/^(INFO|WARNING|DEBUG|ERROR) /i.test(line.trim()))
    .join("\n")
    .trim();
  return cleaned || raw.trim();
}

/**
 * openclaw 的 `agent --local --json` 信封里，除了最终正文还带着本条回复的
 * payloads（isReasoning 的那些就是模型的思考）与 toolSummary（工具调用汇总）。
 *
 * 信封是**一次性**的，所以这里拿到的思考不是逐字流，而是在一轮结束时整段补上
 * —— 群聊/讨论组里 openclaw 节点因此至少能展开「它想了什么、调了什么工具」，
 * 而不是只有一个光秃秃的结论。字段缺失时一律返回空对象（老版本信封）。
 */
export interface OpenclawEnvelopeDetails {
  reasoning?: string;
  tools?: { name: string; calls: number; failures: number }[];
}

export function extractOpenclawEnvelopeDetails(raw: string): OpenclawEnvelopeDetails {
  const text = stripAnsiCodes(raw).trim();
  if (!text.startsWith("{")) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const envelope = parsed as {
    payloads?: unknown;
    toolSummary?: unknown;
  };
  const details: OpenclawEnvelopeDetails = {};
  if (Array.isArray(envelope.payloads)) {
    const reasoning = envelope.payloads
      .map((payload) => (typeof payload === "object" && payload !== null
        ? payload as { isReasoning?: unknown; text?: unknown } : undefined))
      .filter((payload): payload is { isReasoning?: unknown; text?: unknown } =>
        payload?.isReasoning === true && typeof payload.text === "string")
      .map((payload) => (payload.text as string).trim())
      .filter((chunk) => chunk.length > 0);
    if (reasoning.length > 0) details.reasoning = reasoning.join("\n\n");
  }
  const summary = envelope.toolSummary;
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const rec = summary as { tools?: unknown; calls?: unknown; failures?: unknown };
    const names = Array.isArray(rec.tools)
      ? rec.tools.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    const totalCalls = typeof rec.calls === "number" && rec.calls > 0 ? rec.calls : names.length;
    const failures = typeof rec.failures === "number" && rec.failures > 0 ? rec.failures : 0;
    if (names.length > 0) {
      // 信封只给「工具名 + 总次数」，没有逐次调用 → 每种工具一条汇总步骤，
      // 次数作为摘要。宁可粒度粗一点也不编造不存在的调用顺序；多种工具时
      // 总次数无法摊到具体某个工具上，就按 1 次展示、丢失败计数。
      const single = names.length === 1;
      details.tools = names.map((name) => ({
        name,
        calls: single ? totalCalls : 1,
        failures: single ? failures : 0,
      }));
    }
  }
  return details;
}

export async function discoverAgents(opts: { extraPath?: string }): Promise<AgentInfo[]> {
  // When extraPath is provided (even empty) we scan ONLY there (tests and
  // explicit overrides must not pick up a real claude on the dev machine);
  // when absent we scan the real PATH.
  const dirs = opts.extraPath !== undefined
    ? opts.extraPath.split(delimiter).filter(Boolean)
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  const found: AgentInfo[] = [];
  for (const name of KNOWN_AGENT_CLIS) {
    for (const dir of dirs) {
      const candidates = process.platform === "win32"
        ? [join(dir, `${name}.exe`), join(dir, `${name}.cmd`), join(dir, `${name}.bat`)]
        : [join(dir, name)];
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.X_OK);
          found.push({ name, path: candidate });
          break;
        } catch {
          // keep scanning
        }
      }
      if (found.some((f) => f.name === name)) break;
    }
  }
  return found;
}

export interface RunAgentCommandOpts {
  execPath: string;
  argv: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_MAX_OUTPUT_BYTES = 256 * 1024;

// Runs a short, non-interactive agent subcommand (e.g. `opencode models`) and
// returns stdout. Shares runAgentTurn's spawn/argv handling but sends no stdin
// and never applies the prompt-argv strategy.
export function runAgentCommand(opts: RunAgentCommandOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_COMMAND_MAX_OUTPUT_BYTES;

  return new Promise<string>((resolve, reject) => {
    const { file, args } = buildSpawnInvocation(opts.execPath, opts.argv);
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: opts.cwd,
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        killProcessTree(child);
        reject(new Error(`agent command timeout after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stdout.on("data", (buf: Buffer) => {
      if (totalBytes >= maxBytes) return;
      const room = maxBytes - totalBytes;
      const slice = buf.length > room ? trimIncompleteUtf8Tail(buf.subarray(0, room)) : buf;
      chunks.push(slice);
      totalBytes += slice.length;
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr = (stderr + buf.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      settle(() => {
        const stdout = Buffer.concat(chunks).toString("utf8");
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`agent command exited with code ${code}: ${stderr}`));
        }
      });
    });
  });
}

// --- stream-json / JSONL 解析（claude & codex 思考流数据源）----------------
// 各 agent 都以「每行一个 JSON 事件」输出，思考流与正文分道。解析器是
// 纯函数：一行进，{reasoning?, text?, result?} 出。非 JSON 行（codex 的
// WARNING: / rmcp ERROR 行）返回 null 丢弃。
//
// claude stream-json（--output-format stream-json --verbose）：
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}}
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"全文"}]}}
//   {"type":"result","result":"全文"}
//
// codex exec --json（0.144 实测）：
//   {"type":"item.completed","item":{"type":"reasoning","text":"…"}}
//   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
//   {"type":"item.started","item":{"type":"agent_message"}}
//   {"type":"turn.completed","usage":{…}}
//
// opencode run --format json --thinking（1.19 实测）：
//   {"type":"step_start","part":{"type":"step-start"}}
//   {"type":"reasoning","part":{"id":"prt_…","type":"reasoning","text":"…"}}
//   {"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"call_…","state":{…}}}
//   {"type":"text","part":{"id":"prt_…","type":"text","text":"…"}}
//   {"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}
// 与 claude/codex 的关键差异：它上报的是**整段 part 的全文**（同一 part 可能被
// 反复上报），不是增量。所以解析结果带 replace/partId，由调用方按 part 去重后
// 只发新增后缀，否则正文会成倍重复。
// qwen（Qwen Code 0.25.3，本机 + quukk 网关 glm-5.2 实测 2026-11-04）：
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}}
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
//   {"type":"assistant","message":{"content":[{"type":"thinking",…},{"type":"text",…}]}}
//   {"type":"result","result":"全文"}
// 事件形状与 claude 完全同构（gemini-cli 分支移植了同一套 content_block 协议），
// 由上面的 claude 分支直接消化。噪声事件（system/goal_state/message_stop 等）
// 返回 null 丢弃，与 codex 的 WARNING 行同一待遇。
//
// cursor-agent（官方 stream-json，仓内真实抓包
// testdata/cursor-agent-2026.07.20-stream-json.jsonl:3-7,13-21，字段零猜测）：
//   {"type":"thinking","subtype":"delta","text":"…"}      ← 思考流（顶层事件）
//   {"type":"thinking","subtype":"completed"}             ← 块收尾（无正文）
//   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
//   {"type":"result","result":"全文"}
// 思考是**顶层**事件（不是 claude 的 content_block_delta 内嵌），subtype
// 只有 delta 带 text；completed 与未知 subtype 一律丢弃（上游 cursor.go:186-203
// 的 MUL-5231 教训同款：未知 subtype 静默吞掉是事故模式）。assistant 事件与
// claude 分支同形，直接复用。
//
// codebuddy（Claude Code fork，上游 codebuddy.go:38-44 argv、:414-417 思考块）：
// 与 claude 完全同形的 stream_event / assistant / result 事件，claude 分支直接
// 消化，无需专属映射。
//
// pi / omp（pi 协议家族，上游 pi.go:545-559、piStreamEvent pi.go:826-854）：
//   {"type":"agent_start"}                                ← 噪声，丢弃
//   {"type":"turn_start"}                                 ← 噪声，丢弃
//   {"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"…"}}
//   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…"}}
//   {"type":"tool_execution_start","toolCallId":…,"toolName":…}   ← activity
//   {"type":"tool_execution_end",…}                       ← activity
//   {"type":"turn_end","message":{…}}                     ← 噪声（usage 在上游消费）
// thinking_delta / text_delta 的增量在 delta 字段（claude 是 thinking/text 字段）。
//
// kimi（官方文档 moonshotai.github.io/kimi-code：stream-json 模式「thinking
// 内容不会写入 JSONL」）：只有正文事件。stream-json 的正文事件形状与 claude
// 同构（Kimi Code 是 Claude Code 协议族的实现），text_delta 走 claude 分支；
// result 权威全文同款。思考通道在 kimi 上预期为空——如实降级，不虚构。
//
// traecli（`exec <prompt> --json` 一次性 JSONL；⚠️ thought 字段待装机实测）：
// 事件自述形状参考上游 ACP 测试桩（traecli_test.go:55，真实 v0.120.42 抓包格式
// 的 `agent_thought_chunk`）；exec JSONL 按宽松匹配：thinking / thought /
// reasoning 任一增增量字段都当思考。置信度中。
//
// qodercli / qoderclicn（`-p --output-format stream-json`；⚠️ thought 字段待
// 装机实测，官方自述可 observe reasoning）：system/init → assistant → result
// 的 claude 同形骨架走 claude 分支；宽松匹配兜思考。置信度中。
//
// dsh（版本化 stdio JSONL，DshProtocolVersion=1，上游 dsh.go:77-104 帧结构、
// :394-396 thinking 帧）：
//   {"v":1,"type":"ready","runtime":"dsh"}                ← 噪声，丢弃
//   {"v":1,"type":"session","session_id":…}               ← 噪声，丢弃
//   {"v":1,"type":"thinking","content":"…"}               ← 思考流（原生帧）
//   {"v":1,"type":"text","content":"…"}                   ← 正文流（增量）
//   {"v":1,"type":"tool_call","call_id":…,"name":…}       ← activity
//   {"v":1,"type":"tool_result","call_id":…,"output":…}   ← activity
//   {"v":1,"type":"result","output":"全文","status":…}    ← 权威全文在 output
//
// agy（Antigravity 1.1.8+ stream-json；⚠️ thought 字段需实测，宽松匹配）：
//   {"event":"init","conversation_id":…,"init":{"model":…}}        ← 噪声
//   {"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"…"}}
//   {"event":"step_update","step_update":{…,"thought_delta"/"thinking_delta"/"reasoning_delta":"…"}}
//   {"event":"result","result":{"response":"全文","status":"SUCCESS"}}
// 正文在 step_update.text_delta（上游 antigravity.go:393-396 同款消费），
// 末尾 result.response 是权威全文（antigravity.go:412）。思考字段名未实测，
// thinking_delta / thought_delta / reasoning_delta 任一命中都当思考（置信度中）。
export interface StreamJsonDelta {
  reasoning?: string;
  text?: string;
  /** 整段全文语义下，这条内容属于哪个 part（opencode 用；其余 agent 不带）。 */
  partId?: string;
  /** true = 本次给出的是该 part 的完整文本，调用方需自行换算增量。 */
  replace?: boolean;
}

/**
 * 判断一行 stream-json 是否为「整轮正文快照」而非增量：claude 形 result /
 * assistant 汇总消息 / dsh 的 result 帧。消费端（runAgentTurn）据此与已流出
 * 的 delta 正文做前缀换算——claude/qwen/codebuddy 的 delta 流已逐字上屏，
 * 快照再整段发会让过程气泡正文翻倍；cursor-agent / traecli 没有 text delta，
 * 快照就是正文上屏的来源，换算逻辑对它们天然放行（streamedText 对不上时
 * 整段发）。
 */
export function isTextSnapshotLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const event = parsed as Record<string, unknown>;
  if (event.v === DSH_PROTOCOL_VERSION) return event.type === "result";
  if (event.type === "result" && typeof event.result === "string") return true;
  if (event.type === "assistant") {
    const content = (event.message as Record<string, unknown> | undefined)?.content;
    return Array.isArray(content);
  }
  return false;
}

/**
 * 从一行 stream-json 里取出 agent 的**原生会话 id**（会话续接用，见
 * agent-sessions.ts）。
 *
 * 各家字段名不同，但都稳定：
 *   · claude / qwen / codebuddy / hermes：`{"type":"system","subtype":"init",
 *     "session_id":"…"}`；末尾 result 事件带同一个值；
 *   · opencode：`sessionID`（`--format json` 的 step / part 事件）；
 *   · codex：`{"type":"thread.started","thread_id":"…"}`（本轮不启用续接，
 *     但 id 照收，打开时不用再改解析）。
 *
 * 取不到或形状不合法一律返回 null：会话续接是增强，绝不能因为它影响正文解析。
 */
export function extractSessionId(line: string): string | null {
  if (!line.includes("session") && !line.includes("thread")) return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  for (const key of ["session_id", "sessionID", "thread_id", "threadId"]) {
    const value = event[key];
    if (isSessionId(value)) return value;
  }
  return null;
}

export function parseStreamJsonLine(line: string): StreamJsonDelta | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;

  // --- claude（含 codebuddy / qwen 的同构事件）---
  if (event.type === "stream_event") {
    const inner = event.event as Record<string, unknown> | undefined;
    const delta = inner?.delta as Record<string, unknown> | undefined;
    if (!delta) return null;
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return { reasoning: delta.thinking };
    }
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return { text: delta.text };
    }
    return null;
  }

  // --- cursor-agent：顶层 thinking 事件（subtype=delta 才带 text）---
  // 真实抓包 testdata/cursor-agent-2026.07.20-stream-json.jsonl:3-7,13-21：
  // {"type":"thinking","subtype":"delta","text":"…"} / {"type":"thinking",
  // "subtype":"completed"}（无 text）。completed 与未知 subtype 一律丢弃
  // ——上游 cursor.go:194-203（MUL-5231）的结论：未知 subtype 静默折叠进
  // 思考正是那场事故的根源。
  if (event.type === "thinking" && event.subtype === "delta") {
    return typeof event.text === "string" ? { reasoning: event.text } : null;
  }

  // --- kimi：role 判型（kimi stream-json 的事件不带 type 字段）---
  // 实测（2026-11-10，kimi 2.5.2 -p --output-format stream-json）：
  //   {"role":"meta","type":"system.version",…}            ← 噪声，丢弃
  //   {"role":"assistant","content":"OK"}                  ← 正文（权威全文）
  //   {"role":"meta","type":"session.resume_hint",…}       ← 噪声，丢弃
  // content 实测为字符串；兼容块数组（同 claude 形）以防版本差异。
  // kimi 没有独立的 result 帧 —— assistant 消息即本轮回答。工具轮次可能出多
  // 条 assistant 消息，此处按增量拼接（与 claude delta 同语义）。
  if (event.role === "assistant") {
    if (typeof event.content === "string" && event.content) {
      return { text: event.content };
    }
    if (Array.isArray(event.content)) {
      const parts = event.content
        .filter((block): block is Record<string, unknown> =>
          typeof block === "object" && block !== null
          && (block as Record<string, unknown>).type === "text")
        .map((block) => (block as { text?: unknown }).text)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      if (parts.length > 0) return { text: parts.join("") };
    }
    return null;
  }

  // --- claude 同形的 result / assistant 快照（cursor-agent / traecli / qoder）---
  // result 是**权威全文**（整轮正文）。cursor-agent / traecli 家族没有 text
  // delta 流，这是正文上屏的来源之一；claude/qwen/codebuddy 的 delta 已逐字
  // 上屏，重复由消费端的快照换算吸收（isTextSnapshotLine 判定，见消费端）。
  if (event.type === "result" && typeof event.result === "string" && event.result) {
    return { text: event.result };
  }
  if (event.type === "assistant") {
    // traecli 形状：正文/思考在 assistant 事件的顶层字段（无 message.content）。
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((block): block is Record<string, unknown> =>
          typeof block === "object" && block !== null
          && (block as Record<string, unknown>).type === "text")
        .map((block) => (block as { text?: unknown }).text);
      if (textParts.length > 0 && textParts.every((t) => typeof t === "string")) {
        const joined = (textParts as string[]).join("");
        if (joined) return { text: joined };
      }
    } else if (typeof event.text === "string" && event.text) {
      // 顶层 text（traecli exec --json）；thought/thinking/reasoning 不在这里
      // ——落到下方宽松思考匹配。
      return { text: event.text };
    }
    // 无快照正文可取的 assistant 事件（含 qwen 的 thinking 块汇总）继续下落。
  }

  // --- codex ---
  if (event.type === "item.completed") {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return null;
    if (item.type === "reasoning" && typeof item.text === "string") {
      return { reasoning: item.text };
    }
    if (item.type === "agent_message" && typeof item.text === "string") {
      return { text: item.text };
    }
    return null;
  }

  // --- pi / omp：message_update.assistantMessageEvent ---
  // 上游 pi.go:545-559：thinking_delta / text_delta 的增量都在 delta 字段。
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!inner) return null;
    if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
      return { reasoning: inner.delta };
    }
    if (inner.type === "text_delta" && typeof inner.delta === "string") {
      return { text: inner.delta };
    }
    return null;
  }

  // --- dsh：版本化 stdio JSONL（DshProtocolVersion=1）---
  // 上游 dsh.go:77-104 的帧结构；thinking/text 帧的正文在 content 字段，
  // result 帧的权威全文在 output 字段。version 不等于 1 的帧整行丢弃
  // （dsh.go:377-379 同款：协议版本不符直接报错，这里静默丢弃等价降级）。
  if (event.v === DSH_PROTOCOL_VERSION) {
    if (event.type === "thinking" && typeof event.content === "string") {
      return { reasoning: event.content };
    }
    if (event.type === "text" && typeof event.content === "string") {
      return { text: event.content };
    }
    if (event.type === "result" && typeof event.output === "string" && event.output) {
      return { text: event.output };
    }
    return null;
  }

  // --- agy：event 字段判型（不是 type）---
  // 上游 antigravity.go:364-416：init / step_update / result 三种事件，
  // 正文在 step_update.text_delta（step_type=agent_response 才是回答），
  // 权威全文在 result.result.response。思考字段未实测，宽松匹配
  // thinking_delta / thought_delta / reasoning_delta（置信度中）。
  if (event.event === "step_update") {
    const step = event.step_update as Record<string, unknown> | undefined;
    if (!step) return null;
    // 思考字段（thinking/thought/reasoning 任一 delta）优先判定：思考 step 的
    // step_type 形状未实测（候选有 "thinking" 等），不能拿 agent_response 闸门
    // 把它挡掉——正文通道才需要 step_type 收口。
    const thought = dshLooseThoughtDelta(step);
    if (thought !== undefined) return { reasoning: thought };
    // 非 agent_response 的 step（工具执行等）不进正文通道（工具走 activity）。
    if (step.step_type !== "agent_response") return null;
    if (typeof step.text_delta === "string" && step.text_delta) {
      return { text: step.text_delta };
    }
    return null;
  }
  if (event.event === "result") {
    // 正文提取由 extractStreamJsonFinalText 的 agy 分支拿 result.response，
    // 这里不产出增量（终态事件；过程流的正文已由 step_update 增量上屏）。
    return null;
  }

  // --- 宽松思考匹配（traecli exec --json / qodercli stream-json）---
  // ⚠️ 两家的 thought 字段名都待装机实测（报告三点存疑之二），这里按
  // 「thinking / thought / reasoning 任一增量字段」宽松匹配，命中即思考。
  // 证据优先级：官方文档描述 > 上游源码 > 合理推断；字段确认后收窄。
  // 这条分支放在**最后**：claude/codex/opencode/pi/cursor 等已被上面精确
  // 分支消化的事件绝不会误入。
  const loose = parseLooseThoughtLine(event);
  if (loose) return loose;

  // --- hermes ---
  // 形状：{"type":"text","text":"…"}（增量，无 part）/ {"type":"tool_use",…} /
  // {"type":"reasoning","text":"…"}（增量，0.21.3 起补齐：TTY 的 [thinking] 框
  // 走同一个 reasoning_callback，之前静默模式把它置空所以思考整段丢失）。
  // opencode 的事件一定带 part，所以「有 text 没 part」只可能是 hermes。
  if (event.type === "text" && event.part === undefined && typeof event.text === "string") {
    return { text: event.text };
  }
  if (event.type === "reasoning" && event.part === undefined
    && typeof event.text === "string" && event.text) {
    return { reasoning: event.text };
  }

  // --- opencode ---
  if (event.type === "reasoning" || event.type === "text") {
    const part = event.part as Record<string, unknown> | undefined;
    if (!part || typeof part.text !== "string" || !part.text) return null;
    // 只认与事件同名的 part 类型：`reasoning` 事件里偶尔会混进别的 part。
    const partType = typeof part.type === "string" ? part.type : "";
    const id = typeof part.id === "string" ? part.id : undefined;
    if (event.type === "reasoning") {
      if (partType && partType !== "reasoning") return null;
      return { reasoning: part.text, partId: id, replace: true };
    }
    if (partType && partType !== "text") return null;
    return { text: part.text, partId: id, replace: true };
  }
  return null;
}

// dsh 协议版本（上游 server/pkg/agent/dsh.go 的 DshProtocolVersion=1）。
// 解析器只消化 v=1 的帧，版本不符整行丢弃。
const DSH_PROTOCOL_VERSION = 1;

// traecli / qodercli / agy 共用的宽松思考匹配：事件对象上任一已知思考字段
// （thinking / thought / reasoning 及其 _delta 后缀变体）带非空字符串即视为
// 思考增量。只认「值是字符串」的字段——对象形状（part 包装等）走各家的精确
// 分支，这里绝不猜。
function parseLooseThoughtLine(event: Record<string, unknown>): StreamJsonDelta | null {
  const candidates = [event.delta, event.text, event.content];
  for (const field of ["thinking", "thought", "reasoning"]) {
    const value = event[field];
    if (typeof value === "string" && value) return { reasoning: value };
    // 嵌套对象形态：{thinking:{delta:"…"}} / {thought:{text:"…"}}——字段名
    // 待实测，两种最常见的内嵌键都探测。
    if (typeof value === "object" && value !== null) {
      const nested = value as Record<string, unknown>;
      for (const inner of candidates) {
        if (typeof inner === "string" && inner) return { reasoning: inner };
      }
      const nestedDelta = nested.delta ?? nested.text ?? nested.content;
      if (typeof nestedDelta === "string" && nestedDelta) return { reasoning: nestedDelta };
    }
  }
  return null;
}

// agy step_update 里的宽松思考匹配：thinking_delta / thought_delta /
// reasoning_delta 任一非空字符串都当思考增量。
function dshLooseThoughtDelta(step: Record<string, unknown>): string | undefined {
  for (const field of ["thinking_delta", "thought_delta", "reasoning_delta"]) {
    const value = step[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

// 从 stream-json 全量 stdout 提取最终正文（claude 优先 result.result / 最长
// assistant 文本；codex 聚合 agent_message；opencode 按 part 顺序拼 text part）。
// 空时返回 undefined 走兜底。
export function extractStreamJsonFinalText(raw: string): string | undefined {
  const texts: string[] = [];
  let claudeResult: string | undefined;
  // hermes：{"type":"text","text":…} 是**增量**（没有 part），逐条追加即可；
  // 末尾的 {"type":"result","text":…} 是同一次回答的权威全文，优先用它。
  const hermesDeltas: string[] = [];
  let hermesResult: string | undefined;
  // opencode 的正文按 part 分片上报，同一 part 可能重复出现 → 以 id 去重、保序。
  const opencodeTexts = new Map<string, string>();
  // dsh 的 text 帧是增量（content 字段），result 帧的权威全文在 output 字段。
  const dshDeltas: string[] = [];
  let dshResult: string | undefined;
  // agy 的 step_update.text_delta 是增量，result.result.response 是权威全文。
  const agyDeltas: string[] = [];
  let agyResult: string | undefined;
  // pi/omp 的 message_update.assistantMessageEvent.delta 是增量（无 result 帧，
  // 终值就是增量拼接）。
  const piDeltas: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type === "text") {
      const part = event.part as Record<string, unknown> | undefined;
      if (part && typeof part.text === "string" && part.text
        && (typeof part.type !== "string" || part.type === "text")) {
        const id = typeof part.id === "string" ? part.id : `anon-${opencodeTexts.size}`;
        opencodeTexts.set(id, part.text);
      } else if (typeof event.text === "string" && event.text) {
        hermesDeltas.push(event.text);
      }
    }
    if (event.type === "result" && typeof event.result === "string") {
      claudeResult = event.result;
    }
    // hermes 的 result 事件用 text 字段（claude 用 result），且总在最后一条。
    if (event.type === "result" && typeof event.text === "string") {
      hermesResult = event.text;
    }
    // dsh：v=1 的帧才有意义；text 帧增量、result 帧权威全文在 output。
    if (event.v === DSH_PROTOCOL_VERSION) {
      if (event.type === "text" && typeof event.content === "string" && event.content) {
        dshDeltas.push(event.content);
      }
      if (event.type === "result" && typeof event.output === "string") {
        dshResult = event.output;
      }
    }
    // agy：event 字段判型；step_update 的正文增量（只认 agent_response step），
    // result 的权威全文在 result.response。
    if (event.event === "step_update") {
      const step = event.step_update as Record<string, unknown> | undefined;
      if (step && step.step_type === "agent_response"
        && typeof step.text_delta === "string" && step.text_delta) {
        agyDeltas.push(step.text_delta);
      }
    }
    // pi/omp：message_update 的正文增量（thinking_delta 不是正文）。
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (inner?.type === "text_delta" && typeof inner.delta === "string" && inner.delta) {
        piDeltas.push(inner.delta);
      }
    }
    if (event.event === "result") {
      const result = event.result as Record<string, unknown> | undefined;
      if (result && typeof result.response === "string") {
        agyResult = result.response;
      }
    }
    if (event.type === "assistant" || event.role === "assistant") {
      // kimi 的 assistant 事件是顶层 {role,content}（content 为字符串或块数组），
      // claude 系是 {type,message.content}。两种形状都归到 texts。
      const direct = typeof event.content === "string" && event.content ? event.content : undefined;
      const message = (event.message ?? undefined) as Record<string, unknown> | undefined;
      const content = direct !== undefined ? direct : message?.content;
      if (typeof content === "string") {
        if (content) texts.push(content);
        continue;
      }
      if (Array.isArray(content)) {
        const parts = content
          .map((block) => (typeof block === "object" && block !== null
            ? (block as Record<string, unknown>) : undefined))
          .filter((block): block is Record<string, unknown> =>
            block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string);
        if (parts.length > 0) texts.push(parts.join(""));
      }
    }
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
  }
  if (claudeResult !== undefined && claudeResult.length > 0) return claudeResult;
  if (hermesResult !== undefined && hermesResult.trim().length > 0) return hermesResult;
  if (hermesDeltas.length > 0) {
    const hm = hermesDeltas.join("");
    if (hm.trim().length > 0) return hm;
  }
  if (opencodeTexts.size > 0) {
    const oc = [...opencodeTexts.values()].join("").trim();
    if (oc.length > 0) return oc;
  }
  if (dshResult !== undefined && dshResult.trim().length > 0) return dshResult;
  if (dshDeltas.length > 0) {
    const dh = dshDeltas.join("");
    if (dh.trim().length > 0) return dh;
  }
  if (agyResult !== undefined && agyResult.trim().length > 0) return agyResult;
  if (agyDeltas.length > 0) {
    const ay = agyDeltas.join("");
    if (ay.trim().length > 0) return ay;
  }
  // pi/omp：无 result 帧，增量拼接即终值。
  if (piDeltas.length > 0) {
    const pi = piDeltas.join("");
    if (pi.trim().length > 0) return pi;
  }
  const joined = texts.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

// --- opencode 服务端模式（真流式）----------------------------------------
//
// `opencode run --format json` 只在 part 完成时上报**整段全文**：实测一轮 800
// 字长文只有 4 行事件（step_start / reasoning / text / step_finish），正文与思考
// 各出现一次。设备端因此只能发 1 帧正文，客户端看到的就是「憋两分钟 → 全文
// 一次性蹦出」。
//
// `opencode serve` 的 SSE 才是真增量：`message.part.delta` 一条一个 token 片段
// （同一 prompt 实测 12,620 条、平均 1.7 字/片、持续 101 秒）。所以 opencode 默认
// 走 serve，run 退化为「旧版本兜底」。
//
// opencode 2.x 换了协议但同样是真增量：serve 会多打一行 `server password`，
// 会话 API 挪到 `/api/*` 并要 Basic 鉴权，增量事件变成 `session.text.delta` /
// `session.reasoning.delta`（见 opencode-v2.ts）。判据就是那行密码 —— 有它就走
// 2.x，没有就是 1.x。
//
//   CLAWMESSENGER_OPENCODE_SERVER=0        关掉，回到 run --format json
//   CLAWMESSENGER_OPENCODE_FULL_CONFIG=1   不派生精简配置（保留 plugin / MCP）
const SERVE_STARTUP_TIMEOUT_MS = 25_000;
// 拿到 listening 行之后再等密码行的窗口。2.x 这两行是先后打出来的（实测相隔
// 几毫秒），但**别按实测值去压这个窗口**：Windows 冷启动、首次加载配置、杀软
// 扫描 stdout 时，密码行晚到 300ms 是常态。窗口一旦错过，`password` 就为空 →
// 走 1.x 协议 → `POST /session` 405 → 整轮退化成 `run --format json` 的「整段
// 落地」（实测一轮 12,620 事件、101 秒才一次蹦出），而且是**静默**退化：功能还
// 能用，用户只会觉得「1.3.5 变慢了」。1200ms 是这轮取舍的结果 —— 1.x 每轮白等
// 这点时间，换 2.x 稳定命中真流式。
const SERVE_PASSWORD_GRACE_MS = 1200;

export function opencodeServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLAWMESSENGER_OPENCODE_SERVER ?? "").trim();
  if (!raw) return true;
  return !/^(0|false|no|off)$/i.test(raw);
}

function envFlag(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? "").trim());
}

/** 设备端派生的 opencode 配置落盘位置（per-agent：里面的 instructions 指向本 agent 的行为规范）。 */
export function deviceOpencodeConfigPath(
  agentName: string | undefined,
  home: string = homedir(),
): string {
  const base = join(home, ".clawmessenger");
  // 没有 agent 名（老调用方 / 手工探测）时退回整机一份的老路径，行为与升级前一致。
  if (!agentName) return join(base, "opencode-device.json");
  return join(base, `opencode-device-${sanitizeAgentId(agentName)}.json`);
}

interface DeviceConfigInput {
  agentName?: string;
  /**
   * 该轮要注入的行为规范（仅私聊轮次非空）。
   *
   * - 非空串：写文件并让 `instructions` 指向它；
   * - 空串：**显式清掉**（删文件 + 不写 instructions），用于群聊/讨论组轮
   *   （服务端已拼 role_prompt，设备端不能重复注入）；
   * - `undefined`：**不要动**既有文件，存在就继续用。轮询侧的
   *   `syncAgentPermissionConfig` 走这条 —— 它只重算限制键，不能用空串把
   *   用户既有的行为规范删掉（审查 G10）。
   */
  behaviorPrompt?: string;
  /** 整机是否处于「文件读写禁止」限制态。 */
  fsRestricted?: boolean;
  home?: string;
}

/**
 * serve 进程的环境：**派生一份设备端专用 opencode 配置**，去掉 plugin 与 mcp，
 * 并按权限快照写入工具限制与行为规范指令。
 *
 * 为什么（2026-10-26 实测）：用户配置里的 `superpowers@git+https://…` 插件与两个
 * `uvx --from git+https://…` 的 MCP 会让 opencode 在 `message=init` 上卡七十秒
 * 以上、零输出；设备端每轮都要重新付这笔开销，表现就是「先想很久」。provider /
 * model / instructions / permission 全部保留，模型与人格不变。
 *
 * 用户显式指定过 OPENCODE_CONFIG（或 CLAWMESSENGER_OPENCODE_CONFIG）时不动 ——
 * 那说明他自己管这份配置。
 */
function opencodeServeEnv(input: DeviceConfigInput = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!envFlag(env.CLAWMESSENGER_OPENCODE_FULL_CONFIG)
    && !env.OPENCODE_CONFIG
    && !env.CLAWMESSENGER_OPENCODE_CONFIG) {
    const config = ensureDeviceOpencodeConfig(env, input);
    if (config) env.OPENCODE_CONFIG = config;
  }
  // serve 只绑 127.0.0.1、端口随机；带着密码只会让本地请求全部 401。
  delete env.OPENCODE_SERVER_PASSWORD;
  return env;
}

function ensureDeviceOpencodeConfig(
  env: NodeJS.ProcessEnv,
  input: DeviceConfigInput = {},
): string | null {
  let source: string | null = null;
  try {
    source = discoverOpencodeConfigPath({ env });
  } catch {
    return null;
  }
  if (!source) return null;
  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    return null;
  }
  const home = input.home ?? homedir();
  // 行为规范先落盘，再让配置指向它：顺序反了会出现「配置指向一个还不存在的文件」。
  //
  // undefined = 不要动既有文件（轮询侧重算限制时走这条）；空串 = 显式清掉。
  // 二者的区别见 DeviceConfigInput.behaviorPrompt 的注释（审查 G10）。
  const behaviorPath = opencodeBehaviorPath(input.agentName, home);
  const behaviorFile = input.behaviorPrompt === undefined
    ? (existsSync(behaviorPath) ? behaviorPath : null)
    : writeOpencodeBehaviorFile(input.agentName, input.behaviorPrompt, home);
  const built = buildDeviceOpencodeConfig(raw, {
    fsRestricted: input.fsRestricted === true,
    instructions: behaviorFile ? [behaviorFile] : [],
  });
  if (!built) return null;
  const target = deviceOpencodeConfigPath(input.agentName, home);
  try {
    const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
    // 内容没变就不重写：既省 IO，也避免每轮都触发 opencode 重新加载配置。
    if (existing === built.text) return target;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, built.text, "utf8");
  } catch {
    return null;
  }
  return target;
}

/**
 * 权限快照变化时重算并落盘派生配置（supervisor 在轮询里调）。
 *
 * 为什么要有这个显式入口：配置原本只在 `runOpenCodeServerTurn` 前算 —— 那意味着
 * 「用户在界面关掉读写」要等到该 agent 下一轮真的开口才落盘，中间这段时间磁盘上
 * 的配置仍是旧的可读写版本。轮询侧主动重算把生效点提前到「下一次轮询」。
 *
 * 只处理 opencode：其它 agent 的限制靠 spawn 时的 argv/env 表达，没有落盘的派生配置。
 *
 * @returns 写入的配置路径；不需要/失败返回 null。
 */
export function syncAgentPermissionConfig(
  agentName: string | undefined,
  snapshot: PermissionSnapshot | null,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): string | null {
  if (agentName !== "opencode") return null;
  // 运维 agent 不被 allowFs 限制（默认新建绑定就是 false，否则运维一上线就废）。
  // 它的派生配置要保持「无限制键」。
  if (fsGateExempt(agentName)) return null;
  const env = opts.env ?? process.env;
  if (envFlag(env.CLAWMESSENGER_OPENCODE_FULL_CONFIG)
    || env.OPENCODE_CONFIG
    || env.CLAWMESSENGER_OPENCODE_CONFIG) {
    return null;
  }
  const restriction = fsRestriction(snapshot);
  // 行为规范是**私聊轮次**才注入的，重算时不知道下一轮是什么会话形态，所以这里
  // 只重算限制键：**不传 behaviorPrompt**（undefined = 不要动既有指令文件，见
  // DeviceConfigInput 的说明）。传空串会把用户的行为规范文件删掉（审查 G10）。
  return ensureDeviceOpencodeConfig(env, {
    agentName,
    fsRestricted: restriction.restricted,
    ...(opts.home ? { home: opts.home } : {}),
  });
}

/** 起 `opencode serve` 并等它把监听地址打到 stdout，然后跑完一轮。 */
async function runOpenCodeServerTurn(
  opts: RunAgentTurnOpts,
  timeoutMs: number,
  hardLimit: number,
): Promise<string> {
  const { file, args } = buildSpawnInvocation(opts.execPath, [
    "serve",
    // 端口 0 = 让内核挑空闲端口，多台设备/多个 agent 不会撞。
    "--port", "0",
    "--hostname", "127.0.0.1",
  ]);
  const child = spawn(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    cwd: opts.cwd,
    env: opencodeServeEnv({
      // 用**权限身份**命名派生配置：ops 的执行器是 opencode，但它的配置必须
      // 独立一份（opencode-device-ops.json），否则会和对话 agent 共用
      // opencode-device-opencode.json —— 那份可能是 permission.bash=deny 的
      // 受限版本，运维轮次会因此连 bash 工具都拿不到。
      ...((opts.agentIdentity ?? opts.agentName)
        ? { agentName: opts.agentIdentity ?? opts.agentName }
        : {}),
      // 一律传（可能为空串）：serve 每轮都会重写派生配置，空串表示「这一轮不该
      // 有行为规范」（群聊/讨论组），要显式摘掉上一轮私聊写进去的指令文件；
      // 传 undefined 会被理解成「不要动」，那份指令就会在群聊里重复生效。
      // 运维轮次的行为规范在 ops workdir 的 AGENTS.md 里，这里不掺和。
      ...((opts.agentIdentity ?? opts.agentName) === "ops" ? {} : { behaviorPrompt: opts.behaviorPrompt ?? "" }),
      ...(opts.fsRestricted ? { fsRestricted: true } : {}),
    }),
  });

  let stderr = "";
  child.stderr.on("data", (buf: Buffer) => {
    stderr = (stderr + buf.toString("utf8")).slice(-2000);
  });

  const serve = await new Promise<{ baseUrl: string; password?: string }>((resolve, reject) => {
    let tail = "";
    let done = false;
    // 2.x 的启动输出是「listening 行在前、password 行在后」，只等着 URL 会漏掉
    // 密码，因此拿到 URL 后再给它一个很短的窗口把密码行收进来；窗口过了就当
    // 1.x 处理（1.x 永远不打这行）。
    let passwordTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(startTimer);
      if (passwordTimer) clearTimeout(passwordTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error("agent turn aborted")));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const startTimer = setTimeout(() => {
      finish(() => reject(new Error(
        `opencode serve did not report its listening URL within ${SERVE_STARTUP_TIMEOUT_MS}ms: ${stderr.slice(-400)}`,
      )));
    }, SERVE_STARTUP_TIMEOUT_MS);
    child.stdout.on("data", (buf: Buffer) => {
      tail += buf.toString("utf8");
      const url = parseServeListeningUrl(tail);
      const password = parseServePassword(tail);
      if (url && password) {
        finish(() => resolve({ baseUrl: url, password }));
        return;
      }
      if (url && !passwordTimer) {
        passwordTimer = setTimeout(() => {
          finish(() => resolve({ baseUrl: url }));
        }, SERVE_PASSWORD_GRACE_MS);
      }
      // 启动期会打若干行日志；只留尾部，别让长跑把内存吃满。
      if (tail.length > 4000) tail = tail.slice(-2000);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) => {
      finish(() => reject(new Error(`opencode serve exited with code ${code}: ${stderr.slice(-400)}`)));
    });
  });

  try {
    const result = await runServerSession({
      baseUrl: serve.baseUrl,
      password: serve.password,
      prompt: opts.prompt,
      model: opts.model,
      timeoutMs,
      signal: opts.signal,
      onText: opts.onChunk,
      onReasoning: opts.onReasoningChunk,
      onActivity: opts.onActivity,
      // 字符上限按字节上限的一半估：中文 UTF-8 三字节，留余量不误杀长回答。
      maxTextChars: Math.max(1, Math.floor(hardLimit / 2)),
    });
    if (!result.sawDelta) {
      // serve 起来了但没有增量事件：多半是旧版 opencode。内容不丢，只是不流。
      // 正文事件的两种形态都要点到：1.x 的 serve 发 `message.part.delta`，
      // 2.x 的 /api/* 发 `session.text.delta` —— 只写前者会把排查方向带偏。
      console.warn(
        `opencode serve 未上报增量正文事件（message.part.delta / session.text.delta，正文 ${result.text.length} 字）——`
        + " 该版本可能不支持增量事件，本轮按整段返回。",
      );
    }
    if (result.endedOnFailedTool && result.failedStep) {
      const step = result.failedStep;
      const failedCmd = (step.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const failedOut = (step.outputDetail ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      throw new TurnIncompleteError(
        "agent_incomplete",
        result.text,
        `turn ended on a failed ${step.label} with no follow-up text`
          + (failedCmd ? ` [cmd: ${failedCmd}]` : "")
          + (failedOut ? ` [output: ${failedOut}]` : ""),
        { label: step.label, command: failedCmd || undefined, output: failedOut || undefined },
      );
    }
    return result.text;
  } finally {
    // serve 是本轮专用进程，收尾必须整棵杀掉：留着就是下一个孤儿端口。
    killProcessTree(child);
  }
}

// 「文件读写限制态」的日志只在该状态**变化**时打一行：限制是整机级的，每轮都
// 打会把 agent 日志淹掉；但状态翻转（管理员刚关掉/打开读写）必须留痕，否则现场
// 只能看到「工具突然不能用了」。
//
// 日志里必须带「谁触发 + 谁参与了判定」：运维 agent 是豁免的，运维看日志时要能
// 一眼判断「不是限我」还是「限的是对话 agent，但我在豁免名单里」。
let lastFsRestrictionLog = "";
function logFsRestrictionOnce(
  restricted: boolean,
  restriction: { because: readonly string[]; participating: readonly string[]; exempt: boolean },
): void {
  const key = restricted
    ? `on:${restriction.because.join(",")}|${restriction.participating.join(",")}`
    : `off:${restriction.exempt ? "exempt" : "clear"}`;
  if (key === lastFsRestrictionLog) return;
  lastFsRestrictionLog = key;
  if (restriction.exempt) {
    console.log(
      "agent fs gate: 运维 agent 豁免（不受 allowFs 限制，也不参与「有一个人关就都不给」的判定；"
      + `参与判定的 agent=[${restriction.participating.join(", ") || "无"}]）。`
      + " 残留：同机「受限对话 agent + 运维」并存时运维修复能力不降级，见报告 known issues。",
    );
    return;
  }
  if (!restricted) return;
  console.warn(
    `agent fs restricted: allowFs=false on [${restriction.because.join(", ") || "?"}] — `
    + `参与判定的 agent=[${restriction.participating.join(", ") || "无"}]（运维 agent 已豁免）；`
    + "同一台设备的派生配置是整机一份，按「有一个人关就都不给」处理。"
    + "bash 已一并禁用，但本轮没有 OS 级沙箱，见 implementer-report-cli.md 的残留风险。",
  );
}

export function runAgentTurn(opts: RunAgentTurnOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hardLimit = opts.hardOutputBytes ?? HARD_OUTPUT_BYTES;
  // stream-json 的 JSONL 冗余大（事件元数据 + 思考流），64KB 会截断长回答。
  const streamJsonTurn = opts.onReasoningChunk !== undefined || agentSupportsReasoning(opts.agentName);
  const bufferLimit = opts.maxOutputBytes ?? (streamJsonTurn
    ? STREAM_JSON_MAX_OUTPUT_BYTES
    : emitsJsonEnvelope(opts.agentName) ? ENVELOPE_MAX_OUTPUT_BYTES : DEFAULT_MAX_OUTPUT_BYTES);

  if (opts.signal?.aborted) return Promise.reject(new Error("agent turn aborted"));

  // 权限快照 → 本轮的两条限制：文件读写是否禁止、要不要注入行为规范。
  //
  // 快照读的是 supervisor 轮询落盘的那一份（带 5s 缓存，见 agent-permissions.ts），
  // 不是每条消息现查服务端 —— 私聊轮次很密，不能在这里加网络往返。
  // 只在**快照真的变了**的时候打一行日志，避免每轮刷屏。
  // 权限身份优先于执行器名：ops 用 opencode 执行，但豁免判定只认 "ops"。
  // 不传 identity 时（对话 agent）两者相同，行为不变。
  const permissionIdentity = opts.agentIdentity ?? opts.agentName;
  const restriction = fsRestriction(loadPermissionSnapshot(), permissionIdentity);
  const fsRestricted = opts.fsRestricted ?? restriction.restricted;
  logFsRestrictionOnce(fsRestricted, restriction);

  // codex 会把执行过程写进正文（2026-10-26 现场：「我先核对每段字数…这里没有
  // 安装 Python，我改用 PowerShell 直接按字符计数」就是正文第一段）。这类内容
  // 属于思考。约束落在**指令层**（$CODEX_HOME/AGENTS.md）而不是 prompt：私聊的
  // prompt 就是用户原话，往里塞一句会污染输入，而且 agent 可能复述它。
  // 幂等且失败静默 —— 写不了指令文件不该让这一轮答不出来。
  if (opts.agentName === "codex") {
    ensureCodexOutputStyle();
    // 冷启动提速自愈：禁用 slack / google-calendar 这类「未登录也要重试认证」的
    // 远程插件（实测每轮冷启动白付 40s+，见 agent-instructions.ts 的现场记录）。
    // 幂等、失败静默 —— 不影响本轮。
    ensureCodexFastStart();
    // 行为规范只在私聊轮次存在：群聊/讨论组由服务端拼进 role_prompt，这里传空
    // 表示「摘掉上一轮私聊写进去的那一节」，避免同一段话在群聊里出现两遍。
    ensureCodexBehaviorPrompt(opts.behaviorPrompt ?? "");
  }

  // qwen 轮次尾延迟自愈：补写 memory.enableManagedAutoMemory=false（用户显式
  // 设过则不动）。实测每轮 result 事件因此晚 15~45s —— 见 agent-instructions.ts。
  if (opts.agentName === "qwen") {
    ensureQwenFastStart();
  }

  // opencode：默认走 serve + SSE（真 token 级增量）。只有 argv 策略成立时
  // 才走这条路 —— 超长 prompt 会退回 stdin 模式，那条路沿用 run 的老实现。
  if (opts.agentName === "opencode" && !opts.disableServerMode && opencodeServerEnabled()) {
    const strategyArgs = buildAgentArgs(opts.agentName, opts.prompt, opts.model, opts.sessionKey, {
      fsRestricted,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    });
    if (strategyArgs.length > 0) {
      // ⚠️ fsRestricted 是本轮算出来的**局部**值，必须合并进 opts 再往下传：
      // serve 侧的 opencodeServeEnv 只认 `opts.fsRestricted`，不合并就会恒 false
      // —— 受限配置不会被写进 OPENCODE_CONFIG 指向的文件，而上面的日志已经打了
      // 「fs restricted」（日志与事实相反），且 supervisor 写好的受限配置会被这一轮
      // 用同路径的无限制内容覆盖（审查 B1 阻断项）。
      return runOpenCodeServerTurn({ ...opts, fsRestricted }, timeoutMs, hardLimit).catch((err: unknown) => {
        if (!isServeStartupFailure(err)) throw err;
        // 起不来（旧版 opencode 没有 serve / 端口被占 / 配置坏）就退回 run：
        // 内容仍然拿得到，只是回到「整段落地」。绝不因为流式改造让一轮失败。
        console.warn(
          `opencode serve 不可用，回退到 run --format json：${err instanceof Error ? err.message : String(err)}`,
        );
        return runAgentTurn({ ...opts, disableServerMode: true });
      });
    }
  }

  return new Promise<string>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("agent turn aborted"));
      return;
    }

    // Strategy agents take the prompt as argv; everything else (unknown
    // agent, or a prompt past the argv length cap) keeps the legacy stdin
    // invocation with the model flag as the only argument.
    const strategyArgs = opts.agentName
      ? buildAgentArgs(opts.agentName, opts.prompt, opts.model, opts.sessionKey, {
        fsRestricted,
        ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
      })
      : [];
    const argvMode = strategyArgs.length > 0;
    const agentArgs = argvMode
      ? strategyArgs
      : buildModelArgs(opts.agentName ?? "", opts.model);
    // opencode 的 `run` 路径原本完全不碰派生配置（只有 serve 路径设 OPENCODE_CONFIG）。
    // 权限限制要靠配置表达，所以**只在需要时**补上：没有限制、也没有行为规范时
    // 保持老行为不变（不引入「run 也会剥 plugin/mcp」这种副作用）。
    //
    // ⚠️ 这里判的是**权限身份**不是执行器名：ops 用 opencode 执行、身份是 "ops"，
    // 它该用 ops workdir 里的 opencode.json（只钉 shell）。一旦套上对话用的派生
    // 配置（permission.bash=deny / tools.bash=false），运维轮次就只剩一张嘴，
    // 只能回用户「会话未提供 bash 工具，请在本机运行」——2026-11-04 22:29 现场。
    // 运维轮次**恒用**自己那份派生配置（opencode-device-ops.json）：既剥掉
    // 全局 plugin/MCP（否则每轮启动先付几十秒），又天然不带权限限制键 ——
    // 它的身份不是 "opencode"，不会被对话 agent 的受限配置牵连。
    // 其它 agent 维持原语义：只在「受限或有行为规范」时才派生。
    const wantDeviceConfig = permissionIdentity === "ops"
      || (permissionIdentity === "opencode" && (fsRestricted || opts.behaviorPrompt));
    const deviceConfig = wantDeviceConfig
      ? ensureDeviceOpencodeConfig(process.env, {
        ...(permissionIdentity ? { agentName: permissionIdentity } : {}),
        // 与 serve 路径同口径：空串 = 这一轮不该有行为规范（显式清掉），
        // 不能传 undefined（那会保留上一轮私聊写进去的指令，群聊里就重复了）。
        // 运维的行为规范在 ops workdir 的 AGENTS.md，这里不碰。
        ...(permissionIdentity === "ops" ? {} : { behaviorPrompt: opts.behaviorPrompt ?? "" }),
        ...(fsRestricted ? { fsRestricted: true } : {}),
      })
      : null;
    const spawnEnv = deviceConfig
      ? { ...process.env, OPENCODE_CONFIG: deviceConfig }
      : agentRuntimeEnv(opts.agentName, opts.model);
    const { file, args } = buildSpawnInvocation(opts.execPath, agentArgs);
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: opts.cwd,
      // null = 继承当前进程环境（只有需要改网关的 agent 才返回对象）。
      ...(spawnEnv ? { env: spawnEnv } : {}),
    });

    // stdout accumulates raw bytes; decoding happens through a streaming
    // StringDecoder so code points split across chunk boundaries survive,
    // and truncation caps BYTES and backs off to a code-point boundary.
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let bufferedBytes = 0;
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    /** 原始缓冲已满（只影响 chunks，不影响解析）。 */
    let capped = false;
    /** 超出硬上限，这一轮已不可信：收尾按 output_truncated 失败。 */
    let hardStopped = false;
    /** 已经交给 UI 的正文累积：缓冲被截断时以它为准（它才是完整的）。 */
    let streamedText = "";
    /** 最近一个工具步骤的 id：用来判断「正文是否发生在这步之后」。 */
    let lastToolId: string | null = null;
    /** 最后一个工具步骤之后是否还产出过正文（收尾判据，见 close 处理）。 */
    let textAfterLastTool = false;
    const pushText = (delta: string): void => {
      if (!delta) return;
      streamedText += delta;
      textAfterLastTool = true;
      opts.onChunk?.(delta);
    };
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        killProcessTree(child);
        reject(new Error(`agent turn timeout after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    const onAbort = () => {
      settle(() => {
        killProcessTree(child);
        reject(new Error("agent turn aborted"));
      });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // stream-json 模式（claude/codex/opencode）：stdout 是逐行 JSON 事件流。行缓冲
    // 切分（\n 边界），thinking/text 增量分道回调；原始字节照常入 chunks，
    // 结束时用 extractStreamJsonFinalText 提取权威正文。
    const streamJsonMode = agentSupportsReasoning(opts.agentName) && argvMode;
    // 非 stream-json 的 agent 才走「原始 stdout 即正文」的增量回调；JSON 信封
    // 型 agent（openclaw）跳过，避免把整份信封当正文流出去（见 emitsJsonEnvelope）。
    const streamRawStdout = !emitsJsonEnvelope(opts.agentName);
    let lineBuf = "";
    // 本轮收到过多少段思考。hermes 的思考要靠本机 stream_json.py 补丁才能进
    // JSONL（见 scripts/patch-hermes-reasoning.py），缺补丁时给一行日志提示，
    // 免得又去 web 侧翻帧。
    let reasoningChunks = 0;
    const deliverReasoning = (chunk: string): void => {
      reasoningChunks += 1;
      opts.onReasoningChunk?.(chunk);
    };
    // 过程流追踪器：逐行消化工具事件，全量快照上抛。没有回调方就不建，省掉
    // 每行一次的解析开销。
    const activity = opts.onActivity ? createActivityTracker() : undefined;
    const emitActivity = (): void => {
      if (!activity || !opts.onActivity) return;
      opts.onActivity(activity.snapshot());
    };
    // opencode 上报的是「整段 part 全文」而不是增量，这里按 part 记住已经发出的
    // 长度，只补新增后缀。少了这一层，同一段文字会被反复追加 → 气泡里正文翻倍。
    const partSent = new Map<string, number>();
    const emitPart = (kind: "reasoning" | "text", partId: string, full: string): void => {
      const key = `${kind}:${partId}`;
      const prev = partSent.get(key) ?? 0;
      if (full.length <= prev) return;
      partSent.set(key, full.length);
      const suffix = full.slice(prev);
      if (kind === "reasoning") deliverReasoning(suffix);
      else pushText(suffix);
    };
    // 会话续接：从事件流里捡 agent 的原生会话 id，交给调用方按 sessionKey 落盘
    // （见 agent-sessions.ts）。init / result 事件会重复带同一个 id，这里用
    // lastSessionId 去重 —— 否则一轮几十行输出就要回调几十次、写几十次盘。
    let lastSessionId = opts.resumeSessionId && isSessionId(opts.resumeSessionId)
      ? opts.resumeSessionId
      : "";
    const captureSessionId = (line: string): void => {
      if (!opts.onSessionId) return;
      const id = extractSessionId(line);
      if (!id || id === lastSessionId) return;
      lastSessionId = id;
      opts.onSessionId(id);
    };
    const emitStreamJson = (flushed: string) => {
      // 先收会话 id：它出现在 system.init 这类没有正文的行上，一旦走下面的
      // 「解析不出 delta 就 return」就永远捡不到了。
      captureSessionId(flushed);
      // 工具事件先消化：同一个 JSONL 行里 tool 事件与正文不会共存（claude 的
      // tool_use 走 content_block_*，codex 走 item.*），但收尾事件的顺序不能
      // 依赖 —— 先更新步骤再发正文，用户才不会看到「正文已出、步骤还没出」。
      if (activity && activity.push(flushed)) {
        emitActivity();
        // 只在**新步骤**出现时重置：同一步从 running 变 finished/error 不算
        // 「又调了一次工具」，否则正文与步骤的先后关系会被收尾事件抹掉。
        const snap = activity.snapshot();
        const newest = snap[snap.length - 1];
        if (newest && newest.id !== lastToolId) {
          lastToolId = newest.id;
          textAfterLastTool = false;
        }
      }
      const delta = parseStreamJsonLine(flushed);
      if (!delta) return;
      if (delta.replace && delta.partId) {
        if (delta.reasoning !== undefined) emitPart("reasoning", delta.partId, delta.reasoning);
        if (delta.text !== undefined) emitPart("text", delta.partId, delta.text);
        return;
      }
      if (delta.text !== undefined && isTextSnapshotLine(flushed)) {
        // 快照语义：与已流出的 delta 正文做前缀换算。全等（qwen/codebuddy 的
        // result 与 delta 流相同）→ 丢弃；延伸（result 含 delta 之后的更多内容）
        // → 补后缀；快照是已流出正文的子串（cursor 分段 assistant 快照）→
        // 丢弃；完全不同（delta 流缺席，cursor/traecli）→ 整段发。
        if (delta.text === streamedText) return;
        if (streamedText && delta.text.startsWith(streamedText)) {
          pushText(delta.text.slice(streamedText.length));
          return;
        }
        if (streamedText && streamedText.startsWith(delta.text)) return;
        pushText(delta.text);
        return;
      }
      if (delta.reasoning !== undefined) deliverReasoning(delta.reasoning);
      if (delta.text !== undefined) pushText(delta.text);
    };
    child.stdout.on("data", (buf: Buffer) => {
      totalBytes += buf.length;
      // 硬上限：agent 在喷日志/打印超大结果，这一轮已经不可能再有用。掐掉进程，
      // 收尾按 output_truncated 失败 —— 绝不能像过去那样「读到一半就 resolve」，
      // 那等于把半句话当完整回答发给用户。
      if (totalBytes > hardLimit) {
        hardStopped = true;
        killProcessTree(child);
        return;
      }
      // 缓冲满了只停止攒原始字节（内存保护），解析照旧继续：工具输出的洪峰之后
      // 往往还有最终回答，这里过去直接 return，后半轮就被整段丢掉了。
      if (!capped) {
        const room = bufferLimit - bufferedBytes;
        if (buf.length <= room) {
          chunks.push(buf);
          bufferedBytes += buf.length;
        } else {
          if (room > 0) {
            const tail = trimIncompleteUtf8Tail(buf.subarray(0, room));
            if (tail.length > 0) {
              chunks.push(tail);
              bufferedBytes += tail.length;
            }
          }
          capped = true;
          console.warn(
            `agent stdout exceeded ${bufferLimit} bytes; raw buffer capped (turn keeps parsing)`,
          );
        }
      }
      const delta = decoder.write(buf);
      if (streamJsonMode) {
        // 按行切分：完整行立即解析，残行留在 lineBuf 等下一个 chunk。
        lineBuf += delta;
        for (;;) {
          const nl = lineBuf.indexOf("\n");
          if (nl < 0) break;
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          emitStreamJson(line);
        }
      } else if (delta && streamRawStdout) {
        pushText(delta);
      }
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr = (stderr + buf.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      settle(() => {
        const stdout = Buffer.concat(chunks).toString("utf8");
        if (hardStopped) {
          // 硬上限触发：后半轮没读到，已产出的正文一并带出去（终帧还能显示
          // 用户刚才看到的那半句），但终态必须是失败。
          if (activity && activity.finish()) emitActivity();
          reject(new TurnIncompleteError(
            "output_truncated",
            streamedText.trim() || stdout,
            `agent stdout exceeded ${hardLimit} bytes`,
          ));
          return;
        }
        if (code === 0) {
          if (streamJsonMode) {
            // 冲刷残行后提取权威正文；提取失败（非标准输出）兜底原文。
            emitStreamJson(lineBuf);
            // 收尾：异常退出/事件流缺失都不会有 content_block_stop，悬着的
            // 「进行中」步骤必须在这里结掉，否则气泡里永远转圈。
            if (activity && activity.finish()) emitActivity();
            // 这一轮是不是「撞在失败的工具上就没下文了」。
            //
            // 现场（2026-10-20 10:54 运维助手）：opencode 跑到第 7 步 bash 报错，
            // 进程 exit 0，之后再没吐过一个字 —— 气泡里只剩「…拉取模型列表：」
            // 这半句前言，而我们把 exit 0 当成了「答完了」。opencode 自己的会话库
            // 可以确认：该轮最后一条 part 是 bash(error)，之后既无文本也无 step。
            //
            // 判据只认**确定的事实**：最后一步是 failed，且它之后再没出现正文。
            // （最后一步成功、或失败后模型解释了原因，都不算 —— 那两种情况用户
            // 至少拿到了交代。）
            const steps = activity?.snapshot() ?? [];
            const lastStep = steps[steps.length - 1];
            if (lastStep && lastStep.status === "failed" && !textAfterLastTool) {
              // 把「哪条命令、错在哪」一起写进日志：2026-10-20 13:07 现场就是
              // 模型把 PowerShell 的 Get-Content 塞进 bash，报 command not found
              // 之后一声不吭，只看 label「执行命令」根本查不出是 shell 不匹配。
              const failedCmd = (lastStep.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
              const failedOut = (lastStep.outputDetail ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
              reject(new TurnIncompleteError(
                "agent_incomplete",
                streamedText,
                `turn ended on a failed ${lastStep.label} with no follow-up text`
                  + (failedCmd ? ` [cmd: ${failedCmd}]` : "")
                  + (failedOut ? ` [output: ${failedOut}]` : ""),
                // 结构化带上失败步骤：im.ts 据此自动补跑一轮（把命令与错误
                // 回喂给 agent 让它换写法继续），而不是直接把半句话丢给用户。
                { label: lastStep.label, command: failedCmd || undefined, output: failedOut || undefined },
              ));
              return;
            }
            // 缓冲被截断时原始 stdout 只是前缀，以流式正文为准（它才是全的）。
            resolve(capped ? streamedText : (extractStreamJsonFinalText(stdout) ?? stdout));
          } else {
            // JSON 信封型 agent（openclaw）：正文之外还能从信封里拿到本轮的
            // 思考与工具汇总。只能在一轮结束时整段补上（信封是一次性的），
            // 但足以让群聊/讨论组里的气泡有过程可展开。
            if (emitsJsonEnvelope(opts.agentName)) {
              if (capped) {
                // 信封是一次性 JSON：缓冲被截断就等于这份结果拿不全，解析出来
                // 的只会是半截对象或日志行。判失败，别把残片当回答。
                if (activity && activity.finish()) emitActivity();
                reject(new TurnIncompleteError(
                  "output_truncated",
                  "",
                  `${opts.agentName} envelope exceeded ${bufferLimit} bytes`,
                ));
                return;
              }
              const details = extractOpenclawEnvelopeDetails(stdout);
              if (details.reasoning) deliverReasoning(details.reasoning);
              if (details.tools && details.tools.length > 0 && opts.onActivity) {
                opts.onActivity(details.tools.map((tool) => {
                  const cls = classifyTool(tool.name);
                  return {
                    id: `oc-${tool.name}`,
                    kind: cls.kind,
                    label: cls.label,
                    ...(tool.calls > 1 ? { detail: `共 ${tool.calls} 次` } : {}),
                    status: tool.failures > 0 && tool.failures >= tool.calls ? "failed" : "done",
                  } satisfies ActivityStep;
                }));
              }
              // 信封自己说了「这一轮没正常收尾」时（aborted / length /
              // content_filter / error），正文往往只有半句话 —— 必须如实报失败，
              // 否则前端会把它当一次完整回答展示（「话说一半就结束了」）。
              const health = openclawTurnHealth(stdout);
              if (health.incomplete) {
                if (activity && activity.finish()) emitActivity();
                reject(new TurnIncompleteError(
                  "agent_incomplete",
                  extractOpenclawReply(stdout),
                  `openclaw turn did not finish: ${health.detail ?? "unknown"}`,
                ));
                return;
              }
            }
            if (opts.agentName === "hermes" && reasoningChunks === 0) {
              console.warn(
                "hermes 未上报思考：本机 hermes 的 stream_json.py 可能还没打补丁，"
                + "跑一次 scripts/patch-hermes-reasoning.py（hermes 升级会被覆盖）",
              );
            }
            // kimi 官方明示 stream-json 不写 thinking（text 模式思考走 stderr）：
            // 升级到 stream-json 拿的是逐字正文 + 权威全文，思考通道预期为空，
            // 静默属正常——只有拿得到却没拿到才值得留痕。
            // 非流式路径：stdout 本身就是回答（信封型另有上面那条分支），缓冲
            // 上限即回答长度上限，保持「按字节截断」的老语义；流式路径的正文
            // 是解析出来的，所以缓冲满了也照样给出完整正文（见上一条分支）。
            resolve(
              opts.agentName === "openclaw" ? extractOpenclawReply(stdout)
                : opts.agentName === "qwenpaw" ? extractQwenpawReply(stdout)
                : stdout,
            );
          }
        } else {
          // 失败退出同样收尾：failed 帧要带着完整步骤，别留下「进行中」。
          if (activity && activity.finish()) emitActivity();
          // 只把 stderr 拼进错误串，会让「进程把原因打在 stdout」的 CLI 变成一句
          // 「没有任何输出」：kimi 的欢迎横幅（含 `send /login`）、opencode 的
          // usage dump（未知参数）都在 stdout 上。取尾部 800 字符就够
          // classifyTurnError 认出 login / unknown option，也不会让错误串膨胀
          // （几 MB 的 stdout 不能整个塞进去）。
          const tail = stdout.length > 800 ? stdout.slice(-800) : stdout;
          reject(new Error(
            `agent exited with code ${code}: ${stderr}${tail ? `\n[stdout tail]\n${tail}` : ""}`,
          ));
        }
      });
    });

    child.stdin.on("error", () => {
      // The agent may exit before reading all stdin (EPIPE); the close
      // handler reports the real outcome.
    });
    // pi / omp 的策略是「argv 定模式 + prompt 走 stdin」（pi 的 npm shim 会把
    // argv 里的提示词重新分词，pi.go:421-425）：它们**必须**把 prompt 写进
    // stdin 再关，不能走上面那支「纯 argv 即完事」的 fast path。
    // 2026-11-10 现场：漏写导致 omp 收到空 stdin，只吐一行 session 事件就退出，
    // 回合「成功」但正文为空（runAgentTurn 把这行 JSON 原文当成了回答）。
    if (argvMode && opts.agentName !== "dsh" && opts.agentName !== "pi" && opts.agentName !== "omp") {
      child.stdin.end();
    } else if (opts.agentName === "dsh") {
      // dsh 的 stdin 不是裸文本：版本化 stdio JSONL 协议要求写入
      // {"v":1,"type":"execute",…} 命令帧（上游 dshExecuteCommand，
      // dsh.go:54-64）。协议说 dsh 启动后先打 ready 帧再收命令——这里是
      // 简化：一次性管道写入后立即关，dsh 会在 ready 后按行消化缓冲里的
      // 命令。模型选择随命令携带（provider/model 整段路由）。
      //
      // 超长 prompt 也落在这里：dsh 没有 argv prompt 形态（策略不带 prompt），
      // stdin 是唯一入口，天然没有 8000 字上限问题。
      const route = opts.model ? splitModelRoute(opts.model) : null;
      const execute = {
        v: DSH_PROTOCOL_VERSION,
        type: "execute",
        request_id: `cm-${Date.now()}`,
        cwd: opts.cwd ?? "",
        prompt: opts.prompt,
        ...(route ? { model: { provider: route.provider, id: route.model } } : {}),
        mcp_servers: [],
      };
      child.stdin.write(JSON.stringify(execute) + "\n");
      child.stdin.end();
    } else {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    }
  });
}
