---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 7
  issues_found: 4
  must_fix_count: 1
  low_count: 1
  info_count: 2
  duration_estimate: "25"
---

# Dev Business Logic Review v3

## 审查记录
- 审查时间：2026-06-01 18:30
- 审查模式：Dev
- 审查对象：use-cases.md（spec 内嵌） + git diff + 源代码
- 模拟数据路径数：12

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 用户日常工作流中切换 Settings 返回 Chat | ⚠️ 部分 | 侧边栏 session 点击、ESC、侧边栏 toggle 均正确；**Header 齿轮按钮在 Settings 中点击会重复 push** | AppHeader.openSettings() 丢失 toggle 行为（MUST_FIX） |
| UC-2 | 用户浏览 Settings 后想回到之前的上下文 | ✅ 完整 | back() 恢复 Settings 时 activeTab 正确恢复 | — |
| UC-3 | 导航探索后回退 | ✅ 完整 | push/back/forward 全链路通畅，截断行为正确 | — |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|---------|------|------|------|---------|
| 1 | MUST_FIX | UC-1 | AppHeader.openSettings() 始终 push，丢失 toggle 行为。原始代码 `setView(currentView === 'settings' ? 'chat' : 'settings')` 是 toggle，改造后变为无条件 push。用户在 Settings 中点击 Header 齿轮按钮会产生重复 Settings 条目，而侧边栏 settings 按钮（App.vue:7）和 IPC handler（App.vue:261-265）都保留了 toggle 逻辑，三处行为不一致 | `src-electron/renderer/src/components/layout/AppHeader.vue` | 100-102 | 改为与 App.vue:7 一致的 toggle 逻辑：`if (navStore.currentView === 'settings') { if (navStore.canGoBack) { navStore.back() } else { navStore.reset() } } else { navStore.push({ view: 'settings', activeTab: navStore.getLastSettingsTab() }) }` |
| 2 | LOW | UC-3 | NavigationStore.push() 第 45 行 `pointer.value -= 1` 是死代码。容量超限执行 shift() 后 pointer 减 1，但第 48 行 `pointer.value = entries.value.length - 1` 立即覆盖。push 操作的语义是"移动到最新条目"，最终赋值本身正确，但中间的减法没有实际效果，误导读者以为有"保持相对位置"逻辑（spec ID-4） | `src-electron/renderer/src/stores/navigation.ts` | 45 | 删除第 45 行，或在注释中说明 push 语义下总是指向最新条目。如需实现 ID-4 选项 A（back 后再 push 容量超限时保持相对位置），需要重新设计 push 与 capacity eviction 的交互 |
| 3 | INFO | — | markdown.ts 变更（`breaks: true`）不属于导航栈功能范围。混入此 PR 增加审查噪音 | `src-electron/renderer/src/lib/markdown.ts` | 73, 82 | 将 markdown.ts 变更拆到独立 commit 或 revert |
| 4 | INFO | UC-1 | AppHeader.vue:35 title 属性仍为 `(Cmd+)`，缺少逗号。spec 审计已标记为附带 bug，此次变更未修复 | `src-electron/renderer/src/components/layout/AppHeader.vue` | 35 | 改为 `(Cmd+,)` |

## 执行路径详情（Dev 模式）

### UC-1: 用户日常工作流中切换 Settings 返回 Chat

**路径 1：侧边栏 session 点击（从 Settings 回到 Chat）**

**模拟数据：**
```json
{
  "uc_id": "UC-1",
  "scenario": "Settings 中点 session 回到 Chat",
  "input_data": {
    "initial_session": "sess-algo",
    "initial_label": "算法优化",
    "settings_tab": "providers"
  }
}
```

