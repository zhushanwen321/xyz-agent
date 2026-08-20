# review-fix-loop 效率优化 梯队 3：must-fix 可执行验证（结构化验证规格 + 双跑预言机）

> **处置状态（v3）：暂时不做。** 触发条件 = 梯队 1 仪表（M1）上线后，真实 run 数据显示假阳性 must-fix 烧轮显著（verify-failed 候选占比 / 假阳性进修复队列的轮次成本可统计后复核）。**明确不引入 coding-workflow（cw-cli）或任何外部流程引擎**（核实：cw-cli v2.0.0 为 10.5k LOC 事件溯源开发流程引擎，其 verify 是开发单元级门禁；本文的 verify 段是循环内单条 issue 的自包含确定性执行器——validateVerifySpec + 固定命令模板插值 + 双跑判定表，全部落在 review-fix-loop 自身脚本/utils，形态不匹配，轻量变体同理）。以下正文保留作触发后的实施依据。

> **一句话结论**：在聚合与 fix 之间插入 verify 阶段——reviewer 不提供自由文本命令（v1 方案，安全模型被审查打穿），而是提供**结构化验证规格**（引用仓内已存在的测试文件），workflow 用**调用方配置的固定命令模板**执行，按「修复前应失败、修复后应通过」的双跑预言机判定真假阳性；信任边界显式声明：仅在可信代码库（自有 PR）启用，外部 PR 关闭。审查-修复流水化维持暂缓，但补上可度量的触发器（state.json 阶段时间戳）。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 的循环是「并行 review → aggregate → fix → 重审」（结构见梯队 1 文档 §1）。must-fix 从「reviewer 声称」到「fixer 动手」之间没有客观关卡；梯队 1 的证据门槛是文本层诚实（reviewer 自附证据文字），证据本身仍是 LLM 文本，可以编造。
- **C（冲突）**：假阳性 must-fix 进修复队列会白烧整轮（修了不存在的问题、下轮再审回来）。v1 设计让 reviewer 自附 `repro_command` 自由文本命令、workflow 白名单正则过滤后执行——审查证明该安全模型不成立：`pnpm vitest run x.test.ts` 这类「合法」命令的语义就是执行测试文件里任意代码，白名单收敛的是命令字符串形状，不是被执行内容；且「按预期失败」的判定逻辑未定义、降级后 ES3 校验必崩、传输链路（schema 层无 must-fix 条目对象）不存在。
- **Q（问题）**：能不能让 must-fix 进修复队列前经过真实执行验证，同时不引入「LLM 生成命令在主仓库执行」的攻击面？
- **A（答案）**：把「LLM 生成命令」改为「LLM 生成结构化规格 + 调用方固定命令模板」——workflow 只执行操作者预设的命令形态（如 `pnpm vitest run <已校验的仓内测试文件路径>`），LLM 只能选文件不能造命令；判定用双跑预言机（fix 前跑一次应失败、fix 后跑一次应通过），不依赖语义比对；降级条目走梯队 1 统一的 dormant 通道。

## 1. 背景：被设计的系统是什么

**本章结论：本次设计在 review→fix 之间插入确定性验证阶段；核心是把 v1 的自由命令执行替换为结构化规格 + 固定模板，把未定义的判定替换为双跑预言机。**

review-fix-loop 现状循环（脚本真实顺序）：`parallel(review) → aggregate → [stuck/converge 检测] → fix → 下轮`。聚合到修复之间无验证环节；ES3 硬校验（`validateFixResult`，review-fix-loop.js）要求「must-fix 必须全进 fixes[]」，漏修判 fix-failure 终止——**任何 verify 降级都必须同步收窄 ES3 的校验基准**，否则降级 = 整轮必崩（v1 审查发现）。业界对照：Greptile TREX 每个 issue 派生沙箱验证 agent 执行复现（官方博客）；CRITIC 用工具交互产生带客观证据的 critique；AlphaCodium 用测试执行信号驱动定向修复。

**层声明**：当前层 = 技术方案设计（含安全模型）；下一层 = 实现任务。准则 5/6/7 全适用，安全断言一律 ⛔ 探针。

## 2. 设计目标

**本章结论：修复队列里每条 must-fix 都有真实执行背书；验证不引入 LLM 自由命令执行面；降级不崩 ES3、不阻塞收敛、可复活。**

