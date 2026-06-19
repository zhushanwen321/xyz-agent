# Runtime 三层迁移执行记录

**日期**: 2026-06-19 · **分支**: refactor-architecture-design
**关联设计**: [runtime-three-layer-design.md](runtime-three-layer-design.md)（方案 C：端口-适配器）
**状态**: R0–R7 已完成（三层迁移 + 例外清理完结，services 零 infra）

---

## 阅读指引

本文档记录三层迁移的**实际执行过程**——每个阶段做了什么、审查中的关键决策、当前架构状态、待办。
设计原理（为什么三层、为什么不选 Clean Architecture）见 [runtime-three-layer-design.md](runtime-three-layer-design.md)。

---

## 阶段总览

| 阶段 | commit | 状态 | 核心产出 |
|------|--------|------|---------|
| R0 | `26049b9d` | ✅ | 设计文档 + design.md §D4 supersede 标注 |
| R1 | `ea657843` | ✅ | Pi* 协议类型迁入 infra/pi/pi-protocol.ts |
| R2 | `a9058b63` | ✅ | adapters/ 合并入 infra/，消除 infra→adapters 反向依赖 |
| R3a | `ec5912f8` | ✅ | ports.ts 骨架 + IConfigStore 试点（config-service）|
| R3b | `40487dfa` | ✅ | IPiEngine/IPiProcess + 解耦 services 与 rpc-client |
| R3c1 | `51f95aef` | ✅ | IModelSource + 抽 fetch（model-service）|
| R3c2 | `738958ea` | ✅ | IInstaller/IExtensionResolver（extension-service）|
| R3d | `efe19d0f` | ✅ | convertPiHistory unknown[] + PiHistoryMessage 清除 |
| R3e1 | `0e25e194` | ✅ | ISessionStore + session 家族解耦 |
| R3e2 | `e8b1a7ed` | ✅ | ITreeReader/INavigateInterceptor + tree/session 解耦 |
| R4 | `a9780d16` | ✅ | handler 构造移入 setServices()，消除 `as unknown as` 强转 |
| R5 | `a3ab22bd` | ✅ | 收尾验证 + 消除 transport→infra 最后依赖（getPiAgentDir） |
| R6 | `4b4bf3dd` | ✅ | scanners 归位 services + atomicWrite 移 utils（例外 2）|
| R7 | `00541fb4` | ✅ | plugin-service configDir 注入（例外 1）|

**R3 实际拆成 7 个子阶段**（原设计是单一 R3）。审查发现「让所有 service 一次上 ports」是大爆炸式重构，违反单一目标原则，故按 service 域逐个解耦。

---

## R0 · 文档与认知（0 代码风险）✅

- 新增 [runtime-three-layer-design.md](runtime-three-layer-design.md)（方案 C 决策 + 目标架构 + ports 清单 + 归位表）
- design.md 顶部 + §D4 标 supersede，指向新设计
- architecture.md 入口加链接

## R1 · PiXxx 类型收敛（机械）✅

**做了什么**：`types.ts`(444行) 的全部 Pi* 协议类型迁入 `infra/pi/pi-protocol.ts`(330行)。types.ts 只留内部类型（TreeNode/TreeData/NavigateResult/ForkResult）。

**关键修正**：`PiBaseMessage` 补 export（审查发现协议文件的 base 类型应可被消费者 extends）。

## R2 · adapters/infra 合并 + 目录归位（机械）✅

**做了什么**：adapters/ 目录消失，8 文件 git mv 进 infra/pi/；infra/ 重组织为 pi/installers/scanners/system 子目录。

**审查关键发现**：纯 git mv 消除不了 infra→adapters 反向依赖。rpc-client/extension-resolver 改直连源文件（pi-paths/pi-provider-store），同一 commit 内做掉。50+ 处 import 路径修正（含 19 个测试）。

## R3 · ports 依赖倒置（核心，拆 7 子阶段）✅

### R3a · ports 骨架 + IConfigStore 试点 ✅

- 新建 `services/ports.ts`，定义 IConfigStore
- `mapTypeToApi`（pi 协议翻译）从 config-service 迁入 infra（pi-config-store）
- config-service 构造注入 IConfigStore，13 处 `piBridge.*` → `this.configStore.*`

### R3b · IPiEngine/IPiProcess ✅

**审查关键发现**：原计划假设 PiMessage 是事件流类型，要定义 PiTranslatedEvent 重写翻译。**实测证伪**——PiMessage 是 sendCommand 的逃生类型（任意动态 JSON 响应），event-adapter **早已是真翻译层**（输出 ServerMessage，不导出 pi 事件类型）。R3b 因此缩小为「解耦 RpcClient 具体类 + 重定位逃生类型」。

- RpcClient implements IPiEngine；ProcessManager.getClient 返回 IPiEngine
- services 不再 import pi/rpc-client

### R3c1 · IModelSource ✅
- discoverFromApi 的 fetch 从 model-service 抽出，迁入 infra（ModelApiDiscoverer）

