# Plugin 系统信任边界加固与鲁棒性修复·设计文档

> **一句话结论**：plugin 系统的根本缺陷不是零散 bug，而是**从未建立「不可信输入源」的信任模型**——身份由消息自报、边界由错误路径推导、判定权由插件声明、传输无认证。本设计以「身份由通道绑定、策略由宿主集中、输入必经校验」为原则重建四类防线，并补齐生命周期并发模型与对外契约一致性。不做止血（不回退 `EXTERNAL_PLUGIN_ENABLED`），直接把防线修成真的。

**层声明**：当前层 = plugin 系统修复工程的顶层架构决策；下一层 = 3 个方向的技术方案与实施单元（对应 cw 流程的 3 个 slice，见 §5）。

---

## 1. 背景目标

### SCQA

- **S（情境）**：xyz-agent 的 plugin 系统支持 built-in（trusted，Worker 线程共享池）与 external（sandbox，fork 子进程 + ESM loader 边界）两级插件，`EXTERNAL_PLUGIN_ENABLED=true` 意图开放第三方插件生态。
- **C（冲突）**：2026-08-17 五路对抗式审查（runtime 全部 33 文件 + statusline 插件 + plugin-sdk + 前端桥接 + 传输层）发现：sandbox 三道防线在代码层面**全部失效**，生命周期并发存在系统性竞态，SDK 对外允诺存在死链路。
- **Q（问题）**：如何在不动摇现有插件架构（Worker/fork 双宿主、RPC 协议、SDK API 面）的前提下，把安全承诺、稳定性、契约一致性修到长期架构正确？
- **A（答案）**：四类防线重建（身份/边界/判定/传输）+ 生命周期状态机收敛 + 契约「允诺-实现-验证」闭环，共 3 个方向、约 16 个实施单元。

### 系统是什么（受众补背景）

插件运行时链路：**插件代码**（Worker 线程或 fork 子进程内）→ 经 `plugin-rpc-server` 分发的 RPC 方法（`plugin.hooks.register`、`plugin.storage.set` 等 40+ 个）→ **runtime 主进程**各服务（registry/storage/activator）→ WS 广播 → **前端 extension-host**。插件对 runtime 而言是不可信输入源：它可以是善意的第三方代码，也可以是被投毒的 npm 包或恶意 repo 内置插件。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者视角 |
|---|------|-----------|
| G1 | sandbox 插件无法越出自身目录与授权 API 面 | 插件作者写正常插件无感知；恶意插件 `import 'node:fs'`、伪造身份、路径注入全部被拒且有清晰错误 |
| G2 | 传输面不对网络与其他本机用户开放 | 局域网/其他用户进程连不上 runtime WS；同用户本机恶意进程不在威胁模型内（同用户提权等价于用户自身，token 分发见 §3.3 D4 威胁模型声明） |
| G3 | 插件生命周期操作（开关/崩溃/重载/退出）在任何并发时序下状态一致 | 用户快速开关插件、插件崩溃后 5s 内退出应用，不出现假崩溃 toast、幽灵激活、挂死 30s |
| G4 | SDK/API 允诺的能力全部真实可用或显式报错 | 插件作者按 SDK 文档写代码，不存在静默失效 |
| G5 | 恶意/失控插件的广播风暴不拖垮前后端 | 高频 notify/statusbar 更新被限流，单条坏数据不毒化全局 |
| G6 | 正常关停数据零丢失 | 插件在 `onDeactivate` 里写的数据关停后仍在 |

### Scope

- **In**：P0 安全 6 项、P1 稳定性 8 项、P2 契约 8 项（明细见 §2.3），外加审查中发现的命令执行链路断裂修复。
- **Out**：插件市场/签名体系（等生态成型）、trusted 插件互相隔离（进程内对等体，见 §3.3 D1 信任模型澄清）、UI 视觉改动、pi extension 侧（`extensions/` 目录）任何改动。

---

## 2. 现状与问题分析

### 2.1 信任模型现状：三道防线全部失效

以「恶意 external 插件」为攻击者推演（所有路径已代码核实，file:line 为证）：

**防线一：进程沙箱（fork + ESM loader）——边界 0% 命中。**
`plugin-registry.ts:166` 生成 `pluginPath = <dir>/index.js`（入口**文件**路径，ESM 禁止目录导入，必须如此）；`plugin-host-process.ts:362-363` 将该文件路径原样注入 `env.XYZ_PLUGIN_SANDBOX_DIR`；`plugin-esm-loader.cjs:57-64` 判定 `filePath.startsWith(sandboxDir + path.sep)`——即要求模块路径以 `…/index.js/` 开头，任何真实模块都不可能命中 → `resolve` hook 首分支 `isInsideSandbox(context.parentURL)` 恒 false → 黑名单（`node:fs`/`node:child_process`）、路径边界、scheme 检查**从未对任何插件 import 执行过**。`plugin-security.ts` 头部 [HISTORICAL] 注释声称「sandbox 真隔离闭环已落地」，与事实相反。
两条次级逃逸：裸名 `import('somePkg')` 经 Node 向上遍历可在沙箱外 `node_modules` 命中，命中后该模块后续 import 全部绕过 hook（`plugin-esm-loader.cjs:114-115` 裸名放行不校验解析结果）；CJS `require('/abs/path.js')` 绝对路径不落入 `plugin-sandbox.ts:49-69` 的 `./`/`../` 边界分支，直接放行。

