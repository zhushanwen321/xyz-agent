# Handoff · settings · Skill

> Skill 菜单 · 左导航第 2 项。
> **配置面 + 只读预览**——与 Agent 页**同构**（同一套层 A 加载路径 + 层 B 只读预览 + 多源 badge）。差异：① 写 `skillDirs`；② 多一类来源 **pi-install**（只读，不进 discovery.json）。
> 真身：`draft-settings-skill.html` + `adr/0020-resource-loading-strategy.md` + `panel/draft-project-settings-drawer.html`。

## 1. 定位

- 形态：**两层**（同 Agent）。
  - **层 A · 加载路径**：强制目录（置顶·不可关）+ 可选目录（可勾选·可拖）。写 `discovery.json` 的 `skillDirs`。
  - **层 B · skill 只读预览**：按来源 badge 排序，最优先标「生效」；pi-install skill 单列只读。
- 主用模式：层 A = 目录勾选 + 拖动排序控件；层 B = **C · Entity List 只读子集**。

## 2. 与 Agent 的差异（关键）

| 维度 | Skill | Agent |
|---|---|---|
| discovery.json 字段 | `skillDirs` | `agentDirs` |
| 强制目录 | `~/.xyz-agent/skills` + `.xyz-agent/skills` | `…/agents` |
| pi 原生扫描 | skill 是 pi 4 类资源之一，pi 原生扫（重定向到 xyz-agent 目录）| pi 原生**不扫** subagent .md，全靠 discovery 注入 |
| pi-install 来源 | **有**（来源 A，只读 pill，不进 discovery.json） | **无** |
| 生效时机 | 即时（skill 不受 AgentRegistry 单例约束）| 会话启动生效，改后需重开（ADR-0020 §5）|

ADR-0020 §1.1 修正：重定向后 skill 与 agent 加载模型**统一**（强制=xyz-agent目录 / 可选=外部目录），pi 原生复杂优先级被桥接层屏蔽。

## 3. 数据模型

```
// discovery.json
{
  skillDirs: ["~/.pi/agent/skills", "~/.claude/skills", "~/.agents/skills", ".agents/skills"]
  // 有序数组，靠前覆盖靠后（ADR-0020 §1.1 层 3）
}

// 强制目录（硬编码，不进 discovery.json）
//   ~/.xyz-agent/skills  全局（层 1-2，经重定向）
//   .xyz-agent/skills    项目（强制项目 > 强制全局）

// pi-install skill（来源 A，正交）
//   存 <agentDir>/settings.json 的 enabledSkills，子进程读同文件继承
//   不进 discovery.json，UI 只读呈现，由 pi /skills 命令管理

// 层 B 预览（只读）
SkillPreview { name, source: 'pi'|'claude'|'agents'|'piinstall',
               sourcePath, effective: bool, description }
```

## 4. 布局（对齐 draft-settings-skill.html）

- page-header：`Skill` + 来源 tab（全部·Pi·Claude·Agents·pi-install 只读）+ 计数。
- **层 A · 加载路径**（同 Agent 结构）：
  - 组 1 强制：`~/.xyz-agent/skills`（全局）+ `.xyz-agent/skills`（项目，覆盖全局）。
  - 组 2 可选可拖：`~/.pi` · `~/.claude` · `~/.agents` · `.agents`。
  - pi-install info 行：来源 A 说明（不进 discovery.json，只读，由 pi 管理）。
- **层 B · skill 预览**（`#cntPill`）：
  - entity 行 = name + 多源 badge 链 + 「生效」pill + description。
  - pi-install entity：badge 标 `pi-install`，无开关（只读）。

## 5. 关键交互

- **可选目录拖动排序**：写 `skillDirs` 数组顺序，靠前覆盖靠后。
- **覆盖顺序**（ADR-0020 §1.1）：强制 > 可选；强制项目 > 强制全局；可选内靠前 > 靠后。同名合并，badge 第一个标生效。
- **pi-install**：只读呈现，不可在 UI 增删启停（归 pi `/skills` 命令）。
- **生效时机**：skill 改动即时生效（不受 AgentRegistry 单例约束，与 agent 不同）。

## 6. 项目维度（只读，不在本菜单配）

项目级 skill 生效情况在 **项目设置抽屉**（`panel/draft-project-settings-drawer.html`）只读查看：Tab 切 Skill，来源 badge 排序，最优先标生效，项目覆盖全局。加载路径在本菜单统一勾选（`global_configures_project`）。

## 7. 字段溯源（来源 .vue，仅历史参考）

| 旧字段 | 来源 | 现状 |
|---|---|---|
| `SkillInfo { id, name, description, enabled, source, triggers, content }` | `SkillsPane.vue` / `SkillModal.vue` / `SkillSection.vue` / `ScanImportSection.vue` | **废弃**（扫描导入/手动添加/CRUD/启用开关不再用，改只读预览）|

## 8. 校验 / 状态

- 字段级：无用户输入字段（路径预设）。
- 状态：加载中 / 已加载（N 项，分来源计数）/ 空。
- 保存：`skillDirs` 改动 debounce 自动保存。

## 9. 验收 P0（对齐 draft-settings-skill.html）

- [ ] 层 A 强制目录灰显置顶、可选目录可勾选可拖，写 `skillDirs`
- [ ] 层 B 来源 tab 正确（全部/Pi/Claude/Agents/pi-install 只读）
- [ ] pi-install entity 只读（无开关），badge 标 `pi-install`
- [ ] 多源 badge 链第一个标「生效」，被覆盖来源展示路径
- [ ] skill 改动即时生效（不需重开会话，区别于 agent）

## 10. 参考

- 真身：`draft-settings-skill.html` / `adr/0020-resource-loading-strategy.md`（§1.1 优先级·skill/agent 统一 / §5 实体只读）/ `panel/draft-project-settings-drawer.html` / `spec.md` §3 §4
- 同构参照：`handoff-agent.md`（Agent 页结构）
- 废弃模型：见 git 历史
- 对齐：`PRODUCT.md` / `design-system.md`
