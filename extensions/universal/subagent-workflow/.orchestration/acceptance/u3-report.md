# U3 验收报告 — 文档回写（README / CHANGELOG / 手册修订 + R8 扩权注释清理）

> verifier 对抗式独立验收。基线 commit `963fddae8`。验收日期 2026-08-16。
>
> status: **PASS**（3 条 minor 观察，无 MUST_FIX）

## 0. 基线与 diff 范围结论

- 基线 `963fddae8`（U3 acceptance 基线 docs commit）。基线后仅 1 个外部 commit `7c4061e0a`（displayAgentName 功能，9 文件，已提交，与 U3 无关）。
- **防篡改**：`git diff 963fddae8 -- .orchestration/ docs/design/workflow-one-shot-lifecycle.md` 为空（0 文件）。父文档与验收记录未被触碰。PASS。
- **工作区 U3 改动恰 11 文件**（与任务清单逐一对上）：README.md、CHANGELOG.md、docs/design/workflow-one-shot-lifecycle-impl-spec.md、skills/workflow-script-format/SKILL.md、src/orchestration/worker-host.ts、src/orchestration/error-recovery.ts、src/orchestration/worker-handle.ts、src/orchestration/args-validator.ts、src/orchestration/__tests__/args-validator.test.ts、src/orchestration/models/__tests__/trace.test.ts、src/__tests__/prompt-quality-batch1.test.ts。与外部 commit 7c4061e0a 的 9 文件（subagent-service / bg-notify-render / list-component / subagent-actions / subagents / tool-render / WorkflowsView / agent-ref / agent-ref.test）**零交集**。
- **零 src/ 代码行为变更**：7 个 src 文件逐 hunk 核对，全部为注释或测试名字符串改写，无任何逻辑行/断言变更：
  - args-validator.ts ×1 hunk（注释）、error-recovery.ts ×2 hunk（注释）、worker-handle.ts ×1 hunk（注释）、worker-host.ts ×1 hunk（注释）
  - prompt-quality-batch1.test.ts ×1 hunk（注释行，断言未动）、args-validator.test.ts ×1 hunk（行内注释，断言未动）、trace.test.ts ×1 hunk（it 描述名，断言未动）

## 1. 内容真实性逐项

### (a) README「Workflow 生命周期（one-shot）」小节 — PASS

- 语义句 `Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.` 与 `src/interface/tool-workflow.ts:326` promptGuidelines **逐字一致**。
- 状态机两态：`types.ts:27` `RunStatus = "running" | "done"`、`VALID_RUN_TRANSITIONS` 仅 `running→done`、done 唯一终态 — 一致。
- 快照 `wf-run-v2` / 旧 v1 静默跳过：`jsonl-run-store.ts:71` `SNAPSHOT_VERSION = "wf-run-v2"`，v1 loadAll 静默跳过 — 一致。
- `workflow` tool 仅 3 action：`tool-workflow.ts:54-60` `WORKFLOW_ACTIONS = ["run","status","abort"]` — 一致。
- **minor-1**：README「reason 区分 completed / aborted / failed / budget_limited」列举漏了 `time_limited`（types.ts `DoneReason` 中 run.state.reason 可达值有 5 个）。列举未声明穷尽，无误导性，定 minor。

### (b) CHANGELOG 4 项 breaking — PASS

新增 `## Unreleased` 节（package.json 当前 7.3.4 与 CHANGELOG 末节同版本、未发布新版本号 → Unreleased 惯例正确）。逐项对照：

1. **action enum 收窄**：U1 commit message `workflow tool action enum narrows to run/status/abort` + `WORKFLOW_ACTIONS` 代码 — 一致；`Validation failed for tool "workflow"` 文本与 impl-spec S4① U1 verifier 实测口径一致。
2. **/workflows verb 收窄**：提示文案与 `commands.ts:117` **逐字一致**；`(warning level)` 与 `ctx.ui.notify(..., "warning")` 一致；completion 子断言与 `commands.ts:69-72` `getArgumentCompletions` 仅 abort 一致；TUI `p` 键移除 / `a` 保留与 `WorkflowsView.ts:432`（`data === "a"`，无 p）一致。
3. **session 切换 terminate done,failed**：`index.ts:538/606` reason 字符串逐字一致；`lifecycle.ts:326-328` `run.state.error = reason` + `transition("done","failed")` + `store.save` 持久化一致；`previously auto-paused and resumable` 历史断言经 pre-U1 代码（`889a798f9~1` index.ts:527-538 session_tree 调 `pauseRun`）抽验准确。
4. **快照 v1→v2 跳过**：U2 commit + `SNAPSHOT_VERSION` / 两态 / `pausedAt` 删除（workflow-run.ts 零命中，jsonl-run-store 仅版本历史注释）/ create-as-running（`lifecycle.ts:181` `status: "running"`）/ `ReleaseMode = "terminal"`（run-runtime.ts:28）全部一致。
- **崩溃重试注记**：up to 3 retries（`MAX_WORKER_RETRIES = 3`，rebuild 分支 `count <= 3`）、in-flight 清除重跑 / genuinely-done 保留 replay（`discardInFlightCalls` 只删 `status !== "done"`）与代码一致；E2E 证据口径（alpha 恰 1 session file / beta 恰 2）与 impl-spec S7① 及 U1 verifier 实测记录一致。

