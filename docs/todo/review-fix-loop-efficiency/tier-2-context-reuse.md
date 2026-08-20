# review-fix-loop 效率优化 梯队 2：上下文复用架构（前缀稳定化 + 持久 reviewer 会话 + diff 指纹去重）

> **一句话结论**：把「每轮新开 agent 全额重付静态前缀」改为三层复用——prompt 前缀逐字节稳定化（命中 provider 缓存）、持久 reviewer 会话跨轮保留上下文（复用 KV/缓存）、diff 指纹去重跳过无变更轮次；持久会话是主方向但需实测轮数拐点，前缀稳定化与指纹去重是零风险的先行项。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 的批内每轮通过 `parallel()` 派发 reviewer subagent；pi 的 subagent 支持 `conversation:true`（跨轮保留对话历史）。调用方主要走多 provider（kimi/minimax/deepseek 等），缓存支持不可统一假定。
- **C（冲突）**：现状每轮 reviewer 是全新 spawn——代码库侦查 + 读文件 + 审查规则在每轮被全额重复支付。学术成本公式（arXiv 2601.12307）证明：上下文有重叠时，同会话复用 `C_single ∝ ΣΔL_t` 严格 ≤ 多 agent 各自重付 `C_multi ∝ ΣL_t`，等号仅在零重叠成立；而审查循环的上下文重叠极高（同一 diff 反复审）。Claude Code 官方 issue #7317 同样把「subagent 无状态导致 follow-up 重放上下文」列为痛点。
- **Q（问题）**：怎么让跨轮的静态上下文（规则、侦查结果、已读文件）只付一次，同时防住持久会话的上下文膨胀/腐烂？
- **A（答案）**：三招按风险从低到高落地——① prompt 结构改为「静态前缀逐字节固定 + 动态后缀」（有缓存的 provider 白捡 41-80% 输入折扣，无缓存也无害）；② diff 指纹去重（无实质变更的轮次直接跳过）；③ 持久 reviewer 会话试点（conversation:true + 轮末锚定压缩），用梯队 1 的 origin 数据实测轮数拐点后决定推广。

## 1. 背景：被设计的系统是什么

**本章结论：本次设计聚焦 reviewer agent 的「跨轮上下文生命周期」——现状是每轮出生即销毁，设计目标是可复用。**

review-fix-loop 结构见梯队 1 文档（同目录 `tier-1-cheap-wins.md`）§1，本文自包含要点：批内轮次循环，每轮 `buildReviewCall(def, round, ...)` 构造 prompt（R1 全量审查指令 / R2+ 对账指令 / scoped 限定指令）后经 `agent()` 派发到 subagent；R2+ prompt 携带上轮聚合报告路径、fix 结果、known-remaining 清单——**这些动态内容与静态内容（角色、审查维度、输出 schema 说明）在 prompt 中的排列顺序现状未做刻意设计**。

pi subagent 的会话能力（本会话工具契约，已核实）：`conversation:true` 让 subagent 跨多轮 `message` 保持完整上下文；`idleTimeoutMs` 控制空闲存活；`close` 显式释放。

**层声明**：当前层 = 技术方案设计；下一层 = 实现任务（workflow 脚本的 prompt 拼装重构 + subagent 会话管理 + 压缩策略）。涉及运行时行为断言，准则 5/6/7 全适用——凡运行时断言（缓存命中、会话复用收益）**一律标 ⛔ 探针**，不以推理声称。

## 2. 设计目标

**本章结论：改造后，静态上下文在一个 run 内只全额支付一次；无实质变更的轮次零成本；持久会话的收益有实测数据支撑再推广。**

1. **前缀可缓存**：同一 run 内同一 reviewer 的各轮 prompt，从首字节到动态段起点逐字节相同（时间戳、轮次号、可变清单全部后置）。
2. **无变更不重审**：fix 后 diff 指纹与上轮相同（修复无实质代码变更）→ 跳过该轮 review，记 log。
3. **持久会话可试点**：可选参数 `persistentReviewers=true` 时，同一 reviewer 跨轮复用会话，每轮只发增量消息（对账表 + 修复 diff）；轮末做锚定式轻压缩。
4. **可回退**：三个机制独立开关，互不依赖；试点数据（轮数-成本曲线）决定持久会话是否转正。

