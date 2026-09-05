// src/execution/__tests__/session-runner-close-prune.test.ts
//
// [LC-6/T6②] 进程 close 接线：waitForChildExit close handler 调 prunePendingCursor
// 剪枝该进程 sessionFile 的 pending 增量游标（session-runner 领地内的单点接线，主
// agent 裁决授权）。
//
// 覆盖：
//   1. close（resume 锁定 sessionFile）后 cursor 被剪枝——行为观察面：覆写同名文件
//      （新 register 行落在旧 offset 之内、size ≥ 旧 offset），判定应从头全量读出
//      新条目；cursor 未剪时会从旧 offset 续读丢掉它。
//   2. sessionFile 未回填（无 resume、无 header 回填）时 close 跳过剪枝不抛错
//      （此时也无 cursor：判定从未发生）。
//
// mock 拓扑对齐 run-spawn-resume.test.ts（FakeChild / fs 部分 mock / temp-prompt /
// alive-store）；session-pending 刻意**不 mock**——接线行为的观察面就是真实游标
// 剪枝语义（statSync/readFileSync 不在 fs mock 名单，走真实 fs）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
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

// [注意] 工厂内必须 importOriginal 拿真 actual——不带它 `await import("node:fs")` 自引用
// 返回 mock 面。命名面先 ...actual 展开（session-pending 的 statSync/readFileSync、
// 测试 fixture 的 mkdtempSync/rmSync 走真实 fs；fixture 写盘走真实透传的
// node:fs/promises——writeFileSync 本身被 mock 隔离 runSpawn 的生产写入），再覆盖
// runSpawn 生产写入面的 5 个方法（隔离 ~/.xyz-agent 生产路径写）。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    ...actual,
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

vi.mock("../engine/engines/pi/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { runSpawn } from "../engine/engines/pi/session-runner.ts";
import { clearPendingCursors, listActivePendingFromSessionFile } from "../session-pending.ts";
import {
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

let sessionDir = "";

function entryLine(customType: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: "custom",
    customType,
    data,
    timestamp: "2026-09-01T00:00:00.000Z",
    id: `e-${Math.random().toString(36).slice(2)}`,
  })}\n`;
}

function registerData(id: string, sessionId: string): Record<string, unknown> {
  return { id, type: "session", name: `desc-${id}`, status: "active", registeredAt: 1, expiresAt: undefined, sessionId };
}

/** resume + close 的最短驱动：spawn 后直接 end stdout + close（handshake 经 abandon 放弃）。 */
async function runToClose(sessionFile: string): Promise<void> {
  const record = makeRecord();
  const promise = runSpawn(record, "Task: close prune", makeOpts(), makeCtx(), {
    sessionFile,
  });
  await waitForSpawn();
  const child = lastSpawnedChild();
  // resume.sessionFile 真实存在 → existsSync 对它 true（identity 补写路径走通）
  mockExistsSync.mockImplementation((p: unknown) => String(p) === sessionFile);
  child.stdin.on("data", () => {}); // 消费 stdin 防背压
  child.stdout.end();
  child.emit("close", 0);
  await promise;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingCursors();
  mockExistsSync.mockReturnValue(false);
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "close-prune-"));
});

afterEach(() => {
  clearPendingCursors();
  vi.restoreAllMocks();
  fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("[LC-6] 进程 close 剪枝 pending 游标", () => {
  it("close 后 cursor 被剪枝：覆写同名文件后判定从头全量读（旧 offset 不残留）", async () => {
    const f = path.join(sessionDir, "closed-proc.jsonl");
    // gen1：15 字节/行 × 10 行 filler → 预建 cursor offset = 150
    const gen1 = Array.from({ length: 10 }, (_, i) => `filler-line-${String(i).padStart(2, "0")}\n`).join("");
    await writeFile(f, gen1); // 真实写盘（同步 writeFileSync 被 mock 隔离生产写入）
    expect(listActivePendingFromSessionFile(f).items).toHaveLength(0); // cursor 建立

    // 覆写（模拟磁盘状态变化）：register bg-y 落在旧 offset（150）之内、size > 150——
    // cursor 未剪时会从 byte 150 续读丢掉它。
    const gen2 =
      entryLine("pending:register", registerData("bg-y", "sess-y")) +
      "filler".padEnd(150, ".") +
      "\n";
    expect(Buffer.byteLength(gen2, "utf-8")).toBeGreaterThan(150);
    await writeFile(f, gen2);

    await runToClose(f); // resume 锁定 sessionFile → close handler 剪枝

    const items = listActivePendingFromSessionFile(f).items;
    expect(items.map((i) => i.id)).toEqual(["bg-y"]); // 剪枝生效：从头全量读
  });

  it("sessionFile 未回填（无 resume/无 header）时 close 跳过剪枝，流程正常完成", async () => {
    const record = makeRecord();
    const promise = runSpawn(record, "Task: no sessionFile", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();
    child.stdin.on("data", () => {});
    child.stdout.end();
    child.emit("close", 0);
    // sessionFile undefined → guard 跳过（不抛错）；record.sessionFile 保持未回填
    await expect(promise).resolves.toBeDefined();
    expect(record.sessionFile).toBeUndefined();
  });
});
