# requirements.md 需求完整性审查（review-fix-loop 第 1 路：对齐/补齐）

- 审查对象：`.xyz-harness/subagent-engine-abstraction/requirements.md`（402 行）
- 权威源：`docs/architecture/subagent-engine-abstraction.md`（666 行，已过三轮对抗式审查）
- 审查视角：①目标可追溯 ②角色用例完整 ③数据流完整 ④界面场景 ⑤跨系统依赖
- 纪律：本路为完整性审查（对齐/补齐），不引入设计文档之外的新需求；所有修复建议均为「补回设计文档已有语义」

## Verdict: APPROVED

must_fix 为空：A1-A14 验收场景全部有 UC/AC 承载（核对表见下）、11 个错误码主要触发路径全覆盖、G1-G5 无断链、数据清单覆盖 §2.4/§3.3.4 全部关键实体、GUI 面覆盖终态三/A8/A9/A11、§6 覆盖五大依赖方。存在 4 项 should-fix（转述保真度与文档自包含性），不阻塞进入下一阶段。

## A1-A14 验收场景 × UC/AC 映射核对表

| # | 设计文档验收场景 | requirements.md 承载 | 核对结果 |
|---|------|------|------|
| A1 | pi 引擎零回归（测试全绿 + record 快照字段级 diff + GUI 截图基线 + native schema 链路不受仿真层影响 + 手动路径） | AC-2.1（测试/快照/截图三件套）、AC-3.3（D4 硬分流回归）、AC-1.4（三层缺省 = pi 行为与现状零差异） | ✅ 承载完整 |
| A2 | zcode 真实任务（真跑 zcode + schema ajv + GUI 显示） | AC-2.2、AC-3.1（schema ajv 通过）、AC-6.1（隔离池与 db.sqlite 保留 = A8 前置确认） | ✅ 承载完整 |
| A3 | schema 仿真降级调用前可见 | AC-3.2（常驻标记非一次性提示） | ✅ |
| A4 | 嵌套防护 | AC-7.1 | ✅ |
| A5 | 探针拦截（strict 模式） | AC-4.3（错误含三要素恢复指引） | ✅ |
| A6 | 混编 workflow（两引擎 record 一致 + GUI 无引擎字段泄漏） | AC-1.2 | ✅ |
| A7 | 单次调用覆盖 frontmatter | AC-1.1（隔离目录无新增 zcode session 的反证设计忠实） | ✅ |
| A8 | 读取降级链（①前置确认 → ②rename db.sqlite → ③清空 journal） | AC-6.1 / AC-6.2 / AC-6.3（三级逐一对应） | ✅ 承载完整 |
| A9 | 引擎故障 fallback 与守卫（①frontmatter 探针失败 fallback 留痕 / ②对照组显式指定不降级） | AC-4.1 / AC-4.2 | ✅ 承载完整 |
| A10 | abort 两级中断（zcode 杀链 / pi 原生对比） | AC-5.1 / AC-5.2 | ✅ |
| A11 | 调用前拒绝（conversation + message 续聊 + GUI 入口隐藏） | AC-9.1 | ✅ |
| A12 | conformance 契约套件（双引擎全绿 + 负例转红） | AC-8.1 / AC-8.2 | ✅ |
| A13 | 死 handle 续聊拒绝 | AC-9.2 | ✅ |
| A14 | 运行中引擎失败兜底 | AC-4.4（含 stdout 尾部 + golden 补录） | ✅ |

**结论：14/14 全部有承载，无遗漏。**

## 错误规格 11 错误码 × 触发路径覆盖核对

| 错误码 | 设计文档触发 | requirements.md 承载 | 结果 |
|--------|------------|---------------------|------|
| `engine_not_found` | frontmatter 未注册 engine id | UC-1 异常流程 + AC-1.3（解析期报错 + 指向清单/路径） | ✅ |
| `engine_probe_failed` | 探针失败 | UC-1 异常流程（显式指定不 fallback，转 UC-4）+ AC-4.2 / AC-4.3 | ✅ |
| `engine_credential_missing` | preparer 无凭据源 | UC-2 AC-2.3（进程创建前） | ✅ |
| `nested_spawn_rejected` | 嵌套 spawn 尝试 | UC-7 主流程 + AC-7.1 / AC-7.2 | ✅ |
| `schema_emulation_failed` | 仿真三级容错 + 重试仍失败 | UC-3 异常流程 + AC-3.4（含原始输出尾部） | ✅ |
| `engine_timeout` | 宿主超时杀链走完 | UC-5 替代流程 + AC-5.4（stdout 尾部 2000 字 + 重跑建议） | ✅ |
| `engine_capability_unsupported` | 对 unsupported 能力发起调用 | UC-9 主流程 + AC-9.1 | ✅ |
| `engine_session_not_resumable` | 死 handle 调 interact | UC-9 异常流程 + AC-9.2 | ✅ |
| `model_not_available` | model 在引擎 provider 体系不可解析 | UC-2 AC-2.3（prepare 期）+ AC-4.5（守卫 c 不静默换引擎 + 列可用模型清单） | ✅ |
| `prompt_too_large` | argv 超限且无 stdin/file 通道 | UC-2 AC-2.3（prepare 期前置） | ✅ |
| `engine_run_failed` | 运行中解析失败/非零退出/漂移漏网 | UC-4 异常流程 + AC-4.4（宿主合成终态 + record 收尾 + golden 补录） | ✅ |

