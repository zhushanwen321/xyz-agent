# cache-probe：LLM 前缀稳定性数据收集探针设计

> **一句话结论**：用一个零行为影响的 pi extension，在 system prompt / tools 指纹发生变化时向 session 文件插入 custom entry，配合归因脚本把 turn 首笔 cache miss 中「模型未切换 + TTL 应有效」场景下仍存在的约 24% 残差，拆解为「harness 前缀变化（可修）」与「服务端淘汰（不可修）」两类，为「resume 固化系统提示词」方案提供 GO/NO-GO 决策依据。

## 开篇（SCQA）

- **S（情境）**：xyz-agent / pi 的 LLM 调用主力为 5 家国产模型（DeepSeek V4、GLM-5.3、Kimi K3、MiniMax M3、MiMo v2.5-pro），全部支持自动前缀缓存——OpenAI 兼容接口裸调即自动生效，命中价为未命中价的 1/120 到 1/5。pi 的 session 文件原生记录了每笔请求的 `usage.cacheRead`，实测 3.5 个月整体命中率可观。
- **C（冲突）**：实测发现「中断 < 5 分钟 + 模型未切换」（缓存 TTL 应有效）的 turn 首笔请求命中率仅 76.0%，仍有约 24% 的 prefill 在全价重算，原因未知。候选解释有两个，对策完全不同：harness 侧前缀变化（system prompt / tools 漂移，可通过固化快照修复）vs 服务端缓存淘汰（harness 侧无解）。
- **Q（问题）**：这 24% 的 miss 到底归因于什么？在数据给出答案之前，「固化系统提示词快照」方案无法决策。
- **A（答案）**：先做数据收集探针——extension 只记指纹 hash（变化时才写入，session 文件几乎零膨胀），归因脚本与原生 usage / model_change / thinking_level_change / timestamp 数据 join，输出归因矩阵，用 1-2 周真实使用数据回答归因问题。

**层声明**：本文档是**技术方案设计**层，下一层产物是**可实现的 extension 代码 + 归因脚本**。§3「解决方案」侧重接口 / 数据模型 / 错误规格 / 选型对比 / 物理数据流。涉及运行时行为与数据流，验收遵循真实场景准则（非单测非 mock）。

## 1. 背景：被设计的系统是什么

xyz-agent 是 Electron + Vue3 的 AI Agent 桌面工作台，通过 runtime 子进程运行 pi coding agent（npm `@earendil-works/pi-coding-agent`），所有 LLM 请求由 pi 发出。用户同时大量直接使用 pi CLI。两条路径产生的 session 都是 JSONL 文件（每行一个 entry，entry 带 `timestamp`），存储于 `~/.pi/agent/sessions/<workspace-dir>/`（CLI）与 `~/.xyz-agent/pi/sessions/`（桌面）。

与本文相关的 pi 机制（源码已核实，路径相对 pi 包根）：

1. **system prompt 每次构建、不落盘**：pi 的 system prompt 由 `buildSystemPrompt()`（`coding-agent/src/core/system-prompt.ts:28`）从磁盘资源拼装，组成包括 cwd、contextFiles（AGENTS.md / CLAUDE.md 等逐级目录扫描）、tools 清单、skills 清单、appendSystemPrompt（APPEND_SYSTEM.md）、customPrompt（SYSTEM.md）、guidelines。**不含日期、不含 git status**。session JSONL 的 entry 类型（`session-manager.ts:144`）没有 systemPrompt 字段——session 从不保存 system prompt，resume 时重新构建。
2. **extension API 提供三个关键能力**（本项目红线「不修改 pi 源码」内）：
   - `pi.appendEntry(customType, data)`（`extensions/types.ts:1341`）：向 session JSONL 追加 `{"type":"custom","customType":...,"data":...}` entry。**custom entry 不参与 LLM 上下文**（`sessionEntryToContextMessages` 对 custom 类型返回空数组）——这是探针零干扰的前提。
   - `before_agent_start` 事件（`extensions/types.ts:715`）：每轮 turn 开始触发，事件携带拼装好的 `systemPrompt`（全文）与 `systemPromptOptions`（结构化组成部分：contextFiles / skills / selectedTools / toolSnippets / appendSystemPrompt / customPrompt / promptGuidelines / cwd）。
   - `pi.getAllTools()`（`extensions/types.ts:1363`）：返回全部已注册 tools 的 name / description / parameters / promptGuidelines。
