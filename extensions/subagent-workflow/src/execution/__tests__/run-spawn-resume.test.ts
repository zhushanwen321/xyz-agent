// src/__tests__/run-spawn-resume.test.ts
//
// runSpawn 的 resume 路径测试（M1 基建：重开已结束 session 继续对话）。
//
// 覆盖 M1 拆分 1：runSpawn 第 5 参数 resume（SpawnResumeOpts）→ buildSpawnArgs 追加
// --session <file> + model/thinkingLevel 覆盖 + record.sessionFile 提前锁定（handshake 不覆盖）。
//
// mock 模式与 run-spawn-rpc-mode.test.ts 一致（vi.mock 必须各文件独立声明，工厂内用
// `await import` 取回 FakeChild）。

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    execFileSync: vi.fn(() => ""),
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
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { getChildByRecord, runSpawn, spawnedChildren } from "../session-runner.ts";
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
const mockExistsSync = vi.mocked(fs.existsSync);

const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

/**
 * 取最近一次 spawn 调用收到的 args 数组。
 *
 * getPiInvocation 在测试环境（existsSync 全 mock 默认 false + node 通用运行时）走分支 3，
 * invocation.args === buildSpawnArgs 的完整输出，故此处直接读 spawn 的第二参数。
 */
const lastSpawnArgs = (): string[] => {
  const call = mockSpawn.mock.calls.at(-1);
  if (!call) throw new Error("spawn was not called yet");
  return call[1] as string[];
};

describe("runSpawn resume（M1 基建）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resume 全参数：--session + model(:thinkingLevel) 进 args，且覆盖 opts.resolved", async () => {
    const record = makeRecord();
    const resumeSessionFile = "/sessions/sub/resume-target.jsonl";
    const promise = runSpawn(record, "继续上轮对话", makeOpts(), makeCtx(), {
      sessionFile: resumeSessionFile,
      model: "anthropic/claude-sonnet",
      thinkingLevel: "high",
    });

    await waitForSpawn();
    const child = lastSpawnedChild();

    // resume.sessionFile 文件存在（resume 前提）→ 让 existsSync 对它返回 true，
    // 避免进程退出后兜底查找报错 + identity 补写路径走通。
    mockExistsSync.mockImplementation((p: unknown) => String(p) === resumeSessionFile);
    // 消费 stdin（含 get_state 握手命令 + prompt 命令），避免背压
    child.stdin.on("data", () => {});

    emitStdoutLine(child, { type: "turn_end" });
    child.stdout.end();
    child.emit("close", 0);

    await promise;

    const args = lastSpawnArgs();
    // --session <resumeSessionFile> 紧跟 --session-dir
    const sessionIdx = args.indexOf("--session");
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(args[sessionIdx + 1]).toBe(resumeSessionFile);
    const sessionDirIdx = args.indexOf("--session-dir");
    expect(sessionIdx).toBe(sessionDirIdx + 2);
    // --model 用 resume.model（覆盖 opts.resolved 的 test/test-model），thinkingLevel 作后缀
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("anthropic/claude-sonnet:high");
    // 不应出现 opts.resolved 的 model（证明 resume.model 覆盖生效）
    expect(args).not.toContain("test/test-model");

    // record.sessionFile 提前锁定为 resume 值
    expect(record.sessionFile).toBe(resumeSessionFile);
  });

  it("resume 不传 model/thinkingLevel → --model 回退 opts.resolved", async () => {
    const record = makeRecord();
    const resumeSessionFile = "/sessions/sub/no-model.jsonl";
    const promise = runSpawn(record, "继续", makeOpts(), makeCtx(), {
      sessionFile: resumeSessionFile,
    });

    await waitForSpawn();
    const child = lastSpawnedChild();

    mockExistsSync.mockImplementation((p: unknown) => String(p) === resumeSessionFile);
    child.stdin.on("data", () => {});

    emitStdoutLine(child, { type: "turn_end" });
    child.stdout.end();
    child.emit("close", 0);

    await promise;

    const args = lastSpawnArgs();
    // --session 仍追加
    const sessionIdx = args.indexOf("--session");
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(args[sessionIdx + 1]).toBe(resumeSessionFile);
    // --model 回退 opts.resolved（test/test-model）
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("test/test-model");
  });

  it("resume 时 handshake 仍调但 sessionFile 不被 response 覆盖（提前锁定）", async () => {
    const record = makeRecord();
    const resumeSessionFile = "/sessions/sub/locked.jsonl";
    const promise = runSpawn(record, "继续", makeOpts(), makeCtx(), {
      sessionFile: resumeSessionFile,
      model: "openai/gpt-4o",
    });

    await waitForSpawn();
    const child = lastSpawnedChild();

    mockExistsSync.mockImplementation((p: unknown) => String(p) === resumeSessionFile);

    // 捕获握手发出的 get_state 命令（证明 handshake 仍调），并 emit 一个 sessionFile 不同的
    // response（模拟 handshake 返回新文件路径）→ 验证 record.sessionFile 不被覆盖。
    let getStateSeen = false;
    const conflictingSessionFile = "/sessions/sub/SHOULD-NOT-OVERWRITE.jsonl";
    child.stdin.on("data", (data: Buffer | string) => {
      const text = typeof data === "string" ? data : data.toString();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const cmd = JSON.parse(line) as { type?: string; id?: string };
          if (cmd.type === "get_state" && cmd.id) {
            getStateSeen = true;
            emitStdoutLine(child, {
              type: "response",
              command: "get_state",
              success: true,
              id: cmd.id,
              data: { sessionFile: conflictingSessionFile, sessionId: "rpc-sess" },
            });
          }
        } catch {
          // 非 JSON 行（prompt 命令等）忽略
        }
      }
    });

    // 等 stdin listener 触发 + response 经 stdout pump 处理 → finishHandshake 执行
    await new Promise((r) => setTimeout(r, 20));

    emitStdoutLine(child, { type: "turn_end" });
    child.stdout.end();
    child.emit("close", 0);

    await promise;

    // handshake 确实被调（get_state 命令已发出）
    expect(getStateSeen).toBe(true);
    // 但 record.sessionFile 仍是 resume 锁定值，未被 response 覆盖
    expect(record.sessionFile).toBe(resumeSessionFile);
    expect(record.sessionFile).not.toBe(conflictingSessionFile);
  });
});

