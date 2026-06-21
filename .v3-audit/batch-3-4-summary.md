# 批次 3+4 审查汇总（W11 + W17 + W19 + W14 + W16）· 最终总结

> 审查日期：2026-06-21
> 策略：双向交叉 + 全审后统一修复
> 本批次覆盖：MessageStream / Overview / Settings 菜单 / Side Drawer / OV·OL·ST 多余
> **全部 19 wave 审查完成，0 subagent 失败。**

## 一、执行状态

| Wave | subagent | 报告文件 | 行数 | 状态 |
|---|---|---|---|---|
| W11 MessageStream | bg-8 | wave-W11-message-stream.md | 250 | ✅ |
| W17 Overview | bg-9 | wave-W17-overview.md | 247 | ✅ |
| W19 Settings 菜单 | bg-10 | wave-W19-settings-menus.md | 176 | ✅ |
| W14 Side Drawer | bg-11 | wave-W14-side-drawer.md | 367 | ✅ |
| W16 OV/OL/ST 多余 | bg-12 | wave-W16-ov-ol-st-extra.md | 276 | ✅ |

**批次 3+4 全部成功，0 失败。**

## 二、判定统计

| Wave | ✅ | ⚠ | ❌ | 🆕 | 核心产出 |
|---|---|---|---|---|---|
| W11 MessageStream | 3 | 3 | 4 | 0 | **FileChanges 缺失（回合折叠致命缺陷）+ OutputText 未拆分** |
| W17 Overview | 6 | 3 | 0 | 0 | **DEC-01 佐证（SessionCard inset ring 正确）+ pulse 动画两实现** |
| W19 Settings 菜单 | 0 | 0 | 6 | 0 | **5 菜单全 DEFERRED（RC-01）+ Plugins UI 从未创建** |
| W14 Side Drawer | 0 | 0 | 7 | 0 | **全栈断层（组件+数据源双未就绪）** |
| W16 OV/OL/ST 多余 | 0 | 0 | 0 | 3 | **代码最干净 wave + RC-03 四次验证闭合 + Plugins UI 确认不存在** |
| **合计** | **9** | **6** | **17** | **3** | — |

## 三、全审查统计（19 wave 累计）

| 指标 | 值 |
|---|---|
| Wave 总数 | 19（W01-W19） |
| 报告总行数 | 4415 |
| subagent 失败数 | 0 |
| ✅ 一致 | 58 |
| ⚠ 偏差 | 44 |
| ❌ 缺失 | 55 |
| 🆕 多余 | 26 文件 + 若干代码段 |
| 根因总数 | 10（RC-01 ~ RC-10） |
| 裁决数 | 3（DEC-01 ~ DEC-03） |

## 四、根因总表（10 条 · 最终版）

| ID | 严重度 | 根因 | 状态 | 发现 wave | 影响范围 |
|---|---|---|---|---|---|
| **RC-01** | 🔴 | settingsStore 不存在（无主题/语言/外观存储） | 已确认 | W01 | Settings 全层（W18/W19）、MessageStream theme、所有需主题切换的组件 |
| **RC-02** | 🔴 | style.css 无 `[data-theme]`/`[data-palette]` 切换槽位 | 已确认 | W01 | 所有 UI（亮色不可用）、System 菜单主题切换 |
| **RC-03** | 🟡 | dropdown-menu 14 子组件零业务引用 | 已确认（**四次验证** W01+W02+W07+W16） | W01 | 仅占构建体积/导航噪音 |
| **RC-04** | 🟡 | **token SSOT 缺失簇**（`--surface-2`/`--bg-elevated`/`--bg-input`） | 已确认（五 wave 扩展） | W01+W02+W09+W12+W13 | Input/Textarea/Panel 激活/Composer/ProgressZone/GitZone/Side Drawer |
| RC-05 | 🟢 | `aside-region` 废弃术语（1 处） | 已确认 | W01+W03+W04 | 1 class 名，无功能影响 |
| RC-06 | 🟡 | tailwind `darkMode:'class'` 无 runtime 注入 | 疑似 | W01 | 暂无表现（无 dark: variant 使用） |
| RC-07 | 🟢 | session store derivedStatus 死骨架 | **已确认·低优先级**（三次验证 W06+W07+W10） | W01 | 死代码，无运行时影响 |
| RC-08 | 🟡 | `--muted`/`--accent` 语义分歧（局部受害） | 已确认 | W01+W02 | Button Ghost hover 蓝、Dialog close open 态蓝 |
| **RC-09** | 🔴 | SessionItem `grid` 无列定义（差异点①） | 已确认 | W07 | SessionItem 全实例 |
| **RC-10** | 🟡 | SessionItem 激活标识 spec vs draft 冲突 | **已裁决 DEC-01**（改 inset ring） | W07 | SessionItem 激活态 |

