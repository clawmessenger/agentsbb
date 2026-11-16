import { spawn } from "node:child_process";

import { buildSpawnInvocation } from "./agents.js";
import type { DiscussionModelCatalog } from "./model-catalog.js";

// claude 的**活目录**（控制协议），设备端移植版。
//
// claude 没有 `--list-models`，也没有 models 子命令 —— 这正是设备端一直用
// 静态表（model-static-catalogs.ts）的原因。但它有一条发现通道：`--print
// --input-format stream-json` 起的会话会应答一条 `list_models` 控制请求，
// 返回的正是交互式 /model 选择器看到的那份清单（含 disabled 行与其原因）。
//
// 为什么值得搬（MUL-6961 的结论）：静态表不可能知道眼前这个 CLI 能不能跑某个
// 模型。上游每发一版新模型，静态表就多一个「面板里有、选中 400」的窗口：
//   "Claude Code 2.1.246 does not support this model; version 2.1.251 or newer"
// 活目录把窗口关在源头 —— 答案由本地二进制针对当前登录账号算出来。
//
// 设备端不做 Go 那边的「不支持」负缓存：那层是为了避免每个任务白付一次往返，
// 而我们的目录请求本身带 5 分钟缓存（model-catalog.ts），代价已经摊平。

/** 发现专用会话的 argv（对齐 claude_models.go:70-76）。 */
export const CLAUDE_LIST_MODELS_ARGS: readonly string[] = [
  "--print",
  "--verbose",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  // 不带 --mcp-config 的 --strict-mcp-config 等于「一个 MCP 也不加载」：发现流程
  // 不该为了列模型去把用户的 stdio MCP 全启一遍（慢且可能有副作用）。
  "--strict-mcp-config",
];

/** 控制请求的 request_id：回复里靠它挑出我们那一行。 */
export const CLAUDE_LIST_MODELS_REQUEST_ID = "agentsbb-list-models";

/** 一次往返的上限。Go 实测 1.6~2.2s，20s 是给「卡住的 keychain 提示」留的余量。 */
export const CLAUDE_LIST_MODELS_TIMEOUT_MS = 20_000;

/**
 * 目录里的 provider 名。claude 的 `--model` 收**裸 id**（见 agents.ts
 * buildModelArgs 的 claude 分支），provider 只是给前端分组用的。
 */
export const CLAUDE_CATALOG_PROVIDER = "anthropic";

/** `provider/model` 单斜杠路由（与 model-catalog.ts 同一把尺子）。 */
const ROUTE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

export interface ClaudeModelRow {
  /** CLI 里 `/model` 的 token（`sonnet` / `opus[1m]` / `default`）。 */
  value: string;
  /** 该 token 实际跑的模型 id —— 这是我们要存的值。 */
  resolvedModel: string;
  displayName: string;
  disabled: boolean;
}

/**
 * 解析 list_models 的回复。
 *
 * 返回 null 表示「没找到我们的那一行」（进程没答、输出是别的东西）；
 * `unsupported` 为 true 表示 CLI 明确说它不认识这个 subtype（老版本），
 * 调用方据此直接回落静态表，不必再试。
 *
 * 注意控制响应是**双层** `response` 嵌套（外层信封 + 内层 payload），这是
 * claude 自己的形状，不是笔误（claude_models.go:186-197）。
 */
export function parseClaudeListModels(
  stdout: string,
): { rows: ClaudeModelRow[]; unsupported: boolean } | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // stdout 是共享流，噪音行跳过
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const envelope = parsed as Record<string, unknown>;
    if (envelope.type !== "control_response") continue;
    const outer = envelope.response;
    if (typeof outer !== "object" || outer === null) continue;
    const response = outer as Record<string, unknown>;
    if (response.request_id !== CLAUDE_LIST_MODELS_REQUEST_ID) continue;
    if (response.subtype !== "success") {
      const reason = typeof response.error === "string" ? response.error : String(response.subtype);
      return {
        rows: [],
        unsupported: reason.toLowerCase().includes("unsupported control request subtype"),
      };
    }
    const payload = response.response;
    const models = typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).models
      : undefined;
    if (!Array.isArray(models)) return { rows: [], unsupported: false };
    const rows: ClaudeModelRow[] = [];
    for (const item of models) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const resolvedModel = typeof record.resolvedModel === "string" ? record.resolvedModel.trim() : "";
      if (!resolvedModel) continue;
      rows.push({
        value: typeof record.value === "string" ? record.value.trim() : "",
        resolvedModel,
        displayName: typeof record.displayName === "string" && record.displayName.trim() !== ""
          ? record.displayName.trim()
          : resolvedModel,
        disabled: record.disabled === true,
      });
    }
    return { rows, unsupported: false };
  }
  return null;
}