**结论：11/11 全覆盖。** 另：fallback 非错误的语义（engineFallback 字段 + 警告条，错误规格表注）在 UC-4 主流程与 AC-4.1 忠实转述，未与错误码混淆。

## 视角审查明细

### ① 目标可追溯

- G1-G5 成功标准全部可验证：每条均锚定 A 编号验收场景且有对应 AC（G1→A1/A2/A6、G2→A7/A6、G3→A3/A8/A11、G4→A5/A9/A10/A14、G5→A12 含负例）。
- 子目标 G1.1/G1.2 分解清晰（先回填后新增 / 差异不污染上层）。
- 决策记录 D1-D12 + 方案选型全部忠实登记，与本阶段「不重开」声明一致。
- 缺陷：达成路线表 G1 行漏列 UC-1（见 should_fix 4）。

### ② 角色用例完整

- Actor 全覆盖：用户（UC-1/4/5/6）、主会话模型（UC-1~4/6/7/9）、xyz-agent runtime（UC-6）、引擎接入开发者（UC-8）；UC-7 的 subagent 子代理是特殊 Actor（见 nit 1 图连线问题）。
- 用例无关键遗漏：fallback 三守卫、abort 两级、嵌套双层防护、conformance 接入门、死 handle、存档零迁移（AC-6.5）均成用例；pi conversation 正常路径为现状行为，由 A1/AC-2.1 零回归承载，异常路径由 UC-9 承载，分配合理。
- D11 四级处置全部有承载：自动仿真（UC-3）、显示降级（UC-6 + §5）、调用前拒绝（UC-9）、入口拦截（UC-1/UC-2/UC-4 strict）。

### ③ 数据流完整

- 现状图（§2.4 对照）：SubagentService / worktree-manager / spawn pi / spawn-event-adapter / session-reconstructor / record / subagents 目录 / runtime extractor 全部在场。
- 终态图（§3.3.4 对照）：路由 / 公共层 / preparer 隔离 HOME / launcher / parser / journal / record / read 降级 / runtime 按 engine 路由全部在场；「三行按引擎分叉、worktree/record 通道不变」不变量忠实转述。
- 数据清单 9 条覆盖全部关键实体，含生命周期与敏感级别（隔离池 = 高、其余低/中）；EngineHandle 不透明/可持久化/自描述与 record v2 零迁移语义完整。
- 缺陷：spawnedFiles 单次性产物清理语义缺失（nit 2）；ProbeReport 未列（nit 4，可不列）。

### ④ 界面场景

- 终态三（能力差异调用前可见）：§5「引擎配置处能力提示」+ 仿真降级常驻标记 ✅。
- A8：§5「降级显示」+「历史查看路径」（journal 重放视图降级标记 → 摘要卡，不白屏不弹错）✅。
- A9：§5「fallback 警告条」（数据源 = record 的 engineFallback 投影）✅。
- A11：§5「入口隐藏与能力标记」✅。
- 附加面均忠实：粗粒度阶段态卡片、kimi usage/cost 缺失显示不可用、权限模式 fixed/ignored 隐藏设置项、「永不弹错」口径与 D11 一致。

### ⑤ 跨系统依赖

- §6 覆盖：pi 宿主 / zcode CLI（逆向无契约 → 探针 + golden 承载）/ xyz-agent runtime（依赖单向 + 两个例外）/ zsub 参考仓（参考不依赖）/ 未来四引擎（各自契约稳定性标注）。
- runtime 依赖方向（永不 import adapter 运行时件，例外仅无状态 reader + 中立制品）在 §6 表与 §7 约束 4 双重登记 ✅。
- 缺陷：pi 作为执行引擎（PiEngine）的依赖面无独立行（should_fix 3）。

