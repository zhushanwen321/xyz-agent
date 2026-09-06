// src/execution/__tests__/session-runner-dispatch.test.ts
//
// [S-17a / runSpawn 阶段拆分] 重构提取辅助函数的可观察行为锁定（stdout 分派域）。
//
// 背景：session-runner.ts 按执行阶段拆分（文件顶部「runSpawn 的阶段拆分」注释块）后，
// 新提取的辅助函数（dispatchSdkEventByType / accumulateMessageEnd / handleHeaderLine /
// setupFreshChild / buildChildEnv / buildSpawnInvocation / startGetStateHandshake /
// writeAliveMarkerBestEffort）残留分支无断言锁定。本文件经 runSpawn 全链路（FakeChild
// stdout 行喂入）锁定可观察行为：
//   - stdout 分派：message_end usage 累计 / stopReason=error 错误收口 / compaction_start
//     事件外发 / 空行不打 invalid 计数 / 末尾残留 invalid 行 close 时聚合留痕；
//   - header 行：worktree pid 补全（onWorktreePid 收到推导 sessionFile）、回调抛错
//     best-effort 不中断解析、alive marker 写失败不中断；
//   - setupFreshChild：worktree pid 注册失败（防御 catch）warn 留痕 spawn 继续；
//   - buildChildEnv：relay 激活时归属 env 注入子进程；
//   - buildSpawnInvocation：resume model 无 / 时 provider 兜底 unknown；
//   - startGetStateHandshake：[F2] get_state 写 stdin 同步 EPIPE → error 留痕 +
//     握手立即放弃，close 收尾不被阻塞。
//
// mock 布局与 session-runner-epipe.test.ts 一致（FakeChild + fs/alive-store/
// session-pending/temp-prompt mock + 共享 logger mock）。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    // buildEnvBlock 的 git branch 调用（execFile 异步）：默认 err-first 兜底 → branch=""
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
    promises: actual.promises,
  };
});

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
}));

vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 0 })),
  prunePendingCursor: vi.fn(),
  listActivePendingFromSessionFile: vi.fn(() => ({ items: [] })),
}));

vi.mock("../engine/engines/pi/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { writeAliveMarker } from "../alive-store.ts";
import { runSpawn, type RunOptions } from "../engine/engines/pi/session-runner.ts";
import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
} from "../relay-env.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import {
  FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  sessionHeader,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";
import type { SessionRunnerContext } from "../engine/engines/pi/session-runner.ts";

const mockSpawn = vi.mocked(spawn);
const mockWriteAliveMarker = vi.mocked(writeAliveMarker);
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

/** FakeChild → spawn mock 实现（结构缺 ChildProcess 私有字段，仅类型层收窄；运行时形状由 runSpawn 消费面界定）。 */
const fakeSpawnImpl = (): ChildProcess => new FakeChild() as unknown as ChildProcess;

/** runSpawn 收尾：end 流 + close(code)，await runSpawn 返回 AgentResult。 */
async function settleRunSpawn(
  child: FakeChild,
  promise: ReturnType<typeof runSpawn>,
  code = 0,
): Promise<Awaited<ReturnType<typeof runSpawn>>> {
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code);
  return promise;
}

