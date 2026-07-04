# 批次 1 审查汇总（W01 + W02 + W03 + W05 + W09 + W15 + W18）

> 审查日期：2026-06-21
> 策略：双向交叉（自顶向下 A + 自底向上 B）+ 全审后统一修复
> 本批次覆盖：全局根因 + UI 原子 + Shell + Sidebar 容器 + Workspace 拓扑 + Overlays + Settings 骨架

## 一、执行状态

**全部成功，0 subagent 失败/未完成，无需重启。**

| Wave | subagent | 报告文件 | 行数 | 状态 |
|---|---|---|---|---|
| W01 全局根因 | bg-3 | wave-W01-global.md | 274 | ✅ |
| W02 UI 原子 | bg-4 | wave-W02-ui.md | 404 | ✅ |
| W03 Shell | bg-5 | wave-W03-shell.md | 102 | ✅ |
| W05 Sidebar 容器 | bg-6 | wave-W05-sidebar-container.md | 100 | ✅ |
| W09 Workspace 拓扑 | bg-7 | wave-W09-workspace-topology.md | 186 | ✅ |
| W15 Overlays | bg-8 | wave-W15-overlays.md | 137 | ✅ |
| W18 Settings 骨架 | bg-8 | wave-W18-settings-shell.md | 147 | ✅ |

## 二、判定统计总表

| Wave | ✅ | ⚠ | ❌ | 🆕 | 根因关联 |
|---|---|---|---|---|---|
| W01 全局 | 25 | 2 | 3 | 0 | 产出 7 根因 |
| W02 UI | 0 | 12 | 4 | 23 文件 | RC-03/04/08 |
| W03 Shell | 6 | 1 | 1 | 0 | RC-05 |
| W05 Sidebar 容器 | 2 | 3 | 1 | 0 | 0 |
| W09 Workspace 拓扑 | 4 | 1 | 1 | 0 | 0 |
| W15 Overlays | 0 | 2 | 5 | 0 | 0 |
| W18 Settings 骨架 | 2 | 2 | 3 | 0 | RC-01×3 |
| **合计** | **39** | **23** | **18** | **23** | — |

> 多数 ❌ 是已知 DEFERRED（G-022 搜索、G2-003 FileView、G-033 ⌘B、G-023 SideDrawer），非遗漏。真正意外缺失集中在 W02 UI 原子层（shadcn 全量 copy 未裁剪）。

## 三、W01 全局根因清单（7 条 · 横切下游）

| ID | 严重度 | 根因 | 判定 | 治理 |
|---|---|---|---|---|
| RC-01 | 🔴 | settingsStore 不存在（无主题/语言/外观存储） | 已确认 | 长期·治本 |
| RC-02 | 🔴 | style.css 无 `[data-theme]` 切换槽位（RC-01 子根因） | 已确认 | 长期·治本 |
| RC-03 | 🟡 | dropdown-menu 14 子组件零业务引用 | 已确认 | 短期·治标 |
| RC-04 | 🟡 | `--surface-2` 在 SSOT + style.css 均缺失 | 已确认（★扩展见下） | 长期·治本 |
| RC-05 | 🟢 | `aside-region` 废弃术语（1 处，无 CSS 依赖） | 已确认 | 短期·治标 |
| RC-06 | 🟡 | tailwind `darkMode:'class'` 无 runtime 注入 | 疑似 | 待验证 |
| RC-07 | 🟡 | session store derivedStatus 骨架 vs useSidebar 重复 | 疑似 | 待 W07/W10 验证 |

## 四、批次 1 新增/修正根因

### RC-04 扩展定义（token SSOT 落地不完整簇）

W01 原 RC-04 仅指 `--surface-2`。批次 1 发现这是**一类问题**——design-system.md / draft 引用了 SSOT 未定义的 token：

| 缺失 token | 引用来源 | 受害实现 | 发现 wave |
|---|---|---|---|
| `--surface-2` | design-system.md §2 Card-Elevated / §4 Input 背景 | Input→bg-background, Textarea→bg-transparent | W01 + W02 |
| `--bg-elevated` | draft-dual-panel.html `.panel.active` | Panel.vue→bg-surface-hover（色值差 1 点 + 语义错位） | W09 |

**建议**：阶段 C 将 RC-04 升级为"design-system 引用的 token 在 SSOT 缺失"簇，统一排查所有 design-system.md / draft 中引用但 SSOT 未定义的变量。

### RC-08 修正结论（--muted 语义分歧）

W02 核实：**原子层有局部受害**（修正 W02 报告内部"无受害"的矛盾结论）。
- **受害**：Button Ghost hover 变蓝（BUI-BTN-03）、Dialog close open 态变蓝（BUI-DLG-03）——都因 shadcn `bg-accent` 意图是浅灰软底，但 v3 `--accent` 是主色蓝
- **无害**：7 处 `bg-muted`/`text-muted-foreground`/`bg-secondary` 用法视觉正确
- **治理**：改 Ghost/close 为 `bg-surface-hover`，非全局 token 重命名

### 新根因候选（待阶段 C 确认）

| 候选 ID | 描述 | 发现 wave | 性质 |
|---|---|---|---|
| RC-10 | shadcn Dialog 基类缺 backdrop blur（spec 要求 blur 10px） | W02 BUI-DLG-01 + W18 ST-L2-01 | 已确认根因（两 wave 互证） |
| RC-11 | ⌘K 快捷键冲突风险（全局搜索 vs Settings 内置搜索） | W15 + W18 | 疑似（两者均 DEFERRED 未绑定，但 spec 都用 ⌘K） |

