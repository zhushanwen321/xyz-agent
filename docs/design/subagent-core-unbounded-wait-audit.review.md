# 对抗式审查报告：subagent-core 无界等待家族缺陷普查与修复方向

> 审查对象：`docs/design/subagent-core-unbounded-wait-audit.md`（约 410 行）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（P0/P1 清单）
> 审查方式：事实锚点抽查（T0 全部 13 条 + T1-T7 各主题关键证据，约 60 处 file:line 逐一 read 源码核实）+ 方案自证对抗 + 验收专审

## Summary

**5 must-fix, 7 suggestions.**

**总体判断**：这是一份事实质量很高的普查文档——抽查的全部 file:line 证据（含 T0 全部 13 条）经源码核实**无一伪造、无一处语义性错误**（仅 2 处轻微不精确，见 S-2/S-3）；根因归纳（三裁决）与「正常路径根修 + 兜底收敛回收层」的总体方向成立。**不通过点集中在 §7.2 修复主题与 §8 验收的衔接上**：T2 的覆盖声明有两处与措施清单不匹配（LC-1/PS-1 被声明覆盖但无对应措施，对应验收 S-B/S-C 按文档实施必然失败）；T2 新引入的 kill 面对「有活跃后代的 keep-alive 进程」的后代树处置未设计；P-T2 安全门探针的降级路径依赖未定义概念与不可得输入；验收的故障注入/观测手段多处不可照做。这些是实施前必须补齐的设计缺口，不动摇文档主体。

### 核实声明（区分已核实与未核实）

- **已核实（审查者 read 源码逐行比对）**：§3.2 RC-1/2/3、§4.1 T0 全部 13 条（OR-1/2/3/4、LC-1/2/3/4、PS-1/2/3/4/5）、§4.2/§4.3 抽查（PS-6/7/9/10、OR-5/7/8、LC-5/6/7/8/9、PS-11/12/13/14/15、OR-6）、§7.2 各主题引用的关键行、附录 A 的 RC-4 排除依据（sessions-index.ts:258 writeAtomicFile）。
- **未核实（生产环境事实，文档引用既有事故分析，本审查无法在源码层面证伪）**：§3.1 的「600s 守卫 / 60% 触发率 / 5400s rpc-client 超时 / 6 路并发卡死」等生产数字。
- **行号漂移**：抽查中仅 2 处小漂移（launcher.ts L-2 修复实际在 :459-462 而非 :450-454；GET_STATE_TIMEOUT_MS 在 :25 而非 :23 区间内），语义均吻合，不构成 finding。

## Findings

