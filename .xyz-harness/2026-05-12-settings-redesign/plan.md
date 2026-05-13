# Settings Redesign — Implementation Plan

> 视觉 demo（必读）: `docs/designs/settings-final.html`
> 需求规格: `.xyz-harness/2026-05-12-settings-redesign/spec.md`
> 本文件路径: `.xyz-harness/2026-05-12-settings-redesign/plan.md`

---

## Task 依赖关系与执行顺序

```
Task 1 (共享类型)
  ├─→ Task 2 (Skill Scanner)
  ├─→ Task 3 (Agent Scanner)
  └─→ Task 6 (前端 Store)

Task 2 + Task 3 + Task 4 (Config Store) → Task 5 (Sidecar Handler)

Task 5 + Task 6 + Task 7 (ScanImportSection) → Task 9 (SkillsPane) + Task 10 (AgentsPane)
Task 6 → Task 8 (ProviderPane)

Task 8 + 9 + 10 + 11 (SystemPane+清理) → Task 12 (联调+打磨)
```

**可并行的 Task 组**：
- Group A: Task 1 → Task 2 + Task 3 + Task 4 (并行) → Task 5
- Group B: Task 1 → Task 6 → Task 7 (可与 Group A 并行)
- Group C: Task 8 / Task 9 / Task 10 / Task 11 可并行（互不依赖）
- Group D: Task 12 最后

---

## Task 1：共享类型定义

### 描述
在 `src-electron/shared/src/provider.ts` 中新增 `ScanSourceType`、`ScannedSkillInfo`、`ScannedAgentInfo`。
在 `src-electron/shared/src/protocol.ts` 中扩展 `ClientMessageType` 和 `ServerMessageType` 联合类型。

### 验收标准
- [ ] `provider.ts` 中 `ScanSourceType` 存在：`'pi' | 'claude' | 'agents' | 'custom'`
- [ ] `provider.ts` 中 `ScannedSkillInfo` 接口存在，字段：id/name/description/sourceType/sourcePath/triggers/content/fileSize/tools/alreadyImported
- [ ] `provider.ts` 中 `ScannedAgentInfo` 接口存在，字段：id/name/description/sourceType/sourcePath/content/icon/tools/alreadyImported
- [ ] `protocol.ts` 的 `ClientMessageType` 包含：`config.scanSkills`, `config.setSkill`, `config.deleteSkill`, `config.scanAgents`, `config.setAgent`, `config.deleteAgent`
- [ ] `protocol.ts` 的 `ServerMessageType` 包含：`config.scannedSkills`, `config.skillUpdated`, `config.skillDeleted`, `config.scannedAgents`, `config.agentUpdated`, `config.agentDeleted`
- [ ] `npx tsc --noEmit` 通过（在 `src-electron/shared/` 目录下运行）

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/shared/src/provider.ts` | 修改 | 新增 3 个类型（约 30 行） |
| `src-electron/shared/src/protocol.ts` | 修改 | 扩展两个联合类型（每行新增 6 个字符串） |
| `src-electron/shared/src/index.ts` | 修改 | 如有 barrel export 需导出新类型 |

### 风险点
- `protocol.ts` 的联合类型在一行内，新增字符串需保持格式一致

---

## Task 2：Sidecar Skill Scanner

### 描述
新建 `src-electron/sidecar/src/skill-scanner.ts`，扫描指定目录下的 SKILL.md 文件。

### 验收标准
- [ ] 导出 `scanSkills(sources: string[], existingSkillIds: Set<string>): ScannedSkillInfo[]` 函数
- [ ] `sources` 中的 `~` 通过 `homedir()` 展开（参考 `config-store.ts` 的 `loadPiConfig()` 方法）
- [ ] 目录不存在时跳过（不 throw，参考 `config-store.ts` L88-93 的 try-catch 模式）
- [ ] 遍历每个 source 目录下的子目录，查找 `SKILL.md` 文件
- [ ] 解析 SKILL.md：description 取第一段非标题文本，triggers 从 YAML frontmatter 或特定格式解析
- [ ] `sourceType` 根据路径判断：包含 `.pi/` → `'pi'`，包含 `.claude/` → `'claude'`，包含 `.agents/` → `'agents'`，其余 → `'custom'`
- [ ] `alreadyImported` = `existingSkillIds.has(id)`
- [ ] `id` 生成规则：`${sourceType}-${directoryName}`

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/sidecar/src/skill-scanner.ts` | 新建 | Skill 扫描服务（约 60 行） |

