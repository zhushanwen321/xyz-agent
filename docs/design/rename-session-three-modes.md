# rename-session 三模式 + taiji 侧边栏自动更新 + 配置面收敛

> **一句话结论**：在 `pi-rename-session` extension 内以 `mode` 三值枚举落地「首请求即命名 / 首 stop 命名 / agent 工具命名」三种触发模式（落库统一走 pi 原生 `setSessionName`，extension 不感知 taiji）；runtime 在 `session_info_changed` 事件回调补一次 `broadcastSessionList()`（对齐手动 rename 行为）修复侧边栏不刷新的结构性缺口；空 model ref 从「静默跳过」改为「跟随会话模型」消灭默认配置下功能不工作的静默失败；同批吸收 ext-simplify-15 的 rename-session 精简项（删 `PI_RENAME_*` env 覆盖层、登记 C-ext-21 路径耦合约束）。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 桌面端内置 `@zhushanwen/pi-rename-session`（universal 包，也供原生 pi CLI 用户单独安装），现状只在 session 首个成功 round 末（下称 first-stop）用独立 LLM 生成标题并 `pi.setSessionName()` 落库。
- **C（冲突）**：2026-09-11 排查证实三层独立问题：① 触发侧静默失败——开关（flag 文件）与标题模型（config `model.ref`）是两个独立配置，模型默认空 ref，`resolveModel` 对空 ref 返回 null 后静默跳过（实测当前机器正是「flag 开 + ref 空」状态；GUI 无任何失败反馈）；② 显示侧扇出缺口——rename 落库成功后 runtime 只更新内存 label（`packages/runtime/src/index.ts:380` `onSessionRenamed` → `setLabelCache`），不调 `broadcastSessionList()`，`session.renamed` 定向帧只覆盖「已订阅该 session 流」的连接，侧边栏刷新被「下一个无关操作」绑架；③ 用户需要三种触发时机（立刻/首停/agent 自主）但现状只有 first-stop 一种。
- **Q（问题）**：如何用最小改动支持三模式、修复侧边栏自动更新，并消灭「默认配置下功能静默不工作」？
- **A（答案）**：触发与落库分离——三模式只是同一落库管道（`pi.setSessionName` → `session_info` entry → `session_info_changed` 事件）的三个入口；taiji 侧边栏靠 pi 原生事件流 + 一行扇出补丁感知一切 rename 来源（extension 对 taiji 零依赖）；空 ref 改跟随会话模型。本文展开。

**层声明**：本文档是「技术方案设计」层，下一层产物 = 可实施的代码任务 + 测试改造清单。准则 5/6/7（数据流/错误/运行时断言）全适用。

**证据基线**：pi 断言核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（`npm ls` 确认）；extension/runtime/renderer 源码与 `~/.xyz-agent/` 运行数据均为 2026-09-11 实读，行号为实读值。ext-simplify-15 引用其文档实读值。

---

## 1. 背景目标

**系统是什么**：xyz-agent 是 Electron 桌面 AI Agent 工作台，runtime（Node.js WS 服务）管理 pi coding agent 子进程；`pi-rename-session` 是 21 个 builtin extension 之一（feature tier，可禁不可卸），同时作为 npm 包服务独立 pi CLI 用户（role=universal：功能自足、不依赖 xyz-agent）。

**设计目标**（从使用者体验倒推）：

1. **触发时机可选**：用户（GUI 系统设置或 pi CLI 配置文件）三选一——`first-prompt`（发出首条请求后立刻得名，不等回复）、`first-stop`（现状：首个成功 round 末）、`agent-tool`（不自动生成，注册 `rename_session` 工具由 agent 在对话中自主改名）。默认 `first-stop`（零行为迁移）。
2. **侧边栏自动更新**：任何来源的 rename（三模式自动/agent 工具/GUI 手动/pi 原生 `/name`）落库后，GUI 侧边栏无需任何其他操作即刷新；extension 不引入任何 taiji 专属通道（保持 universal 定位）。
3. **默认配置可用**：开箱（开关开 + 模型未配置）即工作——空 model ref 跟随会话主模型；只有显式配错（无效 ref）才静默跳过且日志可诊断。
4. **配置面收敛**：吸收 ext-simplify-15 rename-session 项——删 `PI_RENAME_*` env 覆盖层（0 生产 setter），配置源 4 层 → 3 层；isSubagentSession 跨包路径耦合登记 constraints.json C-ext-21。

**In-scope**：`extensions/universal/rename-session/`（src/README/skills/e2e）、`packages/runtime/src/index.ts` + `services/session/`（onSessionRenamed 扇出）、`packages/runtime/src/services/worktree-config-helper.ts` + `transport/settings-message-handler.ts` + `packages/shared/src/protocol.ts`（mode 的 settings 通路）、`packages/renderer`（SystemAutoRenameSection + core settings api + i18n）、`packages/subagent-core/src/execution/path-encoding.ts`（仅注释）+ `docs/constraints.json`。

**Out-of-scope**：ext-simplify-15 的 session-manager 部分（D2 死面删除、B1-B3 low 批——留在原 worktree 另行推进，见附录 A）；`auto-rename-enabled` flag 契约本体（[COMPAT] Remove after v1.0.0）；`/auto-rename` 命令的 mode 子命令（mode 是一次性低频偏好，CLI 用户手编 JSON 等价，本期不做）；mode 组合形态（如「自动 + 工具并存」——0 现存需求方，且若未来要做应建模为正交字段而非组合枚举值，不为它预留任何空间）；smart-context 等其他 extension 的同类问题。

## 2. 现状与问题分析

### 2.1 触发侧：配置静默失败（三层根因之 ①）

rename-session 的可用性需要两个独立条件同时满足：flag 文件 `<agentDir>/auto-rename-enabled` 存在（GUI 开关写它）**且** config 的 `model.ref` 可解析。现状配置解析 4 层优先级（pure.ts:239-254）：env（`PI_RENAME_*`）> flag > config > 默认。默认 `model = {type:"ref", ref:""}`，空 ref 经 `parseRef("")` 返回 null（llm-shared resolve.ts:23-27）→ `resolveModel` null → llm.ts:244-249 `logger.warn("model not available, skipping")` → 静默跳过。

实测证据（2026-09-11 本机）：`~/.xyz-agent/pi/agent/` 下 flag 存在、config `enabled:false` + `ref:""`；当天活跃 session 的 JSONL 里 rename-session entry 数 = 0（功能实际处于「开着但不可用」状态）；另一 session 有 1 条 usage entry（LLM 调用成功）但创建瞬间已有语义名「影响面审-数据可信度设计」（runtime `persistExplicitLabel` 为 handoff/agent-managed session 写入，session-lifecycle.ts:351-379）→ 被防覆盖守卫 `pi.getSessionName() 非空即 skip` 正确拦截。**后者是 by design（语义名不该被覆盖），前者是缺陷**：GUI 只有一个绿色开关和模型下拉框，用户无从知道「还必须选模型」。

