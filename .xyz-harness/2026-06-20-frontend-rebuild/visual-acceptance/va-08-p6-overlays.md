---
title: VA-08 · P6 Overlays（⌘K 搜索浮层 / hide 入口）
phase: P6
wave: 5
task: T6.2
group: FG6
priority: ★
---

# VA-08 · P6 Overlays

> **v1 只 hide 入口**（spec §9 G-022）：⌘K 不触发搜索浮层，sidebar 搜索 nav 项不显示。跨项目搜索范围永久 DEFERRED。若 SearchModal.vue 已建则验浮层 z-index 骨架。
> 本文件自包含。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P6 行 + §8.5 P6 v1 边界（hide 入口）+ §9 G-022（⌘K 搜索范围 + mock 数据源 DEFERRED，跨项目范围永久 defer）+ §8.5 Round 3（hide 规则） |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG6（T6.2） |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/overlays/spec.md` | **Overlay 规范**（⌘K 全局浮层 + 与 File View 树内搜索严格区分 + 四类分组 + 键盘契约） |
| `$ROOT/docs/designs/v3-demo/overlays/draft-search-modal.html` | **主对照稿**：七节探索稿，含真实可交互 ⌘K 浮层 |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/components/overlays/SearchModal.vue` | create（骨架，hide 入口） |

## 验收前置

- **VA-01 ~ VA-05 必须 PASS**。
- 启动：`cd $ROOT && npm run dev`（hide 入口检查无需 mock 数据）。

## 对照表

> v1 核心：**入口 hide 检查**。SearchModal 若已建则验浮层 z-index 骨架，四类分组 / 键盘导航全 DEFERRED。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| 1 | ⌘K 不触发 | spec §9 G-022 + §8.5 hide 规则 | 按 ⌘K（mac）/ Ctrl+K（win/linux）无浮层弹出 | ✅ |
| 2 | sidebar 搜索 nav 项不显示 | spec §9 G-022 + sidebar/spec §容器四态 | sidebar nav 无「搜索」项（DEFERRED 入口 hide） | ✅ |
| 3 | File View 树内搜索区分 | overlays/spec §归属与边界 | File View（若渲染）的内联过滤 ≠ 全局 ⌘K（两条独立路径，不混） | ✅(若建) / 🔇(未建) |
| 4 | 浮层 z-index（若已建） | draft-search-modal §实现要点 | `z-index: 1000`（高于 sidebar / workspace，低于系统 traffic-light） | ✅(若建) / 🔇(未建) |
| 5 | 浮层形态（若已建） | draft-search-modal + spec §背景 | 模糊背景 + 居中浮层（模态），非内联 | ✅(若建) / 🔇(未建) |
| 6 | 选中态 inset ring（若已建） | draft-search-modal §实现要点 + design-system §2 | Card-Active inset ring，**禁用左色条**（AI slop 反模式） | ✅(若建) / 🔇(未建) |
| 7 | 无障碍（若已建） | draft-search-modal §实现要点 | `role="dialog"` + `aria-modal="true"` | ✅(若建) / 🔇(未建) |
| 8 | 四类分组（命令 / 文件 / 符号 / 会话） | draft-search-modal + spec §四类分组 | — | 🔇 |
| 9 | 键盘契约（↑↓ / Enter / Tab / Esc） | draft-search-modal + spec §键盘契约 | — | 🔇 |
| 10 | 默认 recents 态 | spec §状态 | — | 🔇 |
| 11 | 空结果 / 加载态 | spec §状态 | — | 🔇 |
| 12 | 匹配高亮 `<mark>` | draft-search-modal §实现要点 | — | 🔇 |
| 13 | 跨项目检索范围 | spec §9 G-022 + §遗留③ | — | 🔇(永久 defer) |

## 执行步骤

1. `cd $ROOT && npm run dev`。
2. 验 hide 入口（#1-#2）：
   - 按 `⌘K`（mac）/ `Ctrl+K`（win/linux）确认无浮层弹出（#1）。
   - 查 sidebar nav 无「搜索」项（#2，与 VA-03 #21 一致）。
3. 浏览器打开 `$ROOT/docs/designs/v3-demo/overlays/draft-search-modal.html`（若 SearchModal 已建则对照 #4-#7）。
4. 若浮层已建：DevTools 查 z-index（#4）、modal 结构（#5）、选中态（#6，确认非左色条）、aria 属性（#7）。
5. 🔇 #8-#13 不验（四类分组 / 键盘 / recents / 空态 / 高亮 / 跨项目全 DEFERRED）。
6. **判定规则**：若 SearchModal.vue 完全未实现（hide 策略）→ 只验 #1-#2，#3-#7 标 🔇(未建) = PASS。若已建骨架 → #4-#7 必验。

## FAIL 判定

- ⌘K 触发浮层但功能不全（#1）= FAIL（违反 hide 规则）。
- sidebar 搜索 nav 项已显示（#2）= FAIL（与 VA-03 #21 重复约束）。
- 若已建浮层：z-index ≤ workspace（#4）/ 用左色条（#6）= FAIL。
- 若完全未建（hide）→ #1-#2 PASS 即整体 PASS。
- 🔇 项不影响判定；#13 跨项目范围永久 DEFERRED。
- PASS → 全部 8 个 VA 完成，前端 v3 重建视觉验收闭环。

## 全部 VA 完成后的整体验收

跑 spec §6 整体验收 5 项（回到 [va-00-index.md](va-00-index.md) §共用规则）：
- `npm run dev` 冷蓝画布
- `VITE_MOCK=true npm run dev` 主流程跑通
- `rg "from.*ws-client" renderer/src/` 仅剩 useConnection + api/transport.ts
- `rg "from.*stores/" renderer/src/stores/` 为空（stores 不互 import）
- `npm run lint` + `vue-tsc --noEmit` 通过
