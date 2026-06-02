---
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-02T23:45:00"
  target: ".xyz-harness/2026-06-02-unify-extension-consumption/plan.md"
  verdict: pass
  summary: "计划评审第2轮通过，5条MUST FIX全部修复，无回归问题，0条新MUST FIX。"

statistics:
  total_issues: 8
  must_fix: 0
  must_fix_resolved: 5
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 / ExtensionResolver.deduplicate()"
    title: "deduplicate() 优先级逻辑反转——低优先级覆盖高优先级"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Execution Groups BG1+FG1 / Task 3"
    title: "Task 3 被 BG1 和 FG1 同时声明，subagent 执行时会产生文件冲突"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Interface Contracts / resolve() signature"
    title: "Interface Contracts 表格中 resolve() 签名与实现代码不一致（1参数 vs 3参数）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 3b Step 1 / useExtensionWidget.ts"
    title: "composable 缺少 refCount 保护，违反 CLAUDE.md Rule #2"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 3 / preflight-check.sh"
    title: "传递依赖检查是 TODO stub，FR-7.4b 无法满足"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: LOW
    location: "plan.md:FG1 Subagent 配置 / 读取文件"
    title: "FG1 读取文件引用 useExtensionUI.ts（文件名错误）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "spec.md:FR-5.1 + FR-1.7 / plan.md:Task 3"
    title: "extension.error WS 事件在 shared types 中定义但未实现生成逻辑"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "spec.md:FR-5.1"
    title: "spec 引用的 event-adapter 行号与实际代码偏移（L276 vs 实际约L283）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-06-02 23:45
- 评审类型：计划评审（增量审查模式）
- 评审对象：`.xyz-harness/2026-06-02-unify-extension-consumption/plan.md`（v2，含 5 项 MUST_FIX 修复）
- 审查范围：验证 v1 的 5 条 MUST_FIX 修复是否充分 + 检查回归

---

## MUST_FIX 修复验证

### [FIXED] #1: deduplicate() 优先级逻辑

**v1 问题：** 循环从 `sorted.length-1` 到 `0`（bundled 先写入），配合 first-write-wins 导致 bundled 覆盖 npm。

**v2 修复（plan.md L228-243）：**
- `sorted` 按 `PRIORITY_ORDER` 索引升序排列（npm=0, user=1, third-party=2, bundled=3）
- 循环从 `i=0` 正向遍历（npm 先写入）
- `!result.has(name)` 实现 first-write-wins → npm 胜出

**验证：** 逻辑正确。升序排列 + 正向遍历 + first-write-wins = 高优先级（npm）先写入，低优先级被跳过。单元测试 `deduplicate: npm wins over bundled for same name` 覆盖了此场景。修复充分。

### [FIXED] #2: Task 3 跨组冲突

**v1 问题：** Task 3 同时被 BG1 和 FG1 声明，两个 subagent 会操作同一组文件。

**v2 修复：**
- 拆为 Task 3a（backend: shared types + event-adapter + 测试）归入 BG1
- 拆为 Task 3b（frontend: composable + WidgetPanel + StatusBar + ChatView）归入 FG1
- BG1 声明 "Tasks: Task 1, Task 2, Task 3a"（全部 backend）
- FG1 声明 "Tasks: Task 3b"（全部 frontend）
- 文件零交叉：BG1 操作 `extension.ts / index.ts / event-adapter.ts / event-adapter-bridge.test.ts`，FG1 操作 `useExtensionWidget.ts / WidgetPanel.vue / StatusBar.vue / ChatView.vue`

**验证：** 修复充分。无文件冲突，类型划分正确（无混合 backend/frontend 的 Task）。

### [FIXED] #3: resolve() 签名不一致

**v1 问题：** Interface Contracts 表格记录 1 参数，实现代码用 3 参数。

**v2 修复（plan.md L51）：**
- Interface Contracts 表格更新为 `(projectRoot: string, packaged: boolean, userExtPaths: string[]) => ExtensionPaths`
- Edge Cases 列同步更新：`packaged=true 跳过 bundled 扫描；userExtPaths 为空跳过 user 扫描`

**验证：** 表格与实现代码（plan.md L159）完全一致。修复充分。

### [FIXED] #4: composable 缺 refCount 保护

**v1 问题：** `useExtensionWidget` 在 `onMounted`/`onUnmounted` 中注册/注销 listener，split mode 下事件处理翻倍。

**v2 修复（plan.md L562-611）：**
- 模块级 `let refCount = 0`
- `if (refCount++ === 0)` 首次 mount 注册 listener
- `if (--refCount === 0)` 最后卸载时注销 listener + 清空数据
- 不使用 Vue 生命周期钩子，调用方手动在 `onUnmounted` 中调用 `cleanup()`

**验证：** 修复正确。refCount 是模块级变量，多组件实例共享同一计数器。关键路径验证：
1. 组件 A mount → refCount 0→1，注册 listener ✅
2. 组件 B mount → refCount 1→2，跳过注册 ✅
3. 组件 A unmount → refCount 2→1，跳过清理 ✅
4. 组件 B unmount → refCount 1→0，注销 listener + 清空数据 ✅

Task 3b Step 4 明确说明 "注意在 onUnmounted 中调用 cleanup()"。修复充分。

### [FIXED] #5: preflight 传递依赖检查为 TODO stub

**v1 问题：** preflight-check.sh 的传递依赖检查只有 `# TODO` 注释，无实际逻辑。

**v2 修复（plan.md L768-793）：**
- 完整的 bash 脚本：遍历 `node_modules/@zhushanwen/pi-*/package.json`
- 用 `node -e` 提取 `dependencies` + `peerDependencies` 中非 `@zhushanwen/` scope 的包名
- 逐个检查 `node_modules/$dep` 目录是否存在
- 缺失时输出错误信息 + 退出码 1

**验证：** 逻辑正确。`require()` 能正确解析完整路径，`for dep in $deps` 按 whitespace 分割（npm 包名不含空格），`-d` 检查支持 scoped packages（`@scope/name` 路径）。修复充分。

---

## 回归检查

逐项检查 5 处修复是否引入新问题：

| 修复项 | 变更范围 | 回归风险 | 结论 |
|--------|---------|---------|------|
| #1 deduplicate | sort 逻辑从 reverse 改为 forward | 无副作用，排序结果正确 | 无回归 |
| #2 Task 3 拆分 | Execution Groups + Task 列表重组 | BG1 文件数从 10 降至 8（在限制内），FG1 为 4 | 无回归 |
| #3 resolve 签名 | Interface Contracts 文档更新 | 纯文档变更 | 无回归 |
| #4 refCount | composable 新增模块级计数器 | 清理逻辑在最后实例卸载时执行，数据生命周期与组件绑定 | 无回归 |
| #5 preflight | 新增 ~25 行 bash 检查逻辑 | 独立检查段，不影响现有检查步骤 | 无回归 |

---

## 结论

通过。5 条 MUST_FIX 全部修复且修复充分，无回归问题。

### Summary

计划评审第2轮通过，5条MUST FIX全部修复，0条新MUST FIX，0条回归。
