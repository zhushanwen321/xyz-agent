# 对抗式审查报告：composer-gen-stats.md

> 审查依据：`rubric-design-doc.md`（P0-1~P0-18 / P1-1~P1-10）+ 项目 AGENTS.md 不变量。
> 事实核查方式：全部文档声明的关键代码事实已 read 实装源码逐一核对（worktree 实装 + node_modules pi-ai 0.84.4 dist + pi-statusline 只读参照）。

## Summary

3 must-fix, 7 suggestions.

骨架、方案对比、验收、错误规格、探针纪律整体质量高：五段齐全、结论先行、三方案两维度对比、⛔ 探针带降级路径、验收回溯目标且有负面行为场景（§4 场景 5）。核心问题集中在三处：**协议无值编码违反本项目既有 [HISTORICAL] 协议收敛纪律**、**per-session 显示语义与 per-model 全局存储的矛盾未解决**、**防脏样本阈值与声称的蓝本不符**。

## 事实核查结果（P0-11 基础）

已核实为**准确**的声明：
- `handleTurnEndPi` 在 event-adapter.ts:356，确实只取 `usage.totalTokens` 产出 turn-usage，cacheRead/cacheWrite/output/model 丢弃 ✓
- `handleTurnEndPi` 中 `!usage?.totalTokens` 返回空（纯工具 turn 无样本的前提成立）✓
- interpreter `turn-start` case（:295-310，含 turnGen 代际）与 `turn-usage` case（:325-331，现只调 onContextUpdate）✓
- types.ts:216 turn-usage kind 只有 sessionId/inputTokens/totalTokens ✓
- protocol.ts:1100-1105 context.update 契约 + D1 收敛注释 ✓
- shared/paths.ts:40 `getDataDir()` 读 `XYZ_AGENT_DATA_DIR` ✓
- pi-ai types.d.ts:265 `Usage`、:307 `AssistantMessage`（含 provider/model/responseModel）✓
- pi-statusline cache.ts persistDailyRecord（tmp+rename 原子写、30 天 GC、`replace(/[/\\\s:]/g,'_')` 安全化）、speed.ts 加权平均 `Σtokens/Σduration`、cacheRatio null 语义 ✓
- useContextUsage.ts 五件套范式（分区/恢复腿/0 帧哨兵/in-flight 去重/cleanup）与文档描述一致 ✓
- Composer.vue composer-bar（:90）内 ContextCapacityPopover（:104）挂载点 ✓；i18n `cacheHit` key 存在（panel.ts:135，文档写 :129，属 P1-8 行号偏移）

核实为**错误/不符**的声明：见 MF1、MF3、S4。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D4 / §3.4 | P0-11 事实 + P0-12 副作用 | **`speed.current=0` 表示「样本不可用」直接违反本项目自己的协议收敛纪律**。protocol.ts:1103-1104 明文 [HISTORICAL]：「无值以『字段缺失』表达，禁止 ?? 0 编码（0 物理上不可能是真值）」；useContextUsage.ts:130-133 的 0 帧哨兵正是这条纪律的前端防线。且 0 **并非物理不可能**：output 小 / duration 长（如 output=3、duration=80s）经 `Math.round` 合法得出 0 t/s（pi-statusline avgSpeed 同样可返回 0）。同一帧内 speed 用 0 编码无值、cacheRatio 用 null 编码无值，语义不对称，文档还自我引用了 D1 收敛史（「无值怎么编码的协议论证」）却在新帧上重蹈覆辙。恢复腿「无任何数据时 speed.current=0」会把「无数据」伪装成「测得 0 速度」，UI 无法区分「—」与 0。 | speed 各字段改 `number \| null`（或 optional 字段缺失语义），与 cacheRatio 对齐；0 只允许作为真实测量值出现。G3 的「不闪 —」靠恢复腿时机保证，不靠 0 填充 |
| MUST_FIX | §1 G3 / §3.3 D3+D4 / §4 场景 4 | P0-10 因果 + P0-12 遗漏 | **per-session 显示语义与 per-model 全局存储之间的矛盾未解决**。存储（D3）只有 per-model 日记录，**无任何 session 维度**；但 ① G3/场景 4 要求「切 session 立即显示**该 session** 的值」「重启后显示与重启前一致的**最近一次 current 值**」——「最近一次样本」只存在内存（GenStatsService），runtime 重启即失，落盘文件里只有日记录数组，无法回答「这个 session 的最近一次是什么」（数组末条是**该模型全局**最近一条，可能来自别的 session）；② 场景 4「切到另一个无数据 session 显示『—』」——runtime 凭什么判定一个 session「无数据」？③ 「今日均值」（浮层）是**该模型跨全部 session 的 day** 还是本 session 的 day？三个问题文档均未回答，`snapshot(sid: string)` 签名收了 sid 但语义悬空。这不是实现细节：它决定要不要持久化 per-session 快照（如 session 级 index 文件）、RPC 返回什么、以及场景 4 是否可测。 | 在 D3/D4 明确一组语义并自圆其说。可行口径举例：trigger 显示「该 session 最近一次样本」（需 per-session 快照持久化，或接受重启后显示该模型全局最近样本并改写场景 4 验收）；「今日均值」明确为 per-model 全局 day 并在浮层文案注明。任选，但必须写死且与 §4 验收一致 |
| MUST_FIX | §3.3 D7 | P0-11 事实 | **防脏样本阈值与声称的蓝本不符**。文档写「`outputTokens > 1000 && durationMs < 1000`，pi-statusline index.ts BOGUS_OUTPUT_THRESHOLD / BOGUS_DURATION_THRESHOLD_MS 同款判定」——实装为 **50 tokens / 100ms**（pi-statusline src/index.ts:61-62, :250）。文档阈值比蓝本松 20×/10×：「算法对齐 pi-statusline」是 §1 一句话结论级的承诺，且 D7 的存在理由（G2「今日均值长期可信」）依赖阈值有效——1000ms 的窗口会把大量含网络等待的正常样本误判为 bogus 或反过来放过真正的缓存回放异常。 | 要么照抄 50/100，要么明示偏离并给理由（如 xyz-agent 场景模型更快故放宽至 N）；禁止在证据栏写「同款判定」而数值不同 |
| SUGGESTION | §3.3 D2 | P0-11（降级：探针覆盖面不足） | 探针只验「1 turn = 1 assistant message 配对数」，未覆盖**turn 内 LLM 请求自动重试/续传**：pi 在一个 turn 内重试失败请求时，turn-start→turn-usage 时长含重试退避等待，速度被低估；而「改挂 message_start/end 对」的降级路径是否真的能切分重试段，文档未论证。建议探针追加「含工具调用会话中 turn 级 duration 与 message 级 duration 的数值对比」（不只是配对数），若系统性偏大即触发降级方案评估。 | 扩探针比对 duration 数值；在待验证检查点中补「pi turn 内重试是否存在及其事件形态」 |
| SUGGESTION | §3.3 D3 | P0-12 边界 | `<safe-model>` 文件名安全化沿用 pi-statusline 的 `replace(/[/\\\s:]/g,'_')`，非单射：`a b` 与 `a_b` 碰撞混计；macOS 默认大小写不敏感文件系统下 `Glm`/`GLM` 碰撞；model id 无长度上限，`provider__model` 可超 255 字节文件名限制。pi-statusline 单用户 TUI 可容忍，xyz-agent 多 provider 共存放大了碰撞面。 | 安全化后追加短 hash 后缀（如 `${safe}.${hash(provider+model).slice(0,8)}.json`）+ 超长截断；P2 单测补碰撞用例 |
| SUGGESTION | §3.3 D3 | P1-5 完整性 | 日 key 沿用 `toISOString().slice(0,10)`（UTC）——「今日均值」的日边界对中文用户是本地 08:00，浮层叫「今日」会与直觉相悖。文档未声明时区口径。 | 明示 UTC 或本地时区（推荐本地，与 usage-stats 的 day 分组口径核对一致）并写入 D7/D3 |
| SUGGESTION | §2.2 事实 2 | P1-8 事实 | 「`handleAgentEnd`（:283-345）同理只留 input/output/totalTokens」不准确：实装把整个 `usage` 对象（含 cacheRead/cacheWrite）透传进 turn-end kind（event-adapter.ts:344；types.ts:208 的 turn-end usage 类型也含 cacheRead/cacheWrite），只是 message.complete 的 WS usage 裁剪为三字段。不影响 D1 决策（采集点选 turn-usage 路径正确），但「翻译层丢弃」的断言强度被削弱——数据在 agent_end 路径上其实已经流到 interpreter。 | 修正表述；顺带在 D1 论证中说明为何不用 turn-end(agent_end) 的 usage（每循环仅一次、非 per-turn），堵住「是否重复采集」的读者疑问 |
| SUGGESTION | §3.3 D8 | P0-12（降级） | 多 session 并发写同一模型文件：runtime 单进程 + 同步 IO 下天然串行，无竞态；但这是隐式依赖——若 store 读写改为 async（如 P2 重构）即出现 read-modify-write 竞丢样本。 | 在 D8 加一句约束：「read→append→write 必须在同一同步临界段内完成（单线程事件循环 + 同步 fs 是正确性前提）」 |
| SUGGESTION | §4 场景 3 | P1-8 表达 | 步骤写「`ls ~/.xyz-agent/pi/agent/`」与准则②「`~/.pi/agent/` 无新增」混用两处目录：项目真正的 pi agent 目录是 `<dataDir>/pi/agent`（paths.ts:50，ADR-0009），需要验证零新增的是系统 `~/.pi/agent/`。步骤比对对象写错（拿 dataDir 内的 pi/agent 与 gen-stats 比对无意义）。 | 步骤改为：比对 `~/.pi/agent/`（前后快照 diff）与 `ls <dataDir>/gen-stats/` |
| SUGGESTION | §3.3 D5 | P1-8 | i18n 引用 `zh-CN/panel.ts:129` 实为 :135（`cacheHit`）；另外 D5 说「cacheHit key 已存在可直接复用」——该 key 语义是 ContextCapacityPopover 浮层行的「缓存命中」标签，与新触发器浮层文案是否同一含义建议实施期确认，避免复用后改一处动两处。 | 行号更正；复用决策补一句边界说明 |

