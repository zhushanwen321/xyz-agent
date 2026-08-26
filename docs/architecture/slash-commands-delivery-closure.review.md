# 审查报告：slash-commands-delivery-closure.md

> 审查人：tech-design-review（对抗式）· 依据：rubric-design-doc.md（P0/P1 清单）· 项目约定：AGENTS.md（ADR-0049 / broadcast 时序竞争条款 / TEST-STRATEGY）

## Summary

1 must-fix, 3 suggestions.

整体判定：文档质量高——五段骨架完整、三方案对比两维度齐全、D1-D5 决策四件套规范、P1-P9 探针全部经本次审查独立核实为真（含 pi 实装 dist `rpc-mode.js` 三段拼接、`session-service.ts` 查询即失效、`subscription-state.ts` 幂等守卫、`useSessionEvents` 第二参数捕获 sid、protocol.ts:1486 精确命中、渲染端 `sessionApi.getCommands` 零调用方、mock 同形实现、「runtime 零改动」成立）。方案 A 的因果链（挂载/切 sid/打开三触发点 → RPC 直取 pi → 按 reply.sessionId 写分区）确实打穿 §2.5 根因（零补拉闭环）。**唯一 MUST_FIX 在验收 S3**：其通过标准隐含依赖一条文档未声明的异步链路（skill 变更 → pi reload 编排），无时序锚点，验收会 flaky 或误判。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4 S3（连带 §3.1 成功路径、§2.2 数据流图） | P0-13 + P0-16（波及 P0-14） | **S3 验收场景缺 reload 完成锚点，依赖未声明的异步链路，不可稳定执行。** S3 步骤「新建 skill 目录 → 关闭浮层再打开」期望 N+1，但 pi `get_commands` 的 skills 段来自 `session.resourceLoader.getSkills()` **内存注册表**（已 read 核实：`rpc-mode.js:539-566` 遍历 `getSkills().skills`；`resource-loader.js` 无文件 watcher，注册表仅在 `load()/reload()` 时重扫）。磁盘变化要进注册表必须走既有异步编排：skill-registry chokidar watcher → `skillRegistry.onChange` → `ReloadOrchestrator.onSkillChange` → idle session 发 `/__xyz_reload__` prompt → pi `ctx.reload()` 完成（已 read 核实 `packages/runtime/src/index.ts:561-568` 接线存在；整链秒级）。S3 未含任何等待/确认 reload 完成的步骤——若用户重开浮层早于 reload 完成，第二次打开仍为 N，验收失败但实现无 bug（时序竞态误判）。§3.1 成功路径「刚新增的 skill 目录会出现」同样隐含此前提；§2.2 数据流图未画这条 reload 链路，读者会误以为「打开即拉」直连磁盘。G3 措辞「反映 pi 当前真实命令集」本身准确，但 S3 把它偷换成了「反映磁盘当前」。 | ① S3 步骤补 reload 完成锚点：等待 runtime 日志确认 reload 完成（或 skill watcher 事件已触发 + 固定间隔 ≥2s）后再重开浮层；② §2.2 或 §3.1 补一句链路说明：「pi skills 注册表更新依赖既有 ReloadOrchestrator reload 编排，打开即拉刷新的是 pi 内存注册表当前值」；③ 顺带把 G3 验收拆两层：reload 完成后的新鲜度（正例）与 reload 进行中的旧值保留（负面行为，当前表现为显示旧列表不算失败） |
| SUGGESTION | §2.4 FM3 / §2.2 图注 | P1-8（细节表述，不影响方案） | **「重连也救不回」表述过绝对。** 已 read 核实 `replicated-state.ts` 的 `refetch()`：「重连兜底全量重拉：绕过防抖立即拉取，并重置退避游标」——退避序列耗尽后，WS 重连（resubscribeAll）与 session 重新激活都会触发 refetch 重启拉取。FM3 触发条件应收紧为「pi 持续异常期间」（此窗口内重连也确实救不回）；方案不依赖该声明（RPC 直答不经快照），不影响决策。 | FM3 描述补「（重连/再激活可重启拉取，但 pi 持续异常窗口内无效）」 |
| SUGGESTION | §2.2 / §3.3 D1 证据 / D3 证据 | P1-8（行号/路径偏移，不影响决策） | 行号与路径缩写偏移四处（均不影响结论，仅供实施者定位）：① `CommandPopover.vue:117-127`（useFileSearch 先例）实为 128-143；② `session-service.ts:1997`（`session not active` 抛错行）实为 ~1990；③ `mock/index.ts:332` 实为 `api/mock/index.ts:329-335`（路径缩写漏 `api/`）；④ `core/domain/new-task-search/flow.ts` 属 **packages/core**（`packages/core/src/domain/new-task-search/flow.ts`），文档未注明包名，读者在 packages/renderer 下找不到该文件。 | 逐处修正；路径引用统一带包前缀 |
| SUGGESTION | §4 S4 | P1-10 边缘（验收步骤时点） | **S4「console 有 warn」通过标准的检查时点未定义。** kill pi 后打开浮层，若 runtime 的 process manager 尚未检测到进程死亡（`pm.getClient` 仍返回旧 client），`getCommands` 会挂起至超时才 reject → warn 出现可能延迟数秒；验收若「打开浮层后立即查 console」会扑空误判。 | S4 步骤写明「等待 RPC 失败返回后（最多 FAST_TIMEOUT 10s）再检查 console」 |

