# subagent-core 下沉收口设计（xyz-agent 侧：core 供给面 + pi-sw 消费改造）

> 一句话结论：core 大量已实现原语因 barrel 未导出而迫使两宿主复刻，本设计一次性补齐 core 供给面（barrel 扩面 + 组装层函数 + codec 单源 + git 内核参数化 + 动作层下沉），并以对照探针保障 pi 零回归；zcode 侧消费改造见姊妹文档 zcode-plugin-workspace 仓 `docs/design/zsw-sink-adoption-design.md`。

- 层声明：技术方案层 → 下一层 = 可实现接口与实施单元（core 模块契约 + pi-sw 改造单元）。
- 审查基线：feat-subagent-core-host-surface 分支（下沉审查三报告 RT1/RT2/RT3，2026-08-31）。

## 1 背景目标

### 1.1 SCQA

- **S（情境）**：subagent-core 是 pi-sw（本仓 extension）与 zsw（zcode 插件）两宿主的共享编排内核。收口设计（subagent-core-convergence-design，2026-08-30）已完成四大域收口：资产分发、资源发现、清单渲染、创作管线，两侧由同一份 core 代码供给。
- **C（冲突）**：2026-08-31 三路下沉完备性审查（RT1 同构对比 / RT2 zsw 逐文件 / RT3 pi-sw 逐模块）证实：core 内大量**已实现**的原语与组装逻辑未从 barrel（`src/index.ts` 导出面）导出。zsw 经 vendored 副本只能消费 barrel 导出面，未导出即物理不可达，被迫就地复刻；pi 虽走 workspace 深路径可达部分面，但组装层缺失使它同样各写一遍。已坐实 **5 处真实语义漂移**（非纯重复）：`..` 路径校验分叉（安全面）、watchdog 30min floor 丢失、block-scalar frontmatter 解析丢弃、WorkflowRun 快照 codec 双投影分叉、worktree patch 收集机制分叉。
- **Q（问题）**：双实现是持续漂移源——core 修 bug 宿主不受益、宿主各自演进互相不可见；「共享内核」的契约承诺在导出面之外的域名存实亡。下沉的完成态是什么？
- **A（答案）**：一次性完成全部下沉（用户裁决「一步到位」）：core 供给面一次扩齐，pi-sw 消费改造到位；zsw 侧改造由姊妹文档承载。本设计同时给出已分叉语义的统一裁决。

### 1.2 系统是什么

- **subagent-core**（`packages/subagent-core`）：引擎无关的子代理编排内核。核心面：双执行引擎（pi / zcode）、workflow 编排与脚本契约、资源发现（`resource-discovery`）、注入渲染（`injection-render`）、运行状态存储（FileRunStore 等）。发布形态：npm 包 + 自包含 bundle；zsw 宿主经 vendor 脚本把 **barrel 导出面**拷贝进插件，因此「core 能力 = barrel 导出面」是 zsw 视角的物理事实。
- **pi-sw**（`extensions/universal/subagent-workflow`）：pi 平台宿主。3 tool + 2 command + 注入器；经 workspace 深路径 import core（`@zhushanwen/subagent-core/...`），不受 barrel 限制——这是它历史上能就地补齐（m2 删本地 parser、C5 走 barrel）而 zsw 不能的结构原因。

### 1.3 设计目标（从使用者/维护者体验倒推）

| # | 目标 | 验证方式锚点 |
|---|---|---|
| G1 | **同一资产同一行为**：任一 agent .md / workflow 脚本在两宿主的解析、校验、预算、执行语义一致（含边界：block-scalar、`..`、maxTurns 换算） | §4 S1/S2 |
| G2 | **修复单源化**：core 修正任一下沉域的 bug，两宿主刷新后自动受益，无双实现同步负担 | §4 S3 |
| G3 | **第三宿主可达**：新宿主仅凭 barrel 导出面即可完成「列 agents / run workflow / 崩溃恢复」三件事，零复刻 | §4 S6 |
| G4 | **pi 零回归**：pi-sw 全部既有行为（含注入清单、工具面、TUI）语义不变——唯一例外为下述一项**声明的安全收紧**：normalizeRef 的 `..` 段校验（agent .md 与 workflow .js 引用同受此面，现状两宿主均放行，见 §2.1 例 2；收紧对 pi 是行为变更，⛔2 以样本集验证而非等值断言） | §4 S4 |
| G5 | **发版一次到位**：全部新导出面落同一 core minor（0.4.0），无二次破坏性扩面 | §5 版本节 |

### 1.4 Scope

**In scope**：core barrel 扩面（10 组原语）；组装层新函数（崩溃恢复 / agents 装配 / 参数 schema 助手 / runSummary）；WorkflowRun 快照 codec 单源化；worktree git 内核参数化（机制统一、锚点策略宿主注入）；原子写原语统一；subagent 动作层下沉 + execution 运行时面导出（D 簇，用户裁决纳入）；pi-sw 消费改造与壳内清理；已分叉语义的统一裁决。

**Out of scope**：zsw 侧消费改造与发版（姊妹文档）；zsw record 状态机迁移**实施**（本设计给出端口与方向裁决，物理迁移属 zsw 2.0.0 后另立项）；已裁决不收口的平台绑定面 7 项（平台事件接线、模型数据源读取、完成通知通道、prompt 拼装措辞、jsonout 三级提取、slots/zsub ledger/reaper 生命周期、CLI/MCP/hook 进程壳）；pi TUI 渲染族的下沉（平台 UI 面，仅做壳内去重）。

## 2 现状与问题分析

### 2.1 使用者视角：三个已发生的漂移实例

**例 1（预算语义分叉）**：用户给 agent 写 `maxTurns: 2`（预期「最多两轮，约 10 分钟内出结果」）。pi 侧：core watchdog `computeWatchdogMs = max(30min, maxTurns×5min)`（`session-runner.ts:133-140,180-182`），floor 生效 → 30min。zsw 侧：`manager.js:53-58` 自实现 `MS_PER_TURN = 300_000`，**无 floor** → 10 分钟被杀。同一配置两种命运，且 zsw 注释自认「对齐 pi watchdog 语义」——对齐靠注释不靠机制。