### 风险点
- SKILL.md 格式多样，解析需宽容处理。如果解析困难，description 取文件前 100 字符，triggers 留空数组

---

## Task 3：Sidecar Agent Scanner

### 描述
新建 `src-electron/sidecar/src/agent-scanner.ts`，扫描指定目录下的 agent 配置。

### 验收标准
- [ ] 导出 `scanAgents(sources: string[], existingAgentIds: Set<string>): ScannedAgentInfo[]` 函数
- [ ] 路径展开、目录不存在跳过、sourceType 判断逻辑同 skill-scanner
- [ ] 扫描模式：遍历子目录，查找目录下的主配置文件（优先 `agent.md`，备选目录名.md 或 `SKILL.md`）
- [ ] 解析 description 和 tools（宽容处理，同 skill-scanner）
- [ ] `icon` 取目录名首字母大写

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/sidecar/src/agent-scanner.ts` | 新建 | Agent 扫描服务（约 60 行） |

### 风险点
- Claude Code agent 目录结构可能与 Pi 不同，初期只扫描子目录名 + 内部 md 文件

---

## Task 4：Config Store 扩展

### 描述
扩展 `src-electron/sidecar/src/config-store.ts`，新增 skills 和 agents 的持久化读写。

### 验收标准
- [ ] 新增 `loadSkills(projectRoot: string): SkillInfo[]` — 读取 `<projectRoot>/.xyz-agent/skills.json`
- [ ] 新增 `saveSkills(projectRoot: string, skills: SkillInfo[]): void` — 写入文件
- [ ] 新增 `loadAgents(projectRoot: string): AgentInfo[]` — 读取 `<projectRoot>/.xyz-agent/agents.json`
- [ ] 新增 `saveAgents(projectRoot: string, agents: AgentInfo[]): void` — 写入文件
- [ ] 文件不存在返回空数组（参考 `loadConfig()` 的 try-catch 模式）
- [ ] `.xyz-agent/` 目录不存在时自动创建（`mkdirSync({ recursive: true })`，参考 `saveConfig()` L101）
- [ ] 使用项目根目录（非 home 目录）作为存储路径，因为 skills/agents 是项目级的

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/sidecar/src/config-store.ts` | 修改 | 新增 4 个函数（约 40 行） |

### 风险点
- `projectRoot` 需要从 server.ts 传入。SidecarServer 构造时可接收 projectRoot 参数，或从 process.cwd() 获取

---

## Task 5：Sidecar Server Handler 扩展

### 描述
在 `src-electron/sidecar/src/server.ts` 的 switch-case 中（约 L260-335 之间）新增 6 个消息分支。

