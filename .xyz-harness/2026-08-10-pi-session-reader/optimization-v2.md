# session-reader v2 优化设计：信噪比提升

> **一句话结论**：v1 的三级渐进骨架方向对，但每级信噪比偏低，导致 agent 为看懂一个 session 平均调用 5 次、每次重复消费，与"省 token"目标矛盾。v2 通过 4 个改动让每一级单独看就够做决策，把 90% 场景的调用压到 1-2 次。

> **层声明**：当前层 = session-reader 工具的接口/输出格式优化设计；下一层 = 代码实现（render/tool-handler 改动 + extract action）。下一层产物性质 = 可实现的接口/格式调整，准则 5/6/7 全适用。

> **基线**：本文基于已实现的 session-reader（`extensions/session-reader/`，M1-M5 完成，124 测试绿）。读者无需读 design.md——本文 §1 补足认知，§2 展示真实输出（取自代码与实测，不编造）。

---

## §1 背景目标

**SCQA**

- **S（情境）**：session-reader 是 pi extension，提供 `session_read` 工具（7 个 action：find/family/outline/expand/detail/search/export），让 agent 按语义结构渐进精读历史 session——`outline`（turn 级目录）→ `expand`（单轮 entry 列表）→ `detail`（turn 全文）。设计目标是省 token（避免 agent 用 `read` 读原始 JSONL）。
- **C（冲突）**：实际 agent 使用暴露信噪比问题——三级粒度本质是嵌套包含（outline ⊂ expand ⊂ detail），但每级全量返回且信息层层缺失，agent 为看懂一个 turn 要连续调用 outline→expand→detail，每次重复输出上一级已给过的内容。一次"看懂这个 session 干了什么"调用了 5 次工具，与"省 token"矛盾。
- **Q（问题）**：怎么让每一级单独看就够做决策，而不是"为省 token 先砍光、逼 agent 再展开"？
- **A（答案）**：4 个改动——① outline 加回 assistant 结论行 + 修复 toolSummary 既有 bug；② expand/detail 的 toolResult 改类型化摘要（`bash: <cmd> (N行)`）；③ detail 默认给 toolResult 摘要态（不再整条消失）；④ 新增 `extract` action（按角色/类型跨 turn 提取）。把 90% 场景压到 1-2 次调用。

**设计目标**

1. **每一级单独可决策**：outline 扫一眼能判断点哪轮（含 assistant 结论）；expand 一眼判断要不要 detail（toolResult 有类型+规模）；detail 不丢条目（toolResult 有摘要态）。
2. **调用次数 ↓**：典型"看懂一个 session"从 5 次 → 1-2 次。
3. **toolResult 有中间态**：不全展开也不整条消失，给"工具名 + 参数 + 规模"让 agent 低成本判断。
4. **按类型提取**：新增 extract，一次抽出所有 user 消息 / 命令 / 文件 / commit hash / tool 结果。

**Scope**

- **in**：render 层输出格式（outline/expand/detail）+ tool-handler 新增 extract action + 修复 toolSummary 既有 bug。
- **out**：不改 parser/tree/turns/discovery 核心逻辑；不改架构（不引入 LLM 语义总结——见 §3.2 被否方案）；不改 find/family/search/export 现有行为。

---

## §2 现状与问题分析

### 2.1 真实输出（取自 019e6c96，1204 entry / 26 user / 563 assistant / 515 toolResult / 32 turn）

**outline（当前）**——每行 = `T编号 · userBrief(60字) · toolSummary · [omitted]`：

```
T000 · 03:17 · 帮我分析 plugin 架构，设计新的插件系统 · [12KB omitted]
T001 · 03:18 · 探索现有 plugin 实现 · [48KB omitted]
...
```

**问题**：没有 assistant 结论行。agent 只看到 user 说了什么 + 省略了多少字节，**不知道每轮得出了什么**，被迫逐个 expand。且 `toolSummary` 字段（设计要显示 `bash×2,read×1`）**实际永远是空的**——见 2.3 既有 bug。