3. **xyz-agent 全链路对未知 custom entry 安全**（已探查核实）：实时路径 `entry_appended` 事件已被 EventAdapter 登记为 NULL_EVENTS 静默丢弃（`packages/runtime/src/infra/pi/event-adapter.ts:712`）；历史加载路径 `mapSessionEntries` 把 custom entry 隔离到 `customDataEntries`、不进消息转换管线（`packages/runtime/src/infra/pi/session-entry-mapper.ts:99`）；前端零渲染。**已有 3 个生产先例**：plan（`plan-state`）、model-switch（`model_change`）、unified-hooks（`unified-hooks:tool-error`）extension 均在随应用打包写入 custom entry。

## 2. 设计目标

**本章结论：收集「变化时插入」的前缀指纹数据，把 cache miss 残差归因拆开，支撑快照方案决策。**

1. **G1 归因**：把「中断 < 30min + 模型未切换」的 turn 首笔 miss 拆解为「前缀变化」vs「前缀未变仍 miss（服务端淘汰）」两类，并按 5 家模型分组。
2. **G2 指纹记录**：记录 system prompt / tools 注册表的指纹变化时间线——何时变、哪个组成部分变（contextFiles / skills / tools / append / guidelines / customPrompt）。变化时才写 entry，无变化 turn 零写入。
3. **G3 单数据源 join**：指纹数据与 pi 原生数据（message entry 的 usage、model_change / thinking_level_change entry、全 entry timestamp）落在同一 session 文件，归因脚本无需跨文件对账。
4. **G4 零行为影响**：探针不改变 agent 行为、不污染 LLM 前缀（custom entry 不进上下文）、自身出错时缺口可见而非静默、可随时卸载且卸载后无残留影响。
5. **G5 决策产出**：1-2 周真实使用后，归因矩阵能对「resume 固化系统提示词」方案给出 GO / NO-GO 建议及量化依据（前缀变化导致的 miss 占比 × 平均前缀长度 × 各家命中价差）。

**In-scope**：探针 extension（数据记录）、归因分析脚本、数据收集与决策标准。
**Out-of-scope**（显式不做，防 scope creep）：快照固化方案本身及其 diff 注入；xyz-agent 桌面 builtin extension 清单集成（数据收集期用本地路径加载，是否转正由 G5 结论决定）；指纹全文 diff（只记 hash，定位到「哪个部分变了」粒度即满足 G1/G2）；前端 UI 展示。

## 3. 现状：使用者眼里是什么样的

**本章结论：缓存收益真实且大，但 TTL 内仍有约四分之一 prefill 全价重算，且现有数据无法归因。**

### 3.1 实测现状（2026-05-01 至 2026-08-20，4430 个 session 文件）

对两个数据目录全量扫描（排除 /tmp、var-folders 测试目录），统计 session 内相邻两次真实用户发言的间隔（gap）与每笔 LLM 请求的缓存命中（取自原生 `usage.cacheRead` / `cacheWrite` / `input`）。

**使用节奏**：94% 的回访 gap 在 30 分钟内，「隔天再战」（> 12h）仅 0.3%。

| gap 分布 | 次数 | 占比 |
|---|---|---|
| < 5min | 17565 | 77.9% |
| 5-30min | 3642 | 16.1% |
| 30min-2h | 828 | 3.7% |
| 2-12h | 451 | 2.0% |
| > 12h | 67 | 0.3% |

**turn 首笔请求命中率（按中断时长分桶）**：

| 中断时长 | 首笔命中率 | 对照：turn 内后续请求 |
|---|---|---|
| < 5min | **73.1%** | 94.7% |
| 5-30min | **68.0%** | 91.8% |
| 30min-2h | 35.8% | 89.9% |
| 2-12h | 21.5% | 95.1% |
| > 12h | 18.3%（≈ 全新 session 的 18.6%，缓存死透） | 95.0% |

**已归因的两个因素**（排除 session 初始化时 pi 必然写入的 model_change 干扰后）：

| 条件 | 请求数 | 首笔命中率 |
|---|---|---|
| gap < 5min，模型未切换 | 14260 | **76.0%** |
| gap < 5min，切换了模型 | 735 | **23.3% / 18.7%** |
| 仅切 thinking level（模型未切） | 20 | 76.0%（无影响） |

