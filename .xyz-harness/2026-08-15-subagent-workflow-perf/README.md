# pi-subagent-workflow 性能优化：分析与进度总表

> 日期：2026-08-15。本文是该 extension 性能优化的**追溯入口**：汇总两轮独立审查的全部发现、已落地的优化（含 commit）、剩余待做项、以及当天的决策记录。读者假设为「维护 subagent-workflow 但未参与本次分析的开发者」。

## 1. 背景与方法

`extensions/subagent-workflow/`（约 3 万行源码）做过两轮独立性能审查，结论已交叉对账：

| 审查轮 | 方法 | 覆盖范围 |
|---|---|---|
| 内部审查（2026-08-15） | 3 个并行 Explore agent 分区精读 + 主 agent 对高优先级结论逐条抽查验证（读代码核实行号与行为） | execution 热路径 / 持久化层 / 资源发现与接口层 |
| 外部审查（2026-08-15） | 3 个并行 agent 分区精读 + 交叉验证，产出 22 项编号报告 | 全部非测试源码（含 orchestration/，内部审查未深覆盖的区域） |

两轮结论重合度高的项（stream 全量重发、agent_end 整读、tool_end 扫描、列表扫描频率、发现层无缓存）互相印证后优先实施（批次一/二）；外部审查独有的 workflow 编排层发现（run 持久化 O(N²)、trace 线性扫）随后也已在批次三落地。

上上一轮优化背景（勿重复建议）：commit `0ec55ff2d`（2026-08-14）已完成 record-store per-file stat 缓存 + session-reconstructor light identity 三级探测（head 64KB → tail 64KB → full-file）+ manifest per-file 缓存，实测热扫描 6.9s→47ms。

## 2. 已落地优化（七批 commit）

> 批次三~七按主题归组编号；commit 时间序为 批次六 → 三 → 四 → 五 → 七（git log 可证）。各批次表内的 # 延续批次一/二的连续编号，与 §3 外部审查编号是两套体系。

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

### 批次三：`f2673e2ce` / `5a50bb43f` / `a29c5e5b9` — runstore trace/save/内存有界（外部 #1/#2/#9）

| # | 项 | 位置 | 内容 |
|---|---|---|---|
| 12 | trace 倒排索引 + result 裁剪 | orchestration/models/trace.ts | findByStepIndex 原从头线性扫（外部 #2）；`byIndex` Map O(1)（append/removeByStepIndex/fromArray 重建/update 四个节点变更点同步维护，重复 stepIndex last-wins 语义文档化）。无界性按 §4.1 预设的「节点上限**或** result 裁剪」二选一落地：result.content 入口裁剪 `TRACE_RESULT_MAX_CHARS=8000`（head/tail 4000 + 原长标记；≤8000 引用透传零拷贝，保留 AgentCall.traceNode 与 nodes 的 D-10 引用共享；AgentCall.result 不动保 worker 重放保真） |
| 13 | run save 去抖 + 终态同步 flush | orchestration/jsonl-run-store.ts | save 原每 agent-call 完成覆盖写整聚合根（外部 #1 的 O(N²) 主体）；per-runId pending batch 固定窗口 200ms 去抖（`DEFAULT_SAVE_DEBOUNCE_MS`，N 次调用合并为 flush 时最新态的 1 次写；timer 不重置保证延迟有界 ≤200ms）+ 冷路径（首写/paused/done）同步 flush（终态 flush 取消 timer、原子接管 batch 走 per-runId 串行链）+ 首写 flush 失败回滚 writtenOnce 堵「指针永久丢失」窗口。workflow-state-link 指针只在**首写与 status==="done"** 时写（原每 save appendEntry 一次，收敛到 ≤2 条，不再膨胀父 session jsonl）。session_shutdown 先 `await dispose()` 再删 sessionState。save() 签名与 11 个调用点零变化 |
| 14 | 内存有界三件 | orchestration/lifecycle.ts / interface/helpers.ts / execution/lifecycle-manager.ts | done run 淘汰上限 `MAX_RETAINED_DONE_RUNS=20`（done-only 白名单 + completedAt 升序、缺失视为最旧、同毫秒稳定排序保插入序；session_start rehydrate 后与 onRunDone 两处接线，磁盘文件/指针不动）；notifiedRunIds FIFO 上限 `MAX_NOTIFIED_RUN_IDS=1000`（幂等 add 不重排；超限的旧 id 理论可重通知，runId 全局唯一故语义无损）；activateLockTails tail-identity 自清（releaseFn resolve 后 queueMicrotask，仅当 Map 链尾仍是本链尾时 delete——等尾者不删、最后释放者回收） |

