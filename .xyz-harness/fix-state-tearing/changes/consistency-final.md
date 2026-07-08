---
verdict: CONSISTENT
checks_run: 4
fix_round: 1（M-1~M-10 全部修复后转 CONSISTENT）
---

# 全文档一致性终检

> 独立一致性终检（合并 full 6b 反哺 + 6c 终检）。上下文与主 agent 隔离，仅读 6 份 deliverable + decisions.md + 5 个骨架，不修改任何文件。
> 检查范围：跨文档矛盾 / decisions.md 一致性 / 测试闭环 / 反哺处理。

## 结论先行

**verdict: INCONSISTENT** —— 存在 3 个硬矛盾（M-1/M-2/M-3），均为「mid-detail-plan 阶段 anomaly 决策（D-011/D-014）已拍板，但上游文档/骨架残留旧值」，会直接误导实现：
- M-1：toolCall 终态映射——issues AC-2.4 + chat-skeleton 注释写 `completed`，权威源（D-011 + arch §5 + code-arch §2）要求 `end_not_received`。按残留值实现 = D-011 要修的「虚假成功」bug 复发。
- M-2：NFR M13/SV-4 仍写「catch 走 send.rejected」，权威源（D-014 + code-arch §2/§6 + skeleton 代码）已决断「catch 一律 message.error」。
- M-3：dispatcher-skeleton 验证注释（L105）引用已删除的 `isPiAlreadyProcessing` 并提「分流」，与同文件 catch 代码（一律 message.error）矛盾。

另有 3 个签名表缺口（M-4/M-5/M-6，D-015/D-016/D-017 未回灌 code-arch §2）+ 3 个计数/归属瑕疵（M-7/M-8/M-9）+ 反哺登记缺失（M-10）。

---

## 1. 跨文档矛盾

### M-1 【硬矛盾·终态映射】toolCall 诚实态残留旧值（D-011 未完全回灌）

**权威源（一致，正确）：**
- `decisions.md` D-011：「running toolCall 收口时一律 → end_not_received（除 error/stream_error→error），**不直接 completed**；迟到 tool_call_end 覆盖到 completed」
- `system-architecture.md` §5 reason 映射表（L99）：`normal → message:complete, toolCall:end_not_received（诚实态，迟到 tool_call_end 覆盖到 completed）`；`aborted → ... end_not_received（同上）`
- `code-architecture.md` §2 模块 B 映射表（L58）：`normal → complete | end_not_received`；`aborted → complete | end_not_received`
- `effects-skeleton.ts` tool_call_end 注释：「不 sealed，允许覆盖 end_not_received → completed」

**残留旧值（与权威源矛盾）：**
- `issues.md` AC-2.4（L155）：「running toolCall→收口（timeout/disconnect/restart→**end_not_received**；stream_error→error；**normal/aborted→completed**，按架构 §5 映射表）」
  - 矛盾点：显式引用「架构 §5 映射表」却写出与该表相反的值（`completed` vs 表中的 `end_not_received`）。issues 内部自相矛盾 + 与 arch 矛盾。
- `code-skeleton/chat-store-skeleton.ts` L27-28 FinalizeReason 注释：
  ```
  normal      → message:complete, toolCall:completed
  aborted     → message:complete, toolCall:completed (D-008 保持 complete)
  ```
  - 矛盾点：D-008 只约束 `message.status=complete`（正确），但 toolCall 这里写成 `completed`，与 D-011 的诚实态不变式矛盾。

**影响**：若按 issues AC-2.4 / skeleton 注释实现，`normal`/`aborted` 收口时 running toolCall 直接标 `completed`。一旦 `tool_call_end` 事件丢失（pi 异常/WS 抖动），toolCall 显示成功但无真实 output——正是 D-011 要消除的「虚假成功」失败模式复发。T9.5（sealed 边界 + 覆盖路径）与残留值冲突，测试会暴露但实现者可能照注释写错。

**修复方向**：issues AC-2.4 把「normal/aborted→completed」改为「normal/aborted→end_not_received（迟到 tool_call_end 覆盖到 completed，D-011）」；chat-store-skeleton L27-28 注释同步改 `toolCall:end_not_received`。

