# Review: requirements.md + system-architecture.md（红队反过度设计，第 4 路）

> Reviewer 范式：删除/质疑（认知帧 = 反过度设计，非架构忠实度核查——那是第 2 路职责）。
> 上游权威源：`docs/architecture/subagent-engine-abstraction.md`（665 行，三轮对抗式审查通过，其自身决策不在质询范围）。
> 被审对象：`.xyz-harness/subagent-engine-abstraction/requirements.md`（402 行）+ `system-architecture.md`（542 行）。
> 质询对象：「设计文档 → 两份 CW 文档」的**提炼过程**是否引入过度设计/冗余/越层。
> 审查日期：2026-08-24。

## Verdict: CHANGES_REQUESTED

3 must-fix（事实漂移 1 / 决策四重复写 1 / requirements 越层渗入 1）+ 4 should-fix + 3 nit。核心结论：**提炼变成了扩写**——944 行 vs 设计文档 665 行（+42%），其中约 150 行是可避免的复写与重复渲染，且漂移已实际发生一次（「11 维度」笔误，见 MF-1），证明冗余不是审美问题而是维护问题。全部修复为删减/指针化/术语清扫，不动任何已定决策，不阻塞信息链（每条附 deletion test 论证）。

## 1. 比例性总判断

| 事实 | 数字 |
|------|------|
| 设计文档（权威源） | 665 行 |
| requirements.md + system-architecture.md | 944 行（+42%） |
| 可避免复写（MF-2 ~100 + SF-1 ~12 + SF-2 ~18 + SF-3 ~8 + SF-4 ~6） | ~145 行 |
| 修复后预期 | ~800 行（两文档合计，含净新增价值） |

「提炼」的合理形态：CW 文档重组模板章节 + 净新增价值（BC-1~BC-8 行为契约清单、AC-1~AC-5 反模式 grep、错误码→终态映射表、A1-A14→AC 重分配），总量应与源文档大致持平。当前 +42% 中约 150 行是同一信息的第二/第三/第四份副本——每份都是未来的漂移源（MF-1 已兑现一次）。

**D1-D12 决策现存四份副本**是结构性问题中心：①设计文档 §3.3.2（权威全文）→ ②requirements「决策记录」表（13 行摘要）→ ③arch §10（张力/决策/理由全文复写，~130 行）→ ④decisions.md 账本（append-only 一行一条，arch header 自己声明「决策账本见本目录 decisions.md D-001~D-013」）。四份副本没有一个同步机制。

## 2. must_fix

### MF-1 [事实漂移] requirements「11 维度」应为「十维」

- **位置**：requirements.md L285（F3 行）、L382（决策表 D3 行）
- **事实**：设计文档 §3.3.2 D3 代码块列 **10** 个字段（schemaEnforcement/steer/conversation/personaInjection/eventGranularity/sandbox/sessionRead/resume/interrupt/permissionMode）；arch L52、L372 均写「十维」。requirements 两处写「11 维度」。
- **危害**：mid-detail-plan 的 code-arch 按 capabilities 维度数设计字段面，错误数字直接进接口定义——这是四重复写机制产出的第一个实际漂移。
- **修复**：两处改「十维」，或删去具体数字只写「多维」（维度权威以设计文档 D3 为准）。

### MF-2 [过度复写] arch §10 D1-D12 全文复写，违反自身权威声明

- **位置**：system-architecture.md §10「挑战与决策」（约 130 行）
- **问题**：arch header 声明「接口契约层以设计文档 §3.3.5-§3.3.9 为唯一权威，**本文引用不复制**」——§10 却逐条复写了 12 条决策的张力/决策/理由全文。这是全文档最大单一复写块（占 542 行的 24%），且 decisions.md 账本（一行一条、已 confirmed、source 列回指设计文档）已承担「决策账本」职责——账本存在的情况下再维护一份叙事全文，是文档层的过度设计。
- **deletion test（删了下游缺什么/不缺什么）**：
  - **不缺**：下游衔接表把 §10 指为「每 issue 的方案约束与验收依据」。但每条 issue 需要的约束粒度 = 决策结论 + 不可逆标记，decisions.md 账本（一行一条）完整提供；需要张力/被否方案/证据时读设计文档 §3.3.2（仓内、两文档全文反复引用、mid-detail-plan 本来就要读）。把下游衔接的指针从「§10」改为「decisions.md + 设计文档 §3.3.2」，信息链不断。
  - **缺（须保留的净新增部分）**：①**特化决策表**（reader 双端复用 / journal 落盘引擎目录树 / pi poolKey 恒 shared 三条「违反通用规则的例外」集中列举——设计文档散在 D5/D6/§3.3.9，无此整合视角，对 issues 的方案约束有独立价值）；②provenance（三轮审查确认状态，账本 confirmed_by 列已承载，一行说明即可）。
