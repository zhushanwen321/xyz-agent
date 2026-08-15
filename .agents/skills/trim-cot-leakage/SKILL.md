---
name: trim-cot-leakage
description: >-
  清理 prompt 文本/文档中的推理过程泄露。触发词："cot 泄露"、"leakage"、
  "清理草稿痕迹"、"审 prompt 措辞"、"trim cot"。仅用于 xyz-agent 项目。
---

# trim-cot-leakage

Chain-of-thought leakage：视角停留在创作会话而非仓库的文字——引用只有该
会话能看到的产物、叙述改动过程而非当前状态、与已离场的 reviewer 争辩。
修复不是单纯删除：含事实条款的句子先把每条事实重述到 HEAD 可验证，再删掉
周围的叙述；不含任何事实条款的（审计码、控制流叙述）直接删。这是指导不是
脚本。

## 唯一测试

对每段可疑文字问：**一个只读 HEAD、没有任何会话记录/PR 线程/未提交草稿的
读者，能否解析每个引用、验证每个断言？** 不能 → 从仓库视角重述幸存事实，
删其余。能 → 不是 leakage，但可解析只过本 skill 的关：在 current-state
表面（README、docs、JSDoc、prompt）上，可解析的变更叙述仍是变更叙述，
按第 3 类处理。

## 审查范围

- 目标：`.agents/skills/`、`.agents/agents/`、AGENTS.md（根与各子目录）、
  `docs/`、`.cw/` 中的 prompt 文本。
- 排除：`node_modules/`、构建产物（`dist/`、`lib/`、`apps/electron/dist`）、
  记录的模型输出与 fixture——保留原声。
- 明确 scope 再动手；用户没给范围就问。

## 八类 taxonomy

1. **死设计会话引用** — `(decision 7)`、`(audit C2)`、`设计 §4.7`、
   `plan §1.4`、阶段标签（T4、W3、P-I）、「设计台账」等。决定有已提交的
   主人时，按名字和路径引用；否则删引用、把事实条款重述到能独立成立。
2. **stack/PR 视角** — 「这个 PR 加了」「本分支之后」「上一个 commit」。
   改为陈述已落地的机制或扩展点；推迟的工作移到 TODO 标记或 issue。
3. **改动叙述与版本戳** — 「以前」「不再」「旧的 X」、索引性戳（v1、本版、
   这次 cut、与过去对比的「现在」）。陈述当前行为；已修复的回归变成现在时
   反事实（「没有 X 时会发生 Y」），不是仓库历史（「以前会 Y」）。
4. **review 编排** — 「评审时被否」「reviewer 确认了」「第 5 版的本稿」、
   轮次归属。保留幸存的决定与理由作为事实，删掉谁在何时说了什么。
5. **面向 reviewer 的自辩** — 「这个转换是安全的——它只是…」「这是对的
   因为…」。注释论证自己的正确性是在回答 reviewer，不是在服务维护者。
   陈述使代码安全的不变量；代码本身可见时删注释。
6. **复述与推导记录** — 控制流叙述（「先 X 再 Y」）、测试走读、显然分支的
   证明。删；只留不显然的契约或不变量。
7. **模糊与规划残留** — 「暂时应该没问题」「应该够了」、没有标记的推迟。
   升级为 TODO/FIXME，或重述为实际边界；删掉模糊句。
8. **创作语言残留** — 中文正文里残留的英文草稿片段，或英文正文里残留的
   中文工作片段（「端」「设计稿」「---- 私有 ----」分隔线）。翻译或删除。

## 什么不是 leakage（保留规则）

- **issue 引用** — `#1470`、`TODO(name):` 在 HEAD 可解析，任何表面都保留。
- **抑制理由** — `eslint-disable … -- reason`、覆盖率忽略原因、空 catch
  解释是必需 prose；理由写错了就修理由，绝不删。
- **反事实现在时回归钉** — 「没有 X 时会发生 Y」「naive 的 X 会…」。
- **实测边界** — 「（实测：512 层嵌套 ≈ 0.15s）」校准常量，「实测」一词
  承重。
- **运行时新旧状态** — 「旧连接排空后新连接才接受」是运行时生命周期，
  不是变更历史。
