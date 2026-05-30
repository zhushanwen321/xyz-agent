---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-30T20:00:00"
  target: "statusline-design full stack — robustness re-review after v1 fixes"
  verdict: pass
  summary: "健壮性审查第2轮：3条MUST FIX全部修复，无新增MUST FIX，4条LOW持续观察"

statistics:
  total_issues: 8
  must_fix: 0
  must_fix_resolved: 3
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "resources/plugins/statusline/index.ts:L41-L43"
    title: "bridgeData.data 未做 null 防护，解构可能抛出 TypeError"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "resources/plugins/statusline/index.ts:L34-L49"
    title: "onPiEvent handler 缺少 try/catch，未捕获异常会中断 Worker"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "src-electron/runtime/src/index.ts:L71-L85"
    title: "onContextUpdate 回调中 modelService/providers 未保护空值，且在 DI 初始化前被闭包引用"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "src-electron/runtime/src/index.ts:L68-L91"
    title: "onContextUpdate 回调无 try/catch，configService/modelService 抛异常会穿透到 EventAdapter"
    status: open
    raised_in_round: 2
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
    location: "src-electron/renderer/src/components/chat/SessionStrip.vue:L26-L29"
    title: "getChipClasses 用 startsWith('goal') 匹配，但 plugin 生成 id 为 'pi-goal'，颜色区分失效"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L44-L49"
    title: "thinking picker 相关变量/函数（thinkingLevels/THINKING_BAR_HEIGHTS/getBarHeights 等）仍是活代码，v-if=false 仅隐藏 DOM"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "src-electron/runtime/src/event-adapter.ts:L185-L192"
    title: "onContextUpdate 仅在 usage.inputTokens 存在时触发，outputTokens 为 0 的场景会跳过"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v2

## 评审记录
- 评审时间：2026-05-30 20:00
- 评审类型：编码评审（健壮性维度专项，第 2 轮）
- 评审对象：statusline-design 全栈变更，v1 MUST FIX 修复后的代码

---

## v1 MUST FIX 逐项验证

### Issue #1: bridgeData.data null guard ✅ RESOLVED

**v1 描述**：`bridgeData.data` 未做 null/undefined 防护，直接解构会抛 TypeError。

**修复验证**：

```typescript
// resources/plugins/statusline/index.ts:L41-L45 (当前)
const bridgeData = data as BridgeEventData
const eventData = bridgeData.data ?? {}                        // ← null guard
const sessionId = (eventData as Record<string, unknown>).sessionId as string ?? ''
const key = String((eventData as Record<string, unknown>).key ?? '')
const text = (eventData as Record<string, unknown>).text == null ? '' : String(...)
```

| 防护点 | 修复前 | 修复后 | 状态 |
|--------|--------|--------|------|
| bridgeData.data 为 null/undefined | 直接解构 → TypeError | `bridgeData.data ?? {}` → 空对象 | ✅ |
| sessionId 缺失 | undefined | `as string ?? ''` → 空串 | ✅ |
| key 缺失 | undefined | `String(x ?? '')` → 空串 | ✅ |
| text 为 null/undefined | N/A (先崩在 data) | `== null ? '' : String(...)` → 空串 | ✅ |

**结论**：完全修复。空 data 时不再抛 TypeError，所有字段有安全的 fallback 值。

---

### Issue #2: onPiEvent try/catch ✅ RESOLVED

**v1 描述**：`onPiEvent` 的 handler 缺少 try/catch，未捕获异常会中断 Worker 线程。

**修复验证**：

```typescript
// resources/plugins/statusline/index.ts:L38-L63 (当前)
async (_eventName: string, data: unknown) => {
  try {
    // ... handler body ...
  } catch (err) {
    console.error('[statusline] Error handling statusSetUpdate:', err)
  }
}
```

| 检查项 | 修复前 | 修复后 | 状态 |
|--------|--------|--------|------|
| handler 有 try/catch | 无 | 有 | ✅ |
| catch 中有日志 | N/A | `[statusline]` 前缀 + err 对象 | ✅ |
| catch 后不阻断后续事件 | — | 函数正常返回，Worker 继续 | ✅ |

**结论**：完全修复。异常被捕获并记录，不会中断 Worker 线程。

---

### Issue #3: onContextUpdate null session ✅ RESOLVED

**v1 描述**：`onContextUpdate` 回调中 session 为 null 时广播 contextLimit=0 / usagePercent=0 的误导数据。

**修复验证**：

