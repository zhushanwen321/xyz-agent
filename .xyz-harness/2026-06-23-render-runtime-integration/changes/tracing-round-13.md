# Code Architecture 追踪报告 — Round 13（收敛复核）

> 独立 subagent 隔离追踪产出
> 追踪输入：code-architecture.md、tracing-round-12.md、issues.md、system-architecture.md（+ 交叉验证实际代码库 protocol.ts / message.ts / event-adapter.ts / chat-chunk-processor.ts / mock/）
> 追踪视角：Round 12 的 2 阻塞项（N-01 / F-03+K-02）+ 3 文档清理项（K-01 / F-02 / D-02）是否解决，以及是否引入新 gap

## 结论：NOT CONVERGED

Round 12 的 2 个阻塞项**在设计主体上均已解决**（N-01 移除 pending 切片、F-03/K-02 补 §4.12 F7-UI 时序图 + §4.7 [SURFACED] 冲突标注），3 个文档清理项**全部解决**（K-01 / F-02 / D-02）。但本轮复核**发现 2 个修复过程中引入的新 gap**：

1. **N-02（阻塞）**：§6.4 验收 grep 清单仍要求 `chat store 有 pending case → 有输出`，与 N-01 的 `[STALE]` 移除（§3.9/§4.11 删 pending、当前代码 `ToolCallStatus` 无 `'pending'`、`chat-chunk-processor.ts` 无 pending case）**直接矛盾**。执行该验收项会重新引入 N-01 刚清除的死代码。验收层自相矛盾。
2. **N-03（阻塞）**：§4.7 [SURFACED] 声称「在 issues.md #13 标注此冲突」，但 issues.md **未更新**——issues.md #12 验收仍要求 `ToolCallStatus 含 'pending'`（与 N-01 移除矛盾），issues.md #13 仍为 P3 延后（与 code-architecture 的 spec-P1 覆盖 + W2 排期矛盾）。N-01 决策与 spec↔issues.md 冲突**未向上游传播**，code-architecture 与其上游 issues.md 在两点上发散，且含一条未兑现的前向声明。

另含 2 个非阻塞残留 + 1 个既有上游漂移。

**verdict: FAIL — 需修复 2 个验收/跨文档一致性项（N-02、N-03）后方可收敛；2 个 minor 残留 + 上游漂移建议同批清理但不卡收敛。**

> 说明：阻塞项的**设计工作实质完成**，剩余仅是验收清单对齐（一行）+ 上游 issues.md 同步（两处）的外科式修复。本轮距离收敛很近，但 §6.4 的自相矛盾会在执行期直接瓦解 N-01 的修复，必须先收敛。

| 类型 | 数量 | 说明 |
|------|------|------|
| Round 12 阻塞项（设计主体）已解决 | 2 | N-01 / F-03+K-02 |
| Round 12 文档清理项已解决 | 3 | K-01 / F-02 / D-02 |
| 新发现 gap（阻塞） | 2 | N-02（§6.4 验收自矛盾）/ N-03（issues.md 未同步 + §4.7 未兑现声明） |
| 新发现 gap（minor，非阻塞） | 2 | M-01（§1.1 缺 RetryIndicator/QueueBubble）/ M-02（§6.2 DAG 缺 F7→F7-UI） |
| 既有上游漂移（非阻塞） | 1 | U-01（system-architecture §6.3 Port 清单缺 IInstaller/IExtensionSettings，Round 12 附注遗留） |

---

## 一、Round 12 阻塞项逐项核验

### ✅ N-01 — `message.tool_call_pending` 无生产者 → 设计主体已解决

- **Round 12 问题**：整条 FR-2 切片（payload + store case + `ToolCallStatus.pending`）建在 stale 前提上（runtime 不生产），是死代码消费。
- **当前 code-architecture 处理**：
  - §3.9 加 `[STALE]` 说明：runtime 不生产 `tool_call_pending`（tool 审批链路 Out-of-scope，confirm/select→pending 映射已被有意移除），「本轮不定义 payload、不补 consume case、`ToolCallStatus` 不加 `'pending'`」。
  - §3.9 `ToolCallStatus = 'running' | 'completed' | 'error'`，并注「`'pending'` 不加」。
  - §4.7 F7 时序图 `alt` 分支**无** `tool_call_pending` case。
  - §4.11 F11 加 `[STALE] ToolCallStatus.pending 已移除`，本轮只补 `ExtensionInfo.tools` 和 `FileChangeStatus.unmerged`。
