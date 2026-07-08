---
reviewer: independent (issues 覆盖重建路)
method: 反向认知帧——先从 system-architecture.md §5/§7/§8/§10 按 4 轴独立重建可拆元素，再 diff issues.md
read_order: decisions.md → system-architecture.md → requirements.md → (重建) → issues.md
verdict: pass
---

# Issues 覆盖审查（反向重建路）

## Verdict

**pass（5 条可操作精修，0 阻塞）**

issues.md 的 issue 拆分质量高：9 个 issue 全部可回溯到架构（含 #9 → BC-6 显式 out-of-scope 占位），无 PHANTOM。4 轴覆盖完整，方案对比带预决策 rationale，AC 带 UC trace。

5 条 gap 均为精修级：
- 1 条真实覆盖漏项（UC-6 submitFirstMessage，K）
- 2 条 AC 未钉死**非显然决策**（reason→status 映射，D）—— 这是最高价值发现，D-008 abort→complete 因矛盾而生，直觉答案是 error，AC 不钉死易实现漂移
- 2 条 DAG/枚举完整性（K + D，低危）

## 重建结论（独立推导的应有 issue 集）

从 system-architecture.md §4/§5/§7/§8/§10/§11/§12 按 4 轴扫描，独立重建出 9 个应有 issue，与 issues.md 实际 9 个 issue 几乎一一对应：