1. **假阳性挡在修复前**：must-fix 进 fix 队列前经真实执行验证；修复前应失败而未失败的 → 判定疑似假阳性，降级 dormant。
2. **无自由命令执行面**：LLM 产出的是结构化规格（kind + 仓内文件路径 + 可选期望信号），命令串由 workflow 用调用方配置的固定模板构造；LLM 文本永远不作为命令的一部分被 shell 解释。
3. **降级语义完整**：降级条目从 ES3 校验基准中移除（不判漏修）、不阻塞 converged、入 dormant 清单下轮可带新规格复活。
4. **流水化触发器可度量**：state.json 增加阶段时间戳，「审查段时长占比」从不可度量变为可统计。

**In-scope**：verify 阶段（规格 schema、模板执行器、双跑预言机、ES3 接口、state 字段）、阶段时间戳。**Out-of-scope**：沙箱基建（完整版，视假阳性率数据另立项）；梯队 1/2 覆盖项；对外部/不可信 PR 的支持（显式声明不支持，verifyMode 应关闭）。

## 3. 现状：使用者眼里是什么样的

**本章结论：reviewer 的 LLM 声称直接驱动写操作；v1 想加的执行验证在安全模型、判定逻辑、校验接口、传输链路上四个洞。**

### 3.1 现状的真实样子

聚合到修复（脚本真实代码逻辑）：

```js
// Aggregated: N must-fix → 直接进入 Fix
const fxRaw = await agent({ prompt: buildFixPrompt({ reportContent, ... }), ... });
// ES3：validateFixResult(fixResult, agg.must_fix_ids, state.issues)
//   —— must-fix 未全进 fixes[] → fix-failure 整轮终止
```

### 3.2 v1 方案的四个洞（审查确认，作为现状问题的一部分记录）

- **洞 1 安全模型**：白名单正则放行的 `pnpm vitest run x.test.ts` 会执行 x.test.ts 内任意代码。攻击路径：被审 PR 自带恶意测试文件；或前轮 fixer 写过的测试文件被污染。P-safety 探针（10 个对抗命令字符串）测错了对象——全过也不证明安全。翻车场景：审外部 PR → 恶意测试文件 + 诱导性 bug 报告 → 白名单放行 → 环境 token 外泄。
- **洞 2 判定未定义**：「命令报错与描述比对」需要语义判断，但 v1 自我约束非 LLM 执行；退化为「exit≠0 即复现成功」后系统性误判——无关的预存失败算复现成功（假阳性盖着「验证通过」的章进队列，比没有 verify 更糟）；grep 类命令 exit 1 的语义方向直接反了。
- **洞 3 连带全断**：verify 降级 MF-4 后 fixer 只修 4 条 → ES3 校验基准仍是 5 条 → 必判漏修 → fix-failure 整轮终止；降级条目在 state.issues 里永远 open → 阻塞 converged；aggregated.md 不回写 → 下轮 reviewer 看不到要复活什么。
- **洞 4 传输链路**：reviewerSchema 的 must_fix 是 number 计数，schema 层无「条目」可挂 repro 字段；aggregator 去重合并后 MF-id 与原报告无映射——两个 reviewer 报同一 bug 各附 repro，合并后没有权威数据源。

### 3.3 根因

v1 把「执行验证」想成了一个执行器问题（白名单 + spawn），但它实际是四个问题的复合：**命令构造权归属**（安全）、**真值判定标准**（预言机）、**与现有校验的状态机接口**（ES3/收敛）、**逐 issue 数据传输**（schema）。四个洞对应四个独立设计决策，缺一整个机制不成立。

## 4. 根因方案 + 物理数据流

**本章结论：四个洞的修复是四个正交决策——规格化（洞 1/4）、双跑预言机（洞 2）、ES3 基准收窄 + dormant（洞 3）。**

> **结构化验证规格（verify_spec）** = reviewer 在报告的逐 issue 表里填写、aggregator 透传进聚合条目的结构：`{kind: "test-file", file: "src/__tests__/x.test.ts", expect_signal?: "可选的输出正则"}`。LLM 只能指定**仓内已存在的测试文件**，不能造命令。就是 §3.2 洞 1 里「恶意命令字符串」消失后的形态——根本没有命令字符串。
> **双跑预言机** = 同一验证跑两次：fix 前跑（应失败：exit≠0，且若给 expect_signal 则输出须匹配）+ fix 后跑（应通过：exit=0）。两个观察组合出判定，无需任何语义比对。
> **验证命令模板** = 调用方参数 `verifyCommand`（如 `pnpm vitest run {file}`），workflow 只做 `{file}` 插值；插值前校验：文件存在于仓内、路径在 repo 内（无 `..`）、匹配测试路径模式。

物理数据流：

