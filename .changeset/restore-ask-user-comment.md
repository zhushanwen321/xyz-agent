---
"@xyz-agent/extension-protocol": patch
"@zhushanwen/pi-ask-user": patch
---

Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash). Re-publish pi-ask-user 4.0.1 as emergency fix.
