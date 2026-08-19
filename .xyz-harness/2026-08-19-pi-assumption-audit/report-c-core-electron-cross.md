# 报告 C：core 消费层 + Electron 主进程 + 全仓横切面 pi 假设审计

> 由排查 agent C 产出（agent 因自身写入约束未能直接落盘，主 agent 代为原样落盘，内容未改动）。
> 权威源：node_modules `@earendil-works/pi-coding-agent@0.84.1` dist（+ pi-agent-core 0.84.2 / pi-ai 0.82.1）；clone TS 源仅作版本比对。

## 1. 总结论

| 分类 | 计数 |
|---|---|
| 错误-已致废代码 | 0 |
| 错误-潜在 bug | 3（#1 major、#3 minor、#4 minor） |
| 错误-碰巧无害 | 0 |
| 未验证-风险 | 2（#5、#9） |
| 正确-已锚定 | 21（见 §4） |
| 过时-版本漂移 | 4（#2、#6、#7、#8） |

最重要的 3 条：
1. **#1 thinking level 'max' 被静默丢弃**（major）：pi 0.84.1 支持 `max`，composer UI 提供且默认最高档 `max`，但 runtime spawn 前校验白名单缺 `max` → 用户选最高档创建 session 时 `--thinking` 静默丢失。根因是 #6 的版本漂移。
2. **#6 本地 pi-mono clone 严重过时**（流程级 major）：AGENTS.md 与 ADR-0063 指定的权威查阅源 `~/Code/git-fork/pi-mono-workspace/main` 实际停留在 0.80.3（2026-07-06，落后 origin 723 commits），而运行时是 0.84.1。#1、#2、#7 三条漂移全部源于「按旧 clone 断言新版行为」。
3. **#3 core 侧 normalizePiToolResult 丢 images**（minor）：runtime 版提取 tool-result 图片，core 迁移副本不提取 → 带 image content 的工具结果「实时可见、重开丢失」，破 W20 的 live ≡ replay 不变量。

## 2. 发现明细

### 错误-潜在 bug

**#1 [major] thinking level 'max' 在 session 创建链路被丢弃**
- 位置：`packages/runtime/src/services/session/session-lifecycle.ts:123`（`VALID_THINKING_LEVELS` 缺 `max`）、`:216-222`（非法值 warn 后 ignore，spawn 不带 `--thinking`）；`packages/shared/src/pi-preset.ts:27`（`ThinkingLevel` 类型同样缺 `max`）
- 冲突方：`packages/core/src/domain/composer/thinking-levels.ts:16,34,126` —— UI 档位表含 `max` 且全可用时默认/兜底就是 `max`
- pi 实际（0.84.1 锚点）：`node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:6` `VALID_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`；clone 0.80.3 `cli/args.ts:57` 无 `max`（漂移源头）
- 触发条件：Landing Thinking Chip / Staging override 选「最高(max)」→ runtime 校验不过 → 静默降级为模型默认档
- 建议：三处值域统一到单一 SSOT（pi-protocol.ts:403 的 `PiThinkingLevel` 已是全集，含 max），校验列表从它派生

**#3 [minor] core `normalizePiToolResult` 不提取 images，与 runtime 版行为分叉**
- 位置：`packages/core/src/domain/chat/apply-entry.ts:160-182`（迁移副本，无 images 分支）
- pi 实际：toolResult content 是 `(TextContent | ImageContent)[]`（pi-ai types.d.ts:293-296）；runtime 版 `packages/runtime/src/infra/pi/normalize-tool-result.ts:24,48,65,78` 提取 `images` 且 event-adapter.ts:191 实时路径消费
- 影响：extension 工具返回 image block 的 session，实时流显示图片、关闭重开（reducer `computeToolCallFill` 路径）图片消失——文件头承认两份分叉存在，但未记录 images 这一实质行为差异
- 建议：core 版补 images 提取（或消费侧显式声明降级），并在分叉注释中登记该差异

**#4 [minor] pi spawn 失败的恢复指引指向不存在的包名**（领地备注：process-manager 属 agent A，登记防丢）
- 位置：`packages/runtime/src/infra/pi/process-manager.ts:228` —— `npm i -g @mariozechner/pi-coding-agent`
- 事实：实际依赖是 `@earendil-works/pi-coding-agent`（root package.json:32、AGENTS.md:25）。旧 scope 已迁移，按提示安装会失败或装到旧版
- 建议：改错误文案并指向真实包名/文档

### 未验证-风险

**#5 [低] apply-entry `convertMessageBody` 忽略 user 消息的 image content part**
- 位置：`packages/core/src/domain/chat/apply-entry.ts:270-299`（parts 循环只处理 text/thinking/toolCall/tool_use）
- pi 实际：`UserMessage.content` 可为 `(TextContent | ImageContent)[]`（pi-ai types.d.ts:274-278）
- 现状：xyz 发送路径刻意不走 base64 images 通道（shared/segments.ts:37），rpc-client.ts:493-497 的 images 通道保留但 UI 不用 → 当前潜伏；一旦启用（或外部手写 session 文件含图），重放丢图且无 warn。待证实：是否有 extension 经 `sendUserMessage` 带 images

