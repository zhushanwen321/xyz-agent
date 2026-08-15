# Runtime 性能优化——架构决策总览

> **一句话结论**：本次对 runtime 层（`packages/runtime/src/`）的性能分析收敛出 10 个架构决策（D1–D10），全部已定案；其中 D2 是一个功能性 bug（plugin hook 执行链路断裂），其余 9 个是性能/架构优化。本文档是父文档，给出决策矩阵与实施顺序；每个决策的完整设计在对应子文档。

**当前层 → 下一层**：架构决策总览 → 6 个子系统设计（子文档）。本层性质 = 子目标/子系统拆分（下一层产物 = 6 份可独立实施的子系统设计）。

---

## §1 背景目标

### SCQA

- **情境**：xyz-agent 是 Electron + Vue3 + Node runtime 的 AI Agent 桌面工作台。runtime 是单进程 WebSocket 服务，通过 stdio JSON-RPC 驱动 pi AI 引擎子进程，把 pi 的事件流（每 token 的 text_delta、thinking_delta、工具调用等）翻译后推给渲染进程。
- **冲突**：用户要求分析 runtime 层可优化的性能点。分析（5 个子代理并行深挖 + 主代理精读热路径交叉验证）发现：streaming 热路径每条消息被序列化 2 次并盲广播所有连接、事件流里夹着同步 git 子进程调用、文件扫描每请求全量递归 + 每文件逐个 stat、长 session 每次切回全量重传历史、pi 日志每行同步写盘、启动在监听端口前串行跑了大量无关工作。
- **问题**：**这些现象共享三个根因：①同步阻塞 IO 在热路径上；②每请求全量重算、无缓存；③消息分发双通道冗余（过渡态未收敛）。** 另外在分析中确诊了一个独立的功能性 bug：runtime plugin 的 hook 执行链路断裂，所有插件的 block/transform/observe 语义 100% 失效。
- **答案**：按「探明事实 → 方案对比 → 直接定长期方案」的流程，做出 D1–D10 共 10 个决策（项目无真实用户，不考虑兼容/迁移，直接选长期架构合理的方案）。本文档总览决策，子文档给出每个决策的五段式完整设计。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| runtime | `packages/runtime/src/` 的 Node 单进程服务，三层架构：transport（WS 消息路由）/ services（业务编排）/ infra（pi 子进程 RPC、文件、git 等外部系统适配）。 |
| pi | AI 引擎 CLI 子进程，runtime 通过 stdio JSONL 与其通信（`infra/pi/rpc-client.ts`）。agent 运行时持续推送事件流。 |
| MessageBus | `services/message-bus/` 的 per-session 消息分发核心：每条 session 级消息分配单调 seq、写入 1000 容量环形缓冲、推给订阅该 session 的 ws 连接（ADR-0055）。 |
| 盲广播 | `transport/message-broker.ts` 的 `broadcast()`：把消息发给**所有**已连接 ws，不区分 session。当前 session 级消息「双写」——bus 定向 + 盲广播兜底（ADR-0055 过渡态）。 |

### 设计目标（从使用者体验倒推）

1. **streaming 不卡**：agent 输出 token 时 runtime CPU 开销砍半以上（消除双序列化），事件流里不再夹着同步 git 阻塞。
2. **交互即时**：文件树展开、composer `#` 候选、git 状态面板、切回长 session 的响应从秒级降到百毫秒级。
3. **插件功能真实可用**：插件注册的 hook 真的执行（当前全断），block/transform/observe 语义生效。
4. **启动更快**：runtime 监听端口（Electron 判定就绪的唯一点）不再等待无关的迁移/版本探测。

### In scope / Out of scope

- **In**：D1–D10 十个决策的架构设计（本目录 6 个子文档）。
- **Out**：renderer 层与 pi 引擎进程内部的优化（仅在子文档中作为协作方出现）；具体代码实现（属于下一层拆分单元）；文档审查（用户明确要求「先不要审查」，对抗式审查留待后续）。

---

## §2 现状与问题分析（总览）

完整的现状证据（文件:行号 + 代码片段）在各子文档 §2。此处只给全景：性能问题按触发频率分四个梯队（完整清单见分析会话）：

