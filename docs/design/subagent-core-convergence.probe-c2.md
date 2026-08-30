# C2-core-discovery 对照探针记录（probe-c2）

**单元**：C2-core-discovery（convergence W2，impl-plan §2 C2 行）
**日期**：2026-08-30 | **基线**：分支 `feat-subagent-core-host-surface`（26caa731d 后工作区改动）
**探针对象**：`packages/subagent-core/src/shared/resource-discovery.ts` 改动前后 `discoverResources` 输出逐项一致性（回归红线：hostRoots Map→列表是行为敏感改动）

## 1 探针方法

一次性 node/tsx 探针脚本（`packages/subagent-core/probe-c2.mts`，用完已删）：

- **hostRoots 按 pi 壳形态构造**（与 `extensions/universal/subagent-workflow/src/host/pi-host.ts` 的 `agentDirKindRoots("agents")` 同构）：`getAgentDir()` 推导三根——
  - `user-pi` = `<agentDir>/agents`
  - `npm` = `<agentDir>/npm/node_modules`
  - `npm-dev` = `<agentDir>/extensions`
- `getAgentDir` 语义复刻自 pi 实装（`@earendil-works/pi-coding-agent` dist/config.js:420）：`PI_CODING_AGENT_DIR` env 优先，缺省 `~/.pi/agent`
- `workspaceRoot = findWorkspaceRoot(cwd)`（探针 cwd = packages/subagent-core → workspace root）
- 探针内 `delete process.env.XYZ_EXTENSION_PATHS`（净化 dev-link 源，聚焦 pi 三根单条目形态）

## 2 环境事实

- 本机 pi 真实 agentDir 存在：`/Users/zhushanwen/.pi/agent`（含 `agents/`、`npm/node_modules/`、`extensions/`）
- node v24.11.1 / tsx（仓根 node_modules/.bin）

## 3 改前输出（基线，2026-08-30 改动前采集）

```
# agentDir=/Users/zhushanwen/.pi/agent
# workspaceRoot=/Users/zhushanwen/Code/xyz-agent-workspace
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/general-purpose.md
user-agents	ok	/Users/zhushanwen/.agents/agents/tech-design-review.md
user-pi	ok	/Users/zhushanwen/.pi/agent/agents/vision-analyze.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/analyst.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/coder.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/debugger.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/doc-reviewer.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/explorer.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/orchestrator.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/planner.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/researcher.md
npm	ok	/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/reviewer.md
# TOTAL=12
```

stderr（D8d 双用户源 warn，改前后逐字一致）：

```
[subagents] [resource-discovery] duplicate agents "tech-design-review" from user-agents shadows user-pi {
  shadowed: '/Users/zhushanwen/.pi/agent/agents/tech-design-review.md',
  kept: '/Users/zhushanwen/.agents/agents/tech-design-review.md'
}
```

## 4 改后输出与对比结论

改后（W2① realpath 去重 + W2② project-host 槽 + W2④ Map→列表全部落地后）同探针再跑：

- **stdout 逐项一致**（`diff` 为空）：12 条资源的 source 标签、available、胜出路径、输出序全部不变
- **stderr 逐字一致**（warn 行不变）

真实 agentDir 环境无多链同文件形态（`~/.pi/agent/agents/` 无 symlink），realpath 去重不触发——单条目形态回归红线在真机成立。

## 5 单元测试佐证（多链/多根/序位等真机覆盖不到的面）

`packages/subagent-core/src/shared/__tests__/resource-discovery-host-roots.test.ts`（15 用例）+ 既有 `resource-discovery.test.ts`（40 用例，含 8→9 值分级穷举更新）全绿：

| 场景 | 断言 |
|------|------|
| 多链同文件去重 | a.md 本体 + b.md symlink → a.md：清单 1 条（首遇 a.md）；不产生遮蔽报告；跨源链（user-pi + user-agents 硬编码根）同归一 |
| 同 stem 不同物理文件 | last-writer-wins 覆盖不变（realpath 去重不伤遮蔽语义） |
| 同标签多根 | 两条 user-pi 根都入清单（旧 Map 语义靠后者覆盖的缺陷已消）；project-host 标签多根同理 |
| 同 stem 撞名本体胜 | 展开目标先注入、本体根后注入 → last-writer-wins 落本体（红线 2）；user-agents/project-agents 硬编码槽与注入合并时硬编码根（本体）在后胜 |
| project-host 槽序位 | project-pi < project-host < project-agents（压过 project-pi、被 project-agents 遮蔽）；未注入时槽位缺席 |
| 单层扫描维持 | 子目录不递归；源目录内 node_modules 目录不灌清单（红线 3） |
| pi 单条目形态快照 | 与真实 agentDir 同构 fixture（user-pi 三文件 + npm 包 10 内置角色 manifest + user-agents 撞名 + npm-dev 一包）：13 条 source+basename 逐项 toEqual + 胜出绝对路径锚定 |

全量门：`packages/subagent-core` vitest 全量 2363 passed / 6 skipped（既有 live-gate skip）+ `pnpm typecheck` 绿。

## 6 barrel 逐名探针（验收条款④）

- 运行时：barrel import `discoverResources` 为 function ✓
- 类型层：`ScanConfig` / `DiscoveredResource` / `ResourceSource` / `ResourceKind` 经独立 `tsc --strict` 探针文件逐名 import + 赋值兼容（含 `ResourceSource = "project-host"` 字面量）无错 ✓

## 7 §5.4 检查点 1 定案（project 槽 API 形态）

**已定案**：按设计倾向采用**新增显式槽位 `"project-host"`**（ResourceSource 枚举成员 + buildScanTargets 槽位，序位 project-pi-tmp 与 project-agents 之间），未走「复用现有槽语义扩展」——避免借位语义污染（上游 §5.3.1）。宿主未注入该标签时槽位缺席，与 user-pi/npm/npm-dev 注入语义一致；`ScanConfig.hostRoots: DiscoveryRoot[]` 端口签名不变（验收条款⑤）。zsw 侧消费（四根映射接入）归 W6-W9（另一会话）。
