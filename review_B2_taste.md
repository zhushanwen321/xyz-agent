# B2 Frontend Taste Review — 前端渲染端代码品味审查

**分支**: `feat-integration-pi-extension` vs `main`
**审查范围**: `src-electron/renderer/src/` (22 files changed)
**审查日期**: 2026-06-04

---

## 总结

整体代码质量良好。Extension 功能的前端集成遵循了现有架构约定（composable 单例 + refCount 保护、session 隔离、props/emit 传递）。主要问题集中在：未使用的死代码、一个硬编码颜色、一个 async 误用、以及几处过度提取的常量。

---

## 问题清单

### 1. ExtensionWidgetPanel.vue — 死代码，无任何引用

| 优先级 | 文件 | 描述 |
|---------|------|------|
| **MUST_FIX** | `components/extension/ExtensionWidgetPanel.vue` | 新增文件，但全项目无任何 import 或使用 |

`grep -r "ExtensionWidgetPanel"` 返回 0 结果。WidgetDock 直接内联渲染了 widget 行，ExtensionWidgetPanel 的折叠列表功能完全未被引用。

**修复方向**: 删除该文件，或在 WidgetDock 中集成其折叠能力（如果未来需要）。死文件会在 code review 中造成困惑。

---

### 2. ExtensionsPane.vue — `handleInstall` 是 async 但 send() 不是 Promise，installing 状态永不恢复

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **MUST_FIX** | `components/settings/ExtensionsPane.vue:33-39` | `installing.value = true` 后永远不会被重置为 `false` |

```ts
async function handleInstall() {
  const source = installSource.value.trim()
  if (!source) return
  installing.value = true    // ← 设为 true
  installError.value = ''
  send({ type: 'extension.install', payload: { source } })  // ← fire-and-forget, 没有 await
  // ← 函数结束，installing 永远是 true
}
```

`send()` 是同步的 WS 发送函数，不返回 Promise。`async` 关键字无意义。安装按钮会永久显示 "Installing..." 并被 `:disabled` 锁死。

**修复方向**:
- 移除 `async`（`send` 不是 Promise）
- 监听 server 返回的 `config.extensions` 或 error 事件来重置 `installing.value = false`
- 或者简化：不用 `installing` 状态，让按钮始终可点（WS 是 fire-and-forget，server 成功/失败会通过 event-bus 回传 extensions 列表）

---

### 3. ExtensionsPane.vue — `installError` 永远为空字符串

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **LOW** | `components/settings/ExtensionsPane.vue:16,38,99` | `installError` 只被设为 `''`，从不被赋值真实错误信息 |

模板中有 `<div v-if="installError">` 错误展示区域，但没有任何代码路径设置 `installError.value` 为非空值。需要监听 server 返回的 install 错误事件。

**修复方向**: 在 `onExtensions` 或新增的 `on('error', ...)` handler 中检查 install 相关错误并赋值。

---

### 4. WidgetDock.vue — 硬编码 rgba 颜色

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **MUST_FIX** | `components/extension/WidgetDock.vue:40` | `hover:bg-[rgba(255,255,255,0.02)]` 硬编码白色 |

项目规范禁止硬编码颜色值，必须使用 CSS 变量或语义 Tailwind 类。白色在暗色主题有效，在亮色主题会不可见。

**修复方向**: 使用 `hover:bg-[var(--hover-bg)]` 或定义一个低透明度 hover 变量。

---

### 5. WidgetDock.vue — 无用的 computed 和空 ternary

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **LOW** | `components/extension/WidgetDock.vue:15-16` | `mode` computed 的两个 ternary 分支完全相同 |

```ts
const mode = computed(() => columns.value.length === 1 ? 'single' : 'double')
```
模板中：
```html
:class="[ 'flex gap-0 overflow-hidden', mode === 'single' ? '' : '', ]"
```