**In-scope**：review-fix-loop.js 的 prompt 拼装、agent 派发层（subagent 会话管理）、state.json 增加指纹字段。**Out-of-scope**：provider 侧缓存配置（不归 workflow 管）；aggregator/fix agent 的会话化（reviewer 是成本大头，先行）；梯队 1 已覆盖的 scoped recheck 等。

## 3. 现状：使用者眼里是什么样的

**本章结论：每轮 reviewer prompt 从头拼接、顺序不稳定；agent() 每次新 spawn；无变更轮次照跑。**

### 3.1 现状的真实样子

R1 prompt（脚本 `buildReviewCall` 节选，真实代码）：

```js
prompt: [
  header,            // "Batch 1 Round 1/10 — xxx"（每轮变化，在开头！）
  "",
  reviewInstruction + prevBatchesHint,
  "Review requirements:",
  reviewPrompt,
  "output 路径：" + roundDir + "/" + def.report + ".md",   // 每轮变化
  ...
].join("\n")
```

R2+ 走 `buildR2ReviewPrompt`（utils），同样把轮次 header 放在最前。**变化内容（轮次号、roundDir、对账数据）与不变内容（审查要求、角色）混杂且变化项靠前**——缓存视角下这是最坏排列：provider 前缀缓存从顶向下哈希，断点前任何字节变化使整段前缀失效。

派发层（脚本）：`runReviewAgent(call) → agent(call)`——每次调用是新 subagent 进程/会话，无任何跨轮复用。

### 3.2 怎么出错

- **A 静态前缀逐轮重付**：审查规则 + 侦查读入的文件，R1 付一遍、R2 付一遍、R3 再付一遍。实测量级参照：长程 agentic 任务开缓存后成本省 41-80%（arXiv 2601.06007，跨 4 模型实测）；19 次工具循环 agent 省 68%（工程单源，https://pub.towardsai.net/agent-loop-caching-the-missing-optimization-for-agent-workflows-230cc530eb72 ）。
- **B 无变更轮照跑**：fixer 只改了注释或 commit message，diff 实质未变，下一轮全量重审照样付费。Cursor Bugbot 用 patch-ID 指纹跳过相同 diff（官方 docs，https://cursor.com/docs/bugbot ）。
- **C 无法试错会话化**：没有开关就没有数据，会话化收益永远停留在论文公式层面。

### 3.3 根因

workflow 脚本诞生时以「无状态可重放」为设计约束（callId 重放安全、state.json 恢复），这个约束是对的；但它被错误地延伸到了「每轮必须新 spawn agent」——重放安全只要求**调用顺序确定**，不要求**上下文不复用**。两者正交：持久会话的 message 序列同样可以确定性重放。

## 4. 根因 + 物理数据流

**本章结论：成本在「磁盘 → prompt 字节流 → provider」这条链上逐轮重复产生；三个机制分别作用于链上三个点。**

```
磁盘（审查规则/角色 .md、目标 diff、上轮 state.json）
  ↓ buildReviewCall 拼装（【机制①作用点】静态段逐字节固定在前，动态段在后）
prompt 字节流
  ↓ agent() 派发（【机制③作用点】persistentReviewers=true 时复用会话，只追加增量消息）
provider API
  ↓ 前缀缓存命中判定（exact prefix match，provider 侧行为 ⛔ P-cache）
只付增量 + 缓存读价（约 0.1x，Anthropic 官方定价；OpenAI 自动缓存同向）

【机制②作用点】fix 后 git diff 指纹（patch-id）比对：
  state.json.lastPatchId == 本轮 patch-id → 跳过本轮 review，log "no material change"
```

> **diff 指纹** = 修复后工作区相对锁定 base 的 `git diff` 内容哈希（实现候选：`git diff | sha1`，或 `git patch-id`）。就是 §3.2-B 里「注释级改动」会被判为无变更的那个判定器。
> **锚定式轻压缩** = 每轮末把会话内已完成的审查结论合并进一份结构化状态文档（复用现有 state.issues 追踪表形态），会话历史中已落盘的中间推理可被压缩替换；依据：锚定式增量摘要优于全量重建（Factory 36,000 条真实会话消息评估的聚合报道，置信度 Moderate）。

