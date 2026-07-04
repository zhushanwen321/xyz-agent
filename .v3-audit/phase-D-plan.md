# Phase D · 统一修复计划

> 日期：2026-06-21
> 前置：v3 审计 19 wave 全部完成（见 `results/wave-W*.md` + `batch-*-summary.md`）
> 决策依据：`decisions.md`（DEC-01/02/03）
> 优先级标准：user-memory「P0=整体架构 / P1=局部模块架构 / P2=确定性小局部 / P3=不确定」

## 一、核实结论（委托前必读）

审计文档行号会漂移、部分路径有误。以下为 2026-06-21 实测事实：

1. **★ 路径修正**：审计全篇写 `components/workspace/panel/`，**实际是 `components/panel/`**。workspace 下只有 Workspace.vue + PanelContainer.vue。委托 subagent 必须用修正路径。
2. **文件普遍很小**：最大 Turn.vue 198 行，panel 目录总和 846 行。subagent 瓶颈不是规模而是"同文件冲突"。
3. **RC-04 三 token 确认全缺**：style.css 仅 `--bg/--surface/--surface-hover`，无 `--surface-2/--bg-elevated/--bg-input`。design-tokens.md 同。
4. **RC-02 有预留**：style.css:11 注释"亮色变体待 settingsStore 接入"——设计已知，差落地。
5. **tailwind.config 未找到**：疑用 vite 插件（v4）。token→utility 映射机制待 T00 确认。
6. **Composer.vue 是热点**：159 行，bg+S6+工具区三处都要改，必须一次做完。

## 二、拆分原则

1. **同文件只归一个任务**（消除并行冲突源）→ Composer 热点合并到 T10
2. **同根因受害一次扫**（token 受害归 Wave 2）
3. **无依赖最大化并行**（≤5），有依赖串行

## 三、文件 → 任务归属表

| 文件 | 归属任务 |
|---|---|
| style.css + design-tokens.md + tailwind配置 | T01 |
| Input.vue + Textarea.vue | T06 |
| Panel.vue + ProgressZone.vue + GitZone.vue | T07 |
| button/index.ts + DialogContent.vue | T08 |
| SessionItem.vue | T05 |
| AppShell.vue + AppNavControls.vue + AsideRegion.vue | T09 |
| Composer.vue + design-system.md(min-h) | T10 |
| shared/message.ts | T11 |
| chat.ts + messageTurns.ts | T12 |
| Block.vue + Turn.vue + MessageStream.vue | T13 |
| dropdown-menu/* (15) | T02 |
| tooltip/* (5) + dialog{Close,Footer,Trigger,ScrollContent} | T03 |
| stores/settings.ts (新建) | T04 |

## 四、依赖图

```
T00 调研(steer/FileChanges数据源/tailwind/⌘K)
  ├─→ T01 token SSOT ──┬─→ T06 Input/Textarea
  │                    ├─→ T07 Panel/companion
  │                    ├─→ T08 Button/Dialog
  │                    └─→ T10 Composer (还需 T00)
  ├─→ T02 删dropdown ─(无下游)
  ├─→ T03 删tooltip+dialog ─(无下游)
  ├─→ T04 settingsStore骨架 ─(菜单defer)
  ├─→ T05 SessionItem ─(无下游)
  ├─→ T09 AppShell/Nav ─(无下游)
  └─→ T11 → T12 → T13 (FileChanges链, 需 T00 数据源决策)
```

## 五、波次执行总表

### Wave 0 · 前置调研（1 任务，串行先行）

| 任务 | 内容 | Agent |
|---|---|---|
| **T00** | 4 点事实查证（见 `phase-D-wave0.md`） | worker(sync) |

### Wave 1 · 无依赖并行（5 任务）

| 任务 | 簇 | 文件 | 依赖 |
|---|---|---|---|
| **T01** | R1a token SSOT | design-tokens.md + style.css + tailwind配置 + `[data-theme]`槽位 | 无 |
| **T02** | R4a | dropdown-menu/ 全删 + 清理引用 | 无 |
| **T03** | R4b | tooltip/5 + dialog未用4 + index 清理 | 无 |
| **T04** | R6 | 新建 stores/settings.ts 骨架 | 无 |
| **T05** | R3 | SessionItem.vue: grid→flex + DEC-01 inset ring(删竖条) + pulse对齐SessionCard | 无 |

### Wave 2 · token 下游（T01 完成后，4 并行）

| 任务 | 簇 | 文件 | 依赖 |
|---|---|---|---|
| **T06** | R1b | Input/Textarea: bg-surface-2 + focus ring inset + error态 | T01 |
| **T07** | R1c | Panel激活bg-elevated + Progress/Git bg-input统一 + GitZone圆角lg | T01 |
| **T08** | R1e | button 6变体对齐design-system + Dialog backdrop-blur + bg-surface + close态 | T01 |
| **T09** | R2 | AppShell圆角10px + AppNavControls折叠placement + RC-05 aside清理 | 无 |

### Wave 3 · Composer 热点（T01 + T00 后）

| 任务 | 簇 | 文件 | 依赖 |
|---|---|---|---|
| **T10** | R5 | Composer.vue 一次做完: S6(按T00结论) + 工具区欺骗UI + bg-input + DEC-02 min-h文档 | T01,T00 |

### Wave 4 · FileChanges 链（T00 数据源决策后，串行）

| 任务 | 簇 | 文件 | 依赖 |
|---|---|---|---|
| **T11** | R7-types | shared/message.ts: FileChange接口 + ChangeSetStatus + Message.fileChanges | T00 |
| **T12** | R7-store | chat.ts 块契约4→7类 + fileChanges处理 + messageTurns SystemNotice分组 | T11 |
| **T13** | R7-render | Block/Turn/MessageStream: FileChanges渲染 + OutputText中间/收尾拆分 + Reasoning独立折叠 | T12 |

> **R7 可能整体 defer**：若 T00 查实 runtime 无文件变更事件输出，R7 需先建后端通道（flow-2 范畴），T11-T13 仅做前端骨架或推迟。

## 六、明确 DEFER（登记不修）

| 项 | 原因 |
|---|---|
| Side Drawer (W14) | 全栈断层，需 flow-2/3 协同 |
| ProgressZone/GitZone 状态机 (W13) | 依赖 runtime 数据源 |
| 搜索 G-022 | 入口+⌘K+SearchModal 全缺 |
| FileView G2-003 | 完整实现未启动 |
| 消息操作菜单 (W11) | flow-2 范畴 |
| followup (W12) | G-019 DEFERRED |
| Settings 菜单内容 G3-002 | RC-01 下游，仅建 store 骨架 |
| RC-07 死骨架 | 无害 |
| RC-06 darkMode | 无表现 |
| AppNavControls 折叠冗余层 (W04) | belt-and-suspenders 无害 |

## 七、关键决策（来自 decisions.md）

- **DEC-01**：SessionItem→inset ring（删左竖条）；Panel→保留四层激活
- **DEC-02**：Composer min-height=40px（draft 为准，仅更新 design-system.md）
- **DEC-03**：Composer S6→长期实现 steer；短期兜底禁用输入。**分叉点在 T00**

## 子文档

- `phase-D-wave0.md` — T00 调研详细（首个执行）
