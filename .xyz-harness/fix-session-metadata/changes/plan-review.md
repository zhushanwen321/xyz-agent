# Plan Review: fix-session-metadata

## 审查方法

禁读重建：派 fresh subagent 从 spec FR/AC 重建 wave 拆分，与 dev-plan.json diff。

## 重建结果

重建产出 5 个 wave（W1 rename → W2 sidecar write → W3 sidecar read → W4 cleanup → W5 verify）。

## Diff 分析

初稿 2 个 wave：W1（sidecar 全量：FR-1/2/3/4）+ W2（rename：FR-5）。

重建把 sidecar 拆成 3 个 wave，但 session-file-utils.ts 是所有 sidecar 改动的核心文件（persistSessionEnd + extractSessionOutcome 在同一文件），拆成多个 wave 会导致同一文件的多次 commit，降低 review 效率。初稿合并为 W1 更合理（高内聚）。

W5（接口一致性验证）是纯验证，AC-10 可在 tdd_plan/test 阶段覆盖，无需独立 wave。

### 发现的问题

| # | severity | dimension | 描述 | ref |
|---|----------|-----------|------|-----|
| PR1 | should-fix | coverage | AC-10（ISessionStore 接口不变）无明确验证路径，建议在 W1 的 session-service.ts description 中补充"确认 ISessionStore 接口签名不变" | W1 |

### 审查结论

无 must-fix。1 个 should-fix 可在 dev 阶段关注。plan 就绪，可进 tdd_plan。