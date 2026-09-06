# 对抗式审查报告（第 2 轮聚焦复审）：composer per-session 模型/思考档位状态隔离与持久化

> 审查对象：`/tmp/design-composer-model-session-isolation.md`（第 1 轮修复后修订版）
> 对照基线：`review-r1.md`（3 must-fix + 4 suggestion + 1 INFO）
> 方法：重读修订全文，逐条核对修复；对修订方自列的三个攻击点（D5 分支 2/3 时序组合 / D1 restore='none' 旁路风险 / V4 步骤④快照语义）做源码级攻击；交叉引用一致性五处终检。声称事实错误前已 read 源码核实。

## Summary

0 must-fix, 3 suggestions（另 1 条 INFO）。上一轮 3 must-fix + 4 suggestion + 1 INFO **全部修复且修复成立**——无一处修复被新反例击穿。三个指定攻击点中两个守住（D5 时序组合良性、快照语义无歧义），一个暴露出**表述级偏差 + 未登记的既有边界**（SUGGESTION#2，非设计缺陷：该边界为现状行为，本设计不改变它）。复审另发现两处遗漏的连带改动（删除清理清单、守卫契约清单），均为 SUGGESTION 级。

## 修复核对（上轮 8 项 → 全部确认成立）

| 上轮编号 | 修复内容 | 核对结论 |
|---|---|---|
| MUST_FIX#1 | `.meta.json` → 独立 `.model.json` + persistBindingSidecar 家族 + 五处同步 + 被否谱系登记击穿反例 | ✅ 成立。`persistBindingSidecar`（session-file-utils.ts:271）骨架引用准确；被否谱系的两条反例（persistSessionEnd 全量覆写每 turn 触发、restoreSession unlink）与源码一致；`.model.json` 命名契合家族先例（.preset/.project/.handoff/.agent.json），无命名冲突；usage-stats 与 isScannableSessionFile 均按 `endsWith('.jsonl')` 过滤，新 sidecar 天然不进 session 扫描（已核实，无需连带改） |
| MUST_FIX#2 | D4 两消费点 + toast 副作用显式声明 + V5 toast 断言 + 检查点措辞改为「以实施期 grep 为准」 | ✅ 成立。ProviderPage.vue:369 引用准确；「default-set/provider 对账路径不受影响」与 settings-message-handler.ts 的广播生产点分布一致（对账广播独立于 ModelService.switchModel） |
| MUST_FIX#3 | 四列矩阵显式取值（create/handoff/fork='options'，restore='none'）+ D2 兜底链内部实现 + E6 同步 | ✅ 成立。restore='none' 使 hydrateBindingMeta 在 restore 入口跳过两字段（矩阵层固化）；fork 引用行号 936-940/997 与源码吻合（buildPresetClientOptions 透传 override + registerSession 传 presetClientOptions.model）；handoff-service.ts:275-276 确实透传 modelOverride/thinkingOverride 进 create，handoff 列='options' 有代码依据 |
| SUGGESTION#4 | armed 入口快照（consumeArmedRestore 前捕获局部变量）+ 分支覆盖 2/4/5、分支 3 不门禁 + 未命中裁决 + V4 步骤④ + 被否③ | ✅ 成立（快照语义核对见下「攻击点 c」） |
| SUGGESTION U7 | U0 约束登记前置到 P1 最前 + render-constraints.mjs 随首次提交 | ✅ 成立，符合「先登记再写代码」纪律 |
| SUGGESTION A3/A4 | A3 补缓存失效接线检查、A4 补第二生产点 grep 处置 | ✅ 成立 |
| SUGGESTION D3 | regularThinkingLevel 已建态不再回落 localThinkingLevel + ThinkingLevelPopover 占位 + 文件地图补行 | ✅ 成立，与 D5 分支 2 门禁配套自洽 |
| INFO×3 | ~30ms/77ms 时序、行号 88-108、renderer-KV「双写不同步」+ lastUsedModel 判据差异 | ✅ 均已修正 |

**交叉引用一致性五处终检**：正文决策（D1/D2/D3/E6）、§3.4 终态数据流图、§3.5 错误规格表（E1/E2/E3/E6）、§5 拆分单元表 U1 + 文件改动地图、§4 验收（V1 cat 断言 / V2 构造步骤 / V4 步骤④ / V5 toast）——`.model.json` 与四列矩阵取值**五处全同步**，无残留 `.meta.json` 引用（仅 D1 被否谱系与 §2.3 术语定义中的 `.meta.json` 为正当历史/现状引用）。

## 指定攻击点结论

