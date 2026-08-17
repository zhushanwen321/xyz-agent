---
"@zhushanwen/pi-subagent-workflow": minor
---

Redesign built-in agents into 9 orthogonal roles; stop tool-call deltas from polluting streamed text

The built-in agent set is redesigned around nine orthogonal roles: `coder`, `debugger` and `reviewer` are added while `worker`, `code-reviewer`, `context-builder` and `oracle` are removed, and the prompts for `planner`, `orchestrator`, `explorer`, `researcher`, `general-purpose` and `doc-reviewer` are rewritten — clearer when/notFor semantic routing, explicit data-vs-instruction injection guards, and reviewer-type roles stay read-only. The fallback agent for calls without an explicit agent name remains `general-purpose` (the old `worker` fallback no longer exists).

Streaming is also fixed: `message_update` events now go through a dedicated `mapAssistantMessageDelta` helper that only forwards `text_delta` / `thinking_delta`. Previously tool-call argument deltas (raw JSON fragments such as `{"path":"..."}`) leaked into the streamed assistant text and interleaved with it; tool calls are now displayed only via the fetched history cards, never via the streaming channel.

Data-directory resolution (`resolveSessionDir`, skill discovery) migrated from hardcoded `~/.pi/agent` to pi's `getAgentDir()`, so `PI_CODING_AGENT_DIR` overrides are respected.

Impact for consumers: prompts or workflows referencing the removed agents by name (`worker`, `code-reviewer`, `context-builder`, `oracle`) must be updated to the new roles; streamed subagent output no longer contains JSON tool-argument fragments.
