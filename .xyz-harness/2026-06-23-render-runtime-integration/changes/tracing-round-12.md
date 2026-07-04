# Code Architecture 追踪报告 — Round 12（收敛复核）

> 独立 subagent 隔离追踪产出
> 追踪输入：code-architecture.md、tracing-round-11.md、issues.md、system-architecture.md（+ 交叉验证 spec-w11.md 与实际代码库 protocol.ts / event-adapter.ts / ports/）
> 追踪视角：Round 11 的 11 个 gap 是否解决 + 收敛判定（是否引入新 gap）

## 结论：NOT CONVERGED

Round 11 的 11 个 gap 中，**6 个已解决、1 个证实为伪阳性、3 个部分解决/残留、2 个未解决（阻塞）**，并**新发现 1 个阻塞级 gap**（`message.tool_call_pending` 无生产者）。

不可向下游 `execution-plan.md` 推进，需先修复 3 个阻塞项。

| 类型 | 数量 | 说明 |
|------|------|------|
| 已解决（含 1 伪阳性） | 7 | F-01 / F-04(伪阳性) / F-05 / F-06(仅 consume 侧) / D-01 / D-03，及 F-06 payload 契约 |
| 部分解决 / 残留 | 3 | F-02 / K-01 / D-02（文档清理级，非阻塞） |
| 未解决（阻塞） | 2 | F-03 + K-02（retry/queue UI 链路缺失，延后理由与 spec 矛盾） |
| 新发现（阻塞） | 1 | N-01：`message.tool_call_pending` 无 runtime 生产者，spec FR-2 前提已失效 |

**verdict: FAIL — 需修复 3 个阻塞项（F-03/K-02、N-01）+ 3 个文档清理项后方可收敛。**

---

## 一、Round 11 gap 逐项核验

### ✅ 已解决

#### F-01 — settings.ts & config.ts 缺少 API 契约表 → 已解决
- **Round 11 问题**：§3 只有 git/extension/chat/events 契约表，settings.ts 仅一句话。
- **当前**：§3.5 新增完整的 `config.ts`（13 方法：listProviders/scanSkills/scanAgents/discoverModels/onProviders/onSkills/onAgents/onDefaults/setProvider/deleteProvider/setSkill/deleteSkill/setAgent/deleteAgent）与 `settings.ts`（onProviders/onSkills/onAgents/onExtensions/onDefaults/listProviders/setProvider/getSystem/updateSystem）契约表，并附「规范化约束」：settings.ts 不再暴露 getSkills/getAgents/getExtensions Promise 形态，SettingsModal.vue 改 onMounted 订阅。
- **判定**：RESOLVED。

#### F-04 — git.stage/unstage/commit ack 类型未定义 → 伪阳性（证实已存在）
- **Round 11 问题**：§4.2 用 `reply(ws, id, 'message.status', ...)`，但 §3.8 未定义 `message.status`。
- **代码库核验**：`src-electron/shared/src/protocol.ts:176` 中 `message.status` **本就是已存在的 ServerMessageType**（`'message.complete' | 'message.error' | 'message.status'`）；event-adapter.ts:600 实际生产 `message.status`。§3.8 标题是「Shared Protocol **新增**契约」，正确地**没有**重复定义既有类型。payload 走 `ServerMessageMap` 的 `Record<string, unknown>` 占位（未消费类型的既定机制）。
- **判定**：Round 11 未核对实际 protocol.ts，属伪阳性。RESOLVED（实为非 gap）。附注：`message.status` 语义用于 git 动作 ack 略显宽泛，但类型存在、payload 灵活，非阻塞。

#### F-05 — 时序图异常路径不完整 → 已解决
- **当前**：§4.2 F2 新增独立「异常路径」时序图，覆盖冲突态 / 路径越界 / git CLI 未安装·timeout / session 不存在 四分支；§4.4 F4 新增「异常路径」时序图，覆盖 ensureActive 失败 / client 不存在 / pi engine 错误 三分支。
- **判定**：RESOLVED。

#### F-06 — message.tool_call_pending payload 未明确 → consume 侧已解决（但见 N-01）
- **当前**：§3.8 在 `ServerMessageMap` 中正式定义 `'message.tool_call_pending': { sessionId, messageId, toolCallId, toolName, input }`；§3.8 `ToolCallStatus` 加 `'pending'`。
- **判定**：Round 11 的「payload 未明确」诉求已满足。**但**追踪生产侧发现更深问题，见下文 N-01。

