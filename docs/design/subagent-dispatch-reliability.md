# subagent 派发可靠性：模型全等裁决 + 通知账本架构 + 终态一等披露

> **一句话结论**：subagent 后台派发的三个缺陷（模型串解析漂移致 429 空转、完成通知 at-most-once 丢失、终态显示 gc 无法判读成败）同根同源——「派发契约的两个承诺（start 时承诺可执行的模型、完成后必达通知）都没有受理确认与降级兜底」。本设计不给三处打补丁，而是从终态倒推三项结构改造：模型身份只接受 registry 全等精确匹配并在工具调用同步期完成裁决（模糊匹配只用于报错中的纠错建议，绝不参与采纳）、通知升级为「持久账本 + turn 边界投递」的确认式同步、outcome 提升为一等字段并收敛三处发散派生。全部改动落在 `@zhushanwen/pi-subagent-workflow` 扩展与 `@xyz-agent/session-delivery` 包内，不改 pi 上游。

- **层声明**：技术方案层 → 下一层产物为具体代码任务与测试用例。涉及运行时行为 / 数据流 / 错误处理，层敏感准则全适用。
- **切片归属**：本文是《pi 边界可靠性：语义吸收层终态架构与同类事故防御体系》（[pi-boundary-reliability.md](pi-boundary-reliability.md)）的**第一切片（subagent 派发域）技术方案**。同类问题判据、四支柱终态架构、漂移守卫与护栏体系见总设计；本文只含 subagent 域的三项结构改造（D1-D6）与其验收拆分，可独立实施。
- **证据基线**：本文所有现状事实取自 2026-08-27 实际 session 数据与 pi 实装版源码直读，采集环境 `~/.xyz-agent/pi/sessions/2026-08-27T10-58-34-533Z_01a042df-21a5-783d-890d-61e075514b9d.jsonl`（下称「基线 session」），pi 版本 0.84.1（桌面端 TaiJi.app 与项目 node_modules 一致）。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent GUI 会话中，主 agent 通过 `subagent` 工具以 background 模式派发子 agent 跑真实任务（编码 / 测试 / 审查），完成后经自动注入消息收回结果——这是 subagent-workflow 扩展的核心工作流。
- **C（冲突）**：2026-08-27 的真实使用中，一批派发里正确写法的模型串全部成功跑完（130 万 token 级），小写模型串的派发要么被当场拒单、要么静默换成订阅无权限的 `glm-5.3-highspeed` 后 API 429 空转退出；即便成功跑完的子 agent，主会话也只在偶然的空闲窗口收到过一次完成通知（十余次完成仅 1 次送达）；而所有终态在列表里一律显示 `closedReason: "gc"`，成功与失败无法区分。
- **Q（问题）**：为什么「传对模型就成功、完成后必然通知」这两个派发前提会双双失效？如何让后台派发成为可信赖的默认路径而非碰运气？
- **A（答案）**：三项结构改造——模型裁决在扩展域内收拢为单一入口并只接受 registry 全等匹配（模糊匹配仅用于报错纠错建议，绕开 pi pattern 引擎）、通知从一次性发送升级为账本确认式同步、outcome 从散落派生收敛为一等字段。

### 系统是什么

`subagent-workflow` 是运行在 pi coding-agent 内的扩展（npm 包 `@zhushanwen/pi-subagent-workflow`），向主 agent 提供 `subagent` 工具（action: start/message/list/cancel 等）。`start` 派发后台子进程（spawn `pi --mode rpc <flags>` 子进程跑独立 session），完成后由扩展内 notifier 组装通知文本，经 `@xyz-agent/session-delivery` 投递内核送回主会话。GUI（xyz-agent 桌面端）通过 RPC 通道读取子 agent 列表渲染面板，同时主 agent 通过工具返回 JSON 感知子 agent 状态。

### 设计目标（从使用者体验倒推）

- **G1 派发即确定（输入零宽容）**：模型入参只有两种合法结局——与 registry 条目全等（含大小写，下同）→ 执行；否则 → 工具调用同步期当场报错并附纠错候选。不存在任何「宽容采纳/降级改写」路径，「通过校验」与「将按此名字执行」之间零距离；缺省继承主 agent 模型是唯一豁免（见 D2）。
- **G2 通知必达（at-least-once + 幂等可识别）**：每个后台子 agent 终态后，主 agent 在当前 run 结束或有限延迟内收到完成通知；送达保证为 at-least-once——每条通知携带唯一 notifyId，已销账号绝不重发，构造性竞态（送达已落盘、销账未落盘的强杀窗口）允许重复但重复条目凭 notifyId 可识别为同一条；跨重启不丢（唯一排除面：pi flush 窗口——账本 entry 已入内存但尚未落盘时强杀，账目与通知真丢失，见 pi-semantics PS-17，与 PS-14 首写延迟同族）。
- **G3 终态一眼可判**：主 agent 与用户看到的子 agent 结局是「completed / failed / cancelled」级别的语义判断，不是需要展开 error 字段推理的内部占位符。

### Scope

- **In-scope**：`extensions/universal/subagent-workflow/src/`（模型解析、spawn 参数构建、notifier、record 投影）；`packages/session-delivery/`（投递内核接口适配）。
- **Out-of-scope**：pi 上游 `@earendil-works/pi-*`（[MANDATORY] 不修改、不提 PR、不 fork；pi 内的已知缺陷以「不给它含糊输入」方式绕开）；xyz-agent renderer 侧 UI 徽标改造（本设计只保证新增字段向后兼容输出，renderer 消费列为独立后续任务）；chatMode 对话式子 agent 的轮次通知语义（本轮不动其协议形状，见 D5 影响面说明）。

