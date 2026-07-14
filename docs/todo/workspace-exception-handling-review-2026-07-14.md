# Workspace 异常处理审查待办 — 2026-07-14

> 来源：3 个 subagent 并行审查 + 主 agent 交叉验证。审查范围：runtime 后端（recent-workspaces-store / WriteBackCache / workspace-message-handler / index.ts 组合根）、renderer 前端（workspace store / useNewTaskDirSelect / useNewTaskFlow / DirSelectPopover / pending）、electron main + 持久化底层（privileged-handlers / atomicWrite / session-lifecycle 衔接）。
>
> 审查维度：异常处理合理性、鲁棒性、fail-fast vs fail-soft 策略、错误传播链完整性、用户反馈完整性。
>
> 总体判定：fail-soft 策略方向正确（recent-workspaces 是 UX 辅助数据，降级优先合理），但落地有几处把 fail-soft 误实现成 fail-crash / fail-silent。9 项发现，2 致命 + 2 严重 + 5 需改进。

## 前提澄清

项目里 "workspace" 有两个含义。异常处理的实质全在**「最近工作区」(recent-workspaces)**——一个极简的持久化使用记录系统（只有 record + list 两个操作），不是「workspace 切换/扫描」。该功能定位为 **UX 辅助数据**（非权威状态），设计策略是 **fail-soft（降级优先，不阻塞主流程）**。这个定位本身合理。

**问题不在策略方向，而在落地质量**：fail-soft 的前提是「降级 + 有信号」，当前几处变成了 fail-**silent**（P1-3 loadFromFile 零日志、P1-4 IPC 错误无 toast），以及一处把 fail-soft 误实现成了 **fail-crash**（P0-1 flush 抛错崩进程）。

---

## P0 · 立即修复（致命）

### [ ] W0 · WriteBackCache.flush 无异常隔离 → atomicWrite 失败 crash 整个 runtime

- **文件**：`packages/runtime/src/utils/json-store.ts:247-256`（flush 方法，无 try/catch）
- **被调于**：`json-store.ts:317-320`（scheduleFlush 的 setTimeout 回调）+ `recent-workspaces-store.ts:94-98`（startFlushTimer 的 setInterval 回调）
- **问题**：`flush()` 调 `this.backing.persistPartition()`（L254）无 try/catch，`dirty.clear()`（L255）紧随其后。persistPartition → `recent-workspaces-store.ts:137-142` persistToFile → `atomicWrite`（同步 writeFileSync + renameSync）。整条链无异常隔离。
- **致命路径**：atomicWrite 失败（盘满 / 权限 / 只读挂载 / NFS 断连）时，**同步异常从 setTimeout/setInterval 回调抛出 → Node.js 触发 `uncaughtException`**（不是 unhandledRejection——同步异常不走 rejection 通道）。
- **兜底缺失**：`index.ts:274` 只注册了 `unhandledRejection` handler，**没有 `process.on('uncaughtException')`**。Node 默认行为：打印堆栈 + 进程崩溃退出。
- **后果**：一个 KB 级配置文件写盘失败，会**整个 runtime 宕机、所有 session 中断**。触发路径是用户常规操作（选目录 / 发消息 → record → 500ms 后 flush）。一旦磁盘瞬时故障，整个后端崩溃。
- **影响面放大**：WriteBackCache 是泛型工具（替代 PluginStorage / SessionDataStore），此缺陷影响所有用 WriteBackCache 的子系统，不止 recent-workspaces。
- **方案（短期，必须）**：`flush` 内包 try/catch，失败 `console.error` + **保留 dirty 不清除**（`dirty.clear()` 移入 try 成功路径）+ `scheduleFlush(k)` 安排重试：

```ts
flush(k: K): void {
  const partition = this.partitions.get(k)
  if (!partition || partition.dirty.size === 0) return
  if (partition.flushTimer) { clearTimeout(partition.flushTimer); partition.flushTimer = null }
  try {
    this.backing.persistPartition(k, partition.data)
    partition.dirty.clear()
  } catch (e) {
    // 保留 dirty，下次 flush 重试；避免 timer 回调抛错导致 uncaughtException crash
    console.error(`[json-store] flush failed for partition "${k}", will retry:`,
      e instanceof Error ? e.message : e)
    this.scheduleFlush(k)
  }
}
```

