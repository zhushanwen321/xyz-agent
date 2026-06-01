---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 5
  issues_found: 4
  must_fix_count: 1
  low_count: 2
  info_count: 1
  duration_estimate: "25"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-06-01 22:00
- 审查模式：Dev（L1 + L2）
- 审查对象：use-cases.md + 源代码（navigation.ts, AppSidebar.vue, SettingsView.vue, App.vue, AppHeader.vue）
- 模拟数据路径数：6

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | Chat 中切换 Settings 配置后返回 | ⚠️ 部分 | handleSessionClick → push → SettingsView ESC → back | 边界条件：Settings 为栈根时 toggle/ESC 失效 |
| UC-2 | Settings 浏览多 tab 后回到之前的 Chat | ✅ 完整 | updateCurrentTab + watch currentEntry 恢复 | — |
| UC-3 | 跨多个 session 导航探索后回退 | ✅ 完整 | push/truncate/back/forward 完整覆盖 | — |

## FR/AC 覆盖矩阵

| 需求 | 覆盖状态 | 实现位置 | 备注 |
|------|---------|----------|------|
| FR-1 导航历史栈 | ✅ | navigation.ts:18-89 | push/back/forward + 截断 + 容量上限 |
| FR-2 Settings tab 保留 | ✅ | navigation.ts:60-65, SettingsView.vue:31-37 | updateCurrentTab + watch 恢复 |
| FR-3 侧边栏按钮映射 | ⚠️ | AppSidebar.vue:61-65, 93-96; App.vue:7 | Header Settings 按钮行为不一致 |
| FR-4 键盘快捷键 | ✅ | App.vue:250-255 (IPC), SettingsView.vue:20-28 (ESC) | Cmd+, 走 IPC |
| FR-5 Panel 行为不变 | ✅ | AppSidebar.vue:62-63 | openSessionSmart 在 push 前调用 |
| AC-1 基本导航序列 | ✅ | 全路径推演通过 | 见执行路径详情 |
| AC-2 截断行为 | ✅ | navigation.ts:37-39 | splice(pointer+1) 截断前向分支 |
| AC-3 Settings Tab 恢复 | ✅ | SettingsView.vue:31-37 | watch immediate:true 恢复 |
| AC-4 后退关闭 Settings | ✅ | App.vue:7 toggle handler | 正常路径通过 |
| AC-5 按钮状态 | ✅ | AppSidebar.vue:93,96 | canGoBack/canGoForward 绑定 disabled |
| AC-6 快捷键 ESC | ✅ | SettingsView.vue:20-28 | 检查 modal 后 back() |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-1 | Settings 作为栈唯一条目时 toggle/ESC/◀ 全部失效 | App.vue:7, SettingsView.vue:26, App.vue:252 | 行 7, 26, 252 | 当 back() 无法后退时（canGoBack=false），需要清空栈回到默认视图 |
| 2 | LOW | UC-1 | AppHeader Settings 按钮始终 push，与 sidebar toggle 行为不一致 | AppHeader.vue:100-102 | 行 100-102 | 统一为 toggle 逻辑，或明确区分两种按钮的语义 |
| 3 | LOW | — | navigation.ts 容量淘汰时 `pointer.value -= 1` 是死代码（被行 48 覆盖） | navigation.ts:45 | 行 45 | 移除冗余行或添加注释说明 |
| 4 | INFO | — | Spec FR-3 定义 Settings 按钮为 push，实现为 toggle（改进但偏离 spec） | App.vue:7 | 行 7 | 可接受偏离，建议更新 spec 描述为 toggle 语义 |

## 执行路径详情（Dev 模式）

### UC-1: 用户在 Chat 中切换到 Settings 配置后返回

**模拟数据（正常路径）：**
```json
{
  "uc_id": "UC-1",
  "scenario": "Chat → Settings → 返回 Chat",
  "input_data": {
    "session_id": "sess-alpha-001",
    "session_label": "Agent 对话",
    "settings_active_tab": "providers"
  }
}
```

