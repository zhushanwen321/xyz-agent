# TDD RED Report

## Date: 2026-05-15

## Test Files

| Task | Test File | Result |
|------|-----------|--------|
| T1 | `src-electron/renderer/src/composables/__tests__/useSlashCommands.test.ts` | 4 failed / 3 passed |
| T2 | `src-electron/renderer/src/composables/__tests__/useChat-subagent.test.ts` | 2 failed / 3 passed |
| T3 | `src-electron/sidecar/test/server-subagent.test.ts` | 4 failed / 2 passed |
| T4 | `src-electron/renderer/src/components/chat/ToolRenderers/__tests__/SubagentRenderer.test.ts` | 0 tests (import fail, component not found) |

## RED Verification

### T1: useSlashCommands — agent command support
- PASS: should return only builtin commands when no skills or agents provided
- PASS: should merge skill commands with builtin commands
- PASS: should only include enabled skills
- **FAIL**: should include agent commands when agents are provided — `mergeSkillCommands` only accepts `skills` parameter
- **FAIL**: should only include enabled agents — same signature issue
- **FAIL**: should use agent source type and agent name in action — `SlashCommandSource` doesn't include `'agent'`
- **FAIL**: should sort all commands from all three sources alphabetically — agents not included in merge

### T2: useChat — sendMessage subagent parameter
- PASS: should send message without subagent field (backward compat)
- PASS: should handle undefined subagent gracefully
- PASS: should handle null subagent gracefully
- **FAIL**: should include subagent field in WS payload — `sendMessage` doesn't accept 3rd parameter
- **FAIL**: should pass correct agent name and task — same issue

### T3: sidecar server — subagent XML prompt
- PASS: should send raw content when subagent field is absent
- PASS: should handle normal messages without modification
- **FAIL**: should send XML structured prompt when subagent field present — `sendMessage` called with raw content, not XML
- **FAIL**: should sanitize special characters — no sanitization logic
- **FAIL**: should handle empty task string — no subagent handling
- **FAIL**: should log the constructed XML prompt — no `[sidecar] subagent prompt:` log

### T4: SubagentRenderer — Vue component
- **FAIL (import)**: Component `SubagentRenderer.vue` does not exist yet
- All 7 test cases unable to run

## Test Framework

- vitest installed in `src-electron/` (sidecar tests)
- vitest + @vue/test-utils installed in `src-electron/renderer/` (frontend tests)

## Commits

| Commit | Message |
|--------|---------|
| `b5ffa1f` | test: add failing tests for T3 sidecar subagent prompt construction |
| `09c695d` | test(T1): add failing tests for agent slash command support |
| `fb7bbf1` | test(t4): add failing tests for SubagentRenderer component |
| `c1958d7` | test(T2): add failing tests for sendMessage subagent parameter |

## Conclusion

All 4 test files are in RED state. 10 tests fail due to missing implementation, 8 tests pass (backward compat). Ready for GREEN phase.
