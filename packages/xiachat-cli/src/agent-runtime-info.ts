import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildSpawnInvocation, discoverAgents, type AgentInfo } from "./agents.js";
import { OPS_AGENT_NAME } from "./ops.js";

/**
 * 设备上各 agent CLI 的现场事实：可执行文件路径 + 自报版本。
 *
 * 为什么需要它：后台「设备详情」与移动端面板原来展示的 `install_dir` /
 * `exe_version` 是 **clawmessenger 自己**（supervisor）的安装目录与版本。运维
 * 真正要看的是「这台机器上的 codex / opencode 装的是哪个版本、在哪个目录」——
 * 出问题时要能直接去那个目录翻日志、换二进制，而不是看到一个无关的
 * `%LOCALAPPDATA%\clawmessenger`。
 *
 * 成本与缓存：版本号必须起一次 `<cli> --version` 子进程（qwen / codex 冷启动
 * 从几百毫秒到数秒不等），**绝不能放进 10 秒一轮的上报路径**。所以探测结果落盘
 * 缓存（`~/.clawmessenger/agent-cli-info.json`），默认 6 小时才重探一次；探测
 * 全程在后台跑，失败/超时只留空字段，不影响轮询与启停。
 */

/** 一个 agent 的 CLI 现场事实。字段为空串 = 探测不到（没装 / 超时 / 无版本输出）。 */
export interface AgentCliInfo {
  /** 逻辑 agent 键，与 observed 回执同口径（ops 而不是 opencode）。 */
  agent: string;
  /** 可执行文件绝对路径（Windows 上是 .exe/.cmd 的完整路径）。 */
  cliPath: string;
  /** CLI 自报版本（提取到的 semver；提不出来时是首行原文）。 */
  cliVersion: string;
}

/**
 * agent 键 → 真正执行的 CLI 命令名。
 *
 * 只有 ops 需要映射：它是内置运维智能体这个**身份**，跑的是 opencode 这个
 * 可执行文件（见 agents.ts 的 agentIdentity 说明）。其余 agent 的身份名就是
 * 命令名。
 */
export function agentCliCommand(agent: string): string {
  return agent === OPS_AGENT_NAME ? "opencode" : agent;
}

// CLI 版本输出的形态差异极大（`1.19.4` / `codex-cli 0.48.0` / `v0.25.3`），
// 统一只取第一个 semver。hint 用来在多行输出里优先挑「带自己名字」的那一行 ——
// 有的 CLI 会把 node 版本打在前面（`node v22.23.2` + `codex-cli 0.48.0`），
// 不挑行就会把 node 的版本当成 codex 的。
const SEMVER = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

/**
 * 从 `--version` 的原始输出里提取版本号。纯函数。
 *
 * 优先级：含 agent 名的那一行的 semver → 第一处 semver → 首行原文（截断）。
 * 兜底保留原文而不是返回空串：哪怕是不规范的版本串，也比「-」有用。
 */
export function parseCliVersion(raw: string, hint?: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  if (hint) {
    const needle = hint.toLowerCase();
    for (const line of lines) {
      if (!line.toLowerCase().includes(needle)) continue;
      const hit = line.match(SEMVER);
      if (hit) return hit[1];
    }
  }
  for (const line of lines) {
    const hit = line.match(SEMVER);
    if (hit) return hit[1];
  }
  return lines[0].slice(0, 48);
}

/** 缓存文件结构。`probedAt` 是毫秒时间戳，用来判 TTL。 */
export interface AgentCliInfoCache {
  version: 1;
  probedAt: number;
  agents: Record<string, { cliPath?: string; cliVersion?: string }>;
}

export function defaultAgentCliInfoPath(home = homedir()): string {
  return join(home, ".clawmessenger", "agent-cli-info.json");
}