**执行路径：**
```
App 启动 → entries=[], pointer=-1, currentView='chat'(默认)
→ PanelTreeRenderer 显示（空状态）

用户点击 session sess-alpha-001
→ AppSidebar.handleSessionClick("sess-alpha-001")
  → switchSession("sess-alpha-001")
  → panelStore.openSessionSmart("sess-alpha-001")
  → navStore.push({ view:'chat', sessionId:'sess-alpha-001' })
  → entries=[Chat(sess-alpha-001)], pointer=0
  → currentView='chat' ✅

用户点击 sidebar Settings 按钮
→ emit('toggle-settings')
→ App.vue handler: currentView='chat' !== 'settings'
  → navStore.push({ view:'settings', activeTab: navStore.getLastSettingsTab() })
    → getLastSettingsTab(): 无历史 Settings → return 'providers'
  → entries=[Chat(sess-alpha-001), Settings(providers)], pointer=1
  → currentView='settings' ✅
  → SettingsView mount → watch immediate: activeTab='providers' ✅

用户点击 session sess-alpha-001（从 Settings 回到 Chat）
→ handleSessionClick("sess-alpha-001")
  → navStore.push({ view:'chat', sessionId:'sess-alpha-001' })
  → entries=[Chat(a), Settings(p), Chat(a)], pointer=2
  → currentView='chat' ✅

用户点击 ◀
→ navStore.back() → canGoBack=true(2>0) → pointer=1
→ currentView='settings' ✅
→ SettingsView mount → activeTab='providers' 恢复 ✅

用户点击 ◀
→ navStore.back() → canGoBack=true(1>0) → pointer=0
→ currentView='chat', 显示 sess-alpha-001 ✅
```

**异常路径（Settings 为栈唯一条目 — MUST_FIX）：**
```json
{
  "uc_id": "UC-1-edge",
  "scenario": "应用启动后第一个操作是打开 Settings",
  "input_data": {
    "no_session_clicked": true,
    "first_action": "open_settings"
  }
}
```

```
App 启动 → entries=[], pointer=-1, currentView='chat'(默认)

用户按 Cmd+,（IPC shortcut）
→ App.vue case 'settings': currentView='chat' !== 'settings'
  → navStore.push({ view:'settings', activeTab:'providers' })
  → entries=[Settings(providers)], pointer=0
  → currentView='settings' ✅

用户按 Cmd+, 再次（期望关闭 Settings）
→ App.vue case 'settings': currentView='settings' === 'settings'
  → navStore.back() → canGoBack=false(0 > 0 = false) → **无操作**
  → **STUCK：用户仍在 Settings** ❌

用户按 ESC（期望关闭 Settings）
→ SettingsView.onKeydown → navStore.back()
→ canGoBack=false → **无操作** ❌

用户点击 ◀ → disabled=true → **不可点击** ❌

用户点击 sidebar Settings 按钮（期望关闭）
→ emit('toggle-settings') → currentView='settings' → navStore.back()
→ canGoBack=false → **无操作** ❌

唯一出路：点击 sidebar 中的 session → push Chat → 离开 Settings ✅
```

**问题 #1 分析**：所有 4 种关闭 Settings 的方式（Cmd+, toggle、ESC、◀ 按钮、sidebar toggle）在栈只有 1 个条目时全部失效。用户必须通过点击 session 列表中的会话才能退出。这违反了「toggle 应该 toggle」的基本交互契约。

**修复建议**：在 NavigationStore 增加 `closeCurrent()` 方法，或在 toggle/ESC handler 中增加 `canGoBack` 为 false 时的回退逻辑——清空栈回到默认视图（entries=[], pointer=-1）。

```typescript
// NavigationStore 新增
function closeCurrent(): void {
  if (entries.value.length > 0) {
    entries.value.splice(pointer.value)
    entries.value.splice(0, pointer.value) // 如果 pointer=0，清空全部
    pointer.value = entries.value.length - 1 // 无条目时为 -1
  }
}
```

或更简洁的方案：在 back() 中，当 pointer=0 时 pop 当前条目并重置 pointer=-1。

### UC-2: 用户在 Settings 中浏览多个 tab 后回到之前的 Chat

**模拟数据：**
```json
{
  "uc_id": "UC-2",
  "scenario": "Chat(A) → Settings → 切换 tab → Chat(B) → back → back",
  "input_data": {
    "session_a": "sess-work-001",
    "session_b": "sess-work-002",
    "tab_sequence": ["providers", "system", "skills"],
    "expected_final_tab": "skills"
  }
}
```

