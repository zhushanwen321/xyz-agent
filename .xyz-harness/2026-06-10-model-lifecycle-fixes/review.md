# 模型生命周期修复计划 — 审查意见

## 总体评价

计划覆盖了主要故障点（defaultProvider 失效 → pi crash → 前端无错误信息），修复思路清晰。但存在以下需要补充或修正的问题。

---

## 一、遗漏的故障点

| 优先级 | 文件 | 行号 | 类别 | 描述 | 建议 |
|-----|------|------|------|------|------|
| P0 | pi-config-bridge.ts | L374 | 正确性 | `setDefaultModel()` 不校验 provider/model 是否存在于 models.json。`settings-message-handler.ts` L90 的 `model.switch` 调用 `configService.setDefaultModel(provider, modelId)` 时，provider/model 已经通过了 `switchModel()`（pi RPC set_model），但如果 pi 的 set_model 成功但 models.json 中不存在该 provider（如 llm-simple-router 场景），settings.json 中的 defaultProvider/defaultModel 仍然会指向 models.json 中不存在的条目。下次启动 pi 时 `getDefaultModel()` 返回无效值。T1 的 `validateDefaultModel` 会在读取时 fallback，但 `setDefaultModel` 写入时不做校验是不对称的。 | `setDefaultModel` 内部调用 `validateDefaultModel` 验证，或在 T1 中让 `getDefaultModel` 始终走 validate 路径（计划已选择后者，确认 T1 完全覆盖 `getDefaultModel` 入口即可）。 |
| P1 | settings-message-handler.ts | L33-36 | 正确性 | `config.setProvider` 调用 `configService.setProvider()` 后广播 `config.providerUpdated` 和 `broadcastProviderList()`，但没有检查该 provider 是否是当前 defaultProvider。如果用户修改了 defaultProvider 的 models 列表（删除了 defaultModel 对应的 model），T3 的 upsertProvider 同步校验需要在这里生效。但 `configService.setProvider` 最终调用 `upsertProvider`，确认 T3 的改动在 `upsertProvider` 中生效即可。 | 确认 T3 改动在 `upsertProvider` 函数内部（而非 settings-message-handler 层面），这样所有写路径都经过校验。 |
| P1 | session-service.ts | L93-95 | 正确性 | `create()` 中 `if (!getDefaultModel())` 只在 create 入口检查。但 `restoreSession()` 中的检查（L171）同样存在。计划 T6 说"T1 自动生效"——这依赖于 `getDefaultModel()` 内部调用 `validateDefaultModel()` 并可能自动修正 settings.json。但 `validateDefaultModel` 的 fallback + 自动修正只在调用 `getDefaultModel` 时触发。如果在 `create()` 和 `restoreSession()` 之间 models.json 被外部修改（如用户手动删除 provider），两次调用之间 settings.json 可能被重复修正。 | 无需额外改动，但 `validateDefaultModel` 应该是幂等的（多次调用结果一致）。计划中未明确提及幂等性。建议在测试策略中增加"连续调用两次 validateDefaultModel 结果一致"的测试用例。 |
| P1 | session-service.ts | L261 | 正确性 | `initializeManagedSession` 中 `const modelRef = getDefaultModel()` 用 getDefaultModel 的返回值设置 `session.modelId`。如果 create 时用户尚未配置 provider，`getDefaultModel()` 返回 null，`modelId` 设为空字符串。此后 pi 进程已经以 `--model ''`（空字符串）启动了，但 `start()` 方法中 `if (model) args.push('--model', model)` 会跳过空字符串，所以 pi 以无 --model 参数启动。这不是 crash，但 session 的 `modelId` 字段为空，UI 显示可能异常。 | `create()` 在 `getDefaultModel()` 返回 null 时已经 throw，所以这个路径理论上不可达。但如果 `validateDefaultModel` fallback 逻辑有 bug 导致既返回 null 又不 throw……建议 `initializeManagedSession` 对空 modelId 做防御性处理。 |

---

## 二、可能引入新 bug

