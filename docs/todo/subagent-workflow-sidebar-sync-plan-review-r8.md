# subagent-workflow-sidebar-sync 第八轮联合审查报告（R8，审查-修复循环收敛轮）

> 审查对象：设计文档 `subagent-workflow-sidebar-sync-design.md`（v9）+ 开发计划 `subagent-workflow-sidebar-sync-plan.md`（联合审查）
> 前序报告：R1（`-plan-review.md`，4 MF / 10 SG）、R2（`-plan-review-r2.md`，1 MF / 10 SG / 3 INFO）、R3（`-plan-review-r3.md`，4 MF / 6 SG / 2 INFO）、R4（`-plan-review-r4.md`，2 MF / 6 SG / 4 INFO）、R5（`-plan-review-r5.md`，2 MF / 6 SG / 3 INFO）、R6（`-plan-review-r6.md`，3 MF / 3 SG / 3 INFO）、R7（`-plan-review-r7.md`，2 MF / 1 SG / 1 INFO）、设计 v1 审查（`-design-review.md`）
> 审查依据：`rubric-design-doc.md`（P0/P1 清单）+ 项目 AGENTS.md + 源码交叉核实 + **本机真实 JSONL 全量实测**（声称事实前均已核实。本轮新增 read：扩展 `index.ts`（identity 子进程写入点 :326-361，env 判定 + appendEntry + catch warn）、`unified-hooks/src/index.ts`（`unified-hooks:loaded` 同为 session_start appendEntry 写入，:58-61）、`session-runner.ts`（resume 用 `--session` 续写原文件、spawn 前 `record.sessionFile = resume.sessionFile` 提前锁定、env 注入 `PI_SUBAGENT_SELF_RECORD_ID = record.id` :696/:888）、`subagent-service.ts`（record id 生成 `sa-${randomUUID()}` :1317）；git log（identity 子进程写入引入于 2026-08-13 commit e7a6c0d3d）。实测（4417 个子文件全量扫描 + 按日切分 + 抽样深查）：identity entry 在文件中的位置分布（首条 custom / 尾部 / 缺失）× 按月 × 按日；「首条 custom entry 是否 identity」逐文件判定；今日（2026-08-18）dev-0.9.2 桌面环境 11 个文件的 entry 序列深查；多 identity 文件（resume 形态）57 个全部同 id 验证；8/13 后产物主 JSONL toolResult subagentId ↔ 子文件 identity data.id 相等性 3 组复验；identity 写入延迟实测（文件创建 → identity 落盘 ≈ 1.5s））
> 审查身份：对抗式第八轮（收敛轮）——聚焦 R7 全等级修复质量核对、v9 新增机制对抗（identity-id 精确匹配 / 级 5 轮次 entry_ts 锚）、全文档收口一致性；已修复问题不重复报，除非修复本身错了。
> 本报告只报告不修改任何文档。

## Summary

1 must-fix, 1 suggestion, 3 info.

总体判断：R7 的 4 条（2 MF / 1 SG / 1 INFO）中 3 条完全修复成立；**R7-MF-1（identity-id 精确匹配）的机制核心成立，但其解析规格「读首条 custom entry」被本轮实测证伪**（MF-1）。R7-MF-2（级 5 轮次 entry_ts 锚）完全成立。

