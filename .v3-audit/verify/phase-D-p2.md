# Wave P2 · MessageStream + Overlays + Settings 精细度 验证报告

> 日期：2026-06-21
> 对象：wave-P2-message-overlays.md 5 项任务（P2-1 ~ P2-5）
> 前置：Wave V（phase-D-visual.md）+ Wave P1（phase-D-p1.md，方法学确立）
> 方法：代码改动 + vue-tsc + lint + vitest + CDP 像素核验 + VLM（MiniMax）观感对比
> 产出图：`/tmp/v3-p2/*.png`（未提交，仅验证用）
> 对应 commit：`08cdfa52`（P2-1/2 message-stream）/ `9aaf8e5e`（P2-3/4 overlays）/ `6360b824`（P2-5 companion-zones）

## 一、5 项任务结论总表

| 项 | 内容 | 改动 | 验证 | 判定 |
|---|---|---|---|---|
| P2-1 | OutputText 中间/收尾拆分（WP-L3-08） | Turn.vue `summaryText`=仅末条 assistant.content，前序折进 trace | CDP 折叠态 summary 恒显 + 单测多-assistant 分组 | ✅ |
| P2-2 | ReasoningBlock 独立折叠（WP-L3-09） | Block.vue thinking header toggle + 响应 `collapsed` prop | CDP 展开/折叠 toggle + VLM 对比设计稿 | ✅ |
| P2-3 | SearchModal z-index（OL-L1-01） | DialogContent/DialogOverlay `z-50 → z-[1000]` | 代码层确认（入口 DEFERRED，无法实机渲染） | ✅（结构） |
| P2-4 | SettingsModal .modal-head（ST-L2-02） | modal-head 容器 + DialogClose re-export + `hideClose` prop | 代码层确认（入口 DEFERRED，无法实机渲染） | ✅（结构） |
| P2-5 | Composer 三 zone 间距（WP-L3-29） | Panel.vue `composer-band flex flex-col gap-1.5` 包裹三 zone | CDP 像素核验 gap=6px | ✅ |

## 二、P2-1 · OutputText 中间/收尾拆分

### 改动
`Turn.vue`（`08cdfa52`）：不再把所有 assistant.content 拼成 summary。
- `summaryText` computed = 仅最后一条 `turn.assistants[last].content`（收尾位，draft §4 固定不折叠）
- `isMidAssistant(idx)` = `idx < length - 1` → 前序 assistant.content 折进 trace（`<Block type="text">`，中间产出）
- 单 assistant 内的中间 text 片段拆分依赖 `contentBlocks` 时序数据（runtime 未填充），DEFER flow-2（commit message 明示）

### 验证 1 · CDP 折叠态（mock s1）
选中「重构 auth 模块」会话，回合默认折叠：

| 结构 | CDP 实测 | 判定 |
|---|---|---|
| `.turn-summary` 数量 | 2（两个回合各一） | ✅ 收尾 summary 恒显 |
| summary 内容 | 「已将 AuthService.login 改为 async…」「提交时遇到文件锁…」= 各回合末条 assistant.content | ✅ 仅末条作收尾 |
| turn-meta badge | 「已工作1s 思考 ×1 工具 ×2」「已工作1s 工具 ×1」 | ✅ 折叠按钮 + 计数 |

### 验证 2 · 单测多-assistant 分组（mock 无 steer 场景，补单测覆盖）
mock data 每个 turn 仅 1 assistant（5 user / 5 assistant 一一对应），无法触发 `isMidAssistant`。新增单测 `fg5-message-stream.test.ts`：

```ts
it('多 assistant 同回合（steer 续轮）→ 前序归入，末条作收尾', () => {
  const turns = groupTurns([
    userMsg('u1', '改一下登录'),
    assistantMsg('a1', '正在处理 schema…'),     // steer 前的中间产出
    assistantMsg('a2', '已将 AuthService.login 改为 async。'), // 收尾
  ])
  expect(turns).toHaveLength(1)
  expect(turns[0].assistants).toHaveLength(2)   // groupTurns 把连续 assistant 归同 turn
  const last = turns[0].assistants[turns[0].assistants.length - 1]
  expect(last.id).toBe('a2')                    // isMidAssistant(0)=true, isMidAssistant(1)=false
  expect(last.content).toBe('已将 AuthService.login 改为 async。')
})
```

`groupTurns` 已支持连续 assistant 归同 turn（`messageTurns.ts:60` `current.assistants.push(msg)`），Turn.vue 的 `isMidAssistant` 正确标记前序为中间。**逻辑层确认正确**，待 runtime contentBlocks 时序数据填充后可实机验证单 assistant 内中间 text 拆分。

## 三、P2-2 · ReasoningBlock 独立折叠

### 改动
`Block.vue`（`08cdfa52`）：thinking 分支加可点击 header（chevron + Brain + 「思考」），`thinkingCollapsed` ref 由 `collapsed` prop 初始化（默认 `true`，来自 `ThinkingBlock.collapsed`）。折叠态显示一行 preview（content 截断），展开态显示完整 `<p>` 推理。

### 验证 · CDP toggle + VLM 对比
展开回合 1 trace 后：