---

## §2 现状与问题分析

> 本章结论：三个表面症状（报 gc / 跑失败 / 无通知）对应三个结构性根因——模型标识无单一权威形态（F1）、通知投递无受理确认（F2）、终态语义写入即坍缩（F3）；三者同源于「契约发出时没有兑现的可验证路径」。

### 2.1 使用者视角的现状（真实例子）

基线 session 中主 agent 一天内 13 次 `subagent start` 派发，出现三种结局：

| 派发入参 model | 结局 | 主 agent 看到 |
|---|---|---|
| `zai-coding-cn/GLM-5.3-Flash`（registry 全等写法）×7 | 全部成功，最长 698k tokens | `closedReason:"gc"` |
| `zai-coding-cn/glm-5.3-flash`（全小写）×2 | start 当场拒单 | 错误文案 `Model "..." (paramOverride) not found in registry` |
| `zai-coding-cn/glm-5.3` ×4（其中 2 次在远端目录刷新前） | 刷新前 2 次成功；刷新后 2 次子进程空转退出（duration 5~15s，totalTokens=0） | list 显示 `model:"zai-coding-cn/glm-5.3-highspeed"`、`totalTokens:0`、`closedReason:"gc"` |

失败子进程的 session 文件（如 `2026-08-27T12-25-15-207Z_*.jsonl`）第 2 行 `model_change → glm-5.3-highspeed`，随后连续两条 assistant 消息 `stopReason:"error"`、`errorMessage:"429: {\"code\":\"1311\",\"message\":\"当前订阅套餐暂未开放GLM-5.3-Highspeed权限\"}"` 后进程终止。主 agent 收到的只是「closed(gc)」，不展开读子 session 文件就无法知道发生了什么。

### 2.2 物理数据流图（两条链路）

```
【派发链路】模型字符串的三层 Journey（★=失真点）

 主agent(LLM)──"zai-coding-cn/glm-5.3"(自由字符串)──▶ 扩展层 model-resolver
   │  lookupModel: registry.find(provider, id)  ← registry = pi SDK 注入快照
   │    小写"glm-5.3-flash": find 不命中(精确匹配) ──▶ 当场拒单 ✗ F1a
   │    小写"glm-5.3": 远端目录含同名小写条目 → 命中 ✓（伪装成合法）
   ▼
 subprocess-runner.buildSpawnArgs() ──"--model zai-coding-cn/glm-5.3"──▶ spawn pi CLI
   │                                                              ★F1b
   │        pi 实装 resolveCliModel→tryMatchModel(pattern 引擎):
   │          精确匹配备选[GLM-5.3, glm-5.3]双命中→歧义作废
   │          contains 模糊命中[glm-5.3/-flash/-highspeed…]
   │          localeCompare 取最大 → "glm-5.3-highspeed"
   ▼
 子进程 zai API: model=glm-5.3-highspeed ──429 code 1311 无权限──▶ 空转退出 ✗

【通知链路】完成事件的 at-most-once Journey（★=丢失点）

 子进程 exit ──▶ extension runner 收尾 completeRecord(closed, reason)
   │                        ★F3: reason 无真实死因时兜底填 "gc"
   ▼
 notifier.notify(record) → delivery 内核（合批/settled 驱动/dedup）
   │
   ├─ 主session空闲: sendCustomMessage(triggerTurn:true)
   │    └─ _runAgentPrompt 起新 turn → custom_message 落盘 ✅ 可达(实测仅此一路成功)
   │                                                        ★F2 以下三条丢失路径全部内存态、无回执：
   ├─ 主session streaming: deliverAs:"steer" → agent.steer() 入内存 steeringQueue
   │    └─ 队列消费窗 = loop 运行中 turn 边界 + run 收尾 hasQueuedMessages
   │       自动 continue（agent-session.js:748-750/:781）——窗口仍非闭合,
   │       最终检查之后的落队消息滞留;不落盘不触发无告警 ✗ 静默丢失
   ├─ delivery busy parked: 退避达上限 settle rejected（delivery.ts:9）✗
   ├─ mergeHoldActive 期间合批窗口无限顺延,消息滞留队列 ✗
   └─ 重启: 以上内存态全部清零,无任何账本可重放 ✗
```

### 2.3 根因分析

三个失败模式各自的表现之下，是同一类结构缺失：**承诺发出时没有同时建立「兑现的可验证路径」**。

