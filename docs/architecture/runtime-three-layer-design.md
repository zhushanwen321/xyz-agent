# Runtime 三层架构设计（方案 C：端口-适配器）

**版本**: 1.0 · **日期**: 2026-06-18 · **分支**: refactor-architecture-design
**取代**: [design.md §D4](design.md) 的「transport/services/adapters/infra 四层」中 runtime 部分
**适用范围**: `src-electron/runtime/`（Main 进程不在本次范围）
**plugin-service**: 暂不动（已自洽，作为黑盒保留在 services/）

---

## 阅读指引

- **第一部分**：决策——为什么从四层改为三层
- **第二部分**：目标架构图 + 三层职责边界
- **第三部分**：ports 接口清单（依赖倒置的载体）
- **第四部分**：现有 67 文件逐个归位表
- **第五部分**：迁移步骤（分阶段，低风险优先）

---

# 第一部分 · 决策

## 为什么放弃四层（D4 的 transport/services/adapters/infra）

D4 的本意是区分「怎么连外部系统」(infra) 与「怎么翻译外部格式」(adapters)。概念上正确，但实证暴露 3 个问题：

| 问题 | 证据 |
|------|------|
| **adapters 名存实亡** | `pi-config-bridge.ts` 是 pi 模块的聚合 re-export（转发 `PiProviderConfig`/`readModels` 等原始 pi 类型与 CRUD），不是翻译层。`config-service` 自己写 `mapTypeToApi`（pi 格式映射），翻译职责漏到 service |
| **PiXxx 类型四处泄漏** | `types.ts`(444行) 全是 `Pi*` 类型却放根级；`config-service`/`tree-service`/`session-service` 都直接吃 `PiMessage`/`PiModelDefinition`/`PiHistoryMessage` |
| **infra 反依赖 adapters** | `infra/rpc-client.ts` import `adapters/pi-config-bridge`（infra→adapters 反向），四层声称的单向依赖 `adapters→infra` 不成立 |

**根因**：pi 的「路径配置」与「协议传输」被切到不同层（adapters vs infra），但后者需要前者，于是 adapters 退化成「公共工具层」，翻译职责落空。

## 为什么不选 Clean Architecture（领域中心 + 依赖倒置）

实证 runtime 的**领域逻辑非常薄**——它是 pi 引擎的 Node.js 宿主 + 协议适配层，真正 AI 业务规则在 pi 进程内部。逐项核查：

| 代码 | 性质 | 是独立领域吗 |
|------|------|-------------|
| `mapTypeToApi`（anthropic→anthropic-messages） | pi 格式映射 | ❌ 翻译，非规则 |
| provider/skill/agent CRUD | 纯转发 pi 的 models.json | ❌ CRUD 代理 |
| `ALLOWED_GIT_PREFIXES`（只允许 https/ssh/git@） | infra 输入校验 | ❌ infra 职责 |
| `ensureActive` + `restoringSessions` 去重 | 并发防护 | 🟡 编排不变量 |
| `isGenerating` 状态机 / `rebindAfterFork` | session 生命周期 | 🟡 编排不变量 |

强行做 domain/ 层，里面只有几个薄状态机，会退化成「把 service 方法签名抄一遍」的空壳。Clean Architecture 的收益（领域独立可测、不被 infra 污染）在领域本身贫乏时兑现不了。

## 决策：方案 C —— 三层 + ports 依赖倒置

采纳 Clean Architecture 的精髓（**依赖倒置 + 内部不被外部格式污染**），但去掉空的领域层：

```
transport/  ← 协议入口
services/   ← 业务编排（定义 ports，依赖接口）
infra/      ← pi 适配（实现 ports，连接 + 翻译合并）
```

**C 解决四层的全部 3 个问题**：
1. ❌ adapters/infra 边界模糊 → **合并，不存在模糊**
2. ❌ PiXxx 泄漏 service → **ports 接口用内部类型签名**，service 摸不到 PiXxx
3. ❌ infra 反依赖 adapters → **没有 adapters，infra 是最底层**

**保留 D4 的有效部分**：transport 纯路由、services 按域切、session 已拆分（lifecycle/dispatcher/scanner）、plugin-service 自治切片——这些全部保留。

---

# 第二部分 · 目标架构

