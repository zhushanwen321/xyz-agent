# MessageStream 编辑钉扎身份锚定（virtua keepMounted 越界崩溃修复）

**一句话结论**：编辑钉扎从「数组索引快照」改为「turn 稳定身份反查」，配编辑源卸载清理与越界钳制，三层消除 virtua keepMounted 渲染 undefined item 的崩溃类根因。

> 层性质声明：本文档当前层 = 技术方案设计；下一层产物 = 可实现的代码改动（文件级任务 + vitest 测试用例）。涉及运行时渲染时序与错误处理，运行时断言附探针（✅已测 / ⛔实施期门）。

---

## 1. 背景目标

SCQA：

- **S（情境）**：xyz-agent 对话流（`MessageStream.vue`）用 virtua `<Virtualizer>` 虚拟列表渲染消息回合（turn）。流式回合与编辑中回合通过 `:keep-mounted` 钉扎恒挂载——流式回合防止滚出视口后 ResizeObserver 断开导致高度不再更新，编辑中回合防止卸载丢失草稿。
- **C（冲突）**：钉扎索引以「数组位置快照」形式长期持有（`editingTurnIdx` 裸 ref），而数组随 session 切换、消息增删随时重排；virtua 对 keepMounted 越界索引无任何防御。
- **Q（问题）**：打包版 0.9.12 用户遇到大量 `TypeError: Cannot read properties of undefined (reading 'kind')` 刷屏，对话流渲染损坏。
- **A（答案）**：钉扎改「turn 稳定身份（turnStableId）反查当前索引」+ 编辑源组件卸载清理 + pinnedIndexes 越界钳制。

**系统是什么**（给不熟悉对话流内部的读者）：用户与 AI 的对话按「回合」组织——一个 user 消息带出若干 assistant 消息构成一个 turn，中间穿插系统通知与 bash 执行块。对话流组件把全部消息分组为 `RenderItem[]`（kind 三态：`turn` / `systemNotice` / `bashExecution`）整体喂给 virtua 虚拟列表；virtua 只渲染视口附近的项（窗口化），但接受一个 `keepMounted: number[]` 索引数组声明「这些位置的项永远保持挂载」。**钉扎 = 告诉 virtua 哪些位置恒挂**；一旦传入越界索引，virtua 内部 `data[index]` 得到 undefined 直接传给渲染 slot，slot 读 `item.kind` 即崩。

**设计目标**：

| 编号 | 目标 |
|---|---|
| G1 | 消除崩溃：任何操作序列（切 session、编辑、流式、fork、后台消息入流）下对话流不再出现 keepMounted 越界渲染崩溃 |
| G2 | 编辑态生命周期正确：编辑态随其组件销毁必然回收，无残留状态 |
| G3 | 钉扎语义正确：钉的始终是「正在编辑 / 流式的那一回合」本身，不是某个数组位置 |
| G4 | 不回归：streaming 钉扎、编辑钉扎的既有功能行为不变 |

**Scope**：

- in：`useStreamingPin` 钉扎派生、`UserBubble`/`Turn`/`MessageStream` 编辑事件链、对应 vitest 测试。
- out：
  - 编辑中切 session 草稿丢失（`draftText` 是 UserBubble 实例状态，Virtualizer 按 `:key="sessionId"` 重建即丢；修复需跨层草稿持久化，属独立问题，本设计只保证不崩、编辑态复位干净）。
  - virtua 升级（0.51.0 渲染循环与 0.50.0 逐字相同，见 §2.4 探针 P2，升级不解决本问题）。
  - `parentElement` 连锁错误的独立修复（它是主错误 render 失败后、virtua 卸载钩子访问未初始化容器 ref 的连锁反应；主错误消除后自动消失的断言由 A1「全程控制台零 TypeError」判据兜底验证——若该错误有独立根因，A1 会暴露）。
  - 向 virtua 上游报告 keepMounted 越界防御缺失（建议随实施附带提交 issue，不阻塞本设计）。

---

## 2. 现状与问题分析

**现状是：编辑钉扎把「数组位置快照」当长期状态持有，编辑源组件又无卸载清理，两者叠加在「切到更短会话」时必然产生越界索引，而 virtua 对越界无防御。**

