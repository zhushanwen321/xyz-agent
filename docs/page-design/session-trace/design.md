# Session Trace 可视化设计（main 区 Trace 视图 + drawer inspector）

> 审查记录：2026-08-20 tech-design-review 对抗式审查（报告 `./design-review.md`）——5 must-fix（`entry_appended` 断言证伪 / session 路径错误 / `getEntries()` 不含 header / 留痕写入时机 / V7 自相矛盾）+ 6 suggestions 已全部修复，改动经增量复审。

> **一句话结论**：在 main 区 panel header 增加「对话 | Trace」SegmentedTab 视图切换——Trace 视图把 pi session 文件（append-only JSONL 事件日志）的**全部 entry** 渲染成占满 main 区的线性时间线台账（含 system prompt 留痕、user/assistant 每条 message、compaction、lifecycle 事件、extension 自定义 entry、xyz-agent 自定义边界标记），用「当前 context 边界标注」区分「仍在模型视野里的 entry」与「已被压缩影子化的历史」；点击任意行，右侧 drawer 切入临时 inspector 页展示该 entry 完整详情（不占一级 tab 位）。system prompt 不落盘的问题用 builtin extension 在变化时写 custom entry 解决（DSH `request/header` 模式）。

- **S（情境）**：xyz-agent 的主界面是每个 session 的对话流（message-stream），展示消息级内容：user 气泡、assistant 正文、turn 内 thinking/tool 块、压缩摘要 notice。这是用户与 agent 协作的主界面。
- **C（冲突）**：对话流只是 session 文件的「消息投影」。pi session 文件里还有大量 entry 在 GUI 完全不可见——model_change / thinking_level_change / label / extension 的 custom 数据 entry 被 converter 直接丢弃；system prompt 每次运行时动态重建、**不落盘**，resume/reload/换模型后它变了，文件里毫无痕迹。排查「模型为什么这样回答」「上下文里到底有什么」「这个 session 经历了几次压缩/恢复」只能手工翻 JSONL 文件。
- **Q（问题）**：如何在 GUI 上把一个 session 的完整 trace 可视化，让「这个 session 发生过的一切」和「模型此刻实际看到什么」都可查？
- **A（答案）**：main 区「对话 | Trace」视图切换 + 全量 trace 台账 + drawer inspector 详情 + context 边界标注 + system prompt extension 留痕。本文展开这个答案。

**层声明**：当前层 = 技术方案设计（数据通路 + 渲染模型 + 交互语义）；下一层 = 实现计划（任务拆分 + 代码改动）。本文不写到函数签名级实现细节。

**配套产物**：视觉/交互 demo = [`trace-tab-demo.html`](./trace-tab-demo.html)（浏览器直接打开）。

---

## 1. 背景目标

### 1.1 系统是什么

xyz-agent 是 Electron + Vue 3 的 AI Agent 桌面工作台，每个 session 由 pi 子进程驱动。pi 把 session 持久化为 **append-only JSONL 文件**（`~/.xyz-agent/pi/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`，实现一律走 `getSessionsDir()` 动态推导——`pi-paths.ts:78`，禁止硬编码；注意 `pi/agent/sessions/` 是历史遗留目录，真实数据在 `pi/sessions/`），每个 entry 一行 JSON，entry 间以 `parentId` 链接成链（xyz-agent 场景下是线性链，见 D3）。

**术语锚定**（本文反复使用，且第一个存在命名冲突）：

- **session trace（本文主角）**：session 文件的完整事件台账——所有 entry 按时间序的只读回放。命名冲突警告：项目已有「trace」一词指 **turn 内 trace**（对话流里一个 turn 的 thinking/tool/text 块渲染区域，见 `streaming-trace-window/design.md` §1.1）。两者是不同层级的概念：turn trace 是「一个回合内模型干了什么」，session trace 是「整个 session 历史上发生了什么」。本文及代码内一律用 **session trace / `session-trace`** 区分；用户面向的形态是 main 区 SegmentedTab 的「Trace」段（对话流里 turn trace 不出现文字标签，无冲突）。
- **当前 context**：模型下一次请求实际看到的上下文 = `buildContextEntries()` 的输出（pi 源码 `core/session-manager.ts:418`）中**经 `sessionEntryToContextMessages()` 转换非空的 entry**（`:383`——lifecycle/custom 等类型转换结果为 0 条消息，即使在 compaction 之后也永不进 context）：沿 leaf 路径取最后一条 compaction，context = 该 compaction 自身（转为 summary 消息）+ 其 `firstKeptEntryId` 起（含）到 compaction 前的 entries + compaction 后的全部 entries。多次压缩时只有最后一次决定当前 context。
- **影子化（shadowed）**：entry 存在于文件中但因 compaction 已不在当前 context（DSH 术语 shadowed）。
- **lifecycle entry**：不进 LLM context 的元信息 entry——`model_change` / `thinking_level_change` / `session_info` / `label` / `session` header（`sessionEntryToContextMessages()` 不转换它们，`session-manager.ts:383`）。

### 1.2 设计目标（从使用者体验倒推）

用户画像：开发者在 agent 行为异常、或对「模型到底看到了什么」存疑时打开 trace 排查。一次排查要回答三个问题：**这个 session 发生过什么？模型现在实际看到什么？关键状态（system prompt/模型/thinking level）什么时候变过、变成什么？**

