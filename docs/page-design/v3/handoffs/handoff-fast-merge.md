# Handoff · fast-merge · 多分支差异聚合（待开工型 · spec 已立，待实现）

> 痛点2 主线。设计阶段已完成（spec 已立，架构经两轮 subagent 验证修正）。
> **强依赖痛点1**：parentSession + forkEntryId 基础层必须先完成。
> 接手者读本文 + `../fast-merge/spec.md` + `../fast-fork/spec.md`（§8.1 基础层）即可开工。

## 1. 路径

- 目录：`v3/fast-merge/`
- 文件：`spec.md`（✅ 设计规范 SSOT，B+C+F 三件套架构）
- 层级：L2 跨区联动 + Extension · 跨 runtime + extension + 前端三区
- 配套 draft：待做（交互形态复用 fast-fork composer 贴入 + 反馈行范式）

## 2. 方案演进（接手者必读，避免走废弃路径）

本 spec 经过两轮 subagent 验证 + 用户多轮纠偏，**排除了多个错误方案**，最终锁定 B+C+F 三件套。实现时不要再尝试以下路径（都已验证不可行或被否决）：

| 废弃方案 | 否决原因 |
|---|---|
| extension 调 generateBranchSummary | 半重组上下文 + prompt 语义不对（"被放弃分支便条" ≠ "多分支结论聚合"） |
| extension 调 completeSimple 绕过 agent loop | **放弃 pi 的 context 构建/token 管理/system prompt 基础设施，重造轮子**（用户质疑纠正） |
| runtime 自己写 summarizer | 重复 pi prompt 模板，用户否决 |
| runtime import pi | 破坏进程隔离 |
| 改 pi 加 RPC | 用户明确否决 |
| handleBridgeToolExecute 调 pi extension tool | **架构不通**（xyz-agent plugin 系统与 pi extension 是两套独立系统） |
| 原始差异贴 composer / 主线聚合原始差异 | token 爆炸 |

**锁定方案**：extension 在主线 pi 进程内，用 `setActiveTools(["structured-output"])` 锁工具集 + `before_agent_start` 注入 schema 强约束 + `turn_end` 兜底，让 pi 的 agent loop 产出结构化差异摘要。**复用 pi 的全部基础设施，只介入锁工具集**。

## 3. 要做的事情（实现 checklist）

### Step 0 · 前置：确认痛点1 基础层已完成

- [ ] `SessionSummary` 有 `parentSession` + `forkEntryId` 字段（`packages/shared/src/session.ts`）
- [ ] **active + 磁盘两条路径都回传**（验证发现磁盘链路是易遗漏的关键）：
  - active: `IManagedSessionView` + `ManagedSession` + `toSummary`（`session-service.ts:706`）
  - 磁盘: `SessionHeader`（`session-file-utils.ts:16`）+ `parseSessionHeader`（`:24`）+ `ScannedSessionMeta`（两处定义）+ `scanSessionMeta` + `scannedToSummary`（`session-scanner.ts:63`）
- [ ] JSONL header 写入 forkEntryId（`session-fork.ts:137-144` newHeader，解法 A）

### Step 1 · extension 通信 + 三件套验证（⚠️ 规则 #4，先验证再编码）

写 `tools/verify-merge-extension.cjs`，逐项验证：

- [ ] **触发链路**：runtime 发 `prompt("/merge-branches <json>")` → extension handler 执行（`agent-session.ts:1034` `_tryExecuteExtensionCommand`）
- [ ] **setActiveTools 锁工具集**：handler 内 `pi.setActiveTools(["structured-output"])`，下一 turn agent 工具列表只剩这一个（`agent-session.ts:840-855` 重建 system prompt）
- [ ] **before_agent_start 注入**：返回 `{systemPrompt: ...}` 能追加到 agent 的 system prompt（`runner.ts:1054-1057`）
- [ ] **turn_end 兜底**：检测没调 structured-output → sendUserMessage steer 重试（复用 `structured-output/index.ts:175-210` 逻辑）
- [ ] **回传链路**：extension `appendEntry` / `sendMessage` 写 custom_message → runtime event-adapter 监听到
- [ ] **工具集恢复**：merge 完成后 `setActiveTools(SAVED_TOOLS)` 恢复，try/finally 防状态泄漏

