# W23 验收报告：ADR-0062 落档 + ADR-0042 修订 + review checklist

**结论：PASS**

- verifier：对抗验收（独立复核，非 builder 自验）
- 基线：ed26b3da8；验收时 HEAD：eb4f8628f（ledger commit，非 W23 交付内容）
- 验收时 git status：`M .agents/skills/pr-cr-fix/agents/review-data-governance.md` / `M docs/adr/0042-runtime-session-end-entry.md` / `?? docs/adr/0062-single-data-owner-absolute-write-rule.md`——与交付清单一致，无 W15/W24 在途文件

## 检查点 1：防篡改 — PASS

- `git diff ed26b3da8 -- .xyz-harness/.../acceptance/w23-acceptance.md` 输出为空（exit 0）
- `git diff ed26b3da8 -- docs/architecture/data-source-governance-plan.md` 输出为空——plan §6 W23 节（L700-722）未改
- `git diff ed26b3da8 --stat -- docs/adr/` 仅 1 文件（0042，+5/-1）；其他 ADR 零改动；0061 仍为既有最高编号 ADR，0062 为纯新增

## 检查点 2：范围 — PASS

- git status 仅 3 文件；`packages/`、`taste-lint/` 零触碰；pr-cr-fix SKILL.md 未动
- `git diff --stat`：2 files，7 insertions(+), 3 deletions(-)；untracked ADR-0062 实测 `wc -l` = 52 行
- 总量 62 行（52 + 7 + 3，builder 口径）或 59 行（52 + 7 插入口径），任一口径 ≤ 120 ✓

## 检查点 3：ADR-0062 内容完整性 — PASS

六块决策逐一存在（行号为当前文件实测）：

| 决策块 | 位置 | 核对 |
|---|---|---|
| D1 缓存第二写入者判定表 | L13-22 | 判据句与父文档 L181 逐字一致；判定表两行（纯派生缓存→保留 / 影子状态库→收编或删除）判据可操作 |
| pi JSONL 唯一写方（含扩展 appendEntry） | L24-26 | 「扩展经 pi.appendEntry 写的 custom entry 由 pi 自己持久化，写方仍是 pi」与父文档原则①一致 |
| sidecar 四后缀（D3） | L30 | 与登记表 §4⑤ 逐字同集（见检查点 6） |
| 事件只做失效 | L36-37 | 含登记例外（applyEntry reducer / queue_update 对账）与补充形态（RPC 响应驱动失效） |
| 队列按字段分权威（D6） | L40-41 | 五要素与登记表 #6 + 例外④ 一致（见检查点 6） |
| ReplicatedState 配置即登记条目 | L44-45 | 与登记表表头声明 2 一致 |

- 后果节 L52 含 ADR-0042 修订追认（「本 ADR（D3 选项 a）追认该形态为 sidecar 家族合法成员」）✓
- 实现引用事实性抽查全真：`persistSessionEnd`（session-file-utils.ts:138，与登记表行号一致）、`scanSessionMeta`（SFU:581，session-scanner.ts 消费）、`createForkedSessionFile`（session-fork.ts 存在）、`replicated-states.config.ts`（services/session/ 下存在）

## 检查点 4：ADR-0042 修订质量 — PASS

- 修订记录块（L6）三要素齐：date 2026-08-19 + 前案 W1 消歧（「历史 effort 的 W1 sidecar 修订，非 data-source-governance 计划的 wave W1——该计划 W1 是活跃 label 直写切 RPC，与 sidecar 无关」）+ sidecar 现行决策（persistSessionEnd 细节 + ADR-0062 追认链接）
- git diff 实测：仅状态行扩展（1 删 1 加）+ 顶部修订记录块（1 加）+ 决策节修订标注（1 加）+ 空行（2 加）；「append JSONL」原决策全文、替代方案节、后果节零删改——历史原貌保留 ✓
- 通过命令 1 后半：`grep -n "修订" docs/adr/0042-*.md` 3 处命中，sidecar 与「前案 W1」字样均在 ✓

## 检查点 5：checklist 切换 — PASS（含裁决）

