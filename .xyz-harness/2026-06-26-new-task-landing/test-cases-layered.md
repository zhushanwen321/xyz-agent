---
verdict: pass
upstream: execution-plan.md, code-architecture.md
downstream: coding
---

# 测试用例分层映射 — 新建任务

> 把 [execution-plan.md](execution-plan.md)「测试验收清单」的 39 个用例（T1.1-T8.6，按业务 UC 归类）重新归类到 **单测 / 集成 / E2E 替代（手工+端到端集成）** 三层，指定文件落位与 describe/it 命名。
> 编码阶段的测试落位 SSOT。用例集合 = execution-plan.md 清单全量（39），无遗漏无多余。

## 分层定义（主 agent 已定，本文遵循）

| 层 | 定义 | mock 边界 |
|----|------|----------|
| **unit（单测）** | 纯函数 / 单 composable 状态机 / 单 store action / 单 API 契约函数 / 单 port 实现 / 单组件交互 | mock 全部外部依赖（api 域、IPC、port、store 派生） |
| **integration（集成）** | 跨多模块链路（composable + store + 组件 + mock api），验证数据跨层流转 | 只 mock 最外层边界（api 域调用、IPC、port），内部模块真接线 |
| **manual（E2E 替代）** | v1 不引入 Playwright。涉及 OS 原生 dialog / 真实 git 进程 / 真实 Electron 窗口的用例，自动化只覆盖前端可 mock 分支，真实走查放 Wave 4 手工清单 | — |

**多类型用例约定**：跨前后端的用例（T1.1/T4.1/T4.5/T6.1/T6.3/T6.4 等）既需 runtime port 单测又需前端链路集成，「类型」列写多值（如 `unit+integration`），实现阶段两者都要写。

---

## ★ 39 用例分层映射大表

> 列说明：**类型** = 该用例需要写的测试层（多值表示拆多个测试）；**主类型** 用于统计。文件路径前缀：前端 `src-electron/renderer/src/__tests__/new-task/`，runtime `src-electron/runtime/test/new-task/`。

### Wave 1：主流程垂直切片（16 用例）

