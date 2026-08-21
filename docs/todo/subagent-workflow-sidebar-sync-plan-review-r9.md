# subagent-workflow-sidebar-sync 第九轮联合审查报告（R9，审查-修复循环收敛轮）

> 审查对象：设计文档 `subagent-workflow-sidebar-sync-design.md`（v10）+ 开发计划 `subagent-workflow-sidebar-sync-plan.md`（联合审查）
> 前序报告：R1（`-plan-review.md`，4 MF / 10 SG）、R2（`-plan-review-r2.md`，1 MF / 10 SG / 3 INFO）、R3（`-plan-review-r3.md`，4 MF / 6 SG / 2 INFO）、R4（`-plan-review-r4.md`，2 MF / 6 SG / 4 INFO）、R5（`-plan-review-r5.md`，2 MF / 6 SG / 3 INFO）、R6（`-plan-review-r6.md`，3 MF / 3 SG / 3 INFO）、R7（`-plan-review-r7.md`，2 MF / 1 SG / 1 INFO）、R8（`-plan-review-r8.md`，1 MF / 1 SG / 3 INFO）、设计 v1 审查（`-design-review.md`）
> 审查依据：`rubric-design-doc.md`（P0/P1 清单）+ 项目 AGENTS.md + 源码交叉核实 + 本机真实 JSONL 全量实测。本轮新增 read：`extensions/subagent-workflow/src/index.ts`（identity 写入点 :326-361，`task: process.env.PI_SUBAGENT_TASK` :337）、`extensions/model-switch/src/index.ts`（session_start 只迁移配置+读状态，不写 entry）、`extensions/pending-notifications/src/index.ts`（session_start 条件写 `pending:unregister`——仅 expiredToFlush 非空，子进程新 session 历史为空不触发）、`extensions/plan/src/index.ts`（session_start 只 reconstruct，不写 entry）、`extensions/scheduler/src/index.ts`（session_start 条件写 importLegacyStore——仅 legacy store 存在时）、`extensions/subagent-workflow/src/execution/session-runner.ts:659-674`（子进程扩展集合 = `mirrorFlags.extensionPaths` 逐个 `--extension` 镜像主进程）。实测（4417 个子文件全量重扫）：identity entry 位置按版本日期切分的分布（≥8/13 共 399 个：第 4 条 388 / 第 5 条 11，**前 8 条内 0 miss**）；identity entry 结束字节偏移分布（≥8/13：p50=2997 / p90=6408 / p99=24026 / max=62430，**>16KB 共 15 个 = 3.8%**）；15 个超窗文件的 entry 构成深查（前 3 条仅 ~475B，identity entry 自身 17KB-62KB——超窗全部因 identity 行本身大，非前置 entry 多）；<8/13 存量形态（identity 在第 14-53 条 + 11 个无 timestamp 的父进程补写旧形态 + 8/12 当天 27 个新形态例外）。
> 审查身份：对抗式第九轮（收敛轮）——聚焦 R8 全等级修复质量核对、v10 新增机制对抗（首部扫描 8 条余量 / 16KB 双口径 / 保守规则时间分支）、全文档收口一致性；已裁决问题不重复报，除非修复本身错了或被后续编辑回退。
> 本报告只报告不修改任何文档。

## Summary

**0 must-fix, 4 suggestions, 3 info.**

总体判断：R8 的 1 MF / 1 SG / 3 INFO 中，**机制层修复全部成立**——「首部扫描前 8 条 entry」解析规格经本轮独立全量复验成立（新版本产物 399/399 identity 在第 4/5 条 entry，8 条余量充足）；统一保守规则时间分支（§6.5 三分支 + §5.2 冷路径限定）落地且与级 6 时间判别自洽。v10 无 must-fix 级缺陷。

本轮 4 条 suggestion 全部是**修复落地的边缘精度问题**，无一条动摇方案成立、导致错误收敛或使验收不可执行：