## 逐项判定摘要（rubric 覆盖）

- P0-1~P0-3（骨架/delta/结论先行）：**通过**（五段齐全；层声明置顶；各章一句话结论/SCQA 开篇）
- P0-4/P0-5/P0-6（根因/体验/术语）：**通过**（§2.4 断链+无存储双根因；§2.1/§3.1 使用者视角例子；composer/turn/EventAdapter 等术语均有定义）
- P0-7~P0-9（方案对比）：**通过**（三方案 × 长期架构/短期成本/风险 + 明确裁决 + 「被否方案若用会怎样」）
- P0-10（解决问题）：**可能不完整** → 升级为 MF2（per-session 语义缺口使 G3/场景 4 的因果链断裂）
- P0-11（关键事实）：**不通过** ×2（MF1 协议纪律、MF3 阈值）；其余引用事实全部核实准确
- P0-12（副作用/遗漏）：**不通过**（MF2）；S4/S8 为降级项
- P0-13~P0-15（验收）：**基本通过**（场景真实环境可执行、回溯目标、负面行为 5a-5c 齐备、投入与改动匹配）；场景 4 的通过标准受 MF2 牵连，修 MF2 后需同步复核
- P0-16（探针）：**通过**（D2 ⛔ 探针附降级路径「改挂 message_start/end」）；覆盖面不足见 S1
- P0-17/P0-18（物理数据流/错误恢复）：**通过**（§2.2 物理数据流图含文件行号；§3.5 六行错误表全带恢复指引）
- P1 各项：P1-2 通过（拆分有 justification 列）；P1-4 通过（每条决策有被否+理由）；P1-9 通过（采用/被否/证据/效果四件套）；P1-10 通过（场景 5 负面验证）

## 结论（第 1 轮）

修完 3 条 must-fix（协议无值编码、per-session 语义、防脏阈值）后方可进入实施拆分。三条都在「写清楚口径」层面，不动摇方案 A 的架构选型。

---

## 第 2 轮复审（聚焦复审，不重查已确认项）

> 输入：R1 修订版文档（变更历史 R1 行）+ 上轮报告。审查范围限三项：① 3 must-fix 修复是否成立 + 修订方自列攻击点；② 五处联动同步交叉引用终检；③ R1 行与正文一致性。代码事实核查新增两处：session-state-projection.ts（modelId 实例播种/兜底链）与 session-model-control.ts / session-scanner.ts（modelId 写点与占位语义）。

### Summary（第 2 轮）

1 must-fix, 2 suggestions。

上轮 3 must-fix 修复全部成立：MF1 null 编码已闭合（D4/§3.4/失败路径表/P2 用例四处同步，null→「—」、0→显 0 语义自洽）；MF3 阈值 50/100 已照抄蓝本并改证据行；MF2 模型视角的静态语义（存储/恢复/切模型）自洽且被否谱系论证充分，7 条 suggestion 也已逐条落地。但修订方自列的攻击点 a 与 c 各击穿一处：

