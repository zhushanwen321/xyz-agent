# 全栈性能优化总体规划（runtime + renderer 合并总纲）

> **一句话结论**：runtime 层 10 个决策（D1–D10）与 renderer 层 9 个决策（D-1~D-9）已全部定案并整合为同一套实施计划——按「成本 × 收益」四象限分组、六个阶段实施；流式卡顿的第一根因横跨两层：**runtime 每 token 双序列化盲广播 + renderer 每 token 跨 session 失效扇出**，两层都要修，且有三条跨层缝（git 状态链路、消息分发契约、历史增量）需要联动设计。

- **S（情境）**：xyz-agent 是 Electron + Vue 3 + Node runtime 的 AI Agent 桌面工作台。runtime（`packages/runtime/src/`，单进程 WebSocket 服务）通过 stdio JSON-RPC 驱动 pi AI 引擎子进程，把事件流翻译后推给渲染进程；renderer 进程横跨 `packages/core`（transport + domain 状态层）、`packages/ui`（消息组件库）、`packages/renderer`（shell/composables）三个包。
- **C（冲突）**：对两层的独立深度性能分析（runtime 侧 5 个子代理深挖 + 4 个事实探明；renderer 侧 6 个模块并行分析 + 主代理第一手验证）各自发现：streaming 热路径每 token 有多重放大（runtime 双序列化盲广播、同步 git 阻塞；renderer 全 Map 替换跨 session 失效、全量重渲染）；交互路径全量重算（文件扫描、历史重建）；另有三个「理论成本」被实测证伪，真实成本另有其因。
- **Q（问题）**：如何把两套分析收敛为**一套**决策与实施计划——按成本收益分组、厘清跨层依赖、消除重叠与冲突，且方案长期架构合理？
- **A（答案）**：19 个决策全部定案（编号保留两套命名空间：runtime D1–D10、renderer D-1~D-9，见 §3.1 统一矩阵）；重叠的 D-9（renderer 跨层）与 D3/D4（runtime git）已裁决（§3.3）；本文档给出成本收益四象限分组（§3.2）、统一实施顺序（§3.4）、统一验收（§4）；11 份子文档承载各决策的完整技术方案。

**当前层 → 下一层**：架构决策总览 → 11 份可独立实施的子系统技术方案（子文档）。

---

## §1 背景与目标

**本节的结论：设计目标是 6 条可验证的用户体验目标（G1-G6），范围 = runtime + renderer 三包（pi 引擎进程内部与 electron 主进程除 runtime service 外不在范围）。**

### 1.1 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| runtime | `packages/runtime/src/` 的 Node 单进程服务，三层架构：transport（WS 消息路由）/ services（业务编排）/ infra（pi 子进程 RPC、文件、git 适配）。 |
| MessageBus | runtime `services/message-bus/` 的 per-session 消息分发核心：session 级消息分配单调 seq、写 1000 容量环形缓冲、推给订阅者（ADR-0055）。 |
| 盲广播 | runtime `transport/message-broker.ts` 的 `broadcast()`：发给**所有**已连接 ws。当前 session 级消息「双写」——bus 定向 + 盲广播兜底（ADR-0055 过渡态）。 |
| renderer 三包 | `core` = transport + 领域状态（chat store 等）；`ui` = 消息组件库（Turn/Block/MarkdownRenderer）；`renderer` = shell/composables/面板。 |
| 失效扇出 | 响应式系统中一次状态写入触发的依赖重算范围——renderer 流式卡顿的第一根因（见 §2）。 |

### 1.2 设计目标（从使用者体验倒推）

