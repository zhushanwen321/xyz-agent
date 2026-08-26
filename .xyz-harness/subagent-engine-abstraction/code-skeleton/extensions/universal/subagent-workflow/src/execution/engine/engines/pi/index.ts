// execution/engine/engines/pi/index.ts
//
// PiEngine——现有 pi spawn 链的 EnginePort 回填实现（P1，行为零变化）。
// 结构：编排壳（session-runner 保留 record/worktree/生命周期编排）→ 本引擎
// （preparer env 组装 / launcher spawn / parser 事件翻译 / reader 直读）。
// capabilities 声明口径 = 链路接通能力（D3）：pi RPC 有 steer 但 spawn 链路未接通，
// 首期 steer 声明 unsupported（接通后再升级——AC-9.3）。

import { readViaJournal } from "../../degradation/journal.ts";
import { PI_POOL_KEY } from "../../degradation/pool-manager.ts";
import { type EngineDeps, type EngineHandle, type EnginePort } from "../../port.ts";
import type {
  AgentOutcome,
  AgentTaskSpec,
  EngineCapabilities,
  EngineHandleData,
  EngineRunResult,
  InteractAction,
  InteractResult,
  ProbeReport,
  RunContext,
  SessionView,
} from "../../types.ts";
import { PiLauncher } from "./launcher.ts";
import { PiParser } from "./parser.ts";
import { PiPreparer } from "./preparer.ts";
import { PiReader } from "./reader.ts";

/** pi 首期能力声明（D3 十维；链路接通口径）。 */
export const PI_CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "native",       // PI_WORKFLOW_SCHEMA env 注入链路（不过仿真层——D4 硬分流）
  steer: "unsupported",              // RPC 层有，spawn 链路未接通（AC-9.3；接通后升级）
  conversation: "native",            // chatMode idle 复用（interact 面原生实现，BC-7）
  personaInjection: "flag",          // --append-system-prompt/--skill flag 通道（文件经 flag 引用）
  eventGranularity: "stream",        // rpc 逐行事件流
  sandbox: "emulated",               // worktree 隔离（无 OS 级 sandbox）
  sessionRead: "full",               // JSONL 直读全量
  resume: "native",                  // --session 续写
  interrupt: "native",               // 原生 abort（优雅中断优先，杀链兜底）
  permissionMode: "native",
};

export class PiEngine implements EnginePort {
  readonly id = "pi";
  private readonly preparer = new PiPreparer();
  private readonly parser = new PiParser();
  private readonly reader = new PiReader();

  constructor(private readonly deps: EngineDeps, private readonly launcher: PiLauncher) {}

  capabilities(): EngineCapabilities {
    return PI_CAPABILITIES;
  }

  /** D7 探针：pi 二进制存在（getPiInvocation 解析）+ 版本解析 + golden 终态样本回归。 */
  async probe(_opts?: { force?: boolean }): Promise<ProbeReport> {
    throw new Error("skeleton: pi probe (binary/version/golden regression)");
  }

  /**
   * 主语义：prepare → launch → consume（事件先发）→ 终态组装。
   * 接线链：真调四件套（Level 1 调用链闭合）；终态组装细节（AgentResult 累积器
   * collectResult 语义）属实现域叶子。
   */
  async run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult> {
    const pool = await this.deps.poolManager.acquire(this.id, PI_POOL_KEY, ctx.taskId);
    const prepared = await this.preparer.prepare(task, pool);
    const proc = await this.launcher.launch(prepared, task);
    const emit = this.makeEmit(ctx);
    const terminal = await this.parser.consume(proc, emit, ctx.signal);
    const handle = this.makeHandle(ctx, terminal);
    const outcome = this.makeOutcome(handle, terminal);
    return { handle, outcome };
  }

  /**
   * interact 面（BC-7 行为直通）：chatMode message/close/cancel 经现有
   * subagent-service 的 deliverToRunning/closeChatIdle 链；进程已死的 handle →
   * engine_session_not_resumable（A13，指向 cold resume）。
   */
  async interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult> {
    void handle;
    void action;
    throw new Error("skeleton: pi interact passthrough (chatMode idle reuse)");
  }

  /** read 三级降级链：①reader.readNative → ②journal 重放 → ③宿主 outcome-only 编排。 */
  async read(handle: EngineHandle): Promise<SessionView> {
    const native = await this.reader.readNative(handle.data);
    if (native) return native;
    const viaJournal = await readViaJournal(handle.data);
    if (viaJournal) return viaJournal;
    throw new Error("skeleton: level-3 outcome-only orchestration (read-chain.makeOutcomeOnlyView)");
  }

  // ── 内部 ──

  private makeEmit(ctx: RunContext): (ev: import("../../types.ts").AgentEvent) => void {
    // host 落盘链路：ctx.onEvent 与 journal writer.append 同点消费（事件先发先落盘）。
    return (ev) => {
      ctx.onEvent?.(ev);
    };
  }

  private makeHandle(ctx: RunContext, terminal: { sessionRef?: Record<string, string> }): EngineHandleData {
    // 透传级：spawn 成功即构造（失败终态也返回 handle 供 journal 定位——run 错误语义②）。
    return {
      v: 1,
      engineId: this.id,
      sessionRef: terminal.sessionRef ?? {},
      poolKey: PI_POOL_KEY,
      journalPath: `${this.deps.poolManager.poolDir(this.id, PI_POOL_KEY)}/journal-${ctx.taskId}.jsonl`,
      adapterVersion: "pi-adapter-0",
    };
  }

  private makeOutcome(handle: EngineHandleData, terminal: { exitCode: number | null; stdoutTail: string }): AgentOutcome {
    void handle;
    void terminal;
    // 终态组装（collectResult 语义回填 + engineId/exitCode 新增字段）——叶子逻辑。
    throw new Error("skeleton: pi outcome assembly (collectResult backfill)");
  }
}

/** factory（registry 登记物）。 */
export function createPiEngine(deps: EngineDeps): EnginePort {
  return new PiEngine(deps, new PiLauncher({ sessionDir: "" /* 实现期：getSubagentSessionDir(agentDir, rootCwd) */ }));
}