## 5. 终态：使用者眼里将是什么样的

**本章结论：默认行为不变（安全）；开开关后，日志里能看到缓存命中、指纹跳过、会话复用三种省钱的直接证据。**

### 5.1 成功路径

```
[用户] workflow run review-fix-loop --args targetType=git-diff target=main batch1="..." \
         persistentReviewers=true
[run 日志] Round 1: Review: reviewer-a (new session sa-xxx), reviewer-b (new session sa-yyy)
           Aggregated: 3 must-fix. Fix round 1: fixed_count=3
[run 日志] Round 2: Review: reviewer-a (resume sa-xxx, +incremental msg), reviewer-b (resume sa-yyy)
           —— 增量消息 = 对账表 + R1 fix diff（而非全量 prompt）
[run 日志] Round 3: patch-id unchanged (R2 fix 只改了注释) — skipping review round
[run 日志] Round 4: all agents clean. terminated=clean
```

### 5.2 失败路径（带恢复指引）

- **provider 不支持缓存**：前缀稳定化无收益但也无害（纯 prompt 重排）。👉 用 ⛔ P-cache 探针确认当前 provider 行为；无缓存时关闭持久会话以外的期待，梯队 1 手段仍全额有效。
- **持久会话上下文腐烂**：轮数多时会话膨胀、reviewer 质量衰减（context rot，聚合研究称 lost-in-the-middle 可致 30%+ 精度损失，置信度 Moderate）。👉 表现 = 连续 2 轮 must-fix 数反常上升或 origin=missed 突增；恢复：重跑同一 run 加 `persistentReviewers=false`（默认即 false），并把该 run 的轮数记入待验证清单（§11 拐点数据）。
- **指纹误判**：fixer 改了代码但语义等价（如重排 import），指纹变化触发一轮「无新发现」审查——这是误多审不是误少审，代价上限 = 一轮 scoped 审查，可接受；反向（真变更被判同指纹）在 sha1 整 diff 方案下 by construction 不可能（字节不同即指纹不同）。
- **会话中途崩溃**：持久会话 agent 进程异常 → workflow 捕获 agent() 错误，按现有 review-failure 结构化终止。👉 恢复：`workflow run` 同参数重跑（state.json 断点恢复语义不变）；persistent 模式下崩溃轮降级为新 spawn 继续（会话状态从 state.issues + 上轮报告重建，损失该会话的内存上下文，功能不中断）。

## 6. 关键决策与权衡

**本章结论：三个机制按「零风险先行、高收益试点殿后」排序落地；持久会话是默认关闭的试点开关而非直接替换。**

### 6.1 prompt 前缀稳定化：重排拼装顺序

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 静态段前置逐字节固定（选） | 与 provider 缓存机制（Anthropic cache_control / OpenAI exact-prefix 自动缓存）对齐；无缓存时纯重排零代价 | 低：重排三个 build*Prompt 函数的段落顺序 + 逐字节快照单测 | 几乎无；唯一注意点是「逐字节」需要快照测试守护，防后续 PR 无意破坏 | ✅ |
| 维持现状 | — | 零 | 继续逐轮全价（§3.2-A） | ❌ |

约束：静态段**包括** reviewer 角色 .md 注入、审查要求、输出 schema 说明；动态段（轮次 header、roundDir、对账表、known-remaining、fix 结果）全部移到尾部。批内多个 reviewer 若共用角色定义，静态段也天然一致（缓存跨 reviewer 复用的前提 ⛔ P-cache-shared）。
依据：Anthropic 官方缓存文档（5m TTL 缓存读 0.1x）、OpenAI 官方文档（exact prefix match 自动缓存）；长程实测 41-80%（arXiv 2601.06007）。

### 6.2 diff 指纹去重

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 修复后 patch 指纹相同则跳过下轮 review（选） | 与 Cursor Bugbot patch-ID 行为一致；结构性消除「无变更审查轮」 | 低：fix 后算一次哈希比对 + state 字段 | 误多审（可接受，见 §5.2）；误少审 by construction 不可能（字节级比对） | ✅ |
| 不跳过 | — | 零 | §3.2-B 继续 | ❌ |

