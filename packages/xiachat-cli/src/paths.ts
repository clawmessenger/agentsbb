/**
 * State-directory paths — the single source of truth for "where the CLI keeps
 * its per-user data" and the `~/.clawmessenger` → `~/.agentsbb` migration.
 *
 * Why a module (and not scattered `join(homedir(), ".clawmessenger", ...)`
 * calls): the rebrand moves the state directory once and every call site must
 * see the *same* decision (migrate? fall back?). Keeping the rules here means
 * the migration marker, the fallback policy and the env-var override semantics
 * are testable in one place.
 *
 * Migration policy (design §2.1 — do not change without re-reading it):
 *   - Copy the whole legacy directory, never rename it. Old-version
 *     supervisors / watchdogs may still hold file handles inside
 *     `~/.clawmessenger` and keep writing there; a rename (especially across
 *     volumes) breaks them. Copying also keeps the legacy directory as a
 *     natural rollback path for users who go back to an old exe.
 *   - `AGENTSBB_HOME` (or legacy `CLAWMESSENGER_HOME`) explicitly set → use it
 *     verbatim, never migrate. That preserves test / ops semantics.
 *   - Copy failure (permissions, disk full, locked file) → fall back to the
 *     legacy directory this run; the migration is retried on the next start.
 *   - After a successful migration the legacy directory is never read again
 *     (avoids two diverging copies of user-models etc.).
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Legacy per-user state directory (v≤1.3.33). Kept for migration only. */
// TODO(rebrand-retire): 移除于 v1.6+ —— 旧目录只读沉寂后此常量与迁移逻辑一并删除。
export const LEGACY_HOME_DIR = ".clawmessenger";

/** Current per-user state directory. */
export const HOME_DIR = ".agentsbb";

/** Written into the new directory after a successful migration; idempotence + audit. */
export const MIGRATION_MARKER = ".migrated-from-clawmessenger.json";

/** Marker written by install.ts once the legacy *install* has been taken over. */
export const TAKEOVER_MARKER = ".took-over-legacy-install.json";

/**
 * State directory for this run.
 *
 * Dual-read of the env override: a legacy supervisor spawns new processes with
 * the old variable name, so the new name wins but the old one still answers.
 * Explicitly set (either name) → used verbatim, no migration.
 */
export function stateHome(env: NodeJS.ProcessEnv = process.env, homedirFn: () => string = homedir): string {
  // TODO(rebrand-retire): 双读过渡，移除 CLAWMESSENGER_HOME 于 v1.6+
  const override = env.AGENTSBB_HOME ?? env.CLAWMESSENGER_HOME;
  if (override) return override;
  return join(homedirFn(), HOME_DIR);
}

/** The legacy state directory (used by migration and fallback only). */
export function legacyStateHome(homedirFn: () => string = homedir): string {
  return join(homedirFn(), LEGACY_HOME_DIR);
}

export interface MigrationResult {
  /** The state directory this run should use. */
  home: string;
  /** True when the legacy directory was copied into place this run. */
  migrated: boolean;
  /** True when migration failed and we fell back to the legacy directory. */
  fellBackToLegacy: boolean;
}

type CopyFn = typeof cpSync;

/**
 * Make sure the state directory exists, migrating from `~/.clawmessenger` on
 * first run. Idempotent: existing directory → no-op; marker → migration has
 * already happened (a directory could also exist for other reasons, e.g. the
 * copy succeeded but the marker write failed — re-running the copy is harmless
 * thanks to `force: false`).
 */
export function ensureStateHome(
  env: NodeJS.ProcessEnv = process.env,
  homedirFn: () => string = homedir,
  copyFn: CopyFn = cpSync,
): MigrationResult {
  const home = stateHome(env, homedirFn);
  if (existsSync(home)) return { home, migrated: false, fellBackToLegacy: false };
  const fallback = (): MigrationResult => {
    mkdirSync(home, { recursive: true });
    return { home, migrated: false, fellBackToLegacy: false };
  };
  // Explicit env override (tests / ops) → never migrate; just create it.
  // TODO(rebrand-retire): 双读过渡，移除 CLAWMESSENGER_HOME 于 v1.6+
  if (env.AGENTSBB_HOME || env.CLAWMESSENGER_HOME) return fallback();
  const legacy = legacyStateHome(homedirFn);
  if (!existsSync(legacy)) return fallback();

  // First-run migration: copy the whole directory (never rename, never delete).
  // mkdir 先行：新目录路径本身建不出来（占位文件、权限、磁盘满）也按「迁移失败」
  // 处理，回退旧目录继续服务，下一轮启动重试。
  try {
    mkdirSync(home, { recursive: true });
    // `force: false` + `errorOnExist: false` = merge-copy that never overwrites:
    // a previous partial migration (marker write failed) completes without
    // clobbering anything new files the user already created.
    copyFn(legacy, home, { recursive: true, force: false, errorOnExist: false });
    writeFileSync(
      join(home, MIGRATION_MARKER),
      JSON.stringify({
        from: legacy,
        at: new Date().toISOString(),
        cliVersion: process.env.AGENTSBB_VERSION ?? process.env.CLAWMESSENGER_VERSION ?? "",
      }, null, 2) + "\n",
      { mode: 0o600 },
    );
    // Transient files (pid / lock) copying over is harmless: findLiveSupervisor
    // re-checks liveness with isAlive(pid) before trusting them.
    return { home, migrated: true, fellBackToLegacy: false };
  } catch (err) {
    // Copy failed (permissions / disk full / locked file) → keep serving from
    // the legacy directory this run; the migration retries on the next start.
    console.warn(
      `agentsbb: migrating state dir from ${legacy} to ${home} failed, falling back to the legacy directory:`,
      err instanceof Error ? err.message : err,
    );
    return { home: legacy, migrated: false, fellBackToLegacy: true };
  }
}
