# session-reader v2 优化设计：对抗式审查报告

> 审查对象：`optimization-v2.md`（session-reader v2 优化设计）
> 审查方式：读 render.ts / parser.ts 源码 + 用真实 session `019e6c96`（1204 entry）跑探针独立核实文档所有"probe 实测"声称
> 审查基调：对抗式，默认怀疑，只报告不修改

## Summary

**3 must-fix, 6 suggestions.** 方向（4 个改动提升信噪比、压调用次数）成立，但有 **2 处关键事实错误**直接动摇 O2 方案的根基，**1 处现状描述与代码行为不符**会误导实现，**1 处工具覆盖遗漏**留下未定义行为。

最严重的问题：**O2 推荐方案 A（toolCall→toolResult 靠顺序关联）建立在一个错误的 probe 结论上**——文档 D2 声称"toolResult 无 id 只能靠顺序关联"，实测 515/515 toolResult 都带 `message.toolCallId` 且全部能精确匹配 toolCall.id。用 id 关联是 by construction 精确（准则 8 减法），文档却选了更脆弱的"顺序关联"并凭空造出 P-o2-order（fork/branch 错位）风险。

## 核实结论：§2.3 toolSummary bug 是否真实

**✅ 真实存在。** `render.ts:117-128` 的 `entryToolCallNames` 读 `msg.toolCalls`：

```ts
function entryToolCallNames(entry: Entry): string[] {
  const msg = entry.message
  if (msg === undefined || msg.toolCalls === undefined || !Array.isArray(msg.toolCalls)) {
    return []
  }
  ...
}
```

实测 019e6c96（563 个 assistant message）：**0 个**有顶层 `message.toolCalls` 字段；工具调用全在 content blocks 的 `type:"toolCall"`（519 个，全部带 id）。因此 `entryToolCallNames` 恒返 `[]`，`toolSummary` 恒为空串，v1 全程未工作过。文档 §2.3 论断成立，行号"render.ts:118"基本准确（117 函数定义、119 关键守卫行）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D2 / §3.2 O2 | P0-11 事实 + P0-10 因果 | "toolResult 无 id 只能靠顺序关联"是错误 probe 结论；O2 方案 A 建立在此错误前提上 | 改用 toolCallId↔toolCall.id 精确关联，删 P-o2-order 伪风险 |
| MUST_FIX | §2.1 / §2.2 | P0-11 事实 | expand 现状示例"toolResult 只剩 [tool result]（extractText 返空）"与代码行为不符 | 改为真实输出（文本前 100 字符），病因改为"brief 不含工具维度" |
| MUST_FIX | §3.3 D1 | P0-12 遗漏 | D1 工具表只列 6 个，实测漏 4 个真实工具（todo/coding-workflow-*），未知工具摘要 fallback 未定义 | 补全工具表 + 定义未知工具 fallback 规则 |
| SUGGESTION | §4 V-callcount | P0-13/14 验收 | v1 基线"5 次"来源未锚定，无固定任务基准 | 锚定同一任务记录 v1 真实调用链作对比基线 |
| SUGGESTION | §3.3 D4 | P0-10 权衡 | V3 阈值 600→1500 推翻 v1 已验收目标，outline token 相对 v1 翻倍的 tradeoff 未量化 | 量化"多 ~700 token vs 省 3 次调用"的取舍 |
| SUGGESTION | §3.3 P-no-tr-id | P0-16 探针 | 标 ✅ 但 probe 看错层级（只看 content block，漏 message.toolCallId） | 探针对齐正确字段层级，结论翻转为"有 id 关联" |
| SUGGESTION | §3.3 D3 files | P0-12 边界 | files 预设只取 path 字段，未说明为何不含 todo 等非文件工具 | 明确 files scope 或补 todo 等的处理 |
| SUGGESTION | §3.3 F9 | P0-18 错误 | F9 用"4KB 预算"，V-o1 用"1500 token"，单位混用 | 统一预算单位或注明换算 |
| SUGGESTION | §3.3 D3 commits | P0-12 边界 | `[0-9a-f]{7,40}` 会把 uuid v7 的十六进制段误当 commit（如 019e6c96 本身 8 位） | 限定 7-8 位 + 上下文消歧，或接受噪音并说明 |

