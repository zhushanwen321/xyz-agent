---
"@xyz-agent/extension-protocol": patch
"@zhushanwen/pi-ask-user": patch
---

Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash).

**Version alignment note**: pi-ask-user is linked with `@zhushanwen/pi-subagent-workflow` and `@zhushanwen/pi-structured-output` in `.changeset/config.json`. The subagent-workflow major changeset (tidy-waves-description-phase-lint, 4.0.0 → 5.0.0) forces the whole linked group to 5.0.0, so pi-ask-user will actually be published as **5.0.0**, not the originally expected 4.0.1 — the original 4.0.1 expectation is absorbed by the linked-group major bump.

Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.
