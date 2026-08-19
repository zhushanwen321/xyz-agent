# pi 行为错误假设修复计划（pi-assumption-remediation）

> **一句话结论**：三领地排查证实 13 条对 pi 的错误假设（1 critical + 4 major，含「模型切换从未生效」「启动时删用户 provider 配置」）与 8 条版本漂移，共同根因是**本地 pi-mono clone 停在 0.80.3 而实装 0.84.1**；本计划全部修复 + 治本（clone 更新与「断言以实装版为准」流程规则）。
>
> 层声明：当前层 = 技术方案设计，下一层 = wave 拆分（W1-W6，§5）。证据 SSOT = `.xyz-harness/2026-08-19-pi-assumption-audit/report-{a,b,c}*.md`（每条含 pi 实装版一手锚点，本文不复述全部证据只引用编号）。

## 1. 背景目标

**SCQA**：

- **S**：xyz-agent 与 pi（`@earendil-works/pi-coding-agent@0.84.1`）深度耦合——runtime spawn 子进程、14 个扩展跑在 pi 进程内、core 按 pi entry 类型重放会话。代码里遍布对 pi 行为的假设（注释声明、防御代码、字段映射）。
- **C**：tmp 附着 P0 修复后做了全面排查（三 reviewer 并行、逐条对照 node_modules 实装版源码）：88 条假设中 13 条错误、8 条过时漂移、7 条未验证风险。错误集中在两个模式：**0.80.3 旧结论未随版本重验**（thinking 值域 / provider 有效性 / KnownApi / system prompt）与 **wire 层字段可见性**（pi 序列化剥离字段致机制死代码）。
- **Q**：模型切换从未生效（用户以为切了）、启动 sanitize 会物理删除合法 provider 配置（数据丢失）、最高思考档静默丢弃、tool-call-index 机制死代码、5 个扩展包的错误标记全部失效。
- **A**：分 6 个 wave 全部修复（对齐实装版行为）+ 治本（更新 clone、确立「断言以实装版为准」规则、未验证风险项逐一处置）。

**设计目标**：

| # | 目标 | 使用者可见行为 |
|---|------|--------------|
| G1 | 模型切换真实生效 | 点「切换到 X」→ 实际模型变为 X；重启 pi 附着 session 后仍是 X |
| G2 | 用户 provider 配置零丢失 | 只配 apiKey 的 provider 启动后完好；真空壳仍被清理 |
| G3 | 思考档全值域可用 | UI 选「最高(max)」→ pi 进程真的带 max |
| G4 | wire 层机制真产出 | 工具调用对话中 tool-call-index 事件真实到达前端（toolCall 块顺序正确） |
| G5 | 扩展错误被 pi 采信 | 工具失败 → pi 标 isError → 轮次记录正确、审计可见 |
| G6 | 同类问题不再来 | clone 与实装版对齐 + 断言规则固化；R1 补流式写形态缺口 |

**in scope**：排查报告 a/b/c 的全部错误类 + 过时类 + 可低成本对齐的风险项 + 流程治本。
**out of scope**：A-04 放开 bash 并发（自设 UX 约束保留，仅修文案）；未验证风险中判定「记录观察」的项（F8 SIGINT 窗口、pi-ai/compat 上游废弃——超本计划能力，登记观察）。

## 2. 现状与问题分析（按修复批次归纳，证据见审计报告）

### 2.1 批次一：模型/provider 正确性（critical + 数据丢失）

- **B-F1（critical）**：`extensions/model-switch` 的 `switchToModel` 只做存在性检查 + 写 custom entry，全仓无 `pi.setModel` 调用（pi 唯一切模型 API，`extensions/types.d.ts:954`）；custom entry 非 pi 原生 `model_change`（session-manager 恢复模型只认原生形态）→ 切换从未生效、重载也不恢复，却返回成功文案。
- **B-A02（major）**：`pi-provider-repair.ts` 的 isInvalidProvider 沿用 0.80.3「五字段全空才算无效」；0.84.1 `provider-composer.js:86-93` 已放宽（baseUrl/headers/compat/modelOverrides/models/apiKey/oauth/authHeader **任一存在即合法**）→ 启动 sanitize 把「只配 apiKey」的合法 provider 从 models.json 物理删除，静默数据丢失无自愈。

### 2.2 批次二：值域/文案与 0.84.1 对齐（漂移类）

