# Tracing Round 3（收敛复核）

> 独立 subagent 隔离收敛复核（fresh context）。主 agent 持久化。
> **结论：CONVERGED** —— 无新 gap。已追踪全部 5 视角。

## 追踪范围
- spec 初稿版本：spec-w11.md（2026-06-24，含 FR-1~FR-12 + 追踪修正章节 + Round1(23)+Round2(7) gap 处理 + 决策 C1-C15）
- 追踪的视角：User Journey / Data Lifecycle / API Contract / State Machine / Failure Path（全 5 视角，无降级）
- 复核重点：FR-12 git-zone 的 Round 2 gap（G-R2-01/03/06）处理是否真正自洽

## 收敛判定

**CONVERGED** —— Round 2 的 7 个 FR-12 gap（G-R2-01~07）经独立代码核验全部成立，FR-1~FR-11 亦无新缺口。本轮无新 gap。

仅 1 条提示（H-R3-01，非 gap），不影响收敛。

## 用户重点要求的 3 项自洽性核验

### ① G-R2-01：git.status 返回结构 —— ✅ 自洽
spec FR-12 明确定义 `git.status:result` payload 结构。ClientMessageType/ServerMessageType 当前无 git.* 类型，新增无冲突。cwd 获取 `sessionService.getSession(sid)?.cwd`（session-service.ts:221）成立。前端四态派生路径清晰。

### ② G-R2-03：file_changes vs git.status 数据关系 —— ✅ 自洽
message.file_changes（event-adapter.ts:222-254，附 messageId）与 git.status（附 sessionId）路径完全分离。C15 已消除 FR-11 矛盾（runtime 推 unmerged）。二者语义独立是 git-zone 加回的价值所在。

### ③ G-R2-06：port 复用策略 —— ✅ 决策自洽（H-R3-01 措辞提示）
reconcileFileChanges（file-change-reconciler.ts:73）返回 FileChange[]，与目标 payload shape 差距大（缺 branch/isRepo/stagedCount/unstagedCount/stats/hasConflict）。但 Round 2 subagent 当时已知此差距（G-R2-06 原文已点明），G-R2-01 已覆盖目标结构。Wave 细化时应落实为「新建 git-status 适配函数」，非直接复用返回值。

## 提示（非 gap，不阻塞收敛）

| ID | 类型 | 位置 | 说明 |
|----|------|------|------|
| H-R3-01 | 措辞提示 | FR-12 spec「复用既有 reconcileFileChanges」 | spec 措辞低估 shape 差距。Wave 细化时应落实为：新建 git-status 适配函数（复用 parseGitStatusPorcelain + 扩展 xyToStatus 加 U/staged 拆分 + 调 readGitInfo 取 branch + 另跑 git diff --numstat 取 stats），非直接把 reconcileFileChanges 返回值当 payload。决策信息已在 G-R2-01 结构定义中覆盖。 |

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| State Machine（部分） | git-zone 四态为展示态（git.status 派生），非用户驱动状态转换；ChangeSet 5 态本轮不变更。 | draft-companion-zones §4；message.ts:112 |

## 核心源码定位（供 wave 实施引用）
- cwd：session-service.ts:221 / :206
- 分支：git-info.ts:37（readGitInfo，含 5min 缓存）
- porcelain（缺 U/staged 区分/stats）：file-change-reconciler.ts:31,50,73
- spawn 安全范式：npm-git-installer.ts:36
- file_changes 推送：event-adapter.ts:222-254
- mock 三件套：api/mock/index.ts:190-212
- chunk-processor default 丢弃：chat-chunk-processor.ts:355
- retry/queue store：chat.ts:42,44,54,60
- 协议落点：protocol.ts:9-30 / 170-201 / 343-352
- 路由：server.ts:124-132
- mock 同构：api/index.ts:23-31
