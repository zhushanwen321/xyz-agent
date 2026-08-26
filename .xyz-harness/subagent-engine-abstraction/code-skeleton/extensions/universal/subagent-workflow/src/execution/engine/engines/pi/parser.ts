// execution/engine/engines/pi/parser.ts
//
// PiEngine parser——pi rpc stdout 逐行 JSONL → AgentEvent 流 + 终态（流式引擎形态）。
// 回填锚点：逐行翻译复用现有 spawn-event-adapter 的 parseSpawnLine（事件适配逻辑
// 零漂移）；stdin 协议（prompt/steer/abort RpcCommand）复用 stdin-writer sendPromptCommand。
// 对外契约统一「事件先发、终态后返」（§3.3.7）：launcher/parser 之上的 EnginePort.run
// 只有这一种形态——流式(pi)与批量(zcode)差异被 parser 边界吸收。

import { parseSpawnLine } from "@real/execution/spawn-event-adapter.ts";
// 协议复用锚点（实现期真实调用；骨架层不伪造 ChildProcess 形状断言）：
// import { sendPromptCommand } from "@real/execution/stdin-writer.ts";

import type { AgentEvent, AgentTaskSpec, EngineParser, EngineProcess, ParserTerminal } from "../../types.ts";

export class PiParser implements EngineParser {
  /**
   * 驱动 pi rpc 协议：spawn 后写 prompt RpcCommand（stdin）→ 逐行消费 stdout →
   * 事件经 emit 先发 → 进程退出后 resolve 终态。
   * reject 仅限 parser 自身实现错误；pi 输出异常 resolve 为含错误信息的 terminal
   * （触发 engine_run_failed 宿主合成终态，不静默挂死）。
   */
  async consume(
    proc: EngineProcess,
    emit: (ev: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<ParserTerminal> {
    this.driveStdin(proc, signal);
    const terminal = await this.consumeStdout(proc, emit);
    return terminal;
  }

  private driveStdin(proc: EngineProcess, signal?: AbortSignal): void {
    // pi rpc 模式：必须在 spawn 后主动写 prompt RpcCommand，否则子进程阻塞。
    // 实现期复用 stdin-writer sendPromptCommand（child 参数为 ChildProcess 形状，
    // 与 EngineProcess.stdin 的适配由 pi 包内薄壳完成——骨架层不伪造形状断言）。
    // 杀链/abort 的 stdin abort 命令同源（协议模块驱动，不进公共层，§3.3.7）。
    void proc;
    void signal;
    throw new Error("skeleton: pi rpc stdin protocol driver (prompt/get_state/abort via sendPromptCommand)");
  }

  private async consumeStdout(proc: EngineProcess, emit: (ev: AgentEvent) => void): Promise<ParserTerminal> {
    // 逐行解析（真接线 parseSpawnLine——回填锚点）+ 事件 emit 先发 + 终态组装。
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const parsed = parseSpawnLine(line);
        if (parsed) emit(this.translate(parsed));
      }
    });
    const exited = await proc.exited;
    return {
      exitCode: exited.code,
      signal: exited.signal,
      sessionRef: undefined, // session header 分支提取（实现期：deriveSessionFilePath 接线）
      stdoutTail: "",
    };
  }

  private translate(parsed: ReturnType<typeof parseSpawnLine>): AgentEvent {
    // pi 事件 → 中立 AgentEvent 翻译表（回填：spawn-event-adapter 既有映射搬入）。
    void parsed;
    throw new Error("skeleton: pi event translation table");
  }
}
