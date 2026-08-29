# subagent 核心包抽离与双宿主统一（subagent-core）

> 层声明：本文档是「核心包抽离与宿主适配」的架构层设计，下一层产物是**可实施的 HostServices 接口契约 + 包切面文件清单 + zcode 仓迁移对照实现计划**，不跨层到逐测试用例与逐函数实现。上游承接：[subagent-engine-abstraction.md](../architecture/subagent-engine-abstraction.md)（引擎中立抽象，P1-P5 已实施）——该设计回答「执行引擎如何可插拔」，本文档回答「执行层与编排层如何成为跨宿主共享的独立包」。
>
> 状态：一轮对抗式审查（2026-08-29，报告 `.review/design-review-subagent-core-r1.md`）：4 must-fix 已修复——①D1 切面补 `workflows/` 脚本资产处置（2a/2b 替换对象的落点）②依赖闭包审计补 `config-loader.ts` 触点与 logger 全量计数 ③D6 副作用核对补 runner-appserver 活跃通道处置 ④D2 补 pi 壳 dataRoot 三段回退语义；4 suggestion（D8 计数、检查点 5 降级路径、审计表补注、V1 比对判据与打包验证）已随文处理。

## 1. 背景目标

**一句话结论**：把 pi-subagent-workflow 中已落地的引擎中立执行层（EnginePort + pi/zcode 双引擎）、workflow 编排层与 workflow 脚本资产（含 review-fix-loop）抽为独立 npm 包 `@zhushanwen/subagent-core`，本仓 pi extension 与 zcode 仓 zsw 插件双宿主引用同一实现，消灭两套平行实现导致的逻辑漂移。

### SCQA

- **S（情境）**：pi 侧（本仓 `@zhushanwen/pi-subagent-workflow` v8.6.0）与 zcode 侧（zcode-plugin-workspace 仓 `@zhushanwen/z-subagent-workflow` v1.1.0）各自实现完整的 subagent 编排 + workflow 运行时，能力高度重叠（spawn 驱动、workflow 引擎、内置 workflow 四件、review-fix-loop）。
- **C（冲突）**：两边各自开发、各自修 bug：zcode 侧以 vendor（逐字复制源码）方式同步 pi 侧的 review-fix-loop 纯函数层，已登记 5 个分叉点（2026-08-29，zcode 仓 `fix-review-fix-loop` 分支）；超时语义、复杂度门禁、入口能力（`file:` 路径执行）等行为持续不一致。
- **Q（问题）**：如何让两宿主共享单一实现，同时保留各自宿主特有的能力（pi 侧的 GUI record 链路 / zcode 侧的 daemon 与 task-notification 免轮询唤醒）？
- **A（答案）**：核心包抽离 + 最小宿主端口（HostServices）适配，见 §3。

### 系统是什么（给不熟悉内部的读者）

两个「宿主」各跑一套 subagent 系统。**宿主**指承载编排逻辑的进程环境：

- **pi 宿主**：pi coding-agent 主会话进程内加载本仓 extension（TS 源直接加载）。模型调用 `subagent`/`workflow` 工具时，extension 在进程内 spawn 无头 pi 或 zcode 子进程执行任务，把执行记录（record）写进 pi 会话文件，供 xyz-agent 桌面 GUI 消费。2026-08-25 起，其执行层已有引擎中立抽象（EnginePort——subagent 执行引擎的唯一契约点，pi/zcode 各一个适配器，配置路由三层优先级）。
- **zcode 宿主**：zcode 客户端经 Bash 调 `zsw` CLI（CJS、node ≥20），默认 daemon 模式——常驻 daemon 持有后台任务，CLI 是薄客户端；任务完成经 zcode 引擎原生 task-notification 唤醒主会话（免轮询）。zsw 自带 slots 并发、reaper、notifier-mailbox、runner-spawn（spawn zcode CLI 子进程）、workflow-manager（自己的 workflow 运行时）。

**术语**（后文反复使用，均绑定上面的系统）：

- **核心（core）**：与宿主无关的共享实现——引擎抽象、spawn 执行链、workflow 编排运行时。
- **壳（shell）**：宿主特有的接入层——工具面/命令/视图（pi）、CLI/daemon/通知适配（zcode）。
- **依赖闭包**：core 的 import 传递闭包中所有非 node 内置依赖。core 可独立发布的判据是闭包内不出现 pi SDK 与 pi 宿主协作件。
- **双形态包**：同时以 TS 源（供本仓 workspace 内消费）和编译 dist（供 npm 外部消费）发布的包。本仓 `@xyz-agent/extension-protocol`（0.7.0）、`@xyz-agent/session-delivery`（0.3.0）已是此形态。
- **vendor / 分叉点**：zcode 仓为复用 pi 侧逻辑而逐字复制源码的同步方式；「分叉点」是 vendor 文件头注中登记的、两份实现刻意不再一致的位置。

### 设计目标（从使用者体验倒推）

1. **修复一次，双宿主生效**：开发者改 core 一处，pi 侧（workspace 引用，即时）与 zcode 侧（npm bump）同时获得，不再双仓各修。
2. **pi 宿主行为零回归**：xyz-agent 用户的 subagent / workflow / GUI 可见性行为与抽包前逐字段一致。
3. **zcode 宿主升级到统一实现的全量能力**：获得引擎抽象（路由语义、probe、fallback 守卫）、conformance/golden 质量资产、schema native/emulated 降级链——这些是 zsw 现在没有的。
4. **两宿主特有能力不丢失**：zcode 的 daemon + task-notification 唤醒、pi 的 GUI record 三级读取，迁移后照常工作。
5. **公共 API 成为显式契约**：core 的导出面按 semver 管理，宿主升级路径可预期。

