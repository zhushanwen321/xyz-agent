# pi-session-reader 技术设计：session 定位与渐进式摘要读取

> **一句话结论**：做一个 pi extension `@zhushanwen/pi-session-reader`，提供 `session_read` 多动作工具（find/family/outline/expand/detail/search/export）+ TUI `#` 补全通道，让 agent 按文件名秒定位任意 pi session（含 fork 家族、subagent、workflow），并以 turn 为单位渐进精读——实测 3MB session 的全貌 outline 仅 ~800 token，是原文的千分之一。

**层声明**：当前层 = 技术方案设计；下一层 = 实现计划（代码任务 + 测试）。本设计涉及运行时行为 / 数据流 / 错误处理，准则 5/6/7 全适用。所有运行时断言附探针（附录 A），已实测的标 ✅，实施期门槛标 ⛔。

---

## §1 背景目标

- **S（情境）**：pi 把每个会话完整记录在 session JSONL 文件里（append-only，entry 经 `id/parentId` 构成树）。agent 工作中经常需要回看其他 session：调查历史问题、读 fork 家族、读 subagent/workflow 子代理的产物。
- **C（冲突）**：现状 agent 只能用内置 `read` 直接读 JSONL 原文——无行号、2000 行/50KB 截断、无任何 session 结构感知。实测一个 3MB 真实 session，75.3% 体积是 toolResult 噪音，11.6% 是 toolCall 参数，agent 真正想要的对话内容（user + assistant 文本）只占 4.2%。定位靠猜文件名，读完 context 爆炸。
- **Q（问题）**：怎么让 agent 按文件名片段（如 `38e029`）秒定位任意 session，并以 token 最优的方式渐进精读——先全貌、再定位、后精读，全程避开 toolResult/thinking 噪音？
- **A（答案）**：`pi-session-reader` extension = 一个 `session_read` 多动作工具（发现 + 三层渐进读取）+ TUI `#` 自动补全引用通道。本文展开这个答案。

### 系统是什么

pi 的 session 持久化机制（本设计的操作对象）：

- 每个会话一个 JSONL 文件，路径 `<agentDir>/sessions/<cwd编码目录>/<时间戳>_<sessionId>.jsonl`。`agentDir` 默认 `~/.pi/agent`，xyz-agent 环境下由 `PI_CODING_AGENT_DIR` 环境变量指向 `~/.xyz-agent/pi/agent`。
- **一行 JSON = 一个 entry**。entry 带 `{type, id, parentId, timestamp}` + payload，类型全集：`session`（首行头部）、`message`（role: user/assistant/toolResult）、`compaction`（压缩摘要）、`branch_summary`（/tree 导航摘要）、`custom`（扩展数据，如 subagent-identity）、`model_change`、`thinking_level_change`。
- entry 经 `parentId` 构成**树**：同文件内可分叉（/tree 导航后新分支继续 append）；跨文件的 fork/clone 产生**新文件**，新文件首行 header 带 `parentSession` 字段指向来源文件路径。
- subagent / workflow 的子代理 session 写在独立目录 `<agentDir>/subagents/<cwd编码>/sessions/`，与主 session 不同目录。

### 设计目标（从使用者体验倒推）

使用者是 **pi agent**（LLM），次要使用者是 TUI 中的人类用户。目标：

1. **秒定位**：给文件名任意片段（`38e029`）或名称关键词，一次工具调用返回匹配的 session 候选及元信息（时间/消息数/首消息预览），无需知道完整路径。
2. **可家族追溯**：给一个 session，能列出它的 fork 父链、fork 子代、关联的 subagent session、workflow run——回答「这个 session 从哪来、衍生出谁」。
3. **token 最优渐进精读**：三层模型——L1 turn 级全貌 outline（~800 token 量级）、L2 单轮展开、L3 entry 全文。默认避开 toolResult/thinking，需要时按需取回。
4. **TUI 引用通道**：输入 `#` 弹出当前目录 session 列表，选中插入 `#38e029` 引用文本，agent 见到引用即可用工具消费。