- **新 MF4（攻击点 a）**：模型视角 + per-sessionId 帧路由的组合使「live ≡ reload」在**多 session 同模型并发**时不成立——stats_update 帧带采样 session 的 sid，session A 的分区不会因 session B 的采样而刷新，但 snapshot(sid)（reload / 切回视图）返回的是**模型全局末条**（可能是 B 的样本）。live 时 A 显示旧值、reload 后变成 B 的值，构造性等价被打破；D4「效果」栏的 live ≡ reload 断言与广播路由语义均未覆盖此场景。
- **新 MF5（攻击点 c，代码实证）**：snapshot(sid) 依赖的 modelId replicated state 存在**就绪窗口与失败退避**：`registerReplicatedStates` 播种是异步竞速（session-state-projection.ts:59 注释自认「播种 refetch 三实例异步竞速」），get_state 失败还有 1s/5s/15s 退避；dead session 汇总 fallback `modelId: ''`（session-service.ts:823）、扫描占位 `modelId: ''`（session-scanner.ts:82-85 明示是占位非权威）。renderer 恢复腿在切入视图时一次性 RPC，若此刻 modelId 实例未就绪/为空，snapshot 按「查不到模型 → 全 null」返回，触发器显「—」且**无任何重拉触发**（state_changed 不驱动 stats 重拉），直到下一 turn 才自愈——G3「切 session 立即显示不闪—」在该窗口失效，场景 4 验收会随机变 flaky。
- 攻击点 b 未完全闭合（降级为 S9）：`GenStatsPartition` 单一 `status` 字段无法表达「速度 ok + 命中率 no-value」（非 cache 模型下的常态组合），部分 null → 三态的映射规则文档未写。

联动同步终检：§2.2 数据流图与 S4 修正后的事实 2 自洽（图只画 turn-usage 路径，断链表述已收窄）；§1 G3 / §3.1 / §3.4 / §3.5 / §4 / §5 六处模型视角联动一致；R1 变更历史行与正文逐条核对一致。无漏同步。

### Findings（第 2 轮，新发现）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX【新】 | §3.3 D4「效果」/ 广播时机 / §3.4 useGenStats 注 | P0-12 副作用 | **多 session 同模型并发时 live ≡ reload 断裂，广播路由语义未定义**。帧带 `sessionId`（采样 session），useGenStats 按 sid 分区只认自己的帧 → session B 完成一 turn 后，同模型的 session A 分区不刷新，仍显示 A 自己的旧 current；但 snapshot(sid) 的 current = 模型全局末条（可能是 B 的样本）——A 切走再切回 / 重启后显示的值与 live 时不同，「live ≡ reload」构造性不成立。且「session B 采样后 A 的触发器跳变」是否发生取决于广播发给谁（仅采样 session？该模型全部活跃 session？广播全体？），文档未写。附带：场景 4 ①「与重启前一致」在场景 4 的脚本下（仅 A 用过 M）可测成立，但该前提（A 的末条 = 全局末条）未在通过标准中写明，测试者若并行开同模型 session 即误报。 | 二选一并写死：① broadcast 扩展为「该模型全部活跃 session 各发一帧（各自 sid）」，live 时 A 同步刷新到全局末条，等价性恢复；② 明示接受 per-session 快照陈旧（A 显示自己最近一次采样），并把 D4「效果」的 live ≡ reload 断言收窄为「单 session 视角 ≡ reload 到自身最近样本」+ 场景 4 通过标准补前提「测试期间 M 无其他 session 采样」。同时无论选哪个，浮层「本次」文案需与语义匹配（全局末条 vs 本 session 最近一次） |
| MUST_FIX【新】 | §3.3 D4 snapshot / §3.4 GenStatsService / §4 场景 4 | P0-11 事实 + P0-10 因果 | **snapshot(sid) 的 modelId 来源存在异步就绪窗口与永久空值路径，文档「查不到模型 → 全 null」未覆盖其后果**。实证：modelId replicated state 播种是异步竞速（session-state-projection.ts:59），get_state 失败 1s/5s/15s 退避（:60）；fallback 链 `states.modelId.get()?.modelId ?? session.modelId`（:145）在扫描 session 上是占位 `''`（session-scanner.ts:82-85），dead session 汇总 `modelId: ''`（session-service.ts:823）。renderer 恢复腿切入视图一次性 RPC：若命中未就绪/空 modelId 窗口 → 全 null → 触发器「—」，且**无重拉机制**（state_changed 广播不驱动 stats 恢复），G3「立即显示、不闪—」失效直到下一 turn。首条消息未发的新 session（get_state 是否已含默认 model id 待实证）是高频踩中场景。 | snapshot(sid) 写明降级链与降级动作：① modelId 未就绪 → 恢复腿改走「等 modelId 实例 settle 后再取快照」或 renderer 侧在 `session.state_changed`（modelId 变化）时重拉一次 getGenStats（复用既有广播，不新增机制）；② modelId 恒空（dead/扫描占位）→ 全 null 属终态，明示此态显示语义；③ 待验证检查点补「get_state 对未发消息 session 是否返回默认模型 id」（实装验证，不臆断） |
| SUGGESTION【新】 | §3.4 GenStatsPartition / §3.1 失败路径表 | P0-12 完整性 | **部分 null 与单一 status 三态的映射规则未闭合**。`GenStatsPartition { status: 'unknown'\|'no-value'\|'ok'; speed; cacheRatio; model }` 的 status 是分区级单值，但常态组合「速度 ok + 命中率 null（非 cache 模型）」无法用单 status 表达；失败路径表第 1 行还把「无任何记录」标为 **unknown 态**（useContextUsage 语义里 unknown = 恢复腿未完成），与第 2 行 no-value（拉到了但无值）的既有语义打架。 | 建议 status 只承载 unknown（RPC 未返回）vs loaded 两态，speed/cacheRatio 各字段 null 自显「—」（协议已是 null 语义，前端无需再聚合一个分区级 no-value）；或明确 status 优先级规则（如任一 ok 即 ok）。失败路径表第 1 行改 no-value |

### 上轮 findings 修复核验（逐条，不重查）

- MF1（0 编码）✅：D4 全字段 `number | null`、无值编码纪律段 + 被否谱系②、失败路径表「0 可能是真实测量值」、§3.4 类型、P2 null 用例——五处一致闭合。
- MF2（per-session 语义）✅（静态语义）：模型视角定义、snapshot(sid) 语义、被否谱系③（含三反例）、六处联动改写自洽。动态面（并发广播/就绪窗口）被新 MF4/MF5 击穿，属修订引入机制的边界，非原修复错误。
- MF3（阈值）✅：50/100 照抄 index.ts:61-62，证据行同步。
- S1–S7 ✅：D2 探针数值对比 + 降级触发条件、D3 hash8 单射 + P2 碰撞用例、D3 本地时区 + 有意偏离声明、§2.2 事实 2 改写 + D1 被否栏补 agent_end 理由（与本轮实装核对一致）、D8 同步临界段、场景 3 系统 `~/.pi/agent/` 快照 diff + 两目录澄清、i18n :135 + cacheHit 复用边界——全部落地。

### 结论（第 2 轮）