## 五、用户三大差异点的最终审查结论

### 差异点① SessionItem 状态文字跨行（W07）→ 根因已定位 + 裁决已下

- **RC-09 已确认**：`grid` 无列定义 → 隐式单列堆叠
- **修复**：改 `grid` → `flex items-start`（DEC-01 配套，删左竖条改 inset ring）
- **DEC-01 佐证**：W17 SessionCard 已用 inset ring 且布局正确，SessionItem 应向其对齐

### 差异点② Composer 完全不一样（W12）→ 印证判断，偏差最大

- **Composer 9 态覆盖率：3/9 可工作，6/9 缺失或偏差**
- **工具区 5 项：仅发送按钮正确（1/5）**
- **★ P0 阻断 S6 死胡同 UI**（DEC-03 已裁决：长期实现 steer，短期兜底禁用输入）
- 4 个核心状态 DEFERRED（@浮层/附件 G2-002、steer/followup G-019）

### 差异点③ Panel 不一样（W09）→ 四层激活标识 3/4 正确

- 四层：左竖条✅ / inset ring✅ / **bg⚠**（bg-surface-hover 而非 bg-elevated）/ opacity✅
- Side Drawer ❌（G-023 DEFERRED，W14 确认全栈断层）

## 六、关键跨 wave 关联链（阶段 C 聚合素材）

| 关联簇 | 涉及 wave | 结论 |
|---|---|---|
| **RC-01 settingsStore 因果链** | W01 + W18 + W19 | Settings L2 骨架 + L3 菜单两层全 DEFERRED，根因唯一 |
| **RC-04 token 缺失簇** | W01+W02+W09+W12+W13 | 5 个 wave 累积，3 个 token（surface-2/bg-elevated/bg-input） |
| **AppNavControls 折叠态** | W05 现象 → W03 漏审 → **W04 定位根因** | placement 问题，提升到 AppShell 层 |
| **RC-07 derivedStatus 死骨架** | W01 → W06+W07+W10 三次验证 | 死代码，低优先级清理 |
| **RC-03 dropdown-menu 零引用** | W01+W02+W07+W16 四次验证 | 结论稳固，可安全删除 |
| **Composer min-height 矛盾** | W02(56) vs W12(draft 40) | **DEC-02 裁决：40px 为准**，design-system.md 待更新 |
| **FileChanges 全链缺失** | W11（块缺失）+ W14（Side Drawer ChangeSet Detail 无数据源） | 全栈断层，需 flow-2 协同 |
| **Side Drawer 全栈断层** | W09（stub）+ W11（FileChanges）+ W13（GitZone emit）+ W14（确认） | 组件+数据源双未就绪 |
| **pulse 动画两实现** | W07 SessionItem(animate-pulse) vs W17 SessionCard(同心环) | SessionItem 应向 SessionCard 对齐 |
| **状态点同源性** | W07 SessionItem ↔ W10 PanelHeader | 共用 deriveStatus，一致性保证 |

## 七、双向交叉策略价值验证（5 个案例）

整个审查证明"双向交叉 + 全审后修复"策略的有效性：

1. **AppNavControls 折叠态**（W05现象→W03漏→W04定位）：单方向必漏
2. **Composer min-height**（W02误判→W12发现设计矛盾）：单审会误判
3. **RC-04 token 簇**（5 wave 累积）：单 wave 看不到全貌
4. **RC-03 dropdown-menu**（4 次验证）：结论稳固性证明
5. **DEC-01 佐证**（W07 SessionItem 问题 ↔ W17 SessionCard 正确范例）：对照产生信心

## 八、P0/P1 问题最终清单（修复优先级）

