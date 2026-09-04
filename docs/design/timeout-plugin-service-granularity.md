# plugin-service 超时量级按对象粒度校准（工具执行 / 人工等待 / 控制面）

> **一句话结论**：plugin-service 内六类超时按「被保护对象的粒度」重校——插件工具执行（任务级）默认抬至 30min 并开 `registerTool` 声明覆盖 + 显式 opt-out；两处「等人工操作」（UI 弹窗、权限审批）对齐本仓 dialog-queue 30min 裁决先例，到期语义从「替答/判拒」改为「取消 + 可重试」；控制面（activate / load / hook）保持秒级但补覆盖通道与契约文档；命令执行按任务级抬 30min；Worker loadPlugin 超时后行为对齐 fork 版回收。

<!-- 层声明（准则 10） -->
**层声明**：当前层 = 技术方案；下一层 = 实现任务单元（文件级）。本设计涉及运行时行为 / 数据流 / 错误处理，准则 5/6/7 按最严格档执行。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 的 plugin-service 是插件宿主——插件跑在 Worker 线程或 fork 子进程里，向 pi agent 提供工具、hook、UI 弹窗与状态栏能力；runtime 与插件之间靠 JSON-RPC 往返，每一处「等回复」都挂了一个固定墙钟。
- **C（冲突）**：超时普查（[timeout-audit-2026-09.md](timeout-audit-2026-09.md) Doc 3 范围）发现：pi agent loop 主链路上的插件工具执行被 30s 固定墙钟砍成 `isError`（与已修的 zcode 300s turn 误杀同构、量级短 10 倍）；两处「等用户操作」被短墙钟替答——UI 弹窗 60s 自动 resolve `false`、权限审批 30s 判拒并把插件置 UNLOADED；且 UI 弹窗链路上还藏着一层 30s 的 RPC 客户端超时先到期。所有覆盖参数（`permissionTimeoutMs` 等）注释标注「测试用」，生产不可达。
- **Q（问题）**：怎么让 plugin-service 每一处超时都符合 [AGENTS.md](../../AGENTS.md) 规则 19 的「量级按对象粒度校准」——任务执行 = 小时级或无进展检测、等人工 = 本仓既有 30min 裁决、控制面单请求 = 秒级——并给插件作者与用户留显式逃生门？
- **A（答案）**：六个决策（§5 D1-D6）：工具执行默认 30min + 声明覆盖 + opt-out（D1）；UI 弹窗双层同改 30min + `timeout` 参数 + 取消语义（D2）；权限审批默认转正 30min + 取消语义（D3）；activate 保持控制面量级补覆盖、command 按任务级抬 30min（D4）；Worker loadPlugin 超时后 terminate + 走 rebuild 链（D5）；hook 5s / client 30s 机制 / load 10s 等登记不动（D6）。

---

## 1. 背景：被设计的系统是什么

**本章结论**：plugin-service 是「pi agent ↔ 插件」之间的宿主与适配层，本设计只动它的超时行为，不动插件 API 的能力面。

plugin-service（`packages/runtime/src/services/plugin-service/`）让 xyz-agent 在 pi agent 之外挂载动态能力：

- **插件宿主**：trusted 插件跑 Worker 线程（多插件共享一个 Worker，上限 10），sandbox 插件跑独立 fork 子进程（每插件一进程，`plugin-host-process.ts`）。插件代码在宿主内执行，主线程（runtime）与宿主之间用 JSON-RPC（`plugin-rpc-server.ts` / `plugin-rpc-client.ts`）。
- **pi 桥接**：pi 进程内跑一个 xyz-agent 打包的 bridge extension（`resources/pi/agent/extensions/bridge/index.ts`），轮询 `bridge:sync` 拿插件工具清单并注册为 pi 工具；pi agent 调这些工具时，bridge extension 发 `bridge:tool_execute` 到 runtime，runtime 经 `plugin.tool.execute` RPC 调 Worker 里的插件 handler，回包原路返回。
- **前端桥接**：插件可弹 confirm/select/input 对话框（`UiRequestQueue` 串行派发 `plugin:uiRequest` 广播到前端）；插件首次激活若有未批准权限，广播 `plugin:permissionRequest` 等用户审批（`plugin-activator.ts` 状态机）。

**关键概念——「等回复」的三种对象粒度**（本设计的裁定框架，后文反复使用）：

| 对象粒度 | 定义（绑例子） | 规则 19 量级 | 本模块实例 |
|---|---|---|---|
| **任务执行** | 执行插件作者写的、内容与时长不可预期的业务代码——例：`plugin.tool.execute` 调一个「分析整个代码库」的工具 handler | 小时级，或无进展检测；防挂死兜底默认有界且可 opt-out | 工具执行（D1）、命令执行（D4） |
| **等人工操作** | 等一个不在屏幕前的人做出决定——例：confirm 弹窗等用户点击、权限审批等用户放行 | 本仓裁决值 30min（dialog-queue 先例）+ 请求方显式覆盖 | UI 弹窗（D2）、权限审批（D3） |
| **控制面单请求** | 宿主与插件之间的协议握手 / 生命周期消息往返——例：loadPlugin 模块加载、activate/deactivate 回复、hook 拦截链 | 秒级 | activate（D4）、load（D5）、hook（D6 不动） |

**本模块超时机制现状**（普查报告 rt-svc-plugin，全部亲自核实）：固定墙钟均经 `setTimeout` 或 `PendingTracker.register(key, timeoutMs, error)`（`utils/async/pending-tracker.ts`——统一「超时 reject / 回复 clearTimeout」样板）落地；**无 idle / 无进展检测能力**。这个机制约束是 D1 方案论证的前提。

## 2. 设计目标

**本章结论**：从插件作者、pi agent、桌面用户三类使用者的体验倒推五条目标。

1. **长工具不误杀**：插件作者写一个跑 60s+ 的工具（代码分析、批量处理、子代理调用），pi agent 调用后能拿到真实结果，不被 30s 砍成 `isError`（回溯审计 ❌3）。
2. **人不被替答**：用户离开屏幕 5min 回来，插件的 confirm 弹窗还在等他；权限审批弹窗没见他，插件也不会被判「拒绝而卸载」。
3. **错误诚实**：任何超时错误都告诉受害者（pi agent / 插件作者 / 用户日志）等了多久、对面发生了什么、怎么调整（声明 `timeoutMs` / 传 `timeout` / 重试）。
4. **挂死仍有兜底**：插件 handler 死循环时，pi turn 不会被永久占死——兜底有界、可被插件作者显式 opt-out（规则 19「回收层防挂死兜底允许默认有界」条款）。
5. **每个超时有逃生门**：任务级与等人工类超时均可由「最了解对象的一方」（插件作者 / 请求发起方）显式指定；控制面超时保持秒级但留覆盖参数。

**In-scope**：`plugin-service/` 内 6 类超时的默认值、覆盖通道、到期行为；`ToolRegistration` 增加声明字段；两条 expired 广播（前端撤窗联动项）；契约文档同步。
**Out-of-scope**：pi 侧 bridge extension 的 abort/signal 传播（`bridge/index.ts:29` 的 `_signal` 被忽略，独立缺口另行登记）；无进展检测协议改造（progress 事件通道，见 D1 被否谱系）；前端弹窗 UI 本身的交互 redesign；permission 扩展请求 `APPROVAL_TIMEOUT` 5min（audit §2 A 组暂缓项）；renderer 侧 65s 默认的结构性守卫（Doc 4/5 范围）。

## 3. 现状：使用者眼里是什么样的

**本章结论**：三类使用者在现状下分别遭遇「长工具必被误杀」「人不在场即被替答」「慢审批即被卸载」；根因是超时量级按实现便利（一个模块级常量）设定，覆盖参数存在但生产未接线。

### 3.1 现状的真实样子

**插件作者注册工具**（`plugin-types.ts:324-330`，真实定义）：

```ts
export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Worker 侧本地执行 handler，在 createToolApi 注册时存储 */
  execute?: ToolExecuteHandler
}
```

没有任何超时字段——插件作者**无处声明**「我的工具要跑 10 分钟」。

**pi agent 调用插件工具**：pi 侧 bridge extension 轮询 `bridge:sync` 拿到工具清单后注册为 pi 工具，执行时（`resources/pi/agent/extensions/bridge/index.ts:29-35`，实装原文）：

```ts
execute: async (toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
  if (bridgeState !== 'Ready') return { content: 'Plugin system initializing', isError: true }
  return api.extension_ui_request({
    method: 'bridge:tool_execute', toolName: tool.name,
    toolCallId, params, sessionId: ctx?.sessionId,
  })
}

runtime 侧（`bridge-interop.ts:97-133`）用**模块级常量**一刀切：

```ts
const TOOL_EXECUTE_TIMEOUT_MS = 30_000          // :18
// ...
const result = await rpcServer.invoke(
  handle.workerId, 'plugin.tool.execute', { ... }, TOOL_EXECUTE_TIMEOUT_MS)  // :119-127
