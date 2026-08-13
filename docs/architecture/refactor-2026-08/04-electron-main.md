# 4. Electron Main 详细设计（15.2k 行）

> 本文件是 [README.md](README.md) 的子文档，覆盖层：`apps/electron/main/` + `apps/electron/preload/`（E1-E7）。审查报告来源：`.xyz-harness/2026-08-13-architecture-review/`，纯文本提取 `/tmp/arch-review-text.md` §4。所有路径/行号按 2026-08-13 审查后代码二次核实（见各节「事实」）。
>
> **波次归属**（与主文档 36 候选总览表一致）：E2/E3 → W2、E1 → W3、E4/E5/E6 → W4、E7 → W5。⚠️ 主文档 §3 W5 段落列表误列 E5（总览表标 W4），本文件按总览表执行 W4，盘点先行（见 E5 §3.5.5）。

## §1 背景与目标

### 背景

2026-08-13 架构审查对 Electron Main 层给出**高于预期**的判定：main→runtime 零 import、零 pi 协议复制（grep 命中 3 条全是注释）；supervisor 是合格深模块（interface 5 方法，implementation 深达进程树终止/退避状态机/探针联动）；browser↔window 无 seam 泄漏。**技术债集中在三处：update 链路编排归位不彻底、组合根（main.ts）泄漏、契约层（interfaces.ts）session 域污染。**

审查报告确认的层内事实：

| 事实 | 判定 |
|------|------|
| main→runtime 依赖方向 | 零 import、零反向（实测确认） |
| pi 协议复制 | grep 命中 3 条全部是注释（非代码） |
| supervisor 深浅 | 深模块：进程树终止 / 退避状态机 / 存活探针联动 |
| update 链路 | 编排归位不彻底：orchestrator 已 DI 注入但 interface ≠ implementation |
| 组合根 | 三处内联 + 一处 Facade 穿透（flushStderrSink） |
| 契约层 | WindowState 携带 session 业务域字段（Main 镜像 panel→session 投影） |

### 目标

1. **update 域编排单点化（E1）**：handler 退化为浅转发，四类编排逻辑（预下载状态机 / 快慢路径 / 错误翻译 / 代理探测）全部收进 orchestrator，消灭 ×3 复制
2. **组合根恢复纯编排（E2/E4）**：Facade 穿透（flushStderrSink）内化进 supervisor；三处内联（协议白名单 / 状态投影闭包 / 自愈两步）各归其位
3. **窗口单点权威（E3）**：全部窗口枚举/操作经 IWindowManager，消除 registry Map 与 `BrowserWindow.getAllWindows()` 双真相源
4. **契约层净化（E5）**：session 业务概念退出窗口注册表与 shared 类型
5. **supervisor 内部收敛（E6）**：常量/判活/健康探测基元单定义，shell-env 目录孤儿移出

### Out of Scope

- 不改变 update 的既有行为语义（快慢路径、预下载、代理探测的对外契约全部保持）
- 不引入新窗口能力（split 多窗口 v2 已移除，E3 收敛不改变单窗口事实）
- E5 的 session→window 投影迁移涉及 shared 类型 + renderer 消费方，**盘点先行**，禁止在盘点前动手

---

## §2 现状与问题分析

### 层判定（来自审查报告 §4）

整体质量高于预期；问题集中在「归位不彻底」与「组织债」，无结构性架构错误。所有候选均为行为等价重构，无高风险方向错误。

### 候选问题清单

| 编号 | 级别 | 问题一句话 | 证据位置（已核实） | 波次 |
|------|------|-----------|-------------------|------|
| E1 | Strong | update-handlers 业务编排未归位：preDownloading 状态机 / 快慢路径 / 错误翻译 ×3 / testProxyConnection 全在 handler 层 | gateway/update-handlers.ts（483 行）vs update/orchestrator.ts（333 行） | W3 |
| E2 | Strong | stderr sink 收尾责任被推给组合根：main.ts 直接 import flushStderrSink 穿透 IRuntimeSupervisor Facade，自然退出路径 sink 无人收尾 | main.ts:74 / :274-286；process-control.ts:95 | W2 |
| E3 | Strong | 窗口枚举双权威：WindowManager registry Map 与 `BrowserWindow.getAllWindows()` 直枚举并存（3 文件 + 1 处 activate 判空） | bridge-handlers.ts:77、runtime-supervisor.ts:337、main.ts:265、privileged-handlers.ts:57/:97/:122-132 | W2 |
| E4 | Worth | 组合根去内联化三处同类：① local-file 白名单前缀构造 ② BrowserViewManager 状态投影闭包 ③ update 自愈两步直接 import | main.ts:207-237 / :138-143 / :70+:244/:249 | W4 |
| E5 | Worth | interfaces.ts 契约层 session 域泄漏：WindowState 含 sessionIds + focusedPanelId，WindowOptions.sessionId 携带业务概念 | shared/panel.ts:18-25、interfaces.ts:17/:86/:143、window-manager.ts:108-110 | W4 |
| E6 | Worth | supervisor 内部重复实现 + shell-env 目录孤儿：KILL_WAIT_MS 双定义、存活守卫复制粘贴、shell-env 零 supervisor 内引用 | port-discoverer.ts:12 vs process-control.ts:53、runtime-supervisor.ts:95 vs :166、main.ts:73/:82 | W4 |
| E7 | Speculative | preload 形态适配归位 + update 域口径统一：chooseDirectory 转换、onBrowserState 类型 ×3、~ 缩写、EACCES 子串匹配 | preload.ts:293-294 / :82/:242/:251、bridge-handlers.ts:33-39、orchestrator.ts:202/:228 vs download-asset.ts:103 | W5 |

### 核查修正口径（⚠️ 按修正后描述）

