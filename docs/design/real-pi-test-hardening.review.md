# real-pi 测试基建加固设计文档 · 对抗式审查报告

> 待审：`docs/design/real-pi-test-hardening.md`
> 依据：`rubric-design-doc.md`（P0/P1 清单）· `design-principles.md`（12 准则）· `anti-patterns.md`
> 所有事实断言均已 read 源码核实（行号为当前 HEAD dev-0.9.10 @ 工作区实际值）。

## Summary

4 must-fix, 3 suggestions.

总体评价：文档质量显著高于均值——SCQA 开篇、双使用者终态视角、探针清单、决策四件套、真实场景验收全部到位；绝大多数源码引用（`agent-session.js:833`、`rpc-mode.js:298-310/329-332/348`、`ci.yml:147`、broadcast-getstate `:87/:140`、9 处 baseline、11 个消费文件）逐行核实精确命中。剩余问题是 4 处对抗深挖才能暴露的结构性缺口：**两条方案关键行为断言未进探针清单**、**一类既有测试语义（流中投递）落在方案覆盖之外**、**守卫与 repo 中既有同类测试重叠**、**一处验收通过标准的口径张冠李戴**。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D1 / §3.3 D4 / §5 U3 | P0-12 副作用 | **流中投递（steer/follow_up）语义区完全未纳入方案**。已有用例依赖「busy 时仍可注入」能力：broadcast-getstate.test.ts:149 在 turn 进行中 `sendCommand('follow_up')`（:144 注释「turn 进行中 follow_up 入队」），pi-protocol-contract.test.ts:291 `sendCommand('steer')`，completion-backflow-e2e.test.ts:116 以 streamingBehavior 转发 prompt。而 D1 护栏=「prompt 入口等 !busy」、D4 runTurn=「mark→prompt→等 end」原子原语，均只有「空闲起步」形态，没有「mid-turn 插一步」的缝。U3 自评「机械性迁移…不改任何断言语义」（§5 U3 行）与事实冲突：broadcast-getstate 第二轮（`:146` 注释「followUp 在 run 内 drain——本要停时队列非空→继续下一轮」）一旦被实施者规整成 runTurn，「流中入队」前提消失，`:175-176` 的 queue_update 非空守卫将失败 | U3 增加「语义敏感调用点」分类：steer/follow_up 调用保持原命令形态、明确不入 runTurn，并在 D1 说明护栏只拦 prompt 入口不拦流中控件；探针清单补 P-busy-composite（followUp 接续多轮期间 busy 保持 true 直到最终 agent_end——busy 清态口径的关键行为断言，现无任何探针） |
| MUST_FIX | §3.3 D2 / §3.4 | P0-16 探针 | **P-abort 只验一半，recover 主路径成立所需的另一半断言缺失**。「abort → 等 agent_end drain → 重试一次」能截断传染链的前提有二：① agent_end 必达（P-abort 已覆盖 ⛔）；② **abort 后子进程处于干净态、新 prompt 能完整跑完一轮**。② 未列为断言、无探针。若 abort 留下半截 assistant entry/中断的工具执行残态且影响下一轮产物，重试 turn 会以静默劣化成功——恰恰造出 G2 要消除的新假红；且现有降级路径无法区分此情形（agent_end 到达即视为 P-abort 通过） | 探针 P-abort 补续用性断言：实施期在 abort 后重发 prompt，跑完整轮并断言本轮事件序列形态正常（message_start/end 配齐、事件计数与首轮基线一致）；失败则 recover 固定降级 dispose+respawn（现为二选一路径，改为条件化） |
| MUST_FIX | §3.3 D5 | P0-12 遗漏 + P0-11 事实 | **repo 中已存在 REAL_PI_TESTS 守卫，D5 未提及、其立论证据失准**。session-manager-e2e-fixture-unit.test.ts:13-17 已实现「REAL_PI_TESTS 分池注册」校验（readFileSync vitest.config.ts + `toContain('src/__tests__/equivalence/session-manager-full-e2e.test.ts')`），跑 main 池（不在 REAL_PI_TESTS 数组、CI 不跳）、手法与 D5 同源（静态文本解析配置）。D5 证据栏写「维护契约现状是纯文档，无机制兜底」与仓库不符（兜底存在但仅覆盖 1/11 文件）；照 D5 新建 test/real-pi-pool-sync.test.ts 将形成两套并行守卫、口径漂移 | U4 改为**扩展现有** fixture-unit 守卫（把单点 toContain 升级为 import-spawnPiFixture 集合 vs REAL_PI_TESTS 全量 diff），或在 D5 显式声明取代关系；diff 逻辑避免 regex 解析演进后的脆裂（如 import 配置常量模块或解析 project 结构） |
| MUST_FIX | §4 场景 4 | P0-13 验收 + P0-11 事实 | **「<120s 既有预算口径」出处张冠李戴，通过标准不可靠**。<120s 出自 broadcast-getstate.test.ts:22（「fixture 进程复用…总时长 <120s 预算」，2 turns 文件）；tool-call-index 的既有预算实为 beforeAll hook timeout **420_000ms**（tool-call-index.test.ts:119，注释口径「冷启动+轮次等待+余量」），三连发 3×mimo 轮次（含强制 bash 工具往返）正常耗时即可 >120s。照此标准执行场景 4，合法绿跑会被判红，验收 gate 无法稳定裁决 | 改为受控对照口径：「单跑 tool-call-index 耗时 ≤ 改造前同环境基线 + ε（如 +5%）」或直接以「全程无 RPC timeout、无 Agent is already processing 错误」为准，删掉凭空的绝对值上限 |
| SUGGESTION | §2 / §4 示例 / §5 | P1-8 细节群 | 多处表达性偏差（不影响方案成立）：① 「waitForEvent 调用约 30 处」实测 equivalence 下 `.waitForEvent(` 共 **24** 处（其中 broadcast-getstate/scalar-state-invalidation/usage-queue-commands-invalidation 三文件为 0——它们的 baseline 是 collectEvents 计数器而非 waitForEvent，D3「全部可迁移为 markEvents/since」实际是范式替换而非参数改造）；② 场景一终端示意失真：tool-call-index 实有 **7 个 it**（:70/:77/:84/:128/:138/:159/:186）非 "(3 tests)"，且首行 "✓ broadcast-getstate" 与下行 "Test Files 2 failed" 矛盾；③ 「F4/F5/F6」编号首次出现于 §5 却全文未定义（孤儿编号，读者无法回溯到缺陷 3 与两项登记待办）；④ pi-fixture.ts `events.push` 实际 :357 非 :356；⑤ §1 称 fixture 暴露「6 个方法」含 exited（实为 boolean getter 属性，另有 piPath/sessionDir 未计）；⑥ 场景二「3 轮 marker 均 PASS」的 marker 未定义（指 pr-pre-merge RESULTS 行） | 逐处订正数字与示意；F4/F5/F6 改回「缺陷 3 / 解耦方向 / 环境探针」等已定义名 |
| SUGGESTION | §4 场景 2 | P0-18 轻 | 命令 `pr-pre-merge.sh --test-result PASS --quiet` 有未声明的前置：脚本规定 --test-result 模式下 coverage.json 缺失或 base 不一致即 exit 2（scripts/pr-pre-merge.sh:24），coverage.json 由 PR 流程外部产出。执行者直接照抄场景命令会先撞环境错误而非拿到测试结果 | 场景步骤补一句前置：coverage.json 在位（由 cw/pr 流程产出）或改写为先手动设 env 再跑的替代形式 |
| SUGGESTION | §3.3 D1 | P1-8 表述 | 「护栏 by construction」声明存在两处免护通路未圈出：① `writeLine` 直发原始 JSONL 可绕过 busy 判定（既有消费者 session-manager-full-e2e.test.ts:144 就在用 writeLine 直写 payload）；② 上文 finding 已述的 steer/follow_up 流中控件。原样宣读「想错都错不了」（§3.1 场景二）会被读者放大理解为全通路保证 | D1 加一段「护栏覆盖范围与免护区」小节，显式列出 writeLine/steer/follow_up 不经护栏及各自的使用纪律 |

