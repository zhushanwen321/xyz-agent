---
"@zhushanwen/pi-todo": minor
"@zhushanwen/pi-goal": minor
---

Move widget rendering from tool-result payloads to widget-panel pushes (`guiSetWidget`)

The `details.__gui__` field is no longer attached to `todo` / `goal_control` tool results in RPC mode. GUI state is now pushed through the extension-protocol `guiSetWidget` channel (marker-encoded `GuiRenderResult` over the native `setWidget` transport), which hosts decode and render as a dedicated widget panel in the conversation flow. Tool results carry plain text in every mode, so state display no longer duplicates into each tool result.

Widget payloads were restructured to the v1.1 meta-head architecture (`WidgetMeta`): the host shell renders a single head row (title, status dot, progress count "N/M", mini progress bar) while the body is a numbered list-tree whose item status is expressed solely by a trailing dot — per-row icons and ids burned into labels are gone. Goal widgets map `GoalStatus` onto the same head semantics (active = running, complete = done, blocked/budget_limited/cancelled = failed, paused = idle). The goal `UiPort` interface gains `setGuiWidget` and an `isGui` flag so the projection layer picks the GUI or TUI rendering path.

Impact for consumers: code reading `details.__gui__` from these tool results must switch to the widget channel; `@xyz-agent/extension-protocol` 0.4.0 keeps `extractGui` as a legacy read path with v1/v1.1 dual-format support during the transition. TUI/CLI behaviour is unchanged — when the host is not GUI-capable, native text widgets and status lines are used exactly as before.
