# 阶段 3 · 拆 session-service 巨石（中等风险，需测试）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：T2 · spec：design.md §4.3 T2
> **D6c 订正**：不引入事件总线、不动 switchModel 归属（无循环可解）。
> **v1.1 修订**（plan-review-round-1）：补齐 21 个 public 方法归属、定义私有 helper + sessions Map + constructor deps 的跨模块共享模型、明确 onSessionExit 回调归属。

## 目标

拆 `session-service.ts`（722 行，5 类职责）为 3 协作模块；统一 sendMessage/sendSubagentMessage 重复。仍实现 `ISessionService` 门面，内部组合。

## 前置依赖

建议阶段 2 完成后做（session/ 子目录归位）。**必须先写 vitest**。

## 现状（ISessionService 全 21 方法 + 行号）

| 方法 | 行号 | 归属（本计划） |
|------|------|---------------|
| create | 96 | lifecycle |
| delete | 170 | lifecycle |
| renameSession | 151 | lifecycle |
| restoreSession | 137 | lifecycle |
| rebindAfterFork | 541 | lifecycle（**v1.1 补**） |
| sendMessage | 198 | dispatcher |
| sendSubagentMessage | 248 | dispatcher |
| abort | 308 | dispatcher |
| steerMessage | 314 | dispatcher |
| followUpMessage | 320 | dispatcher |
| compact | 362 | dispatcher |
| switchModel | 328 | **Facade**（编排者，D6c 订正：现状正确） |
| setThinkingLevel | 349 | **Facade**（与 switchModel 同构，访问 sessions Map） |
| getHistory | 369 | **Facade**（经 rpc-client + adapter，轻） |
| hasActiveSession | 358 | **Facade**（进程绑定，查 sessions） |
| getRpcClient | 362 | **Facade**（进程绑定） |
| ensureActive | 371 | **Facade**（进程绑定，被多模块用） |
| listPersistedSessions | 98 | scanner |
| getSummary | 560 | **Facade**（**v1.1 补**，查 sessions，被 PluginService 用） |
| destroyAll | 567 | **Facade**（**v1.1 补**，遍历 sessions，生命周期终结） |
| setSendMessageHook | 192 | **Facade**（hook 注册点，转给 dispatcher） |

### 私有 helper（跨模块共享，v1.1 定义模型）

| helper | 行号 | 被谁用 | 归属模型 |
|--------|------|--------|---------|
| initializeManagedSession | 646 | create/restoreSession/rebindAfterFork | **共享**（lifecycle 调，放 Facade 持有，lifecycle 经 Facade 引用调） |
| detachSession | 718 | delete/destroyAll/rebindAfterFork | **共享**（同上，Facade 持有） |
| toSummary | 605 | 全模块 | **共享**（纯函数，可放 utils 或 Facade） |
| findScannedSession | 621 | rename/delete/rebindAfterFork/ensureActive | **共享**（Facade 持有） |
| findSessionByClient | 303 | sendMessage/sendSubagent | dispatcher 私有 |
| getSkillPaths | 579 | create/restoreSession | **共享**（Facade 持有，被 lifecycle 调） |
| getExtensionPaths | 591 | create/restoreSession | **共享**（同上） |

## 共享状态模型（v1.1 定义，解决 sessions Map + deps 跨模块）

拆 3 模块后，状态与依赖的传递模型：

```ts
// session/session-service.ts (Facade)
class SessionService implements ISessionService {
  private sessions = new Map<string, ManagedSession>()  // ← 唯一持有，传给子模块
  private pm: IProcessManager
  private broker: IMessageBroker
  private adapterFactory
  private treeService / extensionService

  private lifecycle: SessionLifecycle       // 构造时注入 this（访问 sessions + helpers）
  private dispatcher: MessageDispatcher     // 注入 this（访问 sessions + hook）
  private scanner: SessionScanner           // 注入 this（只读 sessions）

  // 共享 helper 留 Facade：initializeManagedSession / detachSession / toSummary
  //   / findScannedSession / getSkillPaths / getExtensionPaths
  // 子模块经 Facade 引用调用（this.sessionSvc.initializeManagedSession(...)）
}
```

**模型选择理由**：sessions Map 单写者（Facade）+ 子模块经 Facade 引用只读/委托。避免 Map 多处持有导致状态不一致。子模块不直接持有 sessions，只持有 Facade 的受限视图（暴露 needed 方法）。

