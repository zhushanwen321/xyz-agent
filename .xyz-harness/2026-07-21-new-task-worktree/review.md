# Code Review · new-task-worktree

**审查范围**：W1（runtime 后端）+ W2（renderer 前端）3 个 commit。
**审查方法**：逐文件审查 + 架构一致性检查 + 安全/边界 case 分析。

## 审查结论

后端三层架构（ports → infra → services）、依赖注入、ShellRunner timeout 时序处理扎实。但发现 **2 个 critical bug 导致整个 W2 功能生产环境不可用**，必须合并前修。另有 3 个 major issue（安全 + 正确性），建议本轮修。

## Critical Issues

### R1 · isBareWorkspace 数据源未连通 —— 入口生产环境永不显示

**位置**：`useNewTaskFlow.ts:98-102` + `Landing.vue:112-115`

Landing.vue 用 `flow.gitInfo.value?.isBare ?? false` 派生 isBareWorkspace，但 useNewTaskFlow 的 gitInfo computed 只返回 `{ branch, isRepo: true }`，从不设 isBare。结果 isBareWorkspace 恒 false，「新建 worktree」动作项 v-if 永不渲染。

架构双层 gap：(1) 前端 gitInfo computed 不填 isBare；(2) runtime GitInfoReader 只检测标准 worktree（isWorktree），不检测 .bare workspace 结构。

测试为何全绿：集成测试 mock 了整个 useNewTaskFlow，直接注入 isBare:true，绕过真实数据路径（三视角事故同构反模式）。

**修复**：WorkspaceDetector 复用到 session 摘要链路，SessionSummary 加 isBareWorkspace 字段，前端 gitInfo computed 从 session 派生。补真实 flow（非 mock）集成测试。

### R2 · 错误 envelope details 未透传 —— error 态不显 stderr，exists 态按钮失效

**位置**：`useConnection.ts:84` ↔ `worktree-message-handler.ts:66-67` ↔ `CreateWorktreeModal.vue:176-183, 214-217`

runtime handler 把 stderr/exitCode/cwd 放进 envelope details，但 useConnection.ts:84 reject 时只复制 code，丢了 details。后果：(1) error 态永远不显 stderr/exitCode；(2) exists 态「直接开始」按钮读 lastError.cwd 恒 undefined，点击无反应。

**修复**：useConnection.ts:84 把 envelope details.detail 展开到 reject 的 Error 上（string→cwd，object→exitCode/stderr）。

## Major Issues

### R3 · runtime 无分支名校验 —— 路径遍历风险

**位置**：`worktree-service.ts:71` + `worktree-message-handler.ts:41-43`

前端有 INVALID_BRANCH_REGEX 校验，runtime 零校验。Windows 下 branch=`..\\..\\evil` → dirName 保留反斜杠 → join 解析到 wsRoot 外。runtime 是安全边界，前端校验只是 UX。

**修复**：WorktreeService.create 入口加分支名校验，非法抛 INVALID_BRANCH。

### R4 · ShellRunner 超时只发 SIGTERM，无 SIGKILL 升级

**位置**：`shell-runner.ts:100-105`

SIGTERM 可被脚本捕获/忽略，npm install 子进程可能不在同一进程组 → 孤儿进程泄漏。

**修复**：timeout 后 SIGTERM，设短延迟 escalation timer，未 close 则 SIGKILL。或 detached + process.kill(-pid) 杀进程组。

### R5 · git worktree add 失败静默吞 —— GIT_FAILED 路径未覆盖

**位置**：`worktree-service.ts:84-86` + port 注释声明 GIT_FAILED 但实现无 catch

gitExecutor.exec exitCode 非 0 不抛（约定），worktree-service 静默继续跑 setup 到未创建的目录 → setup 失败但根因（git add stderr）被吞。

**修复**：worktree add 后检查 exitCode !== 0 → 抛 GIT_FAILED + detail。补 WS-8 测试。

## Minor Issues

### R6 · WorkspaceDetector 在 create 内实例化两次（死代码）

**位置**：`worktree-service.ts:54-58` vs `112-122`

create 第 54-61 行构造的 detector 从未使用，detectBare 内部又构造一个。删第一个。

### R7 · isOpen 恒 true，watch(isOpen) 永不触发（死代码）

**位置**：`CreateWorktreeModal.vue:137, 237-239`

onBeforeUnmount 已清理 timer，watch 是无效代码。删除。

## 测试质量

### R8 · WS-* 未覆盖 git worktree add 失败路径

**位置**：`worktree-service.test.ts`

WS-1~7 无 git add exitCode 非 0 用例（R5 的 bug 因此隐藏）。补 WS-8。

### R9 · 集成测试 mock 过度，掩盖 R1 数据链路断裂

**位置**：`worktree-integration.test.ts:49-52`

vi.mock 整个 useNewTaskFlow，绕过真实 computed。补真实 flow 集成测试用例（R1 修复后）。

## 第 2 轮审查（review_fix 后确认）

7 个 issue 修复均已验证闭环（commit 8d7cff0a）：

| Issue | 修复 | 测试 | 状态 |
|-------|------|------|------|
| R1 isBareWorkspace 数据源 | SessionSummary 加字段 + WorkspaceDetector 缓存复用 + 前端 gitInfo 派生 | RF-1/2 真实 flow 集成测试 | 闭环 |
| R2 details 透传 | useConnection reject 展开 details.detail | useConnection-visibility 3 cases | 闭环 |
| R3 runtime 分支名校验 | INVALID_BRANCH_REGEX (含反斜杠) | WS-8 | 闭环 |
| R4 SIGKILL 升级 | SIGTERM + 5s escalation | SR-4 | 闭环 |
| R5 git add exitCode 检查 | exitCode!=0 抛 GIT_FAILED | WS-9 | 闭环 |
| R6 WorkspaceDetector 死代码 | 删除 | — | 闭环 |
| R7 watch(isOpen) 死代码 | 删除 | — | 闭环 |

验证：runtime 16/16 + renderer 159/159 测试全绿，typecheck 双通过，lint 0 warning。可进 test 阶段。
