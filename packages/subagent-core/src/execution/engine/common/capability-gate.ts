// src/execution/engine/common/capability-gate.ts
//
// [D3-④ 预检 capabilities 化] 调用前预检的唯一实现（capabilities 驱动，无引擎 id
// 特判）。设计权威源：docs/design/subagent-dual-track-convergence.md §3.3 D3-④ + r3 裁定
// （EngineCapabilities 新增 maxTurns 能力位，不保留硬编码 shape 检查）+ §3.4 错误规格
// 第 1 行（engine_capability_unsupported，既有错误族）。
//
// 判据形态：每个引擎拦截「自己 capabilities 声明不支持的能力」——
//   - conversation → capabilities.conversation === 'unsupported'
//   - fork/forkFromSessionFile → session 分叉通道族全缺（steer 与 conversation 均
//     'unsupported'，见下方 fork 判据说明）
//   - maxTurns → capabilities.maxTurns === false（r3 扩位）
//   - worktree（boolean true 或 WorktreeHandle）→ capabilities.sandbox === 'none'
//
// 调用点仍是两处（单点的是实现，不是调用点）：
//   - chat 域：executeViaEngine 同步段、record 创建前（engine.capabilities() 同步可得，
//     承接「全部同步拒绝发生在 record 创建前、不产生孤儿 record」不变量）；
//   - workflow 域：SAR.run 路由后、engine.run 前（同模块调用）。
//
// 行为变化声明（§3.4）：唯一有意行为变化 = workflow 域 zcode+worktree 由漏拦变拦截
// （修复双轨清单 #7 的跨域缺口）；pi 的 maxTurns/fork/conversation/worktree 等既有
// 合法能力零拦截（V4⑤ 反向守护——pi 声明 conversation='native'、sandbox='emulated'、
// maxTurns=true，全数放行）。

import { EngineError } from "./errors.ts";
import type { EngineCapabilities } from "../types.ts";

/**
 * 预检输入的任务形状子集——ExecuteOptions（chat 域）与 AgentCallOpts（D6 合流后的
 * 单一任务形状，workflow 域 SAR 直传）共有的能力相关字段面。结构子集而非具体类型：
 * 两域的 opts 类型都能直接传入。
 */
export interface TaskShapeForGate {
  conversation?: boolean;
  fork?: boolean;
  forkFromSessionFile?: string;
  worktree?: boolean | { path: string };
  maxTurns?: number;
}

/**
 * 调用前预检：任务形状中的能力参数对引擎 capabilities 逐一对照，声明不支持即抛
 * EngineError(engine_capability_unsupported)——同步 throw、进程/record 创建前，文案
 * 含 capabilities 依据与恢复指引（换参数/换引擎）。
 *
 * fork 判据说明（借位裁定）：fork 依赖父 session 上下文继承（父会话文件作为分叉源），
 * 引擎具备该语义的能力面信号 = 会话分叉/交互通道族（steer 或 conversation 任一非
 * 'unsupported'）。pi conversation='native'（chatMode idle 复用）→ 放行；zcode 双
 * 'unsupported'（argv-only spawn 单轮，无父 session 分叉通道）→ 拒绝。仅凭 steer 判
 * 会误拦 pi（pi 的 steer 声明 'unsupported'——RPC 有但 spawn 链路未接通，与 fork 的
 * 初始上下文继承是两条轴），故取通道族任一可用即支持的分寸。
 */
export function assertTaskShapeSupported(
  engineId: string,
  caps: EngineCapabilities,
  task: TaskShapeForGate,
): void {
  if (task.conversation === true && caps.conversation === "unsupported") {
    throw new EngineError(
      "engine_capability_unsupported",
      `engine '${engineId}' 不支持 conversation（capabilities.conversation = 'unsupported'，` +
        `spawn 单轮模式无同进程 idle 复用，message/close 交互控制面不可用）`,
      `改用 engine: pi（支持 conversation 续聊），或不传该参数（一次性任务默认形态）`,
    );
  }
  if (task.fork === true || task.forkFromSessionFile !== undefined) {
    if (caps.steer === "unsupported" && caps.conversation === "unsupported") {
      throw new EngineError(
        "engine_capability_unsupported",
        `engine '${engineId}' 不支持 fork${task.forkFromSessionFile !== undefined ? "（fork-from 同为父 session 上下文继承）" : ""}（fork 依赖父 session 上下文继承，` +
          `capabilities.steer = '${caps.steer}' / conversation = '${caps.conversation}'——引擎无父 session 分叉通道）`,
        `把所需父上下文写进 task 正文后不传 fork，或改用 engine: pi`,
      );
    }
  }
  if (task.maxTurns !== undefined && caps.maxTurns === false) {
    throw new EngineError(
      "engine_capability_unsupported",
      `engine '${engineId}' 不支持 maxTurns（capabilities.maxTurns = false，轮数上限依赖 turn_end 事件流，` +
        `本引擎无此语义——静默丢弃会造成「传了上限却失控」的假象）`,
      `去掉 maxTurns 参数重派，或改用 engine: pi（turn limiter 执行轮数上限）`,
    );
  }
  if ((task.worktree === true || typeof task.worktree === "object") && caps.sandbox === "none") {
    throw new EngineError(
      "engine_capability_unsupported",
      `engine '${engineId}' 不支持 worktree 隔离（capabilities.sandbox = 'none'，` +
        `引擎未接文件系统隔离层）`,
      `改用 engine: pi（worktree 隔离可用），或不传该参数（在 parent cwd 执行）`,
    );
  }
}
