// src/execution/subprocess-agent-runner.ts
//
// Wave 4: SubprocessAgentRunner 委托重写
//
// 从"自己 spawn pi"改为"委托 SubagentService.executeAndAwait"。
// MF-3: 从 orchestration/infra 迁入 execution，同层委托 SubagentService。
//
// [D6 任务形状合流] AgentCallOpts 已是 EnginePort.run 的单一任务形状——本类直传 opts
// 给 engine.run（无 ExecuteOptions/AgentTaskSpec 中间态映射）；pi 边界的一次直出在
// PiEngine.agentCallToExecuteOptions。mergeTimeoutSignal（原 execute-options-mapper
// 的运行期件，D-A9）随 mapper 删除迁入本文件（唯一消费点）。
//
// 接线层级：
//   [跨模块 port] implements AgentRunner（orchestration/models/ports.ts）
//   [模块内直调] mergeTimeoutSignal（本文件，D-A9）
//   [P4 路由层]  engine/routing.ts routeEngineForHost（D3-② 路由单点：三层优先级 +
//                pi 同步短路 + probe + fallback 三守卫，D9）
//   [公共预检]   engine/common/capability-gate（D3-④：capabilities 驱动的调用前拒绝）
//   [引擎层]     EnginePort.run（pi = 本地 DI 绑定实例；非 pi = registry.getEngine 动态获取）
//   [公共 journal] engine/common/journal-wiring（D3-③：writer + retarget + 回填单实现）
//   [模块内直调] this.subagentService.executeAndAwait（PiEngine 内部委托目标）
//
// 设计基线：
//   D-A8（onEvent 桥接）/ D-A9（timeoutMs 合并 signal）/
//   D-008（model 填底，不调 resolveModel）/ BC-9（timeoutMs 行为）/ BC-10（live-record 进度）

import type { AgentRunner } from "../orchestration/models/ports.ts";
import type { AgentCallOpts, AgentResult } from "../orchestration/models/types.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import { assertTaskShapeSupported } from "./engine/common/capability-gate.ts";
import { HOST_TIMEOUT_ABORT_REASON } from "./engine/common/kill-chain.ts";
import { JOURNAL_INITIAL_POOL_KEY, wireEventJournal } from "./engine/common/journal-wiring.ts";
import { createPiEngine } from "./engine/engines/pi/registration.ts";
import type { EnginePort, RunContext } from "./engine/port.ts";
import { validateModelForEngine } from "./engine/model-validation.ts";
import { routeEngineForHost, type EngineRouteResult, type EngineRoutingInput } from "./engine/routing.ts";
import { getEngine } from "./engine/registry.ts";
import type { AgentOutcome } from "./engine/types.ts";
import { getModelConfigService } from "./model-config-service.ts";
import type { ModelInfo } from "./model-resolver.ts";
import { modelRefFromVerified } from "../shared/model-ref";
import { registerSpawnedChildForRecord } from "./engine/engines/pi/session-runner.ts";
import type { SubagentStream } from "./stream-sink.ts";
import type { SubagentService } from "./subagent-service.ts";

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
 * [P4 配置路由] 每次运行经 engine/routing.ts 的 routeEngineForHost（D3-② 路由单点：
 * 唯一实现承载三层优先级（调用参数 opts.engine > agent frontmatter engine > 全局默认
 * 'pi'）+ pi 同步短路 + registry 注入 + probe/fallback 三守卫，D9；本类与
 * SubagentService.execute 是其仅有的两调用点）。路由失败（engine_not_found /
 * engine_probe_failed / model_not_available）与预检命中（engine_capability_unsupported，
 * D3-④）不 reject，入 result.error——与 executeAgentCall 契约一致。
 */
export class SubprocessAgentRunner implements AgentRunner {
  private readonly subagentService: SubagentService;
  private ctxModel: ModelInfo | undefined;
  /** pi 引擎（per-session DI 绑定，缺省执行路径——见类注释）。 */
  private readonly piEngine: EnginePort;

