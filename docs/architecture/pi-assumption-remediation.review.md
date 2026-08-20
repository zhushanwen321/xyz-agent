# pi-assumption-remediation 对抗式审查报告

> **审查日期**：2026-08-20
> **审查对象**：`docs/architecture/pi-assumption-remediation.md`（commit a3a15ef79，146 行）
> **审查依据**：rubric-design-doc.md（P0/P1 清单）+ design-principles.md + anti-patterns.md
> **审查基调**：对抗式——假设方案有问题，逐项找证据反驳，反驳不了才放行
> **特别主攻**：覆盖完备性（遗留检查）——三份审计报告全部 finding 逐条对照计划

---

## Summary

0 must-fix, 3 suggestions.

核心结论：计划结构完整、五段骨架齐全、关键事实经 node_modules 0.84.1 dist 核实全部成立、验收场景真实可执行、三份审计报告 34 条 finding 全部被计划处置（32 条有对应 wave + 4 条显式 out-of-scope with justification）。跨文档一致性检查（R1 机制兼容性）无实质矛盾。方案对抗层面，wave 领地不相交声明基本成立，W3/W4 在 ask-user 包有轻微交叠但不阻塞。修订说明：初版报告误判 F5（pending-notifications EventBus）未被计划处置，经主 agent 挑战核实 §2.4 第 53 行枚举第三项即为 F5，两条 MUST_FIX 撤回。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| ~~MUST_FIX~~ | ~~§2.4 / §3.4~~ | ~~P0-12 遗漏~~ | **挑战成立-撤回**：§2.4 第 53 行枚举「permission theme / unified-hooks ctx.ui / **pending-notifications EventBus** / session-reader data.id / ask-user cancelled TypeError / session-pending steer」恰好 6 条，F5 是第三项。§3.4 W4「6 条注释失实逐条修正」通过 §2.4 枚举明确覆盖 F5。初版报告漏抄第三项后误判为遗漏 | — |
| SUGGESTION | §3.3 W3 | P1-5 MECE | W3 降级分支的判定标准是「builder 调查后二选一并在报告显式记录」——设计层可接受，但未给出可测试的判定条件（如「assistantMessageEvent 内 ToolCall part 的 id 字段在 message_update 事件中是否存在」），实施者需自行设计探针 | 补一句可执行的判定探针描述：「builder 用真实 pi 跑一轮含工具调用的对话，抓 message_update 的 assistantMessageEvent JSON，检查 ToolCall part 是否含 id 字段」 |
| SUGGESTION | §3.4 W4 | P1-5 MECE | W4 要求「逐处确认 throw 后的扩展内部状态清理（原 return 路径的收尾逻辑移到 throw 前）」但未给出 9 处各自的收尾逻辑清单或检查标准。实施者需逐处分析，有遗漏风险 | 对 9 处中的高风险项（如 subagent-workflow tool-workflow.ts:442,501 的 workflow 状态清理）补具体收尾要求 |
| SUGGESTION | §4 V6 | P1-8 事实 | V6（图片不丢）的验证步骤是「构造含 images 的 toolResult entry session → 实时与重开对比」——「构造」一词接近 mock 语义。建议改为「用真实 pi CLI 跑一个返回图片的工具（如 read 截图文件），对比实时流与重开后图片是否仍在」 | 将「构造」改为具体的真实操作步骤 |

---

## 覆盖矩阵（三份审计报告全部 finding 逐条对照）

### 报告 A：runtime/infra 领地（12 条 finding）

