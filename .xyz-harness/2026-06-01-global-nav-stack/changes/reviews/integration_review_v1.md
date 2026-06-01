---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 6
  boundaries_checked: 8
  issues_found: 3
  must_fix_count: 0
  low_count: 2
  info_count: 1
  duration_estimate: "20"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-01 23:30
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：8
- 模拟数据验证路径数：6

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|---------|--------|------------|------------|------------|----------|------|
| UC-1 | AppSidebar → NavigationStore (push ChatEntry) | ✅ | ✅ | ✅ | — | — |
| UC-1 | App.vue toggle → NavigationStore (push/back SettingsEntry) | ✅ | ✅ | ✅ | — | — |
| UC-1 | NavigationStore → App.vue (currentView computed) | ✅ | ✅ | ✅ | — | — |
| UC-1 | NavigationStore → SettingsView (currentEntry watch) | ✅ | ✅ | ✅ | — | — |
| UC-2 | SettingsView → NavigationStore (updateCurrentTab) | ✅ | ✅ | ✅ | — | — |
| UC-2 | SettingsView ESC → NavigationStore (back) | ✅ | ✅ | ✅ | — | — |
| UC-3 | AppHeader → NavigationStore (push) | ✅ | ✅ | ⚠️ | — | push-only 非 toggle |
| — | NavigationStore ↔ SettingsStore | ✅ | ✅ | ✅ | — | 无交叉引用 |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | LOW | UC-1 | AppHeader → NavigationStore | D3 | openSettings() 始终 push，不 toggle。用户在 Settings 页点击 Header 齿轮按钮会产生重复 Settings 条目，需多次 back 才能返回 | AppHeader.vue | 100-102 | 改为与 sidebar 一致的 toggle 逻辑：`navStore.currentView === 'settings' ? navStore.back() : navStore.push(...)` |
| 2 | LOW | — | NavigationStore 内部 | D3 | 容量淘汰时行 45 `pointer.value -= 1` 是死代码，被行 48 `pointer.value = entries.value.length - 1` 覆盖 | navigation.ts | 45 | 移除冗余行 |
| 3 | INFO | UC-3 | NavigationStore → PanelStore | D1 | ChatEntry.sessionId 写入但 back/forward 时未消费恢复面板 session。当前导航仅做视图级切换（Settings ↔ Chat），不恢复具体 panel 内容。FR-5 明确 Panel 行为不变，因此不算缺陷，但 sessionId 字段目前无读取方 | navigation.ts:6, AppSidebar.vue:65 | — | 如未来需要 session 级导航恢复，需在 App.vue 添加 currentEntry watcher 调用 panelStore |

## BLR MUST_FIX #1 验证：已修复

BLR 报告的核心问题——"Settings 为栈唯一条目时 toggle/ESC/◀ 全部失效"——在当前代码中**已修复**：

1. **`canGoBack`** 从 `pointer > 0` 改为 `pointer >= 0`（navigation.ts:32），使 pointer=0 时 back 按钮可点击
2. **`back()`** 新增 `else if (pointer.value === 0)` 分支（navigation.ts:54-58），pop 最后一个条目，重置为空栈默认视图

用 BLR PATH-02 模拟数据验证：

```
entries=[Settings(providers)], pointer=0
→ canGoBack = 0 >= 0 = true ✅ (按钮可点击)
→ back(): pointer > 0? No. pointer === 0? Yes → entries=[], pointer=-1
→ currentView = currentEntry?.view ?? 'chat' = 'chat' ✅
→ SettingsView unmount ✅

Cmd+, toggle (App.vue:251-254):
→ currentView='settings' → navStore.back() → 同上，清空栈 → currentView='chat' ✅

ESC (SettingsView.vue:26):
→ navStore.back() → 同上 ✅

Sidebar toggle (App.vue:7):
→ currentView='settings' → navStore.back() → 同上 ✅
```

**结论：所有 4 种关闭路径在栈只有 1 个条目时均正常工作。MUST_FIX #1 已解决。**