#### D-01 — ExtensionService 声称的 Port 不在目录 → 已解决
- **当前**：§1.2 `services/ports/` 现列 `extension-settings.ts`（extension 启用状态持久化 port）+ `installer.ts`（git clone/npm install port）。
- **代码库核验**：`src-electron/runtime/src/services/ports/` 实际存在 `installer.ts`(1897B) 与 `extension-settings.ts`(2135B)。文档落地。
- **判定**：RESOLVED。**附注（上游漂移，非 code-architecture 责任）**：`system-architecture.md §6.3 Port 清单` 仍只列 ISessionStore/IConfigStore/IPiEngine/IGitExecutor 四项，未含 IInstaller/IExtensionSettings。建议上游同步，但不阻塞 code-architecture 收敛。

#### D-03 — Panel.vue LOC 风险未评估 → 已解决
- **当前**：§6.3 点 5 明确「Panel.vue 现有 template 接近上限，加 GitZone + SideDrawer 触发可能超 400 行；建议将 SideDrawer 打开/钉住/tab 控制提取到 `composables/features/useSideDrawer.ts`，Panel.vue 仅作 slot 容器」；§1.1 已列 `useSideDrawer.ts`。
- **判定**：RESOLVED。

---

### ⚠️ 部分解决 / 残留（文档清理级，非阻塞）

#### F-02 — mock/git.ts 未进入目录清单 → 残留（上游冲突未收敛）
- **Round 11 问题**：§1.1 `api/mock/` 只列 4 文件，mock/git.ts 仅在 §6.3 待确认项。
- **当前**：§1.1 `api/mock/` **仍只列** index.ts/data.ts/settings-data.ts/composer-data.ts；§6.3 点 4 仍把它放在「需要编码前确认的点」。
- **上游冲突 surfaced**：
  - `issues.md #4 方案 A` 明确「`mock/git.ts` 新建（~50 LOC）」（独立文件）。
  - `spec-w11.md G-R2-07` 却写「补 mock git.*（**FR-12 执行时补 mock/index.ts git domain**）」（并入 index.ts）。
  - code-architecture.md 自相矛盾：§1.1 index.ts 注释「补完整流式剧本+git fixture」暗示并入 index.ts（贴合 spec），§6.3 点 4 又说「提供 mock/git.ts」（贴合 issues.md）。
- **代码库核验**：`src-electron/renderer/src/api/mock/` 当前无 git.ts，index.ts 无 git 引用（待建）。
- **判定**：PARTIALLY RESOLVED。需收敛 mock git 的落点（独立文件 vs 并入 index.ts），并同步 §1.1 目录与 §6.3。

#### K-01 — SideDrawer tab 集合与 spec 矛盾 → 主链路已修，§6.3 残留矛盾
- **Round 11 问题**：§6.3 列「Terminal/Browser/Diff」，spec FR-8 明确不含 Diff tab。
- **当前**：
  - §4.10 F10 **已正确对齐 spec**：props `activeTab: 'terminal'|'browser'`（无 Diff）；时序图显式标注「用户点击 Diff 按钮（**触发源，不含 Diff tab**）」；数据流「tab 切换 Terminal/Browser」。
  - 但 §6.3 点 2 **仍写**「Terminal / Browser / Diff（Diff 只展示文件列表，不含审批）」——与 spec FR-8（「不含 Diff tab」）、Scope #8（「含 Terminal/Browser tab；Diff 审批内容排除」）、AC（「含 Terminal/Browser tab」）以及自身的 §4.10 **三重矛盾**。
- **判定**：MOSTLY RESOLVED。残留 §6.3 点 2 未清理。修复：改为「Terminal / Browser」（删除 Diff）。