**例 2（安全校验双缺失）**：用户（或被诱导的模型）传 agent 引用 `/proj/../../etc/passwd.md`。pi 侧：`assertSafeStartPath` 仅守卫 skillPath/cwd（`subagent-tool.ts:316-317`），agent 参数直达 `normalizeRef`——`isAbsolute("/a/../b")` 为 true 直接**放行**（`agent-ref.ts:25-36` 无 `..` 校验）。zsw 侧：`agent-discovery.js:202-212` 仅校验绝对路径 + `.md` 后缀，同样放行。两宿主对该引用均无防御——本设计统一收紧（见 D3/⛔2，登记为两宿主共同的行为变更）。

**例 3（资产解析能力分叉）**：用户自建 agent .md（或未来 core 内置资产演进）使用 YAML block-scalar 写长 description。pi 路径：core `parseResourceMeta`（eemeli/yaml）正确解析 → 清单完整。zsw 路径：手写 mini parser（`agent-discovery.js:293-313`，仅支持 key: value / 行内数组）→ **description 被丢弃**。解析能力两侧不等：现 vendored 内置 10 角色均为单行 description 故内置资产暂未受害，但任何含标准 YAML 形态的资产（用户自建或资产演进）在 zcode 平台必然丢字段——这是能力缺口而非已发生的内置资产漂移。

### 2.2 双实现全清单（审查三报告聚合，20 条主题）

| 簇 | # | 能力 | core 现状 | pi-sw 现状 | zsw 现状 |
|---|---|---|---|---|---|
| A 导出面缺口 | A1 | agent-ref 面（normalizeRef/常量/displayAgentName/报错文案） | 已实现未导出（`shared/agent-ref.ts:25-57`） | 深路径可达 | 3 处复刻（`agent-discovery.js:202-261`、`orchestration-host.js:107-112`） |
| A | A2 | WorkflowScript 类 + 按路径加载工厂 | registry-impl 已有未导出 | 直接用 core 类 | 鸭子复刻整类（`orchestration-host.js:114-225`） |
| A | A3 | computeWatchdogMs | 已实现未导出 | 深路径内部消费 | 硬编码复刻（floor 丢失） |
| A | A4 | ConcurrencyPool（深度分层公式） | 已实现未导出（`concurrency-pool.ts:41-116`） | 经 core service 内部消费 | slots.js 复刻（公式逐字同源） |
| A | A5 | worktree git 内核 | worktree-manager 整类未导出 | 经 core service 消费 | worktree.js 289 行复刻（patch 机制已分叉） |
| A | A6 | agents 装配函数 | **缺失**（workflow 侧 discoverWorkflows 已出 barrel，agents 侧不对称） | 自写装配循环（`subagent-list-injector.ts:129-165`） | 自写装配（`agent-discovery.js:173-191`） |
| A | A7 | 全量 frontmatter 解析（宽容变体） | 严格层（meta-parser）+ 宽容层（agent-registry）均未以 profile 形态导出 | 已收敛 parseResourceMeta（仅注入投影） | 手写 mini parser（第三份） |
| A | A8 | 模型引用切分原语 | zcode preparer 内部（自认「zsub 同构」） | — | model-router 各持一份 |
| A | A9 | isProcessAlive（EPERM 判活） | alive-store 已有未导出 | — | 两处内联 |
| A | A10 | SLUG_MAX_LENGTH | execute-options-mapper:21 未导出 | 深路径消费 | 无闸 |
| B 组装层缺失 | B1 | 崩溃恢复装配（loadAll→failed→save→evict） | 只给了零件 | index.ts:578-627 手写 | recoverOrphans 手写（逐行同构） |
| B | B2 | WorkflowRun 快照 codec | FileRunStore 自带一份投影 | jsonl-run-store 另一份（strip live + 去抖） | 消费 FileRunStore | 
| B | B3 | 参数 schema→键集映射 | args-validator 只做校验 | argKeysFromMeta 动态构建 | normalizeRunParams 双份硬编码 |
| B | B4 | args 平铺检测 | 无 | findFlattenedArgKeys 有 | 无（裸奔） |
| B | B5 | runSummary 投影 + isScriptRunning | 无 | tool-workflow.ts:582-594 | orchestration-host.js:348-362（字段集已分叉） |
| B | B6 | 原子写原语 | 内部散布 6-7 份（tmp 命名各异） | — | 2 份（output-store/notifier-mailbox） |
| B | B7 | boundedPrettySerialize | 无 | helpers.ts:58-151（有测试锚定） | 裸 slice 截断 |
| C 单侧独有 | C1 | 磁盘保留策略 prune | FileRunStore 无 | jsonl-run-store 有（mtime 裁剪） | **workflow-state 无限累积** |
| C | C2 | 引擎感知状态机 | 无 | engine-awareness.ts（宿主注入式） | 无消费方（单引擎） |
| D 结构项 | D1 | subagent 动作层（六 handler+守卫链） | execution 运行时面（SubagentService 等）零 barrel 导出 | 承载全部动作逻辑 | 被迫自建 815 行 manager + 独立 record 状态机 |
| D | D2 | record 事件流存储 | 无对应实体 | —（pi 用 session 锚定 JsonlRunStore） | record-store.js（归属待裁决） |
| D | D3 | workflow ref 契约 | 无 normalizeWorkflowRef 统一原语 | 收裸名+路径 | 入口拒裸名/内层宽松，三层口径不一 |

### 2.3 根因分析

1. **导出面缺口是制度性诱因**：「core 实现了」≠「core 导出了」。zsw 的 vendored 形态把 barrel 变成物理边界——未导出 = 不可达 = 复刻。历史上 xml-injection 未出 barrel 导致 pi-sw 就地重写，收口时补导出后消除；本轮审查证明同款缺口仍在 agent-ref、watchdog、ConcurrencyPool、worktree、WorkflowScript、alive-store 六处重演。
2. **组装层缺失是第二诱因**：core 给了原语（loadAll/transition/evict、discoverResources/parseResourceMeta、args-validator）但没给装配（崩溃恢复四步、agents 清单装配、schema→键集映射）。装配逻辑是「两宿主都要、且必须一致」的语义，留在宿主就是两份。
3. **第一宿主惯性**：pi-sw 作为 core 的第一个宿主，历史上有大量「core 还没来得及收」时就地实现的逻辑；core 后续收口时 pi 逐步迁移（m2/C5），但迁移以「注入投影需要」为界——执行面（profile 全字段、动作层）从未列入。

