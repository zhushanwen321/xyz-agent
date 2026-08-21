# rfl-m0：M0 仪表地基（T1-T4，设计文档 §9 里程碑 M0）

## 任务背景

review-fix-loop 的 run 数据（state.json）现落 `$TMPDIR`（系统清理即丢失），无 token/耗时记录；引擎 AgentResult 已含 usage/durationMs/sessionId 但 returnMeta 不透传到脚本侧；引擎不注入 `_runId`，worker rebuild 时脚本回退 `"run-"+Date.now()` 导致同一逻辑 run 碎裂到多个目录。

设计文档：`docs/todo/review-fix-loop-efficiency/tier-1-cheap-wins.md` §6.8（全量仪表+存储迁移+CLI）、§7.1（引擎透传规格）、§7.3（state.json 新增字段）、§7.4（CLI 命令）、§7.5（存储路径）。

## 目标

交付目标 1（可观测）+ 目标 7（run 完整性）：T1 引擎透传 usage/durationMs/sessionId（两个对称点）、T2 引擎 _runId 稳定注入、T3 RUN_ROOT 迁移 `~/.review-fix-loop/<slug>/<runId>/`、T4 calls[] 采集 + rfl.mjs CLI。

## 改动点（已核实源码）

- T1：`extensions/subagent-workflow/src/orchestration/worker-script-builder.ts` worker 模板两个对称点——live resolve（`pending.resolve({value, sessionFile, worktreePath, error})`）与 `_callCache` 重放重建（同四字段）——各扩 `usage/durationMs/sessionId`。模板是 byte-identical 快照锚定（`src/orchestration/__tests__/__fixtures__/worker-template.snapshot.txt`），fixture 需同 commit 更新基线（IF6 先例）。
- T2：`src/orchestration/lifecycle.ts` `runWorkflow` 是单一 choke point（覆盖 runAndWait launcher.ts:180 与 executeNestedWorkflow launcher.ts:290 两个入口；error-recovery.ts:195 rebuildRuntime 复用 `run.spec.args` 同一对象）——在 `validateRunArgs` 之后、`workerHost.start` 之前把 runId 写入 `spec.args._runId`。脚本侧 review-fix-loop.js:298 已读 `$ARGS._runId`，utils.cjs VALID_ARG_KEYS 已含 `_runId`。
- T3：`workflows/review-fix-loop-utils.cjs` 新增 `resolveRunRoot` 纯函数（git toplevel → slug 化，非 git 用 cwd；home 不可写降级 $TMPDIR 并返回 degraded 标记）；`workflows/review-fix-loop.js` :298-303 接线（RUN_ROOT 改用 resolveRunRoot，degraded 时 log WARN）。旧 $TMPDIR run 不迁移；loadState 只从新位置读。
- T4：review-fix-loop.js 每次 agent 调用（reviewer/aggregator/fixer，均已是 returnMeta:true）后记录 `state.calls[]`（字段见设计 §7.3：batch/round/role/name/model/durationMs/usage/promptMode/promptBytes/sessionId）+ `batches[].rounds[].phaseTimings{review,aggregate,fix}`（[t0,t1] ms epoch 对）。新 CLI `extensions/subagent-workflow/scripts/rfl.mjs`（零依赖）：`rfl list [repoSlug]` / `rfl stats <runId|latest>` / `rfl trends [repoSlug]` / `rfl clean --older-than 30d`（默认干跑，--yes 执行）。

## 验收标准

见 spec.json（A1-A8）：A1/A2 透传两对称点（单测，重放路径用 _callCache 剧本）；A3/A4 _runId 注入与 rebuild 稳定；A5 resolveRunRoot slug/降级；A6 e2e-mock 全链路（真实 worker thread + mock runner，HOME 隔离）state.json 落新位置且 calls[] 采集完整；A7 rfl CLI 四命令；A8 快照基线一致性（模板改动后 fixture 同步更新且测试过）。

## 边界

不改变循环骨架与 R2+ 全量重扫行为；不迁移旧数据；真实 run 场景验收（S1/S4）不在本单元机器验收范围。
