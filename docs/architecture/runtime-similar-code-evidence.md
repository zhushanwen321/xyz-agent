# runtime 相似代码扫描明细（证据索引）

> 配套文档：[`runtime-similar-code-review.md`](./runtime-similar-code-review.md)（分级与修复方案）
> 本文件是四片并行扫描的原始证据，每个相似点带 file:line，供上方 review 文档的字母编号（A1/A2/.../H2）回溯。
> 审查日期：2026-06-20。范围：`packages/runtime/src/`（排除 test/、node_modules/）。
> 性质：**仅记录形式/逻辑相似，不预判真假重复**。

---

## 一、transport 层（消息分发）

### D1. `switch (msg.type)` 分发骨架（6 handler + server.ts）

| 文件 | 方法 | switch 行 |
|---|---|---|
| transport/extension-message-handler.ts | handleExtensionMessage | 23–153 |
| transport/plugin-message-handler.ts | handlePluginMessage | 17–78 |
| transport/session-message-handler.ts | handleSessionMessage | 22–113 |
| transport/settings-message-handler.ts | handleSettingsMessage | 27–122 |
| transport/tree-message-handler.ts | handleTreeMessage | 20–117 |
| transport/bridge-handler.ts | handleBridgeRequest（switch on method） | 12–88 |
| transport/server.ts | handleMessage（中央路由） | 228–286 |

骨架（5/6 同形）：
```ts
async handleXxxMessage(msg, ws) {
  switch (msg.type) {
    case 'x.y': { await this.ctx.<svc>.<op>(...); return this.ctx.send(ws, { type, id: msg.id, payload }) }
  }
}
```

### D2. `this.ctx.send(ws, {type, id:msg.id, payload})` 回复惯用法（40+ 处）

- extension-message-handler.ts:44,47,56,75,88,101,116,132,147
- plugin-message-handler.ts:24,28,32,36,40,44,49,54,64,75
- session-message-handler.ts:26,33,37,44,57,72,76,86,92,103
- settings-message-handler.ts:30,35,49,63,67,72,78,84,89,95,101,107,113
- tree-message-handler.ts:32,38,44,47,56,60,63,71,81,84,91,94,108,111

### D3. "service not available" 前置守卫

- extension-message-handler.ts: `if (!this.ctx.extensionService) return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)` —— **7 处**（:51,63,79,93,108,123,139；list case :44 返空列表而非报错，故不计）
- plugin-message-handler.ts:18（同形，不同 service）

### D4. mutate → scanExtensions → 回复列表

- extension-message-handler.ts toggle:54-56 / install:74-75 / uninstall:87-88 / finishInstall:131-132
- plugin-message-handler.ts list:22-25 / toggle:26-29 / uninstall:30-33 / approvePermissions:34-37 / revokePermissions:38-41

### D5. try/catch → toErrorMessage → 回复错误（10 处）

- extension-message-handler.ts:53-59,65-73,81-86,95-104,110-119,125-135,141-150（走 extractExtensionError）
- session-message-handler.ts:88-109 steer/follow_up 近乎镜像（只差 service 调用 + status 字符串）
- bridge-handler.ts:78-87

### D6. "not found" → 自动 restore session 重试（2 处真行为并行）+ 字符串嗅探 5 处

- session-message-handler.ts:49-67（session.switch）
- tree-message-handler.ts:39-52（session.tree-data）
- tree-message-handler.ts:40,62,83,93,110：`e.message.includes('not found')` 字符串嗅探重复 5 次

### D7. server.ts 内部机械重复

- :67-105 四个 context 对象字面量，`send`/`sendError` 箭头包装逐字相同（settings:73-74 / session:83-84 / extension:92-93 / plugin:97-98）
- :187-224 sendInitialState 6 段 best-effort try/catch（eslint-disable 注释复制 6 次）
- :306-319 broadcastProviderList/SkillList/AgentList 三方法同形

### D8. message-dispatcher `getClient → 空抛 → client.op()`（3 处逐行平行）

abort:118-122 / steerMessage:124-128 / followUpMessage:130-134，只差方法名和报错串。

### D9. DI 构造器 `constructor(private ctx)`

- 5 handler 同形：extension:21 / plugin:15 / session:20 / settings:25 / tree:18
- bridge-handler.ts:10 异类（直接收 service）
- TreeHandlerContext（tree-message-handler.ts:10-15）有 send 签名却没 extends MessageHandlerContext

