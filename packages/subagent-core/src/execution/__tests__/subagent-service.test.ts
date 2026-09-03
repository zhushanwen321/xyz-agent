// src/__tests__/subagent-service.test.ts
//
// SubagentService 生命周期 + 公共 API 边界测试。
//
// 范围:initSession / dispose / query / cancel / listRunning / collectRecords /
// onChange / assertReady -- 这些不依赖动态 import Pi SDK(getSdk)。
//
// execute() 因 buildSessionRunnerContext 会动态 import session-runner → getSdk(),
// 在单测环境无法提供真实 SDK,留给集成测试(见文件末尾 TODO)。
//
// 策略:用真实 ModelConfigService 指向 os.tmpdir() 空目录(loadGlobalConfig
// 对不存在文件返回默认配置,AgentRegistry 空目录也安全),mock PiLike。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import type { RecordStore } from "../record-store.ts";
import type { UiRequest, UiRequestHandler } from "../dialog-queue.ts";
import type { PiLike } from "../subagent-service.ts";
import { getSubagentService, setSubagentService,SubagentService } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";
import type { WorktreeManager } from "../worktree-manager.ts";

// ── 工具:建临时 agentDir + 真实 ModelConfigService ──

function makeTmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  // agentDir/subagents/ 子目录(config 默认路径会用,空即可)
  return dir;
}

