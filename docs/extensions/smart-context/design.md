# pi-smart-context 技术设计

> **层声明**：本文档是**技术方案层**设计——下一层产物是可实现的代码任务（extension 源码 + xyz-agent GUI 接线）。不跨层到具体测试用例与实现细节。
>
> **pi 语义依据**：`@earendil-works/pi-coding-agent@0.84.1`（node_modules 实装版 dist JS/d.ts，已 `npm ls` 核对）。文中所有 pi 行为断言均标注实装文件位置。

**一句话结论**：新建独立 extension `@zhushanwen/pi-smart-context`（`extensions/universal/smart-context/`），通过 `session_before_compact` hook 统一接管所有压缩的 summary 生成（换成配置的廉价模型），注册 `compact_context` 工具把压缩时机交给 agent 自决，并在 `agent_settled` 时按 3 档阈值发一次性提醒；GUI（xyz-agent 设置页）与 config skill 双入口配置。pi 原生 auto-compact 保留为最后防线，不禁用。

---

## 1. 背景目标

### 1.1 SCQA

- **S（现状）**：pi 内建 compaction 有三条触发路径（TUI `/compact` 命令、RPC `compact` 命令、extension `ctx.compact()`），外加自动压缩（上下文接近窗口上限时）。无论哪条路径，summary 一律用**当前会话模型**生成——三条路径在 `agent-session.js` 中全部硬编码 `this.model`（`:1375` manual、`:1602` auto），`CompactOptions`/RPC 命令/settings 均无 model 字段。
- **C（冲突）**：当前会话模型往往是贵的大窗口模型。压缩一次 200K 上下文，输入+输出全按贵模型计费；而压缩本质是"读长对话写短摘要"，廉价小模型完全胜任。同时，自动压缩的触发时机是机械阈值（`contextTokens > contextWindow - 16384`），不看任务边界——任务中途被压缩会丢关键上下文。
- **Q（问题）**：怎么让压缩既**便宜**（用廉价模型执行）又**聪明**（在对的时机压，而不是机械触发）？
- **A（答案）**：pi-smart-context——任务边界信息只在 agent 头脑里，所以把压缩做成工具交给 agent 自决；执行成本用配置的廉价模型；阈值提醒只提供数据与建议，不强制。

### 1.2 系统是什么

- **pi extension**：运行在 pi 进程内的 TypeScript 模块（`export default function smartContextExtension(pi: ExtensionAPI)`），通过 pi 的 extension API 注册工具、监听事件。独立 pi 用户可 `pi install npm:@zhushanwen/pi-smart-context` 单独使用（因此归 `universal/` 分组）。
- **xyz-agent GUI 配置**：桌面端设置页新增 Section，写同一个配置文件，与 extension 热读闭环（复用 rename-session 已验证的模式）。

### 1.3 设计目标（从使用者体验倒推）

1. **agent 自决压缩**：agent 在「任务阶段性完成 && 压缩不影响后续工作 && 上下文超阈值」三个条件都满足时，自己调用 `compact_context` 工具触发压缩。
2. **廉价模型执行**：所有压缩（agent 工具触发、用户 `/compact`、pi 内建自动压缩）的 summary 生成统一用配置的压缩模型。
3. **分档提醒不强制**：3 档可配置阈值（默认 200K/400K/600K token），每档到达时提醒一次；提醒措辞明确"请自行判断"，不构成触发指令。
4. **按模型整体关闭**：当前模型命中排除列表（如 deepseek——缓存极便宜，压缩反而贵）时，工具不注入、不提醒、不接管压缩模型，pi 行为完全原生。
5. **双配置入口**：xyz-agent GUI 设置 + config skill（agent 对话式协助配置）。

### 1.4 Scope

**In scope**：
- 新 extension 包 `extensions/universal/smart-context/`（工具 + 2 个事件 hook + 阈值提醒 + 配置模块 + config skill）
- xyz-agent GUI 设置 Section（压缩模型下拉、3 档阈值、排除列表、总开关）
- 接线：`mandatory-extensions.json`、`extension-dependencies.json`、根 AGENTS.md 包列举

**Out of scope**：
- 不修改 pi 源码、不 fork、不向上游提 PR（项目铁律）
- 不改变 pi 内建 auto-compact 的触发逻辑与切点算法（保留原样作为最后防线）
- 不做压缩质量评估/摘要对比 UI
- 不做 xyz-agent 聊天界面的压缩过程可视化增强（compaction entry 已有既有渲染链路）

---

## 2. 现状与问题分析

### 2.1 pi 原生 compaction 机制（0.84.1 实装）

**触发路径（4 条，全部汇聚到 `AgentSession.compact()` 或 `_runAutoCompaction()`）**：

| 路径 | 入口 | 实装位置 |
|---|---|---|
| TUI slash 命令 | `/compact [instructions]` | `dist/modes/interactive/interactive-mode.js:2392` |
| RPC 命令 | `{"type":"compact","customInstructions":...}`（无 model 参数） | `dist/modes/rpc/rpc-mode.js:416` |
| extension 编程式 | `ctx.compact(options)`，全模式可用 | `dist/core/agent-session.js:1911` |
| 自动 | agent_end 后与 prompt 提交前检查 `shouldCompact` | `dist/core/agent-session.js:1510` |

