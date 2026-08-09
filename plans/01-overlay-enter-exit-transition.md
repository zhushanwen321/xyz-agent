# 01 — 浮层/弹窗进出场过渡动画

- **Status**: TODO
- **Commit**: 5a56eb7c8
- **Severity**: HIGH
- **Category**: Physicality & origin / Missed opportunities
- **Estimated scope**: 5 files（style.css + 4 个 reka 封装组件）

## Problem

项目的 reka-ui 浮层封装组件声明了一整套进出场动画 utility 类，但这些类**实际不生成任何 CSS**——`tailwindcss-animate` 插件未安装（`pnpm-lock.yaml` 0 命中、`packages/renderer/package.json` 无此依赖、`packages/renderer/tailwind.config.ts:113` 为 `plugins: []`）。已用 `npx tailwindcss` CLI 编译实证：产物中 `animate-in` / `zoom-in-95` / `fade-in-0` / `slide-in-from-*` 命中数为 0。

结果：**所有 Popover / Select / Dialog / HoverCard 当前瞬开瞬关，零过渡**。维护者以为有动画，实际没有。

四个组件的当前代码（死类）：

```html
<!-- packages/renderer/src/components/ui/popover/PopoverContent.vue:30 -->
<PopoverContent
  :class="cn(
    'z-[1100] min-w-[240px] rounded-md border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
    props.class,
  )"
>
```

```html
<!-- packages/renderer/src/components/ui/select/SelectContent.vue:36 -->
'relative z-[1100] max-h-[var(--reka-select-content-available-height)] min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-md border border-border-strong bg-bg-elevated text-neutral-fg shadow-2 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
```

```html
<!-- packages/renderer/src/components/ui/hover-card/HoverCardContent.vue:28 -->
'z-[90] min-w-[240px] rounded-md border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
```

```html
<!-- packages/renderer/src/components/ui/dialog/DialogContent.vue:42（DialogContent） -->
<class="cn(
  'fixed left-1/2 top-1/2 z-[1000] grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-surface p-6 shadow-lg duration-200 select-text data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
  props.class,
)">

<!-- packages/renderer/src/components/ui/dialog/DialogContent.vue:36（DialogOverlay） -->
<class="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
```

**附带问题**：reka-ui 的 PopperContent 会在元素上设置 CSS 变量 `--reka-popper-transform-origin`（见 `node_modules/reka-ui/dist/Popper/PopoverContent.js`），但项目任何组件都未消费它——即使动画启用，缩放也从 center 而非触发点。AUDIT §3 明令 popover/dropdown 应从 trigger 缩放展开。

## Target

用 CSS `transition`（可中断 retarget，AUDIT §4 偏好）替代失效的 keyframes utility，由 reka 的 `data-state` 属性驱动。入场起点用 `@starting-style`（Chromium 117+，Electron 42 内核远超）。两类过渡：

- **popover 族**（Popover/Select/HoverCard）：`transform-origin: var(--reka-popper-transform-origin)` 跟随触发点，scale 0.96→1 + opacity
- **dialog**（居中 modal，AUDIT §3 允许 center origin）：scale 0.96→1 + opacity，transform 需保留既有 `translate(-50%,-50%)` 居中

在 `packages/renderer/src/style.css` 全局定义过渡原语类（与既有 keyframes SSOT 并列，同属「全局动画原语」；`@starting-style` 无法用 Tailwind utility 表达，属三层样式纪律的 escape hatch）：

```css
/* target — 追加到 style.css，紧接 @keyframes 区块之后、reduced-motion 块之前 */

/* ============================================================
   浮层进出场过渡（reka data-state 驱动）
   替代失效的 tailwindcss-animate utility（插件未安装，类不生成）。
   用 transition（可中断 retarget）而非 keyframes（restart from zero）。
   ============================================================ */

/* popover 族：缩放跟随触发点（reka 计算 --reka-popper-transform-origin） */
.reka-popover-transition {
  transition: opacity var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease);
  transform-origin: var(--reka-popper-transform-origin, center);
}
.reka-popover-transition[data-state='open'] {
  opacity: 1;
  transform: scale(1);
}
.reka-popover-transition[data-state='closed'] {
  opacity: 0;
  transform: scale(0.96);
}
@starting-style {
  .reka-popover-transition[data-state='open'] {
    opacity: 0;
    transform: scale(0.96);
  }
}

/* dialog：居中缩放（modal 允许 center origin，transform 保留 translate 居中） */
.reka-dialog-transition {
  transition: opacity var(--duration) var(--ease), transform var(--duration) var(--ease);
}
.reka-dialog-transition[data-state='open'] {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}
.reka-dialog-transition[data-state='closed'] {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.96);
}
@starting-style {
  .reka-dialog-transition[data-state='open'] {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.96);
  }
}

/* dialog 遮罩：纯 opacity */
.reka-overlay-transition {
  transition: opacity var(--duration) var(--ease);
}
.reka-overlay-transition[data-state='open'] { opacity: 1; }
.reka-overlay-transition[data-state='closed'] { opacity: 0; }
@starting-style {
  .reka-overlay-transition[data-state='open'] { opacity: 0; }
}
```

四个组件的 class 字符串替换（删全部 `data-[state=...]:animate-*` / `zoom-*` / `fade-*` / `slide-*` / `duration-200` 死类，加过渡原语类）：

