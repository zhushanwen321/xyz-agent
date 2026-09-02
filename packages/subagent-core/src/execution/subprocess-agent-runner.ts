// src/execution/subprocess-agent-runner.ts
//
// Wave 4: SubprocessAgentRunner 委托重写
//
// 从"自己 spawn pi"改为"委托 SubagentService.executeAndAwait"。
// MF-3: 从 orchestration/infra 迁入 execution，同层委托 SubagentService。
//
// 接线层级：
//   [跨模块 port] implements AgentRunner（orchestration/models/ports.ts）
//   [模块内直调] mapToExecuteOptions + mergeTimeoutSignal（execute-options-mapper）
//   [P4 路由层]  engine/routing.ts routeEngine（三层优先级 + probe + fallback 三守卫，D9）
//   [引擎层]     EnginePort.run（pi = 本地 DI 绑定实例；非 pi = registry.getEngine 动态获取）
//   [模块内直调] this.subagentService.executeAndAwait（PiEngine 内部委托目标）
//
// 设计基线：
//   D-A2（映射归 adapter）/ D-A8（onEvent 桥接）/ D-A9（timeoutMs 合并 signal）/
//   D-008（model 填底，不调 resolveModel）/ BC-9（timeoutMs 行为）/ BC-10（live-record 进度）

import type { AgentRunner } from "../orchestration/models/ports.ts";
import type { AgentCallOpts, AgentResult } from "../orchestration/models/types.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import { getEngineDataDir } from "./engine/common/data-dir.ts";
import { JournalWriter } from "./engine/common/event-journal.ts";
import { createPiEngine, PI_POOL_KEY } from "./engine/engines/pi/registration.ts";
import { executeOptionsToTaskSpec } from "./engine/engines/pi/task-spec-mapper.ts";
import { resolveJournalPath } from "./engine/paths.ts";
import type { EnginePort, RunContext } from "./engine/port.ts";
import { routeEngine, resolveEngineRouting, type EngineRouteResult, type EngineRoutingInput } from "./engine/routing.ts";
import { getEngine, hasEngine, listEngines } from "./engine/registry.ts";
import type { AgentOutcome, EngineHandle } from "./engine/types.ts";
import { mapToExecuteOptions, mergeTimeoutSignal } from "./execute-options-mapper.ts";
import { getModelConfigService } from "./model-config-service.ts";
import type { ModelInfo } from "./model-resolver.ts";
import { modelRefFromVerified } from "../shared/model-ref";
import { registerSpawnedChildForRecord } from "./engine/engines/pi/session-runner.ts";
import type { SubagentStream } from "./stream-sink.ts";
import type { SubagentService } from "./subagent-service.ts";
import type { ExecuteOptions } from "./types.ts";

// ── 构造依赖（per-session 注入）──

/**
 * SAR 构造参数。
 *
 * per-session（makeDeps 时创建，随 session 销毁）：
 *   - subagentService: 进程单例（getSubagentService()），委托目标
 *   - ctxModel: 当前 session 主 agent 模型（D-008 model 填底，opts.model 空时用此）
 *
 * resolveAgentOpts 在 orchestration 层完成（M2 修正后单参数，只处理 schema SO 指令 + skill），
 * 结果填进 AgentCallOpts.skillPath/schemaEnv/appendSystemPrompt，SAR 收已解析的 opts。
 * 不含 agent/session 目录/临时文件集合依赖（agent ref 交 resolveIdentity，无临时文件）。
 */
export interface SubprocessAgentRunnerDeps {
  subagentService: SubagentService;
  ctxModel?: ModelInfo;
}

/**
 * AgentRunner port 实现——委托 SubagentService.executeAndAwait。
 *
 * 层归属：execution（MF-3 从 orchestration 迁入）。implements orchestration 层 port。
 *
 * 行为契约（BC-1/BC-2/BC-9/BC-10）：
 *   - opts 形状不变（AgentCallOpts，含 resolveAgentOpts 填的 skillPath/schemaEnv）
 *   - result 形状不变（workflow AgentResult: content/parsedOutput/usage/error/toolCalls）
 *   - 不 reject——失败信息入 result.error（与 executeAgentCall 契约一致）
 *   - timeoutMs 合并 signal（D-A9）；onEvent 桥接 AgentEvent→workflow liveRecord（D-A8）
 *
 * [P1 引擎接线] 执行经 EnginePort。pi 引擎绑定本 SAR 的服务引用（per-session DI——
 * 单测注入 mock 时全局单例不可见；生产环境两者是同一进程单例对象），行为零变化；
 * 非 pi 引擎（P4 路由可达：frontmatter/调用参数/全局默认指定）经 registry.getEngine
 * 动态获取——「引擎身份」的归属边界在注册表，SAR 不感知具体引擎实现。
 *
 * [P4 配置路由] 每次运行经 engine/routing.ts 解析三层优先级（调用参数 opts.engine >
 * agent frontmatter engine > 全局默认 'pi'）+ probe + fallback 三守卫（D9）。路由失败
 * （engine_not_found / engine_probe_failed / model_not_available）不 reject，入
 * result.error——与 executeAgentCall 契约一致。
 */
