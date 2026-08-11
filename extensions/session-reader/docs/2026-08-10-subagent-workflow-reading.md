# session-reader 扩展:支持读取 subagent / workflow 执行记录

> **一句话结论**:扩展 `session_read` 工具,让 LLM 能用现有的渐进式读取流程(outline→expand→detail)直接消费 subagent 对话与 workflow 编排记录。核心 gap 是**读取入口未接通**(引擎已通用、jsonl 已同构),分三层补齐——M0 打通入口、M1 富化导航、M2 新增 workflow 概览渲染。不做衍生工具。

---

## 开篇(SCQA)

- **S（情境）**:session-reader 是 pi 的 session 读取工具,提供 `find → outline → expand → detail` 渐进式读取;pi-subagent-workflow 产生的 subagent 对话与 workflow 编排记录都是 jsonl/json,物理上都在 `agentDir` 下。
- **C（冲突）**:但 session-reader 的读取入口(`resolveSessionId` → `findSessions`)只扫 `sessions/` 目录,subagent 对话文件虽格式同构却读不进来;workflow 的 `RunSnapshot` 编排快照虽有 `family` 已读出 call 指针,但概览字段(状态/步骤/预算)无渲染入口,且 call 对话同样因入口未接通而 detail 不了。
- **Q（问题）**:如何让 LLM 用一套统一的渐进式读取流程,快速消费 subagent 对话 + workflow 编排记录?
- **A（答案）**:分三层扩展 session-reader 自身(不做衍生工具,因为读取引擎已通用且 jsonl 同构)——M0 打通读取入口让 `outline/detail/search/extract` 直接吃 subagent/workflow call session 文件;M1 富化导航(改用 record manifest + `find` 扩扫 `subagents/`);M2 在 family 现有 call 指针发现链路上新增 workflow 概览渲染。

---

## 1. 背景:被设计的系统是什么

**本章结论**:session-reader 是 pi 的 jsonl session 读取器,本设计聚焦让它能读 pi-subagent-workflow 产生的两类"非 main"记录。

session-reader 是一个 pi extension,对外暴露 `session_read` 工具,支持 8 个 action:`find / family / outline / expand / detail / search / export / extract`。它的核心是一条**通用读取引擎**——`parser`(解析 jsonl)→ `tree`(重建 leaf 路径视图)→ `turns`(按 turn 分段)→ `render`(三级渲染 outline/expand/detail)。这条引擎**不区分输入来源**,任何符合 pi jsonl 格式的文件都能喂进去。

pi-subagent-workflow 在运行时产生两类记录,物理上都落在 `agentDir`(动态推导,默认 `~/.pi/agent`,xyz-agent 下为 `~/.xyz-agent/pi/agent`)下:

| 记录类型 | 物理路径 | 格式 | 现状能否被 session-reader 读 |
|---|---|---|---|
| **subagent 对话** | `<agentDir>/subagents/<encodeCwd>/sessions/<ts>_<selfId>.jsonl` | pi jsonl(与 main 同构) | ❌ 读不进来(入口未接通) |
| **subagent manifest** | `<agentDir>/subagents/<encodeCwd>/records/sa-<uuid>.json` | 单行 JSON(元数据) | ⚠️ 仅 family 用尾行 identity,未用 manifest |
| **workflow 编排快照** | `<agentDir>/sessions/<encodeCwd>/workflow-state/<runId>.jsonl` | 单行 rewrite JSON(RunSnapshot) | ⚠️ family 已读出 call 指针;概览字段无渲染入口 |

> **encodeCwd**(关键术语)= `"--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"`。只替换 `/ \ :`,不替换 `.` `_` 空格。源码 `extensions/subagent-workflow/src/execution/path-encoding.ts:15`。
>
> **落盘目录编码键(重要)**:设计上 subagent 目录用 `rootCwd`(subagent-service.ts 经 `PI_SUBAGENT_ROOT_CWD` env 贯穿顶层 ROOT cwd)编码。但**磁盘上存在两类编码目录并存**:ROOT cwd 编码(如 `--Users-zhushanwen-Code-...--`)与 worktree/临时 checkout 路径编码(如 `--private-var-folders-...-pi-sub-sa-<uuid>--`,历史遗留或 env 贯穿未生效场景)。本机实测:98 个 ROOT 编码 + 23 个 worktree 编码目录,两者都含 `sessions/` + `records/`。**因此读取 subagent 必须递归全扫 `subagents/`,不可按单一 mainCwd 定位**(现有 `listSubagentSessions`/`listRecordManifests` 均递归全扫,满足此约束)。

## 2. 设计目标

**本章结论**:从"LLM 作为使用者"的体验倒推四件事。

