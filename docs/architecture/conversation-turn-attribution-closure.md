# 对话流遗留项收尾（conversation-turn-attribution-closure）

> **一句话结论**：主设计（conversation-turn-attribution）W1-W6 实施后遗留 6 项，经产品裁决：L4（steer 插话视觉降级）**不修**——插话显示为完整提问气泡是合理的产品语义；其余 5 项全修——2 项登记例外（bash abort 分歧 / compaction 窄差异）经本轮探针证实可低成本消灭、2 项技术债（executingBash 分区 / 注释编号）清理、真机验收（V1-V6）排进执行序列闭合设计 DoD。修完后登记例外清单从 4 项收敛到 1 项（stream_warn liveOnly——pi 不为健康警告写 entry，物理事实不可消除）。

## §1 背景目标

**SCQA**：

- **S（情境）**：主设计九个 commit（a28fb6238…f9956d113）已落地：分组边界规则集 v2、bash/user/custom/compaction 全类型 live entry 化、load-more 锚定切分、trigger turn 渲染。四包测试全绿，登记表 #7 记录终态 + 4 项例外。
- **C（冲突）**：① 设计 §4 的 V1-V6 真机验收**一个都没跑**（上轮只完成了单测级验证）——设计的 DoD 未闭环；② 4 项登记例外中 2 项（bash abort 分歧、compaction 窄差异）经本轮 0.84.1 dist 探针证实**修复成本远低于当初评估**（各约一个 if 量级的改动），维持登记是欠账而非必要取舍；③ 2 项技术债（executingBash 模块级 Map 未接统一 cleanup、注释引用已废弃规则编号）待清。
- **Q（问题）**：主设计的完成度停在「代码合入 + 单测绿」，距离「验收过 + 无已知可消除的 live≠reload 差异」还差一步。
- **A（答案）**：本设计对遗留逐个裁决（修 / 不修 / 怎么修），给出收尾 wave 拆分与真机验收执行计划。

**与主设计的关系**：本设计是主设计的收尾层，不改变其任何已落地决策（边界规则集 / entry 化 / 锚定切分全部继承）。读者需先了解主设计 §2.2 的消息链路（event-adapter → registry → applyEntryFrame reducer → message-turns 分组）。

### 遗留问题清单（全部来源可追溯）

| # | 遗留项 | 来源 | 本设计裁决 |
|---|--------|------|-----------|
| L1 | V1-V6 真机验收未执行 | 主设计 §4（DoR 门槛承诺） | **修**（D5，F4 执行） |
| L2 | bash abort 分歧：live 无消息 / 文件有 cancelled entry | 登记表 #7 例外① | **修**（D1） |
| L3 | compaction summary-less 窄差异：live 无 / reload 有 fallback 行 | 登记表 #7 例外④ | **修**（D2） |
| L4 | steer 插话视觉降级（主设计 D1b deferred） | 主设计 §3.3 D1b | **不修**（产品裁决 2026-08-20：插话显示为完整提问气泡是合理语义，插话本质就是用户输入，独立成组呈现无误。探针存档见 §2.3） |
| L5 | executingBash 模块级 Map 未接 session 删除 cleanup | bash-effects.ts:40-43 自认迁移欠账 | **修**（D3） |
| L6 | 代码注释引用已废弃的「规则 7.5」编号（12+ 处） | AGENTS 编号演进遗留 | **修**（D4） |

不修项（显式排除）：L4（如上，产品裁决）；stream_warn liveOnly（例外②）——pi 对健康警告不写任何 entry，live 消失是物理事实，`liveOnly` 标记已是终态；executingBash ephemeral 形态本身（例外③）——设计形态非缺陷，D3 只修其生命周期挂接。

**设计目标**：

| # | 目标 | 使用者可见行为 |
|---|------|--------------|
| G1 | abort 后重开不再多出记录 | streaming 中 `!` bash 后 abort：live 出现 cancelled 记录（与 pi 落盘一致）；重开分组与内容一致，不再「重开后突然多一条」 |
| G2 | compaction 无摘要时两侧一致 | summary 缺失的 compaction：live 与重开都出现「上下文已压缩」fallback 行（现状 live 无、重开有） |
| G3 | 收尾不引入新的多源真相 | 每项改动过登记表演进规约，不新增第二份持久化或影子缓存 |
| G4 | 主设计验收闭环 | V1-V6 + 本设计新增场景在 dev app / 本地 pi CLI 真机跑过并记录 |