**压缩流程**（`agent-session.js:1367-1465`）：abort 当前操作 → `prepareCompaction()`（从最新往回累计估算 token，保留约 `keepRecentTokens` 默认 20000，定位切点 `firstKeptEntryId`）→ **emit `session_before_compact`**（extension 可 cancel 或整体替换结果）→ 否则 pi 自己调 summary 生成 → `sessionManager.appendCompaction()` 写入 `type:"compaction"` entry → 重建 `agent.state.messages`（被摘要的旧 entries 全部剔除）→ emit `session_compact`。

**模型选择**：`_getSummarizationRequestAuth(this.model)`（`agent-session.js:1375/1602`）只解析 auth，**不换模型**——三条路径全部固定当前模型。

**关键旁路（本设计的落点）**：`session_before_compact` handler 返回 `{ compaction: CompactionResult }` 即**完全接管 summary 生成**——extension 用任意模型生成后返回，pi 直接落盘并标 `fromExtension=true`（`agent-session.js:1402-1417`）。pi 官方文档明示此用途："Custom compaction (summarize conversation your way)"。

**自动压缩**：阈值 `contextTokens > contextWindow - reserveTokens`（默认 16384）；overflow 场景压缩后重试。可通过 settings.json `compaction.enabled=false` 或 RPC `set_auto_compaction` 禁用。自动路径同样经过 `session_before_compact`（`agent-session.js:1624-1655`）。

### 2.2 使用者视角的真实失败模式

**模式 1：压缩按贵模型计费**。用户在 glm-5.2（贵）上跑长任务，上下文涨到 900K 时内建自动压缩触发：~900K token 输入 + 摘要输出，全部按 glm-5.2 费率计费。同样的摘要质量，用 mimo-v2.5（token 计划内近乎免费）生成成本可忽略。

**模式 2：机械时机打断任务**。内建压缩在 `window - 16384` 触发。一个跨多文件的重构任务进行到一半——改了 6 个文件中的 4 个——压缩把"已改哪 4 个、每个文件的修改意图"压成一段摘要，后续两个文件的修改丢失精确上下文，agent 需要重新读文件重建认知（额外 token + 出错风险）。而如果等 agent 改完所有文件、阶段性验证通过后再压缩，摘要只需保留"改了什么、为什么"，任务中间态全部可以丢弃。

**模式 3：agent 无感知**。agent 不知道当前上下文多大、离窗口上限多远，也就无从规划"什么时候该压缩"。信息不对称：有任务边界知识的一方（agent）没有工具和数据，有工具的一方（pi 内建）没有任务边界知识。

### 2.3 根因

压缩的**执行者**（pi 内建，机械阈值）与**任务边界知识的持有者**（agent）是分离的，且执行成本（模型选择）不可配置。三个失败模式都源于此：
- 模式 1 根因 = pi 把 summary 模型硬编码为会话模型，没有配置出口；
- 模式 2 根因 = 触发权在系统侧，系统不知道任务边界；
- 模式 3 根因 = 用量数据没有送到 agent 手里。

对应的解法就是三个目标的来源：接管模型选择（目标 2）、移交触发权（目标 1）、投递用量数据（目标 3）。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 A：长任务中 agent 自决压缩**

用户在 glm-5.2 上跑一个跨 10 文件的重构，压缩模型配置为 `xiaomi-token-plan-cn/mimo-v2.5`：

```
……重构进行中，上下文涨到 215K……

[系统提醒（200K 档，仅此一次）] 上下文当前 215K / 1000K（21.5%）。已超过第 1 档
提醒阈值 200K。compact_context 工具可用。请自行判断：若当前任务仍在进行中、或近期
仍需引用早期上下文，可忽略本提醒继续工作；若阶段性工作已完成且后续不再依赖早期
细节，可调用 compact_context 压缩（将使用 mimo-v2.5 生成摘要，不影响你的主模型）。

[agent 判断：任务进行到一半，继续]
……重构完成，测试通过，上下文 430K……

[系统提醒（400K 档）] ……（同上格式）

[agent 调用工具 compact_context，参数 custom_instructions="保留每个文件的修改意图与
验证结果，丢弃中间调试过程"]

工具返回（最优态，时序两态契约见 §3.2；降级态下此结果经消息注入送达）：压缩完成。
使用模型 mimo-v2.5；压缩前 431K tokens，压缩后约 24K tokens；
摘要生成成本 432K input + 1.8K output（mimo 费率）。

[agent 继续下一个任务，上下文从摘要 + 保留的最近 20K 起步]
```

**失败路径**：压缩模型 API 调用失败（如凭证失效）→ 工具返回错误，且 `session_before_compact` handler 返回空结果（不 cancel）→ **pi 回退原生路径用当前模型完成压缩**，压缩本身不失败。工具结果中标注"压缩模型 mimo-v2.5 不可用（无凭证），已回退当前模型 glm-5.2；请检查配置"（指向恢复动作：GUI 设置页或 config skill）。

**场景 B：排除模型静默**

