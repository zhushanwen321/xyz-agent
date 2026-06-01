---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 7
  boundaries_checked: 9
  issues_found: 3
  must_fix_count: 0
  low_count: 2
  info_count: 1
  duration_estimate: "30"
---

# Integration Review v2

## 审查记录
- 审查时间：2026-06-01 19:10
- 上游 BLR: business_logic_review_v3.md
- 模块边界点数：9
- 模拟数据验证路径数：12（复用 BLR v3 全部路径）

## BLR v3 问题状态追踪

BLR v3 报告 4 条问题（1 MUST_FIX + 1 LOW + 2 INFO）。当前代码状态：

| BLR # | 严重度 | 描述 | 当前状态 |
|-------|--------|------|----------|
| 1 | MUST_FIX | AppHeader.openSettings() 丢失 toggle 行为 | **已修复** — AppHeader.vue:100-106 已包含完整 toggle 逻辑，与 App.vue:88-94 一致 |
| 2 | LOW | navigation.ts:45 死代码 `pointer -= 1` | **不存在** — 当前 navigation.ts push() 中无 `pointer.value -= 1` 语句，BLR 基于错误代码版本 |
| 3 | INFO | markdown.ts breaks:true 不属于导航功能 | 仍存在，与导航栈无关 |
| 4 | INFO | AppHeader title 缺少逗号 | 仍存在，`(Cmd+)` 未修正为 `(Cmd+,)` |

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|---------|--------|------------|------------|------------|----------|------|
| UC-1 | AppSidebar → navStore.push() | ✅ | ✅ | ✅ | — | — |
| UC-1 | App.vue → navStore (toggle) | ✅ | ✅ | ✅ | — | — |
| UC-1 | AppHeader → navStore (toggle) | ✅ | ✅ | ✅ | — | — |
| UC-1 | SettingsView → navStore (ESC) | ✅ | ✅ | ✅ | — | — |
| UC-1 | settingsStore.currentView 迁移 | ✅ | ✅ | ✅ | — | 无残留引用 |
| UC-2 | SettingsView ↔ navStore (tab sync) | ✅ | ✅ | ✅ | — | — |
| UC-3 | AppSidebar → navStore (back/forward) | ✅ | ✅ | ✅ | — | — |
| FR-5 | App.vue watcher → panelStore | ✅ | ✅ | ✅ | — | guard 防止重复调用 |
| FR-4 | IPC handler → navStore | ✅ | ✅ | ✅ | — | — |

## 问题清单

### D1 数据格式转换

无问题。所有 NavEntry 构造均匹配 ChatEntry / SettingsEntry 接口定义。

### D2 错误传播

无问题。所有 store 操作为同步 void 函数，无异常传播场景。

### D3 接口契约一致性

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | LOW | FR-4 | IPC handler → navStore | D3 | App.vue:260-261: `panelStore.focusedPanel?.sessionId ?? ''` 当 focusedPanel 无 session 绑定时，sid 为空字符串，`if (sid)` 跳过 push。结果：`panelStore.mergeToSingle()` 已执行（面板合并），但 navStore.currentView 仍为 'settings'，UI 状态不一致（面板已合并但仍在 Settings 页面）。实际场景极罕见（用户需先进入 Settings 再触发 focus/standard 快捷键，且当前无 panel 绑定 session） | `src-electron/renderer/src/App.vue` | 259-262 | 改为 `if (sid) navStore.push({ view: 'chat', sessionId: sid }); else if (navStore.currentView !== 'chat') navStore.reset()` 确保 currentView 始终回到 chat |
| 2 | LOW | UC-1 | AppHeader title | D3 | AppHeader.vue:35 settings 按钮的 title 属性为 `(Cmd+)`，缺少逗号。虽然不影响运行时行为，但与 AppSidebar.vue:88 的 `(Cmd+,)` 不一致，用户看到的 tooltip 信息不完整（BLR #4 遗留） | `src-electron/renderer/src/components/layout/AppHeader.vue` | 35 | 改为 `t('header.settings') + ' (Cmd+,)'` |

### D4 前后端上下游

不适用 — 本次变更仅涉及前端 store 重构和组件层，无 WS/API 跨进程边界。

## 模拟数据验证详情

### UC-1 路径 1：侧边栏 session 点击（从 Settings 回到 Chat）

**模拟数据：** `{"initial_session": "sess-algo", "settings_tab": "providers"}`

**边界点：AppSidebar → navStore.push()**
- 调用方构造：`{ view: 'chat', sessionId: 'sess-algo' }`
- 被调用方签名：`push(entry: NavEntry)` 其中 `ChatEntry = { view: 'chat', sessionId: string }`
- 字段名 ✅ 类型 ✅ 嵌套层级 ✅
- **结论：匹配**

**边界点：AppSidebar → panelStore.openSessionSmart()**
- 调用方传递：`openSessionSmart('sess-algo')`
- 被调用方签名：`openSessionSmart(sessionId: string): boolean`
- **结论：匹配**

### UC-1 路径 3（BLR 标记为 BUG）：Header 齿轮按钮 toggle