| # | 优先级 | rubric | 文档位置 | 问题陈述 | 证据（审查者已核实） |
|---|--------|--------|----------|----------|----------------------|
| MF-1 | MUST_FIX | P0-10/P0-12 | §7.2 T2（L279-285）vs §4.1 LC-1（L115-120） | T2 声称覆盖 LC-1，但五项措施无一作用于 LC-1 的挂点（chatMode 首轮等待 agent_settled） | session-runner.ts:1353-1360（chatMode agent_end 纯 continue，不进 keep-alive 分支）；:997-1027（idle timer 只在 agent_settled arm——事件不到达则 timer 永不挂）；:1690-1707（spawn watchdog 仍 opt-in 默认不挂） |
| MF-2 | MUST_FIX | P0-10/P0-12 | §7.2 T2（L279）vs §4.1 PS-1（L135-140）、§10 U-T2（L369） | T2 覆盖列表含 PS-1，但五项措施与 U-T2 说明均无「disposeAllRecords 补 abort/kill/disarm」 | subagent-service.ts:467-499（disposeAllRecords 无 controller.abort/child.kill/disarmIdleTimer）；:543-549（dispose() 对照有三回收面）；:805-810（cancel 只查 getMutable） |
| MF-3 | MUST_FIX | P0-12/P0-16 | §7.2 T2 ①（L281）、§6.2（L251） | keep-alive 30min 上限到期 kill 的是层主进程，其活跃后代（孙进程）的处置链未设计、无探针 | session-runner.ts:1361-1375（keep-alive=有活跃后代）；:918-936（SIGKILL 升级路径无任何 hook）；record-store.ts:640（挂死孙进程最终被孤儿恢复盖 finalized("gc")——活进程误终态，即 PS-7/PS-8 登记的形态） |
| MF-4 | MUST_FIX | P0-16 | §7.3 P-T2（L324）、§7.2 T2 边界（L285） | P-T2 探针的降级路径不可执行：两个选项分别依赖「不可得的输入」与「未定义的概念」 | T2 边界自述上限只挂「无 maxTurns 无 env」裸缺省情形——此时不存在 maxTurns 供 maxTurnsToWatchdogMs 估算；「无后代能力调用」全文无定义 |
| MF-5 | MUST_FIX | P0-13（兼准则 7） | §8.2 S-A/S-B/S-D（L341-344） | 验收的注入/观测手段不可照做：S-D ulimit 可行性是未验证断言；S-B 抑制方式未写；S-A/S-E 观测点未指明 | S-D「ulimit 限线程制造 worker 崩溃后重建失败」：ulimit -u 是 user 级，同时约束主进程/pi 子进程/首个 worker，无法精确制造「首个成功、重建失败」时序；§7.3 探针清单无对应项（文档自己的准则 7） |
| S-1 | SUGGESTION | P0-11（项目约定）/P1-6 | §7.2 T4 ②（L295） | 「armIdleTimer 失败降级挂默认 5min」与既有裁决「不静默 clamp」冲突未对账 | timer-delay.ts:10-13 明文「不静默 clamp——clamp 把配置错误变成静默语义漂移」；非法 idleTimeoutMs（意图极长保活）被静默替换为 5min 正是该形态 |
| S-2 | SUGGESTION | P1-8 | §4.3 LC-7（L206） | LC-7 称 lifecycle-manager.ts:58-64 与 watchdog env「同构（静默等价关闭）」——idle timeout env 非法值是回落默认 5min，不是关闭 | lifecycle-manager.ts:58-64（回落 DEFAULT_IDLE_TIMEOUT_MS）vs session-runner.ts:209-215（不挂 timer） |
| S-3 | SUGGESTION | P1-8 | 一句话结论（L3）、§4（L86-88）vs 附录 B（L403） | 「34 条」计数含 LC-10 占位（附录 B 自认「并条占位」），实际独立缺陷 33 条，口径不一 | LC-10 行内容为「PS 域 F10 并入 LC-6（同一 Map）」非独立缺陷 |
| S-4 | SUGGESTION | P0-12（轻度） | §7.2 T2 ④（L281） | dialog timeout 接线只覆盖「请求方传了 timeout」的 dialog；未传 timeout 的 ask_user 依然无界——LC-3 全局死锁只修一半 | spawn-event-adapter.ts:180-194（timeout 可选字段条件复制）；ui-request-queue.ts:182（复制后全链无消费者，已核实 dialog-queue/handler-factory 无 timeout 读方） |
| S-5 | SUGGESTION | P1-5 | §7.2 T6 ⑥（L310） | 「快照改增量/截断 或 STATE_MAX_RUNS 给默认值」两个不等价选项用「或」并列：前者治单 run O(n²)，后者只治多 run 保留数 | file-run-store.ts:89-90 / jsonl-run-store.ts:507-515（单 run 每次 flush append 全量快照，已核实） |
| S-6 | SUGGESTION | P0-18 | 附录 C（L409） | 止血 env 未提示副作用：XYZ_SUBAGENT_SPAWN_WATCHDOG_MS 挂在 spawn 初期，会误杀 >30min 的合法长 one-shot 任务 | session-runner.ts:1700-1707（env watchdog 覆盖全部 spawn，不只 keep-alive） |
| S-7 | SUGGESTION | P0-6（轻度） | §2 目标 3（L50）、§7.1 方案 C（L266） | 「回收层」是全文核心裁决（兜底只许出现在回收层）但边界未定义——哪些通道属于回收层（dispose/watchdog/idle timer/kill 升级/dialog timeout？）未列举；dialog timeout 是否属回收层影响 T2 ④ 的合法性判断 | —（概念定义缺失，非事实错误） |

### INFO（不计入计数）