用户切到 `deepseek/deepseek-chat`。`model_select` 事件触发门控：`compact_context` 从工具列表移除、提醒逻辑跳过、`session_before_compact` handler 直接返回空（不接管）——压缩模型保持 pi 原生行为。整个 extension 对该会话不可见。

**场景 C：GUI 配置**

xyz-agent 设置页新增 "Smart Context 压缩" Section：总开关、压缩模型下拉（数据源 `settingsStore.models`，只列已配凭证模型）、3 档阈值数字输入（单位 K）、排除模型多选。改动即时落盘 `<agentDir>/config/smart-context-ext-config.json`，extension 每轮事件检查时热读，下一 turn 生效，无需重启。

### 3.2 方案对比

| 维度 | 方案 A：独立 extension（session_before_compact 接管 + 工具 + 提醒）【推荐】 | 方案 B：xyz-agent runtime 侧（RPC 触发） | 方案 C：魔改 pi（compact 加 model 参数） |
|---|---|---|---|
| 原理 | extension 在 pi 进程内监听 `session_before_compact`，用配置模型调 `generateSummaryWithUsage()` 生成摘要，以 `{compaction}` 返回接管；`registerTool` 注册工具；`agent_settled` 检查阈值提醒 | runtime 监听 usage 事件，超阈值时经 stdin JSONL 发 RPC `compact` 命令 | 给 pi 的 `AgentSession.compact()` 加 model 参数并提上游 |
| 换压缩模型 | **能**——接管点在 pi 进程内，唯一合规通道 | **不能**——RPC `compact` 命令无 model 字段，runtime 侧无法注入 | 能，但违反项目铁律 |
| agent 自决 | 能（工具在 pi 层，所有 pi 宿主可用） | 不能（runtime 只能代表用户触发，agent 没有工具） | 能 |
| 原生 pi 用户可用 | **是**（npm 单独安装） | 否（依赖 xyz-agent） | — |
| 长期合理性 | 高：全部走 pi 官方 extension API，pi 升级只受 `session_before_compact` 契约约束（0.84.1 已有，官方文档背书此用法） | 低：功能锁死在 xyz-agent，且核心诉求（换模型）做不到 | 无效方案，直接否决 |
| 短期成本 | 中：1 个新包 + GUI 8 处接线（rename-session 同款成熟模式） | 低但做不成事 | — |
| 风险 | 接管路径对 split-turn（切点在 turn 中间）的 turnPrefix 摘要覆盖度需实施期验证（见 §3.6-R4） | 提醒了也无法廉价压缩，价值残缺 | 违反"不修改 pi 源码"红线 |

**若用方案 B**：§2.2 模式 1 依旧存在（换不了模型），模式 2 部分缓解（提醒数据可以送），模式 3 无改善（agent 没工具）——三个根因只解一个，不合格。

**推荐 A**。方案 A 内部再对比过一个子决策——工具 execute 直接调 `ctx.compact()`（借道 pi 原生流程）vs 手动组 CompactionResult 直接返回（绕过流程）：

- 借道 `ctx.compact()`（**选定**）：切点计算（`prepareCompaction`）、落盘（`appendCompaction`）、上下文重建（`agent.state.messages`）复用 pi 原生实现。**注意边界**：接管 `{compaction}` 返回后，pi 完全采用 extension 给的摘要，原生 `compact()` 的摘要组装段（split-turn 双段合并、fileOps 文件清单追加、previousSummary 增量透传）被绕过——这些必须由接管 handler 自行复刻（见 D11 复刻清单），否则摘要静默丢失已读/已改文件清单与上次摘要。单点接管、处处生效（用户 `/compact`、内建自动、agent 工具三条路径统一）。
- 手动组装：需要自己复刻 appendCompaction + 上下文重建（`agent.state.messages` 重建在 AgentSession 内部，extension 无法触达），不可行。

**工具结果时序契约（fire-and-forget 约束）**：`ctx.compact()` 实装为 `void (async () => { ...; options?.onComplete?.(result) })()`（`agent-session.js:1911-1925`），**不返回 Promise**——工具 execute 无法直接 await 压缩完成。两态策略：

- **最优态**：execute 内 `new Promise`，onComplete/onError 时 resolve/reject，工具调用阻塞至压缩完成、结果直接返回给 agent（是否可行受 R2 探针约束：`this.compact()` 开头 `await this.abort()` 对等待中的工具执行的影响、pi 工具执行有无超时）。
- **降级态**（R2 失败时启用）：execute 立即返回"压缩已启动"，onComplete 后经 `pi.sendMessage` 注入结果消息（deliverAs 选取见 D4 同款权衡），agent 下一轮看到结果。

### 3.3 关键决策与权衡

**D1：压缩模型接管点 = `session_before_compact`，统一接管所有路径（选定）**
被否：只在工具 execute 里换模型——覆盖不了用户 `/compact` 和内建自动压缩；且 pi 落盘与上下文重建必须走原生流程。
证据：`agent-session.js:1402-1417`（manual）与 `:1624-1655`（auto）都检查 handler 返回的 `compaction`；接管后 entry 标 `fromExtension=true`，usage 记录实际 LLM 调用。
效果：即使用户从不让 agent 自决、从不配阈值，只要配了压缩模型，`/compact` 和内建自动压缩也自动变便宜——功能三层价值（模型接管 / 提醒 / 工具）彼此独立生效。
用量归属说明：接管后压缩流量（数十万 token 级 input）计入**压缩模型**的计费与 quota 统计——xyz-agent 用量面板会出现 mimo 等廉价模型用量上涨，这是预期行为而非 bug，GUI 设置页文案需提示。

