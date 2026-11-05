import { describe, expect, it, vi } from "vitest";
import {
  AgentCliInfoProbe,
  agentCliCommand,
  cliInstallDir,
  parseCliVersion,
  probeAgentCliInfo,
  readAgentCliInfoCache,
  type AgentCliInfoCache,
} from "./agent-runtime-info.js";

// --- 版本解析（纯函数） -----------------------------------------------------

describe("parseCliVersion", () => {
  it("从常见单行输出里取 semver", () => {
    expect(parseCliVersion("1.19.4")).toBe("1.19.4");
    expect(parseCliVersion("codex-cli 0.48.0")).toBe("0.48.0");
    expect(parseCliVersion("v0.25.3\n")).toBe("0.25.3");
    expect(parseCliVersion("hermes-agent 0.9.1-beta.2")).toBe("0.9.1-beta.2");
  });

  it("多行输出优先取带自己名字的那一行（不会被 node 版本顶掉）", () => {
    const raw = "node v22.23.2\ncodex-cli 0.48.0\n";
    expect(parseCliVersion(raw, "codex")).toBe("0.48.0");
    // 不给 hint 时退回第一处 semver —— 这是能接受的最坏情况，不是错值
    expect(parseCliVersion(raw)).toBe("22.23.2");
  });

  it("没有任何 semver 时退回首行原文（截断到 48 字符）", () => {
    expect(parseCliVersion("\n  build-unknown-20261105  \n")).toBe("build-unknown-20261105");
    expect(parseCliVersion("x".repeat(80)).length).toBe(48);
  });

  it("空输出返回空串（页面显示「-」而不是编一个版本）", () => {
    expect(parseCliVersion("")).toBe("");
    expect(parseCliVersion("\n\n  \n")).toBe("");
  });
});

describe("agentCliCommand", () => {
  it("ops 身份跑的是 opencode 可执行文件", () => {
    expect(agentCliCommand("ops")).toBe("opencode");
    expect(agentCliCommand("codex")).toBe("codex");
  });
});

describe("cliInstallDir", () => {
  it("取可执行文件所在目录；空路径返回空串", () => {
    expect(cliInstallDir("/usr/local/bin/codex")).toBe("/usr/local/bin");
    expect(cliInstallDir("")).toBe("");
  });
});

// --- 探测 ------------------------------------------------------------------

describe("probeAgentCliInfo", () => {
  const discover = async () => [
    { name: "codex", path: "/opt/bin/codex" },
    { name: "opencode", path: "/opt/bin/opencode" },
  ];

  it("按 agent 键探测路径与版本，ops 走 opencode", async () => {
    const runVersion = vi.fn(async (execPath: string) =>
      execPath.endsWith("codex") ? "codex-cli 0.48.0" : "1.19.4");
    const infos = await probeAgentCliInfo({
      agents: ["codex", "ops"],
      discover,
      runVersion,
    });
    expect(infos).toEqual([
      { agent: "codex", cliPath: "/opt/bin/codex", cliVersion: "0.48.0" },
      { agent: "ops", cliPath: "/opt/bin/opencode", cliVersion: "1.19.4" },
    ]);
    // 同一个 CLI 只探一次版本（ops 用的是 opencode，不是重复探测）
    expect(runVersion).toHaveBeenCalledTimes(2);
  });

  it("本机没装的 agent 不出现在结果里（不塞空记录）", async () => {
    const infos = await probeAgentCliInfo({
      agents: ["qwen"],
      discover,
      runVersion: async () => "0.25.3",
    });
    expect(infos).toEqual([]);
  });

  it("--version 抛错/超时时仍保留路径，版本留空", async () => {
    const infos = await probeAgentCliInfo({
      agents: ["codex"],
      discover,
      runVersion: async () => { throw new Error("timeout"); },
    });
    expect(infos).toEqual([{ agent: "codex", cliPath: "/opt/bin/codex", cliVersion: "" }]);
  });

  it("PATH 扫描失败不抛，等于一个都没装", async () => {
    const infos = await probeAgentCliInfo({
      agents: ["codex"],
      discover: async () => { throw new Error("PATH unreadable"); },
      runVersion: async () => "0.48.0",
    });
    expect(infos).toEqual([]);
  });

  it("重复/空白的 agent 键去重", async () => {
    const runVersion = vi.fn(async () => "0.48.0");
    const infos = await probeAgentCliInfo({
      agents: ["codex", " codex ", ""],
      discover,
      runVersion,
    });
    expect(infos).toHaveLength(1);
    expect(runVersion).toHaveBeenCalledTimes(1);
  });
});

// --- 缓存 + 后台刷新 -------------------------------------------------------

