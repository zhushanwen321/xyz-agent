# Session Trace 设计文档对抗式审查报告

审查对象：`docs/page-design/session-trace/design.md`（271 行，已通读）+ 配套 `trace-tab-demo.html`（888 行，已通读）。
事实核查基线：pi 源码 `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`（0.84.2）+ 本仓 `node_modules/@earendil-works/pi-coding-agent`（0.84.1 dist）双边核对；xyz-agent 代码 `packages/runtime/src/`、`packages/renderer/src/`、`packages/core/src/`、`packages/shared/src/` 实地核对。
审查依据：`tech-design/review/rubric-design-doc.md` P0/P1 清单；项目约定取自 v6-master-spec.md §3.4/§6.3、ADR-0049、AGENTS.md。

## Summary

**5 must-fix, 6 suggestions. 总体结论：需修改后再审。**

骨架、问题定义、方案对比、验收章节本体质量高（P0-1~P0-10、P0-13/14/15 通过）；但**数据通路的事实层有 2 处源码级错误 + 1 处通路遗漏**，其中「`entry_appended` 每次 append 都广播」是 D4 决策与 G5/V4 实时性的承重墙，源码证伪后该腿必须重设计。

## 焦点结论（任务指定的 4 个高风险点）

### 焦点 1：数据通路断言（§3.3 D4 / §2.6）——部分成立，关键一条不成立

| 断言 | 结论 | 证据 |
|---|---|---|
| SessionManager 有 `getEntries()` 返回完整内容 | **成立**（但不含 header，见阻断 #3） | `core/session-manager.ts:1301` `getEntries(): SessionEntry[]`，docstring 明确 "excludes header" |
| RPC `get_entries` 返回 `{ entries, leafId }` | **成立** | dist 0.84.1 `modes/rpc/rpc-types.d.ts:333`（响应）；`rpc-mode.ts:634-644` 实现，支持 `since` 增量参数（rpc-types.ts:64） |
| `appendCustomEntry()` 存在 | **成立** | `agent-session.ts:2514`（extension `appendEntry` 回调内调用 `sessionManager.appendCustomEntry`） |
| `getSystemPrompt()` 存在于 0.84.1 | **成立** | `agent-session.ts:2571` `getSystemPrompt: () => this.systemPrompt`；dist 0.84.1 `core/agent-session.d.ts` 同含 |
| **`entry_appended` 每次 append 都广播** | **不成立（源码证伪，无需探针）** | 全仓仅 1 处 emit：`agent-session.ts:2517`，位于 extension `appendEntry` 回调内；SessionManager 无任何事件机制；dist 0.84.1 `agent-session.js:1868` 同样唯一。**xyz-agent 自己的代码早已记录这一事实**：`event-adapter.ts:710` 注释「entry_appended 在 M5 登记此列——pi extension appendEntry 会 emit，xyz-agent 无前端消费方」 |

后果：§2.6 物理数据流「pi 每次 append 都广播」、D4「已核实 pi 0.84.1 支持……每次 append 时广播」、探针 P3 的预设（compaction/bash/appendEntry 三类都触发）全部错误。普通 message/compaction/bash/lifecycle 的 append **不产生任何 entry 级事件**，G5/V4 的实时增量腿按现文无法工作。修复方向见阻断 #1（代码库已有正确先例，非致命）。

### 焦点 2：system prompt 留痕写入时机——方向可行，session_start 写入点有源码级漏洞

- 可行部分：pi extension 层原生区分时机——`SessionStartEvent.reason: "startup" | "reload" | "new" | "resume" | "fork"`（`core/extensions/types.ts:565`），resume 时 runtime 确实传 `reason: "resume"`（`agent-session-runtime.ts:218/391`）。turn_start 扩展事件存在（`agent-session.ts:744-750`），且触发在 `before_agent_start` override 应用（`agent-session.ts:1265-1271`）**之后**，此时 `getSystemPrompt()` 拿到的是含 xyz-system-prompt-extension 每 turn 注入的最终 prompt（该 ext 每 turn 重读 system-prompt.json 从不缓存，`xyz-system-prompt-extension.js` 头部注释）。V2 的「中途改 system prompt → reason=change」场景在真实环境**可达**。
- 漏洞部分（任务预判成立）：**session_start 时 system prompt 尚未构建完成**，两条独立证据：① session_start emit（`agent-session.ts:2386`）早于 `extendResourcesFromExtensions` 的 prompt 重建（`:2411`，resources_discover 贡献的 skill/prompt 此刻未并入）；② xyz-agent 自己的 `before_agent_start` 注入在 session_start 时根本未发生。在 session_start 写「initial/resume」留痕，记录的 fullText ≠ 实际发给模型的 prompt，且首 turn 必再触发一次误报「change」。P2 探针方向正确，但这一半已可从源码定论，不必等实测。

