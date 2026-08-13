# 1. 包级链（shared → core → dom-core → ui → renderer）详细设计

> 本文件是 [README.md](README.md) 的子文档，覆盖候选 **B1-B7**（包级链层）。波次映射：B1/B2 → W0、B3 → W3（前置 DP-1）、B4 → W4、B5/B6/B7 → W5（分别前置 DP-6 / DP-5）。
> 所有路径/行号均经 2026-08-20 二次核实（审查报告后代码有少量漂移，本文件以实测为准，差异见各条目）。

## §1 背景与目标

### 背景（SCQA）

2026-08-13 架构审查（5 subagent × 109 项声明对抗核查）对包级链的判定：**依赖方向成立**——五包链（shared → core → dom-core → ui → renderer + mobile-renderer）零反向 import、零环，但存在三类组织债：

1. **shim 残留**：renderer 内 5 个 core/ui 的 re-export 兼容壳（B1），绞杀迁移完成后未清除，interface 出现双入口
2. **声明与事实漂移**：core 声明依赖 pinia 但生产源码零消费（B2）；shared 的「12 域」实为 27 个扁平文件（B4）；包名 frontend vs 文档 renderer（B5）
3. **越层与文档 gap**：composer-shell 直连 dom-core 未入图（B6）；mobile sync 的 COPY_MAP 纪律描述的是不存在的脚本（B7）

此外 B3（logic/ 纯函数下沉）与 renderer-target-architecture §2.2「留在原处」裁定存在张力，是本层唯一需要裁决的方向性改动（DP-1）。

### 目标

1. **死 shim 清除**（B1）：renderer 的 core/ui re-export 兼容层全部删除，消费方寻址直达真源，interface 恢复单入口
2. **interface 诚实化**（B2）：core package.json 去掉 pinia 假声明，ADR-0059「core 真 headless + pinia 集成走 renderer 薄壳」名副其实
3. **跨端 leverage**（B3，DP-1 裁决后）：logic/ 纯算法下沉 core，mobile 不再重造 markdown/parseDiff
4. **shared 按域收敛**（B4）：扁平大杂烩先补 exports 子路径、再评估配置域拆出
5. **命名一致**（B5）：包名/目录/文档三语境统一
6. **文档与事实对齐**（B6/B7）：五包图画成 DAG 事实、删除未实现机制的纪律描述

### Out of Scope

- 不改变五包链的依赖方向（审查实测方向成立，无需重构）
- 不新增第三方依赖（B3 的依赖迁移是把 renderer 既有依赖平移进 core，不是新增）
- 不实现 mobile sync 脚本（B7 只清文档与依赖，实现同步机制是未来的功能项）

## §2 现状与问题分析（层判定结论 + 候选问题清单表）

### 层判定结论（来自审查报告 §0/§1）

| 维度 | 判定 | 证据 |
|------|------|------|
| 依赖方向 | ✅ 成立（零反向、零环） | 实测确认；⚠️ 核查修正：无自动化守护，AC1 护栏测试只覆盖 mobile-renderer 边 |
| 链 vs DAG | 形态是 DAG 非链 | renderer 直连 core 96 文件（含测试口径；非测试 65）、直连 shared 237 文件、1 文件越层直连 dom-core |
| 漏画叶子 | extension-protocol（0.8k 行零依赖）被五方依赖，不在五包图 | 依赖 DAG 最底层 |
| 模块名漂移 | renderer 目录包名实为 @xyz-agent/frontend | packages/renderer/package.json:2 |
| core 纯度 | ✅ 「真 headless」实测通过（vue 仅 reactivity 符号、DOM/electron 零命中） | 审查实测；B2 的 pinia 是唯一声明面瑕疵 |

### 候选问题清单

| 编号 | 级别 | 一句话 | 波次 | 前置 |
|------|------|--------|------|------|
| B1 | Strong | 清除 renderer 的 core/ui re-export shim 层（5 文件） | W0 | 无 |
| B2 | Strong | core 的 pinia 死声明移出 dependencies（降 devDependencies） | W0 | 无 |
| B3 | Worth | composables/logic/ 纯函数下沉 core（12 文件 1347 行） | W3 | **DP-1 裁决**（与 §2.2「留在原处」冲突） |
| B4 | Worth | shared 扁平大杂烩按域收敛（轻量步 exports 子路径 → 重步拆配置域） | W4 | 无 |
| B5 | Worth | 包名统一 frontend vs renderer | W5 | **DP-6 裁决**（改包名 vs 文档改口） |
| B6 | Speculative | composer-shell 越层直连 dom-core：文档注记（选项 b） | W5 | **DP-5 裁决**（注记 vs 强制链式） |
| B7 | Speculative | mobile sync 文档 gap：删纪律描述 + 清 shared 依赖 | W5 | 无 |

### 事实修正说明（相对审查报告）

- logic/ 目录现为 **12 个 .ts 文件 1347 行**（审查时 13 文件 1456 行含 guiComponent.ts，该文件已按 C4 内联删除；本次实测时 guiComponent 已不存在）
- sessionStatus.ts 实为 **104 行**（非 195），且其核心 deriveStatus 已迁 core/domain/chat/derive-status.ts，本文件是 re-export 转发 + 视觉映射（DOT_CLASS/STATUS_ICON）
- useMessageBusSubscription shim 非测试消费方实测为 **0**（头注释声称的 useChat.ts/useConnection.ts 已直接 import core），仅 3 个测试文件引用
- shared/src 实测 **27 个 .ts + index.ts + 2 json + __tests__，3993 行**（与审查 3997 行近似）

## §3 解决方案

### B1 · 清除 renderer 的 core/ui re-export shim 层

**级别**：Strong（删除 · 收敛）｜**波次**：W0

**问题**

绞杀迁移（ADR-0058/0059）完成后遗留的 5 个兼容壳，interface 与 implementation 字面合一（纯 re-export），消费方与直连两轨并存，interface 出现双入口、有漂移风险：

