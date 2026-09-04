# PR 全生命周期 workflow（pr-lifecycle）设计

> **一句话结论**：新建单一 workflow 脚本 `.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js`（core 引擎契约；u6 用户裁决移入 skill 目录自包含），把 pr-cr-fix skill 的「开 PR → 门禁 → review-fix 循环 → code-simplify → 终局门禁」全链路编排进脚本：确定性步骤由脚本直接 `child_process` 跑，LLM 步骤收敛为 `agent()` 调用，cr-fix 循环嵌套复用引擎内置 `review-fix-loop`；脚本自维护 `.review/pr-workflow/<runId>/state.json` 检查点文件实现断点恢复——不传 `runId` 从头跑，传 `runId` 从未完成的第一个 step 续跑。终局 push 留在脚本外，由主 agent 获用户授权后执行。

**层声明**：本设计当前层 = 技术方案（脚本架构 / 状态机 / 契约），下一层 = 实现（脚本代码 + SKILL.md 路径 2 重写）。

**SCQA**：pr-cr-fix 已是本仓 PR 工作流的唯一入口（S），但它是一份 440 行的 LLM 编排手册——主 agent 要手工跑 20+ 步、跨小时级执行，任何中断（进程死亡、额度耗尽、context 溢出）都靠前序对话记忆恢复，且 review 循环在 pi/zcode 双轨实现已漂移（C）；把确定性编排下沉为脚本、给脚本加 runId 断点恢复、顺手收敛双轨（A）；本文给出脚本的整体设计（Q）。

## 1. 背景目标

### 1.1 系统是什么

pr-cr-fix skill 当前的工作方式：主 agent 读 SKILL.md，依次手工执行——阶段 1 开 PR（static gate → 生成 PR title/body → push + 建 PR）、阶段 1.5/1.6 两道度量门禁、阶段 2 派 review-fix workflow（8 维 review agent 循环修复）、阶段 3 终局三道门禁 + push。其中阶段 2 在 zcode 环境已有一个 workflow 脚本 `.agents/workflows/pr-review-fix.js`，其余阶段全靠主 agent 按手册逐步执行。

本设计要造的系统：**一个** workflow 脚本，主 agent 一次调用，脚本自己跑完全部阶段（除最终 push），失败可随时用 runId 续跑。

### 1.2 设计目标（从使用者——主 agent——体验倒推)

- G1 **一次调用**：主 agent 发起 run 后只做两件事——等终态通知、拿用户授权后 push。中间不需要逐步编排。
- G2 **断点恢复**：脚本在任意环节失败/被杀后，主 agent 带 `runId` 重新发起同一个 workflow，已完成的步骤自动跳过，从断点续跑。runId 在脚本启动时创建，主 agent 有可靠通道拿到它（含脚本暴毙、无任何通知的场景）。
- G3 **双轨收敛**：cr-fix 循环不再维护仓内移植版，复用引擎内置 `review-fix-loop`（pi/zcode 同源）。
- G4 **code-simplify 纳入**：cr-fix 收敛后自动执行 1 轮 code-simplify（只跑一轮，不循环），产出直接落到 PR diff。
- G5 **门禁语义不降级**：SKILL.md 现有全部硬门禁（Gate-1a / 1a.5 / 1.5 / 1.6 / 2 / 3a）在脚本内语义等价保留，包括执行顺序（coverage → metrics）与注入值契约。

### 1.3 In / Out scope

- **In**：新 workflow 脚本；runId 断点恢复机制；pr-cr-fix SKILL.md 路径 2 重写；旧 `pr-review-fix.js` 退役。
- **Out**：pi 环境路径 1 的改造（预期收益是路径 1/2 可统一为同一脚本，实施期验证后顺手落地，不作为本设计交付承诺）；最终 push（永远留在主 agent + 用户授权）；引擎级原生 checkpoint 能力（列为后续演进方向，见 §3.2 方案 C）；merge/release 流程（merge skill 领域）。

## 2. 现状与问题分析

### 2.1 现状（全部取自代码/文档原文）

**(a) SKILL.md 是一本纯手册**。阶段 1 到阶段 3 共 20+ 个步骤、6 个 Gate、十几条 [MANDATORY] 约束，全部由主 agent 读后自觉执行。确定性脚本（`scripts/pr-pre-merge.sh`、`scripts/pr-submit.sh`、`metrics-gate.py`、`coverage-gate.py`、`select-constraints.mjs`、`validate-skill-yaml.py`）都是现成可机器执行的，但调用顺序、参数、Gate 判定、失败处置全靠 LLM 守规矩。

**(b) 仓内移植版 loop 是简化版，且与原版已漂移**。`.agents/workflows/pr-review-fix.js`（350 行，`module.exports = {name, description, run(ctx)}` 形态）对比引擎内置 `review-fix-loop`（`packages/subagent-core/workflows/review-fix-loop.js`，1606 行）：

| 能力 | 内置版 | 仓内移植版 |
|---|---|---|
| 防「假 clean」台账（issues 状态机 + 跨轮身份对账 + hasOpenResidue 守门） | 有 | **无** |
| 终止态 | clean/converged/stuck/needs-redesign/review-failure/aggregator-failure/fix-failure/max-rounds | clean/stuck/review-failed/fix-failed/max-rounds/fixed-unverified/aborted（无 converged、无 needs-redesign） |
| 聚合 | 独立 aggregator agent（可降档模型，跨维去重/裁决） | 脚本自己拼 markdown 索引（无 LLM 裁决去重） |
| fix commit | 显式路径 add，**明文禁止 `git add -A`** | prompt 指令 `git add -A && git commit`（会把工作区认知外改动一起提交，违反全局规则 0 精神） |
| fix 超时 | 故意不限时（写操作不被墙钟打断） | perPhaseMs 默认 10min 可被打断 |
| 状态持久化 | 每轮原子写 `~/.review-fix-loop/<slug>/<runId>/state.json` | 无任何状态文件 |

**(c) 引擎无断点恢复，且正在换代**。调研实锤（源码证据见 §3.6 D1）：

1. zcode 的 z-subagent-workflow 插件有两代契约：旧版 1.0.0（进程内引擎，`run(ctx)` + `ctx.runAgent` 契约，pr-review-fix.js 跑在这代）；新版 **1.2.0 已实装在插件 cache**（vendored `@zhushanwen/subagent-core@0.3.0`，与 pi 的 workflow 引擎同一份代码），`~/.zcode/cli/config.json` 的 zsw MCP server 条目已指向 `cache/.../1.2.0/dist/mcp/server.js`。契约变为 `/* @pi-meta */` YAML 块 + 顶层 `agent()`/`parallel()`/`$ARGS` 注入全局。**`run(ctx)` 形态在 1.2.0 下不可运行**（无 meta 块直接拒跑）——pr-review-fix.js 迟早要重写，现在写新脚本正是迁移窗口。
2. 两代引擎**都没有** resume/checkpoint/跨 run 状态 API。1.2.0 有同 run 内崩溃自动重试 ≤3 次 + callId 结果回放（不重耗 token），但新 run 永远从零开始；进程被杀后遗留 running run 只被收编为 failed，从不续跑。引擎 run 状态持久化在 `~/.zcode/zsw/workflow-state/<engineRunId>.jsonl`（脚本无官方 API 读它，§3.4-(4) 活性守卫对该文件的依赖列为实施期探针）。
3. 引擎给脚本的持久化出路只有一条：**脚本自己 `require('node:fs')` 写文件**（worker 无沙箱，`child_process`/`fs` 均可用；lint 对读 state 文件仅 warning）。
4. 1.2.0 下自定义参数可透传进 `$ARGS`（`runId` 不在保留键 `RUN_ENVELOPE_KEYS` 中），引擎 runId 经 `$ARGS._runId` 注入——两者都有用，见 §3.4。