### 验收标准
- [ ] `config.scanSkills` → 调用 `scanSkills(sources, existingIds)` → `this.send(ws, { type: 'config.scannedSkills', ... })`
- [ ] `config.setSkill` → 调用 `saveSkills(projectRoot, updatedList)` → `this.send(ws, { type: 'config.skillUpdated', ... })` → `this.broadcastSkillList()`
- [ ] `config.deleteSkill` → 调用 `saveSkills` 移除目标 → `this.send(ws, { type: 'config.skillDeleted', ... })` → `this.broadcastSkillList()`
- [ ] Agent 三条消息对称处理
- [ ] 所有 handler 有 try-catch，失败时 `this.send(ws, { type: 'config.xxx', payload: { success: false, error: message } })`
- [ ] 新增 `broadcastSkillList()` 和 `broadcastAgentList()` 方法（参考 `broadcastProviderList()` L427-432）
- [ ] 在 `broadcastInitialState()` (L120-130) 中新增 skills/agents 初始广播

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/sidecar/src/server.ts` | 修改 | 新增 6 case + 2 broadcast 方法 + 初始广播扩展（约 80 行） |

### 风险点
- server.ts 已有 549 行，新增代码需组织好，避免 switch-case 过长
- `projectRoot` 如何获取需确认（构造函数参数或全局变量）

---

## Task 6：前端 Store + Composable 扩展

### 描述
扩展 `provider.ts` store 新增 scan/CRUD actions，扩展 `useProvider.ts` composable 注册新事件监听，清理 `settings.ts` store 移除 toolPermissions。

### 验收标准
- [ ] `provider.ts` 新增状态：`scannedSkills: ref<ScannedSkillInfo[]>([])`, `scannedAgents: ref<ScannedAgentInfo[]>([])`
- [ ] `provider.ts` 新增 actions：`scanSkills(sources)`, `scanAgents(sources)`, `importSkills(items)`, `importAgents(items)`, `deleteSkill(id)`, `deleteAgent(id)`, `toggleSkill(id)`, `toggleAgent(id)`
- [ ] 每个 action 内部调用 `send({ type: 'config.xxx', payload: {...} })`
- [ ] `useProvider.ts` 新增事件监听：`config.scannedSkills` → `providerStore.scannedSkills = payload.skills`；`config.scannedAgents` 类似
- [ ] `useProvider.ts` 新增事件监听：`config.skillUpdated` / `config.skillDeleted` → 重新调用 `send({ type: 'config.getProviders' })` 或更新 store
- [ ] `settings.ts` 移除 `toolPermissions` 及 `setToolPermission` / `resetToolPermissions` 方法
- [ ] `settings.ts` persist pick 中移除 `'toolPermissions'`

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/renderer/src/stores/provider.ts` | 修改 | 新增 scan/CRUD actions（约 60 行） |
| `src-electron/renderer/src/stores/settings.ts` | 修改 | 移除 toolPermissions 相关（约 -15 行） |
| `src-electron/renderer/src/composables/useProvider.ts` | 修改 | 注册新事件监听（约 20 行） |

### 风险点
- SkillInfo/AgentInfo 类型可能需要 `sourceType` 字段（当前是 `source?: string`），需确认映射关系

---

## Task 7：ScanImportSection 通用组件

### 描述
新建通用扫描导入组件，Skill 和 Agent tab 共用。

### 验收标准
- [ ] Props 接口完整：`sources`, `scanEventType`, `scannedEventType`, `existingItems`
- [ ] source chips 多选 toggle，`active` 样式：accent 边框 + accent-light 底色 + icon 反色
- [ ] 「已选 N 个来源」文案在 toggle 后实时更新（computed）
- [ ] 自定义路径 input + 「添加」按钮
- [ ] 「扫描」按钮 → 调用 store 的 scan action → loading spinner 替换计数文案
- [ ] 监听 store 的 scannedSkills/scannedAgents 变化 → 渲染结果列表
- [ ] checkbox 多选，已导入项禁用 + 「已导入」badge + 整行 opacity 0.4
- [ ] 底栏「导入选中 N 个」→ emit `import` 事件 → 父组件处理
- [ ] 视觉完全对齐 `docs/designs/settings-final.html` 中的扫描区域
- [ ] `<template>` ≤ 400 行, `<script setup>` ≤ 300 行

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/renderer/src/components/settings/ScanImportSection.vue` | 新建 | 通用扫描导入（约 250 行） |

### 风险点
- 需注意已导入判断逻辑：比较 `item.name` 是否在 `existingItems` 中
- checkbox 全选/取消全选可不做，MVP 阶段手动勾选

---

## Task 8：Provider Section 重设计

### 描述
用 ProviderSection 替代 ProviderCard。Provider 的模型直接平铺在 section-body 内。

### 验收标准
- [ ] ProviderSection 接收 `provider: ProviderInfo` + `models: ModelInfo[]` props
- [ ] section-header：左侧 avatar（首字母）+ name + status dot + url；右侧 badge(N models) + toggle + 编辑/删除按钮
- [ ] section-body：model rows 平铺（用现有 ModelRow.vue 或内联渲染）
- [ ] section hover 时 border 变深（`oklch(86% 0.012 70)`）
- [ ] section-header 底色 `var(--section-bg)`
- [ ] 禁用 provider 整体 opacity 0.5
- [ ] ProviderPane 重写为循环渲染 ProviderSection（保持现有 handleSave/handleDelete/handleTest 逻辑）
- [ ] ProviderModal 保留不变
- [ ] 删除 `ProviderCard.vue`
- [ ] 视觉对齐 demo 的 Provider 区域

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/renderer/src/components/settings/ProviderSection.vue` | 新建 | Provider section（约 80 行） |
| `src-electron/renderer/src/components/settings/ProviderPane.vue` | 重写 | 用 ProviderSection（约 120 行） |
| `src-electron/renderer/src/components/settings/ProviderCard.vue` | 删除 | 被替代 |