### 3.2 各家模型缓存机制（官方文档核实）

| 模型 | 机制 | TTL | 命中价 | 最小前缀 |
|---|---|---|---|---|
| DeepSeek V4 | 自动前缀，严格整段匹配 | 「几小时到几天」 | 未命中的 1/30 | 未公开 |
| GLM-5.3 | 隐式自动，按内容相似度 | 未公开 | ~1/5~1/4 | 未公开 |
| Kimi K3 | 全自动前缀 | 未公开 | 1/10 | 256 token |
| MiniMax M3 | 被动缓存 | 「按系统负载自动调整」 | 1/5 | 512 token |
| MiMo v2.5-pro | 隐式前缀，LRU 容量淘汰 | 无固定 TTL，官方博客称「数小时后往往无法命中」 | **1/120** | 未公开 |

五家均无缓存写入额外费用，OpenAI 兼容 `/chat/completions` 裸调（pi 现有调用方式）自动生效，无需改造调用层。

### 3.3 怎么出错：残差无法归因

「gap < 5min + 模型未切换」场景（TTL 应有效）首笔命中率 76.0%，仍有 24% miss。候选解释：

- **harness 前缀变化**：system prompt 某组成部分或 tools 注册表在 turn 之间变了 → 前缀断，整段缓存作废。可通过快照固化修复。
- **服务端淘汰**：LRU / 负载驱逐，与 harness 无关 → 只能接受。

**现有 session 文件无法区分这两者**：pi 不记录 system prompt（§1 机制 1），没有任何「该 turn 前缀指纹是什么、与上一 turn 是否一致」的数据。这就是本设计要补的缺口。

### 3.4 根因

miss 归因需要的三个数据维度中，「间隔」（timestamp）、「模型 / thinking」（model_change / thinking_level_change entry）、「命中量」（message entry 的 usage）pi 原生已记录；唯独「前缀指纹」维度完全缺失。缺失的原因是 pi 的设计取向：session 文件记录对话与状态，不记录 prompt 拼装产物。

## 4. 根因 + 物理数据流

**本章结论：在既有 session 数据流上补一个「指纹」写入点与一个读取分析点，即闭环。**

> **前缀指纹** = system prompt 全文与各组成部分、tools 注册表各自的 sha256。对应 §1 机制 2 中 `before_agent_start` 事件携带的 `systemPrompt` / `systemPromptOptions` 与 `getAllTools()` 返回值。

```
pi 进程（本地 CLI 或 xyz-agent runtime）
  on(before_agent_start)  [每轮 turn 开始]
    → 算 8 个 sha256（口径见 §6.4：全文 1 + 部分 7，其中 toolsList 为 selectedTools+toolSnippets 合并、toolsReg 为注册表）
    → 与进程内存 lastHashes 对比
    → 变化 或 进程首个 turn → pi.appendEntry("cache-probe", {...})
        ↓ pi SessionManager 持久化（追加一行 JSON）
session JSONL（~/.pi/agent/sessions/... 或 ~/.xyz-agent/pi/sessions/...）
  cache-probe entry ──┐
  message entry（含 usage.cacheRead/cacheWrite/input）──┤ 同一文件、时间轴有序
  model_change / thinking_level_change entry ──┘
        ↓ 归因脚本 analyze.py（单数据源，读 JSONL）
  每 turn 一行：(gap, modelChg, thinkChg, prefixChg 及部位, 首笔命中率)
        ↓
  归因矩阵 → 快照方案 GO/NO-GO
```

## 5. 终态：使用者眼里将是什么样的

**本章结论：使用者加载探针后无任何感知差异；跑归因脚本得到一张能直接决策的矩阵。**

### 5.1 成功路径

使用者（未来的决策者）在本地 pi CLI 挂载探针正常工作 1-2 周，然后：

```bash
python3 scripts/cache-probe/analyze.py ~/.pi/agent/sessions ~/.xyz-agent/pi/sessions
```

输出（示意）：

