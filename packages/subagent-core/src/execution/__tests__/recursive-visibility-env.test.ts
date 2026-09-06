// src/__tests__/recursive-visibility-env.test.ts
//
// 递归 subagent 跨层可见性：env 身份贯穿验证（设计 docs/design/recursive-subagent-visibility.md 场景 1b）。
//
// 验证 runSpawn 构造的 childEnv 含 4 个 PI_SUBAGENT_* 身份 env，值 = ctx.sessionRootId /
// record.id / String(record.depth) / ctx.rootCwd（[MF-3] 第 4 个：ROOT cwd，落盘目录编码键）。覆盖 opts.fork=true 与 opts.fork=false 两种（决策 2 无条件注入）。
//
// 这是场景 1（端到端三层嵌套全树可见）的「env 传递机制」确定性验证——不依赖 LLM 配合，
// mock spawn 拦截 childEnv 直接断言。端到端可见性由场景 1（真实 pi CLI + recursive-worker agent）覆盖。
//
// mock 块与 fixture 收敛 __tests__/helpers/spawn-mock.ts（vi.mock 工厂 await import 转发，
// 单源共享）；vi.mocked 取回与收尾装配来自 helpers/session-runner-mocks.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSubagentSessionDir } from "../path-encoding.ts";

// ── mock modules（同 session-runner-schema-env.test.ts 模式，工厂单源在 spawn-mock.ts）──

vi.mock("node:child_process", async () =>
  (await import("./helpers/spawn-mock.ts")).childProcessModule());
vi.mock("node:fs", async () => (await import("./helpers/spawn-mock.ts")).fsModule());
vi.mock("../alive-store.ts", async () =>
  (await import("./helpers/spawn-mock.ts")).aliveStoreModule());
vi.mock("../engine/engines/pi/temp-prompt.ts", async () =>
  (await import("./helpers/spawn-mock.ts")).tempPromptModule());

import { runSpawn } from "../engine/engines/pi/session-runner.ts";
import {
  getLastSpawnEnv,
  makeRunOpts,
  makeVisibilityCtx,
  makeVisibilityRecord,
  waitForSpawn,
} from "./helpers/spawn-mock.ts";
import { closeLastChildAndAwait, takeSessionRunnerMocks } from "./helpers/session-runner-mocks.ts";

const { mockSpawn, mockExistsSync } = takeSessionRunnerMocks();

/** runSpawn 前奏装配：启动、等 spawn 落位、取回 childEnv（断言留在各用例）。 */
async function spawnAndCaptureEnv(
  record: ReturnType<typeof makeVisibilityRecord>,
  task: string,
  opts: ReturnType<typeof makeRunOpts>,
  ctx: ReturnType<typeof makeVisibilityCtx>,
): Promise<{ resultPromise: Promise<unknown>; childEnv: Record<string, string | undefined> }> {
  const resultPromise = runSpawn(record, task, opts, ctx);
  await waitForSpawn(mockSpawn);
  return { resultPromise, childEnv: getLastSpawnEnv(mockSpawn) };
}

// ── runSpawn childEnv 身份 env 注入（场景 1b）──