| 编号 | 严重度 | 一行描述 | 计划处置 |
|------|--------|---------|---------|
| A-01 | major | tool-call-index 机制死代码（toJsonEvent 剥离 message 字段） | **W3**（§3.3 tool-call-index 修复，含真实事件形态调查 + 降级分支 D3） |
| A-02 | major | isInvalidProvider 五字段判定过时（0.84.1 放宽为八字段），启动误删合法 provider | **W1b**（§3.1 八字段对齐 + 防误删测试） |
| A-03 | minor-major | VALID_THINKING_LEVELS 缺 max | **W2**（§3.2 thinking SSOT 派生） |
| A-04 | 错误-碰巧无害 | bash 并发假设不成立（pi 支持并发，xyz 自设互斥） | **D1 显式 out-of-scope**（保留 UX 约束，仅修文案与注释） |
| A-05 | 已致废代码 | pi-protocol select options 类型声明为 {label,value}（实为 string[]） | **W3**（§3.3 pi-protocol select 类型修复） |
| A-06 | 碰巧无害 | _persist \n 注释描述失准 | **W2**（§3.2 顺手 A-06） |
| A-07 | 过时-版本漂移 | spawn 失败提示指向旧 npm 包名 | **W2**（§3.2 包名文案） |
| A-08 | 过时-版本漂移 | message_start 时序注释失准 | **W2**（§3.2 顺手 A-08） |
| A-09 | 过时-版本漂移 | KNOWN_PI_API_TYPES 只有 3/10 | **W2**（§3.2 KNOWN_PI_API_TYPES 全集） |
| A-10 | 未验证-风险 | agent_end willRetry 并发竞争 | **W6**（§3.6 A-10 探针） |
| A-11 | 未验证-风险 | execPath 定位结论来自旧 fork | **W6**（§3.6 A-11 探针） |
| A-12 | 过时-版本漂移 | event-adapter 注释行号锚点漂移 | **W2**（§3.2 顺手 A-12） |

**覆盖判定**：12/12 全部已处置（11 条有对应 wave + 1 条显式 out-of-scope with justification）。

### 报告 B：extensions 领地（13 条 finding）

| 编号 | 严重度 | 一行描述 | 计划处置 |
|------|--------|---------|---------|
| B-F1 | critical | model-switch switchToModel 无 pi.setModel 调用，切换从未生效 | **W1a**（§3.1 setModel 真切） |
| B-F2 | major | 跨 5 包 execute 返回 {isError:true} 不被 pi 采信（只认 throw） | **W4**（§3.4 isError throw 范式 9 处） |
| B-F3 | 碰巧无害 | permission：ExtensionUIContext 无 theme 字段为假 | **W4**（§3.4 6 条注释失实——permission theme 在枚举中） |
| B-F4 | 碰巧无害 | unified-hooks：headless 下 ctx.ui 可能 undefined 为假 | **W4**（§3.4 6 条注释失实——unified-hooks ctx.ui 在枚举中） |
| B-F5 | 碰巧无害 | pending-notifications：EventBus 单例/reload 累积 rationale 为假 | **W4**（§3.4 6 条注释失实——§2.4 第 53 行枚举第三项「pending-notifications EventBus」明确覆盖） |
| B-F6 | 已致废代码 | goal STALE_CONTEXT_PATTERNS 零匹配 + isStaleContextError 无调用方 | **W4**（§3.4 goal stale 对齐） |
| B-F7 | 碰巧无害 | session-reader parser：custom entry id 在 data.id 描述失实 | **W4**（§3.4 session-reader data.id 死分支删除） |
| B-F8 | 未验证-风险 | subagent-workflow：pi SIGINT listener 在 suspend 窗口存在 | **显式 out-of-scope**（§1：「F8 SIGINT 窗口——超本计划能力，登记观察」） |
| B-F9 | 碰巧无害 | ask-user：result.cancelled 对 undefined 抛 TypeError | **W4**（§3.4 6 条注释失实——ask-user cancelled TypeError 在枚举中） |
| B-U1 | 未验证-风险 | llm-shared：compat 模块标注为临时，上游删除时炸 | **显式 out-of-scope**（§1：「pi-ai/compat 上游废弃——超本计划能力，登记观察」） |
| B-U2 | 正确但标签过时 | subagent-workflow types.ts 行号锚点绑定 0.84.0（实装 0.84.2） | **W2**（§3.2 顺手——行号锚点更新类） |
| B-U3 | 碰巧无害 | session-pending：triggerTurn steer 机制描述失实（不经 EventBus） | **W4**（§3.4 6 条注释失实——session-pending steer 在枚举中） |
| B-F10 | 未验证-风险 | jsonl-run-store：首写立即可见在首 assistant flush 前不成立 | **显式 out-of-scope**（§2.6：「登记观察」；已有 state 文件兜底） |

