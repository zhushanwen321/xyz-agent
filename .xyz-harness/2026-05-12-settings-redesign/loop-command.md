# Loop 命令 — Settings 模块重设计 Phase 2

复制以下内容作为 `/loop` 命令的 prompt：

---

```
/loop --max 20 开发需求：Settings 模块重设计 Phase 2

按 plan.md 的 12 个 Task 顺序执行。每个 Task 完成后标记 complete_task。

## 第一步：读取核心文档（必须最先读）

1. `.xyz-harness/2026-05-12-settings-redesign/spec.md` — 需求规格（数据流、WS 协议、组件 API、视觉规范）
2. `.xyz-harness/2026-05-12-settings-redesign/plan.md` — 实现计划（12 Task、依赖图、验收标准、文件变更）
3. 用浏览器打开 `docs/designs/settings-final.html` 查看最终视觉效果（可交互 demo，有扫描/导入/删除确认动画）

## 第二步：读取代码上下文

### 共享类型（Task 1 修改目标）
- `src-electron/shared/src/provider.ts` — 现有 ProviderInfo/ModelInfo/SkillInfo/AgentInfo 类型，新增 ScanSourceType/ScannedSkillInfo/ScannedAgentInfo
- `src-electron/shared/src/protocol.ts` — 现有 ClientMessageType/ServerMessageType 联合类型，扩展新消息类型
- `src-electron/shared/src/index.ts` — barrel export

### Sidecar（Task 2-5 修改目标）
- `src-electron/sidecar/src/server.ts` — WS handler 主文件。重点看 L260-335 的 config case 分支路由模式，L120-130 的 broadcastInitialState()，L403-412 的 send/broadcast 方法，L427-432 的 broadcastProviderList()
- `src-electron/sidecar/src/config-store.ts` — 现有持久化模式（loadConfig/saveConfig）。新增 skills/agents 读写，参考此文件的模式

### 前端 Store/Composable（Task 6 修改目标）
- `src-electron/renderer/src/stores/provider.ts` — 现有 providers/skills/agents 状态管理
- `src-electron/renderer/src/stores/settings.ts` — 需移除 toolPermissions
- `src-electron/renderer/src/composables/useProvider.ts` — WS 事件监听注册模式
- `src-electron/renderer/src/lib/ws-client.ts` — send() 函数
- `src-electron/renderer/src/lib/event-bus.ts` — on()/off() 事件分发

### 现有组件（Task 7-11 参考/重写/删除目标）
- `src-electron/renderer/src/components/settings/ProviderPane.vue` → Task 8 重写
- `src-electron/renderer/src/components/settings/SkillsPane.vue` → Task 9 重写
- `src-electron/renderer/src/components/settings/AgentsPane.vue` → Task 10 重写
- `src-electron/renderer/src/components/settings/SystemPane.vue` → Task 11 重写
- `src-electron/renderer/src/components/settings/ProviderModal.vue` → 保留
- `src-electron/renderer/src/components/settings/SkillModal.vue` → 保留
- `src-electron/renderer/src/components/settings/AgentModal.vue` → 保留
- `src-electron/renderer/src/components/settings/ModelRow.vue` → 保留
- `src-electron/renderer/src/components/settings/ModelStrategyConfig.vue` → 保留
- `src-electron/renderer/src/components/settings/shared/ToggleSwitch.vue` → 保留
- `src-electron/renderer/src/components/settings/shared/MetaGrid.vue` → 保留
- `src-electron/renderer/src/components/settings/shared/MarkdownEditor.vue` → 保留
- `src-electron/renderer/src/components/settings/shared/TagPill.vue` → 保留
- `src-electron/renderer/src/components/settings/index.ts` → Task 11 更新 exports
- `src-electron/renderer/src/components/layout/SettingsView.vue` → Task 11 样式微调

### 待删除组件（Task 11 清理）
- `src-electron/renderer/src/components/settings/ProviderCard.vue`
- `src-electron/renderer/src/components/settings/SkillCard.vue`
- `src-electron/renderer/src/components/settings/AgentCard.vue`
- `src-electron/renderer/src/components/settings/SkillImportSection.vue`
- `src-electron/renderer/src/components/settings/shared/ImportSection.vue`
- `src-electron/renderer/src/components/settings/GlobalParams.vue`
- `src-electron/renderer/src/components/settings/OverrideParams.vue`
- `src-electron/renderer/src/components/settings/ToolPermissions.vue`
- `src-electron/renderer/src/components/settings/ProviderList.vue`
- `src-electron/renderer/src/components/settings/ProviderForm.vue`
- `src-electron/renderer/src/components/settings/SkillsTab.vue`
- `src-electron/renderer/src/components/settings/AgentsTab.vue`

### 项目规范
- `CLAUDE.md` — 编码规范、架构约束

## 执行规则

1. 先读 spec.md + plan.md，理解完整需求后再动手
2. 按 plan.md 的依赖图顺序执行 Task，不要跳步
3. 每个 Task 完成后运行 `npx tsc --noEmit` 确认类型检查通过
4. 所有新组件必须使用 xyz-ui 设计系统组件（Button/Input/Select 等），禁止原生 HTML 表单元素
5. 样式用 Tailwind 工具类，颜色用 CSS 变量（var(--accent) 等），禁止硬编码颜色
6. `<template>` ≤ 400 行, `<script setup>` ≤ 300 行
7. Task 11 清理后全局搜索确认无残留引用：`grep -r "ToolPermissions\|ProviderList\|ProviderForm\|SkillsTab\|AgentsTab\|ImportSection\|SkillImportSection\|GlobalParams\|OverrideParams" src-electron/renderer/src/`
8. Task 12 联调时先启动 sidecar，再启动前端，验证完整流程

## 加载的 Skill

- `xyz-harness-coding-skill` — 分层编码规范
- `xyz-harness-verification-before-completion` — 每次声称完成前必须验证
- `ts-taste-check` — TypeScript 代码品味检查（编码完成后可选运行）
```
