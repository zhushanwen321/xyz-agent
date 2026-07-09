# Extension Upgrade - ARCHIVED

## 项目状态

**已完成** - 2026-07-09

## 沉淀去向

| 文档 | 路径 | 状态 |
|------|------|------|
| plan.md | .xyz-harness/extension-upgrade/plan.md | ✅ 已完成 |
| plan.json | .xyz-harness/extension-upgrade/plan.json | ✅ 已完成 |
| retrospect.md | .xyz-harness/extension-upgrade/changes/retrospect.md | ✅ 已完成 |
| closeout-report.md | .xyz-harness/extension-upgrade/closeout-report.md | ✅ 已完成 |

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