### 2.1 现状链路

用户看到的行为：点 user 气泡「编辑」→ 气泡变输入框 → 该回合在整个对话流里被钉住，滚动不卸载。

代码链路（编辑钉扎五跳，文件均为当前 dev-0.9.13 分支实况）：

1. `packages/ui/src/features/chat/UserBubble.vue`：实例内部 `editingUserId` ref 记录「正在编辑本气泡的消息 id」；`watch(isEditingThisUser)` 状态翻转时 emit `edit-state-change {editing: boolean}`。清理仅发生在 `cancelEdit()` / `submitEdit()` 两个显式动作，**组件无任何卸载清理**。
2. `packages/renderer/src/components/panel/MessageStream.vue:361`：`onEditStateChange(index, editing)` 把 **slot 闭包捕获的数组索引**写进裸 ref `editingTurnIdx`（初值 -1）。
3. `packages/renderer/src/composables/panel/useStreamingPin.ts`：`pinnedIndexes` computed 聚合 `streamingTurnIdx`（末 turn isStreaming 时的位置）+ `editingTurnIdx`。
4. `MessageStream.vue:40` 模板：`:keep-mounted="pinnedIndexes"` 传给 virtua。
5. virtua（0.50.0）渲染函数：`new Set(keepMounted)` 并入可视范围索引后逐项 `data[index]` 传 slot，**无 index < data.length 检查**。

物理数据流（崩溃路径加粗）：

```
用户点「编辑」
  └→ UserBubble.editingUserId = <msg-id>
      └→ watch 翻转 → emit {editing:true}                [身份存在，但没往上送]
          └→ MessageStream.onEditStateChange(index=29, true)
              └→ editingTurnIdx = 29                      [身份在这里退化为位置快照]
                  └→ pinnedIndexes = [29]
                      └→ :keep-mounted=[29]
                          └→ virtua 渲染 data[29] → Turn   [正常：数组足够长]

用户切到短会话（2 个渲染项）
  └→ Virtualizer :key=session 重建，旧 UserBubble 卸载
      └→ editingUserId 随实例消亡，watch 不触发，无 emit   [清理缺口]
          └→ editingTurnIdx 仍 = 29                        [残留]
              └→ pinnedIndexes = [29]（新 renderItems.length=2）
                  └→ :keep-mounted=[29]
                      └→ **virtua 渲染 data[29] = undefined → slot 读 item.kind → 崩溃**
```

### 2.2 真实失败模式

用户场景（对应打包版 0.9.12 实际报障）：在约 30 个回合的长会话 A 中，点开末回合 user 消息的编辑（`editingTurnIdx=29`）；**不退出编辑**，直接点侧栏一个只有 2 个回合的会话 B。切 session 时 `MessageStream` 组件实例被复用（无 `:key`），`Virtualizer` 因 `:key="sessionId"` 整体重建，旧 `UserBubble` 卸载——但没有 `onUnmounted` 清理、`watch` 随作用域失效不触发，`editingTurnIdx` 残留 29；会话 B 的 `renderItems.length=2`，`pinnedIndexes=[29]` 越界，virtua `data[29]` 为 undefined，slot 读 `item.kind` 崩溃。

崩溃后 Vue 组件树保持损坏态，每次响应式更新（消息流入、再次切 session）都重试渲染、再次崩溃——用户侧看到同一堆栈反复刷屏（与报障「很多报错」吻合）。此外 virtua 卸载钩子中的 `requestAnimationFrame` 回调访问未成功挂载的容器 ref，抛出次生 `Cannot read properties of undefined (reading 'parentElement')`——纯连锁错误。

### 2.3 根因分析

根因不是「少了一个 if」，而是**索引的身份误用**：`editingTurnIdx` 要表达的语义是「正在编辑的那个回合」，实现上却持有「某次渲染时的数组位置」。位置是快照、会过期；身份（这条消息本身）不会。

代码库内同类问题已有先例与既定解法——**[M5 stable-key]**（`packages/core/src/domain/chat/message-turns.ts:90-108`）：虚拟列表项 key 曾用 `MessageTurn.index`（每次从 0 重算的序号），消息插删导致 key 平移、组件状态串台；改为 `turnStableId`（回合首条消息 id：`user?.id ?? assistants[0]?.id ?? notices?.[0]?.id`）后 key 恒稳定。本设计将同一原则应用到 keepMounted 钉扎维度：**钉扎按身份声明，索引只在钉扎派生那一刻由当前数组反查得出**。