#### D-02 — git status 解析职责边界模糊 → 文件位置已定，访问路径仍含糊
- **Round 11 问题**：§4.1 仅写「GitService 内部 parseGitStatusPorcelain」，未明确适配函数/文件位置。
- **当前**：§1.2 `infra/` 现列 `git-status-parser.ts # 复用 reconciler 解析 git status（#1 新建）`，文件位置已明确，贴合 spec FR-12 G-R2-06「新建 git-status 适配函数（复用 reconcileFileChanges 的 parseGitStatusPorcelain + 扩展 xyToStatus）」。
- **代码库核验**：`parseGitStatusPorcelain` 现位于 `infra/pi/file-change-reconciler.ts`，新 parser 将复用它。
- **残留张力**：
  1. §2 Import 规则「runtime services 不直接 import infra，必须经 ports」；但 §5.1 称解析「全部隐藏」在 GitService，§4.1 时序图写 `GS->>GS: parseGitStatusPorcelain`（GitService 内部解析）。若 parser 在 `infra/git-status-parser.ts`，GitService 直接 import 即违反规则；若解析留在 GitService，则 §1.2 的 `git-status-parser.ts` 与 §5.1 的「隐藏在 GitService」语义重叠不清。
  2. spec G-R2-06 把 status（走 adapter 函数）与 stage/unstage/commit（走 IGitExecutor）分两条路径，但 code-architecture 未说明 GitService.getStatus 如何在不违反 import 规则的前提下拿到解析结果（经 IGitExecutor 返回解析后数据？还是 parser 作为纯函数例外？还是新增 port？）。
- **判定**：PARTIALLY RESOLVED。文件位置已定（Round 11 字面诉求已满足），但 GitService→parser 访问路径与分层规则的兼容性需一行说明。

---

### ❌ 未解决（阻塞）

#### F-03 + K-02 — retry/queue UI 链路缺失，延后理由与 spec 矛盾

两 gap 同源（store 数据层已做、UI 消费层缺失），合并判定。

- **Round 11 问题**：F-03 指出 §4.7 只覆盖 store 消费，无 store→UI 时序图/契约；K-02 指出 issues.md #13（P3 迷雾）与 spec In-scope #3/#4（P1 核心）优先级冲突，code-architecture 未以 P1 重视度给完整 UI 链路。
- **当前 code-architecture 处理**：§4.7 末尾加了一段说明，把 UI 指示位「延后到 #13 P3 迷雾，本轮不进入具体 Wave，**待 UI 形态确认后补时序图**」。
- **为什么仍未解决（双重问题）**：
  1. **延后理由虚假**：spec-w11.md **已经确认 UI 形态**——C10 决策「retry/queue UI | Composer 上方独立行 | 对齐 panel/spec.md:52」、FR-3/FR-4、AC「steer/followUp 提交后 Composer 上方独立行显示 pending 气泡；auto_retry 时同位置显示重试指示位」。code-architecture §4.7 自己都写出了「Composer 上方独立行」，却仍以「待 UI 形态确认」为由延后，自相矛盾。
  2. **静默降级 spec AC**：issues.md 是 spec 的下游（chain: spec-w11 → system-arch → issues → code-arch），却把 spec 的 P1 in-scope（含 AC、C10）降级为 P3。code-architecture 跟随 issues.md #13 静默降级一项 spec 验收标准，未将 spec↔issues.md 冲突显式表面化。
- **代码库核验**：event-adapter.ts:523/537/550 实际生产 `auto_retry_start`/`auto_retry_end`/`queue_update`——**数据有生产者**，store 层（#8）也有消费，缺的仅是 store→UI（Composer 上方独立行 RetryIndicator/QueueBubble）这一段链路。补这段时序图成本极低（形态已知）。
- **判定**：NOT RESOLVED（阻塞）。需二选一：(a) 按 spec C10/FR-3/FR-4/AC 补 store→UI 链路时序图（Composer 上方独立行消费 `getRetryState`/`getQueueState`）；或 (b) 显式标注 spec↔issues.md 优先级冲突为待裁决项，不得以虚假理由静默延后。

---

### 🆕 新发现 gap（阻塞）

#### N-01 — `message.tool_call_pending` 无 runtime 生产者（spec FR-2 前提已失效）

- **现象**：
  - `protocol.ts:175` 将 `message.tool_call_pending` 保留在 ServerMessageType 联合中。
  - 但 **runtime 实际不生产它**。`grep -rn "tool_call_pending" src-electron/runtime/src/` 无任何生产点；event-adapter.ts 的 emit 清单（tool_call_start:144 / tool_call_update:502 / tool_call_end:311 / auto_retry_start:523 / auto_retry_end:537 / queue_update:550 / status:600 …）**无 tool_call_pending**。
  - `event-adapter-extension.test.ts:14/153/171` 明确：「Original mapping of confirm/select to `message.tool_call_pending` is **REMOVED**」「does NOT produce `message.tool_call_pending` for confirm/select」——该映射已被**有意移除**，测试反向断言不生产。
