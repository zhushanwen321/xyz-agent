# Composer 模型切换状态同步 实现计划

## 业务目标

切换模型时，Composer 工具条的三个状态组件（上下文用量 / 模型显示 / 思考强度）同步反映新模型状态，不再出现「用量不刷新 / 模型显示消失 / 思考强度不跟随」三个缺陷。

成功标准：
1. 切换模型后，ModelSelectPopover 触发器立即显示新模型名（无需等待下一次对话）
2. 切换模型后，ContextCapacityPopover 立即用新模型 contextWindow 重算用量（无需等 agent_end）
3. 切换模型后，ThinkingLevelPopover 根据新模型 thinkingLevelMap 动态显示可用档位；当前选中档位不可用时重置到最高可用档位并下发给 pi
4. 切换模型后，多 panel 视图一致（runtime 广播，非本地乐观更新）

约束：
- 必须用 vitest（runtime 测试），禁止 node:test/tsx --test
- 遵循现有协议层契约（shared/src/protocol.ts 的 ServerMessageMapBase）
- 不引入新 npm 依赖
- 前端遵守 xyz-ui 组件库规范
- stores 间禁止互相 import，跨 store 协调由 composables 做

不做：
- 不改 thinkingLevelMap 的 key 命名空间
- 不改 ProviderEditModal 预设 UI
- 不实装「新增 defaultThinkingLevel 配置字段」方案

## 技术改动点

共同病根：runtime `ModelService.switchModel`（`runtime/src/services/model-service.ts:50-69`）是半成品——只改内存 `session.modelId` + 广播 `config.defaults`（全局默认，不带 sessionId），不广播 session 级状态变更。

- 修改 `shared/src/protocol.ts` — ServerMessageMapBase 新增 `session.state_changed`
- 修改 `runtime/src/services/session/types.ts` — IManagedSessionView 新增 `inputTokens: number`
- 修改 `runtime/src/services/session/session-service.ts` — attachUsageListener 缓存 inputTokens + initializeManagedSession 初始 + getInputTokens
- 修改 `runtime/src/index.ts` — onContextUpdate 同步缓存 inputTokens
- 修改 `runtime/src/services/model-service.ts` — switchModel 末尾广播 session.state_changed
- 修改 `runtime/src/transport/settings-message-handler.ts` — 确认 handler 与新广播不冲突
- 修改 `renderer/src/stores/session.ts` — 新增 updateSessionState action
- 修改 `renderer/src/composables/features/useChat.ts` — 订阅 session.state_changed 路由到 store
- 修改 `renderer/src/components/panel/Composer.vue` — currentModelId 空串兜底 + currentThinkingLevelMap
- 修改 `renderer/src/components/panel/ModelSelectPopover.vue` — 纯受控化
- 修改 `renderer/src/components/panel/ThinkingLevelPopover.vue` — props.levelMap 动态 available + 重置
- 修改 `renderer/src/components/panel/thinking-levels.ts` — resolveAvailableLevels + highestAvailableLevel
- 修改 `renderer/src/components/panel/ContextCapacityPopover.vue` — 订阅 state_changed 更新 stats

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | protocol.ts | - | - | Prefactor：契约类型 |
| W2 | types.ts, session-service.ts, index.ts, model-service.ts, settings-message-handler.ts | W1 | G1 | runtime 缓存+广播 |
| W3 | stores/session.ts, useChat.ts | W1 | G2 | renderer 状态层 |
| W4 | Composer.vue, ModelSelectPopover.vue | W2,W3 | G3 | Q2 修复 |
| W5 | thinking-levels.ts, ThinkingLevelPopover.vue, Composer.vue | W2,W3,W4 | G4 | Q3 修复 |
| W6 | ContextCapacityPopover.vue | W2,W3 | G3 | Q1 修复 |
| W7 | 验收 Wave | W2-W6 | - | 全量测试+覆盖率 |

## 单测用例清单（AC 级）

详见对话内 plan（U1-U31，覆盖 6 个 Wave 的正常/异常/边界）。

## E2E 用例清单

E1-E3 用 vitest + @vue/test-utils（无 Playwright，降级组件集成测试）；E4 手动验证。

## 覆盖率 gate

`cd src-electron/runtime && npx vitest run --coverage`，增量 ≥60%。

## 实现步骤

1. [W1] 写 U1/U2 → protocol.ts 新增 session.state_changed → tsc 通过 → 提交
2. [W2] 写 U3-U10 → attachUsageListener 缓存 inputTokens + model-service switchModel 广播 → 测试通过 → 提交
3. [W3] 写 U11-U14 → sessionStore.updateSessionState + 订阅路由 → 测试通过 → 提交
4. [W4] 写 U15-U19 → Composer 空串兜底 + ModelSelectPopover 纯受控 → 测试通过 → 提交
5. [W5] 写 U20-U28 → thinking-levels.ts 纯函数 + ThinkingLevelPopover 动态档位 + Composer 连线 → 测试通过 → 提交
6. [W6] 写 U29-U31 → ContextCapacityPopover 订阅 state_changed → 测试通过 → 提交
7. [W7] 验收：全量单测 + E1-E3 + 覆盖率 + E4 手动，全绿才算完成
