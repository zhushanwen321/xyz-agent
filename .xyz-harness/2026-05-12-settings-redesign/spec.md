# Settings 模块重设计 — Spec

> **⚠️ PARTIALLY DEPRECATED — 2026-07-13**
>
> 本 spec 的 **Skill/Agent 部分**已被 [ADR-0020](../../../docs/architecture/adr/0020-resource-loading-strategy.md) 推翻，不再作为当前设计规范。现行设计见 [v3 settings spec](../../../docs/page-design/v3/settings/spec.md)。
>
> **仍有效的部分**：Provider 全套（ProviderSection/ProviderModal/ModelRow、model.toggle/switch）、System 全套（配色/语言）、§5.1 现有基础设施、§8 视觉规范摘要。
>
> **已过时（DEPRECATED）的章节**：
> - §1 目标末句「新增 Skill/Agent 的扫描导入四步流程」
> - §2「Skill/Agent 持久化」「扫描导入」「Agent/Skill 扫描来源」4 行 — 文件级 CRUD + 扫描导入模型
> - §3 WS 协议扩展中的 `config.scanSkills/scannedSkills`、`config.setSkill/skillUpdated`、`config.deleteSkill/skillDeleted` 及 Agent 对称消息（代码中已标 `@deprecated`，保留兼容期）
> - §4.1 数据流图中的 Skill/Agent 扫描导入分支
> - §6.2 `ScanImportSection.vue` 整个组件定义 — 被「层 A 加载路径配置 + 只读实体列表」取代
> - §7.1 扫描导入流程（四步：选源 → 扫描 → 勾选 → 导入）
> - §7.2 Skill/Agent 的 toggle 启停 / 编辑内容 / 删除操作（Provider 部分仍有效）
>
> **设计演进核心**：ADR-0020 从「扫文件 → 勾选文件 → 导入到本地 json → 文件级 toggle/delete」改为「勾选目录 → discovery.json 注入路径 → 目录内资源全开 → 实体列表只读看 badge」。文件级 scan/set/delete/toggle 全部消失，配置粒度收敛到目录级（「目录在 = 启用」）。

## 视觉参考

**HTML Demo（必须先在浏览器中打开查看最终效果）**: `docs/designs/settings-final.html`

Demo 中可交互：点击 sidebar tab 切换，Skill/Agent tab 的「扫描」按钮有 loading → 结果动画，source chips 可 toggle，checkbox 可勾选，删除有 confirm-bar，底部有 toast。

---

## 1. 目标

将 Provider / Skill / Agent / System 四个设置 tab 重设计为 **Section Groups** 风格。每个 Provider/Agent 是一个独立 section（圆角 8px 卡片，header 有浅底色），模型/属性直接平铺在 section-body 内。同时修复所有 P0 功能缺陷，新增 Skill/Agent 的扫描导入四步流程。

## 2. 设计决策

| 决策 | 结论 |
|------|------|
| 视觉风格 | Section Groups — 详见 `docs/designs/settings-final.html` |
| OverrideParams | **删除**。Agent 不需要参数覆盖 |
| ToolPermissions | **删除**。默认全部允许 |
| Skill/Agent 持久化 | 通过 WS 与 sidecar 双向同步，sidecar 持久化到 `<project>/.xyz-agent/skills.json` 和 `agents.json` |
| 扫描导入 | 四步流程：选源 → 扫描 → 勾选 → 导入。Skill/Agent 共用 `ScanImportSection` 组件 |
| Agent 扫描来源 | Pi (`~/.pi/agent/agents/`) / Claude Code (`~/.claude/agents/`) / Agents (`~/.agents/agents/`) |
| Skill 扫描来源 | Pi (`~/.pi/agent/skills/`) / Claude Code (`~/.claude/skills/`) / Agents (`~/.agents/skills/`) |
| 保存模式 | 所有变更通过 WS 实时同步（toggle / edit / delete 均 WS 消息） |
| 删除确认 | section 内 confirm-bar（红色底色），不用 modal |
| 操作反馈 | 底部 inline toast（2.5s 自动消失） |

