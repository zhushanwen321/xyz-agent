// src/execution/__tests__/disposition-retry-window.test.ts
//
// [U3 D3b] agent_end 处置翻转：error 分支（读不出）15s 回补重试窗口（实施计划 u3-flip
// 验收条款②；设计 docs/design/subagent-agent-end-recovery.md §3.3 D3b + §3.4 竞态 #2/#5/#8）。
//
// 覆盖：
//   - 条款②-a：窗口内第 2 轮扫描命中 → 以真实 sessionFile 走既有三分支重判（终局 final kill）；
//   - 条款②-b：窗口耗尽 → SIGTERM 升级链 kill + runSpawn 成功语义（结果来自 stdout 累积，
//     不依赖 sessionFile）；
//   - 条款②-c：窗口内外部 kill → timer fire 探活（exitCode/signalCode 双 null，竞态 #2）
//     直接返回交 close 收尾（无二次 kill、无耗尽 warn）；
//   - 竞态 #5：窗口轮回填先行检查——record.sessionFile 已被 D1 迟到回填命中时下一轮直接
//     三分支重判，不重复获取（无新 get_state）；
//   - 竞态 #8：重复 arm 先清旧（幂等，对齐 keepAliveNoProgressTimer arm 模式）——窗口重置
//     重计，耗尽恰好一次 kill / 一条耗尽 warn；
//   - G2 分家守卫：count>0（证实有后代）不受翻转影响——窗口不挂载，keep-alive 原样。
//
// mock 布局与 run-spawn-edges.test.ts 一致（FakeChild + mock session-pending / alive-store）；
// timer 测试用 fake timers（AGENTS.md 红线）；不 emit header（RPC mode 形态）= sessionFile
// 只能靠 get_state 回填 / 扫描兜底获取。

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger：窗口 entering / 轮 miss / 耗尽 warn 的留痕断言。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    // buildEnvBlock 的 git branch 调用（execFile 异步）：默认 err-first 兜底 → catch → branch=""
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => cb(new Error("execFile not configured in this test")),
    ),
  };
});

// fs mock（run-spawn-edges 同款：mkdirSync/existsSync/appendFileSync/writeFileSync/
// readdirSync 可编排；statSync/readFileSync 保留 actual 引用供扫描命中用例 spyOn 覆盖）。
vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: actual.statSync,
    readFileSync: actual.readFileSync,
    promises: actual.promises,
  };
});

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
}));

// agent_end 处置判定独立 mock：默认 sessionFile 缺失形态 error（翻转分支的入口形态）。
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({
    count: 0,
    recentUnregister: false,
    error: "no sessionFile (handshake not settled)",
  })),
  listActivePendingFromSessionFile: vi.fn(() => ({ items: [] })),
  prunePendingCursor: vi.fn(),
}));

vi.mock("../engine/engines/pi/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import {
  DISPOSITION_RETRY_STEP_MS,
  DISPOSITION_RETRY_WINDOW_MS,
  KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS,
  runSpawn,
  SPAWN_WATCHDOG_ENV,
} from "../engine/engines/pi/session-runner.ts";
import { writeAliveMarker } from "../alive-store.ts";
import { readActivePendingFromSessionFile } from "../session-pending.ts";
import { getSubagentSessionDir } from "../path-encoding.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const mockWriteAliveMarker = vi.mocked(writeAliveMarker);
const mockPending = vi.mocked(readActivePendingFromSessionFile);
const mockReaddirSync = vi.mocked(fs.readdirSync as (path: fs.PathLike) => string[]);

const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

/** 统计 stdin 收到的 get_state 请求数（获取轮节奏 / 竞态 #5「不重复获取」断言用）。 */
function countGetStateRequests(child: FakeChild): { seen: number } {
  const counter = { seen: 0 };
  child.stdin.on("data", (data: Buffer | string) => {
    const text = typeof data === "string" ? data : data.toString();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        if ((JSON.parse(line) as { type?: string }).type === "get_state") counter.seen++;
      } catch {
        // prompt 命令等非 JSON 行忽略
      }
    }
  });
  return counter;
}

