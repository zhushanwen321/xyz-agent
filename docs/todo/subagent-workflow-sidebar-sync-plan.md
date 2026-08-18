# subagent/workflow 侧边栏状态同步 — 开发计划

> **一句话结论**：把设计文档（`subagent-workflow-sidebar-sync-design.md` v4）的 M0-M3 展开为 7 个阶段（P0-P6），每阶段「开发内容（文件级）+ 单测 + E2E real 验证（启动真实 pi）+ DoD」；P0 探针先行消解全部未验证前提，P1/P2 可并行，P5 与 P3/P4 可并行。

<!-- 层声明：本计划是设计文档的下一层（实现计划），文件级任务 + 可执行验证步骤，不再展开函数实现。 -->

## 0. 总览与依赖

| 阶段 | 内容 | 依赖 | 交付设计文档的什么 |
|------|------|------|------------------|
| P0 | 探针 A5/A7/A8/A10（可重复执行的脚本 + 结论回写设计 §11） | 无 | 消解 A5/A7/A8/A10 前提，锁定 A10 信号形态（A6 大文件性能探针在 P2 落地） |
| P1 | 协议 + core/renderer 信号消费（U1） | P0（A5 定重试参数） | 决策 2 的 renderer 半 |
| P2 | 三个对账点（U2） | 无（可与 P1 并行） | 决策 3 |
| P3 | runtime 无状态化（U3a） | P1 | 决策 1/2 的 runtime 半 |
| P4 | extractor 投影 + SubagentStatus 枚举（U3b） | P3（广播已信号化） | 决策 5 |
| P5 | extension 修复（U4） | P0（A8/A10） | 决策 6 + 轻量信号（若 A10 选 a） |
| P6 | 全链路验收（设计 §8 的 8 场景） | P1-P5 | 验收关闭 |

每个阶段的 git 粒度：阶段内按单元 commit，每 commit 过 pre-commit（全量修复，禁 SKIP）。

## 1. E2E real 测试的两种形态（全计划通用）

本项目 E2E real 有两个既有先例，按被测面选择：

**形态 A — Playwright real 轨**（断言含 UI 时用，范式见 `docs/testing/11-real-e2e-specs.md` §4）：

```
前置：real renderer bundle 需手动构建（VITE_MOCK 不传），与 mock bundle 输出冲突分批跑
      （global-setup 检测到缺失时 build 的是 mock bundle → real spec 全挂，§3）
① makePresetDataDir()：临时 dataDir + pi 配置（models.json/settings.json）
   + npm extension 目录 + 分支源码 symlink（extension 必须分支优先，§5.1）
   （注：makePresetDataDir 是各 spec 私有复制函数，新 spec 复制既有实现 ~50 行；
   依赖本机 DEV_PI_AGENT 配置与可用 provider key）
② launchRealApp({dataDir}) + waitForRuntime + waitForExtensionsReady
   —— e2e/fixtures/launch-app-real.ts。关键：runtime ready（runtime.port 出现）≠ extension
   就绪；session.create 前必须调 waitForExtensionsReady（runtime 日志 "resolved N extensions"
   N≥8，90s 超时），否则 mandatory npm install（~16s）竞态导致 pi --extension 列表空 →
   LLM 无 subagent/workflow tool → 强引导必然 skip（§5.3/§7）
③ WS session.create（cwd=临时 sample-project，绕过 OS dialog）
④ 开第二 WS 连接监听广播（先 listen 再发 prompt，防 broadcast 时序竞争）
⑤ WS message.send 强引导 prompt（明确「必须调用 subagent tool」）
⑥ 轮询目标事件 / DOM（120s deadline）→ LLM 未按引导 → test.skip + /tmp diag 落盘
⑦ 断言真实表面：WS 广播帧 / pi 产物文件（主 JSONL、sidecar、state 文件）/ data-testid DOM
```

**进程定位消歧（kill/断言子进程时必须）**：dev 模式 runtime 命令行与并行 dev app 的 runtime 同构，`pgrep -f` 必须带 E2E 实例特征——runtime 用 `--port=<waitForRuntime 读到的端口>`，pi 用 E2E dataDir/session-dir 路径匹配；禁宽泛 pkill（AGENTS.md 进程终止精度规则）。runtime 每次重启重新生成 WS auth token——重启后第二 WS 重连需重读 `runtime.port`/`runtime-token` 再连。

