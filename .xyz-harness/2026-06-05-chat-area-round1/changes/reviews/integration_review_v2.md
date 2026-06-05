---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 4
  issues_found: 0
  must_fix_count: 0
  low_count: 0
  info_count: 0
  duration_estimate: "15"
---

# Integration Review v2 — MUST_FIX 验证

**上游:** integration_review_v1.md (verdict: fail, 3 MUST_FIX)
**目的:** 仅验证 v1 提出的 3 个 MUST_FIX 是否已正确修复

## 验证结果

### M#1 ✅ Toast 反馈断裂 — 已修复

**文件:** `src-electron/renderer/src/App.vue`

在 `onMounted` 中新增 `'toast:show'` event-bus 监听器：
- `onEventBus('toast:show', (payload) => { ... })` → 注册 `toastUnregister`
- `crypto.randomUUID()` 生成唯一 id
- `toasts.value.push({ id, type, title, description })` 注入 Toast 数组
- `setTimeout(() => dismissToast(id), TOAST_DURATION_MS)` 自动消失
- `onUnmounted` 中 `toastUnregister?.()` 正确清理

与现有 `extension.ui_timed_out` 处理模式一致。兼容性问题（缺少 `id` 字段）已在监听器中通过 `crypto.randomUUID()` 解决。

### M#2 ✅ 批量选择跨 session 污染 — 已修复

**文件:** `src-electron/renderer/src/components/panel/ChatPanel.vue`

新增 `watch(() => props.sessionId, () => { batchMode.value = false; selectedIds.value = new Set() })`：
- `batchMode` 重置为 `false`，checkbox UI 立即隐藏
- `selectedIds` 替换为空 Set，旧 session 的 message ID 被清除
- 位于 batch 相关逻辑区域，与 `exitBatchMode()` 逻辑一致

### M#3 ✅ Markdown 源码丢失 — 已修复

**文件:** `src-electron/renderer/src/components/chat/MessageBubble.vue` + `src-electron/renderer/src/lib/collectMessageContent.ts`

**MessageBubble.vue:** 所有 `.msg__body` 元素（assistant contentBlocks 路径、assistant fallback 路径、user 消息路径）均已添加 `:data-markdown-source="message.content"` 属性。

**collectMessageContent.ts:** markdown 格式下优先读取 `body.getAttribute('data-markdown-source')`，仅在无该属性时 fallback 到 `body.textContent`。plain 格式仍使用 `textContent`。

## 回归扫描

快速检查 4 个文件未发现回归：
- App.vue：现有事件监听（`extension.ui_timed_out`, `error`）和 IPC 处理未变
- ChatPanel.vue：batch toggle、scroll watch、agent switch 逻辑未受影响
- MessageBubble.vue：渲染管线（renderLightweight/renderFull）、action menu、branch indicator 未变
- collectMessageContent.ts：thinking/tool card 收集逻辑未变，仅新增 markdown source 分支

## 结论

**verdict: pass** — v1 的 3 个 MUST_FIX 全部正确修复，实现方式与 v1 建议方案一致（M#1 事件监听 + id 生成、M#2 watch 重置、M#3 data 属性 + 优先读取）。无回归。
