import { encodeCommandResult, type CommandContent } from "./protocol.js";

// Protocol v1 discussion-title responder. The server's NodeRequestBroker sends
// this node a `command` message on the shared envelope:
//   { request_id, service: "discussion", action: "summarize_title",
//     params: { topic, goal?, model?, timeout_seconds?, timestamp } }
// and waits (up to a short timeout) for a command_result carrying
// `payload.title` — a one-sentence title of at most 10 Chinese characters.
//
// Same shape and same lean agent turn as role-recommend.ts, but deliberately
// smaller: a title is a nicety for the conversation list, not the discussion
// content itself, so it must never hold up group creation.
//
// Old CLIs ignore an unknown action, so a server running this protocol against
// an older device simply times out and falls back to the truncated-topic name.

export const SUMMARIZE_TITLE_ACTION = "summarize_title";
export const SUMMARIZE_TITLE_PROTOCOL_VERSION = "v1";

/** 产品口径：标题最多 10 个中文字（标点也算一个字）。 */
export const TITLE_MAX_CHARS = 10;
/** 本地拒收闸门：超过这个长度判定模型答非所问。 */
export const TITLE_MAX_RAW_CHARS = 120;

/** 标题回合在设备端的兜底超时；服务端下发 timeout_seconds 时以它为准。 */
export const TITLE_TURN_TIMEOUT_MS = 20_000;
const TITLE_REPLY_MARGIN_MS = 3_000;
const TITLE_TURN_TIMEOUT_MAX_MS = 60_000;

export function titleTurnTimeoutMs(timeoutSeconds: unknown): number {
  const seconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) ? timeoutSeconds : 0;
  if (seconds <= 0) return TITLE_TURN_TIMEOUT_MS;
  const budget = seconds * 1000 - TITLE_REPLY_MARGIN_MS;
  return Math.min(Math.max(budget, 5_000), TITLE_TURN_TIMEOUT_MAX_MS);
}

export interface TitleSummarizeRequest {
  requestId: string;
  topic: string;
  goal: string;
  model?: string;
  timeoutMs?: number;
  timestamp?: number;
}

/** Strictly parses the inbound request; null means "not ours / not valid". */
export function parseTitleSummarizeRequest(cmd: CommandContent): TitleSummarizeRequest | null {
  const params = (cmd.params ?? {}) as Record<string, unknown>;
  if (typeof params.topic !== "string" || !params.topic.trim()) return null;
  const rawModel = typeof params.model === "string" ? params.model.trim() : "";
  const timestamp =
    typeof params.timestamp === "number" && Number.isFinite(params.timestamp)
      ? params.timestamp
      : undefined;
  return {
    requestId: cmd.request_id,
    topic: params.topic,
    goal: typeof params.goal === "string" ? params.goal : "",
    model: rawModel || undefined,
    timeoutMs: titleTurnTimeoutMs(params.timeout_seconds),
    timestamp,
  };
}

/** A replay older than this can no longer reach a waiter — ignore it. */
export const STALE_TITLE_SUMMARIZE_REQUEST_MS = 10 * 60 * 1000;

/** The prompt: ask for one short line, no labels, no punctuation. */
export function buildTitleSummarizePrompt(request: TitleSummarizeRequest): string {
  return [
    "为下面这个多智能体讨论组起一个简短标题，用作会话列表里的名字。",
    "",
    `议题：${request.topic}`,
    request.goal.trim() ? `目标：${request.goal.trim()}` : "",
    "",
    `要求：只输出标题本身，不超过 ${TITLE_MAX_CHARS} 个中文字（标点也算一个字）；不要引号、不要书名号、不要结尾标点、不要「标题：」之类的前缀、不要解释。`,
    "标题要能让人一眼认出这场讨论在聊什么，直接用议题里的核心词。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Sanitizes the raw model output into a single usable title, or null. */
export function parseTitleOutput(output: string): string | null {
  let text = output.trim();
  if (!text) return null;
  // 只取第一行；多行的后半段是说明，不是标题。
  text = text.split(/\r?\n/)[0].trim();
  // 先去结尾标点，再剥包裹符号（否则「《标题》。」的句号会挡住书名号）。
  for (let i = 0; i < 3; i += 1) {
    const cleaned = text
      .replace(/[，。！？、；：,.!?;:\s]+$/, "")
      .replace(/^["'“”‘’「」『』《》*_`#\s]+/, "")
      .replace(/["'“”‘’「」『』《》*_`#\s]+$/, "")
      .trim();
    if (cleaned === text) break;
    text = cleaned;
  }
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length === 0 || chars.length > TITLE_MAX_RAW_CHARS) return null;
  if (chars.length > TITLE_MAX_CHARS) return chars.slice(0, TITLE_MAX_CHARS).join("");
  return text;
}

export function buildTitleSummarizeResponse(
  requestId: string,
  title: string,
  elapsedMs?: number,
): string {
  return encodeCommandResult(
    requestId,
    "text",
    elapsedMs === undefined ? { title } : { title, elapsed_ms: elapsedMs },
  );
}

export function buildTitleSummarizeError(
  requestId: string,
  message: string,
  elapsedMs?: number,
): string {
  return encodeCommandResult(
    requestId,
    "error",
    elapsedMs === undefined ? { error: message } : { error: message, elapsed_ms: elapsedMs },
  );
}