- **E6 checkHealthEndpoint**：原报告「注释承认『刻意重复』」系曲解——liveness-probe.ts:19-20 论证的是**同名函数语义不同**（boolean 启动轮询 vs `{ok, ms?}` 存活监测），属有意分离。本设计按「双实现事实在，但设计正当性成立」描述，方案为**共享基元**而非合并函数
- **E6 KILL_WAIT_MS**：双定义在**定义处**（port-discoverer.ts:12 vs process-control.ts:53），原报告 :127-131/:395-398 是使用处。一处改 200ms 另一处忘改是真实 bug 源，定义收敛仍成立
- **E4 行号**：① local-file 白名单约 31 行（main.ts:207-237，原 :185-229 / ~45 行为行号偏移+规模夸大）；③ 自愈两步 import :70 / 编排 :244/:249（原 :29-30 为文件头注释、:235-240 偏前约 9 行）
- **E7 onBrowserState**：类型文件内重复 **3 次**（:82 接口声明 / :242 实现 / :251 handler 参数），原「两遍」低估
- **E1 testProxyConnection**：原 :64-105 截在 finally——实际 :56-111 完整函数（含 dispatcher.close() 句柄回收）

---

## §3 解决方案

### 3.1 E1 · update-handlers 业务编排下沉 orchestrator（Strong，W3）

**级别**：Strong（归位 · 去复制）

**问题**：orchestrator 已 DI 注入（`IUpdateOrchestrator` 3 方法：performUpdate/downloadUpdate/installUpdate），但 handler 层仍持有四类编排逻辑——**interface ≠ implementation**，upgrade 策略分裂在两个文件里：

1. **模块级 preDownloading 状态机**（update-handlers.ts:119 preDownloading flag、:127 preDownloadPromise、:130-166 preloadUpdateSilently）：防重复预下载 + 与 downloading 锁的协调（inFlight await）
2. **快慢路径决策**（update:perform :241-253 区域）：inFlight await → readPreloadedUpdate → installUpdate（快）/performUpdate（慢）+ usedFastPath 失败清 preloaded
3. **错误翻译 ×3 复制**（:273-293 perform catch / :350-364 download catch / :402-416 install catch）：三段结构逐字相同的 `UpdateError.toUserFriendly() → payload` 映射 + 非 UpdateError 兜底
4. **testProxyConnection 直接 fetch**（:56-111）：undici ProxyAgent dispatcher 构造 + 10s AbortController + `fetch('https://github.com', { HEAD })`，网络探测逻辑在 gateway 层

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| **A：全收编**（推荐） | 长期方案 | 四类逻辑全收进 update/ 域，handler 退化为「invoke → orchestrator 单方法 → send 事件」浅转发 | 升级策略单点（leverage：策略全在 update/ 域）；orchestrator 加深、handler 变浅，depth 双向归位。代价：IUpdateOrchestrator 接口扩展，测试 mock 面变化（现有 update-handlers-orchestration.test.ts 基建可复用） |
| B：只消复制 | 短期方案 | 仅抽共享错误翻译函数，状态机与快慢路径留在 handler | 改动最小（半天），但「两处各持升级策略」的核心问题不除，下次新增升级路径仍会两处改 |

**推荐：方案 A**。审查报告明确「orchestrator 已 DI 注入，验证现有测试基建后再收编」；现有 `update-handlers-orchestration.test.ts` / `orchestrator.test.ts` 已覆盖 DI mock 模式，收编的测试迁移成本可控。

**关键边界（不可越）**：orchestrator 是纯逻辑层（头注释自述「不依赖 electron app 生命周期，便于单元测试」）——**app.quit() 与 win.webContents.send 事件推送必须留在 handler**。四类逻辑中：
- 错误翻译 = 纯数据转换（UpdateError → {stage, message, errorCode, suggestion}），可进 update/ 域（建议 update/error-mapping.ts，顺带成为三处复制的单点）
- 代理探测 = 无 electron 依赖（undici + fetch），可进 update/ 域（与 proxy-config.ts SSOT 同处；resolveDispatcher 已在 handler 内，一并移入）
- 状态机与快慢路径 = 纯编排，可进 orchestrator（orchestrator 已有 updating/downloading 双锁先例，preDownloadPromise 编排与 downloading 锁天然同域）

**改动点**：
1. 新增 `update/error-mapping.ts`：`toUpdateErrorPayload(err, fallbackStage)` 纯函数；update-handlers 三处 catch 改为单行调用
2. `resolveDispatcher` + `testProxyConnection` 移入 `update/proxy-config.ts`（或 update/proxy-probe.ts）；gateway 不再 import undici
3. `IUpdateOrchestrator` 扩展：预下载编排方法（如 `preloadUpdateSilently(release)` 封装 readPreloadedUpdate 跳过逻辑）+ 快慢路径合并（如 `performWithPreload(release, opts)` 或保持 performUpdate + handler 调 orchestrator 暴露的 inFlight await）；preDownloading/preDownloadPromise 移入 orchestrator 模块级
4. handler 各 channel 退化为浅转发；`usedFastPath` 的 clearPreloadedUpdate 决策逻辑进 orchestrator（错误路径统一出口）

**风险**：update 链路是打包敏感区（AGENTS.md §12 精神：逐个 commit 逐个验证）；orchestrator 纯逻辑约束被破坏（错误翻译若误引 electron 会破坏单测能力）。缓解：每步独立 commit + `apps/electron` vitest 全绿 + 真实场景冒烟。

**验收（真实场景）**：
1. **完整升级流**：dev 启动（`XYZ_DEV_MOCK_UPDATE=1`）→ 检测到新版 → 点更新 → downloading→verifying→replacing 进度 → 重启。迁移前后各跑一次，断言 UI 行为一致
2. **预下载快路径**：Settings 开预下载 → 触发 check 后台下载 → 点更新**跳过下载**直接 replacing（日志 `using preloaded file`）；预下载进行中点更新 → 等待后走快路径（原 inFlight await 语义）
3. **三错误路径行为等价**：断网下载失败 / 手工破坏预下载产物触发 install 失败（清 preloaded，重试走完整重下）/ UPDATE_DIR 只读权限错误——错误码（UPDATE_PERMISSION_DENIED 等）与迁移前一致
4. **代理测试**：Settings 代理面板「测试连接」——disabled 模式返回 `Proxy disabled`、manual 坏 URL 返回格式错误、可用代理返回 success
5. 既有测试：`orchestrator.test.ts` + `update-handlers-orchestration.test.ts` + `proxy-handlers.test.ts` 全绿