| 用例 ID | 类型（主） | 被测函数/组件 | 测试文件 | describe / it 建议 | mock 依赖 | 关联 AC | 备注 |
|---------|-----------|--------------|---------|-------------------|----------|--------|------|
| T1.1 | integration（+unit 配套） | useNewTaskFlow.startFlow 全链路 + sessionApi.create 透传 | 前端 `flow-integration.test.ts`（+ `session-api.test.ts`） | `describe('⌘N 主流程')`：`it('startFlow→resolveDefaultCwd→create(cwd)→state=landing 且 chip 回灌')`；配套 `describe('sessionApi.create')`：`it('cwd 透传至 payload，cwd=undefined 时 payload 不含 cwd')` | integration 边界：mock `sessionApi.create` 返回 SessionSummary，**不 mock** useNewTaskFlow/store/resolveDefaultCwd。unit 配套：mock transport/pending | AC-1.1 | integration 验全链路；sessionApi cwd 透传是 T1.1 的 api 层片段，单独 unit |
| T1.2 | unit | useNewTaskFlow.startFlow 首次启动分支 | 前端 `use-new-task-flow.test.ts` | `describe('startFlow 首次启动边界')`：`it('sessions=[]→cwd=undefined→不调 create、currentSessionId=null、state=landing、chip 空态+发送 disabled')` | mock sessionApi.create（断言 not called）、mock store sessions=[] | AC-1.7 | 延迟 create 分支，纯状态机 |
| T1.3 | integration | useNewTaskFlow.startFlow in-flight 守卫 | 前端 `flow-integration.test.ts` | `describe('⌘N 主流程')`：`it('create 飞行中再次 startFlow→in-flight 标记忽略，sessionApi.create 只被调一次')` | mock sessionApi.create 返回 pending Promise（不 resolve），真跑 startFlow 两次 | AC-1.5 | 双击并发幂等，跨触发点→composable→api |
| T1.4 | integration | useNewTaskFlow.startFlow 非法 cwd reject | 前端 `flow-integration.test.ts` | `it('create 非法 cwd→sessionApi reject→显错且不静默回退、不留半创建态')` | mock sessionApi.create reject（非法 cwd），验证 state/显错 | AC-1.3 | E2 显错链路 |
| T1.5 | integration | useNewTaskFlow.startFlow spawn 失败回滚 | 前端 `flow-integration.test.ts` | `it('create reject(spawn 失败)→回滚 session 实体、currentSessionId 不绑定僵尸 session')` | mock sessionApi.create reject，mock sessionApi.remove 验证回滚调用 | AC-1.6 | E3 回滚，跨 create→delete |
| T1.6 | unit | Landing.vue / Panel.vue 渲染条件 | 前端 `landing.test.ts` | `describe('Landing 渲染条件')`：`it('messageCount===0 && !isGenerating→渲染 landing')` | mount 组件，mock useChatStore（messageCount/isGenerating） | AC-2.1 | 纯渲染判据 |
| T1.7 | unit | Landing.vue / Panel.vue isGenerating 优先 | 前端 `landing.test.ts` | `it('messages 空但 isGenerating=true→不渲染 landing（生成态优先）')` | mount 组件，mock store isGenerating=true | AC-2.8 | 纯渲染判据 |
| T1.8 | unit | Landing.vue 重试按钮 | 前端 `landing.test.ts` | `describe('Landing getHistory 失败')`：`it('getHistory 失败→渲染重试按钮，点击重新拉取，不永久卡住')` | mount 组件，mock chatApi.getHistory reject，验证重试 emit | AC-2.6 | NFR 稳定性，组件交互 |
| T1.9 | unit（独立 ticket #8） | useSidebar.forkSession cwd 透传 | 前端 `fork-session.test.ts` | `describe('forkSession cwd 透传')`：`it('fork→sessionApi.create 收到源 session cwd，非最近活跃 cwd')` | mock sessionApi.create 捕获入参，mock 源 session | AC-8.1/8.2 | 独立 PR，不阻塞主交付 |
| T7.1 | unit | useNewTaskFlow.openBranchPopover 守卫 | 前端 `use-new-task-flow.test.ts` | `describe('UC-7 非 git 守卫')`：`it('gitInfo==null→openBranchPopover 抛错回 idle，状态机只走 idle↔landing↔dir-popover↔dir-dialog 子集')` | mock store gitInfo=null，mock sessionApi | AC-3.7/2.2 | 纯状态机守卫 |
| T7.2 | manual | branch chip 恢复显示（依赖外部 git init + git-info 缓存 TTL） | —（手工清单） | 手工：非 git 目录下外部 `git init` → 重开 popover / 等缓存 TTL → branch chip 恢复 | — | AC-7.2 | 依赖外部 git init + 既有 git-info 缓存（本期不改 git-info），难自动化 |
| T8.1 | unit | useNewTaskFlow overlay 互斥 | 前端 `use-new-task-flow.test.ts` | `describe('overlay 互斥')`：`it('dir-popover 下触发 openBranchPopover→先关 dir-popover 再开 branch-popover，至多 1 个 overlay')` | mock store gitInfo 非 null，mock api | AC-3.2 | 纯状态机 |
| T8.2 | unit | useNewTaskFlow Esc 优先级 | 前端 `use-new-task-flow.test.ts` | `describe('Esc 优先级')`：`it('modal 内 Esc→只关当前 modal，不影响 composer/浮层')` | mock api，emit Esc | AC-3.9 | 纯状态机 |
| T8.3 | unit | useNewTaskFlow overlay 态切 session | 前端 `use-new-task-flow.test.ts` | `describe('overlay 切 session')`：`it('dir-dialog 打开时切 session→overlay 自动关 + state=cancelled，不卡死')` | mock sessionApi，切换 store activeId | AC-3.10 | 纯状态机 |
| T8.4 | unit | useNewTaskFlow cancelled 重入 | 前端 `use-new-task-flow.test.ts` | `describe('cancelled 重入')`：`it('切回空 session→state=cancelled→reenterFlow→landing 复活')` | mock store，mock api | AC-3.3 | 纯状态机 |
| T8.5 | unit | useNewTaskFlow completed 终态 | 前端 `use-new-task-flow.test.ts` | `describe('completed 终态')`：`it('首条消息成功→completeFlow→state=completed→⌘N 再触发→销毁重建 idle→landing')` | mock sessionApi.create（验证重建时新调用），mock store | AC-3.6/3.12 | 纯状态机 |
| T8.6 | unit | useNewTaskFlow 非法转换 | 前端 `use-new-task-flow.test.ts` | `describe('非法转换')`：`it('idle 下直接 openBranchModal→抛错回 idle，Vue 错误边界兜底不崩')` | mock api，触发非法转换捕获错误 | AC-3.1/3.11 | 纯状态机 |

