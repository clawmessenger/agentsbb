import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import { createActivityTracker, type ActivityStep } from "./agent-activity.js";
import { buildSpawnInvocation, killProcessTree } from "./agents.js";

// ACP turn 通道（设备端）。
//
// 为什么需要它：模型注入有两条完全不同的路。
//   · argv 路 —— `--model X` 拼进命令行（claude/codex/grok/copilot…），已实现；
//   · ACP 路 —— agent 以 ACP server 形态启动，模型靠 `session/set_model` 切换，
//     提示词靠 `session/prompt` 送进去。上游 Go exe 里 kiro/qoder/traecli/dim/
//     reasonix 走的就是这条路（server/pkg/agent/kiro.go:325、dim.go:544…）。
//
// 设备端过去只有 argv 路，于是这几家 agent 的模型选择在面板上"能选、不生效"。
// 本文件补上第二条：initialize → session/new（或 load/resume）→ set_model →
// prompt，正文字/思考增量从 `session/update` 通知里取。
//
// 与 acp-discovery.ts 的分工：那个只读探测目录（15s 后杀进程），这个跑真实回合。
// 协议细节（参数形状、权限应答、正文分块）逐条对齐 Go 的 hermesClient，
// 不引入第二套方言。

/** 一条 ACP update 规整后的类型（对齐 hermes.go normalizeACPUpdateType）。 */
export type AcpUpdateType =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "usage_update"
  | "turn_end"
  | "unknown";

export interface AcpTurnSpec {
  /** 让二进制进入 ACP server 模式的参数。 */
  args: readonly string[];
  /** 额外子进程环境变量（覆盖同名项）。 */
  env?: Readonly<Record<string, string>>;
  /** 裸模型 id 的虚拟 provider 分组名（与目录发现同一把尺子）。 */
  providerFallback: string;
  /** 续接旧会话用哪个 RPC：`session/load`（kiro/traecli/dim/grok）或 `session/resume`（qoder/reasonix）。 */
  resume: "load" | "resume";
  /**
   * initialize 之后、session 之前的显式认证步骤。目前只有 grok 需要
   * （grok.go:372-402：跳过它时会话操作一律被拒）。
   */
  authenticate?: "grok";
  /**
   * session 建好后立刻要钉的配置项（dim 的 permission/mode，
   * dim.go:520-541）。顺序即发送顺序。
   */
  setConfig?: ReadonlyArray<{ id: string; value: string }>;
  label: string;
}

export interface AcpTurnOpts {
  execPath: string;
  spec: AcpTurnSpec;
  prompt: string;
  /** 本轮模型（`provider/model` 路由）；空 = 跟随 agent 当前会话模型。 */
  model?: string;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  resumeSessionId?: string;
  /** 权限限制态：拒绝一切需要授权的动作（只读 ACP 会话不该能写盘）。 */
  fsRestricted?: boolean;
  onChunk?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  onActivity?: (steps: ActivityStep[]) => void;
  onSessionId?: (sessionId: string) => void;
  logger?: (message: string) => void;
  /** 测试注入点。 */
  spawnImpl?: typeof spawn;
}

/**
 * 回合**开跑前**就失败的错（起不来 / initialize 失败 / session 建不出）。
 *
 * 与「回合跑起来了但答错」区分开：只有这一类允许调用方回退到 headless 一次性
 * 调用（见 agents.ts 的 ACP 分支）—— 一旦 prompt 已经发出去，回退就等于让
 * agent 把同一件事做两遍。
 */
export class AcpStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpStartupError";
  }
}

/** 单行 JSON 上限：一个坏进程不该把内存打满。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** session/prompt 返回后等通知安静下来的窗口（对齐 Go 的 drain 窗口语义）。 */
const POST_PROMPT_QUIET_MS = 250;
const POST_PROMPT_MAX_WAIT_MS = 2_000;

