# tier-2-context-reuse.md 对抗式审查报告

审查对象：`docs/todo/review-fix-loop-efficiency/tier-2-context-reuse.md`（下称「文档」，行号=L）
审查依据：`rubric-design-doc.md`（P0/P1 检查项）；事实锚点经源码核实：
- `extensions/subagent-workflow/workflows/review-fix-loop.js`（主脚本，1043 行全文读）
- `extensions/subagent-workflow/workflows/review-fix-loop-utils.cjs`（utils，797 行全文读）
- `extensions/subagent-workflow/src/orchestration/worker-script-builder.ts`（workflow 沙箱 agent() 全局）
- `extensions/subagent-workflow/src/orchestration/models/types.ts`（AgentCallOpts）
- `extensions/subagent-workflow/src/orchestration/models/ports.ts`（AgentRunner port）
- `extensions/subagent-workflow/src/orchestration/agent-opts-resolver.ts`（schema → appendSystemPrompt 注入）
- `extensions/subagent-workflow/src/execution/session-runner.ts`（buildEnvBlock / appendSystemPrompt 拼装）
- `extensions/subagent-workflow/src/interface/subagent-actions.ts` + `src/execution/subagent-service.ts`（subagent tool 的 conversation/chatMode）
- pi 源码 `core/system-prompt.ts`（base system prompt 无时间戳等动态内容）

## Summary

9 must-fix, 8 suggestions (+1 INFO).