## 逐项判定（rubric 四态）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | §1-§5 齐全，各段功能完整 |
| P0-2 delta 链 | 通过（有瑕疵） | 正文无 vN/Rxx/参见上版；但 F4/F5/F6 孤儿编号违反自包含精神 → S1 |
| P0-3 结论先行 | 通过 | 一句话结论 + SCQA 四段；抽查 §2/§3/§4 首句均为该章结论句 |
| P0-4 问题定义 | 通过 | §1 Q 直指根因（传染机制/隐性规则/证据链断裂），非表象复述；缺陷因果链有当日实锤 |
| P0-5 使用者视角 | 通过 | §3.1 按「跑门禁的人/写测试的人」两类使用者给四场景先行，机制（§3.3）后置 |
| P0-6 术语定义 | 通过 | turn/共享 fixture/事件游标 §2 首现即定义并绑定实例 |
| P0-7/8/9 方案对比 | 通过 | A-D 四案 × 长期/短期/风险三栏，明确推荐 A，被否案给出「若用它 §2 例子会怎样」 |
| P0-10 是否真解决目标问题 | 通过（有注记） | G1-G4 ↔ 缺陷 1-3 ↔ D1-D6 ↔ 场景 1-5 因果闭环；波动源诚实划出 scope。注记：G1/G2 的达成度受 F1/F2 两条 finding 限定 |
| P0-11 关键事实 | **部分不通过** | 正确命中率高（见下「已核实一致清单」）；但 D5 证据「无机制兜底」与场景 4「<120s 口径」两处失准且影响决策（F3/F4） |
| P0-12 副作用/遗漏 | **不通过** | steer/follow_up 流中投递语义区整体遗漏（F2）；守卫重复建设（F3） |
| P0-13 验收 testable | **部分不通过** | 场景 1/3/5 步骤-标准-恢复指引完备；场景 4 标准建立在错误事实上（F4） |
| P0-14 验收非 mock | 通过 | 五场景全为真实子进程/真实 LLM/真实门禁脚本；pi-fixture 既有单测仅作 U2 单元门内回归，不冒充验收 |
| P0-15 投入匹配 | 通过 | 中等改动配 5 场景 + 负向反向验证，投入充分 |
| P0-16 探针 | **不通过** | P-abort 断言不完备（F1）；其余探针规范良好（⛔ 均带降级路径 ✅） |
| P0-17 数据流图 | 通过 | §2 ASCII 图标出 pending Map/events 数组/stderr ring buffer/双向箭头物理位置 |
| P0-18 错误恢复指引 | 通过（有瑕疵） | 场景三/四 👉 单跑命令齐全；D2/D6 错误拼 stderr tail + 指引；唯场景 2 前置条件漏述（S2） |
| P1-1 关键概念例子 | 通过 | 终态章节代码示例可直接指导 API 形状 |
| P1-2 拆分 justification | 通过 | U1-U4 每个「为什么这么拆」独立成栏且排序逻辑（先可观测再修因后防漏）自洽 |
| P1-3 受众背景 | 通过 | §1「系统是什么」段补足无背景读者 |
| P1-4 alternatives 记录 | 通过 | 六个决策全部记录被否项 |
| P1-5 MECE | 通过 | 三缺陷互相独立 + 背景放大器分层（波动源/放大器/结果）分离 |
| P1-6 减法优先 | 通过 | D6 拒抽公共工具（30 行照抄）、D3 拒翻转默认语义、D1 拒增加轮询 IPC |
| P1-7 scope 不越层 | 通过 | 止于基建 API 形状 + 接线单元，函数体留白实施层；生产代码显式 out-of-scope |
| P1-8 细节错误 | 有（S1） | 计数/示意/编号/行号四处细节，均不影响决策 |
| P1-9 决策四件套 | 通过 | D1-D6 均采用/被否/证据/效果分行 bullet，无连排 prose |
| P1-10 负面行为验收 | 通过 | 场景 4（护栏不误伤）+ 场景 5（漏登记必红）构成负向验证 |

