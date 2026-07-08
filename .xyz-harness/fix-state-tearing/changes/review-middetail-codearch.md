# Code-Arch 反向认知审查报告 — fix-state-tearing

> 审查帧：禁读 §6 test-matrix → 从 §4 时序图 alt/else + NFR 回灌表（M1~M22）+ §5 sealed 边界 + §2 reason 映射表独立重建测试用例 → diff §6。
> 审查视角：full-code-arch 5 视角（API 契约 / 包依赖图 / 时序图 / sealed 实现 / test-matrix 重建）。
> 读者：主 agent（据此修订 code-architecture.md 后进 Step 6）。

## Verdict

**conditional pass（条件通过）**

架构本体扎实：sealed 边界（tool_call_end 不 sealed / 6 个 delta 流类 sealed）在骨架正确落地且与 §5/NFR M8/SV-2 三向一致；包依赖图无环，effects 经 `MessageEffectContext` ctx 注入的去环 seam 成立；NFR 回灌表 18 条「代码测试」缓解（M2/M3/M4/M5/M7/M8/M9/M11/M13/M14/M15/M16/M17/M18/M19/M20/M21/M22）在 §6 全部有对应用例（T9.1~T9.18），无遗漏。

但 test-matrix 存在 2 个 must_fix：
1. **§6 自检造假**：声称「时序图 1 alt→T1.x catch」，实际 T1.1~T1.4 无一覆盖 `api.send` 失败 catch 路径（clearPendingSend + throw），时序图 1 的唯一 alt 分支无对应异常用例。
2. **dispatcher catch 分类谓词未定义**：§2 模块 F 要求 catch 区分 `pi already processing`→`send.rejected` 与「其他错误」→`message.error` 两分支，但 D-009 明确禁止字符串匹配，§2 未给出替代检测机制；T9.8 测此契约却无可实现谓词。SV-4 把此问题标为「需⑤骨架验证 pi 抛错形态」，§7 又显式跳过 dispatcher 骨架——开放问题在 code-arch 未收敛。

修掉这两项后可放行进 Step 6。

## 重建结论

### 重建方法
- **来源 A**：逐张拆 §4 五张时序图的 `alt`/`else`/`Note over` 分支 → 每条异常/并发分支生成一条功能用例；正常主路径每条生成一条正常用例；§2 reason 映射表 7 值各生成一条终态映射用例。
- **来源 B**：筛 NFR 回灌表 `验收方式=代码测试` 的 18 条（M2/M3/M4/M5/M7/M8/M9/M11/M13/M14/M15/M16/M17/M18/M19/M20/M21/M22）→ 各生成一条 NFR 用例；骨架约束类（M1/M6/M10/M12）不进 matrix。

### 重建 vs §6 diff 结果

| 维度 | 重建覆盖 | §6 覆盖 | 差异 |
|------|---------|--------|------|
| §4 时序图 1 alt（api.send 失败 catch） | ✅ 生成 send-catch 用例 | ❌ **无** | **must_fix #1**：§6 自检声称映射到 T1.x catch，实际 T1.1~T1.4 无此用例 |
| §4 时序图 2 alt/else（steer 成功/失败） | ✅ | ✅ T2.1/T2.4 | 对齐 |
| §4 时序图 3 alt（幂等）+ 4 异常源 | ✅ 7 reason 全 | ⚠️ T4.1/T4.2/T4.3/T4.4/T4.5 | 缺 `message.error`→`'error'` reason 独立用例（nit，与 stream_error 终态同映射） |
| §4 时序图 4 alt/else（abort 成功/RPC 失败） | ✅ 两分支 | ⚠️ 仅 T4.6（成功路径） | **should_fix #1**：abort RPC 失败 else 分支（toast + 实体残留）无用例 |
| §4 时序图 5 alt/else（busy/idle） | ✅ | ✅ T6.1/T6.3 | 对齐 |
| §2 模块 F catch 分类（SF-2 两分支） | ✅ 双路径 | ⚠️ T9.8 仅测 send.rejected 分支 | **must_fix #2**：谓词未定义；「其他错误→message.error」分支亦无用例 |
| §2 模块 G SMH rejected→reply | ✅ | ❌ **无** | **should_fix #2**：dispatcher broadcast（T6.1）与前端回滚（T6.2）之间，SMH `reply('message.status',{rejected})` 路由断档 |
| NFR 18 条代码测试 | ✅ 全 | ✅ T9.1~T9.18 全映射 | 对齐，无遗漏 |
| §5 sealed 6 delta + tool_call_end 边界 | ✅ | ✅ T4.7/T9.5 | 对齐（T4.7 以 text_delta 为代表，其余 5 delta 类未逐个参数化，nit） |
| AC grep（isStreaming/resetActive/busy 无 error） | ✅ | ✅ T7.1/T7.2/T7.3 | 对齐 |
| perf-chaos（scan/24h timer） | ✅ | ✅ T8.1/T8.2 | 对齐 |