机制①（前缀稳定化）方向成立但方案与验收都没覆盖 system prompt 段的 schema 分叉；机制②（diff 指纹）的动机场景、实现候选、验收场景三者互相矛盾，且默认配置下存在「真变更被判同指纹」的漏审路径；机制③（持久会话）依赖的 conversation/message/close API 在 workflow 脚本沙箱里根本不存在，且其成本论证的前提（provider 缓存）与文档自己的假设冲突。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | L18/L162/L216（§1、§7、§11） | P0-11 事实 | **workflow 脚本沙箱没有 conversation/message/close API，机制③按现方案无法实施。** 文档声称「pi subagent 会话能力（本会话工具契约，已核实）」——核实的是 LLM 面向的 subagent **tool** 契约（subagent-actions.ts:81 conversation/chatMode），但 review-fix-loop 的 reviewer 由 workflow 脚本的 `agent()` 全局派发：`_KNOWN_FIELDS` 白名单（worker-script-builder.ts:69）仅 17 个字段，无 conversation/message/close/idleTimeoutMs；`AgentCallOpts`（models/types.ts:72-151）同样无会话字段；执行层 `AgentRunner` port 的唯一实现是 SubprocessAgentRunner（ports.ts:23 注释「Agent 子进程执行 port」），每次调用一次性 spawn。文档「✅ 已核实」（L216）核实错了层。**翻车场景**：T4 实施时 `agent({conversation:true,...})` 被白名单 warn 且字段静默丢弃，每个 R2+ 仍是新 spawn，`reviewerSessions Map` 拿到的只是一次性结果——整个 M3 卡在起点返工，§7「不动 subagent-workflow 引擎」（L157）同时破产（需要引擎层新增会话 API + 重放记录语义 + abort 时的 close 接线）。 | 二选一：(a) 把机制③重新定义为引擎改动（subagent-workflow 增 conversation 支持），§7 改动表如实列出引擎侧工作量与重放设计；(b) 把③降级为「依赖引擎前置能力的后续梯队」，本梯队只做①②。无论哪条，L216 的「已核实」必须改写为「tool 层已核实 / workflow 沙箱层不存在」 |
| MUST_FIX | L26/L122/L179（§2 目标1、§6.1、§8 S1） | P0-11 事实 | **前缀稳定化未覆盖 system prompt 段的 schema 分叉，「各轮逐字节相同」按现方案不成立。** schema 被逐字嵌入 appendSystemPrompt（agent-opts-resolver.ts:61-85，`schemaJson` 内联在指令文本中），经 `--append-system-prompt` 进入 system prompt 尾部（session-runner.ts:856-857）。而 buildReviewCall 三分支的 schema 不同：R1 `required=["report_file","must_fix","suggestion"]`，R2+ 与 scoped 均为 `[..., "reconciliation"]`（review-fix-loop.js buildReviewCall）→ R1 与 R2 的 system prompt 字节必然不同。此外 R1 与 R2+ 的 user prompt「静态段」文本本就不同（R1 是 reviewInstruction+"Review requirements"，R2+ 是对账/known-remaining/新发现三段式），跨轮共同前缀实际只剩 system 段——且还得先统一 schema。文档 L122 把「输出 schema 说明」列为静态段的一部分，与现状直接矛盾。**翻车场景**：按方案重排 user prompt 后跑 S1，dump R1/R2 发现从 system 段起就不同，目标 1 验收失败返工；或 dump 只看 workflow 侧 user prompt 误判通过，provider 侧 R1→R2 缓存仍 miss，机制①的一半收益（R1→R2 转换）静默落空。 | §6.1 增加「统一各轮 schema」工作项（如 reconciliation 全轮次必填、R1 允许空数组）；目标 1 的表述从「各轮逐字节相同」降级为「R2..Rn 逐字节相同 + R1/R2 共享 system 前缀」；S1 验收相应改写 |
| MUST_FIX | L179（§8 S1） | P0-13 验收 | **S1 的「dump R1/R2 prompt」未定义 dump 对象，不可判定。** workflow 侧 user prompt ≠ provider 见到的全量请求（pi base system prompt + env block + agent .md + schema 指令 + user prompt，见 session-runner.ts:847-869 拼装顺序）。dump 前者测不到上一条 MUST_FIX 的分叉；dump 后者需要抓子进程实际请求（文档未给方法）。且「动态段起点」在 R1 与 R2+ 是不同文本结构，跨轮次的「到动态段起点逐字节相同」语义不成立。**翻车场景**：实施完跑 S1，无论 dump 什么都无法判定机制①是否达成——验收沦为仪式。 | S1 改为：定义 dump 点（建议子进程 `--append-system-prompt` 文件全文 + user prompt 全文），断言 R2/R3 两轮全量字节共同前缀 ≥ 静态段长度；R1↔R2 只断言 system 段相同（依赖 schema 统一） |
| MUST_FIX | L60/L84/L100/L180（§3.2-B、§4、§5.1、§8 S2） | P0-10 因果 + P0-13 验收 | **指纹机制的动机场景、实现候选、验收场景三者互相矛盾：「只改注释」在任何候选实现下都会改变指纹。** sha1 整 diff：注释变更改变 diff 字节 → 指纹变 → 不跳过。`git patch-id`：只归一化空白与行号，不归一化内容行——注释文本变更同样改变 patch-id。因此 §3.2-B 的「fixer 只改了注释→diff 实质未变」（L60）、§5.1 的「Round 3: patch-id unchanged (R2 fix 只改了注释)」（L100）、S2 的通过标准「fix 轮只改注释→应出现 skip 日志」（L180）按现方案全部不成立。指纹实际只能捕获「fix 零树变更」（commit-message-only 或 fixer 空转）。**翻车场景**：按 S2 验收，注释 fix 后指纹必然变化、review 照跑，S2 永远失败；实施者为通过验收被迫改语义级指纹（AST 哈希等），反而引入真变更漏判的新风险。 | 重新定位机制②的真实价值场景：「fix agent 未产生任何文件变更」（空转检测），改写 §3.2-B 动机例子与 S2 场景（如构造 fixer 仅输出报告不改代码）；或若确要跳过注释级变更，需明确语义级指纹方案并重评漏判风险 |
| MUST_FIX | L84/L108/L129（§4、§5.2、§6.2） | P0-11 事实 + P0-12 遗漏 | **指纹数据源定义矛盾，且默认配置下「真变更被判同指纹」的漏审路径真实存在——「误少审 by construction 不可能」为假。** ① L84 散文说「工作区相对锁定 base 的 git diff」，实现候选却写「`git diff \| sha1`」——无参 `git diff` 是 index vs 工作区（仅未暂存），autoCommit=true 时 fixer 提交后恒为空 → 指纹恒定 → 后续轮全部跳过。② 即使按散文理解用 `git diff <lockedBase>`，该命令不含 untracked 文件；autoCommit=false（脚本默认，@pi-meta default: false）下 fixer 新建文件即 untracked → 指纹不变 → 跳过下轮 review → 新文件从未被审。而审阅范围明确包含未提交/未跟踪变更：buildReviewInstruction 要求 reviewer 跑 `git status --porcelain` + `git diff` 且声明「uncommitted changes ARE in scope」（utils lockReviewBase 上方函数）。指纹覆盖范围 < 审阅范围，字节级保证只在「已跟踪文件」子集内成立。**翻车场景**：默认 autoCommit=false 的 run，fixer 新建一个文件修复 must-fix，下一轮 review 被指纹跳过，该文件的 regression 直接漏出——审查系统安全性失守，比多付 token 严重得多。 | 钉死数据源：`git diff <lockedBase>` 的全量输出 + `git status --porcelain` 清单（或 `git add -A` 意图化后的 diff）合并哈希，使指纹覆盖范围 ≥ 审阅范围；删除裸 `git diff \| sha1` 候选；「by construction 不可能」的声称改为在明确定义的数据源上重新论证 |
| MUST_FIX | L100-101/L162（§5.1、§7） | P0-10 + P0-12 | **跳轮之后的循环状态机未定义，§5.1 自己的成功路径示例不自洽。** skip 之后没有新 review 结果：循环靠什么推进/终止？若 skip 视为 clean → 上轮 must-fix 未经验证即放行（安全方向错误）；若 skip 后继续 fix → 指纹不变 → 再 skip → 空转到 maxRounds 烧 token。§5.1 从「R3 skipping」直接跳到「R4 all agents clean」（L100→101），clean 的判定来源（没有 R3 review 结果）在示例里不存在。跨批交互同样未设计：state 的批级隔离（主脚本批首重置 issues/convergeStreak/knownRemaining）若不包括 lastPatchHash，batch 2 的 R1 可能被 batch 1 的指纹跳过——该批 reviewer 从未审过任何内容；与 skipCleanAgents/converged 终止的组合行为也无定义。**翻车场景**：实现者各自脑补语义，两个合理读法分别导致「未验证放行」和「死循环烧 token」，都直到真实 run 出事才暴露。 | §6.2 补充状态机定义：skip 的精确语义（建议 = 沿用上轮 review 结果进入 stuck/converged 判定，而非 clean）、skip 仅适用于「本批本轮已审过该指纹」的守卫、lastPatchHash 的批边界重置规则、skip 与 skipCleanAgents 的组合表 |
| MUST_FIX | L28/L85/L148/L162/§10 T4（§2 目标3、§4、§6.3、§7、§10） | P0-10 + P0-12 遗漏 | **「轮末锚定式轻压缩」没有实施路径，且从实现章节与任务拆分中整体遗漏。** subagent tool 的全部 action = start/message/close/list/cancel（subagent-actions.ts），无任何压缩/历史改写 API；workflow 沙箱更没有。pi 核心有 compaction（core/compaction/），但未向 subagent 会话或 workflow 暴露驱动入口。「会话历史中已落盘的中间推理可被压缩替换」（L85）需要引擎/pi 层新能力，文档只标了质量不确定性（⛔ P-compact 只问「质量保持度」），未标可行性不确定性；§7 改动表三行与 T4（「会话 Map + 增量消息 + 降级 + close 管理」）都不含压缩——目标 3（L28「轮末做锚定式轻压缩」）是无任务的承诺。**翻车场景**：M3 落地时压缩无处可挂，要么静默砍掉目标 3 的半句（上下文腐烂护栏随之消失，机制③最大风险敞口裸露），要么临时追加引擎改动，里程碑边界失控。 | 三选一并如实标注：(a) 明确压缩依赖的引擎/pi 新能力，列入§7 与新增任务项；(b) 降级为「发消息让 reviewer 自更新状态文档」（追加而非压缩，说明 token 仍单调增长，压缩收益归零、只剩质量收益）；(c) 从目标 3 删除，留到引擎能力具备后的梯队 |
| MUST_FIX | L181（§8 S3） | P0-13 验收 | **S3 单次对照「true 组总 token ≤ false 组」不科学，且与文档自设标准自相矛盾。** 单 run 噪声（模型采样随机性、轮数路径分叉、fix 时长差异）足以翻转单次 ≤ 判定；文档 §6.3 自己要求「拐点假设需在 ≥3 个真实 run 上验证后才允许考虑改默认值」（L146 附近 ⛔ P-persist），验收却用单次配对硬阈值。另外对照基线错误：false 组也应开启机制①（稳定前缀），否则 S3 测出的是「①+③ vs 裸奔」的混合效应，token 差异无法归因到会话化。**翻车场景**：单次对照因噪声得出「持久化更省/更贵」的结论并据此外推；或 true 组因①的缓存命中显得更省，③被误判为正收益而转正。 | S3 改为：≥3 个真实 PR × 两组各跑，比较 token 中位数/均值并报告方差；false 组 = ①已启用的新 spawn；通过标准改为「true 组不见显著更差 + 质量无丢失」，把「是否更省」留给 P-persist 拐点数据 |
| MUST_FIX | L106/L140（§5.2、§6.3） + §C（L8） | P0-10 因果链 + P0-4 根因 | **机制③的成本论证前提断裂：无 provider 缓存时持久会话 token 成本严格更高，「轮数少时稳赢」不成立。** provider 是无状态 HTTP API：pi 子进程 resume 会话 = 每轮把全量历史作为 input 重发，无缓存则全价重付。C_single ∝ ΣΔL_t 的前提是重叠部分按增量/缓存价计费——即前提就是缓存。无缓存时：持久会话第 N 轮 input = 全量历史 ≥ 新 spawn 的精简 R2+ prompt，成本严格更高，不存在「稳赢区间」。L106「无缓存时关闭持久会话以外的期待」方向写反（无缓存时持久会话恰恰是最差选择）；L140 风险栏「轮数少时持久化稳赢」只在有缓存时成立，未标注此前提。**翻车场景**：在缓存行为未证实的 provider（kimi-coding 等，S5 尚是探针）上开 persistentReviewers，token 不降反升；且因 S3 基线错误（上一条），数据无法归因，错误结论沉淀进默认值决策。 | §6.3 显式声明「机制③的收益以 provider 缓存为前提，与机制①共用同一底层机制」；修正 L106 句子方向；P-persist 探针前置依赖 P-cache 结论：无缓存 provider 上③直接不试点 |