**expand（当前）**——单轮 entry 列表，每条 brief = text 前 100 字符：

```
T010 (16 entries, started 04:22)
  [0] user      "继续优化 todo goal 的存储层"
  [1] assistant "我来分析当前的实现..."           ← thinking 已剥离
  [2] toolResult [tool result]                    ← 结构化结果 extractText 返空，只剩占位
  [3] assistant  "问题是 WeakMap 被 ajv 强引用"
  ...
```

**问题**：toolResult 只剩 `[tool result]`（结构化内容 `extractText` 返空）。agent 不知道这个结果是什么工具产生的、规模多大，只能再 detail。

**detail（当前）**——默认 `includeToolResult:false` → toolResult entry **整条 `continue` 跳过**：

```
detail T010 → 只剩 9 条（16 - 7 个 toolResult = 9），无任何占位提示
```

**问题**：条目数从 16 莫名变 9，agent 以为没看全又调一次。toolResult 默认彻底消失，没有中间态。

### 2.2 五条痛点（经代码核实，非转述）

| # | 痛点 | 核实结论 |
|---|---|---|
| 1 | outline 无 assistant 结论，信息断层逼反复 expand | ✅ 成立。`render.ts:236` 注释明写"L1 行不含 assistantBrief"，`formatLine` level 0/1 都不输出。这是 design §3.5 的硬决策，代价就是信息断层 |
| 2 | outline 首句截取对 skill/代码/日志开头的 turn 失效 | ✅ 成立。`userBrief` 取 user text 前 60 字符（`render.ts:196`），固有限制 |
| 3 | detail 的 `Use offset=N to continue` 提示接不上参数 | ❌ **误解**。grep 全代码无此文案——session-reader 根本不分页、无 offset 参数。该提示是 **pi 内置 `read` 工具**的（agent 用 read 读 export 文件时看到）。但暴露真实限制：detail 不分页，大 turn 一次全返回 |
| 4 | 无按角色/类型提取（只能按 turn 切 + search grep） | ✅ 成立。search 是全文 grep，不能"抽所有 user 消息 / 所有 bash 命令" |
| 5 | toolResult 省略粒度二元（整条跳过 vs 全展开），无中间态 | ✅ 成立。detail 默认 `continue` 跳过，`includeToolResult:true` 全展开 |

### 2.3 既有 bug：toolSummary 从未工作（本次设计顺带修）

**probe 实测**（019e6c96 全量 1204 entry）：

```
assistant content block 类型分布: { thinking:255, toolCall:519, text:254 }
assistant with message.toolCalls:  0      ← toolCalls 字段根本不存在
工具调用位置: assistant content blocks 的 type:"toolCall" block
toolCall block 结构: { type:"toolCall", id:"call_xxx", name:"bash", arguments:{...} }
```

**bug**：`render.ts` 的 `entryToolCallNames` 读 `msg.toolCalls`（`render.ts:118`），但 pi 的工具调用在 `content` blocks 的 `type:"toolCall"`，`message.toolCalls` 字段**从未存在**。结果：outline 的 toolSummary（`bash×2,read×1`）**永远是空串**，v1 全程没工作过。

**影响**：v2 的 O1 必须修这个——从 content blocks 提取 toolCall，否则加 assistantBrief 后 outline 仍缺工具维度。

### 2.4 物理数据流：agent 调用链的重复消费

```
agent 目标: 看懂 019e6c96 干了什么
  │
  ├─ find e6c96          → 1 个 session（定位）
  ├─ outline             → 32 行 turn 目录（无 assistant 结论，不知点哪轮）
  ├─ expand T001         → 16 entry（toolResult 是 [tool result]，不知是啥）
  ├─ expand T010         → 同上
  ├─ detail T010         → 9 entry（7 个 toolResult 消失，以为没看全）
  ├─ detail T010 +includeToolResult → 16 entry 全文（重复了前 9 条 + 7 个 toolResult 全展开）
  └─ (5-6 次调用，detail T010 的 user/assistant 文本被输出了 3 遍)
```