## 3. WS 协议扩展

### 3.1 新增 ClientMessageType（`shared/src/protocol.ts`）

```
'config.scanSkills' | 'config.setSkill' | 'config.deleteSkill'
'config.scanAgents' | 'config.setAgent' | 'config.deleteAgent'
```

### 3.2 新增 ServerMessageType（`shared/src/protocol.ts`）

```
'config.scannedSkills' | 'config.skillUpdated' | 'config.skillDeleted'
'config.scannedAgents' | 'config.agentUpdated' | 'config.agentDeleted'
```

### 3.3 消息格式

#### 扫描

```typescript
// → config.scanSkills
{ type: 'config.scanSkills', payload: { sources: string[] } }
// sources 示例: ['~/.pi/agent/skills/', '~/.claude/skills/']

// ← config.scannedSkills
{
  type: 'config.scannedSkills',
  payload: {
    skills: ScannedSkillInfo[],  // 见下方类型定义
    success: boolean,
    error?: string
  }
}

// config.scanAgents / config.scannedAgents 格式完全对称
```

#### CRUD

```typescript
// → config.setSkill (创建或更新，含启停)
{ type: 'config.setSkill', payload: { skill: SkillInfo } }
// ← config.skillUpdated
{ type: 'config.skillUpdated', payload: { skill: SkillInfo, success: boolean, error?: string } }

// → config.deleteSkill
{ type: 'config.deleteSkill', payload: { skillId: string } }
// ← config.skillDeleted
{ type: 'config.skillDeleted', payload: { skillId: string, success: boolean, error?: string } }

// config.setAgent / config.agentUpdated / config.deleteAgent / config.agentDeleted 格式完全对称
```

### 3.4 新增共享类型（`shared/src/provider.ts`）

```typescript
export type ScanSourceType = 'pi' | 'claude' | 'agents' | 'custom'

export interface ScannedSkillInfo {
  id: string
  name: string
  description: string
  sourceType: ScanSourceType
  sourcePath: string       // 完整文件路径，如 /Users/x/.pi/agent/skills/code-trace/SKILL.md
  triggers: string[]
  content: string          // SKILL.md 文件内容
  fileSize?: string
  tools?: string[]
  alreadyImported: boolean // 是否已在 config-store 中
}

export interface ScannedAgentInfo {
  id: string
  name: string
  description: string
  sourceType: ScanSourceType
  sourcePath: string
  content: string          // agent 配置文件内容
  icon?: string
  tools?: string[]
  alreadyImported: boolean
}
```

## 4. 数据流

### 4.1 数据流图

```
前端 SettingsView
  ├── ScanImportSection (Skill)
  │     → config.scanSkills { sources }
  │     ← config.scannedSkills { skills[] }
  │     → config.setSkill × N (逐个导入选中的)
  │     ← config.skillUpdated × N
  │
  ├── ScanImportSection (Agent)
  │     → config.scanAgents { sources }
  │     ← config.scannedAgents { agents[] }
  │     → config.setAgent × N
  │     ← config.agentUpdated × N
  │
  ├── ProviderSection (现有逻辑不变)
  │     → config.setProvider / config.deleteProvider / model.switch
  │
  └── SkillSection / AgentSection (已导入列表)
        toggle  → config.setSkill { skill: {...skill, enabled: !skill.enabled} }
        delete  → config.deleteSkill { skillId }
        edit    → config.setSkill { skill: {...updatedFields} }

Sidecar
  ├── server.ts: 新增 6 个 case 分支路由到 config-store
  ├── config-store.ts: 新增 loadSkills/saveSkills/loadAgents/saveAgents
  │     持久化: <project>/.xyz-agent/skills.json, <project>/.xyz-agent/agents.json
  │     （参考现有 providers 存储模式: config-store.ts → ~/.xyz-agent/config.json）
  ├── skill-scanner.ts: 扫描目录 → 解析 SKILL.md → ScannedSkillInfo[]
  └── agent-scanner.ts: 扫描目录 → 解析 agent 配置 → ScannedAgentInfo[]
```