### In / Out of Scope

| In | Out |
|---|---|
| 只读访问 main session / subagent session / workflow agent session | 编辑、删除、恢复 session（pi 已有 `/resume`、`/fork`） |
| find / family / outline / expand / detail / search / export | xyz-agent composer 的 `#` 集成（runtime 侧独立项目） |
| TUI `#` 补全 provider + `/session` 命令 | 跨机器 / 跨 agentDir 聚合 |
| pi TUI 与 xyz-agent RPC 两种模式下工具均可用 | 实时 tail 活跃 session（读取是快照语义） |

---

## §2 现状与问题分析

**结论：现状是「一个通用文本读取工具 + 一种高噪音格式」的错配——agent 要的是对话语义，read 给的是原始字节。**

### 现状：agent 读 session 的真实路径

agent 想回看 `38e029.jsonl` 这个 session 时，现状流程：

```
[agent] bash: find ~/.pi/agent/sessions -name "*38e029*"     ← 自己拼路径，cwd 编码规则要猜
[agent] read /Users/.../sessions/--Users-foo--/2026-08-10T03-12-50-031Z_019fe9a8-...38e029.jsonl
[read 返回] 前 2000 行或 50KB 原文，无行号，截断提示 [Showing lines X-Y of N. Use offset=Z to continue.]
```

内置 read 对 `.jsonl` 无任何特殊处理（pi 0.82.1 `core/tools/read.js:16-20`，截断规则 `core/tools/truncate.js:10-11`：2000 行 / 50KB 先到先截）。agent 拿到的是这样的原始行（真实采样，单行 12KB 的 toolResult 是常态）：

```json
{"type":"message","id":"9f3a...","parentId":"8b21...","timestamp":"...","message":{"role":"toolResult","toolCallId":"call_7f2...","content":[{"type":"text","text":"... 12KB 的 pnpm test 完整输出 ..."}]}}
```

### 真实失败模式

对一个 3.0MB / 1204 entry 的真实 session（本机实测，2026-08-10）：

| 失败模式 | 表现 | 根因 |
|---|---|---|
| A. 定位靠猜 | agent 不知道 sessions 目录的 cwd 编码规则（`--` + 路径替换，pi 私有未导出），只能靠 `find` 碰运气 | 发现能力缺失：没有「按片段找 session」的入口 |
| B. 噪音淹没 | read 一次最多吃 50KB ≈ 原文 1.6%，且 75.3% 是 toolResult、8.6% 是 thinking——agent 要的对话内容被稀释到 4.2% | 摘要能力缺失：read 不理解 entry 语义，字节面前一律平等 |
| C. 翻页灾难 | 3MB 文件要 read 60+ 次（50KB/次）才能扫完，每次翻页都把 toolResult 重新塞进 context | 无渐进模型：没有「先全貌后精读」的两段式 |
| D. 家族盲区 | fork 子代、subagent session 分布在不同目录，无任何现成机制把它们关联起来 | 关联能力缺失：pi 只有 `parentSession` 单向指针（首行 header），无反向索引 |

### 噪音分布（实测数据，设计摘要策略的依据）

```
msg/toolResult:text     2456KB  75.3%  n=271   ← 默认省略，[12.3KB omitted] 占位
msg/assistant:toolCall   379KB  11.6%  n=271   ← 只留 name + 截断 key arg
msg/assistant:thinking   281KB   8.6%  n=176   ← 默认省略
msg/assistant:text       111KB   3.4%  n=73    ← 全留（核心价值）
msg/user:text             24KB   0.8%  n=12    ← 全留（核心价值）
compaction                 8KB   0.3%  n=1     ← 留 summary（高信息密度）
```

### 物理数据流（磁盘 → agent 眼前）

