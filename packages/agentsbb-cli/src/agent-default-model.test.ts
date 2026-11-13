// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultAgentModelPath,
  FileAgentDefaultModelStore,
  isModelRoute,
  MemoryAgentDefaultModelStore,
} from "./agent-default-model.js";
import {
  buildAgentDefaultModelResponse,
  parseAgentDefaultModelRequest,
} from "./model-catalog.js";

/**
 * 「通讯录 → 智能体详情 → 默认模型」落盘的那一份偏好。
 *
 * 修的是线上反馈「设置默认对话模型好像无用」：过去这个值只存在浏览器
 * localStorage，再由 web 在打开单聊时补发 per-user 的 `/use-model`。换浏览器就
 * 丢，而群聊 / 讨论组的轮次由服务端派发、根本不经过那条补发 —— 用户设了模型，
 * 界面没有任何变化。现在它落在设备端，run.ts 在三类轮次里兜底读取。
 */

describe("defaultAgentModelPath", () => {
  it("per-node file so supervisor children never clobber each other", () => {
    const a = defaultAgentModelPath("opencode_1234567890");
    const b = defaultAgentModelPath("codex_1234567890");
    expect(a).not.toBe(b);
    expect(a.endsWith("agent-default-model-opencode_1234567890.json")).toBe(true);
  });

  it("sanitises ids that would otherwise escape the directory", () => {
    expect(defaultAgentModelPath("../../etc/passwd")).not.toContain("/etc/passwd");
  });

  it("falls back to an unsuffixed name without a node id", () => {
    expect(defaultAgentModelPath()).toContain("agent-default-model.json");
  });
});

describe("isModelRoute", () => {
  it("accepts provider/model, rejects everything the agent CLI would choke on", () => {
    expect(isModelRoute("quukk/glm-5.2")).toBe(true);
    expect(isModelRoute("anthropic/claude-sonnet-4")).toBe(true);
    expect(isModelRoute("glm-5.2")).toBe(false); // 没有 provider 段
    expect(isModelRoute("a/b/c")).toBe(false); // 多一个斜杠
    expect(isModelRoute("quukk/ glm-5.2")).toBe(false); // 空白
    expect(isModelRoute("")).toBe(false);
    expect(isModelRoute(null)).toBe(false);
  });
});

describe("FileAgentDefaultModelStore", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cm-agent-default-model-"));
    path = join(dir, "agent-default-model-node_1.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through disk (survives supervisor restart)", () => {
    new FileAgentDefaultModelStore(path).set("quukk/glm-5.2");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "quukk/glm-5.2" });
    // 新实例读同一个文件：重启不丢，才是「默认」该有的样子。
    expect(new FileAgentDefaultModelStore(path).get()).toBe("quukk/glm-5.2");
  });

  it("clearing writes an empty object and reads back as unset", () => {
    const store = new FileAgentDefaultModelStore(path);
    store.set("quukk/glm-5.2");
    store.set(null);
    expect(store.get()).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
    expect(new FileAgentDefaultModelStore(path).get()).toBeUndefined();
  });

  it("rejects an illegal route instead of handing the agent a --model it will die on", () => {
    const store = new FileAgentDefaultModelStore(path);
    store.set("glm-5.2");
    expect(store.get()).toBeUndefined();
  });

  it("treats a corrupted file as unset rather than throwing forever", () => {
    writeFileSync(path, "{ not json", "utf8");
    const store = new FileAgentDefaultModelStore(path);
    expect(store.get()).toBeUndefined();
    // 坏过一次不该让这台 agent 的默认模型永久报错：写一次就自愈。
    store.set("quukk/glm-5.2");
    expect(new FileAgentDefaultModelStore(path).get()).toBe("quukk/glm-5.2");
  });
});

describe("MemoryAgentDefaultModelStore", () => {
  it("behaves like the file store (tests / read-only home degrade path)", () => {
    const store = new MemoryAgentDefaultModelStore("quukk/glm-5.2");
    expect(store.get()).toBe("quukk/glm-5.2");
    store.set(null);
    expect(store.get()).toBeUndefined();
    store.set("a/b");
    expect(store.get()).toBe("a/b");
    store.set("bad");
    expect(store.get()).toBeUndefined();
  });
});

describe("默认模型协议（protocol v2）", () => {
  const valid = JSON.stringify({
    msg_type: "discussion_agent_default_model_request",
    protocolVersion: 2,
    requestId: "req-1",
    model: "quukk/glm-5.2",
    timestamp: 1,
  });

  it("parses a well-formed request", () => {
    expect(parseAgentDefaultModelRequest(valid)).toMatchObject({
      msg_type: "discussion_agent_default_model_request",
      protocolVersion: 2,
      requestId: "req-1",
      model: "quukk/glm-5.2",
    });
  });

  it("accepts model=null (恢复节点默认)", () => {
    const parsed = parseAgentDefaultModelRequest(JSON.stringify({
      msg_type: "discussion_agent_default_model_request",
      protocolVersion: 2,
      requestId: "req-2",
      model: null,
    }));
    expect(parsed?.model).toBeNull();
  });

  it("rejects malformed routes and missing ids", () => {
    const withModel = (model: unknown) => JSON.stringify({
      msg_type: "discussion_agent_default_model_request",
      protocolVersion: 2,
      requestId: "req-3",
      model,
    });
    expect(parseAgentDefaultModelRequest(withModel("glm-5.2"))).toBeNull();
    expect(parseAgentDefaultModelRequest(withModel(123))).toBeNull();
    expect(parseAgentDefaultModelRequest(JSON.stringify({
      msg_type: "discussion_agent_default_model_request",
      protocolVersion: 1,
      requestId: "req-3",
      model: "a/b",
    }))).toBeNull();
    // 不是本协议：留给别的消费者（目录请求 / your_turn）。
    expect(parseAgentDefaultModelRequest(JSON.stringify({
      msg_type: "discussion_model_catalog_request",
      protocolVersion: 2,
      requestId: "req-4",
    }))).toBeNull();
  });

  it("builds a response carrying the value actually persisted", () => {
    const request = parseAgentDefaultModelRequest(valid)!;
    const payload = JSON.parse(buildAgentDefaultModelResponse(request, "quukk/glm-5.2", null, () => 42));
    expect(payload).toEqual({
      msg_type: "discussion_agent_default_model_response",
      protocolVersion: 2,
      requestId: "req-1",
      ok: true,
      model: "quukk/glm-5.2",
      timestamp: 42,
    });
  });

  it("reports the error branch without pretending it saved", () => {
    const request = parseAgentDefaultModelRequest(valid)!;
    const payload = JSON.parse(buildAgentDefaultModelResponse(request, null, "磁盘只读", () => 7));
    expect(payload.ok).toBe(false);
    expect(payload.model).toBeNull();
    expect(payload.error).toBe("磁盘只读");
  });
});
