# Plan Review: file-path-preview-fix

## 审查范围

- 基于 spec 的 5 个 FR（FR-1 ~ FR-5）和 5 个 AC 做禁读重建，重建 wave 拆分与 changes 列表。
- 与当前 dev-plan.json（修订后）对比，检查覆盖度、架构合理性和可行性。

## 重建结果 vs 当前 plan

### Coverage

| FR | 重建期望 Wave | 当前 plan | 结论 |
|---|---|---|---|
| FR-1 runtime 识别路径类型 | W1 file-service.ts | W1 file-service.ts | 覆盖 |
| FR-2 放宽 readFile 预览范围 | W1 file-service.ts | W1 file-service.ts | 覆盖 |
| FR-3 前端正确展示绝对路径 | W2 path-utils.ts + W3 DetailPane.vue | W2 path-utils.ts + W3 DetailPane.vue | 覆盖 |
| FR-4 git diff 兼容绝对路径 | W2 path-utils.ts + useDetailPane.ts | W2 path-utils.ts + useDetailPane.ts | 覆盖 |
| FR-5 文件树浏览守门保留 | W1 file-service.ts 明确保留 | W1 file-service.ts 已显式描述保留 listTree/expandDir/searchFiles 守门 | 覆盖（已修正） |

### Architecture

- Wave 拆分：W1 runtime、W2 前端逻辑工具、W3 前端 UI。高内聚，依赖链清晰。
- dependsOn：W2 → W1，W3 → W2。无循环，前置合理。
- W2 同时改 path-utils 和 useDetailPane，共 2 个文件，粒度适中；path-utils 是新增工具，useDetailPane 是首个消费点，放在同一 wave 可减少无意义的 wave 数量。

### Feasibility

- 每个 wave 的 changes 描述具体可执行，无外部依赖或模糊项。
- 路径工具函数实现简单，git diff 转相对路径逻辑边界明确。

## 审查结论

**无 must-fix / should-fix。plan 就绪，可进入 tdd_plan 阶段。**
