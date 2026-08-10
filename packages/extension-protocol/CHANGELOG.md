# @xyz-agent/extension-protocol

## 0.4.0

### Minor Changes

- Remove the ask-user comment feature end-to-end and drop `AskUserOption.value`.

  Breaking changes in this version:

  - `AskUserQuestion.allowComment` field removed — the comment interaction is deleted from all three consumers (protocol, pi-ask-user extension, renderer `AskUserOverlay`) in one atomic delivery. This is the corrective counterpart of 6e2e453 (which restored the field after a one-sided 0.3.0 deletion broke the contract); this time the extension and renderer are changed in the same wave, so no consumer is left depending on the removed API.
  - `AskUserOption.value` removed — proto options no longer carry a separate return value; the selected label is the value (D1 model merge).
  - `getAskUserComment` helper removed — the `${key}__comment` protocol key no longer exists. Answers are decoded with `getAskUserAnswer` / `getAskUserOther` only.

  Per semver convention for 0.x packages, this breaking change ships as a minor bump (0.3.1 → 0.4.0).

## 0.3.1

### Patch Changes

- 6e2e453: Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash).

  **Version alignment note**: pi-ask-user is linked with `@zhushanwen/pi-subagent-workflow` and `@zhushanwen/pi-structured-output` in `.changeset/config.json`. The subagent-workflow major changeset (tidy-waves-description-phase-lint, 4.0.0 → 5.0.0) forces the whole linked group to 5.0.0, so pi-ask-user will actually be published as **5.0.0**, not the originally expected 4.0.1 — the original 4.0.1 expectation is absorbed by the linked-group major bump.

  Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.

## 0.3.1-dev.0

### Patch Changes

- 6e2e453: Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash).

  **Version alignment note**: pi-ask-user is linked with `@zhushanwen/pi-subagent-workflow` and `@zhushanwen/pi-structured-output` in `.changeset/config.json`. The subagent-workflow major changeset (tidy-waves-description-phase-lint, 4.0.0 → 5.0.0) forces the whole linked group to 5.0.0, so pi-ask-user will actually be published as **5.0.0**, not the originally expected 4.0.1 — the original 4.0.1 expectation is absorbed by the linked-group major bump.

  Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.

## 0.3.0

### Minor Changes

- 74a0b10: Two changes ship in this PR:

  1. Remove the ask-user comment feature end-to-end:

     - `@xyz-agent/extension-protocol`: remove `getAskUserComment` helper and
       `allowComment` field from the ask-user protocol (breaking — package is
       still 0.x, so a `minor` bump denotes a breaking change per semver).
     - `@zhushanwen/pi-ask-user`: remove the public tool-schema field
       `allowComment`, the `ANSWER_COMMENT_SEPARATOR` split, the comment
       interaction mode, and `getAskUserComment` usage (breaking — public API
       removal, `major` bump).

  2. Add `thinkingLevel` support to subagent-workflow's `agent()`:
     - `@zhushanwen/pi-subagent-workflow`: `agent()` now accepts an optional
       `thinkingLevel` option (off|minimal|low|medium|high|xhigh) propagated
       through to the pi CLI spawn args (additive feature, `minor` bump).

  `@zhushanwen/pi-structured-output` is in the same changeset `linked` group as
  the two `@zhushanwen/pi-*` packages and has no code changes; `changeset
version` will reconcile it to the group's highest bump automatically.

## 0.2.0

### Minor Changes

- Initial npm release of the extension GUI rendering protocol package.
  Includes types and helper functions for pi extension dual-mode (TUI/GUI) rendering.

## 0.1.1-dev.0

### Patch Changes

- Prerelease build for testing.