  constructor(deps: SubprocessAgentRunnerDeps) {
    this.subagentService = deps.subagentService;
    this.ctxModel = deps.ctxModel;
    // [D4 聚合连带] 经 asEngineService 显式视图适配（原结构化直绑依赖查询面 public）。
    this.piEngine = createPiEngine(() => this.subagentService.asEngineService);
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
   * 执行单次 agent 调用：路由（P4）→ 预检（D3-④）→ EnginePort.run → PiEngine 委托
   * SubagentService.executeAndAwait。
   *
   * 接线链路：
   *   routeEngineForHost（D3-② 路由单点：三层 + pi 同步短路 + probe + 守卫）→
   *   assertTaskShapeSupported（D3-④ 预检 capabilities 化）→ mergeTimeoutSignal →
   *   engine.run(opts 直传——D6 合流：AgentCallOpts 即 EnginePort 任务形状，零映射；
   *   PiEngine 内一次直出 ExecuteOptions + engine 留痕) → executeAndAwait →
   *   AgentOutcome → AgentResult
   *
   * 错误处理：不 reject。
   *   - 路由失败（未注册 id / probe 失败 + 守卫或 strict）→ AgentResult.error（错误码前缀）
   *   - 预检命中（capabilities 不支持的任务形状参数）→ AgentResult.error
   *     （engine_capability_unsupported——[D3-④] workflow 域 zcode+worktree 由漏拦变
   *     拦截，本单元唯一有意行为变化；拒绝在 journal/run 之前，无进程无 journal 产物）
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

    // ── P4 路由（D3-② 单点：routeEngineForHost）+ D3-④ 预检 ──
    // 路由在最前——引擎身份决定 journal 路径与后续一切执行面。pi 快路径同步短路
    //（routed 非 Promise，零微任务——缺省路径时序与 P1 接线前完全一致，下游依赖
    // 「run 内首个 await 前已触达 executeAndAwait」的时序契约）。路由失败（未注册
    // id / probe 失败 + strict/守卫）与预检命中（capabilities 驱动，含 worktree——
    // workflow 域漏拦缺口修复）一并按「不 reject」契约转 result.error。
    let route: EngineRouteResult;
    try {
      const routed = routeEngineForHost({
        routing: this.buildRoutingInput(opts),
        taskModel: opts.model,
        strict: getModelConfigService()?.getGlobalConfig().engineRouting?.strict === true,
        probe: (engineId) => this.engineFor(engineId).probe(),
        piEngine: this.piEngine,
      });
      route = routed instanceof Promise ? await routed : routed;
      // [D3-④] SAR 路径预检调用点（run 前同模块调用；唯一实现 = common/capability-gate）。
      // pi 全参数放行（V4⑤ 反向守护）；zcode 拦 fork/conversation/maxTurns/worktree。
      // [D6 合流] opts（AgentCallOpts）直传预检——TaskShapeForGate 是结构子集，
      // conversation/fork/worktree/maxTurns 均在合流形状字段表内。
      assertTaskShapeSupported(route.engineId, route.engine.capabilities(), opts);
      // [u-h2 D2-2 调用点②] workflow 域非 pi 引擎的派发同步期 model 校验——与 chat
      // 路径（subagent-service.executeViaEngine）共享同一入口 validateModelForEngine
      // 与同一错误文案（V2-4④：agent({engine:'zcode', model:<pi id>}) 同步期报
      // 「引擎与模型不配套」，不再落 engine.run 的 prepare 期晚炸）。校验对象是显式
      // opts.model（frontmatter model 的解析归 pi 链，workflow 域非 pi 路径现状不消费
      // ——维持现状语义不扩散）。「不 reject」契约：throw 由本 try 的 catch 收口
      // errorResult，不进入 journal 创建与 engine.run（零 record/spawn 副作用）。
      if (route.engineId !== "pi") {
        validateModelForEngine(route.engine, opts.model);
      }
    } catch (err) {
      // buildRoutingInput 的 agent 解析期校验（未注册 frontmatter engine）、路由失败
      //（probe + strict/守卫）与预检拒绝（engine_capability_unsupported）一并在此
      // 收口——「不 reject」契约
      return errorResult(err, startedAt);
    }

    // ── P2 event journal 接线（设计 D6 第②级；对齐点③：路径权威 = 引擎池 key）──
    // [D3-③] writer + retarget + 回填收敛 common/journal-wiring（与 chat 域同一实现）：
    // 初始 poolKey 占位 'shared'（pi 恒终值）；非池化稳定引擎（zcode）在 prepare 期经
    // RunContext.onPoolResolved 声明实际池 key → retarget——保证 journal 落盘路径与
    // handle.poolKey 同源（handle.journalPath 由本方法 run 返回后回填）。
    //
    // taskId 为宿主侧任务标识（journal 文件名与池引用计数 key）——executeAndAwait
    // 不外露内部 record id（取真实 id 需 hook record store 且改 createRecordForMode
    // 签名，影响面大；P4 决策：保留占位，`sa-` 前缀与 record id 同构。影响面：record
    // GC 时无法按 taskId 联动删 journal（journal 依赖 TTL 兜底回收，见 D8 分域裁决），
    // read ②级经 handle.journalPath 自描述定位不受影响）。
    const taskId = `sa-${crypto.randomUUID()}`;
    const journal = wireEventJournal({ engineId: route.engineId, taskId, forwardEvents: onEvent });

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

      // ── P1/P4 引擎接线：EnginePort.run ──
      const runCtx: RunContext = {
        taskId,
        poolKey: JOURNAL_INITIAL_POOL_KEY,
        signal: mergedSignal,
        onEvent: journal.onEvent,
        ctxModel: this.ctxModel,
        ...(route.engineFallback !== undefined ? { engineFallback: route.engineFallback } : {}),
        onPoolResolved: journal.onPoolResolved,
        // [U0 D10] 终止链路径①：引擎 spawn 的子进程注册进 session-runner 的
        // spawnedChildren 记账（dispose killAll 收割兜底对 workflow 域引擎任务生效）；
        // taskId（'sa-' 前缀）即记账 key，与 chat 域 kickOffEngineRun 的 record.id 同构
        onChildSpawned: (child) => registerSpawnedChildForRecord(taskId, child),
        ...(stream !== undefined ? { stream } : {}),
        // [D6 合流] 解耦形态（有 schemaEnv 无 schema）不再经 RunContext.schemaEnv
        // 兜底通道——schemaEnv 已在合流形状 AgentCallOpts.schemaEnv 内，pi 直出
        // （agentCallToExecuteOptions）以「schema 派生优先、schemaEnv 兜底」取值，
        // 与原 ctx 兜底链路逐字节等值。
      };
      const { handle, outcome } = await route.engine.run(
        // [D6 合流] opts 直传——AgentCallOpts 即 EnginePort 任务形状（缺省路径零映射；
        // pi 边界一次直出由 PiEngine.agentCallToExecuteOptions 承担，逐字段等值由
        // engines/pi/__tests__/spawn-opts-direct.test.ts 对照表锁定）
        opts,
        runCtx,
      );
      // handle.journalPath 回填（§3.3.6：read ②级的自描述定位符——运行期落盘路径
      // 权威在 writer，handle 记录最终路径供跨重启 read 消费）
      journal.backfillHandle(handle);
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
   * 引擎获取（routeEngineForHost 的 probe 注入体）：pi 走 per-session DI 绑定（mock
   * 语义 + 生产同单例，P1 行为零变化）；非 pi 经 registry.getEngine 动态获取（P4：
   * 引擎身份归属注册表，未注册 id 抛 EngineNotFoundError——路由期已前置校验，这里
   * 是防御性兜底）。[D3-②] get/has/list 的路由期注入已由 routeEngineForHost 内部
   * 承载（本地 pi 恒可用口径），本方法只剩 probe 一个消费点（pi 请求同步短路恒免探）。
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

/** 路由期/预检错误 → AgentResult.error（错误码前缀格式保留——engine_not_found 等）。 */
function errorResult(err: unknown, startedAt: number): AgentResult {
  return {
    content: "",
    durationMs: Date.now() - startedAt,
    error: err instanceof Error ? err.message : String(err),
    toolCalls: [],
  };
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
    // [D5-③] 失败分诊标签透传（pi 引擎产出；zcode 不产 failureKind，缺省 =
    // unknown = 可重试）。成功路径 undefined 不落键。
    ...(outcome.failureKind !== undefined ? { failureKind: outcome.failureKind } : {}),
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

/**
 * D-A9: per-call timeoutMs 合并进 AbortSignal（[D6 合流迁入]——原定义在已删除的
 * execution/execute-options-mapper.ts，本类是唯一消费点，运行期件随消费方落位）。
 *
 * 墙钟 timeoutMs（per-call）+ 外部 signal（run 级 abort）都生效。
 * 缺此合并则 agent({timeoutMs:5000}) 静默无效（BC-9）。
 *
 * @param signal    外部 signal（workflow run 级 controller.signal）
 * @param timeoutMs per-call 墙钟超时；undefined/<=0 → 不设超时，原样返回 signal
 * @returns 合并后的 signal（timeoutMs 或外部 signal 任一 abort 都触发）
 */
export function mergeTimeoutSignal(
  signal: AbortSignal,
  timeoutMs?: number,
): AbortSignal {
  if (!timeoutMs || timeoutMs <= 0) {
    return signal;
  }

  const controller = new AbortController();
  // 超时 abort 带 reason 标记（对齐点④）：引擎合成终态时判别「宿主超时」
  // （engine_timeout 公共合成）vs「外部 cancel」（中止标记）——pi 链路不读 reason，
  // 行为不变。外部 signal abort 不带标记（用户/编排层 cancel 语义）。
  const timer = setTimeout(() => controller.abort(HOST_TIMEOUT_ABORT_REASON), timeoutMs);
  timer.unref();

  const onExternalAbort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      if (!signal.aborted) signal.removeEventListener("abort", onExternalAbort);
    },
    { once: true },
  );

  return controller.signal;
}