**防循环 import（plan-review-round-2 C-4 + round-3 P2）**：受限视图用 **interface 解耦**——定义 `ISessionServiceInternal`（暴露 initializeManagedSession/detachSession/toSummary/findScannedSession/getSkillPaths/getExtensionPaths 给子模块），**interface 必须放 `interfaces.ts`（独立文件）**，子模块 `import type { ISessionServiceInternal } from '../interfaces.js'` 而非从 session-service.ts 引。Facade implements 该接口。这样子模块→接口→Facade 单向，Facade 委托子模块单向，**无模块级循环 import**（若 interface 放 session-service.ts 同文件，子模块 import Facade 文件会重新引入模块环）。运行期的「Facade 调子模块方法、子模块经接口回调 Facade helper」是调用环非依赖环，TS 编译不报。

### pm.onSessionExit 回调归属（v1.1）

构造函数（:78）注册的 exit 回调横跨 lifecycle（sessions.delete）/ tree（unregisterSession）/ scanner（listPersistedSessions）/ broker（broadcast）。**归属 Facade**：回调留在 SessionService 构造函数，调用各子模块的方法（`this.lifecycle.onExit(sid)` / `this.treeService.unregisterSession(sid)` / `this.scanner.invalidate(sid)`）。不拆到单一子模块（它需协调多方）。

## 改动清单（有序 task）

### 1. 先写 vitest（覆盖现有行为，TDD）

`services/session/session-service.test.ts`（vitest，禁 node:test）：
- sendMessage/sendSubagentMessage：hook block/放行、正常发送。
- switchModel：RPC + 缓存。
- abort/steer/followUp/compact。
- create/delete/renameSession/restoreSession/rebindAfterFork/destroyAll 生命周期（mock pm + rpc）。
- listPersistedSessions/getSummary。
- pm.onSessionExit 回调触发后状态一致。

**先跑通现有单文件测试（绿），再动结构。**

### 2. 建目录 + 拆 3 模块（按归属表）

```
services/session/
├── session-service.ts       # Facade：21 方法委托 + 共享 helper + onSessionExit + sessions Map
├── session-lifecycle.ts     # create/delete/renameSession/restoreSession/rebindAfterFork
├── message-dispatcher.ts    # sendMessage/sendSubagent/abort/steer/followUp/compact + hook
└── session-scanner.ts       # listPersistedSessions + listGrouped/listAll/pruneGitCache
```

### 3. 统一 sendMessage/sendSubagentMessage（去重）

`message-dispatcher.ts` 提取：
```ts
private async sendPrompt(sessionId, content, hookContent?: string) {
  if (this.sendMessageHook) {
    const r = await this.sendMessageHook(sessionId, content)
    if (r?.blocked) { /* 发 stream_error */ return }
  }
  // 发 pi（content + 可选 hookContent 区分 subagent）
}
```

### 4. Facade 组合（保持 ISessionService 接口不变）

- 持有 sessions Map + 5 deps + 3 子模块 + 共享 helper。
- `setSendMessageHook` 转给 dispatcher。
- `onSessionExit` 回调留在构造函数，协调子模块。
- **不动** index.ts 组合根（3-Phase 正常）。

## 验证标准

- [ ] `npx vitest run src-electron/runtime/src/services/session/` 全绿。
- [ ] 手测：发消息/subagent/hook 拦截/切模型/中止/compact/rebindAfterFork。
- [ ] `wc -l services/session/*.ts`：每文件 < 300 行。
- [ ] **ISessionService 21 方法全部有归属**（对照上表）。
- [ ] sessions Map 单写者（rg 确认子模块不直接 new/持有 Map）。
- [ ] hook block 语义不变。

## 回滚

单阶段 commit。`git revert` 恢复单文件。

## 风险

| 风险 | 应对 |
|------|------|
| 共享 helper 跨模块调用导致循环（子模块→Facade→子模块） | 受限视图用 `ISessionServiceInternal` 接口解耦；子模块依赖接口非具体类；单向 lifecycle/dispatcher/scanner→接口→Facade |
| this 绑定丢失 | 子模块方法用箭头函数属性或在 Facade 委托时 bind；测试覆盖 |
| onSessionExit 拆分后协调遗漏 | 回调留 Facade 构造函数；测试覆盖 exit 后 sessions/tree/scanner/broker 一致 |
| sessions Map 多处持有导致不一致 | 单写者模型（Facade 唯一持有）；子模块只读经 Facade |

---

## 附：事件总线（可选未来演进，不在本阶段）

D6c 订正后降级为可选。**触发条件**：1) 出现第二个 hook 订阅者；2) 需 hook 链可插拔。未满足前保持 hook 注入。若引入须遵守 design.md T7 命名区分。
