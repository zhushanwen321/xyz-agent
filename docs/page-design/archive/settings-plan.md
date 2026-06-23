# Settings Redesign — Implementation Plan

> 视觉参考 demo: [settings-final.html](./settings-final.html)
> 历史变体: [variant-a](./settings-variant-a-refined.html) · [variant-b](./settings-variant-b-compact.html) · [variant-c](./settings-variant-c-sections.html)

## 1. Scope

将 Settings 模块（Provider / Skill / Agent / System 四个 tab）从当前的卡片式布局重设计为 **Section Groups** 风格，同时修复所有 P0 功能缺陷，并新增 Skill/Agent 的扫描导入流程。

### 设计决策

| 决策 | 结论 |
|------|------|
| 视觉风格 | Variant C: Section Groups（[demo](./settings-final.html)） |
| OverrideParams | 去掉，Agent 不需要参数覆盖 |
| ToolPermissions | 去掉，默认全部允许 |
| Skill/Agent 数据路径 | 通过 WS 与 sidecar 双向同步（前后端一起做） |
| 扫描导入流程 | 选源 → 扫描 → 勾选 → 导入（四步流程） |
| 保存模式 | 所有变更通过 WS 实时同步（toggle、编辑、删除均立即生效） |
| Agent 扫描来源 | Pi / Claude Code / Agents 三处（与 Skill 一致） |

---

## 2. WS Protocol Extension

Sidecar 需新增以下消息类型：

### 2.1 Skill Messages

```
// 扫描指定路径下的 Skill
→ config.scanSkills   { sources: string[] }
← config.scannedSkills { skills: ScannedSkillInfo[], success: boolean, error?: string }

// 创建或更新 Skill
→ config.setSkill     { skill: SkillInfo }
← config.skillUpdated { skill: SkillInfo, success: boolean, error?: string }

// 删除 Skill
→ config.deleteSkill  { skillId: string }
← config.skillDeleted { skillId: string, success: boolean, error?: string }

// Skill 启停（复用 setSkill，只传 enabled 字段）
→ config.setSkill     { skillId: string, enabled: boolean }
```

### 2.2 Agent Messages

```
// 扫描指定路径下的 Agent（支持 Pi / Claude Code / Agents 三处来源）
→ config.scanAgents   { sources: string[] }
← config.scannedAgents { agents: ScannedAgentInfo[], success: boolean, error?: string }

// 创建或更新 Agent
→ config.setAgent     { agent: AgentInfo }
← config.agentUpdated { agent: AgentInfo, success: boolean, error?: string }

// 删除 Agent
→ config.deleteAgent  { agentId: string }
← config.agentDeleted { agentId: string, success: boolean, error?: string }
```

### 2.3 Default Scan Paths

| Source | Skill Path | Agent Path |
|--------|-----------|------------|
| Pi | `~/.pi/agent/skills/` | `~/.pi/agent/agents/` |
| Claude Code | `~/.claude/skills/` | `~/.claude/agents/` |
| Agents | `~/.agents/skills/` | `~/.agents/agents/` |

### 2.3 Shared Types (新增)

```typescript
// src-electron/shared/src/types.ts

type ScanSourceType = 'pi' | 'claude' | 'agents' | 'custom'

interface ScannedSkillInfo {
  id: string           // 基于路径生成的唯一 ID
  name: string
  description: string
  sourceType: ScanSourceType
  sourcePath: string   // 完整文件路径
  triggers: string[]
  content: string      // SKILL.md 内容
  fileSize?: string
  tools?: string[]
  alreadyImported: boolean  // 是否已在列表中
}

interface ScannedAgentInfo {
  id: string
  name: string
  description: string
  sourceType: ScanSourceType  // 与 Skill 共享类型
  sourcePath: string
  content: string    // agent 配置文件内容
  icon?: string
  tools?: string[]
  alreadyImported: boolean
}
```

---

## 3. Sidecar Implementation

### 3.1 Files to modify

