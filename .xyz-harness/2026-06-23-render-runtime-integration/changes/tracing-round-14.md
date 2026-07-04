# Code Architecture 追踪报告 — Round 14（收敛复核）

> 独立 subagent 隔离追踪产出
> 追踪输入：code-architecture.md、tracing-round-13.md、issues.md
> 追踪视角：Round 13 的 2 阻塞项（N-02 / N-03）是否解决、2 minor（M-01 / M-02）是否清理、是否引入新 gap

## 结论：CONVERGED

Round 13 的 **2 个阻塞项均已在可执行层（验收/优先级）解决**，**2 个 minor 全部清理**。本轮追踪**未发现会卡死执行的新阻塞项**。

唯一新发现的是 **1 个非阻塞 minor（M-03）**：issues.md 内有 3 处 body 文本仍把 `ToolCallStatus.pending` 当作待补契约，与同文件新增的 `[STALE]` 覆盖注释自相矛盾。这是 N-03 修复的「尾巴」——[STALE] 注释加对了，但没回扫清理原描述段落。**因验收门（validation）与 [STALE] 注释均正确、且能提供无歧义裁决，implementer 可据 [STALE] 正确取舍，不构成阻塞。**

**verdict: PASS — 设计已收敛。建议同批清理 M-03（3 行 body 文本）使文档自洽，但不卡收敛。**

| 类型 | 数量 | 说明 |
|------|------|------|
| Round 13 阻塞项已解决（可执行层） | 2 | N-02（§6.4 grep 改反向断言）/ N-03（issues.md #12 验收删 pending + #13 升 P1/W2 + [SURFACED]） |
| Round 13 minor 已清理 | 2 | M-01（§1.1 补 RetryIndicator/QueueBubble）/ M-02（§6.2 补 F7→F7-UI 边） |
| 新发现 gap（阻塞） | 0 | — |
| 新发现 gap（minor，非阻塞） | 1 | M-03（issues.md #8/#12 body 文本 3 处仍称 pending 待补，与同文件 [STALE] 注释矛盾） |
| 既有上游漂移（非阻塞） | 1 | U-01（system-architecture.md §6.3 Port 清单缺 IInstaller/IExtensionSettings，未在本次材料内，沿用 Round 13 非阻塞判定） |

---

## 一、Round 13 阻塞项逐项核验

### ✅ N-02 — §6.4 验收 grep 与 §3.9 [STALE] 矛盾 → 已解决

- **Round 13 问题**：§6.4 验收清单要求 `chat store 有 pending case → 有输出`，与 §3.9 [STALE]（不加 pending、不补 case）直接矛盾，执行会反向复活 N-01 刚清除的死代码。
- **当前处理**：§6.4 该行改为 **反向断言**：
  > `| chat store 无 pending 死代码 | grep -n "message.tool_call_pending" .../chat-chunk-processor.ts → **无输出**（[STALE] 移除，见 §3.9） |`
- **一致性核验**：§3.9（`ToolCallStatus = 'running' | 'completed' | 'error'`，无 pending）↔ §4.7（F7 alt 无 pending 分支）↔ §4.11（[STALE] pending 已移除）↔ §6.4（grep 无输出）→ **四方自洽**。
- **判定**：RESOLVED。验收层不再自相矛盾，执行不会重引入死代码。

### ✅ N-03 — issues.md 未同步 + §4.7 未兑现声明 → 已解决（两点均回填）

Round 13 的 N-03 含两个发散点，本轮确认**两点均已通过「方案 a：回填 issues.md」修复**：

1. **issues.md #12 验收 vs code-architecture §3.9**：
   - Round 13：#12 验收仍含 `[ ] ToolCallStatus 含 'pending'`。
   - 当前：#12 验收改为 `[ ] ExtensionInfo 含 tools / [ ] FileChangeStatus 含 'unmerged' / [ ] vue-tsc 0 错`，并加 `[STALE] ToolCallStatus 'pending' 不补` 注释。与 §3.9 一致。
   - **判定**：RESOLVED（可执行层）。