### in / out of scope

**in**：core 包切面（物理抽离范围与准入规则，含 `workflows/` 脚本资产的归属处置）；依赖闭包 port 化（HostServices 最小端口集）；双形态构建与 npm 发布管线接入；本仓 pi extension 回接与 runtime 复用链切换；zcode 仓渐进替换路径的设计层对照（utils → workflow 运行时 → spawn 驱动）；存量数据切换点策略。

**out**：独立 bin CLI（zsw 壳已承担 CLI 职责；core 首期只出库 API，bin 是后续演进）；zcode 主会话引擎切换；第三引擎（claude-code 等）实现；`file:` 入口与材料注入 parity（依赖本设计落地，Phase 3 另行小设计）；zsw daemon 自身架构改造（保留现状，只换底座）；xyz-agent renderer/GUI 改动（零改动）。

## 2. 现状与问题分析

两套实现能力高度重叠、漂移已有实证，且本仓的抽象资产已就绪——抽包的障碍只剩依赖闭包与消费形态。

### 2.1 两套实现的现状（使用者视角）

**pi 侧链路**（模型视角）：模型调用 `subagent` 工具 → extension 进程内 `SubagentService.executeAndAwait` → 引擎路由（`routeEngine`：调用参数 `engine` > agent .md frontmatter `engine` > config `defaultEngine`，缺省 `'pi'`）→ EnginePort 适配器 spawn 子进程 → 事件流翻译为 AgentEvent → record 写 pi 会话 entry → GUI 三级读取降级链展示。workflow 工具则经 `orchestration/` 在 worker thread 跑脚本，agent 调用经 `AgentRunner` port 回到执行链。

**zcode 侧链路**（用户/主 agent 视角）：zcode 主 agent 调 `zsw start <agent> <task>`（Bash 后台）→ daemon 持有执行体 → runner-spawn spawn zcode CLI 子进程 → record 落 `~/.zcode/zsw/` → 完成时 task-notification 唤醒主会话。workflow 经 `zsw workflow run <name>` 走自己的 workflow-manager（worker 内跑 `lib/workflow/*.js` 内置脚本）。

### 2.2 真实失败模式（漂移实证）

以下均取自两仓可查证的状态，非假设：

**失败模式 A：vendor 同步的成本已持续支付**。zcode 仓 `fix-review-fix-loop` 分支（提交 `d4f61eb`，2026-08-29）将 pi 仓 `workflows/review-fix-loop-utils.cjs` 的 14 个纯函数 vendor 进 `lib/workflow/review-fix-loop-utils.js`，头注登记 5 个分叉点：①依赖闭包一并 vendor ②剥离宿主耦合 ③zsw 侧契约常量 ④逐字复制约定（便于上游 diff 审计）⑤`validateFixResult`/`reconcileIssues` 因 zcode 仓圈复杂度门禁（>15）被拆分——**同一份逻辑从此两处维护**，且第 5 点是门禁规则冲突逼出的结构性分叉，上游 pi 仓不修就永久存在。

**失败模式 B：行为不一致各自修**。zcode 侧超时语义事故（20 分钟死线 SIGKILL 毁掉 90% 完成度的 fixer，修复提交 `f854202`/`85666f1`）只在 zcode 仓落地；同类认知若在 pi 侧再出一次，需人工意识到「对面也有这个问题」。

**失败模式 C：能力缺口重复评估**。zcode 侧库层 `runScript({file})` 早已支持任意路径脚本，但 manager/CLI 两层入口只暴露内置名——pi 侧同一能力在 workflow-script-registry 的形态又不同，每次补齐都要跨仓对照（`file:` 入口方案至今停留在已定未落状态）。

**失败模式 D：质量资产不可复用**。本仓为引擎抽象建了 conformance 契约套件（C1-C8）+ pi/zcode 双引擎 golden 回放样本；zcode 仓的 runner-spawn 驱动没有任何等价质量门，zcode CLI 输出格式漂移时无从回归。

### 2.3 根因

**双权威源**：zsw 开发期（早于 2026-08-25）本仓引擎抽象尚不存在，两仓各自长出同构实现，此后每次对齐都靠 vendor + 人工纪律。vendor 纪律（逐字复制 + 分叉点登记 + 上游 diff 审计）只能延缓漂移、不能消除——只要有分叉点存在（当前 5 个），两份实现的语义一致性就依赖人的持续投入。根治 = 单一权威源 + 双宿主适配。

### 2.4 物理数据流（现状，两套）

```
【pi 宿主：xyz-agent 桌面 / pi CLI】
  pi 主会话进程（extension 进程内）
    ├─ src/execution/engine/{pi,zcode}/ spawn 子进程 ──→ 子进程 stdout
    ├─ record: appendEntry 写 pi 会话 JSONL（~/.pi/agent/sessions/）
    ├─ journal/引擎池: <getDataDir()>/engines/<engineId>/<poolKey>/
    └─ workflow state: pi 会话 CustomEntry（jsonl-run-store）
  xyz-agent runtime（独立进程）
    └─ subagent-engine-history.ts: import @zhushanwen/pi-subagent-workflow/
       src/execution/engine/engines/zcode/reader.js（双端复用链）→ GUI

【zcode 宿主：zcode 客户端】
  zcode 主会话（Bash 调用）
    └─ zsw CLI（CJS）→ daemon（常驻）
         ├─ lib/runner-spawn.js spawn zcode CLI 子进程 ──→ 子进程 stdout
         ├─ record: ~/.zcode/zsw/...（record-store.js）
         └─ workflow: lib/workflow/*.js + review-fix-loop-utils.js（vendor）
  【vendor 同步流：pi 仓 utils.cjs ──人工逐字复制──→ zcode 仓 utils.js
   （5 分叉点，双向无机械约束）】
```

