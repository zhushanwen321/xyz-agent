# subagent-workflow-sidebar-sync 第六轮联合审查报告（R6，收敛验证轮）

> 审查对象：设计文档 `subagent-workflow-sidebar-sync-design.md`（v7）+ 开发计划 `subagent-workflow-sidebar-sync-plan.md`（联合审查）
> 前序报告：R1（`-plan-review.md`，4 MF / 10 SG）、R2（`-plan-review-r2.md`，1 MF / 10 SG / 3 INFO）、R3（`-plan-review-r3.md`，4 MF / 6 SG / 2 INFO）、R4（`-plan-review-r4.md`，2 MF / 6 SG / 4 INFO）、R5（`-plan-review-r5.md`，2 MF / 6 SG / 3 INFO）、设计 v1 审查（`-design-review.md`）
> 审查依据：`rubric-design-doc.md`（P0/P1 清单）+ 项目 AGENTS.md + 源码交叉核实（声称事实前均已 read：pi-mono `session-manager.ts`（SessionEntryBase.timestamp / appendMessage 赋值点 / 文件名变换），runtime `subagent-extractor.ts`（toolCalls Map 结构 / findSubagentSessionFile / TIMESTAMP_WINDOW_MS / parseIsoFromFilename），extension `session-file-gc.ts` / `alive-store.ts` / `record-store.ts`（ALIVE_SOFT_TIMEOUT_MS 与重建矩阵分支 3/4）/ `session-runner.ts`（spawn env / ROOT_CWD 目录编码）/ `subagent-service.ts`（record.startedAt 赋值），**以及本机真实 session JSONL 实测**：主 session toolCall entry timestamp 与子进程文件名 ISO 时间戳的差值配对、同一 assistant entry 的并行 toolCall block 验证）
> 审查身份：对抗式第六轮（收敛验证轮）——聚焦 R5 全等级修复质量核对、v7 新增机制对抗（start entry timestamp 锚定匹配 / 级 6 时间判别 / GC 豁免）、全文档收口一致性；已修复问题不重复报，除非修复本身错了。
> 本报告只报告不修改任何文档。

## Summary

3 must-fix, 3 suggestions, 3 info.

总体判断：R5 的 11 条（2 MF / 6 SG / 3 INFO）中 7 条完全修复成立，两个 must-fix 的修复**形式落地但各留一个结构性缺口**。本轮按「时序类断言必须实测」的纪律，用本机真实 JSONL 对 v7 的核心新机制做了双重验证：

**timestamp 锚定的可达性成立、并发正确性不成立（MF-1）**。实测确认三件好事：pi 主 JSONL 每个 entry 确实自带 `timestamp`（`SessionEntryBase.timestamp`，`appendMessage` 落盘时 `new Date().toISOString()` 赋值）；toolCall entry timestamp → 子进程文件名时间戳的真实间隔为 **0.7~1.9s**（25 组配对实测），60s 匹配窗口余量约 30 倍，「≈ 子进程 spawn 时刻」成立；子文件名格式与现有 `parseIsoFromFilename` 的还原变换兼容（同一 `toISOString` 经 `replace(/[:.]/g, "-")` 生成，session-manager.ts:855-871 已核）。**但同一 assistant message 的并行 subagent toolCall 共享完全相同的 entry timestamp**（实测 2026-08-01 session：`call_00_*` 与 `call_01_*` 两个 start 同在 timestamp=05:42:07.047Z 的 entry 内）——而「并行派 A、B」正是设计 §5.1/§8 场景 1 的核心场景。锚相同 + `findSubagentSessionFile` 取「diff 最小」= 两个 record 解析到**同一个** sessionFile、另一个文件无人认领（实测 3 组复现：sa-a7d09/sa-adc97、sa-1053d/sa-d2ed2、sa-25d1d/sa-4fe5c 均双双指向同一最近文件，次近候选仅差 16ms）。v6 修复明言「无锚返回『最近文件』在并发时拿错，禁止」，v7 的 timestamp 锚把该问题换成同形保留，文档未承认该残留。

**「7 天后级 6 时间判别接手」结构上不可达（MF-2）**。级序「先命中先停」，有轮次 entry 的 chatMode 记录恒命中级 5（waiting），而级 6 的进入条件明写「无轮次 entry」——级 6 永远收不到这类记录，「接手为 error」的承诺（死行注 + 变更历史 v7③ 两处）与级 6 行自己的「waiting 永久」在同一文档内自相矛盾，且按级序不可实现。

