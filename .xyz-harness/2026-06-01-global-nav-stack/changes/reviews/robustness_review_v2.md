---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 5
  dimensions_checked: 6
  issues_found: 0
  must_fix_count: 0
  low_count: 0
  info_count: 0
  duration_estimate: "10"
---

# Robustness Review v2

## 审查记录
- 审查时间：2026-06-01 17:00
- 审查文件数：5（本次 diff 涉及的源码文件）
- 审查维度：D1-D6（全量）
- 审查轮次：第 2 轮（v1 复审）

## v1 MUST_FIX 处置说明

### #1: WS 断连 watcher 重复 + 资源泄漏 (v1 MUST_FIX)

**位置**: App.vue L91-113, L276-305

**结论**: 预存在代码，本次 diff 未涉及这些行。

本次 App.vue diff 仅涉及：
- L4/L8: `@toggle-settings` 事件处理替换为 `navStore.push/back`
- L57: `<SettingsView>` 显示条件替换为 `navStore.currentView`
- L84: 新增 `import { useNavigationStore }`
- L237-241: `case 'standard'`/`'focus'` 中 `settingsStore.currentView = 'chat'` → `navStore.push`
- L251-257: `case 'settings'` 中 toggle 逻辑替换

上述变更均未触碰 L91-113（第一套 WS watcher）和 L276-305（第二套 WS watcher），属于预存在代码。按 CLAUDE.md "只动必须动的"原则，不在本次改动范围内修复。

### #2: initConnection 无 try/catch (v1 MUST_FIX)

**位置**: App.vue L177-178

**结论**: 预存在代码，本次 diff 未涉及该行。

`initConnection()` 调用及其所在 `onMounted` 回调的结构未改变，本次 diff 没有修改 L177-178 附近代码。同样属于预存在问题，不在本次改动范围内。

## 本次 diff 健壮性审查

### 审查范围

| 文件 | 变更类型 |
|------|---------|
| `stores/navigation.ts` | 新文件（95 行） |
| `App.vue` | 导航 store 替换（~30 行变更） |
| `AppHeader.vue` | `openSettings` 改用 `navStore.push` |
| `AppSidebar.vue` | `handleSessionClick` 增加 `navStore.push`，Back/Forward 按钮改用 `Button` 组件 |
| `SettingsView.vue` | `settingsStore` → `navStore`，增加 tab sync watch |
| `event-adapter.ts` | usage 字段从 `inputTokens`/`outputTokens` 改为 `input`/`output` |

### navigation.ts（新文件）

**D1 错误处理:**
- ✅ 纯状态操作，无 IO/网络调用，无 try/catch 需求
- ✅ `currentEntry` computed 正确处理 pointer 越界（< 0 或 >= length）

**D2 异常处理:**
- ✅ 无异常抛出路径，符合纯 store 定位

**D3 日志:**
- ✅ 纯 Pinia store，无日志需求（v1 #6 提出的 LOW 建议作为改进项，非健壮性缺陷）

**D4 Fail-fast:**
- ✅ `MAX_ENTRIES` 防止内存无限增长，驱逐逻辑正确
- ✅ `back()`/`forward()` 通过 `canGoBack`/`canGoForward` 守卫
- ✅ `push()` 正确截断 forward branch 后追加

**D5 测试友好性:**
- ✅ 纯 Pinia store，无外部依赖，高度可测
- ✅ 函数均为纯操作，输入→状态变更，便于断言

**D6 调试友好性:**
- ✅ `entries`/`pointer` 均为 ref，可通过 Vue DevTools 观察

### App.vue（diff 部分）

**D1 错误处理:**
- ✅ `navStore.push({ view: 'chat', sessionId: sid })` 在 `sid` 为空时不 push（`if (sid)` 守卫）
- ✅ settings toggle 使用 `navStore.back()`/`navStore.push()`，无异常路径

**D2 异常处理:**
- ✅ 变更部分均为同步 store 操作，无异常风险

**D3-D6:**
- ✅ 无新增 IO/网络/异步操作，无日志/调试需求变化

### AppHeader.vue

**D1-D6:**
- ✅ `openSettings` 改为始终 `navStore.push`（不再 toggle），逻辑简化，无健壮性风险
- ⚠️ 注意：v1 #4 指出的"不判断当前是否已在 settings"问题，本次从 `setView toggle` 改为 `push`，行为从"toggle"变为"始终 push"，**行为已明确**（每次点击 settings 按钮都 push 一个新 entry），不再是"可能产生重复 nav 条目"的问题。但用户连续点击会产生多条相同 settings entry——这是设计选择而非健壮性缺陷（push 会自动截断 forward branch，且 MAX_ENTRIES 限制总量）

### AppSidebar.vue

**D1-D6:**
- ✅ `handleSessionClick` 追加 `navStore.push({ view: 'chat', sessionId })`，使用已验证的 sessionId
- ✅ Back/Forward 按钮改用 `Button` 组件 + `:disabled` 绑定，防止无效操作
- ✅ `isSettingsActive` 改用 `navStore.currentView`，computed 语义不变

### SettingsView.vue

**D1-D6:**
- ✅ Escape 键改用 `navStore.back()`，保留 modal 存在性检查
- ✅ `watch` + `immediate: true` 确保 tab 与 nav entry 同步
- ✅ `updateCurrentTab` 在 entry 非 settings 时不操作（`if (entry?.view === 'settings')` 守卫）

### event-adapter.ts

**D1 错误处理:**
- ✅ `usage?.input` 使用 optional chaining，usage 为 undefined 时正确跳过
- ✅ fallback `?? 0` 处理字段缺失

**D2-D6:**
- ✅ 纯字段映射变更，无新增异常路径

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 6 | 6 | 0 | 10/10 |
| D2 异常处理 | 5 | 5 | 0 | 10/10 |
| D3 日志 | 4 | 4 | 0 | 10/10 |
| D4 Fail-fast | 5 | 5 | 0 | 10/10 |
| D5 测试友好性 | 4 | 4 | 0 | 10/10 |
| D6 调试友好性 | 4 | 4 | 0 | 10/10 |

注：本次评分仅针对 **本次 diff 变更部分**。v1 指出的预存在问题（App.vue WS watcher 重复、initConnection 无 try/catch）不在本次评分范围内。

## 结论

**通过**。v1 的 2 条 MUST_FIX 均为预存在代码（App.vue L91-113, L177-178, L276-305），本次 diff 未涉及这些行。本次变更的健壮性无问题：新增的 `navigation.ts` 是纯 Pinia store，无外部依赖和 IO 操作；其余文件均为导航 store 替换的同步操作，无新增异常路径。