```
== 归因矩阵：gap<30min + 模型未切换 的 turn 首笔 miss ==
模型            前缀未变仍 miss   前缀变了且 miss   前缀变了仍高命中   变化部位 Top
deepseek-v4-*   61%  [服务端淘汰]   39% [可修]        …              contextFiles 12次/toolsReg 3次
mimo-v2.5-pro   20%                80% [可修]        …              toolsReg 9次/skills 2次
== resume 前后基线 hash 对比 ==
跨进程前缀漂移：6/11 次 resume 漂移，部位 = contextFiles（AGENTS.md 编辑）
== 决策建议 ==
前缀变化致 miss 占比 55% × 平均前缀 48k token × MiMo 价差 2.975 元/M → 快照方案 GO，优先固化 contextFiles
```

（以上数字为输出格式示意，非预测值。）

### 5.2 失败路径（带恢复指引）

| 失败 | 现象 | 恢复 |
|---|---|---|
| extension 加载失败 | pi 启动时报 extension error | 去掉 `--extension` 参数即回到无探针状态；`XYZ_AGENT_DEBUG=1` 查 `~/.pi/agent/logs/` 定位 |
| handler 执行异常 | session 文件出现 `data.error` 字段的 entry（缺口可见，非静默） | 查扩展日志；seq 断档 + error entry 即异常边界 |
| hash 假变化（序列化不稳定） | 同状态连发消息却持续产生 entry | 检查 stable stringify（sort keys）实现；验收场景 A 专防此问题 |
| 探针污染前缀（假设被推翻） | agent 行为异常 / token 数异常增长 | 探针不写 LLM 上下文（§1 已核实），此路径理论上不存在；若实测出现，立即卸载并按 §8 场景 F 回溯 |

## 6. 关键决策与权衡

**本章结论：6 个决策，共同达成「零干扰记录 + 单数据源归因」。**

### 6.1 记录载体：变化时插入 custom entry

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. custom entry，变化时才插入 | 数据与 session 同生命周期，无变化零膨胀，entry 序列即变化时间线 | 低（appendEntry 官方 API） | 「无 entry = 无变化」依赖 seq 连续性校验兜底 | ✅ |
| B. custom entry，每 turn 无条件插入 | 同 A 但 turn 密度下文件膨胀（日均数百 turn × 数百字节） | 最低 | session 文件无谓增大；时间线被淹没 | ❌ |
| C. 独立日志文件（extension 写自己目录） | 与 session 生态解耦 | 中 | 双数据源时间轴对账、文件生命周期管理、跨 session 关联都要自己做 | ❌ |
| D. 不做探针，直接实施快照方案 | — | — | 残差归因未知，可能白做（若主因是服务端淘汰，快照无效） | ❌ |

**被否若用**：方案 B 会让一个正常工作日的 session 文件多出数百条无人看的重复 entry；方案 C 会让归因脚本先解决「哪个日志行对应哪个 session 的哪个 turn」的对账问题，复杂度转移到更易错的地方；方案 D 赌错了方向会浪费一个完整 feature 的开发量。

### 6.2 状态管理：无状态 + 进程基线 entry（vs 从 session 恢复 lastHashes）

extension 不读历史 entry 恢复状态，而是 `session_start` 事件时重置（源码核实 reason 取值为 `startup / reload / new / resume / fork` 五种，任一触发均重置，进程内第一个 `before_agent_start` 无条件写一条 `baseline: true` entry）。被否方案（用 `pi.getEntries()` 读回上一条 cache-probe entry 恢复 lastHashes，plan extension 有此先例）能少写基线 entry，但引入读路径依赖与 entry 解析逻辑。「resume 跨进程时前缀是否漂移」由脚本对比 resume 前后两条 entry 的 hash 得出，extension 保持零读依赖。副产品收益：基线 entry 的时间戳天然标记进程边界，`startReason` 字段区分 new / resume / fork 等场景。

### 6.3 usage 不进探针 entry：复用原生记录

pi 的 message entry 原生带 `usage`（含 cacheRead / cacheWrite / input）与 timestamp，探针重复记录只会制造两份数据不一致的可能。被否方案（首笔 usage 写进 probe entry）看似省脚本 join，实则把「哪个 usage 是 turn 首笔」的判定逻辑塞进 extension，而该判定在脚本侧做更易验证。

### 6.4 指纹粒度：全文 hash + 6 部分分 hash + tools 注册表 hash