修完 MF4（广播路由 / live≡reload 收窄）与 MF5（modelId 就绪降级链）后可进入实施拆分。两条均为「补写边界语义」，不动摇方案 A 与模型视角选型本身；S9 可随后一并闭合。

```json
{
  "report_file": "docs/design/composer-gen-stats.review.md",
  "must_fix": [
    "MF4【新】多 session 同模型并发：stats_update 帧按采样 session sid 路由，同模型其他 session 分区不刷新，但 snapshot(sid) 返回模型全局末条 → live ≡ reload 断裂；广播路由语义未定义，场景 4①通过标准缺「M 无其他 session 采样」前提（D4 广播时机/效果栏）",
    "MF5【新】snapshot(sid) 依赖的 modelId replicated state 播种异步竞速（session-state-projection.ts:59）+ get_state 失败退避 + 扫描/dead 占位 modelId=''（session-scanner.ts:82-85 / session-service.ts:823），恢复腿一次性 RPC 命中空窗口 → 全 null 且无重拉触发，G3「立即显示不闪—」失效；待验证点需补 get_state 对未发消息 session 的默认模型返回"
  ],
  "suggestion": [
    "S9【新】GenStatsPartition 单一 status 三态无法表达「速度 ok + 命中率 null」常态组合，部分 null→三态映射规则未闭合；失败路径表第 1 行「无记录=unknown 态」与 useContextUsage 既有 unknown/no-value 语义打架（§3.4/§3.1）"
  ]
}
```

---

## 第 3 轮复审（聚焦复审，不重查已确认项）

> 输入：R2 修订版文档（变更历史 R2 行）+ 上轮报告第 2 轮章节。审查范围限三项：① MF4/MF5/S9 修复成立性 + 修订方自列攻击点 a/b/c；② R2 六处修订交叉引用终检（含 §5 拆分表/改动地图是否漏同步）；③ R2 行与正文一致性。代码事实核查新增一处：session 删除/销毁的 runtime 侧汇聚点（session-service.ts `onSessionDestroyedHandlers`）。

### Summary（第 3 轮）

1 must-fix, 3 suggestions。

上轮三项修复中两项成立：**MF5（降级链）成立**——get_state 实时优先 + 内存映射 + replicated states + 全 null 四级链闭合，§3.5 新行恢复指引自洽；攻击点 b 的残余窗口（重启后 get_state 亦失败 → 全 null 且本次恢复腿已消费）**存在但可接受**：触发条件已从「播种竞速常态命中」收窄到「pi 真实离线」（此时用户本就无法生成，首条消息采样即自愈，§3.5 行已写明），且相比 MF5 原缺陷（pi 健康也随机命中、无重拉）已从「随机 flaky」降为「确定性离线行为」。**S9（两态化）成立**——无值由字段 null 表达、双触发器独立判定，「速度 ok + 命中率 null」自然表达，失败路径表第 1 行与 §3.4 注释同步一致。但 **MF4（扩展广播）被新反例击穿（升级为 MF6）**：反向映射只由 `recordSample` 登记维护，存在两个未覆盖的生命周期缺口——① 模型切换脏映射（有害，发错模型帧）；② 未采样 session 漏登记（重现 MF4 的 live≠reload）。

### Findings（第 3 轮，新发现）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX【新】 | §3.3 D4 广播时机 / §3.4 GenStatsService | P0-12 副作用 + P0-10 因果 | **modelKey→sids 反向映射只由 recordSample 登记维护，生命周期存在两个缺口**。**缺口 ①（脏映射，有害）**：session 在模型 M 采样后切到模型 M2，映射仍登记 sid→M；此时另一 M session 完成 turn，扩展广播会给该 sid 发一帧 **M 的指标**——前端分区按 sid 接帧、不校验帧内 model 与 session 当前模型一致，触发器会把当前模型 M2 的显示覆盖成旧模型 M 的速度/命中率（错误信息，比漏刷新更糟）；脏映射持续到该 session 自己完成下一 turn 才被 recordSample 重登记。**缺口 ②（漏登记，重现 MF4）**：同模型新建/切入但从未采样的 session 不在映射内（「全部**已知** session」实际 = 全部**采样过**的 session）——A（采样过 M）完成 turn 时，同开 B（模型 M、未采样，恢复腿已显示 M 指标）的分区不刷新；B 切走切回即得新值，live ≠ reload 在「新 session + 同模型」这一高频组合下重现，D4「所有同模型 session 的显示同步刷新」的声明与实现范围不符。场景 4⑤ 的脚本（A、B 都已采样）恰好绕开缺口 ②，验收测不出。另：文档只写「session 删除时清条目」未写接线点——实装存在汇聚点 `onSessionDestroyedHandlers`（session-service.ts:166/369/832，覆盖主动删 / deleteByCwd / 进程退出路径），应点名挂载此处。 | 映射登记点扩展为三处写入 + 一处清除，全部写进 D4/§3.4：① recordSample（既有）；② **恢复腿降级链成功解析出 modelKey 时登记**（get_state 命中即 sid→modelKey，堵缺口 ②——恢复腿是每个切入 session 的必经点）；③ **模型切换事件重登记**（若 runtime 侧有 set_model 汇聚点则挂；至少在②③不可得时声明前端帧过滤兜底：分区仅接受 model == 当前 session 模型的帧，堵缺口 ①）；④ 删除清条目点名挂 `onSessionDestroyed`。§5 P3 内容与文件改动地图补映射生命周期接线行；场景 4⑤ 加一组「B 未采样 + A 完成 turn」断言 |
| SUGGESTION【新】 | §3.3 D4 降级链 | P1-5 完整性 | 攻击点 b 的**残余窗口未在文档声明**：runtime 重启后（内存映射空）首次恢复腿若 get_state 也失败（pi 冷启动/离线）→ ③ replicated states 亦空 → 全 null 且本次恢复腿已消费，用户停在「—」直到切 session 或下一 turn。本审查判定**可接受**（触发条件已收窄至 pi 真实离线、离线期本就无生成、首 turn 广播自愈），但 D4 降级链目前以「④ 全部未命中（新 session…）」一笔带过，未把「重启 + get_state 失败」这一残余组合及其可接受性写明——实施者会误以为降级链无懈可击。 | D4 降级链④ 或 §3.5 get_state 失败行补一句残余窗口声明（触发条件 + 自愈路径 + 为何可接受），把本审查的论证落到文档里 |
| SUGGESTION【新】 | §3.4 GenStatsPartition | P1-6 减法 | 攻击点 c：两态化后 unknown 与「ok 但字段全 null」在 UI 上都渲染「—」，status 的区分**当前无任何消费方**——若两态渲染相同，status 字段是冗余机制（准则 8：先减法再加机制）。保留的合理理由只有「unknown 期可显 skeleton/loading」，但文档未写任何 unknown 期的差异化渲染。 | 二选一：① §3.4/D5 写明 unknown 态的 UI 差异（如触发器 skeleton/降透明度，恢复腿返回前短暂存在）；② 删掉 status 字段（分区值即真相：全 null = 无数据），与 useContextUsage 的差异声明改为「不设通道态」。倾向 ①（保留与既有范式对齐的钩子成本为零） |
| SUGGESTION【新】 | §5 P3 / 文件改动地图 / D4 被否谱系④ | P1-8 细节 | 三处小漏同步：① P3 内容未提「modelKey→sids 反向映射 + sessionsOfModel + 恢复腿降级链（get_state 调用）」的接线，MF6 修复后此处改动面还会扩（onSessionDestroyed 挂载）；② 文件改动地图缺组合根装配行之外的映射清理接线文件（session-service.ts 或装配处）；③ D4 被否谱系③ 句尾「无法自圆。；」标点连用（「。；」）。均不影响决策。 | 随 MF6 修复一并补齐；标点订正 |