- **thinking `max` 缺失**（A-03 / C#1，双 agent 独立发现）：pi 0.84.1 `cli/args.js:6` 值域含 `max`，composer UI 默认档就是 max，但 runtime `VALID_THINKING_LEVELS`（session-lifecycle.ts:123）与 shared `ThinkingLevel` 类型（pi-preset.ts:27）均缺 → spawn 校验失败静默丢弃 `--thinking`。协议文件 `pi-protocol.ts:403` 的 `PiThinkingLevel` 已是全集（含 max）——SSOT 已存在只是没人从它派生。
- **KNOWN_PI_API_TYPES 3/10**（A-09 / C#2）：shared/constants.ts:53-57 只列 3 个，pi-ai 0.82.1 `KnownApi` 实为 10 个 → 7 种合法 api 误 warn、前端选不了。
- **DEFAULT_PI_SYSTEM_PROMPT 过时一行**（C#7）：0.84.1 新增 environment variables 文档路由行。
- **旧包名文案**（A-07 / C#4）：process-manager.ts:228 恢复指引指向已迁移的 `@mariozechner/` scope。

### 2.3 批次三：wire 层死代码（字段可见性模式）

- **tool-call-index 永不产出**（A-01，major）：event-adapter.ts:111-125 从 `event.message?.content?.[i]?.id` 提取 toolCallId，但 pi `toJsonEvent`（`modes/json-event.js:3-15`）对 message_update 只输出 `{type, assistantMessageEvent}`，顶层 `message` 被整体剥离 → 提取恒 undefined，机制声称要修的 toolCall 顺序错位从未被修过；单测 mock 自带 message 字段故测试绿生产死。
- **协议 SSOT 自相矛盾**（A-05）：pi-protocol.ts:470 声明 select options 为 `Array<{label,value}>`，pi 实为 `options: string[]`（extensions/types.d.ts:70）——协议真契约文件反而保留了已被修过的错误认知。

### 2.4 批次四：extensions 错误语义范式（跨 5 包）

- **`execute` 返回 `{isError:true}` 不被 pi 采信**（B-F2，major）：pi-agent-core `agent-loop.js:453-483` 对正常 return 恒 `isError:false`，返回值里的 isError 被丢弃；**只有 throw 才置错**（pi 自带 bash.js 即此范式）。9 处违规：session-reader:170 / ask-user:271,281,315 / scheduler:137,163 + tool.ts:100 / subagent-workflow tool-workflow.ts:442,501 + script:402,432。影响：错误轮被标成功、unified-hooks 审计系统性漏报。goal-control-adapter 与 structured-output 用 throw 是正确范本。
- **goal STALE_CONTEXT_PATTERNS 零匹配**（B-F6）：真实文案 "This extension ctx is stale after session replacement..." 与 patterns 无一匹配，且 isStaleContextError 无生产调用方（双重废）。
- **6 条碰巧无害的注释失实**（B 报告 §2 末）：permission theme / unified-hooks ctx.ui / pending-notifications EventBus / session-reader data.id 死分支 / ask-user cancelled TypeError / session-pending steer 注释。

### 2.5 批次五：core 消费层与守卫缺口

- **core 重放丢工具结果图片**（C#3）：runtime 版 normalize-tool-result 提取 images，core 迁移副本（apply-entry.ts:160-182）不提取 → 图片工具结果「实时可见、重开消失」，破 live≡replay 不变量。
- **user 消息 image part 被忽略**（C#5，低危潜伏）：convertMessageBody 只处理 text/thinking/toolCall——当前 xyz 不发送图片故未炸，手写 session 文件或未来启用即丢。
- **R1 漏流式写形态**（C#9）：check_pi_direct_write.py 枚举无 `createWriteStream`——若未来对 sessionFile 用流式写完全绕过（logger.ts 即此形态写 logs，靠路径豁免通过）。

### 2.6 批次六：流程治本（多数漂移 bug 的共同根因）

- **clone 过时**（C#6，流程级 major）：`~/Code/git-fork/pi-mono-workspace/main` 停在 0.80.3（2026-07-06，落后 origin 723 commits），而 AGENTS.md:25 与 ADR-0063:11 把它标注为「0.84.1 源码」权威查阅源——批次二的 4 条漂移全部源于按旧 clone 断言。
- **未验证风险处置**：A-10（agent_end willRetry 与用户抢发的并发竞争——需探针证实）、A-11（execPath 定位结论来自旧 fork 0.75.5——需对 0.84.1 重验）、F8（SIGINT re-raise 窗口）、jsonl-run-store 首写可见性（已有 state 文件兜底）、pi-ai/compat 上游废弃时间炸弹。

## 3. 解决方案

修复总原则：**xyz 侧行为对齐 pi 实装版（node_modules 0.84.1 dist），不从 clone 断言**；每项修复的 pi 语义锚点进代码注释（I4 范式）；扩展修复按仓库铁律在本地 pi CLI 实测。

### 3.1 批次一方案（W1，两 builder 并行，领地不相交）

