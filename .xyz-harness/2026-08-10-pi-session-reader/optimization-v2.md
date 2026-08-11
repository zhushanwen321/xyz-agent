# session-reader v2 优化设计：信噪比提升 + 引用唯一性

> **一句话结论**：v1 的三级渐进骨架方向对，但每级信噪比偏低（agent 看懂一个 session 平均调 5 次）+ `#` 8 字符片段碰撞率 26.5%（引用不唯一）。v2 通过 5 个改动让每级单独可决策、`#` 引用永远唯一，把 90% 场景调用压到 1-2 次。

> **层声明**：当前层 = session-reader 工具的接口/输出格式优化设计；下一层 = 代码实现。下一层产物 = 可实现的接口/格式调整，准则 5/6/7 全适用。

> **基线**：基于已实现的 session-reader（`extensions/session-reader/`，M1-M5 完成，124 测试绿）。读者无需读 design.md——本文 §1 补足认知，§2 展示真实输出（取自代码与实测）。

> **审查修正记录**：初版 D2 基于一个看错层级的 probe（只查 content block，漏看 `message.toolCallId`/`toolName`），错误声称"toolResult 无 id 只能靠顺序关联"。经对抗式审查用真实数据推翻（515/515 toolResult 带 toolCallId）。本文已修正，教训见附录。

---

## §1 背景目标

**SCQA**

- **S（情境）**：session-reader 是 pi extension，提供 `session_read` 工具（7 action：find/family/outline/expand/detail/search/export）+ TUI `#` 引用补全，让 agent 按语义结构渐进精读历史 session——`outline`（turn 目录）→ `expand`（单轮 entry 列表）→ `detail`（turn 全文）。设计目标是省 token。
- **C（冲突）**：实际 agent 使用暴露两类问题——① **信噪比低**：三级粒度嵌套包含但每级信息缺失，agent 看懂一个 turn 要 outline→expand→detail 连调，每次重复消费（一次任务调 5 次）；② **`#` 引用不唯一**：8 字符 uuid 片段碰撞率 26.5%，`#019fea0e` 对应 2 个不同 session，agent 拿它 find 触发多匹配。
- **Q（问题）**：怎么让每级单独可决策 + `#` 引用永远唯一？
- **A（答案）**：5 个改动——① outline 加 assistant 结论行 + 修 toolSummary 既有 bug；② expand/detail 的 toolResult 改类型化摘要（用 toolResult 自带的 toolName + toolCallId 关联取参数）；③ detail 默认给 toolResult 摘要态；④ 新增 `extract` action（按类型提取）；⑤ `#` 补全碰撞时自动延长片段到唯一。

**设计目标**

1. **每级单独可决策**：outline 扫一眼判断点哪轮（含 assistant 结论）；expand 一眼判断要不要 detail；detail 不丢条目。
2. **调用次数 ↓**：典型任务从 5 次 → 1-2 次。
3. **toolResult 有中间态**：给"工具名 + 参数 + 规模"，不全展开也不消失。
4. **按类型提取**：extract 一次抽出 user 消息 / 命令 / 文件 / commit / tool 结果。
5. **`#` 引用唯一**：碰撞时自动延长片段，agent 拿 `#` 片段 find 永不触发多匹配。

**Scope**

- **in**：render 层输出格式（outline/expand/detail）+ tool-handler 新增 extract + 修 toolSummary bug + tui/hash-provider `#` 唯一性。
- **out**：不改 parser/tree/turns/discovery 核心逻辑；不引入 LLM 语义总结（见 §3.2 被否）；不改 find/family/search/export 现有行为。

---

## §2 现状与问题分析

### 2.1 真实输出（取自 019e6c96，1204 entry / 26 user / 563 assistant / 515 toolResult / 32 turn）

**outline（当前）**——每行 = `T编号 · userBrief(60字) · toolSummary · [omitted]`：