/**
 * 收尾时等 agent 自己退出（关 stdin 之后）的上限。
 *
 * 不能在 prompt 返回后立刻 SIGKILL：dim 的会话锁只在**正常退出**时交出，
 * 硬杀的进程会把锁永久挂在会话上，下一轮续接只能开新会话（上下文丢失）。
 */
const GRACEFUL_EXIT_TIMEOUT_MS = 1_500;

/** 续接的尝试次数与间隔（「会话还被上一个进程占着」是可重试的）。 */
const RESUME_ATTEMPTS = 4;
/**
 * dim 0.5.25 实测：上一个 `dim acp` 进程退出后，会话锁要 ~5s 才交出
 * （`Session … is held by another process`）。Go 的 dim 后端同样是 3 次 × 2s
 * （dimSessionLoadRetryAttempts / dimSessionLoadRetryDelay）。
 */
const RESUME_RETRY_DELAY_MS = 2_000;
/**
 * 哪些续接错误值得重试：只认「被占用 / 加锁」这一族。其余（会话不存在、
 * 未登录）重试多少次都一样，只会白等。
 */
const RESUME_RETRY_RE = /in use|is held|held by|is locked|lock(ed)? by|another .*process|busy/i;

/** 已知的 session 级授权 optionId（hermes.go:1538）。 */
const SESSION_SCOPED_OPTION_IDS = ["allow_session", "approve_for_session"];

const KIND_ALLOW_ONCE = "allow_once";
const KIND_ALLOW_ALWAYS = "allow_always";
const KIND_REJECT_ONCE = "reject_once";

const GROK_AUTH_API_KEY = "xai.api_key";
const GROK_AUTH_CACHED_TOKEN = "cached_token";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * JSON-RPC 错误的 `data` → 一句可读后缀。
 *
 * `details` 是 ACP runtime 最常放的字段（dim 的会话占用原因就在那里），优先取它；
 * 其余形状整段序列化并截断 —— 日志要能看懂，但不能被一个巨大对象撑爆。
 */
function describeErrorData(data: unknown): string {
  if (data === undefined || data === null) return "";
  const record = asRecord(data);
  if (record) {
    const details = asString(record.details);
    if (details) return ` (data: ${details})`;
  }
  if (typeof data === "string") return data.trim() ? ` (data: ${data.trim()})` : "";
  try {
    const json = JSON.stringify(data);
    return json && json !== "{}" ? ` (data: ${json.slice(0, 300)})` : "";
  } catch {
    return "";
  }
}

/**
 * wire 路由 → ACP `set_model` 的 modelId。
 *
 * 目录里裸 id 被归到虚拟 provider（`kiro/xxx`）下才能上屏，但 agent 认的是裸
 * `xxx`。规则与 cursor 同：前缀等于虚拟 provider 就剥掉，否则原样透传
 * （reasonix/dim 这类自家模型本来就是 `provider/model` 形状，剥了反而错）。
 */
export function acpTurnModelId(route: string, providerFallback: string): string {
  const prefix = `${providerFallback}/`;
  if (route.startsWith(prefix) && route.length > prefix.length) {
    return route.slice(prefix.length);
  }
  return route;
}

/** set_model 的候选模型 id，按尝试顺序（首个是主判据）。 */
export function acpTurnModelCandidates(model: string, providerFallback: string): string[] {
  const primary = acpTurnModelId(model, providerFallback);
  return primary === model ? [model] : [primary, model];
}

/** `session/update` 的 update 对象 → 规整类型（两代 schema 都认）。 */
export function normalizeAcpUpdateType(update: Record<string, unknown>): AcpUpdateType {
  const raw = asString(update.sessionUpdate) || asString(update.type);
  const key = raw.toLowerCase().replace(/[_-\s]/g, "");
  switch (key) {
    case "agentmessagechunk":
      return "agent_message_chunk";
    case "agentthoughtchunk":
      return "agent_thought_chunk";
    case "toolcall":
      return "tool_call";
    case "toolcallupdate":
      return "tool_call_update";
    case "usageupdate":
      return "usage_update";
    case "turnend":
      return "turn_end";
    default:
      return "unknown";
  }
}

