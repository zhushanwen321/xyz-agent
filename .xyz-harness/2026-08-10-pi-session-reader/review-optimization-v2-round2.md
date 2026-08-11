# session-reader v2 优化设计：第二轮对抗式审查报告

> 审查对象：`optimization-v2.md`（修正版，含 O5 `#` 碰撞处理）
> 审查方式：读 render.ts / hash-provider.ts / find.ts 源码 + 用真实 session `019e6c96`（1204 entry）+ 全量 3486 session 跑探针独立核实
> 审查基调：对抗式，默认怀疑，只报告不修改

## Summary

**1 must-fix, 3 suggestions.** 第一轮三条 must-fix（M1/M2/M3）**全部真正修正**，probe 复核通过。但**新增的 O5（`#` 碰撞处理）引入一个 P0 级算法错误**：D5 唯一前缀算法"取最小值 minLCP"方向写反，全量数据验证下大量碰撞桶的 insertText 仍然碰撞，直接违背 O5"`#` 引用永远唯一"的设计目标。修正算法（取最大值 maxLCP+1）已实测全量通过。

**结论：不可直接进入实施。** 修对 D5 算法 + 补一个大碰撞桶验收场景后即可进入。其余 4 个改动（O1-O4）因果链、探针、验收齐全。

## 修正核实结论（第一轮 must-fix）

| # | 结论 | 证据 |
|---|---|---|
| **M1**（D2 错误"无 id 只能靠顺序"） | ✅ **已修正** | probe 复核：toolResult 带 `message.toolCallId` 515/515、`message.toolName` 515/515、孤儿 toolResult 0、孤儿 toolCall 4。D2 已改用 toolName + toolCallId 精确关联；P-o2-order（fork/branch 错位伪风险）已删除；P-no-tr-id 已替换为 P-tr-has-id-and-name（✅）。附录诚实记录了初版 probe 看错层级的教训 |
| **M2**（expand 示例"extractText 返空→[tool result]"） | ✅ **已修正** | §2.1 expand 现状示例改为真实输出（结果文本前 100 字 `src/stores/todo.ts:12: const cache...`），病因改为"不含工具维度"（非"extractText 返空"）。与源码 `entryBrief` 的 `truncate(extractText(msg.content), 100)` 一致 |
| **M3**（D1 工具表漏 4 个 + 无 fallback） | ✅ **已修正** | probe 复核 019e6c96 工具全集 = 10 个，D1 表已全列（补全 todo/coding-workflow-gate/coding-workflow-init/coding-workflow-phase-start）+ 新增"未知工具 fallback：`<toolname>: <arguments JSON 前 50 字>`" |

三条 must-fix 都是实质修正（改了方案/数据/病因），不是表面改字。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D5 / §3.2 O5 | P0-11 事实 + P0-10 因果 | D5 唯一前缀算法"取最小值 minLCP+1"方向写反，全量验证下 insertText 仍大量碰撞，违背 O5 目标 | 改为"取最大值 maxLCP+1"（与最像的兄弟 LCP+1）；已实测全量通过 |
| SUGGESTION | §2.5 痛点 6 表 | P0-11 事实 | "最严重"列的 3 个桶（6/4/5 个）非真实最大，实测最大 019e9680=19、019e970f=16，低估 3 倍 | 复核后改为真实最大桶数据 |
| SUGGESTION | §3.3 D5 正文 | P0-12 一致性 | D5 正文说"findSessions 多匹配时算 insertText"，但算 insertText 的是补全层 `provideHashCandidates`（hash-provider.ts），不是工具层 `findSessions`（find.ts）；§5 O5 行已正确指向 provideHashCandidates，正文与 §5 矛盾 | D5 正文函数名改为 provideHashCandidates，与 §5 统一 |
| SUGGESTION | §4 V-o5 / §3.3 D5 | P0-14 验收 | V-o5 只用 2 元碰撞桶（019fea0e），2 元桶 min=max LCP 无法暴露 D5 算法方向错误；验收通过 ≠ 算法正确 | 补一个大碰撞桶验收场景（≥5 元，如 019e9680 的 19 元） |

---

## P0 Must-Fix 详述

### 【P0】D5 唯一前缀算法方向写反——"取最小值"应为"取最大值"

**文档声称**（§3.3 D5）：
```
对当前 sid，与 S 中其他每个 sid 求字符级 LCP，取【最小值】 minLCP
唯一前缀 = sid.slice(0, minLCP + 1)
```