两套链路在「spawn 驱动 → 事件/终态解析 → record 落盘 → workflow 编排」四段同构，仅存储位置与唤醒机制不同——这正是可抽公共层的证据。

### 2.5 抽包可行性与阻塞项（依赖闭包审计）

对候选 core 范围（`src/execution/` + `src/orchestration/` + `src/shared/`，剔除壳目录）做外部依赖全量 grep（2026-08-29 实测，非测试 import），闭包内 6 个非 node 依赖：

| 依赖 | 触点 | 性质 | 处置（→ §3.3 D3） |
|------|------|------|------|
| `@zhushanwen/pi-extension-logger` | 非测试 import 共 30 处（execution / orchestration / **shared/resource-discovery.ts**） | 宿主协作件（自身 peer 依赖 pi SDK） | **port 化**：core 内部 log 端口，调用面极薄（全是 getLogger） |
| `@earendil-works/pi-coding-agent` | 硬触点 5 文件：`engine/common/data-dir.ts` 与 `orchestration/config-loader.ts` 与 `orchestration/skill-discovery.ts` 的 `getAgentDir`（后两处为运行时值导入）、`ui-request-handler-factory.ts` 的 ExtensionContext 类型、`jsonl-run-store.ts` 的类型 | pi SDK 硬依赖 | **port 化 / 留壳**：数据根与发现根参数化（config-loader/skill-discovery 走 discovery/data 根端口）；jsonl-run-store 是 RunStore port 的 pi 实现留壳 |
| `@xyz-agent/session-delivery` | `notifier.ts` 的 `createDelivery`（运行时投递） | pi 宿主协作件（已发 npm 0.3.0，但语义是 xyz-agent 桌面投递） | **port 化**：通知端口 |
| `@zhushanwen/pi-pending-notifications` | `session-pending.ts` 的 `countActiveFromEntries` | pi 宿主协作件（peer pi SDK，且传递依赖 logger） | **port 化**：并入通知端口 |
| `@zhushanwen/pi-file-lock` | `worktree-registry.ts` 的 `withFileLock` | 通用件但传递依赖 logger | **去依赖**：worktree-registry 直接用 `proper-lockfile`（runtime 既有依赖） |
| `@xyz-agent/extension-protocol` | `types.ts` 类型 + `engine-discovery.ts` 常量 | **中立**（已发 npm 0.7.0，无 pi SDK） | **保留** |

**已就绪的资产**（抽包不是重新设计）：①分层目录天然对齐切面（execution / orchestration / interface / injectors 四目录，前三即 core，后二即 pi 壳）；②orchestration 已按端口注入（AgentRunner / RunStore / WorkerHost + LifecycleDeps 的 log/eventBus/streamSink 可选回调——HostServices 的雏形）；③EnginePort/conformance/golden/三层路由全部就位；④双形态包先例（extension-protocol：`main: src/index.ts` + exports dist）；⑤runtime 已建立对 engine reader 的 workspace 复用链（tsup noExternal 已登记该包）。

## 3. 解决方案

方案核心一句话：**core 包只新增一个 4 方法的宿主端口（HostServices），其余全部是既有资产的物理搬迁**——切面判据、端口形状、构建形态、替换次序逐条见 D1-D9。

### 3.1 终态（使用者视角先行）

**终态一：pi / xyz-agent 用户零感知。** `subagent`/`workflow` 工具入参、返回、GUI 展示与抽包前完全一致——同一份 agent 清单、同一个 record 结构、同一个引擎选择行为。

**终态二：zcode 用户命令面不变、内核统一。** `zsw start/run/workflow` 等命令照常；review-fix-loop 与 pi 侧是**同一份实现**（改 core 一处，下次 `zsw` 升级即生效）。zsw 获得 pi 侧的质量资产：agent .md `engine:` 字段路由、probe 拦截与 fallback 留痕、schema 降级链。

**终态三：开发者单权威源。** 例：`wrapUntrusted`（上游 LLM 产出的防注入包裹）行为修正落在 core 的一个函数——本仓 extension 因 workspace 引用立即生效（跑 extensions 三连验证）；zcode 仓 `pnpm bump @zhushanwen/subagent-core` 后同样生效。vendor 文件删除，5 个分叉点登记表关闭。

**失败路径（均带恢复指引，→ §3.4 错误规格全表）：**

