# ADR-0003: recent-workspaces 采用 pull-only RPC（不做 broadcast）

- **Status**: accepted
- **Date**: 2026-07-03
- **From**: `2026-07-03-recent-workspaces §system-architecture §6, §decisions D-004`

## 背景

recent-workspaces 数据（最近工作区记录）需要从前端读取。设计时有两个选择：

1. **pull RPC**：前端 `workspace.listRecent` → runtime reply `workspace.recentList`（请求-响应）
2. **broadcast**：runtime 在 record 后主动推 `workspace.recentList` 到所有窗口（推送）

原设计措辞「走 global 通道 + pull model」存在概念错位——架构审查 SF-1、红队 S1、禁读重建 MISMATCH-1 三路独立指出「global 通道」与「pull model」矛盾。

## 决策

采用 **pull-only RPC**（`workspace.listRecent`），**不做 broadcast**。

### 通道澄清

- pull RPC reply 经前端 `routeInbound` 的 **pending map**（`msg.id` 匹配，见 `useConnection.ts:52-72`）
- **不经** `events.ts` 订阅通道（session/global 通道是 broadcast 推送专用）
- WriteBackCache 读内存视图，使 pull 总拿最新值（record 后内存即更新，无需等 flush）

## 备选方案（取舍）

| 方案 | 取舍 |
|------|------|
| **pull-only RPC（采纳）** | 避开 broadcast 时序坑（invariant #3：renderer 切换/创建 session 后需立即消费的 session 级状态，若 broadcast 早于 renderer 订阅则丢失）。recent-workspaces 无「需即时推送」语义（启动时拉一次 + popover 打开时拉即可） |
| broadcast | 引入 invariant #3 的时序竞争——renderer 必须先订阅 workspace 通道才能收推送，但启动编排顺序难保证。收益低（数据更新频率低） |

## 后果

- 前端 workspaceStore 在 `initApp`（启动）和需要时主动 `load()`
- runtime 无需维护 workspace 订阅状态、无需 broadcast
- 数据时效性靠 WriteBackCache 内存视图保证（record 后内存即最新，pull 读内存）

## 验证

- RPC 贯穿单测（T1.9）：`workspace.listRecent` → reply `workspace.recentList` 含 records
- INV-6 时序验证（T3.3）：`workspaceStore.load()` 在 `presetCwd` 之前（`useSidebar.ts:360-364`）
- 跨进程持久化 E2E（T4.6）：app B 重启后 `workspace.listRecent` 拿到 app A record 的 cwd

## 关联

- 规避 invariant #3（Runtime broadcast 时序竞争），见 AGENTS.md「架构约定」段