---

## P0 Must-Fix 详述

### M1【最严重】D2"无 id 只能靠顺序"是错误事实，O2 方案建立在错误前提上

**证据（probe 019e6c96 全量 1204 entry）**：

| 核实项 | 结果 |
|---|---|
| toolResult 总数 | 515 |
| toolResult 带 `message.toolCallId` | **515 / 515（100%）** |
| toolResult 无任何 id | 0 |
| assistant toolCall block 总数 | 519（全部带 `id` 字段） |
| toolResult.toolCallId 能精确匹配到 toolCall.id | **515 / 515（0 孤儿）** |
| 孤儿 toolCall（无对应 toolResult） | 4（正常：未完成/被中断调用） |

基线 design.md §2 自己给出的真实采样就明明白白写着 `"message":{"role":"toolResult","toolCallId":"call_7f2...","content":[{"type":"text",...}]}`——**message 层级有 toolCallId**。v2 文档 D2 却声称"probe 确认 toolResult content 只 `[{type,text}]`，**无 tool_use_id/toolCallId 字段**"。

**错误根因**：D2 的 probe 只检查了 content block 层级（content 内确实无 id），却下了"无 id 关联"的全局结论，漏看了 message 层级的 toolCallId。这是准则 13（运行时行为断言必须先验证）的典型违反——probe 看错层级，结论跟着错。

**对方案的连锁影响**：

1. **O2 推荐方案 A 选了"顺序关联"**（§3.2 O2 表），而正确做法是用 `toolResult.message.toolCallId ↔ toolCall.id` 精确关联——后者 by construction 正确（准则 8 减法），在 fork / compaction / branch 跳跃、toolResult 跨 turn、toolCall 与 toolResult 不相邻等任何场景都零错位。
2. **凭空造出 P-o2-order 风险**（§3.2 O2 表风险栏 + §3.3 P-o2-order + §5 待验证检查点）："fork/compaction 跳跃场景靠顺序可能错位，需实测"——这是一个**本不存在的问题**。用 id 关联则无需此项验证。
3. **D2 的关联规则描述误导实现**："turn 内 assistant toolCall block 按出现顺序对应后续 toolResult entry 按出现顺序"——这条规则在"一个 assistant 含多个 toolCall、toolResult 乱序返回"时就错位；id 关联无此问题。

**修复方向**：
- D2 改为：`toolResult.message.toolCallId`（probe 确认 515/515 存在）↔ `assistant content block (type:toolCall).id`（519/519 存在）精确匹配关联。顺序关联仅作"toolCallId 缺失时的 fallback"（实测缺失率 0%）。
- O2 方案 A 重写为基于 id 的关联；风险栏删去 P-o2-order（或降级为"id 缺失兜底"）。
- §5 删除 P-o2-order 待验证检查点（伪风险）。

### M2 §2.1 expand 现状示例"extractText 返空 → [tool result]"与代码行为不符

**证据**：

render.ts `entryBrief` 对 toolResult：
```ts
if (msg.role === 'toolResult') {
  return truncate(extractText(msg.content), 100) || '[tool result]'
}
```

`extractText` 对 content 的 filter 是保留 `type !== 'thinking' && !== 'tool_use' && !== 'tool_result'` 的 block。toolResult 的 content 实测全部是 `[{type:'text', text:'真实内容'}]`（515/515，shape = `array:text`）——`type:'text'` 不在排除集，**extractText 返回非空 text**。

probe 结果：**515/515 toolResult 的 extractText 返回非空，0 个返空**。

**文档错误**：§2.1 写
```
[2] toolResult [tool result]   ← 结构化结果 extractText 返空，只剩占位
```
这是**编造或误解的输出**。真实 expand 显示的是 toolResult 文本前 100 字符，不是 `[tool result]` 占位。`[tool result]` 只在 text 为空字符串时才出现（实测 0 次）。

**对方案的连锁影响**：

