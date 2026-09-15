# @zhushanwen/pi-cache-probe

## 0.3.1

### Patch Changes

- 64f17310a: ext-simplify-18 shared adoption batch (ext-simplify-17 registered legacy

  topic cash-in):

  - llm-shared: new parseModelRef export ("provider/modelId" ref parsing,
  renamed from private parseRef, body verbatim) (D4)
  - Five packages gain @zhushanwen/pi-ext-guards dependency
  (session-reader / cache-probe / cw-tool / ask-user /
  system-prompt-trace): standalone pi users' closure grows by one
  zero-dependency pure-function package (dependency groundwork)
  - toErrorMessage adoption: 26 hand-written inline sites across
  permission (7), session-reader (5), cache-probe (5, incl. one
  String()-wrapper variant), structured-output (3), smart-context (2),
  subagent-workflow (2), ask-user (1), cw-tool (1) all switched to the
  ext-guards export (D1)
  - isRecord/isPlainObject adoption: 9 local copies removed (3 strict
  identical + 5 lenient migrated to strict with per-site equivalence
  argued + bte missed-site caught by zero-residue grep). All in-package
  consumers switched to ext-guards isRecord. structured-output keeps a
  deprecated isPlainObject re-export for its deep-path public name;
  system-prompt-trace deletes its exported copy outright (taiji group,
  zero external imports) (D2)
  - isEnoentError adoption: cw-tool spawn-error hints (2 sites) and
  rename-session flag cleanup (1 site, also drops an as-cast) (D3)
  - permission: model-picker provider/model preselection now parses specs
  via llm-shared parseModelRef — intended micro-change: a pathological
  "provider/" (empty modelId) manual config value now falls back to Auto
  instead of half-selecting the provider; all well-formed refs unchanged
  (D4, pinned by MPT8)
  - session-reader: three SessionHeader first-line readers consolidated
  into discovery/session-header.ts (two near-identical async 8KB copies
  merged; sync 4KB id-reader moved verbatim) (D5)
  - Thinking-vocabulary guard: subagent-core THINKING_ORDER joins the
  check-thinking-levels comparison plane (T3, set-equality; order
  semantics stay pinned by subagent-core tests); pre-commit trigger
  surface gains model-ref.ts; C-build-10 registration synced (D6)

## 0.3.0

### Minor Changes

- 4955dad6e: Converge export surfaces to what consumers actually use.

  - **pi-extension-logger**: the package now re-exports a single curated surface instead of the previous wider barrel; internal-only helpers are no longer part of the public API.
  - **pi-cache-probe**: `fingerprint` exports are trimmed to the functions consumed downstream, aligning the public surface with actual usage.

## 0.1.3

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.1.2

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.1.1

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

# Changelog

## 0.1.0

初始版本。

- 9 个指纹 hash（schema v2：短 hash + 增量 entry，长期采集数据量精简）
- `before_agent_start`（每 turn）算输入侧 7 hash；`before_provider_request`（turn 首笔）补 payload 侧 spFull / toolsSent，变化时 `appendEntry`
- 零行为影响：不返回 systemPrompt、不注册 tool、不注入消息；custom entry 不进 LLM 上下文
- 契约测试：`src/__tests__/fingerprint.test.ts` + `state-machine.test.ts`
- 配套 `analyze.py` 归因脚本（增量 merge 回放）
