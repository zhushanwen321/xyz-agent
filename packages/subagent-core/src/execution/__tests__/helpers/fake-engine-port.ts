// src/execution/__tests__/helpers/fake-engine-port.ts
//
// [W3 chat 域收口] SubagentService 编排层测试共享的 pi EnginePort 替身。
//
// 背景：chat 域执行链路自 W3 起经协议客户端（registry 'pi' 的 cli 形态 port——
// RemoteEngine）发往 pi-subagent-cli 引擎进程；原 inproc 链路的测试替身
//（vi.mock session-runner / FakeChild stdout pump）随 inproc pi 引擎目录 删除消亡。
// 本 helper 是协议 seam 的替身单源：测试经 registerEngine("pi", fake) 注入，
// 拿到 fake 实例后驱动 run/interact/roundLifecycle，断言协议交互。
//
// 消费方式（与 spawn-mock.ts 同款先例）：
//   const fake = registerFakePiEngine();
//   await service.execute({ task: "...", conversation: true });
//   fake.runs[0].settle({ content: "round text" });   // 模拟首轮 agent_settled 应答
//   fake.interacts[0]                                  // interact 受理断言
//
// 形态对照（协议语义，见 pi-subagent-cli chat-session.ts）：
//   - run 应答时点 = 首轮 agent_settled（outcome = 本轮内容非会话终态）；
//   - interact message 受理 = { ok: true, delivered: true }；冷路径 = engine_session_not_resumable；
//   - interact cancel = { ok: true, delivered: true }（引擎侧 SIGTERM → settle → 杀链）；
//   - roundLifecycle 相位由测试显式驱动（idle 帧先于 run 应答帧）。

import type { EnginePort, EngineRunResult, RunContext, ChatRoundRoute } from "../../../execution/engine/port.ts";
import type { AgentCallOpts } from "../../../orchestration/models/types.ts";
import type {
  AgentOutcome,
  EngineCapabilities,
  EngineHandle,
  InteractAction,
  InteractResult,
  ProbeReport,
  SessionView,
} from "../../../execution/engine/types.ts";
import { registerEngine } from "../../../execution/engine/registry.ts";

/** 一次 run 调用的捕获（task + ctx + 结算控制面）。 */
export class FakeRun {
  readonly task: AgentCallOpts;
  readonly ctx: RunContext;
  private resolve!: (r: EngineRunResult) => void;
  private reject!: (err: unknown) => void;
  readonly promise: Promise<EngineRunResult>;

  constructor(task: AgentCallOpts, ctx: RunContext) {
    this.task = task;
    this.ctx = ctx;
    this.promise = new Promise<EngineRunResult>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }

  /** 模拟 run 正常应答（首轮 agent_settled 口径；outcome 缺省 = 成功空轮）。 */
  settle(outcome: Partial<AgentOutcome> = {}): void {
    this.resolve({
      handle: {
        data: {
          v: 1,
          engineId: "pi",
          sessionRef: { recordId: this.ctx.taskId },
          poolKey: "shared",
          adapterVersion: "fake-engine-port",
        },
      },
      outcome: {
        content: "",
        engineId: "pi",
        ...outcome,
      },
    });
  }

  /** 模拟 run 期失败（prepare 期 reject / 引擎进程死亡）。 */
  fail(err: unknown): void {
    this.reject(err);
  }

  /** 模拟引擎反向事件通知（协议 event 通知形态）。 */
  emitEvent(event: unknown): void {
    this.ctx.onEvent?.(event as never);
  }

  /** 模拟 host/streamDelta（runId 键——首轮）。 */
  emitDelta(delta: string): void {
    this.ctx.stream?.onDelta(delta);
  }

  /** 模拟 host/roundLifecycle（runId 键——首轮）。 */
  emitLifecycle(phase: Record<string, unknown>): void {
    this.ctx.onRoundLifecycle?.({ runId: this.ctx.taskId, ...phase } as never);
  }

  /** 模拟 host/handleReady（运行中句柄回填）。 */
  emitHandleReady(sessionRef: Record<string, string>, poolKey = "shared"): void {
    this.ctx.onHandleReady?.({ sessionRef, poolKey });
  }
}

/** 一次 interact 调用的捕获（action 原样记录，供断言）。 */
export interface FakeInteractCall {
  handle: EngineHandle;
  action: InteractAction;
  result: InteractResult | Promise<InteractResult>;
}

export class FakePiEnginePort implements EnginePort {
  readonly id = "pi";

  /** run 调用捕获（按序）。 */
  readonly runs: FakeRun[] = [];
  /** interact 调用捕获（按序；result = 受理时返回值）。 */
  readonly interacts: FakeInteractCall[] = [];
  /** recordId 键路由注册捕获（recordId → 注销函数）。 */
  readonly chatRoutes = new Map<string, ChatRoundRoute>();
  readonly chatRouteUnregisters: string[] = [];

  /** interact message 的应答形态（默认受理；测试改写为冷路径拒绝等）。 */
  interactMessageResult: InteractResult = { ok: true, delivered: true };
  /** interact cancel / close 的应答形态。 */
  interactControlResult: InteractResult = { ok: true, delivered: true };

  capabilities(): EngineCapabilities {
    // 与 pi-subagent-cli manifest 逐位一致（gate 同步面放行 pi 全参数——V4⑤ 反向守护）。
    return {
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "native",
      personaInjection: "flag",
      eventGranularity: "stream",
      sandbox: "emulated",
      sessionRead: "full",
      resume: "native",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: true,
    };
  }

  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake-1", checks: [{ name: "invocation", ok: true, detail: "fake" }] };
  }

  run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    const captured = new FakeRun(task, ctx);
    this.runs.push(captured);
    return captured.promise;
  }

  async interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult> {
    const result = action.kind === "message" ? this.interactMessageResult : this.interactControlResult;
    this.interacts.push({ handle, action, result });
    return result;
  }

  async read(handle: EngineHandle): Promise<SessionView> {
    return { engineId: "pi", turns: [], source: "outcome-only" };
  }

  registerChatRoundRoute(recordId: string, route: ChatRoundRoute): () => void {
    this.chatRoutes.set(recordId, route);
    return () => {
      if (this.chatRoutes.get(recordId) === route) {
        this.chatRoutes.delete(recordId);
        this.chatRouteUnregisters.push(recordId);
      }
    };
  }

  // ── 测试驱动面（recordId 键路由——interact 续聊轮的协议回流）──

  /** 向指定 record 的 chat 路由发 recordId 键 delta。 */
  emitRecordDelta(recordId: string, delta: string): void {
    void this.chatRoutes.get(recordId)?.onStreamDelta?.(delta);
  }

  /** 向指定 record 的 chat 路由发 recordId 键 roundLifecycle 相位。 */
  emitRecordLifecycle(recordId: string, phase: Record<string, unknown>): void {
    void this.chatRoutes.get(recordId)?.onRoundLifecycle?.({ recordId, ...phase } as never);
  }
}

/** 注册替身 pi 引擎进 registry（覆盖同 id 既有注册——测试隔离自负责清理）。 */
export function registerFakePiEngine(): FakePiEnginePort {
  const fake = new FakePiEnginePort();
  registerEngine("pi", () => fake);
  return fake;
}