| 梯队 | 触发频率 | 代表性发现 | 决策归属 |
|---|---|---|---|
| 第一梯队（streaming 热路径） | 每 token/每事件 | 双写广播（每事件 2 次 JSON.stringify + 盲广播全连接）；`streamRing` 用 `Array.shift()` O(n) 淘汰且 delta 无差别入 ring；pi 日志每行 `appendFileSync`；`thinking_delta` 丢 contentIndex 致前端 O(n²)；turn-start/每写工具结束同步 `execSync('git status')` | D1、D5、D3/D4、D10、微项 |
| 第二梯队（每请求/每操作） | 每次用户交互 | `git.status` 3 次串行 `execFileSync` 无缓存；`searchFiles` 串行递归 + 每文件 stat；`.gitignore` 每请求重读重编译；`matchPath` O(规则×前缀)；长 session 每次切回全量 `get_entries` 重建；`scanPiSessions` 目录级无缓存 + 8 处重复 `.find()` | D3/D4、D7、D9、D6 |
| 第三梯队（plugin 系统） | 随插件使用 | hook 串行 RPC 三重浪费（每 execute 重排序 + 线性查 worker + 每 handler 一次往返）；大 payload 每插件各序列化一次；status bar 每次更新全量广播 | **D2（先修 bug，优化并入修复）** |
| 第四梯队（启动与低频） | 启动一次/低频 | `server.start()` 前串行跑迁移 + `getPiVersion()` 子进程探测；`scanExtensions` 六源全磁盘扫描无缓存；quota hover 每次读盘 | D8、微项 |

**核心洞察（架构优化可以简化性能优化的三个机会）**：
1. **D1 双写收敛**：与其在双通道状态打「共享序列化」补丁，不如按 ADR-0055 完成退出——性能省 50% 序列化，架构上消息分发从双通道双接口变单通道。
2. **D4 Git 统一服务**：git 散在 4 个模块、各维护各的缓存与失效逻辑。与其 4 处分别加缓存，不如一次下沉为 GitStateService——缓存/去重/失效只写一次。
3. **D2 hook 修复 + D5 topic 分类**：这两个做对后，plugin 管线的大半性能问题（串行 RPC、payload 重复序列化）和 ring 容量压力会**自动降级或消失**——先修结构，再谈优化。

**最重要的独立发现（不是性能问题，但必须先修）**：runtime plugin 的 hook 执行链路**断裂**。主线程 `HookPipeline.execute` 发带 id 的 JSON-RPC request，Worker 侧只在无 id 的 notification 分支监听 `plugin.hooks.invoke`，且 request 分发器只认 `plugin.tool.execute`——每次 hook 调用都得到 METHOD_NOT_FOUND 并被吞为「放行」。所有插件的 block/transform/observe 语义 100% 失效。另有两个次生 bug：`transformedData`/`modifiedData` 字段错配（transform 结果被丢弃）、`onPiEvent` 注册/调用 key 不匹配。详见 `d2-plugin-hook-fix.md`。

---

## §3 决策矩阵与子系统划分

### 3.1 决策矩阵（10 个决策，全部已定案）

| # | 决策 | 定案 | 子文档 | 优先级分组 |
|---|---|---|---|---|
| D1 | session 级消息分发收敛 | 单通道：MessageBus 成为唯一通道，删除盲广播；前置 = 6 类「只 broadcast」消息接 bus | d1d5 | 高成本+高收益 |
| D2 | plugin hook 链路 | 修复断裂（request 直连 + observe 走 notify）+ 修两个次生 bug + 端到端测试 | d2 | 功能性 bug，最先做 |
| D3 | git 执行模型 | 异步化（execFile 替换 execFileSync/execSync） | d3d4 | 高成本+高收益 |
| D4 | git 状态统一 | 抽 GitStateService（异步 + in-flight 去重 + TTL 缓存 + 写操作失效钩子） | d3d4 | 高成本+高收益 |
| D5 | MessageBus topic 分类 | 三类 topic：state（seq+快照）/ stream（seq+ring）/ transient（无 seq 直传） | d1d5 | 高成本+高收益 |
| D6 | 历史加载 | 增量拉取（since=lastLeafId）+ renderer append 合并 + branch 失效 fallback | d6 | 高成本+高收益 |
| D7 | 文件扫描 | 自建四件套：matcher mtime 缓存 + 目录剪枝 + 有界并发 + searchFiles 免 stat | d7d9 | 高成本+高收益 |
| D8 | 启动编排 | 先 listen 后初始化；piVersion 惰性；迁移用 promise gate | d8d10 | 中成本+中收益 |
| D9 | session 扫描缓存 | scanPiSessions 目录列举层 1s TTL 缓存 + 显式失效 | d7d9 | 中成本+中收益 |
| D10 | 日志写入 | pi session log + 主日志改 WriteStream 缓冲写 + 退出前 flush | d8d10 | 低成本+高收益 |

