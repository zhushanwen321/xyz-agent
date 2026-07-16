# Code Review — sidebar-p0-exception-handling

## 审查范围
- commits: ae75fb1f..HEAD（3 个 commit: W1 f4fe3a12, W2 8b972cc1, W3 73c948cb）
- 审查方式：独立 subagent 对抗性审查

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| W2-超时 | compact 用默认 30s 超时，runtime 实际 300s → 大上下文压缩必误超时。前端 reject 后 runtime 仍在跑，compact 完成走流式广播无法 settle 已 reject 的 Promise | must_fix | `api/domains/chat.ts:compact()` |
| W2-超时 | 普通命令 30-60s 之间可能误超时（runtime CMD_TIMEOUT_MS=60s，前端默认 30s） | should_fix | `api/pending.ts:17` |
| W1-重复写 | rename 活跃 session（文件已存在）时新名写两次（persistSessionName 一次 + tryPersistLabel 一次）。无功能影响但浪费 IO | should_fix | `session-lifecycle.ts:113` |
| W1-签名 | persistSessionName 保留 id?/cwd? 参数但 void 不使用，死代码标记 | should_fix | `session-file-utils.ts:80` |
| W3-测试 | onConfirmRename 和 onNewSession 的 try-catch 未单测（代码模式一致，测 2 个能推断 4 个） | should_fix | `sidebar-crud-error-handling.test.ts` |
| W2-竞态 | timer 直接调裸 reject 而非 entry.reject（跳过 clearTimeout，但 timer 正执行无需 clear）。竞态安全，写法略不优雅 | nit | `pending.ts:50` |
| W3-mock | focusedSessionId mock 为普通对象而非 ref，导致 Vue warn | nit | `sidebar-crud-error-handling.test.ts:26` |

## plan 覆盖核对

- [x] W1 changes[0]: persistSessionName 删 wx 建文件分支 → console.warn + return
- [x] W1 changes[1]: renameSession 活跃分支加 labelPersisted=false
- [x] W2 changes[0]: register 加 timeoutMs（默认 30s）+ setTimeout 超时 reject
- [x] W2 changes[1]: resolve/reject 路径 clearTimeout
- [x] W3 changes[0]: 四个 CRUD handler 加 try-catch+toastError + ⌘N 改调 onNewSession

## must_fix 处理

**W2 compact 超时**：修复方案是给 compact RPC 传更长超时。需要改 request() helper 支持透传 timeoutMs，或 chat.ts:compact() 单独处理。修复后重新 commit。

## 结论

1 个 must_fix（compact 超时），修完后重新 cw(dev) 提交。3 个 should_fix 中 W1 重复写和 W2 默认超时可在 must_fix 修复中一并处理。