**防线二：RPC 鉴权——身份由消息自报。**
`plugin-rpc-server.ts:132-134` 权限判定取 `message.params?.pluginId`（消息体内、插件进程完全可控），而宿主明明可靠掌握消息来源：`plugin-host.ts:486-492` / `plugin-host-process.ts:411-427` 的消息回调闭包捕获真实 `workerId`（`trusted-N` / `sandbox-<pluginId>`），经 `dispatchHostRpcMessage` 传入 `dispatch(workerId, message)`——**身份通道存在但鉴权层不用它**。sandbox 插件伪冒 built-in id 即全放行（`plugin-permission.ts:39-41` 对 trusted/built-in 一律 true）。
反向缺陷：权限字符串口径错位——check 收到完整方法名 `plugin.hooks.register`，granted 集合存 manifest 声明形 `hooks.register`（`plugin-service.ts:573`），`has()` 永不命中 → **守规矩的 sandbox 插件全部 RPC 恒被拒**。权限系统既不安全也不可用。

**防线三：信任级判定——判定权在插件作者。**
`plugin-registry.ts:166` `trustLevel: manifest.trustLevel ?? 'sandbox'`——external 插件在 package.json 写 `"trustLevel": "trusted"` 即跑进 runtime 进程内 Worker（全权限），且 `getUnapproved` 对 trusted 返回空，审批 UI 不弹。配套的注入面：`plugin-registry.ts:82-96` built-in 目录按 runtime cwd 探测（`<cwd>/resources/plugins`、`<cwd>/../../resources/plugins`），用户 repo 内预置同名目录即可注入「built-in」插件。

**防线四：传输——runtime WS 无认证监听所有网卡。**
`connection-manager.ts:74` `listen(port)` 无 host（绑 `::`），无 origin/token 校验，无 `maxPayload`（ws 默认 100MB/条）。spawn 链路（`process-control.ts:221-227`、`transport.ts:25-28`）确认现状无任何凭据机制；renderer 经主进程 IPC `get-runtime-port` 拿端口后连 `ws://localhost:<port>`。同网段任意机器可直发 `plugin.install` / `plugin.approvePermissions`。

**数据面配套缺口**：`sessionDataStore`/`PluginStorage` 用 `sessionId`/`pluginId` 直接 `join()` 拼路径（`session-data-store.ts:139/157/172`、`plugin-storage.ts:141-153`），API 入口 `params.sessionId as string` 零校验——`../../` 可越出数据目录读/写/删（`clearSession` 的 `rmSync` 是删除原语）任意 `.json` 文件。

### 2.2 生命周期现状：无并发模型

插件激活状态机（UNLOADED/ACTIVATING/ACTIVE/DEACTIVATING/CRASHED/DEPS_MISSING）已有部分守卫（activatePlugin 的 in-flight 幂等返回同一 promise、审批等待期状态复查，`plugin-activator.ts:172-190/:217`），但异步转换窗口仍有系统性缺口：

- **单条 IPC 消息可崩 runtime**：`plugin-host.ts:488-490` 等消息回调对 null 消息 `m.type` 抛 TypeError → uncaughtException（`index.ts:516` 只兜 unhandledRejection）→ 进程退出。
- **并发开关错配**：`pendingReplies` 以 pluginId 单键（`plugin-activator.ts:578-593`），activate/deactivate 并发时互相覆盖 + 旧 timer 误删新 entry → 回复错配、假超时 30s、Worker 内 active 而宿主记 UNLOADED 的幽灵态。
- **并发加载错配**：`loadPlugin` 的 message listener 只匹配 `m.type` 不比对 `m.pluginId`（`plugin-host.ts:304-312`），同 Worker 并发加载 N 插件时 loaded/error 张冠李戴——启动期 `onStartupFinished` 批量激活与 rebuild 路径必然触发。
- **rebuild 不受 shutdown/disable 约束**：crash 后 5s 冷却 timer 不保存引用、不清理、不 unref（`plugin-host.ts:544-548`），`shutdown()` 不清 `crashedTrustedWorkers` → 退出应用后 timer 复活插件并阻塞进程退出；冷却期内用户 `toggle(false)` 后 rebuild 无条件重激活（`plugin-service.ts:357-374` 无状态守卫）。
- **崩溃处理不对称**：`fatal_error` 路径不 terminate 存活线程（线程泄漏，对比 process 版有 kill 兜底）；Worker 内 `events.on` 回调异常无兜底（`plugin-bootstrap.ts:174-177`），单插件回调 bug 连坐同 Worker 全部 ≤10 插件并累积 crashCounts；exit code 0 无清理（僵尸 handle 被复用分配新插件）。
- **关停丢数据窗口**：`plugin-service.ts:636-649` 顺序为 `sessionData.flushAll → stopFlushTimer → deactivateAll`，插件在 `onDeactivate` 写的 sessionData 落在已停表窗口，且 `dispose()` 全程无人调用。

### 2.3 契约面现状：允诺与实现脱节

