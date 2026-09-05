# 对抗式审查报告：timeout-streaming-ui-idle.md（P0-2）

> 审查依据：rubric-design-doc.md（P0×18 / P1×10）。所有事实声称均已 read 源码核实（核实清单见文末）。审查日期 2026-09（v1）。

## Summary

**3 must-fix, 4 suggestions.**

骨架、问题定义、方案对比、探针纪律、验收形态均达标（多数 P0 通过）。三处 MUST_FIX 集中在同一条主线上：**设计对「sync subagent / workflow 编排期间父 session 的帧形态」持有两处与实装相反的事实认知**（进度帧不存在、旁路活跃通道未识别），导致 G1「活跃流不误判」对其自己点名的核心场景（编排）在默认 600s 下不成立；以及 **D2 自愈的标记生命周期不完整**，存在跨 turn 内容错配的具体反例。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §5.1 D1 阈值论证 leg ②（波及 §2 G1、§4.1、§7 S1、§9 P-F） | P0-11 事实 + P0-10 因果 | 「父 session 依赖 tool_call_update 进度帧，registry.ts:559 注释自证」**双重失实**：① registry.ts:559 注释讲的是 `tool_execution_end` result.details 的进度快照（步骤**结束时**一次性），不是执行期间的 tool_call_update 帧流；② 生产端 `extensions/universal/subagent-workflow/src/interface/subagent-tool.ts` 的 `executeSubagent` 显式不消费 `_onUpdate`（注释原话「onUpdate 参数保留以兼容 SDK 回调签名，但不消费」）——sync subagent 执行期父 session 的 message.* 帧按构造为零。workflow `agent()` 步骤同构（subagent-core stream-sink 仅在步骤结束发 result）。**影响决策**：600s 默认的「覆盖合法静默间隙」支柱塌了——任何 >600s 的 sync subagent/workflow 步骤必然触发 idle 误判（subagent-core 自家数据：单 turn 经验值约 5min、keep-alive 窗口 P50=24.5min），G1「编排全程保持 streaming」实际形态是「步骤超阈即闪 error、turn 末自愈」。S1 的前提「期间 delta/工具帧持续」对编排场景同样不成立 | 重写 leg ②：诚实陈述「sync 编排步骤按构造 message.* 零帧，默认 600s 会周期性误判、靠 D2 自愈兜底」，据此重新裁决 600s 默认值是否仍合理；P-F 从「验证性实测」改性质为「在已知构造性零帧前提下裁决缓解路径」（阈值上调 vs 心跳帧补发），并把 S1 场景描述改为与真实帧形态一致 |
| MUST_FIX | §5.1 刷新规则 + §6 接口契约（refresh 挂 applyMessageEvent） | P0-12 副作用/遗漏 | 刷新语义只覆盖 `message.*` 命名空间，**遗漏编排运行期的真实活跃通道 `subagent.stream_delta`**：sync subagent/workflow 执行期，子进程逐字流经 subagent-core stream-sink（widgetKey `subagent-stream-<recordId>`）→ event-adapter:419-425 → interpreter:366-372 广播 `subagent.stream_delta`（protocol.ts:1075），renderer 由 `stores/subagent.ts:297` 消费——该帧**不经过** chat store `applyMessageEvent`。反例：编排步骤 >600s 时，subagent 面板正在逐字打字（UI 明明在动、数据明明在流），父 chat 气泡却被判「10 分钟无任何进展」收口成 error——自相矛盾且恰是 G1 要消灭的「任务在跑却被判死」撕裂，只是从 text_delta 场景挪到了编排场景 | 二选一并写进设计：① 刷新源纳入 `subagent.stream_delta`（需解决虚拟分区 sessionId → 父 session 的映射）；② 维持 message.* 单一入口，但把「编排心跳帧必须走 message.* 命名空间（如 tool_call_update）」定为 P-F 降级路径的硬约束。当前两条都没写 |
| MUST_FIX | §5.2 D2 + §6 恢复谓词 | P0-12 副作用/遗漏 | `prematureTimeout` 标记**生命周期不完整**，存在跨 turn 内容错配反例：恢复谓词「complete 帧到达 ∧ session 内存在标记实体」无 turn 归属（complete 帧不携带 messageId，handler 按 status 全收——registry.ts:311+，帧本身无法回答「这是不是标记那次 turn 的 complete」）；恢复映射只列了 stop/error 两态，**缺 `aborted`**（已核可达：event-adapter STOP_REASON_MAP `aborted/cancelled → 'aborted'`，registry complete handler 有 aborted 分支）。反例链：timeout 打标 → pi 真挂死 complete 永不到，或用户点停止后 complete{stopReason:'aborted'} 到达但映射未覆盖 → 标记滞留 → 用户发新 prompt → 新 turn 的 complete 帧到达 → 谓词命中 → **旧气泡被新 turn 的权威 content/usage 覆盖**（内容错配，比撕裂更糟）。reload 无此问题（标记是 live 态，reload 从 JSONL 重建），恰说明 live 期标记需要显式清除规则 | 补全标记生命周期规格：① stopReason 全集映射（含 aborted → 维持 complete 终态、清标）；② 清除时机全集——任何非 timeout 的 finalizeSession、下一 message_start（该 session）、resetTransientStates（disconnect）；③ 恢复目标定位规则（多气泡时 content/usage 回填到哪个实体）；④ 恢复分支对「同 session 已有新 streaming 实体」的行为声明 |
| SUGGESTION | §5.6 D6 论据 ② | P0-12/诚实性 | 「真挂死不烧 token（无生成）」对「LLM 流黑洞」形态不严格成立：请求已发出后连接黑洞，provider 侧可能继续产 token 计费（abort 取消 HTTP 请求有机会止损）。量级有界（单响应 max_tokens），D6 结论（不联动 abort）仍站得住——主导论据 ①（误判不可逆化）不受影响 | 论据 ② 加限定（「工具死锁/进程挂起类挂死不烧 token；LLM 黑洞形态服务端计费有界」），不动结论 |
| SUGGESTION | §7 S5 | P0-14 可执行性 | 手段因果链失准：「挂起 provider 使 ping 失败 2 次」不成立——ping 探测的是 pi **进程**对 get_state RPC 的应答，provider 挂起不影响 pi 进程应答（这正是 §3.2 自己论证的盲区）。要触发 stream_warn 须让 pi 进程本身短暂无响应（如 SIGSTOP），且窗口须精确控制在第 3 次失败（180s）前恢复，否则 onSilentAbort 判死直接终态化，S5 场景报废 | S5 手段改写为「SIGSTOP pi 进程 ~120-140s 后恢复」并注明 180s 判死红线 |
| SUGGESTION | §5.3 证据行 / §5.1 证据行 / 附录 | P1-8 细节（不阻塞） | 引用漂移三处：① 「settings.ts:98-101」实为 `packages/renderer/src/api/domains/settings.ts:98-103`（路径少 domains 段）；② 「WorktreePage.vue:155-96」区间与实际输入域位置不符（template :88-94、script :161-194）；③ 「session-runner.ts:199」未注明包路径——该文件在 `packages/subagent-core/src/execution/`，紧邻 §3.4 的 runtime 语境极易误读为 runtime 包内文件（我初查即按 runtime 路径扑空） | 按上述核准后补全路径 |
| SUGGESTION | §4.2 / §5.2 | P1-3 受众背景 | 恢复窗口内的用户行为交互未声明：同 session 重发会被 runtime busy 预检拒绝（`send.rejected{reason:'busy'}`，protocol.ts 已核）或入队（pi 队列跨 abort 存活，registry D4 注释），turn 末自愈照常 + 排队消息照常投递；切走再切回 store 单例状态保留。行为可接受，但不写实施者可能误判需要额外交互处理 | 补一段「恢复窗口内用户操作矩阵」（重发/停止/切走/reload 四行为各自结果） |

