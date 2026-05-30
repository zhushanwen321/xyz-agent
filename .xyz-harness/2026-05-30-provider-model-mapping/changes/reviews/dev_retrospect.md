---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — provider-model-mapping

## 1. Phase Execution Review

### Summary
Implemented 5 tasks (2 backend + 3 frontend) for thinkingLevelMap UI in Provider settings. Used subagent parallel execution for Wave 1 (BG1) and Wave 2 (FG1). Five-step specialized review caught 4 MUST_FIX issues that were fixed in a second commit.

### Problems Encountered
- **BLR MUST_FIX-1 (Critical)**: ConfigService.setProvider was doing a full-replace on models, dropping `reasoning`, `api`, `input` etc. This was a pre-existing bug but our feature made it user-visible. Fixed with `{ ...base, id }` merge strategy preserving all existing model fields.
- **Robustness M1**: ThinkingLevelConfig watch re-initialized levels on every emit, causing Input focus loss. Fixed with `selfEmitting` flag.
- **Robustness M2**: `expandedModels` Set persisted across Modal open/close cycles. Fixed by resetting in the watch handler.
- **Robustness M3**: `thinkingLevelMap` lacked runtime type validation in ConfigService. Fixed with `isValidThinkingLevelMap` type guard.

### What Would You Do Differently
- Should have caught the ConfigService full-replace bug during plan review — it's the most critical integration point and the plan's Task 2 only added thinkingLevelMap without considering the existing field-preservation issue.
- The selfEmitting flag pattern for watch loop prevention is a common Vue pattern — could have included it in the initial implementation.

### Key Risks for Later Phases
- **Merge-backward compatibility**: The `{ ...base }` merge means if models.json has fields unknown to ProviderModal, they're preserved silently. This is correct behavior but worth noting.
- **Pre-existing TS2345**: InputToolbar.vue type errors remain unresolved. Not blocking but should be tracked.

## 2. Harness Usability Review

### Flow Friction
Five-step specialized review worked well — 4 parallel reviews caught distinct categories of issues. The BLR reviewer's UC simulation approach was particularly effective, tracing the full data path from UI click to models.json write.

### Gate Quality
Reviews were accurate and specific. BLR's MUST_FIX-1 was a genuinely critical issue that would have made the feature unusable. Robustness M1 (Input focus loss) was a real UX bug.

### Prompt Clarity
Subagent task prompts for coding were clear and produced correct code on first attempt. Review subagents benefited from having spec + plan context.

### Automation Gaps
- Two-round review dispatch (v1 → fix → v2) is manual. Could be automated: dispatch fix subagent on MUST_FIX, re-dispatch review automatically.
- BLR reviewer traced data through ConfigService → pi-config-bridge but couldn't read pi-config-bridge.ts. Providing the full call chain to BLR reviewer would improve accuracy.

### Time Sinks
The most valuable time was spent on the ConfigService merge fix — understanding the pre-existing full-replace bug and designing the correct merge strategy. The `{ ...base, id }` approach is simple but required careful consideration of the "all-on preset = undefined = delete key" semantics.