### 3.2 子系统划分（子文档索引）

| 子文档 | 覆盖决策 | 边界 | 依赖 |
|---|---|---|---|
| `d2-plugin-hook-fix.md` | D2 | plugin-service 全模块（hook-pipeline / hook-api / plugin-bootstrap / plugin-host-process） | 无（最先做） |
| `d1d5-message-distribution.md` | D1 + D5 | MessageBus / message-broker / session-service send 回调 / message-dispatcher / terminal-service 广播点 / renderer routeInbound 契约 | 无（D5 是 D1 前置） |
| `d3d4-git-state-service.md` | D3 + D4 | 4 个 git 调用点（git-service / file-change-reconciler / git-info-reader / workspace-detector）+ EventInterpreter 的 file_changes 时序 | 无 |
| `d6-history-incremental.md` | D6 | session-service.getHistory / entry-tree-builder / renderer chat store | 无 |
| `d7d9-scan-caching.md` | D7 + D9 | file-service / ignore-parser / fs-executor / session-file-utils 扫描 | 无 |
| `d8d10-startup-logging.md` | D8 + D10 | index.ts 启动链 / logger / runtime-supervisor 契约 | 无 |

### 3.3 实施顺序与理由

```
阶段 0：D2 hook 修复（独立、紧急、功能性 bug，影响面清晰）
阶段 1：D5 + D1 消息分发单通道（最高性能收益 + 架构简化；terminal.data 归 transient 是 D1 前置）
阶段 2：D3/D4 GitStateService（消除事件流同步阻塞）
阶段 3：D7/D9 扫描缓存 + D6 历史增量（交互卡顿治理）
阶段 4：D8 启动 + D10 日志（可感知延迟治理）
```

理由：
1. **D2 最先**：它是 bug 而非优化，且修复方案自带性能最优形态（observe 走 notify），修完才能正确评估 plugin 管线的真实性能。
2. **D1+D5 其次**：每 token 热路径上 50% 序列化 + 盲广播消除，收益最大；D5 的 topic 分类是 D1 的 6 类消息迁移（尤其 terminal.data）的正确性前提，必须联动设计。
3. **D3/D4 再次**：同步 git 阻塞事件循环是 streaming 卡顿的第二来源，且 GitStateService 是独立模块，与消息分发无耦合。
4. **D6–D10 无相互依赖**，按收益排序即可；D9 与 D7 同属「扫描类 IO 缓存」范式（mtime/TTL 缓存），合并一份文档便于复用同款缓存实现。

### 3.4 低成本高收益微项（不单独成文档，随各阶段顺手带掉）

以下均为「改动 1–几十行、收益确定、风险极低」的项，已含文件:行号，实施时并入最接近的阶段的 commit：

| 微项 | 位置 | 并入阶段 |
|---|---|---|
| thinking_delta 透传 contentIndex（text_delta 已条件携带） | `infra/pi/event-adapter.ts:98-105` | 阶段 1 |
| `contentBlocks.some()` → 布尔标志（O(n²)→O(n)） | `infra/pi/message-converter.ts:102` | 阶段 3 |
| `stateTypeKey` 的 map 提为模块级常量（避免每次 publish 新建对象） | `services/message-bus/message-bus.ts:41` | 阶段 1 |
| 事件 kind 路由：subagent/workflow customType 判断移出 delta 帧路径 | `services/session/event-interpreter.ts:209-215` | 阶段 1 |
| contextWindow 查询缓存（每 turn 免全量重建 providers/models） | `index.ts:392-397` 注入的 resolver | 阶段 2 |
| notify 改真 notification（免往返+30s 定时器） | `plugin-service/api/notify-api.ts:112` | 阶段 0 |
| tool 执行 name 索引（Array.from+find → Map.get） | `plugin-service/bridge-interop.ts:82` | 阶段 0 |
| numstat 单趟解析（同 stdout 解析 2~3 趟） | `services/git-service.ts:116-131` | 阶段 2 |
| parseSessionHeader 首行读（全量读→读前 256B） | `infra/pi/session-file-utils.ts:28-45` | 阶段 3 |
| LRU 淘汰 O(n)→O(1)（两处同款） | `infra/system/git-info-reader.ts:28-35` + `worktree/workspace-detector.ts:229-236` | 阶段 2 |
| quota 缓存加内存层（hover 免读盘） | `services/quota-cache.ts:56-59` | 阶段 4 |
| 同 handler 内合并多次 `scanSessions().find()` | `services/session/session-service.ts:527/534/560/839` 等 | 阶段 3 |

