// src/__tests__/spawn-run-pump-session-file-fallback.test.ts
//
// M4 close finalizer 接线测试（设计 §3.3 决策 4 / §3.4 错误规格 / V4）。
//
// 被测对象 = wireChildStdoutPump 的 close 收尾链（LC-4 → M4 扫描 → resolveExit），
// fake child（PassThrough stdout/stdin + EventEmitter 手动 close）驱动：
//   - 单命中 → identity.sessionFile 真被填上 + onHandleReady 通知（outcome.sessionFile
//     来源即 identity.sessionFile，见 spawn-runner.ts collectOutcome）+ 审计 warn；
//   - 多命中 / 零命中 → 放弃 + warn + run 正常终态（resolveExit 必达）；
//   - fs 异常（sessionDir 不存在）→ 放弃 + warn + resolveExit 必达；
//   - 回填链 onHandleReady 抛错 → resolveExit 仍必达（整体 try-catch 的意义）；
//   - sessionFile 已由 LC-4/header 填上 → 不扫描（不产生 [sessionfile] warn）；
//   - seam 缺省 → warn「未接线」而非静默。
//
// session 文件 fixture 落在 mkdtempSync 自建目录（tmpdir 白名单，不触碰真实数据目录）。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { configureLoggerSink, resetLoggerSinkForTests, type LogLevel } from "@zhushanwen/subagent-engine-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpawnRunCallbacks } from "../spawn-runner.ts";
import {
  createSessionIdentityTracker,
  formatCandidateCount,
  wireChildStdoutPump,
  type SessionFileFallbackInput,
  type SessionIdentityTracker,
  type StdoutPumpDeps,
} from "../spawn-run-pump.ts";

const WINDOW_START = Date.parse("2026-09-10T00:00:00.000Z");

let dir: string;
let logs: Array<{ level: LogLevel; component: string; message: string }>;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "m4-pump-"));
  logs = [];
  configureLoggerSink({
    log: (level, component, message) => {
      logs.push({ level, component, message });
    },
  });
});

