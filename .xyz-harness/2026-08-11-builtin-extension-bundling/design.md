---
verdict: revised-after-review
review: 对抗式审查（tech-design-review agent + 2 独立核查员）后修订。审查 must-fix M1-M5 经主 agent 实证复核，S3/S6 推翻，S4 删除。修订要点见文末「修订记录」。
---

# builtin pi extension 打包根治方案（prepare-builtin-extensions 长期重构）

> **一句话结论**：builtin extension 打包应从"拷源码 + 人工声明 deps + 从根 node_modules 拷贝"改为"esbuild bundle 成自包含产物 + 仅 wasm/pi-runtime external"，从结构上消除 workspace 包 resolve 不可达与人工维护漂移两个根因，并用 fail-fast 校验门守住 dev/prod 两条路径。

**当前层 → 下一层**：技术方案设计（architecture）→ 实现任务拆分（含 esbuild 配置、脚本重写、校验门）。本次设计到"可实现的接口/工具链选型"层，不跨到具体测试用例。

## 相关设计（先厘清边界，避免重复）

| 设计 | 主题 | 与本文关系 |
|---|---|---|
| `2026-05-27-bundle-pi-extensions` | xyz-pi@0.75.5 fork 时代，复制源码 + pi **jiti 编译** + pi **virtualModules/alias** 提供外部依赖 | **历史背景**。旧方案依赖 pi 运行时 resolve（jiti + virtualModules），本文的 bug 正是该模式的脆弱性暴露——workspace 包不在 pi virtualModules 范围，运行时 resolve 不可达。本文从结构上摆脱运行时 resolve |
| `2026-08-10-extension-version-dedup` | dev 显示版本陈旧 + npm 安装重复（去重 key 不一致） | **互补不重叠**。那份解决"prepare 跑不跑 + 去重 key"；本文解决"prepare 产出的依赖正确性"。两份都 touch `prepare-builtin-extensions.sh`，但问题域不同 |

---

## 开篇（SCQA）

- **S（Situation）**：xyz-agent 的 9 个 builtin pi extension（`@zhushanwen/pi-*`）需在 dev 和 packaged 两种模式下被 pi 进程加载，由 `prepare-builtin-extensions.sh` 预先部署到 `apps/electron/resources/extensions/@zhushanwen/<pkg>/`，prod 再经 electron-builder extraResources 拷进 `Resources/extensions/`。
- **C（Complication）**：该脚本建立在两个未经运行时验证的假设上——① workspace 包会被 pnpm hoist 到根 `node_modules`；② workspace 互引都是 type-only peerDep。两者均被实证推翻，导致每次 `pnpm dev`/`pnpm build` 产出的 staged 目录**源码齐全但依赖全缺**，pi 加载 extension 时报 `Cannot find module`，新会话创建失败。
- **Q（Question）**：如何让 builtin extension 打包从结构上不再依赖"人工维护依赖清单 + workspace 包恰好 hoist 到根"这两个脆弱前提，且 dev/prod 同源可靠？
- **A（Answer）**：改用 esbuild 在构建期把每个 extension 的 `index.ts` 连同所有可 bundle 的 value 依赖打成自包含产物，wasm 数据文件走 asset 拷贝、pi runtime 通过 virtualModules 提供的包设为 external；配 fail-fast 校验门验证 staged 产物完整性，dev 与 build 两条路径都跑。

---

## 1. 背景目标

### 1.1 系统是什么（补背景）

**builtin pi extension**：随 app 内置、不走 npm 安装的 pi 扩展，清单 SSOT 为 `packages/shared/src/mandatory-extensions.json`（9 个：ask-user / goal / todo / pending-notifications / subagent-workflow / structured-output / permission / scheduler / rename-session）。pi 进程通过 module resolve 机制从 extension 目录加载入口文件。

