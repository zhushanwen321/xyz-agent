---
name: pi-cw
description: "cw 递归编排大型多 agent 并行开发任务,适用于需多层拆解(epic/feature/slice/wave)的大树任务。触发词:递归编排、多 agent 并行开发、大任务拆解、大树拆分。配套 @zhushanwen/pi-cw-tool。"
---

# pi-cw

主 agent 发起递归编排:用 cw 建一棵 <顶层>->...->wave 的任务树(<顶层> 通常 epic,也可 feature/slice),派第一个 planning-agent 自递归展开整棵树,主 agent 空闲等 steer 唤醒,全树完成后报告用户。

> **编排机制**:子 agent 完成时 pi 自动 steer 唤醒父 agent(事件驱动,无轮询)。主 agent 只派第一个(根层) planning-agent,**不自己 descend 到子层**。设计依据见 `design-v4.md`（同目录）。

## 何时用

核心判据:**任务需要多 subagent 并行推进 + 上下文隔离**(不是树深——一棵 epic 树也能单 agent 线性走,见 cw-cli)。满足以下场景之一才用 pi-cw:
- 多个 wave 要 worktree 隔离并行开发
- 多个 slice/feature 子树要并行展开
- 单 agent 线性走完整棵树会撑爆上下文(设计 + 实现 + 审查 + 合并全栈),需按层隔离上下文

> 单 agent 模式或小任务（改 typo / 单文件 / 明确小 bug）走 `cw-cli` skill,不必建树。

## 何时不该用

- 单文件小改、明确的小 bug:直接 edit,或派单个 worker subagent;或走 `cw-cli` skill 单 agent 模式
- 线性任务、无需多 agent 并行:走 cw 单层 wave 即可,不必建树
- 能单 agent 线性走完的任务(哪怕要建 epic 树):走 `cw-cli` skill 单 agent 模式,不必上递归编排
- 纯分析 / 调研 / 设计文档:不写代码不该进 cw 编排

## 前置：cw-tool

本 skill 与 5 个编排 agent（planning / wave / dev / review / merge）打包在 `@zhushanwen/pi-cw-tool` 内。cw-tool 同时提供 cw_* 工具（cw_planning / cw_wave / cw_dev / cw_review）。安装确认分两层，不能互相反推：

- **skill + 工具层**：能读到本 skill 且 cw_* 工具可用，说明 cw-tool 的 skill + 工具已加载。
- **agent 层**：5 个编排 agent 走独立发现通路（resource-discovery），**不能由「skill 可读」反推 agent 已发现**。编排 agent 必须通过 npm 把 cw-tool 安装到扫描目录（`<agentDir>/npm/` 或 `<agentDir>/extensions/`）才被发现。

⚠️ **dev-link 限制**：dev-link（`XYZ_EXTENSION_PATHS`）只发现 skill + 工具，**不发现 agent**。用 dev-link live-edit 测 cw-tool 时，skill 可读、cw_* 工具可用，但 step 2 `subagent agent="planning-agent"` 会因 agent 不可发现而失败——需把 cw-tool npm 安装到扫描目录（或把 agent 软链进 `<agentDir>/extensions/`）才可编排。

若 cw_* 工具缺失，说明 cw-tool 的工具未正确安装/加载，编排第一步就会失败（agent 模板的 tools 字段解析为空）。

## 流程

### 1. 建树根

```bash
cw create <顶层> --slug <kebab-slug> --objective "<一句话目标,含可验收的完成标准>"
```

`<顶层>` 通常 epic,但 feature/slice 也能做根——选能覆盖全貌的最小层(选层标准复用 cw-cli skill 的「规模 × 性质」表)。递归编排的额外门槛:**顶层必须会拆出 ≥2 个可并行的下层 unit**;只拆 1 个(无并行价值)或整棵树线性串行即可,走 cw-cli 单 agent 模式更省。

拿到根 unit 的 unitId(下文记作 `<根Id>`)。

### 2. 派第一个 planning-agent

用 `subagent` 工具**后台**派发(`planning-agent` 是 cw-tool 内置的 agent 模板):

```
subagent(action="start", agent="planning-agent", slug="<根-slug>-planning", fork=false,
  task="<背景>这是 cw <根层> <根Id> 的层主 agent,目标:<原 objective>。这是递归编排,你会自递归派下层 planning-agent(<根层> 是 epic 派 feature,是 feature 派 slice,是 slice 派 wave)。<目标>先调 cw handoff --unitId <根Id> 拿上下文与 guidance,按 guidance 的派发指导自递归展开并合并子树。<验收>cw status --unitId <根Id> 显示该 <根层> 子树全部 closed。")
# 不传 model 参数——默认继承主 agent 模型,递归传给所有下层(见「模型派发」)。
# 用户特别指定时才传 model="provider/modelId",单个 subagent 生效或作为全树根模型。
```