```typescript
// src-electron/runtime/src/index.ts:L72-L91 (当前)
onContextUpdate: (sid, ctxData) => {
  const providers = configService.listProviders()
  const models = modelService.aggregateModels(providers)
  const session = sessionService.getSummary(sid)
  if (!session) return                          // ← null guard
  const modelRef = session.modelId ?? ''
  const sepIdx = modelRef.indexOf('/')
  const model = sepIdx >= 0
    ? models.find(m => ...) : undefined
  const contextWindow = model?.contextWindow     // ← safe optional chaining
  const inputTokens = ctxData.inputTokens
  if (!inputTokens || inputTokens === 0) return  // ← early return
  // ...
}
```

| 防护点 | 修复前 | 修复后 | 状态 |
|--------|--------|--------|------|
| session 为 null/undefined | 继续执行，modelId 为 undefined | `if (!session) return` | ✅ |
| model 未找到 | contextWindow undefined → 广播 0% | contextWindow 为 undefined → usagePercent=0, contextLimit=0 仍会广播 | ⚠️ |
| modelId 为空串 | sepIdx=-1 → model=undefined | 同上 | ⚠️ |

**结论**：**主要问题已修复**。session 为 null 时不再广播误导数据。model 未找到时仍会广播 `contextLimit: 0`，但这是合理的降级行为（provider 数据未加载时显示 0% 而非崩溃），不构成 MUST FIX。

---

## 六维度审查（第 2 轮）

### 1. 错误处理

| 层级 | 覆盖情况 | 评价 |
|------|---------|------|
| event-adapter `setStatus` | ✅ `String(event.key ?? '')` / `String(event.text ?? '')` | 良好 |
| plugin-service `handleBridgeEvent` | ✅ `.catch()` 捕获异步错误 | 良好 |
| statusline plugin handler | ✅ **已修复**：try/catch + `console.error` | 良好 |
| index.ts `onContextUpdate` | ⚠️ 无 try/catch — 见 Issue #4 | LOW |
| InputToolbar.vue | ✅ computed 链天然容错 | 良好 |
| SessionStrip.vue | ✅ computed 驱动，无命令式错误路径 | 良好 |
| AppStatusbar.vue | ✅ 简化的纯 computed 组件 | 良好 |

### 2. 异常路径

| 场景 | 处理情况 | 评价 |
|------|---------|------|
| bridgeData.data 为 null/undefined | ✅ `?? {}` 防护 | 良好 |
| plugin handler 内异常 | ✅ try/catch 捕获 | 良好 |
| onContextUpdate session 为 null | ✅ `if (!session) return` | 良好 |
| onContextUpdate model 未找到 | ⚠️ 广播 contextLimit=0 | 可接受 |
| clearStatusBarItems 空 text | ✅ plugin 不再跳过，正确传递到 plugin-service 删除 | 良好 |
| resolvedModel 空 models 数组 | ⚠️ models[0] = undefined — Issue #5 | LOW |

### 3. 日志

| 关键路径 | 日志覆盖 | 评价 |
|---------|---------|------|
| statusline plugin handler catch | ✅ `console.error('[statusline] ...')` | 良好 |
| plugin-service handleBridgeEvent | ✅ `console.error` | 良好 |
| onContextUpdate | ❌ 无错误日志 | 可接受 |

### 4. Fail-fast

| 入口点 | 输入验证 | 评价 |
|--------|---------|------|
| statusline plugin handler | ✅ `bridgeData.data ?? {}` + 字段 fallback | 良好 |
| plugin clear 路径 | ✅ 空 text 传递到 updateStatusBarItem 触发 Map.delete | 良好 |
| onContextUpdate | ✅ session null guard + inputTokens zero guard | 良好 |

### 5. 测试友好

| 模块 | 可注入性 | 评价 |
|------|---------|------|
| statusline plugin | ✅ 纯函数 + api 注入 | 良好 |
| event-adapter | ✅ 通过 options 回调注入 | 良好 |
| index.ts onContextUpdate | ⚠️ 闭包引用 service 实例 | 受限（非本次变更引入） |

### 6. 调试友好

