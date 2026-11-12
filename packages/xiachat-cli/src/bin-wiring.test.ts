/**
 * 入口与命令的「暂存落点」一致性守卫（源码级，运行时不可测）。
 *
 * 为什么只能读源码：`bin.ts` 是进程入口，顶层就带副作用（交换暂存的 exe、
 * 把自身复制到 ~/.local/bin）。在测试里 import 它，会真的去动跑测试那台机器的
 * home 目录 —— 这不是「难测」，是「不该测」。
 *
 * 要锁住的回归（2026-10-28 现场事故）：
 *   暂存升级的落点必须是 `upgradeTargetPath`（= 正在运行的自己 / execPath），
 *   不能退回按平台猜的 `installPaths`。猜错时的现象极具欺骗性 ——
 *   systemd 的 unit 指向 /usr/local/bin、installPaths 指向 ~/.local/bin，
 *   于是暂存文件落在**没人运行的那份**旁边：`update` 兴高采烈地报
 *   「staged 1.3.x」，每次启动却去另一个目录找暂存、永远找不到，
 *   版本纹丝不动；而下一次 `update` 又会去改同一个错文件，问题自己不会暴露。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 取 `start` 之后、`end` 之前的那一段；找不到 start 直接抛，避免静默通过。 */
function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

describe("暂存升级的落点必须与正在运行的自己一致", () => {
  it("bin.ts 的启动兜底交换走 upgradeTargetPath，不用 installPaths 猜路径", () => {
    const src = read("./bin.ts");
    expect(src).toContain("upgradeTargetPath(");
    // 注释里提到 installPaths 是允许的（那是在解释为什么不能用它），
    // 但不允许出现调用。所以匹配「带左括号的调用」而不是裸标识符。
    expect(/installPaths\s*\(/.test(src)).toBe(false);
  });

  it("update 命令与启动交换指向同一个判定函数", () => {
    const src = read("./main.ts");
    const updateBlock = sliceBetween(src, '.command("update")', '.command("__relaunch"');
    expect(updateBlock).toContain("upgradeTargetPath(");
    expect(/installPaths\s*\(/.test(updateBlock)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 状态目录迁移必须挂在**启动链**上，而不是挂在「旧 exe 名」上
//
// QA 回归 P1（真跑复现）：存量设备的 `~/.clawmessenger` 从未被搬到 `~/.agentsbb`。
// 原因是 `ensureStateHome()` 当时只有 takeOverLegacy() 一个调用点，而接管的前置
// 条件是「进程名是旧名」—— 真实升级路径里进程名全是新名：
//   POSIX `clawmessenger` 壳脚本 `exec agentsbb`、Windows 兼容副本转发给
//   `agentsbb.exe`、npm 全局升级、手动覆盖安装，全都拿不到旧名。
// 症状极具欺骗性：日志已经写进 `~/.agentsbb/logs`，界面却说 `not registered`。
//
// 这一组用例**真跑入口**（tsc 编译到临时目录后 `node bin.js status`），因为要守的
// 正是「入口有没有调用它」，用 paths.ts 的单测是守不住的。
// ---------------------------------------------------------------------------
describe("状态目录迁移在启动链上无条件执行（QA 回归 P1）", () => {
  let buildDir: string;
  let binPath: string;

  beforeAll(() => {
    // 落点必须在包目录内：`node <file>` 解析 `commander` 这类裸模块是从文件位置
    // 向上找 node_modules，放到 OS 临时目录会直接 ERR_MODULE_NOT_FOUND。
    const distRoot = join(pkgRoot, "dist");
    mkdirSync(distRoot, { recursive: true });
    buildDir = join(distRoot, `.bin-test-${process.pid}`);
    // 目录名带 pid 是为了并发跑不互相踩；代价是进程被 SIGPIPE/超时打断时 afterAll
    // 不会执行，会留下垃圾。这里顺手回收超过半小时的陈旧目录 —— 一次性清理所有
    // `.bin-test-*` 会误删另一个正在跑的用例的产物，所以按 mtime 判。
    for (const name of readdirSync(distRoot)) {
      if (!name.startsWith(".bin-test-") || name === basename(buildDir)) continue;
      const stale = join(distRoot, name);
      try {
        if (Date.now() - statSync(stale).mtimeMs > 30 * 60_000) {
          rmSync(stale, { recursive: true, force: true });
        }
      } catch {
        // 别的进程正在清理同一份：忽略
      }
    }
    const tsc = join(pkgRoot, "..", "..", "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) throw new Error(`typescript 编译器不在预期位置: ${tsc}`);
    rmSync(buildDir, { recursive: true, force: true });
    const built = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", buildDir], {
      cwd: pkgRoot,
      encoding: "utf8",
    });
    if (built.status !== 0) {
      throw new Error(`tsc 编译失败（status ${built.status}）:\n${built.stdout}\n${built.stderr}`);
    }
    // 编译产物在包内、但不在包目录这一层：附近没有 package.json 的 `.js` 会被
    // Node 当成 CJS，`import` 直接语法错误。补一个 type: module 让产物按 ESM 跑。
    writeFileSync(join(buildDir, "package.json"), '{"type":"module"}\n', "utf8");
    binPath = join(buildDir, "bin.js");
    if (!existsSync(binPath)) throw new Error(`tsc 未产出 ${binPath}`);
  }, 120_000);

  afterAll(() => {
    rmSync(buildDir, { recursive: true, force: true });
  });

  /** 造一个「存量设备」的 HOME：只有旧的 .clawmessenger，没有 .agentsbb。 */
  function legacyDeviceHome(nodeId: string): { home: string; legacyDir: string; creds: string } {
    const home = mkdtempSync(join(tmpdir(), "agentsbb-bin-home-"));
    const legacyDir = join(home, ".clawmessenger");
    mkdirSync(legacyDir, { recursive: true });
    // 文件名/形状照 config.ts 的 defaultKeystorePath + Keystore 的真实契约，
    // 不编一个假名字 —— 否则「读到了没」这件事根本没被验证。
    const creds = JSON.stringify(
      { nodeId, token: "tok-1", serverUrl: "https://example.invalid" },
      null,
      2,
    );
    writeFileSync(join(legacyDir, "credentials.json"), creds, "utf8");
    writeFileSync(join(legacyDir, "answered-turns-abc.json"), '{"turns":[]}', "utf8");
    return { home, legacyDir, creds };
  }

  /** 以「只有 HOME 指向临时目录」的干净环境跑真实入口。 */
  function runBin(home: string, args: string[] = ["status"]) {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    // 显式 home 会让迁移短路（paths.ts 的策略），必须清掉，否则测的是另一条路。
    for (const key of ["AGENTSBB_HOME", "CLAWMESSENGER_HOME", "AGENTSBB_AGENT_CREDS", "CLAWMESSENGER_AGENT_CREDS"]) {
      delete env[key];
    }
    return spawnSync(process.execPath, [binPath, ...args], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("首次启动就把 ~/.clawmessenger 复制成 ~/.agentsbb，并真的读到了旧凭据", () => {
    const { home, legacyDir, creds } = legacyDeviceHome("qa-node-1");
    try {
      const run = runBin(home);
      const newDir = join(home, ".agentsbb");

      // 1) 目录被建出来（QA 现场就是「从没被创建」）。
      expect(existsSync(newDir)).toBe(true);
      // 2) keystore 内容逐字一致。
      expect(readFileSync(join(newDir, "credentials.json"), "utf8")).toBe(creds);
      // 3) 其它状态文件也一起搬（不是只挑 keystore）。
      expect(existsSync(join(newDir, "answered-turns-abc.json"))).toBe(true);
      // 4) 迁移 marker 落地（幂等与审计的依据）。
      expect(existsSync(join(newDir, ".migrated-from-clawmessenger.json"))).toBe(true);
      // 5) 旧目录原样保留 = 回滚路径。
      expect(readFileSync(join(legacyDir, "credentials.json"), "utf8")).toBe(creds);
      // 6) **行为证据**：命令真的读到了凭据，而不是「目录有了、数据没读」。
      expect(run.stdout).toContain("node: qa-node-1");
      // 7) 告知用户数据搬走了（stderr，不污染 stdout 的版本闸门）。
      expect(run.stderr).toContain("moved your data");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("二次启动不重复复制（不覆盖新目录里已经变新的数据）", () => {
    const { home, legacyDir } = legacyDeviceHome("qa-node-legacy");
    try {
      const first = runBin(home);
      expect(first.stdout).toContain("node: qa-node-legacy");
      const newDir = join(home, ".agentsbb");
      const markerBefore = readFileSync(join(newDir, ".migrated-from-clawmessenger.json"), "utf8");

      // 模拟「迁移之后用户又 pair 了一次」：新目录里的凭据已经变了。
      const newer = JSON.stringify(
        { nodeId: "qa-node-new", token: "tok-2", serverUrl: "https://example.invalid" },
        null,
        2,
      );
      writeFileSync(join(newDir, "credentials.json"), newer, "utf8");

      const second = runBin(home);
      // 目录已存在 → 直接 no-op，绝不用旧目录的内容盖回去。
      expect(readFileSync(join(newDir, "credentials.json"), "utf8")).toBe(newer);
      expect(second.stdout).toContain("node: qa-node-new");
      // marker 没被重写（说明没走第二次迁移）。
      expect(readFileSync(join(newDir, ".migrated-from-clawmessenger.json"), "utf8")).toBe(markerBefore);
      // 第二次不该再提示「搬完了」。
      expect(second.stderr).not.toContain("moved your data");
      // 旧目录始终不动。
      expect(existsSync(join(legacyDir, "credentials.json"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("显式 AGENTSBB_HOME 时不迁移（测试/运维语义不变）", () => {
    const { home, legacyDir } = legacyDeviceHome("qa-node-legacy");
    const explicit = mkdtempSync(join(tmpdir(), "agentsbb-bin-explicit-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTSBB_HOME: explicit,
      };
      const run = spawnSync(process.execPath, [binPath, "status"], { env, encoding: "utf8", timeout: 60_000 });
      // 指定了 home 就只建目录、不搬数据：旧凭据不会被读进来。
      expect(existsSync(join(explicit, "credentials.json"))).toBe(false);
      expect(existsSync(join(home, ".agentsbb"))).toBe(false);
      expect(run.stdout).toContain("not registered");
      expect(existsSync(join(legacyDir, "credentials.json"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(explicit, { recursive: true, force: true });
    }
  });
});