**形态 B — verify-*.sh 隔离脚本**（只测 runtime↔pi 链路、不涉 UI 时用，范式见 `scripts/verify-lifecycle-e2e.sh`）：tsx 源码直跑隔离 runtime（随机端口 + 独立 `XYZ_AGENT_DATA_DIR`）+ 真实 fixture，行首 `XX PASS/FAIL` 标记输出，失败保留现场。

**pi CLI 直连**（extension 单包验证用，AGENTS.md 指南）：

```bash
pi --mode rpc --session-dir /tmp/probe-sessions \
   --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve \
   --extension <extensions/subagent-workflow 打包产物或 dev-link 路径> \
   <<< '<jsonl prompt>'
# 探针/单包验证的标准形态；XYZ_AGENT_DEBUG=1 看 <getPiAgentDir()>/logs/ 扩展日志
```

通用约束（全部阶段适用）：观测路径从 `getDataDir()`/`getPiAgentDir()` 动态推导（禁写死绝对路径）；LLM 相关断言 deadline 120s + flaky skip 一次重跑；运行命令全部从对应子包目录跑（vitest cwd 敏感）。

## 2. P0 — 探针验证（M0，不改产品代码）

### 开发内容

新建 `scripts/probe/subagent-sync-probes.sh`（形态 B），内含 4 个子探针，各自输出 `PROBE-A5 PASS/FAIL` 等行首标记：

- **A5 toolResult entry 时序**：pi CLI 起 subagent start（stdin JSONL 发「调用 subagent tool 启动一个后台任务」）；第二进程 tail -F 主 JSONL，在 tool_execution_end 事件到达的同一时刻检查 toolResult entry 是否已落盘（事件到达 = pi stdout 出现该事件行）。
- **A7 pi 版本一致性**：runtime 捆绑 `@earendil-works/pi-coding-agent` 0.84.1 ≠ 已核 dist 0.84.0，直接对捆绑版本重跑 A1（appendFileSync 探针：grep 捆绑 dist 源码确认 `_appendEntry` 同步写）+ A2（emit→persist 顺序）。
- **A8 无 turn 注入**：pi CLI 空闲态注入不带 `triggerTurn` 的 custom_message——经**最小测试 extension**（node 进程内调 `pi.sendMessage`；pi RPC stdin 命令集无 sendMessage 命令，外部注入通道不存在），断言：entry 落盘 ✓、收到 `message_start` 事件 ✓、**无 agent_start/turn 活动**（60s 观察窗）。
- **A10 秒级信号选型**：
  - 候选 a：测试 extension 在终态转换点发 `{customType:'subagent-state-changed', display:false}`（无 triggerTurn）→ 验证 runtime 侧能收到 message_start 事件、且该消息**不进 LLM 下一 turn 的上下文**（检查下一 turn 的 message entry 不含它；若进上下文，记录 token 代价并评级）。
  - 候选 b：验证 background subagent 结束时 `subagent.stream_delta` 终止帧（lines:undefined）必然到达 runtime——两步：① pi CLI 直连跑真实 subagent，grep pi stdout JSONL 确认终止帧必然发出（streamSink 在 RPC 模式恒注入）；② 形态 B 隔离 runtime 挂探针日志于 event-adapter 的 stream 终止帧解析点（`event-adapter.ts:303-304`），确认帧到达 interpreter。
  - 产出裁决：a/b/退化（都不可用则 UI 走窗口 + 对账，正确性不变）。

### 验证（本阶段产出即验证）

- 每个子探针跑 ≥3 次求稳定（时序类探针 A5/A10b 尤其）。
- 结论回写设计文档 §11 探针表（✅/⛔ + 实测数据），P1/P5 据此定参数。

### DoD

4 个探针全部有确定性结论；A10 有裁决（a/b/退化三选一）；结论已回写设计文档；探针脚本入库 `scripts/probe/`（后续回归可用）。

## 3. P1 — 协议 + core/renderer 信号消费（U1）

### 开发内容