| File | Change |
|------|--------|
| `src-electron/sidecar/src/handlers/config.ts` | 新增 scanSkills / setSkill / deleteSkill / scanAgents / setAgent / deleteAgent handlers |
| `src-electron/sidecar/src/services/skill-scanner.ts` | **新建**。扫描目录、解析 SKILL.md、返回 ScannedSkillInfo[] |
| `src-electron/sidecar/src/services/agent-scanner.ts` | **新建**。扫描目录、解析 agent 配置、返回 ScannedAgentInfo[] |
| `src-electron/sidecar/src/services/config-store.ts` | 扩展：新增 skills/agents 的持久化读写（JSON 文件） |
| `src-electron/shared/src/types.ts` | 新增 ScannedSkillInfo / ScannedAgentInfo 类型 |

### 3.2 Skill Scanner 逻辑

```pseudo
scanSkills(sources: string[]):
  results = []
  for source in sources:
    dir = expandTilde(source)  // ~/.pi/agent/skills/ → /Users/x/.pi/agent/skills/
    if !exists(dir): continue
    for entry in readdir(dir):
      if !isDirectory(entry): continue
      skillMd = join(entry, "SKILL.md")
      if !exists(skillMd): continue
      parsed = parseSkillMd(readFile(skillMd))
      results.push({
        id: generateId(source, entry.name),
        name: entry.name,
        description: parsed.description,
        sourceType: mapSourceType(source),
        sourcePath: skillMd,
        triggers: parsed.triggers,
        content: readFile(skillMd),
        alreadyImported: isImported(entry.name)
      })
  return results
```

### 3.3 Config Store 扩展

Skills 和 Agents 持久化到项目级配置文件：

```
<project>/.xyz-agent/
├── skills.json    // SkillInfo[]
└── agents.json    // AgentInfo[]
```

Sidecar 启动时加载，变更时写入。

---

## 4. Frontend Implementation

### 4.1 Component Structure (Section Groups style)

```
settings/
├── index.ts                     // barrel exports
├── ProviderPane.vue             // ← 重写
├── ProviderSection.vue          // **新建**。单个 Provider 的 section（header + model list）
├── ProviderModal.vue            // ← 保留，微调样式
├── ModelRow.vue                 // ← 保留，微调样式
├── SkillsPane.vue               // ← 重写
├── SkillSection.vue             // **新建**。单个 Skill 的 section
├── SkillModal.vue               // ← 保留，微调样式
├── ScanImportSection.vue        // **新建**。通用扫描导入组件（Skill/Agent 共用）
├── AgentsPane.vue               // ← 重写
├── AgentSection.vue             // **新建**。单个 Agent 的 section
├── AgentModal.vue               // ← 保留，微调样式
├── SystemPane.vue               // ← 重写
├── shared/
│   ├── index.ts
│   ├── ToggleSwitch.vue         // ← 保留
│   ├── MetaGrid.vue             // ← 保留
│   ├── MarkdownEditor.vue       // ← 保留
│   ├── TagPill.vue              // ← 保留
│   └── ImportSection.vue        // ← 删除（被 ScanImportSection 替代）
├── GlobalParams.vue             // ← 删除（Agent 不再需要参数覆盖）
├── OverrideParams.vue           // ← 删除
├── ToolPermissions.vue          // ← 删除
├── SkillImportSection.vue       // ← 删除（被 ScanImportSection 替代）
├── ModelStrategyConfig.vue      // ← 保留，嵌入 AgentSection
├── SkillCard.vue                // ← 删除（被 SkillSection 替代）
├── AgentCard.vue                // ← 删除（被 AgentSection 替代）
├── ProviderCard.vue             // ← 删除（被 ProviderSection 替代）
├── ProviderList.vue             // ← 删除（旧版兼容）
├── ProviderForm.vue             // ← 删除（旧版兼容）
├── SkillsTab.vue                // ← 删除（旧版兼容）
└── AgentsTab.vue                // ← 删除（旧版兼容）
```

### 4.2 Key Components Detail

#### ScanImportSection.vue（通用扫描导入）