```
T000 · 03:17 · 帮我分析 plugin 架构，设计新插件系统 · [12KB omitted]
T001 · 03:18 · 探索现有 plugin 实现 · [48KB omitted]
```

**问题**：没有 assistant 结论行。且 `toolSummary`（设计要显示 `bash×2,read×1`）**实际永远空**——见 2.3 既有 bug。agent 只看到 user 说了什么 + 省略多少字节，不知每轮结论。

**expand（当前）**——单轮 entry 列表，toolResult 的 brief = 结果文本前 100 字符：

```
T010 (16 entries, started 04:22)
  [0] user      "继续优化 todo goal 的存储层"
  [1] assistant "我来分析当前的实现..."
  [2] toolResult "src/stores/todo.ts:12: const cache = new WeakMap()..."   ← 结果文本前 100 字
  [3] assistant "问题是 WeakMap 被 ajv 强引用"
```

**问题**：toolResult brief 是**结果文本**（不是 `[tool result]` 占位——extractText 对 `[{type:'text'}]` 返非空，实测 515/515），但**不含工具维度**：agent 不知这个结果来自 bash/read/edit 哪个工具、参数是什么、规模多大。

**detail（当前）**——默认 `includeToolResult:false` → toolResult entry **整条 `continue` 跳过**：

```
detail T010 → 只剩 9 条（16 - 7 个 toolResult），无占位提示
```

**问题**：条目数莫名变少，agent 以为没看全又调一次。

### 2.2 痛点清单（经代码 + 实测核实）

| # | 痛点 | 核实结论 |
|---|---|---|
| 1 | outline 无 assistant 结论，逼反复 expand | ✅ `render.ts:236` 注释明写"L1 行不含 assistantBrief"，formatLine level 0/1 都不输出 |
| 2 | expand 的 toolResult brief 不含工具维度 | ✅ brief 是结果文本前 100 字（非空），但不知工具名/参数/规模 |
| 3 | detail 默认整条跳过 toolResult，条目数莫名变少 | ✅ `renderDetail` 对 toolResult `continue` 跳过，无占位 |
| 4 | 无按角色/类型提取，只能按 turn 切 + search grep | ✅ search 是全文 grep，不能抽"所有 user 消息 / 所有 bash 命令" |
| 5 | toolResult 无中间态（整条跳过 vs 全展开） | ✅ detail 二元：默认 `continue` / `includeToolResult:true` 全展开 |
| 6 | `#` 8 字符片段碰撞，引用不唯一 | ✅ **实测碰撞率 26.5%**（见 2.5）|

### 2.3 既有 bug：toolSummary 从未工作（O1 顺带修）

**probe 实测**（019e6c96 全量）：工具调用在 assistant content blocks 的 `{type:"toolCall", id, name, arguments}`（519 个），`message.toolCalls` 顶层字段**从未存在**（0/563）。

**bug**：`render.ts:117` 的 `entryToolCallNames` 读 `msg.toolCalls`，恒返 `[]`，outline 的 toolSummary 恒空串，v1 全程没工作过。

### 2.4 物理数据流：agent 调用链的重复消费

```
agent 目标: 看懂 019e6c96 干了什么
  ├─ find e6c96 → 1 session
  ├─ outline → 32 行（无 assistant 结论，不知点哪轮）
  ├─ expand T001 → toolResult 是结果文本，不知哪个工具
  ├─ detail T010 → 9 条（7 个 toolResult 消失）
  ├─ detail T010 +includeToolResult → 16 条全文（重复前 9 条）
  └─ (5-6 次调用，detail 的 user/assistant 文本输出 3 遍)
```

**根因**：三级嵌套包含 + 每级全量返回 + 信息层层缺失 = 渐进变成"连点 3 下才见有用信息"，重复消费比一次给全文更费。

### 2.5 `#` 片段碰撞（痛点 6，实测）

**probe**（扫 `~/.pi/agent/sessions` 全部 3486 session，按 uuid 前 8 字符分组）：

