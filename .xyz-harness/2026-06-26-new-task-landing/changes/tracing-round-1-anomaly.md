---
converged: false
---

# Tracing Round 1 — 异常猎手（失败帧）

> 独立异常猎手 subagent，上下文与主 agent 隔离。假设 issues.md 错且不全。
> 戴「失败帧」对每个 issue / ②元素按 hunting 清单（异常路径/边界值/并发时序/状态机死角/删除测试）找未覆盖面。
> 维度标签：**[异常]** error/fallback/超时/重试/降级 · **[边界]** 空/单/极大极小 · **[并发]** race/幂等/乱序 · **[死角]** 状态机不可达/缺转移/卡死 · **[删除]** 伪issue检测

## 未处理清单（26 条）

> 分类：F=二次确认（事实核对） · K=问用户（产品决策） · D=agent 自决（技术细节）

### #1 sessionApi cwd 透传

- **A1 [D][并发] #1**: 新建触发点无幂等保护——用户双击 sidebar+ 或 ⌘N 与 click 同时到达 composable，可能创建 2+ 空 session。AC 群零覆盖防抖/去重。
- **A2 [D][异常] #1**: session.create 业务校验通过但 **pi spawn 失败**（cwd 无读权限/pi 二进制损坏/子进程立即 exit）的半创建态——session 实体已建但 pi 句柄无效。AC-1.3 仅覆盖「非法路径 create 失败」，未覆盖 create 成功后 spawn 失败的回滚/状态。
- **A3 [K][边界] #1+BC-2**: 首次启动 session list 为空 → resolveDefaultCwd 返回 undefined → runtime 回退 `process.cwd()`（app 启动目录）。该目录对用户语义未定义（可能是 /Applications 或 Electron 资源目录），是否合理需用户裁决。

### #2 landing 组件 + 空态判据

- **A4 [D][异常] #2**: getHistory 加载**失败**（WS 断连/runtime 抛错）时 messages 永不 hydrate。AC-2.3「未 hydrate 乐观视为空」会导致 landing **永久卡住**，无失败出口/无超时/无重试。仅覆盖了「加载中」未覆盖「加载失败」。
- **A5 [D][边界] #2**: AC-2.4「isGenerating=true 且 messages 空显示生成态」——但 landing 组件内的**生成态 UI 分支未定义**（landing 与生成态是互斥渲染还是 landing 内含生成子态？）。
- **A6 [D][并发] #2**: 多空 session 快速切换时 messages Map 派据串台——未 hydrate session 的 `messages.get(sessionId)` 返回 undefined，`.size` 判断（0 vs undefined→falsy）边界未明确，切台时序下可能误判。

### #3 useNewTaskFlow composable（状态机重点）

- **A7 [D][死角] #3**: **状态机缺「session 切换」全局中断转移**。② §5 的 17 转换中，仅 `landing --> cancelled`（切到别的 session）。4 个 overlay 态（dir-popover/branch-popover/dir-dialog/branch-modal）**均无 →cancelled 边**。overlay 打开时用户点 sidebar 切 session → 状态机无合法转移 → 卡死或非法转换抛错。这是 NewTaskFlowState 的系统性死角。
- **A8 [D][死角] #3**: overlay 打开期间**当前 session 被外部删除**（sidebar 右键删 session / runtime 清理）——状态机无「session 失效」转移，卡在 overlay（dir-dialog 尤其，OS dialog 还在飞）。
- **A9 [D][异常] #3**: AC-3.1「非法转换抛错」后的**恢复策略未定义**——抛错后状态机停在非法态还是回安全态（idle/landing）？Vue 未捕获 error 可能崩组件，无错误边界兜底。
- **A10 [F][死角] #3**: **completed 后再触发新建的实例模型/重置路径未定义**。② §5「completed 是唯一终态，NewTaskFlow 销毁」，但覆盖表把「②移交⑤ NewTaskFlow 实例模型」标 N/A。completed 后 ⌘N 再触发是新建 NewTaskFlow 实例还是复用单实例重置？状态机如何从 completed 回 idle/landing？issues.md 既 N/A 了该确认项又未在 #3 内定义重置路径，逻辑断裂。

