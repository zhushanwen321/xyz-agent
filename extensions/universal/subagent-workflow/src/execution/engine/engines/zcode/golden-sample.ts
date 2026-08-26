// src/execution/engine/engines/zcode/golden-sample.ts
//
// probe「干跑校验」的内嵌 golden 样本（D7：zcode 无官方契约，探针必须做已知样本
// 回归——对 embed 样本跑 parser，格式漂移在入口拦截而非运行中静默挂死）。
//
// 来源：2026-08-25 验收前置门真机实录（zcode 0.16.5），完整原文与采集元数据见
// __tests__/__fixtures__/zcode-golden-spawn.json。为什么不直接读 fixture 文件：
// probe 在生产运行（npm 包安装形态）也要可用，__tests__ 不在稳定交付面内——内嵌
// 副本以代码为交付载体；两处不一致时以 fixture 为采集 SSOT、此处为运行时副本，
// 更新样本需同步改两处（conformance golden 回放层会 diff 校验）。

/** 实录 stdout 原文（单 JSON：sessionId/traceId/turnId/response/usage/eventCount/projection）。 */
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