**下一层拆分**：见 §5 任务 T-E1-1 ~ T-E1-4。

---

### 3.2 E2 · stderr sink 收尾收进 supervisor（Strong，W2）

**级别**：Strong（封装补完）

**问题**：`flushStderrSink`（process-control.ts:95，幂等）的**生命周期收尾责任被推给组合根兜底**：

- main.ts:74 `import { flushStderrSink }` 直接穿透 `IRuntimeSupervisor` Facade（interfaces.ts 自述「main.ts 不直接调子模块」被违反）
- main.ts:274-286 before-quit 组合根三连编排：`ctx.runtime.stop().then(() => flushStderrSink()).finally(unregisterAll + quit)`（:281 为 flush 调用行）
- main.ts:278-279 注释自证泄漏机理：「stop() 路径未触发（runtime 自然退出）时此 flush 是落盘的唯一保障」

根因在 supervisor 内部：`stopRuntimeProcess` 的 exit/timeout 两路径都走 `done()`，done 内 `await flushStderrSink()`（process-control.ts:412）——**但自然退出路径（runtime 自己崩溃，无 stop 调用）时，spawnRuntimeProcess 注册的 exit handler 只调 `onExit?.(code)`（→ runtime-supervisor.onRuntimeExit），不 flush**。stderrSink 是 append 模式 WriteStream（:72），app 退出前 buffer 未 flush 会丢尾部 stderr（崩溃期证据）。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| **A：flush 内化 spawn 侧**（推荐） | 长期方案 | 在 `spawnRuntimeProcess` 内注册的 child `exit`/`error` handler 里追加 `void flushStderrSink()`（幂等 no-op 安全）——无论谁触发退出（stop / 自然崩溃 / spawn error），sink 收尾都在 process-control 内发生；main.ts 删除 import + .then 编排，组合根只调 `runtime.stop()` | locality：sink 生命周期封闭在 process-control（sink 本就归它管）；interface 不变，implementation 加深；stop 路径的 done() flush 与 exit 路径 flush 幂等互不干扰。代价：无（改动 ~6 行 + 删 ~5 行） |
| B：接口补方法 | 短期方案 | `IRuntimeSupervisor` 新增 `flushStderr()`，组合根保留编排但不再 import 实现符号 | 穿透消除，但「自然退出路径无人 flush」的根因不除（组合根 flush 只覆盖 before-quit 时机），收尾仍靠组合根记得调 |

**推荐：方案 A**。E2 的本质是「sink 的终结者应是它的所有者（process-control）而非调用方（组合根）」——方案 A 同时消除穿透与漏收尾两个问题。

**改动点**：
1. `process-control.ts` `spawnRuntimeProcess`：child `exit` handler 与 `error` handler 内追加 `void flushStderrSink()`
2. `main.ts`：删除 `flushStderrSink` import（:74）与 before-quit 的 `.then(() => flushStderrSink())`（:281），before-quit 恢复 `runtime.stop().finally(unregisterAll + quit)`
3. 更新 :278 注释（泄漏机理不再成立，改为说明收尾归 process-control）

**风险**：低。flush 幂等已内置（stderrSink=null 后 no-op）；exit 先到时 flush 一次，stop 的 done() 再 flush 是 no-op。时序验证点：before-quit 的 quit 必须在 sink 'finish' 之后——方案 A 下 stop() 内部已 await flush（done 路径），语义不变。

**验收（真实场景）**（日志落盘规范：`<getDataDir()>/logs/`，dev = `~/.xyz-agent-dev/logs/electron-runtime-stderr.log`）：
1. **自然退出（崩溃）**：dev 启动 → 找到 runtime 子进程 PID → `kill -9` → 触发 onRuntimeExit → 退出 app → 检查 `~/.xyz-agent-dev/logs/electron-runtime-stderr.log` 尾部：runtime 最后输出的 stderr 行完整落盘无截断
2. **正常退出**：dev 启动 → 关窗退出（非 darwin window-all-closed 路径）→ 同一日志尾部完整（回归）
3. **spawn error**：临时改坏 runtime 入口路径 → 启动 → spawn error 路径日志落盘
4. **stop 路径回归**：`runtime-restart`（状态条重试）→ 日志无截断
5. 既有测试：`supervisor-health-liveness.test.ts` 等 supervisor 套件全绿

**下一层拆分**：见 §5 任务 T-E2。

---

### 3.3 E3 · 窗口枚举双权威收敛到 WindowManager（Strong，W2）

**级别**：Strong（单点权威）

**问题**：窗口枚举存在**两个真相源**——WindowManager registry Map 与 Electron 全局 API 直读：

| 位置 | 直读调用 | 用途 |
|------|---------|------|
| gateway/bridge-handlers.ts:77 | `BrowserWindow.getAllWindows()` | window-list 广播回调 |
| supervisor/runtime-supervisor.ts:337 | `BrowserWindow.getAllWindows()` | broadcastToAllWindows（runtime-port / runtime-restarting / runtime-failed / runtime-error） |
| main.ts:265 | `BrowserWindow.getAllWindows()` | activate 时判空重建窗口 |
| gateway/privileged-handlers.ts:57/:97 | `BrowserWindow.getFocusedWindow()` | pickDirectory / pickFile 对话框宿主窗口 |
| gateway/privileged-handlers.ts:122-132 | `BrowserWindow.fromWebContents(event.sender)` | window-minimize / window-toggle-maximize / window-close |