| 编号 | 目标（谁、在什么上下文、达成什么） | 对应决策 |
|---|---|---|
| G1 | 开发者在 200+ 消息长 session 里看流式回复，token 连续输出无停顿，不随对话增长变卡 | runtime D1/D5；renderer D-1/D-2/D-3/D-4/D-5 |
| G2 | 文件树展开、composer `#` 候选、git 面板、重建长 session（LRU 驱逐/重开/重载）的响应从秒级降到百毫秒级 | runtime D6/D7/D9；renderer D-7/D-9 |
| G3 | 终端跑 `npm run build` 等高频输出命令时输出流畅、界面不冻结 | runtime D5（transient）；renderer D-6 |
| G4 | 冷启动到可交互显著缩短（runtime 监听端口即就绪 + 首屏 JS 显著变小） | runtime D8；renderer D-8 |
| G5 | 修复结构上正确：无重复漂移状态、消息分发单通道收敛、失效范围收敛到单 session | runtime D1/D4；renderer D-1/D-3/D-4 |
| G6 | 插件注册的 hook 真实执行（block/transform/observe 语义生效） | runtime D2 |

### 1.3 In / Out of Scope

- **In**：runtime D1–D10 与 renderer D-1~D-9 共 19 个决策的架构设计（本目录 11 份子文档）。
- **Out**：pi 引擎进程内部优化（上游能力，直接消费）；electron 主进程（除 runtime service 与启动契约外）；功能需求变更；文档对抗式审查（用户明确要求「先不要审查」，留待后续）。

---

## §2 现状与问题分析

**本节的结论：两层的问题收敛为同一张「频率 × 根因」图——streaming 热路径（每 token）有双序列化盲广播 + 跨 session 失效扇出 + 全量重渲染 + 同步 git 阻塞四重放大；交互路径（每请求）全量重算无缓存；另有三个「理论成本」被实测证伪。**

### 2.1 全景：失败模式与梯队

**renderer 侧失败模式**（代码级根因与数据流详见 07-10 子文档 §2）：

| 失败模式 | 根因 | 决策 |
|---|---|---|
| A 长对话流式卡顿 | 每 token 全 Map 替换 → 跨 session 失效扇出 → 三层 computed 级联 → 全量 turn 重建 + markdown 全文重渲染（实测 10KB=18.1ms 超帧预算） | D-1/D-2/D-3/D-4/D-5 |
| B 大仓库文件树卡顿 | 无虚拟化全量渲染 + 每行 12 computed + 徽章 O(n) 扫描；git 角标只在 loadTree 拉一次从不刷新 | D-7 |
| C 高频终端输出掉帧 | PTY chunk 逐条 WS → reactive push → watch → xterm.write，无合帧 | D-6 |
| D 首屏加载重 | 主 JS chunk 2.34MB（gzip 684KB），xterm/shiki/katex 静态 import 进首屏图 | D-8 |
| E AI 写文件主线程抖动 | runtime execSync git status 0.35s/次 × 每写工具一次；前端 deep watch 每 token 全量重扫 fileChanges | runtime D3/D4 + renderer D-9 |

**runtime 侧四梯队**（完整证据在 01-06 子文档 §2）：

| 梯队 | 触发频率 | 代表性发现 | 决策 |
|---|---|---|---|
| 第一梯队 | 每 token/每事件 | 双写广播（每事件 2 次 JSON.stringify + 盲广播全连接）；pi 日志每行 `appendFileSync`；turn-start/每写工具结束同步 `execSync('git status')`（`streamRing` 的 O(n) shift 仅在**溢出淘汰时**触发，非逐 token——归 D5 一并修，不属每事件成本） | D1、D5、D3/D4、D10、微项 |
| 第二梯队 | 每请求/每操作 | `git.status` 3 次串行 `execFileSync` 无缓存；`searchFiles` 串行递归 + 每文件 stat；`.gitignore` 每请求重读重编译；长 session 重建路径每次全量 `get_entries`（LRU 窗口内切回已零请求）；`scanPiSessions` 目录级无缓存 | D3/D4、D7、D9、D6 |
| 第三梯队 | 随插件使用 | hook 执行链路**断裂**（功能性 bug：所有插件 block/transform/observe 语义 100% 失效）；串行 RPC 三重浪费 | **D2（先修 bug）** |
| 第四梯队 | 启动一次/低频 | `server.start()` 前串行跑迁移 + `getPiVersion()` 子进程探测 | D8、微项 |

