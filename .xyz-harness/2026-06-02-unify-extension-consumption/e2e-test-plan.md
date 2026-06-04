---
verdict: pass
---

# E2E Test Plan — 统一 Extension 消费架构

## Test Environment

- **运行环境:** xyz-agent 开发模式（`npm run dev`）
- **前置条件:**
  - `src-electron/package.json` 已添加 12 个 `@zhushanwen/pi-*` 依赖
  - `npm install` 已执行
  - `resources/pi/agent/extensions/goal|todo|workflow/` 已删除
  - ExtensionResolver 代码已部署
  - event-adapter.ts 已包含 setWidget/setStatus 桥接
- **测试工具:** 手动验证（E2E 需要 Electron + pi 子进程完整启动）

## Test Scenarios

### TS-1: Extension 加载无回归（AC-1）

**覆盖 AC:** AC-1

**步骤:**
1. 启动 xyz-agent（`npm run dev`）
2. 创建新 session
3. 在 chat 中输入 `/commands`
4. 验证以下 tools 出现在列表中：
   - `goal_manager`（含 create_tasks/list_tasks/update_tasks/complete_goal/cancel_goal/report_blocked）
   - `todo`（含 add/update/delete/list/clear）
5. 验证以下 commands 出现在列表中：
   - `/goal`
   - `/todos`
   - `/workflow`
6. 执行 `/goal` → 验证 goal_manager tool 被调用，行为与旧版一致
7. 执行 `/todos` → 验证 todo tool 被调用

**预期结果:** 所有 npm 版 extension 的 tools/commands 可用且行为正确。

### TS-2: 去重无冲突（AC-2）

**覆盖 AC:** AC-2

**步骤:**
1. 创建 `~/.xyz-agent/pi/agent/extensions/pi-goal/` 目录，放入一个简单的 index.ts（注册一个 dummy tool）
2. 启动 xyz-agent，创建 session
3. 在 chat 中输入 `/commands`
4. 检查 pi 注册的 tool 列表

**预期结果:** 只有 npm 版本的 `goal_manager` tool，dummy tool 不出现。

**清理:** 删除 `~/.xyz-agent/pi/agent/extensions/pi-goal/`

### TS-3: 第三方 Extension 依赖解析（AC-3）

**覆盖 AC:** AC-3

**步骤:**
1. 将一个依赖 `diff` 包的第三方 extension clone 到 `~/.xyz-agent/pi/agent/extensions/`
2. 启动 xyz-agent，创建 session
3. 验证 extension 加载成功（不报错），且依赖正确 resolve

**预期结果:** 第三方 extension 的 `import diff from 'diff'` 正确解析到 extension 同目录下的 `node_modules/diff`。

### TS-4: setWidget 数据到达前端（AC-4）

**覆盖 AC:** AC-4

**步骤:**
1. 启动 xyz-agent，创建 session
2. 在 chat 中输入 `/goal`，触发 goal extension
3. goal extension 调用 `ctx.ui.setWidget("goal", lines)`
4. 观察 ChatView 中是否出现 ExtensionWidgetPanel
5. 验证 panel 内容与 goal extension 传入的 lines 一致

**预期结果:** ExtensionWidgetPanel 显示 goal 任务列表。

### TS-5: setStatus 数据到达前端（AC-5）

**覆盖 AC:** AC-5

**步骤:**
1. 启动 xyz-agent，创建 session
2. 在 chat 中执行某个会触发 `ctx.ui.setStatus()` 的操作（如 usage-tracker extension 更新 last-activity）
3. 观察 ExtensionStatusBar 区域

**预期结果:** ExtensionStatusBar 显示对应 status 文本。

### TS-6: 打包产物包含 npm extension（AC-6）

**覆盖 AC:** AC-6

**步骤:**
1. 执行 `npm run build`（完整打包）
2. 检查产物中 `app.asar.unpacked/node_modules/@zhushanwen/` 目录
3. 验证 `pi-goal/dist/index.js` 等文件存在
4. 运行 `scripts/postbuild-validate.sh`

**预期结果:** 所有 pi-ext 包存在于打包产物的 unpacked 目录中。

### TS-7: bundled 副本已删除（AC-7）

**覆盖 AC:** AC-7

**步骤:**
1. `ls src-electron/resources/pi/agent/extensions/`
2. 验证 goal/、todo/、workflow/ 目录不存在

**预期结果:** 只有 hooks/、shared/、subagent/、usage-tracker/ 目录。

### TS-8: 现有 bundled 不受影响（AC-8）

**覆盖 AC:** AC-8

**步骤:**
1. 启动 xyz-agent，创建 session
2. 验证 subagent tool 可用
3. 验证 usage-tracker 的 last-activity status bar 更新
4. 验证 hooks extension 正常工作

**预期结果:** 所有保留的 bundled extension 功能正常。

## 测试优先级

| 优先级 | 场景 | 原因 |
|--------|------|------|
| P0 | TS-1（加载回归） | 核心功能，失败则整个需求不达标 |
| P0 | TS-6（打包产物） | 用户交付物，失败则无法发布 |
| P1 | TS-7（副本删除） | 确认迁移完成 |
| P1 | TS-8（bundled 不受影响） | 回归防护 |
| P1 | TS-4（setWidget） | 新功能核心价值 |
| P1 | TS-5（setStatus） | 新功能核心价值 |
| P2 | TS-2（去重） | 边界场景 |
| P2 | TS-3（第三方依赖） | 第三方支持 |
