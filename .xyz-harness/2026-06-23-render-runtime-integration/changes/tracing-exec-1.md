# 执行计划追踪报告 — tracing-exec-1

**追踪对象**: execution-plan.md（初稿）
**追踪者**: 独立 subagent（上下文隔离，源码验证）
**追踪日期**: 2026-06-24
**结论**: 计划的**并行安全基石成立**（runtime-ready 声明 + 文件互斥均经源码证实），但 **W0 含两个已完成的 stale issue（#2/#8）**，且 **#5/#10 的文件影响清单与源码不符**，需修正后才能安全派遣。

---

## 视角 1：切片独立性

### 结论：无「先全后端再全前端」反模式，但 W0 实际比声称的薄

**无反模式的根因**（源码证实）：绝大多数 feature 的 runtime 侧**已经实现**，所以每个 Wave 的前端工作可即时验证，不存在「等后端建完才能接前端」的串行。具体：

| Issue | runtime 状态（源码验证） | 切片真实形态 |
|-------|------------------------|------------|
| #1 git | **未实现**（protocol 无 git.*，无 git-service/handler/executor 文件） | 真·垂直切片（runtime+frontend 同 Wave 建） |
| #5 ext install | **已实现**（extension-service.ts:314/364/417/476 全部 install 方法 + handler 路由 + IInstaller port + server.ts:130 注册） | 实为**前端单层**，非垂直 |
| #6 compact | **已实现**（message-dispatcher.ts:161 compact + 广播 session.compacting/compacted） | 前端单层 |
| #7 session.list | **已实现**（server.ts:322 broadcastSessionList + session-message-handler.ts:33/40/83 create/delete/rename 触发） | 前端单层 |
| #11 widget | **已实现**（event-adapter.ts:364 handleExtensionUIRequest + :383 setWidget→extension:widget 推送） | 前端单层 |

> 计划对 W1b/W1c/W2b/W2c/W3a/W3b 全部标「切片类型: 垂直切片」，**与源码不符**。只有 W1a（git）是真垂直切片。这不是 bug（前端单层切片同样可验），但标签误导，subagent 会预期不存在的 runtime 工作。

**W0 prefactor 是否真铺路**：是，但**比声称的薄**。
- #12（FileChangeStatus.unmerged 缺失、ExtensionInfo.tools 缺失）→ **真实 gap**，protocol.ts:89 `FileChangeStatus = 'added'|'modified'|'deleted'`（无 unmerged），protocol.ts:343 ExtensionInfo 无 tools 字段。✓ 真铺路。
- #4（mock send 仅 message_start/text_delta/complete 三件套，mock/git.ts 不存在）→ **真实 gap**。✓
- 但 #2、#8（见下 F1/F2）**已完成**，W0 实际只剩 #12+#4。

### Gap

- **D（Decision）— 「垂直切片」标签过度**：6 个 Wave 被标为垂直切片，实际 5 个是前端单层。建议改为「前端切片（runtime 已就绪）」，避免 subagent 误判工作量。

---

## 视角 2：依赖闭合

### 结论：DAG 边基本准确，关键路径成立，但有一条边理由标错

**关键路径 W0→W1a→W2a→W3a**（4 跳）：成立。
- W1g→W2s（SideDrawer 依赖 git）：成立。双重约束——①Panel.vue 文件冲突（#1 加 GitZone、#9 加 SideDrawer 同改 Panel.vue）；②E2E 可验性（W2a 验收「GitZone Diff 按钮→SideDrawer 打开」需 #3 GitZone 存在）。虽 §6.3 点2 明确 SideDrawer 不含 Diff tab，但打开触发源仍依赖 GitZone，依赖合理。
- W2s→W3w（widget 依赖 SideDrawer 容器）：成立（widget 渲染进 SideDrawer.vue）。
- W2c→W3r（retryUI 经 Composer.vue 冲突串行）：成立。

**无遗漏依赖**（逐项核验）：
- #10 依赖 #8(store)+#12(unmerged) → 均在 W0，W0→W1c 边覆盖。✓
- #13 依赖 #8(retryStates/queueStates 访问器) → W0，W0→W3r 边覆盖。✓
- #11 依赖 #9(SideDrawer)+extension.ts → W2s→W3w + W1e→W3w 覆盖。✓

### Gap

- **D（Decision）— W1e→W3w 边理由标错**：计划注明「widget 依赖 SideDrawer 容器 + **Extension 安装**」。但 widget 订阅（#11 onWidget）与 Extension 安装 UI（#5 install）**功能上完全独立**——extension:widget 推送来自 runtime EventAdapter + built-in demo plugin，与用户安装 UI 无关。该边的**真实理由是 extension.ts 文件冲突**（#5 在 W1b 加 install 方法、#11 在 W3a 加 onWidget，同改 extension.ts）。边本身需要（保文件安全），但理由应改为「extension.ts 文件冲突串行」，否则误導执行者以为 widget 需先有安装 UI。

