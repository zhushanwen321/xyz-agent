# Runtime 层详细设计（D1-D9）

> 本文件是 [README.md](README.md)（36 候选总纲）的 runtime 层子文档，覆盖审查报告 §3 runtime 章节的 9 个候选改进项。五段骨架：背景目标 → 现状与问题分析 → 解决方案（多方案对比）→ 验收 → 下一层拆分。
>
> **事实修正说明**（审查后二次核实，与本文件正文一致）：
> - event-adapter 实际路径 `infra/pi/event-adapter.ts`（审查报告写 `infra/event-adapter.ts` 有误）；event-interpreter 实际路径 `services/session/event-interpreter.ts`
> - session-service 实际路径 `services/session/session-service.ts`；interfaces.ts 在 `packages/runtime/src/interfaces.ts`
> - services→infra 泄漏按核实后口径：白名单外 **6 处** import（3 值导入 + 3 type-only，非审查报告标题的「5 处值导入」——其内部已自注 ⚠️ 口径不自洽）
> - 主文档 §3 波次计划 W4 段落将 D7 误列（总览表与验收口径均为 W3），本文件按总览表：**D7→W3**

## §1 背景与目标

**SCQA**：2026-08-13 架构审查对 runtime 层（52.5k 行，transport/services/infra 三层 + ports 依赖倒置）做了包级/进程级整体审查 + 四层内部模块深度审查。结论：**三层 DAG 骨架成立**（infra 零 transport import；logger/pi-paths 的 services→infra import 是 `runtime-three-layer-design.md` 声明的受控例外，合规），但骨架被四类侵蚀：**回潮无守护**（D1）、**port 单实现税**（D2/D3）、**transport 混业务编排**（D4/D5）、**组织债/深模块被绕过**（D6/D7/D8）。

**本层目标**：落地 9 个候选（D1-D9），把「声明式架构」变成「可执行架构」：

| 候选 | 级别 | 一句话 | 波次 |
|------|------|--------|------|
| D1 | Strong（**Top 推荐**） | 三层骨架回潮修复 + pre-commit 守护 | W1 |
| D2 | Strong | 16/16 port 单实现 → 7 个 hypothetical seam 折叠（需 DP-2 裁决） | W5 |
| D3 | Strong | ITerminalService/IWorktreeService 方向反置归位 | W2 |
| D4 | Strong | settings-message-handler 业务编排下沉 config-service | W2 |
| D5 | Worth | session-message-handler 业务判断下沉 | W3 |
| D6 | Worth | JsonStore 深模块被新 store 绕过，复用 + 常量收敛 | W3 |
| D7 | Worth | message-bus stateTypeKey 发布侧断链修复 | W3 |
| D8 | Worth | session-service God facade + preset-service 五职责切分 | W4 |
| D9 | Speculative | workspace-service 薄委托：**建议关闭（不删）** | W5 |

**Out of Scope**：不引入新第三方依赖；不改变 pi 私有协议交互；本层所有改动必须保持 WS 消息契约兼容（前端无感）。

## §2 现状与问题分析

**层判定**：三层 DAG 骨架成立（infra 零 transport import），但存在四类侵蚀，其中「不成环纯属侥幸——被依赖方恰好都是叶子」。

**侵蚀 1 · 回潮无守护（D1）**：三层边界规则（`runtime-three-layer-design.md` 铁律 + 受控例外清单）是纯声明。9 处泄漏漂移已回潮，而 `runtime-migration-progress.md` 声称「FULLY CLEAN」。PiXxx 隔离是 three-layer-design 立项要根治的核心问题（R5 验收标准 `rg "Pi[A-Z]" services/ transport/` 应为空）——迁移完成后回潮，等于架构核心承诺失效。

**侵蚀 2 · port 单实现税（D2/D3）**：`services/ports/` 16 接口全部 1:1:1（接口-实现-消费方各一），7 个是 hypothetical seam（读 file-service 要跳一层接口才看到真实调用）；ITerminalService/IWorktreeService 两个接口方向反置（ports/ 语义是「service 定义需要什么、infra 实现」，它们却是 service 对外能力契约）。

**侵蚀 3 · transport 混业务编排（D4/D5）**：「transport 零业务逻辑」边界规则被 settings-message-handler（最深编排：对账 5 case / 差异化广播链 / 逐字段校验）与 session-message-handler（恢复编排 / gap 检测 / 副作用顺序）违反。

**侵蚀 4 · 组织债/深模块（D6/D7/D8/D9）**：P0-A 建好的 JsonStore 深模块（337 行，吸收 ENOENT/原子写语义）被 app-config-store 绕过重写浅版本；message-bus 的 stateTypeKey 发布侧断链（'session.workflows' 无 publish 点，stateSnapshot 永远空）；session-service 1413 行 God facade + preset-service 680 行五职责；workspace-service 52 行薄委托（核查后建议关闭）。

## §3 解决方案

### D1（Strong · Top 推荐）三层骨架回潮修复 + pre-commit 守护 [W1]

#### 3.1.1 现状：9 处泄漏（全部二次核实）

| # | 方向 | 文件:行 | import 内容 | 性质 |
|---|------|---------|------------|------|
| 1 | infra→services | `infra/pi/agent-crud.ts:14` | `inferSourceType` ← services/scanners/scanner-base.js | 值导入 |
| 2 | infra→services | `infra/pi/pi-provider-store.ts:15` | `deriveEnabled` ← services/provider-catalog.js | 值导入 |
| 3 | infra→services | `infra/pi/event-adapter.ts:26` | `PiTranslatedEvent` ← services/session/types.js | type-only |
| 4 | services→infra | `services/quota-service.ts:20` | `getApiKeyForProvider/getProviderConfig/upsertProvider` ← infra/pi/pi-provider-store.js | 值导入 |
| 5 | services→infra | `services/migration/provider-importer.ts:36` | `getProviderNames/upsertProvider/ensureProviderInWhitelist/PiProviderConfig` ← infra/pi/pi-provider-store.js | 值+type |
| 6 | services→infra | `services/session-history.ts:15` | `mapSessionEntries` ← infra/pi/session-entry-mapper.js | 值导入 |
| 7 | services→infra | `services/session-history.ts:16` | `PiSessionEntry` ← infra/pi/pi-protocol.js | type-only（PiXxx） |
| 8 | services→infra | `services/handoff-service.ts:26` | `PiAgentEndEvent/PiAgentEndMessage` ← infra/pi/pi-protocol.js | type-only（PiXxx） |
| 9 | services→infra | `services/session/session-service.ts:24` | `PiSessionEntry` ← infra/pi/pi-protocol.js | type-only（PiXxx） |