1. **「（或 16KB 字节窗）」备选口径被本轮实测证伪**（SG-1）——新版本产物按字节窗口径 miss 15/399 = 3.8%（8 条 entry 口径 100%）。miss 机制不是「前置 entry 多」，而是 **identity entry 自身携带任务全文（`task: process.env.PI_SUBAGENT_TASK`）可达 17KB-62KB**，字节窗在 entry 中间截断 → JSON parse 失败。设计未裁决两口径中实施者用哪个（计划 P4 已隐式选 8 条 entry）。
2. **R8-SG-1 的时间维度修复同步不完整**（SG-2）——设计 §6.5 主文与 §5.2 已改三分支，但设计 §7.2（行 355）与计划 P4（行 185）的复述仍是二分支旧口径（漏「无终态信号 + >7 天 → error」）。
3. **变更历史时间序回退**（SG-3）——v10 行插在 v9 之前，R8-INFO-1 的排序修复被 v10 编辑破坏。
4. **「identity 前最多 4 条」绝对化断言无环境限定**（SG-4）——子进程扩展集合镜像主进程（session-runner mirrorFlags），第三方扩展可在 session_start 写 entry 挤占 8 条窗口；规则 ② 机制上兜住（超窗 → 保守，方向安全），但设计未声明该假设的环境依赖。

任务点名的三个对抗面核验结论：8 条余量在当前内置扩展组合下实测充足（复验成立，环境依赖见 SG-4）；双口径取舍**未写清**（SG-1）；保守规则时间分支与级 6 时间判别关系自洽（域不相交 +「对齐」表述，见 INFO-3），start entry timestamp 锚在 sessionFile-null 场景可达（主 JSONL entry 恒在 = 锚恒在，已核实，无需报）。

## Findings

