# 对抗式审查报告：composer per-session 模型/思考档位状态隔离与持久化

> 审查对象：`/tmp/design-composer-model-session-isolation.md`（状态：待对抗式审查）
> 审查依据：rubric-design-doc.md（P0/P1 清单）+ 项目 AGENTS.md 约定（pi 语义断言纪律 / 约束登记纪律 / 测试红线）
> 方法：文档引用的源码事实逐一 read 核实（项目源码 + pi 0.84.4 node_modules 实装 + 本机运行日志），对抗式找反例。

## Summary

3 must-fix, 4 suggestions (另 1 条 INFO)。

方案总体质量高：问题定义忠于真实缺陷（§2.1 日志轨迹逐条与本机 `runtime-2026-09-04.log` 核实吻合，含 03:28:44.163 的自动 set_thinking_level 反例实证）、六机制根因分析全部经源码核实成立（机制①③④⑤⑥逐行验证属实）、方案对比完整、验收为真实场景且含负面验证。三处 MUST_FIX 均为「方案成立依赖的物理/事实层细节与源码冲突」——其中 D1 的 sidecar 物理文件目标冲突会直接让 G1 不成立，必须先修。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D1（标题）+ §3.4 数据流图 + §4 V1 | P0-11 事实 + P0-12 副作用 | **D1 指定的物理存储目标 `.meta.json` 与既有 owner 的写语义冲突，字段会被周期性抹掉**。证据：① `session-file-utils.ts` `persistSessionEnd` 用 `atomicWrite` **全量覆写** `.meta.json`，内容仅 `{type:'session_end', outcome, reason, timestamp}`；该写点**每 turn 结束无条件触发**（`session-service.ts:665-669` handleTurnEndSideEffects → persistSessionOutcome，session-file-utils.ts:215 注释明示「每 turn 写点」）——若按文档把 modelId/thinkingLevel 写进 `.meta.json`，**下个 turn 结束即被抹掉**，G1 直接不成立。② `session-lifecycle.ts` restoreSession 中 `unlinkSync(target.filePath + '.meta.json')` 在 restore 时删除整个文件。③ 既有绑定字段家族（launchPresetId/projectId/agent）全部存**独立 sidecar 文件**（`.preset.json`/`.project.json`/`.agent.json`，经 `persistBindingSidecar` 公共骨架），不存在「多字段共存一个 .meta.json」的先例。④ 文档自己的文件改动地图写的是 `session-store.ts [persistModelBinding helper]`（家族模式 = 独立文件），与标题的 `.meta.json` 自相矛盾。⑤ V1 验收断言 `cat <sessionFile>.meta.json 含 "modelId": ...` 把错误目标锁进了验收 | 改为独立绑定 sidecar（如 `.model.json`，走 persistBindingSidecar 家族骨架：原子写 + 双层缓存失效 + JSONL 存在性守卫），D1 标题、§3.4 终态数据流图、V1 断言命令、V2 构造步骤同步修正。不推荐改造 persistSessionEnd 为 read-merge（引入与每 turn 写点的并发窗口） |
| MUST_FIX | §3.3 D4（证据行）+ 待验证检查点 | P0-11 事实 + P0-12 副作用 | **「settings-lifecycle.ts:73 是唯一 renderer 消费点」为事实错误，存在第二个真实消费方**。证据：`packages/renderer/src/components/settings/provider/ProviderPage.vue:369` `config.onDefaultsWithSource(({ defaultModel, source }) => ...)` 订阅 config.defaults 帧，`source !== 'default-set'` 且值变化时弹 toast「默认模型自动更新」。两点后果：(a) D4 的分析结论「分析期已查，除 settings-lifecycle 与 mock 外无其他消费」被源码直接反驳，实施者若信此结论可能不再全量 grep；(b) 未声明的消费方行为变化：现状下「Settings 页开着 + 任意 session 切模型」会弹误导性「默认模型已自动更新」toast（机制①的又一症状），D4 移除广播后该 toast 消失——属正向副作用但文档未登记，验收（V5）也未覆盖该 UI 变化 | D4 证据行修正为列举两个消费方（settings-lifecycle + ProviderPage toast），显式声明 ProviderPage 的 toast 行为变化及「该变化本身就是污染症状的消除」；待验证检查点措辞改为「以实施期 grep 全量结果为准更新本节」（分析期结论已证伪，不能再作为基线）；V5 可加一条 Settings 页开着切模型的 toast 消失断言（可选） |
| MUST_FIX | §3.3 D1 × D2 交叉处 | P0-12 副作用/遗漏 | **BINDING_FIELDS 注册表的 restore 列回填语义与 D2 播种的时序冲突未声明**。证据：① `session-binding-fields.ts` 的 `BindingFieldSpec.entries` 是 `Record<BindingEntryKind, ...>`——四列少一列编译红，modelId/thinkingLevel 入表必须显式给 create/handoff/restore/fork 四列语义，文档只讨论了写点未讨论矩阵列。② `session-lifecycle.ts` restoreSession 中 `hydrateBindingMeta(session, {...}, 'restore')` 在 `registerSession` **之后**运行：若实施者按「回填自动获得」的注册表扩展路径把 restore 列填成 `'meta'`（扫描 sidecar 值——现有枚举里 restore 列的唯一惯用值），会用**可能过期的扫描值覆写 D2 刚 get_state 读回的新鲜播种值**，E6 声明的「restore 读回覆写 sidecar 自愈闭环」被自己的回填机制反向破坏。③ 现有语义枚举（options/inherit-source/meta/resolved-in-entry/none）没有「get_state 读回」对应值。④ handoff 承接通道的模型继承语义（承接 session 的模型来自源继承还是 pi 恢复）也未讨论 | D1 显式声明四列矩阵取值（restore 列建议 `'none'` + D2 metaOverride 手动播种，或扩枚举 `'resolved-in-entry'` 变体并声明排序在 hydrateBindingMeta 之前/之后谁赢）；补 handoff 列的模型/档位继承裁决（对照 fork 的 inherit-source 惯例） |
| SUGGESTION | §3.3 D5 | P0-12 边界 | **门禁判定与 armed 消费块的求值顺序未指定，影响「记忆未命中的显式切换」行为**。`thinking-level-sync.ts` 的 `consumeArmedRestore` 在「未命中/幂等/不可用」回落路径**先清 armed 再 return false**：若门禁条件读的是消费块之后的 armed，显式切模型但记忆未命中时会掉进「仅可用性校验」分支，丢失现状的同体系映射/跨体系重置（V4 只测记忆命中路径，测不出该差异）。文档只说「armed 消费块已在回调顶部，门禁插入点明确」，未说明求值基准 | 声明门禁以「回调入口时的 armed 快照」（或等效 local flag：本次触发是否显式）判定，而非消费块之后的 armed 值；并补一句记忆未命中显式切换的行为裁决（保持现状对齐 or 接受仅可用性校验） |
| SUGGESTION | §5 实施路径 | 项目纪律（P0-12 项目补充） | **U7 约束登记排在 P3 违反项目纪律**。AGENTS.md 明文「新增约束**先登记再写代码**，改 json 后跑 render-constraints.mjs 重新生成」；文档实施路径把 constraints.json 三条约束登记放在 P3（全部代码之后），仅 U7 内部提到「按项目纪律……与代码同批 CR」——「同批 CR」与「先登记再写代码」不等价 | 约束登记（U7 的 constraints.json 部分）提前到 P1 之前或与 U1 同批落地；render-constraints.mjs 重生成随首次提交 |
| SUGGESTION | §3.5 探针清单 A3/A4 | P0-16 部分 | A1/A2 探针写了降级路径，A3（整表广播携带真值）/A4（无 config.defaults 帧）两条 ⛔ 实施期门无失败处置说明，与 A1/A2 不对称 | 各补一句失败处置（如 A3：检查 scannedToSummary 字段透传与缓存失效；A4：grep 确认无其他 source='model-switch' 生产点） |
| SUGGESTION | §3.3 D3（采用段） | P1-8 / P0-12 细节 | 「thinkingLevel 已建态本就只读 session 真值，不动」表述与源码不符：`model-thinking.ts` `regularThinkingLevel = sessionState?.thinkingLevel ?? localThinkingLevel`——已建 session 的 undefined 档位会回落到本 composer 实例的 landing 残留值（与 regularModelId 的 `||` 兜底同构的小型污染路径）。D1+D2 落地后窗口极小，非阻塞，但 D3 声明「不动」时宜如实登记该残留路径 | 二选一：与 modelId 对称处理（undefined 显示占位），或在 D3 边界显式声明「档位 undefined 回落 local 残留值，窗口 = D2 播种前，可接受」 |
| INFO | §2.1 / §2.3 机制① | P1-8 | 细节不精确处（均不影响决策）：①「恢复完成仅 3ms」——日志实际 get_state .134/.135 → set_thinking_level .163 约 29ms（switch_session .086 起算 77ms），「非用户操作」的结论不变；② 机制① 引用行号 96-108 与实际 switchModel 方法体（约 88-108）轻微偏移；③ D1 被否理由用「多 renderer 实例不一致」否决 renderer KV 持久化，D4 的 lastUsedModel 又选了 renderer KVStorage——展示默认值 stakes 低可接受，但两处判据的张力宜加半句说明 | 随 MUST_FIX 修正时顺带核对 |

