# 对抗式审查报告：pi-boundary-reliability.md

> 审查对象：`docs/design/pi-boundary-reliability.md`（程序级总设计，2026-08-27）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（P0-1..P0-18 / P1-1..P1-10）
> 事实核实基线：`npm ls` 核对 pi 三包实装一致（pi-coding-agent@0.84.1 / pi-ai@0.84.1 / pi-agent-core@0.84.1，均精确 pin）；pi dist 与 xyz 侧源码、护栏脚本、治理资产直读，共核对 49 处断言（清单见文末）。所有「实测/实读」均指本次审查实际 read 的结果。

## Summary

3 must-fix, 8 suggestions.

骨架成立：两起事故的同构性论证经逐条实读核对**成立**（「undefined 语义两侧相反」「gc 坍缩」「观察项登记≠防御」三个关键事实全部命中）；D2-D4 对事故 B 的因果链闭合（表单补字段 → 注册表算档位 → 回执接通，根因三个环节各有承载）；护栏挂载点描述与实装**高度吻合**（install-hooks.sh heredoc 结构、R1 后不设独立 SKIP_* 惯例、render-constraints 存在性校验、vitest 分池、REAL_PI_READY 门控全部实读核实，G7「同 commit 不死锁」经 pre-commit :770-772 确认可行）；验收 P-S1..P-S5 真实、可证伪、含反向。但存在 3 处必须修复：**D5 点名「scheduler 触发」为禁令对象而 scheduler 现状就是 steer 底层、无迁移承载单元**（约束登记当天即产生已知违规存量）；**「语义自动跟随」存在版本分裂盲区**（门禁只校验 pi-coding-agent 单包，runtime 内嵌 pi-ai 可与 pi 子进程静默分裂，守卫体系在自己的核心威胁场景下失效）；**§5 地图「thinking-levels.ts [U6 删除]」与 D3③ 函数级删除矛盾且连带改动遗漏**（该文件 10 个导出、4 类消费方，含 W3/W4 既有归位决策）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D5 / D7-G4 / §5 U 清单 | P0-12 遗漏 | **C-ext-19 禁令点名「scheduler 触发」，但 scheduler 现状违规且无迁移承载。** D5 原文把「（subagent 完成、scheduler 触发、未来 webhook）」列为「必须走持久账本 + 幂等键通道」的结果语义通知。实读 `extensions/universal/scheduler/src/index.ts:85-105`：scheduler 已用 `createDelivery`（session-delivery 投递内核），但 send 底层就是 `pi.sendMessage(..., { triggerTurn: true, deliverAs: 'steer' \| 'followUp' })`——走 pi 内存队列、无账本、无幂等键，按 D5 口径即违规存量。而 U1-U8 无任何单元承载 scheduler 账本化迁移，G4 禁则只扫 `extensions/universal/subagent-workflow/**`（scheduler 目录不在扫描面，不会红也不会被迁移）。U8 登记 C-ext-19 生效当天即存在已知违规且无机器拦截。另注意 D5 的豁免条款「交互式 steer 不在禁令内」与括号列举「scheduler 触发」两种读法互相矛盾——「定时器到期注入 dispatched 消息」按哪个口径都需文档自清 | 二选一并写明：① 附录 B 待办补「scheduler 迁移到账本通道」条目 + D5 声明存量分阶段口径（新代码即禁、存量列后续切片）；② 若裁定 scheduler 触发属交互注入，则修正 D5 括号列举，把 scheduler 移出禁令对象。同时评估 G4 扫描范围是否扩到 scheduler 目录 |
| MUST_FIX | §3.3 D2 / D6 守卫层③ / 附录 A schema | P0-10 + P0-11 | **「pi 升级时语义自动跟随（同一包）」的声称存在版本分裂盲区，版本门禁只查单包。** 实读根 `package.json:31-32`：pi-ai 与 pi-coding-agent 均为精确 pin `"0.84.1"`。U5 将在 `packages/runtime/package.json` **再加一份独立的 pi-ai pin**——pnpm 允许多版本共存：pi bump PR 改根两包到 0.85.x 而漏改 runtime 的 pin 时，`--frozen-lockfile` 不报错（0.84.1 条目已在 lockfile），node_modules 出现两份 pi-ai（runtime 解析 0.84.1 / pi 子进程 0.85.0）。此时离线计算与探针 import 的是旧版 pi-ai，pi 子进程行为已变——**判据 1（两套规则互不知晓）在守卫体系眼皮底下复活**。而 D6 版本门禁只读 `node_modules/@earendil-works/pi-coding-agent/package.json` 版本 vs verifiedWith：重验流程跑探针（旧版 pi-ai 行为没变，全绿）→ 更新 verifiedWith → 门禁通过，**全程无红灯**。G5「依赖面变更时失败发生在 CI」的承诺在 pi-ai 单独变动/bump 漏改场景落空 | D6 门禁增加多包校验：verifiedWith 与「pi-coding-agent 版本 === pi-ai 解析版本 === pi-agent-core 版本 === runtime package.json 的 pi-ai pin」四者一致才过（pi-mono 三包同步发版，单值 verifiedWith 仍可容纳，校验逻辑并列即可）；C-proc-08 报错文案补「同步 bump runtime pi-ai pin」恢复动作；P-C1 打包验证清单加版本一致性断言 |
| MUST_FIX | §5 文件改动地图 vs D3③ | P0-12 遗漏 + 内部矛盾 | **「thinking-levels.ts [U6 删除]」与 D3③ 的函数级删除矛盾，且整文件删除的连带改动完全遗漏。** 实读 `packages/core/src/domain/composer/thinking-levels.ts`：全文 **10 个导出**（ThinkingLevel 类型 / ThinkingLevelOption / THINKING_LEVELS / isThinkingLevel / resolveAvailableLevels / isOnOffMap / resolveThinkingValue / resolveThinkingKey / highestAvailableLevel / isSameThinkingScheme）。D3③ 只删 `resolveAvailableLevels` + undefined 语义（正确——其余导出如 resolveThinkingValue 是 xyz 自有的 UI 值→请求值映射协议，不是影子推断），但 §5 地图写整文件删除。实际消费方：renderer shim `packages/renderer/src/components/panel/thinking-levels.ts:18`（import core）+:22（`export *` re-export）、`core/domain/composer/index.ts:15`（`export *`）、`thinking-level-sync.ts:27`、`ThinkingLevelPopover.vue:66/102`（resolveThinkingKey 在用）、`thinking-levels.test.ts`。且 shim 头注是 W3 归位/W4 壳接入的**既有架构决策**（「W4 壳接入时删除本 shim」），U6 删 core 文件会砸断该计划。按图施工的 implementer 会撞 4 处编译错误并被迫现场架构决策 | 地图改为「thinking-levels.ts [U6 删 resolveAvailableLevels + undefined 语义；其余导出保留]」；U6 内容行补连带项：renderer shim 与 core index 导出、thinking-level-sync、既有测试文件的处理（迁移或删除锚点） |
| SUGGESTION | §3.3 D6 / D7-G1 | P0-16 剩余面 | **verifiedWith 批量更新的橡皮图章绕过面未声明。** 任务点名问题：有人 bump 时顺手把全部 verifiedWith 改成新版本而不跑探针，版本门禁即过。现有设计的实际防线是 G2 探针测试在 CI 自动跑（与 verifiedWith 无关地红）——这已覆盖大多数情况；但「批量改 verifiedWith + 探针断言恰未覆盖该语义变化」的组合可静默通过（P-D1 已承认部分条目只能做锚点+形态断言，若 pi 行为由非 dist 代码决定而误分型为 probe，双防线同废）。文档未声明这一剩余攻击面与防线归属 | D6 补一段「防线分层」：verifiedWith=提醒机制、探针=机器防线、两者组合的剩余盲区=probe 误分型；可选硬门禁：check-pi-semantics 读 staged diff，`verifiedWith` 变更行数 > N 而无对应探针文件变更时要求交互确认 |
| SUGGESTION | §3.3 D2 | P0-12 轻量 | **缓存键缺 builtin-providers.json 维度。** D2「缓存键 = pi 版本 + models.json mtime」——发版更新 `packages/runtime/src/generated/builtin-providers.json`（实读：1220 个模型，全部自带 reasoning+thinkingLevelMap）而用户 models.json mtime 不变时，supportedLevels 缓存不失效，档位陈旧直到下次 pi bump | 缓存键追加 builtin-providers.json mtime（或内容 hash）；顺带记录：builtin 数据 100% 携带两字段（本次实测），「D2 上线致 builtin 模型批量变『仅关』」的攻击面不存在，用户手加模型缺 reasoning 变「仅关」是 P-S5 覆盖的预期行为 |
| SUGGESTION | §4 P-S2 | P0-13 弱化 | **验收引用了不存在的可观察点。** P-S2 通过标准含「runtime 日志可见 set→get_state→effective 链路」——实读 `session-service.ts:624-645` 该链路**无任何日志语句**（只有注释），U5/U6 交付清单也未列 observability 项。照单实施后验收无法执行 | U6 补一行链路日志交付项（debug 级即可），或 P-S2 改锚为「pi session 文件 thinking_level_change entry 与 UI 显示一致」（P-S1 已用此法） |
| SUGGESTION | 附录 A PS-01 / PS-12 | P1-8 事实 | 两处锚点偏离（均不影响决策）：① PS-01 写「tryMatchModel:291-463」——实读 model-resolver.js：`:291` 起的是 `resolveCliModel`，`tryMatchModel` 在 `:104` 起（`findExactModelReferenceMatch` 的 `toLowerCase()` 相等确在 `:97`，命中）；② PS-12 锚「types.d.ts:257」——实读 pi-ai `dist/types.d.ts:257` 是 Usage 接口的 output 字段，与 thinking 无关；ThinkingLevel 枚举在 `:23`、thinkingLevelMap 在 `:672`（后者已正确用于 PS-10） | read 源核准后改正：PS-01 改「resolveCliModel:291-463（内嵌 tryMatchModel:104 起）、:97」；PS-12 的 types 锚改 `:23` 或删除（clampThinkingLevel:560-578 主锚已核实正确） |
| SUGGESTION | §1 问题类定义 | P0-4 边界 | **判据 2/4 偏宽，问题类的判别力依赖语境限定。** 四条判据本身经 §2.3 逐条核对成立（同根认定不是强行归类——三个关键事实全部实读命中），但「无受理确认」「漂移无守卫」几乎可套入任何跨系统 bug；一个什么都能装的分类框架不构成可证伪的问题定义，未来可能把不相关事故拉进本域扩大 scope | 判据清单后补一行反例边界（如「纯 xyz 域内 bug、与 pi 语义无关的 UI 缺陷不属此类」），把「对 pi 私有语义」从隐含语境升为判据前置条件 |
| SUGGESTION | §2.2 事故 B | P0-17 弱化 | **事故 B 链路无物理数据流图。** 事故 A 的数据流图在切片 1 §2.2（本文档声明引用），但事故 B（表单→models.json→runtime→pi 子进程→回执→protocol.ts→useModel 乐观写→30s 轮询回拉）跨 renderer/runtime/pi 三进程边界，本文档只有文字+行号。因切片 2 不再出独立文档（层声明），数据流图的切片层义务实际由本文档承担 | 补一张事故 B 三层链路小图（标注失真点★，与切片 1 图同风格），或显式声明以 D3 文字链路替代 |
| SUGGESTION | §3.2 / D6 | P1-4 alternatives | **「漂移守卫只在 pi 版本 bump PR 人工跑脚本、不做 pre-commit/CI 门禁」的更简替代未入对比。** D6 被否栏只否了「每次提交全量跑探针」这一反向极端（且论证是探针毫秒级、无成本理由不跑——这恰恰支持挂总闸）；「不挂门禁只人工跑」虽与 G5 立意冲突（8-20 登记照样出事即人工纪律无效的实证），但作为成本最低方案应显式记录被否理由，防止未来以「省 CI 时间」名义回退 | D6 被否栏补一行该替代及否因（引用 8-20→8-27 实证即可，一句完成） |
| SUGGESTION | §3.2 CR-hybrid / P-C1 | P0-16 补充 | **P-C1 验证清单建议补 bundle 体积断言。** 实测 pi-ai `dist/` 总量 5.7MB（含全部 provider 实现）；`import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"` 走主入口，esbuild tree-shake 在 CJS 输出下的实际裁剪效果未验——行为等价（P-C1 现有口径）不等于体积可控。另：pi-paths 探针头注自证现状是「pi 包声明在仓库根、runtime 不可 import、测试只静态读 dist」的**刻意格局**，D2 反转该格局的架构含义（runtime 首次直接依赖 pi 系包、双副本靠 lockfile 同步）值得在设计里点破一句 | P-C1 三阶段验证加体积阈值断言（如 bundle 增量 < 100KB，超标则评估子路径 import `pi-ai/dist/models.js`）；D2 补一句「打破根声明格局」的显式声明 |