- zcode 仓升级 core 到不兼容大版本：`zsw` 启动即报 `core_version_incompatible`，错误含钉版本命令（`npm i @zhushanwen/subagent-core@^N`）与升级指引链接，不进入半初始化状态。
- 宿主接入时漏配必需端口：首次调用 core API 报 `core_host_not_configured`，错误指出缺哪个端口、给该宿主的接入示例（pi 壳 / zsw 壳各一段）。
- core 安装链断裂（CJS require 不到 ESM 传递依赖）：报错含 node 版本要求与重装命令（§3.3 D4 的探针门保证上线前捕获）。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A：核心 npm 包 + 双宿主引用**（core 在本仓 `packages/subagent-core/`，pi 壳 workspace 引用，zcode 仓 npm 引用） | 好：单一权威源；npm 边界强制 HostServices 纪律；两宿主保留各自发布节奏与宿主特有代码；新引擎一处接入双宿主受益 | 中：依赖闭包 port 化（logger 30 处机械替换 + pi SDK 触点 5 文件参数化）+ 双形态构建 + zcode 侧三步替换 | 版本节奏成本（zcode 侧滞后一个发布周期）；双形态包构建的边界细节；appserver 通道 2c 退役的体验让渡（P3 回收） | **✅ 推荐** |
| B：zsw 整仓迁入本仓（monorepo 单权威） | 中：消灭双仓但拖入 zcode marketplace 发布耦合；daemon/task-notification 等 zcode 宿主代码进本仓后，本仓承担非 pi 生态的维护面 | 中：迁移 + 两边构建管线合并 | zcode 插件发布节奏被本仓 changeset 流绑架；仓定位漂移（本仓是 xyz-agent + pi 生态仓） | ❌ |
| C：维持双仓 + vendor 纪律强化（对照组） | 差：分叉点只增不减（当前 5 个），门禁规则冲突（失败模式 A 第 5 点）无解 | 最低 | 漂移持续，每次对齐人工成本复利 | ❌ |

**被否方案「若用它，§2 的例子会怎样」**：方案 B 下失败模式 A 归零，但 zcode 侧一个 daemon 修复要走本仓 changeset + 版本门禁（含 pi 版本一致性校验的提交链），发布摩擦大到会诱发热修复绕行；方案 C 下失败模式 B/C/D 原样持续——这正是本设计要终结的状态。

### 3.3 关键决策与权衡

**D1：core 切面 = execution（引擎无关件）+ orchestration + shared + `workflows/` 脚本资产；准入规则用依赖闭包判据（选定）**

- **采用**：core 范围为 `src/execution/`（剔除 §2.5 表中留壳件）+ `src/orchestration/`（剔除 pi 会话版 RunStore 实现）+ `src/shared/`，**外加包根 `workflows/` 脚本资产整体迁入**（内置四件 chain/parallel/map-reduce/scatter-gather、`review-fix-loop.js` 主脚本、`review-fix-loop-utils.cjs` 纯函数层、`_shared/`）——workflow 脚本是「跑在 worker 契约上的数据/脚本资产」，是 §2.2 失败模式 A 的 vendor 对象本体，不进 core 则 2a/2b 的替换无从落地、终态二「同一份实现」对 workflow 主逻辑断裂。发布形态：作为 core 的子路径资产发布（`@zhushanwen/subagent-core/workflows/*`，保持 .cjs 脚本形态不编译）。脚本内依赖保持**同目录相对 require**（现状 `review-fix-loop.js` require `'./review-fix-loop-utils.cjs'`），使 pi 侧内置 staged 布局（`apps/electron/resources/extensions/` 下无 node_modules）整目录复制后 require 依旧成立；zcode 侧经 npm 解析子路径 require。准入判据一条：**core 内模块（含 workflows 脚本）的依赖闭包不得出现 pi SDK 与 pi 宿主协作件**——违者要么 port 化，要么划归宿主壳。逐文件清单是下一层产物（Phase 1 实施），本层只定判据。
- **被否**：①workflows/ 留在 pi extension 包、仅 src 层进 core——vendor 对象（utils.cjs）不在 core，2a「删 vendor 改 npm 依赖」无处落地，目标 1 对 review-fix-loop 主逻辑不成立；②脚本内改 require 包名（`@zhushanwen/subagent-core/...`）——pi builtin staged 布局无 node_modules 解析面，属本项目打包事故最高发形态（关键规则 12），同目录相对 require 是 staged 下的既验证模式；③逐文件硬清单在本文档定死——Phase 0 port 化会移动文件归属，硬清单立刻过时，判据 + 机器守卫（D9）比静态清单稳。
- **证据**：`extensions/universal/subagent-workflow/workflows/` 实测清单（utils.cjs 84KB / review-fix-loop.js 94KB / 内置四件 / _shared）；zcode 仓 vendor 头注（§2.2 失败模式 A）；pi 内置扩展 staged 机制（关键规则 17）。
- **效果**：目标 1/3 对 workflow 层完整成立；切面清晰使 Phase 2 的 zcode 侧替换有明确对照物；终态二「同一份 review-fix-loop」有物理载体。

**D2：HostServices 最小端口集——4 个方法，可选端口不强制（选定）**

- **采用**：core 定义唯一宿主端口（注入时机：宿主壳初始化时 `configureCore(host)`，core 内部模块统一取用）：