| 指标 | 数据 |
|---|---|
| 总 session | 3486 |
| 8 字符前缀碰撞 | **329 个前缀 / 926 个 session（26.5%）** |
| 最严重 | `019e9680` 19 个、`019e970f` 16 个、`019eb527` 9 个 |
| `019fea0e` | 2 个：`-c0cb...`（feat-optimize-ui）+ `-378e...`（当前 worktree）|

**根因**：uuid v7 前 32 位是毫秒时间戳，8 字符 hex = 完整时间戳。密集开发期同秒创建的 session 前缀重合。FRAGMENT_LEN=8 的唯一性假设失败。

**影响链**：`#019fea0e` 插入 8 字符 → agent 用它 `find` → F2 多匹配（2 个）→ 卡住。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**outline（v2）**——加 assistant 结论 + 修复 toolSummary：

```
T000 · 03:17 · 帮我分析 plugin 架构 · bash×1 · → 分析了 3 个 ADR，建议元数据驱动方案
T010 · 04:22 · 继续优化 todo goal 存储层 · bash×2,edit×3 · → WeakMap 被 ajv 强引用，改用 Map 分区
```

**expand（v2）**——toolResult 类型化摘要（用 toolName + toolCallId 关联取参数）：

```
T010 (16 entries)
  [2] toolResult bash: grep -rn "WeakMap" src/ (48 行)
  [4] toolResult read: src/stores/todo.ts (12KB)
  [5] toolResult edit: src/stores/todo.ts (3 blocks)
```

**detail（v2 默认）**——toolResult 摘要态（不消失）：

```
[2] toolResult bash: grep -rn "WeakMap" src/
     │ 共 48 行，前 3 行：...
     │ ...（+ includeToolResult:true 看全文）
```

**`#` 补全（v2）**——碰撞时延长片段到唯一：

```
用户输入 #019fea0e → 补全列表（2 个，preview 区分）：
  019fea0e-c  读取 pi session 的 extension 设计    ← insertText "#019fea0e-c"（延长到第 10 位唯一）
  019fea0e-3  settings provider 删除 bug 排查     ← insertText "#019fea0e-3"
选中 → 插入唯一片段 → agent find 永不 F2
```

**extract（v2 新增）**——跨 turn 按类型提取：`extract what=user-messages` 给所有 user 消息；`what=commands tool=bash` 给所有 bash 命令；`what=files` 给改动文件；`what=commits` 给 commit hash。

### 3.2 多方案对比

#### O1：outline 加 assistant 结论行 + 修 toolSummary

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **A（推荐）：formatLine 加 assistantBrief + entryToolCallNames 改读 content blocks + V3 阈值 600→1500** | 信息完整可决策 | 中 | token 506→~1100-1300（⛔ P-o1-token） |
| B：只修 toolSummary，不加 assistantBrief | 痛点 1 未解决 | 低 | 低 |
| C：assistantBrief 作可选参数默认关 | agent 不主动加参数，默认无效 | 中 | 等于 B |

**推荐 A**。B 的 outline 仍缺结论，C 的可选参数 agent 默认不传。

#### O2：expand/detail 的 toolResult 类型化摘要

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **A（推荐）：toolResult 摘要 = `toolName: <args 摘要> (规模)`，用 toolResult 自带 toolName + toolCallId 关联取参数** | by construction 精确（toolName/toolCallId 实测 515/515 存在） | 中 | 无顺序依赖风险 |
| B：只显示规模 `[tool result 48 行]` 不关联工具名 | 不知哪个工具 | 低 | 低 |
| C：结果文本头尾截断 | 对长结果信息密度不如类型化 | 中 | 低 |

**推荐 A**。probe 确认 toolResult 自带 `message.toolName`（515/515）+ `message.toolCallId`（515/515 全部匹配 toolCall.id）——用 toolName 直接得工具名，用 toolCallId 关联 toolCall 取 arguments（如 bash 的 command）。**无顺序依赖**（修正初版错误）。

