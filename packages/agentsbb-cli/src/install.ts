/**
 * Self-install: when the single-file SEA executable runs for the first time
 * (typically straight from the Downloads folder), copy itself to a per-user
 * install directory and add that directory to the user's PATH — no admin
 * rights required. Idempotent: running the already-installed copy, or running
 * again from anywhere, is a quiet no-op.
 *
 *   Windows:  %LOCALAPPDATA%\agentsbb\agentsbb.exe  (HKCU\Environment\Path)
 *   Linux/macOS:  ~/.local/bin/agentsbb             (~/.bashrc / ~/.zshrc)
 *
 * Rebrand takeover: devices installed by v≤1.3.33 have the old locations
 * (`%LOCALAPPDATA%\clawmessenger\clawmessenger.exe`, `~/.local/bin/clawmessenger`)
 * on their PATH. `ensureInstalled` additionally keeps a *compat* copy / shim
 * script at the old command name inside the NEW install directory, so no matter
 * which PATH entry a user's shell hits, they get the new version. The old
 * directory's exe becomes a dead file. `takeOverLegacy` (invoked from bin.ts
 * when the running exe is still called `clawmessenger`) finishes the job once:
 * migrate the state dir, re-register autostart under the new names, remove the
 * old autostart entries, and write a marker so the branch never re-enters
 * (upgrade-loop protection, design §2.4).
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureStateHome, TAKEOVER_MARKER } from "./paths.js";

export interface InstallPaths {
  dir: string;
  exe: string;
  target: string;
}

/** Per-user install directory and executable name for a platform. */
export function installPaths(platform: string, homedir: string, localAppData?: string): InstallPaths {
  if (platform === "win32") {
    const base = localAppData || path.win32.join(homedir, "AppData", "Local");
    const dir = path.win32.join(base, "agentsbb");
    return { dir, exe: "agentsbb.exe", target: path.win32.join(dir, "agentsbb.exe") };
  }
  const dir = path.posix.join(homedir, ".local", "bin");
  return { dir, exe: "agentsbb", target: path.posix.join(dir, "agentsbb") };
}

/**
 * Legacy (v≤1.3.33) install locations. Only used by the takeover logic to
 * recognise the old command name; never written to.
 */
// TODO(rebrand-retire): 移除于 v1.6+ —— 旧安装目录不再存在时删除。
export function legacyInstallPaths(platform: string, homedir: string, localAppData?: string): InstallPaths {
  if (platform === "win32") {
    const base = localAppData || path.win32.join(homedir, "AppData", "Local");
    const dir = path.win32.join(base, "clawmessenger");
    return { dir, exe: "clawmessenger.exe", target: path.win32.join(dir, "clawmessenger.exe") };
  }
  const dir = path.posix.join(homedir, ".local", "bin");
  return { dir, exe: "clawmessenger", target: path.posix.join(dir, "clawmessenger") };
}

/**
 * The executable names this device's legacy install used. An exe running under
 * one of these names is a new version that was swapped in through the old
 * self-update path (or launched via the old compat name) and still needs the
 * one-time takeover (rename install dir + service names).
 */
// TODO(rebrand-retire): 移除于 v1.6+
export const LEGACY_EXE_NAMES = new Set(["clawmessenger", "clawmessenger.exe"]);

/** basename(execPath) 旧名判定（大小写不敏感，Windows 语义）。 */
export function isLegacyExeName(execPath: string, platform: string = process.platform): boolean {
  if (!execPath) return false;
  const base = path.basename(execPath, platform === "win32" ? ".exe" : undefined);
  const withExt = path.basename(execPath);
  return LEGACY_EXE_NAMES.has(base.toLowerCase()) || LEGACY_EXE_NAMES.has(withExt.toLowerCase());
}

/**
 * True when running as a single-file SEA executable (not `node bundle.js`).
 *
 * `.cjs` / `.mjs` count as script entrypoints too: the SEA entry bundle that
 * `scripts/build-exe.mjs` emits is `dist/agentsbb.sea.cjs`, and the release
 * pipeline runs it with plain `node ... --version` to check the baked-in
 * version. Judging that run as "the exe" is not a harmless over-detection — it
 * makes a version check heal/swap a real install directory and copy the running
 * `node` binary (100+ MB) over `~/.local/bin/agentsbb`.
 */
export function isSeaExecutable(argv1: string | undefined): boolean {
  if (!argv1) return true;
  return !/\.(c|m)?js$/i.test(argv1);
}