### 2.2 实测证伪（避免为不存在的成本做复杂优化）

| # | 假设 | 实测 | 影响 |
|---|---|---|---|
| F1 | 每 token 数组拷贝 + Map 重造是主要成本 | **证伪**：S=10/M=500 @25 commit/s 仅 0.1ms/秒 | D-1 论据 = 收敛失效扇出而非省拷贝 |
| F2 | O(n²) 字符串拼接是热成本 | **证伪**：100KB/1000 token 拼接 0.1ms（V8 cons-string） | 降级，chunk 缓冲仅服务增量渲染 |
| F3 | scrollback splice 前删是热成本 | **证伪**：5000 稳态 10000 push 6.3ms | D-6 论据 = watch/xterm.write/WS 帧数 |
| F4 | 未闭合代码块每帧重高亮是热成本 | **证伪**：200 行代码块高亮 0.1ms/次 | markdown 成本在 parse + v-html，不在高亮 |

**实测确认**：F5 markdown 全量渲染 10KB=18.1ms/50KB=71ms/200KB=253ms；F6 主 bundle 2.34MB（684KB gz）；F7 git status execSync 0.35s/次、AI 写 10 文件 ≈ 4s 阻塞；其余事实（F8-F13 及 runtime 侧探明事实）见各子文档 §2 与探针清单。

### 2.3 跨层缝（两层问题的交汇点）

三条跨层缝是整合的关键（裁决见 §3.3）：

1. **git 状态链路缝**：runtime `event-interpreter` 同步 git → file_changes 帧 → renderer `useFileChangeInvalidation` deep watch + `fileTreeStore.gitOverlay` 从不刷新。runtime 侧决策（D3/D4：GitStateService）与 renderer 侧决策（D-9：overlay 回写）在此交汇。
2. **消息分发契约缝**：runtime D1/D5（单通道 + topic 三分类）改变 session 级消息的 seq/快照/transient 语义；renderer `routeInbound` 的 gap 检测与订阅前提是正确性依赖（已探明兼容：无 seq 消息直接 dispatch）。
3. **历史重建缝**：`getHistory` 只在无基底路径被调（LRU 驱逐重进 / dispose 重开 / renderer 重载——isHydrated 三重守卫 + LRU 消息常驻使窗口内切回零请求）；增量落在 runtime 侧的「已重建消息缓存 + lastLeafId」（04 文档，审查重范围），renderer 协议与行为零改动——初稿的「renderer append」方案已撤回（无基底路径 append 无处安放）。

---

## §3 解决方案

**本节的结论：19 个决策统一进一张矩阵；按成本收益四象限分组（先做象限 1，象限 4 明确不做）；三条跨层缝已裁决；实施顺序 = 六阶段。**

### 3.1 统一决策矩阵（19 个，全部已定案）

> 编号命名空间：runtime = D1–D10；renderer = D-1~D-9（带连字符）。两套编号独立演进，本文档是唯一映射点。