#### O3：detail 默认 toolResult 摘要态

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **A（推荐）：detail 默认给摘要（O2 摘要 + 头 3 行 + 末 2 行 + 总行数），includeToolResult:true 全文** | detail 不丢条目，有中间态 | 中 | 输出变长但比全展开省 |
| B：维持跳过但加占位 | 条目数对齐但不知内容，仍要二次调用 | 低 | 低 |
| C：默认全展开 | token 爆炸 | 低 | 大 turn 失控 |

**推荐 A**。

#### O4：新增 extract action

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **A（推荐）：新增 extract，5 预设（user-messages/commands/files/commits/tool-results）** | 解决痛点 4，90% 场景一次拿素材 | 中 | action 7→8 |
| B：扩展 search 支持结构化过滤 | search 语义混乱 | 中 | 职责膨胀 |
| C：不做 | 痛点 4 未解决 | 0 | 调用次数不降 |

**推荐 A**。extract 预设基于 probe 确认的数据结构（见 D3），纯提取不需 LLM。B 让 search 职责混乱，C 不解决痛点。

#### O5：`#` 补全碰撞时延长片段到唯一

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **A（推荐）：findSessions 多匹配时，每个 match 的 insertText 动态算唯一前缀（字符级 LCP+1，保留连字符）** | `#`→find 链路永远唯一；正常 8 字符，碰撞延长 | 中 | 无 |
| B：永远插入完整 uuid（`#`+36 字符） | 永远唯一但冗长，正常 session 也被迫 36 字符 | 低 | 低 |
| C：维持 8 字符，靠 find F2 提示重试 | 26.5% session 都要走多匹配回路 | 0 | 体验差 |

**推荐 A**。碰撞时 insertText 从 `#019fea0e` 延长到 `#019fea0e-c`（第 10 位区分），findSessions 子串匹配 `019fea0e-c` 唯一命中。正常 session 仍是 8 字符。

**被否：语义 summary action（"2-3 句总结"）+ outline 意图标签（侦查/设计/修复）**。需要 LLM 语义理解，session-reader 是纯逻辑工具（零 pi 依赖、不调 LLM）。工具能做的是结构化提取（extract），把素材给调用方 agent 自己总结。

### 3.3 关键决策与权衡

**D1：工具调用提取源 = assistant content blocks 的 `type:"toolCall"`**（✅ probe 519 个）

各工具 arguments 字段（✅ probe 019e6c96 真实工具全集）：

| 工具 | arguments 字段 | 类型化摘要格式 |
|---|---|---|
| bash | command, timeout | `bash: <command 前 60 字>` |
| read | path, limit, offset | `read: <basename>` |
| edit | path, edits | `edit: <basename> (N blocks)` |
| write | path, content | `write: <basename> (NKB)` |
| subagent | task, agent, ... | `subagent: <task 前 40 字>` |
| head | path, limit | `head: <basename> (N)` |
| todo | action, id, status | `todo: <action>(<id>)` |
| coding-workflow-gate | phase | `cw-gate: phase=<N>` |
| coding-workflow-init | slug | `cw-init: <slug>` |
| coding-workflow-phase-start | — | `cw-phase-start` |
| **未知工具 fallback** | — | `<toolname>: <arguments JSON 前 50 字>` |

未知工具 fallback 确保任何工具都有确定摘要（不同 session 工具集不同，cw/todo/skill 工具常见）。

**D2：toolResult 类型化摘要的数据源**（修正初版错误）

✅ probe 确认：toolResult.message 自带 `toolCallId`（515/515）+ `toolName`（515/515），全部能匹配 toolCall.id（0 孤儿）。摘要算法：

1. toolName 直接取自 `toolResult.message.toolName`（无需关联）
2. 参数（如 bash command）用 `toolCallId` 匹配同 turn 内 `toolCall.id`，取该 toolCall 的 arguments
3. 规模 = toolResult content 文本的字节数/行数