```
磁盘布局（agentDir = ~/.pi/agent 或 PI_CODING_AGENT_DIR 指向目录）
│
├── sessions/
│   └── --Users-foo-Code-bar--/                        ← cwd 编码目录（pi 私有规则，我们不靠它定位）
│       ├── 2026-08-09T10-45-20Z_019fe620-....jsonl    ← 父 session
│       │     首行: {"type":"session","id":"019fe620-...","cwd":"..."}
│       └── 2026-08-09T11-05-06Z_019fe632-....jsonl    ← fork 子代
│             首行: {"type":"session","id":"019fe632-...","parentSession":"...019fe620-....jsonl"}
│
├── subagents/
│   └── --Users-foo-Code-bar--/
│       ├── sessions/2026-..._019fe635-....jsonl       ← subagent session
│       │     尾行: {"type":"custom","customType":"subagent-identity",
│       │            "data":{"rootSessionId":"019fe620-...","slug":"fix-login",...}}
│       └── records/<recordId>.json                    ← manifest（含 sessionFile 绝对路径）
│
└── workflow-state/<runId>.jsonl                       ← workflow run 快照，calls[].sessionFile
    （主 session 内有 customType:"workflow-state-link" entry 指向它；
      ⚠ 此目录在 subagent-workflow 源码中硬编码 ~/.pi/agent，xyz-agent 下要双位置查）

        ↓ pi-session-reader 三条读取路径
┌─────────────────┬──────────────────────────┬────────────────────────┐
│ ① 首行扫描        │ ② 全文解析（仅目标文件）      │ ③ 尾行/manifest 读取    │
│ 全部 .jsonl 只读  │ jsonl → entries → turns   │ subagent-identity /    │
│ 第 1 行建家族索引  │ → leaf 路径 → 摘要渲染     │ records / workflow-state│
└─────────────────┴──────────────────────────┴────────────────────────┘
        ↓
agent 看到的：find 候选列表 / family 家族树 / outline turn TOC / detail 全文
```

### 关键术语（首次定义，后文反复使用）

- **entry**：JSONL 的一行，带 `{type, id, parentId, timestamp}` 的结构化对象。就是 §2 现状里那条 12KB toolResult 所在的 JSON 行。
- **turn（轮）**：分段单位 = 1 条 user message entry + 其后所有 assistant/toolResult/custom entry，直到下一条 user entry。1204 个 entry 的 session 实测只有 26 个 turn（附录 A P-outline）。
- **leaf 路径**：从 root 沿 parentId 走到某叶子的单条路径。pi 重开 session 文件时把 leafId 重置为**文件最后一条 entry**（`session-manager.ts:894-897`），所以「root → 最后 entry」就是用户 resume 时看到的对话线——本设计的默认读取视图。
- **家族（family）**：一个 session 的全部关联 session 集合 = fork 父链 + fork 子代（经首行 `parentSession` 文件路径指针双向建立）+ subagent session（经尾行 `subagent-identity.rootSessionId`）+ workflow run（经主 session 的 `workflow-state-link` entry）。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**TUI 成功路径**（目标 1/3/4）：

```
[用户输入] #
[编辑器下方弹出] 当前目录 session 列表（同 /resume 数据源，modified 倒序）：
    修复 quota providers 的调查     2h前 · 42 msgs · 38e029
    todo goal 优化讨论              1d前 · 18 msgs · a97f8c
[用户选中第一项，编辑器插入] #38e029
[用户继续输入] 总结当时定位到的根因，发给 agent
[agent] session_read { action:"find", query:"#38e029" }        ← 工具剥 # 前缀
[工具返回] 1 匹配：2026-08-10T03-12-50Z_...38e029.jsonl · 26 turns · 3.0MB · cwd /Users/...
[agent] session_read { action:"outline", session:"38e029" }
[工具返回] 26 行 turn 级 TOC（~800 token）：
    T000 03:12 user: 帮我排查 quota providers 为什么…  → 4工具(bash×2,read×2) 根因是… [48KB omitted]
    T013 04:05 user: 现在执行 Phase 2 复盘。 → 3工具(write,bash,…) 复盘结论… [12KB omitted]
    ...
[agent] session_read { action:"detail", session:"38e029", turns:"T013-T015" }
[工具返回] 三轮完整 user/assistant 文本（toolResult 仍省略，可 includeToolResult 取回）
[agent 回答用户] 当时的根因是……
```