**根因**：三级嵌套包含 + 每级全量返回 + 信息层层缺失 = 渐进变成"必须连点 3 下才看到有用信息"，重复消费反而比一次给全文更费。v2 要让每一级单独可决策，打断这个重复链。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**outline（v2）**——加 assistant 结论行 + 修复 toolSummary：

```
T000 · 03:17 · 帮我分析 plugin 架构，设计新插件系统 · bash×1 · → 分析了 3 个 ADR，建议元数据驱动方案
T001 · 03:18 · 探索现有 plugin 实现 · bash×3,read×2 · → 发现 PluginService 是唯一适配层，但有 4 处硬编码
T010 · 04:22 · 继续优化 todo goal 存储层 · bash×2,edit×3 · → WeakMap 被 ajv 强引用击败，改用 Map 分区
...
```

agent 扫一眼就能判断点哪轮（有 user 意图 + 工具 + assistant 结论），不必逐个 expand。

**expand（v2）**——toolResult 类型化摘要：

```
T010 (16 entries, started 04:22)
  [0] user       "继续优化 todo goal 的存储层"
  [1] assistant  "我来分析当前的实现..."
  [2] toolResult bash: grep -rn "WeakMap" src/ (48 行)
  [3] assistant  "问题是 WeakMap 被 ajv 强引用"
  [4] toolResult read: src/stores/todo.ts (12KB)
  [5] toolResult edit: src/stores/todo.ts (3 blocks)
  ...
```

agent 一眼看到每个 toolResult 是什么工具、什么参数、多大规模，判断要不要 detail 全文。

**detail（v2 默认）**——toolResult 摘要态（不消失）：

```
detail T010 → 16 entries 齐全
  ...
  [2] toolResult bash: grep -rn "WeakMap" src/
       │ 共 48 行，前 3 行：
       │   src/stores/todo.ts:12: const cache = new WeakMap()
       │   src/stores/todo.ts:45: weakRef = cache.get(key)
       │   src/composables/useTodo.ts:8: import { WeakMap } from ...
       │ ...（+ includeToolResult:true 看全文）
  ...
```

条目数不再莫名变少；agent 要全文才加 `includeToolResult:true`。

**extract（v2 新增）**——跨 turn 按类型提取：

```
session_read extract sessionId=019e6c96 what=user-messages
  → [T000] 帮我分析 plugin 架构...
    [T003] 这个方案的依赖注入怎么实现...
    [T010] 继续优化 todo goal 存储层...
    （26 条 user 消息全文，按 turn 排列）

session_read extract sessionId=019e6c96 what=commands tool=bash
  → [T001] find docs -type f | head -50
    [T001] grep -rn "PluginService" src/
    [T010] grep -rn "WeakMap" src/
    （所有 bash 命令，带 turn 来源）

session_read extract sessionId=019e6c96 what=commits
  → [T015] 217d37a37 fix(todo): switch to Map partition
    [T022] a4b8c9d2 feat(plugin): metadata-driven discovery
    （扫出的所有 commit hash + 上下文一行）
```

90% 场景一次调用拿到所需素材（user 意图流 / 命令清单 / 改动文件 / commit 记录），不必逐 turn 展开。

### 3.2 多方案对比

#### O1：outline 加 assistant 结论行 + 修 toolSummary

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（推荐）：formatLine 加 assistantBrief + 降级序调整 + 修 entryToolCallNames 从 content blocks 提取** | outline 信息完整（user 意图 + 工具 + assistant 结论），agent 扫一眼可决策；token 上升是可接受代价（用户已确认放宽） | 中：改 `formatLine`（level 0 加 assistantBrief）+ `entryToolCallNames`（content blocks）+ V3 阈值放宽 | token 从 506 → ~1100-1300，需实测确认 ≤1500（⛔ 探针 P-o1-token） |
| B：维持不含 assistantBrief，只修 toolSummary bug | outline 仍缺 assistant 结论，痛点 1 未解决 | 低 | 低，但核心痛点仍在 |
| C：assistantBrief 作可选参数 `includeAssistantBrief`，默认关 | 灵活但 agent 不会主动加参数，默认仍看不到结论 | 中 | 默认体验不变，等于没改 |

