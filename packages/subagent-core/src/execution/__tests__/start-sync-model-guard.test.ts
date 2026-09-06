// src/execution/__tests__/start-sync-model-guard.test.ts
//
// [U1 验收 3] start 同步期裁决：非全等 model 入参在 start 工具调用同步期 isError——
// 无 spawn、无子 session、record 不落盘。
//
// 用真实 SubagentService（tmpdir + mock pi）走 execute 全链路，断言：
//   1. execute 在 IDENTITY 解析（resolveModel 裁决）阶段 reject（问句式报错）；
//   2. buildSpawnArgs 从未被调用（vi.mock spy 包装真实实现）——spawn 前置守卫的结构性证据；
//   3. node:child_process.spawn 从未被调用——无子进程；
//   4. pi.appendEntry 从未被调用——record 未创建（emitPendingRegister 未发生）。
//
// 放行路径（全等 → 裁决通过）由 model-ref.test.ts / model-resolver.test.ts 锁定，
// 全链路放行的 spawn 行为由 run-spawn-* 契约测试覆盖。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await import("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error("spawn must not be called on sync-model rejection");
    }),
  };
});

// buildSpawnArgs 包装为 spy（保留真实实现）——「非全等拒单不触达 spawn 参数组装」的承重断言。
vi.mock("../engine/engines/pi/session-runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/engines/pi/session-runner.ts")>();
  return { ...actual, buildSpawnArgs: vi.fn(actual.buildSpawnArgs) };
});

import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import { buildSpawnArgs } from "../engine/engines/pi/session-runner.ts";
import type { PiLike } from "../subagent-service.ts";
import { SubagentService } from "../subagent-service.ts";

const mockSpawn = vi.mocked(spawn);
const mockBuildSpawnArgs = vi.mocked(buildSpawnArgs);

// ── 工具 ──

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "GLM-5.3-Flash",
    name: over.name ?? "GLM 5.3 Flash",
    provider: over.provider ?? "zai-coding-cn",
    reasoning: over.reasoning ?? false,
    ...over,
  };
}

/** registry 快照：真实形态（大小写混合 id），无孪生（P-A2 放行快照形态）。 */
function makeRegistry(models: ModelInfo[]): ModelRegistryLike {
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: () => true,
  };
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

describe("start 同步期裁决（U1 验收 3：非全等 → isError 且无 spawn 无子 session）", () => {
  let tmpDir: string;
  let service: SubagentService;
  let pi: PiLike;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-start-guard-"));
    const modelService = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    modelService.initModel({
      modelRegistry: makeRegistry([makeModel()]),
      sessionId: "guard-session",
    });
    service = new SubagentService({ cwd: tmpDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "guard-session" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("小写变体入参 → execute 同步 reject（问句式报错），buildSpawnArgs/spawn/appendEntry 均未被调", async () => {
    await expect(
      service.execute({
        task: "probe task",
        slug: "guard",
        model: "zai-coding-cn/glm-5.3-flash",
      }),
    ).rejects.toThrow(/is not a registry entry.*Did you mean one of these\?/s);

    // spawn 链路零触达：参数组装（buildSpawnArgs）与进程创建（spawn）都未发生
    expect(mockBuildSpawnArgs).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    // record 未创建（emitPendingRegister 未发生）→ 无子 session 前置状态
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("错误含 case variant 首位建议 + 继承指引（可直接重发的合法串）", async () => {
    let msg = "";
    try {
      await service.execute({
        task: "probe task",
        slug: "guard",
        model: "zai-coding-cn/glm-5.3-flash",
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('zai-coding-cn/GLM-5.3-Flash   ← case variant of "glm-5.3-flash"');
    expect(msg).toMatch(/Or omit the `model` param to inherit the main agent model\./);
  });

  it("全等入参通过裁决（reject 不发生，放行链路触达 spawn 参数组装）——守卫零误伤对照", async () => {
    // 放行路径会进入轮次 kick-off（detached）；execute resolve 即视为裁决放行。
    // spawn 本身由 FakeChild 缺失抛错收口——本断言只关心「越过了同步裁决」：
    // execute 不 reject，且 buildSpawnArgs 已被调（或即将被调的 record 已创建）。
    const promise = service.execute({
      task: "probe task",
      slug: "guard-exact",
      model: "zai-coding-cn/GLM-5.3-Flash",
    });
    // 放行路径：裁决不抛（execute 最终可能因 mock 环境子进程收尾而 reject，
    // 但错误不能是模型裁决错误）
    try {
      await promise;
    } catch (e) {
      expect((e as Error).message).not.toMatch(/is not a registry entry/);
      expect((e as Error).message).not.toMatch(/ambiguous case variants/);
    }
    // 全等放行 → record 已创建（emitPendingRegister 发生）——与拒单路径形成对照
    expect(pi.appendEntry).toHaveBeenCalled();
  });
});