// ============================================================
// [M4] spawnedChildren 记账竞态：旧 child close/error 晚于 resume spawn
// ============================================================

describe("[M4] spawnedChildren 记账竞态守卫（旧 child close 晚于 resume spawn）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    spawnedChildren.clear();
  });

  afterEach(() => {
    spawnedChildren.clear();
    vi.restoreAllMocks();
  });

  /**
   * 竞态时序（PR #173 review 组 D）：idle timer 对旧 child 发 SIGTERM（killed=true 但
   * close 事件异步未到）→ deliverMessage 判 child.killed 走冷路径 resumeRound → 新 child
   * spawn 并 set 覆盖注册 → 旧 child 的 close 事件此刻到达。守卫前：close handler 无条件
   * delete(record.id) 误删新注册 → 新活进程脱离记账（killAllSpawnedChildren 漏杀 +
   * 二次 resume 双写 session 文件）。守卫后：按句相等跳过删除。
   */
  it("旧 child close 晚于 resume spawn 到达：不误删新 child 注册（按值守卫）", async () => {
    const record = makeRecord("m4-race-1");
    // 首轮 runSpawn（注册 child1）
    const p1 = runSpawn(record, "first round", makeOpts(), makeCtx());
    await waitForSpawn();
    const child1 = lastSpawnedChild();
    child1.stdin.on("data", () => {});
    expect(getChildByRecord(record.id)).toBe(child1);

    // 模拟 idle timer SIGTERM：killed=true 但 close 事件**未派发**（异步窗口）
    child1.kill("SIGTERM");

    // 冷路径 resume：同 record 第二次 runSpawn，spawn child2 覆盖注册
    const resumeFile = "/sessions/sub/m4-race.jsonl";
    const p2 = runSpawn(record, "resume round", makeOpts(), makeCtx(), {
      sessionFile: resumeFile,
    });
    await waitForSpawn();
    const child2 = lastSpawnedChild();
    child2.stdin.on("data", () => {});
    expect(getChildByRecord(record.id)).toBe(child2);

    // 旧 child1 的 close 事件此刻到达——守卫必须跳过删除
    emitStdoutLine(child1, { type: "turn_end" });
    child1.stdout.end();
    child1.emit("close", 0);
    await p1;

    // 关键断言：新 child2 的注册未被旧 child 的迟到 close 误删
    expect(getChildByRecord(record.id)).toBe(child2);

    // child2 正常退出：close 后注册清理（守卫对当前句柄仍生效）
    mockExistsSync.mockImplementation((p: unknown) => String(p) === resumeFile);
    emitStdoutLine(child2, { type: "turn_end" });
    child2.stdout.end();
    child2.emit("close", 0);
    await p2;
    expect(getChildByRecord(record.id)).toBeUndefined();
  });

  it("旧 child spawn error 晚于 resume spawn 到达：同样不误删新 child 注册", async () => {
    const record = makeRecord("m4-race-2");
    const p1 = runSpawn(record, "first round", makeOpts(), makeCtx());
    await waitForSpawn();
    const child1 = lastSpawnedChild();
    child1.stdin.on("data", () => {});

    const p2 = runSpawn(record, "resume round", makeOpts(), makeCtx(), {
      sessionFile: "/sessions/sub/m4-race-2.jsonl",
    });
    await waitForSpawn();
    const child2 = lastSpawnedChild();
    child2.stdin.on("data", () => {});
    expect(getChildByRecord(record.id)).toBe(child2);

    // 旧 child1 的 error 事件迟到（spawn 失败回调晚到）
    child1.emit("error", new Error("spawn ENOENT (late)"));
    await p1;

    expect(getChildByRecord(record.id)).toBe(child2);

    mockExistsSync.mockImplementation((p: unknown) => String(p) === "/sessions/sub/m4-race-2.jsonl");
    emitStdoutLine(child2, { type: "turn_end" });
    child2.stdout.end();
    child2.emit("close", 0);
    await p2;
    expect(getChildByRecord(record.id)).toBeUndefined();
  });
});