| shim 文件 | 行数 | 内容 | 非测试消费方 |
|---|---|---|---|
| `lib/ws-client.ts` | 25 | 头注释自述「@deprecated…过渡期 re-export shim」 | 3（useExtensionHostBridge / api/mock/index / api/transport） |
| `lib/utils.ts` | 8 | `export { cn } from '@xyz-agent/ui'` | 29 |
| `lib/file-basename.ts` | 8 | `export { findByBasename, collectBasenames, collectFilePaths } from '@xyz-agent/ui'` | 3 |
| `composables/useSessionScopedState.ts` | 12 | `export * from '@xyz-agent/core/foundation/use-session-scoped-state'` | 6 |
| `composables/useMessageBusSubscription.ts` | 23 | `export * from '@xyz-agent/core/coordination/subscription-state'` | 0（仅 3 个测试文件引用） |

> 注意：`stores/chat.ts` 的 pinia 注册薄壳**不在此列**——它是 ADR-0059 终态（renderer 负责 pinia 集成、core 保持 headless），保留。

**方案对比**

- **方案 A：全删 shim + 消费方改指真源**（**长期方案**）：5 个 shim 文件删除，import 路径改为 `@xyz-agent/core/...` / `@xyz-agent/ui/...` 直连。核心 re-export 保证单 registry 实例（useSessionScopedState 的 sessionCleanupRegistry 在 core 包内单例）——删除 shim 不改注册语义，因为 shim 本身就是纯转发，直连后 registry 仍是 core 内单例，`triggerSessionCleanups` 调用链不变。取舍：一次性改动 41 处 import（ws-client 3 手改 + utils 29 脚本批量 + file-basename 3 + useSessionScopedState 6 + 测试文件若干），但之后 interface 单入口、死层消失。
- **方案 B：保留 shim 作为稳定转发面**（**短期方案**）：以「未来核心包版本升级时 renderer 可独立 pin 版本」为由保留。取舍：零改动，但 shim 头注释已自述待删、消费方全量直连 core 的事实说明「独立 pin 版本」从未发生——留着一个文档与事实漂移的假 seam，无维护收益，只有寻址成本。
- **方案 C：删 shim + 加 lint 规则禁止新兼容层**（**长期方案**，B1 的守护延伸）：删除之外，在 taste-lint 加一条「renderer 内禁止创建 re-export 兼容层」的检查（模式：文件只有 `export * from '@xyz-agent/*'` 或单行 re-export 且无本地逻辑）。取舍：额外工作量；考虑到通用病根是「无守护 → 回潮」，本层建议在 W1（D1 加 pre-commit 守护的波次）一并评估，不阻塞 W0 删除本身。

**推荐**：方案 A（W0 立即执行）+ 方案 C 的 lint 守护随 W1 评估（不阻塞）。作者自注待删、纯转发零逻辑，删除是零风险操作。

**消费方清单**（删除前逐一确认 import 行语义）：

| shim | 消费方文件（非测试） | 改后 import 目标 |
|---|---|---|
| `lib/ws-client.ts` | useExtensionHostBridge.ts · api/mock/index.ts · api/transport.ts | `@xyz-agent/core/transport/ws-client` |
| `lib/utils.ts` | 29 文件（脚本批量） | `@xyz-agent/ui`（cn 同一包） |
| `lib/file-basename.ts` | 3 文件（脚本批量） | `@xyz-agent/ui` |
| `composables/useSessionScopedState.ts` | useCompactQueue.ts · useSidebar.ts · useTerminal.ts · useSessionMarkers.ts · stores/turn-expansion.ts | `@xyz-agent/core/foundation/use-session-scoped-state` |
| `composables/useMessageBusSubscription.ts` | 非测试 0；测试 3（select-session-pull / useMessageBusSubscription / useChat） | `@xyz-agent/core/coordination/subscription-state` |

注意 useSessionScopedState 的 5 个消费方中 useSidebar.ts 是 session 销毁编排点（triggerSessionCleanups）——改 import 后 registry 单例语义不变（core 包内单例），但建议在 dev 冒烟中专门验证删除 session 的清理链路（见验收 1）。

**改动点**

1. `packages/renderer/src/lib/ws-client.ts` 删除；3 处消费方手改 import 指向 `@xyz-agent/core/transport/ws-client`：`composables/shell/useExtensionHostBridge.ts`、`api/mock/index.ts`、`api/transport.ts`（注意 mock 分支的 platform 注入语义已由 createMockPlatform 承担，import 改路径即可，不触碰 mock 逻辑）
2. `lib/utils.ts` / `lib/file-basename.ts` 删除；32 处消费方脚本批量替换：`@/lib/utils` → `@xyz-agent/ui`（utils 29 + file-basename 3），用 `sed -i 's|@/lib/utils|@xyz-agent/ui|g'` 后逐个文件确认 import 行语义（utils 的 cn 来自 `@xyz-agent/ui`，file-basename 同理）
3. `composables/useSessionScopedState.ts` 删除；6 处消费方改 import `@xyz-agent/core/foundation/use-session-scoped-state`
4. `composables/useMessageBusSubscription.ts` 删除；3 个测试文件（select-session-pull.test / useMessageBusSubscription.test / useChat.test）改 import `@xyz-agent/core/coordination/subscription-state`
5. `rg -n "@/lib/ws-client|@/lib/utils|@/lib/file-basename|@/composables/useSessionScopedState|@/composables/useMessageBusSubscription" packages/renderer/src` 确认零残留（除测试 fixtures 里作为字符串出现的除外，逐个判断）

**风险**：低。纯 re-export 转发，无本地逻辑。唯一注意点：useSessionScopedState 的「禁止复制实现」约束（双份 registry 会导致 triggerSessionCleanups 失效）在删除 shim 后天然满足——消费方直连 core 单例；实施时不得顺手「内联实现」。

**验收**（真实场景）

1. `pnpm run dev` 启动，新建 session → 发消息 → 收回复 → 折叠/展开侧栏 → 切 session → 重开 session 验证历史（重开验证 sessionCleanupRegistry 单例仍生效：删除旧 session 后侧栏状态无残留）
2. `npx vue-tsc --noEmit`（renderer 目录）通过——shim 删除后全部 import 指向有效
3. 一次完整对话中触发 session 切换与删除，确认 `triggerSessionCleanups` 仍正常编排（useSidebar.deleteSession 路径冒烟）
4. `rg` 确认 5 个 shim 路径零残留引用

