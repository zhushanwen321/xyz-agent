# Plan: 修复 slash command 时序 bug + Landing 预创建 session

## 背景与根因

### 问题 A：真实环境（npm run dev）slash 浮层不弹出
- **现象**：切进 session 后输入 `/`，浮层不出现（slashCount:0）
- **根因**（三层诊断铁证）：
  1. runtime `fetchAndBroadcastCommands` 在 `session.switch` 的 `ensureActive` **内部** broadcast 96 命令（runtime 日志确认）
  2. renderer transport `routeInbound` **只收到 `session.history`，从未收到 `session.commands`**（DIAG log 确认）
  3. 原因：broadcast 发生在 renderer `await sessionApi.switchSession()` resolve **之前**——此时 `session.activeId` 尚未更新，CommandPopover 的 `watch(sessionId)` 还没触发重订阅，新 sessionId 通道无人订阅 → broadcast 丢弃
  4. `session.history` 能收到是因为它是 `reply(ws, msg.id)`（RPC 响应），由 pending map 捕获，不依赖订阅
- **为什么 mock 工作**：mock `switchSession` 的 `pushSessionState` 用 `setTimeout(30ms)`，与 renderer selectSession 的 await 链时序碰巧对上；真实 RPC 往返更紧，时序错位

### 问题 B：Landing（新建任务页）选定目录后也要支持 slash
- **现状**：Landing 用同一 Composer + CommandPopover，传 `composerSid`
- **矛盾**：`useNewTaskFlow` 注释明确「landing 态恒为 null，首发提交 submitFirstMessage 才绑定；选目录只记 pendingCwd 不建 session」。CommandPopover 在 `sid=null` 时不订阅，无命令源
- **方案**：选定目录后预创建 session（放弃「延迟 create」，换 Landing slash 支持）

### 问题 C：dev/prod 不许出现 mock（原则）
- mock 仅限 `VITE_MOCK=true` 纯前端联调。Landing 方案不用 mock，走真实 session 命令源

## 修复方案

### Wave 1：时序 bug 修复（问题 A）—— renderer 主动拉 commands

**方案**：renderer 收到 session.switch 响应后，主动调 `session.getCommands` RPC 重新拉取命令。彻底解耦订阅时序——renderer 控制何时拿数据。

**改动**：
1. `shared/protocol.ts`：新增 `session.getCommands` ClientMessageType + Map + ClientMessage 联合分支
2. `runtime/transport/session-message-handler.ts`：新增 `session.getCommands` handler，调 `sessionService.getCommands(sid)` → `reply(ws, msg.id, 'session.commands', {...})`
3. `runtime/services/session/session-service.ts`：新增 public `getCommands(id)` 方法（从 `fetchAndBroadcastCommands` 提取查询部分；保留原 broadcast 版给 ensureActive 用）
4. `runtime/interfaces.ts`：ISessionService 加 `getCommands` 签名
5. `renderer/api/domains/session.ts` + `renderer/api/mock/index.ts`：session domain 加 `getCommands(sid)` 方法（real 走 transport RPC；mock 直接返回 MOCK_COMMANDS）
6. `renderer/composables/features/useSidebar.ts`：`selectSession` 在 `switchSession` resolve 后调 `sessionApi.getCommands(id)` 拿到命令，`events.dispatchSession(id, {type:'session.commands', payload:{commands}})` 本地分发（让 CommandPopover 订阅收到）

**验证**：真实环境切 session → 输入 / → 浮层弹出含 96 命令（skill:xxx / xyz-navigate）

### Wave 2：Landing 预创建 session（问题 B）

**方案**：用户在 Landing 选定目录后，立即创建 session（而非首发才建）。session 一建就能拉真实命令，Landing 与 panel 共享同一套 slash 逻辑。

**改动**：
1. `renderer/composables/features/useNewTaskFlow.ts`：选目录完成时（pendingCwd 赋值后）调 `sessionApi.create(pendingCwd)` 创建 session，`currentSessionId` 绑定。`submitFirstMessage` 改为「已有 session 直接 send」
2. 移除「延迟 create」相关守卫（createInFlight、首发才 create 的逻辑）

**验证**：Landing 选目录 → composerSid 非 null → 输入 / → 浮层弹出真实命令

### Wave 3：回归 + 验收

1. mock 环境（VITE_MOCK=true）：panel 态 + landing 态 slash 均工作
2. 真实环境（npm run dev）：panel 态 + landing 态 slash 均工作
3. 单测：useSidebar.getCommands 调用、useNewTaskFlow 预创建逻辑

## 测试清单（TDD）

### 单元测试（U）
- U1: useSidebar.selectSession 调 switchSession 后调 sessionApi.getCommands（wave 1）
- U2: sessionApi.getCommands(real) 走 transport RPC（wave 1）
- U3: sessionApi.getCommands(mock) 返回 MOCK_COMMANDS（wave 1）
- U4: useNewTaskFlow 选目录后创建 session（wave 2）
- U5: useNewTaskFlow submitFirstMessage 复用已建 session（wave 2）

### 手动 E2E（无框架）
- E1: 真实环境 panel 态切 session → 输入 / → 浮层弹出（96 命令）
- E2: 真实环境 Landing 选目录 → 输入 / → 浮层弹出
- E3: mock 环境 panel + landing slash 均工作
- E4: 浮层 Tab/Enter 选中 → 插 slash chip
- E5: 浮层 query 过滤（输入 /comm 过滤命令）
- E6: 切回旧 session slash 仍工作（订阅重订正确）