## P0 检查项四态判定（覆盖度）

| # | 判定 | 依据 |
|---|------|------|
| P0-1 五段骨架 | 通过 | §1(11-39)/§2(42-81)/§3(84-231)/§4(233-257)/§5(261-305) + 附录 A/B，层声明与证据基线齐备 |
| P0-2 delta 链引用 | 通过 | 无「参见上版/变更摘要」；「R1 后惯例」「W3/W7」「v4 B-1」均为已登记编号或脚本内注释锚点，可回查 |
| P0-3 结论先行 | 通过 | 篇首一句话结论；§2 章首「本章结论」；D1-D8 标题带（选定）四件套 |
| P0-4 问题定义 | 通过（附边界 SUGGESTION） | 问题类四判据是结构性抽象（影子推断/无受理确认/写入坍缩/漂移无守卫），非表象复述；两起事故同根认定经 §2.3 逐条实读核实成立，非强行归类 |
| P0-5 重实现轻体验 | 通过 | §3.1 使用者视角终态先行（派发体验/设置思考等级体验/维护者红灯流），机制后置 |
| P0-6 抽象术语 | 通过 | 语义吸收层/能力注册表/生效回执/确认式送达/漂移守卫均在 SCQA 或 D1 表有操作化定义并绑实例 |
| P0-7 方案对比数量 | 通过 | 程序级 3 案（P-absorb/P-patch/P-fix-pi）+ 切片 2 域 CR 3 案 + EC 2 案 |
| P0-8 双维度评估 | 通过 | 每案长期架构/短期成本/风险三栏齐备 |
| P0-9 明确推荐 | 通过 | 每域标（选）+ 被否栏给出否因 |
| P0-10 解决目标问题 | **不通过（部分）** | 四支柱对四判据的结构性消除因果链总体成立（D2 消判据 1+4、D3 消判据 2、D4 消判据 3、D5/D6 消判据 2/4）；但 D2「语义自动跟随」支柱在 pi-ai 版本分裂场景静默失效且门禁不覆盖（MF-2）——守卫体系自身有漂移盲区 |
| P0-11 关键事实 | 通过 | 49 处断言实读核对，47 处命中、2 处锚点偏离（PS-01 归属 / PS-12 :257，均已降级 SUGGESTION，不影响决策）；影响决策的事实（两级门控、void 映射、乐观写、undefined 相反语义、回执链路已实装、白名单已支持、rpc-client 零封装、C-build-01 scope 漂移、glob 不支持中缀）全部核实为真 |
| P0-12 副作用/遗漏 | **不通过** | MF-1（scheduler 禁令存量无迁移承载）；MF-3（thinking-levels.ts 文件级删除连带遗漏 + 与 D3③ 矛盾）。已排除项：builtin 数据 100% 携带 reasoning（无批量变关风险）；G7「登记与护栏同 commit」不死锁（pre-commit :770-772 在 constraints.json 变更时触发 render-constraints，读工作树文件，同 commit 两者俱在即过） |
| P0-13 验收存在且 testable | 通过（附缺口） | P-S1..P-S5 场景/步骤/通过标准/回溯目标齐备，全部真实环境无 mock；P-S2 引用不存在的日志可观察点 → SUGGESTION |
| P0-14 单测/mock/抽象断言 | 通过 | 「真实 xyz-agent GUI + 真实 pi 0.84.1 + 真实 LLM 后端 + 真实文件系统」明示；P-S3② 跑探针测试是「守卫会红」的元验收（篡改断言验证红灯），非用单测替代场景验收；回归底线与场景验收分离声明 |
| P0-15 投入匹配 | 通过 | 程序级大改动配 5 个场景 + 2 个演练型（P-S3/P-S4 可操作：改 verifiedWith→跑脚本→非零退出；staged 违规串→commit 红）+ 反向（P-S5 假模型）+ 回归底线含 P-C1 收口 |
| P0-16 运行时断言探针 | 通过（附剩余面） | ⛔ P-C1/P-D1/P-D2 均带降级路径（纯在线对账 / 锚点+形态断言 / withEphemeralPi 实测定）；verifiedWith 橡皮图章组合绕过面未声明 → SUGGESTION |
| P0-17 物理数据流图 | 可能不完整 | 事故 A 图在切片 1（有效引用）；事故 B 跨三进程链路仅文字 → SUGGESTION |
| P0-18 错误恢复指引 | 通过 | D6 报错列出待重验条目+重验命令；孪生守卫报错含清理指引（切片 1）；G4 报错指向白名单与约束 id；C-proc-08 文案含升级必查两项 |