### 风险点
- ProviderModal 的测试连接仍是 no-op（不在本次修复范围）

---

## Task 9：Skill Section + SkillsPane 重设计

### 描述
用 SkillSection + ScanImportSection 重写 SkillsPane。Skill CRUD 通过 WS。

### 验收标准
- [ ] SkillSection 接收 `skill: SkillInfo` prop
- [ ] section-header：左侧 name + description（line-clamp-1）；右侧 toggle + 编辑/删除 + chevron
- [ ] 点击 header → toggle 展开收起 detail-grid（grid-template-columns: 76px 1fr）
- [ ] chevron 旋转动画（`transition: transform 150ms`）
- [ ] SkillsPane 结构：ScanImportSection → 「已导入」section header → SkillSection 循环
- [ ] toggle 启停 → `providerStore.toggleSkill(id)` → WS config.setSkill
- [ ] 删除 → confirm-bar → `providerStore.deleteSkill(id)` → WS config.deleteSkill
- [ ] 扫描导入完整流程：选源 → 扫描 → 勾选 → 导入（通过 ScanImportSection）
- [ ] 导入后 ScanImportSection emit `import` → SkillsPane 调用 `providerStore.importSkills(items)`
- [ ] 删除 SkillCard.vue / SkillImportSection.vue / shared/ImportSection.vue
- [ ] 视觉对齐 demo 的 Skill 区域

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/renderer/src/components/settings/SkillSection.vue` | 新建 | Skill section（约 70 行） |
| `src-electron/renderer/src/components/settings/SkillsPane.vue` | 重写 | ScanImportSection + SkillSection（约 100 行） |
| `src-electron/renderer/src/components/settings/SkillCard.vue` | 删除 | 被替代 |
| `src-electron/renderer/src/components/settings/SkillImportSection.vue` | 删除 | 被替代 |
| `src-electron/renderer/src/components/settings/shared/ImportSection.vue` | 删除 | 被替代 |

### 风险点
- Skill 的编辑功能（内嵌 MarkdownEditor）在 SkillSection 展开后需可选嵌入

---

## Task 10：Agent Section + AgentsPane 重设计

### 描述
用 AgentSection + ScanImportSection 重写 AgentsPane。Agent CRUD 通过 WS。移除 GlobalParams/OverrideParams。

### 验收标准
- [ ] AgentSection 接收 `agent: AgentInfo` + `allModels` props
- [ ] section-header：左侧 avatar + name + strategy label；右侧 toggle + 编辑/删除
- [ ] section-body 不折叠：策略 select 行 + 工具列表行（参考 demo）
- [ ] 策略 select change → emit `update-strategy` → 父组件 WS config.setAgent
- [ ] 删除 → confirm-bar（参考 demo，点击删除按钮展开 confirm-bar）
- [ ] AgentsPane 结构：ScanImportSection → AgentSection 循环（无 GlobalParams）
- [ ] Agent 扫描来源：Pi / Claude Code / Agents 三个 source chips
- [ ] 删除 AgentCard.vue / GlobalParams.vue / OverrideParams.vue
- [ ] 视觉对齐 demo 的 Agent 区域

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/renderer/src/components/settings/AgentSection.vue` | 新建 | Agent section（约 90 行） |
| `src-electron/renderer/src/components/settings/AgentsPane.vue` | 重写 | ScanImportSection + AgentSection（约 100 行） |
| `src-electron/renderer/src/components/settings/AgentCard.vue` | 删除 | 被替代 |
| `src-electron/renderer/src/components/settings/GlobalParams.vue` | 删除 | 功能移除 |
| `src-electron/renderer/src/components/settings/OverrideParams.vue` | 删除 | 功能移除 |