## 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    RUNTIME (Node.js 子进程)                           │
│              entry: index.ts (组合根：DI 接线 + 信号)                  │
└─────────────────────────────────────────────────────────────────────┘
      ▲
      │ WebSocket: ClientMessage(56) → ← ServerMessage(~70)
      │
 ═════╪══════════════════════════════════════════════════════════════════
      │
      │  ┌───────────────── ① transport/ 协议入口 ──────────────────┐
      │  │  server.ts        HTTP /health + WS accept + 心跳 + 广播   │
      │  │  router.ts        type → handler 声明式 map（T1 落地）     │
      │  │  handlers/*.ts    参数提取 → 调 service → 组装响应          │
      │  └────────────────────────┬────────────────────────────────┘
      │                           │ 调 IService 方法 / 经 IBroker 回推
      │  ┌────────────────────────┴────────────────────────────────┐
      │  │                ② services/ 业务编排                       │
      │  │                                                          │
      │  │  ports.ts  ★ 依赖倒置载体（service 定义的「我需要什么」）  │
      │  │     IPiEngine    prompt/abort/steer/getHistory/compact    │
      │  │     IPiProcess   createSession/destroy/绑定               │
      │  │     IConfigStore Provider/Skill/Agent 的 CRUD（内部类型）  │
      │  │     IModelSource 模型聚合 + API 发现                      │
      │  │     IPiEvents    pi 事件订阅（返回内部事件，非 PiEvent）   │
      │  │     IInstaller   npm/git 安装                             │
      │  │     IBroker      WS 广播（已有，保留）                     │
      │  │                                                          │
      │  │  session/        config        model         tree          │
      │  │  ├ lifecycle     (Provider/    (聚合 +       (navigate     │
      │  │  ├ dispatcher     Skill/        IModelSource  树编排)       │
      │  │  └ scanner        Agent CRUD)   发现)                      │
      │  │  (会话+对话，      ──── 全部只依赖 ports 接口 ────)         │
      │  │                                                          │
      │  │  plugin-service/  ← 黑盒保留（已自洽，经 IPluginService）  │
      │  └────────────────────────┬────────────────────────────────┘
      │                           │ 只依赖 ports 接口 + 内部类型
      │  ┌────────────────────────┴────────────────────────────────┐
      │  │            ③ infra/ pi 适配（连接 + 翻译合并）             │
      │  │                                                          │
      │  │  ★ 唯一出现 PiXxx 类型的层；对上只暴露内部类型              │
      │  │                                                          │
      │  │  pi/                                                     │
      │  │  ├ pi-client.ts     spawn('pi') + stdin/stdout JSONL     │
      │  │  │                   实现 IPiEngine + IPiEvents           │
      │  │  ├ process-pool.ts  session→pi 绑定，实现 IPiProcess      │
      │  │  ├ pi-config.ts     models.json CRUD + Provider↔Pi 翻译   │
      │  │  │                   实现 IConfigStore                    │
      │  │  ├ pi-events.ts     pi 事件→内部事件，实现 IPiEvents 翻译 │
      │  │  ├ pi-history.ts    pi JSONL 历史→Message[] 翻译          │
      │  │  ├ pi-tree.ts       pi JSONL 树→树模型翻译                │
      │  │  ├ pi-paths.ts      pi/xyz-agent 路径解析（独立，无反依赖）│
      │  │  └ pi-protocol.ts   Pi* 协议类型（仅 infra 内部可见）      │
      │  │  installers/                                            │
      │  │  ├ npm-installer.ts registry HTTPS，实现 IInstaller       │
      │  │  ├ git-installer.ts  execFile('git', clone)              │
      │  │  └ extension-resolver.ts 扩展路径解析                     │
      │  │  scanners/                                             │
      │  │  ├ scanner-base.ts  skill/agent 扫描基类                  │
      │  │  ├ skill-scanner.ts                                    │
      │  │  └ agent-scanner.ts                                    │
      │  │  system/                                               │
      │  │  ├ git-info.ts     git 分支查询（带缓存）                 │
      │  │  └ trash.ts        废纸篓删除                            │
      │  └──────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────┐  ┌──────────────┐  ┌───────────────────┐
│ pi 子进程 ×N  │  │  文件系统      │  │  外部网络            │
│ (AI 引擎)    │  │ ~/.pi/       │  │ LLM API · npmjs    │
│              │  │ ~/.xyz-agent/│  │ · git              │
└──────────────┘  └──────────────┘  └───────────────────┘
```

## 三层边界规则

| 层 | 可依赖 | 禁止 | 核心约束 |
|----|--------|------|---------|
| **transport** | services(接口) + shared | 不碰 node: 内置；不做业务决策 | 纯路由：参数提取→调 service→组装响应 |
| **services** | ports(自己定义的接口) + shared + 内部类型 | **不 import infra**；**不出现 PiXxx 类型** | 业务编排，经 ports 访问外部能力 |
| **infra** | 外部系统 + node: 内置 + shared | 不知道 WS 协议；不知道 session 业务语义 | 实现 ports；**PiXxx 类型仅在此层内部** |

**依赖方向**：`transport → services ← infra`（services 定义 ports，infra 实现 ports，箭头都指向接口）。**无环**。

---

# 第三部分 · ports 接口清单

ports 是依赖倒置的载体：services 定义「我需要什么能力」，infra 实现。接口签名**只用内部类型或 shared 类型**，绝不出现 PiXxx。

> 现有 `interfaces.ts` 已有部分接口（ISessionService/IConfigService 等），但它们是 service 对 transport 暴露的。ports 是反方向的——service 对 infra 要求的能力契约。两者并存，不冲突。

```ts
// services/ports.ts —— service 层定义、infra 层实现的依赖倒置接口

/** pi 引擎交互（每个 session 一个实例） */
export interface IPiEngine {
  prompt(content: string): Promise<void>
  abort(): Promise<void>
  steer(content: string): Promise<void>
  followUp(content: string): Promise<void>
  compact(): Promise<void>
  setModel(provider: string, modelId: string): Promise<void>
  setThinkingLevel(level: string): Promise<void>
  getHistory(): Promise<Message[]>              // ← 返回内部 Message，非 PiMessage
  getCommands(): Promise<Command[]>             // ← 返回内部 Command
}