/**
 * 行 → wire 目录。
 *
 * · `value === "default"` 是「用 CLI 自己解析出来的那个」，折进 defaultModel，
 *   不当成一档可选模型（与 Go 的 claudeDefaultModelValue 同处理）；
 * · disabled 行**丢弃**：设备端渲染不出「灰掉 + 原因」，给一个选了必 400 的
 *   条目比不给更糟；
 * · 带 context-window 修饰的 id（`claude-opus-5[1m]`）走不过 wire 的单斜杠
 *   路由（方括号不在允许字符集里），跳过 —— 基础模型另有一行。
 */
export function claudeCatalogFromRows(
  rows: readonly ClaudeModelRow[],
): DiscussionModelCatalog & { skipped: number } {
  const models = new Map<string, string>();
  let defaultModel: string | null = null;
  let skipped = 0;
  for (const row of rows) {
    if (row.disabled) continue;
    const route = `${CLAUDE_CATALOG_PROVIDER}/${row.resolvedModel}`;
    if (!ROUTE_RE.test(route)) {
      skipped += 1;
      continue;
    }
    if (row.resolvedModel && !models.has(row.resolvedModel)) {
      models.set(row.resolvedModel, row.displayName);
    }
    if (row.value === "default" && !defaultModel) defaultModel = route;
  }
  const providers = models.size === 0
    ? []
    : [{
      id: CLAUDE_CATALOG_PROVIDER,
      name: CLAUDE_CATALOG_PROVIDER,
      models: [...models.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, name]) => ({ id, name })),
    }];
  return {
    defaultModel: defaultModel && providers.length > 0 ? defaultModel : null,
    providers,
    skipped,
  };
}

export interface ClaudeCatalogProbeOpts {
  execPath: string;
  timeoutMs?: number;
  logger?: (message: string) => void;
  /** 测试注入点。 */
  spawnImpl?: typeof spawn;
}

/**
 * 跑一次控制协议探测，返回 stdout。永不 reject —— 失败返回 null 并记日志，
 * 调用方回落静态表（与改造前行为一致，只是少了一份「活」清单）。
 */
export function probeClaudeModels(opts: ClaudeCatalogProbeOpts): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? CLAUDE_LIST_MODELS_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const { file, args } = buildSpawnInvocation(opts.execPath, [...CLAUDE_LIST_MODELS_ARGS]);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderrTail = "";

    const child = spawnImpl(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const finish = (value: string | null, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // 非 Windows 的独立进程组要整组收：claude 是 node 装的 shim，会带子进程。
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      if (reason) opts.logger?.(`claude model discovery: ${reason}`);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null, `timed out after ${timeoutMs}ms`), timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-500);
    });
    child.on("error", (err: Error) => finish(null, `spawn failed: ${err.message}`));
    child.on("close", (code) => {
      if (settled) return;
      if (stdout.trim() === "") {
        finish(null, `exited with code ${code ?? "null"} and no output${stderrTail ? `: ${stderrTail.trim()}` : ""}`);
        return;
      }
      finish(stdout);
    });

    // 一次性探测：写一帧控制请求后立刻关 stdin。CLI 把 EOF 当会话结束，自己退出 ——
    // 不需要我们事后去掐进程（claude_models.go:284-287 的同一手法）。
    try {
      child.stdin?.write(`${JSON.stringify({
        type: "control_request",
        request_id: CLAUDE_LIST_MODELS_REQUEST_ID,
        request: { subtype: "list_models" },
      })}\n`);
      child.stdin?.end();
    } catch (err) {
      finish(null, `failed to write control request: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/**
 * 发现 claude 的活目录。空目录返回 null（调用方据此保留静态兜底）。
 */
export async function discoverClaudeCatalog(
  opts: ClaudeCatalogProbeOpts,
): Promise<DiscussionModelCatalog | null> {
  const stdout = await probeClaudeModels(opts);
  if (stdout === null) return null;
  const parsed = parseClaudeListModels(stdout);
  if (!parsed) {
    opts.logger?.("claude model discovery: no list_models reply in output");
    return null;
  }
  if (parsed.unsupported) {
    opts.logger?.("claude CLI 不支持 list_models（版本偏旧），回落静态目录");
    return null;
  }
  const catalog = claudeCatalogFromRows(parsed.rows);
  if (catalog.providers.length === 0) {
    opts.logger?.("claude model discovery: list_models returned no usable model");
    return null;
  }
  if (catalog.skipped > 0) {
    opts.logger?.(`claude model discovery: skipped ${catalog.skipped} id(s) the wire route cannot carry`);
  }
  opts.logger?.(
    `claude model discovery: ${catalog.providers[0]?.models.length ?? 0} live model(s)`,
  );
  return { defaultModel: catalog.defaultModel, providers: catalog.providers };
}
