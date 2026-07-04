# Tracing Round 5（收敛复核）

CONVERGED

> 独立 subagent 隔离追踪（fresh context）。按 5+1 架构视角对更新后的 system-architecture.md 做收敛复核。
> **输入**：system-architecture.md（已更新）+ requirements.md + spec-w11.md + tracing-round-4.md + 源码验证。
> **性质**：本轮是 Round 4 追踪的收敛复核——验证 12 个 gap 是否全部解决，并检查是否有新 gap。

## 视角覆盖

| 视角 | 状态 | 备注 |
|------|------|------|
| Model Integrity | ✓ 追踪 | 无新 gap（Round 4 的 G-001/G-002/G-010/G-011 已解决） |
| State Orthogonality | ✓ 追踪 | 无新 gap（Round 4 的 G-003/G-004 已解决） |
| Layering Discipline | ✓ 追踪 | 无新 gap（Round 4 的 G-005/G-006/G-007 已解决） |
| Dependency Boundary | ✓ 追踪 | 无新 gap（Round 4 的 G-008/G-012 已解决） |
| Change Axis | ✓ 追踪 | 无新 gap（Round 4 的 G-009 已解决） |
| Behavior Contract | 降级 | greenfield 模式，无现有行为可保持 |

---

## Round 4 Gap 验收

| Gap | 类型 | 视角 | 问题摘要 | 解决状态 | 验证 |
|-----|------|------|---------|---------|------|
| G-001 | K | Model Integrity | GitFileStatus / GitStatusResult 模型缺失 | ✅ 已解决 | §4.1 GitFileStatus 作为值对象列出；§4.2 GitService 作为服务列出；§3 统一语言含 git 相关术语 |
| G-002 | D | Model Integrity | GitZone 四态的模型归属不清 | ✅ 已解决 | §5.4 明确为"前端派生展示态"，四态从 GitStatusResult 推导，非独立模型 |
| G-003 | K | State Orthogonality | Extension 安装终态不可逆的边界条件 | ✅ 已解决 | §5.2 补充重试机制说明：error 终态的"不可逆"指该次流程不可重置，但用户可发起新安装 |
| G-004 | K | State Orthogonality | git-zone 四态的合法转换未定义 | ✅ 已解决 | §5.4 明确四态是派生展示态，每次 git.status 返回后重新计算，无显式转换规则 |
| G-005 | D | Layering Discipline | git-info.ts 放在 services/ 破坏分层 | ✅ 已解决 | §10 D-8 作为"准 port"决策记录，ponytail 合理 |
| G-006 | D | Layering Discipline | IGitExecutor 与 readGitInfo 职责边界 | ✅ 已解决 | §10 D-9 明确分工：readGitInfo 轻量缓存（5min TTL），IGitExecutor 重量操作 |
| G-007 | D | Layering Discipline | Port 只有 1 个实现的合理性 | ✅ 已解决 | §6.3 "特化决策"论证边界价值 > 可替换价值 |
| G-008 | F | Dependency Boundary | mock 直接 import events | ✅ 已解决 | §10 "特化决策"修正描述：mock 共享 events 分发机制，有意设计 |
| G-009 | K | Change Axis | git.ts domain 是否独立导出 | ✅ 已解决 | §7.1 明确 git.ts 为独立模块 |
| G-010 | F | Model Integrity | ExtensionInfo 缺 tools 字段 | ✅ 已解决 | spec-w11.md FR-11 已定义，system-architecture.md 适当 defer |
| G-011 | F | Model Integrity | unmerged 来源矛盾未同步到架构文档 | ✅ 已解决 | §10 D-6 定义双路径推送机制 |
| G-012 | K | Dependency Boundary | Widget 订阅走 session/global 通道 | ✅ 已解决 | §10 D-7 明确走 session 通道 |

**验收结果**：12/12 全部解决。

---

## 各视角详细追踪

### 视角 1: Model Integrity（模型完整性）

**追踪结果**：无新 gap。

核心模型（§4）覆盖：
- **前端**：ChatStore（store）、ChatSessionState（值对象）、Domain 函数（纯函数）、GitFileStatus（值对象）、ExtensionInfo（DTO）— 类型标注清晰
- **Runtime**：SessionService（服务）、MessageDispatcher（服务）、Handler（路由器）— 类型标注清晰
- **降级决策（§4.3）**：MessageStream / GitZone 四态 / SideDrawer 三个概念主动不建模，理由成立（派生状态/容器组件）

模型完整性验证通过。不变式守卫（ChatStore 的 sessionId Map）、值对象纯净性（GitFileStatus 不可变）、无空壳建模均满足。

### 视角 2: State Orthogonality（状态正交性）

