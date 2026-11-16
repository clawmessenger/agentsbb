import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeAgentNames,
  opsScopeFile,
  opsScopeHeader,
  readOpsScopeSync,
  resolveOpsScope,
  withOpsScopeHeader,
  writeOpsScope,
} from "./ops-scope.js";

describe("normalizeAgentNames", () => {
  it("去掉 ops 自己、supervisor 键（带 @）与重复项", () => {
    expect(normalizeAgentNames(["opencode", "ops", "ops@codex", "Qwen", "qwen", " "]))
      .toEqual(["opencode", "Qwen"]);
  });
});

describe("resolveOpsScope", () => {
  const agents = ["opencode", "openclaw", "qwen", "hermes"];

  it("点名恰好一个 → 锁定它", () => {
    expect(resolveOpsScope("openclaw 掉线了，帮我看看", agents)).toEqual({ target: "openclaw", ambiguous: [] });
  });

  it("大小写不敏感：用户写 OpenClaw 与 openclaw 是同一件事", () => {
    expect(resolveOpsScope("重启一下 OpenClaw", agents).target).toBe("openclaw");
    expect(resolveOpsScope("Qwen 好像卡住了", agents).target).toBe("qwen");
  });

  it("同时点名多个 → 不猜，交给提示词反问", () => {
    const r = resolveOpsScope("openclaw 和 qwen 都掉线了", agents);
    expect(r.target).toBeUndefined();
    expect(r.ambiguous.sort()).toEqual(["openclaw", "qwen"]);
  });

  it("一个都没点名 → 空（不许自行挑一个）", () => {
    expect(resolveOpsScope("帮我看看为什么掉线了", agents)).toEqual({ ambiguous: [] });
  });

  it("按标识符边界匹配：api 不算点名 pi，opencode-x 不算点名 opencode", () => {
    const list = ["pi", "opencode"];
    expect(resolveOpsScope("看下 api 的日志", list).target).toBeUndefined();
    expect(resolveOpsScope("opencode-x 是什么", list).target).toBeUndefined();
    expect(resolveOpsScope("重启 pi 这个智能体", list).target).toBe("pi");
  });

  it("agent 名里的连字符/下划线不会被 \\b 误判", () => {
    expect(resolveOpsScope("qwen-paw 怎么了", ["qwen-paw"]).target).toBe("qwen-paw");
    expect(resolveOpsScope("qwen_paw 怎么了", ["qwen_paw"]).target).toBe("qwen_paw");
  });

  it("空消息或空清单 → 不报错、不命中", () => {
    expect(resolveOpsScope("", agents)).toEqual({ ambiguous: [] });
    expect(resolveOpsScope("openclaw", [])).toEqual({ ambiguous: [] });
  });
});

describe("opsScopeHeader", () => {
  const agents = ["opencode", "openclaw"];

  it("锁定态：抬头点名，并写明本轮只允许操作它", () => {
    const header = opsScopeHeader({ target: "openclaw", ambiguous: [] }, agents);
    expect(header).toContain("【运维对象】openclaw");
    expect(header).toContain("只允许操作 openclaw");
  });

  it("多命中态：抬头写「未确定」并列出候选，明确不许猜", () => {
    const header = opsScopeHeader({ ambiguous: ["opencode", "openclaw"] }, agents);
    expect(header).toContain("未确定");
    expect(header).toContain("opencode、openclaw");
    expect(header).toContain("不许猜");
  });

  it("未指定态：列出本机可选智能体，禁止自行选择与「都检查一遍」", () => {
    const header = opsScopeHeader({ ambiguous: [] }, agents);
    expect(header).toContain("未指定");
    expect(header).toContain("opencode、openclaw");
    expect(header).toContain("不许自行选择");
    expect(header).toContain("都检查一遍");
  });
});

describe("scope 落盘", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agentsbb-ops-scope-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("没有文件时读到空串（= 未锁定）", () => {
    expect(readOpsScopeSync(home)).toBe("");
  });

  it("写入后能读回；写空串表示清空作用域", async () => {
    await writeOpsScope("qwen", home);
    expect(readOpsScopeSync(home)).toBe("qwen");
    expect(opsScopeFile(home).endsWith(join("ops", "scope.json"))).toBe(true);

    await writeOpsScope("", home);
    expect(readOpsScopeSync(home)).toBe("");
  });

  it("文件损坏时按未锁定处理，不抛异常", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeOpsScope("qwen", home);
    await writeFile(opsScopeFile(home), "{not json", "utf8");
    expect(readOpsScopeSync(home)).toBe("");
  });
});

describe("withOpsScopeHeader", () => {
  it("抬头在前、用户原话原样在后", () => {
    const out = withOpsScopeHeader("帮我重启一下", "【运维对象】qwen");
    expect(out).toBe("【运维对象】qwen\n\n帮我重启一下");
  });
});