⚠️ **现有 verify 脚本的局限（必须补的实测）**：`tools/verify-merge-extension.cjs` 当前在 `--print` 模式 + `ctx.waitForIdle()` **阻塞模式**下跑（`verify-merge-extension.cjs:152-165`），handler 阻塞到全部分支跑完才 resolve。这只证明了 **pi API 能力成立**（turn_end/steer/details 捕获/工具集恢复），**没证明生产方案**（RPC 模式 handler 立即 return + 后台事件驱动）。**开工第一步**：把 verify 脚本改到 RPC 模式（pi 长驻不退出）跑一遍，验证 handler 立即 return 后 turn_end 事件驱动是否真能推进状态机（预期可行，但需实测确认）。详见 spec §4.2「验证依据（如实）」段。

⚠️ **structured-output 前置依赖**：`@zhushanwen/pi-structured-output` 非 builtin（2026-07-04 改为推荐安装），未装时 `setActiveTools(["structured-output"])` 会锁成空集（`setActiveToolsByName` 找不到 tool 静默忽略，`agent-session.ts:840-855`）→ agent 无工具死循环。verify 脚本用 mock-structured-output 绕开了这层依赖，但生产 extension 必须在 merge 入口前置检查 structured-output 是否已装（runtime `ExtensionService` 已安装清单），未装则入口 disabled + 引导安装。详见 spec §8.2。

### Step 2 · extension 读分支差异验证

- [ ] extension 无沙箱，可直接 `fs.readFileSync` 读分支 JSONL（已读 `loader.ts` 确认：extension 经 `jiti.import` 在主进程加载，**无 worker thread / 无 vm 沙箱 / 无 fs 拦截**，与主进程同权限）
- [ ] 按 forkEntryId 切片：读分支全部 entries → 找 forkEntryId 的 index → `slice(index + 1)` 得差异 entries
- [ ] 序列化差异 entries 成文本（pi message 格式 → markdown）
- [ ] **handler 同步读 N 分支的阻塞时长实测**（spec §4.2 权衡）：N=10 × 5MB 分支场景下，`branches.map(b => buildMergeInstruction(b))` 同步读 + parse 总耗时多少。若 > 1s 需切「turn_end 按需读」方案（详见 spec §4.2 末尾权衡段）

### Step 3 · extension 实现

- [ ] 新建 `xyz-merge-extension.js`（项目根）
- [ ] `registerCommand("merge-branches", { handler })`：
  - 解析 branches 参数（sessionFile + forkEntryId + name）
  - setActiveTools(["structured-output"]) + 保存 SAVED_TOOLS + ACTIVE=true
  - 串行启动每个分支的 turn（turn_end 推进下一个）
- [ ] `before_agent_start` handler：注入当前分支的差异文本 + schema 强约束
- [ ] `turn_end` handler：检测成功 → 收摘要 → 推进下一分支；全部完成 → 恢复工具集 + appendEntry('merge-result')
- [ ] 失败处理：单分支重试 2 次仍失败 → 标记失败继续下一个（不中断整批）

### Step 4-6 · extension 打包 / runtime merge-service / 前端 UI

（与原 handoff 一致，略）

## 4. 关联文档（md）

- `v3/fast-merge/spec.md` — 本单元设计 SSOT（必读，含方案演进史）
- `v3/fast-fork/spec.md` — 痛点1，§8.1 基础层是前置依赖
- `docs/page-design/design-tokens.md` — 冷蓝暗色 token SSOT
- AGENTS.md 架构约定 #5（pi 适配层）+ #11（Extension 系统）

## 5. 关联代码（pi 源码 + structured-output，实现时参照）