| 方案 | 能否定位「怎么变的」 | 存储 | 裁决 |
|---|---|---|---|
| 只 hash 全文 | 只知道「变了」，不知道哪部分 | 最小 | ❌ 无法支撑 G2 |
| 全文 + 分部分 hash | 定位到组成部分（contextFiles / skills / toolsList / toolsReg / append / guidelines / customPrompt） | 每 entry 约 400 字节 | ✅ |
| 存全文 | 可做逐字 diff | 每 entry 数 KB~数十 KB | ❌ 膨胀，且 diff 需求未证实 |

「定位到组成部分」已满足归因需要（G1/G2）；若后续确需全文 diff，临时开 debug 变体记录对照（out-of-scope，G5 结论后决定）。`spFull` 与各部分 hash 全不同 → 拼装模板 / 顺序变化，这是分部分 hash 独有的检测能力。

hash 与 `BuildSystemPromptOptions` 全部 8 字段的对应口径：`contextFiles` / `skills` / `append`（appendSystemPrompt）/ `guidelines`（promptGuidelines）/ `customPrompt` 各自独立 hash；**`toolsList` 是 selectedTools + toolSnippets 的合并 hash**（两者共同构成 system prompt 内的工具清单，分开 hash 无归因价值）；`cwd` 不做 hash、以明文记录（cwd 变化必然带动 contextFiles 变化，明文即可判读）；合计全文 1 + 部分 6 + tools 注册表 1 = 8 个 hash。

### 6.5 稳定序列化：sort keys 后 JSON 字符串再 sha256

`getAllTools()` 的 `parameters` 是 TypeBox 对象，直接 `JSON.stringify` 会因 key 顺序不稳定产生假变化。所有 hash 输入必须经 stable stringify（递归 sort keys）。**运行时断言**：同状态连发消息不产生 entry——⛔ 实施期门（验收场景 A）。

### 6.6 seq 语义：每次触发递增，仅写入时落盘

`before_agent_start` 每次触发 `seq += 1`（无论是否写 entry），entry 落盘时携带当时 seq。脚本看到 entry 的 seq 跳跃 = 中间有无变化 turn 被略过或异常漏记，「无变化」与「漏记」可区分，数据缺口可见（G4）。

### 6.7 错误处理与零行为影响

- handler 全程 try/catch；捕获异常时写一条带 `data.error` 的 entry 后重置为需基线状态（保证后续 turn 恢复正常记录路径），错误可见不静默。
- 探针不返回 `systemPrompt`（不参与 before_agent_start 的链式修改结果）、不注册 tool、不 send message——对 agent 行为零改变。
- hook 按 priority 串行执行（单 handler 5s 超时），8 个 sha256 计算在毫秒级，远低于超时。
- **运行时断言**：「custom entry 不进 LLM 上下文」——✅ 已从 pi 源码核实（`sessionEntryToContextMessages` 对 custom 返回空数组），且 §1 所列 3 个生产先例佐证。

### 6.8 加载方式：本地路径，不进 builtin 清单

数据收集期通过 `pi --extension <path>` 本地加载（符合「extension 改动优先在本地 pi CLI 实测」规范），不修改 `packages/shared/src/mandatory-extensions.json`。是否转正为 builtin 由 G5 结论决定——若 NO-GO，探针自然退役，已写入的 entry 留在 session 文件中无任何影响（§1 机制 3 已核实全链路安全）。

## 7. 实现机制

**本章结论：一个 extension（两个 hook + 一个 hash 工具函数）+ 一个分析脚本，两层各自产出终态的一样东西。**

### 7.1 探针 extension（建议路径 `scripts/cache-probe/extension/`，实施期可调）

**加载位置与测量视角约束（源码事实，方案口径的组成部分）**：pi 的 extension 加载顺序固定为 CLI `--extension` 加载的 extension 排在 installed extensions 之前（`resource-loader.ts:452`，`mergePaths(cliEnabledExtensions, enabledExtensions)`）——本地路径加载的探针**必然位于链头**，无法通过参数顺序放到链尾。由此确定测量口径：