- SDK `@stable` 死链路 ×2：`events.on/emit`（`plugin.event.*` 通知全仓无生产方，主线程对无 handler 的 notification 静默 return）与 `sessions.onDidCreateSession/onDidDestroySession`（注册的 RPC 方法不存在，错误被 `.catch(() => {})` 吞）。
- **命令执行链断裂**（本次设计核实新发现）：前端 `plugin.executeCommand` → `plugin-service.ts:612` invoke `'plugin.command.execute'`，但 Worker 侧 handler 是 `'plugin.commands.invoke'`（`commands-api.ts:136`），且 `plugin-rpc-setup.ts:248` 注释自认「向 worker 发送段归后续 wave」——动态注册的命令**从未真正可执行**。
- runtime 侧对插件输入零校验（api 域 `params.x as string` 模式）+ 零限流：单条坏 statusBar item 毒化整次全量广播（前端 `parseStatusBarUpdate` 整包丢弃，全体插件状态栏冻结）；notify/statusbar 无频率、大小、上限约束；commands 全局命名空间可覆盖他人命令；crash 不清理 statusBar 贡献（僵尸条目）+ crashCounts 只增不重置（累计 4 次偶发崩溃永久停摆无提示）。
- 前端 `error` 总线事件无消费者（解析失败静默丢失）。

### 2.4 根因归纳

| 根因 | 表现 |
|------|------|
| R1 身份自报 | 鉴权、storage 分区、事件归属全部信消息体 `params.pluginId` |
| R2 边界失配 | 沙箱目录传文件路径；裸名/CJS 绝对路径不校验解析结果 |
| R3 判定权让渡 | trustLevel/built-in 身份由插件清单与 cwd 探测决定 |
| R4 传输裸奔 | 无认证、全网卡、无 payload 上限 |
| R5 无并发模型 | 状态机缺转换守卫、pending 单键、timer 不受生命周期约束 |
| R6 契约无闭环 | SDK 允诺不验证实现、方法名无 SSOT、输入无校验、输出无限流 |

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**插件作者（正常 sandbox 插件）**：按 SDK 文档开发，`permissions` 声明与审批一致后所有 API 正常可用；`import 'node:fs'` 在设计期就得到明确错误 `Sandbox: import('node:fs') is blocked`（loader 拦截，当前此错误从未触发过）。

**恶意插件作者（攻击视角）**：伪冒 `params.pluginId` → 鉴权层按消息来源进程判定，返回 `PERMISSION_DENIED: plugin identity mismatch`；`sessionId='../../.ssh/key'` → `INVALID_SESSION_ID: sessionId must match /^[A-Za-z0-9._-]+$/'`；直连 `ws://<ip>:3210` → 连接建立后在 auth 握手阶段被关闭（1008 policy violation）；高频 notify → 超过每秒 20 条的部分被丢弃并记一次 warning 日志（含 pluginId，可排查）。

**用户**：快速开关插件（毫秒级连点）后插件状态与实际一致；插件崩溃 3 次内自动重建、重建成功且稳定 60s 后计数清零；退出应用无假崩溃 toast、无进程残留；插件在 `onDeactivate` 写的数据重开应用仍在。

### 3.2 根本方案：信任边界四原则

1. **身份由通道绑定**（治 R1）：RPC 消息的身份 = 宿主侧消息回调闭包捕获的 `workerId`，经 `workerId → { pluginId, trustLevel }` 映射解析；消息体内 `params.pluginId` 降级为纯显示字段，任何安全判定不得引用。
2. **边界由宿主定义**（治 R2/R3）：沙箱目录 = `dirname(pluginPath)` 由宿主计算注入；trustLevel 与 built-in 身份由**宿主的安装来源与显式配置**决定，manifest 声明仅对宿主内置插件有效。
3. **入口必经校验**（治 R4/R6）：传输入口有认证握手与 payload 上限；插件 API 入口有参数窄校验（类型 + 字符集 + 大小）；广播出口有限流与合并。
4. **生命周期是状态机**（治 R5）：所有异步转换有守卫（转换中拒绝反向操作）、所有 pending 请求有复合键、所有 timer 受 shutdown 约束并 unref、所有终止路径 pre-mark + 双向清理对称。

### 3.3 分域方案对比与决策

#### D1 鉴权身份（治 R1）——方案 A：通道反查 + 身份覆写

`PluginRpcServer.dispatch(workerId, message)` 已持有可靠来源身份（闭包捕获，不可伪造，`plugin-host.ts:486-492` 证实；processId 格式 `sandbox-${pluginId}` 天然一对一）。三层改造：

1. **鉴权**：`registerWorker` 时同步注册身份元数据 `{ trustLevel, pluginIds }`；`permissionCheck` 签名改为 `(identity, method)`——sandbox 消息按唯一 pluginId 查 granted，trusted worker 消息按 worker 级放行。
2. **身份覆写**：`dispatch` 在进入 handler 前**以 `identity.pluginId` 强制覆写 `params.pluginId`**。只改鉴权不改分区键是半吊子修复——sandbox 插件 a 持有 `storage.set` 授权后仍可伪冒 `pluginId:'statusline'` 把数据写进别人分区（storage/sessionData 分区键均取 `params.pluginId`）。覆写后消息体内 pluginId 从整条信任链（鉴权、分区、事件归属）彻底移除，降级为不可信的显示字段。
3. **权限词汇 SSOT**：SDK `PermissionConstants`（`plugin-sdk/src/types.ts:659`）是**能力词汇**（`storage.access`/`sessions.readState`/`notify` 等），不是方法名去前缀形——机械加前缀得 `plugin.storage.access`（不存在的方法）。归一化必须是显式的**「能力 → RPC 方法集」映射表**（如 `storage.access` → `plugin.storage.get/set/keys/delete/list` 全集），落在 shared 包单一模块，SDK 常量、manifest 声明、demo 插件 legacy 形态（`workspace:file:search`）三口径统一映射；`plugin-permission.ts:100-105` 从磁盘 load 旧持久化权限时同规则归一化（迁移）；配「能力 ↔ 方法」映射完整性测试防再漂移。

