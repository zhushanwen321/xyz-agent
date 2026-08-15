# pi-subagent-workflow 性能优化：分析与进度总表

> 日期：2026-08-15。本文是该 extension 性能优化的**追溯入口**：汇总两轮独立审查的全部发现、已落地的优化（含 commit）、剩余待做项、以及当天的决策记录。读者假设为「维护 subagent-workflow 但未参与本次分析的开发者」。

## 1. 背景与方法

`extensions/subagent-workflow/`（约 3 万行源码）做过两轮独立性能审查，结论已交叉对账：

| 审查轮 | 方法 | 覆盖范围 |
|---|---|---|
| 内部审查（2026-08-15） | 3 个并行 Explore agent 分区精读 + 主 agent 对高优先级结论逐条抽查验证（读代码核实行号与行为） | execution 热路径 / 持久化层 / 资源发现与接口层 |
| 外部审查（2026-08-15） | 3 个并行 agent 分区精读 + 交叉验证，产出 22 项编号报告 | 全部非测试源码（含 orchestration/，内部审查未深覆盖的区域） |

两轮结论重合度高的项（stream 全量重发、agent_end 整读、tool_end 扫描、列表扫描频率、发现层无缓存）互相印证后优先实施；外部审查独有的 workflow 编排层发现（run 持久化 O(N²)、trace 线性扫）为剩余待做的主体。

上上一轮优化背景（勿重复建议）：commit `0ec55ff2d`（2026-08-14）已完成 record-store per-file stat 缓存 + session-reconstructor light identity 三级探测（head 64KB → tail 64KB → full-file）+ manifest per-file 缓存，实测热扫描 6.9s→47ms。

## 2. 已落地优化（两批 commit）

### 批次一：`76a2fca7a` — 8 项 quick win

| # | 项 | 位置 | 内容 |
|---|---|---|---|
| 1 | stream-sink 截断上限 | execution/stream-sink.ts | flush 原每 100ms 把累积全文 split 后整包 RPC 发送（O(n²) 传输）；改尾部 200 行 + truncated 提示，传输量有界 |
| 2 | identity 解析预筛 | execution/session-reconstructor.ts | parseIdentityFromText 对 head 64KB 内每行 JSON.parse（大头是数十 KB 的 toolResult 行）；加值特征串预筛（与 tail/anywhere 路径同款 [S-4] 值匹配），零行为变化 |
| 3 | 注入块渲染缓存 | injectors/subagent-list-injector.ts + workflow-list-injector.ts | before_agent_start 每 turn 重跑 escapeXml 多趟正则；渲染结果随数据缓存同步更新（setAgentCache/setWorkflowCache） |
| 4 | getWorkflowByPath 缓存 | orchestration/config-loader.ts | workflow tool 主路由每次 run 全文 regex + YAML.parse @pi-meta；改走与 getWorkflow(name) 对称的 mtime bucket 缓存（key=绝对路径） |
| 5 | 跨重启消息快路径 | execution/subagent-service.ts + record-store.ts | getRecordForAction 内存未命中原每条消息全目录 collectRecords；新增 RecordStore.findLightById（idToFile 索引 O(1)）优先直查 |
| 6 | 小文件探测短路 | execution/record-store.ts | ≤64KB 文件 head miss 后跳过 tail/anywhere 同内容重复读 |
| 7 | findWorkspaceRoot memoize | shared/resource-discovery.ts | 原每次最多 60 次 existsSync（spawn/tool 热路径）；按 cwd 缓存，清理挂 clearFileCache |
| 8 | 进程恒定量 memo | execution/argv-mirror.ts + pi-invocation.ts | mirrorMainProcessFlags 按 argv 引用、getPiInvocation 的 existsSync 按 argv[1] 值 memo |

### 批次二：`c0002fc86` — 3 项中等改动

