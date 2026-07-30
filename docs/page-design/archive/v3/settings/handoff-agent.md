# Handoff · settings · Agent

> Agent 菜单 · 左导航第 3 项。
> **配置面 + 只读预览**——管「加载哪些 agent」，不管「agent 怎么行为」。
> 真身：`draft-settings-agent.html`（细化稿）+ `adr/0020-resource-loading-strategy.md`（加载策略）+ `panel/draft-project-settings-drawer.html`（项目维度只读生效视图）。

## 0. ★行为契约不进本菜单（消除悬空的裁决）

旧版 handoff 曾把「默认 thinking level / 自动批准边界 / 工具权限矩阵 / 系统提示词覆盖」放进 Agent 菜单（对齐 PRODUCT）。**现裁决：这些不进 Agent 菜单**，理由：

- 单个 agent 的行为定义在 **agent.md 文件内容**（frontmatter `model`/`tools` + 正文 system prompt）——UI 不编辑文件内容，与 ADR-0020「实体只读」原则一致。
- 要细粒度控制某个 agent：去目录里改/删文件，或用 pi 的命令（draft 设计说明原文）。
- 会话级/全局行为契约（PRODUCT 的 thinking 默认值、自动批准边界）若需要，落点由 PRODUCT/design 层明确，**不在本 handoff 范围**。
- 本菜单唯一职责：**勾选加载路径**（写 `discovery.json` 的 `agentDirs`）+ **只读预览扫到的 subagent**。

## 1. 定位

- 形态：**两层**。
  - **层 A · 加载路径**：强制目录（置顶·不可关·不可拖）+ 可选目录（可勾选·可拖排序）。写 `discovery.json` 的 `agentDirs`。
  - **层 B · subagent 只读预览**：扫到的 agent 按来源 badge 排序，最优先标「生效」，同名合并显示。
- 主用模式：层 A = 自定义「目录勾选 + 拖动排序」控件（非标准三模式）；层 B = **C · Entity List 只读子集**（去启用开关/展开，加多源 badge 链）。

## 2. 数据模型

```
// discovery.json（写层 A 的勾选结果）
{
  agentDirs: string[]   // 可选目录有序数组，靠前覆盖靠后（ADR-0020 §1.1 层 3）
}

// 强制目录（运行时硬编码，不写 discovery.json）
//   全局 ~/.xyz-agent/agents   层 1
//   项目 .xyz-agent/agents     层 2  （强制项目 > 强制全局，PRODUCT「项目覆盖全局」）

// 层 B 预览（只读，主进程 AgentRegistry 扫描结果）
SubagentPreview { name, source: 'pi'|'claude'|'agents',
                  sourcePath, effective: bool,   // 最优先同名标 true
                  description }
```

## 3. 布局（对齐 draft-settings-agent.html）

- page-header：`Agent` + 「加载路径勾选 + subagent 只读预览」。
- **层 A · 加载路径**（上半）：
  - 组 1「强制 · xyz-agent 运行时」：`~/.xyz-agent/agents`（全局）+ `.xyz-agent/agents`（项目）。灰显·置顶·hint「不可关·不可拖·最高优先（ADR-0020 §1.1 层 1-2）」。
  - 组 2「可选 · 拖动排序」：`~/.pi` · `~/.claude` · `~/.agents`（全局）· `.agents`（项目）。每行 = checkbox + 路径（mono）+ ⠿ 拖把手。hint「靠前覆盖靠后·写 agentDirs（§1.1 层 3）」。
- **层 B · subagent 预览**（下半，`#cntPill` 计数）：
  - entity 行 = name + 多源 badge 链（`pi`/`claude`/`agents`，色编；项目来源排前）+ 第一个标「生效」pill + description。
  - 被覆盖来源以 `<dl>` 折叠展示路径 + 覆盖原因。

## 4. 关键交互

- **可选目录拖动排序**：⠿ 拖拽 → 实时重排 → 写 `agentDirs` 数组顺序。靠前覆盖靠后。
- **勾选/取消**：写 `agentDirs` 增删。自动保存 pill（debounce）。
- **覆盖顺序**（ADR-0020 §1.1）：强制目录 > 可选目录；强制项目 > 强制全局；可选内靠前 > 靠后。同名 agent 在层 B 合并显示，来源 badge 链第一个标「生效」。
- **生效时机**（ADR-0020 §5 ui_limit）：agent `.md` 仅主进程 AgentRegistry 扫描，**会话启动时生效**。改 `agentDirs` 后需重开会话才加载新目录；切项目同理需重开。skill 不受此约束。

## 5. 项目维度（只读，不在本菜单配）

项目级 agent 实际生效情况在 **项目设置抽屉**（`panel/draft-project-settings-drawer.html`）只读查看：顶部 Tab 切 Agent/Skill，每资源按来源 badge 排序，最优先标生效，同名项目覆盖全局。**抽屉不存配置**，加载路径在本菜单（全局 Settings）统一勾选（决策 `global_configures_project`）。

## 6. 字段溯源（来源 .vue，仅历史参考）

| 旧字段 | 来源 | 现状 |
|---|---|---|
| `AgentInfo { id, name, description, enabled, modelStrategy, content }` | `AgentsPane.vue` / `AgentModal.vue` / `AgentSection.vue` / `ScanImportSection.vue` | **废弃**（CRUD/启用开关/扫描导入不再用，见 §0）|

## 7. 校验 / 状态

- 字段级：无用户输入字段（路径预设，拖拽不改文本）。
- 状态：加载中（AgentRegistry 扫描）/ 已加载（N 项）/ 空（无目录勾选或目录无 .md）。
- 保存：`agentDirs` 改动 debounce 自动保存。

## 8. 验收 P0（对齐 draft-settings-agent.html）

- [ ] 层 A 强制目录灰显置顶、不可关不可拖
- [ ] 层 A 可选目录可勾选、可拖排序，结果写 `agentDirs`
- [ ] 层 B subagent 计数正确，多源 badge 链第一个标「生效」
- [ ] 被覆盖来源展示路径 + 覆盖原因（强制>可选、项目>全局、靠前>靠后）
- [ ] 改 `agentDirs` 后提示「需重开会话生效」（ADR-0020 §5）

## 9. 参考

- 真身：`draft-settings-agent.html` / `adr/0020-resource-loading-strategy.md`（§1.1 优先级 / §5 实体只读·会话启动生效）/ `panel/draft-project-settings-drawer.html`（项目只读视图）/ `spec.md` §3 模式 C 只读子集 / §4 Agent 行
- 废弃模型：见 git 历史（行为契约/CRUD 不再实现，§0 已裁决落点）
- 对齐：`PRODUCT.md`（项目覆盖全局）/ `design-system.md`