**推荐 A**。若用 B，§2.4 的调用链不变（agent 仍要逐个 expand 看 assistant 结论）。C 的可选参数 agent 默认不传，等于 B。

#### O2：expand/detail 的 toolResult 类型化摘要

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（推荐）：toolResult 摘要 = `toolName: <args 摘要> (规模)`，靠顺序关联前一条 assistant 的 toolCall** | 信息密度最高（工具 + 参数 + 规模一行），agent 判断成本极低 | 中：实现 toolCall→toolResult 顺序关联 + 按工具名提取 args 摘要（bash 取 command、read/edit/write 取 path） | 顺序关联在 fork/branch 跳跃场景可能错位（⛔ 探针 P-o2-order）；需评估 |
| B：toolResult 只显示规模 `[tool result 48 行]`，不关联工具名 | 信息少（不知哪个工具），但无关联风险 | 低 | 低，但 agent 仍要 detail 才知工具 |
| C：toolResult 显示 text 头尾截断（当前 expand 的加强版） | 对结构化/非文本结果仍无效（extractText 返空） | 中 | bash 结果头尾常是文件列表，信息密度不如类型化 |

**推荐 A**。probe 确认 toolCall 在 content blocks 含 `{name, arguments}`（✅ 已测），类型化摘要是纯结构化提取。若用 B，§3.1 expand 终态的 `bash: grep ... (48行)` 退化为 `[48 行]`，agent 仍不知工具。C 对 toolResult（常是结构化）失效。

**顺序关联风险**（P-o2-order）：toolResult entry 无 `tool_use_id`（✅ probe 确认 content 只 `[{type,text}]`），只能靠"assistant toolCall entry 后紧跟 toolResult entry"的顺序。正常 turn 内顺序稳定；fork/compaction 跳跃场景需实测（⛔ O2 实现后跑 019e6c96 全量 expand 核对关联正确率）。

#### O3：detail 默认 toolResult 摘要态

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（推荐）：detail 默认给 toolResult 摘要（O2 类型化 + 头 3 行 + 末 2 行 + 总行数），includeToolResult:true 给全文** | detail 不再"条目消失"，有中间态；agent 用 detail 就是要看全，默认给摘要符合预期 | 中：复用 O2 摘要 + 头尾截断逻辑 | detail 输出变长（但比全展开省很多） |
| B：维持默认跳过，但加占位 `[tool result omitted, includeToolResult:true 展开]` | 条目数对齐了，但不知内容，agent 仍要二次调用 | 低 | 低，但调用次数不降 |
| C：detail 默认全展开 toolResult（去掉开关） | detail 看全，但 token 爆炸（痛点 5 反面） | 低 | 大 turn token 失控 |

**推荐 A**。若用 B，§2.4 的"以为没看全又调一次"变成"看到占位再调一次"，调用次数不降。C 让 detail 退化为"全量 read"，违背省 token 初衷。

#### O4：新增 extract action

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（推荐）：新增 extract action，5 个 what 预设（user-messages/commands/files/commits/tool-results）** | 直接解决痛点 4；90% 场景一次拿素材；每个预设是纯结构化提取（probe 确认可行） | 中：新 action 分发 + 5 个提取函数（从 content blocks / text） | action 数 7→8；extract 无匹配时的错误处理（见 §3.3） |
| B：扩展 search 支持结构化过滤（search role=user / type=toolCall） | search 语义混乱（grep + 结构化过滤混合） | 中 | search 职责膨胀 |
| C：不做，靠 detail 全量 + agent 自行过滤 | 痛点 4 未解决，调用次数不降 | 0 | agent 调用次数不降 |

