// 单聊「二次确认」的共享协议：权限确认(permission) + 选项提问(question)。
//
// 两条回灌语义，刻意分开：
//   · permission —— agent 在跑，卡在 ACP/headless 的权限请求上，必须把用户的
//     选择映射回协议 optionId / control_response 才能让 agent 继续（真·暂停）；
//   · question  —— agent 用文本标记抛出一个选择题，本轮答完即止，用户选项作为
//     **新一轮用户输入**续流（与 OpenClaw 插件 question_asked 同语义）。
//
// 两者共用这里的请求/应答类型与卡片构造，web 端 AiCommandCard 的
// permission/question section 是现成消费方（types/chat.ts:173-245）。

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionChoice {
  /** 回给 agent 的真实 optionId（必须来自它给的 options，编造会被判拒绝）。 */
  optionId: string;
  label: string;
  reply: PermissionReply;
}

export interface PermissionInteractionRequest {
  kind: "permission";
  /** 卡片回灌键 = ACP 的 request id（字符串化）。 */
  permissionId: string;
  /** 请求权限的动作描述（工具名 / 命令 / 路径），来自 agent。 */
  permission: string;
  /** agent 给的原始选项映射成前端三按钮。 */
  choices: PermissionChoice[];
  /** 发起轮次的单聊用户 id，回灌时校验身份。 */
  requesterId: string;
  /** 会话键，防止跨会话回灌。 */
  sessionKey: string;
}

export interface QuestionInteractionRequest {
  kind: "question";
  questionId: string;
  question: string;
  options: string[];
  multiple: boolean;
  requesterId: string;
  sessionKey: string;
}

export type InteractionRequest = PermissionInteractionRequest | QuestionInteractionRequest;

export type InteractionReply =
  | { kind: "permission"; reply: PermissionReply }
  | { kind: "question"; value: string[] };

/** agent 侧把选择回写给它的函数：由 acp-turn / headless bridge 提供。 */
export type InteractionReplyFn = (reply: InteractionReply) => void;

export interface PendingInteraction {
  request: InteractionRequest;
  reply: InteractionReplyFn;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** 融云离线重放去重：已消费的交互不再二次回灌。 */
  consumed: boolean;
  /**
   * permission 的回灌方式：
   *  - protocol：ACP 真协议，选择映射回 optionId 写回阻塞中的 agent；
   *  - soft：headless 降级，选择作为新一轮用户输入续流。
   */
  permissionMode?: "protocol" | "soft";
}

// ---- 指令层软确认协议（headless agent 无双向控制通道时的降级方案） --------

/**
 * 注入私聊 behaviorPrompt 的指令：让 agent 在执行不可逆/敏感操作前主动输出
 * permission 标记并停下来。headless 的 -p/exec/run 一次性调用没有 stdin 双向
 * 通道，无法像 ACP 那样在协议层阻塞等待；这是唯一对所有 headless agent 都
 * 生效、且不依赖真机抓包各家控制协议的方案。
 */
export const PERMISSION_PROTOCOL_INSTRUCTION = [
  "【操作确认协议】",
  "当你准备执行删除文件、发送消息、支付、修改系统设置或其它不可逆/敏感操作时，",
  "不要直接执行；先在回复末尾另起一段输出如下标记，然后停止本轮（不要继续执行该操作）：",
  '[interaction:permission] {"permission":"用一句话说明你要执行的操作","options":[{"reply":"once","label":"允许一次"},{"reply":"always","label":"始终允许"},{"reply":"reject","label":"拒绝"}]} [/interaction]',
  "用户选择后会把决定作为新消息发给你：若允许则继续执行该操作，若拒绝则取消并说明。",
  "",
  "【提问协议】",
  "设备端没有交互界面：绝对不要调用内置的 question / ask_user 交互工具（调用后没有任何人能回答，会永久卡住）。",
  "需要让用户从选项里做选择时，直接在回复末尾另起一段输出如下标记并停止本轮：",
  '[interaction:question] {"question":"一句话说明要问什么","options":["选项一","选项二"],"multiple":false} [/interaction]',
  "用户选择后会作为新消息发给你，届时再按用户的选择继续；不要为了等答案而调用任何工具。",
].join("\n");

