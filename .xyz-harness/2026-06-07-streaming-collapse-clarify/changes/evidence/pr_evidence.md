---
pr_created: true
pr_url: https://github.com/zhushanwen321/xyz-agent/pull/71
pr_title: "feat: pi extension installation with npm/local/git support"
branch: feat-pi-extension-install
---

# PR Evidence

PR #71 已存在且 OPEN，streaming-collapse-clarify 改动已包含在最新 push 中。

## 改动范围

- `src-electron/renderer/src/components/chat/CompactSummaryBar.vue` — 操作行渲染升级为 ToolCallCard/ThinkingBlock + chip/item overflow
- `src-electron/renderer/src/components/chat/CompactStreamingBubble.vue` — streaming 结束自动收回
- `src-electron/renderer/src/lib/compact-utils.ts` — 共享 formatTime/toolPath 工具函数（新增）
- 附带修复了分支中预存的 typecheck/test 失败

## Spec 参考

- Spec: `.xyz-harness/2026-06-07-streaming-collapse/spec.md`
- Plan: `.xyz-harness/2026-06-07-streaming-collapse-clarify/plan.md`