- **7 个分 hash 口径可靠**：contextFiles / skills / toolsList / append / guidelines / customPrompt 来自 `systemPromptOptions`，toolsReg 来自 `getAllTools()` 注册表快照——两者在 `before_agent_start` 时点均已定型，不受该事件的链式修改影响，无论链位置如何测的都是同一对象。
- **`spFull` 是「链头视角」全文**：`event.systemPrompt` 在链头位置尚未经过其他 installed extension（如 model-switch、xyz-system-prompt-extension）的 `before_agent_start` 链式修改，**其他 extension 的动态修改是 spFull 的已知盲区**。归因矩阵中「options 全部未变仍 miss」的 turn 不能排除此因素，矩阵需将该类单独标注（详见 §7.2）。
- 口径升级路径见 §11 检查点 5：若 `before_provider_request` 事件能拿到最终发出的请求前缀，spFull 改以该口径为准。

```
state（进程内存）: { lastHashes | null, seq, needsBaseline }
on(session_start):  state = { null, 0, true }，记录 startReason（startup/reload/new/resume/fork 之一）
on(before_agent_start):
  seq += 1
  try:
    hashes = {
      spFull:        sha256(stable(event.systemPrompt)),
      contextFiles:  sha256(stable(event.systemPromptOptions.contextFiles)),
      skills:        sha256(stable(event.systemPromptOptions.skills)),
      toolsList:     sha256(stable([selectedTools, toolSnippets])),
      toolsReg:      sha256(stable(pi.getAllTools() 每项取 name/description/parameters/promptGuidelines)),
      append:        sha256(stable(appendSystemPrompt)),
      guidelines:    sha256(stable(promptGuidelines)),
      customPrompt:  sha256(stable(customPrompt)),
    }
    if needsBaseline:
      appendEntry("cache-probe", { seq, baseline: true, startReason, changed: ["*"], cwd, hashes })
    else if 任一 hash != lastHashes 对应值:
      appendEntry("cache-probe", { seq, baseline: false, changed: [变化字段名], cwd, hashes })
    lastHashes = hashes; needsBaseline = false
  catch e:
    appendEntry("cache-probe", { seq, error: String(e) })   // error entry 无 hashes
    needsBaseline = true   // 下一 turn 重建基线，恢复正常记录
```

entry schema（落在 session JSONL 的一行）。两类 entry 分别示例（未列出的字段视为 undefined，JSON 序列化时省略——`hashes` 在 baseline 与 normal entry 均存在；normal entry 无 `startReason`；error entry 无 `hashes`）：

baseline entry（进程首个 turn，或异常恢复后的重建基线）：

```json
{"type":"custom","customType":"cache-probe","data":{
  "seq":1,"baseline":true,"startReason":"resume","changed":["*"],
  "cwd":"/Users/...",
  "hashes":{"spFull":"…","contextFiles":"…","skills":"…","toolsList":"…","toolsReg":"…","append":"…","guidelines":"…","customPrompt":"…"}
}}
```

normal change entry（后续 turn 检测到变化）：

```json
{"type":"custom","customType":"cache-probe","data":{
  "seq":12,"baseline":false,"changed":["contextFiles"],
  "cwd":"/Users/...",
  "hashes":{"spFull":"…","contextFiles":"…","skills":"…","toolsList":"…","toolsReg":"…","append":"…","guidelines":"…","customPrompt":"…"}
}}
```

写 entry 时机在 before_agent_start handler 内同步完成，不依赖其他事件；`changed:["*"]` 仅 baseline entry 出现。

### 7.2 归因脚本（`scripts/cache-probe/analyze.py`）

输入：一个或多个 sessions 目录。对每个 session 文件：

1. 流式解析 JSONL，抽取五类信息：cache-probe entry、真实用户发言（user role 且含 text 块，定义 turn 边界）、assistant usage（每 turn 首笔）、model_change / thinking_level_change（判定 turn 前是否切换，排除首 turn 初始化写入）、全 entry timestamp（算 gap）。
2. 指纹状态传播：无 entry 的 turn，其指纹 = 最近一条 cache-probe entry 的 hashes（§6.1 的读取侧约定）。
3. 输出归因矩阵（§5.1 格式）+ resume 漂移统计 + 决策建议行；无 cache-probe entry 的旧 session 标记「无指纹数据」跳过指纹维度、其余维度照常统计（供与基线数据交叉验证）。矩阵的 miss 归因分三档：`前缀变化（options 某 hash 变）` / `options 未变仍 miss（两解释并存：服务端淘汰 或 extension 链盲区，见 §7.1 口径约束）` / `模型切换（cache 隔离，已知必然 miss）`——第二档不做单一归因断言，其占比进 G5 决策时按保守口径处理。