**信任模型澄清（重要边界）**：trusted 插件间（同 Worker 进程）互相不设防是**语义而非漏洞**——同进程 JS 对等体物理上无法隔离（api-freeze 的定位也是防误改非安全边界）。本设计的安全边界 = 「sandbox 进程 ↔ 宿主/trusted」之间。

- 被否 B（每插件独立 MessagePort 通道）：能精确到 trusted 内插件归属，但复杂度高（bootstrap 通道改造 + 双宿主差异），收益仅覆盖「不设防语义下本就不承诺」的场景。若用它，§2.1 的伪冒例子仍由 A 完整解决。
- 被否 C（消息签名）：插件与其 secret 同进程，签名可被插件自身读出重签，无安全增益。

#### D2 沙箱边界（治 R2）——dirname 修正 + 解析结果校验

四个子修：① `assignProcess` 注入 `dirname(pluginPath)`（宿主侧 `path.dirname`，一行修正 + wiring 级回归测试——现有测试全部绕过 activator 真实链路，必须补走真实链路的逃逸用例）；② ESM loader 裸名解析后校验 `resolved.url` 在沙箱内（npm dep 天然落在 `pluginDir/node_modules` 内；向上逃逸命中的沙箱外副本拒绝）；③ CJS 拦截器对 `/` 与 `file:` 前缀补边界检查（对齐 ESM loader 行为）；④ loader 与 CJS 拦截器的 `BLOCKED_BUILTINS` 常量收敛到单一来源文件（当前是内联复制，已漂移风险）。

- 被否（统一单拦截器，删 CJS 拦截器）：CJS 拦截器非死代码（sandbox load 即装，保护 ESM 插件内 `createRequire` 混用路径），删除会把该路径变裸奔；等插件生态明确 ESM-only 后再减法。

#### D3 信任级判定权（治 R3）——宿主强制覆盖

registry 层：`source === 'external'` 一律强制 `trustLevel = 'sandbox'`（无视 manifest）；`source === 'built-in'` 一律 `trusted`。built-in 目录不再 cwd 探测：Electron 主进程 spawn 时显式注入 `--builtin-plugins-dir <绝对路径>`（打包 = `process.resourcesPath/resources/plugins`，dev = repo 根 `resources/plugins`，主进程两侧都已知），runtime 缺该参数时回退 cwd 多形态探测并每次落 warning（fail-visible 而非 fail-open；仅限无主进程的 dev/test 形态，生产主进程恒显式传参——勘误 2026-08-18：原文写「跳过扫描」，实施保留 cwd 回退以维持 dev 直跑与 e2e 基线可用）。

- 被否（安装时「信任此插件」审批，允许 external trusted）：为未来需求引入交互与状态复杂度（违反「不加推测性功能」）；当前无任何 external trusted 需求，等真实需求再议。

#### D4 传输安全（治 R4）——loopback + token 首消息握手

**WS 消费方全集**（设计核实）：① Electron renderer（经 preload IPC）；② `packages/runtime/src/cli/ws-client.ts`（xyz-settings CLI，终端进程，无 IPC 通道）；③ `scripts/verify-plugin-e2e.sh`（E2E 编排）。token 必须三条通路都可获取，否则 CLI 与插件 E2E 基线直接挂掉。

方案：Electron 主进程 spawn runtime 时生成随机 32B token，**两个分发通道**——注入 `XYZ_RUNTIME_TOKEN` env（renderer 经 preload 新增 `getRuntimeToken` IPC 获取，与 `getRuntimePort` 同模式，落点 `bridge-handlers.ts`）；写入 `getDataDir()/runtime-token` 文件（**0600 权限**，CLI 与脚本读此文件）。WS 连接建立后首条消息必须是 `{type:'auth', payload:{token}}`（勘误 2026-08-18：原文写 `{type:'auth', token}`，实施为 payload 包裹形态），校验通过前不受理任何其他消息、10s 超时断开；失败以 1008 关闭。`listen(port, '127.0.0.1')` 显式绑回环。

**威胁模型声明（诚实边界）**：0600 token 文件对**同用户**本机进程可读——这是刻意接受的边界，因为同用户恶意进程对 renderer/runtime 的攻击面等价于用户自身（可 ptrace、可读 renderer 进程内存拿 token，任何分发方式都挡不住）。token 防的是：局域网任意机器（回环绑定 + token 双保险）、本机**其他用户**进程（0600）、无凭据的本机粗粒度扫描。G2 按此表述。

**maxPayload**：数值不拍脑袋——现有最大合法单条消息是贴图通路（`shared/src/protocol.ts:317` session.writeImage、`:334` message.send 的 base64 图片数组，原图经 base64 膨胀 4/3，原图 >3.7MB 即破 5MB 天真上限）。S1-W1 实施时先实测现有贴图消息大小分布，`maxPayload` 定为「实测 P99.9 × 2 与 16MB 取小」的配置常量，并加贴图回归验收（⛔ 实施期门）。勘误 2026-08-18：实施定值 `MAX_WS_PAYLOAD_BYTES = 16MB`——实测 P99.9 约 4-8MB，公式字面「取小」结果 8MB 未采用，取 16MB 作绝对上限（≈P99.9 × 2~4 倍余量）；单图 >12MB 原图 base64 化超限被传输层先拒，相对 IPC 层 20MB 单图上限属预期收紧。

