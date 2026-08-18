# xyz-agent-plugin-sdk

## 0.3.16

### ⚠️ Breaking Changes

- **`Phase1AgentAPI.events` downgraded from `@stable` to `@experimental`**: The plugin-to-plugin event bus (`api.events.on` / `api.events.emit`) was never implemented — no production producers existed for `plugin.event.*` notifications. Calling these methods now throws `NOT_IMPLEMENTED` at runtime. Plugins relying on the events API surface should migrate to specific APIs: use `api.sessions.onDidCreateSession` / `api.sessions.onDidDestroySession` for session lifecycle events.

## 0.3.15
