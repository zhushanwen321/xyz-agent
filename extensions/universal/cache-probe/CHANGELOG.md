# @zhushanwen/pi-cache-probe

## 0.1.2

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.1.1

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

# Changelog

## 0.1.0

初始版本。

- 9 个指纹 hash（schema v2：短 hash + 增量 entry，长期采集数据量精简）
- `before_agent_start`（每 turn）算输入侧 7 hash；`before_provider_request`（turn 首笔）补 payload 侧 spFull / toolsSent，变化时 `appendEntry`
- 零行为影响：不返回 systemPrompt、不注册 tool、不注入消息；custom entry 不进 LLM 上下文
- 契约测试：`src/__tests__/fingerprint.test.ts` + `state-machine.test.ts`
- 配套 `analyze.py` 归因脚本（增量 merge 回放）
