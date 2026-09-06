# composer-model-session-isolation 设计审查报告（r3）

- 审查对象：`docs/design/composer-model-session-isolation.md`（含 impl-plan 实施现状交叉审查）
- 审查轮次：第 3 轮（r1 三条 must-fix 全修、r2 零 must-fix 已裁决项不重开；本轮新增攻击面 = U5 blocked）
- 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`
- 日期：2026-09-04

## Summary

1 must-fix, 3 suggestions.

**核心裁决（r3 特别重点）**：设计 D5「armed 入口快照门禁」**与现行源码兼容、按设计原文可直接实现，不存在设计层缺陷**。impl-plan §6 U5 的 blocked 诊断（「门禁 getArmed() 恒 null」）与源码事实矛盾——该症状只在门禁误读**消费块之后**的 armed 值时成立，而这恰是 D5 被否③ 明确禁止、且 D5 采用段显式预警过的实现方式（§3.3 D5：「不能用消费块之后的 armed 值……读后值会让『记忆未命中的显式切换』误入只读分支」）。U5 应按设计原文重实现，不需要设计修正。详见下方「D5 根因裁决」。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | impl-plan §6 U5 行 / 状态表 | P0-11 事实 | blocked 诊断错误：「consume 所有路径均 clearArmed → 门禁取值恒 null」两个事实均不成立。① 并非所有路径都清——规则 3（模型未到达目标）不清 armed（`thinking-level-sync.ts:122-125` 直接 return false 不动 armed）；② 门禁恒 null 只在门禁读**消费后** armed 值时发生——`thinking-level-sync.ts:182` `const armed = deps.getArmed?.() ?? null` 本身就是 consume 执行前的入口快照，consume 内部的 clearArmed 不影响该局部变量。据此 blocked 的「需设计修正」结论不成立，D5 按原文可实现 | U5 按设计 D5 原文重实现：复用回调顶部已有的 `armed` 局部变量作门禁（consume 块之后加 `if (!armed) return` 即覆盖分支 2/4/5）；同步更正 impl-plan §6 U5 记录与残留风险 R5 表述 |
| SUGGESTION | 设计 §3.3 D5 边界 | P1-10 / P0-16 | **providers 迟到两步到达窗口未登记**：显式切换后若 map/supported 分两次到达（首个触发 map=undefined），首个触发即把 armed 消费/清除（命中路径按默认五档 fallback 提前 onReset；未命中路径走分支 3 后 armed 已清），第二次触发（真 map 到达）被门禁拦 → 该次显式切换的同体系映射/跨体系重置 one-shot 丢失，session 保持 pi 侧生效档。D5 边界段只登记了「分支 3 错钳窗口」，未覆盖此窗口 | D5 边界段补登记（与既有错钳窗口同格式：现状等价性论证 + V4/Gate B 偶发红时的排查锚点）；若要根治可考虑门禁对「armed 已清且本次触发 oldMap!==undefined 且模型确实变化」放行，但先登记再评估，不强制 |
| SUGGESTION | 设计 §3.3 D5 | P0-12 对抗（降级：非回归） | 门禁判据「入口 armed 快照存在」是「本触发=显式切换」的**近似而非精确判据**：armed 在途（规则 3 不清）期间，providers 无关刷新触发的分支 4/5 会因快照非 null 放行；规则 1 过期清的同触发内门禁同样放行。行为与现状（无门禁）等价、非本设计引入的回归，但 V3 负面验证在这类窗口偶发红时会被误判为门禁失效 | D5 采用段补一句显式声明「门禁为一次性抑制启发式，覆盖显式切换的主路径时序；armed 在途窗口内的无关触发放行属现状等价」，给 V3 排查锚点（先查该时段是否恰有 armed 在途） |
| SUGGESTION | 设计 §3.3 D2 / §3.5 E2 | P1-8 事实（实现↔设计漂移） | restore 兜底链实现与设计文字不符：设计 D2/E2 写「仍无则维持现状的全局默认兜底」，实现 `session-lifecycle.ts:862-872` 在 sidecar **仅 thinkingLevel 有值**时播种 `modelId: ''`（空串占位，阻断 registerSession 的全局默认兜底，见 `:858` 同构），且注释自称「不回落全局默认——D2 裁决」——设计无此裁决，属虚构引用；而 sidecar **双无值**时又走 undefined → registerSession 全局默认（`:872` 注释）。两个子分支行为不一致 | 按「设计错还是实现错」裁决：单字段缺失播种 '' 更贴 G4（不显示假值），建议把 D2/E2 文字改为「双失败→占位空串/全局默认」的精确表述并消除两子分支不一致；同步删除代码注释中虚构的「D2 裁决」引用（实现侧修正，随 U5 解 block 同批） |

已核对无漂移（抽查项）：D1 矩阵四列（`session-binding-fields.ts:131-146` create/handoff/fork='options'、restore='none' 与设计一致）；D1 sidecar 家族（`session-file-utils.ts:264/449` modelSidecarPath/persistModelBinding）；D4 广播移除（`model-service.ts:104`）；D2 读回播种主干（`session-lifecycle.ts:832-881`）；D3 分流（`model-thinking.ts:189-210`，已按 U4 提交形态核对）。

## D5 根因裁决（r3 特别重点，附代码证据）

**结论：U5 blocked 的根因是实施把门禁判据接到了消费块之后的 armed 值（或等效地在各分支内重新调 getArmed），不是设计缺陷，也不是存在更早的 armed 消费点。**

证据链：

1. **入口快照已存在于源码结构中**：`thinking-level-sync.ts:182` `const armed = deps.getArmed?.() ?? null` 位于 `consumeArmedRestore` 调用（`:185`）之前，正是 D5 声称的「回调入口时的 armed 快照」。consume 内部三处 `deps.clearArmed?.()`（`:119/:133/:138`）只清 `model-thinking.ts:138` 的 `armed` ref，不影响该局部变量。
2. **「所有路径均 clearArmed」不成立**：规则 3 模型未到达目标时（`:122-125`）不动 armed 直接 return false；规则 2 匹配未命中/幂等/不可用（`:137-139`）与规则 1 过期（`:117-121`）才清。armed 的其他防线（换绑清 `model-thinking.ts:163-165`、成功/失败清 `:373/:378`）都在 watch 回调之外或之后，不构成「更早消费点」——换绑清 watch（`:163`）注册先于 sync watch（`:230` 委托入口），同 flush 内先执行，恰好保证换绑触发时入口快照为 null，是设计依赖的正确顺序而非冲突。
3. **「恒 null」症状的充要条件**：门禁读到 null 的唯一方式是取值发生在 consume 之后（或分支内重新 getArmed）——即 D5 被否③ 描述的实现。U5 尝试已回退零残留（git log 中无该 commit），无法直接取证其代码形态，但症状与被否③完全吻合，且设计采用段已预防性禁止该写法。

**修正建议（最小实现）**：watch 回调在 consume 块之后、既有分支之前加一行 `if (!armed) return`（复用 `:182` 局部变量；可更名 `armedSnapshot` 表意）。五类触发路径行为推演：

| 触发路径 | 入口快照 | consume 结果 | 门禁后行为 | 判定 |
|---|---|---|---|---|
| 显式切换·记忆命中 | 非 null | true（已 onReset 记忆值并 return） | 不达门禁（`:195` return） | ✔ V4③ |
| 显式切换·记忆未命中 | 非 null | false（已清 armed，回落） | 门禁放行 → 分支 4/5 照常对齐 | ✔ V4④ |
| 切 session 焦点（换绑） | null（换绑清 watch 先执行，`model-thinking.ts:163` 注册序先于 sync watch） | 不进入 consume | 分支 2/4/5 全跳过，无 setThinkingLevel RPC | ✔ V3 |
| landing 初值（挂载/无 armed） | null | 不进入 consume | 分支 2 跳过；初值由 `followRememberedOrDefault`（`model-thinking.ts:280`，immediate）覆盖 | ✔ 设计 D5「双路径冗余」论证成立 |
| providers 迟到（两步到达） | 首触发非 null / 次触发 null | 首触发消费或回落清 armed | 首触发分支 3 兜底一次；次触发被拦 → 对齐 one-shot 丢失（见 SUGGESTION #2，边界登记项而非门禁缺陷） | △ 与现状差异已列边界 |

## 验收章节审查（P0-13/14/15）

通过。V1-V6 均为真实场景（真实 Electron app + 真实 pi 子进程 + 截图/文件/日志三类可操作断言），每场景回溯 G1-G4；V3/V5 为可执行的负面验证（grep 日志断言「无 set_thinking_level」「无 config.defaults 帧」），V4 覆盖命中+未命中双路径；投入与 ~13 文件改动匹配。A1 探针降级路径的排查指引在 U5 按裁决重实现后即可按原文使用（其第一条「检查门禁是否误读消费块后的 armed 值」正是本次 blocked 的实因，设计预判准确）。

## 判定四态汇总（P0 清单）

P0-1/2/3 结构与 delta 链：通过（r1/r2 已裁，本轮无重开证据）。P0-4/5/6 问题定义与视角：通过（§1 忠于真实问题，§2 六机制有日志实证）。P0-7/8/9 方案对比：通过。P0-10 因果链：通过（D1-D6 与六机制逐条对应）。P0-11 关键事实：见 MUST_FIX #1（impl-plan 侧事实错误；设计文档本体本轮新核事实无误）。P0-12 副作用：见 SUGGESTION #2/#3（边界登记缺口，非阻塞）。P0-13/14/15 验收：通过。P0-16/17/18：通过（A1-A5 探针 + 两张物理数据流图 + E1-E6 恢复指引；A1 降级路径有效性依赖 U5 按裁决重实现）。

## 结论

设计文档 D5 无需修正，DoR 维持；U5 解 block 的正确路径 = 按设计原文以入口快照实现门禁并更正 impl-plan 记录。三条 suggestion 均为边界登记/文字校准，可随 U5 重实现同批吸收。
