# 06 — pending 状态死类名 animate-bounce-small 修复

- **Status**: TODO
- **Commit**: 5a56eb7c8
- **Severity**: HIGH
- **Category**: Cohesion & tokens（功能性失效）
- **Estimated scope**: 1 file（sessionStatus.ts）

## Problem

`pending`（消息排队中）状态图标声明了动画类，但该类**不存在**——`bounce-small` 在 `tailwind.config.ts` animation 表和 `style.css` keyframes 中均无定义。Tailwind 不生成未注册的 utility 类，pending 态图标实际**零动画**，声明与行为不符。

```ts
/* packages/renderer/src/composables/logic/sessionStatus.ts:39-53 — current */
export const STATUS_ICON: Record<string, { icon: string; color: string; animation: string }> = {
  streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' },
  pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-bounce-small' },  // L46 — 死类
  compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' },
  working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' },
  waiting: { icon: 'Wrench', color: 'text-warn', animation: 'animate-wiggle' },  // Plan 04 改 ''
  retrying: { icon: 'Zap', color: 'text-warn', animation: 'animate-pulse-strong' },
  done: { icon: 'CheckCircle2', color: 'text-success', animation: '' },
  stopped: { icon: 'Ban', color: 'text-neutral-mid', animation: '' },
  error: { icon: 'AlertCircle', color: 'text-danger', animation: '' },
}
```

`animate-bounce-small` 死类验证：`grep -rn "bounce-small" packages/renderer/` 仅 `sessionStatus.ts:46` 一处命中，tailwind.config.ts animation map（L99-109）与 style.css keyframes（L372-424）均无定义。

注意：即使补定义，`bounce`（弹跳）也是全库唯一 bouncy 动画，与太极克制风格冲突（AUDIT §7「one bouncy component in a crisp app」）。故不补定义，改为既有且语义契合的动画。

## Target

pending 表示「消息已提交、等待发送/处理」的短暂待命态。改用 **`animate-pulse-strong`**（style.css:387-389 已定义：opacity 1→0.65 + scale 1→0.92，1.4s 呼吸）——语义为「待命呼吸」，与 retrying（L50，同为 pulse-strong）一致，且非 bouncy，契合克制风格。

```ts
/* target — sessionStatus.ts:46 */
pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-pulse-strong' },
```

备选（若 executor 判断 pending 应为纯静态）：`animation: ''`（与 done/stopped/error 一致）。但推荐 `animate-pulse-strong`，因 pending 是活跃等待（即将出发），静态更适合终态。

## Repo conventions to follow

- sessionStatus.ts 的 STATUS_ICON 是状态→图标配置的 SSOT，经 `PanelHeader.vue:88 :class="[iconConfig.color, iconConfig.animation]"` 和 `SessionCard.vue` 消费。
- `animate-pulse-strong` 已定义于 style.css:387-389 + tailwind.config.ts:108，retrying 态已使用，复用既有动画避免新增 keyframes。

## Steps

1. **`packages/renderer/src/composables/logic/sessionStatus.ts:46`** — 把 `pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-bounce-small' }` 的 `animation` 值从 `'animate-bounce-small'` 改为 `'animate-pulse-strong'`。

## Boundaries

- **Do NOT** 改其他状态的 animation 字段（streaming/compacting/working 的 spin、retrying 的 pulse-strong 保留；waiting 由 Plan 04 单独处理）。
- **Do NOT** 在 tailwind.config.ts 或 style.css 新增 `bounce-small` 定义（刻意不补，见 Problem 说明）。
- **Do NOT** 改 PanelHeader.vue / SessionCard.vue（自动跟随 STATUS_ICON）。
- 若 STATUS_ICON 映射自 commit 5a56eb7c8 后漂移，STOP 并报告。

## Verification

- **Mechanical**: `cd packages/renderer && npx vue-tsc --noEmit` → exit 0；`pnpm lint` → 无新增 error。
- **静态确认**: `grep -rn "bounce-small" packages/renderer/src/` → 0 命中（死类彻底清除）。
- **Feel check**（`pnpm dev`，构造 pending 态——如发消息后、发送前的排队瞬间，或 dev 工具强制 status='pending'）：
  - pending 态的 PanelHeader 图标（ArrowUpCircle）有可见的呼吸（opacity + 微 scale，1.4s 周期）。
  - 不再是死类的静态零反馈。
  - 与 retrying 态动画观感一致（同 pulse-strong）。
- **Done when**: pending 态图标有与声明一致的可见动画，`bounce-small` 全仓零残留。