- **修复**：§10 压缩为「决策索引」——开头两行指针（decisions.md 账本 + 设计文档 §3.3.2 权威全文）+ D1-D12 每条 ≤2 行标题级索引（编号、一句话结论、confirmed 标记）+ 特化决策表原样保留；删除张力/理由全文。若 mid 模板强制「挑战与决策」章节存在，索引形态即满足。同步把 header 权威声明改为准确表述：字段级契约归设计文档 §3.3.5-§3.3.9，本文按架构粒度承载不变式、状态映射与特化例外。
- **预期**：-100~120 行，消除最大漂移源。

### MF-3 [越层渗入] requirements 主流程/替代流程/功能清单系统性使用实现术语

- **位置（抽样，非穷举）**：
  - L93（UC-2 主流程）：「preparer 准备隔离环境…launcher spawn…parser 把引擎输出翻译」——架构模块名当业务步骤名
  - L108/L110（UC-3 主流程/异常流程）：「宿主侧 **ajv** 校验」——库名
  - L140（UC-5 主流程）：「公共杀链兜底（**SIGTERM → grace → SIGKILL**）」——信号链实现
  - L155（UC-6 主流程）：「pi/claude-code/codex 的 jsonl、zcode/opencode 的 **sqlite**、kimi 的 **wire.jsonl**」——按引擎枚举存储格式（这是设计文档 §2.2 能力表的口径，不是需求）
  - L172（UC-7 替代流程）：`CLAUDECODE` / `ZSW_NESTED` / `PI_SUBAGENT_*` env 变量名
  - L246-248（§3 终态图节点）：「preparer：…config.json 凭据**原子写**」「launcher/parser」（随 SF-2 整图删除自然消失）
  - L286/L290（F4/F8）：「宿主 ajv」「公共杀链 SIGTERM/grace/SIGKILL」
  - L364（技术约束）：「同步登记 **tsup noExternal** 并跑 **validate-runtime-bundle.sh**」——打包脚本名
- **问题**：requirements 头部自我承诺「设计文档中的接口签名/数据格式/实施阶段拆分不在本文展开」，正文却系统性渗入模块名/库名/信号名/env 变量名/打包脚本名。「做什么」与「用什么做」的层边界失守。
- **范围限定（不为删而删）**：**AC 保持具体**——AC 镜像设计文档 A1-A14 验收场景，场景以可操作步骤定义（AC-6.2「rename 掉 db.sqlite」、AC-4.4「注入损坏 parser」是验收手段不是设计渗漏；AC-3.5 的 ajv 与 arch §11 AC-3 grep 呼应，保留）。§7 业务约束里的「依赖方向单向」为设计文档贯穿纪律④原意转述，保留（精确性有依据）。清扫范围 = UC 主流程/替代流程 prose + 数据流图节点标签 + F 清单 + 技术约束的脚本名。
- **deletion test**：术语换行为语言（「宿主兜底强杀，无僵尸进程」「输出经容错提取与 schema 校验」「引擎原生存储读取」），下游缺什么？**不缺**——ajv/SIGKILL/sqlite/模块名全部在 arch §3 术语表、§6 分层、§7 模块表与设计文档有权威定义，requirements 不承担定义职责；不删的代价：issues 拆分读者把库名/信号名当需求约束固化进 issue 验收措辞。
- **修复**：~15 处术语清扫映射为行为语言；L364 一行指针「reader 双端复用须遵守 runtime 打包纪律（见 system-architecture §8/AC-5）」。

## 3. should_fix

### SF-1 requirements「决策记录」表压缩为指针

- **位置**：requirements.md「决策记录」节（L373-387，13 行表 + 方案选型行）
- **deletion test**：删了下游缺什么？**不缺**——同信息存在于 decisions.md 账本（更权威，append-only）与 arch（MF-2 修复后为决策索引）；requirements 的真正载荷是「本阶段不重开」声明，一句话即可承载。方案选型行（EnginePort 方案 B、否决 A/C）是 requirements 层事实（系统形态承诺），保留为一句。
- **修复**：整表替换为：「D1-D12 已定且经三轮对抗式审查确认（账本 decisions.md D-001~D-013，全文设计文档 §3.3.2），本阶段不重开。方案选型：EnginePort 抽象 + 引擎注册表 + 公共降级层（方案 B），否决 Service 内 if-else（A）与 zsub 外挂（C）。」预期 -12 行。

