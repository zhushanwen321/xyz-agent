# composer-symbol-system.md 对抗式审查报告（R1）

> 审查者：tech-design-review agent（对抗式，2026-08-24）。结论：3 must-fix / 6 suggestion。
> must-fix 全部已在主文档修订（D4 方案性重写、渲染双链路补设计、留痕决策补齐）；suggestion 全部采纳修订。
> 本文件为审查记录归档，主文档为权威版本。

## must-fix（3，全部已修）

### MF-1 「session_start 可达 runtime」静态断言错误（方案性，推翻 D4 事件路）

- 审查发现：pi 0.84.1 中 `session_start(reason)` 只经 `_extensionRunner.emit()`（`agent-session.js:2072`），从不走 AgentSessionEvent 流出 stdout；`rpc-mode.js` 的 subscribe 只输出 `_emit` 流。event-adapter 加 case 是死代码。
- 主 agent 复核：属实（`agent-session.js:330-331` agent_settled 双发对照，session_start 单发）。
- 修订：F8/R3 断点 1 重写为负向事实；D4 主路改为「promptReload resolve 接线」（依据 `agent-session.js:800` `await _tryExecuteExtensionCommand`——prompt resolve 即 reload 完成）；U3 改动地图改挂 reload-orchestrator/session-service；P1 改负向事实、P2 改为 resolve 时机复验；事件路作为「已核实不可行」记录在 D4 方案 b 防后人再走。

### MF-2 G3 定向气泡渲染通路不存在且未设计（规格缺失）

- 审查发现：custom entry 在 renderer 的现状消费是「历史重建跳过非 client-msg-id 类型 + live 只驱动派生缓存」——定向气泡 live/reload 两链路都缺，重开 session 气泡消失违反 AGENTS.md 规则 9。
- 修订：新增 §3.3.3a 渲染双链路设计（event-adapter 翻译 broadcast + entry-tree-builder 识别重建）；U2 改动地图补 entry-tree-builder 与聊天流渲染条目；S6 验收补「重开后气泡仍在」。

### MF-3 @ 定向消息对主 agent 上下文不可见，未决策（副作用遗漏）

- 审查发现：appendEntry 的 plain custom entry 不进 LLM context（`session-manager.js:163-189`）——主 agent 对定向对话完全失忆，用户追问断裂；文档把「不经主 agent 处理」与「主 agent 不可见」混为一个命题。
- 修订决策：留痕载体改 `pi.sendMessage` 的 custom_message entry（进上下文 + 不 triggerTurn 不唤醒 + 同载体供 UI 渲染），§3.3.3 补三条理由，§3.3.8 重写为两命题显式区分（结构性保证 = 无 turn 无 prompt 残留；留痕 = 下次 turn 可见），S6 补「主 agent 能衔接回答」验收；新增 P6 探针（sendMessage 留痕不唤醒，降级路径已备）。

## suggestion（6，全部已修）

| # | 内容 | 修订 |
|---|---|---|
| S-1 | F6 事实不准：RPC 名是 `session.getSubagents`（protocol.ts:348-349），`session.subagents` 是广播名（:940-941） | F6 已改正 |
| S-2 | U5 改动地图缺 session-message-handler.ts（WS 入口 :281-283 + marker 分支 :441）与 marker 相关测试删改清单 | U5 已补 |
| S-3 | D5「行为等价」与正则语义矛盾：多行第二行行首 `/` 现状不触发、正则会触发，是放宽非等价 | D5 显式声明多行放宽（对齐 TUI 每行行首）；3.1.4 同步；S3 补多行 case c |
| S-4 | `$` 误弹噪声未登记（` $HOME`/` ${var}`/` $100` 空格后弹浮层，频率高于 #） | D6 补「已知取舍」段：空候选不弹已内建（`v-if items.length>0`）+ Esc 关闭；字符集白名单作为否决项（误伤数字开头文件名），留实施期反馈回路 |
| S-5 | P3/P4 探针无降级方向 | P3 补静态证据（pi 以首个空格拆命令、args 全量原文）+ 降级（base64/JSON 编码）；P4 补降级（全量 36 位 uuid） |
| S-6 | `#` 语义切换的用户习惯迁移未提 | 新增 §5.2（release note 对照 + 空候选不弹的即时察觉缓解，否决事前弹窗） |

## 审查通过项（对抗未推翻）

F1/F2/F3/F4/F5/F7/F9/F10 与 R2/R3 断点断言全部核实属实；D2 对称惯例成立（且 `client.prompt` 直发绕过 dispatcher busy 预检，恰好支撑「主 agent 生成中也能发定向消息」；pi extension 命令短路不落 user message 支撑 S6「无新 turn」）；验收章节 P0-13/14/15 过关（S6「数分钟内」已改「即时」）；结构与对比项 P0-1~10/17/18 通过。
