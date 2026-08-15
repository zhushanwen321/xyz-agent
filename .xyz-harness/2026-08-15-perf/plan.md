# 全栈性能优化实施计划（wave 拆解 + 评估缺口前置裁决）

> **一句话结论**：11 份设计文档（00-overview + 01~10）的方案总体成立，按本计划拆为 **31 个 wave**（六阶段：阶段 0 五个 / 阶段 1 十个 / 阶段 2 四个 / 阶段 3 四个 / 阶段 4 五个 / 阶段 5 三个）；4 个评估 subagent 发现的 2 个 blocker + 18 个 major 缺口已全部在本计划 §2 做出定案裁决（R-01~R-24，每条均有结论），开发 subagent 拿到「设计文档 + 本计划」即可无歧义实施。

## §0 结论与使用说明

**文档分层**：

| 层 | 文档 | 职责 |
|---|---|---|
| 方案权威层 | `00-overview.md` + `01~10` 子文档 | **怎么做**——每个决策的技术方案、接口定义、多方案对比、被否方案。实施时遇到方案细节问题，以子文档 §3 为准 |
| 拆解裁决层 | 本计划 `plan.md` | **按什么顺序做、哪些地方不能照文档字面做**——wave 划分、依赖关系、评估缺口的前置裁决（§2）、每个 wave 的验收标准 |

使用方式：派发开发 subagent 时，任务书 = 本计划 §4 对应 wave 节 + 该 wave「对应设计文档章节」列指向的子文档段落。两者冲突时，**以本计划 §2 裁决为准**（裁决均已对照代码验证，裁决依据中标注了代码事实）。

**全局约束**（每个 wave 都必须遵守，任务书不再重复）：

1. 测试框架 vitest，命令必须带正确 cwd：runtime 改动 `cd packages/runtime && npx vitest run`；core 改动 `cd packages/core && npx vitest run`；renderer 改动 `cd packages/renderer && npx vitest run`；ui 改动 `cd packages/ui && npx vitest run`（无测试文件时跳过该包）
2. `packages/runtime/src/` 改动触发 pre-commit runtime bundle 验证（`bash scripts/validate-runtime-bundle.sh`），提交时让它跑完
3. renderer 编码规范：禁原生 HTML 表单元素/Emoji/硬编码颜色/魔数间距，Tailwind 三层样式，组件用 xyz-ui
4. 波内改动完成即 commit（conventional commits 英文）；不创建 `demos/` 目录；不修改 pi 源码
5. 全局验收场景（00-overview §4 V1-V8）在各阶段收尾时按需复验，wave 级验收以各 wave 任务书为准
6. 每个 wave 的「文件清单」是上限约定；实施中发现必须增删文件时，在 wave 汇报中说明原因

## §1 文档充分性评估摘要

4 个评估 subagent 对照代码库抽查 100+ 处引用后的判定（浓缩，详见各裁决条目）：

| 文档 | 覆盖决策 | 判定 | 一句话核心问题 |
|---|---|---|---|
| 01-plugin-hook-fix | D2 | 足够 | observe 组事件映射与注册 API 错配（hookType `'onMessage'` 无注册入口），result 回传腿未列清理清单 |
| 02-message-distribution | D1+D5 | 有缺口 | gap 判定基准、subagent publish 目标、组合根注入点、broadcast 全量清单等 6 处与代码现实有偏差 |
| 03-git-state-service | D3+D4 | 有缺口 | baseline 是死参数（对输出零影响），D3-2 的 promise 门防御不存在的问题；port 文件清单有漏 |
| 04-history-incremental | D6 | 偏严重 | renderer append 触发链路不存在（switch reply 被丢弃 + isHydrated 守卫 + LRU 驱逐三重短路）；空增量误走尾读 |
| 05-scan-caching | D7+D9 | 轻微缺口 | 「searchFiles 无剪枝」失实（matchPath 级剪枝已存在），D7-2 保守实现反而改变现状行为 |
| 06-startup-logging | D8+D10 | 足够 | forkSession 也 spawn pi 但 gate 清单只写 create/restore |
| 07-state-layer | D-1/D-2/D-3 | 有缺口 | D-1 读点适配面实测 7 文件 33 处（文档拆分地图只写 2 文件且声称 registry.ts 不改）；deep watcher 断言错误；DeltaBuffer contentIndex 已在文档「审查补充」中修复（评估引用的是旧版） |
| 08-render-layer | D-4/D-5 | 有缺口 | 增量协议是字符串语义但消费方吃 segments 数组；边界判定状态机规格未展开 |
| 09-panel-layer | D-6/D-7/D-9 | 有缺口 | D-7.2 的 13 个消费文件清单缺失；终端 buffer 组件归属与切 tab unmount 矛盾；D-9 触发源无独立事件可订阅 |
| 10-build-and-quickwins | D-8+Q1 | 有缺口 | Q1-7 指向零引用死代码（活跃副本在 packages/ui） |
| 00-overview | 总纲 | — | 微项表「handler 合并 scanSessions().find()」实为跨多方法签名改动，非顺手项 |

**总体结论**：方案选型（各文档 §3.2 的多方案对比与裁决）全部经受住评估，无需推翻任何决策；缺口集中在「文件清单不全 / 与代码现状有偏差 / 触发链路断裂」三类，全部通过 §2 裁决消化。

## §2 前置裁决

裁决编号 R-01~R-24。每条：问题 → 裁决 → 理由 → 影响的 wave。**裁决与设计文档冲突时以裁决为准**。标注 [代码验证] 的条目表示本计划撰写时已重新对照源码核实。

### 2.1 blocker 级（2 条）

**R-11（04-blocker）D6 renderer append 入口不建；改为 session.switch reply 瘦身，renderer 零改动**

- 问题：文档设想的 renderer append 入口（挂 useChat.ts hydrateHistory 分支）被三重事实短路：① `selectSession`（`packages/renderer/src/composables/features/sidebar/useSidebar.ts:162`）发 `session.switch` RPC，runtime handler（`packages/runtime/src/transport/session-message-handler.ts:217-250`）**无条件全量 getHistory 并把 messages 塞进 reply**，但 renderer 丢弃该 reply；② features 层仅 `!chat.isHydrated(id)` 时另发 `session.history` RPC；③ LRU 驱逐时 messages 分区被删 → 唯一「有基底」场景（LRU 窗口内切回）根本不发请求，append 无消费者；被驱逐切回（无基底）append 会丢历史头部。
- 裁决：**放弃 renderer append 链路**（04 文档重范围后的方案 A「runtime 侧重建缓存」是正确方向，本裁决与其一致）；同时把 switch handler reply 中的 `messages`/`historyTruncated` 字段**移除**（reply 只保留 session summary），renderer 侧 `switchSession` 调用点本就丢弃返回值（useSidebar.ts:162、useSidebarNew.ts:238，[代码验证]），零改动。protocol.ts 中 switch reply 复用的 `session.history` reply 类型需拆分（switch reply 用不含 messages 的新形状）。
- 理由：评估建议 A（renderer 消费 reply 做 append）只能省被驱逐切回时的一次 RPC 往返（毫秒级），代价是引入「switch reply 永远携带全量」的持续浪费 + renderer 新代码路径（hydrate 幂等守卫、historyTruncated 处理）；reply 瘦身直接消除「每次切 session 一次全量序列化 + WS 传输」（最高频场景：LRU 窗口内切回从全量传输降为零），且 renderer 零改动、无回归面。被驱逐切回的全量传输是「renderer 无基底」的必然成本，由 D6 的 runtime 缓存把重建侧变便宜即可。
- 影响 wave：W20。总纲 §3.3 裁决 3 中「D6 renderer append 入口」表述作废，D6 定位为纯 runtime 决策。

**R-15（07-blocker）D-1 容器范式必须 7 文件原子落地，否决文档 U1 的 2 文件拆分**

- 问题：`MessagesRef` 升级为 `Map<string, ShallowRef<Message[]>>` 后，所有 `messages.value.get(sid)` 当数组用的位置全部类型错误。实测非测试代码分布：`effects/registry.ts` **16 处**（[代码验证]：registry.ts 内 16 行 `messages.value.get`）、`streaming-state-machine.ts` 3 处（finalizeMessages 的 `prev.map` 会 TypeError）、`bash-effects.ts` 3 处、`changeset.ts` 1 处（applyFileChanges）、`effect-types.ts:28` 内联类型、`mutations.ts` 2 处、`store.ts` 5 处。文档 U4 声称「registry.ts 不改」是误导。
- 裁决：D-1 单个 wave 内原子落地 7 文件（mutations + effect-types + store + streaming-state-machine + bash-effects + changeset + effects/registry），禁止按文档 U1 拆成 2 文件先行。
- 理由：类型升级是全有或全无——中间态（部分文件适配）无法编译，也不存在可独立验证的半步。
- 影响 wave：W10（文件数 7，超出 ≤5 惯例，本条即超限理由）。

### 2.2 major 级（18 条）

**R-01（01-G1）observe 组 7 事件映射改挂 `onPiEvent` 泛型，不新增 onMessage 注册 API**

- 问题：`PI_HOOK_EVENT_MAP`（bridge-interop.ts:33-44）observe 组 7 事件映射 hookType `'onMessage'`，但 createHookApi 只暴露 5 个方法，无 onMessage 注册入口 → `HookPipeline.execute('onMessage')` 永远空跑。
- 裁决：observe 组 7 事件的映射 hookType 改为泛型 `onPiEvent`（与 D2-4「注册/调用 key 统一为泛型」同一收口），不新增 onMessage API。
- 理由：与文档自己的 D2-4 方向一致，避免为一个语义（纯观察）开两个注册入口。
- 影响 wave：W2。

**R-02（01-G2）删除 `plugin.hooks.invoke.result` 回传腿**

- 问题：hook-api.ts:144-162 的 result 回传腿（每次调 handler 后发失败 RPC + console.error）不在 U1/U3 清理清单；observe 改 notify 后它正是每个事件的触发点。
- 裁决：W1 中随「request 直连」一并删除该回传腿及其配套日志。
- 理由：request 直连后 Worker 响应走标准 JSON-RPC reply，回传腿是旧错配协议的残余，保留会产生每事件一次的失败 RPC。
- 影响 wave：W1。

**R-03（02-G1）gap 判定采纳文档 D5-3 现行版：删 bus 内死 gauge，gap 由 handler 基于 ring 最旧 seq 判定；state 类保留统一 seq 计数**

- 问题：评估指出「state 分配 seq 不入 ring」+「seqCounter > ring.length 判定」组合恒真。核查文档：02 文档 D5-3 现行版**已修正**（「初稿在此处写错，已修正」——定案删除 message-bus.ts:146 死 gauge，gap 只由 session-message-handler.ts 的 `fromSeq < ring 最旧 seq` 判定）。评估引用的是修正前口径。
- 裁决：按文档 D5-3 现行版执行：删除 bus 内 gauge；state 类继续用统一 seq 计数器（消息带 seq、推进订阅方 lastSeq，只是不入 ring）。正常重连（fromSeq ≥ ring 最旧）不误报；长断线 + ring 溢出时 gap=true 全量重拉是既有安全语义。不引入 stream 独立计数器（改动面大：协议/renderer/bus 全链，收益仅限低频断线重连场景）。
- 理由：[代码验证] handler 侧判定（session-message-handler.ts 的 fromSeq 比较）在 ring 只存 stream、seq 统一计数下语义自洽；统一 seq 保住「全序」这个简单不变量。
- 影响 wave：W6（验收含「state+stream 混合 session 订阅不误报 gap」探针，见 02 文档 D5-3 实施验证）。

**R-04（02-G2）subagent.stream_delta 的 publish 目标改为主 session；payload.sessionId 保持 subagent sid**

- 问题：R8 预案写「消息本身带 mainSessionId 字段」，但 `subagent.stream_delta` payload 仅 `{sessionId, recordId, lines}`（protocol.ts，[代码验证]），无 mainSessionId。
- 裁决：若 W9 的 R8 探针证实 renderer 未订阅 subagent 虚拟 session，则 publish 目标从 payload.sessionId 改为 event-interpreter 的 `this.sessionId`（主 session，[代码验证]：`ev.sessionId` 来自 extension setWidget 上报的 subagent sid，interpreter 的 `this.sessionId` 是其服务的主 session）；payload.sessionId 字段保持 `ev.sessionId` 不动（前端 subagent 面板路由依赖它）。改动落在 session-service send 回调或消息构造处。
- 理由：publish 目标（发给谁的订阅者）与 payload.sessionId（前端路由到哪个分区）是两个独立维度，只需改前者。
- 影响 wave：W9。

**R-05（02-G3）terminal.data 接 bus 必须改 DI 注入点：文件清单加 index.ts 与 TerminalServiceDeps**

