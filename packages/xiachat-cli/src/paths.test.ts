import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureStateHome,
  HOME_DIR,
  LEGACY_HOME_DIR,
  MIGRATION_MARKER,
  legacyStateHome,
  stateHome,
  TAKEOVER_MARKER,
} from "./paths.js";

// 迁移是「复制而非 rename」：旧 supervisor 可能还握着旧目录里的句柄并在写盘，
// rename（尤其跨卷）会直接炸掉旧进程。这里的用例把三条关键语义钉死：
//   1. 显式环境变量（新名或旧名）→ 直接用，永不迁移；
//   2. 无旧目录 → 新目录静默创建；
//   3. 有旧目录 → 整目录复制 + marker 落地，旧目录原样保留；
//   4. 复制失败 → 回退旧目录继续服务（可用性优先于命名洁癖）。
describe("paths: state dir migration", () => {
  let home: string;
  let legacyHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentsbb-paths-"));
    legacyHome = join(home, "user", LEGACY_HOME_DIR);
    mkdirSync(join(home, "user"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("stateHome defaults to ~/.agentsbb without any env override", () => {
    const dir = stateHome({});
    expect(dir.endsWith(HOME_DIR)).toBe(true);
  });

  it("honours AGENTSBB_HOME and never migrates an explicit override", () => {
    const override = join(home, "explicit-new");
    const result = ensureStateHome({ AGENTSBB_HOME: override });
    expect(result.home).toBe(override);
    expect(result.migrated).toBe(false);
    expect(existsSync(override)).toBe(true);
  });

  it("dual-reads the legacy CLAWMESSENGER_HOME override during the transition", () => {
    // TODO(rebrand-retire): 旧变量随双读机制一起移除
    const override = join(home, "explicit-legacy-env");
    const result = ensureStateHome({ CLAWMESSENGER_HOME: override });
    expect(result.home).toBe(override);
    expect(existsSync(override)).toBe(true);
  });

  it("creates a fresh dir when no legacy dir exists", () => {
    const result = ensureStateHome({}, () => join(home, "user"));
    expect(result.migrated).toBe(false);
    expect(result.fellBackToLegacy).toBe(false);
    expect(result.home.endsWith(HOME_DIR)).toBe(true);
    expect(existsSync(result.home)).toBe(true);
  });

  it("migrates by COPYING the legacy dir (legacy dir left untouched, marker written)", () => {
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "credentials.json"), "{}", "utf8");
    writeFileSync(join(legacyHome, "user-models-a.json"), "{}", "utf8");

    const result = ensureStateHome({}, () => join(home, "user"));

    expect(result.migrated).toBe(true);
    expect(result.fellBackToLegacy).toBe(false);
    // 旧目录原样保留（回滚路径）：旧 exe 退回去还能用。
    expect(existsSync(join(legacyHome, "credentials.json"))).toBe(true);
    // 新目录拿到全部内容。
    expect(existsSync(join(result.home, "credentials.json"))).toBe(true);
    expect(existsSync(join(result.home, "user-models-a.json"))).toBe(true);
    // marker 落地且记录来源（审计）。
    const marker = JSON.parse(readFileSync(join(result.home, MIGRATION_MARKER), "utf8")) as { from: string; at: string };
    expect(marker.from).toBe(legacyStateHome(() => join(home, "user")));
    expect(typeof marker.at).toBe("string");
    // TODO(rebrand-retire): 旧目录名常量随迁移逻辑一起移除
    expect(marker.from.includes(LEGACY_HOME_DIR)).toBe(true);
  });

  it("does not overwrite newer files when re-running a partial migration", () => {
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "a.json"), "legacy", "utf8");
    const first = ensureStateHome({}, () => join(home, "user"));
    expect(first.migrated).toBe(true);
    // 新目录已经产生新文件；再跑一次（marker 丢失的假设场景）不得覆盖它。
    writeFileSync(join(first.home, "a.json"), "newer", "utf8");
    writeFileSync(join(legacyHome, "a.json"), "legacy-v2", "utf8");
    const second = ensureStateHome({}, () => join(home, "user"));
    // 目录已存在 → 直接 no-op，绝不去碰旧目录。
    expect(second.migrated).toBe(false);
    expect(readFileSync(join(second.home, "a.json"), "utf8")).toBe("newer");
  });

  it("falls back to the legacy dir when the copy fails, so the device keeps working", () => {
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "credentials.json"), "{}", "utf8");
    const result = ensureStateHome({}, () => join(home, "user"), () => {
      throw new Error("EPERM: locked by the legacy supervisor");
    });
    expect(result.fellBackToLegacy).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.home).toBe(legacyStateHome(() => join(home, "user")));
    // 旧目录里的凭据原样可用（本机继续服务）。
    expect(existsSync(join(legacyHome, "credentials.json"))).toBe(true);
  });
});

describe("paths: takeover marker constant", () => {
  it("uses a hidden dotfile marker so it ships with the migrated state dir", () => {
    expect(TAKEOVER_MARKER.startsWith(".")).toBe(true);
    expect(existsSync("/nonexistent-marker-check")).toBe(false);
  });
});
