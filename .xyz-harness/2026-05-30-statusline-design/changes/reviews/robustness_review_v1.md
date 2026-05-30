---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T16:00:00"
  target: "statusline-design full stack"
  verdict: fail
  summary: "健壮性审查完成，第1轮，3条MUST FIX，需修改后重审"

statistics:
  total_issues: 8
  must_fix: 3
  must_fix_resolved: 0
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "resources/plugins/statusline/index.ts:L41-L43"
    title: "bridgeData.data 未做 null 防护，解构可能抛出 TypeError"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "resources/plugins/statusline/index.ts:L34-L49"
    title: "onPiEvent handler 缺少 try/catch，未捕获异常会中断 Worker"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "src-electron/runtime/src/index.ts:L71-L85"
    title: "onContextUpdate 回调中 modelService/providers 未保护空值，且在 DI 初始化前被闭包引用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "src-electron/runtime/src/index.ts:L71-L85"
    title: "onContextUpdate 回调每次 agent_end 都执行 listProviders+aggregateModels+find，无缓存"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L37-L39"
    title: "resolvedModel computed 中 models[0] 可能为 undefined（空数组时）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L692-L720"
    title: "clearStatusBarItems 遍历 Map 时 delete 元素，虽然 JS 允许但可读性差"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "src-electron/renderer/src/components/chat/SessionStrip.vue:L19-L23"
    title: "getChipClasses 以 id.startsWith 做前缀匹配，'pi-' 前缀会干扰匹配逻辑"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "src-electron/runtime/src/event-adapter.ts:L185-L192"
    title: "onContextUpdate 仅在 usage.inputTokens 存在时触发，outputTokens 为 0 的场景会跳过"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v1

## 评审记录
- 评审时间：2026-05-30 16:00
- 评审类型：编码评审（健壮性维度专项）
- 评审对象：statusline-design 全栈变更（event-adapter → plugin-service → index.ts → 前端组件）

---

## 六维度审查

### 1. 错误处理

| 层级 | 覆盖情况 | 评价 |
|------|---------|------|
| event-adapter `setStatus` | ✅ `String(event.key ?? '')` / `String(event.text ?? '')` 做了 null→空串转换 | 良好 |
| plugin-service `handleBridgeEvent` | ✅ `.catch()` 捕获异步错误，有日志 | 良好 |
| plugin-service `updateStatusBarItem` | ✅ 在 hostHandlers 工厂内，外层有 try/catch | 良好 |
| **statusline plugin handler** | ❌ **无 try/catch** — 见 Issue #2 | **MUST FIX** |
| index.ts `onContextUpdate` | ⚠️ 无 try/catch，运行在 EventAdapter 同步路径中 | 需修复 |
| InputToolbar.vue | ✅ computed 链天然容错（undefined → ?? 0） | 良好 |
| SessionStrip.vue | ✅ computed 驱动，无命令式错误路径 | 良好 |

### 2. 异常路径

