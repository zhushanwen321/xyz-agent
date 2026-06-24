---
verdict: pass
topic: render-runtime-integration W11+（收尾闭环 + 后端能力对接 + Side Drawer）
predecessor: waves.md（W01-W10 已全部完成，commit e05bbdf7→2584ed5f）
---

# 前端↔runtime 集成第二轮 Wave 计划（W11+）

> **状态：** spec 初稿（2026-06-24），待 5 视角追踪。
> **输入：** 全景 gap 分析（5 路 Explore agent）+ W01-W10 落地核验（精准 grep）+ 5 轮澄清决策。
> **性质：** W01-W10 是「类型地基 + 主路径对接」；本轮是「收尾闭环 + 盘活后端沉没成本 + Side Drawer 架构容器」。

## Background

W01-W10 已完成 ServerMessageMap 类型地基、session.list 分组、Markdown 渲染、Composer 4 接线、消息流 19 个 message.* case 的 store 接入、Settings 核心 CRUD、file_changes 全链路。

但全景扫描 + 核验发现仍有三类残留缺口：
1. **收尾闭环**——store 已入库但无 UI 消费（retry/queue）、硬漏接（tool_call_pending）、mock 流式盲区（三件套导致已实装渲染在 mock 模式看不到实时效果）、确认事件未订阅（session.list server-push）。
2. **后端就绪能力闲置**——Extension 安装/卸载（6 命令）、compact 压缩（命令+dispatcher+协议全齐）、Terminal/Browser widget（推送就绪 0 订阅）。
3. **架构级容器缺失**——右抽屉 Side Drawer 零实现，阻塞 widget 呈现。

## Scope boundaries

### In-scope（12 项）
1. mock `send` 补全套流式事件（固定剧本）
2. `message.tool_call_pending` store case 补全（硬漏接修复）+ ToolCallStatus 扩 'pending' 枚举
3. auto_retry UI 指示位（store 有数据，Turn.vue 未消费）→ Composer 上方独立行
4. queue_update pending 气泡（store 有数据，无 UI 消费，违背 panel/spec.md:52）→ Composer 上方独立行
5. Extension 安装/卸载流程对接（extension.ts 加 install/uninstall/installDir/installGit/finishInstall/cancelInstall，ExtensionPage 接按钮 + 候选选择 UI）
6. compact 压缩触发（经 slash command 触发；session domain 加 compact，订阅 compacting/compacted）
7. Terminal/Browser widget 对接（extension domain 加 onWidget/onStatus 订阅 **走 session 通道 events.on(sessionId)**，消费 extension:widget/extension:status）
8. 右抽屉 Side Drawer 容器（**git-zone Diff 按钮触发打开**；含 Terminal/Browser tab；Diff 审批内容排除但 git-zone 是触发源）
9. session.list server-push 全局订阅（onGlobalType，runtime 增删会话实时刷新 Sidebar；**不重载全量历史**）
10. FileView 切到 message.file_changes 聚合（**跨回合并集**，从直读 mock fixture 改为聚合 chat store 所有 assistant 的 fileChanges）
11. 契约裂缝修复（ExtensionInfo 补 tools[dirName 已在]；FileChangeStatus 补 unmerged[前端标注]）
12. **git-zone 加回**（panel/spec.md zone ⑤，前端重构时错误移除）—— 四态展示 + 分支/stats/pill + **后端新建 git.* 命令协议**（stage/commit/unstage/status）

### Out-of-scope（本轮明确不做，沿用 waves.md D1-D10 边界）
- ❌ Session Tree（tree-data/navigate/fork/clone/capability）—— Flow-3 范畴
- ❌ 工具审批链路（tool.approve/deny/always_allow + ConfirmRequest UI）
- ❌ **Diff 代码审查审批**（Diff Tab + ChangeSet Accept/Reject）—— 含在审批排除边界内
- ❌ Plugin 管理（维持 deferred，spec 原标「独立第 6 菜单」）
- ❌ SubAgent 多 agent 编排
- ❌ @-mention/#文件/SearchModal 数据源（无 search/LSP 后端接口，协议级缺口）
- ❌ Overview 统计卡/timeline（无 overview 后端命令）
- ❌ 附件上传（协议缺口）