## Suggestions

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | L65/L109（§3.3、§5.2） | P0-16 降级 | 「持久会话的 message 序列同样可以确定性重放」是无探针运行时断言。现有 `_callCache` 只重放一次性 agent() 结果（worker-script-builder.ts:105 初始化 / :146 写入 / :251 命中返回），message 序列重放需要引擎新增记录语义，「可以」未经任何验证。另「state.json 断点恢复语义不变」需限定：RUN_ID 只来自 `$ARGS._runId`（review-fix-loop.js 参数解析段），workflow run 一次性无 resume——不传相同 _runId 的「同参数重跑」是全新 RUN_ROOT 的全新 run，不是断点恢复。 | 断言标 ⛔ 或删除；恢复指引写明「用相同 _runId 重跑才有断点恢复，否则是全新 run」 |
| SUGGESTION | L109（§5.2） | P1-8 | 崩溃段两句并列矛盾：「按现有 review-failure 结构化终止」（= 整 run 终止，主脚本 raw.error 分支确为 saveState + terminated）与「崩溃轮降级为新 spawn 继续，功能不中断」——后者是 persistent 模式的新增行为，未说明它替代前者。 | 改写为「现状行为 X；persistent 模式新增降级行为 Y」两句式 |
| SUGGESTION | L99 vs L162/L165（§5.1 vs §7） | P1-8 | 增量消息内容不一致：§5.1 写「对账表 + R1 fix diff」，§7 表写「对账表 + fix diff」、§7 文写「对账要求 + fix 结果 + known-remaining」。fix diff 是新内容——现有 R2+ prompt 只带 fixResult JSON，代码 diff 由 reviewer 自行 `git diff` 获取（buildReviewInstruction）；大 diff 内联有膨胀风险，与「只付增量」目标自伤。 | 选定一种（建议沿用 fix 结果 JSON + reviewer 自查 diff），三处统一 |
| SUGGESTION | L122（§6.1） | P1-8 | 「跨 reviewer 缓存复用」的前提（多 reviewer 共用角色定义）在实践中近乎真空：多 reviewer 的意义就是不同维度不同 .md（system prompt 从 agent body 起分叉，公共前缀只剩 pi base + env block）。P-cache-shared 探针可留，但不应作为收益预期写入约束段。 | 删除或降级该句为「理论上存在，非收益假设」 |
| SUGGESTION | L183（§8 S5） | P1 | S5 探针生态效度不足：背靠背两轮同前缀请求即使命中（在 Anthropic 5m TTL 内），也不能预测真实 run 的跨轮命中——reviewer 超时上限 1h、fix 阶段不限时（主脚本 fix 不设 timeoutMs），真实轮间隔大概率远超 5m TTL。S5 可能给出「支持缓存」的真结论 + 「真实 run 仍 miss」的假安全感。 | S5 增加间隔阶梯（如间隔 6min 再发第二轮），或直接以真实 run 响应 usage 的 cached_tokens 为准 |
| SUGGESTION | L162/§6.2 | P0-12 降级 | 指纹机制未声明 targetType 适用范围：`computePatchHash(workspace)` 假定 git 仓库；file/dir/text 目标（文档审查是本 workflow 的真实用法，doc-reviewer 走 file target）无 git diff 语义。 | 声明机制②仅 targetType=git-diff 生效，或为 file/dir 定义内容哈希 |
| SUGGESTION | §7（L162） | P0-12 降级 | persistent 模式的 idleTimeoutMs 未设计：fix 阶段不限时，reviewer 会话在 fix 期间空闲，subagent 会话默认 idleTimeoutMs=5min 会被回收 → 每轮都走崩溃/超时降级路径，机制③退化成更贵的新 spawn。 | §7 显式设定 idleTimeoutMs ≥ 预期轮间隔上限 |
| SUGGESTION | §7（L162） | P1-8 | `reviewerSessions = Map<def.name, subagentId>` 的跨批生命周期未定义：同名 reviewer 在 batch 2 是 resume batch 1 的会话还是新 spawn？Map 键不带批次维度，两种读法行为不同（前者上下文含批 1 内容，可能有益也可能是污染）。 | 明确键设计（建议带 batchIndex）与批边界会话策略 |
| INFO | L10/L60/L148/附录 | P1-8 | 外部引用离线无法核实：arXiv 2601.12307、arXiv 2601.06007、Claude Code issue #7317、Cursor Bugbot docs、towardsai 两篇。核心成本不等式（重叠上下文重付 ≥ 增量付）算术上自立，引用仅为佐证，不影响本文裁决；建议实施前联网核实一遍链接有效性。 | 实施期核实 |