/** 读缓存；缺失/损坏都返回 null（当作从没探过，不抛）。 */
export function readAgentCliInfoCache(path: string): AgentCliInfoCache | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as AgentCliInfoCache;
    if (!parsed || parsed.version !== 1 || typeof parsed.probedAt !== "number") return null;
    if (!parsed.agents || typeof parsed.agents !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 跑一次 `<cli> --version`，返回 stdout+stderr 合并文本。
 *
 * 不看退出码：一部分 CLI（openclaw / 某些包装脚本）`--version` 会以非 0 退出
 * 却仍把版本打进 stdout，用 runAgentCommand 那种「非 0 即彻底失败」的语义会
 * 白丢版本。超时直接 kill 进程树（Windows 上 .cmd shim 会多出一层 cmd.exe）。
 */
export function runVersionCommand(execPath: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const { file, args } = buildSpawnInvocation(execPath, ["--version"]);
    let child: ReturnType<typeof spawn>;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32" && child.pid !== undefined) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill();
        }
      } catch {
        // 杀不掉也不能让探测卡住：下面照样 resolve 已收集到的内容
      }
      finish(Buffer.concat(chunks).toString("utf8"));
    }, timeoutMs);
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      finish("");
      return;
    }
    child.stdout?.on("data", (buf: Buffer) => chunks.push(buf));
    child.stderr?.on("data", (buf: Buffer) => chunks.push(buf));
    child.on("error", () => finish(Buffer.concat(chunks).toString("utf8")));
    child.on("close", () => finish(Buffer.concat(chunks).toString("utf8")));
  });
}

export interface ProbeAgentCliInfoOpts {
  /** 要探测的逻辑 agent 键（与 observed 回执同口径）。 */
  agents: string[];
  home?: string;
  timeoutMs?: number;
  /** 依赖注入：测试里换掉真实 PATH 扫描 / 子进程。 */
  discover?: (opts: { extraPath?: string }) => Promise<AgentInfo[]>;
  runVersion?: (execPath: string, timeoutMs: number) => Promise<string>;
}

const DEFAULT_VERSION_TIMEOUT_MS = 6_000;

/**
 * 探测一批 agent 的 CLI 路径与版本（不做缓存判断，调用方负责）。
 *
 * 返回顺序与入参一致，探测不到的 agent 不出现（而不是塞一条空记录 —— 空记录
 * 会让调用方误以为「探过了，确实没版本」）。
 */