## Functional Requirements

### FR-1 mock 流式事件补全
mock `send` 当前只发 message_start/text_delta/complete 三件套。补全套固定剧本：发送后先 thinking_start→delta→end，再 text_delta 流式，中间穿插一个 tool_call_start→update→end，最后 file_changes（accumulating→ready），complete。另补 queue_update/auto_retry 的 mock 推送（steer/followUp 后推 queue_update）。让 #3/#4 的 UI 消费能在 mock 验证。

### FR-2 tool_call_pending 修复
chat-chunk-processor.ts:355 的 default 分支补 `case 'message.tool_call_pending'`，写入 ToolCall.status='pending'。

### FR-3 auto_retry UI 指示位
Turn.vue 或 Composer 上方加 RetryIndicator，消费 `chat.getRetryState(sessionId)`，显示重试中 + attempt/maxAttempts。

### FR-4 queue_update pending 气泡
Composer 顶部或消息流加 pending 气泡，消费 `chat.getQueueState(sessionId)`，显示 steer/followUp 排队内容（靠右虚线脉冲，对齐 panel/spec.md:52）。

### FR-5 Extension 安装/卸载
extension.ts 补 6 个动作方法；ExtensionPage 的安装按钮接 handler，卸载确认接 uninstall；多步安装流（installDir/installGit→discovered 候选→finishInstall/cancelInstall）完整对接。

### FR-6 compact 压缩
session domain 加 `compact(sessionId)`；Composer 工具条或 Header 加「压缩」按钮；订阅 session.compacting/compacted 显示状态（与已有的 compactionSummary system 行区分——后者是 pi 主动压缩摘要，本项是用户主动触发）。

### FR-7 Terminal/Browser widget 对接
extension domain 加 `onWidget(handler)` / `onStatus(handler)` 订阅 extension:widget/extension:status（payload 已精确化）；widget 内容渲染到右抽屉 Terminal/Browser tab。

### FR-8 右抽屉 Side Drawer 容器
新建 SideDrawer 容器组件（侧拉抽屉，开/关/钉住态），作为 Terminal/Browser/进度聚合的呈现位。不含 Diff tab。对接 panel/spec.md 的单/双模式 + Drawer 触发。

### FR-9 session.list server-push 订阅
events 层加 session.list 的全局订阅（或 useSidebar 订阅 dispatch），runtime broadcastSessionList 时实时刷新 Sidebar 列表。

### FR-10 FileView 数据源切换
FileView 从 `import { fixtureFileChanges }` 改为聚合 `chat store` 里 active session 末条 assistant 的 fileChanges 成树。补 U（unmerged）标注 + 行数 +N/-N + 树内过滤框（对齐 draft-file-view.html）。

### FR-11 契约裂缝
shared/src/protocol.ts ExtensionInfo 补 **tools 字段**（dirName 已在 protocol.ts:346，无需补；前端 SettingsModal 已用本地 ExtensionItem 桥接 tools，统一回 shared）；FileChangeStatus 补 'unmerged' 枚举（v3 要 U 标注，**由前端标注，runtime 不推 unmerged**——基于 git 对账在前端侧判定）。

### FR-12 git-zone 加回（panel/spec.md zone ⑤）—— 含后端 git.* 命令
前端 Panel.vue 重构时错误移除了 git-zone（Panel.vue:5 注释「git-zone 已移除」），违反 v3 SSOT（panel/spec.md:30 + draft-companion-zones.html §2 四态完整设计）。本项按设计稿加回 + 新建后端 git.* 命令。

**核心定位（C12 + G-R2-03 决策）：** git-zone 显示**真实 git 全量状态**（独立于 message.file_changes）。file_changes 是 per-turn agent 改动（ChangeSetCard/FileView 用），git-zone 是 cwd 实时 git 状态（含用户手改、IDE 外操作）。二者语义不同，各管各的。