**推荐 A**。extract 的 5 个预设基于 probe 确认的数据结构（见 §3.3 数据流），纯提取不需 LLM。若用 B，search 从"全文 grep"变成"grep + 结构化查询"，违反单一职责。C 不解决痛点 4。

**被否：语义 summary action（"2-3 句总结 session"）**。这需要 LLM 语义理解，session-reader 是纯逻辑工具（零 pi 依赖、不调 LLM），架构层做不到。工具能做的是"结构化提取素材"（extract），把素材给调用方 agent 让它自己总结——这是 extract 的定位。同理，outline 的"意图标签（侦查/设计/修复）"也被否（语义分类要 LLM）。

### 3.3 关键决策与权衡

**D1：工具调用提取源 = assistant content blocks 的 type:"toolCall"**（不是 message.toolCalls）

probe 确认（✅ 已测 019e6c96）：toolCall 在 `{type:"toolCall", id, name, arguments}`，`message.toolCalls` 从未存在。O1/O2/O4 的所有工具相关提取都以此为源。各工具 arguments 字段（✅ probe）：

| 工具 | arguments 字段 | 类型化摘要格式 |
|---|---|---|
| bash | `{command}` | `bash: <command 前 60 字符>` |
| read | `{path}` | `read: <basename>` |
| edit | `{path, edits}` | `edit: <basename> (N blocks)` |
| write | `{path, content}` | `write: <basename> (NKB)` |
| subagent | `{task, ...}` | `subagent: <task 前 40 字符>` |
| head | `{path, limit}` | `head: <basename> (limit N)` |

**D2：toolResult 与 toolCall 靠顺序关联**（无 id）

probe 确认（✅）：toolResult entry 的 content 是 `[{type:'text',text}]`，**无 tool_use_id/toolCallId 字段**。关联规则：turn 内，assistant entry 的 toolCall block 按出现顺序，对应后续 toolResult entry 按出现顺序。正常 turn 顺序稳定；fork/compaction 场景 ⛔ P-o2-order 实测。

**D3：extract 的 5 个 what 预设**

| what | 提取源 | 输出 |
|---|---|---|
| `user-messages` | `role==='user'` 的 entry text | 按 turn 排列的 user 消息全文 |
| `commands` | assistant content 的 toolCall blocks | `{name, arguments 摘要}` 列表（带 turn 来源 + 可选 tool 过滤） |
| `files` | toolCall arguments 的 path 字段（read/edit/write/head） | 去重文件路径列表（带操作类型） |
| `commits` | 扫所有 text + toolResult content 的 `[0-9a-f]{7,40}` | commit hash + 上下文一行（去重） |
| `tool-results` | `role==='toolResult'` 的 entry text（+ 顺序关联 toolCall.name 可选过滤） | toolResult 文本列表（带 turn 来源 + 工具名） |

**数据流**（extract commands 为例）：

```
session file → parseSessionContent → entries[]
  → 遍历找 role==='assistant' && content 含 type:'toolCall'
  → 提取 {name, arguments} → 按 arguments 字段映射摘要
  → 附 turn 来源（segmentTurns 定位 entry 所属 turn）
  → 可选 tool 过滤 → 输出列表
```

**D4：V3 阈值放宽 600 → 1500 token**

加 assistantBrief（+80 字符/turn × 32 = +640 token）+ 修复 toolSummary（+toolSummary 行，约 +200 token）后，outline 预估 ~1100-1300 token。新阈值定 1500 留余量。⛔ P-o1-token 实测确认。用户已确认"1000 多 token 可接受"。

**错误规格（准则 6，F7-F9 新增）**

