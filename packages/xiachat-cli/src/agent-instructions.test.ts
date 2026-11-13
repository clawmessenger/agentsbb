import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_OUTPUT_STYLE_BEGIN,
  CODEX_OUTPUT_STYLE_END,
  codexAgentsPath,
  ensureCodexOutputStyle,
  mergeCodexOutputStyle,
} from "./agent-instructions.js";

describe("codexAgentsPath", () => {
  it("CODEX_HOME 优先于用户目录（codex 自己也认这个变量）", () => {
    expect(codexAgentsPath({ CODEX_HOME: "/custom/codex" }, "/home/u")).toBe(
      join("/custom/codex", "AGENTS.md"),
    );
  });

  it("没有 CODEX_HOME 时落在 ~/.codex/AGENTS.md", () => {
    expect(codexAgentsPath({}, "/home/u")).toBe(join("/home/u", ".codex", "AGENTS.md"));
  });

  it("空白 CODEX_HOME 视同未设置", () => {
    expect(codexAgentsPath({ CODEX_HOME: "   " }, "/home/u")).toBe(join("/home/u", ".codex", "AGENTS.md"));
  });
});

describe("mergeCodexOutputStyle", () => {
  it("空文件只写我们的段", () => {
    const merged = mergeCodexOutputStyle(null);
    expect(merged.startsWith(CODEX_OUTPUT_STYLE_BEGIN)).toBe(true);
    expect(merged.trimEnd().endsWith(CODEX_OUTPUT_STYLE_END)).toBe(true);
  });

  it("已有用户内容时追加，原内容一个字不动", () => {
    const merged = mergeCodexOutputStyle("# 我的规则\n\n- 用中文回答\n");
    expect(merged.startsWith("# 我的规则\n\n- 用中文回答")).toBe(true);
    expect(merged).toContain(CODEX_OUTPUT_STYLE_BEGIN);
    // 用户内容与标记段之间留一空行，且有结尾换行
    expect(merged).toContain("用中文回答\n\n<!-- agentsbb:output-style:begin -->");
    expect(merged.endsWith("\n")).toBe(true);
  });

  it("已有标记段时原地替换，不重复堆叠", () => {
    const stale = [
      "# 我的规则",
      CODEX_OUTPUT_STYLE_BEGIN,
      "旧文案",
      CODEX_OUTPUT_STYLE_END,
      "## 尾部说明",
    ].join("\n");
    const merged = mergeCodexOutputStyle(stale);
    expect(merged.match(new RegExp(CODEX_OUTPUT_STYLE_BEGIN, "g"))).toHaveLength(1);
    expect(merged.match(new RegExp(CODEX_OUTPUT_STYLE_END, "g"))).toHaveLength(1);
    expect(merged).not.toContain("旧文案");
    expect(merged).toContain("正文只写成品内容");
    // 前后文都保留
    expect(merged.startsWith("# 我的规则")).toBe(true);
    expect(merged).toContain("## 尾部说明");
  });

  it("幂等：合并两次结果相同", () => {
    const once = mergeCodexOutputStyle("# mine\n");
    expect(mergeCodexOutputStyle(once)).toBe(once);
  });
});

describe("ensureCodexOutputStyle", () => {
  it("文件不存在时创建并写入", () => {
    const writeFile = vi.fn();
    const changed = ensureCodexOutputStyle({
      env: { CODEX_HOME: "/x" },
      readFile: () => null,
      writeFile,
    });
    expect(changed).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0]).toBe(join("/x", "AGENTS.md"));
    expect(writeFile.mock.calls[0][1]).toContain("正文只写成品内容");
  });

  it("已是最新时不写（每个 codex 轮次都会调用，避免 mtime 抖动）", () => {
    const writeFile = vi.fn();
    const current = mergeCodexOutputStyle("# mine\n");
    const changed = ensureCodexOutputStyle({
      env: { CODEX_HOME: "/x" },
      readFile: () => current,
      writeFile,
    });
    expect(changed).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("无标记段的旧文件会被补上并保留原内容", () => {
    const writeFile = vi.fn();
    const changed = ensureCodexOutputStyle({
      env: { CODEX_HOME: "/x" },
      readFile: () => "# mine\n",
      writeFile,
    });
    expect(changed).toBe(true);
    expect(writeFile.mock.calls[0][1]).toContain("# mine");
    expect(writeFile.mock.calls[0][1]).toContain(CODEX_OUTPUT_STYLE_BEGIN);
  });

  it("写入失败不抛错（指令注入不能拖垮一轮对话）", () => {
    const changed = ensureCodexOutputStyle({
      env: { CODEX_HOME: "/x" },
      readFile: () => null,
      writeFile: () => {
        throw new Error("EACCES");
      },
    });
    expect(changed).toBe(false);
  });
});

