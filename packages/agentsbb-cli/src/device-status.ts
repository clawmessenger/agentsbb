/**
 * 设备运行状态：`device_status_request` / `device_status_report`。
 *
 * 为什么需要这一对：web 与小程序「设备详情」页的四个面板（系统健康状态、
 * 会话列表、任务队列、命令控制）全部依赖它。agentsbb-cli 之前从未实现 ——
 * 2026-11-05 现场三端详情页固定等满 15 秒超时，再报一句「设备可能离线」，
 * 而设备其实一直在线（同一次现场：`agent-permissions.json` 正常、进程有
 * 融云 ESTABLISHED 连接、二进制里连 `device_status_request` 这个字符串都不存在）。
 *
 * 形状以 web 的 `services/im.ts` 为准（它是三端里最早实现的一方）：
 *   请求 `{ msg_type: 'device_status_request', request_id, ... }`
 *   响应 `{ msg_type: 'device_status_report', request_id, status, data }`
 * 应答**同时**给顶层 `data` 和字符串形式的 `content`：
 *   - web   `payload = asRecord(record.content) || asRecord(record.data) || record`
 *   - 小程序 `innerContent = JSON.parse(rawContent.content)` → resolve(innerContent)
 * 两边各取一处，少给一处就有一端拿不到数据（仍然是「面板空白」而不是报错，
 * 比超时更难查）。
 *
 * 只读协议：面板每展开一次就请求一次，**不写盘、不产生副作用**。
 */

/** 请求过久才到就跳过：重放一整批旧请求没有意义，还会把面板刷成过期数据。 */
export const STALE_DEVICE_STATUS_REQUEST_MS = 60_000;

export interface DeviceStatusRequest {
  requestId: string;
  /** 客户端发来的毫秒时间戳；老客户端可能不带。 */
  timestamp?: number;
}

export interface DeviceStatusSession {
  sessionKey: string;
  sessionId: string;
  label: string;
  state: "active" | "idle";
}

export interface DeviceStatusSnapshot {
  /** 设备端版本号（面板上显示为「OpenClaw版本」，沿用既有文案）。 */
  version: string;
  /** 本进程跑的 agent 名（codex / opencode / …），纯展示。 */
  agentName?: string;
  sessions?: DeviceStatusSession[];
  /** 面板的「系统健康状态」逐行渲染：key = 标签，value = 值。 */
  diagnostics?: Record<string, string | number>;
  /** 「任务队列」面板；CLI 侧暂无定时任务，回空数组让面板显示「暂无任务数据」。 */
  cronJobs?: Array<{ id?: string; name?: string; schedule?: string }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析状态请求。
 *
 * 判据只认 `msg_type` —— 这一条是刻意的：请求体本身是空对象 `{}`，没有
 * service/action，靠形状去猜会把它和讨论指令、`/use-model` 混在一起。
 * 老客户端（没带 msg_type 的小程序版本）继续走原来的超时，行为不回归。
 */
export function parseDeviceStatusRequest(content: unknown): DeviceStatusRequest | null {
  const raw = typeof content === "string" ? parseJson(content) : content;
  if (!record(raw)) return null;
  if (raw.msg_type !== "device_status_request") return null;
  const requestId = nonEmptyString(raw.request_id) || nonEmptyString(raw.requestId);
  if (!requestId) return null;
  const ts = raw.timestamp;
  const timestamp = typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
  return timestamp === undefined ? { requestId } : { requestId, timestamp };
}

/** 请求是否已过期（重放）。没有时间戳按「不过期」处理，宁可答一次。 */
export function isStaleDeviceStatusRequest(
  request: DeviceStatusRequest,
  now: number = Date.now(),
): boolean {
  if (request.timestamp === undefined) return false;
  // 客户端发的是**秒**（web/小程序都 `Math.floor(Date.now()/1000)`），
  // 小到 1e11 以下就按秒解释 —— 混用会导致 1970 年或 5 万年后，两种都会被判过期。
  const tsMs = request.timestamp < 1e11 ? request.timestamp * 1000 : request.timestamp;
  return now - tsMs > STALE_DEVICE_STATUS_REQUEST_MS;
}

/** 会话表（sessionKey → agent 会话 id）→ 面板的会话列表。 */
export function sessionsFromTable(table: Record<string, string>): DeviceStatusSession[] {  return Object.keys(table || {})
    .sort()
    .map((sessionKey) => ({
      sessionKey,
      sessionId: table[sessionKey],
      label: sessionKey,
      // 这里拿不到「正在跑」的实时状态：面板的活跃/闲置只影响一个标签色，
      // 与其猜错让用户以为还在生成，不如统一报闲置。
      state: "idle" as const,
    }));
}

/**
 * 面板「系统健康状态」的逐行内容。
 *
 * 只放**这台进程自己知道**的事实，别编：CPU 占用、磁盘剩余这类要采样或读系统
 * 计数器的指标，拿不到就干脆不出现 —— 面板上少一行，比显示一个常年 0% 的假
 * 进度条强。
 */
export function buildRuntimeDiagnostics(input: {
  pid: number;
  uptimeSec: number;
  rssBytes: number;
  agentName?: string;
  sessionCount: number;
}): Record<string, string> {
  const out: Record<string, string> = {
    "进程 PID": String(input.pid),
    "已运行": formatUptime(input.uptimeSec),
    "内存占用": formatMegabytes(input.rssBytes),
  };
  if (input.agentName) out["Agent"] = input.agentName;
  out["已登记会话"] = String(input.sessionCount);
  return out;
}

/** 秒 → `3 小时 12 分`（不足 1 分钟报秒，免得刚启动显示「0 分」）。 */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60) % 60;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟`;
  const hours = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  return `${hours} 小时 ${minutes} 分`;
}

/** 字节 → `184 MB`（< 1 GB 保留整数 MB，够看趋势，不必精确到小数）。 */
export function formatMegabytes(bytes: number): string {
  const mb = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * 构造应答。
 *
 * `clock` 可注入，测试里断言时间戳不需要假时钟库（与 model-catalog.ts 同风格）。
 */
export function buildDeviceStatusReport(
  request: DeviceStatusRequest,
  snapshot: DeviceStatusSnapshot,
  clock: () => number = Date.now,
): string {
  const data = {
    version: snapshot.version || "",
    agent: snapshot.agentName || null,
    diagnostics: snapshot.diagnostics || {},
    cron_jobs: snapshot.cronJobs || [],
    sessions: snapshot.sessions || [],
  };
  return JSON.stringify({
    msg_type: "device_status_report",
    request_id: request.requestId,
    timestamp: clock(),
    status: "success",
    // 顶层 data：web 的 payload 解析优先读它
    data,
    // 字符串 content：小程序的 device-rongyun-client 只读这一处
    content: JSON.stringify({ status: "success", data }),
  });
}