**In-scope**：L1/L2/L3/L5/L6 的方案与拆分；等价性测试族更新（E3 改判 / E4 补用例）。
**Out-of-scope**：pi 侧任何行为（[MANDATORY] 不修改 pi 源码）；steer 插话视觉（L4 产品裁决不修，见 §2.3）；thinking 档波动 / bash 流式渲染（governance 线 deferred，非本线遗留）。

## §2 现状与问题分析

（本章全部 pi 侧断言对 node_modules 实装 0.84.1 dist 实测，行号即锚点。）

### 2.1 L2：bash abort 分歧的精确机制

现状帧序（streaming 中 `!` bash 后用户点 abort）：

```
xyz runtime                              pi 进程
─────────                              ────────
sendBash: await client.bash(...)
  myToken = activeSession.bashRunToken
                                       bash 执行中；abort_bash RPC 到达
                                       → bash-executor catch signal.aborted
                                         → return {cancelled:true, output:部分输出, …}
                                         → executeBash 返回（不 throw）
                                       → recordBashResult 照跑
                                         → appendMessage(bashExecution cancelled) 落盘 ✅
abortBash: await client.abortBash()
  finally: 旋转 bashRunToken（≠ myToken）
  广播合成帧 bashResult{command:'', cancelled:true}   ← 哨兵帧
sendBash await 正常 resolve（cancelled result 全量数据）
  :339 guard myToken !== bashRunToken → 「skip duplicate terminal」
  → 真实 cancelled 数据被丢弃 ❌                      ← 丢弃点
```

- pi 侧事实：`core/bash-executor.js:86-109`——abort 时 catch `signal.aborted` 分支 **return cancelled 结果而非 throw**；`recordBashResult` 对 cancelled 无分支照常落盘（主设计探针已锚定）。故 xyz 的 `await client.bash()` 在 abort 后**正常 resolve**，catch 路径（dispatcher :371）只在 transport 断 / pi 死时触发——主路径是 :339 的正常分支。
- xyz 丢弃的理由是「防双终态」：abortBash 已广播一条合成 cancelled 终态。但 W1 之后两条帧职责已正交——合成帧（`command:''`）被 bash-effects.ts:124-127 识别为哨兵，**只清 executingBash 态、不产 entry**；真实帧产 entry。两帧都到达时各自幂等，双终态担忧不成立。**guard 旋转机制本身保留**（catch 分支诊断 + 防旧 sendBash 误写新 bash 的 token 复位仍需要它），只解除正常分支对发布的一声「skip」。

用户所见问题（G1 反面现状）：abort 后 live 干净（无 bash 记录），重开 session 后**突然多出一条 cancelled bash 记录**，且位置在级联末——「重开前后不一致」的机制 4 残余形态。

### 2.2 L3：compaction 窄差异

- `event-interpreter.ts` `handleCompactionEnd`：`if (r.summary)` 真值门——summary 缺失的**成功** compaction 不发 `message.compactionSummary` 帧 → live 无消息。
- pi 侧事实：手动（agent-session.js:1414 → :1432）与 auto（:1654 → :1670）两路都**无条件** `appendCompaction(summary, …)` 落盘；summary 来源是 LLM 结果或 extension 提供（`compactResult.summary` / `extensionCompaction.summary`），缺失形态为 `undefined`（字段缺失，非空串）。
- replay 侧：`apply-entry.ts:543-551` compaction case 的 `summary ?? '上下文已压缩'` fallback 已就绪；live 侧 registry handler（registry.ts:503-530）也已按 `summary !== undefined` 条件展开构造 entry——**全链路只差 interpreter 那一个真值门**。修复 = 删门（帧照发、summary 字段缺省），两侧同走 reducer fallback，差异消灭。
- 空串陷阱（实施审查 MF-1 修正原论证）：若 LLM 异常返回 `''`，pi 落盘 entry 与 live 帧同值 `''`，且 `'' ?? fallback` 两侧都不触发——但**前提是 live 链中转门不丢空串**：原设计论证漏算了 `readCompactionSummary` 的 truthiness 门（`if (s)` 会把 `''` 丢成 undefined 走 fallback，制造两侧内容级分叉）。实施修复 = readers 门改 `s !== undefined`（空串透传，readBranchSummary 同型门一并修），`undefined` 与 `''` 两种形态自此各自两侧同值同路径（E4b/E4c 锁定）。