| 优先级 | 位置 | 维度 | rubric | 描述 | 修复方向 |
|--------|------|------|--------|------|----------|
| SUGGESTION | 设计 §6.5 sessionFile 链第 2 级「解析规格（R8 实测定案）：扫描候选文件首部前 8 条 entry（或 16KB 字节窗）」 | 维度 1（R8-MF-1 修复核对） | P0-11（影响决策的事实：备选口径实测失实）+ P1-8 | **16KB 字节窗备选口径被本轮实测证伪，且双口径未裁决主口径**。实测（4417 文件，按 identity entry timestamp ≥2026-08-13 切分出 399 个新版本产物）：「前 8 条 entry」口径 100% 命中（第 4 条 388 个 / 第 5 条 11 个）；「identity entry 结束偏移 ≤16KB」口径 miss **15/399 = 3.8%**（偏移 p50=2997 / p90=6408 / p99=24026 / max=62430）。miss 机制（本轮深查 15 个超窗文件）：**全部因 identity entry 自身巨大**——前 3 条 entry（session header + model_change + thinking_level_change）合计仅 ~475B，而 identity data 携带 `task: process.env.PI_SUBAGENT_TASK` 任务全文（源码 index.ts:337），长任务使单行 identity entry 达 17KB-62KB——字节窗在 entry 中间截断 → JSON parse 失败 → identity「不可读」→ 规则 ② 保守。即：字节窗不是「更宽的窗」，是**结构性劣于按行计数的口径**（entry 口径按行读完整 JSON，天然免疫单行超长）。后果链：实施者若从设计出发选字节窗（设计「或」字并列两口径、未标主次），3.8% 的正常新文件在窗口期落保守 streaming、kill -9 场景 7 在该子集显示 streaming 而非 done/error（≤7 天）——方向安全但收敛退化；R8 的「399/399 全命中」实测数字只属于 entry 口径，16KB 口径从未被实测过（R8 修复方向原文「N=8 或首部字节窗如 16KB」是并列建议）。计划 P4 已实际选「首部扫描前 8 条 entry」（未提字节窗），与设计不矛盾但未消解设计的二义 | 设计裁决主口径：删「（或 16KB 字节窗）」，或改为「主口径 = 前 8 条 entry（实测 100%）；16KB 字节窗实测 miss 3.8%——identity entry 自身携带 task 全文可超 16KB，字节窗结构性劣于按行口径，不采用」 |
| SUGGESTION | 设计 §7.2（行 355）「匹配不到的保守方向按 §6.5 统一规则（有终态迹象 → error；无 → streaming）」；计划 §6 P4 extractor 行（行 185）同句 | 维度 1（R8-SG-1 修复核对）/ 维度 2 | P0-12（修复同步遗漏） | **R8-SG-1 时间维度修复只改了 §6.5 主文与 §5.2，两处复述未同步**：设计 §6.5 统一保守规则现为三分支（有终态迹象 → error；无终态信号 + ≤7 天 → streaming；**无终态信号 + >7 天 → error**），§5.2 kill -9 行限定「（≤7 天 streaming，>7 天 error）」亦一致；但设计 §7.2（实现机制章节）与计划 P4（开发内容行）的括号复述仍是 v9 的二分支「（有终态迹象→error / 无→streaming）」——实施者按 §7.2/P4 开发内容行实现会漏掉 >7 天 error 分支（存量产物历史孤儿在该路径永久 streaming——正是 R8-SG-1 要消除的症状在实现层复发）。缓解：计划 P4 fixture 清单已含「保守规则时间维度：≤7 天 → streaming；>7 天 → error」断言，DoD 全绿可兜住实施；但文档间相同事实不一致违反收口要求，且 §7.2 是设计「实现机制」权威章节 | 两处复述补齐第三分支：「（有终态迹象 → error；无终态信号 + ≤7 天 → streaming；>7 天 → error）」或改为引用式「按 §6.5 统一规则（三分支，含 >7 天 → error）」 |
| SUGGESTION | 设计附录变更历史（行 442-443） | 维度 1（R8-INFO-1 修复核对） | P1-8 | **变更历史时间序回退**：当前顺序 v8 → **v10 → v9**——v10 行插在 v9 之前。R8-INFO-1 判定「附录 v1→v9 严格时间序已修复 ✓」，v10 的编辑把新行插错位置，破坏了该修复（R6 轮曾发生同类「声称排序修复未执行」事故，v9 行④专门记录过）。不影响决策，但变更历史是版本演进的审计线索，排序错位直接误导「v10 先于 v9 存在」的阅读 | 把 v10 行移到 v9 行之后（列表尾），恢复严格时间序 |
| SUGGESTION | 设计 §6.5 链第 2 级解析规格括号「identity 前最多 session header + model_change + thinking_level_change + hooks:loaded，prompt 在其后不插队」 | 维度 3（新发现） | P0-11 边缘（关键事实的适用域未声明；被既有规则结构性兜住，降级） | **「最多 4 条」是对当前扩展组合的实测断言，无环境限定词**。事实链（本轮 read 核实）：子进程的扩展集合 = 镜像主进程（session-runner.ts:670-672 `mirrorFlags.extensionPaths` 逐个 `--extension`）——主进程加载的任何第三方/用户扩展都会进子进程；任何扩展都可在 session_start handler 里 `pi.appendEntry` 写 custom entry（identity 与 unified-hooks:loaded 正是两个先例），排在 identity 前后由扩展加载顺序决定。当前 14 个内置扩展中 session_start 会写 entry 的只有 identity 自身、unified-hooks:loaded（恒写）、pending-notifications（条件写：仅历史 entries 有 expired 项——子进程新 session 不触发）、scheduler（条件写：仅 legacy store 存在时导入）——内置组合下 8 条余量实测充足（399/399 在第 4/5 条，余量 3-4 条）。但用户装 ≥4 个「session_start 写 entry 且排在 identity 前」的第三方扩展时超窗 → identity 读不到 → 规则 ② 保守（方向安全：不猜文件、不错误收敛），代价是并发消歧失效 + kill -9 场景显示 streaming ≤7 天。设计未声明该假设的环境依赖；实现若把 8 当魔数且无观测，第三方扩展环境下静默退化、无诊断线索 | 解析规格补一句环境限定：「余量基于当前内置扩展组合实测；扩展集合镜像主进程（mirrorFlags），第三方扩展可在 session_start 写 entry 挤占窗口——扫 8 条未见 identity 即按规则 ② 走保守（方向安全）」；建议实现时对「窗口内未见 identity 且文件首部 entry 数 ≥8」记 debug 日志（可观测的静默退化信号） |
| INFO | 设计 §6 开头「本章结论：6 个决策……」 | 维度 2（收口一致性） | P1-8 | **决策计数与实际不符**：§6 实有 7 个决策（6.1 决策 1 … 6.7 决策 7「性能边界」），开头结论写「6 个决策」。前八轮均未报过（grep 全部报告无命中），属长期存量计数漂移，不影响决策与实施 | 改「7 个决策」 |
| INFO | 设计 §6.5 链第 2 级覆盖率表述「8/13 前存量产物 0%」 | 维度 3（实测精度备注） | P1-8 | **版本边界有 1 天过渡带**：本轮按「前 8 条 entry 内可见 identity」口径实测 <8/13 的存量文件——8/12 当天已存在 **27 个新形态**（identity 在第 4 条，子进程写入）；另有一批旧形态（identity 在第 14-53 条，含 11 个无 timestamp 字段的父进程 appendFileSync 补写形态——旧实现手写 JSON 不带 ts，与源码注释「旧实现父进程 fs.appendFileSync 补写的 custom entry 缺 id/parentId」一致）。「8/12 前 = 0%、8/12 当天 = 过渡」比「8/13 前 0%」精确（commit e7a6c0d3d 日期 8/13 与本机产物形态边界差一天，dev 部署/时区所致）。不影响决策：8/12 的新形态文件能读到 identity 只会让投影更准，其余照旧走保守 | 表述微调为「8/12 前存量产物基本 0%（8/12 当天为过渡带）」或维持现状（该口径差不影响任何决策） |
| INFO | 设计 §6.5 级 6 时间判别 vs 统一保守规则时间分支（实现层备注） | 维度 1（任务点名核对项） | — | **两处时间分支关系自洽，无重复实现的设计缺陷**（核对结论，非问题）：输入域不相交——级 6 判别的输入是「sessionFile 已解析（identity-id 确认归属）」后文件不存在的时间兜底，统一保守规则的输入是「sessionFile 匹配不到」（identity 不可读/候选窗外）；两者 7 天阈值、时间锚（start entry timestamp）、now 注入语义一致，设计已用「对齐级 6 GC 判别与 normalize default→error 的既有理由」+「时间源同级 6」表述关系。实现层注意（value-add）：两处是同构时间谓词（阈值 7 天 + 锚 + now），宜抽公共函数防两处阈值未来漂移。「start entry timestamp 锚在 sessionFile-null 场景的可达性」已核实成立——extractor 的记录源自主 JSONL toolCall entry，timestamp 是 pi `SessionEntryBase` 自带字段，主 JSONL 存在（extractor 正在解析它）= start entry 存在 = 锚可达，无缺口 | 无需文档动作；P4 实现时抽公共时间谓词（如 `isOverage(startTs, now)`）供级 6 与保守规则共用 |