**覆盖判定**：13/13 全部已处置（10 条有对应 wave + 3 条显式 out-of-scope with justification）。

### 报告 C：core/electron/跨层领地（9 条 finding）

| 编号 | 严重度 | 一行描述 | 计划处置 |
|------|--------|---------|---------|
| C#1 | major | thinking level max 被静默丢弃（与 A-03 同源） | **W2**（§3.2，与 A-03 合并处置） |
| C#2 | minor | KNOWN_PI_API_TYPES 枚举严重不全（与 A-09 同源） | **W2**（§3.2，与 A-09 合并处置） |
| C#3 | minor | core normalizePiToolResult 不提取 images | **W5**（§3.5 core images 修复） |
| C#4 | minor | spawn 失败恢复指引指向旧包名（与 A-07 同源） | **W2**（§3.2，与 A-07 合并处置） |
| C#5 | 未验证-风险 | convertMessageBody 忽略 user 消息 image part | **W5**（§3.5 convertMessageBody 补 image part） |
| C#6 | major-流程 | 本地 pi-mono clone 严重过时（0.80.3 vs 0.84.1） | **W6**（§3.6 clone 更新 + AGENTS/ADR 规则） |
| C#7 | minor | DEFAULT_PI_SYSTEM_PROMPT 过时一行 | **W2**（§3.2 system prompt 重提取） |
| C#8 | info | extensions 侧锚点版本标签过时 | **W5**（§3.5 版本标签更新） |
| C#9 | 未验证-风险 | R1 检查器缺 createWriteStream 流式写形态 | **W5**（§3.5 R1 补 createWriteStream pattern） |

**覆盖判定**：9/9 全部已处置。

### 汇总

| 报告 | finding 总数 | 已覆盖 | 显式 out-of-scope | 未覆盖-遗留 |
|------|-------------|--------|-------------------|------------|
| A（runtime/infra） | 12 | 11 | 1（A-04） | 0 |
| B（extensions） | 13 | 13 | 3（F8/U1/F10） | 0 |
| C（core/electron/跨层） | 9 | 9 | 0 | 0 |
| **合计** | **34** | **34** | **4** | **0** |

out-of-scope 声明与审计报告原文严重度/建议一致性检查：
- A-04（bash 并发）：报告建议「仅记录/改注释」，计划 D1 保留互斥仅修文案——**一致**
- F8（SIGINT 窗口）：报告建议「re-raise 前检查 listenerCount」，计划登记观察——**降级合理**（报告本身标「未验证-风险，窗口极窄」）
- U1（compat 上游）：报告标「过时-版本漂移风险」，计划登记观察——**一致**
- F10（jsonl-run-store 首写）：报告标「未验证-风险，低」+ 已有 state 文件兜底，计划登记观察——**一致**

---

## 事实核实清单（P0-11 关键事实）

以下断言全部以 node_modules 0.84.1 dist 为权威源核实（禁止用 pi-mono clone）：