- **方案（长期）**：`WriteBackBacking` 接口加 `onPersistError` 回调，让调用方决定错误策略（recent-workspaces 可降级重试，session-data 可能需要告警）。

### [ ] W1 · persistToFile Windows 路径推导 bug → 首次写即 crash

- **文件**：`packages/runtime/src/services/workspace/recent-workspaces-store.ts:138`
- **问题**：

```ts
const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'))
```

Windows 路径分隔符是 `\`。`getDataDir()`（`shared/src/paths.ts:32`）用 `join(homedir(), '.xyz-agent')`，Node 的 join 在 Windows 返回 `\` 分隔 → `lastIndexOf('/')` 返回 -1 → `substring(0, -1)` = 空串 → `existsSync('')` false → `mkdirSync('')` 抛 EINVAL → 叠加 W0 → **Windows 上首次写即 crash**。
- **对比**：同库 `json-store.ts:90` 的 JsonStore.write 用的是 `dirname(this.path)`，手写路径推导偏离了既有约定。
- **方案（短期，必须）**：改用 `dirname(this.filePath)`（import 自 `node:path`），与 JsonStore 一致。

```ts
import { dirname } from 'node:path'
// ...
private persistToFile(data: Map<string, RecentWorkspaceRecord>): void {
  const dir = dirname(this.filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const records = Array.from(data.values())
  atomicWrite(this.filePath, JSON.stringify(records, null, JSON_INDENT))
}
```

---

## P1 · 短期修复（严重）

### [ ] W2 · loadFromFile 完全静默（fail-silent 反模式）— 文件损坏零日志

- **文件**：`packages/runtime/src/services/workspace/recent-workspaces-store.ts:128-131`
- **问题**：

```ts
} catch {
  // INV-4：文件损坏 / ENOENT 返空
  return new Map()
}
```

文件损坏（JSON parse 失败）时返空且**零日志**。用户升级 app / 手动编辑配置 / 磁盘错误导致 `recent-workspaces.json` 被截断 → 下次打开「最近列表全没了」→ 用户困惑，运维查日志也查不到（根本没记）。这是 fail-**silent**（降级 + 无信号），不是 fail-soft。
- **对比**：同项目 `JsonStore.readFromDisk`（`json-store.ts:119-122`）已确立「parse 失败 `console.warn` 记录路径和原因」的约定，recent-workspaces 偏离了。
- **INV-4 约束**：只约束「不抛」，不约束「不记日志」，加 warn 不违反不变式。
- **方案（短期）**：catch 区分 ENOENT（正常首启，静默）与真正损坏（warn）。复用 `errors.ts` 的 `isEnoent`：

```ts
} catch (e) {
  if (isEnoent(e)) return new Map() // 首启无文件，正常态
  console.warn('[recent-workspaces] load failed, starting fresh:',
    e instanceof Error ? e.message : e)
  return new Map()
}
```

### [ ] W3 · openDirDialog 的 throw e 无人接收 — AC-5.6 契约违背

- **文件**：`packages/renderer/src/composables/new-task/useNewTaskDirSelect.ts:82`（throw）+ `packages/renderer/src/components/new-task/Landing.vue:157`（调用点）
- **问题**：`openDirDialog` catch 后 `transition('dir-popover')` + `throw e`，注释声称「调用方接 toast（AC-5.6）」。但实际调用点 `Landing.vue:157` 是模板内联 `@open-dir-dialog="flow.openDirDialog()"`——未 await、未 .catch，等价 `void flow.openDirDialog()`。
- **契约未实现**：`useNewTaskFlow.ts` 有 `toastError`（L53 import），但只用于 cwd 降级（L165），**IPC 错误 toast 从未实现**。AC-5.6 明确要求 IPC 招错时 toast，当前完全未达成。
- **后果**：IPC 招错时状态正确落回 dir-popover（transition 在 throw 前执行），但用户**看不到任何错误提示**，且 `throw e` 变成 unhandled promise rejection。
- **方案（短期）**：在 Landing.vue 加事件处理函数 catch + toast：

```ts
function onOpenDirDialog() {
  flow.openDirDialog().catch((e) => toastError(`无法打开目录选择器：${e?.message ?? e}`))
}
```

模板改为 `@open-dir-dialog="onOpenDirDialog"`。

### [x] W4 · pending.register 无 per-request 超时 — 结构性永挂风险

> 已修复（cw-2026-07-14-sidebar-p0-exception-handling / sidebar-exception-p1p2 topic）。`packages/renderer/src/api/pending.ts` 现有 `DEFAULT_TIMEOUT_MS=65_000` + setTimeout 超时机制，超时后 delete + reject（error.code='timeout'）。传 0 可禁用（向后兼容长操作）。一处改动同时根治 sidebar S1。

- **文件**：`packages/renderer/src/api/pending.ts`（register 无 setTimeout）
- **问题**：`pending.register` 返回的 Promise **无超时**。若 runtime 已连接但 handler 不回复（路由 bug / handler 抛异常未 reply / pi hang），Promise **永不 resolve/reject**。
- **针对 load() 的后果**：`workspaceStore.load()`（stores/workspace.ts:24）若永挂 → `initApp`（useSidebar.ts:452）永远卡在步骤 3 → `presetCwd` 永不执行 → appBootstrapped 永久 true 阻止重试。首屏不卡（Landing 已挂载，initApp 是 fire-and-forget），但「沿用目录」永久失效，用户每次启动都要手动选目录。load 的 try/catch 形同虚设（Promise 永挂时 catch 永不触发）。
- **触发概率**：低（listRecent handler 极简，几乎不可能永挂），但是结构性缺陷。与 sidebar 审查的 S1 是同一个根因（pending 无超时）。
- **方案（长期）**：`pending.register(id, timeoutMs)` 内挂 setTimeout，超时后 delete + reject。workspace 轻量 RPC 可设 5s，session.create 等重操作 30s。一处改动同时根治 sidebar S1。
- **方案（短期兜底）**：至少给 `workspaceStore.load()` 单独包 `Promise.race([workspace.listRecent(), timeout(5000)])`，保证 initApp 不被卡死。

---

## P2 · 需改进

### [x] W5 · cwd 降级后 homedir 污染最近工作区列表

> 已修复（cw-2026-07-14-fix-workspace-p2-robustness，commit afa14186）。`session-lifecycle.ts` create() 的 record 调用增加条件 `sessionCwd === requestedCwd`，降级到 homedir 时跳过 record。测试：session-lifecycle-w5.test.ts 4 用例。
>
> follow-up：用户显式选 homedir 作 cwd（existsSync=true）的退化情况仍会 record(homedir)，代码无法区分降级 vs 真选。属既有行为，彻底解决需 record 层加 homedir 过滤，超本 P2 范围。

- **文件**：`packages/runtime/src/services/session/session-lifecycle.ts:98-101`
- **问题**：用户选失效 cwd → create 内部 `existsSync` 降级 homedir（L47-50，D-008 设计）→ `record(sessionCwd)` 记入的是降级后的 homedir。homedir 不是真实工作区，会出现在「最近工作区」列表里。同时前端 `useNewTaskDirSelect.ts:57/78` 在选目录时已 record 了用户原始选的（失效）cwd，最终列表里既有失效 cwd 又有 homedir。
- **方案（短期）**：降级路径跳过 record（homedir 无记录价值）。或传用户原始 requestedCwd（至少反映用户真实意图，但失效路径也无用，不推荐）。推荐前者：降级是异常兜底，不应把兜底目标写入「最近工作区」。

### [x] W6 · message-dispatcher 的 record 调用阻断 isGenerating 复位

> 已修复（cw-2026-07-14-fix-workspace-p2-robustness，commit d646e8c7 + review 修正 513b806b）。`message-dispatcher.ts` sendPrompt 的 record 调用包 try/catch，失败仅 console.warn，isGenerating 保持 true，pi.prompt 照常执行。注释（review 修正）去掉「OOM」误导，改为防御性编码说明。测试：message-dispatcher-precheck.test.ts 新增 W6 用例。
>
> follow-up：`workspace-message-handler.ts:38` 的 record 调用未加同等保护——与 W6 场景不同（handler 的 record 是主操作，应让外层 transport 兜底 + pending 超时已兜底），不要求对称保护。

- **文件**：`packages/runtime/src/services/session/message-dispatcher.ts:100-102`
- **问题**：

```ts
activeSession.isGenerating = true        // L101 已置 true
this.workspaceService.record(...)        // L102 若抛同步异常
// client.prompt（L107）尚未调用，isGenerating 永不复位
```

record 内存操作（cache.set + scheduleFlush）抛错概率极低（OOM 级），但属于状态机不完整——session 会卡在「生成中」无法再发消息。record 本应是非用户阻塞的副作用，不应阻断发消息主流程（NFR 设计明确「不冒泡到 session 创建/发消息主流程」）。
- **方案（短期）**：record 调用包 try/catch，失败仅 `console.warn`；或后移到 `client.prompt` 成功之后。

### [x] W7 · pick-directory IPC 无 try/catch — 风格不一致

> 已修复（cw-2026-07-14-fix-workspace-p2-robustness，commit c1bc22a3）。`privileged-handlers.ts` pick-directory handler 的 dialog.showOpenDialog 包 try/catch，异常时 console.error + 返回 {canceled:true, path:null}，与无聚焦窗口降级 + open-external 风格对称。测试：privileged-handlers.test.ts 3 用例。

- **文件**：`apps/electron/main/gateway/privileged-handlers.ts:39-50`
- **问题**：同文件 open-external（L25-36）有 try/catch + 返回 false，pick-directory 没有。靠 Electron `ipcMain.handle` 的 invoke rejection 兜底链是完整的（renderer 的 openDirDialog catch 接住），不是 bug，但维护者易误判为「故意吞错」。
- **方案（短期）**：补 try/catch，异常时返回 `{canceled: true, path: null}`（与 getFocusedWindow null 的降级风格对称），而非依赖 renderer rejection 触发 W3 的 toast。

### [x] W8 · WS 重连 / 多窗口后 workspace records stale

> 已修复（cw-2026-07-14-fix-workspace-p2-robustness，commit a8dff8c3 + review 修正 513b806b）。`useSidebar.ts` 新增 `onConnected()` 方法 + 模块级 `hasConnectedBefore`，区分首次 vs 重连 connected：首次调 initApp（内部含 load），重连额外 fire-and-forget workspaceStore.load() 刷新 stale records。App.vue watch connectionState → onConnected()。测试：App-w8.test.ts（调用契约）+ app-bootstrap.test.ts（首次/重连逻辑，含「重连时 initApp 被守卫跳过」断言）。
>
> 已实现短期方案（重连刷新）。长期方案（broadcastRecentList + record 后广播）未做——recent-workspaces 是辅助展示，stale 不影响核心功能，单窗口重连刷新已够。多窗口 stale 场景（窗口 A 选目录，窗口 B 滞后）仍存在但极轻微。

- **文件**：renderer 侧 `workspaceStore.load()` 只在 `useSidebar.ts:452` initApp 调一次；`appBootstrapped` 守卫（L434-435）阻止重连后重跑 initApp。
- **问题**：
  - **重连场景**：WS 断连重连后（onRuntimeRestarting → reconnecting → connected），`workspaceStore.records` 是断连前的 stale 数据。runtime 侧可能重启后从磁盘重新加载了新记录（另一个窗口写入），前端完全不知道。
  - **多窗口场景**：`workspace.record` handler 用 `ctx.reply(ws, ...)` 只回复请求的 ws 连接（workspace-message-handler.ts:35/39-41），不 broadcast。对比 session 变更走 `broadcastSessionList()`。窗口 A 选新目录，窗口 B 列表滞后。
  - defaultCwd 可能指向已被 LRU 淘汰的 cwd（但选了失效 cwd 有 INV-7 toast 兜底，不致命）。
- **严重程度**：轻微。recent-workspaces 是辅助展示，stale 不影响核心功能。
- **方案（短期）**：重连成功时（useConnection 的 WS 状态 watch：`oldState !== 'connected' && newState === 'connected'` 且 `appBootstrapped`）fire-and-forget `void workspaceStore.load()`。
- **方案（长期）**：加 `broadcastRecentList()` helper，record 后广播 `workspace.recentList` 给所有连接，renderer store 订阅该 push 消息自动更新。与 session broadcast 对称。

---

## 合理（保持现状，无需改动）

| 项 | 理由 |
|---|---|
| `selectWorkspace` 的 `void record` fire-and-forget | store 内 catch 彻底吞掉，不可能 unhandled rejection |
| WS 断连 `pending.rejectAll` 三场景全覆盖 | runtime 重启 / runtime 失败 / 普通掉线都 reject |
| 空态 UI（DirSelectPopover） | 三要素齐全 + Primary 入口（打开文件夹）引导 |
| cwd 空串双层守卫（service + store INV-1） | 防御充分 |
| hidden session 不 record 条件（`!options?.hidden`） | 可靠，风险仅在调用方忘传 hidden |
| atomicWrite 原子性（write tmp + rename） | 崩溃后文件要么旧完整要么新完整，不损坏 |
| write-back 内存/磁盘不一致窗口（≤500ms） | UX 辅助数据可接受，不值得 write-through |
| `flushAll` best-effort（shutdown 失败 console.error 照退） | UX 数据不值得延迟退出 |
| 并发 flush 竞态 | 单线程 + dirty 检查 + clearTimeout，无竞态 |
| 路径注入安全 | JSON.stringify 转义 + loadFromFile 类型校验 |

---

## fail-fast 策略评价

文档没有使用「fail-fast / fail-soft」术语，但实际策略是**分层的 fail-soft**，整体方向正确：

- **读取侧**：文件损坏 / RPC 失败 → 降级空数组，不阻塞启动（合理）
- **写入侧**：cwd 空串静默跳过；record 不阻塞 session 创建 / 发消息（合理）
- **用户可见层**：仅「目录不存在」给 toast，其余静默（基本合理，但 W2 / W3 的静默过度）

唯一接近 fail-fast 的点是 pi create 失败时「不 record」（code-architecture.md E1-1），但这是「跳过副作用」而非「快速失败终止流程」。

## 修复优先级总结

| # | 问题 | 严重度 | 位置 | 状态 |
|---|---|---|---|---|
| **W0** | flush 无 catch → runtime crash | **致命** | json-store.ts:247-256 | ✅ 已修（ae75fb1f） |
| **W1** | persistToFile Windows 路径 bug | **致命** | recent-workspaces-store.ts:138 | ✅ 已修（4d4a21a3） |
| **W2** | loadFromFile 零日志（fail-silent） | 严重 | recent-workspaces-store.ts:128 | ✅ 已修（4d4a21a3，随 W1） |
| **W3** | openDirDialog throw 无人接（AC-5.6 违背） | 严重 | Landing.vue:157 | ✅ 已修（0a09b8ed） |
| **W4** | pending 无超时（结构性永挂） | 严重（低概率） | api/pending.ts | ✅ 已修（sidebar topic） |
| **W5** | homedir 污染列表 | 轻微 | session-lifecycle.ts:98-101 | ✅ 已修（afa14186） |
| **W6** | dispatcher record 阻断 isGenerating | 轻微 | message-dispatcher.ts:100-102 | ✅ 已修（d646e8c7） |
| **W7** | pick-directory IPC 风格不一致 | 轻微 | privileged-handlers.ts:39-50 | ✅ 已修（c1bc22a3） |
| **W8** | 重连 / 多窗口 stale | 轻微 | renderer load 调用 | ✅ 已修（a8dff8c3 + 513b806b） |

**9 项全部修复完成。** W0/W1 是真正必须修的（局部写盘失败放大为整个 runtime 崩溃 + Windows 首次使用即触发），已最先处理。W5-W8（P2 轻微项）经 cw-2026-07-14-fix-workspace-p2-robustness topic 完整走完 CW 流程（plan→dev→review→test→retrospect→closeout，8/8 testCase passed）。

W5 follow-up（homedir 降级漏洞：W5 只堵 create 入口，漏掉 sendPrompt/restoreSession/前端直选/列表自繁殖 4 条路径）经 cw-2026-07-14-fix-homedir-record-guard topic 用方案A彻底修复：WorkspaceService.record 加 homedir 守卫一处堵死全部路径 + loadFromFile 存量自愈。6/6 testCase passed。