## 判定四态（rubric 全项）

**通过**（附证据位置）：
- P0-1 五段骨架：SCQA 开篇 + §1-§9 + 探针清单 + 变更历史，完整且分层清晰
- P0-2 delta 链：v1 初版，无悬空版本引用
- P0-3 结论先行：每章标题下有加粗一句话结论
- P0-4 问题定义：§1/§3 定义的是根因（墙钟语义错位 + 校准前提失实 + 死配置口），非表象；失败模式 A/B/C 具体
- P0-5/P0-6：§3/§4 使用者视角 + streaming 实体/finalizeSession 等术语均有定义绑例子
- P0-7/8/9 方案对比：D1/D3 三方案 × 两维度 × 明确裁决 + 被否反演；D2/D4/D6 有被否项
- P0-13 验收存在且 testable：§7 五场景 + 通过标准 + 依赖说明，每场景回溯 §2 目标（S5 还覆盖 P1-10 负面验收）
- P0-14 非单测 mock：真实 pi + Playwright + 网络层手段，单测仅辅助（S5 手段失准已单列 SUGGESTION）
- P0-15 投入匹配：大改动 → 五场景
- P0-16 探针纪律：§9 P-A~P-H，⛔ 门均配降级路径（P-F 的内容性缺陷已列 MUST_FIX#1，纪律本身达标）
- P0-17 物理数据流图：§3.4 带逐跳 file:line（我逐条核实无误）
- P0-18 错误恢复指引：§4.2 a/b/c 具体动作
- P1-1/2/3/4/9：例子/justification/背景/alternatives/四件套条目化均达标
- 项目约定对齐（AGENTS.md）：规则 19（超时默认原则、zcode 反例、粒度校准）是全文主轴 ✓；规则 8 / ADR-0049——timers.ts 现有 ADR-0049 例外判据注释覆盖新增 refreshStreamingTimer 同模块同模式，§6「注入 getter 而非常量」已正确处理闭包捕获，store action 不引入 per-session 实例级状态 ✓；规则 9 live≡reload 在 D2 被否项论证中引用正确 ✓；C-proc-10 登记回写已排 M4-U5 ✓

