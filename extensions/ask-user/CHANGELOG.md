# @zhushanwen/pi-ask-user

## 7.0.7

### Patch Changes

- 1565e57fa: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-workflow@7.3.2 → @zhushanwen/pi-subagent-workflow@7.3.3)

## 7.0.6

### Patch Changes

- 2f38dbd86: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-workflow@7.3.1 → @zhushanwen/pi-subagent-workflow@7.3.2)

## 7.0.5

### Patch Changes

- 291d9645a: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-workflow@7.3.0 → @zhushanwen/pi-subagent-workflow@7.3.1)

## 7.0.4

### Patch Changes

- 4f6e24f45: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-workflow@7.2.0 → @zhushanwen/pi-subagent-workflow@7.3.0)

## 7.0.3

### Patch Changes

- bc336c3b5: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-workflow@7.1.0 → @zhushanwen/pi-subagent-workflow@7.2.0)

## 7.0.2

### Patch Changes

- a0d700161: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-workflow@7.0.1 → @zhushanwen/pi-subagent-workflow@7.1.0)

## 7.0.1

### Major Changes

- 1c0ae0624: Remove the comment feature and adopt the structured `AnswerValue` model across the protocol, extension, and renderer.

  Breaking changes in this version:

  - `allowComment` option removed — the inline comment interaction is deleted end-to-end (paired with the `@xyz-agent/extension-protocol@0.4.0` removal).
  - Options no longer carry a separate `value` field; the selected label is the value (D1 model merge).
  - `getAskUserComment` helper removed; answers decode via `getAskUserAnswer` / `getAskUserOther` only.

### Patch Changes

- 76a0f8d45: Align no-option freeform encoding with the shared `encodeAnswer` contract.

## 6.0.1

### Patch Changes

- 1acbdd2ff: chore: refresh dependency range (triggered by @zhushanwen/pi-subagent-workflow@6.0.0 → @zhushanwen/pi-subagent-workflow@7.0.0)

## 6.0.0

### Patch Changes

- Updated dependencies [7e6cddc]
  - @zhushanwen/pi-subagent-workflow@6.0.0

## 5.0.2

### Patch Changes

- Updated dependencies [4231ad1]
  - @zhushanwen/pi-subagent-workflow@5.0.2

## 5.0.1

### Patch Changes

- Updated dependencies [b5c36a2]
  - @zhushanwen/pi-subagent-workflow@5.0.1

## 5.0.0

### Patch Changes

- 6e2e453: Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash).

  **Version alignment note**: pi-ask-user is linked with `@zhushanwen/pi-subagent-workflow` and `@zhushanwen/pi-structured-output` in `.changeset/config.json`. The subagent-workflow major changeset (tidy-waves-description-phase-lint, 4.0.0 → 5.0.0) forces the whole linked group to 5.0.0, so pi-ask-user will actually be published as **5.0.0**, not the originally expected 4.0.1 — the original 4.0.1 expectation is absorbed by the linked-group major bump.

  Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.

- Updated dependencies [531cd86]
- Updated dependencies [6e2e453]
- Updated dependencies [ab166bf]
  - @zhushanwen/pi-subagent-workflow@5.0.0
  - @xyz-agent/extension-protocol@0.3.1

## 5.0.0-dev.1

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-subagent-workflow@5.0.0-dev.1

## 5.0.0-dev.0

### Patch Changes

- 6e2e453: Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash).

  **Version alignment note**: pi-ask-user is linked with `@zhushanwen/pi-subagent-workflow` and `@zhushanwen/pi-structured-output` in `.changeset/config.json`. The subagent-workflow major changeset (tidy-waves-description-phase-lint, 4.0.0 → 5.0.0) forces the whole linked group to 5.0.0, so pi-ask-user will actually be published as **5.0.0**, not the originally expected 4.0.1 — the original 4.0.1 expectation is absorbed by the linked-group major bump.

  Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.

- Updated dependencies [6e2e453]
- Updated dependencies [ab166bf]
  - @xyz-agent/extension-protocol@0.3.1-dev.0
  - @zhushanwen/pi-subagent-workflow@5.0.0-dev.0

## 3.0.0

### Patch Changes

- Updated dependencies [e33b3a6]
- Updated dependencies [07ee286]
  - @zhushanwen/pi-subagent-workflow@3.0.0

## 2.0.1

### Patch Changes