```
reviewer markdown 报告（逐 issue 表新增「验证规格」列：kind/file/expect_signal）
  ↓ aggregator 去重 + 提取（复用梯队 1 的聚合条目扩展机制）
must_fix_ids 条目：{id, severity, files[], evidence, guidance, verify_spec?}
  ↓【verify 阶段，fix 之前】对每条带 verify_spec 的条目：
    文件校验（存在/仓内/测试路径）→ 模板插值构造命令 → spawn 执行（超时 120s，fail-open）
    exit≠0（且匹配 expect_signal）→ verified，保留 must-fix
    exit=0 → verify-failed（疑似假阳性）→ 降级 dormant
    无 verify_spec → 走梯队 1 证据门槛规则
  ↓ verify 输出收窄后的 must-fix 清单
ES3 校验基准 = 收窄后清单（降级条目不判漏修）
  ↓ fix 阶段（fixer 输入含真实失败输出）
【fix 后同一命令重跑】exit=0 → 修复确认；仍失败 → 该 issue 转 regressed（喂 reconcile）
state.dormant[] → 下轮 R2+ prompt 复活通道（与梯队 1 证据降级共用同一 dormant 机制）
```

信任边界（显式声明）：verify 会真实执行仓内测试代码，信任假设 = 「被审代码本身可信」（自有仓库、自有 PR），不信任的只有 LLM 文本。**审外部/不可信 PR 时必须 `verifyMode=off`**（或未来沙箱版）。这与 CI 跑 PR 测试的信任假设同级——不自称更高。

## 5. 终态：使用者眼里将是什么样的

**本章结论：run 日志多一个 verify 段；修复队列变小变真；fix 后有重跑确认；降级可复活不崩轮。**

### 5.1 成功路径

```
[run 日志] Round 1: Aggregated: 5 must-fix + 3 suggestion(s).
[run 日志] Verify: 3 条带 verify_spec
           MF-1: "pnpm vitest run src/__tests__/session.test.ts" → exit 1（匹配 expect_signal）✓ verified
           MF-2: 文件校验失败（spec 指向不存在文件）→ 按无 spec 走证据规则
           MF-3: repro 通过（exit 0，应失败未失败）→ verify-failed → dormant
[run 日志] Fix round 1: 4 条（ES3 基准 = 收窄后 4 条，MF-3 不判漏修）
[run 日志] Post-fix verify: MF-1 重跑 → exit 0 ✓ 修复确认
[run 日志] Round 2 prompt: dormant 清单含 MF-3（可带新 spec/证据复活）
```

### 5.2 失败路径（带恢复指引）

- **真问题被误降级**（spec 写错/环境 flake）→ 条目在 dormant 清单，下轮 reviewer 可复活；state.json 统计 verify-failed 率，持续 >30% 说明 reviewer 规格写作指引需改进。👉 临时关闭：`verifyMode=off`。
- **verify 拖慢**（测试命令分钟级）→ 单条超时 120s（`verifyTimeoutMs` 可调），超时 fail-open（保留不降级，记 timeout 状态）；多条目并行执行（并发上限 4）。👉 慢仓调小超时或只对 critical 强制：`verifyMinSeverity=critical`。
- **不可信代码场景**：审外部 PR → 👉 必须 `verifyMode=off`；文档与 @pi-meta usage 中显式警告。
- **post-fix 重跑仍失败** → issue 转 regressed 喂 reconcile，走现有 stuck/needs-redesign 出口。👉 人工介入信号同现状。

## 6. 关键决策与权衡

**本章结论：四个决策对应四个洞；流水化维持暂缓但补可度量触发器。**

### 6.1 命令构造权：结构化规格 + 固定模板（洞 1/4）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| verify_spec 结构 + 调用方 verifyCommand 模板（选） | LLM 文本不作为命令被 shell 解释——by construction 消除命令注入面；信任边界与 CI 同级且显式声明 | 中：spec schema + 文件校验 + 模板插值执行器 | 残余风险：恶意测试文件内容（信任边界声明覆盖：仅限可信代码库）；spec 只能引用既有测试文件，新 bug 无对应测试时验证覆盖不到（fail-open 走证据规则） | ✅ |
| 自由 repro_command + 白名单正则（v1） | — | 中 | **审查证实不成立**：白名单收敛命令形状而非被执行内容 | ❌ |
| 完整沙箱版（TREX 式） | 验证能力最强，可信边界最宽（可审外部 PR） | 高：沙箱基建 + 每 issue 验证 agent 成本 | 基建重 | ⏸ 视假阳性率数据 |

