# 05 — reduced-motion 兜底细化 + TaijiLogo 守卫生效

- **Status**: TODO
- **Commit**: 5a56eb7c8
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 2 files（style.css + TaijiLogo.vue）

## Problem

**问题 1：全局 reduced-motion 兜底过激**（AUDIT §6）

```css
/* packages/renderer/src/style.css:429-434 — current */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

AUDIT §6 明令「reduced motion = fewer and gentler, **not zero** — keep transitions that aid comprehension, remove position changes」。当前块把 `transition-duration` 也清零，杀光了**纯 opacity/color 的辅助理解过渡**：hover 背景反馈、进度条颜色分档、toast 淡入、回底浮层 fade、设置页切换淡入（Plan 后续会加）等。reduced-motion 用户失去所有反馈过渡——正是 AUDIT §6 点名的「nuke all feedback」反模式。

**问题 2：TaijiLogo 组件级 motion-reduce 守卫是 no-op**（前置依赖）

```html
<!-- packages/renderer/src/components/icons/TaijiLogo.vue:25-26 — current -->
class="block shrink-0 motion-reduce:animate-none"
:style="spin ? { animation: `taiji-spin ${duration}s linear infinite`, transformOrigin: 'center' } : undefined"
```

动画走**内联 `style`**，内联 style 优先级高于任何类选择器——`motion-reduce:animate-none`（生成的 `@media (prefers-reduced-motion){ .motion-reduce:animate-none{ animation:none } }`）**无法覆盖内联 style**。当前 logo 停转完全依赖问题 1 的全局 `!important` 块。一旦问题 1 细化（去掉 transition-duration 清零、改用更精准的选择器），logo 旋转会复活且无守卫。

**依赖关系**：必须先修问题 2（让组件级守卫真正生效），再细化问题 1，否则 logo 在 reduced-motion 下会复转动。

## Target

**问题 2 先修**：spin 改由 class 注入，使 `motion-reduce:animate-none` 能生效（logo 默认行为不变，仍 8s 旋转——本 plan 不动品牌决策，只让 a11y 守卫工作）。

```html
<!-- TaijiLogo.vue target — spin 用动态 class，内联 style 只留 transformOrigin -->
<svg
  :width="size"
  :height="size"
  viewBox="0 0 1200 1200"
  preserveAspectRatio="xMidYMid meet"
  class="block shrink-0 motion-reduce:animate-none"
  :class="spin ? `animate-[taiji-spin_${duration}s_linear_infinite]` : ''"
  :style="{ transformOrigin: 'center' }"
  aria-hidden="true"
