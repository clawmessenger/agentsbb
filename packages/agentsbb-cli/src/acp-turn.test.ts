import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { runAgentTurn } from "./agents.js";
import {
  acpAuthMethods,
  acpChunkText,
  acpTurnModelCandidates,
  acpTurnModelId,
  AcpStartupError,
  normalizeAcpUpdateType,
  runAcpTurn,
  selectAcpPermissionOption,
  selectGrokAuthMethod,
  type AcpTurnSpec,
} from "./acp-turn.js";

// 真子进程桩：ACP 的坑几乎全在「行缓冲 / 通知与响应的时序 / 进程收尾」上，
// 用假的 spawn 实现测不出来（与 acp-discovery.test.ts 同一取舍）。
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "acp-turn-test-"));
afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

interface FixtureOptions {
  /** initialize 的 result；给 {error:...} 则回 JSON-RPC 错误。 */
  initResult?: unknown;
  initError?: { code: number; message: string };
  sessionResult?: unknown;
  /** session/new 直接报错（模拟未登录 / ACP 模式不可用）。 */
  sessionError?: { code: number; message: string };
  /** 只有续接（session/load / session/resume）报错，新建不受影响。 */
  resumeError?: { code: number; message: string };
  /** 这些 modelId 的 set_model 一律报错。 */
  failModelIds?: string[];
  /** session/prompt 期间按序推送的 update 对象。 */
  updates?: unknown[];
  stopReason?: string;
  /** prompt 之前先向 client 发一个 session/request_permission。 */
  askPermission?: boolean;
  /** 进程在 initialize 之前就退出（模拟二进制不支持 ACP）。 */
  exitBeforeInit?: boolean;
  /** 收到 prompt 就退出，不回响应（模拟中途崩溃）。 */
  crashOnPrompt?: boolean;
}

interface Fixture {
  path: string;
  logPath: string;
}

function writeServer(name: string, opts: FixtureOptions = {}): Fixture {
  const path = join(FIXTURE_DIR, `${name}.mjs`);
  const logPath = join(FIXTURE_DIR, `${name}.log`);
  const cfg = JSON.stringify(opts);
  writeFileSync(path, `
import { appendFileSync } from "node:fs";
const cfg = ${cfg};
const logPath = ${JSON.stringify(logPath)};
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function log(entry) { appendFileSync(logPath, JSON.stringify(entry) + "\\n"); }

if (cfg.exitBeforeInit) process.exit(1);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf("\\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
    nl = buffer.indexOf("\\n");
  }
});

let permissionResolve = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(line) {
  const msg = JSON.parse(line);
  // client 对服务端请求的应答：只有权限请求会收到
  if (msg.id === 900 && (msg.result || msg.error)) {
    log({ method: "permission-reply", result: msg.result ?? null, error: msg.error ?? null });
    if (permissionResolve) permissionResolve();
    return;
  }
  log({ method: msg.method, params: msg.params ?? null });

  if (msg.method === "initialize") {
    if (cfg.initError) { send({ jsonrpc: "2.0", id: msg.id, error: cfg.initError }); return; }
    send({ jsonrpc: "2.0", id: msg.id, result: cfg.initResult ?? { protocolVersion: 1 } });
    return;
  }
  if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") {
    if (cfg.sessionError) { send({ jsonrpc: "2.0", id: msg.id, error: cfg.sessionError }); return; }
    if (cfg.resumeError && msg.method !== "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, error: cfg.resumeError });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: cfg.sessionResult ?? { sessionId: "sess-1" },
    });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/set_model") {
    const modelId = msg.params?.modelId;
    if ((cfg.failModelIds ?? []).includes(modelId)) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown model " + modelId } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    if (cfg.crashOnPrompt) { process.exit(3); return; }
    if (cfg.askPermission) {
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          toolCall: { toolCallId: "t1", title: "write file" },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "deny_once", kind: "reject_once", name: "Deny" },
          ],
        },
      });
      await new Promise((r) => { permissionResolve = r; });
    }
    for (const update of cfg.updates ?? []) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update } });
      await wait(5);
    }
    // 最后一块正文故意放在响应**之后**：真实的 ACP runtime 会这样刷尾包。
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: cfg.stopReason ?? "end_turn" } });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "尾部。" } } },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method " + msg.method } });
}
`);
  return { path, logPath };
}