### P0 · 阻断/无障碍（必须立即修）
1. **Textarea 缺 focus-visible ring**（W02）— 无障碍缺陷
2. **`--surface-2` 缺失**（RC-04）— Input/Textarea 无视觉容器边界
3. **AppShell 缺 border-radius:10px**（W03）— win/linux 锐角
4. **Composer S6 死胡同 UI**（W12，DEC-03 已裁决）
5. **RC-09 SessionItem 布局断裂**（差异点①，DEC-01 配套）

### P1 · 系统性偏差
6. **RC-01 settingsStore 不存在**（阻塞 Settings 全层）
7. **RC-02 `[data-theme]` 切换缺失**（亮色不可用）
8. **Button variant 系统偏差**（W02，6 个 ⚠）
9. **23 个多余文件**（W02 dropdown/tooltip/dialog）
10. **Dialog backdrop 缺 blur**（RC-10）
11. **AppNavControls 折叠态裁剪**（W04，提升到 AppShell）
12. **Composer 工具区欺骗性 UI**（W12，模型/thinking-level 静态 span）
13. **MessageStream FileChanges 缺失**（W11，回合折叠致命缺陷）
14. **Composer 三 zone 视觉割裂**（W12+W13）

### 已知 DEFERRED（非 bug，记录备查）
- G2-002：@浮层 / 附件
- G2-003：FileView 完整实现
- G2-005：SessionItem hover 操作钮
- G-019：steer/followup（steer 提交本身可提前，DEC-03）
- G-022：搜索基础设施（入口+⌘K+SearchModal 内容）
- G-023：Side Drawer（全栈断层，需 flow-2/3 协同）
- G-033：⌘B 三态优先级第 3 态
- G3 / G3-002：分支 popover / Settings 三模式菜单
- Flow-2 / Flow-3：变更集卡 / SubAgent 编排

## 九、正向发现（实现质量高的部分）

- **W17 Overview**（✅6/⚠3/❌0）：实现质量最高，DEC-01 inset ring 正确落地，布局无 RC-09 问题
- **W16 OV/OL/ST**（零未用 import/零废弃/零死分支/零旧设计）：代码最干净 wave
- **Workspace 四层激活标识**（W09）：inset ring 正确规避中缝双线，opacity 精确对齐
- **PanelHeader**（W10）：split/新建互斥逻辑正确，Breadcrumb 三段 DOM 正确
- **Sidebar 层**（W06）：4 项负向验证全通过
- **Warm & Soft 配色**：style.css 完全干净，42 token 与 SSOT 逐项一致
- **features 层**（W01）：hold 住 R2 铁律，useSidebar/useChat 是唯一跨 api+stores 编排层
- **Process Panel 残留**（W13）：v1 删除干净，零匹配
- **状态点同源性**（W07+W10）：SessionItem/PanelHeader/SessionCard 共用 deriveStatus

## 十、下一步 · 阶段 C（根因归类）+ 阶段 D（统一修复）

19 wave 审查全部完成，进入：

### 阶段 C · 根因归类与优先级
读取全部 19 份报告 + decisions.md，按根因聚类（已完成大部分），产出 `phase-C-rootcause.md`：
- 根因依赖图（哪些根因先修能解锁下游）
- 修复优先级（P0 根因级 > 结构级 > 细节级）
- 修复批次建议（根因簇 grouping）

### 阶段 D · 统一修复
按阶段 C 优先级逐个修，每修一个根因验证一次：
1. 先治本（RC-01 settingsStore / RC-04 token 簇 / RC-09 SessionItem 布局）
2. 再治标（DEC-01/02/03 裁决落地、多余清理、P2 精细度）

### 建议的修复顺序（根因依赖序）
1. **RC-04 token SSOT 补齐**（design-tokens.md 补 surface-2/bg-elevated/bg-input → style.css 落地）— 解锁下游多个组件
2. **RC-01 settingsStore 创建**（+ RC-02 data-theme 切换）— 解锁 Settings 全层 + 主题切换
3. **RC-09 + DEC-01 SessionItem 修复**（grid→flex + 删竖条改 inset ring）— 差异点①
4. **DEC-03 Composer S6 死胡同**（短期兜底或 steer 实现）— P0
5. **W02 UI 原子层治理**（Textarea focus ring / Button variant / 多余清理）
6. **W12 Composer 工具区**（模型/thinking-level popover）
7. **其余 P1/P2** 按优先级
