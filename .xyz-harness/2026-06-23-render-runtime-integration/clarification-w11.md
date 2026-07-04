# clarification · W11+ 范围澄清记录

> 配套 spec-w11.md。记录 5 轮澄清的决策 + 已核验事实 + 待 5 视角追踪验证的假设。

## 已核验事实（grep 确认，非 subagent 旧态报告）

### W01-W10 真实落地状态（关键修正）
subagent 第一轮分析混入了 W05-W10 落地前的旧态。经精准 grep 核验，以下已确认完成：

- ✅ **chat-chunk-processor.ts 19 个 message.* case 全在**（:74-345）
  - message_start/text_delta/thinking_start/thinking_end/thinking_delta/tool_call_start/tool_call_end/tool_call_update/complete/status/bashExecution/compactionSummary/branchSummary/auto_retry_start/auto_retry_end/queue_update/stream_error/error/file_changes
- ✅ **chat.ts applyFileChanges 完整实现**（:148-174）+ changeSetStatuses Map（:46）
- ✅ **ChangeSetCard.vue 5 态状态机完整**（accumulating/ready/partially-reviewed/resolved/superseded）
- ✅ **model.switched 经 pending 通道 resolve**（W04 已修正，不需订阅——waves.md:186）
- ✅ **retryStates/queueStates 已入库**（chat.ts:42,44 + getRetryState/getQueueState）

### 仍成立的真实缺口（本次要做）
- 🔴 `message.tool_call_pending` 硬漏接（chunk-processor:355 default 丢弃，case 列表无此项）
- 🟡 **retryState/queueState store 有数据但 Turn.vue 未消费**（Turn.vue:236 只读 getChangeSetStatus）
- 🔴 mock/index.ts 零命中 thinking/tool_call/file_changes/bash/queue_update/auto_retry 流式事件
- 🔴 前端 onGlobalType 只有 7 条（config.*/model.list），无 session.list server-push 订阅
- 🔴 FileView.vue 直读 mock fixture（Sidebar.vue:143 `fixtureFileChanges`），未切 file_changes 聚合

## 后端 ports 对照（已读 ports/*.ts）
| port | 域 | 本次相关 |
|---|---|---|
| IConfigStore | Provider/Skill/Agent CRUD + 默认模型 | FR-5（已 W08-W09 对接，install 属 Extension） |
| IExtensionSettings | packages[] + disabled | FR-5 |
| IInstaller | npm install/uninstall + git clone | FR-5 |
| IExtensionResolver | extension 路径发现 + 校验 | FR-5 |
| IPiEngine | compact/clear + prompt/steer/followUp | FR-6 |
| IModelSource | discoverFromApi | 已 W08 对接 |

## 已澄清决策（5 轮 ask_user）

| 轮次 | 问题 | 决策 |
|---|---|---|
| 1 | 范围深度 | 三档全做 |
| 1 | 审批边界 | 含 Diff 代码审查审批（整块排除） |
| 2 | Side Drawer 处理 | 保留容器，仅移除 Diff 子项 |
| 2 | Plugin | 维持 deferred |
| 3 | mock 流式 | 全套补全（固定剧本） |
| 3 | FileView 数据源 | 切到 file_changes 聚合 |
| 4 | mock 深度 | 全套流式事件（固定剧本） |
| 4 | 右抽屉定位 | 建空容器为 widget 铺位 |
| 4 | session.list | 加 server-push 订阅 |

## 待 5 视角追踪验证的假设（标注 [UNVERIFIED]）

以下在 spec 中提及但未经代码逐行验证，留给 Step 3 独立 subagent 追踪：

1. [UNVERIFIED] extension domain 加 onWidget/onStatus 订阅——extension:widget/extension:status 的 dispatch 路由（global 还是 session 通道？payload 含 sessionId，但 events.ts 的 routeInbound 逻辑需确认）
2. [UNVERIFIED] SideDrawer 容器的单/双模式对接——panel/spec.md 的 Drawer 触发机制（点 ChangeSetCard 打开？还是独立按钮？）
3. [UNVERIFIED] compact 按钮放 Composer 还是 Header——panel/spec.md 的 progress-zone/companion-zones 定义需细读
4. [UNVERIFIED] FileView 聚合多回合 fileChanges 还是只取末条 assistant——draft-file-view.html 的语义
