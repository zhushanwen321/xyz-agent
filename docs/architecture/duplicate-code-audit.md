# runtime 目录重复/近似代码清单

> 审查范围：`src-electron/runtime/src/`（排除 test/、node_modules/）
> 审查日期：2026-06-19
> 性质标注：🔴 真重复（应合并） / 🟡 结构相似（需判断） / 🟢 局部重复（低优先级） / ⚪ 形式相似但非重复

---

## 🔴 严重（高置信度真重复）

### D1. 两套独立的 YAML frontmatter 解析器（`parseAgentMd` / `parseSkillMd`）

三个文件各有一份**手写 YAML frontmatter 提取**，逻辑高度重叠：

- `services/scanners/agent-scanner.ts:10-73` — 提取 `---` 块、解析 `description:`（含多行 `>`/`|` + chomping `+/-`）、解析 `tools:`、正文 fallback
- `services/config-service.ts:28-61` — 提取 `---` 块、解析 `name:`、解析 `description:`（**同样的多行正则** `/^description:\s*[>\|][-+]?\s*$/m`）、同样的正文 fallback 逻辑
- `services/scanners/skill-scanner.ts:14-66`（parseSkillMd）— 第三份 frontmatter 提取骨架（description/argument-hint/triggers）

三处都重复：`split('\n')` → 找 `---` 配对 → 收集 frontmatter 行 → 正则取字段。

**判定**：真重复。description 多行解析的正则和 chomping 处理在三处漂移，是典型该抽公共 helper 的地方。

---

### D2. atomicWrite 已有 utils 但被 5 处手写绕过

`utils/fs-utils.ts:11` 有现成的 `atomicWrite(filePath, data)`（tmp + renameSync）。但下列地方各写一遍：

- `services/plugin-service/plugin-storage.ts:194-197` — `writeFile(tmpPath) + rename(tmpPath)`（PluginStorage.writeToDisk）
- `services/plugin-service/plugin-storage.ts:246-249` — `writeFile + rename`（persistSessionData，tmp 名带 `Date.now()_randomSuffix()`）
- `services/plugin-service/plugin-permission-storage.ts:53-65` — `writeFile(tmpPath) + rename`（PermissionStorage.save）
- `services/extension-service.ts:283-285` / `:303-305` — `writeFileSync(tmpPath) + renameSync`（settings.json、disabled-packages.json 各一处）
- `infra/pi/session-file-utils.ts:176-178` — `writeFileSync(tmpPath, ...) + renameSync`（patchSessionCwd，tmp 名带 `Date.now()`）

对照：`infra/pi/pi-provider-store.ts:91-96`（writeJsonFile）和 `infra/pi/pi-config-bridge.ts:168`（writeAgentFile）**正确用了** `atomicWrite`。

**判定**：真重复。已有官方实现，5 处各写一遍，连 tmp 命名约定都漂移（`.tmp` / `.tmp_${ts}_${rand}` / `.patch-tmp-${ts}`）。

---

### D3. 两套 npm 安装实现（形式相似，业务不同）

> ⚠️ **判定修正（2026-06-19）**：初判为「真重复 + 架构债」有误。经查证，两套服务的是**两个不同业务对象**，非同一件事的两份实现。

| 安装器 | 层 | 服务对象 | 安装目录 | 实现 |
|---|---|---|---|---|
| `NpmGitInstaller` + `npm-installer.ts` | infra | **pi extension**（ExtensionService 用） | `~/.xyz-agent/pi/agent/npm/node_modules/` | 纯 Node + SSRF 防护 |
| `PluginInstaller`（plugin-installer.ts） | services | **xyz-agent plugin**（PluginService 用） | `~/.xyz-agent/plugins/<pkgName>/` | execFile npm/tar |

- **pi extension** = pi 进程加载的扩展（`--extension` 参数），走 pi 自己的加载机制
- **xyz-agent plugin** = xyz-agent runtime 加载的插件（Worker Thread 跑），独立于 pi

形式相似（都是「下载 npm 包 → 校验 → 落盘」），业务是两回事（不同对象、不同目录、不同生命周期）。

**真正的可复用点**：`npm-installer.ts` 里的下载原语（`downloadAndExtract` / `verifyIntegrity` / `fetchMetadata` / SSRF 校验）是通用的，PluginInstaller 可复用这些原语而非自己 execFile npm。

**判定修正**：🟡 **非架构债，降为 P1**。不是「两套做同一件事」，而是「PluginInstaller 该不该也复用 npm-installer 的下载原语」。能力不对等（PluginInstaller 无 SSRF 防护、依赖 npm CLI 在 PATH）是真问题，但不是分层错误。

---

### D4. `migrateToPiSubdir` 中 sessions 和 agents 迁移近乎复制

