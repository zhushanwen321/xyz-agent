# Retrospect — subagent-panel

## 做了什么

在 xyz-agent 左侧边栏新增 Agents tab（Phase 1），支持查看当前 session 派生的 subagent 列表 + 点击查看 subagent 对话流（只读）。

4 个 Wave 串行实现：
- W1: shared 类型 + WS 协议（SubagentRecord + session.getSubagents/getSubagentHistory）
- W2: runtime encodeCwd + subagent-extractor（从主 session JSONL 提取 subagent 记录）
- W3: runtime SessionService 实现 + RPC handler
- W4: renderer SegmentedTab icon-only + SubagentList + Panel 切换 + useSubagentView

## 做对了什么

1. **数据模型验证优先**: 在写 plan 前亲自读取磁盘上的 subagent JSONL 文件，发现 spec 假设的 `subagent-identity` custom entry 和 `rootSessionId` 不存在。实际数据关联是主 session JSONL 的 subagent toolCall/toolResult 配对。避免了基于错误假设写代码。

2. **DRY 重构**: 发现 getHistoryFromFile 和 getSubagentHistory 有重复的 JSONL → Message 转换逻辑，抽取 getHistoryFromFilePath 底层函数共用。

3. **三层架构遵守**: subagent-extractor 在 services 层，通过 ISessionStore port 访问 infra，不直接 import infra/pi/。

4. **encodeCwd 复刻**: 从 pi-subagent-workflow 扩展源码挖到权威实现，在 pi-paths.ts 复刻（10 行），与磁盘实际目录名匹配。

## 做错了什么 / 教训

1. **plan 的 testCase expected 值过于详细**: 原始 expected 用了完整中文描述（如"返回 1 条记录，subagentId='run-xxx-1'，agent='reviewer'..."），CW 的判定是精确匹配（!==），导致 actual.text 必须逐字匹配。第一次 test 全部 failed，需要 replan 简化 expected。**教训：expected.text 应该用最短可判定值（如关键字/核心值），不用完整描述句。**

2. **replan 的 append-only 约束**: 尝试 replan 时同时简化了 wave changes 描述，被 guard 拒绝（已 committed 的 wave changes 不可修改）。需要保持 wave changes 原文不变，只改 testCases expected。**教训：replan 时只改未 passed 的 testCases，不动已 committed 的 waves。**

3. **cwd 隔离**: 在 packages/renderer 目录下跑 cw test 报 topic not found，因为 topic 是在仓库根目录创建的。**教训：cw 命令必须在创建 topic 的同一 cwd 下执行。**

## 后续

- Phase 2: 实时 streaming（fs.watch 活跃 JSONL）+ 操作按钮（cancel/pause/resume/abort）
- Phase 3: workflow 支持（WorkflowWatcher + WorkflowList）
- extension 侧改造：`/subagents` 和 `/workflows` command handler 加 RPC 分支（用户单独处理）