```ts
export interface HostServices {
  /** 数据根目录：引擎隔离池 / journal / record 派生存放的锚点。
   *  pi 壳：原样内联现 data-dir.ts 三段语义（env 优先 → getAgentDir() 回退 + warn-once，
   *  standalone pi 用户落 ~/.pi/agent——不内联则独立 pi 用户的 journal 会静默漂目录）；
   *  zsw 壳：zsw 数据根；缺省实现：~/.subagent-core */
  dataRoot(): string;
  /** 结构化日志：对齐现 getLogger 调用面（level/component/message/data）。缺省 console。 */
  log(level: Level, component: string, message: string, data?: unknown): void;
  /** agent/skill/workflow 资源发现根（可选）。pi 壳：getAgentDir + pi 通路；zsw 壳：zsw 四根发现。 */
  discoveryRoots?(): { agents?: string[]; skills?: string[]; workflows?: string[] };
  /** 完成通知（可选）。pi 壳：pending-notifications + session-delivery 组合；zsw 壳：task-notification；缺省 no-op。 */
  notify?(event: NotifyEvent): Promise<void>;
}
```

  RunStore / AgentRunner / WorkerHost 三个既有 port 不动——jsonl-run-store（写 pi 会话）留 pi 壳，core 另提供通用 `FileRunStore`（落 dataRoot 下）供 zsw 壳与未来 CLI 宿主用。
- **被否**：①把 pi extension API 全量抽象成宿主接口——过度设计，CLI 宿主不需要 ask-user/GUI，端口按「core 实际触点」收口；②HostServices 经 postMessage 传 worker thread——workflow 脚本跑在 worker，但 agent 调用经 agent-call 消息回主线程执行（AgentRunner 在主线程），worker 内无需 HostServices。
- **证据**：`ports.ts` 的 LifecycleDeps 已用同风格可选回调（log/eventBus/streamSink）；§2.5 表的 4 类触点一一对应本端口 4 方法。
- **效果**：目标 4 成立——zsw 壳的 task-notification 接 `notify`，daemon 行为不变；pi 壳 GUI 链路零改动。

**D3：依赖处置矩阵（选定，承接 §2.5 表）**

- **采用**：logger/dataRoot/discovery/notify 四类 port 化（D2）；`file-lock` 改为 worktree-registry 直接依赖 `proper-lockfile`（runtime tsup noExternal 既有条目，零新增打包面）；`extension-protocol` 保留为 core 的 npm 依赖。
- **被否**：给 `pi-file-lock` 包本身去 logger 化——虽更干净但要动共享包并发版，超出本设计范围；记为后续清理项。
- **证据**：`extensions/shared/file-lock/package.json` 的 dependencies；`packages/runtime/tsup.config.ts` noExternal 含 proper-lockfile。
- **效果**：core 闭包收敛为 `extension-protocol + proper-lockfile + ajv + yaml`（后两个是 extension 既有 dependencies，均中立）。

**D4：双形态构建——TS 源供 workspace、dist 双格式供 npm；闭包内包 bundle 进 CJS 产物（选定）**

- **采用**：包形态对齐 `extension-protocol` 先例（`main: src/index.ts` + exports conditions）；tsup 产出 ESM + CJS 双 dist。**关键点**：zsw 是 CJS（node ≥20），而 core 依赖的 `extension-protocol` npm dist 仅 ESM（.mjs）——CJS `require()` 加载 ESM 在 node 20 不可靠，因此 core 的 dist 构建将 `extension-protocol`（运行时面仅常量）**bundle 进产物**（tsup noExternal），不让它以外部 ESM 依赖形态出现在 require 链上。
- **被否**：①要求 zsw 迁 ESM——改造面失控；②core 仅出 ESM——zsw 全部 CJS require 链失效。
- **证据**：`packages/extension-protocol/package.json` exports 的 dist 为 .mjs（✅实测）；zsw `package.json` `"type": "commonjs"`、`engines: node>=20`（✅实测）。**探针 ⛔ 实施期门**：在 node 20 真机 require core 的 CJS dist 跑一次 smoke（含 bundle 后的 protocol 常量引用）。降级路径：若 bundle 边界出问题（如 protocol 后续加了运行时代码），退守方案是 core dist 全量 bundle 闭包内全部非 node 依赖——体积可控（ajv/yaml 已是 extension 运行时依赖量级）。
- **效果**：目标 5 的发布前提；双宿主消费形态都成立。

**D5：版本与公共 API 契约（选定）**

- **采用**：core 的公共 API 面 = 包 index 导出（EnginePort 及中立类型 / routeEngine / HostServices 与 configureCore / orchestration 入口 runWorkflow 等）+ 深路径子入口（`@zhushanwen/subagent-core/engines/<id>/reader` 供双端复用链；`@zhushanwen/subagent-core/workflows/*` 脚本资产子入口，见 D1）。semver 纪律：breaking 走 major；zsw 壳用 `^` 区间 + 启动期版本 guard。发布通道复用现管线：正式走 changeset/main 稳定发布，zcode 侧联调用 dev-npm 预发布通道（`scripts/npm-prerelease.sh`）。
- **被否**：core 跟随 extension 的 8.x 主版本号——两个包语义不同步，版本号耦合制造假对应关系。
- **证据**：本仓两条 npm 发布管线（main 稳定 + dev-npm 预发布）为既有机制。
- **效果**：目标 5 成立。

**D6：zcode 侧渐进替换次序 = utils → workflow 运行时 → spawn 驱动（选定）**

- **采用**：三步风险递增：**2a** 删 vendor utils 改 npm 依赖（zcode 侧 require core 的 `workflows/review-fix-loop-utils.cjs` 子路径；纯函数、零 I/O、对照面现成、立即消灭 5 分叉点）；**2b** workflow-manager/workflow-script 替换为 core orchestration，zcode 侧内置 workflow 脚本副本删除、直接使用 core 的 `workflows/` 资产（worker 契约随 core）；**2c** runner-spawn/driver/model-router/slots/pool 替换为 core `engines/zcode` + 执行链，daemon 改为「core 宿主壳」（经 HostServices 接 task-notification）。
- **被否**：一步到位整替——zsw 的 daemon/reaper/notifier-mailbox 与新执行链的交互面大，单步替换失败时无法定位回归层。
- **证据**：失败模式 A 的 vendor 文件是现成对照物（2a 的 diff 可机械验证语义等价）。
- **效果**：目标 1 的达成路径可分段验收（→ §4 V2）。