| ID | 场景 | 文案 | 恢复指引 |
|---|---|---|---|
| F7 | extract 的 `what` 非法值 | `extract 的 what "xxx" 无效，应为 user-messages/commands/files/commits/tool-results。👉 用合法 what 重试。` | 列举合法值 |
| F8 | extract 无匹配（如 commands tool=nonexist） | `extract what=commands tool="nonexist" 无匹配。该 session 的工具调用有：bash×309,read×64,...。👉 用存在的工具名重试。` | 返回实际工具分布助选 |
| F9 | extract 结果过大超预算 | `extract what=user-messages 结果 8500 字节超 4KB 预算，已截断到 T000-T018（18/26）。👉 缩小范围用 turns=T000-T009 或换 what=commands 重试。` | 给截断位置 + 缩小建议 |

**探针清单（准则 7）**

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-toolcall-src | 工具调用在 content blocks type:toolCall（非 message.toolCalls） | ✅ 已 probe 019e6c96：toolCall 519 个在 content，toolCalls 0 | ✅ |
| P-args-fields | 各工具 arguments 字段名 | ✅ 已 probe：bash/read/edit/write/subagent/head 字段确认 | ✅ |
| P-no-tr-id | toolResult 无 tool_use_id 关联 | ✅ 已 probe：toolResult content 只 `[{type,text}]` | ✅ |
| P-o1-token | outline 加 assistantBrief + toolSummary 后 token ≤1500 | ⛔ O1 实现后实测 019e6c96 outline | ⛔ |
| P-o2-order | toolCall→toolResult 顺序关联正确率 | ⛔ O2 实现后跑 019e6c96 全量 expand 抽样核对 | ⛔ |
| P-extract-commits | commit hash 正则不误匹配（uuid/十六进制地址） | ⛔ O4 实现后核对（uuid v7 含十六进制，需区分 git short hash 7-8 位） | ⛔ |

---

## §4 验收（真实场景，非单测）

> 依赖：全部用本机真实 session（`~/.pi/agent/sessions/`），`019e6c96`（32 turn / 1204 entry / 519 toolCall）为主样本。单测作回归辅助，不计入验收。

| ID | 回溯目标 | 场景 | 步骤 | 通过标准 |
|---|---|---|---|---|
| V-o1 | 目标 1（每级可决策） | outline 含 assistant 结论 + toolSummary 修复 | 对 019e6c96 跑 outline | ① 每行含 assistant 结论（非空）② toolSummary 显示 `bash×N` 等真实工具（不再全空）③ token ≤1500（P-o1-token） |
| V-o1-decision | 目标 1 | agent 只看 outline 能否判断"哪轮在改 todo 存储" | 给 agent outline 输出，问"哪轮改了 WeakMap" | agent 指向 T010（assistantBrief 含"WeakMap/Map 分区"），无需 expand |
| V-o2 | 目标 3（中间态） | expand toolResult 类型化摘要 | 对 019e6c96 跑 expand T010 | toolResult 行显示 `bash: <cmd> (N行)` / `read: <path>` 等（非 `[tool result]`）；P-o2-order 关联正确率 ≥95% |
| V-o3 | 目标 1 | detail 默认 toolResult 摘要态 | 对 019e6c96 跑 detail T010 | ① 条目数 = 16（不再变 9）② toolResult 有摘要（工具名 + 头尾 + 行数）③ `includeToolResult:true` 仍给全文 |
| V-o4-user | 目标 4（按类型提取） | extract user-messages | `extract 019e6c96 what=user-messages` | 返回 26 条 user 消息全文，按 turn 排列 |
| V-o4-cmd | 目标 4 | extract commands tool=bash | `extract 019e6c96 what=commands tool=bash` | 返回所有 bash 命令（309 条或按预算截断），带 turn 来源 |
| V-o4-files | 目标 4 | extract files | `extract 019e6c96 what=files` | 返回去重文件路径列表（read/edit/write 涉及的），带操作类型 |
| V-o4-commits | 目标 4 | extract commits | `extract 019e6c96 what=commits` | 返回 commit hash 列表（P-extract-commits 不误匹配 uuid） |
| V-callcount | 目标 2（调用次数 ↓） | "看懂这个 session 干了什么"全流程 | agent 完成任务，统计 session_read 调用次数 | ≤2 次（v1 是 5 次）；对比 v1 同任务调用链 |
| V-regress | 回归 | v1 既有功能不破坏 | find/family/outline(旧字段)/expand/detail(含 includeToolResult)/search/export 全跑 | 行为与 v1 一致（assistantBrief/toolSummary 是新增，不破坏旧字段消费） |