## 关键检查项判定（对抗式核实记录）

**问题定义与因果链（P0-4/P0-10）——通过**。§1 定义的是真实缺陷而非表面现象；隐藏根因（全局默认被 session 级切换污染 / per-session 无持久层 / watch 无法区分意图来源）均被源码证实为真。回溯因果链：D1 打掉「无持久层」断点（G1）、D2+D3 消灭 restore 窗口假值（G4）、D4 消灭污染源（机制①根因）、D5 消灭档位改写（G3/G2 上游）——方案打的是根因层，非症状掩盖。D6 以减法（不加新门禁）达成 G2，论证成立（污染输入=机制⑤改写值，D5 断其上游）。

**源码事实核实（P0-11）——除上述 3 条 MUST_FIX 外全部属实**：机制①（model-service.ts switchModel 无条件广播 config.defaults；注释「全局默认的持久化由 pi 侧 setModel 完成」确实存在，D6 勘误对象属实）；机制②（session-scanner.ts `modelId:''` 占位 + store.ts applySnapshot 整表分支直接替换 groups、W15 守卫仅在 mergeViewSnapshot 单条分支——均核实）；机制③（model-thinking.ts regularModelId 的 `||` 兜底链逐字符属实）；机制④（registerSession `modelOverride ?? fallbackModelId`、restoreSession 不传 override、session-state-projection.ts `?? session.modelId` 回退链属实）；机制⑤（thinking-level-sync.ts watch 观察 map+supported、oldMap 非空走体系判定 → onReset → RPC，03:28:44.163 日志实证）；机制⑥（记录 watch「不区分来源，值生效即记录」注释属实）。pi 0.84.4 三处实装断言全部核实（rpc-mode.js set_model 不传 options → 不持久化；agent-session.js setModel 仅 persist===true 写 settings；session-manager.js getSessionContextSettings 取路径上最后一条 model_change/assistant）；本机 settings.json defaultModel=glm-5.3 与「7 次切换未污染」实证吻合；§2.1 日志轨迹（6 次 model.switch 的时间戳/sessionId/模型、03:22:15 十进程 code 143、03:28:44.086 switch_session→.163 set_thinking_level）逐条与 `~/.xyz-agent/logs/runtime-2026-09-04.log` 核对吻合。D1 证据「switchModel/setThinkingLevel 均已持有生效值」（session-model-control.ts set→get_state→effective 链）属实；D2 证据「create 流程已调过一次 get_state」（session-lifecycle.ts:403）属实；u3 文档「关键事实⑤」「关联发现」引用属实。

