// execution/engine/engines/zcode/index.ts
//
// ZcodeEngine——新增引擎（P3，spawn 单轮模式；D10：MVP 引擎集 = { pi, zcode }）。
// 能力缺陷按 D11 四级处置：schema 自动仿真（公共层）/ 粗粒度事件显示降级 /
// conversation+steer 调用前拒绝（engine_capability_unsupported，A11）/ 探针入口拦截。

import { abortWithChain } from "../../degradation/kill-chain.ts";
import { readViaJournal } from "../../degradation/journal.ts";
import { computePoolKey } from "../../degradation/pool-manager.ts";
import type { EngineDeps, EngineHandle, EnginePort } from "../../port.ts";
import type {
  AgentOutcome,
  AgentTaskSpec,
  EngineCapabilities,
  EngineRunResult,
  InteractAction,
  InteractResult,
  ProbeReport,
  RunContext,
  SessionView,
} from "../../types.ts";
import { ZcodeLauncher } from "./launcher.ts";
import { ZcodeParser } from "./parser.ts";
import { ZcodePreparer } from "./preparer.ts";
import { ZcodeReader } from "./reader.ts";

/** zcode 首期能力声明（D3 十维；链路接通口径）。 */
export const ZCODE_CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "emulated",  // 无原生 schema 通道——公共层仿真（D4 emulated 侧样板）
  steer: "unsupported",           // 无运行中插话（调用前拒绝）
  conversation: "unsupported",    // 无 idle 复用（--resume 冷路径留作后续演进）
  personaInjection: "prompt",     // prompt 拼接是唯一通道
  eventGranularity: "coarse",     // 单 JSON 终态——GUI 阶段态卡片降级
  sandbox: "emulated",            // worktree 隔离（文件写维度）
  sessionRead: "partial",         // sqlite 逆向（周期性失效 → ②级兜底常态可达）
  resume: "cold",                 // --resume 冷续接
  interrupt: "kill-only",         // 无原生中断——公共杀链兜底（D1 abort 分级②直达）
  permissionMode: "native",       // --mode 映射（yolo 等）
};

export class ZcodeEngine implements EnginePort {
  readonly id = "zcode";
  private readonly preparer = new ZcodePreparer(ZCODE_CAPABILITIES);
  private readonly parser = new ZcodeParser();
  private readonly reader = new ZcodeReader();

  constructor(private readonly deps: EngineDeps, private readonly launcher: ZcodeLauncher) {}

  capabilities(): EngineCapabilities {
    return ZCODE_CAPABILITIES;
  }

  /** D7 探针：zcode 二进制存在 + --version 解析 + 已知样本回归（golden 库复用——一处采集两处消费）。 */
  async probe(_opts?: { force?: boolean }): Promise<ProbeReport> {
    throw new Error("skeleton: zcode probe (binary/--version/golden known-sample regression)");
  }

  /**
   * 主语义（§3.3.4 全链路）：prepare（隔离 HOME + config 原子写 + argv 估算前置）
   * → launch（argv 投递 spawn）→ parser（有界收集 → 单 JSON → coarse 事件）→ 终态。
   * abort：kill-only——signal abort 直走公共杀链（abortWithChain 无 tryNative）。
   */
  async run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult> {
    const poolKey = computePoolKey(task.agent);
    const pool = await this.deps.poolManager.acquire(this.id, poolKey, ctx.taskId);
    const prepared = await this.preparer.prepare(task, pool);
    const proc = await this.launcher.launch(prepared, task);
    const emit = (ev: import("../../types.ts").AgentEvent) => ctx.onEvent?.(ev);
    let terminal: import("../../types.ts").ParserTerminal;
    if (ctx.signal?.aborted) {
      // 接线：kill-only 引擎 abort 直走公共杀链（zcode 无原生中断，A10）。
      const kill = await abortWithChain({ proc, graceMs: 5000 });
      terminal = { exitCode: kill.exitCode, signal: kill.signal, stdoutTail: "" };
    } else {
      terminal = await this.parser.consume(proc, emit, ctx.signal);
    }
    const handle = this.makeHandle(ctx, poolKey, terminal);
    const outcome = await this.makeOutcome(handle, terminal);
    return { handle, outcome };
  }

  /**
   * interact 面：unsupported——据 capabilities 同步拒绝（engine_capability_unsupported，
   * 含可操作文案：换单次调用 / engine: pi），不创建进程（A11）。
   */
  async interact(_handle: EngineHandle, _action: InteractAction): Promise<InteractResult> {
    return {
      ok: false,
      code: "engine_capability_unsupported",
      message: "zcode 不支持 conversation/steer——请换单次调用，或对需要续聊的任务使用 engine: pi",
    };
  }

  /** read 三级降级链：①sqlite reader → ②journal → ③outcome-only（编排同 PiEngine）。 */
  async read(handle: EngineHandle): Promise<SessionView> {
    const native = await this.reader.readNative(handle.data);
    if (native) return native;
    const viaJournal = await readViaJournal(handle.data);
    if (viaJournal) return viaJournal;
    throw new Error("skeleton: level-3 outcome-only orchestration");
  }

  // ── 内部 ──

  private makeHandle(ctx: RunContext, poolKey: string, terminal: { sessionRef?: Record<string, string> }): import("../../types.ts").EngineHandleData {
    return {
      v: 1,
      engineId: this.id,
      sessionRef: terminal.sessionRef ?? {},
      poolKey,
      journalPath: `${this.deps.poolManager.poolDir(this.id, poolKey)}/journal-${ctx.taskId}.jsonl`,
      adapterVersion: "zcode-adapter-0",
    };
  }

  private async makeOutcome(handle: import("../../types.ts").EngineHandleData, terminal: import("../../types.ts").ParserTerminal): Promise<AgentOutcome> {
    void handle;
    void terminal;
    // 终态组装 + schema 仿真消费（emulated：emulateStructuredOutput 接线点在此——A2/A3）。
    throw new Error("skeleton: zcode outcome assembly (with schema emulation)");
  }
}

/** factory（registry 登记物；zcodeEntry 实现期从引擎安装路径动态解析）。 */
export function createZcodeEngine(deps: EngineDeps): EnginePort {
  return new ZcodeEngine(deps, new ZcodeLauncher("skeleton-zcode-entry"));
}
