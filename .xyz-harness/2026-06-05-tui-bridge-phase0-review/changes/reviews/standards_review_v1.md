---
verdict: pass
must_fix: 0
---

# Standards Review — TUI Bridge Phase 0

## Code Style Consistency

### TypeScript Standards
- All new code uses TypeScript strict mode compatible patterns
- No `any` type used in new code (payload extractions use typed `as` casts)
- Proper use of optional chaining (`?.`) for nullable access
- Interfaces exported for shared types (`AutoRetryState`, `QueueState`)

### Naming Conventions
- Event types follow existing `category.action` pattern (e.g., `message.bashExecution`, `session.renamed`)
- Handler functions use `on<EventName>` pattern consistent with existing handlers
- Store methods use `set<Field>` pattern consistent with existing setters
- Test files follow `<module>-new-<feature>.test.ts` naming convention

### Import Organization
- New imports added at the end of existing import blocks
- Shared types imported from `@xyz-agent/shared` (barrel import)
- Store imports follow existing pattern

### Error Handling
- EventAdapter: individual handler errors caught by outer `handleEvent()` try/catch
- useChat: handlers return early on null sessionId (no error thrown)
- Event-bus: `emit()` catches individual handler errors, continues to next handler
- No silent catches without logging (existing pattern maintained)

## Test Standards

### Test Organization
- New test files created alongside existing tests in same directories
- Test file names clearly indicate what they test
- Tests grouped by FR number in describe blocks

### Test Patterns
- EventAdapter tests: `createAdapter()` + `sent[]` pattern (matches existing)
- Event-bus tests: direct module import, no mocks needed
- useChat tests: vi.mock for stores/ws-client (matches existing pattern)

### Test Coverage
- 53 new tests covering all 11 new handlers + event-bus type safety + ChatStore fields
- Each handler tested with valid input and session isolation (null sessionId)
- ChatStore setter/clear/remove lifecycle tested

## Commit Standards
- 4 implementation commits + 1 preload type fix
- Each commit references the FR or feature in the message
- Commits follow conventional commit format (`feat(scope): description`)