### 焦点 3：验收章节（§4）——本体通过，V7 有一条自相矛盾（阻断 #5）

V1~V6 均为真实 dev app + 真实 session 的端到端场景，逐条回溯 G 目标，用具体业务例子（dag-executor 重试任务），无 mock/桩/拼装结果，「单测不计入验收」显式声明——P0-13/14/15 **通过**。V5（>2000 entry 历史 session 路径 B，首屏 <1s）与 V6（fork 溯源 + split 对照）路径具体可执行。例外：V7「禁用留痕 extension → 『现取』可用」自相矛盾（详见阻断 #5）；V2 措辞依赖焦点 2 的修复。

### 焦点 4：交互一致性——兼容，2 处建议级偏离

- SegmentedTab 符合 v6 §3.4 tab 型（`v6-master-spec.md:112-118` 核实）；drawer 7 tab 联合类型在 `packages/core/src/domain/drawer/types.ts:19`（terminal/browser/git/doc/detail/subagent/workflow），PanelContainer v-if 链在 `PanelContainer.vue:85-104`——inspector 作临时页不动联合类型的设计与现有机制兼容。
- per-session entry store 走 ADR-0049 `useSessionScopedState`（工厂存在于 `packages/renderer/src/composables/useSessionScopedState.ts`）与 per-pane 视图状态是正交两轴，无冲突。
- 偏离 1：行选中态 `bg-surface-hover + accent-ring 内描边`（§3.1 + demo `.tr-row.selected`）违反 v6 §3.4 列表项型「`bg-surface` + `text-accent`，**无 ring** 无左条」——应援引 SearchModal 型例外（surface-hover + 蓝字、无 ring，因列表底色 = surface 会同色淹没）或在 v6 登记新例外。
- 偏离 2：§2.6 的 WS 命名 `session:traceEntryAppended`（冒号式）与 session 域现有 server→client 广播的点号式不一致（`session.forkNotice`/`session.handoffAborted`/`session.compacting`，`session-message-handler.ts:116/178`）；冒号式是 plugin 域约定（AGENTS.md 规则 16）。

## Findings