| 文件 | 改动 |
|------|------|
| `packages/shared/src/protocol.ts` | 新增 `session.subagentsChanged`（payload `{sessionId, kind:'started'\|'notify'\|'terminal'}`）；`session.getSubagents` reply 形状与 push 类型解耦（独立定义，不再复用 `ServerMessageMap['session.subagents']`） |
| `packages/core/src/coordination/route-inbound.ts` | ROUTE_TABLE 增 `session.subagentsChanged` → `effects.onSubagentsChanged(sid, kind)`；InboundEffects 接口更新 |
| `packages/renderer/src/composables/effects/useMessageEffects.ts` | 实现 `onSubagentsChanged` → `subagentStore.triggerSubagentReload` |
| `packages/renderer/src/stores/subagent.ts` | 新增 `triggerSubagentReload(sid, kind)`：立即 `loadSubagents`；`kind==='started'` 且结果为空 → 500ms 重试一次（对齐 workflow `RUNNING_RETRY_MS` 模式；重试参数按 P0-A5 结论调整）。**承接设计 §11「边界」**：`loadSubagents` 加空结果守卫——RPC 成功返回 `[]` 且当前分区非空时**不覆盖**（记 warn 日志），防 extractor 读取失败（catch 返回 `[]`）瞬时清空历史列表；RPC 抛错路径维持现状 loadError 语义 |

此阶段 runtime 尚未发新信号（P3 才改）——renderer 先就位，M1 过渡期靠 P2 对账点即可收敛。

**明确放弃 mock E2E spec**：mock 层现状仅 ping→pong（`mock/mock-ws.ts` 不灌业务数据），服务端帧注入需扩展 `api/mock/`（侵入大且波及全部既有 mock 轨 spec）；P1 的信号消费验证由集成测试覆盖（下），real 链路由 P3 的 real E2E 覆盖，不值得为过渡态扩 mock 层。

### 验证

**单测（vitest，renderer 目录跑）**：
- `subagent.ts` store：triggerSubagentReload 触发 loadSubagents（vi.mock api）；started+空结果 → fake timers 推进 500ms → 二次拉取；notify → 不重试；RPC 抛错 → loadError + 分区保留；**RPC 成功返回 [] 且分区非空 → 不覆盖**（设计边界承接的断言）。
- `route-inbound`（core）：session.subagentsChanged 帧 → effects 回调收到 (sid, kind)；带 seq 的 gap 语义不破坏既有用例。

**集成（renderer，@vue/test-utils）**：mount `SubagentList` → 直调 `useMessageEffects` 的 `onSubagentsChanged` 回调（注入 mock api 返回）→ 断言列表刷新后的 DOM testid（使用者视角，TEST-STRATEGY §3 规则 1）。

### DoD

上述单测/集成/mock E2E 全绿；typecheck（`pnpm --filter @xyz-agent/frontend run typecheck` + runtime tsc）通过；`session.subagents` 旧类型仍共存（删除在 P3）。

## 4. P2 — 三个对账点（U2）

### 开发内容

| 位置 | 改动 |
|------|------|
| `packages/renderer/src/composables/effects/useMessageEffects.ts` | `handleMessageComplete` 追加对账：对该 sid 触发 `subagentStore.loadSubagents` + `workflowStore.loadWorkflows`；同 sid 1s 去抖合并（防 steer turn 频繁读放大） |
| 同上 | `handleSessionExited` 追加对账（pi 死后磁盘即终局） |
| `packages/core` use-connection / renderer 装配点 | 重连成功回调：遍历 `sessionStore.list` 全量重拉 subagents+workflows（替代原 `session.subagents` stateSnapshot 恢复语义） |

### 验证

**单测**：去抖合并（fake timers：3 次 complete 1s 内 → 1 次 RPC）；exited 触发重拉；重连回调遍历全部 sid（断言 N sid 恰好各发 1 次 subagents + 1 次 workflows RPC——重连重拉是一次性遍历，无去抖参与，可与 complete 去抖分开断言）。

**A6 大文件性能探针（设计 §11 A6 落点，本阶段执行）**：fixture 用合成器生成 ≥10MB 主 session JSONL（复制真实 session 的 entry 结构：session header + N 组 toolCall/toolResult/bg-notify）；形态 B 隔离 runtime 直连计时 `getSubagents` RPC handler 全路径（readFileSync + parse + 投影前逻辑）。阈值判定：单次 >100ms → 触发设计决策 7 的 mtime+size 缓存（记入本阶段开发清单追加项）；≤100ms → 结论回写设计 §11 关闭。

