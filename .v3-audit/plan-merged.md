# v3 审查执行计划（合并版 · 正式）

> 基于 `plan-A-topdown.md`（14 wave / 88 锚点）与 `plan-B-bottomup.md`（6 wave / 10 全局项）合并。
> 策略：双向交叉 + 全审后统一修复。本文件是执行编排的唯一依据。

## 一、合并后的 wave 总览（19 wave · 拓扑执行序）

| 序 | Wave 编号 | 类型 | 区域 | 层级范围 | 锚点/文件数 | 依赖 | 来源 |
|---|---|---|---|---|---|---|---|
| W01 | B-CS | 全局根因 | style.css + stores + composables + App.vue + types.ts | 全局 | 10 文件 | — | B-W6 |
| W02 | B-UI | 自底向上 | components/ui/（6 组 24 文件） | 原语层 | 24 文件 | — | B-W5 |
| W03 | A-SH | 自顶向下 | Shell | L0-L2 | 8 锚点 | — | A-SH-W1 |
| W04 | B-SH | 独立多余 | Shell（同 W03 文件） | L0-L1 | 5 文件 | W03 | B-SH-W2 |
| W05 | A-SB-C | 自顶向下 | Sidebar 容器（四态 + 收起 + 搜索入口） | L2-L3 | 6 锚点 | — | A-SB-W1 |
| W06 | B-SB | 独立多余 | Sidebar（同 W05+W07+W08 文件） | L1-L3 | 4 文件 | W05 | B-SB-W3 |
| W07 | A-SB-I | 自顶向下 | SessionItem 5 态 + 激活 + 右键 | L3-L4 | 5 锚点 | W05 | A-SB-W2 |
| W08 | A-SB-F | 自顶向下 | FileView 文件树 + git 标注 + 过滤 | L3-L4 | 5 锚点 | W05 | A-SB-W3 |
| W09 | A-WP-T | 自顶向下 | Workspace 双 Panel 主从 + 四层激活 | L1-L2 | 6 锚点 | — | A-WP-W1 |
| W10 | A-WP-H | 自顶向下 | PanelHeader + Breadcrumb popover | L2-L3 | 5 锚点 | W09 | A-WP-W2 |
| W11 | A-WP-M | 自顶向下 | MessageStream 7 类块 + 回合折叠 + 变更集卡 | L2-L4 | 10 锚点 | W10 | A-WP-W3 |
| W12 | A-WP-C | 自顶向下 | Composer 8+ 态 + 工具区 + @浮层 | L2-L4 | 9 锚点 | W09 | A-WP-W4 |
| W13 | A-WP-Z | 自顶向下 | Companion Zones（progress + git） | L3-L4 | 8 锚点 | W09 | A-WP-W5 |
| W14 | A-WP-D | 自顶向下 | Side Drawer + 反向联动 | L3-L4 | 7 锚点 | W11 | A-WP-W6 |
| W15 | A-OL | 自顶向下 | SearchModal ⌘K | L1-L3 | 7 锚点 | — | A-OL-W1 |
| W16 | B-OVS | 独立多余 | Overview + Overlays + Settings（4 文件） | L1-L3 | 4 文件 | W15 | B-OV-W4 |
| W17 | A-OV | 自顶向下 | Overview 卡片网格 + 筛选 + 入口 | L1-L3 | 9 锚点 | W07 | A-OV-W1 |
| W18 | A-ST-S | 自顶向下 | Settings Modal 骨架 + 三模式 + 公共横切 | L2-L3 | 7 锚点 | — | A-ST-W1 |
| W19 | A-ST-M | 自顶向下 | Settings 5 菜单页详细内容 | L3-L4 | 6 锚点 | W18 | A-ST-W2 |

**统计**：
- 自顶向下（A）：14 wave / 100 锚点（含合并后重编号的 A-WP 6 wave）
- 自底向上独立（B-UI）：1 wave / 24 文件
- 全局根因（B-CS）：1 wave / 10 文件
- 独立多余（B-SH、B-SB、B-OVS）：3 wave / 13 文件
- **总 19 wave**

