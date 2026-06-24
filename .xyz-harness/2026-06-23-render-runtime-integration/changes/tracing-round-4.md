# Tracing Round 4（架构设计阶段追踪）

> 独立 subagent 隔离追踪（fresh context）。按 5+1 架构视角对 system-architecture.md 初稿做强制枚举追踪。
> **输入**：system-architecture.md + requirements.md + spec-w11.md + 源码验证。
> **性质**：本轮是**架构设计阶段**追踪（区别于 Round 1-3 的需求澄清阶段），关注架构模型本身的合理性。

## 视角覆盖

| 视角 | 状态 | 备注 |
|------|------|------|
| Model Integrity | ✓ 追踪 | 发现 4 个 gap |
| State Orthogonality | ✓ 追踪 | 发现 2 个 gap |
| Layering Discipline | ✓ 追踪 | 发现 3 个 gap |
| Dependency Boundary | ✓ 追踪 | 发现 2 个 gap |
| Change Axis | ✓ 追踪 | 发现 1 个 gap |
| Behavior Contract | 降级 | greenfield 模式，无现有行为可保持 |

**总计**：12 个 gap（6K / 5D / 1F）

---

## Gaps

### G-001: GitFileStatus / GitStatusResult 模型缺失
- **类型**: K
- **视角**: Model Integrity
- **问题**: system-architecture.md §4 核心模型未包含 git-zone 相关模型。spec-w11.md FR-12 定义了 `git.status:result` payload 结构（isRepo/branch/stagedCount/unstagedCount/stats/hasConflict/files: GitFileStatus[]），GitFileStatus = {path, xyCode, status: added|modified|deleted|unmerged|renamed|untracked}，但这些模型在 system-architecture.md 的统一语言（§3）和核心模型（§4）中均未出现。
- **证据**: system-architecture.md §3 统一语言无 GitFileStatus；§4.2 Runtime 模型只有 SessionService/MessageDispatcher/Handler
- **建议处理**: 在 §3 统一语言补充 GitFileStatus / GitStatusResult / GitFileStatusCode（四态枚举）；在 §4.2 Runtime 模型补充 GitService 作为新服务

### G-002: GitZone 四态的模型归属不清
- **类型**: D
- **视角**: Model Integrity
- **问题**: git-zone 四态（clean/staged/dirty/conflict）是值对象还是计算属性？system-architecture.md §4.3 降级决策说"git 状态是 runtime 推送的值对象，不是有生命周期的实体"，但 spec-w11.md FR-12 定义了 hasConflict/stagedCount/unstagedCount 字段——前端需要从这些字段**推导**四态。推导逻辑放在哪里？
- **证据**: system-architecture.md §4.3 GitZone 降级决策；spec-w11.md FR-12 git.status:result 结构
- **建议处理**: 明确 GitZone 的四态是**前端派生状态**（从 GitStatusResult 推导），非独立模型。推导逻辑应在 GitZone.vue 组件内或 api/domains/git.ts 的工具函数中。

### G-003: Extension 安装状态机终态不可逆的边界条件
- **类型**: K
- **视角**: State Orthogonality
- **问题**: system-architecture.md §5.2 定义 Extension 安装终态 {completed, error} 不可逆，但未说明：(1) 用户能否重新安装已失败的扩展？(2) 如果能，是走新的 install 流程还是重置 error 状态？spec-w11.md FR-5 只说"卸载确认接 uninstall"，未覆盖"失败后重试"。
- **证据**: system-architecture.md §5.2 状态机；spec-w11.md FR-5
- **建议处理**: 明确：error 状态下用户可通过重新触发 install（新流程）来重试，而非重置 error 状态。即 error 终态的"不可逆"指"该次安装流程不可重置"，但用户可发起新的安装。

### G-004: git-zone 四态的合法转换未定义
- **类型**: K
- **视角**: State Orthogonality
- **问题**: spec-w11.md FR-12 定义了四态展示（干净/已暂存/有 diff/冲突），但未定义四态之间的转换规则。例如：从 conflict 到 clean 需要什么操作？从 dirty 到 staged 是用户手动 stage 还是自动的？
- **证据**: spec-w11.md FR-12 只定义了展示态，未定义转换
- **建议处理**: 明确四态是**派生展示态**（从 git.status 实时查询结果推导），非用户驱动的状态机。每次 git.status 返回后重新计算四态，无显式转换规则。这是合理的设计——git-zone 是"镜子"（反映真实状态），不是"控制器"（驱动状态转换）。