**失败路径**（每个错误配恢复指引）：

```
# F1 片段无匹配
[工具返回] 无匹配 session："zz999"。当前目录最近 10 个 session：
           1. 38e029 修复 quota providers…  2. a97f8c todo goal…
           👉 用 session_read { action:"find", query:"recent" } 看全量，或换片段重试。

# F2 片段多匹配（不视为错误，返回消歧候选）
[工具返回] 3 个匹配 "8e0"：
           1. 38e029 … 2h前 · 42 msgs
           2. b8e01a … 1d前 · 7 msgs
           👉 用更长的片段（如 38e029）或 action:"find" 加 cwd/日期过滤。

# F3 subagent session 已被 30 天 TTL GC
[工具返回] subagent session 文件已清理（>30 天 TTL GC）：<path>
           manifest 记录仍在：records/<recordId>.json（task: "fix login bug", slug: fix-login）
           👉 用 session_read { action:"family", session:"<父session>" } 看存活成员。

# F4 detail 索引越界
[工具返回] turn 索引 T099 越界，该 session 共 26 轮（T000-T025）。
           👉 用 session_read { action:"outline", session:"38e029" } 重看有效范围。
```

### 3.2 多方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **D. 专用工具 inline 渐进 + export 物化出口** | ✅ 工具语义自包含，不动内置行为；摘要/分段逻辑纯函数核心可单测；`#` 通道是上游预留的官方扩展点 | 中：core 解析渲染 + 发现层 + 工具适配 + TUI provider 四块 | 低：全部基于导出 API（registerTool / addAutocompleteProvider / getAgentDir） | **✅ 选** |
| A. 仅专用工具 inline（无 export） | 同 D，但大 session 深度挖掘时只能反复调工具，不能 grep | 中 | 低 | ❌ 被 D 吸收 |
| B. 转文档 + 内置 read | 物化文件可 grep/read 组合，但摘要粒度在转换时一次性定死，「渐进」靠多次转换 | 低-中 | 快照过期、文件残留 | ❌ 被 D 的 export action 吸收 |
| C. override 内置 read | 零新工具表面，但 read 契约是「读原文」，静默变摘要违反最小惊讶 | 中-高：委托原实现需复制 pi 内部 read 逻辑（无稳定导出） | **高**：extension 同名 first-registration-wins 冲突 + TUI 警告 | ❌ 否决 |
| E. skill + bash 脚本 | 无 extension 表面，但输出质量无类型保障，每次调用消耗 skill 教学 token | 最低 | 中：脚本质量决定一切 | ❌ 只配当 prototype |

**被否方案 C 若采用，§2 失败模式会变成什么样**：agent 调试 session 机制本身时（如排查坏 session 的原始 entry 字段——xyz-agent 历史上真实发生过 EEXIST 坏 session 事故），`read xxx.jsonl` 静默返回摘要而非原文，agent 在最需要真相的地方被误导；且另一个 extension 若也注册 `read`，先注册者赢，行为取决于加载顺序——三个月后回看必然想骂人。

### 3.3 关键决策与权衡

**D-1：分段单位用 turn，不用 entry 平铺。**
- 选择：L1 outline 每 turn 一行；被否：entry 平铺 outline（每条 entry 一行）。
- 证据：实测 1204 entry 的 session 只有 26 turn。entry 平铺 outline ≈ 1204 行 ~50K token，turn 级 26 行 **~800 token**（附录 A P-outline ✅）。需要 entry 粒度时走 `expand`（L2），平铺模式保留为 `granularity:"entry"` 参数兜底。

