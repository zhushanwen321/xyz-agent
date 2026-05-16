# Code Review v1

## Review metadata
- Reviewed at: 2026-05-16 10:30
- Review type: Feature + Bug Fix Code Review
- Review scope: Agent subagent feature + session routing fix
- Commit range: main..HEAD (46 files, +5449/-133)

---

## 1. Spec Compliance — Acceptance Criteria Checklist

| # | Acceptance Criteria | Status | Evidence |
|---|---------------------|--------|----------|
| 1 | `SlashCommandSource` extended to `'builtin' \| 'skill' \| 'agent'` | PASS | `useSlashCommands.ts` L5 |
| 2 | SlashMenu agent tag shows "agent" text | PASS | `SlashMenu.vue` L29: ternary chain outputs "agent" for third source |
| 3 | Only enabled agents shown | PASS | `useSlashCommands.ts` L53: `.filter(a => a.enabled)` |
| 4 | Input prefills `/agent:name ` | PASS | `ChatInput.vue` L189: sets `text.value` |
| 5 | Protocol-layer message triggers subagent | PASS | `useChat.ts` adds `subagent` to payload; `server.ts` L371-378 constructs XML prompt |
| 6 | `register-tool-renderers.ts` registers SubagentRenderer | PASS | L16: `registerToolRenderer('subagent', SubagentRenderer)` |
| 7 | SubagentRenderer header shows agent name + status + duration | PARTIAL | Shows agent name + status, but **no duration display** — spec says "耗时" from `startTime/endTime` |
| 8 | SubagentRenderer body shows task + output | PASS | Lines 13-15: task desc + output area |
| 9 | Error state shows error info | PARTIAL | No dedicated error UI — spec requires "红色边框 + error text" |
| 10 | LLM auto-call uses same renderer | PASS | Renderer is tool-name based, not trigger-based |
| 11 | No enabled agents → no agent category, no error | PASS | Empty array → empty `agentCmds` |

### AC Issues

**SHOULD FIX — AC#7: Missing duration display**
Spec: "Header 显示 agent name + 状态 + 耗时". SubagentRenderer has no `startTime`/`endTime` rendering. The base `ToolCallCard.vue` may handle this externally, but the spec explicitly lists it as a SubagentRenderer field.

**SHOULD FIX — AC#9: No error state rendering**
Spec: "agent 执行错误时 SubagentRenderer 展示错误信息（红色边框 + error text）". Currently no `toolCall.error` or `toolCall.status === 'error'` handling in the template.

---

## 2. Session Routing Fix Analysis (HEAD commit)

### What changed
`session-pool.ts` `restoreSession()`: `const id = crypto.randomUUID()` → `const id = sessionId`

### Correctness assessment

**The fix is correct for the reported problem.** The old code created a new UUID, causing:
1. Frontend pane bound to `oldSessionId`
2. Sidecar active session uses `newSessionId`  
3. All pi events tagged with `newSessionId` → dropped by chat store router

By reusing the original `sessionId`, `oldSessionId === newSessionId` makes `session.restored` a no-op on the frontend side (remove + re-add same ID).

### Side effect analysis

**resolved issue — Potential duplicate process if same sessionId is restored twice**

`ProcessManager.createSession()` checks `this.processes.has(sessionId)` and kills existing before creating new. This handles the normal case. However, in `session-pool.ts` the `sessions` Map (managed sessions) now also uses the same key. If `restoreSession` is called while a session with that ID is already in `this.sessions` (e.g., race condition: two rapid sends to a cold session), the second call would:
1. `scanSessions()` finds the same file → creates session with same ID
2. ProcessManager kills the old process (correct)
3. But `this.sessions.set(id, session)` overwrites with a new ManagedSession that has a fresh `adapter` attached to the new client — the old adapter's `detach()` is never called

The `adapter.detach()` call is missing from `restoreSession` before overwriting. Contrast with `delete()` which explicitly calls `session.adapter.detach()`.

**SHOULD FIX — Comment says "session.restored migration a no-op" but it's still emitted**

`sendMessage()` still emits `session.restored` with `oldSessionId === newSessionId`. The frontend `onSessionRestored` handler will: remove the session, re-add it, switch to it, iterate all panes, migrate chat data. This is wasted work but functionally correct. Consider skipping the emission when IDs match.

---

## 3. Code Quality Issues

### resolved issue — Indentation errors (3 locations)

**Location 1: `session-pool.ts` L465-468** — 2-space indent instead of 4-space
```typescript
  // Reuse original sessionId to avoid frontend-sidecar ID mismatch
  const id = sessionId
  const client = await this.pm.createSession(id, target.cwd, { ... })
  const adapter = new EventAdapter(id, (msg) => this.send(msg))
```
Surrounding code is 4-space indented. These 4 lines are at 2 spaces.

**Location 2: `ChatInput.vue` L19-26** — `:class` attribute misaligned
```html
      :class="[
      'inline-flex items-center gap-1 ...
      activeCommand.source === 'builtin'
```
The class content is at 6-space indent while it should be nested deeper within the `:class` attribute.

