---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-30T20:00:00"
  target: "feat-statusline diff (264e1e0..HEAD) — integration review round 2"
  verdict: pass
  summary: "4 条 MUST FIX 全部修复，未引入新问题，typecheck 通过"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 4
  low: 3
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "resources/plugins/statusline/index.ts:L55"
    title: "Statusline plugin 清除逻辑断裂——空 text 时跳过 updateStatusBarItem"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/layout/AppStatusbar.vue"
    title: "Branch 同时出现在 SessionStrip 和 AppStatusbar——违反 AC-5"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L139"
    title: "Thinking level picker 可见但 emit 被注释"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L196"
    title: "↓ output tokens 实际显示 totalTokens——语义数据不匹配"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "src-electron/shared/src/protocol.ts:L167"
    title: "plugin:statusSetUpdate 在 ServerMessageType 但从未作为 WS 消息发送"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "src-electron/renderer/src/components/layout/AppStatusbar.vue:L11"
    title: "PI_VERSION 硬编码常量——pi 升级后需手动同步"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "docs/plugin/built-in-plugin-guide.md §5.2"
    title: "Plugin guide 文档错误——声称不要发送空字符串给 updateStatusBarItem"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "src-electron/runtime/src/server.ts:L719"
    title: "bridge:event handler 中 as 断言后 ?? 永远不触发"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "src-electron/renderer/src/composables/useChat.ts:L164-166"
    title: "setTokenUsage 每次 message.complete 覆盖（非累加）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "types/plugin.ts vs protocol.ts"
    title: "PluginStatusItem / StatusBarItem 结构相同但分处两文件"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# 集成审查 v2（第 2 轮）

## 评审记录
- 评审时间：2026-05-30 20:00
- 评审类型：编码评审（集成审查第 2 轮）
- 评审对象：diff `264e1e0..HEAD`（v1 MUST FIX 修复）
- 评审重点：4 条 MUST FIX 修复验证 + 新问题引入检查

---

## 1. MUST FIX 修复验证

### Issue #1: 清除路径断裂 ✅ 已修复

**v1 问题**：`if (text === '') return` 跳过了 `updateStatusBarItem` 调用，plugin-service Map 中旧 chip 永远不删除。

**v2 修复**：
```typescript
// Before (v1):
if (text === '') return

// After (v2):
// Empty text means clear — let updateStatusBarItem handle removal (plugin-service deletes from Map)
// guard 已删除，空 text 正常流入 updateStatusBarItem
```

**验证**：
- statusline plugin 空 text 时调用 `api.ui.updateStatusBarItem('pi-${key}', '')`
- plugin-service L416: `if (text === '') { this.statusBarItems.delete(itemKey) }` 正确执行 Map 删除
- 删除后 `broadcastStatusBarItems()` 广播更新到前端
- UC-1 "goal 完成后 chip 消失" 路径完整 ✅

**结论**：✅ 修复正确，清除链路完整。

---

### Issue #2: Branch 重复 ✅ 已修复

**v1 问题**：branch 同时出现在 SessionStrip 和 AppStatusbar，违反 AC-5。

**v2 修复**：
- `AppStatusbar.vue` 移除了 `useSessionStore`、`usePanelStore` import
- 移除了 `activeSessionId`、`branchName` computed
- 移除了 `<span v-if="branchName">` 模板渲染
- 添加注释 `// Branch name is displayed in SessionStrip (per-session)`
- AppStatusbar 现在只显示：连接状态 + pi 版本 + global chips

**验证**：
- AppStatusbar template: `connection dot + statusText + pi version + global chips` — 无 branch ✅
- SessionStrip 仍正确显示 branch + per-session chips ✅
- 符合 spec FR-5（Global Statusbar = 连接状态 + pi 版本 + global chips）✅

**结论**：✅ 修复正确，AC-5 信息不重复通过。

---

### Issue #3: Thinking picker 隐藏 ✅ 已修复

**v1 问题**：Thinking level picker 可见但 emit 被注释，用户操作无效果。

**v2 修复**：
```html
<!-- Thinking Level Picker — hidden until pi supports setThinkingLevel RPC -->
<div v-if="false" ref="thinkingRef" class="relative">
```
- `showThinkingPicker` computed 被注释
- 模板改为 `v-if="false"` 硬隐藏
- 注释说明 "hidden until pi supports setThinkingLevel RPC"

**验证**：
- picker 在 UI 中不可见 ✅
- 无用户可触发的无效操作 ✅
- 代码保留（非删除），后续 pi 支持 RPC 后可快速启用 ✅
- `pickThinking` 函数中 emit 仍被注释，与 UI 隐藏一致 ✅

**结论**：✅ 修复合理。采用方案 A（隐藏），最小化改动范围。

---