- **D（Decision）— Wave 分配跨文档不一致**：
  - issues.md 依赖关系汇总：`#3 GitZone → W2`、`#9 SideDrawer → W2`
  - code-architecture §6.1：F1 git 拆为「W1 协议+runtime / **W2 前端 GitZone**」
  - execution-plan W1a：把 **#1+#3 合并进 W1a**（runtime+前端 GitZone 同 Wave）
  执行计划把 #3 从 W2 提前到 W1a，**覆盖了两份上游文档且未声明**。这是合理的优化（#3 仅依赖 #1，合并可省一跳、缩短关键路径），但属未记录的偏离。建议在计划中显式注明「#3 从 issues.md 的 W2 提前至 W1a，因严格依赖 #1 且合并可缩短关键路径」。

---

## 视角 3：并行安全（基石核验）

### 结论：三个并行组的文件集**经源码确认互斥**，Composer.vue/extension.ts 串行正确。基石成立。

#### 「runtime 已就绪」声明核验（基石之一）

| 声明 | 源码验证 | 结果 |
|------|---------|------|
| #6 compact runtime 已实现 | message-dispatcher.ts:161 `compact()`，:170 广播 `session.compacting`，:186 广播 `session.compacted`；server.ts:127 路由 `session.compact` | ✅ 真 |
| #7 session.list 广播已存在 | server.ts:322 `broadcastSessionList()`；session-message-handler.ts:33(create)/40(delete)/83(rename) 均调 `ctx.broadcastSessionList()` | ✅ 真 |
| （计划未声明但同样就绪）#5 ext install runtime | extension-service.ts:314/364/417/476 全套方法；extension-message-handler.ts:104/118/132/147 路由；server.ts:130 注册 | ✅ 真（计划反而**低估**了 #5 的就绪度） |
| （计划未声明）#11 widget runtime | event-adapter.ts:364/383 setWidget→extension:widget | ✅ 真 |

> 基石成立：#6/#7 不碰 server.ts，与 #1 git 的 server.ts 并行无冲突——**声明与源码一致**。

#### 文件冲突矩阵核验（基石之二）

| 并行组 | 成员文件集（源码确认） | 互斥？ |
|--------|---------------------|-------|
| **W1** | git{server.ts, Panel.vue, git-service.ts✨, git-message-handler.ts✨, git-executor.ts✨, GitZone.vue✨} ∥ ext{extension.ts, ExtensionPage.vue}（extension-service.ts/handler/runtime 已就绪，无需改） ∥ fileview{**Sidebar.vue**, FileView.vue} | ✅ 互斥 |
| **W2** | SideDrawer{Panel.vue, SideDrawer.vue✨, useSideDrawer.ts✨} ∥ session{useSidebar.ts} ∥ compact{Composer.vue, chat.ts} | ✅ 互斥 |
| **W3** | widget{SideDrawer.vue, extension.ts} ∥ retryUI{Composer.vue, RetryIndicator.vue✨, QueueBubble.vue✨} | ✅ 互斥 |

✨=新建文件。

**串行正确性**：
- Composer.vue：#6(W2c) → #13(W3b)，经 W2c→W3r 边串行 ✅
- extension.ts：#5(W1b) → #11(W3a)，经 W1e→W3w 边串行 ✅
- SideDrawer.vue：#9(W2a 创建) → #11(W3a 改 widget 区)，经 W2s→W3w 边串行 ✅
- Panel.vue：#1(W1a 加 GitZone) → #9(W2a 加 SideDrawer)，经 W1g→W2s 边串行 ✅

> 即便修正 #10 的文件位置（FileView.vue→Sidebar.vue），Sidebar.vue 不被 W1 任何其他成员触碰（#1 改 Panel.vue 非 Sidebar.vue；#5 改 ExtensionPage.vue 非 Sidebar.vue），**W1 仍安全**。

### Gap

并行安全**无实质性破坏**，但有两个文件影响清单失真，会导致 subagent 读错文件：

- **F（Fact）— #10 文件位置标错**：计划 W1c「修改 FileView.vue（数据源切 chat store fileChanges）」。源码：`fixtureFileChanges` 的 import 在 **Sidebar.vue:143**，FileView.vue 本身通过 `props.changes` 接收（数据源无关）。issues.md #10 验收「grep fixtureFileChanges 无输出」也未覆盖 Sidebar.vue。真实改动点：①Sidebar.vue 改为从 chat store 计算 fileChanges（FileView 不变），或②按 §4.8 时序图把 FileView 改为接 sessionId 内部聚合（签名变更）。计划未消解此二选一。