### 上轮 findings 修复核验（逐条，不重查）

- **MF4** ⚠️（方向成立、机制被击穿）：「该模型全部已知 session 各发一帧」确实修复了上轮反例（双方都已采样场景，场景 4⑤ 验收断言正确）；但「已知 = 采样过」的登记边界引入 MF6 两缺口（脏映射 / 漏登记），广播路由的**正确性依赖映射生命周期的完备性**，文档未覆盖。
- **MF5** ✅：四级降级链闭合；get_state 为 async 可 await（session-message-handler 既有 async case 先例）；§3.5 新行 + 待验证点（model 字段格式对齐、未发消息 session 默认模型）齐备。残余窗口见 S10（可接受，仅需声明）。
- **S9** ✅：两态 + 字段 null 自洽；§3.1 失败路径表第 1 行「通道 unknown 态（从未收到合法帧）；字段级无值由 null 表达」与 §3.4 注释（刻意差异声明 + 非 cache 模型组合自然表达）一致。status 字段保留的必要性见 S11。

### 交叉引用终检（R2 六处）

六处修订互相自洽：D4 广播时机（:207）↔ 被否谱系④（:211）↔ 场景 4⑤（:329）↔ §3.4 sessionsOfModel（:277）一致；降级链（:208）↔ §3.4 snapshot 注释（:270-273）↔ §3.5 新行（:305）↔ 待验证点（:374）一致；S9 两态化（:148 失败路径表 / :287-293 §3.4）一致。R2 变更历史行①-⑥与正文逐条核对一致。漏同步仅 S12 三处（不阻塞，随 MF6 一并修）。

### 结论（第 3 轮）

MF5/S9 修复成立；MF4 方向正确但反向映射生命周期不完备被击穿为 MF6（脏映射发错模型帧 + 未采样 session 漏登记重现 live≠reload）。修完 MF6（映射登记三写一清 + 场景 4⑤ 补未采样断言）后可进入实施拆分。S9 的两态化本身成立，S11 只是逼问 status 字段的保留理由。方案 A 架构与模型视角选型历经三轮未被撼动。

```json
{
  "report_file": "docs/design/composer-gen-stats.review.md",
  "must_fix": [
    "MF6【新】modelKey→sids 反向映射仅由 recordSample 维护：① 模型切换后脏映射残留，扩展广播向该 session 发旧模型帧且前端不校验帧内 model，当前模型显示被旧模型指标覆盖（错误信息）；② 同模型未采样 session 不在映射内，A 采样后 B 分区不刷新，live≠reload 在「新 session+同模型」高频组合重现，场景 4⑤ 脚本（A/B 均已采样）测不出；删除清条目未点名接线点 onSessionDestroyedHandlers（session-service.ts:166/369/832）（D4 广播时机/§3.4/§5 P3/场景 4⑤）"
  ],
  "suggestion": [
    "S10【新】MF5 残余窗口未声明：重启后首次恢复腿 get_state 亦失败 → 全 null 且无重拉直到切 session/下一 turn；判定可接受（触发已收窄至 pi 真实离线、首 turn 自愈）但 D4/§3.5 需写明该组合与可接受性论证",
    "S11【新】两态 status 无消费方：unknown 与 ok-全 null UI 均渲染「—」，status 字段当前冗余——写明 unknown 期差异化渲染（skeleton）或删字段（§3.4/D5）",
    "S12【新】R2 漏同步三处：P3 未提反向映射/降级链接线；文件改动地图缺映射清理接线文件；D4 被否谱系③「。；」标点连用"
  ]
}
```

---

## 第 4 轮复审（聚焦复审，不重查已确认项）

> 输入：R3 修订版文档（变更历史 R3 行）+ 上轮报告第 3 轮章节。审查范围限三项：① MF6「三写一清 + 前端兜底」是否闭合第 3 轮两缺口，重点攻击写 2 挂接点的路径覆盖面与写 3 回填竞态；② S10/S11/S12 闭合核验；③ 若 0 must-fix 给出就绪结论。代码事实核查新增两处：`session.state_changed` 组合投影的发布汇聚点（session-state-projection.ts `publishStateChangedFromSnapshot` 及 modelId 实例 fetch 挂钩）与模型切换全部入口（model-service.ts 统一入口 / plugin agent-api setModel / 播种首快照）。

### Summary（第 4 轮）

1 must-fix, 2 suggestions。

MF6 的三写一清在本轮的两个预设攻击点上**均成立**：

- **写 2 挂接点覆盖面 ✅（实装核实）**：`session.state_changed` 的发布收敛于 session-state-projection.ts:437 `publishStateChangedFromSnapshot`（组合投影，modelId/thinkingLevel 实例 fetch 落定挂钩 + fallback 双写缓存触发）。模型变更的全部入口——renderer RPC `switch_model`（settings-message-handler.ts:349 → modelService.switchModel:95 统一入口）、trusted plugin `plugin.agent.setModel`（agent-api.ts:15 经同一 modelService 入口）、扫描/播种 session 的首个快照落定（fetchStateSnapshotWithStatePublish 挂钩）——最终都触发该发布。挂此处是真汇聚点，非部分覆盖。附带收益：播种首帧也会带 modelId 走写 2，重启后映射的重建面比文档声明的还宽。
- **写 3 回填竞态 ✅（判定可接受）**：恢复腿 case 内「get_state → 登记 → snapshot」为同 async 连续段；竞争窗口仅剩「snapshot 计算后、登记执行前恰有他 session 采样完成」的毫秒级交错——此时该样本帧按旧映射发出，本 sid 漏收一帧，但恢复腿 reply 本身已含最新快照，且下一采样即自愈，残余窗口有界且无害。无需机制。
- 前端兜底（帧内 model ≠ session 当前 modelId 丢弃）将写 2 防抖窗口（switchModel 直写缓存 → 实例防抖重拉 → publish，约 300ms）内的脏帧降级为无害丢弃，纵深防御成立；扫描 session 播种占位 `modelId: ''` 经写 2 登记为 sid→'' 条目，但 `sessionsOfModel` 只以真实采样 modelKey 查询，空 key 条目不可达，无害。