关键事实：PiXxx 泄漏 3 处**全部是 type-only**（守护必须同时拦 type-only，不能只看值导入）；`pi-protocol.ts:9-11` 头注释明令「🔒 services/transport 不得 import」；受控例外权威清单在 `runtime-three-layer-design.md:153-200`（① logger ② pi-paths ③ git-status-parser/ignore-parser 纯解析函数，:200 判断准则明确「**pi 协议类型**……一律经 port 访问，不得直接 import」——PiXxx 不能靠扩例外解决）。

#### 3.1.2 修复设计（四步）

**Step 1 · 2 纯判据函数下沉 utils 共享层**

`runtime-three-layer-design.md` 与 `runtime-module-map.md:130` 定义 utils/ 为「三层架构的第四个层——公共底座（无业务语义的纯工具），任意层可 import」。两个反向 import 的源头都是纯判据函数（无 IO、无状态、无副作用）：

- `inferSourceType`（services/scanners/scanner-base.ts:55，纯路径分段判据）→ 下沉 `utils/source-type.ts`。消费方 3 处（scanner-base 定义、skill-scanner services 内用、agent-crud infra 违规）全部改从 utils import；scanner-base.ts 保留其余逻辑（若下沉后 scanner-base 只剩 re-export 则整体删除，迁移时 rg 确认）
- `deriveEnabled`（services/provider-catalog.ts:33，纯白名单匹配判据）→ 下沉 `utils/provider-enabled.ts`。消费方跨层（services 侧 provider-catalog/legacy-provider-migration/provider-config-helper/settings-message-handler + infra 侧 pi-provider-store/pi-enabled-models）全部改从 utils import；provider-catalog.ts 保留其余逻辑

**Step 2 · 1 类型归位：PiTranslatedEvent → services/ports/pi-engine.ts**

`PiTranslatedEvent`（services/session/types.ts:125，event-adapter → interpreter 中间事件，引用 shared 的 ServerMessage）是 `IPiEventListener` 回调的载荷类型。event-adapter 已合规 import `PiEventListener` from `services/ports/pi-engine.js`（:24）——把事件类型移到与监听器接口同处，event-adapter 的 import 从 `services/session/types.js` 改为 `services/ports/pi-engine.js`，**infra→ports 方向合规**（依赖倒置契约本就是 infra 可 import 的）。types.ts 的 `PiTranslatedEvent` 删除，session 域内部消费方改 import ports。

**Step 3 · PiXxx 类型权威下沉 shared + session-entry-mapper 归 utils**

3 处 PiXxx 泄漏（#7/#8/#9）全是 pi-protocol.js 的**类型**（PiSessionEntry/PiAgentEndEvent/PiAgentEndMessage），按 :200 判断准则不能扩 kernel 例外，唯一长期方向是「类型权威移到 services 可访问的层」：

- 类型权威下沉 `shared/src/pi-session.ts`（新模块；shared 已有 pi-preset.ts/pi-default-prompt.ts 的 pi 类型先例）。`infra/pi/pi-protocol.ts` 保留值常量定义，类型改从 shared re-export（infra 内部及其他消费方零改动，re-export 在类型层面等价）
- session-history/handoff-service/session-service 的 PiXxx import 改为从 shared import（#7/#8/#9 消除，`rg "Pi[A-Z]" services/ transport/` 归零）
- `mapSessionEntries`（#6）：session-entry-mapper 是纯解析函数（输入 JSONL 条目 → 伪消息数组，无 IO），下沉 `utils/session-entry-mapper.ts`（与 utils/jsonl.ts 同域，session-history 已 import utils/jsonl.js 先例）；infra/pi/session-entry-mapper.ts 删除（迁移后 rg 确认 infra 无其他消费方，若有则临时 re-export 并列入后续清理）

**Step 4 · 凭证 CRUD 改走 IConfigStore port**

`services/ports/config.ts` 的 IConfigStore（interface 起于 :96）是多消费方 port（11 消费文件，保留在 ports/），**已含** `ensureProviderInWhitelist`（:124）/ `getProviderConfig`（:134）/ `upsertProvider`（:135）/ `removeProvider`（:136）。quota-service/provider-importer 直连 pi-provider-store 是绕过既有 port：

- `IConfigStore` 扩展两个方法：`getApiKeyForProvider(providerId)`（quota-service:20 缺）、`listProviderNames()`（provider-importer:36 缺的 getProviderNames）
- quota-service / provider-importer 构造函数注入 IConfigStore（当前均未注入，需加 DI 参数，组合根在 wiring 处传入既有实现）
- `PiProviderConfig` 类型（provider-importer:36 的 type import）随 Step 3 一并从 shared 取或收敛为 ConfigProviderConfig 转换

**方案对比（Step 1-3 的备选）**：

| 方案 | 性质 | 取舍 |
|------|------|------|
| **下沉 utils/ + ports/ + shared（推荐）** | 长期方案 | 函数/类型归位到「任意层可 import」的权威位置，方向恢复单向；一次性代码移动（约 15+ 文件 / 20 处 import 改写），零行为变化（纯函数/纯类型） |
| 扩大受控例外白名单（kernel 例外囊括 9 处） | 短期方案 | 零代码改动，但 :200 判断准则明确排除 pi 协议类型，且例外清单膨胀会让守护白名单形同虚设——回潮模式原样保留，三个月后必复发 |

#### 3.1.3 pre-commit 守护设计（本候选的核心交付）

**新增 `.githooks/check_layer_boundaries.py`**，复用 `check_path_whitelist.py` 的成熟模式（TARGETS 文件列表 + 正则扫描 + 退出码 0/2 + 错误信息带修复提示）：

检查逻辑（三条规则，基于静态 `import` / `export … from` 语句正则解析）：

1. **反向规则**：`infra/` 下文件 import（或 `export … from` re-export）相对路径命中 `services/` → 硬错误（初始白名单为空，未来确需反向时先裁决再放行）
2. **下钻规则**：`services/` 下文件 import 命中 `infra/` → 硬错误，**白名单 = `runtime-three-layer-design.md:156-200` 受控例外清单的文件级机器可读版**。⚠️ **粒度对齐（MF-3 修订）**：该文档例外清单是**文件级**——logger 8 条 / pi-paths 6 条 / 纯解析函数 2 条，共 16 个 `(services 文件, infra 模块, 行)` 三元组，脚本白名单**必须同粒度**：枚举允许的 `(services 文件, infra 模块)` 对（与文档 16 条严格一一对应），而非「任意 services 文件均可 import 某 infra 模块」的模块级放行。模块级放行会让两套 SSOT 必然漂移——新增一个 services 文件 import `logger` 时脚本放行、文档 8 条清单却未登记，守护与文档脱钩。**同步检查**：脚本启动时校验「脚本白名单三元组与文档清单一致」（参照 `check_env_whitelist_sync.py` 强制 `ENV_WHITELIST_PREFIXES` 单点定义的先例——文档清单是 SSOT，脚本是镜像，两者不一致即 exit 非 0 并提示补登记），防未来有人直接改脚本常量放行
3. **PiXxx 符号规则**：`services/` 与 `transport/` 下任何 import 自 `infra/pi/pi-protocol.js` 的符号（含 type-only）→ 硬错误