**前端：**
1. Panel.vue 恢复 zone ⑤ git-zone（composer 下方，与 progress-zone/composer 共享 composer-band 视觉带）
2. 新建 GitZone.vue：四态展示（干净/已暂存/有 diff/冲突）—— 分支显示 + stats（+N/-N）+ 状态 pill（clean 绿/staged 绿/conflict 红）+ 冲突态 danger 竖条 + soft 渐隐底
3. 暂存/取消暂存按钮调 git.stage/git.unstage；提交按钮弹**简单 message 输入框**（可选 message，C-G-R2-02）调 git.commit；Diff/解决冲突按钮触发 SideDrawer 打开（Diff 审批内容排除，但按钮是触发源）
4. git 数据源：调后端 git.status；**刷新时机（G-R2-04）**：进入 session 时 + agent_end 后 + stage/unstage/commit 操作后手动刷（非轮询，无 filesystem watch）

**后端 git.* 命令协议（新建）：**
1. shared/src/protocol.ts：
   - ClientMessageType 加 `git.status` / `git.stage` / `git.unstage` / `git.commit`
   - git.status payload `{ sessionId }`；git.stage `{ sessionId, filePaths?: string[] }`（空=git add -A）；git.unstage `{ sessionId, filePaths?: string[] }`；git.commit `{ sessionId, message?: string }`（可选，空用 git 默认）
   - ServerMessageType 加 `git.status:result`，payload `{ sessionId, isRepo: boolean, branch?, stagedCount, unstagedCount, stats: {add,del}, hasConflict, files: GitFileStatus[] }`（GitFileStatus = {path, xyCode, status: added|modified|deleted|unmerged|renamed|untracked}）
2. runtime 新建 git-message-handler.ts（参考 extension-message-handler.ts 结构）：git.status → reconcileGitStatus(cwd)；git.stage/unstage/commit → IGitExecutor
3. server.ts 路由注册 git.* 到 handler（routes Map:124-132）
4. **port 复用策略（G-R2-06 + H-R3-01）**：status **新建 git-status 适配函数**（复用 reconcileFileChanges 的 parseGitStatusPorcelain 解析基础 + 扩展 xyToStatus 加 U/staged 拆分 + 调 readGitInfo 取 branch + 另跑 git diff --numstat 取 stats，**非直接复用 reconcileFileChanges 返回值**——其 FileChange[] 缺 branch/isRepo/stagedCount/stats/hasConflict）；stage/unstage/commit 进新 `ports/git-executor.ts` IGitExecutor（spawn 封装）
5. cwd 获取（G-R2-01）：`sessionService.getSession(sid)?.cwd`（session-service.ts:221）

**安全约束（G-R2-05）：**
- spawn 用 `execFileSync` 数组参数（非 shell，防注入，参考 npm-git-installer.ts:36）
- commit message 经参数传递（不拼命令串）
- 非 git 仓库：git.status 返回 `{ isRepo: false }`，前端隐藏 git-zone
- git 未安装：同 isRepo:false 降级（readGitInfo 已有 undefined 返回）
- 超时：spawn 设 timeout（参考 installer 的 timeout 模式）

**冲突态处理：**
- git.status 的 hasConflict=true 时 git-zone 显冲突态（红 pill + danger 竖条）
- 冲突态 commit 必失败（git 拒绝 unmerged）→ error envelope code=`git_conflict`，前端回显
- 解决冲突按钮 → SideDrawer（Diff 审批排除，但冲突文件列表可展示）

**修正 FR-11 矛盾（G-R2-03）：** FR-11 原「unmerged 由前端标注 runtime 不推」修正为「**runtime 推 unmerged**（git.status 的 hasConflict + files[].status=unmerged），前端据此渲染冲突态」。FileChangeStatus 补 unmerged 仍保留（file_changes 和 git.status 共用枚举）。

## 追踪修正（Round 1 gap 处理结果）

追踪 subagent 发现 23 个 gap，处理如下：

