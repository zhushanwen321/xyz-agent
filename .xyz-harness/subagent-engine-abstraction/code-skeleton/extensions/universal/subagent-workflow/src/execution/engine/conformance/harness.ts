// execution/engine/conformance/harness.ts
//
// conformance 契约套件骨架（D12；C1-C8 用例清单见设计文档 §3.3.8）。
// 两层结构（A12）：golden 回放层（免 LLM、免二进制，进 CI 默认）+ run 层（真实 spawn，
// ENGINE_CONFORMANCE_LIVE=1 手动门不进 CI）。
// 负例守护：CI 内置元测试——故意破坏 zcode parser 一个不变量样本，断言 C3 转红；
// 套件未检出破坏则元测试失败（证明套件有牙）。
//
// 骨架定位：用例注册器与断言函数的类型契约（vitest describe/it 形态留实现期——
// 本文件被 *.conformance.test.ts 消费，测试文件不进 tsc 生产骨架）。

import type { EnginePort } from "../port.ts";
import type { AgentEvent, ParserTerminal } from "../types.ts";
import { loadGoldenSamples, type GoldenSample } from "./golden.ts";

/** 契约用例 ID（§3.3.8 表）。 */
export type ConformanceCaseId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8";

/** 单用例执行结果（套件报告元素；负例元测试断言 failed.caseId 可定位不变量）。 */
export interface ConformanceCaseResult {
  caseId: ConformanceCaseId;
  ok: boolean;
  /** 失败时的具体不变量描述（A8.2：转红并指出失败的不变量）。 */
  failure?: string;
}

export interface ConformanceReport {
  engineId: string;
  results: ConformanceCaseResult[];
  /** 全绿判定（负例元测试据此断言「破坏必转红」）。 */
  allGreen: boolean;
}

/** 单用例形状（实现期各用例以 vitest it() 承载；此处固化断言入口签名）。 */
export interface ConformanceCase {
  caseId: ConformanceCaseId;
  /** run 层标记（true = 需真实引擎 + 有效凭据，仅 ENGINE_CONFORMANCE_LIVE=1 时执行）。 */
  live: boolean;
  run(engine: EnginePort, golden: GoldenSample[]): Promise<ConformanceCaseResult>;
}

/** C3 事件不变量五条的独立断言器（§3.3.7——流式 golden 回放 / coarse 合成样本共用）。 */
export function assertEventInvariants(events: readonly AgentEvent[], outcomeContent: string): { ok: boolean; violated: string[] } {
  // 五条逐一：①终态序唯一 ②usage 完整形状 ③text_delta 拼接===content（流式）/coarse 至少
  // 一个 message_end ④tool_start/tool_end 配对 ⑤emit 先于 resolve（由调用方时序断言）。
  void events;
  void outcomeContent;
  throw new Error("skeleton: C3 five invariants assertion");
}

/** golden 回放断言器：parser 对实录样本回归（events + terminal 逐字段比对）。 */
export function assertParserReplay(sample: GoldenSample, actual: { events: AgentEvent[]; terminal: ParserTerminal }): { ok: boolean; diff?: string } {
  void sample;
  void actual;
  throw new Error("skeleton: golden replay diff assertion");
}

/**
 * 套件编排入口（接线：遍历用例真调 case.run；live 用例按环境门跳过）。
 * 实现期形态：vitest describe(`conformance:${engineId}`) 内逐用例 it()。
 */
export async function runConformanceSuite(
  engine: EnginePort,
  cases: readonly ConformanceCase[],
  goldenRoot: string,
  liveGate: boolean,
): Promise<ConformanceReport> {
  const golden = await loadGoldenSamples(goldenRoot, engine.id, "latest");
  const results: ConformanceCaseResult[] = [];
  for (const c of cases) {
    if (c.live && !liveGate) {
      results.push({ caseId: c.caseId, ok: true, failure: undefined /* skipped: live gate off */ });
      continue;
    }
    results.push(await c.run(engine, golden));
  }
  return { engineId: engine.id, results, allGreen: results.every((r) => r.ok) };
}