**「读首条 custom entry」不是稳定不变式（MF-1）**。identity 与 `unified-hooks:loaded` 都是各自扩展 session_start handler 里 `pi.appendEntry` 写入的 custom entry，两者的先后由**扩展加载顺序**决定——同机已实测两种顺序：2026-08-13~08-17 的产物 identity 是首条 custom（第 4 条 entry）；**今日（2026-08-18）xyz-agent dev-0.9.2 桌面环境产出的 11 个子文件，首条 custom 是 `unified-hooks:loaded`（第 4 条），identity 退为第二条 custom（第 5 条 entry）**（parentId 齐全、id 为 sa- 前缀——是新版本子进程写入，不是旧产物）。按 v9 字面规格实现（读首条 custom entry，非 subagent-identity 即判「identity 缺失」→ 保守规则），identity 主键在桌面环境**系统性失效**——并发消歧回到保守规则（秒级收敛退化为窗口+turn），且 kill -9 路径「级 6 只认 identity 确认归属的文件」读不到文件 → 保守 streaming → **§8 场景 7 的通过标准「显示 done 或 error，不是 running/streaming」在桌面环境必挂**。连带口径失实：「当前版本产物覆盖率 ~90-100%，旧版缺失」——90% 是「identity 存在于文件**任意位置**」的口径（本轮实测 2026-08 全文存在率 94.8%，R7 的 89% 同口径）；按「首条 custom entry 可读」口径实测 **2026-08 仅 10.0%（415/4170）、2026-07 为 0%**（8/13 引入子进程写入前的产物 identity 在文件**尾部**——旧实现父进程补写、id 为裸 UUID 格式——或缺失，「旧版缺失」表述亦不准）；按「扫描首部 N 条 entry」口径，8/13 后新版本产物实测 **100%**（399/399，含今日 hooks-first 形态）。修复是把解析规格从「首条 custom entry」改为「首部扫描（实测前 8 条 entry 足够：session header + model_change + thinking_level_change + 可能的 hooks:loaded + identity；prompt 在 identity 之后不会插队）」——机制本身无需改。

其余维度：级 5 锚语义实测复核成立（轮次 entry_ts = notifier flush 时刻，对 7 天判定无影响，INFO-1 记录）；`.alive` GC 边界声明、变更历史排序、P0/P4 同步全部落地 ✓；新发现一个跨「统一保守规则 + sessionFile 不可解析」的时间维度缺口（SG-1，两个低频入口，含冷路径 resume + kill -9 组合）。

## Findings