| # | 计划断言 | 核实锚点 | 判定 |
|---|---------|---------|------|
| 1 | `extensions/types.d.ts:954` setModel 签名 `setModel(model: Model<any>): Promise<boolean>` | node_modules dist types.d.ts:953-954 | **成立** |
| 2 | `provider-composer.js:86-93` 八字段任一存在即合法（apiKey/oauth/authHeader 新增） | node_modules dist provider-composer.js:86-93（8 行 if 条件，含 apiKey/oauth/authHeader===undefined） | **成立** |
| 3 | `cli/args.js:6` VALID_THINKING_LEVELS 含 max | node_modules dist cli/args.js:5 `["off","minimal","low","medium","high","xhigh","max"]` | **成立**（行号偏 1 行：计划写 :6，实为 :5——不影响决策，P1-8） |
| 4 | `modes/json-event.js:3-15` toJsonEvent 对 message_update 只输出 `{type, assistantMessageEvent}` | node_modules dist json-event.js:0-10（11 行全文，剥离 partial 后返回两字段对象） | **成立**（行号偏移：计划写 :3-15，实际文件 11 行——不影响决策，P1-8） |
| 5 | `agent-loop.js:453-483` 正常 return 恒 isError:false，只认 throw | node_modules pi-agent-core dist agent-loop.js:453-483（try 成功 return `{result, isError: false}`；catch return `{result: createErrorToolResult, isError: true}`） | **成立** |
| 6 | pi-ai 0.82.1 KnownApi 10 值 | node_modules pi-ai dist/types.d.ts:14（10 个 union 成员，含 mistral-conversations/azure-openai-responses/openai-codex-responses/bedrock-converse-stream/google-generative-ai/google-vertex/pi-messages） | **成立** |
| 7 | `extensions/types.d.ts:70` select options 为 `string[]` | node_modules dist types.d.ts:70 `select(title: string, options: string[], opts?)` | **成立** |
| 8 | `agent-session.js:2199` bash 并发 Set（`_bashAbortControllers.add`） | node_modules dist agent-session.js:2199-2201（`new AbortController()` + `this._bashAbortControllers.add(abortController)`） | **成立** |
| 9 | runtime VALID_THINKING_LEVELS 缺 max（session-lifecycle.ts:123） | git show HEAD session-lifecycle.ts:124 `['off','minimal','low','medium','high','xhigh']`（6 值，无 max） | **成立** |
| 10 | shared ThinkingLevel 类型缺 max（pi-preset.ts:27） | git show HEAD pi-preset.ts:27 `'off' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'`（6 值） | **成立** |
| 11 | model-switch 无 pi.setModel 调用 | git show HEAD model-switch index.ts：grep setModel 零命中；switchToModel 用 `pi.appendEntry("model_change", ...)` | **成立** |
| 12 | core apply-entry.ts:160-182 不提取 images | git show HEAD apply-entry.ts:160-182：normalizePiToolResult 只提取 text content，无 images 分支 | **成立** |
| 13 | pi-protocol.ts:403 PiThinkingLevel 含 max（SSOT 已存在） | git show HEAD pi-protocol.ts:403 `'off' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`（7 值） | **成立** |
| 14 | isInvalidProvider 只检查 5 字段（缺 apiKey/oauth/authHeader） | git show HEAD pi-provider-repair.ts:44-48：return 条件只有 baseUrl/headers/compat/modelOverrides/models | **成立** |
| 15 | KNOWN_PI_API_TYPES 只有 3 个（shared/constants.ts:53-57） | git show HEAD constants.ts:55-57：`'anthropic-messages','openai-completions','openai-responses'` | **成立** |

**结论**：15/15 事实断言全部成立。两处行号微偏（cli/args.js :5 vs :6、json-event.js 行范围）属 P1-8 不影响决策。

---

## 方案对抗审查（P0-7/8/9/10）

### P0-7/8/9 方案对比

计划是修复方案（非新建功能），只有一个方案（对齐 pi 实装版行为 + 治本）。这是合理的——修复方案的 alternative 是「不修」或「换一种修法」，计划在 D1-D4 中对关键决策点给出了 alternatives（如 D3 session_end 维持 sidecar vs 改 appendEntry、D1 bash 互斥保留 vs 放开），每条有理由。**判定：通过**（修复类文档的方案对比形式可接受）。

### P0-10 方案是否真正解决目标问题