/**
 * 从 chunk 更新里取文本。
 *
 * ACP 的 `content` 有两种已知形态：`{type:"text",text}`（各家标准实现）与
 * `[{type:"text",text}]`（数组包裹）。两种都收，取不到就返回空串。
 */
export function acpChunkText(update: Record<string, unknown>): string {
  const content = update.content;
  if (typeof content === "string") return content;
  const single = asRecord(content);
  if (single) return asString(single.text);
  if (Array.isArray(content)) {
    return content
      .map((item) => asString(asRecord(item)?.text))
      .filter((text) => text.length > 0)
      .join("");
  }
  return "";
}

export interface AcpPermissionChoice {
  optionId: string;
  grant: boolean;
}

interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

/**
 * 从 `session/request_permission` 的 options 里挑一个**agent 真给过的** id。
 *
 * 契约（hermes.go:1558-1593）：必须选它列出来的选项，编一个没给过的 id 等于拒绝，
 * 回 "cancelled" 更是把整轮取消掉。优先 session 级授权 → allow_once →
 * reject_once；什么都没有就返回 null，由调用方回协议错误。
 */
export function selectAcpPermissionOption(
  params: unknown,
  opts: { fsRestricted?: boolean } = {},
): AcpPermissionChoice | null {
  const record = asRecord(params);
  const rawOptions = record?.options;
  const options: AcpPermissionOption[] = Array.isArray(rawOptions)
    ? rawOptions
      .map((item) => {
        const option = asRecord(item);
        if (!option) return null;
        const optionId = asString(option.optionId);
        if (!optionId) return null;
        return { optionId, kind: asString(option.kind).trim().toLowerCase() };
      })
      .filter((option): option is AcpPermissionOption => option !== null)
    : [];

  const reject = (): AcpPermissionChoice | null => {
    const once = options.find((option) => option.kind === KIND_REJECT_ONCE);
    return once ? { optionId: once.optionId, grant: false } : null;
  };

  // 权限限制态：本轮所有需要授权的动作一律拒（只拒这一次，不取消整轮）。
  if (opts.fsRestricted) return reject();

  for (const wanted of SESSION_SCOPED_OPTION_IDS) {
    const hit = options.find((option) => option.optionId === wanted
      && (option.kind === KIND_ALLOW_ALWAYS || option.kind === KIND_ALLOW_ONCE));
    if (hit) return { optionId: hit.optionId, grant: true };
  }
  const always = options.find((option) => option.kind === KIND_ALLOW_ALWAYS);
  if (always) return { optionId: always.optionId, grant: true };
  const once = options.find((option) => option.kind === KIND_ALLOW_ONCE);
  if (once) return { optionId: once.optionId, grant: true };
  return reject();
}

/** initialize 响应里的 authMethods id 列表（hermes.go:2391）。 */
export function acpAuthMethods(initResult: unknown): string[] {
  const record = asRecord(initResult);
  const list = record?.authMethods;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => asString(asRecord(item)?.id).trim())
    .filter((id) => id.length > 0);
}

/**
 * 选择认证方式（grok.go:645-670）：有 XAI_API_KEY 且被提供就用它，否则用缓存登录。
 * 返回 null 表示没有可用方式 —— 调用方据此给出「去 `grok login`」的明确指引。
 */
export function selectGrokAuthMethod(
  methods: readonly string[],
  haveApiKey: boolean,
): string | null {
  const offered = new Set(methods.map((method) => method.trim()).filter(Boolean));
  if (haveApiKey && offered.has(GROK_AUTH_API_KEY)) return GROK_AUTH_API_KEY;
  if (offered.has(GROK_AUTH_CACHED_TOKEN)) return GROK_AUTH_CACHED_TOKEN;
  return null;
}

/** tool_call 的 kind → 用来查中文展示名的工具名（ACP 的 kind 是其自有词表）。 */
const ACP_TOOL_NAME_BY_KIND: Readonly<Record<string, string>> = {
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "grep",
  execute: "bash",
  fetch: "fetch",
  other: "",
};

