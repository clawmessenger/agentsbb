import { describe, expect, it } from "vitest";
import { buildDiscussionCancelAck, parseDiscussionCancelRequest } from "./discussion-cancel.js";

describe("parseDiscussionCancelRequest", () => {
  it("认出 v2 信封（notifyCancelSafe 的形状：没有 targetRequestId）", () => {
    const parsed = parseDiscussionCancelRequest(JSON.stringify({
      msg_type: "discussion_cancel", protocolVersion: 2, discussionId: "disc-1",
      chatroomId: "room-1", requestId: "req-1", stateVersion: 7, round: 2,
      timestamp: 1_700_000_000_000, reason: "cancelled",
    }));
    expect(parsed).toMatchObject({
      protocolVersion: 2,
      discussionId: "disc-1",
      chatroomId: "room-1",
      requestId: "req-1",
      stateVersion: 7,
      round: 2,
      reason: "cancelled",
    });
    expect(parsed?.targetRequestId).toBe("");
    expect(parsed?.targetMemberId).toBe("");
  });

  it("认出 v3 信封（带 targetRequestId / targetMemberId）", () => {
    const parsed = parseDiscussionCancelRequest(JSON.stringify({
      msg_type: "discussion_cancel", protocolVersion: 3, discussionId: "disc-2",
      chatroomId: "room-2", requestId: "req-2", stateVersion: 9, round: 3,
      roundRevision: 1, timestamp: 1, targetRequestId: "turn-9", targetMemberId: "rc_a",
    }));
    expect(parsed).toMatchObject({
      protocolVersion: 3,
      targetRequestId: "turn-9",
      targetMemberId: "rc_a",
      roundRevision: 1,
    });
  });

  it("不把普通命令当取消（your_turn / 空 msg_type / 非对象）", () => {
    const yourTurn = JSON.stringify({ request_id: "r", service: "discussion", action: "your_turn" });
    expect(parseDiscussionCancelRequest(yourTurn)).toBeNull();
    expect(parseDiscussionCancelRequest(JSON.stringify({ msg_type: "chat_stop" }))).toBeNull();
    expect(parseDiscussionCancelRequest("null")).toBeNull();
    expect(parseDiscussionCancelRequest("[]")).toBeNull();
    expect(parseDiscussionCancelRequest("not json")).toBeNull();
  });

  it("reason 缺省兜底成 cancelled（回执与日志都要有可读值）", () => {
    const parsed = parseDiscussionCancelRequest(JSON.stringify({ msg_type: "discussion_cancel" }));
    expect(parsed?.reason).toBe("cancelled");
    expect(parsed?.protocolVersion).toBe(2);
  });
});

describe("buildDiscussionCancelAck", () => {
  it("v2 缺的 targetRequestId / targetMemberId 用本地命中的轮次与自身 id 补齐", () => {
    const cancel = parseDiscussionCancelRequest(JSON.stringify({
      msg_type: "discussion_cancel", protocolVersion: 2, discussionId: "disc-1",
      chatroomId: "room-1", requestId: "req-1", stateVersion: 7, round: 2, timestamp: 5,
    }))!;
    const ack = JSON.parse(buildDiscussionCancelAck(cancel, {
      selfUserId: "rc_self", abortedRequestId: "turn-3", result: "cancelled", now: 42,
    })) as Record<string, unknown>;
    expect(ack).toMatchObject({
      msg_type: "discussion_cancel_ack",
      protocolVersion: 2,
      discussionId: "disc-1",
      chatroomId: "room-1",
      requestId: "req-1",
      stateVersion: 7,
      round: 2,
      timestamp: 42,
      targetRequestId: "turn-3",
      targetMemberId: "rc_self",
      result: "cancelled",
    });
  });

  it("通知自己带了 target 就用通知的，不被本地兜底覆盖", () => {
    const cancel = parseDiscussionCancelRequest(JSON.stringify({
      msg_type: "discussion_cancel", protocolVersion: 3, discussionId: "disc-2",
      chatroomId: "room-2", requestId: "req-2", targetRequestId: "turn-9", targetMemberId: "rc_a",
    }))!;
    const ack = JSON.parse(buildDiscussionCancelAck(cancel, {
      selfUserId: "rc_self", abortedRequestId: "turn-other", result: "already_terminal",
    })) as Record<string, unknown>;
    expect(ack.targetRequestId).toBe("turn-9");
    expect(ack.targetMemberId).toBe("rc_a");
    expect(ack.result).toBe("already_terminal");
  });
});