**W1a model-switch**：`switchToModel` 改为解析目标 `Model` 对象后调 `await pi.setModel(model)`（返回 boolean，false = 拒绝需报错）。关键调查点（builder 首步）：pi `setModel` 是否自写原生 `model_change` entry（若自写 → 删除 xyz 侧 custom entry 写入；若不自写 → 评估保留 custom entry 供 xyz 侧 UI 消费，但持久化恢复以原生为准——以实装版源码为准定案）。验收锚：本地 pi CLI 真实切换 → `get_state().model` 变为目标 + 重启附着后模型仍为目标。

**W1b provider-repair**：`isInvalidProvider` 判定对齐 `applyModelsJson` 抛错条件（八字段**全空**才算无效，`provider-composer.js:86-93`）；sanitize 只删真空壳。防御性测试：只配 apiKey 的 provider 启动后完好；全空壳仍被清；修复附带「曾被误删的配置无法恢复」说明（已删数据不回滚——out of scope，登记 known-issue 文案于修复注释）。

### 3.2 批次二方案（W2）：值域 SSOT 派生

- thinking：`VALID_THINKING_LEVELS` 与 shared `ThinkingLevel` 改为**从 `PiThinkingLevel`（pi-protocol.ts:403，全集）派生**（`satisfies` / 类型级约束），消除三处手写值域漂移的可能；runtime 校验列表 import 派生值。
- KNOWN_PI_API_TYPES：对齐 pi-ai 0.82.1 `KnownApi` 10 值全集（注释附 types.d.ts:14 锚点 + 同步维护注）。
- system prompt：重提取 0.84.1 版（保留版本标注头与 diff 维护注格式）。
- 包名文案：`@earendil-works/pi-coding-agent` + 指向安装文档。
- 顺手：A-06（`\n` 注释改为「pi 读取 trim 分行，补 \n 为保守对齐」）、A-08（message_start 时序注释更新）、A-12（漂移行号锚点更新）。

### 3.3 批次三方案（W3）：wire 层修复

- tool-call-index：builder 首步用真实 pi 跑一轮含工具调用的对话，抓 message_update 的 `assistantMessageEvent` 实际形态（ToolCall part 的 start/delta/end 事件里 id 与 index 的可得性），据实实现提取；**验收锚 = 真实 pi 事件流中 tool-call-index 事件真实产出**（非 mock——现有 mock 必须改为按真实形态构造，消除「mock 自带 message 字段」的自欺）。若调查证实 assistantMessageEvent 不可得 id（pi 未暴露），则方案降级：删除死机制 + 在协议文件登记 pi 能力缺口（诚实删除优于死代码），此分支需在交付报告中显式选定。
- pi-protocol select options：类型改 `options: string[]`（附 types.d.ts:70 锚点），消费侧（ask-user 等 UI 渲染）适配——label=value 渲染或映射。

### 3.4 批次四方案（W4）：isError 范式收敛

- 9 处 `return {isError:true,...}` 改为 `throw new Error(message)`（pi 采信 throw；错误信息保持原文案）；逐处确认 throw 后的扩展内部状态清理（原 return 路径的收尾逻辑移到 throw 前）。
- goal：STALE_CONTEXT_PATTERNS 对齐真实文案（复用 scheduler 已验证的 `'stale after session replacement'` marker），isStaleContextError 无调用方——调查后要么接线要么删除（禁止留死函数）。
- 6 条注释失实逐条修正；session-reader data.id 死分支删除。

### 3.5 批次五方案（W5）：core 对齐 + 守卫

- core normalizePiToolResult 补 images 提取（对齐 runtime 版行为，分叉注释登记该差异已消除）；convertMessageBody 补 image part 处理（渲染层若无消费，先保数据不丢——entry 转换保 images 字段）。
- R1 补 `createWriteStream` pattern（写目标判定复用现有条件 A/B 框架；logger 等合法用例靠 NON_SESSIONS_DERIVATIONS 豁免——补豁免验证）；C#8 版本标签顺手更新。

### 3.6 批次六方案（W6）：治本

- clone 更新：`git -C ~/Code/git-fork/pi-mono-workspace/main pull --ff-only`（更新后可能领先 0.84.1——属正常）；AGENTS.md 与 ADR-0063 修订查阅规则：**「pi 语义断言的权威源 = node_modules 实装版（npm ls 核对版本），clone 仅作可读 TS 参照且须先核对版本」**。
- A-10 探针：真实 pi 复现 willRetry 窗口与用户抢发的交错（可行则修复 isGenerating 复位时序，不可行则登记观察 + 防御建议）；A-11 探针：0.84.1 binary 下 execPath 定位链重验。
- F8 / jsonl-run-store / pi-ai/compat：登记 docs/troubleshooting.md 观察项（含触发条件与上游链接语义，不修）。