1. **读任意顶层 subagent 对话**:LLM 拿到一个 subagent 标识(sa-id / sessionFile / 主 session 派生),能用 `outline/expand/detail` 渐进读取,和读 main session 体验一致。
   - **范围声明**:"任意"指**顶层 main 直接发起的** subagent。嵌套 sub-subagent(某 subagent 再派生的子代)从顶层 main 的 `family` 不可达——这是 family.ts 的已知设计范围(`resolveFamily` 只处理 fork 链隔代,不处理 subagent 链隔代,见 §3.3)。M0 打通入口后,嵌套 subagent **若已知其 session id 仍可直接 `outline` 读取**,局限仅在"发现"(family 不列出),不在"读取"。
2. **读 workflow 编排总览**:LLM 能看到某个 workflow run 的状态、各 step 的 agent/耗时/结果摘要、预算消耗。
3. **从 workflow step 跳转对话**:LLM 从 workflow 概览里的某个 call,能跳到对应 subagent 对话做 detail 级深读。
4. **路径零硬编码**:所有路径从 `agentDir` 动态推导,实例隔离(dev `~/.xyz-agent-dev` vs prod `~/.xyz-agent`)不失效。

**In-scope**:`session_read` 工具的 action 扩展与数据源接通(subagent 对话读取 + workflow 概览渲染 + 导航富化)。
**Out-of-scope**:TUI 层可视化(本设计只到工具层);workflow JS 脚本逻辑解析(只读 RunSnapshot 快照,不解析 scatter-gather 等编排语义);写入/修改这些记录(纯读);**解决嵌套 subagent 的 family 可见性**(这是 family.ts 的设计范围,本设计声明局限而不扩大 scope)。

---

## 3. 现状:使用者眼里是什么样的

**本章结论**:LLM 现在想读 subagent/workflow 记录,会卡在三个断点上,每一个都断在读不进来或看不到全貌。

### 3.1 现状的真实样子

`session_read` 当前 8 个 action 的能力边界:

| action | 现状能力 | 数据源 |
|---|---|---|
| `find` | 按 uuid 片段 / 名字 / "recent" 找 session | **只扫 `<agentDir>/sessions/`**(find.ts:177 `listMainSessions`) |
| `family` | 列出 fork 链 + subagent 列表 + **workflow call 列表(已读 RunSnapshot 的 calls 指针)** | 扫 `subagents/` 文件尾行 identity 建关系;workflow 经 `resolveWorkflows`(subagents.ts:392)读主 session 的 `workflow-state-link` → 读 RunSnapshot → 提取 `calls[].sessionFile` |
| `outline/expand/detail/search/extract/export` | 渐进读取单个 session 内容 | 前置 `resolveSessionId` → `findSessions` → **只扫 `sessions/`** |

> 注:`family` 对 workflow **不是**零感知——它已通过 `resolveWorkflows`(subagents.ts:125 调用,:392 定义)读出每个 run 的 `calls[]`(每个 call 是带 `sessionId/sessionFile` 的 SessionRef)。但它**只提取指针,不渲染** RunSnapshot 的概览字段(`state.status/reason/budget/trace/errorLogs/scriptResult`),也没有独立 action 让 LLM 看编排总览。这正是 M2 要补的真实 gap(见 §5.4、§6.3)。

三类记录在磁盘上的物理数据流(当前):

```
┌─ 磁盘(agentDir 动态推导)─────────────────────────────────────────────┐
│ <agentDir>/sessions/<enc>/            ← main session jsonl           │
│   ├── <ts>_<mainSid>.jsonl                                           │
│   └── workflow-state/<runId>.jsonl    ← RunSnapshot(单行 rewrite)    │
│ <agentDir>/subagents/<encodeCwd>/    ← ⚠️ 双类编码目录并存:           │
│   ├── (a) ROOT cwd 编码  --Users-...--                              │
│   └── (b) worktree 编码  --private-var-folders-...-pi-sub-sa-<uuid>--│
│   每个目录下:                                                        │
│     ├── sessions/<ts>_<selfId>.jsonl ← subagent 对话(与 main 同构)   │
│     └── records/sa-<uuid>.json       ← manifest(元数据)            │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼  当前读取入口
┌─ resolveSessionId → findSessions ────────────────────────────────────┐
│  只扫 <agentDir>/sessions/  (find.ts:177 listMainSessions)           │
│  ✅ main session jsonl        → 能找到 → outline/detail 通          │
│  ❌ subagent 对话 jsonl       → 不在扫描范围 → 找不到 → 抛 F1 错误   │
│  ⚠️ RunSnapshot 概览字段      → resolveWorkflows 只提 calls 指针,     │
│                                  status/budget/trace 无渲染入口      │
│  ⚠️ manifest records/*.json   → 仅 family 用尾行 identity,未用 manifest│
│  ✅ family.workflows[].calls  → 已有 sessionFile 指针(但 detail 不了)│
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
        LLM 眼前:能读 main session 内容;workflow 只看到 call 指针列表
```

### 3.2 怎么出错(三个真实失败模式)

