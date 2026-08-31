# 交付物模板：decisions.md

①clarity 创建此空骨架，后续所有阶段 append 决策行。字段定义见 `loop-skeleton.md` Step 1.2 schema（本模板只给可写骨架，不重复字段说明）。

## decisions.md frontmatter

```yaml
---
topic: subagent-engine-abstraction
created_at: 2026-08-24
---
```

## 决策账本（append-only，一行一条决策）

> 表头与字段顺序固定（check 脚本/下游引用依赖）。`superseded_by` 空列留空；有值时原行 `status` 必须同步改 `revisited`。

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-001 | 接口主语义锚定「一次性任务」（run→outcome），交互控制面单列可选方法 interact（pi 首期原生、zcode unsupported、未来公共层冷仿真） | pi conversation 每轮冷启动会改 pi 行为违反 A1 零回归；双语义接口让首期复杂度翻倍 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D1] | `confirmed` | |
| D-002 | 中立类型从现有类型泛化（AgentTaskSpec=ExecuteOptions 泛化剥离 pi 语义；AgentEvent 8 种原样；AgentOutcome 锚定 orchestration 层 AgentResult 消歧命名） | 现有类型被 workflow/GUI/测试广泛消费，推倒重来是纯迁移成本 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D2] | `confirmed` | |
| D-003 | capabilities 三级声明 native/emulated/unsupported（声明链路接通能力而非引擎理论能力；pi steer 首期声明 unsupported） | 运行时能力探测成本高不可靠；声明式让上层据声明选策略而非 try-catch | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D3] | `confirmed` | |
| D-004 | 降级能力归属公共层写一次全引擎复用；schema native/emulated 硬分流（native 路径不做二次校验防第二校验权威） | 六引擎缺失能力高度重合（schema 4/6 缺、超时 6/6 缺）；pi structured-output 方案 A 唯一校验权威是历史教训 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D4] | `confirmed` | |
| D-005 | 环境隔离与凭据注入走 per-engine preparer 钩子；隔离目录池化跨任务保留，清理与 record 生命周期挂钩只做到池粒度；journal 不随池删 | 六家六种隔离手段互不兼容只能代码化；db.sqlite 是 D6 降级链①级数据源不可单任务清理；逆向 schema 删行脆弱 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D5] | `confirmed` | |
| D-006 | session 读取独立 SessionView 接口 + 三级降级链（①引擎原生 reader → ②宿主 event journal → ③outcome-only）；reader 做成无状态共享只读模块双端复用（extension+runtime） | zcode sqlite 随版本迁移原生读取必然周期性失效需保底；adapter 各自缓存会演变六种格式；journal 保真度低于 sqlite 故 runtime 常态走①级 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D6] | `confirmed` | |
| D-007 | 探针体系按契约稳定性分级（zcode 弱契约=已知样本回归；CC/codex 官方 schema=机器校验最轻）；probe 失败有守卫 fallback（显式指定/独有能力/model 不可解析不兜底） | 契约稳定性光谱两端统一强探针浪费、统一弱探针危险；静默换引擎违反显式意图 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D7/D9] | `confirmed` | |
| D-008 | 嵌套防护双层：统一 XYZ_AGENT_SUBAGENT env 标记 + 各引擎清理/利用原生标记；六家原生多 agent 机制一律禁用，编排权在宿主 | 隔离目录不装扩展依赖配置洁癖；opencode/CC 吃项目级配置，env 标记是唯一跨引擎可靠手段 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D8] | `confirmed` | |
| D-009 | 配置路由三层（调用参数 > agent frontmatter engine > 全局默认缺省 pi）；model 与 engine 正交不做隐式推引擎；workflow 脚本不写死 engine | 与 zsub frontmatter.model 先例一致；隐式换引擎静默卸能力是安全反模式 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D9] | `confirmed` | |
| D-010 | MVP 引擎集 = { pi, zcode }；zcode 首期只做 spawn 单轮（app-server/conversation/其他四引擎不进首期，抽象按六引擎全集设计防返工） | 实现按最小可验收集推进防过度工程 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D10] | `confirmed` | |
| D-011 | 能力缺陷四级处置（自动仿真/显示降级/调用前拒绝/入口拦截），capabilities 声明是唯一分发依据，处置由能力类别决定不由引擎 id 决定 | 新引擎填好 capabilities 即继承全部处置逻辑；错误尽量先于进程创建 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D11] | `confirmed` | |
| D-012 | 新引擎接入以 engine conformance 契约套件（C1-C8）+ golden 样本库为验收门；负例元测试保套件有牙 | 「接入成本递减」由可验证机制承载不靠口号 | `D-不可逆` | `ask_user` | `mid-plan` | [from: design §3.3.2 D12] | `confirmed` | |
| D-013 | 实施五阶段 P1 中立类型+EnginePort+PiEngine 回填 → P2 公共降级层 → P3 ZcodeEngine → P4 配置路由+capabilities+探针+conformance → P5 runtime extractor 分协议 | 先回填后新增隔离回归风险；P5 单独 commit 中改动 | `D-可逆` | `agent-opinionated` | `mid-plan` | [from: design §5] | `confirmed` | |
| D-014 | D-010 的「zcode 首期只做 spawn 单轮」终态被超越：zcode engine 升级为 app-server 常驻（spawn 路径保留为降级兜底，EnginePort 仅新增可选 dispose/onHandleReady 两处字段级扩展，原决策记录不改写） | 常驻化收益（零冷启动/实时进度/per-session model）经独立设计论证后实施；终态决策时间 2026-08-30，出处 commit e70ca71 | `D-可逆` | `ask_user` | `post-plan` | [REVISIT of D-010] from: docs/design/zcode-engine-appserver-resident.md] | `confirmed` | |

## 示例（仅供参考，创建时删除）：revisit 链 append-only 写法

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-002 | 用事件溯源而非 CRUD | 下游要求完整审计链 | `D-不可逆` | `ask_user` | `architecture` | `[from: demo §4.2]` | `revisited` | D-005 |
| D-005 | 改用 CRUD + 变更日志（成本） | 事件溯源运维成本过高（⑤骨架验证发现） | `D-不可逆` | `ask_user` | `code-arch` | `[REVISIT of D-002] from: demo §9]` | `confirmed` | （空） |

> D-005 是 D-002 的推翻决策：D-002 的 `status` 改 `revisited` + `superseded_by: D-005`；D-005 新行 append 带 `[REVISIT of D-002]` 溯源。原 D-002 **不删**（保审计链）。