1. T3 ① 前移 scheduleTimeBudget 后，若 workerHost.start 抛错 timer 残留——已核实 scheduleTimeBudget 的 timer fire 带 `.catch`（lifecycle.ts:130-147），abortRun not found 只产生 error 日志不崩溃；实施时可顺手在 start 抛错路径 clearTimeout。
2. OR-1/OR-2/OR-4 的「unhandledRejection 崩宿主」断言依赖宿主无全局 handler：已核实 subagent-core 与 subagent-workflow 均无 `process.on("unhandledRejection")` 注册（grep 无命中），Node 默认 throw 模式下成立；pi 宿主进程自身是否注册超出本仓范围未验证——但即便不崩，「run 永不可达/卡 running」后果独立成立，缺陷定性不变。
3. 34 条登记的映射完整性已核对：T1-T7 并集覆盖全部登记条目，无悬空；附录 A 已排除项抽查（RC-4 的 writeAtomicFile+节流、waitForChildExit 装配时序的同步段）均成立，未发现误排除。

## 各 MUST_FIX 修复建议

**MF-1（LC-1 与 T2 措施不匹配）**：T2 措施清单补第 6 项——「chatMode 首轮 agent_settled 等待窗口的独立上界」（例如：chatMode 分支在 agent_end 时若进入等待，同样挂 T2 ① 的保守默认上限；或明确 chatMode spawn 的 watchdog 默认挂载语义）。同步修订 §6.2/S-B 的判据，写明该场景回收上界的来源 timer。

**MF-2（PS-1 与 T2 措施不匹配）**：T2（与 U-T2 单元说明）补措施项——disposeAllRecords 在 /new、/fork 路径补齐三回收面：controller.abort + kill（收敛到 killChildWithEscalation，与 T2 ② 同一语义）+ disarmIdleTimer。这是「kill 时机遗漏」而非「kill 方式」缺陷，不能靠 ②③ 覆盖。

**MF-3（kill keep-alive 层主的后代处置）**：T2 实施单元需明确「kill 有活跃后代的层主时后代树的归宿」：优先在 kill 前读活跃后代差集（session-pending 已有该能力）并级联处置，或声明依赖 pi 的 SIGTERM 优雅 shutdown 级联——若是后者必须补探针（pi 子进程收 SIGTERM 后是否执行 session_shutdown → killAllSpawnedChildren），因为 SIGKILL 升级路径（killChildWithEscalation）确定无 hook。不设计此链路，T2 的新 kill 面会系统性制造 PS-7/PS-8 登记的「活进程被孤儿恢复盖 gc」形态。

**MF-4（P-T2 降级路径）**：重写降级路径为可执行动作：① 定义「无后代能力调用」的判定依据（何种调用形态可静态断言必无后代），或 ② 给出裸缺省场景的第二降级（如默认上限取 P-T2 实测分布的安全倍数、或改为「N 次无进展检测」而非固定时长）。⛔ 门探针的失败出口必须能直接转化为实施动作。

**MF-5（验收注入/观测可操作性）**：逐场景补「怎么做、在哪看」：S-A 写明 600s 守卫触发次数的观测点（哪个日志文件的何种条目）与 journal 指哪个文件；S-B 写明抑制 agent_settled 的注入方式（如 stdout 行过滤 wrapper）；S-D 的 ulimit 声称要么给出可复现的具体步骤并先跑通（作为探针补入 §7.3），要么改用其他注入手段并如实标注该子场景的验证方式与缺口。

## 通过项（对抗后放行，抽样列举）

- P0-4 问题定义：§1/§2 忠于真实问题（weekly/monthly 挂死 + 家族扩散），§5 根因三裁决打到了「为什么会长成这样」的层面，非表象归纳。
- P0-7/8/9 方案对比：§7.1 三方案 × 两维度 + 风险 + 明确推荐 + 被否后果（「若用它例子会怎样」）齐备。
- P0-11 事实锚点：抽查约 60 处 file:line 全部成立（详见 Summary 核实声明）——在同族审查中属罕见质量。
- P0-16 探针纪律：P-T1/P-T3/P-T5/P-RC1 均带降级路径；P-RC1「无论结论方案都成立」的论证成立（惰性回补不依赖触发条件）。
- P1-9 决策四件套：T1-T7 全部 item 化（采用/被否/证据/效果）。
- P1-10 负面行为反向验证：S-C「不收到 triggerTurn」、S-A「守卫 0 次」齐备。
- P0-2 自包含：正文无 vN/审查编号引用，附录 B 溯源合规。

---

# 第 2 轮复审（2026-09-01）

> 复审范围：对照轮 1 findings 验证修订落实 + 修订方自提 5 个攻击点 + 修订新引入内容的对抗扫描。已确认项（轮 1 核实的 ~60 处事实锚点、根因归纳、方案对比）不重查。