### 6.2 真值判定：双跑预言机（洞 2）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 双跑预言机（选）：fix 前应失败 + fix 后应通过 | 判定规则是纯退出码/正则匹配表，零语义判断；post-fix 重跑顺带提供「修复确认」信号（现实现缺） | 低-中：执行器跑两次 + 判定表 | 测试 flake 导致误判（expect_signal 正则 + 超时重试一次缓释）；无 spec 条目不在覆盖内 | ✅ |
| 「输出与描述比对」（v1 暗示） | — | — | 需要语义判断，与「非 LLM 执行」约束自相矛盾；exit≠0 退化版系统性误判 | ❌ |

判定表（完整枚举，无 undefined 分支）：

| fix 前 | fix 后 | 判定 |
|---|---|---|
| exit≠0（匹配 signal） | exit=0 | 真问题已修复 |
| exit≠0（匹配 signal） | exit≠0 | 修复未完成 → regressed |
| exit=0 | （不跑） | 疑似假阳性 → verify-failed → dormant |
| 超时/执行错误 | — | fail-open 保留 must-fix，记 verify-status=timeout |
| spec 校验失败（文件不存在等） | — | 按无 spec 处理，走证据规则 |

### 6.3 与现有校验的接口：ES3 基准收窄 + dormant 状态（洞 3）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| verify 输出收窄清单 + ES3 校验收窄后清单 + 降级条目 status=verify-failed 入 dormant（选） | 与梯队 1 证据降级共用同一 dormant 机制（单一复活通道）；verify-failed 是 status 不是 origin，不污染归因统计 | 中：ES3 入参改为收窄清单 + state.status 新枚举 + dormant 注入复用 | 收窄后 ES3 放行范围变大——以双跑预言机为补偿（真问题会被 post-fix 重跑抓住） | ✅ |
| 降级但不动 ES3（v1） | — | — | **审查证实必崩**：漏修判 violation → fix-failure 整轮终止 | ❌ |

### 6.4 审查-修复流水化：维持暂缓，补可度量触发器

v1 暂缓理由成立（与 aggregate 去重冲突、fix 改了文件后续 reviewer 审移动目标、击穿 base 锁定），但审查发现触发器「审查段时长占比 >60%」不可度量——state.json 只有 meta.startedAt 一个时间字段，「暂缓」实为永久搁置。修复：本文档附带一个零风险仪表任务——batchRounds 记录每阶段（review/aggregate/verify/fix）起止时间戳，触发器从此可统计。重评估条件不变：梯队 1/2 上线后占比仍 >60%。

## 7. 实现机制（把终态落到代码层）

**本章结论：改动在 workflow 脚本 + utils + aggregator 条目扩展（与梯队 1 共享），无新 agent。**

| 文件 | 改动 |
|---|---|
| `workflows/review-fix-loop.js` | 聚合后、Fix 前插入 verify 段（并发上限 4 + 超时 + fail-open）；ES3 入参改收窄清单；state.issues 新 status `verify-failed`；fix 后 post-verify 重跑接 reconcile；新增参数 `verifyMode`（默认 on）/`verifyCommand`（模板，缺省则 verify 段跳过并 WARN）/`verifyTimeoutMs`/`verifyMinSeverity`；batchRounds 记录各阶段起止时间戳（6.4） |
| `workflows/review-fix-loop-utils.cjs` | `validateVerifySpec(spec, workspace)`（文件存在/仓内/测试路径模式）；`buildVerifyCommand(template, file)`（插值，拒绝模板外任何 LLM 文本）；`classifyVerifyResult(pre, post)`（§6.2 判定表） |
| aggregator prompt 模板 | 条目扩展增加 `verify_spec` 透传规则（复用梯队 1 的聚合条目扩展，同一字段载体） |
| reviewer prompt 模板 | 逐 issue 表增加「验证规格」列写作指引（「引用仓内已存在的、能复现该问题的测试文件」） |
| `src/__tests__/review-fix-loop-utils.test.ts` | 文件校验（路径逃逸 `..`/不存在文件/非测试路径全拒）；判定表全枚举；模板插值（LLM 文本含 shell 元字符时不出现在命令串） |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：中改动（新流水线阶段 + 安全面 + ES3 接口），核心验收是真阳性确认、植入假阳性拦截、降级不崩轮。**

### 8.1 改动规模

