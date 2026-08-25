// execution/engine/engines/zcode/parser.ts
//
// ZcodeEngine parser——stdout 有界收集（头 4K + 尾 64K）→ 单 JSON {sessionId,response,usage}
// → 合成 coarse AgentEvent（message_end + turn_end）→ ParserTerminal（批量引擎形态）。
// stdout JSON 字段名以实施期待实证项①实录为准（探针已知样本即来自该实录——golden 防漂移）。
// 事件不变量③ coarse 侧：turn_end 前至少一个 message_end（§3.3.7）。

import type { AgentEvent, EngineParser, EngineProcess, ParserTerminal } from "../../types.ts";

/** 有界收集上限（头 4K + 尾 64K——错误规格 stdout 尾部与 §3.3.7 stdoutTail 同源）。 */
const HEAD_LIMIT = 4096;
const TAIL_LIMIT = 65536;

export class ZcodeParser implements EngineParser {
  /**
   * 批量形态：进程退出后一次性 emit 合成事件（emit 先于 resolve——不变量⑤）。
   * 引擎输出异常（新格式/解析失败）不 reject——resolve 为含错误信息的 terminal
   * 触发 engine_run_failed（A14 运行中兜底；新样本补录 golden 库）。
   */
  async consume(
    proc: EngineProcess,
    emit: (ev: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<ParserTerminal> {
    const stdoutTail = await this.collectBounded(proc);
    const parsed = this.parseSingleJson(stdoutTail);
    if (parsed) {
      this.emitSyntheticEvents(parsed, emit);
    }
    const exited = await proc.exited;
    void signal;
    return {
      exitCode: exited.code,
      signal: exited.signal,
      sessionRef: parsed ? { sessionId: parsed.sessionId, dbPath: parsed.dbPath } : undefined,
      stdoutTail,
    };
  }

  private async collectBounded(proc: EngineProcess): Promise<string> {
    // 头 4K + 尾 64K 收集（防失控输出打爆内存；保尾部供诊断）。
    void proc;
    throw new Error(`skeleton: bounded stdout collection (head=${HEAD_LIMIT}, tail=${TAIL_LIMIT})`);
  }

  private parseSingleJson(raw: string): ZcodeRunOutput | undefined {
    // 单 JSON 解析（失败 → undefined → 终态含错误信息 → engine_run_failed）。
    void raw;
    throw new Error("skeleton: zcode single-JSON parse");
  }

  private emitSyntheticEvents(parsed: ZcodeRunOutput, emit: (ev: AgentEvent) => void): void {
    // 合成事件序（coarse 不变量）：message_end（usage 完整或显式缺省）→ turn_end。
    emit({ type: "message_end", usage: parsed.usage });
    emit({ type: "turn_end" });
  }
}

/** zcode spawn 单轮 stdout JSON 契约（字段名以实录为准——期待实证项①）。 */
export interface ZcodeRunOutput {
  sessionId: string;
  response: string;
  usage?: import("../../types.ts").AgentUsage;
  /** db 相对池目录路径（handle.sessionRef.dbPath 数据源；readNative 定位 sqlite）。 */
  dbPath: string;
}