- **代码库核验（本轮实证）**：
  - `grep -rn "tool_call_pending" src-electron/runtime/src/` → **无生产点**（确认 N-01 前提成立）。
  - `protocol.ts:175` 仍声明 `'message.tool_call_pending'` 类型（unused，未消费），`message.status`/`message.complete`/`message.error` 同列存在（印证 Round 12 F-04 伪阳性结论）。
  - `message.ts:3` `ToolCallStatus = 'running' | 'completed' | 'error'` —— **当前代码本就无 `'pending'`**，code-architecture §3.9 与现实一致。
  - `chat-chunk-processor.ts` 无 `tool_call_pending` case（仅 line 208 一条与请求级 pending 通道无关的注释）。
  - `event-adapter-extension.test.ts` 存在于 `src-electron/runtime/test/`，含 tool_call_pending 反向断言 → §3.9 [STALE] 引用的证据真实可查。
- **判定**：RESOLVED（设计主体）。**但修复留下验收层自矛盾，见下文 N-02。**

### ✅ F-03 + K-02 — retry/queue UI 链路缺失 → 设计主体已解决

- **Round 12 问题**：§4.7 只覆盖 store 消费，无 store→UI 时序图；且以「待 UI 形态确认」为由静默降级 spec P1 AC，理由虚假（spec C10 已确认形态）。
- **当前 code-architecture 处理**：
  - **新增 §4.12 F7-UI 时序图**：`RetryIndicator.vue` / `QueueBubble.vue` 消费 `ChatStore.getRetryState`/`getQueueState`，渲染 Composer 上方独立行；含方法签名表（props、getRetryState、getQueueState）+ 数据流链 + 关联（spec C10/FR-3/FR-4/AC）。
  - §4.7 末尾加 **[SURFACED] spec ↔ issues.md 优先级冲突**标注，明确「spec P1 覆盖 issues.md #13 的 P3 延后」「本轮按 spec 补时序图（形态已知）」。
  - §6.1 Wave 表新增 F7-UI 行（W2，依赖 F7 store 数据层）。
- **代码库核验**：`event-adapter.ts:523/537/550` 实际生产 `auto_retry_start`/`auto_retry_end`/`queue_update` → 数据有生产者，§4.12 消费链路成立。
- **判定**：RESOLVED（设计主体，Round 12 option a + b 并举）。**但 §4.7 声称「在 issues.md #13 标注此冲突」未兑现，见下文 N-03。**

---

## 二、Round 12 文档清理项逐项核验（全部 RESOLVED）

### ✅ K-01 — §6.3 点 2 Diff tab 残留 → 已清理
- 当前 §6.3 点 2 改为「Terminal / Browser（**不含 Diff tab**；git-zone Diff 按钮仅作为 SideDrawer 触发源……见 spec-w11.md FR-8 / Scope boundaries #8）」，与 §4.10、spec FR-8 三方一致。Diff tab 已删除。

### ✅ F-02 — mock git 落点冲突 → 已收敛
- §1.1 `api/mock/` 现列独立文件 `git.ts # git.status fixture（#4/#1）`；§6.3 点 4 明确「按 issues.md #4 方案 A 新建独立 `mock/git.ts`，与 spec G-R2-07『并入 index.ts』存在上游表述差异，以 issues.md（更下游决策层）为准」。§1.1 index.ts 注释不再含「+git fixture」，两节自洽，冲突显式表面化。

### ✅ D-02 — GitService→git-status-parser 访问路径 → 已说明
- §5.1 新增「GitService → git-status-parser 访问路径（分层豁免说明）」：`infra/git-status-parser.ts` 是纯函数无 IO，作为 domain utility 例外；GitService 经 `IGitExecutor.exec('status')` 拿 raw stdout 再调纯解析，IO 边界仍在 IGitExecutor port 闭合。与 §2「services 不直接 import infra」规则的兼容性已一行说清。