| 优先级 | 位置 | 维度 | 问题 + 证据 | 修复方向 |
|---|---|---|---|---|
| MUST_FIX | §2.6 / §3.3 D4 / 探针 P3 | P0-11 事实 | **`entry_appended` 并非「每次 append 都广播」**：pi 唯一 emit 点在 extension `appendEntry` 回调（`agent-session.ts:2517`；dist 0.84.1 `agent-session.js:1868` 同样唯一；SessionManager 无事件机制；xyz-agent `event-adapter.ts:710` 注释早已记录「pi extension appendEntry 会 emit」）。message/compaction/bash/lifecycle append 均无 entry 级事件。D4 的增量腿、§2.6 数据流图、P3 探针预设、§5 检查点「加透传改动小」全部建立在此错误断言上；G5/V4 实时性按现文无法实现 | 增量机制重设计，代码库已有先例：复用现有事件（message_end / compaction_end / agent_settled / entry_appended）作触发信号，runtime 收到后用 `get_entries(since=lastLeafId)` 增量拉（`rpc-types.ts:64` 的 since 参数；`history-rebuild-cache.ts:12-25` 已实测验证 since 行为，pi 0.84.0 起）。D4 改为「事件触发 + since 增量拉」，P3 探针改写为验证「各类 append 后哪个现存事件先到达」 |
| MUST_FIX | §1.1 / §2.6 / demo SESSION 行 | P0-11 事实 | **session 文件物理路径错误**：文档与 demo 写 `~/.xyz-agent/pi/agent/sessions/...`；实际 SSOT 是 `getSessionsDir() = <dataDir>/pi/sessions`（`packages/runtime/src/infra/pi/pi-paths.ts:78-80`，`getPiRoot()=…/pi`；`rpc-client.ts:202-203` 以 `--session-dir` 显式传给 pi）。磁盘实测：`~/.xyz-agent/pi/sessions/` 今天（08-20）有写入；`pi/agent/sessions/` 是 08-18 前的遗留目录——decoy 真实存在，照文档实施会读错目录。该路径出现在功能定义（§1.1）与物理数据流图（§2.6）两处承重位置，而本功能的权威性恰恰建立在「与文件逐行对应」上 | 全部改为 `~/.xyz-agent/pi/sessions/<encoded-cwd>/...`，并注明实现必须走 `getSessionsDir()` 动态推导（路径白名单规则），demo 同步修正 |
| MUST_FIX | §2.6 路径 A / §3.4 SESSION 行 / 探针 P1 | P0-12 遗漏 | **路径 A 拿不到 session header**：`getEntries()` docstring 明确 "excludes header"（`session-manager.ts:1297-1302`），`get_state` 也不含 parentSession（`rpc-mode.ts:446-462` 核实）。§3.4 的 SESSION 行（parentSession 溯源链接，V6 验收依赖）在活跃 session 的路径 A 下无数据来源；§2.6 称 get_entries 为「全量」不准确；P1「逐条一致」未界定 header 差异。另：fork header 的 parentSession 有 sessionId fallback 形态（源未落盘时，`session-lifecycle.ts:521-527`），溯源链接解析需覆盖两种形态 | runtime 端口在路径 A 补读文件首行 header（或从 scanner 元数据取 parentSession/forkEntryId）；P1 改为「SessionEntry 序列逐条一致 + header 单独核对」；§3.4 注明 parentSession 两种形态的解析 |
| MUST_FIX | §3.3 D2 / §4 V2 | P0-11 事实 + P0-16 | **session_start 写入点已被源码证伪**（焦点 2）：session_start emit（`agent-session.ts:2386`）早于 resources_discover 的 prompt 重建（`:2411`），且 xyz-system-prompt-extension 的 `before_agent_start` 注入此刻未发生——在 session_start 写留痕，fullText 必然不完整，首 turn 必误报一次「change」。D2 现文「在 session start / resume 及每个 turn 前」的时机设计在 xyz-agent 真实环境下必踩 | D2 改为：不在 session_start 写 prompt 快照；在**首个 turn_start** 写 initial/resume（reason 取自 `sessionStartEvent.reason`，`types.ts:565` 原生支持 resume/new/fork 区分），后续每个 turn_start hash 对比写 change。P2 探针保留但收窄为「实测 resume 链路 reason 值与 entry_appended 落盘时序」；V2 与 demo 的 #2/#22 行叙事同步调整 |
| MUST_FIX | §3.1 失败路径 / §4 V7 | P0-12 + P0-13 | **V7 降级路径自相矛盾**：「禁用留痕 extension → 『现取当前值』可用」——但 pi RPC **没有** get_system_prompt 类命令（`rpc-types.ts` 全量核实无），`getSystemPrompt()` 只存在于 extension API；被禁用的 extension 不加载，「现取」按钮无后端通道。V7 列入通过标准，按现文无法通过 | 「现取」能力挂到常驻 builtin 文件扩展（xyz-agent-extension.js 经 `--extension` 强制注入、不可禁），或 V7 降级为「仅提示无留痕 + 打开 JSONL 指引」；同时明确留痕 extension 在 mandatory-extensions.json 的 tier（V7 要求可禁 → 须 feature tier，infrastructure 不可禁） |
| SUGGESTION | §3.1 / demo `.tr-row.selected` | P1（项目约定，v6 §3.4） | 行选中态 `bg-surface-hover + accent-ring 内描边` 违反 v6 §3.4 列表项型（`bg-surface` + `text-accent`，明示「无 ring 无左条」）；v6 已有同情形登记例外（SearchModal sm-item：底 = surface 时用 surface-hover + 蓝字、无 ring） | 援引 SearchModal 型例外去掉 ring，或在 v6-master-spec 登记新例外并补 justification |
| SUGGESTION | §2.6 | P1-8 一致性 | WS 命名 `session:traceEntryAppended`（冒号式）偏离 session 域 server→client 广播的点号式现状（`session.forkNotice` 等）；冒号式属 plugin 域约定 | 统一为 `session.traceEntryAppended` 点号式，或文中说明采用冒号式的理由 |
| SUGGESTION | §1.1 术语「当前 context」 | P1-8 精确性 | 定义「= `buildContextEntries()` 的输出」不精确：该输出包含 compaction 之后的 lifecycle/custom entry（`sessionEntryToContextMessages` 对它们返回 0 条消息，`session-manager.ts:380-410` 核实）；§3.4 实际操作的是「转换非空」语义（SYSTEM/LIFECYCLE 永不进 context）。两处措辞不齐，实现期可能把 compaction 后的 SYSTEM v2 行误标为 in-context | 定义为「buildContextEntries 输出中经 sessionEntryToContextMessages 转换非空的 entry」，并与 P4 探针「输出一致」的措辞对齐 |
| SUGGESTION | §5 单元 1 | P1-12 边界 | mandatory-extensions.json 的 tier 未指明；V7 要求可禁用 → 必须 feature tier（infrastructure 3 包不可禁，AGENTS.md 规则 17）；「或并入 unified-hooks」注意 unified-hooks 不在现有 mandatory 10 包清单内，并入则需同步解决 builtin 打包内置问题 | 单元 1 明确「新包 + feature tier」或「并入 unified-hooks 且 unified-hooks 整体进 mandatory 清单」二选一 |
| SUGGESTION | §2.1/§2.2/§2.3 行号引用 | P1-8 事实（细节） | 小漂移合集（均不影响决策，文档自称核实的版本是 0.84.1 但行号取自 0.84.2 源码）：`sessionEntryToContextMessages` 实际在 `session-manager.ts:383`（文档 379）；dist `rpc-types.d.ts:115` 是 get_entries **请求**行（响应 `{entries,leafId}` 在 `:333`）；`session_end` sidecar 函数体至 ~146 行（文档 111-143）；`handoff_marker` 写入体在 `session-file-utils.ts:459`（文档引 439 为 docstring 起）；§4 V2 的 `config.systemPrompt` 实体是 `~/.xyz-agent/system-prompt.json`（`system-prompt-config-helper.ts:21`） | 统一以 0.84.1 dist + 本仓源码重核行号后修正；V2 措辞改「设置页 system prompt（system-prompt.json）」 |
| SUGGESTION | §3.4 vs demo | P1-1 | 行 kind 有 12 种、chip 只有 5 个过滤维度，chip→kind 映射文中未定义；demo 隐含「边界」chip = DATA + SESSION + BOUNDARY（`KIND_GROUPS.data=['data','session']`），「工具」chip 含 TOOL+BASH。DATA（extension 纯数据）归「边界」语义牵强 | §3.4 补一行 chip→kind 映射表，或给 DATA 单独归类并同步 demo |

