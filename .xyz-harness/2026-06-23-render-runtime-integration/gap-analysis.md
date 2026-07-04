# 前端功能 ↔ runtime 后端接口 对接缺口全景分析

> **日期：** 2026-06-23
> **基准分支：** `refactor-arch-render-runtime`
> **前置：** 派工单 [plan.md](./plan.md) 第 1+2 项已完成（全局推送链路修复 + mock 契约化改造，commit `74868a15` / `2ba98155` / `0002131f` / `9895610c`）。
> **本文用途：** 派工单范围之外（第 3 项真实集成 + 第 4 项协议缺口）的前置全景调研。第 3/4 项计划以此为输入裁剪范围。
> **方法论：** 按前端骨架（[ui-skeleton.md](../../../docs/page-design/v3/ui-skeleton.md) §3 区域-模块树）拆 7 个模块，每模块派 Explore subagent 扫描，控制器汇总。

---

## 0. 速读：两个直接问题的答案

### Q1：派工单还有未完成任务吗？

**否。** 派工单 8 个 Task（T0~T7）全部完成，工作区干净。派工单本身有意划定了边界（plan.md「不在本计划范围」明确第 3 项真实集成、第 4 项协议缺口不碰）——所以「派工单未完成」≠「无缺口」，下面的分析全是派工单范围**之外**的。

### Q2：前端 mock 用到了后端接口，还是全新 mock？

**两套并存，门面已就绪，但组件消费层大量断链。**

- `api/domains/*.ts`（real）走 `transport + pending + events`，已按三类契约（请求/订阅/动作）定义齐全。
- `api/mock/index.ts` 按 `VITE_MOCK` 切换，签名与 real 一一同构（门面三元成立）。
- **但组件层三类断法：**
  1. **绕过门面硬编码 fixture**：如 `Sidebar.vue` 直接 `import { fixtureFileChanges }`、`ContextChipsBar.vue` 直接 `import { MOCK_ATTACHED_CONTEXT }`。
  2. **动作 handler 空壳**：如 Composer 的 `onModelSelect` / `onThinkingSelect` 只改本地 ref 或空函数，标 TODO。
  3. **订阅骨架 handler 空**：如 `CommandPopover` / `ContextCapacityPopover` 订阅了 `session.commands` / `context.update`，但 handler 体是 TODO，用静态 fallback。

**一句话：domain 契约化了，组件没接。**

---

## 1. 缺口分类框架（4 类，按 ROI 排序）

| 类别 | 含义 | ROI | 标记 |
|------|------|-----|------|
| **A 类** | 后端就绪 + 前端 domain 就绪 + **组件未接** | 最高（纯接线） | 🟢 |
| **B 类** | 后端就绪 + 前端 domain 缺 + 组件未接 | 高（补 domain + 组件） | 🟡 |
| **C 类** | **协议缺口**（protocol.ts 无定义），前后端都需补 | 中（先设计协议） | 🔴 |
| **D 类** | v1 有意 DEFERRED（设计上不做） | —（不做） | ⚪ |

> 下文每条缺口标注类别。A 类是「最快出价值」的接线活，建议第 3 项计划优先消化。

---

## 2. 七模块缺口明细

> 模块划分依据 [ui-skeleton.md](../../../docs/page-design/v3/ui-skeleton.md) §3 区域-模块树 + 现有 `components/` 目录结构。

### 2.1 Shell（窗口外壳）· `components/shell/`（5 文件）

**性质：** 纯展示 + Electron IPC 层。与 runtime 唯一耦合是 `useConnection` 维持的 ping/pong 心跳；窗口控制/全屏/端口发现走 Electron main 进程 IPC（绕开 runtime WS，属正确边界）。

