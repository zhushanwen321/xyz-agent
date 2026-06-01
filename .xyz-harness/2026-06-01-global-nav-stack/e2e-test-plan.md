---
verdict: pass
---

# E2E Test Plan — global-nav-stack

## Test Scenarios

### Scenario 1: Basic Navigation Sequence (AC-1)

**覆盖:** AC-1

1. 应用启动 → 栈为空，UI 显示 Chat 默认状态
2. 点击侧边栏 session A → 切到 Chat(A)，◀ enabled, ▶ disabled
3. 点击 Settings 按钮 → 切到 Settings (providers tab)
4. 点击侧边栏 session B → 切到 Chat(B)
5. 点击 ◀ → 回到 Settings
6. 点击 ◀ → 回到 Chat(A)
7. 点击 ▶ → 回到 Settings
8. 点击 ▶ → 回到 Chat(B)

### Scenario 2: Truncation on Push (AC-2)

**覆盖:** AC-2

1. 建立 [Chat(A), Settings, Chat(B)] → pointer=1 (Settings)
2. 点击 session C → 栈变为 [Chat(A), Settings, Chat(C)] → pointer=2
3. ▶ disabled（Chat(C) 是末尾）

### Scenario 3: Settings Tab Restore (AC-3)

**覆盖:** AC-3

1. 点击 Settings → 进入 Providers tab
2. 切换到 Skills tab
3. 点击 session A → 回到 Chat
4. 点击 ◀ → 回到 Settings → 显示 Skills tab

### Scenario 4: Back Closes Settings (AC-4)

**覆盖:** AC-4

1. 栈: [Chat(A), Settings, Chat(B)] → pointer=2 (Chat(B))
2. 点击 Settings → [Chat(A), Settings, Chat(B), Settings] → pointer=3
3. 点击 ◀ → pointer=2, 回到 Chat(B)

### Scenario 5: Button State (AC-5)

**覆盖:** AC-5

1. 栈空 → ◀ disabled, ▶ disabled
2. push Chat(A) → ◀ disabled, ▶ disabled (pointer at end)
3. push Settings → ◀ enabled, ▶ disabled
4. back → ◀ disabled, ▶ enabled (pointer=0)

### Scenario 6: ESC Shortcut (AC-6)

**覆盖:** AC-6

1. 在 Settings 中按 ESC → 回到上一个视图（同 ◀）
2. 在 Chat 中按 ESC → 无效果（不干扰已有逻辑）
3. 在 Settings 中有 modal 打开时按 ESC → modal 关闭，不触发 back

### Scenario 7: Cmd+, Global Shortcut (FR-4)

**覆盖:** FR-4

1. 在 Chat 视图按 Cmd+, → push Settings, 切到 Settings
2. 在 Settings 视图按 Cmd+, → back(), 回到 Chat（通过 App.vue IPC toggle）

### Scenario 8: Capacity Limit (C-4)

**覆盖:** C-4

1. 连续 push 51 个 entry → 最旧的被丢弃
2. pointer 值正确（减 1）
3. canGoBack/canGoForward 计算正确

### Scenario 9: Panel Integrity (FR-5)

**覆盖:** FR-5

1. 导航栈操作不影响 panel tree 结构
2. 多次 push 同一 session → panel 绑定不变
3. back/forward 不触发 panel tree 重建

## Test Environment

- **运行方式:** `npm run dev` 启动 Electron 开发模式
- **测试类型:** 手动 UI 验证（无自动化 E2E 框架）
- **验证重点:** 视图切换、按钮状态、快捷键行为、tab 恢复
- **前置条件:** 至少存在 2 个 session（A 和 B）