**级 4 软超时把「超 1h 的运行中活任务」踢出后无正确落点（MF-3）**。级 4 条件「未超 1h 软超时」如实转译了扩展矩阵分支 3（`now - alive.startedAt < ALIVE_SOFT_TIMEOUT_MS(1h)`，record-store.ts:68-69/811-818 已核），但 `.alive` 在 + pid 活 + 超 1h 的运行中任务此后：级 4 miss（超时）、级 5 miss（one-shot 无轮次 entry）、级 6 按其括号条件「无 `.alive`」也不满足——六级全部 miss，投影无定义；若实现者把「其余」当 else 兜底则读子 JSONL 末行，运行中任务的末行是中间态 → 误判 done/error = **错误收敛**，违反 §5 核心承诺「信号丢失最多延迟收敛、不会错误收敛」。连带：设计 §6.5「重建矩阵分支 4……这些记录进程必然不存在」的断言对分支 4 的「超时」进入路径（.alive 在 + pid 活）失实——进程可能存在。

维度 3 收口扫描：决策/探针/级数/枚举体系全部一致，R5 的场景计数与发起点两处漂移已修 ✓；残留三类小漂移（计划头部版本 v6 未更新 / 附录 v7 行排在 v6 前 / P4 一处「startedAt 窗口宽限」措辞）。

## Findings

