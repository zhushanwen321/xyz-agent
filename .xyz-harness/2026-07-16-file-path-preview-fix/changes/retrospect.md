# Retrospect: file-path-preview-fix

## 执行概览

- 目标：修复对话流中点击绝对路径文件时 drawer 预览失败的问题。
- 实际产出：
  - runtime `FileService.readFile` 支持绝对路径 / `~/` 家目录路径，并去掉 cwd 越界守门。
  - 前端新增 `lib/path-utils.ts`，`useDetailPane` 和 `DetailPane.vue` 正确识别绝对路径并展示。
  - 8 个 testCase（7 mock + 1 real）全部通过。
- 首次通过率：
  - clarify/spec_review/plan/plan_review/tdd_plan/review/test 均首次通过。
  - dev 阶段 W3 commit hash 第一次手误传错，修正后通过（非实现问题）。

## 关键决策回顾

1. **预览安全策略放宽到「可读任意文件」**：用户已确认。这是本次改动的最大决策点，风险已在前端/运行时边界处理中保留（权限/不存在错误仍正常返回）。
2. **路径识别放在 runtime**：避免前后端重复解析，前端只做展示级适配。
3. **文件树浏览守门保留**：`listTree/expandDir/searchFiles` 仍限制在 cwd 内，与单文件预览安全模型区分。

## 已知风险

| 风险 | 严重度 | 说明 |
|---|---|---|
| `~` 路径的图片预览不支持 | medium | 前端 `local-file://` URL 不会展开 `~`，图片类文件会走失败占位；文本预览正常。可在 Electron protocol handler 层支持 `~` 展开。 |
| Windows 绝对路径的 relative 推导未在真实环境验证 | medium | `isAbsolutePath` 支持 `C:\` 盘符，但 `resolvePreviewPath` 用 `/` 分隔符推导 relative，Windows 真实运行可能有边角偏差。 |
| 缺少 DetailPane.vue 渲染级自动化测试 | low | AC-1/AC-2/AC-4 为 manual，本次用单测覆盖路径工具，UI 渲染未自动化。 |
| 放宽 readFile 后相对路径 `../etc/secret` 会解析为 `/etc/secret` | low | 这是预期行为变更，但保留了文件系统权限守门；未引入新的越界读取能力（进程本来就能读）。 |

## 流程问题

1. **写测试前未检查文件是否存在**：tdd_plan 阶段误以为 `packages/runtime/test/file-service.test.ts` 是新建文件，`write` 覆盖了已有测试。恢复后合并测试才正确。教训：写测试前先 `read` 或 `git ls-files` 确认文件是否存在。
2. **edit 工具漏传 path 参数**：dev 阶段连续多次 `edit` 调用忘记传 `path`，导致 `EISDIR`。这是操作失误，已修正。

## 改进建议

- 给 `resolvePreviewPath` 增加单元测试覆盖 `cwd` 为空 / Windows 路径的边界。
- 后续若支持 `~` 图片预览，应在 Electron `local-file` protocol handler 中统一展开 `~`。
- 对涉及已有测试文件的改动，强制先读原文件再决定追加/修改。
