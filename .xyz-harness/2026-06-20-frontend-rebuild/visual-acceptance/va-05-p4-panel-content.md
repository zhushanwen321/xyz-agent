---
title: VA-05 · P4 Panel 内容（message-stream + composer + zones）
phase: P4
wave: 4
task: T5.1, T5.2, T5.3, T5.4
group: FG5
priority: ★★★
---

# VA-05 · P4 Panel 内容

> Panel 5 zone 的内容深化：message-stream（7 块 + 回合折叠）+ composer（9 态 v1 只 4）+ companion zones。**最重的 VA**。
> 本文件自包含。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P4 行 + §7 UC-2（mock 对话）+ §8.5 P4 v1 边界 + §9（G-018/019/020/025/027/033 + G2-002/005/006/007 DEFERRED） |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG5（T5.1-T5.4） |
| **Plan-frontend** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan-frontend.md` §2 chat domain 签名 + §3 UC-2 数据流链 |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/panel/spec.md` | **Panel spec**（5 zone + 回合折叠机制 + composer 视觉一体） |
| `$ROOT/docs/designs/v3-demo/panel/draft-message-stream.html` | **主对照稿 A**：7 类块 + 回合折叠 + 靠右气泡 + 流式光标 + 失败红框 |
| `$ROOT/docs/designs/v3-demo/panel/draft-composer-states.html` | **主对照稿 B**：composer 9 态 + 工具区浮层 |
| `$ROOT/docs/designs/v3-demo/panel/draft-companion-zones.html` | progress-zone 三态 + git-zone 四态 |
| `$ROOT/docs/designs/v3-demo/panel/draft-detail-pane.html` | Side Drawer（DEFERRED，只确认未渲染） |
| `$ROOT/docs/designs/v3-demo/panel/draft-breadcrumb-popovers.html` | ⌘B 三态（v1 只前两态） |
| `$ROOT/docs/designs/v3-demo/flow-2-code-review/draft-cases.html` | 变更集卡（辅助，跨区联动） |
| `$ROOT/docs/architecture/adr/0019-core-user-flows.md` | 核心用户流 |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/components/panel/MessageStream.vue` | create（7 块 + 回合折叠 + auto-scroll） |
| `$ROOT/src-electron/renderer/src/components/panel/message-stream/Turn.vue` | create（回合折叠） |
| `$ROOT/src-electron/renderer/src/components/panel/message-stream/Block.vue` | create（消息块子组件） |
| `$ROOT/src-electron/renderer/src/components/panel/Composer.vue` | create（S1/S2/S5/S6 主路径） |
| `$ROOT/src-electron/renderer/src/components/panel/ProgressZone.vue` | modify（填实现或保持空壳） |
| `$ROOT/src-electron/renderer/src/components/panel/GitZone.vue` | modify（填实现或保持空壳） |
| `$ROOT/src-electron/renderer/src/stores/chat.ts` | create（messages + isStreaming） |
| `$ROOT/src-electron/renderer/src/composables/features/useChat.ts` | create（send / abort 编排） |
| `$ROOT/src-electron/renderer/src/composables/effects/useChatScroll.ts` | create（auto-scroll 基础版） |
| `$ROOT/src-electron/renderer/src/api/mock/data.ts` | create（fixture：user / assistant text / tool_call / summary / error） |

## 验收前置

- **VA-01 ~ VA-04 必须 PASS**（panel 容器 + token + shell 就绪）。
- **VA-05 依赖 FG1**：chat api + mock fixture（T5.4）就绪。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`。

## 对照表 · A. MessageStream（message-stream）

> 回合 = AI 一次工作（开始到停止）。回合默认折叠，只显 Summary + File Changes。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| A1 | 7 类块渲染 | draft-message-stream §4 附录 + panel/spec | user / output-text / reasoning / tool / file-changes / steer·followup / system | ✅ |
| A2 | mock fixture 块丰富度 | spec §9 G2-006 + plan T5.4 | 至少含 user / assistant text / tool_call(简化) / summary / error，回合折叠 pill 可验 | ✅ |
| A3 | 回合默认折叠 | draft-message-stream + panel/spec §回合折叠 | 默认只显 Summary + File Changes | ✅ |
| A4 | 折叠 pill | draft-message-stream | 「已工作 3m24s · 5 reasoning · 12 tool」计数，点击展开 | ✅ |
| A5 | 展开按真实时序 | panel/spec §回合折叠 | 展开后按真实时序还原所有块 | ✅ |
| A6 | user 气泡靠右 | draft-message-stream | `bubble-user` 靠右 | ✅ |
| A7 | 流式光标 | draft-message-stream | streaming 时 `cursor` 闪烁 | ✅ |
| A8 | 失败红框 | draft-message-stream | error 块 `err` 红框样式 | ✅ |
| A9 | auto-scroll 基础版 | spec §8.5 + useChatScroll | 新消息滚到底 | ✅ |
| A10 | auto-scroll 高级（上滚暂停 / 跳底提示） | spec §9 G2-007 | — | 🔇 |

