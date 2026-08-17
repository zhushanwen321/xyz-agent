# Fast Fork / Merge / Handoff 开发计划

> 三痛点（痛点1 快速 fork、痛点2 多分支聚合、痛点3 一键交接）的统一开发计划。
> 设计文档（spec + handoff）已通过业务审查 → 开发审查 → 可靠性审查 → 假阳性修正四轮迭代，两个验证脚本（`verify-merge-extension.cjs` + `verify-merge-rpc-mode.cjs`）实测通过。
> 本文档基于架构分析（共享基础设施 + 依赖图 + 工作量评估）给出批次划分。

## 0. 结论

**分三批，不要整体一起开发。** 理由：
- 痛点1 fork 体验（>800 行 + composer 状态机 + 快捷键）与痛点2/3 的 extension/runtime 改动**几乎无文件重叠**，并行只增冲突
- 痛点2/3 共享三件套但语义独立，并行需先建好 extension 打包机制（否则两人改同一份 extension-service.ts 冲突）
- 用户优先级：fork 是日常高频，handoff/merge 是收尾低频——**批 1 让用户先解脱最高频痛点**

**关键决策**：基础设施**薄铺**——值得一次性建的（避免重复劳动）一次建好，不值得提前抽象的（容易抽错）等做完再抽。

## 1. 共享基础设施（一次性建设）

| 基础设施 | 涉及痛点 | 一次性建？ | 归入批次 | 理由 |
|---|---|---|---|---|
| **A. SessionSummary 字段全加**（parentSession + forkEntryId + handedOffTo + lastMergedAt） | 1/2/3 | ✅ | 批 1 | 零成本（~10 行可选字段），避免三次改 shared/session.ts |
| **B. 磁盘扫描链路扩字段**（SessionHeader + parseSessionHeader + ScannedSessionMeta×2 + scannedToSummary + handedOffTo JSONL append） | 1 + 3 | ✅ | 批 1 | 痛点1（header 字段）+ 痛点3（JSONL append）同一批文件，一次改完避免改两遍 |
| **C. extension 打包机制通用化** | 2 + 3 | ✅ | 批 2 | 现状硬编码"第二槽位"，重构为数组消除技术债，痛点2/3 不用再改 6 处对称字段 |
| **D. lockToolsAndGenerate 公共函数** | 2 + 3 | ❌ 等做完再抽 | — | 两份状态机已演化多轮，现在抽容易抽错 |
| **E. custom_message 消费注册机制** | 2 + 3 | ❌ 按需加分支 | — | event-interpreter 现有范式清晰，加 2 个 handler 更务实 |
| **F. ServerMessageType 加 session.handoffComplete** | 3 | ✅ | 批 2 | handoff 硬需求（broker.broadcast 编译不过） |
| **G. extension-command-orchestrator 基类** | 2 + 3 | ❌ 不抽 | — | merge/handoff 语义差异大，独立服务类更清晰 |

## 2. 依赖图

```
批 1：基础薄层 + 痛点1 fork 主线
─────────────────────────────────
SessionSummary 字段全加（4 个）
磁盘扫描链路扩字段（含 handedOffTo JSONL append）
  │
  ├─→ 痛点1 基础层（§8.1：active 路径 + JSONL header 写 forkEntryId）
  │     ↑ 强阻塞痛点2
  │
  └─→ 痛点1 fork 体验（§8.2-8.5：入口/行为/composer/侧栏/快捷键）
        ↑ 用户最早能用上 fork-to-ask

批 2：extension 打包机制 + 痛点3 handoff（可与批 3 并行）
─────────────────────────────────
extension-service 重构为数组（技术债清理）
electron-builder.yml + postbuild-validate.sh 动态化
protocol.ts 加 session.handoffComplete
  │
  └─→ xyz-handoff-extension.js + handoff-service + formatter + PanelHeader 按钮

批 3：痛点2 merge（可与批 2 并行，强依赖批 1 基础层）
─────────────────────────────────
xyz-merge-extension.js（复用三件套模式）
merge-service + 超时兜底
前端 merge UI（分支选择器 + 串行 loading + 贴 composer）
```