但顺写 2 的语义链发现**一处 MF6 修复自身的残留缺口（新 MF7）**：写 2 只重登记映射、**不向该 sid 发任何帧**——session 切到 M2 后，live 分区仍显示 M 的指标（场景 4⑥ 把「D 显示不变」写成了通过标准），而 D4 恢复腿（切走切回 / 重启）会解析出 M2 并返回 snapshot(M2)（M2 无记录则全 null「—」）——**live ≠ reload 在「切模型后、新模型首采样前」的整个窗口成立**，与 D4「效果」栏自己的 live ≡ reload 断言矛盾。这与 MF4/MF6 是同类缺口（映射生命周期闭合了，帧的生命周期没闭合），且修复极廉价：写 2 重登记成功时顺带向该 sid 推一帧新模型快照（复用既有逐 sid 发帧通道），或前端在 state_changed 的 modelId 变化时重拉一次 getGenStats（复用既有广播，不新增机制）——二选一写死即可。

S10/S11 闭合成立；S12 两处闭合、标点一处**未实际修复**（文档 R3 行声称已改，正文「。；」仍在，见 S13）。

### Findings（第 4 轮，新发现）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX【新】 | §3.3 D4 写 2 / 场景 4⑥ / D4「效果」栏 | P0-12 副作用 + P0-10 因果 | **切模型后 live 与 reload 语义分叉，D4 的 live ≡ reload 断言在「新模型首采样前」窗口失效**。写 2（state_changed 重登记）更新了映射但静默——session D 从 M 切到 M2 后：live 路径 D 分区无人发帧，继续显示 M 的速度/命中率（场景 4⑥ 将「显示不变」定为通过标准，实为把残留显示合法化）；reload 路径（切走切回 / 重启后切入）恢复腿解析出 M2 → 返回 snapshot(M2)（M2 无任何记录时为全 null「—」）。同一 session 在切模型后「不重进 = M 指标、重进 = M2 指标」，与 MF4/MF6 攻击的 live≡reload 断裂完全同类，只是触发条件从「他 session 采样」换成「本 session 切模型」。且触发器紧邻模型选择器，切换后短暂残留旧模型数字对用户有误导（G2 可解释性受损）。 | 二选一并写死：① **写 2 顺带发帧**（推荐）：state_changed 重登记解析出 modelKey 后，向该 sid 推一帧 snapshot(新 modelKey)——复用既有逐 sid 发帧通道，一行接线，live 立即切换到新模型口径；② 前端兜底升级：useGenStats 订阅 `session.state_changed`，modelId 变化时重拉一次 getGenStats（复用既有广播）。同步修订：场景 4⑥ 通过标准改为「D 切 M2 后立即显示 M2 口径（无记录则「—」）」，D4「效果」栏断言维持不收窄 |
| SUGGESTION【新】 | D4 被否谱系③（:217）/ 变更历史 R3 行⑥ | P1-8 事实 | **S12 标点项未实际修复**：R3 变更历史声称「被否谱系标点修正」，但正文 D4 被否谱系③句尾「无法自圆。；」的「。；」连用仍在（:217）。变更历史与正文不一致，属文档自述失真（准则：变更历史行必须与正文逐条对账）。 | 删「；」或改「；」前的句号为逗号；修后 R3 行无需再改（声称的修复落地即一致） |
| SUGGESTION【新】 | §3.3 D4 写 3 | P1-5 完整性 | 写 3 回填的毫秒级残余竞态（snapshot 计算后、登记执行前他 session 采样 → 本 sid 漏一帧）本轮判定可接受，但该窗口与自愈路径未在 D4 声明——实施者可能误以为恢复腿 case 内无任何竞争。 | D4 写 3 处补一句残余窗口声明（窗口有界 + 恢复腿 reply 已含最新快照 + 下一采样自愈），与 S10 残余窗口声明同风格 |

### 上轮 findings 修复核验（逐条，不重查）

- **MF6** ⚠️（两缺口闭合，修复自身引入新残留 → MF7）：缺口①脏映射由写 2 + 前端兜底双层闭合（写 2 防抖窗口内的脏帧被前端丢弃）；缺口②漏登记由写 3 + 写 2 播种附带路径闭合（未采样 session 切入即登记，「从未打开的 session 无人观察」论证成立）；清条目点名 onSessionDestroyedHandlers 汇聚点正确。但写 2 静默重登记导致切模型后 live 残留旧模型口径 → MF7。
- **S10** ✅：D4 降级链后「残余窗口声明（R3）」落地（:214），触发条件收窄论证 + 接受理由与上轮判定一致。
- **S11** ✅：分区改 `GenStatsFrame | null`（:295-299），null=从未收到合法帧，UX 差异落浮层（「暂无数据」vs 非 null 聚合），失败路径表第 1 行（:148）同步，status 无消费方的冗余消除。
- **S12** ⚠️：P3 拆分行补齐映射/降级链/清理接线（:358）✅；文件地图补 session-service.ts 接线行（:374）✅；标点「。；」未修 → S13。

### 结论（第 4 轮）

MF6 三写一清在两个预设攻击面（写 2 挂接点路径覆盖 / 写 3 回填竞态）均经实装核实成立，S10/S11 闭合；但写 2 的静默性使「切模型后、新模型首采样前」窗口 live ≠ reload（MF7），修复为一行发帧接线或前端重拉，不动摇任何架构选型。**本轮 1 must-fix，尚不满足「设计就绪（0 must-fix）」门禁条件**；MF7 + S13/S14 修完后预计可直接进入就绪判定（无新攻击面遗留）。

```json
{
  "report_file": "docs/design/composer-gen-stats.review.md",
  "must_fix": [
    "MF7【新】写 2（state_changed 重登记）静默不发帧：session 切模型 M→M2 后 live 分区持续显示 M 指标（场景 4⑥ 把「显示不变」定为通过标准），而恢复腿返回 snapshot(M2)（无记录则全 null）——live ≡ reload 在「切模型后、新模型首采样前」窗口断裂，与 MF4/MF6 同类；且触发器紧邻模型选择器，残留旧模型数字误导用户（D4 写 2 / 场景 4⑥ / D4「效果」栏）"
  ],
  "suggestion": [
    "S13【新】S12 标点项未实际修复：R3 变更历史声称「被否谱系标点修正」但 D4 被否谱系③「无法自圆。；」仍在（:217），变更历史与正文失真（D4 被否谱系 / R3 行⑥）",
    "S14【新】写 3 回填毫秒级残余竞态（snapshot 后、登记前他 session 采样 → 漏一帧，下一采样自愈）判定可接受但未在 D4 声明，补同风格残余窗口声明（D4 写 3）"
  ]
}
```