### D10. 错误回复 payload 形状（6 种）

| 形状 | 位置 |
|---|---|
| sendError → `{type:'error',payload:{code,message,sessionId}}` | server.ts:298-302 |
| `{type:'extension.installError',payload:{code,message,hint?}}` | extension-message-handler.ts:68-73,103,118,134,149 + extractExtensionError:159-164 |
| `{type:'message.error',payload:{sessionId,message}}` | session-message-handler.ts:96,107; message-dispatcher.ts:85,101-104,110-113,156 |
| `{type:'file.read:error',payload:{error,path?}}` | server.ts:366,379,388 |
| `client.sendCommand('extension_ui_response',{id,response:{error}})` | bridge-handler.ts:75,81 |
| 内联 `{success:false,error}` | tree-message-handler.ts:32,47,56,63,71,84,94,111 |

### D11. console `[tag]` 遥测 + compact 耗时（无 logger 抽象）

- `[runtime]` server.ts 多处；`[server]` bridge-handler/session-handler；`[message-dispatcher]` message-dispatcher
- compact 遥测两处独立实现：session-message-handler.ts:117-131 与 message-dispatcher.ts:137-164

---

## 二、plugin-service API 层

### C1. 服务端 `registerMethod('plugin.X', params => deps.X(...))`（28 处）

遍布 8 个 `*-api.ts`（agent/config/session/session-data/ui/workspace/hook/tool）+ plugin-rpc-setup。每个 handler 重新解构 pluginId，尽管 plugin-rpc-server.ts:125 dispatch 已读过一次。

### C2. storage 方法 global/workspace ×4 ×2（plugin-rpc-setup.ts:90-115）

get/set/delete/keys 两 scope 各一遍，唯一差别 workspace 多传一个 `'workspace'` 参数。

### C3. 客户端 `rpcClient.request('plugin.X', {pluginId, ...})` 一行转发（~25 处）

所有 createXxxApi 单行 forward。例外：tool-api.ts:90-104 做后处理；workspace-api.ts:74-81 做 pre-warm。

### C4. `.then(() => {})` 丢弃 void 结果（6 处）

agent-api:70,79 / config-api:64 / session-api:96 / session-data-api:159,162 / ui-api:95,98。tool-api 用 await 形式（不一致）。

### C5. `.then(v => (v as T) ?? 默认值)`（5 处）

agent-api:73,76,82 / config-api:61 / session-api:87 / session-data-api:165 / workspace-api:70。默认值 `[]`/`{}`/`''` 各异；session/ui 用裸 `as Promise<T>` 不带 `??`（不一致）。

### C6. 无参 handler + `eslint-disable no-unused-vars`（5 处）

session-api:29-32,39-42 / workspace-api:30-32,34-36 / agent-api:40-42,44-46,53-55。agent-api 省了 eslint 注释（不一致）。

### C7. handlerId 生成 + Map 注册 + Disposable unregister（3 处）

- session-api.ts:98-108（onDidCreateSession）
- session-api.ts:110-120（onDidDestroySession）
- hook-api.ts:168-192（registerHook）

dispose 体基本是代码克隆。模块级 `++counter`：session-api:52 / hook-api:44（rpc-server:27 / rpc-client:21 同思路用于 request id）。

### C8. `onNotification` → 取 handlerId → Map 查找 dispatch（3 处）

session-api:69-75 / 77-83（精确克隆）；hook-api:143-162（多 result 回传 RPC）。

### C9. Map get-or-create 块（4 处）

hook-api:84-88 / session-data-api:86-90,94-98 / plugin-rpc-client.ts:83-88。

### C10. 错误码注入 Error（2 语法，5 处）

- `Object.assign(new Error(...), {code})`：plugin-rpc-client.ts:99 / tool-api:45-48
- `(err as {code?:number}).code =`：plugin-rpc-server.ts:137 / session-data-api.ts:81

---

## 三、session-data / path / persistence

### A1. `readFile/readFileSync → JSON.parse → catch → 默认值` 骨架（9 处）