## 各维度审查结论（含「查过，无发现」）

### 任务点名的六个攻击面

1. **逐字节稳定前缀 vs system prompt**：攻击成立，见 MUST_FIX #1/#2/#3。补充核实：pi base system prompt 无时间戳（core/system-prompt.ts，仅 cwd/contextFiles/skills）；env block（cwd/depth/git branch，session-runner.ts buildEnvBlock）在 run 内稳定；schema 指令是唯一跨轮分叉点（R1 vs R2+ 的 required 不同）。**跨 reviewer 缓存复用**：不同 .md → system prompt 分叉，公共前缀仅 pi base + env block，文档的「若共用角色定义」前提近乎真空（SUGGESTION #4）。
2. **崩溃降级重建数据源**：基本成立但表述不精确。state.issues 只含 {firstSeen, severity, status, history, fixAttempts, openStreak, deferredReason}（主脚本 5.1 初始化段），不含 reviewer 工作上下文；但现有 R2+ 无状态路径本就不依赖会话内存——aggPath（aggregated.md 在磁盘）、fixResult（state.fixResults）、knownRemaining（state.knownRemaining）足以构造等价 prompt，「功能不中断」成立。「从 state.issues + 上轮报告重建」的准确说法应是 state.knownRemaining + state.fixResults + 上轮 aggregated.md。表述矛盾部分见 SUGGESTION #1/#2。
3. **diff patch-hash 数据源**：攻击成立，见 MUST_FIX #4/#5。文档未说清数据源（无参 git diff vs git diff base vs patch-id 三者并列且互相矛盾），「字节不同即指纹不同」对 patch-id 不成立（patch-id 归一化空白/行号），且任何 diff 哈希都覆盖不了 untracked 文件。
4. **锚定式轻压缩 API**：攻击成立，见 MUST_FIX #7。subagent tool 五 action 无压缩；workflow 沙箱无任何会话 API；pi 核心 compaction 未向这两层暴露。文档未诚实标注可行性不确定性（只标了质量不确定性）。
5. **现状 prompt 结构声称**：**查过，属实，无发现**。R1 prompt 头段为 header（`"Batch N Round R/max — name"`，buildReviewCall return 段）、随后 reviewInstruction + prevBatchesHint、"Review requirements:"、reviewPrompt、output 路径——与文档 §3.1 引用一致；buildR2ReviewPrompt 与 buildScopedRecheckPrompt 同样 header 在最前（utils 对应函数首元素）；runReviewAgent → agent(call) 每次新 spawn（SubprocessAgentRunner）属实；§11「已核实：现状 prompt 轮次 header 在最前（脚本源码实测）」属实。
6. **S3 对照实验设计**：攻击成立，见 MUST_FIX #8。

