# review-fix-loop 效率优化 梯队 2：prompt 前缀稳定化（含两个前置探针与一个被否决机制）

> **一句话结论**：梯队 2 收敛为一件可实施的事——把 reviewer 的各轮 prompt（含 system 段的 schema 注入）做成跨轮逐字节稳定，为多 provider 环境下的潜在缓存命中铺路；v1 的「diff 指纹跳轮」机制经审查证明自相矛盾且会漏审真实变更，**否决**；「持久 reviewer 会话」在 workflow 沙箱里无 API 支撑且无缓存时严格更贵，**降级为条件触发的引擎级议题**，不在本文档实施范围。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 批内每轮经 workflow 脚本的 `agent()` 全局派发 reviewer subagent；每轮 prompt 由脚本拼装（R1 全量指令 / R2+ 对账指令 / scoped 限定指令三个模板）。运行环境是多 provider（kimi/minimax/deepseek 等），provider 是否支持前缀缓存未知。
- **C（冲突）**：每轮新 spawn 的 reviewer 重复支付静态上下文（角色 + 审查规则 + schema 指令 + 侦查读文件）。但 v1 设计经对抗式审查发现三个翻案级事实：① 变化内容（轮次 header、roundDir）在 prompt 最前，缓存视角最坏排列；② schema JSON 逐字嵌入 system prompt（agent-opts-resolver.ts 的 appendSystemPrompt 注入），而 R1 与 R2+ 的 schema `required` 不同（reconciliation 字段），**system 段字节必然不同**——只重排 user prompt 达不到逐字节稳定；③ workflow 沙箱的 `agent()` 字段白名单（worker-script-builder.ts `_KNOWN_FIELDS`）没有 conversation/message/close，唯一 runner 是一次性 SubprocessAgentRunner——持久会话机制在 API 层面不存在。
- **Q（问题）**：在「不改动 workflow 引擎」的约束下，哪些上下文复用是真实可落地的？哪些必须先拿探针数据再决策？
- **A（答案）**：落地范围收敛为——统一全轮次 schema（reconciliation 恒必填，R1 填空数组）+ 统一三个模板的静态段文本，使同一 reviewer 跨轮的完整 prompt（system + user）逐字节稳定；配套两个探针（provider 缓存探测 P-cache、system 段动态因子探测 P-sys）拿事实；持久会话与指纹去重分别降级与否决，决策依据记录在案。

## 1. 背景：被设计的系统是什么

**本章结论：本次设计聚焦 reviewer prompt 的「跨轮字节稳定性」；v1 的三个机制一个保留（修正后）、一个否决、一个移出。**

review-fix-loop 结构见梯队 1 文档 §1，本文自包含要点：每轮 `buildReviewCall` 构造 prompt 后经脚本内 `agent()` 派发；subagent 的 system prompt 由主线程组装——reviewer 角色 .md 内容 + schema 结构化输出指令（schema JSON 逐字 stringify 后进入 appendSystemPrompt，源码：`src/orchestration/agent-opts-resolver.ts`）+ env block（拼在 appendSystemPrompt 最前）等因子共同构成；user prompt 是脚本拼装的审查指令。派发面白名单（源码 `src/orchestration/worker-script-builder.ts`）：

```
_KNOWN_FIELDS = ["prompt","description","schema","model","scene","label","task","agent",
                 "phase","skill","timeoutMs","cwd","fork","worktree","returnMeta","thinkingLevel"]
```

——无 conversation/message/close 字段；`agent()` 的执行实现是一次性子进程 runner。

**层声明**：当前层 = 技术方案设计；下一层 = 实现任务（prompt 模板统一 + schema 统一 + 探针脚本）。涉及运行时行为断言，准则 5/6/7 全适用——缓存命中与 system 段稳定性**一律 ⛔ 探针**，不以推理声称。

## 2. 设计目标

**本章结论：改造后同一 reviewer 跨轮的 prompt 逐字节稳定（workflow 可控范围内），provider 缓存事实被探明，两个被否/降级机制有决策记录。**