| 位置 | 默认值 | ENOENT 策略 |
|---|---|---|
| plugin-storage.ts:147-158 getCache | 空 Map | import isEnoent |
| plugin-storage.ts:256-266 loadSessionData | 空 Map | **内联** isEnoent（见 A6） |
| plugin-permission-storage.ts:27-47 load | 空 Map（两段 try） | 裸 catch |
| session-tree-reader.ts:77-84 buildTreeFromFile | 空 BuildTreeResult | 裸 catch |
| session-history.ts:21-31 getHistoryFromFile | 空数组 | import isEnoent |
| session-file-utils.ts:22-33 parseSessionHeader | null（同步） | 裸 catch |
| pi-provider-store.ts:80-90 readJsonFile | fallback 参数 | import isEnoent |
| pi-settings-store.ts:93-103 readSettingsFromDisk | `{}` | import isEnoent |
| pi-extension-settings.ts:32-41 readDisabledArray | `[]` | 裸 catch |

### A2. TTL 缓存 + isExpired（provider-store vs settings-store，字节级同构）

- pi-provider-store.ts:63-74（CACHE_TTL_MS=3000 / CacheEntry / isExpired / modelsCache）
- pi-settings-store.ts:71-82（同上，settingsCache）

两个 isExpired 函数体逐字相同；CACHE_TTL_MS 常量重复。

### A3. atomicWrite + mkdir + `JSON.stringify(data,null,2)` 写包装（3 处）

- pi-provider-store.ts:92-97 writeJsonFile
- pi-settings-store.ts:105-110 writeSettingsToDisk
- pi-extension-settings.ts:44-56 writeDisabledArray（多"空数组删文件"分支）

`JSON_INDENT=2` 常量三处（第三个叫 INDENT_SPACES）。

### A4. Map ↔ JSON round-trip（写侧 3 处）

- plugin-permission-storage.ts:57-63：`for([k,v] of data) obj[k]=v` + stringify
- plugin-storage.ts:189-191 writeToDisk：同形
- plugin-storage.ts:232-233 persistSessionData：`Object.fromEntries(data)` + stringify

### A5. `JSON.parse(JSON.stringify(readSettings()))` RMW（pi-provider-store 9 处，绕过 updateSettingsSync）

行：150, 155, 191, 196, 273, 283, 294, 304, 316。每个 model 域 setter 手写一遍，绕开 pi-settings-store.ts:181-186 的 updateSettingsSync。

### A6. 内联 ENOENT（与同文件已 import 的 isEnoent 冲突）

plugin-storage.ts:4 import 了 isEnoent，:155 正确使用，但 :261 和 :280 又内联同名逻辑（`const isEnoent = e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT'`），遮蔽 import。**修正既有 D20 的遗漏**。

### A7. `JSON.stringify(x).length` 字节统计（同文件 3 处）

session-data-api.ts:69-70,74,117。注意：`.length` 是 UTF-16 码元数，但常量命名带 Bytes；与 plugin-storage 用 Buffer.byteLength 不一致——两套 size 口径并存。

### B. write-back 缓存生命周期（两套并行）

| 维度 | PluginStorage（plugin-storage.ts:25-213） | SessionDataStore（session-data-store.ts:17-119） |
|---|---|---|
| 缓存粒度 | 每 pluginId:scope 一个 CacheEntry | 三张并行 Map（cache/dirty/size） |
| flush 触发 | debounce setTimeout 500ms（每条目） | 全局 setInterval 5000ms |
| size 跟踪 | 增量（set/delete 时 ±） | restoreFromDisk 全量重算（:94-98） |
| size 口径 | Buffer.byteLength | JSON.stringify().length |

- B1 timer clear-then-arm + catch-log：session-data-flush.ts:70-90 / plugin-storage.ts:165-179 + 98-101,114-117

### G1. `openSync → writeSync → closeSync` 块（session-file-utils 3 处）

:87-98（wx，容 EEXIST）/ :120-128（wx）/ :132-139（a）。

### G2. "跳过畸形 JSONL 行"内层 catch（3 处）

session-tree-reader.ts:98-104 / session-file-utils.ts:46-54 / session-history.ts:35-44。

### G3. 同步 ensure-dir（session-file-utils 2 处逐字重复 + 多余判断）

:73-74 与 :112-113 都是 `if(!existsSync(dir)) mkdirSync(dir,{recursive:true})`——而 mkdirSync({recursive}) 本就幂等，判断多余。

### H1. `'session-data'` 魔法字符串