## 二、依赖拓扑图（决定并行/串行）

```
[第 0 层 · 全局根因 · 串行 · 必须最先]
W01 (B-CS)  全局根因（token / 主题 / stores / composables）
   │
   ▼ 横切影响：若发现根因，下游所有 wave 需带"根因表现"识别任务
   │
[第 1 层 · 无相互依赖 · 全并行]
W02 (B-UI)  ──┐
W03 (A-SH)   ─┤
W05 (A-SB-C) ─┤   ← 5 个 wave 全并行
W09 (A-WP-T) ─┤
W15 (A-OL)   ─┤
W18 (A-ST-S) ─┘
   │
   ▼
[第 2 层 · 各依赖第 1 层对应 wave]
W04 (B-SH)   ← W03   ← 注意：W04 与 W03 同文件，必须 W03 先审完
W06 (B-SB)   ← W05   ← 同上，W06 与 W05/W07/W08 同文件
W07 (A-SB-I) ← W05
W08 (A-SB-F) ← W05
W10 (A-WP-H) ← W09
W12 (A-WP-C) ← W09
W13 (A-WP-Z) ← W09
W19 (A-ST-M) ← W18
   │
   ▼
[第 3 层 · 依赖第 2 层]
W11 (A-WP-M) ← W10
   │
   ▼
[第 4 层 · 依赖第 3 层]
W14 (A-WP-D) ← W11
W17 (A-OV)   ← W07   ← SessionItem 原子复用确认
   │
   ▼
[第 5 层 · 依赖第 1/2 层]
W16 (B-OVS)  ← W15/W17/W18  ← Overview/Overlays/Settings 同文件多余补充
```

## 三、并行批次规划（实际派遣节奏）

> 约束：同一时刻 background subagent ≤5 个（全局 CLAUDE.md 约束）。同文件 wave 必须串行（A 先审、B 后补多余）。

### 批次 0 · 全局根因（1 个 subagent，串行）
- **W01 (B-CS)**：style.css + stores + composables + App.vue + types.ts
- **产出要求**：除常规三态判定外，**额外输出"全局根因清单"**——token 是否接入、主题默认值、settingsStore 是否存在、dropdown-menu 是否冗余、style.css vs design-tokens.md 同步性。这些根因会横切影响下游 wave。
- **完成门槛**：根因清单明确（每条标"已确认根因"或"疑似根因，待下游验证"）。

### 批次 1 · 全并行（5 个 subagent）
W02 B-UI ｜ W03 A-SH ｜ W05 A-SB-C ｜ W09 A-WP-T ｜ W15 A-OL + W18 A-ST-S（合 1 个 subagent，因 A-OL 和 A-ST 都无依赖且锚点较少，7+7=14 锚点一个 subagent 可承担）

实际分派（5 个）：
- **subagent-1**：W02 (B-UI)
- **subagent-2**：W03 (A-SH)
- **subagent-3**：W05 (A-SB-C)
- **subagent-4**：W09 (A-WP-T)
- **subagent-5**：W15 (A-OL) + W18 (A-ST-S) 合并

### 批次 2 · 第 1 层依赖（5 个 subagent）
W04 B-SH ｜ W06 B-SB ｜ W07 A-SB-I ｜ W10 A-WP-H ｜ W12 A-WP-C + W13 A-WP-Z（合 1 个）

实际分派（5 个）：
- **subagent-1**：W04 (B-SH) ← W03 完成
- **subagent-2**：W06 (B-SB) ← W05 完成
- **subagent-3**：W07 (A-SB-I) + W08 (A-SB-F) 合并 ← W05 完成
- **subagent-4**：W10 (A-WP-H) ← W09 完成
- **subagent-2**：W12 (A-WP-C) ← W09 完成
- **subagent-5**：W13 (A-WP-Z) ← W09 完成

