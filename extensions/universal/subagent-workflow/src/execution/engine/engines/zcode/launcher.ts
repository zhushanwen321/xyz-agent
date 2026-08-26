// src/execution/engine/engines/zcode/launcher.ts
//
// ZcodeEngine launcher（P3）：spawn 命令组装 + 进程启动——四件套里唯一持有 spawn 权
// 的模块（设计 §3.3.7）。TS 重写自 zsub driver.js 的 runHeadless 命令组装段，机制
// 保留（真机验证过）：
//   - argv 形态：`node <zcode.cjs> --json --cwd <dir> --mode yolo [--disallowed-tools a,b]
//     [--resume <sid>] --prompt <text>`；flag 拒收清单（--model/--skill/--max-turns 等
//     help 漂移项）一个不用；
//   - stdin: 'ignore'（CLI 不读 stdin，置管道会挂起——zsub 实测）；
//   - env：HOME=隔离池目录（provider 配置与 db 全部落池内）+ 嵌套防护标记；
//   - 杀链：SIGTERM → grace → SIGKILL，exited 用 close 事件维护的标志判断
//     （child.killed 在 kill() 调用后恒 true，zsub 修过的原版死代码 bug）。
//
// 与 zsub 的差异：超时不在本模块（宿主公共杀链职责，设计 D4/附录 A「CLI 超时 6/6
// 全缺全补」）；abort 由 AbortSignal 驱动（EnginePort 契约），zsub 的 cancel() 变为
// abort(graceMs)。

import { spawn } from "node:child_process";
import { Readable } from "node:stream";

import { killChain } from "../../common/kill-chain.ts";
import { buildNestedSpawnEnv } from "../../common/nesting-guard.ts";
import { assertArgvBudget } from "../../common/persona-router.ts";
import { ZCODE_KILL_GRACE_MS } from "./constants.ts";

// ============================================================
// argv 组装与字节预算（对齐点②收口：估算/断言单一权威 = common/persona-router，
// 本模块只组装；引擎侧在 launch 前调 assertArgvBudget）
// ============================================================

export interface ZcodeSpawnSpec {
  /** 任务运行目录（--cwd flag 的值）。 */
  cwd: string;
  /** 完整 prompt（persona 拼接后的产物）。 */
  prompt: string;
  /** 工具 denylist（逗号连接进 --disallowed-tools；空数组不加 flag）。 */
  denyTools?: string[];
  /** 冷续聊目标 session（--resume；spawn 单轮模式内不做 resume 仿真，留给宿主）。 */
  resumeSessionId?: string;
}

/** 组装 zcode.cjs 的 argv（不含 `node` 与 cli 路径两个前导元素）。 */
export function buildZcodeArgv(spec: ZcodeSpawnSpec): string[] {
  const args = ["--json", "--cwd", spec.cwd, "--mode", "yolo"];
  // denylist 硬约束：非空数组才落 flag（CLI 对空值行为未定义，不赌——zsub 同判）
  const disallowed = (spec.denyTools ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
  if (disallowed.length > 0) args.push("--disallowed-tools", disallowed.join(","));
  if (spec.resumeSessionId) args.push("--resume", String(spec.resumeSessionId));
  args.push("--prompt", String(spec.prompt));
  return args;
}

/**
 * argv 预算断言（launch 前调用；对齐点②：公共 persona-router 的单一权威实现，
 * DEFAULT_ARGV_BUDGET_BYTES 128KB 阈值同源——超限抛 EngineError(prompt_too_large)，
 * 进程创建前拦截，禁止 spawn 后撞 E2BIG）。
 */
export function assertZcodeArgvBudget(nodeBin: string, cliPath: string, args: string[]): void {
  assertArgvBudget([nodeBin, cliPath, ...args]);
}

// ============================================================
// env 构造
// ============================================================

/**
 * 构造子进程 env：嵌套防护经公共 nesting-guard（D8：注入统一 XYZ_AGENT_SUBAGENT=1 +
 * 剥离引擎原生嵌套标记 ZSW_NESTED/PI_SUBAGENT_*——旧标记继承会让孙代理误判嵌套层），
 * HOME 最后落（隔离 HOME 是 provider 配置与 db 的定位锚，基 env 同名键不许覆盖）。
 */
export function buildZcodeEnv(homeDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...buildNestedSpawnEnv(baseEnv), HOME: homeDir };
}