### 2.4 事实探针

| # | 断言 | 状态 | 依据 |
|---|---|---|---|
| P1 | virtua 0.50.0 keepMounted 渲染循环无越界钳制 | ✅已测 | 实读 `node_modules/virtua/lib/vue/index.cjs`：slot 调用在 483-486（`l.default({ item: t.data[r], index: r })`，越界时 item=undefined 直传 slot）、keepMounted 并入循环在 506-513（`new Set(t.keepMounted)` 并入可视范围后 forEach 渲染），全程无 index < data.length 检查 |
| P2 | 升级 virtua 0.51.0 不解决 | ✅已测 | npm 下载 0.51.0 比对，该渲染循环逐字相同 |
| P3 | UserBubble 无卸载清理 | ✅已测 | grep 全文件无 `onUnmounted`/`onBeforeUnmount` |
| P4 | `streamingTurnIdx` 同一渲染周期内不越界 | ✅已测（代码事实） | 它是 computed、同步派生自当前 `items`，值恒 ≤ length-1；崩溃索引只能来自 `editingTurnIdx` |
| P5 | 「编辑中切短会话」可稳定复现崩溃 | ⛔实施期门 | 目前是代码级推演。实施第一步必须先写 failing test 复现——复用并**扩展** `MessageStream-kind.test.ts` 的 virtua mock（keepMounted 渲染语义模拟 + Turn/UserBubble 事件链打通，形态见 §5 U0/C3；既有 mock 只收 data、不消费 keepMounted，原样不可能复现越界）；若不能复现，回到本节重审根因链，禁止带疑实施 |

### 2.5 现状错误规格（问题边界清单）

| 编号 | 边界场景 | 现状行为 | 后果 |
|---|---|---|---|
| E-now-1 | 编辑中切 session 且新 renderItems 更短 | `editingTurnIdx` 残留越界 | 崩溃刷屏（本 bug） |
| E-now-2 | 编辑中同 session 数据重排（位置平移但不越界，如 load-more 历史载入使索引整体后移） | 钉住旧位置上的**另一个**回合 | 错钉：不崩，但违反 G3，无关回合被恒挂载、真正编辑中的回合可能被卸载丢草稿 |
| E-now-3 | 编辑组件因其他数据换血卸载（fork 回切、消息删除） | 同 E-now-1 / E-now-2 的清理缺口 | 同上 |

---

## 3. 解决方案

**方案核心一句话：钉扎按身份声明（turnStableId），索引只在派生那一刻由当前数组反查得出；编辑源卸载清理与越界钳制作纵深防御。**

### 3.1 终态（使用者视角先行）

**场景 A（编辑中切会话，原崩溃路径）**：用户在长会话 A 编辑末回合 → 未退出编辑切到短会话 B → B 正常渲染两回合，控制台零 TypeError；切回 A，编辑态已干净复位（气泡恢复展示态；草稿丢失为既有行为，见 §1 out of scope）。

**场景 B（编辑中后台消息入流）**：编辑期间 bash 完成通知 / subagent 流式消息追加进对话流 → 编辑框仍在、无报错、正在编辑的回合始终是唯一被钉扎的编辑项（数组重排时钉扎跟随回合移动）。

**场景 C（流式钉扎，回归保护）**：发起流式回复，期间向上滚动两屏再滚回底部 → 流式内容持续追加（高度测量链路未断），与现状行为一致。

**失败路径与恢复**：终态下钉扎失效的唯一形态是「身份反查失败 → 不钉」（fail-safe，宁可不钉不崩溃）。不钉的后果是回到 virtua 默认的窗口化卸载——流式回合滚出视口时高度测量可能中断，用户滚回底部即恢复；这是降级不是损坏。

### 3.2 方案对比

