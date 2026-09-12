---
'@xyz-agent/extension-protocol': minor
---

Subagent in-flight report protocol module.

Adds the `src/extensions/subagent-inflight/` protocol module (~195 lines): `SUBAGENT_INFLIGHT_MARKER` marker constant, `isInFlightReportAck` frame predicate, `SubagentInFlightReport` / ack payload types, and encode/decode helpers for the in-flight subagent reporting channel consumed by `@zhushanwen/pi-subagent-workflow` (host/inflight-reporter). Purely additive — no existing exports change.
