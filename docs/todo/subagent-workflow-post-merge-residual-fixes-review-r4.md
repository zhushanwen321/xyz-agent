# subagent-workflow-post-merge-residual-fixes-review (R4)

> **审查对象**：`docs/todo/subagent-workflow-post-merge-residual-fixes.md` v4
> **基线**：`fix-chat-flow-order` 分支 HEAD（commit 3af2baa71），代码核实于 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/`
> **审查身份**：对抗式审查（adversarial reviewer），默认假设方案有问题，逐项找证据反驳
> **审查依据**：`rubric-design-doc.md` P0/P1 清单
> **前序报告**：R1（2 must-fix / 2 suggestion / 2 info）、R2（3 must-fix / 1 suggestion）、R3（2 must-fix / 2 suggestion）
> **R3 已核实清单**：R3 报告末尾 23 条引用，本轮直接引用不重复 read
> **日期**：2026-08-20

---

## Summary

2 must-fix, 3 suggestions.

**总体判断**：R3 的两个 must-fix 修复方向正确落地——四形态判据表补第四行 + 公式化（R3-MF1/MF2）、isStreamingSubagent 补 resumable 对齐（R3-SG1）、投影函数闭环（R3-SG2）。v4 的四形态等价公式（isStreaming/isDone/isWaiting）经穷举验证覆盖全部 8 种 (result x resumable x chatMode) 组合，无重叠、无遗漏（在 running 前提下）。**但发现两个新的阻塞级问题**：① 场景 3 的验证前提不成立——删除子 JSONL 后 record 不会进入分支 4，而是从列表消失（reconstructAll 扫描 .jsonl 文件集合，文件不存在则不被发现）；② chatMode 缺省策略对过渡期遗留 chat 记录的误判风险未被设计识别。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| **MUST_FIX** | §4.1 场景 B "文件不存在"分支 + §7 场景 3 | P0-10 对抗 + P0-11 事实 | **场景 3 验证前提不成立：删除子 JSONL 后 record 从列表消失，不会显示 "waiting"。** record-store 的 `reconstructAll`（record-store.ts:455-527）通过 `readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'))` 发现文件集合。子 JSONL 被删除 → 不在目录列表中 → `scanFile` 永不被调用 → `buildRecord` 分支 4 永不进入 → record 不在 `collectRecords` 输出中 → 侧栏不显示该 record。设计 §5.2 声称"文件不存在 → 不判终态，落 running + resumable=true（侧栏投影「等续聊」）"描述的是一条**不可达路径**——要进分支 4，文件必须先被 `readdirSync` 发现。唯一可能的触发是 readdir 与 scanFile 之间的竞态窗口（文件在两者之间被删），但这不是设计描述的确定性行为。§7 场景 3 要求"删除子 session JSONL 后重开 → 显示 waiting"无法验证。 | 二选一：(a) 场景 3 改为可执行的等价场景——例如「子 JSONL 存在但 identity 不可解析（头部损坏/截断）→ scanFile 返回负缓存 → record 同样消失」，调整场景描述或验证预期；(b) 在 collectRecords 中增加一条额外发现机制——例如维护一个 record-id 索引（idToFile 已存在），对索引中存在但磁盘文件消失的 record 做孤儿兜底（读不到子文件末行，落 resumable=true）。方案 (b) 改动面更大但能覆盖"文件被删"场景。无论选哪个，§5.2 "文件不存在"分支的可达性必须明确 |
| **MUST_FIX** | §5.4 公式 + §4.1 场景 C | P0-10 对抗 | **chatMode 缺省 undefined 按非 chat 处理，过渡期遗留 chat 记录会误显示为 "done"。** 公式 `isDone = running && result !== undefined && chatMode !== true`——chatMode 缺省（undefined，未被本设计补入链路前的遗留 entry）时 `chatMode !== true` 为 true → isDone = true。遗留 chat 记录（已有一轮 result、chatMode 未被写入）的预期显示应是 waiting（等续聊），但公式给 done。设计 §5.4 说"legacy 缺省按非 chat 处理（one-shot 是历史主流形态，误判方向安全——chat 会话显示 done 后用户续聊会恢复 streaming）"——但这忽略了过渡期窗口：本设计的 entry schema 变更 + 投影函数变更完成后，旧 session 的遗留 entry 不会被重写（entry 是 append-only），chatMode 恒 undefined 直到下一次轮终迁移。在过渡期内（设计实施后、用户首次续聊前），已有 chat 记录显示 done 而非 waiting。"续聊后恢复 streaming"是正确的终态，但中间态的误判对用户可见。 | 在 isDone 条件中增加对 chatMode 证据的鲁棒处理：例如 `(result !== undefined && chatMode === true)` 判 waiting（chat 明确）、`(result !== undefined && chatMode === false)` 判 done（one-shot 明确）、`(result !== undefined && chatMode === undefined)` 按遗留策略（可维持现有"按非 chat"但需在文档中显式声明这是有意的过渡期行为，并在验收场景 4 中增加"遗留 chat 记录"子场景验证预期）；或改用 `round` 字段辅助判据（round > 0 暗示 chat，round 缺省/0 暗示 one-shot） |
| SUGGESTION | §5.4 表 vs 公式 | P1-8 事实 | **表与公式表述不完全等价——表行 2 的条件写法与公式 isWaiting 的兜底逻辑有微妙差异。** 表行 2 "running + chatMode = true + (resumable 或 result 有) → waiting" 限定了 chatMode=true 前提，暗示 chatMode 非 true 时此行不命中。但公式 isWaiting = `running && !isStreaming && !isDone` 是兜底——chatMode 非 true + resumable=true + result=undefined（孤儿兜底行 4）同样被 isWaiting 捕获。表的"先命中先停"注释弥补了这一差异，但实现者如果只看表不看公式会漏掉行 4 的兜底语义。§4.1 场景 C 的条件 `running && result !== undefined` 同样省略了 resumable 检查（公式有 `resumable !== true`）。 | 表的行 2 改为"兜底行"描述（"running + 其余未被行 1/3 命中的组合"），或在表后加注"表是简化展示，权威判据见下方等价公式"。§4.1 场景 C 条件补全为 `running && result !== undefined && resumable !== true` |
| SUGGESTION | §5.4 公式 | P1-8 事实 | **公式对 closed/终态 record 的行为未显式声明。** 公式 `isStreaming = status === 'running' && ...` 限定了 running 前提，closed record 的三个函数均返回 false——语义正确（closed 不是 streaming/waiting/done 中的任何一种，现有 closed 映射不变）。但文档未显式声明这一边界行为，实现者可能不确定 closed record 走什么视觉。 | 在公式下方加一句注释："closed/终态 record 不满足 `status === 'running'` 前提，三函数均返回 false，维持现有 closed 映射不变" |
| SUGGESTION | §6.3 | P1-8 事实 | **§6.3 isStreamingSubagent 对齐描述位置略偏。** R3-SG1 要求 renderer store 的 `isStreamingSubagent`（stores/subagent.ts:158-161）补 `resumable !== true`。v4 §6.3 确实新增了此描述，但放在 §6.3 末尾的"连带改动"段——§6.3 标题是"Renderer（SubagentList.vue + stores/subagent.ts）"，改动描述分散在两处（SubagentList.vue 四形态判据 + isStreamingSubagent 连带），实现者可能遗漏后者。 | isStreamingSubagent 的改动与 SubagentList.vue 判据放在同一层级描述，或在 §6.3 开头列改动清单时显式包含两处 |