**不通过**：P0-11（MUST_FIX#1）、P0-10（MUST_FIX#1 连带：G1 对编排场景不成立的因果链断裂）、P0-12（MUST_FIX#2/#3）

**可能不完整**：无（P-F/P-G 两个 ⛔ 探针设计已诚实标注，其内容性缺陷已在 MUST_FIX#1 处理）

**不适用**：无

## 核实清单（事实锚点 × 源码）

| 文档声称 | 核实结果 |
|---|---|
| store.ts:69 注释「runtime 5min watchdog 先行」自辩 | ✅ 一致（措辞略有删节，语义同） |
| §3.2 证伪：runtime 无 5min streaming watchdog，实装 ping 60s×3=180s 判死 / 120s warn，仅覆盖进程死亡形态 | ✅ event-interpreter.ts:37-41（PING_INTERVAL_MS/FAIL_THRESHOLD/WARN_COUNT）+ index.ts:378 onSilentAbort → sessionService.abort，全仓无 5min watchdog |
| timers.ts:15 BASH_TIMEOUT_MS / :55-61 armStreamingTimer 固定墙钟无刷新 | ✅ |
| registry.ts:267/308 唯一挂载点；:436-440 sealed guard；:340-354 complete 对终态 no-op；:425-433 stream_warn 仅追加提示；:331-333 权威 content 注释 | ✅ 全部一致 |
| store.ts:240-245 readStreamingTimeoutMs 死口（env 恒 undefined） | ✅ |
| D-016 悬空 + 编号被 command 注册表复用 | ✅（chat store.ts:233 vs command.ts:10 等 6 处「D-016 物理隔离」） |
| event-adapter handleAgentEnd 提取完整 content（P-G 前半） | ✅（event-adapter.ts:283-330） |
| store-types.ts:28-33 迟到 tool_call_end 覆盖 completed（P-D 注释级） | ✅ 注释级一致 |
| finalizeBashOnly store.ts:872 / 注入 :939 / ctx :836-837 / 导出 :1137-1138 / markBashError :1154 | ✅ |
| keep-alive 30min 无进展先例「session-runner.ts:199」 | ✅ 事实存在但路径缺包名（packages/subagent-core/src/execution/session-runner.ts:181-201，KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS）→ 已列 SUGGESTION |
| worktree timeout 配置链先例（protocol.ts:122/:550-553 → settings.ts:98-101 → WorktreePage.vue） | ✅ 链路存在，路径细节漂移 → 已列 SUGGESTION |
| 「父 session 依赖 tool_call_update 进度帧，registry.ts:559 注释自证」 | ❌ **失实**（MUST_FIX#1）：registry.ts:559 是 tool_execution_end details 结束快照注释；subagent-tool.ts executeSubagent 不消费 onUpdate |
| 刷新挂 message.* 单一入口即覆盖全部活动 | ❌ **遗漏**（MUST_FIX#2）：subagent.stream_delta 旁路不经 applyMessageEvent |
| 恢复谓词「complete ∧ 存在标记实体」+ stop→complete/error→error 映射 | ❌ **不完整**（MUST_FIX#3）：无 turn 归属、缺 aborted 映射（STOP_REASON_MAP 已核 aborted 可达） |
| auto_retry 帧存在且有界（maxRetries=3） | ✅（protocol.ts:1396-1397；llm-retry-config-helper.ts:15） |
| 测试文件清单（§8 所列 7 个） | ✅ 全部存在 |
| W6 测试 rationale 已接受 10min | ✅（renderer __tests__/chat-streaming-timeout.test.ts:2-10） |

## 给主 agent 的修复优先级建议

MUST_FIX#1 与 #2 同根（对编排期帧形态的认知），建议一并修：先按实装改写 §5.1 阈值论证与刷新语义的「编排场景」小节，再联动改 §2 G1 措辞、§4.1 路径、§7 S1、§9 P-F。#3 独立可修（D2 补规格）。三处修完后本设计的主线（idle 语义 + 自愈 + 配置口 + 契约清理）依然成立，无需推翻重来。