### 2.4 物理数据流（导出面通道现状）

```
core src/**.ts ──tsup──▶ dist/index.cjs（bundle）
                          │
                          ├─ barrel src/index.ts 导出面 ══▶ zsw vendor 拷贝 ══▶ zsw lib/vendor/subagent-core/
                          │      （未导出的模块：zsw 物理不可达 → 就地复刻）
                          └─ workspace 深路径 @zhushanwen/subagent-core/execution/... ══▶ pi-sw 直 import
                                 （不受 barrel 限制，但组装层缺失时同样就地写）
```

关键结论：**barrel 是 zsw 侧唯一的供给通道**。一切「zsw 复刻了 core 已有逻辑」的 finding，其充分修复 = barrel 导出 + zsw 改消费；「两侧各写一遍组装逻辑」的 finding，修复 = core 新增组装函数并导出。

## 3 解决方案

### 3.1 终态（使用者/维护者视角）

**维护者视角**：core 导出面按域分组后新增六组（签名与语义见 §3.3 各决策）；zsw 与 pi-sw 的复刻文件收缩为适配层；本仓后续修任何下沉域 bug，只需改 core 一处。

**使用者视角（成功路径）**：zcode 用户给 agent 写 `maxTurns: 2`，实际超时 30 分钟（floor），与 pi 用户一致；内置角色的 block-scalar description 在两平台注入清单中同样完整；`zsw agents` 与 pi 注入清单对同一目录集产出同序同名（码点序）同一致性口径的清单。

**使用者视角（失败路径带恢复指引）**：某宿主 vendored 副本落后 core（缺新导出面）→ 启动自检（core-ref 符号守卫模式，已有先例 `test/core-ref.test.js:68-79`）报错：`vendored core 缺少导出符号 X —— 重跑 node scripts/vendor-subagent-core.js --local <core-checkout> 刷新，或核对 VENDOR-MANIFEST.json sha256`。使用者执行刷新即恢复，不出现静默降级。

### 3.2 方案对比

**D-策略：一次到位 vs 分批**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 单 wave 全量下沉（本设计） | 一次收敛，无「半收口态」残留；发版单 minor | 高（core 12 个单元 + pi-sw 1 批改造一次性落地） | 回归面大——靠对照探针 + 分单元独立验收兜住 | ✅ 用户裁决「一步到位」，且 5 处漂移正在发生，分批=漂移继续 |
| 分两 wave（导出面批 + 结构批） | 每批风险小 | 两轮发版、两轮宿主刷新、两轮回归 | A/D 簇跨批依赖（动作层下沉依赖 barrel 批次）；半收口态期间复刻仍在生产漂移 | ❌ |

**D-barrel：扩面形态**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 纯新增导出（index.ts 增补 export，不动既有导出） | 零 break，单一 minor 承载 | 低 | 导出面变大（一次 +40 余符号）——用分组注释与文档对冲 | ✅ |
| index 重构（分域子 barrel + re-export） | 结构更清晰 | 高（zsw vendor 的 sha256 manifest、pi 深路径 import 双受影响） | 路径变更波及 pi 24 处消费文件（grep 实测 `@zhushanwen/subagent-core/` 深路径 import 的非测试文件数） | ❌ 纯结构收益不值当回归面 |

**D-解析：宽容解析变体 API 形态**（A7）

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| (a) agent-registry 提取面导出为 `parseAgentProfile`（宽松：缺 description 不拒、name 缺省 stem、返回全字段含 body），AgentMeta 扩可选执行字段（maxTurns/disallowedTools/skills）。实现基础 = `parseResourceMeta`（eemeli/yaml 全量解析，原生支持 block-scalar 与多行 `- item` 数组）为主、meta=null 时 `extractYamlField` legacy fallback（仅单行 key:value）兜底——zsw mini parser 的多行数组形态由主路径原生覆盖，fallback 仅在 yaml 整体解析失败（资产格式异常）时触发 | 执行字段进 core 契约与 engine 字段同路径，双宿主 + 资产演进同源 | 中（core 扩类型 + 导出） | AgentMeta 面变宽需文档声明可选性 | ✅ |
| (b) meta-parser 新增 `parseAgentProfileLoose` 独立函数 | core 类型面不动 | 低 | 双解析入口并存（严格/宽松），语义边界靠约定 | ❌ 两入口是新的分叉温床 |
| (c) zsw 继续手写、仅修 block-scalar | 零 core 改动 | 最低 | 第三份 parser 长存，maxTurns/字段演进继续分叉 | ❌ 不解决根因 |

**D-codec：WorkflowRun 快照 codec 单源形态**（B2）

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| codec 下沉共享：core 出 `WorkflowRunSnapshot` 编解码器（toSnapshot/fromSnapshot + 版本 guard + live-strip 防御），FileRunStore 与 pi JsonlRunStore 共同消费，各自保留 IO 策略（append-only vs rewrite、去抖归属 store 层）。**版本衔接**：版本值沿用 pi 现有字符串形态 `"wf-run-v2"`（保 pi 存量可读）；FileRunStore 存量无版本字段的行按「缺版本 = 当前版本」宽容读取（写入时补 v 字段，不做自动迁移——对齐 pi「不做兼容迁移」先例）；guard 语义 = 未知更高版本跳过该行并 warn（对齐 pi 静默跳过语义，补可见性）。FileRunStore 改 strip live 后落盘字节变化登记为内部行为变更（live 字段 running 期存量行含 live 键，strip 同时消除旧 fromSnapshot 的重水合脏数据；消费面无合法消费方） | 投影单源、IO 策略宿主各异（合法差异显式化）、存量两侧均可读 | 中 | pi rewrite 模式切换行为需对照探针 | ✅ |
| pi 改用 core FileRunStore（消灭 JsonlRunStore） | 完全单源 | 高（pi session 锚定语义、GUI 消费面全动） | pi 行为回归风险大，违背 G4 | ❌ |
| 维持双 codec、加字段联动测试 | 无架构改善 | 低 | 测试锚定 ≠ 单源，漂移继续 | ❌ |