export class SubprocessAgentRunner implements AgentRunner {
  private readonly subagentService: SubagentService;
  private ctxModel: ModelInfo | undefined;
  /** pi 引擎（per-session DI 绑定，缺省执行路径——见类注释）。 */
  private readonly piEngine: EnginePort;

  constructor(deps: SubprocessAgentRunnerDeps) {
    this.subagentService = deps.subagentService;
    this.ctxModel = deps.ctxModel;
    this.piEngine = createPiEngine(() => this.subagentService);
  }

  /**
   * 刷新主 agent model 缓存。model_select 事件时由 index.ts 调用。
   * H1 修复：旧实现 ctxModel 是 readonly，session_start 后固化，
   * model_select 只刷新 ModelConfigService._ctxModel 不更新 SAR →
   * workflow 路径用过期模型。
   */
  updateCtxModel(model: ModelInfo | undefined): void {
    this.ctxModel = model;
  }

  /**
   * 执行单次 agent 调用：路由（P4）→ EnginePort.run → PiEngine 委托
   * SubagentService.executeAndAwait。
   *
   * 接线链路：
   *   routeEngine（三层 + probe + 守卫）→ mergeTimeoutSignal → mapToExecuteOptions →
   *   AgentTaskSpec → engine.run（PiEngine：spec → ExecuteOptions 还原 + engine 留痕）→
   *   executeAndAwait → AgentOutcome → AgentResult
   *
   * 错误处理：不 reject。
   *   - 路由失败（未注册 id / probe 失败 + 守卫或 strict）→ AgentResult.error（错误码前缀）
   *   - executeAndAwait 内部失败 → 返回 AgentResult(success:false) → 已映射 error 字段
   *   - executeAndAwait throw（嵌套超限 BC-12）→ catch → AgentResult.error
   *   - spawn 级失败已由 runSpawn 内部收口为 failed AgentResult（不逃逸）
   */
  async run(
    opts: AgentCallOpts,
    signal: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<AgentResult> {
    const startedAt = Date.now();

    // ── P4 路由：三层优先级 + probe + fallback 三守卫（D9①/D7）──
    // 路由在最前——引擎身份决定 journal 路径与后续一切执行面；失败（未注册 id /
    // probe 失败 + strict/守卫）按「不 reject」契约转 result.error。
    // pi 快路径同步短路（不经 routeEngine 的 await）：pi 恒免探、无 fallback 可言、
    // engineFor('pi') 本地 DI 绑定恒可用——不引入微任务边界，缺省路径时序与 P1 接线
    // 前完全一致（下游依赖「run 内首个 await 前已触达 executeAndAwait」的时序契约）。
    let routingInput: EngineRoutingInput;
    let route: EngineRouteResult;
    try {
      routingInput = this.buildRoutingInput(opts);
      const routing = resolveEngineRouting(routingInput);
      if (routing.engineId === "pi") {
        route = {
          engine: this.piEngine,
          engineId: "pi",
          requestedEngineId: "pi",
          source: routing.source,
        };
      } else {
        route = await routeEngine({
          routing: routingInput,
          taskModel: opts.model,
          strict: getModelConfigService()?.getGlobalConfig().engineRouting?.strict === true,
          probe: (engineId) => this.engineFor(engineId).probe(),
          getEngineFn: (engineId) => this.engineFor(engineId),
          // pi 经本地 DI 绑定恒可用（不依赖 registry 全局注册态——SAR 持有服务引用），
          // has/list 注入同一口径，engine_not_found 文案不会把本地 pi 漏报成未注册
          hasEngineFn: (engineId) => engineId === "pi" || hasEngine(engineId),
          listEnginesFn: () => (hasEngine("pi") ? listEngines() : ["pi", ...listEngines()]),
        });
      }
    } catch (err) {
      // buildRoutingInput 的 agent 解析期校验（未注册 frontmatter engine）与路由失败
      // （probe + strict/守卫）一并在此收口——「不 reject」契约
      return errorResult(err, startedAt);
    }

    // ── P2 event journal 接线（设计 D6 第②级；对齐点③：路径权威 = 引擎池 key）──
    // host 在 onEvent 回调内统一落盘（全引擎免费获得②级数据源）。初始 poolKey 用 pi
    // 缺省占位（pi 恒 'shared'）；非池化稳定引擎（zcode）在 prepare 期经
    // RunContext.onPoolResolved 声明实际池 key → writer.retarget——保证 journal 落盘
    // 路径与 handle.poolKey 同源（handle.journalPath 由本方法 run 返回后回填）。
    //
    // taskId 为宿主侧任务标识（journal 文件名与池引用计数 key）——executeAndAwait
    // 不外露内部 record id（取真实 id 需 hook record store 且改 createRecordForMode
    // 签名，影响面大；P4 决策：保留占位，`sa-` 前缀与 record id 同构。影响面：record
    // GC 时无法按 taskId 联动删 journal（journal 依赖 30 天 TTL 自然回收），read ②级
    // 经 handle.journalPath 自描述定位不受影响）。
    const taskId = `sa-${crypto.randomUUID()}`;
    const journal = new JournalWriter({
      path: resolveJournalPath(getEngineDataDir(), route.engineId, PI_POOL_KEY, taskId),
      taskId,
      engineId: route.engineId,
    });
    const retargetJournal = (poolKey: string): void => {
      journal.retarget(resolveJournalPath(getEngineDataDir(), route.engineId, poolKey, taskId));
    };
    // 包装：先写 journal 再转发原 onEvent（原 onEvent 未传时也恒传包装版——
    // 下游 onEvent 通道是事件生成后的纯转发，无行为分支，仅多一次入队）
    const journalingOnEvent = (event: AgentEvent): void => {
      journal.append(event);
      onEvent?.(event);
    };

    try {
      // ── [U1 D2] RunContext.modelRef 接入：ctxModel 继承路径的孪生守卫 ──
      // ctxModel 是运行时已验证的 ModelInfo（豁免 registry 存在性复查），但继承产出的
      // canonical 串与显式入参走同一个 pi pattern 引擎，孪生守卫同等适用（modelRefFromVerified）。
      // 守卫在 engine.run 之前同步拒绝：含孪生 registry 下不产生任何 record/spawn，
      // 失败走下方 catch → errorResult（错误文案含恢复指引）。
      // RunContext 类型本身定义在 engine/port.ts（跨模块 port，不在本单元领地），
      // 故接入点为构造 runCtx 前的守卫调用；pi 链路下游 resolveModel 的 ctxModel 分支
      // 有同一守卫（model-resolver.ts），两处共用同一入口函数。
      if (this.ctxModel) {
        const modelService = getModelConfigService();
        if (modelService) modelRefFromVerified(this.ctxModel, modelService.getModelRegistry());
      }

      // ── D-A9: timeoutMs 合并 signal（超时 abort 带 HOST_TIMEOUT_ABORT_REASON 标记）──
      const mergedSignal = mergeTimeoutSignal(signal, opts.timeoutMs);

      // ── D-A2 + D-008: AgentCallOpts → ExecuteOptions 映射 ──
      const mappedOpts: ExecuteOptions = mapToExecuteOptions(opts, this.ctxModel);

      // ── P1/P4 引擎接线：EnginePort.run ──
      const runCtx: RunContext = {
        taskId,
        poolKey: PI_POOL_KEY,
        signal: mergedSignal,
        onEvent: journalingOnEvent,
        ctxModel: this.ctxModel,
        ...(route.engineFallback !== undefined ? { engineFallback: route.engineFallback } : {}),
        onPoolResolved: retargetJournal,
        // [U0 D10] 终止链路径①：引擎 spawn 的子进程注册进 session-runner 的
        // spawnedChildren 记账（dispose killAll 收割兜底对 workflow 域引擎任务生效）；
        // taskId（'sa-' 前缀）即记账 key，与 chat 域 kickOffEngineRun 的 record.id 同构
        onChildSpawned: (child) => registerSpawnedChildForRecord(taskId, child),
        ...(stream !== undefined ? { stream } : {}),
        // 解耦形态（有 schemaEnv 无 schema）的兜底通道——耦合形态下引擎从 task.schema
        // 派生等值，此值被忽略（见 RunContext.schemaEnv 注释）
        ...(mappedOpts.schemaEnv !== undefined ? { schemaEnv: mappedOpts.schemaEnv } : {}),
      };
      const { handle, outcome } = await route.engine.run(
        // 泛化为中立声明（PiEngine 内部再还原回 ExecuteOptions——往返保真，
        // 由 engines/pi/__tests__/task-spec-mapper.test.ts 逐字段锁定）
        executeOptionsToTaskSpec(mappedOpts),
        runCtx,
      );
      // handle.journalPath 回填（§3.3.6：read ②级的自描述定位符——运行期落盘路径
      // 权威在 writer，handle 记录最终路径供跨重启 read 消费）
      backfillJournalPath(handle, journal.path);
      return outcomeToRunnerResult(outcome);
    } catch (err) {
      // executeAndAwait throw（嵌套超限 ForkDepthExceededError，BC-12）或未预期异常 → 不 reject，入 error。
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: "",
        durationMs: Date.now() - startedAt,
        error: message,
        toolCalls: [],
      };
    } finally {
      // run 终态后 flush + fsync 一次（§3.3.6 写入纪律）；写失败已由 writer 内部
      // warn + failed 收口，close 不抛（journal 是②级尽力而为数据源）
      await journal.close();
    }
  }

