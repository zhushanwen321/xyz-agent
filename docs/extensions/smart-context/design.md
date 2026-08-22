# pi-smart-context 技术设计

> **层声明**：本文档是**技术方案层**设计——下一层产物是可实现的代码任务（extension 源码 + xyz-agent GUI 接线）。不跨层到具体测试用例与实现细节。
>
> **pi 语义依据**：`@earendil-works/pi-coding-agent@0.84.1`（node_modules 实装版 dist JS/d.ts，已 `npm ls` 核对）。文中所有 pi 行为断言均标注实装文件位置。

**一句话结论**：新建独立 extension `@zhushanwen/pi-smart-context`（`extensions/universal/smart-context/`），通过 `session_before_compact` hook **完全接管所有压缩路径的 summary 生成**（双模式：压缩模型 == 当前模型时走 same-model harness——原上下文 + 追加压缩指令，kv-cache 前缀全命中；否则走 cross-model 摘要化——廉价模型 + 最小输入），注册 `compact_context` 工具把压缩时机交给 agent 自决，`agent_settled` 时按 3 档阈值发一次性提醒，`model_select` 跨界切换注入工具可用性通知；GUI（xyz-agent 设置页）与 config skill 双入口配置。pi 内建 auto-compact 的**触发线**保留为最后防线，其压缩执行走 extension 逻辑；落盘 entry 带 `fromExtension=true` + `details.engine/mode` 标记。

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
2. **廉价压缩执行，双模式**：所有压缩（agent 工具触发、用户 `/compact`、pi 内建自动压缩）的 summary 生成统一由 extension 接管——压缩模型 == 当前模型时走 **same-model harness 模式**（原上下文 + 追加压缩指令，kv-cache 前缀全命中，tool result 不截断）；压缩模型 ≠ 当前模型时走 **cross-model 摘要化模式**（廉价模型 + 最小化摘要输入）。非排除态下 pi 原生生成路径不再执行（完全替代），落盘 entry 携带 extension 引擎标记。
3. **分档提醒不强制**：3 档可配置阈值（默认 200K/400K/600K token），每档到达时提醒一次；提醒措辞明确"请自行判断"，不构成触发指令。
4. **按模型整体关闭**：当前模型精准命中排除列表（完整 `provider/modelId` 等值匹配，如 `deepseek/deepseek-chat`——缓存极便宜，压缩反而贵）时，工具拒绝、提醒跳过、压缩生成回落 pi 原生；模型切换跨界时注入一条可用性变化通知（不每轮注入）。
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

**场景 A：跨模型压缩（cross-model，当前 glm-5.2 + 压缩模型 mimo）**

用户在 glm-5.2 上跑一个跨 10 文件的重构：

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
使用模型 mimo-v2.5（cross-model 模式）；压缩前 431K tokens，压缩后约 24K tokens；
摘要生成成本 432K input + 1.8K output（mimo 费率）。

