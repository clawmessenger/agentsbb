import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSpawnInvocation } from "./agents.js";
import type { DiscussionModelCatalog } from "./model-catalog.js";

// 通用 ACP 模型目录发现器（设备端）。
//
// 为什么需要它：上游 Go 服务端的 exe（server/pkg/agent/models.go 的
// discoverACPModels）能让十几家 agent 报出「本地供应商 + 模型清单」，靠的是
// ACP 标准握手：initialize → session/new，session/new 的响应里带
// `models.availableModels`（老 schema）或 `configOptions` 里的 model 选项
// （kimi 0.29 起的新 schema）。本包原先没有任何 ACP 客户端，于是
// codearts / deveco(qoder) / kiro-cli / qodercli / traecli / dim / reasonix
// 这些「只有 ACP 才给目录」的 agent 在面板上一律空态 —— 用户看到的就是
// 「拿不到本地模型供应商和模型列表」。
//
// 这里只做**只读探测**：不 session/prompt、不发权限响应、不落任何状态到用户
// 目录（cwd 用临时目录；需要隔离状态的 agent 由调用方在 spec.env 里指定
// *_STATE_HOME 之类），拿到目录立刻杀进程树。
//
// 每个 provider 的启动参数差异全部收敛到 agent-acp-providers.ts 的一张表里，
// 加一家 agent = 加一行，不写新代码 —— 这就是「批量对齐 Go 原有 exe」的落点。

export interface AcpDiscoverySpec {
  /** 让二进制进入 ACP server 模式的参数，例如 ["acp"] / ["--acp"]。 */
  args: readonly string[];
  /** 额外子进程环境变量（覆盖同名项）。 */
  env?: Readonly<Record<string, string>>;
  /** 整段握手预算，缺省 ACP_DISCOVERY_TIMEOUT_MS。 */
  timeoutMs?: number;
  /**
   * 目录条目不带 provider 前缀时，用来分组的虚拟 provider id（例如 `kiro`）。
   * 前端 wire 只认 `provider/model` 单斜杠路由，裸 id 必须先归组才能展示。
   */
  providerFallback: string;
}

export interface AcpDiscoveryOpts {
  execPath: string;
  spec: AcpDiscoverySpec;
  /** 探测用的 cwd；缺省临时目录（探测后删除）。 */
  cwd?: string;
  /** 日志（失败原因走这里，不要抛给面板）。 */
  logger?: (message: string) => void;
  /** 测试注入点。 */
  spawnImpl?: typeof spawn;
}

/** 整段握手的默认上限。Go 侧 acpDiscoveryDefaultTimeout 同为 15s。 */
export const ACP_DISCOVERY_TIMEOUT_MS = 15_000;

/** 单行 JSON 的上限，防止一个坏进程把内存打满。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

interface AcpModelInfo {
  modelId?: unknown;
  model_id?: unknown;
  name?: unknown;
}

interface AcpConfigOption {
  id?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `provider/model` 单斜杠路由（与 model-catalog.ts 的 ROUTE_RE 同一把尺子）。 */
const ROUTE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

/** ACP 的裸模型 id 允许的字符集：不接受空白、斜杠在此另行处理。 */
const BARE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * 把一条 ACP 目录条目规整成 `provider/model` 路由。
 *
 * 三种形态都在真机上见过：
 *   * `quukk/glm-5.2`      —— 本身就是路由，直接收；
 *   * `kimi-code/k3`       —— 同上；
 *   * `claude-sonnet-4-5`  —— 裸 id，用 spec 的虚拟 provider 归组（与 agy 同法）。
 * 多斜杠（`a/b/c`）无法映射成 wire 形状，直接丢。
 */
export function acpRouteFromModelId(modelId: string, providerFallback: string): string | null {
  const id = modelId.trim();
  if (!id) return null;
  if (ROUTE_RE.test(id)) return id;
  if (id.includes("/")) return null;
  if (!BARE_ID_RE.test(id)) return null;
  const route = `${providerFallback}/${id}`;
  return ROUTE_RE.test(route) ? route : null;
}

