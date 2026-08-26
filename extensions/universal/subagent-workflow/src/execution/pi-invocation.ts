// src/execution/pi-invocation.ts
//
// 定位 pi 二进制并组装 spawn 调用。Core 叶子原语（仅依赖 node 内置）。
//
// spawn 改造（in-process → spawn pi --mode json）的基座模块。
// 被 runSpawn（session-runner）调用，决定子进程用哪个命令启动。
//
// 移植自 nicobailon subagent example 的 getPiInvocation，处理三种运行时：
//   1. bun bundle（/$bunfs/root/ 虚拟脚本）→ 退化到 pi-in-PATH
//   2. 有真实脚本路径（node + script）→ node <script> <args>
//   3. node/bun generic runtime（无脚本）→ pi <args>（依赖 PATH）
//
// 注意：pi 在扩展进程内运行时 process.execPath 是 node/bun，process.argv[1]
// 是 pi 的入口脚本。子进程需要复现同样的启动方式才能保证扩展/配置一致加载。

import * as fs from "node:fs";
import * as path from "node:path";

import { isRelayActive, RELAY_ENV_NODE, RELAY_ENV_SCRIPT } from "./relay-env.ts";

/** spawn 调用描述符：command + args（透传给 child_process.spawn）。 */
export interface PiInvocation {
  /** 可执行文件路径（node/bun/pi 二进制）。 */
  command: string;
  /** 命令行参数（可能含 [scriptPath, ...userArgs] 或直接 [...userArgs]）。 */
  args: string[];
}

/** getPiInvocation 可选项。 */
export interface PiInvocationOptions {
  /**
   * false = 强制直连 spawn 真实 pi（不经 relay 代理）。唯一现役消费点是 PiEngine.probe
   * ——探针意图是 pi 本体可解析性，经 relay 探到的是 runtime 健康，语义错位（E 方案 §5.1）。
   * 缺省（undefined / true）时按 relay env 激活判定走代理。
   */
  relay?: boolean;
}

/**
 * bun 虚拟文件系统前缀。bun bundle 模式下 process.argv[1] 形如
 * /$bunfs/root/pi——这不是磁盘上的真实文件，不能直接 spawn。
 */
const BUN_VIRTUAL_PREFIX = "/$bunfs/root/";

/**
 * 判断 execPath 的 basename 是否为通用运行时（node/bun）。
 * 通用运行时需要脚本路径才能启动 pi；非通用（如 pi 的 standalone binary）可直接执行。
 */
function isGenericRuntime(execPath: string): boolean {
  const execName = path.basename(execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName);
}

/**
 * 组装 pi 子进程的 spawn 调用。
 *
 * @param userArgs pi CLI 参数（如 ["--mode", "rpc", "--session-dir", "..."]）
 * @param opts 可选项（relay:false 强制直连——probe 用，见 PiInvocationOptions）
 * @returns spawn 描述符（command + 完整 args）
 *
 * 决策链（按优先级）：
 *   0. relay 激活（三 env 齐备且未显式禁用）→ <RELAY_NODE> <RELAY_SCRIPT> <userArgs>
 *      （E 方案 §5.1：xyz-agent runtime 存在时经代理 spawn，改的是进程拓扑不是 pi 语义）
 *   1. process.argv[1] 是真实磁盘文件且非 bun 虚拟路径 → <execPath> <argv[1]> <userArgs>
 *      （复现当前 pi 进程的启动方式，确保扩展/配置/版本一致）
 *   2. execPath 非通用运行时（pi standalone binary）→ <execPath> <userArgs>
 *   3. 通用运行时但无可用脚本路径 → "pi" <userArgs>（依赖 PATH 中可找到 pi）
 */
// [perf] 决策链只依赖 process.argv[1] / process.execPath（进程内恒定），其中唯一的
// 磁盘探测（existsSync）结果 memo 一次——每次 spawn 免重复 syscall。memo 键含
// argv[1] 值：测试 mock 切换 argv[1] 模拟不同运行时时自动失效重算。
let scriptExistsCache: { script: string | undefined; exists: boolean } | undefined;

/** process.argv[1] 是真实磁盘脚本（非 bun 虚拟路径）且存在。 */
function currentScriptExists(): boolean {
  const currentScript = process.argv[1];
  if (scriptExistsCache === undefined || scriptExistsCache.script !== currentScript) {
    scriptExistsCache = {
      script: currentScript,
      exists:
        currentScript !== undefined &&
        !currentScript.startsWith(BUN_VIRTUAL_PREFIX) &&
        fs.existsSync(currentScript),
    };
  }
  return scriptExistsCache.exists;
}

export function getPiInvocation(userArgs: string[], opts?: PiInvocationOptions): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith(BUN_VIRTUAL_PREFIX);

  // 分支 0（前置）：relay 激活（E 方案 §5.1）——runtime 注入三 env 齐备且未显式禁用时，
  // spawn 目标切换为 <RELAY_NODE> <RELAY_SCRIPT> <原 pi spawnArgs>，形态与分支 1「node +
  // script」同构（command 是执行器、args[0] 是脚本）。ELECTRON_RUN_AS_NODE 不在此补：
  // 打包态执行器为 Electron 时由 runtime 与三 env 同点注入主 pi 进程 env（E-2
  // getRelaySpawnEnv），本进程 {...process.env} 继承即达代理进程，extension 不重复判定。
  // isRelayActive 已保证三 env 非空，下方取局部变量仅为 TS 收窄（isRelayActive 的
  // 收窄不跨函数边界传导）。
  if (opts?.relay !== false && isRelayActive(process.env)) {
    const relayNode = process.env[RELAY_ENV_NODE];
    const relayScript = process.env[RELAY_ENV_SCRIPT];
    if (relayNode !== undefined && relayScript !== undefined) {
      return { command: relayNode, args: [relayScript, ...userArgs] };
    }
  }

  // 分支 1：有真实脚本路径 → 复现启动方式（node <pi-script> <args>）
  if (currentScript && !isBunVirtualScript && currentScriptExists()) {
    return { command: process.execPath, args: [currentScript, ...userArgs] };
  }

  // 分支 2：非通用运行时（pi 自带 binary）→ 直接执行
  if (!isGenericRuntime(process.execPath)) {
    return { command: process.execPath, args: userArgs };
  }

  // 分支 3：通用运行时但脚本不可用 → 依赖 PATH
  return { command: "pi", args: userArgs };
}