[agent 继续下一个任务，上下文从摘要 + 保留的最近 20K 起步]
```

**场景 A'：同模型压缩（same-model，压缩模型 = 当前模型，kv-cache harness）**

用户把压缩模型配成与会话一致的 `zai-coding-cn/glm-5.2`。agent 调 `compact_context` 后：

```
工具返回：压缩完成。使用模型 glm-5.2（same-model 模式，KV 缓存命中）；压缩前 431K
tokens，压缩后约 26K tokens；摘要生成成本：新增 input 仅压缩指令 0.9K（其余 431K
前缀缓存命中）+ 2.4K output。
```

模型收到的是**完整原始对话**（tool result 未截断）+ 末尾一条压缩指令——摘要质量与成本同时最优（usage 的 cacheRead 字段可验证缓存命中，见验收 A1'）。

**失败路径**：压缩模型 API 调用失败（如凭证失效）→ 工具返回错误，且 `session_before_compact` handler 返回空结果（不 cancel）→ **pi 回退原生路径用当前模型完成压缩**，压缩本身不失败。工具结果中标注"压缩模型 mimo-v2.5 不可用（无凭证），已回退当前模型 glm-5.2；请检查配置"（指向恢复动作：GUI 设置页或 config skill）。

**场景 B：排除模型静默 + 切换跨界通知**

用户从 glm-5.2 切到 `deepseek/deepseek-chat`（在排除列表中，精准匹配）。`model_select` hook 检测到跨界，注入一条消息：

```
[系统消息] 压缩工具暂时不可用：当前模型 deepseek/deepseek-chat 已配置为排除
（smart-context），本会话将使用 pi 原生压缩行为。
```

此后 agent 不再调用该工具（若仍调用，execute 拒绝并返回原因）；越档不提醒；手动 `/compact` 走 pi 原生生成。切回 glm-5.2 时注入"压缩工具恢复可用：当前模型 zai-coding-cn/glm-5.2 支持压缩"。同边界内切换（glm-5.2 → kimi-k3，两者都未排除）不注入任何消息。

**场景 C：GUI 配置**

xyz-agent 设置页新增 "智能上下文压缩" Section：总开关、压缩模型下拉（数据源 `settingsStore.models`，只列已配凭证模型）、3 档阈值数字输入（单位 K）、排除模型多选。改动即时落盘 `<agentDir>/config/smart-context-ext-config.json`，extension 每轮事件检查时热读，下一 turn 生效，无需重启。**页面形态见 `docs/extensions/smart-context/gui-demo.html`（可打开浏览的静态 demo，v6 设计 tokens）**。

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

- 借道 `ctx.compact()`（**选定**）：切点计算（`prepareCompaction`）、落盘（`appendCompaction`）、上下文重建（`agent.state.messages`）复用 pi 原生实现；**压缩生成**（含 cross-model 模式的摘要组装复刻，见 D11/D12）由接管 handler 负责。单点接管、处处生效（用户 `/compact`、内建自动、agent 工具三条路径统一）。
- 手动组装：需要自己复刻 appendCompaction + 上下文重建（`agent.state.messages` 重建在 AgentSession 内部，extension 无法触达），不可行。

**工具结果时序契约（fire-and-forget 约束）**：`ctx.compact()` 实装为 `void (async () => { ...; options?.onComplete?.(result) })()`（`agent-session.js:1911-1925`），**不返回 Promise**——工具 execute 无法直接 await 压缩完成。两态策略：

- **最优态**：execute 内 `new Promise`，onComplete/onError 时 resolve/reject，工具调用阻塞至压缩完成、结果直接返回给 agent（是否可行受 R2 探针约束：`this.compact()` 开头 `await this.abort()` 对等待中的工具执行的影响、pi 工具执行有无超时）。
- **降级态**（R2 失败时启用）：execute 立即返回"压缩已启动"，onComplete 后经 `pi.sendMessage` 注入结果消息（deliverAs 选取见 D4 同款权衡），agent 下一轮看到结果。

### 3.3 关键决策与权衡

**D1：压缩生成完全替代 pi 原生——接管点 = `session_before_compact`，统一覆盖所有触发路径（选定）**

- **采用**：extension 在 `session_before_compact` hook 内完成全部 summary 生成并返回 `{compaction: CompactionResult}`，pi 只负责切点计算、落盘、上下文重建。agent 工具触发、用户 `/compact`、**内建 auto-compact** 三条路径的压缩生成**全部走 extension 逻辑**——非排除态下 pi 原生生成路径不再执行。
- **被否**：只在工具 execute 里换模型——覆盖不了 `/compact` 和内建自动压缩；手动组装 CompactionResult 绕过流程——`agent.state.messages` 重建在 AgentSession 内部，extension 无法触达，不可行。
- **证据**：`agent-session.js:1402-1417`（manual）与 `:1624-1655`（auto）都检查 handler 返回的 `compaction`，返回即整体采用、跳过原生生成。
- **效果**：只要 extension 处于启用且未排除状态，所有压缩的执行逻辑都在 extension 手里（模式见 D12）——单一接管点，无路径遗漏。
- **entry 标记**（可区分"用的是这个 extension 的压缩"）：接管落盘的 entry 自动带 `fromExtension=true`（pi 原生行为，`session-manager.d.ts:36-47`）；extension 另在 `CompactionResult.details` 写入 `{ engine: "smart-context", mode: "same-model" | "cross-model" }`——details 字段直接落 entry，可在 session 文件中逐条区分压缩引擎与模式。

**D2：内建 auto-compact 触发线保留，作为最后防线（选定）**

- **采用**：不禁用 pi 内建 auto-compact（`compaction.enabled` 保持 true）。其**触发机制**（阈值 `contextTokens > contextWindow - reserveTokens` 默认 16384、overflow 压缩后重试）原样保留；其**压缩执行**由 D1 接管走 extension 逻辑。仅当 extension 异常回退（D7）或模型被排除（D6）时，该次压缩才回落 pi 原生生成。
- **被否**：禁用内建完全依赖 agent 自决——agent 不调用就爆窗口报错，把可靠性押在 LLM 自觉上，不可接受。
- **效果**：分层防御——agent 自决（理想时机）→ 阈值提醒（数据投递）→ 内建触发线（保底，但执行仍是 extension 的廉价/缓存友好逻辑）。

**D3：提醒时机 = `agent_settled` 事件 + 档位去重 + 压缩后重置（选定）**

- **采用**：`agent_settled`（run 级联含 retry/compact 续跑完全落定后）触发检查，`ctx.getContextUsage()` 取 `{tokens, contextWindow, percent}`。每档一个 fired 标志（session 级闭包，`session_start` 重建）；同次检查多档同时越过合并成**一条**提醒；`session_compact` 事件清空全部 fired。
- **被否**：`turn_end`（每 turn 都查，级联未落定时插提醒干扰进行中工作）；`agent_end`（若紧随内建压缩级联，会在压缩中途提醒，语义错乱）。
- **证据**：`agent_settled` 语义见 `types.d.ts:544-547`；`getContextUsage()` 见 `types.d.ts:193-199`，goal extension 有使用先例。
- **防循环**：提醒触发的 turn 落定后，已越档位均已 fired，不会重复发（满足规范「Event handler 消息注入防循环」）。

**D4：提醒投递 = `pi.sendUserMessage(msg, {deliverAs:"followUp"})`（选定）**

- **采用**：followUp 投递（agent 完全空闲后投递并触发一个 turn，agent 可立即决定压缩）。
- **被否**：`deliverAs:"nextTurn"`（pi.sendMessage，随下个用户 prompt 进上下文，不触发额外 turn）——agent 无法及时行动，上下文在等待期间继续膨胀。
- **权衡承认**：followUp 触发的额外 turn，input 是全上下文重发（400K 档 ≈400K input，provider 缓存命中时大幅折价）+ 几 K output，3 档最多 3 次——相比压缩推迟的风险（逼近窗口、被迫机械压缩）可接受。
- **证据**：`types.d.ts:929-934`；先例 `extensions/universal/plan/src/compact.ts:196-208`。

**D5：排除列表精准匹配 + 切换跨界时注入通知（工具常驻，不做动态启停）（选定）**

- **采用**：
  - **匹配规则**：`excludedModels` 条目与当前模型做**完整 `provider/modelId` 等值精准匹配**（如 `"deepseek/deepseek-chat"`）——不做 provider 前缀模糊命中，避免"想排除一个模型却误伤同 provider 其他模型"。
  - **工具常驻注册**：`compact_context` 一经注册不随模型切换增删；不可用态由 execute 运行时校验拒绝（返回明确原因）。
  - **切换通知**：`model_select` hook 检测**跨越排除边界**的切换（前模型未排除→新模型命中排除，或反向），且仅在跨界那一刻注入一条消息告知 agent："压缩工具暂时不可用：当前模型 X 已配置为排除" / "压缩工具恢复可用：当前模型 X 支持压缩"。同边界内切换（两边都未排除）不注入、不每轮注入。
  - **downshift 检测（窗口收缩提醒）**：`model_select` 时若新模型 `contextWindow` 小于旧模型且当前 tokens ≥ 新窗口 − 16384（内建触发线）——注入一条"当前上下文 N tokens 已接近新模型窗口上限，建议压缩后再继续"提醒（不阻止切换，agent 自行决定）。Codex ModelDownshift 机制的小型化（`turn.rs:1097-1142`：换小窗模型时先压缩再切换；我们只做提醒，压缩执行仍走 D1 接管）。
- **被否**：`pi.setActiveTools` 动态增删工具列表（原方案）——语义需探针核实（白名单/增量不确定），且静默移除工具让 agent 不明原因；provider 前缀匹配——误伤面大，违背精准配置意图。
- **证据**：`model_select` 事件 payload 含 `model/previousModel`（`types.d.ts:600-607`）；注入用 `pi.sendUserMessage`（steer/followUp，规范指定事件回调内用 pi 而非 ctx）；注入不触发 `model_select`，无循环风险。
- **效果**：agent 对工具可用性有明确认知（知道原因），比静默移除更符合"agent 自决"哲学；工具列表稳定，无 setActiveTools 白名单误伤风险（原 R5 探针作废）。

**门控矩阵**（行为正确性不依赖工具移除时效，由 execute/handler 现场校验兜底；每次事件回调重新 `loadConfig` 热读，配置变更即时生效）：

| 状态 | 工具列表 | 工具 execute | 阈值提醒 | 压缩生成接管 |
|---|---|---|---|---|
| enabled=true，模型未排除 | 注入 | 放行 | 生效 | 生效（D12 双模式） |
| enabled=true，模型精准命中排除 | 常驻（execute 拒绝） | **拒绝**（"当前模型 X 已配置为排除，压缩工具不可用"） | 跳过 | 跳过（handler 返回空，回落 pi 原生） |
| enabled=false（GUI 关总开关） | 常驻（execute 拒绝） | **拒绝**（"smart-context 已禁用，可在设置页开启"） | 跳过 | 跳过（handler 返回空） |
| compactModel 未配置/无效 | 注入 | 放行（same-model 模式不需要 compactModel；见 D12/D7） | 生效 | same-model 模式生效，cross-model 回退当前模型（D7） |
| 模型切换跨界（model_select） | 常驻不变 | — | 注入一条可用性变化通知（仅跨界时） | 按新模型即时重判 |

**D6：工具带最低阈值保护（选定）**

- **采用**：execute 校验 `getContextUsage().tokens ≥ 档位最小值`，低于则不执行、返回当前用量与建议（"当前 38K，未达第 1 档 200K，无需压缩"）。`tokens` 为 `null`（压缩后首响应前）时返回"当前用量未知"并拒绝——null 窗口期恰紧随一次压缩完成，此时再压既无必要也有误压风险。保护线取最低档而非每档，保留 agent 提前量判断空间（知道接下来是超大任务，在 190K 提前压也放行）。
- **理由**：需求三条件 AND 的第三个条件是配置阈值；完全放开会在低上下文误调用（浪费压缩 + 摘要损失）。

**D7：压缩模型不可用时回退当前模型，不阻断压缩（仅 cross-model 模式适用）（选定）**

- **采用**：`modelRegistry` 解析失败 / 无凭证 / API 报错 → handler 返回空结果，pi 走原生路径（当前模型生成），压缩本身不失败；工具结果与日志标注回退原因与修复指引。
- **不适用场景**：same-model 模式（D12）压缩模型就是当前会话模型，会话能跑说明凭证有效，不存在此回退分支。
- **被否**：报错终止压缩——压缩常发生在接近窗口时的关键时刻，因配置问题失败代价过高。

**D8：配置 schema（llm-shared 生态一致）（选定）**

- **采用**：

```jsonc
// <agentDir>/config/smart-context-ext-config.json
{
  "enabled": true,                                          // 总开关（GUI 开关同源）
  "compactModel": { "type": "ref", "ref": "xiaomi-token-plan-cn/mimo-v2.5" },  // ModelSelector ref；与当前模型相同 → same-model 模式
  "reminderThresholds": [200000, 400000, 600000],           // token 绝对数，升序，3 档
  "excludedModels": ["deepseek/deepseek-chat"]              // 完整 provider/modelId，精准等值匹配（D5）
}
```

- **要点**：路径经 `getConfigPath("smart-context")` 派生（规范强制）；读取用 `loadConfig`（mtime+size 读时刷新），每个 `agent_settled` / `session_before_compact` / 工具 execute 触发时重新 load——GUI/skill 改完下一 turn 生效；`compactModel` 未配置时 same-model 模式照常工作（它不需要压缩模型配置），cross-model 场景回退当前模型（D7）——两模式独立降级。
- **模式选择规则**：`compactModel.ref` 等于当前模型（provider+id 完全一致）→ **same-model 模式**；不等于或未配置 → **cross-model 模式**（未配置时实际效果 = 用当前模型做摘要化压缩，即 pi 原生形态）。

**D9：subagent 子进程禁用（选定，实现方式待验证）**

- **采用**：subagent 是短生命周期任务进程，不注入工具、不提醒。识别手段在实施期查证 subagent-workflow 的 spawn 协议（§3.6-R6）。
- **识别失败时默认行为**：不注册工具、不提醒（宁缺勿污，主进程不受影响），留 WARN 日志。

**D10：GUI 放 SystemPage 新 Section（选定）**

- **采用**：参照 `SystemAutoRenameSection.vue` 模式（开关 + 模型下拉 + 数字输入 + 多选），接线约 10 处文件改动（§5.2 地图）。
- **视觉 demo**：`docs/extensions/smart-context/gui-demo.html`（v6 tokens 内联的静态页面，含压缩模式联动说明——选当前模型即 same-model 模式的 UI 提示）。

**D11：cross-model 模式的摘要组装复刻清单（选定）**

- **采用**：cross-model 模式（压缩模型 ≠ 当前模型，见 D12）下，接管返回 `{compaction}` 后 pi 原生 `compact()` 的摘要组装段被整体绕过（`compaction.js:584-617`），以下三项必须在 handler 内自行完成，否则摘要**静默降质**：
  1. **previousSummary 透传**：从 `session_before_compact` 事件的 `preparation` 取上次 compaction 的 summary，传给 `generateSummaryWithUsage(..., previousSummary, ...)`——pi 检测到旧摘要会改用增量合并 prompt（`UPDATE_SUMMARIZATION_PROMPT`）。丢失此项 = 迭代压缩退化成全量重摘，跨多次压缩的任务记忆漂移。**双份防御（R10）**：opencode 的教训是透传 previousSummary 的同时若被压段输入里还残留旧 compactionSummary 消息，会出现双份摘要——需核对 pi 原生路径的 `messagesToSummarize` 是否已排除旧 compaction 投影（原生怎么处理我们怎么对齐）。
  2. **fileOps 文件清单追加**：摘要生成后拼接 `formatFileOperations(readFiles, modifiedFiles)` 等价格式（从 `preparation` 取数据，输出格式对齐 `compaction.js:607-609`）——摘要末尾的已读/已改文件清单是压缩后 agent 快速恢复现场的关键锚点。
  3. **split-turn 双段合并**：`preparation.isSplitTurn` 为 true 时，原生路径对 `turnPrefixMessages` 用 `TURN_PREFIX_SUMMARIZATION_PROMPT` 二次摘要并合并进主摘要；接管路径需同等处理，若 R4 探针证实无法等价复刻则降级为「split-turn 场景不接管、放行原生生成」。
- **输入瘦身（cross-model 专属，最小输入的具体化）**：被压段输入构造时做两级削减——① tool result 文本只保留头部 2000 字符 + 截断标记（对摘要而言更早的输出内容边际价值趋零，opencode/pi-context-prune 同参数）；② 图片/文档内容块替换为 `[image]` / `[document: <name>]` 文本占位（摘要只需知道"用户发过图"，Claude Code `compact.ts:145-200` 同款，兼防压缩请求自身超窗）。
- **不适用**：same-model 模式（D12）输入是全量原始上下文（前缀缓存命中的前提），不做任何截断。

**D12：双模式生成——same-model harness 模式（kv-cache 命中）vs cross-model 摘要化模式（选定）**

- **采用**：接管 handler 按 `compactModel.ref` 是否等于当前模型分两种生成模式：

  **same-model 模式**（压缩模型 == 当前会话模型，或 compactModel 未配置时显式选择"跟随当前模型"）——deepseek-harness 式：
  - **输入 = 原对话上下文原样**（完整 messages，含全部 tool results，**不截断、不摘要化**）+ 末尾**追加一条压缩指令 user message**。
  - **system prompt = 会话原 system prompt**（不用 pi 的 summarization 专用 prompt）——这是 kv-cache 命中的必要条件：provider prompt cache 按前缀匹配，system prompt + 全部对话与前一轮 LLM 调用完全一致，前缀缓存全命中；新增 token 仅 = 追加的压缩指令 + summary 输出。成本从"全量 input 计费"降为"增量指令 + 输出计费"。
  - **cache-key 一致性约束（成败点，D13-5）**：压缩调用除末尾追加的 user message 外，一切影响 cache-key 的请求参数（system prompt、tools schema、maxOutputTokens、thinking 配置）必须与主会话完全一致——任何一项差异都会使前缀缓存整体失效。Claude Code 实测教训：不共享 cache-key 的摘要请求 98% cache miss；曾因单独设置 maxOutputTokens 造成 thinking config mismatch 而打碎缓存（`compact.ts:1181-1187` 注释明示 DO NOT）。
  - 压缩指令 user message 承载结构化 checkpoint 要求 + agent 的 custom_instructions（prompt 工程细则见 D13-6/7/8）。
  - **质量红利**：模型看的是全量原始上下文（含未截断的 tool results），摘要质量上限高于任何摘要化方案。
  - previousSummary 天然在上下文中（上次 compaction summary 已投影为 compactionSummary 消息在前缀里）、fileOps 素材（tool results）全部可见——D11 三项天然覆盖，仅需按 D11-2 在生成的 summary 末尾补格式化文件清单（恢复锚点）。
  - 完整上下文 messages 的数据源：`session_before_compact` 事件的 `branchEntries`（或 `ctx.sessionManager` entries 投影，实施期核对最直接来源，R9）。

  **cross-model 模式**（压缩模型 ≠ 当前模型）——摘要化：
  - **输入 = 摘要化构造**（`preparation.messagesToSummarize` + summarization system prompt + previousSummary 透传，按 D11 复刻清单组装，并做**输入瘦身**——见 D11 输入瘦身项）——新模型对原上下文无缓存命中，输入越少越便宜，目的就是**减少给模型的输入 token**。
  - 生成用 `generateSummaryWithUsage(messages, 压缩Model, ...)`。

- **模式判定的实时性**：每次 `session_before_compact` 现场读取配置与 `ctx.model` 判定——切换会话模型或热改 compactModel 配置后，下一次压缩即按新模式执行，无需重启。
- **被否**：单一摘要化模式不看模型异同——同模型压缩时把全量上下文重新构造为摘要化输入（全新前缀，零缓存命中，全量 input 按当前模型费率计费）+ 上下文还被截断降质，双重浪费；单一 harness 模式——跨模型时追加指令的上下文对压缩模型全价计费且无缓存，成本失控。
- **证据**：provider prompt cache 以前缀匹配（本项目 cache-probe extension 的前缀指纹采集即基于此机制）；pi 原生 compaction 的 summarization prompt 与 UPDATE 增量机制见 `compaction.js:356-425`；Codex CLI 本地压缩路径与本模式同构（全量历史 + 原 system prompt + 末尾追加压缩指令，`codex-rs/core/src/compact.rs:235-340`）；deepseek-harness `summarizer.ts:24-30` 注释明示 "genuine prefix of the last routed request, so the provider's KV cache is reused"。
- **效果**：压缩成本两档最优——同模型 = 缓存命中近似免费且质量最高；跨模型 = 廉价模型 + 最小化输入。GUI 下拉选当前模型时自动进入 same-model 模式（demo 有联动提示）。

**D13：生成健壮性与 prompt 工程（两模式通用，业界调研吸收）（选定）**

> 来源标注：本决策各项吸收自 Claude Code / Codex / deepseek-harness / opencode 的压缩实现（调研记录见附录 B），均为单点改动。

- **D13-1 摘要收缩校验**：生成的 summary tokens ≥ 被压段 tokens → 判本次接管失败，返回空回落 pi 原生（不落盘防"摘要比原文大"反噬），并记录该段"压不动"（同段不重复尝试）。deepseek-harness `region.ts:373-378` 同款。
- **D13-2 截断 fail-closed**：摘要输出因 max-tokens 截断（finishReason=length）→ 视为不完整 checkpoint，同 D13-1 处理（防半截结构化模板落盘）。deepseek-harness `summarizer.ts:206-212` 同款。
- **D13-3 接管失败熔断**：本 session 接管连续失败 3 次 → 停止接管（后续压缩直接回落 pi 原生）+ 日志与工具结果说明——防"上下文已不可恢复超限时每轮空转重试烧钱"（Claude Code 曾观测单会话 3272 次连续失败、全局每天浪费 25 万次 API 调用，`autoCompact.ts:62-70` 注释）。
- **D13-4 transcript 回查指针**：summary 文本末尾追加一行 session 文件路径（"需要压缩前的完整细节，可读取该文件"）——给摘要丢细节上保险，agent 可按需回查。Claude Code `prompt.ts:349-351` 同款；pi 的 session JSONL 文件天然可用。
- **D13-5 cache-key 一致性**：见 D12 same-model 模式内嵌约束（不设压缩专用的 maxOutputTokens/thinking 覆盖）。
- **D13-6 无工具双保险**：压缩指令开头与结尾各一句"仅输出文本，不调用任何工具"——Claude Code 实测不带此声明时模型有 ~2.8% 概率在压缩调用里乱调工具导致空输出（`prompt.ts:19-26`）。
- **D13-7 结构化模板**：摘要模板 = pi 原生 6 节（Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context）+ 吸收 **Files and Code**（路径 + 关键变更）、**Errors and Fixes**（错误与修法 + 用户纠正）两节——后两节是 coding agent 恢复现场的关键（deepseek 8 节与 Claude 9 段模板共有）。模板措辞实施期按摘要质量迭代（§5.3-3）。
- **D13-8 先验 checkpoint 合并规则**：输入中已含上次摘要（same-model 天然、cross-model 透传）时，指令明确"不逐字复制旧摘要：保留仍真事实、丢弃过时事实、与新信息合并为单一 summary"——两模式共用增量语义。deepseek-harness `summarizer.ts:65` 同款。
- **D13-9 落回包裹语**：summary 文本开头加一段引导（"这是对更早对话的自动压缩检查点，视为既定背景，直接从其后消息继续任务，无需确认已收到本摘要"）——消除压缩后模型第一反应"好的我已了解摘要"的浪费回合。deepseek-harness CHECKPOINT_PREAMBLE、Codex SUMMARY_PREFIX 同款。
- **D13-10 输出解析只取 text**：same-model 模式下模型可能输出 reasoning/工具调用，只取 text 块作为 summary（deepseek `summarizer.ts:216-224` 思路，取文本而非 fail 拒绝）。
- **被否**：压缩后"最近文件内容重注入"（Claude Code ≤5 文件/50K 预算）——实现中等复杂（预算 + 与保留段去重），标记为后续可选优化不进本期；时间型 microcompact / partial compact / session memory 等复杂机制——见附录 B 不吸收清单。

### 3.4 架构与数据流

```
┌─ pi 进程 ──────────────────────────────────────────────────────────────┐
│                                                                         │
│  session_start ──> 读配置 + ctx.model 门控 ──> 注册 compact_context      │
│       │                                              （工具常驻，D5）      │
│       │         model_select ──> 跨越排除边界？──是──> 注入可用性通知     │
│       │                                  └─否──> 静默重判门控            │
│                                                                         │
│  ┌────┴────────── 压缩执行流（三条路径统一）────────────────┐            │
│  │ agent 工具调用 / 用户 /compact / 内建 auto（触发线保留）  │            │
│  │        │                                                 │           │
│  │        v                                                 │           │
│  │  AgentSession.compact()                                  │           │
│  │        │  abort -> prepareCompaction(原生切点算法)        │           │
│  │        v                                                 │           │
│  │  emit session_before_compact ◄── smart-context handler    │           │
│  │        │                                            │    │           │
│  │        │      现场判定模式（compactModel vs 当前模型）    │           │
│  │        │       ┌──────────────┴──────────────┐         │           │
│  │        │       v                             v         │           │
│  │        │  same-model 模式              cross-model 模式 │           │
│  │        │  完整原始上下文(不截断)         摘要化输入        │           │
│  │        │  + 会话原 system prompt        + summarization  │           │
│  │        │    (kv-cache 前缀全命中)         system prompt   │           │
│  │        │  + 末尾追加压缩指令 user msg    + D11 复刻清单    │           │
│  │        │       └──────────────┬──────────────┘         │           │
│  │        v                      v                        │           │
│  │  返回 {compaction} ──> pi 直接落盘（fromExtension=true，  │           │
│  │                        details 含 engine/mode 标记）     │           │
│  │  返回空（排除/禁用/D7 回退）──> pi 原生生成               │           │
│  │        v                                                 │           │
│  │  appendCompaction -> 重建上下文 -> emit session_compact   │           │
│  │                                     │                   │           │
│  │                                     v                   │           │
│  └──────────────────────> 重置提醒 fired 标志 <─────────────┘           │
│                                                                         │
│  agent_settled ──> getContextUsage() 越档检查(去重/合并)                  │
│        └─ 越档 ──> pi.sendUserMessage(提醒, {deliverAs:"followUp"})     │
└─────────────────────────────────────────────────────────────────────────┘