- deafa7f: Fix silent schema-bypass in workflow mode: structured-output now validates data against the authoritative schema from PI_WORKFLOW_SCHEMA env instead of the LLM-supplied schema parameter. Workflow-mode prompts updated to guide LLM to pass only data.

  Workflow-mode structured-output prompt sync (subagent-workflow): the system-prompt instruction written by `resolveAgentOpts` for the `agent({schema})` override and the `formatSchemaInstruction` helper now instruct the LLM to pass ONLY the `data` parameter and do NOT pass a `schema` parameter, because the schema is enforced by the system.

- Updated dependencies [deafa7f]
  - @zhushanwen/pi-subagent-workflow@2.0.1

## 2.0.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

### Patch Changes

- Updated dependencies [83e97ab]
  - @zhushanwen/pi-subagent-workflow@2.0.0

## 1.0.5

### Patch Changes

- Updated dependencies [486746a]
  - @zhushanwen/pi-subagent-workflow@0.4.3

## 1.0.4

### Patch Changes

- Updated dependencies [83da227]
  - @zhushanwen/pi-subagent-workflow@0.4.2

## 1.0.3

### Patch Changes

- 9169119: Migrate all Pi SDK references from the deprecated `@mariozechner/pi-*` namespace to the active `@earendil-works/pi-*` namespace. This eliminates the five deprecation warnings emitted during `pnpm install` (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, transitive `@mariozechner/pi-agent-core`, and transitive `node-domexception`).

  **Changes:**

  - **package.json**: all `peerDependencies` / `peerDependenciesMeta` referencing `@mariozechner/pi-*` updated to `@earendil-works/pi-*` (versions unchanged: `*`)
  - **TypeScript sources**: all `import ... from "@mariozechner/pi-*"` updated to `import ... from "@earendil-works/pi-*"` across 98 files (438 import occurrences including `declare module` and dynamic `import()` types)
  - **`tsconfig.json` paths**: removed `@mariozechner/pi-*` dual-alias entries; kept only `@earendil-works/pi-*`
  - **`vitest.config.ts` aliases**: removed `@mariozechner/pi-*` entries; updated stub path targets to `./shared/types/earendil-works/index`
  - **`shared/types/mariozechner/` → `shared/types/earendil-works/`**: stub directory renamed, `declare module` names updated, `shared/types/package.json` `main` and `files` fields updated
  - **Monorepo cross-package references**: `extensions/ask-user` (`@zhushanwen/pi-subagent-workflow`) and `extensions/subagent-workflow` (`@zhushanwen/pi-structured-output`) switched from `*` to `workspace:*` so local development uses the just-edited sources instead of pulling deprecated versions from npm
  - **`pnpm.allowedDeprecatedVersions.node-domexception = "1.0.0"`**: silences the remaining unavoidable transitive deprecation (`@earendil-works/pi-ai` → `@google/genai` → `google-auth-library` → `gaxios@7` → `node-fetch@3` → `node-domexception`); `node-domexception` is a Node 22+ redundant polyfill, not a functional issue

  **No functional changes** to extension behavior, types, or APIs. `pnpm install`, `pnpm -r typecheck`, and `pnpm -r test` all pass cleanly with zero deprecation warnings.

  **Follow-up hardening (no functional impact):**

  - **`.githooks/validate-no-mariozechner-pi`** (new): standalone grep-based scanner that errors when `@mariozechner/pi-` appears in staged files or in workspace path checks. Can also be called manually for ad-hoc audits (`bash .githooks/validate-no-mariozechner-pi [<files>]`).
  - **`.githooks/pre-commit`** (`-0.` namespace check): wired `validate-no-mariozechner-pi` as a pre-manifest gate. Any staged file in `extensions/` or `shared/` (including `package.json`, `vitest.config.ts`, `.d.ts`) containing the deprecated namespace blocks the commit. `SKIP_NAMESPACE_CHECK=1` hotfix bypass must be justified in the PR description and tracked with an issue.
  - **`.githooks/pre-commit`** (`0b` peerDep check): the package.json deep check now requires `@earendil-works/pi-coding-agent` and explicitly rejects `@mariozechner/pi-coding-agent` (was incorrectly accepting the deprecated name as the success signal).
  - **AGENTS.md** new section "禁止使用已废弃的 Pi SDK namespace [MANDATORY]": documents the namespace rule, the gate script location, and what to do if Pi renames the namespace again.
  - **docs/standards.md / docs/monorepo-conventions.md / docs/quality-gates.md**: updated example `package.json`, import snippets, and `peerDependencies` descriptions to use `@earendil-works/pi-*`. Old historical docs (`docs/evolution/`, `docs/third-party-extensions/`, `docs/research/`) retain the deprecated references as factual record of past investigations.
  - **Bonus fix**: `pre-commit` had a latent bash bug `${#TEST_PKGS[@]:-}` (not a valid parameter expansion). Fixed to `${#TEST_PKGS[@]}` while validating the new gate.