**D-2：默认视图 = root → 文件最后 entry 的单条 leaf 路径。**
- 选择：默认只呈现当前对话线，分叉处标注 `[旁支 N entries]`；被否：默认全树平铺。
- 证据：pi 重开文件时 leafId 重置为最后 entry（`session-manager.ts:894-897`），leaf 路径 = 用户 resume 看到的视角——与使用者心智一致。navi 放弃的旁支默认不可见但可 `allBranches:true` 取。⛔ P-leaf-view：实施期验证重建路径与 pi `/resume` 实际展示一致。

**D-3：`#` 选中插入 uuid 后缀片段（`#38e029`），不插入名称。**
- 选择：`#38e029`；被否：`#"session name"`。
- 证据：uuid 后缀最短无歧义、可键盘手敲、与用户已有的「`38e029.jsonl`」心智一致；名称含空格需引号且可重名。工具 find 剥 `#` 前缀后按片段匹配，匹配规则对 uuid 片段 / 完整文件名 / 名称关键词三路兼容。

**D-4：`#` 引用提交时不展开，由工具侧剥前缀。**
- 选择：插入纯文本 `#38e029`，LLM 见到后自行调 `session_read`；被否：`pi.on("input")` transform 把引用展开成路径明文注入。
- 证据：pi 的 `@` 引用同构——插入 `@path` 纯文本，read 工具用 `stripAtPrefix` 剥 `@`（`core/tools/path-utils.ts:41`），提交时不展开。跟随平台先例，不发明第二套引用语义（一致性 > 品味）。

**D-5：家族索引用「全量首行扫描」自建，不用 `SessionManager.listAll()`。**
- 选择：只读每个 `.jsonl` 的第 1 行（header 含 id/parentSession/cwd），建 parentSession→children 反查表，按 `mtime+size` 缓存；被否：复用 pi 的 `listAll()`。
- 证据：`listAll()` 的 `buildSessionInfo` 对每文件**读全文**提取 name/firstMessage（`session-manager.ts:620-702`），只为建家族索引代价过高；首行扫描实测即可拿到 fork 链全部信息（附录 A P-header ✅）。find 需要首消息预览时才对候选文件单独深读。

**D-6：不做解析结果内存缓存，每次调用重读文件。**
- 选择：无状态工具，每次重新解析；被否：进程内 LRU 缓存解析树。
- 证据：3MB 全文解析实测 **22ms**（附录 A P-parse ✅），缓存省的时间可忽略，却引入「活跃 session 写入后缓存失效」的新断言面——准则 8 减法：by construction 正确，不靠机制。

**D-7：subagent/workflow 发现读尾行 identity + manifest 双源，workflow-state 双位置查。**
- 选择：扫 `<agentDir>/subagents/<enc(cwd)>/sessions/*.jsonl` 尾部 `subagent-identity`（实测存在，附录 A P-identity ✅），`records/*.json` manifest 作孤儿补充；workflow 的 runId→sessionFile 走主 session 的 `workflow-state-link` entry → `workflow-state/<runId>.jsonl` 的 `calls[].sessionFile`。
- 证据：subagent-workflow 源码证实（`session-reconstructor.ts:125`、`jsonl-run-store.ts:245-252`）；**已知坑**：workflow-state 目录在该 extension 里硬编码 `~/.pi/agent`（`index.ts:168-173`），xyz-agent 环境下必须同时查 `getAgentDir()` 与 `~/.pi/agent` 两位置（⛔ P-workflow-dual）。
- 边界：30 天 TTL GC 会删旧 subagent 文件（`session-file-gc.ts`），family 标注 `[已清理]` 并指向 manifest（对应失败路径 F3）。