**失败场景验收（F7-F9）**：故意给非法 what / 不存在的 tool / 超大结果，确认返回 👉 恢复指引且不抛异常（agent 可据指引一次重试成功）。

---

## §5 下一层拆分

按依赖序 4 个单元，每个独立可验收。

| # | 单元 | 内容 | justification | 验收映射 |
|---|---|---|---|---|
| O1 | **outline assistantBrief + toolSummary 修复** | `render.ts`：① `entryToolCallNames` 改从 content blocks 提取 toolCall（修 bug）② `formatLine` level 0 加 assistantBrief ③ 降级序调整（预算不足砍 assistantBrief→toolSummary）④ V3 阈值 600→1500 | 修既有 bug + 补信息断层，是其他优化的基础（toolCall 提取逻辑 O2/O4 复用） | V-o1 / V-o1-decision / V-regress |
| O2 | **expand/detail toolResult 类型化摘要** | `render.ts`：① 新增 toolCall→toolResult 顺序关联（turn 内）② `entryBrief` 对 toolResult 改类型化摘要（按 D1 字段映射） | 解决痛点 5（中间态）+ 痛点 1 的 expand 层 | V-o2 |
| O3 | **detail 默认摘要态** | `render.ts`：`renderDetail` 默认对 toolResult 渲染摘要（O2 摘要 + 头 3 行 + 末 2 行 + 总行数），不再 `continue` 跳过；`includeToolResult:true` 给全文 | 解决"条目莫名消失"，detail 符合"看全"预期 | V-o3 |
| O4 | **extract action** | `tool-handler.ts`：① action 分发加 extract ② 5 个 what 预设提取函数（D3）③ F7-F9 错误规格 ④ TypeBox schema 扩展 | 解决痛点 4，压缩 90% 场景调用 | V-o4-* / V-callcount |

**文件改动地图**：
- `extensions/session-reader/src/core/render.ts`：O1（entryToolCallNames + formatLine + 降级序）+ O2（entryBrief toolResult 类型化 + 顺序关联）+ O3（renderDetail 摘要态）
- `extensions/session-reader/src/tool-handler.ts`：O4（extract action 分发 + 5 提取函数 + F7-F9）+ outline/expand/detail 的渲染调用微调
- `extensions/session-reader/src/__tests__/`：render.test.ts（O1-O3 回归）+ tool-handler.test.ts（O4 extract 用例）
- `.xyz-harness/2026-08-10-pi-session-reader/design.md`：§3.4 加 extract action schema + §3.5 算法 1 补 assistantBrief/toolSummary 修复 + §4 V3 阈值更新

**待验证检查点（实施期门）**：P-o1-token / P-o2-order / P-extract-commits（见 §3.3 探针清单），对应单元实现后必须实跑通过。

---

## 附录：v1 → v2 变更摘要

- outline：+ assistantBrief 行 / + toolSummary 修复（既有 bug）/ V3 阈值 600→1500
- expand：toolResult brief `[tool result]` → `bash: <cmd> (N行)` 类型化
- detail：toolResult 默认 `continue` 跳过 → 摘要态（头尾 + 行数）；条目数不再变少
- 新增 extract action（5 个 what 预设）
- 新增 F7-F9 错误规格
- 既有 bug 修复：entryToolCallNames 读错字段（message.toolCalls → content blocks type:toolCall）
