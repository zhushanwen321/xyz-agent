// execution/engine/read-chain.ts
//
// EnginePort.read 的三级降级链编排（D6；extension 侧——session_read 工具 / GUI 详情页通道）。
// ①引擎原生 reader（engine.readNative，失败返回 undefined 不 throw）
// ②宿主 journal 重放（degradation/journal.ts readViaJournal——重放与 live 共用同一 reducer）
// ③outcome-only 摘要卡（record 内 outcome 投影合成，永不弹错）。
// 三级都不 throw；SessionView.source 标记实际命中级（GUI 降级显示数据源）。
//
// runtime 侧同构链在 packages/runtime/src/services/session/subagent-read-chain.ts
// （reader 双端复用的另一端；runtime 不 import 本文件与 EnginePort 实例——AC-2）。

import type { EnginePort } from "./port.ts";
import type { OutcomeOnlySource, SessionView } from "./types.ts";

/**
 * 降级链编排入口（extension 侧）。
 * 接线：真调 engine.read()（①级在 engine 实现内部）→ 失败降级 outcomeOnly 兜底。
 * ②级由各 engine 的 read() 实现内部消费 readViaJournal（handle.journalPath 自描述）。
 */
export async function readSessionView(engine: EnginePort, handleData: import("./types.ts").EngineHandleData, outcome: OutcomeOnlySource): Promise<SessionView> {
  const nativeOrJournal = await engine.read({ data: handleData, engine });
  if (nativeOrJournal.source !== "outcome-only") {
    return nativeOrJournal;
  }
  return makeOutcomeOnlyView(outcome);
}

/** 第③级：outcome-only 摘要合成（只有 prompt/result/usage；不白屏不报错弹窗——A8）。 */
export function makeOutcomeOnlyView(source: OutcomeOnlySource): SessionView {
  void source;
  // 单 turn 摘要卡：prompt → 无（ReplayedTurn 无 user 侧），content → text，closed 恒 true。
  // 叶子逻辑（投影细节）；source 字面量恒 "outcome-only"。
  throw new Error("skeleton: outcome-only summary view");
}