| 场景 | 处理情况 | 评价 |
|------|---------|------|
| `event.key` 为 null/undefined | ✅ `String(event.key ?? '')` 转为空串 | 良好 |
| `event.text` 为 null/undefined | ✅ `String(event.text ?? '')` 转为空串 | 良好 |
| **bridgeData.data 为 null/undefined** | ❌ **直接解构 `{ sessionId, key, text } = bridgeData.data` 会抛 TypeError** | **MUST FIX (#1)** |
| `providerStore.models` 为空数组 | ⚠️ `models[0]` 返回 undefined，后续 `?.thinkingLevelMap` 安全，但 resolvedModel 为 undefined | LOW (#5) |
| `sessionStore.sessions` 无匹配 session | ✅ `.find()` 返回 undefined → `session?.cwd` 安全检查 | 良好 |
| `contextWindow` 为 undefined/0 | ✅ 三元运算 fallback 到 0 | 良好 |
| `chatStore.getSessionState` 返回默认值 | ✅ `createSessionState()` 确保所有字段有初始值 | 良好 |
| **plugin `sessionId` 缺失** | ⚠️ plugin handler 解构 bridgeData.data.sessionId，如果 data 为 null 则崩在 #1 之前 | 被 #1 覆盖 |

### 3. 日志

| 关键路径 | 日志覆盖 | 评价 |
|---------|---------|------|
| event-adapter setStatus 翻译 | ❌ 无日志 | 可接受（翻译层纯函数） |
| server.handleStatusSetUpdate | ❌ 无日志 | 可接受（薄转发） |
| plugin-service.handleBridgeEvent | ✅ `console.error` | 良好 |
| plugin-service.updateStatusBarItem | ❌ 无日志 | 可接受（Map 操作） |
| index.ts onContextUpdate | ❌ 无日志 | 可接受但建议加 debug |
| statusline plugin handler | ❌ 无日志 | 应修复（与 #2 合并） |

### 4. Fail-fast

| 入口点 | 输入验证 | 评价 |
|--------|---------|------|
| event-adapter `setStatus` | ✅ `String(x ?? '')` 在入口处做 null 安全 | 良好 |
| plugin `onPiEvent` handler | ❌ **未验证 data 结构就解构** | **MUST FIX (#1 + #2)** |
| `updateStatusBarItem` | ✅ text === '' 早返回 | 良好 |
| `onContextUpdate` (index.ts) | ✅ `if (!inputTokens \|\| inputTokens === 0) return` 早返回 | 良好 |
| InputToolbar.vue | ✅ computed 链式 fallback | 良好 |
| SessionStrip.vue | ✅ `v-if="extensionChips.length > 0"` 防空渲染 | 良好 |

### 5. 测试友好

| 模块 | 可注入性 | 评价 |
|------|---------|------|
| event-adapter | ✅ 通过 options 回调注入 | 良好 |
| plugin-service | ⚠️ Map 管理内部状态，测试需实例化 | 中等 |
| index.ts `onContextUpdate` | ❌ **闭包引用外部 service 实例，无法注入 mock** | 受限（非本次变更引入） |
| InputToolbar.vue | ✅ props 驱动 + store 可 mock | 良好 |
| SessionStrip.vue | ✅ props + store 可 mock | 良好 |
| statusline plugin | ✅ 纯函数 + api 注入 | 良好 |

### 6. 调试友好

| 错误信息 | 上下文充分性 | 评价 |
|---------|-------------|------|
| `handleBridgeEvent error` | ⚠️ 有 err 对象但无 eventName/data | 中等 |
| `togglePlugin failed` | ✅ 含 pluginId 和 err.message | 良好 |
| statusline plugin 崩溃 | ❌ 无任何上下文 | 需修复 |
| index.ts onContextUpdate | ❌ 无错误路径（同步） | N/A |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `resources/plugins/statusline/index.ts:L41-L43` | `bridgeData.data` 未做 null/undefined 防护。当 pi 发送的事件 data 字段缺失时，`const { sessionId, key, text } = bridgeData.data` 直接抛出 TypeError，导致 Worker 线程 handler 中断 | 在解构前添加 `if (!bridgeData?.data) return` 或使用带默认值的解构 `const { sessionId = '', key = '', text = '' } = (bridgeData?.data ?? {})` |
| 2 | MUST FIX | `resources/plugins/statusline/index.ts:L34-L49` | `onPiEvent` 的 handler 回调缺少 try/catch。任何未捕获异常会导致 Worker 线程 unhandled rejection，可能触发 Worker 崩溃（取决于 runtime 的 unhandledRejection 处理策略）。最佳实践文档（§5.5）也明确要求所有回调加 try/catch | 用 try/catch 包裹整个 handler body，catch 中 `console.error('[statusline] Error handling event:', err)` |
| 3 | MUST FIX | `src-electron/runtime/src/index.ts:L71-L85` | `onContextUpdate` 回调中 `modelService` 和 `configService` 通过闭包引用。虽然 JS 闭包在调用时求值（此时已初始化），但回调内未对 `models.find()` 返回 undefined 的情况做防护。更严重的是：如果 `sessionService.getSummary(sid)` 返回 undefined/null（session 未注册），`session?.modelId ?? ''` 后 `modelRef` 为空串，`sepIdx` 为 -1，进入 `undefined` 分支，`contextWindow` 为 undefined → `usagePercent` 为 0 → 广播一个 contextLimit=0、usagePercent=0 的消息给前端。前端显示 0% 且无上下文限制，用户会困惑 | 添加早期返回：`const session = sessionService.getSummary(sid); if (!session?.modelId) return`。对 `model === undefined` 也做显式处理 |
| 4 | LOW | `src-electron/runtime/src/index.ts:L71-L85` | `onContextUpdate` 每次 agent_end 都执行 `configService.listProviders()` → `modelService.aggregateModels()` → `models.find()` 全链路查找，无缓存。高频对话场景下产生不必要的重复计算 | 可缓存 modelRef → contextWindow 映射，或在 ModelService 中提供 `getContextWindow(providerId, modelId)` 方法 |
| 5 | LOW | `src-electron/renderer/src/components/chat/InputToolbar.vue:L37-L39` | `resolvedModel` 中 `models[0]` 在数组为空时返回 undefined。后续 `resolvedModel.value?.thinkingLevelMap` 虽安全（可选链），但 `thinkingLevels` 会是空数组，`showThinkingPicker` 为 false，功能静默失效。这不会崩溃但会在配置错误时难以诊断 | 添加 guard：`if (models.length === 0) return undefined`，并在 `showThinkingPicker` 处加注释说明"provider 数据未加载时 thinking picker 自动隐藏" |
| 6 | LOW | `src-electron/runtime/src/services/plugin-service/plugin-service.ts:L700-L710` | `clearStatusBarItems` 在 `for...of` 遍历 Map 时调用 `this.statusBarItems.delete(key)`。ES6 规范允许在 Map 迭代中 delete，但代码意图不明显，维护者可能误认为是 bug | 改用 `Array.from(this.statusBarItems.entries()).filter(...)` 后批量 delete，或收集 keys 后统一删除 |
| 7 | LOW | `src-electron/renderer/src/components/chat/SessionStrip.vue:L19-L23` | `getChipClasses` 使用 `id.startsWith('goal')` 匹配，但 statusline plugin 生成的 item id 格式为 `pi-${key}`（如 `pi-goal`、`pi-todo`）。`startsWith('goal')` 不会匹配 `pi-goal`，导致所有 chip 都走 default 分支（灰色） | 匹配逻辑改为 `id.includes('goal')` 或去掉 `pi-` 前缀后再匹配 |
| 8 | INFO | `src-electron/runtime/src/event-adapter.ts:L185-L192` | `onContextUpdate` 仅在 `usage?.inputTokens` 存在时触发（`if (usage?.inputTokens)`）。这是合理的（无 inputTokens 无法计算百分比），但如果某模型返回 usage 但 inputTokens 为 0，也会被跳过。这可能是预期行为 | 无需修改，记录即可 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 重点检查项汇总

| 检查项 | 状态 | 说明 |
|--------|------|------|
| event-adapter setStatus null/undefined 防护 | ✅ 通过 | `String(event.key ?? '')` + `String(event.text ?? '')` |
| plugin-service Map 并发安全 | ✅ 通过 | Node.js 单线程，Map 操作原子。`clearStatusBarItems` 遍历中 delete 合法但可读性差（#6） |
| index.ts onContextUpdate modelService 空保护 | ❌ **未通过** | session 为 null 时静默广播 0% 数据，model 未找到时同上（#3） |
| InputToolbar.vue store 数据 undefined 处理 | ⚠️ 部分 | 大部分通过 ?? fallback 处理，但 resolvedModel 在空 models 时为 undefined（#5） |
| SessionStrip.vue items 空数组 | ✅ 通过 | `v-if="extensionChips.length > 0"` 阻止空渲染，computed 天然返回空数组 |

---

### 结论

需修改后重审。3 条 MUST FIX 均涉及运行时崩溃或数据语义错误风险：
1. plugin handler 无 null 防护 + 无 try/catch → Worker 崩溃
2. onContextUpdate session 为空时广播错误数据 → 前端显示误导

### Summary

健壮性审查完成，第1轮，3条MUST FIX（plugin handler null 防护、try/catch 缺失、onContextUpdate 空值广播），需修改后重审。
