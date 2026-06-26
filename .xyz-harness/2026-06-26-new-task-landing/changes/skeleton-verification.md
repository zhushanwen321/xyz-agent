---
verdict: pass
type: skeleton-verification
upstream: code-architecture.md (§1/§3/§4/§9)
---

# 骨架验证记录 — 新建任务（code-skeleton）

> Step 7 物理验证。把 code-architecture.md §3 签名表 + §4 时序图 + §1 工程目录落成可编译骨架，
> 经 vue-tsc 实证：签名自洽 + Level 1 调用链签名匹配 + adapter 真引 SDK + 依赖方向无环。

## 1. 骨架产物

位置：`.xyz-harness/2026-06-26-new-task-landing/code-skeleton/`，镜像 §1 工程目录。

- 骨架代码文件：**29**（`src-electron/**/*.ts|.vue|.d.ts`）+ `tsconfig.json` ×1
- 策略（refactor 场景）：
  - **镜像复制 + 扩展**（10 文件）：`shared/protocol.ts`、`shared/session.ts`、`preload/index.d.ts`、`renderer/api/domains/session.ts`、`renderer/api/domains/git.ts`、`renderer/lib/ipc.ts`、`runtime/services/git-service.ts`、`runtime/services/ports/git-executor.ts`、`runtime/transport/git-message-handler.ts`、`runtime/infra/git-executor.ts` —— 复制现有 + 加新签名，验证 merge 后类型自洽
  - **新增完整骨架**（8 文件）：`composables/features/useNewTaskFlow.ts`、`lib/utils.ts`（2 纯函数）、4 个 `components/new-task/*.vue`、`stores/session.ts`（桩）、`types.ts`（GitInfo）
  - **依赖桩**（11 文件）：`shared/{index,provider,message}.ts`、`renderer/api/{index,transport,pending}.ts`、`runtime/{interfaces,utils/errors,utils/path-utils,infra/git-status-parser,transport/message-context}.ts` —— 仅暴露 NewTaskFlow 链路用到的签名（既有实现，本期不改）

`@xyz-agent/shared` path alias 指向骨架内 `shared/src`（镜像，含 git.createBranch/checkout 扩展），核心类型（SessionSummary/GitStatusResult/GitCommand）真引，非 any 重声明。

## 2. 强制验证 gate（6 项全过）

### ① 类型检查 — ✅ PASS

命令：`cd src-electron && ./node_modules/.bin/vue-tsc --noEmit -p ../.xyz-harness/2026-06-26-new-task-landing/code-skeleton/tsconfig.json`

结果：**EXIT 0，0 error**（strict + noUnusedLocals + noUnusedParameters 全开）。

证明：签名/参数/返回类型自洽 + Level 1 接线后调用链签名匹配（tsc 对 `sessionApi.create(cwd)` / `gitApi.checkout(sid,name)` / `this.execSafe(cwd,'checkout',[...])` / `this.ctx.gitService.createBranch(...)` 等真接线逐调用验签）。

迭代过程：首轮 11 个 TS6133（Vue 组件 script setup 绑定未在最小 template 消费）→ 把 template 真接 script 绑定（@click/:data/v-if）→ 二轮 0 error。

### ② lint（无占位符/类型逃逸）— ✅ PASS

grep `any|@ts-ignore|eslint-disable|# type: ignore|//nolint|#[allow]|TODO` 跨 29 文件：**0 命中**。
（首轮从真实 infra 镜像带入 1 行 `eslint-disable-next-line no-magic-numbers`，已移除——骨架 lint 规则未启用，注释残留即 gate 失败。）

### ③ 包依赖无环（与 §2 一致）— ✅ PASS

- 前端 DAG 单向：`components → composables → api/domains → transport/pending`；`api/` 不反向 import `composables/components/stores`（grep 0 命中）；`composables/` 不直接 import `transport/pending`（grep 0 命中，经 api/domains）。
- runtime DAG 单向：`handler → service → port`；`services/` 不反向 import `transport/`（grep 0 命中）。
- `lib/utils.ts` 仅依赖 `@xyz-agent/shared` 类型（纯函数零内部依赖）。

### ④ 调用链代码接线可达（Level 1）— ✅ PASS