// ...
} catch (err) {
  if (err.message.includes('RPC timeout')) {
    return { content: 'Plugin tool execution timed out', isError: true }      // :131-132
  }
```

注意 `invoke` 的第四参 `timeoutMs` 是**必传无默认**（`plugin-rpc-server.ts:142`）——机制上调用点显式指定，问题只在 bridge-interop 调用点把值写死为 30s 且无读取通道。

**插件弹 confirm 对话框**（`api/ui-api.ts:171-175`，Worker 侧）：

```ts
showConfirm: (title: string, message: string) =>
  rpcClient.request('plugin.ui.showConfirm', { pluginId, title, message }) as Promise<boolean>,
```

不传第三参 `timeoutMs` → 落 `plugin-rpc-client.ts:15` 的 `DEFAULT_TIMEOUT_MS = 30_000`。主线程侧 `UiRequestQueue`（`ui-request-queue.ts`）收到后再挂一层：

```ts
const UI_REQUEST_TIMEOUT_MS = 60_000                                   // :19
const defaultResult = method === 'confirm' ? false : undefined         // :97
const timer = setTimeout(() => {
  this.pendingUiRequests.delete(requestId)
  this.processNext()                    // 串行队列放行下一个            // :100-101
  resolve(defaultResult)                // 替答：confirm=false           // :102
}, UI_REQUEST_TIMEOUT_MS)
```

**权限审批**：插件首次激活且有未批准权限时，`plugin-activator.ts:227-243` 等用户审批：

```ts
const approved = await approvalPromise   // waitForPermissionApproval，:415-421
if (!approved) {
  this.setState(pluginId, 'UNLOADED')    // 判拒 → 不装载
  return
}
```

`waitForPermissionApproval` 的 timer 到点 `resolve(false)`（:417-420）——**超时与用户点「拒绝」不可区分**，都走 UNLOADED。覆盖参数 `permissionTimeoutMs`（:66 / 构造接线 :119）注释写着「覆盖权限审批超时（测试用）」，而生产装配点 `plugin-service.ts:184-189` 构造 `PluginActivator` 时只传了 `permissionChecker` 和 `onPermissionRequest`——**参数存在但生产不可达**。

### 3.2 怎么出错（真实失败模式）

**失败模式 A（P0，长工具误杀）**：插件作者写一个 60s 的分析工具。pi agent 调用 → 30s 时 `PendingTracker` reject → bridge-interop 捕获 → pi agent 收到 `isError: 'Plugin tool execution timed out'`。插件 handler **还在 Worker 里跑**（PendingTracker 只删登记项，不中止执行），跑到 60s 返回真实结果——迟到回包因登记已删被丢弃。pi agent 拿着假错误做出错误决策（告知用户「工具失败」），与 zcode 300s turn 误杀（21% 任务、死后继续烧 token）同构，只是量级更短。触发条件：任何 handler 执行 > 30s 的插件工具——普查当日插件生态里「批量处理 / 子代理编排 / 大仓库分析」类工具全部命中。

**失败模式 B（P1，弹窗替答——且实际比 60s 更糟）**：插件弹 confirm，用户切走窗口。链路上有**两层超时在竞速**：

```
插件(Worker) --rpcClient.request(默认30s)--> 主线程 ui-api --> UiRequestQueue(60s) --> 前端弹窗
```

30s 时**内层先到期**：Worker 侧插件收到 `RPC_TIMEOUT` reject（不是替答、是报错）。60s 时外层再到期：主线程 `resolve(false)` 替答并放行串行队列下一个——但这个 `false` 已无人消费（插件的 promise 在 30s 时已 reject），纯粹的幽灵状态。普查报告标注的「60s 替答」实际高估了现状：**真实生效的是 30s RPC 报错**。附带伤害：前端弹窗还挂在屏幕上（没人告诉它撤回），用户回来点「确定」→ `handleResponse` miss → noop，用户对着一个死弹窗点击。

**失败模式 C（P1，慢审批即卸载）**：插件带权限激活，权限弹窗广播到前端。用户在开会，31s 后 timer `resolve(false)` → 插件 UNLOADED。用户 5min 后回来点「批准」→ `resolvePermissionApproval`（:432-438）发现 pending 已删 → **noop，批准被静默吞掉**。用户以为批了，插件实际没装上；下次 activation event 触发时会重新走一遍激活+审批（状态机允许 UNLOADED 重触发）——但用户不知道要等/要再批一次。

**失败模式 D（边界，控制面量级争议）**：activate 回复等 30s（:44，使用 :263）、前端触发的命令 handler 等 10s（`api/commands-executor.ts:15`，PendingTracker 使用 :66）。activate 契约上「应轻量」，但无机制阻止插件在 `onActivate` 里做重初始化（拉配置、建连接）；命令更是用户显式点击按钮触发任意插件逻辑——10s 内跑不完的命令（批量导出、扫描）直接被 reject `code -32000`。

**失败模式 E（附赠#5，Worker 泄漏）**：Worker 版 `loadPlugin` 超时（`plugin-host.ts:108` 常量、:387-389 timer）**只 reject，不 terminate 线程**。fork 版同名常量（`plugin-host-process.ts:26`）超时后 `terminateProcess`（:192-195）清理子进程。模块顶层代码死循环的插件会让 Worker 线程永久泄漏（`loadedModules` 残留），长时间运行的 runtime 泄漏面持续累积。

**失败模式 F（小，timer 空转）**：热重载 `performReload` 的 deactivate race（`plugin-hot-reload.ts:125-128`）：`setTimeout` 句柄未保存，deactivate 正常完成后 5s timer 仍 armed 到期——空转一次空 reject（Promise 已 settle，无害但脏）。

### 3.3 根因

四个症状（A/B/C/D）共享同一根因：**超时量级按「实现便利」而非「对象粒度」设定**——每个「等回复」点就地写一个模块级常量，值的大小取决于写代码时的直觉（30s/60s/10s），不取决于被等的东西是「插件跑业务代码」「等一个不在场的人」还是「协议握手」。规则 19 把这个直觉错误形式化为反模式：任务级秒级必误杀（zcode 300s 误杀 21% 是已发生的实证）、人工等待被秒级判死、控制面反而不该长的地方没逃生门。

次级根因三个：
1. **覆盖参数「测试化」**：`permissionTimeoutMs` 这类参数设计时就有，但注释定位测试用、生产装配点不传——「有参数」≠「有通道」。
2. **双层超时无单一权威源**：UI 请求链路上 client 30s 与 queue 60s 各自为政，生效的是先到期的短的那个，语义层（queue）的「60s 替答」设计从未真正执行过。
3. **两宿主实现漂移**：Worker 版与 fork 版 loadPlugin 同名常量、不同到期行为——对称性靠人肉记忆维护，必然漂移。

## 4. 根因 + 物理数据流

**本章结论**：三条物理链路（工具执行 / UI 弹窗 / 权限审批）上的墙钟位置全部定位，每条链路的「最长真实耗时」由谁决定一目了然——这就是 §5 每个决策的裁定依据。

### 4.1 工具执行链路（失败模式 A）

```
pi agent loop (pi 进程)
  └─ bridge extension (resources/pi/agent/extensions/bridge/index.ts)
       │  轮询 bridge:sync 拿工具清单，注册为 pi 工具
       │  执行时: api.extension_ui_request({method:'bridge:tool_execute', ...})   (:31-34)
       │  （:30 有 bridgeState!=='Ready' 前置守卫，未就绪直接 isError）
       │  ⚠ pi 侧无超时（rpc-mode.js:70-77 pendingExtensionRequests 只 set(id,{resolve,reject})，无 timer）✅已核实
       ▼  (pi ↔ runtime RPC: extension_ui_request 通道)
runtime bridge-handler (transport/bridge-handler.ts:37-42)
  └─ pluginService.handleBridgeToolExecute (plugin-service.ts:718)
       └─ bridge-interop.ts:97 handleBridgeToolExecute
            └─ rpcServer.invoke(workerId, 'plugin.tool.execute', {...}, 30s)   ← ★唯一墙钟 :18/:127
                 └─ PendingTracker.register(id, 30s, Error('RPC timeout'))     (plugin-rpc-server.ts:149)
                      ▼
              Worker 线程 (trusted, 多插件共享≤10) 或 fork 子进程 (sandbox, 每插件一进程)
                 └─ 插件 handler 执行（任意时长，无进度事件回传）
                      └─ 回包 → PendingTracker.resolve → 原路返回 pi
           超时 → catch(:131) → {content:'Plugin tool execution timed out', isError:true} → pi agent
           迟到回包 → tracker miss → 丢弃（handler 仍在跑，结果浪费）
```

**关键论断**：`plugin.tool.execute` 是单发 RPC request/response——插件 handler 执行期间**没有任何进度/心跳事件回到主线程**（PendingTracker 样板无此能力，插件 API 也无 progress 通道）。因此「无进展检测」在当前协议下不可行；若要防「handler 挂死占死 pi turn」，上界不可回避——这是 D1 归属论证的支点。

### 4.2 UI 弹窗链路（失败模式 B）

```
插件代码 (Worker 内)
  └─ ctx.ui.confirm(title, message)
       └─ createUiApi.showConfirm → rpcClient.request('plugin.ui.showConfirm', {...})   (ui-api.ts:171-175)
            └─ PendingTracker.register(id, 30s)          ← ★墙钟1（先到期！）plugin-rpc-client.ts:15/:40
                 ▼
runtime PluginRpcServer → registerUiRpcHandlers → UiRequestQueue.handleRequest
  └─ dispatch: broadcast('plugin:uiRequest', ...) → 前端渲染弹窗
       └─ setTimeout(60s) → resolve(false) + processNext()  ← ★墙钟2（永远轮不到）ui-request-queue.ts:99-103
用户点击 → 前端 → handleResponse(requestId, result) → clearTimeout → resolve → 插件
超时(30s) → 插件收到 RPC_TIMEOUT reject；60s 时队列再替答一次（无人消费）；前端弹窗残留
```

**关键论断**：两层墙钟竞速，生效的是 30s。修复的根本原则是**全链路只留一个计时权威**——语义计时（默认值 + 请求方覆盖解析）归属请求发起方（Worker 侧 ui-api），传输计时与语义计时合并为同一个 timer；queue 侧退为防泄漏兜底（恒晚于语义到期，只在 cancel 通知丢失 / Worker 死亡时收尾）。反对把语义裁决留在 queue 再给 client 加固定余量：queue 的语义 timer 在 `dispatch` 时才挂（ui-request-queue.ts:68-73 排队请求不 dispatch），而 client timer 在 `request()` 发起时即挂（plugin-rpc-client.ts:52）——排队请求的传输计时含排队等待、语义计时不含，固定余量覆盖不了无上界的串行排队（详见 §6.2 被否谱系）。

### 4.3 权限审批链路（失败模式 C）

```
activation event (onStartupFinished / onSlashCommand:xxx)
  └─ plugin-activator.doActivatePlugin (:213)
       ├─ permissionChecker.getUnapproved > 0
       ├─ waitForPermissionApproval(pluginId)        ← ★墙钟 :415-421 (30s, permissionTimeoutMs 可覆盖但生产未接线)
       ├─ broadcast('plugin:permissionRequest')      → 前端渲染审批弹窗
       ├─ await approvalPromise
       │    ├─ resolvePermissionApproval(pid, true/false)  ← 用户点击（:432-438）
       │    └─ 30s timer → resolve(false)                  ← 超时与拒绝不可区分
       └─ !approved → setState(UNLOADED)            (:240-242)
            用户迟到点击批准 → pending 已删 → noop（批准被吞）
```

### 4.4 裁定框架总表（六个设计点的对象粒度裁定）

| 超时点 | file:line（亲自核实） | 被保护对象 | 粒度 | 现值 | 裁定值 | 决策 |
|---|---|---|---|---|---|---|
| 工具执行 | bridge-interop.ts:18（用 :127） | 插件业务代码执行 | 任务级 | 30s | 默认 30min + 声明覆盖 + opt-out | D1 |
| UI 弹窗（client 层 → v2 唯一计时权威） | plugin-rpc-client.ts:15（ui-api.ts:171-184 不传参） | 等用户点击（计时起点 = 插件调用，含排队） | 等人工 | 30s | 唯一语义计时器：默认 30min + `opts.timeout` 覆盖；到期 `UI_TIMEOUT` + cancel 通知 | D2 |
| UI 弹窗（queue 层 → 防泄漏兜底） | ui-request-queue.ts:19（timer :99-103） | 同上（兜底收尾，正常不裁决） | 等人工 | 60s | 删语义裁决与替答；兜底 = effective+60s（仅 cancel 丢失 / Worker 死亡时收尾） | D2 |
| 权限审批 | plugin-activator.ts:45（接线 :119 注释测试用；timer :417-420） | 等用户审批 | 等人工 | 30s | 默认 30min + env 覆盖；到期取消非判拒 | D3 |
| activate 回复 | plugin-activator.ts:44（用 :263） | 生命周期握手 | 控制面 | 30s | 30s 保持 + `activateTimeoutMs` 覆盖 + 契约文档 | D4 |
| 命令执行 | api/commands-executor.ts:15（PendingTracker :66） | 用户触发的插件动作 | 任务级 | 10s | 默认 30min + 命令定义级声明 | D4 |
| Worker loadPlugin | plugin-host.ts:108（timer :387-389） | 模块加载握手 | 控制面 | 10s | 值不动；超时后 terminate + rebuild 链 | D5 |
| fork loadPlugin | plugin-host-process.ts:26（:123 可覆盖；:195 terminate） | 同上 | 控制面 | 10s | 不动（D5 参照系） | D6 |
| hook handler | hook-pipeline.ts:24（用 :95） | 拦截链单 handler | 控制面 | 5s 超时放行 | 不动（规则 16 先例） | D6 |
| deactivate 回复 | plugin-activator.ts:43（用 :338） | 生命周期握手 | 控制面 | 5s（超时仍本地清理） | 不动 | D6 |
| hot-reload deactivate | plugin-hot-reload.ts:45（race :125-128） | 生命周期握手 | 控制面 | 5s + forceTerminate | 值不动；timer 句柄小修 | D5 |

**量级依据**：30min 不是拍脑袋——本仓两处既有裁决同值：①「等人工」裁决（`subagent-core/src/execution/dialog-queue.ts:46-47`，`DEFAULT_DIALOG_TIMEOUT_MS`，注释明示「30 分钟是裁决值：ask_user 挂起 30 分钟无响应视为放弃」，请求方 `req.timeout` 显式覆盖、非法回落、clamp 上限，到期 settle `{cancelled:true}` + warn 恢复指引）；②「任务级兜底下限」（`session-runner.ts:155` `SPAWN_WATCHDOG_FLOOR_MS`=30min，subagent spawn watchdog 估算下限）。zcode 300s 误杀实证（21% 任务）划出「任务级秒级必误杀」的红线。

## 5. 终态：使用者眼里将是什么样的

**本章结论**：插件作者可声明长工具且被尊重；pi agent 的超时错误可决策可恢复；用户离席不再被替答；插件挂死仍有 30min 兜底。

### 5.1 成功路径

**插件作者注册长工具**（新 API 形态）：

```ts
ctx.tools.register({
  name: 'analyze-codebase',
  description: '...',
  parameters: { ... },
  timeoutMs: 600_000,        // 新增可选字段：声明该工具最长执行 10min
})
```

**pi agent 调用 90s 长工具**（未声明的工具吃 30min 默认）：

```
[pi agent] 调用 analyze-codebase 工具
[bridge extension] → bridge:tool_execute → runtime → Worker
[插件 handler 执行 90s —— 90s > 旧 30s 墙钟，新默认 30min 内]
[插件回包] → pi agent 收到真实工具结果，继续推理        ← §1 目标 1 成立
```

**用户离开 5min 回来点弹窗**：

```
[插件] await ctx.ui.confirm('应用重构？', '将改写 42 个文件')
[用户切去开会，5min] —— 弹窗在前端持续显示，两层墙钟均 30min
[用户回来点「确定」] → 插件收到 true，继续执行           ← §1 目标 2 成立
```

**慢审批**：

```
[activation event] → 权限弹窗 → 用户 10min 后才看到 → 点「批准」
→ 插件正常激活（ACTIVE）                                ← §1 目标 2 成立
```

### 5.2 失败路径（带恢复指引）

**未声明工具挂死（30min 兜底）**：

```
[pi agent] 调用 slow-tool（作者未声明 timeoutMs）
[30min 后 runtime] PendingTracker reject → bridge 返回：
  isError: "Plugin tool 'slow-tool' timed out after 30min (default; plugin handler
            may still be running, its result will be discarded). Plugin authors:
            pass timeoutMs in registerTool() to extend or opt out (<=0 = no limit)."
