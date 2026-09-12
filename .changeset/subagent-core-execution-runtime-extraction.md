---
'@zhushanwen/subagent-core': minor
---

Execution-runtime extraction and chat-run unification alignment ([H1]–[H4]). Breaking and behavioral changes — release in lockstep with `@zhushanwen/subagent-engine-sdk`, `@zhushanwen/pi-subagent-cli` and `@zhushanwen/zcode-subagent-cli` from the same batch (new-core `resume` runs against old-protocol engines would silently lose session continuity).

- **Execution runtime absorbed from pi-subagent-workflow** ([H1–H4] alignment): the workflow run engine, record store and persistence family now live in this package; pi-subagent-workflow keeps only the registration surface and pi host adapters.
- **`InteractAction` / `InteractResult` exports removed** (barrel `src/index.ts`): the interact protocol family retired with chat-run unification — chat continuation is a new run with a `resume` anchor.
- **`LifecycleDeps.streamSink` replaced by `workflowAgentDispatch`**: stream consumption is wired through the workflow agent dispatch closure (carrying the real `run.runId`) instead of a stream sink port.
- **`ExecutionTraceNode.live` field removed**: the "clear live on completion" mechanism collapses into the type layer — nodes carry no runtime-attached object anymore.
- **`RecordStore.collectRecords` defaults to hiding workflow-origin records**: the `origin === "workflow"` filter is on by default for list/TUI-facing queries; pass the new `includeWorkflow: true` (4th parameter) to see workflow-dispatched records (diagnostics/drill-down channels). Governance paths (orphan recovery / revive) are unaffected and always see all records.
- `SubagentService` singleton accessors (`getSubagentService` / `setSubagentService`) and the init interface moved to `execution/service/service-bootstrap.ts`; the barrel re-points at it so the exported symbol set is unchanged (consumers unaffected).