function makeModelService(agentDir: string): ModelConfigService {
  return new ModelConfigService({ agentDir });
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

describe("SubagentService", () => {
  let agentDir: string;
  let modelService: ModelConfigService;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    modelService = makeModelService(agentDir);
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  // ============================================================
  // 构造 + 生命周期
  // ============================================================

  describe("构造 + 生命周期", () => {
    it("构造不抛错(空 agentDir,默认 config)", () => {
      expect(() => new SubagentService({ cwd: agentDir, modelService })).not.toThrow();
    });

    it("未 initSession 时 findRecord/cancel 抛 'pi not injected'", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      expect(() => service.queries.findRecord("any")).toThrow(/pi not injected/);
      expect(() => service.cancel("any")).toThrow(/pi not injected/);
    });

    it("initSession 后 assertReady 通过(findRecord 不再抛 pi 错,返回 undefined)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // findRecord 现在能过 assertReady,但 record 不存在 → 返回 undefined
      expect(service.queries.findRecord("missing")).toBeUndefined();
    });

    it("dispose 后 findRecord 抛含 'disposed' 且带恢复指引", () => {
      // [HISTORICAL] 旧实现只抛 "hub disposed"--无信息,调用方和 AI 盲猜。
      // 现错误信息必须含原因 + 恢复指引,让 AI/user 知道要重启会话而非重试。
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      expect(() => service.queries.findRecord("any")).toThrow(/disposed/);
      expect(() => service.queries.findRecord("any")).toThrow(/session ended|session_start|new session/i);
    });

    it("dispose 幂等(多次调用不抛)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(() => {
        service.dispose();
        service.dispose();
        service.dispose();
      }).not.toThrow();
    });

    it("initSession 可 revive 已 dispose 的 service", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      // revive
      service.initSession({ pi: makePi(), sessionId: "s2" });
      // 现在 assertReady 又通过(findRecord 返回 undefined 而非 disposed)
      expect(service.queries.findRecord("any")).toBeUndefined();
    });
  });

  // ============================================================
  // findRecord / cancel 边界
  // ============================================================

  describe("findRecord / cancel 边界 (T4)", () => {
    it("findRecord 不存在的 id 返回 undefined", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.queries.findRecord("nonexistent-id")).toBeUndefined();
    });

    it("cancel 不存在的 id 返回 false(不抛错,boolean 契约不变)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.cancel("nonexistent-id")).toBe(false);
    });
  });

  // ============================================================
  // 状态查询
  // ============================================================

  describe("状态查询", () => {
    // [D4] listRunning 已从 Service 删除（零生产调用方）——初始空态语义由
    // collectRecords 用例与 store 层 listRunning 测试覆盖。

    it("collectRecords 返回数组(空 sessions 目录时为空)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const records = service.queries.collectRecords(100);
      expect(Array.isArray(records)).toBe(true);
    });

    it("onChange 返回 unsubscribe 函数,调用后停止通知", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const listener = vi.fn();
      const unsubscribe = service.queries.onChange(listener);
      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  // ============================================================
  // resolveModel 代理
  // ============================================================

  describe("resolveModel 代理", () => {
    it("代理到 modelService.resolveModel(未 init 时抛错)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // 未 init modelRegistry → resolveModel 拋错(fail-fast)
      expect(() => service.resolveModel("worker")).toThrow(/modelRegistry not injected/);
    });
  });

  // ============================================================
  // 进程单例访问器
  // ============================================================

  describe("进程单例访问器", () => {
    // 保存/恢复单例,避免污染其他测试(setSubagentService 类型不接受 null)
    const original = getSubagentService();
    afterEach(() => {
      if (original) setSubagentService(original);
    });

    it("setSubagentService / getSubagentService 读写一致", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      setSubagentService(service);
      expect(getSubagentService()).toBe(service);
    });
  });

  // ============================================================
  // dispose abort 子进程（R0-D：孤儿进程治理）
  // ============================================================
  //
  // [R0] 进程退出路径：SubagentService.dispose 调 store.abortRunningControllers()，
  // 触发所有 running background record 的 controller.abort() → runSpawn signal listener
  // → child.kill("SIGTERM")，防止主进程退出后 background 子进程成孤儿。
  //
  // 被测方法在 service 层，不需要 mock spawn——直接构造 record 注册到 store。
  // store 是 private 字段，用 Reflect.get 取（与 execute-nesting.test.ts 访问 pool 同模式）。

  describe("dispose abort 子进程 (R0-D)", () => {
    /** 从 service 取出 private store（测试注入 running record 用）。 */
    function getStore(service: SubagentService): RecordStore {
      return Reflect.get(service, "store") as RecordStore;
    }

    /** 构造一个 running background record（带 controller）并注册到 store。 */
    function registerRunningBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        task: "long task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      // createRecord 默认 status="running"；background record 持有 controller。
      getStore(service).register(record);
      return record;
    }

    /** 构造一个 running sync record（无 controller）并注册到 store。 */
    function registerRunningSync(service: SubagentService, id: string): ExecutionRecord {
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "sync",
        task: "sync task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        // sync 不传 controller → controller === undefined
      });
      getStore(service).register(record);
      return record;
    }

    /** 构造一个终态 background record 并注册（用于「无 running」场景）。 */
    function registerTerminalBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        task: "done task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      // 直接改 status 模拟终态（不走 CAS——测试不关心状态机，只关心 dispose 的 abort 过滤）
      record.status = "done";
      getStore(service).register(record);
      return record;
    }

    it("dispose 时有 running background record → controller 被 abort", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      const record = registerRunningBackground(service, "bg-1");

      // 前置：dispose 前 controller 未 abort
      expect(record.controller!.signal.aborted).toBe(false);

      service.dispose();

      // dispose 后 controller 被 abort → runSpawn 的 signal listener 会 kill 子进程
      expect(record.controller!.signal.aborted).toBe(true);
    });

    it("dispose 时无 running record → 不报错，正常清理", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      // 全是终态 record（无 running），dispose 不应抛
      registerTerminalBackground(service, "bg-done-1");

      expect(() => service.dispose()).not.toThrow();
    });

    it("dispose 已 dispose → 幂等（重复调用不抛，不重复 abort）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      const record = registerRunningBackground(service, "bg-2");

      service.dispose();
      expect(record.controller!.signal.aborted).toBe(true);

      // 第二次 dispose：service 已 _disposed，early-return，abortRunningControllers 不再调
      // （即使调了也无害——已 abort 的 controller.abort() 是幂等 noop）
      expect(() => service.dispose()).not.toThrow();
      expect(record.controller!.signal.aborted).toBe(true);
    });

    it("sync record（无 controller）→ dispose 跳过（不因 undefined controller 出错）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      // sync record 的 controller 是 undefined，running 状态下 dispose 不应抛
      // （abortRunningControllers 检查 r.controller 才 abort，sync 跳过）
      // [C1] sync 子进程的 kill 由 killAllSpawnedChildren 兜底（spawnedChildren Set 注册），
      //      集成验证见 run-spawn-integration.test.ts 的 C1 用例（mock spawn + spy kill）。
      const syncRecord = registerRunningSync(service, "sync-1");
      expect(syncRecord.controller).toBeUndefined();

      expect(() => service.dispose()).not.toThrow();
    });
  });

  // ============================================================
  // dispose uiRequestHandler stub（dispose-cleanup Minor 优化1）
  // ============================================================
  //
  // [背景] Pi 单进程 session 串行接管。session A shutdown 发 SIGTERM 后、子进程彻底
  // close 前（graceful shutdown 窗口几十~几百 ms），子进程的 trailing extension_ui_request
  // 仍会被父进程 pump 解析，调到 A 的 handler 闭包（仍持有 A 的 ctx）。旧实现 dispose 不清
  // uiRequestHandler，该闭包触发 ui-request-queue.ts catch 分支打 `[subagents] uiRequestHandler
  // threw` 误导性 console.error。dispose 现注入 stub（始终返回 {cancelled:true}），让 trailing
  // ui_request 干净降级，不再走旧 handler 闭包。
  //
  // 被测点是 SubagentService.dispose 内的 setUiRequestHandler(stub)。uiRequestHandler 是
  // private 字段，用 Reflect.get 取（与 R0-D 块访问 store 同模式）。

  describe("dispose uiRequestHandler stub (dispose-cleanup)", () => {
    /** 从 service 取出 private uiRequestHandler（trailing ui_request 实际调用入口）。 */
    function getHandler(service: SubagentService): UiRequestHandler | undefined {
      return Reflect.get(service, "uiRequestHandler") as UiRequestHandler | undefined;
    }

    /** 最小 UiRequest（method 无关紧要——stub 不论 method 一律返回 cancelled）。 */
    function makeTrailingRequest(id: string): UiRequest {
      return { method: "notify", id };
    }

    it("dispose 后 uiRequestHandler 被 stub 替换，调用返回 {cancelled:true} 不抛错", async () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      service.dispose();

      const handler = getHandler(service);
      expect(handler).toBeDefined();
      // 模拟 dispose 后子进程 trailing ui_request 被父进程 pump 调到 handler
      await expect(handler!(makeTrailingRequest("trailing-1"))).resolves.toEqual({ cancelled: true });
    });

    it("dispose stub 覆盖旧 handler：trailing ui_request 不产生 [subagents] console.error 噪声", async () => {
      // 模拟 session A 的真实 handler 闭包——在 ctx 已 disposed 后调用会抛错
      const staleHandler: UiRequestHandler = async () => {
        throw new Error("stale ctx");
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // [D4-④] setUiRequestHandler 已删——handler 注入走 initSession 参数（唯一入口）
      service.initSession({ pi: makePi(), sessionId: "s1", uiRequestHandler: staleHandler });

      service.dispose();

      // dispose 后 handler 应被 stub 替换，不再是 staleHandler
      const handler = getHandler(service);
      expect(handler).not.toBe(staleHandler);

      // trailing ui_request 调到的是 stub，不抛错、返回 cancelled
      await expect(handler!(makeTrailingRequest("trailing-2"))).resolves.toEqual({ cancelled: true });

      // 关键价值断言：无 "[subagents] uiRequestHandler threw" 误导性噪声
      // （旧实现 dispose 不清 handler 时，trailing ui_request 走 staleHandler 抛错 →
      //   ui-request-queue.ts catch 打该日志。stub 覆盖后该路径不再触发。）
      const subagentsErrors = errorSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[subagents]"),
      );
      expect(subagentsErrors).toHaveLength(0);

      errorSpy.mockRestore();
    });
  });

  // ============================================================
  // execute() worktree 路径（worktree 与 fork 解耦后）
  // ============================================================
  //
  // worktree（文件隔离）与 fork（上下文继承）已解耦：worktree:true 可独立于 fork 工作
  // （worktreeManager.create 只看 opts.worktree，不读 fork）。此组验证三种 fork/worktree
  // 组合下 worktree 路径的行为（均不应抛 'requires fork'——该 guard 已移除）：
  //   1. worktree:true + fork:false → 解耦后正常（创建 worktree 路径，不抛 requires fork）
  //   2. worktree:true + fork:true  → 创建 worktree 路径（测试环境 git 失败，抛非 requires fork 错）
  //   3. worktree:false + fork:false → 默认路径（不创建 worktree）
  //
  // 本文件不 mock spawn（保持与文件头声明一致——execute 集成测试在 execute-nesting /
  // run-spawn-integration），因此 case 验证「不抛 requires fork」而非「执行完成」：
  // 执行越过 worktree 创建后在后续步骤（worktreeManager.create 调 git / runSpawn 调
  // spawn）抛与 fork/worktree 无关的错。用 try/catch 断言抛出的不是 requires fork。

  describe("execute() worktree 路径（worktree 与 fork 解耦）", () => {
    /** 构造已就绪的 service（initSession + initModel 注入 ctxModel，使 resolveIdentity 不因 model 拗错）。 */
    function makeReadyService(): SubagentService {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // 注入 modelRegistry + ctxModel：让 resolveIdentity 越过 resolveModel，
      // 使 guard 之后的失败点稳定在 worktreeManager.create（git）或 runSpawn（spawn），
      // 而非 modelService.resolveModel——避免与 guard 无关的 model 错误掩盖被测点。
      modelService.initModel({
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
        sessionId: "s1",
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
      return service;
    }

    it("worktree:true + fork:false → 解耦后不抛 'requires fork'（worktree 独立于 fork）", async () => {
      const service = makeReadyService();
      // 解耦后 worktree:true+fork:false 不再 throw requires fork（worktreeManager.create 只看 worktree）
      try {
        await service.execute({
          task: "worktree without fork (decoupled)",
          worktree: true,
          fork: false,
          ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
        });
      } catch (err) {
        // 解耦后绝不抛 requires fork（执行继续到 worktreeManager.create/spawn 才可能抛其他错）
        expect((err as Error).message).not.toMatch(/requires fork/);
      }
    });

    it("worktree:true + fork:true → 创建 worktree 路径（不抛 'requires fork'）", async () => {
      const service = makeReadyService();
      // 执行继续：先创建 record，然后 worktreeManager.create 调 git（测试环境无 repo → 抛与 fork 无关的错）
      try {
        await service.execute({
          task: "worktree with fork",
          worktree: true,
          fork: true,
          ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
        });
        // 若未抛（理论上 worktreeManager.create 在某些环境成功）也 OK——重点是没命中 guard
      } catch (err) {
        // guard 放行：抛出的错误绝不能是 "requires fork"
        expect((err as Error).message).not.toMatch(/requires fork/);
      }
    });

    it("worktree:false + fork:false → 默认路径（不创建 worktree，不抛 'requires fork'）", async () => {
      const service = makeReadyService();
      // 默认路径：runSpawn 调 child_process.spawn（测试环境无真实 pi → 抛与 fork 无关的错）
      try {
        await service.execute({
          task: "default path",
          worktree: false,
          fork: false,
          ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
        });
      } catch (err) {
        // guard 放行：抛出的错误绝不能是 "requires fork"
        expect((err as Error).message).not.toMatch(/requires fork/);
      }
    });

    // ============================================================
    // create-await 竞态守卫（Phase 2）：create 的 await 窗口内 dispose/cancel
    // 可把 record CAS 成 closed——守卫须主动 cleanup + early-failed 返回，不 kickOff。
    // 实现约束固化：「赋值 record.worktreeHandle → 终态检查 → 轮次 kick-off」
    // 必须同一同步段（中间禁止 await），本用例即该不变量的回归锚点。
    // ============================================================
    it("守卫：create await 窗口内 dispose 抢先 → cleanup 被调 + early-failed 返回（不 kickOff）", async () => {
      const service = makeReadyService();
      const wtm = Reflect.get(service, "worktreeManager") as WorktreeManager;
      const handle = Object.freeze({
        path: "/tmp/wt-guard",
        branch: "pi-sub-guard",
        baseCommit: "abc123",
        mainCwd: "/repo",
      }) as Parameters<WorktreeManager["cleanup"]>[0];
      let resolveCreate!: (h: unknown) => void;
      vi.spyOn(wtm, "create").mockImplementation(
        () => new Promise((r) => { resolveCreate = r; }) as ReturnType<WorktreeManager["create"]>,
      );
      const cleanupSpy = vi.spyOn(wtm, "cleanup").mockResolvedValue(undefined);

      const execP = service.execute({
        task: "guard test",
        worktree: true,
        fork: false,
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
      // 微任务推进：record 已建 + execute 挂在 pending create 上
      await new Promise((r) => { setTimeout(r, 0); });
      // dispose 抢先（无需 record id）：CAS running → closed，此时 worktreeHandle 仍
      // undefined（dispose 的 fire-and-forget cleanup 跳过）——守卫是唯一的清理点
      service.disposeAllRecords("parent-shutdown");
      resolveCreate(handle);

      const ret = await execP;
      // 守卫生效：handle 被主动清理（不等 60s reaper）
      expect(cleanupSpy).toHaveBeenCalledWith(handle);
      // 返回 early-failed 形态（details.status 已 closed），而非 kickOff 的 running 形态
      expect(ret.mode).toBe("background");
      expect(ret.details).toMatchObject({ status: "closed" });
    });
  });
  //
  // [背景] PR #82 在 subagent-service.ts 新增 emitPendingRegister/Unregister 调用，
  // 5 个 emit 点：register（execute L309）、unregister(failed)（finalizeFailed 经
  // finalizeRecord）、unregister(cancelled)（cancelBackground）、unregister(done)
  //（finalizeRecord 正常完成）、worktree-fail（finalizeFailed 路径，reason=failed）。
  // 此前本文件对这些 emit 零断言，本块补齐。
  //
  // [覆盖策略] 本块覆盖不依赖 runSpawn 完成的 emit 路径：
  //   - register emit：execute 内 createRecordForMode 之后立即触发，在 worktreeManager.create
  //     之前。用 worktree:true+fork:true 让 worktreeManager.create 在测试环境（agentDir 非 git
  //     repo → git status 抛错）失败，既触发 register emit，又顺路走 finalizeFailed →
  //     unregister(failed)。（T2 Wave 0 后只有 background 模式。）
  //   - unregister(cancelled)：cancelBackground 路径。手动注入 running background record 后
  //     调公共 cancel(id) API，无需 runSpawn（覆盖场景 4）。
  //
  // [未覆盖路径] 需 mock spawn 才能跑完 runSpawn 的路径，本文件约定不 mock spawn
  // （见文件头——execute 集成测试在 execute-nesting.test.ts / run-spawn-integration.test.ts）：
  //   - finalizeRecord status="done"（sync/background 正常完成 → unregister(done)）
  //   - finalizeRecord status="cancelled" 经 runAndFinalize 路径（cancel 抢先 CAS 时
  //     runAndFinalize 侧 tryTransition 失败跳过 finalizeRecord，由 cancelBackground 侧 emit——
  //     本块 cancel 用例覆盖的即此后端 emit）
  //   - background detached 正常完成回注（finalizeRecord → emitPendingUnregister(done, {result,error,patchFile})）
  // register emit 的 payload（type:"subagent"、name）由本块 worktree-fail 路径附带覆盖。

  describe("pending-notifications emit 断言 (H4)", () => {
    /** 构造已就绪 service（initSession + initModel）并保留 pi 引用以断言 events.emit。 */
    function makeReadyServiceWithPi(): {
      service: SubagentService;
      pi: ReturnType<typeof makePi>;
    } {
      const pi = makePi();
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi, sessionId: "s1" });
      // 注入 modelRegistry + ctxModel：让 resolveIdentity 越过 resolveModel，
      // 使 worktreeManager.create（git status 在非 repo 抛错）成为稳定失败点，
      // 而非 modelService.resolveModel 抛错（那会在 record 创建之前，无法触发 register emit）。
      modelService.initModel({
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
        sessionId: "s1",
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
      return { service, pi };
    }

    /** 从 service 取出 private store（手动注入 running record 用，与 R0-D 块同模式）。 */
    function getStore(service: SubagentService): RecordStore {
      return Reflect.get(service, "store") as RecordStore;
    }

    /** 手动构造 running background record（带 controller）并注册到 store（绕过 execute/spawn）。 */
    function injectRunningBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        task: "cancel target",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      getStore(service).register(record);
      return record;
    }

    const ctxModel: ModelInfo = { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false };

    it("background execute + worktree 创建失败 → register(bg-id) + unregister(failed) 携带 error 被 emit", async () => {
      const { service, pi } = makeReadyServiceWithPi();

      const handle = await service.execute({
        task: "wt fail bg",
        worktree: true,
        fork: true,
        ctxModel,
      });

      // worktree create 抛错在轮次 kick-off 之前（executeViaEngine 同步 catch），返回 background 形状
      expect(handle.mode).toBe("background");

      // createRecordForMode 生成的 subagentId 带 sa- 前缀（sa-<uuid>）
      expect(handle.subagentId).toMatch(/^sa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // register emit：background mode → id 是 sa-<uuid> 格式
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:register",
        expect.objectContaining({
          type: "subagent",
          id: expect.any(String),
          name: "general-purpose",
        }),
      );
      // unregister(failed) 只记 registry 状态（通知由 BgNotifier 发，不在这条事件里）
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ reason: "closed" }),
      );
    });

    it("cancel(background) → unregister(reason=closed) 被 emit，register 未被 emit（v4 B-1 cancelled 折入 closed）", () => {
      const { service, pi } = makeReadyServiceWithPi();
      const record = injectRunningBackground(service, "bg-cancel-1");
      expect(record.status).toBe("running");

      const ok = service.cancel("bg-cancel-1");

      // cancel CAS 抢锁成功 → cancelBackground 完整收尾 + emit
      expect(ok).toBe(true);
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-cancel-1", reason: "closed" }),
      );
      // record 手动注入（未走 execute）→ register 不应被 emit
      expect(pi.events.emit).not.toHaveBeenCalledWith("pending:register", expect.anything());

      service.dispose();
    });

    // ── T-NFR-8 dispose emit pending:unregister(reason=failed) ──
    //
    // [T2 AC-4.3 双重记账一致性] 进程退出时 running record 随 detached promise 丢弃，
    // finalizeRecord 不会再跑。dispose 中为每个 running record emit pending:unregister，
    // 让 pending-notifications 清理 registry entry，避免两侧状态不一致。
    // 此组验证该 emit 路径。

    it("T-NFR-8: dispose 时每个 running record 都 emit pending:unregister(reason=failed)", () => {
      const { service, pi } = makeReadyServiceWithPi();
      injectRunningBackground(service, "bg-dispose-1");
      injectRunningBackground(service, "bg-dispose-2");
      injectRunningBackground(service, "bg-dispose-3");

      service.dispose();

      // 每个 running record 都 emit 了 pending:unregister(reason=failed)
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-1", reason: "closed" }),
      );
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-2", reason: "closed" }),
      );
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-3", reason: "closed" }),
      );
    });

    it("T-NFR-8: dispose emit 次数 = running record 数（终态 record 不重复 emit）", () => {
      const { service, pi } = makeReadyServiceWithPi();
      // 2 个 running + 1 个终态
      injectRunningBackground(service, "bg-running-1");
      injectRunningBackground(service, "bg-running-2");
      const terminal = injectRunningBackground(service, "bg-done");
      terminal.status = "done"; // 模拟终态，dispose 不应为其 emit

      service.dispose();

      // 统计 pending:unregister 调用次数
      const unregisterCalls = pi.events.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "pending:unregister",
      );
      // 只有 2 个 running record emit，终态的 bg-done 不 emit
      expect(unregisterCalls).toHaveLength(2);
      // 确认终态 record 未被 emit
      expect(pi.events.emit).not.toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-done" }),
      );
    });
  });
});