| # | 项 | 位置 | 内容 |
|---|---|---|---|
| 9 | agent_end 增量读 | execution/session-pending.ts | 原每次 agent_end 全量 readFileSync 子进程 session 文件（fork 继承可达数十 MB，N 次唤醒 = N 次整读，同步阻塞事件泵）；改 per-file offset 游标增量读，truncate 防御 + EOF 半行不入账 |
| 10 | tool_end running 索引 | execution/execution-record.ts | 原每 tool_end 倒扫全部 turns × toolCalls（长任务 O(N²)）；WeakMap<record, Map<toolName, 槽位数组>> 弹尾 O(1)，miss 回退原全扫兜底 |
| 11 | 目录 mtime 快路径 | execution/record-store.ts | /subagents overlay 打开期间 250ms 动画 timer + 120ms debounce 双驱动扫描（每次 readdir + N×4 statSync ≈ 7k syscall/47ms）；sessionsDir mtime 未变时直接复用缓存 light（正确性依据：任何文件增删/sidecar 写入必改目录 mtime；jsonl append 不影响 light 态）。pid 探活抽出 refreshAlive 两路共用 |

验证基线：批次一 subagent-workflow 1991 tests + 18 包全绿；批次二 2000 tests（新增 9 个针对性测试）+ tsc 0 错误 + 改动文件 lint 0 warning。

## 3. 外部审查 22 项对账表

| 外部# | 问题 | 状态 |
|---|---|---|
| 1 | workflow run 持久化 O(N²)（save 整聚合根覆盖写，每 agent-call 触发） | **剩余待做（高）** |
| 2 | trace 线性扫 + 无界（findByStepIndex O(n)，无节点上限） | **剩余待做（高）** |
| 3 | SubagentStream 全量重发 | 已解决（批次一 #1；残留每次 flush 全量 split 的小尾巴，见 §4 低优先） |
| 4 | agent_end 全量同步读 session 文件 | 已解决（批次二 #9，offset 增量比外部建议的 indexOf 方案更彻底） |
| 5 | getWorkflowByPath 绕过缓存 | 已解决（批次一 #4）；残留 source:"user-pi" 标签语义未修 |
| 6 | 注入段无长度预算（token 成本） | **已决策不截断**（见 §5 决策 D1）；渲染缓存部分已解决 |
| 7 | list TUI 动画循环高频 statSync | 已解决（批次二 #11）；残留 hasRunning/buildLines 同帧两次 collectRecords 可共享 |
| 8 | session_start 两次全量发现 + npm manifest 无缓存 + 串行 | 部分解决（findWorkspaceRoot memo）；剩余：readPackageManifest 缓存、7 源并行 |
| 9 | runs Map / notifiedRunIds / 锁链无界 | **剩余待做（中）** |
| 10 | chatMode 每轮通知携带累计全文 | **剩余（设计已出，见 §6 索引）** |
| 11 | worker 模板每次 eval+compile | 剩余（低） |
| 12 | _knownFields Set 每次重建 | 剩余（低） |
| 13 | schema JSON.stringify 重复 | 剩余（低） |
| 14 | skill-discovery existsSync 不缓存 | 剩余（低） |
| 15 | launcher 同脚本重复 lint | 剩余（低） |
| 16 | pollInterval setTimeout 未 unref | 剩余（低） |
| 17 | WorkflowsView 200ms tick 无条件 invalidate | 剩余（低） |
| 18 | truncLine 逐字符 O(n²) | 剩余（低） |
| 19 | scriptResult 全量序列化再截断 | 剩余（低） |
| 20 | tool_end 跨 turn 扫描 | 已解决（批次二 #10，索引 + fallback 覆盖面更广） |
| 21 | spawn 全量 env 拷贝 | 部分（argv/existsSync memo 已做；env 拷贝保留——注入 PI_SUBAGENT_* 语义需要） |
| 22 | onEventThrottled 200ms 全量投影 | 已确认为**生产死路径**（所有调用点 onUpdate: undefined，见 subagent-service.ts:673/1174、subagent-actions.ts:211；仅测试触达）——低优先清理或防误用 |

外部审查两条自我修正（经独立验证成立）：#22 非「高优先级必改」；hasRunningBackground 的 snapshot() 是浅拷贝非全量投影，放大效应不成立。

## 4. 剩余待做（按可做性分组）

### 4.1 可直接做（无行为取舍）