**失败模式 A:读不到 subagent 对话内容**。
LLM 调 `family` 拿到某个主 session 派生的 subagent 列表(只有元数据指针),想深读其中一个的对话过程,调 `outline({session: "<sa-id 或 sessionFile>"})` → `resolveSessionId` → `findSessions` 在 `sessions/` 目录找不到该 sa-id → **抛 F1 "无匹配 session"**。链路断在 family 之后。

**失败模式 B:workflow run 编排总览看不到**。
LLM 知道某 session 跑过 workflow(`family` 返回了 `workflows[].runId` + `calls[]` 指针),想看编排过程(整体状态、各 step 跑了什么、花了多少 token)→ `family` 只给了 call 指针,**概览字段无渲染入口**;即使想深读某 call 的对话,也因失败模式 A(入口未接通)而 detail 不了。

**失败模式 C:找不到 subagent(导航缺失)**。
LLM 想直接按"task 关键词 / slug / agentName"搜某个 subagent(不知道主 session 是哪个)→ `find` 只扫 main sessions,搜不到 subagent。必须先猜主 session 再走 family,绕路。

### 3.3 根因

三个失败模式的共同根因:**读取引擎通用,但读取入口被焊死在 `sessions/` 目录**。引擎层(`parser/tree/turns/render`)对 subagent 对话 jsonl **零工作量**(格式同构,`parseSessionFile` parser.ts:157 接受任意路径);问题全在入口层 `resolveSessionId → findSessions` 只认一个目录。workflow 则多一层:`family` 已读 RunSnapshot 的 calls 指针,但概览字段无渲染入口,且 call 对话仍受入口阻塞。

> **RunSnapshot**(关键术语)= workflow run 的单行 rewrite JSON 快照,字段 `v/runId/spec/state.{status,reason,budget,calls[],trace[],errorLogs[],error,scriptResult}/meta`。物理上每个 run 一个 `<runId>.jsonl`,每次状态变更 rewrite 覆盖整行(`jsonl-run-store.ts:242 save()` → `:265 writeFile`)。它**不是** session jsonl,是 workflow 引擎的独立状态文件。
>
> **family 隔代关联的已知边界**:family.ts 的 `resolveFamily` 只遍历 fork 链(`chainIds` = root + parents + 直接 forks,family.ts:49 注释)。sub-subagent 的 `rootSessionId` 指向其**直接父 subagent**(非顶层 main),该父不在顶层 main 的 fork 链上 → 顶层 main 的 `family` 发现不了非 workflow 的普通嵌套 subagent。workflow call session 由 `RunSnapshot.calls[].sessionFile` 直接指向(不走 family 的 subagentsByRoot),故 workflow call 不受此限。

---

## 4. 终态:使用者眼里将是什么样的

**本章结论**:改造后,LLM 用同一套渐进式读取流程,从 workflow 概览到 subagent 对话深读一路贯通。

### 4.1 成功路径(三个典型场景)

**场景 1:从主 session 读某个 subagent 的对话**

```
[LLM] session_read({ action:"family", session:"#019fc731" })
[工具] → subagents: [
  { id:"sa-c8c8dfa8", agentName:"explorer", slug:"recon-storage",
    status:"completed", sessionFile:"<agentDir>/subagents/<enc>/sessions/<ts>_019fc77a.jsonl",
    task:"分析 pi-subagent-workflow 如何持久化...", model:"..." }
  ...
]
[LLM]  // 拿到 sessionFile,直接 outline(M0 打通后入口认任意 subagent 文件)
[LLM] session_read({ action:"outline", session:"019fc77a" })   // 用 subagent 自身 session id
[工具] → turns: [T000 ... T012]  (和读 main session 完全一致的渐进式体验)
[LLM] session_read({ action:"detail", session:"019fc77a", turns:"T005-T007" })
[工具] → 该 subagent 第 5-7 turn 的完整对话
```

**场景 2:读 workflow 编排总览(M2 新增渲染)**

```
[LLM] session_read({ action:"family", session:"#019fc731" })
[工具] → workflows: [ { runId:"wf-1786339613616-o5v1i2", stateFile:"...", calls:[...] } ]
[LLM] session_read({ action:"workflow", runId:"wf-1786339613616-o5v1i2" })
[工具] →
  Workflow wf-1786339613616-o5v1i2  status: done (completed)
  2026-08-10T05:26 → 07:05  (1h39m)  budget: 13 calls
  script: review-fix-loop   slug: review-fix-wave
  Steps:
  #0  review-arch-boundary   completed  7m12s   → session 019fea23 (用 detail 深读)
  #1  review-business-logic  completed  8m51s   → session 019fea24
  ...
  errors: 0
```

**场景 3:从 workflow step 跳转 subagent 对话深读**