---

## 各维度结论

### R3 修复验证

**R3-MF1（四形态判据表遗漏孤儿兜底第四形态）**：v4 修复正确。§5.4 表扩为四行，等价公式化（isStreaming/isDone 显式定义 + isWaiting 兜底）。穷举验证 8 种组合均被正确覆盖（见下方详表）。**已闭环**。

**R3-MF2（行 2 边界歧义）**：v4 通过公式化消解——isStreaming 的 `resumable !== true` 条件显式排除了行 1 与行 2 的边界歧义（resumable 为 false 且 result 为 undefined 时 isStreaming=true，不再需要行 2 的 `(resumable || result)` 前缀来消歧）。表行 2 的条件措辞仍有 SUGGESTION 级简化（见上），但公式是权威判据，不阻塞。**已闭环**。

**R3-SG1（isStreamingSubagent 不检查 resumable）**：v4 §6.3 新增连带改动段，明确 `isStreamingSubagent` 同步补 `resumable !== true`。isRunning 宽松口径不动（注释论证充分）。**已闭环**。

**R3-SG2（投影函数未列 chatMode 改动）**：v4 §6.2 新增两个投影函数的改动声明（toSubagentRecordEntry + recordToSubagent 各补 resumable + chatMode）。**已闭环**。

### 四形态公式穷举验证（重点攻击方向 1）

对 (result, resumable, chatMode) 全 8 种组合，在 `status === 'running'` 前提下逐一核对：

