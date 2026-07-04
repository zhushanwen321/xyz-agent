# Wave P1 · token 与组件精细度打磨 验证报告

> 日期：2026-06-21
> 对象：wave-P1-polish.md 6 项任务（P1-1 ~ P1-6）
> 前置：Wave V 报告（`.v3-audit/verify/phase-D-visual.md`，Phase D 6/6 commit 兑现）
> 方法：代码改动 + vue-tsc + lint + CDP 像素核验 + minimax VLM 观感对比
> 产出图：`/tmp/v3-p1/*.png`（未提交，仅验证用）

## 一、6 项任务结论总表

| 项 | 内容 | 决策/改动 | 验证 | 判定 |
|---|---|---|---|---|
| P1-1 | `--surface-hover` 取值 + active 卡片背景归一 | token 修正 + 2 组件改 class + 文档同步 | 像素核验 | ✅ |
| P1-2 | Button focus ring 统一性 | 保持现状（shadcn 外环），design-system §3 补注 | 文档裁决 | ✅ |
| P1-3 | Input error 文案机制 | 保持现状（只管 border），design-system §4 补注 | 文档裁决 | ✅ |
| P1-4 | ScrollBar thumb 色过淡 | `bg-border`(6%) → `bg-border-strong`(12%) | 代码层确认 | ✅ |
| P1-5 | GitZone 分支名 truncate | 分支名 span 加 `truncate max-w-[120px]` | 代码层确认 | ✅ |
| P1-6 | ProgressZone 空态判断 | 加 proxy TODO 注释（不改逻辑） | 代码层确认 | ✅ |

## 二、P1-1 · token 修正与卡片归一（核心项）

### 根因（落地偏差，非设计模糊）

两份设计稿 `:root` 都明文区分两 token：
- `draft-session-item.html:10` + `draft-composer-states.html:10`：`--surface-hover:#1f1f26` / `--surface-2:#1b1b20`
- 落地时 `style.css:19` + `design-tokens.md:13` 都误取 `--surface-hover:#1b1b20`（撞了 surface-2）

同时 `SessionItem.vue` active 用 `bg-accent-soft`（淡蓝），不符合 draft `.si.active{background:var(--surface-2)}`（中性灰）。Wave V 报告 P1-1 即此偏差。

### 改动（5 处，token SSOT 三处同步 + 2 组件 class）

| 文件 | 改动 |
|---|---|
| `style.css:19` | `--surface-hover: #1b1b20` → `#1f1f26` |
| `design-tokens.md:13` | 值同步 `#1f1f26`，来源标注修正（原误标 `C(--panel-hover)` → 设计稿 `:root`） |
| `SessionItem.vue:10` | active `bg-accent-soft` → `bg-surface-2` + 注释同步 |
| `SessionCard.vue:15` | active `bg-surface-hover` → `bg-surface-2`（归一 Card-Active，design-system §2） |
| tailwind.config.ts | 无需改（`surface.hover`/`surface.2` 已各自映射，改 CSS 变量即生效） |

### 像素核验（最高可信度）

CDP `getComputedStyle` 读 active session-item：

| 属性 | 改动前（Wave V 记录） | 改动后 | 判定 |
|---|---|---|---|
| backgroundColor | `rgba(79,142,247,0.12)`（accent-soft，淡蓝） | `rgb(27, 27, 32)` = `#1b1b20`（surface-2，中性灰） | ✅ |
| boxShadow | — | `rgba(79,142,247,0.3) 0px 0px 0px 1px inset`（accent-ring 保留） | ✅ |
| 祖先链（8 层） | — | 全 `rgba(0,0,0,0)` + `backgroundImage:none`（零 accent 叠加） | ✅ |
| `--surface-hover` token | `#1b1b20` | `#1f1f26` | ✅ |
| `--surface-2` token | `#1b1b20` | `#1b1b20`（两值现已区分） | ✅ |