```
[LLM]  // 从 workflow 概览看到 #0 step 的 session 019fea23,想看它具体审了什么
[LLM] session_read({ action:"outline", session:"019fea23" })   // 走 M0 打通的入口
[工具] → 该 call 的对话 turns
[LLM] session_read({ action:"search", session:"019fea23", pattern:"must-fix" })
[工具] → 命中列表
```

### 4.2 失败路径(带恢复指引)

**失败:subagent record 存在但 sessionFile 缺失**(failed/cancelled 多数无对话落盘)。
```
[LLM] session_read({ action:"detail", session:"sa-a4cc00d3" })
[工具] → isError: 该 subagent 状态为 failed,无对话记录落盘(pi 延迟写入未触发)。
        record 元数据仍可读:agentName/status/createdAt/task。
        👉 用 session_read { action:"family", session:"<主session>" } 看该 subagent 的 record 概要,
           或换一个 status:"completed" 的 subagent 深读。
```

**失败:runId 模糊匹配多个 workflow run**。
```
[LLM] session_read({ action:"workflow", runId:"wf-1786" })
[工具] → 多匹配(不抛错,返回候选):
  1. wf-1786339613616-o5v1i2 · 2026-08-10 05:26 · done · review-fix-wave
  2. wf-1786339000111-a3b2c1 · 2026-08-10 04:11 · error · map-reduce-test
  👉 用更长的 runId 片段重试,或用 session_read { action:"family", session:"<主session>" }
     查该 session 关联的具体 runId。
```

**失败:subagent 文件已被 GC**(对话 jsonl 被 30 天 TTL 清理,但 manifest 还在)。
```
[LLM] session_read({ action:"detail", session:"019fc77a" })
[工具] → isError: 对话文件已被 GC 清理。
        family 层会据"对话文件缺失"推断 cleanedUp=true(family.ts:167,family 据 fileStats 缺失推断,
        manifest 本身无 cleanedUp 字段)。仍可读 manifest 元数据:agentName/slug/task/model/status。
        👉 用 session_read { action:"family" } 看 cleanedUp 标记,GC 后的 subagent 只能读元数据。
```

---

## 5. 关键决策与权衡

**本章结论**:四个决策共同把现状变成终态——扩展而非衍生、入口扩 scan 范围而非新增 action、family 改用 manifest、workflow 在现有发现链路上加渲染。

### 5.1 决策一:扩展 session-reader vs 衍生工具

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 扩展 session-reader(选)** | 高:读取引擎(parser/tree/turns/render)通用且成熟,session-reader 成为"读 jsonl session"的唯一权威,单一数据源 | 低:引擎零改动,只接通入口 + 加 workflow 渲染器 | 低:沿用现有 agentDir 动态推导、现有错误契约(F1/F2) | ✅ |
| B. 独立衍生 extension(pi-sub-agent-reader) | 低:复制整套渲染引擎 + family 关系建立 + 路径层,形成两个读取器,行为漂移 | 高:从零建引擎副本 | 高:双份维护,subagent session 格式演进时两边不同步 | ❌ |
| C. 仅增强 family(只返回指针,不接通读取) | 低:不解决失败模式 A,family 给了 sessionFile 也读不了 | 最低 | 高:表面通了实际断链 | ❌ |

**被否若用**:方案 B 下,§4.1 场景 1 会变成"LLM 不得不在两个工具间切换——用 session-reader 的 family 找指针,再用衍生工具的 outline 读内容",且两个 outline 行为可能不一致。方案 C 下,场景 1 的 `outline` 调用仍抛 F1,失败模式 A 未解决。

### 5.2 决策二:subagent 读取入口怎么打通

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 扩展 resolveSessionId 的 scan 范围(选)** | 高:入口统一,所有 action 自动受益;subagent session 也是 session,归位到 session 读取器 | 中:`findSessions` 增加 subagent 候选源 + `resolveSessionId` 能解析 subagent 文件路径/sa-id | 低:需处理 sa-id 与 session id 命名空间;find 扫描量随候选增长(见下) | ✅ |
| B. 新增 `subagent` 专用 action | 低:action 膨胀,且渲染逻辑与 outline/expand/detail 完全重复 | 高:重写一套渲染编排 | 中:action 数量增长,LLM 选择负担 | ❌ |

**被否若用**:方案 B 下,§4.1 场景 1 的 LLM 要记两套 action,且 `search/extract` 还得各开一个变体,action 数量翻倍。

**M0 范围细化**:让 `findSessions` 的候选源合并 `listMainSessions` + `listSubagentSessions`(两者 roots.ts 已有),匹配项标记来源;`resolveSessionId` 接受三种输入:完整 sessionId / sa-id / 绝对文件路径(后者直接定位,跳过扫描)。