┌─ xyz-agent 侧（配置写入）──────────────────────────────────────────────┐
│  GUI Section ──> WS 'config.setSmartContext*' ──> worktree-config-      │
│  helper（withFileLockSync + atomicWrite）──> smart-context-ext-         │
│  config.json <──（同一文件、同一锁协议）──> extension loadConfig 热读   │
└─────────────────────────────────────────────────────────────────────────┘
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

execute 返回 details：`{ tokensBefore, estimatedTokensAfter, mode: "same-model" | "cross-model", compactModel, usage, fellBack }`（renderResult 数据源，规范要求 details 不依赖 content 文本解析；`mode` 与落盘 entry 的 `details.engine/mode` 同源）。

**提醒消息模板**（§3.1 场景 A 已示）：固定结构 = 当前用量数据 + 越档信息 + 工具名 + **三条件自查清单** + 明确的"可忽略"出口。措辞设计原则：提醒是数据投递不是指令，避免 agent 见提醒就压缩（需求明确要求"不要一提醒就触发"）。

**GUI 命令**（protocol.ts 新增，命名对齐 rename 模式）：`config.setSmartContextEnabled` / `config.getSmartContextConfig` / `config.setSmartContextCompactModel` / `config.setSmartContextThresholds` / `config.setSmartContextExcludedModels`（读写统一走 config-service → worktree-config-helper 落盘）。