`infra/pi/pi-provider-store.ts:382-440`：

- sessions 块（382-410）：`existsSync(oldDir)` → `readdirSync` → for 循环 `renameSync` → 计数 → `rmdirSync`
- agents 块（412-440）：**逐行结构相同**，只换变量名

**判定**：真重复。可抽 `migrateDirEntries(oldDir, newDir, label)`。

---

## 🟡 中等（结构高度相似，需判断）

### D5. 全部 RPC api/* 文件是同一对偶结构

`services/plugin-service/api/` 下 7 个文件**完全同一骨架**：

```
registerXxxRpcHandlers(rpcServer, deps)  // 主线程侧：rpcServer.registerMethod('plugin.xxx.yyy', async (params) => ...)
createXxxApi(rpcClient, pluginId)         // Worker 侧：return { yyy: (...) => rpcClient.request('plugin.xxx.yyy', {...}) }
```

涉及：`agent-api.ts`、`config-api.ts`、`session-api.ts`、`session-data-api.ts`、`ui-api.ts`、`workspace-api.ts`、`tool-api.ts`（`hook-api.ts` 稍复杂）。

**判定**：⚪ 形式相似但**不是重复**——每个 RPC method 的 params 解构和返回 cast 各自不同，强行合并损类型安全。规约式 API 的合理产物。**可考虑**抽薄封装减少 `async (params) => { const x = params.x as T }` 样板，收益有限。

---

### D6. scanner 两个文件主循环近乎复制

- `services/scanners/agent-scanner.ts:75-139`（scanAgents）
- `services/scanners/skill-scanner.ts:111-166`（scanSkills）

结构一致：`for rawSource of sources → expandHome → inferSourceType → existsSync → readdirSync → for entry → statSync.isDirectory → 找配置文件 → readFileSync → parse → push 结果`。差异只在：找 `agent.md` vs `SKILL.md`、解析函数、fileSize、tools。

`scanDirectory`（`extension-resolver.ts:342-360`）是第三份「readdirSync → isDirectory → 过滤 → push」循环。

**判定**：🟡 形式相似，部分可合并。dir 遍历 + isDirectory 过滤 + existsSync 守卫能抽公共（如 `scanSubdirs(dir, predicate)`），parse/输出结构差异大不建议强行合一。

---

### D7. 多个 store/adapter 类是「聚合 infra 自由函数 + 逐方法薄委托」

三个是同一模式：

- `infra/pi/pi-config-store.ts`（PiConfigStore implements IConfigStore）— 17 个方法，几乎每个 `return piBridge.xxx(...)` 一行，加 2 处 `as unknown` 翻译
- `infra/pi/session-store.ts`（PiSessionStore implements ISessionStore）— 8 个方法，全是 `return xxx(...)` 一行
- `infra/pi/session-tree-reader-adapter.ts`（SessionTreeReaderAdapter implements ITreeReader）— 3 个方法，全是 `return xxx(...) as ...`

**判定**：⚪ 形式相似但非重复。「port adapter 把自由函数包成类」是依赖倒置的标准做法，存在是为了让 service 依赖 interface。但 17 个一行委托确实啰嗦，可质疑「是否需要这么薄的类」。

---

### D8. transport 五个 message-handler 结构相同

`transport/` 下：

- `extension-message-handler.ts`（ExtensionMessageHandler）
- `plugin-message-handler.ts`（PluginMessageHandler）
- `session-message-handler.ts`（SessionMessageHandler）
- `tree-message-handler.ts`（TreeMessageHandler）
- `settings-message-handler.ts`（SettingsMessageHandler）

都是 `class XxxHandler { constructor(private ctx: XxxHandlerContext) {} handleXxxMessage(msg, ws) { switch(msg.type){...} } }`，ctx 接口里都有 `send / sendError`（部分还有 `broadcastXxxList`）。

**判定**：⚪ 形式相似但非重复。从 RuntimeServer 巨石按消息类型拆出的 handler，各自 switch 表完全不同。共享的 `ctx.send/sendError` 已是约定，无需再抽。

---

## 🟢 轻微（局部重复，低优先级）

### D9. `cloneSession` / `forkFromEntry` 尾段重复

`services/tree-service.ts:166-213`：两个方法末尾 `get_state → 取 sessionId/sessionFile → 返回 ForkResult` 几乎一字不差，只差命令名（`clone` vs `fork + entryId`）。

**判定**：🟢 局部真重复，可抽 `getNewSessionState(client)`。

### D10. `findValidDefaultModel` 的「找第一个有 models 的 provider」逻辑内联 3 次