---

## 三、新发现 gap

### 🔴 N-02（阻塞）— §6.4 验收 grep 清单与 N-01 移除自相矛盾

- **现象**：§6.4「验收 grep 清单」仍含一行：
  > `| chat store 有 pending case | grep -n "message.tool_call_pending" src-electron/renderer/src/stores/chat-chunk-processor.ts → 有输出 |`
- **矛盾**：
  - 本轮 N-01 修复明确「不补 consume case、`ToolCallStatus` 不加 `'pending'`」（§3.9 [STALE]），§4.7 F7 时序图也**无** pending 分支。
  - 代码库实证：`message.ts:3` `ToolCallStatus` 无 `'pending'`，`chat-chunk-processor.ts` 无 pending case。
  - 该验收项却要求 grep **有输出**（即要求存在 pending case）。
- **后果**：执行期若按 §6.4 验收，必须向 `chat-chunk-processor.ts` **新增 `case 'message.tool_call_pending'`** —— 即重新引入 N-01 刚清除的死代码消费。§3.9（无 pending）与 §6.4（有 pending case）执行时不可同时满足。
- **根因**：N-01 修复时只改了 §3.9/§4.7/§4.11 的设计描述，未回扫 §6.4 验收清单。
- **判定**：NEW GAP（阻塞）。修复：§6.4 删除该行，或改为反向断言（`grep ... → 无输出`，与 §3.9 一致）。

### 🔴 N-03（阻塞）— §4.7 未兑现的 issues.md 传播 + 上游发散

code-architecture 的两项关键决策（移除 pending、retry/queue 升 P1 入 W2）**未向上游 issues.md 传播**，且 §4.7 含一条未兑现的前向声明。两个发散点：

1. **issues.md #12 验收 vs code-architecture §3.9**：
   - issues.md #12 验收标准仍含 `[ ] ToolCallStatus 含 'pending'`。
   - code-architecture §3.9 已移除 `'pending'`（[STALE]）。
   - **直接矛盾**：执行者按 issues.md #12 会补 `'pending'`，按 code-architecture §3.9 不补。N-01 的移除决策断链。
2. **issues.md #13 vs code-architecture §4.7/§4.12/§6.1**：
   - issues.md #13 仍标 P3、「UI 形态需用户确认」、「不排入具体 Wave」。
   - code-architecture §4.7 [SURFACED] 声称「**在 issues.md #13 标注此冲突**」，但 issues.md #13 **未作任何冲突标注**（无 [SURFACED] 标记、无 P 级修订、无 Wave 调整）。
   - code-architecture §4.12 已把 retry/queue UI 排入 W2 并按 spec P1 实现，issues.md #13 仍是 P3 延后 —— 两文档对同一事项给出互斥排期。
- **判定**：NEW GAP（阻塞）。这是 code-architecture 内的一条**未兑现声明**（§4.7 称已标注 issues.md，实际未标）+ 上游 issues.md 与 code-architecture 在两处发散。修复二选一：
  - (a) 回填 issues.md：#12 删 `ToolCallStatus 含 'pending'` 验收、#13 加 [SURFACED] 冲突标注 + P 级/Wave 修订，使 issues.md 与 code-architecture 一致；**或**
  - (b) 收回 §4.7 声明：将「在 issues.md #13 标注此冲突」改为「建议上游 issues.md 同步此裁决（待办）」，承认未传播，并把 issues.md #12/#13 的发散记为待裁决项。不得保留「已标注」的虚假陈述。

### 🟡 M-01（minor，非阻塞）— §1.1 目录树缺 RetryIndicator.vue / QueueBubble.vue
- §4.12 F7-UI 引入 `RetryIndicator.vue` / `QueueBubble.vue` 作为组件，并各列方法签名，但 §1.1 `components/panel/` 目录树仅列 Panel/GitZone/SideDrawer/Composer +「...」。
- 影响：新时序图的两个核心组件未在工程目录枚举，落点（panel 平级 vs Composer 子组件）不明。
- 修复：§1.1 panel 下补两行（或注明其为 Composer 内嵌子组件）。