## R8 修复核对表（维度 1，验收项 1）

| R8 编号 | 内容摘要 | 判定 | 说明 |
|---------|---------|------|------|
| MF-1 | 解析规格改「首部扫描」（非首条 custom）+ 覆盖率口径分列 + P4 fixture 补 hooks-first 形态 + 设计两处措辞修正 | **机制修复成立，边缘留 2 个本轮 suggestion** | 落地核对：① 解析规格已改「扫描候选文件首部前 8 条 entry」+ 实测依据句（hooks-first 第 5 条）✓；② 覆盖率按口径分列（全文存在率 ~95% / 首部可读率 8/13 后 100%、存量 0%）✓（边界精度见 INFO-2）；③ 计划 P4 fixture「hooks-first 形态：首条 custom 为 unified-hooks:loaded、identity 在第 5 条 entry → 首部扫描（8 条）仍可解析并正确配对」✓；④ 设计正文「读首条 custom entry」旧措辞已清除（grep 验证，仅剩「不是『首条 custom』」的否定引用与变更历史记录）✓。本轮独立全量复验：「前 8 条 entry」口径在新版本产物 399/399 命中（第 4 条 388 + 第 5 条 11）——R8 实测结论复现成立。遗留：「（或 16KB 字节窗）」备选口径从未实测且本轮证伪 miss 3.8%（本轮 SG-1，R8 修复方向的并列建议被 v10 原样收录）；「identity 前最多 4 条」无环境限定（本轮 SG-4） |
| SG-1 | 统一保守规则补时间分支（>7 天 → error）+ §5.2 kill -9 行补冷路径 resume 三重交集限定 | **主文落地 ✓，两处复述未同步（本轮 SG-2）** | 设计 §6.5「匹配不到 sessionFile 的统一保守规则（合并原 §7.2 的无条件 error，R8 补时间维度）」三分支完整（有终态迹象 → error；无 + ≤7 天 → streaming；无 + >7 天 → error，含「对齐级 6 GC 判别」理由与 R5-MF-2 症状复活论证）✓；§5.2 kill -9 行「限定（R8）：冷路径 resume 的续聊轮窗口期内被 kill -9（resume 续写原文件、文件名时间戳在 60s 候选窗外 + 轮次 entry 未 flush + 修正源已死的三重交集）→ sessionFile 不可解析 → 统一保守规则（≤7 天 streaming，>7 天 error）——极低频已接受边界」✓ 与主文一致；R8 给的两个修复方向（① 补时间分支 ② 挑明边界）实际同时落地且自洽（时间分支使两个入口都有界收敛，§5.2 限定把冷路径交集挑明为已接受边界）。遗留：设计 §7.2 行 355 与计划 P4 行 185 的复述仍是二分支（本轮 SG-2） |
| INFO-1 | 变更历史按时间序重排 | **被 v10 编辑回退（本轮 SG-3）** | v8 行后紧接 v10 行、v9 行在最后——v10 行插入位置错误，时间序破坏 |
| INFO-2 | resume 多 identity 全同 id（首部读取兼容）——记录防重复怀疑 | **采录 ✓** | 变更历史 v10 行③ + 链第 2 级「resume 多条 identity 实测全同 id」均有 |
| INFO-3 | worktree 候选窗适用性入 P0 探针 | **采录 ✓** | 设计链第 2 级「worktree 模式的子文件创建延迟与 60s 候选窗交互由 P0 探针覆盖」+ 计划 P0「并发配对正确性探针……顺带覆盖一个 worktree 形态启动（断言子文件名时间戳与 start entry timestamp 的间隔分布——候选窗适用性）」两文档同步落地 |

