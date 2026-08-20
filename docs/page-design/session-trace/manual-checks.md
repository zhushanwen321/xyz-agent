# Session Trace 手工验收记录（manual gate 输入）

> 供 `scripts/cw/manual-gate.sh <unit> <ids>` 读取。每条勾选后必须附一行验证记录（日期 + 现象摘要），否则 gate FAIL。

## trace-ext

- [ ] P2: resume 链路 reason 值与留痕落盘时序（本地 pi CLI `--mode rpc --extension` 实测 resume 场景）
  - 记录：

## trace-runtime

- [x] P1 附注: RPC 录制 fixture 来源 session 说明（3 个真实 session 的路径与特征）
  - 记录：2026-08-20 三 session 均来自 core fixture（真实 session 复制脱敏 + 等结构合成）：①`real-mixed-kinds.jsonl`（124 行，custom×44/custom_message/model_change/id-less session_info 侧支）②`synthetic-compaction-single.jsonl`（compaction firstKeptEntryId）③`real-fork-header.jsonl`（fork header parentSession=源 sessionId fallback）。录制命令 `node packages/runtime/scripts/record-get-entries-fixtures.mjs`（pi 0.84.1 二进制真实 get_entries，隔离 PI_CODING_AGENT_DIR）；parity 3/3 diff 为空，详见 `docs/page-design/session-trace/probe-results.md` P1 节。
- [ ] P3: 四类 append（message/compaction/bash/appendEntry）后触发事件到达且 since 拉取完整；get_entries 超大 session 耗时记录
  - 记录：机制层已机器验证（A33 测试全绿，含四类触发 + lifecycle 补拉）；dev app 真实事件流时序待实测

## trace-ui

- [ ] V1: 真实编码任务 session（>20 工具调用 + 手动 /compact）trace 齐全、compaction 详情可下钻、影子化与 buildContextEntries 核算一致
  - 记录：
- [ ] V3: session 中切模型/切 thinking level/重命名各一次 -> LIFECYCLE 三行可见且字段正确（对话流不可见, 对照 F4）
  - 记录：
- [ ] V4: Trace 视图开着发消息实时追加；自动 compaction 影子化即时重排；切视图状态保留
  - 记录：
- [ ] V5: >2000 entry 历史 session 首屏 <1s、滚动流畅、过滤搜索可用（P5 性能基线）
  - 记录：
- [ ] V6: fork session parentSession 跳转定位；handoff_marker/session_end 行可见；drawer inspector 返回复原（split 功能已于 2026-07-24 从 app 移除，该子句跳过）
  - 记录：

## trace-ext / trace-i18n 补充

- [ ] V2: system prompt 变更 SYSTEM v2 (reason=change) + resume 链路行为符合 P2 实测断言
  - 记录：
- [ ] V7: 坏 JSON 行容错；未落盘空态；禁用留痕 extension 降级 + 现取通道可用
  - 记录：
