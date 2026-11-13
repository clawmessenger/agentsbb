// @vitest-environment node
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowDuplicateSupervisor, buildProgram, commanderExit, OPS_SCOPE_ENV, scopeDaemonReport, SUPERVISED_ENV, supervisedSelfKillRejection, waitForAliveFor, wholeMachineActionRejection } from "./main.js";
import { Keystore } from "./keystore.js";
import type { XiachatApi } from "./api.js";
import { defaultDaemonPaths, type Daemon, type DaemonPaths } from "./daemon.js";
import type { FetchLike } from "./self-update.js";

const dirs: string[] = [];
function tempKeystore(): Keystore {
  const d = mkdtempSync(join(tmpdir(), "agentsbb-main-"));
  dirs.push(d);
  return new Keystore(join(d, "creds.json"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("agentsbb register", () => {
  it("stores credentials from the server response", async () => {
    const keystore = tempKeystore();
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      register: async () => ({ nodeId: "node_1", token: "tok_1", deviceCredentialTicket: "dc_1", bindingVersion: 1 }),
      claimPairing: async () => ({ deviceCredentialId: "", deviceSecret: "", nodeId: "" }),
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "test-machine-1",
    });
    await program.parseAsync(["node", "agentsbb", "register", "--name", "我的Claude", "--ai-type", "claude", "--server", "http://srv"]);
    const stored = keystore.load();
    expect(stored?.nodeId).toBe("node_1");
    expect(stored?.token).toBe("tok_1");
    expect(stored?.serverUrl).toBe("http://srv");
  });

  it("sends a non-empty stable mac_address on register", async () => {
    const keystore = tempKeystore();
    const seenMac: string[] = [];
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      register: async (params: { macAddress?: string }) => {
        seenMac.push(params.macAddress ?? "");
        return { nodeId: "node_1", token: "tok_1" };
      },
      claimPairing: async () => ({ deviceCredentialId: "", deviceSecret: "", nodeId: "" }),
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "test-machine-2",
    });
    await program.parseAsync(["node", "agentsbb", "register", "--name", "n", "--ai-type", "claude", "--server", "http://srv"]);
    await program.parseAsync(["node", "agentsbb", "register", "--name", "n", "--ai-type", "claude", "--server", "http://srv"]);
    expect(seenMac[0]).toBe("test-machine-2");
    expect(seenMac[1]).toBe(seenMac[0]);
  });

  it("register --server is required", async () => {
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
    });
    await expect(
      program.parseAsync(["node", "agentsbb", "register", "--name", "n", "--ai-type", "claude"]),
    ).rejects.toThrow();
  });

  it("surfaces a pairing-ticket hint on workspace attribution errors", async () => {
    const keystore = tempKeystore();
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      register: async () => {
        throw new Error("POST /api/ai/register: HTTP 400: workspace attribution required: provide a pairing_ticket");
      },
      claimPairing: async () => ({ deviceCredentialId: "", deviceSecret: "", nodeId: "" }),
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "test-machine-1",
    });
    await expect(
      program.parseAsync(["node", "agentsbb", "register", "--name", "n", "--ai-type", "claude", "--server", "http://srv"]),
    ).rejects.toThrow(/--pairing-ticket/);
    expect(keystore.load()).toBeNull();
  });
});

describe("agentsbb pair", () => {
  /**
   * 2026-10-27 flaky 定位（Tess）：这三例在负载下发过 `Test timed out in
   * 20000ms/60000ms`，断言本身一次都没失败过。
   *
   * 真因不是断言窗口：`pair` 的动作里会先 `discoverAgents({})` 扫**整条真实
   * PATH**（25 个 CLI 名 × 本机 49 个目录 × 3 个扩展名 ≈ 3,700 次 `fs.access`）。
   * 本机实测单次 490–914ms；某个磁盘/杀软繁忙的窗口里 3 次调用合计 **52s**。
   * 这几例各跑 1–3 次 `pair`，于是基线 1.5s 的用例在负载下被这串 stat 拖到超时。
   *
   * 修法是**隔离环境**而不是放宽断言：PATH 指空 ⇒ 扫描 0ms，等价于「这台机器
   * 没装任何 agent CLI」。这几例只断言幂等键/keystore 落盘，agent 列表不参与
   * 任何断言，所以语义不变。
   */
  beforeEach(() => {
    vi.stubEnv("PATH", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not overwrite the keystore when the ticket was already claimed", async () => {
    const keystore = tempKeystore();
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      register: async () => ({ nodeId: "node_1", token: "tok_1" }),
      claimPairing: async () => ({
        deviceCredentialId: "dc_9",
        deviceSecret: "",
        nodeId: "node_2",
        session: { status: "claimed", ticket: "st_1" },
      }),
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      ensureOpencode: async () => ({}),
    });
    await expect(
      program.parseAsync(["node", "agentsbb", "pair", "--ticket", "pt_1"]),
    ).rejects.toThrow(/already claimed/);
    // The register step still persisted its own node identity, but the
    // claimed-by-another-device result must not overwrite it.
    expect(keystore.load()?.nodeId).toBe("node_1");
  });

  it("derives the same idempotency key across retries on one machine", async () => {
    const keystore = tempKeystore();
    const seenIdemKeys: string[] = [];
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      register: async () => ({ nodeId: "node_5", token: "tok_5" }),
      claimPairing: async (_ticket: string, _cck: string, idemKey: string) => {
        seenIdemKeys.push(idemKey);
        return {
          deviceCredentialId: "dc_1",
          deviceSecret: "sec_1",
          nodeId: "node_5",
        };
      },
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "machine-A",
      ensureOpencode: async () => ({}),
    });
    // A retried claim after a lost response: same ticket, same machine.
    await program.parseAsync(["node", "agentsbb", "pair", "--ticket", "pt_same"]);
    await program.parseAsync(["node", "agentsbb", "pair", "--ticket", "pt_same"]);
    expect(seenIdemKeys).toHaveLength(2);
    expect(seenIdemKeys[0]).toBe(seenIdemKeys[1]);
    expect(seenIdemKeys[0]).toMatch(/^idem-[0-9a-f]{24}$/);

    // A different ticket on the same machine derives a different key.
    await program.parseAsync(["node", "agentsbb", "pair", "--ticket", "pt_other"]);
    expect(seenIdemKeys[2]).not.toBe(seenIdemKeys[0]);
  });

  it("derives a different idempotency key per machine", async () => {
    const keystore = tempKeystore();
    const seenIdemKeys: string[] = [];
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      register: async () => ({ nodeId: "node_6", token: "tok_6" }),
      claimPairing: async (_ticket: string, _cck: string, idemKey: string) => {
        seenIdemKeys.push(idemKey);
        return { deviceCredentialId: "dc_1", deviceSecret: "s", nodeId: "node_6" };
      },
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "machine-B",
      ensureOpencode: async () => ({}),
    });
    await program.parseAsync(["node", "agentsbb", "pair", "--ticket", "pt_same"]);
    const machineBKey = seenIdemKeys[0];
    const program2 = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "machine-C",
      ensureOpencode: async () => ({}),
    });
    await program2.parseAsync(["node", "agentsbb", "pair", "--ticket", "pt_same"]);
    expect(seenIdemKeys[1]).not.toBe(machineBKey);
  });
});