const PERMISSION_MARKER_RE = /\[interaction:permission\]\s*([\s\S]*?)\s*\[\/interaction\]/g;

export interface ParsedPermission {
  permission: string;
  choices: Array<{ optionId: string; label: string; reply: "once" | "always" | "reject" }>;
}

/** 从正文解析 headless 的 permission 软确认标记。坏标记静默跳过。 */
export function parsePermissionMarkers(text: string): ParsedPermission[] {
  if (!text) return [];
  const out: ParsedPermission[] = [];
  let match: RegExpExecArray | null;
  PERMISSION_MARKER_RE.lastIndex = 0;
  while ((match = PERMISSION_MARKER_RE.exec(text)) !== null) {
    try {
      const raw = JSON.parse(match[1] ?? "") as Record<string, unknown>;
      const permission = typeof raw.permission === "string" ? raw.permission.trim() : "";
      const rawOptions = Array.isArray(raw.options) ? raw.options : [];
      const choices = rawOptions
        .map((item) => {
          const o = item as Record<string, unknown>;
          const reply = typeof o.reply === "string" ? o.reply.trim() : "";
          if (reply !== "once" && reply !== "always" && reply !== "reject") return null;
          const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : reply;
          // optionId 就用 reply：软确认没有真实协议 id，回灌时按 reply 续流。
          return { optionId: reply, label, reply };
        })
        .filter((c): c is { optionId: string; label: string; reply: "once" | "always" | "reject" } => c !== null);
      if (!permission || choices.length === 0) continue;
      out.push({ permission, choices });
    } catch {
      // 坏标记：跳过。
    }
  }
  return out;
}

/** 从正文剥掉 permission 标记，避免把协议原文上屏。 */
export function stripPermissionMarkers(text: string): string {
  return text.replace(PERMISSION_MARKER_RE, "").trim();
}

// ---- 选项提问的文本标记协议 ------------------------------------------------

const QUESTION_MARKER_RE = /\[interaction:question\]\s*([\s\S]*?)\s*\[\/interaction\]/g;

export interface ParsedQuestion {
  questionId: string;
  question: string;
  options: string[];
  multiple: boolean;
}

/**
 * 从 agent 正文里解析 `[interaction:question] {json} [/interaction]` 标记。
 * JSON 字段：questionId?（缺省生成）、question、options、multiple?。
 * 解析失败的块静默跳过 —— 绝不能因为一个坏标记把正常回答吞掉。
 */
