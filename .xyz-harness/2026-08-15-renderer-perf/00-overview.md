# Renderer 性能优化总体规划（父文档）

> **一句话结论**：流式对话「越用越卡」的根因不是数据拷贝，而是**响应式失效扇出**与**全量重渲染**——本文档以 9 项决策（D-1~D-9）分 P0→P3 四批修复，并拆出 4 份子文档承载各批的技术方案设计。

- **S（情境）**：xyz-agent 是 Electron + Vue 3 + Pinia 桌面 AI 编程工作台。renderer 进程横跨三个包：`packages/core`（transport + domain 状态层，~19k 行）、`packages/ui`（消息组件库，~14k 行）、`packages/renderer`（shell/composables，~41k 行）。AI 流式回复是核心体验，逐 token 经 `WS → core transport → chat store → 消息组件 → markdown 渲染` 全链路更新。
- **C（冲突）**：六模块深度性能分析发现四类真实失败模式：长对话流式随对话增长变卡、大仓库文件树展开秒级卡顿、高频终端输出掉帧、首屏 JS 2.34MB。更关键的是：三个「理论上成立」的优化假设（数组拷贝、O(n²) 字符串拼接、splice 前删）经实测**全部证伪**——真实成本另有其因。
- **Q（问题）**：如何系统性消除这些瓶颈，且方案长期架构合理（结构上正确，而非修补症状）？
- **A（答案）**：9 项决策已拍板（见 §3.2），按依赖关系分 P0（状态层）→ P1（渲染层）→ P2（面板层）→ P3（构建与快赢）四批实施。本文档是总纲；4 份子文档承载各批的技术方案。

---

## §1 背景与目标

**本节的结论：设计目标是 5 条可验证的用户体验目标（G1-G5），范围严格限定在 renderer 三包 + runtime 跨层配合，不碰 pi 进程与功能需求。**

### 1.1 系统是什么

xyz-agent 的使用者是一位用 AI 编程助手干活的开发者。他在左侧侧边栏管理会话与文件树，在中间面板与 AI 对话（消息流是虚拟滚动列表，AI 回复包含 markdown/代码块/mermaid 图/命令输出块），在底部 composer 输入指令，在面板里看终端输出与文件详情。

流式对话的物理链路（一条 token 的旅程）：

```
pi 进程产出 token
  → runtime WS 推送 message.text_delta
  → core/transport/ws-client JSON.parse（必要成本）
  → coordination/route-inbound 按 payload.sessionId 精确路由（已优化，无全量扇出）
  → domain/chat/effects/registry 的 text_delta handler
      ├─ [...prev] 全消息数组浅拷贝 + content 字符串拼接
      └─ commitMessages: new Map(所有 sessions) 整体替换 .value  ← 根因 1 的触发器
  → shallowRef 替换 → 所有读 messages.value 的 computed 跨 session 失效
      ├─ streamingSessionIds（全 Map 重扫，O(Σ消息)）
      ├─ currentMessages / renderItems（toRenderItems 全量重建所有 MessageTurn）
      └─ useFileChangeInvalidation / useSearch 的整 ref watcher（每 token 全量重扫）
  → virtua 虚拟滚动 diff → 视口内 ~5-10 个 Turn 全部 patch
  → 末位 Turn 的 MarkdownRenderer（rAF 节流后）全文 markdown-it 重渲染
      └─ 实测 10KB 文档 = 18.1ms/次，已超 60fps 帧预算（16.6ms）
```

### 1.2 设计目标（从使用者体验倒推）