### (c) SKILL.md:244 修正段 — PASS

- pause/resume 机制宣传已改为一次性语义（`Runs are one-shot（无 pause/resume——提前停止用 abort，要新结果重新 run）`）。
- 「重试 ≤3 次 + callId 缓存重放不重跑」与 error-recovery.ts 实际机制一致：`MAX_WORKER_RETRIES = 3`、指数退避（`backoffDelay`）、`run.state.calls` Map replay（:268 done 命中即 `postAgentResult(..., true)`）、`discardInFlightCalls` 清在飞保留已完成。
- 「无 script hash 校验」警示保留（改写为「重试重放的是缓存结果，开发期改脚本应重新 run」，警示语义完整）。
- `parallel()` 顺序确定性要求保留且归因改写为 crash-retry replay — 与代码一致。

### (d) impl-spec 手册 3 处修订 — PASS

1. S7 脚本补 `@pi-meta` 头（name/description/phases `[agents]` 全声明），并给出最终脚本全文。与 `meta-parser.ts` 必填校验（name 非空 :84 / description :85 / phases 数组 :93，任一缺失返 null）一致，U1 verifier 实测注记 ① 准确转述。
2. S7 断言改行为证据口径：rebuild 路径（handleWorkerExit → handleWorkerError → scheduleRebuild → rebuildRuntime）经代码核实 **rebuild 分支零 deps.log 调用**（仅超限 failed 分支有日志），断言可执行（workerErrorCount=1 + session 文件计数 + scriptResult）；S7②③ 计数口径（计数至 4 耗尽 / worker-script 分账）与 `count <= MAX_WORKER_RETRIES` 语义吻合。
3. S4③ 补全断言补注记（pi rpc-mode 无补全探测入口，以源码 diff 为证：`getArgumentCompletions` 仅 abort）— 落地。

### (e) 注释 8 hunk 与所在代码行为一致性 — PASS

- error-recovery.ts:267「跨 rebuild——崩溃重建后重跑脚本，已完成调用按 callId 命中缓存」— 对应 rebuildRuntime + calls replay 实路径，准确。
- error-recovery.ts:352「已守 terminal（isTerminal）早期 return」— handleWorkerMessage:208 `if (isTerminal(run)) return`，`paused` 守卫在文件中已零命中，准确。
- args-validator.ts / worker-handle.ts / worker-host.ts / 两测试注释 / trace 测试名 — 均与所在代码现行为一致（逐一读上下文核实）。
- **minor-2（口径观察，非缺陷）**：R8 裁决摘要为「6 处注释 + 2 处测试名」，实际 diff 为 7 处注释 + 1 处测试名（hunk 总数同为 8；trace.test.ts 是唯一 it 名改写，prompt-quality-batch1 与 args-validator.test 均为注释行）。计数口径差异不影响实质（8 hunk 全部注释/测试名、零行为变更）。

## 2. grep 独立归类（288 处命中）

`grep -rn -i "pause|resume" src/ skills/` 复跑 288 处，独立归类如下，**无一处为现役 workflow pause/resume 能力描述残留**：

