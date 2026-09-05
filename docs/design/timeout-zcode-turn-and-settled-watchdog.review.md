# 对抗式审查报告：timeout-zcode-turn-and-settled-watchdog.md

> 审查依据：`rubric-design-doc.md`（P0/P1 清单，判定四态）· 项目约定：AGENTS.md 规则 19（超时默认原则）/ 规则 12（打包）/ C-proc-10（文档同步纪律）。
> 核实方法：全部影响决策的源码声明已逐一 `read` 核实（session-channel.ts / zcode-engine.ts / constants.ts / kill-chain.ts / settled-watchdog.ts / session-runner.ts / subagent-service.ts / subagent-extractor.ts / probe/p-t2c-report.md / unbounded-wait-audit.md §7.2 / impl-plan §5 / fake-appserver 基建）。
> 审查日期：2026-09（v1）。

## Summary

3 must-fix, 6 suggestions, 1 info.

**总体判断**：文档事实密度和证据锚点质量显著高于平均水平——抽查的 30+ 处行号/常量/注释引用**全部与源码吻合**（含 `constants.ts:79` 300s、`session-channel.ts:507-518` timer、`:569` final-frame 恒 success、`zcode-engine.ts:1439` 不读 status、settled-watchdog 头注释、P-T2c 探针数据 6 轮 <2ms / compact 40.1s、impl-plan §5 T2③「待回写」行等）。方案对比、被否谱系、回写义务（D10）均达标。**三处 MUST_FIX 集中在对抗式核心：复用的 abort 链在超时路径下升级分支不可达（读源码证实）、重试与清理链无时序约束（双跑/连坐面）、60min 总上界无探针标定且与自身论证矛盾**——恰好都是「方案成立依赖的运行时行为」层的问题。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §6 D3（`zcode-engine.ts:600-637` 链体引用）·波及 §2 目标 3 / §5.2 F-1 | P0-11 关键事实（外部行为时序）+ P0-12 | **「复用既有 appServerAbortChain」在超时路径下 killChain 分支不可达**。源码核实（`zcode-engine.ts:622-633`）：链体第二级的升级谓词是 `Promise.race([turn.then(()=>true,()=>true), delay 3s])`——race 对已 reject 的 promise **恒立即 resolve true**。用户取消场景下 turn 尚 pending（stop → 服务端终态 → turn 落定 → 不杀），语义正确；但 D3 新接的超时场景里 turn **在进链之前已被 channel timer reject**，race 恒真 → 恒走 `if (settled) return`，killChain 永不触发。后果：当 app-server 真正 wedged（idle 判定的目标场景——事件停了、控制面也死了），`session/stop` 3s 超时失败后**没有任何升级处置**，共享进程继续活着、对端 turn 继续烧 token——§2 目标 3「判死后清理干净」恰在最需要的形态下不成立（健康进程+模型挂起的形态 stop 能送达，止损成立；进程假死形态不成立）。文档声称的「session/stop（3s）→ grace（3s）→ 超窗 killChain」三段在超时路径实际只有第一段 | 超时路径的清理谓词不能复用已 reject 的 turn promise：以 **stop 请求本身的成败**为升级判据（stop 超时/失败 → 直接 killChain），或为超时路径写专用链段；并在 D3 显式区分「stop 送达即止损」（模型挂起形态）与「stop 失败需杀进程」（进程假死形态）两种终局 |
| MUST_FIX | §6 D6 × D3 交互（§7 engine 分流段） | P0-12 副作用/遗漏 | **重试与 abort 链无时序约束，三个衍生风险未设计**：① 双跑烧 token——catch 分流同时 fire-and-forget stop 与「用新会话重跑一次」，stop 在途（最长 3s+处理延迟）期间 app-server 侧新旧两个 turn 并行，重试越快双跑窗越长（用户核心疑问，文档未讨论）；② 若按上条修复为「stop 失败 → killChain」，killChain 杀的是**共享 app-server 进程**——刚启动的重试轮（同进程新会话）被连坐杀掉，其崩溃收割错误又恰好满足 D6 的重试条件族（但重试已用完）→ 最终错误形态被污染为「连接崩溃（已重试 1 次）」而非真实原因；③ stop 超时说明进程 wedged，此时立即重试 = 在 wedged 进程上 createSession（15s 控制面超时）空转一轮 | D6 补时序约束：重试 attempt 启动前 **await abort 链终局**——stop 确认送达即启重试；stop 失败 → 等 killChain 完成 + 连接重建（`ensureAppServerRuntime` 惰性重建路径）后再启；把该序列写进 §7 engine 分流与 U4 拆分，A5 验收补「stop 在途时不出现第二个服务端 turn」断言 |
| MUST_FIX | §6 D1（60min 总上界）+ §2 目标 1 + §11 探针纪律段 | P0-16 运行时断言无探针 + P0-10 自洽性 | **`ZCODE_TURN_MAX_TIMEOUT_MS=60min` 是无探针标定的推理值，且与文档自身三处声明矛盾**：① §11 明言「本设计所有时长默认值要么挂已执行探针（P-T2c），要么挂实施期门探针（P-Z1/Z2）」——但 P-Z1 只标 **idle 30min**（inter-event gap），P-Z2 标 error 事件序，**60min 总上界两者都不覆盖**，恰是文档自己总结的「推理值先上、实测后推翻」形态（300s 前车）；② D1 归属论证断言「正常路径（活跃事件流）永不被时间本身判死」——与 D1 方案表风险列「>60min 合法超长任务被上界杀（env 可关）」直接矛盾：一个流式活跃的 90min 合法任务会在 60min 被时间本身判死（对照面：pi 侧 spawn watchdog `max(30min, maxTurns×5min)` 随 maxTurns 伸缩，maxTurns=20 → 100min > 60min）；③ §2 目标 1「全程流式执行不被超时机制中断」无 >60min carve-out，§5.1 只演示 17min。对 B 方案的核心批评「只是把误杀线后移，量级错配根因仍在」**同等适用于 A 方案的上界组件在 >60min 任务上的行为**——被否谱系没有挡住这种情况，只是把线从 300s 移到 60min（idle 组件确实根修了静默误判，但上界组件对该人群仍是 B 形态） | ① 给总上界加实施期门探针：扫 T001 34 任务 + 新采样的**任务总时长分布**（不是 gap 分布），并对照 pi 侧同类任务 spawn watchdog 实际生效值分布；预定义降级路径（如合法任务 P99 总时长的 ×2、或默认上调至 4h 档）；② §2 目标 1 / D1 / §5 补 >60min carve-out 与量化预期（多大人群受影响、错误文案如何引导 env 调整）；③ §11 的「全覆盖」声明改为如实列举 |
| SUGGESTION | §6 D9 中段（+ §11 P-Z 族） | P1-6 加机制先例缺角（ADR-0047 张力） | 中段宣称「与本仓 keep-alive 范式同构」，但 keep-alive 先例（`session-runner.ts:190-197`）静默 30min fire 时**先复核存活活跃后代**（「静默 ≠ 卡死」的具体化），D9 的中段静默 fire 直接 kill 无任何复核——chatMode 轮内一次 >30min 无 stdout 事件的长工具执行（长构建/子任务）会被判 wedged。现状 10min 全程窗对该形态更差（非回归），且比 D1 的 idle 少了 P-Z1 这样的标定门（P-Z1 只采 zcode 侧 gap） | 登记该残余误杀面到 D9 风险列；实施期用 pi 侧真实会话日志采 chatMode 轮内 inter-event gap 分布（类比 P-Z1），若长工具形态真实存在，考虑 fire 时 get_state 复核或阈值上调 |
| SUGGESTION | §7 U1 / D5 ①（`session-channel.ts` 泵内归因） | P0-12 细分（不阻塞，P-Z2 门控兜底） | 「turn.terminal 晚于 final-frame settle 到达也把 status 记下来」**还依赖泵内归因改动，U1 未提**：现状 `lookupTurn` 对无 sid 的 telemetry 帧走「唯一**未落定** turn」归因（`session-channel.ts:523-528`），已 settle 的 turn 被排除——迟到的 turn.terminal（A.2 明示 telemetry 帧不带 sid）根本路由不到该 turn，`lastTerminalStatus` 记录静默不生效 | U1 补充：迟到 terminal 的泵内路由需放宽归因（settled turn 仍可接收 terminal 记录，只不改写落定）；⚠️P-Z2 落地时把「迟到 + 无 sid」形态纳入帧序记录 |
| SUGGESTION | §6 D6 / D4（§7 engine 分流段） | P0-12 细分 | 「连接崩溃类（onClose failAllTurns 的错误）→ 同入重试判定」——`failAllTurns` 用裸 `Error(reason)` reject（`session-channel.ts:345-353`），engine 侧判别只能靠字符串/来源推断，与 D4 自己立的「类型化判据、不经字符串匹配」纪律不一致 | 收尾段错误同样类型化（如 `ChannelClosedError`），TurnTimeoutError / ChannelClosedError 两判据族并列 |
| SUGGESTION | §8 A2 通过标准 | P0-14 细分（可测性） | 「判死后无新增 token 消耗（对照 ZCode 桌面端用量）」测量口径模糊：桌面端用量面板的粒度/刷新延迟未知，30min 级窗口内的小额 token 增量很可能低于其分辨率 → 通过标准实际不可判定 | 改用 app-server 侧可落盘证据：journal/SQLite usage 记录（`ZCODE_POOL_DB_RELATIVE_PATH`）判死时刻前后快照对比，或 app-server 日志中 stop 后的 turn 生命周期事件 |
| SUGGESTION | §8 全表 | P1-10 负面行为无验收 | 两类「不该发生/逃生门」行为无场景：① env `≤0 关闭`（idle 关闭 / 上界关闭 / settled 两段关闭）的实际行为——A2/A3/A8 只用 env 调小加速，从未验证关闭后「另一层仍在」与 warn 提示；② >60min 活跃任务被上界杀的用户可见形态（F-2 文案 + env 指引是否足以自救）无场景 | 补 1 个 env 关闭行为场景（如上界 =0 时 chatty-wedge 由 idle 层兜底/挂起形态如实呈现）；>60min 形态至少以 env 缩阈值等价模拟验证文案与逃生指引 |
| SUGGESTION | §3.2 缺陷 C 证据（pi clone 引用） | P1-8 事实细节（不阻塞） | `settings-manager.ts:32`、`agent-session.ts:2814-2833`（`_prepareRetry`）经核实**存在于 clone 且内容相符**，但 clone 版本 0.84.2 **落后实装 0.84.4**——AGENTS.md 明示「引用前须核对 clone 版本与实装一致」（C-proc-08 纪律，曾有按旧 clone 断言连产 4 条漂移 bug 的前科）。此处为重试先例的旁证（非承重 API），降级 SUGGESTION | 实施期对实装 dist（`npm ls @earendil-works/pi-coding-agent` 核对 0.84.4）复核一次双层重试默认值；文档引用处标注 clone 版本 |
| INFO | §7 openTurn 段 | 表述赘述 | 「事件到达点…session/create 应答」列为 idle 刷新源——create 应答在 `openTurn` 挂 timer **之前**到达（runTurn 先 createSession 后 openTurn），刷新不到任何 timer，无害但易误导实施者 | 删去该刷新源或注明仅为完整性 |

