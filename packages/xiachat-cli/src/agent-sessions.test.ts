// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileAgentSessionStore,
  isSessionId,
  isStaleSessionError,
  MemoryAgentSessionStore,
} from "./agent-sessions.js";
import { buildAgentArgs, extractSessionId } from "./agents.js";

const SID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

describe("会话 id 的取舍", () => {
  it("只收能安全塞进 argv 的形状", () => {
    expect(isSessionId(SID)).toBe(true);
    expect(isSessionId("abc")).toBe(false);
    // 空格 / 引号 / 换行一律拒绝：这些会改变 argv 结构，等于让 agent 换参数
    expect(isSessionId("bad id with spaces")).toBe(false);
    expect(isSessionId(`${SID}; rm -rf /`)).toBe(false);
    expect(isSessionId("")).toBe(false);
    expect(isSessionId(null)).toBe(false);
  });
});

describe("从事件流里捡会话 id", () => {
  it("claude/qwen/codebuddy 的 system.init 与 result 都带 session_id", () => {
    expect(extractSessionId(JSON.stringify({ type: "system", subtype: "init", session_id: SID })))
      .toBe(SID);
    expect(extractSessionId(JSON.stringify({ type: "result", session_id: SID, result: "ok" })))
      .toBe(SID);
  });

  it("opencode 用 sessionID，codex 用 thread_id", () => {
    expect(extractSessionId(JSON.stringify({ type: "step_start", sessionID: SID }))).toBe(SID);
    expect(extractSessionId(JSON.stringify({ type: "thread.started", thread_id: SID }))).toBe(SID);
  });

  it("普通正文行 / 坏 JSON / 短 id 一律返回 null（不能影响正文解析）", () => {
    expect(extractSessionId(JSON.stringify({ type: "assistant", text: "hi" }))).toBeNull();
    expect(extractSessionId("{not json")).toBeNull();
    expect(extractSessionId("plain text")).toBeNull();
    expect(extractSessionId(JSON.stringify({ session_id: "x" }))).toBeNull();
  });
});

describe("各 agent 的续接参数落在正确位置", () => {
  it("claude / codebuddy / qwen / opencode / hermes 都带续接参数", () => {
    const claude = buildAgentArgs("claude", "hi", undefined, "cm-group-1", { resumeSessionId: SID });
    expect(claude).toContain("--resume");
    expect(claude[claude.indexOf("--resume") + 1]).toBe(SID);

    const qwen = buildAgentArgs("qwen", "hi", undefined, "cm-group-1", { resumeSessionId: SID });
    expect(qwen[qwen.indexOf("-r") + 1]).toBe(SID);

    // opencode 必须用 -s（按 id），绝不能用 -c（目录里最近一个，会把不同群串起来）
    const opencode = buildAgentArgs("opencode", "hi", undefined, "cm-group-1", { resumeSessionId: SID });
    expect(opencode).not.toContain("-c");
    expect(opencode[opencode.indexOf("-s") + 1]).toBe(SID);

    const codebuddy = buildAgentArgs("codebuddy", "hi", undefined, "cm-group-1", { resumeSessionId: SID });
    expect(codebuddy[codebuddy.indexOf("--resume") + 1]).toBe(SID);

    const hermes = buildAgentArgs("hermes", "hi", undefined, "cm-group-1", { resumeSessionId: SID });
    expect(hermes[hermes.indexOf("--resume") + 1]).toBe(SID);
  });

  it("没有会话 id 时不带任何续接参数（首轮就是新会话）", () => {
    for (const agent of ["claude", "qwen", "opencode", "codebuddy", "hermes"]) {
      const argv = buildAgentArgs(agent, "hi", undefined, "cm-group-1", {});
      expect(argv).not.toContain("--resume");
      expect(argv).not.toContain("-r");
      expect(argv).not.toContain("-s");
    }
    // codex 走子命令形态：没有会话 id 时保持 `exec <prompt>`，绝不能出现 resume
    const codex = buildAgentArgs("codex", "hi", undefined, "cm-group-1", {});
    expect(codex.slice(0, 2)).toEqual(["exec", "hi"]);
    expect(codex).not.toContain("resume");
  });

  it("codex 续接是子命令形态：exec resume <id> <prompt>（prompt 必须跟在 id 后）", () => {
    const argv = buildAgentArgs("codex", "问题", undefined, "cm-group-1", { resumeSessionId: SID });
    expect(argv.slice(0, 4)).toEqual(["exec", "resume", SID, "问题"]);
    // 其余开关（--json 等）仍要在，否则思考流/过程流全丢
    expect(argv).toContain("--json");
  });

  it("续接参数排在 prompt 之后、模型参数之前也不破坏 prompt 本体", () => {
    const argv = buildAgentArgs("claude", "问题", "anthropic/claude-x", "cm-group-1", {
      resumeSessionId: SID,
    });
    // -p 的取值必须还是那句 prompt，不能被续接参数挤走
    expect(argv[argv.indexOf("-p") + 1]).toBe("问题");
  });
});