**性能预期**(find 扫描量):合并后 find 的候选 = main + 全部 subagent sessions。本机 subagent session 数远大于 main(一个 main 常派生十余个 subagent),`find` 的首行扫描候选翻倍,`recent`/名称命中后的 `firstMessagePreview` 补读(读首条 user message)也随候选增长。M0 接受这个成本(单次 find 仍在秒级,LLM 调用频率低);若后续出现延迟,可加"main/sub 来源"参数让调用方收窄范围,或对 subagent 只在 sa-id/uuid 命中时补读 preview。**非正确性问题,不阻塞 M0。**

### 5.3 决策三:family 关系建立的数据源

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 改用 record manifest(选)** | 高:manifest 是 subagent-workflow 维护的结构化、权威数据源,带富信息(task/slug/model/status/agentName),扫描 cost 低(读小 JSON 不读 jsonl 尾部 64KB) | 中:新增 manifest 读取路径,与现有尾行 identity 逻辑并存 | 低:manifest 缺失时回退尾行 identity | ✅ |
| B. 维持现状(扫 session 文件尾行 identity) | 低:O(全部 subagent jsonl) 尾部读取,且无富信息 | 最低 | 中:大量 subagent 时慢;尾行 identity 可能缺失 | ❌ |

**被否若用**:方案 B 下,§4.1 场景 1 的 family 返回的 subagent 列表没有 task/slug/model/status,LLM 无法判断该深读哪个(只能盲选)。

**M1 范围细化**:`buildFamilyFromFs` 增加从 `<agentDir>/subagents/<encodeCwd>/records/sa-*.json` 读 manifest 的路径,把 `task/slug/model/status/agentName/sessionFile` 透到 `SubagentRef`;manifest 缺失(旧版扁平 `~/.pi/agent/records/` 历史遗留或 GC)时回退现有尾行 identity。

### 5.4 决策四:workflow 读取的形态

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 新增 `workflow` action + 合并 trace 级别(选)** | 高:概览/trace 用同一 action 的不同 detail,不膨胀;复用 family 现有 `resolveWorkflows` 发现链路,只补渲染 | 中:新增 RunSnapshot 概览渲染器(发现链路已在 subagents.ts:392) | 低:解析器只读快照,无写入 | ✅ |
| B. 拆成 `workflow` + `trace` 两个 action | 低:action 膨胀,trace 与 workflow 只是 detail 级别差异 | 高:两套渲染 | 中:LLM 选择负担 | ❌ |
| C. 把 workflow 概览塞进 family | 低:破坏 family 单一职责(关系结构 vs 编排内容) | 低 | 中:family 返回体膨胀 | ❌ |

**被否若用**:方案 B 下,§4.1 场景 2/3 需要 LLM 先调 `workflow` 再调 `trace`,而两者信息高度重叠(trace 只是 workflow 的 step 展开),徒增调用。方案 C 下,family 的返回体混入编排详情,语义不清。

**M2 真实边界(修正)**:family **现有** `resolveWorkflows`(subagents.ts:392)已读 RunSnapshot 提取 `calls[].sessionFile` 指针。M2 的真实 gap 是:(a) 不渲染概览字段(`status/reason/budget/trace/errorLogs/scriptResult`);(b) call 对话因入口未接通而 detail 不了(归 M0)。故 M2 = **复用 `resolveWorkflows` 的发现链路 + 新增 `renderWorkflowOverview` 渲染器**,`discovery/workflows.ts` 是从 `subagents.ts` 迁移/抽取 resolveWorkflows 相关逻辑,而非全新建发现层。

**减法考量(准则 8)**:不单独做 `trace` action——workflow 概览的 step 列表已含每个 call 的 prompt 摘要/agent/耗时/session 指针,需要更深内容时直接对 call 的 session 走 M0 的 `detail`,不需要中间的 trace action。

---

## 6. 实现机制(把终态落到代码层)

**本章结论**:三层改动,每层产出终态的一部分,可独立交付与回滚。渲染引擎(parser/tree/turns/render)三层均零改动。

### 6.1 M0 — 打通读取入口(核心,解锁所有内容读取)

**目标**:让 `outline/expand/detail/search/extract/export` 能直接作用于 subagent / workflow call session 文件。**渲染引擎零改动**(已通用)。

改动点(均在 `extensions/session-reader/src/`):
- `discovery/find.ts`:`findSessions` 候选源合并 `listMainSessions` + `listSubagentSessions`,匹配项增加 `source: "main" | "subagent"` 标记。`find` action 输出里体现来源。
- `tool-handler.ts` `resolveSessionId`:接受三类输入并都能定位——(a) 完整 sessionId(扫两个目录)(b) sa-id(扫 subagent records manifest 反查 sessionFile)(c) 绝对文件路径(直接定位,跳过扫描)。
- `discovery/subagents.ts`:**导出** `listRecordManifests`(当前 :275 是模块内部函数)供 find.ts/tool-handler.ts 复用(sa-id 反查)。
- 错误契约:沿用现有 F1(无匹配,带 👉 find recent)/ F2(多匹配,带候选)。新增"文件不存在/已被 GC"错误(带 manifest 元数据回退 + 👉)。