**D2：pi 内建 auto-compact 保留为最后防线，不禁用（选定）**
被否：禁用内建（`compaction.enabled=false`）完全依赖 agent 自决——agent 不调用就爆窗口报错，把可靠性押在 LLM 的自觉上，不可接受。
证据：内建触发线 = `window - 16384`，远高于本 extension 提醒档（默认 200/400/600K，均低于窗口上限）；overflow 场景内建压缩后还会重试原 prompt（`willRetry`）。
效果：分层防御——agent 自决（理想）→ 内建兜底（保底），且兜底压缩也被 D1 接管为廉价模型。

**D3：提醒时机 = `agent_settled` 事件 + 档位去重 + 压缩后重置（选定）**
被否：`turn_end`（每 turn 都查，run 级联未落定时插提醒会干扰进行中的工作）；`agent_end`（若紧随内建压缩级联，会在压缩中途提醒，语义错乱）。
证据：`agent_settled` 在 run 级联（含 retry/compact 续跑）完全落定后触发（`types.d.ts:544-547`）；`ctx.getContextUsage()` 直接返回 `{tokens, contextWindow, percent}`（`types.d.ts:193-199`，goal extension 有使用先例）。
去重规则：每档一个 fired 标志（session 级闭包状态，`session_start` 重建）；同一次检查中多档同时越过 → **合并成一条提醒**（避免加载大 session 时连发 3 条）；`session_compact` 事件清空全部 fired。防循环：提醒消息本身触发的 turn 落定后，所有已越档位均已 fired，不会重复发（规范「Event handler 消息注入防循环」要求满足）。

**D4：提醒投递 = `pi.sendUserMessage(msg, {deliverAs:"followUp"})`（选定）**
被否：`deliverAs:"nextTurn"`（pi.sendMessage，随下个用户 prompt 进上下文，不触发额外 turn）——agent 无法及时行动，上下文在等待期间继续膨胀，且提醒的时效性丢失。
权衡承认：followUp 会触发一个额外 turn，其 input 是**全上下文重发**（400K 档提醒 ≈400K input，provider 缓存命中时大幅折价、未命中按全价）+ 几 K output，3 档全触发最多 3 次额外 turn——但相比压缩推迟导致的风险（逼近窗口、被迫机械压缩），这个成本可接受。
证据：`types.d.ts:929-934`；先例 `extensions/universal/plan/src/compact.ts:196-208`（compact 完成后 sendUserMessage steer 注入续跑指令）。

**D5：排除匹配 = provider 前缀与 `provider/modelId` 精确两级 + 运行时校验兜底（选定）**
配置条目 `"deepseek"` 命中该 provider 全部模型；`"zai-coding-cn/glm-5.2"` 只命中该具体模型。当前模型从 `ctx.model` 读（`types.d.ts:222-223`，model-switch 的 `getCurrentModelId` 同款）。
门控时机：`session_start`（初始判定）+ `model_select`（切换时重新判定）。切换进入排除模型 → 工具从活跃列表移除；切出 → 恢复。工具启停用 `pi.setActiveTools`（plan/ask-user 有先例，**其白名单语义需实施期核实**，见 §3.6-R5）。

**门控热更矩阵**（配置经 GUI/skill 热改后**不触发** `session_start`/`model_select`，工具列表变更最长延迟到下一次模型切换或会话重建；因此行为正确性不依赖工具移除的时效，由 execute 运行时校验兜底）：

| 状态 | 工具列表 | 工具 execute | 阈值提醒 | 压缩模型接管 |
|---|---|---|---|---|
| enabled=true，模型未排除 | 注入 | 放行 | 生效 | 生效 |
| enabled=true，模型命中排除 | 移除（最迟下次门控时机） | **拒绝**（返回"当前模型已配置为不使用 smart-context"） | 跳过 | 跳过（handler 返回空） |
| enabled=false（GUI 关总开关） | 移除（最迟下次门控时机） | **拒绝**（返回"smart-context 已禁用，可在设置页开启"） | 跳过 | 跳过（handler 返回空） |
| compactModel 未配置/无效 | 注入 | 放行（压缩回退当前模型，见 D7） | 生效 | 跳过（D8 独立降级） |

每次事件回调（`agent_settled` / `session_before_compact` / 工具 execute）都重新 `loadConfig` 热读（D8），矩阵四态在事件现场按最新配置判定——配置变更的**生效**即时，仅**工具图标从列表消失**有延迟（agent 下次尝试调用时得到明确的拒绝消息，指向修复动作）。

