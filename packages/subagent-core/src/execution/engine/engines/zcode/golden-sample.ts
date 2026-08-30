// src/execution/engine/engines/zcode/golden-sample.ts
//
// golden 语料内嵌副本（双通道并存，R3 扩充）：
//
//   ① spawn 单 JSON（D7）：probe「干跑校验」的内嵌 golden 样本——zcode 无官方契约，
//      探针必须做已知样本回归（对 embed 样本跑 parser，格式漂移在入口拦截而非运行中
//      静默挂死）。来源：2026-08-25 验收前置门真机实录（zcode 0.16.5），完整原文与采集
//      元数据见 __tests__/__fixtures__/zcode-golden-spawn.json。为什么不直接读 fixture
//      文件：probe 在生产运行（npm 包安装形态）也要可用，__tests__ 不在稳定交付面内
//      ——内嵌副本以代码为交付载体。spawn 降级路径（设计 D2 保留）持续消费本语料
//      （zcode-engine probe 干跑 + conformance spawn 回归），故 R3 帧序列语料落地为
//      并存新增而非删除替换——漂移防御的主力语料已切换到 ②（登记于 impl-plan 偏差表）。
//
//   ② app-server NDJSON 帧序列（R3，D8-②）：常驻通道的 golden 帧序列语料，四类样本
//      （create 应答 / 推送流 / 终态帧 / read 应答，附录 A.2 任务生命周期帧序）。
//      来源：按 A.2 协议权威 + 旧 zsw 实现真机抓包形态合成（非实录，fixture _meta
//      如实标注）；真机冒烟后替换。双副本 diff 机制沿用 ① 的先例：fixture
//      __tests__/__fixtures__/zcode-golden-appserver.json 是采集 SSOT，此处为运行时
//      副本，更新样本需同步改两处（session-channel 测试 diff 校验；R6 conformance
//      迁移后由 golden 回放层接管）。

/** [①spawn] 实录 stdout 原文（单 JSON：sessionId/traceId/turnId/response/usage/eventCount/projection）。 */
export const ZCODE_GOLDEN_STDOUT = `{
  "sessionId": "sess_35852a0f-1302-4e20-9e48-87f47527abe3",
  "traceId": "9fffaebd-749e-468b-af3f-2a89e3347785",
  "turnId": "turn_99879260-1c9b-4e97-afe1-c2e7abeaf5b9",
  "response": "ok",
  "usage": {
    "source": "provider",
    "modelRequestCount": 1,
    "inputTokens": 12599,
    "outputTokens": 17,
    "totalTokens": 12616,
    "cacheReadTokens": 512,
    "cacheWriteTokens": 0,
    "reasoningTokens": 0,
    "webFetchRequests": 0,
    "webSearchRequests": 0
  },
  "eventCount": 17,
  "projection": {
    "status": "idle",
    "turnCount": 1,
    "totalTokenCount": 12616,
    "contextUsed": 12616,
    "contextWindow": 1000000
  }
}
`;

// ============================================================
// [②app-server] NDJSON 帧序列语料（R3，附录 A.2 帧序逐字）
// ============================================================

/** 四类样本的结构（与 zcode-golden-appserver.json 的 frames 字段一一对应）。 */
export interface AppServerGoldenFrames {
  /** ① session/create 应答帧（NDJSON 单行；projection.sessionId 恒 "unknown" 勿用）。 */
  createResponse: string;
  /** ④ 推送流帧（NDJSON 逐行：state.updated / stream.chunk 无文本 / session/event delta 有文本）。 */
  pushStream: string[];
  /** ⑤ 终态帧（NDJSON 逐行：v4 telemetry turn.terminal 权威 + session/event 收尾帧全文/usage）。 */
  terminal: string[];
  /** ⑥ session/read 应答帧（NDJSON 单行：messages[].parts[]，text 全文 + step-finish tokens）。 */
  readResponse: string;
}

/** [②app-server] golden 帧序列内嵌副本（采集 SSOT = zcode-golden-appserver.json，双副本 diff 防漂移）。 */
export const ZCODE_APPSERVER_GOLDEN: AppServerGoldenFrames = {
  createResponse:
    '{"session":{"sessionId":"sess_golden_r3_01"},"projection":{"sessionId":"unknown","status":"idle","turnCount":0,"totalTokenCount":0,"contextUsed":0,"contextWindow":1000000}}',
  pushStream: [
    '{"method":"state.updated","params":{"sessionId":"sess_golden_r3_01","patch":{"status":"running"},"reason":"prompt_started"}}',
    '{"method":"v4/telemetry/event","params":{"kind":"stream.chunk","channel":"text","chunkLength":6,"firstChunk":true,"assistantMessageId":"msg_golden_r3_01"}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"delta":"你好","assistantMessageId":"msg_golden_r3_01"}}}',
    '{"method":"v4/telemetry/event","params":{"kind":"stream.chunk","channel":"text","chunkLength":1,"firstChunk":false,"assistantMessageId":"msg_golden_r3_01"}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"delta":"，","assistantMessageId":"msg_golden_r3_01"}}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"delta":"任务完成","assistantMessageId":"msg_golden_r3_01"}}}',
  ],
  terminal: [
    '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"success"}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"response":"你好，任务完成","usage":{"inputTokens":12599,"outputTokens":17}}}}',
  ],
  readResponse:
    '{"messages":[{"info":{"role":"user"},"parts":[{"type":"text","text":"做点什么"}]},{"info":{"role":"assistant"},"parts":[{"type":"text","text":"你好"},{"type":"text","text":"，任务完成"},{"type":"step-finish","tokens":{"input":12599,"output":17,"reasoning":0,"cache":512,"total":12616}}]}]}',
};
