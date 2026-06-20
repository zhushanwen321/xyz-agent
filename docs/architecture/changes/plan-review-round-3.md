# 产出文档审查（Round 3）— 正确性

> 方法：fresh read 独立核对代码（window-manager.ts / session-service.ts / useChat.ts / useSession.ts / server.ts / index.ts / ipc-handlers.ts / stores/window.ts / tsup.config.ts / interfaces.ts / main.ts），不轻信"已修复"标注。聚焦**正确性**（事实/因果/技术判断），不重复完整性/可执行性。

## 摘要

- **任务 A（round-2 修订核对，范围内 7 项）**：真改对 6 / 未充分改 1。主 agent 本轮没出现"声称修了但没生效"，修订基本到位。
- **任务 B（正确性）**：
  - 事实：结论性陈述（分类/归属/位置/事件数/方法数）**全部成立**；行号有偏差（18 核对点：准 13、±1 偏差 3、±7 偏差 2、笔误 1）。round-2 摘要"抽查行号全部真实"有水分。
  - 因果：1 处可疑（M3"必须消除双真相源风险"——spec 自身定 D2 为低/文档化，plan 升级为实质改动且引入新问题）。
  - 技术判断：**1 硬伤**（phase-2.5 改 Set 丢失 `paneId`，IPC 契约 + 前端类型签名均依赖 `{windowId, paneId}`，plan 完全未提）。
  - plan↔spec 不一致：1 处（spec §3.3 铁律 #2"阶段2同步tsup" vs plan-2"tsup 零改动"——plan 对，spec 误读 CLAUDE.md #12）。
- **总体判断**：**基本正确，但 phase-2.5 有 1 处硬伤必须先修（paneId）**。phase 1/2/3 正确可用、可进入执行。

---

## 任务 A：round-2 修订核对（fresh read）

| round-2# | 修订项 | 判定 | 证据 |
|---|---|---|---|
| 硬伤1 | phase-2 extension-service 三处对齐 | ✅ | 现状表"需 git mv 进 services/"；task1 有 `git mv extension-service.ts extension-timeout-manager.ts services/`；风险表"已补入 task 1"。三处一致。`index.ts` 确认两文件在根目录 |
| 硬伤2 | phase-2 task4 tsup entry | ✅ | task4「bundle 模式，entry 零改动」「entry 数组零改动」。无残留。`tsup.config.ts` 实测 `bundle:true` + 2 entry |
| 硬伤3 | phase-2 task1 错误 mv 命令 | ✅ | 干净分类 git mv，带"# 误"的命令已删 |
| 瑕疵4 | phase-1 task6 mock 覆盖清单 | ❌ 未落实 | 仍无 mock 必须覆盖的 api domain 方法最小集清单 |
| 瑕疵5 | phase-3 受限视图 interface | ✅（含瑕疵） | 定义 `ISessionServiceInternal`。**瑕疵**：未指明放 `interfaces.ts`，若同文件仍构成模块环 |
| 瑕疵6 | phase-1 G5 events.ts 不碰 store | ✅ | task3「events.ts 不直接调 markSessionError」「useChat(features) 订阅后调」。符合依赖图 |
| 瑕疵7 | phase-2.5 sessionIds 已存在+前端扫描 | ✅（行号瑕疵） | 结论对、前端扫描已补。**瑕疵**：sessionIds 实际在 `:115`，plan 标 `:108` |

**A 小结**：6/7 真改对（2 含小瑕疵），1 项（mock 清单）未落实。

---

## 任务 B1：现状陈述 vs 代码

### 结论性陈述（全部成立）

| 陈述 | 核对 |
|---|---|
| useChat 23 事件 | ✅ createGlobalHandlers 返回 Map 恰 23 项 |
| useChat 全局单例 + 永不注销 | ✅ 模块级 globalEventMap + 幂等注册 |
| useChat 全局流 vs useSession refCount 两模式并存 | ✅ 印证 useSession 用 globalListenerRefCount + onMounted/onUnmounted |
| ISessionService 恰 21 方法 | ✅ |
| extension-service/timeout-manager 在根目录 | ✅ `from './extension-service.js'` |
| tsup bundle + 2 entry + noExternal 4 项 | ✅ |
| sessions Map 现状单类持有 | ✅ `private sessions = new Map` |
| M1 spawn 编排重复 | ✅ whenReady 与 activate 两处 start + send + try/catch |
| window-manager 持 panelTree + sessionIds 并存 | ✅ |

### 行号偏差（round-2"行号全真实"有水分）

| plan 引用 | 实际 | 偏差 |
|---|---|---|
| window-manager sessionIds `:108` | `:115` | +7 |
| session-service ensureActive `:364` | `:371` | +7 |
| 其余 16 处 | — | 准 13 / ±1 偏差 3 / 笔误 1 |

**B1 结论**：行号多数准，偏差**均不影响结构判断**（方法归属/文件位置/分类全对）。但 round-2"行号全真实"夸大——后续审查应以"结论性陈述"为通过判据，非"行号真实"（行号易随代码漂移）。

---

## 任务 B2：因果推理

### 1. phase-3「sessions Map 单写者才能避免状态不一致」— ✅ 成立
现状单类持有；拆模块后多写者确有 delete 不同步风险。单写者合理。

### 2. phase-3「受限视图用 interface 解耦避免循环 import」— 基本成立（瑕疵）
思路对（子模块→接口→Facade 单向，无模块环）。**瑕疵**：interface 必须放 `interfaces.ts`，plan 未明说。

