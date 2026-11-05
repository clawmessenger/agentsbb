import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 设备端向 agent 注入**输出形态约束**的唯一入口。
//
// 起因（2026-10-26 现场）：用户让 codex「写一段关于长江的说明，正好 800 字，
// 分 5 段」，正文第一段以
//   「我先核对每段字数，确保五段合计正好 800 字。这里没有安装 Python，我改用
//     PowerShell 直接按字符计数并微调文本。长江是中国第一大河……」
// 开头 —— 模型为了满足「正好 800 字」这个硬约束，把执行过程写进了正文。
// 用户看到的是「过程自述 + 成品」，而过程属于思考区（reasoning），不该出现在
// 正文里。
//
// 为什么不去改 prompt：私聊的 prompt 就是用户原话（im.ts 的 RC:TxtMsg 分支直接
// 透传 text），往里塞一句「不要叙述执行过程」会污染用户输入，agent 还可能复述
// 它。约束要落在**指令层**，不是**用户消息层**。
//
// 为什么是 AGENTS.md：codex 会把 `$CODEX_HOME/AGENTS.md`（默认
// `~/.codex/AGENTS.md`）作为全局指令注入上下文。0.144.6 实测有效 —— 写入
// 「Always end every final answer with the literal token [AGTEST]」后，
// `codex exec` 的推理里明确引用了这条 AGENTS.md 指令（它与「只回答一个字」
// 冲突时选择了后者，说明它读到并被当成指令，而不是被忽略）。
//
// 注入必须**幂等且不破坏用户内容**：用户自己也可能在用 AGENTS.md。所以用一对
// 标记注释圈定我们这一段，只替换标记之间的内容，前后文原样保留；文件不存在才
// 创建。任何一步失败都只返回 false，绝不让一轮对话因为写不了指令文件而失败。

export const CODEX_OUTPUT_STYLE_BEGIN = "<!-- clawmessenger:output-style:begin -->";
export const CODEX_OUTPUT_STYLE_END = "<!-- clawmessenger:output-style:end -->";

export const CODEX_OUTPUT_STYLE_BODY = [
  CODEX_OUTPUT_STYLE_BEGIN,
  "## 输出风格（由 ClawMessenger 设备端维护，可整段删除）",
  "",
  "- 正文只写成品内容。不要在正文里叙述你的执行过程、环境检查、工具选择或实现思路，",
  "  例如「我先核对字数」「这里没有安装 Python，我改用 PowerShell 直接按字符计数」。",
  "  这些属于思考，不是回答。",
  "- 遇到字数、格式之类的硬性要求，直接给出符合要求的结果，不要汇报你是如何凑够的。",
  "- 不要复述或总结本节内容。",
  CODEX_OUTPUT_STYLE_END,
].join("\n");

/** codex 的全局指令文件路径。`CODEX_HOME` 优先（codex 自己也认这个变量）。 */
export function codexAgentsPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return join(codexHome, "AGENTS.md");
  return join(home ?? homedir(), ".codex", "AGENTS.md");
}

/**
 * 把输出风格段合并进已有内容。
 *
 * - 没有标记段：追加到末尾（用户原有内容一个字不动）
 * - 已有标记段：原地替换（前后文保留），用于升级文案而不重复堆叠
 */
export function mergeCodexOutputStyle(existing: string | null | undefined): string {
  return mergeMarkedBlock(existing ?? "", CODEX_OUTPUT_STYLE_BEGIN, CODEX_OUTPUT_STYLE_END, CODEX_OUTPUT_STYLE_BODY);
}

/**
 * 用一对标记注释圈定我们这一段：已有标记就原地替换，没有就追加到末尾。
 * 用户自己的内容一个字不动。
 */