细节：指纹在「fix 有改动但 reviewer 视角无变化」时仍会变化（如重排 import）——此时多审一轮，代价上限一轮 scoped 审查；选择保守（宁可多审）方向，与审查系统的安全偏好一致。

### 6.3 持久 reviewer 会话：试点开关而非替换

这是本梯队收益最大、也最需谨慎的决策。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| `persistentReviewers` 试点开关（选） | 会话复用是学术证明的方向（C_single ≤ C_multi）；pi subagent conversation:true 提供现成基建；开关制保留无状态重放路径 | 中：派发层按 def.name 维护会话句柄 Map + 增量消息构造 + 崩溃降级 + 轮末压缩 | 上下文腐烂（轮数多质量衰减）；token 拐点未知（轮数少时持久化稳赢，多时未必） | ✅（试点） |
| 直接替换为持久会话 | 最省 | 中 | 无对照组无法知道是否更优；腐烂风险无护栏 | ❌ |
| 永不会话化，只做状态文件传递 | 重放语义最纯 | 低（梯队 1 已部分做到） | 每轮仍重付静态前缀；学术公式证明其成本上界高于会话复用 | ❌ |

**被否若用（直接替换）**：§5.1 的 Round 2 变成唯一形态后，一旦出现上下文腐烂（某 reviewer 第 6 轮开始报胡话），用户没有任何开关可退回——只能整 run 放弃。试点开关下同一 PR 可两种模式各跑一次直接对比成本。

⛔ 探针 P-persist：用同一个真实 PR 分别跑 `persistentReviewers=true/false`，对比总 token 与轮数；拐点假设「≤3 轮持久化稳赢」需在 ≥3 个真实 run 上验证后才允许考虑改默认值。

轮末压缩策略：复用锚定式增量摘要——每轮末 reviewer 输出已落盘（报告 + state.issues 追踪表），压缩时只保留「当前 open 问题清单 + 上轮对账结论」，中间推理历史压缩替换。实测参照：30 轮会话压缩省 67% 且质量指标反升（单源工程实测，https://pub.towardsai.net/long-context-compaction-for-ai-agents-part-2-implementation-and-evaluation-d708d2d2a6e5 ，置信度 Moderate ⛔ 需在本场景复测）。

### 6.4 减法门检：本梯队刻意不做什么

- **不做** provider 缓存 API 的显式对接（cache_control 断点等）——pi 的 provider 层是否透传缓存标记不在 workflow 控制面；前缀稳定化是「让自己可缓存」，对接是 provider 层的事。
- **不做** aggregator/fix 会话化——reviewer 占轮内 token 大头（侦查 + 全量读文件），先复用大头的上下文；aggregator 已在梯队 1 用降档模型处理。

## 7. 实现机制（把终态落到代码层）

**本章结论：三处改动对应三个机制，全部在 workflow 脚本与 utils 内，不动 subagent-workflow 引擎。**

| 文件 | 改动 |
|---|---|
| `workflows/review-fix-loop-utils.cjs` | 三个 build*Prompt 重排为「静态段 + 动态尾」；新增 `computePatchHash(workspace)`（git diff \| sha1）；静态段快照单测（逐字节断言） |
| `workflows/review-fix-loop.js` | ① 参数白名单 + @pi-meta 增加 `persistentReviewers`（默认 false）；② fix 后算 patchHash 与 `state.lastPatchHash` 比对，相同则跳过下轮并 log；③ persistent 模式：`reviewerSessions = Map<def.name, subagentId>`，R1 用 conversation:true spawn，R2+ 用 message 发增量（对账表 + fix diff），run 结束（含异常路径）统一 close |
| `src/__tests__/review-fix-loop-utils.test.ts` | 静态段快照测试 + patchHash 单测（相同 diff 同指纹 / 字节变化不同指纹） |

持久会话的增量消息格式 = 现有 `buildR2ReviewPrompt` 的动态段（对账要求 + fix 结果 + known-remaining），复用同一构造函数，不新造格式。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：大改动（派发行为变更 + 新运行时路径），用对照实验验收——同一真实 PR 两种模式各跑一次，比成本、比发现量。**

### 8.1 改动规模