## 判定四态（P0/P1 主项）

| 检查项 | 判定 | 依据（位置） |
|---|---|---|
| P0-1 五段骨架 | 通过 | §1/§2/§3/§6-7/§8/§10 全在，层声明明确 |
| P0-2 delta 链 | 通过 | 附录变更历史 v1 + 被否谱系引用 |
| P0-3 结论先行 | 通过 | 各章「本章结论」+ SCQA 开篇 |
| P0-4 问题定义触根因 | 通过 | §4 三连根因（量级错配/固定预算非 idle/判死三不管）+ settled 标定对象错位独立成条，均有实测证据 |
| P0-5/6 使用者视角/术语 | 通过 | §3.1/§5.1 叙事 + §1 关键术语定义（turn 双引擎粒度差、回收层、假成功） |
| P0-7/8/9 方案对比 | 通过 | D1/D2/D9 三表均 ≥3 方案 × 两维度 + 明确裁决；D3-D8 被否理由在条目内 |
| P0-10 因果链 | **不通过（部分）** | 见 MUST_FIX #3：目标 1 的「不被中断」断言与上界行为矛盾；idle/两段式对根因的修复本身成立 |
| P0-11 影响决策的事实 | **不通过（一处）** | 见 MUST_FIX #1：对复用 abort 链在超时上下文的行为断言与源码不符（race 谓词恒真）。其余 30+ 处引用逐一核实无误 |
| P0-12 副作用/遗漏 | **不通过（两处）** | MUST_FIX #2（D3×D6 时序）+ SUGGESTION #5/#6（迟到 terminal 路由 / 崩溃类判据类型化） |
| P0-13 验收存在/testable | 通过 | §8 九场景均有明确通过标准与真实路径 |
| P0-14 真实场景非 mock | 通过（一处可测性弱） | A1/A4/A5/A6/A7 真实桌面端+真实模型；A3 fake app-server 有「无法注入 chatty-wedge」的如实标注与机制等价论证（fake-appserver.mjs 基建核实存在）；A2 测量口径见 SUGGESTION |
| P0-15 验收投入匹配 | 通过 | 大改动 ↔ 九场景 + 三阶段映射（§9）+ 负面验证 A6 |
| P0-16 探针纪律 | **不通过（一处）** | MUST_FIX #3：60min 上界零探针且 §11 自称全覆盖；⛔P-Z1/Z2/Z3/Z4 均有门位与降级路径（合格） |
| P0-17 物理数据流图 | 通过 | §4 两条链路图，节点均标物理位置（文件/进程/常量） |
| P0-18 恢复指引 | 通过 | §7 失败路径总表（错误 → 止损 → 恢复指引） |
| P1-2 拆分 justification | 通过 | §10 每单元附理由 |
| P1-4 alternatives 记录 | 通过 | 被否谱系 + 击穿反例（D9） |
| P1-10 负面验收 | 不通过（轻） | 见 SUGGESTION #8 |

