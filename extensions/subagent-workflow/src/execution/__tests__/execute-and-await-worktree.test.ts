// src/__tests__/execute-and-await-worktree.test.ts
//
// executeAndAwait 的 worktree 前置守卫 + 失败收尾测试（W1 code review 修复回归锁）。
//
// 覆盖两点：
//   1. [MF#7] worktree:true && !fork 在任何副作用之前 fail-fast 抛错
//   2. worktreeManager.create 抛错时 record 被 finalizeFailed（status→failed）且原错外抛
//
// ── mock 策略 ──
//
// 复用 execute-nesting.test.ts 的 spawn / node:fs / manifest-store / temp-prompt / alive-store
// / finalized-marker mock 范式（见该文件头部详细注释）。本文件 **不驱动 FakeChild 完成**——
// 被测的两个分支都在 runSpawn 之前抛/收尾（worktree create 在步骤 2.5，runSpawn 在步骤 5），
// 因此 spawn 即使被调也无人驱动，测试在抛错后立即断言即可结束。
//
// worktreeManager 是 SubagentService 构造时 new 出的私有字段（WorktreeManager 实例，非模块）。
// 测试 2 用 vi.spyOn(Reflect.get(service, "worktreeManager"), "create") 注入抛错，无需模块级 mock。

import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

// ── mock modules（与 execute-nesting.test.ts 同范式）──

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    killSignal: string | undefined;
    kill(sig?: string): boolean {
      this.killed = true;
      this.killSignal = sig;
      return true;
    }
  }

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

vi.mock("../alive-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../alive-store.ts")>();
  return {
    ...actual,
    writeAliveMarker: vi.fn(),
    removeAliveMarker: vi.fn(),
  };
});

vi.mock("../finalized-marker.ts", () => ({
  writeFinalized: vi.fn(),
  readFinalized: vi.fn(() => false),
}));

vi.mock("../manifest-store.ts", () => {
  class FakeManifestStore {
    writeManifest = vi.fn(async () => {});
    readManifest = vi.fn(async () => null);
    listAllSync = vi.fn(() => []);
    recoverTmpFiles = vi.fn(async () => []);
  }
  return { ManifestStore: FakeManifestStore };
});

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import type { WorktreeManager } from "../worktree-manager.ts";
import { SubagentService } from "../subagent-service.ts";

// ── 辅助：service 构造（与 execute-nesting.test.ts setup 等价）──

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

interface SetupResult {
  service: SubagentService;
  worktreeManager: WorktreeManager;
}

function setup(): SetupResult {
  const agentDir = "/tmp/exec-await-worktree-it"; // fs 已 mock，路径不需真实存在
  const modelService = new ModelConfigService({ agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId: "exec-await-worktree-it",
    ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId: "exec-await-worktree-it" });
  const worktreeManager = Reflect.get(service, "worktreeManager") as WorktreeManager;
  return { service, worktreeManager };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

/** 从 service 取出 private store（断言 record 终态用）。 */
function getStore(service: SubagentService) {
  return Reflect.get(service, "store") as {
    getMutable: (id: string) => { status: string } | undefined;
    listRunning: () => Array<{ status: string }>;
    archive: (record: { status: string; id: string }) => void;
  };
}

describe("executeAndAwait worktree 前置守卫 + 失败收尾", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // [MF#7] worktree:true && !fork → fail-fast 抛错（任何副作用之前）
  // ============================================================
  it("[MF#7] worktree:true 且 fork 未设时抛 'worktree:true requires fork:true'", async () => {
    const { service } = setup();

    // guard 在 BC-12 深度检查之后、步骤 1 之前——无需 fork:true，worktree:true 即触发。
    await expect(
      service.executeAndAwait({
        task: "needs worktree without fork",
        worktree: true,
        fork: undefined,
        ctxModel,
      } as Parameters<typeof service.executeAndAwait>[0]),
    ).rejects.toThrow(/worktree:true requires fork:true/);

    // 无副作用：guard 在 createRecordForMode 之前 → store 无 running record。
    expect(getStore(service).listRunning()).toHaveLength(0);
  });

  // ============================================================
  // worktreeManager.create 抛错 → record 收尾为 failed + 原错外抛
  // ============================================================
  it("worktreeManager.create 失败时 finalizeFailed 收尾 record 并抛原错", async () => {
    const { service, worktreeManager } = setup();

    const createErr = new Error("worktree create boom");
    vi.spyOn(worktreeManager, "create").mockImplementation(() => {
      throw createErr;
    });

    // spy store.archive：finalizeFailed 真实收尾链（CAS→completeRecord→archive）的最末一步。
    // 捕获传入 archive 的 record，断言其 status 已被推向 "failed"（证明 finalizeFailed 完整执行，
    // 而非仅 tryTransition 中途返回）。archive 真实执行（不 mockImplementation）以保留移出 running map 的语义。
    const store = getStore(service);
    const archiveSpy = vi.spyOn(store, "archive");

    await expect(
      service.executeAndAwait({
        task: "worktree create will fail",
        worktree: true,
        fork: true,
        ctxModel,
      } as Parameters<typeof service.executeAndAwait>[0]),
    ).rejects.toBe(createErr);

    // finalizeFailed 完整执行：record 经 CAS→completeRecord 推到 failed 终态后 archive。
    expect(archiveSpy).toHaveBeenCalledTimes(1);
    const archivedRecord = archiveSpy.mock.calls[0]![0] as { status: string; id: string };
    expect(archivedRecord.status).toBe("failed");
    // archive 后 record 已移出 running map → listRunning 空、getMutable 取不到。
    expect(store.listRunning()).toHaveLength(0);
    expect(store.getMutable(archivedRecord.id)).toBeUndefined();
  });
});