痛点 2 的**结论**（expand 层 toolResult brief 信息不足、不知是哪个工具）仍然成立——但**病因错了**。文档让读者以为是"extractText 对结构化结果返空"，实际 extractText 没问题，真正的问题是"brief 显示的是结果文本前 100 字符，不含工具名/参数维度"。这会误导实现者：以为要改 extractText（去适配结构化结果），实际要改的是 entryBrief（给 toolResult 加工具名+参数摘要，即 O2）。

**修复方向**：
- §2.1 expand 示例改为真实输出：`[2] toolResult "src/stores/todo.ts:12: const cache = new We..."`（结果文本前 100 字符）。
- 病因改为："brief 显示结果文本，但不含工具名/参数/规模维度，agent 不知这个结果来自哪个工具、参数是什么"。

### M3 D1 工具表缺 4 个真实工具，未知工具的类型化摘要 fallback 未定义

**证据（probe 019e6c96 真实工具全集）**：

| 工具 | 次数 | arguments 字段 | D1 是否覆盖 |
|---|---|---|---|
| bash | 309 | command, timeout | ✅（但漏 timeout） |
| read | 64 | path, limit, offset | ✅ |
| edit | 43 | edits, path | ✅ |
| subagent | 42 | task, taskComplexity, agent, cwd, background | ✅（但只列 task） |
| write | 25 | path, content | ✅ |
| **todo** | **15** | **action, id, status**（非 path！） | ❌ |
| **coding-workflow-gate** | **15** | phase | ❌ |
| **coding-workflow-phase-start** | 4 | — | ❌ |
| **coding-workflow-init** | 1 | slug | ❌ |
| head | 1 | path, limit | ✅ |

D1 表列 6 个工具，**实测漏 4 个**（todo / coding-workflow-gate / coding-workflow-init / coding-workflow-phase-start），合计 **35/519 ≈ 6.7%** 的 toolCall。其中 todo 的 arguments 是 `{action, id, status}`（操作类，非文件），coding-workflow-* 是 `{phase}/{slug}`，D1 的"取 path basename"或"取 command"格式都不适用。

**对方案的连锁影响**：

O2 类型化摘要 + O4 extract commands 实现时，遇到这 6.7% 的工具**无规则可循**。文档 §3.3 F8 错误规格只覆盖 extract 的"tool 过滤无匹配"，没覆盖 expand/detail 渲染时"遇到 D1 未列工具怎么办"。不同 session 的工具集不同（xyz-agent 场景常出现 cw/todo/skill 相关工具），遗漏比例不固定。

**修复方向**：
- D1 表补全真实工具（至少 todo、coding-workflow-*），给出各自摘要格式（如 `todo: <action>(<id>)`、`coding-workflow-gate: phase=<phase>`）。
- 定义**未知工具 fallback 规则**：如 `toolname: <arguments JSON 前 N 字符>`，确保任何工具都有确定的摘要输出。
- O4 extract commands / files 同步评估：files 预设对无 path 的工具如何处理（见 S4）。

---

## Suggestion 详述

### S1 V-callcount 的 v1 基线"5 次"来源未锚定

**现状**：V-callcount 写"v1 是 5 次 → v2 ≤2 次"。但"5 次"来自背景里"一份 agent 分析报告"，§2.4 的调用链是构造示例还是真实记录未标注，没有固定任务描述（哪个 session、什么任务、从哪开始）。可复现性存疑。

**改进**：锚定基线——固定一个任务（如"不用看代码，仅凭 session-reader 总结 019e6c96 的 plugin 架构决策"），实际跑 v1 记录真实调用链（哪 5 次、每次返回什么），作为 v2 对比的同一任务基准。否则"5→2"是不可证伪的。

### S2 V3 阈值 600→1500 推翻 v1 已验收目标，tradeoff 未量化

**现状**：v1 V3 实测 outline 506 token 通过（对比 read 一次 <5%，M5 已验收）。v2 加 assistantBrief 后 outline 预估 ~1100-1300，**相对 v1 翻倍**。D4 用"用户已确认 1000 多 token 可接受"一句话带过。

**改进**：D4 量化 tradeoff——"多 ~700 token outline vs 省 3 次 expand/detail 调用（每次重复输出 user+assistant 文本，远超 700 token）"。v2 验收建议保留 v1 的"vs read"对比口径（V-callcount 间接体现），但 outline 单独 token 效率相对 v1 退化应明确披露，不要让读者以为 v2 在 token 上也是进步。