- 问题：terminal-service 广播是 DI 注入（index.ts:427 `broadcast: (msg) => server.broadcast(msg)`），文档 U3 只列 terminal-service.ts。
- 裁决：W7 文件清单含 `services/terminal/terminal-service.ts`（TerminalServiceDeps 同文件定义，DI 注入即在此改）+ `runtime/src/index.ts`（组合根改注入 bus.publish 封装）。
- 理由：不经组合根改不动广播通道。
- 影响 wave：W7。

**R-06（02-G4）`plugin:viewUpdate` 广播点在 plugin-rpc-setup.ts:260，非 plugin-service.ts**

- 问题：文档 U3 文件清单写错位置。
- 裁决：W8 文件清单按实际位置（plugin-rpc-setup.ts）+ plugin-service.ts（uiRequest 广播点）双列，实施时以 grep `viewUpdate` 的实际广播点为准。
- 理由：[代码验证] 评估已定位实际行号。
- 影响 wave：W8。

**R-07（02-G5）topicOf 查表 miss 的 fallback 定为 stream**

- 问题：topic 表约 30 类型 vs ServerMessageType 70+，miss 时行为未定义。
- 裁决：未入表类型默认 stream（分配 seq + 入 ring）——与现状语义一致（现状所有 publish 都入 ring），最安全。
- 理由：fallback 到 transient 会静默丢消息（不可回放）；fallback 到 state 需要快照键。新增消息类型忘记入表时，stream 是唯一不产生行为回归的默认。
- 影响 wave：W6。

**R-08（02-G6）删双写前置：全量 broadcast 点排查（17 文件 108 处）**

- 问题：删双写需要完整 broadcast 点清单，文档未交付（实测全仓 17 文件 108 处 broadcast）。
- 裁决：W9 第一步是排查步骤：`grep -rn "\.broadcast(" packages/runtime/src --include="*.ts"` 逐处分类（session 级双写 / 纯全局 / D1-1 表内接 bus 点），产出分类清单（写入 wave 汇报），对照 02 文档 D1-2 的 DoR 审计表逐行勾稽后才删。任一 push 型 session 级消息不在表内 → 保留其 broadcast 并上报。
- 理由：删双写是单通道化的收益主体也是风险主体，前置排查是唯一护栏。
- 影响 wave：W9。

**R-09（03-G1）baseline 死参数简化：移除 D3-2「baseline promise 门」，保留 D3-3 帧序三件套**

- 问题：file-change-reconciler.ts:129-142 现状 baseline 非 null 分支同样返回 current 全集（[HISTORICAL] 注释「只要 current 存在就报告」），baseline 对输出零影响——D3-2 防御的问题不存在。
- 裁决：turn-start 的 baseline 采集（event-interpreter.ts:219-221）异步化且不 await；`diffSnapshots` 不依赖 baseline；删除 baseline 参数的死语义。D3-2 的「baseline promise 门」从实施中移除。**D3-3 帧序不变量（per-session 串行 diff 链 + turnGen 代际守卫 + turnFinalizing 压制）保留不动**——它防御的是 accumulating/ready 乱序（异步化的真实风险），与 baseline 无关。
- 理由：为不存在的问题引入 promise 门是复杂度浪费；帧序风险在异步化后真实存在，文档 D3-3 的三件套是 by-construction 保证。
- 影响 wave：W18。

**R-10（03-G2）U3 文件清单补 `services/ports/file-change-diff.ts` 与 adapter**

- 问题：`snapshotGitStatus` 是 port 上的同步签名，异步化必须连 port + adapter + 实现一起改，文档清单漏了 port 文件。
- 裁决：W18 文件清单 = `infra/pi/file-change-reconciler.ts` + `services/ports/file-change-diff.ts` + `infra/pi/file-change-diff-adapter.ts` + `services/session/event-interpreter.ts` + `runtime/src/index.ts`（组合根注入）+ 前端 `core/src/domain/chat/changeset.ts`（单向守卫，纵深防御）。
- 理由：port 签名不改则 services 层无法 await。
- 影响 wave：W18。

**R-12（04-G2）增量返回空 entries 时短路返回空列表**

- 问题：session-service.ts:495 `if (entries.length > 0)` 会把「无增量」当异常走尾读（:503-508），增量正常返回空时误降级。
- 裁决：增量分支 `entries.length === 0` 时直接返回缓存现状（短路），不进 fallback。
- 理由：空增量是常态（leafId 未前进），走尾读既是性能浪费也会破坏缓存一致性。
- 影响 wave：W20。

**R-13（05-G1）剪枝保持现状行为：matchPath 级剪枝不变，D7-2「安全条件剪枝」降级为不做**

- 问题：searchFiles 已有目录级剪枝（file-service.ts:207-210，[代码验证]：`matchPath` 命中即 `continue` 不下钻），文档 §2.3「无剪枝」失实；D7-2 的保守实现（含取反规则禁用剪枝）会改变现状行为，与 V6「取反规则行为与现状一致」自相矛盾。
- 裁决：保持 matchPath 级剪枝现状不动（接受 `build/` + `!build/keep.js` 场景下子孙文件丢失的既有语义）；D7-2 的「安全条件剪枝」**不做**；V6 验收措辞改为「取反规则行为与改造前一致」（以改造前实测为基线，而非理想语义）。W24 只做 matcher mtime 缓存 + 短路径直通。
- 理由：改变现状剪枝行为是一个语义变更（结果集差异），不属于性能优化范畴且有回归风险；现状剪枝已覆盖收益主体。
- 影响 wave：W24。

**R-14（06-G1）迁移 gate 覆盖 create/restore/fork 三处 spawn 点**

- 问题：forkSession 也 spawn pi（session-lifecycle.ts:512），文档 U3 gate 清单只写 create/restore。
- 裁决：`await migrationReady` 挂在 create/restore/fork 三个 spawn 前置点。
- 理由：三处都读 provider 配置，竞态窗口同构。
- 影响 wave：W29。

**R-16（07-G2）useFileChangeInvalidation 的 watch source 改读内层 ref 并去 deep；并入 W11（D-3 wave）**

- 问题：watch 是 `{deep:true}`（useFileChangeInvalidation.ts:70 附近），source 为整 messages Map；Vue deep traverse 会进 Map entry 读内层 ShallowRef 的 `.value` 建立依赖 → D-1 后其他 session 分区 ref 替换仍触发 watcher（失效不收敛）；去掉 deep 则同 sid 消息数组原地变更不触发（功能回归）。
- 裁决：watch source 改为 `() => chatStore.messages.get(sid)?.value`（per-sid 内层 ref），去掉 deep；依赖「消息数组不可变替换」语义（commitMessages 产出新数组，07 文档 D-1 的既有设计）保证同 sid 更新仍触发。此改动越出 07 文档「不改它们逻辑」的边界——**本裁决显式扩展边界**，与 useSearch（共用同一 helper 模式）同批迁移。不放到 D-9（W19）做，因为阶段 1 落地 D-1 后若不迁移，fileChanges/搜索失效在阶段 1-2 间处于「过度触发」状态且 D-9 改造又要动同一片代码。
- 理由：07 文档 §5.2 U7（审查新增）已认定这是 D-1 伴生必改；评估确认 deep watch 断言错误。**现状行为的不确定性声明**：D-1 落地后 deep watcher 的实际表现（「过度触发」还是「静默停更」）存在两种可能，取决于 Vue traverse 对 shallowRef 内层 raw 对象的处理——07 文档 §2.3.5 断言「deep 救不了，触发源被切断（停更）」，本条问题陈述则推断「traverse 进 Map entry 读内层 ref `.value`（仍触发）」；两者互斥且均未实证。**W11 实施第一步先跑 P5 探针实证再动手**；裁决方案（去 deep + watch 内层 ref）在两种情况下均正确，不受该不确定性影响。
- 影响 wave：W11（含 useSearch.ts）。W19（D-9）在此之上再改触发源（见 R-23），两次改造串行无冲突。

**R-17（07-G3）`mutations.test.ts` 核心断言重写（非适配）**

- 问题：`packages/core/src/domain/chat/__tests__/mutations.test.ts` 12 用例断言旧不变式「ref.value 引用必变」，与 D-1「同 sid Map 引用不变、内层 ref 替换」直接冲突，文档测试清单漏列。
- 裁决：W13 中该文件按新不变式**重写核心断言**（断言 Map 恒等 + 内层 `.value` 引用变化 + 消息数组内容），其余 5 个测试文件按文档 §5.3 策略适配。
- 理由：不变式反转时「适配」和「重写」的界限就在断言对象，旧断言全部失效。
- 影响 wave：W13。

**R-18（07-G4）DeltaBuffer contentIndex 保留：采纳 07 文档现行版（评估引用旧版）**

- 问题：评估称「文档 flush 构造 `{payload:{delta:joined}}` 丢 contentIndex」。核查文档：07 文档 §3.3 DeltaBuffer 已含「审查补充」定案（`contentIndex?: number` 字段 + flush 透传 + 07 文档 429 行完整理由段），评估引用的是修正前口径。
- 裁决：按文档现行版执行（保留首条 delta 的 contentIndex 并 flush 透传）。补充要求（消化评估 minor）：flush 合成对象须构造完整 ServerMessage 形状（至少透传首条消息的 `id`；seq 无需合成——transient 消息本就无 seq）。
- 理由：[代码验证] registry.ts text_delta handler 依赖 contentIndex 做 insertContentBlockByIndex 有序插入，保留是正确设计；文档已定案无需新裁决。
- 影响 wave：W12（验收含 contentIndex 透传单测）。

**R-19（08-G1）增量协议落成「前缀 segments 数组缓存 + tail segments 拼接」，稳定边界判定作用在 segment 层**

- 问题：08 初稿的 `IncrementalRenderResult {prefixHtml, tailHtml}` 是字符串语义，但 MarkdownRenderer.vue:74 消费的是 `MarkdownSegment[]`（text/mermaid 段交错、每段独立渲染）——字符串协议会迫使 MarkdownRenderer 重写为整段 v-html，推翻现有渲染结构。**08 文档磁盘版 §3.3.2 已含审查修正（协议已是 `prefixSegments/tailSegments` 数组 + segId 稳定键），本裁决确认现行版**。
- 裁决：增量协议按文档现行版执行——segments 数组语义：`renderIncremental` 返回 `{prefixSegments: MarkdownSegment[], tailSegments: MarkdownSegment[]}`；稳定边界判定（findStableBoundary）作用在 segment 层（边界必须落在两个 segment 之间或某 text segment 内部的块级闭合点）；前缀 segments 按引用恒等缓存，segment 首次产出时分配单调递增 `segId`（跨帧稳定），渲染树 `v-for :key="seg.segId"`——前缀段引用与 segId 稳定即 DOM 复用（text 段 v-html 子树不触碰、mermaid 段组件实例跨帧保活）；tail 段每帧重建。非 turn 项（如 systemNotice）建议纳入 cachedItems 缓存（消化文档伪代码自洽缺口）。
- 理由：协议必须贴合消费方形态；segId 稳定键的 DOM 复用规则（前缀段 key 稳定 → 复用）是增量化在 v-for 下的正确落点。
- 影响 wave：W22（协议与边界函数）、W23（MarkdownRenderer 消费）。

**R-20（08-G2）边界判定规格：纯函数 + markdown-it token 流/行级扫描 + 9 形态单测矩阵锁定**

- 问题：isAllClosed/tailStartsWithCleanBlock 状态机规格未展开（fence `~~~` 变体与 info string、表格分隔行、列表项 lazy continuation、嵌套 blockquote 前缀）。
- 裁决：实现以 markdown-it 的 token 流或行级扫描为准（不手写完整 CommonSpec 解析器）；边界判定函数必须是**纯函数**（同输入同输出、零副作用）；行为由 08 文档 §5.3 的 9 形态矩阵单测锁定（W22 交付）；**未知/无法判定形态一律 fallback-full**（文档已有降级语义，作为唯一兜底出口，不写第 4 条路径）；fence 占位 UI 由 MarkdownRenderer 对未闭合段特殊渲染（语言名 + spinner 行，遵守 xyz-ui 规范禁 emoji）。
- 理由：状态机逐变体展开会让规格无限膨胀；矩阵单测 + 纯函数 + 降级兜底是可证伪且可维护的组合。
- 影响 wave：W22。

**R-21（09-G1）D-7.2 任务书必须包含 13 个消费文件逐一排查步骤**

- 问题：fileTree store 有 13 个非测试消费文件（useSidebar/useSidebarCounts/useSidebarNew/useSearchJump/useSearchModalDeps/useNewTaskFlow/useDetailPane/useChatViewDeps/useFileTree/file-tree-utils/FileTreeRow/FileView/GitPanel），文档 D-7.2 无清单。「4 facet 不变则安全」是隐含主张未验证。
- 裁决：W28 第一步为排查步骤：对 13 个消费文件逐个列出其消费的 store 成员，确认全部落在「保持不变的 4 facet」内；发现消费了被扁平化重构移除/改形的成员 → 该消费点在本 wave 内适配并在汇报中列出。
- 理由：扁平投影 + virtua 改的是数据形状，消费面清单是唯一防回归手段。
- 影响 wave：W28。