### 4.2 Sidecar 初始化

sidecar 启动时（`server.ts` 的 `broadcastInitialState` 方法，约 L120-130），需要新增：
- 发送 `config.skills` 消息，携带 `loadSkills()` 的结果
- 发送 `config.agents` 消息，携带 `loadAgents()` 的结果

### 4.3 时序要求

- 扫描结果返回后才显示列表（前端在 `scannedSkills`/`scannedAgents` 事件回调中更新 store）
- 导入是批量操作：遍历选中项逐个发送 `config.setSkill`，全部完成后 toast + 收起结果列表
- toggle 启停直接发送 `config.setSkill`，不等批量

## 5. 已有基础设施

### 5.1 可复用的现有 API

| 位置 | 方法/组件 | 用途 |
|------|----------|------|
| `stores/provider.ts` | `skills`, `agents` getters | 数据持有（Map 结构） |
| `stores/provider.ts` | `setSkills(s)`, `setAgents(a)` | 批量写入 |
| `stores/provider.ts` | `enabledModels` computed | Agent 模型选择器用 |
| `composables/useProvider.ts` | WS 事件注册模板 | 参考如何注册新事件 |
| `lib/ws-client.ts` | `send({ type, payload })` | WS 消息发送 |
| `lib/event-bus.ts` | `on(event, handler)`, `off(event, handler)` | WS 事件分发 |
| `design-system/` | Button, Input, Select, Textarea | 基础 UI 组件 |
| `settings/shared/` | ToggleSwitch, MetaGrid, MarkdownEditor, TagPill | 可直接复用的共享组件 |

### 5.2 Sidecar 关键结构

| 文件 | 关键函数/模式 | 说明 |
|------|-------------|------|
| `sidecar/src/server.ts` L260-335 | `case 'config.xxx'` 分支 | config handler 路由模式。新增 case 后调用 config-store 方法，用 `this.send(ws, ...)` 回复 |
| `sidecar/src/server.ts` L403-412 | `send()` / `broadcast()` | 消息发送方法。`send` 给单个客户端，`broadcast` 给所有 |
| `sidecar/src/server.ts` L427-432 | `broadcastProviderList()` | 广播模式：修改后广播最新列表给所有客户端。Skill/Agent 也需类似 `broadcastSkillList()` |
| `sidecar/src/server.ts` L120-130 | `broadcastInitialState()` | 初始化广播。新增 skills/agents 初始数据广播 |
| `sidecar/src/config-store.ts` | `loadConfig()` / `saveConfig()` | 现有 config 持久化模式（JSON 文件读写）。Skill/Agent 需类似模式 |
| `sidecar/src/provider-store.ts` | `listProviders()` / `setProvider()` | Provider 数据管理模式。Skill/Agent 需类似 |

### 5.3 接口/类型定义位置

| 位置 | 接口名 | 说明 |
|------|--------|------|
| `shared/src/provider.ts` | `ProviderInfo` | Provider 完整信息 |
| `shared/src/provider.ts` | `ModelInfo` | 模型信息 |
| `shared/src/provider.ts` | `SkillInfo` | Skill 元数据。已有字段：id/name/description/enabled/source/triggers + UI 扩展字段 sourcePath/sourceIcon/fileSize/tools/content/tag |
| `shared/src/provider.ts` | `AgentInfo` | Agent 元数据。已有字段：id/name/description/enabled/modelStrategy + UI 扩展字段 source/sourceType/icon/iconBg/type/tools/modelBind/modelTags/overrideParams/params/content |
| `shared/src/protocol.ts` | `ClientMessageType` / `ServerMessageType` | 联合类型，新增消息类型在此扩展 |
| `shared/src/provider.ts` | **需新增**: `ScanSourceType`, `ScannedSkillInfo`, `ScannedAgentInfo` | 扫描结果类型 |

