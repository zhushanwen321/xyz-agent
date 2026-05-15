# E2E Test Report — Agent Subagent

## Test Environment

| Item       | Value          |
|------------|----------------|
| Date       | 2026-05-15     |
| Branch     | feat-agent-use |
| Commit     | 4b7c9e2        |
| Runner     | Automated (CI) |
| App status | NOT running    |

## G1: Infrastructure Verification

| TC ID    | Description                        | Result | Evidence                                                                                      |
|----------|------------------------------------|--------|-----------------------------------------------------------------------------------------------|
| TC-1-01  | subagent extension exists          | PASS   | `~/.pi/extensions/subagent/index.ts` exists (34319 bytes)                                     |
| TC-1-02  | agent files discoverable by pi     | PASS   | 22 `.md` files in `~/.pi/agent/agents/`, all with valid YAML frontmatter (`---` delimiter)    |
| TC-1-03  | agent list loads in app            | MANUAL | Requires running Electron app to verify Settings UI loads scanned agents                      |
| TC-1-04  | agent-scanner.ts exists            | PASS   | `src-electron/sidecar/src/agent-scanner.ts` (4367 bytes)                                      |
| TC-1-05  | shared types export AgentInfo      | PASS   | `src-electron/shared/src/index.ts` exports `AgentInfo`, `ScannedAgentInfo`, `ScanSourceType`  |

## G2-G6: UI Interaction Tests

| Group | Description                    | Status | Notes                                         |
|-------|--------------------------------|--------|-----------------------------------------------|
| G2    | SlashMenu agent commands       | MANUAL | Requires running Electron app                 |
| G3    | Manual trigger subagent        | MANUAL | Requires running app + pi API                 |
| G4    | SubagentRenderer rendering     | MANUAL | Requires running app                          |
| G5    | LLM auto-invocation            | MANUAL | Requires pi API key                           |
| G6    | Boundary & error handling      | MANUAL | Requires running app                          |

## Code-Level Verification (Automated)

Each interface in the agent-subagent data flow was verified by grep inspection.

### 1. SubagentRenderer registration

| Check                                      | Result | Evidence                                            |
|--------------------------------------------|--------|-----------------------------------------------------|
| `SubagentRenderer.vue` exists              | PASS   | `src-electron/renderer/src/components/chat/ToolRenderers/SubagentRenderer.vue` |
| Registered in `register-tool-renderers.ts` | PASS   | Line 16: `registerToolRenderer('subagent', SubagentRenderer ...)` |

### 2. Sidecar → pi subagent prompt injection

| Check                              | Result | Evidence                                                                  |
|------------------------------------|--------|---------------------------------------------------------------------------|
| `server.ts` reads `msg.payload.subagent` | PASS | Line 371: `const subagent = msg.payload.subagent as { agent: string; task: string } \| undefined` |
| Constructs `<tool_call tool="subagent">` | PASS | Lines 375-377: builds XML prompt with sanitized agent name and task       |

### 3. Frontend → Sidecar protocol

| Check                                 | Result | Evidence                                                              |
|---------------------------------------|--------|-----------------------------------------------------------------------|
| `useChat.ts` accepts `subagent` param | PASS   | Line 228: `sendMessage(content, subagent?)`, Line 237-238: adds to payload |
| `ChatInput.vue` emits subagent        | PASS   | Line 91: `send` event type includes `subagent?`, Line 227: emits with `{ agent, task }` |
| `PaneSessionView.vue` passes subagent | PASS   | Line 81: `handleSend` destructures `subagent` from payload, Line 93: forwards to `sendMessage` |

### 4. SlashMenu three-way source logic

| Check                                       | Result | Evidence                                                            |
|---------------------------------------------|--------|---------------------------------------------------------------------|
| `SlashMenu.vue` renders 'agent' label       | PASS   | Line 29: ternary chain `builtin → 'command'`, `skill → 'skill'`, else `'agent'` |
| `useSlashCommands.ts` has agent source type  | PASS   | Line 6: `SlashCommandSource = 'builtin' \| 'skill' \| 'agent'`       |
| `useSlashCommands.ts` builds agent commands  | PASS   | Lines 55-64: maps `AgentInfo[]` to `SlashCommand[]` with `source: 'agent'` |

### 5. Agent scanning & discovery