  // ── 内部 ──

  /**
   * 引擎获取：pi 走 per-session DI 绑定（mock 语义 + 生产同单例，P1 行为零变化）；
   * 非 pi 经 registry.getEngine 动态获取（P4：引擎身份归属注册表，未注册 id 抛
   * EngineNotFoundError——路由期已前置校验，这里是防御性兜底）。
   */
  private engineFor(engineId: string): EnginePort {
    if (engineId === "pi") return this.piEngine;
    return getEngine(engineId);
  }

  /**
   * 三层路由输入装配（D9）：调用参数（opts.engine，workflow step 级透传）> agent
   * frontmatter（ModelConfigService.getAgentConfig——loadByPath mtime 缓存，幂等）>
   * 全局默认（config.json defaultEngine）。单例未就绪（session_start 前/测试 mock）
   * 时各层缺省——落内置 'pi'。
   */
  private buildRoutingInput(opts: AgentCallOpts): EngineRoutingInput {
    const service = getModelConfigService();
    const agentEngine =
      opts.agent !== undefined && opts.agent !== "" ? service?.getAgentConfig(opts.agent)?.engine : undefined;
    const globalDefault = service?.getGlobalConfig().defaultEngine;
    return {
      ...(opts.engine !== undefined && opts.engine !== "" ? { callEngine: opts.engine } : {}),
      ...(agentEngine !== undefined && agentEngine !== "" ? { agentEngine } : {}),
      ...(globalDefault !== undefined && globalDefault !== "" ? { globalDefaultEngine: globalDefault } : {}),
    };
  }
}