关键设计点：

- **type-only 必须拦**（3 处 PiXxx 泄漏全是 type-only，只拦值导入守护即失效）：import 语句正则需区分 `import type {...}` 与 `import {...}`，两条路径分别判定，任何一条命中即报
- **barrel re-export 也拦（MF-2 修订，堵最可能的意外 bypass）**：正则同时匹配 `export { ... } from '...'` / `export type { ... } from '...'`——有人为「方便」在 services 建类型 barrel `export { PiSessionEntry } from '../../infra/pi/pi-protocol.js'` 时同样命中规则 3。`import` 与 `export … from` 语句同构，一行正则成本即覆盖；当前代码零实例（`grep -rnE "^export.*(\\{|type).*from.*infra" packages/runtime/src/{services,transport}` 核实），属预防性拦截
- **已知限制（best-effort 静态扫描，MF-2 修订）**：守护基于静态 `import`/`export … from` 语句正则，**不覆盖** `require()`（CJS）与动态 `import()` 两类 bypass。经核实（`grep -rn "require(\\|import(" packages/runtime/src/{services,transport}`），当前这两类**均无用于跨 services→infra 层访问的实例**——`plugin-bootstrap.ts:275` 的 `require('node:module')` 是 Worker Thread 内 node 内置、`:98` 的 `await import(moduleUrl)` 是同层动态加载插件、其余多为 TS 类型位置用法 `import('...').T`（编译后消失）或第三方/同层模块。故守护对**当下**跨层问题覆盖完整；但动态 import 是真实存在的语法（非假想的罕见），未来若有人写 `await import('../../infra/pi/pi-protocol.js')` 即可绕过——记入已知限制，引入时须同步扩正则或降级为 AST。守护定位是「拦住已知回潮模式」而非「架构边界完整守卫」（与下条「不引入完整 AST 依赖」的轻量实现自洽）
- 相对路径解析用正则提取 `from '...'` 后做路径归一（`../` 折叠），不引入完整 AST 依赖（与 check_path_whitelist.py 同级的轻量实现）
- 扫描范围 `packages/runtime/src/{transport,services,infra}/` 全部 `.ts`（排除 `*.test.ts`——测试可 mock 跨层，不属架构承诺）
- 退出码：0 = 通过；2 = 检查失败（对齐 check_path_whitelist.py）；错误输出列出 文件:行 → import 内容 → 违反规则 → 修复指向（「受控例外判断准则见 runtime-three-layer-design.md:200」）

**与 install-hooks.sh 集成**（对齐既有 12 个 check_*.py 的接入范式）：在 `.githooks/install-hooks.sh` 生成的 pre-commit 模板中新增一段，`LAYER_BOUNDARY_CHECKER=".githooks/check_layer_boundaries.py"` + `SKIP_ALL_CHECKS`/`SKIP_LAYER_BOUNDARY_CHECK` 双开关（与 PATH_WHITELIST_CHECKER 段落同构）；`.githooks/check_env_whitelist_sync.py` 的 SSOT 检查先例同样适用于本脚本的例外清单（防未来有人直接改脚本放行）。

**migration-progress 联动改造**（与 06-doc-debt.md 合并推进）：`docs/architecture/runtime-migration-progress.md` 的「当前状态」章节从手写「FULLY CLEAN」改为**指向可执行检查输出**——`check_layer_boundaries.py` 增加 `--report` 模式（输出当前违规清单，空 = 三层边界 FULLY CLEAN，exit 0），文档标注「截至 <日期> 历史快照 + 当前状态: 运行 `.githooks/check_layer_boundaries.py --report` 验证」。声明与事实的核对从人工变脚本。

### D2（Strong）16/16 port 单实现 → 7 个 hypothetical seam 折叠 [W5 · 前置 DP-2 裁决]

#### 3.2.1 现状

`services/ports/` 现有 14 个文件（审查报告口径 16 个 port 契约接口；部分文件含纯数据类型导出，不属 port）。**全部 1:1:1**（接口 : 实现 : 消费方），其中 **7 个单消费方**（二次核实，消费文件数含实现与消费两方）：

| port 接口 | 唯一消费方 | 实现 |
|-----------|-----------|------|
| IFileChangeDiff | services/session/event-interpreter.ts | infra/file-change-diff-adapter.ts |
| IFileExecutor | services/file-service.ts | infra/fs-executor.ts |
| IModelSource | services/model-service.ts | infra/model-api-discoverer.ts |
| IShellRunner | services/worktree/worktree-service.ts | infra/shell-runner.ts |
| IPluginInstaller | services/plugin-service/plugin-service.ts | infra/installers/plugin-installer-adapter.ts |
| IExtensionSettings | services/extension-service.ts | infra/pi/pi-extension-settings.ts |
| IExtensionResolver | services/extension-service.ts | infra/installers/extension-resolver.ts |

剩余 9 个多消费方 port（保留在 ports/，是真 seam）——消费文件数（含实现）：IConfigStore 11 / IPiEngine 11 / ISessionStore 7 / IInstaller 5 / IGitInfoReader 5 / IPluginInstaller 4 / IGitExecutor 3 / ITerminalService + IWorktreeService 各 3（⚠️ 后两者被 D3 移出 ports/，移出后 ports/ 净剩 7 个多消费方）。

测试替身零实现接口、全部 `as unknown as` 强转——seam 的可替换性从未以类型安全方式兑现；读 file-service 要跳一层接口才看到真实调用。

#### 3.2.2 DP-2 两个选项（需显式裁决，与 R9 决策相悖）

**选项 A · 单消费方 port 折叠进消费方（本候选主张）**

- 做法：7 个接口声明移到各自消费方文件内（service 文件顶部定义契约，infra 实现类 `import type` 该契约——**依赖方向不变**：service 继续定义、infra 继续实现），`services/ports/` 只保留多消费方 port
- 性质：长期方案。locality 收益——一次消除 7 个跳转税，读消费方文件即见契约；seam 保留（依赖倒置方向没变），只是从「目录级集中」变为「文件级就近」
- 代价：与 R9 决策（「ports 按域集中拆分」，runtime-module-map.md 快照时点标注）方向相悖——集中派认为 ports/ 目录是三层架构的可审计面，折叠后 ports/ 清单不再完整代表「service 需要什么」
- 裁决判据：**seam 的真实价值 = 可替换性兑现**。7 个 port 替换场景为零（历史零换实现、测试用强转而非替身实现）、消费方唯一——目录级集中支付的 indirection 税没有对应收益；多消费方 port 保留集中（它们是真实 seam：方向控制 + 潜在多实现）
- **反转成本评估（SUG 修订）**：折叠不是不可逆决策——若某 port 后续出现第二消费方，须重新抽出（接口声明从消费方文件搬回 ports/ + import 路径调整）。评估：抽 port 成本低（机械移动 + `rg` 改 import，单 port 约 3-4 处改动），且「第二消费方出现」本身是强信号（说明该能力确成 seam）——届时抽回是「响应真实需求」而非「过度设计被推翻」。即反转成本低且触发条件明确，不构成阻碍折叠的理由；但 DP-2 裁决须记录此反转约定，避免第二消费方出现时有人因为「已折叠」而勉强写第二处内联重复