| 缺口 | 类别 | 说明 |
|------|------|------|
| `plugin:statusBarUpdate` / `plugin:statusSetUpdate` / `plugin:notification` 无宿主 | 🟢 A | 协议已定义（protocol.ts:188-191），runtime 不推、前端无 StatusBar / 通知中心组件，**两端皆空** |
| 全局错误 / 断线提示无 UI | 🟡 B | `error` envelope 只被 `pending.reject` 静默吞；`useConnection.state`（disconnected/connecting/reconnecting）闲置；Shell 缺连接状态 banner / SystemNotice 兜底 |

**结论：** Shell 缺口集中在 plugin 通知宿主 + 连接状态可见性。

---

### 2.2 Sidebar（侧边栏）· `components/sidebar/`（8 文件）

已对接：`session.list/create/switch/rename/delete`（走 `useSidebar`）、`session.history`（间接 hydrate）、`gitBranch`（后端 session-scanner 真实填充）。

| 缺口 | 类别 | 说明 |
|------|------|------|
| **FileView 文件改动硬编码** | 🔴 C | `Sidebar.vue:170` 直接 `import { fixtureFileChanges }`（绕过门面）。**`message.file_changes` 协议类型未定义**，store `applyFileChanges` 是 `throw` 空壳（ADR-0024 待落地），runtime 无文件改动聚合 port。整条链路断 |
| 会话「项目分组」UI 缺失 | 🟢 A | 后端 `listPersistedSessions()` 返回 `SessionGroup[]`（按 cwd 分组），前端 domain 扁平化成 `SessionSummary[]` **丢失分组结构**，SessionList 平铺渲染 |
| 会话状态点 waiting/stopped 真实信号 | 🟡 B | 当前从 message 字段前端派生（`DerivedStatus`），代码标 TODO「待 pi tool 事件细化」 |
| 技能入口 / 项目切换器 / 底部模型入口 | ⚪ D | ui-skeleton §47/§51/§52 列了但未实现 |

**FileView 专项：** 后端 `ports/tree.ts` 是 **pi JSONL 会话树解析**（TreeNode = 会话消息树节点），**不是文件系统树**，与 FileView 的文件改动树无关。`file.read`（protocol.ts:99）仅限 skill 目录读取，非通用文件读取。

---

### 2.3 Panel-Chat 消息流（**缺口最密集**）· `components/panel/message-stream/`

已对接：`message_start/text_delta/thinking_start/thinking_delta/tool_call_start/tool_call_end/complete/error/stream_error`。

**`message.*` ServerMessage 消费矩阵（核心产出）：**

| ServerMessage type | 前端消费 | mock 实现 | real 实现 | 缺口 |
|---|---|---|---|---|
| `message_start` / `text_delta` | ✅ | ✅ | ✅ | —（message_start 丢弃 customType/details，轻量） |
| `thinking_start` / `thinking_delta` | ✅ | ❌ | ✅ | mock 不出 thinking 流（仅历史 fixture 有静态） |
| **`thinking_end`** | ❌ | ❌ | ✅ | 🟢 store switch 缺 case，`ThinkingBlock.endTime` 永不回填 → ReasoningBlock 计时无法实现 |
| `tool_call_start` / `tool_call_end` | ✅ | ❌ | ✅ | mock 缺工具流 |
| `tool_call_pending` | ❌ | ❌ | ❌ | ⚪ 死类型（runtime 不产出，Flow-3 工具审批预留） |
| **`tool_call_update`**（进度） | ❌ | ❌ | ✅ | 🟢 后端 `handleToolExecutionUpdate` 已推，前端不接 → 长时工具无进度 |
| `complete` | ✅ 部分 | ✅ | ✅ | 🟢 丢弃 `usage`/`responseModel`/`diagnostics`（Context 容量条/模型回显无数据源） |
| `error` / `stream_error` | ✅ | ❌ | ✅ | — |
| **`status`**（pi server-push） | ❌ | ❌ | ✅ | 🟢 event-adapter pi `status` 事件被 store 丢弃 → steer/aborted 队列态无 UI 回显 |
| **`bashExecution`** | ❌ | ❌ | ✅ | 🟢 bash exitCode/截断/fullOutputPath 后端推了，前端无独立 UI |
| **`compactionSummary`** | ❌ | ❌ | ✅ | 🟢 上下文压缩摘要无 UI |
| **`branchSummary`** | ❌ | ❌ | ✅ | 🟢 分叉摘要无 UI（Overview 卡片改动指标也无消费） |
| **`auto_retry_start` / `auto_retry_end`** | ❌ | ❌ | ✅ | 🟢 限流自动重试无指示器（SystemNotice 缺失场景） |
| **`queue_update`** | ❌ | ❌ | ✅ | 🟢 steer/followUp 队列内容不可见（useChat 注释自承「pending 气泡渲染 DEFERRED」） |
| `context.update` | ❌ | ❌ | ✅ | 🟢 前端 0 消费，ContextCapacityPopover 无真实数据源 |