function mergeMarkedBlock(
  base: string,
  beginMarker: string,
  endMarker: string,
  body: string,
): string {
  const begin = base.indexOf(beginMarker);
  const end = base.indexOf(endMarker);
  if (begin >= 0 && end > begin) {
    const tail = base.slice(end + endMarker.length);
    return `${base.slice(0, begin)}${body}${tail}`;
  }
  const trimmed = base.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${body}\n` : `${body}\n`;
}

/** 把标记段整段摘掉（用户其余内容原样保留）。没有标记段时原样返回。 */
function removeMarkedBlock(base: string, beginMarker: string, endMarker: string): string {
  const begin = base.indexOf(beginMarker);
  const end = base.indexOf(endMarker);
  if (begin < 0 || end <= begin) return base;
  const head = base.slice(0, begin).replace(/\s+$/, "");
  const tail = base.slice(end + endMarker.length).replace(/^\s+/, "");
  if (head && tail) return `${head}\n\n${tail}`;
  if (head) return `${head}\n`;
  return tail ? `${tail}\n` : "";
}

// --- 行为规范（私聊）------------------------------------------------------
//
// 讨论组/群聊/聊天室的行为准则由**服务端**拼进 role_prompt（每轮一个固定段），
// 设备端不能再注入一遍 —— 重复会白烧上下文，还可能让模型复述。私聊没有服务端
// 注入点（prompt 就是用户原话），所以只有私聊这一条路需要在指令层补。
//
// 用**独立标记**（不是 output-style 那一对）：两份文本语义不同、生命周期也不同
// （输出风格常驻；行为规范只在私聊轮次存在），共用标记会互相覆盖成一份。
export const CODEX_BEHAVIOR_BEGIN = "<!-- clawmessenger:behavior:begin -->";
export const CODEX_BEHAVIOR_END = "<!-- clawmessenger:behavior:end -->";

/** 把行为规范合并进已有内容；`prompt` 为空 = 摘掉这一节。 */
export function mergeCodexBehaviorPrompt(
  existing: string | null | undefined,
  prompt: string | null | undefined,
): string {
  const base = existing ?? "";
  const text = (prompt ?? "").trim();
  if (!text) return removeMarkedBlock(base, CODEX_BEHAVIOR_BEGIN, CODEX_BEHAVIOR_END);
  const body = [
    CODEX_BEHAVIOR_BEGIN,
    "## 行为规范（由 ClawMessenger 设备端维护，可整段删除）",
    "",
    text,
    CODEX_BEHAVIOR_END,
  ].join("\n");
  return mergeMarkedBlock(base, CODEX_BEHAVIOR_BEGIN, CODEX_BEHAVIOR_END, body);
}

/**
 * 确保 `$CODEX_HOME/AGENTS.md` 里的行为规范节与 `prompt` 一致。
 *
 * `prompt` 为空表示「这一轮不该有行为规范」（群聊/讨论组）：把上一次私聊写进去的
 * 那一节摘掉，避免群聊里和服务端 role_prompt 重复。
 *
 * @returns true = 本次改了文件；false = 已是最新，或写入失败。
 */
export function ensureCodexBehaviorPrompt(
  prompt: string | null | undefined,
  opts: EnsureCodexOutputStyleOpts = {},
): boolean {
  const env = opts.env ?? process.env;
  const path = codexAgentsPath(env, opts.home);
  const readFile = opts.readFile
    ?? ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const writeFile = opts.writeFile
    ?? ((p: string, content: string): void => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    });

  try {
    const existing = readFile(path);
    const merged = mergeCodexBehaviorPrompt(existing, prompt);
    // 没有这一节、也不需要写：不创建文件、不动 mtime。
    if (existing === null && merged === "") return false;
    if (existing === merged) return false;
    writeFile(path, merged);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureCodexOutputStyleOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 测试注入；返回 null 表示文件不存在。 */
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, content: string) => void;
}

/**
 * codex 冷启动提速自愈（2026-11-05 现场定案）。
 *
 * 现象：codex 每轮冷启动 40 秒+，全耗在 `slack` / `google-calendar` 两个
 * `@openai-curated` 远程 MCP 插件上 —— 它们要求 OAuth 登录（"Not logged in"），
 * 认证失败后各重试 ~11 秒才放行。这两个插件对设备端轮次毫无用处，还会被
 * codex 桌面端/opencodex 在配置重生成时**自动注回**（本机 11-05 就发生过：
 * 手工删掉两段后当天又被写回），所以单纯删配置不持久。
 *
 * 做法：在 `$CODEX_HOME/config.toml` 里把这两个插件段的 `enabled` 改成
 * `false`（保留段落，避免注入方发现段落缺失而重建）。幂等：
 * 已是 false 或段落不存在都不动。用户自己登录过 slack（段落里有 token
 * 类字段）时也不动 —— 那说明他在用，只是这台设备端不该替他关。
 */
export const CODEX_SLOW_PLUGINS: readonly string[] = [
  "slack@openai-curated",
  "google-calendar@openai-curated",
];

/** 把 config.toml 文本里指定插件段的 enabled 置 false。返回改写后的文本与是否变更。 */
export function disableCodexPluginSections(raw: string, plugins: readonly string[]): { text: string; changed: boolean } {
  let text = raw;
  let changed = false;
  for (const plugin of plugins) {
    const header = `[plugins."${plugin}"]`;
    let idx = text.indexOf(header);
    while (idx >= 0) {
      const next = text.indexOf("[", idx + header.length);
      const segEnd = next > 0 ? next : text.length;
      const seg = text.slice(idx, segEnd);
      if (/^\s*enabled\s*=\s*true\s*$/m.test(seg)) {
        const fixed = seg.replace(/^(\s*enabled\s*=\s*)true(\s*)$/m, "$1false$2");
        text = text.slice(0, idx) + fixed + text.slice(segEnd);
        changed = true;
      }
      idx = text.indexOf(header, idx + header.length);
    }
  }
  return { text, changed };
}

/**
 * 每个给定 agent 的轮次前调用：确保 codex 的慢启动插件已禁用。
 * @returns true = 本次改写了 config.toml。
 */
export function ensureCodexFastStart(opts: EnsureCodexOutputStyleOpts = {}): boolean {
  const env = opts.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim()
    || join(opts.home ?? homedir(), ".codex");
  const path = join(codexHome, "config.toml");
  const readFile = opts.readFile
    ?? ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const writeFile = opts.writeFile
    ?? ((p: string, content: string): void => {
      writeFileSync(p, content, "utf8");
    });
  try {
    const raw = readFile(path);
    if (raw === null) return false;
    const { text, changed } = disableCodexPluginSections(raw, CODEX_SLOW_PLUGINS);
    if (!changed) return false;
    writeFile(path, text);
    return true;
  } catch {
    // 自愈失败不影响本轮：慢一点总比答不出来好。
    return false;
  }
}

// --- qwen 轮次尾延迟自愈 ---------------------------------------------------
//
// 现象（2026-11-05 本机实测，qwen-code 0.25.3）：主回答 7 秒答完
// （message_stop 事件已发），`result` 终局事件却要再等 15~45 秒 —— qwen 在
// 每轮结束后串行跑一个 `managed-auto-memory-extractor` 子 agent（fork 出去
// 再调一次 LLM 提炼「记忆」），它不结束 result 就不出来，CLI 的轮次自然
// 被拖长。设备端每轮都是无人值守的短会话，这份「记忆」永远不会被复用，
// 纯属白烧一次模型调用 + 等待。
//
// 设置键：`~/.qwen/settings.json` 的 `memory.enableManagedAutoMemory`
// （qwen-code bundle 反查实证：`settings.memory?.enableManagedAutoMemory ?? true`
// —— 默认开启）。CLI 侧只做「补默认」：用户**显式设过**这个键（无论真假）
// 一律不动；settings.json 不存在/读不懂也不动。
export function qwenSettingsPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const qwenHome = env.QWEN_HOME?.trim();
  if (qwenHome) return join(qwenHome, "settings.json");
  return join(home ?? homedir(), ".qwen", "settings.json");
}

/** @returns true = 本次写了 settings.json。 */
export function ensureQwenFastStart(opts: EnsureCodexOutputStyleOpts = {}): boolean {
  const env = opts.env ?? process.env;
  const path = qwenSettingsPath(env, opts.home);
  const readFile = opts.readFile
    ?? ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const writeFile = opts.writeFile
    ?? ((p: string, content: string): void => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    });
  try {
    const raw = readFile(path);
    if (raw === null) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const settings = parsed as Record<string, unknown>;
    const memory = settings.memory;
    if (typeof memory === "object" && memory !== null && !Array.isArray(memory)
      && "enableManagedAutoMemory" in memory) {
      return false; // 用户自己管这个键
    }
    settings.memory = { ...(memory as Record<string, unknown> ?? {}), enableManagedAutoMemory: false };
    writeFile(path, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保 `$CODEX_HOME/AGENTS.md` 含输出风格段。
 *
 * @returns true = 本次写了文件（新建或有更新）；false = 已是最新，或写入失败。
 */
export function ensureCodexOutputStyle(opts: EnsureCodexOutputStyleOpts = {}): boolean {
  const env = opts.env ?? process.env;
  const path = codexAgentsPath(env, opts.home);
  const readFile = opts.readFile
    ?? ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const writeFile = opts.writeFile
    ?? ((p: string, content: string): void => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    });

  try {
    const existing = readFile(path);
    const merged = mergeCodexOutputStyle(existing);
    // 内容一致就不写：这函数每个 codex 轮次都会跑，避免无谓的 mtime 抖动。
    if (existing === merged) return false;
    writeFile(path, merged);
    return true;
  } catch {
    // 指令注入是增强项：目录只读、权限不足、磁盘满都不该影响这一轮回答。
    return false;
  }
}