### 2.3 L4：steer 插话视觉——裁决记录（不修）

**现象**：agent streaming 中用户插话（steer），当前显示为完整 user 提问气泡，与普通新提问无视觉区分。主设计 D1b 曾将其列为 deferred（设想「视觉降级为 turn 内插话」，阻塞于「pi entry 无标记」）。

**裁决（2026-08-20，产品决策）**：不修。插话本质是用户真实输入，独立成组、以完整提问气泡呈现是**合理的语义**——主设计 D1 的定案（steer 开新 turn 是两侧可一致推导的最大公约数）本就成立，无需视觉降级。

**探针存档**：本轮已探明若未来重启该需求的完整技术通路（pi RPC 面无 appendEntry、extension `pi.appendEntry` 是唯一合法 custom entry 写入通路、steer RPC 不触发 input hook 但 drain 经 runPromptMessages 走同一 finalize 链故 message_end 必触发、message_end hook 可 replace 即将落盘的消息）——完整事实表与链路设计见本文件的 git 历史（3361d74ff 版本 §2.3/§3.3 D1），此处不占用正文。

### 2.4 L5：executingBash 的 cleanup 缺口

`bash-effects.ts:58` `executingBashMap` 是模块级 Map（taste 豁免 W24-EX-B，登记草稿）。文件头注释（:40-43）自认「W2 落地后可随 store 分区槽统一迁移」——W2 已落地，欠账未清。实际缺口不止风格：ADR-0049 的 cleanup 编排（`useSidebar.deleteSession` 统一清理 session 分区状态）**够不到模块级 Map**——删除 session 后若存在未完成 bash，该槽永久残留（量级：一条 `{command, startedAt}` 对象，泄漏极小但违反「cleanup 统一编排」纪律，且豁免登记是草稿状态）。

### 2.5 L6：编号漂移

AGENTS.md 的「对话流状态实时可见」规则现为关键规则 #9，但 12+ 处代码注释与测试名仍引用旧编号「规则 7.5」（apply-entry.ts:388、session-history.ts:7/:92、entry-tree-builder.ts:15、use-session.ts:51、session-entry-mapper.ts:6 及 4 个测试文件）。语义指向一致，纯编号漂移——按 AGENTS 纪律（注释解释为什么且准确）应清理。

### 2.6 L1：验收欠账

主设计 §4 定义了 V1-V6 六个真机场景 + final gate（V1/V2/V4 打包链复跑），实施记录 §6 只完成了 V7（等价性测试）——**V1-V6 全部未执行**。设计的验收承诺（「实施完成后在真实场景验证」）未兑现，本设计将其排入收尾 wave 并扩充新场景。单测绿 ≠ 真的好用：单测验证「代码符合设计的假设」，真机验证「假设在真实 pi 上成立」——主设计 W2 的 appendUser 双计 bug 即单测全绿、被真实 pi 等价性测试（W22）捕获的先例。

### 2.7 根因归纳

两项「当年登记、如今可修」的共同根因：**W1-W6 落地后，live 侧的基础设施（entry 化 reducer / 哨兵帧语义）比当初评估时更强**——abort 分歧的丢弃逻辑写于「bash 直插数组」时代（防双终态针对的是两条都产消息的帧），W1 后帧职责正交化使丢弃失去保护对象；compaction 的真值门写于「直插消息」时代（防 undefined 直插崩溃），W6 entry 化后 registry/reducer 已能安全消费缺省。**登记例外应随基础设施演进复审**——本设计即该复审。

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**：