## 对照表 · B. Composer（composer zone）

> v1 只做主路径 4 态：S1 空 → S2 聚焦 → S5 发送中 → S6 停止 → 回 S1。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| B1 | S1 空态 | draft-composer-states | 输入区空，工具条静态 | ✅ |
| B2 | S2 聚焦态 | draft-composer-states | 输入区聚焦，工具条激活 | ✅ |
| B3 | S5 发送中 | draft-composer-states | spinner + 禁用输入 | ✅ |
| B4 | S6 停止态 | draft-composer-states | 显示停止按钮替代发送 | ✅ |
| B5 | 输入区 + 工具条视觉一体 | panel/spec §composer + draft-composer-states | 同一卡片底，**无强分隔线** | ✅ |
| B6 | 工具条布局 | draft-composer-states | `+添加` · 上下文 · 模型 · thinking-level · 发送 | ✅ |
| B7 | S3 @浮层 / S4 附件 | spec §9 G2-002 | — | 🔇 |
| B8 | S7 / S8 steer / followup | spec §9 G-019 | — | 🔇 |
| B9 | S9 失败重发 | spec §9 | — | 🔇 |
| B10 | 发送→message-stream 追加 | plan-frontend §3 UC-2 链 | Composer → useChat.send → store.appendUser → MessageStream 渲染 | ✅ |

## 对照表 · C. Companion Zones（progress-zone + git-zone）

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| C1 | progress-zone 位置 | panel/spec §5 zone + draft-companion-zones | composer **上方**（zone ③） | ✅ |
| C2 | git-zone 位置 | panel/spec §5 zone + draft-companion-zones | composer **下方**（zone ⑤），单行 38px 常驻 | ✅ |
| C3 | progress-zone 三态 | draft-companion-zones | 待办 / 进行 / 完成 / 阻塞 | 🔇 |
| C4 | git-zone 四态 | draft-companion-zones | 干净 / 已暂存 / 有 diff / 冲突 | 🔇 |
| C5 | git-zone 干净态 | draft-companion-zones + workspace/spec | 显示「工作区干净」，只留 Diff 按钮 | 🔇 |
| C6 | progress / git 内容深度 | spec §8.5 P4 v1 | v1 主路径若用到则验，否则随 companion-zones defer（C3-C5 同） | 🔇 |

## 对照表 · D. Side Drawer / 其他

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| D1 | Side Drawer（detail-pane） | draft-detail-pane + panel/spec | v1 不做，确认未渲染 | 🔇 |
| D2 | Tool 审批 UI | spec §9 G-018 | — | 🔇 |
| D3 | 用户 abort 后流转 | spec §9 G-025 | S6 停止按钮可点（基础），中断回合折叠 / 重发 defer | ✅(基础) / 🔇(高级) |
| D4 | ⌘B 三态第 3 态 | spec §9 G-033 + draft-breadcrumb-popovers 卡 E | v1 只前两态（toggle sidebar），第 3 态（折叠+脏数据→分支 popover）留 TODO | 🔇 |

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. 浏览器打开 4 个 draft 并排：
   - `$ROOT/docs/designs/v3-demo/panel/draft-message-stream.html`（A 主稿）
   - `$ROOT/docs/designs/v3-demo/panel/draft-composer-states.html`（B 主稿）
   - `$ROOT/docs/designs/v3-demo/panel/draft-companion-zones.html`（C）
   - `$ROOT/docs/designs/v3-demo/panel/draft-breadcrumb-popovers.html`（D4）
3. 新建 session 发消息（UC-2 主路径）：
   - 验 composer S1→S2→S5→S6→S1 流转（B1-B4）。
   - 验消息流追加（B10）、user 气泡靠右（A6）、流式光标（A7）。
   - 验回合折叠（A3-A5）：mock stream 完成后默认折叠，点 pill 展开。
4. DevTools 查 composer 工具条 DOM（B5-B6，确认无强分隔线）。
5. 验 auto-scroll（A9）：新消息自动滚到底。
6. 验 5 zone 位置（C1-C2，progress 上 / git 下）。
7. 点 S6 停止验基础 abort（D3 基础部分）。
8. ⌘B 验前两态（D4，toggle sidebar 正常）。
9. 验 🔇 项：确认 Side Drawer（D1）/ Tool 审批（D2）/ S3-S9（B7-B9）未渲染或入口 hide。

## FAIL 判定

- composer 输入区与工具条有强分隔线（B5）= FAIL（panel/spec 明确视觉一体）。
- 回合不折叠 / pill 计数错（A3-A4）= FAIL（核心呈现规则）。
- mock fixture 缺主要块类型（A2，spec G2-006）= FAIL（UC-2 不可验收）。
- auto-scroll 不滚（A9）= FAIL（主聊天流可用性依赖）。
- 🔇 项功能未渲染 = PASS；入口显示但无反应 = FAIL。
- PASS 后进 [va-06-p6-overview.md](va-06-p6-overview.md)。