export function parseQuestionMarkers(text: string): ParsedQuestion[] {
  if (!text) return [];
  const out: ParsedQuestion[] = [];
  let match: RegExpExecArray | null;
  QUESTION_MARKER_RE.lastIndex = 0;
  while ((match = QUESTION_MARKER_RE.exec(text)) !== null) {
    try {
      const raw = JSON.parse(match[1] ?? "") as Record<string, unknown>;
      const question = typeof raw.question === "string" ? raw.question.trim() : "";
      const options = Array.isArray(raw.options)
        ? raw.options.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
        : [];
      if (!question || options.length === 0) continue;
      out.push({
        questionId: typeof raw.questionId === "string" && raw.questionId.trim()
          ? raw.questionId.trim()
          : `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        question,
        options,
        multiple: raw.multiple === true,
      });
    } catch {
      // 坏标记：跳过。
    }
  }
  return out;
}

/** 从正文里剥掉 question 标记块，避免把协议原文上屏给用户。 */
export function stripQuestionMarkers(text: string): string {
  return text.replace(QUESTION_MARKER_RE, "").trim();
}

/**
 * 解析 agent 原生 question / ask_user 工具的入参（headless 下它会挂着等 TUI，
 * 永远等不到答案）。兼容两种常见形状：
 *   {"questions":[{"question":"...","options":[{"label":"A"},"B"],"multiple":false}]}
 *   {"question":"...","options":["A","B"],"multiple":false}
 * 解析不出来返回空数组 —— 宁可不发卡片，也不发一张点不动的假卡片。
 */
export function parseNativeQuestionToolInput(raw: string | undefined): ParsedQuestion[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const root = parsed as Record<string, unknown>;
  const candidates = Array.isArray(root.questions)
    ? root.questions
    : (typeof root.question === "string" ? [root] : []);
  const out: ParsedQuestion[] = [];
  for (const candidate of candidates) {
    const item = candidate as Record<string, unknown>;
    const question = typeof item.question === "string"
      ? item.question.trim()
      : (typeof item.header === "string" ? item.header.trim() : "");
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options = rawOptions
      .map((option) => {
        if (typeof option === "string") return option.trim();
        const record = option as Record<string, unknown>;
        return typeof record.label === "string" ? record.label.trim() : "";
      })
      .filter((label) => label.length > 0);
    if (!question || options.length === 0) continue;
    out.push({
      questionId: `native-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      question,
      options,
      multiple: item.multiple === true,
    });
  }
  return out;
}

// ---- 卡片构造 --------------------------------------------------------------

export interface InteractionCardShape {
  schema: string;
  id: string;
  header: { title: string; icon: string };
  sections: Array<Record<string, unknown>>;
}

/** 权限确认卡片：三按钮 once/always/reject（web/uniapp 现成消费 kind:'permission'）。 */
export function buildPermissionCard(req: PermissionInteractionRequest): InteractionCardShape {
  const buttons = req.choices.map((choice) => ({
    id: `perm_${choice.reply}`,
    label: choice.label,
    variant: choice.reply === "reject" ? "danger" : choice.reply === "always" ? "default" : "primary",
    action: { type: "permission", permissionId: req.permissionId, reply: choice.reply },
  }));
  return {
    schema: "1.0.0",
    id: req.permissionId,
    header: { title: "需要你的确认", icon: "?" },
    sections: [
      { kind: "markdown", content: req.permission || "智能体请求执行一个操作，请确认。" },
      {
        kind: "permission",
        permissionId: req.permissionId,
        permission: req.permission,
        buttons,
      },
    ],
  };
}

/** 选项提问卡片（web/uniapp 现成消费 kind:'question'）。 */
export function buildQuestionCard(req: QuestionInteractionRequest): InteractionCardShape {
  return {
    schema: "1.0.0",
    id: req.questionId,
    header: { title: "请你选择", icon: "?" },
    sections: [
      { kind: "markdown", content: req.question },
      {
        kind: "question",
        questionId: req.questionId,
        question: req.question,
        options: req.options.map((label) => ({ label })),
        multiple: req.multiple,
      },
    ],
  };
}

/** 把 agent 给的 ACP options 映射成三按钮 choice；返回 null 表示没有可用选项。 */
export function mapAcpOptionsToChoices(options: ReadonlyArray<{ optionId: string; kind: string }>): PermissionChoice[] | null {
  const kindOf = (o: { kind: string }) => o.kind.trim().toLowerCase();
  const find = (kind: string) => options.find((o) => kindOf(o) === kind);
  const once = find("allow_once");
  const always = find("allow_always") ?? options.find((o) =>
    ["allow_session", "approve_for_session"].includes(o.optionId));
  const reject = find("reject_once");
  const choices: PermissionChoice[] = [];
  if (once) choices.push({ optionId: once.optionId, label: "允许一次", reply: "once" });
  if (always) choices.push({ optionId: always.optionId, label: "始终允许", reply: "always" });
  if (reject) choices.push({ optionId: reject.optionId, label: "拒绝", reply: "reject" });
  return choices.length > 0 ? choices : null;
}

/** 把用户的 permission reply 映射回 agent 给的 optionId。 */
export function resolvePermissionOptionId(choices: ReadonlyArray<PermissionChoice>, reply: PermissionReply): string | null {
  return choices.find((c) => c.reply === reply)?.optionId ?? null;
}