## 3. 批次详细计划

### 批 1：基础薄层 + 痛点1 fork 主线（~2 周）

**目标**：用户能用上 fork-to-ask（高频痛点）+ 基础层就绪解锁痛点2/3。

#### Step 1.0：SessionSummary 字段全加（最先做，TS 编译引导）

**文件**：`packages/shared/src/session.ts:20-44`

加 4 个可选字段：
```typescript
parentSession?: string    // 痛点1：父 session 文件路径
forkEntryId?: string      // 痛点1：fork 锚点 entry id（痛点2 merge 依赖）
handedOffTo?: string      // 痛点3：handoff 后指向新 session
lastMergedAt?: number     // 痛点2：上次 merge 时间（待设计，字段先占位）
```

加完跑 `pnpm typecheck`，TS 会报出所有需要补字段的位置（约 8-10 处），按报错逐个补。

#### Step 1.1：磁盘扫描链路扩字段（active + 磁盘两条路径）

**改动清单**（按 typecheck 报错引导，以下为完整列表）：

**Active 路径**（runtime 内存态）：
- `packages/runtime/src/services/session/types.ts` — IManagedSessionView 加 parentSession? + forkEntryId? + handedOffTo?
- ManagedSession 实现加对应字段
- `session-service.ts:706` toSummary 补字段输出
- `session-lifecycle.ts` forkSession 创建 ManagedSession 时写入 parentSession + forkEntryId

**磁盘扫描路径**（runtime 持久态，⚠️ 容易遗漏）：
- `session-fork.ts:39-46` SessionHeaderEntry 接口加 forkEntryId?（已有 parentSession?）
- `session-fork.ts:137-144` newHeader 写入 forkEntryId（入参已在手，见 useSidebar.ts:458 piEntryId 数据链）
- `session-file-utils.ts:16-20` SessionHeader 接口加 parentSession? + forkEntryId?
- `session-file-utils.ts:24-35` parseSessionHeader 扩展读两字段
- `session-file-utils.ts:272` ScannedSessionMeta 加 parentSession? + forkEntryId? + handedOffTo?
- `services/ports/session.ts:10` ScannedSessionMeta **第二处定义**同步加
- `session-file-utils.ts:329` scanSessionMeta 提取时带上
- `session-scanner.ts:63-81` scannedToSummary 补字段输出

**handedOffTo JSONL append**（痛点3 的持久化，一次做掉避免改两遍）：
- `session-file-utils.ts` 新增 `persistHandedOff(filePath, newSessionId)`，append `{type:'handoff_marker', handedOffTo, timestamp}` 到 JSONL（参照 persistSessionName:204 的 append 模式）
- `session-file-utils.ts` extractSessionName 附近加 `extractHandedOff`（尾读找最后一条 handoff_marker）
- scanSessionMeta 调 extractHandedOff 填入 ScannedSessionMeta.handedOffTo

**验证**：fork 一个 session → 断言 parentSession + forkEntryId 在 active + 磁盘两路径都可见。

#### Step 1.2：痛点1 fork 入口层（§8.2）

- `Turn.vue:248` 放开门控：去掉 `!isSessionActive`，保留 `!isSubagentVirtualId`
- Turn.vue fork 按钮区从 1 个扩成 2 个（fork 后台 + fork 提问），中间 as-sep，accent 高亮
- 每条 assistant hover 都出 fork 按钮（方案 a：trace Block 内挂 action 行，实现时裁决 a/b）
- onForkConfirm 改为接受 entryId 参数

#### Step 1.3：痛点1 fork 行为层（§8.3）

- `useSidebar.ts:466-470` 去掉 panel.split + selectSession（fork 后留在原线）
- 新增 forkSessionAsk(content)（原子 fork + send，失败自动回滚：sessionApi.remove + removeFromList）
- 删除 ForkConfirmModal.vue + Turn.vue 引用 + forkOpen/openFork 清理 + **6 个测试文件 stub 清理**
- 反馈行 transient 渲染（runtime WS 广播 message.forkNotice → 前端临时插入，不持久化）