**D-worktree：git 内核参数化形态**（A5）

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| git-ops 纯函数内核下沉（dirty 谓词 isTreeDirty / collectWorktreePatch / cleanupWorktree / listWorktreePorcelain / 保真读 / GitRunError；宿主组合 isTreeDirty+throw 即得 ensure 语义），**基线锚点抽象化**（内存 baseCommit 或宿主持久锚点文件二选一注入），目录布局与孤儿判定留宿主 | git 语义单源（MF#2 类修复一处生效），锚点/布局/孤儿策略的宿主差异显式化 | 中（zsw sidecar 机制映射为持久锚点实现） | patch 产物字节级差异（intent-to-add vs add -A+cached）——两机制解同一问题（MF#2），统一到 core 现机制，zsw 侧对照验证 | ✅ |
| WorktreeManager 整类导出 + 构造注入 | 宿主改动最小 | 低 | core 类内嵌全局注册表/写队列/pi 布局假设，参数化面越挖越深 | ❌ |
| 维持双实现 + 行为对账测试 | 无 | 低 | 机制级分叉持续（现状即证明） | ❌ |

**D-action：subagent 动作层下沉路径**（D1）

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 两步：① core barrel 导出 execution 运行时面（SubagentService / record 查询 / agent-registry 的执行消费面）；② 动作 handler 的领域内核（校验/守卫链/归属判定/状态映射，`subagent-actions.ts` 中零 pi-API 部分）下沉为 core 服务函数，pi adapter 与 zsw（后续）共同消费 | 动作语义单源；zsw manager 长期收敛为壳 | 高（领域内核剥离需逐 handler 重演守卫链） | record 状态机模型差异（zsw 四态 vs core running/closed）——本设计只统一**端口查询面**，物理迁移 out of scope | ✅（分步内的第①②步在本 wave） |
| 只导出 SubagentService、pi 保留动作层 | 成本低 | 低 | 动作语义双实现延续（现状最大一块双实现不动） | ❌ 与 G2 冲突 |
| 一步迁移 zsw record 状态机到 core 模型 | 完全单源 | 极高 | zsw record 落盘格式 break、跨 2.0.0 发版，超出本 wave 层级 | ❌（裁决另立项） |

### 3.3 关键决策与权衡

**D1：下沉策略为单 wave 全量（选定）**
- **采用**：§5 全部单元（U1-U12）同一 wave 实施、同一 core minor 发版；单元间以「可独立验收」解耦，不设批间等待。
- **被否**：两 wave 分批——半收口态期间 5 处已发生漂移继续扩大，且 A 簇（barrel）与 D 簇（动作层）存在依赖（动作层下沉消费 barrel 新面），跨 wave 等待无收益。
- **证据**：§2.2 漂移实例均为「现网正在分叉」而非历史遗留；用户裁决（2026-08-31「一步到位做到底」）。
- **效果**：G5 成立（单 minor）；§4 各场景可按单元分组执行。

**D2：barrel 纯新增导出（选定）**
- **采用**：`src/index.ts` 增补导出，既有导出符号与路径零变更；导出按域分组注释（agent-ref 面/workflow 契约面/worktree 内核/运行时面/快照 codec/原语）。
- **被否**：分域子 barrel 重构——pi 24 处深路径 import 与 zsw vendor sha256 manifest 双受波及，结构收益不值回归面。
- **证据**：grep 实测 24 个非测试文件含 `@zhushanwen/subagent-core/` 深路径 import；vendor 脚本按主入口单一解析（`scripts/vendor-subagent-core.js:137-141`）。
- **效果**：G4 的 barrel 面零回归；zsw 刷新后立即可达全部新面。

**D3：宽容解析走 `parseAgentProfile` + AgentMeta 扩可选执行字段（选定）**
- **采用**：core 新导出 `parseAgentProfile(text, filePath): AgentProfile`（宽松语义：无 frontmatter 不拒、name 缺省 stem、description 缺省空串、返回 body 与执行字段全量）；`AgentMeta` 增可选 `maxTurns?/disallowedTools?/skills?`。pi 注入投影继续走 parseResourceMeta（不回归），执行消费面两宿主统一走 parseAgentProfile。**双轨定性**：严格注入投影（路由可见性：缺 name/description 不进清单）与宽容执行解析（执行可用性：可用即跑）的分离是两宿主**既有设计**而非本设计制造的漂移——本设计消灭的是执行侧第三份手写实现。**字段形态覆盖矩阵**：主路径 parseResourceMeta（eemeli/yaml）原生支持单行 key:value、行内数组、block-scalar、多行 `- item` 列表（覆盖 zsw mini parser 全部形态并超出）；fallback 路径 extractYamlField 仅单行——仅在 yaml 整体解析失败时触达（此时资产本身格式异常，warn 可见）。**maxTurns 消费优先级声明**：显式参数 > frontmatter > 缺省——pi 侧工具参数 maxTurns 为显式参数语义不变，frontmatter 值对 pi 是清单元数据（pi 现不消费 frontmatter maxTurns，维持）；zsw 侧 timeoutMs flag 为显式参数，决策链 timeoutMs > profile.maxTurns > 缺省不变。
- **被否**：(b) 双解析入口并存——严格/宽松边界靠约定，是新的分叉温床；(c) zsw 继续手写——第三份 parser 长存，违背 G1。
- **证据**：zsw 现行为「无 frontmatter 的 .md 仍可用」（`agent-discovery.js:293-313`）必须保持——硬换严格解析会拒绝存量用户资产（行为回归）；core agent-registry 已有宽容提取先例（`agent-registry.ts:81-121` legacy fallback）。
- **效果**：G1 的 block-scalar/maxTurns 分叉消解；zsw 手写 parser 退役；路由/执行双轨既有语义显式化防误读。

