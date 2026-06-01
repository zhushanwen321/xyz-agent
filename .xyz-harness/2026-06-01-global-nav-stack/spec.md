---
verdict: pass
---

# 全局导航历史栈 + Settings 面板整合

## Background

当前 xyz-agent 的 Settings 视图与 Chat 面板视图通过 `v-if` 互斥切换，由 `settingsStore.currentView` 控制。存在两个问题：

1. **Settings 无法被导航离开**：用户在 Settings 中时，点击侧边栏的 session 不会自动切回 Chat 模式，`openSessionSmart` 只操作被隐藏的 PanelTree
2. **前进/后退按钮空置**：侧边栏的 ◀ ▶ 按钮已渲染但无功能

底层原因是缺乏一个统一的导航层来管理「视图历史」。Settings 与 Chat 的切换是全局视图级别的切换，不应由 panel store 或 settings store 各自处理。

## Functional Requirements

### FR-1: 导航历史栈

系统维护一个全局导航历史栈，记录用户在所有视图之间的切换足迹。

- 历史栈中的每个条目（Entry）表达一个完整的视图状态
- Chat 条目记录 `{ view: 'chat', sessionId }`
- Settings 条目记录 `{ view: 'settings', activeTab }`
- 所有触发视图切换的操作都经过导航栈：点击 session、点击 settings 按钮、键盘快捷键
- 导航栈支持 back / forward / push 三种操作，行为与浏览器历史一致：
  - `push(entry)` — 若指针不在末尾，截断指针后的条目；追加新条目到末尾，移动指针到末尾
  - `back()` — 指针前移一位（若已在起点则无操作）
  - `forward()` — 指针后移一位（若已在末尾则无操作）

### FR-2: Settings 条目保留 tab 状态

- Settings 条目需要记录 `activeTab`，记录用户在 Settings 中最后查看的 tab（providers / skills / agents / system / plugins / extensions）
- 导航到 Settings 条目时，Settings 视图恢复到对应的 tab
- 用户在 Settings 中切换 tab 时，同步更新当前 entry 的 `activeTab`

### FR-3: 侧边栏按钮映射

- **Session 点击** → `push({ view: 'chat', sessionId })`
  - 同时执行 `panelStore.openSessionSmart(sessionId)` 绑定 panel
  - 即使用户当前在 Settings 中，也会 push chat 并切换到 Chat 视图
- **Settings 按钮** → `push({ view: 'settings', activeTab: lastTab })`
- **◀ 后退** → `back()`（Settings 开着时等同于关闭 Settings）
- **▶ 前进** → `forward()`
- 后退/前进按钮的 disabled 状态跟随 `canGoBack` / `canGoForward`

### FR-4: 键盘快捷键对齐

- **Cmd+, / Ctrl+,** — 同 settings 按钮行为：`push({ view: 'settings', activeTab })`
- **ESC（Settings 中）** — 同后退：`back()`
- ESC 只在 Settings 开启且无 modal 打开时生效（已有逻辑）

### FR-5: Panel 焦点同步

- 导航栈不修改 panel tree 的树结构、不修改 session 绑定逻辑
- 但当 `back()`/`forward()` 导致当前 chat entry 的 sessionId 变化时，必须通过 `panelStore.openSessionSmart(sessionId)` 同步 panel 焦点
- 同步机制：App.vue watcher 监听 `navStore.currentEntry.sessionId`，变化时调用 `openSessionSmart`
- 多条 chat 条目指向同一个 sessionId 是合法的（用户可在不同时刻反复聚焦同一个 session）
## Acceptance Criteria

### AC-1: 基本导航序列

```
前提: 栈为空，初始 Chat(A)
1. push Chat(A)                → 栈: [Chat(A)]            pointer=0, panel 焦点切换到 A
2. push Settings               → 栈: [Chat(A), Settings]  pointer=1
3. push Chat(B)（点 session B） → 栈: [Chat(A), Settings, Chat(B)]  pointer=2, panel 焦点切换到 B
4. back()                      → pointer=1, 显示 Settings，恢复上次 tab
5. back()                      → pointer=0, 显示 Chat(A), panel 焦点切换到 A
6. forward()                   → pointer=1, 显示 Settings
7. forward()                   → pointer=2, 显示 Chat(B), panel 焦点切换到 B
```

> 步骤 5, 7 中的 panel 焦点切换由 App.vue watcher 自动完成（FR-5）。

### AC-2: 截断行为

```
栈: [Chat(A), Settings, Chat(B)]
                   ↑ pointer=1 (当前在 Settings)
push Chat(C) → 截断 Chat(B)，追加 Chat(C)
               栈: [Chat(A), Settings, Chat(C)]
                                     ↑ pointer=2
```

### AC-3: Settings Tab 恢复

