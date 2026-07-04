# Plugin System Roadmap

> 最后更新: 2026-05-29
> 分支: feat-plugin-arch-5 (PR #58)

## 完成概览

| Phase | 内容 | PR | 状态 |
|-------|------|----|------|
| Phase 1 | 插件基础设施（Registry、Host、RPC、Activator、Storage） | #54 | 已合并 |
| Phase 2 | API + 安全（agentAPI 10 模块、Permission、Goal/Todo 内置插件、Bridge） | #54 | 已合并 |
| Phase 3 | 前端 + 质量（PluginsPane、Store、StatusBar、Hooks、ToolExecute、测试） | #57 | 已合并 |
| P0 补完 | PluginsPane 接入 + Worker tool execute handler + CI Windows 修复 | #58 | 已合并 |

核心完成度: 100% (Phase 1-3 + P0 补完)

## P1 — 重要但非阻塞

| # | 功能 | 文件 | 现状 | 前置依赖 |
|---|------|------|------|----------|
| P1-1 | sessionData bridge flush | plugin-service.ts | flush 调用是 Promise.resolve()（TODO），数据仅存内存 | pi bridge API 就绪 |
| P1-2 | plugin:permissionRequest 服务端推送 | server.ts | 前端 PermissionDialog 已就绪，sidecar 不推送此消息 | 无 |
| P1-3 | ui-api 弹窗实现 | ui-api.ts | showSelect/showConfirm/showInput 返回 undefined | 无 |
| P1-4 | agent-api 读接口实现 | agent-api.ts | setModel/getModel/getThinkingLevel/setThinkingLevel 返回假数据 | 无 |

## P2 — Phase 4 分发体系

| # | 功能 | 设计来源 | 预计工期 |
|---|------|---------|----------|
| P2-1 | npm install 集成 (plugin-installer.ts) | plan.md Task 4.1 | 5-7 天 |
| P2-2 | create-xyz-plugin 脚手架 | plan.md Task 4.2 | 3-5 天 |
| P2-3 | xyz-agent-plugin-sdk npm 包 | plan.md Task 4.2 | 5-7 天 |
| P2-4 | 开发者文档 (developer-guide + api-reference) | plan.md Task 4.3 | 3-5 天 |
| P2-5 | 样例插件 + 集成测试 + 压力测试 | plan.md Task 4.4 | 5-7 天 |

## P3 — 远期增强

| # | 功能 | 设计来源 | 说明 |
|---|------|---------|------|
| P3-1 | contributes.panels 面板系统 | design-part2.md §3 | 类型定义存在，无渲染基础设施 |
| P3-2 | contributes.settings 声明式渲染 | design-part2.md §3 | manifest 声明应自动出现在 Settings |
| P3-3 | contributes.statusBarItems 声明式 | design-part2.md §3 | manifest 声明后无代码也应出现状态栏项 |
| P3-4 | contributes.slashCommands 声明式 | design-part2.md §3 | manifest 声明后应出现在 SlashMenu |
| P3-5 | contributes.messageDecorators | design-part2.md §3 | PluginContributes 中未定义此字段 |
| P3-6 | API 稳定性分层 (stable/proposed/internal) | design-part2.md §2 | proposed API gating 未实现 |
| P3-7 | Worker idle recycling (60s 超时回收) | plan.md Task 1.3 | 未确认是否实现 |
| P3-8 | 版本兼容性检查 (engines.xyz-agent semver) | plan.md Task 1.2 | 未实现 |
| P3-9 | 跨 Worker 插件通信 | plan.md Task 2.1 | api.events.on/emit 仅 Worker 内部 |
| P3-10 | 插件市场 / 版本更新 | 远期规划 | 无任何基础设施 |

## 相关 ADR

- [ADR-0007](../../adr/0007-git-submodule-for-extensions-and-skills.md) — Git submodule 管理 extensions/skills
- [ADR-0008](../../adr/0008-extension-bridge-for-navigate-tree.md) — Extension bridge navigate tree
- [ADR-0009](../../adr/0009-xyz-agent-data-dir-isolation-from-pi.md) — xyz-agent 数据目录与 pi 隔离
- [ADR-0010](../../adr/0010-extension-ui-independent-channel.md) — Extension UI 独立 channel
- [ADR-0011](../../adr/0011-bundled-extensions-direct-copy.md) — 内置 extension 直接复制
- [ADR-0012](../../adr/0012-pi-bridge-extension-for-plugin-proxy.md) — Pi bridge extension 代理插件
- [ADR-0013](../../adr/0013-session-data-over-pi-append-entry.md) — Session data over pi append entry

## 建议执行顺序

1. **P1-1 sessionData flush** — 最高优先级，影响数据持久化
2. **P1-2 permission 推送** — 安装插件时的核心交互
3. **P2-2 脚手架 + P2-3 SDK** — 先有开发者工具，再建生态
4. **P2-1 npm install** — 分发基础设施
5. **P2-4 开发者文档 + P2-5 样例插件** — 生态配套
6. **P3 项按需实现** — 根据实际使用反馈决定优先级
