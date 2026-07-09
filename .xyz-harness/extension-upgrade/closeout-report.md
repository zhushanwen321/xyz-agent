# Extension Upgrade - Closeout Report

## 实现完成

- **功能**：已安装 user-installed 扩展的升级按钮 + per-extension 自动升级 switch
- **测试**：25 个 runtime extension-upgrade 测试 + 38 个 existing 测试 + 5 个 renderer 测试全部通过
- **代码质量**：ESLint / vue-tsc / Runtime Bundle 验证全部通过

## 沉淀去向

| 文档 | 路径 | 更新内容 |
|------|------|----------|
| AGENTS.md | 项目根目录 | 无需更新（本次改动不涉及架构约定） |
| TEST-STRATEGY.md | 项目根目录 | 无需更新（测试策略未变） |
| ARCHITECTURE.md | 项目根目录 | 无需更新（无架构变更） |

## 技术决策记录

1. **autoUpgradeOnStartup 时序**：在 ensurePublicSession 之前执行，确保公共 session 启动时扩展已最新
2. **fetchLatestVersion 错误处理**：无 dist-tags.latest 时 fallback 到 semver.maxSatisfying
3. **autoUpgrade 失败容错**：每个扩展独立 try-catch，失败不阻塞启动

## 文件变更清单

- packages/runtime/src/infra/installers/npm-installer.ts
- packages/runtime/src/infra/installers/npm-git-installer.ts
- packages/runtime/src/services/ports/installer.ts
- packages/runtime/src/services/ports/extension-settings.ts
- packages/runtime/src/infra/pi/pi-extension-settings.ts
- packages/runtime/src/services/extension-service.ts
- packages/runtime/src/transport/extension-message-handler.ts
- packages/runtime/src/index.ts
- packages/runtime/test/extension-upgrade.test.ts
- packages/shared/src/extension.ts
- packages/shared/src/protocol.ts
- packages/renderer/src/components/settings/ExtensionPage.vue
- packages/renderer/src/api/domains/extension.ts
- packages/renderer/src/api/mock/index.ts
- packages/renderer/src/__tests__/extension-upgrade.test.ts