`mode` computed 不影响任何样式（两个分支都返回空字符串），且 `mode` 变量只在这一个地方使用。

**修复方向**: 删除 `mode` computed，删除 `:class` 中的条件分支。

---

### 6. ExtensionsPane.vue — 缺少 Input 组件 import

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **LOW** | `components/settings/ExtensionsPane.vue:85` | 模板使用 `<Input>` 但未显式 import |

虽然 Vue 3 + `<script setup>` 的 auto-resolve 可能在某些配置下工作（如果 `design-system` 有全局注册），但 `import { Button, Dialog } from '../../design-system'` 只解构了 Button 和 Dialog，没有包含 Input。同文件其他组件都是显式 import。

**修复方向**: 添加 `Input` 到 import：`import { Button, Dialog, Input } from '../../design-system'`

---

### 7. AppStatusbar.vue — useExtensionWidget 未调用 cleanup

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **LOW** | `components/layout/AppStatusbar.vue:10` | 解构了 `useExtensionWidget()` 但未使用 cleanup |

`AppStatusbar` 是全局组件，生命周期跟应用一致，实际上不太会 unmount。但 `useExtensionWidget` 的 refCount 机制在 `PanelSessionView` 中会注册/注销，AppStatusbar 永远占一个 refCount 不会释放。

这不是 bug（AppStatusbar 需要全局监听 status 事件），但语义上 AppStatusbar 应该使用 module-level 直接订阅，而不是通过 composable 的 refCount 模式。或者至少显式注释说明为什么不需要 cleanup。

**修复方向**: 在 AppStatusbar 中加注释说明这是有意为之的全局订阅。或者将 status 事件分离为独立的 composable（useExtensionStatus）。

---

### 8. SlashMenu.vue — 常量提取的语义争议

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **INFO** | `components/chat/SlashMenu.vue:107-108` | `SCROLL_CAPTURE_PHASE = true` 和 `CENTER_DIVISOR = 2` 语义薄弱 |

`CENTER_DIVISOR = 2` 是 `rect.width / 2` 的除数，变量名没比 `2` 更清晰。`SCROLL_CAPTURE_PHASE = true` 是 `addEventListener` 的 capture 参数，变量名描述的是 API 参数名而非业务语义。

对比来看，同文件没有提取的 `closeTimer` 和 `hoveredIdx` 等命名就很清晰。

**修复方向**: 可保留可删除，属于品味问题。如果保留，`CENTER_DIVISOR` 改为 `HALF` 更直观。`SCROLL_CAPTURE_PHASE` 可直接内联 `true`。

---

### 9. ThinkingBlock.vue / RenderDescriptor.vue — 常量提取建议

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **INFO** | 多处 | `DECISECOND_MS = 100`, `SECONDS_PER_MINUTE = 60`, `PERCENT_MULTIPLIER = 100` 等常量 |

这些常量提取风格一致（从 `InputToolbar.vue` 到 `ThinkingBlock.vue` 到 `RenderDescriptor.vue` 到 `chat.ts`），但部分命名是数学描述而非语义描述：

- `DECISECOND_MS` — 语义清晰，保留合理
- `SECONDS_PER_MINUTE` — 语义清晰，保留合理
- `PERCENT_MAX = 100` — 就是 `100`，不需要名字
- `PERCENT_SCALE = 1000` — 实际是 "乘以 1000 再除以 10 保留一位小数"，变量名没传达这个意图
- `PERCENT_PRECISION = 10` — 同上
- `PERCENT_MULTIPLIER = 100` — 就是 `100`
- `PERCENT_ROUND_DIVISOR = 100` — 就是 `100`

`PERCENT_MAX` / `PERCENT_SCALE` / `PERCENT_PRECISION` / `PERCENT_MULTIPLIER` / `PERCENT_ROUND_DIVISOR` 五个常量都是 100 或其相关值，但命名各异。原始代码 `Math.min(100, Math.round(x / total * 1000) / 10)` 反而比 `Math.min(PERCENT_MAX, Math.round(x / total * PERCENT_SCALE) / PERCENT_PRECISION)` 更易读。