- **外部引用** — RFC 标准章节、Figma frame 名；§-禁令只覆盖未提交的内部
  草稿。
- **项目口吻与文体** — 「我们」作项目口吻；设计文档的备选方案章节。

## 工作流

1. 只读审查先行：跑 recall batteries（`--hidden`，搜得到 `.agents/` 与
   `.cw/`），再对每条命中做语义判断。
2. batteries 只是探针不是定义——每轮清理都出现过 batteries 漏掉的案例，
   所以还要对范围内最密集的 prose（模块 JSDoc、README、prompt）做一遍
   无模式通读。
3. 按表面 owner-first 修复：生成物改源（生成模板/源 JSDoc）再重新生成；
   prompt 措辞是行为——改 prompt = 改模型可见行为，走正常 review/测试
   流程，不静默改词。
4. **删除前枚举命题**：删任何东西之前，先枚举该句的所有命题（事实条款），
   逐一对照「过度修剪陷阱」（见下）；只有整句不携带任何命题时才整句删。
5. 验证：重跑 batteries，期望只剩 sanctioned keeps；确认每个残留引用在
   HEAD 可解析；跑改动面相关检查（改 prompt/文档 → 对应 lint/文档检查
   + 正常 review）。

## 过度修剪陷阱（删除前逐条对照）

1. **义务翻转成背书** — 「这些注册是例外，待迁移到 slots」删成「这些注册
   是受认可的例外」把义务变成了祝福现状。删法不能改变句子的情态。
2. **假想提升为已发布功能** — 「未来的 IPC shell 会继承 executor」删掉
   「未来的」变成声称该类已发布。明确标记假想，而不是只去掉未来标记。
3. **连叙述带真事实一起删** — 半句是叙述、半句是承重耦合时，删子句不删
   整句。
4. **保留数字丢了出处** — 「4 MiB 上限是实测的：最大模块 3.1 MiB」删成
   「上限 4 MiB；最大模块 3.1 MiB」，丢了「实测」出处，数字从观察变成
   定义。

## Recall batteries（grep 模式清单）

命中要语义判断：batteries 故意过度匹配，也会天然漏匹配。零命中没有任何
证明力——先用已知阳性文本验证模式本身能命中。

```sh
# 调用规则：--hidden 搜到 .agents/.cw；排除项放最后，避免被后续 include 重新纳入
rg -n --hidden --glob '!node_modules/**' --glob '!**/dist/**' --glob '!.git/**' \
  --glob '!**/__tests__/**' <模式> <scope>
```

英文 battery（自然语言行加 `-i` 以命中句首大写；第一条代码向模式保持大小写
敏感，`-i` 会把 `\bT\d\b`、`\bP-I\b` 变成噪音）：

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' <scope>
rg -n --hidden -i 'this PR|this branch|this stack|later PR|previous commit|this commit' <scope>
rg -n --hidden -i 'used to |no longer|previously|the old |was renamed|was moved' <scope>
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' <scope>
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' <scope>
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' <scope>
rg -n --hidden '§\d' <scope>
```

中文 battery：

```sh
rg -n --hidden '设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有' <scope>
rg -n --hidden '(^|[^a-zA-Z])端([^a-zA-Z]|$)' --glob '*.md' <scope>
```

已知误报族（清理时见过、判定保留）：

- **工具性 used to** — 「the key used to sign requests」是用途不是时间；
  时间形态在主语后有状态（「colors used to come from…」）。
- **运行时新旧** — 「旧连接排空后新连接才接受」是运行时对象不是仓库状态。
- **流程文档里的 PR** — 讲 PR 流程的文档说「PR」是合法的；禁令针对的是
  某篇文档采用单个 PR 的视角谈代码。
- **v1 作协议/路径段** — `/v1/chat` 端点是标识符不是版本戳。
- **§N 有已提交的主人** — 外部标准与拥有自己 §-编号的已提交文档按章节
  引用合法。
- **「本版本」vs「本版」** — 「本版本」在版本化语境是「this release」的
  合法表达；被禁的索引戳是裸的「本版」。
- **生成物里的「今天」** — 生成的 timestamp 与 CLI 输出样本保留原声。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结的规则。来自实际事故和教训 | **不允许删除或削弱**，只能在原有基础上补充 |
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
