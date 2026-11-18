// 「新开会话」指令：用户主动要求把这段对话的上下文清空、从新会话接着聊。
//
// 为什么需要它：设备端的会话是按「会话形态 + 会话 id」长期续接的 —— 同一个群、
// 同一个私聊对端会一直复用同一条 agent 会话。聊得久了上下文越来越长（token
// 成本上升、旧话题持续干扰新话题），用户却没有任何手段把这段记忆切断：
// web 端删会话只是删界面，服务端和 agent 两侧的记忆都还在。
//
// 匹配规则必须**整句**匹配、且短：用户真在聊「新开一个项目」时不能把这句话
// 当命令吞掉 —— 那等于把用户的原话丢了，还平白清掉上下文。
const NEW_SESSION_PATTERNS: RegExp[] = [
  // 中文口语：新开会话 / 重开会话 / 新开一个对话 / 开启新会话 / 另起一个聊天 …
  /^(?:新开|重开|另开|重新开|新建|开启|开始)(?:一个|个)?新?(?:会话|对话|聊天)$/,
  // 斜杠命令（web / 小程序输入框里更顺手）
  /^[\/／](?:new|reset|newchat|newsession)$/i,
  /^[\/／](?:新会话|新开会话|重置会话)$/,
];

/** 「新开会话」指令的最长长度：超过就不是命令，是正文。 */
const NEW_SESSION_MAX_LEN = 12;

export function isNewSessionCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > NEW_SESSION_MAX_LEN) return false;
  return NEW_SESSION_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * 指令回执。
 *
 * 说清两件事：① 现在开始是新会话；② 上一段并没有被删掉（用户问「刚才的记录还在
 * 吗」时有据可答）。不写「已清空历史」—— 那是假话，历史还在各端的记录里。
 */
export function newSessionAck(scope: "private" | "group" | "chatroom" | "discussion", agent: string): string {
  const where = scope === "private" ? "这个私聊"
    : scope === "group" ? "这个群"
    : scope === "discussion" ? "这个讨论组"
    : "这个聊天室";
  return `已为「${agent}」在${where}开启新会话：接下来这句起不再带之前的上下文，之前的聊天记录仍然保留在会话里。`;
}
