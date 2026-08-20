# Session Trace 探针执行记录（design.md 探针清单）

> 各探针的断言、方法、状态定义见 [design.md](./design.md)「探针清单」。本文件记录执行命令、输出摘要与结论。

## P1：路径 A（RPC get_entries）与路径 B（文件直读）SessionEntry 序列逐条一致 ✅

- **执行日期**：2026-08-20（trace-runtime 单元交付时）
- **执行方式**：录制脚本 `packages/runtime/scripts/record-get-entries-fixtures.mjs` 用本地 pi CLI
  （workspace 缓存二进制 0.84.1，与 `@earendil-works/pi-coding-agent` 锁定版本一致）对 3 个
  session 文件真实调用 `get_entries`（`switch_session` 加载 → `get_entries`，全程无 prompt 零
  LLM 调用），录制响应 + pi 落盘文件到
  `packages/runtime/src/services/session/__tests__/__fixtures__/get-entries-*.json|.jsonl`。
- **3 个 session**：
  1. `real-mixed-kinds`（真实 session 脱敏，124 行：custom×44 / custom_message / model_change / id-less session_info 侧支）→ RPC 123 entries
  2. `synthetic-compaction-single`（compaction firstKeptEntryId + model_change）→ RPC 11 entries
  3. `real-fork-header`（fork header parentSession=源 sessionId fallback 形态）→ RPC 3 entries
- **parity 结果**：逐条 deep-equal diff = **空**（3/3）。机器验收固化在
  `trace-parity.test.ts`（A24），单测 fullName 含 `A24`。
- **附加不变量**（同测试断言）：录制文件无坏行（防「pi 静默跳坏行造成假 parity」）；leafId =
  文件末条带 id entry 的 id（线性链语义）；合计 entry 数 ≥ 100（防 fixture 玩具化）。
- **录制隔离**：`PI_CODING_AGENT_DIR` 指向临时空目录 + 剥离宿主 `PI_*` 环境变量。踩坑记录：
  ① 宿主 pi 会话的 `PI_MODEL` 泄漏给嵌套 pi 导致模型 ambiguous 报错；② 用户 extension 在
  session 启动时写 custom entry（unified-hooks:loaded 等）污染录制产物——两者都必须隔离。
- **已知固定差异**（不破坏 parity，RPC 与文件同时包含）：header.cwd 改写到临时工作区（源是
  脱敏假路径，pi `assertSessionCwdExists` 拒载）；pi resume 追加 1 条 thinking_level_change
  （无历史 thinking level 时应用默认档，真实 pi 行为）。
- **结论**：A1 混合数据通路决策成立，无需 design replan。

## P3：四类 append 后触发事件到达 + since 拉取完整（A34，manual gate）⏳

- **机制层已机器验证**（`session-trace.test.ts` A33 全绿）：message_end / agent_settled /
  entry_appended / compaction_end 四类触发事件 → onTraceSync → `get_entries(since=基线)` →
  `session.traceEntryAppended` 广播（含 sessionId）；lifecycle RPC（set_model /
  set_thinking_level）成功后主动补拉。
- **待人工实测**（dev app + 真实 pi 进程，manual-checks.md `P3` 条目勾选后过 A34 gate）：
  真实四类操作的事件流到达时序 + 追赶式拉取在流式期间的完整性 + get_entries 超大 session
  耗时记录（fixture 录制实测参考：124 行 session 全量 get_entries 往返 ~230ms，见
  `get-entries-*.json` 的 `__elapsedMs`）。

## P2 / P4 / P5

- P2（resume 链路 reason 值）：trace-ext 单元负责，见该单元记录。
- P4（context 边界纯函数 vs pi buildContextEntries）：trace-core 单元负责
  （`packages/core/src/domain/session-trace/__tests__/context-boundary.test.ts` 已落）。
- P5（2000+ entry 首屏渲染）：trace-ui 单元 V5 验收时记录。