### 批次四：`e7011cdaa` / `38fd30433` / `55af6815c` — sessions-index 持久化索引（D4）

| # | 项 | 位置 | 内容 |
|---|---|---|---|
| 15 | sessions-index.json 持久化索引 | execution/sessions-index.ts + record-store.ts | 冷扫描的 identity 探测结论持久化为 `<enc>/sessions-index.json`（sessionsDir 兄弟位置）：per-entry `mtimeMs+size` stat 锚自校验（与 L1 戳同构）、`tmp(pid)+fsync+rename+dir-fsync` 原子写、60s 节流 fire-and-forget、损坏/版本不符静默回退全量探测（**更高版本只忽略不重写**，防 v1/v2 互覆振荡）。RecordStore 两个接入点：scanFile 重建分支探测前查索引（正/负条目戳匹配即零内容读取，miss/失配回退原探测并标 dirty）；reconstructAll 首扫惰性 loadIndex + 扫描尾按节流规则落盘。实测冷扫描中位数 **972.8ms → 80.6ms（12.1x，预算 ≤300ms PASS）**，真实索引 6.4MB / 隔离解析 30.4ms，60 次扫描仅观测到 1 次索引写。证据 evidence/sessions-index-cold-scan-2026-08-15.md |
| 16 | bench 验收脚本 | bench/cold-scan.bench.ts + concurrent-scan.bench.ts | cold-scan（--baseline 每轮 rm 索引防把热命中测成冷启动 + 五元组与 ground truth 等价断言 + chmod000 零读断言 + 中位数 ≤300ms）与 concurrent-scan（3 实例 × 20 轮同进程交错 + 外部随机 append/touch 变异 + 无异常/JSON 完整/无 tmp 残留/输出一致四判定）；`55af6815c` 补空 ground-truth 拒跑守卫与真实数据目录（`~/.pi/agent/subagents`）拒绝守卫 |

### 批次五：`a73bd0dfb` / `076300dbc` / `3dec1719d` — chatMode 增量通知（D2，外部 #10）

| # | 项 | 位置 | 内容 |
|---|---|---|---|
| 17 | 轮次通知增量 | execution/subagent-service.ts + execution-record.ts | 通知正文从 `getFullText` 全量派生（第 k 条含前 k 轮全文，总量 O(N²)）改为按 `roundBaseTurnIndex` 切片的本轮增量（`getFullTextFrom`，[from, length) 语义；base 不持久化、reload 重建为 0）；严格 6 步序：先通知后推 base（同步 at-least-once）。真机实测通知长度 145/198/251 逐条叠加 → 321/321/321 常量。基线与对照见 evidence/chatmode-baseline-2026-08-15.md |
| 18 | 全文指针行 | execution/notifier.ts | 轮次与终态通知追加 `Full transcript: <path>` 指针行（增量语义下全文的恢复通道，实测子 session 文件含全部轮次）；one-shot 结构性排除（sessionFile 仅 chatMode 透传），完成通知字节级不变由结构+语义双断言锁定 |
| 19 | close 终态通知 + 轮次统计 | execution/subagent-service.ts + notifier.ts | 对抗式设计-实现审查发现设计承诺的 close 终态通知**从未存在**（closeChatIdle 无通知调用点、冷路径 .then 通知被轮次 key 去重吞掉）。`notifyClosed` 以裸 id 去重身份（区别于轮次 `id:round`）确保最后一条轮次增量与终态通知都送达；closeChatIdle（D2 路径②）空正文占位 + 指针行，closeAfterRoundSettled（路径①）携带末轮增量 + 指针；终态通知带 `after N rounds` 统计。修复后真机实测 4 条通知序列（3 轮 + 1 终态，close 后 17ms 落盘，21/21 断言），见 evidence/chatmode-close-notify-2026-08-15.md |

