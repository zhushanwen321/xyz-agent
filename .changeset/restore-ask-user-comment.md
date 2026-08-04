---
"@xyz-agent/extension-protocol": patch
"@zhushanwen/pi-ask-user": patch
---

Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash). Re-publish pi-ask-user 4.0.1 as emergency fix.

Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.
