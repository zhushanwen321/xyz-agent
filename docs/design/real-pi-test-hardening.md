# real-pi 测试基建加固：turn 护栏、事件新鲜度与子进程可观测性

> **一句话结论**：packages/runtime 的 real-pi 等价性测试连环假红的根因是 fixture 缺一层「turn 生命周期抽象」——把 turn 护栏、事件游标、失败兜底收进 `pi-fixture.ts` 一处，11 个消费文件自动继承正确语义；配套锁子进程可观测化与 REAL_PI_TESTS 清单守卫。全部为测试基建改动，零生产代码。

## §1 背景目标

- **S（情境）**：packages/runtime 有一族「real-pi 等价性测试」（11 个文件）：spawn 真实 `pi --mode rpc` 子进程、跑真实 LLM 轮次，锁定 runtime 与 pi 协议层面的行为等价（live ≡ reload 基线）。它们由共享 fixture `pi-fixture.ts` 提供 `spawnPiFixture()` 基建。
- **C（冲突）**：2026-08-27 本地 pre-merge 门禁（`scripts/pr-pre-merge.sh`，实跑 `test:runtime` 全量双池）连续 3 轮各挂一个**不同**的 real-pi 文件，单跑全部绿色——表象像偶发抖动，实测是三个架构缺陷在「真实 LLM 延迟无上界 + 满并行 + 高负载」下被随机引爆。门禁红绿失去意义：红不代表真问题，绿只靠运气。
- **Q（问题）**：如何让单个用例的失败（如慢 LLM 超时）就地终止、不传染同文件后续用例，让门禁结果重新可信，并让真实子进程故障现场可被观测？
- **A（答案）**：护栏下沉 fixture——在 `pi-fixture.ts` 内建 turn 生命周期抽象（busy 护栏 + 事件游标 + recover 兜底），把「判断上一轮结束没有」从各测试文件作者的自觉变成基建的机制保证；锁子进程照抄 fixture 已有的 stderrTail 模式补齐可观测性；REAL_PI_TESTS 分池清单守卫从「单点校验（1/11 覆盖）」升级为「全量双向 diff」。

**系统是什么**（给不了解背景的读者）：`pi-fixture.ts`（`packages/runtime/src/__tests__/equivalence/`）是测试基建模块，封装「spawn 一个真实 pi CLI 子进程、经 stdin/stdout JSONL 收发 RPC 命令与事件」的全部细节，向测试文件暴露 5 个方法（`sendCommand`（发 RPC 命令等响应）、`waitForEvent`（轮询等某类事件出现）、`collectEvents`（取事件快照）、`writeLine`（直写原始 JSONL 行）、`dispose`）与 3 个只读属性（`exited`/`piPath`/`sessionDir`）。pi 的 RPC 协议是「先应答后处理」的 ack 语义：发 `prompt` 命令立即收到成功响应，LLM 轮次随后异步推进，轮次结束时 stdout 上出现 `agent_end` 事件。

**设计目标**（从开发者体验倒推）：

| 编号 | 目标 |
|------|------|
| G1 | 单个用例失败不传染：慢 LLM 导致用例 A 超时后，同文件用例 B 不再死于 `Agent is already processing`，失败归因停留在真实失败的用例上 |
| G2 | 门禁结果可信：开发机高负载下 pre-merge 三连跑，红 = 真问题，绿 = 真通过，不再出现「每轮红不同文件、单跑皆绿」 |
| G3 | 子进程故障可观测：任何真实子进程（pi fixture / 锁子进程）崩溃，抛出的错误消息自带临终输出，可直接定位崩因 |
| G4 | 分池清单防漏靠机制：新增 import `spawnPiFixture` 的测试文件忘记登记 `REAL_PI_TESTS` 时，测试套件立即红并指出文件路径 |

**In-scope**：`packages/runtime/src/__tests__/equivalence/pi-fixture.ts` 改造；11 个 real-pi 消费文件的护栏接线；`packages/runtime/test/pi-settings-store.test.ts` 锁子进程可观测化；REAL_PI_TESTS 同步守卫从单点校验扩展为全量 diff（扩展现有测试，不新建并行守卫，见 D5）。
**Out-of-scope**：协议等价性与真实 LLM 解耦（record-replay / fake 流式端点，方向性最优但重构量大，单独立项）；门禁前置环境探针（负载/provider 可达性 fail-fast，登记待办）；生产代码（本设计零改动）；CI 配置（CI 本就 `XYZ_SKIP_REAL_PI=1` 整组跳过，行为不变）。

