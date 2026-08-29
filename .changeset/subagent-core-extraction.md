---
'@zhushanwen/subagent-core': minor
---

**subagent-core: new dual-form package scaffold**

- New package `@zhushanwen/subagent-core` extracted from the subagent-workflow pi extension: the engine-neutral execution layer (EnginePort, pi/zcode engines), workflow orchestration, and workflow script assets will live in one authoritative implementation shared by both hosts (pi extension workspace dependency, zsw npm dependency)
- Dual-form packaging: TS source for workspace consumers, tsup dist (ESM + CJS) for npm consumers; the CJS bundle includes `@xyz-agent/extension-protocol` because its npm dist is ESM-only while the zsw host requires CJS on node>=20
- Dependency closure fixed to `@xyz-agent/extension-protocol` + `proper-lockfile` + `ajv` + `yaml`; host services (logging, data root, discovery roots, notify) are injected via ports, keeping the pi SDK out of the closure
- Code migration lands in the follow-up unit; this changeset tracks the package scaffold (README, barrel placeholder, build/test configs)