**pi 加载 extension 的机制**（✅已实测，二轮审查复核）：
- pi 是 0.80.3 **bun 编译的 Mach-O binary**（`apps/electron/resources/pi/pi-darwin-arm64`，`file` 确认；node_modules devDep 是 0.82.1 提供开发期类型，版本不同是项目已知状态）
- pi 用 **jiti** 加载 extension（`loader.js`：`jiti.import(extensionPath)`），bun 模式下 `tryNative: false`（jiti 接管所有 import）。jiti 是 transpile-only，**pi 从不对 extension 做 type-check**（type-check 由 `pnpm extensions:typecheck` 的 tsc 保证）
- jiti resolve 顺序支持 `.js`（pi 自带 `llama` extension 入口就是 `index.js`，`dist/extensions/llama/index.js`），**go/no-go 门基本解除**

**pi 的 virtualModules**（✅已实测 0.80.3 binary strings 提取）：pi 运行时注入以下模块，extension `import` 它们时由 pi 提供、无需 staged 自带：
- `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-tui`、`pi-ai`（+ `/compat`、`/oauth` 子路径）
- `@mariozechner/pi-coding-agent`、`pi-agent-core`、`pi-ai`、`pi-tui`（旧名别名）
- `typebox` / `@sinclair/typebox`（binary 内变量名 `exports_typebox`，strings 实证）

> external 边界的**权威源 = shipping binary（0.80.3），不是 node_modules 源码（0.82.1）**。本次已从 binary strings 实测确认上述清单两版本一致；但 pi 版本升级时须重测（纳入升级流程，见 §5.1 T1 持续校验）。

### 1.2 设计目标（从使用者体验倒推）

1. **G1｜开发者 `pnpm dev` 即可用**：landing 页发起会话成功，pi 加载全部 9 个 builtin extension 无 `Cannot find module`。
2. **G2｜packaged 用户首次发起会话即用**：prod 产物同样可用，且构建期就拦截残缺产物（不依赖用户报错）。
3. **G3｜新增**静态可分析** value 依赖不改打包脚本**：extension 新增 `import` 一个静态 JS/TS 包后，无需同步维护任何"依赖清单"，下次 build 自动正确产出。
   - **适用边界**（审查 M3 修订）：G3 适用于**静态 `import`/`require` 字面量的 JS/TS 依赖 + wasm/数据 asset**。不适用于：① 真 `.node` native addon（当前 9 个 builtin 均无，见 §3.3 决策 3）；② 动态 `require(variable)` / `import(expr)`（esbuild 静态分析跟不上，需开发者显式处理）。
4. **G4｜dev 与 prod 所见即所得**：两种模式 staged 产物结构一致，dev 验证通过即代表 prod 通过（兑现 `extension-resolver.ts` 注释承诺）。

### 1.3 In scope / Out of scope

- **In**：重写 `prepare-builtin-extensions.sh` 为 esbuild bundle 流程；新增 staged 完整性校验门；dev 与 build 两路径接入；9 个 builtin extension。
- **Out**：非 builtin extension（用户 npm 安装 / 第三方 / discovery 源）不动；pi loader 本身不改；extension 的功能逻辑不改。

---

## 2. 现状与问题分析

### 2.1 现状：打包流程物理数据流

```
pnpm dev / pnpm build
        │
        ▼
prepare-builtin-extensions.sh
        │  对每个 builtin 包：
        │   1. rsync 拷源码 → apps/electron/resources/extensions/@zhushanwen/pi-<pkg>/
        │   2. 按 PKG_DEPS[包] 人工声明的 deps，从 $REPO_ROOT/node_modules/<dep> 拷贝
        │      （第三方包）到 <dest>/node_modules/
        ▼
staged 产物（apps/electron/resources/extensions/@zhushanwen/）
        │
        ├─ dev：extension-resolver scanBundledExtensions 直接读此目录
        │
        └─ build：electron-builder extraResources 拷到 Resources/extensions/@zhushanwen/
                  （逐字节拷贝，prod 与 dev 同源）
        │
        ▼
pi 进程加载 extension（jiti resolve <ext-dir>/node_modules → 向上逐级）
```

