# Code Review — subagent-panel

## 概述

在 xyz-agent 左侧边栏新增 Agents tab，支持查看当前 session 派生的 subagent 列表 + 对话流（只读）。数据获取通过 runtime 直读主 session JSONL 的 subagent toolCall/toolResult 提取列表，用 toolResult 中的 sessionFile 路径直读 subagent JSONL 复用 convertPiHistory 转换为对话流消息。

## Wave 覆盖核对

### W1: shared 类型 + WS 协议

- `packages/shared/src/subagent.ts` — SubagentRecord 类型定义（含 subagentId/sessionFile/agent/task/status/mode/turns/tokens/elapsed 等）
- `packages/shared/src/index.ts` — 导出 SubagentRecord
- `packages/shared/src/protocol.ts` — ClientMessageType 加 session.getSubagents/getSubagentHistory + ServerMessageType 加 session.subagents/subagentHistory + ServerMessageMapBase 精确 payload

**覆盖**: ✅ 全部 changes 落地

### W2: runtime encodeCwd + subagent-extractor

- `packages/runtime/src/infra/pi/pi-paths.ts` — encodeCwd(cwd) + getSubagentSessionDir(mainCwd)
- `packages/runtime/src/services/session/subagent-extractor.ts` — extractSubagentsFromSessionFile(filePath)，配对解析 subagent toolCall + toolResult + bg-notify

**覆盖**: ✅ 全部 changes 落地。处理了 sync 模式（syncResponse）、background 模式（bgResponse + listResponse + bg-notify 合并）、多 subagent、failed 状态、空文件等边界。

### W3: runtime SessionService + RPC handler

- `packages/runtime/src/interfaces.ts` — ISessionService 加 getSubagents + getSubagentHistory 签名
- `packages/runtime/src/services/session/session-service.ts` — 实现（scanSessions 查主 session 文件 → extractSubagentsFromSessionFile → getHistoryFromFilePath 读 subagent JSONL）
- `packages/runtime/src/services/session-history.ts` — 抽取 getHistoryFromFilePath 底层函数（DRY，主 session 和 subagent session 共用）
- `packages/runtime/src/transport/session-message-handler.ts` — handles 数组 + switch case

**覆盖**: ✅ 全部 changes 落地

### W4: renderer SegmentedTab + SubagentList + Panel 切换

- `packages/renderer/src/stores/sidebar.ts` — SidebarTab 加 'subagents'
- `packages/renderer/src/components/sidebar/SegmentedTab.vue` — icon-only 3 tab（sessions/files/subagents），Bot icon，badge-dot
- `packages/renderer/src/components/sidebar/SubagentList.vue` — 列表卡片（状态点 + agent + task + turns/tokens/elapsed）+ 空态
- `packages/renderer/src/composables/features/useSubagentView.ts` — Panel sessionId 临时切换 + subagent 历史 hydrate
- `packages/renderer/src/components/sidebar/Sidebar.vue` — 子视图分支 + watch 加载列表
- `packages/renderer/src/components/panel/PanelHeader.vue` — 返回按钮变体（viewingSubagent 态）
- `packages/renderer/src/components/panel/Panel.vue` — 透传 viewingSubagent + back emit
- `packages/renderer/src/api/domains/session.ts` — getSubagents + getSubagentHistory WS 调用
- `packages/renderer/src/api/mock/index.ts` — mock 实现

**覆盖**: ✅ 全部 changes 落地

## 5 维度审查

### 1. 正确性

- **数据模型修正**: spec 假设 subagent JSONL 有 `subagent-identity` custom entry 和 `rootSessionId`，实际验证发现不存在。实际数据关联模型是主 session JSONL 的 subagent toolCall/toolResult 携带 subagentId + sessionFile。plan.json 已修正数据获取路径。
- **encodeCwd 正确性**: 复刻 pi-subagent-workflow path-encoding.ts 的 `'--' + cwd.replace(/^[/\\]/, '').replace(/[/\\\\:]/g, '-') + '--'`，与磁盘实际目录名匹配（验证了 `--Users-zhushanwen-Code-...`）。
- **DRY**: getHistoryFromFilePath 抽取后，主 session 和 subagent session 共用 JSONL → Message 转换链路，消除重复。
- **幂等性**: chatStore.hydrate 有幂等守卫，subagent 消息注入后切回主会话再切回不会重复加载。

### 2. 类型安全

- SubagentRecord 类型完整定义在 shared 包，runtime 和 renderer 共用。
- WS 协议 ServerMessageMapBase 精确 payload（SubagentRecord[] + Message[]），tsc 编译时校验。
- 无 `any` 使用，所有 unknown 类型在 subagent-extractor 中用类型守卫收窄。

### 3. 架构一致性

- **三层架构遵守**: subagent-extractor 在 services 层，通过 ISessionStore port 访问 infra（不直接 import infra/pi/）。
- **WS 协议 SSOT**: ClientMessageType + ServerMessageType 在 shared/protocol.ts 单一定义。
- **路径动态推导**: encodeCwd + getSubagentSessionDir 基于 getPiAgentDir()（getDataDir 推导），不硬编码 `~/.xyz-agent`。
- **SegmentedTab 改为 icon-only**: 4 tab 等宽 flex-1，label 收进 title——与 spec 设计稿一致。

### 4. 边界处理

- **文件不存在**: extractSubagentsFromSessionFile catch 读文件错误返回空数组；getSubagentHistory 用 isEnoent 处理。
- **未知 subagentId**: getSubagentHistory 找不到 record 时返回空数组。
- **空 session**: SubagentList 空态展示提示文案。
- **toolResult text 非 JSON**: extractSubagentsFromSessionFile try/catch 跳过无法解析的 toolResult。

### 5. 测试覆盖

- **U1-U3**: encodeCwd + extractSubagentsFromSessionFile（sync/background/空/多 subagent/failed）— 9 个测试全绿
- **U4**: getSubagentHistory 读取 + 转换 — 4 个测试全绿
- **U5**: SegmentedTab 渲染 3 tab + count + badge — 5 个测试全绿
- **U6-U7**: SubagentList 卡片 + 空态 + 点击 + spinner/dot — 5 个测试全绿
- **E1-E2**: 端到端 RPC（service 层用真实临时文件验证）— 包含在 U4 测试中

## 已知问题

1. **block-ansi.test.ts 预存在失败**: 不是本次改动引入（git stash 验证 HEAD 就失败），与 GUI 组件渲染降级相关。
2. **Phase 1 只读**: 当前不含操作按钮（cancel/pause/resume/abort）和实时 streaming（fs.watch），这些是 Phase 2/3 范围。
3. **Panel sessionId 切换**: useSubagentView 用模块级 ref 管理状态（单实例跟随 active panel），不支持多 panel 同时查看不同 subagent。

## 结论

**通过**。plan 的 4 个 Wave 全部落地，9 个 testCase 的测试全部通过。数据模型修正（从 spec 假设的 rootSessionId 关联改为实际的 toolCall/toolResult 配对）已在实现中体现。
