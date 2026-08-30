# @zhushanwen/subagent-core

## 0.2.0

### Minor Changes

- 71c283d25: **subagent-core: new dual-form package with finalized public API surface**

  - New package `@zhushanwen/subagent-core` extracted from the subagent-workflow pi extension: the engine-neutral execution layer (EnginePort, pi/zcode engines), workflow orchestration, and workflow script assets live in one authoritative implementation shared by both hosts (pi extension workspace dependency, zsw npm dependency)
  - Public API surface (semver contract): main-entry barrel exporting host port wiring (configureCore/DEFAULT_DATA_ROOT/HostServices, getLogger, NotifyDomainPorts), the engine contract (EnginePort + neutral types, routeEngine), orchestration entries (runWorkflow/abortRun/RunSpec/LifecycleDeps), plus four semantic subentries (`engines/zcode/reader`, `engines/zcode/constants`, `engine/paths`, `relay-env`) and the `workflows/*` asset subentry; the shell-only `./* -> src/*` deep-path wildcard is kept out of the published surface
  - Dual-form packaging: TS source for workspace consumers (export `import` condition -> src), tsup dist (ESM + CJS, multi-entry shape-preserving output with full d.ts/d.cts) for npm consumers via publishConfig; the `require` condition pointing to dist CJS is a first in this repo — the CJS build enforces a defensive noExternal bundle boundary for `@xyz-agent/extension-protocol` (its npm dist is ESM-only while the zsw host requires CJS on node>=20; current entry closures carry no protocol runtime reference, dist verified constant-free)
  - Dependency closure fixed to `@xyz-agent/extension-protocol` + `proper-lockfile` + `ajv` + `yaml`; host services (logging, data root, discovery roots, notify) are injected via ports, keeping the pi SDK out of the closure
  - Package README documents the full API table, both host onboarding examples (pi shell / standalone CJS host, also the landing spot for the `core_host_not_configured` recovery guidance), and the workflow scriptPath anchoring mechanism behind `core_module_load_failed`
