---
"@zhushanwen/pi-goal": patch
---

Fix goal continuation loop while background subagents/workflows are running.

`agent_end` unconditionally queued a `followUp` continuation even when
background subagents/workflows were still active. The queued message drove
`_handlePostAgentRun`'s `hasQueuedMessages()` loop, so the main agent spun
(continuation -> new turn -> agent_end -> continuation) on top of the
subagent completion notifications.

Add a pending guard in `handleContinuation`: read the pending
register/unregister entry diff from session entries (deliberately NOT
checking `expiresAt` — long-running subagents over the 1h TTL still
`triggerTurn` on completion, so treating them as inactive would reintroduce
the loop). When active pending > 0, emit a `goal:log` diagnostic and skip
the followUp; rely on the subagent/workflow completion
`sendMessage({triggerTurn:true})` to resume the main agent.

Also remove the redundant `pendingHint` from `before_agent_start` context
injection: it was a second, possibly-inconsistent source next to the
`pending_notifications` tool (mandatory) and the tool-call history. Goal no
longer summarizes pending state for the LLM.
