# Plan Review: improve-file-path-preview

## 审查范围

- 重建输入：spec FR-1 ~ FR-5 + AC-1 ~ AC-5（AC 在 tdd_plan 阶段以 testCases 落地）
- 重建 wave 拆分：
  - FR-1（~ 图片）+ FR-2（Windows）→ W1
  - FR-3（正则扩展）→ W2
  - FR-5（搜索面板可程序打开）→ W3
  - FR-4（失败 fallback）→ W4（依赖 W3）
- 与当前 dev-plan diff

## 覆盖度

| FR | Wave | Changes | 是否覆盖 |
|---|---|---|---|
| FR-1: ~ 图片预览 | W1 | main.ts 展开 ~；DetailPane.vue 使用 absolute | 是 |
| FR-2: Windows 兼容 | W1 | path-utils.ts 处理 Windows 路径；DetailPane.vue 使用 absolute | 是 |
| FR-3: 扩展正则 | W2 | markdown.ts 正则扩展 | 是 |
| FR-4: 失败 fallback 搜索 | W4 | useMarkdownInteractions.ts 打开搜索面板 | 是 |
| FR-5: 搜索面板可程序打开 | W3 | useSearchModal.ts + Sidebar.vue + SearchModal.vue | 是 |

每个 AC 在 tdd_plan 阶段都有对应的 testCase 出口（AC-1 图片渲染集成、AC-2/3 单元测试、AC-4/5 组件/集成测试）。

## 架构合理性

- W1 和 W2 无依赖，可并行开发。
- W3 是 W4 的前置，dependsOn 正确。
- W4 只改 useMarkdownInteractions 和 MarkdownRenderer，职责单一。
- 没有巨型 wave，每个 wave 改动 2-3 个文件。

## 可行性

- W1 的 main.ts 改动在主进程，需要验证 protocol handler 行为，可通过单元测试覆盖。
- W3 的 useSearchModal 模式与 useSideDrawer 同构，复用现有单例模式。
- W4 的 fallback 逻辑依赖 fileApi.read 的 reject，现有 API 已支持。

## 发现的问题

无 must-fix / should-fix。

## 审查结论

Plan 覆盖完整、架构合理、可行。可以进入 tdd_plan。
