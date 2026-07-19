# Spec Review: file-path-preview-fix

## 审查范围

-  Objective: 修复对话流中点击绝对路径文件时 drawer 预览失败的问题：前端路径拼接和 runtime 守门需正确识别绝对路径/相对路径/~/家目录路径。
-  方法：禁读重建——不读 confirmSpec 文档，只基于 objective 和 clarify 记录重建 FR/AC/决策，再与原 spec 对比。

## 重建结果 vs 原 spec diff

### Functional Requirements

| 重建 FR | 原 spec FR | diff 结论 |
|---|---|---|
| runtime 区分绝对路径/~/家目录/相对路径并正确 resolve | FR-1 runtime 识别绝对路径 | 一致 |
| file.read 不再受 cwd 越界限制 | FR-2 放宽 readFile 预览范围 | 一致 |
| 前端 absolutePath/imageUrl 适配绝对路径 | FR-3 前端正确展示绝对路径 | 一致 |
| cwd 内绝对路径转相对路径用于 gitOverlay/git diff | FR-4 git diff 与绝对路径兼容 | 一致 |
| 文件树浏览接口保留 cwd 守门 | FR-5 文件树浏览守门保留 | 一致 |

### Acceptance Criteria

| 重建 AC | 原 spec AC | diff 结论 |
|---|---|---|
| 绝对路径 /var/folders/... 可预览 | AC-1 | 一致 |
| ~/xxx.md 可预览 | AC-2 | 一致 |
| cwd 内相对路径行为一致 | AC-3 | 一致 |
| cwd 内绝对路径可显示 diff | AC-4 | 一致 |
| runtime 测试覆盖三种路径输入 | AC-5 | 一致 |

### Decisions / Out of Scope

| 重建项 | 原 spec 项 | 结论 |
|---|---|---|
| 放宽预览安全策略、路径识别放 runtime、仅 readFile 放宽、前端新增路径工具、git diff 仍用相对路径 | D1-D5 | 一致 |
| 不做文件树安全策略重写、不做网络/UNC 路径、不改 file.write 骨架 | outOfScope | 一致 |

## 审查结论

-  **完整性**: FR 覆盖 objective 全部诉求；AC 与 FR 对齐；clarify 结论全部落进 spec。
-  **一致性**: FR 之间无矛盾；术语统一（cwd、绝对路径、相对路径、gitOverlay、git diff）。
-  **合理性**: 每个 FR/AC 可验收、可实现；边界场景（cwd 内绝对路径转相对）已覆盖；复杂度评估为 low 合理。

**无 must-fix / should-fix。spec 就绪，可进入 plan 阶段。**
