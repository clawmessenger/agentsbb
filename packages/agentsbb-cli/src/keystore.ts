import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SERVER_URL } from "./config.js";

// Credentials are stored as JSON with 0600 permissions. On Windows the mode
// bit is advisory only (ACLs apply); the file still lives under the user
// profile. OS keychain integration is a future adapter.
export interface StoredCredentials {
  nodeId: string;
  token: string;
  credentialId?: string;
  deviceSecret?: string;
  appKey?: string;
  serverUrl: string;
}

/**
 * 已下线的主域名（裸 origin，不带路径）。
 *
 * 为什么留**清单**而不是只判一个字符串：`serverUrl` 是**持久化在用户机器上**的
 * 值，它由「当年那次 pair 用的 `--server`（或当年的 `DEFAULT_SERVER_URL`）」
 * 决定，所以磁盘里躺着的历史写法取决于这台机器是哪一代装的。换域名在项目里
 * 发生过不止一次（newsradar 子路径 → 独立域名），每次都会给存量机器留下一批
 * 旧值；代码里写死 `if (url === 上一个域名)` 等于「只迁上一代」，再换一次就漏。
 * 以后每下线一个域名，只往这个数组追加一行，判定逻辑不用动。
 *
 * 值必须是**裸 origin**（`scheme://host[:port]`）：带路径的历史值不自动迁移
 * （理由见 `planServerUrlMigration`），否则会把测试环境静默指到生产。
 */
export const LEGACY_SERVER_URLS: readonly string[] = [
  "https://clawmessenger.quukk.com",
  // 同一主机的 http 变体：DNS 已经切走，http 也只会解析失败 / 被跳到别处，
  // 迁到新域名的 https 严格更优，没有理由把它留在清单外。
  "http://clawmessenger.quukk.com",
];

/** 旧域名 → 新域名的迁移计划（纯数据，便于测试与复用）。 */
export interface ServerUrlMigration {
  /** 磁盘里读到的原值（未归一化，便于原样打日志）。 */
  from: string;
  /** 要写入的新值（裸 origin）。 */
  to: string;
}

/**
 * 归一化后再比较：去首尾空白、去尾部所有斜杠、转小写。
 *
 * 只用于**比较**，不用来回写：落盘永远写 `DEFAULT_SERVER_URL` 的原始形态，
 * 免得把 `https://AGENTS.QUUKK.COM` 这种东西固化进凭据。
 */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * 判断一条凭据要不要迁移，**不做任何 IO**。
 *
 * 规则：归一化后与 `LEGACY_SERVER_URLS` 中任意一条**逐字相等**才迁移。
 * 刻意不按「host 相同就迁」放行 —— 存量 `serverUrl` 可能带路径前缀
 * （`.../im-test` 这类测试环境），按 host 迁会把测试设备静默指到生产。
 * 漏迁最多是「这台机器还得手动 `--server`」，错迁是「连到错的环境查数据」，
 * 后者贵得多。带路径的旧值由 `warnLegacyServerUrlWithPath` 在 stderr 上点名。
 */
export function planServerUrlMigration(
  creds: { serverUrl?: string } | null | undefined,
  target: string = DEFAULT_SERVER_URL,
): ServerUrlMigration | null {
  const current = creds?.serverUrl;
  // 老版本 / 手工改坏的凭据可能没有 serverUrl：没有值就没有「旧域名」可谈。
  if (typeof current !== "string" || current.trim() === "") return null;
  const normalized = normalizeServerUrl(current);
  const isLegacy = LEGACY_SERVER_URLS.some((legacy) => normalizeServerUrl(legacy) === normalized);
  if (!isLegacy) return null;
  const to = normalizeServerUrl(target);
  // 清单与目标重合这种理论情况：不迁移，避免无意义写盘。
  if (normalized === to) return null;
  return { from: current, to };
}

/**
 * 迁移提示只走 **stderr**。
 *
 * stdout 有协议语义（`--version` / `agents` / `pair` 的输出会被脚本与提示词
 * 解析，`pair` 还要从 stdout 里抠授权链接），多一行就多一次解析失败的机会。
 */
