# subagent-workflow-post-merge-residual-fixes-review (R5)

> **审查对象**：`docs/todo/subagent-workflow-post-merge-residual-fixes.md` v5
> **基线**：`fix-chat-flow-order` 分支 HEAD（commit 3af2baa71 后多提交，代码核实于 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/`）
> **审查身份**：对抗式审查（adversarial reviewer），默认假设方案有问题，逐项找证据反驳
> **审查依据**：`rubric-design-doc.md` P0/P1 清单
> **前序报告**：R1（2 must-fix / 2 suggestion / 2 info）、R2（3 must-fix / 1 suggestion）、R3（2 must-fix / 2 suggestion）、R4（2 must-fix / 3 suggestion）
> **R4 已核实清单**：R4 报告末尾 30 条引用，本轮直接引用不重复 read
> **日期**：2026-08-20

---

## Summary

1 must-fix, 2 suggestions.

**总体判断**：R4 两个 must-fix 的修复方向正确——三条判据替代「文件不存在」（R4-MF1）、isDone 需显式 `chatMode === false` + 过渡期语义声明（R4-MF2）。全文口径已统一到四形态公式，旧术语（三形态 / `chatMode !== true`）在主正文中清零，版本历史中的旧术语是正确的变更记录。chatMode 在 record 创建时的实际取值链经核实：`subagent-service.ts:1352` 赋值 `opts.conversation === true`，one-shot（conversation=undefined）→ `false`（显式布尔，非 undefined），chat → `true`——新 entry 的 chatMode 均为显式值，isDone 判据对新 entry 有效。**但发现一个阻塞级问题**：场景 3 的 chmod 000 分支验证前提不成立——chmod 000 阻断的是 identity header 发现（上游），不是 branch 4 的末行读取（下游），IO 错误路径在正常操作中不可达。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| **MUST_FIX** | §5.2 判据第三条 + §7 场景 3 chmod 分支 | P0-10 对抗 + P0-13 验收 | **chmod 000 阻断的是 identity header 发现，不是 branch 4 末行读取——IO 错误路径在正常操作中不可达，场景 3 的 chmod 分支不可执行。** 完整推演：(1) `readdirSync` 发现子 JSONL 文件存在；(2) `scanFile` 调 `readIdentityHeader`（session-reconstructor.ts:536 `fs.openSync(file, "r")`）；(3) chmod 000 的文件，同用户 openSync("r") 抛 EACCES（POSIX：owner 权限位 = 000 → 拒绝，不穿透到 other 位）；(4) catch 返回 undefined → 负缓存 → record 不被发现 → 不进入任何 buildRecord 分支 → 侧栏不显示该 record。设计 §5.2 声称"被扫描的文件必然存在，文件不存在不可达"——正确，但 chmod 000 的问题是**文件存在但不可读**，readIdentityHeader 失败发生在 branch 4 上游（identity 发现阶段），record 根本到不了 branch 4 的末行读取。§7 场景 3 要求"chmod 000 → 重开 → 显示 waiting"无法验证——实际结果是 record 从列表消失。附带核实：`readIdentityHeader`（session-reconstructor.ts:533-553）用 `openSync` + `readSync` 读文件，chmod 000 在 openSync 阶段即抛错（:549 catch 返回 undefined），不到 readSync。 | 二选一：(a) 场景 3 的 chmod 分支改为可执行等价场景——例如在 identity header 成功读取后、末行读取前制造 IO 错误（如 truncate 文件到只剩 identity header 行，使末行读取为空或失败——但需确认 openSync 对已打开 fd 的后续 readSync 是否受 chmod 影响：不受，fd 已打开后权限不重检，所以需要在 open 之后、read 之前 chmod，这在单进程内不现实）。最务实的修法：**删除场景 3 的 chmod 分支**，只保留截断分支（截断末行 → error 判定，该路径经 §5.2 第二条判据覆盖且可执行），将 IO 错误路径（§5.2 第三条）登记为"理论可达但无可行触发手段"的已知边界——与 §5.2 已登记的"子文件被外部删除"同级处理。(b) 若需保留 IO 错误路径的验收覆盖，在 collectRecords 的分支 4 增强中注入可测试 hook（如模拟 fs.readFileSync 抛错），但这属于实现层测试辅助，非 E2E 验收场景。 |
| SUGGESTION | §6.1 第 2 点 | P1-8 事实 | **reportRecordTransition 的签名不接受 SubagentRecord——分支 4 落盘需额外适配。** `reportRecordTransition`（record-store.ts:271）签名为 `(record: ExecutionRecord): void`，内部调 `RecordStore.recordToSubagent(record)`（private 方法）。分支 4 的数据源是 `reconstructAll` 返回的 `SubagentRecord`（非 `ExecutionRecord`），不能直接传入 `reportRecordTransition`。设计 §6.1 说"分支 4 命中集 → collectRecords 收尾集中执行 reportRecordTransition"——需要明确适配方式：要么在 RecordStore 上新增 `reportSubagentRecordTransition(record: SubagentRecord)` 方法（直接调 `pi.appendEntry`，不经 `recordToSubagent`），要么构造一个最小 `ExecutionRecord` 桥接。这是实现细节但影响方案可行性——当前描述会让实现者卡在类型不匹配上。 | 在 §6.1 第 2 点补充一句：reportRecordTransition 签名需适配（新增接受 SubagentRecord 的入口方法，或直接调 `pi.appendEntry("subagent-record", toSubagentRecordEntry(record))` 绕过 recordToSubagent）。 |
| SUGGESTION | §5.2 防重声明 | P1-8 事实 | **resumable 形态的"频率 = 重开次数"声明在 fast-path 缓存下大致成立，但存在边界条件。** 推演：`reconstructAll` 有 dir mtime 快路径（record-store.ts:482-493）——dir mtime 未变 → 直接返回 fileCache → 不重入 branch 4 → 不重落 entry。`reportRecordTransition` 调 `pi.appendEntry` 写主 JSONL（非子 JSONL），不改子 sessions 目录 mtime → 快路径持续命中。因此 resumable entry 不会被高频重复 append。但边界条件：(1) 其他文件的 sidecar 创建/删除改 dir mtime → 快路径失效 → 全量重扫 → branch 4 重入 → 重复 append；(2) dir mtime 粒度粗的文件系统（NFS/2s FAT）可能误判。实际频率仍远低于"每次 list 请求都 append"，设计的"频率 = 重开次数"是合理的近似。 | 可选：在 §5.2 防重声明处加一句"fast-path 缓存（dir mtime 未变时不重入 branch 4）结构性限频；边界条件下（dir mtime 变化触发全量重扫）可能多 append 一条，同 id 覆盖无害"。 |

---

## 各维度结论

### R4 修复验证

**R4-MF1（文件不存在不可达 + 场景 3 不可执行）**：v5 修复方向正确——三条判据替代「文件不存在」，子文件被外部删除登记为已知边界。但场景 3 的 chmod 000 分支仍有问题（MUST_FIX 1——chmod 阻断上游发现，不是下游读取）。截断分支可执行。**部分闭环，chmod 分支未闭环**。

**R4-MF2（chatMode 缺省误判遗留 chat 记录）**：v5 修复正确——isDone 改需显式 `chatMode === false`（原 `!== true` 会让存量 chat 轮终误 done）；缺省落 isWaiting 兜底；过渡期语义显式声明（"无法确认不是 chat → 不宣告完成"，保守方向）；场景 4 补 legacy 存量断言。**已闭环**。

**R4-SG1（表 vs 公式措辞差异）**：v5 表后加注"公式为权威判据"。**已闭环**。

**R4-SG2（closed 边界未声明）**：v5 公式下加"closed/终态 record 不满足 `status === 'running'` 前提，三函数均返回 false"。**已闭环**。

**R4-SG3（§6.3 isStreamingSubagent 位置）**：v5 §6.3 改为两文件并列清单（SubagentList.vue + stores/subagent.ts），isStreamingSubagent 与四形态判据同级描述。**已闭环**。

### chatMode 实际取值链验证（重点攻击方向）

task prompt 指定的 #1 攻击点：核实 chatMode 在 record 创建时的实际取值。

**创建路径（register 时）**：`subagent-service.ts:1352` `chatMode: opts.conversation === true`。
- one-shot（conversation=undefined）：`undefined === true` → `false`（显式布尔）。
- chat（conversation=true）：`true === true` → `true`。
- 结论：**新 entry 的 chatMode 均为显式布尔值**，isDone 判据 `chatMode === false` 对 one-shot 新 entry 有效。

**跨重启恢复路径**：`subagent-service.ts:990` `chatMode: true`（getRecordForAction 无条件置 true）。恢复后的 record 若经轮终迁移写 entry，chatMode = true → isDone = false → waiting。语义正确：已恢复续聊的 one-shot 等同 chat session。

**Identity header 路径**：`index.ts:350` `chatMode: process.env.PI_SUBAGENT_CHAT_MODE === "true"`。env 由 `session-runner.ts:906` 注入。子进程的 identity header chatMode 与父的 `createRecordForMode` 赋值同源。一致。

**结论：chatMode 链路自洽。新 entry 的 chatMode 均有显式值（true/false），isDone 判据对新 entry 有效。存量 entry 无 chatMode → undefined → isWaiting 兜底，过渡期语义正确。**

### 四形态公式穷举验证

沿用 R4 穷举表（8 组合），公式未变（仅 isDone 从 `chatMode !== true` 改为 `chatMode === false`）。重新验证关键组合：

| # | result | resumable | chatMode | isStreaming | isDone | isWaiting | 语义 |
|---|--------|-----------|----------|-------------|--------|-----------|------|
| 6 | defined | false/undef | false | F | **T** | F | one-shot 新完成（chatMode 显式 false）→ done |
| 8 | defined | true | undefined(legacy) | F | **F** | T | 遗留 one-shot 完成（chatMode 缺省）→ waiting |

组合 6：`chatMode === false` (T) → isDone = T。正确（新 entry 显式 false）。
组合 8：`chatMode === false` 中 chatMode=undefined → F → isDone = F → isWaiting = T。正确（遗留保守兜底）。

**公式在 R4-MF2 修复后仍完备，无重叠无遗漏。**

### 场景 3 chmod 分支推演（重点攻击方向）

完整推演链：
1. kill -9 父 pi → 子进程跑完 → 子 JSONL 正常收尾
2. `chmod 000` 子 JSONL（重开前手动操作）
3. 重开 session → RecordStore 新建（无缓存）→ `reconstructAll`（dirStamp=null → 全量扫描）
4. `readdirSync` 发现子 JSONL → `scanFile` → `statStamp(file)` 返回 stat（lstatSync 不需读权限）
5. 无缓存（全新 RecordStore）→ 走重建路径 → `readIdentityHeader`（session-reconstructor.ts:536 `fs.openSync(file, "r")`）
6. **chmod 000 + 同用户 → EACCES**（POSIX：owner 权限位 000 = 无读，openSync 失败）
7. catch 返回 undefined → 负缓存 → scanFile 返回 null → record 不被发现
8. collectRecords 输出不含该 record → 侧栏不显示

**设计预期**：显示 waiting + entry 含 resumable:true
**实际结果**：record 从列表消失（与子 JSONL 被外部删除同效果）

**根因**：chmod 000 阻断的是 identity header 发现阶段（openSync），不是 branch 4 的末行读取阶段。设计的「文件存在但不可读」路径在 identity header 三级探测中已被拦截——readIdentityHeader/readIdentityTail/readIdentityAnywhere 三个函数都用 openSync/readSync，全会在 chmod 000 下失败。

### 一致性审查

- **§2 目标 2 ↔ §5.2 判据 ↔ §7 场景 2/3**：目标 2 说"无法判定终态时显示等续聊"——§5.2 第三条判据（IO 错误 → resumable）定义了"无法判定"的触发条件；§7 场景 2（已跑完形态→done）和场景 3（截断→error）覆盖了可判定分支。但场景 3 的 chmod 分支（IO 错误→waiting）不成立（MUST_FIX 1）。**不一致**。
- **§4.1 场景 B ↔ §5.2 判据**：场景 B 的三条分支（完整→done / 截断→error / IO 不可读→resumable）与 §5.2 三条判据完全对齐。**一致**。
- **§4.2 失败路径表 ↔ §5.2**：四条失败路径的恢复指引与判据一致。"resumable 字段被旧 runtime 消费"的向后兼容论证正确（防御式逐字段读取）。**一致**。
- **§5.4 公式 ↔ §6.3 实现描述 ↔ §6.4 extractor 透传**：公式三函数定义完整；§6.3 两文件改动清单与公式对齐；§6.4 extractor 两行透传与 shared 字段对齐。**一致**。
- **§5.4 chatMode 过渡期语义 ↔ 场景 4**：场景 4 的 legacy 存量断言（"改造前的存量 session → 已完成 record 显示 waiting"）与 §5.4 过渡期语义声明一致。**一致**。
- **§8 wave 拆分 ↔ 新字段**：U2 包含 resumable 字段 + 分支 4 增强；U3 包含轮终 resumable + renderer 四形态。chatMode 字段跨 U2（shared 定义）和 U3（renderer 消费），依赖关系正确。**一致**。
- **全文 grep 旧口径残留**：主正文无「三形态」「文件不存在→resumable」「chatMode !== true」残留。版本历史（附录 B）中的旧术语是正确的变更记录。**通过**。

### 方案对抗

**决策 1（恢复循环补 save）**：R1-R4 已通过。v5 未变。**通过**。

**决策 2（孤儿终态兜底）**：三条机械判据逻辑自洽（在 record 被发现的前提下）。终态路径复用 doFinalizeRecord 同构收尾（completeRecord + writeFinalized + archive）——sidecar 防重机制正确。**但 IO 错误路径（第三条判据）在正常操作中不可达**（MUST_FIX 1——identity header 发现阶段先于 branch 4 拦截了不可读文件）。reportRecordTransition 类型适配需补充（SUGGESTION 1）。修复后通过。

**决策 3（resumable 字段）**：可选字段 + 防御式消费模式正确。写点覆盖完整（重建分支 4 + 轮终 doFinalizeRoundToIdle + 新生/续轮清除）。**通过**。

**决策 4（UI 细分四形态判据）**：公式经穷举验证完备（8 组合无遗漏无重叠）。chatMode 链路经源码核实自洽（one-shot → false / chat → true / 跨重启恢复 → true）。isStreamingSubagent 口径对齐正确。isRunning 宽松口径保留理由充分。**通过**。

### 验收

**§7 验收章节存在且质量高**：5 个真实场景全部 E2E real 形态，通过标准具体可判定，每个场景回溯 §2 目标。**P0-13/P0-14/P0-15 通过**（除场景 3 的 chmod 分支外）。

**验收风险**：
- 场景 3 的 chmod 分支**不可执行**（MUST_FIX 1）——chmod 000 阻断 identity header 发现，record 从列表消失而非显示 waiting。截断分支可执行。
- 场景 1/2/4/5 不受影响。

---

## 已核实为真的关键引用

以下引用经 read 源码核实（含 R1-R4 已核实清单 + R5 新增核实项）：

1-30：沿用 R4 报告末尾 1-30 条（全部经 R1-R4 多轮核实，本轮未发现推翻）。

**R5 新增核实项**：

31. **subagent-service.ts:1352 `chatMode: opts.conversation === true`**：one-shot（conversation=undefined）→ `undefined === true` → `false`（显式布尔）；chat（conversation=true）→ `true`。新 entry 的 chatMode 均为显式值，isDone 判据有效。
32. **subagent-service.ts:990 `chatMode: true`（getRecordForAction 跨重启恢复）**：恢复后 record 的 chatMode 恒为 true，即使原 record 是 one-shot。后续轮终迁移写 entry 时 chatMode=true → isDone=false → waiting。语义正确（已续聊的 one-shot 等同 chat）。
33. **session-reconstructor.ts:533-553 `readIdentityHeader`**：用 `fs.openSync(file, "r")` 打开文件。chmod 000 + 同用户 → EACCES → catch 返回 undefined。阻断点在 identity header 发现阶段，不在 branch 4 末行读取阶段。
34. **index.ts:350 `chatMode: process.env.PI_SUBAGENT_CHAT_MODE === "true"`**：identity header 的 chatMode 来源。env 由 session-runner.ts:906 注入，与 createRecordForMode 的 opts.conversation 赋值同源。一致。
35. **record-store.ts:271 `reportRecordTransition(record: ExecutionRecord)`**：签名接受 `ExecutionRecord`，不接受 `SubagentRecord`。branch 4 的数据源是 `reconstructAll` 返回的 `SubagentRecord`，需额外适配。
36. **record-store.ts:482-493 dir mtime 快路径**：`dirStamp.mtimeMs === dirMtimeMs` → 返回 fileCache → 不重入 scanFile/buildRecord。`pi.appendEntry` 写主 JSONL 不改子 sessions 目录 mtime → 快路径持续命中。resumable entry 不会被高频重复 append。