plugin-storage.ts:240,242,255 与 session-data-store.ts:85 各自硬编码目录名，无 getSessionDataDir()。

### H2. join 链手工拼 config 路径

pi-paths.ts:22-50（统一）vs plugin-storage.ts:201,207-212,240 / plugin-permission-storage.ts:26,55 / session-data-store.ts:85 各自 join(baseDir,...)。

---

## 四、RPC / config-store / pi-bridge

### E1. PendingTracker register + resolve/reject（server/client 镜像，真差异）

plugin-rpc-server.ts:29/86/101-106/143 ↔ plugin-rpc-client.ts:23/50/96-103/116。真差异：client 给 reject Error 挂 `.code`、返 void；server 不挂、返 boolean。PendingTracker 已抽共享（既有 D15）。

### E2. listener Set + 返回 unsubscribe（3 处）

rpc-client.ts:69,284-287 / process-manager.ts:115,263-266（Set）；event-adapter.ts:455,464-478（单 listener 槽，异类）。

### E3. RpcClient 高层方法 = 1 行 sendCommand 包装（9 处）

rpc-client.ts:309-347（prompt/abort/steer/followUp/setModel/setThinkingLevel/getHistory/clear/compact），只差命令串和字段名。

### E4. child_process spawn + 生命周期

rpc-client.ts:91-143,356-389（内层 per-process）↔ process-manager.ts:159-192,207-221（外层 Map<sessionId>）。组合关系非重复；findPiExecutable（process-manager.ts:14-100）的 PATH/常见路径推理与 rpc-client.ts:108 `piCommand ?? 'pi'` 有重叠。

### F1. event-adapter 字段拷贝 handler（8 处，可表驱动）

handleAutoRetryStart/End(:364-388) / handleQueueUpdate(:391-400) / handleSessionInfoChanged(:403-408) / handleThinkingLevelChanged(:411-416) / handleExtensionError(:351-361) / handleToolExecutionUpdate(:338-348) / 内联 status/error(:442-449)。真逻辑的是 handleMessageUpdate(:77-102) / ToolExecStart/End(:105-183) / AgentEnd(:186-215) / UIRequest(:218-283) / MessageStart(:286-335)。

### F2. 形状映射/字段重命名 Record（内容不可合并，形式同构）

mapTypeToApi（pi-config-store.ts:24-34）/ STOP_REASON_MAP（event-adapter.ts:14-25）/ INTERACTIVE_UI_METHODS / NULL_FILES（:419-423）/ parseSpec（npm-installer.ts:194-203）/ pi-protocol.ts:12-17 文档化的 message↔content / args↔input / result↔output（散落 event-adapter/message-converter ad-hoc 应用）。

### F3. 目录扫描骨架（6 处）

pi-config-bridge.ts:57-141（scanPiSessions）/ :146-161（listAgentFiles）/ extension-resolver.ts:334-352（scanDirectory）/ :93-107 / :231-247 / pi-provider-store.ts:358-386（migrateDirContents）。

### F4. 原子目录替换 `mkdir tmp → 工作 → rmSync target → renameSync`

npm-installer.ts:311-363（.tmp 兄弟目录 + rename）/ pi-provider-store.ts:410-418（migrateToPiSubdir 直接 rename）/ pi-config-bridge.ts:163-169（writeAgentFile 走共享 atomicWrite）。tmp-dir 变体重写，没复用 atomicWrite。

### F5. installer 流程（npm install / git clone → parse → register）形式类似

npm-installer.ts vs npm-git-installer.ts。（注：既有 D3 已判定二者业务对象不同，移走去重清单。）

### F6. disabled-packages.json 双读（split-brain，需确认）

pi-extension-settings.ts:32-41 返 `string[]` vs extension-resolver.ts:187-199 返 `Set<string>`，各自解析同一文件，无共享 reader。注释声明「刻意独立」，但同进程两模块读同一文件仍是 split-brain。

### F7. pickFirstModelProvider 循环第 4 处内联（既有 D10 遗漏）

pi-provider-store.ts:259-263（findValidDefaultModel）仍内联 `for ([pid,pcfg] of providers) { if (pcfg.models?.length) return {...} }`，而 helper 已在 :132-141。既有 D10 抽了 helper 并改了 upsert/remove 2 处，漏了第 4 处。