### 批次六：`c6d272935` / `8b4636b16` / `2a5857c4a` — worktree git 异步化（D3，方案 A 两期三步）

| # | 项 | 位置 | 内容 |
|---|---|---|---|
| 20 | gitRunAsync + per-repo 写互斥 | execution/worktree-manager.ts | 同步 `execFileSync` git 冻结主进程事件循环（基线实测 create 临界区 717ms 连续同步 git、跨窗口 765ms 事件空洞）；`gitRunAsync`（execFile 手写 Promise 包装，GitRunError 形态与同步版一致）+ 同 repo 写命令串行队列（链吞前驱 rejection，后继不继承失败）；finalize/collectPatch/cleanup/scan/session_start reaper 全异步化，cancel/dispose cleanup 改 fire-and-forget |
| 21 | create 异步化 + 竞态守卫 | worktree-manager.ts + execute | status+rev-parse 经 Promise.allSettled 并行（定序判定：脏树优先于非 repo）、worktree add 走互斥队列；create-await 窗口被 cancel/dispose 抢先 CAS 终态时，守卫在 create 返回后同 tick 主动清理（不等 60s reaper）并跳过 kickOffBackground（子进程零白跑）；同步 gitRun 与 assertCleanTree 删除，单一异步路径 |
| 22 | buildEnvBlock 异步化 | execution/session-runner.ts | 分支查询 execFileSync（慢 git 挂载下阻塞 spawn 链至 2s）改 execFile Promise + 2s 超时，branchCache 保留。Phase 2 终态实测：worktree add 642ms 窗口内流式事件按正常速率流动（事件数/预期 ratio 1.01，NO-FREEZE），见 evidence/pblock-baseline-2026-08-15.md；四门实施期实测（cancel-during-create / per-repo mutex 串行化+失败不传染 / kill 重启 reaper 三门通过；patch 回收门发现**存量** stdout.trim 裁掉 diff 尾换行 bug，已修复（7b2bd1a40，复测通过））见 evidence/pblock-gates-2026-08-15.md |

### 批次七：`093e28fe3` / `dcee2c9b6` — cleanup 低优先批量（外部 #5/#7/#8 残留 + #11-19 + #22）

| # | 项 | 位置 | 内容 |
|---|---|---|---|
| 23 | 残留三项收尾 | orchestration/config-loader.ts / interface/list-component.ts / shared/resource-discovery.ts | ① source 标签从路径推导（`.tmp` 树 → `project-pi-tmp`，替代硬编码 `user-pi`，外部 #5 残留）；② list 同帧 collectRecords 共享：`FRAME_TTL_MS=50ms` 帧缓存统一全部 4 个调用点（hasRunning/handleInput/buildLines/detail-children，外部 #7 残留）；③ readPackageManifest 按 path+mtimeMs 缓存（async/sync 共享一个 Map，stat 失败逐出、坏 JSON 不入缓存不逐出好条目）+ 包级（含 scoped）与源级扫描 Promise.all 并行（保序 + 保留串行版异常上抛语义，allSettled 因会吞向上抛的异常被显式否决并留注释豁免），外部 #8 残留 |
| 24 | 低优先批量 + 死路径删除 | 十余文件（零契约微优化） | worker 模板 PRE/POST 段与 `_KNOWN_FIELDS` 提升为模块常量（输出由字节级 snapshot fixture 锚定，#11/#12）；schema-jsonify WeakMap 按对象引用缓存 compact/pretty 两格式，接入 agent-opts-resolver 与 session-runner 两个 per-call 点（#13）；skill 路径 per-name 结果缓存、miss 同样缓存（#14）；workflow lint 按源码**值**键 memo（lintScript 验证纯函数，配 srcRef 防 source 变化误命中，#15）；pollInterval timer.unref（#16）；WorkflowsView 200ms tick 改 computeRenderSignature 摘要变化才失效（#17）；truncLine 逐字符 O(n²) 改 `indexOf("\x1b")` 跳段，3147 对抗/fuzz 用例与旧实现字节级对拍（#18）；boundedPrettySerialize 流式拼接恰 8000 截断（escape 保真 + 祖先环守卫 + toJSON/BigInt 整体回退旧语义，#19）；ExecuteOptions.onUpdate + onEventThrottled 节流机器确认为生产死路径后整体删除约 80 行（#22） |