**Props**:
```typescript
{
  title: string                          // "扫描并导入 Skill" 或 "扫描并导入 Agent"
  sources: SourceOption[]                // 预定义来源列表
  scanEvent: string                      // WS 事件名: 'config.scanSkills' | 'config.scanAgents'
  scannedEvent: string                   // WS 返回事件: 'config.scannedSkills' | 'config.scannedAgents'
  existingItems: { id: string; name: string }[]  // 已导入列表（用于标记 alreadyImported）
  importFn: (items: ScannedItem[]) => void       // 导入回调
}

interface SourceOption {
  id: string
  icon: string           // 单字母 "P" | "C" | "A"
  label: string          // "Pi Skills"
  path: string           // "~/.pi/agent/skills/"
  defaultActive?: boolean
}

// Skill 默认来源
const SKILL_SOURCES: SourceOption[] = [
  { id: 'pi', icon: 'P', label: 'Pi Skills', path: '~/.pi/agent/skills/', defaultActive: true },
  { id: 'claude', icon: 'C', label: 'Claude Code', path: '~/.claude/skills/' },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/skills/' },
]

// Agent 默认来源
const AGENT_SOURCES: SourceOption[] = [
  { id: 'pi', icon: 'P', label: 'Pi Agents', path: '~/.pi/agent/agents/', defaultActive: true },
  { id: 'claude', icon: 'C', label: 'Claude Code', path: '~/.claude/agents/' },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/agents/' },
]
```

**交互流程**:
1. 渲染 source chips（默认选中 defaultActive 的），可多选 toggle，选中状态实时反映在 `已选 N 个来源` 文案中
2. 底部自定义路径输入 + "添加" 按钮 → 添加新 chip
3. "扫描" 按钮（按钮文案不含数量）→ `send({ type: scanEvent, payload: { sources } })`
4. Loading spinner 替换 `已选 N 个来源` 文案
5. 监听 `scannedEvent` → 渲染 scan-results 列表（带入场动画）
6. 每个结果行有 checkbox，`alreadyImported` 的禁用 + 显示"已导入"badge
7. 底部 "导入选中 N 个" → 调用 `importFn` → toast 反馈 → 结果列表收起

#### ProviderSection.vue

**Props**: `{ provider: ProviderInfo, models: ModelInfo[] }`

**Emits**: `toggle-enabled`, `toggle-model`, `edit`, `delete`, `test`

**Structure**:
```
<section>
  <section-header>
    avatar + name + status dot + baseUrl
    badge(N models) + toggle + 编辑 + 删除
  </section-header>
  <section-body>
    <item-row v-for="model in models">
      toggle + name + ctx + tag-pills
    </item-row>
  </section-body>
</section>
```

不需要展开/折叠。Provider 的模型直接平铺在 section 内（因为 Provider 通常只有 2-5 个模型）。

#### SkillSection.vue

**Props**: `{ skill: SkillInfo }`

**Emits**: `toggle-enabled`, `edit`, `delete`

点击行展开/收起 detail-grid，chevron 旋转动画。

**Structure**:
```
<section>
  <section-header>
    name + description
    toggle + 编辑 + 删除
  </section-header>
  <detail-grid v-if="expanded"> (点击行 toggle 展开)
    名称 / 触发词 / 来源 / 依赖工具
  </detail-grid>
</section>
```

#### AgentSection.vue

**Props**: `{ agent: AgentInfo, allModels: ModelInfo[] }`

**Emits**: `toggle-enabled`, `edit`, `delete`, `update:strategy`

Agent section 不折叠，模型策略和工具信息直接平铺在 section-body 内。

**Structure**:
```
<section>
  <section-header>
    avatar + name + strategy label + source
    toggle + 编辑 + 删除
  </section-header>
  <section-body v-if="expanded"> (点击行 toggle 展开)
    <item-row> 模型策略: select(auto/tag/bind) </item-row>
    <item-row> 工具: read, edit, write, bash </item-row>
  </section-body>
</section>
```

#### SystemPane.vue

**Structure**: 两个 section（语言与外观 + 配色主题），保持当前功能不变，样式对齐 Section Groups。

### 4.3 Store Changes

#### `stores/provider.ts`

新增：
```typescript
// 新增 skills/agents 的 WS 事件监听
// 新增 scannedSkills / scannedAgents 状态（扫描结果）
// 新增 scanSkills(sources) / scanAgents(sources) actions
// 新增 importSkills(items) / importAgents(items) actions
```

#### `stores/settings.ts`

移除：
- `toolPermissions` 及相关方法