### Wave 2：选目录 + 选分支 popover（14 用例）

| 用例 ID | 类型（主） | 被测函数/组件 | 测试文件 | describe / it 建议 | mock 依赖 | 关联 AC | 备注 |
|---------|-----------|--------------|---------|-------------------|----------|--------|------|
| T3.1 | integration | useNewTaskFlow.selectWorkspace 全链路 | 前端 `flow-integration.test.ts` | `describe('选目录链路')`：`it('点 recentWorkspaces 列表项→selectWorkspace(cwd)→cwd 变则 delete 空旧+create 新→state=landing 且 chip 回灌；cwd 未变则 noop')` | mock sessionApi.delete/create（验证调用序列），**不 mock** useNewTaskFlow/recentWorkspaces | AC-5.1 | 跨 composable+api+store |
| T3.2 | unit | DirSelectPopover.vue 空态 | 前端 `dir-select-popover.test.ts` | `describe('DirSelectPopover 空态')`：`it('recentWorkspaces 返回 []→渲染空态文案')` | mount 组件，mock composable recentWorkspaces=[] | AC-5.4 | 单组件交互 |
| T3.3 | integration（+manual） | useNewTaskFlow.openDirDialog OS dialog 选中分支 | 前端 `flow-integration.test.ts` | `describe('OS dialog 分支')`：`it('pickDirectory 返回 canceled=false+path→delete 旧+create(newCwd)→state=landing 且 chip 回灌新 cwd')` | mock `window.electronAPI.pickDirectory` 返回 `{canceled:false,path}`，mock sessionApi.delete/create | AC-5.2 | 真实 OS dialog 走手工（见 manual 清单） |
| T3.4 | integration（+manual） | useNewTaskFlow.openDirDialog 取消分支 | 前端 `flow-integration.test.ts` | `it('pickDirectory 返回 canceled=true→落回 dir-popover，chip 不变，不调 delete/create')` | mock pickDirectory 返回 `{canceled:true}`，断言 sessionApi 未被调 | AC-5.3 | 真实 dialog 取消走手工 |
| T3.5 | integration | useNewTaskFlow.openDirDialog IPC 抛错 | 前端 `flow-integration.test.ts` | `it('pickDirectory reject(getFocusedWindow null)→popover 显错 toast，不崩、state 不卡死')` | mock pickDirectory reject，捕获 toast/error emit | AC-5.6 | E5 IPC 错，前端可 mock 分支 |
| T4.1 | unit（+integration 配套） | runtime GitService.checkout + 前端 selectBranch chip 回灌 | runtime `git-service.test.ts`（+ 前端 `flow-integration.test.ts`） | runtime `describe('GitService.checkout')`：`it('干净分支→execSafe(cwd,checkout,[name]) exit 0→resolve')`；前端配套 `describe('选分支链路')`：`it('selectBranch(name)→gitApi.checkout→state=landing 且 chip 回灌')` | runtime：mock IGitExecutor.exec 返回 exit 0。前端 integration：mock gitApi.checkout resolve，**不 mock** useNewTaskFlow | AC-6.1 | runtime port 单测是核心；前端 chip 回灌模式与 T3.1 同，配套 integration |
| T4.2 | integration | useNewTaskFlow.confirmDirtySwitch dirty 确认 | 前端 `flow-integration.test.ts` | `describe('dirty 确认条')`：`it('选 dirty 分支→弹确认条→确认→gitApi.checkout(name)→未提交改动留工作区（不 stash）→state=landing')` | mock gitApi.status 返回 dirty，mock gitApi.checkout resolve，验证不调 stash 相关 api | AC-6.2 | 跨 status→确认→checkout，留工作区语义 |
| T4.3 | unit（+manual） | BranchSelectPopover.vue unborn 空态 | 前端 `branch-select-popover.test.ts` | `describe('unborn HEAD')`：`it('status 返回 isRepo=true 且无分支/unborn→渲染空态文案+引导首次 commit')` | mount 组件，mock gitApi.status 返回 unborn 结构 | AC-6.3 | 真实 unborn git 仓库走手工 |
| T4.4 | unit | useNewTaskFlow.openBranchPopover + Landing chip 可见性 | 前端 `use-new-task-flow.test.ts` | `describe('UC-7 非 git 不可达')`：`it('gitInfo==null→branch chip 隐藏、openBranchPopover 抛错不可达')`（与 T7.1 同源，此处聚焦 chip 隐藏断言） | mock store gitInfo=null | AC-3.7 | 状态机守卫，与 T7.1 共文件 |
| T4.5 | unit | runtime GitService.checkout 冲突 + composable 留 popover | runtime `git-service.test.ts` + 前端 `use-new-task-flow.test.ts` | runtime `it('目标分支冲突→execSafe 非 0→throw GitError')`；composable `it('gitApi.checkout reject→catch 留 branch-popover 显错，state 不进 landing')` | runtime：mock IGitExecutor 非 0。composable：mock gitApi.checkout reject | AC-6.4 | E8 双侧 unit，工作区不变语义走手工抽查 |
| T4.6 | unit | BranchSelectPopover.vue getStatus 失败 | 前端 `branch-select-popover.test.ts` | `describe('getStatus 失败')`：`it('gitApi.status reject→popover 显错不崩，列表空')` | mount 组件，mock gitApi.status reject | AC-6.4 | 单组件错误处理 |
| T4.7 | manual（条件性） | getStatus per-cwd 缓存命中零 spawn | —（手工清单） | 手工：仅当实现期 P99>200ms 触发加缓存时才验；v1 不加缓存则标 `[DEVIATED]④NFR 允许 v1 不加缓存` | — | AC-6.8(加缓存后) | 条件性用例，见 execution-plan.md D-6 |
| T4.8 | unit（+manual） | useNewTaskFlow Esc 排队 | 前端 `use-new-task-flow.test.ts` | `describe('Esc 排队')`：`it('gitApi.status pending 期间 emit Esc→resolve 后状态机按队列转移，不丢事件')` | mock gitApi.status 返回可控 pending Promise，期间 emit Esc，手动 resolve | AC-6.7 | 前端可 mock 排队语义；真实 execSync 阻塞走手工 |
| T4.9 | unit | BranchSelectPopover.vue 虚拟滚动 | 前端 `branch-select-popover.test.ts` | `describe('虚拟滚动')`：`it('分支 100+→渲染 DOM 节点数受限 + 搜索过滤命中，不卡')` | mount 组件，mock gitApi.status 返回 100+ 分支，断言渲染节点数/搜索 | AC-6.9 | 组件渲染性能 |

