# Spec Review：perf-c-rpc-type-pairing（方案 C 精简版）

**审查方法**：禁读重建法。派 fresh subagent 不读 specSections，只给 objective + clarifyRecords（含修正链条），让其从源码重建 spec，与初稿 diff。主 agent 二次核实 subagent 发现。

**审查日期**：2026-07-17

## diff 结果（重建 vs 初稿）

fresh subagent 逐文件核对了 5 个 runtime handler 的 reply 调用 + 11 个 renderer domain 的 register/request 调用，发现初稿的核心数据错误。

### 逐条评估

| # | subagent 发现 | 严重度 | 核实结论 | 处理 |
|---|--------------|--------|---------|------|
| SR1 | **「37 个配对」严重不全，实际 63 个**。初稿提取配对的脚本有正则 bug（`[a-z_.:]+` 不匹配大写驼峰 type 名如 getSubagents/setThinkingLevel），漏了 session.ts 17 个 + config.ts 13 个 + extension.ts 若干。ReplyPayloadMap 若只建 37 key，一半 domain 仍手写泛型，FR-5「消除手写泛型」达不成 | **must-fix** | **核实成立**。重新用正确正则统计：renderer domain 发送 63 个 RPC request type。FR-2/AC-2 的「37」全错 | 修正：配对清单改为完整 63 个，FR-2/AC-2 重写 |
| SR2 | **session.switch 与 session.history 共用 reply type 但 payload shape 不同**（switch 带 session summary，history 不带）。ReplyPayloadMap 单 value 无法表达 | **should-fix** | **核实成立但已有解法**：switch 前端 `request<void>`（不读 payload），history 读 messages。按 K 映射不冲突——`ReplyPayloadMap['session.switch']=void`、`ReplyPayloadMap['session.history']={sessionId,messages,historyTruncated}`。ServerMessageMap['session.history'] 的 `session` 字段设 optional（switch 路径有，history 路径无） | 修正：spec 明确 session 字段 optional + switch/history 按 K 分流 |
| SR3 | **mock 推导死锁**：command<K>() 需 K 字面量，mock 返回 fixture 无 K，无法从 ReplyPayloadMap 推导返回类型。CL4「mock 签名对齐推导返回类型」的「推导」不成立 | **should-fix** | **核实成立**。mock 返回解包后的最终类型（Promise<SessionGroup[]>），不经 command()，无法推导。mock 是手写对齐 domain 最终返回类型，不是推导 | 修正：CL4 措辞改为「mock 手写对齐 domain 最终返回类型」 |
| SR4 | **plugin 域 renderer 无 register**：plugin-message-handler 有 reply（pong/config.plugins/plugin:config），但 renderer plugin domain 只有 onPlugins 订阅骨架，无 RPC register | **should-fix** | **核实成立**。plugin.* 的 RPC 配对当前无 renderer 消费者，不进 ReplyPayloadMap | 修正：plugin.* 列为 outOfScope（renderer domain 未实装 RPC） |
| SR5 | ping→pong 是否纳入 ReplyPayloadMap？ping 不走 domain，走 ws-client 层 | **nit** | pong 已有精确条目（ServerMessageMapBase['pong']），ping 走 ws-client 不经 command()。无需纳入 ReplyPayloadMap | 不进 issues，记 nit |

## 审查结论

**1 个 must-fix（SR1 配对数 63）+ 3 个 should-fix（SR2 shape 分流 / SR3 mock 措辞 / SR4 plugin outOfScope）**。

SR1 是 blocker：配对清单是 ReplyPayloadMap 的核心数据，37→63 的修正影响 FR-2/AC-2/FR-5。必须在 plan 前修正。

SR2/SR3/SR4 是 spec 表述不清或边界未定，修正后方案仍自洽（精简版一级映射 + command() 方向正确）。

### 正面确认（subagent 重建与初稿一致的部分）

- command() 类型化方向正确（FR-3/FR-4）
- ack 型 void（D2-revised）正确——domain 确实 register<void> 不读 payload
- 砍 RequestReplyMap（D1-revised）正确——一级 ReplyPayloadMap 足够
- 流式 push 事件剔除范围（D5）正确
- 纯类型重构零运行时变更的约束成立

## 修正后的完整 63 个 RPC 配对清单

payload 消费型（ReplyPayloadMap value 引用 ServerMessageMap）：
- session: list→session.list, create→session.created, delete→session.deleted, fork→session.created, rename→session.renamed, history→session.history, getFullHistory→session.fullHistory, getCommands→session.commands, getContext→context.update, getSubagents→session.subagents, getSubagentHistory→session.subagentHistory, getWorkflows→session.workflows, getAgentCallHistory→session.agentCallHistory, getAgentCallFilePath→session.agentCallFilePath
- config: getProviders→config.providers, scanSkills→config.scannedSkills, scanAgents→config.scannedAgents, discoverModels→config.discoveredModels
- model: switch→model.switched
- file: read→file.read:result, tree→file.tree:result, tree.expand→file.tree.expand:result, search→file.search:result
- git: status→git.status:result, diff→git.diff:result
- extension: list/toggle/install/uninstall/upgrade→config.extensions, recommended→extension.recommended, installDir/installGit→extension.discovered, cancelInstall→extension.installCancelled, getPendingRequests→extension.pendingRequests
- workspace: listRecent/record→workspace.recentList

ack 型（ReplyPayloadMap value = void，reply 是 message.status 或 config.*Updated 等，domain register<void>）：
- message: send/steer/follow_up/abort
- git: stage/unstage/commit/checkout/createBranch
- session: switch（见 SR2，不读 payload）/setThinkingLevel/compact/subagentAction/workflowAction/rename/delete
- config: setProvider/deleteProvider/setSkill/deleteSkill/setAgent/deleteAgent/setSkillDirs/setAgentDirs/setDefaultModel（13 个动作-ack）
- extension: finishInstall/setAutoUpgrade/ui_response

注：extension.ui_response 的 reply 形态待 plan 阶段确认（可能是 fire-and-forget 无 reply，需核实）。