### SF-2 requirements §3 终态 mermaid 与 arch §9 泳道图二选一（保留 arch）

- **位置**：requirements.md §3 终态 mermaid（L240-256）vs system-architecture.md §9 sequenceDiagram vs 设计文档 §3.3.4 ASCII——**同一 reviewer@zcode 流程三重渲染**。
- **deletion test**：删 requirements 终态图，下游缺什么？**不缺**——arch §9 覆盖同一流程且更完整（含 read() 事后读取链路、pi 路径差异注记、PreparedExecution 等协议细节）。requirements §3 的独家载荷是：①现状图（refactor 模式基线，arch 没有）；②不变量句（「要变的只是 spawn/翻译/落盘三行」——全文最load-bearing的一句）；③数据清单表（code-arch 的 schema 设计输入，arch 无此表）。这三样都不在终态图里。
- **修复**：删终态 mermaid，换一行指针「终态物理数据流（reviewer@zcode）见 system-architecture §9」；现状图、不变量句、数据清单原样保留。预期 -18 行。

### SF-3 requirements §6 与 arch §8 系统边界双表分化

- **位置**：requirements §6 关联表（8 行，含**契约稳定性**列 + 未来四引擎逐行展开）vs arch §8 表（6 行，也含契约稳定性列）——同一边界信息两处维护。
- **问题**：契约稳定性是架构关注点（决定探针分级，归 arch）；requirements 应只答「与谁交互、交互什么功能」。未来四引擎（claude-code/codex/opencode/kimi-code）逐行展开契约细节（Zod/机器 schema/openapi/文档化），首期 P1-P5 无任何 issue 消费这些行。
- **deletion test**：requirements 删契约稳定性列 + 四引擎合并为一行「未来四引擎：仅预留接入位，契约稳定性与交互细节见设计文档 §2.2/附录 A」——下游缺什么？**不缺**（首期只触 pi/zcode/runtime/zsub 四方）；契约稳定性归 arch §8 单点持有。
- **修复**：如上分化。预期 -8 行。

### SF-4 UC-4 三守卫语义第三份副本压缩

- **位置**：requirements UC-4 替代流程完整展开三守卫 a/b/c（含「capabilities 对照，如 sandbox: native」实现锚点）——与设计文档 D9、arch §5 注① 三处同文；UC-1 异常流程亦部分复述。
- **deletion test**：正文压缩为一句「三守卫（显式指定/独有能力依赖/model 不可解析）任一命中则不 fallback、按 strict 语义直接报错」，下游缺什么？**不缺**——守卫的可验证行为已由 AC-4.1（frontmatter 引擎 fallback 留痕）/AC-4.2（显式参数不降级对照组）/AC-4.5（model_not_available 不静默换引擎）三条 AC 钉死，细语义权威在设计文档 D9 与 arch §5。UC 层保留守卫的存在性与一句话定义即可。
- **修复**：如上压缩。预期 -6 行。

## 4. nit

- **N1**：arch §5 状态图转换标签「created --> preparing : 路由成功（probe 通过或**守卫内** fallback）」措辞歧义——「守卫内」实指「未命中守卫」，与下方注①的精确表述不一致，按注①改写。
- **N2**：requirements AC 引用 conformance 编号（AC-6.4 的 C5、AC-7.2 的 C7）是跨层引用，requirements 内无 C 编号定义；标注为「设计文档 §3.3.8 C5」式全限定。
- **N3**：MF-2/SF-1 落地后，requirements「达成路线」表与各 AC 中的 D2/D9/D4 等裸编号引用，统一加一处映射说明（D↔decisions.md D-00x），避免指针悬空。

## 5. 通过 deletion test 的保留清单（防为删而删）

逐章节正面结论（已审、留、删了会缺什么）：

