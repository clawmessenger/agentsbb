import { describe, expect, it } from "vitest";
import {
  buildTitleSummarizeError,
  buildTitleSummarizePrompt,
  buildTitleSummarizeResponse,
  parseTitleOutput,
  parseTitleSummarizeRequest,
  TITLE_MAX_CHARS,
  titleTurnTimeoutMs,
} from "./title-summarize.js";

describe("parseTitleSummarizeRequest", () => {
  const base = {
    request_id: "title_1",
    service: "discussion",
    action: "summarize_title",
    params: { topic: "如何用 AI 做动画", goal: "", timestamp: 1_700_000_000_000 },
  };

  it("accepts a well-formed request", () => {
    expect(parseTitleSummarizeRequest(base)).toEqual({
      requestId: "title_1",
      topic: "如何用 AI 做动画",
      goal: "",
      model: undefined,
      timeoutMs: 20_000,
      timestamp: 1_700_000_000_000,
    });
  });

  it("rejects a missing/blank topic", () => {
    expect(parseTitleSummarizeRequest({ ...base, params: { topic: "" } })).toBeNull();
    expect(parseTitleSummarizeRequest({ ...base, params: {} })).toBeNull();
  });

  it("carries model and converts server timeout_seconds", () => {
    const parsed = parseTitleSummarizeRequest({
      ...base,
      params: { topic: "t", model: "provider/model", timeout_seconds: 30 },
    });
    expect(parsed?.model).toBe("provider/model");
    expect(parsed?.timeoutMs).toBe(27_000);
  });
});

describe("titleTurnTimeoutMs", () => {
  it("falls back when absent/invalid, and keeps device ahead of server", () => {
    expect(titleTurnTimeoutMs(undefined)).toBe(20_000);
    expect(titleTurnTimeoutMs(0)).toBe(20_000);
    expect(titleTurnTimeoutMs("30")).toBe(20_000);
    expect(titleTurnTimeoutMs(30)).toBe(27_000);
    expect(titleTurnTimeoutMs(999)).toBe(60_000);
  });
});

describe("buildTitleSummarizePrompt", () => {
  it("asks for a short title without labels or punctuation", () => {
    const prompt = buildTitleSummarizePrompt({
      requestId: "title_1",
      topic: "AI 动画制作",
      goal: "头脑风暴",
    });
    expect(prompt).toContain("AI 动画制作");
    expect(prompt).toContain("头脑风暴");
    expect(prompt).toContain(`${TITLE_MAX_CHARS} 个中文字`);
    expect(prompt).toContain("不要引号");
  });
});

describe("parseTitleOutput", () => {
  it("returns the title as-is when short and clean", () => {
    expect(parseTitleOutput("AI 动画制作")).toBe("AI 动画制作");
  });

  it("strips quotes, brackets, markdown emphasis and trailing punctuation", () => {
    expect(parseTitleOutput("“AI 动画制作”")).toBe("AI 动画制作");
    expect(parseTitleOutput("**AI 动画制作**")).toBe("AI 动画制作");
    expect(parseTitleOutput("《AI 动画制作》。")).toBe("AI 动画制作");
  });

  it("takes only the first line", () => {
    expect(parseTitleOutput("AI 动画制作\n这是一个标题")).toBe("AI 动画制作");
  });

  it("truncates overlong output to 10 characters", () => {
    const title = parseTitleOutput("这是一段非常非常长的标题文字超过十个字了");
    expect(title).not.toBeNull();
    expect(Array.from(title!).length).toBe(TITLE_MAX_CHARS);
  });

  it("returns null for empty or abusive output", () => {
    expect(parseTitleOutput("")).toBeNull();
    expect(parseTitleOutput("   ")).toBeNull();
    expect(parseTitleOutput("x".repeat(200))).toBeNull();
  });
});

describe("buildTitleSummarize responses", () => {
  it("success rides payload.title, failure rides payload.error", () => {
    expect(JSON.parse(buildTitleSummarizeResponse("title_1", "AI 动画", 12))).toEqual({
      request_id: "title_1",
      msg_type: "command_result",
      payload: { kind: "text", title: "AI 动画", elapsed_ms: 12 },
    });
    expect(JSON.parse(buildTitleSummarizeError("title_1", "bad"))).toEqual({
      request_id: "title_1",
      msg_type: "command_result",
      payload: { kind: "error", error: "bad" },
    });
  });
});