## Summary（第 2 轮）

**2 must-fix, 6 suggestions.**

总体判断：轮 1 的 5 条 MUST_FIX 中 4 条（MF-1/2/3/4）与 MF-5 主体已完整落实且质量高（T2 八项措施与 LC-1/PS-1 挂点精确对位、P-T2b/P-SD 探针带降级、S-B stdout wrapper 注入方式具体可行）；7 条 SUGGESTION 全部落实。32 计数经表格行数硬数验证**正确**（T0 13 + T1 6 + T2 表 14 行 − LC-10 占位 = 32）。新引入 2 个问题：① 附录 C 的「per-call timeoutMs 放宽」止血指引与源码不符（timeoutMs 是提前杀的 abort 信号、runSpawn 路径无此概念，照做无效）；② T2③「任何 stdout 事件刷新计时」的漏杀方向（pi wedged 但仍有周期性输出时无限续命）是无探针的运行时断言。

轮 1 findings 落实核验：MF-1 → T2③ + §6.2 新路径 + S-B 来源 timer 标注（落实）；MF-2 → T2⑥ + U-T2 同步（落实）；MF-3 → T2② + P-T2b（落实，采集时机/递归深度留尾巴见 R2-S-1）；MF-4 → P-T2 两级降级均可执行（落实）；MF-5 → S-A/S-B/S-D/S-E 观测点与注入方式（落实，留两处小断言见 R2-S-5/S-6）；S-1 ~ S-7 全部落实（T4② 两手设计经对抗无残留静默窗口——参数走入口 fail-fast、env 巨值走回调降级 + warn，re-arm 路径传非法值仍落回调 catch 可见）。

## Findings（第 2 轮）

