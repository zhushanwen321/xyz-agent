# Probe A2 基线对比 — 注入三段渲染函数（改造前 vs 改造后）逐字节 diff

> 补做证据：Gate B（[subagent-core-convergence.gateb.md](subagent-core-convergence.gateb.md)）S1 只做了改造后现状验证
> （真机 pi 会话确认注入生效、10 内置角色 location 指向 core `agents/`），未做「改造前 vs
> 改造后」的基线 diff。本文补齐该缺口：在渲染纯函数层面对旧版（基线 commit
> `5557e109b` injector 内嵌 format 函数）与新版（`packages/subagent-core` barrel 导出的
> `injection-render.ts` 同名函数）做同一确定性 mock 输入的逐字节对比。
> 执行日期：2026-08-31。执行环境：node v24.11.1 + 本仓 workspace tsx。

## 1. 口径声明（对比面与 A2 验收原文的关系）

[设计文档 §4.1](subagent-core-convergence.md) A2 验收原文：「注入三段格式与改造前逐字节等价，
豁免仅两处（10 内置角色 location 前缀 + subagents 段 guide 末句的 systemPrompt 过期文案
修正，见 §3.1；红线 8 的 location 豁免收窄口径不变）」。

本 probe 的对比面是**渲染函数级**（format 纯函数的输出），与 A2 原文的真机会话快照口径关系：

- **两处声明豁免中，豁免 ②（subagent 段 guide 末句）是渲染函数级差异**，本 probe 直接覆盖；
- **豁免 ①（10 内置角色 location 前缀）是数据面差异**（发现层返回的 `path` 值变化：
  `<pi-sw 安装目录>/agents/*.md` → `<core 包>/agents/*.md`），不进入渲染函数对比面
  ——渲染函数对同一 `path` 输入两版输出一致（本 probe 的重名/中文路径用例顺带证明渲染层
  原样透传 location）；实际路径前缀变化由 Gate B S1 真机证据覆盖（10 角色逐条命中 core
  `agents/`，且用户/项目资源 location 不在豁免内的收窄口径由 S1 的 2 个 user 源 agent 佐证）；
- pi 现调用形态（`setAgentCache` / `setWorkflowCache` / `setupModelListInjector` 的实参取值）
  作为 A2 等价面的调用约定：guide 传 pi 版常量、不传 `maxEntries`/`truncationNotice`、
  model 走 `toModelEntry` 全字段投影、agents/workflows 输入为发现层已按 name 码点序排序的数组。

## 2. 方法与复现命令

### 2.1 旧版函数纯度确认（提取前提）

逐行 read 基线三个 injector（`git show 5557e109b:<path>`）确认：

- `formatAgentList` / `formatWorkflowList` / `formatModelList` / `summarizeDescription` /
  `formatCaps` / `compareByCodepoint` 为**纯函数**：无 IO、无模块级状态、无 pi 运行时依赖；
- 唯一外部依赖 = `escapeXml` / `renderXmlSection`（`@zhushanwen/subagent-core/shared/xml-injection.ts`，
  基线时即已下沉 core）；
- injector 其余部分（`setup*Injector` session handler、模块级缓存、`discoverAllAgents` /
  `discoverAllWorkflows`、`getLogger`、`getHostServices`）非纯，不进入对比面，不提取。

因此无需任何逻辑 stub——**唯一依赖用真实现**（见 2.2），比 stub 更强。

### 2.2 共同底座一致性验证

```bash
git show 5557e109b:packages/subagent-core/src/shared/xml-injection.ts > /tmp/baseline-xml-injection.ts
diff /tmp/baseline-xml-injection.ts packages/subagent-core/src/shared/xml-injection.ts
# → 无输出：基线与现版 xml-injection.ts 逐字节一致（IDENTICAL）
```

旧版提取函数的 `escapeXml`/`renderXmlSection` 因此直接 import 现版 core 同文件，
底座差异被构造性排除。

### 2.3 旧版纯函数机械提取（零手抄）

awk 按行区段从基线文件切取（唯一外加物 = 文件头部的底座 import 行），区段：

| 基线文件（`extensions/universal/subagent-workflow/src/injectors/`） | 行区段 | 内容 |
|---|---|---|
| `subagent-list-injector.ts` | 165–197 | `formatAgentList`（含 JSDoc） |
| `workflow-list-injector.ts` | 60–94 | `MAX_DESC_LEN` / `DESC_BOUNDARY_MIN_RATIO` / `summarizeDescription` |
| `workflow-list-injector.ts` | 146–166 | `formatWorkflowList`（含 JSDoc） |
| `model-list-injector.ts` | 64–109 | `compareByCodepoint` / `formatCaps` / `formatModelList` |