**(d) code-simplify 未纳入 PR 流程**。cr-fix 修复完是简化的最佳时机（diff 上下文热、测试已绿），但当前流程没有这一步；且 code-simplify skill 内含「先报告、用户确认后才改」的 [MANDATORY] 确认断点（SKILL.md 与 references/workflow.md 步骤 4-5 均有此表述），直接无人值守执行需要一个显式决策（见 §3.6 D6）。

**(e) 当前调用面处于半坏状态（环境问题，如实记录）**：config.json 同时存在两条 zsw 记录——MCP server 条目指向 cache 1.2.0（有效），但 `plugins.dirs[0]` 残留指向已不存在的 worktree（`zcode-plugin-workspace/feat-app-server-refactor/...`）且优先级更高，本 session 的 zflow 发起即因该残留失败（dist 未构建）。1.2.0 的调用面细节（daemon 异步 / CLI 同步、完成通知方式）以实装为准，列入 §5 待验证②。

### 2.2 问题与根因

- **P1 手工编排不可靠**：20+ 步靠 LLM 自觉，跳步/乱序/忘 Gate 无法结构性防止。根因：确定性流程没有下沉为代码。
- **P2 中断即前功尽弃**：全流程小时级（8 维 × 多轮 review + 修复 + 覆盖率实跑），夜间托管是常态，进程死亡/额度耗尽后主 agent 只能靠对话记忆「大概恢复到哪」。根因：引擎无 resume，脚本也无自持状态。
- **P3 loop 双轨漂移**：移植版是原版的简化快照，原版持续演进（台账、converged 都是后加的），移植版无人跟进。根因：fork 了一份本可复用的代码。
- **P4 简化缺位**：修复后的代码直接进 PR，累积认知复杂度。根因：流程定义里没有这一步。

## 3. 解决方案

### 3.1 终态（使用者视角）

使用者 = 主 agent。交互只有三个触点：发起、收终态、（失败时）带 runId 再发起。发起/完成通知的具体形态（daemon socket 异步 / CLI `run_in_background` 包裹）以 §5 待验证②的探针结论为准，下文伪代码用 `zflow run` 中性表示。

**成功路径**：

```text
# 主 agent 发起（不传 runId = 从头执行；--repo 必传——workdir 是引擎保留键不进脚本参数）
node <zsw-cli> workflow --workflow <repo>/.agents/workflows/pr-lifecycle.js \
  --task "<PR 背景>" --workdir <repo 绝对路径> --repo <repo 绝对路径> \
  --base <base> --timeout-ms 21600000
→ 返回引擎 runId（wf-...），后台/异步执行

# 脚本第一个动作：创建 runId 并落盘
#   .review/pr-workflow/prw-20260903-221430-k7m2/state.json   （status: running）
#   .review/pr-workflow/latest                                （内容：prw-20260903-221430-k7m2）

# 数小时后终态回流
scriptResult.json = {
  status: "awaiting-push",
  runId: "prw-20260903-221430-k7m2",
  prUrl: "https://github.com/zhushanwen321/xyz-agent/pull/197",
  terminated: "clean", simplify: "applied:3/proposals:4",
  gates: {coverage: "pass", metrics: "pass", premerge: "PASS"},
  skippedSteps: []          # 被人工/条件跳过的 step 及原因，汇报时必须逐项披露
}
# 主 agent → 用户：「PR #197 全流程绿，待授权 push」（有 skippedSteps 时逐项披露）
# 用户授权 → 主 agent 在脚本外执行 git push github HEAD:<branch> --force-with-lease
# （3b 恒 --force-with-lease，与 pr-submit.sh 同构：lease 在快进场景无副作用、
#   在远端有新提交时安全拒绝——SKILL 关键约束 4 的 force_push 判定链退化为常量）
```

**失败恢复路径（Gate 失败）**：

```text
scriptResult.json = {
  status: "failed", runId: "prw-20260903-221430-k7m2",
  failedStep: "coverage-1",
  error: "增量覆盖率 62% < 80%（已重试 3 轮），缺口见 .review/coverage.json uncovered_files",
  resumeCommand: "node <zsw-cli> workflow --workflow <repo>/.agents/workflows/pr-lifecycle.js --workdir <repo> --repo <repo> --runId prw-20260903-221430-k7m2"
}
# 主 agent 派 worker 补测试并 commit → 按 resumeCommand 带 runId 再发起
# → preflight 校验通过 → 自动跳过 static-gate/pr-meta/pr-submit（已 done）
# → 从 coverage-1 重跑 → 后续步骤继续
```

**进程暴毙路径（无任何通知）**：

```text
# zcode/CLI 宿主进程被杀，主 agent 什么都没收到
cat .review/pr-workflow/latest        # → prw-20260903-221430-k7m2（兜底通道）
# 带该 runId 再发起 → 活性守卫（引擎 state 终态判定为主、pid 仅降级）确认原 run 已终态
# → 从断点 step 续跑。daemon 形态注意：宿主被杀 ≠ run 死，若引擎 state 显示 running
# 需先 abort 原 run 再 resume
# 若断在 cr-fix 中途：嵌套 loop 整体重跑，但已 fix commit 的问题不会再被报出，
# 通常 1-2 轮即收敛（token 有损耗，工作量不丢失）
```

### 3.2 多方案对比

| 维度 | **方案 A（推荐）**：单脚本全链路 + 脚本自持 state + 嵌套内置 loop | 方案 B：保留主 agent 编排，只给移植版 loop 加 state | 方案 C：改造引擎支持原生 checkpoint/resume |
|---|---|---|---|
| 长期架构合理性 | **高**：编排即代码；loop 单源（内置版）；resume 机制与引擎解耦，pi/zcode 可共用同一脚本 | 低：440 行手册继续靠 LLM 自觉；loop 双轨依旧；PR 阶段仍手工 | 最高：引擎级通用能力，所有 workflow 受益 |
| 短期实现成本 | 中：新脚本约 600 行 + SKILL 路径 2 重写 + zsw 1.2.0 前置 | 低：只改 pr-review-fix.js | 高：跨 zcode-plugin-workspace + subagent-core 两仓改造 + 发包 + 本仓接入 |
| 风险 | zsw 1.2.0 尚未实装（前置条件，§5 拆分 1 先落地）；嵌套内置 loop 的 batch1 参数行为需探针验证（⛔实施期门，不过则降级为内嵌移植 loop） | 恢复可靠性仍依赖主 agent 守规矩——正是现状痛点 P1/P2，问题没被解决 | resume 语义（step 幂等、HEAD/分支守卫）本来只能由流程脚本定义，引擎只能给存储原语——收益有限、阻塞链长 |

**推荐方案 A**。理由：P1-P4 四个根因全部被正面击中；方案 B 只解决 P2 的一部分且加固了双轨；方案 C 是正交的长期演进（未来引擎若有原生 checkpoint，本方案的 state 文件机制可平移上去，不冲突）。

被否方案若落地的样子：方案 B 下，主 agent 仍需在每次中断后人工判断「该从哪个 Gate 重跑、哪些产物还有效」——即现状的每一次失败现场重演；方案 C 下，本仓要等两个上游仓发版才能动手，且等来的也只是「能存 state」，§3.4 的全部恢复语义仍要写在本脚本里。

### 3.3 总体结构：step 注册表 + 状态机

脚本 = 一个**有序 step 注册表** + 一个**resume walker**。每个 step 有唯一 id、确定性的执行体、幂等性设计（§3.4 表）。walker 按序遍历：`done` 跳过、`skipped` 跳过、其余（`pending`/`failed`/`in_progress`）执行；任一 step 失败 → 落盘 `status: failed` + `failedStep` + 恢复指引 → 返回结构化失败结果。