### Wave 3：创建分支 modal + runtime port（8 用例）

| 用例 ID | 类型（主） | 被测函数/组件 | 测试文件 | describe / it 建议 | mock 依赖 | 关联 AC | 备注 |
|---------|-----------|--------------|---------|-------------------|----------|--------|------|
| T6.1 | unit（+integration 配套） | runtime GitService.createBranch + 前端 submitCreateBranch chip 回灌 | runtime `git-service.test.ts` + 前端 `flow-integration.test.ts` | runtime `describe('GitService.createBranch')`：`it('合法名→execSafe(cwd,checkout,[-b,name]) exit 0→resolve')`；前端配套 `describe('创建分支链路')`：`it('submitCreateBranch(name)→gitApi.createBranch→state=landing 且 chip 回灌新分支')` | runtime：mock IGitExecutor exit 0。前端：mock gitApi.createBranch resolve，**不 mock** useNewTaskFlow | AC-7.1 | runtime port 核心；前端链路 integration |
| T6.2 | unit | CreateBranchModal.vue 分支名校验 | 前端 `create-branch-modal.test.ts` | `describe('分支名校验')`：`it('名含空格/..特殊字符→提交按钮 disabled + 错误提示')` | mount 组件，mock composable，驱动输入 | AC-7.8 | 单组件交互，前端实时校验 |
| T6.3 | unit | runtime GitService.createBranch 已存在 + Modal 留 modal | runtime `git-service.test.ts` + 前端 `create-branch-modal.test.ts` | runtime `it('分支已存在→execSafe 非 0→throw GitError(git_failed)')`；modal `describe('失败留 modal')`：`it('createBranch reject(已存在)→modal 不关、显错、可重试（D-7）')` | runtime：mock IGitExecutor 非 0。modal：mock gitApi.createBranch reject，mount 组件验证 modal 仍在 | AC-7.2/7.3 | E10，D-7 不关 modal |
| T6.4 | unit | runtime GitService.createBranch 超时 + Modal 超时留 modal | runtime `git-service.test.ts` + 前端 `create-branch-modal.test.ts` | runtime `it('execSafe ETIMEDOUT→throw GitError(timeout)（port 8000ms 继承）')`；modal `it('createBranch reject(超时)→留 modal 显错「git 操作超时」')` | runtime：mock IGitExecutor throw ETIMEDOUT。modal：mock gitApi.createBranch reject(timeout) | AC-7.7 | E11，port 超时链 |
| T6.5 | unit | useNewTaskFlow.openBranchModal 来源守卫 | 前端 `use-new-task-flow.test.ts` | `describe('openBranchModal 来源守卫')`：`it('非 branch-popover 来源→抛错回 idle（AC-3.8）')` | mock api，从非法 state 触发 | AC-3.8 | E9 纯状态机守卫 |
| T6.6 | unit | CreateBranchModal.vue 飞行中 disabled | 前端 `create-branch-modal.test.ts` | `describe('飞行中防重复')`：`it('createBranch pending→提交按钮 disabled，重复点击不触发第二次')` | mount 组件，mock gitApi.createBranch 返回 pending，断言调用次数 | AC-7.9 | 单组件并发 |
| T6.7 | unit | CreateBranchModal.vue 飞行中 Esc 孤儿 promise | 前端 `create-branch-modal.test.ts` | `describe('飞行中 Esc')`：`it('createBranch pending 时 Esc 关 modal→后续 resolve 被忽略，不回灌 chip')` | mount 组件，mock pending，emit Esc，后手动 resolve，断言 chip 未变 | AC-7.9 | 孤儿 promise，组件级 |
| T6.8 | unit | runtime GitService.createBranch 分支名二次校验 | runtime `git-service.test.ts` | `describe('runtime 分支名二次校验')`：`it('绕过前端直调 createBranch 非法名→runtime 拒绝 throw GitError（不触达 exec）')` | 直调 GitService.createBranch（不经前端），传入非法名，断言 exec 未被调 + 抛错 | AC-7.8 | NFR 安全，runtime 兜底 |

