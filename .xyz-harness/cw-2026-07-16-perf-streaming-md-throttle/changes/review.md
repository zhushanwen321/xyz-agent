# Code Review：perf-streaming-md-throttle（H2 流式 markdown 节流）

## 审查范围

W1 commit 05e5da91：
- `packages/renderer/src/components/panel/message-stream/MarkdownRenderer.vue`（核心实现）
- `packages/renderer/src/__tests__/composables/markdown-renderer.test.ts`（H2-1~H2-7 + rAF mock）
- `packages/renderer/src/__tests__/panel/thinking-md-variant.test.ts`（rAF mock 适配）
- `packages/renderer/src/__tests__/markdown-renderer-fallback.test.ts`（rAF mock 适配）
- `.cw/run-streaming-md-throttle-tests.sh`（testRunner 脚本）

## 审查维度

### 1. 节流逻辑正确性

**scheduleRender / flushRender / doRender 三层职责清晰**：
- scheduleRender：存 pending + 若 rafId===null 才调度（同帧合并，AC-1）✅
- flushRender：rafId 先复位防重入 + 读 pending 最新值（延迟求值守卫，AC-2/AC-7）✅
- doRender：封装原 watch 回调体，序号守卫 + try/catch 降级（AC-5/AC-6）✅

**延迟求值守卫验证**：flushRender 读 pendingContent/pendingLocalFiles（非 scheduleRender 参数快照）。一帧内 content A→B→C，scheduleRender 三次更新 pending 为 C，flushRender 读 C。正确。

**rafId 复位路径**：flushRender 第一行 `rafId = null`，先于 doRender 调用。即使 doRender 抛错（doRender 内部有 try/catch 不外抛），rafId 已复位。异常恢复后新 content 变化能重新调度。AC-6 正确。

**onScopeDispose cancelAnimationFrame**：卸载时取消 pending rAF，flushRender 不会被已 cancel 的回调触发。AC-4 正确。

### 2. 测试质量

**H2-1（AC-1 节流合并）**：100 次 setProps → renderMarkdownSegments 调用 < 50。红灯有效（无节流 ≈100）。但断言 `< 50` 偏宽松——节流后理论应 ≤2（首帧 + trailing）。宽松是因为 `await wrapper.setProps` 的微任务时序可能让部分调用在帧间发生。可接受（核心是证明远小于 100）。

**H2-4（AC-4 卸载安全）**：红灯有效（无节流下 setProps 同步触发 watch → renderMarkdownSegments 被调）。节流后 setProps 排队 rAF，unmount cancel，flushRAF 不触发。正确。

**H2-6（AC-6 异常恢复）**：mockRejectedValueOnce 首渲染降级 → mockResolvedValueOnce + setProps + flushRAF 恢复。验证 rafId 复位后可重新调度。正确。

**既有测试适配**：U9~U13/U15 + thinking-md-variant + fallback 加同步 rAF mock（beforeAll cb(0) 立即执行）。合理——这些用例不验证节流时序，只需 mount 后渲染完成。

### 3. 边界与风险

| 点 | 评估 | 判定 |
|----|------|------|
| pendingLocalFiles 引用赋值 | watch 传 localFiles.value（整体替换非 mutation），pending 持有当前引用。一帧内 localFiles 变两次，scheduleRender 第二次更新 pending 为新引用。flushRender 读最新。正确 | 无问题 |
| watch 解构只取 [text] | scheduleRender 第二参直接读 localFiles.value（响应式 ref，watch 触发时已最新），与解构值一致 | 无问题 |
| SSR/Node 无 rAF | 渲染进程组件（Electron renderer），rAF 必然存在；jsdom 测试已 mock | 无问题 |
| doRender async + 卸载竞争 | flushRender `void doRender()` 即发即弃，doRender await resolve 后写 segments 可能发生在卸载后。但这是 **pre-existing**（原 watch 回调同样 async + await + 写 segments），序号守卫不防卸载。节流未引入新风险 | nit（pre-existing，非本次引入） |
| 后台 tab rAF 暂停 | spec_review SR2 已记录为可接受限制（与 useChatScroll M4 同） | 已知限制 |

## 发现的问题

| ID | severity | description |
|----|----------|-------------|
| R1 | nit | doRender async 卸载竞争（pre-existing，非本次引入，原 watch 回调就有。本次节流未加剧）|

无 must-fix / should-fix。实现正确，测试覆盖 7 个 AC + 既有回归。

## 审查结论

实现通过 review。rAF trailing 节流逻辑正确，延迟求值守卫 + 序号守卫 + 卸载清理三重保护到位，复用 M4 已验证模式。7 个 AC 测试全绿（H2-1~H2-7），既有测试适配同步 rAF mock 后全绿（U14 为 pre-existing baseline failure，与本次无关）。R1 为 pre-existing nit，不阻断。