脚本不修改任何文件；对畸形行跳过计数并在结尾报告（失败要出声）。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：8 个真实场景覆盖全部 5 个目标；A-E 本地实测，F-G 数据交叉验证，H 为数据收集期终验收。**

改动规模：**大**（新增 extension + 分析工具），但探针本身零行为影响，验收重心在「数据正确性」与「零干扰」。

| 场景 | 回溯目标 | 真实流程 / 数据 / 路径 | 通过标准 |
|---|---|---|---|
| A. 稳定性 | G2、G4 | 本地 pi CLI（真实模型）起 session，连发 3 条消息，不修改任何文件 | session 文件仅 1 条 `baseline:true` entry；无假变化 entry（防 §6.5 序列化不稳）；该 entry 的 `hashes` 含全部 8 个 key 且值均为 64 字符 hex |
| B. 部位定位 | G2 | 场景 A 后向项目 AGENTS.md 追加一行，再发 1 条消息 | 新增 entry 的 `changed` 恰为 `["contextFiles"]` |
| C. resume 检测 | G2、G1 | 场景 B 后退出 pi，`pi --resume` 同一 session 再发 1 条消息 | 出现 `baseline:true` + `startReason:"resume"` entry；脚本对比前后基线 hash 能给出「漂移/未漂移」结论 |
| D. 不重复记录 | G3 | 场景 C 中切换模型与 thinking level 各一次后再发消息 | 无新增 cache-probe entry；session 文件出现原生 model_change / thinking_level_change entry |
| E. 缺口可见 | G4 | 临时注入 handler 抛错（如改一行代码抛异常），发 1 条消息，还原代码再发 1 条 | 出现 `error` entry；下一 turn 恢复为正常 baseline entry，后续记录不受污染 |
| F. 全链路安全 | G4 | 在 xyz-agent 桌面（dev 模式）打开含 cache-probe entry 的 session，resume 并继续对话 | 前端无报错、无脏渲染；对话流与无探针时一致（§1 机制 3 的实测确认） |
| G. join 正确性 | G3、G1 | analyze.py 跑历史 session 目录（无指纹数据的旧文件 + 场景 A-E 的新文件混合） | 不崩溃；旧文件标「无指纹数据」；新文件的 (gap, modelChg) 分组命中率与 §3.1 基线口径一致（抽样 3 个 session 人工核对首笔 usage 归属） |
| H. 决策产出（终验收） | G1、G5 | 挂探针真实工作 1-2 周（覆盖 ≥ 200 个 turn、跨 AGENTS.md 编辑 / extension 升级事件 ≥ 3 次），跑 analyze.py | 矩阵能回答三问题：残差中前缀变化占比？变化部位 Top？resume 跨进程漂移频率？并输出快照方案 GO/NO-GO 及量化依据；若数据不足以决策，明确列出缺口原因 |

> 每个场景回溯 §2 目标；A-E 为真实 pi 进程 + 真实模型调用（mimo-v2.5-pro，本机已配），非单测桩。

## 9. 实施

**本章结论：单阶段交付，探针与脚本可并行开发、独立验收。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | 探针 extension + analyze.py 开发，本地加载 | 数据写入点（§4 数据流上端）与读取点（下端） |
| M1 | 验收场景 A-G | 数据正确性与零干扰实证 |
| M2 | 真实使用数据收集 1-2 周 | G5 决策输入 |

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| unit-1 探针 extension | 两个 hook + stable hash 工具 + entry 写入（§7.1）；独立 JS 文件，本地路径加载 | 零依赖、可独立用验收场景 A-E 验收；与脚本解耦，即使脚本未完成数据已在积累 |
| unit-2 归因脚本 analyze.py | §7.2 全部逻辑；纯读 | 只依赖 entry schema 契约，可用手工构造的 session 文件先开发（场景 G 的旧文件即现成测试数据） |
| unit-3 数据收集计划 | 挂载方式说明 + 收集期检查点（每日跑一次 analyze.py 确认数据在积累）+ G5 决策标准；**终止标准内联**：达到「≥ 200 turn、跨 AGENTS.md 编辑 / extension 升级事件 ≥ 3 次」即触发决策评审（对应验收场景 H）；GO → 探针转正进 builtin 清单另立设计；NO-GO → 停用加载即退役，已写 entry 留存无影响（§1 机制 3），并归档本设计文档结论 | 把「收集多久、何时决策、NO-GO 怎么退役」显式化，防止探针无限期挂着无人问津 |