**parallelGroup / dependsOn / 测试层 标注**：§6 每行均完整标注，分组（chat-store/usechat/composer/useconn/dispatcher/effects/grep/perf）与 Wave DAG（W1: #1#2#3#4#8 / W2: #5#6#7）一致，跨 Wave 依赖（如 T1.4 usechat 组 dependsOn #2#5）合理。此三项无系统性问题。

**自检条目核验**：
- 「§4 时序图每个 alt/else 映射到一条异常用例」→ **假**（时序图 1 alt、时序图 4 else 未映射）
- 「来源 B 占位 {PLACEHOLDER_NFR_SOURCE_B} 待回灌」→ 该占位仍残留在自检清单（未勾选），但实际 T9.1~T9.18 已回灌，属自检清单未更新（nit）

## must_fix

### MF-1：补 send api.send 失败 catch 用例（时序图 1 alt 无对应 + 自检造假）

**位置**：§6 UC-1（T1.1~T1.4）+ 覆盖完整性自检第 3 条。

**问题**：§4 时序图 1 唯一 alt 分支「api.send 失败（hook 拦截/WS 断连）→ clearPendingSend(sid) + throw → Composer 恢复草稿 + toast」。§6 UC-1 四条用例（T1.1 message_start 空窗 / T1.2 complete 收口 / T1.3 终态不可逆 / T1.4 send 全链成功路径）无一覆盖此 catch。自检第 3 条却声称「时序图 1 alt→T1.x catch」——断言与表格不符。

**影响**：send 失败时 pendingSend 不回滚 → isActive 派生永久 true（pendingSend 残留）→ Composer 卡 busy 态。这正是 pendingSend 生命周期的异常出口，无测试则回归无防护。

**修复**：新增 T1.5（unit，parallelGroup `usechat`，dependsOn #5）：`send idle + chatApi.send mock reject → clearPendingSend 调用 + throw + pendingSend 无 sid`。同步修正自检第 3 条为「时序图 1 alt→T1.5」。

### MF-2：定义 dispatcher catch 分类谓词（契约空洞 + T9.8 不可实现）

**位置**：§2 模块 F `sendPrompt catch 分类（SF-2 决断）` 行 + §7 骨架覆盖表（dispatcher 标 N/A）。

**问题**：§2 要求 catch 按「错误语义分流」：
- `pi already processing` 拒绝 → `broadcast send.rejected`（busy 语义）
- 其他 prompt 错误 → `broadcast message.error`（流终止语义）
- 明示「不扩大 send.rejected 语义到所有 prompt 失败」

但 D-009 明确禁止字符串匹配（pi 升级改文案即断），§2 未给出替代检测机制（error code？RPC 返回标志？error 类型？）。T9.8（NFR-T-PI-REJECT-ROUTE）测此分流契约，却无可实现谓词——implementer 无法判定「何为 already processing 拒绝」。

SV-4 已把此标为「需⑤骨架验证 pi 抛错形态」，但 §7 显式跳过 dispatcher 骨架（「runtime 侧改动小，实现期直改；非新签名」），开放问题在 code-arch 未收敛。