| 能力 | 源码位置 | 用途 |
|---|---|---|
| setActiveTools（B 件） | `pi-mono/main/packages/coding-agent/src/core/agent-session.ts:840-855` | 锁工具集 + 重建 system prompt |
| before_agent_start（C 件） | `pi-mono/main/packages/coding-agent/src/core/extensions/runner.ts:1016-1080` | 注入 schema 强约束 |
| turn_end（F 件） | `pi-mono/main/packages/coding-agent/src/core/extensions/types.ts:705-710` | 兜底检测 + steer 重试 |
| registerCommand | `pi-mono/main/packages/coding-agent/src/core/extensions/types.ts:1207` | 注册 /merge-branches slash command |
| **正面先例 plan-mode** | `pi-mono/main/packages/coding-agent/examples/extensions/plan-mode/index.ts` | 完整三件套演示（setActiveTools `:104-114` + before_agent_start `:201-247` + turn_end `:250-259`） |
| ask-user 用 setActiveTools | `xyz-pi-extensions-workspace/main/extensions/ask-user/src/index.ts:37-44` | 禁用工具的简短先例 |
| structured-output tool | `xyz-pi-extensions-workspace/main/extensions/structured-output/src/index.ts` | 复用其 tool + Ajv 校验 + turn_end steer 逻辑 |
| ExtensionContext 字段 | `pi-mono/main/packages/coding-agent/src/core/extensions/types.ts:301-339` | sessionManager / model / modelRegistry |

## 6. 关键代码现状（explorer 验证证据）

| 现状 | 文件:行号 | 改动 |
|---|---|---|
| SessionSummary 无 parentSession/forkEntryId | `packages/shared/src/session.ts:20-44` | 痛点1 基础层补 |
| session-fork.ts 只存 parentSession | `packages/runtime/src/services/session/session-fork.ts:137-144` | 痛点1 基础层补 forkEntryId |
| parseSessionHeader 不解析血缘 | `packages/runtime/src/infra/pi/session-file-utils.ts:24-35` | 痛点1 基础层补（磁盘链路） |
| structured-output 已有 tool + steer | `xyz-pi-extensions-workspace/main/extensions/structured-output/src/index.ts` | 复用，不改 |

## 7. 验收 P0

- [ ] merge 入口在有子分支时可见
- [ ] 分支选择器可勾选
- [ ] 三件套生成摘要（loading + 串行进度）
- [ ] **LLM 100% 在 pi agent loop 内**（extension 锁工具集，runtime 不碰 LLM）
- [ ] 摘要只含 forkEntryId 后差异
- [ ] 摘要符合 schema（Ajv 校验）
- [ ] N 份摘要贴入 composer 可编辑
- [ ] setActiveTools 完成后恢复（防状态泄漏）
- [ ] extension 走 builtin 打包
- [ ] **不改 pi 代码**
- [ ] **runtime 零 pi import**
- [ ] 无 token 爆炸

## 8. 测试视角（TEST-STRATEGY.md 三视角）

- **构建者（白盒）**：extension 三件套状态机（ACTIVE/SAVED_TOOLS/currentBranchIndex）、setActiveTools 切换、turn_end 串行推进
- **使用者（黑盒）**：mount merge UI，"点 merge → 选分支 → 等生成 → 看 composer 有摘要 → 编辑发送 → 看主线回复"完整旅程
- **观察者（形态）**：merge 入口位置、loading 串行进度、摘要贴入 composer 可读可编辑

**extension 验证脚本（必含）**：`tools/verify-merge-extension.cjs`，规则 #4 硬要求。

## 9. Open Questions（实现时与用户确认）

### 用户定
1. merge 入口位置（倾向侧栏分支列表头部）
2. 必须选中 vs 默认全选（倾向必须选中）
3. composer 草稿保留（倾向保留）

### 实现时验证
1. before_agent_start 注入 context 的机制（systemPrompt 追加 vs context event 独立 message）
2. 串行 N 分支 turn 推进时序
3. tool result details 捕获方式
4. extension 读分支 JSONL（fs 直接读 vs SessionManager.open）

## 10. 风险与注意事项

### 10.1 setActiveTools 状态泄漏（最高风险）

`setActiveTools` 是 session 级全局状态。merge 完成**必须恢复 SAVED_TOOLS**，否则 session 后续被锁成只有 structured-output。**必须用 try/finally**，在 `agent_end` / `session_shutdown` 等 hook 也兜底恢复。参考 plan-mode 的 restoreNormalModeTools（`plan-mode/index.ts:108`）。

### 10.2 串行 N 分支的 turn 推进时序

turn_end 里 sendUserMessage 启动下一分支 turn——需验证 pi 保证前一个 turn 完全结束后才开始下一个。如果时序不稳，可能出现工具集/状态错乱。Step 1 验证脚本必须覆盖 N=3 场景。