### F 类已确认 + 主 agent 定方案（直接并入 spec）
- G-001 ✅ ToolCallStatus 扩 'pending'（并入 FR-2/FR-11）
- G-002 ✅ message.tool_call_pending payload 需契约化（执行时读 event-adapter 生产侧确认字段）
- G-003 ✅ install/uninstall 刷新靠 onExtensions 订阅（已有），reply 仅 ack
- G-004 ✅ 三 tab→命令映射：npm=install(source)/dir=installDir(path)/git=installGit(url)
- G-007 ✅ session.compacted 订阅过滤带 id 的 reply（只认无 id 广播）
- G-009 ✅ compact return Promise<void> + mock 同构补全
- G-016 ✅ 修正 FR-11 为「只补 tools」（dirName 已在）
- G-017 ✅ unmerged 前端标注（runtime 不推）
- G-022 ✅ mock 剧本 abort 清 timer（循环检查 cancelled Set）

### D 类已决策（用户确认）
- G-012 ✅ SideDrawer 由 **git-zone Diff 按钮触发**（FR-12 加回 git-zone 后有触发源）
- G-013 ✅ compact 经 **slash command** 触发
- G-014 ✅ FileView **跨回合并集**

### F 类执行时细化（不阻塞 spec，留 wave 规格细化）
- G-005 候选选择 UI 形态（弹窗/内联）→ FR-5 wave 细化
- G-006 install 错误回显（含 details.hint）→ FR-5 wave 细化
- G-008 compacted 按钮态自动消失规则 → FR-6 wave 细化
- G-010 widgetKey/statusKey 枚举 + tab 映射 → FR-7 wave 细化（执行时读 event-adapter 确认 widgetKey 来源）
- G-011 widget lines 增量/全量 → FR-7 wave 细化（Terminal=append / 其他=replace 推测，执行时确认）
- G-015 FileView 行数数据来源 → FR-10 wave 细化（FileChange.addLines/delLines）
- G-018 session.list server-push 不重载历史 → FR-9 已注明
- G-019 session.list 订阅用 onGlobalType → FR-9 已注明 + mock 补 server-push
- G-020 mock 剧本 messageId 对齐 + file_changes ready 帧 → FR-1 wave 细化
- G-021 retry/queue 放 Composer 上方独立行 → FR-3/FR-4 已注明
- G-023 pending 气泡消失触发 → FR-4 wave 细化（message_start 到达时清 queue）

### Round 2 gap（FR-12 git-zone，全部已处理）
- G-R2-01 ✅ git.status 返回结构已定义（FR-12：isRepo/branch/stagedCount/unstagedCount/stats/hasConflict/files[]）
- G-R2-02 ✅ commit message 前端弹输入框（C13）；stage 接 filePaths?（空=add -A）；冲突 commit 失败 code=git_conflict
- G-R2-03 ✅ git-zone 独立真实 git（C12）；修正 FR-11 矛盾（C15：runtime 推 unmerged）
- G-R2-04 ✅ 刷新时机：进入 session + agent_end + 操作后（C14，非轮询）
- G-R2-05 ✅ 安全：execFileSync 数组参数 + message 参数传递 + isRepo:false 降级 + timeout
- G-R2-06 ✅ port 复用：status 复用 reconcileFileChanges（加 U），stage/unstage/commit 进新 IGitExecutor
- G-R2-07 ✅ mock 同构：补 mock git.*（FR-12 执行时补 mock/index.ts git domain）

## Acceptance Criteria

- [ ] mock 模式发消息能看到 thinking 块 + tool_call 卡 + ChangeSetCard + 系统通知的实时流式效果（非只看静态 fixture）
- [ ] `message.tool_call_pending` 有 store case（grep `case 'message.tool_call_pending'` 命中）+ ToolCallStatus 含 'pending'
- [ ] steer/followUp 提交后 Composer 上方独立行显示 pending 气泡；auto_retry 时同位置显示重试指示位
- [ ] Settings ExtensionPage 三 tab 安装（npm/dir/git）可用 + 候选选择 UI + 卸载确认（mock 模式可验证链路）
- [ ] slash command 触发 compact，状态正确（compacting→compacted），与 compactionSummary system 行区分
- [ ] extension:widget/extension:status 前端有订阅（session 通道）并渲染到右抽屉
- [ ] 右抽屉 SideDrawer 容器存在，由 git-zone Diff 按钮触发打开，含 Terminal/Browser tab
- [ ] 多窗口/runtime 侧增删会话时 Sidebar 实时刷新（不重载全量历史）
- [ ] FileView 显示真实 file_changes（跨回合并集，非 mock fixture），含 U 标注 + 行数 + 过滤
- [ ] ExtensionInfo 补 tools（dirName 已在）；FileChangeStatus 含 unmerged（vue-tsc 0 错）
- [ ] **git-zone 加回**：Panel 恢复 zone ⑤，四态展示（干净/已暂存/有 diff/冲突），后端 git.status/stage/unstage/commit 命令可用
- [ ] `npx vue-tsc --noEmit` 0 错 + `npx vitest run` 全绿（每 wave 基线）