### #4 recentWorkspaces + resolveDefaultCwd

- **A11 [D][边界] #4**: session list 含 **cwd=null/undefined 脏数据**（老 session 无 cwd 字段 / runtime 异常产物）——distinct 去重时跳过还是归入 undefined 组？派生函数对脏输入的鲁棒性 AC 未覆盖。
- **A12 [D][边界] #4**: 多 session **同 cwd** 时 distinct 去重后 lastActiveAt 取值规则未定义（取最新/最早/合并），AC-4.1 仅说「按 lastActiveAt 倒序」未说同 cwd 合并策略。

### #5 directory popover + OS dialog

- **A13 [D][异常] #5**: pick-directory IPC **本身失败**——BC-7 handler 依赖 `getFocusedWindow()`，全屏其他 app / 无 focused window 时 IPC 抛错。AC-5.3 仅覆盖「用户取消（canceled=true）」，未覆盖「handler 抛错」，popover 无失败处理。
- **A14 [D][异常] #5**: 用户选**不可读目录**（权限拒绝）——OS dialog 允许选，但后续 session.create 用该 cwd 失败（A2），错误反馈落在 #1 而 popover 已关闭，用户感知割裂。跨 issue 错误链路未定义。

### #6 branch popover + dirty + unborn

- **A15 [F][异常] #6/AC-6.2**: **dirty「确认切走（留在工作区，不自动 stash）」语义自相矛盾**。「切走」=切换到目标分支？还是「留在当前工作区不切换」？AC-6.2 同一句里两个对立动作。实际 git 操作（执行 checkout？不执行？丢弃 dirty？）未定义，验收标准本身有缺陷，需用户澄清。
- **A16 [D][异常] #6**: getStatus **无缓存**（git-info 有 5min TTL cache，getStatus 未提及）——每次开 branch popover 都 spawn git status，频繁切换性能影响。② §7 未定义 getStatus 缓存策略。
- **A17 [D][边界] #6**: 分支列表**极多**（100+ 分支的大仓库）——popover 渲染性能/虚拟滚动/搜索过滤未定义。AC-6.1 仅「显示分支列表」未覆盖大量数据。
- **A18 [D][并发] #6**: getStatus 同步阻塞 event loop 期间用户 Esc popover——阻塞执行与状态转移的时序未定义（execSync 期间 JS 单线程冻结，Esc 事件排队，阻塞结束才处理）。

### #7 create-branch modal + GitService.createBranch

- **A19 [D][异常] #7**: createBranch **execSync hang**（.git/index.lock 被其他进程持有 / git 等待输入）——execSync 无原生超时，永久阻塞 runtime event loop。AC-7.3「失败显错」仅覆盖命令返回非零，未覆盖**永久 hang**（命令不返回）。
- **A20 [D][边界] #7**: 分支名**校验规则不全**——AC-7.2 仅「空」「已存在」，git 分支命名规则（禁空格/特殊字符/`..`/`-`开头/`~^:` 等）未覆盖。git 拒绝非法名时错误链路（execSync 抛错 → 前端如何映射到 input 校验态）未定义。
- **A21 [D][边界] #7**: **detached HEAD / worktree** 下 `git checkout -b` 限制未覆盖——② §7 GitInfo 已读 isWorktree，但 createBranch 在 worktree 下的行为（worktree 限制 checkout/HEAD 引用）未处理。
- **A22 [D][并发] #7**: createBranch **promise 飞行中用户 Esc modal**——WS 调用未返回时 modal 已关（branch-modal → branch-popover），返回后孤儿 promise 如何处理（状态已变，无法回灌 chip）。AC-7.1「成功落回 landing」未覆盖「用户已离开」。
- **A23 [D][并发] #7**: 提交按钮**防重复点击**未定义——双击提交可能触发两次 git.createBranch。

### #8 forkSession 波及

