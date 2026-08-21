# tier-1-cheap-wins.md v6 开发就绪度对抗审查

> 审查问题：开发者能否仅凭此文档直接开工、不回头问任何问题？结论先行：**不能，但只差一层窗户纸**——1 个 blocker（验收引用了不存在的参数）+ 5 个 major（实施期必然返工的洞）。核心设计方向、绝大多数源码事实断言经核实**成立**（见文末「已核实成立」清单），不需要再一轮设计。

## Summary

6 must-fix（1 blocker + 5 major）, 9 suggestions.

## 总体裁决：**修完 blocker 后可开工**（建议同批改掉 5 个 major，否则实施期必返工）

---

## Findings

### BLOCKER

| # | 位置 | 维度 | 描述 | 证据 | 修复方向 |
|---|------|------|------|------|----------|
| B1 | §5.2 失败路径 + §8.2 S7 + S8 | P0-11 事实 / P0-13 验收不可执行 | **`evidenceGate` 参数不存在，且全文无任何任务定义它**。§5.2 恢复指引写「复活率持续偏高 → 👉 `evidenceGate=false`」；S7 验收写「`evidenceGate=false` 重跑 → 门槛关闭行为正确」；S8 又依赖 S7 凑满 3 个 run。但 6.3 明确声明「不新增裁决逻辑」，deltas 只有三个（结构化输出/dormant 落盘/R2+ 注入），不含任何开关；T1-T9 也没有创建该参数的任务。裁决目前只是 aggregator prompt 里的文本段（utils.cjs:364-375），代码侧根本没有可关的「门槛」。开发者执行到 S7 必然停下来问「evidenceGate 在哪」。 | `grep -rn "evidenceGate" workflows/ src/` 全仓零命中；6.3 deltas 列表不含开关 | 二选一：① 新增一个参数定义（名称/默认值/关掉什么——prompt 段是文本，只能靠条件拼接 prompt 跳过 adjudication 段，这本身是个新机制，与 6.3「不新增裁决逻辑」冲突，需改写 6.3）；② 删掉 §5.2/S7 中的 evidenceGate 引用，S7 改为只验非 git slug，S8 的 3 个 run 来源重新说明 |

### MAJOR（实施期会返工）