- **F1 模型标识没有单一权威形态**。同一个模型在不同层的名字不同（registry 快照大写 id、远端目录 store 小写 id、LLM 输出任意大小写）。扩展层的校验（精确 find）和 pi CLI 的解释（pattern 模糊匹配 + localeCompare 选择）是两套互不知晓的规则；扩展层「通过了」只代表字符串在某个瞬间的快照里有条目，不代表子进程会用这个模型。中途还有一个时间性陷阱：`models-store.json`（pi 周期拉取的远端目录缓存，本机 2026-08-27 当日的一次目录刷新，文件 mtime/checkedAt 可复核）引入小写全家桶后，昨日还能用的字符串今天会掉进完全不同的模型。
- **F2 通知建立在不可靠通道上且无回执**。唯一推送手段 `pi.sendMessage({deliverAs:"steer"})` 的落点是内存队列 `steeringQueue`，该队列的消费窗口极窄（仅 agent loop 运行中的 turn 边界，实装代码 `@earendil-works/pi-agent-core/dist/agent.js` 全文只有 2 个 drain 点）；投递内核有合并/重试机制，但重试的对象是「send 函数调用」而不是「消息进入主会话」这一事实——没有任何回执判定，发送成功 ≠ 存在。gui 侧探针 P-B0（§3.3 D5）证实 pi 的 idle 分支（triggerTurn 起 new turn）才是可达路径，可惜 notifier 未按主 agent 忙闲分流。
- **F3 终态语义在写入时就已坍缩**。`completeRecord`（execution-record.ts:701）把 done/failed/crashed 统一写成 `closed` + `closedReason:"gc"` 兜底占位（v4 B-1 决策），真实死因靠 `error` 字段存在与否间接表达；下游三处消费点（notifier.buildLlmContent、bg-notify-render.ts 渲染器、list 投影）各自用同构 switch 重新推导一次「到底是成了还是败了」（notifier.ts 注释自认「顺序与三处同构契约一致」）。每处推导都可能漂移，且对外 JSON 里用户可见的还是原始的 `"gc"`。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**——主 agent（GUI 会话中）：

```
主agent: [tool] subagent { action:"start", model:"zai-coding-cn/GLM-5.3-Flash",
                            task:"...", slug:"u2-fix" }
返回:     { status:"accepted", slug:"u2-fix", model:"zai-coding-cn/GLM-5.3-Flash",
            bgResponse:{ status:"running", notifyContract:"ledger+at-least-once" } }
          （model 字段为 registry 全等回显——通过校验 = 子进程必然按此模型执行）

... 子 agent 完成 ...

主agent 收到注入消息（最迟 = 主 agent 当前 run 自然结束后一个 settled 边沿 +10s;
若主 session 长期无 settled 事件则由 120s 超时看门狗兜底尝试）:
  Subagent "general-purpose" (sa-xxx) completed. Result: ...
  （GUI pane 同步显示 outcome=completed）
```

**失败路径 A——模型入参非全等，工具调用同步期拒单**（裁决在 start 返回前完成，不产生 spawn、不等异步通知；报错只给建议、绝不代改输入——恢复动作始终是「重发修正后的参数」）：

```
主agent: [tool] subagent { action:"start", model:"zai-coding-cn/glm-5.3-flash", ... }
返回:     { isError:true, message:
            'Model "zai-coding-cn/glm-5.3-flash" is not a registry entry.
             Registry match is case-sensitive. Did you mean one of these?
               zai-coding-cn/GLM-5.3-Flash   ← case variant of "glm-5.3-flash"
             Other models you may have meant (similar id/provider):
               zai-coding-cn/GLM-5.3         xiaomi-token-plan-cn/mimo-v2.5-pro ...
             Or omit `model` to inherit the main agent model.' }

主agent 重发修正后参数 → 进入成功路径
```

**失败路径 B——子 agent 本身跑失败**：

```
主agent 收到注入消息（同契约）:
  Subagent "general-purpose" (sa-xxx) failed: 429 code 1311 ...
  （list 返回 items[].outcome:"failed"，GUI pane 显示 failed 徽标；
    用户无需翻子 session 文件即可知情）
```

三条终态铁律：①模型裁决同步完成——start 工具调用返回时即有结论（accepted 或 isError），不存在「受理后才发现模型错」；②输入零宽容：除缺省继承外只有 registry 全等写法可放行，模糊/大小写匹配只出现在报错建议里，系统永不代改输入，恢复动作 = 主 agent 重发修正参数；③错误文案自带下一步动作（问句式候选 + 可直接复制的合法串）。

### 3.2 方案对比（终态重构 vs 最小补丁）

三个问题域独立对比。用户方向约束：以长期架构合理性为主要裁决维度，候选必须包含跳出既有框架的重构方案。

**域 A：模型解析**

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **A-strict 全等裁决单点收拢（选）**：新增 `assertCanonicalModelRef(string)` 唯一入口——strip thinking 后缀 → provider 解析 → registry **全等精确查找**（含大小写）：唯一命中 = 放行；否则工具调用同步期抛错。模糊匹配（case variant / 相似 id / 相似 provider）**只用于生成报错里的纠错候选**（「Did you mean…」问句 + 可复制合法串），永不参与采纳。spawn args 只接全等 `ModelRef{provider,id}`，原样字符串永远不再流入 `--model` | 「通过校验 = 必按此名执行」成为可证明的恒等式；非确定性（昨日成功今日 429）在类型与流程两个层面被消除；未来加 provider/别名引擎只改这一个函数；同时绕开 pi pattern 引擎的一切歧义面（不给它含糊输入，不需要改上游） | 新增一个纯函数模块 + resolver/spawn 两处接入 + 问句式报错文案改造，约两天量级，纯扩展内改动 | 行为变化：此前个别「碰巧能用」的非全等串改为当场拒单——但这正是要的效果（那些字符串今天就是 429 元凶）；需在工具 description 写明大小写敏感规则帮 LLM 一次学会 |
| A-lenient 大小写宽容采纳（已否） | 模糊命中即放行+留痕 | 最小 diff | 与零宽容原则冲突：registry 含同名不同条目或动态刷新时，「宽容命中」会随时间漂移——恰恰复刻 §2.3 F1 要根除的「昨天能用今天掉进别的模型」非确定性 |
| A-patch 仅扩展现有 find 容错 | 无结构变化，最小 diff | 只治今日病例：pattern 引擎的歧义选择面原样保留，下一个新类别输入（空格/通配符/provider 别名）重新踩坑。§2.2 的 F1b 星标原样存在 | 长期架构差——规则仍是两套 |
| A-enum 工具 schema 枚举锁死 | 架构上最干净（非法值根本进不来） | pi tool schema 为静态声明，模型清单动态变化（models-store 定期刷新）无法反映到静态 enum | 枚举过期会造成假阴性拒单，反而更难排查 |