### 3.7 关键决策

- **D1 bash 互斥保留**（A-04）：xyz 侧 bash↔bash 互斥是自设 UX 约束，放开并发属新功能非修复；修拒因文案与「pi 单 slot」注释（pi 实为 Set 支持并发，`agent-session.js:2199`）。
- **D2 已被误删的 provider 数据不追溯恢复**：修复只保证今后不删；追溯需用户手动重配（修复注释说明）。
- **D3 W3 的降级分支显式化**：若 pi wire 层确实拿不到 toolCallId，诚实删除机制优于保留死代码——由 builder 调查后二选一并在报告显式记录。
- **D4 修复顺序**：W1（critical/数据丢失）先行；W2/W3/W4 领地不相交（shared+值域 / runtime wire / extensions）可三并行；W5/W6 收尾。

## 4. 验收

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V1 | 模型切换真实生效 | 本地 pi CLI（`--mode rpc`）+ model-switch 扩展：对话中触发 switch → 查 `get_state().model`；kill pi 重启附着同 session 再查 | 两次均为目标模型；扩展返回真实失败当目标不存在 | G1 |
| V2 | provider 零丢失 | 构造 models.json：一个只配 apiKey 的 provider + 一个真空壳 → 启动 runtime | 前者完好、后者被清；sanitize 日志正确区分 | G2 |
| V3 | thinking max | dev app 选「最高(max)」创建 session | pi 进程 args 含 `--thinking max`（或 `get_state().thinkingLevel === 'max'`） | G3 |
| V4 | tool-call-index 真产出 | 真实 pi 跑一轮含工具调用的对话，抓 runtime 事件流 | tool-call-index 事件真实出现且 toolCallId 与 pi entry 对得上（或降级分支：机制删除 + 缺口登记，测试同步） | G4 |
| V5 | 扩展错误被采信 | 本地 pi CLI 触发 session-reader 读不存在文件（等构造错误路径） | pi tool_execution_end 带 isError / turn 记录错误；unified-hooks 审计可见 | G5 |
| V6 | 图片不丢 | 构造含 images 的 toolResult entry session → 实时与重开对比 | 重开后图片仍在（live≡replay） | G5 |
| V7 | 全量回归 | runtime/core/renderer 三包全量 + `extensions:typecheck && extensions:lint && extensions:test` + R1 + taste-lint | 全绿；R1 含 createWriteStream 后 exit 0 且豁免闭环 | G6 |

Final gate：真实 dev app 抽查 V1/V3/V4 的端到端形态（扩展经 builtin 打包链生效）。

## 5. 下一层拆分（cw-orchestrator）

| wave | 内容 | 领地 | 依赖 |
|------|------|------|------|
| W1a | model-switch setModel 真切 + 本地 pi CLI 实测 | extensions/model-switch | 无（先行） |
| W1b | provider-repair 八字段对齐 + 防误删测试 | runtime infra/pi（provider 域） | 无（与 W1a 并行） |
| W2 | thinking SSOT 派生 + KnownApi 全集 + system prompt + 包名 + 值域类注释 | shared + runtime（session-lifecycle/process-manager 值域行） | 无（与 W3/W4 并行；不碰 event-adapter/pi-protocol） |
| W3 | tool-call-index 修复（含真实事件形态调查 + 降级分支）+ pi-protocol select 类型 | runtime infra/pi（event-adapter/pi-protocol） + ask-user 消费适配 | 无（与 W2/W4 并行） |
| W4 | isError throw 范式 9 处 + goal stale 对齐 + 6 注释 | extensions/（5 包，除 model-switch） | 无（与 W2/W3 并行；不碰 model-switch=W1a 领地） |
| W5 | core images 双修 + R1 createWriteStream + 版本标签 | packages/core + .githooks | W2 后（pi-protocol 不冲突即可，实际无依赖可提前） |
| W6 | clone 更新 + AGENTS/ADR 规则 + A-10/A-11 探针 + 观察项登记 | 仓外 clone + 根文档 + troubleshooting | W1-W5 落定后收尾 |
| gate | V1-V7 + dev app 端到端 | — | 全 wave 后 |

实施纪律沿用本仓惯例：验收基线先行防篡改、builder/verifier 三方制衡、主 agent 唯一 commit 出口、pi 断言一律带实装版锚点、扩展改动本地 pi CLI 实测。

---

## 附：裁决记录

- 2026-08-20 计划立项（用户指示「全部都要修复」）。排查报告 a/b/c 为证据 SSOT（commit f2258401f）。out of scope：bash 并发放开（D1）、已删 provider 数据追溯（D2）、F8/compat 上游风险（登记观察）。
