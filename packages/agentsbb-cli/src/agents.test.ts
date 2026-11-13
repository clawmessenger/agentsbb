// @vitest-environment node
import { describe, expect, it } from "vitest";

// 本文件有用例真跑 runAgentTurn，codex 分支会「确保 $CODEX_HOME/AGENTS.md 含
// 输出风格段」。不重定向的话，跑一次测试就写进了执行者自己的 ~/.codex/AGENTS.md
// （2026-10-26 实测踩到：探针文件里凭空多出正式段落）。
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "cm-codex-home-"));
import {
  agentRuntimeEnv,
  buildAgentArgs,
  buildSpawnInvocation,
  buildModelArgs,
  discoverAgents,
  deviceOpencodeConfigPath,
  emitsJsonEnvelope,
  extractOpenclawEnvelopeDetails,
  extractOpenclawReply,
  grokCliModelId,
  grokRouteFromCliModelId,
  KNOWN_AGENT_CLIS,
  normalizeOpenclawOutput,
  openclawTurnHealth,
  parseOpenclawJsonOutput,
  parseStreamJsonLine,
  resolveWindowsShim,
  runAgentCommand,
  runAgentTurn,
  splitModelRoute,
  stripAnsiCodes,
  trimIncompleteUtf8Tail,
} from "./agents.js";
import { createEchoAgentScript, type EchoAgentFixture } from "./test-fixtures.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTurnError } from "./turn-error.js";
import { AGENT_MODEL_CAPABILITIES } from "./agent-model-capabilities.js";

// 本文件测的是 run --format json 那条路径的解析（part 去重、缓冲截断、半句判据）。
// opencode 默认已改走 serve + SSE（真增量），这里统一关掉，让假脚本能按 run 的
// 输出喂进来；serve 那条路自己的用例在 opencode-server.test.ts。
process.env.CLAWMESSENGER_OPENCODE_SERVER = "0";

interface FailureAgentFixture {
  agentPath: string;
  cleanup: () => void;
}