export function reportServerUrlMigration(plan: ServerUrlMigration): void {
  process.stderr.write(`migrated server: ${plan.from} -> ${plan.to}\n`);
}

/** 旧域名带路径前缀（如 `/im-test`）时点名警告：不迁移，但不许静默。 */
function warnLegacyServerUrlWithPath(current: string): void {
  const lowered = normalizeServerUrl(current);
  // 先按「清单里的 origin + /」前缀判断，避免 http/https 混判。
  const onLegacyHost = LEGACY_SERVER_URLS.some((legacy) => lowered.startsWith(`${normalizeServerUrl(legacy)}/`));
  if (!onLegacyHost) return;
  process.stderr.write(
    `warning: server url ${current} points at a retired host and carries a path prefix; `
      + "not auto-migrated (a stale prefix would silently retarget the environment). "
      + `re-run with --server ${DEFAULT_SERVER_URL} if this device should follow the new domain.\n`,
  );
}

/**
 * 把凭据里的旧主域名换成新域名（**纯内存**，不落盘）。
 *
 * 命中旧域名时返回**新对象**并打一行 stderr；否则**原样返回同一个引用**
 * （调用方可用 `!==` 判断「有没有迁移」，`Keystore.load` 就是这么做的）。
 *
 * 用于两条读凭据的链路：
 *   ① `Keystore.load()` —— 磁盘凭据，迁移后持久化；
 *   ② `main.ts` 里从 `AGENTSBB_AGENT_CREDS` 解析出来的环境凭据 ——
 *      supervisor 派生的子进程带着它、**不经过 keystore**，必须同样归一化，
 *      否则升级后子进程仍拿旧域名连。
 */
export function migrateServerUrl<T extends { serverUrl?: string }>(
  creds: T,
  target: string = DEFAULT_SERVER_URL,
): T {
  const plan = planServerUrlMigration(creds, target);
  if (!plan) {
    if (typeof creds.serverUrl === "string") warnLegacyServerUrlWithPath(creds.serverUrl);
    return creds;
  }
  reportServerUrlMigration(plan);
  return { ...creds, serverUrl: plan.to } as T;
}

export class Keystore {
  constructor(private readonly path: string) {}

  /**
   * 读凭据，顺手把旧主域名就地迁到新域名。
   *
   * 迁移点选在这里，因为它是**所有从磁盘拿凭据的入口**：`login` / `agent` /
   * `run` / `status` / 自更新意图探测全部走它，`creds.serverUrl` 的每个消费者
   * 拿到的都已经是新域名 —— 不必在一个个命令里各写一遍（那种写法一定会漏）。
   * 环境凭据那条旁路不经过本方法，由 `main.ts` 调 `migrateServerUrl` 兜住。
   *
   * 三条硬约束：
   *   · **幂等**：已是新域名/自定义地址时原样返回，不写盘、不打日志；
   *   · **不阻塞启动**：写盘失败只降级成「本次内存里用新域名」，绝不抛；
   *   · 只有命中旧域名清单才动手，自定义 `--server` 一律不碰。
   */
  load(): StoredCredentials | null {
    if (!existsSync(this.path)) return null;
    let parsed: StoredCredentials;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredCredentials;
    } catch {
      return null;
    }
    const migrated = migrateServerUrl(parsed);
    if (migrated === parsed) return parsed;
    try {
      this.save(migrated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 只读介质、磁盘满、权限被改坏……都不该让设备起不来：本次用新域名跑，
      // 下次启动再试一次（迁移幂等，重试无副作用）。
      process.stderr.write(
        `warning: could not persist migrated server url (${message}); `
          + `continuing with ${migrated.serverUrl} for this run\n`,
      );
    }
    return migrated;
  }

  save(creds: StoredCredentials): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(creds, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows: chmod is a no-op; ACLs govern access.
    }
  }
}