**修复方向**: 属于品味问题。建议对 `PERCENT_*` 系列统一策略：要么用注释解释算式，要么直接内联数字。

---

### 10. PanelBar.vue — 常量 DIR_PARTS_COUNT

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **INFO** | `components/panel/PanelBar.vue:48` | `DIR_PARTS_COUNT = 2` 替代 `.slice(-2)` |

`slice(-2)` 本身就是 "取最后 2 段" 的惯用写法，常量名 `DIR_PARTS_COUNT` 不比 `-2` 更自解释。与上面 `SECONDS_PER_MINUTE = 60` 不同，`2` 这个数字只在这一个地方出现，不存在多处引用的维护价值。

**修复方向**: 可选还原为 `.slice(-2)`，属于品味问题。

---

### 11. ExtensionsPane.vue — Install 区域英文硬编码

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **LOW** | `components/settings/ExtensionsPane.vue:64-105` | "Install Extension"、"Installing..."、"Install"、"Cancel"、"Uninstall" 等文本硬编码英文 |

项目使用 `vue-i18n`，其他文本（如 `t('settings.extensionConfig')`）都走 i18n，但新增的 Install/Uninstall 相关文本全部硬编码。

**修复方向**: 将硬编码文本提取到 i18n 资源文件中。

---

### 12. SlashMenu.vue — 模板中超长 source 三元链

| 优先级 | 文件:行号 | 描述 |
|---------|-----------|------|
| **INFO** | `components/chat/SlashMenu.vue:27-30,31` | source badge 的 class 和显示文本各有一个 6 分支三元链 |

两处相同的三元链（`cmd.source === 'builtin' ? ... : cmd.source === 'skill' ? ... : cmd.source === 'native' ? ... : ...`）出现在相邻行，且与 `InputToolbar.vue` 中的 thinking 逻辑不同，这里纯粹是 UI 映射。

**修复方向**: 抽取为 `sourceBadgeVariant(cmd.source)` 和 `sourceLabel(cmd.source)` 两个辅助函数，减少模板噪音。这是现有代码（不是本次新增），标记为 INFO。

---

## 无问题确认

以下方面经审查确认符合规范：

1. **行数限制**: 所有 `<template>` ≤ 106 行（ChatPanel），所有 `<script setup>` ≤ 243 行（PanelSessionView），远在限制内。

2. **Session 隔离**: `useExtensionWidget` 的 module-level singleton + refCount 模式正确处理了 split mode。`PanelSessionView` 中通过 `sessionWidgets` / `sessionStatuses` computed 正确按 `props.sessionId` 过滤。

3. **composable 复用**: `useExtensionWidget` 是单一 composable 同时被 `PanelSessionView` 和 `AppStatusbar` 复用，widget 和 status 共享同一份 Map 状态。

4. **Props/emit 传递**: Extension 数据流清晰：composable → PanelSessionView (过滤) → ChatPanel (props) → WidgetDock (props)。没有跨层直接访问。

5. **eslint-disable 注释**: 所有 `taste/no-native-html-elements` 的 eslint-disable 都附带了合理原因说明（复杂 gradient 样式、xyz-ui 不支持的场景）。

6. **Map 响应式更新**: `useExtensionWidget` 中通过 `new Map(map.set(k, v))` 创建新 Map 实例触发 Vue 的 ref 响应式，写法正确。

7. **事件清理**: `PanelSessionView.onUnmounted` 正确调用 `cleanupExtWidget()`，清理 event-bus 监听和 Map 状态。

8. **`PERCENT_*` 常量在 `chat.ts` 中**: 与 `InputToolbar.vue` 保持一致风格，虽然命名可商榷，但跨文件一致性是合理的。