/** pi 进程池（session↔pi 绑定） */
export interface IPiProcess {
  createSession(sessionId: string, cwd: string, opts: SessionOptions): Promise<IPiEngine & IPiEventSource>
  destroySession(sessionId: string): Promise<void>
  getClient(sessionId: string): (IPiEngine & IPiEventSource) | undefined
  hasClient(sessionId: string): boolean
  onExit(cb: (sessionId: string, code: number | null) => void): void
}

/** pi 事件流（翻译后内部事件） */
export interface IPiEventSource {
  onEvent(listener: (event: PiTranslatedEvent) => void): () => void  // ← 内部事件类型
}

/** 配置存储（Provider/Skill/Agent CRUD，内部类型） */
export interface IConfigStore {
  listProviders(): ProviderInfo[]
  upsertProvider(id: string, data: ProviderInput): ProviderResult
  deleteProvider(id: string): ProviderResult
  getDefaultModel(): ModelRef | null
  setDefaultModel(ref: ModelRef): void
  loadSkills(root: string): SkillInfo[]
  saveSkills(root: string, skills: SkillInfo[]): void
  loadAgents(root: string): AgentInfo[]
  // ... Agent/Skill CRUD
}

/** 模型发现（HTTP 探测 + 聚合） */
export interface IModelSource {
  aggregateModels(providers: ProviderInfo[]): ModelInfo[]
  discoverFromApi(baseUrl: string, apiKey?: string, type?: string): Promise<ModelMeta[]>
}