| 编号 | 目标（谁、在什么上下文、达成什么） | 对应决策 |
|---|---|---|
| G1 | 开发者在 200+ 消息长 session 里看流式回复，界面保持流畅；token 密集段不掉帧，且不随对话增长变卡 | D-1/D-2/D-3/D-4 |
| G2 | 开发者在 >1 万文件的大仓库里展开目录、过滤文件名，操作即时响应 | D-7 |
| G3 | 开发者在终端里跑 `npm run build` 等高频输出命令，输出流畅、界面不冻结 | D-6 |
| G4 | 开发者冷启动应用到可交互的时间显著缩短（首屏 JS 从 684KB gzip 降下来） | D-8 |
| G5 | 上述修复是**结构上正确**的：不引入与消息数组重复的漂移风险状态、不靠脆弱缓存键、不修补症状 | D-1/D-3/D-4 |

### 1.3 In / Out of Scope

- **In**：`packages/core`、`packages/ui`、`packages/renderer` 的性能相关改动；D-9 涉及的 `packages/runtime` 跨层配合（git status 异步化、file_changes 节流、overlay 回写）。
- **Out**：pi 进程内部行为；electron 主进程（除 D-9 触碰的 runtime service 外）；任何功能需求变更（新增/删除功能）；样式与视觉改动。

---

## §2 现状与问题分析

**本节的结论：四个失败模式全部有代码级根因与实测数据支撑；其中三个「理论成本」被实测证伪，真实根因收敛为 5 条——失效扇出、全量重渲染、事件无批处理、树无虚拟化、构建无分割。**

### 2.1 失败模式（使用者视角的真实例子）

**失败模式 A：长对话流式卡顿（G1 的反面）。**
开发者在一条 200+ 消息的 session 里让 AI 写一段带代码块的回答。AI 每吐一个 token（实测 mock 节拍 70ms/chunk ≈ 14 token/s，真实 pi 假设 10-80 token/s），界面出现一次可感知的微卡；回答里带代码块时卡顿更明显。对话越长越卡。
触发链路见 §1.1 数据流图——**每个 token 触发一次全量级联**：跨 session 失效（所有读 `messages.value` 的 computed，包括其他 panel、sidebar 派生、搜索缓存失效 watcher）→ `streamingSessionIds` 全 Map 重扫 → `toRenderItems` 全量重建所有 MessageTurn → 视口内全部 Turn patch → markdown 全文重渲染（实测 10KB=18.1ms）。

**失败模式 B：大仓库文件树卡顿（G2 的反面）。**
开发者在一个数千文件的 monorepo 里展开 `node_modules` 之外的某个大目录。`FileView.vue:83-91` 无虚拟化全量渲染，每个 `FileTreeRow` 携带 12 个 computed，其中 `getDirChangeCount`（`fileTree.ts:90-102`）对每个目录行做 O(git 改动文件数) 扫描。展开 3000 文件目录 → 数万 DOM 节点 → 展开/滚动首帧卡顿数百 ms 到秒级。另一个反直觉事实：树上的 git 角标**只在 session 加载时拉一次，之后从不刷新**（`useFileTree.ts:56-79` 是 `setGitOverlay` 唯一调用点）——AI 写文件后树角标 stale，且 `useFileChangeInvalidation` 每 token 全量重扫 fileChanges 的成本**没有产出任何 UI 价值**。

**失败模式 C：高频终端输出掉帧（G3 的反面）。**
开发者在终端 tab 跑 `npm run build`。runtime 的 PTY `onData` 每个 chunk（1-4KB，高频命令可达每秒数百~上千 chunk）发一条 WS `terminal.data`；renderer 端每条消息 push 进 reactive scrollback → watch 触发 → 一次 `xterm.write`。无 rAF 合并、无背压节流，高频输出时主线程每秒被几千次 watch 回调与 write 打断。

**失败模式 D：首屏加载重（G4 的反面）。**
冷启动加载的主 JS chunk 实测 **2.34MB（gzip 684KB）**——xterm + 4 个 addon、shiki core、markdown-it、katex 全部静态 import 进首屏图（`TerminalView.vue:60-64` 静态 import xterm；`main.ts:3-4` 静态 import 字体与 katex css）。全库无一处 `defineAsyncComponent`。总产物 17MB（shiki 语法块已自动拆懒加载，这部分是好的）。

