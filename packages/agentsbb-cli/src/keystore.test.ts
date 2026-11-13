// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Keystore,
  LEGACY_SERVER_URLS,
  migrateServerUrl,
  normalizeServerUrl,
  planServerUrlMigration,
  type StoredCredentials,
} from "./keystore.js";
import { DEFAULT_SERVER_URL } from "./config.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agentsbb-keystore-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

describe("Keystore", () => {
  it("round-trips credentials", () => {
    const ks = new Keystore(join(tempDir(), "creds.json"));
    expect(ks.load()).toBeNull();
    ks.save({ nodeId: "node_abc", token: "tok", serverUrl: "http://x" });
    const loaded = ks.load();
    expect(loaded?.nodeId).toBe("node_abc");
    expect(loaded?.token).toBe("tok");
  });

  it("writes file with 0600 permissions", () => {
    const dir = tempDir();
    const ks = new Keystore(join(dir, "creds.json"));
    ks.save({ nodeId: "n", token: "t", serverUrl: "http://x" });
    const mode = (statSyncPermissions(join(dir, "creds.json")) & 0o777).toString(8);
    expect(["600", "666"]).toContain(mode); // Windows falls back to default ACLs
  });
});

function statSyncPermissions(p: string): number {
  return statSync(p).mode;
}

// ── 旧主域名迁移 ───────────────────────────────────────────────────────────
// 背景：`serverUrl` 是持久化的运行时值。CLI 的 `--server` / `DEFAULT_SERVER_URL`
// 一改只影响**新注册**，存量设备升级后仍在读磁盘上的旧域名，而旧域名已下线 →
// 存量设备全部失联。下面这组用例钉的就是「升级即自动迁移」这条命脉。

const LEGACY = LEGACY_SERVER_URLS[0];

/** 捕获 stderr（迁移提示只允许走这里，stdout 有协议语义）。 */
function spyStderr(): { text: () => string } {
  let out = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  return { text: () => out };
}

function seed(path: string, creds: Partial<StoredCredentials>): void {
  writeFileSync(path, JSON.stringify(creds, null, 2), "utf8");
}

