---
"@zhushanwen/pi-ask-user": patch
"@zhushanwen/pi-scheduler": patch
"@zhushanwen/pi-pending-notifications": patch
"@zhushanwen/pi-permission": patch
"@zhushanwen/pi-unified-hooks": patch
"@zhushanwen/pi-goal": patch
"@zhushanwen/pi-model-switch": patch
---

Align extension behavior with installed pi 0.84.1 semantics (pi-assumption remediation)

- Tool/command errors are now thrown instead of returned with `isError: true` — pi only honors thrown errors; `isError` in return values is discarded by agent-loop (ask-user, scheduler)
- ask-user: guard undefined custom-dialog result in json/print mode (noOpUIContext returns undefined); drop ineffective `isError` field from execute result type
- model-switch: actually switches by calling `ctx.api.setModel` — previous path silently no-op'd; pi clamps unsupported thinking levels silently, effective level returned in reply
- pending-notifications: correct stale-listener rationale — pi tracks event-bus subscriptions and auto-unsubscribes on invalidate/session replace
- permission / unified-hooks: correct ctx.ui theme/undefined assumptions per pi 0.84.1 type authority
- goal: remove stale-context pattern matching no longer reachable under pi 0.84.1 lifecycle