---

### M-2 【硬矛盾·catch 决断】NFR 未随 D-014 反哺

**权威源（一致，正确）：**
- `decisions.md` D-014：「send.rejected 只由 runtime 预检触发；**catch 路径一律 message.error（不分类）**」
- `code-architecture.md` §2 模块 F（L126）：「catch 一律 message.error ... send.rejected 只由预检触发，catch 所有 prompt 失败都走 message.error ... NFR SV-4『所有 prompt 失败走 send.rejected』显式排除」，标注 `T9.8（修订）`
- `code-architecture.md` §6 来源 B T9.8（L478）：「catch 路径一律 message.error（F6 决断：不分类，send.rejected 只走预检）」，标注「修订（F6 决断）」✅（code-arch 内部已修订）
- `dispatcher-skeleton.ts` catch 代码（L61-71）：`broker.broadcast({ type: 'message.error', ... })` + L73 注释「catch 一律 message.error」

**残留旧值（与权威源矛盾）：**
- `non-functional-design.md` M13（L325 缓解项表）：「pi 拒绝 catch 路径走 send.rejected（非 message.error）｜message-dispatcher catch 分支 broadcast send.rejected（busy 语义）」❌ —— 落地方式与 D-014 完全相反
- `non-functional-design.md` L180（#4 可观测性缓解描述）：「pi 拒绝 catch 路径 log `[dispatcher] pi rejected (already processing)`」❌ —— 预设了 catch 会路由 send.rejected（actual processing），但 D-014 下 catch 不区分，该日志路径不存在
- `non-functional-design.md` SV-4（L384）：「catch 路径广播 send.rejected（非 message.error）」+「catch 路由可能需保守处理：所有 prompt 失败都走 send.rejected？还是仅 busy？」+「**待 code-arch 决定 catch 分类策略**」❌ —— SV-4 仍标「待决断」，但 code-arch §2 已引 SV-4 并明确排除「全走 send.rejected」选项

**影响**：NFR M13 是「回灌登记表」中标「代码测试」的缓解项，其「落地为」描述与实际决断相反。coding-execute 若照 M13 实现 catch 分支广播 send.rejected，会重新引入 D-014 要消除的「操作拒绝污染对话流」问题（catch 里所有 prompt 错误都变成「Agent 正在处理」toast，误导用户）。SV-4 标「待决断」会让执行者误以为还要自行决策。

**修复方向**：NFR M13 落地方式改为「catch 一律 message.error（D-014）」；M13 对应的测试断言改为「catch 不广播 send.rejected」；L180 缓解描述删除「pi rejected (already processing)」预设路径；SV-4 回写结论「code-arch §2 已决断：catch 一律 message.error，send.rejected 只走预检」。

---

### M-3 【硬矛盾·骨架自相矛盾】dispatcher-skeleton 验证注释引用已删除函数

**权威源（代码实现，正确）：**
- `dispatcher-skeleton.ts` L61-71 catch 代码：`broker.broadcast({ type: 'message.error', ... })` + `return { blocked: true }`
- `dispatcher-skeleton.ts` L73 注释：「[F6 决断] isPiAlreadyProcessing 不再需要——catch 一律 message.error，send.rejected 只走预检。函数已删除。」

**残留旧值（同文件内矛盾）：**
- `dispatcher-skeleton.ts` L2 文件头：「预检 + **catch 分类**（SF-2 决断）」❌
- `dispatcher-skeleton.ts` L15：「预检分支 + **catch 分类** + 返回类型」❌
- `dispatcher-skeleton.ts` L28 sendPrompt 文档注释：「入口预检 + **catch 分类**」❌
- `dispatcher-skeleton.ts` L31：「[SF-2 catch 分类决断] pi 拒绝（already processing 语义）→ send.rejected；其他 prompt 错误 → ... message.error」❌
- `dispatcher-skeleton.ts` L105 验证注释：「验证：**catch 分类真接 isPiAlreadyProcessing → 分流 send.rejected / message.error**」❌ —— 引用已删除的 `isPiAlreadyProcessing`，描述「分流」与代码「一律 message.error」矛盾

