# Code Review — fix-workspace-p2-robustness

独立对抗性审查。4 个 commit（W5-W8），主 agent 自审通过，本审查专门找盲区。

## 审查范围
- `afa14186` W5: session-lifecycle create cwd 降级 homedir 跳过 record
- `d646e8c7` W6: message-dispatcher sendPrompt 的 workspace.record 包 try/catch
- `c1bc22a3` W7: privileged-handlers pick-directory 补 try/catch
- `a8dff8c3` W8: App.vue 重连成功时 fire-and-forget workspaceStore.load

审查方法：git show 4 commit + 读全文件上下文 + grep 同类调用点对照 + 实跑全部 4 个测试文件（均绿）+ 追下游消费者契约。

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 业务逻辑 | **W8 测试假绿（断言不足导致「未测但显绿」）**：用例 2「断连后重连」只断言 `load` 被调 1 次，**没有断言 `initApp` 仍为 1 次（即重连时 initApp 不再被调）**。注释（L92-93）自承「mock 不含守卫」于是放弃该断言——但 W8 代码（App.vue L56-65）在 `hasConnectedBefore=true` 分支根本不会调 `initApp`，所以这个断言本可加上且必通过。当前用例 2 验证不了「重连不再触发 initApp」这条核心不变式；如果未来有人误把 `initApp` 也挪进重连分支，测试仍绿。 | must_fix | packages/renderer/src/__tests__/App-w8.test.ts:78-94 |
| 业务逻辑 | **W8 hasConnectedBefore 是 per-instance，connectionState 是 module-level singleton——HMR/组件卸载重挂后状态不一致**。`hasConnectedBefore = ref(false)` 在 `<script setup>` 内（每个组件实例一份），但 `connectionState`（`getState()` 返回的 readonly ref，ws-client.ts:37 模块级）和 `appBootstrapped`（useSidebar.ts:109 模块级 `let`）是全局单例。HMR 重挂或组件被卸载重挂时：新组件实例 `hasConnectedBefore=false`，但 `appBootstrapped=true` 且 `connectionState` 可能已是 `'connected'`（watch 不触发，无状态变化）。后果：(a) watch 不触发 → 首次/重连都不调 load（静默不刷新）；(b) 即便触发（如 HMR 后 state 抖动回 connected），新实例 `hasConnectedBefore=false` → 调 `initApp()`，但 `initApp` 因 module-level `appBootstrapped=true` 直接 return → **load 不被调用**，重连刷新失效。原 watch（W8 前）本就不含 immediate、本就依赖「mount 后 state 才从 connecting 变 connected」的时序，W8 没引入新回归，但 W8 新增的重连刷新能力在该场景下不生效。建议要么把 `hasConnectedBefore` 也提到模块级（对齐 `appBootstrapped` 生命周期），要么 watch 加 `{ immediate: true }` + 合并首次判定。 | should_fix | packages/renderer/src/App.vue:55-65（hasConnectedBefore per-instance vs module-level state/guard 的生命周期错配） |
| 业务逻辑 | **W5 判定 `sessionCwd === requestedCwd` 不能识别「requestedCwd 本身就是 homedir 且存在」的退化情况**。当用户显式选 homedir 作工作区（existsSync=true → sessionCwd === requestedCwd === homedir），W5 仍会 `record(homedir)`，homedir 进「最近工作区」列表——这与 W5 的修复意图（"homedir 不应出现在列表"）矛盾。对照 renderer 侧 `selectWorkspace(homedir)` / `openDirDialog` 选中 homedir 也会经 `workspaceStore.record(homedir)`，runtime `WorkspaceService.record` 只过滤空串（无 homedir 过滤），所以 homedir 入列表是既有事实。W5 注释把 homedir 定性为「兜底目标，不是用户真实选择」，但代码无法区分「降级到 homedir」与「用户真选 homedir」。实际命中概率低（用户极少选 homedir 作项目根），且 W5 commit message 只承诺修「降级」场景，故标 should_fix 而非 must_fix。 | should_fix | packages/runtime/src/services/session/session-lifecycle.ts:111 |
| 业务逻辑 | **W6 注释描述的 throw 路径与实际实现不符，try/catch 的实际防护价值被高估**。注释（message-dispatcher.ts:102-104）称「cache.set + scheduleFlush 抛错概率极低（OOM 级）」，但读 `WriteBackCache.set`（json-store.ts:206-221）：`getPartition`→`loadPartition`（recent-workspaces-store.ts:119 loadFromFile 内部 try/catch 吞错返空）、`onSet` 回调（RecentWorkspacesStore 未传 onSet，见 recent-workspaces-store.ts:42-48 构造）、`partition.data.set`/`scheduleFlush`（仅 setTimeout，不抛）——**record() 同步路径几乎不会抛**。commit message 的「session 卡在 isGenerating=true 永不复位」对应的是一条几乎不可能触发的路径。try/catch 本身无害（防御性编码），但：(a) 注释把防护目标说成「OOM」是误导后续维护者；(b) 这意味着 W6 是「为低概率事件加保护」而非「修真实 bug」，与 commit message 的紧迫性（"cache.set OOM 级异常会让 session 卡死"）不匹配。不阻断合并，建议修正注释或补充真实可抛路径的说明。 | should_fix | packages/runtime/src/services/session/message-dispatcher.ts:102-104（注释） |
| 测试覆盖 | **W6 测试是「真绿」但 mock 绕过了真实 throw 路径**：测试用 `record: vi.fn(() => { throw new Error('cache boom') })` 直接让 WorkspaceService.record 抛错，绕过了真实 `cache.set` 路径。这只能证明「MessageDispatcher 对 record 同步异常做了 try/catch」，不能证明真实 `WorkspaceService.record`→`store.record`→`cache.set` 链路会抛（事实上如上一条所述它几乎不抛）。测试本身设计合理（验证 dispatcher 的 try/catch 行为），但要明确它没覆盖到真实抛错路径。非问题，仅标注以免误读为「已验证真实 OOM 场景」。 | nit | packages/runtime/test/message-dispatcher-precheck.test.ts:123 |
| 测试覆盖 | **W6 缺一条「record 抛异步异常」的用例**：`WorkspaceService.record` 当前是同步的（workspace-service.ts:21），所以同步 throw 测试够了。但 W6 注释/commit message 多次强调「OOM」，而 OOM 在 JS 里通常表现为同步 RangeError，已被覆盖。若未来 record 改异步（如 store 层引入 async flush on set），当前 try/catch 会失效（catch 不到 Promise reject）。属前瞻性 nit。 | nit | packages/runtime/test/message-dispatcher-precheck.test.ts（缺异步 throw 用例） |
| 业务逻辑 | **W6 try/catch 范围正确，但 isGenerating=true 后 record 失败的语义需要明确**：review 确认 record 失败 → warn → isGenerating 保持 true → `client.prompt` 照常调。若 prompt 成功，isGenerating 由后续 agent_end/turn_end 正常复位（路径正确）。若 prompt 失败，message-dispatcher.ts:119 已有 `activeSession.isGenerating = false` 复位（路径正确）。**结论：W6 的状态机处理正确，无卡死风险**。这条是「审查通过」的确认，非问题。 | （通过） | packages/runtime/src/services/session/message-dispatcher.ts:105-124 |
| 代码规范 | **同类调用点未对齐保护**：`workspaceService.record` 共 4 处调用（grep 结果）：session-lifecycle.ts:112（W5 改了条件但未加 try/catch）、message-dispatcher.ts:106（W6 加了 try/catch）、workspace-message-handler.ts:38（**未保护**）、workspace-service.ts:23（内部，不抛）。其中 workspace-message-handler.ts:38 的 record 调用在 IPC handler 内，若 record 同步抛错会冒泡到 `handleWorkspaceMessage` → transport 层外层 handler，可能导致该 IPC 的 `reply` 不执行（前端 pending 永挂）。W6 只保护了 message-dispatcher 一处，遗漏了 workspace-message-handler。考虑到 record 实际几乎不抛（见上），标 should_fix 而非 must_fix，但若 W6 的防护理由成立（OOM 卡死），这里同样需要保护才一致。 | should_fix | packages/runtime/src/transport/workspace-message-handler.ts:38（对照 message-dispatcher.ts:105） |
| 类型安全 | **W5/W6/W7/W8 测试的 `as unknown as` 强转合理**：均为「构造最小 mock 满足接口」的标准手法（vi.mock + interface 类型窄化），非滥用。W5 test:53 `session = { id, cwd } as IManagedSessionView`、W6 test:123 `workspace = { record: vi.fn(...) } as unknown as WorkspaceService`、W7 test:41 `registerPrivilegedHandlers({} as never)`——均符合项目既有测试风格（对照 message-dispatcher-precheck.test.ts:46-57 旧用例同模式）。无问题。 | （通过） | 各测试文件 |
| 边界条件 | **W7 测试 handler 调用签名与真实 ipcMain.handle 不完全一致**：测试 `await pickDir({}, {})` 传了空对象作 event 和 options。真实 ipcMain.handle 的 handler 签名是 `(event, options?)`，options 可选。测试传 `{}` 作 options，handler 内 `options?.title ?? '选择项目目录'` 走默认值，行为正确。但测试没覆盖「options 传入 title」的分支（title 透传到 dialog.title），3 个用例都没断言 title 透传。属覆盖不全 nit，不影响 W7 修复正确性。 | nit | apps/electron/main/test/privileged-handlers.test.ts:46-48（缺 title 透传断言） |
| 业务逻辑 | **W7 返回值降级与 renderer 消费契约一致（审查通过）**：renderer `pickDirectory()` 返回类型 `Promise<{canceled:boolean; path:string|null}>`（ipc.ts:58），消费者 `useNewTaskDirSelect.openDirDialog`（L70-74）用 `result.canceled || !result.path` 判取消。W7 的 `{canceled:true, path:null}` 与「无聚焦窗口」降级（L43）、用户取消（L50）三者返回值完全一致，renderer 三个分支统一走「取消落回 dir-popover」。**契约一致，无破坏**。 | （通过） | apps/electron/main/gateway/privileged-handlers.ts:43,50,55 vs packages/renderer/src/lib/ipc.ts:58 |

