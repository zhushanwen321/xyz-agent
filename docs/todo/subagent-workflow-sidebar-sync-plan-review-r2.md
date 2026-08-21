# subagent-workflow-sidebar-sync 计划文档第二轮审查报告（R2）

> 审查对象：`docs/todo/subagent-workflow-sidebar-sync-plan.md`（已按第一轮报告修复一轮后的版本）
> 第一轮报告：`docs/todo/subagent-workflow-sidebar-sync-plan-review.md`（4 must-fix / 10 suggestion / 3 info）
> 审查依据：`rubric-design-doc.md` + 项目 AGENTS.md / TEST-STRATEGY.md / docs/testing/11-real-e2e-specs.md + 源码交叉核实（声称事实前均已 read）
> 审查身份：对抗式第二轮——默认怀疑，逐项找反例；只报告不修改。

## Summary

1 must-fix, 10 suggestions, 3 info.

总体判断：第一轮 14 条（4 MF + 10 SG）**全部有对应修复动作且主体正确**（含 3 条 INFO 全部吸收），设计→计划映射骨架、DoD testable、E2E 设施描述（waitForExtensionsReady 机制、real bundle 前置、进程消歧、归因注意）在本轮核实中均与源码/文档对得上。第二轮剩余问题集中在三处：① **第一轮 MF-4 的修复只做了 subagent 半边**——workflow 侧存在同构的「success 空 reply 覆盖非空分区」暴露（源码已核实），且 P2 新增的三个对账点会放大该暴露面（本轮唯一 must-fix）；② 若干修复语句与文档其他章节的自洽残留（P1 DoD 仍写「mock E2E 全绿」、§10 依赖图与总览表两处矛盾、P6 秒级断言未按 A10「退化」裁决条件化）；③ 可执行性深挖出的验证设施缺口（A6 合成器无归属、P5 `--extension` 产物无构建前置、waiting 态 fixture 维度缺失等）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3 P1 开发内容 vs §4 P2 开发内容 | P0-12 副作用/遗漏 + 目标 4 对称性 | 第一轮 MF-4 的空结果守卫只加在 `subagentStore`——workflow 侧有**同构暴露**（已 read 核实）：`workflow-extractor.ts:139-145` 的 `readFileSync` catch 同样 `return []`（读取失败与真空集语义合并，与 subagent-extractor.ts:107-110 同一模式）；renderer `workflow.ts:149` `applyRecords(sessionId, await sessionApi.getWorkflows(...))` 无条件覆盖分区，无「prior 非空且新结果为空」守卫。且该暴露面被本计划放大：P2 三个对账点（`handleMessageComplete` / `handleSessionExited` / 重连全量重拉）全部同时触发 `loadWorkflows`，拉取频率较现状显著上升。subagent 有守卫、workflow 没有，直接违背设计目标 4「两条链路一种心智模型」 | P1（或 P2）开发内容补 `workflowStore.loadWorkflows` 同款空结果守卫（或抽公共守卫逻辑两条链共用），单测断言同步补「RPC 成功返回 [] 且分区非空 → 不覆盖」 |
| SUGGESTION | §3 P1 DoD | P0-13 验收自洽 / 第一轮 MF-2 修复残留 | DoD 写「上述单测/集成/**mock E2E** 全绿」，但同阶段开发内容已明确「放弃 mock E2E spec」、验证清单只有单测+集成——DoD 引用了本阶段已声明不存在的验证物，验收门槛与正文决策矛盾（实施者无法勾选或需自行解释） | DoD 删去「mock E2E」字样，与验证清单对齐 |
| SUGGESTION | §1 形态 A ② | P0-11 事实（细节级）/ 第一轮 MF-1 修复引入 | 「launchRealApp({dataDir}) + waitForRuntime + waitForExtensionsReady —— e2e/fixtures/launch-app-real.ts」的归属表述不实：`launch-app-real.ts` 只提供 `launchRealApp`/`waitForRuntime`（:85），`waitForExtensionsReady` 是 `e2e/ask-user-real.spec.ts:203` 的 **spec 私有函数**（唯一实现，默认 90s/minCount=8 与计划数字一致）。新 spec 实施者会去 fixtures 文件里找导出而找不到 | 仿 makePresetDataDir 的注写法注明「waitForExtensionsReady 是 spec 私有复制函数（ask-user-real.spec.ts:203），新 spec 复制实现」 |
| SUGGESTION | §4 P2 验证 A6 段 | P0-12 遗漏 / 第一轮 MF-3 修复残留 | A6 探针步骤本身已完整（fixture 结构、计时方式、阈值判定都有），但「fixture 用**合成器**生成 ≥10MB 主 session JSONL」——合成器是新增代码，未列入任何阶段开发清单（P0 DoD 的「探针脚本入库 scripts/probe/」只覆盖 A5/A7/A8/A10 四个子探针），其归属与是否入库未声明 | P2 开发内容补一行「`scripts/probe/` 新增 JSONL fixture 合成器（A6 探针用，随探针脚本入库）」 |
| SUGGESTION | §0 总览表 vs §10 顺序图 | P1-5 交叉引用自洽 | 两处依赖声明互相矛盾：① 图有 `P0 ──→ P2` 箭头，总览表 P2 依赖列为「无（可与 P1 并行）」；② 图中 P1、P2 共同汇入 P3，总览表 P3 依赖只写「P1」。实质上图是对的：P3 删除 `session.subagents` 快照恢复（STATE_TYPE_KEY_MAP 条目），其替代机制「重连全量重拉」正是 P2 的交付——P3 先于 P2 落地会让重连场景丢列表恢复。另外 §10「P1/P2 并行（renderer 内**不同文件面**）」不实：两阶段同改 `useMessageEffects.ts`（P1 加 onSubagentsChanged，P2 改 handleMessageComplete/handleSessionExited），并行有同文件 merge 面 | 总览表 P3 依赖改为「P1+P2」、P2 依赖注明「逻辑无依赖（图中 P0 箭头仅表执行顺序可选等待）」或删图中 P0→P2 箭头；「不同文件面」改为「同文件不同函数（useMessageEffects），冲突面小」 |
| SUGGESTION | §8 P6 验证 1 | P0-13 验收前提未声明 | 「场景 1 的秒级断言在本阶段补齐……断言第一个完成的 subagent 秒级显示终态」未按 P0-A10 裁决条件化：裁决为「退化」时秒级信号不存在（设计决策 4 已预留退化为「窗口 + 对账」，实时性回退但正确性不变），该断言按字面必然 FAIL，会把设计已接受的实时性回退误判为方案失败 | P6 场景 1 断言补条件分支：「A10 裁决 a/b → 秒级断言；裁决退化 → 断言 60s 窗口 + 一个 turn 内有界收敛」（对齐设计 §8 场景 1 的双分支通过标准） |
| SUGGESTION | §6 P4 开发内容/验证 | P0-12/P0-13 条件性内容不完整 | waiting 态三个条件性缺口：① idle 位**数据源**未落——extractor 是读磁盘的，idle 位须从主 JSONL 的轻量事件 custom_message entry 读（A10a 事件无 triggerTurn 会落盘），计划只写「streaming/waiting 按 A10a idle 位」，没写从哪个 entry 读；② P4 单测 fixture 矩阵（主 JSONL × sidecar × 子进程 JSONL）**缺轻量事件 entry 维度**——A10a 分支下构造 waiting 态 fixture 必需；③ A10 裁决 b/退化时 `waiting` 是类型上存在、运行时不可达的枚举值，计划仅有「无则 streaming」的回落，未显式注明该条件性（设计决策 5 有「waiting 态作为 A10a 落地后的增量」表述，计划承接不全） | P4 extractor 行补「idle 位从主 JSONL 轻量事件 entry 读取」；单测矩阵注明 A10a 条件维度；补一句「A10 非 a 时 waiting 运行时不可达（渲染测试仍覆盖 6 态）」 |
| SUGGESTION | §7 P5 验证 1 + §1 pi CLI 直连 | P0-13 可执行性前置缺失 | `--extension <打包产物>` 的「打包产物」无获取命令：`extensions/subagent-workflow/package.json` 无 build 脚本（scripts 仅 typecheck/test，main 即 index.ts 源码）；staged builtin 产物由 `scripts/prepare-builtin-extensions.sh` 生成（`apps/electron/resources/extensions/@zhushanwen/`），**改完源码不重跑 staging 就直接 `--extension <staged>` 会测到旧代码（假通过）**；§1 的「dev-link 路径」是另一机制（dev-link skill 的 pi 模式 = symlink 到 `~/.pi/agent/extensions/` 后 loader 自动发现，**不需要** --extension 参数）。两个名词均未落地为可执行命令 | P5 验证补构建前置三选一并写明命令：重跑 `bash scripts/prepare-builtin-extensions.sh` 后用 staged 产物；或 `--extension <repo>/extensions/subagent-workflow/index.ts` 直连源码（pi 支持 TS 入口）；或引用 dev-link skill pi 模式（pi-link.sh，注意无需 --extension） |
| SUGGESTION | §5 P3 E2E 场景 2 | P0-13 fixture 前置未展开 | 「preset 一个含 ≥3 条历史 subagent 的 session（fixture：预写主 JSONL 含 toolCall/toolResult/bg-notify entry）→ 打开」缺关键前置：预写文件放哪个目录（pi sessions 目录布局/文件命名）、UI 如何发现它（SessionScanner.listAll 扫磁盘，机制成立但 spec 侧需构造）、打开走哪条链路（session.restore RPC 存在，:255；session.create 无 resume）——P4 场景 7 给了打开链路说明，P3 场景 2 没给；格式要求（首行 session header entry，extractor 依赖它推导 cwd）也未提 | P3 场景 2 补 fixture 布局与打开链路（对齐 P4 场景 7 的写法：预写 JSONL 到 pi sessions 目录 + UI 点击/session.restore），注明 session header entry 必需 |
| SUGGESTION | §8 P6 验证 2 | P0-13 手工场景不可判 | 「手工场景：场景 1 的 60s 窗口尾部收敛观察（真并发 2+ subagent 等 60s+）」只有操作没有观察点与 PASS 判定——观察到什么算通过（F5 场景下最后一个 subagent 完成后窗口 flush → bg-notify → notify 信号 → 重拉收敛？日志里看什么？），P6 验收记录要求「每场景一行 PASS/FAIL」无法落笔 | 补判定标准，如：「最后一个 subagent 完成后 ≤60s 窗口 flush + 一个 turn 内侧栏全部收敛终态；runtime 日志可见 bg-notify 与 session.subagentsChanged{kind:'notify'}」 |
| INFO | §6 P4 E2E 场景 7 步骤 2 | 可执行性 | 「等子进程自然结束（轮询 pid 消失）」的等待时长完全取决于 subagent 任务长度——kill -9 pi 后孤儿子进程会跑到任务完成，若引导 prompt 未限定短任务，E2E 步骤 2 等待不可控 | 强引导 prompt 明示「启动一个几秒内完成的短任务 subagent」 |
| INFO | §4 P2 E2E 步骤 5 | 观测手段 | 「日志可见重连全量重拉 RPC」的观测面未落地：第二 WS 连接只收 Server→Client 广播，看不到 Client→Server 的 getSubagents/getWorkflows RPC 帧；renderer store 现状仅失败路径有 console.error | 指明断言载体：page.on('console') 捕获 renderer 日志（守卫/重拉需加对应 log），或改断言 RPC 的间接效果（广播帧/DOM） |
| INFO | §3 P1 验证 | 措辞 | 单测小节标题「（vitest，renderer 目录跑）」下含 route-inbound（core 包）用例，实际从各自子包目录跑（§1 通用约束已写对，此处标题以偏概全） | 标题去掉「renderer 目录跑」或分列 |

## 第一轮修复核对表（验收项 1）

| 第一轮编号 | 内容摘要 | 判定 | 说明 |
|-----------|---------|------|------|
| MF-1 | waitForExtensionsReady 前置（runtime ready ≠ extension 就绪） | 已修复 ✓ | §1 ② 机制转述正确（resolved N extensions N≥8、90s、~16s 竞态链），本轮 read `ask-user-real.spec.ts:203` 核实数字属实；但归属表述引入小错（见 R2-SG：函数在 spec 私有，非 launch-app-real.ts 导出） |
| MF-2 | P1 mock E2E 依赖不存在的能力 | 部分 | 开发内容补「明确放弃 mock E2E spec」段落 + 验证改为单测+集成，路线正确；**残留**：P1 DoD 仍写「mock E2E 全绿」，与正文矛盾（R2-SG） |
| MF-3 | A6 探针无落点 | 已修复 ✓（带尾巴） | 总览 P0 行改口「A6 大文件性能探针在 P2 落地」+ P2 验证有完整步骤（fixture 结构/计时/阈值/缓存触发）；尾巴：合成器工具无开发归属（R2-SG） |
| MF-4 | extractor 空/错误语义边界未承接 | 部分（不完整修复） | subagent 侧已承接（P1 subagent.ts 守卫 + 单测断言，验证与开发内容对齐）；**workflow 侧同构暴露未覆盖**（R2-MUST_FIX，源码已核实） |
| SG-1 | P4 枚举连带文件未列全 | 已修复 ✓ | subagent-status.ts（normalizeSubagentStatus 映射表重写）+ 两个测试文件 + `packages/shared/src/subagent.ts` 精确路径，本轮核实三文件均存在 |
| SG-2 | P3 测试改造量低估 | 已修复 ✓ | 「整文件作废重写（324 行/8 用例）+ 24 处逐点改造」，核实 324 行属实 |
| SG-3 | P3 场景 1「秒级」伪选项 | 已修复 ✓ | 「本阶段只验有界收敛……移至 P4/P6」，与 P6「本阶段补齐」衔接成立 |
| SG-4 | A8「node 直连 pi rpc 发 sendMessage」死路 | 已修复 ✓ | 删死路候选并加澄清「pi RPC stdin 命令集无 sendMessage 命令」 |
| SG-5 | A10b 观测点缺失 | 已修复 ✓ | 两步法（pi stdout grep + 形态 B 挂 event-adapter.ts:303-304），本轮 read 核实挂点属实（setWidget 终止帧 lines:undefined 解析） |
| SG-6 | 进程消歧 + token 刷新 | 已修复 ✓ | §1 消歧段（--port/dataDir 键、禁宽泛 pkill）+ P2 步骤 3/4（重读 runtime.port/runtime-token） |
| SG-7 | P2 归因不纯 | 已修复 ✓ | P2 步骤 6「归因注意」+ P6 场景 8 重跑关闭归因，两处衔接一致 |
| SG-8 | P3 缺 event-adapter.ts 文件行 | 已修复 ✓ | P3 开发内容表已列（A10a 条件分支 + A10b :303-304 附近） |
| SG-9 | real bundle 前置 | 已修复 ✓ | §1 形态 A 前置 + P6 前置重申，与 11-real-e2e-specs §3 一致 |
| SG-10 | P5 取舍未声明 | 已修复 ✓ | 「取舍声明」段明确不实施设计 §7.4 第三条及其被取代原因 |
| INFO-1 | makePresetDataDir 是 spec 私有函数 | 已吸收 ✓ | §1 ① 注释（~50 行复制 + DEV_PI_AGENT 前提），本轮核实属实 |
| INFO-2 | A7 条件恒真 | 已吸收 ✓ | 改直陈「捆绑 0.84.1 ≠ 已核 dist 0.84.0，直接对捆绑版本重跑」 |
| INFO-3 | DoD 风暴量化 + resume 措辞 | 已吸收 ✓ | 单测断言拆分（N sid 各 1 次 RPC vs 去抖分开断言）+ 场景 7「session.restore 链路；session.create 无 resume 参数」（核实 protocol.ts:255 restore 存在） |

汇总：**4/4 must-fix 与 10/10 suggestion 均有对应修复动作；其中 MF-2 留 DoD 残留、MF-4 修复不完整（workflow 侧漏防，升格为本轮 MUST_FIX），MF-1/MF-3 的修复各带一处小尾巴。**

## 任务指定深挖项结论（验收项 2/3 覆盖声明）

| 深挖项 | 结论 |
|--------|------|
| P2 A6 合成器是否悬空 | **是**——验证依赖「合成器」但无任何阶段开发清单条目、无入库声明（R2-SG） |
| P4 waiting 态在 A10 裁决 b/退化时的可达性 | 计划有「无则 streaming」回落但**未显式注明条件性**；且 idle 位数据源（哪个磁盘 entry）与测试矩阵 fixture 维度缺失（R2-SG） |
| P5 pi CLI 实测 `--extension` 指向 | 计划给了「打包产物或 dev-link 路径」两个名词但**无落地命令**；extension 包无 build 脚本，staged 产物有 stale 假通过风险，dev-link pi 模式根本不需要 --extension（R2-SG） |
| workflow 侧 loadWorkflows 同构暴露 | **存在且被 P2 放大**——workflow-extractor catch→[] + store 无守卫（源码核实），判 MUST_FIX |
| P6 手工场景可执行性 | 操作可行（真并发 2+ subagent 等 60s+）但**无观察点与 PASS 判定**，验收记录无法落笔（R2-SG） |
| 其他 P0-11/12/13 新发现 | §10 图与总览表矛盾、P1 DoD mock E2E 残留、P6 秒级断言未条件化、waitForExtensionsReady 归属（见 Findings）；另核实 P3 场景 2 fixture 前置、P2 重连重拉挂点（use-connection.ts:226 `connected` watch 存在，P2 可落地） |

## 已核实为真的关键引用（本轮新增核实，无需修改）

`workflow-extractor.ts:139-145`（readFileSync catch→[]）与 `workflow.ts:144-158`（loadWorkflows 无守卫）、`workflow.ts:161`（RUNNING_RETRY_MS=500）；`useMessageEffects.ts`（handleSubagents/handleWorkflowUpdate/handleMessageComplete/handleSessionExited + createInboundEffects 工厂——P1「直调 onSubagentsChanged 回调」的集成测试形态可行）；`use-connection.ts:220-231`（重连成功点 + S1-W1 token 刷新注释，与 P2 步骤 4 一致）；`launch-app-real.ts`（launchRealApp/waitForRuntime 导出）与 `ask-user-real.spec.ts:203`（waitForExtensionsReady 私有实现，90s/minCount=8）；`event-adapter.ts:295-304`（setWidget subagent-stream 终止帧 lines:undefined）；`message-bus.ts`（TOPIC_TABLE `session.subagents: 'state'` 条目、topicOf fallback='stream'、STATE_TYPE_KEY_MAP）；`route-inbound.ts:93/:202`（onSubagents）；`subagent.ts:139-149`（loadSubagents catch→loadError 保留分区，现状无空守卫）；`shared/src/subagent.ts:26`（SubagentStatus 现状 6 值，P4 拆分/归并映射对得上）；`runtime/test/event-interpreter-subagent-push.test.ts`（324 行）/ `subagent-status.test.ts`（62 行）/ `shared/__tests__/subagent.test.ts` 均存在；`protocol.ts:1283`（reply 复用 push）、`:255`（session.restore）；`SessionScanner.listAll` 扫磁盘；`makePresetDataDir` 实现（tasks-drawer-real.spec.ts:40-52）；`scripts/prepare-builtin-extensions.sh` / `bundle-extensions.mjs` / `verify-lifecycle-e2e.sh` / `validate-runtime-bundle.sh` / `dev:smoke`（package.json:18）；`useBackgroundWork.hasBackgroundWork`、`sessionStatus.ts` STATUS_ICON/DOT_CLASS（compacting/retrying 存在，P4「映射表裁剪」属实）；`extensions/subagent-workflow/package.json`（main=index.ts、pi.extensions=./index.ts、无 build 脚本）；dev-link SKILL.md（pi 模式 symlink 机制）；`docs/testing/11-real-e2e-specs.md` §3/§4/§5.1/§5.3/§7 章节号属实。