1. **轮内一致**：同一 run 内同一 reviewer 的 R1/R2+/scoped 各轮，完整 prompt 的静态段（system 段含 schema 指令 + user 段静态文本）逐字节相同；变化内容（轮次号、roundDir、对账数据、fix 结果）全部位于尾部动态段。
2. **缓存事实探明**：主用 provider 是否支持前缀缓存、env block 等 system 段因子是否逐 spawn 变化——两个 ⛔ 探针给出确定性结论。
3. **决策留痕**：diff 指纹跳轮（否决）与持久会话（降级为引擎级议题）的决策依据写入本文档，未来重评估不需要重做这个分析。

**In-scope**：review-fix-loop 的三个 prompt 模板统一、reviewerSchema 全轮次统一、两个探针脚本。**Out-of-scope**：subagent-workflow 引擎改动（_KNOWN_FIELDS / runner / 会话服务——持久会话若重启需另立引擎级设计）；provider 侧缓存配置；diff 指纹（已否决）；梯队 1/3 覆盖项。

## 3. 现状：使用者眼里是什么样的

**本章结论：三个 prompt 模板各自为政、变化内容靠前、schema 跨轮分叉——同一 reviewer 的相邻两轮 prompt 从第一个字节起就不同。**

### 3.1 现状的真实样子

R1 prompt 拼装（脚本 `buildReviewCall` 真实代码）：

```js
prompt: [
  header,            // "Batch 1 Round 1/10 — xxx"（每轮变化，在开头）
  reviewInstruction + prevBatchesHint,
  "Review requirements:", reviewPrompt,
  "output 路径：" + roundDir + "/" + def.report + ".md",   // roundDir 每轮变化
].join("\n")
```

R2+ 走 `buildR2ReviewPrompt`、scoped 走 `buildScopedRecheckPrompt`——三个模板独立演化，静态文本（审查要求、输出说明）措辞互不相同；schema 分叉（脚本真实代码）：

```js
// R1：reviewerSchema 原样
// R2+/scoped：{ ...reviewerSchema, required: [...reviewerSchema.required, "reconciliation"] }
```

而 schema JSON 会被逐字 stringify 注入 system 段（agent-opts-resolver.ts）→ **R1 与 R2+ 的 system prompt 字节不同**，user prompt 静态段也不同。双重不稳定。

### 3.2 怎么出错

- **A 静态内容逐轮全价重付**：若 provider 支持缓存（Anthropic 缓存读 0.1x、OpenAI exact-prefix 自动缓存），现状排列命中率为零——断点前任何字节变化使整段前缀失效。实测参照：长程 agentic 任务开缓存省 41-80%（arXiv 2601.06007，跨 4 模型）。
- **B 无事实的乐观/悲观**：主用 provider 是否支持前缀缓存、env block 是否逐 spawn 变化，均无实测——设计无法回答「前缀稳定化在这条技术栈上值多少钱」。

### 3.3 根因

三个 prompt 模板与 schema 分叉都是功能迭代的自然产物（每轮次需求不同就各写一个构造函数），从未以「跨轮字节稳定」为设计约束。这不是疏忽而是约束未被提出过——本设计把这个约束显式化并用快照测试守护。

## 4. 根因 + 物理数据流

**本章结论：prompt 字节在三个层产生（引擎组装的 system 段 / 脚本拼装的 user 段 / provider 侧缓存判定），前缀稳定化必须三层同时对齐，只做 user 段等于没做。**

```
reviewer .md（角色）+ reviewerSchema（结构化输出指令）+ env block
  ↓ 主线程 agent-opts-resolver / session-runner 组装        ← 层 1：system 段
    schema JSON 逐字嵌入 appendSystemPrompt（已核实）
    【对齐点 a】schema 全轮次统一（reconciliation 恒必填）
    【探测点 P-sys】env block / tools 清单是否逐 spawn 变化
脚本 buildReviewCall / buildR2ReviewPrompt / buildScopedRecheckPrompt
  ↓ 拼装 user prompt                                        ← 层 2：user 段
    【对齐点 b】三模板统一静态段文本 + 动态段一律后置
provider API                                                ← 层 3：缓存判定
  ↓ exact prefix match（Anthropic/OpenAI 官方文档机制）
  【探测点 P-cache】主用 provider 是否返回 cached_tokens / 等效字段
缓存命中：静态前缀只付缓存读价（约 0.1x，Anthropic 官方定价）
```