**执行路径：**
```
Chat(sess-work-001) → entries=[Chat(s1)], pointer=0

用户点击 Settings 按钮
→ push({ view:'settings', activeTab: getLastSettingsTab()='providers' })
→ entries=[Chat(s1), Settings(providers)], pointer=1
→ SettingsView mount → activeTab='providers' ✅

用户点击 System tab
→ SettingsView: activeTab='system'; navStore.updateCurrentTab('system')
→ entries=[Chat(s1), Settings(system)], pointer=1 ✅

用户点击 Skills tab
→ SettingsView: activeTab='skills'; navStore.updateCurrentTab('skills')
→ entries=[Chat(s1), Settings(skills)], pointer=1 ✅

用户点击 session sess-work-002
→ handleSessionClick("sess-work-002")
→ navStore.push({ view:'chat', sessionId:'sess-work-002' })
→ entries=[Chat(s1), Settings(skills), Chat(s2)], pointer=2
→ currentView='chat' ✅

用户点击 ◀
→ back() → pointer=1 → Settings(skills)
→ SettingsView mount → watch: entry.activeTab='skills' → activeTab='skills' ✅

用户点击 ◀
→ back() → pointer=0 → Chat(s1) ✅
```

**完整覆盖，无问题。**

### UC-3: 跨多个 session 导航探索后回退

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "多 session 来回导航",
  "input_data": {
    "sessions": ["sess-a", "sess-b", "sess-c"],
    "initial_pointer": 3
  }
}
```

**执行路径：**
```
push Chat(sess-a) → [Chat(a)], p=0
push Settings(providers) → [Chat(a), Settings(p)], p=1
push Chat(sess-b) → [Chat(a), Settings(p), Chat(b)], p=2
push Chat(sess-c) → [Chat(a), Settings(p), Chat(b), Chat(c)], p=3

back() → p=2, currentView='chat', Chat(b) ✅
back() → p=1, currentView='settings', Settings(providers) ✅
back() → p=0, currentView='chat', Chat(a) ✅, canGoBack=false, ◀ disabled ✅

forward() → p=1, Settings ✅
forward() → p=2, Chat(b) ✅
forward() → p=3, Chat(c) ✅, canGoForward=false, ▶ disabled ✅

异常路径 6a：在 p=2 时 push Settings
  → truncate splice(3) → [Chat(a), Settings(p), Chat(b)]
  → push Settings(providers) → [Chat(a), Settings(p), Chat(b), Settings(p)], p=3 ✅
```

**完整覆盖，无问题。**

### AC-2 截断行为验证

**模拟数据：**
```json
{
  "ac_id": "AC-2",
  "scenario": "pointer 在中间时 push 截断前向分支",
  "input_data": {
    "stack_before": ["Chat(a)", "Settings(p)", "Chat(b)"],
    "pointer": 1,
    "new_push": "Chat(c)"
  }
}
```

**执行路径：**
```
entries=[Chat(a), Settings(p), Chat(b)], pointer=1

push Chat(c):
  → pointer(1) >= 0 && pointer(1) < entries.length-1(2) → true
  → splice(2) → entries=[Chat(a), Settings(p)]
  → entries.push(Chat(c)) → entries=[Chat(a), Settings(p), Chat(c)]
  → length(3) ≤ 50, 无淘汰
  → pointer = 3-1 = 2 ✅

结果: [Chat(a), Settings(p), Chat(c)], p=2 ✅
```

### AC-5 按钮状态验证

**模拟数据：**
```json
{
  "ac_id": "AC-5",
  "scenario": "按钮 disabled 状态验证",
  "input_data": {
    "states": [
      { "pointer": 0, "length": 1, "expected_canGoBack": false, "expected_canGoForward": false },
      { "pointer": 0, "length": 3, "expected_canGoBack": false, "expected_canGoForward": true },
      { "pointer": 2, "length": 3, "expected_canGoBack": true, "expected_canGoForward": false },
      { "pointer": 1, "length": 3, "expected_canGoBack": true, "expected_canGoForward": true }
    ]
  }
}
```

**推演：**
```
canGoBack = pointer > 0
canGoForward = pointer < entries.length - 1

pointer=0, len=1: back=false(0>0=F), forward=false(0<0=F) ✅
pointer=0, len=3: back=false(0>0=F), forward=true(0<2=T) ✅
pointer=2, len=3: back=true(2>0=T), forward=false(2<2=F) ✅
pointer=1, len=3: back=true(1>0=T), forward=true(1<2=T) ✅
```

### 容量淘汰路径验证

**模拟数据：**
```json
{
  "scenario": "50 条目满栈后 push 触发淘汰",
  "input_data": {
    "stack_size": 50,
    "pointer_position": 49,
    "new_entry": "Chat(sess-new)"
  }
}
```

**执行路径：**
```
entries.length=50, pointer=49