**执行路径：**
```
初始: 栈空, currentView='chat' (默认)
1. handleSessionClick('sess-algo')
   → AppSidebar:62-65: switchSession('sess-algo')
   → AppSidebar:63: panelStore.openSessionSmart('sess-algo')
   → AppSidebar:65: navStore.push({ view:'chat', sessionId:'sess-algo' })
   → 栈: [Chat(sess-algo)], pointer=0

2. 点击侧边栏 settings 按钮 → $emit('toggle-settings')
   → App.vue:7: navStore.currentView !== 'settings'
   → navStore.push({ view:'settings', activeTab:'providers' })
   → 栈: [Chat(sess-algo), Settings(providers)], pointer=1

3. 点击侧边栏 session 'sess-algo'
   → AppSidebar:62-65: switchSession + openSessionSmart + push
   → navStore.push({ view:'chat', sessionId:'sess-algo' })
   → 栈: [Chat(sess-algo), Settings(providers), Chat(sess-algo)], pointer=2
   → currentView='chat', SettingsView unmount
   ✅ 正确：Settings 消失，回到 Chat
```

**路径 2：后退按钮（从 Settings 回到 Chat）**

**模拟数据：**
```json
{
  "uc_id": "UC-1",
  "scenario": "Settings 中按 ◀ 回到 Chat",
  "input_data": {
    "session_id": "sess-algo"
  }
}
```

**执行路径：**
```
栈: [Chat(sess-algo), Settings(providers)], pointer=1
1. 点击 ◀ 按钮
   → AppSidebar:94: navStore.back()
   → navigation.ts:51-54: pointer.value = 1 → 0
   → currentView='chat', SettingsView unmount
   → App.vue:87-93 watcher: sessionId='sess-algo'
   → panelStore.focusedPanel.sessionId === 'sess-algo' → skip (guard)
   ✅ 正确：回到 Chat(sess-algo)
```

**路径 3（BUG）：Header 齿轮按钮在 Settings 中重复 push**

**模拟数据：**
```json
{
  "uc_id": "UC-1",
  "scenario": "Settings 中误点 Header 齿轮按钮",
  "input_data": {
    "session_id": "sess-algo"
  }
}
```

**执行路径：**
```
栈: [Chat(sess-algo), Settings(providers)], pointer=1
1. 点击 Header 齿轮按钮
   → AppHeader:100-102: openSettings()
   → navStore.push({ view:'settings', activeTab:'providers' })
   → 栈: [Chat(sess-algo), Settings(providers), Settings(providers)], pointer=2
   ❌ 用户在 Settings 中点设置按钮，期望 toggle 回 Chat，实际 push 重复 Settings
   → 需要按两次 back 才能回到 Chat，违反最小惊讶原则

对比侧边栏 toggle-settings（App.vue:7）：
  currentView === 'settings' → canGoBack ? back() : reset()
对比 IPC settings handler（App.vue:261-265）：
  currentView === 'settings' → canGoBack ? back() : reset()
两处都是 toggle，唯独 Header openSettings() 不是
```

---

### UC-2: 用户浏览 Settings 后想回到之前的上下文

**路径 1：完整 tab 记忆流程**

**模拟数据：**
```json
{
  "uc_id": "UC-2",
  "scenario": "Settings tab 记忆 + back 恢复",
  "input_data": {
    "sessions": ["sess-algo", "sess-web"],
    "tabs_visited": ["providers", "skills", "system"]
  }
}
```

**执行路径：**
```
1. push Chat(sess-algo) → 栈: [Chat(sess-algo)], pointer=0
2. 侧边栏 toggle-settings → push Settings(providers) → 栈: [Chat(sess-algo), Settings(providers)], pointer=1
3. SettingsView:61 用户点击 Skills tab
   → activeTab.value = 'skills'
   → navStore.updateCurrentTab('skills')
   → navigation.ts:68-72: entries[1] = { view:'settings', activeTab:'skills' }
   → 栈: [Chat(sess-algo), Settings(skills)], pointer=1
4. handleSessionClick('sess-web')
   → push Chat(sess-web)
   → 栈: [Chat(sess-algo), Settings(skills), Chat(sess-web)], pointer=2
   → currentView='chat', SettingsView unmount

5. back()
   → pointer=1, currentEntry = Settings(skills)
   → currentView='settings', SettingsView mount
   → SettingsView:31-36 watcher(immediate): entry.view==='settings' → activeTab='skills'
   ✅ 正确：Skills tab 恢复

6. back()
   → pointer=0, currentEntry = Chat(sess-algo)
   → currentView='chat'
   → App.vue:87-93 watcher: sessionId='sess-algo'
   → panelStore.openSessionSmart('sess-algo')
   ✅ 正确：Chat(sess-algo) 恢复，panel 焦点同步
```

