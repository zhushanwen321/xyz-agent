# Session Trace 实现计划（cw-cli 2.0 执行层）

> 上游设计：[`design.md`](./design.md)（技术方案层，已过对抗式审查）。本文是下一层——把设计 §5 的 5 个单元落到 cw 2.0 的 unit / spec / 验收命令映射，补齐「机器可执行验收」这层缺口。层声明：本文 = 实现计划（任务拆分 + 可执行验收 + 依赖排序），不重复方案论证。

## 1. cw 树结构

根 unit `session-trace`（brief = design.md 路径），5 个子 unit（cw 2.0 深度上限 = 根 + 叶，正好两层）：

| cw unit id | 设计 §5 单元 | 依赖 | 测试框架 / testCwd |
|---|---|---|---|
| `trace-ext` | 1 留痕 extension | 无 | vitest，`extensions/system-prompt-trace/` |
| `trace-core` | 2 core 纯函数 | 无 | vitest，`packages/core/` |
| `trace-runtime` | 3 runtime 端口 | `trace-core`（复用其类型/边界函数） | vitest，`packages/runtime/` |
| `trace-ui` | 4 TraceView + inspector | `trace-core` + `trace-runtime` | vitest，`packages/renderer/` |
| `trace-i18n` | 5 i18n + 边界文案 | `trace-ui` | vitest，`packages/renderer/` |

执行顺序：`trace-ext` ∥ `trace-core` 先行（互不依赖），随后 `trace-runtime` → `trace-ui` → `trace-i18n`。每个 unit 独立走 spec → spec-review → build → verify → exec-review。

## 2. 验收映射原则（V1~V7 → 机器验收）

设计 V1~V7 是 dev app 手工场景。cw 验收分两类：

- **机器验收（入 spec.json）**：vitest 单元/集成测试 + fixture 驱动的真实数据核算（用真实 session JSONL 副本做 fixture，不经 mock 转换层——满足「真实数据、非 mock 投影」精神）。验收 id 以词边界嵌进测试 fullName（`describe("A1 ...")`）。
- **手工验收（type: manual，core: false）**：需要活 Electron + 真实 pi 进程交互的场景（V4 实时追加体感、V6 跳转交互、V7 禁用降级路径），command 指向记录脚本：脚本读 `docs/page-design/session-trace/manual-checks.md` 中的勾选状态并校验非空。dev app 逐项验证后人工勾选。

### 2.1 `trace-ext` spec（验收 A11~A13）

| id | type | 场景 | command |
|---|---|---|---|
| A11 | unit | mock extension API：首个 turn_start 按 SessionStartEvent.reason 写 initial/resume entry；hash 相同不重写；变化写 change 且 diffSummary 生成。reason 5 值→initial/resume/fork 的落盘映射由 P2 实测断言后固化 | `pnpm install --prefer-offline --frozen-lockfile > /dev/null 2>&1 && pnpm -C extensions/system-prompt-trace exec vitest run` |
| A12 | unit | 跨重启 hash 基线恢复：进程内 resume 走 targetSessionFile 直读；app 重启 spawn 走自持久化小文件；两者都读不到时 resume 必写一条 | 同上（同一 command，fullName 区分） |
| A13 | manual | 探针 P2：本地 pi CLI 实测 resume 链路 reason 值 + 落盘时序 | `bash scripts/cw/manual-gate.sh trace-ext P2` |

### 2.2 `trace-core` spec（A21~A24）

| id | type | 场景 | command |
|---|---|---|---|
| A21 | unit | entry→TraceRow kind 映射全覆盖（§3.4 表 12 种 kind + 损坏行） | `pnpm install --prefer-offline --frozen-lockfile > /dev/null 2>&1 && pnpm --filter @xyz-agent/core exec vitest run session-trace` |
| A22 | unit | context 边界计算 = buildContextEntries 语义（fixture：无压缩 / 单次 / 多次压缩 / branch_summary 四场景，与 pi 源码同 JSONL 双边核算，即探针 P4） | 同上 |
| A23 | unit | 影子化标记 + 「仅当前 context」过滤态 + kind chips 分组过滤 | 同上 |
| A24 | integration | 探针 P1：RPC 产物（get_entries 真实录制 JSON，fixture 在 runtime 侧录制）与文件直读产物对同一 session 的 SessionEntry 序列逐条 diff = 空（3 个真实 session） | `pnpm --filter @xyz-agent/runtime run test trace-parity` |

A24 原计划放 trace-core，因 RPC 录制 fixture 产生于 runtime 侧，移至 trace-runtime（plan 修订，spec 未冻结期调整）。

### 2.3 `trace-runtime` spec（A31~A34）

