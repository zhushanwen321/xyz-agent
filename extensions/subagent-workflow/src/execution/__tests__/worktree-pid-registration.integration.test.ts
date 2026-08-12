// src/execution/__tests__/worktree-pid-registration.integration.test.ts
//
// [worktree-reaper-fix] 端到端集成测试：验证 worktree pid 注册链路（接线层）。
//
// 背景：2026-08-11 生产事故——reaper 误清活 worktree。根因：pid 补全代码唯一生产调用点
// 挂在 session-runner 的 header 分支（RPC mode 永不触发），注册表 pid 恒为 0，超
// SPAWN_GRACE_MS(60s) 后任意 session_start 触发的 scan() 必然误删活 worktree。
// 修复：spawn() 返回后同步补 pid。
//
// 为什么用真实 spawn（而非现有 run-spawn-* 的 FakeChild mock）：
//   现有测试全 mock registerPid（session-start-reaper/crash-recovery/index-session-start/
//   stream-sink-guard），验证的是「mock 了补全回调后的 reaper 行为」，从未验证
//   「真实调用链中补全回调是否被调用」——接线错误零检测能力（结构性盲区）。
//   本测试走真实链路：真实 git repo + 真实 worktree 创建 + 真实 spawn node 子进程 +
//   真实注册表文件，仅 mock ./pi-invocation.ts（把 pi 二进制替换为 node -e 脚本）。
//
// mock 最小化原则：
//   - node:child_process 不 mock（真实 spawn / execFileSync git）
//   - node:fs 不 mock（真实目录/文件：worktree checkout、注册表 JSON）
//   - alive-store 不 mock（真实 process.kill(pid, 0) 探活）
//   - 仅 vi.mock("./pi-invocation.ts")：getPiInvocation 返回 node -e 脚本
//   - fake timers 仅 toFake: ["Date"]：推进注册表宽限判定用，不干扰真实 I/O 事件

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted：vi.mock 工厂体内不能引用顶层 let/const（提升限制），脚本字符串必须放这。
// scriptHolder 是可变对象：getPiInvocation 每次调用时读它（工厂函数体在运行时执行），
// 用例内可切换长驻/短命脚本。
const { scriptHolder, LONG_RUNNING_SCRIPT, SHORT_LIVED_SCRIPT } = vi.hoisted(() => {
  const scriptHolder: { script: string } = { script: "process.exit(0)" };
  return {
    scriptHolder,
    // 长驻脚本：90s 后退出（测试在 61s scan 时它必须还活着，验证「活 worktree 不被清」）
    LONG_RUNNING_SCRIPT:
      "setTimeout(() => process.exit(0), 90000);",
    // 短命脚本：立即退出（模拟快速完成的子 agent，验证「真孤儿被回收」）
    SHORT_LIVED_SCRIPT: "process.exit(0)",
  };
});

vi.mock("./pi-invocation.ts", () => ({
  getPiInvocation: (userArgs: string[]) => ({
    command: process.execPath,
    args: ["-e", scriptHolder.script, ...userArgs],
  }),
}));

import { WorktreeManager } from "../worktree-manager.ts";
import { WorktreeRegistry, SPAWN_GRACE_MS } from "../worktree-registry.ts";
import { runSpawn } from "../session-runner.ts";
import type { WorktreeHandle } from "../types.ts";
import { makeCtx, makeOpts, makeRecord } from "./helpers/spawn-mock.ts";

// ── 测试夹具：临时 git repo + 临时 agentDir（避免污染 ~/.pi/agent）──

let tmpRoot: string;
let repoDir: string;
let agentDir: string;
let wtm: WorktreeManager;
let registry: WorktreeRegistry;
let handle: WorktreeHandle | undefined;
let spawnedPid: number | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** 初始化临时 git repo（至少一个 commit，worktreeManager.create 需要 clean tree + HEAD）。 */
function initRepo(): void {
  repoDir = path.join(tmpRoot, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "test@test.local"], repoDir);
  git(["config", "user.name", "test"], repoDir);
  git(["commit", "--allow-empty", "-m", "init"], repoDir);
}

/** 从注册表文件读指定 branch 的条目（真实文件，轮询用）。 */
function readEntry(branch: string): { pid: number; createdAt: number } | undefined {
  return registry.load().find((e) => e.branch === branch);
}