```text
preflight → static-gate → changeset* → pr-meta → skill-yaml* → pr-submit
→ constraints → coverage-1 → metrics-1 → cr-fix → simplify → final-gates
→ （返回 awaiting-push）

* = 条件 step：changeset 仅当 static-gate 输出 WARN changeset-check；
  skill-yaml 仅当 diff 触及 .agents/skills/。条件不满足时落 skipped + 原因，
  保证 resume 时判定确定（不重算条件）。
```

step 与 SKILL.md 阶段的对应（门禁语义映射，G5）：

| step | 对应 SKILL 阶段 | 执行体 | 关键契约 |
|---|---|---|---|
| `preflight` | 前置条件检查 | 脚本 | 校验 git repo / 分支相对 base 有 commits / `gh` 认证 / fallow 可用 / **工作区干净**（`git status --porcelain` 为空，非空 fail-fast——coverage 口径前提在 fresh 起点就锁住）；锁定 `baseHash`（`git rev-parse <base>^{commit}`）写入 state，全流程 review 口径锁定 |
| `static-gate` | 1.1 + Gate-1a | `bash scripts/pr-pre-merge.sh --skip-tests --quiet` | exit≠0 → 有界修复子循环（agent 修 → 重跑，≤3 轮）→ 超限 failed |
| `changeset` | Gate-1a.5 | `agent()` | 仅 WARN changeset-check 时触发；按 diff 逐包分类起草 `.changeset/*.md`，非发布改动落报告 |
| `pr-meta` | 1.2 | `agent()` 带 schema | 输入 `git log <baseHash>..HEAD` + `git diff --stat`，输出 `{title, body}`；落 `pr-title.txt` / `pr-body.md` |
| `skill-yaml` | 1.4 | `validate-skill-yaml.py` | 条件 step；fail → failed（属硬校验，不修） |
| `pr-submit` | 1.3 + Gate-1 | `bash scripts/pr-submit.sh --title-file --body-file --base <base>` | 幂等（脚本自身检测已存在 PR 仅更新）；从输出解析 `pr_url` 校验 `^https://github\.com/.+/pull/\d+$`；含首次 push（流程内行为，与现 SKILL 一致）。**force_push 透传机制已废弃**（被否谱系：源码事实——pr-submit.sh 无条件 `git push ... --force-with-lease`，无任何 force 判定信号可解析；故 3b 恒 --force-with-lease，见 §3.1） |
| `constraints` | 阶段 2 前置 | `node scripts/select-constraints.mjs --base <base>` | 产出 `.review/constraints.md` 供 review agent 消费 |
| `coverage-1` | 1.6 + Gate-1.6 | `coverage-gate.py --base <base>`（diff 含 `packages/shared/**/src/**` 时自动加 `--extra-packages packages/runtime,packages/renderer`） | exit 1 → 派测试 agent 按 `uncovered_files` 补测试 → 重跑 ≤3 轮；exit 2 → failed（工具错误不自动重试） |
| `metrics-1` | 1.5 + Gate-1.5 | `metrics-gate.py --base <base>` | fail → agent 修 → 重跑 ≤3 轮；exit 2 → failed。顺序固定在 coverage-1 之后（coverage.json 的 files 节供其分流） |
| `cr-fix` | 阶段 2 + Gate-2 | `workflow("review-fix-loop", {targetType:"git-diff", target:<base>, batch1:<8 个 agent .md 绝对路径>, maxRounds:10, autoCommit:true, skipCleanAgents:true, aggregatorModel:<仅当参数显式传入时才带此键，缺省跟随 run 模型>})` 嵌套调用 | terminated 映射：clean/converged → 继续；review-failure/aggregator-failure/fix-failure → 脚本内自动重试 1 次，再败 failed；stuck/max-rounds/needs-redesign → failed（error 带 aggregated.md 路径 + 人工处置指引，见 §3.7）。fix commit message 采用内置版格式 `fix: review batch 1 round N — M must-fix + K suggestion`（与 SKILL 路径 2 旧约定不同，SKILL 重写时同步）。**aggregatorModel 不可写死**（Gate B S1 实证：硬编码 `zai-coding-cn/glm-5.3-flash` 在 pi 侧为未知 provider → aggregator-failure；设计原文的该默认值作废，改为透传参数） |
| `simplify` | （新增，G4） | 1 个 `agent()` | 仅 cr-fix 为 clean/converged 才执行，否则 skipped；详见 §3.6 D6 |
| `final-gates` | 3a + Gate-3a | 顺序跑 `coverage-gate.py --base <base>` → `metrics-gate.py --base <base>` → `pr-pre-merge.sh --test-result <注入值> --base <base>` | 三个动作合并为**一个 step**：任一失败按 SKILL 语义「从 ① 头部重跑」，故对外只暴露一个 checkpoint。`--test-result` 注入值 = 本 step 内 coverage-gate 的测试判定；**③ 必须传 `--base <base>`**（与 ① coverage.json 同值——Gate B S1 实证：脚本默认 main，stacked PR（base≠main）必然 exit 2；已给 pr-pre-merge.sh 增加可选 `--base` 参数，默认 main 向后兼容）。有界修复子循环 ≤3 轮。**内含 real-pi 检测**（SKILL 阶段 3a [MANDATORY]）：③ 执行前按 `pi-fixture.ts` 的 `REAL_PI_READY` 三源探测预检凭证，缺失即 failed；③ 输出解析 real-pi skip 标记（⛔实施期确定精确标记格式，探针 P6），检出即按失败处置——不得凭 skip 输出宣布 PASS。**收尾防线**：step 完成前最后一次 `git status --porcelain`，非空即 failed（防「修复改动未 commit → 读数假绿 → push 后修复静默丢失」，与本仓 structured-output 历史事故同型） |

**G5 语义映射的显式声明**（四处收紧/承接，均非降级）：

1. **修复范围**：内置 loop 修复全部等级（must-fix + suggestion）且 clean 判定要求 suggestion 也为 0，严于 SKILL「SUGGESTION 顺手修、INFO 忽略」——更严不降级。
2. **real-pi 开发验收**：SKILL「输出出现 real-pi skip 即验收不完整」由 final-gates 的 real-pi 检测原位承接（见上表）。
3. **Gate-2 stuck 处置收紧**：SKILL 路径 1 原语义 `stuck` 可进阶段 3，本设计统一为 failed 人工接管（skipSteps 逃生舱 + skippedSteps 披露链保证知情）——方向收紧，理由：无人值守场景下 stuck 自动放行等于门禁失效。
4. **Gate-3 双层判定承接**：`pr_exists` = pr-submit step done；`premerge.result == PASS` = final-gates step done；`local_ahead_of_origin == 0` 由 3b push 动作本身达成（push 后主 agent 验证远端 ref == HEAD，沿用 SKILL 现有动作，留在脚本外）。

### 3.4 断点恢复详细设计（G2 核心）

引擎不提供任何 resume 能力（§2.1-c），恢复机制全部内建于脚本。四件套：**runId、state 文件、resume walker、守卫**。

**(1) runId——创建时机与主 agent 获取通道**