大：新增会话管理运行时路径（含崩溃降级）、prompt 结构变更、新参数。必须多场景验收。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 前缀稳定性 | 目标 1 | 真实 run（≥2 轮）后 dump 同一 reviewer 的 R1/R2 prompt | 从首字节到动态段起点逐字节相同（diff 工具验证）；快照单测通过 |
| S2 指纹跳过 | 目标 2 | 构造真实场景：fix 轮只改注释（如 reviewer 报了一条文档类 must-fix），观察下一轮 | 日志出现 `patch-id unchanged — skipping review round`；state.json 记录该跳过 |
| S3 持久会话对照 | 目标 3/4 | 同一真实 PR（xyz-agent 仓，≥5 文件改动）跑两次：`persistentReviewers=true` / 默认 false | 两次都正常终止；true 组总 token ≤ false 组（⛔ P-persist 数据点 +1）；两组发现的 must-fix 集合人工比对无真问题丢失 |
| S4 崩溃降级 | 目标 4（护栏） | persistent 模式下手动 kill 一个 reviewer 会话进程（真实 kill，非 mock） | workflow 结构化降级：该 reviewer 本轮以新 spawn 续跑，run 不中断，日志有 WARN |
| S5 缓存行为探测 | ⛔ P-cache | 在当前主用 provider（kimi-coding 等）上跑两轮相同前缀请求，读响应 usage 的 cached_tokens 字段（若 provider 返回） | 得到确定性结论「该 provider 支持/不支持前缀缓存」，写入文档附录；不臆断 |

单测（快照/patchHash）只作回归辅助，不计入验收。

## 9. 实施

**本章结论：按风险从低到高分三里程碑，每里程碑独立可回退。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | 前缀稳定化（6.1）+ P-cache 探测（S5） | 目标 1 + provider 缓存事实 |
| M2 | diff 指纹去重（6.2） | 目标 2 |
| M3 | persistentReviewers 试点（6.3）+ 对照验收 S3/S4 | 目标 3/4 + 拐点数据 |

顺序理由：M1/M2 零风险先行拿到确定收益；M3 需要 M1 的 prompt 结构稳定化作为前提（会话增量消息与 prompt 动态段复用同一构造），且其验收依赖梯队 1 的 origin 数据判断质量是否衰减。

## 10. 下一层拆分

**本章结论：拆成 4 个实现任务。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 prompt 重排 + 快照单测 | 三个 build*Prompt 静态/动态分段 | 纯函数改动，快照测试守护「逐字节」承诺 |
| T2 P-cache provider 探测脚本 | 独立小脚本发两轮同前缀请求读 usage | 结论决定后续收益预期，必须最先拿到事实 |
| T3 patchHash 跳过 | utils 函数 + 主循环集成 | 与 T1 无依赖，可并行 |
| T4 持久会话派发层 | 会话 Map + 增量消息 + 降级 + close 管理 | 依赖 T1（动态段复用）；唯一触及 agent 生命周期管理的任务，独立拆出集中审查 |

## 11. 待验证检查点

- ⛔ P-cache：主用 provider 是否支持前缀缓存（S5 探测）；不支持则 6.1 收益归零（但保留改动，无害）。
- ⛔ P-cache-shared：批内多 reviewer 共用静态段时缓存是否跨 agent 命中（OpenAI 论坛有报告称多 agent 不同前缀互相驱逐，单源低置信——实测为准）。
- ⛔ P-persist：持久会话 token 拐点（≤3 轮稳赢的假设）；≥3 个真实 run 对照数据前禁止改默认值。
- ⛔ P-compact：轮末锚定压缩在本场景的质量保持度（30 轮省 67% 是外场景数据）。
- ✅ 已核实：pi subagent 支持 conversation:true/message/close（本会话工具契约）；现状 prompt 轮次 header 在最前（脚本源码实测）。

## 附录：变更历史

- v1：初版。关键外部证据——arXiv 2601.12307（单会话成本 ≤ 多 agent 公式）、arXiv 2601.06007（缓存实测 41-80%）、Claude Code issue #7317（subagent 无状态痛点）、Cursor Bugbot docs（patch-ID 去重）、CodeRabbit docs（增量审查默认）。