```
1. push Settings → 进入 Providers tab（默认）
2. 切换到 Skills tab
3. push Chat(A) → 回到 Chat
4. back() → 回到 Settings，显示 Skills tab（上次的 tab）
```

### AC-4: 后退关闭 Settings

```
栈: [Chat(A), Settings, Chat(B)]
                     ↑ pointer=2 (Chat(B))
# 用户打开 Settings
push Settings → 栈: [Chat(A), Settings, Chat(B), Settings]
                                                 ↑ pointer=3
back() → pointer=2, 回到 Chat(B)
```

### AC-5: 按钮状态

- 指针在起点（pointer=0）时 → ◀ disabled
- 指针在末尾（pointer=length-1）时 → ▶ disabled
- push 将指针移到新末尾，▶ 可能变为 disabled（如果之前前进过）

### AC-6: 快捷键 ESC

- Settings 中按 ESC → `back()`，同后退按钮
- Chat 中按 ESC → 无效果（不干扰 PanelBar 已有的 ESC 逻辑）

## Out of Scope

- **OS-1**: PanelTree 的树结构不修改。Settings 不成为 PanelTree 中的节点
- **OS-2**: Session binding 逻辑不修改。导航栈不改变某个 panel 绑定了哪个 session
- **OS-3**: 导航栈状态不持久化到磁盘。应用重启后重新建立
- **OS-4**: 不实现「后退到 settings 时恢复 session 滚动位置」等过度精细的状态快照
- **OS-5**: 不实现多窗口间导航栈同步
- **OS-6**: 不实现 tab 级别的导航（如 settings 内各 tab 之间的切换不在历史栈中记录）

## Constraints

- **C-1**: PanelStore 和 SessionStore 不修改。导航栈是纯上层管理，不侵入下层数据结构
- **C-2**: PanelTreeRenderer 不修改。Chat 视图的渲染逻辑不变
- **C-3**: `settingsStore.currentView` 可移除（不再需要），但保留其他字段
- **C-4**: 历史栈上限 50 条。超过时丢弃最旧的条目（保持指针相对位置）
- **C-5**: 导航栈的状态不需要持久化（应用关闭后不保留）——每次启动从当前 session 开始

## 业务用例

### UC-1: 用户日常工作流中切换 Settings 返回 Chat

- **Actor**: 用户
- **场景**: 用户在 Chat 中与 Agent 对话，想起要配置一个新的 Provider，打开 Settings 完成配置后想回到之前的对话
- **预期结果**: 用户点侧边栏的 session → Settings 消失，回到 Chat 继续对话。用户也可以按后退按钮回到 Chat

### UC-2: 用户浏览 Settings 后想回到之前的上下文

- **Actor**: 用户
- **场景**: 用户在 Chat(A) 中做了很多操作，打开 Settings 查看 system 信息，又切换到 Skills tab 查看 skill 列表，然后点 Chat(B) 去另一个 session 工作。按两次后退 → 回到 Settings（Skills tab）→ 回到 Chat(A)
- **预期结果**: Settings 的 tab 被记住，Chat(A) 的上下文被记住

### UC-3: 导航探索后回退

- **Actor**: 用户
- **场景**: 用户在 Chat(A) → Settings → Chat(B) → Chat(C) 之间切换，按后退逐步回到 Chat(B) → Settings → Chat(A)，再按前进逐步回到 Settings → Chat(B) → Chat(C)
- **预期结果**: 历史双向可导航，不丢失任何中间状态

## Complexity Assessment

```
改动量: 小（1 个新 store + 4 个文件修改）
复杂度: 低（纯前端状态管理，无后端/WS 改动）
风险:   低（不修改 panel tree、session、WS 通信等核心数据流）
测试:   单元测试覆盖 NavigationStore 的 push/back/forward 和截断逻辑
```

---

## Implementation Details to Confirm (Phase 1 补充)

以下 5 个细节是实现层面的歧义点，不影响架构设计，但 Plan 阶段前需敲定。每条提供推荐方案 + 备选。

### ID-1: `lastTab` 术语定义（FR-3）

**[AMBIGUOUS]** FR-3 中 `push({ view: 'settings', activeTab: lastTab })` 的 `lastTab` 含义未定义。

- 选项 A（推荐）：历史栈中最近一次 Settings entry 的 activeTab。若从未访问过 Settings，fallback 到 `'providers'`（默认 tab）。
- 选项 B：NavigationStore 单独维护一个 `lastSettingsTab` ref。简单但与 entry 字段重复。
- 选项 C：始终用当前 Settings 视图的 activeTab（如果是 Settings 状态）。但这与"后退到 Settings 时恢复 tab"语义冲突。

### ID-2: 连续相同 Chat 条目是否去重（FR-5）

**[AMBIGUOUS]** 多条 chat 条目指向同 sessionId "是合法的"（FR-5），但当前在 Chat(A) 再点 Chat(A) 是 push 还是 no-op？