**影响**：骨架是「tsc gate + smoke 验证签名存在性」的契约。L105 验证注释若被执行（tsc 检查 isPiAlreadyProcessing 存在），会因函数已删除而失败；若被实现者照读，会重新引入 D-014 排除的分类逻辑。SF-2（分类）已被 F6（不分类）推翻，但文件头/文档注释/验证注释仍是 SF-2 措辞。

**修复方向**：dispatcher-skeleton L2/L15/L28/L31 把「catch 分类（SF-2 决断）」改为「catch 一律 message.error（F6/D-014 决断）」；L105 验证注释改为「验证：catch 一律 message.error（无 isPiAlreadyProcessing 分流）」。

---

### M-4 【签名表缺口·D-015】code-arch §2 addPendingSend 未提 pendingSendTimer

- `decisions.md` D-015：「pendingSend 空窗期保留 30s timer 兜底（dispatchingTimer 语义迁移到 pendingSendTimer）」
- `chat-store-skeleton.ts`：`PENDING_SEND_TIMEOUT_MS = 30_000` + `pendingSendTimer` + `clearPendingSendTimer`，addPendingSend 挂 timer、clearPendingSend 清 timer ✅
- `code-architecture.md` §2 模块 C `addPendingSend`/`clearPendingSend` 边界条件：仅「不可变 Set add/delete；幂等」，**未提 pendingSendTimer 挂载/清除语义** ❌

**影响**：签名表是 effects/useChat 的消费契约。消费者不知道 addPendingSend 会挂 30s timer、clearPendingSend 会清 timer。若实现者照签名表写（仅 Set 操作），会漏掉 D-015 的兜底——pi 静默卡死在 ack 后（不 emit message_start）时 isActive 恒 true（D-015 要修的回归）。

**修复方向**：code-arch §2 模块 C addPendingSend 边界条件追加「同时挂 pendingSendTimer（30s，D-015），防 ack 后 pi 静默卡死」；clearPendingSend 追加「同时清 pendingSendTimer」。或新增 `clearPendingSendTimer` / `PENDING_SEND_TIMEOUT_MS` 签名行。

---

### M-5 【签名表缺口·D-016】code-arch §2 STREAMING_TIMEOUT_MS 用模糊 readEnv

- `decisions.md` D-016：「XYZ_STREAMING_TIMEOUT_MS env 经 IPC 从主进程读（非 renderer import.meta.env）—— Vite renderer 不暴露 XYZ_ 前缀」
- `chat-store-skeleton.ts` `readStreamingTimeoutMs`：`electronAPI?.getStreamingTimeout?.()` 经 IPC ✅，注释明确 D-016
- `code-architecture.md` §2 模块 C：`STREAMING_TIMEOUT_MS = readEnv('XYZ_STREAMING_TIMEOUT_MS') ?? 86_400_000` ❌ —— `readEnv` 未定义，语义模糊

**影响**：签名表用 `readEnv`，实现者可能误用 `import.meta.env.XYZ_STREAMING_TIMEOUT_MS`（Vite 不暴露 XYZ_ 前缀，永远 undefined → 永远走默认 24h，env 配置失效）。D-016 正是要防此陷阱。

**修复方向**：code-arch §2 该行改为 `readStreamingTimeoutMs()（经 IPC 读主进程 env，D-016）`，或注明「readEnv = electronAPI.getStreamingTimeout（IPC）」。

---

### M-6 【缺口·D-017】code-arch 未显式体现 WS watch 不收口约束

- `decisions.md` D-017：「useConnection WS state watch（瞬态断连）**不触发 finalizeSession**，只 rejectAll pending；仅 onRuntimeFailed/onRuntimeRestarting 触发收口」
- `code-architecture.md` §1 文件 6 useConnection：仅「onRuntimeRestarting/onRuntimeFailed 两处 resetActive() → finalizeSession」，**未提 WS state watch 分支的 rejectAll pending（不收口）约束** ❌
- 5 个骨架中**无 useConnection-skeleton**（D-017 的落地契约缺骨架验证）