#### Step 1.4：痛点1 composer fork 模式（§8.4）

- `Composer.vue`（注意：`panel/Composer.vue`，不是 `panel/composer/` 子目录）加 forkMode ref + enterForkMode/exitForkMode
- boxClass 加 fork-mode 三重视觉（accent 边 + glow + 5% 底）
- placeholder / 发送按钮文案切换
- onSend 开头加 forkMode 分支调 forkSessionAsk，发送后 exitForkMode
- Esc 退出（注意与 SessionList/SideDrawer 的 Esc 优先级）
- 切 session 时自动 exitForkMode

#### Step 1.5：痛点1 快捷键 + 后台分支管理（§8.4 + §8.5）

- `Sidebar.vue:363-369` KeymapEntry 加 shift? 字段
- `Sidebar.vue:385` 默认匹配加 shift 守卫（非 shift 项要求 !e.shiftKey）
- keymap 加 ⌘G（forkFromLastAssistant）+ ⌘⇧G（enterForkModeFromLastAssistant）
- composer focus 时禁用全局快捷键
- SessionList.vue 当前 session 下方渲染 ForkGroup 子组件
- ForkGroup：props `{ branches: SessionSummary[] }` + emits `{ select, stop }`，折叠态内部 ref，fresh 高亮
- 分支 session 自身显示"↑ fork 自 [父名]"血缘元信息（SessionItem sub 行）
- 后台分支完成/出错通知（主线反馈行追加 + 侧栏状态点 + 未读角标）

**批 1 验收**：fork-to-ask 端到端旅程（hover → fork 提问 → 打字 → 发送 → 反馈行 + 侧栏新增），streaming 中 fork，⌘G/⌘⇧G 快捷键，后台分支找回（血缘元信息），停止后台分支。

---

### 批 2：extension 打包机制 + 痛点3 handoff（~1.5 周，可与批 3 并行）

**目标**：用户能用上一键 handoff 交接。

#### Step 2.0：extension 打包机制通用化（技术债清理）

- `extension-service.ts:96-99,122-123,238-265` 重构：把 `extensionFilePath` + `systemPromptExtensionFilePath` 改为 `fileExtensionPaths: string[]` 数组
- `electron-builder.yml:53-70` extraResources 改为动态发现（扫描项目根 xyz-*-extension.js）
- `postbuild-validate.sh:136-159` 改为动态校验
- **好处**：痛点2 加 merge extension 时不用再改这 6 处

#### Step 2.1：protocol.ts + 共享类型

- `shared/src/protocol.ts:234-285` ServerMessageType 加 `'session.handoffComplete'`
- ServerMessageMap 加 payload 类型 `{srcSessionId: string, newSessionId: string}`

#### Step 2.2：xyz-handoff-extension.js（复用已验证的三件套模式）

- 项目根新建 `xyz-handoff-extension.js`（~200 行）
- registerCommand('handoff') + setActiveTools + turn_end 状态机 + agent_end 兜底恢复
- before_agent_start 轻约束 + sendUserMessage 带 schema 指令
- HANDOFF_SCHEMA 常量（§3 spec，含 currentBlocker/filesModified[].changeSummary 扩充字段）
- **parameters 必须用 typebox Type.Object**（实测：普通 JSON schema 被静默过滤）
- tool_execution_end 自维护 soSucceeded/soCallCount/latestResult（structured-output hook 交互态没装，必须自带）

#### Step 2.3：handoff-service + formatter

- `packages/runtime/src/services/handoff-service.ts`（~150 行）
- constructor 注入 SessionService（组合根 index.ts，参照 GitService/FileService 先例）
- runHandoff(srcSessionId)：client.prompt("/handoff") → 监听 custom_message 'handoff-result' → svc.create(srcCwd) + svc.sendMessage(newId, formatted) + persistHandedOff + broker.broadcast(session.handoffComplete)
- **时序坑**：getClient(sessionId) 返回 undefined 时抛 "Session not active"——srcSession 的 pi 进程必须内存中存活，runtime 重启后历史 session 需先 restoreSession
- `handoff-formatter.ts`（~80 行）纯函数 formatHandoffToMarkdown + buildActionOrientedPrompt