// ============================================================
// 进程启动（EngineProcess 形态，设计 §3.3.7）
// ============================================================

/** launcher 产出的进程句柄（parser 消费 stdout/stderr/exited；abort 是杀链执行体）。 */
export interface ZcodeLaunchedProcess {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** 杀链：SIGTERM → graceMs 后未退出则 SIGKILL；resolve 于进程退出。幂等。 */
  readonly abort: (graceMs?: number) => Promise<void>;
  /** 进程退出（code=null 表示被信号杀死）。 */
  readonly exited: Promise<{ code: number | null; signal: string | undefined }>;
  /** 本方杀链是否介入过（合成终态的判据：介入后 code 语义不再是引擎自身失败）。 */
  readonly killedByUs: () => boolean;
}

export interface ZcodeLaunchOptions {
  /** zcode CLI 路径（node 脚本）。 */
  cliPath: string;
  /** cliPath 之后的 argv（buildZcodeArgv 产物）。 */
  args: string[];
  /** 完整 env（buildZcodeEnv 产物）。 */
  env: NodeJS.ProcessEnv;
  /** node 二进制（缺省 'node'，走 PATH）。 */
  nodeBin?: string;
}

/**
 * 启动 zcode 子进程。spawn 同步失败（如 node 不存在）直接 throw——调用方（引擎 run）
 * 按进程创建前错误处理；启动成功后的一切失败归 parser 终态路径（不 throw）。
 *
 * 杀链（对齐点②收口）：SIGTERM → grace → SIGKILL 的实现单一权威 =
 * common/kill-chain.killChain（ChildProcess 结构满足 KillableChild）——本模块只保留
 * killedByUs 标志（合成终态判据：「我方介入过」与「引擎自身失败」的区分）与幂等守卫。
 */
export function launchZcodeProcess(opts: ZcodeLaunchOptions): ZcodeLaunchedProcess {
  const nodeBin = opts.nodeBin ?? "node";
  const child = spawn(nodeBin, [opts.cliPath, ...opts.args], {
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exited = false;
  let killTriggered = false;

  // ENOENT（node 缺失）等 spawn 失败经 'error' 事件异步到达且 stdout/stderr 可能为
  // null——空流兜底，保证消费方（parser）始终拿到可读流
  const emptyStream = (): Readable => Readable.from([]);
  const stdoutStream = child.stdout ?? emptyStream();
  const stderrStream = child.stderr ?? emptyStream();

  const exitedPromise = new Promise<{ code: number | null; signal: string | undefined }>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal: signal ?? undefined });
    });
    child.once("error", () => {
      // spawn 失败（ENOENT 等）也会走 error；close 不一定触发，这里兜底 resolve 防
      // exited 永挂——code 取 null（无引擎语义可判）
      exited = true;
      resolve({ code: null, signal: undefined });
    });
  });

  const abort = (graceMs: number = ZCODE_KILL_GRACE_MS): Promise<void> => {
    if (!killTriggered && !exited) {
      killTriggered = true;
      // 公共杀链（不 await：abort 以 exitedPromise 为准；killChain 自身含 grace/
      // SIGKILL/收尸全时序，fire-and-forget 不改变 abort 的 resolve 语义）
      void killChain(child, { graceMs });
    }
    return exitedPromise.then(() => undefined);
  };

  return {
    pid: child.pid ?? -1,
    stdout: stdoutStream,
    stderr: stderrStream,
    abort,
    exited: exitedPromise,
    killedByUs: () => killTriggered,
  };
}