`infra/pi/pi-provider-store.ts:144-151`（upsertProvider）、`:184-191`（removeProvider）、`:258-262`（findValidDefaultModel）——三处都是 `for ([pid, pcfg] of providers) { if (pcfg.models?.length) { return { pid, pcfg.models[0].id } } }`。

**判定**：🟢 真重复，可抽 `pickFirstUsableDefault(providers)`。

### D11. `navigateCapableMap.get(sessionId) ?? false` 重复 4 次

`services/tree-service.ts:76, 92, 101, 102` 反复写同一表达式。

**判定**：🟢 轻微，已有同名 public 方法 `isNavigateCapable` 但内部没复用。

### D12. `randomSuffix()` 在两文件各定义一次

`services/plugin-service/plugin-service.ts:21-24` 和 `services/plugin-service/plugin-storage.ts:14-17` 各一份 `Math.random().toString(36).slice(2)`。

**判定**：🟢 极轻微真重复。

### D13. `log = { info, warn, error, debug }` 工厂对象在两文件重复

`infra/installers/extension-resolver.ts:23-28` 和 `services/extension-service.ts:26-32` 各手写一份带 `[xxx]` 前缀的 console 包装对象。

**判定**：🟢 形式相似，可抽 `createLogger(tag)`。

---

## 🟡→🔴 第二轮：跨文件横切重复（2026-06-19 补充）

> 第一轮聚焦单文件内/相邻文件的重复。第二轮用 grep 扫横切模式，发现一批「同一小逻辑散落 N 处」的重复。

### D14. `e instanceof Error ? e.message : String(e)` 错误信息提取（50+ 处）