#### Step 2.4：前端 handoff UI

- `PanelHeader.vue` 加 handoff 按钮（Share 图标）+ loading/cancel UI
- `api/domains/session.ts` 加 handoff(sessionId) 函数（发 ClientMessage session.handoff）
- session-message-handler.ts 加 case 'session.handoff' → handoffService.runHandoff
- event-interpreter.ts 加 handleHandoffResult 分支 + EventInterpreterOptions 加 onHandoffResult opt + 组合根接线
- 前端监听 session.handoffComplete → selectSession(newSessionId) 跳转

#### Step 2.5：验证（补 spec 标注的未覆盖项）

- **abort 取消 + agent_end 兜底**：扩展 verify-merge-rpc-mode.cjs 加取消测试用例（触发 handoff → 调 abort → 确认 agent_end{stopReason:'aborted'} → 工具集恢复）
- **action-oriented 注入产品赌注**：真实场景实测（新 session 收到 handoff 后是否立即执行 nextSteps[0] vs 停下确认）

**批 2 验收**：一键 handoff 端到端（点按钮 → 生成结构化 handoff → 新建空白 session → 注入 action-oriented prompt → 跳转 → 新 agent 接手），生成中取消，源 session 标记。

---

### 批 3：痛点2 merge（~2 周，可与批 2 并行，强依赖批 1 基础层）

**目标**：用户能 merge 多分支结论回主线。

#### Step 3.0：xyz-merge-extension.js（复用三件套 + 已验证的串行模式）

- 项目根新建 `xyz-merge-extension.js`（~250 行）
- registerCommand('merge-branches') + handler 立即 return（**RPC 模式已实测：ack 延迟 1ms**）
- turn_end 事件驱动串行 N 分支 + deliverAs:"steer" 续命
- tool_execution_end 捕获 details
- handler 入口预构建 instruction（fs 读分支 JSONL + 按 forkEntryId 切片 + serializeEntries）
- agent_end / session_shutdown 兜底恢复 SAVED_TOOLS

#### Step 3.1：merge-service + 通信

- `packages/runtime/src/services/merge-service.ts`（~200 行）
- constructor 注入 SessionService
- runMerge(srcSessionId, branches)：client.prompt("/merge-branches <json>") → 监听 custom_message 'merge-result' → 回前端
- **超时兜底**（handler 立即 return 后 runtime 不知何时完成，必须配超时）
- event-interpreter.ts 加 handleMergeResult 分支 + EventInterpreterOptions 加 onMergeResult opt

#### Step 3.2：前端 merge UI

- merge 入口（侧栏分支列表头部"merge 选中"按钮）
- **structured-output 前置检查**：runtime 检测 structured-output 是否安装，未装则 merge 入口 disabled + 引导安装（否则 setActiveTools 锁空集死循环）
- 分支选择器（Popover，列出子分支 + checkbox，默认勾未 merge 的，streaming 中 disabled）
- 串行 loading（每分支一行 spinner + 打勾）
- 贴 composer（引导前缀 + N 份并列摘要）
- 主线处理过程 entry 折叠灰显（污染控制）

#### Step 3.3：lastMergedAt 持久化（待设计项）

- 决定存哪（JSONL append handoff_marker 同款 / meta.json / 内存降级）
- scanner 读回 + scannedToSummary 注入
- merge 成功发送后更新

#### Step 3.4：验证（补 spec 标注的未覆盖项）

- **structured-output 未装场景**：mock 未装状态 → 确认 merge 入口 disabled
- **N>2 压测**：3-5 分支场景的时序稳定性 + ack 延迟
- **handler fs 读阻塞**：N=10 × 大分支的 handler 阻塞时长（spec §4.2 权衡点）

**批 3 验收**：merge 端到端（选分支 → 串行生成摘要 → 贴 composer 引导前缀 → 编辑发送 → 主线聚合），structured-output 未装防护，已 merge 标记。

---

## 4. 关键文件清单（开发直接定位）