- 被否 A（Unix domain socket）：Chromium renderer 的 `ws://` 不支持 UDS，renderer 侧物理不可行。
- 被否 B（仅绑 127.0.0.1 不加 token）：本机任意进程仍可直连（CLI 证明这条通路真实存在且发的是 config.* 全量设置命令），token 把可见性收窄到「持有 token 文件/env 的进程」。
- 被否 C（受限命令子集豁免 auth）：豁免面即攻击面，config.* 命令本身敏感，不做豁免分级。

#### D5 路径注入（治 R4 数据面）——入口校验 + 深度防御

API 入口统一 `assertSafeKey(name, value)`：`/^[A-Za-z0-9._-]+$/` 且长度 ≤128（sessionId、pluginId、storage key 的 scope 维度）；store 层 `join` 后再 `resolve` 校验结果仍在 baseDir 内（防上游漏网）。错误码 `INVALID_*_KEY` 带 regex 说明，可直接指导插件作者修正。

#### D6 生命周期并发模型（治 R5）

- **入口防御**：两宿主的消息回调统一 `safeDispatch`（非对象/null 消息落 warning 丢弃，回调 try/catch）；`index.ts` 加 `uncaughtException` 兜底（记日志 + 尝试优雅 shutdown，进程级最后防线）。
- **状态机守卫**：`deactivatePlugin` 对 ACTIVATING 态先置「取消标志」（activate 完成后立即反卷）或排队；DEACTIVATING 态重入激活的错配面由 pending 复合键 + 单通道 IPC FIFO 结构性消除（勘误 2026-08-18：原文要求 `activatePlugin` 补显式守卫，实施采用结构性方案——activate 消息天然排队于在飞 deactivate 之后，回复按复合键精确匹配，终态收敛为用户最后意图，显式守卫不再需要）；`onRebuilt` 只重激活当前状态为 CRASHED 的插件（用户已 disable/uninstall 的跳过）。
- **pending 复合键**：`pendingReplies` key 改 `${pluginId}:${op}`，`handleWorkerReply` 按 `(pluginId, replyType)` 精确匹配；超时 timer 随 entry 删除而 clear。
- **loadPlugin 过滤**：listener 比对 `m.pluginId === pluginId` 再 resolve/reject。
- **rebuild 受约束**：timer 保存引用 + `unref()`；关停时清全部 rebuild timer + `crashedTrustedWorkers`——落点为 `PluginService.shutdown()` **第一步**（`cancelPendingRebuilds()`；deactivateAll 可耗时数秒，等链末 `host.shutdown()` 才清理的话，等待窗口内冷却到期会复活插件，LC-C2 e2e 实测证明）；`rebuildWorker` 入口检查 disposed 标志。（勘误 2026-08-18：原文只写「`shutdown()` 清」未定落点，实施后收敛至关停链第一步。）
- **崩溃处理对称化**：`handleWorkerCrash` 补 `worker.terminate()`（对齐 process 版 kill 兜底）；`handleNotification` 单插件回调 try/catch（记日志，不升级为 Worker 崩溃）；exit code 0 也做 handle/索引清理（不报 crash）；crash 回调补 statusBar/tool/command 贡献清理；rebuild 成功且 60s 无新崩溃清零 crashCounts（「连续 3 次」语义修复）。
- **关停顺序**：`deactivateAll`（allSettled，单插件超时不阻塞）→ `sessionData.flushAll + dispose` → `storage.flushAll + dispose` → `host.shutdown()`；每步独立 catch（一步失败不跳过后续）。

#### D7 契约闭环（治 R6）