describe("[S-17a] stdout 分派辅助函数行为（dispatchSdkEventByType / accumulateMessageEnd）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 显式重置 spawn 实现（防止个别用例的 mockImplementation 泄漏到后续用例）
    mockSpawn.mockImplementation(fakeSpawnImpl);
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
    vi.unstubAllEnvs();
  });

  it("message_end 带 usage → 外发 message_end 事件（cost 从 cost.total 提取）+ totalTokens 累计", async () => {
    const onEvent = vi.fn();
    const record = makeRecord("sa-usage");
    const promise = runSpawn(record, "Task: usage", makeOpts({ onEvent }), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    child.stdout.write(
      `${JSON.stringify({
        type: "message_end",
        message: {
          usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.42 } },
          stopReason: "stop",
        },
      })}\n`,
    );
    await new Promise((r) => setImmediate(r));

    // 事件外发（AgentEvent 形状）：cost 字段拍平自 usage.cost.total
    expect(onEvent).toHaveBeenCalledWith({
      type: "message_end",
      usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.42 },
    });
    // 累计副作用：totalTokens = input+output+cacheRead+cacheWrite
    expect(record.totalTokens).toBe(35);

    const result = await settleRunSpawn(child, promise);
    expect(result.success).toBe(true);
  });

  it("message_end stopReason=error → error 事件收口进 record.lastError → runSpawn 结果 failed", async () => {
    const onEvent = vi.fn();
    const record = makeRecord("sa-merr");
    const promise = runSpawn(record, "Task: stop-error", makeOpts({ onEvent }), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    child.stdout.write(
      `${JSON.stringify({
        type: "message_end",
        message: { stopReason: "error", errorMessage: "provider exploded" },
      })}\n`,
    );
    await new Promise((r) => setImmediate(r));

    // error 事件外发（errorMessage 优先，缺省回退 reason/stopReason）
    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "provider exploded" });
    expect(record.lastError).toBe("provider exploded");

    // close 后 outcome 判定：lastError 分支 → success=false + error 原文
    const result = await settleRunSpawn(child, promise, 0);
    expect(result.success).toBe(false);
    expect(result.error).toContain("provider exploded");
  });

  it("compaction_start → 外发 compaction 事件（record 无数据副作用）", async () => {
    const onEvent = vi.fn();
    const record = makeRecord("sa-compaction");
    const promise = runSpawn(record, "Task: compaction", makeOpts({ onEvent }), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    child.stdout.write(`${JSON.stringify({ type: "compaction_start" })}\n`);
    await new Promise((r) => setImmediate(r));

    expect(onEvent).toHaveBeenCalledWith({ type: "compaction" });
    expect(record.lastError).toBeUndefined();

    const result = await settleRunSpawn(child, promise);
    expect(result.success).toBe(true);
  });

  it("空行不打 invalid 计数；stdout 末尾残留 invalid 行（无换行）close 时聚合 debug 留痕", async () => {
    const record = makeRecord("sa-invalid");
    const promise = runSpawn(record, "Task: invalid-lines", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    // 空行（parseSpawnLine 返回 null）：静默跳过，不算 invalid
    child.stdout.write("\n");
    // 末尾残留半行（无换行，close 前未 flush）：非法 JSON → close 路径计入 invalid 统计
    child.stdout.write("this is not json at all");
    await new Promise((r) => setImmediate(r));

    loggerMock.debug.mockClear();
    const result = await settleRunSpawn(child, promise, 0);

    expect(result.success).toBe(true);
    // [LC-9/T7②] close 聚合留痕：总数 + 样本（事件行损坏被静默丢弃的排查入口）
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("stdout had 1 invalid line(s) dropped in total"),
    );
  });
});

