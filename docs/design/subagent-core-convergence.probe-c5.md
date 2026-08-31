# C5-pi-rebind 探针记录（probe-c5）

**单元**：C5-pi-rebind（convergence W5，impl-plan §2 C5 行）
**日期**：2026-08-30 | **分支**：`feat-subagent-core-host-surface`（C1-C4 已 committed：86b700f67 / 5b03be26d / 19c059bf6 / ec1dcdf9a）
**探针范围**：⑥ core 包 agents/ 进 pi 发现面（§5.4 检查点 2）+ ④ 依赖下限发布面替换策略 + jiti 运行时锚点前提。一次性 node 探针脚本（`extensions/universal/subagent-workflow/probe-c5.mts`，跑完已删）。

## 1 ⑥ core 包 agents/ 发现面实测（五场景）

**探针方法**：tsx 直引 core `discoverResources`（barrel）+ `findWorkspaceRoot`；hostRoots 按 pi 壳形态构造（与 `src/host/pi-host.ts` `agentDirKindRoots("agents")` 同构）：`user-pi = <agentDir>/agents`、`npm = <agentDir>/npm/node_modules`、`npm-dev = <agentDir>/extensions`；agentDir 取真实 `~/.pi/agent`（`PI_CODING_AGENT_DIR` 语义复刻）；探针内清 `XYZ_EXTENSION_PATHS`。P4/P5 用 tmp 目录 symlink 模拟发布态安装布局（core 包 symlink 指向仓内 `packages/subagent-core`）。

### P1 锚点解析（注入根的定位机制）

```
require.resolve("@zhushanwen/subagent-core/workflows/README.md")   （createRequire 锚定 pi-sw 自身）
  → /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-core-host-surface/packages/subagent-core/workflows/README.md
core 包根 = 锚点上两级 = <repo>/packages/subagent-core
npm 槽注入 dir（一级父目录）= <repo>/packages
```

锚点选型依据：`./workflows/*` 子入口在 core package.json 的 workspace 形态（`./workflows/*` → `./workflows/*`）与 publishConfig 发布形态**同径保留**，README.md 是两形态都必在的资产文件（C1 维护）——`require.resolve` 在 workspace 与发布态都从 pi-sw 自身依赖链命中。

### P2 真实 dev 拓扑（pi 三根，无注入）——**不命中，接线必要**

```
total=12 core-pkg-hits=0
  npm  ok  /Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/orchestrator.md
```

结论：core 包（`packages/subagent-core`）不在 pi 三根之下；当前 10 角色由 agentDir 内**旧版残留安装**（8.7.0 时代自带 `agents/`）提供——dev 拓扑下 core agents/ 不可发现，⑥ 的 hostRoots 注入是唯一通路（§5.4 检查点 2 判定：不命中 → 走注入降级）。

### P3 真实 dev 拓扑 + 注入（`{source:"npm", dir:<core 一级父目录>}` 追加在既有 npm 根之后）——**命中 10**

```
total=12 core-pkg-hits=10
  npm  ok  /Users/zhushanwen/Code/.../packages/subagent-core/agents/orchestrator.md
  npm  ok  /Users/zhushanwen/Code/.../packages/subagent-core/agents/general-purpose.md
```

结论：注入后 10 内置角色全部经约定目录扫描命中（core 无 pi manifest → 扫 `agents/` 约定目录，npm 槽语义成立）；同标签多根下靠后者（core 新模板）last-writer-wins 胜出——遮蔽旧版残留副本，序位仍在 user 级之上、npm-dev/project 级之下（红线 1）。**A2 豁免面实测成立**：新旧模板 frontmatter（name/description/when/examples）逐字一致（10 个 .md diff 仅 `tools:` 行与 body，注入段不渲染）——快照差异仅 10 角色的 `<location>` 路径前缀。

### P4 模拟发布态平铺布局（core 为 `node_modules/@zhushanwen/` 下兄弟包，无注入）——**命中 10**

```
total=11 core-pkg-hits=10（realpath 归一计数；字面路径为 symlink 形态）
  npm  ok  <tmp>/flat/npm/node_modules/@zhushanwen/subagent-core/agents/general-purpose.md
```