### 4.4 Composable Changes

#### `composables/useProvider.ts`

扩展：注册新事件监听（`config.scannedSkills`、`config.scannedAgents`、`config.skillUpdated`、`config.agentUpdated`）。

---

## 5. Task Breakdown

### Phase 1: Sidecar Backend

| # | Task | Files | Est. |
|---|------|-------|------|
| S1 | 新增 ScannedSkillInfo / ScannedAgentInfo 类型 | `shared/src/types.ts` | 30min |
| S2 | 新建 skill-scanner 服务 | `sidecar/src/services/skill-scanner.ts` | 1h |
| S3 | 新建 agent-scanner 服务 | `sidecar/src/services/agent-scanner.ts` | 1h |
| S4 | 扩展 config-store：skills/agents 持久化 | `sidecar/src/services/config-store.ts` | 45min |
| S5 | 新增 config handler: scan/set/delete for skill & agent | `sidecar/src/handlers/config.ts` | 1h |
| S6 | 集成测试：验证 WS 消息收发 | `tools/verify-*.cjs` | 30min |

### Phase 2: Frontend Components

| # | Task | Files | Est. |
|---|------|-------|------|
| F1 | 删除废弃组件 (6 files) | Card/List/Form/Tab/ToolPermissions/OverrideParams | 10min |
| F2 | 新建 ScanImportSection.vue | `settings/ScanImportSection.vue` | 2h |
| F3 | 重写 ProviderPane + ProviderSection | `settings/ProviderPane.vue`, `settings/ProviderSection.vue` | 1.5h |
| F4 | 重写 SkillsPane + SkillSection | `settings/SkillsPane.vue`, `settings/SkillSection.vue` | 1.5h |
| F5 | 重写 AgentsPane + AgentSection | `settings/AgentsPane.vue`, `settings/AgentSection.vue` | 1.5h |
| F6 | 重写 SystemPane | `settings/SystemPane.vue` | 30min |
| F7 | 更新 index.ts barrel | `settings/index.ts` | 10min |
| F8 | 更新 SettingsView.vue（tab 切换逻辑不变，样式微调） | `layout/SettingsView.vue` | 20min |

### Phase 3: Store & Composable

| # | Task | Files | Est. |
|---|------|-------|------|
| D1 | 扩展 provider store（scan/import/delete for skill & agent） | `stores/provider.ts` | 1h |
| D2 | 清理 settings store（移除 toolPermissions） | `stores/settings.ts` | 15min |
| D3 | 扩展 useProvider composable（新事件注册） | `composables/useProvider.ts` | 30min |

### Phase 4: Integration & Polish

| # | Task | Files | Est. |
|---|------|-------|------|
| P1 | 连通前后端：Provider Section 样式验证 | - | 30min |
| P2 | 连通前后端：Skill scan → import 全流程 | - | 45min |
| P3 | 连通前后端：Agent scan → import 全流程 | - | 45min |
| P4 | 删除确认交互 + inline toast | - | 30min |
| P5 | 视觉打磨：间距、对齐、动画一致性 | - | 30min |

### Dependencies

```
S1 → S2, S3 → S4 → S5 → S6
F1 → F2 (ScanImportSection 是 Skill/Agent 的依赖)
F2 → F4, F5
D1 → F4, F5
S6 + F2 + D1 → P2, P3
```

Phase 1 (S1-S6) 和 Phase 2 的 F1/F3/F6/F7/F8 可以并行。
F2 和 D1 需要等 S1 完成。
P2/P3 需要等前后端都就绪。

---

## 6. Visual Reference

**最终设计 demo**: [settings-final.html](./settings-final.html)

关键视觉要点：
- 每个 Provider/Agent 是一个独立的 section（圆角 8px，border，section-header 有浅底色）
- Provider 的模型直接平铺在 section-body 内（不折叠）
- Skill 展开后显示 detail-grid（点击行 toggle）
- Agent 展开后显示 inline 属性行（策略 select + 工具列表）
- 扫描导入区是一个特殊的 section：source chips → 扫描按钮 → results with checkbox → 导入按钮
- 删除确认用 section 内的 confirm-bar（不是 modal）
- 操作反馈用底部 inline toast
