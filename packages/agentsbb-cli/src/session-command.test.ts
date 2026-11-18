import { describe, expect, it } from "vitest";
import { isNewSessionCommand, newSessionAck } from "./session-command.js";

// 规则与服务端 session_reset.go 的 newSessionCommandRe 逐条同源：一边认一边
// 不认，用户就会遇到「私聊里好使、群里没反应」。
describe("isNewSessionCommand", () => {
  it.each([
    "新开会话",
    "  新开会话  ",
    "新开一个会话",
    "重开会话",
    "重新开一个对话",
    "另开聊天",
    "开启新会话",
    "/new",
    "/reset",
    "/新开会话",
    "／new", // 全角斜杠（中文输入法下很常见）
  ])("recognises %s", (text) => {
    expect(isNewSessionCommand(text)).toBe(true);
  });

  it.each([
    "新开一个项目", // 真在聊事情：吞掉就等于把用户原话丢了
    "请在群里新开会话",
    "新开会话吧",
    "查版本号",
    "",
    "   ",
    "新开会话新开会话新开会话", // 超长，是正文
  ])("leaves %s alone", (text) => {
    expect(isNewSessionCommand(text)).toBe(false);
  });
});

describe("newSessionAck", () => {
  it("names the agent and the venue, and says history is kept", () => {
    const ack = newSessionAck("private", "kimi");
    expect(ack).toContain("kimi");
    expect(ack).toContain("新会话");
    // 「已清空历史」是假话：历史还在各端记录里，被清掉的只是续接指针。
    expect(ack).toContain("仍然保留");
  });

  it("uses the room wording for group chat", () => {
    expect(newSessionAck("group", "grok")).toContain("这个群");
    expect(newSessionAck("discussion", "grok")).toContain("讨论组");
  });
});