**选项 B · 维持集中并按域拆分（R9 现状）**

- 做法：ports/ 保留全部 16 接口，按域分文件（provider 域/config 域/fs 域/session 域），落实 R9「按域集中拆分」原始意图
- 性质：长期方案（R9 是既有决策）。收益：ports/ 是可审计的依赖倒置面；风险：单消费方 port 的跳转税与强转测试问题原样保留，且「按域拆分」后单消费方接口的域归属仍需逐个判定（工作量更大）
- 与本设计集的关系：主文档 DP 清单推荐倾向为「单消费方 port 折叠（7 个），多消费方 port 留 ports/」——即选项 A 为主、B 为多消费方部分的落实

**裁决建议**：选项 A（折叠 7 个单消费方）+ 选项 B 的域拆分只用于剩余多消费方 port（两选项并非互斥——矛盾点只在「单消费方 port 去留」）。若裁决选 B 全量集中，本候选降级为「只加审计不折叠」，收益归零，需在 DP-2 记录理由。

#### 3.2.3 实施步骤（DP-2 裁决后 1-2 commit）

1. 逐个折叠：接口声明从 ports/ 文件搬入消费方文件顶部（如 IFileChangeDiff → event-interpreter.ts），ports/ 文件删除；infra 实现类的 `implements` 子句 import 改指消费方文件
2. 测试替身改造：`as unknown as` 强转改为实现消费方文件接口（类型安全兑现——这是折叠的直接收益，强转消失是验收证据）
3. `rg "ports/" packages/runtime/src` 确认仅剩多消费方 port 引用；`npx vitest run` 全绿
4. DP-2 裁决记录（选 A/B/混合 + 理由）写入本文件与主文档 DP 清单

### D3（Strong）ITerminalService / IWorktreeService 方向反置归位 [W2]

#### 3.3.1 现状

`services/ports/terminal-service.ts` / `worktree-service.ts` 定义 ITerminalService/IWorktreeService，实现类在 `services/terminal/terminal-service.ts:64`（`class TerminalService implements ITerminalService`）、`services/worktree/worktree-service.ts:119`（`class WorktreeService implements IWorktreeService`），唯一消费方 `transport/server.ts:46,48`（type import 后注入 handler）。

**方向反置**：ports/ 语义 = 「service 定义需要什么、infra 实现」（依赖倒置契约，`runtime-three-layer-design.md` 第三部分「ports 接口清单」的定位）；这两个接口却是 **service 对外能力契约**（IService 性质——terminal/worktree 是 services 域的实现类，被 transport 消费）。声明放 ports/ 使 ports/ 失去单一语义：一半是「service 需要的外部能力」，一半是「service 对外提供的能力」。

**消费链细节**（二次核实）：`transport/server.ts:46` `import type { IWorktreeService }`、`:48` `import type { ITerminalService }`（type import 后注入 handler 构造参数）；两个实现类的 `implements` 子句引用同名接口（terminal-service.ts:64 / worktree-service.ts:119）。对比 interfaces.ts 的 ISessionService/IConfigService 等 10+ 契约——它们与实现类同层（services 域）或被 transport 直接消费，声明统一在 interfaces.ts。

**与 D2 的交互**：D3 移走 ITerminalService/IWorktreeService 后，ports/ 的多消费方净剩 7 个——D2 的折叠清单不受影响（7 个单消费方与这两个无关），但 D2 实施时的「保留清单」数字以 D3 落地后的状态为准（实施顺序：D3 在 W2、D2 在 W5，天然满足）。

#### 3.3.2 方案对比

| 方案 | 性质 | 取舍 |
|------|------|------|
| **声明移入 `interfaces.ts` 与其余 IService 归位（推荐）** | 长期方案 | interfaces.ts（runtime 根级，已核实存在，含 IMessageBroker/ISessionService/IConfigService 等 10+ IService 契约）是「service 对外能力」的权威位置。ITerminalService/IWorktreeService 移入后与其余 IService 契约查找点收敛；改动面 = 声明位置 + 3 处 import（ports 两文件删除、实现类 :64/:119 的 import 改指 interfaces.ts、server.ts:46,48 改指 interfaces.ts），零行为变化 |
| 留 ports/ 并改写文档语义（「ports 亦含能力契约」） | 短期方案 | 零代码改动，但 ports/ 语义模糊永久化——后续新接口的归属判定继续靠人猜，且与 interfaces.ts 既有 IService 集合形成双权威 |

#### 3.3.3 实施步骤（1 commit）

1. 将 ports/terminal-service.ts、ports/worktree-service.ts 的接口声明（含类型依赖，如 TerminalServiceDeps/WorktreeServiceDeps 若被声明引用则一并评估）原样搬入 interfaces.ts，紧随既有 IService 契约分组
2. 删除 services/ports/ 两个文件；`rg "ITerminalService|IWorktreeService" packages/runtime/src` 确认剩余引用点
3. 实现类（terminal-service.ts:64 / worktree-service.ts:119）与 server.ts:46,48 的 import 改指 `../../interfaces.js`（按相对深度）
4. `npx vitest run`（packages/runtime）全绿 + `pnpm run dev` 冒烟（Terminal 面板 / worktree 检测三态）

实施注意：interfaces.ts 现有 TerminalConfig/Worktree 配置方法（:375-384）是 IConfigService 的配置读接口，与 ITerminalService（PTY 生命周期能力）语义不同，**不合并**，仅并列归位。

### D4（Strong）settings-message-handler 业务编排下沉 config-service [W2]

#### 3.4.1 现状

`transport/settings-message-handler.ts` 承载 transport 层最深的业务编排（二次核实）：

- :43-54 `reconcileDefaultModelAfterProviderChange`——默认模型对账（5 case 消费方调用），含 `config.defaults` 差异化广播
- :167-231 成功/失败差异化广播链（provider 变更后按结果分支广播不同事件集）
- :247-267 逐字段校验（settings 更新前按字段类型/范围校验）

transport「零业务逻辑」边界规则被违反；注释自认是「消除 5 handler 各自编排的遗漏根因」——根因修在了错误的层（handler 层编排再收敛也是 handler 层编排）。

**三类编排的现状行为**（二次核实）：① 对账函数在 provider 变更后重算默认模型，若默认模型失效则广播 `config.defaults`（source: 'provider-change'），5 个 handler 场景共用；② 差异化广播链按 provider 操作的成败分支发送不同事件集（成功广播列表刷新、失败发错误事件），确保前端状态与 settings.json 一致；③ 逐字段校验在写 settings 前按字段语义校验（类型/取值范围），防坏数据落盘。