**影响**：实现期 implementer 被迫二选一：(a) 妥协用字符串匹配（违反 D-009）；(b) 保守把所有 prompt 失败都走 send.rejected（违反 §2「不扩大语义」）。两条都违反既定决策。或回头打断 Step 6 问用户——成本更高。

**修复（任选其一，推荐 A）**：
- **A（长期）**：§2 模块 F 补 catch 谓词定义——预检为权威机制（sendPrompt 入口 isGenerating 检查），catch 路径仅处理预检竞态窗口（SV-4/C2）内的 pi 拒绝；由于预检已挡住显式 busy，catch 内的 pi 拒绝在语义上等价 busy，**catch 内所有 pi prompt 拒绝统一走 send.rejected**（即接受 SV-4 的「保守处理」选项，并据此修订 §2「不扩大语义」措辞为「catch 窗口内统一 send.rejected，预检为权威分流」）。同时补 dispatcher-skeleton 验证此谓词。
- **B（短期）**：保留 §2 两分支要求，但在 §2 明示检测信号（如 pi RPC error 的 code/type 字段，需实现期首日 spike 确认 + 回填契约），并补骨架 stub。

无论 A/B，T9.8 的「预期」列需改为可机器判定的断言（当前「busy 语义拒绝 → send.rejected」隐含了未定义的判定逻辑）。

## should_fix

### SF-1：补 abort RPC 失败用例（时序图 4 else 分支）

§4 时序图 4 `else abort RPC 失败（pi 死/getClient 抛）→ reject → toast，实体残留靠 runtime 重启/WS 断连兜底`。§6 T4.6 仅覆盖 alt 成功路径（乐观清 + message.complete{aborted} 兜底收口），else 失败路径无用例。

该分支验证：abort catch 不重抛 + toast 反馈 + pendingSend 已乐观清（即便 RPC 失败）。若未测，abort 失败时 throw 外泄 / pendingSend 未清等回归无防护。

**修复**：新增 T4.8（unit，parallelGroup `usechat`，dependsOn #5）：`busy + abort + chatApi.abort mock reject → clearPendingSend 已调 + toast 调用 + 不 throw`。同步修正自检第 3 条「时序图 4 alt→T4.6」为「alt→T4.6 / else→T4.8」。

### SF-2：补 session-message-handler rejected→reply 用例（§2 模块 G 路由断档）

§2 模块 G：`sendMessage 返回消费 加 rejected 分支 → reply('message.status',{status:'rejected'})（pending 干净 resolve），区别于 blocked→sendError`。这是 §4 时序图 5 中 SMH 的关键路由（防 rejected 误走 sendError 显示错误）。

§6 T6.1 测 dispatcher 预检 broadcast，T6.2 测前端 useChat 回滚，中间 SMH 的 `result.rejected → reply` 路由无独立用例。若 SMH 误把 rejected 当 blocked 走 sendError，前端会收到 message_blocked 错误而非干净 resolve——与 send.rejected「不污染对话流」语义矛盾。

**修复**：新增 T6.4（unit，parallelGroup `dispatcher`，dependsOn #1 #4）：`sendMessage 返回 {blocked:true,rejected:true} → reply('message.status',{status:'rejected'})，未调 sendError`。

### SF-3：统一「异常源」计数（时序图 3 标题 vs body vs 骨架）

计数三方不一致：
- §4 时序图 3 标题：「6 条异常源统一出口」
- §4 时序图 3 Note：「异常源: timeout / stream_error / disconnect / restart」（4 条）
- chat-store-skeleton `finalizeSession` 注释：「6 条异常 + 2 条事件驱动终态」后列「timeout/disconnect/restart + complete{agent_end/aborted}/message.error/stream_error」（3+4=7）

FinalizeReason 实际 7 值：3 条非事件兜底（timeout/disconnect/restart）+ 4 条事件驱动（normal/aborted/stream_error/error）。

**修复**：统一为「7 条 reason（3 兜底 + 4 事件驱动）」，修正时序图 3 标题与骨架注释。计数混乱会误导 implementer 对 finalizeSession 触发源的理解。

### SF-4：dispatcher 补骨架（§7 显式跳过导致 SF-2/MF-2 双重未验证）

