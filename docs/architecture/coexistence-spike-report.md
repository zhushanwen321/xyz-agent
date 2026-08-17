# P0 共存接缝 spike 对比报告与推荐

> 决策文档 | 归属：renderer-rebuild-v2（renderer 重做架构，与 [renderer-rebuild-architecture.md](renderer-rebuild-architecture.md) §11 同层）
> 数据快照：flag-mech-spike commit `b5ae983a6` / dual-entry-spike commit `c4707c6b6`（manifest 均直接读自 `docs/architecture/coexistence-spike-manifests/` 当前内容）
> 本报告回答 P0 验收门第③项「新旧共存接缝机制 spike 验证通过」之后的接缝选型问题：**P3 逐域绞杀用哪个接缝机制**（架构文档 §11.2「接缝机制的具体形态在 P0 spike 中验证后定」）。

---

## 1 执行摘要与推荐

**推荐方案 A（构建 flag 机制）**作为 P0/P3 的新旧共存接缝。

**一句话主理由**：方案 A 与 §11.2 逐域绞杀主线契合度最高——架构文档 §11.2 明确「新壳是独立 vite 入口/Electron 窗口或构建产物切换，**按域灰度**」，域级灰度是 P3 主线的结构性需求而非可选优化；方案 A 的构建 flag 是同一机制的域级延伸（每域入口 composable 按 flag 分支即可，零额外抽象），方案 B 要实现域级灰度必须在双入口之上再加运行时路由层，违背 spike 边界「接缝机制在构建期成立」（clarify Q1 已锁定此锚点）。

**第二/第三支撑理由**（论证主次：主线契合度为第一，以下降权为支撑）：

1. **CI 单次构建**：方案 A 是构建期 define（`__APP_VERSION__` 同构模式），一次 build 按环境变量二选一入口，CI 无额外构建成本；方案 B 构建次数翻倍（两套 vite config × 两套 main/renderer 入口），若要同安装包并存还需串行 + 产物合并 + main 入口切换脚本。
2. **扰动面小且是现有模式同构延伸**：方案 A 改动 = 2 改现有（vite.config.ts + window-factory.ts）+ 7 新增（含 2 份 manifest 快照与 verify 脚本），与现有 `__APP_VERSION__` define 机制同构；方案 B 现有文件零改（纯新增），但生产化需要 electron-builder files 加行 + package.json main 字段单入口结构性限制的构建管线级切换（见 §2 矩阵与 builder-assessment）。

### 已定决策索引（3 条 clarify resolution）

| 决策 | 结论 | 详见 |
|------|------|------|
| 推荐锚点 | 锚定「与 §11.2 逐域绞杀主线契合度」（非「扰动面最小」） | §4 切换粒度对比 |
| 方案 B 处置 | 否决作 P0/P3 接缝，但保留复活条件（spike 代码 + manifest 保留作复现基线） | §6.1 方案 B 复活条件 |
| 域级灰度深度 | 概念描述 + 最小伪代码示意（非真实域实现，不进 src/） | §4 两段伪代码 |

---

## 2 扰动面对比矩阵（DM2 扰动面矩阵）

8 个扰动面 × 3 方案，格式：[改动文件数] [改现有/纯新增] [复杂度] — 说明。数据来源：方案 A ← flag-mech-spike commit `b5ae983a6`（git stat 实测）；方案 B ← dual-entry-spike commit `c4707c6b6`（git stat 实测）+ [dual-entry-builder-assessment.md](coexistence-spike-manifests/dual-entry-builder-assessment.md)；baseline ← 现状（apps/electron/electron-builder.yml + 现有 vite configs）。

