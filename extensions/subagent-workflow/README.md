# @zhushanwen/pi-subagent-workflow

Pi 的 subagent + workflow 合并包：任务委派 + 多 agent 编排（chain / parallel / scatter-gather / map-reduce），单包统一执行链 + 分层配额（ADR-030）。

## 内置 Agents

| Agent | 角色 | 是否执行 |
|-------|------|---------|
| `context-builder` | 模糊需求 → 可执行规格（meta-prompt） | 只写 what |
| `planner` | 已明确需求 → 有序实施步骤 | 只写 how |
| `explorer` | 代码库结构摸底（只读） | 不改文件 |
| `researcher` | 外部资料 / 竞品 / 文档调研 | 不改文件 |
| `worker` | 编码 / 修复 / 文件操作 | 可改文件 |
| `reviewer` | 代码质量审查、找 bug | 只读 |
| `oracle` | 需求对齐核验 | 只读 |
| `orchestrator` | **纯协调器**：拆解 + 委派，不直接执行 | 只协调 |
| `general-purpose` | 兜底，无角色假设 | 按需 |

## Orchestrator 协调器模式

主 agent 禁用 bash / read / write / edit 等执行工具，只保留协调类工具，被迫作为纯协调器：拆解任务 → 委派 subagent → 汇总结果。orchestrator agent 自身也可递归委派子 orchestrator，实现分层任务拆解（深度受 `Depth: N/10` 护栏保护）。

可用工具仅 4 个：`todo`、`goal_control`、`workflow`、`subagent`。

### 启动命令

```bash
# 方式一：CLI 工具白名单（临时验证最快）
pi --tools todo,goal_control,workflow,subagent

# 方式二：白名单 + 注入 orchestrator 的 system prompt（推荐，主进程也具备协调器视角）
pi --tools todo,goal_control,workflow,subagent \
   --append-system-prompt "$(cat ~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/orchestrator.md)"
```

> **依赖**：需先安装本包及相关扩展
> ```bash
> pi install npm:@zhushanwen/pi-subagent-workflow
> pi install npm:@zhushanwen/pi-todo
> pi install npm:@zhushanwen/pi-goal
> ```
> `--tools` 白名单按 tool 注册名匹配。注意 goal 扩展注册的 tool 名是 `goal_control`（非 `goal`）。

### 递归深度

系统内置 `n = 10` 深度护栏（fork 链 + 嵌套取 max），超过抛 `ForkDepthExceededError`。实测建议控制在 **3-4 层**以内——更深层会因上下文逐层压缩导致信息失真。

## Workflow 生命周期（one-shot）

Workflow run 是一次性执行，状态机两态：`running → done`（`done` 唯一终态，reason 区分 completed / aborted / failed / budget_limited / time_limited）。`workflow` tool 仅 3 个 action：`run` / `status` / `abort`。

Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.

- **abort 是唯一的提前停止方式**：`{"action":"abort","runId":"<id>"}`（可选 `"error":"<reason>"`）。pause/resume action 已移除，调用会被 pi schema 校验拒绝（`Validation failed for tool "workflow"`）；`/workflows pause|resume <id>` 返回 removed 提示
- **session 切换/关闭时**，所有 running run 当即作废转 `done,failed`（state.error 为 `Session switched: run terminated` / `Session shutdown: run terminated`），已投入的 token 作废；需要结果就重新 run
- **快照格式 `wf-run-v2`**（status 两态、无 `pausedAt`）；旧 `wf-run-v1` 文件加载时静默跳过
- **worker 崩溃自动重建重试**（默认 3 次）：重建时在飞 agent 调用被清除重跑，已完成的调用保留 replay 缓存，不重复消耗 token

## 性能：sessions-index.json 持久化索引

冷启动首扫的 identity 探测结论持久化为 `<enc>/sessions-index.json`（stat 戳自校验、tmp(pid)+rename 原子写、60s 节流、损坏/版本不符静默回退全量探测），真实目录（1744 jsonl / 671MB）实测冷扫描中位数 972.8ms → 80.6ms（12.1x，预算 ≤300ms）。可复现验收脚本：`bench/cold-scan.bench.ts`（冷扫描计时 + 输出等价断言）、`bench/concurrent-scan.bench.ts`（3 实例并发 + 随机变异四判定），设计文档见 `.xyz-harness/2026-08-15-subagent-workflow-perf/sessions-index-design.md`。

## 安装

```bash
pi install npm:@zhushanwen/pi-subagent-workflow
```

## License

MIT
