# 迁移计划审查（Round 1）

## 摘要

- 审查阶段数：6（phase 0–5）
- 发现遗漏/问题总数：27
- 按严重度：🔴严重 9 | 🟡中 13 | 🟢低 5
- 审查方法：逐阶段对照 spec（D1–D9 + G1–G7 + 第四部分 R/M/T）与 plan 子文档，对存疑点用 grep + read 核对实际代码（main / runtime / renderer / shared）。

> 范围：只审查完整性/遗漏，不评价方案好坏。所有发现附证据（文件:行 或 spec 段落）。

---

## 逐阶段审查

### Phase 0（文档与认知）

| 维度 | 发现 | 严重度 | 说明 / 证据 |
|------|------|--------|-------------|
| 决策覆盖 | D1 八步启动时序与实际代码顺序相反，phase 0 会固化错误契约 | 🔴 | design.md D1 时序写「step 2 spawn → step 3 createWindow」（spawn 先），但 `main/main.ts:142` `createWindow` **先于** `:154` `runtimeManager.start()`。phase 0 task 1 照抄 design.md 八步写入 CLAUDE.md，会把一个代码违反的契约写进规范。tracing-round-1 已标⚠️，但 phase 0 既未安排「改文档匹配代码」也未安排「改代码匹配文档」 |
| 决策覆盖 | M1（main.ts spawn 去重）代码改动无任何阶段承接 | 🔴 | design.md M1 + table 4.4 标「建议阶段 0」，但 phase 0 明确「0 代码改动」。`main.ts:142-156`（whenReady）与 `:177-188`（activate）的 `createWindow + runtimeManager.start() + webContents.send('runtime-port')` 三行重复，design.md 建议抽成 `runtimeManager.startAndNotify(win)`。该代码去重无任何 code phase 认领 |
| 决策覆盖 | M3（window-manager 不存完整 tree）代码改动无任何阶段承接 | 🔴 | design.md M3 + table 4.4 标「建议阶段 3」，建议 Main 只存 `sessionIds: Set`。但 phase 3 全部内容是 Runtime session-service 拆分，零 Main 改动。`main/window-manager.ts:89` `findPaneBySessionId(state.panelTree, ...)` + `:100-105` 递归遍历完整 PanelTree。M3 代码改动掉缝（table 4.4 与 phase 3 实际内容不符） |
| 改动完整性 | task 2「设计基线 commit」未列 `terminology.md` | 🟢 | phase 4 引用此文件作为 R1–R5 来源，phase 0 task 2 的 commit 清单未含它。若该文件未 commit，phase 4 无依据 |
| 验证完整性 | 验证「能说清 8 步时序」无法捕获时序与代码相反的问题 | 🟡 | 验证标准只查文档自洽，不查文档与代码一致。phase 5 的启动时序集成测试会基于错误契约编写 |

### Phase 1（前端 API Client）

