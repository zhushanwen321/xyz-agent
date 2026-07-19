# 0038: 系统提示词替换走 pi 原生 CLI 核心段替换，追加走 before_agent_start hook

## 状态

已接受

## 上下文

xyz-agent 要让用户在 Settings 页配置「替换 pi 系统提示词 + 追加注入额外提示词」（spec：
`.xyz-harness/2026-07-16-system-prompt-config/spec.md`）。pi 0.80.3 的系统提示词由
`buildSystemPrompt` 拼装为单一 string，可干预入口有三条现实路线：

1. **`--system-prompt` CLI（核心段替换）**：自定义文本替换身份/工具列表/指引/pi 文档路径
   4 个核心段，project_context(AGENTS.md)/skills/日期/cwd 等动态段仍由 pi 照常拼接。
   代价：工具描述段被移除需用户自补；配置变更仅对新建会话生效（spawn 参数）。
2. **`before_agent_start` hook 整段替换**：hook 拿到的是**完整组装后**的提示词，直接返回
   用户文本会把 project_context/skills 等动态段冻结（A 项目会话拿到 B 项目的 AGENTS.md
   内容）或整体丢失。
3. **hook 内用 `systemPromptOptions` 重建**：自定义身份/指引 + 保留 pi 工具描述，可热生效。
   但需复制 pi 的拼装逻辑，pi 升级有漂移风险，且 options 是否含完整工具 snippet 未验证。

追加注入则有两条：`--append-system-prompt` CLI（静态，需重启进程）vs hook 每轮读配置
（热生效）。RPC 协议没有 `set_system_prompt` 方法，运行中热改只有 hook 一条路。

## 决策

- **替换**：走 `--system-prompt` CLI 核心段替换。runtime 在 session spawn 链路
  （session-lifecycle → process-manager → rpc-client）透传配置文本。
  恢复默认 = 不传该参数。UI 明示「仅对新建会话生效」和工具描述代价。
- **追加**：走 builtin pi 扩展的 `before_agent_start` hook，每轮读
  `<dataDir>/system-prompt.json` 追加文本。保存后下一轮对话即生效，进行中的会话也生效。
- **配置存储**：`<dataDir>/system-prompt.json` 全局一份，runtime 与 pi 内扩展读同一文件；
  扩展从 `PI_CODING_AGENT_DIR` env 向上两级推导 dataDir（dev/prod 均成立）。
- hook 内重建替换（保留工具段 + 热生效）作为已知增强方向留待后续，需另立 spec 并先验证
  `systemPromptOptions` 内容。

## 理由

- 路线 2 的冻结问题是正确性 bug（跨 cwd 串 project_context），不可接受。
- 路线 1 是 pi 原生语义，行为确定、无漂移风险；「新会话生效」对 xyz-agent 用户（频繁
  新建任务）可接受，且替换本身就是低频操作。
- 追加是高频微调操作，热生效体验显著优于重启，hook 每轮读小文件成本可忽略。
- 路线 3 是替换的最优 UX，但验证成本与维护成本最高，不适合作为 v1。

## 后果

- 正面：替换无冻结/漂移风险；追加热生效；两条路径各自取 pi 原生语义最稳的一面。
- 负面：替换与追加的生效时机不一致（新会话 vs 下一轮），UI 需分别标注；替换模式
  用户需自补工具描述。
