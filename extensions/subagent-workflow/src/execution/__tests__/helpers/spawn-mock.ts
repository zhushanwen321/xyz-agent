// src/execution/__tests__/helpers/spawn-mock.ts
//
// run-spawn-* 三文件（integration/edges/rpc-mode）共享的 FakeChild + 工具函数。
//
// 背景：vitest 的 vi.mock 会被提升到文件顶部，工厂函数体内**不能引用顶层 import 的变量**
//（vitest 官方文档明确警告）。例外：async 工厂内可用 `await import()`（在模块需求时执行，
// 此时所有模块已加载）。故本 helper 不导出「mock 工厂函数」（无法被 vi.mock 顶层引用），
// 而是导出 **FakeChild class + 工具函数**，让各测试文件的 vi.mock 工厂用 `await import`
// 动态取回 FakeChild。这样每个 vi.mock 工厂从 ~15 行（定义 class + vi.fn）缩到 ~4 行，
// 且 FakeChild 定义只有一个权威来源。
//
// 共享内容（原 ~80 行 × 3 重复）：
//   - FakeChild：EventEmitter + PassThrough stdout/stderr/stdin + kill 记录（class 定义）
//   - lastSpawnedChild(mockSpawn)：从 mock.results 取回最近 spawn 返回的 FakeChild
//   - waitForSpawn(mockSpawn)：轮询等 spawn 被调（比 vi.waitFor 在该 vitest 版本下可靠）
//   - emitStdoutLine / sessionHeader：构造 stdout 行的辅助
//   - makeRecord / makeOpts / makeCtx：构造最小合法的 record/opts/ctx（3 文件一致）
//
// 各测试文件 vi.mock 模式（每文件独立声明，vitest 的 vi.mock 是文件作用域）：
//   ```ts
//   vi.mock("node:child_process", async () => {
//     const { EventEmitter } = await import("node:events");
//     const events = { EventEmitter }; // 兼容旧注释
//     const { FakeChild } = await import("./helpers/spawn-mock.ts");
//     return {
//       spawn: vi.fn(() => new FakeChild()),
//       // buildEnvBlock 用 execFile 异步取 git branch：默认 err-first 兜底（catch → branch=""），
//       // 形态同 worktree-manager.test.ts 的 setupExecFile
//       execFile: vi.fn(
//         (
//           _cmd: string,
//           _args: readonly string[],
//           _opts: unknown,
//           cb: (err: Error | null, stdout?: string, stderr?: string) => void,
//         ) => cb(new Error("execFile not configured in this test")),
//       ),
//     };
//   });
//   vi.mock("node:fs", async () => {
//     const actual = await import("node:fs");
//     return {
//       default: { ...actual, mkdirSync: vi.fn(), existsSync: vi.fn(() => false),
//                   appendFileSync: vi.fn(), writeFileSync: vi.fn(), readdirSync: vi.fn(() => []) },
//       mkdirSync: vi.fn(), existsSync: vi.fn(() => false),
//       appendFileSync: vi.fn(), writeFileSync: vi.fn(), readdirSync: vi.fn(() => []),
//       promises: actual.promises,
//     };
//   });
//   vi.mock("../alive-store.ts", () => ({ writeAliveMarker: vi.fn() }));
//   vi.mock("../temp-prompt.ts", () => ({
//     writePromptToTempFile: vi.fn(async (agent: string) => {
//       const safeName = agent.replace(/[^\w.-]+/g, "_");
//       return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
//     }),
//     cleanupTempPrompt: vi.fn(async () => {}),
//   }));
//   ```

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createRecord } from "../../execution-record.ts";
import type { RunOptions, SessionRunnerContext } from "../../session-runner.ts";

/** FakeChild 的假 pid（满足 ChildProcess.pid 形状，无真实进程语义）。 */
const FAKE_PID = 12345;

/** waitForSpawn 默认超时（ms），超时说明 spawn 未被调（runSpawn 前置 await 卡死）。 */
const WAIT_SPAWN_TIMEOUT_MS = 1000;

/** waitForSpawn 轮询间隔（ms），微任务级等待的粒度。 */
const SPAWN_POLL_INTERVAL_MS = 5;

/**
 * FakeChild：模拟 ChildProcess（EventEmitter + PassThrough streams）。
 *
 * 测试通过 mockSpawn.mock.results.at(-1).value 取回实例，控制 emit data/close/error 时序。
 *
 * 导出 class（而非只在工厂内部定义）是为了：
 *   1. vi.mock 工厂内 `await import("./helpers/spawn-mock.ts")` 后 `new FakeChild()` 与
 *      测试侧 `instanceof FakeChild` / 类型断言用同一个 class。
 *   2. C13 e2e 测试可直接 `new FakeChild()` 手动构造 child 喂给 ui-request-queue（不经 spawn）。
 */
export class FakeChild extends EventEmitter {
  pid = FAKE_PID;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  killSignal: string | undefined;
  kill(sig?: string): boolean {
    this.killed = true;
    this.killSignal = sig;
    return true;
  }
}