**D7：zcode 侧存量数据切换点（选定方向，细节 ⛔ 实施期门）**

- **采用**：`~/.zcode/zsw/` 旧 record 只读保留（读取兼容期），新 run 落 core 布局（dataRoot 下 engines/ 与 workflow-state/）；以 2c 合入为 break 点，在 zsw README 标注。⛔ 实施期门：2c 前调研存量 record 的读取路径与数据量，确认只读兼容的覆盖面；降级路径：若存量读取面过大，提供一次性迁移脚本（旧 record → core 布局投影）。
- **被否**：静默双写——两份数据目录并行是新的漂移源。
- **证据**：zsw record-store 的存储路径（§2.4 图）。
- **效果**：目标 4（zsw 用户不丢历史）；失败模式 A 类问题不再新增。

**D8：runtime 复用链切换——直接依赖 core（选定）**

- **采用**：runtime 对 `@zhushanwen/pi-subagent-workflow` 的 4 处深路径 import（relay-env / engine/paths / engines/zcode/reader / engines/zcode/constants）改为依赖 `@zhushanwen/subagent-core` 的对应子入口；tsup noExternal 条目替换；extension 包对 runtime 消费者不再承担 core 模块的转发。
- **被否**：extension 包内 re-export 保持旧深路径兼容——多一层转发且 runtime 是仓内唯一消费者，无外部兼容负担，直接切干净。
- **证据**：runtime 深路径 import 实测 5 处语句（4 个模块路径：relay-env / engine/paths / engines/zcode/reader / engines/zcode/constants，分布在 3 个源文件；另有 5+ 测试文件同口径 import）；`packages/runtime/tsup.config.ts` 的 noExternal 注释「只消费双端复用的无状态模块」；全仓消费者审计（✅实测 grep package.json + 源码 import）：唯一外部消费者是 runtime，无其他 extension / app 依赖本包——切换范围封闭。
- **效果**：依赖方向变干净（runtime → core，而非 runtime → pi 扩展包内部）；validate-runtime-bundle.sh 继续守卫。

**D9：core 依赖卫生机器守卫（选定）**

- **采用**：新增探针脚本（挂 pre-commit / CI invariants）：校验 core 的 dependencies + peerDependencies + 源码 import 闭包**不含** `@earendil-works/*`、`@zhushanwen/pi-extension-logger`、`@zhushanwen/pi-pending-notifications`、`@xyz-agent/session-delivery`。防未来回归（新代码把 pi SDK 带回闭包）。
- **被否**：靠 review 纪律——§2.3 已证明人工纪律守不住漂移。
- **证据**：本仓探针文化（check-pi-semantics / check-extension-dependencies / check-pi-sync 同族）。
- **效果**：D1 判据从文档约束升级为机器约束；目标 1 的长期保障。

**接管 / 替换既有流程的副作用核对（D6 逐段）**：zsw 壳被 core 接管的段落与其后半段内部步骤的归属——①spawn 子进程后的 stdout 解析：core parser 接管（zsw 现 runner-spawn 的解析段废弃，不保留双路径）；②record 落盘：2c 后由 core record-store 写 dataRoot，zsw record-store.js 降级为存量只读；③完成通知：core `notify` 端口 → zsw 壳实现投递 task-notification（复刻 zsw 现有 notifier-mailbox 的「下次活动才注入」边界语义由壳侧决定）；zsw 现通知的 polling 兜底模式归壳侧 notify 实现内部，不进 core；④reaper/孤儿回收：core 的 crash-recovery / session-start-reaper 等价物接管，zsw reaper 删除；⑤slots 并发：core concurrency-pool 接管（2c 验收含并发行为对比）；⑥**runner-appserver 活跃通道**（实测：`ports.js` 按 runnerKind 分派，`ZSW_RUNNER=appserver` 探针门控 + 失败降级 spawn，e2e 在用）——zcode app-server 常驻模式按上游设计属「引擎内部优化项，不进首期接口实现」（engine-abstraction §1 out of scope）：2c 时**显式退役**（统一走 core `engines/zcode` 的 spawn 单轮；appserver 的长驻/零冷启动/实时进度/per-session model 优势暂时让渡），在 zsw README 与 e2e 标注 break；常驻实现的回归路线见 P3（core zcode engine 内部换常驻实现，EnginePort 接口已常驻友好）。每段要么复刻要么显式废弃，禁止默认沿用旧段。

### 3.4 错误规格（每类配恢复指引）

| 错误 | 触发 | 恢复指引 |
|------|------|---------|
| `core_host_not_configured` | 宿主壳未调 `configureCore` 即调 core API | 错误含缺失端口名 + 该宿主接入示例代码（pi 壳 / zsw 壳各一段）+ 接入文档路径 |
| `core_version_incompatible` | zsw 壳声明的所需 core 大版本与实际安装不符（启动期 guard） | 钉版本命令 `npm i @zhushanwen/subagent-core@^N` + 升级指引链接 |
| `core_module_load_failed` | CJS require 链断裂（安装形态/node 版本问题） | node 版本要求（≥20）+ `rm -rf node_modules && npm i` 重装命令 |
| `core_port_missing` | 调用可选端口能力（如 notify）但宿主未接 | 降级 no-op + 一次 warn 日志（不报错——可选端口缺席是合法形态） |
| （继承）`engine_*` 错误族 | 引擎探针/运行失败 | 不变——沿用 engine-abstraction §3.3.3 全表（含 recovery），core 不新造第二套 |