---

## 分层统计

### 用例主类型分布（39 用例）

| 层 | 数量 | 占比 | 用例 ID |
|----|------|------|---------|
| **unit** | 28 | 72% | T1.2, T1.6, T1.7, T1.8, T1.9, T7.1, T8.1-T8.6, T3.2, T4.1, T4.3, T4.4, T4.5, T4.6, T4.8, T4.9, T6.1-T6.8 |
| **integration** | 9 | 23% | T1.1, T1.3, T1.4, T1.5, T3.1, T3.3, T3.4, T3.5, T4.2 |
| **manual** | 2 | 5% | T7.2, T4.7 |

### 各 Wave 分布

| Wave | unit | integration | manual | 合计 |
|------|------|-------------|--------|------|
| Wave 1 | 11（含 T1.9 独立 ticket） | 4 | 1 | 16 |
| Wave 2 | 8 | 5 | 1 | 14 |
| Wave 3 | 8 | 0 | 0 | 8 |
| 独立 ticket #8 | 1（T1.9） | 0 | 0 | 1 |
| **合计** | **28** | **9** | **2** | **39** |

### 配套测试（主类型之外需额外编写，不计入 39 用例统计）

| 配套类型 | 来源用例 | 落位 | 数量 |
|---------|---------|------|------|
| runtime port unit | T1.1（sessionApi cwd 透传契约）、T4.1/T4.5（GitService.checkout）、T6.1/T6.3/T6.4/T6.8（GitService.createBranch） | runtime `git-service.test.ts` / `git-message-handler.test.ts` / `git-executor-port.test.ts` | 7 |
| 前端 integration（chip 回灌模式） | T4.1（selectBranch→chip）、T6.1（submit→chip） | 前端 `flow-integration.test.ts` | 2 |
| manual 真实走查 | T3.3/T3.4（真实 OS dialog）、T4.3（真实 unborn 仓库）、T4.8（真实 execSync 阻塞）、T4.5（真实工作区不变） | Wave 4 手工清单 | 4 |