### 3.6 运行时断言与探针

| # | 断言 | 依据状态 | 探针失败时的降级路径 |
|---|---|---|---|
| R1 | `session_before_compact` 返回 `{compaction}` 后，pi 跳过原生生成、落盘 entry `fromExtension=true` + extension 写入的 details、usage 为生成模型的实际消耗 | ✅ 已读实装代码（`agent-session.js:1402-1417/1624-1655`）；端到端行为实施期用本地 pi CLI 探针复验 | 探针失败（版本行为漂移）→ 放弃接管，extension 退化为「工具 + 提醒」两功能，压缩模型配置项标注不可用 |
| R2 | `ctx.compact()` 在 tool execute 上下文内可用且挂起 Promise 等 `onComplete` 可行（`AgentSession.compact` 开头 `await this.abort()` 对等待中工具执行的影响、工具执行有无超时） | ⛔ 实施期门：本地 pi CLI `--mode rpc` 实测（plan extension 有同类先例但上下文不同，不可直接外推） | 挂起不可行 → 工具走**降级态**（§3.2）：立即返回"压缩已启动"，onComplete 后经 `pi.sendMessage` 注入结果 |
| R3 | cross-model：`generateSummaryWithUsage(messages, 压缩Model, ...)` + `ctx.modelRegistry` 解析 auth（apiKey/baseUrl）跨 provider 可用 | ⛔ 实施期门：mimo 压缩 glm 会话实测；`modelRegistry.getAuth` 返回形状精确核对 | 跨 provider 解析不可用 → 走 **D7 回退**：压缩用当前模型完成（cross-model 价值缺失，same-model 模式不受影响） |
| R4 | cross-model 接管路径对 **split-turn**（切点落在 turn 中间）的 turnPrefix 摘要覆盖完整（原生路径有 `TURN_PREFIX_SUMMARIZATION_PROMPT` 二次摘要） | ⛔ 实施期门：构造 turn 中间触发压缩的 session 对比接管前后摘要质量 | 存在损失确认 → **D11-3 降级**：split-turn 场景不接管、放行原生生成 |
| R5 | ~~setActiveTools 白名单语义~~（**已作废**：D5 改为工具常驻 + 切换注入通知，不再依赖 setActiveTools 动态启停） | — | — |
| R6 | subagent 子进程的识别手段（环境变量 / spawn 标记；`--mode rpc` 与主进程相同，无法靠 mode 区分） | ⛔ 实施期门：读 subagent-workflow `runSpawn` 协议（`session-runner.ts:650` 一带） | 无识别手段 → subagent 进程**默认不注册工具、不提醒**（宁缺勿污），主进程不受影响；留 WARN 日志待上游提供识别标记后启用 |
| R7 | `getContextUsage()` 压缩后首响应前返回 `tokens: null`（提醒检查需容错跳过，不误判为低用量） | ✅ 实装注释明示（`types.d.ts:193-199`） | — |
| R8 | **same-model 模式 kv-cache 实际命中**：完整上下文 + 会话原 system prompt + 末尾追加压缩指令的调用，usage 的 `cacheRead` 覆盖绝大部分 input（前缀缓存命中），且摘要质量不低于摘要化模式 | ⛔ 实施期门：真实长 session（≥100K）上触发 same-model 压缩，检查 usage.cacheRead / (cacheRead+input) 占比 + 摘要抽查 | 命中率显著低于预期（如 provider 对该模型关闭前缀缓存）→ GUI 设置页 same-model 提示文案如实标注成本特征，机制保留（质量红利仍在）；摘要质量劣于摘要化 → 回退统一摘要化模式并记录原因 |
| R9 | same-model 模式的完整上下文数据源：`session_before_compact` 事件 payload（`branchEntries`）或 `ctx.sessionManager` 能取到与 `agent.state.messages` 等价的完整 messages 投影 | ⛔ 实施期门：核对事件 payload 与 sessionManager API 的投影等价性 | payload 不可得 → 经 `ctx.sessionManager.getEntries()` 自行投影（与 pi `buildContextEntries` 对齐） |
| R10 | pi 原生 cross-model 路径的 `messagesToSummarize` 是否已排除上次 compactionSummary 投影（决定 D11-1 透传 previousSummary 时会不会双份摘要） | ⛔ 实施期门：读 `prepareCompaction` 组装 + 构造二次压缩 session 验证 | 已排除 → 直接透传；未排除 → handler 组装输入时剔除旧 compaction 投影（opencode `compaction.ts:335-338` 同款 hidden 剔除） |

