# review-fix-loop 效率优化 梯队 3：验证基建与流水化（沙箱验证 must-fix + 审查-修复流水线）

> **一句话结论**：梯队 3 是高收益高成本的两个结构性改动——Greptile TREX 式「每条 must-fix 先经确定性验证再进修复队列」从根上消灭假阳性轮次，Copilot 式「边审边修」流水化压缩 wall-clock；两者都与现有聚合步骤有架构张力，本文给出对比与推荐：**验证基建值得做（先做轻量版），流水化暂缓**。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 现状是严格串行三段：并行 review → aggregate 去重 → fix 全部 must-fix → 下轮重审（结构详见梯队 1 文档 §1）。梯队 1/2 解决的是「轮内更便宜、轮数更少」。
- **C（冲突）**：两个剩余结构性成本——① 假阳性 must-fix 进修复队列，修一个不存在的问题、下轮再审回来，白烧整轮；② 审查与修复墙-钟时间完全串行（总时长 = Σ审查 + Σ修复），而两者本可重叠。
- **Q（问题）**：能不能在修复前先确定性地验证 must-fix 是真的（挡假阳性），并让修复与审查时间重叠（缩总时长）？
- **A（答案）**：验证基建分两步走——轻量版（reviewer 自附可执行的复现脚本，fix 前批量执行过滤）先做，完整版（独立沙箱验证 agent）视轻量版数据再上；流水化经对比后**暂缓**——它与聚合去重步骤架构冲突，且收益被 scoped recheck（梯队 1）部分覆盖。

## 1. 背景：被设计的系统是什么

**本章结论：本次设计触及 review-fix-loop 的循环骨架本身——在 review 与 fix 之间插入确定性验证阶段，并评估把串行改流水的可行性。**

现状循环（脚本主循环真实顺序）：`parallel(review) → aggregate → [stuck/converge 检测] → fix → 下轮`。must-fix 从 reviewer 报告到 fixer 执行之间**没有任何客观验证**——reviewer 说「这里有空指针风险」，fixer 就去改。业界对照：

- **Greptile TREX**（官方博客）：orchestrator reviewer 发现疑似问题后，**每个 issue 派生一个专用验证 subagent，并行在沙箱里执行代码复现**；「doesn't start from scratch」（继承 orchestrator 上下文）；无法复现的发现不成 PR 评论。https://www.greptile.com/blog/trex-code-execution
- **GitHub Copilot code review**：审查结果分块增量发布——早期评论可见时整批审查尚未完成（社区二手观察，置信度 Moderate），修复可随首批结果开始。

**层声明**：当前层 = 技术方案设计（含架构决策）；下一层 = 实现任务。涉及运行时行为（沙箱执行、流水并发），准则 5/6/7 全适用，运行时断言一律 ⛔ 探针。

## 2. 设计目标

**本章结论：修复队列里的每条 must-fix 都有确定性验证背书；总时长压缩方案有明确数据支撑的做/暂缓结论。**

1. **假阳性挡在修复前**：must-fix 进 fix 队列前经可执行验证（跑测试 / 执行复现脚本 / 静态检查命令），验证失败的降级为 suggestion 并记录。
2. **验证成本可控**：验证本身不许比修复还贵——轻量版用 reviewer 自附的复现命令批量执行，单条验证有超时上限。
3. **流水化有结论**：用真实 run 数据评估「边审边修」的净收益，给出做/不做的决策记录（本文给出预判：暂缓，理由见 6.2）。

**In-scope**：review → fix 之间的验证阶段设计、流水化可行性评估。**Out-of-scope**：梯队 1/2 已覆盖项；沙箱基建的完整实现（镜像、隔离、资源配额——若走到完整版另立设计）；对 fallow 静态分析批次的改造（它已是确定性前置）。

## 3. 现状：使用者眼里是什么样的

**本章结论：must-fix 从「reviewer 声称」到「fixer 动手」之间没有客观关卡；三段完全串行。**

### 3.1 现状的真实样子

聚合到修复的衔接（脚本真实代码逻辑）：

```js
// Aggregated: N must-fix → 直接进入 Fix 阶段
phase("Fix");
const fxRaw = await agent({
  prompt: buildFixPrompt({ header, reportContent, fixPrompt, commitInstr, ... }),
  ...
});
// ES3 硬校验：must-fix 必须全进 fixes[]（漏修判 violation → fix-failure 终止）
```

