---
'@zhushanwen/zcode-subagent-cli': minor
---

zcode engine in-flight snapshot support.

Adds the `inFlightSnapshot()` public method to ZcodeEngine (plus connection plumbing) exposing the engine-side in-flight subagent view that feeds the rolling-restart defer-decision input (design D5) and the subagent-workflow in-flight reporting leg. Purely additive.
