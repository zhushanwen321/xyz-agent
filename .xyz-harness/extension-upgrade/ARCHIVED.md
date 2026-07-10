# Extension Upgrade - ARCHIVED

## 项目状态

**已完成** - 2026-07-09

## 沉淀去向

| 目标文档 | 内容 | 溯源 |
|---------|------|------|
| `TEST-STRATEGY.md` §8 | Extension Upgrade 回归基线（autoUpgradeOnStartup 时序 + 错误码语义 + 回归用例） | plan §U5/U6/U13c/U15 |
| `DESIGN-LOG.md` | 追加 extension-upgrade 行（2026-07-09） | closeout |
| `.xyz-harness/extension-upgrade/plan.md` | 功能设计文档（25 单测 + 6 E2E 设计） | plan |
| `.xyz-harness/extension-upgrade/changes/retrospect.md` | 复盘报告（5 个问题 + 教训） | retrospect |

## 功能摘要

为已安装的 user-installed 扩展提供：
1. **升级按钮**：点击从 npm registry 拉最新版重装
2. **自动升级 switch**：per-extension 开关，开启后 runtime 启动时静默升级
3. **启动时检查**：在 ensurePublicSession 之前执行，失败不阻塞启动

## 测试覆盖

- runtime 测试：57 个（U1-U22 + 现有测试）
- renderer 测试：5 个（E1-E5）
- 覆盖率：≥60%

## 关键文件

- runtime: extension-service.ts, npm-installer.ts, extension-message-handler.ts, index.ts
- shared: extension.ts, protocol.ts
- renderer: ExtensionPage.vue, api/domains/extension.ts, api/mock/index.ts
