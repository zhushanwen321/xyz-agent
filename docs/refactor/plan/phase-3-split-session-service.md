# 阶段 3 · 拆 session-service 巨石（中等风险，需测试）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：T2 · spec：design.md §4.3 T2
> **D6c 订正**：本阶段**不**引入事件总线、**不动** switchModel 归属（无循环可解）。

## 目标

拆 `session-service.ts`（722 行，5 类职责混杂）为 3 个协作模块，减轻单文件负担；统一 sendMessage/sendSubagentMessage 重复代码。仍是 `ISessionService` 门面，内部组合。

## 前置依赖

建议阶段 2 完成后做（session/ 子目录自然归位）。**必须先写 vitest**（CLAUDE.md 测试规范）。

## 现状（已核对，方法清单 + 行号）

| 职责 | 方法（行号） |
|------|-------------|
| 生命周期 | `create`(96)、`renameSession`(151)、`delete`(170)、`restoreSession`(137) |
| 消息分发 | `sendMessage`(198)、`sendSubagentMessage`(248)、`abort`(308)、`steerMessage`(314)、`followUpMessage`(320)、`compact`(362) |
| 模型 | `switchModel`(328)、`setThinkingLevel`(349) |
| 进程绑定 | `hasActiveSession`(358)、`getRpcClient`(362)、`ensureActive`(364) |
| 历史 | `getHistory`(369) |
| 扫描 | `listPersistedSessions`(98)、`listGrouped`(私)、`listAll`(私)、`pruneGitCache`(私) |
| hook | `setSendMessageHook`(192) |

文件头已有 TODO 注释（:2-3）提示同款拆分意图。

## 改动清单（有序 task）

### 1. 先写 vitest（覆盖现有行为，TDD 保护）

`src-electron/runtime/src/services/session/session-service.test.ts`（测试框架 vitest，禁止 node:test / tsx --test）：
- `sendMessage`：hook 拦截（blocked 中止 + 放行继续）、正常发送路径。
- `sendSubagentMessage`：同上（hook 也作用于它，:267）。
- `switchModel`：RPC `setModel` 调用 + 缓存更新。
- `abort`：active session 存在/不存在两条路径。
- `create`/`delete`/`restoreSession` 生命周期（mock process-manager + rpc-client）。

**先跑通现有单文件的测试（绿），再动结构。**

### 2. 建目录 + 拆 3 模块

```
services/session/
├── session-service.ts       # Facade，实现 ISessionService，委托给下三者
├── session-lifecycle.ts     # 生命周期
├── message-dispatcher.ts    # 消息分发（含 hook）
└── session-scanner.ts       # 磁盘扫描 + git 缓存
```

**归属**（按上表）：
- `session-lifecycle.ts`：create / renameSession / delete / restoreSession
- `message-dispatcher.ts`：sendMessage / sendSubagentMessage / abort / steerMessage / followUpMessage / compact
- `session-scanner.ts`：listPersistedSessions / listGrouped / listAll / pruneGitCache
- **留在 Facade**：switchModel / setThinkingLevel（编排者，design.md D6c 订正：现状正确）、进程绑定（hasActiveSession/getRpcClient/ensureActive）、getHistory、setSendMessageHook（hook 注入点）

### 3. 统一 sendMessage/sendSubagentMessage（去重）

两者 hook 拦截逻辑重复（:201-206 与 :267-272）。在 `message-dispatcher.ts` 提取：
```ts
private async sendPrompt(sessionId, content, hookContent?: string) {
  if (this.sendMessageHook) {
    const r = await this.sendMessageHook(sessionId, content)
    if (r?.blocked) { /* 发 stream_error，return */ }
  }
  // 发送给 pi（content + 可选 hookContent 区分 subagent）
}
```
sendMessage → `sendPrompt(sid, content)`；sendSubagentMessage → `sendPrompt(sid, content, subagentCtx)`。

### 4. Facade 组合（保持 ISessionService 接口不变）

- `session-service.ts` 持有 lifecycle / dispatcher / scanner 三实例，方法委托。
- `setSendMessageHook` 仍注册到 dispatcher（hook 逻辑在 dispatcher）。
- **不动** `index.ts` 组合根结构（3-Phase 构造正常，design.md D6c 订正）。

## 验证标准

- [ ] `npx vitest run src-electron/runtime/src/services/session/` 全绿。
- [ ] 手测：发消息、subagent 消息、插件 hook 拦截（block + 放行）、切模型、中止生成、compact。
- [ ] `wc -l services/session/*.ts`：每文件 < 300 行（722 拆 3-4 个）。
- [ ] `ISessionService` 接口未变（调用方零改动）。
- [ ] hook block 语义不变（测试覆盖）。

## 回滚

单阶段 commit。`git revert` 恢复单文件 session-service.ts。

## 风险

| 风险 | 应对 |
|------|------|
| 拆分破坏 hook block 语义 | 步骤 1 先写测试；dispatcher 统一 sendPrompt 后测 blocked 路径 |
| Facade 委托遗漏方法 | ISessionService 接口对照检查；TS 编译即暴露 |
| this 绑定丢失（拆分后方法引用） | 用箭头函数属性或在 Facade 中 `.bind()`；测试覆盖 |

---

## 附：事件总线（可选未来演进，不在本阶段）

D6c 订正后，进程内事件总线降级为可选。**触发条件**（满足任一才引入）：
1. 出现第二个想监听 `session.beforeSendMessage` / 会话生命周期的模块（审计日志、限流、独立扩展系统）。
2. 需要让 hook 链可插拔（多 hook 串联 + 优先级）。

未满足前保持 hook 注入（现状）。若引入，须遵守 design.md T7：命名 `domainEvents`/`internalBus`，与前端 event-bus 严格区分。
