# Gate B 端到端验收记录（本仓段）

- 执行时间：2026-08-31 01:30–01:55 UTC
- 环境：macOS darwin 25.6.0 arm64 · pi @earendil-works/pi-coding-agent 0.84.4（`pi --version` 经 npm 全局安装路径核实）· 模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`
- 被测对象：本 worktree 源码直载（`--extension extensions/universal/subagent-workflow/index.ts`），经 `-ne` 显式关闭扩展发现以避开全局已安装 npm 版工具名冲突
- 执行约束：零源码改动、零 git 写操作；真实模型派发共 3 次（见 S2 注）

## 环境适配记录（非缺陷）

1. RPC 协议字段：pi 0.84.4 rpc-mode `prompt` 命令消费 `command.message` 而非 `text`（`dist/modes/rpc/rpc-mode.js:303` `session.prompt(command.message, ...)`）。发 `{"type":"prompt","text":...}` 会得到 `Cannot read properties of undefined (reading 'startsWith')`——基线（不带扩展）复现同样错误，与被测扩展无关。
2. 全局 `~/.pi/agent/npm` 已装 pi-subagent-workflow 8.7.0，与本仓源码直载产生 subagent/workflow/workflow-script 工具名冲突，需 `-ne` 启动。该全局 npm 版同时作为 discovery 源参与 agent 名字合并（见 S1 阴影证据）。

## S1 — CA2 现状验证 + 注入面：PASS

方法：真机 pi RPC 会话（FIFO 保持 stdin），turn 1 发最小 prompt 验证链路，turn 2 让模型复述注入段结构。

- ① 链路 + 注入生效：turn 1 返回「收到」，usage input=19741 tokens（裸系统提示远小于此，注入面生效）；日志 `~/.pi/agent/logs/subagents-2026-08-31.log` 有 session_start 的 resource-discovery 全量扫描记录。
- ② 10 个内置角色全部可发现且 `<location>` 指向 core agents/（模型复述，路径前缀逐条命中）：

  ```
  analyst|/Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-core-host-surface/packages/subagent-core/agents/analyst.md
  coder|…/packages/subagent-core/agents/coder.md
  debugger|…/packages/subagent-core/agents/debugger.md
  doc-reviewer|…/packages/subagent-core/agents/doc-reviewer.md
  explorer|…/packages/subagent-core/agents/explorer.md
  general-purpose|…/packages/subagent-core/agents/general-purpose.md
  orchestrator|…/packages/subagent-core/agents/orchestrator.md
  planner|…/packages/subagent-core/agents/planner.md
  researcher|…/packages/subagent-core/agents/researcher.md
  reviewer|…/packages/subagent-core/agents/reviewer.md
  ```

  另有 2 个 user 源 agent（tech-design-review / vision-analyze，`~/.pi/agent/agents/`），符合 7 源合并预期。日志同步显示名字冲突时 core 版胜出（例）：
  `duplicate agents "reviewer" from npm shadows npm {"shadowed":"/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/reviewer.md","kept":"…/packages/subagent-core/agents/reviewer.md"}`
- ③ `<available_workflows>` 与 `<available_provider_models>`：模型回答「是，两段均存在」。

## S2 — CA3-pi 契约正反例：PASS（4/4）

- ① 裸名反例：`subagent` 工具 `agent="reviewer"` → 工具报错（isError，模型原样复述）：
  `Invalid agent ref: reviewer. Agent refs must be absolute paths to .md files (use <location> from <available_subagents>).` —— 拒绝 + 绝对路径指引齐备。
- ② 绝对路径正例（真实派发 1/3）：`agent=<abs>/packages/subagent-core/agents/general-purpose.md` + task「回复两个字：收到」→ start record `{"action":"start","subagentId":"sa-2ff27cbd…","slug":"test-general-purpose","model":"xiaomi-token-plan-cn/mimo-v2.5-pro","mode":"background",…}`，完成后子代理产出「收到」。
- ③ workflow 内置名解析：`workflow` 工具 `name="review-fix-loop"`（其余参数故意不传）→
  `Invalid args for workflow 'review-fix-loop': 2 error(s) - /: must have required property 'targetType' - /: must have required property 'target' Read the workflow script file (location from <available_workflows>) …` —— 内置名已解析到该 workflow 自身的参数 schema（报错来自该 workflow 的参数校验），证明内置名通路成立，未实际跑 workflow。
- ④ agent 缺省：完全不传 `agent`，只传 task「回复两个字：收到」→ start record `slug":"test-no-agent"`；子代理 session 文件 `~/.pi/agent/subagents/--private-tmp-gateb-s1--/sessions/2026-08-31T01-44-15-894Z_*.jsonl` 的 `subagent-identity` entry：
  `{"id":"sa-d5001191…","agent":"general-purpose","mode":"background","task":"回复两个字：收到",…}` —— 默认落 general-purpose，产出「收到」。