/**
 * spawn mock 返回的 fake child 类型（结构子集）。
 *
 * 测试文件优先 import { FakeChild } 用真实 class 类型；此 interface 仅为兼容现有
 * describe 块内 `child: FakeChild` 的类型注解风格（与原代码一致，降低 diff 噪声）。
 */
export interface FakeChildLike {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killed: boolean;
  killSignal: string | undefined;
  kill(sig?: string): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

/**
 * 从最近一次 spawn 调用取回返回的 FakeChild（测试控制器）。
 *
 * @param mockSpawn 调用方用 `vi.mocked(spawn)` 取回的 mock 引用
 */
export function lastSpawnedChild<
  T extends { mock: { results: Array<{ value: ChildProcess | unknown }> } },
>(mockSpawn: T): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as FakeChild;
}

/**
 * 等待 runSpawn 内部调到 spawn（拿到 child 控制器）。
 *
 * runSpawn 是 async，spawn 在 buildEnvBlock + writePromptToTempFile 两个 await 之后才调
 *（均为微任务级延迟）。用 setTimeout 轮询 mockSpawn.mock.results，比 vi.waitFor 在该
 * vitest 版本下更可靠（vi.waitFor 偶发过早 resolve 导致后续读取竞态）。
 *
 * [快照语义] 等待的是「调用时刻之后**新发生**的一次 spawn」，而非「任意历史 spawn」。
 * 旧实现只在 results 为空时等待（即只在文件/测试内首次 spawn 有效）：同一文件第二次
 * runSpawn 时立即返回，而新 runSpawn 尚未跨过 await 到达 spawn → lastSpawnedChild 取回
 * **上一次**的 child，stdout/close 事件发给已死的旧 child，当前 runSpawn 永远收不到
 * close → 测试超时。buildEnvBlock 异步化（多一个 await 微任务）后该隐式时序假设失效，
 * 故改为快照 baseline：等待 results.length 超过调用时的快照值，天然对「每测试/每文件
 * N 次 spawn」都正确（调用前先记 baseline，本次 runSpawn 的 spawn 必然使 length 增长）。
 *
 * @param mockSpawn 调用方用 `vi.mocked(spawn)` 取回的 mock 引用
 */
export async function waitForSpawn<
  T extends { mock: { results: unknown[] } },
>(mockSpawn: T, timeoutMs: number = WAIT_SPAWN_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  const baseline = mockSpawn.mock.results.length;
  while (mockSpawn.mock.results.length <= baseline) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn was not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, SPAWN_POLL_INTERVAL_MS));
  }
}

/** 向 stdout 写一行（自动补换行，runSpawn 按 \n split 行）。 */
export function emitStdoutLine(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 构造 session header 行（stdout 首行）。 */
export function sessionHeader(id = "sess-abc"): Record<string, unknown> {
  return {
    type: "session",
    id,
    timestamp: "2026-07-03T12-00-00-000Z",
    cwd: "/tmp/test",
  };
}

/**
 * 让 sessionFile 存在校验通过——runSpawn 在进程退出后用 existsSync(record.sessionFile)
 * 判断是否补写 identity。默认 mock existsSync 返回 false（兜底查找），此 helper 在指定
 * 路径返回 true。
 */
export function mockSessionFileExists(
  mockExistsSync: { mockImplementation: (fn: (p: unknown) => boolean) => void },
  sessionFilePath: string,
): void {
  mockExistsSync.mockImplementation((p: unknown) => String(p) === sessionFilePath);
}

// ── record / opts / ctx 构造（3 文件一致的最小合法形状）──

/** 构造最小合法的 ExecutionRecord（runSpawn 入参）。 */
export function makeRecord(id = "run-1") {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test-model",
    mode: "sync",
    task: "do something",
    startedAt: 1_000_000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
  });
}

/** 构造最小合法的 RunOptions（runSpawn 入参，可 override 关键字段）。 */
export function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    resolved: {
      model: {
        id: "test-model",
        name: "Test Model",
        provider: "test",
        reasoning: false,
      },
      thinkingLevel: undefined,
    },
    agentConfig: undefined,
    appendSystemPrompt: undefined,
    skillPath: undefined,
    schema: undefined,
    maxTurns: undefined,
    graceTurns: undefined,
    signal: undefined,
    onEvent: undefined,
    ...overrides,
  };
}

/** 构造最小合法的 SessionRunnerContext（runSpawn 入参，可 override 关键字段）。 */
export function makeCtx(overrides: Partial<SessionRunnerContext> = {}): SessionRunnerContext {
  return {
    cwd: "/tmp/test",
    agentDir: "/tmp/test/agents",
    skillDirs: [],
    mainCwd: "/tmp/test",
    mainSessionFile: undefined,
    sessionRootId: "root-session-test",
    rootCwd: "/tmp/test",
    ...overrides,
  };
}