**失败模式 E：AI 连续写文件时主线程抖动 + 树角标不刷新（G2/G5 的反面）。**
AI 一轮修改 10 个文件：runtime `event-interpreter.ts:362-363` 每个 mutating tool（write/edit/bash）结束发一次 `sendDiffFileChanges('accumulating')`，agent_end 再发 `ready`；每次内部 `snapshotGitStatus` 执行 **execSync `git status`（本仓实测 0.35s/次）同步阻塞 runtime 主线程**——10 个文件 ≈ 11 次 ≈ 4s 阻塞。前端 `useFileChangeInvalidation.ts:45-71` 用 `{deep:true}` watch 整 `chatStore.messages`，每个 token 全量重扫该 session 全部消息的 fileChanges（纯浪费，见失败模式 B 的 stale 角标）。

### 2.2 根因分析

| # | 根因 | 对应失败模式 | 处置 |
|---|---|---|---|
| 根因 1 | **响应式失效扇出**：`messages = shallowRef<Map>` 每次 commit 整体替换 Map 身份 → 跨 session 失效 + 三层 computed 级联重算 | A（主因）、E | D-1/D-2/D-3 |
| 根因 2 | **渲染无增量**：turn 全量重建（无对象身份复用）+ markdown 全文重渲染（实测 10KB=18ms，已超帧预算） | A（次因） | D-4/D-5 |
| 根因 3 | **事件无批处理**：终端 chunk、file_changes 逐条透传，无合帧/节流 | C、E | D-6/D-9 |
| 根因 4 | **树模型无虚拟化**：递归组件全量渲染 + per-node computed + 徽章 O(n) 扫描 | B | D-7 |
| 根因 5 | **构建无分割**：重依赖静态 import 进首屏图 | D | D-8 |

### 2.3 关键术语（首次定义，后文沿用）

- **失效扇出**：响应式系统中一次状态写入触发的依赖重算范围。§1.1 里「commitMessages 替换 Map → 所有读 messages.value 的 computed 重算」就是跨 session 的失效扇出——这是失败模式 A 的第一根因。
- **token**：AI 流式回复的最小推送单位，一条 `message.text_delta` 消息携带一个 delta。
- **turn**：一轮「用户输入 → assistant 回复（含工具调用）」的展示单元，由 `toRenderItems` 从消息列表派生，是 virtua 虚拟列表的 item。
- **Map 分区派**（ADR-0049）：所有 per-session 状态用 `Map<sessionId, T>` 分区，杜绝实例级状态泄漏。本设计不推翻它，而是把它推得更彻底（见子文档 01）。
- **shallowRef 契约**（ADR-0039）：messages 的浅响应式决策，动机是消除万级深 proxy。本设计不推翻动机，只改粒度（见子文档 01）。

### 2.4 探明事实汇总（决策的事实依据）

**实测证伪（避免为不存在的成本做复杂优化）：**

| # | 假设 | 实测 | 影响 |
|---|---|---|---|
| F1 | 每 token 数组拷贝 + Map 重造是主要成本 | **证伪**：S=10/M=500 @25 commit/s 仅 0.1ms/秒 | D-1 论据改为「收敛失效扇出」 |
| F2 | O(n²) 字符串拼接是热成本 | **证伪**：100KB/1000 token 拼接 0.1ms（V8 cons-string） | R2 降级，chunk 缓冲仅服务于增量渲染 |
| F3 | scrollback splice 前删是热成本 | **证伪**：5000 稳态 10000 push 6.3ms | D-6 论据改为「watch/xterm.write/WS 帧数」 |
| F4 | 未闭合代码块每帧重高亮是热成本 | **证伪**：200 行代码块高亮 0.1ms/次 | markdown 成本在 parse + v-html，不在高亮 |

**实测确认（决定性事实）：**

