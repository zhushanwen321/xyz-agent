# ADR 0062：单一数据 owner + 绝对写规则

- 状态：Accepted
- 日期：2026-08-19
- 关联：[data-source-governance.md](../architecture/data-source-governance.md)（D1-D8 裁决全文）· [data-source-registry.md](../architecture/data-source-registry.md)（登记表 SSOT）· ADR-0042（session_end sidecar 形态，其前案 W1 修订由本 ADR 追认）

## 背景

12 类 GUI 数据多源问题的病根不是缓存，而是「权威源之外的第二个写入者」与「派生在多个进程独立发生」。data-source-governance 计划已完成收敛：xyz 对 pi JSONL 直写归零（登记表 §3，R1 allowlist 空集）、runtime owner 化（ReplicatedState 六实例）、renderer 写入口收敛（applySnapshot）、扩展数据 entry 扫描单源。本 ADR 把这些已发生的裁决固化为长期架构决策。

## 决策

### 1. 单一数据 owner——缓存第二写入者判定（D1 判据）

判据一句话：**缓存里是否存在权威源之外的第二个写入者？有 → 收编或删除（影子状态库）；没有 → 保留（纯派生缓存）**。

| 缓存形态 | 判定 | 处置 |
|---|---|---|
| 纯派生缓存（唯一写方 = 扫描/转换/计算本身，可随时丢弃并从权威源重建） | 无第二写方 | 保留不动 |
| 影子状态库（事件/RPC 回写多条路径直写、承载真值） | 有第二写方 | 收编进 owner 单入口，或无生产读者时纯删除 |

缓存不整体删除——病根是独立写路径，不是缓存本身。

### 2. 绝对写规则——pi JSONL 唯一写方 = pi 进程

xyz 的任何代码（runtime / renderer / 脚本）永不写 pi **当前持有**的 session JSONL。对 pi 持有文件的修改只发生在 pi 内部：内置 RPC（`set_session_name` 等）或扩展 API——扩展经 `pi.appendEntry` 写的 custom entry 由 **pi 自己持久化**，写方仍是 pi。pi 能力缺口由 pi 扩展在 pi 进程内补齐，runtime 只经 RPC 存取（订阅事件 + 调命令两种动作）。

两类**登记在案**的合法边界形态（规则边界的一部分，非例外）：

- **sidecar 家族四后缀（D3）**：`.meta.json` / `.preset.json` / `.project.json` / `.handoff.json`——xyz 自有文件（pi 体系外的 xyz 数据，不是 pi 的文件），读写收口 session-file-utils 单一 util、写前 existsSync 守卫（规则 #6 防 pi `openSync("wx")` 竞态）、写后失效 meta 缓存；R1 检查对四后缀内置豁免，豁免清单与登记表条目一一对应。
- **文件创建型（fork）**：创建 pi 将来才持有的新 session 文件（写前不存在、无进程持有、写后即移交 pi，`createForkedSessionFile` 唯一实例）。边界约束：禁止演进为「重写既有 session 文件」。

无白名单：迁移期 legacy 例外是带期限的债务（W11 已全部消灭），合法形态是规则边界，例外必须登记并带移除期限。

### 3. 事件只做失效

标量 session 状态的复制模式 = **快照拉取 + 事件失效**：数据只由 owner 从权威源拉取快照填充；事件到达只做一件事——标 dirty 并触发（防抖后的）重拉，事件永不直接写数据。补充合法形态：RPC 响应驱动失效（modelId 无 pi 事件，switchModel RPC 响应后主动拉快照）。登记在案的例外：消息流 `applyEntry` reducer 双路喂入（append-only 日志形态，实时与重放共用一份派生代码）、queue_update 计数对账信号（见决策 4）。

### 4. 队列按字段分权威（D6）

pi 无队列内容通道（RPC 命令全集与 ExtensionAPI 均已穷尽核实），按字段拆分权威而非虚构单一权威：**深度权威 = pi**（`get_state.pendingMessageCount` 快照对账）；**内容权威 = renderer 提交日志**（它提交过所以它有），queue_update 是对账信号非数据载体，投递定位走计数 FIFO（禁文本匹配）。xyz 自研扩展禁止使用 `sendUserMessage({deliverAs})` 注入队列（S1 checklist 拦截；第三方扩展注入的残余风险 = 计数 FIFO 有界偏差，深度仍结构性对账）。

### 5. ReplicatedState 配置即登记条目

登记表（data-source-registry.md）是 12 类 GUI 数据 owner / 权威源 / 唯一写入口 / 字段空值语义 / 已知例外的唯一 SSOT，P1 起演进为可执行配置：`replicated-states.config.ts` 每条配置（快照 RPC + 失效触发 + 合并策略含字段空值语义）= 登记表条目的代码化，实例落地一条、登记表同步一行（W6-W8 起强制）。新数据 = 新配置条目——不存在「顺手加个缓存」的物理路径（R3 注解校验条目真实存在）。

## 后果

- 正面：写路径恒一条（pi 内部）、派生恒一份（runtime 投影宿主、renderer 零派生）、对账通道恒在（快照重拉 / get_entries），一致性是结构性质而非时序纪律；等价性测试族（live ≡ reload / broadcast ≡ get_state / 混沌注入收敛）可持续断言。
- 正面：双层护栏以此为准绳——机器层（R1/R2/R3）+ 语义层（pr-cr-fix review-data-governance checklist）均对照登记表。
- 负面：sidecar 家族与 fork 创建型的跨文件数据流静态不可判定，机器层只能拦模式，语义守卫依赖登记纪律 + S1 review。
- 修订追认：ADR-0042 正文「append JSONL」原决策已由其前案 W1（历史 effort 的 W1，非本计划 wave W1）修订为 runtime 单写 sidecar，本 ADR（D3 选项 a）追认该形态为 sidecar 家族合法成员。