```bash
git show 5557e109b:extensions/universal/subagent-workflow/src/injectors/subagent-list-injector.ts \
  | awk 'NR>=165 && NR<=197'
# （其余区段同法；四段拼接 + 头部 import 行 = /tmp/a2-probe/legacy-formats.ts）
```

提取正确性由结果背书：workflow 段与 models pi 投影段逐字节一致（§3），提取若有一字符之
差不可能产生 IDENTICAL。

### 2.4 新版消费面与 pi 调用形态

新版经 **barrel** `packages/subagent-core/src/index.ts` 消费（W5⑦ 后 pi-sw 的统一消费面，
非深路径）：`formatAgentList` / `formatWorkflowList` / `formatModelList` /
`sortByCodepoint` / `summarizeDescription` 均为 barrel 逐名导出（导出面见 index.ts
「注入渲染面」注释块，指向 `./shared/injection-render.ts`）。

pi 侧现行调用形态（现版 injector 源码核实）：

- subagent：`formatAgentList(entries, { guide: SUBAGENT_LIST_GUIDE })` — 无预算参数；
- workflow：`formatWorkflowList(entries, { guide: WORKFLOW_LIST_GUIDE })` — 无预算参数；
- model：`formatModelList(getAvailable().map(toModelEntry), { guide: MODEL_LIST_GUIDE })`
  — 投影全字段必给（provider/reasoning:boolean/input[]/contextWindow）。

三个 guide 常量由 probe 脚本**直接读现版 injector 源文件正则提取 + JSON.parse 还原转义**
（零手抄），杜绝「对比用的 guide 与 pi 实际 guide 不一致」的操作风险。

### 2.5 执行

```bash
node_modules/.bin/tsx /tmp/a2-probe/probe.ts   # probe 脚本与 legacy-formats.ts 放 /tmp，跑完已删（不进仓库）
# 运行环境 node v24.11.1；经 barrel 必须用 tsx——barrel 依赖图含 TS parameter property
# （workflow-script-registry-impl.ts）与 extensionless import（session-runner.ts），
# node 原生 strip-types 两种语法均不可跑，与本对比无关，仅运行器选择问题。
```

probe 对每个用例将两版输出成对落盘（`*.legacy.txt` / `*.current.txt`）后逐字节比较，
diff 取证在证据分析时完成；临时文件已清理，关键 diff 节录进本文 §3–§4。

## 3. mock 输入要点（确定性）

- **agents 主集 10 条**（经 `sortByCodepoint` 排序后喂入，模拟 `discoverAllAgents` 输出）：
  name 覆盖大写开头（码点序位置）／数字后缀／连字符／中文／纯 ASCII；description 覆盖
  XML 特殊字符（`< > & " '`）与中文；`when` 有／无／空串三态；examples 正例单条／正负
  混合／空数组（不渲染段）三态；path 含空格／中文目录。
- **同 stem 撞名对照 2 条**：同 name 不同 path——渲染层两版均不去重（name 去重发生在发现层
  Map），验证渲染层对重名输入行为一致。
- **乱序输入对照 5 条**：旧版按输入序渲染（排序在发现层）、新版内部先码点序排序——调用契约
  变化的显式用例（pi 现调用链不触发，见 §4 #3）。
- **workflows 8 条**：短描述；**恰 160 字符**（不触发截断边界）；**161 字符**且断点在 40% 后
  （`. ` 触发断句）；中文 `。`／`；` 断点各一；无断点（200 字符无标点）硬截 + `…`；断点在
  40% 前硬截 + `…`；特殊字符 + 截断组合；name 含 XML 特殊字符。160/161 字符串由脚本
  `repeat` 构造并**运行时断言长度**（防 mock 本身不确定）。
- **models pi 投影 8 条**（乱序喂入——两版 formatModelList 均内部排序）：同 provider 多 id、
  多 provider 交错、reasoning true/false、input 含/不含 image、contextWindow 常规值/`0`、
  name 含 XML 特殊字符与引号转义。
- **models 并集口径扩展变体 6+3 条**（A2 等价面之外，逐条定性，见 §4）：provider 缺席 /
  空串、contextWindow 缺席、input 缺席、reasoning 对象形态（含 +image 组合）、provider
  存在/缺席混合排序。

## 4. 三段 diff 结论（逐段）

### 4.1 subagent 段（`<available_subagents>`）— 差异仅声明豁免 ②

- **主对比（10 条 + pi guide）：DIFF，diff 仅 1 个 hunk，唯一差异行 = guide 行**。旧末句
  「…ONLY use agent names from this list. If no agent matches your task, pass
  systemPrompt alongside the agent name to create a dynamic agent.」→ 新末句「…ONLY use
  agents from this list — pass the <location> path (absolute .md path) as the agent param.
  If no agent matches your task, omit agent (a general-purpose agent is used) and put all
  role-specific instructions in the task text.」——与设计 §3.1 ② 声明豁免逐字对应。
  条目渲染（含 when/examples/location、XML 转义形态）逐字节一致。