| # | 位置 | 维度 | 描述 | 证据 | 修复方向 |
|---|------|------|------|------|----------|
| M1 | §10 T9「与 T1-T8 全无依赖，可任意并行」+ §9 MP「与 M0-M2 任意并行」 | P0-12 副作用/遗漏 | **「全无依赖」在函数级不成立**。T6 的 6.3 delta ③「buildR2ReviewPrompt 注入 dormant 清单」与 T9 ②「R1/R2+/scoped 三模板静态段重构 + 动态后置」改的是**同一个函数**；T9 还要删 R2+/scoped 分支的 required spread（review-fix-loop.js:427/447），而 T6 正好在这两个 call site 加 dormant 入参（同文件同区域，423-447 行段）。T5/T7 也在 utils.cjs（buildAggregatorPrompt/normalizeAggregatorResult）。若按 MP「任意并行」派发到并行 worktree，合并冲突与「dormant 内容该进动态段」的先后语义协调必然返工。逻辑依赖确实没有，但文件级/函数级重叠真实存在，文档未声明。 | 6.3 delta ③（dormant 注入 buildR2ReviewPrompt）× 6.9 ②（同函数重构）；review-fix-loop.js:423-447 两个分支同时是 T6 和 T9 的改动点 | T9 声明「与 T5/T6/T7 同文件不同区、与 T6 同函数（buildR2ReviewPrompt），并行时注意合并顺序；dormant 清单属动态段内容」。或把 T9 排在 T6 之后串行 |
| M2 | §8.2 S9「从落盘日志/pi stdout jsonl 提取同一 reviewer 相邻两轮完整 prompt（system + user 段）」 | P0-11 事实（影响验收执行）/ P0-13 | **system 段从这两个路径提取不到**。① append-system-prompt 内容写在 `$TMPDIR/pi-subagent-XXX/prompt-<agent>.md`，runSpawn 的 finally 里删除（session-runner.ts:1325-1326 → temp-prompt.ts:51-57 cleanupTempPrompt），run 结束后盘上无此文件；② pi session jsonl 的 entry 类型只有 session/message/thinking_level_change/model_change/compaction/branch_summary/custom/label/session_info/custom_message，**无 system prompt entry**（pi-mono session-manager.ts，全文零 system 引用）；③ pi stdout jsonl 是事件流（json-event.ts：message_start/update/end + tool 事件），含 user 段但不含 system 段；④ pi base system prompt（buildSystemPrompt，agent-session.ts:1067）每次运行内存重建，从不落盘。**user 段确实可提取**（session jsonl message entry / stdout message_start），坏的是 system 段——而 T9 稳定化的核心对象（schema 指令）恰恰在 system 段。**真实存在的替代路径文档未提**：引擎自身的 run store `<sessionDir>/workflow-state/<runId>.jsonl` 逐 call 持久化了完整 `opts`（含 prompt 全文 + appendSystemPrompt 数组 + schema，jsonl-run-store.ts:136-146）。 | temp-prompt.ts:45-57；session-manager.ts entry 类型清单；json-event.ts；jsonl-run-store.ts:136-146 | S9 提取路径改为「引擎 run store workflow-state/<runId>.jsonl 的 call opts（prompt + appendSystemPrompt）+ session jsonl 交叉」；或 T9 增加「每轮把拼装后 prompt 落 RUN_ROOT」的采集动作（顺带供养 calls[].promptBytes 校验） |
| M3 | §8.2 S4「真实 run 中注入一次 agent 错误触发 worker rebuild（错误注入是流程内既定恢复路径）」 | P0-11 事实 / P0-13 | **agent 错误不会触发 rebuild**。B1 设计起 agent() 失败一律 resolve（回退 content 文本），注释明写「改为始终 resolve……把单点失败放大成整批崩溃」是**要避免**的（worker-script-builder.ts:150-156 注释）。rebuild 由 **worker 线程 uncaught error / script error** 触发（error-recovery.ts handleWorkerError:718-730 重试矩阵：workerErrorCount < MAX → 退避 + rebuildRuntime）。且真实 run 里不存在「不改代码就能让 worker/script 出错」的注入点——script 是内置固定脚本，agent 超时/子进程崩溃同样只走 resolve 容错。按字面执行 S4：注入 agent 错误 → 不触发 rebuild → 验收人误判修复无效。 | worker-script-builder.ts:150-156（B1 容错注释）；error-recovery.ts:713-730 | S4 改明注入手段：如「临时在脚本副本注入 throw（对齐 script-error→rebuild 既定恢复路径）」并声明这是受控故障注入；或拆成两步——引擎集成测试验 rebuild 后 _runId 不变 + 真实 run 只验 state 目录唯一性 |
| M4 | §7.1（透传字段 = {usage, durationMs}） vs §7.3（calls[] 含 sessionId） | P0-12 遗漏 | **calls[].sessionId 没有采集路径**。returnMeta 两个对称点现只透传 {value, sessionFile, worktreePath, error}（worker-script-builder.ts:159-166 live / 258-267 replay），§7.1 规定只扩 {usage, durationMs}——**sessionId 不在其中**。AgentResult 有 sessionId（types.ts:198-203）但到不了脚本侧。T1（引擎）按 §7.1 做完，T4（calls[]）实施时才发现缺字段 → 引擎二次改动 + 二次审查，跨任务返工。注意 S1 的通过标准不查 sessionId，这个洞不会被验收兜住，会沉默地带进交付。 | worker-script-builder.ts:159-166/258-267；types.ts:198-209；§7.1 vs §7.3 字段清单对比 | §7.1 透传字段改为 {usage, durationMs, sessionId}（sessionFile 已传，sessionId 补上零成本）；或 §7.3 calls[] 改用 sessionFile 并说明派生关系 |
| M5 | §6.2「reviewer 报告逐 issue 表增加『修复建议』必填列」 | P0-12 遗漏（任务归属） | 6.2 链条第一环「reviewer 报告加必填列」**无任务归属**：T5 的「prompt」按上下文是 aggregator prompt（§7.2 全是 aggregatorSchema）；T6 写「computeOrigin + dormant + guidance 落盘」，不含 reviewer 模板改动；T9 重构 reviewer 三模板但只字未提新增列。而改列必然要动 reviewer prompt 模板——即 T9 重构的同批文件。实施时要么 T6 越界改模板（与 T9 撞车），要么没人改、aggregator 无列可提取、guidance 字段全空，S1「issues 带 guidance」不过。 | §10 T5/T6/T9 职责描述逐字比对；6.2 三步链路 | 在 T6（或单列一项）写明「reviewer 报告模板加修复建议列，落 R1/R2+/scoped 三模板」，并标注与 T9 的模板改动需同分支或串行 |

### MINOR（可容忍，建议同批修）