### 2.2 真实失败模式（取自报错与实证）

发起会话时 pi 报：
```
Cannot find module '@xyz-agent/extension-protocol' from '.../pi-ask-user/src/index.ts'
Cannot find module '@zhushanwen/pi-pending-notifications' from '.../pi-goal/src/adapters/event-handlers/agent-end.ts'
Cannot find module '@zhushanwen/pi-extension-logger' from '.../pi-subagent-workflow/src/index.ts'
```

**staged 产物实测**（✅已测，重跑脚本后）：

| builtin 包 | `node_modules/` 条目 | 应有的 value 依赖 |
|---|---|---|
| pi-ask-user | **0** | `@xyz-agent/extension-protocol`（runtime: `PROTOCOL_VERSION`/`ASK_USER_MARKER`）|
| pi-goal | **0** | protocol + `@zhushanwen/pi-pending-notifications`（runtime: `countActiveFromEntries`）|
| pi-todo | **0** | protocol |
| pi-subagent-workflow | **0** | protocol + `@zhushanwen/pi-extension-logger`（runtime: `getLogger`）+ `@zhushanwen/pi-pending-notifications`（runtime: `countActiveFromEntries`，审查 M4 补）|
| pi-pending-notifications | 0 | 无 |
| pi-rename-session | 0 | 无 |
| pi-structured-output | 5 ✓ | ajv 等（第三方）|
| pi-permission | 4 ✓ | web-tree-sitter + tree-sitter-bash.wasm（WASM 路径，审查 M2 修订）|
| pi-scheduler | 1 ✓ | croner（第三方）|

规律：**第三方 deps 拷贝成功，workspace deps 全部失败**。

### 2.3 dev 与 prod 是否相同（必须明确，决定修复范围）

**同一个 bug 的两面，prod 必须一起修，且 prod 更危险。**

| 维度 | dev | prod (packaged) |
|---|---|---|
| staged 产物来源 | `prepare-builtin-extensions.sh` → `apps/electron/resources/extensions/` | **同一脚本同一目录**；electron-builder extraResources 拷到 `Resources/extensions/`（`electron-builder.yml:88`） |
| staged 内容 | 源码齐全 / 依赖全缺 | **逐字节相同**（extraResources 是整体拷贝） |
| pi 运行 cwd | `apps/electron` | `process.resourcesPath`（`process-control.ts:214`） |
| 上溯能找到 workspace 包吗 | 不能（根 node_modules 无 `@xyz-agent`/`@zhushanwen` scope） | 不能（`files` 未打包这两个 scope） |
| 启动/构建校验 | **无**（dev 直接用 staged） | postbuild 只查目录存在（`postbuild-validate.sh:224` `[ -d ... ]`），**不查依赖完整性** |
| 错误暴露时机 | 发起会话即报错 | **发布后用户首次发起会话才报错**，且用户无法自行修复 |

**结论：长期方案必须同时覆盖 dev 和 prod——两者共享同一个 staged 产物，修一处即修两处。**

### 2.4 根因分析（三层）

**根因 1｜脚本假设 workspace 包在根 node_modules（实证推翻）**

`copy_dep` 从 `$REPO_ROOT/node_modules/<dep>` 拷。但 pnpm hoisted 模式（`.modules.yaml` 实测 `nodeLinker: hoisted`）的行为是：**只有被根 `package.json` 直接依赖的包才进根 node_modules**；workspace 包之间的引用 link 在**消费者自己的 node_modules**。

实证（✅已测）：根 `node_modules/@xyz-agent/`、`@zhushanwen/` 两个 scope 目录不存在；`extensions/goal/node_modules/` 下才有；重跑脚本 4 个包全输出 `WARN: not found, skipping`。

**根因 2｜脚本假设 workspace 互引是 type-only peerDep（实证推翻）**

