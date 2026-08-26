// execution/engine/conformance/golden.ts
//
// golden 样本库（D12；conformance/golden/<engineId>/<engineVersion>/ 布局）。
// 每引擎真实流量采集：stdout 原始字节 + 期望 AgentEvent 序列 + manifest。
// 一处采集两处消费：conformance 回放层（parser 回归）+ 探针已知样本回归（D7）。
// 首批样本 = 验收前置门实录（zcode 0.16.3 stdout 字段核对）+ pi 终态样本。

import type { AgentEvent, ParserTerminal } from "../types.ts";

/** manifest.json——采集元数据（探针版本变化检测的比对基准）。 */
export interface GoldenManifest {
  engineId: string;
  engineVersion: string;
  /** 采集日期（ISO）。 */
  capturedAt: string;
  /** 采集命令（复现实录用）。 */
  captureCommand: string;
  /** 样本说明（每个 case 一行）。 */
  notes: Record<string, string>;
}

/** 单个 golden 样本（文件对：<case>.stdout + <case>.expected.json）。 */
export interface GoldenSample {
  caseName: string;
  /** 真实 stdout 原始字节（喂 parser 回放）。 */
  stdout: string;
  /** 期望产出：AgentEvent 序列 + ParserTerminal（含 sessionRef 与 stdoutTail 截断后形态）。 */
  expected: { events: AgentEvent[]; terminal: ParserTerminal };
}

/** golden 样本目录路径（enginesRoot 无关——样本随代码仓归档）。 */
export function goldenDir(rootDir: string, engineId: string, engineVersion: string): string {
  return `${rootDir}/golden/${engineId}/${engineVersion}`;
}

/** 加载一引擎一版本的全部样本（免 LLM、免二进制——CI 默认跑的 golden 回放层数据源）。 */
export async function loadGoldenSamples(rootDir: string, engineId: string, engineVersion: string): Promise<GoldenSample[]> {
  void rootDir;
  void engineId;
  void engineVersion;
  // 逐 case 读 <case>.stdout + <case>.expected.json + manifest 校验版本一致性。
  throw new Error("skeleton: golden sample loading (stdout + expected.json + manifest)");
}