**D4：快照 codec 下沉共享，IO 策略留宿主，版本衔接三裁决（选定）**
- **采用**：core 新模块 `orchestration/run-snapshot.ts`：`toRunSnapshot(run)` / `fromRunSnapshot(s)` / 版本常量 + live-strip 防御内聚；FileRunStore 与 pi JsonlRunStore 改消费。rewrite/去抖/append 差异归属各 store。**版本衔接**：① 版本值沿用 pi 现有字符串 `"wf-run-v2"`（pi 存量逐字节可读，⛔5 得以成立）；② FileRunStore 存量行（无 v 字段）按「缺版本 = 当前版本」宽容读取，写入时补 v 字段，不做自动迁移（对齐 pi「不做兼容迁移」先例；zsw 现网 workflow-state 存量全部可恢复——姊妹文档 §4 S5 验收覆盖）；③ guard 语义 = **v 不匹配当前版本即跳过该行 + warn**（字符串版本无大小序，不引入比较逻辑；对齐 pi 静默跳过语义并补可见性）。**两 store 读 guard 差异归属**：「缺 v 宽容」仅 FileRunStore 路径，实现于 store 层预处理（读出的行先补缺省 v 再进 codec），不内聚进 codec——保 pi 侧「v1 存量静默跳过」既有语义不被宽容化误读。FileRunStore 改 strip live 属落盘字节变化：live 字段在 call 运行期有真实赋值点（error-recovery.ts node 构造处），running 期 save 的存量行含 live 键，strip 后落盘字节变化真实可见（旧 fromSnapshot 会把 live 重水合为 plain object 脏数据，strip 同时修复该缺陷）；消费面无合法消费方故无功能回归。另：core codec 剔除 spec.budgetRef（嵌套 run 的 Budget 共享引用落盘会退化为脏字段）——⛔5 的逐字节一致断言对不含 budgetRef 的 run 成立，嵌套 run 落盘少 budgetRef 脏字段已按实施计划偏差登记。
- **被否**：pi 改用 FileRunStore——session 锚定与 GUI 消费面全动，违背 G4；双 codec+联动测试——锚定不等于单源；数值版本 + 高版本抛错——与 pi 字符串版本存量及「静默跳过」语义互斥（审查 MF-2 击穿）。
- **证据**：两份投影字段集一致但语义细节分叉（strip live、去抖），`index.ts:209-212` barrel 注释自认双实现；pi `jsonl-run-store.ts:90` `SNAPSHOT_VERSION="wf-run-v2"` 字符串相等比较、`:217` 不匹配返回 null 静默跳过；core `file-run-store.ts:70-84` RunSnapshot 无 v 字段。
- **效果**：WorkflowRun 字段演进单点；两侧存量数据零迁移可读；G2 成立。

**D5：worktree 走 git-ops 纯函数内核 + 基线锚点抽象，降级路径显式留痕（选定）**
- **采用**：core 新模块 `execution/worktree-git-ops.ts`：保真读（stdout 不 trim）、GitRunError/SafeId、dirty 谓词、`collectWorktreePatch(anchor): Promise<{ patchFile, written, patchIncomplete?: boolean }>`（统一 add + diff 基线机制；返回结构即 `patchIncomplete` 留痕载体，宿主透传至 record/summary 的责任在姊妹文档 V6）、三步容错清理、`listWorktreePorcelain`（输出保持 git 原始形态，供宿主 realpath 对账——zsw 的 /var→/private/var 归账依赖原始输出）。`anchor` 为基线锚点抽象：内存 baseCommit 或宿主持久锚点文件（zsw sidecar 语义）由宿主实现注入——core baseCommit 本就持久化于 worktrees.json 注册表（`worktree-manager.ts:155-220`），两形态均有真实先例。**两条降级路径显式化（对 zsw 现状静默降级的改造裁决）**：① 锚点缺失/损坏 → **显著 warn + 降级裸 diff（仅未提交改动）+ 留痕 `patchIncomplete: true`**——不采 fail-fast（任务已完成的执行工作不应因 patch 收集作废），也绝不维持现状的纯静默（静默丢已提交改动使上层拿到残缺 patch 无法察觉；warn+留痕保证可判断）；② add 步骤失败 → 非致命继续 diff（裸 diff）+ warn + 留痕 `patchIncomplete: true`——**非致命语义对齐 zsw 现状（`worktree.js:188-192`），降级形态按 core 机制重定义**（core 的 `diff --cached` 依赖 add，失败退裸 diff 较 zsw 现状 `diff <base>` 多丢已提交改动，损失面差异由留痕可判断）——add 已内聚于本函数，宿主不可自行维持容错，故契约必须显式（审查 F17）。prepare 阶段写锚点失败不阻断任务启动（维持 zsw 现可用性语义）。目录布局、孤儿判定策略留宿主。
- **被否**：WorktreeManager 整类导出——内嵌注册表/写队列/pi 布局，参数化面不可控；维持双实现——patch 机制分叉持续；锚点丢失 fail-fast（初版方案）——被审查击穿：zsw 现网存在 prepare 写 sidecar 前崩溃的真实命中路径（`worktree.js:164-169`），fail-fast 使该场景从「部分 patch」变为「任务作废」，损害大于收益（记入被否谱系）。
- **证据**：patch 收集两机制（intent-to-add+工作树 diff vs add -A+cached diff）解同一问题（MF#2：新文件+已提交改动必须进 diff）；zsw sidecar 持久锚点是跨 daemon 重启的真实需求（`worktree.js:10-33` 铁律）。
- **效果**：git 语义单源；zsw 289 行收缩为锚点+布局适配（zsw 侧文档承载）；锚点异常从静默变为可观察。

**D6：动作层两步下沉——execution barrel 导出 + 领域内核下沉（选定）**
- **采用**：① barrel 导出 execution 运行时面，符号清单（分四类）：`SubagentService` 类 + `SubagentServiceInit` 类型 + `createSubagentService(deps)` 工厂（构造依赖 modelService/PiLike/uiRequestHandler 以参数注入，`subagent-service.ts:300-321` 现构造面如实导出）；record 状态查询面（按状态枚举/按 id 查询）；agent-registry 执行消费面（loadByPath/lookupRecordAnyState 类）；错误类型族。semver 承诺：execution 面标注 `@experimental`（一个 minor 周期内允许签名微调，文档明示），稳定面（§3.3 其余决策的导出）常规 semver。② `subagent-actions.ts` 中零 pi-API 的领域内核（六 handler 的校验、守卫链、归属判定、终态映射）下沉 core `execution/subagent-actions-core.ts`，pi adapter 收缩为「参数提取 + core 调用 + TUI 渲染」。第三宿主最小构造示例随 U10 交付（含 SubagentService 构造注入样例）。
- **被否**：一步迁移 zsw record 状态机——zsw record 落盘格式 break 属 major 语义变更，且 zsw manager 收敛依赖其 2.0.0 发版窗口，out of scope（裁决：zsw 侧另立项，方向已在姊妹文档登记）。
- **证据**：`subagent-actions.ts:293-705` 六 handler 经逐行核实仅依赖 SubagentService + 纯数据变换（审查复测确认零 pi-API）；zsw manager 815 行中约 60% 与 pi 动作层语义同构（RT3-F3 对照）。
- **效果**：pi 动作适配层收敛为壳、第三宿主零复刻动作层；**zsw manager 本 wave 不动**（record 迁移 out of scope），zsw 侧动作双实现的最终收敛在姊妹文档 V 系列完成——本 wave 达成的是「供给面就绪」。