## §2 现状与问题分析

**结论：三个缺陷各自独立足以造成连环假红，且都已在代码中逐行核实（2026-08-27 复核，行号对应当天 HEAD `6963beac3`）。**

**术语定义**（本节首次出现，后文反复使用）：

- **turn**：一次完整的 LLM 轮次——从 `sendCommand('prompt')` 收到 ack 响应，到 stdout 事件流上出现对应的 `agent_end`。就是 §2 缺陷 2 例子里 tool-call-index 三连发中的「每一发」。
- **共享 fixture**：`beforeAll` 里 `spawnPiFixture()` 一次、整个 describe 的全部 `it` 复用同一个 pi 子进程的用法形态。11 个 real-pi 文件中有 3 个是这种形态：broadcast-getstate、chaos、tool-call-index（恰是本次连环假红的主力受害者）；其余 8 个为每用例独立 spawn（afterEach dispose）。
- **事件游标 / 新鲜度**：`events[]` 是 fixture 内只增不减的全量事件数组；「游标」是指数组下标，「只认游标之后到达的事件」即新鲜度语义。

**物理数据流**（测试代码到 pi 子进程）：

```
测试文件 it()
   │ sendCommand('prompt', ...)            waitForEvent(predicate)
   ▼                                       ▲（每 50ms 轮询）
┌────────────────── pi-fixture.ts ──────────────────┐
│  stdin 写 {id,type,...}\n ──▶ pi 子进程           │
│  pending: Map<id, {resolve,reject,timer}>         │
│  events: PiStreamEvent[]（只增，全量历史）   ◀────┼── stdout 逐行 JSONL
│  stderrLines: string[]（ring buffer 50 行）◀─────┼── stderr
└───────────────────────────────────────────────────┘
   │                                                    │
   ▼                                                    ▼
sendCommand 的 promise（按 id 配对 response）   events.find(predicate) ← 缺陷 2：全量历史匹配
```

**缺陷 1：共享 pi 子进程没有 turn 终态护栏，失败会传染（最重）**

`sendCommand`（pi-fixture.ts:360-381）只检查进程是否 exited，没有 agent 忙闲概念——不查 busy、不等上一轮终态、用例失败后也不 abort 在途 turn。实锤因果链（2026-08-27 第一轮 pre-merge 实际失败）：