回溯因果链：
- G1（模型切换生效）→ W1a 调 pi.setModel → 根因（无 setModel 调用）消除 → **通过**
- G2（provider 零丢失）→ W1b 对齐八字段判定 → 根因（五字段过时判定）消除 → **通过**
- G3（thinking max 可用）→ W2 从 PiThinkingLevel 派生 → 根因（手写值域漂移）消除 + SSOT 派生防复发 → **通过**
- G4（tool-call-index 真产出）→ W3 真实事件形态调查 + 降级分支 → 根因（wire 层字段不可得）正视 → **通过**（含诚实删除分支）
- G5（扩展错误被采信）→ W4 throw 范式 → 根因（pi 只认 throw）对齐 → **通过**
- G6（同类问题不再来）→ W6 clone 更新 + 断言规则 + R1 补缺口 → 根因（旧 clone + 无验证规则）消除 → **通过**

### Wave 领地不相交/并行声明核实

| wave 对 | 声明 | 实际文件交叠 | 判定 |
|---------|------|-------------|------|
| W1a / W1b | 并行，领地不相交 | W1a: extensions/model-switch；W1b: runtime infra/pi provider 域 | **无交叠，成立** |
| W2 / W3 | 并行，不碰 event-adapter/pi-protocol | W2: shared + runtime session-lifecycle/process-manager 值域行；W3: runtime event-adapter/pi-protocol | **无交叠，成立** |
| W2 / W4 | 并行 | W2: shared + runtime；W4: extensions/（5 包） | **无交叠，成立** |
| W3 / W4 | 并行 | W3: runtime event-adapter/pi-protocol + ask-user 消费适配；W4: extensions/（含 ask-user isError 改造） | **轻微交叠**：两者都改 ask-user 包，但 W3 改 select UI 渲染（label=value 映射），W4 改 execute throw 范式。不同文件/不同函数，不阻塞并行，但 merge 时需注意 |
| W5 / W2 | W5 依赖 W2 | W5: core + .githooks；W2: shared + runtime | **无交叠，依赖声明合理**（pi-protocol 不冲突） |

### W1a 关键调查点可判定性

W1a 要求 builder 调查「pi setModel 是否自写原生 model_change entry」。可判定：builder 用真实 pi CLI 调 setModel → 检查 session JSONL 尾部是否有 `type:"model_change"` entry（区别于 `type:"custom", customType:"model_change"`）。两分支处置清晰：若自写 → 删除 xyz 侧 custom entry；若不自写 → 评估保留。**可执行，通过**。

---

## 验收真实性审查（P0-13/14/15）

### P0-13 验收章节存在且 testable

§4 存在，7 个场景（V1-V7）+ Final gate。每个场景有明确步骤与通过标准。**通过**。

### P0-14 验收是否真实场景（非单测/mock）

| 场景 | 真实依赖 | 判定 |
|------|---------|------|
| V1 | 本地 pi CLI（`--mode rpc`）+ model-switch 扩展 + get_state() | **真实** |
| V2 | 真实 models.json + runtime 启动 | **真实** |
| V3 | dev app 选 thinking max + pi 进程 args | **真实** |
| V4 | 真实 pi 跑含工具调用对话 + 抓 runtime 事件流 | **真实** |
| V5 | 本地 pi CLI + session-reader 触发错误路径 | **真实** |
| V6 | 含 images 的 toolResult entry session | **偏构造**（见 SUGGESTION） |
| V7 | runtime/core/renderer 全量 + extensions 三连 + R1 + taste-lint | **真实** |

Final gate：真实 dev app 抽查 V1/V3/V4 端到端（扩展经 builtin 打包链生效）。**通过**。

### P0-15 验收投入与改动大小匹配

6 个 wave + 1 个 gate，涉及 critical bug 修复（模型切换）、数据丢失修复（provider）、跨 5 包范式收敛（isError）、wire 层机制调查（tool-call-index）、SSOT 派生、治本流程。V1-V7 覆盖 G1-G6 全部 6 个目标，Final gate 补端到端。**投入充分，通过**。

