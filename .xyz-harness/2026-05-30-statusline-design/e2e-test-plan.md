---
verdict: pass
---

# E2E Test Plan — statusline-design

## Test Scenarios

### Scenario 1: pi extension setStatus 端到端验证 (AC-1)
**目标:** 验证 pi goal extension 调用 setStatus 后，前端 SessionStrip 正确显示
**前置条件:** xyz-agent 运行，pi 进程启动，goal extension 加载
**步骤:**
1. 在聊天输入框输入 `/goal` 命令启动 goal 模式
2. 等待 pi 开始执行目标（goal extension 会调用 setStatus）
3. 检查 SessionStrip 是否显示 goal chip
4. 等待 goal 完成 1-2 个子任务
5. 检查 goal chip 文本是否更新
**预期结果:** SessionStrip 实时显示 goal 进度，文本随子任务完成而更新

### Scenario 2: split panel 隔离验证 (AC-3, AC-5)
**目标:** 验证 split panel 时各 panel 的 SessionStrip 独立显示
**前置条件:** xyz-agent 处于分屏模式，两个 panel 绑定不同 session
**步骤:**
1. Panel A 发送 `/goal` 启动 goal 任务
2. Panel B 保持自由对话
3. 检查 Panel A 的 SessionStrip 显示 goal chip
4. 检查 Panel B 的 SessionStrip 不显示 goal chip
5. 检查 Global Statusbar 不显示 per-session 的 goal chip
**预期结果:** goal chip 只出现在 Panel A 的 SessionStrip

### Scenario 3: Input Toolbar model picker 验证 (AC-2)
**目标:** 验证 model picker 切换模型功能
**前置条件:** xyz-agent 运行，有多个可用模型
**步骤:**
1. 检查 Input Toolbar 显示当前模型
2. 点击 model picker 展开下拉
3. 选择不同模型（如 o3）
4. 检查 Input Toolbar 更新为新模型名
5. 如果是 reasoning model，检查 thinking level picker 出现
6. 如果是非 reasoning model，检查 thinking level picker 隐藏
**预期结果:** 模型切换成功，thinking level picker 根据 reasoning 标志动态显隐

### Scenario 4: Global Statusbar 聚合验证 (AC-4)
**目标:** 验证 Global Statusbar 显示 scope=global 的 extension chips
**前置条件:** xyz-agent 运行，至少一个 global scope 的 extension 输出 setStatus
**步骤:**
1. 等待 pi 启动完成
2. 检查 Global Statusbar 左侧显示连接状态和 pi 版本
3. 触发某个 global scope 的 extension 输出（如 preset extension）
4. 检查 Global Statusbar 右侧显示对应 chip
5. 检查 chip 按 priority 排序
**预期结果:** Global Statusbar 正确聚合和排序 global extension chips

### Scenario 5: bridge:event 修复验证 (AC-8)
**目标:** 验证 bridge:event 接通后 pi 生命周期事件能触发 plugin hooks
**前置条件:** xyz-agent 运行，有 plugin 注册了 onPiEvent hook
**步骤:**
1. 启动一个新 session
2. 发送一条消息触发 pi agent 执行
3. 检查 sidecar 日志中 `handleBridgeEvent` 被调用
4. 检查 plugin hook handler 收到生命周期事件
**预期结果:** bridge:event 不再只是打日志，正确路由到 pluginService

### Scenario 6: statusBarUpdate 向后兼容验证 (AC-6)
**目标:** 验证现有 plugin 不传新参数时行为不变
**前置条件:** 有一个使用旧版 `updateStatusBarItem(id, text)` 的 plugin
**步骤:**
1. 旧版 plugin 调用 `api.ui.updateStatusBarItem("test", "Hello")`
2. 检查前端收到 plugin:statusBarUpdate
3. 检查 item 的 priority=100 (默认), scope='global' (默认)
**预期结果:** 向后兼容，不传新参数时使用默认值

## Test Environment

- **平台:** macOS + Electron (dev mode `npm run dev`)
- **pi 进程:** xyz-pi 0.75.5-xyz-0.1 (fork 版本，支持 leafId)
- **验证方式:**
  - 功能验证: 手动操作 + 视觉检查
  - 数据流验证: sidecar console 日志 + Chrome DevTools WebSocket 面板
  - 回归验证: `npm run lint` + `npm run typecheck` (如有)
- **测试数据:** 使用 pi 内置 goal/todo extension 的真实 setStatus 输出

## E2E → AC 映射

| E2E Scenario | AC 覆盖 |
|-------------|---------|
| Scenario 1 | AC-1 (setStatus→frontend) |
| Scenario 2 | AC-3, AC-5 (Session Strip + 信息不重复) |
| Scenario 3 | AC-2 (Input Toolbar) |
| Scenario 4 | AC-4 (Global Statusbar) |
| Scenario 5 | AC-8 (bridge:event) |
| Scenario 6 | AC-6 (statusBarUpdate 增强) |