interface LogEntry {
  method: string;
  params: Record<string, unknown> | null;
  result?: unknown;
}

function readLog(fixture: Fixture): LogEntry[] {
  try {
    return readFileSync(fixture.logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function spec(overrides: Partial<AcpTurnSpec> = {}): AcpTurnSpec {
  return {
    args: [],
    providerFallback: "dim",
    resume: "load",
    label: "Dim Code",
    ...overrides,
  };
}

function textChunk(text: string): unknown {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

describe("acpTurnModelId / acpTurnModelCandidates", () => {
  it("strips the virtual provider prefix the catalog invented", () => {
    // 目录里裸 id 被归到 `dim/` 下才能上屏，agent 只认裸 id。
    expect(acpTurnModelId("dim/gpt-5.2", "dim")).toBe("gpt-5.2");
  });

  it("passes a real provider/model route through untouched", () => {
    expect(acpTurnModelId("quukk/glm-5.2", "dim")).toBe("quukk/glm-5.2");
    expect(acpTurnModelCandidates("quukk/glm-5.2", "dim")).toEqual(["quukk/glm-5.2"]);
  });

  it("keeps the raw route as the second candidate", () => {
    expect(acpTurnModelCandidates("dim/gpt-5.2", "dim")).toEqual(["gpt-5.2", "dim/gpt-5.2"]);
  });
});

describe("normalizeAcpUpdateType / acpChunkText", () => {
  it("accepts both schema generations and the snake/camel spellings", () => {
    expect(normalizeAcpUpdateType({ sessionUpdate: "agent_message_chunk" })).toBe("agent_message_chunk");
    expect(normalizeAcpUpdateType({ type: "agentMessageChunk" })).toBe("agent_message_chunk");
    expect(normalizeAcpUpdateType({ type: "agent_thought_chunk" })).toBe("agent_thought_chunk");
    expect(normalizeAcpUpdateType({ sessionUpdate: "tool_call_update" })).toBe("tool_call_update");
    expect(normalizeAcpUpdateType({ sessionUpdate: "something_else" })).toBe("unknown");
  });

  it("reads text out of both content shapes", () => {
    expect(acpChunkText({ content: { type: "text", text: "hi" } })).toBe("hi");
    expect(acpChunkText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
    expect(acpChunkText({ content: "raw" })).toBe("raw");
    expect(acpChunkText({})).toBe("");
  });
});

describe("selectAcpPermissionOption", () => {
  it("prefers a session-scoped grant the agent actually offered", () => {
    const choice = selectAcpPermissionOption({
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "allow_session", kind: "allow_always" },
      ],
    });
    expect(choice).toEqual({ optionId: "allow_session", grant: true });
  });

  it("falls back to allow_once, then to an offered reject_once", () => {
    expect(selectAcpPermissionOption({
      options: [{ optionId: "yes", kind: "allow_once" }],
    })).toEqual({ optionId: "yes", grant: true });
    expect(selectAcpPermissionOption({
      options: [{ optionId: "deny_once", kind: "reject_once" }],
    })).toEqual({ optionId: "deny_once", grant: false });
  });

  it("never invents an id when nothing is safely selectable", () => {
    expect(selectAcpPermissionOption({ options: [] })).toBeNull();
    expect(selectAcpPermissionOption({ options: [{ optionId: "always", kind: "reject_always" }] })).toBeNull();
  });

  it("denies this action when the turn is fs-restricted", () => {
    expect(selectAcpPermissionOption({
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "deny_once", kind: "reject_once" },
      ],
    }, { fsRestricted: true })).toEqual({ optionId: "deny_once", grant: false });
  });
});

describe("grok authentication selection", () => {
  it("uses the API key when it is offered and set, otherwise the cached login", () => {
    expect(selectGrokAuthMethod(["cached_token", "xai.api_key"], true)).toBe("xai.api_key");
    expect(selectGrokAuthMethod(["cached_token", "xai.api_key"], false)).toBe("cached_token");
    expect(selectGrokAuthMethod(["xai.api_key"], false)).toBeNull();
    expect(selectGrokAuthMethod([], false)).toBeNull();
  });

  it("reads authMethods out of the initialize result", () => {
    expect(acpAuthMethods({ authMethods: [{ id: "cached_token" }, { id: " " }] })).toEqual(["cached_token"]);
    expect(acpAuthMethods(null)).toEqual([]);
  });
});

describe("runAcpTurn", () => {
  it("runs a full handshake and returns the text after the last tool call", async () => {
    const fixture = writeServer("full-turn", {
      updates: [
        textChunk("我先看看日志。"),
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考一下" } },
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          kind: "execute",
          title: "run tests",
          rawInput: { command: "pnpm test" },
          status: "pending",
        },
        { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "ok" },
        textChunk("结论："),
        textChunk("全部通过"),
      ],
    });

    const chunks: string[] = [];
    const thoughts: string[] = [];
    const steps: string[] = [];
    const sessions: string[] = [];

    const answer = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "跑测试",
      model: "dim/gpt-5.2",
      timeoutMs: 20_000,
      onChunk: (chunk) => chunks.push(chunk),
      onReasoningChunk: (chunk) => thoughts.push(chunk),
      onActivity: (activity) => steps.push(activity.map((step) => `${step.label}:${step.status}`).join(",")),
      onSessionId: (id) => sessions.push(id),
    });

    // 旁白（工具调用之前）不能进交付物 —— 这是 Go acpDeliverableTracker 的判据。
    expect(answer).toBe("结论：全部通过尾部。");
    expect(chunks.join("")).toContain("我先看看日志。");
    expect(thoughts.join("")).toBe("思考一下");
    expect(steps[steps.length - 1]).toBe("执行命令:done");
    expect(sessions).toEqual(["sess-1"]);

    const log = readLog(fixture);
    const methods = log.map((entry) => entry.method);
    expect(methods[0]).toBe("initialize");
    expect(methods).toContain("session/new");
    // set_model 必须带剥掉虚拟前缀的裸 id，并且发生在 prompt 之前。
    const setModel = log.find((entry) => entry.method === "session/set_model");
    expect(setModel?.params).toMatchObject({ sessionId: "sess-1", modelId: "gpt-5.2" });
    expect(methods.indexOf("session/set_model")).toBeLessThan(methods.indexOf("session/prompt"));
    const prompt = log.find((entry) => entry.method === "session/prompt");
    expect(prompt?.params).toMatchObject({ sessionId: "sess-1", prompt: [{ type: "text", text: "跑测试" }] });
  });

  // 收尾必须先 session/close 再优雅退出：dim 的会话锁只在进程正常退出时交出
  // （SIGKILL 之后锁永久挂着，下一轮续接只能开新会话）。这条顺序是续接可用的
  // 前提，不是清理洁癖。
  it("closes the session before tearing the process down", async () => {
    const fixture = writeServer("close-session", { updates: [textChunk("done")] });
    await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      timeoutMs: 20_000,
    });

    const methods = readLog(fixture).map((entry) => entry.method);
    expect(methods).toContain("session/close");
    expect(methods.indexOf("session/close")).toBeGreaterThan(methods.indexOf("session/prompt"));
  });

  it("answers the agent's permission request instead of hanging", async () => {
    const fixture = writeServer("permission", {
      askPermission: true,
      updates: [textChunk("done")],
    });

    const answer = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "写个文件",
      timeoutMs: 20_000,
    });

    expect(answer).toContain("done");
    const reply = readLog(fixture).find((entry) => entry.method === "permission-reply");
    expect(reply?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  it("applies the session config options before switching models (dim)", async () => {
    const fixture = writeServer("config-options");
    await runAcpTurn({
      execPath: process.execPath,
      spec: spec({
        args: [fixture.path],
        setConfig: [
          { id: "permission", value: "full-access" },
          { id: "mode", value: "agent" },
        ],
      }),
      prompt: "hi",
      model: "dim/gpt-5.2",
      timeoutMs: 20_000,
    });

    const log = readLog(fixture);
    const config = log.filter((entry) => entry.method === "session/set_config_option");
    expect(config.map((entry) => entry.params)).toEqual([
      { sessionId: "sess-1", configId: "permission", value: "full-access" },
      { sessionId: "sess-1", configId: "mode", value: "agent" },
    ]);
    const methods = log.map((entry) => entry.method);
    expect(methods.lastIndexOf("session/set_config_option")).toBeLessThan(methods.indexOf("session/set_model"));
  });

  it("retries with the raw route when the bare id is rejected", async () => {
    const fixture = writeServer("model-fallback", { failModelIds: ["gpt-5.2"] });
    await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      model: "dim/gpt-5.2",
      timeoutMs: 20_000,
    });

    const tried = readLog(fixture)
      .filter((entry) => entry.method === "session/set_model")
      .map((entry) => entry.params?.modelId);
    expect(tried).toEqual(["gpt-5.2", "dim/gpt-5.2"]);
  });

  it("fails the turn when no candidate model is accepted", async () => {
    const fixture = writeServer("model-broken", { failModelIds: ["gpt-5.2", "dim/gpt-5.2"] });
    await expect(runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      model: "dim/gpt-5.2",
      timeoutMs: 20_000,
    })).rejects.toThrow(/无法切换到模型 dim\/gpt-5\.2/);
  });

  it("resumes with session/load when a session id is recorded", async () => {
    const fixture = writeServer("resume", { sessionResult: { sessionId: "sess-resumed" } });
    const answer = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path], resume: "load" }),
      prompt: "继续",
      timeoutMs: 20_000,
      resumeSessionId: "sess-old",
    });
    expect(answer).toBe("尾部。");

    const log = readLog(fixture);
    expect(log.some((entry) => entry.method === "session/load")).toBe(true);
    expect(log.find((entry) => entry.method === "session/load")?.params)
      .toMatchObject({ sessionId: "sess-old" });
    expect(log.some((entry) => entry.method === "session/new")).toBe(false);
  });

  it("resumes with session/resume for qoder / reasonix", async () => {
    const fixture = writeServer("resume-alt", { sessionResult: { sessionId: "sess-2" } });
    await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path], resume: "resume" }),
      prompt: "继续",
      timeoutMs: 20_000,
      resumeSessionId: "sess-old",
    });
    expect(readLog(fixture).some((entry) => entry.method === "session/resume")).toBe(true);
  });

  // 续接失败必须当场开新会话，**不能**抛错也不能回退 headless：
  // 回退 headless 就等于这家 agent 从此永久丢掉模型注入（正是要修的那个毛病）。
  it("starts a fresh session when the recorded one is gone, and reports the new id", async () => {
    const fixture = writeServer("resume-gone", {
      resumeError: { code: -32000, message: "session not found" },
      sessionResult: { sessionId: "sess-fresh" },
      updates: [textChunk("新会话")],
    });
    const sessions: string[] = [];
    const logs: string[] = [];

    const answer = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "继续",
      timeoutMs: 20_000,
      resumeSessionId: "sess-dead",
      onSessionId: (id) => sessions.push(id),
      logger: (message) => logs.push(message),
    });

    expect(answer).toContain("新会话");
    const methods = readLog(fixture).map((entry) => entry.method);
    expect(methods).toContain("session/load");
    expect(methods).toContain("session/new");
    // 新 id 必须回传，否则会话存储里会一直留着死 id。
    expect(sessions).toEqual(["sess-fresh"]);
    expect(logs.join("\n")).toMatch(/续接会话 sess-dead 失败/);
  });

  it("reports a startup failure before the prompt is sent", async () => {
    const fixture = writeServer("init-error", { initError: { code: -32603, message: "Authentication required" } });
    const err = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);

    // 这一类必须可识别：只有它允许调用方回退 headless（prompt 还没发出去）。
    expect(err).toBeInstanceOf(AcpStartupError);
    expect((err as Error).message).toMatch(/Authentication required/);
  });

  it("treats a binary that dies before initialize as a startup failure", async () => {
    const fixture = writeServer("no-acp", { exitBeforeInit: true });
    const err = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpStartupError);
  });

  it("does not present a mid-turn crash as a startup failure", async () => {
    const fixture = writeServer("crash-mid-turn", { crashOnPrompt: true });
    const err = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AcpStartupError);
  });

  it("fails when the agent cancels the prompt", async () => {
    const fixture = writeServer("cancelled", { stopReason: "cancelled" });
    await expect(runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      timeoutMs: 20_000,
    })).rejects.toThrow(/cancelled/);
  });
});