P1 抽查：P1-1 通过（§3.1 代码块样例）；P1-2 弱通过（U 表无「为什么这么拆」专列，但交付顺序段+依赖列隐含理由，与切片 1 的显式列相比退步）；P1-3 通过；P1-4 见 SUGGESTION；P1-5 通过；P1-6 通过（resolveAvailableLevels/同构 switch 删除、探针挂总闸无成本论证，减法意识在）；P1-7 可接受（切片 2 寄居本文档是层声明显式决策，D2-D4 深度即技术方案层，未跨两层）；P1-8 两条 → SUGGESTION；P1-9 通过（D1-D8 四件套 item 化）；P1-10 通过（P-S3①② 篡改反向、P-S5 假模型反向、P-S4 拦截演练）。

## 三个重点维度专项评估（任务指定）

### 1. 设计思路

- **同根认定成立，非强行归类**。§2.3 表的四个关键事实全部实读命中：① undefined 语义相反——pi `models.js:549` `!model.reasoning → ["off"]` vs 前端 `thinking-levels.ts:73` `reasoning === false` 才 off（:65 docstring 明写「undefined 视为 true」）；② gc 坍缩三处同构推导（切片 1 已核实）；③ 「登记≠防御」——troubleshooting.md 观察项 5 条实存（:218 起，#4 thinking 钳制 2026-08-20）且无任何机器接线；④ 「runtime 已做对、renderer 最后一跳丢弃」——settings-message-handler:402 回传 effective 与 protocol.ts:1681 void 映射同时实读确认。两起事故在「跨边界承诺无受理确认」层面的同构性经得起核对。
- **四支柱是消除问题类还是转移复杂度**：总体是消除——D2 用同源函数把「第二套规则」物理删除（不是对齐后保留两套），D3 把「请求-生效」升为协议不变量，D6 把人读登记升为机器红灯。转移复杂度的部分（注册表服务面、探针族维护）都有 out-of-scope 边界（bash/compact 等能力面明示不做）。弱点即 MF-1/MF-2：支柱四的覆盖面（scheduler）与自身版本一致性（pi-ai pin）各有一个洞。
- **分层**：程序层/切片层引用干净——对切片 1 只引结论（D1/D4/D5、B-ledger、4 must-fix + 5 suggestions 已落盘），与切片 1 文档及 review.md 实际内容一致；切片 2 寄居本文档是显式层声明显式决策。