| id | type | 场景 | command |
|---|---|---|---|
| A31 | integration | `session.getTraceEntries` 端口：路径 A（活跃，mock RPC 层之上——mockFidelityNote：仅 mock WS/RPC 传输，pi 返回值用真实录制 fixture）路由 + header 首行补读 | `pnpm --filter @xyz-agent/runtime run test session-trace` |
| A32 | integration | 路径 B（非活跃文件直读）：JSONL + sidecar 合并 + 损坏行容错 + session 未落盘空态 | 同上 |
| A33 | integration | 增量腿：事件触发（message_end/compaction_end/agent_settled/entry_appended）→ `get_entries(since=lastLeafId)` 拉取 → WS `session.traceEntryAppended`（含 sessionId）；lifecycle RPC 成功后主动触发补拉 | 同上 |
| A34 | manual | 探针 P3：实测四类 append 的事件流 + since 拉取完整性（本地 pi CLI） | `bash scripts/cw/manual-gate.sh trace-runtime P3` |

### 2.4 `trace-ui` spec（A41~A45）

| id | type | 场景 | command |
|---|---|---|---|
| A41 | unit | per-session trace store（ADR-0049 useSessionScopedState 分区）：加载/增量/过滤/选中 per-pane 隔离，切 session 不串 | `pnpm --filter @xyz-agent/frontend run test session-trace` |
| A42 | unit | SegmentedTab「对话 | Trace」per-pane 视图状态：切换不重建数据、状态保留 | 同上 |
| A43 | unit | 行组件渲染：12 种 kind 行摘要 + 影子化降透明 + 选中态（surface-hover + 强调字色，无 ring）；>500 虚拟滚动启用 | 同上 |
| A44 | unit | drawer inspector 联动：选中切入临时页 / 返回复原前 tab / 未开自动打开（单向 main→drawer） | 同上 |
| A45 | manual | V1/V3/V4/V5/V6 dev app 手工场景（真实 compaction、lifecycle 行、实时追加、2000+ entry、fork 跳转、split 对照），含 P5 性能基线 | `bash scripts/cw/manual-gate.sh trace-ui V1,V3,V4,V5,V6` |

### 2.5 `trace-i18n` spec（A51）

| id | type | 场景 | command |
|---|---|---|---|
| A51 | unit | zh-CN/en-US 文案键全存在且被引用；空态/损坏行/降级/SYSTEM 无留痕四类边界文案 | `pnpm --filter @xyz-agent/frontend test -- trace-i18n` |

### 2.6 手工 gate 机制

`scripts/cw/manual-gate.sh <unit> <ids>`：读 `docs/page-design/session-trace/manual-checks.md` 中对应条目（格式 `- [ ] P2: ...`），全部勾选（`- [x]`）且附一行验证记录（日期 + 现象）则输出 `<id> PASS`，否则 FAIL。dev app 验证由开发者/AI 用 Playwright 连 9222 逐项执行后勾选。这是 V 系列验收进入 cw 证据链的唯一通道，防止「文档写了就算过」。

## 3. fixture 策略（真实数据，非 mock 投影）

- `packages/core/src/domain/session-trace/__fixtures__/`：从 `~/.xyz-agent/pi/sessions/` 挑 3 个真实 session 复制脱敏（含一次 compaction 的、含 model_change/label 的、fork 过的），加一个手工注入坏行的副本（V7 前置）。fixture 入 git（测试可重跑）。
- RPC 录制：`trace-runtime/__tests__/__fixtures__/get-entries-<n>.json` = 本地 pi CLI 对同 3 个 session 真实 `get_entries` 调用的响应录制（探针 P1/P3 的执行产物同时是测试 fixture，一鱼两吃）。
- 探针执行记录落 `docs/page-design/session-trace/probe-results.md`（P1~P5 各一节：命令、输出摘要、结论）。

## 4. 风险与回退

- **P1 不一致**（RPC vs 文件直读序列 diff 非空）→ A1 决策重审，升级为设计层 replan（新 cw unit 处理归一化差异）。
- **`get_entries` 超大 session 超时**（设计「待验证检查点」）→ P3 探针附耗时记录；超 2s 则活跃路径打开时分段拉取（runtime 端口内部改动，不影响 spec）。
- **spec gate 规则②**：全部验收 core:false + unit/integration/manual 组合，合法（规则②只约束 core:true）。
- 红 Phase：所有 unit/integration 验收须在父 commit 树上 fail（实现不存在 → 测试文件也不存在 → vitest 找不到测试即 fail，天然有区分力；测试文件与实现同 commit 提交）。

## 5. 完成定义

5 个子 unit 全部 `closed`（cw status 为准）+ 探针记录齐 + manual-checks.md 全勾 → 根 unit `session-trace` 提交 build 证据（merge 到分支的 commit）+ verify + exec-review 关闭。合并/发布走独立 merge 流程，不在本计划内。