中：新增 verify 阶段 + ES3 接口变更 + 状态机新枚举。不改循环骨架。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 真问题全链路 | 目标 1 | xyz-agent 仓造真实 failing-test 场景 PR（已知 bug + 对应已存在测试），跑 review-fix-loop（verifyCommand 配置为 `pnpm vitest run {file}`） | MF 条目的 spec 被执行、fix 前失败、保留、fix 后重跑通过；run 正常 clean 终止 |
| S2 植入假阳性拦截 | 目标 1/3 | 可控植入：测试 harness 直接向 verify 阶段输入一条假 must-fix（spec 指向一个**当前通过**的真实测试文件）——执行是真的，只有声称是植入的 | 该条目 verify-failed → dormant；**ES3 不判漏修、run 不因它终止、不阻塞 converged**（替代 v1 不可控的「幻觉倾向 diff」构造） |
| S3 命令构造安全 | 目标 2 | 对抗输入：spec 的 file 字段填 `../../etc/passwd`、`x.test.ts; rm -rf ~`、`$(curl evil)` 等 ≥10 个样本走 validateVerifySpec/buildVerifyCommand | 全部拒绝或不进入命令串；命令串中无任何未经路径校验的 LLM 文本（⛔ P-safety 的真实形态：测 spec 校验而非命令字符串正则） |
| S4 超时与并行 | 目标 1 的成本护栏 | 构造一条跑全量测试的 spec（>120s）+ 5 条普通 spec | 慢 spec 被 120s 截断 fail-open 保留；总 verify 时长 < 串行和（并行生效）；run 不中断 |
| S5 关闭开关 | 护栏 | 同 PR 加 `verifyMode=off` 重跑 | verify 段消失，回到梯队 1 证据门槛模式 |
| S6 阶段时间戳 | 目标 4 | S1 的 state.json | batchRounds 每轮含 review/aggregate/verify/fix 起止时间，可算占比 |

## 9. 实施

**本章结论：一个里程碑交付轻量版；完整沙箱版由假阳性率数据触发另立项。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | T1 规格校验/构造/判定表 → T2 schema/prompt 指引 → T3 verify 段集成（ES3 收窄 + dormant + post-fix 重跑）+ 阶段时间戳 | 目标 1-4 全部 |
| M2（条件触发） | verify-failed 率 >30% 且集中于「无既有测试覆盖的新 bug 类问题」→ 评估沙箱版立项 | 决策输入 |

## 10. 下一层拆分

**本章结论：3 个任务，安全件先行。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 规格校验 + 命令构造 + 判定表 + 对抗单测 | utils 纯函数 | 安全红线独立成任务先交付先审查（v1 教训：探针测错对象——本任务的单测对象就是 spec 校验本身） |
| T2 aggregator 条目 verify_spec + reviewer 指引 | 复用梯队 1 传输链 | 与梯队 1 T1 共享字段载体，排期在其后 |
| T3 verify 段集成（ES3 收窄 + dormant + post-fix 重跑 + 时间戳） | 主脚本 | 依赖 T1/T2；ES3 接口变更是本任务的核心风险点，集中审查 |

## 11. 待验证检查点

- ⛔ P-safety：S3 对抗测试（实施期门，不通过不交付）。
- ⛔ P-repro-quality：reviewer 产出 verify_spec 的可用率（能指向真实存在且相关的测试文件的比例）——低则指引需迭代。
- ⛔ P-fp-rate：verify-failed 率——沙箱完整版的立项触发器（<10% 不立项，>30% 立项）。
- ⛔ P-flake：测试 flake 对双跑预言机的污染率（timeout 重试一次是否足够）。
- ✅ 已核实（源码）：聚合→Fix 无验证环节；ES3 校验基准是 agg.must_fix_ids 全量；state.json 仅 meta.startedAt 一个时间字段；reviewerSchema.must_fix 为 number 计数（传输必须走 aggregator 条目扩展）。

## 附录：变更历史

- v1：初版（reviewer 自由 repro_command + 白名单执行）。
- v2：对抗式审查后重设计——命令构造权从 LLM 移交调用方（结构化 verify_spec + 固定模板插值，白名单正则方案否决）；判定从「输出比对」改为双跑预言机（fix 前应失败 + fix 后应通过，纯退出码/正则无语义判断）；补 ES3 基准收窄 + verify-failed dormant 状态（v1 降级必崩 fix-failure）；传输链路走梯队 1 聚合条目扩展；信任边界显式声明（仅可信代码库，外部 PR 关闭）；流水化暂缓不变但补阶段时间戳使触发器可度量；S2 改为可控植入假阳性。审查报告见同目录 `tier-3-verification-pipelining.review.md`。
- v3：处置标记——整体暂时不做，触发条件改由梯队 1 仪表数据驱动（假阳性 must-fix 占比/烧轮成本可统计后复核）；明确否决引入 cw-cli 等外部流程引擎（verify 段为自包含确定性执行器，cw 的账本/单元门禁是开发单元级编排，形态不匹配）。设计本体保留备查。