**下一层拆分**

- [ ] T1-1 删 ws-client shim + 3 处手改（含 mock 分支确认）
- [ ] T1-2 脚本批量替换 utils/file-basename 消费方（29+3 处），逐个文件过一遍 import 行
- [ ] T1-3 删 useSessionScopedState / useMessageBusSubscription shim + 9 处（6 消费 + 3 测试）改 import
- [ ] T1-4 零残留 rg + typecheck + dev 冒烟（T1-1~3 完成后一起验）
- [ ] T1-5 随 W1 评估「禁止 re-export 兼容层」lint 守护（可选，见方案 C）

### B2 · core 的 pinia 死声明移出 dependencies

**级别**：Strong（interface 诚实化）｜**波次**：W0

**问题**

`packages/core/package.json:90` dependencies 声明 `"pinia": "^3"`，但 core 生产源码**零 import**（grep `createPinia|defineStore` 仅命中注释提及：terminal-write-queue.ts:57/65/68、useChat.ts:8、timers.ts:37 均为文档性说明，无实际 import）。仅测试文件 2 处消费：

- `src/domain/chat/__tests__/store.test.ts:17,50`（createPinia/setActivePinia）
- `src/domain/chat/__tests__/derive-status.test.ts:13`

声明依赖即 interface 承诺——消费方读到「core 依赖 pinia」会误判 core 有 pinia 耦合，与「core 真 headless」的实测纯度矛盾。ADR-0059 的前提（pinia 集成走 renderer 薄壳、core 不含 pinia）因死声明而未名副其实。

**方案对比**

- **方案 A：pinia 移出 dependencies → devDependencies**（**长期方案**）：测试的 createPinia 是 vitest 标准做法（为每个 store 测试建独立 pinia 实例），devDependencies 恰好表达「仅测试时消费」。取舍：一行 package.json 改动 + pnpm-lock 更新，零代码改动；语义精确（生产依赖 = 生产源码真实消费面）。
- **方案 B：纯删除 pinia 依赖**（**短期方案**，不可行）：测试文件直接挂——2 个测试的 createPinia 需要重写为手写 store 注入。取舍：为删一个依赖而手写测试替身，引入不必要复杂度，且 pinia 测试语义（store 实例隔离）是成熟模式，不值得绕。除非未来测试全面改造，否则无理由。
- **方案 C：core 生产源码引入 pinia**（反向，明确不做）：既然已声明就「用起来」——把 renderer 的 pinia store 下沉 core。取舍：直接违反「core 真 headless」核心承诺与 ADR-0059 架构裁决，是本层最不该做的事。列出仅为排除。

**推荐**：方案 A。一行改动使 interface 诚实化，ADR-0059 前提恢复名副其实。

**改动点**

1. `packages/core/package.json`：`"pinia": "^3"` 从 dependencies 移入 devDependencies（保留版本号不变）
2. 根 `pnpm install --lockfile-only` 更新 pnpm-lock.yaml（pinia 从 core 的 prod 依赖边移到 dev 边；注意 pinia 本身仍是 renderer/mobile-renderer 的 dependencies，lock 中不会消失，只是 core 的依赖分类变化）
3. 顺带在 core 源码的 terminal-write-queue.ts 注释区确认「Pinia defineStore factory 单例」表述不引起误会——注释描述的是 renderer 侧包装，无需改动（仅核实）

**风险**：极低。生产源码零消费，依赖降级不影响任何运行时行为。core 包无 tsup bundle（package.json 仅 typecheck/test scripts，源码直出 src/，无打包环节）——因此不涉及 AGENTS.md §12 的 noExternal 连锁；pinia 从 core prod 边移除只影响依赖声明与 lock 拓扑。唯一连带：若未来 core 生产源码真要 import pinia，pnpm 会立即报 missing dependency——这正是 interface 诚实化想要的早期信号。

**为什么是 devDependencies 而不是从 lock 彻底消失**：pinia 仍在 renderer/mobile-renderer 的 dependencies（它们才是 pinia 的消费方），lock 中包本身不消失；core 的依赖边从 prod 移到 dev，`pnpm --filter @xyz-agent/core why pinia` 输出变为 dev-only，即诚实面。

**验收**（真实场景）

1. `cd packages/core && pnpm install` 后 `pnpm exec vitest run` 全绿（2 个含 createPinia 的测试正常）
2. `npx tsc --noEmit`（core 目录）通过
3. 全仓 `npx vitest run`（renderer 目录）通过——验证 pinia 从 core prod 边移除后 renderer 侧 store（它们直接依赖自己的 pinia）无影响
4. `pnpm run dev` 启动，chat 域 store 正常工作（发消息收回复）——pinia store 注册链（renderer 薄壳）不受影响

**下一层拆分**

- [ ] T2-1 core package.json 移动 pinia 声明 + lock 更新
- [ ] T2-2 core 测试 + renderer 测试全绿 + dev 冒烟
- [ ] T2-3 随 W1 评估「core 生产源码禁 pinia import」pre-commit 守护（可选，与 D1 同批）：core 源码目录 `rg "from 'pinia'"` 硬错误，防止未来把 renderer store 下沉 core 时顺手拖入 pinia——这是「无守护 → 回潮」在本候选中对应的守护位，建议在 D1 的检查脚本里一并覆盖（一条「core 禁 pinia 运行时 import」规则，DOM 零命中同理）

### B3 · composables/logic/ 纯函数下沉 core

**级别**：Worth（下沉 · 跨端 leverage）｜**波次**：W3｜**前置**：DP-1 裁决（与 renderer-target-architecture §2.2「留在原处」裁定冲突）

**问题**

`packages/renderer/src/composables/logic/` 现为 **12 个 .ts 文件 1347 行**（审查时 13 文件含 guiComponent.ts，已按 C4 内联删除）：

