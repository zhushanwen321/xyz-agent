---
'@zhushanwen/pi-goal': minor
---

Simplify goal internals and normalize extension events to pi SDK types.

- Event payloads are now typed with pi SDK event types instead of local look-alike interfaces.
- Write-only persisted goal fields are dropped from the on-disk record; projection and UI ports were slimmed accordingly (`UiPort.theme` declared explicitly, `SessionPort` reduced to actual usage).
- The internal barrel/shared/budget-dimension helpers were removed; behavior of the goal tools is unchanged.