ES3 校验保证「报了必须修」，但没有「报的对不对」的关卡。时间轴形态：

```
|── review(并行, 慢) ──|── aggregate ──|── fix(慢) ──|── review ──|── ... ──|
                     总时长 = 各段之和，段间无重叠
```

### 3.2 怎么出错

- **A 假阳性整轮成本**：reviewer 报了一个不存在的问题（误读代码 / 幻觉）→ fixer 改了一个不需要改的地方（可能引入真问题）→ 下轮 reviewer 对新代码再报 → 一轮白烧还恶化。梯队 1 的证据门槛（CRITIC）挡「无证据」条目，但**有文字证据≠可复现**——reviewer 完全可以编一段看似合理的「grep 输出」。
- **B 串行时间墙**：审查（读大量文件，慢）与修复（改少量文件，相对快）串行。批内多 reviewer 并行完成后，fix 才开始；若首个 must-fix 在第 2 分钟就确定，也要等到第 20 分钟审查全结束。

### 3.3 根因

循环的信任模型是「reviewer 说了就算」——LLM 声称直接驱动写操作。Huang et al.（ICLR 2024）证明无外部 ground truth 的 LLM 互评循环会退化；CRITIC 的对策是让 critique 经由工具交互产生。梯队 1 把「证据」加进 schema 是第一步，但证据本身仍是 LLM 文本——**本梯队的根因对策是把证据变成「真实执行结果」**：不是 reviewer 说它跑了 grep，而是 workflow 真的跑了。

## 4. 根因 + 物理数据流

**本章结论：在 review→fix 之间插入「确定性验证」数据流环节；验证输入来自 reviewer 自附的可执行脚本，输出决定 must-fix 是否进修复队列。**

```
reviewer 报告（新增可选字段 repro_command: 复现该问题的可执行命令，如 "pnpm vitest run test/auth.test.ts"）
  ↓ aggregate（现有去重逻辑不变）
must-fix 清单 + repro_command
  ↓【新增】verify 阶段：workflow 逐条 spawn 执行（非 LLM，child_process），超时上限 N 秒
  ├─ 命令按预期失败（复现成功 = 问题为真）→ 保留 must-fix，验证输出附进 fixer prompt
  ├─ 命令通过 / 报错与描述不符（复现失败 = 疑似假阳性）→ 降级 suggestion，state.json 记 origin-verify-failed
  └─ 无 repro_command → 维持梯队 1 的证据门槛规则（有文字证据保留，无则降级）
  ↓
fix 阶段（输入 = 已验证的 must-fix + 真实验证输出）
```

> **确定性验证** = 由 workflow 引擎（而非 LLM）执行 reviewer 提供的命令并观察真实退出码/输出。就是 §3.2-A 里「reviewer 编的 grep 输出」会被戳穿的机制——编的命令跑不出编的结果。

物理安全约束（设计红线）：`repro_command` 是 LLM 生成的命令在主仓库真实执行——**必须限制为只读/测试类命令**。下一层实现时的形态：命令白名单正则（`pnpm vitest*` / `pnpm tsc*` / `grep*` / `fallow*` 等）+ 拒绝写操作命令（`rm`/`>`/`git push` 等）；超出白名单的命令不执行、按「无 repro_command」处理并 WARN。⛔ P-safety：白名单绕过测试（实施期门——构造 10 个对抗命令验证全被拒）。

## 5. 终态：使用者眼里将是什么样的

**本章结论：run 日志里多一个 verify 段；修复队列变小变真；总时长变化待流水化评估结论。**

### 5.1 成功路径

```
[run 日志] Round 1: Aggregated: 5 must-fix + 3 suggestion(s).
[run 日志] Verify: 5 must-fix, 3 with repro_command
           MF-1: repro "pnpm vitest run test/session.test.ts" → FAIL as described ✓ verified
           MF-2: repro "pnpm tsc --noEmit" → FAIL as described ✓ verified
           MF-3: repro command rejected by whitelist ("curl ...") → falls back to evidence rule
           MF-4: repro passed (no failure observed) → downgraded to suggestion [verify-failed]
           MF-5: no repro_command, has text evidence → kept
[run 日志] Fix round 1: 4 verified must-fix（fixer 拿到 MF-1/MF-2 的真实失败输出，定位零侦查）
```