- **A24 [D][异常] #8**: 源 session 的 **cwd 已不存在**（创建后被删）——forkSession 传入无效 cwd，session.create 行为/错误反馈未覆盖。

### ② 元素 / 跨 issue 系统性 gap

- **A25 [K][边界] ②§4**: **空 session 累积无清理策略**——② §4 明示「空 session 创建后永久保留（无自动清理）」。用户频繁新建不发送会导致空 session 无限堆积，sidebar/overview 膨胀。issues.md 无清理/上限/GC issue，属产品体验决策。
- **A26 [D][异常] 跨issue**: **WS 断连 / runtime 崩溃全局处理零覆盖**。所有 WS 调用（#1 session.create / #6 getStatus / #7 createBranch）及 landing 态假设 runtime 稳定。runtime 进程崩溃/重启时飞行中请求、landing 态 session 失效、pi 句柄丢失的感知与恢复，issues.md 完全未涉及。
- **A27 [K][异常] 跨issue**: **错误反馈 UI 载体未统一**——多 AC「显错」「留 modal 显错」「composer 子态显错」散落，未定义统一载体（xyz-ui toast？inline？各组件自绘？），跨 issue 一致性未定，属 UX 决策。
- **A28 [D][异常] ②§10 D-5**: **git-info 裸 execSync 异常处理**——BC-6 仅覆盖「非 git 目录返回 undefined」，但 execSync **抛错**（git 未安装/权限拒绝/命令异常）时 toSummary 行为未定义。git-info 是分层债（services 层裸 execSync），其异常路径与 GitService.getStatus（#6）异常处理是否同源未明确。
- **A29 [D][异常] ②§8**: **pi 子进程 spawn 后崩溃检测**——session create 成功但 pi 子进程立即 exit（cwd 有效但 pi 启动失败），landing 态无感知机制（landing 判据只看 messageCount + isGenerating，不看 pi 存活）。
- **A30 [D][边界] ②§7**: **6 触发点语义差异**——BC-8 列出 Sidebar/SessionList/PanelHeader/Workspace/Overview/PanelContainer 统一接入 composable，但 `PanelContainer.vue:69 newSessionToStandby` 与其他 `newSession` 语义不同（standby vs active），统一接入是否破坏 standby 语义未评估。

## 删除测试结论（伪 issue 检测）

逐 issue 问「不做它会怎样」：#1~#8 全部「不做则对应业务目标/UC 破坏或静默坏掉」，**无伪 issue**。但发现一项验收标准缺陷：

- **AC-6.2 语义自相矛盾**（见 A15）——非伪 issue，但验收标准定义本身需修正后方可作为测试依据。

## 维度覆盖统计

| 维度 | 条数 | 编号 |
|------|------|------|
| 异常路径 | 13 | A2 A4 A8 A9 A13 A14 A15 A19 A22 A24 A26 A28 A29 |
| 边界值 | 8 | A3 A5 A11 A12 A17 A20 A21 A25 A30 |
| 并发时序 | 5 | A1 A6 A18 A22 A23 |
| 状态机死角 | 3 | A7 A8 A10 |
| 伪 issue | 0 | （AC-6.2 验收标准缺陷，非伪 issue） |

## 分类统计

| 分类 | 条数 |
|------|------|
| F（二次确认） | 2（A10 A15）|
| K（问用户） | 4（A3 A25 A27 + A15 双标）|
| D（agent 自决） | 21 |

## 优先建议（供收敛）

- **P0 阻塞项**：A7（状态机 session 切换死角，影响所有 overlay）、A15（AC-6.2 语义缺陷，验收标准不可用）、A26（WS 断连全局处理，影响所有 WS 调用）。
- **P1 核心项**：A2/A4/A9（异常路径无出口）、A8/A10（状态机死角与重置）、A19（execSync hang）、A28（git-info 异常）。
- **P2 边界项**：A1/A6/A18/A22/A23（并发）、A11/A12/A17/A20/A21（边界值）、A29/A30（pi/触发点语义）。
- **产品决策**：A3/A25/A27。
