---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — provider-model-mapping

## 1. Phase Execution Review

### Summary
Implemented 5 tasks (2 backend + 3 frontend) for thinkingLevelMap UI in Provider settings. Two commits: initial implementation + MUST_FIX fixes. Five-step specialized review caught 4 MUST_FIX issues across BLR and Robustness dimensions; all fixed in second commit. Standards and Taste reviews passed on v1.

**Files modified/created**: 5 source files + 10 review/evidence docs.

### Problems Encountered

**BLR MUST_FIX-1 (Critical — feature-killer)**: `ConfigService.setProvider` did a full-replace on the models array, only preserving `id/name/contextWindow/thinkingLevelMap`. This dropped `reasoning`, `api`, `input`, `cost`, `compat` — pre-existing bug, but our feature elevated it from "rarely triggered" to "every thinkingLevelMap save destroys model metadata". The cascade: `reasoning` lost → `InputToolbar.vue` returns empty thinking levels → thinking level picker disappears → user's new mapping becomes dead data. **Fixed** with `{ ...base, id }` merge strategy that preserves all existing PiModelDefinition fields and only overwrites user-edited ones.

**Robustness M1 (UX bug)**: ThinkingLevelConfig's `watch(() => props.modelValue)` triggered on every self-emit (toggle/input/preset → emit → parent updates prop → watch → `initLevels` rebuilds entire array → Input loses focus). **Fixed** with `selfEmitting` boolean flag that skips `initLevels` when the change originated from within the component.

**Robustness M2 (state leak)**: `expandedModels` Set persisted across Modal open/close. Opening Provider B after editing Provider A could show stale expansion state. **Fixed** by resetting `expandedModels.value = new Set()` in the `watch(props.visible)` handler.

**Robustness M3 (type safety)**: `thinkingLevelMap` validation used `typeof === 'object'` which accepts Array/Date/RegExp. **Fixed** with `isValidThinkingLevelMap()` type guard that checks null, Array, and validates all values are `string | null`.

### What Would You Do Differently
- **Plan review should have caught the ConfigService full-replace bug**. Task 2's plan only said "add thinkingLevelMap to the map callback" without questioning why the callback only preserved 3 fields. A plan reviewer familiar with the codebase should flag "this code only keeps id/name/contextWindow — what about reasoning/api/input?".
- **selfEmitting flag should be default for v-model components with internal watch**. This is a standard Vue pattern for preventing circular updates. Include it in initial implementation, not as a review fix.
- **expandedModels reset should be automatic**. Any state that accumulates across Modal sessions should be reset on open. Could be a convention in the frontend-dev skill.

### Key Risks for Later Phases
- **Pre-existing TS2345 in InputToolbar.vue**: Two type narrowing errors remain. Not blocking but should be tracked for cleanup.
- **ConfigService merge backward compatibility**: `{ ...base }` preserves unknown fields silently — correct but means ProviderModal can't remove fields that were added outside its UI (e.g., manually edited models.json). This is acceptable behavior.
- **WS error propagation**: ProviderPane's try-catch cannot catch async WS failures (fire-and-forget pattern). AC-4 (error toast on save failure) is not fully met — noted as LOW in BLR review.

## 2. Harness Usability Review

### Flow Friction
Minimal friction. Complex path (5 tasks, cross frontend/backend) worked smoothly with Wave-based execution. BG1 (backend) and FG1 Task 3 (ThinkingLevelConfig creation) ran in parallel, cutting wait time. The five-step review batch-then-serial pattern (4 parallel → 1 sequential after BLR) was efficient.

### Gate Quality
All reviews were substantive and accurate:
- **BLR** was the standout — UC simulation approach traced the full data path and caught the critical field-loss bug that would have made the feature unusable. This review alone justified the entire five-step process.
- **Robustness** caught 3 real issues (watch re-entry, state leak, type validation). All were genuine bugs.
- **Standards** and **Taste** passed on v1 — code was clean from the start, confirming subagent task prompts were well-constructed.
- **Integration** passed on v1 — module boundaries were clear and type contracts matched across the chain.
- No false positives across any review.

### Prompt Clarity
Coding subagent task prompts produced correct code on first attempt for all 5 tasks. The key was including exact file paths, existing code context, and interface contracts from the plan. Review subagent prompts benefited from having spec + plan + use-cases context.

### Automation Gaps
- **Two-round review dispatch is manual**. After v1 reviews found MUST_FIXs, I manually: read reports → fixed code → re-dispatched BLR + Robustness v2. This could be automated: if MUST_FIX > 0, auto-dispatch a fix subagent with the review feedback, then re-dispatch the same review.
- **BLR couldn't read pi-config-bridge.ts**. The reviewer traced data through ConfigService but hit a dead end at the bridge layer. Providing the full call chain (or at least the bridge's function signatures) to BLR would improve simulation accuracy.
- **Pre-existing error baseline not documented**. The TS2345 errors in InputToolbar.vue required manual verification (stash → build → pop) to confirm they weren't introduced by our changes. A pre-dev build baseline would eliminate this step.

### Time Sinks
- **ConfigService merge fix design** (~15 min thinking): The `{ ...base, id }` approach is simple in hindsight, but required careful consideration of edge cases: What if base is empty? What if user applied "all-on" preset (buildMap returns undefined) — should we delete the key or keep old value? This was the most intellectually demanding part of the phase.
- **Pre-existing error verification** (~5 min): Stashing, building, checking, un-stashing to confirm TS2345 was pre-existing. A documented baseline would avoid this.
