# 远程化 P2 实施计划：可靠投递层

**日期**: 2026-07-26 | **spec**: [spec.md](spec.md)（决策编号 D1-D10 在此引用） | **前置**: P0（auth 握手骨架）+ P1（ws-client auth/close code）已实施

> 所有 Task 遵守：vitest（runtime/renderer 各自包内 `npx vitest run`）；lint/hook 问题正面修复；**不主动 git commit**。runtime 传输层改动按 AGENTS §12 精神逐个 commit 验证。

---

## 任务清单

### T1 — shared 协议类型

**文件**：`packages/shared/src/protocol.ts`

- `ServerMessage` envelope + `seq?: number`（spec §2.1）
- `auth` payload + `bootId?: string` + `subscribedSessions?: string[]`（限定回放范围，D2.1）；`auth.token` 维持必填（P0 协议不变，本地开放模式不走 auth 不获得回放能力，spec §九兼容性表格）
- `auth.ok` payload + `bootId/serverSeq/resumed/replayedCount?/seqReset?`（spec §2.2）

**验收**：tsc 通过；runtime/renderer 引用处类型不改行为。

### T2 — broker：seq 打点 + ring buffer + getReplayPlan

**文件**：`packages/runtime/src/transport/message-broker.ts`

- 成员：`seq`/`bootId`/`sessionBuffers: Map<string, SessionBuffer>`/`evictedWatermark`（spec §3.1，per-session 分桶）
- `SessionBuffer` 接口：`{ entries: Array<{seq, data}>, bytes: number }`
- `broadcast`：注入 seq → stringify 一次 → 按 `payload.sessionId` 分桶（有 sid 且非 terminal.data 入对应桶，巨消息豁免不入桶）→ 单桶 LRU 驱逐推进 watermark
- `getReplayPlan(lastSeq, bootId, subscribedSessions)`（spec §3.2）：**只遍历 subscribedSessions 对应桶**收集 seq>lastSeq，按 seq 升序合并
- `clearSessionBuffer(sid)`：session 销毁时调用，移除该桶，**不推进 evictedWatermark**（D4 ①：session 已删，客户端收到 session.deleted 清分区）
- env：`XYZ_AGENT_REPLAY_MAX_MESSAGES_PER_SESSION`（1000）/ `XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION`（8MB）
- 顺带核实 `message.file_changes` 幂等性（spec 开放问题 1），非幂等补 messageId 去重

**测试**：`transport/message-broker.replay.test.ts`（新建，spec §十表格行 1-4）

**验收**：现有 broadcast 测试全绿（seq 注入不破坏 envelope 消费方）。

### T3 — auth 握手回放编排

**文件**：
- `packages/runtime/src/transport/connection-manager.ts`（auth 通过分支插入 plan 判定，spec §四时序图）
- `packages/runtime/src/transport/server.ts`（onConnect 门控：resumed 跳过 sendInitialState）

**测试**：`connection-manager.auth.test.ts` 扩展（冷启动全量 / resumed 不回放 initial state 且限定订阅桶按序直发 / seqReset 带标志推全量 / 回放顺序与原文一致 / subscribedSessions 过滤生效）

### T4 — terminal scrollback + attach 回灌

**文件**：`packages/runtime/src/services/terminal/terminal-service.ts`

- per-session chunk ring（1000 chunks / 256KB，`XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES`）
- onData 入 buffer；attach(sid, ws) 同步点对点回灌（spec §五）；kill/session 销毁清除
- handler 层 attach 路由传 ws

**测试**：`terminal-service.test.ts` 扩展（双限驱逐 / 回灌内容与顺序 / 点对点不广播 / kill 清除）

### T5 — renderer：seq 跟踪 + seqReset reload + terminal 重连

**文件**：
- `packages/renderer/src/lib/ws-client.ts`（spec §6.1：lastSeq/serverBootId/getSubscribedSessions 注入 模块级；onmessage 更新；connect auth 携带 lastSeq+bootId+subscribedSessions；seqReset → 清 seq + `location.reload()`）
- `packages/renderer/src/composables/terminal/useTerminal.ts`（spec §6.3：重连清 per-session scrollback + 重新 attach）

**测试**：ws-client 测试扩展（seq 更新 / 重连携带 lastSeq+bootId+subscribedSessions / seqReset→reload mock / serverSeq 基线）；useTerminal 重连测试

**验收**：mock 模式测试全绿（lastSeq 恒 0 不触发新逻辑）。

### T6 — 端到端验证 + 文档

- `tools/verify-replay.cjs`（spec §十末行：断线→产生广播→重连回放→断言无缺失无重复；第二客户端冷启动全量；**多 session 场景：断线期间 session A/B 各有增量，subscribedSessions 限定后精准回放**；**未订阅 session C 不回放**；**断线期间 session 被销毁，重连不报错**）
- 手动 E2E：dev app 断网 30s 恢复（pi 生成中）→ 无卡「思考中」；断 10min → reload 恢复
- `docs/feature-map/2026-07-26-remote.md` §十一索引追加 P2 行

---

## 依赖与顺序

```
T1（协议）─→ T2（broker）─→ T3（auth 编排）
T4（terminal）独立于 T2/T3，可并行
T5（renderer）依赖 T1 类型 + P1 ws-client auth 已就位
T6 最后
```

## DoD

0. **【R2-m4 前置 gate】** P0 已实施（auth 门控 sendInitialState、Map<clientId, ConnectionCtx>、auth.ok reply）——P2 回放依赖 auth 握手骨架 + lastSeq 预留字段
1. `packages/runtime` + `packages/renderer` vitest 全绿（新增 + 现有）
2. `tools/verify-replay.cjs` exit 0：回放无缺失、无重复、无 initial state 混推
3. 手动 E2E 两场景（闪断无感 / 长断 reload 恢复）通过
4. 本地模式零回归：本地开放模式（不走 auth）启动链、重连、terminal 逐一手动确认——本地模式无 P2 回放能力是预期行为（spec §九），验证不引入回归即可
5. `npm run lint` + pre-commit 全过