（注：W07+W08 合并，因都是 Sidebar 子视图且锚点少 5+5=10，一个 subagent 可承担。腾出槽位给 WP 重区。）

### 批次 3 · 深度依赖（3-4 个 subagent）
- **subagent-1**：W11 (A-WP-M) ← W10 完成（最重 wave，10 锚点）
- **subagent-2**：W19 (A-ST-M) ← W18 完成
- **subagent-3**：W17 (A-OV) ← W07 完成

### 批次 4 · 收尾（2 个 subagent）
- **subagent-1**：W14 (A-WP-D) ← W11 完成
- **subagent-2**：W16 (B-OVS) ← W15/W17/W18 完成

## 四、关键约束（所有执行 subagent 必须遵守）

1. **输出文件**：每个 wave 产出一份 `wave-<W##>-<区域>.md`，放在 `.v3-audit/results/` 下。
2. **格式**：严格遵守 `.v3-audit/audit-template.md`（三态 + 🆕多余 + 双证据 + 根因标签）。
3. **不修复**：只记录不改动代码。
4. **根因横切识别**：W01 完成后，下游 wave 审查时若发现问题与 W01 根因清单相关，标注 `根因关联→W01-<根因ID>`，不重复记录为独立 bug。
5. **同文件串行**：A 类 wave 与对应的 B-多余 wave（W03↔W04、W05↔W06、W15↔W16、W17↔W16）必须 A 先审完才派 B。
6. **路径含空格**：访问 Open Design 目录必须 bash 加引号。

## 五、产出聚合（所有 wave 完成后）

1. **`.v3-audit/results/` 下 19 份 wave 报告**。
2. **阶段 C · 根因归类**：读取全部 19 份报告，按根因聚类，产出 `phase-C-rootcause.md`（根因清单 + 优先级 + 修复建议）。
3. **阶段 D · 统一修复**：按阶段 C 的优先级逐个修复，每修一个根因验证一次。

## 六、wave ↔ 计划映射（溯源）

| Wave | 来自 A 计划 | 来自 B 计划 | 说明 |
|---|---|---|---|
| W01 (B-CS) | — | B-W6 | 全局根因，提前到第 0 层 |
| W02 (B-UI) | — | B-W5 | UI 原子层 |
| W03 (A-SH) | A-SH-W1 | — | Shell 自顶向下 |
| W04 (B-SH) | — | B-SH-W2 | Shell 独立多余（W03 后） |
| W05 (A-SB-C) | A-SB-W1 | — | Sidebar 容器 |
| W06 (B-SB) | — | B-SB-W3 | Sidebar 独立多余（W05 后） |
| W07 (A-SB-I) | A-SB-W2 | — | SessionItem |
| W08 (A-SB-F) | A-SB-W3 | — | FileView |
| W09 (A-WP-T) | A-WP-W1 | — | Workspace 拓扑 |
| W10 (A-WP-H) | A-WP-W2 | — | PanelHeader |
| W11 (A-WP-M) | A-WP-W3 | — | MessageStream |
| W12 (A-WP-C) | A-WP-W4 | — | Composer |
| W13 (A-WP-Z) | A-WP-W5 | — | Companion Zones |
| W14 (A-WP-D) | A-WP-W6 | — | Side Drawer |
| W15 (A-OL) | A-OL-W1 | — | Overlays |
| W16 (B-OVS) | — | B-OV-W4 | OV/OL/ST 独立多余 |
| W17 (A-OV) | A-OV-W1 | — | Overview |
| W18 (A-ST-S) | A-ST-W1 | — | Settings 骨架 |
| W19 (A-ST-M) | A-ST-W2 | — | Settings 菜单页 |

## 七、下一步

等批次 0（W01 全局根因）完成，拿到根因清单后，再开批次 1 的 5 个并行 subagent。W01 的根因清单会写入下游所有 subagent 的 prompt（让它们识别根因表现，避免重复记录）。