**R-22（09-G2）终端 scrollback buffer 放 per-session 分区（组件外），组件重建时读回**

- 问题：D-6.2 验收要求「切 tab 30s 回来历史完整」，但 TerminalView 切 tab 是 unmount/remount（PanelContainer.vue:93 `v-else-if="drawerTab === 'terminal'"`，[代码验证]），buffer 挂组件实例必丢。
- 裁决：buffer 存 per-session 分区（ADR-0049 `useSessionScopedState` 工厂 + `markRaw` 包裹非响应式 buffer），TerminalView 重建时从分区读回 + 按版本回放；session 销毁经工厂注册的 cleanup 自动释放。
- 理由：与项目 per-session 状态隔离范式（ADR-0049）一致，组件生命周期与数据生命周期解耦。
- 影响 wave：W27。

**R-23（09-G3）D-9 触发源：浅 watch messages 分区替换 + 扫末条消息 changeSetStatus（纯 renderer）**

- 问题：fileChanges 是 assistant 消息内嵌字段（m.fileChanges），无独立 WS 事件可订阅，文档「订阅 message.file_changes ready 帧」路径模糊。
- 裁决：D-9 触发源 = 浅 watch `() => chatStore.messages.get(sid)?.value`（数组替换触发）+ 扫末条（或末 N 条）消息的 changeSetStatus，status 变为 ready 时 debounce 300ms → `gitApi.status` → `setGitOverlay`。不加 runtime 广播。与 R-16 的 W11 改造同片代码、串行接力（W11 先把 watch source 迁到内层 ref，W19 在其上加业务判定）。
- 理由：消息数组已是「ready 信号」的载体，浅 watch + 扫尾是零协议成本的正确挂点。
- 影响 wave：W19。

**R-24（10-G1）Q1-7 改 packages/ui 活跃副本，删除 renderer 死副本**

- 问题：文档 Q1-7 指向 `packages/renderer/src/composables/panel/useTurnElapsed.ts`，该文件零 import 引用（[代码验证]：renderer 内出现处均为注释/测试描述文字）；活跃副本是 `packages/ui/src/features/chat/composables/useTurnElapsed.ts`（Turn.vue:106 消费）。
- 裁决：visibilitychange 停表 + Date.now() 补算改在 packages/ui 副本实现；renderer 死副本文件顺带删除（死代码清理，若 pre-commit 的测试引用该路径则同步清理引用）。
- 理由：改死文件等于没改；两副本并存是漂移源。
- 影响 wave：W5。

### 2.3 minor 缺口消化表（挂到 wave 注意事项，不单列裁决）

| 来源 | minor 事项 | 消化 wave |
|---|---|---|
| 01 | 闭包 handlers Map 与模块级 handleIncomingRequest 桥接需模块级胶水（如 setHookExecutor） | W1 |
| 01 | event-interpreter 5 处已是泛型 onPiEvent 调用，U3 实际可能零改动（以 grep 为准） | W2 |
| 01 | D2-5「注册时保序」实为现状（hook-api.ts:93 已 sort），真正改动只是删 hook-pipeline.ts:66 每次执行排序 | W2 |
| 01 | V1 验收需补「确认 demo 插件已激活」操作；hook-types.ts 实际路径含 plugin-types/ 目录层级 | W2 |
| 02 | session-message-handler.ts:320-355（subscribe handler fromSeq 语义）列入 W6 核对 | W6 |
| 02 | 类型名简写勘误 4 处（session.thinkingLevelSet/message.bashStart 等以 protocol.ts 完整 wire 名为准）；handoff-service.ts 在 services/ 直下 | W6/W9 |
| 02 | V1/V2 验收补操作细节（ws 层打点插入位置） | W9 |
| 03 | 超时归一：snapshotStatus/numstat 沿用 reconciler 现状 5000ms，getStatus 沿用 git-executor 8000ms（文档 D3-1 已修正，照办） | W16/W18 |
| 03 | computeLineCounts 的 numstat execSync（reconciler:168）一并异步化（文档 D4-5 已覆盖） | W18 |
| 03 | sendDiffFileChanges 异步化连锁 handleTurnEnd 调用点（event-interpreter.ts:239-241/:394）签名 | W18 |
| 04 | lastLeafId 清除挂点：session dispose（clearSession）+ pi 进程退出感知，任务书指定 | W20 |
| 04 | compaction 场景（pi compact 后旧 entry id 消失 → since 失效/重复）列入前置验证脚本与测试 | W20 |
| 04 | pi 错误文案实为 "Entry not found"（非 Not），fallback 匹配以实测为准 | W20 |
| 05 | listDir 现状 dir entry 已不 stat（fs-executor.ts:28-45），D7-3 参数化对象实际作用于 file entry 的 stat | W25 |
| 05 | fast-glob 有真实消费点（plugin-rpc-setup.ts:279 动态 import），**不删依赖**（总纲检查点 5 就此关闭） | W24 备注 |
| 05 | D9 rename 失效点未探明，任务内排查 | W26 |
| 05 | V2 strace 在 macOS 不可用，改日志打点验证 | W24 |
| 06 | migrateBuiltinExtensions 必须在 checkAndAutoUpgrade 前（index.ts:190 注释）；migrateSettingsSkillsToDiscovery（index.ts:185）重排时位置需判断 | W29 |
| 06 | buildAppInfoMsg 是 private（message-broker.ts:127），需新增 public 入口 | W29 |
| 06 | WriteStream 轮转顺序必须「end 旧流 → rename → 开新流」（rename 时流持旧 inode） | W30 |
| 06 | appInfo 更新机制：getPiVersion 返回后 mutate 同对象 + 补发 app.info | W29 |
| 07 | P4 探针 grep 限定代码引用（注释里有 streamingSessionIds 字样） | W13 |
| 07 | getMessages 消费方实测 12 处/10 文件（文档写 13） | W10 |
| 07 | 「streaming-state-machine 签名不变」表述误导（体内 3 处读法必须改） | W10 |
| 08 | messageTurns re-export 链（renderer/composables/logic/messageTurns.ts:12 re-export 自 core），新函数需同步导出 | W21 |
| 09 | D-6.1 scrollback 填充时机（flush 时逐 chunk push 保持回放粒度） | W14 |
| 09 | cropIfOver 与 xterm scrollback 选项双层语义（SCROLLBACK_LIMIT 按 chunk vs xterm 按行），实施时定 SSOT | W27 |
| 09 | D-7.1 先于 D-9（setGitOverlay 第二调用点交互）——已在依赖图固化 | W15→W19 |
| 10 | Q1-1 验收措辞改「readAll 重复消除」（保留立即写盘，5 次 setItem 可接受；不引入 idle 合并） | W3 |
| 10 | D-8 边界判据：PanelContainer 其余条件挂载组件（BrowserPane/SubagentTab/WorkflowTab/CommandDocPanel/GitPanel）逐个评估后决定是否纳入懒加载（默认不纳入，评估结论写入汇报） | W31 |
| 10 | AsyncErrorFallback.vue 守 xyz-ui 规范（禁原生元素/emoji，loading 用 UI 组件） | W31 |
| 10 | Q1-9 deep watch 改浅前核实语义等价（文档已注明） | W5 |

## §3 Wave 总表

31 个 wave。验证命令列只写主命令（各 wave 任务书内有细化）；「文档章节」= 该 wave 实施时的方案权威入口。

| Wave | 名称 | 覆盖决策 | 涉及文件（packages/ 起算） | 依赖 | 验证命令 | 文档章节 |
|---|---|---|---|---|---|---|
| W01 | D2 核心：request 直连 + result 腿清理 | D2 | runtime/src/services/plugin-service/plugin-bootstrap.ts、hook-api.ts、hook-pipeline.ts | — | runtime vitest | 01 §3.3 D2-1/D2-3 |
| W02 | D2 observe 层 + e2e + 阶段0微项×2 | D2 + 微项6/7 | services/plugin-service/bridge-interop.ts、plugin-service.ts、plugin-host.ts、plugin-host-process.ts、hook-pipeline.ts、api/notify-api.ts + services/session/event-interpreter.ts + 新增 plugin-hooks-e2e.test.ts | W01 | runtime vitest | 01 §3.3 D2-2/D2-4/D2-5/D2-6 |
| W03 | Q1-A：markers/i18n/声音 | Q1-1/2/3 | renderer/src/composables/useSessionMarkers.ts、renderer/src/i18n/index.ts、renderer/src/composables/effects/useCompletionSound.ts、renderer/src/composables/sound-platform.ts | — | renderer vitest | 10 §3.6 Q1-1~3 |
| W04 | Q1-B：core 快赢 | Q1-4/5/8/9(core) | core/src/coordination/route-inbound.ts、renderer/src/api/pending.ts、renderer/src/composables/useToast.ts、core/src/domain/chat/bash-effects.ts、core/src/domain/chat/lru.ts | — | core+renderer vitest | 10 §3.6 Q1-4/5/8/9 |
| W05 | Q1-C：可见性/停表/死副本 | Q1-6/7/9(renderer) | renderer/src/composables/features/settings/useAppUpdate.ts、ui/src/features/chat/composables/useTurnElapsed.ts、删 renderer/src/composables/panel/useTurnElapsed.ts、renderer/src/components/sidebar/ForkGroup.vue、renderer/src/stores/project.ts | — | renderer+ui vitest | 10 §3.6 Q1-6/7/9 |
| W06 | Bus topic 分类 + gap 修正 | D5 | runtime/src/services/message-bus/message-bus.ts、message-bus.test.ts、runtime/src/transport/session-message-handler.ts | — | runtime vitest | 02 §3.3 D5-1~D5-3 |
| W07 | 接 bus 第一批：terminal/context/exited | D1 | runtime/src/services/terminal/terminal-service.ts（含 TerminalServiceDeps 定义）、services/session/session-service.ts、runtime/src/index.ts、runtime/src/infra/pi/event-adapter.ts（微项1） | W06 | runtime vitest | 02 §3.3 D1-1 |
| W08 | 接 bus 第二批：plugin/extension | D1 | runtime/src/services/plugin-service/plugin-rpc-setup.ts、plugin-service.ts、transport/extension-message-handler.ts、services/handoff-service.ts（删 handoffStarted） | W06 | runtime vitest | 02 §3.3 D1-1 |
| W09 | 删双写 + 接口收敛 + renderer 验证 | D1 | runtime/src/services/session/session-service.ts、services/session/message-dispatcher.ts、runtime/src/interfaces.ts、transport/message-broker.ts、services/session/event-interpreter.ts（微项4） | W07+W08 | runtime+renderer vitest | 02 §3.3 D1-2/D1-3 |
| W10 | D-1 容器范式原子落地 | D-1 | core/src/domain/chat/mutations.ts、effect-types.ts、store.ts、streaming-state-machine.ts、bash-effects.ts、changeset.ts、effects/registry.ts（7 文件，R-15 超限理由） | W09 | core vitest（存量红=预期，W13 收口） | 07 §3.3 D-1 |
| W11 | D-3 惰性派生 + watcher 迁移 | D-3 + R-16 | core store.ts、core/src/domain/chat/lru.ts、renderer/src/composables/features/file-tree/useFileChangeInvalidation.ts、renderer/src/composables/features/search/useSearch.ts | W10 | core+renderer vitest | 07 §3.3 D-3 + §5.2 U7 |
| W12 | D-2 token coalescing | D-2 | core/src/domain/chat/useChat.ts + 新增 coalescer 单测 | W10 | core vitest | 07 §3.3 D-2 |
| W13 | 07 测试适配收口 | D-1/D-3 回归 | core __tests__/mutations.test.ts（重写）+ 文档 §5.3 所列 5 文件 | W10+W11+W12 | core+renderer vitest 全绿 | 07 §5.3 |
| W14 | D-6.1 rAF 写队列 | D-6 第一步 | renderer/src/composables/features/terminal/useTerminal.ts、renderer/src/components/panel/TerminalView.vue | — | renderer vitest | 09 §5 D-6.1 |
| W15 | D-7.1 徽章预聚合 + 过滤防抖 | D-7 第一步 | renderer/src/stores/fileTree.ts、renderer/src/composables/features/file-tree/useFileTree.ts | — | renderer vitest | 09 §5 D-7.1 |
| W16 | GitStateService 基础设施 | D3+D4 + 微项10 | 新增 runtime/src/services/ports/git-state.ts + 实现（services/git/ 下）、runtime/src/infra/git-executor.ts、infra/system/git-info-reader.ts、services/worktree/workspace-detector.ts | — | runtime vitest | 03 §3.3 D3-1/D4-1~D4-3 |
| W17 | getStatus 收编 + 写操作失效 | D4 + 微项5/8 | runtime/src/services/git-service.ts、transport/git-message-handler.ts、runtime/src/index.ts | W16 | runtime vitest | 03 §3.3 D4-4 + §5 U2 |
| W18 | file_changes 采集异步化 + 帧序不变量 | D3 + R-09/R-10 | runtime/src/infra/pi/file-change-reconciler.ts、services/ports/file-change-diff.ts、infra/pi/file-change-diff-adapter.ts、services/session/event-interpreter.ts、runtime/src/index.ts、core/src/domain/chat/changeset.ts | W17 | runtime+core vitest | 03 §3.3 D3-3/D4-5 + §5 U3 |
| W19 | D-9 overlay 回写 | D-9 | renderer/src/composables/features/file-tree/useFileChangeInvalidation.ts、useFileTree.ts（+useFileSearch/useSearchModalDeps 消费确认） | W15+W18 | renderer vitest | 09 §5 D-9 |
| W20 | D6 历史增量（纯 runtime）+ switch reply 瘦身 | D6 + R-11/R-12 + 微项2/9 | runtime/src/services/session/session-service.ts、transport/session-message-handler.ts、shared/src/protocol.ts、runtime/src/infra/pi/message-converter.ts（微项2）、runtime/src/infra/pi/session-file-utils.ts（微项9）+ 前置验证脚本（临时） | W09 | runtime vitest + 验证脚本 exit 0 | 04 §3.3 D6-1~D6-5 |
| W21 | D-4 turn 派生增量化 | D-4 | core/src/domain/chat/message-turns.ts、renderer/src/composables/logic/messageTurns.ts（re-export）、renderer/src/components/panel/MessageStream.vue、ui/src/features/chat/Turn.vue + 新增 message-turns.incremental.test.ts | W10 | core+renderer vitest | 08 §3.3 D-4 + §5 U1-U3 |
| W22 | D-5 边界判定 + 增量协议 | D-5 | renderer/src/composables/logic/markdown.ts + 新增 markdown-incremental.test.ts | —（可与 W21 并行启动；segments 协议形状对齐 W23 消费方后合入，R-19） | renderer vitest | 08 §3.3 D-5 + §5 U4/U6 |
| W23 | MarkdownRenderer 增量消费 | D-5 | ui/src/features/chat/MarkdownRenderer.vue | W21+W22 | ui+renderer vitest | 08 §5 U5 |
| W24 | matcher 缓存 + 短路径直通 | D7（R-13 后缩围） | runtime/src/services/file-service.ts、runtime/src/infra/fs/ignore-parser.ts + 新增剪枝/缓存测试 | — | runtime vitest | 05 §3.3 D7-1 + D7-2（缩围） |
| W25 | listDir 参数化 + 有界并发 | D7 | runtime/src/infra/fs-executor.ts、runtime/src/services/ports/file-executor.ts、runtime/src/services/file-service.ts | W24 | runtime vitest | 05 §3.3 D7-3/D7-4 |
| W26 | session 扫描缓存 + find 合并 + quota | D9 + 微项11/12 | runtime/src/infra/pi/session-file-utils.ts、runtime/src/services/session-history.ts（force 透传）、runtime/src/services/session/session-lifecycle.ts、session-service.ts、services/session/session-fork.ts、runtime/src/services/quota-cache.ts | W20（同文件序） | runtime vitest | 05 §3.3 D9-1 + §5 U5 |
| W27 | D-6.2 命令式 buffer + 回放 | D-6 第二步 | renderer useTerminal.ts、TerminalView.vue、runtime/src/services/terminal/terminal-service.ts | W09+W14 | renderer+runtime vitest | 09 §5 D-6.2 |
| W28 | D-7.2 扁平投影 + virtua | D-7 第二步 | renderer/src/stores/fileTree.ts、renderer/src/components/sidebar/FileView.vue、sidebar/FileTreeRow.vue | W15 | renderer vitest | 09 §5 D-7.2 |
| W29 | 启动编排重排 | D8 | runtime/src/index.ts、runtime/src/transport/message-broker.ts、runtime/src/services/session/session-lifecycle.ts | — | runtime vitest + dev 启动验证 | 06 §3.3 D8-1~D8-3 |
| W30 | 日志 WriteStream 化 | D10 | runtime/src/infra/logger.ts | — | runtime vitest | 06 §3.3 D10-1/D10-2 |
| W31 | 构建分割 | D-8 | renderer/vite.config.ts、renderer/src/components/shell/AppShell.vue、renderer/src/components/workspace/PanelContainer.vue + 新增 AsyncErrorFallback.vue | — | pnpm build + 产物断言 | 10 §3.4/§3.5 + §5.1 P3-1 |

