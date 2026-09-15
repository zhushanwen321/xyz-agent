# @zhushanwen/pi-session-manager

## 0.1.9

### Patch Changes

- 64f17310a: ext-simplify-17 cross-package shared extraction (shared-layer convergence):

  - ext-guards: new isRecord (array-excluding) and isEnoentError predicates,
  plus SUBAGENT_MARKER_ENV / isSubagentProcess for engine-spawned subagent
  detection (ext-simplify-17 D2/D3/D4)
  - llm-shared: adopts toErrorMessage internally; new isThinkingLevel (seven
  values incl. xhigh), normalizeModelSelector, joinTextBlocks exports. Note
  for standalone pi users: llm-shared now depends on @zhushanwen/pi-ext-guards
  (runtime dependency closure grows by one zero-dep package, D1/D5/D6/D7)
  - extension-protocol: new callMarkerRpc select+marker RPC primitive with
  MarkerRpcResult discriminated union and ChannelErrorResult error-shape
  single source; GuiContext.ui.select gains timeout field; firstContentText
  helper; mapReasonToStatus pending-entry mapping; plugin-bridge guard family
  moved here (four guards token-identical; isBridgeErrorResponse delegates to
  shared isChannelErrorResult, condition-equivalent). Existing type exports
  keep their names — SessionManagerErrorResult / BridgeErrorResponse are now
  aliases over the shared shape, public API unbroken (D8/D9/D10/D11)
  - base-tool-enhance: adopts ext-guards toErrorMessage (13 inline sites);
  subagent detection rerooted to the engine-injected XYZ_AGENT_SUBAGENT
  marker (old PI_SUBAGENT_* keys had no injector — in-subagent background
  downgrade was dead and now works again); pending unregister entries now
  write mapped status instead of raw reason (D1/D4/D10)
  - rename-session: drops local THINKING_LEVELS / normalizeModelSelector /
  joinTextBlocks / isRecord copies in favor of shared exports; three-site
  code-point truncation merged into truncateCodePoints, byte-identical
  (D3/D5/D6/D7/D13)
  - plan: inline firstContentText copy replaced by protocol import (new
  dependency wiring) (D9)
  - pi-rpc: ThinkingLevel whitelist gains xhigh — the :xhigh model suffix was
  silently dropped before; now accepted per pi-ai ModelThinkingLevel (P1-a)
  - session-manager: non-JSON channel responses now surface as isError with a
  logged trace instead of silently passing through as success text (intended
  behavior change, aligns with plugin-bridge shape) (D8)
  - todo: fixedWidth retired in favor of pi-tui truncateToWidth combination,
  visible output byte-identical (double-ellipsis truncation form locked by
  tests) (D14); firstContentText copy now imports from protocol (D9)
  - scheduler: adopts toErrorMessage (7 sites), entry-type literal converged
  to a constant, dual task/snapshot converters and history helpers unified
  in types.ts, isEnoentError imported from ext-guards — all behavior-neutral
  (D1/D12/D2)
  - permission: local THINKING_LEVELS/isModelThinkingLevel copies dropped in
  favor of llm-shared isThinkingLevel (D5)
  - smart-context: compact-model restore uses llm-shared
  normalizeModelSelector (D6); subagent detection converges on
  XYZ_AGENT_SUBAGENT marker via ext-guards (D4)
  - pending-notifications: mapReasonToStatus now delegates to the protocol
  single source (D10)
  - subagent-workflow: wide isEnoentError copy replaced by strict ext-guards
  import (D2); renderTextFallback delegates to protocol firstContentText
  (D9); inflight reporter send path uses callMarkerRpc primitive (D8)
  - plugin-bridge: callBridge transport core replaced by callMarkerRpc
  primitive (mode gate stays caller-side); guard family moved to protocol
  (four token-identical, error guard delegating) with local copies importing
  from there (D8/D11/D3)

## 0.1.8

### Patch Changes

- 893b702b6: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.9.0 → @xyz-agent/extension-protocol@0.10.0)

## 0.1.7

### Patch Changes

- 4955dad6e: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.8.2 → @xyz-agent/extension-protocol@0.9.0, @zhushanwen/pi-extension-logger@0.5.0 → @zhushanwen/pi-extension-logger@0.6.0)

## 0.1.6

### Patch Changes

- bbd8e5e8a: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.8.1 → @xyz-agent/extension-protocol@0.8.2)

## 0.1.5

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.1.4

### Patch Changes