## 附：核实记录（对抗式审查中「找不到反例」而放行的关键项）

以下声明逐一 read 源码核实为真，判定通过：

- **P0-1/2/3/5/6/7/8/9（结构与主线）**：五段齐全；无 delta 链残留；一句话结论 + SCQA + 各章节结论先行；§2.1 三个使用者例子；§2.3 术语带例子；§3.2 三方案 × 两维度 + 明确推荐及理由。通过。
- **P0-4 问题定义**：§1 忠于用户真实问题（skill 消失不自愈），非复述方案；§2.5 根因「闭环断在最后一厘米」与 AGENTS.md「Runtime broadcast 时序竞争」条款对齐（该条款原文核实存在）。通过。
- **P0-10 因果链**：G1/G2/G4 因果闭合（挂载/切 sid 即拉 + handler 捕获 sid + 静默降级）；G3 见 MUST_FIX 1（方案侧成立，验收侧有缺陷）。FM1 时序证据核实：`packages/core/src/domain/new-task-search/flow.ts` createSessionFlow 编排 appendSession→applyModel→migrateImages + 壳层 await setThinkingLevel → pushChat，中间 RPC 窗口属实；FM2 机制核实（`useSessionStreamSync.ts` watch session.list 同步建订阅 + `subscription-state.ts:155-158` 幂等守卫）。通过。
- **P0-11 关键事实**：本报告核实清单——`CommandPopover.vue:186-192`（唯一写入点，行号精确）、`session-service.ts` 查询即失效（markDirty 前置 + client 直答，「拉取全程实时透传 pi」声明准确）、`replicated-state.ts` markDirty 防抖到点直调 doFetch 与退避游标解耦（P3 成立）、`replicated-states.config.ts` commands 无 pollIntervalMs + backoff [1000,5000,15000]（常量核实）、`useSessionEvents.ts` handler 第二参数透传订阅时捕获 sid（ADR-0049 M1 消除注释原文核实）、`command.ts` findCommandByName chip 同步消费、`protocol.ts:1486` 精确命中、`api/domains/session.ts` getCommands 签名带 sessionId、`api/mock/index.ts:329-335` mock 同形、`session-message-handler.ts` case 'session.getCommands' 存在、`server.ts` handleMessage 外层 catch → sendError（P5 闭环）、`message-bus.ts:131-138` STATE_TYPE_KEY_MAP 五条目（行号精确）、pi 实装 0.84.1（npm ls 确认，读的是 node_modules dist 非参照 clone）、P8（get_commands 无 busy 守卫）、P9（cmdOpen 汇聚于 85/100/149 行）、`useSessionStreamSync.ts` App 级订阅、渲染端 `sessionApi.getCommands` 零调用方（grep 全 renderer 无调用点）、composer-symbol-system §D4 引用属实（git show 2342dc7f0：「renderer 浮层开时 1 次 RPC」原文一致，轮询否决理由一致）。**未发现影响决策的事实错误。** 通过。
- **P0-12 副作用/遗漏**：非接管式方案（广播链路保留且 D5 被否③给出理由）；mock 模式已覆盖（P6）；landing 态 sid 为空不拉（契约已声明）；「打开浮层 → markDirty → 300ms 防抖重拉」副作用文档已声明且无害；与 U3 零文件冲突声明与两侧文件清单一致；split mode 多实例各自 in-flight 跨实例不去重，但幂等覆盖写无害（INFO，不单列）。通过。
- **P0-15 验收投入**：~100 行改动配 6 个真实场景 + 单测，投入匹配。通过。
- **P0-17/18**：§2.2 物理数据流图位置标注齐全（reload 链缺失并入 MUST_FIX 1）；§3.1 失败路径有具体恢复动作。通过。
- **P1-1/2/3/4/5/6/7/9/10**：例子充分；W1/W2 有 justification；术语/背景补足；D1-D5 全有「被否」记录；FM1-FM4 基本 MECE；D5 论证了为何不减广播链路；未越层（契约为行为级）；决策四件套完整；S2/S6 负面验证在位。通过。