/** 安装器（npm/git） */
export interface IInstaller {
  installNpm(spec: string): Promise<InstallResult>
  installGit(url: string): Promise<InstallResult>
}
```

**内部事件类型**（`PiTranslatedEvent`，取代泄漏的 `PiMessage`）：在 `services/types.ts` 定义，由 `infra/pi-events.ts` 从 pi 原始事件翻译而来。这是「断开 PiXxx 泄漏」的关键——service 只见翻译后的内部事件。

---

# 第四部分 · 现有文件归位表

逐文件标注 `[层] 子目录/动作`。`git mv` = 纯移动；`重构` = 需改逻辑/加翻译。

## adapters/（8 文件，全部消失——拆入 infra）

| 文件 | 行 | 性质 | 归位 |
|------|----|----|------|
| event-adapter.ts | 511 | 真翻译（pi事件→ServerMessage） | `[infra/pi/] pi-events.ts` 重构：翻译为内部事件（PiTranslatedEvent），实现 IPiEvents |
| message-converter.ts | 129 | 真翻译（pi历史→Message[]） | `[infra/pi/] pi-history.ts` 重构：实现 history 翻译 |
| session-tree-reader.ts | 299 | 真翻译（pi JSONL树→树模型） | `[infra/pi/] pi-tree.ts` 重构 |
| navigate-interceptor.ts | 76 | pi 扩展消息拦截 | `[infra/pi/] navigate-interceptor.ts` git mv |
| pi-config-bridge.ts | 182 | re-export 杂物间 | **拆解**：路径→`pi-paths.ts`；re-export 的 CRUD→`pi-config.ts`；re-export 的类型→废弃 |
| pi-provider-store.ts | 461 | pi 的 models.json CRUD（原始 pi 类型） | `[infra/pi/] pi-config.ts` 重构：CRUD 保留，翻译 Provider↔PiProviderConfig |
| pi-paths.ts | 50 | 路径解析 | `[infra/pi/] pi-paths.ts` git mv |
| session-file-utils.ts | 185 | session 文件操作 | `[infra/pi/] session-files.ts` git mv |

## infra/（8 文件 → infra/ 重组织）

| 文件 | 行 | 性质 | 归位 |
|------|----|----|------|
| rpc-client.ts | 388 | pi 子进程 stdin/stdout | `[infra/pi/] pi-client.ts` 重构：实现 IPiEngine，去 PiMessage export |
| process-manager.ts | 267 | session→pi 绑定 | `[infra/pi/] process-pool.ts` 重构：实现 IPiProcess |
| npm-installer.ts | 460 | registry HTTPS | `[infra/installers/] npm-installer.ts` git mv，实现 IInstaller |
| extension-resolver.ts | 358 | 扩展路径解析 | `[infra/installers/] extension-resolver.ts` git mv |
| skill-scanner.ts | 166 | skill 扫描 | `[infra/scanners/] skill-scanner.ts` git mv |
| agent-scanner.ts | 139 | agent 扫描 | `[infra/scanners/] agent-scanner.ts` git mv |
| scanner-base.ts | 35 | 扫描基类 | `[infra/scanners/] scanner-base.ts` git mv |
| trash.ts | 24 | 废纸篓 | `[infra/system/] trash.ts` git mv |

## transport/（7 文件，保留 + 微调）

| 文件 | 行 | 归位 |
|------|----|------|
| server.ts | 359 | `transport/server.ts` 重构：handler 移到 setServices 后构造，去 `as unknown` |
| session-message-handler.ts | 134 | `transport/handlers/session.ts` git mv |
| tree-message-handler.ts | 118 | `transport/handlers/tree.ts` git mv |
| extension-message-handler.ts | 165 | `transport/handlers/extension.ts` git mv |
| plugin-message-handler.ts | 80 | `transport/handlers/plugin.ts` git mv |
| settings-message-handler.ts | 138 | `transport/handlers/settings.ts` git mv |
| bridge-handler.ts | 95 | `transport/handlers/bridge.ts` git mv |

## services/（session/ + 根级，需去 PiXxx 依赖）

| 文件 | 行 | 归位 | 改动 |
|------|----|------|------|
| session/* (5文件) | 767 | 保留原位 | 改 import：`PiMessage`→`PiTranslatedEvent`；adapter 创建经 IPiEvents |
| config-service.ts | 308 | 保留 | **重**：去 `pi-config-bridge` import，改依赖 IConfigStore port；`mapTypeToApi` 移入 infra/pi-config |
| model-service.ts | 138 | 保留 | 去 pi 类型，改依赖 IModelSource port |
| tree-service.ts | 207 | 保留 | 去 `PiMessage` + adapters import，经 ports |
| extension-service.ts | 694 | 保留 | git clone 逻辑抽到 infra/git-installer，经 IInstaller port |
| extension-timeout-manager.ts | 101 | 保留 | 无改动（纯超时管理） |
| git-info.ts | 83 | `[infra/system/]` git mv | 从 service 移到 infra（它查 git，是外部系统连接） |
| session-history.ts | 56 | 保留或并入 session/ | 去 `convertPiHistory`/`scanPiSessions` import，经 ports |
| plugin-service/ (27) | 5173 | **保留原位不动** | 黑盒，已自洽 |

## 根级（3 文件）

| 文件 | 行 | 归位 |
|------|----|------|
| index.ts | 174 | 保留，调整 DI 接线（构造 infra 实现，注入 service） |
| interfaces.ts | 275 | 保留（service→transport 契约）+ 新增 `ports.ts`（service→infra 契约） |
| types.ts | 444 | **拆**：`Pi*` 类型移入 `infra/pi/pi-protocol.ts`；内部类型留 `services/types.ts` |

## 其他

| 文件 | 行 | 归位 |
|------|----|------|
| utils/path-utils.ts | 17 | 保留 `utils/` 或并入 `infra/`（纯函数，任意层可用） |
| plugins/demo/ | — | 不动（示例插件） |

---

# 第五部分 · 迁移步骤

> **铁律**：每阶段独立 commit、独立验证（`npm run build:runtime` + `validate-runtime-bundle.sh` + vitest）。禁止跨阶段部分回滚。plugin-service 全程不动。

## 阶段 R0 · 文档与认知（0 代码风险）

- 本设计文档 + ports 接口定义（本文件 + `services/ports.ts` 骨架）
- 在 design.md 标注 D4 被 supersede，指向本文件
- **验证**：无

## 阶段 R1 · PiXxx 类型收敛（低风险，机械）

**目标**：把 `types.ts` 的 `Pi*` 类型移到 infra 内部，断开根级共享。

1. 新建 `infra/pi/pi-protocol.ts`，`git mv` types.ts 里的 `Pi*` interface/type 过去
2. 全仓 import 路径修正（infra 内部从 pi-protocol 引，service/transport 引不到）
3. `services/types.ts` 只留内部类型（Message/Provider/Session 等，本就来自 shared 或新定义）
- **验证**：tsc + build + vitest
- ⚠️ 中间态：service 仍可能通过相对路径引到 Pi* —— R3 彻底断开

## 阶段 R2 · adapters/infra 合并 + 目录归位（机械，低风险）

**目标**：消灭 adapters/ 目录，全部归入 infra/，按外部系统建子目录。

1. 建 `infra/pi/`、`infra/installers/`、`infra/scanners/`、`infra/system/`
2. `git mv` 按「归位表」执行（纯移动，不改逻辑）
3. 修正所有 import 路径
4. **关键**：`pi-paths.ts` 移入 infra/pi/，`rpc-client` 改 import 同层 pi-paths → **消除 infra→adapters 反向依赖**
- **验证**：tsc + build + validate-runtime-bundle.sh + vitest

## 阶段 R3 · ports 接口落地（中风险，核心）

**目标**：service 不再 import infra，改依赖 ports 接口。

1. 在 `services/ports.ts` 定义 IPiEngine/IPiProcess/IConfigStore/IModelSource/IPiEvents/IInstaller
2. infra 侧：`pi-client` 实现 IPiEngine、`process-pool` 实现 IPiProcess、`pi-config` 实现 IConfigStore、`model-source` 实现 IModelSource、`pi-events` 实现 IPiEvents
3. 定义 `PiTranslatedEvent`（内部事件类型），`pi-events.ts` 把 pi 原始事件翻译成它
4. service 改 import：`config-service` 去 `pi-config-bridge` 改 IConfigStore；`mapTypeToApi` 移入 infra/pi-config
5. index.ts 组合根：构造 infra 实现，注入 service 的 ports
- **验证**：tsc + build + vitest（重点跑 session/config/model 测试）
- ⚠️ 这是改动最大阶段；建议先写 ports 的 vitest（mock 实现）验证 service 行为不变

## 阶段 R4 · transport 清理（低风险）

1. server.ts 的 handler 构造移到 `setServices()` 后，去掉 `as unknown as` 强转
2. （可选）switch 路由改声明式 map（T1）
3. handlers/ git mv 进 `transport/handlers/`
- **验证**：tsc + build + 手测 WS 消息流

## 阶段 R5 · 收尾验证

- `npm run build:runtime` + `validate-runtime-bundle.sh`
- `rg "Pi[A-Z]" services/ transport/` → **应为空**（PiXxx 不再泄漏）
- `rg "from '.*infra/" services/` → **应为空**（service 不直接 import infra，只经 ports）
- 全量 vitest

---

## 与现有 phase 计划的关系

| 现有 phase | 状态 | 与本设计关系 |
|-----------|------|-------------|
| phase-2 (runtime 分层) | ✅ 已完成 | 本设计是 phase-2 的**修订**——phase-2 建了四层，本设计改为三层 |
| phase-3 (拆 session-service) | ✅ 已完成 | **保留**，session 三拆分质量高，不动 |
| phase-4 (命名对齐) | ✅ 已完成 | 保留 |
| phase-5 (防护加固) | 未开始 | 本设计的 R5 验证项覆盖部分 phase-5 |

**plugin-service 在所有 R 阶段均不动**（已自洽，作为黑盒）。

---

## 一句话总结

runtime 是 pi 引擎的 Node.js 宿主，领域薄、适配重。放弃 D4 的四层（adapters 独立）改为三层（infra 合并连接+翻译），用 ports 依赖倒置断开 PiXxx 泄漏。改动以 git mv + 加翻译为主，业务逻辑基本不动，分 5 阶段（R0-R5）低风险推进，plugin-service 全程不碰。
