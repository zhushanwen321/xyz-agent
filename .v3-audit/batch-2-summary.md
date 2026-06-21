# 批次 2 审查汇总（W04 + W06 + W07 + W08 + W10 + W12 + W13）

> 审查日期：2026-06-21
> 策略：双向交叉 + 全审后统一修复
> 本批次覆盖：Shell 多余 / Sidebar 多余 / SessionItem（差异点①）/ FileView / PanelHeader / Composer（差异点②）/ Companion Zones

## 一、执行状态

**全部成功，0 subagent 失败/未完成，无需重启。**

| Wave | subagent | 报告文件 | 行数 | 状态 |
|---|---|---|---|---|
| W04 Shell 多余 | bg-1 | wave-W04-shell-extra.md | 179 | ✅ |
| W06 Sidebar 多余 | bg-2 | wave-W06-sidebar-extra.md | 171 | ✅ |
| W07 SessionItem | bg-3 | wave-W07-session-item.md | ~350 | ✅ |
| W08 FileView | bg-4 | wave-W08-file-view.md | 163 | ✅ |
| W10 PanelHeader | bg-5 | wave-W10-panel-header.md | 321 | ✅ |
| W12 Composer | bg-6 | wave-W12-composer.md | ~350 | ✅ |
| W13 Companion Zones | bg-7 | wave-W13-companion-zones.md | 293 | ✅ |

## 二、判定统计总表

| Wave | ✅ | ⚠ | ❌ | 🆕 | 核心产出 |
|---|---|---|---|---|---|
| W04 Shell 多余 | 5 复核 | 1 | 0 | 3 | AppNavControls 根因定位（placement 问题） |
| W06 Sidebar 多余 | 5 | 0 | 0 | 2 | RC-07 验证 + 4 项负向验证通过 |
| W07 SessionItem | 0 | 2 | 3 | 0 | **RC-09（差异点①根因）+ RC-10（激活标识冲突）** |
| W08 FileView | 0 | 0 | 5 | 0 | FileView 完全未实现（G2-003 defer） |
| W10 PanelHeader | 0 | 2 | 3 | 0 | 高度偏差判断 + RC-07 三次验证闭合 |
| W12 Composer | 0 | 5 | 4 | 0 | **差异点②：Composer 9态仅3/9可工作 + S6 死胡同 UI** |
| W13 Companion Zones | 0 | 5 | 3 | 0 | progress/git 多态缺失 + RC-04 扩展（--bg-input） |
| **合计** | **10** | **15** | **18** | **5** | — |

## 三、新增根因（累计更新到 10 条）

| ID | 严重度 | 根因 | 状态 | 发现 wave |
|---|---|---|---|---|
| RC-01 | 🔴 | settingsStore 不存在 | 已确认 | W01 |
| RC-02 | 🔴 | style.css 无 `[data-theme]` 切换 | 已确认 | W01 |
| RC-03 | 🟡 | dropdown-menu 14 组件零引用 | 已确认（三次验证） | W01+W02+W07 |
| RC-04 | 🟡 | **token SSOT 缺失簇**（`--surface-2`/`--bg-elevated`/`--bg-input`） | 已确认（三次扩展） | W01+W02+W09+W12+W13 |
| RC-05 | 🟢 | `aside-region` 废弃术语 | 已确认 | W01+W03+W04 |
| RC-06 | 🟡 | tailwind darkMode 无注入 | 疑似 | W01 |
| RC-07 | 🟢 | session store derivedStatus 死骨架 | **已确认·低优先级**（三次验证） | W01+W06+W07+W10 |
| RC-08 | 🟡 | `--muted`/`--accent` 语义分歧（局部受害） | 已确认 | W01+W02 |
| **RC-09** | 🔴 | SessionItem `grid` 无列定义（差异点①） | **已确认** | **W07** |
| **RC-10** | 🟡 | SessionItem 激活标识 spec vs draft 冲突 | 疑似·**需裁决** | **W07** |

### RC-04 簇完整清单（token SSOT 缺失）