### 5.2 失败路径（带恢复指引）

- **真问题被误降级**（repro 脚本写错/环境问题）→ 条目在 suggestion 区可见，下轮 reviewer 可带修正后的 repro 复活（复用梯队 1 复活通道）。state.json 的 verify-failed 计数若持续偏高 = reviewer prompt 的 repro 写作指引需改进。👉 观察指标：`origin=verify-failed` 占比 > 30% 时排查。
- **verify 阶段拖慢整体**（每条 repro 跑全量测试）→ 超时上限截断（默认 120s/条，参数可调），超时按「无法验证」处理不降级。👉 恢复：调 `--args verifyTimeoutMs=30000` 或只对 critical 强制验证。
- **沙箱逃逸焦虑**（用户不信任 LLM 生成命令）→ `verifyMode=off` 整段关闭，回到梯队 1 纯证据门槛。默认开但白名单收紧。

## 6. 关键决策与权衡

**本章结论：验证基建分两步走（轻量版先行）；流水化经对比暂缓——两个决策一正一缓。**

### 6.1 must-fix 确定性验证：轻量版 vs 完整版

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 轻量版：reviewer 自附 repro_command + workflow 白名单执行（选） | 无新 agent、无沙箱基建；验证数据（verify-failed 率）为后续决策供血 | 中：schema 字段 + 白名单执行器 + 超时 | LLM 生成命令的安全面（白名单 + 只读限制收敛）；repro 质量参差 | ✅ 先行 |
| 完整版：TREX 式独立验证 agent（每 issue 一个沙箱 agent 自主复现） | 验证能力最强（可写探针代码、多步复现）；假阳性拦截率最高 | 高：沙箱基建（隔离/配额/镜像）+ 每 issue 一个 agent 的成本 | 基建重；验证 agent 本身也烧 token | ⏸ 视轻量版数据 |

**推荐逻辑**：轻量版的 verify-failed 率是完整版的决策输入——若真实 run 中假阳性占比 <10%，完整版的高成本收不回；若 >30%，完整版值得立项。这符合准则 8（减法优先）：先用最小机制拿到数据。

与梯队 1 的关系：梯队 1 证据门槛是「文本层诚实」，本决策是「执行层真实」，后者是前者的加强版而非替代——无 repro_command 的条目仍走证据规则。

### 6.2 审查-修复流水化：暂缓

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 维持串行 + 梯队 1/2 减轮（选） | 聚合去重步骤完整保留；架构简单 | 零（已在前两梯队投入） | 总时长仍有一段不可重叠 | ✅ |
| 边审边修（首个 must-fix 确定即派 fixer） | 理论总时长从 Σ审+Σ修 压向 max(审,修) | 高：reviewer 结果流式化 + 修复与后续审查的并发文件冲突管理 + 聚合去重被绕过 | **与 aggregate 去重架构冲突**：先修的条目可能正是后续 reviewer 重复报的（去重信息缺失）；fix 改了文件后后续 reviewer 审的是移动目标，diff 基线漂移（现实现的 base 锁定机制被击穿） | ❌ 暂缓 |

**暂缓而非否决的理由**：流水化的真实收益取决于「审查时长占比」——梯队 2 的持久会话 + 梯队 1 的 scoped recheck 上线后，审查轮本身已大幅缩短，流水化省的是缩水后的段落。决策触发器：梯队 1/2 上线后真实 run 的「审查段时长占比 > 60%」时重新评估本文档。

**被否若用**：§5.1 的流程会变成——MF-1 边修、reviewer-b 还在审被 MF-1 修改中的文件、R2 的对账基线（lockedBase）与文件实际内容脱节，对账表大面积 regressed 误报。

## 7. 实现机制（把终态落到代码层）

**本章结论：轻量版验证的全部改动在 workflow 脚本内 + 一个命令白名单执行器；不引入新 agent。**