registry Map 漏登记时（如 activate 重建路径之外的窗口）两套真相打架——多窗口场景的漂移 bug 源。ARCHITECTURE.md 明确窗口注册表是 Main 的跨进程协调状态。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| **A：全经 IWindowManager**（推荐） | 长期方案 | ① `IWindowManager` 新增 `broadcast(channel, payload)`（内部 getAllWindows 循环 + isDestroyed 守卫，与 bridge-handlers 的 window-list 广播模式合并）；② RuntimeSupervisor 构造注入 IWindowManager（或 broadcastToAllWindows 迁移为调用注入的 windowManager.broadcast）；③ activate 判空改 `windowManager.windowCount === 0`；④ privileged 窗口操作经 windowManager（接口扩展 `minimize/maximize/closeByWebContents(sender)` 或 `fromWebContents(sender)` 查询） | 窗口状态单点权威；registry 与全局 API 漂移物理不可能；bridge-handlers:67 setOnWindowListChanged 编排面挂进 broadcast 后，窗口列表广播与通用广播同源。代价：RuntimeSupervisor 构造签名变化（main.ts:76 传入 windows），privileged-handlers 接口扩展 |
| B：只收广播 | 短期方案 | 仅 broadcastToAllWindows + window-list 收进 windowManager；privileged 的 getFocusedWindow/fromWebContents 保留直读 | 覆盖 3/5 处，但特权窗口操作（最小化/最大化/关闭）仍直读全局 API——双权威未根除 |

**推荐：方案 A**。v2 移除 split 后实际单窗口，但 runtime 广播路径（restart / fail）是多窗口语义的真实代码，收敛后这些路径全部单点。

**改动点**：
1. `interfaces.ts` `IWindowManager` 扩展：`broadcast(channel, payload)` + `minimize(windowId)` / `toggleMaximize(windowId)`（close/focus 已有）+ `fromWebContents(sender)` 查询
2. `window-manager.ts`：实现 broadcast（复用现有遍历守卫模式）；closed 事件已触发 onWindowListChanged，广播逻辑与注册表天然同处
3. `runtime-supervisor.ts`：构造注入 `IWindowManager`，broadcastToAllWindows 内部改调注入的 broadcast；删除 BrowserWindow 全局 import（若不再需要）
4. `main.ts:265`：activate 判空改 `ctx.windows.windowCount === 0`；`:138` 构造 BrowserViewManager 与 RuntimeSupervisor 时传入 windows
5. `privileged-handlers.ts`：pickDirectory/pickFile 改经 windowManager 定位聚焦窗口；window-minimize/toggle-maximize/close 改经 fromWebContents→windowId→windowManager 方法
6. `bridge-handlers.ts:77`：window-list 广播改用 windowManager.broadcast（或保持 onWindowListChanged 回调内调 broadcast）

**风险**：中。runtime-supervisor 的 broadcastToAllWindows 是崩溃重启/存活探针的广播路径，注入 windowManager 属构造依赖新增（非循环依赖：runtime-supervisor → interfaces，windowManager → interfaces，无环）。privileged 的 `fromWebContents(event.sender)?.minimize()` 链式可选调用（:123/:127）改为 windowManager 方法后需等价守卫（windowId 查不到时 no-op）。

**验收（真实场景）**：
1. **runtime 重启广播**：dev 启动 → kill runtime 子进程 → 自动重启（≤5 次退避）→ renderer 收到 runtime-restarting / runtime-port 事件（前端状态条与端口重连正常）
2. **窗口列表广播**：关闭主窗口 → renderer window-list-updated 正常；macOS 全屏切换 → fullscreen-changed 正常
3. **特权窗口操作**：DevTools 执行 `window.electronAPI.minimizeWindow()` 等 → 窗口最小化/最大化/关闭行为与迁移前一致
4. **对话框降级**：pickDirectory 无聚焦窗口场景 → 返回 canceled（降级路径不变）
5. **activate 重建**：macOS 关闭窗口 → dock 点击 → 窗口重建 + runtime 复用（判空逻辑经 windowCount 等价）
6. 既有测试：`privileged-handlers.test.ts` + supervisor 套件全绿

**下一层拆分**：见 §5 任务 T-E3-1 ~ T-E3-3。

---

### 3.4 E4 · 组合根去内联化（Worth，W4）

**级别**：Worth（组织债 · 三处同类）

**问题**：main.ts（286 行）作为纯编排脚本，仍内联三处「子域自己的逻辑」：

1. **protocol.handle('local-file') 内联白名单前缀构造**（main.ts:207-237 约 31 行）：allowedPrefixes 列表（getAppPath / getDataDir / attachments / cwd / tmpdir / 用户子目录 + path.sep 后缀）构造在组合根；校验函数 `isPathInAllowedPrefixes` 已抽 input-validators，**仅前缀列表内联**
2. **BrowserViewManager onStateChange 状态投影闭包内联**（main.ts:138-143）：`(sid, state) => { win = ctx.mainWindow; isDestroyed 守卫; send('browser:state', { sessionId: sid, ...state }) }`——状态投影（Main 窗口引用 + 守卫 + 事件发送）是 BrowserViewManager 的职责，闭包把 ctx 耦合进了 main.ts
3. **update 自愈两步直接 import 组合根编排**（import :70 / 编排 :244/:249）：`maybeRollbackInterruptedUpdate()` + `cleanupCompletedUpdate()` 两步时序（先回滚后清理，注释自述顺序依赖）内联在 whenReady——update 域没有门面

**方案对比**：

| 项 | 方案 A（长期，推荐） | 方案 B（短期） |
|----|---------------------|---------------|
| ① 白名单 | `buildLocalFileAllowedPrefixes()` 纯函数移入 `gateway/input-validators.ts`（与校验同处，白名单构造与校验共域）；main.ts 剩一行调用 | 保持内联（仅注释解释） |
| ② 投影 | BrowserViewManager 构造参数增加 mainWindow 提供者（如 `() => BrowserWindow \| null` getter，main.ts 传 `() => ctx.mainWindow`）；投影（守卫 + send）内聚进 BrowserViewManager，onStateChange 回调签名简化为业务状态 | 保持闭包（泄漏留在组合根） |
| ③ 自愈 | `update-self-healer.ts` 新增 `selfHealOnBoot()` 单一入口（内部按序调 maybeRollback + cleanup，顺序依赖封装进域）；main.ts 一行调用 | 保持两步 import |

