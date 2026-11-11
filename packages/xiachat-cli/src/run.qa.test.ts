// @vitest-environment node
// QA 独立验证（Edward / Yan，2026-11 回归轮）。不复述工程师 run.test.ts 的断言，
// 观测点全部换掉：
//   * console.log 侦探：钉住 run loop「到达/重放丢弃」的判定日志（工程师未用）；
//   * 行为学断言：重放后帧计数不再增长 = 第二轮 agent turn 没有起跑；
//   * 重启视角：全新的 createInboundReplayDedupe 实例读同一份落盘文件裁决重放；
//   * wire 帧形态断言：busy/cancelled 通知帧的 stream_id 后缀钉死（区别于 turn 产物）。
// 记账纪律四铁律 + 绕队列路径（catalog）各至少一条独立断言。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboundReplayDedupe, startRunLoop } from "./run.js";
import type { IMTransport, InboundIMMessage } from "./im.js";
import { XiachatApi } from "./api.js";
import { createEchoAgentScript } from "./test-fixtures.js";

interface WireFrame {
  to: string;
  objectName: string;
  content: string;
}

// ---- 私有 harness：与工程师的 harness 相互独立 ----
function makeHarness(agentOpts: { hangMs?: number } = {}) {
  const sent: WireFrame[] = [];
  const listeners: Array<(msg: InboundIMMessage) => void> = [];
  let resolveWired: () => void = () => {};
  const wired = new Promise<void>((r) => {
    resolveWired = r;
  });
  const dir = mkdtempSync(join(tmpdir(), "clawmessenger-qa-replay-"));
  const processedUidsPath = join(dir, "qa-processed-uids.json");
  // 私聊闸门确定性快照：owner=user_1、本节点 allowPrivate=true。
  const permissionsPath = join(dir, "qa-agent-permissions.json");
  writeFileSync(
    permissionsPath,
    JSON.stringify({
      ownerUserId: "user_1",
      ownerUserIdPresent: true,
      agents: [
        { agent: "kimi", nodeId: "node_1", allowPrivate: true, behaviorPrompt: "", version: 1 },
      ],
      updatedAt: Date.now(),
    }),
  );
  const prevPermissions = process.env.CLAWMESSENGER_AGENT_PERMISSIONS_FILE;
  process.env.CLAWMESSENGER_AGENT_PERMISSIONS_FILE = permissionsPath;

  const agent = createEchoAgentScript("kimi", agentOpts);

  const transport: IMTransport = {
    connect: async () => {},
    sendMessage: async (to, objectName, content) => {
      sent.push({ to, objectName, content });
    },
    // run.ts 恒挂 sendStream（经 sendMessageTo）：缺了它终帧要吃 ~11s 退避重试。
    sendMessageTo: async (_t, targetId, objectName, content) => {
      sent.push({ to: targetId, objectName, content });
    },
    onMessage: (cb) => {
      listeners.push(cb);
    },
    disconnect: async () => {},
    getSelfUserId: () => "rc_node_self",
  };
  const api = new XiachatApi("http://unused.local");
  vi.spyOn(api, "getConfig").mockImplementation(async () => ({ appKey: "appkey-1" }));

  return {
    sent,
    wired,
    processedUidsPath,
    start: () =>
      void startRunLoop({
        creds: { nodeId: "node_1", token: "tok", serverUrl: "http://unused.local", appKey: "appkey-1" },
        api,
        transport,
        agentExecPath: agent.agentPath,
        // 未登记的 agent 名：stdin 模式、无 argv 策略、无 opencode serve 分支。
        agentName: "kimi",
        processedUidsPath,
        turnTimeoutMs: 10_000,
        stdout: { write: () => { resolveWired(); return true; } } as unknown as NodeJS.WriteStream,
      }),
    emit: (uid: string, content: string, objectName = "RC:TxtMsg") => {
      for (const cb of listeners) {
        cb({
          objectName,
          fromUserId: "user_1",
          toUserId: "",
          targetId: "user_1",
          conversationType: 1,
          content,
          messageUId: uid,
        } as InboundIMMessage);
      }
    },
    cleanup: () => {
      if (prevPermissions === undefined) delete process.env.CLAWMESSENGER_AGENT_PERMISSIONS_FILE;
      else process.env.CLAWMESSENGER_AGENT_PERMISSIONS_FILE = prevPermissions;
      agent.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const textMsg = (text: string): string => JSON.stringify({ content: text });

function readUids(path: string): string[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as string[];
  } catch {
    return [];
  }
}

// 某条消息名下所有 chat_stream 帧（turn 产物 + busy/stopped 通知都算）。
function framesFor(sent: WireFrame[], requestMessageId: string): WireFrame[] {
  return sent.filter(
    (f) =>
      f.objectName === "chat_stream" &&
      f.content.includes(`"request_message_id":"${requestMessageId}"`),
  );
}

// turn 产物帧 = 该消息名下除 -busy / -stopped 两个通知后缀外的帧。
function turnFramesFor(sent: WireFrame[], requestMessageId: string): WireFrame[] {
  return framesFor(sent, requestMessageId).filter(
    (f) =>
      !f.content.includes(`"stream_id":"stream-${requestMessageId}-busy"`) &&
      !f.content.includes(`"stream_id":"stream-${requestMessageId}-stopped"`),
  );
}

describe("QA: createInboundReplayDedupe 契约（只读查询 / 派发后记账）", () => {
  it("isDuplicate 连查 50 次也不记账；markProcessed 幂等入 Set", () => {
    const dedupe = createInboundReplayDedupe();
    for (let i = 0; i < 50; i += 1) {
      expect(dedupe.isDuplicate("qa-uid-storm")).toBe(false);
    }
    expect(dedupe.size).toBe(0);
    dedupe.markProcessed("qa-uid-storm");
    dedupe.markProcessed("qa-uid-storm");
    expect(dedupe.size).toBe(1);
    expect(dedupe.isDuplicate("qa-uid-storm")).toBe(true);
  });

  it("落盘只含已派发 UID：重启视角（新实例读同一文件）裁决重放", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmessenger-qa-dedupe2-"));
    const path = join(dir, "qa2.json");
    try {
      const live = createInboundReplayDedupe({ path, flushDelayMs: 1 });
      // 只到达未派发：查询绝不落盘。
      live.isDuplicate("qa-arrived-only");
      live.flush();
      expect(createInboundReplayDedupe({ path }).size).toBe(0);
      // 派发后落盘；重启实例对两个 UID 的裁决相反。
      live.markProcessed("qa-dispatched");
      live.flush();
      const restarted = createInboundReplayDedupe({ path });
      expect(restarted.isDuplicate("qa-dispatched")).toBe(true);
      expect(restarted.isDuplicate("qa-arrived-only")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("QA: startRunLoop 记账纪律（mark-after-dispatch）端到端", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown, ...rest: unknown[]) => {
      logs.push([msg, ...rest].map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("场景A·到达未派发（重启等价）：被 busy 丢掉的 UID 三视角全阴性", async () => {
    const h = makeHarness({ hangMs: 60_000 });
    try {
      h.start();
      await h.wired;
      h.emit("qa-uid-occupy", textMsg("first slow prompt"));
      await new Promise((r) => setTimeout(r, 300));
      h.emit("qa-uid-wait", textMsg("second prompt"));
      h.emit("qa-uid-busy", textMsg("third prompt"));
      await vi.waitFor(() =>
        expect(h.sent.some((f) => f.content.includes("agent_busy"))).toBe(true));
      await new Promise((r) => setTimeout(r, 400));
      // 视角1 落盘文件：不含被丢 UID（sendBusyDropNotice 路径零记账）。
      expect(readUids(h.processedUidsPath)).not.toContain("qa-uid-busy");
      // 视角2 重启实例：同一文件裁决「可重放」。
      expect(
        createInboundReplayDedupe({ path: h.processedUidsPath }).isDuplicate("qa-uid-busy"),
      ).toBe(false);
      // 视角3 日志：从未对它做过重放丢弃判定（先记后丢的病态顺序会留下这条日志）。
      expect(logs.some((l) => l.includes("dropping replayed message uid=qa-uid-busy"))).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 20_000);

  it("场景B·成功派发记账 + 同进程重放被日志判重、零新增帧", async () => {
    const h = makeHarness();
    try {
      h.start();
      await h.wired;
      h.emit("qa-uid-ok", textMsg("hello qa"));
      await vi.waitFor(
        () => expect(turnFramesFor(h.sent, "qa-uid-ok").length).toBeGreaterThan(0),
        { timeout: 8_000 },
      );
      await vi.waitFor(
        () => expect(readUids(h.processedUidsPath)).toContain("qa-uid-ok"),
        { timeout: 8_000 },
      );
      const framesBefore = framesFor(h.sent, "qa-uid-ok").length;
      // 同 UID 重放（融云离线重放等价物）。
      h.emit("qa-uid-ok", textMsg("hello qa"));
      await new Promise((r) => setTimeout(r, 800));
      // 日志判重（run loop 层，不是 answered-turns 层）。
      expect(logs.some((l) => l.includes("dropping replayed message uid=qa-uid-ok"))).toBe(true);
      // 行为学：该 UID 名下没有任何新帧 —— 第二轮 turn 没有起跑。
      expect(framesFor(h.sent, "qa-uid-ok").length).toBe(framesBefore);
    } finally {
      h.cleanup();
    }
  }, 20_000);

  it("场景C·队列满：被丢消息只有唯一 -busy 通知帧，无 turn 产物、不记账", async () => {
    const h = makeHarness({ hangMs: 60_000 });
    try {
      h.start();
      await h.wired;
      h.emit("qa-uid-occupy", textMsg("first"));
      await new Promise((r) => setTimeout(r, 300));
      h.emit("qa-uid-wait", textMsg("second"));
      h.emit("qa-uid-drop", textMsg("third"));
      await vi.waitFor(() =>
        expect(h.sent.some((f) => f.content.includes("agent_busy"))).toBe(true));
      // 唯一帧是 sendBusyDropNotice 的 -busy 通知（seq=0, status=failed）。
      const dropFrames = framesFor(h.sent, "qa-uid-drop");
      expect(dropFrames.length).toBe(1);
      expect(dropFrames[0].content).toContain('"stream_id":"stream-qa-uid-drop-busy"');
      expect(dropFrames[0].content).toContain('"error_code":"agent_busy"');
      expect(dropFrames[0].content).toContain('"status":"failed"');
      // 无 turn 产物帧。
      expect(turnFramesFor(h.sent, "qa-uid-drop").length).toBe(0);
      // 不记账（落盘 + 重启视角双验）。
      expect(readUids(h.processedUidsPath)).not.toContain("qa-uid-drop");
      expect(
        createInboundReplayDedupe({ path: h.processedUidsPath }).isDuplicate("qa-uid-drop"),
      ).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 20_000);

  it("场景D·chat_stop 撤排队：victim 只有 -stopped 通知帧、不记账；stop 自身记账", async () => {
    const h = makeHarness({ hangMs: 60_000 });
    try {
      h.start();
      await h.wired;
      h.emit("qa-uid-occupy", textMsg("first"));
      await new Promise((r) => setTimeout(r, 300));
      h.emit("qa-uid-victim", textMsg("second"));
      await new Promise((r) => setTimeout(r, 80));
      h.emit(
        "qa-uid-stop",
        JSON.stringify({ msg_type: "chat_stop", stream_id: "stream-unknown", request_id: "req-qa-1" }),
        "chat_stop",
      );
      await vi.waitFor(() =>
        expect(h.sent.some((f) => f.content.includes('"status":"cancelled"'))).toBe(true));
      await new Promise((r) => setTimeout(r, 1_500));
      // victim：唯一帧是 onDropped 的 cancelled 通知，不是 turn 产物。
      const victimFrames = framesFor(h.sent, "qa-uid-victim");
      expect(victimFrames.length).toBe(1);
      expect(victimFrames[0].content).toContain('"stream_id":"stream-qa-uid-victim-stopped"');
      expect(turnFramesFor(h.sent, "qa-uid-victim").length).toBe(0);
      // victim 不记账；chat_stop 自身（绕队列派发成功）要记账。
      const recorded = readUids(h.processedUidsPath);
      expect(recorded).not.toContain("qa-uid-victim");
      expect(recorded).toContain("qa-uid-stop");
    } finally {
      h.cleanup();
    }
  }, 20_000);

  it("场景E·绕队列路径（模型目录请求）：成功应答后记账，重放被日志判重且不二次应答", async () => {
    const h = makeHarness();
    try {
      h.start();
      await h.wired;
      h.emit(
        "qa-uid-cat",
        JSON.stringify({ msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "req-qa-cat-1" }),
        "command",
      );
      // 目录回执（command 通道）确实发出。
      await vi.waitFor(
        () =>
          expect(
            h.sent.filter((f) => f.content.includes("discussion_model_catalog_response")).length,
          ).toBeGreaterThanOrEqual(1),
        { timeout: 8_000 },
      );
      await vi.waitFor(
        () => expect(readUids(h.processedUidsPath)).toContain("qa-uid-cat"),
        { timeout: 8_000 },
      );
      // 重放同一 UID：run loop 层判重（日志为证），且不再发第二份回执。
      h.emit(
        "qa-uid-cat",
        JSON.stringify({ msg_type: "discussion_model_catalog_request", protocolVersion: 2, requestId: "req-qa-cat-1" }),
        "command",
      );
      await new Promise((r) => setTimeout(r, 800));
      expect(logs.some((l) => l.includes("dropping replayed message uid=qa-uid-cat"))).toBe(true);
      expect(
        h.sent.filter((f) => f.content.includes("discussion_model_catalog_response")).length,
      ).toBe(1);
    } finally {
      h.cleanup();
    }
  }, 20_000);
});