汇总：**5 条中 2 条完全成立（INFO-2/3）；MF-1 与 SG-1 的机制修复全部落地且经本轮独立复验成立，各留一个同步/精度级 suggestion；INFO-1 的排序修复被 v10 编辑回退。**

## 各维度结论

### 维度 1：R8 全等级修复质量核对（首要维度）

见上方核对表。总评：v10 对 R8 的响应率 100%（5/5 有对应动作），机制层修复质量经本轮独立实测复验全部成立——这是九轮里第一次「上一轮 must-fix 的修复在对抗复验下完整存活」（R6→R7→R8 三轮均为「机制成立、规格/口径留尾巴」模式，本轮尾巴已收窄到：一个从未实测的备选口径 + 一个绝对化断言的环境适用域 + 两处复述同步 + 一个排序回退，全部不触达方案成立性）。「首部扫描前 8 条 entry」规格本轮全量复验：新版本产物 399/399 命中（第 4/5 条 entry），**8 条余量在当前扩展组合下充足**；「扫 8 条不够时走保守」的频率与后果评估——当前内置组合实测频率 0，第三方扩展场景为开放集合（无上界断言，故 SG-4 要求声明环境依赖而非改机制），后果方向安全（规则 ② 不猜文件 → 不错误收敛，代价是收敛退化 ≤7 天）。保守规则时间分支与级 6 时间判别的关系：输入域不相交（文件路径已知 vs 匹配不到）+ 阈值/锚/时间源一致 + 「对齐」表述——无重叠矛盾，无重复实现的设计层缺陷（INFO-3 记实现层抽公共谓词建议）；start entry timestamp 锚在 sessionFile-null 场景可达性成立（主 JSONL 恒在 = 锚恒在）。