## 攻击面专项结论（task 指定四问）

1. **「idle 30min 主判定 + 60min 宽上界」vs 真实 90min 活跃任务**：会被 60min 上界杀。被否谱系（B 方案「只是把误杀线后移」的批评）**没有**挡住这种情况——上界组件对 >60min 人群就是 B 形态，且该值无探针标定、与「正常路径永不被时间本身判死」的自家断言矛盾 → MUST_FIX #3。回收层归属论证本身（idle 主判定 + 有界 opt-out 兜底 = 回收层上界族合法形态）与规则 19 和 unbounded-wait-audit 框架相容，论证结构成立。
2. **settled-watchdog 两段式对 LC-1 三场景**：逐场景推演时间线，覆盖**不降级**成立——①版本偏斜：工作期事件刷新中段（修复了现状 10min 全程窗误杀工作轮的缺陷），agent_end 缺失则最后事件后 30min 回收 ✓；②post-run compact 卡死：agent_end 交棒收尾段，600s ≥ P99×10（40.1s×10=401s）✓；③settled 行被丢：收尾段 600s ✓。收尾段固定上界论证（头注释）在拆段后归位正确。残余面：>30min 无事件长工具执行（keep-alive 先例的 fire 复核组件被丢弃）→ SUGGESTION #4；迟到 terminal 无 sid 归因缺口 → SUGGESTION #5。
3. **D3 abort 链 × 「重试一次」**：会双跑，且更糟——stop 未完成时重试即启（双跑窗）；stop 失败时升级链在超时路径**结构上不可达**（race 恒真，读源码证实）→ 止损在最需要的进程假死形态不成立（MUST_FIX #1）；修复后还需处理 killChain 连坐重试轮的次生污染（MUST_FIX #2）。
4. **探针运行时依据**：✅P-T2c 真实存在且数据与引用一致（6 轮 <2ms / compact 40.1s / 299,798 tokens / P99×10 规则原文）；⛔P-Z1/Z2/Z3/Z4 均有实施门位 + 预定义降级路径，可执行。唯一缺口 = 60min 上界无探针（MUST_FIX #3）；pi clone 引用版本偏移 → SUGGESTION #9。