describe("[U3 D3b] agent_end 处置翻转：error 分支 15s 回补重试窗口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
    mockPending.mockReturnValue({
      count: 0,
      recentUnregister: false,
      error: "no sessionFile (handshake not settled)",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  /** 启动 runSpawn（RPC 形态：不 emit header）并进入 fake timers（agent_end 前）。 */
  async function spawnAndEmitAgentEnd(
    task = "Task: retry-window",
    opts = makeOpts(),
  ): Promise<{ child: FakeChild; promise: ReturnType<typeof runSpawn>; counter: { seen: number } }> {
    const record = makeRecord();
    const promise = runSpawn(record, task, opts, makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();
    const counter = countGetStateRequests(child);
    // fake timers 必须在 emit agent_end 之前启用（窗口 timer 新建于处置链内；
    // 不 fake setImmediate——stream flush 靠真实事件循环交付，对齐 MF-3 先例）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    return { child, promise, counter };
  }

  it("条款②-a：窗口内第 2 轮扫描命中 → 以真实 sessionFile 走既有三分支重判（终局 final kill，无耗尽 warn）", async () => {
    // 判定序列：①入口首判（sessionFile undefined）error → arm 窗口；②轮 1 get_state
    // 无响应 → sessionFile 仍缺失，无重判调用（miss 续窗）；③轮 2 扫描命中（回填 +
    // marker）→ 以真实路径重判 count=0 → final kill。
    mockPending
      .mockReturnValueOnce({ count: 0, recentUnregister: false, error: "no sessionFile (handshake not settled)" })
      .mockReturnValue({ count: 0, recentUnregister: false });

    const record = makeRecord("scan-hit-1");
    const promise = runSpawn(record, "Task: scan-hit", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();
    const counter = countGetStateRequests(child);

    // 轮 2 扫描命中的候选装配：readdirSync（mock，入口阶段返回空让三路全 miss 进窗口）+
    // statSync/readFileSync（spyOn actual——fs mock 保留 actual，命中形态按需覆盖）
    const ctx = makeCtx();
    const sessionDir = getSubagentSessionDir(ctx.agentDir, ctx.rootCwd);
    const scannedName = "20260910T00000000_scan-hit-1.jsonl";
    const scannedPath = `${sessionDir}/${scannedName}`;
    const identityLine = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      timestamp: "2026-09-10T00:00:00.000Z",
      data: { id: "scan-hit-1", agent: "general-purpose", mode: "background", task: "t", startedAt: 1 },
    });
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(
      () => ({ isFile: () => true, mtimeMs: Date.now() + 10_000 }) as fs.Stats,
    );
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(
      (() => identityLine) as unknown as typeof fs.readFileSync,
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      await new Promise((r) => setImmediate(r));
      // 入口惰性回补已发出（握手 1 + 入口 1）；扫描首查 miss（readdirSync 默认空）
      expect(counter.seen).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(record.sessionFile).toBeUndefined();

      // 轮 1（5s）：get_state 单查（第 3 个请求）无响应 → miss
      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_STEP_MS);
      expect(counter.seen).toBe(3);
      expect(child.killed).toBe(false);

      // 轮 2（10s）：放行扫描候选 → 命中 → 回填 + marker + 三分支重判（count=0 → final kill）
      mockReaddirSync.mockReturnValue([scannedName]);
      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_STEP_MS);
      expect(record.sessionFile).toBe(scannedPath);
      // 扫描命中 warn 留痕（troubleshooting §12 词条②的窗口轮措辞）
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `[session-runner] sessionFile located via sessionDir scan (retry window round 2): ${scannedPath}`,
        ),
      );
      expect(mockWriteAliveMarker).toHaveBeenCalledWith(
        scannedPath,
        expect.objectContaining({ pid: child.pid, id: "scan-hit-1" }),
      );
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // 命中重判走既有三分支终局（final kill），不是窗口耗尽路径
      const exhaustWarn = loggerMock.warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m) =>
        m.includes("recovery window"),
      );
      expect(exhaustWarn).toHaveLength(0);

      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.sessionFile).toBe(scannedPath);
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("条款②-b：窗口耗尽 → SIGTERM 升级链 kill + runSpawn 成功语义，结果来自 stdout 事件累积", async () => {
    const { child, promise, counter } = await spawnAndEmitAgentEnd("Task: window-exhaust");

    // stdout 事件累积 assistant 正文（结果内容来源——不依赖 sessionFile）
    emitStdoutLine(child, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "月报数据已生成" },
    });

    try {
      // 入口回补 1s 预算 → 空结果 → 扫描 miss → arm 窗口（轮 1/2/3 @ arm+5/10/15s）
      await vi.advanceTimersByTimeAsync(1000);
      expect(counter.seen).toBe(2);
      expect(child.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_STEP_MS);
      expect(counter.seen).toBe(3); // 轮 1：get_state 单查已发出（无响应 → miss）
      expect(child.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_STEP_MS);
      expect(child.killed).toBe(false); // 轮 2：扫描 miss（readdirSync 默认空）

      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_STEP_MS);
      // 轮 3（耗尽判定轮，不再获取）：kill SIGTERM——SIGKILL 升级由 killChain 30s 窗口承接
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // 耗尽 warn 留痕（设计 §3.5 D3b 行文案；后代连带终局表述为 Gate B S5/P5 实测勘误后）
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("sessionFile unobtainable after 15s recovery window"),
      );
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "descendants (if any) were terminated with this process (graceful-shutdown reap or stdout EPIPE)",
        ),
      );

      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);
      const result = await promise;
      // 被信号终止视为正常完成（resolveRunOutcome 既有语义）+ 正文来自 stdout 累积
      expect(result.success).toBe(true);
      expect(result.text).toContain("月报数据已生成");
      expect(result.sessionFile).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("条款②-c / 竞态 #2：窗口内外部 kill → timer fire 探活直接返回交 close 收尾（无二次 kill / 无耗尽 warn）", async () => {
    const { child, promise } = await spawnAndEmitAgentEnd("Task: window-race-kill");

    try {
      await vi.advanceTimersByTimeAsync(1000); // 入口回补预算 → arm 窗口
      expect(child.killed).toBe(false);

      // 窗口内外部 kill（abort / dispose 形态）：真 ChildProcess close 后 exitCode 非 null，
      // FakeChild 需手动赋值模拟该语义——探活判据读取的就是它
      const killSpy = vi.spyOn(child, "kill");
      child.kill("SIGTERM");
      child.exitCode = 143;
      child.signalCode = "SIGTERM";
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);
      await promise; // close 收尾完成（窗口 timer 由收尾统一 disarm）

      // 越过窗口全程：无二次 kill（探活失败 tick 直接返回）、无耗尽处置
      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_WINDOW_MS + 60_000);
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("sessionFile unobtainable after 15s recovery window"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("竞态 #5：窗口轮回填先行检查——record.sessionFile 已回填时直接三分支重判，不重复获取", async () => {
    // 判定序列：①入口 error → arm；②轮 1 fire 时 record.sessionFile 已被（模拟 D1 迟到
    // 回填落地）先行回填 → 直接重判 count=0 → final kill；全程无第 3 个 get_state。
    mockPending
      .mockReturnValueOnce({ count: 0, recentUnregister: false, error: "no sessionFile (handshake not settled)" })
      .mockReturnValue({ count: 0, recentUnregister: false });

    const record = makeRecord("race5-backfilled");
    const promise = runSpawn(record, "Task: race5", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();
    const counter = countGetStateRequests(child);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(1000); // 入口回补预算 → error → arm 窗口
      expect(record.sessionFile).toBeUndefined();
      expect(counter.seen).toBe(2);

      // 模拟 D1 迟到回填在窗口内落地（幂等回填面已由 session-runner-late-backfill 单测锚定）
      record.sessionFile = "/tmp/test/agents/subagents/--tmp-test--/sessions/race5.jsonl";

      // 轮 1 fire：回填先行检查命中 → 直接重判（无新 get_state）→ count=0 → final kill
      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_STEP_MS);
      expect(counter.seen).toBe(2); // 不重复获取
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      expect(loggerMock.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("recovery window"),
      );

      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);
      const result = await promise;
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("竞态 #8：重复 arm 先清旧（幂等）——窗口重置重计，耗尽恰好一次 kill / 一条耗尽 warn", async () => {
    const { child, promise, counter } = await spawnAndEmitAgentEnd("Task: race8-rearm");

    try {
      // 第 1 次 agent_end：入口回补预算 → arm 窗口（round1 @ +5s）
      await vi.advanceTimersByTimeAsync(1000);
      expect(counter.seen).toBe(2);
      expect(child.killed).toBe(false);

      // 第 2 次 agent_end（递归层主被唤醒后的多轮形态）：重复进入 error 分支 →
      // disarm 旧窗口 + 重 arm（窗口重置，从 +2s 起算）
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(1000); // 第 2 次入口回补预算（第 3 个 get_state）
      expect(counter.seen).toBe(3);

      // 推进到新窗口耗尽点（arm@2000 + 15s = 17000）：若旧窗口未清（叠加），
      // 旧 round 链会在 16000 先行耗尽 → 两次 kill / 两条耗尽 warn
      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_WINDOW_MS);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      const exhaustWarns = loggerMock.warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m) =>
        m.includes("sessionFile unobtainable after 15s recovery window"),
      );
      expect(exhaustWarns).toHaveLength(1);

      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);
      const result = await promise;
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("G2 分家守卫：count>0（证实有后代）不受翻转影响——窗口不挂载，keep-alive 原样等待", async () => {
    mockPending.mockReturnValue({ count: 1, recentUnregister: false });
    const { child, promise } = await spawnAndEmitAgentEnd("Task: count-positive");

    try {
      await vi.advanceTimersByTimeAsync(1000);
      // 无窗口挂载：无 entering debug（count>0 走 keep-alive，不进翻转分支）
      const entering = loggerMock.debug.mock.calls.map((c: unknown[]) => String(c[0])).filter((m) =>
        m.includes("entering") && m.includes("recovery window"),
      );
      expect(entering).toHaveLength(0);

      // 15s 窗口量级处不杀（keep-alive 合法等待；无进展上界 30min 远未到）
      await vi.advanceTimersByTimeAsync(DISPOSITION_RETRY_WINDOW_MS);
      expect(child.killed).toBe(false);

      // keep-alive 原样保留：裸缺省无进展上界（30min 连续静默 + 复核无存活后代）才处置
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);
      const result = await promise;
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