## Constraints

- 沿用 waves.md §0 的 D1-D10 决策边界（不越界到 tree/审批/plugin/附件/搜索）
- 三层架构不变：services 定义 port，infra 实现，transport handler 路由
- mock/real 门面同构（api/index.ts 三元要求两侧签名一致）
- 错误契约 D10/P0-B：请求级失败走统一 error envelope
- 每 wave 验证基线：`vue-tsc --noEmit` + `vitest run`，git 干净后提交
- 串行执行（不并行派 implementer，会冲突）

## 业务用例

### UC-1: 开发者联调时看到完整流式效果
- **Actor**: 开发者
- **场景**: mock 模式发消息
- **预期结果**: 看到 thinking 折叠→tool_call 卡→文本流式→ChangeSetCard 出现→系统通知，验证 W05-W10 渲染逻辑端到端

### UC-2: 用户管理 Extension 安装卸载
- **Actor**: 用户
- **场景**: Settings → Extension 菜单 → 安装 npm 包 / 卸载
- **预期结果**: 安装按钮触发多步流，候选列表出现，确认后安装完成列表刷新；卸载确认后从列表移除

### UC-3: 用户主动压缩上下文
- **Actor**: 用户
- **场景**: 长会话 → 点 Composer 压缩按钮
- **预期结果**: 显示 compressing 状态，完成后 compacted + compactionSummary system 行

## 决策记录（本轮澄清）

| # | 决策 | 选项 | 理由 |
|---|------|------|------|
| C1 | 范围深度 | 三档全做 | 收尾闭环 + 后端能力对接 + Side Drawer |
| C2 | 审批边界 | 含 Diff 代码审查审批 | tool 审批 + Diff Accept/Reject 整块排除 |
| C3 | Side Drawer | 保留容器，仅移除 Diff 审批内容 | 为 Terminal/Browser/进度聚合铺位 |
| C4 | Plugin | 维持 deferred | 后端 11 命令闲置，但 spec 标独立第 6 菜单 |
| C5 | mock 流式 | 全套固定剧本 | 让所有已实装渲染可验证 |
| C6 | FileView | 切到 file_changes 聚合（跨回合并集） | 数据已在 store，盘活 file_changes 通道 |
| C7 | session.list | 加 server-push 订阅（不重载历史） | 多窗口/runtime 侧变更实时同步 |
| C8 | compact 触发 | 经 slash command | 用户确认 |
| C9 | SideDrawer 触发 | git-zone Diff 按钮触发打开 | git-zone 加回后有触发源 |
| C10 | retry/queue UI | Composer 上方独立行 | 对齐 panel/spec.md:52 |
| C11 | **git-zone** | **按设计稿加回（含后端建 git.* 命令）** | v3 SSOT 明确要求（panel/spec.md:30），前端重构错误移除 |
| C12 | git-zone 数据源 | **独立真实 git status**（非 file_changes） | git-zone 显示全量 git 状态（含用户手改），file_changes 仅 agent 改动，语义不同 |
| C13 | commit message | 前端弹输入框（可选 message） | 设计稿无 commit UI，但用户要可输入 |
| C14 | git.status 刷新 | 进入 session + agent_end + 操作后（非轮询） | 无 filesystem watch，手动+事件触发 |
| C15 | unmerged 来源 | **runtime 推**（修正 FR-11 矛盾） | git.status 输出 hasConflict + files[].status=unmerged |