**无顺序依赖**。`toolCallId` 缺失时（实测 0%）fallback 用顺序，但这是兜底而非主路径。

**D3：extract 的 5 个预设**

| what | 提取源 | 输出 | scope 说明 |
|---|---|---|---|
| `user-messages` | `role==='user'` 的 text | 按 turn 排列的 user 消息全文 | — |
| `commands` | assistant content toolCall blocks | `{name, args 摘要}` 列表（带 turn + 可选 tool 过滤） | 全部工具 |
| `files` | toolCall arguments 的 path（read/edit/write/head） | 去重文件路径（带操作类型） | **仅含 path 的文件类工具**；todo/cw/subagent 无 path 不纳入 |
| `commits` | 扫 text + toolResult 的 hash | commit hash + 上下文一行 | 见 D6 误匹配处理 |
| `tool-results` | `role==='toolResult'` text（+ toolName 可选过滤） | toolResult 文本列表（带 turn + 工具名） | — |

**数据流**（extract commands 为例）：`session file → parse → 找 role==='assistant' && content 含 toolCall → 提取 {name, arguments} → 按 D1 映射摘要 → 附 turn 来源 → 可选 tool 过滤 → 输出`。

**D4：V3 阈值 600 → 1500 token（tradeoff 量化）**

加 assistantBrief（+80 字/turn × 32 ≈ +640 token）+ 修复 toolSummary（+~200 token）后 outline 预估 ~1100-1300。tradeoff：

- **多花 ~700 token outline** vs **省 3 次 expand/detail 调用**（每次重复输出 user+assistant 文本，单次 detail T010 全文就远超 700 token）。
- outline 单独 token 效率相对 v1 退化（506→~1200，翻倍），但**整体调用链 token 大幅下降**（v1 的重复消费省掉）。v2 验收保留 v1 的"vs read"对比口径（V-callcount），outline 单独退化在 D4 显式披露。

**D5：`#` 唯一前缀算法**（provideHashCandidates 补全层，非工具层 findSessions）

provideHashCandidates 多匹配时，对每个候选的 sessionId 计算 `insertText`：

```
同组 sessionId 列表 S
对当前 sid，与 S 中其他每个 sid 求字符级 LCP，取【最大值】 maxLCP（最像的兄弟）
唯一前缀 = sid.slice(0, maxLCP + 1)   // 保留连字符
insertText = "#" + 唯一前缀
```

**算法正确性**（✅ 全量 3486 session / 329 碰撞桶验证通过）：要唯一区分一个 sid，须比"与它最像的兄弟"（共享前缀最长者）多一位——取 LCP **最大值** +1。取最小值会被远房邻居把前缀拖短导致碰撞（初版错误，见附录）。insertText 最长 16 字符（分布：10 字 415 / 12 字 270 / 13 字 158 / 16 字 40），远短于完整 uuid（36）。

例：2 元桶 `019fea0e-c0cb...` 与 `019fea0e-378e...`，LCP=9，唯一前缀=`019fea0e-c`；19 元桶 `019e9680` 每个 sid 的 insertText 两两不同（max LCP+1 全量验证唯一）。findSessions 子串匹配（`sessionId.includes(query)`）成立。正常情况（无碰撞）insertText 仍 8 字符。

**D6：extract commits 的 uuid 误匹配处理**

`[0-9a-f]{7,40}` 会误匹配 uuid v7 的十六进制段（pi session id 本身就是）。处理：① 限定 7-8 位（git short hash 默认 7 位）；② 上下文消歧——优先取 bash `git log`/`git commit` 的 toolResult 内的 hash，或前后有 `feat:`/`fix:`/`commit` 关键词的；③ 输出标注来源 turn，agent 可快速辨认。⛔ P-extract-commits 实测误匹配率。

**错误规格（准则 6）**

