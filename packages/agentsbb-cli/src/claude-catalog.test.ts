import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CATALOG_PROVIDER,
  CLAUDE_LIST_MODELS_REQUEST_ID,
  claudeCatalogFromRows,
  discoverClaudeCatalog,
  parseClaudeListModels,
  probeClaudeModels,
  type ClaudeModelRow,
} from "./claude-catalog.js";
import { createModelCatalogLoader } from "./model-catalog.js";

// claude 的目录发现走控制协议（没有 --list-models），所以这里既要钉解析
// （两代信封、disabled 行、不可上屏的 id），也要钉「活目录顶替静态表」这条
// 加载器语义 —— 只有活目录能回答「本机这个 CLI 到底能跑什么」。

function controlResponse(models: unknown[]): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: CLAUDE_LIST_MODELS_REQUEST_ID,
      // 双层 response 是 claude 自己的形状（claude_models.go:186-197）。
      response: { models },
    },
  });
}

function row(overrides: Partial<ClaudeModelRow> = {}): ClaudeModelRow {
  return {
    value: "sonnet",
    resolvedModel: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    disabled: false,
    ...overrides,
  };
}

describe("parseClaudeListModels", () => {
  it("reads the doubled-response envelope", () => {
    const parsed = parseClaudeListModels([
      '{"type":"system","subtype":"init"}',
      controlResponse([
        { value: "default", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
        { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus 5 (1M)", disabled: true },
      ]),
    ].join("\n"));

    expect(parsed?.unsupported).toBe(false);
    expect(parsed?.rows.map((r) => r.resolvedModel))
      .toEqual(["claude-sonnet-4-6", "claude-opus-5[1m]"]);
    expect(parsed?.rows[1].disabled).toBe(true);
  });

  it("reports an unsupported subtype so the caller stops asking", () => {
    const parsed = parseClaudeListModels(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: CLAUDE_LIST_MODELS_REQUEST_ID,
        error: "Unsupported control request subtype: list_models",
      },
    }));
    expect(parsed).toEqual({ rows: [], unsupported: true });
  });

  it("returns null when our reply is not in the stream", () => {
    expect(parseClaudeListModels("")).toBeNull();
    expect(parseClaudeListModels('{"type":"system"}')).toBeNull();
    expect(parseClaudeListModels("not json at all")).toBeNull();
  });
});

describe("claudeCatalogFromRows", () => {
  it("folds the `default` row into defaultModel instead of offering it", () => {
    const catalog = claudeCatalogFromRows([
      row({ value: "default", resolvedModel: "claude-sonnet-4-6" }),
      row({ value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus 5" }),
    ]);
    expect(catalog.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(catalog.providers[0].models.map((m) => m.id))
      .toEqual(["claude-opus-5", "claude-sonnet-4-6"]);
  });

  it("drops disabled rows and ids the wire route cannot carry", () => {
    const catalog = claudeCatalogFromRows([
      row({ value: "old", resolvedModel: "claude-3-opus", disabled: true }),
      row({ value: "opus[1m]", resolvedModel: "claude-opus-5[1m]" }),
      row({ value: "sonnet", resolvedModel: "claude-sonnet-4-6" }),
    ]);
    expect(catalog.providers[0].models.map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
    expect(catalog.skipped).toBe(1);
  });

  it("returns an empty catalog when nothing is selectable", () => {
    const catalog = claudeCatalogFromRows([row({ disabled: true })]);
    expect(catalog.providers).toEqual([]);
    expect(catalog.defaultModel).toBeNull();
  });
});

describe("probeClaudeModels", () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (chunk: string) => void; end: () => void };
      pid?: number;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    return child;
  }

  it("writes one control_request frame and closes stdin", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const pending = probeClaudeModels({ execPath: "/fake/claude", spawnImpl });
    // 请求必须先落盘再等回复：拿不到这一帧，说明 argv/stdin 契约变了。
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    const frame = JSON.parse((child.stdin.write as unknown as { mock: { calls: string[][] } })
      .mock.calls[0][0]);
    expect(frame).toMatchObject({
      type: "control_request",
      request_id: CLAUDE_LIST_MODELS_REQUEST_ID,
      request: { subtype: "list_models" },
    });
    expect(child.stdin.end).toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from(controlResponse([row()])));
    child.emit("close", 0);
    await expect(pending).resolves.toContain("control_response");
  });

  it("resolves null (never rejects) when the CLI says nothing", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const logs: string[] = [];

    const pending = probeClaudeModels({ execPath: "/fake/claude", spawnImpl, logger: (m) => logs.push(m) });
    child.stderr.emit("data", Buffer.from("not logged in"));
    child.emit("close", 1);

    await expect(pending).resolves.toBeNull();
    expect(logs.join("\n")).toMatch(/not logged in/);
  });
});

describe("discoverClaudeCatalog", () => {
  function stubSpawn(stdout: string) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (chunk: string) => void; end: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0);
    });
    return vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
  }

  it("projects the live catalog", async () => {
    const catalog = await discoverClaudeCatalog({
      execPath: "/fake/claude",
      spawnImpl: stubSpawn(controlResponse([
        { value: "default", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
        { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus 5" },
      ])),
    });
    expect(catalog?.providers[0].id).toBe(CLAUDE_CATALOG_PROVIDER);
    expect(catalog?.providers[0].models).toEqual([
      { id: "claude-opus-5", name: "Opus 5" },
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
    ]);
    expect(catalog?.defaultModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("returns null for an old CLI so the static table still answers", async () => {
    const catalog = await discoverClaudeCatalog({
      execPath: "/fake/claude",
      spawnImpl: stubSpawn(JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: CLAUDE_LIST_MODELS_REQUEST_ID,
          error: "Unsupported control request subtype: list_models",
        },
      })),
    });
    expect(catalog).toBeNull();
  });
});

describe("loader: claude live catalog", () => {
  const noConfig = () => null;

  it("serves the live catalog instead of the static table", async () => {
    const loader = createModelCatalogLoader({
      agentName: "claude",
      execPath: "/fake/claude",
      runCommand: vi.fn(),
      readConfig: noConfig,
      discoverClaude: async () => ({
        defaultModel: "anthropic/claude-sonnet-4-6",
        providers: [{
          id: "anthropic",
          name: "anthropic",
          models: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
        }],
      }),
    });

    const catalog = await loader.load();
    // 静态表有 11 条；活目录只给 1 条，且**不并集** —— 并集等于把
    // 「眼前这个 CLI 跑不了」的模型又塞回面板。
    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0].models).toEqual([{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }]);
    expect(catalog.defaultModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("falls back to the static table when discovery yields nothing", async () => {
    const loader = createModelCatalogLoader({
      agentName: "claude",
      execPath: "/fake/claude",
      runCommand: vi.fn(),
      readConfig: noConfig,
      discoverClaude: async () => null,
    });

    const catalog = await loader.load();
    expect(catalog.providers.length).toBeGreaterThan(0);
    expect(catalog.providers[0].id).toBe("anthropic");
    expect(catalog.providers[0].models.length).toBeGreaterThan(5);
  });
});