> **SubagentRef.fileName 现状(已确认)**:纯逻辑层 family.ts:127/160 是占位空串,IO 层 `enrichRefs`(subagents.ts)对 **alive** subagent 用 `meta.path` 绝对路径覆盖(subagents.ts:50 `fileName: meta.path`);**cleanedUp 孤儿**(manifest 来,未进 pathToRef)保持空串。故 M0 只需处理 alive 的(绝对路径可直接喂 resolveSessionId);cleanedUp 孤儿本就无对话文件,走 §4.2 GC 失败路径。

### 6.2 M1 — 导航富化

**目标**:让 LLM 选得准、找得到。

- `discovery/subagents.ts` `buildFamilyFromFs`:增加 manifest 读取路径,把 `task/slug/model/status/agentName/sessionFile` 透到 `SubagentRef`(`core/family.ts` 的 `SubagentRef` 接口扩字段)。manifest 缺失回退现有尾行 identity。
- `discovery/find.ts`:支持按 task 关键词 / slug / agentName 匹配 subagent(现 find 只对 main 读首条 user message)。

### 6.3 M2 — workflow action(复用现有发现链路)

**目标**:在 family 现有 call 指针发现链路上,补 RunSnapshot 概览渲染。

新增/改动模块:
- `discovery/workflows.ts`(新,**从 subagents.ts 迁移** `resolveWorkflows`/`readWorkflowCallSessionFiles`/`extractCallSessionFiles` 相关逻辑):负责发现 run + 反查 state file + 读 RunSnapshot。复用现有 `extractCallSessionFiles`(subagents.ts:302,已兼容 NEW `wf-run-v1` 与 OLD callCache 两格式)。
- `core/workflow.ts`(新):`parseRunSnapshot(content): RunSnapshotView`(读最后一行 rewrite JSON,提取 `state.status/state.calls[]/state.trace[]/meta`);`renderWorkflowOverview(view): string`(渲染 §4.1 场景 2 的文本)。
- `tool-handler.ts`:新增 `doWorkflow`(参数 `runId` 或 `session`,输出概览文本 + details 含各 call 的 sessionId/sessionFile 供 M0 的 detail 跳转)。
- `index.ts`:`SessionReadAction` 枚举加 `"workflow"`,schema 加参数。

### 6.4 探针清单(运行时断言,准则 7)

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-encode | encodeCwd 只替换 `/ \ :`,不替换 `.` `_` | path-encoding.ts:15 逐字核对 | ✅ 已验证 |
| P-dualdir | subagent 目录双类编码并存,读取递归全扫覆盖两者 | 本机实测 98 个 ROOT 编码 + 23 个 worktree 编码目录,均含 sessions/+records/;`listSubagentSessions`/`listRecordManifests` 递归全扫 | ✅ 已验证 |
| P-samefmt | subagent 对话 jsonl 与 main 同构,parser 可直接解析 | `parseSessionFile` 接受任意路径(parser.ts:157);真实 subagent jsonl 首行 session entry 结构一致 | ✅ 已验证 |
| P-gap1 | resolveSessionId 当前只扫 sessions/ | find.ts:177 `listMainSessions`;sa-id 调 outline 抛 F1 | ✅ 已验证(本设计根因) |
| P-wfptr | family 现已读 RunSnapshot 提取 calls 指针 | subagents.ts:125 `family.workflows = await resolveWorkflows(...)`;:392 定义;:302 extractCallSessionFiles | ✅ 已验证 |
| P-sessionfile | record.sessionFile 指向对话文件,completed 几乎都有 | 真实产物:1153/1204 有,completed≈95% | ✅ 已验证 |
| P-rootid | record.rootSessionId = 顶层 main session id(**单层场景**) | 端到端:rootSessionId 命中主 sessions 目录 | ✅ 已验证(单层) |
| P-rootid-nest | 嵌套 sub-subagent 的 rootSessionId = 直接父 subagent(非顶层 main) | family.ts:178 注释"指向直接发起 session,可能是中间节点";resolveFamily chainIds 只含 fork 链 | ⛔ M0 实施期取真实 sub-subagent 验证 family 可见性(预期顶层不可达) |
| P-snapshot | RunSnapshot 单行 rewrite | jsonl-run-store.ts:242 save() → :265 writeFile | ✅ 已验证 |
| P-wfreuse | workflow call 复用 subagent session | subprocess-agent-runner.ts:109 委托 `subagentService.executeAndAwait` | ✅ 已验证 |
| P-filename | alive subagent 的 SubagentRef.fileName = 绝对路径 | subagents.ts:50 `fileName: meta.path` + enrichRefs 覆盖占位 | ✅ 已验证(降级自待验证) |
| P-fallback | manifest 缺失时尾行 identity 回退覆盖历史场景 | 旧版扁平 records 无 sessionFile 字段 | ⛔ M1 实施期验证 |