**影响**：useConnection 实现者若在 WS state watch（瞬态断连，ws-client 自动重连）也调 finalizeSession，网络抖动会错误收口为 error（pi 仍活、流可恢复）。D-017 正是要防此误收口。

**修复方向**：code-arch §1 文件 6 追加「WS state watch 仅 rejectAll pending，不调 finalizeSession（D-017，防瞬态断连误收口）」；建议补 useConnection-skeleton 或在 §2 补 useConnection 签名行。

---

### 一致项（核对通过，记录闭环）

以下关键映射/签名跨文档一致，无矛盾：
- **abort 终态保持 complete（D-008）**：arch §5 / arch §12 BC-2 / code-arch §2 模块 B / issues 上游覆盖表 / T4.6 断言，均一致（message.status=complete，非 error）。
- **finalizeSession 签名 errorText?（D-013）**：code-arch §2 模块 C / effects-skeleton MessageEffectContext / chat-store-skeleton / message.error+stream_error handler 传 errorText，一致。
- **finalizeAllStreaming helper（D-012）**：code-arch §2 模块 C / chat-store-skeleton，一致。
- **sealed 不变式 + tool_call_end 不 sealed（D-010/M8）**：arch §4/§5 / code-arch §5 / effects-skeleton / nfr SV-2 / T9.5，一致。
- **isGenerating per-session computed scan（D-005）**：arch §4 / code-arch §2 / chat-store-skeleton / nfr SV-1，一致。
- **send.rejected 独立类型（D-006）+ runtime 预检（D-009）**：arch §8 / code-arch §2 模块 F/G / dispatcher-skeleton 预检分支 / protocol-skeleton，一致。
- **execution Wave 依赖 vs code-arch §8**：execution 显式标注「偏离 §8 建议（#6/#8 提前到 W1）」+ 依赖不破坏（#6/#8 仅依赖 #2），属合理明确化，非矛盾。

---

## 2. decisions.md 一致性

逐条核对 D-001~D-017 在对应 .md 有无真实章节（source 溯源）：

| 决策 | source | 上游章节落地 | 状态 |
|------|--------|-------------|------|
| D-001~D-010 | mid-plan | requirements/arch/issues/nfr/code-arch 全链覆盖 | ✅ 溯源不断 |
| **D-011** | anomaly F3 | arch §5 ✅ / code-arch §2 ✅ / **issues AC-2.4 ❌** / **chat-skeleton 注释 ❌** | ⚠️ 残留（M-1） |
| D-012 | anomaly F1 | code-arch §2 模块 C ✅ / chat-skeleton ✅ | ✅ |
| D-013 | anomaly F2 | code-arch §2 ✅ / effects-skeleton ✅ / chat-skeleton ✅ | ✅ |
| **D-014** | anomaly F6 | code-arch §2 ✅ / §6 T9.8 ✅ / skeleton 代码 ✅ / **nfr M13+SV-4+L180 ❌** / **skeleton 注释 ❌** | ⚠️ 残留（M-2/M-3） |
| **D-015** | anomaly F4 | chat-skeleton ✅ / **code-arch §2 签名表 ❌** / **nfr 无对应 M 条目 ❌** | ⚠️ 缺口（M-4） |
| **D-016** | anomaly F5 | chat-skeleton ✅ / **code-arch §2 签名表（readEnv 模糊）❌** | ⚠️ 缺口（M-5） |
| **D-017** | anomaly F7 | **code-arch §1 未显式 ❌** / **无 useConnection-skeleton ❌** | ⚠️ 缺口（M-6） |

**无残留 superseded_by 链**：D-001~D-017 全部 status=confirmed，无 superseded_by 值，无 revisited 状态，决策账本无悬空推翻。✅

**结论**：D-001~D-010 溯源完整；**D-011/D-014/D-015/D-016/D-017 五条 anomaly 决策在上游 .md/骨架有残留或缺口**（对应 M-1~M-6）。decisions.md 本身 append-only 账本完整，问题在消费侧未完全回灌。

