import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 「这台 agent 的默认对话模型」。
//
// 与 user-models.ts 的 per-user 偏好是两件事，别合并：
//   · per-user（`/use-model`）：**某个人**在私聊里临时换的模型，换个人不生效；
//   · 本文件：**主人给这台 agent 定下的长期默认模型**，通讯录 → 智能体详情 →
//     「默认模型」写的就是它，对群聊 / 单聊 / 讨论组**一视同仁**。
//
// 修的是什么：面板以前只把值存进浏览器 localStorage，再由 web 在「打开与该设备
// 的单聊」时补发一条 `/use-model`。于是
//   1. 换浏览器 / 清缓存 / 换台电脑就没了；
//   2. 群聊和讨论组的轮次由服务端派发，根本不经过那条补发，用户设了模型却看不到
//      任何变化 —— 这才是「设置默认模型好像无用」的真身。
// 落盘到设备端之后，run.ts 在「本轮没显式指定模型」时用它兜底，三条路径共用。
//
// 优先级（从高到低，见 run.ts 的注释）：
//   本轮显式 model（服务端角色模型 / per-user） > `run --model` > 本文件的默认
//   > agent CLI 自己的配置。
//
// 文件名带 nodeId：supervisor 一个 agent 一个子进程，但共用同一个 home；不分文件
// 就有多进程互相覆盖的风险（与 user-models / processed-uids 同一处理方式）。
export function defaultAgentModelPath(nodeId?: string): string {
  const suffix = nodeId ? `-${nodeId.replace(/[^A-Za-z0-9._-]/g, "_")}` : "";
  return join(homedir(), ".clawmessenger", `agent-default-model${suffix}.json`);
}

/** `provider/model` 路由：与 web 的 segment() 判据同源（非空、无空白、恰好一个斜杠）。 */
export function isModelRoute(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 256) return false;
  if (/\s/.test(value)) return false;
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

export interface AgentDefaultModelStore {
  /** 已设置的默认模型；undefined = 没设过（跟随 agent CLI 自身配置）。 */
  get(): string | undefined;
  /** route 传 null 表示清除，恢复 agent CLI 自身默认。 */
  set(route: string | null): void;
}

/** 内存实现：测试与「没有可写 home」的降级路径用。 */
export class MemoryAgentDefaultModelStore implements AgentDefaultModelStore {
  private value: string | undefined;

  constructor(initial: string | null = null) {
    if (isModelRoute(initial)) this.value = initial;
  }

  get(): string | undefined {
    return this.value;
  }

  set(route: string | null): void {
    if (route === null || !route.trim() || !isModelRoute(route.trim())) {
      this.value = undefined;
      return;
    }
    this.value = route.trim();
  }
}

export class FileAgentDefaultModelStore implements AgentDefaultModelStore {
  // 懒加载 + 缓存：阅读发生在每一轮轮次上（热路径），写是低频操作且同步落盘，
  // 所以缓存永远与磁盘一致。
  private cache: string | null | undefined;

  constructor(private readonly path: string) {}

  private load(): string | null {
    if (this.cache !== undefined) return this.cache;
    let parsed: unknown = null;
    try {
      if (existsSync(this.path)) parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // 半截 JSON / 手工改坏：当作没设过。绝不能抛 —— 抛了等于「文件坏过一次，
      // 这台 agent 的默认模型永久报错」，而它只是偏好，不该有这个权力。
      parsed = null;
    }
    const model = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).model
      : null;
    this.cache = isModelRoute(model) ? model : null;
    return this.cache;
  }

  get(): string | undefined {
    const model = this.load();
    return model ?? undefined;
  }

  set(route: string | null): void {
    const trimmed = route === null ? "" : route.trim();
    const next = isModelRoute(trimmed) ? trimmed : null;
    this.cache = next;
    this.persist(next);
  }

  private persist(model: string | null): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // 先写临时文件再 rename：直接覆盖时若进程正好被杀，会留下半截 JSON。
      const tmp = `${this.path}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify(model ? { model } : {}, null, 2),
        { mode: 0o600 },
      );
      renameSync(tmp, this.path);
    } catch {
      // 只读 home / 磁盘满：内存里已经生效（本轮及之后都用新模型），只是重启后
      // 回退到 agent CLI 自身默认。不能因为落盘失败就打断保存流程。
    }
  }
}