- **G1 完整性**：session 文件的每种 entry 都可见、可下钻——pi 官方 10 种 + xyz-agent 自定义 2 种（`handoff_marker`、sidecar `session_end`）+ extension 的 custom/custom_message。任何 entry 不再「只有翻 JSONL 才能看到」。
- **G2 system prompt 可追溯**：session 内每次 system prompt 快照留痕（版本、变化原因、全文可查），resume/reload 前后的差异可定位。
- **G3 context 边界可辨**：一眼区分「仍在当前 context」与「已影子化」的 entry；能回答「模型此刻看到的上下文长什么样」。
- **G4 长 session 可用**：数千 entry 的 session 可流畅浏览（虚拟化/分页 + 类型过滤 + 搜索）。
- **G5 实时性**：活跃 session 的新 entry 实时追加到 trace（不用重开）。
- **G6 只读无副作用**：trace 是诊断视图，不提供任何写操作（v1 不做 fork-from-here / 编辑 label 等交互）。

**In scope**：main 区 Trace 视图 + drawer inspector 的数据通路（runtime 端口 + WS + renderer store）、渲染模型（entry → 行 → inspector）、system prompt 留痕 extension、过滤/搜索/视图切换交互。
**Out of scope**：对话流（message-stream）内部渲染任何改动（Trace 是它的平级视图，不改它）；turn trace 收编机制（streaming-trace-window 已设计）；跨 session 的全局搜索（DSH session-query 那种，未来独立设计）；trace 导出（pi 自带 `export_html` RPC 可后续暴露）；编辑/交互操作。

---

## 2. 现状与问题分析

**结论：pi 的 session 文件本身是完整的事件日志（10 种 entry 全覆盖），但 xyz-agent 的 GUI 只消费了其中的「消息子集」——4 种 lifecycle entry 被 converter 丢弃、system prompt 从不落盘、resume/reload 不留痕；trace 可视化的本质是补全「事件日志 → GUI」的投影，而不是新建数据源。**

### 2.1 pi session 文件格式（事实表，取自 pi 0.84.1 源码）

entry 类型全集（行号引自 pi 源码仓 0.84.2；0.84.1 npm dist 的行为一致性已抽查核实——关键断言的修正注记见 §2.6 / §3.3 D2/D4）：

| type | 关键字段 | 进 LLM context？ | 说明 |
|---|---|---|---|
| `session` | version, id, cwd, parentSession? | 否 | 文件首行 header。fork 出的新文件 parentSession 指回源文件 |
| `message` | message: AgentMessage | **是** | 见下方 role 细分 |
| `compaction` | summary, firstKeptEntryId, tokensBefore, details{readFiles,modifiedFiles}, fromHook? | **是**（转 summary 消息） | 压缩点。summary 是 LLM 生成的 Markdown |
| `branch_summary` | fromId, summary | **是**（转 user 消息） | 分支摘要 |
| `custom` | customType, data? | 否 | extension 纯数据 entry（`appendEntry(customType, data)` 写入） |
| `custom_message` | customType, content, display, details? | **是**（转 custom 消息） | extension 消息 entry（display 控制对话流可见性） |
| `thinking_level_change` | thinkingLevel | 否 | thinking 档位变更 |
| `model_change` | provider, modelId | 否 | 模型切换 |
| `label` | targetId, label? | 否 | 给某 entry 打书签 |
| `session_info` | name? | 否 | 重命名 |

`message` entry 的 role 细分：`user` / `assistant`（content = text|thinking|toolCall blocks + model/provider/usage/stopReason）/ `toolResult`（toolCallId + content）/ `bashExecution`（command/output/exitCode/truncated）/ `custom`（customType + content + display）。

xyz-agent 自定义（runtime 写，非 pi 官方）：`handoff_marker`（append 进 JSONL，记录交接目标 session id，`session-file-utils.ts:459`）；`session_end`（写同目录 sidecar `.meta.json`，**不污染 JSONL**，`session-file-utils.ts:111-146`）。

### 2.2 三个关键运行时事实（全部已核实源码）

1. **system prompt 不落盘**。SessionEntry 无 system_prompt 字段；system prompt 由 `buildSystemPrompt()` 每次运行时动态构建（工具定义 + 技能 + AGENTS.md + extension 注入）。RPC `get_state` 不含它（`rpc-mode.ts:446-461`）；唯一获取通道是 **pi extension API** `getSystemPrompt()`（`agent-session.ts:2571`）。→ resume/reload/换模型后 system prompt 变化**无任何留痕**。
2. **resume/reload 不写任何 entry**；compact 追加一条 `compaction` entry。session 文件**延迟写入**：首条 assistant 消息前文件不存在（`session-manager.ts:1015` `_persist`，xyz-agent AGENTS.md 规则 6 同源）。
3. **context 成员规则的精确语义**（`buildContextEntries`，`session-manager.ts:418-458`）：取 leaf 路径上最后一条 compaction → context = [compaction] + 路径中 `firstKeptEntryId`（含）至 compaction 前的 entries + compaction 后全部。lifecycle entry 天然不进 context（`sessionEntryToContextMessages` 不转换）。**这个纯函数语义就是 trace 视图「边界标注」的算法来源，前端/core 复刻即可，无需新协议。**

### 2.3 xyz-agent 现状：entry 可见性对照表