[pi agent] 收到 isError，自行决策：告知用户 / 换路径 / 放弃   ← §1 目标 3/4 成立
👉 恢复指引（错误消息内嵌）：插件作者加 timeoutMs；pi agent 可重试
```

**弹窗 30min 无人响应（取消 ≠ 替答）**：

```
[插件] await ctx.ui.confirm(...)（未传 opts.timeout）
[30min 后 runtime] warn 日志（含等待时长与恢复指引）
  + broadcast('plugin:uiRequestExpired', {requestId, pluginId})  → 前端撤回弹窗
  + 插件收到 reject Error('ui request timed out after 30min', code='UI_TIMEOUT')
[插件] catch 决定自己的默认行为（重发提问 / 放弃操作）——不再被替答 false   ← §1 目标 2/3 成立
👉 恢复指引：需要更长等待传 opts.timeout（毫秒，全程含排队）；用户离开前弹窗一直等
```

**审批 30min 超时（取消 ≠ 拒绝，插件可重触发）**：

```
[审批 30min 无人响应] → warn 日志 + broadcast('plugin:permissionRequestExpired')
  → 本次激活取消（插件置 UNLOADED——未装载态，非「被拒」）
  → 前端撤回审批弹窗；用户迟到点「批准」→ 前端提示已过期
[下次 activation event]（如再次触发该 slash command）→ 重新激活 + 重新弹审批  ← §1 目标 2/3 成立
👉 恢复指引：重触发激活事件即可；全局调等待时长用 env XYZ_PLUGIN_PERMISSION_TIMEOUT_MS
```

**Worker loadPlugin 超时（线程被回收）**：

```
[插件模块顶层死循环] → 10s 超时 → worker.terminate() + loadedModules/rebuild 索引清理
  → 走既有 crash/rebuild 链（handleWorkerCrash：crashedTrustedWorkers 记录 + 冷却后 rebuild）