**推荐**：三项全走方案 A。③ 的时序依赖（「必须在 maybeRollback 之后（replacing 回滚完成转入终态后再清理）」）是 update 域的知识，不应由组合根记住；① 的白名单是安全敏感逻辑（注释自述「禁止把整个 homedir 加入白名单」），构造与校验同域后安全决策单点可审。

**改动点**：
1. `input-validators.ts`：新增 `buildLocalFileAllowedPrefixes()`（现 main.ts:207-237 逻辑整体迁移，含 path.sep 后缀规范化与注释）；main.ts protocol.handle 内剩 `isPathInAllowedPrefixes(resolved, buildLocalFileAllowedPrefixes())`
2. `browser-view-manager.ts`：构造签名扩展（windows + mainWindow getter + 可选 onStateChange）；内部 `sendBrowserState(sid, state)` 私有方法封装守卫+发送；main.ts 闭包删除
3. `update-self-healer.ts`：新增 `selfHealOnBoot(): Promise<void>`；main.ts whenReady 两步换一行

**风险**：① 是安全路径（local-file 白名单）——迁移必须逐行等价（含 sep 后缀逻辑、注释保留），验收含越权 403 回归。② 涉及 BrowserViewManager 构造签名，main.ts:138 与 registerIpcHandlers 的传参同步改。③ 纯时序封装，零行为变化。

**验收（真实场景）**：
1. **local-file 回归**：dev 启动 → 拖入图片附件 → 图片正常显示；对话中图片 URL 含 `~/` → 展开正确；越权路径（如 `file://localhost-file/~/.ssh/config`）→ 403 Forbidden；attachments 目录图片可读（session 附件场景）
2. **browser drawer 回归**：打开嵌入式浏览器 → 地址栏回填真实 URL（防钓鱼）+ loading/error 态切换正常；关闭 drawer 后无残留事件推送
3. **自愈回归**：人为写 `update-result.json` status='replacing' → 启动 → 回滚发生（.app 恢复到可用态）；终态（done/failed）→ 清理残留 zip 与元信息
4. main.ts 行数下降且只剩「注册 + 生命周期串联」；typecheck + lint 全绿

**下一层拆分**：见 §5 任务 T-E4-1 ~ T-E4-3（三项互相独立，可并行）。

---

### 3.5 E5 · interfaces.ts 契约层 session 域泄漏（Worth，W4）

**级别**：Worth（契约层净化）

**问题**：Main 契约层混入 session 业务域状态：

1. `WindowState`（shared/panel.ts:18-25）含 `sessionIds` + `focusedPanelId` + `panel.sessionId`——窗口注册表在镜像 panel→session 投影（业务域状态进窗口状态）
2. `window-manager.ts:108-110` `createInitialState` 构造 `{ panel: { sessionId: null }, focusedPanelId, sessionIds: [] }`——投影从未被业务更新（grep 无 `sessionIds.push` 类写入），是**恒空镜像**
3. `WindowOptions.sessionId`（interfaces.ts:143）携带 session 业务概念；window-factory.ts:155/:159/:170 把它拼进窗口 URL query/params

**盘点结论（已核实）**：`WindowState` 在 renderer **零消费**（`grep WindowState/sessionIds/focusedPanelId packages/renderer/src/` 无命中）——纯 Main 内部类型，却定义在 shared 层；`windowManager.getAll()` 的唯一消费方是 bridge-handlers.ts:59（window-list 广播）。**session 业务状态 renderer 本就全部持有**（chat store 分区），Main 镜像属于冗余投影。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| **A：注册表瘦身 + 投影归 renderer**（推荐） | 长期方案 | ① `WindowState` 瘦身为 `windowId` + 最小元数据（或整体移出 shared → main 内部类型）；② session→window 投影查询从 Main 移除，renderer 自行维护（它持有全部 session 状态）；③ `WindowOptions.sessionId` 从 Main 契约移除，窗口初始化参数由 renderer 构造 URL 时自行携带（window-factory 的 sessionId query 逻辑随迁 renderer 侧） | 契约层恢复纯窗口域；shared 不再被 Main 内部类型污染；renderer 状态单源（消除「Main 镜像可能过期」的隐式契约）。代价：涉及 shared 类型改动 + window-factory URL 参数构造迁移到 renderer 消费方——**必须先盘点 renderer 侧 sessionId 初始化消费点再动** |
| B：标记 deprecated | 短期方案 | shared 保留 WindowState 但注释标 deprecated，sessionIds 字段停止更新（恒空），renderer 迁移完成后再删 | 零行为变化，但契约层污染与恒空镜像继续存在 |

**推荐：方案 A，但盘点先行**。主文档 W5 段落误列 E5（总览表 W4），本文件按 W4 执行——**第一步就是盘点任务**（§5 T-E5-0），盘点产出 renderer 消费点清单后再定 ③ 的具体迁移形态。注意区分：window-factory 的 sessionId 是「窗口初始化 URL 参数」（渲染启动数据，合理），与「Main 持有 session 状态」（业务投影，不合理）是两件事——迁移只针对后者，前者的归属由盘点决定。

**风险**：中。shared/panel.ts 是跨包类型（renderer + main 共享），删除字段需全仓 typecheck；window-factory 的 URL 参数若 renderer 消费方依赖 Main 注入，迁移要同步改 renderer 初始化逻辑。

