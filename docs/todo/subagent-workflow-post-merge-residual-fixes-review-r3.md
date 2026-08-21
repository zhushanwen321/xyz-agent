# subagent-workflow-post-merge-residual-fixes-review (R3)

> **审查对象**：`docs/todo/subagent-workflow-post-merge-residual-fixes.md` v3
> **基线**：`fix-chat-flow-order` 分支 HEAD（commit 3af2baa71），代码核实于 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/`
> **审查身份**：对抗式审查（adversarial reviewer），默认假设方案有问题，逐项找证据反驳
> **审查依据**：`rubric-design-doc.md` P0/P1 清单
> **前序报告**：R1（`subagent-workflow-post-merge-residual-fixes-review.md`，2 must-fix / 2 suggestion / 2 info）、R2（`subagent-workflow-post-merge-residual-fixes-review-r2.md`，3 must-fix / 1 suggestion）
> **日期**：2026-08-20

---

## Summary

2 must-fix, 2 suggestions.

**总体判断**：R2 的三个 must-fix 修复方向全部正确落地——chatMode 替代 mode 做三形态判据（R2-MF1）、collectRecords 接线点具体化 + session_start 主动触发 + writeFinalized sidecar 防重（R2-MF3）、冷路径续轮清 resumable 标注为新增行为（R2-SG）。v3 防重设计（sidecar → 分支 2 不再重判）经源码核实成立。核心架构决策经源码交叉核实成立。

**但发现 §5.4 三形态判据表遗漏第四形态（孤儿无文件兜底）**：表中三行（streaming / waiting / done）未覆盖"running + resumable + 无 result + chatMode 非 true"的孤儿兜底形态——该形态在场景 B（§4.1）和 §6.1 第 2 条明确要求显示为"等待"，但 §5.4 表和 §6.3 isWaiting 条件均不命中。这是一个表-条件-场景三方不一致，实现者按表实现会把孤儿显示为 streaming（默认分支），与设计意图矛盾。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| **MUST_FIX** | §5.4 表 + §6.3 | P0-10 对抗 + P0-12 遗漏 | **三形态判据表遗漏孤儿兜底第四形态**。表中三行：(1) running + 无 result + 无 resumable → streaming；(2) running + (resumable \|\| result) + chatMode=true → waiting；(3) running + result + chatMode 非 true → done。孤儿无文件兜底形态（running + resumable + 无 result + chatMode 非 true/undefined）不命中任何一行：行 1 被 resumable 排除，行 2 被 chatMode 排除，行 3 被 result 排除。按表实现 + CSS 条件默认分支，孤儿会落 streaming（spinner），与场景 B（§4.1 "显示 waiting（非 running 转圈、非 error）"）和 §6.1（"不判终态 → running + resumable=true"侧栏投影「等续聊」）矛盾。附带矛盾：§5.2 决策表方案 a 的原始表述 `running && (result !== undefined \|\| resumable) → waiting` 比 §5.4 细化表更宽（不含 chatMode 限定），两处不一致——实现者不知以哪个为准。 | §5.4 表补第四行：`running + resumable + 无 result + chatMode 非 true` → waiting（孤儿兜底——进程已死，无产出可判，等续聊方向保守）。§6.3 isWaiting 条件改为 `running && !isStreaming && (chatMode === true \|\| result === undefined)`——捕获孤儿（result=undefined → isWaiting=true）同时不误捕 one-shot 轮终（result 有值 + chatMode 非 true → isWaiting=false → isDone=true）。§5.2 方案 a 表述对齐细化表（补 chatMode 条件或注明细化表为准） |
| **MUST_FIX** | §5.4 表行 2 | P0-10 对抗 | **行 2 "running + (resumable \|\| result) + chatMode=true → waiting"把无 result 的 chat 轮终首态也排除在 waiting 之外**。chatMode=true + resumable=true + result=undefined 是"chat 轮终首态正在进行"（进程还活着，doFinalizeRoundToIdle 尚未执行）——此态 isStreaming 被 resumable 排除（正确：进程活着但 resumable 标记尚未写入的窗口极窄），isWaiting 被 result=undefined + chatMode=true 命中（isWaiting = running && !isStreaming && (chatMode=true \|\| result=undefined) 为 true）。但若严格按行 2 `(resumable \|\| result) + chatMode=true`，resumable 为 false 且 result 为 undefined 时不命中——行 2 的条件组合对 chat 首轮正在进行态（无 resumable、无 result）开窗。实际此态进程正在跑、应显示 streaming，行 1（无 result + 无 resumable）正确覆盖。但行 2 条件写法暗示"waiting 必须 resumable 或 result 有值"，与 chat 首轮正在进行（应 streaming）的语义产生微妙重叠。此问题的实质是行 2 的 `(resumable \|\| result)` 前缀与行 1 的 `无 result + 无 resumable` 存在边界歧义——当两者都为 false 时行 1 行 2 都不命中。 | 行 2 条件改为 `running + chatMode=true + (resumable \|\| result)`（chatMode 前置，resumable/result 作后置细化），或在行间加注"行 1 优先（无 result + 无 resumable = streaming）"消除歧义。实质是行 1 行 2 的优先级需显式声明 |
| SUGGESTION | §6.4 + renderer store | P1-12 遗漏 | **`isStreamingSubagent`（renderer store subagent.ts:158-161）不检查 `resumable`**。当前判据 `running && result === undefined`——孤儿兜底（resumable=true, result=undefined）会被判为"真在流活动中"。设计引入 resumable 进 shared SubagentRecord 但未更新该函数。与 SubagentList.vue 的 isStreaming（检查 resumable）不一致：同一个 record 在 SubagentList.vue 显示 waiting、在虚拟 session forceWorking 显示 streaming。 | §6.3 或 §6.4 补一句：renderer store 的 `isStreamingSubagent` 同步补 `resumable !== true` 条件（与 SubagentList.vue isStreaming 对齐）。或登记为已知边界（两函数服务不同目的，可接受分叉） |
| SUGGESTION | §6.1 recordToSubagent | P1-8 事实 | **`RecordStore.recordToSubagent`（record-store.ts:902-930）未投影 `chatMode`**。`toSubagentRecordEntry`（record-entry.ts:80-108）同样未投影 chatMode。设计 §6.2 声明两处加字段但只列了 schema/shared 类型变更，未列出 `toSubagentRecordEntry` 和 `recordToSubagent` 这两个投影函数的改动。toSubagentRecordEntry 是 entry 写入的唯一出口（register/archive/reportRecordTransition 都经此），不补 chatMode 则 entry 层永远无 chatMode——§6.4 extractor 透传行读到的 chatMode 恒 undefined。recordToSubagent 是内存源投影（collectRecords 内存覆盖），不补则内存源 SubagentRecord 无 chatMode。 | §6.2 或 §6.1 补明确：`toSubagentRecordEntry` 加 `chatMode: record.chatMode`；`recordToSubagent` 加 `chatMode: r.chatMode`。两处是字段链路闭环的必要环节（entry 写入 + 内存投影） |

---

## 各维度结论

### R2 修复验证

**R2-MF1（mode 字段不能区分 chatMode vs one-shot）**：v3 修复正确。§6.2 改用 `chatMode?: boolean`（ExecutionRecord:373 已有）替代 `mode?: ExecutionMode`（恒 "background" 无区分度）。§5.4 判据表改用 chatMode。§6.2 声明 chatMode 从 extension record 投影进 entry（toSubagentRecordEntry 补一行）。§6.4 extractor 透传行补 `chatMode: typeof d.chatMode === 'boolean' ? d.chatMode : undefined`。§5.4 legacy 缺省按非 chat 处理（one-shot 是历史主流，误判方向安全）。链路三步闭环（entry schema + shared + extractor + renderer）已声明。**但发现 SUGGESTION 级遗漏**：`toSubagentRecordEntry` 和 `recordToSubagent` 两个投影函数未列改动（见 Findings SUGGESTION 2），不补则 entry 层和内存源均无 chatMode。修复方向明确。

**R2-MF2（ExecutionMode 未在 shared 定义）**：v3 随字段替换自然消解——chatMode 是 boolean，不依赖 ExecutionMode 类型。shared SubagentRecord 不加 mode 字段（已被有意移除，subagent.ts:14）。**已闭环**。

**R2-MF3（接线点未定位 + 触发时机 + 防重）**：v3 修复正确。
- 接线点：§6.1 明确为 `RecordStore.collectRecords`（:342-398）内 `reconstructAll` 返回后、merge 内存源之前。核实：collectRecords 是公开方法，reconstructAll 是 private 方法，buildRecord 是 private static 方法——分支 4 判定收集在 buildRecord 内、落盘动作在 collectRecords 收尾集中执行，分层合理。
- 触发时机：§6.1 新增 index.ts session_start 恢复段主动调用 `store.collectRecords()`。核实：当前 index.ts session_start 不调 collectRecords（grep 确认），是新增行为。`setPi` 在 `initSession`（subagent-service.ts:320）中调用，早于 session_start 恢复段——pi 必已注入。
- 防重设计：终态形态（completeRecord + writeFinalized sidecar + archive）——sidecar 使下次重建走分支 2（.finalized → closed gc），不再进分支 4。核实：writeFinalized（finalized-marker.ts:27-37）写空文件 `${sessionFile}.finalized`；buildRecord 分支 2（record-store.ts:825）检查 `m.finalized` → closed(gc)。防重成立。
- "与 doFinalizeRecord 完全同构"声明：核实 doFinalizeRecord（finalize-record.ts:56-164）步骤 = collectPatch + completeRecord + archive + writeFinalized + cleanup(worktree/aliveMarker/pending) + manifest。孤儿路径省略 collectPatch（无 worktree）、cleanup（进程已死）、manifest（诊断辅助）。省略合理，核心三步（completeRecord + writeFinalized + archive）一致。声明基本准确（附"孤儿省略"注释更严谨）。
- completeRecord 可行性：签名 `completeRecord(record, result: AgentResult, status, closedReason?)`——需合成 AgentResult。disposeAllRecords（subagent-service.ts:411-420）有合成先例（空 text + error + sessionId = record.id）。孤儿路径可同款合成（成功 → success=true + text=末行文本；截断 → success=false + error 说明）。

**R2-SG（冷路径续轮清 resumable 标注为新增行为）**：v3 §6.1 第 3 条已明确"新增 `record.resumable = undefined`（或 delete）"。**已闭环**。

### 事实核查

| 文档声明 | 核实结果 |
|---------|---------|
| §3.1 恢复循环 index.ts:467-475 无 store.save | **真**：:467 `transition("done","failed")`，:475 `runs.set` 无 save |
| §3.2 buildRecord 四分支 = record-store.ts:816-846 | **真**：:818 cancelled / :825 finalized / :834 alive+pid / :844 兜底 running |
| §3.2 entry 写入口 5 处 | **真**：register :245 / archive :259 / reportRecordTransition :272 / subagent-service :813 / finalize-record :244 |
| §3.3 ExecutionMode = "background" 唯一字面量 | **真**：types.ts:80 `type ExecutionMode = "background"` |
| §3.3 chatMode 在 ExecutionRecord:373 存在 | **真**：`readonly chatMode?: boolean` |
| §3.3 chatMode 不在 entry schema / shared / extractor | **真**：record-entry.ts SubagentRecordEntryData 无 chatMode；shared subagent.ts SubagentRecord 无 chatMode；extractor collectSelfDescribedSubagentRecords 不读 chatMode |
| §6.1 collectRecords 当前不在 session_start 调用 | **真**：grep index.ts 无 collectRecords 调用 |
| §6.1 setPi 在 initSession 中注入（subagent-service.ts:315-320） | **真**：:320 `this.store.setPi(this.pi)` |
| §6.1 IdentityHeaderRecon 有 sessionFile（session-reconstructor.ts:514） | **真**：`sessionFile: string` |
| §6.1 writeFinalized 写空 sidecar（finalized-marker.ts:27-37） | **真**：`fs.writeFileSync(\`\${sessionFile}.finalized\`, "", "utf-8")` |
| §6.1 completeRecord 签名需 AgentResult（execution-record.ts:695-707） | **真**：`completeRecord(record, result: AgentResult, status, closedReason?)` |
| §6.1 disposeAllRecords 有合成 AgentResult 先例（subagent-service.ts:411-420） | **真**：`{ text: "", turns, durationMs, success: false, error, sessionId: record.id, toolCalls: [] }` |
| §5.4 SubagentList.vue:43/57 用 status === 'running' 判 spinner/cancel | **真**：:43 `v-if="record.status === 'running'"`，:57 同款 |
| §5.4 hasRunning 判据 running && result === undefined（subagent store :120） | **真** |
| §5.4 isStreamingSubagent 判据 running && result === undefined（subagent store :158-161） | **真**：不检查 resumable |
| recordToSubagent（record-store.ts:902-930）不投影 chatMode | **真**：无 chatMode 字段 |
| toSubagentRecordEntry（record-entry.ts:80-108）不投影 chatMode | **真**：无 chatMode 字段 |

### 方案对抗

**决策 1（恢复循环补 save）**：R1/R2 已通过。v3 未变。**通过**。

**决策 2（子 JSONL 末行三条机械判据）**：R1/R2 已通过。v3 判据措辞不变。**通过**。

**决策 3（resumable 字段）**：可选字段 + 防御式消费模式正确。写点覆盖完整（重建分支 4 + 轮终 doFinalizeRoundToIdle + 新生/续轮清除）。**通过**。

**决策 4（UI 细分三形态判据）**：R2 MUST_FIX 1（mode 恒 "background"）已修复为 chatMode。**但发现新问题**：§5.4 表三行遗漏孤儿兜底第四形态（MUST_FIX 1）+ 行 2 边界歧义（MUST_FIX 2）。修复后通过。

**防重设计（v3 新增，重点攻击）**：
- 攻击 1：sidecar 写失败 → 分支 4 每次重开重复判定、重复 append entry。退路：writeFinalized 是 best-effort（finalized-marker.ts:34 静默），但 sidecar 写失败后 entry 已 append（同 id 覆盖无害）且 record 已 archive（内存已移除）——下次 collectRecords 从磁盘重建时无 sidecar → 分支 4 → 再次读子 JSONL → 再次 completeRecord + writeFinalized + archive。幂等收敛（每次重开多一条同 id entry，无功能损害）。**可接受**。
- 攻击 2：archive 后 record 移出内存，但 entry 已落盘——下次 collectRecords 磁盘重建读到终态 entry + sidecar → 分支 2 closed(gc)。防重成立。
- 攻击 3：resumable 形态（文件不存在）每次重开重落 entry——设计明确说"同 id 覆盖无害"。核实：reportRecordTransition 同 id 多条 entry，消费方取最后一条。**可接受**。
- 攻击 4：closedReason 映射 gc 语义损失——extension 内存 list（collectRecords 返回的 SubagentRecord）分支 2 重建 closedReason=gc，丢失 done/error 细分。设计说"entry 内 result/error 保留细分，renderer 读 entry 不受影响"。核实：renderer 从 runtime extractor 读 shared SubagentRecord（从 entry 投影），有 result/error。extension 工具 list 读 collectRecords（extension 内存源），分支 2 的 closedReason=gc。两边独立。**可接受（设计已记录权衡）**。

### 验收

**§7 验收章节存在且质量高**：5 个真实场景全部 E2E real 形态，通过标准具体可判定，每个场景回溯 §2 目标。**P0-13/P0-14/P0-15 通过**。

**验收风险**：场景 3（孤儿不可判形态）要求"显示 waiting"——依赖 MUST_FIX 1 修复（§5.4 表补第四行 + §6.3 isWaiting 条件扩展）。场景 4 的 one-shot 区分依赖 chatMode 到位（R2-MF1 已修复，但 SUGGESTION 2 的 toSubagentRecordEntry 投影必须同步补）。场景 1/2/5 不受影响。

### 一致性

- **目标↔场景↔决策↔回溯**：三个目标映射三个缺口，五个验收场景全覆盖。**通过**。
- **§4.1 场景 B ↔ §5.4 表 ↔ §6.3 条件**：场景 B 要求孤儿无文件形态显示 waiting；§5.4 表不覆盖该形态；§6.3 isWaiting 条件不命中该形态。**不一致（MUST_FIX 1）**。
- **§5.2 决策表方案 a ↔ §5.4 细化表**：方案 a 说 `running && (result !== undefined || resumable) → waiting`（无 chatMode 限定）；细化表行 2 加 chatMode=true 限定。**不一致（MUST_FIX 1 的子项）**。
- **§6.2 声明加字段 ↔ 投影函数未列改动**：§6.2 声明 SubagentRecordEntryData + SubagentRecord 加 chatMode，但 toSubagentRecordEntry 和 recordToSubagent 两个投影函数未列出改动。**不一致（SUGGESTION 2）**。
- **附录 A 裁决对照**：与正文一致。**通过**。
- **out-of-scope 声明与正文不冲突**：不改枚举、不补恢复通知、不对账点补建。**通过**。

---

## 已核实为真的关键引用

以下引用经 read 源码核实（含 R1/R2 已核实清单 + R3 新增核实项）：

1. **index.ts:467-475**：恢复循环 `transition("done","failed")` 后无 `store.save`（:475 只有 `runs.set`）。
2. **jsonl-run-store.ts:488-505**：`doFlush` 成功后 `this.pi?.appendEntry(WORKFLOW_RECORD_CUSTOM_TYPE, ...)`；失败时 settlers reject。
3. **record-store.ts:816-846**：`buildRecord` 四分支实现——:818 cancelled→closed / :825 finalized→closed / :834 alive+pid→running / :844 兜底→running。buildRecord 是 private static 方法。
4. **subagent-service.ts:952/963**：注释说"标记为 idle"，与 :845 `markReconstructedStatus(rec, "running")` 矛盾。以代码为准。
5. **subagent.ts:14**（shared）："移除 mode 字段（新版只有 background，无 sync 模式）"——mode 被有意从 SubagentRecord 移除。
6. **record-entry.ts:50**：`mode: ExecutionMode` 在 entry schema v1 中——entry 层有 mode。
7. **subagent-extractor.ts:136-185**：`collectSelfDescribedSubagentRecords` 逐字段守卫，不读取 mode/resumable/chatMode。
8. **finalize-record.ts:237**：`record.status = "running"`（doFinalizeRoundToIdle 回 running-resumable）。
9. **subagent-service.ts:811-813**：冷路径续轮 `record.status = "running"` + `reportRecordTransition(record)`。无 resumable 清除（字段尚不存在）。
10. **types.ts:80**：`type ExecutionMode = "background"`——唯一字面量。
11. **types.ts:373**：`readonly chatMode?: boolean`——chatMode 是 ExecutionRecord 独立字段。
12. **record-entry.ts:76**：`round?: number`——entry schema 有 round 字段。
13. **session-reconstructor.ts:498-514**：`IdentityHeaderRecon` 有 `sessionFile: string`（:514）、`chatMode?: boolean`（:509）、`mode: ExecutionMode`（:501）。
14. **record-store.ts:342-398**：`collectRecords` 调 `reconstructAll`（:350）→ merge 内存源 → sort/slice，当前不调 reportRecordTransition。
15. **subagent-service.ts:315-320**：`initSession` 设 `this.store.setPi(this.pi)`（:320），后续 collectRecords 时 pi 已注入。
16. **finalize-record.ts:56-164**（R3 新增）：`doFinalizeRecord` 步骤 = collectPatch(S0) + completeRecord(S1) + archive(S2) + writeFinalized/cleanup(S3) + manifest(S4)。writeFinalized（:111）在 record.sessionFile 存在时写 `.finalized` sidecar。
17. **finalized-marker.ts:27-37**（R3 新增）：`writeFinalized(sessionFile)` 写 `${sessionFile}.finalized` 空文件，best-effort 静默。
18. **execution-record.ts:695-707**（R3 新增）：`completeRecord(record, result: AgentResult, "closed", closedReason?)` 设 status/closedReason/endedAt/agentResult/result/error。
19. **subagent-service.ts:402-434**（R3 新增）：`disposeAllRecords` 合成 AgentResult（{ text:"", success:false, error, sessionId:record.id }）+ completeRecord + archive。合成先例成立。
20. **SubagentList.vue:43/57**（R3 核实）：spinner 和 cancel 按钮均以 `record.status === 'running'` 为判据。无 isStreaming/isWaiting 区分。
21. **subagent store:158-161**（R3 新增）：`isStreamingSubagent` 判据 `running && result === undefined`，不检查 resumable。
22. **recordToSubagent（record-store.ts:902-930）**（R3 新增）：不投影 chatMode。
23. **toSubagentRecordEntry（record-entry.ts:80-108）**（R3 新增）：不投影 chatMode。