### 目标-场景回溯检查

| 目标 | 对应场景 | 判定 |
|------|---------|------|
| G1 模型切换 | V1 | 有 |
| G2 provider 零丢失 | V2 | 有 |
| G3 thinking max | V3 | 有 |
| G4 tool-call-index | V4（含降级分支） | 有 |
| G5 扩展错误被采信 | V5 | 有 |
| G5 图片不丢 | V6 | 有 |
| G6 同类问题不再来 | V7 + Final gate | 有 |

无目标无对应场景、无场景无对应目标。**通过**。

---

## 跨文档一致性检查：R1 机制兼容性

**检查对象**：计划 W5「R1 补 createWriteStream pattern」与 `data-source-governance.md` §3.6 R1 机制（条件 A/B 两必要条件框架）。

**兼容性分析**：

1. **条件 A/B 框架是否仍成立**：成立。补 createWriteStream 只是在 WRITE_CALL_PATTERNS 列表新增一个 pattern（与 openSync/appendFile/writeFile/atomicWrite 并列），条件 A（文件级 sessions 痕迹）和条件 B（写目标豁免）的框架完全不受影响。新 pattern 的命中/豁免逻辑与现有 pattern 一致。

2. **logger.ts 用例靠路径豁免通过的说法**：**实质无矛盾但表述需澄清**。logger.ts（`packages/runtime/src/infra/logger.ts`）用 createWriteStream 写 `<getDataDir>/logs/` 目录（文件头注释 :11 明确 `WriteStream 缓冲写`；:36 import createWriteStream）。按 R1 条件 A 检查：logger.ts 唯一的 sessions token 在 :426 注释中（`与 ~/.xyz-agent-dev/pi/sessions/`），**代码语境无 sessions 痕迹**（注释不计入，R1 docstring 明确）。因此 createWriteStream 加入 WRITE_CALL_PATTERNS 后，logger.ts **连条件 A 都不命中**，根本不需要走到条件 B 豁免。计划说「logger.ts 靠路径豁免通过」在结果上正确（不被拦），但机制描述不精确——不是「靠豁免通过」而是「不命中候选」。这不影响方案正确性，但若实施者按「需要豁免」理解可能误加 allowlist 条目。**建议**：W5 实施时明确 logger.ts 不命中条件 A（注释不计入），无需额外豁免处理。

3. **R1 的 NON_SESSIONS_DERIVATIONS 豁免通道**：data-source-governance §3.6 条件 B② 定义了「非 sessions 目标」豁免（写目标经 tmpdir() 或 NON_SESSIONS_DERIVATIONS 枚举的目录推导函数）。logger.ts 写 logs 目录，若未来有代码语境 sessions 痕迹的文件用 createWriteStream 写非 sessions 目标，该豁免通道可覆盖。**通道完整，无矛盾**。

**结论**：跨文档无实质矛盾。W5 补 createWriteStream 与 R1 框架完全兼容。

---

## rubric 逐项判定（P0/P1 清单）

### P0 致命

