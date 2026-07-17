# Code Review: markdown-redos-fix

## 审查范围

- commit: af0ff310（fix(W1): FILEPATH_RE 改线性无回溯结构 + 段含字母前瞻）
- 文件: markdown.ts（正则重写 + 导出 + 注释）、markdown-filepath.test.ts（重写 18 用例）

## 审查维度结论

### plan-completeness（plan 完成度）
W1 三条 changes 全落地：
- change 1（FILEPATH_RE 线性化）：✅ 嵌套量词 → 单层 `[chars]+(?:\/[chars]+)+`，额外加段含字母前瞻
- change 2（BASENAME_RE 同构修复）：⚠️ nit（见下方 nit 区）
- change 3（注释更新）：✅ 删除 W2 空格支持描述，改为线性结构 + 段含字母设计说明

### design-consistency（设计一致性，禁读重建反查）
逐 FR 反查实现：
- FR-1 消除回溯：✅ AC-9 静态断言证明无嵌套量词，AC-1 性能 0.04ms
- FR-2 含分隔符路径识别：✅ AC-3 覆盖相对/绝对/家目录/中部路径
- FR-3 裸 basename 识别：✅ BASENAME_RE 导出，AC-7 性能断言
- FR-4 误识别防御：✅ AC-5 覆盖 glm-5.2/node-18.0/pi-3.14/src-123

### test-coverage（测试质量）
测试有真防线，非覆盖率填充：
- AC-9 静态结构断言：能抓「未来谁又加回嵌套量词」（零抖动兜底）
- AC-1/AC-7 性能断言：能抓「正则退化导致回溯」
- AC-5 误识别：能抓「启发式误判」（开发中实际抓到 node/18.0 等真 bug）
- AC-2 真实渲染：模拟 cw-cli SKILL.md 触发块，能抓「大文档卡死回归」

### edge-case（边界条件）
开发中发现 `src/123`（纯数字段 + 无扩展名）会误识别——「扩展名可选」让正则退化为纯段匹配。通过段含字母前瞻修复并补测试用例。此边界在初始 spec 未预见，TDD 红灯阶段暴露，已在实现中覆盖。

## nit（不进 issues，仅记录）

- N1: plan change 2 描述为「BASENAME_RE 重写为单层」，实际 BASENAME_RE 本就无嵌套量词（`[chars]+\.(?=...)[ext]` 单层），仅做了 export 导出。不需结构性重写——修本来没坏的东西是正确的，但 plan 描述应更准确。不影响功能。

## 审查结论

代码就绪进 test。无 must-fix，无 should-fix。实现根除了 ReDoS 回溯根因，顺带修复了开发中发现的纯数字段误识别 bug，测试设计有真防线。