**异常路径：getLastSettingsTab 无历史时 fallback**

**模拟数据：**
```json
{
  "uc_id": "UC-2",
  "scenario": "从未访问过 Settings 时 push",
  "input_data": {}
}
```

**执行路径：**
```
1. 栈空, currentView='chat'
2. Header openSettings()
   → getLastSettingsTab()
   → navigation.ts:75-82: for 循环遍历 entries, 无 settings entry
   → return 'providers'
   → push Settings(providers)
   ✅ 正确：fallback 到默认 tab
```

---

### UC-3: 导航探索后回退

**路径 1：完整 forward/back 链路**

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "多步前进后退全链路",
  "input_data": {
    "sessions": ["sess-A", "sess-B", "sess-C"]
  }
}
```

**执行路径：**
```
1. push Chat(sess-A)       → 栈: [C(A)], p=0
2. push Settings(providers) → 栈: [C(A), S(prov)], p=1
3. push Chat(sess-B)       → 栈: [C(A), S(prov), C(B)], p=2
4. push Chat(sess-C)       → 栈: [C(A), S(prov), C(B), C(C)], p=3

5. back() → p=2, C(B)
   → App.vue watcher: sessionId='sess-B' → openSessionSmart('sess-B') ✅

6. back() → p=1, S(prov)
   → currentView='settings', SettingsView mount
   → watcher: activeTab='providers' ✅

7. back() → p=0, C(A)
   → App.vue watcher: sessionId='sess-A' → openSessionSmart('sess-A') ✅

8. forward() → p=1, S(prov) ✅
9. forward() → p=2, C(B) ✅
10. forward() → p=3, C(C) ✅
```

**异常路径：AC-2 截断行为**

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "back 后 push 截断前向分支",
  "input_data": {
    "sessions": ["1", "2", "3", "new"]
  }
}
```

**执行路径：**
```
1. push C(1), push C(2), push C(3) → 栈: [C(1), C(2), C(3)], p=2
2. back() → p=1
3. push Settings(skills)
   → navigation.ts:37-38: splice(2) → 截断 C(3)
   → push → 栈: [C(1), C(2), S(skills)], p=2
   → canGoForward = false (2 < 3-1 = false) ✅
4. back() → p=1, C(2) ✅
5. forward() → p=2, S(skills) ✅
6. forward() → canGoForward=false, no-op ✅
```

**异常路径：C-4 容量超限 50 条**

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "push 51 条触发 eviction",
  "input_data": {
    "count": 51
  }
}
```

**执行路径：**
```
1. 循环 push({ view:'chat', sessionId:`s${i}` }) 51 次 (i=0..50)
2. 第 51 次 push (s50):
   → splice: no-op (pointer at end)
   → push: entries.length = 51
   → 51 > 50: shift() 移除 s0, entries.length=50
   → pointer -= 1 (死代码，立即被覆盖)
   → pointer = 50 - 1 = 49
3. 结果: entries=[s1..s50], pointer=49, currentEntry=s50
   ✅ 正确：最旧条目被驱逐，pointer 指向最新

注: navigation.ts:45 的 pointer.value -= 1 被第 48 行覆盖，是死代码。
但最终结果正确，因为 push 语义总是指向最新条目。
仅在"back 到中间位置后连续 push 到容量超限"的场景下，中间的减法才有理论意义，
但该场景下 splice 已截断前向分支，实际不可能触发。
```

### FR-5 验证：Panel 焦点同步

**模拟数据：**
```json
{
  "uc_id": "FR-5",
  "scenario": "back/forward 导致 sessionId 变化时 panel 焦点同步",
  "input_data": {
    "focused_panel_session": "sess-B",
    "target_session": "sess-A"
  }
}
```

**执行路径：**
```
栈: [C(sess-A), C(sess-B)], p=1, panelStore.focusedPanel.sessionId='sess-B'