describe("存储：按会话键互不串台", () => {
  it("群聊 / 单聊 / 讨论组各自独立（键里带 venue）", () => {
    const store = new MemoryAgentSessionStore();
    store.set("cm-group-793293", SID);
    store.set("cm-private-3300776275", "11111111-2222-3333-4444-555555555555");

    expect(store.get("cm-group-793293")).toBe(SID);
    expect(store.get("cm-private-3300776275")).toBe("11111111-2222-3333-4444-555555555555");
    expect(store.get("cm-chatroom-793293")).toBeUndefined();

    store.clear("cm-group-793293");
    expect(store.get("cm-group-793293")).toBeUndefined();
  });

  it("非法 id 不落库（免得下一轮带着废参数起来）", () => {
    const store = new MemoryAgentSessionStore();
    store.set("cm-group-1", "bad id");
    expect(store.get("cm-group-1")).toBeUndefined();
  });

  it("文件存储在重启后仍能续上（跨进程）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-sessions-"));
    const path = join(dir, "agent-sessions.json");

    new FileAgentSessionStore(path).set("cm-group-1", SID);

    // 新实例 = 新进程，读的是同一个文件
    expect(new FileAgentSessionStore(path).get("cm-group-1")).toBe(SID);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "cm-group-1": SID });
  });

  it("文件被改坏时当空表处理，绝不抛（丢会话只是从头开始，不能连轮次一起崩）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-sessions-"));
    const path = join(dir, "agent-sessions.json");
    writeFileSync(path, "{半截 JSON");

    const store = new FileAgentSessionStore(path);
    expect(store.get("cm-group-1")).toBeUndefined();
    // 坏文件下仍能正常写入并被下一轮读到
    store.set("cm-group-1", SID);
    expect(new FileAgentSessionStore(path).get("cm-group-1")).toBe(SID);
  });
});

describe("会话失效的自愈判据", () => {
  it("认出各家「会话不存在」的原文", () => {
    expect(isStaleSessionError(new Error("No conversation found with session ID: " + SID))).toBe(true);
    expect(isStaleSessionError(new Error("No saved session found with ID " + SID))).toBe(true);
    expect(isStaleSessionError(new Error("session not found"))).toBe(true);
    expect(isStaleSessionError(new Error("UnknownError: Session 42 not found"))).toBe(true);
    // codex 0.144.6 实测原文（thread/resume 找不到 rollout）
    expect(isStaleSessionError(
      new Error("Error: thread/resume failed: no rollout found for thread id " + SID),
    )).toBe(true);
  });

  it("普通失败不误判（否则会把 agent 的活重跑两遍）", () => {
    expect(isStaleSessionError(new Error("429 rate limit exceeded"))).toBe(false);
    expect(isStaleSessionError(new Error("agent exited with code 1"))).toBe(false);
    expect(isStaleSessionError(new Error("output_truncated"))).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});