// 一个「只往 stdout 打固定文本、stderr 一个字都不打、然后以 code 退出」的假
// agent。现场（2026-10-25）kimi 就是这么失败的：横幅落在 stdout，我们只把
// stderr 拼进错误串，于是 web 收到的是「进程异常退出，没有任何输出」。
function createStdoutFailureAgent(
  name: string,
  stdoutText: string,
  code = 1,
): FailureAgentFixture {
  const dir = mkdtempSync(join(tmpdir(), "cm-failure-agent-"));
  const helper = join(dir, "failure-agent.cjs");
  writeFileSync(helper, [
    // 回调里退出，保证 stdout 已经冲刷完（否则管道异步写会被截断）。
    `process.stdout.write(${JSON.stringify(stdoutText)}, () => process.exit(${code}));`,
  ].join("\n"));
  const isWin = process.platform === "win32";
  const agentPath = join(dir, isWin ? `${name}.cmd` : name);
  if (isWin) {
    writeFileSync(agentPath, `@echo off\r\nnode "${helper}"\r\n`, { mode: 0o755 });
  } else {
    writeFileSync(agentPath, `#!/bin/sh\nexec node "${helper}"\n`, { mode: 0o755 });
    chmodSync(agentPath, 0o755);
  }
  return {
    agentPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("KNOWN_AGENT_CLIS", () => {
  it("matches the server-side knownAgentCLIs list", () => {
    expect(KNOWN_AGENT_CLIS).toEqual([
      "claude", "codex", "opencode", "codebuddy", "codearts", "deveco",
      "openclaw", "hermes", "pi", "omp", "cursor-agent", "kimi",
      "reasonix", "dsh", "kiro-cli", "agy", "qodercli", "qoderclicn",
      "traecli", "grok", "qwen", "qwenpaw", "mcode", "dim", "zeroclaw",
    ]);
  });
});

describe("buildAgentArgs", () => {
  it("claude uses print mode with stream-json and --model", () => {
    expect(buildAgentArgs("claude", "hi", "sonnet-4")).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--verbose", "--model", "sonnet-4",
    ]);
  });

  it("codex uses exec subcommand with --json and -m", () => {
    expect(buildAgentArgs("codex", "hi", "gpt-5")).toEqual([
      "exec", "hi", "--json", "--skip-git-repo-check", "-m", "gpt-5",
    ]);
  });

  it("opencode uses run subcommand with --model", () => {
    expect(buildAgentArgs("opencode", "hi", "glm-4.7")).toEqual([
      "run", "hi", "--format", "json", "--thinking", "--model", "glm-4.7",
    ]);
  });

  // 没有这两个参数时 opencode 只输出格式化纯文本，思考与工具步骤全都拿不到
  // ——私聊里「看不到它想了什么」的根因。--format 是 1.19 才有的参数。
  it("opencode 强制开 JSON 事件流，思考流与过程流才有数据源", () => {
    const args = buildAgentArgs("opencode", "hi");
    expect(args).toEqual(["run", "hi", "--format", "json", "--thinking"]);
    expect(args).toContain("--format");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
  });

  it("openclaw uses agent --local --json -m with --model", () => {
    expect(buildAgentArgs("openclaw", "hi", "m1")).toEqual(["agent", "--local", "--json", "-m", "hi", "--model", "m1"]);
  });

  it("openclaw 带会话键时用 --session-key 隔离会话（群聊不得读讨论组的上下文）", () => {
    expect(buildAgentArgs("openclaw", "hi", "m1", "cm-group-g1")).toEqual([
      "agent", "--local", "--json", "-m", "hi", "--session-key", "cm-group-g1", "--model", "m1",
    ]);
    // 不带键时参数形状不变（老行为、老测试）
    expect(buildAgentArgs("openclaw", "hi", "m1")).not.toContain("--session-key");
  });

  it("不支持会话键的 agent 忽略它（opencode/hermes 每轮本就是新会话）", () => {
    expect(buildAgentArgs("opencode", "hi", undefined, "cm-group-g1")).toEqual([
      "run", "hi", "--format", "json", "--thinking",
    ]);
    expect(buildAgentArgs("hermes", "hi", undefined, "cm-group-g1")).toEqual([
      "chat", "-q", "hi", "--oneshot", "--format", "stream-json",
    ]);
  });

  it("hermes 走 chat -q + 结构化事件流（-z 只有整包正文，拿不到工具过程）", () => {
    expect(buildAgentArgs("hermes", "hi", "m1")).toEqual([
      "chat", "-q", "hi", "--oneshot", "--format", "stream-json", "-m", "m1",
    ]);
  });

  // The panel stores `provider/model`; codex and hermes take the provider
  // separately, so the route is split rather than passed through. Verified
  // against the real CLIs: `codex -m quukk_direct/glm-5.2` is model_not_found.
  it("codex splits a route into -c model_provider + a bare -m", () => {
    expect(buildAgentArgs("codex", "hi", "quukk_direct/glm-5.2")).toEqual([
      "exec", "hi", "--json", "--skip-git-repo-check",
      "-c", "model_provider=quukk_direct", "-m", "glm-5.2",
    ]);
  });

  it("hermes passes the provider separately", () => {
    expect(buildAgentArgs("hermes", "hi", "quukk/glm-5.3")).toEqual([
      "chat", "-q", "hi", "--oneshot", "--format", "stream-json",
      "-m", "glm-5.3", "--provider", "quukk",
    ]);
  });

  it("openclaw keeps the whole route", () => {
    expect(buildAgentArgs("openclaw", "hi", "openai/glm-5.2")).toEqual([
      "agent", "--local", "--json", "-m", "hi", "--model", "openai/glm-5.2",
    ]);
  });

  it("omits model flags when no model is given", () => {
    expect(buildAgentArgs("claude", "hi")).toEqual(["-p", "hi", "--output-format", "stream-json", "--verbose"]);
    expect(buildAgentArgs("codex", "hi")).toEqual(["exec", "hi", "--json", "--skip-git-repo-check"]);
    expect(buildAgentArgs("opencode", "hi")).toEqual(["run", "hi", "--format", "json", "--thinking"]);
    expect(buildAgentArgs("openclaw", "hi")).toEqual(["agent", "--local", "--json", "-m", "hi"]);
    expect(buildAgentArgs("hermes", "hi")).toEqual([
      "chat", "-q", "hi", "--oneshot", "--format", "stream-json",
    ]);
  });

  // kimi 必须走 -p：不带参数直接 spawn 的是交互式 TUI，Windows 上拿不到
  // console 时会以 `No Windows console found` 退出（生产事故实证）。
  // 升级到 stream-json 后正文走逐行事件流（官方：thinking 不写 JSONL，思考
  // 预期为空——正文流升级，不虚构思考）。
  it("kimi 走 -p + stream-json（不再是 text 整包，也不回退 stdin/TUI）", () => {
    expect(buildAgentArgs("kimi", "hi")).toEqual(["-p", "hi", "--output-format", "stream-json"]);
    // -m 收的正是 `kimi provider list --json` 给出的 alias（`quukk/glm-5.2` 形，
    // 2026-11 实测），所以整段路由直接注入。
    expect(buildAgentArgs("kimi", "hi", "quukk/glm-5.2")).toEqual([
      "-p", "hi", "--output-format", "stream-json", "-m", "quukk/glm-5.2",
    ]);
    // 超长 prompt 退回 stdin 模式：kimi -p 的 argv 与 stdin 二选一，stdin 形态
    // 下它把管道读到 EOF 当 prompt（不会挂起）。
    expect(buildAgentArgs("kimi", "a".repeat(8001))).toEqual([]);
  });

  // qwen（Qwen Code 0.25.3）：-p 是官方「附到 stdin 输入之后」的形态，argv 与
  // stdin 兼容；事件流必须带 --include-partial-messages，否则 thinking_delta /
  // text_delta 都不上报（实测抓取确认）。--model 仍由 buildModelArgs 的 qwen
  // 分支注入裸 slug。
  it("qwen 走 -p + stream-json 事件流（思考流数据源），--model 注入裸 slug", () => {
    expect(buildAgentArgs("qwen", "hi")).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--include-partial-messages",
    ]);
    expect(buildAgentArgs("qwen", "hi", "quukk/glm-5.2")).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--include-partial-messages",
      "--model", "glm-5.2",
    ]);
    // 超长 prompt 退回 stdin 模式：qwen 的 -p 明确兼容 stdin 输入，两种形态都能答。
    expect(buildAgentArgs("qwen", "a".repeat(8001))).toEqual([]);
    expect(buildAgentArgs("qwen", "a".repeat(8000))).toEqual([
      "-p", "a".repeat(8000), "--output-format", "stream-json", "--include-partial-messages",
    ]);
  });

  // ── B 类十家 argv 形态（2026-11-04 批量接入）──────────────────────────────
  // cursor-agent：官方 headless 形态 `-p <prompt> --output-format stream-json`
  // （cursor.com/docs/cli/headless）。不注入 --model：抓包 init 的 model 是
  // "Auto"，模型走 cursor 账户配置。
  it("cursor-agent 走 -p + stream-json，不注入 --model", () => {
    expect(buildAgentArgs("cursor-agent", "hi")).toEqual([
      "-p", "hi", "--output-format", "stream-json",
    ]);
    expect(buildAgentArgs("cursor-agent", "hi", "quukk/glm-5.2")).toEqual([
      "-p", "hi", "--output-format", "stream-json",
    ]);
    expect(buildAgentArgs("cursor-agent", "a".repeat(8001))).toEqual([]);
  });

  // codebuddy：Claude Code fork，argv 对齐上游 codebuddy.go:38-44 的单向形态
  //（-p + stream-json 输出 + --verbose）。⚠️ 不带 --input-format stream-json：
  // 该参数让 stdin 变成「流式输入消息」通道，设备端 stdin 立即关闭 → 空 stdin
  // 让 codebuddy 静默 exit 0、零事件（2026-11-10 实测，即「本轮没有产出内容」
  // 的真因）。--model 不走 argv（只认自家 id），走 CODEBUDDY_MODEL env；
  // buildModelArgs 只保留 --port 0。
  it("codebuddy 走 -p + stream-json + --verbose（无 input-format，--port 0 防冲突）", () => {
    expect(buildAgentArgs("codebuddy", "hi")).toEqual([
      "-p", "hi",
      "--output-format", "stream-json", "--verbose",
      "--port", "0",
    ]);
    expect(buildAgentArgs("codebuddy", "hi", "quukk/glm-5.2")).toEqual([
      "-p", "hi",
      "--output-format", "stream-json", "--verbose",
      "--port", "0",
    ]);
  });

  // pi / omp：上游 buildPiArgs（pi.go:980-1029）的一次性形态
  // `-p --mode json`，prompt 官方走 stdin 管道（pi.go:421）；--model 整段
  // 透传（pi.go:1001-1010，GH #7300：拆 provider 反而是硬错误）。
  it("pi / omp 走 -p --mode json（prompt 留 stdin），--model 整段透传", () => {
    expect(buildAgentArgs("pi", "hi")).toEqual(["-p", "--mode", "json"]);
    expect(buildAgentArgs("pi", "hi", "anthropic/claude-sonnet-5")).toEqual([
      "-p", "--mode", "json", "--model", "anthropic/claude-sonnet-5",
    ]);
    // omp 是 pi 协议家族的衍生（builtin_runtimes.go:86-100），同形。
    expect(buildAgentArgs("omp", "hi", "anthropic/claude-sonnet-5")).toEqual([
      "-p", "--mode", "json", "--model", "anthropic/claude-sonnet-5",
    ]);
    // prompt 不进 argv：超长或超短都一样——pi 的 prompt 永远在 stdin。
    expect(buildAgentArgs("pi", "a".repeat(9000))).toEqual([]);
  });

  // traecli：一次性 `exec [PROMPT] --json`（docs.trae.cn）。不引入 ACP 会话
  // 管理；不注入 --model（官方参数表没有模型选择旗标）。
  it("traecli 走 exec --json 一次性入口", () => {
    expect(buildAgentArgs("traecli", "hi")).toEqual(["exec", "hi", "--json"]);
    expect(buildAgentArgs("traecli", "hi", "quukk/glm-5.2")).toEqual(["exec", "hi", "--json"]);
  });

  // qodercli / qoderclicn：官方 `-p --output-format stream-json`
  // （docs.qoder.com/cli/run-in-scripts）。CN 二进制同 backend，argv 共享。
  it("qodercli / qoderclicn 走 -p + stream-json（同 backend 同 argv）", () => {
    expect(buildAgentArgs("qodercli", "hi")).toEqual([
      "-p", "hi", "--output-format", "stream-json",
    ]);
    expect(buildAgentArgs("qoderclicn", "hi")).toEqual([
      "-p", "hi", "--output-format", "stream-json",
    ]);
    expect(buildAgentArgs("qodercli", "hi", "quukk/glm-5.2")).toEqual([
      "-p", "hi", "--output-format", "stream-json",
    ]);
  });

  // dsh：argv 只有启动旗标（--profile multica --stdio），prompt 与模型都在
  // stdin 的 execute 命令帧里（版本化 JSONL 协议，dsh.go:54-64）。
  it("dsh 走 --profile multica --stdio（prompt/模型在 stdin 命令帧）", () => {
    expect(buildAgentArgs("dsh", "hi")).toEqual(["--profile", "multica", "--stdio"]);
    expect(buildAgentArgs("dsh", "hi", "deepseek/dsh-r2")).toEqual([
      "--profile", "multica", "--stdio",
    ]);
    // dsh 没有 argv prompt 形态：超长 prompt 也走同一条 stdin 命令帧路径，
    // 不会有「回退裸 stdin」的降级形态差。
    expect(buildAgentArgs("dsh", "a".repeat(9000))).toEqual([]);
  });

  // agy：上游 buildAntigravityArgs（antigravity.go:780-785）的一次性形态，
  // --dangerously-skip-permissions 与上游同款（聊天场景没有交互确认通道）。
  it("agy 走 -p + stream-json + 跳权限（--model 透传）", () => {
    expect(buildAgentArgs("agy", "hi")).toEqual([
      "-p", "hi", "--dangerously-skip-permissions", "--output-format", "stream-json",
    ]);
    expect(buildAgentArgs("agy", "hi", "gemini-3-pro")).toEqual([
      "-p", "hi", "--dangerously-skip-permissions", "--output-format", "stream-json",
      "--model", "gemini-3-pro",
    ]);
  });

  // B 类第二批（2026-11-10 全量真机接入）：每家的 headless 入口都经实机
  // `--help` 核对过，钉住 argv 形状防止回归成「裸 CLI = TUI」的老坑。
  it("deveco 走 run 一次性入口（不再进 TUI 喷进度条）", () => {
    expect(buildAgentArgs("deveco", "hi")).toEqual(["run", "hi"]);
    expect(buildModelArgs("deveco", "quukk/glm-5.2")).toEqual([]);
  });

  it("codearts 走 run 一次性入口（否则 TUI 启动横幅「正在启动中…」被当正文）", () => {
    expect(buildAgentArgs("codearts", "hi")).toEqual(["run", "hi"]);
    expect(buildModelArgs("codearts", "quukk/glm-5.2")).toEqual([]);
  });

  it("mcode 走 exec + text（不再撞 interactive mode requires a TTY）", () => {
    expect(buildAgentArgs("mcode", "hi")).toEqual(["exec", "hi", "--output-format", "text"]);
    expect(buildModelArgs("mcode", "quukk/glm-5.2")).toEqual([]);
  });

  it("qwenpaw 走 task -i，模型不注入", () => {
    expect(buildAgentArgs("qwenpaw", "hi")).toEqual(["task", "-i", "hi"]);
    expect(buildModelArgs("qwenpaw", "quukk/glm-5.2")).toEqual([]);
  });

  it("dim 走 exec 一次性入口（不再进 TUI 撞未信任目录）", () => {
    expect(buildAgentArgs("dim", "hi")).toEqual(["exec", "hi"]);
    expect(buildModelArgs("dim", "quukk/glm-5.2")).toEqual([]);
  });

  it("grok 走 -p/--single（plain 正文），-m 注入连字符模型 id", () => {
    expect(buildAgentArgs("grok", "hi")).toEqual(["-p", "hi"]);
    // 目录用斜杠路由（wire 要求），注入用 CLI 的连字符 id（2026-11 实测
    // `grok models` 输出 `quukk-glm-5.2`）。转换是严格双射：`/` ⇄ `-`，
    // 所以 `grok/4.7` 注入回 CLI 认的 `grok-4.7`（不做前缀白名单猜测）。
    expect(buildModelArgs("grok", "quukk/glm-5.2")).toEqual(["-m", "quukk-glm-5.2"]);
    expect(buildModelArgs("grok", "grok/4.7")).toEqual(["-m", "grok-4.7"]);
    // 无斜杠的裸 id 原样透传（splitModelRoute 返回 null 时不做改写）
    expect(buildModelArgs("grok", "grok-4.7")).toEqual(["-m", "grok-4.7"]);
    expect(buildModelArgs("grok", undefined)).toEqual([]);
    expect(buildAgentArgs("grok", "hi", "quukk/glm-5.2")).toEqual(["-p", "hi", "-m", "quukk-glm-5.2"]);
  });

  it("reasonix 走 -p + text（不再把 usage help 当回复）", () => {
    expect(buildAgentArgs("reasonix", "hi")).toEqual(["-p", "hi", "--output-format", "text"]);
    expect(buildModelArgs("reasonix", "quukk/glm-5.2")).toEqual([]);
  });

  it("zeroclaw 走 agent -a default -m（缺别名时它只打 usage help）", () => {
    expect(buildAgentArgs("zeroclaw", "hi")).toEqual(["agent", "-a", "default", "-m", "hi"]);
    expect(buildModelArgs("zeroclaw", "quukk/glm-5.2")).toEqual([]);
  });

  it("extractQwenpawReply 从 INFO 日志 + JSON 信封里提取正文", async () => {
    const { extractQwenpawReply } = await import("./agents.js");
    const envelope = [
      "INFO C:\\some\\path.py:80 | 2026-11-10 | Unified browser experimental beta is enabled",
      "{",
      '  "status": "success",',
      '  "elapsed_seconds": 2.31,',
      '  "response": "\\n\\nOK",',
      '  "usage": {}',
      "}",
    ].join("\n");
    expect(extractQwenpawReply(envelope)).toBe("OK");
    // 无信封（日志为主）时去掉日志行兜底，绝不返回空。
    expect(extractQwenpawReply("INFO a\nWARNING b\nhello")).toBe("hello");
    // status=error 的信封如实转述，不假装成功。
    const errEnvelope = '{"status": "error", "error": "boom"}';
    expect(extractQwenpawReply(errEnvelope)).toContain("boom");
  });

  it("normalizeCodeartsOutput 剥掉 SGR 与 `|` 排版符（只留正文）", async () => {
    const { normalizeCodeartsOutput } = await import("./agents.js");
    const raw = "\u001b[90m|\u001b[39m\n\u001b[34m•\u001b[39m  认证失败\n\u001b[90m|\u001b[39m  请配置 AK/SK\n";
    expect(normalizeCodeartsOutput(raw)).toBe("•  认证失败\n 请配置 AK/SK");
  });

  it("returns [] for agents without a strategy", () => {
    // copilot 至今没有 argv 策略（设备端不支持它的运行时），是「无策略」样本；
    // 2026-11-10 起 grok/deveco/mcode/qwenpaw/dim/reasonix/zeroclaw 都有策略了，
    // 不能再拿它们当样本。
    expect(buildAgentArgs("copilot", "hi")).toEqual([]);
  });

  it("returns [] past the argv length cap (falls back to stdin)", () => {
    expect(buildAgentArgs("claude", "a".repeat(8001))).toEqual([]);
    expect(buildAgentArgs("codex", "a".repeat(8001), "gpt-5")).toEqual([]);
    expect(buildAgentArgs("claude", "a".repeat(8000))).toEqual([
      "-p", "a".repeat(8000), "--output-format", "stream-json", "--verbose",
    ]);
  });
});