// --- 冷启动/尾延迟自愈（2026-11-05 现场） ----------------------------------

import {
  CODEX_SLOW_PLUGINS,
  disableCodexPluginSections,
  ensureCodexFastStart,
  ensureQwenFastStart,
  qwenSettingsPath,
} from "./agent-instructions.js";

describe("disableCodexPluginSections", () => {
  it("把目标插件段的 enabled=true 改成 false，其余段落不动", () => {
    const raw = [
      'model = "glm-5.2"',
      "",
      '[plugins."slack@openai-curated"]',
      "enabled = true",
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
      "[features]",
      "web_search = true",
    ].join("\n");
    const { text, changed } = disableCodexPluginSections(raw, CODEX_SLOW_PLUGINS);
    expect(changed).toBe(true);
    expect(text).toContain('[plugins."slack@openai-curated"]\nenabled = false');
    // 无关插件保持原样
    expect(text).toContain('[plugins."browser@openai-bundled"]\nenabled = true');
    expect(text).toContain("web_search = true");
  });

  it("已是 false / 段落不存在时幂等不改", () => {
    const already = '[plugins."slack@openai-curated"]\nenabled = false\n';
    expect(disableCodexPluginSections(already, CODEX_SLOW_PLUGINS).changed).toBe(false);
    expect(disableCodexPluginSections("model = \"x\"\n", CODEX_SLOW_PLUGINS).changed).toBe(false);
  });
});

describe("ensureCodexFastStart", () => {
  it("config.toml 存在且含慢插件时改写；已是 false 时不动", () => {
    const files = new Map<string, string>([
      [join("/h", ".codex", "config.toml"), '[plugins."slack@openai-curated"]\nenabled = true\n'],
    ]);
    const writeFile = vi.fn((p: string, c: string) => files.set(p, c));
    const changed = ensureCodexFastStart({
      home: "/h",
      readFile: (p) => files.get(p) ?? null,
      writeFile,
    });
    expect(changed).toBe(true);
    expect(files.get(join("/h", ".codex", "config.toml"))).toContain("enabled = false");

    // 再跑一次：幂等
    const again = ensureCodexFastStart({
      home: "/h",
      readFile: (p) => files.get(p) ?? null,
      writeFile: vi.fn(),
    });
    expect(again).toBe(false);
  });

  it("CODEX_HOME 优先；config.toml 不存在时静默返回 false", () => {
    const changed = ensureCodexFastStart({
      env: { CODEX_HOME: "/custom" },
      readFile: () => null,
      writeFile: vi.fn(),
    });
    expect(changed).toBe(false);
  });
});

describe("ensureQwenFastStart", () => {
  it("settings.json 没有 memory 键时补写 enableManagedAutoMemory=false", () => {
    const files = new Map<string, string>([
      [join("/h", ".qwen", "settings.json"), JSON.stringify({ model: { name: "glm-5.2" } })],
    ]);
    const changed = ensureQwenFastStart({
      home: "/h",
      readFile: (p) => files.get(p) ?? null,
      writeFile: (p, c) => files.set(p, c),
    });
    expect(changed).toBe(true);
    const written = JSON.parse(files.get(join("/h", ".qwen", "settings.json"))!);
    expect(written.memory.enableManagedAutoMemory).toBe(false);
    // 用户其余内容原样保留
    expect(written.model.name).toBe("glm-5.2");
  });

  it("用户显式设过 enableManagedAutoMemory（无论真假）一律不动", () => {
    const explicit = JSON.stringify({ memory: { enableManagedAutoMemory: true } });
    const files = new Map<string, string>([
      [join("/h", ".qwen", "settings.json"), explicit],
    ]);
    const changed = ensureQwenFastStart({
      home: "/h",
      readFile: (p) => files.get(p) ?? null,
      writeFile: vi.fn(),
    });
    expect(changed).toBe(false);
    expect(files.get(join("/h", ".qwen", "settings.json"))).toBe(explicit);
  });

  it("settings.json 不存在时静默返回 false；QWEN_HOME 优先", () => {
    expect(ensureQwenFastStart({
      env: { QWEN_HOME: "/q" },
      readFile: () => null,
      writeFile: vi.fn(),
    })).toBe(false);
    expect(qwenSettingsPath({ QWEN_HOME: "/q" }, "/h")).toBe(join("/q", "settings.json"));
  });

  it("破损 JSON 静默返回 false（不创建文件）", () => {
    const writeFile = vi.fn();
    expect(ensureQwenFastStart({
      home: "/h",
      readFile: () => "not json {",
      writeFile,
    })).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