**config-service 现状盘点**（interfaces.ts 二次核实）：IConfigService 已暴露 provider 域完整能力——`listProviders` / `setProvider` / `removeProviderByKind`（含 newDefault 重算）/ `getProvider` / `applyImportProviders`（:261-410 区间）。handler 的 :43-54 对账实质是对 `removeProviderByKind` 返回的 newDefault 的二次编排——**能力已在 services，编排却在 transport**，下沉是「编排与能力同层」的自然归位，不新增能力面。

#### 3.4.2 方案对比

| 方案 | 性质 | 取舍 |
|------|------|------|
| **对账与差异化广播下沉 config-service，handler 退回纯执行（推荐）** | 长期方案 | config-service（services 层，test 基建成熟——config-service 系列测试已存在）新增 `reconcileDefaultModelAfterProviderChange()` / `applyProviderChangeAndGetBroadcast()`：对账逻辑 + 返回「需广播什么」的结构化结果（事件类型 + payload 列表），handler 只做参数提取 → 调用 → 按返回值发送。规则单点可测（5 case 全部直测），handler 变浅 |
| 在 handler 内继续收敛（把 5 case 抽成 handler 内部共享函数） | 短期方案 | 代码内聚一点但不改层——业务编排仍在 transport，违反边界规则的根因未动；未来新 handler 仍需绕过 config-service 拼广播 |

#### 3.4.3 实施步骤（1-2 commit）

1. config-service 新增对账方法（`:43-54` 逻辑原样搬移，5 case 消费方改调 config-service）
2. 新增差异化广播方法：返回结构化结果（如 `{ broadcasts: ServerMessage[] }`），handler 按结果发送；逐字段校验下沉为 config-service 内部校验器（或复用既有 validation 模块）
3. handler 改造：删 `:43-54` 编排与 `:167-231` 广播链、`:247-267` 校验，保留参数提取与响应组装
4. 测试迁移矩阵：config-service 新增 5 case 单测（对账各分支）；settings-message-handler 既有测试改为断言「调用 config-service + 按返回值发送」（行为断言不变，mock 目标从 handler 内部逻辑换成 service 方法）；WS 集成测试保留原场景验证端到端
5. 验收：切换默认模型 → 切 provider → 增删 provider 各跑一遍，WS 事件序列与迁移前一致

验收要点：迁移前后跑同一真实场景（改默认模型 → 切 provider → 增删 provider），断言 WS 事件序列一致（playwright 或 runtime 集成测试）。

### D5（Worth）session-message-handler 业务判断下沉 [W3]

#### 3.5.1 现状

`transport/session-message-handler.ts` 三处业务判断（二次核实）：

- :178-195 `session.deleteByCwd` 副作用顺序编排（先聚合结果再清 timeout，与单删「先清 timeout 再 delete」顺序相反——注释自述编排理由）
- :197-249 switch 双分支恢复编排 + `isEnoent` 错误分类（造两条用户文案）
- :300-344 `fromSeq < oldestSeq` gap 检测（消息同步算法）

这些是 session 域业务（恢复策略、错误语义、同步算法），不属 transport 的「参数提取 → 调用 → 响应组装」。

**三处问题的行为细节**（二次核实）：① deleteByCwd 必须先拿批量聚合结果才知道清哪些 session 的 timeout——与单删「先清 timeout 再 delete」顺序相反，注释自述理由，编排顺序错误会导致已删 session 的 timeout 泄漏或未删 session 的 timeout 被误清；② 恢复分支按错误类型（isEnoent vs 其他）分两条用户文案——错误语义是 session 域知识，handler 层拼文案与「错误作为 assistant 消息/结构化结果」的既有范式不一致；③ gap 检测是消息同步算法（fromSeq 小于 oldestSeq 时判定历史缺口，需全量重同步而非增量补发——同步语义错误会导致历史缺失段静默），属 message-bus 的 seq 域。

**测试现状**：这三处目前只能靠 WS 集成测试覆盖（handler 层无单测入口）——文案与 gap 判定下沉后获得纯函数单测入口，是「测试价值/成本比」的直接改善（对齐测试规范「每条用例至少一个用户可见断言」：文案可 DOM 断言、gap 可单测纯函数）。

#### 3.5.2 方案对比

| 方案 | 性质 | 取舍 |
|------|------|------|
| **下沉 session-service / message-bus，错误返回结构化 code+userMessage（推荐）** | 长期方案 | 恢复编排与 gap 判定下沉 session-service（或 message-bus——gap 判定是同步算法，归属 message-bus 更贴切，实施时按依赖方向裁决）；错误分类改为结构化 `{ code, userMessage }` 返回，handler 直接透传。文案与 gap 判定可直接单测（不再需 WS 集成测试）；
依赖：与 D8（session-service God facade 切分）同文件，先做 D8 的抽方法重构再迁移，避免在 God facade 上继续堆方法 |
| 保持 handler 内实现 + 抽私有函数 | 短期方案 | 代码局部收敛，但编排仍在 transport；gap 判定无单测入口（需 WS 集成），与「错误作为结构化结果」的既有范式（extension-message-handler invalid_payload 等）不一致 |

#### 3.5.3 实施步骤（前置 D8-①）

1. 先完成 D8-①（session-service 抽方法重构，见 §3.8），使 :197-249 恢复编排与 :300-344 gap 判定有干净的迁移目标位置
2. 错误分类下沉：session-service 返回 `{ code, userMessage }` 结构化错误，handler 透传（两条文案进 services 域，单测直测）
3. gap 判定下沉 message-bus（seq 域）或 session-service（按依赖方向裁决），返回「需全量重同步」信号
4. deleteByCwd 副作用顺序编排下沉 session-service（聚合 + 清 timeout 的编排内聚），handler 只调一个方法
5. 验收：三条真实场景（错误恢复文案 / gap 重同步 / deleteByCwd timeout 清理）行为与迁移前一致

### D6（Worth）JsonStore 深模块被新 store 绕过 [W3]

#### 3.6.1 现状

`services/app-config-store.ts:36-70` 手写 `existsSync → readFileSync → JSON.parse` 全骨架（含容错分支），`rg JsonStore` 在 app-config-store 零命中——P0-A 建好的深模块 `utils/json-store.ts`（337 行，吸收 ENOENT/原子写语义）被绕过重写浅版本；`JSON_INDENT` 常量重复散布——实测 `rg -rln JSON_INDENT packages/runtime/src` 命中 **9 文件**：6 处 `const JSON_INDENT =` 定义（`app-config-store.ts:17` 已 `export`、`session-service.ts:1326` 为函数内局部常量、`cli/commands.ts:12` / `preset-service.ts:31` / `project-store.ts:26` / `recent-workspaces-store.ts:27` 各一处模块级私有）+ 2 处 import 消费（`terminal-config-helper.ts:18` / `system-prompt-config-helper.ts:17` 从 app-config-store 取）+ 1 处注释提及（`utils/json-store.ts:29`，已在注释里预告「统一既有 JSON_INDENT / INDENT_SPACES 两套常量」但尚未落地）。

