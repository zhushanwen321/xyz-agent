# subagent-workflow-post-merge-residual-fixes-review (R6)

> **审查对象**：`docs/todo/subagent-workflow-post-merge-residual-fixes.md` v6
> **基线**：`fix-chat-flow-order` 分支 HEAD（commit 3af2baa71），代码核实于 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/`
> **审查身份**：对抗式审查（adversarial reviewer），默认假设方案有问题，逐项找证据反驳
> **审查依据**：`rubric-design-doc.md` P0/P1 清单
> **前序报告**：R1（2 must-fix / 2 suggestion / 2 info）、R2（3 must-fix / 1 suggestion）、R3（2 must-fix / 2 suggestion）、R4（2 must-fix / 3 suggestion）、R5（1 must-fix / 2 suggestion）
> **R5 已核实清单**：R5 报告末尾 35 条引用 + R4 报告 30 条，本轮直接引用不重复 read
> **日期**：2026-08-20

---

## Summary

2 must-fix, 1 suggestion.

**总体判断**：v6 正确修复了 R5 的三个问题——chmod 000 分支删除 + IO 判据可达性注（R5-MF）、reportRecordTransition 签名适配描述（R5-SG1）、防重 fast-path 限频说明（R5-SG2）。四形态公式经 R5 穷举仍完备，全文口径统一到四形态。**但发现一个阻塞级问题在六轮审查中均未被攻击到**：设计的字段链路（§6.2 → §6.4 → §6.3）要求对四个类型定义新增字段，§6.2 标题声称"SubagentRecord 与 SubagentRecordEntryData 各加两个字段"——但实际上有四个独立类型需要修改（extension `ExecutionRecord`、shared `SubagentRecord`、extension `SubagentRecord`、`SubagentRecordEntryData`），设计只明确覆盖了其中两个，遗漏的两个会导致 TypeScript 编译失败，实施无法推进。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| **MUST_FIX** | §6.2 | P0-11 事实 + P0-12 遗漏 | **类型定义改动不完整——四个类型需要新增字段，设计只明确覆盖两个，遗漏的两个导致编译失败。** 完整推演：(1) `doFinalizeRoundToIdle`（finalize-record.ts:237）设 `record.status = "running"` 后，§6.1 第 3 点要求补 `record.resumable = true`——record 类型是 `ExecutionRecord`（types.ts:345-474），该接口**无 `resumable` 字段**（只有 `chatMode?: boolean` 在 :373），TypeScript 编译报错；(2) `recordToSubagent`（record-store.ts:902-930）§6.2 要求补 `chatMode: r.chatMode`——返回类型是 extension 的 `SubagentRecord`（types.ts:590-607），该接口有 `resumable?: boolean`（:602）但**无 `chatMode` 字段**，对象字面量多余属性 TypeScript 报错；(3) shared `SubagentRecord`（packages/shared/src/subagent.ts:38-93）**无 `resumable` 也无 `chatMode`**——§6.4 extractor 逐字段守卫 `typeof d.resumable === 'boolean'` 赋值给 `SubagentRecord` 属性，属性不存在则编译报错。设计 §6.2 标题"SubagentRecord 与 SubagentRecordEntryData 各加两个字段"覆盖了 shared `SubagentRecord` 和 `SubagentRecordEntryData`，但遗漏了 extension `ExecutionRecord`（需加 `resumable`）和 extension `SubagentRecord`（需加 `chatMode`）。四个类型改动是字段链路闭环的必要前提——缺任一个，§6.1-§6.4 的代码改动无法编译。 | §6.2 明确列出四个类型各需新增的字段：(a) `ExecutionRecord` 加 `resumable?: boolean`（doFinalizeRoundToIdle 写点 + 冷路径续轮清除）；(b) shared `SubagentRecord` 加 `resumable?: boolean` + `chatMode?: boolean`（extractor 透传）；(c) extension `SubagentRecord` 加 `chatMode?: boolean`（recordToSubagent 投影）；(d) `SubagentRecordEntryData` 加 `resumable?: boolean` + `chatMode?: boolean`（toSubagentRecordEntry 投影）。§6.2 标题修正为覆盖全部四个类型。 |
| **MUST_FIX** | §8 U2 | P0-12 遗漏 | **U2 描述遗漏 shared 类型改动与 runtime 改动——实现者按 U2 描述只改 extension 目录会遗漏 shared/runtime 两处必做改动。** U2 写"重建矩阵分支 4 终态判定 + entry 落盘 + resumable 字段（决策 2/3，extension 侧）"——但字段链路闭环需要：(1) shared `SubagentRecord` 加字段（`packages/shared/src/subagent.ts`，不在 extension 目录）；(2) shared `SubagentRecordEntryData`（即 extension `record-entry.ts`）加字段；(3) runtime extractor 透传（`packages/runtime/src/services/session/subagent-extractor.ts`，§6.4 两行）。U2 的"extension 侧"限定会让实现者跳过这三处。U3 同理——§6.1 第 3 点（冷路径续轮清 resumable）和 §6.4（extractor 透传）在 U2/U3 之间无归属。§8 表下方文字"U2/U3 共享 resumable 字段定义，先 shared 后两侧"部分弥补，但 U2 行内描述仍会误导。 | U2 描述改为"重建矩阵分支 4 终态判定 + entry 落盘 + **shared 类型加字段 + 投影函数 + extract or 透传**"；或在 U2 行内注明依赖项（shared 类型 + runtime 透传）。U3 补充冷路径续轮清 resumable（§6.1 第 3 点后半）。确保 §6 每条改动都有明确 wave 归属。 |
| SUGGESTION | §8 U3 | P1-8 事实 | **U3"两点小改"措辞与实际改动数不符。** U3 写"跨 extension/renderer 两点小改"——实际：(1) extension `finalize-record.ts` doFinalizeRoundToIdle 加 `resumable: true`（1 行）；(2) extension `subagent-service.ts` 冷路径续轮清 `resumable = undefined`（1 行）；(3) renderer `SubagentList.vue` 四形态判据 + 模板改动；(4) renderer `stores/subagent.ts` isStreamingSubagent 补 resumable 检查。共 4 处改动跨 4 文件，非"两点"。不阻塞（改动量仍小），但描述不准确可能让实现者低估 scope。 | "两点小改"改为"四处小改（2 extension + 2 renderer）"或列文件清单。 |

---

## v6 修复闭环验证

### R5-MF（chmod 000 分支不可执行）

v6 修复：删除场景 3 的 chmod 分支，只保留截断分支；IO 错误判据（§5.2 第三条）保留为防御性路径并加可达性注（"常规操作中难有可行触发手段，验收以单测注入覆盖，不设 E2E 场景"）。

验证：§5.2 判据三条（完整 JSON → done / 截断 → error / IO 错误 → resumable）与 §7 场景 3（只留截断分支）一致。§4.1 场景 B 三条分支对齐。**已闭环**。

### R5-SG1（reportRecordTransition 签名适配）

v6 修复：§6.1 第 2 点明确"需在 RecordStore 新增接受 SubagentRecord 的入口方法（内部直接 `pi.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, toSubagentRecordEntry(record))`，绕过 recordToSubagent）"。

验证：方案方向正确，描述足够定位接线点。具体方法名未指定（如 `reportSubagentRecordTransition`），属实现细节，SUGGESTION 级。**已闭环**。

### R5-SG2（防重 fast-path 限频说明）

v6 修复：§6.1 第 2 点补"fast-path 缓存（dir mtime 未变不重入分支 4）结构性限频；appendEntry 写主 JSONL 不改子目录 mtime，实际频率 ≈ 重开次数 + dir mtime 变化触发的全量重扫（同 id 覆盖无害）"。

验证：与 R5 核实的 `record-store.ts:482-493` dir mtime 快路径一致。**已闭环**。

---

## 全文一致性审查

### 目标 ↔ 场景 ↔ 决策 ↔ 机制 ↔ 验收 ↔ V 检查点 ↔ 附录 A

- **§2 目标 1 ↔ §5.1 决策 1 ↔ §6.1 第 1 点 ↔ §7 场景 1 ↔ V4**：workflow kill-9 恢复补 save，场景 1 验收敛 + 无 LLM turn，V4 验 entry_appended 时机。**一致**。
- **§2 目标 2 ↔ §5.2 决策 2 ↔ §6.1 第 2 点 ↔ §7 场景 2/3 ↔ V1/V2**：孤儿终态三条判据 + 主动触发 collectRecords，场景 2（已跑完→done）/场景 3（截断→error），V1 验末行完整 JSON / V2 验 setPi 注入时序。**一致**。
- **§2 目标 3 ↔ §5.3/§5.4 决策 3/4 ↔ §6.2-§6.4 ↔ §7 场景 4**：resumable + chatMode 字段链路 + 四形态公式，场景 4 验 waiting/done/legacy 存量。**一致**（但类型定义遗漏导致实施受阻，见 MUST_FIX 1）。
- **§3.3 第三形态（one-shot 完成）↔ §5.4 isDone 判据 ↔ §7 场景 4**：isDone = `chatMode === false`，one-shot register 时 `chatMode: opts.conversation === true` → `false`（subagent-service.ts:1352），toSubagentRecordEntry 投影后 entry 携带显式 false，isDone 对新 entry 有效。**一致**（前提是 MUST_FIX 1 修复后类型链路通）。
- **§5.4 chatMode 过渡期语义 ↔ §7 场景 4 legacy 存量断言**：存量 entry 无 chatMode → undefined → isDone false → isWaiting 兜底。场景 4 明确断言"legacy 存量完成 record 显示 waiting"。**一致**。
- **§8 wave 拆分 ↔ §6 改动清单**：U1（恢复循环 save）↔ §6.1 第 1 点；U2（分支 4 + resumable + shared）↔ §6.1 第 2 点 + §6.2；U3（轮终 resumable + renderer）↔ §6.1 第 3 点 + §6.3；U4（注释 + 回归）↔ §6.1 第 4 点。**基本一致**，但 U2/U3 归属有模糊（MUST_FIX 2）。
- **§9 V1-V4 ↔ 时序断言**：V1（末行完整 JSON，实测）；V2（setPi 时序，实测）；V3（perf，基线对照）；V4（entry_appended 订阅时机，实测）。场景 1 的 save→entry_appended→缓存失效链已有 V4 覆盖。**无遗漏时序断言**。
- **附录 A 裁决表 ↔ 正文**：决策 3"大部分被替代，一项待验证"（场景 8 信号丢失收敛）→ V4 同族。决策 6.2"被结构性消解"↔ §3.1"save 内部 appendEntry 终态，不带 triggerTurn"。**一致**。
- **全文 grep 旧口径残留**：主正文无"三形态""文件不存在→resumable""chatMode !== true"残留。版本历史（附录 B）中的旧术语是正确的变更记录。**通过**。
- **out-of-scope 声明 ↔ 正文**：不改枚举、不补恢复通知、不对账点补建（仅验证）。**一致**。

### 变更历史 v1-v6 与正文现状矛盾检查

- v2 修复 mode 字段链路 → v3 反转为 chatMode（R2-MF1 ExecutionMode 恒 "background" 无区分度）→ 正文 §6.2 用 chatMode。**无矛盾**（mode 仍存在于 entry schema 和投影函数，是既有字段，chatMode 是新增字段）。
- v4 修复四形态 → v5 isDone 改显式 `chatMode === false` → v6 删除 chmod 分支。正文四形态公式与 v5 最终版一致。**无矛盾**。
- v5-R4 场景 3"删除子 JSONL"→ v5-R5 改 chmod 000 → v6 删 chmod 分支只留截断。§7 场景 3 只有截断分支。**无矛盾**。

---

## 对抗式审查（逐决策）

### 决策 1（恢复循环补 save）

R1-R5 已通过。v6 未变。逐 run try/catch + 不阻断循环的设计合理（store.save reject 沿 settlers 链上抛，catch 记日志）。**通过**。

### 决策 2（孤儿终态兜底）

三条机械判据在"文件存在 + identity 可解析 + 进分支 4"前提下逻辑自洽。终态路径复用 doFinalizeRecord 同构收尾（completeRecord + writeFinalized sidecar + archive）——sidecar 防重正确。IO 错误路径（第三条）加可达性注后可接受（单测注入覆盖）。**通过**。

攻击面：分支 4 读子 JSONL 末行时，子进程可能正在写（并发窗口）。但设计已声明"分支 4 的 record 由 readdirSync 发现——若子进程活着，分支 3 先命中（.alive + pid 活），进不了分支 4"——并发窗口内 pid 可能已退出但子进程还在写最后一行（SIGTERM 回收窗口极短），判 error 方向安全。**通过**。

### 决策 3（resumable 字段）

可选字段 + 防御式消费模式正确。写点覆盖完整（重建分支 4 + 轮终 doFinalizeRoundToIdle + 新生/续轮清除）。向后兼容（runtime 逐字段守卫）。**通过**。

### 决策 4（UI 细分四形态判据）

公式经 R4/R5 穷举验证完备（8 组合无遗漏无重叠）。chatMode 链路经 R5 源码核实自洽（one-shot → false / chat → true / 跨重启恢复 → true）。isStreamingSubagent 口径对齐正确。isRunning 宽松口径保留理由充分。**通过**。

### 决策 2 补充攻击：重开 N 次的 entry 膨胀

每次重开 session，分支 4 的 resumable 形态会 append 一条 entry（无 sidecar 锚，不走终态路径）。N 次重开 = N 条 entry。设计声明"同 id 后到覆盖，消费方取最后一条"——正确。但 JSONL 文件体积随重开次数线性增长。实际影响：每条 entry 约 200-500 bytes，即使每天重开一次，一年 ~180KB，可忽略。**不阻塞，但登记为已知边界**。

---

## 验收审查（P0-13/P0-14/P0-15）

**§7 验收章节存在且质量高**：5 个真实场景全部 E2E real 形态（Playwright 连 dev app 或 pi CLI 直连），通过标准具体可判定，每个场景回溯 §2 目标。

- **P0-13（验收存在且 testable）**：通过。5 个场景均有明确通过标准（"Flows tab 秒级显示 failed""Agents tab 显示 done""静态圆点不转圈"等）。
- **P0-14（非单测非 mock）**：通过。全部 E2E real 形态；IO 错误路径以单测注入覆盖是合理降级（可达性注已声明）。
- **P0-15（投入匹配）**：通过。改动面小（extension 为主），5 个场景 + 1 项回归覆盖三个缺口 + 既有链路。

**验收细节攻击**：
- 场景 1"重开后无自发 LLM turn（日志无未经输入的 agent_start）"——观测手段是日志检查，appendEntry 不带 triggerTurn 是结构性保证（§5.1），日志检查是防御性验证。合理。
- 场景 2"等子进程自然结束（轮询 pid 消失，60s 超时兜底）"——可操作（`kill -0 <pid>` 循环检查）。
- 场景 4"legacy 存量完成 record 显示 waiting（§5.4 过渡期语义，显式断言防误判为 bug）"——设计主动声明预期行为 + 验收显式断言，防止实施者误判。好实践。

---

## 已核实为真的关键引用

以下引用经 read 源码核实（含 R1-R5 已核实清单 + R6 新增核实项）：

1-35：沿用 R5 报告末尾 1-35 条（全部经 R1-R5 多轮核实，本轮未发现推翻）。

**R6 新增核实项**：

36. **ExecutionRecord（types.ts:345-474）无 `resumable` 字段**：接口有 `chatMode?: boolean`（:373）但无 `resumable`。§6.1 第 3 点要求 `record.resumable = true` 在 doFinalizeRoundToIdle 中执行——record 类型是 ExecutionRecord，该赋值编译失败。
37. **extension SubagentRecord（types.ts:590-607）无 `chatMode` 字段**：有 `resumable?: boolean`（:602）但无 `chatMode`。§6.2 要求 `recordToSubagent` 补 `chatMode: r.chatMode`——返回类型是该接口，多余属性 TypeScript 报错。
38. **shared SubagentRecord（packages/shared/src/subagent.ts:38-93）无 `resumable` 也无 `chatMode`**：§6.4 extractor 逐字段守卫赋值给 `SubagentRecord` 属性——属性不存在则编译失败。
39. **toSubagentRecordEntry（record-entry.ts:80-108）当前无 `resumable`/`chatMode` 投影**：设计要求补（§6.2），与 SubagentRecordEntryData 加字段配套。当前代码不含这两个字段——需同步修改。
40. **recordToSubagent（record-store.ts:902-930）当前无 `resumable`/`chatMode` 投影**：设计要求补（§6.2），与 extension SubagentRecord 加 chatMode 字段配套。
41. **collectRecords 不在 session_start 中调用**：index.ts session_start 段（:308-504）无 `collectRecords` 调用。设计 §6.1 第 2 点要求新增调用——正确识别了现状缺口。