/**
 * 把 ACP 的 tool_call / tool_call_update 折成 activity 追踪器认识的 JSONL 帧
 * （dsh 的 v=1 形状）。这样过程流不需要在 agent-activity.ts 里再开一条方言。
 */
function acpToolFrames(
  update: Record<string, unknown>,
  type: AcpUpdateType,
): string[] {
  const id = asString(update.toolCallId) || asString(update.tool_call_id);
  if (!id) return [];
  const input = asRecord(update.rawInput) ?? asRecord(update.input) ?? undefined;
  if (type === "tool_call") {
    const kind = asString(update.kind).toLowerCase();
    const name = asString(update.name)
      || ACP_TOOL_NAME_BY_KIND[kind]
      || asString(update.title)
      || "tool";
    return [JSON.stringify({
      v: 1,
      type: "tool_call",
      call_id: id,
      name,
      arguments: input ? JSON.stringify(input) : "",
    })];
  }
  const status = asString(update.status).toLowerCase();
  if (!status) return [];
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  if (!terminal) return [];
  const output = update.rawOutput ?? update.output ?? update.content;
  return [JSON.stringify({
    v: 1,
    type: "tool_result",
    call_id: id,
    output: typeof output === "string" ? output : JSON.stringify(output ?? ""),
    is_error: status === "failed",
  })];
}

/** 从 session 响应里取 sessionId（session/new、session/load、session/resume 同形）。 */
function acpSessionId(result: unknown): string {
  return asString(asRecord(result)?.sessionId) || asString(asRecord(result)?.session_id);
}

/**
 * 正文分块 → 最终回答。
 *
 * ACP 把「旁白」和「最终答案」用同一种 chunk 发出来，唯一的边界是工具调用
 * （acp_deliverable.go:8-26）。所以交付物取**最后一次工具调用之后**的文本；
 * 整轮停在工具调用上时回退到最近一个非空文本块。
 */
class DeliverableTracker {
  private full = "";
  private deliverable = "";
  private lastTextBlock = "";

  pushText(text: string): void {
    this.full += text;
    this.deliverable += text;
  }

  markToolCall(): void {
    if (this.deliverable.trim() !== "") this.lastTextBlock = this.deliverable;
    this.deliverable = "";
  }

  result(): { deliverable: string; full: string } {
    const deliverable = this.deliverable.trim() !== "" ? this.deliverable : this.lastTextBlock;
    return { deliverable, full: this.full };
  }
}

/**
 * 跑一个 ACP 回合，返回最终回答正文。
 *
 * 失败语义：
 *   · 开跑前失败 → AcpStartupError（调用方可回退 headless）；
 *   · prompt 发出后失败/超时/中止 → 普通 Error（**不可**回退，否则重复干活）。
 */