**域 B：完成通知**

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **B-ledger 账本+投递分离（选）**：通知拆为两个正交关注点——**存在性**由持久账本保证（`pi.appendEntry("subagent-bg-notify-ledger", …)` 内存同步入账先于一切投递尝试，文件落盘随 pi flush 管线 debounce、非 fsync——flush 窗口内强杀的真丢失面见 pi-semantics PS-17）；**可达性**由 courier 统一在 settled 边沿直达（busy 期间只记账不投递，见 D5）；销账回执 = 主 session 文件出现 `notifyId` 匹配的 custom_message entry；重启恢复扫账本重放，notifyId 幂等去重防双发 | 「发消息」变成「数据同步」：投递通道可以随便换/坏，账本永远在，at-least-once + 幂等键（notifyId dedupe）数学上闭环。这正是 GUI pane 已经在用的 subagent-record entry 流的同款范式，架构归一 | 账本读写 + 回执扫描约三天量级（record-store 已有 readLastJsonlLine/sidecar 同构先例可复刻）；notify 消费方（buildLlmContent 文案）不变 | 双发防护依赖销账及时性——「送达已落盘、销账未落盘」的强杀窗口允许重复注入，幂等键保证 LLM 侧可识别（正文含同一 notifyId）；P-B 系探针任一失败的降级路径见 D5 |
| B-flowfix 仅把 intent 按 isIdle 分流（idle→triggerTurn/busy→steer 改 followUp） | 半天量级改动 | 本质仍 at-most-once：steer/followUp 都进内存队列，run 收尾窗口的丢失面和今天一模一样；重启照丢。§2.2 F2 三个丢点只堵住半个 | 补丁假象最危险的一种——测试时段可能全绿，生产长尾必复发 |
| B-poll 取消推送全面转拉取 | 架构最简（无状态） | LLM 不会自发轮询，缺触发器 = 通知能力事实上消失；还需要给主 agent prompt 反复灌输轮询纪律，不可靠 | 等于放弃 G2 |

**域 C：终态披露**

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **C-outcome 一等字段收敛派生（选）**：`ExecutionRecord` 新增 `outcome?: "completed"\|"failed"\|"cancelled"`，在 `completeRecord` 唯一写入点计算一次（cancelled 从 tryTransition 已知分支带出；failed = closed && error 非空（truthy，空串不算，与旧三处同构判定逐字对齐）；completed = closed && !error，patchFile/result 语义不变）；`project()`/list/bgResponse/bg-notify 文案/渲染器全部只读 `outcome`，三处同构 switch 收敛删除；`closedReason` 保留为内部诊断字段退出对外 JSON | 语义在诞生处定形，消费方零推导。未来任何新展示面（新版 GUI/webhook）自动获得正确语义；这是减法（删三份同构逻辑加一份权威计算），符合「遇子问题先问减法」 | 字段计算本身半天；收敛删码涉及注释与既有字节级锁定测试的同步更新（one-shot 文案 G4 有逐字节锚定测试，需同步改锚） | 改的是对外可见 JSON 形状——向后兼容边界（2026-08-28 实施核对修正）：`closedReason` 退出 list/bgResponse 对外 JSON；GUI 链路（subagent-record entry / bg-notify details）继续携带，未升级 GUI 经 shared 投影读旧字段无异常 |
| C-raw 直接修改 closedReason 枚举语义 | 无中间投影层、语义直白 | 需重定义枚举、迁移约 30 处消费点与历史数据，改动面大 | 推翻 v4 B-1 已登记决策，兼容性破坏最大、收益最小 |

推荐组合：**A-strict + B-ledger + C-outcome**。三者共同点是「单一权威 + 受理确认」：模型身份一个函数说了算，通知一份账本说了算，终态一个字段说了算。三者互相独立可分阶段交付（见 §5），也可以说 F1/F2/F3 是同一个缺失原则（契约必须有受理确认）在三个环节的实例化。

### 3.3 关键决策与权衡