| # | 决策 | 定案 | 子文档 | 象限 | 阶段 |
|---|---|---|---|---|---|
| D1 | session 级消息分发收敛（runtime） | 单通道：MessageBus 唯一通道，删除盲广播；前置 = 6 类消息接 bus | 02 | ③ | 1 |
| D2 | plugin hook 链路修复（runtime） | 修复断裂 + 两个次生 bug + e2e 测试 | 01 | ① | 0 |
| D3 | git 执行模型（runtime） | 异步化（execFile 替换 execSync/execFileSync） | 03 | ③ | 2 |
| D4 | git 状态统一（runtime） | GitStateService：异步 + in-flight 去重 + TTL 缓存 + 写失效钩子 | 03 | ③ | 2 |
| D5 | MessageBus topic 分类（runtime） | state（seq+快照）/ stream（seq+ring）/ transient（无 seq 直传） | 02 | ③ | 1 |
| D6 | 历史重建缓存 + leafId 增量（runtime） | runtime 侧「已重建消息缓存 + lastLeafId」：缓存命中零 pi 序列化、leafId 前进时 `getEntries(since)` 只重建增量窗口；renderer 零改动（审查重范围：初稿 renderer append 撤回） | 04 | ③ | 3 |
| D7 | 文件扫描缓存（runtime） | matcher mtime 缓存 + 目录剪枝 + 有界并发 + searchFiles 免 stat | 05 | ③ | 4 |
| D8 | 启动编排（runtime） | 先 listen 后初始化；piVersion 惰性；迁移 promise gate | 06 | ① | 5 |
| D9 | session 扫描缓存（runtime） | scanPiSessions 目录列举 1s TTL + 显式失效 | 05 | ① | 4 |
| D10 | 日志写入（runtime） | pi log + 主日志改 WriteStream 缓冲写 + 退出前 flush | 06 | ① | 5 |
| D-1 | 消息容器范式（renderer） | `Map<sid, shallowRef<Message[]>>`：Map 恒等稳定 + per-session 独立 ref | 07 | ③ | 1 |
| D-2 | token coalescing（renderer） | useChat 层 microtask 批量（同类型保序，终态即时 flush） | 07 | ① | 1 |
| D-3 | streaming 状态派生（renderer） | per-session 惰性缓存 computed（并入 D-1 实施） | 07 | ③ | 1 |
| D-4 | turn 派生增量化（renderer） | 消息对象身份增量复用 turn + Block 级 v-memo | 08 | ③ | 3 |
| D-5 | markdown 流式渲染（renderer） | 后缀增量渲染 + 未闭合 fence 占位（阈值留实施期 tuning） | 08 | ③ | 3 |
| D-6 | 终端输出模型（renderer） | 第一步 rAF 写队列；第二步命令式 buffer + 版本回放 | 09 | ①② | 1/4 |
| D-7 | 文件树数据模型（renderer） | 第一步徽章预聚合 + 防抖；第二步扁平可见列表 + virtua | 09 | ①② | 1/4 |
| D-8 | 构建分割（renderer） | defineAsyncComponent（TerminalView/DetailPane/设置页）+ manualChunks | 10 | ① | 5 |
| D-9 | overlay 回写（renderer 侧，runtime 侧已并入 D3/D4） | ready 后 debounce 300ms → git.status RPC（经 GitStateService 缓存）→ setGitOverlay | 09 | ① | 2 |

### 3.2 成本 × 收益四象限分组

**象限 ① 低成本 + 高收益（快赢，最先做）**：

| 决策/项 | 成本 | 收益 | 位置 |
|---|---|---|---|
| D2 hook 修复（功能性 bug，阶段 0 最先） | 中（链路重连 + e2e 测试，无数据模型改动） | 插件功能解锁 + 管线性能最优形态 | 01 |
| D-2 token coalescing | 低（useChat 一处，测试面零影响） | 每 token 级联触发频率降一个数量级 | 07 §D-2 |
| D-6 第一步 rAF 写队列 | 低（useTerminal 局部） | 高频输出 watch/xterm.write 次数降 ~60× | 09 §D-6 |
| D-7 第一步徽章预聚合 + 防抖 | 低 | 大仓库 per-row O(n) 扫描消除、过滤即时 | 09 §D-7 |
| D-9 renderer 侧 overlay 回写 | 低 | 修复「角标永不刷新」+ 失效成本产出价值 | 09 §D-9 |
| D8 启动编排、D9 scan 缓存、D10 日志 | 低-中 | 启动提前、切 session/列表交互即时 | 06/05 |
| D-8 构建分割 | 低（配置 + 3-4 个 import 改） | 首屏 gzip 684KB → <400KB | 10 |
| Q1 快赢集 + runtime 微项（共 ~20 项） | 低（每项 1-几十行） | 见 10 §3.6 与 §5 微项表 | 10/本文 §5 |