**深模块与浅骨架的能力差**（二次核实）：JsonStore 吸收了 ENOENT→默认值、原子写（临时文件 + rename）、损坏 JSON 容错等语义；app-config-store 的手写骨架只覆盖「文件存在 → 读 → 解析」路径，容错分支（损坏 JSON 回退、写失败处理）各自实现且细节与 JsonStore 不同——两套语义并存，后续维护要同时记住两个行为。

#### 3.6.2 方案对比

| 方案 | 性质 | 取舍 |
|------|------|------|
| **复用 utils/json-store.ts + 常量收敛单点（推荐）** | 长期方案 | app-config-store 改走 JsonStore（读接口对齐现有语义，行为等价：ENOENT→默认值、原子写由深模块吸收）；JSON_INDENT 收敛到 utils/json-store.ts 导出（或 shared 常量位），4 处改 import。深模块的「吸收 ENOENT/原子写语义」承诺重新兑现 |
| 保持手写骨架 + 注释指向 JsonStore | 短期方案 | 零改动，但两套文件读写语义并存（容错分支细节各写各的），后续第三个 store 大概率继续手写——深模块价值持续流失 |

#### 3.6.3 实施步骤（1 commit）

1. `rg -rln JSON_INDENT packages/runtime/src` 定位 9 处命中（分类见 §3.6.1）→ 收敛为 `utils/json-store.ts` 单一导出（深模块已在注释里预告统一意图，且 services 多处已 `import { atomicWrite } from '../utils/json-store.js'`，同源收敛成本最低），6 处 `const` 定义删除改 import、2 处既有 import 改指向 utils、session-service:1326 函数内局部常量改 import
2. app-config-store 的 `:36-70` 手写骨架替换为 JsonStore 调用：读路径对齐现有语义（ENOENT → 默认值、损坏 JSON → 容错），写路径由 JsonStore 原子写吸收
3. 行为等价验证：删除 config.json 启动（ENOENT 路径）、损坏 JSON 启动（容错路径）、正常读写——三个场景与手写骨架行为一致（含现有测试全绿）

### D7（Worth）message-bus stateTypeKey 发布侧断链修复 [W3]

#### 3.7.1 现状

`services/message-bus/message-bus.ts:40-45` 的 `stateTypeKey` 映射表含 `'session.workflows': 'workflows'`，但**发布侧无任何 'session.workflows' 类型消息**——实际广播 type 是 `'session.workflowUpdate'`（`services/session/event-interpreter.ts:591` `broadcastWorkflowUpdate`）。workflows 的 stateSnapshot 永远空，message-bus 的 reconcile 深机制（last-value 覆盖）对该 topic 空转；dual-write 未退出（broker.broadcast 仍有 55-57 处）。ADR-0055 phase-2 已记录此缺口——本候选是其修复项，非新发现。

**message-bus 深模块机制**（二次核实）：message-bus 本身是深模块——seqCounter / FIFO ring（容量 1000）/ stateSnapshot last-value / 双 Map 不变量，495 行测试覆盖。stateTypeKey 是 stateSnapshot 的键派生函数（:40），断链导致该 topic 的 last-value 机制从未被触发，`stateTypeKey` 对 'session.workflows' 的映射是死分支（单测 :399-421 仍断言其行为，属「机制在、数据源无」的空转）。

#### 3.7.2 方案对比

| 方案 | 性质 | 取舍 |
|------|------|------|
| **对齐映射：stateTypeKey 改 `'session.workflowUpdate': 'workflows'`（推荐）** | 长期方案 | 发布侧类型与 stateSnapshot 键对齐，workflows 的 last-value 机制复活；同步推进 ADR-0055 phase-2 的 dual-write 退出（broker.broadcast 收口到 message-bus 统一入口）。改动 1 行映射 + 事件流收口，message-bus 495 行测试基建可直接验证 |
| 删除 stateTypeKey 的 workflows 条目（承认该 topic 不用 snapshot） | 短期方案 | 断链消除但 reconcile 能力对 workflows 永久关闭；若未来 workflows 需要 last-value（如重开 session 恢复工作流状态）需重做映射 |

#### 3.7.3 实施步骤（前置 ADR-0055 边界确认，1 commit）

1. 对照 ADR-0055 phase-1/phase-2 边界确认 dual-write 退出范围（只收 workflows 域还是全量 broker 收口）——避免与既有 dual-write 迁移中的其他 topic 冲突
2. `stateTypeKey` 映射改 `'session.workflowUpdate': 'workflows'`（1 行）；message-bus 单测扩展：发布 workflowUpdate 后 stateSnapshot 非空且 last-value 覆盖正确（:399-421 既有用例改指新键）
3. dual-write 收口：broker.broadcast 的 workflows 域调用改走 message-bus 统一入口，`rg "broker.broadcast"` 计数下降（55-57 处 → 目标随 phase-2 范围定）
4. 真实场景：dev app 启动 workflow → 重开 session 验证工作流状态可恢复（若 phase-2 范围含恢复）

### D8（Worth）session-service God facade + preset-service 五职责切分 [W4]

#### 3.8.1 现状

- `services/session/session-service.ts`（1413 行）God facade：60+ 方法约半数零决策委托（转发到 session-pool/scanner/store 等，如列表/详情/生命周期类方法多为直通）；夹带 token/usage 状态 8 方法 + 11 setter 注入（状态与 facade 职责混杂——状态本应归属 tracker，facade 却同时是状态持有者和转发器）
- `services/preset-service.ts`（680 行）五职责混装：文件 IO / mtime 缓存 / coerce 校验 / builtin 守卫 / resolve 编排——任一职责变更要读完 680 行才敢动；preset 合法性枚举有两套本地副本，**与 shared 的关系不同，须区别对待**（核实 `grep -rn VALID_TOOL_MODES packages/shared/src/` 零命中）：
  - `VALID_TOOL_MODES`（preset-service.ts:40）——**shared 无对应**（shared 根本不导出 tool mode 枚举，该常量纯本地）；无任何 shared 注释
  - `VALID_EXTENSION_MODES`（preset-service.ts:46）——对应 `shared/pi-preset.ts:200` 的 `EXTENSION_MODES`，但后者是 `const`（**未 `export`，私有**），:46 注释自认「shared 未导出，本地定义副本」
  - 即：两者都非「改 import shared」可直接执行——前者 shared 压根没有，后者 shared 有但不导出
- **切分边界**（与 D5 的依赖）：D5 要把 session-message-handler 的业务下沉 session-service——若先做 D5 会在 God facade 上继续堆方法，故 D8-①（抽方法重构）是 D5 的前置

#### 3.8.2 方案对比