1. （G1）streaming 中 `!` 跑命令后点 abort：对话流出现一条 cancelled bash 记录（turn 内 notice，含已产生的部分输出），重开位置与内容一致——不再「重开后多出一条」。
2. （G2）compaction 完成但无摘要（罕见）：live 与重开都出现「上下文已压缩」行。
3. 删除 session：其 ephemeral 执行态随分区清理，无残留。

**失败路径与恢复**：

- abort 场景 transport 抛错（pi 死 / 连接断）：维持现状哨兵语义（只清态不产 entry）——例外收窄登记（触发条件从「任何 abort」收窄为「abort 且 transport 抛错」）；无用户动作需要，错误帧按现状入流提示。
- compaction 失败路径（errorMessage 非空）：现状 interpreter hasError 分支（session.compacted{error} + message.error 进对话流）不受本设计影响。

### 3.2 方案对比（L2 / L3，二维评估）

| 项 | 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|------|--------------|-------------|------|------|
| L2 | 解除正常分支丢弃（发布真实 cancelled 数据） | 消灭登记例外①，live 侧数据源收敛为「pi RPC 返回原样转发」 | 一步改动（guard 分支改发布）+ E3 改判 | 帧职责正交已论证（§2.1），双终态不成立 | ✅ 解除 |
| L2 | 维持登记 | 例外留存，认知负担永续 | 零 | 无 | ❌ 无收益 |
| L3 | 删真值门（帧照发、summary 缺省透传） | 消灭登记例外④，两侧 fallback 已就绪（§2.2） | 一个 if 删除 + E4 用例 | 空串陷阱已排除（两侧同值同 fallback） | ✅ 删 |
| L3 | 维持登记 | 例外留存 | 零 | 无 | ❌ 无收益 |

catch 分支裁决（L2 边界）：维持哨兵（无真实数据可发布，合成会制造与文件部分输出的内容级差异——比「无消息」更糟）。

（L4 steer 插话视觉：产品裁决不修，无方案对比——裁决记录见 §2.3。）

### 3.3 关键决策

**D1：解除 abort 正常分支的丢弃（选择）**——影响 G1。

dispatcher `sendBash` :339-341 的 guard 命中分支从「warn + skip」改为「发布真实 cancelled 结果」（走既有双分支：streaming 压 pendingBashResults 等 settled flush——位置与 pi 落盘一致；空闲立即发布）。token 旋转机制保留（catch 分支 :371 诊断、finally :399 复位逻辑不变）。abortBash 合成哨兵帧（:466-481）职责不变（只清 executingBash）。**哨兵判定的隐式契约显式化（r3 审查补）**：bash-effects.ts:124 哨兵识别依赖「真实帧的 `command` 恒非空」（command 来自用户 `!` 输入的命令文本，sendBash 入口无空命令场景；哨兵帧独占 `command === '' && cancelled` 形态）——该约束目前是隐式成立，F1 实施时在 sendBash 入口补一行空命令早退守卫（空命令直接 return 不入流），使两类帧的区分从「约定」升级为「结构性不变式」。E3 等价性测试从「abort 例外锁定（差异恰为 cancelled entry）」改判为「abort 等价（cancelled entry 两侧 deep-equal）」+ 新增「transport 抛错场景例外锁定」用例（该场景维持哨兵不产 entry，登记收窄例外）。

**D2：compaction 恒发帧（选择）**——影响 G2。

interpreter `handleCompactionEnd` 删除 `if (r.summary)` 真值门——帧照发，`summary` 字段缺省透传。registry（`summary !== undefined` 条件展开）与 reducer（`?? '上下文已压缩'`）零改动即两侧一致。E4 补 summary-less 用例（live 帧 entry ≡ replay entry，两侧同 fallback 文案）。

**D3：executingBash 迁入 chat store 分区（选择）**——影响 G3（架构一致性）。