## 11. 待验证检查点

1. **`before_agent_start` 触发粒度**：源码 `_installAgentNextTurnRefresh` 表明每 turn 一次，但未实测确认。若实测为每笔 LLM 请求触发，hash 对比逻辑不变（同状态不写 entry），仅 seq 语义变为请求数——验收场景 A 顺带确认。
2. **extension 链盲区是否实际存在（§7.1 口径约束的实测确认）**：检查常用 installed extensions（model-switch、xyz-system-prompt-extension 等）是否通过 `before_agent_start` 返回值修改 systemPrompt 全文——若均不修改，spFull 的链头视角与最终视角等效，盲区为空；若存在修改者，记录哪些 extension 参与，作为归因矩阵第二档解释的佐证。
3. **`systemPromptOptions` 各字段可能为 undefined**（如无 SYSTEM.md 时 customPrompt 缺失）：stable hash 需把 undefined 规范化为固定值（如空串），实施时按实际类型定义处理。
4. **xyz-agent 桌面内收集的可行性**：桌面 runtime 经 builtin 打包加载 extension，本地探针在桌面的挂载方式与 CLI 不同（--extension 参数桌面不可配）。数据收集期以 CLI 为主；桌面侧是否值得接，等 G5 结论后再议。
5. **spFull 口径升级路径（before_provider_request）**：若 `before_provider_request` 事件（`extensions/types.ts:692`）携带最终发出的请求体（含经全部 extension 修改后的 systemPrompt），spFull 改以该口径为准——每笔 LLM 请求触发，恰与被测请求一一对应，同时消除 §7.1 的链视角盲区。实施 unit-1 前先核实该事件字段。

## 附录 A：数据与事实来源

- §3.1 实测数据：本仓库分析脚本扫描 `~/.pi/agent/sessions/`（4417 个）与 `~/.xyz-agent/pi/sessions/`（12 个，桌面使用占比低，数据主要反映 CLI 模式），时间范围 2026-05-01 至 2026-08-20，排除 /tmp 与 var-folders 测试目录；命中率口径 = cacheRead / (cacheRead + input + cacheWrite)。
- §1/§3.2 机制事实：pi 源码 `~/Code/git-fork/pi-mono-workspace/main/packages/`（coding-agent / ai 两包）与各家官方文档（DeepSeek api-docs、bigmodel.cn、platform.kimi.com、platform.minimaxi.com、mimo.mi.com），2026-08-20 调研。
- §1 机制 3 前端安全：xyz-agent 仓库 `packages/runtime/src/infra/pi/`（event-adapter / session-entry-mapper / entry-tree-builder）与 `extensions/plan|model-switch|unified-hooks` 先例，2026-08-20 探查。

## 附录 B：变更历史

- v1：初稿。
- v2：对抗式审查修复——修正 `session_start` reason 枚举为源码实际的 5 种（startup/reload/new/resume/fork）；补齐 hash 与 `BuildSystemPromptOptions` 8 字段的对应口径（toolSnippets 并入 toolsList、cwd 明文）；链尾加载从待验证项提升为 §7.1 设计约束；验收场景 A 追加 hashes 完整性校验；unit-3 内联终止标准与 NO-GO 退役流程。
- v3：二轮审查修复——撤回 v2 的「链尾加载约束」（源码 `resource-loader.ts:452` 证实 CLI extension 恒在链头，不可达），改为 §7.1「加载位置与测量视角约束」：options 分 hash 口径可靠、spFull 明示为链头视角并标注 extension 链盲区；§7.2 归因矩阵第二档改为双解释并存不做单一断言；entry schema 拆 baseline / normal 两类示例消除 startReason 矛盾；§4 hash 口径注释修正（全文 1 + 部分 7）；伪代码补 error entry 无 hashes 约定；新增 §11 检查点 2（盲区实测）与 5（before_provider_request 升级路径）。
- v4：三轮终审通过（0 must-fix），采纳 1 条 suggestion：schema 说明补「hashes 在 baseline 与 normal entry 均存在」。