## 五、问题优先级清单

### P0 · 阻断/无障碍（必须修）
1. **Textarea 缺 focus-visible ring**（W02 BUI-TA-01）— `outline-none` 后无 ring，键盘用户看不到焦点
2. **`--surface-2` 缺失**（RC-04）— Input/Textarea 无视觉容器边界
3. **AppShell 缺 border-radius:10px**（W03 SH-L0-01）— win/linux frameless 窗口锐角

### P1 · 系统性偏差（影响全局一致性）
4. **Button variant 系统偏差**（W02，6 个 ⚠）— Ghost hover 蓝/Secondary 实底/Destructive 实底/多 outline+link/高度不符
5. **23 个多余文件**（W02）— dropdown-menu 15 + tooltip 4 + dialog 4，shadcn 全量 copy 残留
6. **Dialog backdrop 缺 blur**（RC-10）— Settings/SearchModal 都受影响
7. **`--bg-elevated` 缺失**（W09）— Panel 激活态 bg 用错 token
8. **AppNavControls 折叠态被裁剪**（W05 SB-L2-05，跨 W03）— AsideRegion overflow:hidden 裁掉 absolute 按钮，三路唤回弱化为两路

### P2 · 体验/精细度
9. Input focus ring 外环非 inset（W02 BUI-IP-02）
10. Input 缺 error 态（W02 BUI-IP-03）
11. Dialog bg 用画布色非 surface（W02 BUI-DLG-02）
12. ScrollBar thumb 色过淡 6%（W02 BUI-SA-01）
13. Textarea min-height 40≠56（W02 BUI-TA-02）
14. SearchModal z-index 50≠1000（W15 OL-L1-01）
15. SettingsModal 缺 .modal-head 结构（W18 ST-L2-02）

### 已知 DEFERRED（非 bug，记录备查）
- G-022：搜索基础设施（入口+⌘K+SearchModal 内容）全缺
- G2-003：FileView 内容 + 文件计数
- G-033：⌘B 三态优先级第 3 态
- G-023：Side Drawer 完整实现
- G3-002：Settings 三模式/菜单内容

## 六、跨 wave 关联链（阶段 C 聚合素材）

| 关联簇 | 涉及 wave | 性质 |
|---|---|---|
| token SSOT 落地不完整 | W01 RC-04 + W09 bg-elevated + W02 Input/Textarea | 同根因，RC-04 扩展 |
| settingsStore 缺失 | W01 RC-01 + W18 三模式/搜索/自动保存 | RC-01 因果链，3 个 ❌ 是同根因三表现 |
| shadcn 全量 copy 冗余 | W01 RC-03 + W02 dropdown/tooltip/dialog | 同模式，23 文件 |
| backdrop blur 缺失 | W02 + W18 | RC-10，shadcn Dialog 基类 |
| AppNavControls 折叠态 | W05 现象 + W03 根因层（AsideRegion overflow） | 跨层 placement 问题 |
| ⌘K 冲突 | W15 全局搜索 + W18 Settings 内置搜索 | RC-11，设计层冲突 |

## 七、双向交叉价值验证（策略有效性证明）

两个案例证明"双向交叉"策略的必要性——单方向都会漏：

1. **AppNavControls 折叠态裁剪**：W03（自顶向下）审 AppNavControls 锚点判 ✅（只看按钮本身 left 位移/图标切换），W05（自底向上）审 Sidebar 收起态时发现按钮被 `overflow:hidden` 裁掉在折叠态不可见。**自顶向下漏了，自底向上补上**。
2. **RC-08 受害范围**：W01 预判 `--muted` 语义分歧，W02 核实修正了"原子层无受害"的初步结论——实际 Button Ghost + Dialog close 受害。**自底向上核实了自顶向下的预判**。

## 八、正向发现（实现质量高的部分）

- Workspace 四层激活标识：inset ring 正确规避中缝双线（用 box-shadow 非 border）、opacity 精确对齐（1/0.5/0.78）、主从状态机健壮
- Sidebar 容器：6 层纵向分层完全符合 spec、Overview 入口正确解耦于 tab、四态切换结构完整
- SettingsModal：导航↔详情联动正确、inset accent ring 正确禁左竖条、与 Overview 架构边界清晰
- Warm & Soft 配色：style.css 完全干净，42 token 与 SSOT 逐项一致
- features 层 hold 住 R2 铁律：useSidebar/useChat 是唯一跨 api+stores 编排层

## 九、下一步 · 批次 2

批次 2 共 6 wave，按依赖拓扑分两拨（受 5-subagent 并行上限约束）：

| 拨 | Wave | 区域 | 依赖（均已完成） |
|---|---|---|---|
| 拨 1（5 并行） | W04 B-SH / W06 B-SB / W07 A-SB-I / W08 A-SB-F / W10 A-WP-H | Shell 多余 / Sidebar 多余 / SessionItem / FileView / PanelHeader | W03/W05/W09 |
| 拨 2（2 并行） | W12 A-WP-C / W13 A-WP-Z | **Composer（用户差异点②）** / Companion Zones | W09 |

批次 2 完成后，还有批次 3（W11 MessageStream + W17 Overview + W19 Settings 菜单）和批次 4（W14 Side Drawer + W16 OV/OL/ST 多余）。