**E2E real（形态 A，`e2e/subagent-reconcile-real.spec.ts`）**——本阶段核心验证，走设计 §8 场景 5+8 合并：
1. makePresetDataDir + launchRealApp + waitForExtensionsReady；session.create；强引导 prompt 启动 1 个 subagent。
2. 等 `session.subagents` 广播出现 running（第二 WS 监听）。
3. 在 subagent 运行中 `pkill -9` **runtime 子进程**（Electron/renderer 存活；PID 用 `--port=<waitForRuntime 端口>` 消歧，见 §1 消歧规则）。
4. 等 renderer 自动重启 runtime + WS 重连（重读 runtime.port/runtime-token 后第二 WS 重连成功；「runtime 日志 ready」作兜底观测）。
5. 断言：侧栏 Agents tab（data-testid）列表与磁盘 JSONL 一致（subagent 条目存在，无空列表/幻影）；日志可见重连全量重拉 RPC。
6. 通过标准：状态收敛到磁盘真相。**归因注意**：本阶段 `session.subagents` stateSnapshot 快照仍在（删除在 P3），重连后快照恢复与对账重拉并存——「纯对账收敛（零信号/零快照）」的归因由 P6 场景 8 在 P3 之后重跑关闭。

**flaky 处理**：LLM 不调 subagent tool → skip + diag（real 轨既有模式）。

### DoD

单测 + real E2E 通过；重连重拉 N sid 各恰好 1 次 RPC（单测断言）；complete 去抖 1s 窗口合并生效（单测断言）；A6 探针有结论（回写设计 §11，超阈值则缓存项已排期）。

## 5. P3 — runtime 无状态化（U3a）

### 开发内容

| 文件 | 改动 |
|------|------|
| `packages/runtime/src/services/session/event-interpreter.ts` | 删 `subagentRecords` / `pendingStartParams` / `broadcastSubagents` / `handleSubagentBgNotify` 内存更新逻辑；`handleSubagentEnd` → 广播 `session.subagentsChanged{kind:'started'}`；bg-notify → `{kind:'notify'}`；P0-A10 选定的秒级信号 → `{kind:'terminal'}`（候选 b 则挂 stream 终止帧翻译处） |
| `packages/runtime/src/infra/pi/event-adapter.ts` | （若 P0-A10 选 a）扩展轻量事件的透传：customType 识别 + 翻译为 interpreter 中间事件；候选 b 则在 stream 终止帧解析点（:303-304 附近）产出事件 |
| `packages/runtime/src/services/message-bus/message-bus.ts` | TOPIC_TABLE 增 `session.subagentsChanged: 'transient'`（**必须显式**，fallback 是 stream 违背语义）；删 STATE_TYPE_KEY_MAP 的 `session.subagents` 条目 |
| `packages/shared/src/protocol.ts` | 删 `session.subagents` push 类型（P1 已解耦 reply） |
| core/renderer | 删 route-inbound 旧条目、`useMessageEffects.handleSubagents`、`InboundEffects.onSubagents` |
| 测试改造（工作量如实估） | `runtime/test/event-interpreter-subagent-push.test.ts`（324 行 / 8 用例）**整文件作废重写**（全部围绕被删的内存态 + 全集广播）；event-interpreter 其余测试约 24 处 subagent 引用逐点改造 |

### 验证

**单测（runtime 目录跑）**：现有 event-interpreter 测试改造——subagent tool-call-end → 断言广播 `session.subagentsChanged`（不再断言全集 payload）；bg-notify → 信号；确认无 `subagentRecords` 残留（grep 断言进测试或 review 清单）。

**E2E real（形态 A，`e2e/subagent-signal-real.spec.ts`）**——设计 §8 场景 1/2/3：
- 场景 1（并发终态收敛）：强引导并行启动 2 个 subagent（「必须并行调用两次 subagent tool」）→ **本阶段只验「有界收敛」路径**（bg-notify 60s 窗口 flush → notify 信号 → 重拉；或 turn 结束对账重拉）——秒级断言依赖 P4 的 sidecar 投影（本阶段终态数据仍来自主 JSONL entry，窗口期内拉不到），移至 P4/P6 验证。
- 场景 2（列表不回退）：preset 一个含 ≥3 条历史 subagent 的 session（fixture：预写主 JSONL 含 toolCall/toolResult/bg-notify entry）→ 打开 → 再启动 1 个 → 断言 4 条全在（F1 结构性消除的直接证明）。
- 场景 3（workflow 完成）：强引导跑最小 workflow → Flows tab running → done。