| 文件 | 改动 |
|---|---|
| `workflows/review-fix-loop.js` | 聚合后、Fix 前插入 verify 段：遍历 agg.must_fix_ids 对应报告的 repro_command → 白名单过滤 → `child_process.spawn` 执行（超时默认 120s，参数 `verifyTimeoutMs`）→ 按退出码与输出比对决定保留/降级；state.json 记 verify 结果；`verifyMode` 参数（on/off，默认 on） |
| `workflows/review-fix-loop-utils.cjs` | 新增 `matchWhitelist(cmd)` 纯函数（白名单正则表 + 写操作黑名单正则表）；`buildVerifyResult(...)`；reviewer prompt 模板增加 repro_command 写作指引（「给出能复现该问题的最小命令，优先测试命令」） |
| reviewerSchema | must-fix 条目增加可选 `repro_command`（string） |
| `src/__tests__/review-fix-loop-utils.test.ts` | 白名单单测：放行 `pnpm vitest run x.test.ts` 等；拒绝 `rm -rf`、`curl | sh`、`git push`、`echo x > file` 等 ≥10 个对抗样本（⛔ P-safety 的单测形态） |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：中改动（新增 verify 段 + 安全面），核心验收是「假阳性被真实拦截」和「真问题不被误伤」。**

### 8.1 改动规模

中：新增一个流水线阶段 + schema 字段 + 执行器。不改循环骨架。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 真问题验证通过 | 目标 1 | xyz-agent 仓造一个真实 failing test 场景的 PR（已知 bug + 对应测试），跑 review-fix-loop | 该问题的 repro_command 被执行、复现成功、保留在修复队列；fixer 输入含真实失败输出 |
| S2 假阳性被拦截 | 目标 1 | 同一 run 中若 reviewer 报了无法复现的问题（或人工构造：给 reviewer 一份含幻觉倾向的 diff） | verify-failed 条目出现在 suggestion 区且带「repro 未复现」标注；不进入 fixes[] |
| S3 白名单安全 | 目标 2（红线） | 实施期 ⛔ P-safety：构造 ≥10 个对抗命令（写文件/网络/删除/git 写操作）走 matchWhitelist | 全部拒绝执行并 WARN；零逃逸 |
| S4 超时不拖死 | 目标 2 | 构造一条跑全量测试的 repro（>120s） | 120s 截断、按「无法验证」处理、run 继续不中断 |
| S5 关闭开关 | 目标 2（护栏） | 同一 PR 加 `verifyMode=off` 重跑 | 行为回到梯队 1 证据门槛模式，verify 段日志消失 |

## 9. 实施

**本章结论：验证轻量版一个里程碑交付；流水化不产生实施任务（仅保留决策记录）。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | reviewer schema/prompt 增加 repro_command + 白名单执行器 + verify 段 + state 记录 | 目标 1/2 |
| M2（条件触发） | 真实 run 积累 verify-failed 率数据后，评估完整版沙箱立项 | 决策输入 |

## 10. 下一层拆分

**本章结论：拆成 3 个实现任务。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 matchWhitelist + 对抗单测 | 纯函数 + ≥10 对抗样本 | 安全红线独立成任务，先交付先审查 |
| T2 schema + reviewer prompt repro 指引 | 字段 + 写作指引 | 决定 repro_command 产出质量；与 T1 无依赖可并行 |
| T3 verify 段主循环集成 + state 记录 + 超时/开关 | 脚本改动 | 依赖 T1/T2 都就绪 |

## 11. 待验证检查点

- ⛔ P-safety：白名单对抗测试（S3，实施期门，不通过不交付）。
- ⛔ P-repro-quality：reviewer 产出的 repro_command 可用率（多少条能真实执行出结果）——决定轻量版是否达到「挡假阳性」的设计意图；数据从 M1 后真实 run 的 state.json 统计。
- ⛔ P-fp-rate：假阳性占比（verify-failed 率）——完整版沙箱的立项触发器（<10% 不立项，>30% 立项，中间看成本感受）。
- ⛔ P-pipeline：梯队 1/2 上线后审查段时长占比是否仍 >60%——流水化重评估触发器。
- ✅ 已核实（源码）：聚合→Fix 之间无验证环节；ES3 只校验「报了必须修」不校验「报的对不对」。

## 附录：变更历史

- v1：初版。关键外部证据——Greptile TREX 官方博客（沙箱验证 agent）、CRITIC（arXiv 2305.11738，工具交互 critique）、Huang et al. ICLR 2024（无外部信号互评退化）、Copilot code review 分块发布（社区观察，Moderate）。