## 事实核实清单（影响决策项，全部 read 源码）

`constants.ts:79`(300s)/`:74-78`(职责注释)/`:139-152`(漂移码)/`HARVEST_GRACE_MS=1s` · `session-channel.ts:507-518`(timer 不刷新)/`:569,582`(final-frame 恒 success)/`:607-617`(error 均终态)/`:335,340-353`(onClose 收割/dispose 仅退订)/`lookupTurn` 排除已落定 turn · `zcode-engine.ts:490-506`(仅 schema 重试)/`:566-573`(abort 挂载)/`:600-637`(链体+race 谓词)/`:749-771`(HARVEST_GRACE 退化)/`:1035-1076`(spawn 无 timer+onChildSpawned)/`:1388`(engine_run_failed)/`:1439-1450`(不读 status) · `kill-chain.ts:96-110`(engine_timeout SSOT) · `settled-watchdog.ts:43`+头注释 · `session-runner.ts:199`(keep-alive 30min+fire 复核)/`:240-241`(maxTurns 换算 opt-in)/`:2453-2461` · `subagent-service.ts:1177`(「prompt 发出即起算」注释) · `unbounded-wait-audit.md §7.2 T2-③`(边界自认) · impl-plan §5 T2③ 行(待回写) + S-B relay 注入通道(已核实) · fake-appserver.mjs(基建存在) · `subagent-extractor.ts:296,604`(error 透传) · `subprocess-agent-runner.ts:203`(mergeTimeoutSignal) · `types.ts` AgentTaskSpec(无 timeout) · `subagent-tool.ts`(参数面无 timeoutMs) · `ENV_WHITELIST_PREFIXES` 含 `XYZ_`（新 env 传播无遗漏，规则 12/18 无连带改动需求——「无新依赖」声明与 tsup noExternal 无冲突）。

**未能在仓内核实的引用**（T001 深诊明细数据：576 delta/72.8KB 等）来自普查 session 文件（`~/.xyz-agent/pi/agent/subagents/...`），与总报告 §0/§1 摘要一致，不构成决策影响，未列为 finding。