## plan 覆盖核对

逐 commit 对照 changes 落地情况：

### W5 (afa14186)
- [x] create() record 调用增加 `sessionCwd === requestedCwd` 条件：落地（session-lifecycle.ts:111 `if (!options?.hidden && sessionCwd === requestedCwd)`）
- [x] 降级到 homedir 时跳过 record：落地（existsSync=false → sessionCwd=homedir ≠ requestedCwd → 条件 false → 跳过）
- [x] 测试 4 用例：落地（未降级 record / 降级跳过 / cwd 仍 homedir / hidden 跳过回归），全部实跑通过
- [ ] **未覆盖**：requestedCwd 本身是 homedir 且存在的退化情况（见上表 should_fix）

### W6 (d646e8c7)
- [x] record 调用包 try/catch：落地（message-dispatcher.ts:105-110）
- [x] 失败 console.warn 不阻断 pi.prompt：落地（catch 内仅 warn，无 throw/return）
- [x] 测试 W6 用例：落地（record 抛错→catch+warn+prompt 仍调+isGenerating 保持 true），实跑通过
- [ ] **遗漏**：workspace-message-handler.ts:38 同类 record 调用未加同等保护（见上表 should_fix）
- [ ] 注释把防护目标说成「cache.set OOM」与实际不抛的 cache.set 路径不符（见上表 should_fix）

