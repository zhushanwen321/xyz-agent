# 自动升级验证流程

## 分层验证

| 层 | 验证目标 | 方式 | 状态 |
|---|---|---|---|
| L1 单元 | release-checker 三重过滤 / orchestrator 状态机 / download-asset 真实文件流 | vitest | ✅ |
| L1.5 集成 | bash 脚本真实执行 + sha256 决策树 + 回滚 | updater-script-integration.test.ts | ✅ |
| L2 半 E2E | dev + mock releaseChecker → UI 状态转换 + release note 渲染 | dev-mock-update-e2e.mjs | ✅ |
| L3 全链路 | 真实 release → 下载 → 替换 → 重启 | 手动，依赖多版本 | ⏸ 待 v0.8.15 发布后做 |

## L2 半 E2E 操作步骤

1. 启动 dev app（带 mock）：
   ```bash
   XYZ_DEV_MOCK_UPDATE=1 pnpm dev
   ```
2. 等 Electron 窗口起来（约 10s）
3. 另开终端跑：
   ```bash
   node scripts/dev-mock-update-e2e.mjs
   ```
4. 看脚本输出，应看到：
   - `[PASS] update-button visible (state=available)`
   - `[PASS] release notes 含 <h2>（markdown 标题已渲染）`
   - `[PASS] release notes 含 <code>（markdown 代码块已渲染）`
   - 截图保存到 `/tmp/dev-update-e2e-full.png` 与 `/tmp/dev-update-e2e-popover.png`
5. 手动验证：hover UpdateButton，肉眼看 release note 浮层（markdown 渲染）

## 触发机制说明

`useAppUpdate` 是 module-level 单例，外部脚本无法直接访问其 `checkForUpdate`。
脚本 `scripts/dev-mock-update-e2e.mjs` 按两条路径触发检测：

1. **手动触发（优先）**：若 dev app 在 `window` 上挂了 `__testTriggerUpdate` 钩子，
   直接调用，立即检测（mock 立即返回，无需等 30s）。
2. **降级等待自动触发**：未找到钩子时，等 35s 让 `Sidebar` 的 `initAutoCheck`
   （`AUTO_CHECK_DELAY_MS = 30_000`）自动跑一次。

若需在 dev app 中暴露钩子以加速验证，可在 `Sidebar.vue` setup 末尾加：
```ts
// dev-only 测试钩子（P2 半 E2E 用，prod 构建因 import.meta.env.DEV=false 被 tree-shake）
if (import.meta.env.DEV) {
  window.__testTriggerUpdate = () => useAppUpdate().checkForUpdate(true)
}
```

## 限制

- L2 **不验证真实替换**：dev 模式 `app.isPackaged=false`，`MacUpdater` 显式拒绝
  （即使点了 UpdateButton 也会落入 error 态——这是有意为之，P2 只验证「检测 → UI 显示」）。
- L3 需等下次正式 release（v0.8.15+），在旧版本上手动跑全链路（下载 → 替换 → 重启）。
- mock 的 `version: 999.999.999` 是「恒大于任何真实版本」的哨兵值，避免 compare-versions 误判。