### 2. 方案长期性

- **runtime→pi-ai 直接依赖（P-C1）是否最优**：在 CR-rpc-only（无进程可查时设置页瘫痪）与 CR-align（影子原样保留）之间，同源函数是唯一同时满足「离线可用 + 零影子」的形态，diff-probe 实证可 import。三个月后看不会骂人的前提是 MF-2 修掉（版本分裂会让「同源」变成「同名不同源」——那才是要骂人的形态）。P-C1 降级路径（纯在线 + 可用性妥协）诚实且语义保真。
- **「语义自动跟随」**：单包 bump 场景成立（pi-mono 同步发版）；分裂场景不成立（MF-2）。
- **rotting 风险**：探针红了谁来判断「适配」还是「掩盖」——review 级极限，所有测试守卫共有，非本设计特有；verifiedWith 纪律的机器化程度见 SUGGESTION（防线分层声明 + 可选软门禁）。比现状（零守卫）严格单调改进。
- **更简终态是否被漏掉**：在线对账 only（CR-rpc-only 已对比否决）；pi RPC 直查档位（get_available_thinking_levels 只对「当前模型」有效，无 session 时不可用，与 CR-rpc-only 缺陷同构，P-D2 检查点已覆盖短命进程变体）；bump PR 人工跑脚本（未显式入对比，SUGGESTION 补录——否因即 8-20→8-27 实证）。

