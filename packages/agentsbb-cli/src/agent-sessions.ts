import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateHome } from "./paths.js";

// 「会话形态 + 会话 id」→ agent 自己的会话 id。
//
// 要解决的问题：设备端每次派发都 spawn 一次 agent CLI，一次性跑完就退。除了
// openclaw（`--session-key` 自带会话桶），其余 agent 每次都从零开始 —— 同一个
// 群里聊了十句，它一句都不记得上一句，只能靠服务端拼进 prompt 的那点上下文
// 兜着。用户看到的就是「每句话都像换了个新对话」。
//
// 键就是 im.ts 的 turnSessionKey：`cm-<venue>-<conversationId>`。venue 分
// private / group / chatroom，所以：
//   · 同一个群，对不同 agent 各有各的会话（key 相同但存在不同节点的文件里）；
//   · 群聊、单聊、讨论组互不串台（venue 不同）。
//
// 值是该 agent 原生的会话 id（claude --resume / qwen -r / opencode -s ……），
// 由每轮的事件流带回来（见 agents.ts 的 StreamJsonDelta.sessionId）。
//
// 文件名带 nodeId：supervisor 一节点一子进程、共用同一个 home，不分文件就会
// 互相覆盖（与 user-models / agent-default-model 同一处理方式）。
export function defaultAgentSessionsPath(nodeId?: string): string {
  const suffix = nodeId ? `-${nodeId.replace(/[^A-Za-z0-9._-]/g, "_")}` : "";
  return join(stateHome(), `agent-sessions${suffix}.json`);
}

/** 只保留可安全塞进 argv 的 id：各家 id 都是 UUID/短横线串，出界一律丢掉。 */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export interface AgentSessionStore {
  /** 该会话键上次用过的 agent 会话 id；没跑过 / 已被清理时 undefined。 */
  get(sessionKey: string): string | undefined;
  set(sessionKey: string, sessionId: string): void;
  /** 会话失效（agent 说没有这个 id）：忘掉它，下一轮开新会话。 */
  clear(sessionKey: string): void;
  snapshot(): Record<string, string>;
}

/**
 * 判断一轮失败是不是「续接的会话 id 已经不存在了」。
 *
 * 各家 agent 自己的清理策略（保留天数、`--resume` 找不到目录）会让旧 id 失效，
 * 这时 CLI 是**直接非零退出**、这一轮什么都没答。不能就这么把错误抛给用户 ——
 * 一台设备在一个群里会永远带着同一个死 id 起步、每轮都失败。识别出来后清掉
 * 记录、当场用新会话重跑一次即可自愈。
 *
 * 只认各家确实会打的这几种原文，宁可漏判（那只是一轮报错）也不要误判把正常
 * 失败重跑两遍（会让 agent 重复干活）。
 */
export function isStaleSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!message) return false;
  // `no rollout found` 是 codex 0.144 的原话（实测：thread/resume 找不到该
  // thread 的 rollout 记录），不能漏 —— 漏了 codex 在群里会每轮都拿死 id 起步。
  return /no rollout found|no conversation found|no saved session|session (?:id )?(?:.* )?not found|not found.*session id|unknown session|invalid session|session .* (?:does not exist|has expired)/i
    .test(message);
}

export class MemoryAgentSessionStore implements AgentSessionStore {
  private table: Record<string, string>;

  constructor(initial: Record<string, string> = {}) {
    this.table = { ...initial };
  }

  get(sessionKey: string): string | undefined {
    return this.table[sessionKey];
  }

  set(sessionKey: string, sessionId: string): void {
    if (!sessionKey || !isSessionId(sessionId)) return;
    this.table[sessionKey] = sessionId;
  }

  clear(sessionKey: string): void {
    delete this.table[sessionKey];
  }

  snapshot(): Record<string, string> {
    return { ...this.table };
  }
}

export class FileAgentSessionStore implements AgentSessionStore {
  // 懒加载 + 缓存：每一轮都要读一次（热路径），写是低频同步落盘，缓存永远一致。
  private cache: Record<string, string> | null = null;

  constructor(private readonly path: string) {}

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    const table: Record<string, string> = {};
    let parsed: unknown = null;
    try {
      if (existsSync(this.path)) parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // 半截 JSON / 手工改坏：当空表处理。绝不能抛 —— 抛了等于「文件坏过一次，
      // 这台节点的会话续接永久报错」，而丢会话最多是「这轮从头开始」。
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isSessionId(value)) table[key] = value;
      }
    }
    this.cache = table;
    return table;
  }

  get(sessionKey: string): string | undefined {
    return this.load()[sessionKey];
  }

  set(sessionKey: string, sessionId: string): void {
    if (!sessionKey || !isSessionId(sessionId)) return;
    const table = this.load();
    if (table[sessionKey] === sessionId) return;
    table[sessionKey] = sessionId;
    this.persist(table);
  }

  clear(sessionKey: string): void {
    const table = this.load();
    if (!(sessionKey in table)) return;
    delete table[sessionKey];
    this.persist(table);
  }

  snapshot(): Record<string, string> {
    return { ...this.load() };
  }

  private persist(table: Record<string, string>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // 先写临时文件再 rename：直接覆盖时若进程正好被杀，会留下半截 JSON。
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // 只读 home / 磁盘满：内存里已经生效（本轮及之后仍能续上），只是重启后
      // 回退成新会话。不能因为落盘失败就打断这一轮。
    }
  }
}
