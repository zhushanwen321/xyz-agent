# 阶段 2.5 · Main 进程重构（中等风险，需测试）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：M1 / M3 · spec：design.md §4.2 M1/M2/M3
> **新增**（plan-review-round-1）：原 table 4.4 标 M1「阶段 0」、M3「阶段 3」，但 phase 0 纯文档、phase 3 全 Runtime，两处代码改动无 code phase 认领。本阶段承接。

## 目标

- **M1**：`main.ts` 的 runtime spawn + 端口通知逻辑在 `whenReady` 与 `activate` 两处重复，抽成 `runtimeManager.startAndNotify(win)`。
- **M3**：`window-manager.ts` 当前持有完整 PanelTree（递归遍历），改为只存跨窗口查询所需的最小投影（`sessionIds: Set`），消除「Main/Renderer 树结构不一致」风险。

## 前置依赖

阶段 0（文档，尤其 D2 双真相源已定义）。建议在阶段 2 之后（同属「进程内重构」批次）。**与 phase 3 解耦**（不同进程，可并行）。

## 现状（已核对）

### M1 · spawn 去重

`main/main.ts`：
- `whenReady` 块（~:142-156）：`createWindow()` → `runtimeManager.start()` → `mainWindow.webContents.send('runtime-port', port)`，带 try/catch。
- `activate` 块（~:177-188）：**相同三行**重复。
- design.md M1 建议抽 `runtimeManager.startAndNotify(win)`，消除重复。

### M3 · window-manager 状态模型

`main/window-manager.ts`：
- `:89` `findPaneBySessionId(state.panelTree, ...)`、`:100-105` 递归遍历完整 PanelTree 找 session。
- `:108-117` `initialWindowState` 含 `panelTree` + `focusedPanelId` + `sessionIds[]`——Main 存了渲染进程推上来的完整树。
- 唯一跨窗口查询：`findSessionBySessionId`（:87）。
- design.md M3：改存 `sessionIds: Set<string>`，不存完整 tree。

## 改动清单（有序 task）

### 1. 先写 vitest（覆盖现有行为，TDD）

- `window-manager.test.ts`：`findSessionBySessionId` 在有/无 session 时返回正确窗口；`updateWindowState` 同步正确。
- `main` 编排测试（mock runtimeManager + BrowserWindow）：whenReady 与 activate 都能通知端口、不重复 spawn。

### 2. M1 · 抽 startAndNotify

- `runtime-manager.ts` 新增 `async startAndNotify(win: BrowserWindow): Promise<number>`：内部调 `start()` + `win.webContents.send('runtime-port', port)` + try/catch。
- `main.ts` 的 `whenReady` 与 `activate` 两处都改为调 `startAndNotify(mainWindow)`，消除重复。
- **保持 spawn 幂等**（design.md M2 不变量：`start()` 已有活进程则复用）。

### 3. M3 · window-manager 改最小投影

> **plan-review-round-2 发现**（降认知负担）：`window-manager.ts:108` 的 `initialWindowState` **已有 `sessionIds: []` 字段**（与 panelTree 并存）。M3 实际只需「查询改用 sessionIds + 删 panelTree 字段」，比从零加字段更轻。

- `WindowState` 去掉 `panelTree` 字段，保留 `focusedPanelId` + `sessionIds`（已存在，改用）。
- `findSessionBySessionId` 从「递归遍历 panelTree」改为「查 sessionIds」。
- `updateWindowState` 入参从「完整 panelTree」改为「sessionIds + focusedPanelId」。
- **渲染进程侧配套**：`stores/window.ts` 的 `syncPaneState` 改为只推 `sessionIds`（从 panelTree 提取）+ `focusedPanelId`，不推完整树。
- IPC 协议 `update-window-state` 的 payload 相应调整（shared/protocol.ts）。

### 4. 向后兼容过渡（可选，若一次性改风险高）

- 也可分两步：先加 `sessionIds` 字段与 panelTree 并存，渲染进程双推；验证 Main 查询正确后再删 panelTree。但通常一次改更清晰。

## 验证标准

- [ ] vitest 全绿（window-manager + main 编排）。
- [ ] 手测：多窗口、跨窗口 session 查找（`findSessionWindow`）、split panel 后 sessionIds 同步。
- [ ] **全仓 panelTree 清零**：`rg "panelTree" src-electron/main/ src-electron/renderer/src/`（Main + 前端两侧）在 window-manager / stores/window.ts / stores/panel.ts 的使用点全部改完。
- [ ] `npm run build` + `npm run dev` 正常。
- [ ] runtime spawn 幂等：activate 时不重复 spawn（测试覆盖）。

## 回滚

单阶段 commit。`git revert` 恢复完整 panelTree + 重复 spawn 逻辑。

## 风险

| 风险 | 应对 |
|------|------|
| M3 改 Main 持有状态，跨窗口 session 查找回归 | 先写测试覆盖 findSessionBySessionId；手测多窗口 |
| IPC 协议 payload 改动需前后端同步 | shared/protocol.ts 改 + renderer window store 配套；同 commit |
| activate 重复 spawn 破坏幂等 | start() 幂等已就绪；测试覆盖 activate 场景 |
| Main 失去完整 tree 后某些功能依赖它 | 核对全仓 `rg "panelTree" src-electron/` 使用点（Main + 前端 stores/window.ts、stores/panel.ts）；当前仅 findSessionBySessionId |

## 备注

本阶段是 M1/M3 代码改动的唯一承接点。table 4.4 原标的「阶段 0/3」已订正为「阶段 2.5」。D1 时序契约的「代码侧」不变（见 phase 0，时序文档改为匹配代码现状）。
