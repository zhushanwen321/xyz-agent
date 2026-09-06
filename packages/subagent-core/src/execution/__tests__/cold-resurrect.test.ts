// src/execution/__tests__/cold-resurrect.test.ts
//
// [D4-③] coldLookupForAction 单元测试（依赖注入直测）。
//
// 背景：cold-resurrect.ts 自 SubagentService 搬移后按 ColdResurrectDeps 依赖注入
// 设计，此前仅有经 subagent-service 集成路径的 running 重建覆盖——closed 可重连
// 候选的「恢复失败守卫 / 部分恢复回边」（assertReconnectAllowed / resurrectColdRecord
// 的 wasClosed 分支）零直测。本文件锁定这些路径的可观察行为：
//   - 恢复失败：worktree 绑定丢失 / 异进程活实例（closed 与 running 候选）→
//     ResurrectDeniedError 且内存无残留（register 不被调用）；
//   - 部分恢复：closed 可重连记录 → resurrectClosed 回边翻回 running + 磁盘终态位
//     同步翻转（.finalized 删除 + .alive 刷新当前进程）+ register/transition 上报；
//   - 恢复源缺失：sessionFile 缺失 / sidecar 翻转失败（目录不存在）均不阻断重生
//     （best-effort 语义）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAliveMarker, writeAliveMarker } from "../alive-store.ts";
import { COLD_LOOKUP_SCAN_LIMIT, coldLookupForAction, type ColdResurrectDeps } from "../cold-resurrect.ts";
import type { SubagentRecord } from "../types.ts";
import { ResurrectDeniedError } from "../types.ts";

/** 磁盘/索引侧候选记录（SubagentRecord 最小合法形状 + closed 可重连缺省）。 */
function makeFound(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-cold-1",
    agent: "general-purpose",
    task: "cold recovery task",
    slug: "cold-test",
    status: "closed",
    closedReason: "parent-shutdown",
    mode: "background",
    startedAt: 1_700_000_000_000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    endedAt: 1_700_000_100_000,
    turns: 0,
    totalTokens: 0,
    model: "test/model-a",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...overrides,
  };
}

interface DepOverrides {
  /** findLightById（idToFile 索引直查）返回值。 */
  direct?: SubagentRecord;
  /** collectRecords（磁盘全扫）返回清单。 */
  disk?: SubagentRecord[];
  /** getSessionRootId 返回值（归属校验）。 */
  rootId?: string;
  /** getBaselineRecordId 返回值（直接父校验）。 */
  baseline?: string;
}

/** 构造依赖注入桩（register / reportRecordTransition 可断言副作用）。 */
function makeDeps(o: DepOverrides = {}): ColdResurrectDeps {
  return {
    findLightById: vi.fn(() => o.direct),
    collectRecords: vi.fn(() => o.disk ?? []),
    register: vi.fn(),
    reportRecordTransition: vi.fn(),
    getSessionRootId: vi.fn(() => o.rootId ?? "root-session"),
    getBaselineRecordId: vi.fn(() => o.baseline),
  };
}