注：W22 标注「可并行启动」指边界判定纯函数可先行开发，但其协议形状（segments 数组，R-19）必须与 W23 对齐后合入；W21 与 W22 无文件交集，可并行派发。

## §4 Wave 详细任务书

> 通用验收基线（每个 wave 隐含）：改动包的 `npx vitest run` 全绿（W10 例外，见其任务书）；`pnpm run lint` 对改动文件无新增告警；runtime 包改动额外过 `bash scripts/validate-runtime-bundle.sh`；完成即 commit。

### W01 — D2 核心：Worker request 直连 + result 腿清理（阶段 0）

- **目标**：修复 hook 执行链路断裂的主体——block/transform 语义走 request 直连拿结果。不做 observe 改造（W02）、不动 event-interpreter。
- **文件**：`packages/runtime/src/services/plugin-service/plugin-bootstrap.ts`（handleIncomingRequest 增加 `plugin.hooks.invoke` 分支）；`services/plugin-service/hook-api.ts`（**plugin-service/ 直下，非 api/ 子目录——api/ 下只有 notify-api.ts 等**；导出按 handlerId 执行的入口，如 `executeHookRequest(params)`；闭包 handlers Map 经模块级胶水如 setHookExecutor 桥接到 bootstrap）；`services/plugin-service/hook-pipeline.ts`（响应 `{proceed, modifiedData, reason}` → `HookResult {blocked, blockedBy, reason, transformedData}` 映射层）。
- **步骤要点**：① hook-api 导出执行入口 + 模块级胶水注册；② bootstrap 分支查 Map → 调 handler → catch 回 `{proceed:true}`（异常放行语义）→ 原样回传；③ hook-pipeline 映射层；④ **删除 hook-api.ts:144-162 的 `plugin.hooks.invoke.result` 回传腿**（R-02）。
- **注意事项**：hook-types.ts 实际路径含 plugin-types/ 目录层级；`handleBridgeIntercept` 的 `injectedMessages` 返回语义与 HookResult 字段对齐（01 §5 检查点）。
- **验收**：`cd packages/runtime && npx vitest run` 全绿（现有 plugin-hooks-serial / plugin-api-hooks 不红）；新增单测：mock 传输下 executeHookRequest 返回 block 与 transform 两形态 + 映射层断言 `transformedData === modifiedData`；grep 确认 `plugin.hooks.invoke.result` 字符串在 src 内零命中。
- **关联裁决**：R-02。

### W02 — D2 observe 层 + e2e + 阶段 0 微项（阶段 0）

- **目标**：observe 类走 notify（零往返）、注册/调用 key 统一泛型、排序与索引优化、e2e 测试消灭 mock 盲区；顺带两项阶段 0 微项（同文件）。
- **文件**：`services/plugin-service/bridge-interop.ts`（observe 组 7 事件映射改挂 `onPiEvent` 泛型——R-01；微项：tool 执行 name 索引 Map.get，bridge-interop.ts:82）；`plugin-service.ts`（executeHooks observe 快捷路径）；`plugin-host.ts`/`plugin-host-process.ts`（pluginId→workerId 反向索引维护）；`services/plugin-service/hook-pipeline.ts`（删 :66 的每次执行排序——步骤③）；`services/session/event-interpreter.ts`（5 处 onPiEvent 调用点核对——已是泛型则零改动，以 grep 为准）；`services/plugin-service/api/notify-api.ts`（微项：notify 改真 notification，notify-api.ts:112）；新增 `plugin-hooks-e2e.test.ts`。
- **步骤要点**：① observe 映射改泛型 + plugin-service observe 快捷路径（调 `rpcServer.notify`）；② 反向索引（assign/terminate/crash 同步维护）；③ 删 hook-pipeline.ts:66 的每次执行排序（注册时保序是现状 hook-api.ts:93 已 sort，勿重复实现）；④ e2e：真实 plugin-bootstrap.handleMessage + 真实 PluginRpcServer + worker_threads MessageChannel 内存端口，覆盖 block 生效 / transform 生效 / observe 通知不产生响应三断言 + 双宿主（bootstrap 与 bootstrap-process）各跑一遍。
- **注意事项**：V1 真实验收时先确认 demo 插件已激活再发消息。
- **验收**：`cd packages/runtime && npx vitest run` 全绿，其中新 e2e 文件三语义断言全过；`PI_HOOK_EVENT_MAP` 内无 `'onMessage'` 字面量（grep 断言）。
- **关联裁决**：R-01；微项 6/7。

### W03 — Q1-A：markers / i18n / 声音缓存（阶段 0）

- **目标**：Q1-1 markers 写路径走内存 cache；Q1-2 i18n 初始只载 zh-CN；Q1-3 声音/platform 探测缓存。
- **文件**：`useSessionMarkers.ts`（写路径改 `ensureCache()` → mutate → 更新 cache.value → 写盘；**不引入 idle 合并**，保留立即写盘）；`i18n/index.ts`（初始只 zh-CN；`setLocale('en-US')` 动态 import + setLocaleMessage）；`useCompletionSound.ts` + 同目录 sound-platform（缓存 resolveName/detectPlatform + win 平台 `Map<name, Audio>`）。
- **注意事项**：Q1-1 验收措辞按 R 裁决为「readAll 重复消除」（5 次 setItem 保留）。
- **验收**：`cd packages/renderer && npx vitest run` 全绿；新增/改造单测：markers 连续写不再 readAll（spy 断言）；setLocale('en-US') 后文案为英文且 zh-CN 包仍可切回；连续播放同音不重复 new Audio/spawn（spy 计数不变）。
- **关联裁决**：§2.3 minor（Q1-1 措辞）。

### W04 — Q1-B：core 快赢四项（阶段 0）

- **目标**：Q1-4 ROUTE_TABLE Record 化；Q1-5 pendingMap 上限 + 惰性超时；Q1-8 toast timer 句柄；Q1-9 的 core 部分（bash-effects reverse 改倒序 for、lru keys 去二次拷贝）。
- **文件**：`core/src/coordination/route-inbound.ts`、`renderer/src/api/pending.ts`、`renderer/src/composables/useToast.ts`、`core/src/domain/chat/bash-effects.ts`、`core/src/domain/chat/lru.ts`。
- **注意事项**：bash-effects/lru 在 W10 还会被 D-1 适配改造——本 wave 只做性能微改，不动类型读法；Q1-5 上限定 256，超限最老 reject。
- **验收**：`cd packages/core && npx vitest run` + `cd packages/renderer && npx vitest run` 全绿；新增单测：route-inbound 路由 O(1) 行为等价（同消息同路由）；pending 超 256 驱逐最老；remove toast 后 timer 已清（fake timers 断言不再触发）。
- **关联裁决**：无（照 10 §3.6）。

### W05 — Q1-C：可见性守卫 + 死副本清理（阶段 0）

- **目标**：Q1-6 useAppUpdate visibility 守卫；Q1-7 改 ui 活跃副本 + 删 renderer 死副本；Q1-9 renderer 部分（ForkGroup/project deep watch 改浅）。
- **文件**：`useAppUpdate.ts`、`ui/src/features/chat/composables/useTurnElapsed.ts`、删除 `renderer/src/composables/panel/useTurnElapsed.ts`、`ForkGroup.vue`、`stores/project.ts`。
- **步骤要点**：① useTurnElapsed 在 **ui 包副本**实现 visibilitychange 停表 + 恢复 Date.now() 补算；② 删 renderer 死副本前 grep 全部引用（含测试），引用处同步清理；③ ForkGroup watch `props.freshIds`、project watch `projects` 改浅前先读全部写点确认「数组内部变更均经整替换表达」，语义不等价则保持 deep 并在汇报说明（Q1-9 有条件改浅）。
- **验收**：`cd packages/renderer && npx vitest run` + `cd packages/ui && npx vitest run`（如有）全绿；`grep -rn "composables/panel/useTurnElapsed" packages/` 零命中；失焦态无每秒 tick（fake timers + visibility mock 断言 interval 回调不触发）。
- **关联裁决**：R-24。

### W06 — Bus topic 分类 + gap 修正 + stateTypeKey（阶段 1）