| 缺失 token | 设计值 | 引用来源 | 受害实现 |
|---|---|---|---|
| `--surface-2` | ~#1a1a20 | design-system.md §2 Card-Elevated / §4 Input | Input→bg-background, Textarea→bg-transparent |
| `--bg-elevated` | #1c1c20 | draft-dual-panel.html `.panel.active` | Panel.vue→bg-surface-hover（色值差 1 点 + 语义错位） |
| `--bg-input` | #101013 | draft-companion-zones + draft-composer-states | Composer/ProgressZone/GitZone→bg-black/20 硬编码 |

## 四、用户三大差异点的审查结论

### 差异点① SessionItem 状态文字跨行（W07）→ 根因已定位

**RC-09 已确认**：`SessionItem.vue:46` 用 `grid` 但**没指定列定义**（无 `grid-cols-*`）→ CSS Grid 默认单列堆叠 → 状态点/标题/时间垂直分三行。

**修复**：改一行 class——`grid` → `flex items-start`（匹配 draft），时间移回 `.si-main` 内部 `.si-sub` 子行。

### 差异点② Composer 完全不一样（W12）→ 印证判断，偏差最大区域

**Composer 9 态覆盖率：3/9 可工作，6/9 缺失或偏差**（目前所有 wave 中偏差最大）。

**工具区 5 项：仅发送按钮正确（1/5）**：
- +添加内容 ❌ 模板不存在
- 上下文/模型/thinking-level ⚠ 退化为静态 `<span>`，"看起来有但点了没用"的欺骗性 UI
- 发送 ✅ 三态正确

**★ P0 阻断：S6 死胡同 UI**：
- isStreaming=true → 显示 stop 按钮 + textarea 不禁用（能打字）
- 但 `onKeydown` 里 `if (!isStreaming.value) onSend()` 阻止了 Enter 发送
- **结果：用户能打字但 Enter 无效 = 死胡同**
- placeholder 引导"按停止中断"，与设计"想补充什么？⏎ 加入当前任务"完全反向

**4 个核心状态全 DEFERRED**：@浮层/附件（G2-002）、steer/followup（G-019）。其中 steer 被过度推迟（设计明确说 steer 提交本身不受 abort 问题影响）。

### 差异点③ Panel 不一样（W09·批次 1）→ 四层激活标识 3/4 正确

四层激活标识：左竖条✅ / inset ring✅ / **bg⚠**（用 bg-surface-hover 而非 bg-elevated）/ opacity✅。Side Drawer ❌（G-023 DEFERRED）。

## 五、问题优先级清单（批次 2 新增）

### P0 · 阻断（必须立即修）
1. **Composer S6 死胡同 UI**（W12 WP-L3-20）— 用户能打字但 Enter 无效，placeholder 引导反向
2. **Composer 工具区欺骗性 UI**（W12 WP-L3-23）— 模型/thinking-level 显示为可交互但实际是静态 span

### P1 · 系统性偏差
3. **RC-09 SessionItem 布局断裂**（W07）— 差异点①，改一行 class 即可
4. **Composer 9 态大面积缺失**（W12）— @浮层/附件/steer/followup/pending/双队列/失败态 6 个 DEFERRED
5. **RC-04 token 缺失簇**（W01+W02+W09+W12+W13）— `--surface-2`/`--bg-elevated`/`--bg-input` 三 token
6. **AppNavControls 折叠态裁剪**（W04，跨 W05/W03）— placement 问题，提升到 AppShell 层
7. **Companion Zones 多态缺失**（W13）— progress 4 态全无、git 3 态缺失
8. **Composer 三 zone 视觉割裂**（W12+W13）— 各自独立 card + GitZone 圆角不一致 + 间距非规范

### P2 · 体验/精细度
9. SessionItem 脉冲动画偏差（W07，`animate-pulse` vs 设计 pulse-ring 波纹）— 与 W10 PanelHeader 状态点联动
10. PanelHeader 高度 38 vs draft 42（W10，建议保持 38，draft 值仅供 popover 偏移参考）
11. Sidebar collapse 冗余层（W04，belt-and-suspenders 无害）
12. GitZone 圆角 rounded-md vs 另两 zone rounded-lg（W13）

### 已知 DEFERRED（非 bug，记录备查）
- G2-002：@浮层 / 附件
- G2-003：FileView 完整实现
- G2-005：SessionItem hover 操作钮
- G-019：steer/followup（但 steer 提交本身可提前实现）
- G-023：Side Drawer
- G3 / G3-002：分支 popover / Settings 三模式菜单