| # | 优先级 | rubric | 文档位置 | 问题陈述 | 证据（审查者已核实） |
|---|--------|--------|----------|----------|----------------------|
| R2-MF-1 | MUST_FIX | P0-11 | 附录 C（L420） | 「对该调用显式传 per-call timeoutMs 放宽」与源码不符——照做无效，长任务场景止血指引不可用 | timeoutMs 的作用点是 abort signal 合并（subprocess-agent-runner.ts:202-203 `mergeTimeoutSignal(signal, opts.timeoutMs)`），语义是**提前** abort；runSpawn 路径（session-runner.ts）grep 无 timeoutMs 字样——spawn watchdog 只由 maxTurns/env 决定（:229-251 优先级：显式 maxTurns > env）。传 timeoutMs 既到不了 watchdog 决策、方向也相反 |
| R2-MF-2 | MUST_FIX | P0-16 | §7.2 T2③（L285、L294） | 「任何 stdout 事件刷新计时 ⇒ wedged 必静默 ⇒ 30min 必触发」的漏杀方向是无探针的运行时断言：pi 若在 idle/wedged 期间存在周期性输出（心跳/进度/调试行——LC-9 自己证明 stdout 可能有调试输出），刷新语义使真 wedged 无限续命，LC-1（T0）修复退化为「仅回收事件流静默形态」；且「stdout 事件」定义未定（invalid 行算不算）。文档边界（L294）与 P-T2 只覆盖了不误杀方向 | session-runner.ts:1436（invalid 行静默丢弃，stdout 可有非事件输出）为已核实事实；pi idle 期 stdout 形态未验证——正是需要探针的断言。对照：P-T2 降级 B 已用更严格的「后代集合变化」作刷新信号，证明作者知道「任何事件」过宽，但 T2③ 未收窄 |
| R2-S-1 | SUGGESTION | P0-12 | §7.2 T2②（L284）、§6.2（L251） | 后代清单「kill 层主前采集」会漏窗口内新后代（层主垂死期间新 spawn、清单内后代再 spawn 的孙代）；层主死后其 sessionFile 冻结为最终快照，「层主确认死亡后采集」反而更准。补杀只对清单内后代，深度 2+ 的树叶不闭合 | 逻辑链基于已核实的 session-pending 语义（pending entries 落层主 session 文件，层主死后文件冻结）。修复方向：采集移到死亡确认后 + 对每个后代迭代采集至叶，或明示深度>1 依赖 T5 marker 兜底并写明误终态代价 |
| R2-S-2 | SUGGESTION | P0-13/P1-1 | §7.2 T2⑦（L289） | dialog 30min 默认值「随探针 P-T2 的时长标定同步调整」——标定来源错配：P-T2 统计的是 wave keep-alive 时长分布（等后代），与用户回答 ask_user 的时长分布（等用户）是两个无关总体；「用户挂机 31min 被判失败」的产品语义路径（agent 收到错误如何推进、用户回来看到什么）未进 §6.2 失败路径 | 修复方向：dialog 上界单独标定（或声明 30min 为裁决值 + opt-out 指引），§6.2 补一条 dialog 超时路径 |
| R2-S-3 | SUGGESTION | P1-10/P0-15 | §8.2 | PS-4/PS-5 两个 T0 修复无验收场景（S-A~S-E 未覆盖）；OR-3 的 pending timeout 半边仅 P-T3 部分覆盖（abort 半边）。T0 级修复的验证缺口值得点名 | 修复方向：补可注入场景（PS-4：真实跑一个传非法 idleTimeoutMs 的 subagent 观察入口 fail-fast 与 warn；PS-5：shutdown 瞬间主 agent busy 的注入）或明示以探针/单测替代验收的理由 |
| R2-S-4 | SUGGESTION | P1-8 | 附录 B（L414）、§4 编号规则（L90） | 32 计数硬数验证正确，但推导文字有 1 条含糊：「1 组并条 + 1 项占位」只解释 34−1=33，剩 1 条（LC-F10 的归宿）无法唯一解读——「LC-1..LC-10 = F1..F10」与「LC-10 为并条占位」并存时，LC-F10 是独立发现被丢弃还是与 PS-F10 跨域重复登记，读者无法判定 | 表格行数 13+6+13=32（审查者重数）；附录 B 需补一句闭合（如「LC-F10 与 PS-F10 为同一发现的跨域重复登记，并入 LC-6；LC-10 编号保留为占位」，以普查事实为准） |
| R2-S-5 | SUGGESTION | P0-12 轻度 | §7.3 P-SD（L335）、§8.2 S-D | 测试钩子 env 进生产代码无安全约束：XYZ_SUBAGENT_TEST_INJECT_REBUILD_FAILURE 若意外泄漏到生产环境，重建永远失败——恰好是本家族「env 非法值静默」的新变体 | 修复方向：钩子约束写入 P-SD/T3（仅显式设置时激活 + 激活即 warn 留痕，对齐 T7① 可见性原则） |
| R2-S-6 | SUGGESTION | P0-16 轻度 | §8.2 S-A（L352） | 「守卫触发必落 call 级失败记录」是未验证断言：600s 守卫属 cw 脚本层机制，其降级行为是否落 errorLogs/call 终态记录未验证，验收判据依赖它 | 修复方向：S-A 执行前先跑一次守卫触发形态确认落痕位置（可作为观测预检步骤写入），或改为直接观测守卫自身日志输出 |

## 修订方 5 个自提攻击点的回应

1. **T2③ 无进展刷新**：确实是问题——漏杀方向（R2-MF-2）。建议参照降级 B 的「后代集合变化」语义收窄刷新定义，或加总时长硬上限双保险 + 补 pi idle 期 stdout 形态探针。
2. **dialog 30min 产品语义**：「有意行为变更」标注本身合格；问题在标定来源错配与 §6.2 缺路径（R2-S-2）。用户挂机被判失败的产品代价可辩护（有恢复指引 + opt-out），不构成 must-fix。
3. **32 计数**：重数验证 32 正确（T0 13 + T1 6 + T2 表 14 行 − LC-10 占位）；推导文字留 1 条含糊（R2-S-4）。
4. **T4② 两手分工**：对抗后无残留静默语义漂移窗口——参数非法走入口同步 fail-fast（显式暴露），env 巨值走回调内降级 + warn（防御性兜底且可见），re-arm 路径传非法值仍落入回调 catch。通过。
5. **T2② 采集时机**：kill 前采集确有窗口漏洞；层主死后 sessionFile 冻结为最终快照，死亡确认后采集更准（R2-S-1）。

## 通过项（第 2 轮新增对抗后放行）