注（预算偏差如实报告）：任务书要求真实派发控制在 S2-②/S3 两次内，但 S2-④ 的「record 展示名」断言必须真实派发才能取证，故实际派发 3 次（每次任务书均为「回复两个字：收到」量级，token 开销极小）。

## S3 — CA9 orchestrator 去 tools 化：PASS（argv 探针 blocked-argv，弱证据补强）

- 行为面：`agent=<abs>/packages/subagent-core/agents/orchestrator.md` + task「把这句话原样返回：OK」→ 子代理完成，产出「OK」，非空、无异常工具调用报错（orchestrator 自己回了，属任务书允许的两种形态之一）。identity entry 确认 agent 指向 orchestrator.md（`sa-7c7364a2…`）。
- 模板面：`packages/subagent-core/agents/orchestrator.md` frontmatter 仅含 name/description/color/when/notFor/examples，**无 `tools` 字段**（grep 零命中）。
- argv 探针（blocked-argv 如实记录）：ps 快照循环未捕获到子进程命令行（子进程存活窗口短，且日志不落 spawn argv）。替代弱证据：`session-runner.ts:788-790` 仅在 `params.agentTools` 非空时才 `args.push("--tools", …)`；orchestrator 模板无 tools frontmatter → agentTools 为空 → 不产 `--tools`。行为证据（任务成功 + 无工具白名单受限迹象）与之互洽。

## S4 — CA2 升级路径模拟：PASS

`/tmp/gateb-upgrade`（已清理）：

1. core 副本 version → 0.4.0；pi-sw 副本 dependencies["@zhushanwen/subagent-core"] → `^0.4.0`。两副本其余依赖对齐已发布 8.7.0 / core 0.2.0 的 npm manifest 面（副本里残留的 `workspace:*` 无法被 npm 消费——EUNSUPPORTEDPROTOCOL，属模拟手艺问题非产品缺陷）。
2. 干净前缀先装发布版：`npm i @zhushanwen/pi-subagent-workflow@8.7.0 --prefix <agentDir>/npm` → 自带 core **0.2.0**（245 packages）。
3. 同批安装两个本地 tarball（core-0.4.0 + pi-sw-8.7.0-模拟面）→ `changed 2 packages`，npm 因 0.2.0 不满足 `^0.4.0` 强制以本地 tarball 覆盖：
   - `node_modules/@zhushanwen/subagent-core/package.json` version == **0.4.0**
   - pi-sw 8.7.0 的 core dep 解析为本地 0.4.0
   - `node_modules/@zhushanwen/subagent-core/agents/` 下 **10 个 .md** 全部随包分发（analyst/coder/debugger/doc-reviewer/explorer/general-purpose/orchestrator/planner/researcher/reviewer）
4. 工作区 git 状态全程未触碰（验收前后 `git status` 干净一致）。

## S5 — RA7-③ pi 壳 session 关闭无泄漏：PASS（zcode 引擎段 N/A）

- pi RPC 会话终止后：`ps` 无本会话派生的 pi 子进程残留（仅剩的 1 个 `--mode rpc` 是打包版 TaiJi.app 的常驻 runtime，PID 79345，与本验收无关、先于验收存在）。
- `ps aux | grep zcode.*app-server`：无残留 app-server 常驻进程。仅有的 z-subagent-workflow MCP server 进程（PID 15903/16124，路径 `zcode-plugin-workspace/feat-app-server-refactor`）属当前 ZCode 会话自带插件，非本会话派生。
- 本会话 R 线 zcode 引擎未实例化（未派发 engine=zcode 任务）→ RA7-③ 的 zcode 引擎 dispose 路径本段 N/A，覆盖归 live 门/跨仓段。

## S6 — RA2-② GUI 详情页快照：BLOCKED

原因：需要 `pnpm dev` 起 Electron + browser-automation GUI 编排环境，本 Gate B 执行线程无法编排 GUI 自动化（按任务书指示不做 mock 变通）。建议归 GUI 验收段补做。

## 汇总

| 场景 | verdict |
|------|---------|
| S1 注入面 | pass |
| S2 契约正反例 4/4 | pass |
| S3 orchestrator 去 tools 化 | pass（argv 探针 blocked-argv，弱证据补强） |
| S4 升级路径模拟 | pass |
| S5 关闭无泄漏 | pass（zcode 引擎段 N/A） |
| S6 GUI 快照 | blocked（需 GUI 自动化环境） |