| Check                                | Result | Evidence                                                                    |
|--------------------------------------|--------|-----------------------------------------------------------------------------|
| `agent-scanner.ts` exports `scanAgents` | PASS | Line 83: `export function scanAgents(sources, existingAgentIds)`            |
| `server.ts` imports agent scanner       | PASS | Line 9: `import { scanAgents } from './agent-scanner.js'`                   |
| `server.ts` handles `scanAgents` message | PASS | Line 235: responds to scan request with scanned agents                      |
| `server.ts` handles agent CRUD          | PASS | Lines 240-243: add/update agent, save to `agents.json`                      |
| `config-store.ts` has `loadAgents`/`saveAgents` | PASS | Lines 194-214: load/save agents from `~/.xyz-agent/agents.json` |

### 6. Subagent extension capabilities

| Check                                    | Result | Evidence                                                    |
|------------------------------------------|--------|-------------------------------------------------------------|
| Three modes: single/parallel/chain       | PASS   | Extension validates `agent+task`, `tasks[]`, or `chain[]`   |
| Agent discovery via `discoverAgents()`   | PASS   | Imports from `./agents.js`, resolves user/project scope     |
| Streaming updates via `onUpdate`         | PASS   | `emitUpdate()` / `emitParallelUpdate()` callbacks           |
| Concurrency limiting                     | PASS   | `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`                 |
| TUI rendering: renderCall + renderResult | PASS   | Both methods implemented with collapsed/expanded views      |

## Regression Test Results

| Suite    | Files | Tests | Pass | Fail | Duration |
|----------|-------|-------|------|------|----------|
| Renderer | 10    | 73    | 73   | 0    | 980ms    |
| Sidecar  | 5     | 36    | 36   | 0    | 2.29s    |
| **Total** | **15** | **109** | **109** | **0** | —        |

## Manual Test Checklist

### G2: SlashMenu agent commands

1. Start the app (`npm run dev`)
2. Open a chat panel
3. Type `/` in ChatInput
4. **Verify**: SlashMenu shows a third category "agent" alongside "command" and "skill"
5. **Verify**: Agent items appear with `agent:<name>` prefix
6. Select an agent command (e.g., `/agent:general-purpose`)
7. **Verify**: ChatInput shows a task input prompt (not immediately sends)
8. Type a task and submit
9. **Verify**: Message is sent with `subagent` payload in WebSocket message

### G3: Manual trigger subagent

1. In a running chat session, type `/agent:general-purpose`
2. Enter a task description (e.g., "List the files in the current directory")
3. Submit
4. **Verify**: Sidecar logs show `[sidecar] subagent prompt:` with the constructed XML
5. **Verify**: pi process receives the subagent tool call
6. **Verify**: Subagent tool spawns a child pi process
7. **Verify**: Result streams back to the UI

### G4: SubagentRenderer rendering

1. Trigger a subagent invocation (see G3)
2. **Verify**: Tool call shows "subagent" label with agent name and task preview
3. **Verify**: During execution, streaming status updates are visible
4. **Verify**: On completion, result shows success/failure icon, output text, and usage stats
5. Press `Ctrl+O` to expand
6. **Verify**: Expanded view shows full tool call history and markdown output

### G5: LLM auto-invocation

1. Send a message like "Please use the general-purpose agent to analyze this code"
2. **Verify**: LLM recognizes the request and invokes the `subagent` tool
3. **Verify**: The tool call and result render correctly via SubagentRenderer

### G6: Boundary & error handling

1. **Unknown agent**: Send `/agent:nonexistent-agent` with any task
   - Verify: Error message "Unknown agent" shown, no crash
2. **Empty task**: Select an agent command but submit with empty task
   - Verify: Validation prevents submission or shows error
3. **Agent process failure**: Trigger an agent that will fail (bad model, network error)
   - Verify: Error state renders with error icon and message
   - Verify: `isGenerating` resets, UI does not freeze
4. **Parallel limit**: If possible, trigger >8 parallel tasks
   - Verify: Error message about max limit
5. **Project agent security**: Set `agentScope: "both"`, trigger a project-local agent
   - Verify: Confirmation dialog appears before execution

## Verdict

- **Automated checks**: 18/18 PASS (G1 infrastructure + code-level verification)
- **Regression tests**: 109/109 PASS (0 failures)
- **Manual tests**: Deferred to human QA (G2-G6 require running Electron app)