- T2③ 与 idle timer 的互补边界（settled 前后分工）表述清晰，S-B 反例链（滤除 settled → 静默 → 上界 → 回收）自洽。
- T2⑥ 对「kill 时机 vs kill 方式」的区分准确（④⑤ 收敛方式、⑥ 补时机），与 PS-1 断点对位。
- P-T2 两级降级均可执行（P95×2 输入即探针产出；无进展检测不依赖固定时长）。
- S-B stdout 过滤 wrapper 注入方式具体可行（子进程与其余链路真实，仅事件行被滤）。
- §2 回收层四族定义完备且与 T2 八项措施对得上（dialog timeout/settled 上界归上界族、后代级联归 kill 族）。
- 32 计数的表格实数与全文口径（L3/L10/L86/L90）一致。

---

# 第 3 轮复审（2026-09-01）

> 复审范围：对照第 2 轮 findings 验证修订落实 + 修订方自提 3 个攻击点 + 新引入内容（T2③ 重设计 / S-F / 附录 B 推导）的对抗扫描。已确认项不重查。

## Summary（第 3 轮）

**1 must-fix, 3 suggestions, 1 info.**

总体判断：第 2 轮全部 8 条 findings 均已落实，其中 T2③ 的推翻重设计质量高——固定硬上限 by construction 覆盖静默与非静默两种 wedged、被否谱系留痕、P-T2c 定案门 + 可执行降级（P99×10 输入即探针产出），是对「事件刷新续命面」的正确闭合。附录 C 指引已与源码对齐（maxTurns > env 优先级核实正确）。新发现 1 个实质问题：T2③ 声称「多轮会话每轮 agent_end→settled 窗口独立计时」，但措施定位在「runSpawn 在 resolve 前等待的窗口」= 仅首轮——后续轮次（热路径续聊后 settled 永不到达）经源码推演仍无任何 timer，LC-1 同族变体无界残留，声称与措施不匹配（与轮 1 MF-1 同型问题复发）。

第 2 轮落实核验：R2-MF-1 → 附录 C 改 maxTurns/env（与 resolveSpawnWatchdogMs :229-251 一致，落实）；R2-MF-2 → T2③ 重设计 + P-T2c + 边界/§6.2/S-B 同步（落实）；R2-S-1 → 死亡后采集 + 迭代至叶 + 残余窗口标注（落实，pid 校验尾巴见 R3-S-2）；R2-S-2 → 裁决值表述 + §6.2 dialog 路径（落实）；R2-S-3 → S-F 两子场景 + OR-3 缺口明示（落实）；R2-S-4 → 附录 B 完整推导 + 实数兜底（落实，INFO 尾巴见 R3-I-1）；R2-S-5 → P-SD/S-D 安全约束（落实）；R2-S-6 → S-A 观测预检（落实）。

## Findings（第 3 轮）

| # | 优先级 | rubric | 文档位置 | 问题陈述 | 证据（审查者已核实） |
|---|--------|--------|----------|----------|----------------------|
| R3-MF-1 | MUST_FIX | P0-10/P0-12 | §7.2 T2③（L286 末句） | 「多轮会话中每轮 agent_end→settled 窗口独立计时」的覆盖声称与措施定位矛盾：③ 挂在「runSpawn 在 resolve 前等待 agent_settled 的窗口」——即仅首轮（resolveRun(0) 后 runSpawn 返回，其 timer 随之消亡）。后续轮次走热路径：deliverMessage **无条件 disarm idle timer** → 子进程跑完 turn → agent_end 纯 continue → settled 永不到达时，idle timer 不 arm（arm 只在 settled）、spawn watchdog 默认关、runSpawn 已返回——**该窗口无任何 timer，LC-1 同族变体无界残留**。矛盾句若按字面实施（每轮计时）则需要跨轮存活机制（未设计），按 runSpawn 内实施则后续轮次裸奔 | subagent-service.ts:994（deliverMessage 无条件 disarm）；session-runner.ts:997-1027（arm 只在 agent_settled）、:1353-1360（chatMode continue）、:1025（首轮 resolveRun(0) 后 runSpawn 返回）；LC-1 触发 (b)（post-run 卡死）对后续轮次同样成立。讽刺佐证：P-T2c 探针统计的就是「多轮对话每轮间隔」，而修复只护住首轮 |
| R3-S-1 | SUGGESTION | P0-12/P1-2 | §9 依赖说明（L375）、§10 本章结论（L379） | 两处均只写「T2 依赖 P-T2 探针」，漏 P-T2c（T2③ 10min 硬上限的定案门）——实施者若只看 §9/§10 会跳过标定直接定 10min，产生修订方自担的「真实分布长尾超 10min 且探针未跑」误杀窗口。探针清单的 ⛔ 状态列写对了，但依赖声明两处未同步 | 修复：改为「T2 默认值依赖 P-T2 与 P-T2c 双探针」（P-T2 管 keep-alive 30min、P-T2c 管 settled 10min，两个值两扇门） |
| R3-S-2 | SUGGESTION | P0-12 轻度 | §7.2 T2②（L285） | 后代补杀只能用 pid 裸 kill（后代不在本进程 spawnedChildren 记账内，层主死后句柄不存在），但 kill 前的存活校验与 pid 复用防护未设计：①清单含已死项（孙进程死亡且 unregister 未落盘）时 kill 裸 pid，若窗口内 pid 被系统复用 → 误杀无关进程；②「个别后代 pid 反查失败兜底 T5」之外，正向路径同样需要校验 | 修复：补杀前校验目标进程 cmdline 含 pi 特征（spawn 参数可辨识），不匹配则跳过并留痕——一行级防护，对齐文档自己的「不押注未验证断言」基调 |
| R3-S-3 | SUGGESTION | P1-8 | §8 本章结论（L344） | 「用 4 个真实场景验证」与表格 6 个场景（S-A~S-F）不符——S-E 之后就应是 5，S-F 加入后是 6，结论行两轮未同步 | 修复：改为 6（或「多场景」） |

