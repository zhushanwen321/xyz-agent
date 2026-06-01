---
verdict: pass
---

# Non-Functional Design — global-nav-stack

## 1. 稳定性

导航栈替代 `settingsStore.currentView` 的 view 切换机制。原有机制是简单的 boolean toggle（chat ↔ settings），新机制是数组 + 指针。风险点在于指针越界（pointer < 0 或 pointer >= entries.length）。缓解方案：所有 computed（currentEntry, canGoBack, canGoForward）都有边界检查；back/forward 在边界时 no-op；push 操作在尾部截断后自动修正 pointer。NavigationStore 不修改 panelStore 或 sessionStore，影响面隔离在 view 层。

## 2. 数据一致性

NavigationStore 是纯内存状态，不持久化（C-5）。应用重启后栈为空，UI 回到默认 Chat 视图。不存在多窗口同步问题（OS-5: out of scope）。唯一的外部副作用是 `panelStore.openSessionSmart(sessionId)` 调用——在 push Chat entry 时执行，与现有 handleSessionClick 行为一致，不引入新的数据流。

## 3. 性能

栈上限 50 条（C-4），所有操作 O(1) 或 O(n) 其中 n ≤ 50。push 的 truncate 是 `splice(pointer+1)`，最坏情况截断 49 条——在 50 条上限内可忽略。reverse-iterate 查找 lastSettingsTab 最坏遍历 50 条。computed 属性（currentEntry, currentView）由 Vue reactivity 缓存，仅 entries/pointer 变化时重算。无性能瓶颈。

## 4. 业务安全

不适用。导航栈是纯 UI 状态管理，不涉及用户数据、权限、认证或外部输入处理。所有数据（sessionId, activeTab）来自应用内部状态，不接受外部输入。

## 5. 数据安全

不适用。NavigationStore 不读写文件系统、不访问网络、不持久化到磁盘（C-5）。sessionId 和 activeTab 都是应用内部标识符，不含敏感信息。