**象限 ② 低成本 + 低收益（顺手做，不做也不亏）**：ROUTE_TABLE Record 化、pendingMap 上限、toast timer 句柄、ForkGroup/project deep watch 改浅、bash 定位倒序 for、LRU keys 二次拷贝等——全部已并入 10 的 Q1 杂项与 runtime 微项表，随最接近的阶段顺手带掉。

**象限 ③ 高成本 + 高收益（核心工程，按阶段推进）**：

| 决策 | 为什么贵 | 为什么值 |
|---|---|---|
| D1 + D5 消息单通道 | 6 类消息接 bus + 全 push 点枚举 + renderer 订阅验证 | 每 token 省 50% 序列化 + 消除 O(clients) 盲发——runtime 最大常数倍放大点 |
| D3 + D4 GitStateService | 4 个 git 调用点下沉统一服务 | 事件流热路径同步阻塞清零 + 缓存去重 |
| D6 历史重建缓存 | runtime 重建缓存 + lastLeafId + since 增量重建 + fallback | 长 session 重建路径从秒级到百毫秒（LRU 内切回已零请求） |
| D7 文件扫描四件套 | 自建缓存/剪枝/并发 | `#` 候选、搜索从秒级到百毫秒 |
| D-1 + D-3 容器范式 | 全部写入面 + 5 个测试文件适配 | 跨 session 失效扇出结构性消除——renderer 最大根因 |
| D-4 turn 增量化 | 缓存键/失效设计 + v-memo 键清单 | 每 token 只 patch 末位 turn |
| D-5 markdown 增量渲染 | 稳定边界判定规则 + 单测矩阵 | 10KB 全量 18ms → 只渲染 tail（帧预算内） |
| D-6 第二步命令式 buffer | 回放语义重设计 | 终端模型最简 + attach 流量控制落位 |
| D-7 第二步扁平列表 | 14 消费方适配 + ADR-0025/0026 对齐 | 万级 DOM → 视口渲染 |

**象限 ④ 高成本 + 低收益（明确不做/暂缓）**：

- runtime：`scanPiSessions` 全异步化（与既定架构约定冲突，D9 已覆盖痛点）；rpc-client stdin 背压队列（低概率 OOM 防护）；hook 大 payload 懒取协议（需插件侧联调，D2 后按需评估）；terminal.data WS 批量合并窗口（D5 transient 已消除放大，实时性风险不再值得）；统一缓存原语跨模块重构（各缓存失效语义差异大）。
- renderer：DetailPane 1MB 大文件行虚拟化（改动面大收益边缘）；DiffView 整段高亮（跨行 span 拆回难点）；search top-K 前置截断（排序语义风险）；attach 流量控制剩余部分（被 D1 transient + D-6 第二步覆盖）。

### 3.3 跨层缝裁决（整合新增的决策，均已定案）

**裁决 1（git 链路）**：D-9 的 runtime 侧设计（execSync→execFile + accumulating 300ms debounce）**撤销并让位于 runtime D3/D4**——GitStateService 以「baseline promise 帧序保证」替代 debounce（accumulating 帧序契约保序：baseline 未就绪跳过本次 accumulating、ready 全量兜底）。D-9 保留 renderer 侧：ready 后 debounce 300ms → `git.status` RPC（享受 GitStateService 缓存）→ `setGitOverlay`。理由：帧序契约是 ADR-0024 的正确性约束，不能靠 debounce 破坏；异步化后 accumulating 帧不再阻塞事件循环，**runtime 侧**的帧节流失去必要性。**措辞区分**：runtime 侧不 debounce（帧序契约保序），renderer 侧 D-9 仍保留「ready 后 debounce 300ms」——那是合并**角标刷新 RPC 频次**（每 turn 至多一次）的节流，两者作用对象不同、不冲突。

**裁决 2（terminal）**：runtime 不做 WS 批量合并（D5 transient 直传已消除序列化/ring 放大）；renderer D-6 的 rAF 写队列与命令式 buffer 独立成立（合并的是 xterm.write 频率，不是 WS 帧）——两者不冲突，各自生效。