| 操作 | CDP 实测 | 判定 |
|---|---|---|
| trace 渲染 thinking 块 | `.trace-think` = 1 | ✅ |
| 默认折叠态 | `<p>` 不存在（`thinkParaVisible: "no-p"`），header 显示「思考 · 先确认字段范围…」一行 preview | ✅ 响应 `collapsed` |
| 点击 header 展开 | `<p>` display:block，显示完整「先确认字段范围（username / password），再建 schema 文件…」 | ✅ toggle 可逆 |
| header 可点击元素 | `.trace-think > div.cursor-pointer`（非 button，但 role/cursor 正确） | ✅ |

VLM（MiniMax）对比设计稿结论：thinking header 完整为 `chevron + 紫色 Brain + 紫色「思考」+ · + 灰色一行 preview`，与 draft §4「思考 · 一行预览」折叠态吻合。✅

## 四、P2-3 / P2-4 · Overlays + Settings 结构（DEFERRED 入口）

两任务改动已落地（`9aaf8e5e`），但**实机渲染入口 DEFERRED**：
- P2-3 SearchModal（⌘K）内容 G-022 DEFERRED，mock 无触发路径
- P2-4 SettingsModal 菜单 G3-002 DEFERRED，mock 无打开路径

走代码层 + 类型层确认：

| 项 | 代码核实 | 判定 |
|---|---|---|
| P2-3 DialogContent z-index | `DialogContent.vue:26,32` overlay + content 均 `z-[1000]`（原 z-50），对齐 overlays/spec.md「浮层 1000」 | ✅ |
| P2-3 hideClose prop | `DialogContent.vue` 新增 `hideClose` prop，允许消费者自渲染关闭 | ✅ |
| P2-4 modal-head 容器 | `SettingsModal.vue:19` `.modal-head flex h-[44px] ... border-b`（标题 + 关闭按钮），替换 shadcn 绝对定位 ✕ | ✅ |
| P2-4 DialogClose re-export | `ui/dialog/index.ts` 导出 `DialogClose` | ✅ |

**注**：z-index 是颜色类外的布局结论，但无层级冲突场景（mock 单 overlay）下非像素核验重点；改动方向正确（数值对齐 spec），待 flow-2 入口落地后实机复核。

## 五、P2-5 · Composer 三 zone 垂直间距

### 改动
`Panel.vue`（`6360b824`）：ProgressZone/Composer/GitZone 包进 `.composer-band flex flex-col gap-1.5`（6px）单一容器，移除三 zone 各自 margin（ProgressZone mt-2.5 / Composer pt-2.5 / GitZone mb-3）。bg-input/圆角 Phase D 已统一。

### 像素核验（最高可信度）
CDP `getComputedStyle` + `getBoundingClientRect`：

| 属性 | 实测 | 判定 |
|---|---|---|
| band.gap | `6px` | ✅ |
| band.display / flexDirection | `flex` / `column` | ✅ |
| 三 zone 间距（getBoundingClientRect） | ProgressZone→Composer: 6px，Composer→GitZone: 6px | ✅ 6px 紧凑成带 |
| composer-band class | `composer-band flex flex-shrink-0 flex-col gap-1.5` | ✅ |

**结论**：三 zone 垂直间距统一为 6px（gap-1.5），符合 draft-companion-zones §裁决。

## 六、自动化验证

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `cd src-electron/renderer && npx vue-tsc --noEmit` | ✅ exit 0 |
| Lint | `npm run lint` | ✅ exit 0 |
| 单测 | `npx vitest run` | ✅ 6 files / 56 tests（+1 P2-1 多-assistant 用例，原 55） |

## 七、VLM 观感对比与方法学说明

按 Wave V/P1 方法学：颜色类结论像素层兜底，VLM 仅做结构观感复核。本次 VLM 用 vision-analysis skill 的 MiniMax VLM（GLM-4.6V key 未配置，fallback；subagent 隔离执行，主会话不读图）。

| 对比 | 判定 | 备注 |
|---|---|---|
| 折叠态 vs 设计稿 | ⚠️ 基本一致 | summary 恒显 + badge 结构对齐；偏差：badge 多了 Brain/Wrench 图标（设计稿纯文字彩色 badge），语义/颜色编码不变，属可接受视觉增强 |
| 展开态 trace vs 设计稿 | ✅ | thinking header「思考 · preview」+ tool 块样式 + 顶部 badge 持续 + 底部 summary 恒显，全部对齐 |

**偏差登记（非阻断）**：折叠 badge 实现带 lucide 图标（Brain/Wrench），设计稿是纯文字彩色 badge。两者语义一致（思考=紫/工具=青），图标是 CLAUDE.md「禁止 Emoji，用图标库」规范的合规实现。如需严格对齐设计稿可后续移除图标，当前保留。

## 八、结论

Wave P2 5 项全部完成：
- **P2-1**（OutputText 拆分）：CDP 折叠态 summary 恒显确认 + 单测覆盖多-assistant 分组逻辑；单 assistant 内中间 text 拆分 DEFER flow-2（contentBlocks 时序数据）
- **P2-2**（Reasoning 折叠）：CDP toggle 展开/折叠可逆 + 响应 `collapsed` prop + VLM 对齐设计稿
- **P2-3/P2-4**（Overlays/Settings 结构）：代码层确认，入口 DEFERRED 待 flow-2 实机复核
- **P2-5**（Composer 间距）：像素核验 gap=6px，三 zone 紧凑成带

**1 处可接受偏差**（badge 图标）登记待评估。本 wave 无阻断项。
