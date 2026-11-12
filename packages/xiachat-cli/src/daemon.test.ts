// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDaemon,
  decodeCommandOutput,
  defaultDaemonPaths,
  findLiveSupervisor,
  formatDaemonStatus,
  injectStartupVbsSelfHeal,
  supervisorSpawnArgv,
  STARTUP_VBS_TEMPLATE_MARKER,
  writeSupervisorState,
  type DaemonOverrides,
  type DaemonPaths,
} from "./daemon.js";

const EXE = "/opt/clawmessenger/clawmessenger";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

interface Harness {
  paths: DaemonPaths;
  home: string;
  lines: string[];
  errors: string[];
  /** pid → alive? Default: nothing is alive. */
  alive: Set<number>;
  signals: Array<{ pid: number; signal: string }>;
  spawns: Array<{ exec: string; argv: string[]; options: SpawnOptions }>;
  commands: Array<{ file: string; args: string[] }>;
  daemon: ReturnType<typeof createDaemon>;
  /** Set to make spawn() also publish the supervisor state, like the real child. */
  publishOnSpawn?: (pid: number) => void;
  spawnPid: number;
  spawnError?: Error;
}

function harness(overrides: Partial<DaemonOverrides> = {}, opts: { spawnPid?: number; publish?: boolean } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "clawmessenger-daemon-"));
  dirs.push(home);
  const paths = defaultDaemonPaths(join(home, ".clawmessenger"));
  const lines: string[] = [];
  const errors: string[] = [];
  const alive = new Set<number>();
  const signals: Array<{ pid: number; signal: string }> = [];
  const spawns: Array<{ exec: string; argv: string[]; options: SpawnOptions }> = [];
  const commands: Array<{ file: string; args: string[] }> = [];
  const spawnPid = opts.spawnPid ?? 555;

  const h: Harness = {
    paths,
    home,
    lines,
    errors,
    alive,
    signals,
    spawns,
    commands,
    spawnPid,
    daemon: undefined as unknown as ReturnType<typeof createDaemon>,
  };

  const spawnFn = ((exec: string, argv: string[], options: SpawnOptions) => {
    if (h.spawnError) throw h.spawnError;
    spawns.push({ exec, argv, options });
    h.publishOnSpawn?.(spawnPid);
    return { pid: spawnPid, unref: () => {} };
  }) as unknown as typeof spawn;

  h.daemon = createDaemon({
    platform: "linux",
    home,
    paths,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    uid: 0,
    now: () => 1_000_000,
    sleep: async () => {},
    isAlive: (pid) => alive.has(pid),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      // SIGTERM is graceful: the fake supervisor goes away on it.
      if (signal === "SIGTERM") alive.delete(pid);
    },
    spawn: spawnFn,
    spawnSync: (() => ({ status: 0, stdout: "", stderr: "", pid: 1 })) as unknown as typeof import("node:child_process").spawnSync,
    selfArgv: () => ({ exec: EXE, args: [] }),
    stdout: { write: (s: string) => { lines.push(s); return true; } },
    stderr: { write: (s: string) => { errors.push(s); return true; } },
    runCommand: (file, args) => {
      commands.push({ file, args });
      return { status: 0, stdout: "", stderr: "" };
    },
    // 自启项一律落在临时目录里，绝不去碰真实的 /etc 与用户目录。
    autostartPaths: {
      systemUnit: join(paths.stateDir, "etc", "systemd", "system", "clawmessenger.service"),
      userUnit: join(home, ".config", "systemd", "user", "clawmessenger.service"),
      launchAgent: join(home, "Library", "LaunchAgents", "com.clawmessenger.supervisor.plist"),
    },
    ...overrides,
  });
  return h;
}

const state = (paths: DaemonPaths, pid: number, agents: string[] = ["claude"]) => {
  writeSupervisorState(
    { pid, startedAt: 999_000, execPath: EXE, cwd: "/home/u", agents },
    paths,
  );
};

describe("supervisorSpawnArgv", () => {
  it("re-invokes the bare exe when there is no .js entry point (SEA)", () => {
    // argv[1] 在 SEA 单文件 exe 里要么不存在、要么就是 exe 自己，都不是 .js。
    expect(supervisorSpawnArgv("")).toEqual([]);
    expect(supervisorSpawnArgv("/usr/local/bin/clawmessenger")).toEqual([]);
    expect(supervisorSpawnArgv("C:\\Users\\u\\.local\\bin\\clawmessenger.exe")).toEqual([]);
  });

  it("keeps the bundle path when running under node", () => {
    expect(supervisorSpawnArgv("/repo/packages/xiachat-cli/dist/bin.js")).toEqual([
      "/repo/packages/xiachat-cli/dist/bin.js",
    ]);
  });
});

describe("findLiveSupervisor", () => {
  const nothingAlive = (): boolean => false;

  it("reports nothing when the state dir is empty", () => {
    const h = harness();
    expect(findLiveSupervisor(h.paths, nothingAlive)).toBeNull();
  });

  it("ignores a pid file left behind by a process that is gone", () => {
    const h = harness();
    mkdirSync(h.paths.stateDir, { recursive: true });
    writeFileSync(h.paths.pidFile, "4242\n");
    expect(findLiveSupervisor(h.paths, nothingAlive)).toBeNull();
  });

  it("reports the live pid together with the agents it published", () => {
    const h = harness();
    state(h.paths, 4242, ["opencode", "ops"]);
    const found = findLiveSupervisor(h.paths, (pid) => pid === 4242);
    expect(found?.pid).toBe(4242);
    expect(found?.state?.agents).toEqual(["opencode", "ops"]);
  });

  it("finds a supervisor that has a pid file but has not published its state yet", () => {
    const h = harness();
    mkdirSync(h.paths.stateDir, { recursive: true });
    writeFileSync(h.paths.pidFile, "777\n");
    const found = findLiveSupervisor(h.paths, (pid) => pid === 777);
    expect(found?.pid).toBe(777);
    expect(found?.state).toBeNull();
  });

  it("falls back to the state file when the pid file went missing", () => {
    const h = harness();
    state(h.paths, 888, ["hermes"]);
    rmSync(h.paths.pidFile, { force: true });
    const found = findLiveSupervisor(h.paths, (pid) => pid === 888);
    expect(found?.pid).toBe(888);
    expect(found?.state?.agents).toEqual(["hermes"]);
  });
});