- **目标**：D5-1/2/3 落地——topic 三分类表、publish 分流（state 写快照 / transient 免 seq 直传）、O(1) 环形缓冲、gap 基准修正、stateTypeKey 补全（含 `session.workflowUpdate` 映射修正）+ 提为模块级常量（微项 3）。
- **文件**：`message-bus.ts`、`message-bus.test.ts`、`session-message-handler.ts`（subscribe handler 的 fromSeq/gap 语义核对与适配，:320-355 一带）。
- **步骤要点**：① `topicOf(type)` 查表 + **miss fallback = stream**（R-07）；② state 类分配 seq、写快照不入 ring；transient 不分配 seq 直传；③ ring 改定长数组 + head/tail（覆盖写），snapshot 按 seq 导出；④ **删除 bus 内 `seqCounter > ring.length` 死 gauge**（R-03），gap 只由 handler 的 `fromSeq < ring 最旧 seq` 判定；⑤ stateTypeKey：补 `session.state_changed`、改 `session.workflowUpdate`、提模块级。
- **注意事项**：类型名以 `packages/shared/src/protocol.ts` 完整 wire 名为准（简写勘误 4 处）；message-bus.test.ts 的 FIFO/seq/快照断言同步更新。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增断言：① state+stream 混合 session（5 state + 3 stream）subscribe 时 `gap === false` 且快照完整（R-03 探针）；② transient 消息无 seq 字段；③ ring 溢出后 oldest seq 正确、gap=true 路径全量回放。
- **关联裁决**：R-03、R-07；微项 3。

### W07 — 接 bus 第一批：terminal / context / exited（阶段 1）

- **目标**：D1-1 表前三类接 bus——terminal.data（transient）/alive/exit（stream）、context.update turn-end 路径（state）、session.exited（stream）。
- **文件**：`services/terminal/terminal-service.ts`（广播改注入的 publish 封装，TerminalServiceDeps 同文件定义——R-05）；`services/session/session-service.ts`（applyContextUpdate 补 publish 对齐 restore 路径、exited 补 publish）；`runtime/src/index.ts`（组合根：`broadcast: (msg) => server.broadcast(msg)` 注入点改 bus 通道封装）；`infra/pi/event-adapter.ts`（微项 1：thinking_delta 透传 contentIndex，:98-105）。
- **注意事项**：terminal.data 走 transient（不占 seq 不入 ring）；alive/exit 入 ring；D1-2 未删双写前这些消息 bus + broadcast 并存是过渡态（W09 收口）。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增集成断言：terminal.data publish 后订阅者收到且 ring 长度不变、seq 计数不变；context.update 走 bus 后重连订阅能从快照恢复。
- **关联裁决**：R-05；微项 1。

### W08 — 接 bus 第二批：plugin / extension / handoff（阶段 1）

- **目标**：D1-1 表后三类——plugin:viewUpdate（transient）/uiRequest（stream）补 publish、extension.ui_timeout（stream）补 publish、删除 session.handoffStarted 广播。
- **文件**：`plugin-rpc-setup.ts`（viewUpdate 广播点，:260 一带——R-06）；`plugin-service.ts`（uiRequest 广播点；sid 为 string 走 publish 且不再 broadcast，undefined 保持全局 broadcast）；`extension-message-handler.ts`（ui_timeout 补 publish）；`handoff-service.ts`（删 handoffStarted 广播——前端无消费方）。
- **注意事项**：viewUpdate/uiRequest 均在 CROSS_SESSION_TYPES，renderer dispatchCrossSession 不受传输方式影响（02 文档 D1-1 已论证）；handoff-service.ts 实际在 services/ 直下。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；grep 断言：`handoffStarted` 在 src 内零 publish/broadcast；新增断言：viewUpdate 经 bus publish 后订阅者收到（transient 无 seq）。
- **关联裁决**：R-06。

### W09 — 删双写 + 接口收敛 + renderer 只读验证（阶段 1）

- **目标**：D1-2 收益主体——删除 session 级消息的盲广播路径，`IMessageBroker` 与 MessageBus 收敛为同一 publish 抽象；R8 验证；顺带微项 4（事件 kind 路由移出 delta 帧路径）。
- **文件**：`services/session/session-service.ts`（send 回调删 broadcast）、`services/session/message-dispatcher.ts`（14 处双写点删 broadcast）、`runtime/src/interfaces.ts` + `transport/message-broker.ts`（接口收敛，broadcast 退化为纯全局通道）、`services/session/event-interpreter.ts`（微项 4：:209-215 的 kind 路由移出 delta 帧路径）。
- **步骤要点**：① **前置排查（R-08）**：`grep -rn "\.broadcast(" packages/runtime/src` 逐处分类，对照 02 文档 D1-2 审计表逐行勾稽，清单写入汇报；任一 session 级 push 型消息不在表内 → 保留其 broadcast 并上报；② 删双写；③ 接口收敛；④ renderer 只读验证：grep renderer 对 `msg.seq` 的消费点确认无「所有 push 都有 seq」的隐式依赖；R8 探针验证 subagent 虚拟 session 订阅覆盖——**未覆盖则实施 R-04**（publish 目标改 `this.sessionId` 主 session，payload.sessionId 不动）。
- **注意事项**：全局消息（config.*、app.info、plugin:statusBar* 等无 sessionId 者与 RPC reply 型）的 broadcast/reply 全部保留，见 02 文档 D5-1 排除清单。
- **验收**：`cd packages/runtime && npx vitest run` + `cd packages/renderer && npx vitest run` 全绿；新增确定性断言（02 V1 的脚本化）：同一 session 级消息在 send/bus 层只被 `JSON.stringify` 一次（ws 层打点计数 = 1）、只推给订阅该 sid 的连接；R8 结论（覆盖/未覆盖 + 是否实施 R-04）写入汇报。
- **关联裁决**：R-04、R-08；微项 4。

### W10 — D-1 容器范式原子落地（阶段 1，7 文件）

- **目标**：`MessagesRef` 从 `ShallowRef<Map<string, Message[]>>` 升级为 `Map<string, ShallowRef<Message[]>>`（Map 恒等稳定 + per-session 独立 ref），commitMessages/deleteMessages 新实现，全部读点适配。**7 文件一个 commit 原子落地，不可拆**（R-15：中间态无法编译）。
- **文件**：`core/src/domain/chat/mutations.ts`（类型 + 写实现）、`effect-types.ts:28`（内联类型）、`store.ts`（声明 + getMessages `.value` + 5 处读点）、`streaming-state-machine.ts`（3 处：finalizeMessages 的 prev 读法）、`bash-effects.ts`（3 处）、`changeset.ts`（applyFileChanges 1 处）、`effects/registry.ts`（16 处）。
- **步骤要点**：① 先改类型与写侧（mutations/store）；② 逐文件适配读侧（`messages.value.get(sid)` → `.value.get(sid)?.value` 或经 getMessages）；③ 每文件适配后跑 `cd packages/core && npx vitest run` 记录失败面（预期存量红集中在 5+1 测试文件，W13 收口）。
- **注意事项**：getMessages 接口形状不变（消费方零改）；「streaming-state-machine 签名不变」仅指对外签名，体内 3 处读法必须改；本 wave 结束时 core 测试允许非测试文件零类型错误 + 指定测试文件红（在汇报中列明红文件清单），**不要求全绿**——全绿是 W13 的验收。
- **验收**：`cd packages/core && npx vitest run`：非「直接断言 messages.value」的测试文件全绿；`npx tsc --noEmit`（core 包）零错误；grep 断言 `messages.value.get(` 的返回值不再被当数组直接 `.map/.filter`（配合 tsc）。
- **关联裁决**：R-15。

### W11 — D-3 惰性派生 + watcher 依赖迁移（阶段 1）

- **目标**：删 `streamingSessionIds` 全 Map 重扫，新增 per-session 惰性派生（`sessionStreamingFlags` 或等价 computed 缓存）；R-16 watcher 迁移（useFileChangeInvalidation + useSearch 的 watch source 迁到 per-sid 内层 ref 并去 deep）。
- **文件**：`core store.ts`（删 streamingSessionIds + isGenerating 惰性化 + disposeSession 清 flags）、`core/src/domain/chat/lru.ts`（deleteMessageKey 同步清 flags）、`renderer/src/composables/features/file-tree/useFileChangeInvalidation.ts`、`renderer/src/composables/features/search/useSearch.ts`。
- **步骤要点**：① store 惰性派生（SSOT 仍是消息数组，flags 是派生缓存）；② LRU 驱逐/dispose 增补 flags 清理（唯一新增生命周期状态，漏删即慢泄漏）；③ watcher：source 改 `() => chatStore.messages.get(sid)?.value`，删 `{deep:true}`，确认 commitMessages 新数组语义使同 sid 更新仍触发；④ 探针 P5（07 文档）：其他 session 分区 ref 替换不再触发本 watcher。
- **注意事项**：07 文档 §5.2 U7 的边界扩展已由 R-16 显式裁决；useSearch 与 useFileChangeInvalidation 共用 helper 模式，同批迁。
- **验收**：`cd packages/core && npx vitest run` + `cd packages/renderer && npx vitest run`（本 wave 范围内测试绿）；新增单测：同 sid 数组替换触发 watcher、异 sid 替换不触发（spy 计数）；isGenerating 惰性化后行为等价（现有 streaming 相关用例不红）。
- **关联裁决**：R-16。

### W12 — D-2 token coalescing（阶段 1）

- **目标**：useChat 层 delta 合帧——同类型保序、microtask 批量、非 delta 消息先 flush、终态即时 flush。
- **文件**：`core/src/domain/chat/useChat.ts`（ensureStreamSubscription 回调内加 DeltaBuffer + flush）；新增 coalescer 单测文件。
- **步骤要点**：① DeltaBuffer 按文档 §3.3 现行版实现（key = `${sid}:${type}`，**保留首条 contentIndex 并 flush 透传**）；② flush 合成对象构造完整 ServerMessage 形状（透传首条 id；seq 不合成——transient 无 seq）；③ text/thinking delta 合并、非 delta 消息到达即 flush 缓冲再 dispatch；④ 终态（message.complete 等）即时 flush。
- **注意事项**：registry.ts handler 不改（合帧在 useChat 层，直接调 applyMessageEvent 的测试不受影响）；真实 pi token 到达率（总纲检查点 1）在本 wave 验收时用 mock 流实测合并率，若 microtask 窗口过窄再评估 rAF 上限（07 §5.4）。
- **验收**：`cd packages/core && npx vitest run` 全绿；新增单测：N 条同 sid text_delta 合成 1 条且 delta 文本有序拼接、contentIndex 透传（R-18）、tool_call 类消息插入时先 flush、complete 即时 flush。
- **关联裁决**：R-18。

### W13 — 07 测试适配收口（阶段 1）

- **目标**：D-1/D-3 的测试面收口，core 与 renderer 恢复全绿。
- **文件**：`core/src/domain/chat/__tests__/mutations.test.ts`（**重写核心断言**——R-17：断言 Map 恒等 + 内层 ref 替换 + 内容）；文档 §5.3 所列 5 文件（streaming-state-machine.test / lru.test / effects.test / changeset.test / renderer chat-chunk-content-blocks.test）按「读侧改 getMessages 或 .value、写侧 spy 签名三元不变」策略适配。
- **注意事项**：P4 探针 grep 时限定代码引用（注释里有 streamingSessionIds 字样会误报）；优先黑盒断言（经 getMessages）。
- **验收**：`cd packages/core && npx vitest run` + `cd packages/renderer && npx vitest run` **全绿**（W10 遗留红文件清零）；mutations.test 新断言覆盖「同 sid Map 引用不变 + 内层 .value 引用变化」双向。
- **关联裁决**：R-17。

### W14 — D-6.1 终端 rAF 写队列（阶段 1）

- **目标**：terminal.data 处理改 appendChunk + rAF flush，单帧合并多次 xterm.write；用户输入直连不变。
- **文件**：`useTerminal.ts`（TerminalPartition 增 pendingChunks/rafPending + flushPending）、`TerminalView.vue`（挂 rAF flush）。
- **注意事项**：flush 时逐 chunk push 进 scrollback 保持回放粒度（为 W27 版本回放留语义）；本 wave 不动 watch(scrollback.length)。
- **验收**：`cd packages/renderer && npx vitest run` 全绿；新增单测：同帧 N chunk 只一次 write 调用（fake rAF）；探针 P-D6-1 在 dev 实测（写次数/chunk 数显著下降）。
- **关联裁决**：无。

### W15 — D-7.1 徽章预聚合 + 过滤防抖（阶段 1）

- **目标**：dirChangeCounts 随 setGitOverlay 一次预聚合，getDirChangeCount O(1)；setFilter 150-200ms debounce。
- **文件**：`renderer/src/stores/fileTree.ts`、`useFileTree.ts`。
- **注意事项**：本 wave 先于 W19（D-9）落地——setGitOverlay 将新增第二个调用点（ready 回写），预聚合使两调用点天然兼容。
- **验收**：`cd packages/renderer && npx vitest run` 全绿；新增单测：预聚合后 getDirChangeCount 不触发遍历（spy）；过滤输入在防抖窗口内只触发一次投影。
- **关联裁决**：无。

### W16 — GitStateService 基础设施（阶段 2）