---

## 4. 验收

> 全部场景在**本地 pi CLI 实测环境**（`pi --mode rpc --session-dir <dir> --extension <path>`，项目 MANDATORY 流程）或 xyz-agent dev 实例上执行，非单测/mock。阈值在测试中临时调低（如 5K/10K/15K）以降低造数成本，默认值行为单独用配置缺省验证。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| A1 | agent 自决压缩（cross-model，真实长任务） | 配置压缩模型 mimo；在 glm-5.2 会话跑真实编码任务至超低档阈值；收到提醒后在阶段完成点让 agent 调 `compact_context` | session 文件新增 `compaction` entry：`fromExtension=true` 且 `details` 含 `{engine:"smart-context", mode:"cross-model"}`；entry usage 对应 mimo 费率；摘要含落回包裹语 + Files and Code / Errors and Fixes 节 + 文件清单 + transcript 回查指针（D13-4/7/9）；压缩后 agent 继续任务不丢失关键决策且**无"确认收到摘要"浪费回合**；工具结果报告 tokensBefore/After 与模式 | 目标 1、2 |
| A1' | same-model 压缩（kv-cache harness） | 压缩模型配成与会话一致的模型；真实长 session（≥100K）触发 `compact_context` | entry `details.mode = "same-model"`；usage 的 `cacheRead` 占 input 绝大部分（缓存命中验证）；摘要含结构化 checkpoint 与文件清单（tool result 未截断带来的质量红利）；agent 压缩后继续工作正常 | 目标 2 |
| A2 | 提醒分档与去重 | 阈值设 5K/10K/15K；持续对话使上下文越 5K 后继续涨到 11K | 5K 档恰好提醒一次（不重复）；11K 时 10K 档提醒一次；每次提醒是一条消息（多档合并）；压缩后继续对话再次越档会重新提醒 | 目标 3 |
| A3 | 提醒不强制（负面验证） | 越档后明确指示 agent "继续当前任务，暂不压缩" | agent 不调用工具、正常继续；不出现反复催促 | 目标 3 |
| A4 | 排除模型静默 | `excludedModels` 配置任一已配凭证、可切换的完整 `provider/modelId`；切到该模型 | 收到一条"压缩工具暂时不可用"注入通知（仅此一条）；越档不提醒；手动 `/compact` 时 summary 由 pi 原生成路径产生（entry 无 smart-context 标记）；工具若被调用返回拒绝与原因 | 目标 4 |
| A5 | 切回恢复 + 窗口收缩提醒 | 从排除模型切回未排除模型；再造 downshift：大上下文（超新模型窗口−16K）下从大窗模型切到小窗模型 | 收到一条"压缩工具恢复可用"注入通知；提醒恢复；下一次压缩 entry 恢复 smart-context 标记。同边界内切换（两个都未排除的模型间）不产生任何注入消息。downshift 场景收到"建议先压缩"提醒（一次），压缩走接管逻辑 | 目标 4 |
| A6 | 完全替代验证（`/compact` 与内建 auto 路径） | 配置 mimo；用户手动 `/compact`；再造内建自动压缩（把 settings 的 `reserveTokens` 调大逼近当前用量） | 两条路径的 entry 都带 `fromExtension=true` + smart-context details、usage 为 mimo 费率——证明 pi 原生生成在非排除态下不再执行，全部压缩走 extension 逻辑 | 目标 2 |
| A7 | 压缩模型回退 | 把 compactModel 配成无凭证模型；触发压缩 | 压缩不失败（当前模型完成），工具结果/日志含回退说明与修复指引 | 目标 2（容错） |
| A7' | 接管失败熔断 | compactModel 持续无效（如指向返回错误的端点），连续触发 3 次压缩 | 前 3 次走 D7 回退（压缩仍完成）；第 4 次起 extension 不再尝试接管（日志与工具结果标注熔断），压缩直接走 pi 原生，无重复重试 | 目标 2（容错） |
| A8 | GUI 配置闭环 | xyz-agent dev：设置页改压缩模型/阈值/排除列表/总开关 | 落盘 `smart-context-ext-config.json` 与界面一致；不重启 pi 会话，下一 turn 新配置生效（热读）；关总开关后再调 `compact_context` 得到"已禁用"拒绝消息、提醒停止；把当前模型精准加入排除列表后工具调用得到拒绝消息 | 目标 5 |
| A9 | skill 配置闭环 | 在 pi 会话中要求 agent "把压缩阈值第一档改成 150K" | agent 经 progressive disclosure 读到 `smart-context-ext-config` skill，正确改写配置文件并说明生效时机 | 目标 5 |
| A10 | subagent 不受影响 | 通过 subagent-workflow 派发子任务 | 子进程工具列表无 `compact_context`，不产生提醒 | 目标 1（边界） |