**#9 [低] check_pi_direct_write.py 写调用形态枚举缺口**
- 位置：`.githooks/check_pi_direct_write.py:97-105`
- 枚举：`openSync('a'/'w')` / `appendFile(Sync)` / `writeFile(Sync)` / `atomicWrite(Async)`。缺口：`fs.createWriteStream`（流式写，logger.ts 即此形态写 logs；若未来对 sessionFile 用则完全绕过）、别名 import（`import { writeFileSync as w }`）、`truncate`+重建
- 定性：防回归守卫而非安全边界，docstring 已诚实声明 fd 型与跨文件数据流盲区；`createWriteStream` 是未声明的最大缺口。建议补 pattern 或在「检出边界」声明

### 过时-版本漂移

**#6 [major-流程] 本地 pi-mono clone 落后安装版约 4 个 minor 版本**
- 事实：`~/Code/git-fork/pi-mono-workspace/main` HEAD `647c5554b`（2026-07-06，package version 0.80.3）；origin 领先 723 commits（FETCH_HEAD `e47b8e37a`，2026-08-07）；node_modules 实装 `pi-coding-agent 0.84.1` + `pi-agent-core 0.84.2` + `pi-ai 0.82.1`
- 影响：AGENTS.md:25 与 `docs/adr/0063-session-attachment-invariants.md:11`（「锚点均为 pi-mono 0.84.1 源码，本地 ~/Code/git-fork/...」）把该 clone 当当前版权威源——版本归属标注失真。抽验 ADR-0063 关键锚点（setSessionFile 永久字段 dist session-manager.js:611-612、`_persist` appendFileSync 按路径 :724-751）在 0.84.1 dist 仍成立，结论未失效；但 #1/#2/#7 证明「按 clone 断言」已实际产生漂移 bug
- 建议：更新 clone（git pull）或在 AGENTS.md 标注 clone 实际版本并要求断言前 `npm ls` 核对

**#2 [minor] `KNOWN_PI_API_TYPES` 枚举严重不全**
- 位置：`packages/shared/src/constants.ts:53-57`（3 个值）
- pi 实际：pi-ai 0.82.1 `KnownApi` 10 个（types.d.ts:14）——缺 `mistral-conversations` / `azure-openai-responses` / `openai-codex-responses` / `bedrock-converse-stream` / `google-generative-ai` / `google-vertex` / `pi-messages`
- 影响：用户 models.json 用上述 api 时 runtime 误报 warn（pi-config-store.ts:108-110，warn 不阻断、原样透传，功能无碍）；前端 Select 也无法选这些类型。建议从 pi-ai 类型或文档同步全集

**#7 [minor] DEFAULT_PI_SYSTEM_PROMPT 过时一行**
- 位置：`packages/shared/src/pi-default-prompt.ts`（提取自 0.80.3，自带版本标注与「升级后 diff」维护注）
- 差异：0.84.1 文档路由行新增 `environment variables (docs/environment-variables.md)`（dist/core/system-prompt.js:81 vs clone system-prompt.ts 无）。仅 Settings 参考展示用途，guidelines/tools 段逐字比对无其他差异

**#8 [info] extensions 侧锚点版本标签过时**（extensions/ 归 agent B，版本漂移专项记录）
- 位置：`extensions/subagent-workflow/src/execution/types.ts:418-424` 锚定 `pi-agent-core 0.84.0 dist/agent-loop.js:106-113`；实装 0.84.2。复核 error/aborted 路径 turn_end→agent_end 时序在 0.84.2 仍成立（agent-loop.js:107-110，行号微移），该文件自带观测哨（logger.warn），行为有效仅标签过时

## 3. 版本漂移专项（抽查结论）

xyz 强依赖的 pi 机制在 clone(0.80.3) vs 实装(0.84.1) 的比对：

| 机制 | clone 0.80.3 | 实装 0.84.1 | 判定 |
|---|---|---|---|
| SessionEntry 9 类型联合 | 相同（session-manager.ts:140） | 相同（session-manager.d.ts:105） | 无漂移 |
| message_end emit 先于 appendMessage | agent-session.ts:545-561 | dist agent-session.js:364-378 | 无漂移（shared/pi-entry.ts:17 引用的行号即 clone 行号） |
| get_entries `since` 增量 | rpc-mode.ts:609-620 | rpc-mode.js:502-513 | 无漂移 |
| queue_update drain 先于 message_start | agent-session.ts:516 | dist :341-351 | 无漂移 |
| VALID_THINKING_LEVELS | 无 `max` | 含 `max` | **漂移，已致 #1** |
| 默认 system prompt | 无 env vars 路由行 | 新增一行 | 漂移，已致 #7 |

