# Code Review v1

## Review Context
- Review time: 2026-05-15
- Review type: Clean-slate final code review
- Review scope: All changes on `feat-agent-use` branch vs `main`
- Commits: 12 commits (T1-T4 tests + implementation + fixes)
- Files changed: 17 files (+862/-20 lines)

## Spec Compliance Matrix

| AC | Description | Status | Notes |
|----|-------------|--------|-------|
| `SlashCommandSource` 扩展 | `'builtin' \| 'skill' \| 'agent'` | PASS | `useSlashCommands.ts` line 4 |
| SlashMenu source 标签 "agent" | 区分三种来源文字 | PASS | `SlashMenu.vue` line 29, `ChatInput.vue` line 23-25 |
| 仅展示 enabled agent | `filter(a => a.enabled)` | PASS | `useSlashCommands.ts` line 55 |
| 选择 agent 后预填 `/agent:name ` | 输入框预填 | PASS | `ChatInput.vue` line 188-193 |
| Protocol 层触发 subagent | `message.send` + `subagent` field | PASS | `useChat.ts`, `server.ts` |
| 注册 SubagentRenderer | `registerToolRenderer('subagent', ...)` | PASS | `register-tool-renderers.ts` line 16 |
| SubagentRenderer Header | agent name + 状态 + 耗时 | PARTIAL | agent name in body header; status/elapsed in ToolCallCard outer header |
| SubagentRenderer Body | task 描述 + 输出文本 | PASS | Lines 11-17 of SubagentRenderer.vue |
| 错误展示 | 红色边框 + error text | PARTIAL | Red border from ToolCallCard; no explicit error text display |
| LLM 自动调用渲染 | 使用 SubagentRenderer | PASS | Registry lookup by toolName='subagent' works for any trigger |
| 无 enabled agent 时不展示 | 空数组不生成命令 | PASS | `(agents ?? []).filter(...)` returns empty, no agent section |

## Data Flow Verification

```
SlashMenu → ChatInput.handleSlashSelect() → activeCommand set
  → user types task → handleSend()
  → emit('send', { content, subagent: { agent, task } })
  → PaneSessionView.handleSend() → sendMessage(content, subagent)
  → useChat.sendMessage() → WS message.send with subagent payload
  → sidecar server.ts → XML prompt construction → pool.sendMessage()
  → pi RPC prompt() → LLM processes → tool_call subagent
  → EventAdapter tool_execution_start/end → ToolCallCard → SubagentRenderer
```

All links verified. The chain is complete and connected.

## Discovered Issues

