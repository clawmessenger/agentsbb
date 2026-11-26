import { describe, expect, it } from "vitest";

import {
  buildPermissionCard,
  buildQuestionCard,
  mapAcpOptionsToChoices,
  parsePermissionMarkers,
  parseQuestionMarkers,
  PERMISSION_PROTOCOL_INSTRUCTION,
  stripPermissionMarkers,
  resolvePermissionOptionId,
  stripQuestionMarkers,
} from "./interaction.js";

describe("mapAcpOptionsToChoices", () => {
  it("maps allow_once / allow_always / reject_once to three buttons", () => {
    const choices = mapAcpOptionsToChoices([
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "allow_always", kind: "allow_always" },
      { optionId: "deny_once", kind: "reject_once" },
    ]);
    expect(choices?.map((c) => c.reply)).toEqual(["once", "always", "reject"]);
    expect(resolvePermissionOptionId(choices!, "reject")).toBe("deny_once");
    expect(resolvePermissionOptionId(choices!, "always")).toBe("allow_always");
  });

  it("recognises session-scoped option ids as always", () => {
    const choices = mapAcpOptionsToChoices([
      { optionId: "allow_session", kind: "allow_once" },
      { optionId: "deny_once", kind: "reject_once" },
    ]);
    expect(resolvePermissionOptionId(choices!, "always")).toBe("allow_session");
  });

  it("returns null when no usable option is offered", () => {
    expect(mapAcpOptionsToChoices([{ optionId: "x", kind: "other" }])).toBeNull();
    expect(mapAcpOptionsToChoices([])).toBeNull();
  });
});

describe("permission / question cards", () => {
  it("builds a permission card with a permission section carrying three button actions", () => {
    const choices = mapAcpOptionsToChoices([
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "deny_once", kind: "reject_once" },
    ])!;
    const card = buildPermissionCard({
      kind: "permission",
      permissionId: "perm-p2p-u1-900",
      permission: "write file",
      choices,
      requesterId: "u1",
      sessionKey: "p2p-u1",
    });
    expect(card.id).toBe("perm-p2p-u1-900");
    const section = card.sections.find((s) => s.kind === "permission") as Record<string, unknown>;
    expect(section.permissionId).toBe("perm-p2p-u1-900");
    const buttons = section.buttons as Array<{ action: { type: string; permissionId: string; reply: string } }>;
    expect(buttons.map((b) => b.action.reply)).toEqual(["once", "reject"]);
    expect(buttons[0]!.action.type).toBe("permission");
  });

  it("builds a question card carrying questionId/options/multiple", () => {
    const card = buildQuestionCard({
      kind: "question",
      questionId: "q-1",
      question: "选哪个方案？",
      options: ["A", "B"],
      multiple: true,
      requesterId: "u1",
      sessionKey: "p2p-u1",
    });
    const section = card.sections.find((s) => s.kind === "question") as Record<string, unknown>;
    expect(section.questionId).toBe("q-1");
    expect(section.multiple).toBe(true);
    expect(section.options).toEqual([{ label: "A" }, { label: "B" }]);
  });
});

describe("question markers", () => {
  it("parses a question block and strips it from the visible text", () => {
    const text = [
      "我先确认一下：",
      '[interaction:question] {"question":"选哪个？","options":["A","B"],"multiple":false} [/interaction]',
      "（请回复）",
    ].join("\n");
    const parsed = parseQuestionMarkers(text);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.question).toBe("选哪个？");
    expect(parsed[0]!.options).toEqual(["A", "B"]);
    expect(parsed[0]!.multiple).toBe(false);
    const stripped = stripQuestionMarkers(text);
    expect(stripped).not.toContain("interaction:question");
    expect(stripped).toContain("我先确认一下");
  });

  it("ignores malformed blocks and keeps the text", () => {
    const text = '[interaction:question] not json [/interaction] 正文保留';
    expect(parseQuestionMarkers(text).length).toBe(0);
    expect(stripQuestionMarkers(text)).toContain("正文保留");
  });
});


describe("headless soft permission markers", () => {
  it("parses a permission marker with three choices and strips it from text", () => {
    const text = [
      "我准备删除临时文件。",
      '[interaction:permission] {"permission":"删除 /tmp/a.txt","options":[{"reply":"once","label":"允许一次"},{"reply":"always","label":"始终允许"},{"reply":"reject","label":"拒绝"}]} [/interaction]',
    ].join("\n");
    const parsed = parsePermissionMarkers(text);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.permission).toBe("删除 /tmp/a.txt");
    expect(parsed[0]!.choices.map((c) => c.reply)).toEqual(["once", "always", "reject"]);
    const stripped = stripPermissionMarkers(text);
    expect(stripped).not.toContain("interaction:permission");
    expect(stripped).toContain("我准备删除临时文件");
  });

  it("ignores malformed permission markers", () => {
    expect(parsePermissionMarkers('[interaction:permission] bad [/interaction]').length).toBe(0);
    expect(parsePermissionMarkers('[interaction:permission] {"permission":"x","options":[]} [/interaction]').length).toBe(0);
  });

  it("instruction tells the agent to output the marker and stop", () => {
    expect(PERMISSION_PROTOCOL_INSTRUCTION).toContain("[interaction:permission]");
    expect(PERMISSION_PROTOCOL_INSTRUCTION).toContain("停止本轮");
  });
});