describe("daemon start", () => {
  it("refuses to start a second supervisor and reports the running one", async () => {
    const h = harness();
    state(h.paths, 4242, ["claude", "codex"]);
    h.alive.add(4242);

    await h.daemon.start();

    expect(h.spawns).toHaveLength(0);
    expect(h.lines.join("")).toContain("already running: supervisor PID 4242");
    expect(h.lines.join("")).toContain("claude, codex");
  });

  it("spawns a detached supervisor, records its pid and reports where the log is", async () => {
    const h = harness({}, { spawnPid: 777 });
    h.alive.add(777);
    h.publishOnSpawn = (pid) => {
      writeSupervisorState(
        { pid, startedAt: 999_500, execPath: EXE, cwd: h.home, agents: ["claude", "codex"] },
        h.paths,
      );
    };

    await h.daemon.start({ model: "gpt-5" });

    expect(h.spawns).toHaveLength(1);
    const [spawned] = h.spawns;
    expect(spawned.exec).toBe(EXE);
    expect(spawned.argv).toEqual(["run", "--model", "gpt-5"]);
    expect(spawned.options.detached).toBe(true);
    expect(spawned.options.windowsHide).toBe(true);
    expect(spawned.options.cwd).toBe(h.home);
    expect(spawned.options.stdio?.[0]).toBe("ignore");

    // The pid file is what `stop` uses, and it must be on disk right away.
    expect(readFileSync(h.paths.pidFile, "utf8").trim()).toBe("777");
    const text = h.lines.join("");
    expect(text).toContain("started in the background: supervisor PID 777");
    expect(text).toContain(join(h.paths.logDir, "supervisor.log"));
    expect(text).toContain("claude, codex");
  });

  it("defaults the workdir to the home directory", async () => {
    const h = harness();
    h.alive.add(555);
    await h.daemon.start();
    expect(h.spawns[0].options.cwd).toBe(h.home);
  });

  it("rejects a --workdir that does not exist", async () => {
    const h = harness();
    await expect(h.daemon.start({ workdir: join(h.home, "nope") })).rejects.toThrow(/--workdir does not exist/);
    expect(h.spawns).toHaveLength(0);
  });

  it("clears the pid file and surfaces the log tail when the supervisor dies at once", async () => {
    const h = harness();
    mkdirSync(h.paths.logDir, { recursive: true });
    writeFileSync(join(h.paths.logDir, "supervisor.log"), "boom: no credentials\n");
    // Nothing is alive, so the very first liveness poll fails.

    await expect(h.daemon.start()).rejects.toThrow(/failed to stay up/);

    expect(existsSync(h.paths.pidFile)).toBe(false);
    expect(existsSync(h.paths.stateFile)).toBe(false);
    expect(h.errors.join("")).toContain("exited immediately after start (PID 555)");
    expect(h.errors.join("")).toContain("boom: no credentials");
  });

  it("starts anyway when the leftover pid file points at a process that is gone", async () => {
    const h = harness({}, { spawnPid: 777 });
    state(h.paths, 4242); // 上次崩溃留下的残骸，进程已经不在了
    h.alive.add(777); // 这次真正起来的 supervisor
    h.publishOnSpawn = (pid) => {
      writeSupervisorState({ pid, startedAt: 1_000_000, execPath: EXE, cwd: h.home, agents: ["claude"] }, h.paths);
    };

    await h.daemon.start();

    expect(h.spawns).toHaveLength(1);
    expect(readFileSync(h.paths.pidFile, "utf8").trim()).toBe("777");
  });
});

