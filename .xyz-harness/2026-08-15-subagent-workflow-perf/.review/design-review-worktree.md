# worktree-git-async-design.md 对抗式审查报告

审查对象：`.xyz-harness/2026-08-15-subagent-workflow-perf/worktree-git-async-design.md`
审查依据：`rubric-design-doc.md`（P0-1~P0-18 / P1-1~P1-8）+ 项目 AGENTS.md 约定
源码核实范围：`extensions/subagent-workflow/src/` 下 worktree-manager.ts / subagent-service.ts / finalize-record.ts / session-runner.ts / index.ts / worktree-registry.ts / best-effort.ts + 5 个测试文件；另在本机（Node v24.11.1、git 2.52.0）复跑了 P-errshape/P-errtimeout 探针。

## Summary

3 must-fix, 4 suggestions.

总体：文档事实质量极高——抽查约 30 处行号/API/数量引用（如 `worktree-manager.ts:273-287` gitRun、`:37` 30s 超时、11 处 git 调用计数、`subagent-service.ts:1421` CAS、`:1534-1540` cancelBackground cleanup、测试 mock 行号）全部与源码一致；P-errshape 探针断言在本机完整复现（`execFile` 的 `err.stderr` 确为 undefined、`err.code` 为数字 128、超时 `killed:true`+`SIGTERM`；`execFileSync` 的 `e.code` undefined、`e.status`=128）；git 2.52.0 属实。结构与方案对比（P0-1/2/3/7/8/9）、根因因果（P0-4/10）、术语定义（P0-6）、探针诚实性（P0-16，⛔实施期门标注分明）均通过。问题集中在三处：验收场景 1 的核心判据选错了观测点（测不到主进程冻结）、per-repo mutex 未定义前驱失败错误语义（字面实现会级联失败）、Phase 1/2 拆分存在过渡期自洽矛盾（gitRun 在 Phase 1 不能删）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.2 场景 1 / §4.3 / §3.7 P-block | P0-14 验收 | **验收判据观测点错位：B 的 session jsonl 时间戳测不到主进程冻结。** 判据写「读 B 的 session jsonl 逐 entry 时间戳，相邻间隔无 >500ms 空洞」来证明「主进程事件循环不被阻塞」。但 B 的 session jsonl 由 B 子进程独立写入——`buildSpawnArgs` 以 `--session-dir` 把 sessions 目录传给子进程（`session-runner.ts:572`），子进程是独立进程独立事件循环。主进程 `execFileSync` 冻结期间，子进程照常跑 LLM/bash/写 jsonl；只有 stdout 管道（~64KB 缓冲）写满才会反压子进程，而 B 每 0.2s 一条小 JSON 行，A 的 1-3s 冻结窗口仅堆积十几 KB，不会满。**结论：改造前后 B 的 jsonl 时间戳都可能连续，该判据测不出差异**；§4.3 对照基线与 P-block 探针建立在同一判据上，一并失效。附带两个连带问题：(a) 判据若「碰巧」出现空洞，是因为 B 的 bash 工具审批经主进程 RPC 往返（`mirrorMainProcessFlags` 镜像主进程 approve，测试环境不显式加 `--approve` 时），测的是审批链路而非事件循环，噪声源未声明；(b) B 的任务构造（每 0.2s 一条 entry）不可行——一次 `bash` 循环 tool call 只产生 1 个 assistant + 1 个 toolResult entry，要 0.2s 粒度 entry 需上百次独立 LLM tool call，LLM 不会这样跑。 | 观测点移到主进程侧任一确定信号：(1) `PI_EXT_DEBUG=1` 主进程日志中 B 的 stdout pump（`session-runner.ts:1015`）处理事件的时间戳连续性；(2) streamSink/TUI widget 渲染或 statusline 周期刷新时间戳（主进程 timer，冻结即停）；(3) 或构造 B 的输出链路强制经主进程往返并显式声明该依赖 + 固定 `--approve`。同时重设计 B 的任务（如 chatMode 轮次或逐条独立 tool call）并声明其可行性 |
| MUST_FIX | §3.3 设计点 4 / §5 T1 / §3.7 P-mutex | P0-12 副作用遗漏 | **per-repo mutex 未定义前驱失败的错误语义，字面实现导致同 repo 队列级联失败或静默卡死。** 设计写「`Map<repo, Promise>` 链式串行，后来的写命令 `await` 前一个的 Promise 尾部」。按字面实现（`prev.then(run)` 或 `await prev` 后再 run）：第一个写命令失败（git 报错 / 30s 超时 SIGTERM）后，该 repo 队列中所有后续写命令要么因前驱 rejected 被 `.then` 跳过而**静默不执行**（链断裂 + unhandled rejection），要么逐个 reject（**错误级联**——7 个无关命令报同一个前驱错误）。具体危害：wave 中 1 个 `worktree add` 失败会传染后续 7 个 create；一次 `worktree remove` 失败后该 repo 所有 cleanup 的 `branch -D` 全部被跳过 → worktree 批量泄漏。原 `execFileSync` 各命令独立失败互不影响，这是行为回归。P-mutex 单测只断言「串行 + 无饥饿」，缺「前驱失败不传染后继」断言。 | 设计点 4 补一句错误语义：链实现必须吞掉前驱 rejection（如 `chain.set(repo, run.catch(() => {}))` 或 `prev.catch(noop).then(run)` 模式），后继命令只关心自己是否已排队、不继承前驱错误；P-mutex 探针单测增加「前驱失败后后继正常执行」断言 |
| MUST_FIX | §5 T1 vs T2/T11 | P0-12 两期边界 | **Phase 1 排期与 T1 措辞矛盾：gitRun 在 Phase 1 不能被替换删除。** T1（P1 期）措辞「`gitRun` → `gitRunAsync`」是替换语义，但 create 的 5 处 gitRun 调用（`worktree-manager.ts:63/82/115/120` + assertCleanTree `:293`）要到 T2（P2 期）才 async 化，buildEnvBlock 的 `execFileSync`（T11）也是 P2。Phase 1 期间同步 `gitRun` 必须继续存在——否则 create 编译不过。这正是 §1 目标 3「不留隐性双轨 API」所反对的形态，但作为过渡态不可避免；文档未声明「过渡期 gitRun/gitRunAsync 显式双轨 + gitRun 在 Phase 2 哪个任务删除」，实现者按 T1 字面执行会在 Phase 1 卡住或擅自提前改 create。 | T1 改述为「新增 `gitRunAsync`，`gitRun` 保留供 Phase 1 未改造的 create/buildEnvBlock 使用」；在 T2 或独立收尾任务中写明 gitRun 的删除点（Phase 2 完成后），使「终态无双轨」有明确的落地动作 |
| SUGGESTION | §3.5 / §5 Phase 划分依据 | P1-5 表述精度 | 「Phase 1 无新竞态」表述过强。T10 把 reaper `scan()` async 化后，scan 的逐孤儿 await 窗口内 cancel/dispose 的 fire-and-forget cleanup（T7/T8）可插入——改造前两者都是主进程同步段、天然互斥，改造后存在 reaper × cleanup 并发清理同一 worktree 的交错窗口。实际无害（`cleanupOrphan` 三步各自 best-effort 吞错 + `registry.remove` 幂等，`index.ts:404-411` 还有外层 catch），但文档应把该窗口及「为何无害」写明，避免实施者或后续审查者意外。 | §3.5 补一句：Phase 1 打开 reaper × fire-and-forget cleanup 的并发交错，靠 cleanup 幂等 + best-effort 兜底，无正确性影响；「无新竞态」改述为「无正确性影响的新并发窗口」 |
| SUGGESTION | §5 T5/T6 | P0-12 边缘（不影响架构，影响对外语义） | 守卫触发分支的对外语义未完整定义。T5 写「返回 `buildEarlyFailedHandle`」但未说明 handle details 中 status/closedReason 的形态（cancel 抢先场景应为 cancelled 而非 failed）；T6 只写「同 T5（失败 throw 语义不变）」——守卫触发时 executeAndAwait 是 throw cancelled 错误，还是对齐 runAndFinalize CAS 失败路径返回已跑完的 result？两种选择下 wave 聚合（SAR.run catch 转 `AgentResult.error`）对 cancelled action 的呈现不同。 | T5/T6 各补一句守卫分支的返回/抛出形态与 closedReason 取值，明确与「create 本身失败」路径的区别 |
| SUGGESTION | §5 T5 | P1-8 实现约束 | 守卫的正确性隐式依赖「`record.worktreeHandle` 赋值 → 终态检查 → `kickOffBackground`」在同一同步段（无 await 间隙）完成。若实现者中途插入 await（日志、指标上报），检查与 kickOff 之间 cancel 可插入——后果虽只是子进程白跑（handle 已赋值，cancelBackground 能正常清理，不泄漏），但守卫不变量被无声破坏。 | T5 补实现约束：「赋值→检查→kickOff 必须同一同步段完成，中间禁止 await」，并把该约束写入 cancel-during-create 单测注释 |
| SUGGESTION | §3.3 设计点 5 / §3.7 P-ffcleanup | P1-8 可观测性 | fire-and-forget cleanup 的 `.catch(err => bestEffort(err, ...))` 走 `bestEffort` 默认 **debug** 级（`best-effort.ts:30`），生产日志级别（info+）下不可见。与现状一致（cleanup 内部三步本就是 debug 级 best-effort，且 `worktree-manager.ts:146-164` 已逐段吞错、外层 catch 几乎不触发），非新问题；但 P-ffcleanup 探针声称「失败可观测」，其验证依赖 debug 日志开启，探针方法应声明这一前提。 | P-ffcleanup 探针描述补前提：「失败经 debug 级日志留痕，验证时需 debug 日志可见」；或将 fire-and-forget 外层 catch 的 bestEffort 显式提为 error 级 |