### 3. phase-2.5「M3 消除 Main/Renderer 树结构不一致风险」— ⚠️ 因果成立但收益/成本失衡，偏离 spec
- X（双真相源风险）为真但**弱**：Renderer 是唯一真相源，Main 存副本，IPC 丢/乱序时副本过期。当前无实际 bug。
- spec §3.1 自己把 D2（双真相源）定为「🟢 低 / 仅文档化」。
- plan 升级为实质改动（删 panelTree + 改 IPC + 改前端 store），且**引入 paneId 硬伤**（见 B3）。
- 判断：风险真实但低；plan 改动成本 > 收益。建议重审 M3 必要性，或降级回 spec"仅文档化"。

### 4. phase-2.5「M1 spawn 去重」— ✅ 成立
两处"start + send + try/catch"编排重复真实。抽 `startAndNotify(win)` 合理。

### 5. phase-1「23 事件全局流，不用 refCount」— ✅ 成立
代码印证两类生命周期模式客观并存，G6 区分准确。

### 6. phase-1 G5「runtime 重启后旧 session 消息无意义所以清队列」— ⚠️ 部分成立
plan 已留"系统级 vs 全部清空——执行时定"弹性，可接受。

### 7. phase-2「adapters 防腐层隔离 pi 格式」— ⚠️ 方向对，现状偏理想
event-adapter 等确做格式转换。**但 session-service.ts 仍 `import type { PiMessage }` + 处理 PiHistoryMessage**——pi 类型已泄漏到 service 层。"adapters 是防腐层"是目标态非完全现状。不影响 mv 决策，但执行者需知 mv 不消除类型耦合。

---

## 任务 B3：技术判断可行性

### 1. phase-3 Facade 委托，this 绑定 — ✅ 可行
接口方法调用 = `facade.helper()`，this 指向 Facade。风险表已列应对（箭头函数/bind）。

### 2. phase-2.5 删 panelTree 改 Set — 🔴 硬伤：paneId 丢失
**证据链**（已核实）：
- `window-manager.ts:87`：`findSessionBySessionId` 返回 `{ windowId, paneId } | null`，内部 `findPaneBySessionId(state.panelTree, sessionId)` **递归 panelTree 才能拿到 paneId**
- `ipc-handlers.ts:90`：`ipcMain.handle('find-session-window', ...)` 透传 `{ windowId, paneId }`
- `stores/window.ts:31`：前端类型签名 `Promise<{ windowId: string; paneId: string } | null>`

**问题**：plan-2.5 task3「findSessionBySessionId 改查 sessionIds（Set）」—— `Set<string>` **只能给 windowId，paneId 无来源**。plan 未提 IPC 契约 / 前端类型 / paneId 去向。

**关键发现（主 agent 补充核实）**：`grep '\.paneId' renderer/src/` **全无命中**——前端只声明 paneId 类型，**无值消费**（死返回值）。这影响修复方案：废弃 paneId 成本为零。

### 3. phase-1 api.events.on 注册/注销时机 — ✅ 可行
全局单例下行为不变，仅收口到 api.events。

---

## 硬伤（必须修） vs 瑕疵（可选）

### 🔴 硬伤（1 处）

**H1. phase-2.5 M3 改 Set 丢失 paneId 契约**
- 改 Set 后 paneId 无来源，plan 未提 IPC/类型/去向。
- **修复（三选一）**：
  - (a) 顺势废弃 paneId（前端无值消费，成本零）：IPC 返回改 `{windowId}`，前端类型同步
  - (b) Main 改存 `Map<sessionId, paneId>`（保留契约，比 Set 略重）
  - (c) **重审 M3 必要性，降级回 spec §3.1"仅文档化"**（推荐——风险低、对齐 spec、零代码；M3 双真相源风险本身被 spec 定为低）

### 🟡 瑕疵（建议修）

- **P1. spec↔plan tsup 不一致**：spec §3.3 铁律 #2（:563）「阶段2同步tsup——entry/noExternal/asarUnpack 联动，否则打包崩」+ :543「tsup entry/noExternal 同步更新」误读 CLAUDE.md #12。CLAUDE.md #12 原文是"noExternal 覆盖所有 dependencies（新增依赖才追加）"+"plugin-bootstrap 独立打包（已在 entry）"——**根本没说目录迁移要改 entry**。plan-2（零改动）才对。**spec §3.3 铁律 #2 + :543 需订正**。
- **P2. phase-3 ISessionServiceInternal 文件位置**：应放 `interfaces.ts`，否则同文件 import 仍构成模块环。
- **P3. phase-1 task6 mock 覆盖方法最小集**（round-2 瑕疵4 未落实）。
- **P4. 行号偏差**：sessionIds `:108`→`:115`、ensureActive `:364`→`:371`。建议改用方法名引用（行号易漂移）。
- **P5. phase-2「adapters 防腐」是目标态**：session-service 仍 import PiMessage。建议注明"mv 不消除类型耦合，彻底防腐化属后续 scope"。
- **P6. phase-2.5 M3 偏离 spec 定位**（与 H1 关联，若采 H1-c 自动消解）。

---

## 退出建议

**phase 1 / 2 / 3：正确可用，可进入执行。** 现状陈述、方法归属、文件分类、事件/方法计数全部经代码核对成立；因果推理（单写者、interface 解耦、M1 去重、23 事件全局流、G5 收尾链路）均成立。P1/P2/P3 建议执行前顺手补。

**phase 2.5：必须先定 H1（paneId）再执行。** 推荐降级 M3 回 spec"仅文档化"，既消硬伤又对齐 spec。

**对主 agent 的提醒**：round-2"行号全真实"不实（有 ±1/±7 偏差）。后续审查抽核"结论性陈述"而非"行号真实"。