**D7：并发池导出 + 排队策略参数化（选定）**
- **采用**：barrel 导出工厂 `createConcurrencyPool({ maxConcurrent, queuePolicy: 'priority' | 'strict-fifo' })`（与 U4 定稿签名一致，缺省 priority 维持 pi 行为）；zsw slots 消费 strict-fifo（zsw 侧文档承载）。
- **被否**：维持 slots 独立——分层公式与下限常量双份维护（公式已逐字同源，注释互抄即漂移前兆）。
- **证据**：`concurrency-pool.ts:24-26` 接口注释与 `slots.js:29-31` 公式同源；排队策略差异是宿主声明过的有意决策（保留为参数而非消灭）。
- **效果**：并发预算语义单源、策略差异显式化。

**D8：组装函数进 core——recoverCrashedRuns / prune / runSummary（选定）**
- **采用**：`recoverCrashedRuns(store, runs, reason, hooks?)` 自由函数（lifecycle 域）——pi 现恢复循环含 pi 专属 `pending:unregister` 事件发射，以 `hooks` 回调参数外置（宿主注入，core 保持平台中立）；FileRunStore 增 `pruneStateFilesBeyondCap(max, envName)`（C1，语义对齐 pi jsonl-run-store 实现）；`runSummary(run)` 与 `isScriptRunning(runs, name)` 出 barrel（字段以 core WorkflowRun 为准，宿主可扩展投影）。
- **被否**：恢复/prune 留宿主——「两宿主都要且必须一致」的语义（G2 直接反例）；runSummary 双投影字段分叉已实锤（workflow vs name）。
- **证据**：pi `index.ts:579-627` 与 zsw `orchestration-host.js:566-580` 逐行同构（pi 侧 pending:unregister 为唯一宿主差异点）；pi `jsonl-run-store.ts:359` prune 实现纯 fs 可平移。
- **效果**：zsw workflow-state 无限累积问题随 prune 消解；恢复语义单源且宿主扩展点显式。

**D9：schema 助手下沉——normalizeArgsByMeta + findFlattenedArgKeys（选定）**
- **采用**：core `orchestration/args-meta.ts`：`argKeysFromMeta(meta)`（schema→已知键集）、`findFlattenedArgKeys(params, meta)`（平铺检测）、`normalizeArgsByMeta(params, meta): { args, warnings }` 组装函数；pi tool-workflow 改消费（删本地 argKeysFromMeta），zsw 白名单退役改消费（姊妹文档承载）。
- **被否**：zsw 继续硬编码——pi 已用 m6 教训删过 21 键硬编码，zsw 重蹈中；平铺检测不下沉则 zsw 持续裸奔同类事故。
- **证据**：`tool-workflow.ts:136-196` 纯函数零平台依赖；zsw `normalizeRunParams:326-334` 白名单与 vendored 资产 @pi-meta parameters 双份声明。
- **效果**：资产加参数两宿主自动可见（G1/G2）。

**D10：pi 零回归由对照探针保障（选定）**
- **采用**：实施前对 pi 真实 agentDir 跑「发现清单快照」（每条含 source 标签、胜出路径、码点序）与「注入两段 XML 快照（available_subagents / available_workflows；provider_models 段因 auth 态派生属非确定字段排除，见实施计划 wave1 偏差登记）」；实施后同目录集重跑 diff，要求逐项一致。快照探针纳入 §5 U12，作为实施期门（⛔→✅）。
- **被否**：仅靠全量单测——单测锚定的是实施后代码自身，探针锚定的是「改前=改后」这一外部事实。
- **证据**：收口设计 W2 的 hostRoots Map→列表改造即用对照探针验收（先例有效）。
- **效果**：G4 可证伪、可执行。

**错误规格（新增失败路径）**

| 失败 | 触发 | 恢复指引 |
|---|---|---|
| vendored 副本缺新导出符号 | 宿主未刷新即升级代码 | core-ref 符号守卫报错（模式已有）：重跑 vendor --local / --npm 刷新 + sha256 自检（npm/marketplace 形态用户恢复指引 = 升级插件包版本，姊妹文档 §3.1 分众承载） |
| parseAgentProfile 遇不可解析 .md | 资产损坏 | 返回 `{ name: stem, body, warnings[] }` 宽容降级，不抛——与 zsw 现行为一致，pi 投影面不受影响（仍走严格层） |
| collectWorktreePatch 锚点缺失/损坏 | 宿主锚点文件缺失（prepare 期未写成）或损坏 | **显著 warn + 降级裸 diff（仅未提交改动）+ 留痕 `patchIncomplete: true`**（返回结构定义见 U5）；`listWorktreePorcelain` 供人工对账。不做 fail-fast（任务执行成果不应因 patch 收集作废），不做纯静默（现状缺陷，审查 MF-4 击穿后改裁决，被否谱系见 D5） |
| collectWorktreePatch add 步骤失败 | git add 非致命错误（如索引锁冲突瞬时态） | 非致命继续 diff（裸 diff）+ warn + 留痕 `patchIncomplete: true`（对齐 zsw 现状 `worktree.js:188-192`；add 已内聚于 core 函数，宿主不可自行维持容错——审查 F17 补契约） |
| codec 版本高于代码 | 快照行 v 字段为未知更高版本 | fromRunSnapshot 跳过该行 + warn（对齐 pi 静默跳过语义，补可见性）；缺 v 字段（FileRunStore 存量）按当前版本宽容读取，不做自动迁移 |

## 4 验收

以下场景全部使用真实依赖（真实 pi agentDir、真实 vendored 刷新、真实 git 仓），禁止 mock 替代。每个场景标注回溯目标。