脚本头部注释原话：*"workspace 互引是纯契约 peerDep，无运行时 import，不拷贝"*。实证（✅已测，审查 M4 补全）有 **3 处 value import**：
- `goal/src/adapters/event-handlers/agent-end.ts:22` → `@zhushanwen/pi-pending-notifications` 的 `countActiveFromEntries`
- `subagent-workflow/src/execution/session-pending.ts:18` → 同上 `countActiveFromEntries`（**审查补，文档初版漏**）
- `subagent-workflow/src/interface/subagent-tool.ts:15` → `@zhushanwen/pi-extension-logger` 的 `getLogger`

且 `@xyz-agent/extension-protocol` 有 runtime value export（`PROTOCOL_VERSION`、`GUI_WIDGET_MARKER`、`ASK_USER_MARKER`）。

**根因 3｜人工维护的 `PKG_DEPS` 与 package.json 无机械同步**

`PKG_DEPS` 是 bash 关联数组，靠人维护。当前 `PKG_DEPS["goal"]` 只声明 protocol，**未声明 pi-pending-notifications**；`PKG_DEPS["subagent-workflow"]` 未声明 pi-extension-logger / pi-pending-notifications。

### 2.5 防护缺口（为什么一路漏到用户面前）

| 缺口 | 后果 |
|---|---|
| `copy_dep` 源缺失 → `return 0` + WARN，`set -euo pipefail` 不触发 | 脚本 exit 0 = "成功"，残缺无人知 |
| `PKG_DEPS` 人工维护 | 新增 value import 漏声明，无检查拦截 |
| `pnpm dev` 后无 staged 完整性校验 | dev 路径裸奔 |
| `postbuild-validate.sh:224` 只查目录存在 | prod 残缺产物"校验通过"成功发布 |
| 错误延迟到 pi 加载才暴露 | 报 `Cannot find module`，离根因隔 3 层 |

### 2.6 演化时间线

`ada6c0466` 引入脚本时，goal/subagent-workflow 对 workspace 包的消费碰巧全是 type-only，bun type erasure 使缺失不报错。之后新增 value import 未同步 `PKG_DEPS` 与注释假设。

---

## 3. 解决方案

### 3.1 终态（使用者视角先行）

**开发者视角（dev）**：
```
$ pnpm dev
[prepare-builtin-extensions] bundling 9 extensions with esbuild...
[prepare-builtin-extensions] ✓ pi-ask-user: 142kb (protocol inlined)
[prepare-builtin-extensions] ✓ pi-goal: 38kb (protocol + pi-pending-notifications inlined)
[prepare-builtin-extensions] ✓ pi-permission: 1.2mb (web-tree-sitter inlined + tree-sitter-bash.wasm as asset)
[verify-staged-extensions] ✓ all 9 extensions: dry-run require entry succeeded
[vite] ready.
# → landing 页发起会话，pi 加载全部 extension，无 Cannot find module
```

**失败路径（带恢复指引）**：
```
[verify-staged-extensions] ✗ pi-goal dry-run require failed: Cannot find module '@zhushanwen/pi-pending-notifications'
  hint: 检查 extensions/goal/src 是否新增了 value import 但 esbuild 把它误标 external
  hint: 运行 pnpm --filter @xyz-agent/electron run bundle-extensions --verbose 查看依赖图
[dev] ABORTED: staged extension verification failed
```

**打包维护者视角（G3）**：extension 新增 `import { x } from "some-pkg"` 后，**无需改任何打包配置**——下次 build esbuild 静态分析自动 inline（纯 JS）或报错指引（若 `some-pkg` 是 pi 不提供的 native/动态依赖）。

### 3.2 多方案对比（强制 ≥2）

#### 方案 A（推荐）｜esbuild bundle 成自包含产物

每个 builtin extension 的 `index.ts` 经 esbuild 处理。**external 边界权威源 = 0.80.3 binary virtualModules（§1.1 已实测）**，三类处理：

