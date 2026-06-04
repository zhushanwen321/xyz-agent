# Frontend 渲染端健壮性审查报告

**分支**: `feat-integration-pi-extension` (main...HEAD)
**审查范围**: `src-electron/renderer/src/`
**日期**: 2026-06-04

---

## MUST_FIX

### 1. ExtensionsPane.vue: `Input` 组件未导入

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:6,85`
- **描述**: 模板中使用了 `<Input v-model="installSource" ...>`（第 85 行），但 `<script setup>` 第 6 行仅导入了 `Button, Dialog`，未导入 `Input`。运行时 Vue 无法解析该组件，install 输入框将无法渲染或行为异常。
- **修复方向**: 在第 6 行导入中追加 `Input`：
  ```ts
  import { Button, Dialog, Input } from '../../design-system'
  ```

### 2. ExtensionsPane.vue: `installing` 状态永远不重置

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:36`
- **描述**: `handleInstall()` 设置 `installing.value = true`（第 36 行）后通过 `send()` 发送 `extension.install` 消息。服务端成功后回传 `config.extensions`，失败时回传 error，但两者都未重置 `installing` 为 `false`。一旦点击 Install，按钮将永远显示 "Installing..." 并被禁用。
- **修复方向**: 在 `onExtensions` 回调中（收到更新列表即意味着 install 完成）重置 `installing.value = false`；同时监听 error 事件也重置状态。或在 `handleInstall` 中不依赖 `installing` 状态做乐观 UI，改为基于服务端回传驱动。

### 3. ExtensionsPane.vue: `installError` 从未被赋值

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:16`
- **描述**: `installError` ref 声明后仅在 `handleInstall` 中清空（第 35 行 `installError.value = ''`），但整个组件没有监听 install 失败的 error 事件来设置错误消息。模板中 `v-if="installError"` 的错误提示永远不会显示实际错误内容。
- **修复方向**: 监听服务端 install 错误响应（error 事件或特定 error type），设置 `installError.value`。

### 4. SlashMenu.vue: tooltip hover 跟踪不完整 — `hoveredIdx` 和 `closeTimer` 为死代码

- **文件**: `src-electron/renderer/src/components/chat/SlashMenu.vue:105-107`
- **描述**: `hoveredIdx` 被声明为 `ref<number | null>(null)`，在 `hoverTipFor` computed 和 `updateTipPos` 中读取（`hoveredIdx.value ?? activeIndex.value`），但**从未被赋值为非 null 值**。`closeTimer` 同理：仅被 `clearTimeout` 和 null 检查，从未被 `setTimeout` 赋值。预期逻辑是：menu item `@mouseleave` 启动 closeTimer 延迟关闭 tooltip → mouse 进入 tooltip 时 clearTimeout 保留 → 但这些 handler 都未实现。当前 tooltip 依赖 `activeIndex`（键盘/鼠标共用的索引）工作，mouse 离开所有 menu item 后 tooltip 会"粘"在最后 hover 的条目上不会消失。
- **修复方向**: 在 menu item 上添加 `@mouseleave` handler 启动 `closeTimer`（~150ms 后清除 `hoveredIdx`），将 `@mouseenter` 改为设置 `hoveredIdx` 而非 `activeIndex`。或者如果当前"tooltip 跟随 activeIndex"行为是有意设计，删除 `hoveredIdx` 和 `closeTimer` 死代码以消除混淆。

---

## LOW

### 5. SlashMenu.vue: tooltip 可能渲染到视口外

- **文件**: `src-electron/renderer/src/components/chat/SlashMenu.vue:147-149`
- **描述**: `updateTipPos()` 通过 `getBoundingClientRect()` 获取 item 位置后，直接用 `transform: translate(-50%, -100%)` 将 tooltip 放在 item 正上方。如果 item 靠近视口顶部（窗口很矮、面板很高），tooltip 会渲染到视口之外，用户看不到。没有边界检测和翻转逻辑。
- **修复方向**: 在 `updateTipPos` 中加入视口边界检测。如果 `rect.top < estimatedTooltipHeight`，改为将 tooltip 放在 item 下方（`top: rect.bottom`）。

### 6. WidgetDock.vue: 硬编码 rgba 颜色值

- **文件**: `src-electron/renderer/src/components/extension/WidgetDock.vue:40`
- **描述**: `hover:bg-[rgba(255,255,255,0.02)]` 是硬编码的颜色值，违反项目编码规范「禁止硬编码颜色 — 用 CSS 变量或语义 Tailwind 类名」。在暗色主题下该颜色可能不可见（白色叠加在深色背景上微弱但可接受），但在亮色主题下完全无效。
- **修复方向**: 使用 CSS 变量 `hover:bg-[var(--hover-bg)]` 或移除该 hover 效果。

### 7. useExtensionWidget.ts: cleanup 只在 refCount===0 时清理 Map，不清理当前 session 的数据

- **文件**: `src-electron/renderer/src/composables/useExtensionWidget.ts:32-33`
- **描述**: `cleanup()` 在 `refCount` 降为 0 时清空全局 `widgets` 和 `statuses` Map。但如果有多个 panel 存在，关闭一个 panel 时 refCount 不为 0（其他 panel 仍在用），该 panel 对应 session 的 widget/status 数据不会被清理，持续占用内存。这是 minor memory leak，在长期运行、频繁创建/销毁 session 的场景下会累积。
- **修复方向**: cleanup 时额外过滤移除属于当前 session 的 entries，或在 PanelSessionView 卸载时仅清理当前 session 的数据，global cleanup 保留给 refCount===0 场景。

---

## INFO

### 8. SlashMenu.vue: `mouseenter` 菜单项直接修改 `activeIndex`，键盘和鼠标状态耦合

- **文件**: `src-electron/renderer/src/components/chat/SlashMenu.vue:18`
- **描述**: 菜单项的 `@mouseenter="activeIndex = idx"` 直接修改 `activeIndex`，这是键盘导航的同一状态。鼠标 hover 会"吃掉"用户的键盘选择位置。虽然当前行为可接受（大多数用户不会同时用键盘和鼠标），但如果后续需要区分键盘高亮和鼠标 hover（如不同的视觉样式），需要拆分状态。
- **修复方向**: 如果需要分离，引入独立的 `hoveredIdx`（当前已有但未使用）。否则标记为已知行为，保持现状。

### 9. ExtensionsPane.vue: install 操作无 loading 遮罩 / 无重复提交防护

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:34-39`
- **描述**: `handleInstall()` 是 `async` 函数但 `send()` 是 fire-and-forget（非 Promise），`installing` 仅控制按钮 disabled 状态。用户在 install 进行中如果切换了 `showInstall` 折叠面板再展开，`installing` 仍为 true 但无法取消。此外没有任何超时保护，如果服务端长时间不响应，UI 会一直卡在 "Installing..."。
- **修复方向**: 考虑添加超时逻辑（如 30s 后自动重置 `installing`），或基于服务端 `config.extensions` 回传驱动状态重置（见 MUST_FIX #2）。

---

## 总结

| 级别 | 数量 | 关键问题 |
|------|------|----------|
| MUST_FIX | 4 | Input 未导入（运行时报错）、installing 状态卡死、installError 死代码、tooltip hover 跟踪不完整 |
| LOW | 3 | tooltip 视口外、硬编码颜色、widget Map 内存泄漏 |
| INFO | 2 | 键盘/鼠标状态耦合、install 无超时保护 |

**最紧急**: MUST_FIX #1（Input 未导入）会直接导致安装扩展功能不可用。MUST_FIX #2-3（install 状态管理缺陷）会导致安装操作后 UI 卡死。