**（a）D5 门禁覆盖分支 2 后的 landing/已建时序组合——守住，且攻击前提本身不成立**。修订方设想的「providers 未加载时 followRememberedOrDefault 会写 'max'」与源码不符：`thinking-levels.ts` 的 `DEFAULT_SUPPORTED_LEVELS` 是 off/minimal/low/medium/**high** 五档（无 xhigh/max），`highestAvailableLevel(undefined)` 返回 **'high'**——landing 初值落 'high' 而非 'max'。随后 map/supported 到达触发分支 3（不门禁）：'high' 在绝大多数真实模型可用集内 → 无 onReset；唯一触发场景是「真实模型可用集不含 high」（如 non-reasoning 模型归一为 ['off']）→ 一次本地纠正（landing 无 session、无 RPC、不入记忆表），**良性且正确**。已建 session 侧：followRememberedOrDefault 被 `if (sessionId.value) return` 守卫，'max'/'high' 残留路径不存在；已建 + providers 迟到的分支 3 行为见 SUGGESTION#2 的既有边界登记。landing→已建（首发创建）与 5s 换绑边界维持上轮结论（armed 在选择时同步消费 / 边界已显式声明）。

**（b）D1 restore='none' + D2 内部兜底链——守住，旁路风险被矩阵 + 守卫测试双层固化**。'none' 使 hydrateBindingMeta 在 restore 入口对两字段结构性跳过；未来「补回填」需改矩阵值（显式注释决策点），且 U8 含 BINDING_FIELDS 矩阵守卫测试——比扩 'resolved-in-entry' 枚举的漂移面更小（枚举值反而给「顺手回填」开了合法通道）。遗留一个小缺口见 SUGGESTION#3（alternatives 记录）。

**（c）V4 步骤④的入口快照语义——无歧义**。修订文本「回调入口时的 armed 快照（`consumeArmedRestore` 执行前捕获的 `getArmed()` 值，存局部变量）」+ 被否③（明确拒绝读消费块后的值）+ V4④ 验收（未命中路径按对齐规则落位）三处互相咬合，实施者无法从文本推出第二种读法。命中路径（consumeArmedRestore 返回 true 提前 return）与门禁的正交性也自洽。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION【新发现】 | §3.3 D1 写点清单 / §5 U1 + 文件改动地图 | P0-12 连带改动遗漏 | **删除路径的 sidecar 清理清单缺 `.model.json`**。`session-lifecycle.ts:587-599` `purgeSessionSidecars`（注释明示「delete 是唯一清理点，防孤儿 sidecar」）按显式后缀清单清理 `.meta.json`/`.preset.json`/`.project.json`/`.handoff.json`/`.agent.json`——新 sidecar 不加入则删除 session 留孤儿 `.model.json`（纯磁盘垃圾，无正确性影响：扫描/统计均按 `.jsonl` 后缀过滤，孤儿不可见，但违背该函数自身的清理承诺）。fork 路径同理需确认：forkSession 对 forkedFilePath 防御性 unlink `.meta.json`/`.agent.json` 并写 preset/project sidecar，D1 写点④落位时应同批 | U1 内容补「purgeSessionSidecars 清单 + `.model.json`」与「forkSession sidecar 写点落位」；文件改动地图 session-lifecycle.ts 行补注 |
| SUGGESTION【新发现】 | §3.3 D5 采用段（分支 3 说明） | P0-11 表述精度 + 既有边界未登记 | **「分支 3 仅在 composer 挂载首触发可达」不精确，且该窗口存在一个未登记的既有错钳边界**。源码级事实：分支 3 的触发条件是 `oldMap === undefined`，而 oldPair[0] 为 undefined 的触发不止挂载首触发——providers 迟到（map undefined→defined）后的首次到达同样走分支 3，此时可能已发生过换绑（「换绑路径 oldMap 非 undefined 天然不触发」在该窗口不成立）。该窗口下的既有行为（非本设计引入，D5 前后等价）：已建 session 档位 value ∈ {xhigh, max}（`DEFAULT_SUPPORTED_LEVELS` 五档之外）时，分支 3 按五档归一误判不可用 → 钳到 high → **发一次 setThinkingLevel RPC + 记忆表写入**。窗口窄（providers 早于 panel 加载即不出现），但 V3 实施期若偶发红，排查者会先怀疑 D5 门禁回归 | ① 表述改为「仅在前一对 map 为 undefined 的触发可达（挂载首触发 + providers 迟到后首次到达）」；② D5 边界段登记该既有错钳窗口（声明维持现状或留待后续治理），给 V3 偶发红留排查锚点 |
| SUGGESTION【新发现】 | §3.3 D1（handoff 列）/ §5 U1 / 待验证检查点 | P1-4 alternatives 记录 + 守卫契约同步 | **CREATE_DERIVED_CALLERS 契约同步未列入实施清单**：`session-binding-fields.ts` 的 handoff 行 `passedBindingFields: ['projectId']` 是 Wave 3 守卫测试的承诺清单；modelId/thinkingLevel 升格为绑定字段且 handoff 通道实际透传（handoff-service.ts:275-276）后，承诺清单可能需同步登记（静态扫描如何映射 modelOverride 参数 → 绑定字段取决于守卫实现，属实施期核对）。另：D1 restore 列只记录了为何不是 'meta'，未记录为何不用 'resolved-in-entry'（launchPresetId 的 restore 先例，值同样可入口解析后经注册表回填）——补半句使 alternatives 谱系完整 | U1 或待验证检查点补「CREATE_DERIVED_CALLERS passedBindingFields 是否需 +modelId/thinkingLevel（含 user-facing/agent-managed 行）」；D1 restore 列补一句 'resolved-in-entry' 未选理由（播种点统一在 registerSession，避免双写源） |
| INFO【新发现】 | §5 A1 降级路径 | P1-8 表述 | 「需确认其 immediate watch 先于 sync watch 生效」方向含混：代码中 sync watch（useThinkingLevelSync 内）注册**先于** followRememberedOrDefault watch，但因分支 2 已门禁，两种顺序均收敛（sync 先跑 = 被门禁 no-op，follow 后设值）。该提示宜改为「确认分支 2 门禁生效且 followRememberedOrDefault 正常写初值」，避免实施者按字面去调整 watch 注册顺序 | 顺带改写 A1 降级路径措辞 |

## 结论

修订版可进入实施（DoR 达成）：上轮全部阻塞项修复成立，四层方案（sidecar 持久化 / restore 播种 / 兜底收紧 / 解耦 + 门禁）的因果链在源码层无击穿点；三条 SUGGESTION 均为实施期清单补全与表述精度问题，可在 U1 落地时顺带吸收，无需再开一轮全文复审。
