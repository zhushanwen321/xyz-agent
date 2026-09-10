// src/execution/engine/engines/pi/__tests__/session-runner-late-backfill.test.ts
//
// [U1 D1/D2] session-runner 回填面单测（实施计划 u1-acquire 验收条款①③）。
//
// 覆盖：
//   - 条款①（回填守卫半边）：backfillSessionFileFromLateGetState 的 !record.sessionFile
//     幂等守卫——已有 sessionFile 不覆盖、不重写 marker；缺失形态补 sessionFile +
//     handshakeResult.sessionId + alive marker（对齐 finishHandshake 回填面）。
//   - 条款③：backfillSessionFileByLookup 接入点 2——lookupId 缺失（rpc mode 无 header
//     ∧ 握手全失败）时按 record.id 扫描回填；lookupId 存在时既有反查路径主导不扫描；
//     record.sessionFile 在盘时整体跳过（既有守卫回归）。
//
// 红线对齐：写删目标全部 mkdtempSync(tmpdir) 自建自删；alive-store mock（marker 不落
// 真实数据目录）；fs 用真实实现（sessionDir 隔离在临时目录内）。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeAliveMarker } from "../../../../alive-store.ts";
import type { ExecutionRecord } from "../../../../types.ts";
// spawn-mock 必须先于 session-runner 初始化：后者的模块顶层 getLogger 调用会触发
// 下方 vi.mock 工厂，工厂引用的 loggerMock 单例届时必须已就绪（否则 TDZ）。
import {
  loggerMock,
  makeCtx,
  makeOpts,
  makeRecord,
} from "../../../../__tests__/helpers/spawn-mock.ts";
import {
  backfillSessionFileByLookup,
  backfillSessionFileFromLateGetState,
  type SpawnRunState,
} from "../session-runner.ts";

vi.mock("../../../../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
}));

// 回填 warn 文案留痕断言用（[2026-09-10 清理] warn 断言广度补齐；spawn-mock 共享单例）。
// 注意 mock 路径相对本测试文件解析：五级向上 = src/core/logger.ts（与 session-runner.ts
// 的四级 import 解析到同一模块，vitest 按解析后绝对路径拦截）。
vi.mock("../../../../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

const mockWriteAliveMarker = vi.mocked(writeAliveMarker);

/** identity entry 行（对齐子进程 session_start hook 写盘序列化形态）。 */
function identityLine(recordId: string): string {
  return JSON.stringify({
    type: "custom",
    customType: "subagent-identity",
    timestamp: "2026-09-10T00:00:00.000Z",
    data: { id: recordId, agent: "general-purpose", mode: "background", task: "t", startedAt: 1 },
  });
}

/** 构造最小合法 SpawnRunState（spawnStartedAtMs 设为 1 分钟前 → 现写文件 mtime 必然大于基准）。 */
function makeState(record: ExecutionRecord, overrides: Partial<SpawnRunState> = {}): SpawnRunState {
  return {
    record,
    opts: makeOpts(),
    ctx: makeCtx(),
    proc: undefined,
    watchdog: undefined,
    sessionHeader: undefined,
    handshakeResult: undefined,
    resolveRun: undefined,
    keepAliveNoProgressTimer: undefined,
    // [U3 D3b] error 分支回补重试窗口 timer（本文件只测回填面纯函数，恒未挂载）
    dispositionRetryTimer: undefined,
    sweepDescendantsOnClose: false,
    settledWatchdogFired: undefined,
    spawnStartedAtMs: Date.now() - 60_000,
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "session-runner-late-backfill-test-"));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("backfillSessionFileFromLateGetState（[U1 D1] 迟到接受回填面）", () => {
  it("缺失形态：补 record.sessionFile + handshakeResult.sessionId + 写 alive marker", () => {
    const record = makeRecord("run-1");
    const state = makeState(record);

    backfillSessionFileFromLateGetState(
      state,
      4321,
      { sessionFile: "/tmp/agents/sa-late.jsonl", sessionId: "sess-late" },
    );

    expect(record.sessionFile).toBe("/tmp/agents/sa-late.jsonl");
    expect(state.handshakeResult?.sessionId).toBe("sess-late");
    expect(mockWriteAliveMarker).toHaveBeenCalledWith(
      "/tmp/agents/sa-late.jsonl",
      expect.objectContaining({ pid: 4321, id: "sess-late" }),
    );
    // 回填 warn 留痕（troubleshooting §12 词条①）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "[session-runner] sessionFile backfilled via late get_state response: /tmp/agents/sa-late.jsonl",
    );
  });

  it("!record.sessionFile 幂等守卫：已有 sessionFile（header/resume 先行设置）不覆盖、不重写 marker", () => {
    const record = makeRecord("run-1");
    record.sessionFile = "/resume/locked.jsonl";
    const state = makeState(record, { handshakeResult: { sessionId: "old-sess" } });

    backfillSessionFileFromLateGetState(
      state,
      4321,
      { sessionFile: "/tmp/agents/sa-late.jsonl", sessionId: "new-sess" },
    );

    expect(record.sessionFile).toBe("/resume/locked.jsonl"); // 不被迟到值覆盖
    expect(mockWriteAliveMarker).not.toHaveBeenCalled();
    expect(state.handshakeResult?.sessionId).toBe("old-sess"); // 已有 sessionId 不覆盖
    // 守卫生效 = 无回填发生 = 无回填 warn
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("backfilled via late get_state response"),
    );
  });

  it("childPid undefined（进程已死形态）→ 仍回填 sessionFile/sessionId，跳过 marker 不抛", () => {
    const record = makeRecord("run-1");
    const state = makeState(record);

    backfillSessionFileFromLateGetState(
      state,
      undefined,
      { sessionFile: "/tmp/agents/sa-late.jsonl" },
    );

    expect(record.sessionFile).toBe("/tmp/agents/sa-late.jsonl");
    expect(mockWriteAliveMarker).not.toHaveBeenCalled();
  });
});