**ChangeSetCard / 变更集专项：** 🔴 协议缺口（`message.file_changes` 未定义）+ store `applyFileChanges` throw 空壳 + 组件不存在。类型契约（`shared/message.ts` 的 `FileChange`/`ChangeSetStatus` 5 态机）已就绪但全链路 DEFERRED（ADR-0024）。

**Markdown 渲染待复核：** feature-map 称已完成（Shiki 高亮），但 subagent 发现 `Block.vue` 的 summary 是纯 `{{ summaryText }}`，未走 Markdown 解析器。需复核是否回归或仅部分组件未接。

**消息组件降级实现：** v3 ui-skeleton §3 列的 7 类独立块组件（UserMessage/AssistantMessage/ReasoningBlock/ToolCallCard/ChangeSetCard/ConfirmRequest/SubAgentNode/SystemNotice）**没有一个作为独立组件存在**——全部降级成 `Block.vue` 的内部 type 分支 + `Turn.vue` 的 user/assistant 模板。

---

### 2.4 Composer（输入区）· `components/panel/`（Composer + 6 Popover）

已对接：`message.send/steer/followUp/abort`（走 `useChat`）。`ModelSelectPopover` 列表已订阅 `model.onModels`（近期改）。

**各动作 runtime 对接矩阵（核心）：**

| 用户动作 | 应调接口 | 现状 | 类别 |
|---|---|---|---|
| 切模型 | `model.switchModel` + 订阅 `model.switched` | **未接**（`onModelSelect` 仅 `currentModelId.value = modelId`，标 `TODO(后续)`）。domain + runtime handler 都就绪 | 🟢 A |
| 切思考等级 | `session.setThinkingLevel` + 订阅 `thinkingLevelSet` | **未接**（`onThinkingSelect` 空函数）。domain 缺 `setThinkingLevel` 包装方法 | 🟡 B |
| 选 slash 命令 | 订阅 `session.commands` | **半接**（订阅骨架在，handler 空，用静态 `/commit /review /fix`）。**注：runtime payload 已契约化**（`{name,description,source}`），前端「未契约化」注释已过时 | 🟢 A |
| context.update 消费 | 订阅 `context.update` | **半接**（handler 空）。runtime payload `{sessionId,usagePercent,inputTokens,contextLimit}` 与前端 `ContextStats{used,total,percent,cacheHit,modelId}` **字段名不一致 + 缺 cacheHit/modelId** | 🟢 A |
| @/# 引用、附件、上下文 chip 增删 | 无协议通道 | `ContextChipsBar` 硬编码 `MOCK_ATTACHED_CONTEXT`；`AddMenuPopover` 附件入口 early-return；`onRemove` 空函数 | 🔴 C |

**关键观察：** Composer 是所有缺口的汇聚点——`onModelSelect`/`onThinkingSelect`/`onAddSelect(attach)` 三个 handler 是空壳或 early-return，且 `props.sessionId` 已在，调 runtime 不缺上下文。ModelSelect 形成「看得到真实模型列表但点了没效果」的半成品态。