env 覆盖层本身也是死代码面：全仓 0 个生产 setter，4 键中 3 键从未被用过，唯一用法是 1 个历史验收场景（ext-simplify-15 §3.1 已详证）。

### 2.2 显示侧：扇出缺口（三层根因之 ②）

rename 落库后的完整链路与断点：

```
[pi 子进程] extension pi.setSessionName(title)
  → pi appendSessionInfo：sanitize → session_info entry（JSONL 追加，最后一条胜）
  → pi _emit("session_info_changed", {name})                  （pi 侧完备）
  → RPC stdout 无过滤转发（rpc-mode.js:266 session.subscribe → output）
[runtime]
  → rpc-client 全量 listeners → event-adapter 转译（已存在，event-adapter.ts:1151-1164）
     ├ kind 'session-renamed' → interpreter → onSessionRenamed（index.ts:380）
     │    └ setLabelCache：只更新内存 label ★缺口：不调 broadcastSessionList()
     └ message 'session.renamed' 定向帧 → messageBus.publish(sid)
          └ 只送达「已订阅该 sid 流」的 ws 连接 ★多窗口/订阅驱逐窗口收不到
  → 无 fs watch / 无轮询：磁盘重扫只在下一次整表广播时发生
[renderer]
  → handleSessionRenamed → sessionStore.applySnapshot(sid,{label})（链路已通，useChat.ts:407-419）
```

对照：GUI 手动 rename 路径（session-message-handler.ts:671-675）在 RPC 成功后**显式调 `broadcastSessionList()`**——这是侧边栏立即刷新的原因。自动路径缺这一步，所以「落库成功但侧边栏不动，直到你随手做别的操作它才突然更新」。

### 2.3 触发时机单一（三层根因之 ③）

现状只有 `turn_end`（stopReason==="stop" 且首个成功 round）一个入口。用户需要 first-prompt（立刻得名）与 agent-tool（agent 自主、零额外 LLM 成本）两种新时机。

### 2.4 现状使用者视角小结

桌面用户今天的样子：新会话发首条消息 → 侧边栏显示「前 10 字符预览…」（display-only 派生名，不落 pi）→ 若模型配置正确且无语义名，首 round 结束 2-30s 后标题落库，但侧边栏大概率不刷新；若模型未配置（默认态），永远停在预览名，无任何提示。

---

## 3. 解决方案

### 3.1 终态：使用者视角

**成功路径**（三种模式各一段，桌面用户）：

```
[模式 first-stop，默认] 用户开关开着、模型未配置（跟随会话模型）
  发首条消息 → agent 回复完成（首个成功 round 末）
  → 2-30s 内侧边栏自动变成 LLM 生成的 slug 标题（如「重构配置加载」），无任何其他操作

[模式 first-prompt] 用户在系统设置把「自动重命名时机」切到「首次请求时」
  发首条消息（无需等回复完成）→ 2-30s 内侧边栏自动得名
  → 标题只基于 prompt 本身生成；agent 随后的回复不再触发第二次改名

[模式 agent-tool] 用户切到「agent 自主命名」
  对话中说「把这个会话改名为 X」或 agent 自认为该命名时调 rename_session 工具
  → 立即落库 + 侧边栏立即刷新；显式改名允许覆盖既有名字（含自动名/语义名）
```

**失败路径**（带恢复指引）：

| 情形 | 行为 | 恢复 |
|---|---|---|
| 显式配了无效 ref（`bad/nonexistent`） | `resolveModel` null → warn「model not available, skipping」静默跳过，主对话不受影响 | 改 config 文件修正 ref，或清空 ref 走跟随会话模型；排查看 session JSONL 的 `rename-session:log` entry（`XYZ_AGENT_DEBUG=1` 时另有文件日志） |
| LLM 调用失败/超时（30s） | 静默跳过保留原 label（现状不变） | 同上；网络问题自查 |
| first-prompt 落库后 pi 在首条 assistant 前崩溃 | 名字随会话整体丢失（session 文件未创建，崩溃窗口内会话本就不可恢复） | 无需恢复——会话本身已丢，重开后由下一轮触发重新命名 |
| 语义名（handoff/agent-managed session）已存在 | 自动路径防覆盖守卫 skip（by design 不变） | 想改用 GUI 手动 rename 或 agent-tool 显式改名 |
| first-prompt 模式 rename LLM 失败 | 触发窗口唯一（首条 user 已消费），该 session 不再有自动命名机会 | 手动 rename；或接受占位预览名（不想错过自动命名选 first-stop 模式，其 error 轮延迟语义有重试） |
| mode 切走后残留 rename_session 工具被调用 | execute 守卫拒绝（isError，经 throw 产生——实装依据见 D3；文案含恢复动作指引，样例见 D3） | 本会话立即改名走手动 rename（GUI rename / pi 原生 `/name`）；或切回 agent-tool（live 读 mode，存量 session 的工具立即恢复可用）；或等新会话（新进程按新 mode 注册/不注册） |
| 切回 first-stop 时 session 已跑过成功 round | 一次性窗口已过（新 round 末 count ≥ 2，判定实装 `!== 1`），该 session 不再自动命名 | 手动 rename（GUI rename / pi 原生 `/name`）；或先切回 agent-tool（残留工具 live 恢复可用）由 agent 改名；或接受现名 |
| agent-tool 模式 agent 一直不调工具 | 不命名（显式模式的产品语义，非缺陷） | 切回 first-prompt/first-stop |

### 3.2 方案对比（总架构）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 单 extension 三分支 + pi 原生事件桥扇出补丁**（本设计） | 触发与落库分离：三入口共用一条已验证的落库管道与事件桥；extension 零 taiji 依赖；模式只是配置枚举 | 低：rename-session 单包为主，runtime 一行扇出 + settings 通路按 5 处既有先例复制 | 低：全部机制有实装先例（turn_end 现状 / registerTool 同仓 4+ 先例 / broadcast 16 处先例） | ✅ |
| B. runtime 侧实现三模式（runtime 监听事件/拦截 prompt 触发 rename） | 破坏分层：runtime 越过 extension 管道直调 pi RPC，extension 与 runtime 双写触发逻辑；原生 pi CLI 用户得不到三模式（能力分裂） | 中：runtime 侧新建触发器 + 与 extension 现有触发去重 | 高：两套触发并存必然打架（防覆盖/一次性语义双实现） | ❌ |
| C. 拆三个 extension 包（每模式一包） | 90% 代码三分拷贝；用户装三选一的认知负担；builtin 清单/打包/版本 ×3 | 高 | 中 | ❌ |