### R3c2 · IInstaller/IExtensionResolver ✅
- npm install/uninstall/installDeps + git clone 经 IInstaller port
- ExtensionResolver 经 IExtensionResolver port
- extension-service 不再 import npm-installer/child_process

### R3d · convertPiHistory unknown[] ✅
- convertPiHistory 签名改 unknown[]，pi 历史类型断言内化到 converter
- services 不再 import PiHistoryMessage

### R3e1 · ISessionStore ✅
- scanPiSessions/refreshAll/persistSessionName/ensureSessionFile/patchSessionCwd/convertHistory/trash 聚合为 ISessionStore
- session 全家（service/lifecycle/scanner/history）经 port 访问

### R3e2 · ITreeReader/INavigateInterceptor ✅
- buildTreeFromFile/countBranches/extractFullText 经 ITreeReader port
- NavigateInterceptor 经 INavigateInterceptorFactory 工厂创建（不再 new 具体类）
- tree-service/session-service 不再 import navigate-interceptor/session-tree-reader

---

## 当前 ports 清单（services/ports.ts）

| port | 职责 | infra 实现 |
|------|------|-----------|
| IConfigStore | Provider/Skill/Agent CRUD + 默认模型 + 配置目录 + type→api 翻译 | PiConfigStore |
| ISessionStore | session 发现/扫描/持久化 + 历史翻译 + trash | PiSessionStore |
| IPiEngine | pi 引擎交互（prompt/abort/steer/sendCommand/onEvent）| RpcClient |
| IPiProcess | session↔pi 进程绑定（createSession/destroy/getClient）| ProcessManager |
| IModelSource | LLM API 模型发现（HTTP /v1/models）| ModelApiDiscoverer |
| IInstaller | npm install/uninstall/deps + git clone | NpmGitInstaller |
| IExtensionResolver | extension 路径发现 + 校验 | ExtensionResolver |
| ITreeReader | pi JSONL 树解析（buildTree/countBranches/extractFullText）| SessionTreeReaderAdapter |
| INavigateInterceptorFactory | navigate 拦截器工厂 | NavigateInterceptorFactory |

辅助类型：PiMessage(=unknown, 逃生类型)、PiEventListener、ScannedSessionMeta、ConfigProviderConfig、BuildTreeResult 等。

---

## 当前架构状态

```
transport/  → services（经 IService 接口）
services/   → ports（9 个 port 接口）
infra/      → 实现 ports（9 个实现类）
```

**依赖方向**：`transport → services ← infra`，services 定义 ports，infra 实现 ports，无环。

### 最终验证（R3 完成时）

- `services/` 零 infra 直接 import（`rg "from '.*infra/" services/` 排除例外后为空）
- `Pi*` 类型不在 services（收敛到 infra/pi/）
- tsc 0 / eslint 0 / build:runtime ✓ (index.cjs 777KB) / vitest 658/658, 53/53

### ~~2 个有意保留的例外~~（已在 R6/R7 消除）

R5 时保留、R6/R7 已清零：
1. ~~**plugin-service getConfigDir ×6**~~ — R7 经 configDir 注入消除（design.md T5 切片自治，路径走组合根）
2. ~~**config-service scanners**~~ — R6 归位：atomicWrite→utils/fs-utils（跨层共享），skill/agent-scanner→services/scanners（纯 fs，非外部系统连接器，违反 T4 铁律故移出 infra）

---

## R4 · transport 清理 ✅

### R4a · handler 构造时序修正 ✅

**问题**：`server.ts` 的 6 个 handler 在字段初始化期构造，用了 `this as unknown as XxxHandlerContext` 双重断言。

**审查根因**：双重断言不只是时序问题——TS 在跨类边界不暴露 `private` 成员，`RuntimeServer` 的 `nextPushId`/`broadcastSessionList` 等是 private，结构上不满足 context 接口，所以被迫用 `as unknown as`（TS 版 `any`）。

**修复**：handler 字段改 `!` 确定赋值断言，构造挪到 `setServices()` 末尾。每个 handler 收到**显式 context 对象字面量**，在调用点结构化校验，不再依赖跨类可见性。`bridgeHandler` 也从初始化器（`new BridgeHandler(null)`）挪入 setServices，统一时序。

**不变量验证**：所有 6 个测试文件 + index.ts 都是 `new → setServices() → start()` 序列，消息只在 `start()` 后流动，所以 setServices 内构造 handler 是安全的（handleConnection/handleMessage 不会在 setServices 前触发）。

### R4b · switch→map 路由（有意不做）

37-case switch 改声明式 map 是纯风格切换——不改依赖方向、不改可测试性、不改性能。在 Ponytail/YAGNI 下保持 switch。该改动属"引诱性重构"（看起来更现代但无架构收益），列为有意跳过。

---

## R5 · 收尾验证 ✅

### R5 审查：计划判据修正

跑真实 rg 后发现原 R5 计划判据有两个缺陷，先修正再验证：

