---
name: recursive-split
description: "递归编排大型多 agent 并行开发任务,适用于需多层拆解(epic/feature/slice/wave)的大树任务。触发词:递归编排、recursive split、多 agent 并行开发、大任务拆解、大树拆分。仅用于 xyz-agent 项目。"
---

# recursive-split

主 agent 发起递归编排:用 cw 建一棵 epic->feature->slice->wave 的任务树,派第一个 planning-agent 自递归展开整棵树,主 agent 空闲等 steer 唤醒,全树完成后报告用户。

> **编排机制**:子 agent 完成时 pi 自动 steer 唤醒父 agent(事件驱动,无轮询)。主 agent 只派第一个 epic planning-agent,**不自己 descend 到子层**。设计依据见 `/tmp/cw-recursive-orchestration-design-v4.md`。

## 何时用

满足任一:
- 任务需要 epic/feature/slice/wave 多层拆解(单层 wave 装不下)
- 多个 wave 可并行,各自 worktree 隔离开发
- 单 agent 从头做到尾会撑爆上下文(设计 + 实现 + 审查 + 合并全栈)

## 何时不该用

- 单文件小改、明确的小 bug:直接 edit,或派单个 worker subagent
- 线性任务、无需多 agent 并行:走 cw 单层 wave 即可,不必建树
- 纯分析 / 调研 / 设计文档:不写代码不该进 cw 编排

## 流程

### 1. 建树根

```bash
cw create epic --slug <kebab-slug> --objective "<一句话目标,含可验收的完成标准>"
```

拿到 epic 的 unitId(下文记作 `<epicId>`)。

### 2. 派第一个 planning-agent

用 `subagent` 工具**后台**派发(`planning-agent` 是项目 `.agents/agents/` 下的 agent 模板):

```
subagent(action="start", agent="planning-agent", slug="<epic-slug>-planning", fork=true,
  task="<背景>这是 cw epic <epicId> 的层主 agent,目标:<原 objective>。这是递归编排,你会自递归派 feature/slice/wave 层 planning-agent。<目标>先调 cw handoff --unitId <epicId> 拿上下文与 guidance,按 guidance 的派发指导自递归展开并合并子树。<验收>cw status --unitId <epicId> 显示该 epic 子树全部 closed。")
```

task 三要素:
- **背景**:epic 的 `<epicId>`、目标、说明这是递归编排(planning-agent 会自递归派下层)
- **目标**:入口是 `cw handoff --unitId <epicId>`;自递归的每一步按 cw guidance 的派发指导执行
- **验收**:`cw status --unitId <epicId>` 子树全 `closed`(可查的检查点,禁止"完成""实现该功能"这类不可证伪描述)

派发后主 agent 结束当前 turn,进空闲态(session 保活)。

### 3. 等 steer 唤醒

planning-agent 自递归展开(epic->feature->slice->wave),每层 design -> 审查 -> execute -> 合并。叶子 wave 完成后 steer 逐层回溯,最终唤醒主 agent。**期间主 agent 不轮询、不介入下层**——下层失败由 planning-agent 按 L0-L3 自恢复(定义在 planning-agent 模板与 cw guidance,本 skill 不重复)。

### 4. 被唤醒后查进度

```bash
cw status                     # 全局
cw frontier --root <epicId>   # 看 epic 子树 frontier
```

- 子树全 `closed` -> 进入第 5 步汇报用户
- 有 `active` / `blocked` -> planning-agent 还在跑,继续等下一次 steer 唤醒
- 长时间无唤醒(疑似 session 失活) -> 查 `cw status`,若 frontier 有未完成 unit 但无 active agent,按 unitId 重派对应层 planning-agent 续跑(cw 状态持久,不丢)

### 5. 报告用户

全树 closed 后汇报:完成了哪些 unit、合并了哪些分支、遗留的 followupActions(exec-review 记录的技术债)。**不信 agent 自报,以 `cw status` 为唯一真相**。

## 关键约束

- **只派第一个 planning-agent**:主 agent 不自己 descend 到 feature / slice / wave 层。下层派发是 planning-agent 的职责(它调 cw execute 自动建子 unit,并按 guidance 派子 planning-agent / wave-agent)。
- **靠 cw 查进度,不信自报**:agent 汇报"我做完了"不等于 cw 状态 closed。以 `cw status` / `cw frontier` 为唯一真相。
- **worktree 隔离**:wave 层用 `worktree: true` 派出(各 wave 独立工作目录,并行不冲突);主 agent 派的 epic planning-agent 不需 worktree(它只编排不写码)。worktree 的合并与清理由 slice 层 planning-agent 派 chain workflow(merge-agent)处理,细节见 planning-agent 模板。
- **失败恢复靠 L0-L3**:cw gate fail / 审查 must-fix / 方案缺陷 / 父层拆错,各有恢复路径(L0 就地改重审 / L1 cw replan / L2 父 replan 级联 / L3 上报人),定义在 planning-agent 模板与 cw guidance,本 skill 不重复。

## 派发 model 建议

**cw.config.json 不配置 model**——cw 引擎只读 `testRunner`,不读 model 字段;`perLayer.model` 放进去是无人消费的死字段。model 在派发点(subagent 工具的 `model` 参数)决定,各层建议:

| 层 | 职责性质 | model 建议 |
|---|---|---|
| planning(epic / feature / slice) | 方案设计 + 拆分 + 调度,错则全树返工 | 强模型(glm-5.1 / ds-pro) |
| wave 层主 | 本层 design + 调度,范围窄 | 中(glm-5.1) |
| dev | 写码 + 测试,量大 | 便宜 coding(ds-flash / glm-turbo) |
| review | 主观审查,需判断力 | 强推理(ds-pro / glm-5.1) |
| merge | git 操作,机械 | 便宜(glm-turbo) |

主 agent 派 epic planning-agent 时用**强模型**:它是整棵树的根,方案错则全树返工,成本最高。下层 model 分配由各 agent 模板在派子时按本表执行。

## 标记说明

| 标记 | 含义 |
|------|------|
| `[HISTORICAL]` | 历史经验规则,不允许删除或削弱,只能补充加强 |
| `[MANDATORY]` | 流程强制要求,不遵守会导致编排失败 |