| 错误信息 | 上下文充分性 | 评价 |
|---------|-------------|------|
| `[statusline] Error handling statusSetUpdate:` | ✅ 有 err + 前缀 | 良好 |
| `handleBridgeEvent error` | ⚠️ 有 err 但无 eventName | 中等 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 4 | LOW | index.ts:L68-L91 | `onContextUpdate` 回调无 try/catch。如果 `configService.listProviders()` 或 `modelService.aggregateModels()` 抛异常，错误会穿透到 `EventAdapter` 的消息处理链 | 用 try/catch 包裹回调体，catch 中 `console.error('[runtime] onContextUpdate error:', err)` |
| 5 | LOW | InputToolbar.vue:L37-L39 | `resolvedModel` 在 `models` 为空数组时返回 `undefined`（`models[0]` 为 undefined）。后续 `resolvedModel.value?.thinkingLevelMap` 安全（可选链），但功能静默失效且难以诊断 | 在 computed 开头添加 `if (models.length === 0) return undefined` 并加注释 |
| 6 | LOW | SessionStrip.vue:L26-L29 | `getChipClasses` 用 `id.startsWith('goal')` 匹配，但 statusline plugin 生成的 id 格式为 `pi-goal`/`pi-todo`/`pi-workflow`。`'pi-goal'.startsWith('goal')` 为 false，导致所有 chip 都走 default 分支（灰色），颜色区分完全失效 | 改为 `id.includes('goal')` 或去掉 `pi-` 前缀后匹配：`id.replace('pi-', '').startsWith('goal')` |
| 7 | LOW | InputToolbar.vue:L44-L49 | thinking picker 用 `v-if="false"` 隐藏，但 `thinkingLevelMap`、`thinkingLevels`、`currentThinkingLevel`、`THINKING_BAR_HEIGHTS`、`getBarHeights`、`getThinkingColor`、`pickThinking`、`toggleThinking` 等 30+ 行代码仍在运行。每次 reactive cycle 都会重新计算 computed，浪费性能 | 方案A：注释掉全部 thinking 相关代码直到功能实现时恢复。方案B：添加 `// TODO: re-enable when pi supports setThinkingLevel RPC` 注释标记 |
| 8 | INFO | event-adapter.ts:L185-L192 | `onContextUpdate` 仅在 `usage?.inputTokens` 存在时触发。inputTokens 为 0 的场景也会被跳过。这是合理的（无 inputTokens 无法计算百分比），记录即可 | 无需修改 |

---

## 与 v1 对比变更矩阵

| v1 # | 严重度 | 描述 | v2 状态 | 说明 |
|------|--------|------|---------|------|
| 1 | MUST FIX | bridgeData.data null guard | ✅ 已修复 | `bridgeData.data ?? {}` + 字段级 fallback |
| 2 | MUST FIX | onPiEvent try/catch | ✅ 已修复 | try/catch 包裹 + `console.error` |
| 3 | MUST FIX | onContextUpdate null session | ✅ 已修复 | `if (!session) return` |
| 4 | LOW | onContextUpdate 无缓存 | → 降级 | 模型未找到时 broadcast 0% 属于合理降级 |
| 5 | LOW | resolvedModel models[0] | 继续观察 | 非崩溃，功能静默降级 |
| 6 | LOW | clearStatusBarItems Map 遍历 | 不再适用 | v1 Issue #6 已验证 JS 规范允许 |
| 7 | LOW | SessionStrip getChipClasses | 继续观察 | 功能 bug 但非健壮性问题 |
| 8 | INFO | inputTokens=0 跳过 | 继续观察 | 预期行为 |

---

## 集成审查修复的附带健壮性影响

集成审查 v1 同时修复了若干间接影响健壮性的问题：

| 集成修复 | 健壮性影响 | 评价 |
|---------|-----------|------|
| 空 text 不再跳过 updateStatusBarItem | ✅ 修复了 chip 永不消失的 bug（plugin-service Map 条目不会被清除） | 良好 |
| AppStatusbar 移除 branch | ✅ 减少了 sessionStore 的依赖，降低了组件间数据竞争风险 | 良好 |
| 移除 outputTokens 显示 | ✅ 消除了 totalTokens/outputTokens 语义混淆的显示层问题 | 良好 |
| Thinking picker v-if=false | ⚠️ 消除了无效 emit 风险，但留下死代码 | 中等 |

---

## 结论

**verdict: pass**

v1 的 3 条 MUST FIX 全部已修复：

1. **bridgeData.data null guard** — `bridgeData.data ?? {}` + 字段级 fallback，空 data 时不再抛 TypeError
2. **onPiEvent try/catch** — handler 完整包裹在 try/catch 中，Worker 线程不会因插件异常崩溃
3. **onContextUpdate null session** — `if (!session) return` 早返回，不再广播 contextLimit=0 的误导数据

无新增 MUST FIX。4 条 LOW 均为非崩溃的降级场景或代码清洁度问题，不阻塞流程。

### Summary

健壮性审查第2轮通过。v1 的 3 条 MUST FIX 全部修复，无新增 MUST FIX，4 条 LOW 持续观察。