`executingBashMap` 从 bash-effects.ts 模块级 Map 迁入 `store.ts` per-session Map 分区（与 messages / hydrateAnchors 同区），bash-effects 三个写方（bashStart 置 / bashResult 清 / markBashError 兜底清）改调 store 方法；`getExecutingBash` 由 store 暴露（渲染层读方签名不变）。收益：session 删除时随 useSidebar.deleteSession 统一 cleanup 编排清理（消灭豁免草稿），ADR-0049 checklist 全项合规。注意：ctx（effect-types）需补 store 访问或 bash-effects 直接 import store 单例——实施期按 core 域既有依赖方向定（倾向后者：bash-effects 已 import mutations / apply-entry 同层模块）。

**D4：注释编号清理（选择）**——影响可维护性。

12+ 处「规则 7.5」引用批量更新为「AGENTS.md 关键规则 9」（含 4 个测试用例名）；同时清理 bash-effects.ts:40-43 的迁移欠账注释（D3 落地后改写为落定描述）。纯注释/命名改动，无行为变更，随 F3 一并提交。

**D5：验收执行计划（选择）**——影响 G4。

V1-V6 继承主设计场景原样执行（不因实现已合入而缩减）；新增 V8/V9/V10（§4）；final gate 保持「V1/V2/V4 打包链 dev app 复跑」。执行顺序：F1-F3 合入 → F4 真机全量一轮（避免实现期反复搭环境）。

### 3.4 目标物理数据流（abort 帧序，D1 修复后）

```
abortBash: 旋转 token + 广播哨兵帧(command:'') ──▶ bash-effects: 只清 executingBash
sendBash await resolve(cancelled result 全量)
  guard 命中 → 发布真实帧（streaming: 压 pendingBashResults → settled flush；空闲: 立即）
  ──▶ bash-effects: cancelled entry 化 → turn 内 notice        ← 与 pi 落盘同位同值
```

### 3.5 探针清单

**✅ 已测（本轮，0.84.1 dist + xyz 现网代码）**：§2.1 帧序与丢弃点（bash-executor abort 返回形态）；§2.2 真值门与两侧 fallback 就绪度（含空串形态分析）；§2.4 cleanup 缺口。

**⛔ 实施期门（探针不过则对应决策重议，禁止带病实施）**：

1. **D1 实测**：本地 pi CLI 按 AGENTS 扩展实测纪律跑一次 streaming 中 bash + abort → 确认 RPC resolve 的 result 含 `cancelled: true` 与部分 output（dispatcher 发布数据完整性）；dev app 复跑 V8 场景确认重开一致。

### 3.6 与既有治理/规范的一致性自查（多源红线）

| 本设计新增物 | 权威源 | 唯一写方 | 是否缓存/影子 | 合规依据 |
|---|---|---|---|---|
| abort 真实帧发布 | pi recordBashResult 落盘数据（RPC 返回原样转发） | dispatcher sendBash 单点 | 否 | 与 W1 双分支同通路，无新状态 |
| compaction 恒发帧 | pi appendCompaction 落盘数据 | interpreter 单点 | 否 | 同上 |
| executingBash 分区迁移 | bashStart/bashResult 帧 | store 分区（三写方成对契约不变） | 否（瞬态） | ADR-0049 Map 分区 + 统一 cleanup 编排 |

本设计不新增任何持久化物或派生字段（L4 信使链路已随产品裁决移除出范围）。

登记表 #7 例外清单演进：例外①（bash abort 分歧）删除；例外④（compaction 窄差异）删除；新增收窄例外「abort 且 transport 抛错时 live 无 cancelled entry（哨兵语义保留）」；例外②③不变。`@data-owner` 注解随 F3 更新。规则 9 双通路核查：abort / compaction 的实时链路（RPC 结果转发 / compaction_end 帧转发）与持久化链路（文件 entry → replayEntries）**读同一数据源、喂同一 reducer 分支**，无单侧独有规则。

## §4 验收（真实场景，非单测非 mock）