**D1：模型裁决收拢为 `assertCanonicalModelRef` 单函数——全等放行 + 孪生守卫，模糊只做报错建议（选定）**
- **采用**：扩展域内所有「字符串 → 模型身份」的转换只允许经这一个入口，且**校验发生在 start 工具调用的同步期（spawn 之前、返回值之内）**。规则：① strip 合法 thinking 后缀；② provider 精确匹配；③ modelId 与 registry 条目**全等精确匹配（含大小写）**；④ **孪生守卫**——全等命中后对 registry 做 case-insensitive 复扫，若存在与本次入参 case-insensitive 相等但非全等的其他条目（大小写孪生，如 `GLM-5.3-Flash` 与 `glm-5.3-flash` 并存），**拒绝放行**并报「registry contains ambiguous case variants for X: [A, B]」+ 恢复指引（清理 models.json / models-store 中重复条目后重试）。⑤ 未命中（步骤③）= 同步抛错，错误信息用模糊匹配（case variant / 包含关系 / provider 相似度）生成「Did you mean」候选 + 合法串全集（截断至 MODEL_LIST_LIMIT=20 防超长错误信息；case variant 首位建议不受截断影响）+ 「省略 model 继承主 agent」指引。**系统绝不代改输入**：不自动纠正、不放行变体、不重试。孪生守卫同样作用于 ctxModel 继承路径（见 D2）；resume 路径的 record 回显串（系统自产已裁决形态）同属运行时已验证豁免（P-10 防漂移：registry 刷新后强制裁决会破坏续聊）。
- **被否**：A-lenient 大小写宽容采纳——采纳即改写，「通过」与「执行名字」之间出现翻译层，registry 动态刷新时宽容命中会随时间漂移，复刻 F1 的非确定性；❌ 现状双层规则（扩展精确 + pi pattern 模糊）——2026-08-27 已实证产生「昨天成功今天 429」的非确定性；❌ 只做全等校验不做孪生守卫——恒等式存在静默破产面（见证据），零宽容必须覆盖「registry 自身歧义」这一输入侧不可控维度。
- **证据**：✅ P-A0 探针（node 直译 pi `dist/core/model-resolver.js` tryMatchModel，输入现行 registry 快照复现 `glm-5.3 → glm-5.3-highspeed` 选择，输出与基线 session 子文件 model_change 逐字一致）；实装源码 `resolveCliModel` 第 291-463 行直读，其中 `findExactModelReferenceMatch` 的 id 匹配是 `toLowerCase()` 相等（:97），registry 存在大小写孪生时 canonical 串亦被判歧义作废、落入模糊分支 localeCompare 取最大——**即「扩展侧全等放行」并不能独立保证「子进程按此名执行」，恒等式成立需要孪生不存在这一前置条件，故守卫必须内建**（当前本机 store 实测无孪生，今日成立）；📋 ⛔ P-A2（实施期门）：孪生守卫行为验证——构造含孪生的 registry 快照实测拒单路径 + 无孪生快照实测放行路径。**失败语义**：探针发现「有孪生仍放行」= 守卫失效，阻断合入（守卫本身即终态，无降级形态——降级=恢复赌博）。
- **效果**：§1 G1 成立的直接载体且无未声明前置条件；§3.1 成功路径「model 全等回显」与失败路径 A 问句式报错的来源。

**D2：spawn 前置守卫——`--model` 只接已裁决的 ModelRef（选定）**
- **采用**：`buildSpawnArgs` 入参类型收窄为 `{modelRef: {provider,id}}`，拼接值为 `${provider}/${id}`；thinkingLevel 仅允许 `THINKING_ORDER` 白名单值拼 `:level` 后缀。类型层面使任何未经 D1 裁决的裸字符串无法到达 spawn。
- **被否**：在 pi CLI 参数上加引号/转义等待遇优化——pattern 引擎行为是 pi 私有语义且跨版本可变，给它任何非全等字符串都是赌行为。
- **证据**：`session-runner.ts:670` 现状 `if (params.model) args.push("--model", params.model)` 直传任意串；📋 ⛔ P-A1（实施期门）：ctxModel 继承路径在真实 spawn 中 model_change 与 ctxModel 全等的验证。**豁免口径（按审查修正）**：继承路径豁免的只是**扩展侧 registry 复查**——ctxModel 是运行时已验证的 ModelInfo 对象而非自由字符串，且「缺省继承」是输入缺省而非变体放行，不违反零宽容；但继承产出的 canonical 串与显式入参走**同一个 pi pattern 引擎**，孪生/刷新导致的往返漂移对两条路径同等适用，故 D1 的孪生守卫同样作用于继承路径，往返等值由 P-A1/P-A2 共同把关。
- **效果**：与 D1 合起来封死 F1a/F1b 两个失真点——同步期裁决管入口，类型收窄管出口。

**D3：不改 pi，以上游缺陷为设计常量（约束决策）**
- **采用**：pi pattern 歧义选错模型不上浮 warning、steeringQueue 无残留告警，均作为「上游已知行为」纳入边界条件，本设计的正确性不依赖其修复。
- **被否**：给 pi 提 PR / fork——项目 [MANDATORY] 纪律禁止。
- **证据**：workspace AGENTS.md 外部依赖条款；实装版 dist 与 clone 参照的双向核对流程已在本节探针中执行。
- **效果**：方案有效期与 pi 小版本升级解耦（输入全等化后 pattern 引擎再怎么变也不影响我们）。