### 5.4 已知技术债务（编码 agent 不修）

| 文件 | 问题 | 原因 |
|------|------|------|
| `ProviderModal.vue` handleTest | 硬编码 `testResult = 'ok'` | 需 sidecar 实现真正的连接测试，不在本次范围 |
| `useProvider.ts` | loadProviders/setProvider 方法未被 Pane 直接调用 | Pane 用 `send()` + event-bus，composable 只做事件监听，不影响新功能 |
| `AgentInfo.overrideParams` / `params` | 这两个字段将在本次需求中移除使用 | Agent 不再做参数覆盖 |

## 6. 组件结构

### 6.1 删除的组件（9 个文件）

| 文件 | 原因 |
|------|------|
| `settings/ProviderCard.vue` | 被 `ProviderSection.vue` 替代 |
| `settings/SkillCard.vue` | 被 `SkillSection.vue` 替代 |
| `settings/AgentCard.vue` | 被 `AgentSection.vue` 替代 |
| `settings/SkillImportSection.vue` | 被 `ScanImportSection.vue` 替代 |
| `settings/shared/ImportSection.vue` | 被替代 |
| `settings/GlobalParams.vue` | 功能移除 |
| `settings/OverrideParams.vue` | 功能移除 |
| `settings/ToolPermissions.vue` | 功能移除 |
| `settings/ProviderList.vue` / `ProviderForm.vue` / `SkillsTab.vue` / `AgentsTab.vue` | 旧版兼容，4 个文件 |

### 6.2 新建的组件（4 个文件）

#### ScanImportSection.vue（通用扫描导入）

```
Props:
  sources: SourceOption[]           // 预定义来源列表
  scanEventType: string             // 'config.scanSkills' | 'config.scanAgents'
  scannedEventType: string          // 'config.scannedSkills' | 'config.scannedAgents'
  existingItems: { id: string; name: string }[]  // 已导入列表（标记 alreadyImported）

Emits:
  import(selectedItems: ScannedSkillInfo[] | ScannedAgentInfo[])

SourceOption:
  { id: string, icon: string, label: string, path: string, defaultActive?: boolean }
```

视觉结构（对齐 demo `settings-final.html`）：
- `.source-row`: 多个 `.source-chip`（active 时 accent 边框+底色，icon 背景反色）
- `.custom-path-row`: mono input + 添加按钮
- `.scan-action-bar`: 左侧「已选 N 个来源」(动态计数) + 右侧「扫描」按钮
- `.scan-results`: 扫描结果列表（`.scan-item` 行，含 checkbox/name/source badge/「已导入」badge）
- `.import-action-bar`: 底栏（已选计数 + 导入按钮）

#### ProviderSection.vue

```
Props:
  provider: ProviderInfo
  models: ModelInfo[]

Emits:
  toggle-enabled: [providerId: string]
  toggle-model: [providerId: string, modelId: string]
  edit: [providerId: string]
  delete: [providerId: string]
```

视觉结构：
- `.section > .section-header`（左：avatar + name + status dot + url；右：badge + toggle + 编辑/删除按钮）
- `.section-body`（model rows 平铺，不需要折叠）
- 禁用状态：整个 section `opacity: 0.5`

#### SkillSection.vue

```
Props:
  skill: SkillInfo

Emits:
  toggle-enabled: []
  edit: [skillId: string]
  delete: [skillId: string]
```

视觉结构：
- `.section > .section-header`（左：name + description；右：toggle + 编辑/删除 + chevron）
- 点击 header 行 → toggle 展开/收起 `.detail-grid`（key-value 网格：触发词/来源/工具）
- chevron 旋转动画

#### AgentSection.vue

```
Props:
  agent: AgentInfo
  allModels: { id: string; name: string; providerName: string }[]

Emits:
  toggle-enabled: []
  update-strategy: [agentId: string, strategy: string]
  delete: [agentId: string]
```