describe("[S-17a] handleHeaderLine：header 行分派 + worktree pid 补全", () => {
  const WORKTREE = {
    path: "/tmp/wt-checkout",
    branch: "wt/dispatch-1",
    baseCommit: "abc123",
    mainCwd: "/tmp/test",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockImplementation(fakeSpawnImpl);
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
  });

  it("header 到达 → sessionFile 推导回填 + onWorktreePid 收到 (branch, pid, 推导路径)", async () => {
    const onWorktreePid = vi.fn();
    const ctx = makeCtx({ onWorktreePid } as Partial<SessionRunnerContext>);
    const opts = makeOpts({ worktree: WORKTREE });
    const record = makeRecord("sa-wt-header");
    const promise = runSpawn(record, "Task: wt-header", opts, ctx);
    await waitForSpawn();
    const child = lastSpawnedChild();

    child.stdout.write(`${JSON.stringify(sessionHeader("sa-sess-wt"))}\n`);
    await new Promise((r) => setImmediate(r));

    // header 分支的 worktree pid 补全：带推导出的 sessionFile（registry entry 数据源）
    expect(onWorktreePid).toHaveBeenCalledWith(
      "wt/dispatch-1",
      child.pid,
      expect.stringContaining("sa-sess-wt"),
    );
    expect(record.sessionFile).toContain("sa-sess-wt");

    await settleRunSpawn(child, promise);
  });

  it("onWorktreePid 回调同步抛错 → best-effort error 留痕，stdout 解析不中断（后续事件照常分派）", async () => {
    const onEvent = vi.fn();
    // setupFreshChild 内两处注册调用先成功，header 分支的第三处抛错
    const onWorktreePid = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockImplementation(() => {
        throw new Error("registry lock contention");
      });
    const ctx = makeCtx({ onWorktreePid } as Partial<SessionRunnerContext>);
    const opts = makeOpts({ worktree: WORKTREE });
    const promise = runSpawn(makeRecord("sa-wt-throw"), "Task: wt-throw", makeOpts({ ...opts, onEvent }), ctx);
    await waitForSpawn();
    const child = lastSpawnedChild();

    child.stdout.write(`${JSON.stringify(sessionHeader("sa-sess-wt2"))}\n`);
    child.stdout.write(`${JSON.stringify({ type: "compaction_start" })}\n`);
    await new Promise((r) => setImmediate(r));

    // bestEffort 缺省 debug 级（msg + { detail } 两参）：同步段异常不阻断 stdout 解析
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("onWorktreePid callback (first header) failed"),
      expect.objectContaining({ detail: "registry lock contention" }),
    );
    // 解析继续：header 之后的 compaction 事件照常外发
    expect(onEvent).toHaveBeenCalledWith({ type: "compaction" });

    await settleRunSpawn(child, promise);
  });

  it("alive marker 写失败（writeAliveMarker 抛错）→ best-effort debug 留痕，header 回填与解析照常", async () => {
    const onEvent = vi.fn();
    mockWriteAliveMarker.mockImplementation(() => {
      throw new Error("disk full");
    });
    const record = makeRecord("sa-marker-fail");
    const promise = runSpawn(record, "Task: marker-fail", makeOpts({ onEvent }), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    child.stdout.write(`${JSON.stringify(sessionHeader("sa-sess-mf"))}\n`);
    child.stdout.write(`${JSON.stringify({ type: "compaction_start" })}\n`);
    await new Promise((r) => setImmediate(r));

    // [持久化 C] marker 是崩溃恢复的增强信号，缺失只降低可恢复性，不影响执行主流程
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("alive marker write failed (best-effort continue)"),
    );
    expect(record.sessionFile).toContain("sa-sess-mf");
    expect(onEvent).toHaveBeenCalledWith({ type: "compaction" });

    await settleRunSpawn(child, promise);
  });
});

describe("[S-17a] setupFreshChild：worktree pid 注册防御 catch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockImplementation(fakeSpawnImpl);
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
  });

  it("第二处 onWorktreePid 注册抛错（防御 catch）→ warn 留痕，spawn 主流程不被阻断", async () => {
    // 第一处（无保护）成功，第二处（try/catch 保护）抛错
    const onWorktreePid = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementation(() => {
        throw new Error("registry write failed");
      });
    const ctx = makeCtx({ onWorktreePid } as Partial<SessionRunnerContext>);
    const opts = makeOpts({
      worktree: { path: "/tmp/wt-checkout", branch: "wt/defensive", baseCommit: "abc", mainCwd: "/tmp/test" },
    });
    const record = makeRecord("sa-wt-defensive");
    const promise = runSpawn(record, "Task: wt-defensive", opts, ctx);
    await waitForSpawn();
    const child = lastSpawnedChild();

    // [S1] 注册表写失败最坏后果是条目停留 pid=0（reaper 宽限兜底），不阻断 spawn
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("worktree pid registration failed (defensive)"),
      expect.objectContaining({ branch: "wt/defensive" }),
    );
    // prompt 命令已照常写入 stdin（spawn 装配未被中断）
    expect(child.stdin.writable).toBe(true);

    const result = await settleRunSpawn(child, promise);
    expect(result.success).toBe(true);
  });
});

