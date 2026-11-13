/**
 * Deprecated `clawmessenger` entry point — forwards to `agentsbb` with a
 * bilingual deprecation warning.
 *
 * Lifecycle (PRD decision): kept for one to two releases, removed in v1.6.0
 * together with the `bin` entry in package.json. The message below is the only
 * place that tells users the deadline, so when the shim is deleted this
 * comment goes with it.
 *
 * Why forward instead of re-running the CLI logic in-process: the real binary
 * may have been swapped or updated since this shim was invoked (self-update
 * replaces files on disk); spawning the current `agentsbb` entry guarantees
 * the user always talks to the up-to-date implementation.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

/** Printed before every forwarded invocation (bilingual, per PRD). */
export function deprecationNotice(): string {
  return (
    "警告：clawmessenger 命令已更名为 agentsbb，本入口将在未来一至两个版本（v1.6.0 前后）移除。\n" +
    "Warning: the 'clawmessenger' command has been renamed to 'agentsbb'; this shim will be removed in an upcoming release.\n"
  );
}

/** The script/exe that actually implements the CLI, resolved from this shim's location. */
function cliEntry(): string {
  // SEA: the shim is compiled into the same exe family; spawn the real exe
  // by name so PATH resolution picks the installed copy.
  return "agentsbb";
}

function scriptEntry(): string {
  // node dist/shim.js → node dist/bin.js in the same directory.
  return path.join(path.dirname(process.argv[1] ?? "."), "bin.js");
}

/**
 * Forward `argv.slice(1)` (the arguments after the shim name) to agentsbb and
 * exit with its status. In SEA mode self is the exe; under node we re-spawn
 * node on the sibling bin.js so dev workflows (`node dist/shim.js ...`) work.
 */
export function runShim(argv: string[] = process.argv): number {
  process.stderr.write(deprecationNotice());
  const args = argv.slice(2);
  const isSea = !/\.(c|m)?js$/i.test(argv[1] ?? "");
  if (isSea) {
    // argv[1] is the exe itself; forward everything after it.
    const forwarded = argv.slice(2).length > 0 ? argv.slice(2) : argv.slice(1);
    const res = spawnSync(cliEntry(), forwarded, { stdio: "inherit", shell: false });
    return res.status ?? 1;
  }
  const res = spawnSync(process.execPath, [scriptEntry(), ...args], { stdio: "inherit" });
  return res.status ?? 1;
}

// Invoked as the package bin: run and forward the exit code.
if (process.argv[1] && /shim\.(c|m)?js$/i.test(process.argv[1])) {
  process.exitCode = runShim();
}