| # | 位置 | 维度 | 描述 | 证据 | 修复方向 |
|---|------|------|------|------|----------|
| m1 | §1/§7.2/§11「normalizeAggregatorResult（utils.cjs:638-663）」 | P1-8 事实 | 起始行 638 准确，结束行漂移：函数实际 638-**672**（fixes_caution 块到 671，闭合 672）。不影响决策（白名单截断断言本身属实：条目只留 {id,severity}、顶层只挑已知字段 ✓） | utils.cjs:638-672 | 行号改为 638-672 |
| m2 | §1/§11「adjudication 段（utils.cjs:317-405）」 | P1-8 事实 | buildAggregatorPrompt 实际起于 **320**，ADJUDICATION 段标记在 **364**；317 无对应内容。函数区间约 320-405，断言本身属实 ✓ | utils.cjs:320/364 | 改为 320 起（或注明 adjudication 段在 364-375） |
| m3 | §6.9 ① / T9 | P1（遗漏连带改动） | T9 未声明两处机械连带：① required 统一后，R2+/scoped 分支的 `{ ...reviewerSchema, required: [...required, "reconciliation"] }` spread（review-fix-loop.js:427/447）变冗余需删除（不删则 schema 仍有两份拼装逻辑，前缀稳定目的事实达成但留死代码）；② reconciliation 的 description 文案现写「MANDATORY for R2+ rounds, optional for R1」（:218 附近），统一后文案 stale，且该文案逐字嵌进 system prompt——不改则 prompt 自相矛盾 | review-fix-loop.js:219/427/447 | T9 交付物补这两条 |
| m4 | §6.8/§7.4「scripts/rfl.mjs」 | P1（路径歧义） | extension 下**无 scripts/ 目录**；xyz-agent repo root 有 scripts/（仓库级脚本）。rfl.mjs 落哪个 scripts 未声明——放错位置影响打包与发现（extension 随 npm 分发的话 root scripts/ 进不了包） | `ls extensions/subagent-workflow/scripts/` → 不存在 | 写明绝对归属（如 `extensions/subagent-workflow/scripts/rfl.mjs`）及是否入 package.json files/bin |
| m5 | §11 P-sys「残余未知 = tools 清单稳定性（T9 快照测试覆盖）」 | P0-16 降级（探针覆盖误归因） | T9 快照测的是 **workflow 脚本层模板输出**；tools 清单在 pi base system prompt 里（子进程内 buildSystemPrompt 拼装，agent-session.ts:1058-1067），快照测试物理上看不到它。「快照测试覆盖 tools 清单稳定性」不成立。实际能覆盖它的是 S9 的真实 run 提取——但 S9 的 system 段提取路径恰是 M2 的断点，两者叠加 = 完整前缀稳定性目前没有任何可执行的守护 | agent-session.ts:1058-1067；M2 证据 | P-sys 残余未知改标「⛔ 待 S9（修正后提取路径）覆盖」；或在 T9 加一条对 tools 清单的探针记录 |
| m6 | §7.2/§7.3 scores 结构 | P1（规格洞） | scores entry 的 `round` 语义未定义：是「打分发生的轮」还是「被打分对象的轮」？（R2 聚合给 R1 的 fix 打分，entry.round = 1 还是 2？）clean 轮无聚合调用，regression-only entry 由谁创建、total 如何标缺省，§6.6 只说了 LLM 三维度缺省，没说 entry 形态 | §6.6 vs §7.2/§7.3 对照 | §7.2 补 round 语义定义 + clean 轮 entry 形态（如 round=被打分轮，LLM 维度 null） |
| m7 | §7.1/T2「run 启动路径」 | P1（遗漏入口） | 引擎 args 入口有两个：runAndWait（顶层，launcher.ts:180）与 executeNestedWorkflow（嵌套 workflow()，launcher.ts:290）。只注入顶层则嵌套 run 的 _runId 仍漂移（review-fix-loop 自身不嵌套，但引擎级修复应覆盖；且 worker rebuild 在两条路径上都发生） | launcher.ts:180/290 | T2 写明注入点覆盖两个入口（或在 workerData.args 单一 choke point 注入并指出该点位置） |
| m8 | §7.2 adjudication 字段归属 | P1（任务边界含糊） | aggregatorSchema 条目的 `adjudication` 字段出现在 §7.2（→T5 范围），但语义上属 6.3 的 dormant 机制（→T6）。两任务都可能改 aggregatorSchema 同一块，归属不清 | §7.2 vs §10 T5/T6 描述 | 明确 adjudication 字段随 T5（schema 扩展）落地、T6 只消费 |
| m9 | §7.3 phaseTimings | P1（规格洞） | `[t0,t1]` 的时间戳格式未定（ms epoch / ISO 字符串），calls[].durationMs 是 number 而 phaseTimings 是区间，CLI 现算时类型要一致 | §7.3 | 补一行格式定义 |

