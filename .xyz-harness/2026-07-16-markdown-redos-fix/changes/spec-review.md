# Spec Review: markdown-redos-fix

## 审查范围

执行「禁读重建」：派 fresh subagent，仅给 objective + clarifyRecords（不读 specSections / confirmSpec），从源头重建 spec，再与初稿 diff。

重建章节：FR（功能需求）+ AC（验收标准）+ 决策 + 不做范围 + 预判遗漏点。

## diff 结果

初稿方向正确、范围清晰，无矛盾、无阻塞性遗漏（must-fix = 0）。重建发现 4 个 should-fix：均为 AC 覆盖面不足或可维护性遗漏，不影响 spec 方向，在 plan/tdd_plan 阶段补齐即可。

## 发现的问题

| ID | severity | dimension | ref | 描述 |
|----|----------|-----------|-----|------|
| SR1 | should-fix | completeness | AC-1 | 初稿 AC-1 只提 FILEPATH_RE 性能断言，未明确 BASENAME_RE（L243，同构病态）也需独立性能测试。两条正则同病，必须同测 |
| SR2 | should-fix | completeness | AC-3 | 初稿 AC 只覆盖 filepathRule（inline rule）路径识别，未验收 linkifyFilePathsHtml（code_inline renderer，L310）这一共用正则的第二条路径。两路共用一改两受益，但 code_inline 输入粒度（单 token content）与 filepathRule（整段剩余）不同，需独立验证不回归 |
| SR3 | should-fix | reasonableness | AC-1/AC-2 | 纯计时断言在 CI 上易 flaky（计时抖动）。需补充静态结构断言兜底：正则源码不得出现 `)+)+`、`)*)+`、`)+)*` 嵌套量词模式。静态断言零抖动，与动态计时双保险 |
| SR4 | should-fix | reasonableness | — | markdown.ts L230/L243 附近的注释描述了「路径段允许空格」「嵌套量词」等 W2 引入的语义。重写后这些注释会变成误导性僵尸注释，须同步更新/删除 |

## 补充边界用例（重建预判点，并入 AC-5）

- `src/Makefile`（无扩展名 + 含字母）→ 命中（初稿 AC-4 已覆盖）
- `src/123`（无扩展名 + 纯数字）→ 不命中（初稿未覆盖，前瞻与无扩展名可选的交互边界）
- 路径出现在剩余串中部（前有其他文本）→ 边界符集合触发命中（初稿未覆盖，filepathRule 输入是 slice(pos) 整段剩余）

## 处理计划

4 条 should-fix 均不阻断进 plan，在 plan 阶段的 Wave 拆分和 tdd_plan 阶段的 test.json 中落实：
- SR1/SR2/SR3 → tdd_plan 的 testCases 补 BASENAME_RE 性能用例、code_inline 路径用例、静态结构断言用例
- SR4 → dev 阶段 Wave 内一并更新注释

## 审查结论

spec 就绪进 plan。无 must-fix。should-fix 在后续阶段补齐，不回流 spec_review_fix。