### 10.3 before_agent_start 是 per-agent-run 不是 per-turn

`before_agent_start` 每个 agent run 触发一次（`agent-session.ts:1134` 在 prompt 里调），不是每个 turn。串行 N 分支如果在一个 agent run 内用 steer 推进，before_agent_start 只触发一次——schema 注入可能只对第一个分支生效。**可能需要改用 turn_start 或 context event**（`types.ts:655-658`）在每个 turn 注入。这是 Step 1 验证的关键点。

### 10.4 structured-output 未装时工具集锁成空集（高，硬前置依赖）

`@zhushanwen/pi-structured-output` 在 2026-07-04 从 builtin 改为 Settings 推荐安装（架构约定 #11），用户可能未装。`setActiveToolsByName`（`agent-session.ts:840-855`）对找不到的 tool 名**静默忽略**——`setActiveTools(["structured-output"])` 在未装时会把活动工具集锁成**空数组**，agent 无任何工具可调，turn_end 兜底重试也无效（工具列表为空），状态机死循环到 MAX_BRANCHES 上限。**merge 入口必须前置检查**（runtime `ExtensionService` 已安装清单按 `@zhushanwen/pi-structured-output` 精确匹配），未装则入口 disabled + 引导安装。详见 spec §8.2。

### 10.5 RPC 模式 handler 立即 return ✅ 已验证（原高风险，已消除）

`tools/verify-merge-rpc-mode.cjs` 在 pi `--mode rpc`（长驻不退出）下实测通过：handler 立即 return（**RPC ack 延迟仅 1ms**），agent run 在后台由 turn_end 事件驱动完整推进（2 分支 5 次 turn_end + 1 次 steer 续命 + COMPLETE，30.5s）。spec §4.2 的生产方案端到端验证可行。两个验证脚本互补：`verify-merge-extension.cjs`（API 能力）+ `verify-merge-rpc-mode.cjs`（生产方案）。**剩余未覆盖**：abort 取消 + agent_end 兜底恢复（实现时补）、N>2 压力测试。

### 10.6 merge 结果回传无直接先例 + runtime 超时兜底（中，硬缺口）

原 spec 说「结果回传对齐 workflowAction」是误读——`workflowAction`（`session-service.ts:550-554`）是 fire-and-forget，pause/resume/abort 的副作用在扩展侧执行，**runtime 不收任何业务结果**，只等 `session.workflowActionDone` RPC reply（仅含 sessionId/action/runId 标识）。`handleWorkflowResult`（`event-interpreter.ts:625`）和 `handleSubagentBgNotify`（`event-interpreter.ts:575`）处理的是 workflow 进度推送和 subagent 完成通知，**不是 action 回传**。merge 的 custom_message 'merge-result' 回传需自建 handleMergeResult 分支（消费模式可参照 handleSubagentBgNotify，但语义不同）。且 handler 立即 return 后 runtime 不知何时完成，**必须配超时兜底**（建议 N × 60s/分支），超时后向前端报错 + 通知 extension 中止。详见 spec §4.4。

### 10.7 lastMergedAt 持久化未设计（中，待设计项）

原 spec 把 `lastMergedAt` 持久化当成确定方案是未经验证的假设。`SessionSummary` 是运行时聚合对象（`session-scanner.ts:40-55`），`scannedToSummary`（`:63-81`）只读 `ScannedSession` 的 7 个字段，**不读 sidecar 也不读 merge entry**。存哪 / scanner 怎么读回 / active 路径怎么注入都没有现成路径。**v1 建议降级为内存态**（runtime `IManagedSessionView` 加字段，重启丢失），先解决「同 session 内不重复合并」的基本需求；持久化作为 v2 跟进。详见 spec §5「已 merge 标记的数据层」。

## 11. 不在本 handoff 范围

- **痛点1 fork 体验**：parentSession + forkEntryId 基础层（§8.1）是独立 spec，本 handoff 只依赖其产出
- **痛点3 handoff**：共享三件套架构但是独立 spec（总结当前 session 全部 → 新建空白 session）
- **pi 代码改动**：用户明确否决
- **runtime LLM 调用 / completeSimple**：用户明确否决
