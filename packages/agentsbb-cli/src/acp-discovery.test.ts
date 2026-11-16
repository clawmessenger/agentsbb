import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  acpRouteFromModelId,
  catalogFromAcpRoutes,
  discoverAcpModelCatalog,
  parseAcpSessionModels,
} from "./acp-discovery.js";

// 一个最小的 ACP server 桩：按行读 JSON-RPC，对 initialize / session/new 回
// 预置结果。用真子进程而不是 spawn 假实现，是因为这里最容易出错的恰恰是
// 「行缓冲 / 进程收尾 / 不退出」这类只在真实管道上暴露的行为。
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "acp-discovery-test-"));
afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

function writeServer(name: string, sessionResult: unknown, opts: { exitEarly?: boolean } = {}): string {
  const path = join(FIXTURE_DIR, `${name}.mjs`);
  writeFileSync(path, `
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
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function handle(line) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    if (${opts.exitEarly ? "true" : "false"}) process.exit(0);
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: ${JSON.stringify(sessionResult)} });
    // ACP server 通常不会自己退出：这里保持挂起，验证探测端能收尾。
    return;
  }
}
`);
  return path;
}

describe("acpRouteFromModelId", () => {
  it("keeps an already-qualified provider/model route", () => {
    expect(acpRouteFromModelId("quukk/glm-5.2", "kiro")).toBe("quukk/glm-5.2");
    expect(acpRouteFromModelId("kimi-code/k3", "kimi")).toBe("kimi-code/k3");
  });

  it("groups a bare id under the provider fallback", () => {
    expect(acpRouteFromModelId("claude-sonnet-4-5", "kiro")).toBe("kiro/claude-sonnet-4-5");
    expect(acpRouteFromModelId("auto", "cursor")).toBe("cursor/auto");
  });

  it("drops ids the wire shape cannot carry", () => {
    expect(acpRouteFromModelId("a/b/c", "kiro")).toBeNull();
    expect(acpRouteFromModelId("has space", "kiro")).toBeNull();
    expect(acpRouteFromModelId("   ", "kiro")).toBeNull();
    expect(acpRouteFromModelId("-bad", "kiro")).toBeNull();
  });
});

describe("parseAcpSessionModels", () => {
  it("reads the legacy models.availableModels block and its currentModelId", () => {
    const parsed = parseAcpSessionModels(
      {
        sessionId: "s1",
        models: {
          availableModels: [
            { modelId: "claude-sonnet-4-5", name: "Sonnet 4.5" },
            { modelId: "gpt-5.2" },
            { modelId: "claude-sonnet-4-5" },
          ],
          currentModelId: "gpt-5.2",
        },
      },
      "kiro",
    );
    expect(parsed).toEqual({
      routes: ["kiro/claude-sonnet-4-5", "kiro/gpt-5.2"],
      defaultRoute: "kiro/gpt-5.2",
    });
  });

  it("accepts the snake_case variant", () => {
    const parsed = parseAcpSessionModels(
      {
        models: {
          available_models: [{ model_id: "quukk/glm-5.2" }],
          current_model_id: "quukk/glm-5.2",
        },
      },
      "hermes",
    );
    expect(parsed).toEqual({ routes: ["quukk/glm-5.2"], defaultRoute: "quukk/glm-5.2" });
  });

  it("reads the newer configOptions shape (kimi 0.29+) and ignores thinking", () => {
    const parsed = parseAcpSessionModels(
      {
        sessionId: "s2",
        configOptions: [
          {
            type: "select", id: "thinking", category: "thought_level",
            options: [{ value: "low" }, { value: "high" }],
          },
          {
            type: "select", id: "model", category: "model", currentValue: "kimi-code/k3",
            options: [{ value: "kimi-code/k3" }, { value: "kimi-code/kimi-for-coding" }],
          },
        ],
      },
      "kimi",
    );
    expect(parsed).toEqual({
      routes: ["kimi-code/k3", "kimi-code/kimi-for-coding"],
      defaultRoute: "kimi-code/k3",
    });
  });

  it("returns null when the payload has no catalog at all", () => {
    expect(parseAcpSessionModels({ sessionId: "s3" }, "kiro")).toBeNull();
    expect(parseAcpSessionModels(null, "kiro")).toBeNull();
    expect(parseAcpSessionModels({ models: { availableModels: [] } }, "kiro")).toBeNull();
  });
});

describe("catalogFromAcpRoutes", () => {
  it("groups by provider and only reports a default that exists", () => {
    const catalog = catalogFromAcpRoutes(
      ["b/z", "a/y", "a/x", "b/z"],
      "a/x",
    );
    expect(catalog.providers).toEqual([
      { id: "a", name: "a", models: [{ id: "x", name: "x" }, { id: "y", name: "y" }] },
      { id: "b", name: "b", models: [{ id: "z", name: "z" }] },
    ]);
    expect(catalog.defaultModel).toBe("a/x");
    expect(catalogFromAcpRoutes(["a/x"], "b/missing").defaultModel).toBeNull();
  });
});

describe("discoverAcpModelCatalog", () => {
  it("returns the session/new catalog from a real ACP-speaking child", async () => {
    const script = writeServer("ok", {
      sessionId: "s1",
      models: {
        availableModels: [
          { modelId: "claude-sonnet-4-5", name: "Sonnet 4.5" },
          { modelId: "quukk/glm-5.2", name: "GLM 5.2" },
        ],
        currentModelId: "quukk/glm-5.2",
      },
    });
    const catalog = await discoverAcpModelCatalog({
      execPath: process.execPath,
      spec: { args: [script], providerFallback: "kiro" },
    });
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["kiro", "quukk"]);
    expect(catalog.defaultModel).toBe("quukk/glm-5.2");
  });

  it("degrades to an empty catalog when the child dies before session/new", async () => {
    const script = writeServer("early-exit", {}, { exitEarly: true });
    const reasons: string[] = [];
    const catalog = await discoverAcpModelCatalog({
      execPath: process.execPath,
      spec: { args: [script], providerFallback: "kiro" },
      logger: (message) => reasons.push(message),
    });
    expect(catalog).toEqual({ defaultModel: null, providers: [] });
    expect(reasons.join("\n")).toMatch(/exited before session\/new|handshake failed/);
  });

  it("degrades to an empty catalog when the child never answers", async () => {
    const script = join(FIXTURE_DIR, "silent.mjs");
    writeFileSync(script, "process.stdin.resume();\n");
    const catalog = await discoverAcpModelCatalog({
      execPath: process.execPath,
      spec: { args: [script], providerFallback: "kiro", timeoutMs: 400 },
    });
    expect(catalog).toEqual({ defaultModel: null, providers: [] });
  });

  it("degrades to an empty catalog when the binary is missing", async () => {
    const catalog = await discoverAcpModelCatalog({
      execPath: join(FIXTURE_DIR, "does-not-exist-binary"),
      spec: { args: ["acp"], providerFallback: "kiro" },
    });
    expect(catalog).toEqual({ defaultModel: null, providers: [] });
  });
});