describe("daemon stop", () => {
  it("SIGTERMs the supervisor, waits, then clears the pid file", async () => {
    const h = harness();
    state(h.paths, 4242, ["claude"]);
    h.alive.add(4242);

    await h.daemon.stop();

    expect(h.signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(existsSync(h.paths.pidFile)).toBe(false);
    expect(existsSync(h.paths.stateFile)).toBe(false);
    expect(h.lines.join("")).toContain("stopping supervisor PID 4242 (and its 1 agent process(es))");
    expect(h.lines.join("")).toContain("stopped.");
  });

  it("escalates to SIGKILL when the supervisor ignores SIGTERM", async () => {
    const h = harness({
      signal: (pid, signal) => {
        h.signals.push({ pid, signal });
        // Never dies: the fake ignores every signal.
      },
    });
    state(h.paths, 4242);
    h.alive.add(4242);

    await h.daemon.stop();

    expect(h.signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.lines.join("")).toContain("escalating to SIGKILL");
    expect(h.errors.join("")).toContain("stop failed");
    expect(existsSync(h.paths.pidFile)).toBe(false);
  });

  it("reports a no-op and clears a stale pid file when nothing is running", async () => {
    const h = harness();
    state(h.paths, 4242); // written, but the process is gone

    await h.daemon.stop();

    expect(h.signals).toHaveLength(0);
    expect(h.lines.join("")).toContain("cleared a stale pid/state file");
    expect(existsSync(h.paths.pidFile)).toBe(false);
  });

  it("reports a plain no-op when there is not even a stale file", async () => {
    const h = harness();
    await h.daemon.stop();
    expect(h.lines.join("")).toContain("no clawmessenger supervisor is running.");
    expect(h.lines.join("")).not.toContain("stale");
  });

  it("kills the whole process tree on Windows", async () => {
    const killed: Array<{ file: string; args: string[] }> = [];
    const h = harness({
      platform: "win32",
      spawnSync: ((file: string, args: string[]) => {
        killed.push({ file, args });
        return { status: 0, stdout: "", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
    });
    state(h.paths, 4242);
    h.alive.add(4242);

    await h.daemon.stop();

    expect(killed).toEqual([{ file: "taskkill", args: ["/PID", "4242", "/T", "/F"] }]);
    expect(h.signals).toHaveLength(0);
    expect(existsSync(h.paths.pidFile)).toBe(false);
  });
});

describe("daemon restart", () => {
  it("stops then starts", async () => {
    const h = harness({}, { spawnPid: 888 });
    state(h.paths, 4242);
    h.alive.add(4242);
    h.alive.add(888);
    h.publishOnSpawn = (pid) => {
      writeSupervisorState({ pid, startedAt: 1_000_000, execPath: EXE, cwd: h.home, agents: ["claude"] }, h.paths);
    };

    await h.daemon.restart();

    expect(h.signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(h.spawns).toHaveLength(1);
    expect(readFileSync(h.paths.pidFile, "utf8").trim()).toBe("888");
  });
});

describe("daemon status", () => {
  it("reports not-running when there is nothing on disk", () => {
    const h = harness();
    const report = h.daemon.status();
    expect(report.running).toBe(false);
    expect(report.stale).toBe(false);
    const text = formatDaemonStatus(report, h.paths);
    expect(text).toContain("not running in the background");
    expect(text).toContain("clawmessenger start");
  });

  it("flags a leftover pid file as stale", () => {
    const h = harness();
    state(h.paths, 4242);
    const report = h.daemon.status();
    expect(report.running).toBe(false);
    expect(report.stale).toBe(true);
    expect(formatDaemonStatus(report, h.paths)).toContain("stale pid/state file");
  });

  it("reports the supervisor, its uptime and its agents", () => {
    const h = harness();
    state(h.paths, 4242, ["claude", "opencode"]);
    h.alive.add(4242);

    const report = h.daemon.status();

    expect(report.running).toBe(true);
    expect(report.pid).toBe(4242);
    expect(report.uptimeMs).toBe(1_000); // now() - startedAt
    expect(report.agents).toEqual(["claude", "opencode"]);
    expect(report.cwd).toBe("/home/u");
    const text = formatDaemonStatus(report, h.paths);
    expect(text).toContain("running in the background (PID 4242, up 1s)");
    expect(text).toContain("2 (claude, opencode)");
  });

  it("still reports running when the supervisor has not published its state yet", () => {
    const h = harness();
    mkdirSync(h.paths.stateDir, { recursive: true });
    writeFileSync(h.paths.pidFile, "4242\n");
    h.alive.add(4242);
    const report = h.daemon.status();
    expect(report.running).toBe(true);
    expect(report.agents).toEqual([]);
    expect(formatDaemonStatus(report, h.paths)).toContain("supervisor has not reported yet");
  });

  // 回归：2026-10-26 照 status 的「not running」跑 stop，杀掉了一个在线 17 小时的节点。
  // 成因是 status 走 `readPidFile() ?? state?.pid`（只认第一个候选），而 stop 走
  // findLiveSupervisor（两个候选都试）。pid 文件残留死 pid、状态文件里才是活进程时，
  // 两个命令对同一条事实给出相反答案：一个说没在跑，一个真杀掉。
  it("agrees with stop when the pid file and the state file disagree", async () => {
    const h = harness();
    state(h.paths, 888, ["opencode"]); // 状态文件：真正活着的 supervisor
    writeFileSync(h.paths.pidFile, "4242\n"); // pid 文件：上一次留下的死 pid
    h.alive.add(888);

    const report = h.daemon.status();
    expect(report.running).toBe(true);
    expect(report.pid).toBe(888);
    expect(report.agents).toEqual(["opencode"]);
    expect(report.note).toContain("pid file says 4242");
    expect(formatDaemonStatus(report, h.paths)).toContain("note   : pid file says 4242");

    // 同一个场景下 stop 会杀的就是 status 刚报的那个 pid —— 这是本条断言的意义。
    await h.daemon.stop();
    expect(h.signals).toEqual([{ pid: 888, signal: "SIGTERM" }]);
  });

  it("prefers the pid file when that is the live one (state file is the stale side)", () => {
    const h = harness();
    state(h.paths, 4242, ["stale-agent"]);
    // 反过来的分叉：pid 文件里是活的，状态文件还停在上一次启动的 pid 上。
    mkdirSync(h.paths.stateDir, { recursive: true });
    writeFileSync(h.paths.stateFile, `${JSON.stringify({ pid: 999, startedAt: 1, agents: ["ghost"] })}\n`);
    writeFileSync(h.paths.pidFile, "4242\n");
    h.alive.add(4242);

    const report = h.daemon.status();
    expect(report.running).toBe(true);
    expect(report.pid).toBe(4242);
    // 详情只跟随与 pid 匹配的那份状态文件，不会把别的进程的 agent 列表串上来。
    expect(report.agents).toEqual([]);
    expect(report.note).toContain("pid file says 4242, state file says 999");
  });

  it("surfaces the configured autostart entry", () => {
    const h = harness();
    mkdirSync(join(h.home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(h.home, ".config", "systemd", "user", "clawmessenger.service"), "[Unit]\n");
    expect(h.daemon.status().autostart).toContain("systemd user service");
  });
});

describe("daemon logs", () => {
  it("prints the tail of the newest log file", async () => {
    const h = harness();
    mkdirSync(h.paths.logDir, { recursive: true });
    writeFileSync(join(h.paths.logDir, "supervisor.log"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(h.paths.logDir, "supervisor.log.1"), "old\n");

    h.daemon.logs({ lines: 2 });

    const text = h.lines.join("");
    expect(text).toContain("supervisor.log\n");
    expect(text).toContain("three\nfour\n");
    expect(text).not.toContain("old");
  });

  it("says so when no log exists yet", () => {
    const h = harness();
    h.daemon.logs();
    expect(h.lines.join("")).toContain("no supervisor log yet");
  });

  it("picks the newest file when the legacy script wrote timestamped names", () => {
    const h = harness();
    mkdirSync(h.paths.logDir, { recursive: true });
    writeFileSync(join(h.paths.logDir, "supervisor-20260101-000000.out.log"), "legacy\n");
    h.daemon.logs({ lines: 5 });
    expect(h.lines.join("")).toContain("legacy");
  });
});

describe("daemon install-service (Linux)", () => {
  it("writes a system-level unit for root and enables it", async () => {
    const h = harness({ uid: 0 });
    await h.daemon.installService({ model: "gpt-5" });

    const unitPath = join(h.paths.stateDir, "etc", "systemd", "system", "clawmessenger.service");
    expect(existsSync(unitPath)).toBe(true);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain(`ExecStart=${EXE} run --model gpt-5`);
    expect(unit).toContain(`WorkingDirectory=${h.home}`);
    expect(unit).toContain("Restart=always");
    expect(h.commands.some((c) => c.file === "systemctl" && c.args.join(" ") === "daemon-reload")).toBe(true);
    expect(h.commands.some((c) => c.file === "systemctl" && c.args.join(" ") === "enable clawmessenger")).toBe(true);
    expect(h.commands.some((c) => c.file === "systemctl" && c.args.join(" ") === "start clawmessenger")).toBe(true);
    expect(h.lines.join("")).toContain("systemctl {start|stop|restart|status} clawmessenger");
    expect(h.lines.join("")).toContain("journalctl -u clawmessenger -f");
  });

  it("writes a --user unit for a non-root user and tries to enable linger", async () => {
    const h = harness({ uid: 1001 });
    await h.daemon.installService();

    const unitPath = join(h.home, ".config", "systemd", "user", "clawmessenger.service");
    expect(existsSync(unitPath)).toBe(true);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(`ExecStart=${EXE} run`);
    expect(unit).toContain(`WorkingDirectory=${h.home}`);
    expect(unit).toContain("Environment=PATH=/usr/bin:/bin");
    // 回归护栏：systemd 的 WorkingDirectory= 不去引号，带引号的值会被判成「非绝对路径」，
    // 整个 unit 变成 bad unit file setting（0.2.15 线上就是这么炸的）。
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).not.toContain('ExecStart="');
    expect(unit).not.toContain('Environment="');
    expect(h.commands.some((c) => c.file === "systemctl" && c.args[0] === "--user")).toBe(true);
    expect(h.commands.some((c) => c.file === "loginctl" && c.args[0] === "enable-linger")).toBe(true);
  });

  it("quotes an env value only when it really contains whitespace", async () => {
    const h = harness({ uid: 0, home: "/opt/my home", env: { PATH: "/opt/my agents/bin:/usr/bin" } });
    // 显式给 workdir：否则默认值会取带空格的 home，而它并不存在。
    await h.daemon.installService({ workdir: h.home });

    const unitPath = join(h.paths.stateDir, "etc", "systemd", "system", "clawmessenger.service");
    const unit = readFileSync(unitPath, "utf8");
    // 有空白必须加引号，否则 systemd 会按空白拆成多个赋值，PATH 直接丢。
    expect(unit).toContain('Environment="HOME=/opt/my home"');
    expect(unit).toContain('Environment="PATH=/opt/my agents/bin:/usr/bin"');
    // WorkingDirectory= 永远不加引号（systemd 不去引号，加了就是致命错误）。
    expect(unit).not.toContain('WorkingDirectory="');
  });

  it("aborts before touching the running supervisor when systemd-analyze rejects the unit", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const h = harness(
      {
        uid: 0,
        runCommand: (file, args) => {
          calls.push({ file, args });
          if (file === "systemd-analyze") {
            return {
              status: 1,
              stdout: "",
              stderr: 'clawmessenger.service: Working directory is not absolute, ignoring: "/root"',
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      { spawnPid: 808 },
    );
    state(h.paths, 4242, ["claude", "codex"]);
    h.alive.add(4242);

    await h.daemon.installService();

    // 手工 supervisor 一根汗毛都没动：没有信号、没有新进程，pid 文件照旧。
    expect(h.signals).toEqual([]);
    expect(h.spawns).toHaveLength(0);
    expect(readFileSync(h.paths.pidFile, "utf8").trim()).toBe("4242");
    // 也没 enable / start —— 否则每次开机都会再撞一次同样的失败。
    expect(calls.some((c) => c.file === "systemctl" && c.args.join(" ") === "enable clawmessenger")).toBe(false);
    expect(calls.some((c) => c.file === "systemctl" && c.args.join(" ") === "start clawmessenger")).toBe(false);
    // systemd 的原话 + unit 正文都要带出来。
    const errs = h.errors.join("");
    expect(errs).toContain("Working directory is not absolute");
    expect(errs).toContain("unit file ");
    expect(errs).toContain("the device stays online");
  });

  it("does not treat a missing systemd-analyze as a broken unit", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const h = harness(
      {
        uid: 0,
        runCommand: (file, args) => {
          calls.push({ file, args });
          // spawnSync 跑不起来时 status 是 null（宿主机没装 systemd-analyze）。
          if (file === "systemd-analyze") return { status: null, stdout: "", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      { spawnPid: 808 },
    );

    await h.daemon.installService();

    // 真的走下去了：enable + start 都发了，也没有把「校验不通过」当成结论。
    expect(calls.some((c) => c.file === "systemctl" && c.args.join(" ") === "start clawmessenger")).toBe(true);
    expect(h.errors.join("")).not.toContain("rejected the unit");
  });

  it("keeps the device online when systemd refuses the unit", async () => {
    const h = harness(
      {
        uid: 0,
        runCommand: (file, args) => {
          if (file === "systemctl" && args.join(" ") === "start clawmessenger") {
            return {
              status: 1,
              stdout: "",
              stderr: "Failed to start clawmessenger.service: Unit clawmessenger.service has a bad unit file setting.",
            };
          }
          if (file === "journalctl") {
            return {
              status: 0,
              stdout: 'clawmessenger.service: Invalid syntax in ExecStart=, ignoring: "/opt/x" run',
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      { spawnPid: 808 },
    );
    state(h.paths, 4242, ["claude", "codex"]);
    h.alive.add(4242);
    h.alive.add(808);

    await h.daemon.installService();

    // 手工起的 supervisor 确实被收掉了……
    expect(h.signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    // ……但服务起不来也不能让设备就这么下线：自动把后台 supervisor 拉回来。
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].argv).toEqual(["run"]);
    expect(readFileSync(h.paths.pidFile, "utf8").trim()).toBe("808");
    expect(h.lines.join("")).toContain("restoring the background supervisor");
    expect(h.lines.join("")).toContain("supervisor PID 808");
    // systemd 的原话、unit 正文都要带出来，省得用户自己去翻 journal。
    const errs = h.errors.join("");
    expect(errs).toContain("Unit clawmessenger.service has a bad unit file setting");
    expect(errs).toContain("Invalid syntax in ExecStart=");
    expect(errs).toContain("unit file ");
    expect(errs).toContain("WantedBy=multi-user.target");
    // 失败后不再打「怎么管理服务」那一套，避免误导。
    expect(h.lines.join("")).not.toContain("the PATH baked into the unit");
  });
});

describe("daemon install-service (macOS / Windows)", () => {
  it("writes a LaunchAgent plist on macOS", async () => {
    const h = harness({ platform: "darwin" });
    await h.daemon.installService();

    const plistPath = join(h.home, "Library", "LaunchAgents", "com.clawmessenger.supervisor.plist");
    expect(existsSync(plistPath)).toBe(true);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain(`<string>${EXE}</string>`);
    expect(plist).toContain("<string>run</string>");
    expect(h.commands.some((c) => c.file === "launchctl" && c.args[0] === "load")).toBe(true);
  });

  it("restores the supervisor when launchctl refuses to load the plist", async () => {
    const h = harness(
      {
        platform: "darwin",
        runCommand: (file, args) => {
          if (file === "launchctl" && args[0] === "load") {
            return { status: 1, stdout: "", stderr: "Load failed: 5: Input/output error" };
          }
          if (file === "launchctl" && args[0] === "list") {
            return { status: 0, stdout: "PID\tStatus\tLabel\n-\t0\tcom.clawmessenger.supervisor\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      { spawnPid: 909 },
    );
    state(h.paths, 4242);
    h.alive.add(4242);
    h.alive.add(909);

    await h.daemon.installService();

    expect(h.spawns).toHaveLength(1);
    expect(readFileSync(h.paths.pidFile, "utf8").trim()).toBe("909");
    expect(h.lines.join("")).toContain("restoring the background supervisor");
    expect(h.errors.join("")).toContain("Load failed: 5: Input/output error");
    expect(h.errors.join("")).toContain("com.clawmessenger.supervisor");
  });

  it("writes a hidden logon launcher into the Startup folder on Windows", async () => {
    const appData = join(tmpdir(), `clawmessenger-appdata-${Date.now()}`);
    dirs.push(appData);
    // 带空格的安装路径是 Windows 常态（C:\Program Files\...），正好压住两层引号：
    // 内层是 shell 命令行的引号，外层是 VBScript 字符串字面量。0.2.49 及之前漏了
    // 外层开引号，落盘成 `sh.Run ""C:\...exe"" run` —— VBScript 报语法错误，自启
    // 从未生效（2026-10-22 重启后运维节点集体离线）。
    const winExe = "C:\\Program Files\\clawmessenger\\clawmessenger.exe";
    const h = harness({
      platform: "win32",
      env: { APPDATA: appData, PATH: "C:\\bin" },
      selfArgv: () => ({ exec: winExe, args: [] }),
    });
    await h.daemon.installService();

    const vbs = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "clawmessenger.vbs");
    expect(existsSync(vbs)).toBe(true);
    const body = readFileSync(vbs, "utf8");
    expect(body).toContain(`sh.Run """${winExe}"" run", 0, False`);
    // cwd 必须钉死：登录自启时 wscript 的 cwd 是 System32，agent 会在那里找配置。
    expect(body).toContain(`sh.CurrentDirectory = "${h.home}"`);
    // 自愈必须在 exe **之外**：两步 rename 的中间态里 target 不存在，而这时没有
    // 任何进程能跑起来执行 healInstall（它住在需要被启动的那个 exe 里）。登录自启
    // 是唯一的「exe 之外」的执行点（审查报告 S4）。
    expect(body).toContain(`exePath = "${winExe}"`);
    expect(body).toContain("If Not fso.FileExists(exePath) Then");
    expect(body).toContain(`exeName & ".old-"`);
    expect(body).toContain(`exeName & ".new-"`);
    expect(body).toContain("fso.MoveFile best, exePath");
    // 模板标记：存量设备靠它判断「要不要补自愈块」。
    expect(body).toContain(STARTUP_VBS_TEMPLATE_MARKER);
    // 半截文件不能当恢复源：下载中间态是 <dest>.part，它同样命中 .new- 前缀
    // 且 Size>0，被 MoveFile 成 target 之后 heal 链会以为「没事」（审查报告 M3b）。
    expect(body).toContain('InStr(f.Name, ".part") = 0');
    // 自愈必须在 Run 之前，否则等于没做。
    expect(body.indexOf("fso.MoveFile best, exePath")).toBeLessThan(body.indexOf("sh.Run "));
    expect(h.lines.join("")).toContain("installed logon autostart");
  });
});

describe("daemon uninstall", () => {
  it("removes the autostart entry but leaves the pid file alone", async () => {
    const h = harness({ uid: 1001 });
    mkdirSync(join(h.home, ".config", "systemd", "user"), { recursive: true });
    const unitPath = join(h.home, ".config", "systemd", "user", "clawmessenger.service");
    writeFileSync(unitPath, "[Unit]\n");
    state(h.paths, 4242);
    h.alive.add(4242);

    await h.daemon.uninstall();

    expect(existsSync(unitPath)).toBe(false);
    expect(existsSync(h.paths.pidFile)).toBe(true);
    expect(h.lines.join("")).toContain("removed systemd user service");
    expect(h.lines.join("")).toContain("clawmessenger stop");
  });

  it("says nothing was configured when there is no autostart entry", async () => {
    const h = harness();
    await h.daemon.uninstall();
    expect(h.lines.join("")).toContain("no autostart entry was configured");
  });
});

// 存量设备（磁盘上的 VBS 是旧模板）必须在下一次启动后拿到自愈块 —— 远程升级走
// spawn `target run`，不会重写 VBS，所以只能由 supervisor 启动时补（审查报告 M3a）。
describe("logon script self-heal backfill", () => {
  const OLD_TEMPLATE = [
    "' clawmessenger: start the agent supervisor at logon, without a console window.",
    "' Generated by `clawmessenger install-service`. Remove with `clawmessenger uninstall`.",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "C:\\\\Users\\\\op"',
    'sh.Run """C:\\\\Program Files\\\\clawmessenger\\\\clawmessenger.exe"" run --model kimi", 0, False',
    "",
  ].join("\r\n");

  it("injects the block in place and leaves an --model argument alone", () => {
    const injected = injectStartupVbsSelfHeal(OLD_TEMPLATE, "C:\\Program Files\\clawmessenger\\clawmessenger.exe");
    expect(injected).not.toBeNull();
    const body = injected as string;
    expect(body).toContain(STARTUP_VBS_TEMPLATE_MARKER);
    expect(body).toContain("If Not fso.FileExists(exePath) Then");
    expect(body).toContain('InStr(f.Name, ".part") = 0');
    // 就地插入：原来的启动命令行（含安装时给的 --model）必须原样保留。
    expect(body).toContain('run --model kimi", 0, False');
    expect(body.indexOf("fso.MoveFile best, exePath")).toBeLessThan(body.indexOf("sh.Run "));
  });

  it("is a no-op on a file that already carries the marker", () => {
    const once = injectStartupVbsSelfHeal(OLD_TEMPLATE, "C:\\bin\\clawmessenger.exe") as string;
    expect(injectStartupVbsSelfHeal(once, "C:\\bin\\clawmessenger.exe")).toBeNull();
  });

  it("refuses to touch a file it does not recognise", () => {
    expect(injectStartupVbsSelfHeal('MsgBox "hello"', "C:\\bin\\clawmessenger.exe")).toBeNull();
  });

  it("rewrites a stale logon script exactly once on startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmessenger-vbs-"));
    dirs.push(dir);
    const vbs = join(dir, "clawmessenger.vbs");
    writeFileSync(vbs, OLD_TEMPLATE);
    const h = harness({
      platform: "win32",
      env: { APPDATA: dir, PATH: "C:\\bin" },
      autostartPaths: { startupVbs: vbs },
      selfArgv: () => ({ exec: "C:\\Program Files\\clawmessenger\\clawmessenger.exe", args: [] }),
    });

    const first = await h.daemon.refreshStartupScript();
    expect(first).toMatchObject({ updated: true, path: vbs });
    const afterFirst = readFileSync(vbs, "utf8");
    expect(afterFirst).toContain(STARTUP_VBS_TEMPLATE_MARKER);

    // 第二次必须一个字节都不动（幂等）：每次启动都改用户的开机脚本是不可接受的。
    const second = await h.daemon.refreshStartupScript();
    expect(second).toMatchObject({ updated: false, reason: "already-current" });
    expect(readFileSync(vbs, "utf8")).toBe(afterFirst);
  });

  it("does not create a logon script where there was none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmessenger-vbs-"));
    dirs.push(dir);
    const vbs = join(dir, "clawmessenger.vbs");
    const h = harness({ platform: "win32", env: { APPDATA: dir }, autostartPaths: { startupVbs: vbs } });
    const result = await h.daemon.refreshStartupScript();
    expect(result).toMatchObject({ updated: false, reason: "no-logon-script" });
    expect(existsSync(vbs)).toBe(false);
  });

  it("does nothing on other platforms", async () => {
    const h = harness({ platform: "linux" });
    const result = await h.daemon.refreshStartupScript();
    expect(result).toMatchObject({ updated: false, reason: "not-windows" });
  });
});

// Windows 崩溃自愈（2026-11-05）。
//
// 现场：codex-2 离线后一直没回来。根因不在「自启没装」——VBS 在「启动」文件夹里躺着，
// 只是它**只在登录时跑一次**：进程崩溃/被任务管理器结束后，没有任何东西会把它拉回来。
// Linux 那边 systemd 的 Restart=always 早就兜住了，Windows 没有等价物，只能拿计划任务补。
describe("Windows 看门狗", () => {
  const winHarness = (extra: Partial<DaemonOverrides> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "clawmessenger-watchdog-"));
    dirs.push(dir);
    const vbs = join(dir, "Startup", "clawmessenger.vbs");
    const cmd = join(dir, "watchdog.cmd");
    const h = harness({
      platform: "win32",
      env: { APPDATA: dir, PATH: "C://bin" },
      selfArgv: () => ({ exec: "C://Program Files//clawmessenger//clawmessenger.exe", args: [] }),
      autostartPaths: { startupVbs: vbs, watchdogCmd: cmd },
      ...extra,
    });
    return { h, dir, vbs, cmd };
  };

  it("install-service 除了登录自启，还注册每 5 分钟一次的看门狗任务", async () => {
    const { h, vbs, cmd } = winHarness();

    await h.daemon.installService();

    expect(existsSync(vbs)).toBe(true);
    expect(existsSync(cmd)).toBe(true);

    const create = h.commands.find((c) => c.file === "schtasks" && c.args.includes("/Create"));
    expect(create).toBeDefined();
    const args = create!.args;
    expect(args).toContain("/TN");
    expect(args[args.indexOf("/TN") + 1]).toBe("clawmessenger-watchdog");
    expect(args[args.indexOf("/SC") + 1]).toBe("MINUTE");
    expect(args[args.indexOf("/MO") + 1]).toBe("5");
    // /TR 指向 .cmd（含引号包裹，路径可能带空格），而不是直接拼 exe 命令行：
    // schtasks 对 /TR 里的引号解析各版本不一致，套一层 .cmd 才稳。
    const target = args[args.indexOf("/TR") + 1];
    expect(target).toBe(`"${cmd}"`);

    // 不传 /RU：默认当前用户、登录后运行，因此不需要管理员。
    expect(args).not.toContain("/RU");

    expect(h.lines.join("")).toContain("installed watchdog task");
    expect(h.lines.join("")).toContain("every 5 min");
  });

  it("看门狗脚本是薄壳：调 `clawmessenger watchdog`，并把输出重定向进日志", async () => {
    const { h, cmd } = winHarness();

    await h.daemon.installService();

    const body = readFileSync(cmd, "utf8");
    // 路径带空格时必须整体加引号，否则 cmd 会把 C:/Program 当成命令。
    expect(body).toContain('"C://Program Files//clawmessenger//clawmessenger.exe" watchdog');
    expect(body).toContain("watchdog.log");
    expect(body.startsWith("@echo off")).toBe(true);
  });

  it("计划任务注册失败时：不 fail-closed，但必须说清「崩溃后不会自己回来」", async () => {
    const { h, vbs } = winHarness({
      runCommand: (file, args) => {
        h.commands.push({ file, args });
        if (file === "schtasks") return { status: 1, stdout: "", stderr: "Access is denied." };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await h.daemon.installService();

    // 登录自启已经装好了，不能因为看门狗失败就把它回滚掉。
    expect(existsSync(vbs)).toBe(true);
    const errText = h.errors.join("");
    expect(errText).toContain("could not register the watchdog task");
    expect(errText).toContain("will NOT come back on its own");
    // 给一条能复制走的手动命令，而不是让用户自己猜参数。
    expect(errText).toContain("schtasks /Create");
  });

  it("watchdog：supervisor 活着时什么都不做，也不写日志噪声", async () => {
    const h = harness();
    state(h.paths, 4242);
    h.alive.add(4242);

    const started = await h.daemon.watchdog();

    expect(started).toBe(false);
    expect(h.spawns).toHaveLength(0);
    // 5 分钟一次的调度，一天 288 次；每次都写一行就是纯噪声，真出事时翻不到记录。
    expect(h.lines.join("")).toBe("");
  });

  it("watchdog：supervisor 不在了就拉起来，并在日志里留下时间戳", async () => {
    const h = harness({}, { spawnPid: 777 });
    h.alive.add(777); // 拉起后的新进程
    h.publishOnSpawn = (pid) => {
      writeSupervisorState({ pid, startedAt: 1_000_000, execPath: EXE, cwd: h.home, agents: ["claude"] }, h.paths);
    };

    const started = await h.daemon.watchdog();

    expect(started).toBe(true);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].argv).toEqual(["run"]);
    // detached：计划任务退出后不能让 supervisor 跟着走。
    expect(h.spawns[0].options.detached).toBe(true);
    expect(h.lines.join("")).toMatch(/watchdog: supervisor is not running/);
  });

  it("watchdog：pid 文件是崩溃残骸时也能起来，并标明是残骸", async () => {
    const h = harness({}, { spawnPid: 888 });
    state(h.paths, 4242); // 文件在，进程早没了
    h.alive.add(888);
    h.publishOnSpawn = (pid) => {
      writeSupervisorState({ pid, startedAt: 1_000_000, execPath: EXE, cwd: h.home, agents: ["claude"] }, h.paths);
    };

    const started = await h.daemon.watchdog();

    expect(started).toBe(true);
    expect(h.lines.join("")).toContain("stale pid/state left behind");
  });

  it("uninstall 连看门狗一起拆：先删任务再删脚本", async () => {
    const { h, cmd } = winHarness();
    await h.daemon.installService();
    expect(existsSync(cmd)).toBe(true);
    h.commands.length = 0;

    await h.daemon.uninstall();

    const del = h.commands.find((c) => c.file === "schtasks" && c.args.includes("/Delete"));
    expect(del).toBeDefined();
    expect(del!.args[del!.args.indexOf("/TN") + 1]).toBe("clawmessenger-watchdog");
    expect(existsSync(cmd)).toBe(false);
    expect(h.lines.join("")).toContain("removed watchdog task");
  });

  it("status 的 autostart 行要能看出「只装了登录自启、没有看门狗」", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmessenger-watchdog-status-"));
    dirs.push(dir);
    const vbs = join(dir, "clawmessenger.vbs");
    const cmd = join(dir, "watchdog.cmd");

    const onlyVbs = harness({ platform: "win32", env: { APPDATA: dir }, autostartPaths: { startupVbs: vbs, watchdogCmd: cmd } });
    writeFileSync(vbs, "rem logon only\n");
    expect(formatDaemonStatus(onlyVbs.daemon.status()).toString()).toContain("no crash watchdog");

    const both = harness({ platform: "win32", env: { APPDATA: dir }, autostartPaths: { startupVbs: vbs, watchdogCmd: cmd } });
    writeFileSync(cmd, "rem watchdog\n");
    const text = formatDaemonStatus(both.daemon.status());
    expect(text).toContain("watchdog every 5 min");
    expect(text).not.toContain("no crash watchdog");
  });
});

// 存量设备也会拿到看门狗：远程升级只会 spawn `target run`，不会有人再去点一次
// install-service。不在 supervisor 启动时补一刀，自愈就只对新装设备生效 —— 而现场
// 离线的那批恰恰全是存量设备。
describe("ensureWatchdog（存量设备自愈补装）", () => {
  const setup = (extra: Partial<DaemonOverrides> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "clawmessenger-ensure-watchdog-"));
    dirs.push(dir);
    const vbs = join(dir, "Startup", "clawmessenger.vbs");
    const cmd = join(dir, "watchdog.cmd");
    const h = harness({
      platform: "win32",
      env: { APPDATA: dir, PATH: "C://bin" },
      selfArgv: () => ({ exec: "C://Program Files//clawmessenger//clawmessenger.exe", args: [] }),
      autostartPaths: { startupVbs: vbs, watchdogCmd: cmd },
      ...extra,
    });
    return { h, dir, vbs, cmd };
  };

  it("从没装过登录自启的设备一律不碰：未经同意不往别人机器上写开机项", async () => {
    const { h, cmd } = setup();

    const result = await h.daemon.ensureWatchdog();

    expect(result).toEqual({ created: false, reason: "no-logon-autostart" });
    expect(existsSync(cmd)).toBe(false);
    // 连 schtasks 都不该被调用（有个用例把这条钉死：只读探测也不该发生）。
    expect(h.commands.filter((c) => c.file === "schtasks")).toHaveLength(0);
  });

  it("已装登录自启但缺看门狗 → 补上 cmd 与计划任务", async () => {
    const { h, vbs, cmd } = setup();
    mkdirSync(join(vbs, ".."), { recursive: true });
    writeFileSync(vbs, "rem logon only\n");

    const result = await h.daemon.ensureWatchdog();

    expect(result).toEqual({ created: true });
    expect(existsSync(cmd)).toBe(true);
    const create = h.commands.find((c) => c.file === "schtasks" && c.args.includes("/Create"));
    expect(create).toBeDefined();
    expect(create!.args[create!.args.indexOf("/TN") + 1]).toBe("clawmessenger-watchdog");
  });

  it("任务已经在了就一个字节都不动（/Create /F 会覆盖用户加过的触发器）", async () => {
    const { h, vbs, cmd } = setup();
    mkdirSync(join(vbs, ".."), { recursive: true });
    writeFileSync(vbs, "rem logon only\n");
    writeFileSync(cmd, "rem existing watchdog\n");

    const result = await h.daemon.ensureWatchdog();

    expect(result).toEqual({ created: false, reason: "already-installed" });
    expect(readFileSync(cmd, "utf8")).toBe("rem existing watchdog\n");
    expect(h.commands.filter((c) => c.args.includes("/Create"))).toHaveLength(0);
  });

  it("非 Windows 平台：直接跳过，不去调 schtasks", async () => {
    const h = harness({ platform: "linux" });
    const result = await h.daemon.ensureWatchdog();
    expect(result).toEqual({ created: false, reason: "not-windows" });
    expect(h.commands).toHaveLength(0);
  });
});

// 中文 Windows 上 schtasks.exe 的报错原文是 GBK（cp936）编码；过去按 UTF-8 解码
// 后上报给服务端的 detail 全是菱形（U+FFFD）。这一组钉住两级兜底解码 + 替换符清洗。
describe("decodeCommandOutput（子进程输出的编码兜底）", () => {
  it("合法 UTF-8 原样返回", () => {
    const text = "错误: 系统找不到指定的文件。";
    expect(decodeCommandOutput(Buffer.from(text, "utf8"))).toBe(text);
  });

  it("GBK 字节（中文 Windows 的 ANSI 输出）正确转回中文", () => {
    // 「拒绝访问」的 GBK/cp936 编码。这些字节不是合法 UTF-8，严格 UTF-8 解码会
    // 抛错，于是落到 GBK 一级。（字节序列已用 Node full-ICU 的 TextDecoder 验证。）
    const gbk = Buffer.from([0xbe, 0xdc, 0xbe, 0xf8, 0xb7, 0xc3, 0xce, 0xca]);
    expect(decodeCommandOutput(gbk)).toBe("拒绝访问");
  });

  it("纯 ASCII 输出不受影响（GBK 与 UTF-8 在 ASCII 区间一致）", () => {
    expect(decodeCommandOutput(Buffer.from("ERROR: The system cannot find the file specified.\r\n"))).toBe(
      "ERROR: The system cannot find the file specified.\r\n",
    );
  });

  it("无效字节被清掉，不留 U+FFFD 残留", () => {
    // [0x41, 0x81, 0x20, 0x42] 在 UTF-8 里非法（0x81 是孤立续字节）、在 GBK 里
    // 也不合法（0x81 作首字节时 0x20 不是合法的次字节）：两级严格解码都失败 →
    // 宽松 UTF-8 把 0x81 替换成 U+FFFD，最后必须被清掉。
    const decoded = decodeCommandOutput(Buffer.from([0x41, 0x81, 0x20, 0x42]));
    expect(decoded).toBe("A B");
    expect(decoded).not.toContain("\uFFFD");
  });

  it("空输出给空串", () => {
    expect(decodeCommandOutput(Buffer.alloc(0))).toBe("");
  });
});

describe("serviceHealth（Windows 看门狗探测的编码兜底）", () => {
  const setup = (spawnSyncOverride: Partial<DaemonOverrides> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "clawmessenger-health-gbk-"));
    dirs.push(dir);
    const vbs = join(dir, "Startup", "clawmessenger.vbs");
    const cmd = join(dir, "watchdog.cmd");
    mkdirSync(join(vbs, ".."), { recursive: true });
    writeFileSync(vbs, "rem logon autostart\n");
    writeFileSync(cmd, "rem watchdog shell\n");
    return harness({
      platform: "win32",
      env: { APPDATA: dir },
      autostartPaths: { startupVbs: vbs, watchdogCmd: cmd },
      ...spawnSyncOverride,
    });
  };

  it("schtasks 报错原文是 GBK 字节时，detail 里是中文而不是菱形", () => {
    // 「拒绝访问」的 GBK 编码 —— 安全软件拦截 schtasks 时在中文 Windows 上就是这个。
    const spawnSyncFake = ((file: string, args: string[], options: { encoding?: string }) => {
      expect(file).toBe("schtasks");
      expect(args).toEqual(["/Query", "/TN", "clawmessenger-watchdog"]);
      expect(options.encoding).toBe("buffer");
      return {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from([0xbe, 0xdc, 0xbe, 0xf8, 0xb7, 0xc3, 0xce, 0xca]),
        pid: 0,
      };
    }) as unknown as typeof import("node:child_process").spawnSync;
    const h = setup({ spawnSync: spawnSyncFake });

    const health = h.daemon.serviceHealth();

    expect(health.ready).toBe(false);
    expect(health.detail).toContain("拒绝访问");
    expect(health.detail).not.toContain("\uFFFD");
  });

  it("探测拿不到输出（如被安全软件拦死）时仍给默认文案，不出现替换符", () => {
    const spawnSyncFake = (() => ({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0 })) as unknown as typeof import("node:child_process").spawnSync;
    const h = setup({ spawnSync: spawnSyncFake });

    const health = h.daemon.serviceHealth();

    expect(health.ready).toBe(false);
    expect(health.detail).toContain("schtasks 不可用");
    expect(health.detail).not.toContain("\uFFFD");
  });

  it("任务已注册（status 0）时 ready=true，与编码处理无关", () => {
    const spawnSyncFake = (() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0 })) as unknown as typeof import("node:child_process").spawnSync;
    const h = setup({ spawnSync: spawnSyncFake });

    const health = h.daemon.serviceHealth();

    expect(health.ready).toBe(true);
    expect(health.detail).toContain("崩溃看门狗");
  });
});