> **预计测试文件**：前端 9 个 + runtime 4 个 = 13 个测试文件。**预计 it 用例**：~45-50 个（39 主 + ~10 配套）。

---

## 文件落位约定

### 选择：子目录（推荐）

前端新建 `__tests__/new-task/` 子目录，runtime 新建 `test/new-task/` 子目录。

**理由**：
1. 新建任务测试函数密度高（13 文件 / ~50 it），平铺到现有 `__tests__/`（9 文件）和 `test/`（70+ 文件）会被淹没，子目录聚合便于 Wave 4 验收时定位
2. 与功能模块目录 `components/new-task/` 对称，命名即归属
3. 现有平铺风格保留给"跨功能/基础设施"测试；功能密集型新模块用子目录是合理演进（runtime 已有 `fixtures/` 子目录先例）
4. v1 不引入 Playwright，无需单独 e2e 目录，manual 用例进 Wave 4 手工清单文档

### 前端落位（`src-electron/renderer/src/__tests__/new-task/`）

| 文件 | 类型 | 覆盖用例 |
|------|------|---------|
| `use-new-task-flow.test.ts` | unit | T1.2, T7.1, T4.4, T4.5(composable), T4.8, T8.1-T8.6, T6.5 |
| `lib-utils.test.ts` | unit | resolveDefaultCwd / recentWorkspaces（T1.1/T1.2/T3.1 数据基座，配套） |
| `session-api.test.ts` | unit | T1.1 配套（create cwd 透传契约） |
| `landing.test.ts` | unit | T1.6, T1.7, T1.8 |
| `dir-select-popover.test.ts` | unit | T3.2 |
| `branch-select-popover.test.ts` | unit | T4.3, T4.6, T4.9 |
| `create-branch-modal.test.ts` | unit | T6.2, T6.3(modal), T6.4(modal), T6.6, T6.7 |
| `flow-integration.test.ts` | integration | T1.1, T1.3, T1.4, T1.5, T3.1, T3.3, T3.4, T3.5, T4.2, T4.1(前端), T6.1(前端) |
| `fork-session.test.ts` | unit | T1.9（独立 ticket #8） |

### runtime 落位（`src-electron/runtime/test/new-task/`）

| 文件 | 类型 | 覆盖用例 |
|------|------|---------|
| `git-service.test.ts` | unit | T4.1, T4.5, T6.1, T6.3, T6.4, T6.8（GitService.checkout/createBranch） |
| `git-message-handler.test.ts` | unit | T4.1/T6.1 配套（handler git.checkout/git.createBranch 路由） |
| `git-executor-port.test.ts` | unit | T4.1/T6.1 配套（GitCommand 白名单含 `'checkout'`，编译期 + 运行期） |
| `protocol.test.ts` | unit | T4.1/T6.1 配套（protocol git.checkout/git.createBranch 消息类型） |

---

## describe / it 命名规范

沿用 `useChat.test.ts` 风格（参考其 `describe('useChat 流式状态机', ...)` + `it('首次 send 订阅流式事件恰好一次', ...)`）：