- **重名对照：DIFF 同样仅 guide 行**；两条重名条目两版均原样渲染、顺序一致（渲染层不去重，
  行为一致）。
- **乱序对照：guide 行差异 + 条目顺序差异**（定性见 §4.4 #3；pi 现调用链输入已排序，不触发）。

### 4.2 workflow 段（`<available_workflows>`）— 逐字节等价

**IDENTICAL**（8 条全用例：截断/断句/边界 160/161/中文断点/硬截/特殊字符）。
另做 `summarizeDescription` 函数级对拍 10 例（短/160/161/中文。/中文；/无断点/早断点/
特殊字符/带空白 padding/边界长度），**10/10 全等**。

### 4.3 models 段（`<available_provider_models>`）— pi 投影下逐字节等价；并集变体为声明内守卫

- **pi 投影主对比（8 条乱序 + pi guide）：IDENTICAL**——(provider, id) 码点序排序、
  `provider/id` 拼接、caps（reasoning/vision）、contextWindow 渲染（含 `0` 值）、特殊字符
  转义全部一致。设计文档 §3.2 L162「pi 投影必填 provider，保证 A2 逐字节等价」实测成立。
- **并集口径扩展变体（A2 面外）**：差异逐条定性于 §4.4 #4–#7。其中 reasoning 对象形态
  两版输出一致（旧版 truthy 消费对对象同样成立）。

### 4.4 差异定性清单与设计声明比对

| # | 差异 | 所属面 | 定性 |
|---|------|--------|------|
| 1 | 10 内置角色 `<location>` 路径前缀（pi-sw 安装目录 → core 包） | 数据面（发现层），不在渲染函数对比面 | **声明豁免 ①**（§3.1 ①）；渲染函数对同一 path 输入两版输出一致（本 probe 证明）；路径实际变化由 Gate B S1 真机证据覆盖 |
| 2 | subagent 段 guide 末句重写 | A2 等价面内 | **声明豁免 ②**（§3.1 ②）——本 probe 唯一在等价面内观测到的差异，逐字命中声明 |
| 3 | 排序责任入 format：乱序输入下旧版按输入序、新版内部码点序重排 | 调用契约（pi 现调用链输入已排序——发现层排序后喂入，不触发） | **声明内**：injection-render.ts 头注释「format 内部先排后截：pi 调用链数据已排时重排幂等」+ 设计 §3.1 收口后图「core format*List（守卫 + 预算参数 + 码点序）」 |
| 4 | provider 缺席/空串：旧版渲染 `undefined/bare-id`、`/empty-provider` 垃圾；新版裸 id | A2 面外（zsw 投影形态） | **声明内红线 5 守卫**（injection-render.ts 头注释 + ModelEntry 并集口径定约） |
| 5 | contextWindow 缺席：旧版渲染 `<contextWindow>undefined</contextWindow>` 垃圾；新版不渲染该元素 | A2 面外 | **声明内红线 5 守卫**（同上） |
| 6 | input 缺席：旧版 `TypeError: Cannot read properties of undefined (reading 'includes')` 直接抛；新版正常渲染（caps 缺 vision） | A2 面外 | **声明内红线 5 守卫**（源码注释明确「pi 版此处对 undefined 抛 TypeError」——实测证实） |
| 7 | provider 混合排序：旧版 comparator 对 undefined 返回 0（顺序语义退化）；新版归一空串排最前 | A2 面外 | **声明内**（compareModelEntries 注释定约「混合形态下无 provider 条目排最前，口径确定可复现」） |

**声明外差异：无。** A2 等价面三个主对比（agents-main / workflows-main / models-pi）中，
除声明豁免 ② 外零差异；其余全部观测差异均可定位到设计/源码的明文声明（豁免 ①、红线 5、
排序契约），且行为方向均为「旧版在 pi 投影之外的输入形态下产出垃圾或崩溃，新版守卫」。

## 5. 结论

渲染函数层面，A2 验收的等价性声明成立：**三段注入在 pi 现调用形态下，除声明豁免 ②
（subagent 段 guide 末句）外与基线逐字节等价**；豁免 ① 为数据面差异、由 Gate B S1 真机
证据另行覆盖。未发现任何声明外差异。本 probe 与 Gate B S1 合并构成 §4.1 A2 的完整证据链
（S1：真机注入面 + 10 角色 location 前缀；本 probe：渲染函数级逐字节基线 diff）。

局限（如实声明）：本 probe 为纯函数级对比，不覆盖发现层数据面（豁免 ① 归 S1）与
before_agent_start 链式叠加时序（两侧未改动，S1 真机已验证注入生效）；mock 为确定性构造
（非真机 12 agent 全集），但字段变体覆盖了渲染函数的全部分支（when/examples 三态、截断
四态、caps 组合、排序交错、转义字符类）。
