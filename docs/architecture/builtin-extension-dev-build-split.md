# Built-in Extension dev/build 加载路径分流（2026-08）

> **状态**：设计文档（已实施）
> **性质**：长期方案。架构归位——dev 与 build 的加载路径按各自本质分流，dev 不再替 build 背 bundle 成本。
> **关联**：
> - 承接 AGENTS.md §11「Plugin System 架构约束」2026-08-12 推翻记录（builtin 改为打包内置，dev/build 同源）
> - 修订 `scripts/prepare-builtin-extensions.sh`（定位收窄为 build-only）
> - 配套 `.agents/skills/dev-link/`（mandatory 在 dev 自动走源码，dev-link 收窄为非 mandatory 切换）

---

## 0. 结论先行

dev 与 build 的 builtin extension 加载路径分流：

| 模式 | 加载路径 | 形态 | 改源码后生效方式 |
|------|---------|------|----------------|
| **dev**（`!packaged`） | `extensions/<pkg>/`（源码目录，repo root） | `.ts` 源码，pi 原生加载 | 新建 session 即生效（无需 bundle、无需重启 dev） |
| **build**（`packaged`） | `Resources/extensions/@zhushanwen/<pkg>/`（staged bundle） | esbuild 全量 bundle 的自包含 `index.js` | 重新打包（electron-builder extraResources 拷贝） |

分流标志用既有的 `packaged`（`extension-service.ts:169` `this.packaged = options.packaged ?? isPackaged()`），不引入新开关。

代价：dev 与 build 的加载路径不同源（dev = 源码 `.ts`，build = bundle `.js`）。这是**刻意权衡**——用「加载形态差异」换「dev 零 bundle 成本」，而形态差异由「源码 = bundle 的源」这一关系约束在可控范围（见 §5 风险）。

---

## 1. 背景：dev/build 同源的代价

2026-08-12 决策把 builtin extension 改为「随应用打包内置」：esbuild 把每个 mandatory 包 bundle 成自包含 `index.js` → staged 到 `apps/electron/resources/extensions/@zhushanwen/<pkg>/` → electron-builder extraResources 拷进 `Resources/extensions/`。该决策令 **dev 与 build 同源**——dev 直接读 staged 目录，build 经 extraResources 拷贝同一目录。

同源的好处是「修一处即修两处」（所见即所得），但**让 dev 替 build 背了 bundle 成本**：

- 改任意 mandatory 源码（如 `extensions/goal/src/index.ts`）后，dev 不会感知——dev 读的是 staged 的 `index.js` bundle，不是源码。
- 必须先跑 `prepare-builtin-extensions.sh`（esbuild 全量 bundle 13 个包）才能让改动生效，再重启 dev（~40s/次）。
- 无 watch、无单包增量、无 live edit。开发 builtin 扩展的 inner loop 极差。

根因：`scanBundledExtensions`（`extension-resolver.ts`）的 dev 与 packaged 两个分支**指向同一 staged 目录**，只是相对基准不同（dev = `apps/electron/resources/...`，packaged = `process.resourcesPath/...`）。bundle 是 build 的必需工序（打包产物不能含 `.ts`、不能依赖 workspace 符号链接），却强制 dev 也走一遍。

---

## 2. 方案：packaged 标志分流

### 2.1 为什么 dev 能直接走源码

pi 原生支持加载 `.ts` extension（内置 ts loader）。源码包的 `package.json` 已声明 `.ts` 入口：

```jsonc
// extensions/goal/package.json
{ "name": "@zhushanwen/pi-goal", "main": "src/index.ts", "pi": { "extensions": ["./index.ts"] } }
```

dev-link 的 pi 模式（把源码 symlink 到 `~/.pi/agent/extensions/`）已长期验证 pi 加载 `.ts` 正常。因此 dev 读源码目录在技术上可行，且能消除 bundle 工序。

### 2.2 分流机制

`ExtensionResolver.scanBundledExtensions(projectRoot, packaged)` 改为按 `packaged` 分流：

- **`packaged = true`（build）**：不变。读 `join(projectRoot, 'extensions', '@zhushanwen')`（`projectRoot = process.resourcesPath`）——即 electron-builder extraResources 拷贝的 staged bundle。
- **`packaged = false`（dev）**：改为读源码目录 `join(projectRoot, '..', '..', 'extensions')`（`projectRoot = apps/electron`，repo root = `apps/electron/../..`）。