- **创建**：fresh run（未传 `runId` 参数）的**第一个动作**，先于任何副作用。格式 `prw-<yyyymmdd-HHMMSS>-<rand4>`（如 `prw-20260903-221430-k7m2`），脚本自生成，不依赖引擎注入的 `$ARGS._runId`（那是引擎 runId，每次 run 都变，不能当恢复键；仅记录进 state 便于排查）。
- **落盘**：创建后立刻原子写 `state.json` + 更新 `.review/pr-workflow/latest` 指针文件（内容 = runId 单行文本）。
- **主 agent 拿到 runId 的三条通道**（按可靠性排序）：
  1. **终态 scriptResult.json 必含 `runId`**——成功与失败终态都有；失败终态另含 `failedStep` + 可直接复制执行的 `resumeCommand` 字符串（形态 = zsw CLI 真命令：`node <zsw-cli> workflow --workflow <repoRoot>/.agents/workflows/pr-lifecycle.js --workdir <repoRoot> --repo <repoRoot> --runId <runId>`——`--repo` 必带：workdir 是引擎保留键不进脚本参数，脚本读仓库根只能走此参数，repo 一致性由守卫 2 复核）。`<zsw-cli>` 由脚本按序解析（lib.resolveZswCli）：候选① zsw 插件 main worktree bin（`~/Code/zcode-plugin-workspace/main/z-subagent-workflow/bin/zsw.js`）优先；候选② 插件 cache 目录中版本数值最高且 ≥1.2.0 的条目（1.0.0 是旧 `run(ctx)` 契约，执行 core 契约脚本必失败，须过滤）；两候选皆缺失时降级占位符并注明获取方式。发起/通知形态的探针②定案见 §5 待验证②。这是正常路径。
  2. **`.review/pr-workflow/latest` 指针文件**——脚本暴毙（kill -9、宿主崩溃）无任何通知时的兜底通道。主 agent 或用户 `cat` 一下即可。
  3. **脚本 log 首行**——`log("runId=prw-... resumeCommand=...")`，运行中即可见。
- **fresh / resume 判定**：`$ARGS.runId` 缺失 → fresh（新建 runId）；存在 → resume（读 `<stateDir>/<runId>/state.json`，不存在则 fail-fast：「runId 不存在，若要从头执行请去掉 runId 参数」，绝不悄悄新建）。
- **engineRunId 刷新**：每次发起（fresh 与 resume 都含）把本次 `$ARGS._runId` 写入 state.engineRunId 并在首个 checkpoint 落盘——活性守卫的主通道永远读**最近一次** run 的状态文件，避免「读完首 run 终态后双重 resume 竞态窗口扩大」。
- **fresh 并发防护**：fresh 发起时同样读 `latest` 指针，对指针对应的 run 过一次活性守卫（§3.4-(4)）——已有进行中的 run 时 fail-fast「已有进行中的 run <runId>；如需从头再来请先 abort」，防同 worktree 双 run 并发写各自 state 却互相污染 git/PR。
- **互斥锁（TOCTOU 收口）**：上述「读 latest → 过守卫 → 写 state」是 check-then-act，存在并发窗口（双 fresh 同读同放行；resume 守卫通过到 engineRunId 刷新落盘之间被并发 resume 插入）。用 lockfile 原子化：进入任何 run（fresh/resume）前以 `O_EXCL` 创建 `.review/pr-workflow/lock`（内容 = runId + pid + engineRunId）；`EEXIST` 时读锁内容对其 engineRunId 过活性双通道复查——原 run 存活 → fail-fast，已终态/进程死 → 接管（删旧锁重建）。脚本到终态（awaiting-push/failed）时删除锁。锁同样靠 rename 语义之外的 `O_EXCL` 原子创建保证只有一个持有者。

**(2) state 文件 schema（stateVersion: 1）**

路径：`.review/pr-workflow/<runId>/state.json`（`/.review/` 已在 .gitignore，且随 worktree 天然隔离）。每次写盘 = 写临时文件 + `rename` 原子替换；写盘时机 = 每个 step 开始（标 `in_progress`）与结束（标 `done`/`failed`）、gate 修复子循环每轮、返回前。

```jsonc
{
  "stateVersion": 1,
  "runId": "prw-20260903-221430-k7m2",
  "repo": "/abs/path/to/worktree",          // preflight 时 git rev-parse --show-toplevel
  "branch": "feat-xxx",
  "base": "main",
  "baseHash": "<锁定的 base commit>",         // review/diff 口径锁定，防 ref 漂移
  "pid": 12345,                              // 跑脚本的进程，活性守卫降级通道用
  "engineRunId": "wf-...",                   // 每次发起刷新为本次 $ARGS._runId（活性守卫主通道）
  "params": { "...": "发起时参数原样留存" },
  "status": "running | awaiting-push | failed",
  "failedStep": null,
  "error": null,
  "lastHead": "<最近一次 checkpoint 时的 HEAD>",
  "result": null,                            // 终态 scriptResult 的完整快照；awaiting-push/failed 时写入，
                                             // 幂等重跑（全 done 且 HEAD 不变）直接回放，保证「同一结果」
  "steps": {
    "static-gate": { "status": "done", "startedAt": "...", "finishedAt": "...",
                     "attempts": 1,
                     "outputs": { "result": "PASS", "changesetWarn": false } },
    //   ↑ changesetWarn：条件 step「changeset」的判定输入——条件 step 的触发条件
    //     在其前置 step done 的同一 checkpoint 判定并落盘（不满足则直接落
    //     skipped+reason），resume walker 只读落盘结果，永不重算条件
    "pr-meta":     { "status": "done", "outputs": { "title": "...", "bodyFile": ".../pr-body.md" } },
    "pr-submit":   { "status": "done", "outputs": { "prUrl": "https://.../pull/1234" } },
    "cr-fix":      { "status": "in_progress", "attempts": 1,
                     "outputs": { "nestedRunId": "wf-...", "terminated": null,
                                  "aggregatedFile": null } },
    "simplify":    { "status": "pending" }
    //   终态展示字段的 outputs 契约：simplify.outputs={applied,proposals,reportFile}；
    //   final-gates.outputs={coverageVerdict,coveragePct,metricsVerdict,premergeResult}
    // ... 未执行到的 step 无条目或 pending
    // skipped 条目必须带 reason（"user-ack" / 条件不满足的具体原因），
    // 终态 scriptResult.skippedSteps 由此透传，授权链披露依据
  }
}
```

**(3) resume walker 语义**

1. 读 state → 依次过守卫（见下）→ 按注册表顺序找到第一个非 `done`/`skipped` 的 step → 从它开始执行。
2. `done`/`skipped` 的 step **一律不重跑**（幂等性在建 step 时已保证其产物仍有效；simplify 之后的 final-gates 是最终真实性校验，它没过就不算 done）。
3. `failed`/`in_progress`（= 上次死在中途）的 step **整体重跑该 step**——step 是恢复的最小单位。各 step 重跑安全性见下面的幂等表。
4. 通用逃生舱参数 `skipSteps: string[]`：walker 遇到列名中的未完成 step 标 `skipped(reason: "user-ack")` 并跳过。用途：人工判定 reviewer 误报卡住（cr-fix stuck）、用户已手工建过 PR（pr-submit）等接管场景。这是 resume 的必要人工接口，不是推测性功能。**所有 skipped 条目必须带 reason 并透传进终态 scriptResult.skippedSteps，主 agent 汇报 awaiting-push 时逐项披露**（授权链完整性：用户必须知道哪些门禁被跳过了）。
5. `cr-fix` 的恢复粒度说明：嵌套 loop 是黑盒（其内部 state.json 被刻意设计成跨 run 不续跑），故该 step 重跑 = loop 从头跑。可接受性论证：loop 的 fix 已逐轮 commit 进 git 历史，重跑时 review 面对的是**当前真实 diff**，已修复问题不会再被报出，通常 1-2 轮收敛；丢的是 stagnation 计数等易变态，由 maxRounds 兜底。这是方案 A 相对「copy 移植版加轮次级 checkpoint」的已知代价，已在 §3.2 计入。
6. **空转防护**：resume 时若所有 step 均已 done/skipped 且 HEAD == state.lastHead → 幂等返回旧终态（不重跑任何步骤）——**回放前提 = state.status 与 result.status 双双 awaiting-push**，不满足（如终态组装期崩溃残留的 failed result 快照）则从现存 steps outputs 重建 result 快照后返回，error 清空；若全 done 但 HEAD ≠ lastHead → **fail-fast**，指引「本 run 已完成；新产生的 commit 未经任何门禁，请不传 runId 起新 run」——不允许带着旧绿标空转放行新改动。