| ID | 场景 | 文案 | 恢复指引 |
|---|---|---|---|
| F7 | extract `what` 非法 | `what "xxx" 无效，应为 user-messages/commands/files/commits/tool-results。👉 用合法 what 重试。` | 列举合法值 |
| F8 | extract 无匹配（tool 不存在） | `what=commands tool="nonexist" 无匹配。该 session 工具：bash×309,read×64,...。👉 用存在的工具名重试。` | 返回工具分布 |
| F9 | extract 结果超预算 | `what=user-messages 结果 8500 字节超预算（≈2000 token），已截断到 T000-T018（18/26）。👉 缩小 turns=T000-T009 或换 what=commands 重试。` | 截断位置 + 缩小建议（预算统一用字节，注明 ≈ token 换算） |

**探针清单（准则 7）**

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-toolcall-src | 工具调用在 content blocks type:toolCall | ✅ probe 019e6c96：519 在 content，0 在 message.toolCalls | ✅ |
| P-args-fields | 各工具 arguments 字段全集 | ✅ probe：10 个工具 + 未知 fallback | ✅ |
| P-tr-has-id-and-name | toolResult 带 toolCallId + toolName | ✅ probe：515/515 带，515/515 匹配 toolCall.id | ✅ |
| P-collision-rate | 8 字符片段碰撞率 | ✅ probe 全量 3486 session：26.5% | ✅ |
| P-o1-token | outline 加 assistantBrief+toolSummary 后 ≤1500 | ⛔ O1 实现后实测 | ⛔ |
| P-extract-commits | commit hash 7-8 位 + 上下文消歧的误匹配率 | ⛔ O4 实现后核对 | ⛔ |

---

## §4 验收（真实场景，非单测）

> 依赖：本机真实 session，`019e6c96`（32 turn/1204 entry/519 toolCall）+ `019fea0e` 碰撞对为主样本。单测作回归辅助。

| ID | 回溯目标 | 场景 | 通过标准 |
|---|---|---|---|
| V-o1 | 目标 1 | outline 含 assistant 结论 + toolSummary | ① 每行含 assistant 结论（非空）② toolSummary 显示真实工具（不再空）③ token ≤1500（P-o1-token） |
| V-o1-decision | 目标 1 | agent 只看 outline 判断"哪轮改 WeakMap" | 指向 T010（assistantBrief 含"WeakMap/Map 分区"），无需 expand |
| V-o2 | 目标 3 | expand toolResult 类型化摘要 | toolResult 行显示 `bash: <cmd> (N行)` / `read: <path>`（非纯文本）；用 toolName+toolCallId 关联，无顺序错位 |
| V-o3 | 目标 1 | detail 默认 toolResult 摘要态 | ① 条目数 = 16（不再变 9）② toolResult 有摘要 ③ includeToolResult:true 仍全文 |
| V-o4-* | 目标 4 | extract 5 预设 | user-messages 返 26 条 / commands+bash 返命令带 turn / files 返去重路径 / commits 返 hash（P-extract-commits 误匹配率可接受）/ tool-results 返文本带 toolName |
| V-o5 | 目标 5 | `#` 碰撞延长 | ① 2 元桶 `#019fea0e` 列 2 候选，insertText `#019fea0e-c`/`#019fea0e-3` 唯一 ② **大桶 `019e9680`（19 元）**：19 候选 insertText 两两不同，每个 `findSessions(insertText去#)` 唯一命中（拦截算法方向错误——2 元桶退化无法暴露） |
| V-callcount | 目标 2 | 固定任务"总结 019e6c96 的 plugin 架构决策" | v1 实测调用链（锚定基线）vs v2 ≤2 次 |
| V-regress | 回归 | v1 既有功能 | find/family/outline(旧字段)/expand/detail(含 includeToolResult)/search/export 行为一致 |

**失败场景（F7-F9）**：非法 what / 不存在 tool / 超预算，返回 👉 指引且不抛异常，agent 据指引一次重试成功。