| 优先级 | 位置 | 维度 | 标记 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | 设计 §6.5 sessionFile 链第 2 级 / §5.1 T+0s 与 T+40s / §5.2 kill -9 subagent 行 / 级 4 与级 6；计划 P4 extractor 行「start entry timestamp 锚定匹配为主数据源」 | 维度 1+2 / P0-11 + P0-10 | 新发现（R5-MF-1 修复的核心机制缺口） | **start entry timestamp 锚定匹配在「同一 assistant message 并行 toolCall」场景下区分度为零，v7 未承认该残留**。已 read + 实测双重核实：① 可达性成立——pi `SessionEntryBase.timestamp`（session-manager.ts:46-50）+ `appendMessage` 落盘赋值（:981-989）+ 子文件名 = 同一 `toISOString` 经 `replace(/[:.]/g,"-")` 变换（:855-871），与现有 `parseIsoFromFilename`（subagent-extractor.ts:332-343）解析兼容；25 组真实配对的 toolCall entry → 子文件名间隔 0.7~1.9s，`TIMESTAMP_WINDOW_MS=60_000` 余量约 30 倍；② 并发正确性不成立——「并行派两个 subagent」的自然形态是同一 assistant message 的两个 toolCall block（实测 `call_00_*`/`call_01_*` 同在 entry timestamp=2026-08-01T05:42:07.047Z），**两个 record 的锚完全相同**；`findSubagentSessionFile` 对每个 record 独立取「diff 最小」，实测 3 组并发对（sa-a7d09/sa-adc97、sa-1053d/sa-d2ed2、sa-25d1d/sa-4fe5c）双双匹配到同一最近文件、次近文件（相差仅 16ms）无人认领——**50% 概率某 record 的 sessionFile 指向别人的文件**；③ 后果链——窗口期内（秒级信号重拉）级 4 探测错 `.alive`（A 已完成却探测到 B 的活标记 → 显示 streaming，秒级收敛失效，退化为窗口+turn）；kill -9 场景（§5.2/场景 7 依赖级 6 读子 JSONL 末行判终态）读错文件的末行 → **错误终态无修正通路**（父进程已死，bg-notify 永不落盘，级 1 兜底不存在），违反「不会错误收敛」；④ v6 修复明言「无锚返回『最近文件』在并发时拿错，禁止」（链第 5 级注），v7 的锚在同 message 并行形态下歧义度与「无锚」等价，文档既未论证区分度也未声明该残留风险。另：extractor 现状 `toolCalls` Map 值只含 `{agent, slug, task}`（subagent-extractor.ts:123/150-156），收集 entry timestamp 属必要改动，两文档均未提（实现可行，属遗漏的连带改动说明） | 在链第 2 级或级 6 补并发消歧机制，任选或组合：① 同 message 多 toolCall 时按 toolCall 在 entry 内的出现顺序与窗口内候选文件的时间顺序做一一配对（锚相同 → 序保持）；② 匹配歧义检测——同锚 record 数 > 可认领文件数、或多个候选文件落在彼此的匹配半径内（实测 16ms）时判「匹配不确定」，不猜文件、落统一保守规则（无终态迹象 → streaming；有终态迹象 → error），并把 bg-notify sessionFile（链 3）与 A10a payload sessionFile 作为 flush 后的修正源；③ kill -9 永久终态路径（无级 1 兜底）禁止使用歧义匹配的文件读末行；④ 文档显式承认「timestamp 锚在串行启动下可靠、同 message 并行下需消歧」，并补 extractor 收集 entry timestamp 的改动说明；⑤ 计划 P4 单测补「同 message 并行 toolCall + 窗口内两个文件」的消歧/保守 fallback fixture |
| MUST_FIX | 设计 §6.5 映射表死行注（「7 天后仍未终态化则级 6 时间判别接手为 error」）/ 级 6 行（「有轮次 entry 的 chatMode 记录落级 5 → waiting 永久」）/ 变更历史 v7③；计划 P4 无对应落点 | 维度 1+2 / P0-11 + P0-12 | 修复引入（R5-MF-2 修复对「有轮次 entry」形态不闭环） | **「7 天后级 6 时间判别接手为 error」在级序上不可达，同一文档内自相矛盾**。级序规则「按序判定，先命中先停」：有轮次 entry 的 chatMode 记录（/new、/fork 级联关闭前已跑过轮）恒命中级 5（最后 bg-notify entry 为 running 轮次通知 → waiting）——先命中即停；而级 6 的进入条件明写「其余（孤儿与崩溃：无终态 entry、无 sidecar、无 `.alive`、**无轮次 entry**）」——该形态永远进不了级 6，其时间判别（7 天阈值）永远不作用于它。因此死行注与变更历史 v7③ 的「7 天后仍未终态化则级 6 时间判别接手为 error」是**结构上不可能兑现的承诺**，与级 6 行自己的「waiting 永久（是本投影的已知边界）」直接矛盾（一句话内「waiting 永久」与「7 天后接手」不能同时真）。实质后果：R5-MF-2 要修的「无时间上界」在 chatMode 轮次形态下依然存在——级联关闭的 chatMode 记录永久显示 waiting（进程已死、语义误导「等续聊」），文档给实施者的 7 天兜底是虚假的 | 二选一：① 级 5 补时间衰减条件——「轮次 entry 自身超龄（如 start entry timestamp 距今 > 7 天）则视为无效、不再命中级 5、落入级 6 时间判别」（使「接手」承诺真实可达，需同步级 5 说明与计划 P4 单测「轮次 entry 超龄 → 级 6」用例）；② 删除两处「7 天后接手」表述，明确「有轮次 entry 的级联关闭记录 waiting 无上界、无兜底」为最终接受边界（回到 v6 立场并显式声明）——不可保留当前的矛盾表述 |
| MUST_FIX | 设计 §6.5 级 4（「未超 1h 软超时」条件）/ 级 6 进入条件（「无 `.alive`」）/ §6.5 错位事实段（「分支 4……这些记录进程必然不存在」）；计划 P4 级 ④⑥ | 维度 2 / P0-11 + P0-10 | 新发现 | **超 1h 的运行中活任务在六级矩阵中无正确落点：按字面无级可落，按兜底解读则错误收敛**。已 read 核实：级 4 条件忠实转译扩展矩阵分支 3——`m.alive !== undefined && isProcessAlive(m.alive.pid) && m.now - m.alive.startedAt < ALIVE_SOFT_TIMEOUT_MS`（record-store.ts:68-69「1h，防 pid 复用」/ :811-818），`.alive` 的 startedAt 是 marker 内 spawn 时刻（一次性，无 heartbeat 更新，alive-store.ts:22-25 已核）。于是「`.alive` 在 + pid 活 + startedAt 超 1h」的**运行中**任务（后台调研跑 1 小时+ 完全常见：慢模型/复杂任务）：级 4 miss（超时）、级 5 miss（one-shot 无轮次 entry）、级 6 按括号条件「无 `.alive`」不满足——**六级全部 miss，投影无定义**；若实现者把级 6「其余」当穷尽 else 兜底（忽略括号枚举），则读子 JSONL 末行——运行中任务的末行是中间态 entry，「正常收尾 → done / 截断 → error」的两分判定必错其一 → **把「在跑」误判为终态 = 错误收敛**，违反 §5「信号丢失最多延迟收敛、不会错误收敛」的核心承诺。连带事实错误：错位事实段「重建矩阵分支 4（……无 sidecar / `.alive` 但 pid 死 / 软超时）落点 running——这些记录**进程必然不存在**」——分支 4 的「超时」进入路径（.alive 在 + pid 活 + 超 1h）进程**可能存在**（软超时只是防 pid 复用的保守措施，不是死亡证明；扩展侧分支 4 对该形态保守落 running 正是为此），该断言是决策 5 把分支 4 记录整体归入「误导性 running」的依据之一，对超时子形态失实 | 级 6 读子 JSONL 末行（或判终态）前加活进程兜底：`.alive` 存在且 pid 活时无论是否超软超时，保守投影 streaming（进程在跑，读末行判终态必错）——软超时只用于「pid 已死场景下 .alive 可信度的衰减」而非「pid 活也当死」；同步修正级 6 括号条件（纳入「有 `.alive` 但超软超时」形态）与错位事实段「进程必然不存在」的表述（限定为「pid 死/无 .alive 子形态」）；P4 单测补「`.alive` 在 + pid 活 + 超 1h → streaming」与「超时 + pid 死 → 级 6」两个用例 |
| SUGGESTION | 设计 §6.5 级 6（「session-file-gc.ts 每次 session_start 5% 概率清 mtime>30 天的子 JSONL + 全部 sidecar」）；计划 P0-A10 GC 交互探针 | 维度 2 / P0-11（表述与源码偏差，含一个边缘行为缺口） | 新发现 | **对 GC 行为的转述与源码有三处偏差，其中「活进程豁免」对级 4 依赖的 `.alive` 不成立**。已 read session-file-gc.ts 全文核实：① `.jsonl` 删除**有**活进程豁免——`readAliveMarker(full)` + `isProcessAlive(aliveMarker.pid)` 活则 continue（:86-90），设计未提该豁免（「清 mtime>30 天的子 JSONL」是无条件表述）；② 孤儿 sidecar 分支（:101-117）对 `.alive`/`.finalized`/`.cancelled`/`.patch` **独立按 TTL 清理，既不做 pid 豁免、也不检查兄弟 `.jsonl` 是否存在**（注释称「孤儿 sidecar」但代码对所有该后缀文件生效）；③ `.alive` 无 heartbeat（`writeAliveMarker` 仅 spawn 时写一次，alive-store.ts:22-25）——30 天后**活进程**的 `.alive` 也会被该分支删除（其 `.jsonl` 因豁免保留），级 4 的 `.alive` 依赖随之失效，该进程若继续运行将落入 MF-3 同款无落点/误判路径。缓解因素：`idleTimeoutMs` 默认 300000ms/5min（interface/subagent-tool.ts:274 已核），「30 天+ 活进程」需用户显式传超大 idleTimeoutMs 或 one-shot 跑满 30 天，极边缘——故降级 SUGGESTION；但设计把它当「活进程豁免」的地基表述（级 6 时间判别「> 7 天 → error」不误判活任务的前提之一）需要准确 | 级 6 的 GC 表述改为精确版：「5% 概率扫 `<piAgentDir>/subagents`：mtime>30 天的 `.jsonl` 删前做 pid 探活豁免（活进程保留）；`.alive`/`.finalized`/`.cancelled`/`.patch` 作为独立条目按同 TTL 清理、**无豁免**——`.alive` 无 heartbeat，30 天后活进程的 `.alive` 亦被删（已知边缘，idle 默认 5min 使其实际不可达）」；P0-A10 的 GC 交互探针顺带断言孤儿 sidecar 分支行为（伪造 mtime>30d 的 `.alive` + 活 pid 场景） |
| SUGGESTION | 计划头部一句话结论（line 3「设计文档（`subagent-workflow-sidebar-sync-design.md` **v6**）」） | 维度 3 / P1-8 + P0-12 | 漏同步（R4-SG-1/R5-SG-1 同类问题第三轮复发） | **计划头部版本号未随设计 v7 更新**：设计已是 v7（附录含 v7 行），计划一句话结论仍写「v6」。该版本号在 R4 轮曾漏 v4→v5 一次（R4-SG-1⑦），属同类漂移的再次复发；计划 §0 P6 行的「v6 含场景 9」是历史事实陈述可保留，但头部引用的当前版本必须同步 | 计划头部 v6 → v7；建议后续把「设计版本号」列为主 agent 更新计划的固定检查项，防第四轮复发 |
| SUGGESTION | 设计 §6.5 级 6 时间判别（三分支表述） | 维度 2 / P0-12（边界组合未定义） | 新发现 | **「中间态 + 子 JSONL 不存在」组合无分支归宿**：级 6 时间判别写「距今 ≤ 窗口期+1 turn → 子 JSONL 不存在/不可读 → streaming」「距今 > 7 天且不存在 → error」「**中间态/文件存在** → 读子进程 JSONL 末行」——「窗口期+1turn < 距今 ≤ 7 天 且文件不存在」（如 spawn 发起后子进程启动失败、文件从未创建；或文件被外部删除）按字面落第三分支「读末行」，但文件不存在不可执行。统一保守规则（无终态迹象 → streaming）语义上可兜住，但级 6 行未显式该组合，实现者可能落进「读末行失败 → 当作不可读」的任意方向 | 第三分支改为「文件存在 → 读末行；文件不存在且距 ∈（窗口期+1turn, 7 天] → streaming（保守，同 start 早期方向）」，与统一保守规则显式对齐 |
| INFO | 设计附录变更历史（v7 行排在 v6 行之前） | 维度 3 / P1-8 | 新发现 | v5 行之后先出现 v7 行（line 439）再出现 v6 行（line 440），时间顺序颠倒——纯排版，不影响决策 | v6/v7 两行按时间顺序排列 |
| INFO | 计划 P4 验证（单测清单） | 维度 1 / P0-13（细节） | 修复尾巴（R5-SG-3） | R5-SG-3 修复方向明确要求「P4 单测补 running/undefined 输入断言」；v7/计划已在开发内容层落地映射（running→streaming、falsy→streaming 两文档一致 ✓），但 P4 单测清单（fixture 矩阵行）未显式列这两个输入的断言项——按现清单实施可能漏测 | P4 单测清单补一句「normalize 输入域断言：'running' → streaming、undefined → streaming」 |
| INFO | 计划 P4 extractor 行末尾（「A10 探针若证实冷路径抖动 → 级 6 加 **startedAt** 窗口宽限」） | 维度 3 / P1-8 | 措辞残留 | 设计 v7 已把宽限的时间锚统一为「start entry timestamp」（级 5 注括号 + 级 6 时间源 + P0 冷路径探针均带澄清），P4 该处单独使用旧词「startedAt 窗口宽限」且无澄清——可能被实施者理解为 notify.startedAt（恰是窗口期缺失、不可用的锚） | P4 该处改为「start entry timestamp 窗口宽限」或补括号引用设计级 5 注 |