| # | 事实 | 数据 |
|---|---|---|
| F5 | markdown 全量渲染是重活 | 10KB=18.1ms / 50KB=71ms / 200KB=253ms 每帧 |
| F6 | 主 bundle 2.34MB（684KB gzip）启动即加载；shiki 语法块已自动懒加载 | build 实测 |
| F7 | git status execSync 0.35s/次；file_changes = 每 mutating tool 1 次 + agent_end 1 次 | 本仓实测 + 代码 |
| F8 | `status:'streaming'` 写入点仅 3 处 + `finalizeMessages` 单点终态 + D-010 sealed 幂等；handoff 无直接 status 写 | 代码盘点 |
| F9 | 整 Map 直接消费者 3 处；watch 整 ref 2 处；getMessages 消费方 13 个接口不变；5 个测试文件直接断言 messages.value | 代码盘点 |
| F10 | turn UI 态三类：展开态→store、thinking/tool 折叠→组件本地、forceWorking→派生（仅虚拟 session） | 代码盘点 |
| F11 | fileTree 对外接口收敛（selectFile/selectedPath/gitOverlay/clearSession/loadTree） | 代码盘点 |
| F12 | ADR-0039 动机=消除深 proxy；ADR-0049 要求 Map 分区派——D-1 与两者兼容 | ADR 原文 |
| F13 | mock 14 deltas/s；真实 pi 假设 10-80/s（决策对此区间鲁棒） | mock 代码 |

---

## §3 解决方案（子系统划分）

**本节的结论：9 项决策全部拍板（§3.2 总表），按依赖关系切成 4 个子系统（P0-P3），各自的技术方案在 4 份子文档中展开；本层只定边界、依赖、优先级。**

### 3.1 终态（使用者视角）

实施完成后，§2 的失败模式对应的体验：

- **A 修复后**：开发者在 200+ 消息 session 里看流式回复，token 更新只触发「当前 session 的状态」与「视口内末位 turn」的重算；markdown 只重渲染未稳定段。token 密集段不掉帧，对话长度不敏感。
- **B 修复后**：开发者展开 3000 文件目录，只渲染视口 ± 缓冲区的行；过滤即时；AI 写文件后树角标在几秒内刷新。
- **C 修复后**：跑 `npm run build` 时终端输出每帧合并写入，主线程空闲；切走 tab 再回来，历史完好回放。
- **D 修复后**：冷启动首屏 JS gzip 显著下降；终端/设置等非首屏模块按需加载。
- **E 修复后**：AI 连续写文件不再阻塞 runtime 主线程；树角标随 file_changes 刷新。

### 3.2 决策总表（9 项，均已拍板）

| ID | 决策 | 选定方案 | 理由摘要（详见子文档） | 事实依据 |
|---|---|---|---|---|
| D-1 | 消息容器范式 | `Map<sid, shallowRef<Message[]>>`：Map 恒等稳定，每 session 数组独立 ref | 失效范围=单 session；接口不变（F9）；兼容 ADR-0039/0049（F12）；F1 证伪后本决策收益=失效扇出收敛 | F1/F9/F12 |
| D-2 | token coalescing | useChat 层 microtask 批量（同类型保序，终态即时 flush） | 测试面零影响；store 不承担调度职责 | F8/F13 |
| D-3 | streaming 状态派生 | per-session 惰性缓存 computed（并入 D-1 实施） | SSOT 仍是消息数组，零 drift；不引入与消息重复的计数状态 | F8 |
| D-4 | turn 派生层 | 消息对象身份增量复用 turn 对象 + Block 级 v-memo | D-1 的不可变性让「成员消息未变→turn 复用」判定精确；F10 显示 UI 态清单有限，memo 键可控 | F10 |
| D-5 | markdown 流式渲染 | 后缀增量渲染（前缀缓存到稳定边界，只渲染 tail）+ 未闭合 fence 占位 | F5 决定性：10KB 全量 18ms 已超帧预算，不增量必掉帧；F4 证伪高亮成本 | F4/F5 |
| D-6 | 终端输出模型 | 目标=命令式 buffer + 版本回放；第一步先落 rAF 写队列 | F3 证伪 splice 后，成本在 watch/xterm.write/WS 帧数；命令式模型最简 | F3 |
| D-7 | 文件树数据模型 | 目标=扁平可见列表 + virtua；第一步先徽章预聚合 + 防抖 | F11 消费面收敛；扁平化统一虚拟化/过滤/排序/徽章 | F11 |
| D-8 | 构建分割 | defineAsyncComponent 拆 TerminalView/DetailPane/设置页 + manualChunks | F6 数据充分，无争议 | F6 |
| D-9 | runtime 跨层配合 | git status execSync→execFile；accumulating 300ms debounce；ready 后 renderer debounce 300ms 回写 overlay | F7：0.35s×11 次=4s 阻塞；修复 F4 stale 角标 | F7 |