---

## 5. 下一层拆分

### 5.1 实施单元

| # | 单元 | 内容 | justification | 对应验收 |
|---|---|---|---|---|
| U1 | 包骨架 + 配置模块 | `extensions/universal/smart-context/` 目录、package.json（`pi.extensions`/`pi.skills`/role universal/llm-shared 依赖）、`src/pure.ts` 配置 schema/默认值/normalize/`loadSmartContextConfig()` | 配置是一切功能的数据源，先行；纯函数易测 | A8 前置 |
| U2 | 压缩生成接管（双模式 + 健壮性） | `session_before_compact` handler：门控（D5 矩阵）→ 现场判定模式（D12）→ same-model 路径（完整上下文 + 会话原 system prompt + 追加压缩指令，cache-key 一致性）/ cross-model 路径（modelRegistry 解析 + 输入瘦身 + `generateSummaryWithUsage` + **D11 复刻清单**）→ 组装 `CompactionResult`（details 含 engine/mode 标记）；**D13 健壮性**（收缩校验 / 截断 fail-closed / 熔断 / prompt 工程六项）贯穿两路径；失败回退 | 核心价值；独立于其他单元可单独验收（`/compact` 即验）。D12 双模式是成本与质量的核心，D11 三项缺一即 cross-mode 摘要静默降质，D13 是业界实测教训的防呆（不加则翻车概率高） | A1、A1'、A6、A7、A7'、R3/R4/R8/R9/R10 探针 |
| U3 | `compact_context` 工具 | registerTool + D6 阈值保护（含 null 分支）+ `ctx.compact()` 时序两态实现（最优态挂起 Promise / 降级态注入，按 R2 探针结果选定）+ execute 内 D5 运行时校验 | 核心价值 2；依赖 U1 | A1、R2 探针 |
| U4 | 阈值提醒 | `agent_settled` 检查 + 档位去重 + 合并提醒 + `session_compact` 重置 + followUp 投递 | 核心价值 3；依赖 U1 | A2、A3、R7 |
| U5 | 排除门控 + 切换通知 | 工具常驻注册；`model_select` 跨界检测 + 可用性通知注入（仅跨界一次）；execute/handler 现场运行时校验（热更矩阵 D5） | 横切 U2-U4 的开关层；热改配置不触发门控事件，运行时校验是正确性兜底 | A4、A5、A8、R6 探针 |
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
  src/compact-handler.ts                     # session_before_compact 双模式接管（U2）
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

