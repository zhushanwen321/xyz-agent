# subagent-workflow-post-merge-residual-fixes-review (R1)

> **审查对象**：`docs/todo/subagent-workflow-post-merge-residual-fixes.md` v1
> **基线**：`fix-chat-flow-order` 分支 HEAD（commit 3af2baa71），代码核实于 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/`
> **审查身份**：对抗式审查（adversarial reviewer），默认假设方案有问题，逐项找证据反驳
> **审查依据**：`rubric-design-doc.md` P0/P1 清单
> **日期**：2026-08-20

---

## Summary

2 must-fix, 2 suggestion, 2 info.

**总体判断**：方案的三个缺口定位准确，恢复循环补 save（决策 1）和子 JSONL 末行判终态（决策 2）的代码依据充分、逻辑自洽。**核心阻塞项是 §5.4 三形态渲染判据依赖 `mode` 字段区分 chatMode/one-shot，但 `mode` 已从 shared `SubagentRecord` 中被显式移除，且 `subagent-extractor.ts` 不读取 entry 中的 `mode`——设计识别了"需补透传"但未列出 SubagentRecord 类型变更这个前提步骤，导致 §5.4 判据在渲染层无法实现。** 修复方向明确：§6.2 补 `SubagentRecord` 加 `mode?: ExecutionMode` 字段 + §6.4 补 `scanSubagentEntries` 读取 `mode` 的具体行。其余事实核查通过率高，核心架构决策经源码交叉核实成立。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| **MUST_FIX** | §5.4 / §6.2 | P0-12 遗漏 | **§5.4 三形态判据依赖 `mode` 区分 chatMode vs one-shot，但 `mode` 已从 shared `SubagentRecord` 中移除（`subagent.ts:14`："移除 mode 字段（新版只有 background，无 sync 模式）"），`subagent-extractor.ts` 的 `collectSelfDescribedSubagentRecords` 不读取 entry 中的 `mode` 字段。** 设计 §6.3/§6.4 识别了"renderer 消费需 shared SubagentRecord 补透传"和"runtime scanSubagentEntries 补一行透传"，但 §6.2 只声明加 `resumable?: boolean`，未声明加 `mode?: ExecutionMode`——这是前提遗漏。无 `mode` 则 §5.4 表中"running + result + 非 chatMode（one-shot）→ done"行在渲染层不可执行，验收场景 4 的 one-shot 区分必挂。 | §6.2 显式声明 `SubagentRecord` 加 `mode?: ExecutionMode`（与 `resumable` 同级）；§6.4 补 `scanSubagentEntries` 的 `collectSelfDescribedSubagentRecords` 函数增加 `mode: typeof d.mode === 'string' ? d.mode : undefined` 透传行（与 `result` 同款防御式守卫模式）；§6.3 确认 renderer 的 `SubagentList.vue` 消费 `mode` 的具体位置 |
| **MUST_FIX** | §6.4 | P0-12 遗漏 | **§6.4 标题"Runtime 零改动"与正文矛盾**：正文说"补一行 resumable 透传"和"同 §6.4 模式"补 mode 透传——这些是 `subagent-extractor.ts` 的代码改动，不是"零改动"。更重要的是，§6.2 未声明 `SubagentRecord` 加 `mode` 字段，导致 §6.4 的"补一行透传"无落点——`scanSubagentEntries` 构建的 `SubagentRecord` 对象中没有 `mode` 属性位置。两节联动缺失。 | §6.4 标题改为"Runtime（subagent-extractor.ts 一行透传）"或类似；§6.2 和 §6.4 形成闭环——共享类型加字段 → 提取层透字段 → 渲染层消费字段，三步缺一不可 |
| SUGGESTION | §3.2 | P1-8 事实 | **record-store.ts:440-470 引用指向的是 `reconstructAll` 方法的 JSDoc 注释（440-447），不是四分支的实际实现代码。** 实际四分支在 `buildRecord` 静态方法的 816-846 行（`:816` 分支1 cancelled / `:824` 分支2 finalized / `:833` 分支3 alive+pid / `:842` 分支4 兜底 running）。注释内容准确描述了四个分支的优先级和行为，但行号指向注释而非代码可能导致实现者定位偏差。 | 补充实际代码行号引用：`buildRecord` 方法（record-store.ts:816-846）为四分支实现点 |
| SUGGESTION | §3.2 | P1-8 事实 | **"reportRecordTransition 仅 2 处调用：冷路径续轮 subagent-service.ts:813、轮终 finalize-record.ts:244"** 技术上准确（外部调用点确实是 2 处），但 `record-store.ts` 内部的 `register`（:245）和 `archive`（:259）也直接调用 `pi.appendEntry` 写 entry（绕过 `reportRecordTransition`），加上 `reportRecordTransition` 自身（:272），共 5 处 entry 写入口。读"仅 2 处"可能误以为只有 2 个写点。 | 补一句"register/archive 内部直接 appendEntry（不经过 reportRecordTransition）"以完整描述写入口分布 |
| INFO | §3.2 | P0-11 事实 | **subagent-service.ts:952/963 注释矛盾被正确识别。** 核实：:952 注释说"reconstructAll 已将跨重启 record（无 sidecar marker + pid 死）标记为 **idle**"，:963 同款。而 record-store.ts:845 分支 4 代码是 `markReconstructedStatus(rec, "running")`。以代码为准（idle 是 v4 前的历史概念，已折入 running）。设计的修复方向（修正注释）正确。 | 无需修复方向变更——设计已覆盖 |
| INFO | §9 V4 | P0-16 运行时断言 | **V4 检查点（runtime 派生缓存对重开 session 的首次失效时机）正确标记为待实测，退路合理。** 核实：`session-service.ts:1422` 记录条目缓存注册发生在 session 激活时；恢复循环的 `store.save` 在 `session_start` 回调内执行，`appendEntry` 写入触发 `entry_appended` 事件。runtime 是否在 `session_start` 期间已订阅该 session 的 `entry_appended` 取决于事件接线时序，无法从静态代码确证。设计退路（依赖冷启动 RPC 首拉，收敛在"重开后"边界内）合理，不阻塞实施。 | V2/V4 均需 pi CLI 实测验证——设计已正确标记，实施期按设计指定的验证方式执行 |

---

## 各维度结论

### 事实核查

**通过率高。** 以下关键引用已 read 源码核实为真：

| 文档声明 | 核实结果 |
|---------|---------|
| index.ts:467-475 恢复循环 transition 无 save | **真**：:467 `transition("done","failed")`，:475 `runs.set` 无 `store.save` |
| lifecycle.ts:282/329 正常路径有 store.save | **真**：:282 `await deps.store.save(run)`（abortRun），:329 同款（onRunDone 路径） |
| store.save 内部 doFlush 会 pi.appendEntry | **真**：jsonl-run-store.ts:491-494 `this.pi?.appendEntry(WORKFLOW_RECORD_CUSTOM_TYPE, ...)` |
| record-store.ts 分支 4 兜底落 running | **真**：:845 `markReconstructedStatus(rec, "running")` |
| reportRecordTransition 外部调用 2 处 | **真**：subagent-service.ts:813、finalize-record.ts:244 |
| doFinalizeRoundToIdle 不 archive、回 running | **真**：:237 `record.status = "running"`，无 archive 调用 |
| doFinalizeRoundToIdle 删 .alive | **真**：:221 `removeAliveMarker(record.sessionFile)` |
| scanSubagentEntries 只认 subagent-record entry | **真**：collectSelfDescribedSubagentRecords 检查 `customType === SUBAGENT_RECORD_CUSTOM_TYPE` |
| SubagentRecord 有 result、无 resumable/mode | **真**：subagent.ts:83 `result?: string`，无 `resumable`、无 `mode`（:14 明确移除） |
| SubagentList.vue:43/57 用 `status === 'running'` 判 spinner/cancel | **真**：:43 `v-if="record.status === 'running'"`、:57 同款 |
| hasRunning 判据 running && result === undefined | **真**：subagent store :120 `s.status === 'running' && s.result === undefined` |
| appendEntry 不带 triggerTurn | **真**（从代码结构推断 + record-entry.ts 注释"不进 LLM context"；A8 探针将实测确认） |

### 方案对抗

**决策 1（恢复循环补 save）**：无争议。代码先例充分（lifecycle.ts:282/329 同款 save），save 内部 appendEntry 触发 runtime 失效重拉的链路已验证。恢复幂等（每次 session_start 重复 transition + save 无害）。唯一风险是 save 失败（磁盘满），设计已覆盖逐 run try/catch。**通过**。

**决策 2（子 JSONL 末行三条机械判据）**：三条判据（完整 JSON→done、截断→error、文件不存在→resumable）逻辑自洽。攻击面：(a) 子进程正常完成时末行是否一定是 assistant 消息？设计说"末条 entry 为 assistant 消息且非截断"但子进程被 SIGTERM 时末行可能是 tool_result/custom_message——但设计的保守方向（非 assistant 完整行也判 done 而非 error？此处措辞有歧义）需澄清：设计实际意图是"末行可完整 JSON.parse"= 正常收尾，不限于 assistant 类型。(b) 子进程分叉新进程继续写？子进程是独立 CLI 不存在分叉。(c) 并发写截断？子进程 appendFileSync 同步写整行，竞态窗口极窄。**通过（附 SUGGESTION：§5.2 "assistant 消息"措辞可精确化为"可完整 JSON.parse 的末行"，避免实现者误解为需检查 entry type）**。

**决策 3（resumable 字段）**：可选字段 + 防御式消费是 W16 已验证模式。写点覆盖完整（重建分支 4 + 轮终 doFinalizeRoundToIdle + 新生/续轮清除）。**通过**。

**决策 4（渲染层三形态判据）**：判据数据来源（entry 的 result/resumable/mode）理论上充分。**但 mode 字段链路断裂（MUST_FIX 1）导致此决策的实现前提不成立**。修复后通过。

### 验收

**§7 验收章节存在且质量高**：5 个真实场景全部 E2E real 形态（Playwright 连 dev app 或 pi CLI 直连），通过标准具体可判定，每个场景回溯 §2 目标。非 mock、非单测、非抽象断言。验收投入与改动规模（extension 三处 + renderer 一处）匹配。V1-V4 检查点可执行且有退路。**P0-13/P0-14/P0-15 通过**。

**唯一验收风险**：场景 4 的 one-shot 区分依赖 `mode` 字段到位（MUST_FIX 1），修复前该子场景不可执行。

### 一致性

- **目标↔场景↔决策↔回溯**：三个目标映射三个缺口，五个验收场景全覆盖，每个决策标注回溯目标。**通过**。
- **附录 A 裁决对照**：决策 1/2/3/5/6.1/6.2 的裁决与正文一致。**通过**。
- **out-of-scope 声明与正文不冲突**：不改枚举（§5.4 用渲染层判据替代）、不补恢复通知（§3.1 appendEntry 消解）、不对账点补建（先验证）。**通过**。
- **§6.4 "零改动"与实际代码改动矛盾**：标题说零改动，正文描述至少两行透传代码。**SUGGESTION**。

---

## 已核实为真的关键引用

以下引用经 read 源码核实，后续轮次无需重复怀疑：

1. **index.ts:467-475**：恢复循环 `transition("done","failed")` 后无 `store.save`（:475 只有 `runs.set`）。代码在 `extensions/subagent-workflow/src/index.ts`。
2. **jsonl-run-store.ts:488-494**：`doFlush` 成功后 `this.pi?.appendEntry(WORKFLOW_RECORD_CUSTOM_TYPE, toWorkflowRecordEntryData(snapshot))`——save 走冷路径（done 立即 flush）时 appendEntry 写终态 workflow-record entry。
3. **record-store.ts:816-846**：`buildRecord` 四分支实现——:818 cancelled→closed、:825 finalized→closed、:834 alive+pid→running、:844 兜底→running。
4. **subagent-service.ts:952/963**：注释说"标记为 idle"，与 :845 `markReconstructedStatus(rec, "running")` 矛盾。以代码为准。
5. **subagent.ts:14**："移除 mode 字段（新版只有 background，无 sync 模式）"——`mode` 被有意从 `SubagentRecord` 移除。
6. **record-entry.ts:50**：`mode: ExecutionMode` 仍在 entry schema v1 中——entry 层有 mode 但 shared 层无。
7. **subagent-extractor.ts:136-186**：`collectSelfDescribedSubagentRecords` 逐字段守卫，不读取 `mode`。
8. **finalize-record.ts:237**：`record.status = "running"`（doFinalizeRoundToIdle 回 running-resumable，不 archive）。
9. **session-service.ts:635-678**：`refreshRecordEntries` 游标增量逻辑——cursor 非空走增量、Entry-not-found 丢 cursor 全量自愈。
10. **SubagentList.vue:43/57**：spinner 和 cancel 按钮均以 `record.status === 'running'` 为判据。
