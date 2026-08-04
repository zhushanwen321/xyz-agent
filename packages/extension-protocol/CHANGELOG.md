# @xyz-agent/extension-protocol

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