| # | 检查项 | 判定 | 依据 |
|---|--------|------|------|
| P0-1 | 五段骨架 | **通过** | 背景目标(§1) / 现状问题(§2) / 解决方案(§3) / 验收(§4) / 下一层拆分(§5) 五段齐全 |
| P0-2 | delta 链引用 | **通过** | 正文无「vN」「Rxx-finding」「参见上版」；证据引用为审计报告编号（A-01/B-F1 等）非 delta 链 |
| P0-3 | 结论不先行 | **通过** | 标题下有一句话结论（:3）；SCQA 开篇（:9-14）；§2-§5 各有结论句 |
| P0-4 | 问题定义错误 | **通过** | §1 定义的问题是「pi 行为错误假设导致功能失效/数据丢失」，根因识别为「clone 过时 + 无验证规则」（§2.6），非表面现象 |
| P0-5 | 重实现轻体验 | **通过** | §1 有使用者可见行为表（G1-G6 每条配用户视角描述） |
| P0-6 | 抽象术语无定义 | **通过** | 关键术语（SSOT / I4 范式 / wave）首次出现有上下文定义 |
| P0-7 | 无方案对比 | **通过**（修复类文档） | D1-D4 关键决策点有 alternatives（D3 sidecar vs appendEntry、D1 bash 保留 vs 放开） |
| P0-8 | 对比缺评估 | **通过** | D1/D3 各有长期/短期/风险三栏评估 |
| P0-9 | 无明确推荐 | **通过** | 每个 D 有明确选择 + 理由 |
| P0-10 | 方案解决目标问题 | **通过** | 因果链回溯 G1-G6 全部打到根因（见上文） |
| P0-11 | 关键事实错误 | **通过** | 15 项事实断言全部经 node_modules 0.84.1 dist 核实成立（见事实核实清单） |
| P0-12 | 副作用/遗漏 | **通过** | 三份审计报告 34 条 finding 全部被计划处置（32 条对应 wave + 4 条显式 out-of-scope with justification，其中 A-04 与 F8/U1/F10 各有独立理由）。§2.4 第 53 行枚举恰好 6 条含 F5，初版报告漏抄后误判已撤回 |
| P0-13 | 无验收/不可测试 | **通过** | §4 有 7 个 testable 场景 + Final gate |
| P0-14 | 验收=单测/mock | **通过** | V1-V5/V7 全部真实 pi CLI / 真实事件流 / 真实环境；V6 略偏构造（SUGGESTION） |
| P0-15 | 验收投入不匹配 | **通过** | 6 目标 × 7 场景 + Final gate，投入充分 |
| P0-16 | 运行时断言无探针 | **通过** | 计划中运行时行为断言（如 pi setModel 行为、toJsonEvent 剥离）均有实测锚点（审计报告一手证据）或计划中 builder 首步探针 |
| P0-17 | 数据流没画物理图 | **不适用** | 修复计划不新建数据流，引用审计报告已有锚点 |
| P0-18 | 错误无恢复指引 | **通过** | D2（已删数据不追溯——恢复指引在修复注释）、W1b（sanitize 日志正确区分）、W3（降级分支显式化） |

### P1 建议

| # | 检查项 | 判定 | 依据 |
|---|--------|------|------|
| P1-1 | 关键概念无例子 | **通过** | G1-G6 每条有使用者可见行为描述 |
| P1-2 | 拆分 justification 弱 | **SUGGESTION** | §5 wave 拆分表的 justification 列存在但部分偏简略（如 W5「core images 双修 + R1 + 版本标签」缺 why 这么组合的理由） |
| P1-3 | 受众背景不足 | **通过** | 计划假设读者已知审计报告背景，对 pi/xyz 耦合有基本了解——与实际读者（本项目开发者）匹配 |
| P1-4 | 决策无 alternatives | **通过** | D1-D4 每条有 alternatives |
| P1-5 | 章节未 MECE | **SUGGESTION** | W3 降级分支 / W4 throw 收尾逻辑的判定标准可更可测试 |
| P1-6 | 加机制而非减法 | **通过** | 计划是修现有机制（对齐 + 删除死代码），非加新机制；W6 治本是减法（消除旧 clone 误导） |
| P1-7 | scope 越层 | **通过** | 当前层 = 技术方案设计，下一层 = wave 拆分（§5），未跨 2 层 |
| P1-8 | 细节事实错误 | **SUGGESTION** | cli/args.js 行号 :6 vs :5、json-event.js 行范围 :3-15 vs 实际 11 行——不影响决策 |

---

## 审查输出

```json
{"report_file": "/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/docs/architecture/pi-assumption-remediation.review.md", "must_fix": 0, "suggestion": 3}
```
