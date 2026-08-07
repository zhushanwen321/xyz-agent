# 远程化 P3 实施计划：pi 与连接生命周期解耦

**日期**: 2026-07-26 | **spec**: [spec.md](spec.md)（决策编号 D1-D8 在此引用） | **前置**: P0（auth 门控 sendInitialState）+ P2（ring buffer 回放）已实施

> 所有 Task 遵守：vitest（各包内 `npx vitest run`）；lint/hook 问题正面修复；**不主动 git commit**。

---

## 任务清单

### T1 — pendingRequests 缓存审计 + 补发段（服务端）

**核实先行**（spec §2.1 三条前置）：
- `extension-timeout-manager.ts cachePendingRequest`（:168-186）存储字段是否足够重建审批 UI
- 清理路径：session 删除 / pi 进程退出 / restore 重建时 pending 缓存是否清除（孤儿请求会随 initial state 反复推送）
- 缓存是否无界

**文件**：
- `packages/runtime/src/transport/message-broker.ts`（sendInitialState 加**第 14 段** `extension.pendingRequestsBatch`【R1-C1 独立 type，非 extension.pendingRequests】，点对点不打 seq）
- `packages/runtime/src/services/extension/extension-timeout-manager.ts`（按审计结果补清理钩子：session 删除/pi exit 时清该 session 的 pending）
- `session-service.ts` onSessionExit / detachSession 处接清理（如需）

**测试**：broker 测试扩展（**第 14 段**存在/内容正确，type 是 `extension.pendingRequestsBatch`）；timeout-manager 清理测试（无孤儿）

### T2 — renderer 消费补发

**文件**：
- `packages/renderer/src/composables/useExtensionUI.ts`（或对应 store）——**`extension.pendingRequestsBatch`** handler（R1-C1 独立 type）+ requestId 去重
- 冷启动时序兜底：onConnected 后主动 `extension.getPendingRequests`（spec §2.2 二选一，实施取简单者）

**测试**：push → 审批 UI 可见（用户可见断言）；重复 requestId 不重复弹

### T3 — 解耦语义固化测试 + verify 脚本

**测试**（spec §三表格四条契约）：
- 全断开 pi 存活 + 事件入 buffer（runtime 集成测试）
- 审批挂起 180s+ watchdog 不误 abort（event-interpreter 测试，vi.useFakeTimers）
- 审批挂起 → 冷启动新客户端 → 补发 → 响应 → pi 继续（端到端）

**脚本**：`tools/verify-pi-decouple.cjs`——真 runtime + 真 pi 两场景：①生成中断线→turn 完成→重连回放完整；②审批挂起→断开→冷启动→补发→响应→继续

### T4 — 文档

- 部署文档追加三条语义（spec §四.1；若 P0 的 `docs/deployment/server.md` 尚未建，记录为 P0 T12 的追加内容）
- `docs/troubleshooting.md` 追加 Q&A
- `docs/feature-map/2026-07-26-remote.md` §十一索引追加 P3 行；§十 待确认 #3 标记已决（指向本 spec D1/D2）

---

## 依赖与顺序

```
T1（服务端补发）─→ T2（renderer 消费）
T3 依赖 T1/T2（端到端场景）+ P2 已实施
T4 随时，最后收尾
```

## DoD

0. **【R2-m4 前置 gate】** P0（auth 门控 sendInitialState）+ P2（per-session ring buffer 回放）已实施——P3 审批补发走 sendInitialState 第 14 段（点对点），短断线审批回放靠 P2 buffer
1. vitest 全绿（runtime + renderer，新增 + 现有）
2. `tools/verify-pi-decouple.cjs` exit 0（两场景）
3. spec §三四条契约测试全过
4. feature-map §十 #3 两个子问题在文档中标记已决
5. `npm run lint` + pre-commit 全过