task 三要素:
- **背景**:`<根层>` 的 `<根Id>`、目标、说明这是递归编排(planning-agent 会自递归派下层)
- **目标**:入口是 `cw handoff --unitId <根Id>`;自递归的每一步按 cw guidance 的派发指导执行
- **验收**:`cw status --unitId <根Id>` 子树全 `closed`(可查的检查点,禁止"完成""实现该功能"这类不可证伪描述)

派发后主 agent 结束当前 turn,进空闲态(session 保活)。

### 3. 等 steer 唤醒

planning-agent 自递归展开(epic->feature->slice->wave),每层 design -> 审查 -> execute -> 合并。叶子 wave 完成后 steer 逐层回溯,最终唤醒主 agent。**期间主 agent 不轮询、不介入下层**——下层失败由 planning-agent 按 L0-L3 自恢复(定义在 planning-agent 模板与 cw guidance,本 skill 不重复)。

### 4. 被唤醒后查进度

```bash
cw status                     # 全局
cw frontier --root <根Id>   # 看根子树 frontier
```

- 子树全 `closed` -> 进入第 5 步汇报用户
- 有 `active` / `blocked` -> planning-agent 还在跑,继续等下一次 steer 唤醒
- 长时间无唤醒(疑似 session 失活) -> 查 `cw status`,若 frontier 有未完成 unit 但无 active agent,按 unitId 重派对应层 planning-agent 续跑(cw 状态持久,不丢)

### 5. 报告用户

全树 closed 后汇报:完成了哪些 unit、合并了哪些分支、遗留的 followupActions(exec-review 记录的技术债)。**不信 agent 自报,以 `cw status` 为唯一真相**。

## 关键约束

- **只派第一个 planning-agent**:主 agent 不自己 descend 到 feature / slice / wave 层。下层派发是 planning-agent 的职责(它调 cw execute 自动建子 unit,并按 guidance 派子 planning-agent / wave-agent)。
- **靠 cw 查进度,不信自报**:agent 汇报"我做完了"不等于 cw 状态 closed。以 `cw status` / `cw frontier` 为唯一真相。
- **worktree 隔离**:wave 层用 `worktree: true` 派出(各 wave 独立工作目录,并行不冲突;worktree 与 fork 正交,fork 默认 false);主 agent 派的根层 planning-agent 不需 worktree(它只编排不写码)。worktree 的合并与清理由 slice 层 planning-agent 派 chain workflow(merge-agent)处理,细节见 planning-agent 模板。
- **失败恢复靠 L0-L3**:cw gate fail / 审查 must-fix / 方案缺陷 / 父层拆错,各有恢复路径(L0 就地改重审 / L1 cw replan / L2 父 replan 级联 / L3 上报人),定义在 planning-agent 模板与 cw guidance,本 skill 不重复。

## 模型派发

**默认不指定 model —— 递归继承主 agent 模型**。pi subagent 的模型解析是三层(显式 `model` 参数 → agent 模板 frontmatter `model` → 父 agent 当前模型兜底直接透传),子进程启动时用 `--model` 固化该解析结果,其再派子时不指定则继续透传。因此**只要派发点不传 `model`(且 agent 模板 frontmatter 不写 `model`),整棵 cw 树所有 agent 自动同模型**——这是唯一能保证「递归传给所有 subagent」的机制,不需要也不应该逐层重复指定。

- **全树同模型**:用户在主 agent 切换模型,或根派发(第一个 planning-agent)时显式传一次 `model="provider/modelId"`,下层全部自动继承。模型在每次派发瞬间固化,中途切换只影响后续派发。
- **单点覆盖**:用户特别指定某 subagent 用特定模型时,只在该次派发传 `model` 参数。指定但模型不存在 / 鉴权未配置会**抛错不静默降级**(错误信息列出可用模型),不会出现「以为用了 X 实际用 Y」。
- **cw.config.json 不配置 model**:cw 引擎只读 `testRunner`,不读 model 字段;`perLayer.model` 放进去是无人消费的死字段。

各层职责性质仅作用户自主差异化时的参考(planning 强模型 / dev 便宜模型等),不作为默认行为——默认一律继承主 agent 模型。

## 标记说明

| 标记 | 含义 |
|------|------|
| `[HISTORICAL]` | 历史经验规则,不允许删除或削弱,只能补充加强 |
| `[MANDATORY]` | 流程强制要求,不遵守会导致编排失败 |