**过渡症状核验**：P3 落地后 F1 不再出现（对比 P2 之前的复现）。

### DoD

runtime 不再持有 subagent 状态（grep `subagentRecords` 零命中）；单测 + real E2E 三场景通过；M1→M2 过渡窗口关闭。

## 6. P4 — extractor 四级投影 + SubagentStatus 枚举（U3b）

### 开发内容

| 文件 | 改动 |
|------|------|
| `packages/shared/src/subagent.ts`（SubagentStatus 类型定义处） | `SubagentStatus` 重定义：`streaming / waiting / done / cancelled / stopped / error`（running 拆分、closed/crashed/failed 归并；细分保留在 closedReason/error 字段） |
| `packages/runtime/src/services/session/subagent-status.ts` | `normalizeSubagentStatus` 映射表**重写**（旧输出 running/closed/crashed/failed → 新 6 态；上游变体 done/completed/success/error/canceled/crashed/active 等的归一目标是语义设计工作，编译断只能暴露类型不匹配）；连带重写 `runtime/test/subagent-status.test.ts`、`packages/shared/__tests__/subagent.test.ts` |
| `packages/runtime/src/services/session/subagent-extractor.ts` | 四级投影（设计决策 5 表格）：bg-notify entry（最权威）→ `.cancelled` → `.finalized`+子进程 JSONL 末行 → `.alive`+pid+1h 软超时（streaming/waiting 按 A10a idle 位；无则 streaming）→ 孤儿兜底（子进程 JSONL 正常收尾→done，否则 error）。sidecar 路径从 sessionFile 推导，null 时走既有 `findSubagentSessionFile` 时间戳匹配 |
| `packages/renderer/src/composables/features/chat/useBackgroundWork.ts` | `hasRunning` → 判 `streaming ∨ waiting` |
| sidebar `SubagentList` / drawer `SubagentTab` / `sessionStatus.ts` | 状态消费与视觉映射对齐 `STATUS_ICON`（同一状态语言；subagent 无 compacting/retrying 态，映射表裁剪） |

### 验证

**单测（runtime，extractor 是纯函数，测试矩阵）**：fixture 工厂生成 主 JSONL × sidecar（.finalized/.cancelled/.alive+pid 活/死/超时）× 子进程 JSONL（正常收尾/截断）的全组合投影断言（≥10 用例，含回归基线价值：孤儿不再 running）。

**单测（renderer）**：useBackgroundWork 新判定；SubagentList 各状态 testid/状态点 class 断言（观察者视角，含首屏冒烟模板）。

**集成**：mount SubagentList 全状态快照（6 态渲染正确）。

**E2E real（形态 A，`e2e/subagent-crash-real.spec.ts`）**——设计 §8 场景 7：
1. subagent running 中 `kill -9` **pi 进程**（pgrep 按 E2E dataDir/session-dir 路径消歧，见 §1）。
2. 等子进程自然结束（轮询 pid 消失）。
3. UI 重开该 session（点击侧栏 session 项或 session.restore 链路；protocol 的 session.create 无 resume 参数）。
4. 断言：该 subagent 显示 done 或 error（依子进程 JSONL 收尾），**不是 running/streaming**；无扩展补写依赖（本阶段 extension 未改也成立——投影纯 runtime 侧）。

### DoD

投影矩阵单测全绿；real E2E 场景 7 通过；sidebar 状态视觉与 session 状态语言一致（同一 STATUS_ICON 消费）。

## 7. P5 — extension 修复（U4，可与 P3/P4 并行）

### 开发内容

| 文件 | 改动 |
|------|------|
| `extensions/subagent-workflow/src/index.ts` | kill-9 恢复循环补 `await store.save(run)`（决策 6.1）；恢复通知改无 turn 注入（决策 6.2，依赖 P0-A8 结论） |
| 同上（若 P0-A10 选 a） | 轻量状态事件：终态转换点发 `{customType:'subagent-state-changed', idle 位}`（display/上下文行为按 A10a 探针结论） |

**取舍声明**：设计文档 §7.4 第三条（subagent 重建矩阵分支 4 转终态 + 补发无 turn bg-notify）是其 v2 决策 6.3 的残留表述，已被 v4 决策 6.3（extractor 投影解决，P4 实施）取代——本计划**不实施**该条，subagent 域扩展改动仅限上表两处 + 可选轻量事件。