### G-005: git-info.ts 放在 services/ 是否破坏分层
- **类型**: D
- **视角**: Layering Discipline
- **问题**: `services/git-info.ts` 直接用 `execSync` 执行 git 命令，这是 Infrastructure 层的行为（IO 操作）。但它放在 services/（Engine 层）。system-architecture.md §6.2 Runtime 分层定义 Infrastructure 为"ports + infra"，services 应"不直接碰 pi"——同理也不应直接碰 git。
- **证据**: `services/git-info.ts:37` 用 `execSync('git rev-parse --abbrev-ref HEAD')`
- **建议处理**: 两种方案：
  - **方案 A（最小改动）**：保留 git-info.ts 在 services/，但将其视为"准 port"（已有 readGitInfo 函数，未来可提升为 IGitInfo port）
  - **方案 B（严格分层）**：将 git-info.ts 移到 infra/git-info.ts，services 通过 port 接口访问
  - **建议**：方案 A（ponytail: 当前只有 1 个调用方，过度分层是浪费）

### G-006: IGitExecutor 与 readGitInfo 的职责边界
- **类型**: D
- **视角**: Layering Discipline
- **问题**: spec-w11.md FR-12 提出新建 IGitExecutor port（stage/unstage/commit），但 readGitInfo（读分支/worktree）已有实现。两者的职责边界是什么？readGitInfo 是否也应纳入 IGitExecutor？
- **证据**: `services/git-info.ts` 有 readGitInfo；spec-w11.md FR-12 提出 IGitExecutor
- **建议处理**: 明确分工：
  - **readGitInfo**：轻量缓存查询（分支名 + worktree 标记），已有 5min TTL 缓存，用于 session list 展示
  - **IGitExecutor**：重量操作（stage/unstage/commit/status），每次执行真实 git 命令，用于 git-zone 交互
  - 两者可共存，readGitInfo 不纳入 IGitExecutor（缓存策略不同）

### G-007: Port 清单中 ISessionStore / IConfigStore 只有 1 个实现
- **类型**: D（已有决策，验证其合理性）
- **视角**: Layering Discipline
- **问题**: system-architecture.md §6.3 列出 ISessionStore / IConfigStore / IPiEngine / IGitExecutor 都只有 1 个实现，但保留为 port。文档说"边界价值 > 可替换价值"。需要验证：这些 port 是否真的提供了边界价值（即是否有代码绕过 port 直接访问 infra）？
- **证据**: `services/ports/session.ts` 定义 ISessionStore；`infra/pi/session-store.ts` 实现
- **建议处理**: 已验证合理。session-service.ts 通过 ISessionStore 接口访问，未发现绕过 port 的直接 import。保留为 port 的决策成立。

### G-008: mock/index.ts 直接 import events 是否破坏隔离
- **类型**: F
- **视角**: Dependency Boundary
- **问题**: system-architecture.md 说"mock 不走 transport/events/pending，独立内存实现"，但 `mock/index.ts:10` 实际 import 了 `../events`，用 `events.dispatchSession` 模拟 session 通道推送。这是否破坏了 mock 的隔离性？
- **证据**: `src-electron/renderer/src/api/mock/index.ts:10` — `import * as events from '../events'`；`mock/index.ts:29` — `events.dispatchSession(sessionId, msg)`
- **建议处理**: 这是**有意的设计**（mock 需要模拟 session 通道推送让组件订阅生效），不是 bug。但 system-architecture.md §4.3 降级决策的描述不准确——mock 确实依赖 events 层。建议修正描述为"mock 不走 transport/pending，但共享 events 分发机制"。

### G-009: 前端 domain 层是否需要 git.ts
- **类型**: K
- **视角**: Change Axis
- **问题**: system-architecture.md §7.1 列出 `api/domains/git.ts` 为新建模块（status/stage/unstage/commit），但 api/index.ts 当前未导出 git domain。需要确认：git domain 是独立导出，还是合并到现有某个 domain？
- **证据**: `src-electron/renderer/src/api/index.ts` 无 git 导出；system-architecture.md §7.1 git.ts
- **建议处理**: 新建独立 `api/domains/git.ts`，在 `api/index.ts` 中新增 `export const git = isMock ? mockApi.git : realGit`。git 操作的变化轴独立于 chat/config/extension，合并会增加耦合。