## 逐项判定汇总（P0/P1 清单）

| 项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | 背景/现状/方案/验收/拆分五段俱全，§2.0 使用者视角、§3.7 探针清单、§5 逐任务 justification 齐备 |
| P0-2 delta 链 | 通过 | 无「vN」「Rxx」「参见上版」引用，自包含 |
| P0-3 结论先行 | 通过 | SCQA 开篇 + 每章首句「结论：」（§1/§2/§3/§4/§5） |
| P0-4 问题定义/根因 | 通过 | 根因明确「不是 git 慢而是同步等 git」（§2.0），有 wave 真实例子与事件循环物理时序图（§2.2） |
| P0-5 重实现轻体验 | 通过 | §2.0/§3.1 使用者视角先行，§3.4/§3.5 有「若用它例子会怎样」推演 |
| P0-6 术语定义 | 通过 | 临界区/CAS 抢锁/fire-and-forget/per-repo mutex/脏树均有定义+例子（§2.0/§3.3） |
| P0-7 方案对比 ≥2 | 通过 | A/B/C 三方案 |
| P0-8 长期+短期双维 | 通过 | §3.2 总表两维度+风险+裁决；各方案详述均含长期合理性论证与短期成本 |
| P0-9 明确推荐 | 通过 | 方案 A 推荐 + B 否决理由逐条 + C 定位为 Phase 1 |
| P0-10 解决根因 | 通过 | async 化直接消除「同步等 git」，因果链直打 §2.0 根因；不越界改 git 耗时（out-of-scope 声明） |
| P0-11 关键事实错误 | 通过 | 抽查 ~30 处行号/API/计数全部与源码一致（含 `:1421` CAS、`:1534-1540`、`registry.ts:14-18/153-154`、测试 mock 行号）；探针断言本机复现成立（execFile `err.stderr`===undefined、`err.code`===128、SIGTERM；git 2.52.0） |
| P0-12 副作用/遗漏 | 不通过（3 处） | mutex 错误语义缺失（级联失败）；Phase 1 gitRun 不能删的过渡矛盾；另 2 处降级为 SUGGESTION（守卫对外语义、Phase 1 表述精度）。守卫本身的插入窗口分析经源码核实覆盖完整：cancel 与 disposeAllRecords 均先 CAS（`subagent-service.ts:1514/417`）转终态，守卫检查终态即可兜住 create-await 窗口；`cleanup` 内部三步 best-effort 不外抛（`worktree-manager.ts:146-164`），「守卫后 cleanup 失败」无外抛路径 |
| P0-13 验收 testable | 通过（有保留） | 验收存在、场景 testable、逐场景标注回溯 §1 目标；但场景 1 判据有效性见 P0-14 |
| P0-14 验收=mock/抽象断言 | 不通过（1 处） | 场景 1 判据观测点错位（子进程侧 jsonl 测不到主进程冻结），证据链断裂——详见 Findings #1。其余场景（2/3 主进程 timer/stdin、功能回归 1-6 具体命令级断言、§4.3 对照基线框架）质量高 |
| P0-15 验收投入匹配 | 通过 | 两期各留证、三层验收（单测/实测/基线对比），与改动量匹配 |
| P0-16 运行时断言探针 | 通过 | §3.7 探针清单 ✅/⛔ 分明，未实测的（P-guard/P-mutex）诚实标注实施期门与归属 Phase |
| P0-17 物理数据流 | 通过 | 调用链标注文件:行号，物理位置（tmpdir、agentDir、sessions 目录）明确 |
| P0-18 错误恢复指引 | 通过 | §3.1 条 3/4、§4.2 功能回归失败恢复均给具体命令（`git worktree remove --force` 等）与 reaper 兜底路径 |
| P1-1 概念例子 | 通过 | 各抽象术语绑定最小例子 |
| P1-2 拆分 justification | 通过 | §5 逐任务「拆分理由 + 呼应验收」表 |
| P1-3 受众背景 | 通过 | 层级声明+受众假设+内部机制最小背景（§1「系统是什么」） |
| P1-4 alternatives 记录 | 通过 | §3.4 否决理由逐条、§3.6 registry 不改的三条证据、§3.7 P-lock 原断言被实测推翻并改写的记录 |
| P1-5 MECE | 可能不完整 | Phase 1 边界表述精度见 SUGGESTION #4 |
| P1-6 减法优先 | 通过 | mutex 是加机制但有独立论证（P-lock 实测后仍保留的三重理由）；C 方案作为分阶段策略而非终点 |
| P1-7 scope 越层 | 通过 | 声明「技术方案层→实现任务层」，任务到文件级+行号但不逐行设计 |
| P1-8 细节事实错误 | 通过（4 条建议） | 无影响决策的事实错误；4 条 SUGGESTION 均为语义补全/表述精度 |

## 探针抽查记录（任务要求第 7 项）

- **P-errshape/P-errtimeout（✅已测）**：本机 Node v24.11.1 复跑三路径探针，结果与文档逐项一致——`execFile` 非零退出 `err.code`=128（数字）、`err.stderr`=undefined（stderr 在 callback 第三参）、`err.killed`=false；超时 `killed:true`/`signal:"SIGTERM"`/`code:null`；`execFileSync` `e.code`=undefined、`e.status`=128、`e.stderr` 为 string；两者 message 格式同构（`"Command failed: git status --porcelain\n<stderr>"`）。论证自洽，测试条件（Node 24）与生产一致。
- **P-lock（✅已测）**：本机 git 2.52.0 与文档声明一致；「该行为无兼容性承诺、不能作为正确性依据」的自我限定已声明（旧 git/NFS/packed-refs 未测），设计未滥用该结论（mutex 保留理由改为防御+限流）。自洽。
- **P-block（⛔）**：验证方法「B 的 session jsonl 时间戳」存在观测点错位（见 Findings #1），实施期门应先修判据再留基线。