**Location 3: `ChatInput.vue` L223-229** — `case 'agent'` block at wrong indent level
```typescript
    case 'agent': {
    const agentName = cmd.action.agentName
```
The `case` and its body are at 4-space indent, but should be at 6 spaces (matching `case 'skill'` at L217 which is at 6 spaces). The closing `}` and `break` are also misaligned.

### SHOULD FIX — Hardcoded colors

Per project rules: "禁止硬编码颜色值，使用 CSS 变量或 Tailwind 语义类名"

- `SlashMenu.vue` L27: `bg-blue-500/10 text-blue-500` — hardcoded blue
- `ChatInput.vue` L25: `bg-blue-500/10 text-blue-500` — hardcoded blue
- `SubagentRenderer.vue` L5: `bg-[oklch(0.65_0.15_250)]` — hardcoded oklch value
- `SubagentRenderer.vue` L6: `text-[oklch(0.55_0.15_250)]` — hardcoded oklch value

The existing skill accent uses `bg-accent-light text-accent`. Agent should use a similar semantic token (e.g., `--agent-accent` or a dedicated Tailwind class), not raw blue/oklch values.

### NOTE — `as unknown as Component` pattern

`register-tool-renderers.ts` uses `as unknown as Component` for all renderers. This is an existing pattern from before this change, not introduced here.

---

## 4. Security Analysis

### SHOULD FIX — XML injection sanitization is incomplete

`server.ts` L375-376:
```typescript
const safeAgent = subagent.agent.replace(/[<>"&]/g, '')
const safeTask = subagent.task.replace(/[<>"&]/g, '')
const agentPrompt = `<tool_call tool="subagent">\n{"agent":"${safeAgent}","task":"${safeTask}"}\n</tool_call />`
```

Issues:
1. **Single quotes not stripped** — `'` could break JSON string boundaries. E.g., `agent: "test'"` produces `{"agent":"test'"}` which is valid JSON, but if the agent name or task contains backslash characters, `\"` escaping could be constructed.
2. **Backslash not stripped** — `task: 'foo\\"}` would produce `{"agent":"...","task":"foo\\"}` which prematurely closes the JSON string.
3. **JSON escaping should use proper serialization** — Instead of regex sanitization, use `JSON.stringify()`:
   ```typescript
   const agentPrompt = `<tool_call tool="subagent">\n{"agent":${JSON.stringify(safeAgent)},"task":${JSON.stringify(safeTask)}}\n</tool_call />`
   ```
   This is the standard defense against injection in JSON contexts.

### NOTE — `<tool_call />` XML tag format

The prompt uses `<tool_call tool="subagent">...</tool_call />` with a self-closing slash on the closing tag. This is non-standard XML — closing tags should be `</tool_call >` without the `/`. Whether this works depends entirely on pi's parser. This isn't a security issue but could be a correctness issue if pi's XML parser is strict.

---

## 5. Findings Summary

| # | Priority | Category | Location | Description | Suggestion |
|---|----------|----------|----------|-------------|------------|
| 1 | **resolved issue** | Indentation | `session-pool.ts` L465-468 | 2-space indent in 4-space method body | Fix to 4-space indent |
| 2 | **resolved issue** | Indentation | `ChatInput.vue` L19-26 | `:class` content misaligned | Realign with parent context |
| 3 | **resolved issue** | Indentation | `ChatInput.vue` L223-229 | `case 'agent'` at wrong indent | Match `case 'skill'` indent level |
| 4 | **resolved issue** | Race condition | `session-pool.ts` restoreSession | Missing `adapter.detach()` on overwrite | Check for existing session and detach before overwrite |
| 5 | **SHOULD FIX** | Spec compliance | `SubagentRenderer.vue` | No duration display (AC#7) | Add startTime/endTime rendering |
| 6 | **SHOULD FIX** | Spec compliance | `SubagentRenderer.vue` | No error state rendering (AC#9) | Add red border + error text for `status === 'error'` |
| 7 | **SHOULD FIX** | Security | `server.ts` L375-377 | XML/JSON injection sanitization incomplete | Use `JSON.stringify()` instead of regex |
| 8 | **SHOULD FIX** | Style rules | `SlashMenu.vue`, `ChatInput.vue`, `SubagentRenderer.vue` | Hardcoded colors (blue-500, oklch values) | Use CSS variables or semantic Tailwind classes |
| 9 | **SHOULD FIX** | Efficiency | `session-pool.ts` sendMessage | `session.restored` emitted even when IDs match | Skip emission when `id === sessionId` |
| 10 | **NOTE** | Correctness | `server.ts` L377 | `<tool_call />` non-standard closing tag | Verify pi parser accepts this format |
| 11 | **NOTE** | Pattern | `register-tool-renderers.ts` | `as unknown as Component` cast | Pre-existing pattern, not introduced here |

---

## Conclusion

**需修改后重审** — 4 条 resolved issue（3 处缩进错误 + 1 处 race condition 遗漏 detach）。核心功能逻辑正确，spec AC 基本覆盖，但 SubagentRenderer 缺少 2 个 spec 要求的 UI 状态。