### G-010: ExtensionInfo 缺少 tools 字段的建模
- **类型**: F
- **视角**: Model Integrity
- **问题**: spec-w11.md FR-11 提到"ExtensionInfo 补 tools 字段"，但 system-architecture.md §4 的模型表未提及。protocol.ts 的 ExtensionInfo 接口当前只有 name/dirName/version/description/path/enabled/source，无 tools。
- **证据**: `src-electron/shared/src/protocol.ts:343-352` ExtensionInfo 定义无 tools
- **建议处理**: 在 system-architecture.md §4.1 或 §4.2 补充 ExtensionInfo 的 tools 字段定义（类型、语义）。FR-11 已明确要补，架构文档应同步。

### G-011: FileChangeStatus 补 'unmerged' 的来源矛盾已解决但架构文档未同步
- **类型**: F
- **视角**: Model Integrity
- **问题**: spec-w11.md 经过 Round 2 追踪修正，已将 FR-11 矛盾解决为"runtime 推 unmerged"（C15 决策）。但 system-architecture.md §4 和 §10 的决策记录中未体现这一修正。§10 D-1 说"git-zone 走 git.status 命令，file_changes 走 message.file_changes 推送"，但未说明 unmerged 状态在两条路径中的处理。
- **证据**: spec-w11.md 追踪修正章节 G-R2-03；system-architecture.md §10 D-1
- **建议处理**: 在 system-architecture.md §10 补充 D-6（或扩展 D-1）：unmerged 状态由 runtime 在两条路径中推——git.status 的 hasConflict + files[].status=unmerged，以及 message.file_changes 的 FileChangeStatus='unmerged'。前端据此渲染冲突态。

### G-012: Widget 订阅走 session 通道还是 global 通道
- **类型**: K
- **视角**: Dependency Boundary
- **问题**: spec-w11.md FR-7 说"extension domain 加 onWidget/onStatus 订阅走 session 通道 events.on(sessionId)"，但 protocol.ts 的 extension:widget / extension:status payload 已含 sessionId。如果走 session 通道，events.ts 的 dispatchSession 需要从 payload 中提取 sessionId 来路由——这与当前 routeInbound（useConnection）的逻辑是否一致？
- **证据**: `src-electron/renderer/src/api/events.ts` session 通道按 sessionId 路由；protocol.ts extension:widget payload 含 sessionId
- **建议处理**: 确认 routeInbound 的路由逻辑：如果 msg.payload.sessionId 存在，走 dispatchSession；否则走 dispatchGlobal。extension:widget/extension:status 含 sessionId，应走 session 通道。这与 spec-w11.md FR-7 一致。架构文档应明确这一路由规则。

---

## 视角 6: Behavior Contract（降级）

**降级理由**：greenfield 模式——本轮是 W11+ 新功能开发（git-zone/extension install/compact/widget/SideDrawer），无现有行为可保持。W01-W10 的已有行为（session CRUD、message 流式、config CRUD）在本次架构变更中不被修改，只新增模块。

**例外**：FR-2 tool_call_pending 修复和 FR-11 契约裂缝修复涉及现有代码的行为变更，但这些是 bug 修复（补漏接），不是行为变更。架构文档无需追踪。

---

## 收敛判定

**未收敛** —— 本轮是架构设计阶段的首次追踪（Round 1-3 是需求澄清阶段），发现 12 个新 gap。需主 agent 处理后决定是否需要 Round 5 收敛复核。

## Gap 汇总

| ID | 类型 | 视角 | 问题摘要 | 处理建议 |
|----|------|------|---------|---------|
| G-001 | K | Model Integrity | GitFileStatus / GitStatusResult 模型缺失 | §3/§4 补充 |
| G-002 | D | Model Integrity | GitZone 四态的模型归属 | 明确为前端派生状态 |
| G-003 | K | State Orthogonality | Extension 安装 error 终态重试机制 | 明确可发起新流程 |
| G-004 | K | State Orthogonality | git-zone 四态转换规则 | 明确为派生展示态 |
| G-005 | D | Layering Discipline | git-info.ts 放在 services/ 破坏分层 | 方案 A（保留，准 port）|
| G-006 | D | Layering Discipline | IGitExecutor 与 readGitInfo 职责边界 | 明确分工 |
| G-007 | D | Layering Discipline | Port 只有 1 个实现的合理性 | 已验证合理 |
| G-008 | F | Dependency Boundary | mock 直接 import events | 修正文档描述 |
| G-009 | K | Change Axis | git.ts domain 是否独立导出 | 独立导出 |
| G-010 | F | Model Integrity | ExtensionInfo 缺 tools 字段 | §4 补充 |
| G-011 | F | Model Integrity | unmerged 来源矛盾未同步到架构文档 | §10 补充 |
| G-012 | K | Dependency Boundary | Widget 订阅走 session/global 通道 | 明确路由规则 |