- **权限/方法名 SSOT**：`shared` 包新增 RPC 方法名常量 + permission 名映射模块（D1 已覆盖，此处指把 `plugin.command.execute` vs `plugin.commands.invoke` 类漂移用常量消灭）。
- **命令执行链修复**：Worker 侧 handler 统一为 `plugin.commands.invoke` 常量，补齐 runtime→Worker 发送段（`plugin-rpc-setup.ts:248` 标记的未实现段），端到端测试（注册→前端触发→插件 handler 收到→返回）。commandId 改复合键 `pluginId:commandId`（消费方唯一——`useExtensionHostBridge.ts:272-280`，迁移影响面可控；builtin 插件命令同步迁移——勘误 2026-08-18：实测 statusline 不注册动态命令，该项影响面为空）。返回值闭环终点为 runtime pending 层（`executeCommand` promise 的 resolve/reject）；WS `plugin.executeCommand` reply 保持既有 pong 契约不含返回值，前端消费场景待真实需求再议（对齐复核 2026-08-18 补注）。
- **SDK 死链路处置**：`sessions.onDidCreateSession/onDidDestroySession` **实现**——钩子挂 session-service 的全部创建入口（create/restoreSession/forkSession 三处收敛为一个内部 `notifySessionCreated`——勘误 2026-08-18：原文写「create/clone/fork/precreate 四条路径」，代码实际无独立 clone/precreate 方法）与销毁入口（deleteSession），主线程侧新建 registerCreate/registerDestroy 注册表（按 handlerId 记 workerId），事件发生时按注册表**定向投递**到对应 Worker（经 rpcServer.notify 通知形态——勘误 2026-08-18：原文写「复用 rpcServer.invoke 通道」，但 Worker 侧 session-api 以 onNotification 监听 didCreate/didDestroy，invoke 的 request/response 形态不匹配）；`events.on/emit` 插件间事件总线**显式降级**——SDK 从 `@stable` 移到 experimental 且调用即抛 `NOT_IMPLEMENTED`（带 issue 指引），等真实消费方再实现。注：`handleNotification` 的 Worker 内兜底（D6）因此不能随 events 降级而省略——sessions 通知走同一入口，无兜底则单插件回调 bug 仍连坐整 Worker。
- **输入校验层**：不引入 ajv（runtime 无该依赖，为窄校验引入打包依赖违反最小化；`noExternal` 纪律）。在 `plugin-service/api/` 入口统一手写窄校验工具（`asString`/`asSafeKey`/`asBoundedString`，对齐 core 侧 `message-bus-bridge` 既有模式），覆盖全部 40+ RPC 方法的 params。
- **限流与防毒化**：runtime 侧每插件令牌桶——notify 默认 20 条/s（依据：正常插件通知是用户动作触发型，20/s 已是失控水平的 10 倍量级；做成 shared 常量可调，S3-W4 实施时以现有 statusline 通知频率实测校准；`plugin.notify` 与 `plugin.ui.notify` 双入口共享同一桶实例合并计费——对齐复核 2026-08-18 补注，否则双入口合计 40/s 限流语义减半）、单条 message 8KB、statusbar 单条 text 4KB（D3 验收「1MB text 被拒」即依此规则）、statusbar 更新 100ms 合并窗口；前端 toast 在列 ≤5（超出丢弃计数）。数值全部为可配置常量并注明默认值理由，不写死在逻辑里。statusBar item 入口逐条校验（坏条目拒绝该条而非整包）；`error` 总线事件前端接 consumer（console + 可选 toast）。

### 3.4 决策汇总

| 域 | 决策 | 性质 | 被否方案 |
|----|------|------|---------|
| D1 鉴权 | workerId 通道反查 + params.pluginId 身份覆写 + 能力↔方法映射表 SSOT | 长期 | MessagePort 通道、消息签名、仅改鉴权不动分区键 |
| D2 沙箱 | dirname 修正 + 解析结果边界校验 + 黑名单 SSOT | 长期 | 删 CJS 拦截器 |
| D3 判定权 | external 强制 sandbox + `--builtin-plugins-dir` 显式注入 | 长期 | 安装时信任审批 |
| D4 传输 | loopback + token 首消息握手（env + 0600 文件双通道）+ maxPayload 实测校准 | 长期 | UDS、仅 loopback 无 token、受限命令豁免 |
| D5 注入 | 入口 assertSafeKey + store 层 resolve 深度防御 | 长期 | 仅深层校验（错误暴露晚） |
| D6 生命周期 | 状态机守卫 + pending 复合键 + timer 约束 + 关停顺序反转 | 长期 | 全局 shuttingDown 标志位（已被既有 terminated 范式否定的同族思路） |
| D7 契约 | 方法名常量 SSOT + 死链路分级处置 + 手写窄校验 + 令牌桶限流 | 长期 | 引 ajv、实现 events 总线、静默保留死链路 |

全部决策为长期方案：身份/边界/判定/校验归位到宿主层，不引入新技术债，三个月后回看无需推翻。

---

## 4. 验收（真实场景）