验证基线：批次一 subagent-workflow 1991 tests + 18 包全绿；批次二 2000 tests（新增 9 个针对性测试）+ tsc 0 错误 + 改动文件 lint 0 warning。批次三各 commit 记录 2018→2054 tests（+11/+20/+15，tsc/lint clean）；批次四 2068→2069 tests（+14，tsc/lint clean）；批次五 2079→2089 tests（+10/+10，tsc clean；`3dec1719d` 未在 message 记总数）；批次六 2004→2007 tests（tsc clean）；批次七 2148→2164 tests（+59 后净 +10，tsc clean）。

## 3. 外部审查 22 项对账表

| 外部# | 问题 | 状态 |
|---|---|---|
| 1 | workflow run 持久化 O(N²)（save 整聚合根覆盖写，每 agent-call 触发） | 已解决（批次三 `5a50bb43f`）：save 200ms 去抖 + 冷路径/终态同步 flush + 指针只在首写与 done 写（≤2 条）；长期增量 append + 重放形态仍在 §4.3 |
| 2 | trace 线性扫 + 无界（findByStepIndex O(n)，无节点上限） | 已解决（批次三 `f2673e2ce`）：byIndex 倒排 O(1)；无界性按 §4.1 预设的「节点上限或 result 裁剪」二选一，落地 result 8000 裁剪 |
| 3 | SubagentStream 全量重发 | 已解决（批次一 #1；残留每次 flush 全量 split 的小尾巴——传输量已有界，仅剩 split 的 CPU 成本，见 §4 低优先） |
| 4 | agent_end 全量同步读 session 文件 | 已解决（批次二 #9，offset 增量比外部建议的 indexOf 方案更彻底） |
| 5 | getWorkflowByPath 绕过缓存 | 已解决（批次一 #4）；残留 source:"user-pi" 标签已修（批次七 `093e28fe3`：从路径推导，.tmp 树 → project-pi-tmp） |
| 6 | 注入段无长度预算（token 成本） | **已决策不截断**（见 §5 决策 D1）；渲染缓存部分已解决 |
| 7 | list TUI 动画循环高频 statSync | 已解决（批次二 #11）；残留 hasRunning/buildLines 同帧两次 collectRecords 已修（批次七 `dcee2c9b6`：FRAME_TTL_MS=50 帧缓存统一 4 个调用点） |
| 8 | session_start 两次全量发现 + npm manifest 无缓存 + 串行 | 已解决（批次一 #7 findWorkspaceRoot memo + 批次七 `dcee2c9b6`：readPackageManifest path+mtime 缓存 + 包级/源级 Promise.all 并行） |
| 9 | runs Map / notifiedRunIds / 锁链无界 | 已解决（批次三 `a29c5e5b9`）：done run 上限 20 + notifiedRunIds FIFO 1000 + activateLockTails tail 自清 |
| 10 | chatMode 每轮通知携带累计全文 | 已解决（批次五 `a73bd0dfb`/`076300dbc`/`3dec1719d`）：本轮增量 + 全文指针行 + close 终态通知；O(N²)→O(N) 真机实测见 evidence/chatmode-baseline-2026-08-15.md |
| 11 | worker 模板每次 eval+compile | 已解决（批次七 `093e28fe3`）：模板段提升为模块常量 + 字节级 snapshot 锚定输出（Worker 线程随 spawn 编译属线程模型固有，预编译仍属 §4.3 长期项） |
| 12 | _knownFields Set 每次重建 | 已解决（批次七 `093e28fe3`：hoisted 出生成的 source body） |
| 13 | schema JSON.stringify 重复 | 已解决（批次七 `093e28fe3`：schema-jsonify WeakMap 按对象引用缓存 compact/pretty） |
| 14 | skill-discovery existsSync 不缓存 | 已解决（批次七 `093e28fe3`：resolveSkillPath per-name 结果缓存，miss 同样缓存） |
| 15 | launcher 同脚本重复 lint | 已解决（批次七 `093e28fe3`：lint 按源码值键 memo + srcRef 防 source 变化） |
| 16 | pollInterval setTimeout 未 unref | 已解决（批次七 `093e28fe3`：timer.unref，对齐 gcTimer 先例） |
| 17 | WorkflowsView 200ms tick 无条件 invalidate | 已解决（批次七 `093e28fe3`：computeRenderSignature 摘要变化才失效，字段清单随代码文档化） |
| 18 | truncLine 逐字符 O(n²) | 已解决（批次七 `093e28fe3`：indexOf("\x1b") 跳段；3147 对抗/fuzz 用例与旧实现字节级对拍） |
| 19 | scriptResult 全量序列化再截断 | 已解决（批次七 `093e28fe3`：boundedPrettySerialize 流式拼接恰 8000 截断） |
| 20 | tool_end 跨 turn 扫描 | 已解决（批次二 #10，索引 + fallback 覆盖面更广） |
| 21 | spawn 全量 env 拷贝 | 部分（argv/existsSync memo 已做；env 拷贝保留——注入 PI_SUBAGENT_* 语义需要） |
| 22 | onEventThrottled 200ms 全量投影 | 已解决（批次七 `dcee2c9b6`）：确认为生产死路径后整体删除（ExecuteOptions.onUpdate + 节流机器约 80 行） |