### W7 (c1bc22a3)
- [x] dialog.showOpenDialog 包 try/catch：落地（privileged-handlers.ts:44-56）
- [x] 异常返回 {canceled:true, path:null}：落地（catch 块 L53-55）
- [x] console.error 诊断信号：落地（L54）
- [x] 风格对齐 open-external：确认（对照 L28-36 open-external 同 try/catch+console.error+降级模式）
- [x] 测试 3 用例：落地（正常选中 / dialog 崩溃降级 / 用户取消），实跑通过
- [x] 与无聚焦窗口降级对称：确认（L43 vs L55 返回值一致）
- [x] renderer 消费契约一致：确认（见上表「通过」行）

### W8 (a8dff8c3)
- [x] 引入 hasConnectedBefore ref 区分首次 vs 重连：落地（App.vue:55）
- [x] 首次 connected 调 initApp：落地（App.vue:58-61）
- [x] 重连 connected 额外调 workspaceStore.load()：落地（App.vue:64）
- [x] 非 connected 不触发：落地（App.vue:57 提前 return）
- [x] import useWorkspaceStore：落地（App.vue:42）
- [x] 测试 3 用例：落地，实跑通过
- [ ] **测试断言不足**：用例 2 未断言「重连时 initApp 不再被调」（见上表 must_fix）
- [ ] hasConnectedBefore 生命周期与 module-level state 错配，HMR/重挂场景刷新失效（见上表 should_fix）