| 文件 | 行数 | 依赖面 |
|---|---|---|
| markdown.ts | 541 | katex / markdown-it / markdown-it-katex / shiki（第三方）+ `@/i18n`（t 直接耦合） |
| parseDiff.ts | 235 | 纯函数（无 i18n 依赖） |
| mermaid.ts | 138 | 动态 import mermaid（懒加载）；**:42 读 `document.documentElement.getAttribute('data-theme')`**（全目录唯一 DOM 命中） |
| file-type.ts | 112 | 纯映射（无 i18n 依赖） |
| sessionStatus.ts | 104 | 已是 re-export shim：deriveStatus 迁 core 后转发 + 视觉映射（DOT_CLASS/STATUS_ICON 属展示层） |
| messageFormat.ts | 39 | `@/i18n` 直接耦合 |
| file-tree-utils.ts | 37 | 纯函数（findNodeByPath 等） |
| formatTime.ts | 37 | `@/i18n` 直接耦合 |
| popover-styles.ts | 41 | theme 字符串（CSS 类映射） |
| session-file-format.ts | 35 | 纯函数 |
| messageTurns.ts | 17 | 纯函数 |
| summarizeTurn.ts | 11 | **零调用方死代码**（唯一引用是自己的测试，TD7 迁 core 后的残骸；属 C4 清理范围，W0 删） |

判定：12 文件中 11 个无 vue 无 DOM（唯一例外 mermaid.ts:42）；依赖面全纯函数 + 两个薄 seam——`@/i18n` 直接 import（实测 3 文件：formatTime/markdown/messageFormat，⚠️ 核查修正：审查报告「t 注入 4 文件」口径偏宽，parseDiff/file-type 等为无 i18n 依赖的纯函数）+ theme 字符串（mermaid/popover-styles）。纯算法被锁定在装配层（renderer），mobile-renderer 无法复用——mobile 若要渲染 markdown 只能重造 541 行。

**与既有裁定的张力**：renderer-target-architecture §2.2 明确「composables/logic/（13 个零状态纯函数文件）→ 合法落点，留在原处」，理由是「stores 可 import 纯函数（无状态无倒置）」。那是**包内七层视角**（renderer 内部 Foundation 层组织）；本候选是**包级 leverage 视角**（跨端复用优先）。两个视角冲突，需 DP-1 裁决——主文档推荐倾向：包级 leverage 优先（移动端复用价值 > 包内七层纯净），下沉。

**方案对比**

- **方案 A：全量下沉 core**（**长期方案**，DP-1 裁决后实施）：12 文件（剔除 summarizeTurn 死代码后约 1336 行）迁 `packages/core/` 合适子域（如 `core/domain/markdown/`、`core/domain/diff/`、`core/foundation/logic/` 按域归位），t 注入从「直接 import renderer i18n 单例」改为**参数注入**（函数签名带 `t?: TranslateFn`，默认回退 key 直出，renderer 调用点传 `i18n.global.t`），theme 字符串同理（mermaid 的 data-theme 读取改为参数 `theme: 'dark'|'light'`，renderer 从 DOM 读后传入；popover-styles 的 CSS 类映射保留 renderer 侧——CSS 类属展示层）。第三方依赖（katex/shiki/markdown-it/mermaid）平移进 core dependencies（renderer 已有，非新增）。取舍：import 改写面大（logic 的消费方遍布 renderer，估计数十处）、core 增加 4 个第三方依赖、需要 core 侧新增单测迁移；收益是三端复用（mobile 直接 import core 渲染 markdown/diff）、headless 逻辑与 core 域同处、renderer 瘦身 ~1.3k 行。
- **方案 B：留在原处**（**短期方案**，维持 §2.2 裁定）：零改动，renderer 内部组织保持「logic 目录 = 合法落点」。取舍：mobile 将来需要 markdown/parseDiff 时只能复制或重写（跨端重复实现——正是 C3/F1 类问题在包级链的重演）；且 sessionStatus 已出现「核心迁走、视觉留在 renderer」的拆分先例，留在原处的文件实际是一半 shim 一半逻辑的混合态，归属边界已经模糊。
- **方案 C：分批下沉**（**短期过渡方案**）：先迁大文件（markdown/parseDiff/mermaid，约 914 行），小文件（file-type/formatTime/messageTurns 等）后续再议。取舍：降低单次改动面与审查成本，但同域逻辑两处维护、t 注入契约要在两批里分别定，中间态存在「部分 logic 在 core、部分在 renderer」的歧义期。

**推荐**：方案 A（全量下沉），但**必须等 DP-1 裁决通过**——裁决是方向性决策（§2.2 裁定是否推翻），本设计不预判结果；若裁决维持「留在原处」，则 B3 关闭并在 §2.2 追加「mobile 复用需求出现时重议」注记。实施时按方案 C 的分批节奏降低风险（裁决后批次执行，但目标是全量）。

**改动点**（裁决通过后）

1. `packages/core/` 新增子域目录：markdown 域（markdown.ts + 依赖声明 katex/shiki/markdown-it/markdown-it-katex 入 core dependencies）、diff 域（parseDiff.ts）、foundation 纯逻辑（file-type/formatTime/messageTurns/file-tree-utils/session-file-format/messageFormat）、mermaid 域（mermaid.ts + mermaid 依赖 + theme 参数化）
2. t 注入改造：formatTime/markdown/messageFormat 3 个直接耦合 `@/i18n` 的文件，函数签名加 `t` 可选参数（默认回退 key 直出）；renderer 调用点统一传 `i18n.global.t`（调用方改动集中在 markdown 渲染链路）
3. mermaid.ts:42 的 `document...getAttribute('data-theme')` 改为 theme 参数（renderer 的 MermaidRenderer.vue 读 DOM 传入）
4. summarizeTurn.ts 删除（C4 W0 已排，实施 B3 前确认已删，避免把死代码搬进 core）
5. renderer 消费方 import 改写 + logic 目录删除；原 renderer 测试（如 `src/__tests__/composables/mermaid.test.ts`、logic 相关单测）迁移到 core 对应目录，`logic/__tests__/summarizeTurn.test.ts` 随死代码删除
6. 同步更新 renderer-target-architecture §2.2：logic/ 条目改为「已迁 core」并追加 DP-1 裁决记录