describe("commander 控制流异常的退出码", () => {
  // 发布流水线要用 `<exe> --version` 跟 tag 逐字符比对，所以 `--version` 必须是
  // **exit 0**。buildProgram 为了在进程内跑测试用了 exitOverride()，commander 于是
  // 用抛异常表达「已打印、该退出」——生产入口漏翻译的表现就是打印对了版本却 exit 1。
  it("treats --version / --help as success", () => {
    expect(commanderExit({ code: "commander.version", exitCode: 0, message: "1.3.0" }))
      .toEqual({ exitCode: 0, printMessage: false });
    expect(commanderExit({ code: "commander.helpDisplayed", exitCode: 0, message: "(help)" }))
      .toEqual({ exitCode: 0, printMessage: false });
  });

  it("keeps real usage errors failing and prints the message", () => {
    expect(commanderExit({ code: "commander.unknownOption", exitCode: 1, message: "unknown option" }))
      .toEqual({ exitCode: 1, printMessage: true });
  });

  it("ignores ordinary errors", () => {
    expect(commanderExit(new Error("boom"))).toBeNull();
  });
});

describe("waitForAliveFor 的第三个参数是毫秒，不是次数（B1 的根因）", () => {
  // 老签名是 `(pid, sleep, attempts = 15, intervalMs = 200)`，调用方写 `3_000` 想表达
  // 「等 3 秒」，实际是 3000 次 × 200ms = 10 分钟：父进程把端口锁捏了十分钟，子进程
  // 在锁上等 15s 就自杀，于是每次远程升级都「磁盘是新版、设备没 supervisor」。
  it("按时间窗结束，而不是按传入的那个数字跑那么多次", async () => {
    const sleeps: number[] = [];
    const realSleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    };
    const started = Date.now();
    const alive = await waitForAliveFor(process.pid, realSleep, 120, 50);
    const elapsed = Date.now() - started;
    expect(alive).toBe(true);
    // 120ms / 50ms → 2~3 次。若把 120 当成「次数」则是 120 次（约 6 秒）。
    expect(sleeps.length).toBeLessThanOrEqual(5);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("进程已经没了就立刻返回 false，不空等整个窗口", async () => {
    const sleeps: number[] = [];
    const started = Date.now();
    const alive = await waitForAliveFor(999_999, async (ms) => { sleeps.push(ms) }, 5_000, 50);
    expect(alive).toBe(false);
    expect(sleeps).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// 后台常驻命令面：这些动作以前只能靠随 Release 分发的守护脚本提供
// （agentsbb-daemon.sh / .cmd），现在直接编进 CLI。
function fakeDaemon(overrides: Partial<Daemon> = {}): { daemon: Daemon; calls: string[] } {
  const calls: string[] = [];
  const daemon: Daemon = {
    start: async (o) => { calls.push(`start:${JSON.stringify(o ?? {})}`); },
    stop: async () => { calls.push("stop"); },
    restart: async (o) => { calls.push(`restart:${JSON.stringify(o ?? {})}`); },
    status: () => ({ platform: "linux", running: false, stale: false, agents: [], logs: [], serviceName: "agentsbb" }),
    logs: (o) => { calls.push(`logs:${o?.lines ?? 40}`); },
    // 看门狗：计划任务每 5 分钟调一次，绝大多数时候返回 false（什么都没做）。
    watchdog: async (o) => { calls.push(`watchdog:${JSON.stringify(o ?? {})}`); return true; },
    // 常驻看门狗循环：只在 `watchdog --loop`（schtasks 被拦的降级兜底）时进入。
    watchdogLoop: async () => { calls.push("watchdog-loop"); },
    watchdogLoopRunning: () => false,
    // 存量设备升级时自动补看门狗：默认「什么都不用做」（非 Windows 的常态）。
    ensureWatchdog: async () => { calls.push("ensure-watchdog"); return { created: false, reason: "not-windows" }; },
    installService: async (o) => { calls.push(`install-service:${JSON.stringify(o ?? {})}`); },
    uninstall: async () => { calls.push("uninstall"); },
    // 登录自启脚本的模板刷新：这里不需要模拟文件系统，记一笔即可。
    refreshStartupScript: async () => ({ updated: false, path: "/nonexistent/agentsbb.vbs", reason: "no-logon-script" }),
    // 常驻自愈判据：默认「非 Windows，无需看门狗」—— Linux 上 install-service
    // 装的是 systemd 单元，而不是计划任务。
    serviceHealth: () => ({ ready: true, detail: "systemd 服务" }),
    ...overrides,
  };
  return { daemon, calls };
}

describe("agentsbb status", () => {
  it("prints stored identity", async () => {
    const keystore = tempKeystore();
    keystore.save({ nodeId: "node_9", token: "t", serverUrl: "http://srv" });
    const lines: string[] = [];
    const program = buildProgram({
      keystore,
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
      daemon: fakeDaemon().daemon,
      daemonPaths: defaultDaemonPaths(join(tmpdir(), "agentsbb-daemon-unused")),
    });
    await program.parseAsync(["node", "agentsbb", "status"]);
    expect(lines.join("")).toContain("node_9");
  });

  it("appends whether the supervisor is running in the background", async () => {
    const keystore = tempKeystore();
    keystore.save({ nodeId: "node_9", token: "t", serverUrl: "http://srv" });
    const lines: string[] = [];
    const program = buildProgram({
      keystore,
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
      daemon: fakeDaemon({
        status: () => ({
          platform: "linux",
          running: true,
          stale: false,
          pid: 4242,
          uptimeMs: 65_000,
          agents: ["claude", "codex"],
          logs: ["/home/u/.agentsbb/logs/supervisor.log"],
          serviceName: "agentsbb",
        }),
      }).daemon,
      daemonPaths: defaultDaemonPaths(join(tmpdir(), "agentsbb-daemon-unused")),
    });
    await program.parseAsync(["node", "agentsbb", "status"]);
    const text = lines.join("");
    expect(text).toContain("node_9");
    expect(text).toContain("daemon : running in the background (PID 4242, up 1m05s)");
    expect(text).toContain("2 (claude, codex)");
    expect(text).toContain("supervisor.log");
  });
});

describe("agentsbb background commands", () => {
  it("start passes --model and --workdir through", async () => {
    const { daemon, calls } = fakeDaemon();
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
      daemon,
    });
    await program.parseAsync(["node", "agentsbb", "start", "--model", "gpt-5", "--workdir", "/srv/work"]);
    expect(calls).toEqual(['start:{"model":"gpt-5","workdir":"/srv/work"}']);
  });

  it("stop and restart reach the daemon", async () => {
    const { daemon, calls } = fakeDaemon();
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
      daemon,
    });
    await program.parseAsync(["node", "agentsbb", "stop"]);
    await program.parseAsync(["node", "agentsbb", "restart"]);
    expect(calls).toEqual(["stop", "restart:{}"]);
  });

  it("logs honours --lines and defaults to 40", async () => {
    const { daemon, calls } = fakeDaemon();
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
      daemon,
    });
    await program.parseAsync(["node", "agentsbb", "logs", "--lines", "5"]);
    await program.parseAsync(["node", "agentsbb", "logs"]);
    await program.parseAsync(["node", "agentsbb", "logs", "--lines", "not-a-number"]);
    expect(calls).toEqual(["logs:5", "logs:40", "logs:40"]);
  });

  it("install-service and uninstall reach the daemon", async () => {
    const { daemon, calls } = fakeDaemon();
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
      daemon,
    });
    await program.parseAsync(["node", "agentsbb", "install-service"]);
    await program.parseAsync(["node", "agentsbb", "uninstall"]);
    expect(calls).toEqual(["install-service:{}", "uninstall"]);
  });

  it("watchdog is a top-level command: it is what the Windows scheduled task invokes", async () => {
    const { daemon, calls } = fakeDaemon();
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
      daemon,
    });
    await program.parseAsync(["node", "agentsbb", "watchdog"]);
    expect(calls).toEqual(["watchdog:{}"]);
  });

  it("watchdog --loop enters the resident loop instead of the one-shot check", async () => {
    const { daemon, calls } = fakeDaemon();
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
      daemon,
    });
    await program.parseAsync(["node", "clawmessenger", "watchdog", "--loop"]);
    expect(calls).toEqual(["watchdog-loop"]);
  });

  it("the `daemon` namespace dispatches every action", async () => {
    const { daemon, calls } = fakeDaemon();
    const lines: string[] = [];
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
      daemon,
      daemonPaths: defaultDaemonPaths(join(tmpdir(), "agentsbb-daemon-unused")),
    });
    for (const action of ["start", "stop", "restart", "logs", "watchdog", "install-service", "uninstall"]) {
      await program.parseAsync(["node", "agentsbb", "daemon", action]);
    }
    await program.parseAsync(["node", "agentsbb", "daemon", "status"]);
    expect(calls).toEqual(["start:{}", "stop", "restart:{}", "logs:40", "watchdog:{}", "install-service:{}", "uninstall"]);
    expect(lines.join("")).toContain("not running in the background");
  });

  it("rejects an unknown daemon action instead of silently doing nothing", async () => {
    const { daemon, calls } = fakeDaemon();
    const program = buildProgram({
      keystore: tempKeystore(),
      apiFactory: () => { throw new Error("should not be called"); },
      stdout: process.stdout,
      daemon,
    });
    await expect(program.parseAsync(["node", "agentsbb", "daemon", "explode"])).rejects.toThrow(
      /unknown daemon action 'explode'/,
    );
    expect(calls).toEqual([]);
  });
});

