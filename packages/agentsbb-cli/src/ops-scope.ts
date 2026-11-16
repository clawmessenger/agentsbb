import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { stateHome } from "./paths.js";

/**
 * 机器级运维助手（ops）的「本轮运维对象」作用域。
 *
 * 背景：per-agent 运维账号（`<agentRC>_ops`）因为融云注册用户上限退役后，一台
 * 机器只剩一个 ops 账号、一个 ops 子进程，但用户依然是从「某个智能体的运维
 * 入口」进来的。融云私聊的对端是同一个账号，入口信息在 IM 层就丢了 —— 所以
 * 作用域不能像老方案那样由进程启动参数（AGENTSBB_OPS_SCOPE）决定，只能由
 * **本轮消息明确点名的智能体**决定。
 *
 * 三态（与提示词、命令层拦截共用同一份判定，避免两边漂移）：
 *   · 点名了恰好一个 → 锁定它：消息前注入 `【运维对象】X` 抬头，scope.json
 *     写入 X，命令层只放行 X；
 *   · 点名了多个 / 一个都没点名 → 不猜：scope 清空，提示词要求先反问用户，
 *     命令层拒绝一切启停（宁可多问一句，也不许「顺手挑一个」）。
 *
 * per-agent ops（未升级的设备）仍以环境变量 AGENTSBB_OPS_SCOPE 为准，不读
 * 这个文件 —— 见 main.ts 的 opsScope()。
 */

/** 本机绑定过的智能体名（不含 ops 自己）。 */
export function normalizeAgentNames(agents: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of agents) {
    const name = raw.trim();
    // ops 自己是运维端，不是可操作对象；空名和明显的节点键（带 @ 的
    // supervisor 键如 `ops@codex`）也排除。
    if (!name || name === "ops" || name.includes("@")) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * agent 名在自然语言里的匹配式。
 *
 * 用前后「非标识符字符」做边界，而不是 `\b`：agent 名里带 `-` 和 `_`（如
 * `qwen-paw`），`\b` 会在连字符处误判。同时忽略大小写 —— 用户写 OpenClaw
 * 与 openclaw 是同一件事。
 */
function mentionPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`, "i");
}

export interface OpsScopeResolution {
  /** 本轮唯一确定的对象（消息里点名的那一个 agent）。 */
  target?: string;
  /** 消息里同时点名了多个 agent —— 不能猜，必须反问。 */
  ambiguous: string[];
}

/**
 * 从用户消息里解析本轮运维对象。
 *
 * 只认「点名的 agent」，不做语义猜测：用户说「帮我看看为什么掉线」而没有
 * 名字时，返回空 —— 交给提示词反问，而不是让模型自己挑一个动手。
 */
export function resolveOpsScope(text: string, agents: readonly string[]): OpsScopeResolution {
  const names = normalizeAgentNames(agents);
  if (!text || names.length === 0) return { ambiguous: [] };
  const hits = names.filter((name) => mentionPattern(name).test(text));
  if (hits.length === 1) return { target: hits[0], ambiguous: [] };
  if (hits.length > 1) return { ambiguous: hits };
  return { ambiguous: [] };
}

/** scope.json 的位置：机器级 ops 的 workdir 根（per-agent 子目录里不放）。 */
export function opsScopeFile(home: string = stateHome()): string {
  return path.join(home, "ops", "scope.json");
}

/** 读当前作用域（同步：命令层在 CLI 子命令里直接调用）。 */
export function readOpsScopeSync(home: string = stateHome()): string {
  try {
    const raw = JSON.parse(readFileSync(opsScopeFile(home), "utf8")) as { scope?: unknown };
    return typeof raw.scope === "string" ? raw.scope.trim() : "";
  } catch {
    return "";
  }
}

/** 写当前作用域（空串 = 未锁定，下一次命令一律拦启停）。 */
export async function writeOpsScope(scope: string, home: string = stateHome()): Promise<void> {
  const file = opsScopeFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ scope: scope.trim(), updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * 本轮消息前注入的抬头。
 *
 * 为什么改消息而不是改 AGENTS.md：opencode 的会话在创建时就固定了 system
 * prompt，运行中重写 AGENTS.md 对已有会话不生效；而用户消息每轮都是新的，
 * 抬头跟着消息走才是「这一轮」的唯一可靠载体。
 */
export function opsScopeHeader(resolution: OpsScopeResolution, agents: readonly string[]): string {
  const names = normalizeAgentNames(agents);
  const list = names.length > 0 ? names.join("、") : "（未读到本机绑定列表）";
  if (resolution.target) {
    return `【运维对象】${resolution.target}\n（本轮只允许操作 ${resolution.target}。其他智能体一律不碰，也不许做整机批量动作。）`;
  }
  if (resolution.ambiguous.length > 0) {
    return `【运维对象】未确定 —— 消息里同时提到了 ${resolution.ambiguous.join("、")}\n`
      + `（不许猜。先问用户这一轮要操作哪一个，问清之前不执行任何操作。）`;
  }
  return `【运维对象】未指定 —— 本机可选：${list}\n`
    + "（不许自行选择，也不许「都检查一遍」。先用一句话问用户要操作哪一个智能体，"
    + "问清之前不执行任何操作。）";
}

/** 把抬头拼到用户消息前面；消息本身保持原样（用户看得到自己发的内容）。 */
export function withOpsScopeHeader(text: string, header: string): string {
  return `${header}\n\n${text}`;
}
