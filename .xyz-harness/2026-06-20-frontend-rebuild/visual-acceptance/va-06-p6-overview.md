---
title: VA-06 · P6 Overview（多会话鸟瞰骨架）
phase: P6
wave: 5
task: T6.1
group: FG6
priority: ★
---

# VA-06 · P6 Overview

> Overview 独立 L1 Region 骨架：卡片网格 + 进入 / 基本退出。高级功能（筛选 / 排序 / 后台 agent 聚合）DEFERRED。
> 本文件自包含。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P6 行 + §8.5 P6 v1 边界（骨架 + 进入 / 基本退出）+ §9 G-020（高级退出 ⌘⇧O DEFERRED） |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG6（T6.1） |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/overview/spec.md` | **Overview 规范**（独立 Region + 与 Session List 分工 + 入口落点 + 卡片信息结构） |
| `$ROOT/docs/designs/v3-demo/overview/draft-entry.html` | **主对照稿 A**：入口 + 覆盖关系（sidebar 触发 · 覆盖 workspace） |
| `$ROOT/docs/designs/v3-demo/overview/draft-overview.html` | **主对照稿 B**：卡片网格 + 筛选排序 + 后台 agent 聚合 |
| `$ROOT/docs/architecture/adr/0022-overview-entry-coverage.md` | **入口覆盖裁决**（sidebar 按钮 · 覆盖 workspace · sidebar 持久） |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/components/overview/Overview.vue` | create（卡片网格骨架） |
| `$ROOT/src-electron/renderer/src/components/overview/SessionCard.vue` | create（单卡片） |

## 验收前置

- **VA-01 ~ VA-05 必须 PASS**（panel + shell + token 就绪）。
- **VA-06 依赖 FG3**：sidebar Overview 入口按钮（T3.3）就绪。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`（需多 session mock 数据）。

## 对照表

> 核心约束：**Overview ≠ 放大版 Session List**——Session List 紧凑导航，Overview 网格统筹，两者取向必须不同。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| 1 | 入口 = sidebar Overview 按钮 | draft-entry + ADR-0022 + spec §触发 | sidebar「Overview」入口按钮触发（带 session 计数角标） | ✅ |
| 2 | 覆盖关系 | draft-entry + ADR-0022 | 激活后覆盖整个 workspace（main）区 | ✅ |
| 3 | sidebar 持久 | draft-entry + ADR-0022 | Overview 激活时 sidebar 持久不变（不被覆盖） | ✅ |
| 4 | 进入交互 | spec §触发 + §8.5 | 点 Overview 按钮 → main 区被卡片网格取代 | ✅ |
| 5 | 基本退出·点卡片 | spec §8.5 + spec §交互 | 点任意卡片 → 载入该 session → 回 chat view | ✅ |
| 6 | 基本退出·Esc | spec §触发 | Esc 退出 Overview 回 workspace | ✅ |
| 7 | Overview 按钮激活态 | draft-entry + sidebar/spec | 激活时按钮转 accent 态 | ✅ |
| 8 | 卡片网格响应式 | draft-overview + spec §布局 | 列数随视口：宽屏 4 / 笔记本 3 / 窄屏 2 / 移动 1 | ✅ |
| 9 | 卡片最小宽度 | draft-overview + spec §布局 | ~280px | ✅ |
| 10 | 卡片间距 | draft-overview + spec §布局 | 16px（`--space-4`），无分隔线靠间距区分 | ✅ |
| 11 | 卡片信息结构 | draft-overview + spec §卡片信息 | 状态点 + 标题 + 分支 pill + 摘要 + 指标 + 时间 | ✅ |
| 12 | 卡片激活态 | draft-overview + spec §卡片信息 | Card-Active（inset accent ring，弃左竖条，同 design-system §2） | ✅ |
| 13 | 空状态 session=0 | spec §边缘状态 | 图标 + 「新建一个会话开始」+ Primary 入口 | ✅ |
| 14 | 工具栏 | draft-overview + spec §布局 | 新建 + 筛选 + 排序 + 视图密度（骨架可渲染） | ✅(骨架) |
| 15 | 筛选 / 排序交互 | spec §8.5 P6 + §9 | — | 🔇 |
| 16 | 后台 agent 聚合 | draft-overview + spec §卡片信息 | — | 🔇 |
| 17 | 高级退出 ⌘⇧O | spec §9 G-020 | — | 🔇 |
| 18 | 卡片右键菜单 | spec §交互 | — | 🔇 |
| 19 | 批量操作 | spec §交互 | — | 🔇 |

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. 浏览器打开 `$ROOT/docs/designs/v3-demo/overview/draft-entry.html` + `draft-overview.html` 并排。
3. mock 多 session（≥3），点 sidebar Overview 按钮验进入（#1-#4）。
4. 确认 sidebar 持久（#3）、按钮转 accent（#7）。
5. 量卡片网格响应式（#8-#10）：调整窗口宽度看列数变化、卡片最小宽、间距。
6. 验卡片信息（#11）+ 激活 inset ring（#12，DevTools 确认非左竖条）。
7. 点卡片验退出回 chat（#5）；再进 Overview 按 Esc 验退出（#6）。
8. 删空 mock session 验空态（#13）。
9. 🔇 #15-#19 不验；确认筛选 / 排序若已渲染入口则 hide 或骨架无功能不算 FAIL。

## FAIL 判定

- Overview 覆盖了 sidebar（#3）= FAIL（ADR-0022 强制 sidebar 持久）。
- 入口不在 sidebar 按钮（#1，如在 workspace 顶栏 view-tab）= FAIL（ADR-0022 裁决）。
- 退出后 workspace 状态丢失（不恢复双 Panel）= FAIL（spec §边缘状态）。
- 卡片用左竖条激活（#12）= FAIL（design-system §2 禁止，AI slop 反模式）。
- 🔇 项未渲染 = PASS。
- PASS 后进 [va-07-p6-settings.md](va-07-p6-settings.md)（P6 三者可并行）。