**D4：通知的存在性与可达性分离——账本先行，投递尽力，回执销账（选定）**
- **采用**：四步生命周期——① `appendEntry("subagent-bg-notify-ledger", {notifyId, payload})` 落盘（存在性基准，先于一切投递尝试）；② courier 按 D5 在 settled 边沿/超时点投递；③ **销账持久化**：回执判定成功（主 session 出现 `notifyId` 匹配的 custom_message entry 事件）后，向主 session 追加 `appendEntry("subagent-bg-notify-ack", {notifyId})`——销账记录与账本同文件同通道，**未销账号 = 两列 entry 的差集**，重启恢复扫描差集重放，内存态不承担任何销账职责；④ 重放按 notifyId 幂等去重。**通道分工**：ledger/ack 用 plain appendEntry——实测不进 LLM 上下文（session-manager.js:165-186 `sessionEntryToContextMessages` 对 type=custom 返回空），无上下文污染；送达消息用 sendCustomMessage（custom_message 进上下文）。两通道不得混用。
- **被否**：销账仅存内存（Set/LRU）——重启即全量重放历史已送达通知，S4 不可满足；❌ 维持 delivery 内核单打独斗——它的 retry 重试的是函数调用不是事实，2026-08-27 基线 session 十余次完成仅 1 条落盘即为反证；❌ B-pull 纯拉取——无触发器则 G2 失效。
- **证据**：`pi.appendEntry` 可靠落盘先例充分（`reportSubagentRecord`、IDENTITY_CUSTOM_TYPE 同款机制，跨重启由 record-store 重建矩阵消费）——落盘语义为内存入账 + flush debounce（非 fsync，强杀窗口见 pi-semantics PS-17）；plain appendEntry 不进上下文为审查期实测（session-manager.js:165-186）；reconstructAll/orphanJudged/sidecar 防重三件套提供了账本恢复的同构参照实现。
- **效果**：G2 从「best effort 承诺」变为「可证明的最终一致」；重启示意架构直接消灭今天「重启丢通知」这一整类故障。
- **fork / branch / compaction 归属规则**：账本与 ack entry 随主 session 文件存在，扫描域 = **单 session 文件**（幂等键作用域随文件域天然隔离，分身与本体互不串扰）。fork 复制 session 文件时，分身会继承「创建后未销账」的 pending——分身重放补投是**可接受语义**（分身继承任务上下文，知悉子 agent 结局合理），notifyId 去重保证分身内部也至多一次送达（崩溃窗口例外见 G2）。compaction 对 entry 的保留行为实装未验证，登记为 ⛔ P-B4 探针：实测 compaction 后 ledger/ack entry 存活情况；若被清除，恢复扫描退化为「以 subagent-record entry 反查未闭环通知」（record-store 重建矩阵同构，终态已知）。

**D5：courier 单通道化——投递时机统一收敛到 settled 边沿直达，删除 steer 与 nextTurn 通道（选定；初稿「busy 走 nextTurn」选型经审查证伪后重定）**
- **采用**：投递尝试只发生在「主 session 确定空闲」的时刻——① `agent_settled` 边沿（实装 `_emitAgentSettled` 先复位 `_isAgentRunActive` 再发事件，agent-session.js:327-331，故边沿回调内 `ctx.isIdle()` 恒真）；② 完成后 120s 超时看门狗（主 session 长期无 settled 时兜底）；③ 实现补充（2026-08-28 实施核对）：notifier.notify() 即时 attemptDeliver 与 flushPendingNotifications 两个附加触发面（idle 即时尝试，发送前 isIdle 二次复查）——settled 仅随 run 结束发出，主 agent idle 且无 run 时永无边沿，保留旧内核 idle 即投语义使送达时机严格优于「最迟」上界，零宽容不破坏。发送前二次复查 `ctx.isIdle()`，若竞态窗口内新 run 已启动则放弃本次发送、消息挂回 pending 等下一边沿（零宽容同样适用于发送时机：不在 isStreaming 分支有任何依赖）。发送调用为 `sendCustomMessage({triggerTurn:true})`，实装走 `_runAgentPrompt` 起轮直达（agent-session.js:1089-1090，基线 session 11:26:44Z 唯一成功样本即此路径）；同一边沿的多条 pending 经合并语义（同款 join/batch details）合为一条注入。
- **被否**：❌ steer 通道（现状）——queued steering 消费窗极窄（pi-agent-core 全文 drain 仅 agent.js:243/321）且回执为零；❌ **nextTurn 队列（初稿 D5 busy 分支选型，审查证伪）**——实测 `_pendingNextTurnMessages` 全文仅 3 处（声明 :95、入队 :1078-1080、注入并清空 :880-883），注入点**只在 `session.prompt()` 内**：仅当用户主动提交新 prompt 时才消费，`_runAgentPrompt` 直达、post-run `continue()` 续跑均不经过它。G2 主场景（主 agent 长 streaming、用户不输入）下 nextTurn 消息无限期滞留内存；且 pending 未消费期间 settled 直达照常落盘 → 超时重放再入队 → 用户下一次 prompt 时多条重复通知一次性涌入。既非可靠也非防重，整个通道删除（减法）。
- **证据**：✅ P-B0（源码级已测：sendCustomMessage 四分支 :1068-1098、_emitAgentSettled 复位先行 :327-331、nextTurn 唯一 drain 点 :880-883，均 dist 直读）；⛔ P-B1（实施期门，含反向验证）：(a) 实测 triggerTurn 直达确实不消费 `_pendingNextTurnMessages`（锁死 nextTurn 不可依赖的结论，防未来误复活）；(b) 实测 settled 边沿发送 → custom_message 落盘 → 回执事件到达销账的全链路时序与内容完整；(c) 合并窗口下多条 pending 单条送达。**降级路径**：若 (b) 时序实测晚于 S3 阈值，维持「只记账，超时看门狗直达」的纯兜底形态——必达性由账本保证，实时性让位。
- **效果**：busy 场景从「大概率永失」（§2.2 F2）变为「最迟当前 run 结束后一个边沿内必达」；通道唯一化后可测、可观测、可证伪。
- **影响面声明**：chatMode 轮次通知（round 语义、dedupe key `${id}:${round}`）沿用同一 ledger/courier 管道，dedupe key 规则不变；one-shot 通知文案 G4 字节锁定测试需同步迁移锚点（U2 内机械变更，行为契约不变）。

