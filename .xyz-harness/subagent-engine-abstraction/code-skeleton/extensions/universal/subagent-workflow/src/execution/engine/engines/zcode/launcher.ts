// execution/engine/engines/zcode/launcher.ts
//
// ZcodeEngine launcher——spawn 单轮模式（argv 投递，stdin=/dev/null，§3.3.4）。
// argv 形态：node <zcode.cjs> --json --cwd <worktree> --mode yolo --disallowed-tools <denylist>
//           --prompt <persona+task+schema 仿真段>（env: HOME=隔离目录, XYZ_AGENT_SUBAGENT=1）。

import { spawn } from "node:child_process";

import type { AgentTaskSpec, EngineLauncher, EngineProcess, PreparedExecution } from "../../types.ts";
import { wrapChildProcess } from "../pi/launcher.ts"; // ChildProcess→EngineProcess 适配件复用（引擎间共享的纯包装，非 pi 专有协议）

export class ZcodeLauncher implements EngineLauncher {
  /** zcode 可执行入口（实现期从引擎安装路径动态解析——ZCode.app bundle 内 zcode.cjs）。 */
  constructor(private readonly zcodeEntry: string) {}

  async launch(prepared: PreparedExecution, task: AgentTaskSpec): Promise<EngineProcess> {
    const argv = this.buildArgv(prepared, task);
    // 真引 node:child_process spawn（adapter 真引 SDK）：stdin=/dev/null（argv-only 引擎）、
    // env 隔离 HOME、cwd=prepared.cwd。
    const child = spawn(process.execPath, argv, {
      cwd: prepared.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"], // zcode 无 stdin 协议——EngineProcess.stdin 恒 null
      env: prepared.env,
    });
    return wrapChildProcess(child);
  }

  /** argv 组装（透传级：flag 段逐个映射；prompt 值含 persona 段 + schema 仿真段——§3.3.4）。 */
  private buildArgv(prepared: PreparedExecution, task: AgentTaskSpec): string[] {
    const argv = [
      this.zcodeEntry,
      "--json",
      "--cwd", prepared.cwd,
      "--mode", this.mapMode(task),
    ];
    if (task.denyTools && task.denyTools.length > 0) {
      argv.push("--disallowed-tools", task.denyTools.join(","));
    }
    argv.push("--prompt", this.buildPromptValue(task));
    return argv;
  }

  private mapMode(task: AgentTaskSpec): string {
    // 权限模式映射（capabilities.permissionMode 声明映射表；默认 yolo——headless 非交互）。
    void task;
    return "yolo";
  }

  private buildPromptValue(task: AgentTaskSpec): string {
    // persona 段 + task + schema 仿真段拼接（仿真段由公共层 augmentPersonaWithSchemaEmulation 产出）。
    void task;
    throw new Error("skeleton: zcode prompt assembly (persona+task+schema emulation segment)");
  }
}