**(4) 守卫（resume 入口依次执行，任一不过即 fail-fast + 恢复指引）**

| 守卫 | 检查 | 失败处置 |
|---|---|---|
| state 存在性 | state.json 可读且 stateVersion=1 | 「runId 不存在或版本不兼容；从头执行请去掉 runId」 |
| repo 一致 | 当前脚本解析出的 repoRoot == state.repo | 「该 runId 属于另一仓库/worktree」 |
| 分支一致 | 当前分支 == state.branch | 「runId 属于分支 X；如需对当前分支跑全流程请不传 runId 起新 run」 |
| 活性（双通道，主通道裁决以记录进程存活为前提） | **主通道**：读引擎 state 文件 `~/.zcode/zsw/workflow-state/<state.engineRunId>.jsonl` 的最后状态——明确终态（done/failed/aborted 等已知值）→ 放行；**非终态（running/未知/缺失，fail-closed）时先 probe pid 裁决**：pid 存活 → fail-fast（daemon 活着且 run 在跑，abort 出口可达）；**pid 已死 → 判定原 run 已死，接管放行**（Gate B S2 实证：CLI 本地 kill -9 时宿主与引擎同死，state 文件必然 stale 在 running，且 daemon 未运行时 abort 出口 ENOENT 死锁——进程死亡使 state 必然过期）。**降级通道**：引擎 state 文件不存在/解析失败时 `process.kill(state.pid, 0)`，ESRCH → 放行并 log 标注降级；存活 → fail-fast，error 指引带人工出口（「`ps -p <pid> -o command=` 核实非本 run 进程（pid 复用）后，终止之或手工编辑 state 清除 pid 字段重试」） | 「原 run 仍在进行（engineRunId / pid）；如需接管请先 abort 原 run」。⛔实施期探针 P5：验证引擎 state 文件路径与终态字段格式（引擎内部契约，版本耦合）。**被否谱系**：①单一 pid 守卫——被 daemon 形态击穿（daemon 常驻 pid 在 run 结束后仍存活，resume 被系统性误挡死锁）；②主通道 running 即无条件拦截——被 CLI 本地 kill -9 场景击穿（stale running + abort 不可达死锁），收敛为上述 pid 裁决语义 |
| 工作区干净 | `git status --porcelain` 为空（脚本自持 `.review/` 目录结构性排除，不依赖目标仓 gitignore）。本守卫是 resume 入口防线；run 内另有三个结构性时点：preflight（§3.3）、gate 修复子循环每轮 agent 返回后（§3.5）、final-gates 收尾前（§3.3）。**全 done 幂等回放场景不适用本守卫**（walker 第 6 条分流先于本守卫，回放零 git 副作用，脏工作区不进 commit/push） | 非空 → fail-fast：「存在未提交改动。若为中断残留（cr-fix/simplify 的半成品），人工检查后经 `git add <显式路径> && git commit` 落盘或 `git checkout --` 还原后 resume」。依据：coverage-gate 要求干净工作区（SKILL 明文），脏工作区会污染插桩口径；simplify/fix 的中断窗口是分钟级，守卫是主防线 |
| HEAD 外部变更 | 当前 HEAD ≠ state.lastHead 且 state.status ≠ "failed" | 需显式 `allowExternalChanges:true` 放行（walker 会从断点 step 重跑，新 commit 自然进入检查范围）；不加参数则 fail-fast。status=failed 时外部 commit 是**预期恢复动作**（用户手工修完再 resume），直接放行。**全 done 场景不适用本守卫**，走 walker 第 6 条空转防护——此时加参数也会被拦，报错文案直接预告「请起新 run」避免指引链兜圈。**被否谱系**：「allowExternalChanges 无条件放行」——被「全 done + 外部 commit 秒回旧绿标」反例击穿（新 commit 未过任何 gate 却被误认为已复验） |

**(5) step 幂等性设计表**（恢复安全性的依据，逐条落实为实现要求）