1. **workflow run 持久化 O(N²)**（外部 #1，最高价值剩余项）— `orchestration/jsonl-run-store.ts:242-273`（save 整聚合根覆盖写），调用点 error-recovery.ts:302/354/376/425（每 agent-call 完成触发）+ lifecycle.ts:213/269/328/377。短期：save 加 100-250ms 去抖（终态必须同步 flush）+ workflow-state-link 指针只在创建/终态写一次（现每 save appendEntry 一次，膨胀父 session jsonl 反加重 loadAll）。长期：增量 append + 重放（概念说明见 §6）。
2. **trace 线性扫 + 无界**（外部 #2）— `orchestration/models/trace.ts:68-73` findByStepIndex 每次从头扫、:27-28 nodes 无上限（对比同文件 errorLogs MAX_ERROR_LOGS=500）。修法：Map 倒排索引 + 节点上限或 result 裁剪。与上一项同区域，一起做收益乘数。
3. **内存有界性三件**（外部 #9）— done run 淘汰、notifiedRunIds 清理、activateLockTails release 后 delete。
4. **list 同帧共享扫描**（外部 #7 残留）— list-component.ts:120 hasRunning 与 buildLines 同帧各一次 collectRecords。
5. **npm manifest 缓存 + 并行**（外部 #8 残留）— readPackageManifest（async/sync 两套）path+mtime 缓存；scanNpmDir/源级 Promise.all。
6. **source 标签语义修正**（外部 #5 残留）— getWorkflowByPath 的 "user-pi" 标签一行修正。
7. **低优先批量**（外部 #11-19、#22）：见 §3 表。

### 4.2 需设计评审（设计文档已出，见 §6）

- chatMode 轮次通知增量（外部 #10）
- worktree git 异步化（内部审查发现，外部报告未覆盖）
- sessions-index.json 持久化索引（内部审查长期项，外部报告未覆盖）

### 4.3 长期

- jsonl-run-store 增量 append + 重放（外部 #1 的长期形态）
- worker 模板预编译（外部 #11）

## 5. 决策记录（2026-08-15，项目维护者拍板）

| # | 决策 | 内容 |
|---|---|---|
| D1 | **注入段不截断** | agent/workflow 注入段（description/examples）不做长度预算截断——当前规模可接受，稍大也无妨。外部 #6 的截断方案**否决**，现状（不截断）即为终态 |
| D2 | chatMode 轮次通知 | 出设计文档后再定实施（→ chatmode-round-notify-design.md） |
| D3 | worktree git 异步化 | 出设计文档后再定实施（→ worktree-git-async-design.md） |
| D4 | sessions-index 持久化索引 | 出设计文档后再定实施（→ sessions-index-design.md） |
| D5 | jsonl-run-store 增量方案 | 先出概念说明（→ jsonl-run-store-append-replay.md），完整设计另议 |

## 6. 本目录文档索引

| 文档 | 内容 |
|---|---|
| README.md（本文） | 追溯总表：审查对账 + 已落地 + 剩余 + 决策 |
| chatmode-round-notify-design.md | chatMode 轮次通知增量设计（推荐：本轮增量 + sessionFile 回溯指针） |
| worktree-git-async-design.md | worktree git 异步化设计（推荐：整链 async 化，两期落地） |
| sessions-index-design.md | sessions-index.json 持久化索引设计（推荐：兄弟位置自校验索引，tmp+rename 原子写） |
| jsonl-run-store-append-replay.md | jsonl-run-store 增量 append + 重放的概念说明（非完整设计） |

## 7. 勿动清单（有意设计，防止「优化」引入回归）

- record-store per-file stat 戳缓存与负缓存——stat 校验是精心设计的精准失效，勿改成整体失效
- onUpdate 节流排除 text_delta（subagent-service.ts）与 notifier 滑动窗口 + dedup + isIdle 退避——竞态防护完整
- injector session 级缓存——发现不在每 turn 热路径，勿「优化」成每 turn 重扫
- `turn.text += delta`——V8 cons-string 摊销 O(1)，非二次方
- ajv.compile 有 benchmark 依据不缓存；manifest-store/mtimeCache 缓存；list-view debounce + timer 全清理；watchdog/idle timer unref；spawnedChildren 按值守卫；stderr 64KB 截断
