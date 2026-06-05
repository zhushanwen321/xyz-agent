---
verdict: pass
must_fix: 0
---

# Gate Review #1 — Phase 0 Spec: TUI Bridge (EventAdapter + 基础设施加固)

**Deliverable**: `.xyz-harness/2026-06-05-tui-bridge-phase0-review/spec.md`
**Reviewer**: Gate (anti-fraud)
**Date**: 2026-06-05
**Methodology**: `~/.pi/agent/skills/xyz-harness-gate-reviewer/SKILL.md`

## 0. Methodology Note

The task brief referenced a 'Phase 1 — Spec' section in `SKILL.md`, but the file (18 lines total) only contains `Gate Reviewer Skill` / `Review Criteria` / `Instructions`. No 'Phase 1' section exists. This review therefore applies the three explicit Review Criteria from the actual file:

1. Review file has YAML frontmatter with `verdict` and `must_fix` (top-level)
2. Review covers spec completeness, codebase alignment, and risk assessment
3. Gate passes iff `verdict=pass` and `must_fix=0`

## 1. Spec Completeness

| Dimension | Finding |
|---|---|
| Title + scope statement | ✅ "Phase 0：TUI Bridge — EventAdapter 前置修改 + 基础设施加固" with explicit out-of-scope (no GUI changes — Phase 1-2) |
| Background / motivation | ✅ Quantified 75% EventAdapter coverage; three gap categories (P0 method miss, P1 field loss, P1 event drop) |
| Functional Requirements | ✅ FR-1 … FR-9 (9 items), each with concrete change location and payload schema |
| Acceptance Criteria | ✅ AC-1.1 … AC-5.3 (22 items), all input→output verifiable |
| Constraints | ✅ C-1 … C-5 (no pi source, handler signature stable, backward compat, session isolation, no GUI) |
| Complexity assessment | ✅ Code (~450 LoC) / test (~380 LoC) / file (~8) / risk / rollback estimates |
| Date | ✅ 2026-06-05 |

No `[待决议]` / TBD / "TBA" markers. No section is empty or stubbed. **No fraud signal of placeholder content.**

## 2. Codebase Alignment (anti-fraud core check)

I verified the spec's claims against the live code on disk. All checked claims hold:

### 2.1 `src-electron/runtime/src/event-adapter.ts`

| Spec claim | Code location | Verified |
|---|---|---|
| FR-1: only `confirm/select/input/notify` matched in `extension_ui_request` | lines 274-330 (case 'extension_ui_request') | ✅ `editor` / `set_editor_text` / `setTitle` not matched |
| FR-1: `extension_error` reads `event.extensionName` | line 388 `extensionName: event.extensionName ?? ''` | ✅ field-name bug is real |
| FR-2: `message_start` only checks `customType`, not `role` | (no role branch in message_start handler) | ✅ |
| FR-3: `auto_retry_start/end` discarded | lines 405-406 (explicit `return null`) | ✅ |
| FR-3: `queue_update` / `session_info_changed` / `thinking_level_changed` not handled | (no cases — fall to default warn at line 416) | ✅ |
| FR-4: `tool_execution_end` only extracts text content | (no image branch) | ✅ |
| FR-4: `tool_execution_update` treats `partialResult` as string | line 396 `detail: event.partialResult as string \| undefined` | ✅ |
| FR-5: `message_update` `type==='error'` falls to default warn | default branch line 416 | ✅ |

### 2.2 `src-electron/shared/src/protocol.ts`

| Spec claim | Verified |
|---|---|
| `ExtensionUIRequestPayload.method` = `'confirm' \| 'select' \| 'input' \| 'notify'` (line 192) | ✅ no `'editor'` |
| `ServerMessageType` lacks `'extension:setEditorText'`, `'message.bashExecution'`, `'message.compactionSummary'`, `'message.branchSummary'`, `'message.auto_retry_start'`, `'message.auto_retry_end'`, `'message.queue_update'`, `'message.stream_error'`, `'extension:setTitle'` | ✅ none of the 9 are present (lines 156-169) |
| `ServerMessageType` already contains `'session.renamed'` and `'session.thinkingLevelSet'` | ✅ lines 158, 169 — FR-3 reuse claim valid |
| `ExtensionErrorPayload` lacks `errorEvent` | ✅ line 209-213 has only `sessionId/extensionName/error` |

### 2.3 `src-electron/renderer/src/lib/event-bus.ts`

| Spec claim | Verified |
|---|---|
| `on(event: string, handler)` / `emit(event: string, ...args: any[])` | ✅ lines 6, 17 — untyped, no ServerMessageType constraint |

### 2.4 `src-electron/renderer/src/composables/useChat.ts`

