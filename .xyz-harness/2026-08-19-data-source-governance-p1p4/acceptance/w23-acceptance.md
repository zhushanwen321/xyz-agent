# W23 验收标准：ADR-0062 落档 + ADR-0042 修订 + review checklist

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §6 W23 节（L700-722）是 W23 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W11、W13、W18（ADR 记录已发生的裁决——三 wave committed 后本 wave 才派）。
> **纯文档 wave：`git diff --stat` 仅 3 文件 ≤120 行，无代码改动**。

## 目标（一句话）

架构决策落档：新 ADR-0062「单一数据 owner + 绝对写规则」；修订 ADR-0042 与前案 W1 sidecar 实现的矛盾；review checklist 准绳切换。

## 交付物

1. `docs/adr/0062-single-data-owner-absolute-write-rule.md` [新增]（编号顺延已核实：当前最高 0061）：内容 = 判据（D1 缓存第二写入者判定表）/ 事件只做失效 / pi JSONL 唯一写方 = pi 进程（含扩展经 pi API）/ sidecar 是登记在案的 xyz 自有合法形态（D3，四后缀家族）/ 队列按字段分权威（D6）/ ReplicatedState 配置即登记条目
2. `docs/adr/0042-runtime-session-end-entry.md`（修改：正文「append JSONL」原决策更新为「runtime 单写 sidecar」+ 顶部修订记录块（date + **ADR-0042 前案 W1** 引用——历史 effort 的 W1，非本计划 wave W1，防归因错误）；不动其他历史内容）
3. `.agents/skills/pr-cr-fix/agents/review-data-governance.md`（修改：checklist 准绳从「父文档 §2.2 清单」切换为「登记表」+ 附 ADR-0062 引用；pr-cr-fix SKILL.md 维度表不动——8 维已含）

## 通过命令（builder 自验 + verifier 实跑）

1. `grep -n "绝对写规则\|单一数据 owner" docs/adr/0062-*.md` 命中；ADR-0042 含修订记录块（grep "修订" 命中且含 sidecar 与前案 W1 引用字样）
2. 一致性：ADR-0062 的 sidecar/队列分工表述与登记表（W2/W19 终态）交叉核对无矛盾（汇报列核对结论）
3. `git diff --stat` 仅 3 文件 ≤120 行

## 禁改清单

- 一切代码；pr-cr-fix SKILL.md 维度表；其他 ADR
- 禁 git 写操作

## 备注

- 完成后 P4 剩 W24/W25。
