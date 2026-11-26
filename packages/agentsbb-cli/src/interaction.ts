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