| entry 类型 | 对话流现状 | 丢弃点/证据 |
|---|---|---|
| message(user/assistant/toolResult) | ✅ 可见 | session-entry-mapper.ts → message-converter.ts |
| message(bashExecution) | ✅ 可见（BashOutputBlock） | 同上 |
| compaction | ⚠️ 仅摘要 notice | mapper 转 `compactionSummary` 伪消息；details/首保留点不可见 |
| custom_message | ⚠️ 部分（COMPLETE_NOTIFY 类被覆写 display=false 隐藏） | session-entry-mapper.ts:74 附近 |
| model_change / thinking_level_change / label | ❌ **丢弃** | mapper default 分支跳过（session-entry-mapper.ts:104 附近，`// label / session_info / 未建模类型 → 跳过`） |
| session_info | ⚠️ 仅 name 用于侧栏列表 | session-file-utils.ts extractSessionName |
| custom（纯数据） | ❌ 不进消息流 | mapper custom 分支（session-entry-mapper.ts:99 附近，收进 customDataEntries 供按需读取） |
| session header | ⚠️ 仅元信息提取 | session-file-utils.ts |
| handoff_marker / session_end | ⚠️ 仅状态提取（交接/终态标记） | session-file-utils.ts:317/439 |
| system prompt | ❌ **不存在于文件** | §2.2-1 |

### 2.4 DSH 调研借鉴（repo：`~/GitApp/ai-agent/deepseek-harness`）

DSH 的对应物是 **Trajectory 视图**（`packages/client/ui-trajectory/`，Web UI 独立页面）：顶部时间线总览（可缩放/拖拽选区间）+ Turn 感知的事件台账（@tanstack/react-virtual 虚拟化，向上翻页加载历史）+ 选中 entry 开详情 inspector（token/时间/input/output/JSON tree）。数据模型是 **Event Sourcing**：append-only 事件日志（43 种事件）是唯一真相源，当前消息历史是从日志派生的投影。

直接击中本需求的四点：

1. **`request/header` 事件**：每次 LLM 请求前记录完整 system prompt + 模型配置，带 `reason: initial | resume | change`——system prompt 变化**留痕**。pi 缺这个，我们用 extension 补（D2）。
2. **压缩三件套** `compaction/start → summary → end`：summary 事件携带被影子化的 seq 范围与 token 统计——trace 上「此处压缩了 N token」的标注方式。pi 的 compaction entry 有等价字段（tokensBefore/firstKeptEntryId）。
3. **surface vs log 分层**：DSH 区分「全部事件」与「进消息历史的 surface 事件」（仅 3 种）。对应我们的「全量 trace + context 边界标注」。
4. **台账形态**：一行 = 一个事件（序号 + 类型标签 + 单行摘要），选中展开详情。行即 entry，不发明新的聚合结构。

可回避：DSH 的 surface replace 机制（surfaceOp/replaceGeneration）复杂度高，pi 的 compaction 已用「compaction entry + firstKeptEntryId」表达，不需照搬；DSH 无 TUI 可参考的另一点是 crash recovery 合成事件，与本设计无关。

### 2.5 失败模式（真实、可复现）

- **F1 排查靠手翻 JSONL**：「模型为什么忽略了 AGENTS.md 规则」→ 用户只能打开 `~/.xyz-agent/pi/sessions/.../*.jsonl` 手工检索，文件动辄数万行。
- **F2 system prompt 黑洞**：resume 后行为漂移，想知道「resume 前后 system prompt 变了什么」→ 永远查不到（不落盘）。
- **F3 压缩后历史蒸发感**：compaction 后对话流只剩 summary，被压缩的原始对话在 GUI 无任何入口可看（数据还在文件里）。
- **F4 lifecycle 不可见**：什么时候切过模型/thinking level、什么时候重命名过，对话流无痕迹（converter 丢弃）。

### 2.6 物理数据流

```
磁盘：~/.xyz-agent/pi/sessions/<cwd>/<ts>_<sid>.jsonl （append-only，10 种 entry + handoff_marker）
      + 同目录 .meta.json sidecar（session_end 终态）

路径 A（活跃 session，pi 进程在跑）：
  pi 子进程 --mode rpc
    ├─ RPC get_entries → { entries: SessionEntry[], leafId }   （打开时全量，pi 原生解析；
    │    注意不含 session header——header 由 runtime 端口补读文件首行 / scanner 元数据）
    └─ 增量 = 事件触发 + get_entries(since=lastLeafId) 拉取
         （pi 没有「每次 append 都广播」的 entry 事件：entry_appended 全仓唯一 emit 点在
          extension appendEntry 回调内 agent-session.ts:2517，message/compaction/bash 的
          append 均无 entry 级事件。改用现存事件 message_end / compaction_end /
          agent_settled / entry_appended 作触发信号，runtime 收到后 since 增量拉——
          since 参数 rpc-types.ts:64，history-rebuild-cache.ts:12-25 已有实测先例）
        → runtime event-interpreter → WS session.traceEntryAppended（点号式，session 域惯例）

路径 B（非活跃/历史 session，无 pi 进程）：
  runtime session-file-utils 读 JSONL（scanPiSessions 同族设施，含 header 首行）+ sidecar 合并
        → WS reply session.traceEntries

两条路径在 runtime 的 session.getTraceEntries 端口内路由，前端无感。
    → renderer：per-session 分区 store（ADR-0049 useSessionScopedState）→ TraceView 渲染
```

---

## 3. 解决方案

### 3.1 终态（使用者视角）

main 区 panel header 新增 SegmentedTab「对话 | Trace」（v6 §3.4 tab 型范式：`bg-bg-elevated` + `text-neutral-fg`），默认在「对话」。切到「Trace」后 main 区变为台账视图（composer 保留在底部，不打断对话能力）：

