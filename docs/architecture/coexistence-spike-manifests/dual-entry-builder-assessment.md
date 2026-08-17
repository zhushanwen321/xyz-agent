# 双入口并存（方案 B）生产形态：electron-builder files 静态评估

> P0 coexistence spike — dual-entry-spike 产出（T6）
> 范围：**静态评估**，不实际修改 electron-builder.yml（spike 边界）。评估结论作为 w3 comparison-report（DM2 矩阵「electron-builder files / 构建产物目录」两行）的输入素材。

## 现状基线（apps/electron/electron-builder.yml）

| 规则 | 现值 | 说明 |
|------|------|------|
| files | `dist/main/**/*`、`dist/preload/**/*`、`dist/runtime/**/*`、`renderer/dist/**/*`、`package.json` + node_modules 白名单 | main 进程入口 + preload + runtime（asarUnpack 前提）+ renderer 产物 |
| asarUnpack | `dist/runtime/**/*`、`node_modules/node-pty/**/*` | 仅 runtime 与 native 模块需要解包 |
| main 入口指向 | `package.json "main": "dist/main/main.cjs"`（apps/electron/package.json） | electron-builder 依此找 main 进程入口 |
| 输出目录 | `dist/builder-output` | 打包产物 |

## 方案 B 生产化需要的改动（全部在评估层面，未实施）

### 1. files 需新增 `dist/main-new/**/*`

双入口并存时 asar 内必须同时含两套 main 产物：

```
app.asar/dist/main/main.cjs        ← 现有（files: dist/main/**/* 已覆盖）
app.asar/dist/main-new/main.cjs    ← 新增（需加 dist/main-new/**/*）
```

**评估**：单行追加，风险低。asarUnpack **不需要**为 main-new 改动——main-new.cjs 是纯 CJS（无 native 模块、无子进程加载需求），留在 asar 内即可。但注意：新增 main-new 产物会同步进 `!dist/builder-output/**/*` 排除规则的覆盖范围吗？不会——builder-output 是输出目录，与 dist/main-new 无关，无冲突。

### 2. renderer 新入口已被现有规则覆盖（零改动）

spike-dual-entry 构建 outDir = `apps/electron/renderer/dist/spike-dual-entry/`，落在现有 `renderer/dist/**/*` 规则内：

```
app.asar/renderer/dist/index.html              ← 现有（loadFile 旧入口）
app.asar/renderer/dist/spike-dual-entry/index.html ← 新入口，已被 renderer/dist/**/* 覆盖
```

**评估**：`renderer/dist/**/*` 通配天然包含子目录，**零改动**。这是 spike 把 spike-dual-entry outDir 放 renderer/dist 内子目录（而非独立目录）的直接收益——若放独立目录，需新增一条 files 规则 + gitignore 例外。

### 3. main 入口切换：electron-builder 单入口限制（核心约束）

electron-builder 通过 `package.json "main"` 字段决定启动哪个 main 文件——**一个产物只能有一个入口**。双入口并存的「切换」需要以下之一：

| 方案 | 改动面 | 评估 |
|------|--------|------|
| A. 构建时改写 package.json main 字段（`dist/main/main.cjs` ↔ `dist/main-new/main.cjs`） | 打包脚本 + 条件构建 | 最小改动，但两条管线共享 apps/electron/package.json，并发构建有写竞争；CI 需按 flag 走不同构建分支 |
| B. main 入口文件命名区分（`main-legacy.cjs` / `main-next.cjs`，经 files 白名单同时打包） | vite config fileName + electron-builder files | 规避「同名 main.cjs 双份」的 asar 内歧义（ES2），但「切换」仍需方案 A 的 main 字段改写或独立 app 目录 |
| C. 独立 app 目录（两套完整 electron-builder 配置 + 两个 productName） | 双份 electron-builder.yml | 改动面最大，不推荐——双入口是过渡期共存机制，最终收敛单入口，双 app 形态会遗留废弃资产 |

**推荐**：方案 A + B 组合——main-new 产物命名为 `main-new.cjs`（fileName 差异化，规避 ES2 同名覆盖风险），切换走构建脚本改写 main 字段。P0 spike 阶段维持现状（main.cjs 同名双份在 dist/main 与 dist/main-new 不同目录，构建期互不污染已实证，asar 内路径也不同，技术不冲突——差异仅在「package.json main 只能指一个」）。

### 4. preflight / postbuild 检查脚本影响

现有检查（scripts/preflight-check.sh / postbuild-validate.sh）验证 `dist/main/main.cjs` 存在性。双入口生产化后需扩展：
- preflight：`dist/main-new/main.cjs` 存在性（若启用）
- postbuild：asar 内容含 `dist/main-new/main.cjs`（若 files 加了）

P0 spike 阶段：**不触发**——本 wave 不改 electron-builder.yml，preflight 对 dist/main-new 无感知；verify-dual-entry.mjs 自身已断言 dist/main-new/main.cjs 存在。

## 结论

| 维度 | 评估 |
|------|------|
| files 改动 | 1 行追加（`dist/main-new/**/*`），renderer 侧零改动 |
| asarUnpack | 零改动（main-new 纯 CJS 无需解包） |
| main 入口切换 | 核心约束（package.json main 单入口），推荐构建期改写 + 产物命名区分 |
| 检查脚本 | preflight/postbuild 各加 1 条存在性断言（生产化时） |
| 总扰动面 | 低-中：files 1 行 + 构建脚本切换逻辑；相比方案 A（flag 机制）不触碰 renderer vite.config / window-factory / 运行期分支 |

**静态评估结论**：方案 B 的生产化打包改动集中在「files 加一行 + main 入口切换脚本」，asar/预检脚本扰动极小；但「单产物单 main 入口」是 electron-builder 的结构性限制，双入口真正并存运行（同一安装包可切换入口启动）需要构建管线级切换，无法纯靠 electron-builder 配置实现——这是 DM2 矩阵「electron-builder files」「CI 构建次数」「切换粒度」三行的关键输入。