继承主设计 V1-V6（场景、步骤、通过标准原样有效，此处不重复——见主设计 §4 表）。本设计新增：

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V8 | abort 后重开一致 | dev app：agent streaming 中 `!` 跑长命令（如 `sleep 30`）→ 数秒后点 abort → run 结束 → 关闭重开该 session | live 与重开都有一条 cancelled bash 记录（含部分输出），位置同在 turn 内 notice 位；重开不再「多出」记录；console 无新增 warn | G1 |
| V9 | compaction 无摘要一致 | **混合验收形态**：summary 缺失依赖 LLM 异常返回，真实环境无法稳定构造，故核心断言用单测级注入（compaction_end 事件 summary 缺省）承载，真机部分跑正常 /compact 作不回归基线。步骤：① 注入用例（E4 断言 live 与 replay 同产「上下文已压缩」fallback 行）② 真机跑一次 /compact | **① 注入用例**：两侧同 fallback 行、deep-equal。**② 真机**：正常摘要行两侧一致（既有行为不回归） | G2 |
| V10 | 全量回归 + 等价性 | 四包全量 + E3 改判（abort 等价 / transport 例外锁定）+ E4 summary-less 用例 | 全绿；登记表 #7 例外清单与实现一致（4→1+收窄） | G3、主设计 G6 |

Final gate：V1 / V2 / V4 在打包链 dev app 端到端复跑一次（builtin 扩展生效形态）。

## §5 下一层拆分（收尾 wave，领地与依赖）

| wave | 内容 | 领地 | 依赖 | justification |
|------|------|------|------|---------------|
| F1 | bash abort 分歧消灭（dispatcher guard 分支改发布 + E3 改判与例外锁定用例 + 探针 ①） | runtime dispatcher + core 等价性测试 | 无 | 独立最小闭环；例外①即除 |
| F2 | compaction 恒发帧（interpreter 删门 + E4 用例） | runtime interpreter + core 测试 | 无 | 独立最小闭环；例外④即除 |
| F3 | 技术债 + 文档（executingBash 迁 store 分区 + 编号清理 + 登记表 #7 例外清单演进 + AGENTS/主设计实施记录回填） | core store/bash-effects + 全仓注释 + 文档 | F1-F2（登记表要记录它们的落定） | 纯收敛层；例外清单 4→1+收窄的登记动作 |
| F4 | 真机验收执行（V1-V6 + V8-V10 + final gate，按 D5 顺序） | 无代码（发现问题回投对应 wave） | F1-F3 全部合入 | 设计 DoD 闭环；主设计欠账 L1 兑现 |

**文件改动地图**：改写 `message-dispatcher.ts`（sendBash guard 分支）、`event-interpreter.ts`（删真值门）、`store.ts`（executingBash 分区）、`bash-effects.ts`（三写方改调 store + 欠账注释改写）；批量更新 12+ 处「规则 7.5」注释与测试名；登记表 #7 与主设计 §6 实施记录回填。新增无文件。

**并行协调（r3 审查修正）**：F1/F2 的 runtime 侧领地不相交（F1 碰 message-dispatcher.ts、F2 碰 event-interpreter.ts），可两路并行开发；**但两者的测试都落在 `packages/core/src/domain/chat/__tests__/apply-entry-equivalence.test.ts`**（F1 改判 E3 :279 附近、F2 在 E4 :333 附近增用例）——该文件须串行（F1 先改判 E3、F2 后增 E4，或反之，按先合入者为准），否则并行 diff 冲突。F3 串行收尾，F4 最后。启动前 `git log` 复核并行 session 在途改动。

**待验证检查点**：§3.5 实施期门 1；F3 的 ctx 访问方式（store 单例 import vs ctx 扩展，实施期按依赖方向定案）。

## §6 实施记录（F1-F3，2026-08-20）