## 模拟数据验证详情

### PATH-01: 正常 Chat→Settings→Chat 导航

**边界：AppSidebar → NavigationStore (push) → App.vue (currentView)**

- 模拟数据：`{ view: 'chat', sessionId: 'sess-alpha-001' }`
- 调用方构造：`navStore.push({ view: 'chat', sessionId: 'sess-alpha-001' })`
- 被调用方签名：`push(entry: NavEntry)` → ChatEntry `{ view: 'chat', sessionId: string }`
- 结论：字段名和类型完全匹配 ✅

**边界：NavigationStore → App.vue (currentView)**

- push 后：entries=[Chat(a)], pointer=0 → currentView='chat'
- App.vue v-if：`navStore.currentView === 'settings'` → false → 显示 PanelTreeRenderer ✅

### PATH-02: Settings 唯一条目 toggle（已验证，见上文）

### PATH-03: 多 tab 切换后导航恢复

**边界：NavigationStore → SettingsView (currentEntry watch)**

- 模拟数据：back() 到 Settings(skills)
- currentEntry = `{ view: 'settings', activeTab: 'skills' }`
- SettingsView watch：`entry?.view === 'settings'` → true → `activeTab.value = 'skills'`
- 结论：tab 正确恢复 ✅

**边界：SettingsView → NavigationStore (updateCurrentTab)**

- 用户点击 System tab：`navStore.updateCurrentTab('system')`
- 被调用方逻辑：`entries.value[pointer.value] = { view: 'settings', activeTab: 'system' }`
- entries 原地替换，Vue reactivity 检测到变更 ✅

### PATH-04: 截断行为

**边界：NavigationStore.push 内部**

- 模拟数据：entries=[Chat(a), Settings(p), Chat(b)], pointer=1, push Chat(c)
- splice(2) → [Chat(a), Settings(p)] → push → [Chat(a), Settings(p), Chat(c)], pointer=2
- 结论：截断后 push，pointer 指向新条目 ✅

### PATH-05: 完整双向导航

**边界：AppSidebar back/forward 按钮 → NavigationStore**

- 所有 navigation_sequence 步骤推演通过
- canGoBack/canGoForward 与 disabled 绑定一致 ✅

### PATH-06: 容量淘汰

**边界：NavigationStore.push 内部**

- length=50 → push → length=51 → shift() → length=50
- pointer 最终 = 49（行 48 覆盖行 45）
- 结论：淘汰正确 ✅

## 关键隔离验证

### NavigationStore ↔ SettingsStore

| 检查项 | 结果 |
|--------|------|
| settingsStore 是否包含 currentView | ❌ 已移除 ✅ |
| navigation.ts 是否 import settingsStore | ❌ 无 import ✅ |
| 交叉引用 | 无 ✅ |

### NavigationStore ↔ PanelStore

| 检查项 | 结果 |
|--------|------|
| navigation.ts 是否 import panelStore | ❌ 无 import ✅ |
| NavigationStore 是否修改 panel 状态 | ❌ 不修改 ✅ |
| NavigationStore 是否读取 panel 状态 | ❌ 仅 App.vue 协调层读取 `panelStore.focusedPanel?.sessionId` |

协调层（非 store 间直接依赖）：
- `AppSidebar.handleSessionClick`：独立调用 `panelStore.openSessionSmart()` + `navStore.push()`
- `App.vue` shortcut handler：读取 `panelStore.focusedPanel?.sessionId` 用于 push 参数
- 两者均在组件层协调，store 间无直接耦合 ✅

## 结论

**Verdict: PASS** — 所有模块边界数据流正确，BLR MUST_FIX #1 已在当前代码中修复。

3 条遗留问题均为 LOW/INFO 级别，不影响功能正确性：
- AppHeader push-only 行为（UX 不一致，但不阻塞用户）
- 死代码（无功能影响）
- sessionId 未消费（设计决策，FR-5 明确 Panel 行为不变）
