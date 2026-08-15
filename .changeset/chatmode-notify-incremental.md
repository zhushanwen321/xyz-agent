---
"@zhushanwen/pi-subagent-workflow": minor
---

Incremental round notifications and transcript pointer for chatMode subagents:

- **Round notifications now carry per-round increments instead of the full transcript.** Previously each round notification resent all previous rounds' text (`record.result` derived from the full turn history), making total notification volume grow quadratically with the number of rounds (O(N²)). Each notification now contains only the current round's reply text. If a round produced no non-empty increment (pure tool round, interrupted round, empty model reply), the notification falls back to `"(no output this round)"` (or a `round did not complete: <error>` line for failed rounds).
- **Notifications now end with a `Full transcript: <sessionFile>` pointer line** (blank-line separated). chatMode round/close notifications transparently pass the subagent's session file path so the parent LLM can read the full transcript on demand — this is the recovery channel if a round's increment is lost in an async flush window. The pointer line is omitted when the session file is not (yet) known, and is not appended to `cancelled` / failed notifications.
- **one-shot subagent notifications are byte-for-byte unchanged** — the session file is only passed through for conversation-mode (`chatMode`) records.
- Consumer-visible impact: the `/subagents` detail Result section shows shorter text per round (incremental semantics; the detail view already directs readers to the session file for full history). The TUI notification card is unaffected by the pointer line — `bg-notify-render` renders from `message.details` fields (title line for round notifications, first line of `result` for completed ones) and never reads `message.content`, so the pointer line is visible to the LLM only.