### 维度 2：全文档收口一致性（v10 后）

- **两文档间相同事实**：计划头部一句话结论「设计文档 v10」✓；P4「首部扫描前 8 条 entry」与设计解析规格一致（且计划未收录 16KB 备选——与 SG-1 的口径裁决建议方向一致）；P4 fixture「hooks-first 形态」「保守规则时间维度（≤7 天 streaming / >7 天 error）」「轮次超龄两形态」「序颠倒形态」与设计对应 ✓；P0「并发配对正确性探针 + worktree 形态」✓；级 5 锚、死行注、级 4 无软超时、`hasRunning` = streaming∨waiting 两文档一致 ✓。**唯一漂移**：设计 §7.2 与计划 P4 对统一保守规则的复述是二分支（SG-2）。
- **级序/枚举/编号**：决策 1-7、探针 A1-A10、六级矩阵、SubagentStatus 6 态、sessionFile 链 5 级、场景计数 9——除「6 个决策」计数错（INFO-1）外抽查一致，无新漂移。
- **已接受边界表述**（前八轮裁决项复查）：`.alive` GC 30 天+ 活进程错误收敛（owner 裁决 + 单独立项路径）✓ 保留；冷路径 resume 三重交集（§5.2 限定）✓；worktree 候选窗（P0 探针）✓；级 3 done→stopped 瞬态（≤60s+turn 接受）✓；级 5 冷路径抖动（A10 探针实测条件化）✓；场景 9 编号插在 3/4 之间（v6 引入位置，前轮未异议）维持 ✓。表述均一致，无回退。
- **变更历史**：v10 行内容与 R8 五条发现对应准确（MF→①、SG→②、INFO→③）✓；但行序回退（SG-3）。

### 维度 3：新发现问题

SG-1（16KB 备选口径实测证伪——R8 修复方向自带的未验证并列项，前八轮从未实测过字节窗口径，新攻击面）、SG-4（8 条余量的环境适用域——扩展集合镜像机制本轮首次 read 核实，新攻击面）、INFO-1（决策计数）、INFO-2（版本边界 1 天过渡带）。**零 must-fix**：四条 suggestion 均不满足「影响方案成立/导致错误收敛/验收不可执行」判据——16KB 口径 miss 走保守规则方向安全且计划已实际锁定 entry 口径；§7.2/P4 复述漂移有 fixture 断言兜底；排序与计数是表述级；环境适用域有规则 ② 结构性兜底。

### 维度 4：方法备注

本轮的关键实测是把 R8 修复方向里「N=8 **或** 首部字节窗如 16KB」这个并列建议**当成被审对象**：R8 验证了 entry 口径（399/399）却把字节窗作为「或」选项一并写进修复方向，v10 原样收录——一个从未实测的备选规格就这样进入了权威文档。本轮对同一批数据换问「identity entry **结束位置的字节偏移**是多少」，发现 miss 全部来自 identity entry 自身携带 task 全文（17KB-62KB）——这同时解释了为什么按行口径天然稳健（读完整行）而字节窗结构性脆弱（截断在行中间）。教训与前几轮同构：**修复方向里的每个并列选项都要单独过实测，未被验证的选项进入文档时就带着「已审定案」的伪装**（v10 行甚至写着「R8 实测定案」——定案的只是 entry 口径）。收敛判据建议：SG-1/SG-2/SG-3 修复后（三处一句话级改动 + 一处行序调整），本设计文档可进入实施；SG-4 可随 SG-1 一并补。