// ============================================================
// ModelConfigService ctxModel 缓存(renderCall 标题行 model 显示的核心)
// ============================================================
//
// [HISTORICAL] 99f20da1e 后 renderCall 拿不到主 agent model(ToolRenderContext 无 model),
// resolveModel 第三层拗错→降级不显示 model。修复:session_start 缓存 ctxModel,
// resolveModel 第三参默认用缓存。此测试验证该透传链路。

describe("ModelConfigService ctxModel 缓存", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  /** 最小 mock registry:空可用列表(ctxModel 路径不需要 lookup)。 */
  function makeEmptyRegistry(): ModelRegistryLike {
    return {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
  }

  it("initModel 传 ctxModel 后,resolveModel 不传第三参返回缓存 model", () => {
    const svc = makeModelService(agentDir);
    const mainModel: ModelInfo = {
      id: "main-model",
      name: "Main",
      provider: "anthropic",
      reasoning: false,
    };
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "sess-1",
      ctxModel: mainModel,
    });

    // agent 无 model 声明 + 无 override → 走第三层 ctxModel 缓存
    const r = svc.resolveModel("general-purpose");
    expect(r.model).toBe(mainModel);
    expect(r.model.provider).toBe("anthropic");
  });

  it("显式 ctxModel 参数优先于缓存(execute 路径覆盖 renderCall 缓存)", () => {
    const svc = makeModelService(agentDir);
    const cached: ModelInfo = { id: "cached", name: "C", provider: "p1", reasoning: false };
    const explicit: ModelInfo = { id: "explicit", name: "E", provider: "p2", reasoning: false };
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "sess-1",
      ctxModel: cached,
    });

    // execute 传显式 ctxModel → 用显式,不用缓存
    const r = svc.resolveModel("general-purpose", undefined, explicit);
    expect(r.model).toBe(explicit);
  });

  it("setCtxModel 刷新缓存(model_select 后 renderCall 能看到新 model)", () => {
    const svc = makeModelService(agentDir);
    const m1: ModelInfo = { id: "m1", name: "1", provider: "p", reasoning: false };
    const m2: ModelInfo = { id: "m2", name: "2", provider: "p", reasoning: false };
    svc.initModel({ modelRegistry: makeEmptyRegistry(), sessionId: "s", ctxModel: m1 });

    expect(svc.resolveModel("general-purpose").model).toBe(m1);
    svc.setCtxModel(m2); // 模拟 model_select 刷新
    expect(svc.resolveModel("general-purpose").model).toBe(m2);
  });

  it("缓存为空且无 override/agentConfig.model → 拗错(不静默降级)", () => {
    const svc = makeModelService(agentDir);
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "s",
      // ctxModel 不传 → 缓存为空
    });
    // 空 registry + 空 ctxModel → 第三层不可用 → 拗错
    expect(() => svc.resolveModel("general-purpose")).toThrow(/No available model/);
  });
});

// ============================================================
// execute() 集成测试 — 已由 execute-integration.test.ts 覆盖
// ============================================================
// 原先此处的 TODO 已落地为 src/__tests__/execute-integration.test.ts（12 用例），
// 通过 mock 最底层的 SDK 边界（session-runner.getSdk → fakeSdk）跑通完整编排链路：
//   - sync happy / sync error / createAgentSession 失败（finalizeFailed）
//   - background 启动 / background cancel CAS（running 成功 + 已终态 false）
//   - dispose flush（sliding window 内 pending notification）
//   - run() 事件累积（turn_end / message_end usage / tool_start+end / error stopReason）
//   - sync signal abort → cancelled
//   - schema enforcement steer（漏调 structured-output）
// 同时覆盖 session-runner.run() —— event-bridge 合并进 run() 后的事件处理回归。