版本引用一致性：root package.json / pnpm-lock / build.yml（`PI_VERSION: '0.84.1'`）/ AGENTS.md 均一致为 0.84.1，无冲突引用；docs 与 extensions 中 `0.84.0` 均为历史实测环境记录（可接受）。

## 4. 已核实为正确的假设（简表，均附 0.84.1 一手锚点）

| # | 假设（位置） | 锚点 |
|---|---|---|
| 1 | reducer case 覆盖 = pi SessionEntry 全集（apply-entry.ts:369-594：6 建模 + 3 no-op） | session-manager.d.ts:105（9 类型） |
| 2 | message role 全集 user/assistant/toolResult/bashExecution/custom/compactionSummary/branchSummary | pi-ai types.d.ts:310 + coding-agent messages.d.ts（CustomAgentMessages 4 role） |
| 3 | entry id 恒 uuidv7，`e<N>` 无碰撞（apply-entry.ts:122-124） | session-manager.js:1,13 |
| 4 | message_end 后才 appendMessage 分配 id（pi-entry.ts:14-18） | agent-session.js:364-378 |
| 5 | compaction/branch_summary/custom_message 与 message-role 双形态（apply-entry.ts:378-383） | session-manager.js:166-190 sessionEntryToContextMessages |
| 6 | queue_update(drain) 先于 message_start（registry.ts:145） | agent-session.js:341-351 |
| 7 | `_emitQueueUpdate` 恒数组、元素为 string（registry.ts:560） | agent-session.js:303-307,1017 |
| 8 | pendingMessageCount = steering+followUp 长度（registry.ts:582） | agent-session.js:1151-1153 |
| 9 | custom message 双发 start+end，去双计正确（registry.ts:418） | agent-session.js:1095-1096 + agent-loop.js:96-101 |
| 10 | compaction_end 失败带 `Compaction failed:` errorMessage、aborted 不带（useChat.ts:232） | agent-session.js:1459-1477 |
| 11 | get_commands 返回裸命令名（command-registry.ts:157） | runner.js:416-424（invocationName=name，重名才 `:N`；skill 带 `skill:` 前缀） |
| 12 | rpc stdout 全 JSONL 事件流 | rpc-mode.js:266 + 文件头声明 |
| 13 | runtime 崩溃 → pi 经 stdin 关闭退出（use-connection.ts:273,340） | rpc-mode.js:640-642（stdin end → shutdown） |
| 14 | spawn flags 全集（--mode rpc/--session-dir/--session/--extension/--thinking/--no-skills/--no-context-files/--approve） | dist/cli/args.js:25-183 |
| 15 | BUILTIN_TOOLS 7 个（pi-preset.ts:30） | dist/core/tools/ 目录逐一存在 |
| 16 | pi bash 继承进程 env → PATH 修复链成立（main.ts:77-82） | bash.js:58-61 + utils/shell.js:103-116（spread process.env） |
| 17 | entry_appended 仅 extension appendEntry 发射（event-adapter.ts:835-840） | agent-session.js:1863-1870 |
| 18 | pi 按参数顺序加载 extension → builtin 链序约束成立（extension-service.ts:424-425） | loader.js:432-453 |
| 19 | ADR-0063 核心：switch_session 永久重绑 + 按路径追加重建 | dist session-manager.js:611-612,724-751 |
| 20 | pi ToolCall.type='toolCall'（reducer 兼容 'tool_use' 为无害冗余） | pi-ai types.d.ts:244-245 |
| 21 | pi 首条 assistant 前不落盘 / get_messages 无 entryId（已知项复核） | rpc-mode.js:533-535 + SessionManager `_persist` flushed 逻辑 |

Electron 主进程专项结论：pi 不由 electron main 直接 spawn（spawn 在 `packages/runtime/src/infra/pi/process-manager.ts`，属 agent A 领地）；electron main 的 pi 相关假设（pi 为 runtime 后代进程、SIGTERM 前预采 descendant PIDs 防 PPID=1、进程树倒序 SIGKILL）与 pi stdout tee（实际在 runtime `infra/logger.ts`）定位核实无误。ws-client（core/transport）无与 pi 语义交叉的错误假设（auth 队列/重连均纯 xyz 协议）。

## 5. 方法论声明

假设采集：对 core/shared/runtime 散点/electron main/scripts/.githooks 全量 grep 断言形态词（pi 会/不会/忽略/已/先/延迟/防御/workaround/0.84/AgentMessage/entry 类型等）+ 代码形态（shape guard、default 分支、as 断言）；逐条以 node_modules `@earendil-works/pi-coding-agent@0.84.1` dist 编译 JS 为运行时权威源核实（含 pi-agent-core 0.84.2 / pi-ai 0.82.1 传递依赖），clone TS 源仅作版本比对；不确定项标「待证实」（#5），未猜测。已知问题清单（tmp 附着/session_end 树污染/bash_execution_update RPC id 复用/W20 双形态/延迟落盘）未重复报告。仅做只读检查 + 一次对 clone 的 `git fetch --dry-run`（FETCH_HEAD 更新，工作树未动）；本仓零写入、零 git 操作。
