# subagent-workflow-post-merge-residual-fixes-review (R2)

> **审查对象**：`docs/todo/subagent-workflow-post-merge-residual-fixes.md` v2
> **基线**：`fix-chat-flow-order` 分支 HEAD（commit 3af2baa71），代码核实于 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/`
> **审查身份**：对抗式审查（adversarial reviewer），默认假设方案有问题，逐项找证据反驳
> **审查依据**：`rubric-design-doc.md` P0/P1 清单
> **前序报告**：同目录 `subagent-workflow-post-merge-residual-fixes-review.md`（R1，2 must-fix / 2 suggestion / 2 info）
> **日期**：2026-08-20

---

## Summary

3 must-fix, 1 suggestion.

**总体判断**：R1 的两个 must-fix（mode 字段链路闭环、§6.4 标题矛盾）已修复——v2 §6.2 正确声明了 `SubagentRecord` 补 `mode?: ExecutionMode`、§6.4 补了 extractor 透传行并修正了标题。R1 修复方向闭环，无新引入矛盾。

**但发现一个新的阻塞级问题**：§5.4 三形态判据用 `mode` 区分 chatMode vs one-shot（"running + result + chatMode → waiting" / "running + result + 非 chatMode → done"），而 `ExecutionMode` 类型在 extension 侧定义为唯一字面量 `"background"`（types.ts:80: `type ExecutionMode = "background"`），所有 subagent 的 mode 恒为 `"background"`。真正区分 chat vs one-shot 的是 `chatMode?: boolean`（ExecutionRecord:373），但该字段既不在 entry schema（record-entry.ts SubagentRecordEntryData 无 chatMode）、也不在 shared SubagentRecord、也不在 extractor 投影链路。renderer 层无从区分 chatMode 与 one-shot——§5.4 表中 "running + result + chatMode → waiting" 行在渲染层不可实现，验收场景 4 的 one-shot 区分必挂。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| **MUST_FIX** | §5.4 / §6.2 / §6.3 | P0-11 事实 + P0-10 对抗 | **`mode` 字段不能区分 chatMode vs one-shot**。`ExecutionMode` 在 extension 侧定义为唯一字面量 `"background"`（types.ts:80），所有 subagent mode 恒为 `"background"`（subagent-service.ts:633："mode 固定 background（sync 已删除）"）。真正区分 chat/one-shot 的是 `chatMode?: boolean`（ExecutionRecord:373），但该字段不在 entry schema（SubagentRecordEntryData 无 chatMode）、不在 shared SubagentRecord（subagent.ts 无此字段）、不在 extractor（collectSelfDescribedSubagentRecords 无此透传）。设计 §5.4 表中"running + (resumable \|\| result) + **chatMode** → waiting"和"running + result + **非 chatMode**（one-shot）→ done"两行在 renderer 层无数据可判——`mode` 恒为 `"background"`，renderer 拿不到 chatMode。验收场景 4 的 one-shot 区分必挂。 | 三选一：(a) `chatMode` 加入 entry schema（SubagentRecordEntryData + toSubagentRecordEntry）、shared SubagentRecord、extractor 透传，§5.4 判据改用 `chatMode`；(b) 扩展 ExecutionMode 增 `"chat"` 字面量 + toSubagentRecordEntry 按 chatMode 选 mode 值，renderer 按 `mode === 'chat'` 判；(c) entry 已有的 `round` 字段（SubagentRecordEntryData:76，chatMode 有意义，one-shot 恒 0/undefined）作为 renderer 侧代理判据（round > 0 → chatMode）。推荐 (a) 最显式。同时修正 §6.2 的"mode 字段在 W16 entry schema v1 已携带，无需新字段"——需新字段 |
| **MUST_FIX** | §6.2 | P0-12 遗漏 | **`ExecutionMode` 类型未在 shared 包定义**。设计说"ExecutionMode 类型从 shared 定义（与 extension 侧字面量对齐）"，但 grep 全量搜索 `packages/shared/src/` 无任何 `ExecutionMode` 定义。shared/subagent.ts 目前无此类型——要加 `mode?: ExecutionMode` 到 SubagentRecord，前提是先在 shared 定义该类型。 | §6.2 补一步：在 `packages/shared/src/subagent.ts` 增 `export type ExecutionMode = "background"`（或按 MUST_FIX 1 的修复方向扩展字面量） |
| **MUST_FIX** | §6.1 第 2 条 | P0-12 遗漏 | **重建矩阵分支 4 调用 reportRecordTransition 的接线点未定位到具体代码位置**。设计说"落 entry 的调用点选在 session_start 重建完成后、且仅对本次重建新判定的 record"。基线代码中：(1) `reconstructAll` 是 `RecordStore` 的 private 方法，返回 `SubagentRecord[]`，不调 reportRecordTransition；(2) `collectRecords` 是公开方法，调 `reconstructAll` 后 merge/sort 返回——它不是 session_start 时序中的显式调用点；(3) `initSession`（subagent-service.ts:315）设 `this.store.setPi(pi)` 但不调 `collectRecords`；(4) `collectRecords` 的首次调用发生在 renderer 请求列表时（非 session_start 期间）。实际可行路径是在 `collectRecords` 中 `reconstructAll` 之后、返回之前，对 branch 4 判定的新 record 调 `reportRecordTransition`——但需确认此时 `this.pi` 已注入（session_start 先于 renderer 请求，是的）。设计应明确接线点为 `collectRecords` 方法内部，而非笼统的"session_start 重建完成后"。 | §6.1 第 2 条明确：接线点 = `RecordStore.collectRecords` 方法内部，`reconstructAll` 返回后、merge 内存源之前，对 branch 4 新判定的 record 调 `this.reportRecordTransition(rec)`。补充前提：`setPi` 在 `initSession` 中已调用（subagent-service.ts:320），`collectRecords` 时 pi 必已注入 |
| SUGGESTION | §6.1 第 3 条 | P1-8 事实 | **"冷路径续轮 reportRecordTransition 前清 resumable"描述精确度不足**。基线代码（subagent-service.ts:815-817）只做 `record.status = "running"` + `reportRecordTransition(record)`，无清 resumable 的代码（因为 resumable 字段尚不存在）。设计应明确：此处是**新增行为**（写 `record.resumable = undefined` 或 delete），非描述既有代码。 | §6.1 第 3 条改为"冷路径续轮（subagent-service.ts:813 附近）新增 `record.resumable = undefined`（或 delete），然后 reportRecordTransition——进程启动 = 有驱动 = 非 resumable" |

---

## 各维度结论

### R1 修复验证

**R1-MF1（mode 字段链路闭环）**：v2 修复方向正确。§6.2 补了 `SubagentRecord` 加 `mode?: ExecutionMode` 声明；§6.4 补了 extractor 透传行（`mode: typeof d.mode === 'string' ? d.mode : undefined`）并修正标题为含两行透传。**链路三步闭环**（shared 加字段 → extractor 透传 → renderer 消费）已声明完整。但发现新问题（MUST_FIX 1）：`mode` 恒为 `"background"` 无法区分 chat/one-shot，三形态判据实际需要 `chatMode` 而非 `mode`。R1 修复本身无引入新矛盾。

**R1-MF2（§6.4 标题矛盾）**：已修复。v2 §6.4 标题改为"Runtime（`subagent-extractor.ts` 仅两行字段透传，无逻辑改动）"，正文列了 resumable 和 mode 两行透传代码，标题与正文一致。

**R1-SUGGESTION 1（行号精确化）**：已修复。v2 §3.2 引用了 `buildRecord :816-846` 四分支实现，与源码一致（核实：:818 cancelled / :825 finalized / :834 alive+pid / :844 兜底 running）。

**R1-SUGGESTION 2（entry 写入口完整描述）**：已修复。v2 §3.2 列出 5 处写入口：register（:245）/ archive（:259）内部 appendEntry + reportRecordTransition 自身（:272）+ 2 处外部调用点（subagent-service.ts:813 / finalize-record.ts:244）。核实：全部准确。

### 事实核查

**v2 新增声明核实**：

| 文档声明 | 核实结果 |
|---------|---------|
| §6.2 `ExecutionMode` 类型从 shared 定义 | **假**：grep `packages/shared/src/` 无 `ExecutionMode` 定义。该类型仅存于 extension types.ts:80 |
| §6.4 extractor 透传行 `resumable` / `mode` | **计划中**：基线 `collectSelfDescribedSubagentRecords`（:157-183）当前不读这两个字段。设计描述的是新增行为，非既有代码，描述准确 |
| §3.2 四分支实现 = buildRecord :816-846 | **真**：:818 cancelled / :825 finalized / :834 alive+pid / :844 兜底 running |
| §3.2 entry 写入口 5 处 | **真**：register :245 / archive :259 / reportRecordTransition :272 / subagent-service :813 / finalize-record :244 |
| §5.4 mode 字段区分 chatMode vs one-shot | **假**：`ExecutionMode = "background"` 唯一字面量（types.ts:80），所有 subagent mode 恒 "background"。chatMode 是独立 boolean（ExecutionRecord:373），不在 entry/shared/extractor |
| 决策 1 store.save 失败不阻断循环 | **真**：index.ts:493 catch 块记 err 后继续循环 |

### 方案对抗

**决策 1（恢复循环补 save）**：R1 已通过。v2 未变。save 失败处理确认：jsonl-run-store.ts:505 `for (const s of settlers) s.reject(err)` 传回调用方，index.ts:493 catch 记日志不阻断。**通过**。

**决策 2（子 JSONL 末行三条机械判据）**：R1 已通过。v2 判据措辞精确化（"末行可完整 JSON.parse"不限 assistant 类型），与 R1 建议一致。**通过**。

**决策 3（resumable 字段）**：可选字段 + 防御式消费模式正确。写点覆盖完整。**通过**。

**决策 4（UI 细分三形态判据）**：**MUST_FIX 1 阻塞**。`mode` 恒为 `"background"` 无法区分 chat/one-shot，三形态判据的第二、三行（waiting vs done）在 renderer 层不可实现。修复后通过。

### 验收

**§7 验收章节存在且质量高**：5 个真实场景全部 E2E real 形态，通过标准具体可判定，每个场景回溯 §2 目标。**P0-13/P0-14/P0-15 通过**。

**验收风险**：场景 4 的 one-shot 区分依赖 chatMode 数据到位（MUST_FIX 1），修复前该子场景不可执行。场景 1/2/3/5 不受 MUST_FIX 1 影响。

### 一致性

- **目标↔场景↔决策↔回溯**：三个目标映射三个缺口，五个验收场景全覆盖。**通过**。
- **附录 A 裁决对照**：与正文一致。**通过**。
- **out-of-scope 声明与正文不冲突**：不改枚举、不补恢复通知、不对账点补建。**通过**。
- **§3.3 与 §5.4 一致性**：§3.3 说"区分判据 entry 已携带：mode 字段（chat 与否——chatMode 轮终 = 等续聊，one-shot 轮终 = 已完成）"——mode 与 chatMode 混用，且 mode 不能做此区分。**不一致**（归入 MUST_FIX 1）。

---

## 已核实为真的关键引用

以下引用经 read 源码核实，后续轮次无需重复怀疑（含 R1 已核实清单，加 v2 新增核实项）：

1. **index.ts:467-475**：恢复循环 `transition("done","failed")` 后无 `store.save`（:475 只有 `runs.set`）。
2. **jsonl-run-store.ts:488-505**：`doFlush` 成功后 `this.pi?.appendEntry(WORKFLOW_RECORD_CUSTOM_TYPE, ...)`；失败时 `for (const s of settlers) s.reject(err)` 传回调用方。
3. **record-store.ts:816-846**：`buildRecord` 四分支实现——:818 cancelled→closed、:825 finalized→closed、:834 alive+pid→running、:844 兜底→running。
4. **subagent-service.ts:952/963**：注释说"标记为 idle"，与 :845 `markReconstructedStatus(rec, "running")` 矛盾。以代码为准。
5. **subagent.ts:14**："移除 mode 字段（新版只有 background，无 sync 模式）"——mode 被有意从 SubagentRecord 移除。
6. **record-entry.ts:50**：`mode: ExecutionMode` 在 entry schema v1 中——entry 层有 mode。
7. **subagent-extractor.ts:136-185**：`collectSelfDescribedSubagentRecords` 逐字段守卫，不读取 mode/resumable。
8. **finalize-record.ts:237**：`record.status = "running"`（doFinalizeRoundToIdle 回 running-resumable）。
9. **subagent-service.ts:815-817**：冷路径续轮 `record.status = "running"` + `reportRecordTransition(record)`。
10. **types.ts:80**：`type ExecutionMode = "background"`——唯一字面量，所有 subagent mode 恒 "background"。
11. **types.ts:373**：`readonly chatMode?: boolean`——chatMode 是 ExecutionRecord 独立字段，不在 SubagentRecordEntryData。
12. **record-entry.ts:76**：`round?: number`——entry schema 有 round 字段（chatMode 有意义，one-shot 恒 0/undefined）。
13. **session-reconstructor.ts:498-514**：`IdentityHeaderRecon` 有 `sessionFile: string`（:514）和 `mode: ExecutionMode`（:501），重建路径可定位子文件。
14. **record-store.ts:342-398**：`collectRecords` 调 `reconstructAll`（:350）→ merge 内存源 → sort/slice，当前不调 reportRecordTransition。
15. **subagent-service.ts:315-320**：`initSession` 设 `this.store.setPi(this.pi)`，后续 collectRecords 时 pi 已注入。