被否后果示例（方案 B）：§2.2 的 `session_info_changed` 桥会被 runtime 触发器与 extension 触发器同时命中，同一 round 双 LLM 调用 + 双 setSessionName 竞态；原生 pi CLI 用户在 first-stop 之外的两种模式上永远落后桌面端。

### 3.3 关键决策与权衡

#### D1：mode 三值枚举（选定：`"first-prompt" | "first-stop" | "agent-tool"`，默认 first-stop）

- **采用**：config schema 加第 5 字段 `mode`；`normalizeRenameConfig` 逐字段校验回默认（旧 config 无字段 → first-stop，零迁移）；三值互斥，`agent-tool` 模式下自动命名逻辑**不激活**（两个事件 handler 常驻注册，每次事件 live 分派拦截——这是「切回 first-stop 即时恢复自动命名」的唯一自洽实现，见求值时点段；「不注册」字面与 live 边界矛盾，v3.3 校准）。**求值时点（by design 边界）**：事件面（自动命名分派）每次事件 live 读 config——GUI 切 mode 对**活跃 session 的自动命名行为即时生效**（边界：first-stop 自动命名受一次性窗口约束，实装判定 `countSuccessfulAssistantReplies !== 1` 即跳过——已在任一 mode 下产生成功 round 的 session 切回 first-stop 后，新 round 末计数必 ≥ 2，**不再自动命名**，见失败路径表「切回时窗口已过」行；切回改变的是分派逻辑，不重置窗口）；工具注册面（`rename_session` 工具）只在 pi 进程启动加载 extension 时求值一次（pi 无 unregisterTool API，loader.js 注册后不可撤销）——**切 mode 后已存活 session 的工具清单不回溯**：切到 agent-tool 当前 session 无工具、切走则工具残留，残留工具由 execute 内 live mode 守卫兜底（见 D3）。GUI 切换交互须提示「工具面对新会话生效」。**开关与 mode 的正交关系**：开关 flag 只门控自动路径（两入口第一步查 `enabled`）；agent-tool 的工具注册与 execute 不受 flag 门控——GUI mode 控件相应不随开关禁用（v3.3 据实现升为书面契约）。**GUI 反馈分流（v3.4 补记）**：该正交契约在切换提示上的用户反馈面——开关关 + 切到自动模式（first-prompt/first-stop）时，toast 换用 `renameModeSwitchedAutoDisabled` 键（披露「需开启开关才会自动生成」的 flag 门控边界，不承诺不会发生的已生效），其余组合用常规 `renameModeSwitched` 键（SystemAutoRenameSection.vue 实装，i18n 双语键齐）。
- **被否**：① 正交两维（autoTrigger × toolRegistered）——支持 4 种组合态，当前只需求 3 种，多出的「自动关 + 工具关」是无意义态；② 组合枚举值（`first-prompt+tool`）——0 现存需求方，且为想象组合预埋建模方向（正交需求未来该用正交字段表达），2026-09-11 过度设计审计判定 cut；③ 工具面动态注册（事件回调内按 live mode 反复 registerTool）——注销缺失导致工具面不可收敛，复杂度全部花在对抗 pi API 限制，收益仅「存量 session 立即获得工具」，不值得。
- **证据**：normalizeRenameConfig 已有 4 字段同款模式（pure.ts:187-209）；startup-config-declaration.test 断言 package.json `startupConfig.content` 与 DEFAULT 深相等——**默认值含 mode 后该声明须同批更新**（拆分层落点）。

#### D2：first-prompt 触发点（选定：`message_end` 过滤 user + event 载荷取文本）

- **采用**：监听 `message_end`（ExtensionHandler 清单实存，types.d.ts:933），过滤 `event.message.role === "user"`；**prompt 文本从 event 载荷取**（实装中 extension handler 执行先于该条 message 的 entries append——`agent-session.js:384` `_emitExtensionEvent` 先于 `:398` `appendMessage`，故 handler 内 `getEntries()` 必不含本条，文本只能从 `event.message` 取，复用 `joinTextBlocks` 拼接逻辑）；**首条 user 判定** = handler 内 `getEntries()` 中 user message 计数 === 0（append 晚于 handler，本条即 session 首条 user——精确且免计数竞态）；守卫链（开关 → subagent 排除 → 防覆盖）复用；LLM 输入走现成两条降级路径（`buildTitleMessages(prompt, "", instruction)`，llm.ts:131）；fire-and-forget 结构照抄现状。
- **重试与幂等语义**：① first-prompt 的 LLM 调用失败（未落名）且首个 round error 时，下一个满足「entries 无 user」窗口的调用不再出现（首条 user 此后已入 entries），但**首条 assistant 完成前该条 prompt 已定，命名机会唯一**——error 轮不重试 first-prompt（与 first-stop 的「error 轮延迟到下一成功轮」不同：first-prompt 的信号在 round 开始时已消费）；② 防覆盖守卫（`pi.getSessionName()` 非空即 skip）保证得名后零重复；③ **在途双发窗口**：fire-and-forget 调用窗口（2-30s）内用户连发第二条 prompt——该条到达时首条 user 已 append（计数=1）不满足首条判定，**by construction 不会双发**；极端交错下双发结果 last-write-wins 无害——实施时加 in-flight 标志去重（**工厂闭包级**，非模块级：pi 的 extensionCache 缓存 factory、每次 session 创建重执行工厂函数，闭包变量 = per-session 生命周期；模块顶层变量进程级存活，进程内 `/fork`、`/session` 切换 session 时会跨 session 污染、吞掉新 session 的唯一命名机会）。
- **steering 边界**：pi 的 steering/follow-up 队列消息同样以 message_end(role=user) 发射；到达时首条 user 已在 entries（计数 ≥1），不满足首条判定，不触发——守卫天然覆盖，无需特判。
- **被否**：① `turn_start`——**pi 0.84.4 实装静态证据否决**：`pi-agent-core/dist/agent-loop.js:50` turn_start 先于本轮 prompts 的 message_start/message_end 发射，且 extension handler（agent-session.js:384）先于 appendMessage（:398），故 turn_start handler 内 entries 必不含本轮 user message（首轮取 prompt 恒为 null）；② `entry_appended` 过滤首条 user entry——该事件在 extension `on()` 类型化清单中不存在（extensions/types.d.ts:906-951 逐行核对；仅 AgentSessionEvent union 成员，RPC 流可见、进程内订阅不到）。
- **pi 边界（设计已核）**：`_persist` 缓冲规则——首条 assistant 前 `setSessionName` 的 session_info entry 只在 pi 内存、不落 JSONL，但事件照发（侧边栏能立刻更新）；首条 assistant append 时全部缓冲 entries（含 session_info）统一 flush（session-manager.js:726-755 实读）。丢名窗口 = 首 assistant 前崩溃 = 会话整体丢失，不做任何补偿机制（审计 A5 cut：补偿时点在数据已落盘之后，同构冗余）。
- **探针**：P1 已过（2026-09-12，u1 实测 dcc189dc4）：载荷含完整文本、`getEntries()` 不含本条——取文本路径成立，零降级（见 §3.4）。

