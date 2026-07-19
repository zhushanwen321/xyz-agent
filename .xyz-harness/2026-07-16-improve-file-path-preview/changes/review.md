# Code Review: improve-file-path-preview

## 审查范围

- 审查 commit：d8cd35d7（W1）、5668fd29（W2）、be9fc0e0（W3）、4903a982（W4）
- 文件：
  - `packages/renderer/src/lib/path-utils.ts`
  - `apps/electron/main/utils/path.ts`
  - `apps/electron/main/main.ts`
  - `packages/renderer/src/composables/logic/markdown.ts`
  - `packages/renderer/src/composables/features/useSearchModal.ts`
  - `packages/renderer/src/components/sidebar/Sidebar.vue`
  - `packages/renderer/src/components/overlays/SearchModal.vue`
  - `packages/renderer/src/composables/panel/useMarkdownInteractions.ts`
  - 测试文件 4 个

## 设计一致性（禁读重建）

从 spec FR/AC 反查实现：

| FR/AC | 实现路径 | 状态 |
|---|---|---|
| FR-1 ~ 图片预览 | `apps/electron/main/utils/path.ts` + `main.ts` 展开 `~`；`DetailPane.vue` 已用 `resolvePreviewPath` | 通过 |
| FR-2 Windows 路径 | `packages/renderer/src/lib/path-utils.ts` 统一分隔符 | 通过 |
| FR-3 扩展正则 | `packages/renderer/src/composables/logic/markdown.ts` 允许空格和可选扩展名 | 通过 |
| FR-4 失败 fallback | `useMarkdownInteractions.ts` 含/路径失败/0 匹配打开搜索面板 | 通过 |
| FR-5 搜索面板可打开 | `useSearchModal.ts` + `Sidebar.vue` + `SearchModal.vue` | 通过 |
| AC-1 ~ 图片 | `main/test/local-file-protocol.test.ts` | 通过 |
| AC-2 Windows relative | `renderer/src/__tests__/lib/path-utils-improve.test.ts` | 通过 |
| AC-3/4 正则 | `renderer/src/__tests__/composables/markdown-filepath.test.ts` | 通过 |
| AC-5 搜索面板预填 | `renderer/src/__tests__/composables/useSearchModal.test.ts` | 通过 |
| AC-6 失败 fallback | `renderer/src/__tests__/composables/useMarkdownInteractions-fallback.test.ts` | 通过 |

## 类型安全

- 新增类型 `OpenSearchModalOptions`、`ResolvePreviewPathResult` 完整。
- 无 `any` 引入。
- `Sidebar.vue` 用 `const { isOpen } = useSearchModal()` 解构后绑定 `v-model:open="isOpen"`，类型正确。

## 错误处理

- `useMarkdownInteractions` 对 `fileApi.read` 失败走 `.catch()` 打开搜索面板，不静默吞错。
- `local-file` handler 仍保持 403 拒绝越界路径。

## 边界条件

- `isAbsolutePath('')` 返回 false，`resolvePreviewPath` 对空路径会当作相对路径（返回 `cwd/`），但 preview 入口有前置检查。
- `~` 路径保持原样展示，由主进程展开。
- 测试覆盖 Windows 混合分隔符、带空格路径、无扩展名路径。

## 测试质量

- 测试覆盖：每条 FR 至少一个 case。
- 测试能发现真 bug：U1 能发现 Windows 路径推导错误；U6 能发现 fallback 未触发。
- 测试盲区：
  - 未覆盖 `~` 路径在 renderer 侧拼成 `local-file://` 的 URL 形态（只测了主进程展开）。
  - 未覆盖 `useSearchModal` 与 `SearchModal.vue` 的 query 双向同步（组件级测试缺失）。
  - 未覆盖 `useMarkdownInteractions` 中文件成功打开路径（只测了失败 fallback）。

## 计划完成度

- W1/W2/W3 完全落地。
- W4 原 plan 写了 `MarkdownRenderer.vue` 改动，但实际不需要（`useMarkdownInteractions` 自己调用 `useSearchModal`），未改动。功能已满足 FR-4，可接受。

## 发现的问题

| severity | dimension | 描述 | ref |
|---|---|---|---|
| nit | design-consistency | W4 plan 中 MarkdownRenderer.vue 未改动，说明 wave 计划时过度拆解 | W4 |
| nit | test-coverage | 缺少 SearchModal.vue 与 useSearchModal 的组件级同步测试 | SearchModal.vue |

## 审查结论

无 must-fix / should-fix。代码符合 spec，四个 wave 的 changes 基本落地，测试覆盖核心路径。可以进入 test 阶段。