## 已核实一致的清单（对抗验证后放行）

以下文档断言逐一经源码核实命中，不再列为 finding：

- `Agent is already processing...` 拒绝文案：agent-session.js:**833** 逐字节一致
- rpc-mode.js prompt preflight ack（:295-310 `preflightResult` 内 `output(success(id,"prompt"))`）、abort 转 `session.abort()`（:329-332）、get_state 含 `isStreaming`（:347-348）
- ci.yml:**147** `XYZ_SKIP_REAL_PI: '1'`
- broadcast-getstate：beforeAll :87-88、round-1 waitUntil :140（TURN_TIMEOUT_MS=120_000 @:50）、baseline 计数 grep -c = **9**
- tool-call-index 三连发裸匹配：for 循环 :112 起、:116 裸 `waitForEvent(e => e.type==='agent_end', 120_000)`
- 锁子进程无输出监听：pi-settings-store.test.ts spawn（~:259）无第三参/无 data 监听，失败抛 `child exited (code ...) before holding lock`（~:283）
- REAL_PI_TESTS：vitest.config.ts:22 数组 11 成员与「11 个消费文件」精确一致；:20 注释文案「漏加会落回 main 满并行组，复发饿死超时」逐字一致
- 共享 fixture 三文件：broadcast-getstate / chaos（beforeAll @:83）/ tool-call-index
- DEFAULT_COMMAND_TIMEOUT_MS=30_000、stderr ring buffer 50 行 / tail 10 行、waitForEvent `events.find` 全量匹配实现
- pi 版本 npm ls = @earendil-works/pi-coding-agent@0.84.1（dist 为权威源，符合项目约定）