describe("agentsbb run (supervisor mode)", () => {
  // 回归护栏：supervisor 会被 start 之外的入口直接拉起（开机自启 .vbs、守护脚本的
  // -Action run、手敲 `agentsbb run`），那些入口绕过 start 的检查。两份
  // supervisor 派生同样的融云节点 id —— 互相踢线 + 同一条私聊被各答一次。
  it("refuses to start a second supervisor while one is already running", async () => {
    const keystore = tempKeystore();
    keystore.save({ nodeId: "node_9", token: "t", serverUrl: "http://srv" });
    const stateDir = mkdtempSync(join(tmpdir(), "agentsbb-supervisor-guard-"));
    dirs.push(stateDir);
    const paths = defaultDaemonPaths(stateDir);
    // 需要一个「确实活着、但不是本进程」的 pid，否则会命中「pid 就是我自己」的放行分支。
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
    const previousExitCode = process.exitCode;
    try {
      await once(sleeper, "spawn");
      const pid = sleeper.pid as number;
      writeFileSync(paths.pidFile, `${pid}\n`);
      writeFileSync(
        paths.stateFile,
        JSON.stringify({
          pid,
          startedAt: 1,
          execPath: "/opt/agentsbb/agentsbb",
          cwd: "/home/u",
          agents: ["opencode", "ops"],
        }),
      );

      const lines: string[] = [];
      const program = buildProgram({
        keystore,
        apiFactory: () => ({}) as unknown as XiachatApi,
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemonPaths: paths,
      });
      await program.parseAsync(["node", "agentsbb", "run"]);

      const text = lines.join("");
      expect(text).toContain(`another agentsbb supervisor is already running (PID ${pid}`);
      expect(text).toContain("opencode, ops");
      expect(text).toContain("agentsbb stop");
      expect(text).toContain("AGENTSBB_ALLOW_DUPLICATE_SUPERVISOR=1");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      sleeper.kill();
    }
  });

  // pid 文件防线拦不住孤儿 supervisor：pid 文件指向死进程、真身还活着（强杀、
  // 沙箱回收拉起方等）。端口锁与进程同生死，兜这道缝（2026-10-20 现场两套
  // 进程树并存两小时，同一条私聊被各答一遍）。
  it("refuses via the singleton port lock when no live pid file exists", async () => {
    const keystore = tempKeystore();
    keystore.save({ nodeId: "node_9", token: "t", serverUrl: "http://srv" });
    const stateDir = mkdtempSync(join(tmpdir(), "agentsbb-supervisor-lock-"));
    dirs.push(stateDir);
    const paths = defaultDaemonPaths(stateDir);
    // 不写任何 pid/state 文件 —— findLiveSupervisor 返回 null，走端口锁。

    const lines: string[] = [];
    const program = buildProgram({
      keystore,
      apiFactory: () => ({}) as unknown as XiachatApi,
      stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
      daemonPaths: paths,
      // 假锁：直接回 null 模拟「端口已被别人占着」。
      acquireLock: () => Promise.resolve(null),
    });
    const previousExitCode = process.exitCode;
    try {
      await program.parseAsync(["node", "agentsbb", "run"]);
      const text = lines.join("");
      expect(text).toContain("singleton lock held, no live pid file");
      expect(text).toContain("AGENTSBB_ALLOW_DUPLICATE_SUPERVISOR=1");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("starts normally when the singleton lock is acquired", async () => {
    const keystore = tempKeystore();
    keystore.save({ nodeId: "node_9", token: "t", serverUrl: "http://srv" });
    const stateDir = mkdtempSync(join(tmpdir(), "agentsbb-supervisor-lock-ok-"));
    dirs.push(stateDir);
    const paths = defaultDaemonPaths(stateDir);

    const lines: string[] = [];
    let lockReleased = false;
    const program = buildProgram({
      keystore,
      apiFactory: () => ({}) as unknown as XiachatApi,
      stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
      daemonPaths: paths,
      acquireLock: () => Promise.resolve({ release: () => { lockReleased = true; } }),
      // runSupervisor 会拉子进程 —— 用一个会立即失败的 spawn 断掉即可，
      // 本测试只验证锁获取不挡正常启动路径。
      spawnChild: (() => {
        const child = new EventEmitter() as ChildProcess & { pid: number };
        child.pid = 424242;
        setTimeout(() => (child as unknown as EventEmitter).emit("exit", 1), 5);
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawn,
    });
    await program.parseAsync(["node", "agentsbb", "run"]).catch(() => {});
    // 启动路径走到了 runSupervisor（锁没拦），无论后续怎么失败都行。
    expect(lockReleased).toBe(false); // 失败路径由 runSupervisor 的清理负责释放；这里只验证没被锁拒绝
    const text = lines.join("");
    expect(text).not.toContain("singleton lock held");
  });
});

describe("allowDuplicateSupervisor", () => {
  it("is off unless the operator asks for it", () => {
    expect(allowDuplicateSupervisor({})).toBe(false);
    for (const v of ["0", "false", "no", "", "  ", "maybe"]) {
      expect(allowDuplicateSupervisor({ CLAWMESSENGER_ALLOW_DUPLICATE_SUPERVISOR: v })).toBe(false);
    }
  });

  it("accepts the documented truthy spellings, whitespace and case included", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(allowDuplicateSupervisor({ CLAWMESSENGER_ALLOW_DUPLICATE_SUPERVISOR: v })).toBe(true);
    }
  });
});

describe("agentsbb agent", () => {
  const credsKeystore = () => {
    const keystore = tempKeystore();
    keystore.save({
      nodeId: "node_machine",
      token: "t",
      credentialId: "dc",
      deviceSecret: "sec",
      serverUrl: "http://unused.local",
    });
    return keystore;
  };

  function setScope(value: string | undefined): () => void {
    const previousScope = process.env[OPS_SCOPE_ENV];
    const previousCreds = process.env.AGENTSBB_AGENT_CREDS;
    if (value === undefined) delete process.env[OPS_SCOPE_ENV];
    else process.env[OPS_SCOPE_ENV] = value;
    delete process.env.AGENTSBB_AGENT_CREDS;
    return () => {
      if (previousScope === undefined) delete process.env[OPS_SCOPE_ENV];
      else process.env[OPS_SCOPE_ENV] = previousScope;
      if (previousCreds === undefined) delete process.env.AGENTSBB_AGENT_CREDS;
      else process.env.AGENTSBB_AGENT_CREDS = previousCreds;
    };
  }

  it("defaults to the scoped agent and forwards the action", async () => {
    const restore = setScope("opencode_330076275");
    try {
      const lines: string[] = [];
      const setDeviceControl = vi.fn(async () => ({
        agent: "opencode",
        nodeId: "node_open",
        desiredState: "running" as const,
        version: 2,
        restart: true,
      }));
      const program = buildProgram({
        keystore: credsKeystore(),
        apiFactory: () => ({ setDeviceControl } as unknown as XiachatApi),
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "agent", "restart"]);

      expect(setDeviceControl).toHaveBeenCalledWith("node_machine", "dc", "sec", "opencode", "restart");
      expect(lines.join("")).toContain("重启指令已下发");
    } finally {
      restore();
    }
  });

  it("refuses another account's agent without calling the server", async () => {
    const restore = setScope("opencode_330076275");
    const previousExitCode = process.exitCode;
    try {
      const lines: string[] = [];
      const setDeviceControl = vi.fn();
      const program = buildProgram({
        keystore: credsKeystore(),
        apiFactory: () => ({ setDeviceControl } as unknown as XiachatApi),
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "agent", "stop", "hermes"]);

      expect(setDeviceControl).not.toHaveBeenCalled();
      expect(lines.join("")).toContain("只负责 opencode");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      restore();
    }
  });

  // 现场回归（2026-10-20 12:43）：这台设备的节点是旧方案
  // rc_node_<key>_<agent>，按名字切尾巴曾切出 rc_node_<key>，拿它当 target
  // 去启停 → 服务端 404「本机没有这个智能体」。
  it("defaults to the scoped agent under the legacy rc_node_<key>_<agent> id", async () => {
    const restore = setScope("rc_node_3300776275_hermes");
    try {
      const lines: string[] = [];
      const setDeviceControl = vi.fn(async () => ({
        agent: "hermes",
        nodeId: "node_hermes",
        desiredState: "stopped" as const,
        version: 3,
        restart: false,
      }));
      const program = buildProgram({
        keystore: credsKeystore(),
        apiFactory: () => ({ setDeviceControl } as unknown as XiachatApi),
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "agent", "stop"]);

      expect(setDeviceControl).toHaveBeenCalledWith("node_machine", "dc", "sec", "hermes", "stop");
      expect(lines.join("")).toContain("停止指令已下发");
    } finally {
      restore();
    }
  });

  it("reports a missing agent when the server 404s with a message", async () => {
    const restore = setScope("rc_node_3300776275_hermes");
    const previousExitCode = process.exitCode;
    try {
      const lines: string[] = [];
      const setDeviceControl = vi.fn(async () => {
        throw new Error("POST /api/claw/device/control/set: HTTP 404: 本机没有这个智能体");
      });
      const program = buildProgram({
        keystore: credsKeystore(),
        apiFactory: () => ({ setDeviceControl } as unknown as XiachatApi),
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "agent", "stop"]);

      const out = lines.join("");
      expect(out).toContain("没有找到智能体");
      // 接口是有的，别再把「名字不对」说成「服务端没上线」。
      expect(out).not.toContain("未上线");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      restore();
    }
  });

  it("still reports the endpoint as missing for a bare 404 (old server)", async () => {
    const restore = setScope(undefined);
    const previousExitCode = process.exitCode;
    try {
      const lines: string[] = [];
      const setDeviceControl = vi.fn(async () => {
        throw new Error("POST /api/claw/device/control/set: HTTP 404");
      });
      const program = buildProgram({
        keystore: credsKeystore(),
        apiFactory: () => ({ setDeviceControl } as unknown as XiachatApi),
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "agent", "stop", "opencode"]);

      expect(lines.join("")).toContain("未上线");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      restore();
    }
  });
});

describe("ops scope guard", () => {
  it("leaves whole-machine actions alone outside an ops scope", () => {
    expect(wholeMachineActionRejection("stop", {})).toBeNull();
    expect(wholeMachineActionRejection("restart", {})).toBeNull();
  });

  it("refuses to stop or restart the whole machine from a per-agent ops child", () => {
    const env = { [OPS_SCOPE_ENV]: "opencode_330076275" };
    const stop = wholeMachineActionRejection("stop", env) ?? "";
    expect(stop).toContain("只负责本账号");
    expect(stop).toContain("agentsbb start");
    expect(wholeMachineActionRejection("restart", env) ?? "").toContain("--all-agents");
  });

  it("hides other agents from status inside an ops scope", () => {
    const report = {
      agents: ["opencode", "hermes", "openclaw", "ops@opencode_330076275", "ops@hermes_111"],
    };
    expect(scopeDaemonReport(report, "opencode_330076275").agents)
      .toEqual(["opencode", "ops@opencode_330076275"]);
    expect(scopeDaemonReport(report, "").agents).toEqual(report.agents);
  });

  it("blocks `agentsbb stop` before it reaches the daemon", async () => {
    const previous = process.env[OPS_SCOPE_ENV];
    const previousExitCode = process.exitCode;
    process.env[OPS_SCOPE_ENV] = "opencode_330076275";
    try {
      const lines: string[] = [];
      const stopDaemon = vi.fn(async () => {});
      const program = buildProgram({
        keystore: tempKeystore(),
        apiFactory: () => ({}) as unknown as XiachatApi,
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemon: { stop: stopDaemon } as unknown as Daemon,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "stop"]);

      expect(stopDaemon).not.toHaveBeenCalled();
      expect(lines.join("")).toContain("只负责本账号");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      if (previous === undefined) delete process.env[OPS_SCOPE_ENV];
      else process.env[OPS_SCOPE_ENV] = previous;
    }
  });
});

// 2026-10-20 11:33 的现场：运维助手在会话里执行 `agentsbb stop`，把拉起它的
// supervisor 连同自己一起杀掉 —— 失败/取消终帧没机会发，前端气泡永远停在
// 「正在思考 3m42s」，整台设备的智能体也全部下线。
// 这条守卫与 ops 作用域无关：**任何**由 supervisor 拉起的子进程都不许停整机。
describe("supervised self-kill guard", () => {
  it("leaves the commands alone outside a supervised child", () => {
    expect(supervisedSelfKillRejection("stop", {})).toBeNull();
    expect(supervisedSelfKillRejection("restart", {})).toBeNull();
  });

  it("refuses whole-machine stop/restart inside a supervised child", () => {
    const env = { [SUPERVISED_ENV]: "1" };
    const stop = supervisedSelfKillRejection("stop", env) ?? "";
    expect(stop).toContain("supervisor");
    expect(stop).toContain("agentsbb agent stop|start");
    expect(supervisedSelfKillRejection("restart", env) ?? "").toContain("supervisor");
  });

  it("blocks `agentsbb stop` before it reaches the daemon", async () => {
    const previous = process.env[SUPERVISED_ENV];
    const previousExitCode = process.exitCode;
    process.env[SUPERVISED_ENV] = "1";
    try {
      const lines: string[] = [];
      const stopDaemon = vi.fn(async () => {});
      const program = buildProgram({
        keystore: tempKeystore(),
        apiFactory: () => ({}) as unknown as XiachatApi,
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemon: { stop: stopDaemon } as unknown as Daemon,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "stop"]);

      expect(stopDaemon).not.toHaveBeenCalled();
      expect(lines.join("")).toContain("supervisor");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      if (previous === undefined) delete process.env[SUPERVISED_ENV];
      else process.env[SUPERVISED_ENV] = previous;
    }
  });

  it("blocks whole-machine restart even with --all-agents", async () => {
    const previous = process.env[SUPERVISED_ENV];
    const previousExitCode = process.exitCode;
    process.env[SUPERVISED_ENV] = "1";
    try {
      const lines: string[] = [];
      const restartDaemon = vi.fn(async () => {});
      const program = buildProgram({
        keystore: tempKeystore(),
        apiFactory: () => ({}) as unknown as XiachatApi,
        stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
        daemon: { restart: restartDaemon } as unknown as Daemon,
        daemonPaths: defaultDaemonPaths(),
      });

      await program.parseAsync(["node", "agentsbb", "restart", "--all-agents"]);

      expect(restartDaemon).not.toHaveBeenCalled();
      expect(lines.join("")).toContain("supervisor");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      if (previous === undefined) delete process.env[SUPERVISED_ENV];
      else process.env[SUPERVISED_ENV] = previous;
    }
  });
});

describe("agentsbb pair — browser authorization (no ticket)", () => {
  const deviceSession = {
    ticket: "pt_device",
    userCode: "ABCD2345",
    verifyUrl: "https://agentsbb.quukk.com/pair?code=ABCD2345",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    intervalSeconds: 2,
  };

  it("prints the verify URL, then pairs and starts the supervisor once bound", async () => {
    const keystore = tempKeystore();
    const lines: string[] = [];
    const { daemon, calls: daemonCalls } = fakeDaemon();
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      startDevicePairing: async () => deviceSession,
      register: async () => ({ nodeId: "node_machine", token: "tok_1", deviceCredentialTicket: "dc_t" }),
      claimPairing: async () => ({ deviceCredentialId: "dc_9", deviceSecret: "secret_9", nodeId: "node_machine" }),
      pollDevicePairing: async () => ({
        status: "claimed",
        expiresAt: deviceSession.expiresAt,
        boundAgents: [{ agent: "opencode", nodeId: "node_oc" }],
      }),
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
      machineId: () => "machine-dev",
      ensureOpencode: async () => ({}),
      daemon,
      daemonPaths: defaultDaemonPaths(join(tmpdir(), `cm-pair-${process.pid}`)),
      sleep: async () => {},
      devicePollMs: 1,
    });

    await program.parseAsync(["node", "agentsbb", "pair"]);

    const output = lines.join("");
    expect(output).toContain(deviceSession.verifyUrl);
    expect(output).toContain("ABCD2345");
    // The ticket is the device's own secret and must never be shown.
    expect(output).not.toContain("pt_device");
    expect(output).toContain("授权完成");
    expect(keystore.load()?.deviceSecret).toBe("secret_9");
    expect(daemonCalls.some((c) => c.startsWith("start:"))).toBe(true);
  });

  it("keeps polling while the device is claimed but not yet authorized", async () => {
    const keystore = tempKeystore();
    let polls = 0;
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      startDevicePairing: async () => deviceSession,
      register: async () => ({ nodeId: "node_machine", token: "tok_1", deviceCredentialTicket: "dc_t" }),
      claimPairing: async () => ({ deviceCredentialId: "dc_9", deviceSecret: "secret_9", nodeId: "node_machine" }),
      pollDevicePairing: async () => {
        polls += 1;
        if (polls < 3) return { status: "claimed", expiresAt: deviceSession.expiresAt, boundAgents: [] };
        return { status: "claimed", expiresAt: deviceSession.expiresAt, boundAgents: [{ agent: "hermes", nodeId: "node_h" }] };
      },
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "machine-dev",
      ensureOpencode: async () => ({}),
      daemon: fakeDaemon().daemon,
      daemonPaths: defaultDaemonPaths(join(tmpdir(), `cm-pair-${process.pid}`)),
      sleep: async () => {},
      devicePollMs: 1,
    });

    await program.parseAsync(["node", "agentsbb", "pair", "--no-start"]);
    expect(polls).toBe(3);
  });

  it("fails with a re-run hint when the session expired before authorization", async () => {
    const keystore = tempKeystore();
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      startDevicePairing: async () => deviceSession,
      register: async () => ({ nodeId: "node_machine", token: "tok_1", deviceCredentialTicket: "dc_t" }),
      claimPairing: async () => ({ deviceCredentialId: "dc_9", deviceSecret: "secret_9", nodeId: "node_machine" }),
      pollDevicePairing: async () => ({ status: "expired", expiresAt: deviceSession.expiresAt, boundAgents: [] }),
      refreshToken: async () => ({ token: "" }),
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "machine-dev",
      ensureOpencode: async () => ({}),
      daemon: fakeDaemon().daemon,
      daemonPaths: defaultDaemonPaths(join(tmpdir(), `cm-pair-${process.pid}`)),
      sleep: async () => {},
      devicePollMs: 1,
    });

    await expect(program.parseAsync(["node", "agentsbb", "pair"])).rejects.toThrow(/过期/);
  });

  it("never calls the device-code API when a manual ticket is supplied", async () => {
    const keystore = tempKeystore();
    const fakeApi = {
      getConfig: async () => ({ appKey: "pk" }),
      register: async () => ({ nodeId: "node_1", token: "tok_1" }),
      claimPairing: async () => ({ deviceCredentialId: "dc_1", deviceSecret: "s", nodeId: "node_1" }),
      refreshToken: async () => ({ token: "" }),
      // startDevicePairing intentionally absent: calling it throws TypeError.
    };
    const program = buildProgram({
      keystore,
      apiFactory: () => fakeApi as unknown as XiachatApi,
      stdout: process.stdout,
      machineId: () => "machine-dev",
      ensureOpencode: async () => ({}),
      daemon: fakeDaemon().daemon,
      daemonPaths: defaultDaemonPaths(join(tmpdir(), `cm-pair-${process.pid}`)),
    });

    await program.parseAsync(["node", "agentsbb", "pair", "--ticket", "pt_manual"]);
    expect(keystore.load()?.nodeId).toBe("node_1");
  });
});