每张 §4 时序图入口→底层在骨架代码里真实接线（非仅 import 图）：

| 时序图 | 接线实证（骨架代码 this.x() / api.x()） |
|--------|----------------------------------------|
| §4.1 主流程 | `startFlow` → `resolveDefaultCwd(session.list)` + `await sessionApi.create(effectiveCwd)`（useNewTaskFlow.ts:112） |
| §4.2 选目录 | `openDirDialog` → `await pickDirectory()` + `sessionApi.remove` + `sessionApi.create(path)`（:170,177,180）；DirSelectPopover → `recentWorkspaces(session.list)` |
| §4.3 选分支 | `selectBranch`/`confirmDirtySwitch` → `await gitApi.checkout(currentSessionId,name)`（:193,203）；`openBranchPopover` 守卫 `gitInfo==null`（:131） |
| §4.4 创建分支 | `submitCreateBranch` → `await gitApi.createBranch(...)`（:233）→ handler `this.ctx.gitService.createBranch`（git-message-handler.ts:88）→ `this.execSafe(cwd,'checkout',['-b',name])`（git-service.ts:230） |
| §4.5 非 git 降级 | `gitInfo` computed 派生 + `openBranchPopover` 守卫（:70,131） |

runtime 接线密度：GitService 全 7 方法经 `this.execSafe`/`this.requireCwd`（grep 11 处真调用）。

### ⑤ adapter 真引 SDK（Tier 2 证伪）— ✅ PASS

- runtime：`infra/git-executor.ts` 真引 `import { execFileSync } from 'node:child_process'`（:13），`execFileSync('git', fullArgs, {...})`（:32）—— SDK 契约经 @types/node 验签。
- 前端：`lib/ipc.ts` 真引 `window.electronAPI`（preload seam），`pickDirectory` 调 `api.pickDirectory(options)`（:66）—— 经 preload/index.d.ts 全局类型验签。

### ⑥ §3 签名表 orphan 覆盖 — ✅ PASS

§3 全部公开方法/类型在骨架有定义（16 行核验表逐项 grep 通过，详见 code-architecture.md §9 回填）。无 ❌ 未定义。

## 3. NFR④ 并发/骨架约束字段落地

- in-flight 幂等：`createInFlight`（AC-1.5 双击并发）、`branchCreateInFlight`（AC-7.9 防重复提交）—— useNewTaskFlow.ts:56,58
- 非法转换计数器（NFR④#3 反推状态机 bug）：`illegalTransitionCount`（:61，logger 接线点标注，实装⑥Wave）
- §3.8 骨架约束（session.create 回滚/结构化日志、getStatus P99 埋点、createBranch port 继承 8000ms 超时、GitCommand 白名单）—— 均以骨架注释 + 接线暴露，详见各文件注释。

## 4. 设计假设验证结论

- **签名可用**：`create(cwd?,label?)` / `checkout(sessionId,name)` / `createBranch(sessionId,name)` 经 tsc 实证自洽，跨前后端 payload 形状一致。
- **调用链闭合**：§4.1-§4.4 入口→底层代码可达，无断链。
- **状态机可落地**：8 态枚举 + ALLOWED 转换表 + 守卫编译通过，非法转换回 idle 守卫接线。
- **SDK 可行**：child_process.execFileSync + electronAPI.pickDirectory 静态契约验签通过。
- **无新依赖**：零新增 npm 包（pinia/clsx 等桩化规避，真实依赖在 src-electron/node_modules 既有）。

## 5. 移交⑥Wave 的叶子作用域

每个 throw/finally/桩 = ⑥一个 Wave 填充单元（骨架叶子）：
- runtime `infra/git-status-parser.ts`（parseGitStatus/deriveCounts/parseNumstat 返零值桩）→ 既有实现直接复用（getStatus 接线已就位）
- renderer `api/transport.ts`/`pending.ts` 桩 → 既有实现复用（NewTaskFlow 链路零改动）
- 各 Vue 组件 template（watermark/列表/表单）→ ⑥Wave 按 spec §6 填充（script setup 接线已就位）
- composable 错误 toast / spawn 失败回滚的 UI 侧处理 → 调用方/Vue 错误边界（接线点已标注）