- **F（Fact）— #5 runtime 工作清单失真**：计划 W1b 列「创建 services/ports/installer.ts、services/ports/extension-settings.ts、修改 extension-service.ts、修改 extension-message-handler.ts」。源码：installer.ts / extension-settings.ts **均已存在**，extension-service.ts 的 install 方法**均已实现**，extension-message-handler.ts 路由**均已就绪**。#5 实际是纯前端（extension.ts 补 6 方法 + ExtensionPage 接线），runtime 零改动。

---

## 跨视角汇总：Stale Issue（最大风险）

### F（Fact）— #8 chat store 消息补全：**已完成**

issues.md #8 列「未消费」的 case，源码中**全部已实现**（带 W05-A/W06-B 注释，显系前序 Wave 产物）：

| #8 声称未消费 | 源码实际 | 行号 |
|--------------|---------|------|
| thinking_end（endTime 永不回填） | **已回填** `endTime: Date.now()` | chat-chunk-processor.ts:107 |
| tool_call_update（长时工具无进度） | **已消费** detail 字段 | :172 |
| complete 的 usage（丢弃） | **已消费** `readUsage` 回填 Message.usage | :188（Message.usage 字段 message.ts:129 已存在） |
| auto_retry_start/end（无指示器） | **已写** retryStates（指示器属 #13 UI 层） | :262/:276 |
| queue_update（无 pending 气泡） | **已写** queueStates（气泡属 #13 UI 层） | :285 |

store 访问器 `getRetryState`/`getQueueState`/`getMessages`/`applyFileChanges` 均已在 chat.ts:49-185 实现。

**影响**：W0 #8 是 no-op。W0 验收「chat-chunk-processor 无 default no-op 命中」已天然满足。仅 `responseModel`/`diagnostics` 字段在 Message 类型中不存在（message.ts 无此二字段），但 contract（code-architecture §3.9）也未要求补这俩——属 issues.md #8 描述里的残留陈旧点，非计划 gap。

### F（Fact）— #2 domain 规范化：**已完成**

- settings.ts：无 `getSkills/getAgents/getExtensions` Promise 方法，已是 `onSkills/onAgents/onExtensions/onProviders/onDefaults` 订阅形态（settings.ts:24-28），文件头注释甚至写明「返工前（错误）：getSkills/...全 Promise」。
- config.ts：同样无 get*，已是 listProviders/scanSkills/scanAgents/on*/set*/delete* 规范形态。

**影响**：W0 #2「删 get*」是 no-op。验收「grep getSkills 无输出」已天然满足。

> **W0 实际净内容**：#12（contract，真）+ #4（mock，真）。#2/#8 是 stale 占位。建议从 W0 移除 #2/#8 或显式标注「验证已就绪，仅回归」。

---

## 优先修复清单（按执行风险排序）

| # | 类型 | Gap | 风险 | 建议 |
|---|------|-----|------|------|
| 1 | F | #8、#2 已完成，W0 含 no-op | 中（subagent 空跑、验收标准误导） | 从 W0 移除或标「已就绪·仅回归」 |
| 2 | F | #5 runtime 已就绪，W1b 清单失真 | 中（subagent 误建已存在的 port/方法） | W1b 改为「纯前端」，删除 runtime 创建项 |
| 3 | F | #10 改动点在 Sidebar.vue 非 FileView.vue | 中（subagent 改错文件，fixture 残留） | W1c 文件影响补 Sidebar.vue，消解 FileView 签名二选一 |
| 4 | D | W1e→W3w 边理由标错（非功能依赖，实为 extension.ts 文件冲突） | 低（边仍需保留） | 改边注释为「extension.ts 文件冲突串行」 |
| 5 | D | #3 Wave 分配跨文档不一致（issues/code-arch 说 W2，exec 说 W1a） | 低（exec 的合并是优化） | 计划内显式声明偏离原因 |
| 6 | D | 「垂直切片」标签过度（6 个中 5 个实为前端单层） | 低（工作量误判） | 改标「前端切片（runtime 已就绪）」 |
| 7 | F | Panel.vue 实为 92 行（非「接近 400 上限」） | 低（useSideDrawer 提取仍合理，仅 LOC 理由失效） | §6.3 点5 LOC 论据更新为「架构解耦」 |

**并行安全无需修改**——三个并行组文件互斥 + 串行边正确 + runtime-ready 声明属实，基石成立。修正上述 7 项后计划可安全派遣。