/**
 * 一次自更新该覆盖哪个文件。
 *
 * 单文件 exe 跑起来时，答案只有一个：**正在运行的自己**（`process.execPath`）。
 * 按平台去猜安装路径会在 Linux 上直接猜错 —— systemd 的 unit 可能指向
 * `/usr/local/bin/agentsbb`，而 `installPaths` 给的是 `~/.local/bin/...`。
 * 换错的后果不是「升级没生效」这么简单：unit 重启后仍跑旧版，而那份没人用的
 * 副本变成了新版，于是「页面显示的版本 / 磁盘上的文件 / 实际在跑的东西」三方
 * 对不上，且下一次升级又会去改同一个错文件。
 *
 * 只有在用 node 跑脚本（非 SEA）时才退回安装路径 —— 那时 `process.execPath`
 * 是 node 本体，覆盖它等于把开发机的 node 换成一个 CLI 二进制。
 */
export function upgradeTargetPath(
  platform: string,
  argv1: string | undefined,
  execPath: string,
  homedir: string,
  localAppData?: string,
): string {
  if (isSeaExecutable(argv1)) return execPath;
  return installPaths(platform, homedir, localAppData).target;
}

/** Case-insensitive on Windows, exact elsewhere. */
export function samePath(a: string, b: string, platform: string): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const ra = p.resolve(a);
  const rb = p.resolve(b);
  return platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Extract the Path value from `reg query HKCU\Environment /v Path` output. */
export function parseRegPathQuery(stdout: string): string {
  const m = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]*)/i);
  const value = (m?.[1] ?? "").trim();
  // Empty values are echoed as "(value not set)" or similar; treat as absent.
  if (!value || value.startsWith("(")) return "";
  return value;
}

/** Append `entry` to a `;`-separated PATH value unless already present. */
export function nextPathValue(current: string, entry: string, platform: string): string {
  const sep = platform === "win32" ? ";" : ":";
  const norm = (s: string): string => (platform === "win32" ? s.trim().toLowerCase() : s.trim());
  const segments = current.split(sep).map((s) => s.trim()).filter(Boolean);
  if (segments.some((s) => norm(s) === norm(entry))) return current;
  return segments.length ? segments.join(sep) + sep + entry : entry;
}

const RC_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

function ensureUnixPath(dir: string): boolean {
  // Already visible in this shell's PATH (e.g. ~/.profile default) — nothing to do.
  const inPath = (process.env.PATH ?? "").split(path.delimiter).includes(dir);
  if (inPath) return false;
  let changed = false;
  const home = os.homedir();
  for (const rc of [".bashrc", ".zshrc"]) {
    const rcPath = path.join(home, rc);
    try {
      if (existsSync(rcPath)) {
        const content = readFileSync(rcPath, "utf8");
        if (content.includes(".local/bin")) continue;
        writeFileSync(rcPath, content.replace(/\s*$/, "") + "\n" + RC_PATH_LINE + "\n", "utf8");
      } else if (rc === ".bashrc") {
        writeFileSync(rcPath, RC_PATH_LINE + "\n", "utf8");
      } else {
        continue; // no zshrc — don't create one
      }
      changed = true;
    } catch {
      // best effort
    }
  }
  return changed;
}

function ensureWindowsPath(dir: string): boolean {
  // Prefer the expandable literal when LOCALAPPDATA is the standard base.
  // The legacy %LOCALAPPDATA%\clawmessenger entry is left alone for now — an
  // existing entry pointing at the old directory does no harm (the compat exe
  // there keeps working) and removing registry entries on a failed install
  // would strand users.
  // TODO(rebrand-retire): 清理旧 PATH 条目于 v1.6+
  const literal = process.env.LOCALAPPDATA ? "%LOCALAPPDATA%\\agentsbb" : dir;
  const query = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
  const current = query.status === 0 ? parseRegPathQuery(query.stdout) : "";
  const next = nextPathValue(current, literal, "win32");
  if (next === current) return false;
  const add = spawnSync("reg", [
    "add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f",
  ]);
  return add.status === 0;
}

export interface InstallResult {
  /** The binary was copied to the install directory this run. */
  copied: boolean;
  /** The user's PATH configuration was modified this run. */
  pathAdded: boolean;
  dir: string;
  target: string;
}

/**
 * Best-effort self-install. Returns null when not applicable (dev `node`
 * mode) or on unexpected failure — never throws, never blocks normal CLI
 * operation.
 */