/**
 * 从 `session/new` 的响应里抽模型目录。
 *
 * 两代 schema 都认（Go 侧 parseACPSessionNewModels / parseACPConfigOptionModels
 * 的同构实现）：
 *   1. `models.availableModels[]`（camel/snake 都收），优先；
 *   2. `configOptions[]` 里 id 或 category 为 `model` 的 select 项，
 *      取 `options[].value`。thinking / thought_level 之类**必须忽略** ——
 *      那是独立的产品面，混进模型下拉就是错值。
 *
 * 解析不出任何条目时返回 null（调用方据此区分「没有目录」与「目录为空」）。
 */
export function parseAcpSessionModels(
  result: unknown,
  providerFallback: string,
): { routes: string[]; defaultRoute: string | null } | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;

  const modelsBlock = record.models;
  if (typeof modelsBlock === "object" && modelsBlock !== null) {
    const models = modelsBlock as Record<string, unknown>;
    const available = Array.isArray(models.availableModels)
      ? models.availableModels
      : Array.isArray(models.available_models)
        ? models.available_models
        : null;
    if (available) {
      const routes = collectRoutes(
        available.map((entry) => {
          if (typeof entry !== "object" || entry === null) return null;
          const info = entry as AcpModelInfo;
          return asTrimmedString(info.modelId) ?? asTrimmedString(info.model_id);
        }),
        providerFallback,
      );
      const current = asTrimmedString(models.currentModelId)
        ?? asTrimmedString(models.current_model_id);
      if (routes.length > 0) {
        return { routes, defaultRoute: normalizeRoute(current, providerFallback) };
      }
    }
  }

  const options = record.configOptions;
  if (!Array.isArray(options)) return null;
  for (const entry of options) {
    if (typeof entry !== "object" || entry === null) continue;
    const option = entry as AcpConfigOption;
    const id = asTrimmedString(option.id);
    const category = asTrimmedString(option.category);
    const isModelPicker = id?.toLowerCase() === "model" || category?.toLowerCase() === "model";
    if (!isModelPicker || !Array.isArray(option.options)) continue;
    const routes = collectRoutes(
      option.options.map((item) => {
        if (typeof item !== "object" || item === null) return null;
        return asTrimmedString((item as Record<string, unknown>).value);
      }),
      providerFallback,
    );
    if (routes.length > 0) {
      return {
        routes,
        defaultRoute: normalizeRoute(asTrimmedString(option.currentValue), providerFallback),
      };
    }
  }
  return null;
}

function normalizeRoute(modelId: string | null, providerFallback: string): string | null {
  if (!modelId) return null;
  return acpRouteFromModelId(modelId, providerFallback);
}

function collectRoutes(ids: Array<string | null>, providerFallback: string): string[] {
  const routes: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    const route = acpRouteFromModelId(id, providerFallback);
    if (!route || seen.has(route)) continue;
    seen.add(route);
    routes.push(route);
  }
  return routes;
}