### S3 P-no-tr-id 标 ✅ 但 probe 看错层级

**现状**：§3.3 P-no-tr-id 标 ✅"已 probe：toolResult content 只 `[{type,text}]`"。content 层级结论对，但它推出的"无 id 关联"结论应用到了 message 层级（toolCallId），probe 根本没查 message 层级。这是探针不诚实（准则 7）——标了 ✅ 给人"已验证"的假象，实际验证的是错的字段。

**改进**：P-no-tr-id 应改为"toolResult.message.toolCallId 存在（515/515 probe），可精确关联 assistant content toolCall.id"，状态从"无 id 关联"翻转为"有 id 关联"。这条与 M1 是同一事实的两面——M1 修方案，S3 修探针记录。

### S4 extract files 预设未说明非文件工具的处理

**现状**：D3 files 预设"toolCall arguments 的 path 字段（read/edit/write/head）"。todo（action/id/status）、coding-workflow-*（phase/slug）、subagent（task）都无 path，不纳入 files。这可能是预期（files = 文件），但文档未明说"只覆盖文件类工具"。

**改进**：files 预设明确 scope（"仅含 path 参数的文件类工具"），或新增 `operations`/`actions` 预设覆盖非文件操作（让 agent 也能一次抽出"所有 todo 操作 / 所有 cw gate 调用"）。

### S5 F9 预算单位与 V-o1 不一致

**现状**：F9 用"4KB 预算"截断，V-o1 用"1500 token"。字节与 token 混用，实现者和读者都要心算换算（4KB ≈ 1000 token）。

**改进**：统一预算单位（都用 token，或都用字节并注明 ≈ 换算），避免同一文档两套预算口径。

### S6 extract commits 正则会误匹配 uuid v7

**现状**：D3 commits 预设"扫所有 text + toolResult content 的 `[0-9a-f]{7,40}`"。uuid v7（pi session id 就是）形如 `019e6c96-0a0c-74b8-a73f-d1854d88e2a7`，连字符分隔出 8/4/4/4/12 位的十六进制段，全部会被 `[0-9a-f]{7,40}` 命中——一个 uuid 产生 2-3 个假 commit。更糟的是，pi session id 的前 8 位（如 `019e6c96`）和 git short hash（默认 7 位）几乎无法仅凭十六进制区分。

**改进**：文档标了 ⛔ P-extract-commits 是诚实的，但方案 robustness 存疑。建议实现时限定长度（7-8 位 git short hash）+ 上下文消歧（前后有 `feat:`/`fix:`/`commit` 等关键词，或来自 bash `git log`/`git commit` 的 toolResult），或明确接受"会有 uuid 噪音"并在输出标注置信度。

---

## 通过项（站得住的部分）

为平衡对抗视角，记录核实**通过**的部分：

- **toolSummary bug 论断**（§2.3）：真实存在，render.ts:117 读 `msg.toolCalls`，实测 0/563 assistant 有该字段。
- **D1 工具调用提取源 = content blocks type:toolCall**（D1 前半）：probe 确认 519 个 toolCall 全在 content blocks，带 {id, name, arguments}。
- **O1/O3/O4 的因果链**：O1（outline 加 assistantBrief + 修 bug）→ 目标 1 可决策，成立；O3（detail 默认摘要）→ 解决条目消失，成立；O4（extract）→ 目标 4 按类型提取，成立，与 search 边界清晰（§3.2 O4 否决 B 合理）。
- **方案对比充分性**（P0-7/8/9）：每个 O 都 ≥2 方案 + 三栏（长期架构/短期成本/风险）+ 明确推荐 + 被否方案"若用它例子会怎样"。结构达标。
- **五段骨架 / 结论先行 / 无 delta 链**（P0-1/2/3）：齐全，正文自包含。
- **F7-F9 错误恢复指引**（P0-18）：都有 👉 具体恢复动作。
- **被否"语义 summary action"**：架构层判断准确（session-reader 是纯逻辑工具不调 LLM），extract 定位正确。
