# 模型生命周期修复计划

## 问题概述

xyz-agent 的模型配置管理存在多个断裂点，导致：
1. `settings.json` 中 `defaultProvider/defaultModel` 可能指向不存在的 provider/model
2. pi 启动时传入不存在的 `--model` 参数，导致 `process.exit(1)`
3. 错误信息不透传，用户看到无用的固定文案

根因：写入侧（CRUD provider/model）不做一致性校验，读取侧（getDefaultModel）不做有效性检查。

## 修复范围

### T1. `pi-config-bridge.ts` — 有效性校验 + 自动修复

**设计**：拆分为两个函数，提高可测试性。

#### `findValidDefaultModel()` — 纯校验，无副作用

读取 settings.json 的 defaultProvider/defaultModel，在 models.json 中查找：
- 找到 → 返回 `{ provider, modelId }`
- provider 不存在 → fallback 到第一个有 model 的 provider + 其第一个 model
- provider 存在但 model 不存在 → fallback 到该 provider 的第一个 model
- 完全无 provider/model → 返回 null

返回 `{ result: { provider, modelId } | null, wasFixed: boolean, originalProvider?: string, originalModel?: string }`

#### `getDefaultModel()` — 调用 findValidDefaultModel + 自动修正

- 调用 `findValidDefaultModel()`
- 如果 `wasFixed` → 写入修正后的值到 settings.json，打印 warn 日志
- 返回 result

**幂等性保证**：`writeSettings()` 会更新 `settingsCache`，第二次调用 `findValidDefaultModel()` 读到修正后的值，`wasFixed === false`，不再写入。

### T2. `pi-config-bridge.ts` — `removeProvider()` 同步清理

**前提**：全程同步（无 await），避免竞态窗口。

`removeProvider(providerId)` 删除 provider 后：
1. 如果 `defaultProvider === providerId` → 清空 defaultProvider/defaultModel
2. 调用 `findValidDefaultModel()` 找 fallback
3. 如果找到 fallback → 设为新的 defaultProvider/defaultModel，写入 settings.json
4. 返回 fallback 信息供调用方广播

**返回值变更**：`boolean` → `{ removed: boolean; newDefault?: { provider: string; modelId: string } } | null`

### T3. `pi-config-bridge.ts` — `upsertProvider()` 同步校验

**前提**：全程同步（无 await）。

`upsertProvider(providerId, config)` 更新 provider 后：
1. 如果 `defaultProvider !== providerId` → 无需处理
2. 如果 `defaultProvider === providerId`：
   - 检查 defaultModel 是否在新 models 列表中
   - 如果在 → 不动
   - 如果不在 → 从新 models 列表选第一个 model 作为 defaultModel，写入 settings.json
   - 如果新 models 列表为空 → 清空 defaultProvider/defaultModel
3. 返回 fallback 信息供调用方广播

**返回值变更**：`void` → `{ newDefault?: { provider: string; modelId: string } }`

### T2b. `settings-message-handler.ts` — deleteProvider 广播 config.defaults

**文件**: `src-electron/runtime/src/settings-message-handler.ts`

`config.deleteProvider` handler 中，调用 `deleteProvider()` 后：
- 如果返回了 `newDefault` → 广播 `config.defaults` 到所有 panel，保持前端 settingsStore 一致

### T3b. `settings-message-handler.ts` — setProvider 广播 config.defaults

`config.setProvider` handler 中，调用 `setProvider()` 后：
- 如果返回了 `newDefault` → 广播 `config.defaults` 到所有 panel

### T4. `event-adapter.ts` — 透传 errorMessage

**前置验证**：已确认 pi 的 `AssistantMessage` 类型有 `errorMessage?: string` 字段（`@earendil-works/pi-ai` 的 `types.ts:296`）。`agent_end` 的 messages 数组中最后一个 assistant message 在 error 场景下携带 `errorMessage`。

**改动**：
- `handleAgentEnd()` 提取 `lastMsg?.errorMessage` 并加入 `message.complete` payload
- payload 新增 `errorMessage?: string` 字段

### T5. 前端错误显示透传

#### `src-electron/renderer/src/stores/chat.ts`

`completeStream()` 扩展参数为 `{ stopReason?: string; errorMessage?: string }`：
- `stopReason === 'error'` 且无 `streamingMessage` 时：
  - 优先使用 `errorMessage`（透传 pi 的具体错误）
  - 无 `errorMessage` 时用 fallback 文案"请求失败，请检查模型配置"
- `stopReason !== 'error'` 或有 `streamingMessage` → 不受影响

#### `src-electron/renderer/src/composables/useChat.ts`

- `onComplete` 提取 `msg.payload.errorMessage` 并传给 `completeStream({ stopReason, errorMessage })`
- 其他调用 `completeStream` 的地方（abort 路径）不受影响（errorMessage 默认 undefined）

### T6. session-service 自动生效

T1 修改了 `getDefaultModel()`，`create()` 和 `restoreSession()` 中的 `if (!getDefaultModel())` 检查自动受益。无额外改动。

## 不在本次修复范围

| 问题 | 原因 |
|------|------|
| C1: restoreSession 用 defaultModel 而不是 session 上次用的模型 | 需要持久化 session-level modelId，架构变更较大，独立 PR |
| C2: split mode 下 config.defaults 广播导致 panel B UI 与实际不一致 | 需要区分"全局默认模型"和"session 当前模型"两个概念，架构变更 |
| E1: 全局默认模型和 session 模型混为一谈 | 同上 |
| E3: ManagedSession.modelId 无持久化 | 同 C1 |
| A4: Settings 页面无默认模型配置入口 | 纯 UI 功能，不影响稳定性，独立 PR |

## 修改文件清单

| 文件 | 改动类型 |
|------|---------|
| `src-electron/runtime/src/pi-config-bridge.ts` | 新增 `findValidDefaultModel()`，修改 `getDefaultModel()`/`removeProvider()`/`upsertProvider()` |
| `src-electron/runtime/src/settings-message-handler.ts` | deleteProvider/setProvider 后广播 config.defaults |
| `src-electron/runtime/src/event-adapter.ts` | `handleAgentEnd()` 提取 errorMessage |
| `src-electron/renderer/src/composables/useChat.ts` | `onComplete` 透传 errorMessage |
| `src-electron/renderer/src/stores/chat.ts` | `completeStream` 使用透传的 errorMessage |

## 测试策略

### 单元测试（`validateDefaultModel` 系列）

1. 正常场景：provider 和 model 都存在 → 返回原值
2. provider 不存在 → fallback 到第一个可用 provider
3. provider 存在但 model 不存在 → fallback 到该 provider 的第一个 model
4. 完全无 provider → 返回 null
5. 幂等性：连续调用两次，第二次 wasFixed === false
6. removeProvider 后 defaultModel 被清理
7. upsertProvider 删除 defaultModel 后 fallback

### 手动测试

1. settings.json 中设置不存在的 provider → 启动 xyz-agent → 验证自动 fallback + 前端显示修正后的模型
2. Settings 页面删除当前 defaultProvider → 验证 defaultModel 被清理 + 前端同步更新
3. Settings 页面编辑 provider 删除 defaultModel → 验证 fallback + 前端同步更新
4. 触发 API 错误 → 验证前端显示具体错误信息而非固定文案
5. 删除所有 provider → 验证提示"请先配置 provider"
