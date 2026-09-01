// src/__tests__/run-spawn-edges.test.ts
//
// runSpawn 的 stdout 边界与 orphan 进程兜底集成测试（从 run-spawn-integration.test.ts 拆出）。
//
// 本文件覆盖：
//   - [C1] orphan 进程兜底：killAllSpawnedChildren 对未退出 child 发 SIGTERM。
//   - [M8] stdout 边界：损坏行（非法 JSON / 缺 type）静默忽略 + 残留尾行（close 前无 \n）
//     由 close handler 再 parse。
//   - [agent_end] rpc 长驻进程自然完成：agent_end（willRetry=false）→ kill SIGTERM 触发 close。
//
// mock 工厂 + FakeChild + 工具函数共享自 helpers/spawn-mock.ts（详见该文件头注释）。
// vi.mock 必须各文件独立声明（文件作用域），工厂内用 `await import` 取回 FakeChild。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// [LC-9/T7②] Mock 共享 logger：stdout invalid 行的 debug 留痕可被断言
//（对齐 channel-registry-handshake.test.ts 模式；vi.mock 自动 hoist 到 import 前）。
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
  // [T5②] keep-alive 心跳刷新读取现有 marker id（缺失兜底 record.id）
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
}));

// [recursive-orchestration] agent_end 后代判定独立 mock（判定函数本身在 session-pending.test.ts 单独测）。
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 0 })),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS, killAllSpawnedChildren, runSpawn, spawnedChildren, WAKEUP_GRACE_MS, maxTurnsToWatchdogMs, SPAWN_WATCHDOG_ENV } from "../session-runner.ts";
import { writeAliveMarker } from "../alive-store.ts";
import { getSubagentSessionDir } from "../path-encoding.ts";
import { readActivePendingFromSessionFile } from "../session-pending.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  sessionHeader,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(fs.existsSync);

// 绑定到本文件 mockSpawn 的 lastSpawnedChild/waitForSpawn（需读 mockSpawn.mock.results）
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

// ============================================================
// 测试
// ============================================================

