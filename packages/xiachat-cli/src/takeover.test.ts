import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLegacyExeName, installPaths, legacyInstallPaths, removeLegacyAutostart, takeOverLegacy } from "./install.js";
import { TAKEOVER_MARKER } from "./paths.js";

// 接管状态机（design §2.4）：新代码跑在旧文件名下时一次性完成迁移，marker
// 防止重入（升级死循环的闸）。这里验证判定、幂等与旧自启清理三类关键行为。
describe("install: legacy exe name detection", () => {
  it("recognises the legacy command name on both platforms (case-insensitive on win32)", () => {
    expect(isLegacyExeName("C:\\x\\clawmessenger.exe", "win32")).toBe(true);
    expect(isLegacyExeName("C:\\x\\CLAWMESSENGER.EXE", "win32")).toBe(true);
    expect(isLegacyExeName("C:\\x\\agentsbb.exe", "win32")).toBe(false);
    expect(isLegacyExeName("/usr/bin/clawmessenger", "linux")).toBe(true);
    expect(isLegacyExeName("/usr/bin/agentsbb", "linux")).toBe(false);
    expect(isLegacyExeName("", "linux")).toBe(false);
  });
});

describe("install: path generations", () => {
  it("new install paths use agentsbb", () => {
    const win = installPaths("win32", "C:\\Users\\u");
    expect(win.dir.endsWith("\\agentsbb")).toBe(true);
    expect(win.exe).toBe("agentsbb.exe");
    const posix = installPaths("linux", "/home/u");
    expect(posix.exe).toBe("agentsbb");
    expect(posix.target).toBe("/home/u/.local/bin/agentsbb");
  });

  it("legacy paths stay readable for the takeover only (never written)", () => {
    const win = legacyInstallPaths("win32", "C:\\Users\\u");
    expect(win.target.endsWith("clawmessenger\\clawmessenger.exe")).toBe(true);
    const posix = legacyInstallPaths("linux", "/home/u");
    expect(posix.target).toBe("/home/u/.local/bin/clawmessenger");
  });
});

describe("install: legacy autostart cleanup (dual whitelist)", () => {
  it("removes systemd units, launchd agent, schtasks and the old VBS, best-effort", () => {
    const commands: { file: string; args: string[] }[] = [];
    const removed = removeLegacyAutostart(
      "linux",
      (file, args) => {
        commands.push({ file, args });
        return { status: 0, stdout: "", stderr: "" };
      },
      "/home/u",
    );
    expect(commands.some((c) => c.args.join(" ") === "disable --now clawmessenger")).toBe(true);
    expect(commands.some((c) => c.args.join(" ") === "--user disable --now clawmessenger")).toBe(true);

    const winRemoved = removeLegacyAutostart(
      "win32",
      (file, args) => {
        commands.push({ file, args });
        return { status: 0, stdout: "", stderr: "" };
      },
      "C:\\Users\\u",
    );
    const joined = commands.map((c) => c.args.join(" "));
    expect(joined.some((s) => s.includes("/TN ClawMessenger Agents"))).toBe(true);
    expect(joined.some((s) => s.includes("/TN clawmessenger-watchdog"))).toBe(true);
    expect(winRemoved.length).toBeGreaterThan(0);
  });

  it("a failing cleanup step never throws (new chain must not be blocked)", () => {
    expect(() =>
      removeLegacyAutostart(
        "linux",
        () => {
          throw new Error("systemctl missing");
        },
        "/home/u",
      ),
    ).not.toThrow();
  });
});

describe("install: takeOverLegacy state machine", () => {
  let dir: string;
  let userHome: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentsbb-takeover-"));
    userHome = join(dir, "home");
    stateDir = join(dir, "state");
    mkdirSync(userHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when the process is not running under a legacy name", async () => {
    const result = await takeOverLegacy({
      platform: "linux",
      env: {},
      homedir: userHome,
      execPath: "/opt/agentsbb/agentsbb",
    });
    expect(result.takenOver).toBe(false);
    expect(result.reason).toBe("not-legacy-name");
    expect(existsSync(join(stateDir, TAKEOVER_MARKER))).toBe(false);
  });

  it("runs once: migrates state, re-registers the service, cleans legacy autostart, writes the marker", async () => {
    // 旧配置目录在场 → 接管应先完成迁移（marker 与迁移产物同目录）。
    const legacyState = join(userHome, ".clawmessenger");
    mkdirSync(legacyState, { recursive: true });
    writeFileSync(join(legacyState, "credentials.json"), "{}", "utf8");

    const calls: string[] = [];
    const result = await takeOverLegacy({
      platform: "linux",
      env: { AGENTSBB_VERSION: "1.4.0" },
      homedir: userHome,
      execPath: "/home/u/.local/bin/clawmessenger",
      installService: () => {
        calls.push("install-service");
        return Promise.resolve();
      },
      removeLegacyAutostart: () => {
        calls.push("legacy-cleanup");
        return ["legacy systemd service"];
      },
      stderr: { write: () => undefined },
    });

    expect(result.takenOver).toBe(true);
    expect(result.removedLegacy).toEqual(["legacy systemd service"]);
    // 顺序：先重注册新服务，再清旧自启。
    expect(calls).toEqual(["install-service", "legacy-cleanup"]);
    const migratedDir = join(userHome, ".agentsbb");
    // marker 落地（幂等闸）且记录版本。
    const marker = JSON.parse(readFileSync(join(migratedDir, TAKEOVER_MARKER), "utf8")) as { version: string };
    expect(marker.version).toBe("1.4.0");
    // 配置目录已迁移（复制语义）。
    expect(existsSync(join(migratedDir, "credentials.json"))).toBe(true);
    // 旧目录原样保留。
    expect(existsSync(join(legacyState, "credentials.json"))).toBe(true);
  });

  it("second run is a no-op when the marker already exists (no service churn, no loop)", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, TAKEOVER_MARKER),
      JSON.stringify({ version: "1.4.0", at: new Date().toISOString() }),
      "utf8",
    );
    const calls: string[] = [];
    const result = await takeOverLegacy({
      platform: "linux",
      env: {},
      homedir: userHome,
      stateDir,
      execPath: "/home/u/.local/bin/clawmessenger",
      installService: () => {
        calls.push("install-service");
        return Promise.resolve();
      },
      stderr: { write: () => undefined },
    });
    expect(result.takenOver).toBe(false);
    expect(result.reason).toBe("already-done");
    expect(calls).toHaveLength(0);
  });

  it("skips re-registration when installService throws (marker not written, next start retries)", async () => {
    const result = await takeOverLegacy({
      platform: "linux",
      env: {},
      homedir: userHome,
      stateDir,
      execPath: "/home/u/.local/bin/clawmessenger",
      installService: () => Promise.reject(new Error("systemctl unavailable")),
      stderr: { write: () => undefined },
    });
    expect(result.takenOver).toBe(false);
    expect(result.reason).toBe("systemctl unavailable");
    expect(existsSync(join(stateDir, TAKEOVER_MARKER))).toBe(false);
  });
});
