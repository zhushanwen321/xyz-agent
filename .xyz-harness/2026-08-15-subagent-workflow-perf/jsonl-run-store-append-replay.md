# jsonl-run-store「增量 append + 重放」是什么：概念说明

> 本文回答一个问题：针对 workflow run 状态持久化的 O(N²) 写放大，长期方案「增量 append + 重放」具体指什么、与短期方案（save 去抖节流）如何取舍。**这不是完整设计文档**——实施前需按 tech-design 方法论补全（方案对比 / 验收 / 任务拆分）。

## 1. 现状：rewrite 模式（问题来源）

`orchestration/jsonl-run-store.ts:242-273` 的 `save(run)` 是**快照覆盖写**：每次把整个 WorkflowRun 聚合根（budget + 全部 calls 数组 + 全部 trace 节点 + errorLogs + scriptResult）`serializeRun` 后一次性 `writeFile` 覆盖状态文件。调用时机是**每个 agent-call 完成**（`error-recovery.ts:302/354/376/425`、`lifecycle.ts:213/269/328/377`）。

后果：N 个 call 的 workflow，第 k 次 save 的序列化量 ∝ k，累计写入量 O(N²)。review-fix-loop 这类数百 call 的长 workflow，尾部每次 call 的落盘延迟线性恶化。`save()` 内每次还向父 session JSONL `appendEntry("workflow-state-link")` 一条指针，指针条目持续膨胀父 session 文件，又反过来加重 `loadAll` 的扫描成本。

## 2. 增量 append + 重放的概念

核心思想：**把「状态」的持久化从快照式改为事件流式**——与 pi 自身的 session JSONL、subagent record 的 identity + 消息追加是同一个模式：

```
现状（rewrite）                     增量 append + 重放
─────────────────────               ─────────────────────
save(k)   = 全量快照[1..k]          save     = append 一条事件（如 call-7 完成 + patch 数据）
save(k+1) = 全量快照[1..k+1]        load     = 顺序重放全部事件 → 内存重建聚合根
单次写 O(k)，累计 O(N²)             单次写 O(1)，累计 O(N)；load O(N) 一次性
```

要素：

1. **事件 entry 设计**：每次状态变化 append 一行 JSONL——`run-created`（含初始配置）、`call-started`、`call-completed`（含 result/trace patch）、`run-transition`（状态机翻转）等。事件粒度对齐现有 `trace.update` 的 patch 字段（status/result/error/completedAt/sessionId）。
2. **重放（replay）**：`loadAll()` 从「读快照文件」变为「读事件流 + 按序 apply 到空的 WorkflowRun」。需要幂等 apply（同一事件重放两次结果不变）以容错截断的最后一行（写入中途崩溃）。
3. **快照切换（compaction）**：事件文件不能无限增长——达到阈值（如事件数或字节数）后把当前聚合根写成一次新快照 + 截断事件流（或滚动新文件）。这与 pi session 的 compaction、subagent sessions 的 GC 同构。

## 3. 与短期方案（save 去抖节流）的取舍

| 维度 | 去抖节流（短期） | 增量 append + 重放（长期） |
|---|---|---|
| 改动面 | save 调用点加 100-250ms 合并（终态同步 flush）+ 指针只在创建/终态写 | 持久化格式演进（新版本字段）+ 重放引擎 + compaction |
| 写放大 | 降低写**次数**，单次仍 O(k) 全量序列化（尾部 call 的尖峰延迟仍在，只是频率降低） | 根除：单次写 O(1) |
| 崩溃恢复 | 去抖窗口内崩溃丢最后一段状态（终态有 flush 兜底） | 事件粒度恢复，最多丢截断的最后一行 |
| 复杂度/风险 | 低，无格式变更 | 中：重放正确性（乱序/重复/旧版本事件）、compaction 与运行中 save 的竞态、向后兼容（旧快照文件的迁移或共存） |
| 判定 | 立即可做的止血 | 架构上正确归位（事件溯源），在 review-fix-loop 数百 call 场景成为常态后再值得投入 |

**建议路径**：先做去抖节流（消除 90% 的写次数与指针膨胀），把增量 append + 重放留到有真实的长 workflow 延迟投诉或去抖后仍有可感知尖峰时再做完整设计。两者的关系是**演进**而非二选一：节流方案的指针修复（workflow-state-link 只写创建/终态）与事件流方案的事件设计可以共享对「什么状态变化值得持久化」的分析。

## 4. 实施前需要回答的设计问题（完整设计的输入）

1. 事件 schema 的版本化与旧快照迁移（现状 D-5 决策：版本不匹配返回空——事件流需明确共存还是迁移）
2. 并发：多个 agent-call 并发完成时事件的串行化点（现有 acquireActivateLock 模式可否复用）
3. compaction 阈值与运行中 workflow 的快照切换时机（idle 窗口？终态时？）
4. `workflow-state-link` 指针与事件文件的关系（指针仍指向文件路径，loadAll 逻辑不变）
5. 重放性能：数百 call 的 run 重放是否需要在 sessions-index 类持久化层做缓存（与 sessions-index-design.md 的决策联动）