- 选项 A（推荐）：允许连续重复。栈记录用户真实的点击轨迹，按钮 disabled 状态完全可预测。
- 选项 B：去重。当前 entry 与 push 的 sessionId 相同则 no-op。但与"后退回到上次同 session 状态"行为不同（指针不动 vs 回到 pointer-1）。

### ID-3: 应用启动时栈的初始化（AC-1 步骤 1）

**[AMBIGUOUS]** AC-1 说"前提: 栈为空，初始 Chat(A)"，第 1 步是 `push Chat(A)`，这两者矛盾。应用启动时栈的状态未定义。

- 选项 A（推荐）：启动时栈为空，UI 走默认逻辑（不显示 Chat 视图 / 显示空状态 / 跳到 default session）。NavigationStore 不自动 push 任何 entry。用户首次点击 session 才入栈。
- 选项 B：启动时若有 default session 则 push Chat(defaultSessionId)，否则栈为空。

### ID-4: 容量超限的 pointer 处理（C-4）

**[AMBIGUOUS]** C-4 说"超过时丢弃最旧的（保持指针相对位置）"——pointer 减 1 还是不变？

- 选项 A（推荐）：pointer 减 1。最旧条目被丢弃后，pointer 指向的逻辑位置不变。例：栈满 50 条，pointer=25，push 第 51 条 → 丢弃最旧，pointer 变成 24（指向原本的第 26 个 entry）。
- 选项 B：pointer 不变。同样例子里 pointer 仍为 25（指向原本的第 26 个 entry，丢弃后变成第 25 个）。实现更简单但与"相对位置"措辞不符。

### ID-5: push Settings 时的 activeTab 来源

**[AMBIGUOUS]** AC-4 中从 Chat(B) push Settings → 新 Settings entry 的 activeTab 是用：

- 选项 A（推荐）：最近一次 Settings entry 的 activeTab（即 ID-1 选项 A 的实现）。保证"后退到 Settings 时看到上次的 tab"。
- 选项 B：当前 Settings 视图的 activeTab（如果 Settings 已挂载）。但 Settings 在 Chat 时已 unmount，状态丢失，fallback 到 'providers'。

---

## Assumption Audit Summary (2026-06-01)

由 Phase 1 流程执行，对 spec 引用的代码事实逐一验证：

| 引用 | 文件:行 | 验证结果 |
|------|---------|----------|
| `settingsStore.currentView: 'chat' \| 'settings'` | renderer/stores/settings.ts:11 | [VERIFIED] |
| `settingsStore.setView(v)` | renderer/stores/settings.ts:48 | [VERIFIED] |
| settingsStore 不持久化 currentView | renderer/stores/settings.ts:54-60 (persist.pick) | [VERIFIED] |
| `panelStore.openSessionSmart(sessionId)` | renderer/stores/panel.ts:173-184 | [VERIFIED] |
| handleSessionClick 调用 openSessionSmart | renderer/components/layout/AppSidebar.vue:59-62 | [VERIFIED] |
| handleSessionClick **不**调用 setView('chat') | renderer/components/layout/AppSidebar.vue:59-62 | [VERIFIED] |
| 侧边栏 ◀▶ 按钮存在 | renderer/components/layout/AppSidebar.vue:90-95 | [VERIFIED] |
| ◀▶ 按钮无 @click / 无 disabled 绑定 | renderer/components/layout/AppSidebar.vue:90-95 | [VERIFIED] |
| Cmd+, 快捷键只在 Settings 视图内注册 | renderer/components/layout/SettingsView.vue:29-32, 35-40 | [VERIFIED] |
| ESC 快捷键逻辑：检查 modal 后 setView('chat') | renderer/components/layout/SettingsView.vue:20-28 | [VERIFIED] |
| SettingsView activeTab 是局部 ref（非 store） | renderer/components/layout/SettingsView.vue:9 | [VERIFIED] |
| Settings tab 列表：providers/skills/agents/system/plugins/extensions | renderer/components/layout/SettingsView.vue:11-18 | [VERIFIED] |
| AppHeader openSettings 切换 setView | renderer/components/layout/AppHeader.vue:94-95 | [VERIFIED] |
| App.vue 全局 IPC 快捷键（来自 Electron 主进程） | renderer/App.vue:231-249 | [VERIFIED] |
| App.vue handleKeydown 全局 Cmd+W / Cmd+D | renderer/App.vue:119-142, 252 | [VERIFIED] |

### 发现的额外问题（与本 spec 相关）

1. **AppHeader.vue:35 i18n 文案错写为 `(Cmd+)`**（应为 `(Cmd+,)`）—— 跟导航栈无关，属于附带可修 bug。
2. **Cmd+, 快捷键当前不在 Chat 视图下生效**（只在 SettingsView 内部注册）—— 本 spec 实施时需要把 Cmd+, 的全局快捷键上移到 App.vue 或 IPC 侧。