| 优先级 | 文件 | 类别 | 描述 | 建议 |
|-----|------|------|------|------|
| P0 | pi-config-bridge.ts | 并发/竞态 | **settings.json 写入竞态**：`upsertProvider()`（T3）和 `removeProvider()`（T2）都会在写完 models.json 后再读写 settings.json。如果两个操作并发（如快速连续删除两个 provider），`readSettings()` → 修改 → `writeSettings()` 的 read-modify-write 序列之间没有互斥保护。`atomicWrite` 只保证单次写入原子性，不保证 read-modify-write 原子性。虽然计划中注释了"写入频率极低，用户手动操作，冲突概率可忽略"，但 `model.switch`（settings-message-handler L89-95）也会写 settings.json，如果用户在 Settings 页面编辑 provider 的同时切换模型，理论上可能发生竞态。 | 实际风险极低（Node.js 单线程，除非有 async 操作夹在 read 和 write 之间）。但 T2/T3 中 `removeProvider`/`upsertProvider` 内部调用的 `writeModels()` 和后续的 `readSettings()`/`writeSettings()` 之间如果有 `await`，可能被其他 WS handler 插入。检查 T2/T3 的实现确保全程同步（无 await）。当前代码中 `removeProvider` 和 `upsertProvider` 确实是全同步的，所以竞态窗口只存在于两个 handler 真正并行处理的场景——在 Node.js 单线程中不会发生。**可以接受，但建议在代码注释中明确标注"必须保持同步"。** |
| P1 | pi-config-bridge.ts | 正确性 | **validateDefaultModel 的 fallback 时写 settings.json 的时序**：`validateDefaultModel()` 在 `getDefaultModel()` 中被调用，而 `getDefaultModel()` 可能在任何上下文被调用（包括 WS handler 处理过程中）。如果 fallback 触发 `writeSettings()`，会同时使 `settingsCache` 失效并重建。如果上游代码已经 readSettings() 并持有旧引用，后续写入可能覆盖 validateDefaultModel 的修正。 | `validateDefaultModel` 应该只在 `getDefaultModel()` 中被调用，且该函数的调用者不应该再 readSettings-modify-writeSettings（目前 `getDefaultModel` 本身不做写操作，但 T1 会改它做写操作）。确保 `validateDefaultModel` 内部的 `writeSettings` 调用 `writeSettings()`（会更新缓存），这样后续 `readSettings()` 能读到修正后的值。 |
| P1 | event-adapter.ts | 正确性 | **T4 提取 errorMessage 的字段名不确定**：计划说"提取 `lastMsg?.errorMessage`"，但 pi 的 `agent_end` event 结构中 `PiAgentEndMessage` 类型只有 `role/content/stopReason/usage`，没有 `errorMessage` 字段。需要确认 pi 实际返回的 agent_end 事件在 error 场景下是否有额外字段（可能在 `content` 中、或 `diagnostics` 中、或作为顶层的 error 字段）。如果 `errorMessage` 字段不存在，T4 的改动将始终拿到 undefined，等于没改。 | 需要实际测试 pi 的 agent_end 在 error 时返回的完整结构。可以先通过手动触发 API 错误，在 rpc-client.ts 的 onEvent listener 中打印完整 event 对象。建议在 plan 中增加"验证步骤：确认 pi agent_end error 场景的实际字段"。 |
| P1 | chat.ts | 正确性 | **T5 扩展 completeStream 参数但保留旧签名**：`completeStream` 目前接受 `{ stopReason?: string }`，T5 要扩展为 `{ stopReason?: string; errorMessage?: string }`。但 `useChat.ts` 的 `onComplete` 和 `useChat` 的 `abort` 都调用 `completeStream`。abort 路径传 `{ stopReason: 'aborted' }` 不需要 errorMessage。需要确保 `completeStreaming` 内部的 error 分支（L155-163）同时处理两个场景：(1) `stopReason === 'error'` 且有 errorMessage（透传）；(2) `stopReason === 'error'` 且无 errorMessage（用 fallback 文案）。 | 计划已描述此逻辑（"优先使用 errorMessage，fallback 到通用提示"），但需要确认 `completeStreaming` 的参数类型与 `completeStream` 一致更新。当前 `completeStream` 的参数类型是 `{ stopReason?: string }`，需要扩展。 |

---

## 三、被忽略的更优方案