**D-8：export 物化到 `<agentDir>/tmp/session-view-<id>.md`。**
- 选择：大 session 深度挖掘时一次物化完整摘要文件，agent 随后用 read/grep 自由组合；被否：每次深挖都 inline 调 detail。
- 证据：inline 三步（outline→expand→detail）覆盖 80% 场景；剩余 20%（如跨 50 轮全文检索工具输出）用 grep 比逐轮 detail 省一个数量级调用。路径用 `getAgentDir()` 动态推导，禁止硬编码 `~/.pi`。

---

## §4 验收（真实场景，非单测非 mock）

实施完成后，在本机真实 pi 环境（含真实历史 session 数据）验证。每个场景回溯 §1 目标。

| # | 回溯目标 | 验证场景（谁/上下文/操作/预期） | 通过标准 |
|---|---|---|---|
| V1 | 目标 1 秒定位 + 目标 4 `#` 通道 | 真实 pi TUI 里输入 `#`，下方弹出当前目录 session 列表；选中一项插入 `#<片段>`，补一句「总结这个 session 做了什么」发给 agent | agent 调 `session_read` 完成定位+阅读并给出与该 session 实际内容一致的总结；全程未 `read` 原始 JSONL |
| V2 | 目标 3 渐进精读 | 对本机 3.0MB / 26 turn 真实 session：`outline` → 据 TOC 选 2 轮 `detail` | outline 输出 ≤2K token 且 26 行齐全；两步内定位到指定历史事件（如某次 bash 命令的发起轮）；toolResult 默认不出现，`includeToolResult:true` 可取回 |
| V3 | 目标 3 token 对比 | 同一 session，对照组：agent 用内置 read 直接读原文 | 实验组（outline+detail 完成 V2 任务）总 token < 对照组 read 一次（50KB）的 5% |
| V4 | 目标 2 家族追溯 | 对本机真实 fork 对（`019fe632` fork 自 `019fe620`）+ 真实 subagent session（`019fe635`，feat-optimize-todo-goal 目录）跑 `family` | 父链、fork 子代、subagent 列表全部列出且与实际文件属实一致；已 GC 的 subagent（若存在）标注 `[已清理]` |
| V5 | 目标 1 xyz-agent 模式 | dev 实例（RPC 模式，无 `#` 弹窗属预期）让 agent「读一下 38e029 这个 session」 | agent 直接用工具完成 find→outline→detail，功能与 TUI 模式一致 |
| V6 | 错误恢复（F1/F2/F4） | 故意给不存在的片段 `zz999`、多匹配片段、越界 turn 索引 | 三个错误返回均含候选列表或有效范围 + 👉 恢复指引，agent 据指引一次重试成功 |

依赖说明：全部用本机真实 session 文件（`~/.pi/agent/` 已有充足历史数据），无需 mock、无需构造假数据。单元测试（parser/turns/render 纯函数）作回归辅助，不计入验收。

---

## §5 下一层拆分（实现计划预览）

按依赖序分 5 个里程碑，每个独立可验收。