---

### 2.5 Settings（**CRUD 全断**）· `components/settings/`（7 文件）

**核心发现：** 对整个 `components/settings/` 目录 grep 所有 CRUD 接口名（`setProvider/deleteProvider/setSkill/.../scanSkills/.../extension.*/plugin.*`）—— **零匹配**。连已就绪的 `settings.setProvider` 都没人调。7 组件全是纯展示骨架。

**各域 CRUD 对接矩阵（后端 handler 以 `settings/extension/plugin-message-handler.ts` 实际 switch case 为准）：**

| 域 | 动作 | 后端 handler | 前端 domain | 前端组件对接 | 类别 |
|---|---|---|---|---|---|
| Provider | 列表/订阅 | ✅ | ✅ | ✅（SettingsModal 订阅） | — |
| Provider | **setProvider/deleteProvider** | ✅ | ✅ | ❌ | 🟢 A |
| Provider | **discoverModels** | ✅（真实 fetch `/v1/models`） | ✅ | ❌（ProviderEditModal 用 `setTimeout(1000)` 假装） | 🟢 A |
| Skill | **scanSkills/setSkill/deleteSkill** | ✅ | ✅ | ❌（只读列表，无编辑入口） | 🟢 A |
| Agent | **scanAgents/setAgent/deleteAgent** | ✅ | ✅ | ❌ | 🟢 A |
| Extension | **toggle** | ✅ | ✅ | ❌（checkbox 无 @change） | 🟢 A |
| Extension | **install/uninstall/installDir/installGit/finishInstall/cancelInstall** | ✅（4 handler 完整多步流程） | ❌ | ❌（安装按钮无 @click） | 🟡 B |
| **Plugin** | **全部 plugin.\*（10 接口）** | ✅（permissions/worker/config 完整） | ❌（仅 `onPlugins` 骨架） | ❌（**无 PluginPage**） | 🟡 B |
| Provider | 设默认/testConnection/加载路径管理 | ❌（无协议） | ❌ | ❌（本地 ref） | 🔴 C |
| System | locale/theme/themePreset | —（纯前端） | ✅（localStorage） | ✅ | —（设计如此） |
| System | 快捷键/关于/字体密度 | — | — | ❌（SystemPage 缺） | ⚪ D |

**Extension install 全流程专项：** 后端 `extension-message-handler.ts:104-160` 实现完整多步流程（`installDir/installGit → discovered{tempDir,candidates} → finishInstall(selected) → config.extensions 刷新`），前端 0 实现，连安装按钮的 @click 都没绑，缺「候选选择」二次 UI。

**Plugin 影子域专项：** 后端 Plugin 能力（permissions 审批、worker 隔离、config 存储）明显比 Extension 重，但前端 Settings 只认 Extension（菜单「Extension / 管理 MCP 扩展」），**Plugin 整条线在 UI 层不存在**。是产品决策还是遗漏需澄清（见 §5 决策点）。

---

### 2.6 Overview / Overlays / Workspace · `components/{overview,overlays,workspace}/`

feature-map 说 Overview「仅骨架 + 入口隐藏」**准确**——卡片网格有真数据（复用 `session.list`），Workspace 双 Panel 状态机已落地。

| 缺口 | 类别 | 说明 |
|------|------|------|
| SearchModal 会话类用静态 mock 而非 `session.list` | 🟢 A | store 有真数据却硬编码 4 条假会话（最低成本修复） |
| SearchModal `select` 事件父组件未接入 | 🟢 A | emit('select') 透出但 Sidebar 无 handler，选中后无响应 |
| `plugin.executeCommand` domain 方法缺 | 🟡 B | 协议就绪（protocol.ts:25），命令面板无法触发 |
| `message.branchSummary` 卡片改动指标 0 消费 | 🟢 A | 协议就绪，SessionCard 的 +N/−M 指标恒隐藏 |
| 概览卡（任务数/Token/活跃agent）、Background Agent、活动时间线 | ⚪ D | v1 DEFERRED，协议也未设计 |
| 全局搜索后端接口（跨项目文件/符号检索） | ⚪ D / 🔴 C | DEFERRED |

