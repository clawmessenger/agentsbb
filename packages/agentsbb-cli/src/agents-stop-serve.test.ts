import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopServeProcess, withServeSerial } from "./agents.js";

/**
 * 假的 serve 子进程：只有 stopServeProcess 真正用到的那几个面 ——
 * `kill(signal)`、`exitCode` / `signalCode`、`once/off("exit")`。
 *
 * `exitOnKill` 控制它收到 SIGTERM 后是立刻退出（优雅收尾），还是根本不
 * 理你（现场那种「SIGTERM 之后还在 drain，跟下一轮抢数据目录」）。
 */
function fakeServe(opts: { exitOnKill?: boolean; exited?: boolean } = {}) {
  const ee = new EventEmitter();
  const signals: NodeJS.Signals[] = [];
  const child = {
    pid: 4242,
    exitCode: opts.exited ? 0 : null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      signals.push(signal);
      if (opts.exitOnKill !== false) {
        child.exitCode = 0;
        queueMicrotask(() => ee.emit("exit", 0, null));
      }
      return true;
    },
    once: ee.once.bind(ee),
    off: ee.off.bind(ee),
    on: ee.on.bind(ee),
    emit: ee.emit.bind(ee),
  };
  return { child: child as unknown as ChildProcess, childRef: child, signals };
}

describe("stopServeProcess", () => {
  // 用例跑在 POSIX 语义上：killProcessTree 在 win32 走 taskkill，假进程感知不到。
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("已经退出的进程不再发信号", async () => {
    const { child, signals } = fakeServe({ exited: true });

    await stopServeProcess(child, 20);

    expect(signals).toEqual([]);
  });

  it("SIGTERM 后立刻退出的进程：等它 exit 就返回，不再 SIGKILL", async () => {
    const { child, signals } = fakeServe({ exitOnKill: true });

    await stopServeProcess(child, 20);

    expect(signals).toEqual(["SIGTERM"]);
    expect(child.exitCode).toBe(0);
  });

  it("不理 SIGTERM 的进程：宽限期过后 SIGKILL，并等它落地", async () => {
    // 现场那种「SIGTERM 之后还在 drain」的 serve：必须被打死，否则下一轮和它
    // 抢同一份 opencode 数据目录，整轮零输出直到回合超时。
    const { child, childRef, signals } = fakeServe({ exitOnKill: false });
    const originalKill = childRef.kill;
    childRef.kill = (signal: NodeJS.Signals = "SIGTERM") => {
      const ok = originalKill(signal);
      if (signal === "SIGKILL") {
        childRef.signalCode = "SIGKILL";
        queueMicrotask(() => childRef.emit("exit", null, "SIGKILL"));
      }
      return ok;
    };

    await stopServeProcess(child, 20);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(childRef.signalCode).toBe("SIGKILL");
  });

  it("SIGKILL 也打不死的进程：不会无限挂住（到点返回）", async () => {
    const { child, signals } = fakeServe({ exitOnKill: false });

    const startedAt = Date.now();
    await stopServeProcess(child, 10);
    const elapsed = Date.now() - startedAt;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    // 宽限 10ms + SIGKILL 后最多再等 1s。
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("withServeSerial", () => {
  it("同一 key 上的两轮不重叠：后一轮一定等前一轮的任务落地", async () => {
    const events: string[] = [];
    const gate = { release: () => {} };
    const first = withServeSerial("opencode|host", async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      events.push("first:end");
      return "a";
    });
    // 让第一轮真正进到任务里，再排队第二轮。
    await Promise.resolve();

    const second = withServeSerial("opencode|host", async () => {
      events.push("second:start");
      return "b";
    });
    await Promise.resolve();
    // 第一轮还压着：第二轮不许开始（现场就是这里重叠，才撞数据目录的锁）。
    expect(events).toEqual(["first:start"]);

    gate.release();
    await expect(first).resolves.toBe("a");
    await expect(second).resolves.toBe("b");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("前一轮失败不传染：后一轮照常执行", async () => {
    await expect(
      withServeSerial("opencode|fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(withServeSerial("opencode|fail", async () => "ok")).resolves.toBe("ok");
  });

  it("不同 key 互不排队", async () => {
    const events: string[] = [];
    const block = withServeSerial("opencode|a", async () => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push("a:end");
      return "a";
    });
    const other = withServeSerial("opencode|b", async () => {
      events.push("b:start");
      return "b";
    });

    await Promise.all([block, other]);
    // b 不必等 a 那 30ms。
    expect(events.indexOf("b:start")).toBeLessThan(events.indexOf("a:end"));
  });
});

describe("stopServeProcess / win32", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Windows 上不靠 child.kill 的 SIGTERM 打 wrapper", async () => {
    // win32 走 `taskkill /T /F`（另起进程，测试里拿不到 argv）。这里能钉住的是：
    // 第一个打给子进程的信号不是 SIGTERM —— 那只会杀掉 wrapper，留下真正干活的
    // 孙进程，正是「下一轮被上一轮残骸卡住」的来源。
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { child, childRef, signals } = fakeServe({ exitOnKill: false });
    const originalKill = childRef.kill;
    childRef.kill = (signal: NodeJS.Signals = "SIGTERM") => {
      const ok = originalKill(signal);
      if (signal === "SIGKILL") {
        childRef.signalCode = "SIGKILL";
        queueMicrotask(() => childRef.emit("exit", null, "SIGKILL"));
      }
      return ok;
    };

    await stopServeProcess(child, 10);

    expect(signals).not.toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
});