| wave | 内容 | 落定 |
|------|------|------|
| F1 | dispatcher sendBash：入口空命令早退守卫（哨兵不变式结构化）+ guard 命中分支改发布真实 cancelled 结果（注释重写，catch 分支维持 skip）；bash-effects 哨兵注释更新为收窄语义；E3 改判为 abort 等价（两侧 deep-equal）+ 新增 E3b transport 抛错例外锁定；runtime W1a 测试改判（2 条帧断言；cr1 强化：哨兵帧补 `command:''` 字段断言——两字段共同构成哨兵形态不变式，第二帧 cancelled 随 pi 返回值透传，mock 刻意用 cancelled:false 验证「guard 命中与结果正交、照发不筛」） | 例外①消灭 |
| F2 | interpreter handleCompactionEnd 删 `if (r.summary)` 真值门（恒发帧，summary 缺省透传）；新增 TC2b（runtime）与 E4b/E4c（core）锁定（E4c 为 r1 MF-1 空串透传配套，cr1 SG-A4 补记） | 例外④消灭 |
| F3 | executingBash cleanup 挂接（**实施期定案**：形态保留 bash-effects 模块级分区 Map——store 是 factory 模式，渲染层 `getExecutingBash` 模块级读签名不变，迁入 store 实例会迫使读方改走 pinia 解包超出「读方签名不变」约束；架构目标「cleanup 编排可达」以 store.disposeSession 同点调 `clearExecutingBash` 达成，taste 豁免 W24-EX-B 从草稿转落定）；「规则 7.5」→「关键规则 9」编号清理（r2 MF-2 修正口径 + **一致性审查 cr1 变体族终态**）：历轮按 `规则 7.5` 精确 pattern 清 packages 源码 26 处 + 活文档 10 处；**cr1 发现该 pattern 遗漏四种变体**（`规则 #7.5` / `AGENTS.md 7.5` / `AGENTS.md #7.5` / `AGENTS 7.5`），补清 packages 源码 4 处（message-bus.ts / entry-tree-builder.ts / tail-read-history.test.ts 用例名 / entry-tree-builder.test.ts 注释）与活文档 6 处（unified-converter 5 + 主设计 wave 表 W6 行 1），至此 packages 与活文档两区对全变体族 0 残留；**as-written 保留（全变体口径）26 处** = `规则 7.5` 20 处（docs/adr 4 + .xyz-harness 6 = 历史决策记录；*.review.md 3 = 历史审查报告；closure 自身 5 = 对 L6 客体的自指性命名 + §6 处置记录引用，改写反而失真；主设计 :259 说明性引用 1；archive html 1）+ `规则 #7.5` 3（.xyz-harness 2 + docs/adr/0055 1）+ `AGENTS.md #7.5` 3（.xyz-harness clarify.json）。主设计消灭口径勘误（cr1 F-E）：前轮「活文档 10 处含主设计 2」中主设计实际改名仅 :121 一处，:259 为过时表述改写、旧编号字符串原样保留并计入 as-written。历轮教训链：数字复核的 grep 必须裸跑（无 --include 过滤），且 pattern 必须覆盖变体族（精确串匹配会漏 `#` 号与 `AGENTS.md` 前缀变体）；登记表 #7 例外清单演进（①④消灭 / ②落定 / 新增收窄例外⑤） | 技术债清偿 |

**探针门 1（§3.5 ⛔）状态**：pi dist 侧依据为静态源码锚定（bash-executor.js:86-109 abort 返回 cancelled 不 throw）+ W1a mock 测试按此语义改判并通过；按门定义的本地 pi CLI 真机腿 + dev app 复跑（V8）归 F4 验收阶段执行。F4（真机验收 V1-V6 + V8-V10 + final gate）未执行——独立阶段，发现问题回投对应 wave。

**实施审查（r1，reviewer 对 21a8564b0 + b17307a9c 对抗式）处置记录**：