---

## 第 5 轮复审（聚焦复审，不重查已确认项）

> 输入：R4 修订版文档（变更历史 R4 行）+ 上轮报告第 4 轮章节。审查范围限三项：① MF7「写 2 重登记 + 顺带推 snapshot(M2) 帧」是否闭合「切模型后 live≠reload」窗口，含推帧与 state_changed 广播的帧序问题（前端收到两种帧的顺序无关性）；② S13/S14 闭合核验；③ 若 0 must-fix 给出就绪结论。

### Summary（第 5 轮）

2 must-fix, 0 suggestion。

S13/S14 均已闭合：被否谱系③「。；」已改「无法自圆；」，R4 行如实记录「R3 误称已修」（变更历史与正文对账恢复一致）；写 3 竞态声明落地（:211，与 S10 同风格）。MF7 修复方向正确（写 2 推帧 + 被否谱系⑦ + 场景 4⑥ 改写三处联动一致），但推帧方案自身在两个点上不闭合：

- **MF8（全 null 快照帧被前端校验拦截，MF7 的主场景不可达）**：snapshot 语义为「modelKey 未解析或无记录 → 全 null」，且 GenStatsFrame.model 约定「无样本时缺省」（:262/:280）——即 M2 无任何记录时写 2 推出的帧是 **model 缺省的全 null 帧**；而前端兜底校验是「帧内 model ≠ 该 session 当前 modelId → 丢弃」（:213/:301），缺省（undefined）≠ M2 按现文必被丢弃。结果：场景 4⑥ 声称的「D 立即显示 M2 快照（**无记录则「—」**）」中「—」分支不可达——D 分区继续显示 M 的指标，恰是 MF7 要消灭的窗口（新模型首采样前）里最常见形态（换新模型 = 该模型多半无记录）。注意恢复腿不受影响（RPC reply 直写分区、不过帧校验），所以这是 live 与 reload 的又一次分叉，只是藏在 null 分支里。
- **MF9（帧序未规定）**：写 2 推帧与 `session.state_changed` 广播同源于 publishStateChangedFromSnapshot，但文档未规定两帧发送先后。前端分区校验依赖的「该 session 当前 modelId」在插件路径（plugin.agent.setModel）下由 state_changed 帧驱动更新——若实装把 snapshot 帧先于 state_changed 发出，则前端 modelId 仍是旧值 M，snapshot(M2) 帧（有记录形态）被校验丢弃，MF7 窗口在插件切换路径原样回归。单 WS 连接有序送达 + 同一同步段内两次 send，只要规定「先广播 state_changed、后推 snapshot 帧」即可构造性闭合（renderer 按序处理，modelId 必先于 snapshot 帧落定）；同理，写 2 推帧必须位于映射重登记**之后**（否则帧内快照查映射仍是旧模型口径）。

两处修复均为一句话级规格补写（校验规则对 model 缺省帧放行 / snapshot 无记录时也回填 model=modelKey，二选一或并用；规定 send 顺序），不动摇方案 A 与三写一清架构。

### Findings（第 5 轮，新发现）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX【新】 | §3.3 D4 写 2 / 前端兜底 / §3.4 GenStatsFrame.model / 场景 4⑥ | P0-12 副作用 + P0-10 因果 | **写 2 推出的「全 null 快照帧」自带 model 缺省，被前端兜底校验丢弃，「无记录则「—」」分支不可达**。链条：snapshot「无记录 → 全 null」（:280）× GenStatsFrame.model「无样本时缺省」（:262）→ 帧 model=undefined → 校验「model ≠ 当前 modelId 丢弃」（:213/:301）→ 帧被丢 → 分区维持 M 的旧指标。MF7 的核心场景（切到无记录新模型）恰好全落此分支；场景 4⑥ 的「无记录则「—」」通过标准按现规格**必然失败**。恢复腿 reply 不经帧校验、直写分区，故 reload 显示「—」而 live 显示 M——live ≡ reload 在 null 分支再度断裂，且场景 4⑥ 验收会如实抓住（好事，说明验收可测）。 | 二选一（或并用）并写死：① **snapshot 有 modelKey 输入时始终回填 payload.model = modelKey**（无记录时 model 仍填、speed/cacheRatio 全 null）——校验语义不变，帧可通过；② 前端校验补「model 缺省的全 null 帧放行」（缺省 ≠ 脏帧，脏帧定义是 model 有值且不匹配）。推荐①（协议自描述，前端不引入特判） |
| MUST_FIX【新】 | §3.3 D4 写 2 | P0-12 边界 | **写 2 推帧与 state_changed 广播的发送顺序未规定，插件切换路径下校验时序可倒置**。renderer 的 per-session modelId 在非 renderer 发起的切换（trusted plugin `plugin.agent.setModel`，第 4 轮已核实经同一 modelService 入口触发写 2）下只能由 state_changed 帧更新；若实装先 send snapshot(M2) 再 send state_changed（同一同步段内两次 send 都合法），前端按序处理时 modelId 仍是 M → snapshot 帧被校验丢弃 → D 继续显 M 直到 M2 首采样，MF7 窗口在插件路径回归。同理未规定「重登记先于推帧」（顺序颠倒则快照按旧映射取错模型口径）。单连接有序送达使这纯属规格缺失，一句话可构造性消除。 | D4 写 2 补顺序规格：「同一同步段内，先发 state_changed 广播 → 再重登记映射 → 最后向该 sid 推 snapshot 帧」（两不变式：modelId 状态先于快照帧落定；快照按新映射计算）。§5 P3 接线行顺带带一句 |

### 上轮 findings 修复核验（逐条，不重查）

- **MF7** ⚠️（方向与联动成立，机制两处不闭合 → MF8/MF9）：写 2 改「重登记 + 推 snapshot(M2) 帧」（:210）、被否谱系⑦（:217）、场景 4⑥ 改「立即显示 M2 快照 + 后续 M 帧被校验丢弃」（:338）三处联动一致；但全 null 帧 model 缺省被自家校验拦截（MF8）、帧序未规定（MF9）。
- **S13** ✅：被否谱系③「无法自圆；」（:217）已改；R4 行③如实记录「R3 历史误称已修」，变更历史与正文对账恢复。
- **S14** ✅：写 3 处竞态声明落地（:211），毫秒级交错 + reply 已含最新快照 + 下一采样自愈 + 有界无害，与 S10 声明同风格。

### 结论（第 5 轮）