**结论**：active 背景已从中性灰 `#1b1b20` 落地，蓝色仅来自 inset accent-ring。`--surface-hover`(#1f1f26) 与 `--surface-2`(#1b1b20) 现区分，hover 不再与 active 重合。

### VLM 观感对比与方法学裁决

minimax(M3) 对 sidebar active 截图分析，判断"背景通体泛蓝、背景与 ring 叠加"——**与像素核验冲突**。

**裁决：像素层胜出**（依据 Wave V 报告 §一关键教训："所有颜色类结论必须用像素层复核，不能只信 VLM 观感"）。理由：
1. `#1b1b20` 的 R27=G27 B32，B-R 差值仅 5/255（2%），物理上几乎纯中性灰，人眼不可辨其蓝偏；VLM 放大了 ring 1px 淡蓝描边的边缘渗透，误读为背景泛蓝
2. 祖先链零叠加（全透明），排除"父级 accent 染背景"
3. 改动前 `rgba(79,142,247,0.12)` 的 B 通道（79×0.12≈9.5）显著高于现状——蓝色确实从背景底色移除

> 本案再次验证 Wave V 方法学：VLM 颜色观感会误判（第二次，前次为 S2 边框色误判为蓝），像素核验是颜色结论的唯一可信兜底。

## 三、P1-2 / P1-3 · 文档裁决（保持现状 + 补注）

### P1-2 Button focus ring

`design-system.md §3`（Button）只讲 variant 配色，**完全没提 focus ring**。"inset ring"要求仅写在 §4（Input/Textarea："聚焦 --accent 1px ring，inset，同 Card-Active"）。Button 当前 `focus-visible:ring-2 ring-ring ring-offset-2`（外环+offset）是 shadcn 原样惯例。

**裁决**：保持现状。Button 是操作型原语（外环表焦点），Input 是容器型原语（inset 表边界聚焦），两语境故意不同。在 §3 末尾补注说明，避免后人误改。

### P1-3 Input error 文案

`design-system.md §4` 原文"错误态 --danger 辆框 + 下方错误文案"，但：
- 项目**无 `components/ui/form/` 表单层**（已确认）
- Input 消费者仅 Composer + SearchModal，**零处传 `:error` prop**
- shadcn 体系错误文案归表单层 FormMessage，原子 Input 只管 border

**裁决**：维持现状（Input 只暴露 `error?: boolean` border 态），在 §4 补注"下方错误文案归表单层 FormMessage（待引入），原子 Input 不自带文案 prop"。

## 四、P1-4 · ScrollBar thumb（代码层确认 + 运行时澄清）

### 改动
`ScrollBar.vue:26` `ScrollAreaThumb` 的 `bg-border`(rgba 6%) → `bg-border-strong`(rgba 12%)。

### 运行时验证澄清
CDP 查找 `bg-border-strong` 元素 = 0。原因：`ScrollBar.vue` 经 `ScrollArea.vue:23` 组装进 reka-ui ScrollArea，reka 的 ScrollBar **仅在内容溢出需要滚动时才渲染 thumb**（lazy）。mock 5 session 在 800px 视口不溢出，故 thumb 未渲染。

**归类**：同 Wave V V5——"代码层确认正确（class 改对了，token 值 `rgba(255,255,255,0.12)` 像素已验），待出现滚动内容时运行时可视"。非改动缺陷，是 reka lazy 渲染行为。

### 边界（未做）
`MessageStream.vue:77-82` 有独立 scoped `::-webkit-scrollbar`（thumb `bg-border`/hover `subtle`），是 W02 提到的另一套滚动条。它与 ScrollBar.vue（reka 组件）是两套独立机制，统一是更大重构，**超出 P1 范围**，登记待后续 wave 评估。

## 五、P1-5 / P1-6 · 机械项

| 项 | 改动 | 验证 |
|---|---|---|
| P1-5 GitZone 分支名 truncate | 分支名 `<span>` 包裹 + `truncate max-w-[120px]`，图标加 `shrink-0` | tsc+lint 过；运行时待长分支名触发 |
| P1-6 ProgressZone 空态 | `v-if="sessionLabel"` 上方加 TODO(proxy) 注释，说明 sessionLabel 是 FG4 骨架期 proxy，Flow3 落地后改 hasTasks | 注释改动，无逻辑变更 |

## 六、自动化验证

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `cd src-electron/renderer && npx vue-tsc --noEmit` | ✅ exit 0 |
| Lint | `npm run lint` | ✅ exit 0 |

## 七、结论

Wave P1 6 项全部完成：
- **P1-1**（token + 卡片归一）像素核验确认 active 背景从淡蓝修正为中性灰 `#1b1b20`，`--surface-hover` 修正为 `#1f1f26`，两 token 区分；VLM 误判经像素层裁决推翻（Wave V 方法学复现）
- **P1-2/P1-3** 文档裁决保持现状 + 补注，避免后人误改
- **P1-4** thumb 色加深，reka lazy 渲染下待滚动触发可视
- **P1-5/P1-6** 机械项落地

Wave V 报告登记的 P1-1（SessionItem active 背景）+ P2-3（surface-hover/surface-2 同值）**两项偏差随本 wave 一并消除**。其余 P2 项（G2-002/G-022/G-021 配套）不在本 wave 范围。

**验证方法学二次印证**：VLM 颜色观感不可信，像素核验是颜色类结论唯一兜底。