> **逐字节稳定** = 同一 run 内同一 reviewer 的相邻两轮，从 prompt 首字节到「动态段起点标记」之前，diff 工具输出为空。就是 §3.1 例子里 header/roundDir 从现在它们所在的位置消失（移到动态段）之后的样子。
> **动态段起点标记** = 静态段末尾一行固定文本（如 `--- ROUND CONTEXT ---`），其后才允许出现轮次号/路径/对账数据。它是快照测试的断言锚点。

## 5. 终态：使用者眼里将是什么样的

**本章结论：调用方式与终止行为完全不变；变化不可见，收益在 token 账单与探针报告里。**

### 5.1 成功路径

```
[用户] workflow run review-fix-loop --args targetType=git-diff target=main batch1="..."（参数与现状一致）
[后台] R1/R2/R3 的 reviewer-a prompt：静态段逐字节相同；轮次号、roundDir、对账表全部在
       "--- ROUND CONTEXT ---" 标记之后
[探针] P-cache：对主用 provider 发两轮相同前缀请求 → 读 usage.cached_tokens（或等效字段）
       → 结论「支持/不支持」写入 run 日志与本文档附录更新
[探针] P-sys：dump 同一 reviewer 两轮的完整 system prompt → diff 为空（或定位动态因子）
```

### 5.2 失败路径（带恢复指引）

- **P-cache 结论为「不支持」**：前缀稳定化在当前 provider 上无直接收益。改动保留（纯重排 + schema 统一，无行为回归），持久会话议题直接关闭（无缓存时持久会话重放增长历史，严格更贵——学术公式 C_single ≤ C_multi 的前提是 KV/前缀缓存存在，arXiv 2601.12307）。👉 无需操作，决策记录已含此分支。
- **P-sys 发现 system 段有逐 spawn 动态因子**（如 env block 含时间戳）：workflow 层无法修（引擎组装）。👉 记录因子清单，若因子可消除则另立引擎小改动 issue；不可消除则前缀稳定收益封顶于「同 spawn 内缓存」（收益归零，改动仍无害）。
- **快照测试在后续 PR 被破坏**：有人改了静态段文本导致快照失败。👉 测试失败即 CI 红，修复方式二选一：恢复静态段 / 显式更新快照并在 MR 描述声明「缓存前缀已失效重建仓」。

## 6. 关键决策与权衡

**本章结论：一个实施决策（前缀稳定化）+ 两个处置决策（指纹否决、会话降级）。**

### 6.1 前缀稳定化：三层对齐 + 快照守护

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| schema 统一 + 三模板静态段统一 + 动态后置（选） | 把「跨轮字节稳定」从隐式运气变为显式契约（快照测试守护）；无缓存 provider 上纯重排零代价 | 低-中：模板重构 + schema required 统一 + 快照单测 | R1 强制 reconciliation 字段（空数组）增加 reviewer 微量输出负担；system 段动态因子可能不在 workflow 控制面（P-sys 探测） | ✅ |
| 只重排 user prompt 段（v1 方案） | — | 低 | **审查证实不成立**：schema 分叉使 system 段字节不同，user 段三个模板静态文本也不同——只重排达不到稳定 | ❌ |
| 不做 | — | 零 | 有缓存的 provider 上继续全价（§3.2-A） | ❌ |

schema 统一的具体形态：reviewerSchema.required 恒含 reconciliation；R1 prompt 明示「首轮无前轮对账，reconciliation 返回空数组」。这是用 schema 语义统一换字节稳定——审查发现的 R1↔R2 schema 分叉因此消除。

### 6.2 diff 指纹跳轮：否决（v1 机制②）

v1 设想「fix 后 diff 指纹相同则跳过下轮 review」。审查证伪三条，全部成立：

1. **动机例子错误**：「只改注释」会改变 `git diff | sha1` 和 `git patch-id` 两者（patch-id 归一化空白但注释是内容字节）——指纹只会在「fix 产生零字节变化」时相同，而这种场景现实现的 stuck/收敛检测已覆盖。
2. **数据源自相矛盾**：autoCommit=true 时 fixer 已 commit，无参 `git diff` 恒空 → 永远判「无变更」→ 全跳过；`git diff <lockedBase>` 不含 untracked 文件 → fixer 新建文件时指纹不变 → **真代码从未被审**。v1 声称「误少审 by construction 不可能」为假。
3. **跨批误伤**：跳轮状态机未定义，batch 1 的指纹会让 batch 2 R1 被误跳过。