### 3.3 子系统划分（4 份子文档）

**边界与依赖**（`→` = 依赖）：

```
00 总纲（本文档）
├─ 01 P0 状态层（D-1/D-2/D-3）──→ 02/03 的前置（不可变身份、失效收敛）
├─ 02 P1 渲染层（D-4/D-5）─────→ 依赖 01 的不可变性；与 03 独立
├─ 03 P2 面板层（D-6/D-7/D-9）──→ D-6/D-7 两步走各自独立；D-9 含 runtime 改动
└─ 04 P3 构建与快赢（D-8 + Q1 集）→ 与 01-03 完全独立
```

| 子文档 | 范围 | 优先级 | 依赖 | 可独立验收性 |
|---|---|---|---|---|
| 01 P0 状态层 | D-1 容器范式、D-3 per-session computed、D-2 coalescing | **最高**（根因 1，是 02 的地基） | 无 | 每项可独立验收（见 01 §4） |
| 02 P1 渲染层 | D-4 turn 增量 + v-memo、D-5 markdown 增量渲染 | 高（根因 2，独立于 03） | 01 完成 | 独立验收 |
| 03 P2 面板层 | D-6 终端、D-7 文件树、D-9 runtime 跨层 | 中 | 01（D-7 的失效链受益于 01） | 三项各自独立 |
| 04 P3 构建与快赢 | D-8 构建分割 + Q1 快赢集（markers cache/i18n 懒加载等） | 低（可随时并行） | 无 | 独立验收 |

**为什么这么切**：① 01 是根因 1 的唯一归属，且 02 的 D-4 依赖 01 的不可变消息身份（切出去会丢失依赖关系）；② 02 与 03 面向不同失败模式（A vs B/C/E），拆开可并行实施与验收；③ 04 与性能架构无关（配置 + 单点修复），拆开不阻塞主线。

### 3.4 关键权衡（父层只定原则，细节在子文档）

- **D-1 与 D-3 合并实施**：D-3 的 per-session computed 只有 D-1 的 per-session ref 存在时才自然成立，分开做会产生中间态。
- **D-4 选择缓存而非归一化**：turn 实体归一化进 store 会引入与消息数组重复的第二份状态（drift 风险，违反 G5），F10 探明后确认 UI 态清单有限，缓存键可控——不归一化。
- **D-6/D-7 均两步走**：第一步快赢（rAF 队列 / 徽章预聚合）先消除高频成本，第二步模型重构（命令式 buffer / 扁平列表）按目标架构落位；两步之间有独立验收点。
- **D-5 的稳定边界判定规则与阈值留待实施期 tuning**：F5 证明必须增量，但「多长静默算稳定」「多长文档切增量」无真实用户数据，设计文档给出规则框架，阈值标为待验证（诚实标注，不编造）。

---

## §4 验收（全局真实场景）

**本节的结论：5 个全局验收场景直接回溯 G1-G5，用真实 dev 环境跑真实用例；子文档另有细分验收，本层只判全局是否达成。**

> 验证环境：`pnpm dev` 启动的真实 Electron 应用（renderer 9222 / runtime 3310），用真实仓库（本仓，>5000 文件）、真实 pi 会话或 mock 流（标注验证缺口）。

