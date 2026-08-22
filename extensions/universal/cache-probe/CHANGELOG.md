# Changelog

## 0.1.0

初始版本。

- 9 个指纹 hash（schema v2：短 hash + 增量 entry，长期采集数据量精简）
- `before_agent_start`（每 turn）算输入侧 7 hash；`before_provider_request`（turn 首笔）补 payload 侧 spFull / toolsSent，变化时 `appendEntry`
- 零行为影响：不返回 systemPrompt、不注册 tool、不注入消息；custom entry 不进 LLM 上下文
- 契约测试：`src/__tests__/fingerprint.test.ts` + `state-machine.test.ts`
- 配套 `analyze.py` 归因脚本（增量 merge 回放）