| Spec claim | Verified |
|---|---|
| `createGlobalHandlers()` exists, contains `onMessageStart` (13 handlers currently) | ✅ line 23, line 153, line 218 |
| No `onSetEditorText` / `onAutoRetryStart` / etc. handlers | ✅ confirmed absent — FR-8 is genuine gap |

### 2.5 `src-electron/renderer/src/stores/chat.ts`

| Spec claim | Verified |
|---|---|
| `ChatSessionState` lacks `pendingEditorText`, `autoRetryState`, `queueState`, `thinkingLevel`, `responseModel` | ✅ lines 37-53 only contain the existing fields |
| `createSessionState()` factory has no new fields | ✅ lines 62-79 |

### 2.6 Test file references (AC-5)

| AC claim | Verified |
|---|---|
| `event-adapter-bridge.test.ts`, `event-adapter-extension.test.ts` exist | ✅ `src-electron/runtime/test/` |
| `useChat.test.ts`, `useChat-subagent.test.ts`, `useChat-subagent-boundary.test.ts` exist | ✅ `src-electron/renderer/src/composables/` (+ `__tests__/`) |

**Codebase alignment is 100% accurate.** Every concrete claim in the spec maps to a real, currently-true state of the repo. No fabricated gaps; no false positives.

## 3. Risk Assessment

| Risk | Spec assessment | Reviewer agreement |
|---|---|---|
| EventAdapter regression | 🟡 Medium | ✅ Agree — 15-case `default warn` and 6 forwarders. AC-5.1 mandates all existing tests pass. |
| event-bus type migration | 🟢 Low | ✅ Agree — handler signatures are already `(msg: ServerMessage) => void`; type-only change. C-2 constraint enforces no handler body change. |
| ChatStore field addition | 🟢 Low | ✅ Agree — all fields optional, no serialization impact. C-3 enforces backward compat. |
| Session isolation (AC-3.4) | 🟡 Medium | ✅ Agree — every new handler must check `payload.sessionId`; test coverage must be explicit. |
| Rollback | 🟢 Low | ✅ Agree — purely additive (new case branches, new optional fields, new handlers); per-change `git revert` viable. |
| `window.electronAPI` for `onExtensionSetTitle` (renderer-only) | not in spec risk table | ⚠️ Minor — already flagged in prior v1 review (Obs-3 in `spec_review_v1.md`). Should be addressed at implementation, not blocking the spec. |

No risk is under-stated. No risk is hidden.

## 4. Fraud-Signal Scan

| Signal | Check | Result |
|---|---|---|
| Placeholder / TBD content | grep for `TODO\|TBD\|TBA\|待决议\|XXX\|FIXME` in spec | None found in functional content |
| Self-contradiction | FR + AC cross-check (e.g. AC-1.1 expects `prefill` field, FR-1 promises it) | Consistent |
| Phantom dependencies | Spec references `ServerMessageType`, `ExtensionUIRequestPayload`, `ExtensionErrorPayload`, `ChatSessionState`, `event-bus`, `useChat`, `EventAdapter` | All exist at the stated paths |
| Inflated complexity | ~450 LoC + ~380 LoC test estimate | Plausible for 9 FRs across 5 files (matches implementation-plan.md section 二) |
| Plagiarism / unattributed reuse | spec is a condensed re-statement of `docs/research/tui-to-gui-implementation-plan.md` §二 | Acknowledged as a derived planning artifact; not a fraud signal, but worth noting that the source-of-truth doc exists in `docs/research/`. The spec is the implementation contract, the plan is the rationale. |
| Date integrity | `Date: 2026-06-05` matches the harness directory name `2026-06-05-tui-bridge-phase0-review` and prior v1 review timestamp (Jun 5 14:25) | ✅ |
| Cross-deliverable consistency | spec aligns with ADR-0015 (event-bus typing decision = "方案 B"), implementation-plan §二, and supplemental-audit recommendations | ✅ all three planning artifacts tell the same story |
| Ghost AC items | every AC references a real event/payload field | ✅ |

**No fraud signals detected.** The deliverable is genuine, internally consistent, and externally corroborated by both the live code and three sibling planning documents.

## 5. Methodology Compliance of THIS Review

- [x] YAML frontmatter at top level with `verdict` and `must_fix` (integer)
- [x] Covers spec completeness (§1)
- [x] Covers codebase alignment (§2 — 13 code-anchored verifications)
- [x] Covers risk assessment (§3)
- [x] Applies anti-fraud lens (§4 — explicit fraud-signal scan table)

## 6. Verdict

**PASS** — `must_fix: 0`

The spec is a faithful, accurate, and verifiable description of the Phase 0 work. Every concrete claim about the current codebase was independently re-verified against the live code on disk. The spec is consistent with the implementation plan, the supplemental audit, and ADR-0015. No fraud signals detected.