**D6：工具带最低阈值保护（选定）**
`compact_context` execute 时校验 `getContextUsage().tokens ≥ 档位最小值`，低于则不执行、返回当前用量与建议（"当前 38K，未达第 1 档 200K，无需压缩"）。`tokens` 为 `null`（压缩后首响应前）时返回"当前用量未知"并拒绝执行——null 窗口期恰好紧随一次压缩完成，此时再压既无必要也有误压风险。
理由：需求三条件 AND 的第三个条件是配置阈值；工具完全放开会在低上下文误调用（浪费一次压缩 + 摘要损失）。同时保护线取最低档而非每档，保留 agent 提前量判断空间（如知道接下来是超大任务，在 190K 时提前压也放行）。

**D7：压缩模型不可用时回退当前模型，不阻断压缩（选定）**
被否：直接报错终止压缩——压缩往往是接近窗口时的关键操作，因配置问题失败代价过高。
行为：`modelRegistry` 解析失败 / 无凭证 / API 报错 → handler 返回空结果让 pi 走原生路径，工具结果与 extension 日志标注回退原因与修复指引（GUI 设置页 / config skill 路径）。

**D8：配置 schema（llm-shared 生态一致）**

```jsonc
// <agentDir>/config/smart-context-ext-config.json
{
  "enabled": true,                                          // 总开关（GUI 开关同源）
  "compactModel": { "type": "ref", "ref": "xiaomi-token-plan-cn/mimo-v2.5" },  // ModelSelector ref
  "reminderThresholds": [200000, 400000, 600000],           // token 绝对数，升序，3 档
  "excludedModels": ["deepseek"]                            // provider 或 provider/modelId
}
```

- 路径经 `@zhushanwen/pi-llm-shared` 的 `getConfigPath("smart-context")` 派生（规范强制，禁止自拼）；
- 读取用 `loadConfig`（mtime+size 读时刷新），**每个 `agent_settled` / `session_before_compact` 触发时重新 load**——GUI/skill 改完下一 turn 生效，与 rename-session 体验一致；
- 未配置 `compactModel`（或 ref 空）时：接管逻辑跳过（压缩保持当前模型），提醒与工具照常工作——三功能独立降级，不互相绑架。

**D9：subagent 子进程禁用（选定，实现方式待验证）**
subagent 是短生命周期任务进程，不应注入 `compact_context`（污染工具列表、浪费）也不应提醒。区分手段（环境变量标记 / spawn 参数识别）在实施期查证 `extensions/universal/subagent-workflow` 的 spawn 协议后落定（§3.6-R6）；**识别失败时的默认行为 = 不注册工具、不提醒**（宁缺勿污，subagent 宁可没有本功能也不能被污染，主进程不受影响）。

**D10：GUI 放 SystemPage 新 Section（选定）**
参照 `SystemAutoRenameSection.vue` 模式（开关 + 模型下拉 + 数字输入 + 多选），接线约 10 处文件改动（rename-session 同构清单，见 §5 文件地图）。

**D11：接管 handler 复刻原生摘要组装清单（选定）**
接管返回 `{compaction}` 后，pi 原生 `compact()` 的摘要组装段被整体绕过（`compaction.js:584-617`），以下三项必须在 handler 内自行完成，否则摘要**静默降质**：

1. **previousSummary 透传**：从 `session_before_compact` 事件的 `preparation` 取上次 compaction 的 summary，传给 `generateSummaryWithUsage(..., previousSummary, ...)`——pi 检测到旧摘要会改用增量合并 prompt（`UPDATE_SUMMARIZATION_PROMPT`）。丢失此项 = 迭代压缩退化成全量重摘，跨多次压缩的任务记忆漂移。
2. **fileOps 文件清单追加**：摘要生成后拼接 `formatFileOperations(readFiles, modifiedFiles)` 等价格式（从 `preparation` 取数据，输出格式对齐 `compaction.js:607-609`）——摘要末尾的已读/已改文件清单是压缩后 agent 快速恢复现场的关键锚点。
3. **split-turn 双段合并**：`preparation.isSplitTurn` 为 true 时，原生路径会对 `turnPrefixMessages` 用 `TURN_PREFIX_SUMMARIZATION_PROMPT` 二次摘要并合并进主摘要。接管路径需同等处理；若 R4 探针证实无法等价复刻，降级为「split-turn 场景不接管、放行原生生成」（切点落在 turn 中间的压缩本就少见，降级面窄）。

### 3.4 架构与数据流