2. **issues.md #13 vs code-architecture §4.7/§4.12/§6.1**：
   - Round 13：#13 仍标 P3、「不排入 Wave」；§4.7 声称「在 issues.md #13 标注此冲突」未兑现。
   - 当前：#13 标题改 `P1（[SURFACED] 冲突修订，见下）`，新增完整 `[SURFACED] spec ↔ issues 优先级冲突（已裁决）` 段落（用户确认 2026-06-24，按 spec 方案 A，P1，W2），原延后理由作废；依赖表 #13 改 `W2（[SURFACED] P1 修订）`；总览 mermaid #13 标 `P1`。
   - **§4.7 声明兑现核验**：§4.7 称「在 issues.md #13 标注此冲突」——issues.md #13 现确实含 [SURFACED] 标注，**声明由「未兑现」转为「已兑现」**。
   - **判定**：RESOLVED（优先级 + Wave + 冲突标注三点对齐）。

---

## 二、Round 13 minor 项逐项核验（全部 RESOLVED）

### ✅ M-01 — §1.1 目录树缺 RetryIndicator.vue / QueueBubble.vue → 已补
- §1.1 `components/panel/` 现列 `RetryIndicator.vue # auto_retry 指示位（#13）` 与 `QueueBubble.vue # queue_update pending 气泡（#13）`，与 §4.12 F7-UI 引入的两个组件对齐。落点明确（panel 平级）。

### ✅ M-02 — §6.2 DAG 缺 F7→F7-UI 边 → 已补
- §6.2 关键依赖 DAG 现含 `F7 --> F7UI[retry/queue UI F7-UI]` 节点与边，与 §6.1 Wave 表「F7-UI 依赖 F7 store 数据层」一致。表↔图对齐。

---

## 三、新发现 gap

### 🟡 M-03（minor，非阻塞）— issues.md #8/#12 body 文本 3 处仍把 pending 当待补契约，与同文件 [STALE] 注释矛盾

N-03 的修复机制是给 #8/#12 加 `[STALE]` 覆盖注释（声明 pending 不补）。但原描述段落未回扫，留下 **3 处 body 文本**仍按旧契约（pending 待补）描述，与同文件 [STALE] 注释直接矛盾：

| # | 位置 | 当前文本（矛盾） | 与何矛盾 |
|---|------|----------------|---------|
| 1 | issues.md #12 方案 A「模型」行 | `模型: ExtensionInfo.tools / FileChangeStatus.unmerged / ToolCallStatus.pending` | #12 自身 [STALE] 注释（pending 不补）+ 验收（无 pending） |
| 2 | issues.md #12「支撑下游」段 | `字段类型需与 #8 验收标准中「ToolCallStatus 含 pending / FileChangeStatus 含 unmerged」对齐` | #8 验收已无 pending；引用了一条已删除的验收项 |
| 3 | issues.md #8「依赖 #12」段 | `#8 消费 ToolCallStatus.pending ... 需要 #12 先在 protocol.ts 中补这两个枚举` | #8 自身 [STALE] 注释（#8 不补 pending case、#12 不加 pending 枚举）+ §3.9 |

- **为何不阻塞**：
  1. **验收门（validation）全部正确**：#8/#12 验收清单均无 pending，§6.4 grep 为反向断言。implementer 按验收执行不会重引入死代码。
  2. **[STALE] 注释提供无歧义裁决**：#8 [STALE] 明确「#8 不补 pending case、#12 不加 'pending' 枚举」，#12 [STALE] 明确「pending 不补」，均引用 code-architecture §3.9 为权威源。implementer 可据 [STALE] 正确取舍，不存在 Round 13 所定义的「无从取舍」。
  3. 矛盾在 **描述性 body 文本**，非可执行验收项。性质等同代码里的过期注释——有显式覆盖（[STALE]）存在时不改变可执行语义。
- **为何仍应清理**：项目规则「冲突要表面化，禁止平均两种模式」。同文件内既保留旧指令又加 [STALE] 覆盖，是「两种模式并存」，应删旧对齐新。
- **修复**（外科式，3 行）：
  - #12 方案 A「模型」行删去 `/ ToolCallStatus.pending`（或注 `[已移除，见 STALE]`）。
  - #12「支撑下游」段把「ToolCallStatus 含 pending / 」删去，改为仅「FileChangeStatus 含 unmerged」对齐。
  - #8「依赖 #12」段把「`ToolCallStatus.pending` 和」删去，改为仅 `FileChangeStatus.unmerged`，并补一句「pending 见 [STALE]」。