## 逐项清单覆盖摘要（P0/P1）

- **通过**：P0-1 五段骨架 / P0-2 无 delta 链（外部引用均为锚定非版本链）/ P0-3 结论先行（SCQA + 各章首句结论）/ P0-4 问题定义挖到根因（system prompt 不落盘、converter 丢弃是用户未明说的深层问题）/ P0-5 使用者视角（§3.1 终态 + 样例先行）/ P0-6 术语锚定 / P0-7/8/9 方案对比（决策点 A/B/C/D 均 ≥2 方案、双维度、有裁决）/ P0-10 因果链（补全投影 + 留痕打到根因，前提是阻断 #1~#3 修复）/ P0-13/14/15 验收本体（见焦点 3）/ P0-17 物理数据流图存在 / P0-18 失败路径恢复指引（打开所在目录 / 空态 / 降级 banner）
- **不通过**：P0-11 ×3（阻断 #1/#2/#4）、P0-12 ×2（阻断 #3/#5，其中 #5 兼 P0-13）
- **可能不完整（已转为探针或修复项）**：P0-16 探针机制本身健全（P1~P5 均有 ⛔ 门禁），但 D4 把已被源码证伪的断言标注为「已核实」——探针清单不能替代 main text 的事实诚实
- 参照物一致性：与 streaming-trace-window 的 turn trace 术语分层（§1.1）经核实成立；与 v6 §3.4/§6.3、ADR-0049 的兼容性见焦点 4

## 总体结论

**需修改后再审。** 设计骨架与验收方法论达标，5 个阻断项全部有源码级证据且修复方向明确（#1 有现成先例可循，#2/#3/#5 为事实修正与遗漏补全，#4 是时机参数调整而非机制推翻）。修掉数据通路事实层（#1~#4）与 V7 自相矛盾（#5）后，本方案可进入实现；建议修复后走一轮增量复审（只审改动节）。