**S1 资产行为一致性（G1）**：在 `~/.zcode/agents/` 放置测试资产 `t-sink.md`（注：pi 宿主不扫描 `~/.zcode/agents`——S1① 的 pi 侧验证经 fixture agentDir + 真机 agentDir 注入快照承载（U12 探针）；`~/.zcode/agents` 放置仅服务 S1② zsw 侧）（block-scalar description + `maxTurns: 2` + 多行 `- item` 形态的 `tools` 列表，覆盖 zsw mini parser 全部形态）。① pi 真机会话注入清单含该 agent 且 description 完整；② `zsw agents`（zsw 侧实施后）清单同一 description 与 tools 投影；③ 两平台对 `/x/../etc/passwd.md` 引用均拒绝（本设计收紧后两宿主一致——现状两宿主均放行，此为声明的共同行为变更）。通过标准：三步全过。回溯 G1。

**S2 预算一致性（G1）**：`maxTurnsToWatchdogMs(2) ≥ 1_800_000`（floor 断言，函数级真实调用）+ pi 真机短轮派发一轮断言 watchdog 挂载时长日志 ≥30min 等价值 + zsw CLI 同款。通过标准：两侧换算一致。回溯 G1。

**S3 修复单源化（G2）**：core 修改一处 workflow 校验错误文案 → 重跑 vendor → zsw 侧错误消息同步变更，zsw 零代码改动。通过标准：消息 diff 仅来自 core。回溯 G2。

**S4 pi 零回归（G4）**：① U12 对照探针：实施前后同目录集发现清单/注入 XML 快照逐项一致；② pi-sw 全量测试绿（基线 2541+）；③ 真机 pi 会话跑一轮 subagent 派发 + workflow run 冒烟。通过标准：三项全过。回溯 G4。

**S5 第三宿主模拟（G3）**：以 barrel 导出面清单为唯一依据（不看 core 源码内部），编写最小集成脚本完成：经 `discoverAgents` 列 agents、经 `normalizeWorkflowRef` + registry run 一个内置 workflow（带参数）、经 `recoverCrashedRuns` 触发一次崩溃恢复（kill -9 后 loadAll→recover，含 hooks 回调注入样例）。通过标准：三步仅凭导出面完成。回溯 G3。

**S6 原子写统一（G2）**：确定性场景为主——手工构造半截目标文件 + 残留 tmp 文件各 3 组（覆盖 manifest/sessions-index/workflow-state 三处布局），断言统一扫描恢复/清理语义一致；辅以 kill -9 随机打断各 10 次验证 rename 窗口外无损坏。通过标准：确定性场景全过 + 随机场景无损坏。回溯 G2。

**S7 负面验证——探针不误报（G4）**：在未改动 pi 行为的无关提交上重跑 U12 探针，diff 必须为空（防止探针本身脆弱导致实施期误判）。回溯 G4。

**S8 发版链路（G5）**：core 0.4.0 发布 → zsw `--npm 0.4.0` 刷新 → zsw core-ref 符号守卫（含本文档全部新导出符号清单）全绿。通过标准：链路一次通过。回溯 G5。

## 5 下一层拆分

### 5.1 实施路径

三阶段交付（同一 wave 内顺序执行，每阶段可独立验证）：
- 阶段一（core 供给面）：U1-U9 —— 纯新增导出与新模块，pi/sw 零改动即可合入（ barrel 纯新增对两宿主零影响）。
- 阶段二（pi-sw 消费改造）：U10-U11 —— pi 切换消费新面 + 壳内清理，U12 探针门验收。
- 阶段三（发版）：版本 0.4.0 changeset 消化（与既有 pending minor changeset 合并窗口）。

### 5.2 拆分清单

| 单元 | 内容 | justification |
|---|---|---|
| U1 | barrel 批次一（契约面集中）：agent-ref 面（normalizeRef/AGENT_REF_EXT/WORKFLOW_REF_EXT/displayAgentName，`..` 段拒绝并入 normalizeRef）+ 报错文案工厂（invalidAgentRefMessage(ref, {howToList?})）+ **workflow ref 原语 `normalizeWorkflowRef(ref, {knownNames})`**（名/路径二分 + 保留字裁决 + 内置名优先策略，knownNames 宿主注入）+ **WorkflowScript 类与 `loadWorkflowScriptByPath(path)` 工厂**（自 workflow-script-registry-impl 导出）+ **模型切分原语四件**（splitZcodeModelRef/DEFAULT_PROVIDER_ID/ZCODE_FALLBACK_DEFAULT_MODEL/hasApiKey，自 zcode preparer/constants 提升为共享导出）+ SLUG_MAX_LENGTH + isProcessAlive | 契约面一次导出齐——审查 MF-1/R2-F1-F3 击穿初版拆分「四组符号无供给单元」，全部补入同单元以保跨文档契约闭环；`..` 是安全修复须最先可用（A1/A2/A8/A9/A10 + D3 行缺口） |
| U2 | `parseAgentProfile` 宽容解析 + AgentMeta 可选执行字段（maxTurns/disallowedTools/skills）+ **`discoverAgents(workspaceRoot, hostRoots): Promise<AgentEntry[]>` 装配函数**（发现→parseAgentProfile→frontmatter name 去重→码点序，warn 口径内聚；workflow 侧 discoverWorkflows 的对称面） | D3 裁决落地 + A6 装配缺口裁决为「做」（审查 MF-1 指出初版决策悬空；G3/S5 的「列 agents」硬依赖）；zsw 第三份 parser 退役的前置（A7） |
| U3 | computeWatchdogMs 导出（语义化名 `maxTurnsToWatchdogMs`，floor 语义文档化） | 漂移已发生（floor 丢失），独立小单元先行（A3） |
| U4 | 并发池导出：工厂 `createConcurrencyPool({ maxConcurrent, queuePolicy: 'priority' \| 'strict-fifo' })`（缺省 priority 保 pi 行为；避免暴露 DefaultConcurrencyPool 类名与位置参数构造） | 策略差异显式化，pi 缺省零回归；签名定稿消解跨文档不一致（A4/D7/R2-F9） |
| U5 | worktree-git-ops 模块（D5 裁决全量：保真读/GitRunError/dirty 谓词/`collectWorktreePatch(anchor): Promise<{ patchFile, written, patchIncomplete?: boolean }>`（返回结构即 patchIncomplete 留痕载体，宿主透传至 record/summary 的责任在姊妹文档 V6）/cleanup/listWorktreePorcelain 原始形态输出） | 机制分叉收敛，锚点抽象使 zsw sidecar 语义可保留（A5） |
| U6 | `shared/atomic-write.ts` 原子写原语 + core 内部 6-7 处迁移 | 横切原语，tmp 命名统一后崩溃残留扫描可共享（B6） |
| U7 | recoverCrashedRuns（含 hooks 回调参数外置宿主事件，pi pending:unregister 先例）+ FileRunStore.pruneStateFilesBeyondCap + runSummary/isScriptRunning | 三个组装/投影函数同属「宿主各写一遍」域（B1/B5/C1/D8） |
| U8 | run-snapshot codec（toRunSnapshot/fromRunSnapshot/版本常量 `"wf-run-v2"` 衔接语义 + live-strip），FileRunStore 切换消费（缺版本存量宽容读 + 写入补 v + strip live） | D4 裁决落地（含审查 MF-2 版本衔接三裁决）；pi JsonlRunStore 切换在 U11（B2） |
| U9 | args-meta 助手（argKeysFromMeta/findFlattenedArgKeys/normalizeArgsByMeta） | D9 裁决落地（B3/B4） |
| U10 | execution 运行时面 barrel 导出（D6 符号清单四类：SubagentService + SubagentServiceInit + createSubagentService 工厂、record 状态查询面、agent-registry 执行消费面、错误类型族；`@experimental` 标注 + 第三宿主最小构造示例）+ subagent-actions-core 领域内核下沉（六 handler 校验/守卫链/归属判定/终态映射） | D6 裁决；供给面就绪（zsw manager 收敛在姊妹文档 V 系列完成）（D1） |
| U11 | pi-sw 消费改造：动作层切 core 内核、JsonlRunStore 切 codec、injector 装配循环改 `discoverAgents`、boundedPrettySerialize 下沉 shared、format.ts/views 格式函数合并（宿主内）、死导出清理、workflow-list-injector 排序改 sortByCodepoint | 全部 pi 侧行为等值切换，U12 探针门验收（D6/D4/A6/B7/壳内清理） |
| U12 | 对照探针 + 回归保障：发现清单/注入 XML 前后快照、S1-S8 场景脚本化 | G4 的可证伪保障（D10） |