## must_fix

无。

## should_fix

1. **UC-4 替代流程守卫 b 丢失「首期与守卫 a 合流」限定**（L125）
   设计文档 D9① 守卫 b 原文含括号限定：「首期声明载体 = step/调用级显式 engine，与守卫 a 合流，AgentTaskSpec 下钻时补 `requires?: Partial<EngineCapabilities>` 后独立生效」。requirements 只写「task 声明依赖该引擎独有能力（capabilities 对照，如 sandbox: native）」，未注明首期载体。读者可能误判首期需实现独立的能力声明字段/机制（实施范围误解）。
   修复：守卫 b 后补括号「首期声明载体 = step/调用级显式 engine（与守卫 a 合流）；`requires` 字段待 AgentTaskSpec 下钻时补齐后独立生效」。

2. **C5/C6/C7 conformance 编号悬空，破坏文档自包含**（L116、L117、L164、L178）
   AC-3.3/AC-3.4 引用 C6、AC-6.4 引用 C5、AC-7.2 引用 C7，但全文未定义 C1-C8 编号清单；UC-8 主流程第 5 步（L185）也仅枚举前五项（probe 形状/run/事件不变量/abort/read 降级）后以「等」带过，恰漏 C6（schema 分流）/C7（嵌套防护）/C8（prepare 前置错误）。
   修复：UC-8 主流程第 5 步枚举补全三项，或在 C 编号首次出现处（L116）加注「C1-C8 = conformance 契约用例编号（C6 schema 分流 / C7 嵌套防护 / C8 prepare 前置错误），清单见设计文档 §3.3.8」。

3. **§6 关联表缺「pi 作为执行引擎」的依赖行**（L338 表首行）
   现有「pi 主会话引擎（宿主）」行只描述宿主承载关系（appendEntry/journal/编排权），而 PiEngine 作为执行引擎的依赖面——spawn pi CLI `--mode rpc` 子进程、subagents 目录 JSONL schema 被 reader/session-reconstructor 锚定、pi 二进制存在性——没有对应行；对比 zcode 与未来四引擎均有独立依赖行。A1 零回归守护的正是这条依赖。
   修复：在该行「交互方式」列补「兼执行引擎之一（PiEngine）：spawn `--mode rpc` 子进程 + subagents 目录 JSONL 原生读取」，或单列一行「pi CLI（执行引擎）」。

4. **达成路线表 G1 行对应用例漏 UC-1**（L28）
   G1 成功标准引用 A6（混编 workflow），A6 的承载是 UC-1 的 AC-1.2，但 G1 行只列「UC-2, UC-5」，正向追溯 G1 → UC 时 A6 承载缺一环。
   修复：改为「UC-1, UC-2, UC-5」。

## nit

1. **UC-7 用例图 Actor 连线与正文不一致**（L69）：图中「Model --> UC7」但 UC-7 正文 Actor 为「subagent 子代理」。建议图增加 Subagent actor 节点（子代理内模型），保持 Actor 集合无歧义。
2. **数据清单「隔离目录池」缺 spawnedFiles 清理语义**（L276）：设计文档 D5 明确「spawnedFiles（临时 prompt 文件等单次性产物）任务结束即清理，resume 场景保留」——与池化跨任务保留是两种生命周期。建议处理/归档列补「spawnedFiles 单次性产物任务结束即清理（resume 保留）」。
3. **AC-8.3 为非首期承诺项但列在 AC 中**（L193）：已文字标注「后续 Phase 非首期承诺」，但 AC 列表语义上是本需求验收面，首期验收时可能误判缺失。建议标签改为「[边界·后续 Phase]」或移至 §8 之外的边界说明。
4. **ProbeReport 未入数据清单**：探针产出（engineVersion 为 handle 数据源、checks/error 支撑入口拦截与恢复指引）属即时消费不归档，可维持不列；若要求数据清单完备，可补一行并标「即时消费不持久化」。

## 汇总

| 级别 | 数量 | 清单 |
|------|------|------|
| must_fix | 0 | — |
| should_fix | 4 | 守卫 b 首期合流限定 / C 编号悬空 / §6 缺 pi-as-engine 依赖行 / G1 路线表漏 UC-1 |
| nit | 4 | UC-7 图连线 / spawnedFiles 生命周期 / AC-8.3 验收时点 / ProbeReport |

全部 4 项 should-fix 均为「补回设计文档已有语义」的转述修正，无一项要求新增能力或改动需求范围——不违反本路「完整性审查、不扩张需求」的纪律。