export function ensureInstalled(): InstallResult | null {
  try {
    if (!isSeaExecutable(process.argv[1])) return null;
    const platform = process.platform;
    const paths = installPaths(platform, os.homedir());
    mkdirSync(paths.dir, { recursive: true });
    let copied = false;
    if (!samePath(process.execPath, paths.target, platform)) {
      const tmp = `${paths.target}.tmp-${process.pid}`;
      try {
        copyFileSync(process.execPath, tmp);
        try {
          renameSync(tmp, paths.target); // atomic-ish replace of an old install
        } catch {
          copyFileSync(process.execPath, paths.target);
        }
        copied = true;
      } catch (err) {
        // Target may be locked by a running instance; PATH is still ensured.
        process.stderr.write(
          `agentsbb: could not self-install to ${paths.target}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      } finally {
        // A successful rename consumes tmp; every other exit path — including a
        // fallback copy that throws EBUSY on a locked target — must not leave a
        // full-size stray file next to the install.
        try {
          unlinkSync(tmp);
        } catch {
          // already renamed into place, or never created
        }
      }
    }
    writeLegacyCompatEntry(platform, paths, process.execPath);
    const pathAdded = platform === "win32" ? ensureWindowsPath(paths.dir) : ensureUnixPath(paths.dir);
    return { copied, pathAdded, dir: paths.dir, target: paths.target };
  } catch {
    return null;
  }
}

/**
 * Keep the legacy command name working after the rename (design §2.2 step 3).
 *
 *   Windows: a byte copy of the new exe as `<installDir>\clawmessenger.exe`.
 *     The exe self-checks its basename: a process invoked as
 *     `clawmessenger(.exe)` prints the deprecation notice and spawns
 *     `agentsbb` with the same arguments (bin.ts).
 *   POSIX: a shell shim at `~/.local/bin/clawmessenger` that execs the new
 *     binary with all arguments.
 *
 * Either way, every PATH entry — old or new — resolves to the new version.
 * Best-effort: the compat copy may be busy running (EBUSY) — retried next
 * start. Never throws.
 */
function writeLegacyCompatEntry(platform: string, paths: InstallPaths, execPath: string): void {
  // TODO(rebrand-retire): 垫片 v1.6.0 退役时整体删除
  try {
    if (platform === "win32") {
      const compat = path.win32.join(paths.dir, "clawmessenger.exe");
      if (samePath(execPath, compat, platform)) return; // running AS the compat copy
      let needsCopy = true;
      try {
        // Skip the copy when the on-disk compat exe is already this image
        // (byte-size equality is a cheap approximation — the exe is only ever
        // replaced whole by self-update, never appended to).
        const selfSize = statSync(execPath).size;
        const compatSize = statSync(compat).size;
        if (selfSize === compatSize) needsCopy = false;
      } catch {
        // stat failure (missing / unreadable) → just copy
      }
      if (!needsCopy) return;
      const tmp = `${compat}.tmp-${process.pid}`;
      try {
        copyFileSync(execPath, tmp);
        renameSync(tmp, compat);
      } catch {
        try {
          copyFileSync(execPath, compat);
        } catch {
          // busy / locked: retried on a later start
        }
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // already renamed
        }
      }
      return;
    }
    const compat = path.posix.join(paths.dir, "clawmessenger");
    if (samePath(execPath, compat, platform)) return; // running AS the compat shim
    const shim = `#!/bin/sh\n# Deprecated alias kept during the ClawMessenger → AgentsBB rename.\n# TODO(rebrand-retire): 垫片 v1.6.0 退役时删除本文件。\nexec "${paths.target.replace(/"/g, '\\"')}" "$@"\n`;
    try {
      if (existsSync(compat)) {
        if (readFileSync(compat, "utf8") === shim) return;
      }
      writeFileSync(compat, shim, { mode: 0o755 });
    } catch {
      // read-only dir: retried on a later start
    }
  } catch {
    // never let compat bookkeeping break the CLI
  }
}

export interface TakeOverResult {
  /** True when the takeover ran (or had already run) this start. */
  takenOver: boolean;
  /** Why nothing happened: not-legacy-name / already-done / <error>. */
  reason?: string;
  target?: string;
  /** Autostart entries removed from the legacy names (best-effort). */
  removedLegacy?: string[];
}

/** Minimal re-registration surface — real daemon implementation in daemon.ts. */
export interface TakeOverOverrides {
  platform?: string;
  homedir?: string;
  localAppData?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 本进程 exe 的路径（默认 process.execPath；测试注入旧名路径）。 */
  execPath?: string;
  now?: () => number;
  /** Service (re)registration — wired to daemon.ts createDaemon().installService(). */
  installService?: () => Promise<unknown>;
  /** Legacy autostart cleanup, per-platform; injected in tests. */
  removeLegacyAutostart?: (platform: string) => string[];
  /** stderr sink for the bilingual takeover notice. */
  stderr?: { write(s: string): unknown };
}

/**
 * Default legacy-autostart cleanup: systemd user+system units, launchd agent,
 * Windows scheduled tasks and the old startup-folder VBS. Best-effort — every
 * step is individually guarded and a failure only skips that step. The running
 * legacy supervisor is NOT killed here: installService (called before this in
 * takeOverLegacy) already stops/restarts the supervisor under the new unit.
 */
export function removeLegacyAutostart(
  platform: string,
  runCommand: (file: string, args: string[]) => { status: number | null; stdout: string; stderr: string },
  home: string,
): string[] {
  // TODO(rebrand-retire): 移除于 v1.6+ —— 旧服务名不再存在时删除
  const removed: string[] = [];
  try {
    if (platform === "linux") {
      for (const scope of [[], ["--user"]]) {
        const r = runCommand("systemctl", [...scope, "disable", "--now", "clawmessenger"]);
        if (r.status === 0) removed.push(`systemd${scope.join("")} clawmessenger.service`);
        const unit = scope.length === 0
          ? `/etc/systemd/system/clawmessenger.service`
          : path.join(home, ".config", "systemd", "user", "clawmessenger.service");
        try {
          if (existsSync(unit)) {
            rmSync(unit, { force: true });
          }
        } catch {
          // best effort
        }
      }
    } else if (platform === "darwin") {
      const plist = path.join(home, "Library", "LaunchAgents", "com.clawmessenger.supervisor.plist");
      const r = runCommand("launchctl", ["remove", "com.clawmessenger.supervisor"]);
      if (r.status === 0) removed.push(`launchd com.clawmessenger.supervisor`);
      try {
        if (existsSync(plist)) {
          rmSync(plist, { force: true });
          removed.push(plist);
        }
      } catch {
        // best effort
      }
    } else if (platform === "win32") {
      for (const task of ["ClawMessenger Agents", "clawmessenger-watchdog"]) {
        const r = runCommand("schtasks", ["/Delete", "/F", "/TN", task]);
        if (r.status === 0) removed.push(`scheduled task (${task})`);
      }
      const vbs = path.join(
        process.env.APPDATA || path.win32.join(home, "AppData", "Roaming"),
        "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "clawmessenger.vbs",
      );
      try {
        if (existsSync(vbs)) {
          rmSync(vbs, { force: true });
          removed.push(vbs);
        }
      } catch {
        // best effort
      }
    }
  } catch {
    // never let legacy cleanup block the new chain
  }
  return removed;
}

/**
 * One-time takeover of a legacy install (design §2.4 trigger point B).
 *
 * Precondition checked by the caller (bin.ts): the running exe is named
 * `clawmessenger(.exe)`. Idempotence: the `rename-complete.json`-style marker
 * in the (possibly freshly migrated) state dir makes this run exactly once —
 * without it, the old-name exe would re-run the takeover on every start and
 * re-register services forever (upgrade-loop hazard named in the PRD).
 *
 * Steps: migrate state dir → self is already installed at the new target by
 * `ensureInstalled` → re-register autostart under the new names → remove the
 * legacy autostart entries (best-effort) → write the marker.
 */
export async function takeOverLegacy(overrides: TakeOverOverrides = {}): Promise<TakeOverResult> {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const home = overrides.homedir ?? os.homedir();
  const execPath = overrides.execPath ?? process.execPath;
  if (!isLegacyExeName(execPath, platform)) {
    return { takenOver: false, reason: "not-legacy-name" };
  }
  const migration = ensureStateHome(env, () => home);
  const stateDir = overrides.stateDir ?? migration.home;
  const marker = path.join(stateDir, TAKEOVER_MARKER);
  if (existsSync(marker)) {
    return { takenOver: false, reason: "already-done" };
  }
  const stderr = overrides.stderr ?? process.stderr;
  stderr.write(
    "\n已升级为 AgentsBB，正在完成命名迁移（配置目录与自启服务）…\n" +
    "Upgraded to AgentsBB — finishing the rename (state dir and autostart services)…\n",
  );

  // Re-register autostart under the new names first: if this throws we still
  // want the marker NOT to be written so the next start retries.
  try {
    if (overrides.installService) {
      await overrides.installService();
    }
  } catch (err) {
    return { takenOver: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const removed = overrides.removeLegacyAutostart
    ? overrides.removeLegacyAutostart(platform)
    : removeLegacyAutostart(platform, (file, args) => {
        const r = spawnSync(file, args, { encoding: "utf8" });
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      }, home);

  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      marker,
      JSON.stringify({
        version: env.AGENTSBB_VERSION ?? env.CLAWMESSENGER_VERSION ?? "",
        // TODO(rebrand-retire): 双读过渡，移除 CLAWMESSENGER_VERSION 于 v1.6+
        at: new Date((overrides.now ?? (() => Date.now()))()).toISOString(),
        legacyInstall: legacyInstallPaths(platform, home, overrides.localAppData).target,
      }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch (err) {
    // Marker write failed → next start re-runs the takeover. installService is
    // idempotent (it overwrites the VBS/unit in place), so a retry is safe.
    return { takenOver: true, reason: `marker-write-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result: TakeOverResult = { takenOver: true, removedLegacy: removed };
  return result;
}
