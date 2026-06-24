# Tracing Round 2（收敛复核）

> 独立 subagent 隔离收敛复核（fresh context）。主 agent 持久化。
> **结论：NOT CONVERGED** —— FR-12 git-zone 新增 7 个 gap，FR-1~FR-11 已收敛。

## 收敛判定

**不收敛** —— 7 个新缺口（G-R2-01~07），全部集中在 FR-12 git-zone。
- G-R2-01/02/03/04 是硬阻塞（git.status 结构/stage-commit payload/刷新时机/file_changes 关系未定）
- G-R2-05/06/07 可 wave 细化
- **FR-1~FR-11 无新缺口**（Round 1 的 23 个处理合理）

## [本轮] FR-12 代码核实（F 类证据）

### 核实 #1：cwd 来源已具备
`sessionService.getSession(sid)?.cwd`（session-service.ts:221）或 `findScannedSession(sid)?.cwd`（:206）。前端 `session.active.cwd` 已暴露（stores/session.ts:31-33）。

### 核实 #2：已有 git spawn 基础设施（可复用，不应从零建）
- `services/git-info.ts:37 readGitInfo(cwd)` —— execSync git rev-parse，含 5min 缓存 + worktree 检测（git-zone 分支来源已就绪）
- `infra/pi/file-change-reconciler.ts:73 reconcileFileChanges(cwd)` —— execSync git status --porcelain，含 parseGitStatusPorcelain + xyToStatus（A/M/D/R/C/?? 映射，**缺 U unmerged**）
- `infra/installers/npm-git-installer.ts:36` —— execFileSync 数组参数（spawn 安全范式，防注入）

### 核实 #3：冲突映射缺失
现有 `xyToStatus`（file-change-reconciler.ts:50-65）无 U 映射。git-zone 冲突态需 unmerged 检测。spec FR-11「unmerged 前端标注 runtime 不推」与 FR-12 后端需输出冲突标记**矛盾**——前端无 git XY 码无法标注冲突。

## Gap 列表（7 个新缺口）

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-R2-01 | D | API Contract | P3/FR-12 | git.status 返回结构未定义。新建精简结构（branch/staged数/unstaged数/stats/冲突标志/文件列表）还是复用 reconcileFileChanges 的 FileChange[]（缺行数/冲突/staged区分）？前端四态如何派生？ |
| G-R2-02 | F | API Contract | P3/FR-12 | git.stage/unstage/commit payload+错误码未契约化。stage 接 filePath[] 还是 git add -A？commit message 从哪来（设计稿无 commit-message UI）？冲突态 commit 失败错误码？ |
| G-R2-03 | F | Data Lifecycle | P2/FR-12 | git.status（实时）与 message.file_changes（agent改动）数据关系。同一文件两处显示冲突？用户手改文件进 git-zone 是预期吗？ |
| G-R2-04 | F | State Machine | P4/FR-12 | git.status 刷新时机（轮询/事件/手动）。无 filesystem watch，何时调？ |
| G-R2-05 | F | Failure Path | P5/FR-12 | spawn git 安全约束（commit message 注入）+ 超时 + 非 git 仓库降级信号。 |
| G-R2-06 | D | API Contract | P3/FR-12 | 新建 IGitExecutor port vs 复用既有 reconcileFileChanges/readGitInfo。status 可复用（加 U），stage/unstage/commit 需新建。 |
| G-R2-07 | K | User Journey | P1/FR-12 | git-zone mock 模式如何验证？mock/index.ts 无 git.* 实现（facade 同构要求）。 |

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| State Machine（部分） | git-zone 四态是展示态，由 git.status 派生非用户驱动状态转换，已在 G-R2-01/04 追踪。 | draft-companion-zones §4「git 操作就地完成无中间态机」 |

## 核心源码定位（供处理 gap 引用）
- cwd：session-service.ts:206,221
- 分支：git-info.ts:37；前端 PanelHeader.vue:38
- porcelain（缺U）：file-change-reconciler.ts:31,50,73
- spawn 安全：npm-git-installer.ts:36
- 协议落点：protocol.ts:9-30（ClientMsgType）/170-201（ServerMsgType）/47-102（ClientMsgMap）
- 路由：server.ts:124-132
- mock 同构：api/index.ts:23-31