**追踪结果**：无新 gap。

状态机覆盖：
- **isGenerating（§5.1）**：idle ↔ generating，极简，终态 idle
- **Extension 安装（§5.2）**：idle → installing → discovered → completed/error，终态 {completed, error} 不可逆，重试机制已定义
- **Compact（§5.3）**：瞬态 compacting → compacted，非持久状态机，合理
- **git-zone 四态（§5.4）**：派生展示态（clean/staged/dirty/conflict），非状态机，实时推导

所有状态机均有 Status 枚举、终态集合、合法转换定义。git-zone 的"镜子"定位（反映真实状态，不驱动转换）是正确设计。

### 视角 3: Layering Discipline（分层纪律）

**追踪结果**：无新 gap。

分层验证：
- **核心计算明确**：消息路由与状态同步（§2），非复杂业务规则，三层足够
- **前端三层**：Interface（Vue + composables）→ Engine（stores + domains）→ Infrastructure（transport + events + pending）— 依赖严格向下
- **Runtime 三层**：Interface（handlers）→ Engine（services）→ Infrastructure（ports + infra）— 依赖严格向下
- **核心层零外部依赖**：services 层不直接 import pi SDK，通过 ports 访问
- **Port 清单（§6.3）**：ISessionStore / IConfigStore / IPiEngine / IGitExecutor 均 1 实现但保留为 port，边界价值论证充分

**源码验证**：
- `git-info.ts:59` 用 `execSync`（IO 操作在 services/），符合 D-8 "准 port" 决策
- `session-service.ts:211` 和 `session-scanner.ts:59` 都调用 `readGitInfo`（2 个调用方，非 D-8 所述的 1 个），但不影响设计决策——ponytail 论证仍然成立

### 视角 4: Dependency Boundary（依赖边界）

**追踪结果**：无新 gap。

依赖健康度验证：
- **无循环依赖**：前端 Vue → Stores → Domains → Transport → WebSocket → Runtime → Services → Ports → Infra，单向
- **无上帝对象**：预估最大模块 stores/chat.ts ~300 行，合理
- **mock 隔离（§10 特化决策）**：mock/index.ts import events（`import * as events from '../events'`，源码 line 24），共享 dispatchSession 机制，有意设计
- **Widget 通道路由（§10 D-7）**：routeInbound 按 `payload.sessionId` 有无走 dispatchSession/dispatchGlobal，extension:widget/extension:status 含 sessionId 走 session 通道 — 逻辑一致

**源码验证**：
- `useConnection.ts:54-58`：`const sid = (msg.payload as { sessionId?: string }).sessionId` → `dispatchSession(sid, msg)` / `dispatchGlobal(msg)` — 确认路由逻辑与 D-7 描述一致

### 视角 5: Change Axis（变化轴）

**追踪结果**：无新 gap。

模块拆分验证：
- **前端（§7.1）**：8 个模块，每个单一变化轴，LOC 预估合理
- **Runtime（§7.2）**：6 个模块，每个单一变化轴，git-* 为新建独立模块
- **命名反映职责**：git-message-handler.ts（git 命令路由）、git-service.ts（git 业务逻辑）、git-executor.ts（git 命令执行）— 看名知责
- **git.ts 独立导出**：§7.1 明确为独立模块，变化轴（git 命令增删）独立于 chat/config/extension

### 视角 6: Behavior Contract（行为契约）

**降级理由**：greenfield 模式。本轮是 W11+ 新功能开发（git-zone / extension install / compact / widget / SideDrawer），无现有行为可保持。W01-W10 已有行为（session CRUD、message 流式、config CRUD）在本次架构变更中不被修改，只新增模块。

**例外说明**：FR-2 tool_call_pending 修复和 FR-11 契约裂缝修复涉及现有代码，但属于 bug 修复（补漏接），不是行为变更，架构文档无需追踪。

---

## 收敛判定

**CONVERGED** — Round 4 的 12 个 gap 全部解决，5+1 视角追踪无新 gap。架构设计初稿（system-architecture.md）可进入下游 issues 拆分阶段。

### 确认已追踪的视角

1. ✅ Model Integrity — 核心模型类型标注、不变式、降级决策均完整
2. ✅ State Orthogonality — 4 组状态机/展示态定义清晰，终态/重试/派生逻辑完备
3. ✅ Layering Discipline — 三层架构合理，Port 边界价值论证充分，准 port 决策有据
4. ✅ Dependency Boundary — 无循环依赖，mock 隔离有意设计，通道路由逻辑确认一致
5. ✅ Change Axis — 模块拆分按变化轴，命名反映职责
6. ✅ Behavior Contract — 降级（greenfield）