```
┌─ pi 进程 ────────────────────────────────────────────────────────────┐
│                                                                       │
│  session_start ──> 读配置 + ctx.model 门控 ──> 注册/不注册 compact_context │
│       │                                              ▲                │
│       │         model_select ──> 重新门控（setActiveTools + 重置提醒状态）│
│       │                                                               │
│  ┌────┴──────────── 压缩执行流（三条路径统一）────────────┐              │
│  │ agent 工具调用 / 用户 /compact / 内建自动              │              │
│  │        │                                              │             │
│  │        v                                              │             │
│  │  AgentSession.compact()                               │             │
│  │        │  abort -> prepareCompaction(原生切点算法)      │             │
│  │        v                                              │             │
│  │  emit session_before_compact ◄── smart-context handler │             │
│  │        │                     用配置模型调               │             │
│  │        ├─ 返回 {compaction} ──> generateSummaryWith-   │             │
│  │        │   (廉价模型生成的摘要,         Usage(压缩模型)   │             │
│  │        │    pi 直接落盘)                              │             │
│  │        └─ 返回空(排除模型/回退) ──> pi 原生生成          │             │
│  │        v                                              │             │
│  │  appendCompaction -> 重建上下文 -> emit session_compact │             │
│  │                                     │                 │             │
│  │                                     v                 │             │
│  └──────────────────────> 重置提醒 fired 标志 <───────────┘             │
│                                                                       │
│  agent_settled ──> getContextUsage() 越档检查(去重)                      │
│        └─ 越档 ──> pi.sendUserMessage(提醒, {deliverAs:"followUp"})     │
└───────────────────────────────────────────────────────────────────────┘

┌─ xyz-agent 侧（配置写入）────────────────────────────────────────────┐
│  GUI Section ──> WS 'config.setSmartContext*' ──> worktree-config-    │
│  helper（withFileLockSync + atomicWrite）──> smart-context-ext-       │
│  config.json <──（同一文件、同一锁协议）──> extension loadConfig 热读   │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.5 接口契约

**工具 `compact_context`**（typebox schema，顶层 `Type.Object`，规范强制）：

```jsonc
{
  "name": "compact_context",
  "description": "压缩当前会话上下文（用配置的廉价压缩模型生成摘要，不会切换你的主模型）。仅在同时满足以下条件时调用：1) 当前任务的一个阶段已完成并验证（如一批文件改完、测试通过）；2) 后续工作不再依赖将被压缩的早期细节；3) 上下文已超过提醒阈值（你会收到系统提醒）。若任一条件不满足，不要调用。",
  "parameters": {
    "type": "object",
    "properties": {
      "custom_instructions": {
        "type": "string",
        "description": "给摘要模型的指引：哪些信息必须在摘要中保留（如文件修改意图、关键决策、验证结果），哪些可以丢弃（如中间调试过程）"
      }
    },
    "additionalProperties": false
  }
}
```

execute 返回 details：`{ tokensBefore, estimatedTokensAfter, compactModel, usage, fellBack }`（renderResult 数据源，规范要求 details 不依赖 content 文本解析）。

**提醒消息模板**（§3.1 场景 A 已示）：固定结构 = 当前用量数据 + 越档信息 + 工具名 + **三条件自查清单** + 明确的"可忽略"出口。措辞设计原则：提醒是数据投递不是指令，避免 agent 见提醒就压缩（需求明确要求"不要一提醒就触发"）。

**GUI 命令**（protocol.ts 新增，命名对齐 rename 模式）：`config.setSmartContextEnabled` / `config.getSmartContextConfig` / `config.setSmartContextCompactModel` / `config.setSmartContextThresholds` / `config.setSmartContextExcludedModels`（读写统一走 config-service → worktree-config-helper 落盘）。

### 3.6 运行时断言与探针

| # | 断言 | 依据状态 | 探针失败时的降级路径 |
|---|---|---|---|
| R1 | `session_before_compact` 返回 `{compaction}` 后，pi 跳过原生生成、落盘 entry `fromExtension=true`、usage 为压缩模型的实际消耗 | ✅ 已读实装代码（`agent-session.js:1402-1417/1624-1655`）；端到端行为实施期用本地 pi CLI 探针复验 | 探针失败（版本行为漂移）→ 放弃接管，extension 退化为「工具 + 提醒」两功能，压缩模型配置项标注不可用 |
| R2 | `ctx.compact()` 在 tool execute 上下文内可用且挂起 Promise 等 `onComplete` 可行（`AgentSession.compact` 开头 `await this.abort()` 对等待中工具执行的影响、工具执行有无超时） | ⛔ 实施期门：本地 pi CLI `--mode rpc` 实测（plan extension 有同类先例但上下文不同，不可直接外推） | 挂起不可行 → 工具走**降级态**（§3.2）：立即返回"压缩已启动"，onComplete 后经 `pi.sendMessage` 注入结果 |
| R3 | `generateSummaryWithUsage(messages, 压缩Model, ...)` + `ctx.modelRegistry` 解析 auth（apiKey/baseUrl）跨 provider 可用 | ⛔ 实施期门：mimo 压缩 glm 会话实测；`modelRegistry.getAuth` 返回形状精确核对 | 跨 provider 解析不可用 → 走 **D7 回退**：压缩用当前模型完成（功能退化为「工具 + 提醒」，接管仅在压缩模型与会话模型同 provider 时生效） |
| R4 | 接管路径对 **split-turn**（切点落在 turn 中间）的 turnPrefix 摘要覆盖完整（原生路径有 `TURN_PREFIX_SUMMARIZATION_PROMPT` 二次摘要，接管返回的 `CompactionResult` 无 turnPrefix 字段，是否存在摘要损失） | ⛔ 实施期门：构造 turn 中间触发压缩的 session 对比接管前后摘要质量 | 存在损失确认 → **D11-3 降级**：split-turn 场景不接管、放行原生生成 |
| R5 | `pi.setActiveTools(names)` 的语义是全量白名单还是增量启停（影响 D5 切换实现——若为白名单需 `getAllTools()` 差集，有误伤其他 extension 工具的风险） | ⛔ 实施期门：读 `types.d.ts:945-950` 注释 + 实测 | 白名单语义且差集方案有误伤风险 → 放弃动态移除工具：工具常驻注册，排除/禁用态由 execute 运行时校验拒绝（D5 矩阵的拒绝分支本来就是兜底，只是 agent 会在工具列表里看到一个不可用工具） |
| R6 | subagent 子进程的识别手段（环境变量 / spawn 标记；`--mode rpc` 与主进程相同，无法靠 mode 区分） | ⛔ 实施期门：读 subagent-workflow `runSpawn` 协议（`session-runner.ts:650` 一带） | 无识别手段 → subagent 进程**默认不注册工具、不提醒**（宁缺勿污），主进程不受影响；留 WARN 日志待上游提供识别标记后启用 |
| R7 | `getContextUsage()` 压缩后首响应前返回 `tokens: null`（提醒检查需容错跳过，不误判为低用量） | ✅ 实装注释明示（`types.d.ts:193-199`） | — |

---

## 4. 验收

> 全部场景在**本地 pi CLI 实测环境**（`pi --mode rpc --session-dir <dir> --extension <path>`，项目 MANDATORY 流程）或 xyz-agent dev 实例上执行，非单测/mock。阈值在测试中临时调低（如 5K/10K/15K）以降低造数成本，默认值行为单独用配置缺省验证。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| A1 | agent 自决压缩（真实长任务） | 配置压缩模型 mimo；在 glm-5.2 会话跑真实编码任务至超低档阈值；收到提醒后在阶段完成点让 agent 调 `compact_context` | session 文件新增 `compaction` entry（`fromExtension=true`），entry usage 的模型费率对应 mimo；压缩后 agent 能继续执行下一阶段任务且不丢失关键决策上下文（对话可查证其引用摘要内容）；工具结果报告 tokensBefore/After | 目标 1、2 |
| A2 | 提醒分档与去重 | 阈值设 5K/10K/15K；持续对话使上下文越 5K 后继续涨到 11K | 5K 档恰好提醒一次（不重复）；11K 时 10K 档提醒一次；每次提醒是一条消息（多档合并）；压缩后继续对话再次越档会重新提醒 | 目标 3 |
| A3 | 提醒不强制（负面验证） | 越档后明确指示 agent "继续当前任务，暂不压缩" | agent 不调用工具、正常继续；不出现反复催促 | 目标 3 |
| A4 | 排除模型整体静默 | `excludedModels` 配置 deepseek（或任一已配凭证、可切换的 provider/model）；切到该模型 | 工具列表无 `compact_context`；越档不提醒；手动 `/compact` 时 summary 由当前模型生成（原生行为，entry 无 extension 接管痕迹） | 目标 4 |
| A5 | 排除后切回恢复 | 从排除模型切回 glm | 工具重新出现，提醒恢复，压缩被接管 | 目标 4 |
| A6 | 换模型压缩（`/compact` 与内建路径） | 配置 mimo；用户手动 `/compact`；再造内建自动压缩（把 `reserveTokens` 调大逼近当前用量） | 两条路径的 entry usage 均为 mimo 费率——证明接管对全部路径生效 | 目标 2 |
| A7 | 压缩模型回退 | 把 compactModel 配成无凭证模型；触发压缩 | 压缩不失败（当前模型完成），工具结果/日志含回退说明与修复指引 | 目标 2（容错） |
| A8 | GUI 配置闭环 | xyz-agent dev：设置页改压缩模型/阈值/排除列表/总开关 | 落盘 `smart-context-ext-config.json` 与界面一致；不重启 pi 会话，下一 turn 新配置生效（热读）；关总开关后再调 `compact_context` 得到"已禁用"拒绝消息、提醒停止；把当前模型加入排除列表后工具调用得到"当前模型已排除"拒绝消息 | 目标 5 |
| A9 | skill 配置闭环 | 在 pi 会话中要求 agent "把压缩阈值第一档改成 150K" | agent 经 progressive disclosure 读到 `smart-context-ext-config` skill，正确改写配置文件并说明生效时机 | 目标 5 |
| A10 | subagent 不受影响 | 通过 subagent-workflow 派发子任务 | 子进程工具列表无 `compact_context`，不产生提醒 | 目标 1（边界） |

---

## 5. 下一层拆分

### 5.1 实施单元

| # | 单元 | 内容 | justification | 对应验收 |
|---|---|---|---|---|
| U1 | 包骨架 + 配置模块 | `extensions/universal/smart-context/` 目录、package.json（`pi.extensions`/`pi.skills`/role universal/llm-shared 依赖）、`src/pure.ts` 配置 schema/默认值/normalize/`loadSmartContextConfig()` | 配置是一切功能的数据源，先行；纯函数易测 | A8 前置 |
| U2 | 压缩模型接管 | `session_before_compact` handler：门控（D5 矩阵）→ modelRegistry 解析 → `generateSummaryWithUsage`（配置模型，透传 previousSummary）→ 按 **D11 清单**组装摘要（fileOps 追加 + split-turn 处理）→ 返回 `CompactionResult`；失败回退 | 核心价值 1；独立于其他单元可单独验收（`/compact` 即验）。D11 三项缺一即摘要静默降质，实施时逐项对齐原生输出 | A6、A7、R3/R4 探针 |
| U3 | `compact_context` 工具 | registerTool + D6 阈值保护（含 null 分支）+ `ctx.compact()` 时序两态实现（最优态挂起 Promise / 降级态注入，按 R2 探针结果选定）+ execute 内 D5 运行时校验 | 核心价值 2；依赖 U1 | A1、R2 探针 |
| U4 | 阈值提醒 | `agent_settled` 检查 + 档位去重 + 合并提醒 + `session_compact` 重置 + followUp 投递 | 核心价值 3；依赖 U1 | A2、A3、R7 |
| U5 | 排除门控 | `session_start`/`model_select` 门控 + 工具启停 + 提醒跳过 + execute/handler 现场运行时校验（热更矩阵 D5） | 横切 U2-U4 的开关层；热改配置不触发门控事件，运行时校验是正确性兜底 | A4、A5、A8、R5/R6 探针 |
| U6 | config skill | `skills/smart-context-ext-config/SKILL.md`（路径/schema/默认值/示例/生效时机） | 规范强制（有磁盘配置文件的扩展必须带） | A9 |
| U7 | GUI 接线 | protocol.ts 等约 10 处文件改动（§5.2 地图）+ `SystemSmartContextSection.vue` + i18n | rename-session 同款成熟模式，一次接线 | A8 |
| U8 | 清单登记 | `mandatory-extensions.json`（feature 可禁）、`extension-dependencies.json`、根 AGENTS.md 包列举、CHANGELOG/changeset | 规范强制；防 pre-commit/preflight 拦截 | — |
| U9 | 测试与实测 | vitest 单测（pure 函数/handler 逻辑/工具参数校验）+ SDK 契约测试 + GUI 三视角测试 + 本地 pi CLI 实测（全部验收场景） | 项目测试策略（TEST-STRATEGY 三视角红线） | A1-A10 |

### 5.2 文件改动地图

```
extensions/universal/smart-context/          # 新包（U1-U6）
  index.ts                                   # re-export src/index.ts（规范强制形态）
  package.json                               # pi.extensions/pi.skills/role/files/deps
  src/index.ts                               # 入口：事件接线 + 门控
  src/pure.ts                                # 配置 schema/加载/normalize（无副作用）
  src/compact-handler.ts                     # session_before_compact 接管（U2）
  src/tool.ts                                # compact_context 工具（U3）
  src/reminder.ts                            # 阈值检查/去重/提醒消息（U4）
  src/__tests__/                             # 单测 + sdk-contract.test.ts
  skills/smart-context-ext-config/SKILL.md   # U6

