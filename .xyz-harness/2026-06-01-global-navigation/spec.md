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

### FR-5: Panel 行为不变

- `panelStore.openSessionSmart` 的逻辑不受影响
- 导航栈不修改 panel tree 的树结构、不修改 session 绑定逻辑
- 多条 chat 条目指向同一个 sessionId 是合法的（用户可在不同时刻反复聚焦同一个 session）

## Acceptance Criteria

### AC-1: 基本导航序列

```
前提: 栈为空，初始 Chat(A)
1. push Chat(A)                → 栈: [Chat(A)]            pointer=0
2. push Settings               → 栈: [Chat(A), Settings]  pointer=1
3. push Chat(B)（点 session B） → 栈: [Chat(A), Settings, Chat(B)]  pointer=2
4. back()                      → pointer=1, 显示 Settings，恢复上次 tab
5. back()                      → pointer=0, 显示 Chat(A)
6. forward()                   → pointer=1, 显示 Settings
7. forward()                   → pointer=2, 显示 Chat(B)
```

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