#### D3：agent-tool 模式（选定：registerTool `rename_session` + execute 直写、不走防覆盖）

- **采用**：`pi.registerTool`（types.d.ts:944 实存）注册 `rename_session`，参数 `{ title: string }`；execute 内先 live 读 config，**mode !== 'agent-tool' 时 throw Error 进入 isError 状态**（文案含恢复动作：「模式已切换，rename_session 仅在 agent-tool 模式可用；本会话可切回 agent-tool 立即恢复，或手动改名（GUI rename / pi 原生 /name）」——兜底 D1 声明的切走残留，文案与失败路径表「守卫拒绝」行/V10 通过标准三处对齐），`cleanTitle(title, config.maxTitleLength)` 空值同样 throw（**throw 而非在 execute 返回值上标 isError**：pi 0.84.4 agent-loop `executePreparedToolCall` 将 execute 正常返回包成 `{result, isError:false}`，返回值的 isError 字段被丢弃，isError 状态只能经 throw 产生——v3.4 按 u1 偏差裁决校准措辞，impl-plan §5）；非空直接 `pi.setSessionName`；**不走 `getSessionName()` 防覆盖守卫**——agent 显式调用是「代表用户的意图」，语义等同 GUI 手动 rename，允许覆盖任何既有名。注册条件 = extension load 时 `mode === 'agent-tool'`（见 D1 求值时点边界）。tool description 写明语义与时机建议（弱引导，universal 包不依赖 taiji 的 system prompt 注入）。
- **被否**：三模式都常驻注册工具——组合态（audit A4 已 cut）；工具走防覆盖守卫——agent 永远改不了自动生成的名字，模式失去意义。
- **证据**：registerTool 同仓 4+ 先例（base-tool-enhance/ask-user/cw-tool/goal）；pi 内置工具（bash/edit/...）无 rename，不撞名（dist/core/tools/ 实查）。
- **成本声明**：「零额外**调用**成本」指不发起独立 rename LLM 调用（主模型顺手命名）；工具 schema + description 常驻 agent 工具清单，每 turn 携带 ~百 token 级——仅 agent-tool 模式承担，量级可忽略但与「零调用成本」区分表述。

#### D4：显示层扇出修复（选定：onSessionRenamed 补 broadcastSessionList + 空 label 回落）

- **采用**：处理体见 `packages/runtime/src/services/session/session-rename-fanout.ts`（`createSessionRenamedHandler`，组合根 index.ts :558 接线），先 `setLabelCache` 后 `broadcastSessionList()`——行为契约对齐手动 rename（session-message-handler.ts:703）。活跃 session 的内存 label 已新鲜（broadcast 现算直读内存），非活跃 session 靠磁盘扫描且 metaCache 键 `(mtime,size)` 因 session_info 追加自然失效。同批顺手修：`name === undefined`（pi 清名事件）时 `setLabelCache(sid, '')` 会把 label 置空串——改为回落 basename 派生（回落实现同在 session-rename-fanout.ts，与 scanner 兜底及 create/fork 初始 label 同语义）。
- **覆盖面限定（已核实）**：修复覆盖 **xyz-agent 管理的 pi 进程内**的全部 rename 来源——三模式自动、rename_session 工具、GUI 手动（经 runtime RPC）、以及任何该进程内 `setSessionName` 调用（统一走 `session_info_changed` 事件）。**已知边界**：xyz session 目录外的进程写入（原生 pi TUI `/name`、`pi --name` CLI）不产生 xyz 可见事件——xyz 数据目录隔离（独立 `--session-dir` + `PI_CODING_AGENT_DIR`）使常规场景不触发；显式指向共享目录的高级场景靠懒收敛兜底（下次任意整表广播时 metaCache 因 mtime 变化失效带出新名）。
- **连带量级声明**：GUI 手动 rename 路径此后每次产生 **2 次**整表广播（handler 显式调用 + 事件回调追加，毫秒级间隔）——renderer 侧 `mergeViewSnapshot` scan 来源分流守卫幂等无风暴，手动 rename 为低频操作，判定可接受；「收敛为事件单源（删 handler 显式调用）」登记为未来清理项，本期不动（避免与 D4 修复耦合回归面）。
- **被否**：① 保留定向帧即可——多窗口/订阅驱逐窗口收不到，结构性缺口；② fs watch session 目录——事件桥已存在，纯增复杂度；③ broadcast 防抖——rename 是低频事件（手动 rename 路径同样每次广播），16 处先例均无防抖。

#### D5：空 model ref 跟随会话模型（选定：fallback `ctx.model`，消灭默认静默失败）

- **采用**：`callRenameLLM` 内模型解析改为——`config.model.ref` 为**空串**（未配置语义）时直接用 `ctx.model`（ExtensionContext.model，types.d.ts:222-223 实存，`Model | undefined`；undefined 时无 fallback，走原「model not available, skipping」静默跳过）；ref **非空但解析失败**（配错）维持现状静默跳过 + warn（保留配置错误的可诊断性，不掩盖）。GUI 模型下拉「未设置」文案改为「跟随会话模型」语义。
- **被否**：GUI 强制配置 + warning 提示——静默失败只是变得可见而非消失，且多一个 warning 派生态。
- **证据**：现状「默认开 flag（ensureAutoRenameDefault）+ 默认空 ref = 默认不工作」是真实现役缺口；smart-context 同款语义先例（compactModel 空串 = 跟随当前会话模型，worktree-config-helper.ts:466 注释明言）。
- **代价四要素（已接受代价，P0-20）**：
  - **量级**：一次 rename 调用 ≈ 2k input + 64 output token（两段信号各截 4000 码点 + maxTokens 64），每个新 session 至多一次；存量「flag 开 + ref 空」用户升级后从零调用变为主模型计费（coding-plan 5h 窗口用户计入窗口用量）。
  - **恢复路径**：GUI 关自动重命名开关（flag 删除，回到全关）；或系统设置选专用低价模型（如 flash 级），单次成本降至忽略不计。rename 用量全额计入 usage 统计 rename 虚拟桶（usage-stats-service.ts:133,275，经 appendUsageEntry 落账），用户可审计实际开销。
  - **重审条件**：release 后若 rename 桶 token 占用户总量比异常（>1%）或出现额度压力反馈，重审默认策略（候选：首启弹窗引导配模型替代静默 fallback）。
  - **显式判定**：单次调用成本相对单 session 正常对话（数十万 token 量级）占比 <0.5%，且换来「默认配置即可用」的目标 3——判定**可接受**；该行为迁移在 release notes 显式声明（双语）。