### 风险点
- ModelStrategyConfig.vue 可能在 AgentSection 中被复用，需确认 props 接口

---

## Task 11：SystemPane + Barrel Exports + 清理

### 描述
重写 SystemPane 为两个 section，更新 barrel exports，清理所有废弃组件。

### 验收标准
- [ ] SystemPane 重写为两个 section：「语言与外观」+ 「配色主题」
- [ ] 语言/外观 select 行在第一个 section 内
- [ ] 配色主题在独立 section 内，Muted/Colorful 分组，palette-btn active 切换
- [ ] `settings/index.ts` 更新 exports（移除旧组件 export，添加新组件 export）
- [ ] 删除：ToolPermissions.vue / ProviderList.vue / ProviderForm.vue / SkillsTab.vue / AgentsTab.vue
- [ ] 全局搜索确认无文件引用被删除的组件（`grep -r "ToolPermissions\|ProviderList\|ProviderForm\|SkillsTab\|AgentsTab\|ImportSection\|SkillImportSection" src-electron/renderer/`）
- [ ] `npx tsc --noEmit` 通过

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/renderer/src/components/settings/SystemPane.vue` | 重写 | 两个 section（约 80 行） |
| `src-electron/renderer/src/components/settings/index.ts` | 修改 | 更新 exports |
| `src-electron/renderer/src/components/layout/SettingsView.vue` | 修改 | 样式微调（section hover） |
| `src-electron/renderer/src/components/settings/ToolPermissions.vue` | 删除 | 功能移除 |
| `src-electron/renderer/src/components/settings/ProviderList.vue` | 删除 | 旧版 |
| `src-electron/renderer/src/components/settings/ProviderForm.vue` | 删除 | 旧版 |
| `src-electron/renderer/src/components/settings/SkillsTab.vue` | 删除 | 旧版 |
| `src-electron/renderer/src/components/settings/AgentsTab.vue` | 删除 | 旧版 |

### 风险点
- SettingsView.vue 的 tab 切换逻辑不变，只需确认 import 路径正确

---

## Task 12：前后端联调 + 视觉打磨

### 描述
启动 sidecar + 前端，验证完整流程，修复视觉细节。

### 验收标准
- [ ] Provider section 样式与 demo 一致（hover border、header 底色、model rows）
- [ ] Skill 扫描 → 勾选 → 导入 → 已导入列表更新，全流程通过
- [ ] Agent 扫描 → 勾选 → 导入，全流程通过
- [ ] Skill/Agent toggle 启停通过 WS 同步，刷新页面后状态保持
- [ ] 删除 → confirm-bar → 确认 → section 移除 → toast
- [ ] Toast 正常弹出和消失（2.5s）
- [ ] Skill 展开收起动画流畅
- [ ] 整体间距/对齐与 demo 一致
- [ ] `npm run lint` 通过

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| 多文件 | 修改 | 联调修复 + 视觉打磨 |

### 风险点
- sidecar 需要重启才能加载新 handler
- WS 事件名不一致导致消息丢失 — 验证方法：在 server.ts 的 handler 中加 `console.log`