### ⚪ U-01（既有上游漂移，非阻塞，Round 13 附注遗留）
- system-architecture.md §6.3 Port 清单仍缺 IInstaller / IExtensionSettings。本次材料未含该文件，沿用 Round 13 非阻塞判定，建议上游补齐，不影响收敛。

### 附加观察（sub-minor，非 gap）
- code-architecture §4.7 [SURFACED] 注释仍按「冲突原态」措辞（「issues.md #13 将其降为 P3 迷雾」）。现 issues.md #13 已升 P1，该注释作为「冲突已裁决」的历史记录可保留；如追求极致自洽，可补一句「issues.md #13 已同步升 P1/W2」。不影响理解与执行，不计为 gap。

---

## 四、收敛判定

**CONVERGED。**

- Round 13 的 **2 个阻塞项**（N-02 验收自矛盾、N-03 issues.md 未同步 + 未兑现声明）**均已在可执行层解决**：§6.4 改反向断言；issues.md #12 验收删 pending、#13 升 P1/W2 并加 [SURFACED]，§4.7 声明由未兑现转为兑现。
- **2 个 minor**（M-01 目录枚举、M-02 DAG 边）**全部清理**。
- **未发现新阻塞项**。新发现的 M-03 是 N-03 修复的描述性尾巴（3 处 body 文本与同文件 [STALE] 矛盾），验收门与 [STALE] 裁决均正确，implementer 可无歧义取舍，不构成阻塞。
- Round 12 已确认的对齐决策（git 全栈 IGitExecutor、GitZone 独立组件、Extension 内联候选、compact slash command、session.list onGlobalType、FileView 聚合 chat store、widget session 通道、unmerged 双路径、retry/queue store→UI 链路）经本轮复核无回归、无偷改。

**为何放行**：M-03 的矛盾存在于描述性 body 文本，可执行验收门（#8/#12 验收、§6.4 grep）与 [STALE] 覆盖注释均一致且能提供无歧义裁决——这恰是 Round 13 对「阻塞」的定义（验收层矛盾 / 无从取舍）的反面。继续卡收敛属过度审查；M-03 应作为同批清理项推进，但不阻断从设计进入执行。

---

## 五、建议清理项（非阻塞，可同批或执行期顺手修）

| # | 动作 | 对应 gap | 阻塞? |
|---|------|---------|------|
| 1 | issues.md #12 方案 A「模型」行删 `/ ToolCallStatus.pending` | M-03 | 否 |
| 2 | issues.md #12「支撑下游」段删「ToolCallStatus 含 pending / 」 | M-03 | 否 |
| 3 | issues.md #8「依赖 #12」段删「ToolCallStatus.pending 和」，补「pending 见 [STALE]」 | M-03 | 否 |
| 4 | （上游）system-architecture.md §6.3 Port 清单补 IInstaller / IExtensionSettings | U-01 | 否 |

完成 1–3 可使 issues.md 内部完全自洽（消除 [STALE] 与 body 并存）；不完成亦不影响执行正确性。

---

## 六、已确认无回归项

本轮复核确认 Round 12/13 已对齐的关键决策无偷改、无回归：N-01 的 pending 移除（§3.9/§4.7/§4.11/§6.4 四方自洽，验收为反向断言）、F-03/K-02 的 retry/queue UI 链路（§4.12 F7-UI + §6.1 W2 + §6.2 DAG 边 + §1.1 组件枚举 + issues.md #13 P1/[SURFACED]/W2 全链对齐）、git 全栈 IGitExecutor、Extension 内联候选、compact slash command、session.list onGlobalType、FileView 聚合 chat store、widget session 通道、unmerged 由 runtime 双路径推。`auto_retry_start/end`/`queue_update`/`file_changes`/`thinking_end`/`tool_call_update`/`complete` 的生产者经前轮代码库核验存在，§4.12 F7-UI 消费链成立。唯一无生产者的 `tool_call_pending` 已被 N-01 正式移除并贯穿四文档一致。