describe("backfillSessionFileByLookup 接入点 2（[U1 D2] lookupId 缺失扫描兜底）", () => {
  it("lookupId 缺失（无 header ∧ 握手全失败）→ 按 record.id 扫描回填", () => {
    const record = makeRecord("run-42");
    const state = makeState(record); // sessionHeader / handshakeResult / sessionFile 全缺
    const target = join(dir, "sa-run-42.jsonl");
    fs.writeFileSync(target, identityLine("run-42") + "\n");

    backfillSessionFileByLookup(state, dir);

    expect(record.sessionFile).toBe(target);
    // 扫描兜底 warn 留痕（troubleshooting §12 词条②的 close finalization 措辞）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      `[session-runner] sessionFile backfilled via sessionDir scan (close finalization): ${target}`,
    );
  });

  it("lookupId 缺失且扫描无匹配（极早期 kill：identity 未写）→ sessionFile 保持 undefined", () => {
    const record = makeRecord("run-42");
    const state = makeState(record);
    fs.writeFileSync(join(dir, "unrelated.jsonl"), "no identity here\n");

    backfillSessionFileByLookup(state, dir);

    // 记账缺失 = 正确语义（进程从未开始工作，finalize 按 crashed 记账），不误指路径
    expect(record.sessionFile).toBeUndefined();
    // crashed 记账前的 warn 留痕（troubleshooting §12 词条⑤的 close 链措辞）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining(`sessionFile unobtainable for run-42 (process killed before handshake settled)`),
    );
  });

  it("lookupId 存在（既有反查路径）→ 即使反查不命中也不走扫描（既有语义主导）", () => {
    const record = makeRecord("run-42");
    const state = makeState(record, { handshakeResult: { sessionId: "sess-header-x" } });
    // 目录里有 identity 精确匹配文件——但 lookupId 存在时应只走 findSessionFileByHeaderId
    // 反查（首行 header id 匹配），本文件首行非 header → 反查不命中 → 不回填
    fs.writeFileSync(join(dir, "sa-run-42.jsonl"), identityLine("run-42") + "\n");

    backfillSessionFileByLookup(state, dir);

    expect(record.sessionFile).toBeUndefined();
    // 未走扫描分支：两条扫描路径 warn 均不出现
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("sessionDir scan"),
    );
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("unobtainable"),
    );
  });

  it("record.sessionFile 已在盘（既有守卫）→ 整体跳过兜底，路径不被扫描结果覆盖", () => {
    const record = makeRecord("run-42");
    const existing = join(dir, "already.jsonl");
    fs.writeFileSync(existing, "{}\n");
    record.sessionFile = existing;
    const state = makeState(record); // lookupId 缺失，但 sessionFile 存在且在盘

    backfillSessionFileByLookup(state, dir);

    expect(record.sessionFile).toBe(existing);
  });
});