**实测推翻**（全量 3486 session，对全部 329 个碰撞桶跑文档算法）：

文档算法（min LCP+1）**大面积失败**。摘录几个碰撞桶：

| 桶 | 桶内 session 数 | 文档算法 insertText | 子串命中数 |
|---|---|---|---|
| `019e9680` | 19 | `019e9680-d` / `019e9680-c` / `019e9680-8` / `019e9680-e` | `-d` 命中 5、`-c` 命中 7、`-8` 命中 3、`-e` 命中 4 |
| `019e970f` | 16 | `019e970f-9` / `019e970f-8` | 各命中 8 |
| `019eb527` | 9 | `019eb527-b` / `019eb527-d` | `-b` 命中 2、`-d` 命中 4 |
| `019e8b55` | 7 | `019e8b55-133` / `019e8b55-134` | 各命中 3 |

19 元桶 `019e9680` 下，4 个不同的 insertText（`-d/-c/-8/-e`）居然覆盖全部 19 个 session，毫无唯一性可言。

**根因**（算法逻辑错误，非边界 case）：

要唯一区分一个 sid，它需要比"**与它最像的兄弟**（共享前缀最长的那个邻居）"多一位。即应取 LCP 的**最大值**（最像的兄弟）+1。文档写"取最小值"会被"**最不像的远房邻居**"把前缀拖短——例如 `019e9680-dcc0` 与 `019e9680-8...` 的 LCP 只有 9（`019e9680-`），min LCP=9 → slice(0,10)=`019e9680-d`，但桶里所有 `-d*` 开头的兄弟都得到同一个 `019e9680-d`，互相碰撞。

**对方案的连锁影响**：

1. **O5 设计目标直接落空**：O5 目标是"`#` 引用永远唯一"，但按 D5 文档实现，26.5% 碰撞 session 的 insertText 仍会碰撞，agent find 仍触发 F2 多匹配。O5 等于没解决问题。
2. **V-o5 验收会假通过**（见下文 S3）：V-o5 用的 2 元桶样本（019fea0e）恰好是 min=max LCP 的退化情况，文档算法在 2 元桶上碰巧正确，验收绿灯但算法错。
3. **§5 待验证检查点缺失**：§5 O5 行没列 D5 算法正确性的探针/验收检查点（只说"V-o5"），算法错误没有任何机制能拦截。

**修复方向**：

D5 算法改为取**最大值**：

```
对当前 sid，与 S 中其他每个 sid 求字符级 LCP，取【最大值】 maxLCP
唯一前缀 = sid.slice(0, maxLCP + 1)
```

**已实测验证**：修正算法（max LCP+1）对全量 3486 session / 329 碰撞桶全部通过——每个 insertText 在桶内唯一 + `sessionId.includes(insertText)` 子串匹配唯一命中。insertText 最大长度 16 字符（分布：10 字符 415 / 11 字符 43 / 12 字符 270 / 13 字符 158 / 16 字符 40），比文档错误算法（最大 13）略长但仍远短于完整 uuid（36），可接受。

> 算法直觉：等价于在 sid 的字符 trie 上，从叶子回溯到"只剩自己"的第一个分叉点，取到该分叉的路径长度+1。这是经典的"区分性前缀（distinguishing prefix）"。

---

## Suggestion 详述

### S1 §2.5"最严重"碰撞桶数据失实，低估 3 倍

**文档声称**（§2.5 表"最严重"行）：`019fa865` 6 个、`019fa867` 4 个、`019fa84e` 5 个。

**实测复核**：这三个桶的数量本身正确（6/4/5），但它们**不是最严重的**。真实最大桶：

| 桶 | 实测 session 数 |
|---|---|
| `019e9680` | **19** |
| `019e970f` | **16** |
| （某桶） | 9 |
| （4 个桶） | 7 |
| `019fa865`（文档"最严重"） | 6 |

文档标"最严重"却列了排不进前 5 的中等桶，最大桶（19 个）是文档所列（6 个）的 3 倍多。

**影响**：误导读者对问题严重性的判断。更关键的是——19 元大桶恰恰是 D5 错误算法失效的重灾区（见 P0），文档若用了真实最大桶数据，本应在设计阶段就暴露算法问题。碰撞率 26.5% 本身正确（实测 26.6%），不改变方案存在性，但"最严重"栏应改为真实数据。

**改进**：§2.5"最严重"行改为 `019e9680` 19 个、`019e970f` 16 个等真实 top 桶。