### 3.5 物理数据流（终态）

```
        ┌── 本仓 packages/subagent-core（npm 发布：src 供 workspace + dist ESM/CJS）──┐
        │  execution/engine（EnginePort + pi/zcode adapter + conformance/golden）      │
        │  execution 引擎无关件 + orchestration + shared + HostServices + FileRunStore │
        └────────────┬──────────────────────────────┬────────────────────────────────┘
     workspace:*     │                              │ npm ^（经 prerelease 通道联调）
┌────────────────────┴──────────┐      ┌────────────┴───────────────────────────────┐
│ pi 壳：extensions/universal/   │      │ zsw 壳：zcode-plugin-workspace              │
│   subagent-workflow            │      │   zsw CLI + daemon（保留）                  │
│   interface/ + injectors/      │      │   HostServices 实现（dataRoot=~/.zcode/zsw、│
│   + PiSessionRunStore          │      │   notify=task-notification、四根 discovery）│
│   + logger/notify 桥接         │      │   + skills（不变）                          │
└───────────────────────────────┘      └─────────────────────────────────────────────┘
        ↑ runtime 直接依赖 core 的 reader 子入口（D8，tsup noExternal 更新）
数据落点：pi 宿主 ~/.xyz-agent（dataRoot 注入）／zcode 宿主 ~/.zcode/zsw（同）——布局统一为
  <dataRoot>/engines/<engineId>/<poolKey>/ 与 <dataRoot>/workflow-state/，宿主差异收敛到 dataRoot 值
```

## 4. 验收

大改动（包结构 + 双仓迁移），多场景。执行环境：本机真实 xyz-agent dev（`pnpm dev`）+ 真实 zcode 客户端与 pi/zcode CLI（有效凭据）+ 一个真实有 diff 的仓库（如 xyz-agent 本身）。每个场景标注回溯 §1 目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V1 | pi 宿主零回归 | ①抽包合入前采集基线：xyz-agent dev 下派一个默认引擎 subagent、一个 reviewer.md 带 `engine: zcode` 的 subagent、跑一个两步 parallel workflow + 一个内置 review-fix-loop 最小 run（验证 workflows/ 资产迁移），保存 record entry JSON 快照与 GUI 关键视图截图（视图清单：对话流 / 工具面板 / record 详情三级读取页 / WorkflowsView）；②合入后重跑同四例；③standalone pi（pi CLI 直跑、非 xyz-agent）派一个 subagent，核对 journal/record 落盘目录；④打包子系统验证：`validate-runtime-bundle.sh` + 打包产物内 workflows 目录 staged 布局与脚本相对 require 探针 | record entry JSON 字段级一致；四视图与基线截图一致（逐视图人工比对）；③落 `~/.pi/agent` 派生目录（D2 三段语义未漂移）；④双验证 exit 0、staged 内 `require('./review-fix-loop-utils.cjs')` 解析成功；`pnpm extensions:typecheck && extensions:lint && extensions:test` 与 runtime vitest 全绿 | 目标 2 |
| V2 | 分叉点归零 | zcode 仓基于 `fix-review-fix-loop` 分支：删 `lib/workflow/review-fix-loop-utils.js` vendor 拷贝，测试改 import core；在本机真实 repo 上跑 `zsw` review-fix-loop 一轮全流程（真实 diff + 真实模型审查/修复） | 流程走通且终态 JSON 与 pi 版同 schema；`grep -r "vendor 自 pi 仓" lib/` 零残留；parity 文档分叉点登记表标记关闭 | 目标 1 |
| V3 | zcode 侧获得路由语义 | zsw 接 core 后（2b/2c 后）：①agent .md frontmatter `engine:` 生效；②调用参数显式覆盖 frontmatter；③临时移走 zcode 二进制模拟 probe 失败，观察 frontmatter 来源任务的 fallback | ①生效引擎正确（record 留痕）；②覆盖优先级正确；③fallback 回默认引擎且 record 含 `engineFallback`（若为调用参数显式指定则不兜底、报 `engine_probe_failed`） | 目标 3 |
| V4 | 修复一次双宿主生效 | 选一个真实小修（如 utils 纯函数边界修正）落在 core：①本仓 extension 跑相关测试；②`npm-prerelease.sh` 发 beta；③zcode 仓 bump beta 后跑 zsw 测试 | ①绿；②beta 可安装；③zsw 测试绿且行为体现修正 | 目标 1 |
| V5 | 宿主特有能力保留 | ①zcode：`zsw start` 后台任务（daemon 持有），主会话等待 task-notification 唤醒；②pi：xyz-agent dev 打开 zcode 引擎 subagent 详情页（三级读取降级链）；③2c 后跑 zsw 测试族（含原 appserver e2e 改造为 spawn 通道的用例） | ①完成时主会话被原生通知唤醒（免轮询，与迁移前同感）；②详情页正常渲染；③全绿——appserver 退役（D6-⑥）无残留断链 | 目标 4 |
| V6 | 负面行为（守卫不破防） | ①对 core 发布物跑 D9 守卫探针，故意在 core 源加一处 `import ... from "@earendil-works/pi-coding-agent"` 后重跑；②zsw 声明需要 core ^2 但装了 1.x 后启动 | ①探针转红拦截（证明有牙）；②启动期 `core_version_incompatible` 报错含钉版本命令，不进入半初始化 | 目标 5 / §3.4 |
| V7 | conformance 资产随包可用 | 在 zcode 仓（或独立空仓）以 npm 消费者身份 require core 的 CJS dist，跑 golden 回放层（免 LLM 免二进制） | require 成功、golden 回放全绿——证明质量资产不绑定本仓 dev 环境 | 目标 3 |