**验收（真实场景）**：
1. **session 生命周期回归**：新建 session → 切 session → 折叠/展开侧栏 → 重启 app 重开 session——历史与状态一致（不受 Main 镜像移除影响）
2. **窗口列表广播**：window-list 广播内容（瘦身后的字段）与 renderer 消费方契约一致
3. **URL 参数迁移**：新窗口创建后 sessionId 正确初始化（renderer 从 URL 读取，与迁移前一致）
4. 全仓 typecheck 全绿（shared 类型变更波及面为零残留）；`rg "sessionIds"` 在 main 窗口域零命中

**下一层拆分**：见 §5 任务 T-E5-0 ~ T-E5-3。

---

### 3.6 E6 · supervisor 内部重复实现 + shell-env 目录孤儿（Worth，W4）

**级别**：Worth（组织债）

**问题**（⚠️ 按核查修正口径）：

1. **checkHealthEndpoint 双实现**（health-checker.ts:72 `Promise<boolean>` 启动轮询 vs liveness-probe.ts:53 `Promise<{ok, ms?}>` 存活监测）：**有意分离成立**（liveness-probe.ts:19-20 注释论证同名函数语义不同），双实现事实在但非「刻意重复」——方案不合并函数，只收敛共享探测基元
2. **KILL_WAIT_MS=200 双定义**（port-discoverer.ts:12 vs process-control.ts:53，⚠️ 定义处非使用处）：一处改 200ms 另一处忘改是**真实 bug 源**（两处语义应恒等：等 SIGTERM 后补 SIGKILL 的窗口）
3. **存活守卫复制粘贴**（runtime-supervisor.ts:95 start 幂等 vs :166 restartRuntime 幂等）：`this.child && this.child.exitCode === null && this._port !== null` 逐字重复（含注释意图）
4. **shell-env.ts 目录孤儿**（supervisor/ 内唯一引用是 main.ts:73/:82）：修的是 **main 进程自己**的 PATH（GUI 启动时补全用户级 bin 目录），supervisor/ 内零文件 import——住在 supervisor 目录但非 supervisor 职责

**方案对比**：

| 项 | 方案 A（长期，推荐） | 方案 B（短期） |
|----|---------------------|---------------|
| ① 健康探测 | 抽取共享基元（`fetch /health` + AbortController 超时 + JSON 解析）到 `supervisor/health-probe-core.ts`；两函数保留各自语义（boolean vs {ok, ms?}）只复用基元 | 保持双实现 + 注释互指（设计正当性已在注释） |
| ② KILL_WAIT_MS | 单定义收敛（port-discoverer 或新 supervisor/constants.ts），process-control import 它；两处使用点语义恒等由类型单源保证 | 保持双定义 + 注释互相引用（风险仍在） |
| ③ 存活守卫 | runtime-supervisor 抽私有方法 `isProcessAlive()`，:95/:166 两处调用 | 保持复制 |
| ④ shell-env | 移出 supervisor/ → `main/utils/shell-env.ts`（或 main 根级），import 路径同步（main.ts + test） | 留在原地 + 注释说明 |

**推荐**：四项全走方案 A。② 是唯一有真实 bug 风险项（数值漂移），单定义成本一行；① 尊重核查修正（不合并语义）；④ 是纯目录归位（零行为变化）。

**改动点**：
1. 新增 `supervisor/health-probe-core.ts`：`probeHealthOnce(port, { timeoutMs })` 基元；health-checker.ts:72 与 liveness-probe.ts:53 改为调用基元包装各自语义
2. `KILL_WAIT_MS`：port-discoverer.ts:12 保留定义（或移 constants），process-control.ts:53 删除改 import；两文件使用点不变
3. `runtime-supervisor.ts`：私有 `isProcessAlive()` 方法，:95 与 :166 替换
4. `shell-env.ts` → `utils/shell-env.ts`（`apps/electron/main/utils/` 已有 path.ts 先例）；main.ts:73 与 `test/shell-env.test.ts:3` import 路径同步

**风险**：低。① 的基元抽取需保持两语义各自的超时/解析行为（单测覆盖）；② 单定义后两使用点读同一常量，行为零变化；③④ 纯重构。shell-env 移动涉及测试 import 路径，typecheck + test 兜底。

**验收（真实场景）**：
1. **健康探测回归**：dev 启动 → waitForHealth 正常（启动轮询语义不变）；runtime 半活（kill -STOP 挂起进程）→ 存活探针连续失败达阈值 → 强制重启（liveness 语义不变）
2. **kill 时序回归**：restart runtime → 日志显示 SIGTERM→200ms→SIGKILL 时序与迁移前一致（`KILL_WAIT_MS` 单源后改值测试：临时改 50ms → 两路径同步生效）
3. **重启守卫回归**：kill runtime → 自动重启 ≤5 次 → 重启用尽广播 runtime-failed → 状态条重试 → 重启成功（start/restartRuntime 幂等守卫行为等价）
4. **PATH 修复回归**：GUI 启动（无 shell 环境）→ pi 会话 bash 工具能找到用户 CLI（如 `which uv` 命中 ~/.local/bin）——shell-env 移动后行为不变
5. 既有测试：supervisor 全部套件 + shell-env.test.ts 全绿

**下一层拆分**：见 §5 任务 T-E6-1 ~ T-E6-4（四项互相独立，可并行）。

---

### 3.7 E7 · preload 形态适配归位 + update 域口径统一（Speculative，W5）

**级别**：Speculative（形态归位 · 口径统一）

**问题**（四处小泄漏）：

1. **chooseDirectory 形态转换**（preload.ts:293-294）：`invoke('pick-directory').then((r) => r.path)` —— `{canceled, path} → path` 转换是 renderer API 门面职责（ChooseDirectoryFn 契约），preload 应纯透传
2. **onBrowserState 类型文件内重复 3 次**（preload.ts:82 接口声明 / :242 实现 / :251 handler 参数）：同一 BrowserState 形状内联 3 遍，应引 shared 单源（当前 shared 无 BrowserState 类型，`grep` 零命中）
3. **get-data-dir ~ 路径缩写**（bridge-handlers.ts:33-39）：`dir.startsWith(home + sep) ? '~' + dir.slice(home.length) : dir` —— 展示格式逻辑入 Main（renderer 展示层该做的事）
4. **update 域错误分类口径不一**：orchestrator.ts:202/:228 内联 `message.includes('EACCES') || includes('permission')` 子串匹配，与 download-asset.ts:103 `getNodeErrnoCode()`（:410/:514-517 精确 errno 匹配）相反——同域两种口径