export async function probeAgentCliInfo(opts: ProbeAgentCliInfoOpts): Promise<AgentCliInfo[]> {
  const wanted = [...new Set(opts.agents.map((agent) => agent.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const discover = opts.discover ?? discoverAgents;
  const runVersion = opts.runVersion ?? runVersionCommand;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;

  let found: AgentInfo[] = [];
  try {
    found = await discover({});
  } catch {
    // PATH 扫不出来就等于「一个都找不到」，让每条都留空路径
  }
  const pathByCli = new Map(found.map((info) => [info.name, info.path]));

  // 并行探测：串行的话 5 个 agent × 6 秒超时会把后台刷新拖成一分钟。
  const results = await Promise.all(wanted.map(async (agent) => {
    const cli = agentCliCommand(agent);
    const cliPath = pathByCli.get(cli) ?? "";
    if (!cliPath) return null;
    let output = "";
    try {
      output = await runVersion(cliPath, timeoutMs);
    } catch {
      output = "";
    }
    return { agent, cliPath, cliVersion: parseCliVersion(output, cli) } satisfies AgentCliInfo;
  }));
  return results.filter((item): item is AgentCliInfo => item !== null);
}

/**
 * supervisor 侧用的探测器：内存快照 + 落盘缓存 + 后台刷新。
 *
 * `snapshot()` 永远同步返回（首次是空表），10 秒一轮的上报路径因此零阻塞；
 * `refresh()` 触发后台探测，TTL 内直接返回，正在探时不重入。这样即使某个
 * agent 的 `--version` 要 6 秒，也只影响「版本号晚几秒才有」，不影响启停与心跳。
 */
export class AgentCliInfoProbe {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly discover?: ProbeAgentCliInfoOpts["discover"];
  private readonly runVersion?: ProbeAgentCliInfoOpts["runVersion"];
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private cache: AgentCliInfoCache | null;
  private probing = false;

  constructor(opts: {
    home?: string;
    path?: string;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
    discover?: ProbeAgentCliInfoOpts["discover"];
    runVersion?: ProbeAgentCliInfoOpts["runVersion"];
    log?: (message: string) => void;
  } = {}) {
    this.path = opts.path ?? defaultAgentCliInfoPath(opts.home);
    this.ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
    this.discover = opts.discover;
    this.runVersion = opts.runVersion;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((message) => console.error(message));
    this.cache = readAgentCliInfoCache(this.path);
  }

  /** 当前已知的 CLI 事实（同步，可能滞后；首次为空表）。 */
  snapshot(): Map<string, AgentCliInfo> {
    const out = new Map<string, AgentCliInfo>();
    for (const [agent, entry] of Object.entries(this.cache?.agents ?? {})) {
      if (!entry.cliVersion) continue;
      out.set(agent, {
        agent,
        cliPath: entry.cliPath ?? "",
        cliVersion: entry.cliVersion,
      });
    }
    return out;
  }

  /** 缓存是否新鲜（TTL 内）。 */
  fresh(): boolean {
    return this.cache !== null && this.now() - this.cache.probedAt < this.ttlMs;
  }

  /**
   * 后台刷新一次（不 await）。TTL 内、或已在探测中时直接返回。
   *
   * agent 集合变了（新绑了一个 agent）时也应重探 —— 所以比较集合，不只是比时间。
   */
  refresh(agents: string[], opts: { force?: boolean } = {}): void {
    const wanted = [...new Set(agents.map((agent) => agent.trim()).filter(Boolean))];
    if (wanted.length === 0 || this.probing) return;
    const cached = this.cache?.agents ?? {};
    const missing = wanted.filter((agent) => !cached[agent]?.cliVersion);
    if (!opts.force && missing.length === 0 && this.fresh()) return;

    this.probing = true;
    void probeAgentCliInfo({
      agents: wanted,
      timeoutMs: this.timeoutMs,
      ...(this.discover ? { discover: this.discover } : {}),
      ...(this.runVersion ? { runVersion: this.runVersion } : {}),
    })
      .then((infos) => {
        const probedAt = this.now();
        // 逐键合并而不是整体覆盖：这次空手而归（`--version` 超时、PATH 抖动）
        // 的 agent 必须保留上一次探到的版本，否则页面上的版本号会在有/无之间闪。
        const mergedAgents: Record<string, { cliPath?: string; cliVersion?: string }> = {};
        for (const info of infos) {
          const prev = this.cache?.agents[info.agent];
          mergedAgents[info.agent] = {
            cliPath: info.cliPath || prev?.cliPath || "",
            cliVersion: info.cliVersion || prev?.cliVersion || "",
          };
        }
        // 本轮没探测到的键（比如临时从 PATH 上消失）也保留旧值：agent 还在绑定时
        // 页面宁可显示「上次看到的版本」也不要突然变成「-」。
        for (const [agent, prev] of Object.entries(this.cache?.agents ?? {})) {
          if (!(agent in mergedAgents)) mergedAgents[agent] = prev;
        }
        const merged: AgentCliInfoCache = { version: 1, probedAt, agents: mergedAgents };
        this.cache = merged;
        try {
          writeFileSync(this.path, JSON.stringify(merged, null, 2), "utf8");
        } catch (err) {
          this.log(`agent cli info: cache write failed (${err instanceof Error ? err.message : String(err)})`);
        }
      })
      .catch((err) => {
        this.log(`agent cli info: probe failed (${err instanceof Error ? err.message : String(err)})`);
      })
      .finally(() => {
        this.probing = false;
      });
  }
}

/** CLI 路径所在目录 —— 后台「安装目录」一栏展示的就是它。 */
export function cliInstallDir(cliPath: string): string {
  return cliPath ? dirname(cliPath) : "";
}
