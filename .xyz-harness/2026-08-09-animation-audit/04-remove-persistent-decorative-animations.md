# 04 — 删除常驻装饰性动画（pulse-dot / steer-breathe / wiggle）

- **Status**: TODO
- **Commit**: 5a56eb7c8
- **Severity**: MEDIUM
- **Category**: Purpose & frequency
- **Estimated scope**: 4 files（SegmentedTab / SessionItem / composer-shell / sessionStatus）

## Problem

四处常驻/无限循环动画违反 AUDIT §1「100+ 次/天可见元素 → no animation」「it looks cool 型动画应删」。这些是太极「克制」风格最直接的视觉噪音源：状态已由颜色 + 文字表达，动画是冗余装饰。Raycast/Linear 侧栏零常驻动效。

**1. SegmentedTab.vue:25 — badge 无限 pulse**
```html
<!-- packages/renderer/src/components/sidebar/SegmentedTab.vue:25 -->
<span
  v-if="tab.badge"
  class="absolute right-1 top-1 size-[7px] rounded-full bg-accent animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none"
/>
```
badge 由 `subagentRunningCount/workflowRunningCount > 0` 驱动——后台任务运行期间（可达数小时），侧栏 tab 上的 7px 圆点以 1.8s 周期无限脉动。tab 是侧栏常驻控件（100+ 次/天可见）。

**2. SessionItem.vue:68 — running 指示条无限 pulse**
```html
<!-- packages/renderer/src/components/sidebar/SessionItem.vue:68 -->
<span class="inline-block h-[9px] w-[3px] rounded-[2px] bg-accent animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none" />
```
running 态 session 的 badge 内 9×3px 条无限脉动；多个 running session 即多个闪烁源。状态已由 accent 底色 + 耗时文字（timeLabel 每分钟自增）双重表达。

**3. composer-shell.ts:285 — 流式期 composer 呼吸环**
```ts
// packages/renderer/src/composables/panel/composer-shell.ts:285（boxClass computed 三级链之一）
: isActive.value
  ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe'
  : hasInput.value
```
整个 streaming 期间 composer 边框 2.6s 无限呼吸（box-shadow 3px↔4px）。composer 是最高频 UI，状态已被消息流可见流式文本满足；呼吸是冗余放大。且 box-shadow 动画是 paint 属性（AUDIT §5 轻微违规）。对比同文件 bash-mode（L284）用静态 ring，两态标准不一致。

**4. sessionStatus.ts:49 — waiting 态无限 wiggle**
```ts
// packages/renderer/src/composables/logic/sessionStatus.ts:49（STATUS_ICON 映射）
waiting: { icon: 'Wrench', color: 'text-warn', animation: 'animate-wiggle' },
```
`wiggle` 1.2s 无限 ±6° 摆动，经 `PanelHeader.vue:88 :class="[iconConfig.color, iconConfig.animation]"` 消费，渲染在 PanelHeader 常驻 13px 图标。waiting 覆盖 tool 审批/ask-user 等待，**可持续无限长**（用户离开），期间常驻图标永久摆动。streaming 的 spin（L45）有「正在产出」语义可辩护，wiggle 无。

## Target

全部降为**静态**（靠颜色/底色表达状态，符合 AUDIT §1「remove the animation」与太极克制风格）：

```html
<!-- SegmentedTab.vue:25 target — 静态 badge（motion-reduce 类一并删除，静态无需守卫） -->
<span
  v-if="tab.badge"
  class="absolute right-1 top-1 size-[7px] rounded-full bg-accent"
/>
```

```html
<!-- SessionItem.vue:68 target — 静态指示条 -->
<span class="inline-block h-[9px] w-[3px] rounded-[2px] bg-accent" />
```

```ts
// composer-shell.ts:285 target — 静态 accent 边框（与 bash-mode 静态 ring 标准统一）
: isActive.value
  ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)]'
  : hasInput.value
```

```ts
// sessionStatus.ts:49 target — waiting 改静态 warn 色（删 animation 字段值）
waiting: { icon: 'Wrench', color: 'text-warn', animation: '' },
```

## Repo conventions to follow

- sessionStatus.ts 的 STATUS_ICON 是 `Record<string, { icon, color, animation }>` 结构（L43-53），done/stopped/error 态已用 `animation: ''`（静态）——本 plan 把 waiting 对齐到既有静态范式。
- PanelHeader.vue:88 / SessionCard.vue 等消费方用 `:class="[iconConfig.color, iconConfig.animation]"`，`animation: ''` 渲染为无类名，安全。

## Steps

1. **`packages/renderer/src/components/sidebar/SegmentedTab.vue:25`** — 删 badge class 中的 `animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none`（保留 `absolute right-1 top-1 size-[7px] rounded-full bg-accent`）。

2. **`packages/renderer/src/components/sidebar/SessionItem.vue:68`** — 删指示条 class 中的 `animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none`（保留 `inline-block h-[9px] w-[3px] rounded-[2px] bg-accent`）。

3. **`packages/renderer/src/composables/panel/composer-shell.ts:285`** — 删 `'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe'` 末尾的 ` animate-steer-breathe`（保留前面的 border + shadow）。

4. **`packages/renderer/src/composables/logic/sessionStatus.ts:49`** — 把 `waiting: { icon: 'Wrench', color: 'text-warn', animation: 'animate-wiggle' }` 改为 `animation: ''`。

## Boundaries

- **Do NOT** 改 streaming / compacting / working / retrying / pending 的 animation 字段（见 Plan 06 处理 pending）。streaming 的 spin 保留（有「正在产出」语义）。
- **Do NOT** 删 `@keyframes pulse-dot` / `wiggle` / `steer-breathe` 定义（style.css）——pulse-dot 仍被 SystemShortcutSection.vue:13（录音提示，秒级短暂）消费；wiggle/steer-breathe 暂留（是否清死定义见 Plan 01 README 说明，本 plan 不动 keyframes）。
- **Do NOT** 改 PanelHeader.vue / SessionCard.vue（它们自动跟随 STATUS_ICON 变化）。
- 若上述 verbatim 代码自 commit 5a56eb7c8 后漂移，STOP 并报告。

## Verification

- **Mechanical**: `cd packages/renderer && npx vue-tsc --noEmit` → exit 0；`pnpm lint` → 无新增 error。
- **单测**: `cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts` — 注意：该测试 L79 断言 `expect(badge.classes()).toContain('animate-[pulse-dot_1.8s_ease-in-out_infinite]')`。本 plan 删该动画后，此断言会失败——**需同步把断言改为 `not.toContain`**（这是正面修复，非绕过测试：意图已变，测试须跟）。
- **Feel check**（`pnpm dev`）：
  - 有 subagent/workflow 运行时：SegmentedTab badge 为**静态** accent 圆点（不再脉动）。
  - 有 running session：SessionItem badge 内指示条为**静态**（不再脉动），耗时文字仍每分钟更新。
  - composer 在 streaming（steer 激活）态：边框为**静态** accent + 静态 ring（不再呼吸）。
  - session 处于 waiting 态（如 tool 审批中）：PanelHeader 图标为**静态** warn 色扳手（不再摆动）。
  - 整体侧栏/composer 在无主动操作时**完全静止**——这是太极克制的正确体感。
  - DevTools Rendering 面板观察：这些区域无持续 paint（box-shadow 动画消失后不再持续重绘）。
- **Done when**: 四处动画均变为静态，侧栏与 composer 在稳态下零常驻动效。