### S2 D5 正文函数名笔误（findSessions ≠ provideHashCandidates）

**文档声称**（§3.3 D5 正文）："findSessions 多匹配时，对每个 match 计算 insertText"。

**源码事实**：
- `findSessions`（`find.ts`）是**工具层** find action 用的，返回 `MatchedSession[]`，**不返回 insertText**（find.ts 全文无 insertText 字段）。
- `provideHashCandidates`（`hash-provider.ts`）是**补全层**，返回 `AutocompleteCandidate[]`，每个 candidate 有 `insertText` 字段——**这才是算 insertText 的地方**。
- 且 provideHashCandidates 的数据源是 `SessionManager.listAll`（pi 的），不是 findSessions。

文档 §5 O5 行已正确写"tui/hash-provider.ts：provideHashCandidates 多匹配时动态算唯一前缀（D5）"，但 D5 正文却说 findSessions，自相矛盾。实现者看 D5 正文会把算法挂到错误的函数上。

**改进**：D5 正文"findSessions 多匹配时"改为"provideHashCandidates 多匹配时"，与 §5 统一。

### S3 V-o5 验收样本无法暴露 D5 算法错误

**现状**：V-o5（§4）用 `019fea0e`（2 个 session）作验收样本。

**问题**：2 元碰撞桶是退化情况——两个 sid 之间只有一个 LCP 值，min LCP = max LCP，文档错误算法（min）与修正算法（max）在 2 元桶上**结果完全相同**，都碰巧正确。因此 V-o5 即使按错误算法实现也会绿灯通过，**验收通过 ≠ 算法正确**。

D5 算法错误只在 ≥3 元且存在"子簇"的桶暴露（如 19 元的 019e9680 有 `-d/-c/-8/-e` 四个子簇）。V-o5 的 2 元样本完全无法触发。

**改进**：V-o5 补一个 ≥5 元的真实碰撞桶验收场景（如 `019e9680` 19 元，或 `019eb527` 9 元），断言"19 个候选的 insertText 两两不同 + 每个 `findSessions(insertText去掉#)` 唯一命中"。这样能在验收阶段拦截算法方向错误。

---

## 通过项（站得住的部分）

为平衡对抗视角，记录核实**通过**的部分：

- **M1/M2/M3 三条 must-fix 全部实质修正**：不是表面改字，方案/数据/病因都改对了。附录对初版 probe 看错层级的教训记录诚实。
- **碰撞率 26.5% 真实**（实测 26.6%，329 前缀/926 session），O5 的问题定位成立。
- **findSessions 子串匹配链路成立**：`find.ts` 确认是 `sessionId.includes(query)` 子串匹配（line 242），insertText 延长后 `019fea0e-c` 是 `019fea0e-c0cb-...` 的前缀子串，includes 返回 true。O5 的"insertText 延长 → findSessions 子串匹配唯一命中"链路在算法修对后成立。
- **D1 工具表完整**：实测 019e6c96 工具全集 = 10 个，与 D1 表一致；未知工具 fallback 已定义。
- **D2 数据源正确**：toolCallId/toolName 515/515 probe 复核通过，by construction 精确关联无顺序依赖。
- **O1/O3/O4 因果链成立**：O1（outline 加 assistantBrief + 修 toolSummary bug）→ 目标 1；O3（detail 默认摘要）→ 解决条目消失；O4（extract）→ 目标 4。toolSummary bug（render.ts `entryToolCallNames` 读 `msg.toolCalls` 恒空）源码确认真实存在。
- **探针诚实**：P-toolcall-src / P-args-fields / P-tr-has-id-and-name / P-collision-rate 均标 ✅ 且 probe 复核通过；P-o1-token / P-extract-commits 标 ⛔ 待实测，未虚标。
- **五段骨架 / 结论先行 / 自包含**（无 delta 链）：齐全。
- **F7-F9 错误恢复指引**：均有 👉 具体动作（S5 单位混用问题第一轮已提，本版 F9 已统一用字节并注明 ≈ token 换算，已改进）。

## 进入实施的前置条件

1. **【必须】** D5 算法改为取最大值 maxLCP+1（已实测全量通过）。
2. **【必须】** V-o5 补一个 ≥5 元碰撞桶验收场景，确保能拦截算法方向错误。
3. 【建议】§2.5"最严重"数据改为真实 top 桶；D5 正文函数名改为 provideHashCandidates。

完成 1、2 后，5 个改动（O1-O5）可进入实施。
