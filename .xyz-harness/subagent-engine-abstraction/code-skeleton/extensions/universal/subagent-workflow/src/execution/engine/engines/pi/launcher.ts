// execution/engine/engines/pi/launcher.ts
//
// PiEngine launcher——spawn 命令组装 + 进程启动（唯一持 spawn 权的模块，§3.3.7）。
// 回填锚点（P1）：argv 组装复用现有 buildSpawnArgs（同一函数保证 --mode rpc 协议
// 零漂移）；pi 可执行入口解析复用 getPiInvocation（bun 虚拟路径守卫）。实现期
// （P1 wave）buildSpawnArgs/getPiInvocation/applySchemaEnvToChildEnv 随回填移入本包。

import { spawn, type ChildProcess } from "node:child_process";

import { buildSpawnArgs } from "@real/execution/session-runner.ts";
import { getPiInvocation } from "@real/execution/pi-invocation.ts";

import type {
  AgentTaskSpec,
  EngineLauncher,
  EngineProcess,
  PreparedExecution,
} from "../../types.ts";

/** spawn 守卫参数（与现有 runSpawn 的 watchdog/timeout 语义对齐——由编排层注入）。 */
export interface PiLaunchOpts {
  sessionDir: string;
  resumeSessionFile?: string;
  forkSource?: string;
}

export class PiLauncher implements EngineLauncher {
  constructor(private readonly opts: PiLaunchOpts) {}

  /** 组装 argv + spawn pi 子进程（rpc 模式：stdin JSONL 协议，stdout 事件流）。 */
  async launch(prepared: PreparedExecution, task: AgentTaskSpec): Promise<EngineProcess> {
    const argv = this.buildArgv(task);
    const invocation = getPiInvocation(argv);
    // 真引 node:child_process spawn（adapter 真引 SDK）：stdio pipe 三通道 + env 隔离。
    const child = spawn(invocation.command, invocation.args, {
      cwd: prepared.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: prepared.env,
    });
    return wrapChildProcess(child);
  }

  private buildArgv(task: AgentTaskSpec): string[] {
    // 回填锚点：真调现有 buildSpawnArgs（--mode rpc / --session-dir / --model /
    // --append-system-prompt / --fork / --skill——与现有 spawn 链零漂移）。
    return buildSpawnArgs({
      model: task.model,
      thinkingLevel: task.effort, // pi 专属映射：中立 effort → pi thinkingLevel 后缀
      agentTools: task.denyTools ? [] : undefined,
      appendSystemPromptPath: undefined, // persona 文件路径由 preparer 产出（P1 接线）
      sessionDir: this.opts.sessionDir,
      sessionFile: this.opts.resumeSessionFile,
      forkSource: this.opts.forkSource,
      skillPaths: task.persona?.skillPath ? [task.persona.skillPath] : undefined,
    });
  }
}

/** ChildProcess → EngineProcess 适配（abort = 杀链执行体：SIGTERM → grace → SIGKILL）。 */
export function wrapChildProcess(child: ChildProcess): EngineProcess {
  if (!child.stdout || !child.stderr) {
    throw new Error("engine child process requires piped stdout/stderr");
  }
  const abort = async (graceMs: number): Promise<void> => {
    // 杀链实现（SIGTERM → setTimeout(graceMs) → SIGKILL）；时序细节属实现域。
    void graceMs;
    child.kill("SIGTERM");
    throw new Error("skeleton: SIGTERM→grace→SIGKILL chain");
  };
  const exited = new Promise<{ code: number | null; signal?: string }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal: signal ?? undefined }));
  });
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin,               // ChildProcess.stdin 已是 Writable | null（argv-only 引擎为 null）
    stdout: child.stdout,             // 上方非空守卫已收窄
    stderr: child.stderr,
    abort,
    exited,
  };
}