## 结构性观察（不计 finding）

- 方案对比质量高：B/C 的否决论证用了「若采用，§2 缺陷会如何重演」的可感知推演（准则 4 风格），非空洞贬低。
- 探针纪律整体建立（§3.4 表），缺口集中在「断言枚举不全」而非「没有探针习惯」——修复成本低。
- typecheck 兜底核验通过：runtime tsconfig include=["src","test"]（tsconfig.json:14）+ pre-merge --skip-tests/--test-result 模式跑 `typecheck:runtime`（pr-pre-merge.sh:176-177），D3「TS 编译期抓漏改点」的前提成立（仅默认模式不含 runtime typecheck，实施时用前两种模式即可）。

---

# 第二轮复审（聚焦核对第一轮 7 项修复）

> 复审对象：修订版 `docs/design/real-pi-test-hardening.md`
> 范围：仅核对第一轮 4 MUST_FIX + 3 SUGGESTION 是否正确修复、修复是否引入新矛盾；不改设计文档。
> 方法：对抗姿态保留——每个「已修复」判定都以修复点新引入的事实断言重新 read 源码为准（行号为当前工作区实际值），文本自查不采信。本轮核实命中的关键源码：broadcast-getstate `:144/:146/:149`、pi-protocol-contract `:291`、completion-backflow-e2e `:116-119`、session-manager-full-e2e `:144`、tool-call-index `7 its`/`:106 注释`/`:122`、session-manager-e2e-fixture-unit `:12-16`、pi-fixture.ts `:99/:101/:102/:104-112/:357`、pr-pre-merge.sh `:24/:89-108/:158`、pr-status.sh 存在性、pi 0.84.1 dist `pendingMessageCount`/`isStreaming`。

## Summary

**0 must-fix, 1 suggestion.**

第一轮 7 项发现**全部修复到位**；全文 grep 无旧表述残留（「约 30 处」「F4/F5/F6」「(3 tests)」零命中，`real-pi-pool-sync.test.ts` 仅存于 D5 被否栏属合法记录）；修订版新引入的全部事实断言逐一经源码核实命中，包括降级案的关键 API——`get_state` 响应确含 `pendingMessageCount`（`dist/modes/rpc/rpc-mode.js:357`）与 `isStreaming`，P-busy-composite 降级路径可行。唯一 suggestion 是 D5 扩展表述内嵌的一个守卫覆盖域边界（防御收紧建议，非错误）。