**风险**：中。① import 改写面大（logic 消费方多）；② t 注入契约从「编译期耦合 renderer i18n 单例」变「运行时参数」，漏传 t 会导致文案回退到 key（不崩但丑）——需在 renderer 调用点统一收口；③ mermaid 懒加载语义（动态 import 缓存）迁 core 后单例归属变化，需在 core 侧保留同一缓存语义；④ core 新增 4 个第三方依赖（katex/shiki/markdown-it/mermaid）：core 无 tsup bundle（与 B2 同理，源码直出 src/），不涉及 noExternal 连锁；但需确认 renderer 的 vite 构建链路对 core 内第三方依赖的 external/预构建处理（shiki/mermaid 的 worker/动态 import 形态），打包链路验证见验收 5。

**验收**（真实场景）

1. `pnpm run dev` 启动，发一条含代码块（fence）与 mermaid 块的消息，确认：代码高亮（shiki 双主题 + CSS 变量切换）、mermaid 渲染、明暗主题切换后 mermaid 重渲染（theme 参数链路）——三个渲染链路全过
2. 同一会话中打开文件 diff（DetailPane），parseDiff 渲染与迁移前一致（对比迁移前后截图，行为等价验证）
3. 消息时间戳/文件类型图标（formatTime/file-type）与迁移前一致
4. mobile-renderer（若已初始化 markdown 消费）直接 import core markdown 域成功——跨端复用验证（当前 mobile 无 markdown 消费则验证 import 可达即可）
5. core + renderer 全量测试绿 + `pnpm run lint` + `bash scripts/validate-runtime-bundle.sh`

**下一层拆分**

- [ ] T3-1 DP-1 裁决（W3 前）：reviewer 核对 §2.2 裁定与包级 leverage 视角，出裁决记录
- [ ] T3-2 纯函数小文件批：file-type/formatTime/messageTurns/file-tree-utils/session-file-format/popover-styles（t 参数化 + 消费方改写）
- [ ] T3-3 markdown 域：依赖声明 + 迁移 + 调用点 t 注入
- [ ] T3-4 diff 域：parseDiff 迁移
- [ ] T3-5 mermaid 域：theme 参数化 + 懒加载语义保持
- [ ] T3-6 死代码确认（summarizeTurn 已在 W0 删）+ logic/ 目录清空删除
- [ ] T3-7 §2.2 文档更新 + 全量验证（见验收）

### B4 · shared 扁平大杂烩按域收敛

**级别**：Worth（分域 · 长期方案）｜**波次**：W4

**问题**

⚠️ 核查修正口径：审查报告原文「shared 非 12 域」——`packages/shared/src` 实测 **27 个扁平 .ts 文件 + index.ts + 2 个 json（mandatory/recommended-extensions）+ __tests__，共 3993 行**，无目录分层；标注「SSOT/单一真值源」的文件实测 10-11 个（原「9」偏低）。内容构成：**消息协议占主体**（message/message-metadata/session/panel/subagent/workflow/project/plugin/extension/settings/update/workspace/segments 等）+ **Provider 预设/配额次之**（provider/pi-preset/pi-default-prompt/quota-presets/quota-types）+ 路径（paths）+ 零散（constants/git/file-tree/migration/discovery-migrate/sound-defaults/protocol）。

interface 是「什么都装」的扁平集合：新成员定位困难（27 文件平铺无导航）、浅接口无深度。renderer 消费 shared 达 237 文件，但全部走 `@xyz-agent/shared` 主入口（零子路径 import），exports 目前只有 `.` 和 `./paths` 两个入口。

**方案对比**

- **方案 A：轻量步——按域补 exports 子路径分层暴露**（**长期方案的第一步**，低风险）：为 message/paths/provider/quota/config 等域补 `@xyz-agent/shared/<domain>` 子路径 exports（对齐既有 `./paths` 先例），index.ts 保留聚合 re-export 作兼容面。消费方渐进迁移：新代码走子路径，旧 import 不强制改。取舍：改动小（package.json exports + 少量内部文件归位）、零行为变化；收益是域导航 + 依赖面可观测（谁在消费哪个域一目了然），为重步铺路。
- **方案 B：重步——配置域拆出独立包**（**长期方案**，成本高）：Provider 预设/配额（provider/pi-preset/pi-default-prompt/quota-presets/quota-types，约 787 行量级）拆成独立包（如 `@xyz-agent/provider-config`）或并入其主消费方（model-switch extension 的 shared 定位，关联 F3 DP-3 裁决），shared 收敛为「消息协议 + 真跨端常量」。取舍：monorepo 级连锁——workspace 声明、所有消费方 import 改写（237 处 renderer + runtime + extensions）、exports 重构；拆错域会引入新的组织债。审查报告明确警告「拆包动 exports 是 monorepo 级连锁，建议分步」。
- **方案 C：不动**（**短期方案**）：维持扁平。取舍：零成本，但 27 文件平铺的导航成本与「什么都装」的浅接口持续存在；且 F3（quota-providers 死面删除）若推进，shared 的配置域定位会进一步动摇，不动反而放大模糊。

**推荐**：方案 A 先落地（W4 内完成），方案 B 列为后续项并与 F3 的 DP-3 裁决联动——quota 域去留取决于 shared 层定位裁决，不应独立拆包。轻量步是重步的前置验证：子路径暴露后能实测各域真实消费面，拆包决策才有数据。

**改动点**

1. `packages/shared/package.json` exports 按域补子路径：先补消费面清晰的域——`./message`（消息协议主体）、`./provider`（provider/pi-preset/quota 预设，若 F3 未裁决则暂缓）、`./config`（settings/migration 等配置域）；内部文件按域归入 `src/<domain>/` 子目录或保持平铺仅加 exports 映射（轻量步可不物理移动文件，只加 exports 入口）
2. index.ts 保持聚合导出兼容（消费方零破坏）
3. 新增消费（新代码）走子路径的约定写入 docs/standards.md；renderer/runtime 的存量 237 处 import 不强制迁移（渐进）

**风险**：低（轻量步）。exports 子路径是 additive 变更，主入口不变则零破坏。唯一注意：子路径与平铺文件名冲突（如 `./message` vs `./message.ts` 的解析歧义）——exports 显式映射可消除歧义，实施时逐域验证 import 解析。