---

## §5 下一层拆分

| # | 单元 | 内容 | justification | 验收 |
|---|---|---|---|---|
| O1 | outline assistantBrief + toolSummary 修复 | render.ts：① entryToolCallNames 改读 content blocks（修 bug）② formatLine 加 assistantBrief ③ 降级序调整 ④ V3 阈值 1500 | 修 bug + 补断层，toolCall 提取逻辑 O2/O4 复用 | V-o1/V-o1-decision |
| O2 | expand/detail toolResult 类型化摘要 | render.ts：用 toolResult.toolName + toolCallId 关联取 args（D1/D2），entryBrief 改类型化 | 解决痛点 2/5 | V-o2 |
| O3 | detail 默认摘要态 | render.ts：renderDetail 默认渲染摘要（O2 + 头尾 + 行数），不再 continue | 解决条目消失 | V-o3 |
| O4 | extract action | tool-handler.ts：action 分发 + 5 预设提取（D3）+ F7-F9 + schema | 解决痛点 4 | V-o4-* |
| O5 | `#` 唯一性 | tui/hash-provider.ts：provideHashCandidates 多匹配时动态算唯一前缀（D5） | 解决痛点 6（26.5% 碰撞） | V-o5 |

**文件改动地图**：
- `core/render.ts`：O1（entryToolCallNames + formatLine + 降级序）+ O2（entryBrief 类型化 + toolCallId 关联）+ O3（renderDetail 摘要态）
- `tool-handler.ts`：O4（extract + F7-F9）+ outline/expand/detail 渲染微调
- `tui/hash-provider.ts`：O5（唯一前缀算法）
- `__tests__/`：render.test（O1-O3）+ tool-handler.test（O4）+ hash-provider.test（O5）
- design.md：§3.4 加 extract schema + §3.5 算法 1 补 assistantBrief/toolSummary + §4 V3 阈值更新 + `#` 唯一性

**待验证检查点**：P-o1-token / P-extract-commits（见 §3.3）。

---

## 附录：审查修正记录

初版（commit 550705b6）D2 声称"toolResult 无 id 只能靠顺序关联"，基于一个**看错层级的 probe**——只查 `message.content` blocks（content 内确实无 id），漏看 `message` 顶层字段。经对抗式审查（review-optimization-v2.md）用真实数据推翻：`message.toolCallId`（515/515）+ `message.toolName`（515/515）都存在，全部匹配 toolCall.id。

**教训**（准则 7）：probe 要覆盖所有可能字段层级。初版 probe 只看 content block 就下"无 id"全局结论，导致 O2 选了更脆弱的"顺序关联"方案 + 凭空造出 P-o2-order（fork/branch 错位）伪风险。修正后用 toolName + toolCallId 精确关联，by construction 零风险。

本版已修正：D2 重写、P-no-tr-id 删除（替换为 P-tr-has-id-and-name ✅）、P-o2-order 删除（伪风险）、§2.1 expand 现状改真实输出、D1 工具表补全 + fallback、新增 O5（碰撞）。

**第二轮审查修正（D5 算法方向错误）**：初版 D5 写"取最小值 minLCP+1"，直觉错误——要唯一区分 sid 应取"与最像的兄弟"（LCP 最大）+1。取最小值会被远房邻居把前缀拖短，导致大碰撞桶（如 19 元的 019e9680）的 insertText 仍碰撞（文档算法 90 桶失败、19 元桶只产生 4 个去重 insertText）。第二轮审查用全量数据验证推翻，修正为 max LCP+1（全量 329 桶通过）。**教训**（准则 7）：碰撞率（26.5%）验证了≠算法验证了；V-o5 用 2 元退化桶验收无法暴露算法方向错误（2 元 min=max LCP），验收必须覆盖 ≥5 元含子簇的真实大桶。本版 V-o5 已补 19 元桶场景。