### 5.3 文件改动地图（core）

- `src/index.ts`：+6 组导出（U1-U10，组划分见 §3.3 D2）
- `src/shared/agent-ref.ts`：normalizeRef 增 `..` 段拒绝（**对两宿主均为行为变更**——现状两宿主均放行，安全收紧已登记，见 G4 与 ⛔2）
- `src/shared/atomic-write.ts`：新增（U6）
- `src/execution/agent-registry.ts`：parseAgentProfile 导出形态（U2）
- `src/execution/agents-assembly.ts`：新增（U2，discoverAgents 装配函数载体）
- `src/shared/bounded-serialize.ts`：新增（U6a，boundedPrettySerialize 下沉目标，§2.2 B7）
- `src/shared/resource-meta.ts` + `src/shared/meta-parser.ts`：AgentMeta 扩可选执行字段的类型与 typecheckMeta 投影落点（U2/D3）
- `src/execution/session-runner.ts`：computeWatchdogMs 抽出为可导出纯函数（U3）
- `src/execution/concurrency-pool.ts`：createConcurrencyPool 工厂 + queuePolicy 参数（U4）
- `src/execution/worktree-git-ops.ts`：新增（U5）
- `src/execution/subagent-actions-core.ts`：新增（U10，自 pi-sw subagent-actions 迁移领域内核）
- `src/orchestration/workflow-script-registry-impl.ts`：WorkflowScript 类与按路径加载工厂导出形态（U1）
- `src/execution/engine/engines/zcode/`（preparer/constants）：模型切分原语提升为共享导出（U1，实现体内聚不挪文件，barrel re-export）
- `src/orchestration/file-run-store.ts`：切 codec + prune（U7/U8）
- `src/orchestration/run-snapshot.ts`：新增（U8）
- `src/orchestration/lifecycle.ts`：recoverCrashedRuns（U7）
- `src/orchestration/args-meta.ts`：新增（U9）
- `src/orchestration/workflow-run-summary.ts`（或 lifecycle 邻位）：runSummary/isScriptRunning（U7）

### 5.4 待验证检查点（实施期门）

| # | 检查点 | 断言 | 状态 |
|---|---|---|---|
| ⛔1 | U12 对照探针基线 | 实施前快照生成且 S7 负面验证通过 | 实施期 |
| ⛔2 | `..` 收紧样本集 | 样本集覆盖：`/x/../y.md` 与 `/x/../y.js`（normalizeRef 为 agent/workflow 双消费面）两宿主均拒、`~/` 合法路径不误伤、skillPath/cwd 既有 assertSafeStartPath 拒绝保持——收紧是**声明的行为变更**（现状两宿主均放行），非等值断言 | 实施期 |
| ⛔3 | patch 机制切换对照 | zsw sidecar 场景（新文件+已提交改动+跨重启）在 core 锚点抽象下产物等价（zsw 侧验收，此处出锚点 API）+ **锚点缺失/损坏与 add 失败分支：warn 发出 + 降级裸 diff + `patchIncomplete` 留痕（返回结构见 U5）** | 实施期（跨文档） |
| ⛔4 | 动作内核迁移守卫链等值 | pi 六 handler 行为快照（含错误文案锚）迁移前后逐项一致 | 实施期 |
| ⛔5 | codec 存量往返等值 | pi 侧含 live 字段 run 的快照往返与实施前逐字节一致（v 字段保持 `"wf-run-v2"`；不含 budgetRef 的 run——嵌套 run 落盘少 budgetRef 脏字段已按偏差登记，见 D4 补充）；FileRunStore 存量无 v 行读取不丢数据 | 实施期 |

### 5.5 版本与发版

- 全部新导出面落 **0.4.0**：与既有 pending minor changeset（`subagent-core-convergence-0.4.0.md`）同窗发布，不新增独立 changeset 文件（同一 minor 语义）。
- 发版时序：本仓 U1-U12 完成 + Gate 绿 → core 0.4.0 发布（用户侧流程不变）→ zsw 侧 `--npm 0.4.0` 刷新 + 消费改造（姊妹文档 U/V 单元）。
- pi-sw 随本仓同节奏发版（无独立 npm 面，extension 随仓）。