**D6：outcome 一等字段在 completeRecord 唯一写入点定形（选定）**
- **采用**：见 §3.2 域 C 选定列。派生规则集中在 `execution-record.ts`，导出供 batch 测试与渲染测试共用；对外投影（project/list/bgResponse/buildLlmContent/bg-notify-render）切换为只读 outcome。
- **被否**：各消费点继续本地推导——三处同构 switch 已是维护事故温床（notifier 里 patchFile 判序 bug 曾因此产生，注释存档可查）；❌ C-raw 改 closedReason 语义：推翻 v4 B-1 且波及 30 余处消费点与历史数据兼容。
- **证据**：`completeRecord` execution-record.ts:701 唯一终态写入点直读；三处同构的出处注释（notifier.ts:109「顺序与三处同构契约一致」）；⚠ 待核（实施期）：worktree patchFile 判序逻辑迁入 outcome 计算时保持「failed 优先于 patchFile 提示」的既有修复语义（finalizer 同处注释）。**显式取舍**：parent-shutdown 合成关闭（subagent-service.ts:464-472 合成 result 恒写 `error: "closed due to ${reason}"`）在本映射下落 `outcome:"failed"`——语义为「父进程关闭时子 agent 未完成即失败」，此为选定行为而非疏漏，与 closedReason=gc 的对应关系随 U3 实现注释固化，防止实施者误当 bug 改为 cancelled 造成派生矛盾。
- **效果**：G3；同时是减法——净删除约两份同构 switch。

---

## §4 验收

以下场景在真实环境（xyz-agent GUI 会话 + 真实 LLM 后端 + 真实文件系统）执行，全部不含 mock。每个场景标注回溯目标。

**S1 派发确定性（回溯 G1）**
场景：延续 2026-08-27 的真实工作负载——在 GUI 让主 agent 用三种 model 入参派发后台子 agent：「非全等小写 `glm-5.3-flash`」「正确大写 `GLM-5.3-Flash`」「完全不传 model（继承）」，各跑一个轻量真实任务（如「阅读指定文件并摘要一句」）。
步骤：派发后立即检查 start 返回值 → 对放行的两项等待完成 → 读 list 输出与子 session 首行 model_change。
通过标准：小写入参 start 同步返回 isError，报错含「Did you mean: zai-coding-cn/GLM-5.3-Flash」问句候选且不产生任何子 session 文件、无 spawn；大写与继承两项全部跑完且 tokens>0；子进程 model_change 与入参全等（继承项 = 主 agent 当前模型）；成功项的 start 返回值中 model 字段为 registry 全等回显。

**S2 非法模型拒绝质量（回溯 G1，负面路径）**
步骤：分别传 `"zai-coding-cn/nonexistent-probe"`（无相似物）与 `"zai-coding-cn/glm-5.3-flash"`（存在 case variant）各派发一次。
通过标准：两次均为 start 工具调用同步期 isError（无异步 notify 报错路径）；前者列出 canonical 合法串全集（截断至 20，见 D1 规则⑤）+ 继承指引；后者的首个建议恰为 `zai-coding-cn/GLM-5.3-Flash` 且标注 case variant；系统全程零宽松放行（若本轮误放行任何非全等串即判不通过）。

**S3 通知必达压力（回溯 G2，含反向验证）**
场景：主 agent 连续做重活制造持续 streaming（模拟基线 session 的连轴转形态），期间先后派发 6 个 background 子 agent（错峰完成），另外 1 个派发后被 cancel。
步骤：逐一记录每个子 agent 的 endedAt 与对应 `subagent-bg-notify` entry 在主 session JSONL 的落盘时刻。
通过标准：无强杀干预下，6 个完成事件各有通知（每 notifyId 在 JSONL 中 grep 恰 1 条 custom_message——本场景不含崩溃窗口，重复注入即判不通过），送达时刻不早于 endedAt、不晚于「该 endedAt 之后主 agent 第一个 settled 边沿 +10s」；cancel 的那个产生的通知正文为 cancelled 语义且不携带 result 正文（反向验证「不该有就没有」）；delivery 销账后 ledger 中无残留未销账号。

**S4 重启恢复（回溯 G2，反向验证重放纪律）**
步骤：在 S3 进行到一半（≥3 条已完成、销账与未销账混合态）时强杀桌面应用重开，恢复同一主 session 继续观察。
通过标准：重启后未销账号被重放送达（≤1 分钟内出现在上下文），**已销账号零重发**（重启前后按 notifyId grep 计数比对）；已知构造性例外——强杀恰落在「送达已落盘、销账未落盘」窗口时允许该 notifyId 出现第 2 条，重复条目携带同一 notifyId 且正文可识别为同一条通知，除此之外零重复。

**S5 终态判读（回溯 G3）**
步骤：构造混合批次：2 个正常完成 + 1 个注定失败（仿 S1 但传入会被 provider 拒的任务参数，如人为配错的模型权限路径）+ S3 的 cancelled；让不了解本设计的同事只看 list 输出与通知消息回答「哪些成了、哪些败了、哪些被取消」。
通过标准：三分全部答对且用时逐条秒级（不看 error 字段原文、不打开子 session 文件）；items[].outcome 取值仅 completed/failed/cancelled/closed-legacy（历史记录兼容态），GUI 未升级版本读旧字段无异常。

**回归底线**：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连绿；受影响的字节级锁定测试（one-shot 通知文案 G4、derive-closed-display-parity）在新锚点上全绿。单测不构成 S1-S5 的替代，只是防回归护栏。

---

## §5 下一层拆分

交付顺序按「互不阻塞、风险递减」排布：U3（披露）与 U1（模型）先行——两者独立见效且回滚面小；U2（账本）最后合入，因为它是行为变更核心，依赖 U3 的 outcome 字段作为通知文案输入之一。

