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
//   [引擎层]     EnginePort.run（P1 接线：经 engines/pi 适配，缺省引擎 'pi'）
//   [模块内直调] this.subagentService.executeAndAwait（PiEngine 内部委托目标）
//
// 设计基线：
//   D-A2（映射归 adapter）/ D-A8（onEvent 桥接）/ D-A9（timeoutMs 合并 signal）/
//   D-008（model 填底，不调 resolveModel）/ BC-9（timeoutMs 行为）/ BC-10（live-record 进度）

import type { AgentRunner } from "../orchestration/models/ports.ts";
import type { AgentCallOpts, AgentResult } from "../orchestration/models/types.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import { createPiEngine, PI_POOL_KEY } from "./engine/engines/pi/registration.ts";
import { executeOptionsToTaskSpec } from "./engine/engines/pi/task-spec-mapper.ts";
import type { EnginePort, RunContext } from "./engine/port.ts";
import type { AgentOutcome } from "./engine/types.ts";
import { mapToExecuteOptions, mergeTimeoutSignal } from "./execute-options-mapper.ts";
import type { ModelInfo } from "./model-resolver.ts";
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
 * [P1 引擎接线] 执行经 EnginePort（缺省引擎 'pi'，registry SSOT 见
 * engine/engines/pi/registration.ts）。PiEngine 是薄适配层：把 ExecuteOptions 泛化为
 * AgentTaskSpec 再映射回 ExecuteOptions（往返保真，task-spec-mapper 单测锁定），最终
 * 仍调本类注入的 subagentService.executeAndAwait——下游执行路径与 record 产出零变化。
 * 引擎实例在构造期绑定本 SAR 的服务引用而非取 registry 全局单例：SAR 是 per-session
 * DI 构造（单测注入 mock 时全局单例不可见），生产环境两者是同一进程单例对象。
 */
export class SubprocessAgentRunner implements AgentRunner {
  private readonly subagentService: SubagentService;
  private ctxModel: ModelInfo | undefined;
  /** 执行引擎（缺省 'pi'；构造期绑定注入服务，见类注释）。 */
  private readonly engine: EnginePort;

  constructor(deps: SubprocessAgentRunnerDeps) {
    this.subagentService = deps.subagentService;
    this.ctxModel = deps.ctxModel;
    this.engine = createPiEngine(() => this.subagentService);
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
   * 执行单次 agent 调用：经 EnginePort 委托 SubagentService.executeAndAwait。
   *
   * 接线链路：
   *   mergeTimeoutSignal → mapToExecuteOptions → AgentTaskSpec →
   *   engine.run（PiEngine：spec → ExecuteOptions 还原）→
   *   this.subagentService.executeAndAwait → AgentOutcome → AgentResult
   *
   * 错误处理：不 reject。
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

    try {
      // ── D-A9: timeoutMs 合并 signal ──
      const mergedSignal = mergeTimeoutSignal(signal, opts.timeoutMs);

      // ── D-A2 + D-008: AgentCallOpts → ExecuteOptions 映射 ──
      const mappedOpts: ExecuteOptions = mapToExecuteOptions(opts, this.ctxModel);

      // ── D-A8: onEvent 桥接 ──
      // executeAndAwait 发强类型 AgentEvent（session-runner handleSdkEvent 出口）。
      // workflow 的 onEvent 闭包（error-recovery.ts dispatchAgentCall）类型已升级为
      // (event: AgentEvent) => updateFromEvent(liveRecord, event)（D-005）。
      // 引擎层直接透传 onEvent——类型对齐后零桥接开销。
      const bridgedOnEvent = onEvent;

      // ── P1 引擎接线：EnginePort.run（缺省 'pi'）──
      // taskId 为宿主侧任务标识（journal 文件名与池引用计数 key，P2 消费）——P1 无
      // journal 写入者，executeAndAwait 内部创建的 record.id 不外露，此处生成唯一
      // 占位（`sa-` 前缀与 record id 同构）；P4 配置路由落地时改为真实 record.id。
      const runCtx: RunContext = {
        taskId: `sa-${crypto.randomUUID()}`,
        poolKey: PI_POOL_KEY,
        signal: mergedSignal,
        ...(bridgedOnEvent !== undefined ? { onEvent: bridgedOnEvent } : {}),
        ctxModel: this.ctxModel,
        ...(stream !== undefined ? { stream } : {}),
        // 解耦形态（有 schemaEnv 无 schema）的兜底通道——耦合形态下引擎从 task.schema
        // 派生等值，此值被忽略（见 RunContext.schemaEnv 注释）
        ...(mappedOpts.schemaEnv !== undefined ? { schemaEnv: mappedOpts.schemaEnv } : {}),
      };
      const { outcome } = await this.engine.run(
        // 泛化为中立声明（PiEngine 内部再还原回 ExecuteOptions——往返保真，
        // 由 engines/pi/__tests__/task-spec-mapper.test.ts 逐字段锁定）
        executeOptionsToTaskSpec(mappedOpts),
        runCtx,
      );
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
    }
  }
}

/**
 * AgentOutcome → workflow AgentResult：剥离引擎层新增字段（engineId/engineFallback/
 * exitCode——它们投影进 record/GUI 的通道在 P2/P4 接线，workflow 引擎不消费）。
 * 其余字段由 PiEngine 从 executeAndAwait 的返回值逐字段映射而来，字段全集完整性由
 * pi-engine 单测锁定（缺字段会在该处转红，不会静默丢失）。
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
