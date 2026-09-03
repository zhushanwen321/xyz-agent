// src/execution/__tests__/session-runner-branch-cache-lru.test.ts
//
// [LC-8/T6③] branchCache LRU 上界。
//
// 背景（设计 §4.3 LC-8）：缓存 key=cwd，worktree 路径每次唯一 → 模块级 Map 永不淘汰，
// 条目按 path 永久累积（长寿命 orchestrator 内存无界，实锤·轻微）。T6③ 加 LRU 上限
// BRANCH_CACHE_MAX_ENTRIES=64（常量导出）。
//
// 覆盖（验收：65 个路径插入后规模 64，最旧被淘汰）：
//   - 65 次 miss 插入 → size 封顶 64，execFile 恰 65 次；
//   - 最旧条目已被淘汰（再查重新 spawn git），次旧条目仍在（LRU 只淘汰最旧）；
//   - get 命中刷新 LRU 序（touch 后不再是淘汰候选）；
//   - 常量导出值 = 64。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// buildEnvBlock 用 execFile 异步取 git branch：按 opts.cwd 回填可区分的 branch 名。
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async () => {
  const actual = await import("node:child_process");
  return { ...actual, execFile: execFileMock };
});

// Mock 共享 logger（buildEnvBlock 的 git 失败 debug 留痕不落真实日志盘）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  BRANCH_CACHE_MAX_ENTRIES,
  _getBranchCacheSizeForTest,
  _resetBranchCacheForTest,
  buildEnvBlock,
} from "../session-runner.ts";

/** execFile mock 回填 br-<cwd>（branch 与 cwd 一一对应，淘汰行为可断言）。 */
function stubGitBranchSuccess(): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: readonly string[],
      opts: { cwd?: string },
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => cb(null, `br-${opts?.cwd ?? "unknown"}`, ""),
  );
}

beforeEach(() => {
  _resetBranchCacheForTest();
  stubGitBranchSuccess();
});

afterEach(() => {
  _resetBranchCacheForTest();
  execFileMock.mockReset();
  loggerMock.debug.mockClear();
});

describe("[LC-8] branchCache LRU 上界", () => {
  it("常量导出 BRANCH_CACHE_MAX_ENTRIES = 64", () => {
    expect(BRANCH_CACHE_MAX_ENTRIES).toBe(64);
  });

  it("65 个路径插入后规模封顶 64，最旧被淘汰（重新 spawn git）", async () => {
    const cwds = Array.from({ length: BRANCH_CACHE_MAX_ENTRIES + 1 }, (_, i) => `/tmp/lru-cwd-${i}`);
    for (const cwd of cwds) {
      const block = await buildEnvBlock(cwd);
      expect(block).toContain(`Git branch: br-${cwd}`);
    }
    // 65 次 miss 插入，第 65 次插入时淘汰最旧（cwd-0）→ execFile 恰 65 次、规模 64
    expect(execFileMock).toHaveBeenCalledTimes(BRANCH_CACHE_MAX_ENTRIES + 1);
    expect(_getBranchCacheSizeForTest()).toBe(BRANCH_CACHE_MAX_ENTRIES);

    // 最旧（cwd-0）已被 LRU 淘汰 → 再次查询重新 spawn git（66 次）；重插后淘汰次旧
    //（cwd-1），更近插入的 cwd-2 不受影响
    const block0 = await buildEnvBlock("/tmp/lru-cwd-0");
    expect(block0).toContain("Git branch: br-/tmp/lru-cwd-0");
    expect(execFileMock).toHaveBeenCalledTimes(BRANCH_CACHE_MAX_ENTRIES + 2);

    // cwd-2（仍近插入序）仍在缓存 → 查询不再 spawn（仍 66 次）
    await buildEnvBlock("/tmp/lru-cwd-2");
    expect(execFileMock).toHaveBeenCalledTimes(BRANCH_CACHE_MAX_ENTRIES + 2);
  });

  it("get 命中刷新 LRU 序：被 touch 的条目不再是最旧淘汰候选", async () => {
    const cwdA = "/tmp/lru-touch-a";
    const cwdB = "/tmp/lru-touch-b";
    await buildEnvBlock(cwdA); // A 先插
    await buildEnvBlock(cwdB); // B 后插
    expect(execFileMock).toHaveBeenCalledTimes(2);

    await buildEnvBlock(cwdA); // 命中并 touch → A 变最新，B 变最旧；零 spawn
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // 再插 63 个新条目挤爆缓存（2 + 63 = 65 → 淘汰恰 1 个最旧）：B（最旧）被淘汰、
    // A（被 touch 过，次新）存活
    for (let i = 0; i < BRANCH_CACHE_MAX_ENTRIES - 1; i++) {
      await buildEnvBlock(`/tmp/lru-flood-${i}`);
    }
    expect(_getBranchCacheSizeForTest()).toBe(BRANCH_CACHE_MAX_ENTRIES);
    const spawnsAfterFlood = execFileMock.mock.calls.length;

    await buildEnvBlock(cwdA); // A 被 touch 过 → 仍在缓存
    expect(execFileMock).toHaveBeenCalledTimes(spawnsAfterFlood);

    await buildEnvBlock(cwdB); // B 最早未 touch → 已被淘汰，重新 spawn
    expect(execFileMock).toHaveBeenCalledTimes(spawnsAfterFlood + 1);
  });
});