- 7b33e6f00: **Drift cleanup across extension packages: agent-facing text synced with actual behavior, dead surface removed**

  > Scope note: accumulated post-convergence cleanup across several development sessions. Every removal below was verified to have zero non-test consumers; runtime behavior is unchanged unless a bullet says otherwise. `src/` ships in these npm packages, hence minor where exported surface shrank.

  **ask-user: drop the dead `ErrorDetails` surface; docs aligned with the throw-based error contract**

  - The exported `ErrorDetails` interface is removed and `AskUserDetails` narrows to plain `Result`: since the W4 fix every error path in `execute` throws (pi marks the tool result `isError` with empty details), so the `{error}` details shape — and the `renderResult` branch rendering `✗ <error>` — was unreachable. Runtime output is unchanged; the removal only affects deep imports of `src/types.ts` (the package entry keeps exporting only the extension factory).
  - README/ARCHITECTURE synced to the shipped behavior: validation failures and headless tool removal documented as throws, `←/→` (not Tab) documented as the question-tab navigation keys, and the `allowComment` parameter dropped from the docs — it does not exist in the code.

  **cw-tool: `cw_query` tool description corrected on `details.data`**

  - The tool description now says `details.data` holds the parsed result whenever the command's stdout is parseable as JSON, instead of implying it appears only with `--json` — matching what the runner already does. README/SKILL drop stale cross-repo doc references.

  **goal: dead exports removed, never-consumed prompt parameters dropped, criteria validation deduplicated**

  - Dead exports removed: `BUDGET_PERCENT_HIGH` / `BUDGET_PERCENT_LOW` (constants) and `checkResumeBudget` (service); `goalStatusSeverity` and `getTitle` become module-private. The exported prompt builders `formatBudget` / `continuationPrompt` / `contextInjectionPrompt` drop the `timeUsedSeconds` placeholder argument that was explicitly `void`-ed — output text is byte-identical, but deep-import call sites should drop the argument.
  - successCriteria per-item validation (string / non-empty / single-line) is extracted into `adapters/success-criteria.ts` shared by the `goal_control create` tool path and `/goal update`; validation order and message wording are unchanged, only the `Correct:` recovery example is parameterized per channel.
  - README / CHANGELOG erratum / package description synced with shipped behavior: token-only budget (time budget removed), agent-reported blocking, append-only persistence with no entry GC.

  **scheduler: skip-reason wording and tool text synced with the delivery-kernel behavior; dead surface dropped**

  - `schedule_control run`'s `DISPATCH_SKIPPED` message no longer lists "busy" as a skip reason (`disabled, rate-limited, or already queued for delivery`) — non-force tasks are already enqueued in the session delivery kernel when the agent is busy and delivered once idle, and the message now says so. The `expires` parameter description notes it only applies to recurring tasks, the `run` guideline describes enqueue-then-deliver semantics, and the `/schedule` command description no longer promises a no-args TUI (bare `/schedule` returns a not-implemented notice pointing at `/schedule list`).
  - Dead surface removed: `ExecutionRecord.snippet` (declared, never populated), `SchedulerRuntime.getTaskCount()`, and the `note` field of `normalizeCronExpression`'s return type (now a plain string).

  **session-manager: tool descriptions aligned with actual runtime statuses**

  - `get_session_status` now documents status values as `active / idle / error` (not `running`), and `abort_session` says the final status will be `stopped` instead of an "aborted state" — matching what the xyz-agent runtime handler actually reports. README syncs the select-timeout tiers (create/history 60s, others 30s) and notes `list_my_sessions` takes no filter parameters.

  **session-reader: LLM-facing wording corrected across the tool surface; dead fields dropped**

  - Tool description and parameter descriptions now match the implementation: outline is a ~1500-token overview (render budget hard-coded at 2000), `turns` applies to detail and extract, `allBranches` applies to outline/export but not family, `source` filters find and session-resolving actions, TUI `#` references insert full uuids, and the current-session advice no longer names a nonexistent `get_messages` tool. Error and hint texts reworded for accuracy: an unmatched `sa-` id now says the record may not be flushed yet, and the truncated-outline hint points at `detail`'s `turns` range instead of a budget knob.
  - Dead optional fields removed from shipped types (`SessionRef.name`, `AutocompleteCandidate.description` — never populated), and the duplicated `formatOmitted` helper now reuses the exported `formatBytesMarker`.

  **structured-output: correction hints now spell the real tool name**

  - `CORRECT_USAGE_HINT` and the tool description's usage examples now write `structured-output(...)` — the registered `TOOL_NAME`, hyphenated — instead of `structured_output(...)`: an LLM following the old underscore spelling would call a tool name that does not exist. Comments re-anchor the cross-package schema-env contract to `packages/subagent-core`, and the npm description now covers both the workflow mode and the interactive Ajv-validated mode.

## 0.1.3

### Patch Changes

- b3a8cf77b: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.6.0 → @xyz-agent/extension-protocol@0.7.0)

## 0.1.2

### Patch Changes

- d4f466667: chore: refresh dependency range (triggered by @zhushanwen/pi-extension-logger@0.2.2 → @zhushanwen/pi-extension-logger@0.3.0)

## 0.1.1

### Patch Changes

- df69a18fc: New `@zhushanwen/pi-session-manager` extension (0.1.0 first release): agent-managed sessions — six tools (create / send / history / status / list / abort) letting an agent spawn and manage independent child sessions via the `\x00XYZ_SESSION_MANAGER` select+marker channel, answered by the xyz-agent runtime SessionManagerHandler. Includes `.agent.json` sidecar persistence for restart recovery (AI badge + parent navigation in the sidebar), server-side injection of spawnSource/parentAgentSessionId (extension params are untrusted), and a real-pi full-chain e2e suite.