- **目标**：D4-1/4-2/4-3 port + 实现先行——异步 execFile、in-flight 单飞去重、分层缓存（getStatus 短 TTL 键 = sessionId+cwd、非仓库负缓存 60s、snapshotStatus 只单飞不缓存）、invalidate 入口；顺带微项 10（两处 LRU O(1)）。
- **文件**：新增 `services/ports/git-state.ts`（StatusSnapshot 用不透明类型 unknown——ADR-0027 层约束）+ `services/git/` 实现文件；`infra/git-executor.ts`（execSync→execFile 异步化，数组参数、超时getStatus 8000ms）；`infra/system/git-info-reader.ts` + `services/worktree/workspace-detector.ts`（微项 10：LRU 淘汰 O(n)→O(1)）。
- **步骤要点**：① port 定义（snapshotStatus/numstat/getStatus/invalidate 四方法）；② 实现（单飞 Map + TTL + 负缓存）；③ git-executor 异步化保持防注入数组参数；④ 两处 LRU 微项独立 commit。
- **注意事项**：git 参数不统一合并——snapshotStatus 裸 `--porcelain`、getStatus `--porcelain=v1 -z -b --untracked-files=all`（03 D4-1 有意区分）；D4-4 第二步（收编 git-info-reader/workspace-detector 的缓存）不做，只做它们的 LRU 微项。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增单测：同 cwd 并发两请求共享一个 Promise（spawn 计数=1）；非仓库首次失败后 60s 内零 spawn；invalidate 后缓存 miss。
- **关联裁决**：无（照 03 §3.3）；微项 10。

### W17 — getStatus 收编 + 写操作失效（阶段 2）

- **目标**：git-service.getStatus 改走 GitStateService（聚合 status+numstat+branch，返回形状不变）；6 个写操作挂 invalidate；微项 5（contextWindow 查询缓存）+ 微项 8（numstat 单趟解析）。
- **文件**：`git-service.ts`（收编 + 微项 8 numstat 单趟解析 :116-131）、`transport/git-message-handler.ts`（stage/unstage/commit/checkout/branch 写操作后 invalidate）、`index.ts`（组合根注入 + 微项 5 contextWindow 查询缓存 :392-397）。
- **注意事项**：worktree add/remove 若走独立 spawn 不经服务，必须同步挂 invalidate（03 §5 检查点：否则面板 2s 陈旧——挂 invalidate 或在汇报声明接受陈旧，二选一写明）；GitStatusResult.sessionId 路由语义不变（缓存键含 sessionId 防串扰，03 D4-3）。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增单测：getStatus 二次调用命中缓存（execFile spy 计数=1）；stage 后立即 getStatus 不返回陈旧（invalidate 生效）；contextWindow 查询重复调用零重复执行。
- **关联裁决**：微项 5/8。

### W18 — file_changes 采集异步化 + 帧序不变量（阶段 2）

- **目标**：reconciler 的 status+numstat 采集全部收进 GitStateService；computeLineCounts 纯函数化；**按 R-09 简化 baseline（不做 promise 门）**；落地 D3-3 帧序三件套（串行链 + turnGen + turnFinalizing）；前端 changeset.ts 单向守卫（纵深防御）。
- **文件**：`infra/pi/file-change-reconciler.ts`（采集注入、computeLineCounts 纯函数化、删 baseline 死参数语义）、`services/ports/file-change-diff.ts`（snapshotGitStatus 签名异步化——R-10）、`infra/pi/file-change-diff-adapter.ts`、`services/session/event-interpreter.ts`（turn-start 采集异步化不 await、handleTurnEnd/handleToolCallEnd 适配 sendDiffFileChanges 异步链、diffChain/turnGen/turnFinalizing）、`runtime/src/index.ts`（组合根注入）、`core/src/domain/chat/changeset.ts`（changeSetStatuses 单向守卫：禁止 ready→accumulating 回退）。
- **步骤要点**：① port/adapter/实现签名异步化；② reconciler 注入采集 + computeLineCounts(changes, numstatMap, writeContents?) 纯函数；③ event-interpreter：turn-start baseline 采集改异步不 await、diffSnapshots 不依赖 baseline；④ 帧序三件套 + `message.complete` 先于 ready 的次序保持（禁止 await 阻塞 turn-end 链）。
- **注意事项**：超时沿现状（snapshotStatus/numstat 5000ms）；numstat 失败 → writeContents 回退语义不变；现有 reconciler 测试基线同步更新。
- **验收**：`cd packages/runtime && npx vitest run` + `cd packages/core && npx vitest run` 全绿；新增单测：computeLineCounts 纯函数（同输入同输出、零 spawn spy）；帧序——模拟乱序完成（accumulating 慢于 ready 入链）时 ready 恒为链尾、跨 turnGen 的迟到 diff 被丢弃、turnFinalizing 后 accumulating no-op；changeset 单向守卫（ready 后 accumulating 不回退）。
- **关联裁决**：R-09、R-10。

### W19 — D-9 overlay 回写（阶段 2）

- **目标**：useFileChangeInvalidation 触发源改造——移除 messages deep watch 依赖模式，改「浅 watch 分区 ref + 扫末条消息 changeSetStatus」，ready 后 debounce 300ms → gitApi.status → setGitOverlay；目录/搜索失效职责保留（ready 路径清单 → onInvalidate）。
- **文件**：`useFileChangeInvalidation.ts`（触发源 + 职责分离）、`useFileTree.ts`（消费方确认；useFileSearch/useSearchModalDeps 只做签名不变确认）。
- **步骤要点**：① 在 W11 迁移后的 watch source 上加 changeSetStatus 扫描（末条或末 N 条 assistant 消息）；② ready 判定 → debounce 300ms → git.status RPC（享受 W16-W17 的 GitStateService 缓存）→ setGitOverlay；③ 目录失效走 ready 的路径清单（**只删 watch 不补目录失效 = 新文件不出现的功能回归**，09 文档 D-9 已警告）。
- **注意事项**：setGitOverlay 第二调用点（loadTree + ready 回写）与 W15 预聚合兼容；debounce 窗口在真实 AI 多文件时序下复核（09 待验证 3）。
- **验收**：`cd packages/renderer && npx vitest run` 全绿；新增单测：**token 路径零 RPC 调用 / 零缓存失效副作用**（浅 watch 在 token commit 数组替换时仍会触发回调，但回调内扫描后 no-op——口径与 09 文档 P-D9-3 探针判定一致：零 git.status RPC、零 onInvalidate 调用，非零 watch 回调）+ ready 后 onInvalidate（目录失效）与 setGitOverlay 均走通（P-D9-3 脚本化）；dev 实测 AI 改 5 文件后角标数秒内刷新（P-D9-2）。
- **关联裁决**：R-23。

### W20 — D6 历史增量 + switch reply 瘦身（阶段 3）

- **目标**：runtime 侧重建缓存（容量帽 8）+ lastLeafId 记录 + `getEntries(since)` 增量 + piEntryId 去重合并 + "Entry not found" fallback；**switch reply 移除 messages 字段**（R-11）；微项 2（contentBlocks.some→布尔）+ 微项 9（parseSessionHeader 首行读）。
- **文件**：`session-service.ts`（getHistory 三分支：缓存命中 / since 增量 / 全量 + 空 entries 短路 R-12 + clearSession 清缓存与 lastLeafId）、`transport/session-message-handler.ts`（switch handler reply 瘦身）、`shared/src/protocol.ts`（switch reply 类型拆分——新形状不含 messages；session.history reply 不动）、`infra/pi/message-converter.ts`（微项 2）、`infra/pi/session-file-utils.ts`（微项 9）；前置验证脚本（临时，验证后移除——项目规则 #4）。
- **步骤要点**：**先验证再编码**（04 §5 检查点 + 项目规则）：① 写独立脚本实测 pi `get_entries(since)` 行为——leafId 随 append 更新、branch 报错文案（"Entry not found" 大小写以实测为准）、空增量响应形状、**compact 后 since 语义**（重复 or 只回新条目）；**条件动作（04 §5 检查点定案）**：若实测 pi compact 后返回与缓存重复的 entry，增量合并按 piEntryId 去重兜底（D6-3 已设计）之外，**补 V7 场景断言**（compact 后切回的历史正确性进单测）；② 缓存与合并实现（去重键 piEntryId，无 piEntryId 防御性顺序追加 + debug 日志）；③ fallback：错误文案匹配 → 丢缓存 → 全量重建；④ switch reply 瘦身 + 协议拆分；⑤ pi 进程退出感知清 lastLeafId（session dispose / clearSession 编排点）。
- **注意事项**：renderer **零改动**（switchSession 两调用点本就丢弃 reply，[代码验证]）；reply 瘦身后 grep renderer 无消费 switch reply messages 的路径（防御性复核）；缓存是纯派生数据可随时丢弃。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；验证脚本 exit 0 且结论写入汇报（四项行为实测）；新增单测：增量合并 piEntryId 去重（同 id 跳过）、空 entries 短路不走尾读（R-12）、fallback 触发后缓存被覆盖、switch reply 形状不含 messages（类型断言）；dev 实测 V1/V2（LRU 驱逐重进：缓存命中零 get_entries / leafId 前进走 since 且日志可见）。**总纲 V7 按 04 文档重范围后新口径执行——LRU 窗口内切回本就零请求（isHydrated 守卫），计时场景限「被驱逐重进」**。
- **关联裁决**：R-11、R-12；微项 2/9。

### W21 — D-4 turn 派生增量化（阶段 3）

- **目标**：`toRenderItemsIncremental`（含 TurnRenderCache）落地，历史 turn 按消息对象身份增量复用；Turn.vue trace 区 v-memo。
- **文件**：`core/src/domain/chat/message-turns.ts`（增量版 + TurnRenderCache，全量版保留为 cache=undefined 退化路径）、`renderer/src/composables/logic/messageTurns.ts`（**re-export 同步导出新函数**——minor 消化）、`renderer/src/components/panel/MessageStream.vue`（**缓存经 `useSessionScopedState` 工厂分区持有（`Map<sid, shallowRef<TurnRenderCache|null>>`），组件内只读当前 sid 分区**——08 §3.3.1 失效条件 3 定案；`<MessageStream :session-id>` 无 `:key`，组件实例不随 session 销毁，实例级缓存会跨 session 残留，违反 ADR-0049。08 §5.2 U2 表格下方的「per-instance 缓存」措辞是文档内部残留矛盾，以 §3.3.1 为准）、`ui/src/features/chat/Turn.vue`（trace v-for 包 v-memo，键 = [块身份, 状态, 本地折叠 ref]）+ 新增 `message-turns.incremental.test.ts`。
- **注意事项**：依赖 07 已落地的消息对象不可变身份（W10-W13）；完整探针验收（复用率 100%）依赖 07，本 wave 先做单测级验收；TurnRenderCache 补 cachedItems 字段缓存非 turn 项（08 minor）。
- **验收**：`cd packages/core && npx vitest run` + `cd packages/renderer && npx vitest run` 全绿；新增单测：追加 1 条消息时历史 turn renderItems 引用复用（身份相等断言）、cache=undefined 时与全量版输出 deepEqual；re-export 链新函数可从 renderer 导入（import 断言）。
- **关联裁决**：无（照 08 §5 U1-U3）。

### W22 — D-5 边界判定 + 增量协议（阶段 3）

- **目标**：`findStableBoundary` + `renderIncremental`（**segments 数组协议**——R-19）+ fence/mermaid 未闭合占位判定；9 形态单测矩阵。
- **文件**：`renderer/src/composables/logic/markdown.ts` + 新增 `markdown-incremental.test.ts`。
- **步骤要点**：① 边界判定纯函数（markdown-it token 流或行级扫描实现——R-20），未知形态一律 fallback-full；② `renderIncremental` 返回 `{prefixSegments, tailSegments}`，稳定边界作用于 segment 层；③ 占位判定（未闭合 fence/mermaid 整体进 tail 占位段）；④ 9 形态矩阵逐行断言「边界处前缀块级结构全闭合 + tail 可独立 render」+ 降级行断言 mode。
- **注意事项**：静默阈值 T 与长度切点不在本 wave 定死（实施期 dev 实测 tuning，候选值见 08 §5.4）；`~~~` fence 变体、表格分隔行、列表 lazy continuation、嵌套 blockquote 覆盖进矩阵。
- **验收**：`cd packages/renderer && npx vitest run` 全绿；新增矩阵测试 9+ 行全绿且覆盖 4 个变体（fence 变体/表格/列表续行/嵌套引用）；纯函数属性抽测（同输入同输出）。
- **关联裁决**：R-19、R-20。

### W23 — MarkdownRenderer 增量消费（阶段 3）

- **目标**：MarkdownRenderer.vue 改增量渲染——前缀 segments 按引用恒等缓存（segment 单调递增 `segId` 跨帧稳定，引用与 segId 不动即 DOM 复用）、tail 每帧重建、静默/complete 转完整渲染、未闭合段占位（语言名 + spinner 行，xyz-ui 组件）。
- **文件**：`ui/src/features/chat/MarkdownRenderer.vue`。
- **注意事项**：渲染树 `v-for :key="seg.segId"`（08 §3.3.2 现行版——前缀段引用与 segId 稳定 → text 段 v-html 子树不触碰、mermaid 段组件实例跨帧保活，R-19 裁决的 DOM 复用规则）；不触碰 MermaidRenderer 成图逻辑（只加未闭合守卫）。
- **验收**：`cd packages/ui && npx vitest run`（如有）+ `cd packages/renderer && npx vitest run` 全绿；dev 实测（P3/P4/P5 探针）：流式期 md.render 入参 = tail 段、稳定边界单调不减、mermaid/fence 流式期重渲 ≈0；降级仅发生在超大单行等预期形态。
- **关联裁决**：R-19。

