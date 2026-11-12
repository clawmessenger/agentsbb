import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProgram, commanderExit } from "./main.js";
import { Keystore } from "./keystore.js";
import { XiachatApi } from "./api.js";
import { defaultKeystorePath } from "./config.js";
import { ensureInstalled, isLegacyExeName, isSeaExecutable, takeOverLegacy, upgradeTargetPath, type InstallResult } from "./install.js";
import { applyStagedUpdate, cleanupStaleBackups, healInstall } from "./self-update.js";
import { ensureStateHome, LEGACY_HOME_DIR } from "./paths.js";

// ---------------------------------------------------------------- 旧名兼容转发
//
// Windows 上的兼容副本（`%LOCALAPPDATA%\agentsbb\clawmessenger.exe`，见
// install.ts writeLegacyCompatEntry）就是新版 exe 的字节拷贝：进程被叫
// `clawmessenger` 时，先打印双语弃用警告，再把同一份参数转发给同目录的
// `agentsbb.exe`。判定依据：**同目录存在 agentsbb(.exe)** —— 旧安装目录
// （%LOCALAPPDATA%\clawmessenger）里不会有这个文件，那种情况走的是下面的
// takeOverLegacy 接管，而不是转发。
// TODO(rebrand-retire): 垫片 v1.6.0 退役时删除本段
if (process.platform === "win32" && isLegacyExeName(process.execPath, process.platform)) {
  const sibling = path.join(
    path.dirname(process.execPath),
    "agentsbb.exe",
  );
  if (existsSync(sibling)) {
    process.stderr.write(
      "警告：clawmessenger 命令已更名为 agentsbb，本入口将在未来一至两个版本移除。\n" +
      "Warning: the 'clawmessenger' command has been renamed to 'agentsbb'; this shim will be removed in an upcoming release.\n",
    );
    const forwarded = spawnSync(sibling, process.argv.slice(1), { stdio: "inherit", windowsHide: true });
    process.exit(forwarded.status ?? 1);
  }
}

// ---------------------------------------------------------------- 状态目录迁移
//
// 存量设备（v≤1.3.33）的数据在 `~/.clawmessenger`；改名后一切读写都走
// `~/.agentsbb`（paths.ts 的 stateHome）。这一步**无条件**执行，且必须早于任何
// 状态读写（keystore、user-models、answered-turns、logs…）。
//
// 为什么不能挂在「进程名是旧名」上（QA 回归 P1，真跑复现）：
// 真实升级路径里进程名几乎都是**新名**，四种路径全都拿不到旧名 ——
//   - POSIX `~/.local/bin/clawmessenger` 是 `exec agentsbb` 的壳脚本；
//   - Windows 兼容副本 `clawmessenger.exe` 转发给同级 `agentsbb.exe`；
//   - npm 全局升级、手动覆盖安装更不用说。
// 挂条件的结果就是「日志已经写进 ~/.agentsbb/logs、界面却说 not registered」，
// 因为旧 keystore 从未被读。
//
// 与 takeOverLegacy() 的分工：那边只管 exe / 服务名 / 旧自启的交接，用
// `.took-over-legacy-install.json` 做幂等；这里只管数据搬家，幂等靠
// `.migrated-from-clawmessenger.json`（见 paths.ts）。两者互不依赖，
// 所以「不是旧 exe 名」不再是迁移的前置条件。
//
// 幂等且廉价：目录已存在 → 立刻返回，零 IO。失败则回退旧目录并把决定钉进 env
// （paths.ts 里做），本进程后续读取与子进程都落在旧目录，下一轮启动重试。
let stateMigrationNote: string | null = null;
try {
  const migration = ensureStateHome();
  if (migration.migrated) {
    // stderr：stdout 只留给命令输出（发布流水线的版本闸门读它）。
    stateMigrationNote =
      `agentsbb: moved your data to ${migration.home} ` +
      `(the old ~/${LEGACY_HOME_DIR} is left untouched — it is your rollback path).\n`;
  }
} catch {
  // 迁移本身永不因为「读不到 home」而挡住启动：paths.ts 内部已兜底，
  // 这里再兜一层，保证入口在任何磁盘状态下都能进命令解析。
  stateMigrationNote = null;
}
if (stateMigrationNote) process.stderr.write(stateMigrationNote);