| step | 重跑语义 | 幂等依据 |
|---|---|---|
| static-gate / coverage-1 / metrics-1 / final-gates | 纯检查重跑；修复子循环的 commit 已进 git 历史，重跑检查面对的是新代码 | gate 脚本无副作用（只写 .review/*.json 与 marker） |
| changeset | 重跑时 agent 先查 `.changeset/` 现状，已补齐则报 skipped | 判定基于文件系统现状 |
| pr-meta | 重新生成并覆盖 pr-title.txt/pr-body.md | 产物是 runId 目录内文件 |
| pr-submit | pr-submit.sh 自身幂等（检测 PR 已存在则仅在有变化时更新） | 脚本原生语义（⛔实施期探针 P3 实测） |
| skill-yaml | 纯校验重跑 | 无副作用 |
| constraints | 重新生成 constraints.md | 产物覆盖写 |
| cr-fix | loop 整体重跑（见上 (3)-5） | fix commit 在 git 历史；review 面向当前 diff |
| simplify | agent 面对当前 diff 重新评估；已应用的简化不会再被报出 | 同 cr-fix；commit 分离保证可审 |

**(6) 物理数据流图**

```text
pr-lifecycle.js（zsw worker 线程内，CJS，无沙箱）
 ├─ require('node:child_process') ── bash scripts/pr-pre-merge.sh / pr-submit.sh
 │                                  python3 coverage-gate.py / metrics-gate.py / validate-skill-yaml.py
 │                                  node scripts/select-constraints.mjs
 │                                  （exit code 判定；.review/*.json 读 verdict）
 ├─ agent({prompt, schema?}) ────── zsw 主线程 → pi rpc 子进程（pr-meta / changeset / gate 修复 / simplify）
 ├─ workflow("review-fix-loop",…) ── 引擎内置 loop（自带台账 + saveState 到 ~/.review-fix-loop/<slug>/<wf-id>/）
 └─ require('node:fs') ──────────── .review/pr-workflow/<runId>/state.json（原子写）
                                    .review/pr-workflow/latest（指针）
                                    ~/.zcode/zsw/workflow-state/<engineRunId>.jsonl（只读，活性守卫主通道）
主 agent ◄── 终态通知 / CLI 输出（scriptResult.json：status/runId/failedStep/resumeCommand/prUrl）
主 agent ◄── 兜底：cat .review/pr-workflow/latest
```

### 3.5 各 step 设计要点（实现层契约摘要）

- **child_process 封装**：统一 `sh(cmd, args, {cwd: repoRoot})`；`execFileSync` 必须显式 `maxBuffer`（≥64MB）——coverage-gate 跑全量插桩测试输出量大，默认 1MB 会直接炸（⛔实施期探针 P4）；python3/bash/node 一律用绝对命令名 + 参数数组，不经过 shell 字符串拼接。
- **agent() 调用纪律**：全部带 `returnMeta: true` 并检查 `error`（core 引擎 agent 失败不 reject，只能经 meta 观测）；review/fix 类 agent 的 `timeoutMs` 对齐内置 loop 实践（review 1h；fix 不设超时）；**agent() 调用顺序必须确定**（walker 顺序固定），保证引擎崩溃重试的 callId 回放安全。
- **pr-meta 的 schema**：`{title: string, body: string}`，prompt 内嵌 conventional commit 规则与 PR body 三节模板（Summary/Changes/Test plan），输入为 `git log <baseHash>..HEAD --format="%s%n%b---"` + `git diff <baseHash>..HEAD --stat` 全文。
- **gate 修复子循环统一骨架**：`for attempt in 1..3 { verdict = run_gate(); if pass break; agent(fixPrompt(verdict 详情)); } 仍败 → step failed`。fixPrompt 要求 agent 修完自行 commit（确定性步骤的修复 commit 与 cr-fix 的 fix commit 区分 message：`fix: gate <step-id> round N`）。**脚本侧结构性验证**：每轮子循环 agent 返回后立即 `git status --porcelain`，**非空即 step failed**（第 1 次止损，不烧后续轮次 token）——脚本不自动 commit（不判断改动归属，对齐全局「认知外改动不擅自处理」），failed 指引「人工检查改动 → 显式路径 commit → resume」（resume 后该 step 重跑，gate 面对已 commit 的改动正常判定）。被否谱系：「脏则下轮 fixPrompt 提醒 commit」——被两个洞击穿：gate 提前 pass 路径上提醒丢失（脏状态穿透到 final-gates 才被拦，期间插桩读数违反 Gate-1.6 干净工作区前提）；agent 连续不 commit 时 3 轮全在脏状态空烧。
- **参数合并语义**：`@pi-meta parameters` 声明全部脚本级可覆盖项（`runId` / `repo` / `base` / `reviewers` / `maxRounds` / `aggregatorModel` / `simplifyMode` / `skipSteps` / `allowExternalChanges`，共 9 项）+ `task`（zsw CLI 必填 flag，引擎存入 run spec 供通知与查询展示，脚本不消费其语义）；发起值覆盖脚本默认值。schema 声明 `additionalProperties: false`，未声明参数被 AJV 拒绝（fail-fast 含修正指引）——**该拒绝由 schema 显式声明实现**（引擎 AJV 原生仅编译 schema，无此声明时未声明参数被静默忽略）；脚本消费面另由 normalizeParams 白名单二次收口（九项之外不进 state.params）。注意两层参数分界：`timeoutMs` / `workdir` / `model` / `wait` 是引擎级参数（RUN_ENVELOPE_KEYS，不进 `$ARGS`），脚本内不重复声明。
- **cr-fix 的 batch1 组装**：默认扫 `.agents/skills/pr-cr-fix/agents/review-*.md` 排序得 8 个绝对路径，逗号拼接；参数 `reviewers`（数组或逗号串）为白名单交集裁剪。**维度排除判定归主 agent 发起时决定**（按 SKILL 路径匹配排除表裁剪 `reviewers` 后传入，宁可多派不漏派），脚本内不做 diff 语义判断——与 SKILL「默认全集、显式裁剪」现行语义一致，避免脚本内隐式裁剪不可审计。

### 3.6 关键决策与权衡

- **D1 引擎契约：写 core 契约（`@pi-meta` + 顶层 `agent()`），不写 1.0.0 的 `run(ctx)`**。证据：zsw main worktree 已 vendored subagent-core（与 pi 同引擎），1.0.0 是退役中的旧契约；pr-review-fix.js 在 1.2.0 下本来就跑不起来，迁移不可避免；core 契约带来 AJV 参数校验、结构化 lint、崩溃重试 + callId 回放。代价：依赖 zsw ≥1.2.0 实装（当前 cache 是 1.0.0），列为 §5 拆分 1 的阻塞前置。被否：双形态适配层（一个脚本兼容两代）——双轨复杂度常驻，违反一致性原则。
- **D2 cr-fix loop 不 copy，嵌套内置 `review-fix-loop`**。证据：§2.1-b 的漂移表——移植版已落后原版一整代能力（台账/converged/needs-redesign/aggregator），copy 等于给漂移续命；嵌套后 pi/zcode 路径 1/2 在 loop 层面同源。代价：恢复粒度从「轮次级」降为「step 级」（§3.4-(3)-5 已论证可接受）。被否：①copy 移植版加 checkpoint（永久 fork + 无台账）；②copy 内置 1606 行改造（维护噩梦）。**⛔实施期门**：嵌套 `workflow("review-fix-loop", {batch1: ...})` 在 zsw 1.2.0 实装环境真实派发 8 个 review agent 需先行探针验证（P1/P2），不通过则降级方案 = 把移植版 loop 按 core 契约重写内嵌（保留 D2 的其余部分不变）。
- **D3 runId 由脚本创建（非主 agent 传入）**，创建时机 = fresh run 第一动作，通道 = 终态 JSON + latest 指针 + log 首行三条（§3.4-(1)）。被否：主 agent 生成传入——与「不传 runId = fresh」的用户语义冲突（fresh 时主 agent 同样需要一个 id 来引用本次 run，让脚本创建并回传是唯一自洽方案）。
- **D4 恢复最小单位 = step，cr-fix 内部不重开轮次**。见 §3.4-(3)。被否：轮次级 checkpoint（需要 fork loop，D2 已否）。
- **D5 PR 阶段的脚本化边界**：确定性动作（gates、submit、constraints、yaml 校验）一律 `child_process`，不包 agent；LLM 动作收敛为 3 个 agent()（pr-meta / changeset / gate 修复）。「能脚本化的前置做好」落实为：主 agent 发起前零前置劳动，全部前置检查在脚本 `preflight` 内完成并给出可操作报错。
- **D6 code-simplify 无人值守模式：默认 `simplifyMode: "apply"`——prompt 显式授权 agent 直接应用「高置信 + 行为不变（A 档）」发现，每项改动后跑相关测试，全部完成后独立 commit（`refactor: code-simplify — N 项`，单 commit 保证可审可 revert）；B 档（行为敏感）与低置信项只进报告不落地**。这是对 code-simplify skill「先报告等确认」[MANDATORY] 断点的**显式偏离**，偏离的指令冲突必须被结构性消解而不是叠床架屋：
  1. **冲突根因**：skill 的确认断点同时写在 SKILL.md 与 references/workflow.md 步骤 4-5，若让 agent 必读原文再叠加授权指令，agent 面对两组矛盾 [MANDATORY] 行为不可预测（守断点则 G4 失效，守授权则违规）。**被否谱系**：必读原文 + prompt 叠加授权——被「两组矛盾指令」击穿。
  2. **消解方式**：新建固化契约 `agents/simplify-apply.md`（放 pr-cr-fix skill 目录，与其他 review agent 同管理方式）——摘录 skill 的三条铁律（先理解再改 / 行为严格不变 / 降认知复杂度）、范围收敛与定范围条款（SKILL.md「范围收敛」节与 workflow.md 步骤 1）、A-B 档定义（perf-signals.md）与报告格式契约（workflow.md 步骤 3-4），**顶部显式声明覆盖关系**（「本 agent 由 pr-lifecycle workflow 以 simplifyMode=apply 发起，skill 的确认断点在本上下文视为已获用户授权，授权范围仅 A 档高置信项；B 档与低置信项只产报告」）。references 的信号清单文件（review-signals.md / perf-signals.md / scaling.md）可作为审查参考保留在阅读清单，冲突条款以 simplify-apply.md 为准。**漂移防护**：simplify-apply.md 顶部锚定每个摘录条款的源文件 + 节名（引用式摘录，冲突条款才内联全文）；「code-simplify skill 更新后核对本文件」写入本文件头部的维护义务；验收场景 6 含摘录-源一致性人工核对项。
  3. **知情环节**：SKILL 路径 2 重写时规定主 agent 发起前必须向用户说明 simplifyMode 默认 apply 的行为含义（自动改码发生在 push 授权之前）；终态 scriptResult 的 `simplify` 字段披露 applied/proposals 计数。
  4. 参数 `simplifyMode: "report"` 可退回纯报告模式（完全不改码，断点语义完整保留）。
  被否：①严格守 skill 断点（流程卡在半路，违背 G1）；②无限制授权（B 档行为风险无人把守）；③中断窗口靠 simplify 逐项 commit 缩小（牺牲单 commit 可审性；选中方案用 §3.4-(4) 工作区干净守卫兜底中断场景）。
- **D7 push 边界不动**：脚本内唯一的 push 是 `pr-submit` 的首次推送（建 PR 的流程内行为，与现 SKILL 一致）；终局 3b push 永远留在脚本外，主 agent 获用户授权后执行。`awaiting-push` 是脚本唯一的成功终态。3b 命令恒为 `git push github HEAD:<branch> --force-with-lease`——与 pr-submit.sh 的现有行为同构（其 push 无条件带 --force-with-lease），SKILL 关键约束 4 的 force_push 判定链在新流程退化为常量真，SKILL 重写时同步简化。
- **D8 gate 失败的有界修复子循环（≤3 轮）内建于各 gate step**（对齐 SKILL 的 Gate-1.5/1.6 上限语义），超限 failed + resumeCommand。被否：失败后直接退出等人工（夜间托管场景下小问题（如 lint）会无谓中断全流程）。
- **D9 旧 `pr-review-fix.js` 删除而非并存**（git 历史保留）。双形态并存 = 两份 loop 编排继续漂移，违反「冲突要表面化」。SKILL.md 路径 2 重写指向 pr-lifecycle，反模式表同步更新。

### 3.7 错误规格表（每个错误配恢复指引）

| 失败 | 脚本行为 | 恢复指引（error 字段必含） |
|---|---|---|
| preflight：分支相对 base 无 commits / gh 未认证 / fallow 缺失 / 工作区脏 | failed | 逐条给出修复命令（`gh auth login` / `npm i -g fallow` / commit 或 stash 后重跑） |
| resume：state 不存在 / 版本不符 | fail-fast | 「runId 无效；从头执行请去掉 runId 参数」 |
| resume：分支/repo 不匹配 | fail-fast | 「runId 属于分支 X；切回或起新 run」 |
| resume / fresh：原 run 仍在进行（引擎 state running / 降级 pid 存活） | fail-fast | 「run 仍在进行（engineRunId / pid N）；接管请先 abort 原 run；pid 复用嫌疑时 `ps -p <pid> -o command=` 核实」 |
| resume：工作区脏 | fail-fast | 「未提交改动清单 + commit（显式路径）或 checkout 还原后 resume」 |
| resume：HEAD 外部变更且非 failed 状态 | fail-fast | 「确认外部改动后加 allowExternalChanges:true，或起新 run」 |
| resume：全 step done 但 HEAD 已变 | fail-fast | 「本 run 已完成；新 commit 未过门禁，请不传 runId 起新 run（allowExternalChanges 在此场景无效）」 |
| static-gate / coverage / metrics / final-gates 子循环 3 轮不过（含 fix agent 未 commit 致工作区脏） | failed | 失败步骤输出摘要 + 「人工修复 commit 后用 resumeCommand 续跑」 |
| gate 脚本 exit 2（工具错误） | failed，不自动重试 | 按脚本输出指引（多为配置漂移/记账不闭合，需人看） |
| final-gates：real-pi 凭证缺失或输出检出 real-pi skip | failed | 「补 pi 凭证（~/.pi 三源探测）后 resume；不得凭 skip 宣布 PASS」 |
| final-gates 收尾：工作区脏 | failed | 「存在未提交改动，修复可能静默丢失；commit 后 resume」 |
| pr-submit：exit 2（git push 失败） | failed | 「检查远端连通性/分支保护后 resume（PR 已建时重跑幂等更新）」 |
| pr-submit：exit 3（gh 已认证但调用失败） | failed | 「查 `gh auth status` / API 限流后 resume」 |
| pr-submit：exit 5（title/body 文件缺失） | failed | 「pr-meta 产物异常：检查 runId 目录下 pr-title.txt/pr-body.md，resume 重跑」 |
| cr-fix：review-failure/aggregator-failure/fix-failure | 自动重试 1 次 nested 调用，再败 failed | 「环境问题；检查后 resume」 |
| cr-fix：stuck / max-rounds / needs-redesign | failed | 「读 <aggregated.md 路径>：误报 → resumeCommand + skipSteps:["cr-fix"]；真问题 → 修复 commit 后 resume」 |
| simplify：agent 失败 / 测试跑红且无法回滚 | failed（agent 被要求每项改动自带验证+失败回滚） | 「查看 runId 目录 simplify 报告后 resume 或 skipSteps:["simplify"]」 |

## 4. 验收（真实场景，非单测/mock）

> 前置：zsw 1.2.0 调用面可用（§5 拆分 1 完成），探针 P1-P6 全绿。所有场景在真实 GitHub 远端（`github` remote）与真实 pi 模型凭证下执行。

- **场景 1：端到端真实 PR（回溯 G1/G5）**。取下一个真实 feature 分支（含 extensions + renderer 混合改动），主 agent 仅发起一次 run。通过标准：主 agent 全程无中间编排动作；终态 `awaiting-push` 且 `skippedSteps` 为空；PR 页面可见 title/body 符合规范；`.review/` 下 coverage.json / metrics.json / premerge-result 全绿；cr-fix 的 fix commit（`fix: review batch 1 round N — ...` 内置版格式）与 simplify commit（`refactor: code-simplify — N 项`）按序存在于 `git log`；final-gates 的 test:runtime 输出无 real-pi skip。
- **场景 2：cr-fix 中途中断恢复（回溯 G2）**。真实 diff 跑到 cr-fix 第二轮时中断：CLI 一次性进程形态用 `kill -9` 宿主进程；daemon 形态下 run 存活于 daemon，改为先 `zflow abort` 再 resume（形态判定以 §5 待验证②探针结论为准）。通过标准：①`cat .review/pr-workflow/latest` 能拿到 runId；② 若中断留下脏工作区（cr-fix agent 在途改动未 commit），resume 先撞工作区干净守卫 fail-fast——按指引人工 commit/还原后再 resume 才续跑（该处置步是验收的一部分，不是可跳过噪音）；③ 续跑后 static-gate…constraints 全部跳过（无重复 commit、PR 未被重复创建）；④ cr-fix 重跑并在 2 轮内收敛（已 fix 的问题不再出现）；⑤ 终态 awaiting-push。
- **场景 3：gate 失败 → 人工修复 → resume（回溯 G2 + 守卫语义）**。构造覆盖率不足的真实分支（新逻辑不写测试）。通过标准：coverage-1 经 3 轮补测试子循环仍不足 → failed 且 resumeCommand 可复制执行；人工补测试 commit 后 resume，从 coverage-1 续跑（HEAD 外部变更在 failed 状态下被放行）到 awaiting-push。
- **场景 4：幂等重跑 + 空转防护（回溯 G2）**。awaiting-push 状态下带 runId 再跑一次：秒级返回同一 awaiting-push 结果，`git rev-list --count` 不变，PR 无 force-update。再手工追加一个 commit 后带 runId 重跑：fail-fast，报错指引「起新 run」而非放行。
- **场景 5：分支守卫（回溯 G2 不误伤）**。切到另一分支带该 runId 发起。通过标准：fail-fast，报错文案含「属于分支 X」与正确做法。
- **场景 6：code-simplify 单轮语义（回溯 G4 + D6）**。真实 diff 内预埋一个 A 档简化点（纯函数重复计算）与一个 B 档候选（可并行化的串行 await）。通过标准：A 档被应用且有独立 `refactor: code-simplify` commit、相关测试绿；B 档只出现在 simplify 报告、代码未动；simplify 恰好执行 1 轮（state 与 git log 可证）；**人工通读 `agents/simplify-apply.md` 一次，核对其摘录条款与 code-simplify skill 源文件对应节一致**（漂移防护的首次校准）。
- **场景 7：stuck 人工接管 + 披露链（回溯 D8/逃生舱/MUST_FIX-5）**。用 `maxRounds: 1` 发起参数覆盖默认值，强制 cr-fix 以 max-rounds 终态退出。通过标准：failed 报错含 aggregated.md 路径与两条处置分支；带 `skipSteps:["cr-fix"]` resume 后流程走到 awaiting-push，且终态 scriptResult.skippedSteps 含 `{step:"cr-fix", reason:"user-ack"}`，主 agent 汇报文案逐项披露。
- **场景 8：SKILL 三路径一致性 + pi 冒烟（回溯 G3）**。SKILL.md 重写后通读路径 1/3 与反模式表：路径 1 语义未被波及；反模式表两条受影响条目均已改写——「zcode 用内置 review-fix-loop（焦点名模型）」条（理由对 1.2.0 vendored 版失效）与「zcode 有 zflow 却手工编排 review subagent（应走 script:pr-review-fix）」条（pr-review-fix.js 删除后改指 pr-lifecycle，不留悬空引用）。若 §5 待验证①成立（pi 可直接跑同脚本），在 pi 环境用同一脚本对同一测试分支冒烟一次（可只跑到 cr-fix 开始前中止验证前置链路）。
- **场景 9：多 worktree 并存（回溯守卫正确性）**。同 repo 两个 worktree（分支 A/B）各起 run：A 进行中时 B 起新 run 互不影响（`.review/` 随 worktree 隔离）；从 worktree B 带 A 的 runId resume → repo/分支守卫 fail-fast。
- **场景 10：活性守卫拦截（回溯 MUST_FIX-1 修复）**。run 进行中带同一 runId 再发起 resume。通过标准：fail-fast，报错含「仍在进行」与 abort 指引；daemon 形态下该拦截基于引擎 state 文件而非 pid（原 run abort 后再 resume 即放行，不误挡）。同 worktree 并发第二个 fresh run → 被 lockfile（`O_EXCL`）原子拦截；锁残留的接管路径（kill -9 后锁文件仍在，下一次发起经活性复查终态后删锁重建）一并验证。

## 5. 下一层拆分

| # | 单元 | 内容 | justification | 依赖 |
|---|---|---|---|---|
| 1 | 前置环境验证 | 清理 config.json 的 plugins.dirs 残留条目 + 验证 1.2.0 调用面可用 + 探针 P1（嵌套 review-fix-loop batch1 真实派发 8 agent）/ P2（自定义 runId 参数透传 $ARGS）/ P3（pr-submit.sh 幂等更新实测）/ P4（execFileSync maxBuffer 与长输出实测）/ P5（引擎 state 文件 `~/.zcode/zsw/workflow-state/<id>.jsonl` 的终态字段格式）/ P6（test:runtime 输出的 real-pi skip 标记格式） | 全部后续工作的阻塞项；探针 P1 不过则触发 D2 降级方案，必须先知道。（原 P6「pr-submit force push 判定信号」已取消——源码证实该信号不存在，pr-submit 恒 --force-with-lease，见 §3.3 pr-submit 行被否谱系） | 无 |
| 2 | state 核心 | stateVersion 1 schema + 原子写 + resume walker（含空转防护）+ 六道守卫 + skipSteps/allowExternalChanges | 其余所有 step 都挂在 walker 上，独立可验证（手工构造 state 文件驱动各恢复路径） | 1 |
| 3 | PR 阶段 steps | preflight / static-gate / changeset / pr-meta / skill-yaml / pr-submit + sh() 封装 + gate 修复子循环骨架（含轮间工作区干净验证）。注意两个 gate 脚本与 yaml 校验脚本位于 skill 目录内：`.agents/skills/pr-cr-fix/scripts/coverage-gate.py`、`metrics-gate.py`、`validate-skill-yaml.py`；仓级脚本在 `scripts/pr-pre-merge.sh`、`scripts/pr-submit.sh`、`scripts/select-constraints.mjs` | 纯确定性 + 2 个 agent prompt，可独立用「只跑到 pr-submit」的测试分支验证 | 2 |
| 4 | 门禁 steps | constraints / coverage-1 / metrics-1 / final-gates（注入值契约 + 三道联动 + real-pi 检测） | gate 脚本调用约定与有界子循环的落点 | 3 |
| 5 | cr-fix step | batch1 组装（默认扫描 + 维度裁剪）+ nested workflow 调用 + terminated 映射 + 自动重试 1 次 | 依赖探针 P1 结论 | 1, 2 |
| 6 | simplify step | 新建 `agents/simplify-apply.md` 固化契约（覆盖声明 + 引用式摘录：三条铁律 / 范围收敛 / A-B 档 / 报告格式，每条锚定源文件+节名）+ step 实现 + simplifyMode 参数 + **上游登记**：在 code-simplify SKILL.md 末尾登记一句「改动铁律/范围收敛/档位/报告格式节后须核对 xyz-agent 仓 pr-cr-fix/agents/simplify-apply.md」（下游义务单向失效，上游登记提供感知通道） | 依赖 cr-fix 终态判定；D6 的冲突消解载体；摘录-源同步义务写进文件头部 | 5 |
| 7 | 文档与退役 | pr-cr-fix SKILL.md 路径 2 重写（单 workflow 调用 + 终态映射 + push 边界：**3b 恒 --force-with-lease**（关键约束 4 判定链同步简化）+ simplifyMode 发起前披露义务 + awaiting-push 汇报必披露 skippedSteps）+ pr-review-fix.js 删除 + zflow lint 通过 + 反模式表更新两条：①「zcode 阶段 2 用内置 review-fix-loop（焦点名模型）」——「焦点名」理由基于 1.0.0 旧内置，1.2.0 vendored 版已是 agent .md 路径驱动（与 pi 路径 1 同源），旧理由失效；②「zcode 有 zflow 却手工编排 review subagent 分批（应走 script:pr-review-fix）」——pr-review-fix.js 删除后改指 pr-lifecycle，不留悬空引用 | 交付闭环；lint 是脚本入库的硬门槛 | 4, 5, 6 |

**实施期待验证清单**（设计阶段无法确定，诚实标注）：① pi 环境是否可直接跑同一脚本（路径 1/2 统一的预期收益，验收场景 8）；② 1.2.0 异步 run 的完成通知通道（mailbox 通知线已退役，主 agent 侧的等待方式以实装为准：daemon socket status / CLI `run_in_background` + 输出文件）；③ nested loop 的产物路径（aggregated.md 在其自带 runDir 下，error 指引需回传绝对路径）。

**文件改动地图**：新增 `.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js`（含 `lib.cjs`/`test/run-tests.js`，随 skill 自包含分发——u6 用户裁决移入技能目录）；新增 `.agents/skills/pr-cr-fix/agents/simplify-apply.md`；删除 `.agents/workflows/pr-review-fix.js`；修改 `.agents/skills/pr-cr-fix/SKILL.md`（路径 2 整节 + 前置条件 + 反模式表 + 目录结构节）；修改 `scripts/pr-pre-merge.sh`（新增可选 `--base <ref>` 参数，默认 main 向后兼容——final-gates ③ 必须传 `--base <base>` 与 ① coverage 同口径，见 §3.3 final-gates 行与实施计划偏差 #11；Gate B S1 实证 stacked PR 场景下硬编码 main 必 exit 2）。其余脚本（pr-submit.sh / coverage-gate.py / metrics-gate.py / validate-skill-yaml.py 等）零改动——本设计全部复用现有确定性资产。