## 逐项修复核对（7/7 到位）

| 编号 | 判定 | 核对证据（文档位置 → 源码实况） |
|------|------|--------------------------------|
| MF1 流中投递遗漏 | ✅ 到位 | D1 新增「护栏覆盖范围（免护区显式声明）」列三免护通路，四组引用全部源码定位命中：session-manager-full-e2e **:144** `fx.writeLine(...extension_ui_response...)`、broadcast-getstate **:149** `sendCommand('follow_up')`（**:144** 注释「turn 进行中 follow_up 入队」原文吻合）、pi-protocol-contract **:291** `sendCommand('steer')`、completion-backflow-e2e **:116-119** streamingBehavior 条件转发。busy 清态口径句引 broadcast-getstate **:146** 注释（「followUp 在 run 内 drain……继续下一 turn」）逐字吻合。U3 新增「语义敏感调用点不迁移」分类，三处文件行号与 D1/D4 完全一致。探针 P-busy-composite 进 §3.4 表 + D1 尾注 + §5 待验证检查点三处口径一致；其降级案「`get_state` 轮询 `pendingMessageCount===0` 且 `!isStreaming`」两字段均实测存在（rpc-mode.js:357 get_state 响应组装含 `pendingMessageCount: session.pendingMessageCount`；agent-session.js:1151 getter；RpcSessionState 接口声明 d.ts:157）|
| MF2 P-abort 只验一半 | ✅ 到位 | D2 补「运行时断言（两条）」：① agent_end 必达 + ② abort 后子进程干净、新 prompt 能完整跑完一轮（message_start/end 配齐、事件形态与首轮基线一致），并写明 ② 缺失的后果（静默劣化成功 = 新假红）。降级条件化：「①或②不成立 → recover/重试固定降级 dispose+respawn，护栏等待逻辑不变」。§3.4 P-abort 行与 §5 待验证检查点同步改写，三处一致 |
| MF3 D5 守卫重叠 | ✅ 到位 | 改为扩展 session-manager-e2e-fixture-unit.test.ts 既有守卫。源码核实：该用例确为 readFileSync(vitest.config.ts) + `toContain('...session-manager-full-e2e.test.ts')` 单点校验，注释自述理由「解析静态文本即可（配置 import 会拉起 globalSetup，超出 unit 校验边界）」**:14** 逐字吻合。四处交叉引用一致：§1 In-scope（扩展现有测试，见 D5）/ §3.1 场景四 FAIL 头（指向 fixture-unit 文件）/ §4 场景 5（跑扩展后的守卫用例）/ §5 U4（改写既有注册校验用例）。diff 提取前提成立：REAL_PI_TESTS 为纯字符串字面量 `as const` 数组（vitest.config.ts，11 成员），非 regex 解析结构 |
| MF4 场景 4 口径张冠李戴 | ✅ 到位 | 通过标准改为受控对照：「耗时 ≤ 改造前同环境基线 +5%（受控对照，不设凭空绝对值上限）」+「全程无 RPC timeout、无 Agent is already processing」双判据。420_000ms 归属改正：tool-call-index beforeAll hook timeout 实测闭合于 **:122**，注释「预算 = 冷启动 + 轮次等待 + 余量」**:106** 吻合 |
| S1 细节群（六子项） | ✅ 全部落实 | ① `.waitForEvent(` 计数实测 **24**（8 文件分布 4/4/3/1/4/1/2/5；broadcast-getstate / scalar-state-invalidation / usage-queue-commands-invalidation 三文件 0 处，11 文件闭环）② tool-call-index **7 个 it** 枚举命中（:70/:77/:84/:128/:138/:159/:186），场景一示意重排后无内部矛盾 ③ F4/F5/F6 零残留（登记待办具名化）④ `events.push` 实测 **:357** ⑤ 接口计数准确：5 方法（sendCommand/writeLine/collectEvents/waitForEvent/dispose @ :104-112）+ 3 只读属性（piPath :99 / sessionDir :101 / exited :102）⑥ marker 定义成立：`write_result_marker()` 写 `.review/premerge-result` 含 `result="$result"` 行，函数注释「写入 stage gate marker（供 pr-status.sh 读取）」（pr-pre-merge.sh ~:158），pr-status.sh 存在 |
| S2 coverage.json 前置 | ✅ 到位 | 「pr-pre-merge.sh:24 强制，缺失 exit 2」：头注释 **:24** 逐字 + 实际校验逻辑 **:89-108**（缺文件 / base 缺失 / base 不一致三分支，各带恢复指引）。「由 PR 流程 coverage-gate 产出」：脚本恢复指引指向 pr-cr-fix/scripts/coverage-gate.py（实际存在） |
| S3 免护区声明 | ✅ 到位 | D1 免护区小节（writeLine / steer/follow_up / streamingBehavior 转发三通路 + 各自使用纪律）+ §3.1 场景二补「护栏不管辖的免护通路见 D1」消除「想错都错不了」的全称误读风险 |