### INFO（不计入计数）

- R3-I-1（附录 B）：34→32 推导现已自洽（LC-F6/PS-F10/LC-F10 三元归并 3→1 + 以表格实数为准兜底）。唯一无佐证断言是「LC-F10 ≡ LC-F6 同一发现」（修订方自认按占位行自述 + 实数反推，普查原始记录不在手）——即使该等同不成立，最坏影响是「34 原始」的叙述误差，登记实数 32 与全部方案/验收不受影响。建议普查原始材料可查时核对一次即可，不阻塞。

## 修订方 3 个自提攻击点的回应

1. **10min vs 合法慢 post-run**：设计本身已闭环（正常秒级 + 10min 量级余量 + P-T2c 定案门 + P99×10 降级）——但「实施顺序 = P-T2c 先于定案」只在探针清单表达了，§9/§10 依赖声明漏同步（R3-S-1），这正是误杀窗口的实际入口。
2. **死亡后采集的时序 granularity**：半项够、半项不够——session-pending 只消费完整行（:134-138 已核实）且孙进程完成仍会向层主 session 文件写 unregister（文件写入不依赖层主进程存活），「清单含已死项」概率低；但 pid 裸 kill 无存活校验/复用防护是真实残留（R3-S-2）。
3. **附录 B 推导**：自洽且已兜底（以实数为准）；唯一无佐证点影响面纯叙述（R3-I-1），不再列为 SUGGESTION。

## 通过项（第 3 轮新增对抗后放行）

- T2③ 固定硬上限重设计：被否谱系（事件刷新被 LC-9 调试行实证击穿）留痕、与 idle timer 的互补边界、P-T2c 含大 session compact 场景、降级「仅调值不改语义」——四要素齐备。
- 附录 C 修正后的放宽指引与源码一致（显式 maxTurns > env 优先级，resolveSpawnWatchdogMs :229-251 已核实）。
- S-F 两子场景可执行（非法 idleTimeoutMs 真实 spawn 观察入口 fail-fast；长任务占住主 agent 后 shutdown 重启观察 replay），判据含反向项（无静默降级）。
- OR-3 验证缺口明示不冒充（集成测试 + P-T3 覆盖范围如实标注）——符合准则 11「依赖无法获取时明说验证缺口」。
- T2② 层主死亡后采集冻结快照的理由链（垂死窗口漏项 + 快照最完整）成立，残余窗口已如实标注。

---

# 第 4 轮复审（2026-09-01）

> 复审范围：对照第 3 轮 findings 验证修订落实 + 修订方自提 2 个攻击点（双挂载原语一致性 / 交叉引用终检）。已确认项不重查。

## Summary（第 4 轮）

**0 must-fix, 2 suggestions.**