**验收**（真实场景）

1. `@xyz-agent/shared/message`（示例子路径）在 renderer 与 runtime 中可正常 import 且类型完整（tsc 通过）
2. 新建一个消费 shared 的代码，走子路径 import，`pnpm run dev` 下类型提示与运行时均正常（HMR 无报错）
3. 全部既有主入口 import 零改动仍工作（全量 typecheck + 测试绿）
4. 导出子路径清单与实际域文件一一对应（`pnpm exec node -e "console.log(Object.keys(require('@xyz-agent/shared/package.json').exports))"` 输出与设计一致）

**下一层拆分**

- [ ] T4-1 盘点各域文件归属 + 消费面实测（谁在 import 什么，237 处按域聚合统计）
- [ ] T4-2 补 message/config 域 exports 子路径（先行两域试点）
- [ ] T4-3 试点验证（renderer/runtime 各一处消费方迁移到子路径）
- [ ] T4-4 全量域 exports 补齐 + standards.md 约定写入
- [ ] T4-5 （联动 F3/DP-3）评估配置域拆包可行性，输出重步裁决

### B5 · 包名统一：frontend vs renderer

**级别**：Worth（interface 命名一致性）｜**波次**：W5｜**前置**：DP-6 裁决

**问题**

`packages/renderer/package.json:2` 包名 `"name": "@xyz-agent/frontend"`，而目录名是 `renderer`、全部文档/速查表/护栏测试用「renderer」。同一 module 三个语境两个名字：新成员（含 AI agent）import 时必然踩坑——查 `@xyz-agent/frontend` 找不到文档，查 renderer 目录又对不上包名。

**方案对比**

- **方案 A：改包名为 `@xyz-agent/renderer`**（**长期方案**，主文档 DP-6 推荐）：改 package.json name 一处，目录名与包名对齐；连带改动的引用点：AC1 护栏测试（`FORBIDDEN_XYZ_DEPS` 含 `'@xyz-agent/renderer'` 字符串，mobile-renderer 测试）、可能存在的 workspace 内 import 依赖名（renderer 是叶子壳包，无下游消费方，主要是测试与文档）。取舍：改口面最小（包名一处 + 测试/文档跟随）；但改名会让「曾经叫 frontend」的历史在 git 中留痕，且 npm workspace 引用名变化需全仓 grep 清理。
- **方案 B：文档/测试全部改口 frontend**（**短期方案**）：保留包名，把 renderer-target-architecture、module-map、速查表、审查文档里所有「renderer」改「frontend」。取舍：改口面大得多（文档散布全仓）；且目录名 `renderer` 与包名 `frontend` 的错位依然存在——文档改口后三语境变两名字，问题只是换了个方向没消除。
- **方案 C：目录改名 frontend**（不推荐）：物理移动 `packages/renderer` → `packages/frontend`。取舍：git 历史断裂、所有相对路径 import 链失效、波及 build 配置，成本远超收益。

**推荐**：方案 A（改包名），DP-6 裁决确认后执行。包名是唯一真值源，目录/文档跟随包名是成本最低的对齐方向。

**改动点**（⚠️ 核查修正：改名面不止 package.json 一处——实测 `@xyz-agent/frontend` 字符串在代码与测试注释中共 10+ 处，其中 2 处是**代码内常量**）

1. `packages/renderer/package.json:2`：`"name": "@xyz-agent/renderer"`（其他字段不动）
2. **代码内常量同步**（易漏点）：`src/shell/index.ts:1` 的 `RENDERER_SHELL_SCAFFOLD = '@xyz-agent/frontend/shell'` 与 `src/workspace/index.ts:1` 的 `RENDERER_WORKSPACE_SCAFFOLD = '@xyz-agent/frontend/workspace'` ——这两个常量目前无消费方（注释标「终态迁入点」占位），改包名时同步改为 `@xyz-agent/renderer/...` 保持标识符与包名一致；若判定为废弃占位可随 B5 一并删除（需确认未来 shell/workspace 层落位是否引用此标识符）
3. **测试文件头注释批量改**：约 10+ 个测试文件（BlockSubagent/BlockWorkflow/chat-streaming-reset/provider-page 等）头注释含 `pnpm --filter @xyz-agent/frontend run test` 运行命令——不改会导致命令失效（filter 匹配不到包），脚本批量替换 `@xyz-agent/frontend` → `@xyz-agent/renderer`（含 packages/ui 下 2 个测试的注释）
4. **apps/electron 连带**（关键，漏改则 pnpm install 解析失败）：`apps/electron/package.json:28` 的 `"@xyz-agent/frontend": "workspace:*"`（electron 依赖 renderer 包）改为 `@xyz-agent/renderer`；同文件 :16/:23 的 `dev:vite`/`build:vite` 脚本里 `--filter @xyz-agent/frontend` 同步替换
5. 测试断言：mobile-renderer 的 ac1-dependency-edge.test.ts FORBIDDEN_XYZ_DEPS 含 `'@xyz-agent/renderer'`——**新包名恰好匹配该字符串**，改名后护栏断言语义自动正确（它禁止 mobile 依赖 renderer 壳，@xyz-agent/renderer 不在 ALLOWED 白名单 → 加进 dependencies 会红，护栏有效），注释中确认指向一致即可
6. 文档口径统一：module-map / 速查表 / 审查 README 中「renderer」表述已正确，只需检查是否有按包名 `frontend` 描述处（大概率无——漂移方向是文档用 renderer、包名用 frontend，改包名即对齐）
7. 根 `pnpm install --lockfile-only` 更新 lock 中的包名映射

**风险**：低。renderer 是依赖 DAG 顶层叶子（无下游包依赖它），改名不影响任何上游依赖解析；风险集中在测试字符串断言与文档残留。

**验收**（真实场景）