## Findings（本轮新增）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §3.3 D5 | P0-12 边界（防御收紧，非错误） | 守卫提取域限定「grep `src/__tests__/` 下 import spawnPiFixture 的文件集合」，但 main 组 include 为 `['test/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts']`（vitest.config.ts projects.main.include）——未来若把 real-pi 测试写到 `test/` 下（从 test/ 跨目录 import equivalence/pi-fixture 技术可行，当前无先例），文件将落 main 满并行组（复发饿死超时，恰是 G4 要防的场景）且逃过守卫 | grep 范围扩为 src 与 test 两目录；或在 D5 显式声明目录纪律「spawnPiFixture 消费方只准放 src/__tests__/equivalence/」作为守卫的前置约定 |

INFO 备注（不计数字、不影响决策，列出仅供顺带订正）：① D5 引守卫用例行号区间「:13-17」，实测 it 体主体为 :12-16（it@12、readFileSync@13、注释@14、toContain@15），区间已框住实现主体；② 场景 2「脚本 RESULTS 行」措辞与脚本内部 RESULTS 步骤汇总数组撞名——可读 marker 实为 `.review/premerge-result` 文件中的 `result="PASS\|FAIL"` 行，要素全真不至误导执行。

## 新矛盾扫描（对抗复核后放行）

- **残留词 grep**：「约 ?30」「F[0-9]」全文零命中；`real-pi-pool-sync.test.ts` 仅出现在 D5 被否栏（否决论证需要指名被否方案，合法保留）；场景一示意不再有 ✗/✓ 自相矛盾行。
- **D3 × U3 表面张力**：D3「全部 24 处既有调用点随 U3 一并迁移（TS 编译期抓漏改点）」vs U3「语义敏感调用点不迁移」——两层对象不同：D3 指 waitForEvent 第二参数签名 break（数字→对象形态，编译器强制全覆盖），U3 指 runTurn 收编范围（仅「空闲起步 prompt + 等 agent_end」点）。合读自洽，实施者行动清单无歧义，放行。
- **现状 vs 目标态 API 面**：§1「暴露 5 个方法…3 个只读属性」是对改造前 fixture 的背景介绍；runTurn/recover/markEvents 由 §3.1 场景二示例与 D2/D3/D4 目标态描述承接，现状/目标分层正常，非矛盾。
- **「120s」字样余留处**：§2 缺陷 1 因果链（A 超时 120s，TURN_TIMEOUT_MS=120_000）与缺陷 2 例（裸匹配预算 120_000）均为源码真实值，与场景 4 已删除的错误口径无关。

## 结论

七项修复全部到位且互洽，修订版可进入实施。**0 must-fix**（1 suggestion 见上表，2 条 INFO 仅供顺带订正）。