- **根因**：`message.tool_call_pending` 原本绑定 tool **confirm/select（审批/选择）**；本轮 spec 将「工具审批链路」列为 Out-of-scope（「❌ 工具审批链路 tool.approve/deny/always_allow + ConfirmRequest UI」），故 confirm/select→tool_call_pending 的生产被移除。
- **对 code-architecture.md 的影响**：
  - spec FR-2 / G-002 仍要求「chat-chunk-processor 补 `case 'message.tool_call_pending'`」「执行时读 event-adapter 生产侧确认字段」——**前提已 stale**（生产侧已删）。
  - code-architecture §3.8 为它定义了 payload `{sessionId, messageId, toolCallId, toolName, input}`，§4.7 F7 加了 consume 分支（`toolCalls.push({...status:'pending'})`），`ToolCallStatus` 加 `'pending'`——**全部消费一条永远不会到达的消息**。store case 是死代码，`ToolCallStatus.pending` 不可达，spec AC「`message.tool_call_pending` 有 store case + ToolCallStatus 含 pending」会因 case 存在而形式上通过，但功能不生效。
- **Round 11 为何没发现**：Round 11 的 F-06 只看 consume 侧（payload 是否定义），未追踪 produce 侧。本轮收敛复核补了 produce 侧追踪，方暴露。
- **判定**：NEW GAP（阻塞）。需二选一：(a) 若确实需要 pending 语义，需在 event-adapter **重新引入生产点**（但这与「审批 Out-of-scope」冲突，需重新定义 pending 的触发场景）；或 (b) **从本轮移除 FR-2 / `message.tool_call_pending` consume case / `ToolCallStatus.pending`**，承认 spec FR-2/G-002 前提失效，同步修订 code-architecture §3.8/§4.7/§4.11 与 spec。不得保留死代码消费。

---

## 二、收敛判定

**NOT CONVERGED。**

阻塞项 3 个：
1. **N-01**（新）：`message.tool_call_pending` 无生产者——整条 FR-2 切片（payload + store case + ToolCallStatus.pending）建在 stale 前提上，非功能性。
2. **F-03 + K-02**：retry/queue UI 链路缺失，且以虚假理由（「待 UI 形态确认」，而 spec C10 已确认）静默降级一项 spec AC。

文档清理项 3 个（非阻塞，建议一并修）：
3. **K-01 残留**：§6.3 点 2 仍列 Diff tab，与 spec FR-8 及自身 §4.10 矛盾，改为「Terminal / Browser」。
4. **F-02 残留**：mock git 落点上游冲突（spec G-R2-07 并入 index.ts vs issues.md #4 独立 mock/git.ts），code-architecture 自身 §1.1 注释与 §6.3 点 4 不一致，需收敛并同步目录。
5. **D-02 残留**：GitService→`git-status-parser` 访问路径与「services 不直接 import infra」规则的兼容性未说明，补一行。

---

## 三、已确认对齐项（无回归）

Round 11 列出的 9 项已对齐决策本轮复核无偷改、无回归：git 全栈 IGitExecutor（#1）、GitZone 独立组件（#3）、Extension 内联候选（#5）、compact slash command（#6）、session.list onGlobalType（#7）、FileView 聚合 chat store（#10）、widget session 通道（#11）、git-zone 独立真实 status（C12）、unmerged 由 runtime 推（C15，event-adapter.ts file_changes + git.status 双路径）。其中 auto_retry/queue_update/file_changes/thinking_end/tool_call_update/complete 的**生产者均经代码库核验存在**（event-adapter 实际 emit），唯独 tool_call_pending 无生产者（见 N-01）。

---

## 四、修复后可收敛的最小动作清单

| # | 动作 | 对应 gap | 阻塞? |
|---|------|---------|------|
| 1 | 裁决 `message.tool_call_pending`：重引入生产 or 从本轮移除 FR-2 切片；同步 §3.8/§4.7/§4.11 与 spec | N-01 | 是 |
| 2 | 补 retry/queue store→UI 链路时序图（Composer 上方独立行），或显式标注 spec↔issues.md 冲突待裁决 | F-03/K-02 | 是 |
| 3 | §6.3 点 2 删除 Diff tab | K-01 | 否 |
| 4 | 收敛 mock git 落点，同步 §1.1 目录与 §6.3 点 4 | F-02 | 否 |
| 5 | §4.1/§5.1 补一行 GitService→git-status-parser 访问路径说明 | D-02 | 否 |
| 6 | （上游）system-architecture.md §6.3 Port 清单补 IInstaller/IExtensionSettings | D-01 附注 | 否 |

完成 #1、#2 后即可重新提交追踪；#3–#6 建议同批清理但不卡收敛。
