# composer-model-session-isolation 设计审查报告（r4，聚焦复审）

- 审查对象：`docs/design/composer-model-session-isolation.md` + `docs/design/composer-model-session-isolation.impl-plan.md`（r3 修订后的聚焦复审）
- 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`
- 范围声明：仅核验 r3 四条 findings 的修复 + 任务书列出的四个聚焦攻击点；r1/r2/r3 已裁项（D1/D3/D4/D6 机制、V1-V6 验收结构）不重开。实现侧代码（session-lifecycle.ts 双无值分支、thinking-level-sync 守卫落地）按任务书约定不在本轮范围，只审设计/计划文字语义自洽。
- 日期：2026-09-04

## Summary

2 must-fix, 1 info.

**结论：r3 四条 findings 的修复主体全部到位且经源码反例重演成立（含修订方自行否掉 r3 修复建议的两个反例，均核实无误）；但「全局默认末级兜底移入被否谱系」这一 r3 校准只改了 D2/E2 正文，设计 §5 U2 行与 impl-plan §2 U2 行的「兜底链 sidecar→全局默认」文字残留，且随 U5 解 block 同批执行的 session-lifecycle.ts 实现侧修正没有登记进 impl-plan 的任何单元领地或残留风险表——执行层有丢失该连带改动的风险。修掉这两处文字/登记后设计即就绪。**

## r3 findings 逐条核验（全部通过）

| r3 finding | 修复位置 | 核验结果 |
|---|---|---|
| MUST_FIX（U5 误诊） | impl-plan §6 U5 行 + R5 + §0 + 变更历史 | ✅ 四处一致：U5 = pending + 误诊根因（门禁取值误接消费块后 = D5 被否③形态）+ 按分支守卫形态；R5 改为「取值时点」锚点并指回 D5 被否③；与设计 D5 采用段文字零漂移 |
| SUGGESTION #2（providers 迟到两步到达） | 设计 D5 边界段 | ✅ 已登记（窗口描述 + 窄度论证 + V4/Gate B 排查锚点）；「被否的根治候选」重演核实成立（见下「反例 A/B 复核」） |
| SUGGESTION #3（启发式声明） | 设计 D5 采用段 bullet | ✅ 已声明「一次性抑制判据，非精确归因 + 现状等价 + V3 排查锚点」，与边界段错钳窗口不重叠（采用段讲 armed 在途放行，边界段讲 armed 已清拦截，互补） |
| SUGGESTION #4（D2/E2 兜底链） | 设计 D2 采用段/被否谱系 + E2 | ✅ 正文已按字段粒度改「读回值 → sidecar 值 → 空串占位」，全局默认末级兜底移入被否谱系并给击穿理由（机制④残余假值，违 G4）；**但 §5 U2 行残留旧文字（见 MUST_FIX #1）** |

## 反例 A/B 复核（修订方自行推演，本轮独立验证）

**A. 按分支守卫形态：成立。** 源码核实（`thinking-level-sync.ts`）：

- 分支结构定位无误：分支 2 = `:200` `if (!current)`；分支 3 = `:207` `oldMap === undefined`；分支 4 = `:217` 同体系；分支 5 = `:236` 跨体系。`:182` `const armed = deps.getArmed?.() ?? null` 即 consume 执行前的入口快照。
- r3 建议的「consume 块后单点 `if (!armed) return`」确会击穿分支 3：挂载首触发（immediate watch，armed 恒 null）会整体 return，分支 3 声明的两个可达场景之一（挂载首触发）被消灭，安全网失效——修订方否掉 r3 写法、改用按分支守卫（分支 2 内 + 分支 4/5 前）的理由正确。
- 分支 3 两场景可达性核实：mount（armed null，无守卫照常执行）✅；显式切换 + providers 迟到（armed 非 null，分支 3 无守卫照常执行）✅。
- 第四触发路径排查：watch 源仅 `[map, supported]` 两轴，全部触发形态（挂载首触发 / 模型切换 / providers 无关刷新 / supported 单轴变化）都被 分支 2/3/4/5 + consume 块穷尽，无被守卫误伤的第五路径。armed null 时分支 4 内层「不可用→重置」安全网也被跳过——这是「对齐只挂显式切换」语义的直接推论，属设计意图（D5 采用段明列分支 4 被门禁），非缺陷。

**B. 按字段空串占位：成立。** `session-lifecycle.ts:267` `metaOverride?.modelId ?? modelOverride ?? fallbackModelId`——空串非 nullish，`??` 短路阻断 `fallbackModelId`，播种 `''` 生效；composer `regularModelId`（`model-thinking.ts:203-206`）已建态 `?? ''` 占位，不回落 landing 残留/全局默认；快照收敛（`session-state-projection` 回退链）自愈。极端组合（双无值 + get_state 失败 + pi 无模型）占位持续，裁决「诚实占位优于假值」与 G4 一致。与 E3（undefined 占位）、V2（全程不出现他 session 模型）语义自洽。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | 设计 §5 U2 行 | P0-2 delta 链 / P1-5 内部一致性 | U2 行仍写「兜底链 sidecar→全局默认，实现在 D2 内部」，与同文档已按 r3 校准的 D2 采用段/E2（「空串占位，不播种全局默认」）直接矛盾。同一文档内新旧两套兜底链并存，实施者按哪段执行产生分叉 | §5 U2 行兜底链文字同步为「sidecar 值 → 空串占位（r3 校准）」 |
| MUST_FIX | impl-plan §2 U2 行 / §6 / §7 | P0-12 遗漏（连带改动登记缺失） | 三处漂移：① §2 U2 职责与验收条款仍写「兜底链 get_state→sidecar 扫描值→全局默认」「双失败回落全局默认」——按 r3 校准后的设计这是**错误**的验收断言（应为空串占位）；② 设计 D2 明文「实现侧 session-lifecycle.ts restore 兜底随 U5 解 block 同批对齐此语义」，但该连带改动未登记进 impl-plan 任何单元领地（U5 领地仅 thinking-level-sync.ts + 测试）或残留风险 R 表——执行层读计划无从得知该欠账，U5 重实现批次会漏掉它；③ §6 U2 行 committed 证据按旧语义记录却无「语义待对齐」标记 | ① §2 U2 行兜底链/验收文字同步为空串占位语义；② 把「session-lifecycle.ts restore 双无值分支统一播种 ''/'' + 删除虚构『D2 裁决』注释」登记进 U5 行（领地扩列）或新增 R6 残留风险，明确随 U5 解 block 同批执行；③ §6 U2 行加「（兜底链语义按 r3 校准，对齐随 U5 批次）」标记 |
| INFO | 设计 D5 边界段「providers 迟到两步到达窗口」 | P1-8 表达精度 | 「第二次触发被门禁拦截」为粗粒度描述：若两步到达形态是 supported 先到、map 后到，第二次触发 oldMap 仍 undefined，落的是**不门禁的分支 3**（可用性安全网仍可达，仅同体系/跨体系对齐 one-shot 丢失）。「对齐 one-shot 丢失」的结论本身准确，不修正也不影响决策 | 可选：边界段补一句「第二次触发若 oldMap 仍 undefined，分支 3 安全网照常可达」 |

## 聚焦攻击点 3 复核（D5 边界段三处登记互检）

无矛盾无重叠：采用段启发式声明讲「armed 在途 → 无关触发放行」（放行侧）；边界段错钳窗口讲「分支 3 不门禁 + providers 迟到 → 错钳 RPC」（现状等价侧）；两步到达窗口讲「armed 已清 → 对齐被拦」（拦截侧）；被否根治候选的三条件同构重演（换绑清 → armed null、oldMap = A 体系、模型变化）与 `model-thinking.ts:163-165` 换绑清 watch 注册序先于 sync watch（`:230` 委托）核实一致，放行确会复活机制 ⑤。四处分别覆盖 armed 生命周期的不同相位，MECE。

## 结论

**2 must-fix，设计暂不就绪**——但两条均为文字同步/登记缺口（U2 行兜底链残留 + 连带改动未入计划），零方案层问题：D5 按分支守卫形态、D2 按字段空串占位、边界登记结构均经本轮独立反例重演成立。修完这两条登记（约十行文字）即可宣布 0 must-fix / 设计就绪，无需 r5 全面重审。