| 类别 | 处理方式 | 清单（实测） |
|---|---|---|
| **pi virtualModule** | external（pi 运行时提供） | `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-tui`、`pi-ai`(+子路径)、`@mariozechner/*` 别名、`typebox`/`@sinclair/typebox` |
| **纯 JS / workspace value dep** | inline bundle | `@xyz-agent/extension-protocol`、`@zhushanwen/pi-*` workspace 包、`web-tree-sitter`、ajv、croner 等 |
| **wasm / 数据 asset** | asset 拷贝到产物目录 | `tree-sitter-bash.wasm`、`web-tree-sitter.wasm` |
| **真 `.node` native addon** | （当前 9 包均无） | permission 走 WASM 路径不用 .node；若未来引入需单独设计 |
| ~~`node-addon-api`/`node-gyp-build`~~ | **从清单删除** | 审查 M2：编译期依赖，permission 运行时不 require |

产物结构：`<pkg>/index.js`（bundle）+ `<pkg>/package.json`（`pi.extensions` 改指 `./index.js`）+ `<pkg>/<asset>.wasm`（仅 permission）+ **无 node_modules**（自包含）。

| 维度 | 评价 |
|---|---|
| 长期架构合理性 | ✅ 消除 workspace resolve（value import 被 inline）；消除人工维护（esbuild 静态分析）；dev/prod 真正同源自包含产物；9 包全部可 bundle（无真 native） |
| 短期实现成本 | 中。esbuild 配置脚本 + external 边界（已实测）+ 9 包验证 + wasm asset 处理（permission 的 loader.ts 路径适配） |
| 风险 | ① 跨 ext value import inline 后的状态分裂（见决策 2，已论证安全）；② permission 的 wasm loader 路径适配（bundle 后 .wasm 定位）；③ bundle 后错误堆栈指向 .js 非 .ts（见决策 7，source map）|

#### 方案 B｜pnpm deploy 隔离安装

用 `pnpm deploy` 部署含完整 node_modules 的隔离目录。

| 维度 | 评价 |
|---|---|
| 长期架构合理性 | ⚠️ 装完整依赖树（含 peerDeps 传递闭包），体积膨胀；脚本注释已否决（*"--legacy 会装整个 monorepo 依赖树"*） |
| 风险 | 体积失控（permission 已 24M，deploy 更胖）；peerDeps 闭包引入 pi-runtime 版本冲突 |

#### 方案 C｜保留拷贝机制，修拷贝源 + 自动派生 deps + fail-fast

不引入 bundle，只修脚本：① `copy_dep` 多源查找（根 → 消费者 → .pnpm）**递归拷贝传递闭包**；② `PKG_DEPS` 从 package.json 自动派生；③ 源缺失 exit 1；④ 加 staged 校验门。

| 维度 | 评价 |
|---|---|
| 长期架构合理性 | ⚠️ 仍依赖运行时 resolve workspace 包。审查 M5：跨包 resolve 链（goal→pending-notifications→?）需**递归**拷贝传递闭包才不断链；native + workspace + 第三方三类拷贝源规则仍需维护 |
| G3 达成度 | 部分：自动派生 deps 解决人工清单，但拷贝源规则仍需维护 |
| 作为 go/no-go 回退 | 若 pi 不能加载 .js（决策 4），回退方案 C 后 G1/G2 **仅当拷贝递归处理传递闭包时**才达成；需显式实现递归拷贝机制 |

**推荐方案 A**。理由：经二轮审查 + 主 agent 实测，9 个 builtin 全部可 bundle（无真 native 阻塞），virtualModules external 边界已从 binary 实测确认。方案 A 是唯一从结构上消除两个根因并兑现 G3/G4 的方案。

### 3.3 关键决策与权衡

**决策 1｜bundle 产物形态：自包含 `index.js` + wasm asset，无 node_modules**
- 选择：`index.js`（所有 JS value dep inline）+ `.wasm` asset（仅 permission）+ 改写 manifest 指向 `.js`。**无 node_modules 目录**（彻底自包含）。
- 证据：permission 是唯一有非 JS 依赖的包，且走 WASM 路径（`ast/loader.ts` 实测），web-tree-sitter 纯 JS 可 inline，.wasm 是数据 asset