afterEach(() => {
  resetLoggerSinkForTests();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 本 run 的日志里含 [sessionfile] 的 warn 文案。 */
function sessionFileWarnings(): string[] {
  return logs
    .filter((l) => l.level === "warn" && l.message.includes("[sessionfile]"))
    .map((l) => l.message);
}

/** 按实装 pi 落盘形态写一份 session 文件（逐行 JSON.stringify）并钉住 mtime。 */
function writeSessionFile(name: string, prompt: string, mtimeMs = WINDOW_START + 1000): string {
  const filePath = join(dir, name);
  const entry = {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-09-10T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(entry)}\n`);
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

/** fake child（PassThrough stdout/stdin + 手动 close；precedent: ui-request-queue.test.ts）。 */
function makeFakeChild(): {
  child: ChildProcess;
  fireClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = {
    stdout,
    stdin,
    stderr: null,
    killed: false,
    pid: 4242,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  } as unknown as ChildProcess;
  return {
    child,
    fireClose: (code, signal = null) => {
      emitter.emit("close", code, signal);
      stdout.end();
      stdin.end();
    },
  };
}

interface PumpHarness {
  identity: SessionIdentityTracker;
  exitPromise: Promise<number>;
  fireClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  readyCalls: Array<{ sessionRef: Record<string, string>; poolKey: string }>;
}

/** 装配 close 收尾链（endedCleanly 缺省 true = agent_end 主动终结）。 */
function wirePump(
  sessionDir: string,
  fallback: SessionFileFallbackInput | undefined,
  overrides: Partial<SpawnRunCallbacks> = {},
  endedCleanly = true,
): PumpHarness {
  const { child, fireClose } = makeFakeChild();
  const readyCalls: PumpHarness["readyCalls"] = [];
  const callbacks: SpawnRunCallbacks = {
    onEvent: () => {},
    onHandleReady: (partial) => {
      readyCalls.push(partial);
    },
    ...overrides,
  };
  const identity = createSessionIdentityTracker(sessionDir, callbacks);
  const deps: StdoutPumpDeps = {
    child,
    recordId: "rec-m4-test",
    callbacks,
    identity,
    handleSdkEvent: () => {},
    enqueueUi: () => {},
    stderrTee: undefined,
    runEnd: { endedCleanly },
    ...(fallback !== undefined ? { sessionFileFallback: fallback } : {}),
  };
  return { identity, exitPromise: wireChildStdoutPump(deps), fireClose, readyCalls };
}

describe("close finalizer M4 兜底扫描接线", () => {
  it("单命中：identity.sessionFile 真被填上 + handleReady 通知 + 审计 warn，resolveExit 达", async () => {
    const prompt = '任务 "引号" \n 换行 \\ 反斜杠';
    const filePath = writeSessionFile("solo.jsonl", prompt, WINDOW_START + 1000);
    const h = wirePump(dir, { prompt, spawnStartedAtMs: WINDOW_START, sessionDir: dir });

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBe(filePath);
    expect(h.readyCalls).toHaveLength(1);
    expect(h.readyCalls[0]?.sessionRef.sessionFile).toBe(filePath);
    const warns = sessionFileWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("recovered for rec-m4-test by M4 prompt-head scan");
    expect(warns[0]).toContain("file=solo.jsonl");
    expect(warns[0]).toContain("promptHeadHash=");
  });

  it("多命中：放弃 + warn + run 正常终态（resolveExit 达、不回填）", async () => {
    writeSessionFile("twin-a.jsonl", "同模板任务 prompt");
    writeSessionFile("twin-b.jsonl", "同模板任务 prompt");
    const h = wirePump(dir, { prompt: "同模板任务 prompt", spawnStartedAtMs: WINDOW_START, sessionDir: dir });

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBeUndefined();
    expect(h.readyCalls).toHaveLength(0);
    const warns = sessionFileWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("unobtainable for rec-m4-test");
    expect(warns[0]).toContain("reason=multiple_matches");
    expect(warns[0]).toContain("candidates=2");
    expect(warns[0]).toContain("record finalized without transcript anchor");
    expect(warns[0]).toContain("Recovery:");
  });

  it("零命中：放弃 + warn(no_match) + resolveExit 达", async () => {
    writeSessionFile("other.jsonl", "另一个任务");
    const h = wirePump(dir, { prompt: "本 run 的 prompt", spawnStartedAtMs: WINDOW_START, sessionDir: dir });

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBeUndefined();
    expect(sessionFileWarnings()[0]).toContain("reason=no_match");
  });

  it("fs 异常（sessionDir 不存在）：放弃 + warn(fs_error) + resolveExit 必达", async () => {
    const missingDir = join(dir, "missing-dir");
    const h = wirePump(missingDir, { prompt: "本 run 的 prompt", spawnStartedAtMs: WINDOW_START, sessionDir: missingDir });

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBeUndefined();
    const warns = sessionFileWarnings();
    expect(warns[0]).toContain("reason=fs_error");
    expect(warns[0]).toContain("error=");
  });

  it("回填链 onHandleReady 抛错：resolveExit 仍必达，sessionFile 已落位（先赋值后回调）", async () => {
    const prompt = "异常链任务 prompt";
    const filePath = writeSessionFile("throwing.jsonl", prompt);
    const h = wirePump(
      dir,
      { prompt, spawnStartedAtMs: WINDOW_START, sessionDir: dir },
      {
        onHandleReady: () => {
          throw new Error("server 组帧失败（模拟）");
        },
      },
    );

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBe(filePath);
    const warns = sessionFileWarnings();
    // 采纳 warn 先出，随后是异常按 miss 处理的 warn（close 链继续）
    expect(warns.some((w) => w.includes("M4 prompt-head scan threw for rec-m4-test"))).toBe(true);
  });

  it("sessionFile 已回填（LC-4/header 命中）：不再扫描，不产生 [sessionfile] warn", async () => {
    writeSessionFile("already.jsonl", "本 run 的 prompt");
    const h = wirePump(dir, { prompt: "本 run 的 prompt", spawnStartedAtMs: WINDOW_START, sessionDir: dir });
    const known = join(dir, "known-session.jsonl");
    h.identity.applyGetStateFields({ sessionFile: known });

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBe(known);
    expect(sessionFileWarnings()).toHaveLength(0);
  });

  it("seam 缺省（未接线）：warn 显式留痕，不静默；resolveExit 达", async () => {
    const h = wirePump(dir, undefined);

    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0);
    expect(h.identity.sessionFile).toBeUndefined();
    const warns = sessionFileWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("M4 prompt-head scan not wired");
  });

  it("[U-A5] 宿主回调 onChildStateChanged 抛错：不逃出 close 监听器，resolveExit 必达且 LC-4/M4 兜底链不被跳过", async () => {
    const prompt = "宿主回调抛错任务 prompt";
    const filePath = writeSessionFile("host-throw.jsonl", prompt);
    const h = wirePump(
      dir,
      { prompt, spawnStartedAtMs: WINDOW_START, sessionDir: dir },
      {
        onChildStateChanged: () => {
          throw new Error("宿主镜像回调抛错（模拟 server 组帧链失败）");
        },
      },
    );

    // 原实现：异常从 close 监听器逃出（本行即抛）且 M4/resolveExit 双双被跳过 → run 永挂
    h.fireClose(0);
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(0); // resolveExit 必达 + 正常折算（endedCleanly=true）
    expect(h.identity.sessionFile).toBe(filePath); // M4 扫描仍执行（必达区）
    const warns = sessionFileWarnings();
    expect(warns.some((w) => w.includes("recovered for rec-m4-test by M4 prompt-head scan"))).toBe(true);
    // 降级留痕（非 [sessionfile] 前缀，不经过 sessionFileWarnings）
    const allWarnText = logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(allWarnText.some((w) => w.includes("close finalizer step 'reportChildExited' failed for rec-m4-test"))).toBe(true);
  });

  it("[U-A4] 放弃诊断的候选数渲染：完整计数 = candidates=N；部分计数显式写明 so far + 总数未知", () => {
    // 完整收集（上限门/多命中/收集后异常）：直接报数，诊断方按「窗口内候选总数」读
    expect(formatCandidateCount({ candidateCount: 3, candidateTotalKnown: true })).toBe("candidates=3");
    // 收集被时间门/readdir 打断：不得把部分计数冒充候选总数
    const partial = formatCandidateCount({ candidateCount: 3, candidateTotalKnown: false });
    expect(partial).toBe("candidates=3 so far (collection aborted: window total unknown)");
    expect(partial).not.toBe("candidates=3");
  });

  it("agent_end 未置位（信号退出）：退出码仍按 128+ 折算，扫描逻辑不改变退出码口径", async () => {
    const prompt = "信号退出任务 prompt";
    const filePath = writeSessionFile("signaled.jsonl", prompt);
    const h = wirePump(dir, { prompt, spawnStartedAtMs: WINDOW_START, sessionDir: dir }, {}, false);

    h.fireClose(null, "SIGTERM");
    const exitCode = await h.exitPromise;

    expect(exitCode).toBe(128);
    expect(h.identity.sessionFile).toBe(filePath);
  });
});