> 测试环境原则：沙箱与鉴权类场景必须走**真实 fork 子进程 + 真实 ESM loader + 真实 activator 链路**。现有基建已有 `scripts/verify-plugin-e2e.sh`（非 mock 端到端：隔离 runtime + 真实 sandbox fork + 真实权限审批）与 `plugin-host-sandbox-wiring.test.ts`（真实 fork wiring）——缺的是「真实 ESM loader 边界 + 恶意 fixture 插件」用例（恰恰是边界 0% 命中漏检的原因），S1-W3 以这两个既有基建为载体扩展，不重复造。遵循项目规则「本地实测优先」，插件系统验证在本地 runtime 直跑（vitest 集成层 + verify-plugin-e2e.sh + `pnpm dev` 手动场景）。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|--------|---------|
| A1 | 沙箱 import 拦截 | 构造 sandbox 测试插件（`import 'node:fs'`），走真实 activator 链路激活 | 激活失败，错误含 `Sandbox: import('node:fs') is blocked`；同插件 `import './sibling.js'` 成功 | G1 |
| A2 | 沙箱裸名/绝对路径逃逸 | 插件分别尝试 `import(<沙箱外存在的裸名包>)`、CJS `require('/tmp/evil.js')` | 两者均 `PERMISSION_DENIED` + 落插件错误日志 | G1 |
| A3 | 身份伪冒（含分区） | sandbox 测试插件**声明并获批** `storage.set` 权限后，在 RPC params 填 `pluginId: 'statusline'` 调 `plugin.storage.set` | 未授权方法伪冒 → `PERMISSION_DENIED`（identity mismatch，鉴权层拒）；已授权方法伪冒 → 放行但写入分区为通道覆写的自身 pluginId 而非 statusline（`getDataDir()` 下无 statusline 分区新文件）；statusline 自身调用不受影响（勘误 2026-08-18：原文前半句无条件要求鉴权层拒，与 D1 身份覆写语义自相矛盾——覆写后已授权伪冒按设计本就不拒） | G1 |
| A4 | 合规 sandbox 插件全通 | 声明 `permissions: ["storage.set"]` 的插件经审批后调全部已授权 API | 全部 200；未授权方法（如 `agent.setModel`）PERMISSION_DENIED | G1/G4 |
| A5 | 路径注入 | 插件传 `sessionId='../../evil'` 调 `plugin.sessionData.set` | `INVALID_SESSION_ID`；数据目录外无新文件 | G1 |
| B1 | WS 认证 | 本机进程无 token 直连 `ws://127.0.0.1:<port>` 发 `plugin.toggle`；xyz-settings CLI 带 token 文件正常执行 config 命令 | 无 token 连接在 auth 阶段被 1008 关闭；带 token 的 renderer 与 CLI 均正常（三方消费方全通） | G2 |
| B2 | 监听面 + 贴图回归 | `lsof -i :<port>` 检查监听；renderer 粘贴 5MB 截图发送 | 仅 127.0.0.1 绑定；贴图通路在 maxPayload 上限内正常收发（上限按实测基线校准后） | G2 |
| C1 | 并发开关 | `pnpm dev` 中对同一插件毫秒级连点开关 20 次 | 最终状态与点击序列一致；无 30s 挂起；Worker 内状态与宿主一致（重启后激活状态正确） | G3 |
| C2 | 崩溃后退出 | 插件 crash（触发 rebuild timer）后 2s 内退出应用 | 无「插件崩溃」toast；runtime 进程正常退出无残留（`ps` 验证）；无复活 | G3 |
| C3 | 单插件回调 bug | 测试插件在 `sessions.onDidCreateSession` 回调中抛异常，随后新建 session | 该插件记一次错误日志；同 Worker 其他插件不受影响、无 crash 计数（notification handler 兜底验证——`events.on` 已降级不可作载体） | G3 |
| C4 | 关停零丢失 | 插件 `onDeactivate` 内写 sessionData 后退出应用 | 重启后数据在 | G6 |
| D1 | SDK 死链路 | 插件调 `api.sessions.onDidCreateSession`；新建/删除 session | handler 触发且收到 sessionId；`api.events.emit` 抛 `NOT_IMPLEMENTED` 且 SDK 类型不再标 @stable | G4 |
| D2 | 命令执行 | 插件 `api.commands.register('x', h)` → 前端触发 | handler 收到调用并返回；另一插件无法覆盖/注销 `x`（复合键 + 归属校验） | G4/G5 |
| D3 | 风暴限流 | 插件 1s 内发 200 条 notify + 1 条 1MB statusbar text | runtime 侧超 20/s 的 notify 被丢弃（日志含 pluginId）、前端 toast 在列 ≤5、无卡顿；超大 statusbar 条目按单条 4KB 上限被拒并有日志（勘误 2026-08-18：原文「前端 toast ≤20/s 展示」口径失准——20/s 是 runtime 丢弃率，前端展示上限是在列 ≤5） | G5 |
| D4 | 毒化隔离 | 恶意插件发 `text: {}` 的 statusbar item | 仅该条被拒，statusline 等其他插件状态栏正常更新 | G5 |
| E1 | 全量回归 | `cd packages/runtime && npx vitest run`；`pnpm extensions:typecheck`；`bash scripts/verify-plugin-e2e.sh` | 全绿零回归（以实际输出为准） | 全部 |

---

## 5. 下一层拆分

### 实施顺序与依赖

三个方向（cw slice）文件集基本不相交，可并行；仅 D1（鉴权）与 D7（方法名 SSOT）共享 `plugin-permission`/`plugin-rpc-server` 接线点，先做 D1 的 SSOT 常量再并行。方向内按「防线从外到内」排序（先传输/身份，再边界/注入，再生命周期/契约）。

### Slice 1：security-trust-boundary（安全信任边界）