describe("runSpawn 跨进程身份 env 注入（递归可见性场景 1b）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("非 fork（fork=false/undefined）：无条件注入 4 个身份 env（决策 2）", async () => {
    const record = makeVisibilityRecord({ id: "sa-aaa", depth: 0 });
    const ctx = makeVisibilityCtx({ sessionRootId: "root-main" });
    const opts = makeRunOpts({ fork: false });

    const { resultPromise, childEnv } = await spawnAndCaptureEnv(record, "test task", opts, ctx);

    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("root-main");
    expect(childEnv.PI_SUBAGENT_SELF_RECORD_ID).toBe("sa-aaa");
    expect(childEnv.PI_SUBAGENT_DEPTH).toBe("0");
    // [MF-3] 第 4 个贯穿 env：ROOT cwd（子进程落盘目录编码键）
    expect(childEnv.PI_SUBAGENT_ROOT_CWD).toBe("/fake/cwd");
    // fork=false 不注入 fork depth env（与既有行为一致，本测试不改变它）
    expect(childEnv.PI_SUBAGENT_FORK_DEPTH).toBeUndefined();

    await closeLastChildAndAwait(resultPromise);
  });

  it("fork=true：4 个身份 env 与 fork depth env 共存（决策 2 无条件注入不依赖 fork）", async () => {
    const record = makeVisibilityRecord({ id: "sa-bbb", depth: 2 });
    const ctx = makeVisibilityCtx({ sessionRootId: "root-main" });
    const opts = makeRunOpts({ fork: true, parentForkDepth: 1 });

    const { resultPromise, childEnv } = await spawnAndCaptureEnv(record, "test task", opts, ctx);

    // 身份 env 无条件存在（决策 2）
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("root-main");
    expect(childEnv.PI_SUBAGENT_SELF_RECORD_ID).toBe("sa-bbb");
    expect(childEnv.PI_SUBAGENT_DEPTH).toBe("2");
    expect(childEnv.PI_SUBAGENT_ROOT_CWD).toBe("/fake/cwd");
    // fork depth env 同时存在（fork=true + parentForkDepth=1 → 2）
    expect(childEnv.PI_SUBAGENT_FORK_DEPTH).toBe("2");

    await closeLastChildAndAwait(resultPromise);
  });

  it("深层 record（depth=3）：DEPTH env = String(record.depth)，正确贯穿嵌套层级", async () => {
    const record = makeVisibilityRecord({ id: "sa-deep", depth: 3 });
    const ctx = makeVisibilityCtx({ sessionRootId: "root-topmost" });

    const { resultPromise, childEnv } = await spawnAndCaptureEnv(record, "test task", makeRunOpts(), ctx);

    expect(childEnv.PI_SUBAGENT_DEPTH).toBe("3");
    expect(childEnv.PI_SUBAGENT_SELF_RECORD_ID).toBe("sa-deep");
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("root-topmost");

    await closeLastChildAndAwait(resultPromise);
  });

  it("ROOT_SESSION_ID 恒等于 ctx.sessionRootId（贯穿真 ROOT，非 record.rootSessionId）", async () => {
    // record.rootSessionId 是 createRecord 时写入的值（可能来自旧逻辑），但 env 注入用的是
    // ctx.sessionRootId（经 buildSessionRunnerContext 从 this.sessionRootId 透传，贯穿真 ROOT）。
    // 这保证深层 subagent 的子进程仍归顶层 ROOT（设计决策 1/3）。
    const record = makeVisibilityRecord({ id: "sa-ccc" }); // record.rootSessionId = fixture 默认值
    const ctx = makeVisibilityCtx({ sessionRootId: "real-root-session" });

    const { resultPromise, childEnv } = await spawnAndCaptureEnv(record, "test task", makeRunOpts(), ctx);

    // env 用 ctx.sessionRootId，不是 record.rootSessionId
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("real-root-session");
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).not.toBe(record.rootSessionId);

    await closeLastChildAndAwait(resultPromise);
  });

  it("[MF-3 回归] worktree 模式（mainCwd=checkout ≠ rootCwd）：sessionDir 用 ROOT cwd 编码，深层 record 落盘到 ROOT 可扫描段", async () => {
    // 模拟 B（worktree 子进程）spawn C：ctx.cwd/mainCwd = checkout 路径，rootCwd = 真 ROOT cwd。
    // 旧实现 sessionDir 用 ctx.mainCwd 编码 → enc(checkout) 段，ROOT 磁盘重建扫不到（MF-3）。
    const rootCwd = "/root/project";
    const checkoutPath = "/var/folders/worktree/pi-subagents/--root-project--/branch";
    const agentDir = "/fake/agent";
    const record = makeVisibilityRecord({ id: "sa-deep", depth: 2 });
    const ctx = makeVisibilityCtx({ cwd: checkoutPath, mainCwd: checkoutPath, rootCwd, agentDir });

    const { resultPromise, childEnv } = await spawnAndCaptureEnv(record, "test task", makeRunOpts(), ctx);
    const spawnArgs = mockSpawn.mock.calls.at(-1)?.[1] as string[];

    // 第 4 个 env 贯穿 ROOT cwd
    expect(childEnv.PI_SUBAGENT_ROOT_CWD).toBe(rootCwd);
    // spawn --session-dir 指向 enc(ROOT cwd)（非 enc(checkout)）
    expect(spawnArgs).toContain(getSubagentSessionDir(agentDir, rootCwd));
    expect(spawnArgs).not.toContain(getSubagentSessionDir(agentDir, checkoutPath));

    await closeLastChildAndAwait(resultPromise);
  });
});