| 扰动面 | 方案 A（构建 flag） | 方案 B（双入口） | baseline（现状） |
|--------|--------------------|------------------|------------------|
| vite 入口配置 | 1 文件 改现有 低 — vite.config.ts 加 `NEW_ARCH` define + 二选一入口（15++），现有入口链不动 | 2 文件 纯新增 低 — vite.config.main-new.ts + vite.config.spike-dual-entry.ts（各 20-32 行），现有 vite.config.ts 零改 | 现状：单 vite.config.ts，单一入口链 / 0 改动 |
| electron main 入口 | 2 文件 改现有 低 — window-factory.ts 改 + resolve-renderer-entry.ts 新增（17 行，按 flag 选 html 入口），main 入口文件本体零改 | 1 文件 纯新增 低 — main-new.ts（18 行独立骨架），现有 main 入口零改，但双入口并存需 package.json main 字段切换（结构性限制，见 electron-builder files 行） | 现状：单 main.cjs 入口 / 0 改动 |
| preload | 0 文件 零改 — flag 是构建期入口选择，preload 桥不受影响 | 0 文件 零改 — 双入口都不触 preload，桥接层原样复用 | 现状：单 preload.cjs / 0 改动 |
| 构建产物目录 | 1 文件 纯新增 中 — renderer 产物按 flag 落在 dist 或 dist-new/new-arch/（manifest 实测 rendererEntryHtml 切换），main 产物仍在 dist/main | 2 文件 纯新增 中 — main 产物落 dist/main-new/（与 dist/main 物理隔离，路径不交叉），renderer 落 dist/spike-dual-entry/（在 renderer/dist/** 通配内） | 现状：dist/main + renderer/dist / 0 改动 |
| electron-builder files | 0 文件 零改 — 构建期二选一，产物只含选中态，asar/files 规则原样覆盖 | 1 行追加 改现有 中低 — 需 files 加 `dist/main-new/**/*`（builder-assessment §1，asarUnpack 零改）；核心约束是 package.json main 单入口，真正并存运行需构建管线级切换（builder-assessment §3） | 现状：files 含 dist/main/** 等 4 组 + asarUnpack 2 组 / 0 改动 |
| CI 构建次数 | 1 次 — flag 是构建期 define，一次 build 按环境变量二选一入口，CI matrix 可选非必须 | 4 次 — 两套 vite config × 两套 main/renderer 入口；同安装包并存需串行 + 产物合并 + main 入口切换脚本，耗时与复杂度双增 | 现状：1 次 / 0 改动 |
| 切换粒度（整体 vs 域级） | 整体已实证 + 域级同机制延伸 — flag 下沉到模块/composable 级即域级灰度（§4 伪代码 A），无额外抽象 | 整体已实证 + 域级需额外抽象 — 双入口是进程/产物级整体隔离，域级需在 main 进程内加运行时路由层 + 域注册表（§4 伪代码 B） | 现状：无切换 / 0 改动 |
| 域级灰度原生支持 | 原生支持 — `globalThis.__NEW_ARCH__` 可下沉到每个域的入口 composable，逐域从 false 翻 true（§11.2「回退单元是域」直接对应） | 不支持原生 — 需构建双入口之上加运行时路由层，违背 spike 边界「接缝在构建期成立」 | 现状：无 / 0 改动 |

**关键差异行标注**：

- **preload 行**：两方案均「零改」——flag 与双入口都在入口选择层生效，preload 桥接层完全不受影响，此维度两方案打平。
- **electron-builder files 行**：方案 A「零改（构建期二选一，产物只含选中态，asar 内永远只有一份入口）」vs 方案 B「需加 `dist/main-new/**/*` 一行 + main 入口切换脚本（package.json main 字段单入口结构性限制，builder-assessment §3 推荐构建期改写 main 字段 + fileName 差异化命名规避同名覆盖）」。
- **切换粒度行**：这是两方案结构性分水岭——A 的域级灰度成本 = 0 额外抽象（flag 已在），B 的域级灰度成本 = 1 运行时路由层 + 域注册表。

**量化小结**（git stat 实测）：

- 方案 A 改动 = 2 改现有（vite.config.ts + window-factory.ts）+ 7 新增（resolve-renderer-entry.ts / resolve-renderer-entry.test.ts / new-arch/index.html / new-arch/new-arch.ts / verify-coexistence-flag.mjs / flag-on.json / flag-off.json），commit 共 9 文件。
- 方案 B 改动 = 1 改现有（package.json 加 build script）+ 9 新增（main-new.ts / vite.config.main-new.ts / vite.config.spike-dual-entry.ts / spike-dual-entry/index.html / spike-dual-entry/main.ts / verify-dual-entry.mjs / dual-entry-builder-assessment.md / baseline.json / dualEntry.json），commit 共 10 文件。

---

## 3 实证结果

三个子节分别对应构建通过性、产物切换证明、扰动面量化。所有数据均直接读自 `docs/architecture/coexistence-spike-manifests/` 四份快照与两份 spike 的 verify 脚本/retrospect 结论。

### 3a 构建通过性

| 方案 | 构建次数 | 结果 | 验证方式 |
|------|---------|------|---------|
| 方案 A | 2 次（NEW_ARCH=1 与未设各一次 vite build） | 全部 exit 0 | `scripts/verify-coexistence-flag.mjs` 4 断言 + 6 单测全绿（flag-mech-spike retrospect 确认） |
| 方案 B | 4 次（build:main / renderer baseline / build:main-new / spike-dual-entry） | 全部 exit 0 | `scripts/verify-dual-entry.mjs` ALL PASS（dual-entry-spike retrospect 确认） |

两方案的构建期接缝机制均实证成立——这是 spike 目标本身（接缝在构建期成立），两者在「机制成立」维度打平，差异在域级灰度的结构性成本（§4）。

### 3b 产物切换证明（四份 manifest 快照）

**方案 A 的 flag 切换产出不同入口**（flag-on.json vs flag-off.json）：

- [flag-on.json](coexistence-spike-manifests/flag-on.json)：`newArchEnv: "1"` → `rendererEntryHtml: apps/electron/renderer/dist-new/new-arch/index.html`，`bakedFlagValue: true`——flag 已烘焙进产物（构建期 define 生效），renderer 入口指向新壳。
- [flag-off.json](coexistence-spike-manifests/flag-off.json)：`newArchEnv: "unset"` → `rendererEntryHtml: apps/electron/renderer/dist/index.html`，`bakedFlagValue: false`——未设 flag 时入口与现状完全一致（ES1 安全默认：未设 flag = 现状，主线构建行为零变化）。

**方案 B 的物理隔离（路径完全不交叉）**（baseline.json vs dualEntry.json）：

- [baseline.json](coexistence-spike-manifests/baseline.json)：`mainEntry: apps/electron/dist/main/main.cjs`，`bundleChunks` 共 411 个（主线完整产物清单）。
- [dualEntry.json](coexistence-spike-manifests/dualEntry.json)：`mainEntry: apps/electron/dist/main-new/main.cjs`，`bundleChunks` 仅 3 个（main-new/main.cjs + spike-dual-entry/index-CFtPdPa8.js），`fileCount: 3`——spike 产物与主线 411 chunk 完全解耦，`dist/main` 与 `dist/main-new` 两目录物理隔离，构建期互不污染（ES2 同名覆盖风险已规避：不同目录 + fileName 差异化命名）。

### 3c 扰动面量化

- **方案 A**：新壳骨架构建仅证明 loadFile 切换（new-arch 占位页，14 行 html + 7 行 ts），主线构建行为零变化（flag-off.json 实证未设 flag = 现状）；扰动面是现有 `__APP_VERSION__` define 模式的同构延伸。
- **方案 B**：spike-dual-entry 构建仅 4 modules / 1.36kB / 101ms（dual-entry retrospect T1），与主线 5512 modules 完全解耦——spike 边界内两方案都不污染主线。

**诚实边界**：以上均为构建期物证 + 静态评估，不含运行时验证（clarify Q1 锁定 spike 边界：运行时全链路验证留给 P3 各域切换周期，§11.2「回退单元是域」）。「推荐方案 A」是构建期可行性 + 主线契合度论证，非运行时已验证结论。

---

## 4 切换粒度对比

对应 §11.2 逐域绞杀主线：「新壳是独立 vite 入口/Electron 窗口或构建产物切换，按域灰度……回退单元是域」。

### 概念对比

- **方案 A**：已实证整体 flag 切换（§3b）；域级灰度是同一机制的延伸——`globalThis.__NEW_ARCH__` 可下沉到模块/composable 级，每个域迁移完成后在其入口 composable 加分支，逐域从 false 翻 true。
- **方案 B**：已实证整体入口隔离（§3b）；域级灰度需在双入口之上加运行时路由层——双入口是进程/产物级机制，域级分支发生在入口之下，需要额外的「域 → 入口」注册表抽象。

### 方案 A 域级灰度伪代码（示意，非真实域实现）

```ts
// renderer 某 composable 内，flag 下沉到模块级 import
// 同一 flag 机制，域级只需在每个域的入口 composable 分支，无额外抽象
import { legacyUseChat } from '@/legacy/useChat'
import { newShellUseChat } from '@/new-shell/useChat'