| 优先级 | 位置 | 维度 | 标记 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | 设计 §6.5 sessionFile 链第 2 级两处「（读首条 custom entry）」（规则 ①③ 段 + 连带改动段）与「当前版本产物覆盖率 ~90-100%，旧版缺失」；计划 P4 fixture（「identity 缺失 → 匹配不确定 → 保守」用例的形态域） | 维度 1 / P0-11 + P0-10 | 新发现（R7-MF-1 修复的解析规格被实测证伪） | **「读首条 custom entry」在 unified-hooks 先加载的环境下读不到 identity，按字面实现使 identity 主键在桌面环境系统性失效**。已 read + 实测双重核实：① 机制——identity（`index.ts:326-361`）与 `unified-hooks:loaded`（`unified-hooks/src/index.ts:58-61`）都是扩展 session_start handler 内的 `pi.appendEntry`，先后由扩展加载顺序决定，无顺序保证；② 实测——2026-08-13~17 产物 388 个文件 identity 是首条 custom（第 4 条 entry），**今日 dev-0.9.2 桌面环境 11 个文件（含 10:32:32 同秒 5 个并发）首条 custom = `unified-hooks:loaded`、identity 在第 5 条 entry**（parentId 齐全 + sa- 前缀 id = 新版本子进程写入，非旧产物）——「首条 custom entry 是 subagent-identity」不是不变式；③ 后果链——按字面规格（首条 custom 非 identity 即判缺失 → 保守规则）：桌面环境全部并发启动落保守 streaming（秒级收敛失效，退化为窗口+turn）；**kill -9 路径「级 6 只认 identity 确认归属的文件」→ 无文件可认 → 保守 streaming → §8 场景 7 通过标准（done/error，非 running/streaming）不可通过**；④ 覆盖率口径失实——「~90-100%」是「identity 存在于文件任意位置」（本轮实测 2026-08 = 94.8%，R7 的 89% 同口径），按解析口径（首条 custom 可读）实测 2026-08 = **10.0%（415/4170）**、2026-07 = 0%（8/13 引入子进程写入前 identity 由旧实现父进程补写在文件**尾部**、id 为裸 UUID 格式，或缺失——「旧版缺失」表述不准）；按「首部扫描前 8 条 entry」口径 8/13 后产物实测 **100%（399/399，含今日 hooks-first 形态）**——机制核心（subagentId ↔ data.id 相等性）成立，仅规格与口径错误 | 解析规格改为「**扫描候选子文件首部 N 条 entry（N=8 或首部字节窗如 16KB）寻找 customType=subagent-identity 的 custom entry**」——实测依据：identity 前最多只有 session header + model_change + thinking_level_change + hooks:loaded（prompt 在 identity 之后不会插队）；identity 写入延迟实测 ≈1.5s（文件创建 → 落盘），对终态判定（T+40s）无影响、对 start 早期重拉 miss 方向安全（streaming 保守正确）。覆盖率表述按口径分列：「全文存在率（旧口径）vs 首部扫描可读率（实现口径）——新版本产物 100%、8/13 前存量产物 0%（尾部/缺失）」。P4 fixture 补「首条 custom 非 identity（unified-hooks:loaded 在前）、identity 在第 5 条」形态断言 identity 仍可解析并正确配对；设计两处「读首条 custom entry」措辞同步修正 |
| SUGGESTION | 设计 §6.5「匹配不到 sessionFile 的统一保守规则」段 + 级 6 时间判别；§5.2 kill -9 subagent 行 | 维度 3 / P0-12（边界不闭环） | 新发现 | **统一保守规则无时间维度，「sessionFile 不可解析 + 无终态迹象 → streaming」无上界，使 R5-MF-2 裁决的「7 天/30 天后 error」在 sessionFile-null 子集上不可达**。机制链（已 read + 实测推演）：级 6 时间判别（> 7 天 + 文件不存在 → error）的「文件不存在」判定需要 sessionFile 路径——sessionFile null 的记录（identity 首部不可读的存量产物 / timestamp 候选窗外）不进级 6 判别而走统一保守规则「无任何终态信号 → streaming」，**无论多老**。两个入口：(a) 存量旧产物（8/13 前，identity 在尾部不可首部读）+ 无终态 entry 的历史孤儿（kill -9 / 级联关闭 / notify 丢失）→ 永久 streaming——R5-MF-2 要消除的「永久 running 在 30 天尺度复发」在该子集复活（主 JSONL 记录永在，GC 只删子文件）；(b) **冷路径 resume + kill -9**：chatMode idle 超时回收后续聊，resume spawn 用 `--session` 续写**原文件**（文件名时间戳 = 首次创建时刻，可能数天前）→ 60s timestamp 候选窗不含它 → identity 无从匹配 → 窗口期（轮次 entry flush 前）sessionFile 全链 miss；若父进程恰在续聊轮 60s 窗口内被 kill -9（bg-notify 修正源已死）→ 保守 streaming 永久——§5.2 kill -9 subagent 行「子进程已死 → 读子进程 JSONL 末行 → done/error」对该形态不成立，v9「零时序假设」表述未覆盖（候选圈定本身是 60s 时间窗假设）。频率评估：(a) 随 8/13 前存量产物被 30 天 GC 自然收缩（但主 JSONL 记录与保守 streaming 显示不随 GC 消失）；(b) 需「idle>5min 回收 + 续聊 + 60s 窗口内 kill -9」三重交集，极低 | 二选一：① 统一保守规则补时间分支——「start entry timestamp 距今 > 7 天 + sessionFile 不可解析 + 无终态迹象 → error」（对齐级 6 GC 判别与 normalize default→error 的既有理由「未知更可能是终态」；正常 start 早期不受影响）；② 显式挑明两个入口为已接受边界（owner 裁决，同 `.alive` GC 边界的处理范式），§5.2 kill -9 行补「冷路径 resume 窗口期形态除外」限定 |
| INFO | 设计 §6.5 级 5（轮次 entry_ts 锚语义） | 维度 1 / 已核实为真 | — | **级 5 锚的 timestamp 语义实测澄清（结论支持 v9）**：轮次 bg-notify entry 的 entry timestamp 是 pi `appendEntry` 时刻 = **extension notifier 60s 窗口 flush 发送 sendMessage 的时刻**，非轮次完成时刻（延迟 ≤60s；若窗口内还有其他 background 完成则被滑动重置、可能更长）。对 7 天超龄判定无实际影响（分钟级延迟 vs 7 天阈值）；「轮次 entry_ts 距今 > 7 天 = 7 天无续聊活动」的语义在 flush 延迟下仍成立（flush 时刻 ≥ 完成时刻，误差方向只可能使超龄判定**晚**触发 ≤60s）。v9「轮次 entry_ts 每轮刷新」表述成立 | 无需动作（记录 flush-时刻语义防后续轮次重复怀疑；若追求精确可在级 5 行补一句「entry_ts ≈ flush 时刻」） |
| INFO | 设计 §6.5 链第 2 级（resume 兼容性） | 维度 2 / 已核实为真 | — | **resume 形态的 identity 兼容性实测通过**：chatMode 冷路径 resume 每轮 spawn 都重新注入 `PI_SUBAGENT_SELF_RECORD_ID = record.id` 并再次触发 session_start（SR-3：new/existing 都注入 handler）→ 同一子文件被 append 多条 identity entry（实测 57 个多 identity 文件**全部同 id**，0 个 mixed）——首部第一条 identity 与后续追加的 id 恒等，「首部读取」对 resume 兼容。fork 派生的孙进程有自己的 record id 与自己的子文件（其 toolResult 落在子进程 JSONL 而非主 JSONL，不进 extractor 记录集），不影响主 JSONL 匹配 | 无需动作（记录防重复怀疑） |
| INFO | 设计 §6.5 链第 2 级（worktree 候选窗适用性）；计划 P0 探针 | 维度 2 / P1-8 | 新发现（未验证项提示） | **worktree 模式的子文件创建延迟与 60s timestamp 候选窗的交互未实测、v9 未声明**：worktree 模式下 spawn 需等 worktree ready（git worktree add 耗时随 repo 规模增长），子文件创建可能晚于普通模式——若超出 60s 候选窗则 identity 无从圈定（落保守 streaming，方向安全）。本轮无实测数据、不作超窗断言；R6 已核实 worktree 下目录编码一致（enc(ROOT cwd) 段），仅时间窗适用性空白 | P0「并发配对正确性探针」顺带覆盖一个 worktree 形态启动（断言子文件名时间戳与 start entry timestamp 的间隔分布），或在链第 2 级补一句「worktree 模式候选窗适用性由探针覆盖」 |