| 维度 | 发现 | 严重度 | 说明 / 证据 |
|------|------|--------|-------------|
| 改动完整性 | send() 直调**不止 7 个 composable**，4 个非 composable 文件被漏 | 🔴 | `stores/plugin.ts:3,118-177`（8 处：plugin.list/uninstall/config.get/set/approvePermissions/revokePermissions…）；`components/settings/ExtensionsPane.vue:5,94-182`（8 处 extension.* ）；`components/panel/PanelSessionView.vue:49,108-138`（4 处：session.setThinkingLevel/message.steer/message.follow_up/动态路由）；`components/chat/SkillDrawer.vue:28,85`（1 处 file.read，且**已用 `id: requestId`**）。共 ~21 处 send 直调不在迁移范围。其中 `stores/plugin.ts` 是 store 直接 send，正是 API Client 层要消灭的反模式 |
| 验证完整性 | 验证 `rg "from '../lib/ws-client'" renderer/src/composables/` 只扫 composables/ | 🔴 | 上述 4 个文件（1 store + 3 组件）不在 composables/ 下，该 rg 验证会**通过**而它们仍绕过 API Client。验证有盲区 |
| 改动完整性 | useChat 事件订阅模型与 G6 refCount 设计不匹配 | 🔴 | useChat 用模块级 `createGlobalHandlers()` + `queueMicrotask(safeRegisterGlobalListeners)` 全局单例注册（`useChat.ts:340-368`、`:375/:467`），订阅 **23 个事件类型**（实测），非每组件 `on`。phase 1 task 7 只提 `text_delta/complete/error` 3 个 + G6 refCount 多实例去重。现有全局单例模式与 G6「组件多实例 refCount」是两套机制，plan 未说明如何 reconcile，也未列出实际 23 个事件类型 |
| 改动完整性 | mock 迁移被严重低估（273 行重写非搬迁）+ VITE_MOCK 检查点漏一处 | 🔴 | `mock/mock-ws.ts`（273 行）直接 `import { emit } from '../lib/event-bus'`（:3）+ 直接操作 `useProviderStore`/`useChatStore`（:7-8）。plan task 8「mock 实现同一 api 接口，返回预制 Promise」是**重写**（mock 当前在传输层拦截 connect/send + 推 event-bus + 改 store，非 api 语义）。VITE_MOCK 检查点在 3 处：`ws-client.ts:24/100/117` + `useConnection.ts:45/53`（connect 路径分支），plan task 8 只提 ws-client.ts，漏 useConnection.ts |
| 改动完整性 | useTree 消息数严重低估（plan 说 3，实际 8） | 🟡 | `useTree.ts` 实测 send：session.history/list/switch **+ session.tree-capability/tree-clone/tree-data/tree-fork/tree-navigate**（5 个 tree.* 全漏）。plan「3 个命令」少算 5 个 |
| 改动完整性 | useModel 漏 session.setThinkingLevel（plan 说 2，实际 3） | 🟡 | `useModel.ts` 实测 send：model.list/model.switch **+ session.setThinkingLevel**。且 session.setThinkingLevel 也在 `PanelSessionView.vue:108` 直调 |
| 改动完整性 | useExtensionUI 的 plugin.uiResponse 被误标为 extension 相关 | 🟢 | plan 说「2 个 extension 相关」，实际是 `extension.ui_response` + `plugin.uiResponse`（`useExtensionUI.ts:71/77`）。迁移同时碰 extension 与 plugin 两个 domain |
| 改动完整性 | useSession 的 session.switch 实际在 useTree | 🟢 | plan「useSession 7 个命令含 switch」，但 `useSession.ts` 实测无 session.switch send（在 useTree）。总数对得上但归属错 |
| 改动完整性 | Runtime 侧 id 回填**已实现**，task 4 描述误导 | 🟡 | 5 个 handler 共 85 处 `msg.id` 回填（session-handler 15、tree 14、extension 28、plugin 13、settings 15），`pong`/`file.read:result`/`sendError` 均已回填（`server.ts:187/321/334/340/256`）。task 4「Runtime 侧回填 id（向后兼容）」是已完成工作，应标注「仅需前端 pending.ts 发 id，runtime 侧已就绪」 |
| 边界情况 | G5「不续传」与现有 ws messageQueue flush 冲突 + 层级违规 | 🟡 | `ws-client.ts:47-50` `onopen` 重连时 flush `messageQueue`（缓存的 send 重发）。G5 决策「重连不续传中断的 streaming」与该 flush 直接冲突——缓存的 `message.send` 会被重发给重启后的 runtime。plan 未提「重连时清空 session-scoped 队列」。另：plan 把 markSessionError 调用放在 useConnection，但 useConnection 是 effects 层（design.md R2 规定 effects 不碰 store），层级违规 |
| 边界情况 | command() Promise 与 messageQueue 交互未定义 | 🟢 | command 返回 Promise + 30s 超时（G4），但 ws 断连期 send 走 `enqueueMessage`（ws-client.ts:130）。command 是否入队？入队期间超时怎么算？迟到响应丢弃规则（pending 无 id）与队列重发如何互斥？plan 未提 |
| 验证完整性 | 验证未覆盖 stores/plugin.ts 与 3 组件的 send 清零 | 🔴 | 见上「验证盲区」。应扫全 `renderer/src/` 而非仅 composables/ |