## R5 修复核对表（维度 1，验收项 1）

| R5 编号 | 内容摘要 | 判定 | 说明 |
|---------|---------|------|------|
| MF-1 | sessionFile 链第 1 级证伪后的链重写（第 1 级降级为升级点 / timestamp 锚为主数据源 / 保守方向统一 / fixture 真实形态） | **部分成立** | 链重写、级 1 降级注、统一保守规则（§6.5 + §7.2 + 计划 P4 三处一致）、§5.1 时间线改写、P4 fixture「details 恒 null + timestamp 锚」全部落地 ✓；timestamp 锚的**可达性**本轮实测成立（间隔 0.7-1.9s << 60s、字段与文件名格式兼容）；但**并发正确性**不成立——同 message 并行 toolCall 锚相同，最近匹配使多 record 解析到同一文件（实测 3 组），kill -9 路径错误终态无修正通路——本轮 MF-1 |
| MF-2 | 级 6 时间判别（≤ 窗口期 → streaming / > 7 天且不存在 → error / now 参数 / GC 交互探针） | **部分成立** | 时间判别三分支、now 参数（两文档一致）、§11 A10 GC 交互探针、P0-A10 探针行全部落地 ✓，对「无轮次 entry」形态（无终态孤儿）闭环；但「有轮次 entry → 7 天后级 6 接手」不可达（级 5 先命中先停 + 级 6 进入条件排除该形态），与级 6 行「waiting 永久」自相矛盾——本轮 MF-2；级 4 软超时漏斗（MF-3）是该判别邻域的前轮未触达缺口 |
| SG-1 | 场景计数两处（设计 §8 结论 / 计划 §8 标题） | **已修复 ✓** | 设计 §8 结论「9 个」与表 9 行一致；计划 §8「全部 9 场景」与 §0「9 场景」、DoD「9/9」一致 |
| SG-2 | 轻量事件发起点两处（§7.4 / P5） | **已修复 ✓** | 两处均补齐「终态转换 + 轮次完成（idle 位翻转），见决策 6.3」 |
| SG-3 | normalize 输入域补 running/falsy | **已修复 ✓（带尾巴）** | 设计 §6.5 与计划 P4 开发内容层一致落地（running→streaming + falsy→streaming + default→error）；尾巴：P4 单测清单未显式列 running/undefined 断言——本轮 INFO-2 |
| SG-4 | 死行注层级混淆 + 级联关闭落点分类 | **已修复 ✓（带缺口）** | 「组合映射表保留死行标注——normalize 单值归一层收不到 closedReason」层级修正 ✓；级联关闭两形态分类（无轮次 → 级 6 / 有轮次 → 级 5）三处一致 ✓；缺口：waiting 形态的「7 天后接手」承诺不可达——本轮 MF-2 |
| SG-5 | §7.2「保守投影 error」限定终态语境 | **已修复 ✓** | §7.2 改为引用 §6.5 统一规则（有终态迹象 → error / 无 → streaming），与级 6 一致，两个失败模式方向统一 |
| SG-6 | 宽限规则时间源（now 注入 / entry timestamp 锚） | **已修复 ✓** | 设计级 5 注 + 级 6 时间源 + 计划 P0/P4 均落 now 参数；P4 一处「startedAt 窗口宽限」措辞残留——本轮 INFO-3 |
| INFO-1 | 一句话结论六级枚举「非与级数一一对应」注 | **已修复 ✓** | 文档头一句话结论已带「按磁盘事实枚举……非与级数一一对应」 |
| INFO-2 | conversation 参数核实记录 | **无需动作 ✓** | 维持（本轮未重复怀疑） |
| INFO-3 | sessionFile 取值稳定性核实记录 | **无需动作 ✓** | 维持（本轮未重复怀疑） |