describe("runSpawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // existsSync 默认 false（sessionFile 不存在兜底路径）
    mockExistsSync.mockReturnValue(false);
    // [F-4 假红源修复] env 隔离：makeOpts 默认 maxTurns=undefined →
    // resolveSpawnWatchdogMs 走 env 兑底分支，宿主 export SPAWN_WATCHDOG 即假红。
    // 空串 = 未设（raw falsy 判定）；MF-4b 用例内的手动 save/delete/restore 与本
    // stub 兼容（finally 恢复到 stub 值，语义不变）。
    vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── 1. orphan 进程兜底（C1）──
  //
  // [C1] runSpawn 把每个 spawned child（sync + background）注册到模块级 spawnedChildren Set。
  // SubagentService.dispose 调 killAllSpawnedChildren 遍历该 Set 对仍存活的子进程发 SIGTERM，
  // 覆盖 sync 子进程（controller=undefined，abortRunningControllers 跳过它）。
  //
  // 关键验证：
  //   1. child 退出（close/error）后从 Set 移除 → killAllSpawnedChildren 不重复 kill。
  //   2. child 未退出时 killAllSpawnedChildren → child.kill("SIGTERM") 被调。
  //   3. 已 kill 的 child 二次调用无害（killAllSpawnedChildren 跳过 killed=true 的）。
  describe("orphan 进程兜底 (C1)", () => {
    it("未退出的 child → killAllSpawnedChildren 对它发 SIGTERM", async () => {
      const record = makeRecord();
      // 不 await——runSpawn 内部 await 子进程 close，killAllSpawnedChildren 测试在 close 前
      const promise = runSpawn(record, "Task: orphan", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // spawn 后 child.killed 应为 false（尚未被 kill）
      expect(child.killed).toBe(false);

      // dispose 兜底：killAllSpawnedChildren 应 kill 未退出的 child
      const n = killAllSpawnedChildren();
      expect(n).toBeGreaterThanOrEqual(1);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn resolve（避免悬挂）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143);

      const result = await promise;
      expect(result.success).toBe(true); // 信号终止视为正常完成
    });

    it("已 close 的 child → 从 Set 移除，killAllSpawnedChildren 不重复 kill", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: closed", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // 子进程正常退出
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;
      expect(child.killed).toBe(false); // 正常退出未触发 kill

      // close 后 child 已从 Set 移除；再调 killAllSpawnedChildren 不会 kill 它
      const n = killAllSpawnedChildren();
      expect(n).toBe(0);
      expect(child.killed).toBe(false);
    });

    it("多个未退出 child（sync + bg）→ killAllSpawnedChildren 全部 kill", async () => {
      // spawn 两个 child（模拟 sync + background 并发），都未退出。
      const rec1 = makeRecord("spawn-c1");
      const p1 = runSpawn(rec1, "Task: c1", makeOpts(), makeCtx());
      await waitForSpawn();
      const c1 = lastSpawnedChild();

      const rec2 = makeRecord("spawn-c2");
      const p2 = runSpawn(rec2, "Task: c2", makeOpts(), makeCtx());
      // waitForSpawn 是快照语义（记 baseline 等新 spawn），天然支持二次等待
      await waitForSpawn();
      const c2 = lastSpawnedChild();

      // c1 和 c2 是不同实例
      expect(c1).not.toBe(c2);
      expect(c1.killed).toBe(false);
      expect(c2.killed).toBe(false);

      // dispose 兜底 kill 两个
      const n = killAllSpawnedChildren();
      expect(n).toBeGreaterThanOrEqual(2);
      expect(c1.killed).toBe(true);
      expect(c2.killed).toBe(true);

      // 收尾
      for (const { child, promise } of [
        { child: c1, promise: p1 },
        { child: c2, promise: p2 },
      ]) {
        emitStdoutLine(child, sessionHeader());
        child.stdout.end();
        child.emit("close", 143);
        const r = await promise;
        expect(r.success).toBe(true);
      }
    });

    // [dispose-cleanup Minor 优化2] killAllSpawnedChildren 末尾 clear spawnedChildren Set。
    // 防主进程崩溃/close 事件漏触发时 Set 无限增长。正常路径 close 事件会 delete（保留 per-child
    // 精细清理语义）；killAllSpawnedChildren 是 dispose 全量兼底。
    it("killAllSpawnedChildren 后 spawnedChildren Set 被 clear（size===0）", async () => {
      // 前置清理：即他测试可能残留的 child（close 未触发场景）
      killAllSpawnedChildren();
      expect(spawnedChildren.size).toBe(0);

      // spawn 两个未 close 的 child（模拟 close 事件漏触发的极端累积场景）
      const rec1 = makeRecord("clear-c1");
      const p1 = runSpawn(rec1, "Task: clear-1", makeOpts(), makeCtx());
      await waitForSpawn();
      const c1 = lastSpawnedChild();

      const rec2 = makeRecord("clear-c2");
      const p2 = runSpawn(rec2, "Task: clear-2", makeOpts(), makeCtx());
      // 快照语义二次等待：等 rec2 的 runSpawn 调到 spawn
      await waitForSpawn();
      const c2 = lastSpawnedChild();

      // 两个 child 都在 Set 中
      expect(spawnedChildren.size).toBe(2);

      // dispose 兼底：kill + clear
      const n = killAllSpawnedChildren();
      expect(n).toBe(2);
      expect(c1.killed).toBe(true);
      expect(c2.killed).toBe(true);
      // Set 被 clear（兑底防泄漏）
      expect(spawnedChildren.size).toBe(0);

      // 再次调用：Set 已空，返回 0（不会重复 kill 已 kill 的 child）
      const n2 = killAllSpawnedChildren();
      expect(n2).toBe(0);

      // 收尾
      for (const { child, promise } of [
        { child: c1, promise: p1 },
        { child: c2, promise: p2 },
      ]) {
        emitStdoutLine(child, sessionHeader());
        child.stdout.end();
        child.emit("close", 143);
        const r = await promise;
        expect(r.success).toBe(true);
      }
    });
  });

  // ── 2. stdout 边界：损坏行 + 残留尾行 (M8) ──
  //
  // [M8] runSpawn 的 stdout 解析容错：
  //   - parseSpawnLine 对「非法 JSON」「合法 JSON 但缺 type 字段」归为 kind:"invalid"。
  //   - runSpawn 的 data 处理器只认 header/event 两类，invalid 行不中断事件流。
  //     [LC-9/T7②] 起不再静默：per-child 计数 + debug 级前 3 条样本留痕，close 时
  //     聚合输出总数与样本（「事件行损坏被静默丢弃」曾使 LC-1 形态 (c) 无法排查）。
  //   - close 前 stdoutBuffer 若残留未以 \n 结尾的合法 event 行，close handler 会再 parse
  //     一次（L574-579）——覆盖子进程末行漏 \n 的场景；残留 invalid 行同计统计。
  describe("stdout 边界：损坏行 + 残留尾行 (M8)", () => {
    it("stdout 夹杂非法 JSON 行 → 该行被忽略，合法 turn_end 正常计数（不抛错）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: garbage", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 非法 JSON 行（如 pi 的调试输出 / 进度条残片）—— parseSpawnLine 归为 invalid
      child.stdout.write("this is not json\n");
      // 合法 turn_end 事件
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 非法行被忽略，仅 turn_end 计数
    });

    // [LC-9/T7②] invalid 行可观测性：计数 + debug 样本 + close 聚合，不再零可见。
    it("[LC-9] invalid 行计数留痕：前 3 条逐条 debug 样本 + close 聚合总数（不刷屏）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: invalid-obs", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.write("garbage-line-1\n");
      child.stdout.write('{"foo":"bar"}\n'); // 缺 type 字段的合法 JSON，同归 invalid
      child.stdout.write("garbage-line-3\n");
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 容错行为不变：invalid 不中断事件流

      const debugMsgs = loggerMock.debug.mock.calls.map((c) => String(c[0]));
      // 前 3 条逐条样本（含原始行内容，可定位是哪行损坏）
      const sampleMsgs = debugMsgs.filter((m) => m.includes("stdout invalid line #"));
      expect(sampleMsgs).toHaveLength(3);
      expect(sampleMsgs[0]).toContain("#1");
      expect(sampleMsgs[0]).toContain("garbage-line-1");
      expect(sampleMsgs[1]).toContain('{"foo":"bar"}');
      expect(sampleMsgs[2]).toContain("garbage-line-3");
      // close 聚合：总数一次暴露（processTrailingLine 由 close handler 必经）
      const aggMsgs = debugMsgs.filter((m) => m.includes("invalid line(s) dropped in total"));
      expect(aggMsgs).toHaveLength(1);
      expect(aggMsgs[0]).toContain("3 invalid line(s)");
    });

    it("[LC-9] invalid 行超过样本上限（5 条）→ 样本 debug 恰 3 条（防刷屏）+ 聚合仍报全量 5", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: invalid-flood", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      for (let i = 1; i <= 5; i++) {
        child.stdout.write(`flood-${i}\n`);
      }
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;
      expect(result.success).toBe(true);

      const debugMsgs = loggerMock.debug.mock.calls.map((c) => String(c[0]));
      const sampleMsgs = debugMsgs.filter((m) => m.includes("stdout invalid line #"));
      expect(sampleMsgs).toHaveLength(3); // MAX_INVALID_LINE_SAMPLES=3，第 4/5 条仅累计
      const aggMsgs = debugMsgs.filter((m) => m.includes("invalid line(s) dropped in total"));
      expect(aggMsgs).toHaveLength(1);
      expect(aggMsgs[0]).toContain("5 invalid line(s)"); // 聚合不丢全量计数
    });

    it("[LC-9] 残留尾行为 invalid（无 \\n 结尾的损坏行）→ close handler 同计统计", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: tail-invalid", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 无 \n 的损坏行：同步 emit（同上方残留用例的时序原理）残留在 stdoutBuffer，
      // 由 close handler 的 processTrailingLine 再 parse。
      child.stdout.emit("data", "not-json-tail");
      child.emit("close", 0);

      const result = await promise;
      expect(result.success).toBe(true);

      const debugMsgs = loggerMock.debug.mock.calls.map((c) => String(c[0]));
      const aggMsgs = debugMsgs.filter((m) => m.includes("invalid line(s) dropped in total"));
      expect(aggMsgs).toHaveLength(1);
      expect(aggMsgs[0]).toContain("1 invalid line(s)");
      expect(aggMsgs[0]).toContain("not-json-tail"); // 聚合携带样本
    });

    it("stdout 夹杂合法 JSON 但缺 type 字段 → 该行被忽略，不抛错", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: notype", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 合法 JSON 但无 type 字段 —— parseSpawnLine 归为 invalid（"missing string 'type'"）
      child.stdout.write('{"foo":"bar"}\n');
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 无 type 行被忽略
    });

    it("残留尾行（close 前未以 \\n 结尾的合法 event）→ close handler 再 parse 处理", async () => {
      // 覆盖 session-runner.ts L574-579：close 前 stdoutBuffer 残留的合法 event 行。
      //
      // 关键：不能用 emitStdoutLine（它会补 \n，残留行在 data 处理器就被 split 消费了，
      // 走不到 close handler 的残留 parse 分支）。需同步 emit data（无 \n）确保该行
      // 残留在 stdoutBuffer 直到 close handler 处理。
      //
      // 同步 emit 的必要性：PassThrough 的 .write() 会把 data flush 排到后续微任务，
      // 若先 .write() 再 emit("close")，close listener 同步执行时 stdoutBuffer 仍为空
      // → 残留逻辑被跳过 → turnCount=0（测出真实 bug 风险）。直接 emit("data", ...) 同步
      // 触发 data 处理器，使行残留在 buffer（split("\n") 无换行 → pop 回 buffer），close
      // handler 才能捕到它。
      const record = makeRecord();
      const promise = runSpawn(record, "Task: tail", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 合法 turn_end 但不带末尾 \n：同步 emit（绕过 write 的异步 flush）。
      // data 处理器把它整体留在 stdoutBuffer（无 \n → split 后 pop 回 buffer），
      // 由 close handler 的残留 parse 逻辑（L574-579）处理。
      child.stdout.emit("data", JSON.stringify({ type: "turn_end" }));
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 残留尾行被 close handler 正确解析
    });

    it("同一 JSON 行跨 3 次 data 事件分片 → stdoutBuffer 字符串拼接后正确解析", async () => {
      // 覆盖 stdoutBuffer += data 的字符串拼接（setEncoding("utf8") 后 data 收到 string，
      // 非 Buffer）。拆成 3 片写入（跨 type 字段名边界 + 跨 turn_end 值边界），验证拼接无误。
      // .write() 的异步 flush 在 await promise（resolve 排在 data 微任务之后）前完成。
      const record = makeRecord();
      const promise = runSpawn(record, "Task: split3", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.write('{"typ');
      child.stdout.write('e":"turn_en');
      child.stdout.write('d"}\n');
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 3 片拼接后解析为 1 次 turn_end
    });
  });

  // ── 3. agent_end 自然完成（rpc 长驻进程不自动退出，需主动 kill）──
  //
  // [rpc agent_end] pi --mode rpc 是长驻进程（runRpcMode 末尾 return new Promise(() => {})），
  // 处理完 prompt 后不退出。runSpawn 只靠 child.on("close") 判完成——如果不处理 agent_end，
  // 子进程会卡到 watchdog 30 分钟兜底 kill。修复：收到 agent_end（willRetry=false）后
  // 主动 child.kill("SIGTERM") 让子进程退出，触发 close → runSpawn resolve。
  // willRetry=true 时 agent 会重试，不能 kill。
  describe("agent_end 自然完成", () => {
    // [recursive-orchestration] 条件 kill：agent_end 时读子进程 session 文件算活跃后代
    // （pending:register − unregister 差集）。有活跃后代 → 保持进程 idle 等 steer 唤醒。
    const mockPending = vi.mocked(readActivePendingFromSessionFile);

    // [MF-3] recentUnregister 竞态分支的秒级宽限：count=0 + recentUnregister=true → keep alive
    // 挂 WAKEUP_GRACE_MS（15s）定时器，到期无新 agent_end（未被唤醒）即 kill。
    // 背景：旧实现挂固定 2h（WAIT_DESCENDANT_TIMEOUT_MS）——层主 closeout 的最终 agent_end
    // 距最后一次 unregister <60s 必命中此分支，空等 2h 才 kill + 冒牌完成通知级联。
    it("MF-3: agent_end（count=0 + recentUnregister）→ 15s 宽限到期后 kill", async () => {
      mockPending.mockReturnValue({ count: 0, recentUnregister: true });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: wake-grace", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // 必须在 emit agent_end 之前启用 fake timers——keep-alive 定时器在 agent_end 处理器里
      // 新建，新建时若已是 fake 定时器才可被 advance。不 fake setImmediate：stream .write() 的
      // data flush 靠真实事件循环（微任务/nextTick）交付，用真实 setImmediate 让出事件循环。
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        emitStdoutLine(child, sessionHeader());
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        // 让事件 pump 处理 agent_end（stream flush 是异步的）
        await new Promise((r) => setImmediate(r));
        // keep alive：宽限挂起，不 kill
        expect(child.killed).toBe(false);

        // 宽限未到（14999ms）：仍不 kill
        await vi.advanceTimersByTimeAsync(WAKEUP_GRACE_MS - 1);
        expect(child.killed).toBe(false);

        // 第 15000ms 到期：无新 agent_end（未被唤醒）→ kill
        await vi.advanceTimersByTimeAsync(1);
        expect(child.killed).toBe(true);
        expect(child.killSignal).toBe("SIGTERM");

        // 收尾：close 让 runSpawn resolve
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 143);

        const result = await promise;
        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [MF-3] 唤醒重评估：宽限挂起期间父被 steer 唤醒（续跑产出新一轮）→ 下一次 agent_end
    // 重新判定；此时后代已完成（count=0，recentUnregister=false）→ 正常 kill，不等宽限到期。
    it("MF-3: 宽限期内被唤醒 → 下一次 agent_end 重新评估（后代已完成 → kill）", async () => {
      mockPending
        .mockReturnValueOnce({ count: 0, recentUnregister: true })
        .mockReturnValueOnce({ count: 0, recentUnregister: false });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: wake-then-done", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        emitStdoutLine(child, sessionHeader());
        // 第一次 agent_end：recentUnregister 竞态 → keep alive（宽限挂起）
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        await new Promise((r) => setImmediate(r));
        expect(child.killed).toBe(false);

        // 被唤醒后父续跑产出新一轮 agent_end：后代已 unregister → 立即 kill（不等宽限）
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        await new Promise((r) => setImmediate(r));
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

    // [MF-4] count>0 分支的动态超时：等待超时 = maxTurnsToWatchdogMs(maxTurns)，非固定 2h。
    // maxTurns=20 → 20×5min = 100min 到期 kill。若回归到固定 2h 常量，100min 处不会 kill，
    // 本用例 advance(maxTurnsToWatchdogMs − 1) 后仍不 kill、再 +1 才 kill 的断言会失败。
    it("MF-4: agent_end（count>0）→ 等待超时 = maxTurnsToWatchdogMs(maxTurns)（动态，非固定 2h）", async () => {
      const maxTurns = 20;
      const expected = maxTurnsToWatchdogMs(maxTurns);
      mockPending.mockReturnValue({ count: 2 });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: slow-desc", makeOpts({ maxTurns }), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        emitStdoutLine(child, sessionHeader());
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        await new Promise((r) => setImmediate(r));
        // keep alive：动态超时挂起，不 kill
        expect(child.killed).toBe(false);

        // 未到动态超时（100min−1ms）：不 kill
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(child.killed).toBe(false);

        // 动态超时到期：kill。若误用固定 2h，此处不会 kill → 用例失败
        await vi.advanceTimersByTimeAsync(1);
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

    // [MF-4b] 预算语义对齐 + [T2-① / P-T2 降级 B]：maxTurns 未传且无兑底 env → count>0
    // 分支不 re-arm 固定时长 watchdog，改挂**无进展检测上界**——连续静默达
    // KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS 才处置，期间任何 stdout 活动刷新计时。
    // 原守护意图保留：若误回旧 50min 估算默认（固定时长、不刷新），活动刷新后 51min
    // 处早已 kill，本用例失败。
    it("MF-4b: agent_end（count>0）+ maxTurns 未传 → 无进展检测上界（活动刷新不限时，纯静默有界）", async () => {
      // hermetic：确保兑底 env 未设（若外层 shell 误设会让「裸缺省」断言失效）
      const prevWatchdogEnv = process.env[SPAWN_WATCHDOG_ENV];
      delete process.env[SPAWN_WATCHDOG_ENV];
      mockPending.mockReturnValue({ count: 2 });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: slow-desc-no-turns", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        emitStdoutLine(child, sessionHeader());
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        await new Promise((r) => setImmediate(r));
        // keep alive：不 kill
        expect(child.killed).toBe(false);

        // 静默 29min：未达无进展阈值，不 kill
        await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS - 60_000);
        expect(child.killed).toBe(false);

        // 子进程活动（输出一行）：静默计时刷新。若误回旧 50min 估算默认（固定时长
        // 不刷新），此点之后不久会 kill——51min 断言守护该回归
        emitStdoutLine(child, { type: "message_end", message: {} });
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS - 60_000);
        expect(child.killed).toBe(false);

        // 再次活动刷新（此刻距上次活动 29min < 30min 阈值），随后静默 21min——总时钟
        // 已 >51min 仍不 kill = 无固定时长上限（原守护点：误回旧 50min 估算默认则此处
        // 已 kill）；距最近一次活动静默 21min < 30min 阈值。
        emitStdoutLine(child, { type: "message_end", message: {} });
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(21 * 60 * 1000);
        expect(child.killed).toBe(false);

        // 连续静默达阈值（最后一次活动后 30min 无任何输出）：有界回收（新契约）。
        // 本段 advance 跨过 SIGTERM 后的 30s 升级点（escalation 语义：FakeChild 未退出），
        // killSignal 已升级为 SIGKILL。
        await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
        expect(child.killed).toBe(true);
        expect(child.killSignal).toBe("SIGKILL");

        child.stdout.end();
        child.stderr.end();
        child.emit("close", 143);

        const result = await promise;
        expect(result.success).toBe(true);
      } finally {
        if (prevWatchdogEnv !== undefined) process.env[SPAWN_WATCHDOG_ENV] = prevWatchdogEnv;
        vi.useRealTimers();
      }
    });

    // [S-9] pending.error 分支（sessionFile 不可读 → 保守 keep-alive + re-arm dynamic watchdog）
    // 集成行为 guard：session-pending 单测覆盖 error 返回值，但 session-runner 的 no-kill +
    // re-arm 到 maxTurnsToWatchdogMs(maxTurns) 行为无集成 guard。若 re-arm 误删/误用固定超时，
    // 保守 keep-alive 会退化成永久挂起或被固定超时误杀。
    it("S-9: agent_end（count=0 + error）→ 保守不 kill + watchdog re-arm 到动态超时", async () => {
      const maxTurns = 20;
      const expected = maxTurnsToWatchdogMs(maxTurns);
      mockPending.mockReturnValue({ count: 0, error: "session file unreadable: EACCES" });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: unreadable", makeOpts({ maxTurns }), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        emitStdoutLine(child, sessionHeader());
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        await new Promise((r) => setImmediate(r));
        // 保守策略：sessionFile 不可读时不 kill（宁可空等也不误杀有后代的进程）
        expect(child.killed).toBe(false);

        // watchdog re-arm 到动态超时（maxTurnsToWatchdogMs(maxTurns)），未到期不 kill
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(child.killed).toBe(false);

        // 动态超时到期：kill。若 error 分支漏了 re-arm（或误用固定超时），此断言失败
        await vi.advanceTimersByTimeAsync(1);
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

    it("agent_end（willRetry=false，无活跃后代）→ child.kill(SIGTERM) 被调用，close 后 success=true", async () => {
      mockPending.mockReturnValue({ count: 0 });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: done", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // agent 自然完成（willRetry=false）
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      child.stdout.end();
      child.stderr.end();
      // agent_end 触发 kill(SIGTERM) → 子进程退出（exitCode 143 = 128+15）
      child.emit("close", 143);

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // 信号终止（>=128）视为正常完成
      expect(result.success).toBe(true);
    });

    it("agent_end（willRetry=false，有活跃后代）→ 不 kill，进程保持 idle 等 steer 唤醒；后代完成后 kill", async () => {
      // 第一次 agent_end：有活跃后代（count=1）→ 不 kill
      mockPending.mockReturnValueOnce({ count: 1 });
      // 第二次 agent_end：后代已 unregister（count=0）→ kill
      mockPending.mockReturnValueOnce({ count: 0 });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: orchestrate", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      // 给事件 pump 一点时间处理 agent_end（判定读 session 文件）
      await new Promise((r) => setTimeout(r, 20));
      expect(child.killed).toBe(false);

      // 后代完成（unregister 已写入）后再次 agent_end → 无活跃后代 → kill
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      expect(result.success).toBe(true);
    });

    it("agent_end（willRetry=true）→ child.kill 不被调用（agent 会重试，等下一个 agent_end）", async () => {
      mockPending.mockReturnValue({ count: 0 });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: retry", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // willRetry=true：agent 会重试，不应 kill
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: true });
      // 此时 child.killed 应仍为 false。给一点时间让 event pump 处理完。
      await new Promise((r) => setTimeout(r, 10));
      expect(child.killed).toBe(false);

      // 收尾：模拟重试后的最终完成（willRetry=false）
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);

      const result = await promise;

      // 最终的 agent_end（willRetry=false）触发 kill
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      expect(result.success).toBe(true);
    });

    it("agent_end 后的后续 event 仍被 handleSdkEvent 处理（kill 不阻塞 event pump）", async () => {
      mockPending.mockReturnValue({ count: 0 });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: flush", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // agent_end kill 是 fire-and-forget（SIGTERM 异步），后续 stdout 行仍被 event pump 处理
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      emitStdoutLine(child, { type: "turn_end" }); // kill 后的 turn_end 仍应被处理
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(result.success).toBe(true);
      // turn_end 被处理 → turnCount=1
      expect(record.turnCount).toBe(1);
    });
  });

  // ── 4. [T1/RC-1+RC-2] agent_end 惰性回补 + [T1/LC-4] 收尾反查 ──
  //
  // RC-1：RPC mode 的 get_state 握手一次性（7s 预算耗尽永不再试），sessionFile 成为
  // 永久缺失。T1 双管：
  //   ① agent_end 决策点发现 sessionFile 缺失 → 现场单次 get_state（idle 子进程毫秒级
  //      应答，探针 P-T1）回填后走正常三分支；
  //   ② 回补失败不重试 → 既有保守分支（行为不劣化）；
  //   ③ close 收尾 findSessionFileByHeaderId 兜底移出 if (record.sessionFile) 守卫——
  //      「sessionId 有、sessionFile 无」形态（两字段独立采集）也做 sessionDir 反查。
  //
  // 测试形态：不 emit header（RPC mode）→ record.sessionFile 只能靠 get_state 回填。
  // stdin 上第 1 个 get_state 是 spawn 握手（测试不回应 = 握手失败），第 2 个是 agent_end
  // 惰性回补（按用例决定回应与否）。
  describe("[T1] agent_end 惰性回补 + LC-4 收尾反查", () => {
    const mockPending = vi.mocked(readActivePendingFromSessionFile);
    const mockWriteAliveMarker = vi.mocked(writeAliveMarker);
    const mockReaddirSync = vi.mocked(fs.readdirSync);

    /** 统计 stdin 收到的 get_state 请求数（握手 1 次 + agent_end 惰性回补 1 次）。 */
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

    /** 只对第 N 次（1-based）get_state 回应 response（其余不回应 = 握手失败）。 */
    function respondToNthGetState(
      child: FakeChild,
      nth: number,
      data: Record<string, unknown>,
    ): void {
      let seen = 0;
      child.stdin.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString();
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let cmd: { type?: string; id?: string };
          try {
            cmd = JSON.parse(line) as { type?: string; id?: string };
          } catch {
            continue;
          }
          if (cmd.type !== "get_state" || !cmd.id) continue;
          seen++;
          if (seen === nth) {
            emitStdoutLine(child, {
              type: "response",
              command: "get_state",
              success: true,
              id: cmd.id,
              data,
            });
          }
        }
      });
    }

    /** 轮询等待条件（真实 timers；vi.waitFor 在本 vitest 版本下偶发过早，见 spawn-mock 注释）。 */
    async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error("condition not met within timeout");
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    // ① 握手失败（sessionFile 空）→ agent_end 惰性 get_state 回填 → 正常三分支（final kill）
    it("① 握手失败 sessionFile 缺失 → agent_end 惰性 get_state 回填 → 无后代走 final kill（非保守不杀）", async () => {
      // 回补成功后判定：无活跃后代 → final kill 分支（若仍走保守分支则不会 kill，断言失败）
      mockPending.mockReturnValue({ count: 0 });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: lazy-backfill", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();
      const counter = countGetStateRequests(child);
      // 第 1 个 get_state（spawn 握手）不回应；第 2 个（agent_end 惰性回补）回应完整数据
      const expectedSessionFile =
        "/tmp/test/agents/subagents/--tmp-test--/sessions/lazy-backfill.jsonl";
      respondToNthGetState(child, 2, {
        sessionFile: expectedSessionFile,
        sessionId: "lazy-sess",
      });

      // 不 emit header（RPC mode 形态）：agent_end 时 record.sessionFile 缺失
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });

      // 决策点异步：惰性 get_state → 回填 → readActivePending(count=0) → final kill
      await waitFor(() => child.killed);
      expect(child.killSignal).toBe("SIGTERM");

      // 回填落地：record.sessionFile + alive marker（对齐 finishHandshake 回填面）
      expect(record.sessionFile).toBe(expectedSessionFile);
      expect(mockWriteAliveMarker).toHaveBeenCalledWith(
        expectedSessionFile,
        expect.objectContaining({ pid: child.pid, id: "lazy-sess" }),
      );
      // 惰性请求确实发出：握手 1 次 + agent_end 惰性 1 次
      expect(counter.seen).toBeGreaterThanOrEqual(2);

      // 收尾：close 让 runSpawn resolve
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.sessionFile).toBe(expectedSessionFile);
    });

    // ② 回补超时/失败 → 仍走保守分支（行为不劣化）
    it("② 回补无响应超时 → record.sessionFile 仍缺失 → 保守不杀（不劣化为 final kill）", async () => {
      // mock 判定：sessionFile 缺失形态返回 error（真实现语义，见 session-pending.ts:85）
      mockPending.mockReturnValue({ count: 0, error: "no sessionFile (handshake not settled)" });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: lazy-timeout", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();
      const counter = countGetStateRequests(child);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        // stdin flush 依赖真实事件循环（setImmediate 不 fake）：决策点已发出惰性 get_state
        await new Promise((r) => setImmediate(r));
        // 惰性请求已发出（握手 1 + 惰性 1），但无人回应
        expect(counter.seen).toBe(2);
        expect(child.killed).toBe(false);

        // 1s 回补预算到期：空结果 → 不重试 → readActivePending error → 保守分支
        await vi.advanceTimersByTimeAsync(1000);
        expect(record.sessionFile).toBeUndefined();
        expect(child.killed).toBe(false); // 保守不杀

        // maxTurns 未传（opts 默认）+ env 未设 → 保守分支挂无进展检测上界
        // [T2-① / P-T2 降级 B] 不再「不限时」：连续静默达阈值才处置；此处静默
        // 29min（< 30min 阈值）不 kill——保守 keep-alive 仍有界但不被时长误杀
        await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS - 60_000);
        expect(child.killed).toBe(false);

        child.stdout.end();
        child.stderr.end();
        child.emit("close", 143);
        const result = await promise;
        // 进程最终由 close 收尾（保守分支不吞掉 runSpawn 的完成）
        expect(result.success).toBe(true);
        expect(record.sessionFile).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    // ③ [T1/LC-4] sessionId 有 + sessionFile 无 → close 收尾 findSessionFileByHeaderId 可达
    // 形态说明：握手只回 sessionId 时握手自身 7s 预算耗尽才 settle（其 timer 创建于
    // useFakeTimers 之前，fake advance 驱不动）——本用例经 agent_end 惰性回补只回
    // sessionId，同产「handshakeResult.sessionId 有、record.sessionFile 无」形态，
    // 且顺带覆盖惰性回补的 sessionId 补入 handshakeResult 分支（close 收尾 lookupId 源）。
    it("③ LC-4: 惰性回补只回 sessionId（sessionFile 仍无）→ close 收尾 sessionDir 反查修正 record.sessionFile", async () => {
      // sessionFile 缺失 → 决策点惰性回补；回补判定保守（error → 不杀）
      mockPending.mockReturnValue({ count: 0, error: "no sessionFile (handshake not settled)" });
      const record = makeRecord();
      const promise = runSpawn(record, "Task: lc4-lookup", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();
      // 第 2 个 get_state（惰性回补）只回 sessionId（两字段独立采集的 RC-1 残余形态）
      respondToNthGetState(child, 2, { sessionId: "sess-lc4" });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
        // flush：惰性 get_state 写出 + response 回流 → 回补拿到 sessionId（无 sessionFile）
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(1000); // 回补预算到期兜底（response 已先行到达）

        // 保守分支：sessionFile 仍缺失 → 不杀（LC-4 修复前的死路：无任何反查可达）
        expect(record.sessionFile).toBeUndefined();
        expect(child.killed).toBe(false);

        // 兜底查找的目录命中项：文件名格式 <timestamp>_<sessionId>.jsonl
        const ctx = makeCtx();
        const sessionDir = getSubagentSessionDir(ctx.agentDir, ctx.rootCwd);
        const matchedName = "20260901T12000000_sess-lc4.jsonl";
        mockReaddirSync.mockReturnValue([matchedName, "unrelated_other.jsonl"]);

        // close 收尾：lookupId = handshakeResult.sessionId（惰性回补补入）→ 反查命中
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
        await promise;

        const expected = path.join(sessionDir, matchedName);
        expect(record.sessionFile).toBe(expected);
        // findSessionFileByHeaderId 真实执行过（readdirSync 收到 sessionDir）
        expect(mockReaddirSync).toHaveBeenCalledWith(sessionDir);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