### 🟡 M-02（minor，非阻塞）— §6.2 DAG 缺 F7→F7-UI 边
- §6.1 Wave 表已列 F7-UI（W2，依赖 F7 store 数据层），但 §6.2 关键依赖 DAG **无 F7-UI 节点**、无 `F7 --> F7-UI` 边。
- 影响：Wave 表与 DAG 对 F7-UI 的依赖描述不一致（表有、图无）。
- 修复：§6.2 补 `F7 --> F7-UI[retry/queue UI]` 节点与边。

### ⚪ U-01（既有上游漂移，非阻塞，Round 12 附注遗留）
- system-architecture.md §6.3 Port 清单仍只列 ISessionStore/IConfigStore/IPiEngine/IGitExecutor 四项，**未含 IInstaller/IExtensionSettings**（code-architecture §1.2 已列这两个 port 且 §5.4 ExtensionService 依赖它们）。
- Round 12 已标为「上游漂移，非 code-architecture 责任，建议同步」。本轮仍存在，维持非阻塞，建议上游补齐。

---

## 四、收敛判定

**NOT CONVERGED。**

阻塞项 2 个（均为 N-01 / F-03+K-02 修复过程中引入的验收/跨文档一致性裂缝）：
1. **N-02**：§6.4 验收 grep「pending case → 有输出」与 §3.9 [STALE] 移除矛盾，执行会重引入死代码。一行修复（删行 / 改反向）。
2. **N-03**：§4.7 未兑现「在 issues.md #13 标注」声明；issues.md #12（仍要 pending）/ #13（仍 P3）与 code-architecture 两处发散。修复 = 回填 issues.md 或收回 §4.7 声明。

非阻塞 minor 2 个（M-01 目录枚举、M-02 DAG 边）+ 既有上游漂移 1 个（U-01）。

**为何不放过**：N-02 是验收层自矛盾，会让 N-01 的死代码清除在执行期被验收项反向复活；N-03 让 issues.md 与 code-architecture 对同一事项给出互斥指令，执行者无从取舍。两者都是 Round 12 阻塞项修复的「尾巴」，必须在收敛前收齐，否则 Round 12 的两个阻塞项实质未真正闭环。

---

## 五、修复后可收敛的最小动作清单

| # | 动作 | 对应 gap | 阻塞? |
|---|------|---------|------|
| 1 | §6.4 删除「chat store 有 pending case」行，或改为 `→ 无输出` 反向断言，与 §3.9 [STALE] 对齐 | N-02 | 是 |
| 2 | 裁决 issues.md 同步：回填 #12（删 pending 验收）+ #13（加 [SURFACED] + P1/W2 修订）；或收回 §4.7「已标注 issues.md」声明改记为待办 | N-03 | 是 |
| 3 | §1.1 panel 目录补 RetryIndicator.vue / QueueBubble.vue（或注明内嵌于 Composer） | M-01 | 否 |
| 4 | §6.2 DAG 补 `F7 --> F7-UI` 节点与边 | M-02 | 否 |
| 5 | （上游）system-architecture.md §6.3 Port 清单补 IInstaller/IExtensionSettings | U-01 | 否 |

完成 #1、#2 后即可重新提交追踪并判 CONVERGED；#3–#5 建议同批清理但不卡收敛。

---

## 六、已确认无回归项

本轮复核确认 Round 12 列出的已对齐决策无偷改、无回归：git 全栈 IGitExecutor（#1）、GitZone 独立组件（#3）、Extension 内联候选（#5）、compact slash command（#6）、session.list onGlobalType（#7）、FileView 聚合 chat store（#10）、widget session 通道（#11）、git-zone 独立真实 status（C12）、unmerged 由 runtime 双路径推（C15）。`auto_retry_start/end`/`queue_update`/`file_changes`/`thinking_end`/`tool_call_update`/`complete` 的生产者经代码库核验均存在（event-adapter.ts 实际 emit），§4.12 F7-UI 消费链成立。唯一无生产者的 `tool_call_pending` 已被 N-01 正式移除（§3.9 [STALE]），与代码库一致。