| 优先级 | 描述 | 建议 |
|-----|------|------|
| P2 | **validateDefaultModel 的触发时机**：计划让 `getDefaultModel()` 内部调用 `validateDefaultModel()` 并自动修正 settings.json。这是一种"读时修正"策略。更优雅的方案是"写时校验"——在所有修改 models.json 或 settings.json 的入口点（upsertProvider/removeProvider/setDefaultModel）做校验，保证写入后的一致性。这样 `getDefaultModel()` 保持纯读、无副作用，更容易推理和测试。 | 计划实际上同时做了两者：T1 是读时修正（防御性），T2/T3 是写时校验（主动）。这种双层防御是合理的。但建议 `getDefaultModel()` 中的 `validateDefaultModel` 分离为两个函数：(1) 纯校验函数 `findValidDefaultModel()` 返回结果但不写入；(2) `validateAndFixDefaultModel()` 做校验+修正。`getDefaultModel` 调用后者，而需要只读校验的场景可以调用前者。 |
| P2 | **前端 error 透传的现有通道**：当前 `event-adapter.ts` 已经有 `handleMessageUpdate` 的 `case 'error'`（L95）发送 `message.stream_error`。pi 在流式传输中遇到错误时通过 `message_update` sub-type `error` 发送，前端 `useChat.ts` 的 `onStreamError` 已经处理这个事件。但 `agent_end` 的 error（stopReason=error）和 `message_update` 的 error 是两个不同层面的错误。T4 只处理了 agent_end 层面的透传，如果 pi 在流中就发送了 error content（通过 message_update），前端已经有 `message.stream_error` 处理。需要确认两者不会同时出现导致显示两条错误消息。 | 在 `completeStreaming` 的 error 分支中，如果 streamingMessage 已存在（说明已收到流式内容），此时流式 error 可能已经被 stream_error handler 处理过了。需要避免重复显示。检查 `completeStreaming` 中 `stopReason === 'error'` 的两个分支：(1) streamingMessage 存在 → 正常完成消息（已有流式错误显示）；(2) streamingMessage 不存在 → 插入错误通知（T5 要改的部分）。这种情况下不会重复。 |

---

## 四、测试策略补充

| 优先级 | 描述 | 建议 |
|-----|------|------|
| P1 | **缺少 settings.json 写入竞态的测试** | 虽然实际风险极低（Node.js 单线程），但应在测试中验证：快速连续调用 `removeProvider`（删除 defaultProvider）+ `setDefaultModel` 不会导致 settings.json 损坏。可以写一个集成测试模拟快速连续操作。 |
| P1 | **缺少 `validateDefaultModel` 幂等性测试** | 计划的测试策略列出了 4 种 fallback 场景，但没有测试"validateDefaultModel 被调用两次"的场景。如果 fallback 时写入了 settings.json，第二次调用应该不再触发 fallback（因为 settings.json 已经被修正）。 |
| P1 | **缺少 pi error 字段的验证步骤** | T4 假设 `lastMsg?.errorMessage` 存在，但没有验证 pi 实际行为。建议在 plan 中增加一个前置验证任务：手动触发 API 错误，记录 pi agent_end 的完整 event 结构，确认 errorMessage 字段名和位置。 |
| P2 | **缺少 config.defaults 广播一致性测试** | `model.switch` 成功后广播 `config.defaults`，前端 `useProvider.ts` 的 `onDefaults` 设置 `settingsStore.defaultModel`。如果 T2/T3 的 fallback 修正了 settings.json，但没有广播 `config.defaults`，前端 settingsStore 的 `defaultModel` 与后端 settings.json 可能不一致。 | T2/T3 的 fallback 修正 settings.json 时，应该也广播 `config.defaults`（或让调用方负责广播）。但 `pi-config-bridge.ts` 是纯数据层，不应该直接广播 WS 消息。建议在 `removeProvider`/`upsertProvider` 的调用方（settings-message-handler.ts）处理广播。计划中未提及这一点。 |

---

## 五、总结

### 必须修复（P0）

1. **T4 的 errorMessage 字段名需要验证**：`PiAgentEndMessage` 类型中没有 `errorMessage` 字段。需要确认 pi 实际返回结构后再编码，否则改动无效。

### 推荐修复（P1）

2. **T2/T3 fallback 后缺少 config.defaults 广播**：`removeProvider`/`upsertProvider` 在 fallback 修正 settings.json 后，前端的 `settingsStore.defaultModel` 与后端不一致。需要在 settings-message-handler 层面增加广播。
3. **validateDefaultModel 幂等性**：确保多次调用不会重复写入或产生不一致状态。
4. **T5 参数类型一致性**：确保 `completeStream` 和 `completeStreaming` 的参数类型同步扩展。

### 建议关注（P2）

5. 考虑将 `validateDefaultModel` 拆分为纯校验+带修正两个函数，提高可测试性。
6. 在代码注释中明确标注 T2/T3 的"必须保持同步"约束。