- Updated dependencies [9169119]
  - @zhushanwen/pi-subagent-workflow@0.4.1

## 1.0.2

### Patch Changes

- Updated dependencies [b5f53fd]
- Updated dependencies [a090b61]
  - @zhushanwen/pi-subagent-workflow@0.4.0

## 1.0.1

### Patch Changes

- bb86ee9: Harden 5 tool descriptions + runtime validation against weak-model first-call parameter misuse.

  Triggered by a real session where a flash-tier model (step-3.7-flash) called the `subagent` tool with `task`/`slug` flattened to the top level (missing the `startParam` envelope) and needed a round-trip to self-correct. Root cause analysis found a systemic debt pattern across 5 tools: conditional-required fields expressed as `Type.Optional`, zero JSON call examples in descriptions, no parameter-structure anti-patterns, dry runtime error messages with no Correct example, and no prompt-quality regression tests.

  Three-layer fix applied uniformly to all 5 tools (subagent + workflow + goal_control + todo + ask-user + structured-output):

  - **Runtime friendly correction**: required-field throws now append a copy-pasteable `Correct: {full JSON}` example; common-misuse detectors catch the highest-frequency errors and return a corrected shape (subagent `startParam` flattening; workflow `args` sub-field flattening — a P0 silent failure; todo `text`/`texts` + `id`/`ids` dual-shape trap; ask-user string `options` array).
  - **Description examples + structural anti-patterns**: each tool now ships complete JSON call examples for every high-risk action and a Don't section listing parameter-structure mistakes.
  - **Prompt-quality regression tests**: new source-text assertion test per tool locks the examples / anti-patterns / Correct-usage strings so they cannot silently regress.

  Notable silent-failure closures (worse than the original throw-based failure because they did not error at all):

  - **structured-output**: `schema`/`data` swap detection + keyword-less schema rejection. Previously `Type.Unknown()` + `ajv strict:false` compiled a keyword-less object (e.g. `{}`, `{a:1}`) into an accept-anything validator — swapping schema and data then passed validation and stored garbage silently. Now detected and rejected with a Correct hint.
  - **workflow**: flattened `args` sub-fields (task/items/...) previously fell through to `args = params.args ?? {}`, silently launching a run missing its parameters.

  Other changes:

  - **subagent + workflow**: `slug` `maxLength` relaxed 20 → 35 (single source `SLUG_MAX_LENGTH`; both schemas now reference the constant). Descriptive kebab-case slugs like `fix-subagent-wf-tools` (21) no longer collide; over-limit error now suggests a shorter label.
  - **ask-user**: `InputSchema.options` element intentionally loosened to `OptionSchema | string` so a mistyped string-array `options` reaches `validateInput` (friendly Correct error) instead of being killed by the schema layer's raw ajv error before `execute` runs. Internal `Question`/`Option` types stay strict.
  - **structured-output**: extracted `executeStructuredOutput()` for direct unit testing (internal test helper — not re-exported from the package root, so not part of the public API); deleted stale `STRUCTURED_OUTPUT_SCHEMA` env-name + tool_call block tests (0.3.0 changed to unconditional registration, real env name is `PI_WORKFLOW_SCHEMA`).

  Review follow-up (addressed in the same PR after a 6-dimension multi-agent code review):

  - **structured-output**: `SCHEMA_KEYWORDS` completed with the remaining draft-07 validation keywords (`if`/`then`/`else`/`dependencies`/`propertyNames`/`contains`/`$defs`/`definitions`) so a conditional root schema is no longer wrongly rejected as keyword-less; `executeStructuredOutput` return type widened from `Record<string,unknown>` to `unknown` (data may be a primitive/array per its own tests); `getOrCompileValidator` now accepts `object | boolean` (boolean root schemas are valid draft-07), eliminating an unsafe cast; `tool_execution_end` handler uses a runtime type guard instead of a bare cast; `echo()` now tolerates `undefined` (`JSON.stringify(undefined)` returns undefined and previously crashed `.length` — a latent bug surfaced by the new edge-case tests).
  - **subagent-workflow + todo**: detectors (`hasFlattenedStartFields`, workflow `findFlattenedArgKeys`, todo `handleAdd`/`handleDelete`) now exported to enable behavioural trigger/no-trigger tests — the P0 workflow flatten detector previously had only a fragile source-text lock. Added slug boundary tests (35/36) and a workflow-side runtime slug guard matching subagent's.
  - goal_control `hasGoalDetails` guard tightened to validate the `details` value is an object (not just that the key exists).

  All five packages are bumped `patch`: no breaking API changes, no new public exports forming a supported API contract (the exported detectors are test helpers, not a stable surface), and the ask-user schema loosening + structured-output keyword-less rejection only surface clearer errors for inputs that were already malformed (previously silently corrupted or raw-ajv-rejected). This is defensive hardening + prompt-quality work, conservatively versioned as patch.