describe("splitModelRoute / buildModelArgs", () => {
  it("splits only well-formed provider/model routes", () => {
    expect(splitModelRoute("quukk/glm-5.3")).toEqual({ provider: "quukk", model: "glm-5.3" });
    expect(splitModelRoute("quukk_direct/glm-5.2")).toEqual({
      provider: "quukk_direct",
      model: "glm-5.2",
    });
    expect(splitModelRoute("glm-5.3")).toBeNull();
    expect(splitModelRoute("a/b/c")).toBeNull();
    expect(splitModelRoute("/glm-5.3")).toBeNull();
    expect(splitModelRoute("quukk/")).toBeNull();
    expect(splitModelRoute("quukk/glm 5.3")).toBeNull();
  });

  it("omits flags without a model and defaults to --model", () => {
    expect(buildModelArgs("opencode", undefined)).toEqual([]);
    expect(buildModelArgs("opencode", "quukk/glm-5.3")).toEqual(["--model", "quukk/glm-5.3"]);
    expect(buildModelArgs("claude", "sonnet-4")).toEqual(["--model", "sonnet-4"]);
    // 没人选的模型 → 什么都不加（与 agent 是否支持注入无关）
    expect(buildModelArgs("kimi", undefined)).toEqual([]);
  });

  // 3a 的守卫必须逐 agent 钉住：既不能给不认 `--model` 的 agent 乱塞参数，
  // 也不能把本来支持 `--model` 的 agent 一起误伤（qwen 就是易回归点 ——
  // 它在设备端没有 argv 策略，但 `--model` 是真实支持的参数）。
  it("only renders model flags for agents that actually accept them", () => {
    // 无策略 → 不注入
    expect(buildModelArgs("kiro-cli", "m1")).toEqual([]);
    expect(buildModelArgs("cursor-agent", "m1")).toEqual([]);
    // 有策略 → 按各家形状注入
    expect(buildModelArgs("codex", "p/m")).toEqual(["-c", "model_provider=p", "-m", "m"]);
    expect(buildModelArgs("opencode", "p/m")).toEqual(["--model", "p/m"]);
    expect(buildModelArgs("hermes", "p/m")).toEqual(["-m", "m", "--provider", "p"]);
    // 无策略但确实支持 --model：provider 段必须剥掉
    expect(buildModelArgs("qwen", "p/m")).toEqual(["--model", "m"]);
    // kimi：-m 收 provider/model alias，整段注入
    expect(buildModelArgs("kimi", "p/m")).toEqual(["-m", "p/m"]);
    // grok：目录用斜杠、注入用连字符
    expect(buildModelArgs("grok", "p/m")).toEqual(["-m", "p-m"]);
    // codebuddy 只留一个随机端口，模型走 CODEBUDDY_MODEL
    expect(buildModelArgs("codebuddy", "m1")).toEqual(["--port", "0"]);
    // 没选模型 → 什么都不加
    expect(buildModelArgs("claude", undefined)).toEqual([]);
  });

  // B 类十家的模型注入面（2026-11-04 批量接入）：每一家都按证据钉住——
  // 不认路由的（cursor）不注入，认整段的（pi/omp/kimi）整段透传，
  // 模型在 stdin 协议帧里的（dsh）argv 返回空。
  it("B 类新 CLI 的模型注入面逐家钉住（不猜参数名）", () => {
    // cursor-agent：模型跟随 cursor 账户配置（抓包 init model="Auto"）
    expect(buildModelArgs("cursor-agent", "p/m")).toEqual([]);
    // traecli / qodercli / qoderclicn：官方参数表没有模型旗标，不注入
    expect(buildModelArgs("traecli", "p/m")).toEqual([]);
    expect(buildModelArgs("qodercli", "p/m")).toEqual([]);
    expect(buildModelArgs("qoderclicn", "p/m")).toEqual([]);
    // pi / omp：--model 整段透传（pi.go:1001-1010，拆 provider 反而报错）
    expect(buildModelArgs("pi", "anthropic/claude-sonnet-5"))
      .toEqual(["--model", "anthropic/claude-sonnet-5"]);
    expect(buildModelArgs("omp", "anthropic/claude-sonnet-5"))
      .toEqual(["--model", "anthropic/claude-sonnet-5"]);
    // dsh：模型在 stdin 的 execute 命令帧（{provider,id}），argv 无 --model
    expect(buildModelArgs("dsh", "p/m")).toEqual([]);
    // agy：Gemini CLI 血统，--model 透传（上游 antigravity.go:786-788 同款）
    expect(buildModelArgs("agy", "gemini-3-pro")).toEqual(["--model", "gemini-3-pro"]);
  });

  it("strips the provider segment for qwen, which only takes the upstream slug", () => {
    expect(buildModelArgs("qwen", "quukk/glm-5.2")).toEqual(["--model", "glm-5.2"]);
    expect(buildModelArgs("qwen", "glm-5.2")).toEqual(["--model", "glm-5.2"]);
    expect(buildModelArgs("qwen", undefined)).toEqual([]);
    // qwen 有了 argv 策略之后守卫不再拦它：`--model` 必须照常注入（易回归点，
    // 别让「无策略不注入」的守卫把 stdin 时代的老事实带进 argv 时代）。
    expect(buildAgentArgs("qwen", "hi", "quukk/glm-5.2")).toContain("glm-5.2");
  });

  // claude 的静态目录（model-static-catalogs.ts）以 anthropic 前缀分组，但
  // Claude Code 的 --model 只认裸 ResolvedModel（claude_models.go:340-344）——
  // 整段路由会被它当成未知模型，注入前必须剥掉 provider（2026-11 修复）。
  it("strips the provider segment for claude, which takes the bare resolved id", () => {
    expect(buildModelArgs("claude", "anthropic/claude-sonnet-4-6"))
      .toEqual(["--model", "claude-sonnet-4-6"]);
    expect(buildModelArgs("claude", "claude-opus-5")).toEqual(["--model", "claude-opus-5"]);
    expect(buildModelArgs("claude", undefined)).toEqual([]);
  });

  // agy 的目录（`agy models`，parseAgyModelsList）用自造的 `agy` 前缀分组，
  // 但目录条目本身没有 provider（models.go:2427-2452），--model 收裸 id ——
  // 注入前剥掉前缀（2026-11 修复）。
  it("strips the synthetic provider segment for agy", () => {
    expect(buildModelArgs("agy", "agy/gemini-3-pro")).toEqual(["--model", "gemini-3-pro"]);
    // 裸 id 形态（历史行为）保持不变
    expect(buildModelArgs("agy", "gemini-3-pro")).toEqual(["--model", "gemini-3-pro"]);
  });

  // grok 的目录 ↔ 注入 id 形状转换必须严格互逆：目录（wire）用斜杠，
  // CLI 用连字符。转换规则 = 第一个 `-` 前是 provider，其余是 model，
  // 因此裸 id `grok-4.7` 被切成 `grok` + `4.7` —— 分组不完美但可逆，
  // 注入出去仍是 CLI 认的 `grok-4.7`。**不用前缀白名单猜 xai**。
  it("round-trips grok ids between the wire route and the CLI form", () => {
    expect(grokRouteFromCliModelId("quukk-glm-5.2")).toBe("quukk/glm-5.2");
    expect(grokRouteFromCliModelId("quukk-kimi-k2-7-code")).toBe("quukk/kimi-k2-7-code");
    expect(grokRouteFromCliModelId("grok-4.7")).toBe("grok/4.7");
    expect(grokRouteFromCliModelId("   ")).toBeNull();
    // 无法构成合法单斜杠路由时返回 null（这些 id 会被目录解析器跳过）
    expect(grokRouteFromCliModelId("grok4.7")).toBeNull();
    expect(grokRouteFromCliModelId("-4.7")).toBeNull();
    expect(grokRouteFromCliModelId("grok-")).toBeNull();
    // 互逆：CLI id → 路由 → CLI id 必须逐字符还原（分组被切得不完美也不影响注入）
    for (const cliId of ["quukk-glm-5.2", "quukk-kimi-k2-7-code", "grok-4.7", "deepseek-v4-pro"]) {
      const route = grokRouteFromCliModelId(cliId);
      expect(route).not.toBeNull();
      expect(grokCliModelId(route as string)).toBe(cliId);
    }
    // 正向：wire 路由 → CLI id
    expect(grokCliModelId("quukk/glm-5.2")).toBe("quukk-glm-5.2");
    expect(grokCliModelId("grok/4.7")).toBe("grok-4.7");
    // 无斜杠输入原样返回（不进 CLI 的模型名不做改写）
    expect(grokCliModelId("grok-4.7")).toBe("grok-4.7");
  });

  it("never passes --model to codebuddy (it only exposes a free port)", () => {
    // codebuddy rejects any model id it does not own (`--model glm-5.2` →
    // "Authentication required"), so the model rides CODEBUDDY_MODEL instead.
    expect(buildModelArgs("codebuddy", "quukk/glm-5.2")).toEqual(["--port", "0"]);
    expect(buildModelArgs("codebuddy", undefined)).toEqual(["--port", "0"]);
  });

  // 能力矩阵与注入实现的**交叉校验**（agent-model-capabilities.ts 是单一事实源）：
  // 矩阵说 'none' 的 agent，argv 里绝不能出现模型参数 —— 否则「目录里没有」与
  // 「注入了不该注入的旗标」会同时发生，比空目录更糟（CLI 未知参数直接退出）。
  // 反过来，矩阵说 'argv' 的 agent 必须真的把模型带进命令行，否则面板上选中的
  // 模型会静默失效（设计 D 的红线）。
  it("agrees with AGENT_MODEL_CAPABILITIES on every agent", () => {
    for (const [agentName, capability] of Object.entries(AGENT_MODEL_CAPABILITIES)) {
      const argv = buildModelArgs(agentName, "probe/provider-model");
      if (capability.modelInjection === "none") {
        expect(argv, `${agentName} must not inject a model`).toEqual([]);
      } else if (capability.modelInjection === "stdin-frame") {
        // dsh：模型随 stdin 的 execute 帧走，argv 里没有 --model
        expect(argv, `${agentName} carries the model on stdin`).toEqual([]);
      } else if (capability.modelInjection === "env") {
        // codebuddy：只留 --port 0，模型走 CODEBUDDY_MODEL
        expect(argv.join(" "), `${agentName} must not pass the route on argv`)
          .not.toContain("probe/provider-model");
      } else {
        expect(argv.length, `${agentName} must inject the model`).toBeGreaterThan(0);
        expect(argv.join(" "), `${agentName} must carry the model id`).toContain("provider-model");
      }
    }
  });
});