```
┌─ main ──────────────────────────────────────────────────┬─ drawer ──────────────┐
│ feat-retry · 工作中 2m41s        [ 对话 | Trace ]        │ ← 返回   TRACE #22    │
│ [全部][消息][工具][系统][生命周期][边界] 🔍  ☐仅当前context │ SYSTEM · 10:03:01      │
│ 30 entries · 9 在当前 context · 1 次压缩 · prompt v2      │ system prompt v2       │
│────────────────────────────────────────────────────────│ reason: resume         │
│ #1   SESSION    09:41:02  dag-executor-workspace · fork…  │ 12,702 字符 · 较 v1 +266│
│ #2   SYSTEM     09:41:02  system prompt v1 · initial …    │ ┌ diff 摘要 ─────────┐ │
│ #3   USER       09:41:15  帮我修一下 dag-executor 的重试…  │ │+ 10. 选择性提交用…  │ │
│ …    （影子化区：降透明，hover 恢复）                       │ │+ [extension 注入]… │ │
│ #21  COMPACTED  10:02:44  压缩 152,311 tok → summary …    │ └────────────────────┘ │
│ ─── 当前 context = #21 summary + 保留区 #18–#20 + #22+ ──│ [查看 v2 全文] [与 v1…│
│ #22  SYSTEM     10:03:01  system prompt v2 · resume … ◀选中态                       │
│ #23  USER       10:03:40  继续，把测试补上                │                       │
└────────────────────────────────────────────────────────┴───────────────────────┘
```

**交互样例（成功路径）**：

1. **总览**：切到 Trace 视图 → 从尾部加载最近一页，滚动到顶自动加载更早（DSH Trajectory 同范式）；顶部状态行显示 entries 总数 / 当前 context 内数量 / 压缩次数 / system prompt 当前版本。
2. **下钻**：点任意行 → 行进入选中态（`bg-surface-hover` + 摘要 `text-accent`，**无 ring 无左条**——v6 §3.4 列表项型规范；行底色已是 surface 的场景按 SearchModal sm-item 登记例外：选中用 surface-hover + 强调字色），drawer 切入 inspector 页显示该 entry 完整详情（assistant：逐 content block；tool：完整输出；compaction：summary 全文 + readFiles/modifiedFiles；SYSTEM：全文 + 与上版 diff 摘要）。drawer 未开时自动打开。inspector 顶部「← 返回」回到之前的 drawer tab。
3. **过滤**：kind chips（消息/工具/系统/生命周期/边界）+ 文本搜索（命中行高亮）；「仅当前 context」toggle 一键隐藏影子化与不进 context 的 entry——这就是「session 视角」，作为过滤态获得，不做独立视图。
4. **实时**：活跃 session 流式期间新 entry 追加到底部（compaction 发生时影子化标注即时更新）；对话与 Trace 视图共享数据，切回不丢状态。
5. **溯源**：SESSION header 行的 parentSession 链接点击 → 跳源 session 的 Trace 视图并定位 forkEntryId 行高亮。
6. **分屏对照**：split 双 pane 下 pane A 留对话、pane B 开 Trace（视图状态 per-pane），实现「对话流 ↔ 台账」同屏对照。

**失败路径**：

- **JSONL 损坏行**：pi 解析本身跳过 malformed 行（`parseSessionEntryLine` 吞错），trace 在对应位置显示一行 `⚠ 无法解析的 entry（第 N 行）`，不静默丢失——恢复指引：hover 提示「可在文件管理器中打开 JSONL 检查」并提供「打开所在目录」按钮。
- **session 文件尚不存在**（延迟写入期）：空态显示「session 尚未落盘（首条 assistant 回复到达后可见）」+ 转圈；文件出现后自动加载。不主动创建/触碰文件（AGENTS.md 规则 6 红线）。
- **system prompt 留痕缺失**（留痕包未装/被禁/旧 session）：SYSTEM 行显示「无留痕（该时段留痕 extension 未启用）」，并提供当前快照的「现取」按钮——**现取通道挂在常驻文件扩展**（`xyz-agent-extension.js` 同款 `--extension` 强制注入、不可禁；与 feat-original-system-prompt-save 分支在开发的 original-system-prompt-save 常驻插件同模式），不依赖可禁的留痕包，标注「当前值，非历史」。pi RPC 无 get_system_prompt 命令、`getSystemPrompt()` 只存在 extension API——现取能力若放可禁包里，本降级路径自相矛盾（审查 must-fix #5）。
- **RPC get_entries 失败**（pi 进程异常）：降级路径 B 文件直读，banner 提示「来自磁盘文件（实时更新不可用）」。

### 3.2 方案对比

**决策点 A：数据通路**（本节核心架构决策）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A1 混合：活跃走 RPC `get_entries` + 事件触发 since 增量拉；非活跃走文件直读**；runtime 端口内路由 | 高：活跃路径信任 pi 原生解析（entry 结构演进跟随 pi 升级），文件路径复用已有设施；对前端暴露统一模型 | 中：runtime 加一个端口 + 触发事件订阅 + 两条通路归一化 | 两条通路产物一致性（探针 P1 门禁）；RPC 失败需降级 | **推荐** |
| A2 纯文件直读（活跃也读文件） | 中：自维护 parser 跟随 pi 演进是长期负债；但 xyz-agent 已有 JSONL 读取设施，且 runtime 已在做（scanner） | 低：复用现有 | 活跃 session 写入竞态（读到半行——pi appendFileSync 单行原子但尾读可能截断，需容忍）；实时性靠 fs.watch 轮询，不如事件 | 不选：活跃路径放弃 pi 原生事件流是退步 |
| A3 纯 RPC（非活跃也拉 pi 进程） | 低：为看历史 session 起 pi 进程，资源与延迟不可接受 | 高：session 激活流程改动大 | 进程池压力 | 不选 |