- Updated dependencies [bb86ee9]
  - @zhushanwen/pi-subagent-workflow@0.3.1

## 1.0.0

### Patch Changes

- 988497d: Wire ask-user into the subagent-workflow channel registry so subagent children can route `ask_user` requests back to the parent UI.

  - New `channel-handler.ts`: `createAskUserChannelHandler(ctx)` registers ask-user as a channel consumer. Mode split — RPC forwards via `askUserInteract`; TUI renders `AskUserComponent`. Returns `{value: JSON.stringify(answers)}` matching the child decode contract.
  - New `channel-registry-access.ts`: cross-extension stable public API for the channel registry (no cross-package import; shares the registry via `globalThis[Symbol.for(...)]`, load-order independent).
  - `package.json`: optional peerDep on `@zhushanwen/pi-subagent-workflow` (degrades gracefully when subagent-workflow is absent).
  - `extension-dependencies.json`: ask-user optional dep on pi-subagent-workflow.

  End-to-end verified: subagent child → host TUI `AskUserComponent` → user answers → child receives answer.

- Updated dependencies [4fe4906]
- Updated dependencies [bd68203]
  - @zhushanwen/pi-subagent-workflow@0.3.0

## 0.2.0

### Minor Changes

- de5d7a3: Add RPC mode support via @xyz-agent/extension-protocol: ask_user now works in xyz-agent GUI through askUserInteract (select channel + ASK_USER_MARKER), while preserving TUI ctx.ui.custom behavior.

## 0.1.0

### Minor Changes

- 986ec30: Fix arrow key leak in ask-user editor (chars like `[C` leaking into input text). Refactor key parsing to whitelist architecture using SDK parseKey, migrate editorText to QuestionState.draftText, split handleInput router, add UX hint line.

## 0.0.4

### Patch Changes

- 7b4d775: Fix Other option marker misalignment (single-select freeform, multi-select non-freeform, freeText preview indent) and strip bracketed-paste escape sequences (`\x1b[200~` / `\x1b[201~`) that leaked into the Other/comment editor text.

## 0.0.3

### Patch Changes

- 1684bde: Companion changes shipped alongside the subagents spawn/fork rework:

  - `pi-ask-user`: fix paste truncation for emoji / astral-plane surrogate pairs and "Others" option alignment; add component paste regression tests.
  - `pi-taste-lint`: new rule additions supporting the subagents refactor.
  - `pi-types`: extend the `mariozechner` SDK type stubs with the new APIs consumed by the spawn execution model.

## 0.0.2

### Patch Changes

- 803414f: Fix multi-question navigation key conflict, narrow Other editor, and Other freeform number prefix.

  - Rebind tab navigation off shift+tab (conflicts with Pi global `app.thinking.cycle`). Navigation keys are now consistent across all tabs: Left/Right always move between tabs (Right enters Submit from the last question; Left backs with no wrap at the first; on the Submit tab Left goes to the last question, Right wraps to the first). Tab toggles Submit/Cancel focus on the Submit tab. No shift+tab dependency anywhere.
  - Other freeform/comment editor renders at full width instead of the split-pane left column (~42%), fixing premature wrapping. Split-pane is bypassed in editor modes since the right-side preview is useless while typing a custom answer.
  - Other row shows its number prefix in freeform mode (`> [ ] N. <input>`), matching regular options.