**对抗式核心三问（P0-10/11/12）**：
- *D5 armed 门禁击穿场景*：landing→panel 切换不构成击穿（landing 选模型的 armed 在 currentModelId 同步变化时即被 watch 消费，无在途 token 存活到换绑；已建态在途 RPC 由 in-flight 豁免覆盖）；「5s 内换绑清」边界已显式声明且与 u3 规则 6 同向。唯一残留 = SUGGESTION#4 的求值顺序。判定：通过（带 1 条 suggestion）。
- *D4 遗漏消费方*：**击中**——ProviderPage.vue:369（MUST_FIX#2）。决策本身仍成立（移除广播对两消费方均为正向），但事实声明与分析完备性不达标。
- *D1 双写一致性边界*：语义边界（sidecar=best-effort 显示缓存，pi 会话文件=权威，restore 覆写）本身成立，E1/E3/E6 降级路径自洽；但物理载体（.meta.json）与回填注册表（hydrateBindingMeta restore 列）两处与既有机制的冲突未核对——MUST_FIX#1/#3。

**验收（P0-13/14/15）——通过（带修正项）**：§4 存在；6 场景全部真实环境（真实 Electron + 真实 pi 子进程 + 真实数据目录 + browser-automation 截图断言 + 日志 grep 探针 + sidecar 文件断言），非单测/mock；每场景回溯 G1-G4 且用具体模型名（glm-5.3 vs flash）而非抽象断言；V3/V5 为负面验证（P1-10 覆盖）；投入与 ~12 文件改动匹配。需随 MUST_FIX#1 修正 V1 断言命令与 V2 构造步骤；可随 MUST_FIX#2 补 Settings toast 断言（可选）。

**其余 P0**：P0-1 五段骨架完整；P0-2 不适用（首版无 delta）；P0-3 结论先行（一句话结论/现状结论/SCQA 均有）；P0-5 使用者视角先行（§2.1 真实复现）；P0-6 术语有定义（全局默认/扫描占位/粘滞默认/sidecar/armed）；P0-7/8/9 三方案两维度评估+明确推荐+被否反例；P0-16 部分通过（SUGGESTION#6）；P0-17 §2.4/§3.4 物理数据流图标注物理位置；P0-18 E1-E6 均有具体恢复动作。P1-9 决策四件套 item 化（采用/被否/证据/效果）为范本级；P1-4 alternatives 记录完备。