| 维度 | 方案一：索引 + 两处补丁 | 方案二：身份锚定（推荐） | 方案三：升级 / 替换 virtua |
|---|---|---|---|
| 思路 | 保留 `editingTurnIdx` 索引协议；UserBubble 加 onUnmounted emit false；MessageStream watch sessionId 清零；pinnedIndexes 加 clamp | 编辑状态以 turnStableId 持有（`editingTurnKey: Ref<string|null>`）；pinnedIndexes 每次从**当前** items 反查索引；卸载清理与 clamp 作为纵深防御层保留 | 升级 0.50.0→0.51.0 或换虚拟列表库 |
| 长期架构合理性 | 中：清理纪律治标，「索引快照」本质未变，E-now-2 错钉仍在 | 高：钉扎语义 = 身份，session 切换 / 重排 / 删除下反查失败自动不钉（fail-safe）；与 M5 stable-key 同一原则，代码库内一致 | 低：依赖外部修复，不可控 |
| 短期实现成本 | 低（三处小改） | 中（事件协议 +1 字段、状态类型改 string、反查逻辑；测试设施现成） | 高（回归验证全量虚拟滚动行为） |
| 风险 | 中：未来新增钉扎来源必须各自记得清理，缺一处复发同族 bug | 低：改动集中单链路，`use-streaming-pin.test.ts` 驱动器与 `MessageStream-kind.test.ts` virtua mock 可复用（后者需小扩展：keepMounted 渲染语义模拟 + 事件链打通，见 U0） | 高：P2 探针已否决升级路径 |
| 若用它，§2 的例子会怎样 | 场景 B 中同 session 索引平移时仍钉错回合（E-now-2 不修，违反 G3） | 场景 A/B/C 全部达成 | §2.2 崩溃原样发生（0.51.0 同代码） |

**推荐方案二**。方案一中的卸载清理与 clamp 并非与方案二互斥——它们在方案二中降格为纵深防御层（见 D3/D4），差异核心只在「索引快照 vs 身份锚定」。

### 3.3 关键决策与权衡

**D1 编辑身份选 `turnStableId`，与 `renderKey` 同一身份空间**。
选择：UserBubble emit 的 `turnKey` 即 `turnStableId(turn)`；useStreamingPin 反查时对 kind==='turn' 的项计算 `renderKey(item)` 比对（`t-` 前缀空间）。
被否：`user.id` 直接比对——虽然编辑必发生在 user 气泡，但反查对象是 RenderItem，`renderKey` 已是渲染层统一身份（`t-${turnStableId}` / `s-${message.id}`），再造「第三个身份口径」违反单一权威。
证据：`message-turns.ts:104-108`（renderKey 实现）、M5 注释（key 恒稳定论证）。

**D2 事件协议改为 `{editing, turnKey}`，身份由事件源携带**。
选择：`edit-state-change` 负载从 `{editing: boolean}` 扩为 `{editing: boolean, turnKey: string}`。
被否：MessageStream 收到 editing=true 时用 slot 闭包 index 反查 items[index] 的 key——闭包 index 在异步 / 卸载时刻可能已指向别的项，恰好复刻本 bug 的时序缺陷（位置快照过期）。
理由：谁置位谁携带身份（编辑状态源在 UserBubble），index 参数从协议中删除（不再需要）。

**D3 卸载清理责任在 UserBubble（`onUnmounted`）**。
选择：`onUnmounted` 中若 `editingUserId` 非空，emit `{editing: false, turnKey}` 后再随实例消亡。
被否：MessageStream 在 watch(sessionId) 里清零作为**主清理机制**——只覆盖 session 切换一种卸载路径，同 session 数据换血（E-now-3）不覆盖。（该路径后来以「消费侧防线」定位在 D8 恢复采用——是 D3 之下的纵深防御层，不是替代。）
理由：状态归谁所有，清理就归谁（与 ADR-0049 per-session 状态分区同精神）；MessageStream 只消费事件。
待验证：unmount 时刻父组件监听器是否仍可接收 emit（Vue 卸载顺序预期可达，U2 用组件测试实证，见 §5 检查点 C2）。

**D4 pinnedIndexes 保留 clamp（过滤 `idx >= items.length`）作纵深防御**。
选择：反查已结构性消除本 bug，clamp 兜未来新增钉扎来源的同类错误。
降级语义（E3）：极端时序下最多「少钉一项」，回到 virtua 默认窗口化行为——可接受的降级，clamp 防崩不治病，病根在来源侧的身份/清理纪律。