---

## 7. 验收(真实场景,非单测非 mock)

**本章结论**:用真实场景验证 M0+M1+M2 的核心链路与关键边界(双目录编码、嵌套 subagent),在真实 agentDir 数据上跑。

### 7.1 改动规模

大改动(新功能 + 数据源接通 + 新 action),需多个真实场景验收。

### 7.2 验收场景

| 场景 | 回溯 §2 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| **1. subagent 对话渐进读取(ROOT 编码目录)** | 目标 1 | 在真实 agentDir(ROOT cwd 编码目录,如 `feat-optimize-ui` 下)取一个 completed subagent 的 sessionFile → `outline` 用其 session id → `detail` 读 3 个 turn | outline 返回 turn 列表;detail 返回真实对话;体验与读 main 一致;全程不报 F1 |
| **1b. worktree 编码目录边界** | 目标 1 | 取一个 `--private-var-folders-...-pi-sub-sa-<uuid>--` 编码目录下的 completed subagent(本机 23 个此类),验证 `outline/detail` 能读 | 递归扫描覆盖 worktree 编码目录,读取成功(验证 MF2 双目录约束) |
| **1c. 嵌套 subagent 边界** | 目标 1(范围声明) | 取一个 sub-subagent(其 rootSessionId 指向父 subagent):(a) 验证顶层 main 的 `family` **不可达**它(已知局限);(b) 若已知其 session id,M0 `outline` 能读 | (a) family 不列出该 sub-subagent(符合 family.ts 设计范围);(b) 直接用 session id 读取成功 |
| **2. workflow 概览 + call 跳转** | 目标 2/3 | 找一个真实跑过 workflow 的 session(含 `workflow-state-link`):`family` 拿 runId → `workflow` 拿概览(状态/步骤/耗时) → 取某 step 的 sessionId `detail` 读对话 | workflow 输出含 status/steps/budget;各 step 含 sessionId;detail 读真实对话 |
| **3. 导航富化** | 目标 1(选得准) | `family` 看 subagent 列表是否带 task/slug/model/status;`find` 按 task 关键词搜 subagent | subagent 列表带富信息可据此选目标;find 能命中 subagent |
| **4. 失败路径恢复** | 目标 1(错误可恢复) | 对一个 failed/cancelled subagent(record 无 sessionFile)调 `detail`;对模糊 runId 调 `workflow`;对 GC 文件调 detail | detail 返回带 manifest 元数据 + 👉 的错误;workflow 返回多匹配候选(非抛错);GC 返回 cleanedUp 回退 |
| **5. 路径动态推导** | 目标 4 | 在 xyz-agent dev 数据目录(`~/.xyz-agent-dev/pi/agent`)下验证同样链路 | 无硬编码 `~/.pi`,dev/prod 路径都生效 |

> 单元测试(findSessions 合并候选源 / parseRunSnapshot 字段提取 / encodeCwd 边界)仅作回归辅助,不计入验收。验收回答"真实工作里 LLM 能否顺畅完成目标",不是"代码逻辑对不对"。
> 依赖说明:agentDir 真实数据(subagent/workflow 产物)是真实依赖,无需 mock;验收前确保本机有 completed subagent(ROOT + worktree 两类编码目录各一)+ workflow run 产物 + 一个 sub-subagent 样本。

---

## 8. 实施

**本章结论**:分三阶段交付,每阶段交付终态的一部分,各自可独立验收与回滚。

| 阶段 | 内容 | 交付终态的什么 | 验收场景 |
|---|---|---|---|
| **M0** | 打通 resolveSessionId/findSessions 入口 + 导出 listRecordManifests,支持 subagent/workflow call session 文件 | §4.1 场景 1、场景 3 后半段(call 跳 detail)、场景 1b/1c | 场景 1、1b、1c、4、5 |
| **M1** | family 改用 record manifest 富化 + find 扩扫 subagent | §4.1 场景 1 的导航(选得准) | 场景 3 |
| **M2** | 复用 resolveWorkflows 发现链路 + 新增 workflow 渲染 action | §4.1 场景 2、场景 3 前半段(概览) | 场景 2 |

M0 是性价比最高且解锁后续的阶段——它打通后,subagent 对话读取(目标 1)和 workflow call 跳转(目标 3 的深读部分)立即可用。M1/M2 可并行或按需排。

---

## 9. 下一层拆分

**本章结论**:拆成 6 个实现单元,对应三层。