## 结论
- **must_fix 数量: 1**
- should_fix 数量: 4
- nit 数量: 3

**结论: 需修复（不阻断功能正确性，但有 1 处测试假绿风险 + 4 处质量/一致性问题）**

总体评价：4 个修复的业务逻辑核心路径**全部正确**（W5 降级判定、W6 状态机、W7 契约一致性、W8 首次/重连分流均经追踪验证无误），测试全部实跑通过。主要问题集中在：
1. **W8 测试断言缺口（must_fix）**：核心不变式「重连不再调 initApp」未被断言，未来回归不会被测试捕获。修复成本极低（加一行 `expect(mocks.initApp).toHaveBeenCalledTimes(1)`），应修。
2. **一致性遗漏（should_fix）**：W6 只保护了 4 处 record 调用中的 1 处，workspace-message-handler.ts:38 漏网；W8 的 per-instance flag 与 module-level state 生命周期错配。
3. **注释/描述准确性（should_fix）**：W6 的「OOM」描述与实际不抛的 cache.set 路径不符，会误导维护者。

无阻断性 bug，无契约违背（W7 已确认与 renderer 消费端一致），无类型安全滥用。建议修 must_fix（W8 测试加一行断言）后通过，should_fix 作为 follow-up。

---

## Review 后修复处理（主 agent 回复）

### 已在本 topic 修复（commit 于 review 后）

1. **must_fix（W8 测试断言）— 已修**：onConnected 逻辑从 App.vue 提到 useSidebar（测试移至 app-bootstrap.test.ts，不 mock useSidebar 跑真实实现），新增断言「重连时 sessionCtrl.list 仍 1 次（initApp 被守卫跳过）」+「重连后 load 共 2 次（首次+刷新）」。
2. **should_fix #1（W8 hasConnectedBefore 模块级）— 已修**：hasConnectedBefore 从 App.vue per-instance ref 改为 useSidebar 模块级 `let`（与 appBootstrapped 同生命周期）。onConnected 方法封装首次/重连判断，App.vue 只负责 watch → onConnected 调用。
3. **should_fix #3（W6 注释措辞）— 已修**：去掉「OOM」误导描述，改为「当前几乎不抛，作为防御：未来 store 实现变更或 lazy partition 加载异常都不该让 session 卡死」。

### 留作 follow-up（不在本 topic 改，含理由）

4. **should_fix #2（workspace-message-handler.ts:38 record 保护）— 不改**：与 W6 场景不同。message-dispatcher 的 record 是「发消息的副作用」，阻断它会破坏 isGenerating 状态机（W6 修复理由）；workspace-message-handler 的 record 是「用户选目录的主操作」，若抛错应让外层 transport handler 兜底（reply 不执行时 pending 现有 65s 超时兜底，W4 已修）。两处错误策略属不同设计域，对称保护不成立。
5. **should_fix #4（W5 homedir 退化）— 不改**：用户显式选 homedir 作 cwd（existsSync=true）时 W5 会 record(homedir)，与「homedir 不入列表」的注释意图有张力。但这是**既有行为**（W5 前 record 也记录），W5 范围明确为「降级场景」。代码无法区分「降级到 homedir」与「用户真选 homedir」，要彻底解决需在 record 层加 homedir 过滤——影响面超出本 P2 topic，留作独立决策。
6. **nit（W6 异步 throw / W7 title 透传）— 不改**：前瞻性与覆盖细节，非本次范围。