---

## 3. 测试闭环

### 3.1 用例 ID 集合闭环 ✅

execution 全量清单（L193）：`T1.1-T1.5, T2.1-T2.5, T3.1-T3.3, T4.1-T4.8, T5.1, T6.1-T6.4, T7.1-T7.3, T8.1-T8.2, T9.1-T9.18`
code-arch §6 全量（来源 A UC-1~6 + grep + perf + 来源 B T9.1-T9.18）：集合相等 ✅

（注：T6.4 在 code-arch §6 L448 存在「SMH rejected→reply 路由」，execution L159 对应一致；初次 read code-arch 时因截断漏看，经 grep 确认存在。）

### M-7 【计数瑕疵】code-arch §6 来源 B 计数自相矛盾

- `code-architecture.md` L490：「**17 条**用例回灌（T9.1~T9.17），其中 7 条与来源 A 同断言 ... 10 条是来源 A 未覆盖的补充」
- `code-architecture.md` L497 自检：「来源 B 已回灌（T9.1~T9.18，**18 条**）」
- 实际表格（L470-488）：**18 行**（T9.1-T9.18 全列）
- nfr 缓解项登记：代码测试项 18 条（M2/M3/M4/M5/M7/M8/M9/M11/M13/M14/M15/M16/M17/M18/M19/M20/M21/M22），与 18 行对齐

**矛盾**：L490 文字（17 条 / T9.1~T9.17）vs L497 自检（18 条 / T9.1~T9.18）vs 实际表格（18 行）。L490 文字错误（漏数 T9.18/M22），「7 同断言 + 10 补充 = 17」的算术也因漏 T9.18 失效。

**修复方向**：L490 改为「18 条用例回灌（T9.1~T9.18）」，重算同断言/补充数。

### M-8 【归属瑕疵】T1.5 测试层 + Wave 归属冲突

- `code-architecture.md` §6 T1.5：测试层 **unit**
- `execution-plan.md` 测试分层 L171：T1.5 归 **integration**（W2）
- `execution-plan.md` Wave 覆盖清单：T1.5 同时出现在 **W1 覆盖**（L71）和 **W2 覆盖**（L112）

**矛盾**：测试层 unit vs integration；Wave 归属 execution 内部 W1 与 W2 重复列 T1.5（dependsOn #2 #5，#5 在 W2，逻辑应归 W2）。

**修复方向**：统一 T1.5 测试层（建议 integration，因 mock api.send reject 属集成）；execution W1 覆盖清单删除 T1.5。

### M-9 【归属瑕疵】T9.3 测试层在 execution 重叠

- `code-architecture.md` §6 T9.3：**perf-chaos**（= T8.1 同断言）
- `execution-plan.md` unit 层 L163：「T9.1~T9.8」（简写范围含 T9.3）
- `execution-plan.md` perf 层：也列 T9.3

**矛盾**：T9.3 在 execution 同时落入 unit 范围（T9.1~T9.8 简写）和 perf 层。简写歧义。

**修复方向**：execution unit 层 T9 范围改为显式列举（排除 T9.3），或标注「T9.1~T9.8 中除 T9.3（perf）」。

### 3.2 NFR 缓解项 → test-matrix 来源 B 映射 ✅（除 M-2 的 M13）

nfr 标「代码测试」的 18 条缓解（M2/M3/M4/M5/M7/M8/M9/M11/M13/M14/M15/M16/M17/M18/M19/M20/M21/M22）→ code-arch §6 来源 B T9.1-T9.18 一一对应。
**唯一例外**：M13（对应 T9.8）的「落地为」描述与 D-014 决断相反（M-2），T9.8 已在 code-arch §6 修订但 nfr M13 未同步——映射关系在，但 nfr 侧描述需修正。

---

## 4. 反哺处理

### M-10 【反哺登记缺失】backfed_from 全空 vs 实际未反哺残留

6 份 deliverable 的 frontmatter `backfed_from` 字段**全部为 `[]`**：
- requirements.md / system-architecture.md / issues.md / non-functional-design.md / code-architecture.md / execution-plan.md