| 单元 | 内容 | 为什么这么拆 | 可独立验收 |
|---|---|---|---|
| **U1 ModelRef 全等裁决** | 新增 `shared/model-ref.ts`（assertCanonicalModelRef：全等校验 + 模糊建议生成 + 问句式报错构建）；`model-resolver.ts` paramOverride/agentConfig 两路径接入；`buildSpawnArgs` 签名收窄 + thinkingLevel 白名单；start 返回值 model 全等回显；工具 description 写明大小写敏感规则 | 模型域自成一个纯函数群，无 IO、无状态，单测友好，与通知/披露互不牵连；裁决函数放 shared 层供 resolver 与 runner 双侧复用 | S1/S2 |
| **U2 通知账本与 courier** | `packages/session-delivery` 增加回执回调口径（port.send 返回受理事实的扩展位，旧调用方兼容）；extension 侧新增 `execution/notify-ledger.ts`（appendEntry 写账 / ack 销账 entry / 两列差集扫描重放 / notifyId dedup / settled 边沿与超时看门狗两触发点 / session_start 恢复钩子，fork/compaction 归属规则按 D4 落地）；notifier 四步生命周期接线；chatMode round dedupe key 平移 | 通知是唯一触碰「消息何时能进上下文」这个 pi 内部行为的域，集中一处便于对照 P-B 系探针调参；账本不引入对 pi 新 API 的依赖（appendEntry/custom_message 事件均为现有能力） | S3/S4 |
| **U3 outcome 一等披露** | `execution-record.ts`：outcome 计算 + project() 输出；`notifier.ts`/`bg-notify-render.ts`/list 投影切读 outcome 并删除同构 switch；`deriveClosedDisplayParity` 测试改锚至单一实现；start/list bgResponse JSON 增 outcome 字段 | 纯投影层改造，是 U2 文案正确性的前置输入；单独合入即可显著改善判读体验 | S5 |
| **U4 观测补齐（轻量）** | delivery 的 warn 出口接 extensionLogger（落 `<dataDir>/logs/` 而非 console.warn）；ledger 投递计数分桶（settle rejected / 销账超时 / 重放次数）经 extensionLogger 落盘暴露 + `deliveryMetrics()` 诊断 API（2026-08-28 实施修正：session 级指标挂 per-record eventLog 语义错位，改 extensionLogger 通道） | 今天排查最大的痛是投递丢失无痕（warn 走 stderr tee 不到）；这条不修，未来任何投递回归依然是黑盒。三桶覆盖 §2.2 全部四条丢失路径（steer 滞留 / busy parked settle rejected / mergeHold 顺延 / 重启——watchdogReplays 桶吸收 steer 滞留与合批顺延两路，recoveryReplays 桶对应重启）。与前三者解耦、随时可插 | 日志样例人工核对 |

**文件改动地图**：

```
extensions/universal/subagent-workflow/src/
├─ shared/model-ref.ts                     [U1 新增]
├─ execution/model-resolver.ts             [U1 接入 canonicalize]
├─ execution/session-runner.ts             [U1 buildSpawnArgs 收窄]
├─ execution/subprocess-agent-runner.ts    [U1 RunContext.modelRef]
├─ execution/notify-ledger.ts              [U2 新增]
├─ execution/notifier.ts                   [U2 四步接线; U3 文案切 outcome]
├─ interface/bg-notify-render.ts           [U3 切 outcome 删同构 switch]
├─ execution/execution-record.ts           [U3 completeRecord/project + outcome]
└─ index.ts                                [U2 重启恢复钩子挂 session_start]

packages/session-delivery/src/
├─ types.ts                                 [U2 port.send 回执口径]
└─ delivery.ts                              [U2/U4 warn 出口参数化]
```

**待验证检查点（诚实标注）**：
- ⛔ P-A1 ctxModel 继承路径的 ModelRef 包装一致性（D2）；继承与显式入参同走 pi pattern 引擎，孪生守卫（P-A2）双路径生效。
- ⛔ P-A2 孪生守卫行为验证（D1）：含孪生 registry 快照实测拒单 + 无孪生快照实测放行；发现「有孪生仍放行」= 守卫失效，阻断合入。
- ⛔ P-B1 courier 全链路（D5，含反向验证）：(a) 实证 triggerTurn 直达不消费 `_pendingNextTurnMessages`（锁死 nextTurn 不可依赖）；(b) settled 发送 → custom_message 落盘 → 回执销账时序与内容完整性；(c) 合并窗口多条 pending 单条送达。降级＝只记账 + 超时看门狗直达。
- ⛔ P-B2 settled 边沿竞态窗口宽度（D5）：发送前 isIdle 复查命中 busy 的频率实测；命中即挂回 pending，无降级需求。
- ⛔ P-B3 重启重放幂等（S4 即为其验收形态；失败则强化 sidecar 锚，参照 .finalized 同构机制）。
- ⛔ P-B4 compaction 后 ledger/ack entry 存活情况（D4）；被清除则恢复扫描退化为 subagent-record 反查闭环（record-store 重建矩阵同构）。
- worktree patchFile 与 failed 判序语义的迁移保真（D6 待核项）。

---

## 附：与 v4 B-1 既有决策的关系

本设计不推翻 B-1「closed 统一终态」的存储层决策——record 内部表示不变，管控点上移到「对外披露层」（outcome 投影）与「可靠性层」（通知账本）。D6 是对 B-1 遗留投射债（三处同构 switch）的清算，D4/D5 是对 B-1 时代「通知 = 发送调用」假设的修正。