外部审查两条自我修正（经独立验证成立）：#22 非「高优先级必改」（后经授权于批次七清理删除）；hasRunningBackground 的 snapshot() 是浅拷贝非全量投影，放大效应不成立。

## 4. 剩余待做（按可做性分组）

> 4.1/4.2 条目已全部完成（状态标注于各条），本节保留原文与完成标注作追溯；当前真实剩余项仅 §4.3 两项与门 4 存量 bug 修复。

### 4.1 可直接做（无行为取舍）

1. **workflow run 持久化 O(N²)**（外部 #1，最高价值剩余项）— **已完成（批次三，短期形态）**：save 200ms 去抖 + 终态同步 flush + 指针首写/done 各一次；增量 append + 重放的长期形态仍在 §4.3。
2. **trace 线性扫 + 无界**（外部 #2）— **已完成（批次三）**：byIndex 倒排 O(1) + result 8000 裁剪（「节点上限或 result 裁剪」二选一，取后者）。
3. **内存有界性三件**（外部 #9）— **已完成（批次三）**：done run 上限 20 / notifiedRunIds FIFO 1000 / activateLockTails 自清。
4. **list 同帧共享扫描**（外部 #7 残留）— **已完成（批次七）**：FRAME_TTL_MS=50 帧缓存统一 4 个调用点（超出原方案只合并 2 处的设想）。
5. **npm manifest 缓存 + 并行**（外部 #8 残留）— **已完成（批次七）**：path+mtimeMs 缓存（async/sync 共享）+ 包级/源级 Promise.all。
6. **source 标签语义修正**（外部 #5 残留）— **已完成（批次七）**：从路径推导 project-pi-tmp。
7. **低优先批量**（外部 #11-19、#22）— **已完成（批次七）**，见 §3 表。唯一未动残留：外部 #3 的 flush 全量 split CPU 小尾巴（传输量已由批次一 #1 界定，见 §3 #3）。

### 4.2 需设计评审（设计文档已出，见 §6）

- chatMode 轮次通知增量（外部 #10）— **已实施（批次五）**
- worktree git 异步化（内部审查发现，外部报告未覆盖）— **已实施（批次六）**
- sessions-index.json 持久化索引（内部审查长期项，外部报告未覆盖）— **已实施（批次四）**

### 4.3 长期

- jsonl-run-store 增量 append + 重放（外部 #1 的长期形态）——未做（批次三落地的是去抖短期形态，增量形态设计另议，见 §6 概念说明）
- worker 模板预编译（外部 #11）——未做（批次七消除的是模板字符串每次重建；缓存编译产物仍待）

### 4.4 实施期新发现（随批次六实测产生）

- 门 4 存量 bug：`gitRunAsync`/旧 `gitRun` 对 `diff --cached` 输出 `.trim()` 裁掉尾换行，落盘 patch `git apply --check` exit 128（非异步化回归，同步时代同样存在）。已修复（7b2bd1a40：gitRunAsync 输出保真不 trim + 消费点自行 trim + patch 尾换行回归断言，复测 apply --check 通过），证据 evidence/pblock-gates-2026-08-15.md §1 修复与复测子节。

