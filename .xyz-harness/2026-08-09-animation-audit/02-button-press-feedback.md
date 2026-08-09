# 02 — Button 按下物理反馈（active scale）

- **Status**: TODO
- **Commit**: 5a56eb7c8
- **Severity**: MEDIUM
- **Category**: Physicality & origin
- **Estimated scope**: 1 file（buttonVariants）

## Problem

按钮是全应用最高频的交互元素，但**全局无任何 `:active` 按下反馈**。全仓 grep `active:scale` 零命中。当前 `buttonVariants` 只有 hover 背景变化 + `transition-colors`，按下时零物理回响——太极「克制」风格不等于死板，Linear/Raycast 的按钮都有微缩反馈。

```ts
/* packages/renderer/src/components/ui/button/index.ts:8 — current */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent),0_0_0_4px_rgba(0,0,0,0.4)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: { ... },
    ...
  },
)
```

AUDIT §3「Press feedback: `transform: scale(0.97)` on `:active` with `transition: transform 160ms ease-out`. Keep it subtle (0.95–0.98).」

## Target

在 base class 加 `active:scale-[0.97]`，并把 `transition-colors` 扩展为同时覆盖 transform（让 press 反馈也平滑）。时长用 token `--duration-fast`（120ms）。

```ts
/* target */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[background-color,color,border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease)] active:scale-[0.97] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent),0_0_0_4px_rgba(0,0,0,0.4)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: { ... },
    ...
  },
)
```

要点：
- `transition-[background-color,color,border-color,transform]`：显式列出会变的属性（替代 `transition-colors`，加上 transform），避免 `transition-all`。
- `duration-[var(--duration-fast)] ease-[var(--ease)]`：引用 token（120ms），落在 AUDIT 的 100-160ms 区间。
- `active:scale-[0.97]`：press 微缩，AUDIT 推荐区 0.95-0.98 的中值。
- 禁用态由 `disabled:pointer-events-none` 保证不触发 active。

## Repo conventions to follow

- 动效 token：`--ease: cubic-bezier(0.4,0,0.2,1)`、`--duration-fast: 120ms`（style.css:128-129），已有组件用 `duration-[var(--duration-fast)] ease-[var(--ease)]` 范式（如 `SettingsModal.vue:32`）。
- 按 AUDIT §5，显式 `transition-[props]` 优于 `transition-all`（避免 GPU 外属性意外参与动画）。

## Steps

1. **`packages/renderer/src/components/ui/button/index.ts:9`** — 把 base class 字符串中的 `transition-colors` 替换为 `transition-[background-color,color,border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease)] active:scale-[0.97]`。其余字符（focus-visible / disabled / svg 规则）完全不变。

## Boundaries

- **Do NOT** 改 variants（default/secondary/ghost/danger）和 size 的任何值。
- **Do NOT** 改 `Button.vue`（它只消费 buttonVariants）。
- **Do NOT** 加 `transition-all`。
- 若 `index.ts` 的 base class 自 commit 5a56eb7c8 后漂移，STOP 并报告。

## Verification

- **Mechanical**: `cd packages/renderer && npx vue-tsc --noEmit` → exit 0；`pnpm lint` → 无新增 error。
- **Feel check**（`pnpm dev`）：
  - 点击侧栏「新建任务」「搜索」按钮、对话框 Confirm/Cancel 按钮、设置页所有按钮：按下瞬间应见轻微缩小（97%），松手回弹，120ms 内完成。
  - 长按某按钮：保持 97% 缩放不回弹（active 态持续），松手才回弹。
  - DevTools → Animations 面板 10% 速度：确认 transform 是 `scale(0.97)`，非位移/无 scale(0)。
  - `prefers-reduced-motion: reduce`：press 仍触发但几乎瞬切（全局兜底压到 0.01ms），不影响功能。
- **Done when**: 任意 Button 按下有可见且克制的 scale(0.97) 回弹。