### INFO

- **P-cache 收益量化张力**：§11 P-cache 探明消息级缓存命中已达 97-99%，而 6.9 的收益边界（P-shared）= 同一 reviewer 跨轮。若基线命中已 97-99%，T9 的残余收益空间（1-3%？）与实现/守护成本的比例未量化说明。不阻塞——P-cache 探针的本意是验证「前缀稳定化收益前提」，但建议补一句「当前 miss 集中在跨轮 respawn 的哪一段前缀」，否则 M 完成后无法回答「T9 到底省了多少」。（对应 6.7 eval：calls[] 的 cacheRead 占比按轮次拆开即可回答，数据链已具备。）

---

## 已核实成立的关键断言（抽查通过，不再是风险点）

| 断言 | 核实结果 |
|---|---|
| AgentResult 含 usage 七字段 + durationMs + sessionId/sessionFile | ✅ types.ts:182-227（AgentUsage 156-164：input/output/cacheRead/cacheWrite/cost/contextTokens/turns） |
| returnMeta 只透传 {value, sessionFile, worktreePath, error}，两个对称点（live resolve + _callCache 重放重建） | ✅ worker-script-builder.ts:157-167 / 251-268；workflow() 嵌套走 workflow-result 分支直传、parallel() thenable 鸭辨不重建——「无第三路径」成立 |
| 引擎生产路径不注入 _runId（仅 worker 模板读取 + 测试显式传） | ✅ 全 src/ 仅 worker-script-builder.ts:379/382 读取 |
| RUN_ID 回退 `"run-"+Date.now()`，rebuild 漂移风险 | ✅ review-fix-loop.js:298 |
| normalizeAggregatorResult 白名单截断（条目只留 {id,severity}，扩展字段静默丢弃） | ✅ utils.cjs:638-672 |
| aggregator prompt 已有 adjudication 段（裁决是现实现，本设计只补落盘+复活） | ✅ utils.cjs:364-375 |
| all-clean 在聚合/reconcile 前 break；且 reconSeen/reconEscalate/reconAll 在 break **之前**已派生（:551-584），clean 轮回填的数据前提真实存在 | ✅ review-fix-loop.js:608-613 vs 733 |
| reviewerSchema.must_fix 为 number；reconciliation 现 R1 可选、R2+/scoped 经 spread 必填（T9 要消除的分叉真实存在） | ✅ review-fix-loop.js:199-222 / 427 / 447 |
| reconcileIssues 输入 {seenIds, escalateIds, round, stuckThreshold}；空 reconciliation 数组下游行为与现状一致（normalizeReviewResult 本就缺省 []） | ✅ utils.cjs:523；review-fix-loop.js:733；T9 required 统一不改变下游语义 ✓ |
| env block 无逐 spawn 动态因子（cwd + depth + git branch 缓存，无时间戳/随机数） | ✅ session-runner.ts:529-572 buildEnvBlock |
| schema JSON 逐字嵌入 appendSystemPrompt | ✅ agent-opts-resolver.ts:57-84（→ --append-system-prompt 文件，session-runner.ts:847-872） |
| state.json 现仅 meta.startedAt 一个时间字段；state.fixResults/batches[].rounds/issues 结构存在 | ✅ review-fix-loop.js:333-352 / 560 / 610 |
| $TMPDIR 441 个历史 run | ✅ 实测 `ls $TMPDIR/review-fix-loop \| wc -l` = 441 |
| 梯队 2 文档 §6.1/§7/§11 引用有效 | ✅ tier-2-context-reuse.md 章节齐全 |
| §9 里程碑 ↔ §10 任务 ↔ §2 目标编号映射自洽（M0=T1-T4→目标1/7；M1=T5-T6→2/3/4；M2=T7-T8→5/6；MP=T9→8） | ✅ 逐项比对无矛盾 |
| §2 Out-of-scope「reviewerSchema 其他破坏性变更」与 In-scope「required 统一」、与 6.6 reconciliation 维度（R1 按重复度评）互不冲突 | ✅ 文档内部一致 |

## 审查方法与边界

- 依据：task prompt 的六项审查重点 + tech-design skill 的 rubric-design-doc.md（P0/P1 编号）；严重度按 task 定义（blocker=不修不能开工 / major=实施期会返工 / minor=可容忍）。
- 事实断言全部 read 源码核实（extension 源码 + pi-mono 上游 `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`），核实结果直接引用文件:行号。
- 只审查文档的开发就绪度，不审查文档描述的代码实现的业务正确性；未修改被审文档。