1. broadcast-getstate.test.ts:87-91 在 `beforeAll` 创建一个 fixture，两个用例共用同一 pi 子进程；
2. 用例 A 发出 prompt 后 `waitUntil('round-1 agent_end', …, 120_000)`（:140）；当天真实 LLM（`xiaomi-token-plan-cn/mimo-v2.5-pro`，走外网）单轮超过 120s → A 超时失败，但这轮 generation 在共享子进程里**继续跑**；
3. 用例 B 在同一子进程发出自己的首个 prompt → pi 直接拒绝。该拒绝文案在 pi 0.84.1 实装版核实存在（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:833`）：`Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`

一次 provider 慢，毒死整个文件的所有后续用例。

**缺陷 2：waitForEvent 匹配全量历史事件，没有新鲜度语义**

`waitForEvent`（pi-fixture.ts:392-417）的实现是 `events.find(predicate)`——在包含所有历史事件的数组里找第一个命中。上一轮留下的旧 `agent_end` 会被当成「本轮结束」瞬时命中。实锤旁证是同一个代码库里两种写法并存：

- broadcast-getstate 的作者意识到了问题，手工用 baseline 计数防御（`agentEndsBefore` / `queueUpdatesBefore`，全文 9 处）；
- tool-call-index.test.ts:113-122 的三连发循环里 `waitForEvent(e => e.type === 'agent_end', 120s)` 是**裸匹配**——attempt-2 极可能拿到 attempt-1 的旧事件，「等上一轮结束」退化成「零等待立刻重发」，第二发 prompt 打进还在处理的 turn。

全库统计：11 个 real-pi 文件中 `waitForEvent(` 调用共 24 处（其中 broadcast-getstate / scalar-state-invalidation / usage-queue-commands-invalidation 三文件为 0 处——它们的 baseline 防御走 `collectEvents` 计数器路线，全文计数防御分别 9/4/2 处），有计数防御的仅这 3 个文件。守卫纪律靠各文件自觉，不一致即踩坑——这正是缺陷的架构本质：**正确性依赖每个作者知道一条隐性规则**。

**缺陷 3：锁子进程崩溃的证据链是断的**

`test/pi-settings-store.test.ts:259-267` 用 `spawn(process.execPath, ['-e', …])` 起一个模拟 pi 持锁的子进程，但没有挂任何 stdout/stderr 监听（spawn 默认 pipe 但无人读取）。失败路径（:283-285）只读 `child.exitCode` 抛通用错误：

```
child exited (code 1) before holding lock
```

对照：pi-fixture.ts 对 pi 子进程有 `stderrLines` ring buffer（50 行）并在所有错误消息里拼 `stderrTail()`——同一「子进程输出 tail 捕获」模式，一处有一处没有，说明它没被固化成可复用模式。工作区同款脚本连续跑 40 次 0 崩溃，说明触发条件只在满量池环境出现；每次出现我们都看不见临终遗言，只能瞎猜——这是该失败模式至今无法定因的直接原因：**不是原因不存在，是架构把证据丢了**。

**背景放大器（非根因，分层列出）**：

| 层 | 因素 | 性质 |
|----|------|------|
| 波动源 | 真实网络 LLM 进入断言关键路径（mimo 外网往返），延迟无上界 | 结构性（本设计不消除，见 out-of-scope 的解耦方向） |
| 波动源 | 满并行 main 组里混着真实子进程用例（锁子进程测试在 main 组，不在分池保护范围） | 结构性 |
| 放大器 | 测试当天机器高负载（同花顺 95% CPU 等），拖慢 JS 泵与事件轮询 | 环境 |
| 结果 | 每轮长池随机红不同文件、单跑皆绿——「定时炸弹 × 随机引信」 | — |

CI 从不见这些红：`.github/workflows/ci.yml:147` 显式 `XYZ_SKIP_REAL_PI: '1'`，CI 整组跳过 real-pi；它们只活在本地 pre-merge（pr-cr-fix SKILL.md 的 [MANDATORY] 契约：开发验收必须跑 real-pi，skip 输出即验收不完整）。

## §3 解决方案

**结论：推荐方案 A——护栏下沉 fixture，一处改动 11 文件受益，机制防复发；B/C 各只治一个缺陷且留复发通道，D 方向正确但单独立项。**

### 3.1 终态（使用者视角）

使用者是两类开发者：**跑门禁的人**（执行 pre-merge，看红绿）与**写测试的人**（新增/维护 equivalence 用例）。

**场景一：跑门禁的人遇到慢 LLM 的一天（成功路径）**

```
$ bash scripts/pr-pre-merge.sh --test-result PASS --quiet
...
✗ broadcast-getstate.test.ts > 用例 A 事件风暴   # 超 120s：真实慢信号，归因停在 A
✓ broadcast-getstate.test.ts > 用例 B 队列操作   # 护栏挡住 in-flight turn，B 正常运行
✓ tool-call-index.test.ts (7 tests)              # 三连发每发都等本轮 agent_end，无假命中
```

用例 A 仍然失败（LLM 真的慢，这是真实信号），但失败**停在 A**：B 的首个 prompt 进入 fixture 的 busy 护栏——等待上一轮终态，超预算则 fixture 主动 abort 在途 turn 并 drain，B 拿到干净子进程正常运行。门禁报告里 A 的红归因清晰，B 不再陪葬。

**场景二：写测试的人新增一个共享 fixture 用例（护栏白得）**

```ts
beforeAll(async () => { fx = await spawnPiFixture() })
afterEach(async () => { await fx.recover() })   // 一行兜底，防传染
afterAll(async () => { await fx.dispose() })

it('case B', async () => {
  await fx.runTurn('做点什么', 120_000)          // mark→prompt→等本轮 agent_end，一体化
  // 不需要知道 agentEndsBefore 这类手工 baseline 写法——基建已保证只等本轮
})
```

作者不再需要知道「等 agent_end 要先记 baseline 计数」这条隐性规则——`runTurn` 把 turn 等待原子化，`recover` 把失败兜底固化。prompt 通路想错都错不了（by construction，而非靠纪律；护栏不管辖的免护通路见 D1「护栏覆盖范围」）。

**场景三：锁子进程崩溃（失败路径 + 恢复指引）**

```
FAIL  test/pi-settings-store.test.ts > busy-waits and acquires ...
Error: child exited (code 1) before holding lock
child stderr (last 10 lines):
  Error: Cannot find module 'proper-lockfile'
  ...
👉 单跑复现：cd packages/runtime && npx vitest run test/pi-settings-store.test.ts
```

错误自带临终输出与单跑命令——「错误 → 权威源 → 重试」闭环，不再需要 40 次盲跑碰运气。

**场景四：新增 real-pi 文件忘登记分池清单（失败路径 + 恢复指引）**

```
FAIL  src/__tests__/equivalence/session-manager-e2e-fixture-unit.test.ts > REAL_PI_TESTS 与 spawnPiFixture 消费方全量同步
Error: 以下文件 import spawnPiFixture 但未登记 REAL_PI_TESTS：
  src/__tests__/equivalence/my-new-case.test.ts
👉 把该路径加入 packages/runtime/vitest.config.ts 的 REAL_PI_TESTS（漏加会落回 main 满并行组，复发饿死超时）
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|----------------|--------------|------|------|
| **A：护栏下沉 fixture**（turn 抽象 + 游标 + recover + 锁子进程可观测（D6）+ 清单守卫全量化（D5）） | 高：正确性由基建 by-construction 保证，新文件自动继承；11 文件收敛到同一范式 | 中：集中改 1 个基建文件 + 11 文件接线（多为删 baseline / 换 runTurn） | abort 中断在途 turn 的行为未实测（探针 P-abort 兜底，含降级路径） | ✅ 推荐 |
| B：每用例独立 spawn（消灭共享） | 中：传染链 by-construction 消失，但 waitForEvent 假命中仍在（独立 spawn 内多 turn 仍有历史事件），锁子进程不可观测也没解决——三个缺陷只治一个 | 高：11 文件全部改形态；每文件多轮冷启动 + 真实 LLM 轮次，套件时长显著膨胀（real-pi 组串行，时长直接叠加在门禁关键路径上） | 门禁时长不可控；缺陷 2/3 原样保留 | ❌ |
| C：纪律层修补（各文件补手工 baseline + afterEach abort，不动 fixture） | 低：正是缺陷 2 的根因形态——正确性靠每个作者自觉，下一个新文件照样踩坑 | 低：只改 3 个共享文件 | 必然复发（隐性规则不可枚举）；无机制防漏登记 | ❌ |
| D：真实 LLM 解耦（record-replay / fake 流式端点） | 最高：连根拔掉延迟波动源 | 大：重构 fixture 数据源与全部断言方式 | 重放数据与真实协议漂移的维护成本 | 登记为后续方向，不进本 PR |

**推荐理由**：A 是唯一「一处改动、全部受益、机制防复发」的方案。B 若采用，§2 缺陷 2 的例子会变成：tool-call-index 三连发在独立 spawn 内照样裸匹配旧 `agent_end`（历史事件来自同一进程的前两发），红照出；C 若采用，§2 的两种写法并存会继续分叉，第 12 个 real-pi 文件仍需作者恰好知道隐性规则。D 是对的长期方向（消除波动源本身），但它不替代护栏——即便 record-replay 落地，共享子进程的 turn 语义仍在，护栏仍需要；且重构量远超本次收尾窗口，单独立项。

### 3.3 关键决策与权衡

**D1：busy 状态用事件流游标推导，不用 get_state 轮询（选定）**
- **采用**：fixture 内部维护 turn 状态——`sendCommand('prompt')` 的 ack 响应到达时记录 `turnStart = events.length` 并置 busy；当 `agent_end` 出现在下标 ≥ turnStart 处时清 busy。护栏 = `runTurn`/`sendCommand('prompt')` 入口等待 `!busy`。
- **被否**：轮询 `get_state` 的 `isStreaming` 字段（pi 0.84.1 dist 已核实该字段存在，rpc-mode.js:348）。ack 响应与 isStreaming 翻真正的先后关系是未实测的时序断言（ack 先于 streaming 开始的话，护栏会漏过刚 ack 的 turn），且每个 prompt 前多一轮 RPC 往返。
- **证据**：fixture 本就全量收事件（pi-fixture.ts:357 `events.push(event)`），busy 判定零额外 IPC；prompt 的 ack 语义有实装注释佐证（rpc-mode.js:298-310）。
- **效果**：G1 成立——用例 B 的 prompt 在 A 的 turn 未终结前不会打进子进程。
- **护栏覆盖范围（免护区显式声明）**：护栏只管 `prompt` 入口。以下通路**不经** busy 判定，各有使用纪律：① `writeLine` 直写原始 JSONL（既有消费者 session-manager-full-e2e.test.ts:144 用于 extension_ui_response 回包）——协议控制面操作，纪律为「只写非 prompt 命令」；② `steer`/`follow_up` 流中控件——语义本身就是「busy 时注入排队」（agent-session.js:833 拒绝文案的指定出路），既有用例 broadcast-getstate.test.ts:149（turn 进行中 follow_up 入队）、pi-protocol-contract.test.ts:291（steer）依赖此能力，护栏若拦它们等于破坏协议语义；③ 带 `streamingBehavior` 参数的 prompt 转发（completion-backflow-e2e.test.ts:116-119）同属流中投递，按 ② 同纪律。busy 的清态口径须覆盖「followUp 接续多轮」：一轮 agent_end 到达后若队列非空 pi 会继续下一轮（broadcast-getstate.test.ts:146 注释口径），此期间 busy 保持 true 直至队列 drain 后的最终 agent_end——探针 P-busy-composite。

**D2：护栏超时先 abort 再重试一次，recover() 兜底断传染链（选定，含探针）**
- **采用**：`runTurn`/`sendCommand('prompt')` 等 busy 超预算（默认与 commandTimeoutMs 同量级）→ 发 `abort` 命令 → 等 `agent_end` drain → 重试一次；仍 busy 则抛带 stderr tail 与恢复指引的错误。另暴露 `recover()`（abort + drain 幂等封装），3 个共享 fixture 文件在 afterEach 调用。
- **被否**：失败后直接 dispose+respawn 新子进程——每次慢 LLM 都付出冷启动 + 重跑前置 turn 的代价，且让「传染」变成「重建」掩盖真实失败信号。
- **证据**：pi 0.84.1 RPC 实装 `abort` 命令（rpc-mode.js:329-332 `session.abort()`）；`Agent is already processing` 拒绝文案（agent-session.js:833）证明裸发 prompt 必死，护栏是必经之路。
- **效果**：G1/G2 成立——传染链在 fixture 层被截断，门禁红归因到真实失败用例。
- **运行时断言（两条，均⛔ 探针 P-abort）**：① `session.abort()` 中断在途 LLM turn 后，`agent_end` 事件必到达事件流；② abort 后子进程处于干净态，新 prompt 能完整跑完一轮（message_start/end 配齐、事件形态与首轮基线一致）——② 缺失会让重试 turn 以静默劣化成功，恰恰造出 G2 要消除的新假红。**降级路径（条件化）**：①不成立或②不成立 → recover/重试固定降级为 dispose+respawn，护栏等待逻辑不变。

**D3：waitForEvent 不改默认语义，新增 `since` 游标参数 + `markEvents()`（选定）**
- **采用**：`waitForEvent(predicate, { timeoutMs, since })`——`since` 为事件数组下标，只匹配下标之后的事件；`markEvents()` 返回当前下标供调用方在触发动作前打点。既有全量匹配语义保留（`since` 缺省 = 0）。第二参数由数字改为对象形态是签名 break：全部 24 处既有调用点随 U3 一并迁移（TS 编译期直接抓出漏改点，无静默回归通道）。
- **被否**：把默认语义翻转为「只匹配调用后新到的事件」——快 turn 会在 `sendCommand` resolve 与 `waitForEvent` 调用之间的毫秒级窗口内完成，`agent_end` 先于调用到达 → 默认语义下永久等不到，挂死超时。该竞态是 by-construction 存在的，不能靠语义翻转解决。
- **证据**：turn 等待（假命中的支配性来源）已由 D4 的 `runTurn` 收编；其余 `waitForEvent` 调用（等 extension_ui_request 等）多为上下文唯一事件，全量匹配本就安全，`since` 作为显式加固选项。
- **效果**：G1 成立且零回归风险；手工计数防御写法（agentEndsBefore 等，基于 collectEvents 计数器）在迁移 runTurn 后随调用点一并删除——对这三个文件是范式替换（runTurn/游标取代计数器），不是参数改造。

**D4：新增 `runTurn(prompt, timeoutMs)` 原语，原子化「打点→发 prompt→等本轮 agent_end」（选定）**
- **采用**：`runTurn` = `markEvents()` → `sendCommand('prompt')`（经 D1 护栏）→ `waitForEvent(agent_end, { since: 打点 } )`，三步在 fixture 内原子完成，消除「ack 与注册等待之间的完成竞态」。迁移范围限定为「空闲起步的 prompt + 等 agent_end」调用点；**流中语义调用点不迁移**——steer/follow_up 调用保持原命令形态（它们的语义前提就是 turn 进行中注入，见 D1 免护区），带 streamingBehavior 的 prompt 转发同。
- **被否**：只提供 `markEvents/since` 让各文件自己组合——三连发这类场景的「先等旧 end 再发新 prompt」仍要每个作者写对顺序，护栏感弱。
- **证据**：24 处 `waitForEvent` 调用中，等 `agent_end` 是支配性模式（缺陷 2 的两个实例都属此类）。
- **效果**：G1 成立；新文件的最短路径就是正确路径。

**D5：REAL_PI_TESTS 清单守卫——扩展现有守卫为全量 diff，不新建并行守卫（选定）**
- **采用**：扩展 `src/__tests__/equivalence/session-manager-e2e-fixture-unit.test.ts` 的既有「REAL_PI_TESTS 分池注册」用例（:12-16，现仅以 `toContain` 单点校验 session-manager-full-e2e 一个文件）：升级为「grep `src/` 与 `test/` 两目录下 import `spawnPiFixture` 的文件集合 vs REAL_PI_TESTS 数组」全量双向 diff（grep 覆盖两目录：main 组 include 含 `test/**`，未来若有消费方写到 test/ 下会落 main 满并行组且不能逃过守卫），不一致即 fail 并列出路径与修复指引。该文件跑在 main 池（自身不 spawn pi），本地/CI/pre-merge 三处自动生效。diff 提取不走脆弱 regex 解析配置结构：REAL_PI_TESTS 成员为纯字符串字面量，按 `'src/...test.ts'` 字面量集合提取即可，消费侧按 import 语句文本匹配。
- **被否**：新建 `test/real-pi-pool-sync.test.ts` 独立守卫——与既有单点校验形成两套并行守卫，口径随时间漂移；pre-commit 脚本——不经过 pre-commit 的路径（CI、直接 npx vitest）漏守。
- **证据**：既有守卫已用「readFileSync vitest.config.ts 静态文本」手法且注释自述理由（「解析静态文本即可，配置 import 会拉起 globalSetup，超出 unit 校验边界」），扩展它手法同源、零新断言源；vitest.config.ts 头注释的维护契约（「漏加会落回 main 满并行组，复发饿死超时」）目前只有这 1/11 覆盖度的单点校验兜底，其余 10 个文件漏加无机制拦截。
- **效果**：G4 成立且不引入并行守卫。

**D6：锁子进程照抄 stderrTail 模式补齐可观测性（选定）**
- **采用**：pi-settings-store.test.ts 的锁子进程挂 stdout/stderr data 监听入 ring buffer，所有 throw 处拼输出 tail + 单跑恢复指引。
- **被否**：把 ring buffer 抽成共享工具模块——两处使用不构成抽象，且跨目录（test/ vs src/__tests__/）引测试工具模块增加耦合；照抄 30 行模式更便宜（减法优先）。
- **证据**：pi-fixture.ts 的 stderrTail 模式（50 行 buffer + 错误拼 tail）已在冷启动探针错误等路径实战验证其价值。
- **效果**：G3 成立。

### 3.4 探针清单（运行时断言审计）

| ID | 验证的行为断言 | 探针方法 | 状态 | 失败时的降级路径 |
|----|----------------|----------|------|------------------|
| P-abort | ① abort 中断在途 LLM turn 后 `agent_end` 必达；② abort 后子进程干净、新 prompt 能完整跑完一轮（message_start/end 配齐、事件形态与首轮基线一致） | 实施期起 fixture 发 prompt 后立即 abort 断言 agent_end 出现；再发 prompt 跑完整轮断言事件序列形态 | ⛔ U2 实施期门 | ①或②不成立 → recover/重试固定降级 dispose+respawn；护栏等待逻辑不变 |
| P-busy-composite | followUp 接续多轮期间 busy 保持 true，直至队列 drain 后的最终 agent_end（一轮 agent_end 到达时队列非空 → pi 继续下一轮，busy 不得提前清态） | 实施期构造「turn 进行中 follow_up」场景（broadcast-getstate :149 同款），断言首个 agent_end 后 busy 仍为 true、最终 agent_end 后清态 | ⛔ U2 实施期门 | 不成立 → busy 清态口径改为「get_state 轮询 pendingMessageCount===0 且 !isStreaming」（D1 被否案转为降级案） |
| P-ack-order | prompt 的 ack 响应先于该轮 agent_end 到达（ack 语义） | 实装注释核实（rpc-mode.js:298-310 preflight 成功即 output success） | ✅ 已核实 | — |
| P-busy-reject | busy 时裸发 prompt 被拒绝 `Agent is already processing` | 实装核实（agent-session.js:833）+ 2026-08-27 pre-merge 实际失败输出 | ✅ 已核实 | — |
| P-guard-noop | 非 busy 时护栏零开销（不引入等待） | by construction：busy=false 时直接放行，无 sleep 无轮询 | ✅ 构造保证 | — |
| P-respawn | recover 降级路径（dispose+respawn）在共享 fixture 文件可行（fx 变量可重赋值） | U3 接线时检查 3 个共享文件的 fixture 持有方式 | ⛔ U3 实施期门 | 不可重赋值则 recover 失败时显式 fail 后续用例并带恢复指引 |
| P-realpi-green | 改后 pre-merge 三连跑 real-pi 组全绿且无私下 skip | 验收期实跑（§4 场景 2） | ⛔ 验收期门 | 红 → 按新错误消息（含 stderr tail）修因后重跑 |

## §4 验收（真实场景，非单测非 mock）

**结论：五个真实场景覆盖 G1-G4 全部目标（含护栏不误伤的反向验证），全部用真实 pi 子进程 + 真实 LLM + 真实门禁脚本，无 mock。**

改动规模：中等（测试基建行为变更 + 11 文件接线）。

| 场景 | 回溯目标 | 步骤 | 通过标准 |
|------|----------|------|----------|
| 1. 慢 turn 不传染 | G1 | 在 broadcast-getstate.test.ts 把用例 A 的 `agent_end` 等待预算临时改为 5s（真实 mimo 单轮必超 5s，可控复现「慢 LLM」），单跑该文件（`cd packages/runtime && npx vitest run src/__tests__/equivalence/broadcast-getstate.test.ts`）；跑完还原预算再跑一次 | 注入时：用例 A 超时失败，用例 B 的错误**不含** `Agent is already processing`（B 被护栏保护正常运行或以其自身逻辑成败）；还原后：文件全绿 |
| 2. 门禁三连稳定 | G2 | 前置：`.review/coverage.json` 在位且 base 与当前一致（pr-pre-merge.sh:24 强制，缺失 exit 2；由 PR 流程 coverage-gate 产出）。开发机正常负载下完整跑 `bash scripts/pr-pre-merge.sh --test-result PASS --quiet` 连续 3 轮（test:runtime 双池全量含 real-pi） | 3 轮 marker（`.review/premerge-result` 文件中的 `result="PASS"` 行，pr-status.sh 可读）均为 PASS；输出中无 real-pi 文件红、无 real-pi skip 字样（skip 即验收不完整，pr-cr-fix 既有契约） |
| 3. 锁子进程故障可观测 | G3 | 临时在 pi-settings-store.test.ts 的 `node -e` 脚本体内注入 `throw new Error('boom-probe')`，单跑该文件；跑完还原 | 注入时失败错误消息包含 `boom-probe` 与 stderr tail + 单跑恢复指引；还原后全绿 |
| 4. 护栏不误伤快路径（负面行为反向验证） | G1 | 不做任何注入，单跑 tool-call-index.test.ts（三连发是护栏触发频率最高的文件，其时长权威口径是 beforeAll hook timeout 420_000ms——:122，注释口径「冷启动+轮次等待+余量」，非 <120s），记录耗时 | 文件全绿；全程无 RPC timeout、无 `Agent is already processing` 错误；耗时 ≤ 改造前同环境基线 +5%（受控对照，不设凭空绝对值上限） |
| 5. 清单漏加即红 | G4 | 临时新建 `src/__tests__/equivalence/__probe__.test.ts`（内容仅 import spawnPiFixture + 一个平凡用例），不登记 REAL_PI_TESTS，跑扩展后的守卫用例（session-manager-e2e-fixture-unit.test.ts）；跑完删除探针文件 | 守卫用例红且错误消息列出 `__probe__.test.ts` 路径与修复指引；删除后全绿 |

依赖说明：场景 1/2/4 依赖真实 mimo 凭证在位（开发机既有，`REAL_PI_READY` 探测链不变）；场景 3/5 不依赖 LLM，CI 亦可跑。

## §5 下一层拆分

实施路径按「先可观测、再修因、后防漏」排序，每个单元独立可验收、独立 commit：

| 单元 | 内容 | 文件改动 | 独立验收 | 为什么这么拆 |
|------|------|----------|----------|--------------|
| U1 | 缺陷 3 修复：锁子进程可观测化（D6） | `packages/runtime/test/pi-settings-store.test.ts` | §4 场景 3 | 最小且独立；先让唯一无法定因的失败模式可观测，后续单元若引发新红也有证据链 |
| U2 | fixture turn 抽象（D1/D2/D3/D4）：busy 状态机、markEvents/since、runTurn、recover、护栏错误文案 | `packages/runtime/src/__tests__/equivalence/pi-fixture.ts` | 探针 P-abort 实跑 + pi-fixture 既有单测全绿 | 全部机制集中一处，接线前先锁定基建 API 与探针 |
| U3 | 11 个消费文件接线：3 个共享文件 afterEach 加 recover；「空闲起步 prompt + 等 agent_end」调用点迁移 runTurn；手工计数防御写法随迁移删除。**语义敏感调用点不迁移**：steer/follow_up（broadcast-getstate:149、pi-protocol-contract:291）与 streamingBehavior prompt 转发（completion-backflow-e2e:116-119）保持原命令形态（语义前提是 turn 进行中注入，见 D1 免护区） | `src/__tests__/equivalence/` 下 11 个测试文件（不含 pi-fixture.ts） | §4 场景 1/4 + 探针 P-respawn | 机械性迁移与基建解耦，便于分派与 review；除迁移点外不改任何断言语义 |
| U4 | REAL_PI_TESTS 守卫全量化（D5）：扩展现有单点校验为双向全量 diff | 改写 `src/__tests__/equivalence/session-manager-e2e-fixture-unit.test.ts` 的既有注册校验用例 | §4 场景 5 | 不新建并行守卫，单文件改动与前序单元零耦合 |
| 终验 | 门禁三连 | 无改动 | §4 场景 2 | 整体目标 G2 的最终裁决 |

**待验证检查点**（设计期无法确定，实施期必须验证，诚实标注）：
- P-abort（U2 门）：abort 后 agent_end 必达 + abort 后子进程干净可续用——任一不成立走条件化降级（dispose+respawn），§3.3 D2 已写明；
- P-busy-composite（U2 门）：followUp 接续多轮期间 busy 清态口径——不成立则降级为 get_state 轮询方案（§3.4 探针表已写明）；
- P-respawn（U3 门）：3 个共享文件 fixture 变量可重赋值——不成立则 recover 失败路径改为显式 fail；
- runTurn 的默认预算取值：沿用各调用点既有 timeout（迁移时逐点保留原值），不设全局新默认值。

**登记待办（不进本 PR）**：真实 LLM 解耦（record-replay / fake 流式端点，方向性最优，需独立设计）；门禁前置环境探针（负载阈值 + provider 可达性 fail-fast）。