| # | result | resumable | chatMode | isStreaming? | isDone? | isWaiting? | 语义 | 公式是否正确 |
|---|--------|-----------|----------|-------------|---------|------------|------|-------------|
| 1 | undefined | false/undef | false/undef/true | T | F | F | 首轮进行中 | 正确（行 1） |
| 2 | undefined | true | true | F | F | T | chat 轮终等续聊（无 result 极端窗口） | 正确（行 2/4） |
| 3 | undefined | true | false/undef | F | F | T | 孤儿兜底（无文件/不可判终态） | 正确（行 4） |
| 4 | defined | false/undef | true | F | F | T | chat 轮终有 result | 正确（行 2） |
| 5 | defined | true | true | F | F | T | chat 轮终有 result + resumable | 正确（行 2） |
| 6 | defined | false/undef | false/undef | F | T | F | one-shot 完成 | 正确（行 3） |
| 7 | defined | true | false/undef | F | T | F | one-shot 完成 + resumable | 正确（行 3，isDone 优先） |
| 8 | defined | true | undefined(legacy) | F | T | F | 遗留 one-shot 完成 | 正确（行 3） |

组合 6/7 的 isDone=true 验证：`result !== undefined` (T) && `chatMode !== true` (T, chatMode=false/undef) → isDone=T → isWaiting=F。one-shot 轮终显示 done 视觉——符合设计意图。

**结论：公式在 running 前提下完备，8 组合无遗漏无重叠。** closed/终态 record 不满足 running 前提，三函数均返回 false，维持现有映射（SUGGESTION 级，建议显式声明）。

### isStreamingSubagent 消费链验证（重点攻击方向 2）

基线 `isStreamingSubagent`（subagent store:158-161）判据 `running && result === undefined`。v4 §6.3 补 `resumable !== true`。

消费链追踪：`isStreamingSubagent` → `MessageStream` 虚拟 session `forceWorking` → 决定虚拟 session 末位 turn 是否显示 streaming。

- 孤儿兜底（resumable=true, result=undefined）：补后 isStreamingSubagent=false → 虚拟 session 不 forceWorking → 末位 turn 不卡 streaming。与 SubagentList.vue isWaiting=true 对齐。正确。
- chat 轮终（resumable=true, result=defined）：补后 isStreamingSubagent=false（result 已有值，原始条件已排除）。正确。
- 首轮进行中（resumable=undefined, result=undefined）：isStreamingSubagent=true。正确。
- isRunning（宽松口径）不动：resumable 续轮仍有流活动（SubagentTab 订阅流），isRunning=true 保持数据通路。注释论证（:110-117）充分。

**结论：isStreamingSubagent 对齐后，SubagentList.vue 与虚拟 session 两处口径统一。isRunning 宽松口径的保留理由充分（订阅流依赖）。**

### 孤儿判定子文件定位攻击（重点攻击方向 3）

**sessionFile 来源**：`buildRecord` 的 `base.sessionFile` 来自 `IdentityHeaderRecon.sessionFile`（session-reconstructor.ts:514）——该字段是 `parseIdentityFromText(text, sessionFile)` 的 `sessionFile` 参数透传（session-reconstructor.ts:552），值 = `scanFile` 的 `file` 参数 = readdirSync 发现的 `.jsonl` 文件路径。不是从文件内容解析出来的。

**推论**：只要 `readIdentityHeader` 成功解析出 identity，`sessionFile` 必有值（= 文件自身路径）。identity 解析失败 → `scanFile` 返回 null → record 不被发现。不存在"record 被发现但 sessionFile 为空"的第五形态。

**但有一个攻击面被设计忽略**：`readIdentityHeader` 只读头部 64KB（IDENTITY_HEAD_BYTES）。续聊场景 identity 可能在文件尾部（session-reconstructor.ts:493-494 注释："实测真实目录 1186/1744 文件的 identity 不在头 64KB"）。`scanFile` 的 fallback 链是头部 → 尾部 → 全文（record-store.ts:597-604）。如果三级都 miss → 负缓存 → record 消失。这不是本设计引入的新风险（既有行为），但设计的"分支 4 兜底"依赖于 record 被发现——identity 不可解析的文件不会进入任何分支。

### 场景 2/3 E2E 可执行性（重点攻击方向 4）

**场景 2（孤儿终态，已跑完形态）**：可执行。kill -9 父 pi → 子进程自然跑完（子 JSONL 正常收尾）→ 重开 → collectRecords 发现子 JSONL（文件存在）→ readIdentityHeader 成功 → buildRecord 进分支 4（.alive 已删/ pid 死/ 超时）→ 读子 JSONL 末行 → 判终态。链条自洽。**通过**。

**场景 3（孤儿不可判形态）**：**不可执行（MUST_FIX 1）**。删除子 JSONL → 文件不在目录列表中 → record 不被发现 → 侧栏不显示。设计预期"显示 waiting"无法验证。

**子文件末行稳定性**：子进程正常退出时 appendFileSync 写完整行（设计 §5.2 判据依据）。SIGTERM 死法的末行形态——设计标记 V1 探针实测，合理。唯一截断窗口是子进程写入中途被 kill——此时父已死、子也死，判 error 方向正确。

