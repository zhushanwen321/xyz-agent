---
verdict: pass
---

# Use Cases — bundle-pi-extensions

纯技术性需求，无业务用例。spec.md 已标注"无业务用例"。

以下用例为技术验证场景，对应 spec AC：

### UC-1: LLM 调用 goal_manager 工具
- **Actor**: LLM (pi 进程)
- **Preconditions**: xyz-agent dev mode running, session created, bundled goal extension loaded
- **Main Flow**:
  1. User sends "/goal" slash command
  2. pi extension registers `/goal` command handler
  3. LLM receives goal_manager tool context prompt
  4. LLM calls `goal_manager` with `action: "create_tasks"`
  5. Extension executes, returns task list + render descriptor
  6. xyz-agent frontend RenderDescriptor.vue renders task list
- **Postconditions**: Task list visible in chat, task data persisted in session file
- **Module Boundaries**: pi extension (tool execution) → RPC response → event adapter → Vue renderer

### UC-2: Logger writes to isolated directory
- **Actor**: subagent extension (runs inside pi process)
- **Preconditions**: PI_CODING_AGENT_DIR env var set to `~/.xyz-agent/pi/agent/`, shared/logger.ts reads it
- **Main Flow**:
  1. LLM calls `subagent` tool
  2. Subagent extension imports createLogger from shared/logger
  3. Logger resolves LOG_DIR from PI_CODING_AGENT_DIR
  4. Logger writes to `~/.xyz-agent/pi/agent/logs/subagent-YYYY-MM-DD.log`
- **Postconditions**: Log file exists in xyz-agent directory, NOT in `~/.pi/agent/logs/`
- **Module Boundaries**: pi extension → shared/logger.ts → filesystem

### UC-3: AC Coverage Mapping

| UC | AC |
|----|----|
| UC-1 | AC-1, AC-2 |
| UC-2 | AC-3 |
| (production build) | AC-4 |
| (git tracking) | AC-5 |
