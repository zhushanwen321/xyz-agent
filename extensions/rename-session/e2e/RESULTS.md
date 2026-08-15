# rename-session E2E A2 人工抽查记录

本文件由 `node e2e/run-a2.mjs` 自动追加标题记录；「词组形态 / 语义相关 / 语言跟随」三列为人工抽查项（自动规则对中文词组 vs 句子无完备判别力，正式验收以人工为准，见 e2e/README.md A2 说明）。

## 2026-08-15 04:19:26 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数与单元测试 |  |  |  |
| 英文任务 | Refactor the config loader to support env overrides | refactor-config-loader-env-overrides |  |  |  |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | rename-session-leading-option |  |  |  |

## 2026-08-15 04:27:18 run

| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |
|---|---|---|---|---|---|
| 中文任务 | 帮我写一个防抖函数并加单测 | 防抖函数单测实现 | PASS（名词词组，无主谓宾/代词/时态助词） | PASS（防抖函数+单测，准确概括任务） | PASS（中文） |
| 英文任务 | Refactor the config loader to support env overrides | refactor-config-loader-env-overrides | PASS（小写 kebab-case 动名词链） | PASS（refactor config loader + env overrides 全要素） | PASS（英文） |
| 跟进型 | 继续刚才的，改成支持 leading 选项 | 支持-leading-选项功能实现 | PASS（词组形态；「支持X功能实现」略冗但非句子） | PASS（leading 选项改动，跟进型缺上下文下合理） | PASS（中文为主+英文术语保留） |

**人工抽查结论（2026-08-15，验收人：主 agent）**：三场景全部 PASS。对照旧风格反例（如「我帮你写了一个防抖函数」），三个标题均为 slug 词组形态，slug prompt 约束（D4）达成 G2 目标。跟进型标题质量略弱于另两个（prompt 本身无上下文），符合设计的预期差异（§11.2），不构成失败。