| 单元 | 说明 | justification(为什么这么拆) |
|---|---|---|
| `U1` findSessions 合并 subagent 候选源 | find.ts 候选源合并两个 list 函数 + 来源标记 | M0 最小入口改动,独立可验 |
| `U2` resolveSessionId 多形态输入 | 接受 sessionId/sa-id/绝对路径三种定位 | M0 核心,解耦于 U1(路径直定不依赖 scan) |
| `U3` 错误契约扩展 | 文件不存在/GC 错误 + manifest 回退 | M0 体验完整性,呼应准则 6 |
| `U4` SubagentRef 富化 + manifest 读取 | family.ts 接口扩字段 + subagents.ts 加 manifest 路径 | M1,独立于 M0 的数据源增强 |
| `U5` find 扩扫 + task/slug 匹配 | find.ts 候选源已在 U1 扩,本单元加匹配逻辑 | M1,依赖 U1 |
| `U6` workflow action + RunSnapshot 渲染 | 从 subagents.ts 迁移 resolveWorkflows 发现链路 + 新增 core/workflow.ts 渲染器 + doWorkflow | M2,完全独立的新能力;发现逻辑复用现有 |

### 文件改动地图

```
extensions/session-reader/src/
├── discovery/
│   ├── roots.ts          (现成:listMainSessions/listSubagentSessions 已有)
│   ├── find.ts           [改 U1/U5] 合并候选源 + task/slug 匹配
│   ├── subagents.ts      [改 U4 + 导出 U1/U2 依赖] 加 manifest 读取 + 导出 listRecordManifests
│   └── workflows.ts      [新 U6] 从 subagents.ts 迁移 resolveWorkflows 发现链路
├── core/
│   ├── family.ts         [改 U4] SubagentRef 接口扩字段
│   ├── workflow.ts       [新 U6] parseRunSnapshot + renderWorkflowOverview
│   └── (parser/tree/turns/render 不动 — 引擎通用)
├── tool-handler.ts       [改 U2/U3/U6] resolveSessionId 扩展 + doWorkflow
└── index.ts              [改 U6] action 枚举 + schema
```

---

## 10. 待验证检查点

- **P-rootid-nest**:嵌套 sub-subagent 的 family 可见性。设计上预期顶层 main 不可达(family.ts 只处理 fork 链隔代),M0 实施期取真实 sub-subagent 验证此预期;若实际可达则需更新 §2 范围声明。
- **P-fallback**:旧版扁平 `~/.pi/agent/records/<uuid>.json`(无 sessionFile 字段)是历史遗留,M1 的 manifest 回退需验证这类 record 是否只能走尾行 identity。
- **RunSnapshot 版本兼容**:`extractCallSessionFiles`(subagents.ts:302)已兼容 NEW `wf-run-v1` 与 OLD callCache,M2 解析器需复用该兼容逻辑,不重新发明。
- **agentDir 注入路径**:`session_read` 的 `agentDir` 参数由调用方(pi / xyz-agent runtime)注入,本设计所有路径基于它推导;需确认 xyz-agent runtime 调用 session_read 时传入的 agentDir 正确指向 `~/.xyz-agent/pi/agent`(dev 为 `~/.xyz-agent-dev/pi/agent`)。

---

## 附录:术语速查

| 术语 | 定义 | 物理位置/源码 |
|---|---|---|
| agentDir | pi agent 数据根目录,所有路径的推导基准 | 调用方注入,默认 `~/.pi/agent` |
| encodeCwd | cwd → 目录段的编码函数 | path-encoding.ts:15 |
| 双类编码目录 | subagent 落盘目录存在 ROOT cwd 编码 + worktree checkout 编码两类,读取须递归全扫 | 本机 98 + 23 个 |
| main session | 用户直接交互的主对话 | `<agentDir>/sessions/<enc>/` |
| subagent session | subagent 子进程的对话,格式与 main 同构 | `<agentDir>/subagents/<encodeCwd>/sessions/` |
| record manifest | subagent 终态元数据(含 sessionFile 指针);无 cleanedUp 字段(由 family 据 fileStats 缺失推断) | `<agentDir>/subagents/<encodeCwd>/records/sa-<uuid>.json` |
| RunSnapshot | workflow run 的单行 rewrite 编排快照 | `<agentDir>/sessions/<enc>/workflow-state/<runId>.jsonl`(jsonl-run-store.ts:242 save/:265 writeFile) |
| workflow call session | workflow 内某 agent 调用的对话,本质是 subagent session | RunSnapshot.calls[].sessionFile 指向 |
| rootSessionId | record 字段,**单层场景**= 顶层 main session id;嵌套场景= 直接父 subagent | record.rootSessionId |

## 附录:变更历史

- v1:初稿(五段骨架 + 四决策 + 三层 M0/M1/M2)。
- v2:经 tech-design-review 对抗式审查修复——纠正 workflow 现状失真(family 已读 calls 指针,M2 改为复用发现链路);纠正 encodeCwd 单目录断言(双类编码目录并存,读取递归全扫);声明嵌套 subagent 的 family 可见性局限;补 worktree/嵌套验收场景;核准全部行号;cleanedUp 表述与 SubagentRef.fileName 现状定论。