/** 路由期错误 → AgentResult.error（错误码前缀格式保留——engine_not_found 等）。 */
function errorResult(err: unknown, startedAt: number): AgentResult {
  return {
    content: "",
    durationMs: Date.now() - startedAt,
    error: err instanceof Error ? err.message : String(err),
    toolCalls: [],
  };
}

/** handle.journalPath 回填（一次写者：SAR 是 handle 的首个消费者）。 */
function backfillJournalPath(handle: EngineHandle, journalPath: string): void {
  handle.data.journalPath = journalPath;
}

/**
 * AgentOutcome → workflow AgentResult：剥离引擎层新增字段（engineId/engineFallback/
 * exitCode——engineFallback 经 record（pi 路径）/outcome（zcode 路径）留痕，GUI 投影
 * 通道在后续 wave 接线，workflow 引擎不消费）。其余字段由 PiEngine 从 executeAndAwait
 * 的返回值逐字段映射而来，字段全集完整性由 pi-engine 单测锁定（缺字段会在该处转红，
 * 不会静默丢失）。
 */
function outcomeToRunnerResult(outcome: AgentOutcome): AgentResult {
  return {
    content: outcome.content,
    parsedOutput: outcome.parsedOutput,
    usage: outcome.usage,
    durationMs: outcome.durationMs,
    error: outcome.error,
    sessionId: outcome.sessionId,
    sessionFile: outcome.sessionFile,
    worktreePath: outcome.worktreePath,
    toolCalls: outcome.toolCalls,
  };
}