`packaged` 标志由 `ExtensionService` 构造时一次性确定（`options.packaged ?? isPackaged()`），透传给 `resolver.resolve()`（`extension-service.ts:267/410`）。runtime 进程在 dev（`tsx` 跑源码）与 packaged（跑 asar.unpacked bundle）下 `isPackaged()` 返回值不同，天然分流，无需新开关。

### 2.3 dev 源码扫描只保留 mandatory 集合

源码目录 `extensions/` 是**扁平结构**（`goal/`、`todo/`、`ask-user/` …，共 17 个 `@zhushanwen/pi-*` 包），而 build 的 staged 目录只含 **13 个 mandatory 包**（`prepare-builtin-extensions.sh` 按 `mandatory-extensions.json` SSOT bundle）。若 dev 全量加载源码目录，会多出 4 个非 mandatory 包：

| 非 mandatory 源码包 | 误加载副作用 |
|---------------------|-------------|
| `cw-tool` | 注册 cw 系列工具与 agent |
| `model-switch` / `plan` / `unified-hooks` | 注册各自工具/命令 |

（历史注记：设计时另有 `evolve-daily`——每日首个 session 自动跑 Python 分析写文件、副作用最重，及 `context-engineering` / `vision`，三包已从仓库删除；按 SSOT 过滤的机制防护保留，防未来再引入非 mandatory 副作用包。）

这与 build 产物集不一致。因此 dev 扫描源码后**按 `mandatory-extensions.json` SSOT 过滤**，只保留 mandatory 包：

```ts
const mandatoryNames = new Set(mandatoryExtensions.map(e => e.name))
for (const name of [...result.keys()]) {
  if (!mandatoryNames.has(name)) result.delete(name)
}
```

`readExtName` 读的是 `package.json.name`（如 `@zhushanwen/pi-goal`），与 mandatory SSOT 的 `name` 字段全链路一致（与 disabled key、`ExtensionInfo.name` 同源），过滤可靠。

**这不算「策略过滤」违约**：resolver 文档头声明「纯发现层，不做 disabled/mandatory/preset 策略过滤」。这里的过滤针对的是「**哪些包属于 builtin 源**」这一静态定义（由 mandatory SSOT 给定），而非运行时的 disabled/enabled/tier 状态。build 的 staged 目录天然只含 mandatory（prepare 脚本保证），dev 用 SSOT 显式对齐同一集合，是发现层的集合界定，不是 filter 管道的策略筛选。

### 2.4 mandatory 语义保留

dev 走源码后，mandatory 包仍标 `source: 'bundled'` 进入 `extension-filter.ts`。filter 按 `isMandatoryExtension(name)`（name-based，source-agnostic，排除 discovery 源）推导 tier：

- infrastructure 级（`pi-pending-notifications` / `pi-session-reader` / `pi-structured-output`）→ `tier: 'infrastructure'`，强加载、不可禁用。
- feature 级（其余 7 个）→ `tier: 'feature'`，可禁用、不可卸载。

这些守卫（`uninstallExtension` 抛 `builtin_cannot_uninstall`、`toggleExtension` 抛 `infrastructure_cannot_disable`）全部不变，因为它们判的是 name，与加载路径无关。

### 2.5 dedupe 无冲突

dev 不再读 staged 目录，mandatory 走源码（`source: 'bundled'`）。dev 环境默认不 npm-install 这些包（`apps/electron/package.json` 不依赖 `@zhushanwen/pi-*`），settings/third-party/user/discovery 通道也不含它们，故无同名冲突，`deduplicate` 的 first-write-wins 不会误杀。

---

## 3. 精确改动点

### 3.1 核心：`packages/runtime/src/infra/installers/extension-resolver.ts`

`scanBundledExtensions` 改为 dev/build 双分支：

**Before**（dev/build 同指 staged）：

```ts
scanBundledExtensions(projectRoot: string, packaged: boolean): ExtensionMap {
  const result: ExtensionMap = new Map()
  const builtinDir = packaged
    ? join(projectRoot, 'extensions', '@zhushanwen')                          // build: Resources/...
    : join(projectRoot, 'resources', 'extensions', '@zhushanwen')             // dev:  apps/electron/resources/...（staged）
  if (!existsSync(builtinDir)) return result
  this.scanDirectory(builtinDir, result, 'bundled')
  return result
}
```