### Issue #4: ↓ output 语义 ✅ 已修复

**v1 问题**：`↓` 标签显示 `totalTokens`（= input + output），语义与 output tokens 不匹配。

**v2 修复**：
- 移除 `outputTokens` computed
- 移除模板中 `<span>↓</span><span>{{ formatTokenCount(outputTokens) }}</span>`
- 只保留 `↑` + `inputTokens`（来自 context update，语义准确）
- 注释说明 "Token Stats: input tokens only (total tokens not available per-request)"

**验证**：
- `↑ 12.5k` 显示 context inputTokens（来自 `context.update` 广播的 `inputTokens`）✅
- 无误导性的 `↓` 标签 ✅
- 不再依赖 `message.complete` 中的 `usage.totalTokens`（该路径代码保留但不再渲染）✅

**结论**：✅ 修复正确。移除了不可靠的 output token 显示，保留语义准确的 input token。

---

## 2. 新问题引入检查

| 检查项 | 结果 |
|--------|------|
| statusline plugin: 空字符串流入 updateStatusBarItem 是否引发异常？ | ✅ plugin-service L416 正确处理 `text === ''` → Map.delete |
| AppStatusbar: 移除 sessionStore/panelStore 后是否还有未使用 import？ | ✅ 无未使用 import |
| InputToolbar: `v-if="false"` 是否产生 dead code warning？ | ✅ Vue compiler 不对 v-if="false" 报错 |
| InputToolbar: 移除 outputTokens 后 useChat.ts 中 setTokenUsage 是否成死代码？ | ⚠️ useChat.ts 仍调用 `store.setTokenUsage()`，但 store 中的 `tokenUsage` 字段不再被任何组件读取。无功能影响，属于 INFO 级残留（与 Issue #9 合并） |
| TypeScript 编译 | ✅ `tsc --noEmit` (renderer) + `tsc --noEmit` (runtime) 零错误 |

**新引入问题**：无 MUST FIX 级新问题。

---

## 3. Typecheck 验证

| 检查项 | 结果 |
|--------|------|
| `src-electron/renderer/` vue-tsc --noEmit | ✅ 通过 (exit 0, 零错误) |
| `src-electron/` tsc --noEmit | ✅ 通过 (exit 0, 零错误) |

---

## 4. spec 合规验证矩阵（更新）

| AC | 描述 | v1 状态 | v2 状态 |
|----|------|---------|---------|
| AC-1 | setStatus 到达前端 | ❌ | ✅ 清除路径已修复 |
| AC-2 | Input Toolbar 完整功能 | ❌ | ✅ thinking 隐藏, token 语义正确 |
| AC-3 | Session Strip 信息展示 | ⚠️ | ✅ branch + chips, 无重复 |
| AC-4 | Global Statusbar 聚合 | ❌ | ✅ 连接+版本+global chips, 无 branch |
| AC-5 | 信息不重复 | ❌ | ✅ branch 仅在 SessionStrip |
| AC-6 | statusBarUpdate 增强 | ✅ | ✅ |
| AC-7 | Built-in Plugin 开发指南 | ⚠️ | ⚠️ Issue #7 (LOW) 未修 |
| AC-8 | bridge:event 修复 | ✅ | ✅ |

---

## 5. 遗留问题（不阻塞）

| # | 优先级 | 说明 | 备注 |
|---|--------|------|------|
| 5 | LOW | `plugin:statusSetUpdate` 在 ServerMessageType 联合类型中但从未作为 WS 消息 | 建议后续清理 |
| 6 | LOW | `PI_VERSION` 硬编码 | 建议后续从 pi `get_state` 动态读取 |
| 7 | LOW | built-in-plugin-guide §5.2 空文本指导与 API 行为矛盾 | 随 Issue #1 修复后应更新文档 |
| 8 | INFO | server.ts bridge:event `as ... ?? {}` 语义不清晰 | 无功能影响 |
| 9 | INFO | useChat.ts `setTokenUsage` 覆盖非累加 + tokenUsage 不再被渲染 | 可在后续清理 |
| 10 | INFO | PluginStatusItem / StatusBarItem 双类型 | 可在后续统一 |

---

## 6. 结论

**verdict: PASS**

4 条 MUST FIX 全部正确修复：
1. **清除路径**：删除 `if (text === '') return` guard，空 text 正确触发 plugin-service Map.delete
2. **Branch 重复**：AppStatusbar 移除 branch 显示，仅 SessionStrip 保留
3. **Thinking picker**：`v-if="false"` 隐藏，避免无效用户交互
4. **Token 语义**：移除误导性的 `↓` output token 显示，仅保留 `↑` input tokens

TypeScript 编译零错误，未引入新 MUST FIX 级问题。6 条 LOW/INFO 遗留问题均不阻塞。