## R7 修复核对表（维度 1，验收项 1）

| R7 编号 | 内容摘要 | 判定 | 说明 |
|---------|---------|------|------|
| MF-1 | 并发消歧主键换成 identity-id 精确匹配（序配对证伪陈述 + 主键规则 ①②③ + 诚实边界句重写 + 级 6 文件使用条件收紧 + timestamp 窗降级为候选圈定 + P0 探针 + P4 fixture） | **部分成立（解析规格缺陷）** | 全部部件落地 ✓：主键机制核心成立——相等性 3 组复验（主 JSONL toolResult details.subagentId = 子文件 identity data.id 精确相等，sa- 前缀双轨）；写入链恒等（env `PI_SUBAGENT_SELF_RECORD_ID = record.id` 注入 → 子进程 session_start appendEntry，id 生成点 subagent-service.ts:1317 同源）；resume 同 id（57 文件全同）、fork 孙进程不进主 JSONL、worktree env 相同；诚实边界句、级 6 收紧、P0「并发配对正确性探针」、P4「序颠倒形态 + identity 缺失 → 保守」fixture 均可见 ✓。但「（读首条 custom entry）」解析规格与实测数据形态不符（今日桌面环境首条 custom = unified-hooks:loaded，identity 在第 5 条 entry）+「覆盖率 ~90-100%」口径混淆（全文存在率 vs 首部可读率：后者实测 2026-08 仅 10.0%）——本轮 MF-1 |
| MF-2 | 级 5 超龄锚改为轮次 entry 自身 timestamp + 死行注对齐「done 或 error」+ P4 两形态 fixture | **已修复 ✓** | 级 5 条件重写（轮次 entry 自身 entry_ts 距今 ≤ 7 天，超龄落级 6）✓；锚语义正确（entry_ts 每轮刷新实测复核，flush-时刻语义见 INFO-1，对 7 天判定无影响）；死行注「（文件存在读末行 → done 或 error），waiting 不再无上界」与级 6 落点表述一致 ✓；P4「轮次超龄两形态」（start > 7 天 + 轮次新 → 未超龄 waiting 防误杀回归；轮次 entry > 7 天 → 级 6）✓；级 6 时间判别锚（start entry timestamp）与超龄形态自洽（轮次超龄 ⇒ start 更老 ⇒ > 7 天 ⇒ 文件存在读末行 / 不存在 error）✓ |
| SG-1 | `.alive` 被 GC 删后 30 天+ 活进程错误收敛边界挑明（owner 裁决 + 单独立项路径） | **已修复 ✓** | 级 6 GC 括号「**已接受边界（owner 裁决）**：`.alive` 被删且子 `.jsonl` 因 pid 豁免保留时……接受该极端边界；若未来不接受，扩展侧 `.alive` 补 heartbeat 或 GC 加兄弟文件检查需单独立项」完整落地，与 R7 修复方向 ① 一致 |
| INFO-1 | 变更历史按时间序重排 | **已修复 ✓** | 附录 v1→v2→…→v9 严格时间序（本轮逐行核对） |