1. **文件名**：`<被测对象-kebab-case>.test.ts`（如 `use-new-task-flow.test.ts`、`git-service.test.ts`）
2. **describe 主题**：`<被测对象> <中文功能主题>`，每个文件 1 个顶层 describe + 多个分组 describe（如 `describe('useNewTaskFlow 状态机')` → 子 `describe('overlay 互斥')`）
3. **it 断言**：中文断言式，**条件→预期行为**结构（如 `it('gitInfo==null→openBranchPopover 抛错回 idle')`），用 `→` 串联输入与预期，不用"应该/应当"
4. **文件头注释**：参照 useChat.test.ts，写明覆盖点 + mock 策略 + 运行命令（`cd src-electron/renderer && npx vitest run src/__tests__/new-task/xxx.test.ts`）
5. **mock 命名**：`apiMock`/`executorMock` 等，用 `vi.hoisted` 捕获 handler 的模式（事件驱动用例如 T1.3/T4.8）

**示例**（use-new-task-flow.test.ts 骨架命名，仅命名不写实现）：
```
describe('useNewTaskFlow 状态机', () => {
  describe('startFlow 首次启动边界', () => { it('sessions=[]→cwd=undefined→不调 create、state=landing', ...) })
  describe('overlay 互斥', () => { it('dir-popover 下点 branch→先关再开至多 1 个', ...) })
  describe('UC-7 非 git 守卫', () => { it('gitInfo==null→openBranchPopover 抛错回 idle', ...) })
  ...
})
```

---

## 未自动化用例清单（manual，Wave 4 手工验收必走）

> 下列用例**不能只靠自动测试 PASS**，必须在 Wave 4 用真实环境走查并登记结果。理由均为"依赖 OS/真实 git 进程/外部状态，v1 不引入 Playwright"。

| 用例 ID | 手工走查内容 | 不能自动化的根因 |
|---------|-------------|----------------|
| T3.3 | 真实点「打开文件夹」→ OS 原生 dialog 弹出 → 选目录 → chip 回灌新 cwd | OS 原生 dialog（NSOpenPanel/IFileOpenDialog）无法在 vitest 模拟，前端只测 canceled=false 分支 |
| T3.4 | 真实 OS dialog 取消 → 落回 popover、chip 不变 | 同上，前端只测 canceled=true 分支 |
| T4.3 | 真实无首次提交的 git 仓库（unborn HEAD）→ popover 空态文案+引导 | 需真实 `git init` 后未 commit 的仓库，前端只测 mock status 返回 unborn |
| T4.5 | dirty 切走冲突 → 真实工作区文件内容不变 | "工作区不变"需真实 git 工作树校验，前端只测 checkout reject 留 popover |
| T4.7 | （条件性）若实现加了 per-cwd 缓存：同 cwd 连开两次 popover 第二次零 spawn | 依赖缓存实现是否存在；v1 不加则 `[DEVIATED]④NFR 允许`，登记豁免 |
| T4.8 | 真实分支 100+ + getStatus execSync 阻塞期间按 Esc → 阻塞后事件不丢 | 真实 execSync 同步阻塞无法在 vitest 复现，前端只测 pending Promise 排队语义 |
| T7.2 | 非 git 目录下外部 `git init` → 重开 popover / 等缓存 TTL → branch chip 恢复 | 依赖外部 git init + 既有 git-info 缓存 TTL（本期不改 git-info），难自动化 |

**Wave 4 验收要求**：上表 7 条（T3.3/T3.4/T4.3/T4.5/T4.7/T4.8/T7.2）必须在手工清单逐条登记 PASS，任一未走查 = Wave 4 未完成。其中 T4.7 按 D-6 条件性处理（v1 不加缓存可标 DEVIATED 豁免，需用户确认）。

---

## 闭环说明

- 本表 39 用例 = execution-plan.md「测试验收清单」全量，逐条对应，无遗漏无多余
- 主类型统计：unit 28 / integration 9 / manual 2；配套测试（runtime port 7 + 前端 integration 2 + manual 走查 4）另计
- 实现阶段按「文件落位约定」建 13 个测试文件，按「describe/it 建议」命名，按「mock 依赖」划边界
- Wave 4 验收 = 全部 unit/integration 测试 PASS **且** manual 清单 7 条手工走查登记