**裁决 3（历史重建，审查修订）**：对抗式审查核实初稿前提不成立——`getHistory` 只在无基底路径被调（isHydrated 三重守卫 + LRU 消息常驻），「每次切回都全量」错误、renderer append 在无基底路径无处安放（append 空数组丢头部、branch fallback 被 hydrate 守卫 no-op、重建消息 id 随机不可去重）。D6 重范围为 runtime 侧重建缓存（04 文档附重范围记录），renderer 协议与行为零改动；实施 D6 前仍需验证 pi 版本 `since` 行为与 compact 后增量语义（04 文档待验证）。

**裁决 4（编号与目标）**：决策编号保留两套命名空间（D1–D10 / D-1~D-9，语法天然可区分，§3.1 是唯一映射点）；目标统一为 G1-G6（原 renderer G1-G5 语义不变，新增 G6 插件可用；原 runtime「目标 1-4」映射 G1/G2/G4/G6）。

### 3.4 统一实施顺序（六阶段）

```
阶段 0（bug + 快赢，零依赖）：D2（01）+ Q1/微项集（10 + §5 微项表）
阶段 1（消息热路径双层 + 面板快赢第一步）：runtime D5+D1（02）先定 transient/seq 契约；**并含 D-6 第一步（rAF 写队列，09）与 D-7 第一步（徽章预聚合 + 防抖，09）两项零依赖快赢**（矩阵象限①与阶段清单对齐）
                          → renderer D-1/D-2/D-3（07）
阶段 2（git 跨层联动）：runtime D3/D4（03）+ renderer D-9 侧（09 §D-9）同批验收
阶段 3（渲染与历史重建）：renderer D-4/D-5（08）+ runtime D6（04，runtime 侧重建缓存，renderer 零改动）
阶段 4（扫描与面板）：runtime D7/D9（05）+ renderer D-6 第二步/D-7 第二步（09）
阶段 5（启动与构建）：runtime D8/D10（06）+ renderer D-8（10）
```

理由：① 阶段 0 是 bug 与快赢，零依赖可立即并行；② 阶段 1 先 runtime 后 renderer——renderer 状态层的验收依赖稳定的消息到达语义，D1 的 transient 契约（terminal.data 等）是 09 文档 D-6 第二步的前提；③ 阶段 2 必须两层联动（同一因果链：git 阻塞 → file_changes → 角标）；④ 阶段 3-5 按收益与依赖排序，各阶段内可并行。

---

## §4 验收（全局真实场景）

**本节的结论：8 个全局验收场景覆盖 G1-G6，用真实 dev 环境跑真实用例；各子文档另有细分验收，本层只判全局是否达成。**

> 验证环境：`pnpm dev` 启动的真实 Electron 应用（renderer 9222 / runtime 3310），真实仓库（本仓，>5000 文件）、真实 pi 会话（标注验证缺口）。

| 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|
| V1 长对话流式流畅 | 200+ 消息 session 中让 AI 生成 50KB+ 带代码块回复；流式期间滚动历史；Performance 录 token 密集段 | ≥55fps；无 >100ms 长任务来自提交链；runtime CPU 较基线显著下降（双序列化消除） | G1 |
| V2 大仓库交互 | 展开 `packages/` 大目录；过滤框输入 `store`；composer 输入 `#` 看候选 | 展开/滚动首帧 <100ms；过滤即时；候选 <1s | G2 |
| V3 终端高频输出 | 终端 tab 跑 `npm run build`；输出期间滚动消息流 | 输出流畅可交互；CPU 峰值低于基线；切 tab 回来历史完整 | G3 |
| V4 启动与首屏 | 冷启动记录点击图标到可交互时长；Network 录首屏加载 | runtime 监听端口即就绪（不再等迁移/版本探测）；首屏 gzip JS <400KB（基线 684KB） | G4 |
| V5 AI 写文件链路 | 让 AI 一轮修改 ≥5 文件；观察 runtime 进程与树角标 | runtime 主线程无 >100ms git 阻塞；角标在 file_changes ready 后数秒内刷新 | G5/G2 |
| V6 插件 hook 可用 | 安装注册 `onBeforeSendMessage` 的插件，发送含关键词消息 | hook 真实执行（拦截/改写生效）；runtime 日志无 failed/timed out 告警 | G6 |
| V7 长 session 切回（**口径勘误：W20 重范围，2026-08-16**） | **被驱逐重进**：几百轮 session 切走后超出 LRU 窗口（>8 session）再切回，观察历史加载（原「切走再切回」场景会测错——LRU 窗口内切回 isHydrated 守卫直接命中常驻消息，**本就零请求**，见 04 文档重范围记录与 `session-message-handler.ts:222` 注释；plan.md W20 验收已同步此口径） | 秒级→百毫秒级；runtime 日志可见 get_entries 带 since 且返回条目 < 全量（计时仅对「被驱逐重进」路径有意义；LRU 窗口内切回零请求属更快上限，不参与计时） | G2 |
| V8 断线重连（**依赖 D1/D5 落地后才可验收**，属阶段 1 产物，非全局收尾） | streaming 中断开 renderer WS，5 秒后重连 | state 快照立即恢复；stream 按 seq 回放；delta 不回放但后续继续；无重复消息 | G1/G5 |