| 章节 | 结论 | 保留理由 |
|------|------|---------|
| requirements §1 目标树 + §2 全部 UC/AC | 留 | A1-A14→AC 的用例化重分配是 issues 验收场景分配的直接消费物 |
| requirements §3 现状图 + 数据清单 | 留 | refactor 基线（arch 无现状视角）；数据清单是 code-arch schema 设计输入 |
| requirements §5 UI/UX 场景 | 留 | F14 GUI 显式化唯一的需求侧描述 |
| requirements §7/§8 | 留 | 约束与不做清单是 issues DoD 边界（MF-3/SF-3 只动其中两处措辞） |
| requirements 待确认（5 项待实证） | 留 | 实施期验收前置门，已标注来源 |
| arch §1/§2/§3 | 留 | 目标转换/设计立场/术语表是下游阅读前提 |
| arch §4 核心模型 + 不变式 | 留 | conformance C1-C8 断言来源（下游衔接明确消费）；类图为架构粒度，未复制 API 签名全文（层纪律合格） |
| **arch §5 状态流转（任务点名质询项）** | **留，见专项** | 见下 |
| arch §6/§7 | 留 | §7 模块+变化轴表是 Wave/issue 切分基准（下游衔接第一行） |
| arch §8 Context Map | 留 | SF-3 后成为系统边界与契约稳定性唯一持有者 |
| arch §9 泳道图 | 留 | SF-2 后成为终态流程唯一渲染 |
| arch §11 反模式 grep AC | 留（**净新增价值**） | 机器可查 DoD，设计文档没有此形态；issue 完成定义直接消费 |
| arch §12 BC-1~BC-8 | 留（**净新增价值**） | refactor 模式行为契约集中清单，设计文档无此形态；P1/P5 回归锚点 |
| arch 下游衔接 | 留 | Step 3 消费映射（MF-2/SF 修复后同步更新其中 §10 指针） |

### 专项质询结论：arch §5 状态流转是否必要

**结论：必要，保留。它是忠实综合，不是重复设计文档。**

1. **设计文档没有状态机**——§3.3.3 错误表与 §3.3.5 run 错误语义三条是散置的；§5 把 11 个错误码 → 触发面/终态/拒绝形态的映射整合成单表，下游衔接明确将其作为「错误规格落地的枚举清单与测试场景（A5/A9/A11/A14）」来源。删了，issues 阶段要自己从散置语义重新推导同一映射——信息链断。
2. **「record 状态（保持现有，不动）」段仅 3 行，是显式非变更栅栏**——防止实施期有人顺手重设计现有 record 状态机（ExecutionStatus/ClosedReason/mapExternalState）。这是 refactor 模式的防扩围信息，有独立价值；设计文档根本没写 record 状态机，谈不上重复。
3. 引擎任务生命周期六态是设计文档散置语义（prepare 期 reject / 运行中不 reject / abort 合成终态）的首次整合，与两条转换补充注一起构成测试场景推导骨架。mermaid 状态图约 25 行属描述性糖，若追求极致可删图保表，但收益小，不强求（不入 should-fix）。

## 6. 过度抽象检查结论（任务第 5 项）

**未发现超出设计文档承诺的抽象。**逐项核验：

- 未来四引擎内容均为引用级（预留接入位 + 契约稳定性引用），未新增接口/模块/机制（SF-3 只是删冗余行，不涉及抽象面）
- driver host 保持「命名预留、首个 server-mode 引擎接入时落地」口径，与设计文档 §3.3.1 一致
- capabilities 维度数除 MF-1 笔误外无扩张
- 幻觉扩张抽查：≤500 行 / stdout 尾部 2000 字 / 头4K+尾64K / 11 个错误码 / 8 种事件 / 六引擎 / conformance C1-C8 等数字与枚举均与设计文档一致；arch §11 grep 为既有规则的操作化（非新规则），路径真实存在且自带「允许按实际目录微调」护栏

## 7. 修复后预期形态

| 文档 | 现状 | 修复后 | 变化来源 |
|------|------|--------|---------|
| requirements.md | 402 | ~355 | MF-1 修正 + MF-3 术语清扫 + SF-1/2/3/4 |
| system-architecture.md | 542 | ~430 | MF-2 决策索引化 + header 声明修正 |
| 合计 | 944（+42% vs 源） | ~785（+18% vs 源） | 增量全部来自净新增价值（UC 重组 / BC / grep AC / 状态映射 / 数据清单）+ 两套模板的必要章节 |

+18% 的净增对应「一套已审设计文档拆两份模板文档 + 四块净新增综合」，这是「提炼」的合理形态；+42% 且含 150 行四重复写不是。

## 统计

- must-fix：3（MF-1 事实漂移 / MF-2 决策四重复写 / MF-3 requirements 越层渗入）
- should-fix：4（SF-1 决策表指针化 / SF-2 终态流程图二选一 / SF-3 系统边界表分化 / SF-4 守卫语义三副本压缩）
- nit：3
- 正面保留：14 项章节级结论 + §5 专项质询（保留）