describe("[D4-③] coldLookupForAction 冷查/复活链", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-resurrect-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** tmpdir 下建 session 文件 + 可选 .finalized sidecar，返回 sessionFile 路径。 */
  function writeSessionFixture(opts: { finalized?: string; aliveMarker?: string } = {}): string {
    const sessionFile = path.join(dir, "20260901T000000-000_sa-cold-1.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    if (opts.finalized !== undefined) {
      fs.writeFileSync(`${sessionFile}.finalized`, opts.finalized, "utf-8");
    }
    if (opts.aliveMarker !== undefined) {
      fs.writeFileSync(`${sessionFile}.alive`, opts.aliveMarker, "utf-8");
    }
    return sessionFile;
  }

  // ── 部分恢复（closed 可重连 → 透明重生回边）──

  it("closed 可重连记录（parent-shutdown）+ allowReconnect → 重生翻回 running：终态位清除、sidecar 翻转、register + transition 上报", () => {
    const sessionFile = writeSessionFixture({ finalized: JSON.stringify({ reason: "parent-shutdown" }) });
    const found = makeFound({ sessionFile, round: 2 });
    const deps = makeDeps({ disk: [found] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    // 重生回边：closed → running，终态语义位清除
    expect(record.status).toBe("running");
    expect(record.closedReason).toBeUndefined();
    expect(record.endedAt).toBeUndefined();
    // [v4 A-3] 跨重启恢复入口：chatMode 无条件 true
    expect(record.chatMode).toBe(true);
    // 身份/续聊字段从磁盘候选回填
    expect(record.sessionFile).toBe(sessionFile);
    expect(record.round).toBe(2);
    expect(record.model).toBe("test/model-a");
    expect(record.hadWorktree).toBe(false);
    // register + [v8.5 D] 重生后立刻上报 transition entry（live ≡ reload）
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledWith(record);
    // [review MF-8] 磁盘终态位同步翻转：.finalized 删除 + .alive 刷新为当前进程
    expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "sa-cold-1" });
    // 冷查扫描契约：全目录兜底按 COLD_LOOKUP_SCAN_LIMIT 上限扫全量（无 root 过滤）
    expect(vi.mocked(deps.collectRecords)).toHaveBeenCalledWith(COLD_LOOKUP_SCAN_LIMIT, "all", undefined);
  });

  it("idToFile 索引直查返回非 running 态 → 回退磁盘全扫兜底定位（closed 候选仍可重连）", () => {
    const sessionFile = writeSessionFixture();
    const found = makeFound({ sessionFile });
    // direct 命中但 status=closed → 不直接采用，落到 collectRecords 兜底
    const deps = makeDeps({ direct: found, disk: [found] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.collectRecords)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
  });

  it("closed disconnected（.finalized 空内容兜底死因）同样落在可重连集内", () => {
    const sessionFile = writeSessionFixture({ finalized: "" });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, closedReason: "disconnected" })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  // ── 恢复失败守卫（ResurrectDeniedError + 内存无残留）──

  it("worktree 绑定丢失（跨重启 WorktreeHandle 不可序列化）→ ResurrectDeniedError 拒绝，register 不残留", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, worktree: true })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/worktree isolation/);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("closed 候选仍有异进程活实例（.alive 指向活 pid）→ 拒绝双写，register 不残留", () => {
    // 用本测试进程 pid 模拟「另一进程的活跃实例」——isProcessAlive 判活为真
    const sessionFile = writeSessionFixture();
    writeAliveMarker(sessionFile, { pid: process.pid, id: "sa-cold-1", startedAt: Date.now() });
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /still finishing in another process/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("running 候选仍有异进程活实例（父进程重启后旧子进程尚存窗口）→ 拒绝并给恢复指引", () => {
    const sessionFile = writeSessionFixture();
    writeAliveMarker(sessionFile, { pid: process.pid, id: "sa-cold-1", startedAt: Date.now() });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, status: "running" })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /currently running in another process instance/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("损坏 .alive marker（无法解析）→ 视为确死放行重生，marker 被当前进程覆盖写", () => {
    const sessionFile = writeSessionFixture({
      finalized: JSON.stringify({ reason: "parent-shutdown" }),
      aliveMarker: "{not valid json",
    });
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid });
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  // ── 候选过滤 / 归属与父层校验 ──

  it.each([
    ["自然完成死因 gc", makeFound({ closedReason: "gc" })],
    ["用户主动 close", makeFound({ closedReason: "user-close" })],
  ])("不可重连死因（%s）→ 磁盘也无候选，返回 undefined", (_label, found) => {
    const deps = makeDeps({ disk: [found] });

    expect(coldLookupForAction(deps, "sa-cold-1", true)).toBeUndefined();
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("allowReconnect=false：closed 候选一律不可见（running-only 查询语义）", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    expect(coldLookupForAction(deps, "sa-cold-1", false)).toBeUndefined();
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("rootSessionId 不匹配 → 返回 undefined（不区分失败形态，防跨 session 探测）", () => {
    const deps = makeDeps({ disk: [makeFound({ rootSessionId: "other-root" })], rootId: "root-session" });

    expect(coldLookupForAction(deps, "sa-cold-1", true)).toBeUndefined();
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("parentRecordId 跨层不匹配（候选有直接父）→ 原样抛 direct parent 错误（跨层导航指引）", () => {
    const deps = makeDeps({
      disk: [makeFound({ status: "running", parentRecordId: "sa-parent" })],
      baseline: undefined,
    });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/is owned by its direct parent/);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/parent=sa-parent/);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("顶层候选（parentRecordId 缺失）遇嵌套进程 baseline → direct parent 错误带 (root layer) 回显", () => {
    const deps = makeDeps({
      disk: [makeFound({ status: "running", parentRecordId: undefined })],
      baseline: "rec-baseline-child",
    });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /parent=\(root layer\)/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  // ── 恢复源缺失（best-effort 不阻断重生主流程）──

  it("sessionFile 缺失的 closed 候选 → 跳过 sidecar 翻转，重生照常完成（register + transition 上报）", () => {
    const deps = makeDeps({ disk: [makeFound({ sessionFile: undefined })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(record.sessionFile).toBeUndefined();
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledTimes(1);
  });

  it("sidecar 翻转失败（sessionFile 所在目录不存在，writeAliveMarker ENOENT）→ best-effort 吞错，重生不中断", () => {
    // 恢复源缺失形态：sessionFile 指向已消失的目录（推导路径过期 / 目录被清理）
    const sessionFile = path.join(dir, "vanished-dir", "20260901T000000-000_sa-cold-1.jsonl");
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    // best-effort：sidecar 翻转失败不阻断重生主流程（状态回边与注册照常）
    expect(record.status).toBe("running");
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledTimes(1);
    // marker 写入确实失败（目录不存在，未落盘）
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
  });
});