1. R2/R3/R4/R6/R8/R9/R10 七个探针（§3.6，R5 已作废）在 U2/U3/U5 开工首日先行执行，结果回写本文档（探针失败按各自备注的降级路径调整方案）；
2. `generateSummaryWithUsage` 的 `reserveTokens` 传参来源（pi 原生用 `settings.compaction.reserveTokens` 默认 16384——接管时读同一 settings 保持一致，还是用 `summary maxTokens = min(0.8*reserveTokens, model.maxTokens)` 反推）——以「摘要长度与原生路径一致」为验收锚点；
3. same-model 模式的压缩指令 user message 措辞（承载原 summarization prompt 的结构化 checkpoint 要求 + agent custom_instructions）在 U2 实施时按摘要质量迭代。

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

---

## 附录 B：业界压缩机制调研吸收记录（2026-08-22）

> 调研对象：Claude Code（`~/GitApp/ai-agent/claude-code-source-code`）、Codex CLI（`codex-cli`）、deepseek-harness、opencode（`opencode-anomaly`）、pi-context-prune；另参考本项目 `feat-context-compact` 分支的 infinite-context 复杂机制（全部不吸收，用于划界）。判定原则：只吸收单点改动、与双模式架构兼容的机制。

**已吸收**（落点见括号内决策编号）：