若用 A2，§3.1 的「实时」样例变成：fs.watch 轮询 + 半行容忍逻辑，且活跃 session 失去 pi 内存态权威（未 flush 的 entry、leafId 路径判断都要自己复刻）。若用 A3，打开一个 3 个月前的 session 的 trace 要等 pi 进程启动数秒。

**决策点 B：展示形态**（已被用户裁决为线性，此处记录被否项）：线性时间线 + parentSession 溯源链接 vs 树形视图。用户确认 xyz-agent 的 fork 是「截断源文件写新文件」的 clone 式（`session-fork.ts`：不用 pi 原生 in-file fork RPC），**每个 session 文件内部是线性链**，分支表现为另一个 session（header `parentSession` + `forkEntryId` 指回源）。故树形视图无对象，线性即可。

**决策点 D：承载位置**（用户裁决，2026-08-20）：main 区视图切换 + drawer inspector vs drawer 一级 tab（初稿方案）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **B. main 区「对话 | Trace」SegmentedTab 切换 + 点行进 drawer inspector** | 高：trace 台账是主视图级信息密度，归 main；详情归 drawer（辅助/详情区）——与项目「main 主视图 / drawer 辅助」层级自洽；与 DSH Trajectory / LangSmith 的 trace 工具标准形态一致 | 中：net 增量 = per-pane 视图状态 + 单向联动（main 选中 → drawer inspector）；行组件/过滤/搜索两方案都要做 | drawer 被 inspector「抢走」的打扰（靠「选中才切入 + 返回按钮」缓解）；split 下视图状态需 per-pane 而非 per-session | **选定（用户裁决）** |
| A. drawer 一级 tab + 就地展开详情 | 中：把主视图级密度塞进半宽 drawer，长内容（system prompt 全文/tool 输出）就地展开推挤列表、上下文跳动；扫列表↔看详情循环体验差 | 略低：少视图切换与联动 | drawer tab 持续膨胀（第 8 个）；accordion 详情在窄栏可读性差 | 不选（初稿方案，被用户以交互体验否决） |

B 的附带约束（用户一并裁决）：切换控件用 SegmentedTab（非单按钮）；inspector 是**临时上下文页**（选中才切入，不占一级 tab 位，顶部带返回）；drawer 未开时点行自动打开。

**决策点 C：system prompt 留痕**（用户已裁决「extension 留痕，变化才写」，此处记录被否项备查）：

| 方案 | 被否理由 |
|---|---|
| C2 只展示当前快照（打开时现取） | 满足不了「上次 resume 前是什么样」——历史永远查不到（F2 不修） |
| C3 只展示影响因子（model_change 等） | 看不到实际发给模型的完整 prompt，排查「模型为什么忽略规则」仍无解 |

### 3.3 关键决策与权衡

