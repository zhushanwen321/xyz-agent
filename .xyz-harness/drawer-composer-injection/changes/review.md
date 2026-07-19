# Code Review — drawer-composer-injection（W1-W5）

**审查日期**: 2026-07-17
**审查范围**: 5 commit（bf92a4dd..e78c8eef），6 源文件 + 6 测试文件
**测试状态**: 46 测试全绿（9 文件：6 本次 + 3 回归）

## 阻塞性问题（blocker）

### B1. 选区 bubble 点击前被 mouseup 清掉（FR-4 实际不可用）
**file**: DetailPane.vue:159-178, onContentMouseup
**问题**: bubble 渲染在绑定了 @mouseup 的 contentRef 内。真实点击流程：mousedown 折叠选区 → mouseup 冒泡到 contentRef → onContentMouseup 检测 sel.isCollapsed=true → selectionRange=null → bubble 卸载 → 按钮 click 永不触发。测试因 mock getSelection + 直接 trigger('click')（不经 mouseup）掩盖了此 bug。
**severity**: blocker
**修复**: bubble 按钮加 @mousedown.prevent（阻止 mousedown 折叠选区）

## 主要问题（major）

### M1. file segment 行范围在 segmentsToPrompt 被丢弃
**file**: packages/shared/src/segments.ts:57（segmentsToText file case）
**问题**: segmentsToText 把 {type:file,lineRange:[10,20]} 序列化为仅 path，lineRange 丢失。useChat.send 用 segmentsToPrompt 发给 pi，LLM 看不到行号。FR-4/5 行范围注入的核心价值丢失。chip DOM / badge 渲染 / store 都正确携带 lineRange，唯独发给模型时丢了。
**severity**: major
**修复**: segmentsToText 的 file case 用 D2 格式序列化 lineRange（path:L<n> / path:L<s>-L<e>）

### M2. target=new 双 composer 挂载时 panel 误触 startFlow 拆 session
**file**: useComposerInjection.ts:77-114
**问题**: landing + panel 同时挂载（dual 状态）时，target=new 请求两个 watch 都触发：landing 消费（applyInjection+clear），panel 的 target=new 分支无条件 startFlow+routeToLanding。startFlow 强制 session.activeId=null + panel.loadSession(null) 拆除 panel 活跃 session。测试 U9 只挂 panel 未挂 landing，未覆盖双挂载。
**severity**: major
**修复**: panel 的 target=new 分支只在当前 session 是活跃 session 时才 startFlow（sessionId.value === sessionStore.active?.id），否则不触发（已有 landing 处理）

## 次要问题（minor）

### m1. W4 diff 模式行范围反推失效
**file**: DetailPane.vue:382-391 onContentMouseup
**问题**: diff 模式 state.content 是 patch 字符串，选中行（如 +new line）匹配不到 patch 原始行 → idx<0 → bubble 不出。应在 diff 模式禁用 bubble 或从 DOM 算行号。
**severity**: minor
**修复**: diff 模式（state.viewMode==='diff'）禁用 bubble，加注释说明

### m2. Turn.vue file badge testid 非唯一
**file**: Turn.vue:84
**问题**: `:data-testid="msg-file-badge"` 模板字面量无插值，所有 badge 同 testid。
**severity**: minor
**修复**: 去掉模板字面量改普通字符串，或加索引后缀

## 审查结论

1 blocker（B1）+ 2 major（M1/M2）必须修。B1 使 FR-4 选区 bubble 实际不可用；M1 使行范围发给 LLM 时丢失；M2 在 dual 挂载下误拆 session。进 review_fix 修复 B1/M1/M2/m1/m2。