### 基础设施层（批 1）
- `packages/shared/src/session.ts:20-44`（SessionSummary）
- `packages/shared/src/protocol.ts:234-285`（ServerMessageType）
- `packages/runtime/src/infra/pi/session-file-utils.ts:16-35`（SessionHeader + parseSessionHeader）+ `:204`（persistSessionName JSONL append 范式）+ `:272-282`（ScannedSessionMeta）+ `:329`（scanSessionMeta）
- `packages/runtime/src/services/ports/session.ts:10`（ScannedSessionMeta 第二处定义）
- `packages/runtime/src/services/session/session-scanner.ts:63-81`（scannedToSummary）
- `packages/runtime/src/services/session/session-fork.ts:38-45`（SessionHeaderEntry）+ `:137-144`（newHeader 写入）

### 痛点1 fork（批 1）
- `packages/renderer/src/components/panel/message-stream/Turn.vue:248,477-483,271`（门控 + onFork + ForkConfirmModal）
- `packages/renderer/src/composables/features/useSidebar.ts:445-473`（forkSession）
- `packages/renderer/src/components/panel/Composer.vue:247-326`（boxClass + placeholder + onSend）
- `packages/renderer/src/components/sidebar/Sidebar.vue:363-404`（KeymapEntry + keymap + matchOverrideKey）
- `packages/renderer/src/components/sidebar/SessionList.vue:10-34`（分组结构）

### extension 打包（批 2）
- `packages/runtime/src/services/extension-service.ts:96-99,122-123,238-265`
- `apps/electron/electron-builder.yml:53-70`
- `scripts/postbuild-validate.sh:136-159`

### custom_message 消费 + 组合根 DI（批 2/3）
- `packages/runtime/src/services/session/event-interpreter.ts:42-85`（EventInterpreterOptions）+ `:184-186`（customStart 分发）+ `:575`（handleSubagentBgNotify 范式）
- `packages/runtime/src/index.ts:137-174`（createAdapter closure）+ `:198-231`（SessionService + GitService/FileService 注入范式）

### 验证脚本（已有可复用）
- `tools/verify-merge-extension.cjs`（V1-V8，--print 阻塞模式）
- `tools/verify-merge-rpc-mode.cjs`（R1-R4，RPC 模式生产方案，ack 1ms）

---

## 5. 未验证风险（实现时必补）

| 风险 | 批次 | 验证方法 |
|---|---|---|
| handoff abort 取消 + agent_end 兜底 | 批 2 | 扩展 verify-merge-rpc-mode.cjs 加取消用例 |
| merge structured-output 未装 | 批 3 | mock 未装 → merge 入口 disabled |
| merge N>2 压测 | 批 3 | 3-5 分支时序稳定性 |
| handoff action-oriented 注入效果 | 批 2 | 真实场景实测（产品赌注，非技术链路） |
| fork streaming 中 JSONL 读取竞态 | 批 1 | parseJsonl 已跳过坏行不崩溃，但 ⌘G 末条 fork + streaming 会静默丢失末尾——实现缓解（回退上一条完整 assistant / 反馈行明示） |

---

## 6. 工作量汇总

| 批次 | 新增文件 | 改动文件 | 代码量级 | 周期 |
|---|---|---|---|---|
| 批 1 基础层 + fork | ~3 | ~18 | 大（>1000 行，含 composer 状态机 + 快捷键 + 反馈行） | ~2 周 |
| 批 2 extension 机制 + handoff | ~5 | ~8 | 中（~580 行） | ~1.5 周 |
| 批 3 merge | ~4 | ~7 | 中-大（~750 行） | ~2 周 |
| **合计** | ~12 | ~33 | ~2300 行 | ~5.5 周（批 2/3 并行可压到 ~4 周） |

## 7. 推荐启动顺序

**第一步**（批 1 Step 1.0）：`packages/shared/src/session.ts` 加 4 个字段 → `pnpm typecheck` → 按报错引导补全所有位置。这是整个计划的基石，30 分钟能看到 typecheck 报错全貌，之后按报错逐个补。