// ---------------------------------------------------------------- update

/**
 * `update` 一条命令干完「下载 → 校验 → 换上去 → 重启」。
 *
 * 这里的桩只做两件事：给一份「GitHub 长这样」的 Release，和一个记名字的假
 * daemon。真正要钉死的是**顺序与边界**：
 *   · 换上去之后必须 restart，否则用户看到的还是旧版本在干活（旧 `update` 就
 *     停在这一步，要求人工再敲 `restart`）；
 *   · `--no-restart` / 智能体进程里只交换不重启；
 *   · 模型与工作目录要跟着重启带过去，否则设备会静默回落默认模型。
 */
describe("agentsbb update", () => {
  const ASSET = "agentsbb-linux-x64";

  /** Buffer → 独立的 ArrayBuffer（`buf.buffer` 会带出 SharedArrayBuffer 的联合类型）。 */
  const toArrayBuffer = (b: Buffer): ArrayBuffer => {
    const ab = new ArrayBuffer(b.length);
    new Uint8Array(ab).set(b);
    return ab;
  };

  function releaseFetch(payload: Buffer, version = "1.3.23", opts: { failLookup?: boolean } = {}) {
    const sha = createHash("sha256").update(payload).digest("hex");
    const sums = `${sha}  ${ASSET}\n`;
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (opts.failLookup) throw new Error("getaddrinfo ENOTFOUND api.github.com");
      if (url.endsWith("/releases/latest")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: `agentsbb-v${version}`,
            assets: [
              { name: ASSET, browser_download_url: `https://cdn.test/${ASSET}`, size: payload.length },
              { name: "SHA256SUMS", browser_download_url: "https://cdn.test/SHA256SUMS", size: sums.length },
            ],
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (url.endsWith("SHA256SUMS")) {
        const bytes = Buffer.from(sums);
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => toArrayBuffer(bytes),
          text: async () => sums,
        };
      }
      if (url.endsWith(ASSET)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => toArrayBuffer(payload),
        };
      }
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    return { fetchImpl, urls, sha, sums };
  }

  /** 临时安装目录：target 是一份「旧 exe」，旁边放状态/pid 文件。 */
  function installFixture(opts: { running: boolean; model?: string; cwd?: string }) {
    const root = mkdtempSync(join(tmpdir(), "agentsbb-update-"));
    dirs.push(root);
    const target = join(root, "agentsbb");
    writeFileSync(target, "OLD-EXE-BYTES");
    const paths = defaultDaemonPaths(join(root, "state"));
    mkdirSync(paths.stateDir, { recursive: true });
    if (opts.running) {
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeFileSync(
        paths.stateFile,
        JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          execPath: target,
          cwd: opts.cwd ?? root,
          ...(opts.model ? { model: opts.model } : {}),
          agents: ["claude"],
        }),
      );
    }
    return { root, target, paths };
  }

  function programFor(args: {
    target: string;
    paths: DaemonPaths;
    fetchImpl: FetchLike;
    daemon: Daemon;
    keystore?: Keystore;
    apiFactory?: (serverUrl: string) => XiachatApi;
    lines: string[];
  }) {
    return buildProgram({
      keystore: args.keystore ?? tempKeystore(),
      apiFactory: args.apiFactory ?? (() => { throw new Error("api should not be called"); }),
      stdout: { write: (s: string) => { args.lines.push(s); return true; } } as unknown as NodeJS.WriteStream,
      daemon: args.daemon,
      daemonPaths: args.paths,
      upgradeTarget: args.target,
      updateFetch: args.fetchImpl,
      platform: "linux",
      arch: "x64",
      version: "1.3.22",
    });
  }

  it("applies the new build and restarts the supervisor into it", async () => {
    const payload = Buffer.from("NEW-EXE-BYTES-1.3.23");
    const { fetchImpl } = releaseFetch(payload);
    const { target, paths } = installFixture({ running: true, model: "claude-opus", cwd: "/work/dir" });
    const fake = fakeDaemon();
    const lines: string[] = [];

    const program = programFor({ target, paths, fetchImpl, daemon: fake.daemon, lines });
    await program.parseAsync(["node", "agentsbb", "update"]);

    const out = lines.join("");
    expect(out).toContain("current: 1.3.22");
    expect(out).toContain("latest:  1.3.23");
    expect(out).toContain(`applied 1.3.23 to ${target}`);
    // 关键：重启必须发生，且模型 / 工作目录要原样带过去。
    expect(fake.calls).toContainEqual(`restart:${JSON.stringify({ model: "claude-opus", workdir: "/work/dir" })}`);
    expect(out).toContain("updated to 1.3.23 and restarted");
    // 磁盘上真的是新 exe，旧的那份被改名留作回滚。
    expect(readFileSync(target, "utf8")).toBe(payload.toString());
    const backups = readdirSync(dirname(target)).filter((f) => f.startsWith("agentsbb.old-"));
    expect(backups.length).toBe(1);
  });

  it("--no-restart only stages and leaves the running build alone", async () => {
    const payload = Buffer.from("NEW-EXE-BYTES-1.3.23");
    const { fetchImpl } = releaseFetch(payload);
    const { target, paths } = installFixture({ running: true });
    const fake = fakeDaemon();
    const lines: string[] = [];

    const program = programFor({ target, paths, fetchImpl, daemon: fake.daemon, lines });
    await program.parseAsync(["node", "agentsbb", "update", "--no-restart"]);

    expect(fake.calls.filter((c) => c.startsWith("restart"))).toHaveLength(0);
    expect(readFileSync(target, "utf8")).toBe("OLD-EXE-BYTES");
    expect(existsSync(`${target}.new-1.3.23`)).toBe(true);
    expect(lines.join("")).toContain("run `agentsbb restart`");
  });

  it("says already up to date and touches nothing", async () => {
    const { fetchImpl } = releaseFetch(Buffer.from("same"), "1.3.22");
    const { target, paths } = installFixture({ running: true });
    const fake = fakeDaemon();
    const lines: string[] = [];

    const program = programFor({ target, paths, fetchImpl, daemon: fake.daemon, lines });
    await program.parseAsync(["node", "agentsbb", "update"]);

    expect(lines.join("")).toContain("already up to date");
    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(target, "utf8")).toBe("OLD-EXE-BYTES");
  });

  it("installs but does not restart when no supervisor is running", async () => {
    const payload = Buffer.from("NEW-EXE-BYTES-1.3.23");
    const { fetchImpl } = releaseFetch(payload);
    const { target, paths } = installFixture({ running: false });
    const fake = fakeDaemon();
    const lines: string[] = [];

    const program = programFor({ target, paths, fetchImpl, daemon: fake.daemon, lines });
    await program.parseAsync(["node", "agentsbb", "update"]);

    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(target, "utf8")).toBe(payload.toString());
    expect(lines.join("")).toContain("no supervisor is running");
  });

  it("in a supervised agent process it swaps the exe but never restarts", async () => {
    const payload = Buffer.from("NEW-EXE-BYTES-1.3.23");
    const { fetchImpl } = releaseFetch(payload);
    const { target, paths } = installFixture({ running: true });
    const fake = fakeDaemon();
    const lines: string[] = [];
    vi.stubEnv(SUPERVISED_ENV, "1");
    try {
      const program = programFor({ target, paths, fetchImpl, daemon: fake.daemon, lines });
      await program.parseAsync(["node", "agentsbb", "update"]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(target, "utf8")).toBe(payload.toString());
    expect(lines.join("")).toContain("不重启 supervisor");
  });

  it("falls back to the server's upgrade intent when the release channel is unreachable", async () => {
    const payload = Buffer.from("NEW-EXE-BYTES-FROM-MIRROR");
    const sha = createHash("sha256").update(payload).digest("hex");
    const { fetchImpl, sums } = releaseFetch(payload, "1.3.23", { failLookup: true });
    // 只让镜像地址可用：Release 通道整体不可达。
    const mirrorFetch: FetchLike = async (url, init) => {
      if (url.endsWith("/api/agent/upgrade/download") || url.includes("mirror.test")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => toArrayBuffer(payload),
        };
      }
      return fetchImpl(url, init);
    };
    const keystore = tempKeystore();
    keystore.save({ nodeId: "node_1", token: "t", serverUrl: "http://srv", credentialId: "dc_1", deviceSecret: "sec" });
    const apiFactory = () => ({
      fetchDeviceControl: async () => ({
        agents: [],
        upgrade: {
          generation: 3,
          targetVersion: "1.3.23",
          assetName: ASSET,
          sha256: sha,
          force: false,
          mirrors: ["https://mirror.test/1.3.23/agentsbb-linux-x64"],
        },
      }),
    }) as unknown as XiachatApi;
    const { target, paths } = installFixture({ running: true });
    const fake = fakeDaemon();
    const lines: string[] = [];

    const program = programFor({ target, paths, fetchImpl: mirrorFetch, daemon: fake.daemon, lines, keystore, apiFactory });
    await program.parseAsync(["node", "agentsbb", "update"]);

    const out = lines.join("");
    expect(out).toContain("using the server's upgrade intent: 1.3.23");
    expect(readFileSync(target, "utf8")).toBe(payload.toString());
    expect(fake.calls.filter((c) => c.startsWith("restart"))).toHaveLength(1);
    expect(sums).toContain(sha);
  });
});