散落在几乎所有 catch 块。grep 命中 57 行（截断在 60），实际遍布 extension-service（16 处）、plugin-storage、session-*、tree-service、transport/*、plugin-service/* 等。

变体还有 `e instanceof Error ? e.message : e`（pi-provider-store.ts:403/408/433/438、session-lifecycle.ts:63、session-service.ts:164——少一个 `String()`）。

**判定**：🔴 真重复，横切所有层。应抽 `errMsg(e): string` 工具函数（utils/）。这是收益最高的一项——50+ 处样板，且存在 `: e` vs `: String(e)` 的不一致漂移。

---

### D15. RPC / 请求超时三件套：`pending Map<number|string, {resolve, reject, timer}>` + `setTimeout` + `clearTimeout`

5 处各自实现同一结构：

| 文件 | pending 字段 | entry 形状 | 超时行为 |
|---|---|---|---|
| `infra/pi/rpc-client.ts:63-67` | `pending: Map<string,{resolve,reject,timer}>` | `{resolve,reject,timer}` | reject(timeout) |
| `services/plugin-service/plugin-rpc-client.ts:19-27` | `pending: Map<number,PendingEntry>` | `{resolve,reject,timer}` | reject(timeout) |
| `services/plugin-service/plugin-rpc-server.ts:22-33` | `pendingInvokes: Map<number,PendingInvoke>` | `{resolve,reject,timer}` | reject(timeout) |
| `services/plugin-service/plugin-activator.ts:45-48` | `pendingReplies: Map<string,PendingReply>` | `{resolve,timer}`（无 reject） | resolve(false) |
| `services/plugin-service/plugin-service.ts:64` | `pendingUiRequests: Map<string,{resolve,timer}>` | `{resolve,timer}`（无 reject） | resolve(default) |

外加 `plugin-activator.ts:272-281`（pendingPermissions）和 `tree-service.ts:135-148`（navigate 用 `Promise.race` + setTimeout）是变体。

每处都重复：`new Promise` → `setTimeout(清理+reject/resolve)` → `pending.set(id, entry)` → 完成时 `clearTimeout + pending.delete + resolve/reject` → `dispose/rejectAll` 时遍历清理。

**判定**：🟡 结构高度同构。可抽 `createPendingTracker<T>({timeoutMs, onTimeout})` 通用管理器，5 处变成薄封装。差异点（reject vs resolve(false)、id 类型）用泛型/配置吸收。中等收益，能消约 150 行重复。

---

### D16. `get_state` 响应解析：`resp.data ?? resp.payload` + `as` 取字段（6 处）

pi RPC 响应兼容两种字段位置（`data` 或 `payload`），解析样板重复：

- `services/tree-service.ts:70,160,174,199`（4 处）+ `:14-17` 定义了 `PiStateResponse` interface
- `services/session/session-lifecycle.ts:57-60`（内联 `{ data?: Record; payload?: Record }`，未复用 PiStateResponse）
- `infra/pi/rpc-client.ts:350`（`resp.data ?? resp.payload`）

每处都重复：`const stateData = stateResp.data ?? stateResp.payload` → `stateData?.sessionFile as string` / `stateData?.sessionId as string` / `stateData?.leafId as string`。

**判定**：🔴 真重复。`PiStateResponse` 类型在 tree-service 定义却被 session-lifecycle 内联重写，6 处解析样板可抽 `readPiState(client): Promise<PiState>` 返回强类型。顺带消除 session-lifecycle 那段重复的 `as`。

---

### D17. `settings.json` / `disabled-packages.json` 读写逻辑跨层重复 ✅ 已解决（2026-06-19）

> **解决记录**：settings.json 收敛为单一读写层 + 异步互斥 + 分区访问；跨层泄漏消除。
> - 新增 `infra/pi/pi-settings-store.ts` 作为 settings.json **唯一所有者**：`readSettings()`/`writeSettings()`/`updateSettings()`（异步 RMW 队列串行化）+ 3s 缓存 + 原子写。路径可经 `setSettingsPath()` 覆盖（测试用），生产默认 `getSettingsPath()`。
> - **model 域**（defaultModel/skills/...）：`pi-provider-store.ts` 删除自有的 `readSettings`/`writeSettings`/缓存，改为 import + re-export 自 pi-settings-store。两域共享同一缓存、同一队列。
> - **extension 域**（packages[]）：新增 port `services/ports/extension-settings.ts`（`IExtensionSettings`）+ infra 实现 `infra/pi/pi-extension-settings.ts`（`PiExtensionSettings`），经 pi-settings-store 读写 packages[]。
> - **ExtensionService**：installExtension/uninstallExtension/toggleExtension/readSettingsState 全部改走 `IExtensionSettings` port，删除 5 处直接的 `readFileSync`/`writeFileSync`/`renameSync` 对 settings.json/disabled-packages.json 的访问。services 层不再碰这两个文件。
> - **ExtensionResolver**：`scanSettingsExtensions` 的 packages[] 读取改走 `pi-settings-store.readSettings()`（disabled-packages.json 保留本地读，是 xyz-agent 自己的文件、无跨域竞争）。
> - **disabled-packages.json** 保持独立（xyz-agent 自己的文件，pi 不读），归 `IExtensionSettings` port 管理，不经 settings.json 互斥——无跨域竞争。
> - 跨域竞态消除：extension 的 async install 经 `updateSettings` RMW 队列，与 model 域同步写共享同一串行队列，await 间隙不再被覆盖。
> - 验证：tsc clean，657/657 测试通过。无行为变更（读写语义、原子性、错误处理对齐原有实现）。

这两个 pi 配置文件的读写，在 infra 和 services **各自独立实现**：

- **infra**：`infra/installers/extension-resolver.ts:149-207`（scanSettingsExtensions + readDisabledPackages，读 settings.json 的 packages[] + disabled-packages.json 的 disabled[]）
- **services**：`services/extension-service.ts` 多处：
  - `:266-285` installExtension 写 settings.json
  - `:294-309` uninstallExtension 读写 settings.json
  - `:312-326` uninstallExtension 读写 disabled-packages.json
  - `:345-374` toggleExtension 读写 disabled-packages.json
  - `:560-583` readSettingsState 读两个文件

路径拼接 `join(settingsDir, 'settings.json')` / `join(settingsDir, 'disabled-packages.json')` 两边各写一遍，JSON.parse + 字段形状 `{ packages?: string[] }` / `{ disabled?: string[] }` 也各写一遍。

**判定**：🔴 真重复 + 跨层泄漏。ExtensionResolver（infra）和 ExtensionService（services）都对同一对配置文件做独立 IO。理想状态：这两文件的读写应收敛到一处（建议 infra 侧 pi 配置层），ExtensionService 经 port 访问。这也呼应 D3 的架构债。

---

### D18. `xyz-agent-extension.js` 路径解析重复（packaged 分支）

- `services/extension-service.ts:96-100`
- `services/session/session-service.ts:58-60`

两处都是 `packaged ? resolve(process.cwd(), 'xyz-agent-extension.js') : resolve(resolve(projectRoot, '..'), 'xyz-agent-extension.js')`。

**判定**：🟢 局部真重复。可抽 `getExtensionFilePath(projectRoot, packaged)`。且这个判定和 D19 的 `XYZ_AGENT_PACKAGED` 是同一现象。

---

### D19. `process.env.XYZ_AGENT_PACKAGED === '1'` 打包模式判定（5 处）

散落：`pi-provider-store.ts:443`、`process-manager.ts:13,162`、`extension-service.ts:93`、`session-service.ts:58`。

**判定**：🟢 轻微。可抽 `isPackaged()` 常量。低优先级。

---

### D20. ENOENT 处理 3 种写法并存

| 写法 | 位置 |
|---|---|
| `(e as NodeJS.ErrnoException).code === 'ENOENT'` | plugin-storage.ts:156,266,285 |
| `code === 'ENOENT'`（已先取 code） | pi-provider-store.ts:84、session-history.ts:26 |
| `errMsg.includes('ENOENT')`（字符串匹配） | process-manager.ts:161、session-message-handler.ts:60 |

**判定**：🟡 形式相似 + 不一致。前两种是结构化判定（正确），第三种是字符串包含匹配（脆弱，消息一变就失效）。可统一成 `isEnoent(e)` 工具。低-中收益。

---

### D21. `statSync(x).isDirectory()` 扫描守卫（6 处）

`extension-resolver.ts:99,245,349`、`plugin-registry.ts:45`、`agent-scanner.ts:94`、`skill-scanner.ts:130`——全是 `try { if (!statSync(p).isDirectory()) continue } catch { continue }` 或变体。

**判定**：🟢 与 D6 同源（scanner 重复）。归到 D6 的 `scanSubdirs` 骨架一并处理。

---

### D22. push id / 广播 id 生成 3 种写法不一致

- `transport/server.ts:121` — `push_${++this.pushId}`（自增计数器）
- `services/model-service.ts:25` — `push_${Date.now()}`（时间戳）
- `index.ts:93` — `push_${Date.now()}`（broadcastFn 内联）
- `plugin-service.ts:245,306` — `${prefix}_${pluginId}_${Date.now()}`

且部分 `broker.broadcast({...})` **不带 id**（session-service.ts:75,76,292、message-dispatcher.ts:83），部分带。

**判定**：🟢 一致性问题。id 生成策略不统一（计数器 vs 时间戳），且广播消息 id 可选。非严格重复，但属于「同一概念多种实现」。低优先级。

---

### D23. 路径归一化 `p.split(/[/\\]/).join('/')` 重复

- `transport/server.ts:368`（handleFileRead 内 `normalize`）
- `services/plugin-service/plugin-rpc-setup.ts:280`（workspace.getName 取最后一段）

**判定**：🟢 极轻微。两处目的不同（一个归一化分隔符，一个取 basename），形式相似非重复。`path-utils.ts` 可考虑补 `toPosixPath` / `basenameCross`。

---

## 🟡→🔴 第三轮：接口重叠与遗漏的小重复（2026-06-19 补充）

### D24. `IRpcClient` 与 `IPiEngine` 是同一概念的两套接口 ✅ 已解决（2026-06-19）

> **解决记录**：合并到 `services/ports/pi-engine.ts` 作为唯一权威定义。
> - `IPiEngine` 吸收 `IRpcClient` 的全部方法（通信 + 进程生命周期 `start/kill/onExit/exited` + session 级 `compact/clear`）。决策依据：`IPiEngine` = 「单个 pi 进程的全部能力」，生命周期方法是该进程自身的能力，归进程池反而不自然。
> - `IProcessManager`（原 interfaces.ts）迁入 `ports/pi-engine.ts`，删除无人引用的死 port `IPiProcess`。顺手修正契约漂移：旧 `IProcessManager.onSessionExit` 声明返回 `void`，实际实现返回 `() => void`——port 现与实现一致。
> - `RpcClient implements IPiEngine`（原有）、`ProcessManager implements IProcessManager`（新增）均通过 tsc 校验。
> - `interfaces.ts` 仅保留 `IRpcClient = IPiEngine` 兼容别名（@deprecated）+ re-export，待后续清理。调用点（message-dispatcher / tree-service / bridge-handler / session-service / 测试）已迁到从 `ports/` 导入。
> - 验证：tsc clean，657/657 测试通过。无行为变更。

- `interfaces.ts:26-43`（`IRpcClient`）— transport/session 层用
- `services/ports/pi-engine.ts:36-49`（`IPiEngine`）— ports 域定义

方法集高度重叠：`prompt / abort / steer / followUp / setModel / setThinkingLevel / getHistory / getCommands / sendCommand / onEvent` 全部一致。差异：

- 返回类型：`IRpcClient` 用 `Promise<unknown>`，`IPiEngine` 用 `Promise<PiMessage>`（而 `PiMessage = unknown`，见 pi-engine.ts:15——本质相同，只是别名）
- `IRpcClient` 多 `onExit / exited / kill / start / clear / compact`（生命周期方法）

同理 `IProcessManager`（interfaces.ts:48-65）是 `IPiProcess`（pi-engine.ts:55-61）的超集（多 `rekey / getSessionIdByClient / destroyAll`）。

**判定**：🔴 真重复。同一批概念（pi 引擎 + 进程池）在 interfaces.ts 和 ports/pi-engine.ts 各定义一遍，且 `PiMessage = unknown` 这个别名说明类型系统已经对 pi 动态响应「认输」——两套接口都没提供真正的类型安全。应合并成一套（建议保留 ports/pi-engine.ts 作为 port 定义，interfaces.ts 的 IRpcClient 改为 re-export 或删除）。

---

### D25. `RpcClient` 与 `PluginRpcClient` 的 pending 管理深层同构

D15 已记录 pending 三件套。第三轮细看，`infra/pi/rpc-client.ts` 和 `services/plugin-service/plugin-rpc-client.ts` 连清理循环都一样：

```
rpc-client.ts:216        for (const [id, entry] of this.pending) { clearTimeout; reject }
plugin-rpc-client.ts:125 for (const entry of this.pending.values()) { clearTimeout; reject }
plugin-rpc-server.ts:162 for (const pending of this.pendingInvokes.values()) { clearTimeout; reject }
```

三个 `dispose()/rejectAll()` 的实现是同一段代码（遍历 pending → clearTimeout → reject → clear）。

**判定**：🟡 强化 D15。`createPendingTracker` 抽出后，dispose/rejectAll 也一并统一。

---

### D26. npm-installer 内 gunzip+extract 的两个 Promise 包装重复

`infra/installers/npm-installer.ts:311-324`（integrity 校验后从 buffer 解压）和 `:327-338`（无 integrity 流式解压）——两段 `new Promise<void>((resolve, reject) => { createGunzip + tarExtract + 绑定 error/finish })` 几乎逐行相同，差异仅在输入源：

- 前者：`gunzip.write(buffer); gunzip.end(); gunzip.pipe(extract)`
- 后者：`final.pipe(gunzip).pipe(extract)`

**判定**：🟢 局部真重复。可抽 `extractTarStream(input: Readable | Buffer, tmpDir)` 吸收两种输入。低优先级（局部、单文件内）。

---

### D27. `writeFileSync(tmpPath) + renameSync` 在 extension-service 重复 4 处

`services/extension-service.ts`：
- `:227` 写 package.json（非原子，无 tmp）
- `:283-285` 写 settings.json（tmp + rename）
- `:303-305` 写 settings.json（tmp + rename，uninstall 路径）
- `:319` 写 disabled-packages.json（**非原子**，直接 writeFileSync）
- `:366` 写 disabled-packages.json（**非原子**）

**判定**：🟡 强化 D2 + 一致性问题。同一文件内 5 处写操作，3 种风格（atomic / 非 atomic 混用），`:319/:366` 的 disabled-packages.json 写入没有用原子写，与 settings.json 不一致。统一改 `atomicWrite` 顺带修这个潜在 bug。

---

### D28. `Disposable` 仅 runtime 内部定义，未与任何上层共享

`plugin-types.ts:200` 定义 `Disposable { dispose(): void }`，被 plugin-service 大量使用（hooks/sessions/events 的返回类型）。grep shared 包无此定义。

**判定**：⚪ 非重复（只有一份）。但属于「该共享却没共享」——这是 VSCode LSP 风格的通用契约，若未来 renderer 也要用会重复定义。仅作记录，无需现在动。

---

## 处置优先级汇总（合并三轮）

> 下方表格按 **影响范围 × 改动性质** 重新分为 P0–P3 四档（取代早期的「高/中/低」定性）：
> - **P0 整体架构层**：改动跨层、动 port 定义归属、改变分层契约。做之前必须讨论清楚目标分层。
> - **P1 局部模块级架构**：在单模块/单层内调整结构（抽 port、拆类、改 store 形态），不跨层但改变模块内部架构。
> - **P2 快速代码复用**：纯抽公共 helper / 工具函数，调用点机械替换，不改架构。可批量做。
> - **P3 待确认 / 可能非重复**：形式相似但语义可能本质不同，或收益不明确，需逐个确认。

| 档位 | 项 | 性质 | 处置 |
|---|---|---|---|
| **P0** | ~~D17 settings/disabled-packages 跨层读写~~ ✅ | 真重复 + 跨层泄漏 | 新增 pi-settings-store 单一读写层（异步互斥）+ IExtensionSettings port，services 不再碰文件，两域分区共享 |
| **P0** | ~~D24 IRpcClient vs IPiEngine 接口双份~~ ✅ | port 定义重复 | 合并到 ports/pi-engine.ts，IPiEngine 吸收生命周期方法，删 IPiProcess，interfaces.ts 留 @deprecated 别名 |
| **P1** | D3 两套 npm 安装（形式相似，业务不同） | 能复用的是下载原语 | PluginInstaller 复用 npm-installer 的下载/校验原语，非整体合并 |
| **P1** | D15/D25 RPC 超时三件套（5 处） | 跨层同构结构 | 抽 `createPendingTracker` 放 `utils/async/`，5 处统一 |
| **P1** | D1 parseAgentMd/parseSkillMd | 真重复，跨 scanner+config | 抽公共 frontmatter 解析 helper（infra 或 utils） |
| **P1** | D6/D21 scanner 主循环 + isDirectory 守卫 | 形式相似 | 抽 `scanSubdirs` 遍历骨架 |
| **P1** | D7 三个 store/adapter 薄委托 | 形式相似，可质疑 | 评估「自由函数→port adapter」是否过度封装 |
| **P1** | D16 get_state 解析（6 处） | 真重复 | 抽 `readPiState(client)`，session/tree 共用 |
| **P1** | D4 migrateToPiSubdir 两段 | 真重复 | 抽 `migrateDirEntries` |
| **P1** | D27 extension-service 写操作风格不一 | 强化 D2 + 潜在 bug | 统一 atomicWrite，修 disabled 非原子写 |
| **P2** | D2 atomicWrite | 真重复，已有官方实现 | 5 处改用 `atomicWrite`，统一 tmp 命名 |
| **P2** | D14 `errMsg(e)` 提取 | 真重复，50+ 处横切 | 抽 utils 工具函数，统一 `:e` vs `:String(e)` |
| **P2** | D20 ENOENT 3 写法 | 不一致 | 抽 `isEnoent(e)`，消灭字符串匹配写法 |
| **P2** | D18/D19 packaged 路径/判定 | 局部重复 | 抽 `isPackaged()` + `getExtensionFilePath()` |
| **P2** | D9 cloneSession/forkFromEntry 尾段 | 局部真重复 | 抽 `getNewSessionState(client)` |
| **P2** | D10 pickFirstUsableDefault | 真重复 3 处 | 抽 helper |
| **P2** | D11 navigateCapableMap 重复读 | 轻微 | 复用已有 public 方法 |
| **P2** | D12 randomSuffix 重复 | 极轻微 | 抽 utils |
| **P2** | D13 log 工厂对象重复 | 形式相似 | 抽 `createLogger(tag)` |
| **P2** | D26 gunzip+extract 两段 | 局部，单文件内 | 抽 `extractTarStream` |
| **P3** | D5 api/* 对偶结构 | 形式相似，可能非重复 | 规约式 API，强合并损类型安全，倾向不动 |
| **P3** | D8 transport 五个 message-handler | 形式相似非重复 | switch 表各异，仅共享 ctx 约定 |
| **P3** | D22 push id 三种生成法 | 一致性问题非重复 | id 策略可讨论，但非重复 |
| **P3** | D23 路径归一化 | 形式相似，目的不同 | 一个归一化一个取 basename，非重复 |
| **P3** | D28 Disposable 未共享 | 非重复（仅一份） | 「该共享却没共享」，暂不动 |
| **P3** | D14 的 `:e` 变体（pi-provider-store/session-lifecycle） | 可能非重复 | 需确认那几处为何不 `String()`——可能是刻意保留原始对象 |

---

## P0 详述（待讨论）

> P0 两项的共同特征：**改一处就要动跨层依赖方向或 port 定义归属**，不是「抽个函数」能解决的。
>
> 名词约定：**port**（来自六边形架构/端口-适配器模式）= service 层定义的接口，描述「我需要外部世界提供什么能力」，但不关心谁实现、怎么实现。infra 层写「适配器」实现这些接口。这样 service 依赖的是抽象（port），不依赖具体实现，实现可替换、可 mock。runtime 里 `services/ports/` 目录就是这个意思——每个文件定义一个域的 port（config/session/tree/pi-engine...）。

### P0-1. D17：settings.json / disabled-packages.json 跨层读写 ✅ 已完成（2026-06-19）

> **落地结果**（详见上方 D17 解决记录）：
> - 新建 `infra/pi/pi-settings-store.ts`：settings.json 唯一读写层（`readSettings`/`writeSettings`/`updateSettings` 异步 RMW 互斥 + 3s 缓存 + 原子写 + 可覆盖路径）。
> - 新建 port `services/ports/extension-settings.ts`（`IExtensionSettings`）+ infra 实现 `infra/pi/pi-extension-settings.ts`（`PiExtensionSettings`）。
> - model 域（pi-provider-store）与 extension 域共享同一 store/缓存/队列——分区靠各域只改自己的 key。
> - ExtensionService/ExtensionResolver 改走 port/store，services 层删除全部 settings.json/disabled-packages 直接 IO。
> - 讨论点结论：选了「新建 IExtensionSettings port」（不塞进 IConfigStore）——同一文件两个窄 port，各管各的字段，比一个膨胀的 IConfigStore 清晰；两 port 的实现都经 pi-settings-store，物理同文件、逻辑分区。
> - tsc clean + 657/657 测试通过，零行为变更。

**现状**：这两个 pi 配置文件的读写，在 infra 和 services **各自独立实现**：

- **infra**：`infra/installers/extension-resolver.ts:149-207`（scanSettingsExtensions + readDisabledPackages，读 settings.json 的 packages[] + disabled-packages.json 的 disabled[]）
- **services**：`services/extension-service.ts` 多处（installExtension/uninstallExtension/toggleExtension/readSettingsState 各自读写）

路径拼接 `join(settingsDir, 'settings.json')` / `join(settingsDir, 'disabled-packages.json')` 两边各写一遍，`JSON.parse + as { packages?: string[] }` / `as { disabled?: string[] }` 也各写一遍。两个层对同一对配置文件做独立 IO，没有任何一方知道另一方在改什么。

**问题**：
- 跨层泄漏：ExtensionService（services）直接读写 pi 的配置文件，绕过了 port 抽象
- 一致性风险：两套读写逻辑各自演化，字段形状、容错处理可能漂移
- 这不是「抽个 helper」能解决的——要决定「配置文件读写归谁」

**目标方向**：
```
services/extension-service ──port──> infra (settings.json 读写单点)
```

**讨论点**：
- 归属到已有的 `IConfigStore`（ports/config.ts），还是新建 `IExtensionConfigStore`？我倾向后者——settings.json 的 packages[]/disabled[] 是 extension 管理专用语义，塞进 IConfigStore 会让后者膨胀。但 IConfigStore 已经管 settings.json 的其他字段（skills/defaultModel...），同一文件分两个 port 管也奇怪。想听你的。
- 这项和 D3（npm 安装）独立，不耦合，可单独做。

---

### P0-2. D24：IRpcClient 与 IPiEngine 是同一概念的两套接口 ✅ 已完成（2026-06-19）

> **落地结果**（详见上方 D24 解决记录）：
> - `IPiEngine` = 单进程全部能力（通信 + `start/kill/onExit/exited` + `compact/clear`）。
> - `IProcessManager` 迁入 ports/，删死 port `IPiProcess`，修 `onSessionExit` 返回类型漂移。
> - `ProcessManager` 加 `implements IProcessManager`（之前无 implements 子句，契约漂移无人发现）。
> - tsc clean + 657/657 测试通过，零行为变更。

**先讲清「是什么概念」**：这两个接口描述的是同一件事——**「和 pi 子进程通信的能力」**。pi 是一个独立子进程，runtime 通过 stdin 发命令、stdout 收响应。任何需要跟 pi 说话的代码（发消息、切模型、读历史、abort...），都需要这个能力。

**现状**：
- `interfaces.ts:26-43` 定义 `IRpcClient`（session/transport 层用，如 message-dispatcher、tree-service、bridge-handler）
- `services/ports/pi-engine.ts:36-49` 定义 `IPiEngine`（ports 域定义，RpcClient 类 `implements` 它）
- 方法集 10/10 重叠：`prompt / abort / steer / followUp / setModel / setThinkingLevel / getHistory / getCommands / sendCommand / onEvent`
- 返回类型差异是假差异：`IRpcClient` 用 `Promise<unknown>`，`IPiEngine` 用 `Promise<PiMessage>`，而 `PiMessage = unknown`（pi-engine.ts:15）——本质相同
- `IRpcClient` 多 `onExit / exited / kill / start / clear / compact`（进程生命周期方法）
- 同理 `IProcessManager`（interfaces.ts:48-65）是 `IPiProcess`（pi-engine.ts:55-61）的超集

**问题**：
- 同一概念两份定义，维护时要改两处
- `interfaces.ts` 和 `ports/` 的**职责边界不清**：哪些接口该在 interfaces.ts、哪些该在 ports/？目前是历史遗留混放（早期没有 ports 概念，接口都堆 interfaces.ts；后来按「port 归 ports/」新建，但老的没删）
- 讽刺点：`PiMessage = unknown` 说明类型系统已经对 pi 动态响应「认输」——两套接口都没提供真正的类型安全，重复的定义没带来额外价值

**讨论点**：
- 合并方向：保留 `ports/pi-engine.ts`（更符合「port 定义在 services/ports/」的依赖倒置规约），`interfaces.ts` 的 `IRpcClient` 改 re-export 还是删除？
- 借这次定一个规约：**「port 定义（描述外部能力）一律放 ports/，interfaces.ts 只放跨服务 DI 契约（如 ISessionService 这类 facade 接口）」**？还是反过来？这会牵动 interfaces.ts 里不少接口的归属判断。
- `IRpcClient` 多的生命周期方法（kill/start/onExit/exited）归到哪？它们是「进程生命周期」，逻辑上属于 `IPiProcess`（进程池）而非 `IPiEngine`（通信能力）——但这样改会动 RpcClient 的 implements。