| 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|
| V1 长对话流式流畅 | ① 在真实 session 中让 AI 生成一段 50KB+ 带代码块的回复；② 流式期间滚动查看历史消息；③ 用 devtools Performance 录 token 密集段 | 流式期间帧率 ≥ 55fps；无 >100ms 长任务来自 chat store 提交链；滚动历史不卡 | G1 |
| V2 大仓库文件树 | ① 在本仓展开 `packages/` 大目录（数千文件）；② 在过滤框输入 `store`；③ AI 修改一个文件后观察树角标 | 展开/滚动首帧 <100ms；过滤输入即时（150ms 防抖内）；角标在 file_changes 后数秒内刷新 | G2 |
| V3 高频终端输出 | ① 打开终端 tab 跑 `npm run build`（或 `find / -name x` 之类高频输出命令）；② 输出期间滚动消息流 | 终端输出流畅、界面可交互；CPU 峰值明显低于改动前基线；切 tab 回来历史完整 | G3 |
| V4 首屏加载 | ① 冷启动应用；② 用 devtools Network/Performance 记录加载到可交互 | 首屏 gzip JS 总量较基线 684KB 显著下降（目标 <400KB）；TTI 提前 | G4 |
| V5 AI 写文件不阻塞 | ① 让 AI 一轮修改 ≥5 个文件；② 观察 runtime 进程与 UI 响应 | runtime 主线程无 >100ms 的 git 相关阻塞；前端 fileChanges watcher 不在 token 路径触发全量重扫（devtools 探针） | G5 |

**验证缺口说明**：V1 若无真实模型可用，mock 流（70ms/chunk）可验证渲染路径但无法覆盖真实 token 速率上限——实施时优先争取真实 pi 会话；V5 依赖真实 AI 工具调用，无法 mock。

---

## §5 下一层拆分

**本节的结论：下一层 = 4 份子文档，每份是「技术方案设计」层（接口先行 + 数据模型 + 错误规格 + 真实验收）；实施顺序 01→02→03→04。**

| 子文档 | 下一层产物 | justification |
|---|---|---|
| `01-p0-state-layer.md` | D-1 容器范式 + D-3 per-session computed + D-2 coalescing 的接口/数据模型/错误规格 | 根因 1 唯一归属；02 的地基；改动面横跨 core + 5 个测试文件，必须接口先行 |
| `02-p1-render-layer.md` | D-4 turn 增量缓存/v-memo + D-5 markdown 增量渲染的渲染协议与边界判定规则 | 根因 2 归属；F5 证明必须增量；协议设计决定 ui 层组件契约 |
| `03-p2-panel-layer.md` | D-6 终端写队列/命令式 buffer + D-7 树扁平化/虚拟化 + D-9 runtime 跨层（含 WS 通道与节流归属） | 三个独立失败模式的合集，各自可独立验收；D-9 含 runtime 改动需单独验证流程 |
| `04-p3-build-and-quickwins.md` | D-8 构建分割配置 + Q1 快赢清单（每项一句话方案+验收） | 与主线无依赖，可随时并行；快赢项分散在 6+ 文件，集中管理避免遗漏 |

**实施路径**：01（状态层，含 D-3）→ 02（渲染层）→ 03（面板层三项可并行）→ 04（构建与快赢，可与前三批并行）。每批完成后跑 §4 对应验收场景，通过才进下一批。

**待验证检查点（设计阶段诚实标注）**：
1. 真实 pi token 到达率（F13 是假设区间）——影响 D-2 合并窗口收益上界，不影响方案选择。
2. D-5 稳定边界阈值（静默时长、文档长度切点）——需真实使用数据 tuning。
3. V1/V5 验收场景的真实模型可用性。

---

## 附录：变更历史

- 2026-08-15：初版。基于六模块性能分析（M1-M7）+ 13 项探明事实 + 9 项决策（D-1~D-9）成文。