// dsh 的列举命令打完帧不肯退出（2026-11 实测，只能等 timeout 被杀 → exit 124）：
// runAgentCommand 必须靠 stopWhen 早退，否则设备端永远是「超时 → 空目录」。
describe("runAgentCommand stopWhen", () => {
  it("resolves as soon as the predicate matches, without waiting for the process to exit", async () => {
    // stdoutText 写完后 process.stdin.resume() 挂着不退 —— 正好复现 dsh 的行为。
    const fixture = createEchoAgentScript("dsh", {
      stdoutText: '{"v":1,"type":"models","models":[{"id":"quukk/glm-5.2"}]}\n',
    });
    const started = Date.now();
    try {
      const stdout = await runAgentCommand({
        execPath: fixture.agentPath,
        argv: ["--profile", "multica", "--list-models"],
        timeoutMs: 30_000,
        stopWhen: (partial) => partial.includes('"type":"models"'),
      });
      expect(stdout).toContain('"type":"models"');
      // 远小于 timeoutMs：证明是「命中即收工」，不是等超时、也不是等进程退出
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      fixture.cleanup();
    }
  });

  it("still waits for a normal exit when no predicate is given", async () => {
    const fixture = createEchoAgentScript("dsh", { stdoutText: "done\n" });
    try {
      const stdout = await runAgentCommand({
        execPath: fixture.agentPath,
        argv: [],
        timeoutMs: 30_000,
      });
      expect(stdout).toBe("done\n");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("agentRuntimeEnv", () => {
  const CONFIG = {
    endpoints: [
      {
        id: "quukk",
        name: "Quukk AI",
        baseUrl: "https://llmapi.quukk.com/v1",
        apiKey: "sk-test",
      },
    ],
    defaultModel: "quukk/glm-5.2",
  };

  it("points codebuddy at the configured gateway and passes the picked model", () => {
    const env = agentRuntimeEnv("codebuddy", "quukk/glm-5.3", { env: { PATH: "/bin" }, config: CONFIG });
    expect(env).toMatchObject({
      PATH: "/bin",
      CODEBUDDY_BASE_URL: "https://llmapi.quukk.com/v1",
      CODEBUDDY_AUTH_TOKEN: "sk-test",
      CODEBUDDY_MODEL: "glm-5.3",
    });
  });

  it("falls back to the configured default model when none was picked", () => {
    expect(agentRuntimeEnv("codebuddy", undefined, { env: {}, config: CONFIG }))
      .toMatchObject({ CODEBUDDY_MODEL: "glm-5.2" });
  });

  it("leaves the environment alone for agents that need no gateway switch", () => {
    expect(agentRuntimeEnv("qwen", "quukk/glm-5.2", { env: {}, config: CONFIG })).toBeNull();
    expect(agentRuntimeEnv("codebuddy", "quukk/glm-5.2", { env: {}, config: null })).toBeNull();
  });
});

// Real shapes observed from OpenClaw 2026.9.2 (`openclaw agent --local …`)
// on this machine.
const OPENCLAW_PLAIN_STDOUT = [
  "\x1b[33m[provider-transport-fetch]\x1b[39m \x1b[36m[model-fetch] start provider=openai api=openai-responses model=gpt-5.6-sol method=POST url=http://127.0.0.1:49830/v1/responses timeoutMs=undefined proxy=none policy=custom\x1b[39m",
  "\x1b[33m[provider-transport-fetch]\x1b[39m \x1b[36m[model-fetch] response status=200 elapsedMs=28 dispatcher=new contentType=text/event-stream\x1b[39m",
  "收到",
  "\x1b[33m[agents/agent-command]\x1b[39m \x1b[36m[agent] run 2b7c1e00-1234 ended with stopReason=stop\x1b[39m",
  "",
].join("\n");

const OPENCLAW_JSON_STDOUT = JSON.stringify({
  payloads: [{ text: "你好！有什么我可以帮你的吗？😊", mediaUrl: null }],
  meta: {
    durationMs: 7909,
    finalPromptText: "你好",
    finalAssistantVisibleText: "你好！有什么我可以帮你的吗？😊",
    finalAssistantRawText: "你好！有什么我可以帮你的吗？😊",
    stopReason: "stop",
  },
});

describe("stripAnsiCodes", () => {
  it("removes CSI color sequences", () => {
    expect(stripAnsiCodes("\x1b[33m[model-fetch]\x1b[39m text")).toBe("[model-fetch] text");
    expect(stripAnsiCodes("plain")).toBe("plain");
  });
});

describe("normalizeOpenclawOutput", () => {
  it("drops ANSI log lines and keeps the answer", () => {
    expect(normalizeOpenclawOutput(OPENCLAW_PLAIN_STDOUT)).toBe("收到");
  });

  it("preserves markdown links that look like bracket tags", () => {
    const md = "see [docs](https://example.com) for details";
    expect(normalizeOpenclawOutput(md)).toBe(md);
  });

  it("collapses blank runs and trims edges", () => {
    expect(normalizeOpenclawOutput("\n\nline1\n\n\n\nline2\n\n")).toBe("line1\n\nline2");
  });

  it("keeps multi-line answers intact", () => {
    const answer = "第一行\n第二行";
    expect(normalizeOpenclawOutput(`${answer}\n[agent] run x ended with stopReason=stop`)).toBe(answer);
  });
});

describe("parseOpenclawJsonOutput", () => {
  it("joins payload texts from the --json envelope", () => {
    expect(parseOpenclawJsonOutput(OPENCLAW_JSON_STDOUT)).toBe("你好！有什么我可以帮你的吗？😊");
  });

  it("joins multiple payloads with newlines", () => {
    const raw = JSON.stringify({ payloads: [{ text: "part1" }, { text: "part2" }, { mediaUrl: null }] });
    expect(parseOpenclawJsonOutput(raw)).toBe("part1\npart2");
  });

  it("falls back to meta.finalAssistantVisibleText when payloads are empty", () => {
    const raw = JSON.stringify({ payloads: [], meta: { finalAssistantVisibleText: "visible text" } });
    expect(parseOpenclawJsonOutput(raw)).toBe("visible text");
  });

  it("returns undefined for non-JSON output", () => {
    expect(parseOpenclawJsonOutput("收到")).toBeUndefined();
    expect(parseOpenclawJsonOutput("")).toBeUndefined();
  });

  it("returns undefined for JSON without recognizable fields", () => {
    expect(parseOpenclawJsonOutput(JSON.stringify({ foo: 1 }))).toBeUndefined();
  });
});

describe("extractOpenclawReply", () => {
  it("prefers the --json envelope", () => {
    expect(extractOpenclawReply(OPENCLAW_JSON_STDOUT)).toBe("你好！有什么我可以帮你的吗？😊");
  });

  it("normalizes plain stdout when no envelope is present", () => {
    expect(extractOpenclawReply(OPENCLAW_PLAIN_STDOUT)).toBe("收到");
  });

  it("falls back to raw trimmed text when extraction comes up empty", () => {
    expect(extractOpenclawReply("  \n raw fallback \n ")).toBe("raw fallback");
  });
});

describe("extractOpenclawEnvelopeDetails", () => {
  it("把 isReasoning 的 payload 抽成思考（不进正文）", () => {
    const raw = JSON.stringify({
      payloads: [
        { text: "先想想用户要什么", isReasoning: true },
        { text: "你好，有什么可以帮你？" },
      ],
    });
    expect(extractOpenclawEnvelopeDetails(raw).reasoning).toBe("先想想用户要什么");
    // 正文里绝不能混进思考
    expect(parseOpenclawJsonOutput(raw)).toBe("你好，有什么可以帮你？");
  });

  it("多种思考 payload 按顺序拼接", () => {
    const raw = JSON.stringify({
      payloads: [{ text: "第一段", isReasoning: true }, { text: "第二段", isReasoning: true }],
    });
    expect(extractOpenclawEnvelopeDetails(raw).reasoning).toBe("第一段\n\n第二段");
  });

  it("toolSummary 折成每一种工具一条汇总步骤", () => {
    const raw = JSON.stringify({
      payloads: [{ text: "已查完" }],
      toolSummary: { calls: 3, tools: ["web_search"], failures: 0, totalToolTimeMs: 1200 },
    });
    expect(extractOpenclawEnvelopeDetails(raw).tools).toEqual([
      { name: "web_search", calls: 3, failures: 0 },
    ]);
    const many = JSON.stringify({ toolSummary: { calls: 4, tools: ["web_search", "terminal"] } });
    expect(extractOpenclawEnvelopeDetails(many).tools).toEqual([
      { name: "web_search", calls: 1, failures: 0 },
      { name: "terminal", calls: 1, failures: 0 },
    ]);
  });

  it("没有思考/工具字段时返回空对象（老信封）", () => {
    expect(extractOpenclawEnvelopeDetails(JSON.stringify({ payloads: [{ text: "hi" }] }))).toEqual({});
    expect(extractOpenclawEnvelopeDetails("收到")).toEqual({});
    expect(extractOpenclawEnvelopeDetails("")).toEqual({});
  });
});

describe("emitsJsonEnvelope", () => {
  it("只把 openclaw 当作一次性 JSON 信封型 agent", () => {
    expect(emitsJsonEnvelope("openclaw")).toBe(true);
    expect(emitsJsonEnvelope("opencode")).toBe(false);
    expect(emitsJsonEnvelope("hermes")).toBe(false);
    expect(emitsJsonEnvelope("codex")).toBe(false);
    expect(emitsJsonEnvelope(undefined)).toBe(false);
  });
});

describe("openclawTurnHealth", () => {
  const envelope = (meta: unknown): string => JSON.stringify({ payloads: [], meta });

  it("把 aborted 判成没答完", () => {
    expect(openclawTurnHealth(envelope({ aborted: true })).incomplete).toBe(true);
  });

  it("把 finishReason=length 判成没答完（回答被截断）", () => {
    const health = openclawTurnHealth(envelope({ completion: { finishReason: "length" } }));
    expect(health.incomplete).toBe(true);
    expect(health.detail).toContain("length");
  });

  it("老信封没有 completion 时退到 stopReason", () => {
    expect(openclawTurnHealth(envelope({ stopReason: "content_filter" })).incomplete).toBe(true);
  });

  it("正常 stop 不算没答完", () => {
    expect(openclawTurnHealth(envelope({ aborted: false, completion: { finishReason: "stop" } })).incomplete).toBe(false);
  });

  it("非信封输出不做判断（绝不拿日志行猜结论）", () => {
    expect(openclawTurnHealth("plain stdout").incomplete).toBe(false);
    expect(openclawTurnHealth("{}").incomplete).toBe(false);
  });
});

describe("discoverAgents", () => {
  it("scans only extraPath when provided", async () => {
    const fixture = createEchoAgentScript("claude");
    try {
      const found = await discoverAgents({ extraPath: fixture.dir });
      expect(found.some((a) => a.name === "claude")).toBe(true);
      expect(found.every((a) => a.path.startsWith(fixture.dir))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns [] when extraPath has no known agent", async () => {
    const fixture = createEchoAgentScript("not-a-known-agent");
    try {
      expect(await discoverAgents({ extraPath: fixture.dir })).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns [] for an empty extraPath", async () => {
    expect(await discoverAgents({ extraPath: "" })).toEqual([]);
  });
});

describe("trimIncompleteUtf8Tail", () => {
  // "你" = E4 BD A0 (3-byte); "😀" = F0 9F 98 80 (4-byte).
  const cjk = Buffer.from("你", "utf8"); // e4 bd a0
  const emoji = Buffer.from("😀", "utf8"); // f0 9f 98 80
  const ascii = Buffer.from("a", "utf8");

  it("returns the buffer unchanged when it ends on a complete ASCII char", () => {
    const buf = Buffer.concat([ascii, cjk, ascii]);
    expect(trimIncompleteUtf8Tail(buf)).toEqual(buf);
  });

  it("returns an empty buffer for input that is only a partial sequence", () => {
    expect(trimIncompleteUtf8Tail(cjk.subarray(0, 1))).toEqual(Buffer.alloc(0));
    expect(trimIncompleteUtf8Tail(emoji.subarray(0, 1))).toEqual(Buffer.alloc(0));
  });

  it("trims a cut after the lead byte of a 3-byte char (E4)", () => {
    const buf = Buffer.concat([ascii, cjk.subarray(0, 1)]); // ...e4
    expect(trimIncompleteUtf8Tail(buf)).toEqual(ascii);
  });

  it("trims a cut after the 1st continuation byte of a 3-byte char (E4 BD)", () => {
    const buf = Buffer.concat([ascii, cjk.subarray(0, 2)]); // ...e4 bd
    expect(trimIncompleteUtf8Tail(buf)).toEqual(ascii);
  });

  it("trims a cut after the lead byte of a 4-byte char (F0)", () => {
    const buf = Buffer.concat([ascii, emoji.subarray(0, 1)]); // ...f0
    expect(trimIncompleteUtf8Tail(buf)).toEqual(ascii);
  });

  it("trims a cut after the 1st continuation byte of a 4-byte char (F0 9F)", () => {
    const buf = Buffer.concat([ascii, emoji.subarray(0, 2)]); // ...f0 9f
    expect(trimIncompleteUtf8Tail(buf)).toEqual(ascii);
  });

  it("trims a cut after the 2nd continuation byte of a 4-byte char (F0 9F 98)", () => {
    const buf = Buffer.concat([ascii, emoji.subarray(0, 3)]); // ...f0 9f 98
    expect(trimIncompleteUtf8Tail(buf)).toEqual(ascii);
  });

  it("keeps a complete multi-byte char at the end", () => {
    const buf = Buffer.concat([ascii, cjk]);
    expect(trimIncompleteUtf8Tail(buf)).toEqual(buf);
    const withEmoji = Buffer.concat([ascii, emoji]);
    expect(trimIncompleteUtf8Tail(withEmoji)).toEqual(withEmoji);
  });

  it("cuts the trailing continuation run when no lead byte exists within 4 bytes (invalid UTF-8)", () => {
    const garbage = Buffer.from([0x80, 0x80, 0x80, 0x80]); // bare continuations
    const buf = Buffer.concat([ascii, garbage]);
    expect(trimIncompleteUtf8Tail(buf)).toEqual(ascii);
  });
});

describe("runAgentTurn", () => {
  it("pipes prompt via stdin and resolves stdout", async () => {
    const fixture = createEchoAgentScript("claude");
    try {
      const out = await runAgentTurn({ execPath: fixture.agentPath, prompt: "hello agent", timeoutMs: 30_000 });
      expect(out).toContain("hello agent");
    } finally {
      fixture.cleanup();
    }
  });

  it("strategy agents receive the prompt as argv", async () => {
    // Echo agent prints its first argument (the argv prompt for strategy
    // agents) instead of stdin.
    const fixture = createEchoAgentScript("codex", { recordArgs: true, echoArg: 2 });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "codex",
        prompt: "argv-prompt-here",
        timeoutMs: 30_000,
      });
      expect(out).toContain("argv-prompt-here");
      const args = fixture.recordedArgs();
      expect(args).toContain("exec");
      expect(args).toContain("argv-prompt-here");
    } finally {
      fixture.cleanup();
    }
  });

  it("strategy agents fall back to stdin past the argv length cap", async () => {
    // Long prompt -> buildAgentArgs returns [] -> stdin mode. The fixture
    // echoes stdin when no prompt arg is given.
    const fixture = createEchoAgentScript("codex", { recordArgs: true });
    try {
      const longPrompt = "x".repeat(8001);
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "codex",
        prompt: longPrompt,
        timeoutMs: 30_000,
      });
      expect(out).toContain("x".repeat(80));
      const args = fixture.recordedArgs();
      expect(args).not.toContain("exec");
    } finally {
      fixture.cleanup();
    }
  });

  it("unknown agents keep stdin mode", async () => {
    // kimi 2026-11-04、grok 2026-11-10 都有策略了；「无策略」样本改用 copilot
    //（设备端不支持它的运行时，至今没有 argv 策略）。
    const fixture = createEchoAgentScript("copilot", { recordArgs: true });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "copilot",
        prompt: "stdin-still-works",
        timeoutMs: 30_000,
      });
      expect(out).toContain("stdin-still-works");
      const args = fixture.recordedArgs();
      expect(args).not.toContain("-p");
      expect(args).not.toContain("run");
      expect(args).not.toContain("exec");
    } finally {
      fixture.cleanup();
    }
  });

  // 这条钉住生产事故的修复方向：kimi 必须以 -p 启动（argv 模式），
  // 而不是退化成「裸 kimi」——裸 kimi 是交互式 TUI，在 Windows 上拿不到
  // console 时会直接以 `No Windows console found` 退出。
  it("kimi 以 -p 启动并把 prompt 作为 argv 传入（不再是 stdin 兜底）", async () => {
    const fixture = createEchoAgentScript("kimi", { recordArgs: true });
    try {
      await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "kimi",
        prompt: "kimi-argv-prompt",
        timeoutMs: 30_000,
      });
      const args = fixture.recordedArgs();
      expect(args).toContain("-p");
      expect(args).toContain("kimi-argv-prompt");
      expect(args).toContain("--output-format");
    } finally {
      fixture.cleanup();
    }
  });

  // pi/omp 的策略是「argv 定模式 + prompt 走 stdin」：argvMode 分支若不写
  // stdin，omp 收到空输入只吐一行 session 事件就退出，回合「成功」但正文为空
  // （2026-11-10 现场）。这条钉住 stdin 必写。
  it("omp 在 argv 模式下仍把 prompt 写进 stdin", async () => {
    const fixture = createEchoAgentScript("omp");
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "omp",
        model: "quukk/glm-5.2",
        prompt: "omp-stdin-prompt",
        timeoutMs: 30_000,
      });
      expect(out).toContain("omp-stdin-prompt");
    } finally {
      fixture.cleanup();
    }
  });

  // kimi 的 stream-json 事件是 {role:"assistant",content:…}（没有 type 字段），
  // 没有专属分支时整份 JSONL 会被当成正文流出去（2026-11-10 现场）。
  it("kimi stream-json 只把 assistant 的 content 当正文", async () => {
    const lines = [
      '{"role":"meta","type":"system.version","version":"2.5.2"}',
      '{"role":"assistant","content":"OK"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"kimi -r s1"}',
    ].join("\n") + "\n";
    const fixture = createEchoAgentScript("kimi", { stdoutText: lines });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "kimi",
        prompt: "hi",
        timeoutMs: 30_000,
      });
      expect(out).toBe("OK");
    } finally {
      fixture.cleanup();
    }
  });

  // ── qwen 思考流（feat/qwen-reasoning）回归 ────────────────────────────────
  // 现场走查：群里 qwen 回答只有正文、没有思考内容（claude/codex/opencode/hermes
  // 都有），根因就是 qwen 不在 STREAM_JSON_AGENTS。这组用例按 qwen 0.25.3 的
  // 真实事件形状（本机 2026-11-04 实测抓取）钉住：argv 形态、思考/正文分道、
  // 权威正文、argv 超长回退 stdin 仍能答。
  const qwenTurnStdout = [
    '{"type":"system","subtype":"init","session_id":"s1","model":"glm-5.2","qwen_code_version":"0.25.3"}',
    '{"type":"stream_event","uuid":"u0","session_id":"s1","parent_tool_use_id":null,"event":{"type":"goal_state","goal_state":{"v":2,"goal":null,"activity":"idle"}}}',
    '{"type":"stream_event","uuid":"u2","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}',
    '{"type":"stream_event","uuid":"u3","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"用户要"}}}',
    '{"type":"stream_event","uuid":"u4","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"一个字"}}}',
    '{"type":"stream_event","uuid":"u5","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_stop","index":0}}',
    '{"type":"stream_event","uuid":"u8","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}}',
    '{"type":"stream_event","uuid":"u9","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_stop","index":0}}',
    '{"type":"stream_event","uuid":"u10","session_id":"s1","parent_tool_use_id":null,"event":{"type":"message_stop"}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"好"}',
  ].join("\n") + "\n";

  it("qwen：思考与正文分道流式回调，终值取 result 权威全文", async () => {
    const fixture = createEchoAgentScript("qwen", { stdoutText: qwenTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "qwen",
        prompt: "只回答一个字：好",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
      });
      expect(out).toBe("好");
      expect(reasoning.join("")).toBe("用户要一个字");
      expect(chunks.join("")).toBe("好");
    } finally {
      fixture.cleanup();
    }
  });

  it("qwen：argv 形态带 -p 与 stream-json 开关（含 --model 裸 slug）", async () => {
    const fixture = createEchoAgentScript("qwen", { recordArgs: true });
    try {
      await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "qwen",
        prompt: "只回答一个字：好",
        model: "quukk/glm-5.2",
        timeoutMs: 30_000,
      });
      const args = fixture.recordedArgs();
      expect(args).toContain("-p");
      expect(args).toContain("stream-json");
      expect(args).toContain("--include-partial-messages");
      expect(args).toContain("--model");
      expect(args).toContain("glm-5.2");
    } finally {
      fixture.cleanup();
    }
  });

  it("qwen：超长 prompt 回退 stdin 模式（-p 官方兼容 stdin），解析链不降级", async () => {
    // recordArgs 与 stdoutText 在 fixture 里互斥，argv 形态断言在上面那条用例。
    const fixture = createEchoAgentScript("qwen", { stdoutText: qwenTurnStdout });
    try {
      const reasoning: string[] = [];
      // 超长 prompt：strategy 退回 []，走 stdin 模式（qwen -p 明确兼容 stdin 输入，
      // 实测 `qwen -p <prompt> < /dev/null` 正常作答）。fixture 始终吐同一份
      // JSONL，正好验证 stdin 形态下整条 stream-json 解析链原样工作。
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "qwen",
        prompt: "x".repeat(8001),
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
      });
      // stdin 模式没有 argv 策略 → 不进 stream-json 解析，stdout 原样透传
      // （文本形态的正文兜底），思考通道为空 —— 回退不挂、不失败，正文完整。
      expect(out).toContain('"type":"result"');
      expect(reasoning.join("")).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  // ── B 类十家思考流回归（2026-11-04 批量接入）──────────────────────────────
  // cursor-agent：事件形状按**仓内真实抓包**逐字构造
  // （server/pkg/agent/testdata/cursor-agent-2026.07.20-stream-json.jsonl，
  // 字段零猜测）：顶层 thinking/subtype=delta 事件是思考，assistant/result
  // 是正文与权威全文，subtype=completed 与 system/user/tool_call 全部丢弃。
  const cursorTurnStdout = [
    '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"ebb","model":"Auto","permissionMode":"default"}',
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"session_id":"ebb"}',
    '{"type":"thinking","subtype":"delta","text":"Reading notes.txt.","session_id":"ebb","timestamp_ms":1784819288883}',
    '{"type":"thinking","subtype":"delta","text":" Running wc.","session_id":"ebb","timestamp_ms":1784819289514}',
    '{"type":"thinking","subtype":"completed","session_id":"ebb","timestamp_ms":1784819289515}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"notes.txt has 3 lines."}]},"session_id":"ebb"}',
    '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"wc -l notes.txt"}}},"session_id":"ebb"}',
    '{"type":"tool_call","subtype":"completed","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"wc -l notes.txt"},"result":{"success":{"stdout":"       3 notes.txt\\n"}}}},"session_id":"ebb"}',
    '{"type":"thinking","subtype":"delta","text":"Finished.","session_id":"ebb","timestamp_ms":1784819294133}',
    '{"type":"thinking","subtype":"completed","session_id":"ebb","timestamp_ms":1784819294133}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"3 lines written."}]},"session_id":"ebb"}',
    '{"type":"result","subtype":"success","duration_ms":9679,"is_error":false,"result":"notes.txt has 3 lines.3 lines written.","session_id":"ebb"}',
  ].join("\n") + "\n";

  it("cursor-agent：思考与正文分道（真实抓包形状），未知 subtype 丢弃", async () => {
    const fixture = createEchoAgentScript("cursor-agent", { stdoutText: cursorTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "cursor-agent",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
      });
      // 权威全文取 result.result（两段 assistant 全文的拼接，与抓包行为一致）。
      expect(out).toBe("notes.txt has 3 lines.3 lines written.");
      expect(reasoning.join("")).toBe("Reading notes.txt. Running wc.Finished.");
      expect(chunks.join("")).toBe("notes.txt has 3 lines.3 lines written.");
    } finally {
      fixture.cleanup();
    }
  });

  // codebuddy：Claude Code fork，事件与 claude 完全同形（上游 codebuddy.go:414-417
  // 的 thinking 块与 claude 分支同款）。
  const codebuddyTurnStdout = [
    '{"type":"system","subtype":"init","session_id":"cb1","model":"glm-5.2"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先查一下"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"目录结构"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"目录是 src/"}}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"目录是 src/"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"目录是 src/"}',
  ].join("\n") + "\n";

  it("codebuddy：claude 分支直接消化 thinking_delta（fork 同形协议）", async () => {
    const fixture = createEchoAgentScript("codebuddy", { stdoutText: codebuddyTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "codebuddy",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
      });
      expect(out).toBe("目录是 src/");
      expect(reasoning.join("")).toBe("先查一下目录结构");
      expect(chunks.join("")).toBe("目录是 src/");
    } finally {
      fixture.cleanup();
    }
  });

  // pi / omp：上游 pi.go:545-559 的 message_update 事件（thinking_delta /
  // text_delta 的增量在 assistantMessageEvent.delta）。
  const piTurnStdout = [
    '{"type":"agent_start"}',
    '{"type":"turn_start"}',
    '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"想想"}}',
    '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"再答"}}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"答"}}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"案"}}',
    '{"type":"tool_execution_start","toolCallId":"tc1","toolName":"bash","args":{"command":"ls"}}',
    '{"type":"tool_execution_end","toolCallId":"tc1","result":"file.txt"}',
    '{"type":"turn_end","message":{"role":"assistant","model":"m","usage":{"input":1,"output":2}}}',
  ].join("\n") + "\n";

  it("pi：message_update 的 thinking_delta/text_delta 分道，tool_execution 进 activity", async () => {
    const fixture = createEchoAgentScript("pi", { stdoutText: piTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const steps: unknown[][] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "pi",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
        onActivity: (s) => { steps.push(s); },
      });
      // pi 没有 result 帧：终值由 extractStreamJsonFinalText 的增量聚合给出。
      expect(out).toBe("答案");
      expect(reasoning.join("")).toBe("想想再答");
      expect(chunks.join("")).toBe("答案");
      const last = steps.at(-1) as { label: string; status: string; outputDetail?: string }[];
      expect(last?.[0]).toMatchObject({ label: "执行命令", status: "done", outputDetail: "file.txt" });
    } finally {
      fixture.cleanup();
    }
  });

  it("omp：与 pi 共享同一解析分支（同协议家族）", async () => {
    const fixture = createEchoAgentScript("omp", { stdoutText: piTurnStdout });
    try {
      const reasoning: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "omp",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
      });
      expect(out).toBe("答案");
      expect(reasoning.join("")).toBe("想想再答");
    } finally {
      fixture.cleanup();
    }
  });

  // kimi：官方明示 stream-json 不写 thinking —— 升级的是**正文流**（逐字 +
  // result 权威全文），思考通道预期为空。如实断言空思考，不虚构。
  const kimiTurnStdout = [
    '{"type":"system","subtype":"init","session_id":"k1","model":"kimi-for-coding"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"呀"}}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"你好呀"}',
  ].join("\n") + "\n";

  it("kimi：正文流升级（逐字上屏 + 权威全文），思考通道如实为空", async () => {
    const fixture = createEchoAgentScript("kimi", { stdoutText: kimiTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "kimi",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
      });
      expect(out).toBe("你好呀");
      expect(chunks.join("")).toBe("你好呀");
      expect(reasoning.join("")).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  // dsh：版本化 stdio JSONL（v=1）原生 thinking 帧；stdin 收 execute 命令帧
  // （prompt 与模型都在命令里），stdout 帧按 dsh.go:376-434 的形状。
  const dshTurnStdout = [
    '{"v":1,"type":"ready","runtime":"dsh"}',
    '{"v":1,"type":"session","session_id":"d1"}',
    '{"v":1,"type":"thinking","content":"先想"}',
    '{"v":1,"type":"thinking","content":"后答"}',
    '{"v":1,"type":"text","content":"答"}',
    '{"v":1,"type":"text","content":"案在此"}',
    '{"v":1,"type":"tool_call","call_id":"dc1","name":"terminal","arguments":"{\\"command\\":\\"ls\\"}"}',
    '{"v":1,"type":"tool_result","call_id":"dc1","output":"file.txt"}',
    '{"v":1,"type":"result","status":"completed","output":"答案在此"}',
  ].join("\n") + "\n";

  it("dsh：thinking 帧进思考、text 帧进正文、execute 命令写进 stdin", async () => {
    const fixture = createEchoAgentScript("dsh", { stdoutText: dshTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const steps: unknown[][] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "dsh",
        prompt: "hi",
        model: "deepseek/dsh-r2",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
        onActivity: (s) => { steps.push(s); },
      });
      expect(out).toBe("答案在此");
      expect(reasoning.join("")).toBe("先想后答");
      expect(chunks.join("")).toBe("答案在此");
      const last = steps.at(-1) as { label: string; status: string; inputDetail?: string }[];
      expect(last?.[0]).toMatchObject({ label: "执行命令", status: "done", inputDetail: "ls" });
    } finally {
      fixture.cleanup();
    }
  });

  it("dsh：stdin 收到的是 v=1 execute 命令帧（prompt 与模型在内），不是裸文本", async () => {
    // stdoutText 与 stdin 探测共存：fixture 的 fixed-agent 只吐固定 stdout，
    // stdin 落地进 args 文件的验证交给下面的专用 fixture（recordArgs + 裸跑）。
    // 这里直接用 node 脚本把 stdin 原样回显，检查 execute 帧的字段。
    const dir = mkdtempSync(join(tmpdir(), "cm-dsh-stdin-"));
    const helper = join(dir, "dsh-stdin.cjs");
    writeFileSync(helper, [
      "let buf='';",
      "process.stdin.on('data',(d)=>{buf+=d;});",
      "process.stdin.on('end',()=>{",
      "  process.stdout.write(buf);",
      "  process.exit(0);",
      "});",
    ].join("\n"));
    const isWin = process.platform === "win32";
    const agentPath = join(dir, isWin ? "dsh.cmd" : "dsh");
    if (isWin) {
      writeFileSync(agentPath, `@echo off\r\nnode "${helper}"\r\n`, { mode: 0o755 });
    } else {
      writeFileSync(agentPath, `#!/bin/sh\nexec node "${helper}"\n`, { mode: 0o755 });
    }
    try {
      const out = await runAgentTurn({
        execPath: agentPath,
        agentName: "dsh",
        prompt: "问题正文",
        model: "deepseek/dsh-r2",
        timeoutMs: 30_000,
      });
      const frame = JSON.parse(out.trim());
      expect(frame).toMatchObject({
        v: 1,
        type: "execute",
        prompt: "问题正文",
        model: { provider: "deepseek", id: "dsh-r2" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // agy：上游 antigravity.go 的 stream-json 骨架（init/step_update/result），
  // 正文在 step_update.text_delta（step_type=agent_response），权威全文在
  // result.result.response。思考字段未实测 → 宽松匹配（置信度中）。
  const agyTurnStdout = [
    '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3-pro"}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"ACTIVE","step_type":"thinking","thinking_delta":"琢磨一下"}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"答"}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"案了"}}',
    '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"答案了"}}',
  ].join("\n") + "\n";

  it("agy：宽松思考匹配（thinking_delta）+ 正文走 text_delta + result 权威全文", async () => {
    const fixture = createEchoAgentScript("agy", { stdoutText: agyTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "agy",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
      });
      expect(out).toBe("答案了");
      expect(reasoning.join("")).toBe("琢磨一下");
      expect(chunks.join("")).toBe("答案了");
    } finally {
      fixture.cleanup();
    }
  });

  // traecli / qodercli：exec --json 与 stream-json 的 thought 字段待装机实测
  // （报告三点存疑之二）→ 宽松匹配分支。fixture 按「字段名候选」构造，
  // 断言宽松匹配命中且不误吞正文。
  it("traecli/qodercli：宽松思考匹配命中 thinking/thought/reasoning 任一增量", () => {
    // 直接测 parseStreamJsonLine（fixture 端到端在 chat-stream.test.ts 的
    // 真实形状组里）。
    expect(parseStreamJsonLine('{"type":"assistant","thought":"想着"}')).toEqual({ reasoning: "想着" });
    expect(parseStreamJsonLine('{"type":"assistant","thinking":"想着"}')).toEqual({ reasoning: "想着" });
    expect(parseStreamJsonLine('{"type":"assistant","reasoning":"想着"}')).toEqual({ reasoning: "想着" });
    // 嵌套对象形态（thought:{delta/text/content}）
    expect(parseStreamJsonLine('{"type":"assistant","thought":{"delta":"嵌套"}}'))
      .toEqual({ reasoning: "嵌套" });
    // 非 agent 事件（result/system/usage）即使带同名字段也不该误吞——
    // 但宽松匹配按字段形状判断，字符串字段就是思考。真正要防的是
    // 正文通道不被污染：text/result/agent_message 走各自精确分支。
    expect(parseStreamJsonLine('{"type":"result","result":"正文全文"}')).toEqual({ text: "正文全文" });
    // 空/非字符串字段不命中
    expect(parseStreamJsonLine('{"type":"assistant","thought":""}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"assistant","thought":{"extra":1}}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"assistant"}')).toBeNull();
  });

  it("traecli：exec --json 端到端（宽松思考 + 正文提取）", async () => {
    // exec JSONL 真实事件流骨架（官方文档自述 --json 输出事件流；thought
    // 字段按宽松匹配兜住——装机实测后收窄字段名）。
    const traecliTurnStdout = [
      '{"type":"system","subtype":"init","session_id":"t1"}',
      '{"type":"assistant","thought":"先看看文件"}',
      '{"type":"assistant","text":"文件已读"}',
      '{"type":"result","result":"文件已读"}',
    ].join("\n") + "\n";
    const fixture = createEchoAgentScript("traecli", { stdoutText: traecliTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "traecli",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
      });
      expect(out).toBe("文件已读");
      expect(reasoning.join("")).toBe("先看看文件");
      expect(chunks.join("")).toBe("文件已读");
    } finally {
      fixture.cleanup();
    }
  });

  it("qodercli：stream-json 端到端（claude 同形骨架 + 宽松思考）", async () => {
    const qoderTurnStdout = [
      '{"type":"system","subtype":"init","session_id":"q1","model":"qoder-model"}',
      '{"type":"assistant","reasoning":"想想再答"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"答出来了"}}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"答出来了"}',
    ].join("\n") + "\n";
    const fixture = createEchoAgentScript("qodercli", { stdoutText: qoderTurnStdout });
    try {
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "qodercli",
        prompt: "hi",
        timeoutMs: 30_000,
        onReasoningChunk: (c) => { reasoning.push(c); },
        onChunk: (c) => { chunks.push(c); },
      });
      expect(out).toBe("答出来了");
      expect(reasoning.join("")).toBe("想想再答");
      expect(chunks.join("")).toBe("答出来了");
    } finally {
      fixture.cleanup();
    }
  });

  it("qoderclicn：与 qodercli 共享解析（纯注册），argv 一致", async () => {
    const fixture = createEchoAgentScript("qoderclicn", { recordArgs: true });
    try {
      await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "qoderclicn",
        prompt: "hi",
        timeoutMs: 30_000,
      });
      const args = fixture.recordedArgs();
      expect(args).toContain("-p");
      expect(args).toContain("stream-json");
    } finally {
      fixture.cleanup();
    }
  });

  it("passes --model for agents with an argv strategy", async () => {
    const fixture = createEchoAgentScript("claude", { recordArgs: true });
    try {
      await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "claude",
        prompt: "p",
        model: "sonnet-4",
        timeoutMs: 30_000,
      });
      const args = fixture.recordedArgs();
      expect(args).toContain("--model");
      expect(args).toContain("sonnet-4");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not inject --model for an agent with no argv strategy", async () => {
    // 现场（2026-10-25）：给不认 `--model` 的 CLI 追加参数，等于让它更早退出
    // （usage dump + exit 1），用户看到的是「进程异常退出」。没有策略就不猜。
    const fixture = createEchoAgentScript("grok", { recordArgs: true });
    try {
      await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "grok",
        prompt: "p",
        model: "m1",
        timeoutMs: 30_000,
      });
      expect(fixture.recordedArgs()).not.toContain("--model");
    } finally {
      fixture.cleanup();
    }
  });

  it("omits --model when not provided", async () => {
    const fixture = createEchoAgentScript("claude", { recordArgs: true });
    try {
      await runAgentTurn({ execPath: fixture.agentPath, prompt: "p", timeoutMs: 30_000 });
      expect(fixture.recordedArgs()).not.toContain("--model");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects on timeout", async () => {
    const fixture = createEchoAgentScript("claude", { hangMs: 8000 });
    try {
      await expect(
        runAgentTurn({ execPath: fixture.agentPath, prompt: "p", timeoutMs: 500 }),
      ).rejects.toThrow(/timeout/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("truncates stdout beyond maxOutputBytes", async () => {
    const fixture = createEchoAgentScript("claude", { bigOutputBytes: 200_000 });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        prompt: "p",
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      });
      expect(out.length).toBeLessThanOrEqual(1024);
      expect(out).toBe("a".repeat(1024));
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps CJK characters intact when a code point splits across stdout chunks", async () => {
    const fixture = createEchoAgentScript("claude", { cjkSplit: true, cjkRepeat: 100 });
    try {
      const chunks: string[] = [];
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        prompt: "p",
        timeoutMs: 30_000,
        onChunk: (c) => { chunks.push(c); },
      });
      const expected = "你好".repeat(100);
      expect(out).toBe(expected);
      expect(out).not.toContain("\uFFFD");
      expect(chunks.join("")).toBe(out);
    } finally {
      fixture.cleanup();
    }
  });

  it("truncates CJK output on a byte cap without corrupting the cut", async () => {
    // 100 CJK chars = 300 UTF-8 bytes; cap 100 bytes holds 33 complete chars
    // (99 bytes: 16 full 你好 pairs + one 你); the 34th char's dangling lead
    // byte must be dropped, never decoded to U+FFFD.
    const fixture = createEchoAgentScript("claude", { cjkSplit: true, cjkRepeat: 50 });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        prompt: "p",
        timeoutMs: 30_000,
        maxOutputBytes: 100,
      });
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(100);
      expect(out).toBe("你好".repeat(16) + "你");
      expect(out).not.toContain("\uFFFD");
    } finally {
      fixture.cleanup();
    }
  });

  // 线上现场（2026-10-20 10:54，运维助手 opencode）：跑到第 7 个工具时 stdout
  // 超过缓冲上限，旧实现在超限处直接 return —— 后半轮（含最终回答）整段丢掉，
  // 却仍然 resolve 出一个「completed」，前端于是把半句话当完整回答展示。
  // 现在缓冲满了只停止攒原始字节，解析继续，正文照样能拿到结尾。
  it("缓冲被截断后仍把后半轮的正文交出来，而不是只交前缀", async () => {
    const pad = JSON.stringify({ type: "reasoning", part: { id: "r1", type: "reasoning", text: "x".repeat(3_000) } });
    const answer = JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "最终答案：模型列表已拉到。" } });
    const fixture = createEchoAgentScript("opencode", { stdoutText: `${pad}\n${pad}\n${answer}\n` });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "opencode",
        prompt: "列出可用模型列表",
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
        onReasoningChunk: () => {},
      });
      expect(out).toBe("最终答案：模型列表已拉到。");
    } finally {
      fixture.cleanup();
    }
  });

  // 缓冲截断可以继续解析；但输出到硬上限就是这一轮已经不可信（agent 在喷日志），
  // 这时必须**失败**收尾，并把已产出的正文带出去，绝不能假装答完。
  it("输出超过硬上限时以 output_truncated 失败收尾，并带上已产出的正文", async () => {
    const pad = JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "半句话" } });
    const fixture = createEchoAgentScript("opencode", { stdoutText: pad.repeat(400) });
    try {
      await expect(runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "opencode",
        prompt: "p",
        timeoutMs: 30_000,
        maxOutputBytes: 512,
        hardOutputBytes: 2_048,
        onReasoningChunk: () => {},
      })).rejects.toMatchObject({ code: "output_truncated" });
    } finally {
      fixture.cleanup();
    }
  });

  // openclaw 信封自己说「这轮被中止 / 被截断」时，正文通常只剩半句前言。
  // 必须判失败（agent_incomplete），否则前端把它当完整回答展示。
  it("openclaw 信封说本轮被中止时判失败，并保留半截正文", async () => {
    const envelope = JSON.stringify({
      payloads: [{ text: "我先看看有哪些技能：", isReasoning: false }],
      meta: { aborted: true, completion: { finishReason: "aborted" }, finalAssistantVisibleText: "我先看看有哪些技能：" },
    });
    const fixture = createEchoAgentScript("openclaw", { stdoutText: envelope });
    try {
      await expect(runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "openclaw",
        prompt: "列出可用模型列表",
        timeoutMs: 30_000,
      })).rejects.toMatchObject({ code: "agent_incomplete", partialText: "我先看看有哪些技能：" });
    } finally {
      fixture.cleanup();
    }
  });

  it("openclaw 正常收尾（finishReason=stop）仍然算完成", async () => {
    const envelope = JSON.stringify({
      payloads: [{ text: "已经重启完成。" }],
      meta: { aborted: false, completion: { finishReason: "stop" }, finalAssistantVisibleText: "已经重启完成。" },
    });
    const fixture = createEchoAgentScript("openclaw", { stdoutText: envelope });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "openclaw",
        prompt: "重启一下",
        timeoutMs: 30_000,
      });
      expect(out).toBe("已经重启完成。");
    } finally {
      fixture.cleanup();
    }
  });

  // 现场（2026-10-20 10:54，运维助手 opencode）：问「列出可用模型列表」，模型先
  // 说「已登录。拉取模型列表：」，接着 bash 报错、进程 exit 0，之后再没吐过一个
  // 字。opencode 自己的会话库可确认：该轮最后一条 part 是 bash(error)，其后既无
  // 文本也无新步骤。我们把 exit 0 当成「答完了」，前端就把这半句前言当完整回答。
  it("撞在失败的工具上就没下文时判 agent_incomplete", async () => {
    const lines = [
      JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "已登录。拉取模型列表：" } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "c1", state: { status: "error", input: { command: "arkcli models list" } } } }),
    ].join("\n") + "\n";
    const fixture = createEchoAgentScript("opencode", { stdoutText: lines });
    try {
      await expect(runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "opencode",
        prompt: "列出可用模型列表",
        timeoutMs: 30_000,
        onReasoningChunk: () => {},
        onActivity: () => {},
      })).rejects.toMatchObject({
        code: "agent_incomplete",
        partialText: "已登录。拉取模型列表：",
        // failedStep 结构化带出失败命令：im.ts 靠它自动补跑一轮。
        failedStep: { label: "执行命令", command: "arkcli models list" },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("工具失败之后模型补了说明，就不算没答完", async () => {
    const lines = [
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "c1", state: { status: "error" } } }),
      JSON.stringify({ type: "text", part: { id: "p2", type: "text", text: "命令报了 ENOENT，这机器上没装 arkcli。" } }),
    ].join("\n") + "\n";
    const fixture = createEchoAgentScript("opencode", { stdoutText: lines });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "opencode",
        prompt: "列出可用模型列表",
        timeoutMs: 30_000,
        onReasoningChunk: () => {},
        onActivity: () => {},
      });
      expect(out).toContain("没装 arkcli");
    } finally {
      fixture.cleanup();
    }
  });

  // serve 是新路径：旧版 opencode 没有 serve 子命令，起来就退。这时必须无声
  // 退回 run --format json —— 流式改造不能让一轮直接失败。
  it("serve 起不来时自动回退到 run，正文照样拿到", async () => {
    const prevServer = process.env.CLAWMESSENGER_OPENCODE_SERVER;
    const prevFull = process.env.CLAWMESSENGER_OPENCODE_FULL_CONFIG;
    delete process.env.CLAWMESSENGER_OPENCODE_SERVER;
    // 别在测试里派生设备端配置（那会动 ~/.agentsbb）。
    process.env.CLAWMESSENGER_OPENCODE_FULL_CONFIG = "1";
    const answer = JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "老版本也能答" } });
    const fixture = createEchoAgentScript("opencode", { stdoutText: `${answer}\n` });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "opencode",
        prompt: "p",
        timeoutMs: 30_000,
        onReasoningChunk: () => {},
      });
      expect(out).toBe("老版本也能答");
    } finally {
      if (prevServer === undefined) delete process.env.CLAWMESSENGER_OPENCODE_SERVER;
      else process.env.CLAWMESSENGER_OPENCODE_SERVER = prevServer;
      if (prevFull === undefined) delete process.env.CLAWMESSENGER_OPENCODE_FULL_CONFIG;
      else process.env.CLAWMESSENGER_OPENCODE_FULL_CONFIG = prevFull;
      fixture.cleanup();
    }
  });

  it("最后一步成功但没写结尾时不算没答完（不误报）", async () => {
    const lines = [
      JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "已重启。" } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed" } } }),
    ].join("\n") + "\n";
    const fixture = createEchoAgentScript("opencode", { stdoutText: lines });
    try {
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "opencode",
        prompt: "重启",
        timeoutMs: 30_000,
        onReasoningChunk: () => {},
        onActivity: () => {},
      });
      expect(out).toContain("已重启");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects immediately when the signal is already aborted", async () => {    const fixture = createEchoAgentScript("claude");
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        runAgentTurn({ execPath: fixture.agentPath, prompt: "p", timeoutMs: 30_000, signal: controller.signal }),
      ).rejects.toThrow(/abort/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects with stderr context on nonzero exit", async () => {
    const fixture = createEchoAgentScript("claude", { failWith: { code: 3, message: "agent-boom" } });
    try {
      await expect(
        runAgentTurn({ execPath: fixture.agentPath, prompt: "p", timeoutMs: 30_000 }),
      ).rejects.toThrow(/agent-boom/);
    } finally {
      fixture.cleanup();
    }
  });

  // ── 事故核心回归（2026-10-25 私有设备私聊）──────────────────────────────
  // kimi 的登录横幅打在 **stdout** 上、stderr 为空，然后 exit 1。旧实现只拼
  // stderr，错误串是 "agent exited with code 1: "，前端于是说「进程异常退出，
  // 没有任何输出」，classifyTurnError 也归成 agent_failed。用户永远不知道该去
  // 登录/换 key —— 这条用例就是钉住「原因必须能被看见、被分类」。
  it("把 stdout 尾巴并进错误串，kimi 的登录横幅不再变成「没有任何输出」", async () => {
    const banner = [
      "Kimi Code CLI",
      "Session: abc",
      "Tip: send /login to use Kimi for Code",
    ].join("\n");
    const fixture = createStdoutFailureAgent("kimi", `${banner}\n`, 1);
    try {
      const error = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "kimi",
        prompt: "hi",
        timeoutMs: 30_000,
      }).then(() => null, (err: Error) => err);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("agent exited with code 1");
      expect(message).toContain("[stdout tail]");
      expect(message).toContain("Tip: send /login to use Kimi for Code");
      // 分类器必须认得出这是鉴权/未登录，不是「未知崩溃」。
      expect(classifyTurnError(message)).toBe("model_auth_failed");
    } finally {
      fixture.cleanup();
    }
  });

  it("stdout 为空时不追加空的 [stdout tail] 段", async () => {
    const fixture = createEchoAgentScript("kimi", { failWith: { code: 1, message: "agent-boom" } });
    try {
      const error = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "kimi",
        prompt: "p",
        timeoutMs: 30_000,
      }).then(() => null, (err: Error) => err);

      const message = (error as Error).message;
      expect(message).toContain("agent-boom");
      expect(message).not.toContain("[stdout tail]");
    } finally {
      fixture.cleanup();
    }
  });

  it("只带 stdout 末尾 800 字符，不把整份输出塞进错误串", async () => {
    // 洪峰场景：几 MB 的 stdout 不能整体进错误串（会撑爆日志与 wire 帧）。
    const stdout = `EARLY_MARKER${"x".repeat(4000)}\nTip: send /login to use Kimi for Code\n`;
    const fixture = createStdoutFailureAgent("kimi", stdout, 1);
    try {
      const error = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "kimi",
        prompt: "hi",
        timeoutMs: 30_000,
      }).then(() => null, (err: Error) => err);

      const message = (error as Error).message;
      // 真正的结尾（含可分类的提示）必须还在
      expect(message).toContain("Tip: send /login to use Kimi for Code");
      // 头部早就不该在
      expect(message).not.toContain("EARLY_MARKER");
      // 尾巴 800 + 前缀措辞，整体远小于原始 stdout
      expect(message.length).toBeLessThan(1_000);
      expect(classifyTurnError(message)).toBe("model_auth_failed");
    } finally {
      fixture.cleanup();
    }
  });

  it("streams chunks through onChunk before resolving", async () => {
    const fixture = createEchoAgentScript("claude");
    try {
      let chunks = "";
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        prompt: "stream me",
        timeoutMs: 30_000,
        onChunk: (c) => { chunks += c; },
      });
      expect(out).toContain("stream me");
      expect(chunks).toContain("stream me");
    } finally {
      fixture.cleanup();
    }
  });

  // openclaw 的 stdout 是 `agent --local --json` 的完整信封（含输入提示词全文
  // 与执行 trace）。一旦把原始增量当正文回调出去，web 的打字气泡里就会出现
  // 一整坨 JSON；而终帧与兜底广播给的是 extractOpenclawReply 提取后的正文，
  // 两者内容不等，web 的 streamEchoIndex 按内容相等去重就失效，聊天里于是
  // 出现一对「内容重复」的气泡（一条 JSON、一条正文）。所以 openclaw 必须
  // 跳过增量回调，只靠终帧一次性给出正文。
  it("openclaw 的 --json 信封不进增量回调，终值仍是提取后的正文", async () => {
    const envelope = JSON.stringify({
      payloads: [{ text: "正文一号", mediaUrl: null }],
      meta: {
        finalPromptText: "[group chat] 请以「rc_node_x_openclaw」的身份发言，只输出发言正文。",
        finalAssistantVisibleText: "正文一号",
        finalAssistantRawText: "正文一号",
        replyInvalid: false,
        livenessState: "working",
        executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.6-sol" },
      },
    });
    const fixture = createEchoAgentScript("openclaw", { stdoutText: envelope });
    try {
      let chunks = "";
      const out = await runAgentTurn({
        execPath: fixture.agentPath,
        agentName: "openclaw",
        prompt: "p",
        timeoutMs: 30_000,
        onChunk: (c) => { chunks += c; },
      });
      // 信封一个字符都不许流进增量 —— 它就是气泡里那坨 JSON 的来源。
      expect(chunks).toBe("");
      // 但终值仍然要拿到提取后的正文，不能因此变成空回复。
      expect(out).toBe("正文一号");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects promptly when the signal aborts", async () => {
    const fixture = createEchoAgentScript("claude", { hangMs: 8000 });
    try {
      const controller = new AbortController();
      const pending = runAgentTurn({
        execPath: fixture.agentPath,
        prompt: "p",
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 300);
      await expect(pending).rejects.toThrow(/abort/i);
    } finally {
      fixture.cleanup();
    }
  });
});