---

### 2.7 树形引擎 / SubAgent（**产品护城河，缺口最大**）

feature-map 实事求是：**树形引擎 0%，SubAgent 数据流 ~10%**。

| 子功能 | 后端 | 前端 | 类别 |
|--------|------|------|------|
| **tree-\* 全套**（tree-data/navigate/fork/clone/capability） | ✅ 100%（`TreeService` + `tree-message-handler.ts` + `ports/tree.ts` 完整，装配进 server） | ❌ 0%（无 api domain、无 TaskTree 组件、`forkSession` 用 mock `sessionApi.create()` 替代，**绕过 pi 真实 fork**） | 🟡 B（**后端孤岛**） |
| SubAgent 并行编排（拆解→派发→聚合→steer 个体→汇总） | ❌ ~10%（仅 `sendSubagentMessage` 单次 marker 注入，**无编排调度器/多进度聚合/个体 steer**） | ❌ 0%（无 SubAgentNode/ConfirmRequest/Side Drawer Detail 组件） | 🔴 C（前后端都没有） |
| 工具审批（`tool.approve/deny/always_allow`） | stub-only（`settings-message-handler.ts:116` 空 ACK `return true` 丢弃） | ❌ 0%（`Block.vue:8` 标「审批按钮 DEFERRED G-018」） | 🔴 C（两端皆空，仅协议 SSOT 就绪） |
| TaskTree 可视化、ConfirmRequest、SubAgent Detail Drawer | — | ❌ 0% | 🔴 C |

**tree-\* 专项：** 后端是「能力完整、前端零对接」的典型孤岛。`TreeService` 是从 SessionService 巨石拆出的成熟模块（含 navigate 拦截器、JSONL 解析、fork/clone 共享骨架），但 renderer 连 api/domain 函数都没有。

---

## 3. 横向汇总：最高 ROI 的「A 类纯接线缺口」

> 这些是**后端就绪 + 前端 domain 就绪，只差组件接一下**的。建议第 3 项计划优先消化，1-2 天工作量即可让 mock→real 切换真正可用。

| # | 缺口 | 对接点 | 消费方 |
|---|------|--------|--------|
| 1 | Composer 切模型 | `model.switchModel` + 订阅 `model.switched` | `Composer.onModelSelect` |
| 2 | Composer 切思考等级 | 新增 `session.setThinkingLevel` domain + 接线 | `Composer.onThinkingSelect` |
| 3 | CommandPopover slash 命令 | 解析 `session.commands` payload（已契约化） | `CommandPopover` 订阅 handler |
| 4 | ContextCapacityPopover | 消费 `context.update`（字段名映射） | `ContextCapacityPopover` 订阅 handler |
| 5 | Settings Provider CRUD | `setProvider/deleteProvider/discoverModels` | `ProviderPage` / `ProviderEditModal` |
| 6 | Settings Skill/Agent CRUD | `scanSkills/setSkill/deleteSkill` + Agent 同构 | `SkillPage` / `AgentPage` |
| 7 | Settings Extension toggle | `extension.toggle` | `ExtensionPage` checkbox |
| 8 | 消息流 6 个未消费 message.\* | store `appendAssistantChunk` switch 补 case | `stores/chat.ts` |
| 9 | Sidebar 会话分组 | 消费后端 `SessionGroup[]`（domain 改返回类型） | `SessionList` |
| 10 | SearchModal 会话类真数据 | 用 `session.list` 替代硬编码 + 接入 select | `SearchModal` |

---

## 4. 协议层真缺口（🔴 C，需先设计再实现）