### rubric 全量检查项中「查过，无发现」的项

- **P0-1 五段骨架**：通过。背景目标（§1/§2）/ 现状问题（§3）/ 方案（§4-§7）/ 验收（§8）/ 下一层拆分（§10）齐全。
- **P0-2 delta 链**：通过。无「vN 参见上版/Rxx-finding」类引用；对 tier-1 文档的引用是系列背景且本文自包含要点（L16）；附录变更历史仅 v1 初版。
- **P0-3 结论先行**：通过。每章「本章结论」开头 + SCQA 开篇。
- **P0-5 使用者视角**：通过。§3.1 真实 prompt 代码、§5.1 日志形态示例。
- **P0-6 抽象术语**：通过。diff 指纹、锚定式轻压缩均有定义（L84/L85）——后者的可行性问题另列 MUST_FIX #7，定义本身存在。
- **P0-7/8/9 方案对比**：通过。§6.1/6.2/6.3 均 ≥2 方案、长期/短期双维度、明确裁决；§6.3 有被否方案的后果推演（「被否若用」段）。
- **P0-14 验收=单测/mock**：通过（形式上）。S2-S5 均为真实场景（真实 PR、真实 kill、真实 provider 探测），L184 明确「单测只作回归辅助，不计入验收」。可执行性问题另列 MUST_FIX #3/#4/#8。
- **P0-15 验收投入匹配**：通过。大改动配 5 场景。
- **P0-17 物理数据流图**：通过。§4 图标出磁盘/prompt 字节流/provider 与三个机制作用点。
- **P0-18 错误恢复指引**：基本通过（§5.2 四失败路径均有恢复动作），表述矛盾另列 SUGGESTION #1/#2。
- **P1-2 拆分 justification**：通过。§10 每个任务有 justification。
- **P1-4 alternatives 记录**：通过（§6 各表 + §6.3 被否若用）。
- **P1-5 章节 MECE**：通过。机制按风险分层无重叠。
- **P1-6 减法门检**：通过。§6.4 明确不做什么（provider 缓存 API 对接、aggregator 会话化）。
- **P1-7 scope 越层**：通过。技术方案层，下一层 = 实现任务，未直接到函数签名（除复用现有构造函数的描述，合理）。

### 判「可能不完整」的项

无。所有 P0 项均有足够证据定论（通过或不通过）。