§7 骨架覆盖表将 `dispatcher.sendPrompt 预检` 标 N/A（「runtime 侧改动小，实现期直改；非新签名」）。但：
- MF-2 的 catch 分类谓词是 SV-4 标注的开放问题，需骨架验证 pi 抛错形态；
- M11（runtime isGenerating broadcast 终态前同步置 false）、M12（预检置于最入口 hooks 前）均标「骨架约束」却无骨架承载。

runtime 侧虽「改动小」，但 catch 分类的契约复杂度不低（两分支 + D-009 约束 + 竞态窗口）。建议补 `dispatcher-skeleton.ts`（至少 stub 预检入口 + catch 分支签名），与 4 个 renderer 骨架同级验证。

## nit

### N-1：message.error→`'error'` reason 无独立用例
T4.1 测 stream_error，T1.2 测 normal。`message.error` handler→`finalizeSession('error')`（§2 reason 表 'error'→(error,error)）无独立用例。与 stream_error 终态映射相同，低优先，但 effects-skeleton 显示两者是不同 handler，建议参数化或补一行。

### N-2：AC-1.2 无用例
AC-1.2「send.rejected 不触发 message.* handler（effects 注册表无映射）」无对应用例。可作 grep/契约检查（`messageEffects` 注册表无 `'send.rejected'` key + dispatchMessageEvent 对该 type no-op）。

### N-3：6 个 delta 类 sealed guard 仅 text_delta 代表性测试
T4.7 输入「注 text_delta」，T9.5 验 sealed 边界（delta sealed / tool_call_end 覆盖）。thinking_start/thinking_delta/thinking_end/tool_call_start/tool_call_update 5 类未逐个参数化。建议 T4.7 改 parameterized（each.of 6 delta types）。

### N-4：protocol 骨架引入 SendRejectedReason 别名，§2 未列
protocol-skeleton 定义 `SendRejectedReason = 'busy'` 类型别名，§2 签名表直接写 `reason: 'busy'` 内联字面量。骨架更精确（命名类型利于扩展），但 §2 签名表应同步列 `SendRejectedReason` 以保持文档/骨架一致。

### N-5：effects-skeleton import 目标应注明 chat-store-types.ts
effects-skeleton `import type { FinalizeReason, QueueState, RetryState } from './chat-store-skeleton'`。§1 规定 FinalizeReason 住在 `chat-store-types.ts`（独立类型文件，非 chat.ts）。合并骨架文件模糊了「types 文件 vs store 文件」边界。§3 去环规则「effects 不 import chat.ts」成立的前提是 import 指向 chat-store-types.ts——建议骨架注释明示真实 import 目标，防 implementer 误 import chat.ts（即便 type-only 不致循环，也违背分层纪律）。

### N-6：自检占位 {PLACEHOLDER_NFR_SOURCE_B} 未勾选
§6 自检末条「来源 B 占位 {PLACEHOLDER_NFR_SOURCE_B} 待回灌」未打勾，但 T9.1~T9.18 已实际回灌。占位残留，应勾选并改为「已回灌（T9.1~T9.18）」。

---

## 附：5 视角结论速览

| 视角 | 结论 | 关键发现 |
|------|------|---------|
| **API 契约（§2）** | 基本一致 | 签名表与骨架对齐；MF-2 catch 谓词是唯一契约空洞；dispatcher 无骨架（SF-4） |
| **包依赖图（§3）** | 通过 | 无环；effects ctx 注入去环 seam 成立；N-5 import 目标需注明 |
| **时序图（§4）** | 基本覆盖 | 时序图 1 alt / 时序图 4 else 未映射用例（MF-1/SF-1）；异常源计数混乱（SF-3） |
| **sealed 实现（§5）** | 通过 | tool_call_end 不 sealed 在骨架正确体现；6 delta sealed 一致；N-3 建议参数化 |
| **test-matrix 重建** | 条件通过 | NFR 18 条全映射无遗漏；2 个 must_fix（自检造假 + catch 谓词）；parallelGroup/dependsOn/测试层 标注完整 |