**方案对比**：

| 项 | 方案 A（长期） | 方案 B（短期） |
|----|---------------|---------------|
| ① chooseDirectory | 转换移归 renderer 门面（`lib/ipc` 的 chooseDirectory 封装处做 `{canceled, path} → path`）；preload 返回原始 invoke 结果 | 保持 preload 转换（现状） |
| ② BrowserState 类型 | 定义 `BrowserState` 于 shared 单源（或 main/browser 域导出 + preload type-only import——先盘点 browser-view-manager 的 BrowserViewState 是否可复用）；preload 3 处改引单源 | 保持 3 处内联 |
| ③ ~ 缩写 | Main 返回原始路径，renderer 做缩写（renderer 需 home 信息：新增 IPC 或返回结构带 home——SettingsResourcePage.vue:119 消费点迁移） | 保持 Main 缩写（注释标注展示契约） |
| ④ EACCES 口径 | `getNodeErrnoCode` 从 download-asset 导出（或下沉 update/error-classify.ts），orchestrator 的权限/磁盘分类改用精确 errno 匹配 | 保持子串匹配 |

**推荐**：① 与 ④ 走方案 A（① 是纯职责归位、消费方已明确：ExtensionPage.vue:41/:45 与 SettingsResourcePage.vue:84 经 `lib/ipc` 注入；④ 同域口径统一是真实 bug 源——子串匹配会误判含 "EACCES" 字样的业务消息）。② ③ 是 Speculative 级别，**先盘点再定**（② 需确认 BrowserViewState 与 onBrowserState 形状是否同一；③ 的 renderer 缩写需 home 信息通道，若盘点发现改动面大则降级方案 B 并记录）。

**改动点**：
1. preload.ts：chooseDirectory 改 `ipcRenderer.invoke('pick-directory')` 纯透传；`packages/renderer/src/lib/ipc` 的 chooseDirectory 封装内做形态转换（若转换在 lib/ipc 而非 composable，确认单点）
2. BrowserState 单源定义（位置由盘点定）；preload 3 处类型替换
3. （盘点后定）get-data-dir 返回原始路径 + renderer 缩写
4. `getNodeErrnoCode` 导出或下沉；orchestrator.ts:202/:228 改精确匹配（含 ENOSPC 分支一并统一）

**风险**：低。① 影响 renderer 目录选择交互（ExtensionPage 加载扩展目录 + SettingsResourcePage 资源目录）——真实场景回归必测；④ 是 update 错误路径（权限/磁盘分类），错误码语义不变仅匹配口径变精确。

**验收（真实场景）**：
1. **目录选择回归**：Settings 扩展页「选择目录」→ 选择成功路径正确 / 取消返回 null（UI 无异常）；资源页 forcedDirs 展示正确
2. **browser 状态回归**：浏览器 drawer 打开/导航/错误页 → 地址栏与 loading 态推送正常（onBrowserState 类型替换后事件形状一致）
3. **权限错误口径**：UPDATE_DIR 只读 → 触发更新 → 错误码 UPDATE_PERMISSION_DENIED（与迁移前一致）；含 "EACCES" 字样但非权限的业务错误不再被误分类
4. 全仓 typecheck 全绿（preload 类型与 renderer 消费方契约一致）

**下一层拆分**：见 §5 任务 T-E7-1 ~ T-E7-4。

---

## §4 验收

### 层内整体验收（每候选完成后跑）

1. **真实场景冒烟**：`pnpm run dev` 启动 → 完整对话（新建 session → 发消息 → 收回复 → 切 session → 重开验证历史）→ 确认无回归。update 相关（E1/E7 ④）用 `XYZ_DEV_MOCK_UPDATE=1` 走 mock 升级流
2. **全量检查**：`apps/electron` 的 vitest 全绿（`cd apps/electron && npx vitest run`）、`pnpm run lint` 通过、全仓 typecheck 通过
3. **日志落盘验证**（E2 专属）：`~/.xyz-agent-dev/logs/electron-runtime-stderr.log` 尾部完整
4. **打包链路**：E1 是 update 打包敏感区——W3 波次整体验收时跑一次 `bash scripts/validate-runtime-bundle.sh`；main/ 改动不触发 pre-commit 的 runtime bundle 验证，但 AGENTS.md §12「打包相关改动逐个 commit 逐个验证」精神适用（update 域改动每 commit 后跑 electron 测试）

### 汇总表

| 编号 | 级别 | 波次 | 方案 | 验收核心场景 | 风险 |
|------|------|------|------|-------------|------|
| E1 | Strong | W3 | 四类逻辑收进 orchestrator，handler 浅转发 | mock 完整升级流 / 预下载快路径 / 三错误路径等价 / 代理测试 | update 打包敏感区，逐 commit 验证 |
| E2 | Strong | W2 | flush 内化 process-control spawn 侧，组合根删编排 | kill -9 runtime 后 stderr 完整落盘 / 正常退出回归 | 低（幂等已内置） |
| E3 | Strong | W2 | 全部窗口枚举/操作经 IWindowManager | 重启广播 / 窗口列表 / 特权窗口操作 / 对话框降级 | 中（supervisor 注入无环） |
| E4 | Worth | W4 | 白名单进 input-validators、投影内聚、selfHealOnBoot | local-file 图片与越权 403 / browser drawer / 中断升级回滚 | ① 是安全路径，逐行等价 |
| E5 | Worth | W4 | 注册表瘦身 + 投影归 renderer（盘点先行） | session 生命周期回归 / window-list 契约 / URL 参数迁移 | 中（shared 跨包类型） |
| E6 | Worth | W4 | 共享探测基元 / KILL_WAIT_MS 单定义 / 守卫抽方法 / shell-env 移出 | 健康探测与 kill 时序回归 / PATH 修复回归 | 低 |
| E7 | Speculative | W5 | 转换归 renderer、类型单源、errno 精确匹配（②③ 盘点后定） | 目录选择回归 / browser 状态 / 权限错误码 | 低 |