### 一致性审查

- **§4.1 场景 B "文件不存在"分支 ↔ §5.2 判据第三条 ↔ §7 场景 3**：三处口径一致（均声称文件不存在 → waiting），但都基于同一个错误前提（文件不存在时 record 仍可被发现）。**不一致的根因是 record 发现机制依赖文件存在**。
- **§5.4 表 ↔ 公式 ↔ §4.1 场景 C**：表行 2 的简化措辞（chatMode=true 前缀）与公式 isWaiting 兜底逻辑有 SUGGESTION 级差异；场景 C 的条件省略了 resumable 检查。不阻塞但建议对齐。
- **§5.4 公式 ↔ §6.3 实现描述**：公式三函数定义完整，§6.3 的实现描述（isStreaming/isDone/isWaiting 具名函数 + 模板 43/57 行 + statusDotClass）与公式对齐。**通过**。
- **§5.4 chatMode 缺省策略 ↔ 遗留数据**：设计声称"legacy 缺省按非 chat 处理，误判方向安全"——对 one-shot（历史主流）正确，对遗留 chat 记录误判为 done（MUST_FIX 2）。**不一致**。
- **附录 A 裁决对照**：与正文一致。**通过**。
- **out-of-scope 声明与正文不冲突**：不改枚举、不补恢复通知、不对账点补建。**通过**。

### 方案对抗

**决策 1（恢复循环补 save）**：R1/R2/R3 已通过。v4 未变。**通过**。

**决策 2（子 JSONL 末行三条机械判据）**：R1/R2/R3 已通过。v4 判据措辞不变。三条判据在"文件存在 + identity 可解析"前提下逻辑自洽。**但"文件不存在"分支的可达性存疑（MUST_FIX 1）**——该分支在正常扫描流程中不可达。修复后通过。

**决策 3（resumable 字段）**：可选字段 + 防御式消费模式正确。写点覆盖完整（重建分支 4 + 轮终 doFinalizeRoundToIdle + 新生/续轮清除）。**通过**。

**决策 4（UI 细分四形态判据）**：R2/R3 的阻塞项已修复。公式经穷举验证完备。**MUST_FIX 2（chatMode 缺省误判遗留 chat 记录）阻塞**。修复后通过。

### 验收

**§7 验收章节存在且质量高**：5 个真实场景全部 E2E real 形态，通过标准具体可判定，每个场景回溯 §2 目标。**P0-13/P0-14/P0-15 通过**。

**验收风险**：
- 场景 3（孤儿不可判形态）**不可执行**（MUST_FIX 1）——删除子 JSONL 后 record 消失，无法验证"显示 waiting"。
- 场景 4 的遗留 chat 记录子场景未覆盖（MUST_FIX 2）——需增加"设计实施后、首次续聊前，已有 chat 记录的显示"子场景。
- 场景 1/2/4（one-shot 部分）/5 不受影响。

---

## 已核实为真的关键引用

以下引用经 read 源码核实（含 R1/R2/R3 已核实清单 + R4 新增核实项）：

1-23：沿用 R3 报告末尾 1-23 条（全部经 R1-R3 多轮核实，本轮未发现推翻）。

**R4 新增核实项**：

24. **record-store.ts:455-527 `reconstructAll`**：通过 `readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'))` 发现文件集合。文件不在目录中 → 不被扫描 → 不进入任何 buildRecord 分支。
25. **record-store.ts:536-541 `scanFile`**：`statStamp(file)` 返回 null（文件不存在）→ `this.fileCache.delete(file); return null`——文件消失时清理缓存并跳过。
26. **session-reconstructor.ts:533-552 `readIdentityHeader`**：`sessionFile` 参数透传为返回值字段（:552 `return parseIdentityFromText(text, sessionFile)`），值 = 文件路径本身。
27. **session-reconstructor.ts:621 `parseIdentityFromText`**：签名 `(text: string, sessionFile: string)`——sessionFile 是调用方传入的文件路径，非从文件内容解析。
28. **record-store.ts:897 `manifestToSubagent`**：`sessionFile: m.sessionFile`——manifest 源的 sessionFile 来自 ManifestRecord，可为 undefined。但 manifest 记录仅补充 session.jsonl 重建失败的记录（:354-358 优先级低于磁盘源），且 manifest 的 sessionFile 来源需另行核实（不在本设计 scope 内）。
29. **subagent store:158-161 `isStreamingSubagent`**（v4 §6.3 对齐后预期）：`running && result === undefined && resumable !== true`——与 SubagentList.vue isStreaming 口径统一。
30. **record-store.ts:902-930 `recordToSubagent`**：当前不投影 resumable/chatMode。v4 §6.2 声明需补，符合 R3-SG2 修复方向。
