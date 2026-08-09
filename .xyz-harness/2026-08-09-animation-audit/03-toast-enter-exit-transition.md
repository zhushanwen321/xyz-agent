# 03 — Toast 进出场过渡修复

- **Status**: TODO
- **Commit**: 5a56eb7c8
- **Severity**: HIGH
- **Category**: Easing & duration / Performance
- **Estimated scope**: 1 file（ToastContainer.vue scoped style）

## Problem

Toast 进出场是所有用户高频看到的动画，但 scoped style 三错叠加：

```css
/* packages/renderer/src/components/ui/ToastContainer.vue:73-76 — current */
<style scoped>
.toast-enter-active { transition: all 0.3s ease-out; }
.toast-leave-active { transition: all 0.2s ease-in; }
.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>
```

1. **`transition: all`**（AUDIT §5「always a finding」）：未限定属性，动画一切可过渡属性。
2. **leave 用 `ease-in`**（AUDIT §2「ease-in on UI is always a finding」）：起速慢，恰好延迟用户正在盯着的消失瞬间。leave 也该 ease-out（甚至更快、更果断）。
3. **脱 token**：0.3s / 0.2s 硬编码，与 `--ease` / `--duration-*` 体系完全脱节（token 只有 120/200/320ms）。enter 0.3s 也贴着 300ms 上限。

好消息：用 Vue `<TransitionGroup>` + CSS transition（非 keyframes），AUDIT §4 可中断性已合规（toast 堆叠 retarget 正确），本 plan 只修这三错。

## Target

显式限定过渡属性（opacity + transform），引用 token，enter/leave 都用 ease-out，leave 更短更果断。

```css
/* target */
<style scoped>
.toast-enter-active { transition: opacity var(--duration) var(--ease), transform var(--duration) var(--ease); }
.toast-leave-active { transition: opacity var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease); }
.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>
```

要点：
- `transition: opacity ..., transform ...`：显式列属性，替代 `transition: all`。
- enter 200ms（`--duration`）/ leave 120ms（`--duration-fast`）：leave 比.enter 快，消失更果断（用户已看过 toast，无需再吸引注意）。
- 两态都用 `var(--ease)`（cubic-bezier(0.4,0,0.2,1)），消除 ease-in。
- `translateX(20px)` 入场/出场方向保持不变（从右滑入、向右滑出）。

## Repo conventions to follow

- 动效 token：`--ease`、`--duration`（200ms）、`--duration-fast`（120ms）（style.css:128-130）。
- Vue `<TransitionGroup>` 用 `name="toast"` 生成 `.{name}-enter-active` 等类名，本 plan 保持命名不变。

## Steps

1. **`packages/renderer/src/components/ui/ToastContainer.vue:73-74`** — 把 `.toast-enter-active` 和 `.toast-leave-active` 两条规则替换为 target 中的两条。L75-76 的 `.toast-enter-from` / `.toast-leave-to` 保持不变。

## Boundaries

- **Do NOT** 改 template（`<TransitionGroup>` / `toastClass` / icon 逻辑）。
- **Do NOT** 改 `translateX(20px)` 的方向或距离。
- **Do NOT** 加 keyframes（保持 transition 以维持可中断性）。
- 若 scoped style 自 commit 5a56eb7c8 后漂移，STOP 并报告。

## Verification

- **Mechanical**: `cd packages/renderer && npx vue-tsc --noEmit` → exit 0；`pnpm lint` → 无新增 error。
- **Feel check**（`pnpm dev`，触发 toast 的方式：在能弹 toast 的操作里观察，如可用 dev 工具直接 `useToast().error('test')`）：
  - toast 从右滑入 + 淡入，200ms，起速快（ease-out）。
  - toast 向右滑出 + 淡出，120ms，干脆消失（非缓慢淡出）。
  - 快速连续弹 3 条 toast：堆叠平滑重排，无闪烁、无 restart from zero。
  - DevTools Animations 10%：确认进入为 ease-out 曲线（前快后慢），离开同样是 ease-out（不是 ease-in 的前慢后快）。
- **Done when**: toast 进出顺滑、果断，且全程消费 token。