汇总：**4 条中 3 条完全成立；MF-1 部分成立（主键机制成立、解析规格与覆盖率口径各留一个本轮 must-fix 的组成部分——合并为一条，因同根：口径/规格都来自「identity 在文件中的位置」这一未经全量实测的假设）。**

## 各维度结论

### 维度 1：R7 全等级修复质量核对（首要维度）

见上方核对表。总评：v9 对 R7 的响应率 100%（4/4 有对应动作）；R7-MF-2 / SG-1 / INFO-1 三条完全成立。R7-MF-1 的修复质量呈现与 R6→R7 相同的模式但程度更轻：**机制核心（identity-id 相等性）经本轮独立实测复验成立**（R7 实测 + 本轮 3 组复验 + 写入链同源推导 + resume/多 identity 边界实测），失效点收窄到「解析规格」（读首条 custom entry）与「覆盖率口径」（全文存在 vs 首部可读）——两者同根于「identity 在文件中的位置」这一 R7 轮只验证了「存在」与「（当时环境的）首条」而未做全量位置分布实测的假设。本轮全量扫描 4417 个子文件 + 按日切分定位版本边界（8/13 = identity 子进程写入的引入日），发现位置分布强烈依赖扩展加载顺序（hooks-first 桌面环境实测存在且正是今日产物形态）与产物版本（8/13 前全部尾部/缺失）。修复成本极低（规格一句话 + fixture 一个形态），架构无需动。

### 维度 2：全文档收口一致性（v9 后）

- **两文档间相同事实**：计划头部版本号 v9 ✓；P0「并发配对正确性探针（R7）」与设计诚实边界/级 6 收紧对应 ✓；P4 extractor 行（identity 主键 + 序配对证伪陈述 + 「identity 缺失 → 保守」+ timestamp 窗仅圈定）与设计链第 2 级一致 ✓；P4 fixture「序颠倒形态（identity 匹配仍正确）」「轮次超龄两形态」✓；级 5 锚（轮次 entry 自身 entry timestamp ≤ 7 天）两文档一致 ✓；死行注「done 或 error」与级 6 落点一致 ✓。
- **级序/枚举/编号体系**：决策 1-7、探针 A1-A10、六级矩阵、SubagentStatus 6 态、sessionFile 链层级、场景计数 9——抽查一致，无新漂移。
- **MF-1 的两文档同步点**：设计两处「读首条 custom entry」（规则段 + 连带改动段）需改；计划 P4 的「首部 identity 解析（连带）」措辞本身宽松无错，但 fixture 形态域需补 hooks-first 形态。
- 一句话结论、§5.1 时间线、§5.2、变更历史 v9 行——与正文一致 ✓。