结论：npm install 默认平铺布局下，既有 npm 根（`<agentDir>/npm/node_modules`）即可命中 core 兄弟包——注入是幂等兜底（重复发现被 C2 realpath 去重吸收）。

### P5 模拟发布态嵌套布局（core 在 `pi-subagent-workflow/node_modules/` 内）

```
P5a 无注入：  total=1  core-pkg-hits=0   （npm 槽只扫一级子项，嵌套依赖不可达）
P5b +注入：   total=11 core-pkg-hits=10  （注入兜底生效）
```

结论：版本冲突场景 npm 嵌套安装下既有根不可达，注入是必要兜底。**三布局合论：注入对 dev / 平铺 / 嵌套全部成立，平铺下幂等。**

### 接线落点（已实施）

`src/host/pi-host.ts` `agentDirKindRoots("agents")` 追加第 4 根 `{dir: corePackageNpmRoot(), source: "npm"}`（仅 agents kind；workflows kind 刻意不注入——`<available_workflows>` 的 `<location>` 是 A2 快照不豁免面，红线 8）。解析失败（异常布局/加载器无 `import.meta.url`）降级为不注入 + warn，不阻断发现主链。

## 2 jiti 运行时锚点前提（规则 13 核实）

pi 扩展加载器 = jiti（`@earendil-works/pi-coding-agent` dist/core/extensions/loader.js:14 `createJiti from "jiti/static"`，jiti 2.7.0）。探针（jiti/static 加载仓内 TS 文件，跑完删）：

```
JITI-ANCHOR-OK /Users/.../packages/subagent-core/workflows/README.md
```

jiti 变换下 `import.meta.url` 可用、`createRequire(import.meta.url).resolve(锚点)` 从 pi-sw 包内解析成功——⑥ 的定位机制在 pi 真实加载器下成立（vitest 下同机制已由 `pi-host.test.ts` 第 4 根断言覆盖）。

## 3 ④ 依赖下限：发布链 workspace:* 替换策略

**链路核实**（read-only）：

- `scripts/apply-version.sh`：只 bump 各包 package.json 的 `version` 字段 + 生成 CHANGELOG + 消费 .changeset——**不改写** deps 里的 `workspace:*`；
- `.github/workflows/release-npm.yml:86`：发布执行 `pnpm changeset publish`（pnpm publish）——替换发生在 pnpm 打包时。

**pack 实测**（`pnpm pack` → 解包 tarball 的 package.json）：

```
"@zhushanwen/subagent-core": "workspace:*"  →  "@zhushanwen/subagent-core": "0.2.0"   （精确 pin，非 * 非 range）
```

**结论**：发布面依赖 = 依赖包**当前精确版本**。发布批内 apply-version.sh 先把 core bump 到 0.4.0（本单元 changeset 声明 pi-sw minor + core 0.4.0 minor 同批），pi-sw 发布 manifest 即携带精确 `"@zhushanwen/subagent-core": "0.4.0"`——**满足 ≥0.4.0 下限**（非 `*`、非更宽 range），无需把 deps 改写成 `workspace:^0.4.0`（且 core 现为 0.2.0，提前写 `^0.4.0` 会直接破坏 workspace 安装解析）。pi-sw package.json 零改动。

## 4 单元门证据

- pi-sw `npx vitest run` 全量：**71 files / 918 tests 全绿**（含新增 `tool-workflow-run-builtin-name.test.ts` 7 用例——fake registry 4 + 真 registry `WorkflowScriptRegistryImpl` 3；含 CA2 逐字节锚定用例 2 个：subagent 段旧模板逐字 golden + location 前缀替换等价、workflow 段全段逐字 golden）
- pi-sw `npx tsc --noEmit`：exit 0
- ⑦ grep 证据见验收报告（收口面深路径仅剩 injectors 4 函数 barrel 缺口 + 非收口面 agent-ref/model-ref 9 处，均登记 blocker/deviation）

## 5 十角色可见性证据（A2 前置）

P3 输出即 10 角色在新接线下的胜出路径（`<repo>/packages/subagent-core/agents/*.md`，与 C2 探针（probe-c2.md）的旧基线（`~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/*.md`）同为 npm 槽、同 stem 集——location 前缀变化即 A2 快照唯一豁免差异）。真机 dev 会话注入快照对比（CA2 完整三段）属 Gate B，移交收尾段执行。