| 机制 | 来源 | 落点 |
|---|---|---|
| fork 请求 cache-key 一致性（不设压缩专用 maxOutputTokens/thinking 覆盖，否则前缀缓存全 miss） | Claude Code `compact.ts:1181-1187` | D12 / D13-5 |
| 压缩指令首尾"仅输出文本"双保险（防模型在压缩调用里乱调工具） | Claude Code `prompt.ts:19-26` | D13-6 |
| 结构化模板补 Files and Code / Errors and Fixes 两节 | deepseek-harness（8 节）与 Claude Code（9 段）共有 | D13-7 |
| 先验 checkpoint 合并措辞（不逐字复制旧摘要，保留仍真、丢弃过时、合并为单一 summary） | deepseek-harness `summarizer.ts:65` | D13-8 |
| 落回包裹语（视为既定背景，直接继续，无需确认收到摘要） | deepseek-harness CHECKPOINT_PREAMBLE / Codex SUMMARY_PREFIX | D13-9 |
| 摘要收缩校验（summary ≥ 被压段则失败不落盘 + 同段不重试） | deepseek-harness `region.ts:373-378` / pi-context-prune frontier | D13-1 |
| max-tokens 截断 fail-closed（半截模板不落盘） | deepseek-harness `summarizer.ts:206-212` | D13-2 |
| 接管连续失败熔断（3 次停止，防每轮空转烧钱） | Claude Code `autoCompact.ts:62-70`（3272 次连续失败教训） | D13-3 |
| transcript 回查指针（summary 末尾附 session 文件路径） | Claude Code `prompt.ts:349-351` | D13-4 |
| 输出解析只取 text 块（防 reasoning/工具调用混入 summary） | deepseek-harness `summarizer.ts:216-224` | D13-10 |
| cross-model 输入瘦身：tool result 头部 2000 字符截断 + 图片/文档占位化 | opencode `compaction.ts:351-354` / Claude Code `compact.ts:145-200` | D11 输入瘦身 |
| previousSummary 双份防御（透传同时剔除被压段中旧 compaction 投影，或确认原生已排除） | opencode `compaction.ts:335-338` | D11-1 + 探针 R10 |
| 模型切换 downshift 检测（切小窗模型且将超线时提醒先压缩） | Codex `turn.rs:1097-1142` 的小型化 | D5 |
| 工具 result 截断的 PRUNE_MARKER 格式（`[N chars truncated]`） | deepseek-harness tool-result-pruner | D11 输入瘦身 |

**已评估、暂不吸收**（后续可选）：

| 机制 | 来源 | 原因 |
|---|---|---|
| 压缩后"最近文件内容"重注入（≤5 文件/50K 预算/去重） | Claude Code `compact.ts:1415-1534` | 实现中等复杂（预算 + 与保留段去重）；fileOps 清单 + transcript 指针已覆盖主要恢复路径，先观察够不够 |
| 压缩后多轮降智警告 UX 文案 | Codex `compact.rs:383-386` | 一行文案，实施期顺手加，不构成决策 |

**不吸收**（复杂度与"小优化"定位冲突，明确排除）：

| 机制 | 来源 | 原因 |
|---|---|---|
| 压缩前 model-free tool-result 截断通道（截断后低于阈值则跳过 LLM 摘要） | deepseek-harness tool-result-pruner | 需改写 pi 原生消息投影（context hook 过滤），复杂；cross-model 输入瘦身已吸收其精神 |
| 时间型 microcompact / cache_edits 服务端删减 | Claude Code | pi 无对应基础设施 |
| partial compact 双方向（up_to/from） | Claude Code | 引入边界 relink 复杂度，pi 原生切点够用 |
| session memory / 持续笔记文件替代摘要 | Claude Code 实验特性 | 多状态源，维护成本高 |
| `context_tree_query` 按需找回原始输出（t1/t2 refs） | pi-context-prune | 需索引持久化 + 新工具，超出整体压缩定位 |
| `<pruner-note>` 尾部 append 注入方式 | pi-context-prune | pi extension 的 sendUserMessage(steer/followUp) 语义下无此约束，不适用 |
| overflow 后未处理 user message 重放 + auto-continue 合成消息 | opencode | pi 的 willRetry 重试机制已覆盖溢出恢复语义 |
| 双层压缩（L1 增量 + L2 重排）、cp 数组多段 checkpoint、context map、recall/memory、动态压缩率指导 | 本项目 feat-context-compact / infinite-context | 多级状态机全家桶，与"agent 自决 + 双模式生成"的简单架构定位冲突（该分支独立演进） |

**关键同构验证**：Codex CLI 本地压缩路径（`compact.rs:235-340`：全量历史 + 原 system prompt + 末尾追加压缩指令 user message + 同模型）与 deepseek-harness（`summarizer.ts`：复用 system + tools 前缀做 KV 缓存对齐）均与本方案 same-model 模式同构——该模式方向被两个独立实现验证。