describe("[S-17a] buildChildEnv / buildSpawnInvocation：env 与参数组装", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockImplementation(fakeSpawnImpl);
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
    vi.unstubAllEnvs();
  });

  it("relay 激活（SOCKET/NODE/SCRIPT 三 env 齐备）→ 子进程 env 注入归属键 SESSION_ID/RECORD_ID", async () => {
    vi.stubEnv(RELAY_ENV_SOCKET, "/tmp/relay.sock");
    vi.stubEnv(RELAY_ENV_NODE, "node-1");
    vi.stubEnv(RELAY_ENV_SCRIPT, "/tmp/relay.mjs");
    const record = makeRecord("sa-relay");
    const promise = runSpawn(record, "Task: relay-env", makeOpts(), makeCtx());
    await waitForSpawn();

    const call = mockSpawn.mock.calls.at(-1);
    expect(call).toBeDefined();
    const env = call?.[2]?.env as Record<string, string | undefined> | undefined;
    // [E 方案 §5.2-2] tee 帧路由键：SESSION_ID = ctx.sessionRootId、RECORD_ID = record.id
    expect(env?.[RELAY_ENV_SESSION_ID]).toBe("root-session-test");
    expect(env?.[RELAY_ENV_RECORD_ID]).toBe("sa-relay");

    await settleRunSpawn(lastSpawnedChild(), promise);
  });

  it("relay 未激活 → 归属 env 不注入（未激活环境下携带 record 值 env 是误导噪声）", async () => {
    const promise = runSpawn(makeRecord("sa-norelay"), "Task: no-relay", makeOpts(), makeCtx());
    await waitForSpawn();

    const call = mockSpawn.mock.calls.at(-1);
    const env = call?.[2]?.env as Record<string, string | undefined> | undefined;
    expect(env?.[RELAY_ENV_SESSION_ID]).toBeUndefined();
    expect(env?.[RELAY_ENV_RECORD_ID]).toBeUndefined();

    await settleRunSpawn(lastSpawnedChild(), promise);
  });

  it("resume model 无 / 分隔（异常形态回显）→ provider 兜底 unknown，--model 仍可执行", async () => {
    const promise = runSpawn(
      makeRecord("sa-resume-noslash"),
      "Task: resume",
      makeOpts() as RunOptions,
      makeCtx(),
      { sessionFile: "/tmp/prev-session.jsonl", model: "legacy-model-no-slash" },
    );
    await waitForSpawn();

    const call = mockSpawn.mock.calls.at(-1);
    const args = call?.[1] as string[];
    // [U1 D2 豁免] resume 回显不经 registry 断言，无 / 时按 unknown provider 兜底
    //（与 subagent-service record 回读同构）
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("unknown/legacy-model-no-slash");
    // resume 锁定 sessionFile：--session 参数追加
    const sessionIdx = args.indexOf("--session");
    expect(args[sessionIdx + 1]).toBe("/tmp/prev-session.jsonl");

    await settleRunSpawn(lastSpawnedChild(), promise);
  });
});

describe("[S-17a] startGetStateHandshake：[F2] 同步写失败兜底", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
  });

  it("get_state 写 stdin 同步 EPIPE（stdin 已断）→ error 留痕 + 握手立即放弃，close 收尾不被阻塞", async () => {
    // spawn 即返回 stdin 已断语义的 child：对 get_state 命令的 write 同步抛 EPIPE
    //（prompt 命令写入正常，区分 writeStdinLine 的两条调用链）
    mockSpawn.mockImplementation((): ChildProcess => {
      const c = new FakeChild();
      const realWrite = c.stdin.write.bind(c.stdin);
      c.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof chunk === "string" && chunk.includes('"get_state"')) {
          const err = new Error("write EPIPE") as NodeJS.ErrnoException;
          err.code = "EPIPE";
          throw err;
        }
        return realWrite(chunk as Buffer, ...(rest as []));
      }) as typeof c.stdin.write;
      return c as unknown as ChildProcess;
    });

    const record = makeRecord("sa-hs-epipe");
    const promise = runSpawn(record, "Task: hs-epipe", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();
    await new Promise((r) => setImmediate(r));

    // [F2] unhandledRejection 防线：executor 同步异常转 reject 后被 .catch 接住，
    // 错误消息带 EPIPE 语义与冷路径恢复指引
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("get_state handshake failed"),
    );
    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining("EPIPE"));

    // 握手已放弃（abandonHandshake）：close 收尾不被阻塞，runSpawn 正常 resolve
    const result = await settleRunSpawn(child, promise, 0);
    expect(result.success).toBe(true);
    // sessionFile 未回填（握手失败形态，收尾由 existsSync + findSessionFileByHeaderId 兜底）
    expect(record.sessionFile).toBeUndefined();
  });
});