// 这些用例钉的是 **runAgentTurn 的分流**：traecli / qodercli 这类「模型只能靠
// set_model 生效」的 agent，默认必须走 ACP（agent-acp-providers.ts 的 turn 字段），
// 且 ACP 起不来时要自动回到 headless —— 否则一次 ACP 故障会让整个 agent 哑掉。
function wrapAsBinary(serverPath: string, name: string): string {
  const isWin = process.platform === "win32";
  const path = join(FIXTURE_DIR, isWin ? `${name}.cmd` : name);
  if (isWin) {
    writeFileSync(path, `@echo off\r\nnode "${serverPath}"\r\n`, { mode: 0o755 });
  } else {
    writeFileSync(path, `#!/bin/sh\nexec node "${serverPath}"\n`, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  return path;
}

describe("runAgentTurn ACP routing", () => {
  it("routes traecli through ACP and lands the selected model on set_model", async () => {
    const server = writeServer("routing-traqe", { updates: [textChunk("ACP 回答")] });
    const binary = wrapAsBinary(server.path, "traecli");
    // shim 解析后会 spawn PATH 上的 node：把当前 node 目录放进 PATH，避免机器
    // 上没装全局 node 时用例假失败。
    const originalPath = process.env.PATH;
    process.env.PATH = `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
    try {
      const answer = await runAgentTurn({
        execPath: binary,
        agentName: "traecli",
        prompt: "hi",
        model: "trae/e-1",
        timeoutMs: 20_000,
      });
      // 桩在响应之后还会补一块「尾部。」（模拟真实 runtime 的尾包刷出）。
      expect(answer).toBe("ACP 回答尾部。");
      // 目录里的虚拟 provider `trae` 必须被剥掉：agent 只认裸 id。
      const setModel = readLog(server).find((entry) => entry.method === "session/set_model");
      expect(setModel?.params).toMatchObject({ modelId: "e-1" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("falls back to the headless invocation when ACP cannot start", async () => {
    // 同一个二进制：带 ACP 参数就退出 1（旧版 CLI 不认 ACP），否则打正文。
    const scriptPath = join(FIXTURE_DIR, "no-acp-agent.mjs");
    writeFileSync(scriptPath, `
const acp = process.argv.slice(2).some((arg) => arg === "acp" || arg === "--acp");
if (acp) { process.stderr.write("unknown option: acp\\n"); process.exit(1); }
process.stdout.write("HEADLESS 回答");
`);
    const binary = wrapAsBinary(scriptPath, "qodercli");
    const originalPath = process.env.PATH;
    process.env.PATH = `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      const answer = await runAgentTurn({
        execPath: binary,
        agentName: "qodercli",
        prompt: "hi",
        timeoutMs: 20_000,
      });
      expect(answer).toBe("HEADLESS 回答");
      // 回退告警运维会看，也按双语版式：两半分开断言。
      const joined = warnings.join("\n");
      expect(joined).toContain("ACP 不可用，回退 headless");
      expect(joined).toContain("falling back to headless");
    } finally {
      warn.mockRestore();
      process.env.PATH = originalPath;
    }
  });
});

// 这几条是「面向用户的失败原因」，按仓内版式（中文一行 + 英文一行，见 bin.ts 的
// 迁移提示）给双语。两半分开断言：任何一半被改回单语都会立刻变红。
describe("面向用户的失败文案是中英双语", () => {
  it("session 没有 sessionId", async () => {
    const fixture = writeServer("no-session-id", { sessionResult: {} });
    const err = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path] }),
      prompt: "hi",
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AcpStartupError);
    const message = (err as Error).message;
    expect(message).toContain("没有拿到 sessionId");
    expect(message).toContain("without a sessionId");
  });

  it("切换模型被 agent 拒绝", async () => {
    const fixture = writeServer("set-model-rejected", {
      failModelIds: ["e-1", "trae/e-1"],
      updates: [textChunk("不该到这里")],
    });
    const err = await runAcpTurn({
      execPath: process.execPath,
      spec: spec({ args: [fixture.path], providerFallback: "trae" }),
      prompt: "hi",
      model: "trae/e-1",
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).toContain("无法切换到模型");
    expect(message).toContain("could not switch to model");
  });
});