但 mid-detail-plan 阶段产生的 anomaly 决策（D-011~D-017，source 标 `[from: anomaly F1~F7]`）有 5 条未完全回灌到上游 .md/骨架：

| 决策 | 应反哺到 | 实际状态 | 对应发现 |
|------|---------|---------|---------|
| D-011（F3） | issues AC-2.4 + chat-skeleton 注释 | 残留 `completed` | M-1 |
| D-014（F6） | nfr M13 + SV-4 + L180；dispatcher-skeleton 注释 | 残留「catch 走 send.rejected」/「分流」 | M-2 / M-3 |
| D-015（F4） | code-arch §2 签名表 | 缺 pendingSendTimer | M-4 |
| D-016（F5） | code-arch §2 签名表 | readEnv 模糊 | M-5 |
| D-017（F7） | code-arch §1 + useConnection-skeleton | 缺 WS watch 约束 + 无骨架 | M-6 |

**佐证**：`non-functional-design.md` 自检章节明确写「决策账本不推翻：**D-001~D-010** 全部尊重」——仅覆盖到 D-010，未提 D-011~D-017，印证 NFR 是 mid-detail-plan 前定稿，后续 anomaly 决策未回灌。

**注**：材料中未见 reviewer 显式 `[BACKFED]` / `must_fix` 标记（这些应在 changes/review-*.md，本次未要求读取）。但 D-011~D-017 的 source `[from: anomaly F*]` 即 anomaly 猎手发现项，等效于 must_fix。反哺处理判定基于：决策已 confirmed，但消费侧文档未同步。

**修复方向**：
1. 处理 M-1~M-6 后，将受影响文档的 `backfed_from` 填入 `[D-011, D-014, D-015, D-016, D-017]`（或对应的 anomaly F-id）。
2. NFR 自检章节「决策账本不推翻」范围扩展到 D-001~D-017。

---

## 结论

**verdict: INCONSISTENT**

10 项发现，按严重度：

**硬矛盾（阻塞实现，必须修后再过 gate）：**
- **M-1** toolCall 终态映射残留 `completed`（issues AC-2.4 + chat-skeleton L27-28）→ 应 `end_not_received`（D-011）。误实现 = 虚假成功 bug 复发。
- **M-2** NFR M13/SV-4/L180 残留「catch 走 send.rejected」→ 应「catch 一律 message.error」（D-014）。误实现 = 操作拒绝污染对话流。
- **M-3** dispatcher-skeleton L2/L15/L28/L31/L105 注释残留「SF-2 分类/isPiAlreadyProcessing 分流」→ 应「F6 一律 message.error」（D-014）。骨架自身注释 vs 代码矛盾。

**签名表缺口（会导致实现者漏机制，应修）：**
- **M-4** code-arch §2 addPendingSend 缺 pendingSendTimer（D-015）
- **M-5** code-arch §2 STREAMING_TIMEOUT_MS readEnv 模糊（D-016，应 IPC）
- **M-6** code-arch §1 useConnection 缺 WS watch 不收口约束 + 无骨架（D-017）

**计数/归属瑕疵（不影响正确性，影响验收清晰度）：**
- **M-7** code-arch §6 来源 B 计数 17 vs 18 自相矛盾（L490 文字错误）
- **M-8** T1.5 测试层 unit vs integration + Wave W1/W2 重复归属
- **M-9** T9.3 在 execution unit 范围与 perf 层重叠

**反哺登记：**
- **M-10** backfed_from 全空但 D-011/D-014/D-015/D-016/D-017 未完全回灌（M-1~M-6 的根因）

**建议处理顺序**：先修 M-1/M-2/M-3（硬矛盾，改 issues AC-2.4 + chat-skeleton 注释 + nfr M13/SV-4/L180 + dispatcher-skeleton 注释），再补 M-4/M-5/M-6 签名表缺口，最后清 M-7/M-8/M-9 计数归属 + 填 backfed_from（M-10）。修完后重跑本终检应转 CONSISTENT。