**After**（dev 走源码 + mandatory 过滤）：

```ts
scanBundledExtensions(projectRoot: string, packaged: boolean): ExtensionMap {
  const result: ExtensionMap = new Map()

  if (packaged) {
    // build：读 staged bundle（projectRoot = process.resourcesPath）
    const builtinDir = join(projectRoot, 'extensions', '@zhushanwen')
    if (!existsSync(builtinDir)) return result
    this.scanDirectory(builtinDir, result, 'bundled')
    return result
  }

  // dev：读源码目录（projectRoot = apps/electron，repoRoot = projectRoot/../..）
  const sourceExtDir = join(projectRoot, '..', '..', 'extensions')
  if (!existsSync(sourceExtDir)) return result
  this.scanDirectory(sourceExtDir, result, 'bundled')
  // 只保留 mandatory 包，对齐 build staged 集合（见设计文档 §2.3）
  const mandatoryNames = new Set(mandatoryExtensions.map(e => e.name))
  for (const name of [...result.keys()]) {
    if (!mandatoryNames.has(name)) result.delete(name)
  }
  return result
}
```

新增 import：`import { mandatoryExtensions } from '@xyz-agent/shared'`（`mandatoryExtensions` 已从 shared 导出，`extension-service.ts` 已用同一来源）。

### 3.2 配套：`scripts/prepare-builtin-extensions.sh` 定位收窄

脚本本身保留（build 仍需它产出 staged bundle 供 electron-builder 拷贝）。脚本头注释与调用处说明收窄为 **build-only**：dev 模式 mandatory 走源码不再依赖本脚本。详见 §4.1。

### 3.3 配套：`.agents/skills/dev-link/` 合并优化版 + 收窄语义

合并 `feat-auto-name-session-refactor` worktree 的 dev-link 优化版（pi install/uninstall 替代 backup/restore + skill symlink + link-list 智能检测 + 多 worktree 支持）。SKILL.md 补充说明：**mandatory extension 在 dev 自动走源码，不需 dev-link**；dev-link 收窄为非 mandatory extension 的本地/npm 切换，以及临时测某 mandatory 包的别的源码版本。详见 §4.2。

---

## 4. 配套改动

### 4.1 prepare-builtin-extensions.sh 头注释 + dev 脚本调用处

**脚本头注释**：把「dev 与 build 同源：dev 直接读此目录」改为「只服务 build（electron-builder 前 staging）；dev 模式 mandatory 走源码（`extensions/<pkg>/`），不依赖本脚本」。

**dev 脚本调用处**（`apps/electron/package.json`）：从 `dev` 脚本移除 `prepare-builtin-extensions` 与 `verify-staged-extensions.mjs`——dev 运行时不再读 staged 目录，这两个步骤在 dev 下是纯开销（每次 `pnpm dev` 白跑一遍全量 bundle + 校验）。`build` 脚本不变（仍需 staged 供 electron-builder extraResources 拷贝）。这与 `dev:mock`（本就不跑 prepare）对齐，确认 dev 不依赖 staged。

其余调用处（`scripts/preflight-check.sh` / `scripts/postbuild-validate.sh` / CI release workflow）本就是 build 期检查，语义不变。

### 4.2 dev-link SKILL.md 补充

新增段落说明 builtin extension 的 dev 加载机制：

- mandatory 包在 dev 自动从源码加载（`extensions/<pkg>/`），改源码新建 session 即生效，**不需要 dev-link**。
- dev-link 的用途收窄为：(a) 非 mandatory 的 `@zhushanwen/pi-*` 包（如 `context-engineering`、`cw-tool`）在本地源码与 npm 版本间切换；(b) 临时把某个 mandatory 包指向别处的源码版本（如 feature 分支的 worktree）做对比测试。

---

## 5. 验收场景