### W24 — matcher 缓存 + 短路径直通（阶段 4）

- **目标**：D7-1 matcher mtime 缓存——**按单个 .gitignore 文件 `(path, mtimeMs, size)` 作 key（05 §3.3 D7-1 审查修正定案）**；不按调用方目录集合分键——expandDir 传 (cwd,dir) 两目录时按目录分键会使 20 个不同目录产生 20 个不同 key、根 .gitignore 被重读重编译 ~20 次（05 文档已否决该方案）；缓存 miss 路径先 stat 该文件取 (mtime,size) 再决定重读/重编译。+ matchPath 短路径直通（无 `/` 跳过 allPrefixes）。**R-13 后 D7-2 安全条件剪枝不做，现状剪枝语义不动**。
- **文件**：`services/file-service.ts`（loadMatcher 加缓存）、`infra/fs/ignore-parser.ts`（短路径直通）+ 新增缓存/剪枝行为测试。
- **注意事项**：V2 的 strace 验证在 macOS 不可用，改日志打点（.gitignore 读取/编译次数）；fast-glob 有真实消费点（plugin-rpc-setup.ts:279），**不删依赖**（总纲检查点 5 关闭）；V6 验收措辞对齐「与改造前一致」。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增单测：同一 .gitignore 文件（mtime 未变）二次 loadMatcher 零读盘零编译（spy）；文件 mtime/size 变化后缓存 miss 重读重编译；**expandDir 双目录共享同一根 .gitignore 时命中同一编译结果（单文件 key，读盘/编译计数 = 1）**；短路径 matchPath 结果与全路径展开等价。
- **关联裁决**：R-13。

### W25 — listDir 参数化 + searchFiles 有界并发（阶段 4）

- **目标**：`IFileExecutor.listDir(path, opts?)` 参数化（file entry 的 stat 可跳过——现状 dir entry 已不 stat，minor 消化）；searchFiles 改 8-16 路有界并发。
- **文件**：`infra/fs-executor.ts`、`services/ports/file-executor.ts`、`services/file-service.ts`（walk 信号量化，MAX_SEARCH_RESULTS 截断与 per-dir 容错语义保持）。
- **注意事项**：与 W24 串行（file-service 同文件）；结果顺序「深度优先 + 目录内字典序」收集后排序输出与现状对齐（V1 的 diff 验证）；有界并发下截断时机变化影响以结果集 diff 验证为零。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增单测：listDir withSize=false 时 file entry 无 stat 调用；并发 walk 结果集与串行版 deepEqual（同一目录树 fixture）。
- **关联裁决**：无。

### W26 — session 扫描缓存 + find 合并 + quota（阶段 4）

- **目标**：D9-1——scanPiSessions 目录列举层 1s TTL 缓存 + create/fork/delete/rename 显式失效；**消费方分层（05 §3.3 D9-1 审查修正定案，必须落地）**：TTL 只作用**列表构建消费方**（SessionScanner.listAll / listPersistedSessions，侧栏列表）；**单 session 路径解析消费方必须绕过缓存强制刷新**——分层 API 落在 session-file-utils.ts 扫描入口（force 旁路），调用点透传 force。否则刚落盘 session 的历史/子代理/workflow 查找会在 TTL 窗口内静默返回空（pi 是外部进程写文件，不在显式失效覆盖内，05 D9-1 已论证该路径正确性敏感不可节流）。同 handler 多次 `scanSessions().find()` 合并（**非顺手项**：涉及 session-service 多方法签名，独立 commit）；微项 11（quota 缓存内存层）。
- **文件**：`infra/pi/session-file-utils.ts`（目录缓存层 + force 旁路 API，per-file scanSessionMeta 缓存保持现状 + 微项 9 已改的首行读已在 W20 落地）、`services/session-history.ts`（**路径解析消费方调用点**：:46 `getHistoryFromFile` / :61 `getHistoryTailFromFile` 的 `scanSessions().find()` 透传 force 绕过 TTL——M-3 补入；getSubagents/getWorkflows 等同类按文件路径查找的调用点同批透传）、`services/session/session-lifecycle.ts`（失效点）、`services/session/session-service.ts`（find 合并 + 多方法签名）、`services/session/session-fork.ts`（失效点）、`services/quota-cache.ts`（微项 11）。
- **注意事项**：微项 12（find 合并）总纲标阶段 3，因与 W20 同文件（session-service.ts）冲突调整至本 wave——两 wave 避免同文件并行改动；D9 的 rename 失效点未探明，任务内 grep rename 路径补挂；1s TTL 保证新建 session 落盘后秒级可见（pi 首 assistant 前不落盘是既定行为）；列表构建与路径解析两类消费方的判定以 05 D9-1 的清单为准，实施时 grep `scanSessions(` 全部调用点逐一归类写入汇报。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增单测：1s 内重复 scanPiSessions 目录列举零 IO（spy）；**路径解析消费方透传 force——刚落盘 session 的 getHistoryFromFile 在 TTL 窗口内不返回空（先 fill TTL 缓存再落盘新 session 文件，force 调用仍能查到）**；create/delete 后立即 scan 可见性正确（显式失效）；find 合并后同 handler 单次请求 scan 计数 = 1；quota 重复查询命中内存层。
- **关联裁决**：微项 11/12（阶段调整已述）。

### W27 — D-6.2 命令式 buffer + 版本回放（阶段 4）

- **目标**：scrollback 改 append-only 非响应式 buffer + version（**存 per-session 分区**——R-22）；组件 replay(version) 回放；删 watch(scrollback.length) 与 replayedScrollbackLength；attach 流量控制不做（terminal-service.ts:159-161 保持 no-op）。
- **文件**：`useTerminal.ts`（buffer 结构 + useSessionScopedState 分区 + markRaw）、`TerminalView.vue`（回放重写：unmount/remount 后从分区读回 + replay）、`runtime/src/services/terminal/terminal-service.ts`（如有流控接口适配）。
- **注意事项**：依赖 W14（rAF 队列先就位）+ W09（transient 契约——总纲：D1 transient 是 D-6 第二步前提）；SCROLLBACK_LIMIT（按 chunk）与 xterm scrollback（按行）双层语义在本 wave 定 SSOT 并写汇报（09 待验证 1）；session 销毁经工厂 cleanup 自动释放分区。
- **验收**：`cd packages/renderer && npx vitest run` 全绿；新增单测：切 tab（卸载重挂组件）后 replay 覆盖版本差、无缺漏重复（P-D6-2 脚本化）；PTY 未活时命令入队、alive 后按序 flush；watch(scrollback.length) 已删除（grep 断言）。
- **关联裁决**：R-22。

### W28 — D-7.2 扁平投影 + virtua（阶段 4）

- **目标**：VisibleRow 结构 + projectVisibleRows 唯一投影点；FileView 用 virtua 挂扁平行（virtua ^0.50.0 是既有依赖）；FileTreeRow 改纯行组件（收 VisibleRow，不再依赖 useFileTree 的 expandNode）。
- **文件**：`renderer/src/stores/fileTree.ts`（投影函数 + dirChangeCounts 暴露）、`renderer/src/components/sidebar/FileView.vue`（virtua + 扁平行）、`renderer/src/components/sidebar/FileTreeRow.vue`（递归→单行）。
- **步骤要点**：**第一步 = R-21 排查**：13 个消费文件逐个列出消费的 store 成员，确认落在保持不变的 facet 内；消费了被改形成员的 → 本 wave 内适配并汇报。
- **注意事项**：expandNode/collapseNode/setFilter/toggleShowIgnored/setGitOverlay 全部经投影缓存失效生效；virtua 滚动锚点（展开/折叠行数剧变）dev 实测（09 待验证 2）。
- **验收**：`cd packages/renderer && npx vitest run` 全绿；R-21 排查清单写入汇报（13 文件逐一结论）；dev 实测 P-D7-1：展开 5000 文件目录 DOM 行数 < 200；投影纯函数单测（同树同过滤同展开 → 同输出）。
- **关联裁决**：R-21。

### W29 — 启动编排重排（阶段 5）

- **目标**：D8-1/8-2/8-3——listen 提前（同步迁移 + 服务构造 + setServices + start 保持紧密连续，其余后置）、piVersion 惰性 + app.info 补发、迁移 promise gate（**create/restore/fork 三处**——R-14）。
- **文件**：`index.ts`（重排 + gate + appInfo mutate 补发）、`transport/message-broker.ts`（buildAppInfoMsg 增加 public 入口）、`session-lifecycle.ts`（三处 spawn 前 await migrationReady）。
- **步骤要点**：**⓪ 启动延迟实测分解探针（06 §5 审查补充，⛔ 实施前首步）**：在 `main()` 内 listen 前各段打点（三个同步迁移 / await 迁移A / await 迁移B / getPiVersion 各自耗时），确认被后置项确为可感知主导项；**若实测缩短量 < 100-200ms，重估 D8 是否值得其重排 + gate 注入的风险**（迁移幂等快速常态 no-op 时收益可能仅数百 ms），结论写入汇报再动手。① 保持「三个同步迁移 → 服务构造 → setServices → server.start()」顺序；② 后台初始化块：migrateProviderConfig（存 migrationReady）→ migrateBuiltinExtensions → checkAndAutoUpgrade（**顺序约束：migrateBuiltin 必须在 autoUpgrade 前**）→ getPiVersion → skillRegistry.initGlobal → pluginService.initialize；migrateSettingsSkillsToDiscovery 重排位置按依赖判断并汇报；③ appInfo.piVersion 初始 unknown，getPiVersion 返回后 mutate 同对象 + 补发 app.info。
- **注意事项**：迁移失败已 catch → gate 恒 resolve（不阻塞）；启动时恢复路径（restoreSession）同样过 gate。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；dev 启动验证：/health 就绪时刻显著提前（waitForHealth 日志对比）；版本标签先应用版本后 1-2s 补全（V2）；迁移窗口内抢建 session 行为正常（V3）；gate 三处 spawn 点单测（fake promise resolve 前 create 挂起、resolve后通过）。
- **关联裁决**：R-14。

### W30 — 日志 WriteStream 化（阶段 5）

- **目标**：D10-1/10-2——pi session log 与主日志改 createWriteStream 缓冲写；轮转按写入字节计数（替代 statSync）；退出 flush（SIGINT/SIGTERM + closeLogger）；PiSessionLog 接口形状不变（end 后 write no-op）。
- **文件**：`infra/logger.ts`（单文件：writeLogEntry/createPiSessionLog/rotateIfNeeded/closeLogger）。
- **步骤要点**：① 写流按日期惰性打开；② **轮转顺序必须「end 旧流 → rename → 开新流」**（rename 时流持旧 inode——minor 消化）；③ 退出钩子调 end() 强制 flush，**shutdown 链必须 `await` 写流 `end()`（pi session log 与主日志）完成后再 `process.exit(0)`**——现状 `closeLogger(); process.exit(0)` 同步链必须改等待（06 §3.3 D10-1 定案：pi session log 是 pi 静默卡死的唯一决定性证据，丢尾部几行 = 丢「pi 挂在最后哪一步」的冒烟证据，缓冲写必须与优雅退出 await flush 配套）；④ 字节计数轮转。
- **注意事项**：与 W29 并行（文件不相交）；Electron supervisor kill 若为 SIGKILL 接受丢尾（风险已声明，session JSONL 不受影响）；异常崩溃丢缓冲窗口内几行日志尾部可接受。
- **验收**：`cd packages/runtime && npx vitest run` 全绿；新增单测：退出 flush 后文件尾部含退出前最后条目（fake timers + 临时目录）；轮转触发条件按字节计数；end 后 write 为 no-op；跨天轮转 end→rename→开新流顺序（fs mock 断言调用序）。
- **关联裁决**：无。

### W31 — 构建分割（阶段 5）