**结论：设计就绪。** 第 3 轮全部 findings 落实：T2③ 扩展为「任意一轮等待 settled 的窗口」并写明双挂载位置与三无窗口现状（落实）；§9/§10 依赖声明补 P-T2c（落实）；T2② 补 cmdline 存活校验（落实）；§8 结论改 6 场景（落实）；附录 B 维持实数兜底（合理）。本轮对抗未发现方案缺口、事实错误或新的覆盖声称与措施不匹配。剩余 2 条建议均为一句话级同步补齐，不阻塞实施，可在 U-T2 实施单元内顺手闭合。

四轮收敛轨迹：轮 1（5 MF + 7 S）→ 轮 2（2 MF + 6 S）→ 轮 3（1 MF + 3 S）→ 轮 4（0 MF + 2 S）——问题密度单调下降且性质从「方案缺口/事实错误」退化为「文字同步」，符合收敛判据。

## Findings（第 4 轮）

| # | 优先级 | rubric | 文档位置 | 问题陈述 | 修复方向 |
|---|--------|--------|----------|----------|----------|
| R4-S-1 | SUGGESTION | P0-12 轻度（交叉引用） | §6.2（L252）、§8.2 S-B（L355） | T2③ 双挂载的热路径半边未同步到终态描述与验收：①§6.2 该条仍写「runSpawn 以错误返回而非永挂」——只适用于首轮（runSpawn resolve 前）；续聊轮（deliverMessage 后 settled 不到）timer 触发时 runSpawn 早已返回，回收形态是「进程被杀 + 该轮以失败通知用户」，且该形态下 record 的终态化归属（timer 触发方负责 finalize）未写；②S-B 只验首轮（spawn 后即滤），热路径位置（deliverMessage 内挂载）这一新实现面无验收触达——同一 wrapper 先续聊一轮再观察即可低成本覆盖 | §6.2 该条补热路径形态一句；S-B 补「续聊一轮后再滤」子场景或明示仅验首轮 |
| R4-S-2 | SUGGESTION | P1-6/P0-6 轻度（原语统一） | §7.2 T2③（L286） | 双挂载仅以「同挂」二字暗示同一机制，未显式声明为同一原语——两处若各写一套（session-runner 一处、subagent-service 一处，常量复制、清除语义漂移：首轮有 resolveRun 路径而热路径没有），恰是 T2 被否理由「散布姿势」的微缩复发。文档全文的反家族立场（§5 裁决 3、T2 被否项）要求这里显式钉死 | T2③ 补一句：「两处共用同一原语——同一常量、同一挂载/清除 helper，两个调用点」；实施时 U-T2 单批改动物理上本就同批，补声明即闭合 |

## 修订方 2 个自提攻击点的回应

1. **双挂载是否引入口径不一的家族复发风险**：是，风险真实存在但已被 U-T2 单元边界大部分约束——建议以 R4-S-2 的一句原语声明彻底钉死（同一常量 + 同一 helper），成本一句话。
2. **交叉引用五处终检**：a 正文决策 ✓、b 终态路径（未完全同步——热路径形态缺失，R4-S-1）、c §9/§10 ✓、d §8（结论行 ✓，S-B 判据未覆盖热路径，R4-S-1）、e 文件改动地图 ✓（deliverMessage 挂载落在 subagent-service.ts，已在 U-T2 列内）。

## 通过项（第 4 轮）

- T2③ 双挂载修订本身：两个位置、三无窗口现状、「每轮窗口独立计时」声称现在与措施对得上（热路径由 deliverMessage 挂载实现），R3-MF-1 实质闭合。
- §9「两个默认上限值分别依赖 P-T2（keep-alive 30min）与 P-T2c（settled 窗口 10min）」与 §10 结论行、探针清单 ⛔ 门三处一致。
- T2②「存活校验 + cmdline 含 pi/--mode rpc 校验」与「不押注未验证断言」基调自洽。
- §8 结论「6 个真实场景（S-A~S-F）」与表格一致。

## 设计就绪结论

**本文档通过对抗式审查，达到实施就绪（DoR）**：32 条登记事实锚点经四轮抽查无一伪造；根因归纳与七主题修复方向成立；全部运行时断言附探针且降级路径可执行；验收为 6 个真实场景（非单测非 mock）并回溯 §2 目标、含负面行为反向验证与明示的验证缺口。附带条件：R4-S-1/S-2 两条建议在 U-T2 实施单元内顺手闭合（均为一句话级）；⛔ 门探针（P-T1/P-T2/P-T2b/P-T2c/P-SD）按 §7.3 标注的阶段前执行，未过门不得定案对应默认值。