**裁决：否决，不实现。** Cursor Bugbot 的 patch-ID 去重适用于「同一 PR 多次 push」的持续流场景，与单 run 内循环的形态不匹配。零字节变化的 fix 轮由现有 stuck/converge 检测覆盖，无功能缺口。

### 6.3 持久 reviewer 会话：降级为条件触发的引擎级议题

v1 设想用 `conversation:true` 跨轮复用 reviewer 会话。审查发现两个根本性事实：

1. **API 不存在**：workflow 沙箱 `agent()` 的 `_KNOWN_FIELDS` 白名单无 conversation/message/close，唯一 runner 是一次性 SubprocessAgentRunner。v1 核实的 conversation 能力是 LLM 面向的 subagent **tool** 契约，与 workflow 脚本的 `agent()` 是两个层面。实施需先改引擎（白名单 + 会话型 runner + 生命周期管理），v1 声称的「不动引擎」同时破产。
2. **收益前提不存在于多 provider 现实**：学术成本公式 C_single ≤ C_multi 的前提是 KV/前缀缓存可复用；**无 provider 缓存时，持久会话每轮重放增长中的历史，严格比「新 spawn + 固定前缀」更贵**。主用 provider 缓存支持未知（P-cache 未探测前）。

**裁决：降级。** 触发条件（两者同时满足才另立引擎级设计）：P-cache 证明主用 provider 支持前缀缓存；且梯队 1 上线后真实 run 数据显示「R2+ 静态前缀重付」仍是 token 大头。v1 设想的轮末压缩（锚定式摘要）在 subagent 会话服务中同样无 API 支撑，一并移出。

### 6.4 减法门检

本梯队实施物刻意只剩一件半：模板/schema 统一（一件）+ 两个探针（半件）。v1 的三个机制两个被处置掉——设计变短、断言变少，但剩下的每条都站得住（准则 8）。

## 7. 实现机制（把终态落到代码层）

**本章结论：改动集中在 prompt 模板与 schema 定义；两个探针是独立脚本；不动引擎。**

| 文件 | 改动 |
|---|---|
| `workflows/review-fix-loop-utils.cjs` | 三个 build*Prompt 重构：共享静态段常量（审查要求/输出说明/角色指令文本单一来源）+ 统一动态段起点标记 + 动态内容（header/roundDir/对账/known-remaining/fix 结果）全部后置 |
| `workflows/review-fix-loop.js` | reviewerSchema.required 恒含 reconciliation（删除 R2+/scoped 分支的 schema 分叉拼装）；R1 prompt 增加「首轮 reconciliation 返回空数组」说明 |
| `src/__tests__/review-fix-loop-utils.test.ts` | 快照测试：同一 reviewer 三个轮次模板的静态段逐字节相同（动态段起点标记之前 diff 为空）；动态段内容变化不破坏静态段 |
| `scripts/probe-prompt-cache.mjs`（新增） | P-cache：对指定 provider 发两轮同前缀请求，读 usage.cached_tokens（或等效字段），输出支持/不支持结论 |
| `scripts/probe-system-prompt-stability.mjs`（新增） | P-sys：同一 reviewer 连续两 spawn，dump 完整 system prompt 比对，定位动态因子（若有） |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：小-中改动（prompt 结构 + schema 统一，无行为变更），验收以「静态段 diff 为空 + 探针结论落地」为核心。**

### 8.1 改动规模

小-中：无循环行为变更；schema required 统一影响 R1 reviewer 输出格式（多空数组字段），prompt 文本重排。两个探针是新增脚本。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 跨轮字节稳定 | 目标 1 | 真实 run（≥2 轮，xyz-agent 仓真实 PR）+ 开启 `XYZ_AGENT_DEBUG=1` 落盘扩展日志；从日志/pi stdout jsonl 提取同一 reviewer 相邻两轮的完整 prompt（system 段 + user 段） | diff 工具比对：动态段起点标记之前逐字节相同；快照单测通过（回归辅助） |
| S2 P-cache 事实 | 目标 2 | 对当前主用 provider（如 kimi-coding）跑 `probe-prompt-cache.mjs` | 输出确定结论（支持/不支持/无法判定及原因）；结论追加到本文档附录 |
| S3 P-sys 事实 | 目标 2 | 跑 `probe-system-prompt-stability.mjs` | 输出「system 段逐 spawn 稳定」或动态因子清单；结论追加到附录 |
| S4 行为回归为零 | 目标 1 的护栏 | 同一真实 PR 在改动前后各跑一次 review-fix-loop（默认参数） | 两轮 run 的终止状态一致（clean/converged/stuck 同类）；R1 reviewer 报告含 reconciliation 空数组字段，下游 reconcile 逻辑无异常 |