/** 路由列表 → wire 目录（按 provider 分组，组内按 id 排序）。 */
export function catalogFromAcpRoutes(
  routes: readonly string[],
  defaultRoute: string | null,
): DiscussionModelCatalog {
  const groups = new Map<string, Map<string, string>>();
  for (const route of routes) {
    const match = ROUTE_RE.exec(route);
    if (!match) continue;
    const [, providerId, modelId] = match;
    let group = groups.get(providerId);
    if (!group) {
      group = new Map();
      groups.set(providerId, group);
    }
    if (!group.has(modelId)) group.set(modelId, modelId);
  }
  const providers = [...groups.entries()]
    .map(([id, models]) => ({
      id,
      name: id,
      models: [...models.keys()].sort((a, b) => a.localeCompare(b)).map((modelId) => ({
        id: modelId,
        name: models.get(modelId) ?? modelId,
      })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const wanted = defaultRoute && ROUTE_RE.test(defaultRoute) ? defaultRoute : null;
  const inCatalog = wanted !== null
    && providers.some((provider) => provider.id === wanted.split("/")[0]
      && provider.models.some((model) => model.id === wanted.split("/")[1]));
  if (providers.length === 0) return { defaultModel: null, providers: [] };
  return { defaultModel: inCatalog ? wanted : null, providers };
}

function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (!child.pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === "win32") {
    // ACP server 会再起子进程（node / python），只杀直接子进程会留下孤儿，
    // 而目录探测是周期性的 —— 泄漏会累积。
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/**
 * 跑一次 ACP 握手拿目录。永不 reject —— 失败返回空目录并把原因写进 logger，
 * 面板据此回落「手动填写」而不是报错。
 */
export async function discoverAcpModelCatalog(
  opts: AcpDiscoveryOpts,
): Promise<DiscussionModelCatalog> {
  const spec = opts.spec;
  const timeoutMs = spec.timeoutMs ?? ACP_DISCOVERY_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const { file, args } = buildSpawnInvocation(opts.execPath, [...spec.args]);

  let cwd = opts.cwd;
  let tempCwd: string | null = null;
  if (!cwd) {
    try {
      tempCwd = mkdtempSync(join(tmpdir(), "agentsbb-acp-discovery-"));
      cwd = tempCwd;
    } catch {
      cwd = tmpdir();
    }
  }

  const env = spec.env ? { ...process.env, ...spec.env } : process.env;

  return new Promise<DiscussionModelCatalog>((resolve) => {
    const child = spawnImpl(file, args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      cwd,
      env,
      // 非 Windows 上给独立进程组，killTree 才能整组收掉。
      detached: process.platform !== "win32",
    });

    let settled = false;
    let nextId = 1;
    let buffer = "";
    const pending = new Map<number, (msg: unknown) => void>();

    const finish = (catalog: DiscussionModelCatalog, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const resolvePending of pending.values()) resolvePending(null);
      pending.clear();
      killTree(child);
      if (tempCwd) {
        try {
          rmSync(tempCwd, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      if (reason) opts.logger?.(`acp model discovery (${opts.execPath}) ${reason}`);
      resolve(catalog);
    };

    const timer = setTimeout(() => {
      finish({ defaultModel: null, providers: [] }, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, (msg) => {
          if (msg === null) {
            rejectRequest(new Error("acp process closed"));
            return;
          }
          const envelope = msg as { result?: unknown; error?: { message?: unknown; code?: unknown } };
          if (envelope.error) {
            const message = asTrimmedString(envelope.error.message) ?? "unknown error";
            const code = typeof envelope.error.code === "number" ? envelope.error.code : null;
            rejectRequest(new Error(`${method} failed${code === null ? "" : ` (${code})`}: ${message}`));
            return;
          }
          resolveRequest(envelope.result);
        });
        try {
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (err) {
          pending.delete(id);
          rejectRequest(err instanceof Error ? err : new Error(String(err)));
        }
      });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) {
        finish({ defaultModel: null, providers: [] }, "output exceeded line budget");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) dispatch(line);
        newline = buffer.indexOf("\n");
      }
    });

    const dispatch = (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // 非 JSON 噪音（部分 CLI 会往 stdout 打日志）
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const record = parsed as Record<string, unknown>;
      const id = record.id;
      if (typeof id !== "number") return; // 通知/服务端请求，探测阶段一律忽略
      const handler = pending.get(id);
      if (!handler) return;
      pending.delete(id);
      handler(record);
    };

    child.on("error", (err: Error) => {
      finish({ defaultModel: null, providers: [] }, `spawn failed: ${err.message}`);
    });
    child.on("close", () => {
      if (settled) return;
      const msg = buffer.trim();
      if (msg) dispatch(msg);
      finish({ defaultModel: null, providers: [] }, "process exited before session/new completed");
    });

    void (async () => {
      try {
        await request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "agentsbb-model-discovery", version: "0.1.0" },
          clientCapabilities: {},
        });
        const session = await request("session/new", { cwd: cwd ?? tmpdir(), mcpServers: [] });
        const parsed = parseAcpSessionModels(session, spec.providerFallback);
        if (!parsed) {
          finish(
            { defaultModel: null, providers: [] },
            "session/new carried no model catalog",
          );
          return;
        }
        finish(catalogFromAcpRoutes(parsed.routes, parsed.defaultRoute));
      } catch (err) {
        finish(
          { defaultModel: null, providers: [] },
          `handshake failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  });
}