packages/shared/src/protocol.ts              # GUI 命令/reply 声明（U7）
packages/runtime/src/transport/settings-message-handler.ts
packages/runtime/src/interfaces.ts
packages/runtime/src/services/config-service.ts
packages/runtime/src/services/worktree-config-helper.ts   # 锁协议对齐 llm-shared
packages/renderer/src/api/domains/settings.ts
packages/renderer/src/components/settings/system/SystemSmartContextSection.vue
packages/renderer/src/components/settings/system/SystemPage.vue
packages/renderer/src/i18n/locales/{zh-CN,en-US}/settings.ts

packages/shared/src/mandatory-extensions.json # U8
extension-dependencies.json
AGENTS.md                                     # 全集列举更新
docs/extensions/smart-context/design.md       # 本文档
```

### 5.3 实施期待验证检查点（设计未定死、按探针结果落定）

1. R2/R3/R4/R5/R6 五个探针（§3.6）在 U2/U3/U5 开工首日先行执行，结果回写本文档（探针失败按各自备注的降级路径调整方案）；
2. `generateSummaryWithUsage` 的 `reserveTokens` 传参来源（pi 原生用 `settings.compaction.reserveTokens` 默认 16384——接管时读同一 settings 保持一致，还是用 `summary maxTokens = min(0.8*reserveTokens, model.maxTokens)` 反推）——以「摘要长度与原生路径一致」为验收锚点；
3. GUI 排除列表的交互形态（模型多选 tag vs 手输 provider）在 U7 实施时按 `settingsStore.models` 数据结构定。

---

## 附：与既有规范的一致性核对

- 目录/role：`universal/`（独立 pi 用户可单独安装）+ `package.json` 声明 `xyz-agent.role: "universal"` ✅
- 配置路径：`getConfigPath("smart-context")` 派生 `config/smart-context-ext-config.json` ✅
- skill 命名：`smart-context-ext-config`（与配置文件同名配对）✅
- 工具 schema：顶层 `Type.Object`（OpenAI 兼容红线）✅
- 事件注入：`pi.sendUserMessage`（非 `ctx.sendUserMessage`）+ 防循环去重 ✅
- session 隔离：提醒 fired 状态存 `session_start` 重建的闭包 ✅
- 依赖声明：`extension-dependencies.json` 登记 `@zhushanwen/pi-llm-shared`（package 类型）✅
- 验证流程：本地 pi CLI 实测优先（非 xyz-agent 桌面）✅