- **D1 定位 = 全量 trace 台账 + context 边界标注**（用户裁决）。「session 视角」（模型当前实际看到的上下文）不做独立视图，以「仅当前 context」过滤 toggle 提供。依据：用户原始诉求是「都能够看见」；DSH Trajectory 同形态验证可行。
- **D2 system prompt 用独立 builtin extension 留痕**（用户裁决；新包 `@zhushanwen/pi-system-prompt-trace`，mandatory **feature tier** 可禁不可卸）。写入时机经源码校正：**不在 session_start 写**——session_start emit（`agent-session.ts:2386`）早于 resources_discover 的 prompt 重建（`:2411`），且 xyz-system-prompt-extension 的 `before_agent_start` 每 turn 注入此刻未发生，此时快照必然不完整、首 turn 必误报一次 change。改为**首个 turn_start 写 initial/resume**（此时 `getSystemPrompt()` 拿到的是含全部注入的最终 prompt；时机区分取 `SessionStartEvent.reason`，`core/extensions/types.ts:565` 原生支持 startup/reload/new/resume/fork），**后续每个 turn_start** 对 `getSystemPrompt()` 做 hash 对比，变化才 `appendEntry('xyz:system-prompt', { version, hash, reason, fullText, charCount, parentVersionDiffSummary? })`。reason 枚举对齐 DSH：initial / resume / change。被否：C2/C3（见上）。权衡：fullText 每次 ~12KB 落盘，hash 去重后典型 session 只写 1-3 次，体积可接受；留痕 entry 本身是 `custom` 类型不进 context，零模型侧影响。探针 P2 门禁：实测 resume 链路 reason 值与落盘时序（见探针清单）。**hash 基线的跨重启恢复**（复审 N2）：进程内 resume 可经 `session_before_switch.targetSessionFile`（`types.ts:578-583`）直读目标文件取上一版 hash；app 重启直 spawn resume 时 `session_start.previousSessionFile` 为 undefined（`agent-session-runtime.ts:210/218`）且 extension API 无文件读取通道——此情形由 extension 自持久化基线（dataDir 下小文件记 lastHash/sessionId），读不到基线则按「resume 必写一条」兜底。「典型 session 只写 1-3 次」以基线可恢复为前提，基线丢失时每次 resume 多写一条（~12KB），可接受。
- **D3 线性时间线，fork = 另一个 session**（用户裁决 + 代码确认 `session-fork.ts:58` 截断写新文件）。trace 提供 parentSession 链接溯源，不做树。
- **D4 数据通路 = A1 混合**（用户确认后定）。runtime 新增 `session.getTraceEntries` 端口；打开时全量走 RPC `get_entries`，增量走「事件触发 + `get_entries(since=lastLeafId)` 拉取」。**已核实 pi 0.84.1 支持**：`get_entries` 返回 `{ entries, leafId }` 且支持 `since` 增量参数（dist rpc-types.d.ts:333 响应 / rpc-types.ts:64 请求；`history-rebuild-cache.ts:12-25` 已实测 since 行为）；`appendCustomEntry`/`getSystemPrompt` 存在（`agent-session.ts:2514/2571`）。**审查修正**：pi 不存在「每次 append 都广播的 entry 事件」——`entry_appended` 全仓唯一 emit 点在 extension `appendEntry` 回调内（`agent-session.ts:2517`；xyz-agent `event-adapter.ts:710` 注释同源），message/compaction/bash 的 append 均无 entry 级事件，故增量腿用现存事件（message_end / compaction_end / agent_settled / entry_appended）作触发信号再 since 拉取，而非直接透传。时序已核实：compaction_end / agent_settled / thinking_level_changed / session_info_changed 均 append 先于 emit；message_end 严格先于 append 但跨进程往返 + 追赶式 since + agent_settled 兜底使其可靠（P3 覆盖）。**lifecycle 与独立 bashExecution 的 append 无通用事件**（model_change / label 无事件）——这些动作全部由 runtime 自身发起，在对应 RPC 命令成功后主动触发一次 since 拉取即可覆盖。
- **D5 行 = entry，详情进 drawer inspector**（用户裁决修正）。不发明聚合结构（一个 assistant turn 的多条 message 各自成行）；行摘要显示关键字段（assistant：模型/blocks 计数/usage；compaction：tokensBefore/保留起点），点击后详情在 drawer inspector 渲染（assistant 逐 block 复用 Block.vue 形态或轻量复刻）。被否：① 按 turn 聚合行——turn 是消息级概念，trace 的权威性来自「与文件逐行对应」，聚合破坏可核对性；② 就地 accordion 展开（初稿）——长内容推挤列表，「扫列表↔看详情↔对比多行」循环体验差（决策点 D）。
- **D5a 切换控件 = SegmentedTab「对话 | Trace」**（用户裁决）：放 main panel header，遵循 v6 §3.4 tab 型范式。被否：单个 toggle 按钮——不能明确表达「当前在哪一态」。
- **D5b inspector = drawer 临时上下文页**（用户裁决）：选中 trace entry 才切入，不占一级 tab 位，顶部「← 返回」复原前一个 tab。被否：新增常驻「详情」tab——inspector 无选中即空态，不配常驻；tab 栏不膨胀。正在使用其他 drawer tab 时点 trace 行会切入 inspector（点击即明确意图），返回可复原。
- **D5c 视图状态 per-pane**：split 双 pane 下 pane A 对话 + pane B Trace 同 session 是合法对照场景；selectedEntryId 同样 per-pane。对话/Trace 视图切换不重建数据（共享同一 store 分区，ADR-0049）。
- **D6 命名：代码/文件名一律 `session-trace`**，tab 显示名「Trace」。理由 §1.1：与 turn trace（streaming-trace-window）分层，避免代码库里 `trace` 一词两义。
- **D7 只读（G6）**：v1 不提供 fork-from-entry / label 编辑等写操作。被否：顺手做 fork 入口——写操作引入权限/状态同步问题面，且对话流已有 fork 模式入口（composer forkMode）。
- **D8 过滤维度 = kind chips + 文本搜索 + context toggle**，不做正则/时间区间筛选（减法优先；DSH 的时间线缩放留待 v2 验证需求）。
- **D9 性能基线**：>500 entry 启用虚拟滚动（virtua，MessageStream 同族设施）；首次加载尾部一页（~200 entry），向上滚动翻页。被否：全量加载——长 session 数千 entry + system prompt 全文，DOM 与内存双炸。

### 3.4 渲染模型（entry → 行 kind 映射）

| 行 kind | 来源 entry | 行摘要内容 | 展开详情 |
|---|---|---|---|
| SESSION | session header | cwd / 创建时间 / parentSession 链接 | 完整 header JSON |
| SYSTEM | custom(`xyz:system-prompt`) | 版本 / reason / 字符数 / hash 短码 | 全文 + 与上版 diff 摘要 |
| USER | message(user) | 文本首行 | 完整内容（含图片） |
| ASSISTANT | message(assistant) | 模型 / thinking×n tool×n / usage / stopReason | 逐 content block |
| TOOL | message(toolResult) | 工具名 + ✓/✗ + 输出首行 | 完整输出 |
| BASH | message(bashExecution) | 命令 + exitCode | 完整输出（truncated 标记 + fullOutputPath） |
| NOTICE | custom_message + message(role:custom)（display=true） | customType + 内容首行 | 完整 content/details |
| COMPACTED | compaction | tokensBefore / summary 首行 / 保留起点 #N | summary 全文 + readFiles/modifiedFiles |
| BRANCH | branch_summary | fromId + summary 首行 | summary 全文 |
| LIFECYCLE | model_change / thinking_level_change / session_info / label | 各字段一行 | 原始 JSON |
| DATA | custom（其他 customType） | customType + data 概要 | 完整 JSON |
| BOUNDARY | handoff_marker / session_end(sidecar) | 交接目标 / 终态 outcome | 原始记录 |

上表「展开详情」列即 drawer inspector 的内容（决策点 D）。「不进 context」的 kind（LIFECYCLE/DATA/SESSION/BOUNDARY）在 context 过滤态下隐藏，在全部态下有弱标记（不计入影子化——它们本来就不进）。