1. `pnpm install` 后 `pnpm -w list` / `node -e "console.log(require('packages/renderer/package.json').name)"` 显示 `@xyz-agent/renderer`
2. mobile-renderer 的 AC1 护栏测试仍绿（FORBIDDEN_XYZ_DEPS 的 `'@xyz-agent/renderer'` 与新包名匹配——故意把 `@xyz-agent/renderer` 加回 mobile dependencies 会红，护栏有效）
3. `pnpm run dev` 启动正常（workspace 解析无 missing dep）
4. 全仓 `rg "@xyz-agent/frontend"` 零命中（除 git 历史）

**下一层拆分**

- [ ] T5-1 DP-6 裁决确认
- [ ] T5-2 改 package.json + lock 更新 + 全仓 grep 清理引用
- [ ] T5-3 AC1 护栏测试同步 + 全量测试绿 + dev 冒烟

### B6 · composer-shell 越层直连 dom-core 裁决

**级别**：Speculative（低风险清理 / 文档对齐）｜**波次**：W5｜**前置**：DP-5 裁决

**问题**

`packages/renderer/src/composables/panel/composer-shell.ts:39-44` 存在 renderer 全仓唯一一处越过 ui 直连 dom-core 的 import（⚠️ 核查修正：1 处多行 import，非原「2 处」）：

```ts
// input 域 3 个 composable 已迁 @xyz-agent/dom-core（ADR-0058）：history/dragdrop/restore
import { ... } from '@xyz-agent/dom-core/composer/input'
```

五包图画的是线性链（renderer 只经 ui 消费），实测是 DAG（renderer 直连 core 96 文件、直连 shared 237 文件），dom-core 直连是其中一条实测边——文档未体现。

**方案对比**

- **方案 (a)：强制链式**（**短期方案**）：composer-shell 改为经 ui 转发 dom-core（ui 加一层 re-export seam）。取舍：消除越层边，但为形式约束加一层**纯转发 seam**——正是 B1 在 core 侧刚清除的那类层；且 renderer 直连 core 已有 96 文件先例，dom-core 直连不是孤立违规而是 DAG 形态的一部分，单独封堵一条边没有架构意义。
- **方案 (b)：文档注记**（**长期方案**，主文档 DP-5 推荐）：五包图加注记「renderer 对底层为 DAG 直连（core 96 文件 / shared 237 文件 / dom-core 1 文件）」，把图改画成事实。取舍：零代码改动；文档与事实一致后，未来审查不会再把已裁决的边当违规上报。代价是五包图失去「纯链」的简化美感——但审查已证明简化是失真。

**推荐**：方案 (b)（DP-5 裁决确认后执行）。与 B1 的教训同构：假 seam 比直连更糟——直连是真依赖，转发层是假抽象。

**改动点**

1. `docs/architecture/renderer-target-architecture.md`（或审查 README 的五包图）补注记：renderer 对底层为 DAG 直连，dom-core/composer/input 为已裁决的合法直连边（DP-5）
2. composer-shell.ts 的 import 处补一行注释「DP-5 裁决：DAG 直连合法，禁止经 ui 转发」防回潮（文档裁决落地为代码注释，是「无守护 → 回潮」的轻量守护）

**风险**：零（纯文档 + 注释）。

**验收**（真实场景）

1. 文档五包图含 DAG 注记，且 composer-shell.ts import 处有 DP-5 注释
2. 后续 review 会话中，该直连不再被报为「越层违规」（裁决记录可追溯）
3. `pnpm run dev` 下 composer 输入区（历史/拖拽/恢复）功能正常——无行为变化验证

**下一层拆分**

- [ ] T6-1 DP-5 裁决确认
- [ ] T6-2 五包图注记 + composer-shell.ts 注释（一行）
- [ ] T6-3 dev 冒烟（composer 输入区功能）

### B7 · mobile sync 文档 gap 清理

**级别**：Speculative（低风险清理 / 文档对齐）｜**波次**：W5

**问题**

⚠️ 核查修正口径：git 跟踪源码内 **COPY_MAP 零命中**（仅 `.cw` 临时产物 2 处设计记录提及，原「全仓」措辞过宽）；`sync-mobile-from-renderer.sh` 脚本**不存在**（scripts/ 与 packages/ 下均无）；但两处文档描述了该机制：

1. `docs/architecture/renderer-target-architecture.md:199`（§2.3 内「sync 兼容纪律」段）：声称「被 `sync-mobile-from-renderer.sh` COPY_MAP 覆盖的文件…v6 重构改路径时必须同步更新 sync 脚本」
2. `docs/todo/remote-use-merge-architecture.md:88,137`（§5「sync 兼容纪律」）：声称「已内化进 sync 脚本 + B9 checklist」——脚本不存在，描述的是未实现机制

另外 `packages/mobile-renderer/package.json` dependencies 声明 `"@xyz-agent/shared": "workspace:*"`，但 `src/` 零消费（唯一命中是 `__tests__/ac1-dependency-edge.test.ts` 的 ALLOWED_XYZ_DEPS 白名单字符串——那是护栏测试的允许边声明，不是消费）。

**方案对比**

- **方案 A：删不存在的纪律描述 + 清未用依赖**（**长期方案**，推荐）：renderer-target-architecture §2.3 的 sync 兼容纪律段删除（或改写为「mobile 同步机制未实现，若未来实施需重估」一句）；remote-use-merge-architecture.md 是「合并 remote-use 后删除」的临时文档（AGENTS.md 已规定），其 §5 随文档生命周期处理即可；mobile-renderer package.json 移除 `@xyz-agent/shared` + AC1 白名单同步移除。取舍：文档与代码事实对齐，未来实施 sync 时从零设计（不会被过期纪律误导）；护栏测试白名单收窄后仍覆盖 core/dom-core/ui 三条允许边，护栏强度不减。
- **方案 B：实现 sync 脚本**（**短期方案**，超范围）：按文档描述把 COPY_MAP 机制实现出来。取舍：mobile-renderer 现仅 0.5k 行壳（App.vue/bootstrap/platform/shell），尚无 renderer 同步需求；为一个不存在需求实现脚本是推测性功能（违反「不加推测性功能」），且 sync 方向（renderer → mobile）的正确性本身需重估（远程化合并后 mobile 是否还走文件复制路线未定）。
- **方案 C：维持现状**：文档描述未实现机制、mobile 挂着未消费依赖。取舍：零成本，但文档继续误导读者（§2.3 声称的纪律约束着不存在的脚本），依赖声明面继续撒谎（与 B2 同类问题）。