- **与 ext-simplify-15 的冲突裁决**：原设计 V3/V8 验收场景以「默认空 ref → 静默跳过」为基准路径——本决策落地后空 ref 不再走该路径，**该验收场景改用显式无效 ref**（`invalid-provider/nonexistent-model`，parseRef 成功 → modelRegistry.find 失败 → null → 同一守卫静默跳过），与原 V8 场景的注入语义等价（详见 §4 V7 与附录 A）。

#### D6：删 `PI_RENAME_*` env 覆盖层（吸收 ext-simplify-15 D1，选定：四键整体删除）

- **采用**：删 `getEnvOverrides`（pure.ts:74-114）、`ENV_PREFIX`/`MODEL_REF_PART_COUNT` 常量（:53-57）、`loadRenameConfig` env 合成段（:243-251，flag 检查简化为无条件 `existsSync`）、pure.test.ts「环境变量覆盖」describe 整块（:261-404）、README/SKILL.md 的 env 文档行（4 源改 3 源）。配置源终态：flag > config > 默认。
- **被否**：保留 `PI_RENAME_MODEL` 单键——覆盖层骨架全保留，1 键维护费照付。
- **证据**：全仓 0 生产 setter（ext-simplify-15 §3.1 已证，本 worktree 复核同结论）；原 V8 验收按 D5 冲突裁决改道（不再依赖空 ref 路径，也不需要 env 注入）。

#### D7：isSubagentSession 跨包耦合登记 C-ext-21（吸收 ext-simplify-15 D3，选定：登记 + 双端注释）

- **采用**：constraints.json 登记 C-ext-21（scope：`packages/subagent-core/src/execution/path-encoding.ts` + `extensions/universal/rename-session/**`；enforcement：review-arch-boundary；登记后跑 `node scripts/render-constraints.mjs`）；llm.ts isSubagentSession 注释与 path-encoding.ts getSubagentSessionDir 注释互指。**三模式的新入口（message_end / rename_session 工具）同样复用该守卫，约束覆盖面自动扩展**。
- **被否**：收敛为读 `PI_SUBAGENT_*` env 或 universal 包 import subagent-core——契约面反而扩大 / role=universal 失格（ext-simplify-15 §6.3 已详证）。

#### D8：验收形态（选定：e2e 事件序断言 + GUI 场景集）

- **采用**：e2e 新增 2 场景沿用「本地人工触发、真实 pi 进程 + 真实模型」形态；first-prompt 场景断言**触发时点 + 最终态**（见 V2：handler 同步段早于 assistant message_start，完成序不做 gate）而非墙钟时间差；GUI Playwright 验收场景集 = V4（单窗零操作刷新）+ V5（多窗一次）+ V6（语义名防覆盖）+ V10（mode 切换边界）——broadcast 是 WS 层广播天然多窗一致，多窗与模式正交，不做模式 × 多窗矩阵（审计 D-gui simplify）。
- **被否**：时序差断言（脆弱）；三模式 × 多窗矩阵（为想象场景付费）。

### 3.4 探针清单（已全部闭环，v3.4 回写）

| ID | 验证的行为 | 探针 | 状态 | 失败降级 |
|---|---|---|---|---|
| P1 | `message_end(role=user)` 到达 extension handler 时：`event.message` 载荷含完整 prompt 文本（string 或 blocks 可拼），且 `getEntries()` 确不含本条（验证 handler 先于 append 的静态结论，D2 取文本路径成立） | 本地 pi CLI：`--mode rpc` 起 pi + 临时 extension 打点 event 载荷与 entries 快照，发一条消息比对 | ✅ 已过（2026-09-12，u1 实测 dcc189dc4）：载荷含完整文本、entries 不含本条——D2 取文本路径成立，零降级 | 载荷不含文本（理论不发生）→ 改读 RPC 出口流事件序兜底拼装；entries 已含本条 → 首条判定改「计数含载荷条目的等价重算」，D2 其余不变 |
| P2 | `ctx.model` 在 rpc 模式下首轮可用（D5 fallback 目标非 undefined） | 同 P1 环境，extension 内打点 `ctx.model?.provider/id` | ✅ 已过（2026-09-12，u1 实测 dcc189dc4）：ctx.model 首轮可用——D5 fallback 成立，零降级 | undefined 时 fallback 路径静默跳过（维持现状可诊断），D5 结论降级为「跟随会话模型（可用时）」 |
| P3 | `broadcastSessionList` 在 onSessionRenamed 回调内可安全调用（无重入/时序问题） | dev app 起一个 session 跑 rename，核对 WS 帧序（session.renamed 定向帧与 config.sessions 整表帧都到达且无死锁/重复风暴） | ✅ 已过（2026-09-12，u4 单测级 cbf6b5894 + 帧序归 Gate B V4/V5 pass）：同步调用安全，无需微任务尾部调度降级 | 改为微任务尾部调度（queueMicrotask/short debounce），行为契约不变 |

---

## 4. 验收（真实场景，非单测非 mock）