### 验证

**三连**：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`。

**pi CLI 直连实测（AGENTS.md [MANDATORY]：extension 改动优先本地 pi CLI 实测，不经桌面）**：
1. `pi --mode rpc --session-dir /tmp/xxx --approve --extension <打包产物>` 跑一个 workflow run → `kill -9` pi → 同 session-dir 重启 pi（触发 session_start recovery）。
2. 断言：`workflow-state/<runId>.jsonl` 末行含 done/failed（6.1 生效）；pi stdout 出现 workflow-result 事件且 **60s 内无自发 agent_start**（6.2 生效）。
3. 若 A10a：断言轻量事件到达 + 不进下一 turn 上下文。

**E2E real（形态 A，`e2e/workflow-kill-recovery-real.spec.ts`）**——设计 §8 场景 4：workflow running 中 kill -9 pi → 重开 session → Flows tab 显示 failed + **无自发 LLM turn**（日志断言无用户输入前的 agent_start）。

### DoD

三连全绿 + CLI 实测 2 项断言通过 + real E2E 场景 4 通过；extension 版本 bump + changeset（PR 阶段初判 type）。

## 8. P6 — 全链路验收

### 验证（不开发新代码，跑设计 §8 全部 8 场景 + 既有回归）

**前置**：real renderer bundle 手动构建（与 mock bundle 分批，见 §1 形态 A 前置）——P6 套件全跑前必须确认，否则 global-setup 会 build mock bundle 导致 real spec 全挂。

1. **real E2E 套件全跑**：`npx playwright test e2e/subagent-*-real.spec.ts e2e/workflow-kill-recovery-real.spec.ts`（本计划新增的 4 个 spec）。其中**场景 1 的秒级断言在本阶段补齐**（P3 时只验有界收敛）：A10 信号（P3）+ sidecar 投影（P4）+ 轻量事件（P5，若选 a）全就位后，断言第一个完成的 subagent 秒级显示终态；场景 8 在 P3 后的代码上重跑，关闭「纯对账收敛（零信号/零快照）」归因（P2 遗留）。
2. **手工场景**（自动化覆盖不到的）：场景 1 的 60s 窗口尾部收敛观察（真并发 2+ subagent 等 60s+）、场景 6 链路同构 code review（grep `subagentRecords` 零命中 + 两条链路 `trigger*Reload` 对称）。
3. **dev 冒烟闸门**：`pnpm dev:smoke`。
4. **既有回归**：renderer/runtime 全量 vitest + `bash scripts/validate-runtime-bundle.sh`（涉及 runtime 打包面）。
5. **验收记录**：每场景一行结论（PASS/FAIL + 日志路径）回写本文件附录。

### DoD

8/8 场景 PASS；无回归；验收记录入档。

## 9. 风险与回退

| 风险 | 触发阶段 | 回退 |
|------|---------|------|
| A5/A10 探针否决设计前提 | P0 | started 重试提为 2 次×500ms；A10 退化为「窗口 + 对账」（正确性不变，实时性回退——设计决策 4 已预留） |
| 大 JSONL 全读超阈值（>100ms/次） | P2/P6 | extractor 加 mtime+size 跳过缓存（设计决策 7 预留）；A6 探针并入 P2 验证（≥10MB 真实 session 实测） |
| real E2E LLM flaky | P2-P6 | 既有模式：skip + diag 落盘 + 重跑一次；连续 2 次失败才判真失败 |
| SubagentStatus 枚举变更破坏消费方 | P4 | 类型收紧先行（one commit 编译断清单）→ 逐消费方迁移；P4 独立 commit 可 revert |
| kill runtime 的 E2E 与 dev app 端口冲突 | P2 | 形态 A 全部走 launchRealApp 隔离 dataDir + 随机端口，不碰 dev（AGENTS.md 1420/3310 坑） |

## 10. 阶段顺序与并行

```
P0 ──→ P1 ──┐
  │         ├──→ P3 ──→ P4 ──┐
  └──→ P2 ──┘                ├──→ P6
  └──→ P5 ────────────────────┘
```

P1/P2 并行（renderer 内不同文件面）；P5 独立 npm 包可与 P3/P4 并行；P6 收口。

## 附录：验收记录（P6 回填）

（待 P6 填写）