**模拟数据：** `{"session_id": "sess-algo"}`

**边界点：AppHeader → navStore (openSettings)**

```
栈: [Chat(sess-algo), Settings(providers)], pointer=1
1. 点击 Header 齿轮按钮
   → AppHeader:101: navStore.currentView === 'settings' → true
   → AppHeader:102: navStore.canGoBack → true (pointer=1 > 0)
   → navStore.back() → pointer=0
   → currentView='chat', SettingsView unmount
   ✅ 正确：toggle 行为与 App.vue toggleSettings() 一致
```

**结论：匹配** — BLR v3 MUST_FIX 已在当前代码中修复。

### UC-2 路径 1：Settings tab 记忆 + back 恢复

**模拟数据：** `{"sessions": ["sess-algo", "sess-web"], "tabs_visited": ["providers", "skills", "system"]}`

**边界点：SettingsView ↔ navStore (双向 tab sync)**

```
1. navStore.push Settings(providers) → 栈: [..., Settings(providers)]
2. 用户点击 Skills tab → SettingsView:61: activeTab='skills'; navStore.updateCurrentTab('skills')
   → navStore:70: entries[pointer] = { view:'settings', activeTab:'skills' }
   → 替换整个对象，Vue reactivity 检测到变化 ✅
3. 用户切到 Chat(sess-web) → back() → pointer 回到 Settings(skills)
   → SettingsView:32-34 watcher: entry.view==='settings' → activeTab='skills'
   ✅ tab 正确恢复
```

**结论：匹配** — 双向同步正确：本地 `activeTab` → `updateCurrentTab()` 写入 navStore，watcher 从 navStore 恢复 `activeTab`。

### UC-3 路径 2：AC-2 截断行为

**模拟数据：** `{"sessions": ["1", "2", "3", "new"]}`

**边界点：AppSidebar → navStore.push() 截断验证**

```
1. push C(1), C(2), C(3) → 栈: [C(1), C(2), C(3)], p=2
2. back() → p=1
3. push Settings(skills)
   → navStore:37-38: pointer(1) >= 0 && pointer(1) < entries.length-1(2) → true
   → splice(2) → 截断 [C(3)]
   → push → 栈: [C(1), C(2), Settings(skills)], p=2
   → canGoForward = (2 < 3-1=2) = false ✅
```

**结论：匹配** — 截断逻辑正确，forward 分支被清除。

### FR-5：Panel 焦点同步

**模拟数据：** `{"focused_panel_session": "sess-B", "target_session": "sess-A"}`

**边界点：App.vue watcher → panelStore.openSessionSmart()**

```
栈: [C(sess-A), C(sess-B)], p=1, panelStore.focusedPanel.sessionId='sess-B'
1. back() → p=0, currentEntry=C(sess-A)
2. App.vue:97-98 watcher source: navStore.currentEntry?.view === 'chat' → true
   → returns navStore.currentEntry.sessionId = 'sess-A'
3. App.vue:100-101 callback: sessionId='sess-A' (truthy)
   → panelStore.focusedPanel?.sessionId ('sess-B') !== 'sess-A' → true
   → panelStore.openSessionSmart('sess-A')
   ✅ panel 焦点同步

反验证：handleSessionClick 中的双重调用
1. AppSidebar:64: openSessionSmart('sess-X') → panel 焦点切到 sess-X
2. AppSidebar:65: navStore.push({ view:'chat', sessionId:'sess-X' })
3. watcher 触发: sessionId='sess-X'
4. guard: panelStore.focusedPanel?.sessionId === 'sess-X' → skip
✅ 无重复调用
```

**结论：匹配** — guard 机制正确防止了 handleSessionClick 中 openSessionSmart 的重复调用。

## settingsStore.currentView 迁移验证

| 检查项 | 结果 |
|--------|------|
| `settingsStore.currentView` 已从 settings.ts 移除 | ✅ ref 声明、setView 函数、return 均已删除 |
| 所有 `.vue` 和 `.ts` 文件中无残留引用 | ✅ grep 零匹配 |
| `navStore.currentView` 替代后接口类型一致 | ✅ computed<'chat' \| 'settings'> 与原 ref<'chat' \| 'settings'> 类型相同 |
| currentView 不在 settingsStore persist pick 列表中 | ✅ 原实现中 currentView 也未持久化，行为无变化 |
| vue-tsc --noEmit 编译通过 | ✅ 零错误 |

## 结论

**通过**。9 个模块边界点全部检查通过，0 条 MUST_FIX。

BLR v3 唯一的 MUST_FIX（AppHeader.openSettings() 丢失 toggle 行为）在当前代码中已修复。其余 2 条 LOW 为边缘场景（IPC handler 空 session 时的 currentView 不一致、tooltip 文字遗漏），不影响核心导航功能。

NavigationStore 与消费方（App/AppHeader/AppSidebar/SettingsView）的数据格式、接口契约、错误传播均正确。settingsStore.currentView → navStore.currentView 的迁移完整无残留。