// A staged update — downloaded and checksum-verified by `agentsbb update`
// on an earlier run — is swapped in here, before anything else starts. The
// current process keeps executing the image it already mapped; every process
// started afterwards (including the agents the supervisor spawns) runs the new
// version. Renaming the live exe is what makes this possible on Windows, where
// an in-place overwrite is refused with EBUSY.
let stagedVersion: string | null = null;
try {
  if (isSeaExecutable(process.argv[1])) {
    // 落点必须是**正在运行的自己**（`process.execPath`），不能按平台猜 ——
    // 与手动 `update`、服务端下发升级共用 upgradeTargetPath 这一个判定。
    // 按 installPaths 猜会在 Linux 上直接猜错：systemd 的 unit 可能指向
    // /usr/local/bin，而 installPaths 给的是 ~/.local/bin，于是暂存文件落在
    // 没人运行的那份旁边，每次启动都「什么也没有」，升级静默失效。判定细节
    // 与理由见 install.ts 的 upgradeTargetPath。
    const target = upgradeTargetPath(
      process.platform,
      process.argv[1],
      process.execPath,
      os.homedir(),
    );
    // 自愈先于交换：升级的交换是两步 rename（旧 → .old-<ts>、新 → target），
    // 中间 target 会短暂不存在。断电停在那一步之后，登录自启的 VBS 会找不到
    // exe 而静默失败 —— 设备就此离线。这里（以及 __relaunch）把 target 补回来。
    const healed = healInstall(target);
    if (healed.healed) {
      process.stderr.write(
        `agentsbb: restored ${target} from ${healed.staged ?? healed.from ?? "a backup"}\n`,
      );
    }
    const applied = applyStagedUpdate(target, process.platform);
    if (applied.applied) stagedVersion = applied.version ?? null;
    cleanupStaleBackups(target);
  }
} catch {
  // Update bookkeeping must never block normal operation.
}

// Single-file exe: best-effort per-user install (copy + PATH) on first run.
// Quiet no-op when already installed or running under `node` in dev.
let installNote: InstallResult | null = null;
try {
  installNote = ensureInstalled();
} catch {
  installNote = null;
}

// ---------------------------------------------------------------- 旧安装接管
//
// 一次性接管（design §2.4 触发点 B）：本进程仍跑在旧文件名 clawmessenger(.exe)
// 下（旧版自更新把 agentsbb 字节换进了旧路径），且接管 marker 尚不存在 ——
// 迁移配置目录、确认新 target 就位、以新名重注册自启、清理旧自启，然后写
// marker 保证本分支永不重入（防升级死循环的关键）。串行在 parseAsync 之前：
// 接管会重注册自启/重启 supervisor，不能与命令执行并发。
// （用 promise 链而非顶层 await：esbuild 的 CJS 产物不允许顶层 await。）
// TODO(rebrand-retire): 接管分支移除于 v1.6+
const takeover: Promise<unknown> =
  isSeaExecutable(process.argv[1]) && isLegacyExeName(process.execPath, process.platform)
    ? takeOverLegacy().catch(() => undefined)
    : Promise.resolve();

const program = buildProgram({
  keystore: new Keystore(defaultKeystorePath()),
  apiFactory: (serverUrl) => new XiachatApi(serverUrl),
  stdout: process.stdout,
});

takeover.then(() => program.parseAsync(process.argv)).catch((err: unknown) => {
  // `.exitOverride()` 让 commander 用抛异常代替 process.exit（测试要在进程内 parse）。
  // 生产入口必须把这类异常翻译回**正确的**退出码：`--version` / `--help` 是成功，
  // 不是错误（否则 `agentsbb --version` 打印版本却 exit 1，发布流水线的版本
  // 校验永远失败，而且版本号会被重复打到 stderr）。
  const translated = commanderExit(err);
  if (translated) {
    if (translated.printMessage) console.error(err instanceof Error ? err.message : err);
    process.exitCode = translated.exitCode;
    return;
  }
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

// After the command finishes (or when commander prints help and the parse
// promise resolves), tell the user where the binary now lives.
//
// 这两条通知走 **stderr**：stdout 只留给命令本身的输出。发布流水线里
// `actual="$("<exe>" --version | tail -n1)"` 要拿最后一行当版本号，而首次运行时
// 这两条通知恰好打在版本号之后 —— 留在 stdout 就会让流水线读到 "Open a NEW
// terminal window…" 并据此判定「产物版本不对」，把一个正确的包拦下来。
if (installNote && (installNote.copied || installNote.pathAdded)) {
  const what = [installNote.copied ? "copied itself to " + installNote.target : null,
    installNote.pathAdded ? "added it to your user PATH" : null].filter(Boolean).join(" and ");
  process.stderr.write(
    `\nagentsbb: ${what}.\n` +
    `Open a NEW terminal window and run \`agentsbb\` from anywhere.\n`,
  );
}

if (stagedVersion) {
  process.stderr.write(
    `\nagentsbb: update ${stagedVersion} is now on disk; ` +
    `it takes effect the next time the supervisor starts.\n`,
  );
}