汇总：**11 条中 7 条完全成立；两个 MF 均部分成立（各带一个本轮新缺口：MF-1→并发区分度、MF-2→接手不可达）；SG-3/SG-4 成立但各带一处尾巴/缺口；3 条 INFO 无需动作。**

## 各维度结论

### 维度 1：R5 全等级修复质量核对

见上方核对表。总评：v7 对 R5 的响应率高（11/11 有对应动作），形式完整度好（链重写、时间判别、保守规则统一、输入域补全、计数/发起点/层级三处漂移清理全部落地）；timestamp 锚定的**可达性**经本轮实测确认成立（这是 R5 修复方向 ② 的核心前提，前五轮从未实测过）。但两个 must-fix 的修复各留一个结构性缺口，且都落在「并发/边界形态」上——MF-1 的并发区分度缺口恰在设计的核心场景（并行 subagent），MF-2 的接手承诺在级序上不可达。另暴露一个前五轮未触达的洞（级 4 软超时 → 超 1h 活任务无落点，MF-3）。

### 维度 2：v7 新增机制对抗

- **start entry timestamp 锚定匹配**：字段存在性（`SessionEntryBase.timestamp: string`，appendMessage 落盘赋值）✓ 实测确认；与子文件名解析兼容性（同一 toISOString 变换链）✓；间隔充分性（实测 0.7-1.9s vs 60s 窗口）✓；**并发区分度 ✗**（同 message 并行 toolCall 锚相同，MF-1）；extractor 落地路径（toolCalls Map 需扩展收集 entry timestamp）可行但两文档未提（并入 MF-1 修复方向）。
- **级 6 时间判别**：7d vs 30d 关系自洽（7d 是提前防御——「> 7 天 + 文件不存在」在 7-30 天间覆盖非 GC 原因的缺失，30 天后覆盖 GC 删除；活任务被级 4 拦截的前提在「`.alive` 被 GC 孤儿分支删」的 30 天+ 边缘失效，SG-1）；「> 7 天 → error」对真任务的一般误判不成立（活任务有 `.alive`+pid 活 → 级 4，或 `.alive` 在 + pid 活 + 超 1h → MF-3 的洞）；「7 天后接手」不可达（MF-2）；「中间态 + 文件不存在」未定义（SG-3）。
- **GC 活进程豁免**：`.jsonl` 豁免真实（readAliveMarker + isProcessAlive，session-file-gc.ts:86-90）；**`.alive` 不豁免**（孤儿 sidecar 分支独立按 TTL、无 pid 检查、不查兄弟文件）且 `.alive` 无 heartbeat 更新——「活进程豁免」对级 4 依赖的文件不完整成立（SG-1，边缘：idle 默认 5min）。
- **其余 v7 改动**：保守方向统一（§6.5/§7.2/P4 三处一致）✓；级联关闭两形态分类三处一致 ✓（waiting 形态带 MF-2 缺口）；normalize 输入域（running/falsy/default）两文档一致 ✓；发起点与计数修复 ✓。