| # | 场景 | 期望 | 验证方式 |
|---|------|------|---------|
| A1 | dev 模式启动，未跑 prepare 脚本 | 13 个 mandatory 包从源码加载，ExtensionPage 列出 13 个 | dev 启动后看 `[extension-resolver] resolved N extensions` 日志 + ExtensionPage |
| A2 | dev 模式改 `extensions/goal/src/` 某文件 | 新建 session 即生效（无需 bundle/重启） | 改源码 → 新 session → 观察行为变化 |
| A3 | dev 模式源码目录含非 mandatory 包（`evolve-daily` 等） | 不被加载（filtered out） | dev 启动日志 resolved 数 = mandatory 集合，不含非 mandatory |
| A4 | packaged 模式（build 产物） | 13 个 mandatory 包从 `Resources/extensions/@zhushanwen/` 加载（staged bundle） | 打包后启动，行为同改前 |
| A5 | mandatory 守卫 | infrastructure 不可禁、feature 可禁不可卸（dev/build 皆然） | ExtensionPage 操作开关/卸载按钮 |
| A6 | 单测 | `scanBundledExtensions` dev 分支返回 mandatory 源码集合、packaged 分支不变 | `npx vitest run extension-resolver.test.ts` |

> A1/A2/A3/A5 涉及 dev 进程管理与 browser-automation，由主 agent 后续实测；本设计文档的实施交付物 = 代码 + 单测 + typecheck（A4/A6）。

---

## 6. 风险

### R1：dev 源码的 node_modules 解析

源码包的 value 依赖（如 `@xyz-agent/extension-protocol`）需从 node_modules 解析。源码目录 `extensions/<pkg>/` 自身无 `node_modules`，依赖 pnpm hoist 到 repo-root `node_modules`。Node 的 resolution 从 extension 真实路径向上走：`extensions/<pkg>/node_modules`（无）→ `extensions/node_modules`（无）→ repo-root `node_modules`（命中）。

pi 的 peerDeps（`@earendil-works/pi-*`）由 pi virtualModules 在运行时注入，不走 node_modules——这与 staged bundle 的 external 策略一致（bundle 时也把 virtualModules 标 external）。

**缓解**：dev-link pi 模式（symlink 源码到 `~/.pi/agent/extensions/`）已长期验证同样的源码加载与依赖解析路径，证明 dev 读源码可行。本方案把 dev-link 的「symlink 到外部目录」改为「直接用项目内源码路径」，依赖解析的向上查找基准不变（都从源码真实路径出发）。主 agent 实测 A1 确认。

### R2：dev/build 加载形态差异

dev 加载 `.ts` 源码，build 加载 `.js` bundle。两者的潜在差异：

- **bundle 内联 vs 源码 import**：esbuild 把 value 依赖 inline 进 bundle；源码走真实 import 经 Node resolution。若某依赖在 dev 的 repo-root node_modules 存在但 bundle 时被 esbuild tree-shake 掉行为差异，可能出现 dev 能跑、build 报错（或反之）。**缓解**：bundle 的 external 策略与源码 import 一致（只 external pi virtualModules），value 依赖两边都真实加载；CI 的 postbuild `verify-staged-extensions.mjs` 做 import dry-run 校验。
- **`.ts` vs `.js` 语法**：pi 内置 ts loader 编译 `.ts`，esbuild 也编译 `.ts`，两者目标都是运行时 JS，语义一致。
- **新增 mandatory 包**：加入 `mandatory-extensions.json` 后，dev 自动从源码发现（`scanDirectory` 扫到 + mandatory 过滤放行），build 由 prepare 脚本 bundle——两边都自动生效，无需改打包配置（extraResources filter 为 `**/*`）。

### R3：dev 误删 staged 目录不影响

dev 不再读 staged 目录（`apps/electron/resources/extensions/@zhushanwen/`），故即便该目录被 `.gitignore` 忽略、未跑 prepare 脚本而不存在，dev 也能正常加载 mandatory（从源码）。`existsSync` 兜底：源码目录不存在时返回空（全新 clone 但未装依赖的极端情况），与旧行为一致。

### R4：测试 mock 适配

`extension-resolver.test.ts` 的 `join` mock 为 `args.join('/')`（不解析 `..`），dev 源码路径 `join(projectRoot, '..', '..', 'extensions')` 在测试里表现为 `/project/../../extensions`。已更新对应断言（dev 路径 + mandatory 过滤断言），详见 commit。