### 维度 3：新发现问题

MF-1（解析规格 + 口径）、SG-1（统一保守规则时间维度缺口，两入口）、INFO-1（级 5 锚 flush-时刻语义，支持 v9）、INFO-2（resume 兼容性，支持 v9）、INFO-3（worktree 候选窗未验证提示）。收敛性检查：SG-1 的入口 (a) 与 R5-MF-2 同域但**未被其裁决覆盖**（R5-MF-2 修复假设「文件不存在」可判定，sessionFile-null 使判定不可达——是修复的结构性缺口而非重复提起）；入口 (b) 冷路径 resume 是前七轮未触达的新攻击面。

### 维度 4：方法备注

本轮的关键实测是「**identity 在文件中的位置分布**」：R7 验证了「存在」（全文 grep 口径）与「当时环境的首条 custom」，本轮对同一批数据换问「**在哪个位置、按什么分布**」，用 4417 文件全量分类（首条 custom / 前 4KB / 任意位置 / 缺失）+ 按日切分（定位 8/13 版本边界）+ 今日产物深查（发现 hooks-first 形态）三步，把「覆盖率」拆成三个口径（全文存在 94.8% / 首条 custom 10.0% / 首部扫描 100%）。教训与前几轮同构：「字段存在」≠「位置可预期」≠「规格口径可达成」是三层断言——解析规格必须对「首条」这类顺序性声称做形态分布实测，尤其在多扩展共享同一事件钩子（session_start appendEntry）的场景，写入顺序由扩展加载顺序决定而非协议保证。

## 已核实为真的关键引用（本轮新增核实）

扩展侧：identity 子进程写入点（`index.ts:326-361`——env 判定 `PI_SUBAGENT_SELF_RECORD_ID`、`pi.appendEntry(IDENTITY_CUSTOM_TYPE, identity)`、`identity.id = selfRecordId`、catch 仅 warn；「identity 只在子进程写一次」注释）；`unified-hooks/src/index.ts:58-61`（`unified-hooks:loaded` 同为 session_start handler 内 `pi.appendEntry`）；session-runner.ts（resume 选项 `--session <sessionFile>` 续写原文件 :632、spawn 前 `record.sessionFile = resume.sessionFile` 提前锁定 :696、env `PI_SUBAGENT_SELF_RECORD_ID = record.id` :888、chatMode/worktree env :906-911）；subagent-service.ts:1317（record id = `sa-${crypto.randomUUID()}`）；git log（identity 子进程写入引入 commit `e7a6c0d3d` 2026-08-13「V2 continuous chat core paradigm」）。

**真实 JSONL 实测（4417 个子文件全量）**：位置分布（首条 custom = identity：415；identity 存在但非首条 custom：3755，其中首条 custom 全部为 `unified-hooks:loaded`；无 identity：216）；按月（2026-07：FC 0/247；2026-08：FC 415/4170 = 10.0%）；按日（8/12 前 FC = 0；8/13-8/17 FC = 100%，共 388；**8/18 的 11 个文件首条 custom = unified-hooks:loaded、identity 在第 5 条 entry**——dev-0.9.2 桌面环境、含 10:32:32 同秒 5 个并发，identity ts 10:32:33.944 / 文件创建 10:32:32.475 ≈ 1.5s 写入延迟，parentId 齐全、id = sa- 前缀）；「扫描前 8 条 entry」口径 8/13-8/18 全命中（399/399）；多 identity 文件 57 个**全部同 id**（0 mixed）；相等性复验 3 组（2026-08-17 主 JSONL toolResult `details.subagentId` = 子文件 identity `data.id`，details.sessionFile = None 再确认）；旧产物（2026-07-20 样本）identity 在文件**末行**（line 101/101）、id 为裸 UUID（无 sa- 前缀）、首条 custom = unified-hooks:loaded。