**验证缺口**：V1/V5/V6 依赖真实 pi 模型与插件，无法 mock——实施时优先争取真实 pi 会话；mock 流（70ms/chunk）可验证渲染路径但覆盖不了真实 token 速率上限。**G1 确定性 fallback（审查补充）**：拿不到真实模型时，用「固定 fixture pi 会话（预置 200+ 消息 JSONL）+ 预录 token 流按 70ms/帧回放」跑 V1——可确定性执行、覆盖失效扇出/增量渲染的因果链，偏差边界 = 不覆盖真实 token 速率上限（该上限由实施期真实会话另行补测，不编造通过）。

---

## §5 下一层拆分

**本节的结论：下一层 = 11 份子文档（本目录），按阶段实施；子文档内各自有文件改动地图与探针清单。**

| 子文档 | 覆盖决策 | 边界 | 阶段 |
|---|---|---|---|
| `01-plugin-hook-fix.md` | D2 | plugin-service 全模块（hook-pipeline/hook-api/plugin-bootstrap/plugin-host-process） | 0 |
| `02-message-distribution.md` | D1 + D5 | MessageBus/message-broker/session-service send 回调/message-dispatcher/terminal-service 广播点/renderer routeInbound 契约 | 1 |
| `03-git-state-service.md` | D3 + D4 | 4 个 git 调用点 + EventInterpreter 的 file_changes 帧序 | 2 |
| `04-history-incremental.md` | D6 | session-service.getHistory/entry-tree-builder/runtime 重建缓存（renderer 零改动） | 3 |
| `05-scan-caching.md` | D7 + D9 | file-service/ignore-parser/fs-executor/session-file-utils 扫描 | 4 |
| `06-startup-logging.md` | D8 + D10 | index.ts 启动链/logger/runtime-supervisor 契约 | 5 |
| `07-state-layer.md` | D-1 + D-2 + D-3 | renderer core 消息容器范式/coalescing/per-session computed（D-1 是 08 的地基） | 1 |
| `08-render-layer.md` | D-4 + D-5 | turn 派生增量化/markdown 增量渲染协议 | 3 |
| `09-panel-layer.md` | D-6 + D-7 + D-9 | 终端两步走/文件树两步走/overlay 回写 | 1/2/4 |
| `10-build-and-quickwins.md` | D-8 + Q1 集 | 构建分割 + renderer 快赢（markers cache/i18n 懒加载/sound 缓存等） | 5（Q1 项阶段 0 并行） |
| （微项表，随阶段带掉） | runtime 微项 11 项 | 见下方微项表 | 0-4 |

**runtime 微项表**（改动 1-几十行、收益确定，随各阶段 commit 带掉）：