[runtime 日志] warn: loadPlugin timeout → worker terminated & scheduled rebuild   ← 附赠#5 成立
```

## 6. 关键决策与权衡

**本章结论**：六个决策分别处理 D1 工具执行（P0 根修）、D2 UI 弹窗、D3 权限审批、D4 控制面裁定线、D5 Worker 回收对称化、D6 登记不动项，共同把 §4 总表右侧的裁定值落地。

### 6.1 D1：工具执行超时——默认 30min + 工具定义级声明覆盖 + 显式 opt-out（选定）

- **采用**：三层取值结构，单一权威源在 bridge-interop 调用点：`有效超时 = entry.schema.timeoutMs（插件作者声明，合法正数） ?? DEFAULT_TOOL_EXECUTE_TIMEOUT_MS（30_000_000，新常量）`；`timeoutMs <= 0` 或 `Infinity` 视为显式 opt-out（不限时，直接不挂 PendingTracker 超时——invoke 侧需支持 `timeoutMs = 0` 表示不注册超时或传一个 2^31-1 clamp 值，实现取简单者）。超时后行为：isError 保留（工具级失败让 pi agent 自行决策重试——pi 的工具错误语义本就如此）+ 错误消息按 §5.2 诚实化（等了多久 / 默认还是声明值 / handler 可能仍在跑 / 如何调）。不 terminate 插件宿主（长任务 ≠ 插件坏；迟到回包 PendingTracker miss 丢弃即可）。
- **被否**：
  - **方案 a：纯声明制**（未声明维持 30s 短默认，声明了才放宽）——存量插件全部未声明，30s 误杀照旧；且把「系统防挂死兜底」的责任转嫁给插件作者（不写声明就被砍），激励倒挂。若用它，§5.1 的 90s 工具场景变成：作者忘了声明 → 30s 被 isError → 用户以为插件坏了。
  - **方案 c：默认不挂（不限时）纯 opt-in**——最贴规则 19 字面（「调用方未传就是不限时」），但被 dialog-queue LC-3 的同类论证击穿：插件 handler 死循环 → pi turn 永久占死（pi 侧 extension_ui_request 无超时，✅已核实 rpc-mode.js:70-77）→ 用户只 能重启 session。dialog 先例的原话：「『等用户无限久』改为默认有界是有意的行为变更」——防全局死锁的有界兜底是本仓已裁决的方向。若用它，§2 目标 4（挂死有兜底）被放弃。
  - **被否谱系（无进展检测完整形态）**：给插件 API 加 progress 事件通道（handler 周期上报进度刷新计时，busy 永不判死——idle timer 范式）——架构上最正确，但要新增 Worker→host→bridge→pi 的进度 RPC 通道并改 bridge extension，改造面横跨四层；当前插件生态无此需求证据（误杀是实证、挂死无实证）。**若未来出现「合法跑数小时」的工具需求，此方案是升级路径**，届时 D1 的声明通道平滑兼容（声明 `timeoutMs: Infinity` + progress 通道）。
- **证据**：执行形态无进度回传（§4.1 论断 + PendingTracker 机制约束）→ 无进展检测不可行 → 归属规则 19「回收层防挂死兜底 = 默认有界 opt-out」条款；量级=任务级兜底下限 30min（`session-runner.ts:155` SPAWN_WATCHDOG_FLOOR_MS 同值）+ dialog 30min 裁决（dialog-queue.ts:46）；zcode 300s 误杀 21% 实证秒级必误杀；`invoke` timeoutMs 必传机制（plugin-rpc-server.ts:142）证明「调用点显式指定」的通道现成，只缺读取源；`ToolRegistration`（plugin-types.ts:324-330）现无字段（✅已核实）；声明值传播链现成——Worker 注册 → `toolRegistry` → `bridgeToolCache.syncFrom`（bridge-interop.ts:71-75 缓存层整体同步 schema，runtime 裁决点本地可读 `entry.schema.timeoutMs`）；注意 `getSyncPayload` 只塑形 `{name, description, parameters}`（bridge-interop.ts:92），`timeoutMs` **不进 `bridge:sync` 负载**——pi 侧不可见亦无需可见（裁决在 runtime 本地，不经 pi）。声明值合法性校验对齐 dialog-queue `isValidDialogTimeout` / `resolveDialogTimeoutMs` 先例（合法正数、非法回落默认、clamp `MAX_TIMER_DELAY_MS` 防 Node timer 塌缩 1ms 语义反转）。
- **效果**：§2 目标 1（长工具不误杀）、3（错误诚实）、4（兜底）、5（逃生门）全部成立；§5.1/§5.2 前两个场景成立。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| a 纯声明制（未声明=30s） | 差：兜底责任转嫁作者，存量插件不受益 | 低（一个字段+读取） | 误杀照旧，用户无感升级 | ❌ |
| **b 默认 30min + 声明覆盖 + opt-out（选）** | 好：兜底归系统、量级归作者、逃生门显式 | 低（常量 + 一个可选字段 + clamp 校验） | 挂死工具占住 pi turn 等待 30min 才拿到 isError，**且这 30min 内无任何层可中断**——pi abort 不传播至 bridge 调用（rpc-mode.js:47-77 `createDialogPromise` 的 signal/timeout 是 opt-in，bridge 的 `extension_ui_request` 走 pendingExtensionRequests 直接登记无 timer 无 abort，rpc-mode.js:177，✅已核实）。可接受性：①正常任务（30min 内完成）零影响；②aborted turn 的 handler 残留是既有行为（30s 时代同样不中断），新默认仅拉长残留窗 30s→30min，且残留 = handler 继续跑完、结果被丢弃，不阻塞其他 turn/session；③缓解：插件作者可声明小 timeoutMs；④根治 = signal 传播缺口，§11 独立登记（out-of-scope）。早杀是假错误、晚杀是诚实兜底——两害取其轻 | ✅ |
| c 默认不挂纯 opt-in | 差：死循环挂死 pi turn，重启才能解 | 最低 | 高（全局死锁回归） | ❌ |
| d 无进展检测完整形态（progress 通道） | 最优（busy 永不判死） | 高（四层协议改造） | 改造面大、无需求实证 | ❌（记为升级路径） |

### 6.2 D2：UI 弹窗超时——单一计时权威（Worker 侧）+ `opts.timeout` 覆盖 + 到期取消语义（选定）

- **采用**（v2 重构：计时权威归属请求发起方，queue 退为防泄漏兜底）：
  1. **Worker 侧（createUiApi）是唯一计时权威**：`opts.timeout`（插件 API 新增可选参数，形态对齐 pi 先例 `showConfirm(title, message, opts?: { timeout?: number })`）经 `resolveUiRequestTimeoutMs`（对齐 dialog-queue `resolveDialogTimeoutMs`：合法正数优先 / 非法回落默认 30min / clamp）解析为 effective；`rpcClient.request(method, params, effective)` 显式传参——**传输计时与语义计时合并为同一个 timer**（client 的 PendingTracker timer 就是语义裁决者，plugin-rpc-client.ts:52 发起即挂），链路上不存在「两层谁先到期」。`opts.timeout` 语义 = **从调用到拿到结果的最长全程等待，含串行排队时间**——排队也是插件在等，从请求方视角计时才诚实。
2. **requestId 生成权移到 Worker 侧**：现状由 queue 在 `handleRequest` 生成（ui-request-queue.ts:66），而 Worker 侧的取消通知需要引用它——改为 ui-api 生成随 params 传递，queue 尊重来方 requestId。**唯一性规则（v1.1 补，审查 MF1）**：生成 id 必须全局唯一——`${workerId}-${自增}` 或 UUID（对齐既有 id 惯例），防共享 Worker（≤10 插件同线程同 rpcClient）内两插件并发请求 id 碰撞导致 cancel 误删他方 pending/错撤他人弹窗；queue 侧对重复 id 的行为 = warn + 丢弃后到者（防御性）。
  3. **到期行为从「替答」改「取消」**：Worker 侧 timer 到期 → PendingTracker reject → ui-api catch 转译为 `Error('ui request timed out after N', code='UI_TIMEOUT')` reject 给插件（effective timer 的 reject 只可能来自语义到期，转译安全）→ 同刻 `rpcClient.notify('plugin.ui.uiRequestExpired', { requestId, pluginId })`（**复用既有 Worker→host notification 通路**，plugin-rpc-server.ts:175-190 无 id 消息 dispatch 已存在，仅注册新 method handler）→ 主线程 queue `cancelRequest(requestId)`：删 pending / 排队项 + `broadcast('plugin:uiRequestExpired', { requestId, pluginId })`（前端撤回弹窗；`ServerMessageMap` 新增类型，类型定义随本单元落地）+ 若该请求正活跃则 `processNext()` 放行（串行防死锁保留）。warn 日志（等了多久 + 恢复指引）在 Worker 侧 reject 处打。**命名对齐规则（v1.1 补，审查 S2）**：Worker→host notify 用 `plugin.ui.*` RPC 域；host→renderer broadcast 用 `plugin:*Expired`（ServerMessageMap 域）——两条通路命名前缀不同，实施时勿混用。
  4. **queue 侧删语义 timer，换防泄漏兜底**：删除 `UI_REQUEST_TIMEOUT_MS` 60s 语义 timer 与 `defaultResult` 替答；queue 收到请求时挂**兜底** timer = `effective + 60s`（入队起算，与 Worker 侧语义 timer 同起点、值恒更大）——正常路径下 Worker 先到期 + cancel 通知到达，兜底被 clearTimeout；兜底只在 cancel 丢失 / Worker 死亡（线程死则语义 timer 随之消失）时触发，做同样的清理 + 撤窗 + 放行 + warn。兜底不参与语义裁决、永不与语义裁决竞速——「防泄漏余量」从「覆盖排队等待（无上界）」缩为「覆盖一条 cancel 通知的传播（秒级）」，固定余量重新成立。
- **被否**（v2 新增三条置前）：
  - **[v1 采用方案，被反例击穿] queue 唯一裁决 + client 传「语义值 + 60s 固定余量」**——击穿反例：client timer 从 `request()` 发起即挂（plugin-rpc-client.ts:52）且计时**含排队等待**，queue 语义 timer 到 `dispatch` 才挂（ui-request-queue.ts:68-73 排队不 dispatch）且**不含排队**——前置一个全时长 30min 弹窗时，第二个弹窗传输层在 ~30min+60s 报 RPC_TIMEOUT、语义层要 ~60min 才裁，失败模式 B（传输层先于语义层报错）原样复发；且队列长度无上界，任何固定余量都不封闭。v1 援引的「UI = RPC + 余量」handoff 范本只适用于各层计时**同起点**的链路，串行排队打破了同起点前提。
  - **[重置方案] queue 出队 dispatch 时经 host→Worker 反向通知重置 client timer**——可实现「从展示起算」，但需新增 host→Worker 通知 + client reset API（双向协议改动），并引入 reset 与到期的竞速；被「Worker 侧单向 notify cancel」取代（复用既有 notification 通路，零新协议形态）。
  - **[余量方案] client 余量 = 语义值 + 队列最长可能等待**——串行队列长度无上界（插件可连续弹 N 个），静态余量数学不封闭；动态计算需 Worker 知晓队列状态，又回到反向通知。
  - **保持替答只抬时长到 30min**——把「替用户拒绝」从 60s 推迟到 30min，伤害更隐蔽（用户回来看到「已经替你拒绝了」且不可撤销）。若用它，§5.2 弹窗超时场景变成：插件无感知拿到 false，把「没回答」当「回答了不要」处理——语义谎言。
  - **到期 resolve(undefined) 而非 reject**——`showSelect/showInput` 的 `undefined` 已被用作「用户关闭弹窗」语义，复用则超时与取消不可区分（对照：现状 confirm=false 与用户点「取消」就不可区分，正是要修的病）。reject 让「超时」成为插件可 catch 的独立错误类别，语义诚实。
  - **可配置无上界（默认无限等）**——与 D1 方案 c 同因被否：串行队列下 head-of-line 阻塞 + 全局弹窗死锁（dialog-queue LC-3 论证），且失败模式 B 的实测证据（两层竞速）说明该链路历史上就没被长等待设计过。
- **证据**：双层竞速 ✅已核实（ui-api.ts:171-184 五方法均不传第三参 → client 30s 先于 queue 60s 到期，见 §4.2）；排队不 dispatch / dispatch 才挂 timer ✅已核实（ui-request-queue.ts:68-73 / :99-105）；client timer 发起即挂 ✅已核实（plugin-rpc-client.ts:52 先 register 后 postMessage）；Worker→host notification 通路既有 ✅已核实（plugin-rpc-server.ts:175-190 无 id 消息 dispatch + plugin-rpc-client.ts:68 `notify`）；30min + 显式覆盖 + 取消语义 = dialog-queue 全套先例（dialog-queue.ts:46 `DEFAULT_DIALOG_TIMEOUT_MS` / `resolveDialogTimeoutMs` / `{cancelled:true}` + warn 恢复指引）；requestId 现状生成点 ✅已核实（ui-request-queue.ts:66）。
- **排队场景反例重演（修复验证）**：弹窗 A（默认 30min）先到立即 dispatch，弹窗 B 排队。B 的语义 timer（Worker 侧）与 queue 兜底 timer 同起点（B 发起时刻）起跑。T+30min：B 语义到期 → `UI_TIMEOUT` reject → cancel notify → queue 删 B 排队项（B 从未展示，无需撤窗）→ A 不受影响继续等满自己的 30min；全程无传输层先到期。若 A 提前 settle，B 出队展示，B 剩余等待 = 30min − 排队耗时（「全程语义」的直接推论：插件作者声明 timeout 即按全程预算）。
- **效果**：§2 目标 2/3 成立；§5.1 弹窗场景 + §5.2 弹窗超时场景成立；失败模式 B 的三层病灶（30s 报错 / 60s 幽灵替答 / 前端死弹窗）全部消除，且在串行排队场景封闭（v1 方案不封闭，见被否谱系首条）。

### 6.3 D3：权限审批超时——`permissionTimeoutMs` 转正 30min + env 逃生门 + 到期取消语义（选定）

- **采用**：
  1. **值**：`PERMISSION_TIMEOUT_MS` 30s → 30min（与 D2 同为「等人工」粒度，同一裁决值）；`ActivatorOptions.permissionTimeoutMs` 参数从「测试用」转正——生产装配点 `plugin-service.ts:184-189` 接线，值 = `env XYZ_PLUGIN_PERMISSION_TIMEOUT_MS`（若设合法正数）→ 否则新常量。env 命名对齐 `XYZ_SUBAGENT_IDLE_TIMEOUT_MS` 先例（lifecycle-manager.ts:68：env 可配、非法 warn 回落默认）。
  2. **到期行为从「判拒」改「取消」**：`waitForPermissionApproval` 到期不再 `resolve(false)`，改为 resolve 可区分的 `'timeout'` 结局（Promise 类型收窄为 `boolean | 'timeout'`）；`doActivatePlugin` 收到 `'timeout'` → warn 日志（恢复指引）+ `broadcast('plugin:permissionRequestExpired', { pluginId })`（前端撤回审批弹窗）+ 本次激活取消（置 UNLOADED——该状态本就兼作「未装载」，且状态机允许后续 activation event 重触发激活，✅已核实 handleEvent 过滤条件只排除 ACTIVE/ACTIVATING）。收到显式 `false`（用户真点了拒绝）行为不变（UNLOADED）。用户迟到点「批准」时 pending 已删 → 前端收到 expired 广播后应已撤窗；若旧版前端仍派发批准，`resolvePermissionApproval` miss noop 维持（不炸），日志 debug 一条。重触发的精确语义：**30min 等待窗口内**重触发 activation event 被 handleEvent 候选过滤拦截（plugin-activator.ts:157 排除 ACTIVATING）——原审批等待继续有效，不产生第二个弹窗；**超时取消（UNLOADED）后**重触发才走新激活 + 重新弹审批（恢复指引据此写）。
  3. **权限存储不受影响**：超时不是拒绝，不写任何「拒绝」记录（现状 `resolve(false)` 也未写 storage——storage 只存批准，`getUnapproved` 过滤已批准项），重触发激活时同一批权限重新弹审批。
  4. **30min ACTIVATING 窗口的调度语义（为何可接受）**：`handleEvent` 对候选插件是**并行**激活（plugin-activator.ts:160 `Promise.allSettled`），且权限审批等待位于 `assignWorker` **之前**（:223-242 早于 :246）——等待中的插件不占 Worker 执行槽，不阻塞其他插件激活；startup 批量场景（onStartupFinished）各插件的审批弹窗各自独立等待。诚实披露：`handleEvent` 的调用方（plugin-lifecycle.ts:93 `await`）会被最慢的那个审批等待拖住——但等待条件是「用户未作答」，此时用户不在场，被拖住的 boot 收尾逻辑无用户可感知的损失。与 D4 论证的对齐：D4 否「activate 抬 30min」的论据是**占 Worker 执行槽**（activate 在 assignWorker 之后执行插件代码），审批等待不占槽——同一「启动链拖慢」论据在两处的适用性不同，不矛盾。
  5. **dismiss / 弹窗丢失路径**：现状审批弹窗 `hide-close` 无主动关闭通道（PermissionRequestDialog.vue:84，✅已核实），仅「批准 / 拒绝」两个出口——「用户主动 dismiss 不作答」路径现状不存在；若未来组件放开关闭（或 ESC 本地关闭不回传），runtime 侧视同「无人作答」自然落入超时取消路径（`'timeout'` 结局），无需新增处理分支。**已知限制（登记）**：前端审批弹窗为全局单例且不做队列（usePermissionRequest.ts:17-18「新请求覆盖旧 state」）——多插件并发审批时，先到的弹窗被后到者顶掉、runtime 仍在等待：30s 时代该插件 30s 即超时，30min 时代空窗被拉长至 30min。审批弹窗队列化是 renderer 侧既有 TODO（usePermissionRequest.ts:18），登记为本设计的联动依赖（U8/排期项），不阻塞 runtime 侧决策——runtime 语义（取消非判拒 + 可重触发）在队列化前后均成立。
- **被否**：
  - **仅转正参数不提值**（30s 保持 + env 可调）——30s 对「人不在场」仍是秒级判死；env 逃生门是给排障的，不是给每个用户日常配置的（默认值必须本身合理——与 streaming 死口反例同理：把默认值做对，配置口才不是必需品）。
  - **接 configService 配置面**（settings UI 可调）——plumbing 重（settings 存储 → renderer 设置页 → runtime 读取三层），而「等权限审批多久」没有证据表明需要 per-app 用户配置；env + 合理默认已覆盖排障诉求。若未来用户侧诉求出现，env → configService 是平滑升级（单一读取函数替换）。
  - **到期保持判拒但提升到 30min**——时长对了语义仍错：用户 31min 回来看到插件「被拒载」，与自己点拒绝的后果不可区分，而前者应可重试。取消语义（expired 广播 + 可重触发）是本决策的核心，不只是改数。
- **证据**：生产未接线 ✅已核实（plugin-service.ts:184-189 构造 activator 未传 permissionTimeoutMs）；timer 与 `!approved → UNLOADED` 链 ✅已核实（plugin-activator.ts:415-421 / :240-242）；迟到批准 noop ✅已核实（:432-438 miss return）；UNLOADED 可重触发 ✅已核实（handleEvent 候选过滤仅排除 ACTIVE/ACTIVATING）；30min 裁决同 D2；env 先例 `XYZ_SUBAGENT_IDLE_TIMEOUT_MS`（lifecycle-manager.ts:68）。
- **效果**：§2 目标 2/3 成立；§5.1 慢审批 + §5.2 审批超时场景成立；失败模式 C 的「批准被吞」消除（expired 广播撤窗 + 重触发路径显式化）。

### 6.4 D4：activate / command 粒度裁定线——分类裁定，不一刀切（选定）

**裁定线（本设计的新增判断标准）**：保护对象是「宿主↔插件的协议消息往返」还是「插件业务代码执行」？前者按控制面秒级 + 覆盖参数 + 契约文档；后者按任务级 30min + 定义级声明（并入 D1 框架）。判据：**请求体是否执行插件作者写的、时长不可预期的业务逻辑，且该逻辑的成功执行本身就是请求的目的**。

- **采用**：
  - **activate（30s 保持 + 覆盖 + 契约）**：activate 的目的是「声明注册」（工具/hooks/命令清单），协议语义上是生命周期握手（控制面）。保持 30s；新增 `ActivatorOptions.activateTimeoutMs` 覆盖参数（对齐 fork 版 `loadTimeoutMs` :123 先例，测试与重初始化插件逃生）；extension 开发指南补契约：「`onActivate` 应保持轻量（注册声明），重初始化（拉配置、建连接、预热缓存）移到首个工具调用或命令 handler」。
  - **command（10s → 30min + 定义级声明）**：命令是用户显式点击 UI（状态栏按钮/命令面板）触发的插件动作执行——与 `plugin.tool.execute` 同粒度（任务执行），只是触发者是人不是 agent。`COMMAND_EXECUTE_TIMEOUT_MS` 10s → 复用 D1 的默认常量与声明结构（命令注册定义加可选 `timeoutMs`，取值链同 D1）。诚实错误消息同 D1 形态。
- **被否**：
  - **两者都抬 30min**：activate 抬 30min 放大「激活卡死」窗口——activation event 常在 startup 时批量自动触发（非用户在场），一个 `onActivate` 挂死的插件将占住 Worker 30min 才判失败，拖慢整个启动链。control-plane 语义下 30s + 覆盖是更准的量级。
  - **两者都保持秒级 + 只加覆盖参数**：command 保持 10s 意味着「用户点按钮跑批 30s+」必失败——与工具执行 30s 误杀是同一个错（对象是任务执行、量级给秒级），zcode 300s 教训的镜像。
  - **被否若用**：若采纳「都抬 30min」，§5.1 无影响但启动体验退化（startup 卡 30min 的极端窗口）；若采纳「都保持秒级」，用户点击的批量命令 10s 被 reject——§2 目标 1 对命令维度不成立。
- **证据**：activate 用点 :263（sendAndWaitReply）与失败 UNLOADED 链 ✅已核实；command PendingTracker 用点 :66 ✅已核实；「activation event 批量自动触发」见 §4.3 链路（onStartupFinished）；D1 框架复用（声明结构 / clamp / 诚实消息）使本决策增量成本趋近于零。
- **效果**：§2 目标 5（控制面逃生门）成立；失败模式 D 消除（重初始化插件有 activateTimeoutMs；批量命令不再 10s 误杀）。

### 6.5 D5：Worker loadPlugin 超时后回收对称化 + hot-reload timer 小修（选定）

- **采用**：
  1. **Worker 版 loadPlugin 超时 → terminate + 清理 + rebuild 链**：超时 reject 前/后调用既有 `handleWorkerCrash(workerId, 'loadPlugin timeout ...')`（plugin-host.ts:640-680——已含：幂等守卫 / `worker.terminate()` / `rpcServer.unregisterWorker` / `removeIndexEntries`（loadedModules 索引清理）/ trusted 记录 `crashedTrustedWorkers` / crash 计数 / 冷却后 `rebuildWorker`）。与 fork 版 `terminateProcess`（:192-195）行为对齐：**超时后宿主必回收**。
  2. **「连坐」是正确语义的论证**：load 超时 ≈ 插件模块顶层代码死循环 ≈ Worker 线程 event loop 卡死 ≈ 同宿主（共享 ≤10 插件）的一切 RPC 不可响应——此时该 Worker 已整体不可用，terminate + rebuild（连带同宿主其他插件重载）与 crash 路径的处理完全一致，是恢复而非伤害。若顶层代码只是「慢初始化」（>10s 合法场景），`loadTimeoutMs` 覆盖参数是逃生门（fork 版先例，Worker 版同步补齐同名参数）。
  3. **hot-reload timer 小修**：`performReload` 的 race timer（plugin-hot-reload.ts:125-128）提取句柄，deactivate 胜出路径 `clearTimeout`——消除 5s 空转（行为无变化的卫生修）。
- **被否**：
  - **超时只清理 loadedModules 不 terminate**（最小干预）——模块顶层死循环下线程已卡死，只删索引不杀线程 = 线程泄漏照旧（失败模式 E 未修）；「该插件不再派活」的僵尸防御治标不治本。
  - **照抄 fork 版为每插件单独 terminate**——Worker 是多插件共享线程，无「单插件隔离终止」手段；隔离手段本就存在于架构层（sandbox 插件走 fork 每插件一进程）。trusted 插件接受 worker 级回收是该信任级别的既有契约（crash 路径同款）。
- **证据**：Worker 版超时仅 reject ✅已核实（plugin-host.ts:387-389，无 terminate 调用）；fork 版 terminate ✅已核实（:192-195）；crash/rebuild 链完整存在 ✅已核实（handleWorkerCrash :640-680 + rebuildWorker + REBUILD_COOLDOWN_MS :110 / MAX_REBUILD_ATTEMPTS）；共享语义 ✅已核实（:391 注释「trusted Worker 多插件共享（≤10）」）。
- **效果**：附赠#5（audit §4 表 #5）消除；失败模式 E/F 消除；§5.2 Worker 回收场景成立。

### 6.6 D6：登记不动项（显式裁决，非遗漏）

**本章结论**：以下五处经裁定维持现状，各自有明确权威依据——「不动」是决策不是省略。

| 项 | file:line | 现值与到期行为 | 不动的依据 |
|---|---|---|---|
| hook handler 5s | hook-pipeline.ts:24（用 :95） | 5s 超时**放行**（warn，链路继续） | AGENTS.md 规则 16 明示先例：控制面单 handler 秒级 + 放行降级——放行语义天然「不误杀」（宁可漏拦不可拦死主链路） |
| plugin-rpc-client 默认 30s | plugin-rpc-client.ts:15（:40 可覆盖） | reject RPC_TIMEOUT | 机制正确（控制面默认 + opt-in 覆盖通道存在）；D2 正是**使用**该覆盖通道而非改默认——其余 Worker→Host 控制面请求（config/storage/session 读写）30s 合理 |
| LOAD_PLUGIN 10s（两版） | plugin-host.ts:108 / plugin-host-process.ts:26 | 10s（fork 版可覆盖，Worker 版 D5 补） | 控制面握手秒级合法；D5 修的是**超时后行为**（回收对称化），不是值 |
| DEACTIVATE 5s | plugin-activator.ts:43（用 :338） | resolve(false) 后**仍继续本地清理**（dispose + UNLOADED） | 到期行为已安全（不静默、有兜底清理）；控制面秒级 |
| hot-reload deactivate 5s | plugin-hot-reload.ts:45 | 超时 forceTerminate + UNLOADED | 仅 external 插件开发流程；已有强杀兜底；D5 只修 timer 句柄卫生 |

## 7. 实现机制（文件级改动地图）

**本章结论**：改动集中在 plugin-service 的 9 个文件 + 2 个跨层联动点，无新模块、无协议层改造。

| 文件 | 决策 | 改动 |
|---|---|---|
| `plugin-service/bridge-interop.ts` | D1 | `TOOL_EXECUTE_TIMEOUT_MS` → `DEFAULT_TOOL_EXECUTE_TIMEOUT_MS = 30_000_000`；invoke 前经 `resolveToolTimeoutMs(entry.schema.timeoutMs)`（新纯函数，对齐 dialog-queue `resolveDialogTimeoutMs`：合法正数优先 / `<=0` 或 `Infinity` = 不限时 / 非法回落默认 / clamp）；超时 catch 分支错误消息诚实化（§5.2 文案） |
| `plugin-service/plugin-types.ts` | D1 | `ToolRegistration` 加 `timeoutMs?: number`（JSDoc：声明 >0 为该工具上界；`<=0`/`Infinity` 显式不限时；非法值回落默认） |
| `plugin-service/tool-api.ts` | D1 | 注册入口窄校验（对齐 ui-api 的 INVALID_* 风格：非 number 抛 INVALID_TIMEOUT_MS） |
| `plugin-service/ui-request-queue.ts` | D2 | 删 60s 语义 timer 与 `defaultResult` 替答；改挂防泄漏兜底 timer = `effective + 60s`（入队起算，仅 cancel 丢失 / Worker 死亡时收尾清理 + warn）；requestId 尊重 Worker 侧来方值；新增 `cancelRequest(requestId)`（删 pending / 排队项 + expired 广播 + 活跃请求 `processNext` 放行）；注册 `plugin.ui.uiRequestExpired` notification handler（复用既有无 id dispatch 通路，plugin-rpc-server.ts:175-190） |
| `plugin-service/api/ui-api.ts` | D2 | `createUiApi` 五个方法加 `opts?: { timeout?: number }`；requestId 生成（uuid 随 params 传递）；`rpcClient.request` 第三参传 `resolveUiRequestTimeoutMs(opts?.timeout)`（**语义值本身，无余量**——传输计时即语义计时）；到期 catch 转译 `UI_TIMEOUT` reject 插件 + warn + notify cancel |
| `plugin-service/plugin-activator.ts` | D3/D4 | `PERMISSION_TIMEOUT_MS` → 30min；`waitForPermissionApproval` 到期 resolve `'timeout'`；`doActivatePlugin` 分流 `'timeout'`（warn + expired 通知 + UNLOADED）与 `false`（现状 UNLOADED）；`ActivatorOptions` 加 `activateTimeoutMs` |
| `plugin-service/plugin-service.ts` | D3 | activator 装配点接线：`permissionTimeoutMs: readEnvTimeoutMs('XYZ_PLUGIN_PERMISSION_TIMEOUT_MS') ?? DEFAULT`（env 读取 + 非法 warn 回落，对齐 lifecycle-manager :68 形态）；`onPermissionRequestExpired` 广播回调注入 |
| `plugin-service/api/commands-executor.ts` | D4 | 常量 10s → 复用 D1 默认常量；命令注册定义加可选 `timeoutMs`（取值链同 D1）；错误消息诚实化 |
| `plugin-service/plugin-host.ts` | D5 | `loadPlugin` 超时 reject 前调 `this.handleWorkerCrash(workerId, 'loadPlugin timeout...')`；`loadPlugin` 加 `loadTimeoutMs` 参数（对齐 fork 版） |
| `plugin-service/plugin-hot-reload.ts` | D5 | race timer 句柄提取 + 胜出 `clearTimeout` |
| **跨层联动**（登记，非本设计实施单元） | D2/D3 | `packages/shared` ServerMessageMap 加 `plugin:uiRequestExpired` / `plugin:permissionRequestExpired`（**类型定义随 U3/U5 同 commit 落地**，防断言漂移）；renderer 弹窗组件消费两条广播撤窗（消费侧另行排期，U8）；`docs/extensions/development-guide.md` 补超时契约（onActivate 轻量 / timeoutMs 声明 / opts.timeout / pi abort 不传播的已知限制） |

**错误规格表**（新边界与失败路径汇总）：

| 边界 | 行为 | 恢复指引载体 |
|---|---|---|
| 工具超时（默认或声明值到期） | isError 诚实消息（时长 / 声明or默认 / handler 仍在跑结果将丢弃） | 错误消息内嵌「registerTool 传 timeoutMs 调整」 |
| 工具迟到回包 | PendingTracker miss → 丢弃，debug 日志一条 | —（pi agent 已拿到 isError 并决策） |
| UI 弹窗超时（语义到期，Worker 侧裁决） | 插件收 `UI_TIMEOUT` reject + cancel 通知 → queue 删项 / 撤窗广播 / 活跃请求放行下一个 | warn 日志「传 opts.timeout 延长（全程含排队）/ 用户在场则弹窗会一直等」 |
| cancel 通知丢失 / Worker 死亡（queue 兜底到期） | 兜底 timer（effective+60s）清理：撤窗广播 + 放行 + warn（插件侧早已 reject，无幽灵 promise） | warn 日志标注兜底触发原因 |
| 审批超时 | resolve `'timeout'` → 取消激活 + expired 广播撤窗 | warn 日志「重触发激活事件 / env 调整」 |
| activate 超时 | 现状 UNLOADED 保持 + 消息提示 activateTimeoutMs | 错误消息内嵌 |
| Worker load 超时 | terminate + rebuild 链 + warn | 日志「loadTimeoutMs 可覆盖 / rebuild 已排期」 |
| 声明值非法（非正数非 Infinity 的脏值） | 注册入口 INVALID_TIMEOUT_MS 抛错（fail-fast）；运行中防御回落默认 | 注册错误消息含期望格式 |
| 命令执行中重复触发（30min 窗口放大 UX 面，v1.1 补，审查 S1） | 并发守卫拒绝 → busy 提示（含已等待时长与取消出路） | 提示文案；「命令进度反馈/可取消」登记 renderer 联动排期项（U8 模式） |

## 8. 探针清单

**本章结论**：设计期已实测 8 项（✅，全部经代码实读核实）；实施期门 5 项（⛔，各带降级路径）。

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-1 | UI 链路双层竞速：client 30s 先于 queue 60s 到期（§4.2 论断） | 读 `ui-api.ts:171-183`（五方法均不传第三参）+ `plugin-rpc-client.ts:15/:40`（默认参数） | ✅ 设计期 | — |
| P-2 | pi 侧 bridge 调用路径无超时无 abort（runtime 是工具链路唯一墙钟；pi 的 abort/timeout 是 opt-in 能力而非缺失） | 读 pi 实装 `rpc-mode.js`：`createDialogPromise`（:47-77）支持 `opts.signal` / `opts.timeout` 但仅用于 pi 自有 dialog 方法；bridge 的 `extension_ui_request` 走 `pendingExtensionRequests` 直接登记（:177），不传 opts → 该路径无超时无 abort | ✅ 设计期 | — |
| P-3 | Worker 版 loadPlugin 超时仅 reject 不 terminate | 读 `plugin-host.ts:387-389`（reject 后无 terminate / 无 crash 链调用） | ✅ 设计期 | — |
| P-4 | hot-reload race timer 无句柄不可清 | 读 `plugin-hot-reload.ts:125-128`（setTimeout 内联于 Promise 构造器，无引用） | ✅ 设计期 | — |
| P-5 | `invoke` timeoutMs 必传无默认（调用点是取值权威） | 读 `plugin-rpc-server.ts:142` 签名 | ✅ 设计期 | — |
| P-6 | `ToolRegistration` 现无超时字段；`permissionTimeoutMs` 生产未接线 | 读 `plugin-types.ts:324-330` + `plugin-service.ts:184-189` | ✅ 设计期 | — |
| P-7 | pi agent loop 内工具调用串行（一个工具挂死阻塞该 turn 后续） | pi 架构既有语义（bridge/index.ts execute await 单发请求） | ✅ 设计期 | — |
| P-8 | 30min 默认端到端生效：长工具 90s 真实返回非 isError | `pnpm dev` 全链实测（bridge 依赖 runtime WS，见 V1 环境勘误）：触发一个 sleep 90s 的测试插件工具 | ⛔ U1 完成后 | 失败 → 检查 bridge-handler reply 路径与 `bridge:sync` 轮询间隔对首调的干扰；仍不通则回落 30s→10min 分段验证定位卡点 |
| P-9 | 迟到回包 miss 不炸：工具超时后 handler 完成回包，runtime 无异常、debug 日志一条 | 同 P-8 环境：sleep 100s 工具 + 声明 timeoutMs 90s，观察 90s isError 后 100s 回包到达时行为 | ⛔ U1 完成后 | 失败 → deliverReply 加 miss 防御（当前实现可能直接 noop，若抛错则包 try-catch） |
| P-10 | Worker load 超时触发 rebuild 链：terminate 后同宿主其他插件经 cooldown 重载可用 | 单测 + 本地实测：顶层死循环插件与正常插件共宿主，观察正常插件 rebuild 后工具恢复 | ⛔ U7 完成后 | 失败 → rebuild 链已有 MAX_REBUILD_ATTEMPTS/计数衰减保护，检查 handleWorkerCrash 幂等守卫是否拦截 load 超时入口（status 非 active 时改直接 terminateWorker 兜底） |
| P-11 | expired 广播对旧版前端无害（未消费广播的 renderer 下撤窗缺位但无异常） | dev 环境跑 D2/D3 超时路径，观察 renderer 无报错、弹窗残留但不影响后续 | ⛔ U3/U5 完成后 | 失败 → 广播 payload 加 `optional: true` 语义（消费方缺失仅 debug）；renderer 联动项排期补 |
| P-12 | 30min/声明大值的 setTimeout 域安全（1.8M ms << 2^31-1，无需担心 Node 塌缩） | 值域计算 + clamp 函数单测（对齐 timer-delay.ts 惯例） | ⛔ U1 完成后 | 失败 → clamp 到 `MAX_TIMER_DELAY_MS`（dialog-queue 同款），声明 `Infinity` 在 invoke 侧转为「不注册 timer」 |
| P-13 | Worker→host notification 通路既有（D2 cancel 通知零新协议形态） | 读 `plugin-rpc-server.ts:175-190`（无 id 消息 dispatch）+ `plugin-rpc-client.ts:68`（`notify`） | ✅ 设计期 | — |

## 9. 验收（真实场景，非单测非 mock）

**本章结论**：改动规模=大（行为变更 + API 扩展，6 个决策），用 6 个真实场景验证，覆盖全部正向目标 + 2 个负面行为。

### 9.1 改动规模

大——默认值变更（4 处）、到期语义变更（2 处）、插件 API 扩展（`timeoutMs` / `opts.timeout` 两个新参数面）、跨层广播（2 条）。验收须真实 pi CLI + 真实插件 + 真实前端，单测仅作回归辅助。

### 9.2 验收场景

| 场景 | 回溯 §1/§2 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| V1 长工具不误杀 | 目标 1（❌3 根修）；§5.1 场景 1 | **环境（v1.1 勘误，审查 MF2）**：`pnpm dev` 全链（runtime + pi spawn + renderer）——bridge:sync/tool_execute 是 runtime WS 命令（bridge-handler.ts:28-37），纯 pi CLI 无 runtime 时工具无被调方（AGENTS.md 的 pi CLI 纪律针对 pi extension 本体，不适用 runtime 子系统 plugin-service）；备选：standalone 启动 runtime + 以 relay env 手动拉起 pi CLI。测试插件注册 `sleep-tool`（handler 真睡 90s，不声明 timeoutMs）；向 pi 发「调用 sleep-tool」 | pi agent 在 ~90s 收到非 isError 的真实结果；runtime 日志无 timeout；pi 侧无 30s 报错 |
| V2 声明通道生效 + 挂死兜底 | 目标 4/5；§5.2 场景 1 | 同环境两个工具：`a`（声明 `timeoutMs: 10_000`，handler 睡 60s）、`b`（声明 `timeoutMs: 0` 不限时，handler 睡 45s） | `a` 在 10s 收到 isError 且错误消息含「timed out after 10s (declared)」与调整指引；`b` 在 45s 正常返回（opt-out 尊重）；pi agent 对 `a` 的 isError 可继续对话 |
| V3 弹窗离席不替答 | 目标 2；§5.1 场景 2 | xyz-agent dev 环境装测试插件，触发 `ctx.ui.confirm`；人离开 5min（屏幕勿扰/切窗），回来点「确定」 | 插件收到 `true`；全程无 RPC_TIMEOUT / 无替答日志；串行队列无幽灵放行 |
| V4 弹窗超时取消语义（负面验证） | 目标 3；§5.2 场景 2 | 测试插件 `confirm(title, msg, { timeout: 60_000 })` 显式传 60s；不点击等待到期 | 60s 时插件 catch 到 `UI_TIMEOUT`（**不是** resolve false）；前端弹窗撤回（expired 广播消费）；runtime warn 含等待时长与恢复指引；队列中排队的下一个弹窗正常弹出（防死锁保留） |
| V4b 弹窗排队全程语义（负面验证，v2 新增） | 目标 3；§6.2 反例重演 | 两个弹窗：A 不传 timeout（默认全时长）、B 传 `{ timeout: 60_000 }` 在 A 发起后立刻发起（B 排队）；均不点击 | B 在发起后 ~60s（仍在排队、从未展示）即收 `UI_TIMEOUT` reject，且**无任何 RPC_TIMEOUT 先于语义到期**（v1 固定余量方案的击穿反例不复发）；A 不受 B 影响继续等待至自身到期；全程无幽灵替答 |
| V5 慢审批不 UNLOADED + 批准不被吞 | 目标 2/3；§5.1 场景 3 | dev 环境：带权限插件首次激活触发审批弹窗，等待 10min 后点「批准」 | 插件 ACTIVE；无 UNLOADED；权限存储记录批准；若等 30min+（可临时 env 调小加速验证）→ 插件 UNLOADED + 前端弹窗撤回 + warn，重触发 slash command 后重新弹审批且本次批准生效 |
| V6 Worker 回收 + 命令不误杀 | 目标 4/5；附赠#5；§5.2 场景 4 | ①死循环模块插件（顶层 `while(true)`）load 超时 → 观察 Worker 线程数/loadedModules 回收 + rebuild 日志；②同宿主正常插件 rebuild 后工具可用；③测试命令 handler 睡 45s（旧 10s 必杀），前端按钮触发 | ①10s 后线程被 terminate（`process` 观察 Worker 数回落）、warn 含 rebuild 排期；②正常插件冷却后恢复；③命令 45s 返回真实结果非 `-32000` |

> 说明：V3/V5 的「离席 5min/10min」可用 env（`XYZ_PLUGIN_PERMISSION_TIMEOUT_MS`）/ `opts.timeout` 传小值加速等价验证（同一代码路径），但**至少各跑一次全时长真实等待**确认无中途中断；实测环境用 dev app 全链（bridge 经 runtime WS 中转，见 V1 环境勘误——v1.1 勘误），`XYZ_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/`。

## 10. 下一层拆分（实现任务单元）

**本章结论**：7 个单元按依赖序交付，每个单元可独立验收（映射 §9 场景），U1-U2/U3/U5/U6/U7 相互独立可并行。

| 单元 | 内容（文件） | justification（为什么这么拆） | 验收映射 |
|---|---|---|---|
| U1 | 工具执行根修：bridge-interop.ts 常量 + resolveToolTimeoutMs + 错误消息诚实化 | P0 最高优先；纯 runtime 内改动零跨层；独立于其余单元 | V1/V2 |
| U2 | 声明通道：plugin-types.ts 字段 + tool-api.ts 校验 | 与 U1 是同决策的 API 面，但类型+校验可独立回归；U1 无 U2 也可跑（字段缺省回落默认） | V2 |
| U3 | UI 弹窗超时权威源重构：ui-api.ts（`opts.timeout` + requestId 生成 + effective 直传 + `UI_TIMEOUT` 转译 + cancel notify）+ ui-request-queue.ts（删语义 timer / 替答 → 防泄漏兜底 timer + `cancelRequest` + notification handler）+ shared ServerMessageMap `plugin:uiRequestExpired` 类型 | D2 v2 的单一计时权威横跨 Worker（ui-api）与 host（queue）两侧，**必须单 commit 同改**——拆开交付会产生「queue 已无语义 timer 但 ui-api 未接取消通知」的中间破碎态（比失败模式 B 更糟）；广播类型同 commit 落地防 `as ServerMessage` 断言漂移 | V3/V4/V4b |
| U5 | 权限审批：plugin-activator.ts 30min + timeout 结局 + plugin-service.ts 接线 env + shared ServerMessageMap `plugin:permissionRequestExpired` 类型 | D3 完整闭环（值+通道+语义）一个单元，避免半成品（值改了语义没改）；类型同 commit 防漂移 | V5 |
| U6 | 控制面裁定：activateTimeoutMs 参数 + commands-executor 30min + 命令声明 | D4 两文件小改合并单元；依赖 U1 的默认常量与取值函数 | V6③ |
| U7 | Worker 回收对称化：plugin-host.ts crash 链接入 + loadTimeoutMs + hot-reload timer 修 | D5 与超时值无关的行为修复，独立可测（P-10） | V6①② |
| U8 | 契约与消费收口：development-guide.md 超时契约节（onActivate 轻量 / timeoutMs 声明 / opts.timeout / pi abort 不传播已知限制）+ renderer 弹窗消费两条 expired 广播撤窗 | 类型已在 U3/U5 先行落地，U8 只做 renderer 消费侧与契约文档；撤窗消费缺位期间由 P-11 验证兜底（旧版前端无异常） | V4/V5 的撤窗断言 |

**迁移路径**：U1+U2（P0 交付，V1/V2 验收）→ U3（V3/V4/V4b）→ U5（V5）→ U6/U7（V6）→ U8 收口。每步独立可回滚（常量与参数面变更，无数据迁移）。

## 11. 待验证检查点

- ⛔ P-8：30min 默认下 pi bridge 首调的 `bridge:sync` 轮询间隔是否影响首工具可用性（轮询周期内工具清单未同步 → tool not found 假象）——实施时实测首次调用时延。
- ⛔ P-10：`handleWorkerCrash` 幂等守卫对 load 超时入口的 status 前置条件（load 期间 handle.status 值待实测——若非预期状态需走直接 terminate 兜底）。
- ✅已核实 → 登记推进：pi 侧 `_signal`（abort）不传播至 bridge 调用（bridge/index.ts:31-34 不传 opts；rpc-mode.js:47-77 opt-in 支持、:177 bridge 路径未用）——**30min 工具等待窗内无任何层可中断是既成事实**（非待验证）。本设计 out-of-scope 维持：缓解 = 插件作者声明 timeoutMs（U8 契约文档显式标注该已知限制）；根治 = signal/timeout 传播缺口独立登记推进（bridge extension 改动）。
- ⛔ D2 cancel 通知的幂等与竞态窗：`cancelRequest` 对已 settle 请求须 miss-safe（Map.delete miss → return，实现约束）；cancel notify 与 queue 兜底到期理论上可能接近同刻（clamp 上限边界），两路径清理须幂等可重入——实施时以单测覆盖。
- `XYZ_PLUGIN_PERMISSION_TIMEOUT_MS` env 是否需要进 `ENV_WHITELIST_PREFIXES`（runtime 进程自读 env 不涉入站白名单，预期不需要——实施时按 C-proc-09 出站契约核对）。

---

## 附录：变更历史

- v1.1（2026-09-04）：第一轮对抗式审查修复（2 MF/2 SG/2 INFO，审查人=主 agent 代行，报告见 .review.md）：
  - MF1（requestId 碰撞面）→ D2 第 2 条补全局唯一规则（workerId 前缀/UUID + queue 重复 id 防御）；U4 验收落地时加双插件并发断言。
  - MF2（验收环境可行性）→ V1/P-8/说明注三处环境勘误：bridge 是 runtime WS 子系统（bridge-handler.ts），纯 pi CLI 无被调方，改 dev app 全链或 standalone runtime + relay env pi CLI；AGENTS.md pi CLI 纪律适用性澄清。
  - S1（command 重复触发 UX）→ 错误规格表补 busy 行 + renderer 联动排期登记；S2（命名对齐）→ D2 补两通路命名规则。
  - INFO×2：D1 传播链攻击未击穿（syncFrom 存完整 entry，:71-75）记录在案；证据句直白化建议采纳为可选。
  - 联动同步：§6.2/§7 错误规格表/§8 P-8/§9 V1+说明/变更历史；变更历史本条。
- v1（2026-09-04）：初稿。依据 timeout-audit-2026-09.md Doc 3 范围（P0-3 + P1 全部 + 附赠#5）与 rt-svc-plugin 模块普查报告撰写；全部 file:line 经代码实读核实（普查报告行号漂移已修正：ui-request-queue confirm 默认值 :96→:97、processNext :63→:118）；设计期新发现报告未覆盖的隐藏层——UI 链路 client 30s 与 queue 60s 双层竞速（§4.2 / P-1）。
- v2（2026-09-04）：对抗式审查第 1 轮修复（2 MF / 5 SG 全修）。**MF#1**：D2 v1「queue 唯一裁决 + client 固定 60s 余量」被串行排队反例击穿（client timer 发起即挂含排队、queue timer dispatch 才挂不含——前置 30min 弹窗时传输层 ~30min+60s 先炸），重设计为「Worker 侧单一计时权威（传输计时即语义计时）+ cancel notification（复用既有无 id dispatch 通路）+ queue 防泄漏兜底（effective+60s，仅异常收尾）」，v1 方案连同击穿反例记入 D2 被否谱系；联动 §4.2 论断 / §4.4 总表 / §7 文件地图与错误规格表 / §9 新增 V4b 排队变体 / §10 U3+U4 合并。**MF#2**：D1 风险论证「pi agent 层仍可 abort turn」与实装不符（abort/timeout 是 opt-in，bridge 调用不传 opts）改写为正面承认 30min 不可中断 + 可接受性四点论证，§11 对应条目从「待验证」升级为「已核实事实 + 登记推进」。**SG**：bridge 代码片段按实装原文修正（含 Ready 守卫）；P-2 表述修正（opt-in 机制）；D3 补 30min ACTIVATING 窗口调度论证（并行激活 + 审批不占 Worker 槽）、重触发精确语义、dismiss 路径不存在（hide-close）与多插件并发审批单例覆盖限制登记；U3/U8 类型定义顺序矛盾消除（类型随 U3/U5 落地）；D1 传播措辞收紧（getSyncPayload 只塑形三字段，timeoutMs 不进 bridge:sync 负载）。新增 P-13 设计期探针（notification 通路既有）与 §11 cancel 幂等检查点。