### 维度 3：全文档收口一致性（v7 后）

- **编号体系全部一致**：决策 1-7（含 6.1/6.2/6.3）、探针 A1-A10、六级矩阵、SubagentStatus 6 态、sessionFile 链层级（设计 5 级与计划 4 数据源级对应）、场景计数 9、normalize 输入域、A10 探针步骤（含 GC 交互与冷路径时间源）——两文档间未发现新的语义漂移。
- **残留漂移三类**（均为 P1-8 级）：计划头部版本号 v6（SG-2，同类第三轮复发）；附录变更历史 v7/v6 行序颠倒（INFO-1）；P4 一处「startedAt 窗口宽限」旧锚名（INFO-3）。
- 两文档间相同事实表述抽查（级 6 时间判别参数、GC 交互探针、保守规则、fixture 真实形态要求、A10a 发起点）一致。

### 维度 4：方法备注

本轮延续 R5 确立的「时序类断言必须实测」纪律：v7 的三个关键时序断言（entry timestamp 字段存在、间隔充分、锚区分度）中前两个实测通过、第三个实测证伪——「消费代码存在/字段存在」与「值可区分」是三层不同强度的断言，本轮对第三层的实测再次避免了「文档声称可达 = 实际可用」的误判。MF-3（软超时漏斗）则来自「转译既有规则（与扩展分支 3 同规则）时未检查该规则排除的形态在新级序中的去向」——跨系统转译条件时被转译系统的兜底（分支 4 → running）不会自动跟过来。