## 5. 决策记录（2026-08-15，项目维护者拍板）

| # | 决策 | 内容 |
|---|---|---|
| D1 | **注入段不截断** | agent/workflow 注入段（description/examples）不做长度预算截断——当前规模可接受，稍大也无妨。外部 #6 的截断方案**否决**，现状（不截断）即为终态 |
| D2 | chatMode 轮次通知 | 已实施（批次五）：本轮增量 + 全文指针行 + close 终态通知（含 `3dec1719d` 审查修复）；证据 evidence/chatmode-baseline-2026-08-15.md、evidence/chatmode-close-notify-2026-08-15.md（设计 → chatmode-round-notify-design.md） |
| D3 | worktree git 异步化 | 已实施（批次六）：全链 gitRunAsync + per-repo 写互斥 + 竞态守卫；证据 evidence/pblock-baseline-2026-08-15.md（Phase 1/2 冻结消除对照）、evidence/pblock-gates-2026-08-15.md（四门：三门通过，门 4 存量 bug 已修复 7b2bd1a40）（设计 → worktree-git-async-design.md） |
| D4 | sessions-index 持久化索引 | 已实施（批次四）：冷扫描 972.8ms→80.6ms（12.1x，预算 ≤300ms 达成）；实测回填 sessions-index-design.md §4.1，另见 evidence/sessions-index-cold-scan-2026-08-15.md |
| D5 | jsonl-run-store 增量方案 | 先出概念说明（→ jsonl-run-store-append-replay.md），完整设计另议；批次三已落地去抖短期形态（外部 #1 的 O(N²) 主体已消除） |

## 6. 本目录文档索引

| 文档 | 内容 |
|---|---|
| README.md（本文） | 追溯总表：审查对账 + 已落地 + 剩余 + 决策 |
| chatmode-round-notify-design.md | chatMode 轮次通知增量设计（推荐：本轮增量 + sessionFile 回溯指针） |
| worktree-git-async-design.md | worktree git 异步化设计（推荐：整链 async 化，两期落地） |
| sessions-index-design.md | sessions-index.json 持久化索引设计（推荐：兄弟位置自校验索引，tmp+rename 原子写）；§4.1 已回填实测数字 |
| jsonl-run-store-append-replay.md | jsonl-run-store 增量 append + 重放的概念说明（非完整设计） |
| evidence/chatmode-baseline-2026-08-15.md | chatMode 通知基线（O(N²) 叠加实测 145/198/251）+ 增量改造后对照（321 常量）+ 跨轮暗号/one-shot 零影响 |
| evidence/chatmode-close-notify-2026-08-15.md | close 终态通知修复后复测（`3dec1719d`：4 条通知序列、终态含轮次统计与指针行，21/21 断言） |
| evidence/pblock-baseline-2026-08-15.md | worktree git 同步阻塞基线（717ms 临界区/765ms 事件空洞）+ Phase 1/2 异步化对照（NO-FREEZE） |
| evidence/pblock-gates-2026-08-15.md | worktree git 四门实施期实测（cancel 竞态/写互斥/kill 重启 reaper 通过；patch 回收门发现存量尾换行 bug） |
| evidence/sessions-index-cold-scan-2026-08-15.md | sessions-index 冷扫描实测报告（972.8ms→80.6ms、索引成本分解、并发写观测，bench 复现命令） |

## 7. 勿动清单（有意设计，防止「优化」引入回归）

- record-store per-file stat 戳缓存与负缓存——stat 校验是精心设计的精准失效，勿改成整体失效
- notifier 滑动窗口 + dedup + isIdle 退避（execution/notifier.ts）——竞态防护完整，勿动。（原并列的「onUpdate 节流排除 text_delta」已随外部 #22 死路径授权删除于批次七，勿重新引入）
- injector session 级缓存——发现不在每 turn 热路径，勿「优化」成每 turn 重扫
- `turn.text += delta`——V8 cons-string 摊销 O(1)，非二次方
- ajv.compile 有 benchmark 依据不缓存；manifest-store/mtimeCache 缓存；list-view debounce + timer 全清理；watchdog/idle timer unref；spawnedChildren 按值守卫；stderr 64KB 截断