**缺陷 1 — Pi* 搜索词过宽**：`rg "Pi[A-Z]" services/` 会命中 `PiMessage`/`IPiEngine`/`PiEventListener`/`scanPiSessions` 等合法条目（ports.ts 有意定义的端口契约、plugin-service 的扩展协议回调）。"Pi* 应空"判据本身错误。**修正**：目标精确化为「services/transport 不 import `pi-protocol.ts`（类型源头），也不出现 pi 内部协议**类型**（PiProviderConfig/PiModelDefinition/PiHistoryMessage）」。端口接口名（IPiEngine/PiMessage）是契约，保留。

**缺陷 2 — 遗漏 transport→infra 的真实泄漏**：原计划只查 services，但 `transport/server.ts` 直接 import `getPiAgentDir`（file.read handler 用）——transport 应只依赖 services。这是 R3 覆盖 config-service 时漏掉的 transport 侧。**修复**：`IConfigService.getPiAgentDir()`（IConfigStore 已有同名方法），server.ts 经 configService 访问。

### R5 验证结果（修正判据后，R6/R7 前的快照）

```
[A] transport/ → infra 直接 import        → ✓ EMPTY（零依赖）
[B] services/ → infra 直接 import          → 2 组已记录例外（plugin 6×getConfigDir 黑盒
                                              + config-service 3×scanners 通用 fs），无新增
[C] services/transport → pi-protocol.ts   → ✓ EMPTY
[D] services 内 pi 协议类型               → ✓ 仅注释/文档字符串命中，无真实类型使用
```

> 注：[B] 的 2 组例外在 R6/R7 已清零，见下文「最终验证」。

全量回归：tsc 0 / eslint 0 / tsup build (779KB) / vitest 658/658（53 files）全绿。

---

## R6 · scanners 归位（例外 2）✅

**审查关键发现**：scanners 不是整体跨层——只有 `atomicWrite` 真跨层（infra 2 处 + services 1 处），skill/agent-scanner 只被 config-service 用。且 scanners 是纯 fs 实现（读 SKILL.md/agents），非外部系统连接器，放 infra 违反 design.md **T4 铁律**。

**修复（合并为 1 commit，避免中间态）**：
- `atomicWrite` → `utils/fs-utils.ts`（ADR 0004 第 46 行预先授权）。`utils/` 成为合法跨层共享叶子层（零业务语义，infra+services 都可 import）。
- `skill-scanner`/`agent-scanner` + `expandHome`/`inferSourceType` → `services/scanners/`（纯 fs，只被 config-service 引用，归 services 域）。
- 不上 port：atomicWrite 是纯无状态函数、scanner 是纯 fs，套 IPort 是过度工程。

**判据**：config-service 零 infra import。例外 2 消除。

## R7 · plugin-service configDir 注入（例外 1）✅

**架构定调**：design.md **T5** — plugin-service 是自治纵向切片。6 处 `getConfigDir()` 全是拿配置根路径（plugins/session-data 目录），非 pi 协议。注入路径，不套 port。

**注入链**：`IConfigService.getConfigDir()`（委托 IConfigStore，同 R5 getPiAgentDir 先例）→ index.ts 注入 → PluginRegistry(第 2 构造参数) + PluginService.deps.configDir → 向下传 installer/registry/permission/session-data-store。flush 3 个模块函数加 configDir 参数。

**不上 port 的理由**：这是路径注入，不是控制反转——plugin-service 只是少了一个 infra 直连，引入 IPluginConfigStore port 是给路径解析套接口，违背 Ponytail。

**判据**：plugin-service 零 infra import。例外 1 消除。

---

## 最终验证（R7 后）

```
services/  → infra 直接 import   → ✓ FULLY CLEAN（零依赖，无任何例外）
transport/ → infra 直接 import   → ✓ EMPTY
utils/     → 跨层共享叶子层       → atomicWrite（infra + services 共用，无业务语义）
```

全量回归：tsc 0 / eslint 0 / tsup build (781KB) / vitest 657/657（53 files，-1 删除的 obsolete default 测试）。

---

## 迁移完结

三层架构（transport → services ← infra）落地完成，**services 零 infra 直接依赖**（含原 2 个例外均已消除）。R0–R7 共 15 个 commit，每阶段审计→修复→执行循环，审查产出（R2 反向依赖、R3b PiMessage 误判、R5 判据修正、R6 scanner 非整体跨层）均被采纳并修正了原计划。

**utils/ 共享层定位**（R6 确立）：`utils/` 是所有业务层之下的共享叶子层，存放零业务语义的纯工具（fs-utils/path-utils）。infra 和 services 都可 import，但 utils 不依赖任何业务层。这是三层架构的第四个层——不是业务层，是所有业务层的公共底座。

**两个例外为何能消除而非保留**（对照 user-memory「重构走长期方案」）：
- 例外 1 原标"黑盒豁免"——实际是 R3 未覆盖 plugin-service 的遗漏，T5 自治不等于可以 infra 直连，configDir 注入是长期正解。
- 例外 2 原标"移出超范围"——实际是 scanner 放错层（违反 T4），归位 services 域是长期正解，atomicWrite 归位 utils 共享层。