- **目标**：D-8——manualChunks 四组（vendor/xterm/shiki/katex）+ 三组件 defineAsyncComponent（SettingsModal/DetailPane/TerminalView）+ AsyncErrorFallback。
- **文件**：`renderer/vite.config.ts`、`AppShell.vue`、`PanelContainer.vue` + 新增 `AsyncErrorFallback.vue`。
- **步骤要点**：**第一步 = 最小构建验证（总纲检查点 6）**：先只加 manualChunks 配置跑一次 `pnpm build`，确认 rolldown 1.1.4 下键名行为（`rollupOptions.output.manualChunks` vs `rolldownOptions.output.advancedChunks`），以实际生效的写法为准，结论写入汇报；② 三组件 defineAsyncComponent + error/loading 组件；③ 产物断言。
- **注意事项**：AsyncErrorFallback 守 xyz-ui 规范（禁原生元素/emoji，loading 用 UI 组件）；PanelContainer 其余条件挂载组件（BrowserPane/SubagentTab/WorkflowTab/CommandDocPanel/GitPanel）逐个评估后决定是否纳入，默认不纳入（评估结论写汇报）；katex css 保持静态 import（字体首屏必需）；markdown-it 不拆组（10 §3.4）。
- **验收**：`pnpm build` exit 0；产物断言（10 §4 A2 口径）：**manualChunks/advancedChunks 配置生效后，首屏入口 chunk 与重依赖 chunk 分离存在（具体 chunk 命名以实施期探针 1 收敛的实际产物名为准，不把 `xterm-*` 等臆测命名固化为硬断言——rolldown 键名未验证）且 xterm 不进主 chunk、不进首屏初始请求集合（Network 首屏无 xterm）**；shiki/katex 分组 chunk 仍在首屏初始请求集合（静态 import，符合 10 §2.2 声明）；主 chunk gzip < 400KB（entry-only 口径，基线 684KB）；shiki 语法 chunk 仍按需分离；Electron loadFile 实测切 tab/开设置三懒加载点功能正常、chunk 首次触发才加载、无 404（file:// 相对路径——10 §3.5）；切英文即时（en-US 不进首屏）。
- **关联裁决**：无（首步验证 = 总纲检查点 6 的关闭动作）。

## §5 全覆盖映射表

### 5.1 19 个决策 → wave

| 决策 | 定案（00 §3.1） | wave | 决策 | 定案 | wave |
|---|---|---|---|---|---|
| D1 | session 级消息单通道 | W06-W09 | D-1 | 消息容器范式 | W10（适配收口 W13） |
| D2 | plugin hook 修复 | W01-W02 | D-2 | token coalescing | W12 |
| D3 | git 异步化 | W16-W18 | D-3 | streaming 惰性派生 | W11 |
| D4 | GitStateService | W16-W18 | D-4 | turn 派生增量化 | W21 |
| D5 | topic 三分类 | W06-W09 | D-5 | markdown 增量渲染 | W22-W23 |
| D6 | 历史增量（纯 runtime，R-11） | W20 | D-6 | 终端两步走 | W14（一步）+ W27（二步） |
| D7 | 文件扫描缓存（R-13 缩围） | W24-W25 | D-7 | 文件树两步走 | W15（一步）+ W28（二步） |
| D8 | 启动编排 | W29 | D-8 | 构建分割 | W31 |
| D9 | session 扫描缓存 | W26 | D-9 | overlay 回写 | W19 |
| D10 | 日志 WriteStream | W30 | | | |

### 5.2 Q1 九项 → wave

| 项 | wave | 项 | wave | 项 | wave |
|---|---|---|---|---|---|
| Q1-1 | W03 | Q1-4 | W04 | Q1-7 | W05（R-24：改 ui 副本 + 删死副本） |
| Q1-2 | W03 | Q1-5 | W04 | Q1-8 | W04 |
| Q1-3 | W03 | Q1-6 | W05 | Q1-9 | W04（core 半）+ W05（renderer 半） |

### 5.3 12 微项 → wave

| 微项（00 §5 表） | 总纲阶段 | 实际 wave | 偏差说明 |
|---|---|---|---|
| thinking_delta contentIndex 透传 | 1 | W07 | 无 |
| contentBlocks.some→布尔标志 | 3 | W20 | 无 |
| stateTypeKey 提模块级 | 1 | W06 | 无 |
| 事件 kind 路由移出 delta 帧 | 1 | W09 | 无 |
| contextWindow 查询缓存 | 2 | W17 | 无 |
| notify 改真 notification | 0 | W02 | 无（与 D2 同文件同批） |
| tool name 索引 Map.get | 0 | W02 | 无（与 D2 同文件同批） |
| numstat 单趟解析 | 2 | W17 | 无 |
| parseSessionHeader 首行读 | 3 | W20 | 无 |
| LRU O(1) 两处 | 2 | W16 | 无 |
| quota 缓存内存层 | 4 | W26 | 无 |
| handler 合并 scanSessions().find() | 3 | W26 | **调整到阶段 4**：评估确认非顺手项（session-service 多方法签名），且与 W20（D6）同文件并行冲突；W20 串行在前、W26 收尾，避免同文件两 wave 交叉 |

### 5.4 7 待验证检查点 → wave

| # | 检查点（00 §5） | 归属 wave | 处置 |
|---|---|---|---|
| 1 | 真实 pi token 到达率（D-2 窗口） | W12 | 验收时 mock 流实测合并率；过窄再评估 rAF 上限（07 §5.4） |
| 2 | D-5 稳定边界阈值（静默时长/长度切点） | W22/W23 | 实施期 dev 实测 tuning（候选 200/300ms、4KB/8KB），不定死在计划 |
| 3 | subagent 虚拟 session 订阅（R8） | W9 | 探针验证；未覆盖则实施 R-04，结论写汇报 |
| 4 | pi `since` 行为与 leafId | W20 | 前置验证脚本四项实测（含 compact 场景），exit 0 才编码 |
| 5 | fast-glob 消费点 | W24（备注） | **已探明关闭**：plugin-rpc-setup.ts:279 动态 import，保留依赖不删 |
| 6 | rolldown manualChunks 行为 | W31 | wave 第一步最小构建验证，结论写汇报 |
| 7 | V1/V5/V6 真实模型可用性 | 各阶段收尾 | 全局验收（00 §4），涉及 wave：W02（V6）、W18/W19（V5）、W10-W13（V1） |

## §6 Wave 间依赖图与执行顺序

### 6.1 依赖图（→ 表示「必须先完成」）

```
阶段 0（并行启动）：W01→W02 ┐
                W03 W04 W05 ┘（三者相互独立，且与 W01/W02 独立）

阶段 1：
  W06 → ┬→ W07 ─┐
        └→ W08 ─┴→ W09
  W09 → W10 → ┬→ W11 ──→ W13
              └→ W12 ──↗（W13 需 W10+W11+W12 全部完成）
  W14、W15 独立（可与 02/07 群并行；W15 需先于 W19）

阶段 2：
  W16 → W17 → W18
  W15 + W18 → W19（D-9 依赖 D-7.1 预聚合 + runtime git 落地）

阶段 3：
  W09 → W20（session-message-handler/session-service 同文件串行）
  W10 → W21 → ┬→ W23
        W22 ──┘（W22 协议对齐 W23 消费方后可与 W21 并行开发；W23 需两者）

阶段 4：
  W24 → W25（file-service 同文件串行）
  W20 → W26（session-file-utils/session-service 同文件序）；W26 与 W24/W25 可并行
  W26 ↔ W29 在 session-lifecycle.ts 上互斥（§6.2），不得并行、须串行执行
  W09 + W14 → W27（transient 契约 + rAF 队列前置）
  W15 → W28（D-7.1 先于 D-7.2）

阶段 5：
  W29、W30、W31 相互独立，可并行
```

### 6.2 同文件互斥约束（并行派发时的硬边界）

并行 wave 之间不得触碰同一文件。经核查的关键互斥对（均已通过依赖序解耦，派发时再复核一次）：

| 文件 | 涉及 wave | 串行序 |
|---|---|---|
| bridge-interop.ts | W02（D2+微项） | 阶段 0 内无并行触碰 |
| session-service.ts | W07→W09→W20→W26 | 依赖链已固化 |
| session-message-handler.ts | W6→W9→W20 | 依赖链已固化 |
| event-interpreter.ts | W02→W09→W18 | 依赖链已固化 |
| plugin-service.ts | W02→W08 | 阶段 0→1 串行 |
| index.ts（runtime 组合根） | W07→W17→W29 | 依赖链已固化 |
| store.ts（core） | W10→W11 | 依赖链已固化 |
| lru.ts / bash-effects.ts | W04→W10/W11 | 阶段 0→1 串行 |
| fileTree.ts / useFileTree.ts | W15→W19→W28 | 依赖链已固化 |
| useTerminal.ts / TerminalView.vue | W14→W27 | 依赖链已固化 |
| useFileChangeInvalidation.ts | W11→W19 | 依赖链已固化 |
| session-file-utils.ts | W20→W26 | 依赖链已固化 |
| file-service.ts | W24→W25 | 依赖链已固化 |
| session-lifecycle.ts | W26↔W29 | 批次顺序兜底：W26 已移出批次 2 并行候选，须与 W29 串行（W29 先或后均可，不得并行） |
| changeset.ts（core） | W10↔W18 | 批次顺序兜底（W10 批次 4 / W18 批次 5，无直接依赖边，靠批次序串行） |
| message-broker.ts | W09↔W29 | 批次顺序兜底（W09 批次 3 / W29 批次 2 或 8，无直接依赖边，靠批次序串行；并行派发时须显式串行） |

### 6.3 推荐执行批次

| 批次 | wave | 说明 |
|---|---|---|
| 1 | W01、W03、W04、W05（并行）+ W02（W01 后接力） | 阶段 0 全量，最多 4 个 subagent 并行 |
| 2 | W06、W14、W15、W24、W29、W30、W31（并行候选） | 若追求最短总工期，阶段 1-5 中无跨层依赖的独立 wave（W14/W15/W24/W29/W30/W31）可提前并行；保守执行则按阶段顺序。**W26 不入本批次**——与 W29 同改 session-lifecycle.ts（§6.2 互斥），不得同批并行 |
| 3 | W07、W08（并行）→ W9 | 阶段 1 runtime 侧收口 |
| 4 | W10 →（W11、W12 并行）→ W13 | 阶段 1 renderer 侧 |
| 5 | W16 → W17 → W18 → W19 | 阶段 2 串行链 |
| 6 | W20、W21、W22（W22 与 W21 并行）→ W23 | 阶段 3 |
| 7 | W24 → W25；W26；W27、W28 | 阶段 4。W26 依赖 W20（同文件序，批次 6 已完成）；W26 与 W29 的 session-lifecycle.ts 互斥（§6.2）靠批次顺序兜底——W29 要么已在批次 2 提前完成、要么在批次 8 晚于本批次，两种路径下均不同批并行 |
| 8 | W29、W30、W31（并行） | 阶段 5（若未在批次 2 提前） |

保守路径（推荐）：严格按阶段 0→5，每阶段内按 6.1 依赖图并行。激进路径：批次 2 的独立 wave 提前，可压缩总工期，但增加同时活跃分支数与 review 负担。

### 6.4 无环论证

依赖图的全部边为：W01→W02；W06→{W07,W08}；{W07,W08}→W09；W09→{W10,W20,W27}；W10→{W11,W12,W21}；{W10,W11,W12}→W13；W21→W23；W22→W23；W16→W17→W18；{W15,W18}→W19；W24→W25；W14→W27；W15→W28；W20→W26（同文件序）。所有边均从小编号指向大编号（或同阶段内单向），拓扑序存在且唯一性不依赖具体实现，无环。

---

## 附录：撰写本计划时的代码事实核验记录

以下事实在本计划撰写期间重新对照源码核实（覆盖验收标准第 6 条要求的 5 处以上抽查）：

| # | 事实 | 核验位置 | 结论 |
|---|---|---|---|
| 1 | selectSession 发 switchSession 后丢弃 reply，且 `!chat.isHydrated(id)` 才另发 getHistory | `packages/renderer/src/composables/features/sidebar/useSidebar.ts:162` 起的 selectSession 函数体 | 一致（R-11 依据） |
| 2 | switch handler 无条件 getHistory 并把 messages 塞进 reply | `packages/runtime/src/transport/session-message-handler.ts:217-250` | 一致（R-11 依据） |
| 3 | registry.ts 内 `messages.value.get` 共 16 行 | `packages/core/src/domain/chat/effects/registry.ts`（grep 计数 = 16） | 一致（R-15 依据） |
| 4 | subagent.stream_delta payload 仅 `{sessionId, recordId, lines}`，无 mainSessionId | `packages/shared/src/protocol.ts`（subagent.stream_delta 条目） | 一致（R-04 依据） |
| 5 | TerminalView 以 `v-else-if` 条件挂载（切 tab 即 unmount） | `packages/renderer/src/components/workspace/PanelContainer.vue:87/93` | 一致（R-22 依据） |
| 6 | searchFiles 已有 matchPath 级目录剪枝 | `packages/runtime/src/services/file-service.ts:207-210`（`if (ignored && !showIns) continue`） | 一致（R-13 依据） |
| 7 | renderer 的 useTurnElapsed.ts 零 import 引用；活跃副本在 ui 包被 Turn.vue:106 消费 | grep renderer/ui 两包 | 一致（R-24 依据） |
| 8 | 07 文档 §3.3 DeltaBuffer 已含 contentIndex 保留定案（「审查补充」段） | `.xyz-harness/2026-08-15-perf/07-state-layer.md`（DeltaBuffer 定义与 429 行理由段） | 一致（R-18 依据：评估引用旧版） |