| # | Priority | Dimension | File | Description | Fix Suggestion |
|---|----------|-----------|------|-------------|----------------|
| 1 | **MUST FIX** | Functional bug | `ChatInput.vue` L215 | **Task sent to subagent includes `/agent:name` prefix**. `content = trimmed` includes the full input text `/agent:code-reviewer my task`. This becomes `subagent.task`, which is sent to pi as the task description containing the command prefix. | Strip the `/agent:` prefix from task: `const taskContent = trimmed.replace(/^\/agent:\S+\s*/, '').trim()` and use `taskContent` for both `content` (display) and `task` (subagent payload). |
| 2 | **MUST FIX** | Indentation | `ChatInput.vue` L21-25 | **Indentation regression**: ternary expression indented at 6/8 spaces, but enclosing `:class=[` array is at 10-space indent. Original was at 12/14 spaces. Code works but breaks visual consistency with surrounding lines. | Restore to 12/14-space indent matching the `:class=[` level. Same pattern used correctly in `SlashMenu.vue`. |
| 3 | **MUST FIX** | Indentation | `SubagentRenderer.vue` | **Multiple indentation issues**: (a) Template children (lines 3-18) at indent=2 same as root `<div>`, should be indent=4. (b) `try/catch` body (lines 32-35) has no additional indentation inside `try {`. | Re-indent: template children of root `<div>` at 4 spaces; `try` body at 4 spaces inside the `try {`. |
| 4 | **MUST FIX** | Tests | `useSlashCommands.test.ts` | **6 uses of `as any`** on `AgentInfo` objects. Project rules forbid `any`. Root cause: test-local `AgentInfo` interface is incomplete (missing `modelStrategy` required field from shared type). | Import `AgentInfo` from `@xyz-agent/shared` and provide `modelStrategy` in `makeAgent()`. |
| 5 | **SHOULD FIX** | Malformed XML | `server.ts` L376 | Closing tag `</tool_call />` mixes closing-tag and self-closing syntax. This is invalid XML. While not parsed by an XML parser (it's sent as text prompt), it looks sloppy and may confuse some LLMs. | Use `</tool_call >` or `</tool_call` instead. |
| 6 | **SHOULD FIX** | Missing error display | `SubagentRenderer.vue` | Spec AC requires "红色边框 + error text". ToolCallCard provides red border, but SubagentRenderer shows no explicit error message. When `toolCall.status === 'error'`, the output area shows `toolCall.output` but there's no distinct error styling within SubagentRenderer. | Add conditional error display: when `status === 'error'`, show `toolCall.output` with `text-danger` styling and a distinct error indicator. |
| 7 | **SHOULD FIX** | Spec alignment | `SubagentRenderer.vue` | Spec says "Header 显示 agent name + 状态 + 耗时". Agent name is in SubagentRenderer's own header row (inside ToolCallCard body), not in ToolCallCard's header. ToolCallCard header shows "subagent" as generic tool name. This means user must expand the card to see which agent was called. | Consider passing agent name up to ToolCallCard header via a `filePathHint`-like mechanism, or document this as accepted deviation. |
| 8 | **SHOULD FIX** | Sanitization | `server.ts` L373-374 | XML injection sanitization only strips `<>"&` but the sanitized values are injected into a JSON string inside XML. `safeTask` could contain newlines or other characters that break the JSON structure (e.g., `"task":"line1\nline2"` — newlines in JSON strings must be escaped). | Use `JSON.stringify()` for safeTask/safeAgent to produce properly escaped JSON, then embed in the XML template. |
| 9 | **SHOULD FIX** | Test config | `vitest.config.ts` (renderer) | SubagentRenderer tests fail when run from project root (`npx vitest run` at root) because the renderer-specific vitest config is not found. Tests only pass when run from `src-electron/renderer/` directory. | Either add a root-level vitest config that references the renderer config via `projects`, or document the required test run directory. |
| 10 | **NOTE** | Hardcoded color | `ChatInput.vue` L25, `SlashMenu.vue` L28, `SubagentRenderer.vue` L4-5 | Agent items use hardcoded `bg-blue-500/10 text-blue-500` and `oklch(...)` colors instead of CSS variables or design tokens. | Consider using design system CSS variables for consistency with the rest of the UI. Acceptable for first implementation. |
| 11 | **NOTE** | Architecture | `server.ts` L376 | The XML prompt approach (`<tool_call tool="subagent">`) sends structured text as a user message to pi, relying on the LLM interpreting it as a tool call instruction. This is essentially the "强格式指令" backup approach from the spec. It works but is less reliable than native function calling. | Accepted per spec's decision record. May need refinement if LLM compliance is unreliable. |
| 12 | **NOTE** | Untracked file | `docs/designs/views_agent-subagent.html` | The UI demo HTML file is untracked (not in git commits). | Consider adding to git or adding to `.gitignore` if not needed in the repo. |

## Code Quality Assessment

### TypeScript Safety
- All implementation code is properly typed. No `any` in production code.
- `ToolCall.input` is typed as `unknown` in shared; SubagentRenderer correctly handles both `string` and `object` cases.
- `server.ts` uses `as string` / `as { ... } | undefined` for WS payload destructuring — consistent with existing patterns.

### Vue Best Practices
- Proper use of `computed()` for reactive derived state.
- `defineProps<T>()` with typed generics.
- `v-html` is not used anywhere — XSS-safe via `{{ }}` interpolation.
- Component registration follows the existing `registerToolRenderer` pattern.

### Error Handling
- SubagentRenderer gracefully degrades on invalid JSON input (shows 'unknown').
- `useChat.sendMessage` correctly handles undefined subagent (backward compat).
- Sidecar sanitizes `<>"&` from agent name/task.

### Backward Compatibility
- `mergeSkillCommands(skills)` still works with single argument (agents defaults to undefined).
- `sendMessage(content)` still works without subagent.
- No breaking changes to existing WS protocol — subagent field is additive.

## Test Coverage Summary

| Test File | Tests | Status |
|-----------|-------|--------|
| `useSlashCommands.test.ts` | 7 | PASS |
| `useChat-subagent.test.ts` | 5 | PASS |
| `server-subagent.test.ts` | 6 | PASS |
| `SubagentRenderer.test.ts` | 9 | PASS (from renderer dir only) |

Total: 27 tests passing. Coverage is good for the new functionality.

## Conclusion

**需修改后重审** — 4 条 MUST FIX。

Critical issues: (1) subagent task contains command prefix, (2-3) indentation regressions, (4) test `as any` violations. All are straightforward fixes.

## Summary

Code review v1 完成，4 条 MUST FIX，5 条 SHOULD FIX，3 条 NOTE。核心数据流完整且正确，TypeScript 类型安全，测试覆盖充分。主要问题集中在 task 内容包含命令前缀（功能 bug）和代码格式（缩进回退）。