### Phase 2（Runtime 目录分层）

| 维度 | 发现 | 严重度 | 说明 / 证据 |
|------|------|--------|-------------|
| 改动完整性 | extension-service.ts / extension-timeout-manager.ts 分类错误 | 🔴 | plan 表格「services/（已存在，保持）」列此两文件，但它们实际在 `runtime/src/` **根目录**（非 services/）。需 `git mv` 进 services/，plan 标「保持」= 不动作 → 漏迁。引用方：`index.ts:12`、`server.ts:13`、`extension-message-handler.ts:8-9` |
| 改动完整性 | services/ 现有文件 git-info.ts / session-history.ts 未入盘点表 | 🟡 | 两文件已在 services/（位置正确），但 plan 表格未列，影响完整性核对。被 `session-service.ts:30-31` import |
| 改动完整性 | tsup entry 描述错误（bundle 模式非多 entry） | 🔴 | `runtime/tsup.config.ts` 用 `bundle: true` + 仅 2 个 entry（`index: 'src/index.ts'` + `'plugin-bootstrap': 'src/services/plugin-service/plugin-bootstrap.ts'`）。server.ts 等是被 bundle 进 index.cjs，**非独立 entry**。phase 2 task 4「entry 数组更新新路径（含 transport/server.ts 等）」是错误指导——server.ts 不是 entry，加它无意义。entry 实际只需保持 src/index.ts + plugin-bootstrap.ts（后者在 plugin-service/ 切片内，不迁移） |
| 改动完整性 | utils/path-utils.ts、plugins/demo/ 未提及 | 🟢 | 盘点遗漏（前者被引用，后者是 demo 插件）。不需动作但应标注 |
| 改动完整性 | SidecarServer 注释残留归属不清（handler 头注释 + shared 注释） | 🟡 | 17 处 sidecar 引用：5 个 handler 文件头注释「Extracted from SidecarServer」、`shared/protocol.ts:1,166`「Client → Sidecar」/「Sidecar → Client」、`process-manager.ts:21`、`plugin-types.ts:7`、`stores/plugin.ts:16`、`tsup.config.ts:35`。phase 2 task 3 只改 server.ts 注释，phase 4 R1「扫残留」无清单。两边都没明确承接 handler 头注释与 shared 注释（D7 原则「挪名须正注释」未贯穿） |
| 改动完整性 | handler→service 跨层 import 联动未具体列出 | 🟢 | `extension-message-handler.ts:8-9` 同时 import extension-timeout-manager + extension-service（根→services/）；`server.ts:13/20` import extension-timeout-manager + pi-config-bridge（→跨 transport/services/adapters）。task 2 泛泛提「修正 import」，未列具体联动文件 |
| 验证完整性 | electron-builder files/asarUnpack 确实不受影响（已核对） | — | `electron-builder.yml:9` `dist/runtime/**/*` 在 files，`:43` asarUnpack 同路径，排除项 `!dist/builder-output/**/*`（:33）不碰 runtime。plan 判断正确，无遗漏 |

### Phase 3（拆 session-service）