## 已核实为真的关键引用（本轮新增核实）

pi `SessionEntryBase.timestamp: string`（session-manager.ts:46-50）与 `appendMessage` 落盘赋值 `new Date().toISOString()`（:981-989）；子 session 文件名 = 同一 toISOString 经 `replace(/[:.]/g, "-")`（:855-871），与 `parseIsoFromFilename` 还原变换互逆；extractor `toolCalls` Map 值仅 `{agent, slug, task}`（subagent-extractor.ts:123/150-156）、`TIMESTAMP_WINDOW_MS=60_000`（:270）、最近匹配选 diff 最小且 ≤ 窗口（:311-325）；**真实 JSONL 实测**：25 组 start 配对的 toolCall entry → 子文件名间隔 0.7~1.9s；同一 assistant entry 含两个并行 start toolCall（`call_00_*`/`call_01_*`，共享 timestamp=2026-08-01T05:42:07.047Z）；三组并发对双双匹配同一最近文件、次近候选差 16ms；GC `.jsonl` 删除的活进程豁免（readAliveMarker + isProcessAlive，session-file-gc.ts:86-90）；孤儿 sidecar 分支独立按 TTL、无豁免、不查兄弟（:101-117）；`writeAliveMarker` 仅 spawn 时一次写入、无 heartbeat（alive-store.ts:22-25）；`ALIVE_SOFT_TIMEOUT_MS = 1h` 与分支 3 三条件、分支 4 兜底落 running（record-store.ts:68-69/810-826）；`record.startedAt = Date.now()` 创建时刻（subagent-service.ts:1336）；worktree 下子 session 落盘目录统一编码在 enc(ROOT cwd) 段（session-runner.ts:885-890，与 extractor mainCwd 推导一致）；idleTimeoutMs 默认 300000ms/5min（interface/subagent-tool.ts:274）。