**推荐**：方案 A。

**改动点**

1. `docs/architecture/renderer-target-architecture.md` §2.3：删除 sync 兼容纪律段（含 COPY_MAP/MANUAL_FORK 表述），如 §2.3 其余内容仍有效则保留节内其他段落
2. `docs/todo/remote-use-merge-architecture.md` §5：该文档本身待删（合并 remote-use 后），本次仅确认不依赖其中的 sync 描述；如该文档近期不会删除，则同步删 §5
3. `packages/mobile-renderer/package.json`：dependencies 移除 `@xyz-agent/shared`
4. `packages/mobile-renderer/src/__tests__/ac1-dependency-edge.test.ts`：ALLOWED_XYZ_DEPS 移除 `'@xyz-agent/shared'`（保留 core/dom-core/ui），注释同步
5. 根 `pnpm install --lockfile-only` 更新 lock

**风险**：极低。shared 在 mobile 侧零消费，移除依赖不产生运行时变化；护栏测试收窄一条允许边，仍断言「@xyz-agent/* 依赖 ∈ 白名单」，防护语义不变。

**验收**（真实场景）

1. mobile-renderer 的 AC1 护栏测试绿（移除 shared 后白名单断言通过）；故意把 shared 加回 dependencies 会红（护栏仍有效）
2. `pnpm install` 后 mobile-renderer 的 dev/build 正常（`pnpm --filter @xyz-agent/mobile-renderer build` 通过）
3. `rg -n "sync-mobile-from-renderer|COPY_MAP" docs/ packages/` 仅剩历史 git 记录与 .cw 临时产物，git 跟踪文档零命中
4. renderer-target-architecture §2.3 可读性确认（删除段落后上下文连贯）

**下一层拆分**

- [ ] T7-1 删 renderer-target-architecture §2.3 sync 纪律段
- [ ] T7-2 remote-use-merge-architecture §5 处理（随文档生命周期；近期不删则同步删段）
- [ ] T7-3 mobile package.json 移除 shared + AC1 白名单同步 + lock 更新
- [ ] T7-4 护栏测试 + mobile build 验证

## §4 验收

### 层内整体验收（W0 与各波次完成后）

1. **W0 完成后**（B1+B2）：`pnpm run dev` 启动，完成一次完整对话（新建 session → 发消息 → 收回复 → 折叠/展开侧栏 → 切 session → 重开 session 验证历史），确认无回归；renderer `npx vue-tsc --noEmit` + 全量 vitest 绿
2. **W3 后**（B3）：除 W0 冒烟外，跑 `bash scripts/validate-runtime-bundle.sh`（core 新增第三方依赖的打包链路验证）
3. **W5 后**（B4/B5/B6/B7）：全仓 `rg` 确认文档与代码事实一致（shim 路径零残留、frontend 旧包名零残留、COPY_MAP 零命中），全量 typecheck + lint + 测试绿
4. 每个波次结束按 README 全局验收跑一次全量检查（extensions:typecheck / extensions:lint / renderer/runtime vitest / lint）

### 每候选验收汇总

| 候选 | 真实场景验收 | 强制项 |
|------|-------------|--------|
| B1 | dev 完整对话 + session 删除清理冒烟 | `rg` 5 shim 路径零残留 + typecheck |
| B2 | dev 下 chat store 正常 | core/renderer 测试绿 + tsc 通过 |
| B3 | 代码块/mermaid/diff 渲染与迁移前一致 + 主题切换重渲染 | core+renderer 测试绿 + lint + validate-runtime-bundle |
| B4 | 子路径 import 在 renderer/runtime 可用 + 主入口零破坏 | exports 清单与域文件对应 |
| B5 | dev 启动正常 + 护栏测试绿 | `rg @xyz-agent/frontend` 零命中 |
| B6 | composer 输入区功能无变化 | 五包图注记 + import 处 DP-5 注释存在 |
| B7 | mobile build 通过 + 护栏测试绿 | git 跟踪文档 `rg COPY_MAP|sync-mobile` 零命中 |

## §5 下一层拆分（实施顺序、依赖、commit 建议）

### 依赖图

```
B1/B2（W0，无依赖，可同批）→ B3（W3，依赖 DP-1 裁决 + C4 已删 summarizeTurn）
                                  B4（W4，依赖 F3/DP-3 的 quota 域裁决——只影响重步，轻量步独立）
                                  B5（W5，依赖 DP-6 裁决）
                                  B6（W5，依赖 DP-5 裁决）
                                  B7（W5，无依赖）
```

### 实施顺序与 commit 建议

1. **W0（B1+B2 同批）**：每个 shim 删除一个 commit（5 个 shim 可合并为 2-3 个 commit：ws-client 单独、utils+file-basename 批量、useSessionScopedState+useMessageBusSubscription 一组），B2 单独一个 commit。删除类改动零行为变化，验证 = typecheck + dev 冒烟
2. **W3（B3）**：按 T3-2→T3-5 分批，每批一个 commit（小文件批 / markdown / diff / mermaid），依赖声明变更单独 commit 并逐个跑 validate-runtime-bundle（AGENTS.md §12：打包相关改动逐个 commit 逐个验证）
3. **W4（B4）**：轻量步 exports 是 additive 变更，一个 commit；重步与 F3 联动，等 DP-3
4. **W5（B5/B6/B7）**：三者独立互不依赖，各自一个 commit（B5 改名 commit 前先 grep 全量引用点清单；B6/B7 纯文档+注释+依赖清理）
5. **全程纪律**：每个 commit 前跑对应包 typecheck + 测试；涉及 shared/core/mobile 的 package.json 改动 commit 前跑 `pnpm install --lockfile-only` 确认 lock 一致；pre-commit hook 检出问题全部正面修复（AGENTS.md 强制）
6. **收尾**：本目录 README 与各子文档标注实施状态；renderer-target-architecture §2.2/§2.3 按 B3/B7 结果更新（文档债随行，W1 起）