**D5 `streamingTurnIdx` 维持位置派生，不身份化**。
「末回合在流式」本身就是位置语义（最后那个），computed 同步派生索引恒有效（探针 P4）；对它引入反查是无谓复杂化，违反最小改动。

**D6 草稿丢失（编辑中切 session）不修**：out of scope 声明，防范围蔓延；终态明确「编辑态复位干净」即可。

**D7 Turn.vue 只透传不解读**：`@edit-state-change="emit('edit-state-change', $event)"` 模板不动，仅 emits 类型声明随负载扩展——编排器不解析领域语义。

**D8 消费侧防线：MessageStream 在既有 `watch(props.sessionId)` 中同步置 `editingTurnKey = null`**。
选择：切 session 时无条件清空编辑身份（该 watch 现存于 MessageStream.vue，只做 followToBottom，加一行清零）。
定位：与 D3（谁置位谁清理）不冲突——D3 是状态所有者侧清理，D8 是消费侧防线，与 D4 clamp 同为纵深防御层。它把「session 切换路径的 key 残留」从「依赖卸载 emit 可达性」变为「结构性不可能」，专防 §3.4 E4 描述的最坏情形（清理 emit 不可达 → 回合复现时复活钉扎）。
被否：不加（信任 D3 单层清理）——D3 的 emit 可达性是实施期待验证项（C2），单层依赖违反纵深原则。
语义正确性：切回原 session 时 UserBubble 已是新实例（`editingUserId=null`，编辑态本就复位），保留旧 key 无意义，清零不损失任何合法状态。
幂等性推演：D8 清零与卸载 emit(false) 双重到达顺序无关——`watch(sessionId)` 是 flush:'pre' 先执行，卸载 emit(false) 在重渲染 patch 内同步后至；handler 按 editing 分支置 `null`（见 U3），迟到 emit 与 D8 清零幂等（反向顺序同理）。**关键约束：handler 禁止写成无分支 `editingTurnKey.value = payload.turnKey`**——那样每次切 session 都会上演「D8 清 null → 卸载 emit 迟到置回 turnKey → 回合复现时复活钉扎」，把 E4 从窄窗口扩大为每次切 session 必现，恰好击穿 D8。

### 3.4 终态错误规格

| 编号 | 边界场景 | 终态行为 | 恢复指引 |
|---|---|---|---|
| E1 | UserBubble 编辑态中卸载（session 切换 / 数据换血） | `onUnmounted` emit `{editing:false, turnKey}` → `editingTurnKey` 置 null → 反查失效自动不钉 | 用户重新进入编辑（草稿丢失为既有行为，§1 out of scope） |
| E2 | renderItems 反查 turnKey 不存在（回合不在场） | idx=-1，不入 pinnedIndexes，不渲染任何越界项 | 无需恢复——语义即「该回合不在场，无钉可钉」；回合回来（切回 session）时按需重新进入编辑 |
| E3 | 极端时序下 pinnedIndexes 仍出现越界（假设未来新来源违反纪律） | clamp 过滤，不崩，少钉一项 | 由该来源自身修身份 / 清理纪律；clamp 仅为防崩底线 |
| E4 | 清理 emit 不可达（`onUnmounted`/`onBeforeUnmount` 两级均失效，C2 验证项的最坏情形）且编辑中回合从数据中消失（卸载且 emit 未送达、key 残留），之后回合在同 session 内经数据换血恢复（**中途无 session 切换**——经切走再切回的路径已被 D8 清零结构性消除，见 C2/§3.5） | 复现时反查命中 → **已不在编辑态的回合被复活恒挂载**（多余挂载，不崩，G1 不破；违反 G2/G3）。注意前提是「回合消失」——换血时回合仍在场则按稳定 key 复用根本不卸载、编辑态无缝延续，无本条问题 | 回合复现路径：下次进入再退出编辑即覆盖；回合永久不在场：反查恒 miss 不入 pinnedIndexes，等价 E2 的无害残留，下次任何 session 切换经 D8 清零 |