---

## §5 下一层拆分

### 实施顺序与依赖

```
W2（E2 + E3，可与 D3/D4/C2/C3 并行）
  T-E2    → T-E3-1 → T-E3-2 → T-E3-3        （E3 依赖接口扩展先行）
W3（E1，最大波次，逐 commit 验证）
  T-E1-1 → T-E1-2 → T-E1-3 → T-E1-4         （错误翻译 → 代理探测 → 状态机/快慢路径 → handler 退化）
W4（E4/E5/E6 互相独立可并行；E5 盘点先行）
  T-E4-1 ∥ T-E4-2 ∥ T-E4-3
  T-E5-0 → T-E5-1 → T-E5-2 → T-E5-3
  T-E6-1 ∥ T-E6-2 ∥ T-E6-3 ∥ T-E6-4
W5（E7，②③ 盘点后定方案级别）
  T-E7-0 → T-E7-1 ∥ T-E7-2 ∥ T-E7-3 ∥ T-E7-4
```

### 任务清单与 commit 建议

| 任务 | 内容 | 依赖 | commit 建议 |
|------|------|------|------------|
| **T-E2** | flush 内化 spawn 侧 + 删组合根编排 | 无 | 单 commit（~10 行 + 注释更新） |
| **T-E3-1** | IWindowManager 扩展接口（broadcast/minimize/toggleMaximize/fromWebContents）+ window-manager 实现 | T-E2（同 W2，无硬依赖） | 单 commit（interface + 实现 + 测试） |
| **T-E3-2** | RuntimeSupervisor 注入 windowManager，broadcastToAllWindows 改经注入 | T-E3-1 | 单 commit |
| **T-E3-3** | privileged-handlers / bridge-handlers / main.ts activate 改经 windowManager | T-E3-1 | 单 commit（3 文件联动） |
| **T-E1-1** | 抽 update/error-mapping.ts，handler 三处 catch 改单点 | 无 | 单 commit（纯提取，行为零变化，最优先） |
| **T-E1-2** | resolveDispatcher + testProxyConnection 移入 update/ 域；gateway 不再 import undici | T-E1-1 | 单 commit + proxy-handlers 测试迁移 |
| **T-E1-3** | preDownloading 状态机 + 快慢路径 + usedFastPath 决策收进 orchestrator（IUpdateOrchestrator 扩展） | T-E1-1/T-E1-2 | 单 commit + update-handlers-orchestration 测试迁移 |
| **T-E1-4** | handler 各 channel 退化浅转发；验证 mock 全流程 + 三错误路径 | T-E1-3 | 单 commit（收尾验证） |
| **T-E4-1** | buildLocalFileAllowedPrefixes 移入 input-validators | 无 | 单 commit（安全路径逐行等价 + 越权回归） |
| **T-E4-2** | BrowserViewManager 投影内聚（mainWindow getter 注入） | 无 | 单 commit |
| **T-E4-3** | update-self-healer 新增 selfHealOnBoot()，main.ts 一行调用 | 无 | 单 commit |
| **T-E5-0** | **盘点**：renderer 侧 sessionId 初始化消费点 + WindowState 消费面（已初步：renderer 零消费）+ BrowserViewState 与 onBrowserState 形状比对 | 无 | 盘点产出文档（不写码） |
| **T-E5-1** | WindowState 瘦身（shared 类型改）+ window-manager createInitialState 简化 | T-E5-0 | 单 commit（typecheck 全仓绿） |
| **T-E5-2** | WindowOptions.sessionId 处理（按盘点结论迁 renderer 或标注） | T-E5-0 | 单 commit |
| **T-E5-3** | session→window 投影查询归 renderer；删除恒空镜像 | T-E5-1 | 单 commit |
| **T-E6-1** | health-probe-core 基元抽取 | 无 | 单 commit + 双语义单测 |
| **T-E6-2** | KILL_WAIT_MS 单定义 | 无 | 单 commit（改值双路径验证） |
| **T-E6-3** | runtime-supervisor isProcessAlive() 抽方法 | 无 | 单 commit |
| **T-E6-4** | shell-env.ts 移入 utils/ | 无 | 单 commit（import 路径同步） |
| **T-E7-0** | 盘点：BrowserState 单源位置 + renderer home 信息通道 | 无 | 盘点产出文档 |
| **T-E7-1** | chooseDirectory 转换移归 renderer lib/ipc | 无 | 单 commit + 目录选择回归 |
| **T-E7-2** | onBrowserState 类型引 shared 单源 | T-E7-0 | 单 commit |
| **T-E7-3** | get-data-dir 展示归 renderer（或按盘点降级方案 B） | T-E7-0 | 单 commit |
| **T-E7-4** | getNodeErrnoCode 导出/下沉，orchestrator 精确匹配 | 无 | 单 commit + 错误码回归 |

### 收尾

- 全部完成后：更新 README.md 的 36 候选总览表状态列（E1-E7 → 已落地），修正 W5 段落误列 E5 的笔误
- 每波次结束跑 §4 层内整体验收；W3 结束（E1 落定）跑一次 `bash scripts/validate-runtime-bundle.sh`
- 本层改动全部在 `apps/electron/` 与 `packages/shared/`（E5）+ `packages/renderer/`（E5/E7 消费方），不触碰 runtime 打包链路（E1 的 update 域除外——它不进 runtime bundle，但属于打包敏感功能域，逐 commit 验证原则适用）
