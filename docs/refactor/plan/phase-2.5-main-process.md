# 阶段 2.5 · Main 进程重构（M1 spawn 去重，低风险）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：M1 · spec：design.md §4.2 M1/M2/M3
> **历史**（plan-review-round-1）：原 table 4.4 标 M1「阶段 0」、M3「阶段 3」，两处代码改动无 code phase 认领，本阶段承接 M1。
> **M3 降级**（plan-review-round-3，用户决策 C）：M3（window-manager 改 Set）原计划会丢失 `paneId` 契约（`findSessionBySessionId` 返回 `{windowId, paneId}`，前端类型声明 paneId），且 M3 针对的「双真相源风险」被 spec §3.1 自己定为**低严重度**。**M3 降级为「仅文档化」**（spec 原定位），不做代码改动。本阶段只剩 M1。

## 目标

- **M1**：`main.ts` 的 runtime spawn + 端口通知逻辑在 `whenReady` 与 `activate` 两处重复，抽成 `runtimeManager.startAndNotify(win)`。
- ~~**M3**（已降级为文档化）~~：见下方「M3 文档化说明」。

## 前置依赖

阶段 0（文档）。建议在阶段 2 之后。**与 phase 3 解耦**（不同进程，可并行）。

## 现状（已核对）

### M1 · spawn 去重

`main/main.ts`：
- `whenReady` 块（~:142-156）：`createWindow()` → `runtimeManager.start()` → `mainWindow.webContents.send('runtime-port', port)`，带 try/catch。
- `activate` 块（~:177-188）：**相同三行**重复。
- design.md M1 建议抽 `runtimeManager.startAndNotify(win)`，消除重复。

## 改动清单（有序 task）

### 1. 先写 vitest（覆盖现有行为，TDD）

- `main` 编排测试（mock runtimeManager + BrowserWindow）：whenReady 与 activate 都能通知端口、不重复 spawn。

### 2. M1 · 抽 startAndNotify

- `runtime-manager.ts` 新增 `async startAndNotify(win: BrowserWindow): Promise<number>`：内部调 `start()` + `win.webContents.send('runtime-port', port)` + try/catch。
- `main.ts` 的 `whenReady` 与 `activate` 两处都改为调 `startAndNotify(mainWindow)`，消除重复。
- **保持 spawn 幂等**（design.md M2 不变量：`start()` 已有活进程则复用）。

## 验证标准

- [ ] vitest 全绿（main 编排测试）。
- [ ] runtime spawn 幂等：activate 时不重复 spawn（测试覆盖）。
- [ ] `npm run build` + `npm run dev` 正常。

## 回滚

单阶段 commit。`git revert` 恢复重复 spawn 逻辑。

## 风险

| 风险 | 应对 |
|------|------|
| activate 重复 spawn 破坏幂等 | start() 幂等已就绪；测试覆盖 activate 场景 |

---

## M3 文档化说明（不做代码改动，仅记录）

**为何降级**（plan-review-round-3）：M3 计划把 `window-manager` 的 `panelTree` 改为 `sessionIds: Set`，但：

1. **契约冲突**：`findSessionBySessionId`（`window-manager.ts:87`）现返回 `{ windowId, paneId }`，`paneId` 靠递归 panelTree 取得；改 Set 后 paneId 无来源。IPC `find-session-window`（`ipc-handlers.ts:90`）+ 前端类型（`stores/window.ts:31`）都声明了 paneId。改 Set 需同步处理 IPC 协议 + 前端类型 + paneId 去向，plan 未覆盖。
2. **风险本身弱**：当前 Renderer 是 panelTree 唯一真相源，Main 存副本，仅在 IPC 丢/乱序时副本过期——**当前无实际 bug**。
3. **spec 自定低优先**：spec §3.1 把 D2（双真相源）定为「🟢 低 / 仅文档化」。

**当前现状记录**（供未来若真要消除双真相源时参考）：
- `window-manager.ts:87` `findSessionBySessionId` 返回 `{ windowId, paneId } | null`
- `:89` 调 `findPaneBySessionId(state.panelTree, ...)` 递归 panelTree 取 paneId
- `:100-105` `findPaneBySessionId` 递归实现
- `:115` `initialWindowState` 同时含 `panelTree` + `focusedPanelId` + `sessionIds[]`（两套并存）
- **关键事实**：前端 `grep '\.paneId' renderer/` 零命中——paneId 是**声明了但无值消费的死字段**。未来若做 M3，顺势废弃 paneId（IPC 返回改 `{windowId}`）成本为零，无需改存 Map。

**结论**：M3 风险弱、无 bug、spec 定低优；当前不做。若未来双真相源真的引发 bug，再按上述现状记录启动 M3，届时采用「顺势废弃 paneId」方案（前端无人用，成本零）。