describe("AgentCliInfoProbe", () => {
  /** 极简内存文件系统，替代真实 ~/.clawmessenger。 */
  const createStore = () => {
    const files = new Map<string, string>();
    return {
      files,
      readFile: (p: string) => files.get(p) ?? null,
      writeFile: (p: string, content: string) => { files.set(p, content); },
    };
  };

  // AgentCliInfoProbe 内部直接用 readFileSync/writeFileSync，这里靠临时目录落盘
  // 验证真实行为（比 mock fs 更接近生产：写失败/格式错都要能扛）。
  const tmpPath = () => joinTmp(`agent-cli-info-${Math.random().toString(36).slice(2)}.json`);

  it("首次快照为空；refresh 后带上探测结果并落盘", async () => {
    const path = tmpPath();
    let now = 1_000;
    const probe = new AgentCliInfoProbe({
      path,
      now: () => now,
      discover: async () => [{ name: "codex", path: "/opt/bin/codex" }],
      runVersion: async () => "codex-cli 0.48.0",
      log: () => {},
    });
    expect(probe.snapshot().size).toBe(0);
    expect(probe.fresh()).toBe(false);

    probe.refresh(["codex"]);
    await flush();
    const snap = probe.snapshot();
    expect(snap.get("codex")).toEqual({ agent: "codex", cliPath: "/opt/bin/codex", cliVersion: "0.48.0" });
    expect(probe.fresh()).toBe(true);

    // 落盘内容可被下一次进程读回（重启后不必等探测就有值）
    const cache = readAgentCliInfoCache(path);
    expect(cache?.agents.codex?.cliVersion).toBe("0.48.0");
  });

  it("TTL 内不重探；过期后重探；新绑的 agent 立刻重探", async () => {
    const path = tmpPath();
    let now = 1_000;
    const runVersion = vi.fn(async (p: string) => (p.endsWith("codex") ? "0.48.0" : "1.19.4"));
    const probe = new AgentCliInfoProbe({
      path,
      now: () => now,
      ttlMs: 1_000,
      discover: async () => [
        { name: "codex", path: "/opt/bin/codex" },
        { name: "opencode", path: "/opt/bin/opencode" },
      ],
      runVersion,
      log: () => {},
    });

    probe.refresh(["codex"]);
    await flush();
    expect(runVersion).toHaveBeenCalledTimes(1);

    // TTL 内再来一轮：空操作
    now += 500;
    probe.refresh(["codex"]);
    await flush();
    expect(runVersion).toHaveBeenCalledTimes(1);

    // 新绑了 ops（= opencode）：即使 TTL 没到也要补探
    probe.refresh(["codex", "ops"]);
    await flush();
    const snap = probe.snapshot();
    expect(snap.get("ops")?.cliVersion).toBe("1.19.4");
  });

  it("某次探测超时的 agent 保留上一次的版本，不会被抹成空", async () => {
    const path = tmpPath();
    let fail = false;
    const probe = new AgentCliInfoProbe({
      path,
      ttlMs: 0,
      discover: async () => [{ name: "codex", path: "/opt/bin/codex" }],
      runVersion: async () => {
        if (fail) throw new Error("timeout");
        return "0.48.0";
      },
      log: () => {},
    });
    probe.refresh(["codex"]);
    await flush();
    expect(probe.snapshot().get("codex")?.cliVersion).toBe("0.48.0");

    fail = true;
    probe.refresh(["codex"], { force: true });
    await flush();
    // 探到的是「路径有、版本空」——空版本不得覆盖已知版本
    expect(probe.snapshot().get("codex")?.cliVersion).toBe("0.48.0");
  });

  it("损坏的缓存文件当成没探过（不抛）", () => {
    const path = tmpPath();
    writeBadCache(path);
    const probe = new AgentCliInfoProbe({ path, log: () => {} });
    expect(probe.snapshot().size).toBe(0);
    expect(probe.fresh()).toBe(false);
  });
});

// --- 小工具 -----------------------------------------------------------------

function joinTmp(name: string): string {
  const dir = process.env.TMPDIR || process.env.TEMP || "/tmp";
  return `${dir.replace(/\\/g, "/")}/${name}`;
}

function writeBadCache(path: string): void {
  // 直接写坏 JSON：模拟升级中断/磁盘写一半
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(path, "{ not json", "utf8");
}

/** 让出事件循环，等 refresh() 的后台 promise 跑完（探测是纯内存，微任务即可）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 类型占位：确保 AgentCliInfoCache 的形态被测试引用到（防止字段改名后测试静默失配）
const _cacheShape: AgentCliInfoCache = { version: 1, probedAt: 0, agents: {} };
void _cacheShape;