## 9. 实施

**本章结论：一个里程碑交付全部——探针脚本可与模板重构并行。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | T1 模板/schema 统一 + 快照测试；T2/T3 探针脚本并行；T4 真实 run 验收（S1/S4） | 目标 1/2/3 全部 |

## 10. 下一层拆分

**本章结论：4 个任务，探针与主改动解耦。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 三模板静态段统一 + schema 统一 | utils 重构 + reviewerSchema.required 统一 + R1 空数组说明 | 核心交付物；schema 统一是 system 段稳定的前提，必须与模板同批 |
| T2 P-cache 探针脚本 | 独立脚本，不依赖 T1 | provider 事实决定后续所有缓存类议题的走向，尽早拿到 |
| T3 P-sys 探针脚本 | 独立脚本，不依赖 T1 | system 段动态因子若存在，T1 的收益预期要修正 |
| T4 真实 run 验收（S1/S4） | 依赖 T1 完成 | 真实场景验证，非单测 |

## 11. 待验证检查点

- ✅ P-cache（已探明，2026-08-20 实测）：扫描 ~400 份历史 pi session JSONL 的 usage 字段——本环境所有主用 provider 消息级缓存命中率 97-99%（glm-5.1/5.2、minimax-m3、ds-flash、deepseek-v4-flash、ds-pro、**mimo-router/mimo-v2.5-pro 97%**、kimi-for-coding）。前缀缓存在本环境事实上普及，前缀稳定化的收益前提成立。探针脚本（T2）仍保留，用于新 provider 接入时复测。
- ✅ P-sys（已探明，源码核实）：env block = 固定头行 + Working directory + 可选 Depth + 可选 Git branch（branchCache 按 cwd 缓存），**无时间戳等逐 spawn 随机因子**（session-runner.ts buildEnvBlock）；同一 run 内同一 cwd 的 env block 字节稳定。残余未知：tools 清单稳定性（实施期快照测试覆盖）。
- ⛔ P-shared：批内不同 reviewer（不同 .md → 不同 system prompt）天然无法跨 reviewer 共享缓存前缀——前缀稳定收益边界 = 「同一 reviewer 跨轮」。
- ✅ 已核实（源码）：`_KNOWN_FIELDS` 白名单无会话字段（worker-script-builder.ts:69）；schema JSON 逐字嵌入 appendSystemPrompt（agent-opts-resolver.ts）；R1/R2+ schema required 分叉（review-fix-loop.js）；现状模板 header/roundDir 靠前（review-fix-loop.js buildReviewCall）。

**P-cache/P-sys 转 ✅ 后对 6.3 的影响**：持久会话成本公式（C_single ≤ C_multi）的缓存前提在本环境成立，机制③ 的剩余门槛收敛为「引擎改动 + 梯队 1 实测数据显示静态前缀重付仍是大头」——P-cache 不再是阻塞项。

## 附录：变更历史

- v1：初版（前缀稳定化 + diff 指纹 + 持久会话试点三机制）。
- v2：对抗式审查后推倒重来——机制② diff 指纹否决（动机例子错误：注释改动改变哈希；autoCommit=true 下 git diff 恒空全跳过；untracked 文件漏判真变更；跨批误伤）；机制③ 持久会话降级为条件触发议题（workflow 沙箱 agent() 无会话 API，唯一 runner 是一次性子进程；无 provider 缓存时持久会话严格更贵）；机制① 保留但修正为「三层对齐」（schema 统一消除 system 段分叉 + 模板静态段统一 + 动态后置），验收方法从未定义的「dump prompt」落到具体日志路径。审查报告见同目录 `tier-2-context-reuse-review.md`。