## 六、跨 wave 关联链（阶段 C 聚合素材）

| 关联簇 | 涉及 wave | 结论 |
|---|---|---|
| token SSOT 缺失（RC-04） | W01+W02+W09+W12+W13 | 同根因，5 个 token 缺失，需统一排查 |
| AppNavControls 折叠态 | W05 现象 → W03 漏审 → **W04 定位根因** | placement 问题，提升到 AppShell 层 |
| RC-07 derivedStatus 死骨架 | W01 发现 → **W06+W07+W10 三次验证** | 死代码，低优先级清理 |
| RC-03 dropdown-menu 零引用 | W01+W02+W07 三次验证 | 结论稳固 |
| Composer min-height 矛盾 | W02(56) vs W12(draft CSS 40) | **设计内部矛盾，需裁决** |
| Composer S6 状态机 | W12 发现 | 死胡同 UI，与 steer(G-019) 联动 |
| 状态点同源性 | W07 SessionItem ↔ W10 PanelHeader | 共用 deriveStatus，一致性保证 |
| Composer 三 zone 视觉一体 | W12+W13 | 各自独立 card + token 缺失 + 圆角不一致 |

## 七、双向交叉价值再次验证

批次 2 三个案例证明策略有效性：

1. **AppNavControls 折叠态**（三 wave 协同）：W05（自顶向下）发现现象 → W03（自顶向下）漏审 → **W04（自底向上）定位根因**（placement 问题）。单方向必漏。
2. **Composer min-height**（两 wave 互证）：W02 认为实现偏小（56），W12 深查发现 **draft CSS 实际就是 40**——是设计内部矛盾，非实现 bug。单审 W02 会误判。
3. **RC-04 token 簇**（五 wave 累积）：从 W01 的 `--surface-2` 单点，经 W09/W12/W13 逐步扩展到 `--bg-elevated`/`--bg-input`，确认是一类问题。单 wave 看不到全貌。

## 八、需要用户裁决的问题（累积）

### Q1. RC-10 SessionItem 激活标识方向
- **(A) 采纳 draft §4 裁决**：改 inset ring，删左竖条（需同步 W09 Panel 激活标识）
- **(B) 保留左竖条**：回退 draft §4 裁决，spec.md 不动
- **(C) 暂不裁决**：留阶段 C

### Q2. Composer min-height 40 vs 56（设计内部矛盾）
- design-system.md §4 说 56，draft-composer-states.html CSS 实际 40
- 实现当前 40（与 draft 一致）
- **哪个是最终值？**

### Q3. Composer S6 死胡同 UI
- **(A) 立即短期 patch**：isStreaming 时禁用输入（让 UI 状态自洽，但放弃 steer）
- **(B) 实现 steer 提交**：让 Enter 在 isStreaming 时触发 steer（设计原意，但需后端 RPC 支持）
- **(C) 等G-019 一起做**

## 九、正向发现（实现质量高的部分）

- PanelHeader：split/新建互斥逻辑正确、Breadcrumb 三段 DOM 正确（L1/L2 无误加可点击）、状态点与 SessionItem 同源
- GitZone：38px 常量高度正确、与 PanelHeader 同高、Diff 按钮 emit 接线正确
- Shell 层：0 死 import / 0 TODO / 0 shadcn 残留，代码干净
- Sidebar 层：4 项负向验证全通过，无未用 import/无残留/无旧设计/无死分支
- RC-07 死骨架确认无害：三调用方都不经过 session store 版本
- Process Panel 残留：W13 全量搜索零匹配，v1 删除干净

## 十、下一步 · 批次 3 + 4

剩余 6 wave：

| 批次 | Wave | 区域 | 依赖 |
|---|---|---|---|
| 批次 3（3 并行） | W11 MessageStream / W17 Overview / W19 Settings 菜单页 | 消息流7类块 / 卡片网格 / 5菜单 | W10/W07/W18 |
| 批次 4（2 并行） | W14 Side Drawer / W16 OV/OL/ST 多余 | detail-pane / Overview等独立多余 | W11/W15/W17/W18 |

批次 3+4 完成后，所有 19 wave 结束，进入阶段 C（根因归类 + 优先级）和阶段 D（统一修复）。
