---
verdict: pass
---

# Use Cases — statusline-design

## UC-1: 用户在 goal 模式下实时查看任务进度

**Actor:** 使用 xyz-agent 的开发者

**Preconditions:**
- xyz-agent 已启动，pi 进程运行中
- pi goal extension 已加载（pi 内置 extension）

**Main Flow:**
1. 用户在聊天输入框输入 `/goal` 命令
2. pi goal extension 启动，开始执行多轮任务循环
3. goal extension 调用 `ctx.ui.setStatus("goal", "◆ Goal 1/20")`
4. pi RPC 发出 `extension_ui_request { method: "setStatus", key: "goal", text: "◆ Goal 1/20" }`
5. sidecar event-adapter 翻译为 `plugin:statusSetUpdate` 消息
6. statusline plugin hook 捕获事件，查映射表得到 priority=10, scope=per-session
7. plugin 调用 `api.ui.updateStatusBarItem("goal", "◆ Goal 1/20", { priority: 10, scope: "per-session", sessionId })`
8. plugin-service 广播 `plugin:statusBarUpdate` 到前端
9. 前端 pluginStore 收到 items，SessionStrip 按 sessionId 过滤显示 goal chip
10. goal 进度更新时重复步骤 3-9，chip 文本实时更新
11. goal 完成后 goal extension 调用 `setStatus("goal", undefined)`，chip 消失

**Alternative Paths:**
- 3a. goal extension 发出未知格式的 key → statusline plugin 使用默认 metadata (priority=100, scope=global) → chip 出现在 Global Statusbar

**Postconditions:**
- SessionStrip 显示当前 session 的 goal 进度 chip
- Global Statusbar 不显示 per-session 数据

**Module Boundaries:**
- pi goal extension → event-adapter → server → plugin-service → statusline plugin → WS → plugin store → SessionStrip.vue
- 涉及 Task 1, 2, 3, 4, 5, 6, 8

**AC Coverage:** AC-1 (setStatus→frontend), AC-3 (Session Strip), AC-5 (scope routing)

---

## UC-2: 用户在 split panel 时区分不同 session 状态

**Actor:** 使用分屏功能的开发者

**Preconditions:**
- xyz-agent 窗口处于分屏模式（两个 panel）
- Panel A 绑定 Session A（正在执行 goal 任务）
- Panel B 绑定 Session B（自由对话）

**Main Flow:**
1. goal extension 在 Session A 中调用 `ctx.ui.setStatus("goal", "◆ Goal 3/20 | 2/5")`
2. 数据流经 event-adapter → statusline plugin → plugin:statusBarUpdate 到达前端
3. 前端 pluginStore 收到带 scope=per-session, sessionId=A 的 item
4. Panel A 的 SessionStrip: `getSessionStatusBarItems(A)` 匹配 → 显示 goal chip
5. Panel B 的 SessionStrip: `getSessionStatusBarItems(B)` 不匹配 → 不显示 goal chip
6. Global Statusbar 仅显示 scope=global 的 items → 不显示 goal chip

**Alternative Paths:**
- 1a. 两个 session 同时有各自的 goal → 各自的 chip 独立显示在各自 panel
- 1b. todo extension 在 Session B 也调用 setStatus → Panel B 显示 todo chip，Panel A 不显示

**Postconditions:**
- 每个 panel 独立显示各自 session 的 extension status
- Global Statusbar 不被 per-session 数据污染

**Module Boundaries:**
- plugin store (getSessionStatusBarItems) → SessionStrip.vue
- 涉及 Task 6, 8

**AC Coverage:** AC-3 (Session Strip per-session), AC-5 (信息不重复)

---

## UC-3: 用户切换模型和思考级别

**Actor:** 使用 xyz-agent 的开发者

**Preconditions:**
- xyz-agent 已启动，当前 session 处于空闲状态（不在生成中）
- 可用模型列表包含 reasoning model（如 o3）和非 reasoning model（如 gpt-4o）