push Chat(sess-new):
  → pointer(49) >= 0 && pointer(49) < 49 → false, 无截断
  → entries.push(Chat(sess-new)) → length=51
  → 51 > 50 → shift() → length=50
  → pointer -= 1 → pointer=48（被下一行覆盖）
  → pointer = 50-1 = 49 ✅

最终: 最旧条目被丢弃, pointer 指向新条目(末尾) ✅
注: 行 45 的 pointer-=1 是死代码，被行 48 覆盖。不影响正确性。
```

## 模拟业务数据汇总（供 Integration Review 使用）

```json
{
  "simulated_paths": [
    {
      "id": "PATH-01",
      "description": "正常 Chat→Settings→Chat 导航",
      "entries": [
        { "view": "chat", "sessionId": "sess-alpha-001" },
        { "view": "settings", "activeTab": "providers" },
        { "view": "chat", "sessionId": "sess-alpha-001" }
      ],
      "pointer_after": 2,
      "expected_view": "chat"
    },
    {
      "id": "PATH-02",
      "description": "Settings 唯一条目 toggle 失效",
      "entries": [
        { "view": "settings", "activeTab": "providers" }
      ],
      "pointer_after": 0,
      "expected_view": "settings",
      "known_issue": "MUST_FIX #1: back/toggle 不生效"
    },
    {
      "id": "PATH-03",
      "description": "多 tab 切换后导航恢复",
      "entries": [
        { "view": "chat", "sessionId": "sess-work-001" },
        { "view": "settings", "activeTab": "skills" },
        { "view": "chat", "sessionId": "sess-work-002" }
      ],
      "pointer_after": 2,
      "expected_view": "chat",
      "back_to_settings_tab": "skills"
    },
    {
      "id": "PATH-04",
      "description": "截断行为验证",
      "entries_before": [
        { "view": "chat", "sessionId": "sess-a" },
        { "view": "settings", "activeTab": "providers" },
        { "view": "chat", "sessionId": "sess-b" }
      ],
      "pointer_before": 1,
      "push_entry": { "view": "chat", "sessionId": "sess-c" },
      "entries_after": [
        { "view": "chat", "sessionId": "sess-a" },
        { "view": "settings", "activeTab": "providers" },
        { "view": "chat", "sessionId": "sess-c" }
      ],
      "pointer_after": 2
    },
    {
      "id": "PATH-05",
      "description": "完整双向导航（UC-3）",
      "entries": [
        { "view": "chat", "sessionId": "sess-a" },
        { "view": "settings", "activeTab": "providers" },
        { "view": "chat", "sessionId": "sess-b" },
        { "view": "chat", "sessionId": "sess-c" }
      ],
      "navigation_sequence": [
        { "action": "back", "expected_pointer": 2, "expected_view": "chat", "expected_session": "sess-b" },
        { "action": "back", "expected_pointer": 1, "expected_view": "settings" },
        { "action": "back", "expected_pointer": 0, "expected_view": "chat", "expected_session": "sess-a", "canGoBack": false },
        { "action": "forward", "expected_pointer": 1, "expected_view": "settings" },
        { "action": "forward", "expected_pointer": 2, "expected_view": "chat", "expected_session": "sess-b" },
        { "action": "forward", "expected_pointer": 3, "expected_view": "chat", "expected_session": "sess-c", "canGoForward": false }
      ]
    },
    {
      "id": "PATH-06",
      "description": "容量淘汰（50→51 条目）",
      "entries_count_before": 50,
      "pointer_before": 49,
      "push_entry": { "view": "chat", "sessionId": "sess-new" },
      "entries_count_after": 50,
      "pointer_after": 49,
      "oldest_evicted": true
    }
  ]
}
```

## 结论

**Verdict: FAIL** — 存在 1 条 MUST_FIX。

核心问题：当 Settings 为导航栈的唯一条目时（用户启动应用后第一个操作是打开 Settings），所有关闭机制（sidebar toggle、Cmd+, toggle、ESC、◀ 按钮）均因 `canGoBack=false` 而失效。用户必须通过点击 sidebar 中的 session 才能退出，违反了 toggle 应该 toggle 的基本交互契约。

修复方向：在 NavigationStore 的 `back()` 方法中，当 `pointer === 0` 时，pop 当前条目并将 pointer 设为 -1（回到空栈默认状态），而非仅检查 `pointer > 0`。或在 toggle handler 中增加 fallback 逻辑。

其余 3 条 FR 和 6 条 AC 均被代码完整覆盖，push/back/forward/截断/tab 恢复逻辑正确。