| 微项 | 位置 | 并入阶段 |
|---|---|---|
| thinking_delta 透传 contentIndex | `infra/pi/event-adapter.ts:98-105` | 1 |
| `contentBlocks.some()` → 布尔标志 | `infra/pi/message-converter.ts:102` | 3 |
| `stateTypeKey` map 提为模块级常量 | `services/message-bus/message-bus.ts:41` | 1 |
| 事件 kind 路由移出 delta 帧路径 | `services/session/event-interpreter.ts:209-215` | 1 |
| contextWindow 查询缓存 | `index.ts:392-397` | 2 |
| notify 改真 notification | `plugin-service/api/notify-api.ts:112` | 0 |
| tool 执行 name 索引 Map.get | `plugin-service/bridge-interop.ts:82` | 0 |
| numstat 单趟解析 | `services/git-service.ts:116-131` | 2 |
| parseSessionHeader 首行读 | `infra/pi/session-file-utils.ts:28-45` | 3 |
| LRU 淘汰 O(n)→O(1) 两处 | `infra/system/git-info-reader.ts:28-35` + `worktree/workspace-detector.ts:229-236` | 2 |
| quota 缓存加内存层 | `services/quota-cache.ts:56-59` | 4 |
| 同 handler 合并 scanSessions().find() | `services/session/session-service.ts:527 等` | 3 |

**待验证检查点**（设计阶段诚实标注，跨文档）：
1. 真实 pi token 到达率（renderer F13 假设区间）——影响 D-2 合并窗口收益上界，不影响方案选择。
2. D-5 稳定边界阈值（静默时长、长度切点）——需真实使用数据 tuning。
3. subagent 虚拟 session 是否经 subscribeSession 订阅——影响 D1 的 R8 风险项，实施 D1 时验证。
4. pi 版本 `since` 行为与 AGENTS.md「leafId 从 JSONL 解析」描述的差异，及 **compact 后增量 since 语义**（⛔）——D6 实施前确认。
5. fast-glob 在 runtime 的现有消费点——决定 D7 是否可移除该依赖。
6. ~~rolldown 下 manualChunks 实际行为~~ **✅已验证关闭（W31 df1e7b62e 实施探针）**：manualChunks/advancedChunks 在 rolldown 1.1.4 已标 deprecated（manualChunks 仅剩函数形式、与 codeSplitting 同设时被忽略），实际生效键为 `build.rolldownOptions.output.codeSplitting.groups`；`rollupOptions` 系 `rolldownOptions` 的 deprecated alias，同设时被整体丢弃，input/output 须统一迁至 `rolldownOptions`。勘误详情见 10 §3.4 实施定案。
7. V1/V5/V6 验收场景的真实模型可用性。

---

## 附录 A：决策编号映射（历史 → 现）

| 现 | 原 | 现 | 原 |
|---|---|---|---|
| D1–D10 | runtime D1–D10（不变） | D-1~D-9 | renderer D-1~D-9（不变） |
| 01-plugin-hook-fix.md | d2-plugin-hook-fix.md | 07-state-layer.md | 01-p0-state-layer.md |
| 02-message-distribution.md | d1d5-message-distribution.md | 08-render-layer.md | 02-p1-render-layer.md |
| 03-git-state-service.md | d3d4-git-state-service.md | 09-panel-layer.md | 03-p2-panel-layer.md |
| 04-history-incremental.md | d6-history-incremental.md | 10-build-and-quickwins.md | 04-p3-build-and-quickwins.md |
| 05-scan-caching.md | d7d9-scan-caching.md | 00-overview.md | runtime README.md + renderer 00-overview.md 合并 |
| 06-startup-logging.md | d8d10-startup-logging.md | | |

## 附录 B：变更历史

- 2026-08-15：runtime 决策集（D1-D10，6 子文档）与 renderer 决策集（D-1~D-9，4 子文档）分别成文。
- 2026-08-15：两套合并为单一目录 `2026-08-15-perf`：总纲合并重写、子文档重编号（附录 A）、跨层缝裁决 4 条（§3.3）、D-9 runtime 侧让位于 D3/D4、统一目标 G1-G6 与六阶段实施顺序。