| 方案 | 性质 | 取舍 |
|------|------|------|
| **渐进切分（推荐）：facade 保留对外入口、状态抽 tracker、校验抽独立模块并消 shared 副本** | 长期方案 | 三步走，每步独立 commit + 全量测试：① token/usage 8 方法 + 11 setter 抽 `SessionUsageTracker`（services/session/ 内新模块，facade 组合）② 零决策委托方法逐个内联到被委托方（rg 消费方确认无外部直用后再删 facade 方法）③ preset-service 校验/守卫抽 `preset-validation.ts` + 枚举改 import shared。审查报告明确警告「渐进切分，勿大爆炸」——禁止单次大重构 |
| 一次重写 facade 为多模块 | 短期方案 | 表面上干净，但 1413 行的消费面（transport 17 handler + 测试）一次性改写风险极高，任何遗漏都静默变行为——与 D5 的迁移形成叠加风险 |

#### 3.8.3 实施步骤（三步，每步独立 commit）

**D8-① SessionUsageTracker 抽取**：token/usage 8 方法 + 11 setter 注入的字段/方法整体搬入 `services/session/usage-tracker.ts`；facade 保留对外方法签名（内部转调 tracker），setter 注入收敛为 tracker 构造参数；`rg "token|usage" session-service.ts` 确认 facade 不再持有状态字段；测试迁移（既有 token 断言改指 tracker）

**D8-② 零决策委托内联**：逐方法排查——「无任何分支/变换、纯转发」的方法内联到被委托方（session-pool/scanner/store），rg 确认无外部直接调用后删 facade 方法；每批（≤5 方法）一个 commit，保持 diff 可 review。**前置 gate（SUG 修订）**：内联删除前先产出 **facade 方法 → transport handler 消费映射表**（`sessionService.xxx() → { handlerA, handlerB }`），作为删除白名单——映射表为空（零外部消费）的方法才允许内联删除；映射表非空的转调链须显式改为 handler 直调被委托方（不能只删 facade 方法签名而不改调用点）。映射表同时是 17 handler 消费面的回归基线（每个被内联方法的消费点在表里可见，避免「删了 facade 方法、handler 调用点静默断裂」）

**D8-③ preset-service 校验抽模块 + 消 shared 副本**：coerce 校验与 builtin 守卫抽 `services/preset-validation.ts`（纯函数，可直接单测）；枚举收敛须按 §3.8.1 区分的两套分别处理，**不能一句「改 import shared」带过**（执行顺序如下）；resolve 编排留在 preset-service，文件 IO/mtime 缓存抽 `preset-store.ts`（如确认无外部消费方）
  - **前置子步（核实 + 创建权威源）**：先核实 shared 哪些枚举真导出（`grep -rn '^export.*MODES' packages/shared/src/`）；`VALID_TOOL_MODES` 在 shared 无对应，若设计上确需收敛，须**先在 `shared/src/pi-preset.ts` 创建并 `export`** 对应的 `TOOL_MODES`（或等价命名），再谈 import；`VALID_EXTENSION_MODES` 对应的 `EXTENSION_MODES` 当前是 shared 私有 `const`（pi-preset.ts:200），须**先改 `export const`** 才能被 import
  - **收敛子步（核实完成后再动）**：shared 权威源就绪后，preset-service 两处本地副本（:40/:46）删除改 import；消费方（preset-service 内部 coerce 路径）随 import 源切换；`shared` 包改动触发 `pnpm extensions:typecheck` + renderer vitest 核实无下游类型破损

每步完成后：`npx vitest run` 全绿 + `pnpm run dev` 冒烟（facade 拆不得破坏 17 个 transport handler 的消费面）。

### D9（Speculative）workspace-service 薄委托：建议关闭（不删）[W5]

#### 3.9.1 现状与核查修正

`services/workspace/workspace-service.ts`（52 行）曾被候选为「三层薄委托，可删」。⚠️ 核查修正后原候选**自相矛盾**：并非全单行委托——`record` 方法含 INV-1 守卫（空串 + homedir 跳过）后才委托，仅 `list`/`detectBare` 是纯委托（3 中 2）。守卫在 record 内恰与「INV-1 主守卫放 service 层」的设计自述一致。

#### 3.9.2 方案对比

| 方案 | 性质 | 取舍 |
|------|------|------|
| **关闭不删（推荐）** | 长期方案 | record 的 INV-1 守卫（空串 + homedir 跳过）是「主守卫放 service 层」的显式设计（AC-2.4/2.5 验收约束的落点），删 service 会把守卫下沉 store、违反设计意图；守卫归位正确、规模小（52 行）、无重复——不构成组织债。关闭动作 = 审查报告/总纲标记「已核查关闭」，零代码改动 |
| 删除 service、调用方直连 workspace-store | 短期方案 | 表面减一层，但守卫随之下沉 store——「守卫放 service 层」的验收约束（AC-2.4/2.5）失效；且 3 个方法中 2 个（list/detectBare）虽纯委托，删除后 store 直连的消费面变广，未来守卫位置回归无人约束 |

**结论（建议关闭，不删）**：候选前提（纯委托）经核查不成立——`record` 含守卫非纯委托（3 中 2 纯委托），修复对象不存在。唯一附带检查：`list`/`detectBare` 的纯委托可留待 D8 类切分顺手内联，但不单独立项。

## §4 验收

每候选验收均为**真实场景**（非单测唯一依据），共同前置：`pnpm run dev` 完整对话冒烟（新建 session → 发消息 → 收回复 → 切 session → 重开验证历史）。

### D1 验收

1. **守护拦截实测（红线 13：运行时行为断言必须先验证）**：修复 9 处泄漏后，故意在 `services/` 下某文件加一行 `import { x } from '../infra/pi/pi-provider-store.js'`（或 infra 文件 import services 符号），`python3 .githooks/check_layer_boundaries.py` → **exit 非 0 且错误输出含 文件:行 + 违反规则 + 修复指向**；删除该行后 → exit 0。再验证 type-only 路径：加 `import type { PiSessionEntry } from '../infra/pi/pi-protocol.js'` 同样被拦（3 处 PiXxx 泄漏全是 type-only 的回归防护）。**再验证 barrel re-export bypass（MF-2 探针）**：加 `export { PiSessionEntry } from '../../infra/pi/pi-protocol.js'` 同样被拦——这是最可能的意外 bypass（有人建类型 barrel 文件时发生），`export … from` 正则覆盖见 §3.1.3 关键设计点
2. **真实 commit 触发**：`git commit` 携带上述违规 → pre-commit 拦截，commit 失败；修复后 commit 通过（验证 install-hooks.sh 接入段生效）
3. **9 处泄漏归零**：`rg "from '.*(services|infra)" packages/runtime/src/infra packages/runtime/src/services` 反向边为零（白名单例外除外）；`rg "Pi[A-Z]" packages/runtime/src/services packages/runtime/src/transport` 为空（R5 验收标准回归）
4. **行为等价**：修复前后跑同一 provider 切换场景（settings → 切换 provider → 观察默认模型对账与广播），断言行为一致（纯函数下沉 + port 注入不得改变语义）
5. **migration-progress 联动**：`docs/architecture/runtime-migration-progress.md` 当前状态节执行 `.githooks/check_layer_boundaries.py --report` exit 0（输出空清单）

