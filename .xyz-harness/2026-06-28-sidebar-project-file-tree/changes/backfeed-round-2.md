# 反哺 Round 2 — ④NFR → 上游

> ④NFR Step 6b 反哺检查产物。本轮正向追踪（5 个 fresh subagent）发现 1 处需反哺上游的架构约束冲突（K-9），已落地。

## 反哺条目

### K-9: AC-3.11 跨 store 失效机制违反 stores 间禁止 import 硬约束

**发现阶段**: ④NFR 正向追踪（前端渲染簇 fresh subagent，源码实证）
**发现人**: fresh subagent（独立 context，非主 agent 自证）
**类型**: 架构约束冲突（非决策推翻，K 级）

**问题**:
- ③issues.md AC-3.11 原措辞：「fileTree store subscribe chat store 的 file_changes ready 事件」
- 源码实证：`stores/sidebar.ts:5` + `stores/chat.ts:3` 明文「依赖方向：无（stores 间禁止互相 import）」
- 现有跨 store 编排全在 composables/features 层：`useSidebar.ts:101-106` 注入 5 个 store 编排；`useChat.ts:69-70` 注入 chat+session
- file_changes 事件入口：`chat-chunk-processor.ts:347` `case 'message.file_changes'` → 调 `chat store.applyFileChanges`，根本不经 fileTree store
- → ③AC-3.11「store subscribe store」字面违反硬约束，⑤骨架按此实现会撞约束

**反哺动作**:

| 上游文件 | 修改内容 |
|---------|---------|
| ③issues.md AC-3.11 | 措辞修正：「fileTree store subscribe chat store」→「composable 层（useFileTree）编排跨 store 失效触发（watch chat store 的 file_changes ready 事件 + 派发 fileTree store 的 invalidate 接口）」。附 `[BACKFED from ④NFR K-9]` 标注 + 约束证据 |
| ③issues.md frontmatter | `backfed_from: []` → `backfed_from: [nfr]` |
| ③issues.md Step 6b 反哺记录 | 追加 K-9 条目 |
| ②architecture §7 stores/fileTree.ts | 职责从「监听 file_changes ready 帧」改为「暴露 invalidate(sessionId, paths) 接口供 composable 派发」 |
| ②architecture §7 composables/useFileTree.ts | 增加「编排跨 store 失效触发（watch chat store file_changes + 派发 fileTree invalidate）」职责，LOC ~80→~90 |
| ②architecture §10 D-017 | 决策补充「失效触发编排位置在 composable 层，非 store 层」 |
| ②architecture frontmatter | `backfed_from: [issues]` → `backfed_from: [issues, nfr]` |
| ④non-functional-design.md #3 并发 | 补 K-9 约束冲突说明；缓解项「ready 帧跨 store 失效时序」去向为⑤骨架验证（composable 层实现位置） |

**非 D-不可逆**：K-9 是机制措辞/编排位置修正（源码实证驱动），非用户已拍板决策的推翻，无需 ask_user。

## 无反哺的 gap（全在 ⑤/⑥ 消化）

其余 F-1/F-2/K-1~K-8/K-10（K-9 外）/D-1~D-10 均为 NFR 分析覆盖完整性补强，缓解项回灌到 ⑤test-matrix（NFR-AC）/ ⑤骨架（骨架约束）/ ⑥独立 perf Wave，不触发上游修订。D-001~D-020 全部 confirmed 决策无下游证据推翻。

## 闭环验证

- ③issues.md AC-3.11 措辞已修正（grep 验证：无「store subscribe chat store」残留）
- ②architecture §7/§10 D-017 已同步（composable 层编排）
- ④non-functional-design.md K-9 已记录（#3 并发维度 + 缓解表 + Step 6b）
- 三方 frontmatter backfed_from 标注一致（②[nfr]、③[nfr]、④无下游）