改动规模「大」（三新模式 + 行为变更 + 跨 4 层），10 个真实场景。单测/typecheck/lint 全绿是合入门禁但不计入验收。

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | first-stop 主流程回归 | 目标 1 | pi CLI：`PI_CODING_AGENT_DIR=<tmp>` + flag + config 只写 mode: first-stop（模型留空），新 session 发消息（真实模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`，e2e/README 最小样例） | 标题落库且**用会话主模型**生成（D5：空 ref fallback 生效，usage entry 的 model 字段 = 主模型）；日志显示 rename with model |
| V2 | first-prompt 立刻得名 | 目标 1 | 同 V1 环境但 mode: first-prompt，发一条长 prompt | **触发时点断言（稳定）**：首条 assistant `message_start` 之前，rename LLM 请求已发出（harness 轮询 debug 内省日志 `LLM request messages`，A3 场景同构先例）；**最终态断言**：标题落库且仅基于 prompt 语义、后续 round 不再改名。rename 完成 vs assistant 完成的相对次序**不做 gate**（两个独立 LLM 调用的完成序受 provider 排班影响，仅观察记录） |
| V3 | agent-tool 模式 | 目标 1 | 同 V1 环境但 mode: agent-tool，prompt 要求 agent 调 rename_session 命名；对照进程以 first-stop 起 | 工具被调用且立即落库（session_info entry 出现）；此前已有自动名时**成功覆盖**（不走守卫）；对照进程的 session JSONL **无任何 rename_session toolCall entry**（确定性判据：pi RPC 无工具清单查询命令，但无工具 ⇒ 必无 toolCall，与 agent 行为无关） |
| V4 | 侧边栏零操作自动刷新 | 目标 2 | GUI dev（Playwright 连 9222）：mode: first-prompt，新建会话发消息，期间不做任何点击/切换 | 侧边栏该条目 label 在 LLM 窗口（≤30s）内自动变为标题，无任何用户操作（D4 修复的直接验证） |
| V5 | 多窗口一致 | 目标 2 | GUI dev 双窗口（create-window）看同一 session，触发一次 rename | 两窗口侧边栏均刷新且一致（broadcast 全局性） |
| V6 | 语义名防覆盖回归 | 目标 1 | GUI dev：经 handoff 创建承接 session（persistLabel=true 已写名），跑 first-stop 自动 rename | 自动路径 skip（`name exists` 日志——fire-and-forget LLM `.then` 落库前重查检查点），语义名不被覆盖 |
| V7 | 无效 ref 静默跳过（原 ext-simplify-15 V3 改道） | 目标 3/4 | 同 V1 环境，config 显式写 `model.ref: "invalid-provider/nonexistent-model"` | 主对话正常完成；warn「model not available, skipping」留痕（session JSONL custom entry）；无标题落库 |
| V8 | env 残留负面（ext-simplify-15 V2） | 目标 4 | 同 V1 环境但 shell 预置 `PI_RENAME_ENABLED=false PI_RENAME_MODEL=bad/x` | 行为与无该变量完全一致（D6：删掉的层不再有幽灵效果） |
| V9 | 空名回落（D4 顺手修） | 目标 2 | **已改道（v3.4 回写）**：原程序「pi CLI 起进程后经 RPC `set_session_name` 传空串触发清名事件」不可执行——pi 0.84.4 RPC 层 trim 校验拒空串（rpc-mode.js:526-529），清名事件现网无自然生产者，D4 空名回落为纯防御路径；实际经 GUI 组事件注入验证（注入空名事件核对宿主侧 D4 回落，runtime 单测 + 事件注入双验证，Gate B V9 pass） | runtime 侧 label 回落 basename 派生而非空串；事件载荷形态为 name 字段缺失（undefined ≠ 空串，session-manager.js:848-858 trim 归一），renderer 不写空 label |
| V10 | mode 切换的存量 session 边界 | 目标 1 | GUI dev：session A 以 first-stop 起动并跑完一轮（已自动命名），GUI 切到 agent-tool → A 内发新消息（live 读到 agent-tool，**不应**再自动命名）→ prompt 让 agent 调 rename_session（A 起动时未注册——判据 = A 的 JSONL 无 rename_session toolCall entry，无工具 ⇒ 必无 toolCall）→ 新建 session B（agent-tool 起动，**有工具**且调用成功改名）→ 切回 first-stop → B 内残留工具调用**应被 execute 守卫拒绝**（isError 带恢复指引文案）；B 完成一个新 round → turn_end 自动逻辑 live 恢复（first-stop 分派生效），但 B 在 agent-tool 期间改名所在的 round 已计入 countSuccessfulAssistantReplies，切回后新 round 末 count ≥ 2，被一次性窗口判定拦截（debug 日志 `skip: count=N`），不发起 rename LLM 调用，agent 名保持不变 | 事件面 live 双向生效（A 切走即停、B 切回即恢复分派）；工具面按进程起动时 mode（A 无 toolCall、B 有且成功）；残留工具被守卫拒绝且文案可指引恢复；agent 名保持不变（拦截归因 = **一次性窗口 count ≥ 2**，非防覆盖守卫——实装判定顺序 count 先行，本场景下守卫不可达；「已有名 + count === 1」的防覆盖检查点由 V6 同构覆盖：语义名与 agent 名走同一 fire-and-forget `.then` 落库前重查，证据形态同为 `skip: name exists` 日志） |

补充：V1/V2/V3/V7/V8 共享同一套临时环境可顺序跑完；V4-V6/V10 用 `~/.xyz-agent-dev` 隔离数据目录；V9 已改道入 GUI 组执行（原因与实际程序见 V9 行，v3.4 回写）；验收记录（事件序摘录 + JSONL 片段 + 截图）贴实施 PR。

---

## 5. 下一层拆分

### 5.1 里程碑

| 阶段 | 内容 | 交付 | 验收挂点 |
|---|---|---|---|
| M1 | extension 单包：mode 枚举 + 三模式入口 + D5 fallback + D6 env 删除 + D7 登记 + README/SKILL/e2e | rename-session 三模式终态 | V1/V2/V3/V7/V8 + extensions 三连绿 + render-constraints --check |
| M2 | runtime：D4 扇出修复 + mode 的 settings 通路（worktree-config-helper RMW + settings-message-handler + shared protocol） | 侧边栏自动更新 + mode 可配置 | V4/V5/V9 + runtime vitest 绿 |
| M3 | renderer：SystemAutoRenameSection 模式 Select + 「跟随会话模型」文案 + core settings api + i18n 双语 + 切换生效提示（「工具面对新会话生效」） | GUI 配置面 | V4/V6/V10（含 GUI 切换模式实测） |

依赖：M2/M3 依赖 M1 的 mode 字段落定（settings 读写它）；M1 可独立先发（原 first-stop 行为不变，先修显示层反而独立受益——M2 实际可与 M1 并行开发，仅 settings 通路联调依赖 M1）。

### 5.2 单元拆分清单

| 单元 | 范围 | justification |
|---|---|---|
| u1 = M1a | pure.ts（mode 字段 + env 删除）+ llm.ts（fallback）+ index.ts（message_end 入口 + 模式分支 + 工厂闭包级 in-flight 去重）+ 工具注册 | 触发层单包自包含，可独立验收回滚 |
| u2 = M1b | README/SKILL 更新 + startupConfig 声明同步 + e2e 两新场景脚本 | 文档/资产与行为同批（纪律：符号变更同批清扫文档引用）；ext-simplify-15 吸收登记的载体 = 本设计附录 A（随本设计进 git 历史），**不改兄弟 worktree 的 untracked 文档**（见附录 A 处置声明）；README 增一行指针「env 覆盖层已删，rename-session 相关精简项裁决见本仓 `docs/design/rename-session-three-modes.md` 附录 A」——把吸收登记的主动可达性从「搜 git 历史」提升到「动这个包必读」 |
| u3 = M1c | C-ext-21 登记（constraints.json + render + 双端注释，含 subagent-core 注释） | 纯登记零行为，独立 review 面 |
| u4 = M2a | index.ts onSessionRenamed 扇出 + 空 label 回落 | 核心修复最小面 |
| u5 = M2b | settings 通路（helper → handler → protocol，命令名 `config.getRenameMode`/`config.setRenameMode` 对齐既有 `config.setRenameModel` 前缀惯例）+ **`RENAME_MODEL_DEFAULT_CONFIG` 镜像同批加 mode 字段**（worktree-config-helper.ts:229-238 注释自称与 extension DEFAULT 一致，三处默认值真相——pure.ts / startupConfig.content / 此镜像——必须同批收敛） | 第 6/7 个字段级 RMW 先例复制，独立联调面 |
| u6 = M3 | renderer GUI + i18n | 前端独立验收（Playwright） |

### 5.3 文件改动地图

| 文件 | 改动 |
|---|---|
| `extensions/universal/rename-session/src/pure.ts` | +mode 字段/normalize/默认值；−env 覆盖层（~60 行） |
| `extensions/universal/rename-session/src/llm.ts` | 模型解析 fallback 分支；isSubagentSession 注释 +C-ext-21 互指 |
| `extensions/universal/rename-session/src/index.ts` | message_end(role=user) 入口 + mode 分派 + in-flight 去重 + rename_session 工具注册（load 时 mode===agent-tool）+ execute 内 live mode 守卫 |
| `extensions/universal/rename-session/src/__tests__/` | pure.test（−env 块 +mode 用例）、index.test（模式分支）、llm.test（fallback） |
| `extensions/universal/rename-session/package.json` | startupConfig.content 默认值 +mode；minor bump |
| `extensions/universal/rename-session/{README.md,skills/.../SKILL.md}` | mode 文档 + 3 源配置表 + 跟随会话模型语义 + 附录 A 指针一行（见 u2） |
| `extensions/universal/rename-session/e2e/` | run-a6（first-prompt）/run-a7（agent-tool）+ harness 断言函数 |
| `packages/runtime/src/index.ts` | onSessionRenamed +broadcast + 空名回落 |
| `packages/runtime/src/services/session/session-rename-fanout.ts` | D4 处理体提取（index.ts 文件尾 main() 无条件执行使接线闭包不可直测，agent-settled-fanout.ts 先例；impl-plan u4 偏差裁决，v3.3 回写） |
| `packages/runtime/src/services/worktree-config-helper.ts` | +getRenameMode/setRenameMode（rmwExtConfigField 复用）+ `RENAME_MODEL_DEFAULT_CONFIG` 镜像补 mode 字段 |
| `packages/runtime/src/transport/settings-message-handler.ts` + `packages/shared/src/protocol.ts` | `config.getRenameMode` / `config.setRenameMode` 命令（对齐 config.* 前缀惯例）；接线链扩张 4 文件（interfaces.ts IConfigService 两方法声明 / config-service.ts 委托 / shared index.ts RenameMode 导出 / worktree-service.test.ts mock stub）见 impl-plan §5 u5 偏差裁决（v3.4 回写） |
| `packages/core/.../domains/settings.ts` + `packages/renderer/.../SystemAutoRenameSection.vue` + i18n ×2 | 模式 Select + 文案 |
| `packages/subagent-core/src/execution/path-encoding.ts` | 仅注释（C-ext-21 消费方指向） |
| `docs/constraints.json` → `docs/constraints.md` | +C-ext-21（render 脚本再生成） |

### 5.4 待验证检查点

- P1/P2/P3 探针结果——已全部闭环（v3.4 回写，见 §3.4 状态列：P1/P2 = u1 实测通过零降级 dcc189dc4，P3 = u4 单测级通过同步调用安全 cbf6b5894 + 帧序归 Gate B V4/V5 pass）。
- e2e harness 对 message_end 事件的监听能力核对（现有 harness 只订阅既有事件面，可能需扩展事件白名单——实施时确认）。
- D6 删除后 `docs/design/usage-page-fixes.impl-plan.md:41,102,123,147` 对 `PI_RENAME_MODEL`/`getEnvOverrides` 的引用成为悬空引用——该文档是历史签收记录**保留原样不改写**（不在 check-doc-symbol-drift 守卫覆盖内，登记此处置声明防实施期困惑）；若未来重跑该 wave，按本设计 §3.3 D6/V7 新程序执行。
- GUI「跟随会话模型」文案与既有 RenameModelNotSet i18n 键的关系——**已定（2026-09-12 u6）：新键 `renameModelFollow` 替代 `renameModelNotSet`（旧键删除 0 残留；对齐 smart-context `smartContextModelFollow` 先例，避免键名与语义长期矛盾）**。

---

## 附录 A：与 ext-simplify-15 的关系及冲突裁决

| ext-simplify-15 条目 | 本设计处置 |
|---|---|
| D1（删 PI_RENAME_* env 层） | **吸收**为本设计 D6，执行项（A1-A3）并入 u1/u2 |
| D3（C-ext-21 isSubagentSession 登记） | **吸收**为本设计 D7，并入 u3 |
| D4（preview 双维护接受现状）/ C3（export 面登记不执行） | **零改动裁决随本设计关闭**，不再悬置 |
| D2/B1-B3（session-manager 部分） | **不吸收**——留在原 worktree（feat-optimize-extensions-over-engineering）的设计 15 内另行推进。**处置声明**：ext-simplify-15 文档在该分支当前为 untracked（`git log --all` 无提交包含），本设计不触碰它（改 untracked 不进历史、跨分支提交属跨任务污染）；吸收关系的登记载体 = **本附录 A 表格**（随本设计进 git 历史）。执行依赖：ext-simplify-15 后续落地（commit/审查/实施）时，其实施者须对照本表**跳过 D1（删 env）/D3（C-ext-21）/D4/C3**（已被本设计 D6/D7 吸收），否则删 env 必与本设计冲突 |
| V1-V5 验收场景 | V1（主流程）→ 本设计 V1（叠加 D5 fallback 断言）；V2（env 残留）→ V8 原样保留；**V3（原空 ref 静默跳过）→ 改道为 V7（显式无效 ref）**——冲突根因：本设计 D5 把空 ref 语义从「静默跳过」改为「跟随会话模型」，原场景的等价性基础不复存在，改道后守卫路径（modelRegistry.find 失败 → null → 跳过）与原 V8 注入语义等价；V4/V5（session-manager）→ 留原设计 |

## 附录 B：变更历史

- v1（2026-09-11）：初稿。综合三源——用户三模式需求 + 侧边栏更新（本会话架构方案与过度设计审计修正：A2 事件改道、A4/A5 cut、C2 移出、D-gui 简化）+ ext-simplify-15 rename-session 精简项（D1/D3/D4/C3 吸收、V3 冲突裁决）。8 个决策 + 3 探针 + 9 验收场景 + 6 单元拆分。
- v2（2026-09-11）：双审修复（主审 2 MF + 3 S，影响面审 2 MF + 6 S，全修）。D2 主选 turn_start → **message_end**（pi 实装静态证据：agent-loop.js:50 turn_start 先于本轮 message 事件、agent-session.js:384 handler 先于 :398 appendMessage——turn_start 时 entries 必不含本轮 user，旧主选首轮恒 null；被否谱系记入 D2）；V2 验收改触发时点断言 + 最终态断言（完成序竞态不做 gate）；D1/D3 补 mode 求值时点边界（事件面 live / 工具面 startup + execute 守卫兜底）+ V10 混合态场景；D5 补代价四要素；D4 覆盖面限定为 xyz 管理的进程内来源 + 手动 rename 双广播量级声明；命令名对齐 config.* 前缀；ext-simplify-15 吸收标注交付物（合并顺序依赖）；u5 增 RENAME_MODEL_DEFAULT_CONFIG 镜像同批；V9 补触发手段（pi CLI RPC）；D2 增在途双发窗口声明 + in-flight 去重；D3 补 schema 常驻 token 量级；D6 悬空引用处置声明。验收 9 → 10 场景。
- v3（2026-09-11）：影响面审第 2 轮修复（2 MF + 3 S）。**V10 预期方向修正**（v2 把「切到 agent-tool 后 A 仍自动命名」写反——事件面 live 的正确语义是切走即停自动命名；连带补「切回后 B 首个成功 round 的自动命名被 agent 已设名防覆盖拦截」闭环断言）；**ext-simplify-15 标注载体改判**（该文档在兄弟分支 untracked、三路皆断——改为本附录 A 表格为唯一登记载体 + 兄弟分支落地时实施者自查，u2 撤销跨 worktree 写入）；失败路径表补「守卫拒绝」「切回时一次性窗口已过」两行；in-flight 标志层级修正（模块级 → **工厂闭包级**，防 /fork、/session 进程内切 session 时跨 session 污染）；D8 GUI 场景集与 §4 实际构成对齐（V4/V5/V6/V10）。
- v3.1（2026-09-12）：主审第 2 轮复审 0 must-fix + 1 suggestion 修复——V3/V10 的「工具不在清单」断言改为确定性判据（JSONL 无 rename_session toolCall entry：pi RPC 无工具清单查询命令，无工具 ⇒ 必无 toolCall，与 agent 行为无关）。主审五条 v2 修复全数核实成立（含 V2 时序断言的 await 链构造性闭合增强论证）。
- v3.2（2026-09-12）：影响面审第 3 轮修复（1 MF + 3 S）。**V10 B 段断言归因修正**（v3 的「防覆盖守卫 skip」路径在实装判定顺序下不可达——同步段 `count !== 1` 先行 return，callRenameLLM 不发起，`.then` 落库前防覆盖重查不执行；改为「一次性窗口 count ≥ 2 拦截（`skip: count=N` 日志），agent 名保持不变」+ 防覆盖检查点由 V6 同构覆盖声明——语义名与 agent 名走同一 `.then` 重查，证据形态同为 `skip: name exists`）；D1 事件面补一次性窗口边界句（已消费窗口的 session 切回不自动命名，切回改变分派不重置窗口）；失败路径表「切回时窗口已过」行恢复指引修正（v3 的「残留 agent-tool 工具改名」在本行 mode=first-stop 前提下被 execute 守卫拒绝——标注「先切回 agent-tool」前置；「守卫拒绝」行恢复列补手动 rename 出路）；D3 isError 文案样例补恢复动作指引并与失败路径表/V10 三处对齐；u2/§5.3 README 增附录 A 指针一行（吸收登记的主动可达性锚点）。
- v3.3（2026-09-12）：实施期校准（dev-flow 阶段 3 一致性审查 doc_errors 修复）。D1 首句「不注册自动逻辑」改为「不激活（handler 常驻 + live 分派拦截）」——消除与同段 live 边界/V10 B 段的字面矛盾（实现即如此）；D1 补开关与 mode 正交关系书面契约；§5.3 文件地图补 session-rename-fanout.ts 行（u4 偏差裁决回写）；§5.4 i18n 键决定回写（新键 renameModelFollow）。设计 D3「返回 isError」在 pi 0.84.4 实装的正确映射为 throw（execute 返回值 isError 字段被 agent-loop 丢弃），实现已按 throw 落地（u1 偏差登记）。
- v3.4（2026-09-12）：design-code-sync 第 2 轮第 1 批（设计文档组 5 finding，全部 code-right 修文档）。① 探针状态回写：§3.4 三探针全部闭环（P1/P2 = u1 实测通过零降级 dcc189dc4；P3 = u4 单测级通过同步调用安全 cbf6b5894 + 帧序归 Gate B V4/V5 pass），§5.4/D2 尾注同步去除待决口吻（依据 impl-plan §7「探针 P1-P3 已全部闭环」）；② V9 改道回写：原「pi RPC set_session_name 传空串」程序被 pi 0.84.4 RPC 层 trim 校验拒绝（rpc-mode.js:526-529，清名事件现网无自然生产者），V9 实际经 GUI 组事件注入验证（runtime 单测 + 事件注入双验证，Gate B V9 pass），回落 basename 断言保留，§4 分组补充句同步；③ D3 throw 措辞校准（兑现 v3.3 登记的 u1 偏差承诺）：execute 正常返回的 isError 字段被 agent-loop 丢弃，isError 状态只能经 throw 产生——D3 两处与 §3.1 失败路径表同步改 throw 表述；④ §5.3 settings 行补 u5 接线链扩张 4 文件指针（对齐 u4 偏差回写的同类处理，消除不对称）；⑤ D1 补 GUI toast 分流记载（开关关 + 切到自动模式 → `renameModeSwitchedAutoDisabled` 键披露 flag 门控边界，SystemAutoRenameSection.vue 实装）。