| 重建 ID | 应有 issue | 轴 | P | 依赖 | issues.md 对应 | 对齐 |
|---------|-----------|----|----|------|---------------|------|
| R-1 | chat.ts store 状态模型重构（删 flag/timer + computed isGenerating/isActive + pendingSend + finalizeSession + sealed） | 状态+模块 | P0 | — | #2 | ✅ |
| R-2 | effects handler 迁移 + sealed guard | 模块 | P0/P1 | R-1 | #3 | ✅ |
| R-3 | protocol.ts send.rejected 类型（shared） | 边界 | P0 | — | #1 | ✅ |
| R-4 | message-dispatcher runtime 预检广播 | 边界 | P0/P1 | R-3 | #4 | ✅ |
| R-5 | useChat 编排迁移（send/steer/abort/editAndResend/**submitFirstMessage** + send.rejected 监听） | 模块 | P1 | R-1,R-2 | #5 | ⚠️ 见 MISSING-1 |
| R-6 | useConnection resetActive→finalizeSession | 模块 | P1 | R-1 | #6 | ✅ |
| R-7 | 超时兜底行为变更（BC-3 + env） | 挑战 | P1/P2 | R-1 | #8 | ✅ |
| R-8 | Composer 鼠标 B 策略路由（F4, D-6） | 挑战 | P1 | R-1,R-5 | #7 | ✅ |
| R-9 | AC grep 验收 + BC 回归基线（独立 issue） | 测试 | P1 | all | （折叠进各 issue AC + CW testCases 层） | ✅ 设计选择合理，非漏项 |

**重建与实际的轴覆盖一致性**：状态轴（§4/§5）、模块轴（§7 六模块）、边界轴（§8 send.rejected）、挑战轴（§10 D-1~D-6 + BC-1~6）四轴全部命中。#8 的 P2 定级理由（"callback 改 finalizeSession 是 #2 删 timer 的编译必然，独立部分仅 env 配置 = 增强"）比重建默认的 P1 更精准——编译强制部分随 #2，独立增强才值 P2。**认可 issues.md 的 P 分级**。

**#9（abort 复活 steer，P3）非 PHANTOM**：架构 §12 BC-6 显式 "已知风险，本 topic 不修，需在 mid-detail-plan NFR 标注"。#9 作为 P3/fog 占位服务于该追溯要求，合理。issue 决策图保留一个永不实现的节点是为 NFR 风险留锚。

## 三态 gap

### MISSING（漏项）

**M-1 [K]：UC-6 submitFirstMessage（landing 首发空窗）未在 #5 显式覆盖，无 AC-6.1 trace**

- 证据：requirements UC-6「landing 态首发（submitFirstMessage）… AC-6.1 landing 首发的空窗期由 pendingSend 覆盖（create 后 add）」是独立用例。架构 §7 useChat 改动列「send/editAndResend 路由」，**未列 submitFirstMessage**。issues.md #5 问题描述枚举「send/editAndResend/steer/abort」，AC 表（AC-5.1~5.4）**无 AC-6.1 trace**。
- 结构性观察：issues.md「上游覆盖核验」表只交叉验架构 §5/§7/§8/§10/§11/§12，**未交叉验 requirements UC-1~UC-6 / AC-1.1~AC-6.1**。UC-6 在该表无对应行 → 验证盲区。
- 为何 K：架构文档无法判定 submitFirstMessage 是否独立 send 路径（有无独立 setDispatching 调用点）。若它内部复用 send()，#5 的 "send" 覆盖之；若它是 create→send 的独立编排分支，则需显式纳入 #5 并补 AC-6.1 trace。
- 处置：核实 `useChat.ts` submitFirstMessage 是否调 setDispatching/dispatchingSessionId。是 → #5 显式补 submitFirstMessage pendingSend.add（create 后 add）+ AC-6.1 trace；否 → 在 #5 注明 "submitFirstMessage 经 send() 复用，已覆盖"。

### PHANTOM（脱锡，issue 无架构依据）

**无。** 9 个 issue 全部回溯到架构：#1~#8 → §7 六模块 + §8 边界 + §10 挑战；#9 → §12 BC-6 显式 out-of-scope 占位。

### MISMATCH（虚覆盖 / 精度不足）

**MM-1 [D]：#2 AC 未钉死 reason→message.status 映射，尤其 D-008 的非显然决策「finalizeSession('aborted') → complete（非 error）」**

- 证据：架构 §5 reason 映射表规定 `aborted → message.status=complete`，D-008 明确「abort 终态保持 complete（不映射 error）」，理由是「arch reviewer SF-1 发现 §5 与 BC-2 矛盾，此决策消除矛盾」。issues.md #2 AC-2.4 只笼统说「streaming message→终态」，**未钉死 aborted→complete**。
- 为何高危且可自决（D）：D-008 存在的**全部理由**就是直觉答案（abort→error）是错的、曾引发矛盾。AC 不钉死，实现者按直觉把 abort 映射 error 会**重新引入 D-008 已消除的 §5↔BC-2 矛盾**。这是「决策非显然 + AC 未捕获」的典型漂移陷阱。
- 处置：#2 增一条 AC：「finalizeSession('aborted') → message.status=complete（D-008，非 error）；stream_error/timeout/disconnect/restart → error」。源依据架构 §5 表。

**MM-2 [D]：#2 AC 未钉死 reason→toolCall.status 映射（end_not_received 语义）**

- 证据：架构 §5 表规定 `timeout/disconnect/restart → toolCall.status=end_not_received`，`stream_error→error`，`normal/aborted→completed`。issues.md #2 AC-2.4 只说「running toolCall→收口」笼统，**未钉死 end_not_received**。
- 风险：若 finalizeSession 把所有异常收口的 toolCall 一律标 error，则 timeout/disconnect 场景丢失「工具未返回」语义（end_not_received 与 error 是不同终态，消费方区分）。
- 处置：#2 AC-2.4 细化为按架构 §5 表的 reason→toolCall.status 映射（明确 end_not_received 触发条件）。

**MM-3 [K]：#2 方案 A 删除的 ref 枚举（4 个）可能遗漏 dispatchingTimer**

- 证据：架构 §1 搭便车改造目标显式命名「删除 **streamingTimer/dispatchingTimer** 补丁」（两个 timer）。issues.md #2 方案 A 改动枚举「isStreaming/streamingSessionId/dispatchingSessionId/**streamingTimer** 4 个 ref」——列了 streamingTimer 与 dispatchingSessionId（id），**未列 dispatchingTimer**。
- 为何 K：架构文档无法判定 dispatchingTimer 是否独立 ref（vs dispatchingSessionId 的伴随 timer）。若源码中 dispatchingTimer 是独立 setTimeout ref，#2 枚举不全 → 删除遗漏 → 残留 timer 引用编译断或运行时悬挂。
- 处置：核实 `chat.ts` 是否存在独立 dispatchingTimer ref。是 → 补入 #2 删除枚举；否（dispatching 概念无独立 timer）→ 在 #2 注明 dispatchingTimer 非独立 ref，§1 命名为概念性。

**MM-4 [D]：DAG 缺 #1→#5 边（send.rejected 类型依赖）**

- 证据：#5 监听 send.rejected 需引用 #1 定义的 `SendRejectedPayload` 类型（TS 类型依赖）。issues.md 依赖图声明 #5←{#2,#3}，**未声明 #1→#5**。
- 低危：#1（P0）与 #5（P1）分层级，实际 wave 顺序已保证 #1 先；类型依赖可在同 wave 内解决。但 DAG 完整性上，监听方对类型定义的依赖应显式。
- 处置：补 #1→#5 边，或在 #5 注明「send.rejected 监听依赖 #1 类型，同 wave 内 #1 先定义」。

---

## 标记说明

| 标记 | 含义 |
|------|------|
| F | 需二次确认（向用户求证） |
| K | 问用户 / 查源码可定（本审查无法从架构文档独立判定） |
| D | agent 自决（有充分架构依据，可直接处置） |

5 条 gap 分布：K×2（M-1 submitFirstMessage、MM-3 dispatchingTimer，均需查 `useChat.ts`/`chat.ts` 源码）、D×3（MM-1/MM-2 reason 映射 AC 钉死、MM-4 DAG 边）。无 F（无需向用户求证，全部可由 agent 查源码 + 补 AC 解决）。