S13/S14 闭合；MF7 修复三处联动正确但机制上有两个一句话级规格缺口（全 null 帧 model 缺省被前端校验丢弃——主场景「无记录新模型」不可达；推帧与 state_changed 的帧序未规定——插件切换路径时序可倒置）。**本轮 2 must-fix，尚不满足「设计就绪（0 must-fix）」门禁条件**。两处修复均为 D4 内的规格补写（snapshot 回填 model 或校验放行缺省帧；规定 send 顺序），不新增机制、不动摇架构选型；修完后场景 4⑥ 现有通过标准即可如实验收，无其他新攻击面遗留，预计下一轮可直接进入就绪判定。

```json
{
  "report_file": "docs/design/composer-gen-stats.review.md",
  "must_fix": [
    "MF8【新】写 2 推出的全 null 快照帧 model 缺省（GenStatsFrame.model「无样本时缺省」× snapshot「无记录→全 null」），被前端兜底校验「model≠当前 modelId 丢弃」拦截——切到无记录新模型时「—」分支不可达，分区继续显示旧模型指标，live≡reload 在 null 分支再度断裂；恢复腿 reply 不经校验故 reload 显「—」，场景 4⑥「无记录则「—」」按现规格必然失败（D4 写 2/前端兜底/§3.4/场景 4⑥）",
    "MF9【新】写 2 推帧与 state_changed 广播的发送顺序未规定：插件路径（plugin.agent.setModel）下 renderer modelId 仅由 state_changed 帧更新，若 snapshot 帧先发则被校验丢弃，MF7 窗口在插件切换路径回归；且「重登记先于推帧」也未规定（颠倒则快照取旧映射口径）（D4 写 2）"
  ],
  "suggestion": []
}
```

---

## 第 6 轮复审（聚焦复审，不重查已确认项）

> 输入：R5 修订版文档（变更历史 R5 行）+ 上轮报告第 5 轮章节。审查范围限三项：① MF8/MF9 修复成立性——重点核对 model 回填规则与前端「model 缺省 live 帧丢弃」组合下场景 4⑥ 全部分支可达性、帧序规定对 RPC 路径与插件路径的覆盖；② R5 行与正文一致性；③ 若 0 must-fix 给出就绪结论。

### Summary（第 6 轮）

0 must-fix, 1 suggestion。**MF8/MF9 均闭合**：

- **MF8 ✅**：model 回填规则落在 D4 snapshot 语义（:216「modelKey 解析成功时 payload.model 恒回填（含无记录全 null 帧）；仅 modelKey 未解析（降级链④）时 model 缺省」）+ 前端校验补「model 缺省的 live 帧同样丢弃（防御：所有 live 推帧路径均有 modelKey，缺省即异常）」+「恢复腿 reply 不经此校验（RPC 主动拉取语义）」（:213）+ §3.4 snapshot 注释同步（:280-281）。**场景 4⑥ 全部分支可达性逐支验证成立**：切 M→M2 后 live 路径（写 2 推帧）——M2 有记录 → model=M2 回填、有值帧过校验；M2 无记录 → model=M2 回填、全 null 帧过校验显「—」；reload 路径（恢复腿 reply）——modelKey 解析成功 → model 回填/全 null 均直写分区不经校验，modelKey 走尽降级链④ → model 缺省 + 全 null 直写分区（此时该 session 无当前模型可匹配，跳过校验正是唯一正确行为）。live 与 reload 在所有分支同值，null 分支断裂消除。防御性丢弃规则自身逻辑自洽：live 帧的三个来源（写 1 扩展广播 / 写 2 推帧 / 写 3 后的后续帧）均有已解析 modelKey，缺省即实现 bug，丢弃正确。
- **MF9 ✅**：帧序固定为「先广播 state_changed → 再重登记映射 → 最后推快照帧」（:210），两个不变式（modelId 状态先于快照帧落定；快照按新映射计算）均由该顺序构造性保证，且写明依赖前提（单 WS 连接有序送达）与插件路径理由（renderer modelId 仅由 state_changed 帧更新）。**RPC 路径不受帧序牵连已澄清**：恢复腿是 request/reply，不与广播帧竞争同一校验点（reply 不经校验，:213），帧序规定只需覆盖广播路径——写 2 是唯一的「双帧同触发点」场景，覆盖完备。renderer 发起的切换路径（switch_model RPC）modelId 本地先更新，帧序同样无害。
- R5 变更历史行①②③与正文逐条核对一致（:210 帧序 / :216 回填 / :213 校验与恢复腿澄清 / :217 被否谱系⑧ / :280-281 §3.4 注释）。

唯一残留（S15，不阻塞）：GenStatsFrame.model 字段注释仍写「无样本时缺省」（:262，R1 版遗留）——按 R5 回填规则，缺省条件是「modelKey 未解析」而非「无样本」（无样本但 modelKey 已解析的帧 model 恒回填）。一行注释更新，属文档内部措辞滞后，不影响任何规格语义（D4 :216 与 §3.4 :280 的权威规则已写死且互相一致）。

### Findings（第 6 轮，新发现）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION【新】 | §3.4 GenStatsFrame.model 注释（:262） | P1-8 细节 | 字段注释「无样本时缺省」与 R5 回填规则（「modelKey 非 null 恒回填，缺省仅当降级链④走尽」）不符——「无样本」与「modelKey 未解析」是新规则下的两个不同条件，注释停留在 R4 前的旧语义。实施者按注释实现会在无样本分支漏回填，重新引入 MF8。 | 注释改为「modelKey 未解析（恢复腿降级链走尽）时缺省；无样本但 modelKey 已解析时恒回填」，与 :280-281 对齐 |

### 上轮 findings 修复核验（逐条，不重查）

- **MF8** ✅：见 Summary——回填规则 + 校验放行边界 + 恢复腿豁免三处联动一致，场景 4⑥ null 分支可达。
- **MF9** ✅：见 Summary——帧序两不变式构造性成立，RPC 路径经「reply 不经校验」澄清后与帧序正交。

### 结论（第 6 轮）

**设计就绪（0 must-fix）**。MF8/MF9 闭合，第 4~6 轮围绕「帧与映射生命周期」的全部攻击面（MF4/6/7/8/9）均已构造性闭合且互相自洽；S15 为一行注释同步，可在实施期（或 impl-plan 落地时）顺手修正，不构成门禁阻塞。方案 A 架构、模型视角、三写一清 + 前端兜底、固定帧序 + model 恒回填的规格体系历经六轮未被撼动。**可进入 dev-flow 阶段 0 门禁引用本结论**。

```json
{
  "report_file": "docs/design/composer-gen-stats.review.md",
  "must_fix": [],
  "suggestion": [
    "S15【新】GenStatsFrame.model 注释（:262）「无样本时缺省」仍为 R4 前旧语义，与 R5 回填规则（缺省仅当 modelKey 未解析，无样本但已解析则恒回填）不符——实施者按注释实现会重新引入 MF8；一行注释同步（§3.4）"
  ]
}
```