- 准绳句（L8）已从「落地前以设计文档 §2.2 的 12 类清单为准绳」切换为「登记表 SSOT + ADR-0062 + 父文档」三层引用；`grep "§2.2" review-data-governance.md` 无命中（exit 1），残留 = 0 ✓
- 背景契约修正裁决：**builder 判定合理，修正属切换必要组成**。依据：①原句「当前唯一合法 legacy 例外 = 非活跃 session rename 直写（带移除期限）」在 W11 后失实——登记表 L9「W11 之后——xyz 对 pi JSONL 的直写链路全部消灭…R1 allowlist 空集」、L71「①-③ 已移除（W11）」；②该文件明确指示 review agent「背景契约当作前提，不要重新怀疑」——保留过时句会导致 review agent 放行已消灭的直写形态、同时漏列 sidecar/fork 两类新合法形态，两个方向都错。修正后表述与登记表 W11 终态逐点一致。

## 检查点 6：一致性独立复核 — PASS（4 条，超出最低 2 条）

1. **sidecar 后缀集合**：登记表 §4⑤「.meta.json / .preset.json / .project.json / .handoff.json」↔ ADR-0062 决策 2 ↔ checklist L14，三处 grep 实测同集（含「xyz 自有文件」定性、「写前 existsSync 守卫防 openSync("wx") 竞态」「R1 内置豁免与条目一一对应」三细节一致）
2. **R1 allowlist 空集**：登记表 L9/L52/L71 ↔ ADR-0062 背景（「R1 allowlist 空集」）↔ checklist L14（「W11 后 R1 allowlist 空集」），一致
3. **D6 五要素**（登记表 #6 + 例外④ ↔ ADR-0062 决策 4）：深度权威 = pi（pendingMessageCount）✓；内容权威 = renderer 提交日志（「它提交过所以它有」逐字同）✓；queue_update = 对账信号非数据载体 ✓；计数 FIFO 禁文本匹配 ✓；sendUserMessage({deliverAs}) 禁用 + S1 拦截 + 第三方残余风险表述（计数 FIFO 有界偏差、深度结构性对账）✓
4. **配置即登记条目**：登记表表头声明 2（「ReplicatedState 配置三元组…即登记条目，W6-W8 执行时同步维护」）↔ ADR-0062 决策 5（「replicated-states.config.ts 每条配置…= 登记表条目的代码化，实例落地一条、登记表同步一行（W6-W8 起强制）」），一致

## 检查点 7：红性/防回归验证 — PASS

- 手法：备份 ADR-0062 → 删决策 4（D6）核心句「pi 无队列内容通道（RPC 命令全集与 ExtensionAPI 均已穷尽核实），按字段拆分权威而非虚构单一权威：」→ 实跑通过命令 1
- 结果：grep 仍 3 处命中（L1 标题 / L13 决策 1 标题 / L24 决策 2 标题），exit 0——证明断言锚定标题级核心内容（「单一数据 owner + 绝对写规则」），不依赖任意内容句命中
- 还原：diff 与备份 identical，`git status` 回到验收前 3 文件状态，无残留

## 通过命令实跑汇总

1. `grep -n "绝对写规则\|单一数据 owner" docs/adr/0062-*.md` → 3 处命中 ✓；ADR-0042 grep「修订」3 处命中且含 sidecar + 前案 W1 ✓
2. 一致性交叉核对（4 条）→ 无矛盾 ✓（见检查点 6）
3. `git diff --stat` 2 files 7+/3- + untracked 52 行 → ≤120 ✓

## minor 观察项（不阻塞）

1. ADR-0042「替代方案」节（L42）历史原文保留了对 sidecar 的负面评价（「与 JSONL 可能脱同步…append 改动更集中」），与现行修订后决策方向相反。历史原貌保留符合验收要求（「不动其他历史内容」），且顶部修订记录块已显式声明保留原貌——可接受；仅提示未来读者须先读修订记录块再读正文，防止误引旧论据。
2. ADR-0062 决策 2 措辞「永不写 pi **当前持有**的 session JSONL」中「当前持有」限定了绝对写规则的适用范围（与 fork 创建型边界呼应），父文档原则①表述为「永不写 pi 的文件」——ADR-0062 实际是更精确的重述（把 fork 边界内嵌进规则），非矛盾；如后续有人逐字对齐两文档可能产生疑问，可在父文档下次修订时同步措辞（非本 wave 范围）。