| 维度 | 发现 | 严重度 | 说明 / 证据 |
|------|------|--------|-------------|
| 改动完整性 | 方法归属表未覆盖全部 ~20 个 public 方法 | 🔴 | `getSummary`（:560）、`rebindAfterFork`（:541）、`destroyAll`（:567）三个 public 方法 plan 无归属。ISessionService 接口共 ~20 方法（`interfaces.ts`），plan「归属」表只覆盖 ~12 个 |
| 改动完整性 | 私有 helper 跨三类模块，共享模型未定义 | 🔴 | `initializeManagedSession`（:646，被 create/restoreSession/rebindAfterFork 用）、`detachSession`（:718，被 delete/destroyAll/rebindAfterFork 用）、`toSummary`（:605，全模块用）、`findScannedSession`（:621，rename/delete/rebindAfterFork/ensureActive 用）、`findSessionByClient`（:303，sendMessage/sendSubagent 用）、`getSkillPaths`（:579）/`getExtensionPaths`（:591，create/restoreSession 用）。这些 helper 横跨 plan 拟分的 lifecycle/dispatcher/scanner，plan 未说明它们归谁、如何被跨模块复用 |
| 改动完整性 | 共享状态（sessions Map + 5 个 constructor deps）拆分模型未定义 | 🔴 | `sessions: Map`（:56）被 lifecycle（create/delete）、dispatcher（sendMessage 经 findSessionByClient→sessions）、switchModel、scanner（listAll 经 sessions.values()）共用。constructor deps：`pm`/`broker`/`adapterFactory`/`treeService`/`extensionService`（:61-68）也跨模块。拆 3 模块后状态怎么传（构造注入？Facade 持有并传 this？）plan 风险表只泛泛提「this 绑定」，未给模型 |
| 边界情况 | pm.onSessionExit 回调（:78）跨模块归属未定 | 🟡 | 构造函数注册的 exit 回调横跨 lifecycle（`sessions.delete` :83）+ tree（`treeService.unregisterSession` :84）+ scanner（`listPersistedSessions` :85）+ broker.broadcast（:85-86）。拆分后该回调逻辑归哪个模块、如何访问他模块状态，plan 未提 |
| 边界情况 | switchModel 留 Facade 的切分依据不明确 | 🟢 | switchModel（:328）访问 `sessions` Map + `pm.getClient`，与 dispatcher 的 sendMessage 共用同一批状态。plan 把 switchModel 留 Facade、sendMessage 进 dispatcher，但两者依赖同构，切分理由薄弱（非错误） |
| 验证完整性 | 验证「ISessionService 接口未变」无法捕获私有 helper 共享破坏 | 🟡 | 接口不变只保证外部调用方零改动，但 helper 共享模型缺失会导致内部编译失败或运行期 this 丢失。验证依赖「TS 编译即暴露」，但 this 绑定问题编译期不一定暴露 |

### Phase 4（命名对齐）

| 维度 | 发现 | 严重度 | 说明 / 证据 |
|------|------|--------|-------------|
| 改动完整性 | R1 残留扫描范围不明（17 处 sidecar 散落） | 🟡 | 见 phase 2「注释残留」。R1「已大部分完成，扫残留」无具体清单，handler 头注释（5 文件）+ shared/protocol.ts 注释（2 处）+ process-manager/plugin-types/stores/plugin/tsup 注释均未明确归属 phase 4 |
| 决策覆盖 | R1 与 phase 2 的 SidecarServer 注释归属重叠 | 🟢 | server.ts「pure Transport」注释 phase 2 改，handler「Extracted from SidecarServer」两头不靠 |

### Phase 5（防护加固）

| 维度 | 发现 | 严重度 | 说明 / 证据 |
|------|------|--------|-------------|
| 验证完整性 | 5.2 启动时序集成测试依赖 phase 0 先修正时序文档 | 🟡 | 若 phase 0 固化与代码相反的 spawn/createWindow 顺序（见 phase 0 第一行），phase 5 集成测试会基于错误契约编写 |
| 验证完整性 | 5.3 pre-commit 只扫 composables/，漏 stores + components | 🔴 | 同 phase 1 验证盲区。`stores/plugin.ts` + 3 组件的 send 直调不会被 5.3 的「composables/ 下禁止 import ws-client」拦截。防护形同虚设 |

---

## 跨阶段问题

### 🔴 掉到缝隙里的决策（无阶段认领的代码改动）

1. **M1 main.ts spawn 去重**：design.md M1 + table 4.4 标「阶段 0」，phase 0 是纯文档。`main.ts:142-156` vs `:177-188` 的 `createWindow + start + send('runtime-port')` 三行重复，design.md 建议抽 `startAndNotify(win)`。**无 code phase 承接**。

