# Code Review — fix-opendir-toast

## 审查范围
- commits: `0a09b8ed` (W3)
- 审查方式：主 agent 自审（改动范围小，单文件 + 2 条测试）

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| — | 无 must_fix / should_fix | — | — |

**确认正确**：
- `onOpenDirDialog` 用 `flow.openDirDialog().catch(toastError)` 模式，catch 吞掉 reject 不再变 unhandled rejection
- catch 参数 `(e: unknown)` + `e instanceof Error ? e.message : String(e)` 类型守卫，无 any/as
- toast 文案「无法打开目录选择器：${reason}」含错误原因，符合 AC-5.6「显错 toast」
- 模板从内联 `flow.openDirDialog()` 改为 `onOpenDirDialog`，修复了 Promise 无 catch 的根因
- useToast import 用法与 useNewTaskFlow.ts L53 一致（`const { error: toastError } = useToast()`）

## plan 覆盖核对

### W1 (commit 0a09b8ed)
- [x] changes[0]: Landing.vue import useToast + onOpenDirDialog handler + 模板改用 — 完全符合
- [x] changes[1]: landing.test.ts 新增 reject→toast + resolve→不 toast 测试 — 完全符合

### testCases 覆盖（3/3）
- [x] U1: openDirDialog reject → toastError 被调（含「无法打开目录选择器」+「IPC failed」）
- [x] U2: openDirDialog resolve → 不调 toastError
- [x] E1: onOpenDirDialog handler 转发调用（U1/U2 均断言 flow.openDirDialog 被调 1 次）

## 结论
- **must_fix: 0**
- 15 tests passed（landing.test.ts 全绿），118 tests passed（new-task 全套件）
- 单文件改动，逻辑简单明确，无边界遗漏。**建议通过 review**。