### 3. 护栏可落地性（G1-G7 逐条核对结论）

- G1：install-hooks.sh 实读——heredoc `:46-:1034`、i18n 段 `:958-1019`、「全部通过」段 `:1023-1028`，「i18n 段后插入」落点存在且在通过段之前；「R1 后不设独立 SKIP_*」惯例属实（`:649-653` 注释原文「不设独立跳过开关……仅受既有 SKIP_ALL_CHECKS 总闸管辖」）。挂 CI invariants 可行（check 为零依赖 node 读 node_modules，无 git index 依赖，与 invariants 既有「直调自包含脚本」模式吻合，`ci.yml:312` 起 job 结构实读确认）。
- G2：pi-paths 探针头注（`:16-32`）实读确认「静态读 dist / skip 不 fail / 不进 REAL_PI_TESTS」范式存在且描述一致。
- G3：diff-probe 确认无任何自动调用方（package.json/CI/hooks 零命中），接线必要性成立；触发条件在 U6 删除 thinking-levels.ts 后切到 model-capability.ts 已声明（但见 MF-3——文件删除粒度需先修正）。
- G4：exit 0/2 范式与 `.githooks/check_*.py` 既有惯例一致；正则误报面靠白名单收敛的设计合理，提示：测试文件中的 deliverAs 模拟串可能需要进白名单（实施细节）；扫描范围不覆盖 scheduler（MF-1）。
- G5：REAL_PI_READY 实存（pi-fixture.ts 导出，equivalence 族 `describe.skipIf(!REAL_PI_READY)`）；vitest.config.ts:22-34 REAL_PI_TESTS 数组与「守卫测试强制」先例（session-manager-e2e-fixture-unit.test.ts:29 双向 diff）均实读命中。
- G6：诚实停在 review 级（机器判定「改状态」语义不可靠），protocol.ts 注释指约束的挂法与现状注释风格一致。
- G7：render-constraints.mjs `:46-51/:87-89` machine hook 存在性校验实读确认；「同 commit 或护栏先行」**不死锁**——pre-commit `:770-772` 在 constraints.json 变更时触发该校验，校验读工作树文件，同 commit 内脚本+登记俱在即通过。四个新 id（C-pi-12/C-pi-13/C-ext-19/C-proc-08）经查均未被占用。
- **ci.yml paths-ignore 含 docs/** 的盲区**：评估为**可接受**。单独 push 一个 docs-only commit（如只改 verifiedWith）确不触发 CI，但该篡改只在 pi 版本已变时才有意义，而 pi bump 必含 package.json/lockfile 变更 → PR 整体触发 CI → invariants 跑 check-pi-semantics → verifiedWith 旧值红灯；即便裸 push main，下一个非 docs commit 的 CI 也会收网。文档已诚实登记为已知边界，无需升级为 finding。

## 事实抽查清单（49 处，命中 47 / 偏离 2）

**pi dist 侧（19 处）**：

| # | 断言 | 锚点 | 结论 |
|---|------|------|------|
| 1 | 两级门控 `!model.reasoning → ["off"]` | pi-ai dist/models.js:548-550 | 命中（getSupportedThinkingLevels :548，条件 :549-550） |
| 2 | clampThinkingLevel 就近回落 | models.js:560-578 | 命中 |
| 3 | get_available_models 返回 `{models}` | rpc-mode.js:380-382 | 命中 |
| 4 | set_thinking_level 响应无 data | rpc-mode.js:387-389 | 命中（:389 success 无第二参） |
| 5 | get_state 不含 models 清单（PS-10） | rpc-mode.js:344-359 | 命中（state 字段实读无 models） |
| 6 | get_available_thinking_levels | rpc-mode.js:398-400 | 命中 |
| 7 | settled 先复位再发（PS-07） | agent-session.js:327-331 | 命中（:328 复位 / :330-331 emit） |
| 8 | nextTurn 声明/入队/注入清空（PS-06） | agent-session.js:95/:1079/:880-883 | 命中（全文仅 3 处，grep 证实） |
| 9 | sendCustomMessage 四分支 + 直达（PS-08） | agent-session.js:1068-1098/:1089-1090 | 命中 |
| 10 | isChanging=false 不发事件（PS-04） | agent-session.js:1275-1294 | 命中 |
| 11 | steeringQueue 仅 2 个 drain 点（PS-05） | pi-agent-core agent.js:243/:321 | 命中（grep drain() 恰 2 处） |
| 12 | plain custom entry 不进上下文（PS-09） | session-manager.js:166-186 | 命中（:177 仅 custom_message 返回消息） |
| 13 | 延迟首写（PS-14） | session-manager.js:724-752 | 命中（_persist hasAssistant 分支） |
| 14 | Model.reasoning / thinkingLevelMap（PS-10） | pi-ai types.d.ts ≈:667/:672 | 命中（dist/types.d.ts，interface Model 内） |
| 15 | PS-12 的 types 锚 | types.d.ts:257 | **偏离**：:257 是 Usage.output；ThinkingLevel 在 :23 |
| 16 | compat 临时入口自声明（PS-15） | pi-ai dist/compat.js 头注 | 命中（"deleted with the ModelManager migration"） |
| 17 | `--model <pattern>`（PS-01） | cli/args.js:245 | 命中 |
| 18 | id 匹配 toLowerCase 相等（PS-01） | model-resolver.js:97 | 命中；但「tryMatchModel:291-463」**偏离**（:291 是 resolveCliModel，tryMatchModel 在 :104） |
| 19 | SIGINT ignoreSigint（PS-13） | interactive-mode.js:3193-3223 | 命中（handleCtrlZ :3204-3205） |

**xyz 侧（30 处）**：

| # | 断言 | 锚点 | 结论 |
|---|------|------|------|
| 20 | setThinkingLevel reply 映射 void | shared protocol.ts:1681 | 命中 |
| 21 | 乐观写请求值 | useModel.ts:66-69 | 命中（:68 applySnapshot） |
| 22 | undefined 视为 true | core thinking-levels.ts:65/:73 | 命中（与 pi :549 相反语义成立） |
| 23 | addModel 五字段无 reasoning | use-provider-edit.ts:546-561 | 命中 |
| 24 | runtime 回传 effective | settings-message-handler.ts:397-404 | 命中（:399-400 注释原文一致） |
| 25 | set→get_state→effective 链路 | session-service.ts:624-645 | 命中（且段内无日志语句——SUGGESTION 依据） |
| 26 | 写盘白名单已含 reasoning | provider-config-helper.ts:584-589 | 命中（`!== undefined` 判定） |
| 27 | 配置聚合三源 | provider-config-helper.ts:268 起 listProviders | 命中 |
| 28 | 表单全文无 reasoning | ModelListSection.vue | 命中（grep 零匹配） |
| 29 | 档位读 config 推算 | model-thinking.ts:144-152 | 命中 |
| 30 | Popover 本地推算 | ThinkingLevelPopover.vue:101-104 | 命中（resolveAvailableLevels 调用） |
| 31 | 30s 周期兜底重拉 | replicated-states.config.ts:57-59 | 命中（THINKING_LEVEL_POLL_INTERVAL_MS=30_000） |
| 32 | REAL_PI_TESTS 分池 | runtime vitest.config.ts:22-34 | 命中 |
| 33 | REAL_PI_READY 凭证门控 | pi-fixture.ts 导出 | 命中（equivalence 族 skipIf 用法实存） |
| 34 | paths-ignore 含 docs/** | ci.yml:3-17 | 命中（push+PR 双段） |
| 35 | invariants job 既有模式 | ci.yml:312-425 | 命中（直调自包含脚本 + 等效实现） |
| 36 | heredoc / i18n 段 / 全部通过段 | install-hooks.sh:46/:1034/:958-1019/:1023-1028 | 命中 |
| 37 | R1 后不设独立 SKIP_* 惯例 | install-hooks.sh:649-653 | 命中（注释原文） |
| 38 | machine hook 存在性校验 | render-constraints.mjs:13/:46-51/:87-89 | 命中 |
| 39 | 全等匹配 + glob 仅前缀 | select-constraints.mjs:67-68 | 命中（`packages/**/tsup.config.ts` 确不支持） |
| 40 | constraints 76 条 / 新 id 未占用 / C-pi-02 仅 review / C-build-01 scope 含不存在的根 tsup.config.ts | docs/constraints.json | 全命中（76 精确；C-pi-12/13、C-ext-19、C-proc-08 空闲；C-build-01 enforcement 含 machine+review） |
| 41 | tsup.config.ts 实装三处 | packages/{runtime,extension-protocol,session-delivery}/tsup.config.ts | 命中（根无，D8 漂移修正声明成立） |
| 42 | diff-probe 双实现比对 + 无调用方 | diff-probe-thinking.mjs:16-18 | 命中（package.json/CI/hooks 零引用） |
| 43 | deliverAs 条文 | extension-conventions.md:130-152 | 命中（steer/followUp 表格 :141-148） |
| 44 | 观察项 5 条（#4=2026-08-20 thinking 钳制） | troubleshooting.md:218-250 | 命中 |
| 45 | 探针范式先例（skip 不 fail/不进分池） | pi-paths-config-dir-contract.test.ts:16-32 头注 | 命中（另发现「pi 包根声明、runtime 不可 import」既有格局——SUGGESTION 依据） |
| 46 | 守卫测试双向 diff 先例 | session-manager-e2e-fixture-unit.test.ts:29-78 | 命中 |
| 47 | plugin 通道入口 | plugin-rpc-setup.ts:233-240 | 命中 |
| 48 | rpc-client 未封装 get_available_models（零命中） | runtime infra/pi/rpc-client.ts | 命中（grep 空） |
| 49 | 根 package.json 精确 pin / builtin 数据字段覆盖 / scheduler steer 现状 / models.json 路径 / 基线 session 存在 / plugin-host:490 30s monitor | package.json:31-32 等 | 命中（builtin 1220 模型 100% 带 reasoning+map；scheduler :97-99 steer 实存——MF-1 依据；~/.xyz-agent/pi/agent/models.json 路径正确——P-S1 可执行） |

未核项：PS-16（fork 路径 spawn 透传，observe 级、待产品裁决，不涉方案成立）；「pre-commit 21 项检查」的具体口径（CHECKER 变量 18 个 + 内联若干，数量级吻合，背景陈述不影响决策）。

## 结构化结论

```json
{ "report_file": "docs/design/pi-boundary-reliability.review.md", "must_fix": 3, "suggestion": 8 }
```