>
```

要点：`animation` 从内联 style 移到 `:class`（Tailwind arbitrary `animate-[...]`，引用全局 `@keyframes taiji-spin`）。`transformOrigin: 'center'` 留在内联 style（它不影响 animation 的可覆盖性）。`motion-reduce:animate-none` 现在能正确覆盖 class 注入的动画。

**问题 1 再修**：把 transition 清零限定到**运动属性**（transform/translate/rotate/scale/left/top/width/height 等会触发位移的），保留 opacity/color/background-color/border-color 等「辅助理解」过渡。

```css
/* style.css target — 替换 L429-434 整块 */
@media (prefers-reduced-motion: reduce) {
  /*
   * Reduced motion = 更少更温和，非零（AUDIT §6）。
   * - 动画（位移/旋转/脉动类）：duration 归零 + 仅播一次 → 瞬切到终态
   * - transition：只清零运动属性（transform/位移类），保留 opacity/color 过渡
   *   （辅助理解类反馈不应被一并砍掉）
   */
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
  /* 保留辅助理解的非位移过渡（覆盖上面的 0.01ms） */
  *, *::before, *::after {
    transition-property: opacity, color, background-color, border-color, fill, stroke, box-shadow, filter !important;
    transition-duration: var(--duration-fast) !important;
  }
}
```

要点：
- 第一组规则把所有 transition 压到瞬切（运动属性 transform/left/width 等瞬切 = 无位移动画，符合 reduce 语义）。
- 第二组规则用 `transition-property` 白名单覆盖回 opacity/color/bg/border/fill/stroke/box-shadow/filter，时长恢复 120ms——这些是 AUDIT §6 要保留的「aid comprehension」过渡。
  - **[HISTORICAL] transition-property 必须带 `!important`**（F2 修复）：组件级 transition-* 类特异性 (0,1,0) 高于元素选择器 (0,0,0)，无 !important 时白名单被组件原属性（含 transform）覆盖，位移过渡在 reduce 下仍以 120ms 动画（比修复前 0.01ms 瞬切反而更慢），白名单机制失效。
- transform / translate / top / left / width / height / margin / padding 等运动属性不在白名单 → 保持瞬切。

## Repo conventions to follow

- 动效 token `--duration-fast: 120ms`（style.css:129）。
- TaijiLogo 的 `animate-[taiji-spin_...]` 引用全局 `@keyframes taiji-spin`（style.css:421-424），Tailwind arbitrary animation 范式已被项目其他组件使用（如 `SegmentedTab.vue:25` 的 `animate-[pulse-dot_...]`，Plan 04 删除后仍作为范式参考存在于 SystemShortcutSection.vue:13）。
- `motion-reduce:animate-none` 是 Tailwind 内置 variant，项目已用（SegmentedTab/SessionItem/AskUserOverlay）。

## Steps

1. **`packages/renderer/src/components/icons/TaijiLogo.vue`** — 模板 `<svg>` 元素：
   - `class` 保持 `"block shrink-0 motion-reduce:animate-none"` 不变。
   - 新增 `:class="spin ? \`animate-[taiji-spin_${duration}s_linear_infinite]\` : ''"`（注意是 `:class` 动态绑定，与静态 `class` 并存，Vue 会合并）。
   - `:style` 从 `spin ? { animation: ..., transformOrigin: 'center' } : undefined` 改为 `{ transformOrigin: 'center' }`（删 animation，transformOrigin 始终保留——无 spin 时也无害）。

2. **`packages/renderer/src/style.css:429-434`** — 用 target 中的两段 `@media (prefers-reduced-motion: reduce)` 规则替换原单段规则（含注释）。

## Boundaries

- **Do NOT** 改 TaijiLogo 的 `spin` 默认值（`true`）或 `duration` 默认值（`8`）——品牌 logo 旋转保留（用户明确要求）。本 plan 只让 reduced-motion 守卫真正生效。
- **Do NOT** 改 TaijiLogo 的 SVG path 几何。
- **Do NOT** 删其他组件已有的 `motion-reduce:animate-none` 局部守卫（它们与全局块双保险，细化后局部守卫仍正确工作）。
- 若 style.css 的 reduced-motion 块或 TaijiLogo 模板自 commit 5a56eb7c8 后漂移，STOP 并报告。

## Verification

- **Mechanical**: `cd packages/renderer && npx vue-tsc --noEmit` → exit 0；`pnpm lint` → 无新增 error。
- **Feel check**（`pnpm dev`）：
  - 默认（未开 reduced-motion）：logo 正常 8s 旋转——**行为与改动前完全一致**（验证未误伤品牌）。
  - DevTools → Rendering → 勾选 `prefers-reduced-motion: reduce`：
    - **logo 停止旋转**（验证问题 2 守卫生效）。
    - hover 任意按钮/nav-item：背景色**仍有 120ms 渐变**（验证 opacity/color 过渡被保留，非瞬切）。
    - 触发 toast：仍有淡入（非瞬现）。
    - 触发弹层（Plan 01 完成后）：位移类过渡瞬切（不缩放），但 opacity 仍淡入。
  - DevTools Animations 面板：reduce 模式下无 transform/位移类动画在跑。
- **Done when**: reduced-motion 下 logo 停转、位移动画消失，但 hover/toast/弹层的颜色与透明度反馈保留。