describe("Keystore legacy server url migration", () => {
  it("rewrites a retired domain and persists it", () => {
    const path = join(tempDir(), "creds.json");
    seed(path, { nodeId: "node_1", token: "tok", serverUrl: LEGACY });
    const stderr = spyStderr();

    const creds = new Keystore(path).load();

    expect(creds?.serverUrl).toBe(DEFAULT_SERVER_URL);
    // 落盘：再读一次磁盘文件，必须是新域名（不是只在内存里改了）
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as StoredCredentials;
    expect(onDisk.serverUrl).toBe(DEFAULT_SERVER_URL);
    // 其他字段一个都不能丢
    expect(onDisk.nodeId).toBe("node_1");
    expect(onDisk.token).toBe("tok");
    expect(stderr.text()).toContain("migrated server:");
    expect(stderr.text()).toContain(LEGACY);
    expect(stderr.text()).toContain(DEFAULT_SERVER_URL);
  });

  it("is idempotent: a credential already on the new domain is not rewritten", () => {
    const path = join(tempDir(), "creds.json");
    const ks = new Keystore(path);
    ks.save({ nodeId: "node_1", token: "tok", serverUrl: DEFAULT_SERVER_URL });
    const before = readFileSync(path, "utf8");
    const saveSpy = vi.spyOn(ks, "save");
    const stderr = spyStderr();

    const creds = ks.load();

    expect(creds?.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(saveSpy).not.toHaveBeenCalled(); // 零副作用：不重复写盘
    expect(stderr.text()).not.toContain("migrated server:"); // 也不刷屏
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("survives a credential without serverUrl (no crash, no write)", () => {
    const path = join(tempDir(), "creds.json");
    seed(path, { nodeId: "node_1", token: "tok" });
    const ks = new Keystore(path);
    const saveSpy = vi.spyOn(ks, "save");

    const creds = ks.load();

    expect(creds?.nodeId).toBe("node_1");
    expect(creds?.serverUrl).toBeUndefined();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("degrades to in-memory migration when the write fails (never throws)", () => {
    const path = join(tempDir(), "creds.json");
    seed(path, { nodeId: "node_1", token: "tok", serverUrl: LEGACY });
    const ks = new Keystore(path);
    vi.spyOn(ks, "save").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    const stderr = spyStderr();

    expect(() => ks.load()).not.toThrow();
    const creds = ks.load();
    // 本次照样用新域名跑
    expect(creds?.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(stderr.text()).toContain("could not persist migrated server url");
    expect(stderr.text()).toContain("EACCES");
  });

  it("matches case and trailing-slash variants of the retired domain", () => {
    const variants = [
      "HTTPS://ClawMessenger.Quukk.COM",
      "https://clawmessenger.quukk.com/",
      "https://clawmessenger.quukk.com///",
      "  https://clawmessenger.quukk.com  ",
    ];
    for (const serverUrl of variants) {
      const path = join(tempDir(), "creds.json");
      seed(path, { nodeId: "node_1", token: "tok", serverUrl });
      const creds = new Keystore(path).load();
      expect(creds?.serverUrl, `variant: ${serverUrl}`).toBe(DEFAULT_SERVER_URL);
    }
  });

  it("leaves a custom --server untouched (self-hosted / local dev)", () => {
    const custom = "http://127.0.0.1:8080";
    const path = join(tempDir(), "creds.json");
    const ks = new Keystore(path);
    ks.save({ nodeId: "node_1", token: "tok", serverUrl: custom });
    const saveSpy = vi.spyOn(ks, "save");
    const stderr = spyStderr();

    expect(ks.load()?.serverUrl).toBe(custom);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(stderr.text()).not.toContain("migrated server:");
  });

  it("does not auto-migrate a retired domain that carries a path prefix, but says so", () => {
    // 按 host 迁会把这台测试设备静默指到生产；宁可漏迁 + 点名。
    const withPrefix = `${LEGACY}/im-test`;
    const path = join(tempDir(), "creds.json");
    const ks = new Keystore(path);
    ks.save({ nodeId: "node_1", token: "tok", serverUrl: withPrefix });
    const saveSpy = vi.spyOn(ks, "save");
    const stderr = spyStderr();

    expect(ks.load()?.serverUrl).toBe(withPrefix);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(stderr.text()).toContain("retired host and carries a path prefix");
  });
});

describe("migrateServerUrl (env credentials path)", () => {
  it("rewrites the retired domain in memory without touching the keystore", () => {
    spyStderr();
    const creds: StoredCredentials = { nodeId: "n", token: "t", serverUrl: LEGACY };
    const migrated = migrateServerUrl(creds);
    expect(migrated).not.toBe(creds); // 新对象，调用方可用引用判断
    expect(migrated.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(creds.serverUrl).toBe(LEGACY); // 入参不被就地改
  });

  it("returns the same object when nothing needs migrating", () => {
    const creds: StoredCredentials = { nodeId: "n", token: "t", serverUrl: DEFAULT_SERVER_URL };
    expect(migrateServerUrl(creds)).toBe(creds);
  });
});

describe("normalizeServerUrl / planServerUrlMigration", () => {
  it("normalizes only for comparison", () => {
    expect(normalizeServerUrl(" HTTPS://A.Example.COM/// ")).toBe("https://a.example.com");
  });

  it("plans a migration only on an exact (normalized) legacy hit", () => {
    expect(planServerUrlMigration({ serverUrl: `${LEGACY}/` })?.to).toBe(DEFAULT_SERVER_URL);
    expect(planServerUrlMigration({ serverUrl: "https://example.com" })).toBeNull();
    expect(planServerUrlMigration({})).toBeNull();
    expect(planServerUrlMigration(null)).toBeNull();
  });
});