// 被测的 resolveWindowsShim 只在 win32 上生效（其它平台第 300 行直接返回
// false），所以这组用例在 Linux/macOS 上必然失败——按平台跳过，而不是让它
// 在 CI 里装成一个真实的回归。
describe.skipIf(process.platform !== "win32")("Windows .cmd shim 穿透（cmd.exe 会截断多行提示词）", () => {
  it("能认出 npm shim 的真实目标：真 exe 直接跑，脚本交给同目录 node.exe", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "cm-shim-"));

    // opencode 形态：目标本身就是 exe
    const binDir = join(dir, "node_modules", "pkg", "bin");
    await mkdir(binDir, { recursive: true });
    const exeTarget = join(binDir, "cli.exe");
    await writeFile(exeTarget, "");
    const exeShim = join(dir, "opencode.cmd");
    await writeFile(
      exeShim,
      ['@ECHO off', 'GOTO start', ':start', 'SETLOCAL', `"%dp0%\\node_modules\\pkg\\bin\\cli.exe"   %*`].join("\r\n"),
    );
    expect(resolveWindowsShim(exeShim)).toEqual({ file: exeTarget, prefixArgs: [] });

    // openclaw 形态：目标是 .mjs，且 shim 同目录有 node.exe
    const nodeExe = join(dir, "node.exe");
    await writeFile(nodeExe, "");
    const mjsTarget = join(dir, "node_modules", "oc", "openclaw.mjs");
    await mkdir(join(dir, "node_modules", "oc"), { recursive: true });
    await writeFile(mjsTarget, "");
    const mjsShim = join(dir, "openclaw.cmd");
    await writeFile(
      mjsShim,
      [
        '@ECHO off',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        ')',
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\oc\\openclaw.mjs" %*`,
      ].join("\r\n"),
    );
    const resolved = resolveWindowsShim(mjsShim);
    expect(resolved?.file).toBe(nodeExe);
    expect(resolved?.prefixArgs).toEqual([mjsTarget]);
    expect(existsSync(resolved!.prefixArgs[0])).toBe(true);

    // 目标不存在 → 不硬来，返回 null（调用方退回 cmd.exe）
    const broken = join(dir, "broken.cmd");
    await writeFile(broken, '"%dp0%\\node_modules\\nope\\gone.exe" %*');
    expect(resolveWindowsShim(broken)).toBeNull();

    // 非 npm shim（认不出目标）→ null
    const weird = join(dir, "weird.cmd");
    await writeFile(weird, "@ECHO off\r\necho hello\r\n");
    expect(resolveWindowsShim(weird)).toBeNull();
  });

  it("buildSpawnInvocation：解析成功就不再经 cmd.exe；失败则退回 cmd.exe 并抹掉换行", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cm-spawn-"));
    const binDir = join(dir, "node_modules", "pkg", "bin");
    await mkdir(binDir, { recursive: true });
    const target = join(binDir, "cli.exe");
    await writeFile(target, "");
    const shim = join(dir, "pkg.cmd");
    await writeFile(shim, `"%dp0%\\node_modules\\pkg\\bin\\cli.exe"   %*`);

    const viaReal = buildSpawnInvocation(shim, ["run", "line1\nline2"]);
    expect(viaReal.file).toBe(target);
    expect(viaReal.args).toEqual(["run", "line1\nline2"]);

    const unresolvable = join(dir, "plain.cmd");
    await writeFile(unresolvable, "@ECHO off\r\necho hi\r\n");
    const viaCmd = buildSpawnInvocation(unresolvable, ["run", "line1\nline2"]);
    expect(viaCmd.file).toBe("cmd.exe");
    expect(viaCmd.args.every((a) => !a.includes("\n"))).toBe(true);
  });
})

describe("deviceOpencodeConfigPath", () => {
  it("精简回合写 -lean 副本，绝不与聊天轮次共用同一份配置", () => {
    const home = join(tmpdir(), "cm-home");
    // 聊天轮次：老路径，升级前后完全一致（既有设备不受影响）。
    expect(deviceOpencodeConfigPath("opencode_673", home))
      .toBe(join(home, ".agentsbb", "opencode-device-opencode_673.json"));
    // 精简回合：独立文件 —— 共用的话，私聊/群聊的 agent 会跟着丢掉工具与人设。
    expect(deviceOpencodeConfigPath("opencode_673", home, true))
      .toBe(join(home, ".agentsbb", "opencode-device-opencode_673-lean.json"));
    // 没有 agent 名的老调用方：整机一份，同样带后缀。
    expect(deviceOpencodeConfigPath(undefined, home, true))
      .toBe(join(home, ".agentsbb", "opencode-device-lean.json"));
  });
});