| 类别 | 处数（代表性） | 判定 |
|---|---|---|
| A. removed 能力必要字面量 | command-actions.ts:21/36/39-46/78（REMOVED_LIFECYCLE_VERBS + 类型）、commands.ts:105/114、tool-workflow.ts:11/294/326/545、WorkflowsView.ts:22/431、command-handlers/command-actions/prompt-quality-batch1 测试断言与注释 | 必要（removed 提示机制 + one-shot 语义句 + 历史说明注释） |
| B. subagent resume（与 workflow 无关的现役能力） | src/execution/ 全线（resumeRound / SpawnResumeOpts / 冷路径 resume / EPIPE 兜底）、index.ts:372/570/630/646、types.ts:252/612、相关测试 | 无关保留正确（subagent 续聊基建 + pi /resume session 语境） |
| C. Node.js stream.pause() API | stdin-writer.test:53/57、delivery-methods.test:102、run-spawn-integration.test:809/811、ask-user-transit-e2e.test:139、dialog-queue.ts:210 | 无关保留正确 |
| D. 历史/版本说明注释 | error-recovery.ts:131、jsonl-run-store.ts:64/65、run-runtime.ts:25、jsonl-run-store-session-file.test:226/268/286/287、execution/types.ts:73 | 历史语境，正确 |

## 3. 命令实跑输出尾部

```
$ pnpm extensions:typecheck
TYPECHECK_EXIT=0

$ pnpm extensions:lint
✖ 191 problems (0 errors, 191 warnings)   LINT_EXIT=0

$ cd extensions/subagent-workflow && npx vitest run
 Test Files  2 failed | 162 passed (164)
      Tests  4 failed | 2175 passed (2179)
   Duration  27.89s

$ npx vitest run <U3 的 3 个测试文件>
 Test Files  3 passed (3)
      Tests  43 passed (43)
```

4 个失败为**豁免存量**（与 ledger 观察项一致）：skill-discovery.test.ts ×2（依赖 `~/.agents/skills` 真实目录）+ spawn-worktree-guidance.test.ts ×2（依赖 worktree 环境 + 2 unhandled rejection）。两文件均不在 U3 的 11 文件内、自基线无改动，与 U3 diff 无因果。

## 4. 对抗抽查（自选 4 条，全过）

1. **SKILL.md 全文暗含语义扫描**：中文（挂起/暂停/续跑/可恢复/断点）+ 英文（suspend/halt/continue later/pick up/where it left/mid-run/interrupt）双向扫描 — 零命中，无「可暂停后续跑」误导残留。
2. **README 三态残留**：`三态|三种状态|paused|挂起|可恢复` 仅命中新增小节的否定/历史语境（:52/:54/:56 均为「已移除/不存在/wf-run-v2 两态」表述）。
3. **CHANGELOG 历史节误改检查**：diff 仅在文件头 `@@ -1,5 +1,23 @@` 新增 Unreleased 节；:375（历史 5-action 记录）与 :517（2003e64 RPC lifecycle 记录）等历史节原文未动 — 历史记录保留正确。
4. **CHANGELOG③ 历史断言抽验**：pre-U1 代码 `889a798f9~1` index.ts:527-538 确认 session_tree 曾 `pauseRun` 所有 running run — 「previously auto-paused and resumable」非杜撰。

## 5. 遗留边界判定复核 — ports.ts:132 语境成立

注释标题 `D-12 regression fix (round-2 #2)` 明确为历史修复记录；括号句「（直到下次 pause/resume 才重排）」出现在「否则……静默失效」的反事实分支内，转述的是**修复前缺陷现象**。代码考古证实：该措辞自 monorepo 集成 commit `e726711d0` 即存在（早于 U1）；pre-U1 的 `resumeRun`（`889a798f9~1` lifecycle.ts:331）确实调 `scheduleTimeBudget` 重排 — 「只有 pause/resume 能恢复预算」在 D-12 修复前时代语义准确。**不报 MUST_FIX，维持主 agent 保留裁决。**（附注：error-recovery.ts 同源注释已改写为新口径「直到 rebuildRuntime 才重排——本函数即唯一重排点」，ports.ts 保留旧口径，两处并存但各自语境自洽。）

## 6. 总结论

**PASS** — U3 交付（首轮 3 文件 + R8 扩权 8 文件 = 11 文件）全部通过对抗式验收：防篡改区零触碰、范围恰 11 文件、零代码行为变更、文档语义与代码终态逐项一致、命令全绿（豁免存量外）、grep 独立归类无现役能力残留、遗留边界复核成立。

Minor 观察（不阻塞）：
1. README reason 列举漏 `time_limited`（非穷尽列举，无误导）。
2. R8 摘要计数口径（6 注释+2 测试名）与实际（7 注释+1 测试名）差 1，实质无影响。
3. `.orchestration/ledger.md` 事件流水缺 U2 verified→committed / U3 条目（最后事件停在 U1 verified）——ledger 属防篡改区、builder/verifier 无权写，属主 agent 流转职责，非 U3 交付缺陷，提请流转时补记。
