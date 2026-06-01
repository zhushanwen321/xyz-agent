---
verdict: pass
---

# Use Cases — global-nav-stack

## UC-1: 用户在 Chat 中切换到 Settings 配置后返回

- **Actor:** 用户
- **Preconditions:** 应用运行，至少一个 session 存在，用户在 Chat 视图中与 Agent 对话
- **Main Flow:**
  1. 用户点击侧边栏 Settings 按钮（或按 Cmd+,）
  2. 系统将当前 Chat 状态入栈，push Settings entry（activeTab = lastSettingsTab 或 'providers'）
  3. UI 切换到 Settings 视图，显示上次查看的 tab
  4. 用户完成配置后，点击侧边栏之前的 session
  5. 系统将 Settings 状态保留在栈中，push 新的 Chat entry
  6. UI 切换到 Chat 视图，session 恢复
  7. 用户按 ◀ → 回到 Settings（上次 tab 状态保留）
- **Alternative Paths:**
  - 4a. 用户按 ESC（无 modal）→ back() → 直接回到 Chat
  - 4b. 用户按 ◀ → back() → 回到 Settings
- **Postconditions:** Settings 和 Chat 的视图状态都被保留在历史栈中，用户可随时通过 ◀▶ 在两者间导航
- **Module Boundaries:** AppSidebar (Settings 按钮), App.vue (view switch), SettingsView (ESC), NavigationStore (push/back)
- **AC 覆盖:** AC-1, AC-4, AC-6

## UC-2: 用户在 Settings 中浏览多个 tab 后回到之前的 Chat

- **Actor:** 用户
- **Preconditions:** 用户在 Chat(A) 中工作，需要查看 Settings 信息
- **Main Flow:**
  1. 用户从 Chat(A) 打开 Settings
  2. Settings 以 Providers tab 打开（首次）或上次 tab 恢复
  3. 用户切换到 System tab 查看 system prompt
  4. 用户切换到 Skills tab 查看 skill 列表
  5. 用户点击侧边栏 session B
  6. 系统更新当前 Settings entry 的 activeTab 为 'skills'，push Chat(B)
  7. 用户按两次 ◀ → 回到 Settings (skills tab) → 回到 Chat(A)
- **Alternative Paths:**
  - 5a. 用户按 Cmd+, → toggle back → 回到 Chat(A)
- **Postconditions:** Settings 的 activeTab 为 'skills'，Chat(A) 上下文保留
- **Module Boundaries:** SettingsView (tab sync), NavigationStore (updateCurrentTab), AppSidebar (session click)
- **AC 覆盖:** AC-1, AC-3

## UC-3: 用户跨多个 session 导航探索后回退

- **Actor:** 用户
- **Preconditions:** 存在 3 个以上 session（A, B, C）
- **Main Flow:**
  1. 用户从 Chat(A) 开始
  2. 打开 Settings → push Settings
  3. 点击 session B → push Chat(B)
  4. 点击 session C → push Chat(C)
  5. 栈: [Chat(A), Settings, Chat(B), Chat(C)] pointer=3
  6. 按 ◀ → Chat(B) pointer=2
  7. 按 ◀ → Settings pointer=1
  8. 按 ◀ → Chat(A) pointer=0, ◀ disabled
  9. 按 ▶ → Settings pointer=1
  10. 按 ▶ → Chat(B) pointer=2
  11. 按 ▶ → Chat(C) pointer=3, ▶ disabled
- **Alternative Paths:**
  - 6a. 在 pointer=2 时 push Settings → 截断 Chat(C)，栈变为 [Chat(A), Settings, Chat(B), Settings]
- **Postconditions:** 历史双向完整可导航，无状态丢失
- **Module Boundaries:** NavigationStore (push/back/forward/truncate), AppSidebar (◀▶ buttons)
- **AC 覆盖:** AC-1, AC-2, AC-5

## UC 覆盖映射表

| UC | AC-1 | AC-2 | AC-3 | AC-4 | AC-5 | AC-6 |
|----|------|------|------|------|------|------|
| UC-1 | ✅ | — | — | ✅ | — | ✅ |
| UC-2 | ✅ | — | ✅ | — | — | — |
| UC-3 | ✅ | ✅ | — | — | ✅ | — |

所有 6 个 AC 均被至少一个 UC 覆盖。