**多实例边界（split mode）**：MessageStream 在 Panel.vue / SubagentTab.vue 两处挂载均无 `:key`，但 `editingTurnKey` 是实例级 ref、事件链（UserBubble → Turn → MessageStream）按实例闭环——同 session 双 pane 各自独立编辑互不串扰，与现状 `editingTurnIdx` 行为等价，不引入新竞态。

### 3.5 终态数据流

```
用户点「编辑」
  └→ UserBubble.editingUserId = <msg-id>
      └→ watch 翻转 → emit {editing:true, turnKey: turnStableId(turn)}   [身份直达顶层]
          └→ MessageStream.editingTurnKey = <turnKey>                     [持有身份，非位置]
              └→ useStreamingPin.pinnedIndexes（computed，随 items 重算）
                  ├─ 反查：items.findIndex(renderKey === `t-${turnKey}`)  [每次当前数组求值]
                  ├─ clamp：过滤 idx >= items.length
                  └─ streamingTurnIdx（位置派生，不变）
                      └→ :keep-mounted（全部索引有界）
                          └→ virtua 渲染 data[idx] —— 恒为有效项

UserBubble 卸载（session 切换 / 数据换血）
  └→ onUnmounted：editingUserId 非空 → emit {editing:false, turnKey}
      └→ editingTurnKey = null → 反查失效 → 不钉              [E1：无残留]

session 切换（消费侧防线，D8）
  └→ MessageStream watch(sessionId)：editingTurnKey = null
      └→ 反查失效 → 不钉（不依赖卸载 emit 可达性）            [E4 的 session 路径被结构性消除]
```

---

## 4. 验收

**验收主体是三个真实场景（dev 模式 Playwright 黑盒），单测仅作回归护栏；每个场景回溯 §1 目标并带可判定的通过标准。**

真实场景验证在 dev 模式（`pnpm dev` + Playwright 连 `http://localhost:9222`，确认页面 URL 为 `localhost:1420` 防多实例错连）执行，对应 TEST-STRATEGY 三视角中的使用者黑盒视角；控制台报错由 Playwright console 监听采集。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| A1 | 编辑中切短会话（原崩溃路径） | 准备约 30 回合会话 A 与 2 回合会话 B；A 末回合点「编辑」；不退出编辑切到 B；再在 A/B 间往返切换 5 次 | B 正常渲染 2 个回合；全程控制台零 TypeError；切回 A 后编辑态干净复位（气泡为展示态） | G1、G2 |
| A2 | 编辑中后台消息入流 | 会话 A 编辑中途，输入 `!echo hi` 执行 bash（完成通知入流），另让一条流式回复进行中 | 黑盒判据：编辑框仍在且可继续输入；零报错。白盒判据（U3 单测断言，与黑盒分列执行）：数组重排后被钉扎的编辑项索引反查自当前 items，仍钉在编辑中回合上 | G2、G3 |
| A3 | 流式钉扎不回归 | 发起流式回复，期间向上滚动两屏再滚回底部 | 流式内容持续追加到最后完成（无「卡在半截不再更新」）；零报错 | G4 |
| A4 | 打包版冒烟（可选，随下一 beta） | 0.9.13 beta 安装包重复 A1 操作 | 同 A1 | G1（真实产物环境） |

单测回归护栏（实施期完成，非验收主体——单测只验代码符合设计假设，不能替代真实场景）：

- `use-streaming-pin.test.ts` 增补三类用例：身份反查命中（key 在场 → 正确索引）；反查失焦（key 不在场 → 不钉）；clamp（构造越界来源 → 被过滤）。
- `MessageStream-kind.test.ts` 增补：pinnedIndexes 含越界索引时 mount 不抛（复用并扩展该 mock 的 keepMounted 渲染语义模拟与 Turn/UserBubble 事件链打通，形态见 §5 U0/C3；此用例即 P5 探针的 failing test，先红后绿）。
- UserBubble 组件测试：编辑态中 unmount → emit `{editing:false, turnKey}`。

---

## 5. 下一层拆分

**拆分遵循 TDD 先行（U0 复现红 → 并行 U1/U2 → U3 集成转绿 → U4 真实场景终验），五个单元各自挂验收。**