- **MF-1（major，已修）**：空串 summary 分叉——原设计 §2.2 论证漏算 `readCompactionSummary` 的 truthiness 中转门，live 帧 `''` 被丢成 undefined 走 fallback 而 pi 落盘 `''` 保留空行。修复：readers 门改 `s !== undefined`（readBranchSummary 同型门一并修）+ readers 单测空串断言 + E4c 用例 + interpreter 注释与 §2.2 论证同步修正。
- S-1（已修）：registry compactionSummary handler 例外④注释更新为销案表述。
- S-2（已修）：空命令守卫上移至 ensureActive 之前（真入口，空命令不再拉起 pi 子进程）+ 注释显式声明「程序不变式守卫不广播用户可见错误」契约。
- S-3（表述修正，**r2 复审 MF-2 二次修正**）：r1 报告给出的残留分布（「.xyz-harness 4 文件 + docs/adr 2 文件共 25 处」）未经核实被 85133e338 原样固化——实际两区仅 10 处，另有 15 处在 docs/architecture 活文档区（其中 8 处是与 L6 同性质的活引用漂移，as-written 理由不成立）。二次修正：活文档 10 处（含主设计 2 处，其中过时「未清理」自登记改写为已清）一并清理；as-written 保留 19 处（历史决策记录 / 历史审查报告 / closure 自指性命名）如上分述。教训：subagent 报告的数字必须本仓 grep 复核后再落文档。
- S-4（表述修正）：见上文探针门状态段（原文「已实测锚定」夸大为真机实测，实为 dist 静态 + mock）。
- S-5（备案，pre-existing 非本次回归）：sendBash finally 无条件 `isBashRunning = false` 在 abort 后新旧 sendBash 交叠的窄窗口会破坏 bash↔bash 互斥并短路 abortBash 的 isBashRunning 守卫——旧代码同病且设计明言「finally 复位逻辑不变」，登记为已知问题（触发条件：abort 后立即发起下一次 `!` bash 的毫秒级窗口），归后续 bash 互斥专项处理，不在本收尾范围。

**一致性审查（cr1，2026-08-20，实现↔设计文档双向对照；3 agent 并行 = D1/D2 正向 + D3/MF-1/D4 正向 + diff 反向，全部 finding 主 agent 本仓核实后处置）**：

- **正向 D1/D2**：0 must-fix / 4 suggestion。D1/D2 全部机制断言逐条一致（含 pi 0.84.1 dist 抽查：bash-executor abort 返回 cancelled 不 throw、recordBashResult 无条件落盘、appendCompaction 直写 summary、_flushPendingBashMessages 先于 _emitAgentSettled；含 §3.4 帧序图 / §3.6 多源自查断言——sendBash 是真实 cancelled 帧唯一发布点、interpreter 是 compactionSummary 帧唯一发布点）。处置：SG-A1 sendBash JSDoc「blocked:true 三种形态」改四种（catch abort skip 是 D1 新增分支，与执行失败的关键区别是不广播）；SG-A2/A3 W1a 测试补 `command:''` 哨兵字段断言 + 第二帧透传语义注释（见 F1 行）；SG-A4 F2 行补记 E4c。
- **正向 D3/MF-1/D4**：2 must-fix（均 D4 编号变体残留 → F3 行 cr1 补清段）+ 1 suggestion（as-written 总数口径 → 已并入 26 处终态）；D3 生命周期挂接（含 useSidebar.deleteSession→cleanupSessionState→useChat.disposeSession→store.disposeSession→clearExecutingBash 全链逐跳）、MF-1 双透传门、等价性测试族 E3/E3b/E4b/E4c、登记表 #7 终态全部核实一致。
- **反向 diff（5f1d0acb0..ddf71ced3，30 文件逐处对照 + 5 commit 消息核对）**：0 must-fix / 3 minor / 2 suggestion。行为性改动 5 处（dispatcher guard 改发布、interpreter 删门、readers 双门、store 挂接、clearExecutingBash 导出）全部有正文记载；处置：F-A（r2 轮 SG-2 处置未进 §6 处置记录）→ 补记于此：r2 SG-2 = blocked 多形态契约 JSDoc 化 + 空命令早退的 ack 文案失真备案归 bash 互斥专项；F-B（§5 F3 计划项「AGENTS/主设计实施记录回填」AGENTS 部分零落地）→ 豁免记录：实测 AGENTS.md 关键规则 9 正文为指针级规则，例外清单 SSOT 在 data-source-registry.md #7，无可回填内容，主设计回填部分已落地（:257）；F-C（b17307a9c message「across 12 files」失真：26 处中 1 处已由 21a8564b0 先行改名，b17307a9c 实改 25 处 / 14 文件）与 F-D（8976155b2 算术矛盾 10+19≠28，ddf71ced3 已自纠）→ commit message 不可改写，在此登记勘误；F-E（主设计消灭口径重复计数）→ 主设计 :259 与本文 F3 行均已修正。core 测试复跑 80 files / 1091 passed 与 85133e338 记载一致（runtime/renderer/ui 数字未复跑，存于 commit message）。