**决策 2｜跨 extension value import inline + 状态分裂论证（审查 M4 修订）**
- `countActiveFromEntries` 有 **3 处消费**（pending-notifications 自身 + goal + subagent-workflow），inline 后产生 3 份 copy。✅已读 `state.ts` 确认是**纯函数**（取 entries 参数、不读模块级状态）→ 3 份 copy 安全。
- `getLogger`（pi-extension-logger）有进程级单例（`globalPi` + `loggerCache`）。但审查 S6 推翻原担忧：pi 给每个 extension 创建**独立 ExtensionAPI**，inline 后 logger 各自路由到各自 pi 实例 → session 隔离**反而更好**（修复了原代码注释自认的"多 session 覆盖"隐患）。builtin 中仅 subagent-workflow 消费 logger，单一消费方。→ inline 对 logger **更正确**，非脆弱。
- 持续约束（记入 T2 核查清单）：若未来第二个 builtin 开始消费 logger，需重新评估。

**决策 3｜permission 的 tree-sitter 处理：WASM 路径，无真 native（审查 M2 修订）**
- `permission/src/ast/loader.ts` 实测用 **web-tree-sitter WASM API**（`Parser.init({locateFile})`、`Language.load(path)`），**不消费 tree-sitter-bash 的 prebuilds/*.node**。
- 处理：`web-tree-sitter`（纯 JS）inline bundle；`tree-sitter-bash.wasm` + `web-tree-sitter.wasm` 走 asset 拷贝；`node-addon-api`/`node-gyp-build` 从清单删除（编译期依赖）。
- ⛔实施期门：bundle 后 permission 的 `loader.ts` 定位 .wasm 的路径需适配（bundle 改变了模块位置）。实测验证 pi 能加载并解析 bash。

**决策 4｜pi 加载 `.js` extension（go/no-go 门，已基本解除）**
- ✅已实证：pi 用 jiti 加载（`loader.js` jiti.import），jiti resolve 顺序含 `.js`；pi 自带 `llama` extension 入口是 `index.js`（官方验证路径）。
- ⛔ T1 唯一剩余实测：用 0.80.3 **binary**（非 0.82.1 node_modules）实际加载一个最小 `.js` extension，确认 0.80.3 同样支持（llama 实证来自 0.82.1 源码，binary 版本需实测）。
- **回退路径（审查 M5 诚实化）**：若 0.80.3 binary 不能加载 .js，回退方案 C。回退后：G1/G2 **仅当方案 C 的多源拷贝递归处理传递闭包时**才达成（goal→pending→? 链不断）；G3 部分达成（自动派生 deps 解决清单，拷贝源规则仍维护）；G4 仍达成。即回退从"根治"降级为"可靠止血（需实现递归拷贝）"，且必须保留 verify-staged 校验门。

**决策 5｜fail-fast 校验门：dev 与 build 都跑，dry-run require（审查 M3 修订）**
- 新增 `scripts/verify-staged-extensions.mjs`：对每个 staged 包**实际 dry-run require entry**（jiti 或 node 跑一次 index.js 的 require 探针），而非只查 declared deps——这样才能覆盖动态 require（审查 M3：declared deps 查不到未声明的动态 require）。
- 接入 `apps/electron/package.json` 的 dev/build，prepare 之后。postbuild-validate.sh 增依赖完整性检查。

**决策 6｜删除 `PKG_DEPS` 人工清单**
- bundle 方案下依赖由 esbuild 静态分析决定，`PKG_DEPS` 删除。

**决策 7｜source map（审查 S2 新增）**
- esbuild 配 `sourcemap: true` + `keepNames: true`。⚠️已知限制：jiti 加载 `.js` 不消费 source map，pi 运行时错误堆栈仍指向 `.js` 行号（当前 `.ts` 走 jiti transform 堆栈指向源码，是真实倒退）。缓解：source map 供开发者用 devtools/source-map 工具离线还原。验收场景 6 验证可定位性。

**~~决策：失去 pi type-check~~**（审查 S4 删除）：jiti transpile-only，pi 从未 type-check extension。type-check 由 `pnpm extensions:typecheck`（tsc）保证，不受 bundle 影响。非风险。

---

## 4. 验收

> 验收用真实 pi 进程加载、真实 packaged 产物，不用 mock。每个场景回溯 §1 目标。

### 场景 1（G1 + G4）｜dev 发起会话成功
- **步骤**：`pnpm dev` → landing 页输入"帮我建个 todo"发起会话
- **通过标准**：verify-staged exit 0；会话创建成功无 `Cannot find module`；`/todo` 命令可用

### 场景 2（G2）｜packaged 首次发起会话成功
- **步骤**：`pnpm build` → 解压 DMG 到全新位置 + `rm -rf ~/.xyz-agent` → 启动发会话
- **通过标准**：postbuild verify-staged 对 `Resources/extensions/` exit 0；9 extension 全部加载（pi 日志无 `Failed to load extension`）

### 场景 3（G3）｜新增静态 value 依赖不改脚本
- **步骤**：`extensions/goal/src/` 临时加 `import Ajv from "ajv"; console.log(Ajv)` → `pnpm run prepare-builtin-extensions`（不改任何配置）→ 检查 staged `pi-goal/index.js`
- **通过标准**：bundle 产物含 ajv（`grep -c "ajv" > 0`）；回退临时改动

### 场景 4（G3 边界 + 审查 M3 补）｜新增跨 ext workspace value import
- **步骤**：模拟给 pi-todo 新增 `import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications"`（复刻本 bug 形态）→ bundle → verify-staged
- **通过标准**：bundle 自动 inline countActiveFromEntries；verify-staged dry-run require 通过；无需改 external 配置
- **回溯**：验证 G3 对跨 ext workspace dep 成立（本次 bug 的根因形态）

### 场景 5｜permission 解析 bash（WASM 路径）
- **步骤**：dev 发会话 → 触发 permission 对 bash 命令的解析
- **通过标准**：permission 正常解析 bash AST，不报 wasm 加载失败

### 场景 6（审查 S2 补）｜错误堆栈可定位
- **步骤**：故意让某 extension 抛错（如 pi-goal 内 throw）→ 观察错误堆栈
- **通过标准**：堆栈结合 source map 能定位到源码 `.ts` 行号（开发者用工具还原；pi 运行时堆栈指 .js 是已知限制）

### 场景 7（fail-fast 拦截）｜残缺产物被拦截
- **步骤**：`rm -rf staged/pi-permission/*.wasm` → `pnpm dev`
- **通过标准**：verify-staged dry-run 报错 exit 非 0，dev 中断，错误指明缺哪个 + 恢复命令

---

## 5. 下一层拆分

### 5.1 实施路径（顺序，含 go/no-go 门）

| # | 单元 | justification | 可独立验收 |
|---|---|---|---|
| T1 | **go/no-go 前置探针（唯一剩余实测）**：用 **0.80.3 binary** 实测加载一个最小 `.js` extension（复刻 llama 路径） | 决策 4；virtualModules 已实测（§1.1），只剩 .js 加载能力待 binary 实测 | binary 加载 .js extension 无报错 |
| T2 | **跨 ext value import 前置确认**：确认 countActiveFromEntries 纯函数（已读 state.ts，T2 复核）+ logger 单一消费方（确认无第二个 builtin 用 getLogger）| 决策 2 持续约束 | 源码结论 |
| T3 | **bundle 脚本** `scripts/bundle-extensions.mjs`：esbuild 配置（external = §3.2 virtualModule 清单，wasm asset loader），产出 `apps/electron/resources/extensions/` | 方案 A 核心 | 9 个 index.js 产出 + 体积报告 |
| T4 | **重写 `prepare-builtin-extensions.sh`**：调 T3；**rsync 必须排除源码入口 `.ts`**（审查 M4 陷阱：resolver fallback `.ts` 优先 `.js`，残留 .ts 会旁路 bundle）；manifest 改写指向 `.js` + 校验"staged 无同名 .ts 残留" | 替换拷贝机制 + 防静默失效 | 脚本产出 9 自包含包且无 .ts 残留 |
| T5 | **校验门** `scripts/verify-staged-extensions.mjs`：dry-run require entry（非 declared deps 查询） | 决策 5；覆盖动态 require | 场景 7 |
| T6 | **接入 dev/build + postbuild** | G1/G2 闭环 | 场景 1/2 |
| T7 | **本地 pi 全量实测**：9 extension 在本地 pi CLI（rpc mode）逐个加载 | 对齐 AGENTS.md「extension 优先本地 pi 实测」 | pi 日志无 load error |
| T8 | **packaged 验证**：build + 新装 + 发会话 | G2 | 场景 2 |

### 5.2 文件改动地图

- **新增**：`scripts/bundle-extensions.mjs`、`scripts/verify-staged-extensions.mjs`
- **重写**：`scripts/prepare-builtin-extensions.sh`（调 bundle 脚本，删 `PKG_DEPS`，**rsync 排除源码 .ts 入口**，manifest 改写 + 无 .ts 残留校验）
- **改**：`apps/electron/package.json`（dev/build 接入 verify）、`scripts/postbuild-validate.sh`（增依赖完整性）、9 包 staged 副本 `package.json`（`pi.extensions` 指向 `.js`，**bundle 脚本自动改写 staged 副本，不改源码**）、permission staged 副本 `ast/loader.ts` 的 wasm 路径（**仅 staged 副本，不改源码**——需评估是否用 esbuild define/replace 注入路径）
- **不动**：extension **源码**、pi binary、`extension-resolver.ts`

> 审查 M4 关键陷阱：`extension-resolver.ts` 的 `resolveExtensionEntries` fallback 顺序是 **`index.ts` 优先于 `index.js`**（`extension-resolver.ts:345`）。若 rsync 拷了源码 index.ts 且 manifest 改写遗漏，pi fallback 到 .ts 源码 → **bundle 被静默旁路，bug 原样存在**。T4 必须排除 .ts 入口 + 加校验。

### 5.3 待验证检查点

- ⛔ T1：0.80.3 binary 实测加载 .js（go/no-go 唯一剩余门）
- ⛔ T3 后：permission wasm loader 路径适配
- ✅ 已测：virtualModules 清单（binary strings）、9 包无真 .node native（permission 走 WASM）、countActiveFromEntries 纯函数、resolver fallback .ts 优先、dev/prod staged 同源、protocol runtime value、pi 是 bun/jiti、typebox 在 binary 提供

---

## 修订记录

v2（审查后修订）：
- **M1**：external 权威源从"⛔T1待验证"改为"✅0.80.3 binary 已实测"（pi-* + @mariozechner 别名 + typebox）；T1 缩为"实测 .js 加载"
- **M2**：external 清单重新分类（web-tree-sitter inline、wasm asset、删 node-addon-api/node-gyp-build、无真 .node）；permission 走 WASM 路径已确认
- **M3**：G3 明确适用边界（静态 JS/TS + wasm asset；不含真 .node/动态 import）；验收补场景 4（跨 ext）、场景 6（source map）、场景 7（fail-fast）；verify-staged 升级为 dry-run require
- **M4**：补 subagent→pending-notifications value import（3 份 copy，纯函数安全论证）；删"resolver 不关心 .ts/.js"错误表述，改为 `.ts` 优先陷阱警示 + rsync 排除 .ts + 校验
- **M5**：方案 C 回退分析诚实化（需递归拷贝传递闭包才达成 G1/G2）
- **S2**：新增决策 7 source map + 验收场景 6
- **S4**：删除"失去 pi type-check"伪风险（jiti transpile-only）
- **推翻 S3**：dev 非回归（当前本就 prepare-once，无 HMR）
- **推翻 S6**：logger inline 反而更正确（pi 给每 extension 独立 ExtensionAPI）