```html
<!-- PopoverContent.vue:30 target -->
'z-[1100] min-w-[240px] rounded-md border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none reka-popover-transition'

<!-- SelectContent.vue:36 target -->
'relative z-[1100] max-h-[var(--reka-select-content-available-height)] min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-md border border-border-strong bg-bg-elevated text-neutral-fg shadow-2 outline-none reka-popover-transition'

<!-- HoverCardContent.vue:28 target -->
'z-[90] min-w-[240px] rounded-md border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none reka-popover-transition'

<!-- DialogContent.vue:42 target（注意：删 -translate-x-1/2 -translate-y-1/2，由 transition 的 transform 承担居中） -->
'fixed left-1/2 top-1/2 z-[1000] grid w-full max-w-lg gap-4 border bg-surface p-6 shadow-lg select-text reka-dialog-transition sm:rounded-lg'

<!-- DialogContent.vue:36 target（DialogOverlay） -->
'fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm reka-overlay-transition'
```

**CollapsibleContent 暂不在本 plan 范围**：它仅 `PresetListSection.vue` 一个低频消费方（设置页），且其动画机制是 height/width（reka 的 `--reka-collapsible-content-height`）而非 scale，需单独设计。本 plan 仅保留其死类不动（后续如需，另立 plan）。

## Repo conventions to follow

- 动效 token SSOT 在 `packages/renderer/src/style.css`：`--ease: cubic-bezier(0.4,0,0.2,1)`、`--duration-fast: 120ms`、`--duration: 200ms`、`--duration-slow: 320ms`（style.css:128-131）
- 全局 keyframes 原语已定义在 style.css（`@keyframes spin` 等，L372+），本 plan 的过渡原语类紧随其后，同属「全局动画原语」层
- 组件 class 用 Tailwind utility 优先，过渡原语用语义类名（`.reka-*-transition`）引用，保持模板可读
- reka data-state 驱动的范式：reka-ui 关闭时把 `data-state` 设为 `closed` 并保留 DOM 直到 `transitionend`/`animationend`（Presence 机制），本 plan 的 transition 方案天然兼容

## Steps

1. **`packages/renderer/src/style.css`** — 在 `@keyframes taiji-spin { ... }` 块之后、`@media (prefers-reduced-motion: reduce)` 块之前，粘贴上面「target」里的全部 CSS（3 个原语类 + 3 个 `@starting-style` 块）。

2. **`packages/renderer/src/components/ui/popover/PopoverContent.vue:30`** — 把 class 字符串中的 `data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95` 替换为 `reka-popover-transition`。

3. **`packages/renderer/src/components/ui/select/SelectContent.vue:36`** — 同上替换为 `reka-popover-transition`。

4. **`packages/renderer/src/components/ui/hover-card/HoverCardContent.vue:28`** — 同上替换为 `reka-popover-transition`。

5. **`packages/renderer/src/components/ui/dialog/DialogContent.vue`**：
   - L42 DialogContent：把 `data-[state=open]:animate-in ... slide-in-from-top-[48%]` 全部死类删除，同时删除 `-translate-x-1/2 -translate-y-1/2`（由 `.reka-dialog-transition` 的 transform 承担居中），删除 `duration-200`，加上 `reka-dialog-transition`。
   - L36 DialogOverlay：把 `data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0` 替换为 `reka-overlay-transition`。

## Boundaries

- **Do NOT** 改 `components/ui/collapsible/CollapsibleContent.vue`（不在本 plan 范围，机制不同）。
- **Do NOT** 改组件的 template 结构、props、非动画相关 class（z-index / 颜色 / 尺寸 / 阴影 / `backdrop-blur-sm` 等全部保持不变）。
- **Do NOT** 安装 `tailwindcss-animate` 或任何新依赖——本方案刻意用手写 transition（可中断性更优、无依赖、token 原生）。
- **Do NOT** 改 `tailwind.config.ts`。
- 若某组件的 class 字符串与本 plan 引用的 verbatim 代码不符（自 commit 5a56eb7c8 后漂移），STOP 并报告，不要臆测。

## Verification

- **Mechanical**:
  - `cd packages/renderer && npx vue-tsc --noEmit` → exit 0
  - `pnpm lint`（renderer）→ 无新增 error
  - 全仓 grep 确认无残留死类：`grep -rn "animate-in\|zoom-in-95\|zoom-out-95\|fade-in-0\|fade-out-0\|slide-in-from\|slide-out-to" packages/renderer/src/components/ui/` → 应仅 CollapsibleContent.vue 命中（本 plan 不动它）
- **Feel check**（`pnpm dev` 后）：
  - 触发 CommandPopover（⌘K）/ ModelSelectPopover / ThinkingLevelPopover：浮层应**从触发按钮处缩放展开**（非中心），120ms，不闪。
  - 连续快速开关同一 popover 5 次：动画**中途重定向**，不 restart from zero（对比 keyframes 行为）。
  - 打开 ConfirmDialog / 含 DialogContent 的弹窗：居中缩放（0.96→1）+ 遮罩淡入 200ms。
  - DevTools → Animations 面板，速度调到 10%，确认 popover 的 transform-origin 落在触发器一侧（非几何中心）。
  - DevTools → Rendering →勾选 `prefers-reduced-motion: reduce`：弹层变为瞬切（由全局 reduced-motion 块兜底），但仍出现/消失（不卡死）。
- **Done when**: 4 个组件的浮层均有可见的从触发点（或 dialog 的中心）缩放淡入过渡，且快速开关不闪。