export function runAcpTurn(opts: AcpTurnOpts): Promise<string> {
  const spec = opts.spec;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const { file, args } = buildSpawnInvocation(opts.execPath, [...spec.args]);
  const cwd = resolvePath(opts.cwd ?? process.cwd());
  const env = { ...process.env, ...spec.env } as NodeJS.ProcessEnv;

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false;
    let promptSent = false;
    let stderrTail = "";
    let nextId = 1;
    let buffer = "";
    const pending = new Map<number, (msg: Record<string, unknown> | null) => void>();
    const deliverable = new DeliverableTracker();
    const activity = opts.onActivity ? createActivityTracker() : undefined;

    const child = spawnImpl(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd,
      env,
      // 非 Windows 给独立进程组：超时/中止时整组收掉，不留孤儿 node 子进程。
      detached: process.platform !== "win32",
    });

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(quietTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      for (const resolvePending of pending.values()) resolvePending(null);
      pending.clear();
      fn();
    };

    const fail = (err: Error): void => settle(() => {
      killProcessTree(child);
      rejectPromise(err);
    });

    const startupFail = (message: string): void => {
      fail(new AcpStartupError(`${spec.label} ACP: ${message}`));
    };

    const timer = setTimeout(() => {
      fail(new Error(`agent turn timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const onAbort = (): void => fail(new Error("agent turn aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // --- 通知安静窗口：session/prompt 的响应可能早于最后几个 chunk 到达 ---
    let quietTimer: NodeJS.Timeout | undefined;
    let promptResolvedAt = 0;
    let pendingPromptResult: unknown = null;
    /** 本轮建/续的会话 id：收尾时用它发 session/close。 */
    let activeSessionId = "";
    let finishing = false;
    const tryFinishPrompt = (): void => {
      if (!promptResolvedAt || finishing) return;
      const stopReason = asString(asRecord(pendingPromptResult)?.stopReason);
      if (stopReason === "cancelled" || stopReason === "refusal") {
        fail(new Error(`${spec.label} ACP: prompt ${stopReason === "cancelled" ? "cancelled" : "refused"}`));
        return;
      }
      finishing = true;
      const { deliverable: answer, full } = deliverable.result();
      // 先**优雅**关会话再杀进程。
      //
      // 现场（2026-11-16 真机）：dim 直接 SIGKILL 之后，下一轮的 session/load
      // 报 `-32603 Internal error`；reasonix 更直白 —— `session/resume: this
      // session is in use by another Reasonix process`。两者都是「上一个进程
      // 没把锁交出来」。session/close 是 ACP 里唯一能交锁的动作，Go 的 dim 后端
      // 也在收尾时做同一件事（dimSessionCloseTimeout）。
      //
      // 上限 400ms：交不出锁也不能拖住整轮 —— 下一轮的续接失败会自动开新会话。
      const closeThenResolve = async (): Promise<void> => {
        if (activeSessionId) {
          await Promise.race([
            request("session/close", { sessionId: activeSessionId }).catch(() => undefined),
            new Promise((resolveWait) => { setTimeout(resolveWait, 400).unref?.(); }),
          ]);
        }
        // 再**优雅退出**：关 stdin 让进程自己收工。
        //
        // 这一步不是洁癖，是续接能不能用的前提。dim 0.5.25 实测：会话锁只在进程
        // **正常退出**时交出；SIGKILL 之后锁一直挂着，下一轮 session/load 只会得到
        // `Internal error (data: Session … is held by another process)`，等多久都不散。
        // （reasonix 也会留下 `session/resume: this session is in use`。）
        await waitForExit(child);
        settle(() => {
          killProcessTree(child);
          resolvePromise(answer.trim() !== "" ? answer : full);
        });
      };
      void closeThenResolve();
    };
    const scheduleQuiet = (): void => {
      if (!promptResolvedAt) return;
      clearTimeout(quietTimer);
      const elapsed = Date.now() - promptResolvedAt;
      quietTimer = setTimeout(
        tryFinishPrompt,
        Math.max(0, Math.min(POST_PROMPT_QUIET_MS, POST_PROMPT_MAX_WAIT_MS - elapsed)),
      );
    };

    // 优雅退出：关 stdin，等进程自己停下（最多 GRACEFUL_EXIT_TIMEOUT_MS）。
    // 见 closeThenResolve 里关于会话锁的说明 —— 这里等的是「锁被交出来」。
    const waitForExit = (target: typeof child): Promise<void> => new Promise((resolveExit) => {
      let done = false;
      const once = (): void => {
        if (done) return;
        done = true;
        resolveExit();
      };
      target.once("close", once);
      target.once("exit", once);
      setTimeout(once, GRACEFUL_EXIT_TIMEOUT_MS).unref?.();
      try {
        target.stdin?.end();
      } catch {
        /* 已经关了 */
      }
    });

    const write = (payload: Record<string, unknown>): void => {      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        opts.logger?.(`acp write failed: ${describe(err)}`);
      }
    };

    const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      new Promise((resolveRequest, rejectRequest) => {
        if (settled) {
          rejectRequest(new AcpStartupError(`${spec.label} ACP: process already closed`));
          return;
        }
        const id = nextId++;
        pending.set(id, (msg) => {
          if (msg === null) {
            rejectRequest(new Error(`${method} failed: acp process closed`));
            return;
          }
          const error = asRecord(msg.error);
          if (error) {
            const code = typeof error.code === "number" ? error.code : null;
            // data 一定要带上：dim 把真正的原因（"Session … is held by another
            // process"）放在 data.details 里，而顶层 message 只有一句
            // "Internal error"。少了它，日志和续接重试判据都变成了瞎猜。
            rejectRequest(new Error(
              `${method} failed${code === null ? "" : ` (${code})`}`
              + `: ${asString(error.message) || "unknown error"}`
              + describeErrorData(error.data),
            ));
            return;
          }
          resolveRequest(msg.result);
        });
        write({ jsonrpc: "2.0", id, method, params });
      });

    const replyError = (id: unknown, code: number, message: string): void => {
      write({ jsonrpc: "2.0", id, error: { code, message } });
    };

    const handleAgentRequest = (msg: Record<string, unknown>): void => {
      const method = asString(msg.method);
      const id = msg.id;
      if (method === "session/request_permission") {
        const choice = selectAcpPermissionOption(msg.params, {
          ...(opts.fsRestricted ? { fsRestricted: true } : {}),
        });
        if (!choice) {
          replyError(id, -32603, "no auto-selectable permission option offered");
          return;
        }
        if (!choice.grant) {
          opts.logger?.(`acp: denied ${opts.execPath} permission request (${choice.optionId})`);
        }
        write({
          jsonrpc: "2.0",
          id,
          result: { outcome: { outcome: "selected", optionId: choice.optionId } },
        });
        return;
      }
      // 我们没声明 fs / terminal 能力，agent 不该来问；真问了就如实回不支持，
      // 让它走自己的本地实现（Go 侧未声明能力时同样是 -32601）。
      replyError(id, -32601, `method not supported by device client: ${method}`);
    };

    const handleUpdate = (update: Record<string, unknown>): void => {
      const type = normalizeAcpUpdateType(update);
      if (type === "agent_message_chunk") {
        const text = acpChunkText(update);
        if (!text) return;
        deliverable.pushText(text);
        opts.onChunk?.(text);
        scheduleQuiet();
        return;
      }
      if (type === "agent_thought_chunk") {
        const text = acpChunkText(update);
        if (!text) return;
        opts.onReasoningChunk?.(text);
        scheduleQuiet();
        return;
      }
      if (type === "tool_call" || type === "tool_call_update") {
        // 工具调用是正文的分界线：旁白到此为止，之后才是交付物。
        if (type === "tool_call") deliverable.markToolCall();
        if (activity && opts.onActivity) {
          let changed = false;
          for (const frame of acpToolFrames(update, type)) {
            if (activity.push(frame)) changed = true;
          }
          if (changed) opts.onActivity(activity.snapshot());
        }
        scheduleQuiet();
      }
    };

    const dispatch = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // 非 JSON 噪音（部分 CLI 会往 stdout 打日志）
      }
      const msg = asRecord(parsed);
      if (!msg) return;
      const id = msg.id;
      if (typeof id === "number") {
        if (msg.method !== undefined) {
          handleAgentRequest(msg);
          return;
        }
        const handler = pending.get(id);
        if (!handler) return;
        pending.delete(id);
        handler(msg);
        return;
      }
      const method = asString(msg.method);
      if (method !== "session/update" && method !== "session/notification") return;
      const params = asRecord(msg.params);
      const update = asRecord(params?.update);
      if (!update) return;
      handleUpdate(update);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) {
        fail(new Error(`${spec.label} ACP: output exceeded ${MAX_LINE_BYTES} bytes`));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) dispatch(line);
        if (settled) return;
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err: Error) => {
      if (promptSent) {
        fail(new Error(`${spec.label} ACP: ${err.message}`));
        return;
      }
      startupFail(`spawn failed: ${err.message}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      const tail = buffer.trim();
      if (tail) dispatch(tail);
      if (settled) return;
      if (promptResolvedAt) {
        tryFinishPrompt();
        return;
      }
      const detail = stderrTail.trim();
      const message = `process exited with code ${code ?? "null"}`
        + (detail ? `: ${detail}` : "");
      if (promptSent) {
        fail(new Error(`${spec.label} ACP: ${message}`));
        return;
      }
      startupFail(message);
    });

    void (async () => {
      try {
        const initResult = await request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "agentsbb-device", version: "1.0.0" },
          clientCapabilities: {},
        });

        if (spec.authenticate === "grok") {
          const methodId = selectGrokAuthMethod(
            acpAuthMethods(initResult),
            Boolean(process.env.XAI_API_KEY),
          );
          if (!methodId) {
            startupFail("grok 未提供可用认证方式；请设置 XAI_API_KEY 或先跑 grok login");
            return;
          }
          await request("authenticate", { methodId, _meta: { headless: true } });
        }

        // 续接。续接失败**不抛**、也**不回退 headless**：那两种做法都会让这台
        // 设备在这个会话里永久丢掉模型注入（第一次续接失败 → 每轮都走 headless，
        // 而 headless 恰恰是「选了没用」的那条路）。这里当场开新会话继续，
        // 并把新 id 回传给调用方覆盖旧值 —— 语义与 Go 的 ResumeRejected 自愈一致。
        let session: unknown = null;
        let resumed = false;
        if (opts.resumeSessionId) {
          for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt += 1) {
            try {
              session = await request(`session/${spec.resume}`, {
                cwd,
                sessionId: opts.resumeSessionId,
                mcpServers: [],
              });
              resumed = true;
              break;
            } catch (err) {
              const message = describe(err);
              // 「会话还被上一个进程占着」是**可重试**的：上一轮刚退出时锁还没
              // 交出来（reasonix 实测：`this session is in use by another
              // Reasonix process (pid …, since 17:43)`）。Go 的 dim 后端为同一
              // 现象留了 3 次 × 2s（dimSessionLoadRetryAttempts）。
              const retryable = RESUME_RETRY_RE.test(message);
              if (!retryable || attempt === RESUME_ATTEMPTS - 1) {
                opts.logger?.(`acp: 续接会话 ${opts.resumeSessionId} 失败，改为新会话（${message}）`);
                break;
              }
              await new Promise((resolveWait) => { setTimeout(resolveWait, RESUME_RETRY_DELAY_MS); });
            }
          }
        }
        if (!session) {
          session = await request("session/new", { cwd, mcpServers: [] });
        }
        const sessionId = acpSessionId(session) || (resumed ? opts.resumeSessionId ?? "" : "");
        if (!sessionId) {
          startupFail("session 建立后没有 sessionId");
          return;
        }
        activeSessionId = sessionId;
        opts.onSessionId?.(sessionId);

        for (const option of spec.setConfig ?? []) {
          await request("session/set_config_option", {
            sessionId,
            configId: option.id,
            value: option.value,
          });
        }

        if (opts.model) {
          const candidates = acpTurnModelCandidates(opts.model, spec.providerFallback);
          let lastError: unknown = null;
          let applied = false;
          for (const candidate of candidates) {
            try {
              await request("session/set_model", { sessionId, modelId: candidate });
              applied = true;
              break;
            } catch (err) {
              lastError = err;
            }
          }
          if (!applied) {
            // 绝不静默回落：那正是「面板上选了、实际没生效」的老毛病。
            fail(new Error(`${spec.label} ACP: 无法切换到模型 ${opts.model}：${describe(lastError)}`));
            return;
          }
        }

        promptSent = true;
        const promptResult = await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: opts.prompt }],
        });
        pendingPromptResult = promptResult;
        promptResolvedAt = Date.now();
        scheduleQuiet();
      } catch (err) {
        if (settled) return;
        if (promptSent) {
          fail(err instanceof Error ? err : new Error(describe(err)));
          return;
        }
        startupFail(describe(err));
      }
    })();
  });
}
