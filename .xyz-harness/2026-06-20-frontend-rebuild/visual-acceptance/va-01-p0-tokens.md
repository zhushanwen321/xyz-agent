---
title: VA-01 · P0 基础对齐（tokens + shadcn 装机）
phase: P0
wave: 1
task: T0.1, T0.2, T0.3
group: FG0
priority: ★★★
---

# VA-01 · P0 基础对齐

> 所有 UI phase 的前置。PASS 后才进 VA-02（Shell）。
> 本文件自包含：已列出开始 P0 验收所需的全部路径。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P0 行 + §5 D3（shadcn 装机）/ D5（radius 裁决）+ §追加 D5 + §9 G-004/G-008 |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG0（T0.1-T0.3） |
| **Plan-frontend** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan-frontend.md` §1 FG0 行 |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/design-tokens.md` | **色 / 字 / 距 / 影 / 动效原子值 SSOT**（本 VA 全部色值 / 半径基准） |
| `$ROOT/docs/designs/design-system.md` | 原语层（tokens 如何组合进组件） |
| `$ROOT/PRODUCT.md` | 冷蓝暗色品牌主张来源 |
| `$ROOT/docs/architecture/adr/0018-visual-direction.md` | 视觉方向裁决（冷蓝暗色 + Inter） |
| `$ROOT/docs/architecture/adr/0021-default-theme-direction.md` | 暗色为真默认 |
| `$ROOT/CLAUDE.md` | #10 radius 规范（已改 3/8/12px）/ 前端编码规范 |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/style.css` | modify（CSS 变量落地） |
| `$ROOT/src-electron/renderer/tailwind.config.ts` | modify（borderRadius / colors / Inter） |
| `$ROOT/src-electron/renderer/components.json` | create（shadcn-vue 配置，放 renderer workspace 根——shadcn 组件是 renderer 资源，CLI 在 renderer 目录跑） |
| `$ROOT/src-electron/renderer/src/components/ui/` | create dir（shadcn 原子） |
| ~~`composables/useChat.test.ts`(symlink)~~ | delete — **当前已不存在**（spec/plan 描述过时，见 #11 备注） |
| ~~`composables/useSlashCommands.test.ts`(symlink)~~ | delete — **当前已不存在**（同上） |

## 验收前置

- P0 是起点，无前置 phase。
- 启动：`cd $ROOT && npm run dev`

## 对照表

| # | 检查项 | 基准来源 | 期望值 | 标记 |
|---|--------|---------|--------|------|
| 1 | 画布底色 `--bg` | design-tokens.md | `#0d0d0f`（冷蓝暗色） | ✅ |
| 2 | 主色 `--accent` | design-tokens.md | `#4f8ef7` | ✅ |
| 3 | accent 变体 | design-tokens.md | `--accent-hover` / `--accent-soft` / `--accent-ring`（30% 透明）全部存在 | ✅ |
| 4 | 语义色 success / warning / danger / info | design-tokens.md（**SSOT**） | `#22c55e` / `#f5a524` / `#ef4444` / `#38bdf8`（draft 旧值如 `#34d399` 不作基准，spec G-008） | ✅ |
| 5 | 文本色阶 `--fg`/`--muted`/`--subtle` | design-tokens.md + ADR-0018 归一 | 3 级齐全（fg 最亮、subtle 最暗）；**禁止旧名 `--text-*`** | ✅ |
| 6 | radius `--radius-sm` / `DEFAULT` / `lg` | design-tokens.md + D5 | `3px` / `8px` / `12px` | ✅ |
| 7 | tailwind `borderRadius` 映射 | tailwind.config.ts | sm=3 / DEFAULT=8 / lg=12（D5） | ✅ |
| 8 | 字体 Inter | ADR-0018 + design-tokens | fontFamily 加载且 body 应用 | ✅ |
| 9 | 暗色为真默认 | ADR-0021 | 首次启动即暗色，**无亮色闪烁** | ✅ |
| 10 | shadcn 配置装机 | `src-electron/renderer/components.json` | 存在且 aliases 指向 `@/components/ui` / `@/lib/utils`（renderer workspace 根） | ✅ |
| 11 | 断链 symlink 清理 | spec §1 + plan T0.1 | `composables/` 下无 `*.test.ts` symlink（实测当前已不存在，spec/plan 描述过时——验证时仍不存在则 PASS，若重新出现需删除） | ✅ |
| 12 | token 命名归一（G-004） | spec §4 P0 注 | 画布底层变量名 = `--bg`（非 `--bg-base`，shell/spec.md 笔误待修） | ✅ |
| 13 | typecheck + lint 绿 | spec §6.5 | `npm -w @xyz-agent/frontend run typecheck` + `npm run lint` 零错（对齐 CI/README，非 `npx vue-tsc`） | ✅ |

## 执行步骤

1. `cd $ROOT && npm run dev` 启动 Electron。
2. 浏览器打开 `$ROOT/docs/designs/design-tokens.md` 查 SSOT 值。
3. Electron 窗口开 DevTools → Elements → `<html>` / `<body>` 的 computed style，对照 #1-#5、#8。
4. DevTools Console 跑 `getComputedStyle(document.documentElement).getPropertyValue('--accent')` 验色值（#2-#4）。
5. `cat $ROOT/src-electron/renderer/tailwind.config.ts` 验 #6-#7。
6. `ls $ROOT/src-electron/renderer/components.json $ROOT/src-electron/renderer/src/components/ui/` 验 #10 装机。
7. `find $ROOT/src-electron/renderer/src/composables \( -name '*.test.ts' -o -type l \)` 验 #11（预期空结果 = 无断链 symlink = PASS）。
8. `cd $ROOT && npm -w @xyz-agent/frontend run typecheck && npm run lint` 验 #13（对齐 CI/README，非 `npx vue-tsc`）。

## FAIL 判定

- 任一 ✅ 不通过 = FAIL，停 P0 修复。
- 色值以 design-tokens.md 为准（draft HTML 色值差异忽略，spec G-008）。
- 暗色闪烁（#9）= FAIL（ADR-0021 强制无闪烁）。
- PASS 后进 [va-02-p1-shell.md](va-02-p1-shell.md)。