SESSION 行数据来源注意：`getEntries()` 明确**不含 session header**（`session-manager.ts:1301` docstring "excludes header"），路径 A 下 header 由 runtime 端口补读文件首行（或从 scanner 元数据取 parentSession/forkEntryId）；fork header 的 parentSession 有两种形态——源 session 已落盘时为文件路径、未落盘时为 sessionId fallback（`session-lifecycle.ts:521-527`），溯源链接解析两种都要覆盖。

kind chips → 行 kind 映射（§3.1 样例 3 的过滤维度）：**消息** = USER / ASSISTANT；**工具** = TOOL / BASH；**系统** = SYSTEM / NOTICE / COMPACTED / BRANCH；**生命周期** = LIFECYCLE；**边界** = SESSION / DATA / BOUNDARY（demo 的 KIND_GROUPS 即此映射）。

### 3.5 assistant 聚合行的子 block 展开（2026-08-21 增补）

台账契约「一行 = 一个 entry」不变；assistant 行的 content blocks（真实 corpus 仅 thinking / text / toolCall 三种，字段口径 `thinking.thinking` / `toolCall.id+name+arguments`——core `trace-blocks.ts` 归一化 SSOT）是**展示层派生**的内联子行：

- **列表**：ASSISTANT 行带 chevron（`expandedKeys` per-session 分区存储，切视图保留），展开后按序插入缩进的子 block 行（badge + `blockHeadline` 首行摘要）；子行跟随父行过滤（父行被过滤掉则子行不出现）；子行 key = `<entryKey>#block-N`（entry key 取值域不含 `#`，无碰撞；virtua stable-key 同源）。
- **选中寻址**：`selectedKey` 扩展上述 block key；点 assistant 行 → inspector 聚合态（id / model / usage tokens / blocks 清单），点子 block 行（或聚合态清单项）→ inspector block 态（thinking/text 全文、toolCall name/callId/arguments + 按 toolCallId 配对跳转 TOOL 行、redacted 占位）。
- **返回层级**：block 态「← 返回」回父聚合态；聚合态「← 返回」清除选中复原前 tab。
- **TOOL 行 content 层**：toolResult 的 content（text block 全文 + `[image ×N]` 占位）直接渲染在 inspector 正文，不再只能翻 raw JSON。
- **框选**：inspector body 容器 `select-text`（全局 `user-select:none` 下的内容区恢复点，与 chat 域 WidgetArea 同款范式）；拖选不触发 click，按钮不受影响。

## 4. 验收（真实场景，非单测非 mock）

改动规模：新功能（新 tab + runtime 端口 + 新 extension）。在 dev app（`pnpm dev`）用真实 session 验证，禁止 mock entry 流。每个场景回溯 §1.2 目标。

- **V1（G1/G3，主场景）**：在本仓跑一个真实编码任务（>20 次工具调用，中途手动 `/compact` 一次），完成后切到 Trace 视图：user/assistant/tool/bash/compaction/NOTICE 各行齐全；点 compaction 行 → drawer inspector 可见 summary 全文与 tokensBefore；`firstKeptEntryId` 之前的 message 行影子化标注、保留区（firstKeptEntryId 至 compaction 之间）不影子化，「仅当前 context」toggle 后仅剩 summary + 保留区 + 压缩后 entries——与手工用 `buildContextEntries` 规则对该 JSONL 核算的结果逐条一致。
- **V2（G2）**：同一 session 中途修改设置页 system prompt（`~/.xyz-agent/system-prompt.json`）或改全局 AGENTS.md 后继续对话 → Trace 视图出现 SYSTEM v2 行，reason=change，inspector 可见与 v1 的差异摘要；关闭 app 重开该 session（resume）再发一条消息 → 若 prompt 内容变化则出现 SYSTEM v3 行 reason=resume，若未变则 hash 去重不写新行（顶部「prompt 当前版本」标注不变）——reason 值与去重行为按探针 P2 实测断言。连续点选 v1/v2 两行对比 inspector 内容（B 形态的核心动作）。
- **V3（G1，lifecycle）**：session 中切一次模型、切一次 thinking level、重命名一次 → LIFECYCLE 三行可见且字段正确（对话流里这三者均不可见，对照验证 F4 修复）。
- **V4（G5，实时）**：Trace 视图开着的同时经底部 composer 发新消息 → 新 entries 实时追加到底部；触发一次自动 compaction → 影子化标注即时重排；切回「对话」再切回，过滤/选中状态保留。
- **V5（G4，长 session）**：打开一个 >2000 entry 的真实历史 session（非活跃，走路径 B）切到 Trace 视图 → 首屏 <1s，滚动流畅，翻页加载正常；kind chips 过滤与搜索可用。
- **V6（G1，边界 + B 形态交互）**：fork 出的 session → SESSION 行显示 parentSession 链接，点击跳源 session Trace 视图并高亮 forkEntryId 行；交接过的 session → handoff_marker BOUNDARY 行可见；已结束 session → session_end 终态行可见（来自 sidecar）。点行进 inspector：drawer 未开时自动打开；inspector「← 返回」复原前 tab；split 双 pane 下 pane A 对话 + pane B Trace 同 session 互不干扰。
- **V7（失败路径）**：手工往 JSONL 追加一行坏 JSON → trace 显示「无法解析的 entry」行不崩溃；首条消息前的新 session → 空态文案正确，落盘后自动加载；禁用留痕 extension（feature tier 可禁）→ SYSTEM 行降级文案 + 「现取当前值」仍可用（通道在常驻文件扩展，不经被禁包——pi RPC 无 get_system_prompt 命令）。
- **通过标准**：V1~V7 全部通过。单元测试（entry→行映射纯函数、context 边界计算）仅作回归辅助，不计入验收。