验收前置门（实施期完成）：V2 前先用 `file:` 本地链接（zcode 仓 dependencies 指向本地 core 路径）打通联调回路，替代正式 npm 版本——这是 D5 prerelease 通道的轻量前置。

## 5. 下一层拆分

实施路径四阶段，每阶段可独立验收/回滚（V1-V7 分配到阶段门）：

| 阶段 | 单元 | 内容 | justification / 验收挂钩 |
|------|------|------|--------------------------|
| P0 | 依赖闭包 port 化（包内完成，零行为变化） | 新增 `src/core/host-services.ts`（HostServices + configureCore + 缺省实现）；`engine/common/data-dir.ts` getAgentDir → `host.dataRoot()`（保留 env 优先三段语义，缺省实现内联）；`orchestration/skill-discovery.ts` 与 `orchestration/config-loader.ts` 的 getAgentDir → `host.discoveryRoots()`/`host.dataRoot()`（按用途归口，实施期核对 config-loader 的具体用途后定端口归属）；`execution/notifier.ts` + `session-pending.ts` 的 session-delivery/pending-notifications → `host.notify`；30 处 getLogger（含 `shared/resource-discovery.ts`）→ core log 端口；`worktree-registry.ts` 改用 proper-lockfile | 纯重构无行为变更，现有 480+ 测试族守护；先收口再搬家，Phase 1 是纯物理迁移不再改语义。验收：全量测试绿 + extension 在 pi CLI 实测一例 subagent |
| P1 | 物理抽包 + 双形态构建 + 回接 + 发布 | 新包 `packages/subagent-core/`（package.json / tsup ESM+CJS / vitest / README）；代码物理迁移；extension 改 workspace 引用；runtime 深路径 import 切 core（D8）+ tsup noExternal 更新；changeset 接入；D4 的 node 20 CJS smoke 门；D9 守卫探针落地 | 单仓内闭环，不依赖 zcode 仓配合；pi 侧行为零变化由 V1 守护；发布物由 V7 验证 |
| P2 | zcode 仓渐进替换（2a/2b/2c） | 2a：vendor utils → npm 依赖（file: 联调→beta 通道）；2b：workflow 运行时替换；2c：spawn 驱动 + slots/pool/reaper 归属切换 + 存量切换点（D7 门）+ daemon 变 core 宿主壳 | 风险递增次序（D6），2a 立即兑现分叉归零（V2），2c 兑现 V3/V5 |
| P3 | 后续演进（另行小设计） | `file:` 入口、材料注入 parity、独立 bin CLI、core zcode engine 内部常驻实现（回收 2c 退役的 appserver 优势：长驻/零冷启动/实时进度，EnginePort 接口已常驻友好）、`pi-file-lock` 去 logger 化清理 | 依赖本设计落地；每项独立成立不绑架本设计 |

**文件改动地图（P0/P1 主要落点）**：`extensions/universal/subagent-workflow/src/`（P0 改 6 组触点文件；P1 迁出 execution/orchestration/shared 主体，壳保留 interface/injectors/jsonl-run-store/部分 ui-* 件）与包根 `workflows/`（P1 整体迁入 core，内置 staged 布局的复制源同步改指 core）；`packages/subagent-core/`（新）；`packages/runtime/`（import 与 tsup.config.ts、package.json 依赖切换）；`scripts/`（D9 守卫探针新脚本）；`.githooks/`（pre-commit 挂载）。精确逐文件清单属下一层（实现计划）产物。

**待验证检查点（实施期必须实证，不预设结论）**：

1. `ui-request-handler-factory.ts`（execution/ 内唯一 pi ExtensionContext 类型触点）的切面归属：泛化为中立 UI 上下文类型进 core，还是随 GUI 交互件划归 pi 壳——Phase 1 实施时按其被依赖方向定（若仅 interface 层消费则划壳）。
2. D4 的 CJS require 链：node 20 真机 smoke（含 bundle 后 extension-protocol 常量引用），失败走「全量 bundle 闭包」降级。
3. D7 的 zsw 存量 record 兼容覆盖面（2c 前调研）。
4. core dist 的 d.ts 生成与 exports conditions 映射（先例 extension-protocol 的构建配置可直接参照，但 CJS 是首例）。
5. worker thread 链路对 HostServices 的零依赖断言（D2 推理依据实测：`orchestration/launcher.ts` 的 agent-call 经 postMessage 回主线程执行，AgentRunner 在主线程）——用现有 worker-exit/workflow-e2e 测试族加一条断言探针。降级路径：若断言翻车（worker 内确需宿主服务），退守 D2 被否方案②——HostServices 经 worker 构造参数以「可序列化的宿主调用描述」传递（worker 内只发消息，宿主侧执行），core 接口不变。
