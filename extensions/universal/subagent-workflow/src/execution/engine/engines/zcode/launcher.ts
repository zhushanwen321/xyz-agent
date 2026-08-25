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

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { buildNestedSpawnEnv } from "../../common/nesting-guard.ts";
import { ZCODE_ARGV_LIMIT_BYTES, ZCODE_KILL_GRACE_MS } from "./constants.ts";

const logger = getLogger("subagents");

// ============================================================
// argv 组装与字节估算
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
 * argv 总字节估算：每元素 byteLength + 1（NUL 分隔符近似），前导 node/cliPath 计入。
 * 为什么在 spawn 前估算：超长 prompt 撞 ARG_MAX/E2BIG 是运行时形态（进程半创建、错误
 * 不可分辨），prepare 期拦截给出可操作建议（设计 §3.3.3 prompt_too_large 行）。
 */
export function estimateArgvBytes(nodeBin: string, cliPath: string, args: string[]): number {
  let total = 0;
  for (const seg of [nodeBin, cliPath, ...args]) total += Buffer.byteLength(String(seg), "utf8") + 1;
  return total;
}

/** prompt_too_large（prepare 期——进程创建前抛出）。 */
export class ZcodeArgvLimitError extends Error {
  readonly code = "prompt_too_large" as const;

  constructor(estBytes: number, limitBytes: number) {
    super(
      `[prompt_too_large] zcode 引擎的 argv 估算 ${estBytes} 字节超限（${limitBytes}）。` +
        `zcode spawn 单轮模式的 prompt 只走 argv（无 stdin 通道）。` +
        `恢复指引：缩短 task 文本，或改用 engine: pi（stdin 投递无此限制）。`,
    );
    this.name = "ZcodeArgvLimitError";
  }
}

/** argv 估算超限断言（launch 前调用；阈值 ZCODE_ARGV_LIMIT_BYTES）。 */
export function assertArgvWithinLimit(nodeBin: string, cliPath: string, args: string[]): void {
  const est = estimateArgvBytes(nodeBin, cliPath, args);
  if (est > ZCODE_ARGV_LIMIT_BYTES) throw new ZcodeArgvLimitError(est, ZCODE_ARGV_LIMIT_BYTES);
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
 */
export function launchZcodeProcess(opts: ZcodeLaunchOptions): ZcodeLaunchedProcess {
  const nodeBin = opts.nodeBin ?? "node";
  const child = spawn(nodeBin, [opts.cliPath, ...opts.args], {
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exited = false;
  let killTriggered = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  // ENOENT（node 缺失）等 spawn 失败经 'error' 事件异步到达且 stdout/stderr 可能为
  // null——空流兜底，保证消费方（parser）始终拿到可读流
  const emptyStream = (): Readable => Readable.from([]);
  const stdoutStream = child.stdout ?? emptyStream();
  const stderrStream = child.stderr ?? emptyStream();

  const exitedPromise = new Promise<{ code: number | null; signal: string | undefined }>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve({ code, signal: signal ?? undefined });
    });
    child.once("error", () => {
      // spawn 失败（ENOENT 等）也会走 error；close 不一定触发，这里兜底 resolve 防
      // exited 永挂——code 取 null（无引擎语义可判）
      exited = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve({ code: null, signal: undefined });
    });
  });

  const killChain = (graceMs: number): void => {
    if (exited || killTriggered) return;
    killTriggered = true;
    try {
      child.kill("SIGTERM");
    } catch (err) {
      // 进程恰在 kill 前自退——幂等兜底，debug 留痕
      logger.debug("[zcode-launcher] SIGTERM on exited process", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    // 宽限后强杀：node CLI 可能在收尾钩子里拖延；用 exited 判断（kill() 后 child.killed 恒 true）
    graceTimer = setTimeout(() => {
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch (err) {
          logger.debug("[zcode-launcher] SIGKILL on exited process", {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, graceMs);
  };

  const abort = (graceMs: number = ZCODE_KILL_GRACE_MS): Promise<void> => {
    killChain(graceMs);
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
