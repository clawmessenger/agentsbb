/**
 * 设备运行状态协议（device_status_request / device_status_report）。
 *
 * 事故背景（2026-11-05）：三端「设备详情」页固定等满 15 秒超时，报「请求超时，
 * 设备可能离线」，而设备一直在线。查到设备端二进制里连 `device_status_request`
 * 这个字符串都没有 —— 协议从未实现。这里锁死两侧契约：
 *   - 请求判据只认 msg_type（空对象请求没有别的特征可依据）；
 *   - 应答必须**同时**给顶层 `data`（web 读它）和字符串 `content`（小程序读它）。
 */
import { describe, expect, it } from "vitest";
import {
  buildDeviceStatusReport,
  buildRuntimeDiagnostics,
  formatMegabytes,
  formatUptime,
  isStaleDeviceStatusRequest,
  parseDeviceStatusRequest,
  sessionsFromTable,
  STALE_DEVICE_STATUS_REQUEST_MS,
} from "./device-status.js";

const request = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ msg_type: "device_status_request", request_id: "req-1", ...extra });

describe("parseDeviceStatusRequest", () => {
  it("解析 web 的 CommandMessage 形状（字符串输入）", () => {
    expect(parseDeviceStatusRequest(request())).toEqual({ requestId: "req-1" });
  });

  it("接受已解析的对象（小程序 listener 给的是对象）", () => {
    expect(
      parseDeviceStatusRequest({ msg_type: "device_status_request", request_id: "req-2" }),
    ).toEqual({ requestId: "req-2" });
  });

  it("兼容 requestId 驼峰写法", () => {
    expect(
      parseDeviceStatusRequest({ msg_type: "device_status_request", requestId: "req-3" }),
    ).toEqual({ requestId: "req-3" });
  });

  it("别的 command 一律不认（讨论指令、模型目录、/use-model 都不能被误吞）", () => {
    expect(parseDeviceStatusRequest({ msg_type: "discussion_model_catalog_request" })).toBeNull();
    expect(parseDeviceStatusRequest({ service: "discussion", action: "your_turn" })).toBeNull();
    expect(parseDeviceStatusRequest({ content: "/use-model quukk/glm-5.2" })).toBeNull();
    // 空对象请求但**没有 msg_type**（老客户端）：不能靠「形状像」去猜，
    // 猜错会把一条普通消息当成状态请求吞掉。
    expect(parseDeviceStatusRequest("{}")).toBeNull();
  });

  it("缺 request_id 无法回执，按无效请求丢弃", () => {
    expect(parseDeviceStatusRequest({ msg_type: "device_status_request" })).toBeNull();
  });

  it("坏 JSON 不抛", () => {
    expect(parseDeviceStatusRequest("{not json")).toBeNull();
    expect(parseDeviceStatusRequest(null)).toBeNull();
    expect(parseDeviceStatusRequest(123)).toBeNull();
  });

  it("时间戳按毫秒透传（客户端发秒时也能识别）", () => {
    expect(parseDeviceStatusRequest(request({ timestamp: 1_700_000_000 }))?.timestamp).toBe(
      1_700_000_000,
    );
  });
});

describe("isStaleDeviceStatusRequest", () => {
  const now = 1_700_000_000_000;

  it("没有时间戳不判过期（宁可答一次，也不能让面板永远空着）", () => {
    expect(isStaleDeviceStatusRequest({ requestId: "x" }, now)).toBe(false);
  });

  it("秒级时间戳按秒解释：26 秒前不算过期，2 分钟前算", () => {
    expect(isStaleDeviceStatusRequest({ requestId: "x", timestamp: (now - 26_000) / 1000 }, now)).toBe(false);
    expect(isStaleDeviceStatusRequest({ requestId: "x", timestamp: (now - 120_000) / 1000 }, now)).toBe(true);
  });

  it("毫秒级时间戳同样处理", () => {
    expect(isStaleDeviceStatusRequest({ requestId: "x", timestamp: now - 1000 }, now)).toBe(false);
    expect(
      isStaleDeviceStatusRequest({ requestId: "x", timestamp: now - STALE_DEVICE_STATUS_REQUEST_MS - 1 }, now),
    ).toBe(true);
  });
});