**Main Flow:**
1. 用户看到 Input Toolbar 显示当前模型（如 "gpt-4o @ openai"）
2. 当前 model 非 reasoning model → thinking level picker 隐藏
3. 用户点击 model picker → 展开下拉列表（显示所有可用模型）
4. 用户选择 "o3 @ openai"
5. 前端发送 `session.switchModel` 命令到 sidecar
6. sidecar 通过 pi RPC 切换模型
7. 切换成功 → model picker 更新为 "o3 @ openai"
8. o3 是 reasoning model → thinking level picker 出现
9. thinking level picker 读取 `o3.thinkingLevelMap` keys → 显示可选级别（如 low/medium/high）
10. 用户点击 "high" → 发送 `session.setThinkingLevel` 命令
11. 切换成功 → thinking level picker 显示 "high" 选中状态

**Alternative Paths:**
- 5a. pi RPC 切换失败 → model picker 恢复显示原模型 + toast 错误提示
- 8a. o3 的 thinkingLevelMap 为空 → thinking level picker 不显示（即使 model 标记为 reasoning）

**Postconditions:**
- Input Toolbar 显示新模型和可选的 thinking level
- 后续请求使用新模型和 thinking level

**Module Boundaries:**
- InputToolbar.vue → modelStore (models, thinkingLevelMap) → sidecar RPC
- 涉及 Task 7

**AC Coverage:** AC-2 (Input Toolbar 完整功能)

---

## UC-4: 插件开发者参考 statusline plugin 编写自己的 built-in plugin

**Actor:** xyz-agent 插件开发者

**Preconditions:**
- 开发者已阅读 `docs/plugin/built-in-plugin-guide.md`
- statusline plugin 源码在 `resources/plugins/statusline/` 可参考

**Main Flow:**
1. 开发者阅读指南中的 "Getting Started" 章节
2. 了解 manifest 结构（xyzAgent 字段、activationEvents、permissions）
3. 查看 statusline plugin 的 `package.json` 作为 manifest 示例
4. 了解 activate 函数签名和 api 对象的可用方法
5. 学习 hook 注册方式（api.hooks.onPiEvent）
6. 学习 statusBarUpdate API 使用（含 options 参数）
7. 开发者创建自己的 plugin 目录和文件
8. 开发者在 manifest 中声明正确的 permissions
9. 开发者注册 hooks 并在 handler 中调用 api 方法
10. 开发者测试 plugin 是否正常工作

**Alternative Paths:**
- 7a. 开发者需要 statusBarItem 功能但不了解 scope 路由 → 指南中 "Scope Routing" 章节解释
- 9a. 开发者 hook handler 抛出异常 → 指南中 "Error Handling" 章节说明最佳实践

**Postconditions:**
- 开发者成功创建并运行一个 built-in plugin
- plugin 能正确使用 statusBarUpdate API

**Module Boundaries:**
- built-in-plugin-guide.md → 开发者参考 statusline plugin 源码
- 涉及 Task 11

**AC Coverage:** AC-7 (Built-in Plugin 开发指南)

---

## UC ↔ AC 覆盖映射表

| UC | AC-1 | AC-2 | AC-3 | AC-4 | AC-5 | AC-6 | AC-7 | AC-8 |
|----|------|------|------|------|------|------|------|------|
| UC-1 | ✅ | — | ✅ | — | ✅ | — | — | — |
| UC-2 | — | — | ✅ | — | ✅ | — | — | — |
| UC-3 | — | ✅ | — | — | — | — | — | — |
| UC-4 | — | — | — | — | — | — | ✅ | — |

**未直接覆盖的 AC:**
- AC-4 (Global Statusbar 聚合) — UC-1/UC-2 部分覆盖（scope=global items 渲染），但无专门 UC。在 e2e-test-plan 中补充。
- AC-6 (statusBarUpdate 增强) — 被 UC-1 的步骤 7 隐含覆盖（options 参数），但无专门验证 UC。
- AC-8 (bridge:event 修复) — UC-1 依赖此修复，但未显式验证。在 e2e-test-plan 中补充。