| 缺口 | 影响范围 | 优先级 | 备注 |
|------|---------|--------|------|
| `message.file_changes`（ServerMessage type） | ChangeSetCard + FileView 变更集 | 最高 | ADR-0024 已就绪待落地，类型契约（`FileChange`/`ChangeSetStatus`）已在 `shared/message.ts` 定义 |
| 上下文条目增删 / 附件上传通道 | ContextChipsBar 无法 runtime 化；AddMenu 附件入口永久 disabled | 高 | `context.update` 只推用量不推条目清单 |
| @/# 搜索通道（`file.search`/`symbol.search`） | CommandPopover @/# 永远静态 | 中 | 后端搜索能力从零 |
| `ServerMessageMap`（ServerMessage payload 强类型） | 所有订阅靠手抄字段名 | 基础设施 | `ServerMessage.payload` 现是 `Record<string, unknown>`，无类型守卫——这是前端反复标「payload 未契约化」TODO 的根因 |
| SubAgent 编排调度（派发计划/多进度聚合/个体 steer/汇总） | Flow-3 产品护城河 | 低（长期） | 前后端都没有，需整体设计 |

---

## 5. 需要决策的点

1. **Plugin 是否进 Settings？** 后端有完整 plugin.* 能力（10 接口 + permissions/worker/config），前端 0 出口。是产品决策（只做 Extension 不做 Plugin）还是遗漏？—— **影响是否要新建 PluginPage + plugin domain 动作方法。**
2. **Flow-3（SubAgent 编排）何时启动？** 产品护城河，但前后端都大量缺失（编排调度器、多进度聚合、个体 steer 后端都没有）。tree-* 后端已就绪可先接（前端纯组件工作）。
3. **Markdown 渲染复核：** feature-map 称已完成（Shiki），subagent 发现 `Block.vue` summary 是纯文本。需确认是回归还是部分组件未接。
4. **第 3 项计划范围：** 建议先做 §3 的 A 类纯接线（立即可用），协议缺口（§4）单列第 4 项设计。

---

## 6. 与现有文档的关系

| 文档 | 关系 |
|------|------|
| [plan.md](./plan.md) | 第 1+2 项已完成。本文是其「下一步」的输入 |
| [contract.md](./contract.md) | domain 契约表。本文缺口标注的「domain 就绪」以它为准 |
| [tasks.md](./tasks.md) | T0~T7 派工单。本文是 T7 之后的缺口全景 |
| [feature-map/2026-06-20.md](../../docs/feature-map/2026-06-20.md) | 完成度估算（聊天核心 ~70%、SubAgent ~10%、树形引擎 0%）。本文是这些百分比的细化拆解 |

---

## 附录 A：扫描覆盖的模块与文件路径

| 模块 | 组件目录 | 关键编排层 | 关键后端 handler |
|------|---------|-----------|-----------------|
| Shell | `components/shell/` | `composables/useConnection.ts`、`effects/usePlatformChrome.ts` | `transport/server.ts`（sendInitialState） |
| Sidebar | `components/sidebar/` | `composables/features/useSidebar.ts` | `transport/session-message-handler.ts`、`services/session/session-scanner.ts` |
| Panel-Chat | `components/panel/message-stream/` | `composables/features/useChat.ts`、`stores/chat.ts` | `infra/pi/event-adapter.ts`、`services/session/message-dispatcher.ts` |
| Composer | `components/panel/`（Composer + Popover） | `Composer.vue` | `transport/settings-message-handler.ts`（model.switch/setThinkingLevel） |
| Settings | `components/settings/` | `SettingsModal.vue` | `transport/{settings,extension,plugin}-message-handler.ts` |
| Overview/Overlays/Workspace | `components/{overview,overlays,workspace}/` | `composables/features/useSidebar.ts`、`stores/panel.ts` | `transport/session-message-handler.ts` |
| 树形/SubAgent | （前端无组件） | `composables/features/useSidebar.ts`（forkSession mock） | `services/tree-service.ts`、`transport/tree-message-handler.ts`、`services/ports/tree.ts` |