describe("sessionsFromTable", () => {
  it("按 sessionKey 排序输出，字段齐全", () => {
    const list = sessionsFromTable({ "private:user-2": "sess-b", "private:user-1": "sess-a" });
    expect(list.map((s) => s.sessionKey)).toEqual(["private:user-1", "private:user-2"]);
    expect(list[0]).toEqual({
      sessionKey: "private:user-1",
      sessionId: "sess-a",
      label: "private:user-1",
      state: "idle",
    });
  });

  it("空表 → 空数组（面板显示「暂无 Session」，不是报错）", () => {
    expect(sessionsFromTable({})).toEqual([]);
  });
});

describe("buildRuntimeDiagnostics", () => {
  it("只出现这台进程真正知道的指标", () => {
    const d = buildRuntimeDiagnostics({
      pid: 4242,
      uptimeSec: 3 * 3600 + 12 * 60,
      rssBytes: 192 * 1024 * 1024,
      agentName: "codex",
      sessionCount: 3,
    });
    expect(d["进程 PID"]).toBe("4242");
    expect(d["已运行"]).toBe("3 小时 12 分");
    expect(d["内存占用"]).toBe("192 MB");
    expect(d["Agent"]).toBe("codex");
    expect(d["已登记会话"]).toBe("3");
    // 没有来源的指标不编造
    expect(d["CPU"]).toBeUndefined();
  });

  it("没给 agent 名就不出现那一行", () => {
    const d = buildRuntimeDiagnostics({ pid: 1, uptimeSec: 0, rssBytes: 0, sessionCount: 0 });
    expect(d.Agent).toBeUndefined();
  });
});

describe("formatUptime / formatMegabytes", () => {
  it("不足一分钟报秒，避免刚启动显示「0 分钟」", () => {
    expect(formatUptime(0)).toBe("0 秒");
    expect(formatUptime(59)).toBe("59 秒");
    expect(formatUptime(60)).toBe("1 分钟");
    expect(formatUptime(3600)).toBe("1 小时 0 分");
    expect(formatUptime(86400 + 5 * 3600)).toBe("1 天 5 小时");
  });

  it("超过 1 GB 用小数，避免「10240 MB」", () => {
    expect(formatMegabytes(512 * 1024 * 1024)).toBe("512 MB");
    expect(formatMegabytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});

describe("buildDeviceStatusReport", () => {
  const clock = () => 1_700_000_000_000;

  it("顶层 data 与字符串 content 同时给（web 读 data，小程序读 content）", () => {
    const raw = JSON.parse(
      buildDeviceStatusReport(
        { requestId: "req-9" },
        {
          version: "1.3.19",
          agentName: "codex",
          sessions: [{ sessionKey: "k", sessionId: "s", label: "k", state: "idle" }],
          diagnostics: { "进程 PID": "1" },
        },
        clock,
      ),
    );

    expect(raw.msg_type).toBe("device_status_report");
    expect(raw.request_id).toBe("req-9");
    expect(raw.timestamp).toBe(1_700_000_000_000);
    expect(raw.status).toBe("success");

    // web: payload = asRecord(record.content) || asRecord(record.data)
    expect(raw.data.version).toBe("1.3.19");
    expect(raw.data.sessions).toHaveLength(1);

    // 小程序: innerContent = JSON.parse(rawContent.content) → resolve(innerContent)
    const inner = JSON.parse(raw.content);
    expect(inner.status).toBe("success");
    expect(inner.data).toEqual(raw.data);
  });

  it("没有会话/诊断时给空结构，前端不会读到 undefined", () => {
    const raw = JSON.parse(buildDeviceStatusReport({ requestId: "r" }, { version: "" }, clock));
    expect(raw.data.sessions).toEqual([]);
    expect(raw.data.cron_jobs).toEqual([]);
    expect(raw.data.diagnostics).toEqual({});
    expect(raw.data.agent).toBeNull();
  });
});