1. back() → p=0, currentEntry=C(sess-A), sessionId='sess-A'
2. App.vue:87-93 watcher 触发:
   → computed 值从 'sess-B' 变为 'sess-A'
   → sessionId='sess-A' (truthy)
   → panelStore.focusedPanel.sessionId ('sess-B') !== 'sess-A' → true
   → panelStore.openSessionSmart('sess-A')
   ✅ 正确：panel 焦点同步到 sess-A

3. forward() → p=1, currentEntry=C(sess-B), sessionId='sess-B'
4. watcher 再次触发:
   → 'sess-A' → 'sess-B'
   → panelStore.focusedPanel.sessionId ('sess-A') !== 'sess-B' → true
   → panelStore.openSessionSmart('sess-B')
   ✅ 正确：panel 焦点同步回 sess-B
```

**边界：handleSessionClick 中的双重 openSessionSmart**

```
handleSessionClick('sess-X'):
1. AppSidebar:63: panelStore.openSessionSmart('sess-X') → panel 焦点切到 sess-X
2. AppSidebar:65: navStore.push({ view:'chat', sessionId:'sess-X' })
3. App.vue watcher 触发: sessionId='sess-X'
4. guard: panelStore.focusedPanel.sessionId === 'sess-X' → skip
✅ 无重复调用，guard 生效
```

### FR-4 验证：键盘快捷键

**ESC（Settings 中）：**
```
1. SettingsView 挂载了 keydown listener (SettingsView.vue:40)
2. e.key === 'Escape', 无 modal
3. SettingsView.vue:26: canGoBack ? back() : reset()
   → 与侧边栏 toggle 行为一致 ✅
```

**ESC（Chat 中）：**
```
1. SettingsView 未挂载（v-if=false）
2. ESC 不触发 navStore 操作 ✅
3. PanelBar 已有 ESC 逻辑不受影响 ✅
```

**Cmd+,（IPC 快捷键）：**
```
1. 主进程发送 'settings' action → App.vue:260-266
2. currentView === 'settings' → canGoBack ? back() : reset()
3. currentView !== 'settings' → push Settings
✅ toggle 行为正确

注: SettingsView 原有的 Cmd+, 本地 handler 已删除（diff 中移除），
现在完全依赖 IPC handler。如主进程未注册 Cmd+, 全局快捷键，则 Chat 中按 Cmd+, 无效。
但 spec 审计已确认 IPC handler 存在（App.vue:244 onShortcut），此依赖合理。
```

### AC-5 验证：按钮 disabled 状态

**模拟数据：**
```json
{
  "uc_id": "AC-5",
  "scenario": "pointer 在边界时的 disabled 状态"
}
```

**执行路径：**
```
空栈: canGoBack=false (pointer=-1, -1 > 0 false), canGoForward=false (-1 < -1 false)
  → ◀ ▶ 均 disabled ✅

[C(A)] p=0: canGoBack=false (0>0 false), canGoForward=false (0<0 false)
  → ◀ ▶ 均 disabled ✅

[C(A), S(prov)] p=1: canGoBack=true (1>0), canGoForward=false (1<1 false)
  → ◀ enabled, ▶ disabled ✅

[C(A), S(prov)] p=0 (back后): canGoBack=false, canGoForward=true (0<1)
  → ◀ disabled, ▶ enabled ✅
```

## 结论

**需修改**：UC-1 存在 1 条 MUST_FIX — AppHeader.openSettings() 丢失 toggle 行为，与侧边栏按钮和 IPC handler 行为不一致。用户在 Settings 中点击 Header 齿轮按钮会产生重复 Settings 条目。

其余 UC-2、UC-3 以及 FR-4/FR-5/AC-1~AC-6 的业务逻辑实现正确，NavigationStore 的 push/back/forward/reset/updateCurrentTab/getLastSettingsTab 覆盖完整，单元测试覆盖充分。
