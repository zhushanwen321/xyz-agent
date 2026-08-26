// packages/runtime/src/services/session/subagent-read-chain.ts
//
// runtime 侧 subagent session 三段读取编排（issues #6；P5 改造）。
// 与 extension 侧 engine/read-chain.ts 同构但独立——runtime 不 import EnginePort 实例
// 与 adapter 运行时件（AC-2 依赖方向），例外通道只有：共享 reader 模块（engines/<id>/reader.ts
// 无状态纯函数）+ 中立制品（record + journal）。
//
// 三段：①record.engine 字段路由到该引擎共享 reader（①级原生读取）
//      ②journal 重放（handle.journalPath 自描述绝对路径 + runtime 前缀白名单校验，
//        路径从 getDataDir() 动态推导不写死——AC-5）
//      ③record outcome 投影（摘要卡兜底）。
// 存量 record 无 engine 字段一律按 pi 投影（零迁移，BC-6）；pi 既有直读 JSONL 行为不变（BC-5）。

// 骨架期路径说明：engine/ 目录尚未合入真实源码（P1-P3 交付物），此处回指同仓骨架内的
// 骨架 engine 模块；实现期（P5）改经 workspace 依赖引入（@zhushanwen/pi-subagent-workflow
// 的 engine/engines/<id>/reader.ts 入口 + tsup noExternal 登记，validate-runtime-bundle.sh 验证双 bundle）。

import { PiReader } from "../../../../../extensions/universal/subagent-workflow/src/execution/engine/engines/pi/reader.ts";
import { ZcodeReader } from "../../../../../extensions/universal/subagent-workflow/src/execution/engine/engines/zcode/reader.ts";
import type { EngineHandleData, EngineReader, SessionView } from "../../../../../extensions/universal/subagent-workflow/src/execution/engine/types.ts";

/** runtime 侧 reader 路由表（新引擎接入在此登记一行——reader 是唯一例外通道）。 */
const READERS: Record<string, () => EngineReader> = {
  pi: () => new PiReader(),
  zcode: () => new ZcodeReader(),
};

/** record 内嵌 engine 字段的形状（SubagentRecordEntryData v2 增补 engine?: { id; handle }）。 */
export interface RecordEngineField {
  id: string;
  handle: EngineHandleData;
}

/** record outcome 投影的输入（③级数据源——runtime 侧从 record entry 取）。 */
export interface RecordOutcomeProjection {
  engineId: string;
  content: string;
  error?: string;
}

/**
 * journal 路径前缀白名单校验（防路径注入：handle 自描述路径必须落在 <dataDir>/engines/ 下；
* dataDir 运行时注入动态推导——不写死绝对路径，AC-5）。
 */
export function isJournalPathAllowed(journalPath: string, dataDir: string): boolean {
  const enginesRoot = `${dataDir}/engines/`;
  return journalPath.startsWith(enginesRoot) && !journalPath.includes("..");
}

/**
 * 三段编排入口（GUI 派生列表 / subagent 详情页历史链路消费）。
 * ①reader（engine 字段路由；无 engine 字段 = 存量 record 按 pi 投影，BC-6）
 * ②journal（白名单校验后重放；实现期待实证：重放与 live reducer 共用，C5）
 * ③outcome 摘要卡兜底（三级都不 throw / 不白屏——A8）。
 */
export async function resolveSubagentSessionView(
  engineField: RecordEngineField | undefined,
  outcome: RecordOutcomeProjection,
  dataDir: string,
): Promise<SessionView> {
  const reader = resolveReader(engineField?.handle ?? piProjectedHandle(engineField));
  const native = await reader.readNative((engineField?.handle ?? piProjectedHandle(engineField)));
  if (native) return native;
  return readJournalOrOutcome(engineField, outcome, dataDir);
}

function resolveReader(handle: EngineHandleData): EngineReader {
  // 接线：engine 字段路由（无 engine 字段 → pi 投影——零迁移存量兼容）。
  const factory = READERS[handle.engineId] ?? READERS["pi"];
  return factory();
}

async function readJournalOrOutcome(
  engineField: RecordEngineField | undefined,
  outcome: RecordOutcomeProjection,
  dataDir: string,
): Promise<SessionView> {
  // ②journal（isJournalPathAllowed 守卫 + 重放）→ ③outcome 摘要卡。
  // 接线边界：journal 重放复用 extension 侧 degradation/journal（中立格式同一解析器，
  // 不引入第二套 runtime 版 JSONL 解析——实现期经 workspace 依赖引入）。
  void engineField;
  void outcome;
  void dataDir;
  throw new Error("skeleton: runtime journal replay + outcome-only fallback");
}

function piProjectedHandle(engineField: RecordEngineField | undefined): EngineHandleData {
  // 存量 v1 record（无 engine 字段）按 pi 投影 + sessionFile 定位（BC-6 零迁移）。
  void engineField;
  throw new Error("skeleton: legacy record pi projection (sessionFile-based)");
}
