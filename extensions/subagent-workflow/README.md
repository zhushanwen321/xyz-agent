# @zhushanwen/pi-subagent-workflow

Pi 的 subagent + workflow 合并包：任务委派 + 多 agent 编排（chain / parallel / scatter-gather / map-reduce），单包统一执行链 + 分层配额（ADR-030）。

## 内置 Agents

按「读/写 × 视角」正交切分，9 个角色零重叠：

| Agent | 角色 | 读/写 |
|-------|------|-------|
| `explorer` | 代码库侦查：找入口 / 追调用链 / 摸结构 | 只读 |
| `planner` | 复杂任务拆解为有序实施计划（合并需求澄清） | 只读产文档 |
| `coder` | 代码实现、修改、测试（唯一改代码的角色） | 可改 |
| `reviewer` | 代码审查与需求验收（含 git diff） | 只读 |
| `debugger` | 运行时故障诊断，钉根因 | 只读* |
| `analyst` | 深度项目分析，产出给人读的报告 | 只读 |
| `researcher` | 外部资料调研（依赖 tavily skill） | 只读 |
| `orchestrator` | **纯协调器**：拆解 + 委派，不直接执行 | 只协调 |
| `general-purpose` | 兜底，无角色假设 | 按需 |

\* debugger 可加临时诊断日志，但必须诊断后恢复，不改业务代码（修复归 coder）。

日常调用链路：
```
陌生代码改动：  explorer → (planner) → coder → reviewer
修 bug：       debugger 定位 → coder 修复+补测试 → reviewer 验收
新功能开发：    planner → [coder 并行多包] → reviewer 验收
深度调研：      analyst (项目) / researcher (网页)
```

## Orchestrator 协调器模式

主 agent 禁用 bash / read / write / edit 等执行工具，只保留协调类工具，被迫作为纯协调器：拆解任务 → 委派 subagent → 汇总结果。orchestrator agent 自身也可递归委派子 orchestrator，实现分层任务拆解（深度受 `Depth: N/10` 护栏保护）。

可用工具 5 个：`todo`、`goal_control`、`workflow`、`subagent`、`ask_user`（`ask_user` 由 `@zhushanwen/pi-ask-user` 提供，未安装时 orchestrator 遇歧义会明示停止而非猜测）。

### 启动命令

```bash
# 方式一：CLI 工具白名单（临时验证最快）
pi --tools todo,goal_control,workflow,subagent,ask_user

# 方式二：白名单 + 注入 orchestrator 的 system prompt（推荐，主进程也具备协调器视角）
pi --tools todo,goal_control,workflow,subagent,ask_user \
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

## 安装

```bash
pi install npm:@zhushanwen/pi-subagent-workflow
```

## License

MIT