## 5. 下一层拆分

| # | 单元 | 内容 | justification | 独立验收 |
|---|---|---|---|---|
| 1 | 留痕 extension | 新独立包 `@zhushanwen/pi-system-prompt-trace`：首个 turn_start 写 initial/resume（SessionStartEvent.reason 区分）+ 每 turn_start hash 对比写 change（时机见 D2 校正）+ `appendEntry('xyz:system-prompt', …)`；register 进 mandatory-extensions.json **feature tier**（可禁不可卸——V7 要求可禁） | 独立可交付：装上后 JSONL 里即出现留痕 entry，不依赖 GUI | V2 |
| 2 | core 纯函数 | `packages/core/src/domain/session-trace/`：entry→TraceRow 映射、context 边界计算（复刻 buildContextEntries 语义）、影子化标记 | 纯逻辑落 core（绞杀模式），可脱离 Vue 单测；与 pi 语义的一致性用同一 JSONL 双边核算 | 纯函数单测 + V1 核算 |
| 3 | runtime 端口 | `session.getTraceEntries`（A1 混合路由 + header 首行补读）+ 增量（事件触发 + `get_entries(since)` 拉取 → WS `session.traceEntryAppended`）+ sidecar 合并 + WS 消息（带 sessionId，规则 7） | 两条通路归一化是独立的 runtime 工作 | V4/V5 的 runtime 侧 |
| 4 | TraceView 渲染 + inspector | main panel header 加 SegmentedTab（per-pane 视图状态）+ TraceView.vue + 行组件 + 虚拟滚动 + 过滤/搜索/context toggle + 点行联动 drawer（selectedEntryId per-pane + inspector 临时上下文页：选中切入/返回复原/未开自动打开）+ per-session store（ADR-0049） | UI 主体；复用 Block.vue 块形态与 ScrollArea/virtua 设施；联动单向（main→drawer），无双向同步 | V1/V3/V4/V5/V6/V7 |
| 5 | i18n + 边界 | zh-CN/en-US 文案；空态/损坏行/降级文案 | 文案集中收口 | V7 |

**文件改动地图**：新增 `extensions/system-prompt-trace/`（独立包，feature tier；**不考虑并入 unified-hooks**——unified-hooks 不在现有 mandatory 清单，并入需先解决它自身的 builtin 打包内置）、`packages/core/src/domain/session-trace/`、`packages/renderer/src/components/panel/TraceView.vue` 及行组件、drawer inspector 内容页组件；修改 main panel header 容器（SegmentedTab + per-pane 视图状态，遵循现有「视图切换状态驱动」约定）、drawer 容器（inspector 临时页的切入/复原）、runtime `services/ports/session.ts` + session-service + session-message-handler + event-interpreter（事件触发 + since 增量拉 + header 首行补读）、常驻文件扩展（`xyz-agent-extension.js` 或 original-system-prompt-save 常驻插件，加「现取 system prompt」通道）、`mandatory-extensions.json`、两个 locale 文件。**不动** drawer 一级 tab 体系（types.ts 的 SideDrawerTab 不变——inspector 是临时页不是 tab）、不动 message-converter / session-entry-mapper 现有行为（对话流投影不变，trace 是新增并行投影）。

**待验证检查点**（设计期无法确定，实施期定）：`get_entries(since=lastLeafId)` 在 leafId 指向 compaction 之前 entry 时的增量语义（P3）；get_entries 在超大 session（>5MB JSONL）的 RPC 响应耗时（若超阈值则活跃路径打开时也分段）；「事件触发 → since 拉取」的时延对 V4「实时追加」体感的影响。

## 探针清单（运行时行为断言）

| ID | 断言 | 探针 | 状态 |
|---|---|---|---|
| P1 | 路径 A（RPC get_entries）与路径 B（文件直读）对同一 session 产出的 **SessionEntry 序列逐条一致**（header 单独核对——`getEntries()` 不含 header，路径 A 由端口补读） | 单元 3 交付前：取 3 个真实 session 双边拉取 diff | ⛔ 实施期门，不一致则 A1 决策重审 |
| P2 | resume 链路实测：`SessionStartEvent.reason` 在 resume 时为 `"resume"`、首个 turn_start 时 `getSystemPrompt()` 返回含 `before_agent_start` 注入的完整 prompt、留痕 entry 落盘时序正确 | 单元 1 交付前：本地 pi CLI 实测（`pi --mode rpc --extension` + resume 场景，AGENTS.md 要求的实测通道） | ⛔ 实施期门（机制本身源码已定论：session_start 不写、首个 turn_start 写——P2 只验证链路参数） |
| P3 | 增量腿实测：message/compaction/bash/extension appendEntry 四类 append 后，触发事件（message_end/compaction_end/agent_settled/entry_appended）到达且 `get_entries(since)` 能完整拉到新 entry（原断言「entry_appended 每次 append 都广播」已被源码证伪——agent-session.ts:2517 唯一 emit 点） | 单元 3：实测四类操作的事件流 + since 拉取 diff | ⛔ 实施期门 |
| P4 | context 边界纯函数与 pi `buildContextEntries` 输出一致（含多 compaction、无 compaction、branch_summary 场景） | 单元 2：同一 JSONL 双边核算 | ⛔ V1 前置 |
| P5 | 2000+ entry session 首屏渲染 <1s、滚动 60fps | V5 实测 | ⛔ V5 验收时 |