| Unit | 内容 | 主文件 |
|------|------|--------|
| S1-W1 | WS 认证握手 + 127.0.0.1 + maxPayload（D4，含 CLI/脚本 token 文件通路 + renderer authed 状态机 + 重连 token 刷新） | connection-manager.ts、renderer ws-client.ts、use-connection.ts、bridge-handlers.ts、preload.ts、process-control.ts、cli/ws-client.ts、verify-plugin-e2e.sh |
| S1-W2 | 鉴权通道反查 + 身份覆写 + 能力↔方法映射表 SSOT + 旧数据归一化（D1） | plugin-rpc-server.ts、plugin-permission.ts、plugin-permission-storage.ts、plugin-host(-process).ts、shared 新映射模块 |
| S1-W3 | 沙箱 dirname 修正 + 裸名/CJS 边界 + 黑名单 SSOT + 真实 loader 恶意 fixture 用例（D2，载体 = verify-plugin-e2e.sh 扩展 + sandbox-wiring 测试） | plugin-host-process.ts、plugin-esm-loader.cjs、plugin-sandbox.ts、verify-plugin-e2e.sh、fixtures |
| S1-W4 | external 强制 sandbox + `--builtin-plugins-dir` 注入（D3，连带 verify-plugin-e2e.sh 传参） | plugin-registry.ts、process-control.ts、runtime index.ts、verify-plugin-e2e.sh |
| S1-W5 | 路径注入校验（D5） | session-data-store.ts、plugin-storage.ts、api/*-api.ts |

### Slice 2：lifecycle-robustness（生命周期健壮性）

| Unit | 内容 | 主文件 |
|------|------|--------|
| S2-W1 | 消息入口 safeDispatch + uncaughtException 兜底（D6 前半） | plugin-host.ts、plugin-host-process.ts、index.ts |
| S2-W2 | 状态机守卫 + pendingReplies 复合键 + loadPlugin 过滤（D6 中） | plugin-activator.ts、plugin-host(-process).ts |
| S2-W3 | rebuild 约束（timer 引用/unref/shutdown 清理/onRebuilt 状态检查）+ crashCounts 衰减（D6 中） | plugin-host.ts、plugin-service.ts |
| S2-W4 | 崩溃对称化（fatal terminate、notification 兜底、exit-0 清理、贡献清理）+ 关停顺序反转（D6 后） | plugin-host.ts、plugin-bootstrap.ts、plugin-service.ts |

### Slice 3：api-contract-hardening（契约面加固）

| Unit | 内容 | 主文件 |
|------|------|--------|
| S3-W1 | 命令执行链修复 + 复合键 + 方法名常量化收尾（D7） | commands-api.ts、plugin-service.ts、plugin-rpc-setup.ts、useExtensionHostBridge.ts、statusline |
| S3-W2 | SDK 死链路处置（sessions 事件实现：四创建入口收敛 + 定向投递注册表；events 降级报错）（D7） | session-api.ts、session-service.ts、plugin-sdk/src/types.ts、plugin-bootstrap.ts |
| S3-W3 | api 入口窄校验层（全 40+ 方法）（D7） | plugin-service/api/*.ts、shared 校验工具 |
| S3-W4 | 限流（notify/statusbar 令牌桶 + 合并）+ 前端 toast 上限 + error 事件消费（D7） | notify-api.ts、plugin-rpc-setup.ts、status-bar-registry.ts、notification-host-controller.ts、useToast.ts |

### cw 树结构

```
feature:plugin-trust-hardening
  ├─ slice:security-trust-boundary   → 5 waves
  ├─ slice:lifecycle-robustness      → 4 waves
  └─ slice:api-contract-hardening    → 4 waves
```

### 待验证检查点（实施期门，设计阶段诚实标注）

- ⛔ maxPayload 上限与现有贴图通路（session.writeImage / message.send images）的实测分布校准——S1-W1 实施时先测后定
- ⛔ token 握手与 renderer 重连逻辑的交互（bridge-reconnect 机制需实测多轮断连重连 + runtime 重启后 token 刷新）——S1-W1 实施时验证
- ⛔ `plugin.command.execute` 链路打通后前端 CommandPopover 是否有动态命令消费场景（当前唯一消费方是 commandExecutor）——S3-W1 实施时确认
- ⛔ statusline（唯一 builtin 插件）在 external-强制-sandbox 与 builtin-trusted 规则下的回归——S1-W4 验收必含
- ⛔ 存量 external 插件影响：`EXTERNAL_PLUGIN_ENABLED` 于 2026-08 才翻 true，当前无已知安装面（无 external 插件分发渠道与用户），强制降级 sandbox 的影响集判定为空；若实施时发现存量自报 trusted 的 external 插件，行为变化（首次权限审批 + import node:* 激活失败）属预期安全收紧，在 release notes 说明——S1-W4 实施时复核
- ⛔ CJS `createRequire` 混用路径的真实插件存在性——S1-W3 保留拦截器但加监控日志，若 3 个月内无命中再减法删除

---

## 勘误记录（2026-08-18，实施后回写；1-3 实施期发现，4-6 实施后设计-代码对齐复审发现）

实施与对齐复审发现的设计原文失准，已就地修正并在此汇总（1-3 见 exec-review.md §5 偏差裁决；4-6 见 exec-review.md §8 对齐复审）：

1. §3.3 D6「rebuild 受约束」：rebuild timer 清理落点明确为 `PluginService.shutdown()` 第一步（原文未定落点；链末清理在 deactivateAll 等待窗口内会放行冷却到期复活，LC-C2 e2e 实测）。
2. §3.3 D7「命令执行链」：builtin 插件命令迁移影响面为空（statusline 不注册动态命令，实测 grep 证实）。
3. §3.3 D7「SDK 死链路」：创建入口为 create/restoreSession/forkSession 三处（原文写四条路径，代码无独立 clone/precreate 方法）；定向投递经 rpcServer.notify 通知形态（原文写 invoke 通道，Worker 侧 onNotification 契约决定形态）。
4. §3.3 D3「缺参时 built-in 扫描跳过」：实施为回退 cwd 多形态探测 + 每次落 warning——完全跳过会废掉无主进程形态（dev 直跑、verify 脚本）的 e2e 基线；生产主进程恒显式传参，注入面收敛到显式注入路径。
5. §3.3 D6「activatePlugin 补 DEACTIVATING 态守卫」：由 pending 复合键 + 单通道 IPC FIFO 结构性达成——DEACTIVATING 态重入激活时 activate 消息排队于在飞 deactivate 之后，回复按 `${pluginId}:${op}` 复合键精确匹配，终态收敛为用户最后意图（ACTIVE），无回复错配面；显式守卫不再需要（lifecycle-races.test.ts 固化该语义）。
6. 传输 listen 失败路径（原文无条款覆盖）：EADDRINUSE 等 listen 错误在传输层 reject（错误信息含端口排查指引），进程退出决策归组合根 `index.ts`（捕获 → 可操作日志 + exit(1) fail-fast）；测试基建补 `test/helpers/free-port.ts` 重试 helper，消除 getFreePort 的 TOCTOU 端口竞态。
