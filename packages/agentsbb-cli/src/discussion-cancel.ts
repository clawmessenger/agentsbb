/**
 * 服务端「停止讨论」的下行指令：`discussion_cancel`。
 *
 * 通道与 your_turn 相同：服务端系统账号给正在跑的节点**私发一条 objectName
 * 为 `command` 的消息**，但内容**不是** `{request_id, service, action}` 那个
 * 命令信封，而是 `msg_type` 判别的一族 v2/v3 协议包。因此它必须在
 * `decodeCommandContent` 之前被认出来 —— 否则 `decodeCommandContent` 返回 null，
 * 整条消息被静默丢弃，设备上那一轮 agent 继续跑到自己结束：用户点了「停止
 * 讨论」，界面上已停止，后台还在烧 token，稍后又把半截回答补进房间
 * （QA4-DEF-07 现场）。
 *
 * 两种信封都要认（服务端两条路径并存）：
 *   - v2（discussion_runtime.go 的 notifyCancelSafe）：扁平字段
 *     `{msg_type, protocolVersion:2, discussionId, chatroomId, requestId,
 *       stateVersion, round, timestamp, reason}`，**没有** targetRequestId /
 *       targetMemberId —— 只能按 chatroomId 找本地在飞的轮次；
 *   - v3（讨论交互轮）：多带 `targetRequestId` / `targetMemberId`，可以精确
 *     命中某一轮，避免把同房间别的节点/别的轮次一起掐掉。
 *
 * 回执 `discussion_cancel_ack` 是 v3 契约（web `lib/discussion-v3.ts` 里已有
 * 对应类型）。服务端目前只在日志层面消费它，但同一份回执在 v3 交互链路里是
 * 「节点已确认中断」的唯一凭据，所以两种情况都发：v2 信封缺的身份字段用通知
 * 自身的 requestId / 本地命中的轮次补上，宁可多一字段也不回一个残缺包。
 */

/** 一行 `discussion_cancel` 的解析结果；字段名与线上 JSON 逐字对应。 */
export interface DiscussionCancelRequest {
  /** 协议版本：服务端 v2 缺省 2，v3 交互轮为 3。 */
  protocolVersion: number;
  /** 讨论 id（v2 有，v3 有；缺省空串，只用于日志与回执回填）。 */
  discussionId: string;
  /** 房间（聊天室）id —— 本地在飞轮次的 conversationId 就是它。 */
  chatroomId: string;
  /** 通知自身的 requestId（回执的 requestId 用它，保持一条链路同一 id）。 */
  requestId: string;
  /** v3 才有：被取消的那一轮 request_id。 */
  targetRequestId: string;
  /** v3 才有：被取消的成员（融云 id）。 */
  targetMemberId: string;
  stateVersion: number;
  round: number;
  roundRevision: number;
  timestamp: number;
  reason: string;
}

/** 回执结果，与 web `CancelResult` 取值逐字一致。 */
export type DiscussionCancelResult = "cancelled" | "already_terminal" | "not_started" | "failed";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 认出 `discussion_cancel`，不是就返回 null。
 *
 * 只认 `msg_type` 这一个判别位：服务端 v2 与 v3 都用它，且这两个版本里
 * `protocolVersion` 分别是 2 / 3，光看版本号会把 v2 漏掉。
 */
export function parseDiscussionCancelRequest(raw: string): DiscussionCancelRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const c = parsed as Record<string, unknown>;
  if (asString(c.msg_type) !== "discussion_cancel") return null;
  return {
    protocolVersion: asNumber(c.protocolVersion) || 2,
    discussionId: asString(c.discussionId),
    chatroomId: asString(c.chatroomId),
    requestId: asString(c.requestId),
    targetRequestId: asString(c.targetRequestId),
    targetMemberId: asString(c.targetMemberId),
    stateVersion: asNumber(c.stateVersion),
    round: asNumber(c.round),
    roundRevision: asNumber(c.roundRevision),
    timestamp: asNumber(c.timestamp),
    reason: asString(c.reason) || "cancelled",
  };
}

/**
 * 生成 `discussion_cancel_ack`。
 *
 * targetRequestId 的取值顺序是「通知里带的 → 本地实际被掐掉的那一轮 →
 * 空串」：v2 信封没有这个字段，而回执不带它就等于只说了一句「收到」，
 * 服务端无从判断停的是哪一轮。
 */
export function buildDiscussionCancelAck(
  request: DiscussionCancelRequest,
  options: {
    /** 本节点融云 id：v2 信封没有 targetMemberId 时回填它。 */
    selfUserId?: string;
    /** 本地真正被中止的轮次 request_id（可能没有在飞轮次）。 */
    abortedRequestId?: string;
    result: DiscussionCancelResult;
    /** 回执自己的 requestId；缺省沿用通知的，保证同一链路同 id。 */
    requestId?: string;
    now?: number;
  },
): string {
  const targetRequestId = request.targetRequestId || options.abortedRequestId || "";
  const targetMemberId = request.targetMemberId || (options.selfUserId ?? "");
  return JSON.stringify({
    msg_type: "discussion_cancel_ack",
    protocolVersion: request.protocolVersion,
    discussionId: request.discussionId,
    chatroomId: request.chatroomId,
    requestId: options.requestId || request.requestId || `cancel-ack-${Date.now()}`,
    stateVersion: request.stateVersion,
    round: request.round,
    roundRevision: request.roundRevision,
    timestamp: options.now ?? Date.now(),
    targetRequestId,
    targetMemberId,
    result: options.result,
  });
}