视觉结构：
- `.section > .section-header`（左：avatar + name + strategy label + url；右：toggle + 编辑/删除）
- `.section-body`（不折叠）：策略 select 行 + 工具列表行
- 删除 → 展示 `.confirm-bar`（红色底色，确认/取消按钮）

### 6.3 重写的组件（4 个文件）

| 组件 | 核心变更 |
|------|---------|
| `ProviderPane.vue` | 用 `ProviderSection` 循环渲染替代 `ProviderCard`。样式对齐 demo（section hover border、section-header 底色） |
| `SkillsPane.vue` | 用 `ScanImportSection` + `SkillSection` 循环渲染。CRUD 走 WS |
| `AgentsPane.vue` | 用 `ScanImportSection` + `AgentSection` 循环渲染。CRUD 走 WS。移除 GlobalParams |
| `SystemPane.vue` | 重写为两个 section（语言与外观 + 配色主题）。palette-btn active 切换逻辑不变 |

### 6.4 保留的组件（微调样式）

| 组件 | 说明 |
|------|------|
| `ProviderModal.vue` | 保留，样式无需大改 |
| `SkillModal.vue` | 保留，用于「手动添加」 |
| `AgentModal.vue` | 保留，用于「手动添加」 |
| `ModelRow.vue` | 保留，嵌入 ProviderSection |
| `ModelStrategyConfig.vue` | 保留，嵌入 AgentSection |
| `ToggleSwitch.vue`, `MetaGrid.vue`, `MarkdownEditor.vue`, `TagPill.vue` | 保留，共享组件 |

## 7. 关键交互规则

### 7.1 扫描导入流程

1. source chips **多选** toggle，选中计数实时更新到「已选 N 个来源」
2. 自定义路径输入 + 添加 → 追加为新的 source chip
3. 「扫描」按钮 → `send({ type: scanEventType, payload: { sources } })` → loading spinner 替换计数文案
4. 监听 `scannedEventType` → 渲染结果列表（入场动画）
5. 已导入项：checkbox 禁用 + 「已导入」badge + 整行 opacity 0.4
6. 底部「导入选中 N 个」→ 遍历选中项 emit `import` → 父组件批量 WS → toast → 结果列表收起

### 7.2 CRUD 操作

| 操作 | WS 消息 | 反馈 |
|------|---------|------|
| toggle 启停 | `config.setSkill/setAgent { ...item, enabled: !enabled }` | 无 toast（视觉 toggle 即反馈） |
| 编辑内容 | `config.setSkill/setAgent { ...item, content: newContent }` | toast「已保存」 |
| 删除 | 点击删除 → confirm-bar → 确认 → `config.deleteSkill/deleteAgent` | toast「已删除」+ section 移除 |

### 7.3 Toast

- 位置：`fixed; bottom: 24px; left: 50%; transform: translateX(-50%)`
- 样式：深色背景（`var(--fg)`）+ 浅色文字（`var(--bg)`）
- 动画：fadeIn 200ms → 显示 → fadeOut 300ms at 2s
- 实现：在 App.vue 或 SettingsView.vue 中添加 toast 容器，由 store 驱动

## 8. 视觉规范摘要（对齐 DESIGN.md）

| 元素 | 值 |
|------|---|
| section 圆角 | `8px` |
| section border | `1px solid var(--border)`, hover 时 `oklch(86% 0.012 70)` |
| section-header 底色 | `var(--section-bg)` = `oklch(95% 0.014 70)` |
| section-header 最小高度 | `42px` |
| item-row padding | `9px 16px` |
| avatar 尺寸 | `30×30px`, `border-radius: 5px` |
| toggle 尺寸 | `34×19px` |
| source-chip padding | `6px 12px` |
| source-chip-icon | `22×22px`, `border-radius: 5px` |
| detail-grid | `grid-template-columns: 76px 1fr` |
| confirm-bar 底色 | `var(--danger-light)` |
| toast 底色 | `var(--fg)`, 文字 `var(--bg)` |
| 动画曲线 | `ease-out` 200ms |