### D2 验收

1. `services/ports/` 仅剩 9 个多消费方 port；7 个单消费方接口声明出现在各自消费方文件内（`rg "interface IFileChangeDiff"` 命中 event-interpreter.ts 等 7 处消费方文件）
2. 依赖方向不变：`rg "ports/" services/ infra/` 确认 infra 实现类仍 import 消费方文件（或原 ports 位置）的契约——**折叠不得把依赖倒置折没**（如果某实现类无处 import 契约，说明折叠做成了「删接口」，是错的）
3. `npx vitest run`（packages/runtime）全绿——测试替身从 `as unknown as` 强转改为实现真实契约（类型安全兑现的正面证据）；DP-2 裁决记录进设计文档

### D3 验收

1. `rg "ITerminalService|IWorktreeService" packages/runtime/src` 命中 interfaces.ts + 实现类 :64/:119 + server.ts:46,48，ports/ 无残留
2. 真实场景：dev app 打开 Terminal 面板 spawn PTY + 输入输出回显正常；worktree 场景（检测 bare/plain/not-repo 三态）输出与迁移前一致（Playwright + runtime 日志断言）

### D4 验收

1. 真实场景：dev app 中切换默认模型 → 切换 provider → 增删 provider（5 case 各跑一遍），断言 WS 事件序列（config.defaults/provider 列表/错误文案）与迁移前一致（Playwright 监听 WS 事件比对）
2. `reconcileDefaultModelAfterProviderChange` 在 config-service 单测中 5 case 直测（不依赖 WS 集成）
3. settings-message-handler.ts 该区域只剩「参数提取 → 调用 → 按返回值发送」

### D5 验收

1. 真实场景：① 断网/错误路径触发恢复分支，两条用户文案与迁移前一致（DOM 断言）② 消息同步 gap 场景（删除本地历史后用 fromSeq 同步）补发行为一致 ③ deleteByCwd 批量删除后 timeout 清理与单删顺序语义不变（分场景断言）
2. `isEnoent` 分类与 gap 判定作为 session-service/message-bus 纯函数单测覆盖（code+userMessage 结构化返回直测）

### D6 验收

1. `rg "JsonStore" packages/runtime/src/services/app-config-store.ts` 命中（复用深模块）；`rg "JSON_INDENT"` 全部指向单一导出
2. 真实场景：删除 config.json 后启动 dev app（ENOENT 走 JsonStore 默认值路径）、修改配置后原子写落盘——行为与手写骨架一致（含损坏 JSON 容错分支）

### D7 验收

1. `stateTypeKey` 映射含 `'session.workflowUpdate'`；单测断言：发布 workflowUpdate 后 `stateSnapshot` 非空且 last-value 覆盖正确（message-bus 既有测试基建扩展）
2. 真实场景：dev app 启动 workflow（触发 event-interpreter:591 广播），重开 session 后工作流状态可从 snapshot 恢复（若 phase-2 范围含恢复）；broker.broadcast 调用数从 55-57 处下降（dual-write 退出进度）

### D8 验收

1. 每个切分 commit 后 `npx vitest run` 全绿 + `pnpm run dev` 冒烟（facade 拆不得破坏 17 个 transport handler 的消费面）
2. token/usage 状态抽 tracker 后：session-service 行数下降、setter 注入从 11 个减少到 tracker 内部；`VALID_TOOL_MODES` 在 shared 唯一权威（`rg "VALID_TOOL_MODES"` 命中 shared + 消费方，preset-service 无本地副本）
3. 渐进性验证：禁止单 commit 大爆炸——每步 commit 的 diff 规模与语义可独立 review（对照 AGENTS.md §12 打包改动逐个 commit 的精神）

### D9 验收

1. 无代码改动（关闭确认）；审查报告与总纲标记「已核查关闭，原因：record 含 INV-1 守卫非纯委托，删除违反 AC-2.4/2.5 设计意图」
2. 附带验证：`workspace-service.ts` 保持 52 行规模不再膨胀（组织债不新增）

## §5 下一层拆分

### 依赖顺序

```
W1: D1（独立，无前置）
W2: D3（独立）∥ D4（独立）
W3: D5（依赖 D8 第一步的抽方法重构——同文件）→ D6（独立）∥ D7（前置 ADR-0055 边界确认）
W4: D8（三步渐进，每步独立 commit）
W5: D2（前置 DP-2 裁决）∥ D9（关闭确认，零代码）
```

### 任务清单（按波次）

**W1（D1）**：① utils/source-type.ts + utils/provider-enabled.ts 下沉（改 6 处 import）② PiTranslatedEvent 移 ports/pi-engine.ts（改 2 处 import）③ shared/src/pi-session.ts 类型下沉 + pi-protocol.ts re-export + session-entry-mapper 移 utils（改 4 处 import）④ IConfigStore 扩 getApiKeyForProvider/listProviderNames + quota-service/provider-importer 注入（改 3 文件）⑤ `.githooks/check_layer_boundaries.py` 新建（含 --report 模式）⑥ install-hooks.sh 接入段 + SKIP_LAYER_BOUNDARY_CHECK ⑦ runtime-migration-progress.md 当前状态节改造（与 06-doc-debt.md 协同）⑧ 每步独立 commit + 验收 §4-D1 全项

**W2（D3/D4）**：D3：interfaces.ts 增两接口 + 删 ports 两文件 + 改 3 处 import（1 commit）；D4：config-service 新增对账/广播方法 + handler 改造（1-2 commit），每 commit 后跑验收场景

**W3（D5/D6/D7）**：D5 前置 D8 抽方法；D6 一个 commit；D7 对齐映射 + dual-write 收口（对照 ADR-0055 边界），3 项可并行

**W4（D8）**：三步（usage tracker → 委托内联 → preset 校验抽模块），每步 commit + 测试 + 冒烟

**W5（D2/D9）**：DP-2 裁决记录 → D2 折叠 7 port（1 commit + 测试替身改造）；D9 关闭标注（0 commit 或仅文档 commit）

### 风险与注意

- D1 的 Step 3 涉及 shared 包改动 → 触发 extensions/renderer 类型检查（`pnpm extensions:typecheck` + renderer vitest），PiSessionEntry 若被其他包消费需同步
- D4/D5 迁移期间 transport handler 与 services 是双写状态（临时），每步 commit 保持可回滚
- 打包链路：W3 后跑 `bash scripts/validate-runtime-bundle.sh`（runtime 文件变更触发 pre-commit 自带检查）