const useChatStore = globalThis.__NEW_ARCH__
  ? () => newShellUseChat()   // 新壳 chat 域
  : () => legacyUseChat()     // 旧 renderer chat 域
```

标注：flag 是构建期烘焙的全局常量（§3b bakedFlagValue 实证），运行时分支是纯函数选择器——域级灰度成本 = 0 额外抽象。

### 方案 B 域级灰度伪代码（示意，非真实域实现）

```ts
// main 进程启动时按域注册表 require 对应入口
const domainEntries = loadDomainRegistry()   // 额外抽象：域 → 入口映射
for (const domain of activeDomains) {
  const mod = domain.useNewArch
    ? require(`./main-new/${domain}`)        // 新壳子模块
    : require(`./main-legacy/${domain}`)     // 旧壳子模块
  registerDomain(mod)                        // 运行时路由层
}
```

标注：双入口是进程/产物级隔离，域级需 main 进程内路由层 + 域注册表——违背 clarify Q1「接缝在构建期成立」的 spike 边界（构建期机制在入口选择层，域级路由是运行期机制）。

### 小结（推荐 A 的主论证落点）

| 维度 | 方案 A | 方案 B |
|------|--------|--------|
| 域级灰度成本 | **0 额外抽象**（flag 已在，下沉到模块级即得） | 1 运行时路由层 + 域注册表 |
| 与 §11.2「按域灰度」期望的贴合 | 直接对应（逐域翻 flag，回退单元是域） | 结构性错位（整体入口隔离，域级需补运行期机制） |
| 接缝成立层 | 构建期（spike 边界内） | 构建期入口隔离成立，但域级灰度需运行期机制（越界） |

---

## 5 CI 影响

- **方案 A**：单次构建。flag 是构建期 define，一次 build 按环境变量二选一入口（§3a 实证 2 次构建均 exit 0），CI 流程无需新增 job，CI matrix 可选（同时构建 on/off 两种产物做回归对比）但非必须。
- **方案 B**：构建次数翻倍。两套 vite config × 两套 main/renderer 入口 = 4 次 build（§3a 实证）；若要在同一安装包并存两套入口，还需串行构建 + 产物合并 + main 入口切换脚本（builder-assessment §3：package.json main 单入口结构性限制），CI 耗时与复杂度双增。若接受「两个安装包各自只含一套入口」（不做并存），则 CI 变成两条独立管线（双倍 job + 双倍维护），也不优于 A。

**结论**：CI 维度方案 A 显著占优，但这是第二/第三支撑理由——主论证仍是 §4 的域级灰度契合度（clarify Q1 锚点）。

---

## 6 对 P3 逐域绞杀的衔接建议

**推荐方案 A 作为 P3 接缝机制**。具体衔接：

1. **接缝落地形态**：沿用 flag-mech-spike 已验证的机制（vite define `NEW_ARCH` → `globalThis.__NEW_ARCH__` → resolve-renderer-entry.ts 按 flag 选 html 入口），P3 启动时把 spike 的 4 个文件（resolve-renderer-entry.ts / new-arch 占位 / vite.config.ts 改动 / verify 脚本）正式收编进主线，spike 验证脚本职责并入 preflight-check.sh 或保留为独立 verify。
2. **逐域迁移节奏**（对应 §11.2 顺序 chat → composer → session/sidebar → settings → new-task/search → drawer）：每个域在新壳实现后，于该域入口 composable 加 `globalThis.__NEW_ARCH__` 分支（§4 伪代码 A 模式），该域从 false 翻 true，验收通过后删除旧域代码。回退单元是域（§11.2）——任何域切换后发现回归，只回退该域 flag，不影响已切换的其他域。
3. **每域验收门**：沿用 §11.3 渲染 gate（每域至少一条首屏冒烟）+ 域级行为测试随迁移改写；flag 翻转用 verify-coexistence-flag.mjs 扩展的逐域断言验证。
4. **P4 ExtensionHost 解耦**：P3 各域入口以「壳内硬编码占位」形态接入（§11.2），不走 contribution 路由；本报告的 flag 机制只负责新旧域切换，不承担挂载点职责。

### 6.1 方案 B 复活条件

**当前不推荐方案 B 作为 P0/P3 接缝**（clarify Q2 锁定「否决但留复活条件」，与父 slice「非推荐方案实证代码保留作对比可复现」一致）。若未来出现「新旧壳需进程级隔离」场景，B 的双入口机制可复活：

| 触发场景 | 说明 |
|---------|------|
| 依赖不同 Electron/Node 主版本 | 新旧壳各自需要不同运行环境，同进程内无法共存 |
| 需热切换不重启 | 进程级隔离下切换入口无需重启主进程 |
| 安全边界要求分进程沙箱 | 新旧壳分进程运行，崩溃/权限隔离 |

**复活基线** = spike 代码（`vite.config.main-new.ts` / `main-new.ts` / `spike-dual-entry/`）+ [dualEntry.json](coexistence-spike-manifests/dualEntry.json) / [baseline.json](coexistence-spike-manifests/baseline.json) manifest，保留作复现起点。生产化改动面已评估清楚（builder-assessment：files 加 1 行 + main 入口切换脚本 + preflight/postbuild 各加 1 条断言），复活时可直接按该评估实施，无需重新 spike。

**诚实标注推荐的不替代场景**：方案 A 是同进程内 import 分支，物理上仍是单 Electron 进程——若未来需要新旧壳真正的进程级隔离（A 无法覆盖），方案 B 有不可替代价值。本报告推荐 A 仅覆盖「P0/P3 逐域绞杀」的接缝需求，不否决 B 在进程级隔离场景的未来适用性。
