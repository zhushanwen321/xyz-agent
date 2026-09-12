# @zhushanwen/zcode-subagent-cli

## 0.2.0

### Minor Changes

- 4955dad6e: zcode engine in-flight snapshot support.

  Adds the `inFlightSnapshot()` public method to ZcodeEngine (plus connection plumbing) exposing the engine-side in-flight subagent view that feeds the rolling-restart defer-decision input (design D5) and the subagent-workflow in-flight reporting leg. Purely additive.

## 0.1.2

### Patch Changes

- ab07bdb4a: Align test-guard comments with the v2 data-directory layout (comment-only; no runtime behavior change).

## 0.1.1

### Patch Changes

- 838806898: W9 packaging & distribution registration (subagent-engine-protocolization): engine CLI packages are npm-publishable and declared as dependencies of @zhushanwen/pi-subagent-workflow so standalone installs get engines automatically. Electron packaged form bundles both engines to resources/engines/<id>/ (discovered via XYZ_AGENT_ENGINE_ROOTS); zsw vendored form adds engine package directories under lib/vendor/ (owner: z-code-plugin-workspace z-subagent-workflow repo).