### 3.5 已明确不做（高成本低收益）

- `scanPiSessions` 全异步化：与「KB 级文件同步 IO」既定架构约定冲突，收益仅冷启动一次。D9 的目录级缓存已覆盖其主要痛点。
- rpc-client stdin 背压队列：低概率 OOM 防护，顺序保证 + 失败清理成本高。
- hook 大 payload 懒取协议变更：需插件侧联调，且 D2 修复前无意义；D2 修复后按实际插件使用情况再评估。
- terminal.data 批量合并窗口：D1+D5 的 transient 分类已消除其序列化/ring 放大，批量合并的实时性风险不再值得。
- 统一缓存原语跨模块重构：各缓存失效语义差异大，重构成本 > 收益。

---

## §4 验收（子系统协同的整体真实场景）

> 各子系统的详细验收场景在子文档 §4。此处是从用户视角的整体验证，覆盖 §1 的四个目标。

| # | 场景（谁、什么上下文、做什么） | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| A1 | 用户在一个大仓库（≥5 万文件）里让 agent 做「读代码 + 改文件 + 跑命令」的多工具任务，同时开 2 个 session panel | 观察 streaming 全程：token 是否连续输出；工具执行间隙是否卡顿；切到另一个 panel 交互是否响应 | token 输出无肉眼可见停顿；runtime 进程 CPU 在 streaming 期间较改造前显著下降（对比基线采样）；两个 panel 都实时收到各自 session 的事件 | 目标 1（streaming 不卡） |
| A2 | 用户在长对话 session（几百轮）里切走再切回 | 切回后看聊天历史加载时间 | 历史秒级呈现（增量拉取生效，验证点：runtime 日志可见 `get_entries` 带 since 参数且返回条目数 < 全量） | 目标 2（交互即时） |
| A3 | 用户打开 composer 输入 `#` 触发文件候选 | 在大仓库里观察候选列表出现时间 | 候选列表 < 1s 出现（改造前实测基线作为对比） | 目标 2 |
| A4 | 用户安装一个注册了 `onBeforeSendMessage` hook 的插件，发送一条含插件要拦截的关键词的消息 | 发送后查看对话流 | 插件 hook 真实执行：拦截/改写生效（demo 插件场景：`!important` 被改写为 `IMPORTANT`），且 runtime 日志无 `hook handler ... failed/timed out` 告警 | 目标 3（插件功能可用） |
| A5 | 用户冷启动应用 | 记录从点击图标到 UI 出现的时长（含 runtime ready 判定） | 启动时长较改造前缩短（改造前：waitForHealth 前需完成 getPiVersion + 两个迁移）；版本标签在启动后短时间内从「unknown」变为真实 pi 版本 | 目标 4（启动更快） |

---

## §5 下一层拆分

下一层 = 6 份子文档（本目录），每份含各自的实施路径与文件改动地图：

1. `d2-plugin-hook-fix.md` —— 阶段 0
2. `d1d5-message-distribution.md` —— 阶段 1
3. `d3d4-git-state-service.md` —— 阶段 2
4. `d6-history-incremental.md` —— 阶段 3
5. `d7d9-scan-caching.md` —— 阶段 3
6. `d8d10-startup-logging.md` —— 阶段 4

**待验证检查点**（跨文档共有的诚实标注）：
- subagent 虚拟 session 是否经 subscribeSession 订阅（影响 D1 的 R8 风险项，实施 D1 时验证）。
- fast-glob 在 runtime 的现有消费点（决定 D7 是否可移除该依赖）。
- AGENTS.md 所述「leafId 从 JSONL 解析近似值」与代码现实（leafId 来自 pi RPC）的矛盾——D6 实施前确认 pi 版本行为。

---

## 附录：事实来源说明

本目录所有文档的「现状」事实均来自 2026-08-15 的探明工作：5 个并行子代理深挖 runtime 各层（transport / session 事件流 / pi infra / plugin service / 杂项服务）+ 4 个事实探明子代理（renderer 消息消费与 bus / hook 链路 / git+启动+扫描+日志 / 历史+文件扫描）+ 主代理对热路径文件的精读交叉验证。行号以 `feat-optimize-ui` 分支当前代码为准，实施时行号会漂移，以引用的函数/符号名为准。