| # | 单元 | 内容 | justification | 验收映射 |
|---|---|---|---|---|
| M1 | **core 纯逻辑核**（零 pi 依赖） | `parser.ts`（jsonl→entries，坏行跳过计数）、`turns.ts`（分段）、`tree.ts`（leaf 路径重建/旁支标注）、`render.ts`（outline/expand/detail 格式化 + token 预算）、`family.ts`（首行扫描/父子链/反查表） | 与本仓 goal extension 的 engine/ports 模式同构：纯函数核心可单测，与 pi API 解耦后改动面最小 | V2/V3 的格式与预算 |
| M2 | **discovery 发现层** | `roots.ts`（`getAgentDir()` 推导三处根目录）、`find.ts`（片段/名称/日期/recent 匹配）、`subagents.ts`（尾行 identity/manifest/workflow-state 双位置） | 定位与解析分离：find/family 只读首行/尾行，不为定位付全文解析成本（D-5） | V1/V4 |
| M3 | **工具适配层** | `tool-adapter.ts`：`registerTool("session_read")`，TypeBox 参数 schema（7 action），错误文案规格（F1-F4 👉 指引） | pi 交互的唯一适配点，业务代码不碰 pi 类型（本仓规则 5 同构） | V1/V2/V5/V6 |
| M4 | **TUI 层** | `hash-provider.ts`（`ctx.ui.addAutocompleteProvider` wrapper：`#` 命中返回 session 候选，否则委托下家）、`session-command.ts`（`/session` 命令 + `getArgumentCompletions` + `ctx.ui.select` 兜底） | TUI 专属能力独立成层，RPC 模式加载时自动跳过（⛔ P-hash-trigger 先验证再展开） | V1 |
| M5 | **export + 验收实跑** | `export.ts` 物化摘要到 `<agentDir>/tmp/`；执行 §4 全部场景 | 独立交付物化出口，避免阻塞主链路 | V3 对照 + 全场景 |

**文件改动地图**：新增 `extensions/session-reader/`（`package.json` 声明 `@zhushanwen/pi-session-reader` + `pi.extensions`），不改任何既有包。发布走 changeset 常规线；是否进 `mandatory-extensions.json` 发布后再定。

**待验证检查点（实施期门）**：附录 A 中全部 ⛔ 项（P-open-active / P-leaf-view / P-hash-trigger / P-workflow-dual），在对应里程碑完成前必须实跑通过，失败则回退设计（如 `#` 通道降级为 `/session` 命令 + `ui.select`）。

---

## 附录 A：探针清单（准则 7）

| ID | 验证的行为 | 探针方法 | 状态 |
|---|---|---|---|
| P-noise | toolResult 占 75.3%、对话内容仅 4.2% | python 统计本机 3.0MB session 各 block 体积 | ✅ 2026-08-10 实测 |
| P-parse | 3MB 全文解析 ~22ms，「不做缓存」成立 | python 逐行 json.loads 计时（Node 同量级） | ✅ 实测 22ms |
| P-outline | turn 级 outline ≈ 800 token（26 行/3.2KB） | python 对真实 session 生成 turn brief 并计字符 | ✅ 实测 3236 chars |
| P-header | 首行恒为 session header；fork 文件含 `parentSession` 路径指针 | 遍历本机 40 个 session 文件首行，找到真实 fork 对 019fe632→019fe620 | ✅ 实测 |
| P-identity | subagent session 尾行存在 `subagent-identity` custom entry（含 rootSessionId） | tail 真实 subagent 文件（019fe635） | ✅ 实测 |
| P-open-active | `SessionManager.open()` 读取**活跃写入中**的 session 文件安全（无锁、不写） | 实施期：对正在对话的 session 调 open 读 entries，确认主进程 append 不受影响 | ⛔ M3 前 |
| P-leaf-view | root→最后 entry 重建路径与 pi `/resume` 展示一致 | 实施期：对含旁支的真实 session 重建路径，与 pi TUI resume 肉眼比对 | ⛔ M1 前 |
| P-hash-trigger | `ctx.ui.addAutocompleteProvider` 包装后 `#` 在真实 TUI 触发弹窗 | 实施期：最小 provider 注册后 TUI 手测 | ⛔ M4 前，失败降级为 `/session` 命令 |
| P-workflow-dual | xyz-agent 环境下 workflow-state 实际落在 `~/.pi/agent`（硬编码）而非 `~/.xyz-agent/pi/agent` | 实施期：xyz-agent dev 实例跑一次 workflow，双位置查 runId 文件 | ⛔ M2 前 |

*注：P-parse/P-outline 用 python 实测，实施时为 Node 实现，同数据量级结论不变；如有出入以 M1 的 Node 基准复测为准。*
