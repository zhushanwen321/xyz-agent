// execution/engine/routing.ts
//
// 配置路由三层 + 故障 fallback 三守卫（D9 / issues #4）。
// 三层优先级：调用参数 engine > agent .md frontmatter engine > 全局 settings 默认（缺省 pi）。
// 纯函数模块（无 IO）：probe 由编排层调用，判定结果传入 decideAfterProbeFailure。
//
// fallback 三守卫（任一命中则不 fallback、按 strict 语义直接报 engine_probe_failed）：
//   a) engine 来自调用参数/step 级显式指定（首期与守卫 b 合流——声明载体 = 显式 engine 指定）
//   b) task 声明依赖该引擎独有能力（AgentTaskSpec 下钻 requires 字段后独立生效）
//   c) 显式 model 在默认引擎上不可解析（不静默换模型，报 model_not_available）
// engineRouting.strict 全开则一切 probe 失败直接报错。

import type { EngineErrorShape } from "./types.ts";

/** 三层输入（编排层从工具调用参数 / agentMeta.engine / settings 组装）。 */
export interface EngineRoutingInput {
  /** 守卫 a 载体：调用参数 / workflow step 级显式 engine。 */
  explicitEngine?: string;
  /** agent .md frontmatter engine（per-agent 主通道）。 */
  agentEngine?: string;
  /** 全局 settings 默认引擎（缺省 "pi"——回填期零风险默认，AC-1.4）。 */
  defaultEngine: string;
  /** engineRouting.strict（true = 一切 probe 失败直接报错）。 */
  strict: boolean;
}

/** probe 失败后的路由决策。 */
export type EngineRoutingDecision =
  | { kind: "use"; engineId: string; fallback?: { from: string; reason: string } }
  | { kind: "rejected"; error: EngineErrorShape };

/**
 * 三层优先级解析（纯函数，透传级）。
 * 接线语义：explicitEngine ?? agentEngine ?? defaultEngine——单次调用覆盖 frontmatter（A7）、
 * workflow step 级混编（A6）、三层均未配置缺省 pi（A1 零差异）。
 */
export function resolveEngineId(input: EngineRoutingInput): string {
  if (input.explicitEngine) return input.explicitEngine;
  if (input.agentEngine) return input.agentEngine;
  return input.defaultEngine;
}

/**
 * probe 失败后的守卫判定（D9①）。
 * 守卫命中 / strict 模式 → rejected（engine_probe_failed，错误含恢复指引：
 * 版本确认命令 + 探针重跑命令 + 调研文档路径——A5）；无守卫 → 路由回全局默认
 * 引擎完成 + engineFallback 留痕（record + GUI 警告条数据源，A9①）。
 */
export function decideAfterProbeFailure(
  input: EngineRoutingInput,
  failedEngineId: string,
): EngineRoutingDecision {
  const guardAHit = input.explicitEngine === failedEngineId; // 显式指定 = 能力依赖（守卫 a；b 首期合流于此）
  if (input.strict || guardAHit) {
    // 守卫 c（显式 model 在默认引擎不可解析）由编排层在 prepare 期单独报 model_not_available。
    return {
      kind: "rejected",
      error: {
        code: "engine_probe_failed",
        message: `engine "${failedEngineId}" probe failed`,
        recovery: "恢复指引：①版本确认命令（如 <engine> --version）②探针重跑命令 ③调研文档路径——A5 终态四样例",
      },
    };
  }
  return {
    kind: "use",
    engineId: input.defaultEngine,
    fallback: { from: failedEngineId, reason: "probe_failed" },
  };
}