2. **M3 window-manager 不存完整 tree**：design.md M3 + table 4.4 标「阶段 3」，phase 3 全是 Runtime session-service。`window-manager.ts:89,100-105` 递归完整 PanelTree。design.md 建议改存 `sessionIds: Set`。**无 code phase 承接**。

3. **D1 启动时序契约与代码相反**：phase 0 文档化八步时序（spawn→createWindow），代码是 createWindow→spawn（`main.ts:142` 先于 `:154`）。phase 0 不处理，phase 5 基于该契约写集成测试。**契约-代码不一致无人 reconcile**。

### 🟡 决策映射表造成误解

4. **D2「Main 原子 claim」无限期搁置**：migration-plan 决策映射「Main 原子 claim 随 session 迁移功能迭代」——无具体阶段。等于不在本重构 scope，但留在映射表易误读为有计划。应明确标注「超出本重构 scope」。

### 🟡 设计内部冲突未 reconcile

5. **G6 refCount 多实例去重 vs useChat 全局单例注册**：design.md G6 设计「组件多实例 refCount 合并」，但 useChat 现状是模块级全局单例注册（`useChat.ts:375` queueMicrotask + `if (globalEventMap) return` 幂等）。两套机制，phase 1 task 7 未说明迁移后走哪套。

6. **G5 重连收尾放在 useConnection（effects 层）vs design.md R2「effects 不碰 store」**：plan task 7 要求 useConnection 调 markSessionError，但 design.md R2 明确 effects 只碰 api 不碰 store。层级违规未解决。

---

## 建议（不给方案，只指出遗漏）

> 以下只指出「缺了什么」，不给替代方案。

1. **phase 0**：明确 D1 八步时序与代码现状的 reconcile 路径（改文档 or 改代码）；把 M1/M3 的代码改动从 table 4.4 的「阶段 0/3」要么重新分配到真实 code phase，要么标注「超出 scope」。
2. **phase 1**：
   - 迁移范围从「7 composable」扩到「所有 send 直调方」（含 `stores/plugin.ts` + 3 组件）。
   - 验证 rg 扫描范围从 `composables/` 扩到全 `renderer/src/`。
   - mock 迁移按 273 行重写估工；VITE_MOCK 检查点补 `useConnection.ts:45,53`。
   - useChat 迁移列出实际 23 个事件类型；说明 G6 refCount 与全局单例注册如何 reconcile。
   - task 4 标注「runtime 侧 id 回填已就绪，仅需前端 pending.ts 发 id」。
   - G5 补「重连时清空 session-scoped messageQueue」+ 解决 effects 层碰 store 的层级违规。
   - 修正 useTree（8 非 3）/ useModel（3 非 2）/ useExtensionUI（含 plugin.*）/ useSession（switch 在 useTree）的消息数。
3. **phase 2**：
   - 修正 extension-service.ts / extension-timeout-manager.ts 分类（根目录→需 mv 进 services/）。
   - 修正 tsup entry 描述（bundle 模式，entry 不含 server.ts）。
   - 补 services/ 现有 git-info.ts / session-history.ts 盘点。
   - 明确 5 个 handler 头注释 + shared/protocol.ts 注释的归属（phase 2 随 SidecarServer 改名一起「正注释」最合理，符合 D7）。
4. **phase 3**：
   - 方法归属表补齐 ~20 个 public 方法（getSummary/rebindAfterFork/destroyAll 必须有归属）。
   - 定义私有 helper（initializeManagedSession/detachSession/toSummary/findScannedSession/findSessionByClient/getSkillPaths/getExtensionPaths）的共享模型。
   - 定义 sessions Map + 5 个 constructor deps 的跨模块共享模型。
   - 明确 pm.onSessionExit 回调（:78）的归属。
5. **phase 5**：5.3 pre-commit 扫描范围扩到全 renderer（含 stores + components），否则 stores/plugin.ts + 3 组件的 send 直调永不被拦截。
6. **跨阶段**：M1/M3 代码改动、D2 原子 claim 的去留，必须在 migration-plan 决策映射表中明确「归属某 code phase」或「明确超出 scope」，不能留在模糊的「阶段 0/3」。
