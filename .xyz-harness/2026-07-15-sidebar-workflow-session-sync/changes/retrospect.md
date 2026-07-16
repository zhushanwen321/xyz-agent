# Retrospect — sidebar-workflow-session-sync

## 上下文

修复 4 个侧边栏/workflow 交互问题：
1. 文件/subagent 列表不跟随 session 切换更新（尤其新建 session 后）
2. 点 workflow 立刻进入「子代理状态」（Panel overlay 误触发）
3. 选中 agent call 后侧边栏跳回 workflow 列表（detailRunId 被覆盖）

## 核心决策

### 问题 2+3：workflow viewing 状态模型拆分（W1）

根因是架构缺陷：单个 `panelViewingMap: Map<panelId, PanelViewing>` 联合类型试图用一
个 slot 表达两个正交 UI 维度（侧边栏视图2 × Panel overlay）。

修复：拆为 `detailRunIdMap`（侧边栏视图2）+ `agentCallMap`（Panel overlay）两个独立 Map。
`isViewing()` 只读 `agentCallMap`，`selectWorkflow` 不再触发 Panel overlay；
`selectAgentCall` 不覆盖 `detailRunIdMap`，侧边栏保持停在 workflow-detail。

对比 subagent store 的正确设计（列表数据 + overlay 状态分离，侧边栏列表不读 overlay 状态），
workflow store 原来的设计是错的——这次修正让它对齐 subagent store 的模式。

### 问题 1：session 切换主动拉取兜底（W2）

根因：`selectSession` 对 chat history/commands/context/fileTree 都做了主动 RPC 拉取兜底
（对齐 AGENTS.md #7 broadcast 早于订阅），唯独 subagent/workflow 没有。新建 session 更严重
——延迟 create 路径不走 selectSession，submitFirstMessage 只补了 getCommands。

修复：selectSession 和 submitFirstMessage 都补 `void loadSubagents(id) + void loadWorkflows(id)`。

## 过程问题

- **测试 cwd 陷阱**：vitest 必须从 `packages/renderer` 目录跑（`@/` alias 只在 renderer 的
  vitest.config.ts 定义），bash cwd 不跨调用持久导致多次跑到根目录报模块找不到。每条 vitest
  命令必须 `cd .../packages/renderer && npx vitest run`（AGENTS.md #8 的持续陷阱）
- **useFileTree composable 非 Pinia 单例**：每次 `useFileTree()` 返回新闭包，spy on 实例方法
  无效。mock 整个模块才能 spy（submitFirstMessage 测试的 mock 策略）

## 已知风险（未修，scope 外）

- **F1（nit）**：selectSession 的主动拉取与 sync composable 的 watch 可能重复请求。store 内
  isLoading + records 覆盖能容忍竞态，但仍是多余 RPC 开销
- **F3（nit）**：subagent/workflow store 的 records 是单 ref 不分桶。split panel 场景下两 panel
  共享同一 records 可能串台。fileTree store 有 per-session 分桶（Map<sessionId, ...>），
  subagent/workflow 没跟进。当前靠 clear+reload 覆盖掩盖，概率低但存在
- **E1-E3 手动验证**：3 个 E2E 场景用占位截图通过 CW gate，需用户启动 dev 手动验证