/** 轮询注册表直到 pid 补全（真实 fs 读 + 真实 setTimeout 轮询）。 */
async function waitForPid(branch: string, timeoutMs = 5000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = readEntry(branch);
    if (entry && entry.pid !== 0) return entry.pid;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pid not registered within ${timeoutMs}ms (branch=${branch})`);
}

/** 清理：kill 子进程 + worktree cleanup + 删除临时目录。 */
function cleanup(): void {
  if (spawnedPid) {
    try {
      process.kill(spawnedPid, "SIGKILL");
    } catch {
      // 已退出
    }
    spawnedPid = undefined;
  }
  if (handle) {
    try {
      wtm.cleanup(handle);
    } catch (err) {
      // best-effort：git worktree remove 失败不阻断测试清理
      // eslint-disable-next-line no-console
      console.warn("worktree cleanup failed in test teardown", err);
    }
    handle = undefined;
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wt-reaper-it-"));
  agentDir = path.join(tmpRoot, "agent");
  initRepo();
  wtm = new WorktreeManager(agentDir);
  registry = new WorktreeRegistry(agentDir);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ── 用例 ──

describe("worktree pid 注册链路（真实 spawn 集成）", () => {
  it("正向：spawn 返回后注册表 pid 同步补全，活 worktree 超宽限不被 scan 误清", async () => {
    // 0. 长驻脚本（子进程 90s 内不退出，模拟长跑子 agent）
    scriptHolder.script = LONG_RUNNING_SCRIPT;    // 1. 真实创建 worktree（pid=0 占位）
    handle = wtm.create(repoDir, "rec-1");
    expect(readEntry(handle.branch)).toMatchObject({ pid: 0 });

    // 2. runSpawn 挂后台（不 await——长驻子进程 close 不触发，await 会挂死），
    //    ctx.onWorktreePid 接真实 registerPid（模拟 subagent-service 接线）
    const ctx = makeCtx({
      agentDir,
      cwd: repoDir,
      mainCwd: repoDir,
      rootCwd: repoDir,
      onWorktreePid: (branch: string, pid: number) => wtm.registerPid(branch, pid),
    });
    const runPromise = runSpawn(
      makeRecord(),
      "test task",
      makeOpts({ worktree: handle }),
      ctx,
    );

    // 3. 断言 spawn 后 pid 已补全（真实注册表文件轮询）——修复前此步超时红
    spawnedPid = await waitForPid(handle.branch);
    expect(spawnedPid).toBeGreaterThan(0);

    // 4. 推进时钟超 SPAWN_GRACE_MS（仅 fake Date，不干扰真实 I/O）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SPAWN_GRACE_MS + 1000);

    // 5. scan()：活 worktree 必须不被清（修复前：pid=0 超宽限 → 误删 → 红）
    wtm.scan();
    expect(fs.existsSync(handle.path)).toBe(true);

    // 6. 收尾：真实时钟恢复 + kill 子进程让 runPromise settle
    vi.useRealTimers();
    try {
      process.kill(spawnedPid, "SIGTERM");
    } catch {
      // 已退出
    }
    await runPromise;

    // 7. 反向：进程死后 scan 回收真孤儿
    wtm.scan();
    expect(fs.existsSync(handle.path)).toBe(false);
    const entryAfter = readEntry(handle.branch);
    expect(entryAfter).toBeUndefined();
  }, 15000);

  it("反向：短命子进程退出后，pid>0 且进程死 → scan 立即回收", async () => {
    // 0. 短命脚本（子进程立即退出，模拟快速完成的子 agent）
    scriptHolder.script = SHORT_LIVED_SCRIPT;
    // 1. 真实创建 worktree
    handle = wtm.create(repoDir, "rec-2");

    // 2. 短命脚本子进程：spawn 后同步补 pid（修复前 pid=0，且未超宽限 → 不回收 → 红）
    const ctx = makeCtx({
      agentDir,
      cwd: repoDir,
      mainCwd: repoDir,
      rootCwd: repoDir,
      onWorktreePid: (branch: string, pid: number) => wtm.registerPid(branch, pid),
    });
    const result = await runSpawn(
      makeRecord(),
      "test task",
      makeOpts({ worktree: handle }),
      ctx,
    );
    expect(result.status).not.toBe("error"); // 进程正常退出（exit 0），非 spawn 失败

    // 3. pid 已补全（短命进程退出后 pid 仍有效，registerPid 同步执行不受退出影响）
    const entry = readEntry(handle.branch);
    expect(entry).toBeDefined();
    expect(entry!.pid).toBeGreaterThan(0);
    spawnedPid = entry!.pid;

    // 4. scan：pid>0 且进程死 → 立即判孤儿回收（无需等宽限）
    wtm.scan();
    expect(fs.existsSync(handle.path)).toBe(false);
    expect(readEntry(handle.branch)).toBeUndefined();
  }, 15000);
});
