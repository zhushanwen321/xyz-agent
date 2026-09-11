# @zhushanwen/pi-subagent-cli

## 0.1.2

### Patch Changes

- ab07bdb4a: Align test-guard comments with the v2 data-directory layout (comment-only; no runtime behavior change).

## 0.1.1

### Patch Changes

- 838806898: W9 packaging & distribution registration (subagent-engine-protocolization): engine CLI packages are npm-publishable and declared as dependencies of @zhushanwen/pi-subagent-workflow so standalone installs get engines automatically. Electron packaged form bundles both engines to resources/engines/<id>/ (discovered via XYZ_AGENT_ENGINE_ROOTS); zsw vendored form adds engine package directories under lib/vendor/ (owner: z-code-plugin-workspace z-subagent-workflow repo).
