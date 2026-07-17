# Code Review: file-path-preview-fix

## 审查范围

- 审查 commit：0f8f00ac（W1）、f456fa88（W2）、cf05b1a9（W3）
- 文件：
  - `packages/runtime/src/services/file-service.ts`
  - `packages/runtime/test/file-service.test.ts`
  - `packages/runtime/test/file-service-real.test.ts`
  - `packages/renderer/src/lib/path-utils.ts`
  - `packages/renderer/src/composables/features/useDetailPane.ts`
  - `packages/renderer/src/__tests__/lib/path-utils.test.ts`
  - `packages/renderer/src/components/panel/DetailPane.vue`

## 逐维度审查

### design-consistency（对照 spec）

| FR | 期望实现 | 实际实现 | 结论 |
|---|---|---|---|
| FR-1 runtime 识别路径类型 | readFile 内部区分绝对路径/~/相对路径 | file-service.ts 使用 `isAbsolute` + `expandHome` | 通过 |
| FR-2 放宽 readFile 预览范围 | 去掉 readFile 的 cwd 越界守门 | 已移除 `isUnderOrEqual` 守门，保留其他错误处理 | 通过 |
| FR-3 前端正确展示绝对路径 | DetailPane 的 absolutePath/imageUrl 不拼 cwd | 已使用 `resolvePreviewPath` | 通过 |
| FR-4 git diff 兼容绝对路径 | useDetailPane 将 cwd 内绝对路径转相对路径 | 已新增 `gitPath` 参数，用 relative 查 gitOverlay 和 git diff | 通过 |
| FR-5 文件树浏览守门保留 | listTree/expandDir/searchFiles 仍限制 cwd | 未改动这些函数，守门保留 | 通过 |

### plan-completeness

- W1: file-service.ts + 测试文件 → 已落地
- W2: path-utils.ts + useDetailPane.ts → 已落地
- W3: DetailPane.vue → 已落地

全部通过。

### type-safety

- 新增函数有完整类型签名，无 `any`。
- `loadContent` 新增 `gitPath: string | null` 参数，调用方类型匹配。
- `resolvePreviewPath` 返回类型结构清晰。

### error-handling

- readFile 去掉 cwd 守门后，仍通过 `callFs` 转 `ENOENT/EACCES` 为 `FileError`。
- `gitPath` 为 `null` 时，`loadContent` 回退原始 `path` 调 `gitApi.getDiff`，由 GitService 自身校验并抛错，不引入新的静默失败。

### edge-case

- 路径为空：DetailPane 和 useDetailPane 均有 early return，不会进入解析。
- `~` 路径：前端保持原样展示，runtime 负责展开；文本预览已覆盖。
- cwd 为空：`resolvePreviewPath` 对相对路径会生成 `/${path}`，但 preview 场景 cwd 始终非空，当前可接受。
- Windows 绝对路径：`isAbsolutePath` 已支持盘符路径，但 `resolvePreviewPath` 的 relative 推导使用 `/` 分隔符，跨平台细节可后续补强。

### test-coverage

- runtime file-service 单测覆盖相对/绝对/`~`/cwd 外绝对路径。
- 前端 path-utils 单测覆盖 Unix/Windows/`~`/相对路径。
- DetailPane.vue 的渲染断言当前依赖 manual 验收（AC-1/AC-2/AC-4），未自动化 UI 测试。

## 发现的问题

| severity | dimension | 描述 | ref |
|---|---|---|---|
| nit | edge-case | `resolvePreviewPath` 在 `cwd` 为空时，相对路径会生成 `/${path}`，可考虑单独处理 | `packages/renderer/src/lib/path-utils.ts:33` |
| nit | edge-case | `~` 路径的图片预览当前会失败（`local-file://` 无法解析 `~`），后续可在 protocol handler 中支持 | `apps/electron/main/main.ts:142` |
| nit | test-coverage | 缺少 DetailPane.vue 的渲染测试，AC-1/AC-2/AC-4 依赖手工验证 | `packages/renderer/src/components/panel/DetailPane.vue` |

## 审查结论

无 must-fix / should-fix。代码符合 spec，三个 wave 的 changes 全部落地，类型安全、错误处理、核心边界均已覆盖。可直接进入 test 阶段。