| 单元 | 内容 | justification | 验收挂钩 |
|---|---|---|---|
| U0 | failing test 先行（真复现形态）：扩展 MessageStream-kind.test.ts 的 virtua mock，使其**模拟 virtua keepMounted 渲染语义**——对 keepMounted 数组 ∪ 可视范围的每个索引调用 `slot({item: data[idx], index: idx})`（越界时 item=undefined，与 virtua 实装行为一致）；同时解除 Turn/UserBubble 的无事件 stub（改为可 emit `edit-state-change` 的 stub 或 unstub，chatDepsMock 已有 isActive/editAndResend 可支撑），打通 UserBubble → Turn → MessageStream 事件链。用例：编辑 → 切短会话 → 断言 mount 不抛。确认红 | TDD 探针门（P5）：mock 复现的是崩溃路径本身（slot 收到 undefined item），非「断言派生值有界」的旁路——旁路测的是结论不是崩溃机理 | 单测护栏第 2 条（先红） |
| U1 | `useStreamingPin.ts`：入参 `editingTurnIdx` 改 `editingTurnKey: Ref<string \| null>`；pinnedIndexes 反查（显式 null guard：`editingTurnKey == null` 不反查，不依赖 `'t-' + null` 拼接巧合）+ clamp | 钉扎派生单一归口，纯 computed 可独立单测 | 单测护栏第 1 条 |
| U2 | `UserBubble.vue`：emit 协议 +`turnKey`；`onUnmounted` 编辑态清理 | 谁置位谁清理（D3） | 单测护栏第 3 条 |
| U3 | `Turn.vue` emits 类型扩展；`MessageStream.vue` 状态改 `editingTurnKey` + `onEditStateChange` 适配（index 参数删除；**handler 显式按 editing 分支**：`editing ? turnKey : null`，false 恒置 null，禁止无分支透传 turnKey——见 D8 幂等性推演）+ `watch(sessionId)` 清零（D8） | 协议贯通（D2/D7/D8） | U0 用例转绿 + A1/A2 |
| U4 | 真实场景验收 A1–A3（Playwright） | 使用者黑盒终验 | A1–A3 |

依赖：U0 →（U1 ∥ U2）→ U3 → U4。

文件改动地图：

| 文件 | 单元 | 改动 |
|---|---|---|
| `packages/renderer/src/composables/panel/useStreamingPin.ts` | U1 | 入参类型、反查 + null guard + clamp |
| `packages/ui/src/features/chat/UserBubble.vue` | U2 | emit 负载、onUnmounted 清理 |
| `packages/ui/src/features/chat/Turn.vue` | U3 | emits 类型声明（模板透传不动） |
| `packages/renderer/src/components/panel/MessageStream.vue` | U3 | `editingTurnIdx: ref(-1)` → `editingTurnKey: ref<string\|null>(null)`、handler 适配、`watch(sessionId)` 清零（D8） |
| `packages/renderer/src/__tests__/effects/use-streaming-pin.test.ts` | U1 | 三类新用例（驱动器已有，改喂 turnKey） |
| `packages/renderer/src/__tests__/components/MessageStream-kind.test.ts` | U0/U3 | virtua mock 扩展 keepMounted 渲染语义 + Turn/UserBubble 事件链打通 + 越界崩溃复现用例 |
| `packages/ui/src/features/chat/__tests__/UserBubble.test.ts` | U2 | 新增卸载清理用例；**既有三处 emit 严格相等断言适配**（`toEqual([{editing: true}])` → `toEqual([{editing: true, turnKey: 'u1'}])` 等，167-168/191-192 行附近——协议加字段后原断言必红，属 D2 的连带改动） |

待验证检查点（实施期必须回答，不通过则回设计）：

- C1（U0）：P5 复现是否成立。
- C2（U2）：happy-dom / jsdom 下 `onUnmounted` 内 emit 父组件监听器是否可达；不可达则改 `onBeforeUnmount`（卸载顺序上更早、ref 未清），设计语义不变。两级均不可达时的残余暴露面 = E4 双条件窄窗口（session 切换路径已被 D8 消除），可接受不回炉。
- C3（U0）：virtua mock 扩展的具体形态已在 U0 写明（模拟 keepMounted 渲染语义 + 事件链打通）——mock 必须复现「越界索引 → slot 收到 undefined item」的崩溃机理，而非仅断言派生值有界。
