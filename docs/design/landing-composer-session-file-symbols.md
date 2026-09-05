# Landing 态 Composer 支持 `#` session 引用与 `$` 文件引用

> **一句话结论**：landing 态（新建任务空态）补齐 `#`/`$` 两路符号浮层——`#` 走常驻的 sessionStore（删一行 landing 硬空门），`$` 新增 cwd 通道（协议加 `file.search.cwd` 消息 + FileService 拆出按 cwd 扫描的核心函数）；发送链路与 chip 插入零改动（segments 全程透传已验证）；`@` subagent 维持 landing 不弹（out-of-scope 延续 D3 拍板）。

- **层**：技术方案层（下一层产物 = 代码实现任务，§5 给文件改动地图）
- **SSOT 关系**：本文增量修订 `docs/architecture/composer-symbol-system.md` 的 §1 Out 清单第 5 条（landing 态 `@`/`#` 浮层）与 §5 待验证清单第 4 条（landing 空态处理），实施时同批回写（C-proc-10）

---

## 1. 背景目标

**结论：landing 是新任务的起点，用户在这里最需要引用已有 session 和文件，但四符号体系只有 `/` 在 landing 可用——这是体验断裂，不是功能缺失。**

**系统是什么**：xyz-agent 桌面端的 composer 输入区支持四符号内联引用（composer-symbol-system）：`/` 弹命令（slash/skill）、`$` 弹当前目录文件、`#` 弹已有 session（pi `session_read` 协议）、`@` 弹 subagent 定向。符号选中后插入彩色 chip，发送时结构化 Segment[] 序列化为 prompt 文本。

**现状（S）**：对话态（panel）四符号全部可用；新建任务落地页（landing，Panel 在 `messageCount===0 && !isGenerating` 时渲染）只有 `/` 能弹（skill 列表），敲 `#`/`$`/`@` 无任何反应。

**冲突（C）**：landing 的典型场景恰恰是「引用过去」——「基于 `#` 那个 session 的结论继续」「分析 `$` src/index.ts」。用户必须先发一条消息进入 panel 态才能插入引用，引用又只能追加在后续消息里，迫使「空发一条 → 再补引用」的别扭两步。

**问题（Q）**：landing 态为什么弹不出来？是触发链路缺失还是数据源缺失？

**答案（先行给出，§2 展开）**：触发链路四路全通（无 variant 差异），断在**候选数据源以 sessionId 为键**，而 landing 态无 session（延迟 create 设计：选目录只记 `pendingCwd`，session 到首条消息发出才创建）。

**目标**：

| id | 目标（使用者视角） |
|---|---|
| G1 | landing 态敲 `$` 弹出**当前选定目录**的文件候选，选中插绿色 file chip，随首条消息发送后 LLM 能读到文件内容 |
| G2 | landing 态敲 `#` 弹出**跨 cwd 全量**已有 session 候选，选中插金色 session chip（显 label），发送后 LLM 经 `session_read` 获取该 session 上下文 |
| G3 | `@` subagent 在 landing 维持不弹（原 D3 拍板「@ 范围限当前 session」延续，无当前 session 即无数据源） |
| G4 | panel 态四符号行为零回归 |

**In scope**：`#`/`$` 两路的候选数据源、浮层渲染、chip 插入、首条消息携带引用。
**Out of scope**：`@` landing 支持（G3 明确不做）；landing 态 `$` 候选的 gitignore 开关 UI（沿用 panel 默认 `showIgnored=false`）；跨目录文件候选（只列当前选定目录）。

---

## 2. 现状与问题分析

**结论：两路断点性质不同——`#` 是一行刻意的硬空门（当年 out-of-scope 决策的落点），`$` 是整条数据通路以 session 为键；两者之上还有一个共享的「空候选不渲染」守卫把缺数据放大成「无反应」。**

### 2.1 使用者视角的现状

landing 页（`packages/renderer/src/components/new-task/Landing.vue`）复用 panel 的 `Composer.vue`（`variant="landing"`）。用户在 landing composer 里：

- 敲 `/` → 弹出全局 skill + 项目 skill 列表（`CommandPopover.vue` 的 `slashCommands` computed 有 `variant==='landing'` 分支，合并 `globalSkills`/`projectSkills` props）✅
- 敲 `#` / `$` / `@` → **界面无任何变化**（浮层 DOM 不挂载）❌

### 2.2 触发链路（已通，非断点）

四符号触发在 landing 与 panel 完全同构，逐环核实无 variant/sessionId 分支：

```
用户敲 # / $
 → dom-core 触发检测（input-dom.ts detectHashTriggerFromEl / detectSubagentTriggerFromEl，
   条件「行首/空格 + 符号 + 非空白」，无 session 依赖）
 → ComposerInput.vue 转发 emit（# → 'session-trigger'，$ → 'file-trigger'；bash 态 suppress 除外）
 → useCommandPopoverTrigger.makeTriggerHandler：cmdOpen=true + cmdType='session'/'file'
 → CommandPopover 收 open=true
```

### 2.3 断点一：`#` session 路（一行硬空门）

数据源 `sessionStore.list` 是 sidebar 同款的跨 cwd 全量列表，由 `useSidebar` 启动流程 `await loadSessions()`（`useSidebar.ts:356`）填充并经广播维护——**landing 态数据已在内存，不需要任何拉取**。断在纯函数门：

```ts
// packages/renderer/src/components/panel/command-popover-symbols.ts
export function buildSessionCandidates(sessions, query, hasSessionId) {
  if (!hasSessionId) return []   // ← 「landing 态返回空——设计 out-of-scope：无活跃 session 不弹 # 浮层」
  ...
}
// 调用点 CommandPopover.vue items computed：
return buildSessionCandidates(sessionStore.list, props.query ?? '', !!props.sessionId)
```

landing 态 `composerSid = flow.currentSessionId ?? props.sessionId` 恒为 null（延迟 create，见 `landing-precreate-session.test.ts` 头注释），所以 `hasSessionId=false` → 候选空。测试 `composer-hash-trigger.test.ts` S4 固化了该行为。

### 2.4 断点二：`$` file 路（整条通路 session 键控）

与 `#` 不同，`$` 的数据**不在前端**，需要拉取，而拉取通路每一环都以 sessionId 为键：

```
useCommandPopoverFileCandidates(sessionId)
  └─ loadCandidates(): if (!sessionId.value) return   ← renderer 侧门（注释「landing 态无 cwd 不加载」，实为无 sessionId）
       └─ composerApi.getFileCandidates(sessionId)     ← WS 'file.search' { sessionId }（protocol.ts:485，sessionId 必填）
            └─ runtime FileMessageHandler case 'file.search'
                 └─ FileService.searchFiles(sessionId)
                      └─ const cwd = this.requireCwd(sessionId)   ← session 不存在抛 session_not_found
                           （此后全部逻辑——递归 8 层 / ignore / 5000 截止 / 16 并发——以 cwd 为轴）
```

关键观察：**session 在这条链路里只是 cwd 的定位器**。`requireCwd` 之后没有任何环节消费 session 本体。这就是 §3 方案对比的核心依据：给 FileService 拆一个按 cwd 直接扫描的核心函数，session 路变成 `requireCwd + 核心` 的薄包装，即可让 landing 复用全部扫描能力（gitignore 编译缓存、并发上限、DoS 截止）。

### 2.5 共享放大器：空候选不渲染

```html
<!-- CommandPopover.vue -->
<PopoverContent v-if="open && items.length > 0" ...>
```

候选为空时浮层 DOM 完全不挂载。这个守卫本身是合理的（不弹空壳），但它意味着**数据源修好之前任何触发侧的「提示用户」都不存在**——用户视角是纯静默。本设计不改这个守卫：数据通了它自然渲染（G1/G2 达成时此守卫自动满足）。

### 2.6 发送链路（已通，零改动——设计可行性基石）

landing 首发全程透传结构化 segments，已逐环核实：

```
ComposerInput.getSegments()  ← chip DOM → segment（insertSessionChip/insertFileChip 是纯 DOM 操作，零 session 依赖）
 → dispatch/send.ts landing 分支 → flow.submitFirstMessage(segments, ...)
 → createSessionFlow.createSession({ cwd: pendingCwd, segments, ... })   ← image 迁移后原样返回 migratedSegments
 → ports.chat.send(newSid, finalSegments)
 → segmentsToPrompt()：file → 裸相对路径（'src/index.ts'）；session → '#<sessionId>'（label 不进 prompt）
 → pi 消费：相对路径按 pi cwd（=session.cwd=pendingCwd）解析；#<sessionId> 走 TUI session_read 协议（stripHash）
```

两个语义锚点：

1. **file chip 存相对路径是现状设计**（FileNode.path 相对 cwd 无前导斜杠，`file-candidates.ts`），panel 态已工作——pi 进程 cwd 就是 session.cwd，相对路径自解析。landing 沿用同一语义：候选按 `pendingCwd` 扫描，session 创建后 cwd 相同，路径解析成立。
2. **`#<sessionId>` 自包含**：不依赖发送时的任何上下文，panel 态 S4 场景（symbol-system §4 验收表）已验证 LLM 能经 `session_read` 读到被引 session——landing 首发与 panel 发送在 pi 侧不可区分。

### 2.7 物理数据流图（改动后终态）

```
┌─ landing 态 ────────────────────────────────────────────────────────────────┐
│                                                                            │
│  敲 $：Composer ──触发──▶ CommandPopover(open,type=file)                    │
│           │                     │ open 边沿（1s 节流）                       │
│           │                     ▼                                           │
│           │            api.getFileCandidatesByCwd(flow.currentCwd)          │
│           │                     │ WS 'file.search.cwd' { cwd }              │
│           │                     ▼                                           │
│           │            FileService.searchFilesInCwd(cwd)（新：递归核心）       │
│           │                     │ reply 'file.search.cwd:result' { files }    │
│           │                     ▼                                           │
│           │            toFileCandidates → items → PopoverContent 渲染        │
│           ▼                                                                 │
│  选中 → insertFileChip(相对路径) → getSegments → submitFirstMessage           │
│        → create session(cwd=pendingCwd) → send → 'src/index.ts' 进 prompt    │
│                                                                            │
│  敲 #：Composer ──触发──▶ CommandPopover(open,type=session)                  │
│                                 │ items = buildSessionCandidates(           │
│                                 │     sessionStore.list /*常驻*/, query)     │
│                                 ▼                                           │
│                              PopoverContent 渲染（无拉取）                    │
│  选中 → insertSessionChip(sid,label) → send → '#<sid>' 进 prompt → session_read │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径（$）**：用户打开 app → 点 directory chip 选定项目目录 → 在 composer 敲 `$` → 光标下方浮出文件列表（主行 basename、副行父目录路径，与 panel 同款两行展示）→ 继续输入即时过滤（`query` 透传已有）→ ↑↓ 选择 ⏎ 选中 → 绿色 file chip 插入光标处 → 输入任务描述 → ⏎ 发送 → 进入 panel 对话态，首条 user 消息可见 file badge，LLM 回答内容与该文件实际内容一致。

**成功路径（#）**：用户在 landing 敲 `#` → 浮出跨 cwd 全量 session 列表（主行 label、副行 `cwd · 相对时间`，按最近活跃降序）→ 输入过滤 → 选中 → 金色 session chip（显示 label 非 uuid）→ 描述任务发送 → LLM 调 `session_read` 读取被引 session 后作答。

**失败路径与恢复指引**：

| 失败场景 | 用户看到 | 恢复动作 |
|---|---|---|
| 敲 `$` 时无 cwd（`pendingCwd=null`，仅隔离数据目录冷启动可构造——常态启动 `initApp` 已预填最近 session 目录，见 §4 S4a） | 无浮层（无数据源，静默不弹） | 点 directory chip 选目录，或换有历史记录的数据目录再启动 |
| cwd 目录扫描失败（权限/已删除） | 无浮层（reply error → 降级空候选） | 换目录或重选；console 有 warn 日志可排查 |
| `#` 选中了一个已被删除 JSONL 的 session | 发送后 LLM 转述 session_read 报错 | 删 chip 换其它 session；与 panel S5 失败路径同款 |
| 换目录后旧 `$` chip 未删（§3.3 D6 已知边界） | LLM 报找不到文件 | 删 chip 重选（chip label 右侧 × 即删） |

### 3.2 方案对比

**决策主体一：`$` 候选的 cwd 通路（协议层怎么加）**

| | 方案 A（推荐）：新消息 `file.search.cwd` / `file.search.cwd:result` | 方案 B：扩展 `file.search` payload | 方案 C：landing 预建 session |
|---|---|---|---|
| 做法 | protocol.ts 加请求 `'file.search.cwd': { cwd: string }` + reply `'file.search.cwd:result': { files: FileNode[] }`；handler 加 case；FileService 拆 `searchFilesInCwd(cwd)` 核心 | payload 改 `{ sessionId?: string; cwd?: string }`（二选一），handler 内分流 | 恢复「选目录即 create session」（历史上做过，已回退） |
| 长期架构合理性 | reply 语义干净（无 sessionId 字段污染）；session 路零改动零回归；两条通道错误语义独立（session_not_found vs cwd 无效） | 协议类型不增，但 reply `{ sessionId, files }` 在 cwd 模式下 sessionId 只能传空串（语义污染）；「二选一」校验散在 handler；未来第三种来源（如全局搜索）还得再改 | 数据通路全复用（`file.search` 现状直用） |
| 短期实现成本 | protocol 3 处 + handler 1 case + FileService 拆函数（纯搬移）+ renderer api 1 函数 | 略小（不加类型）但 handler 分支复杂度更高，测试矩阵更绕 | 看似零成本 |
| 风险 | 新消息类型需过协议一致性测试（现有 pattern，机械） | 向后兼容靠约定；空串 sessionId 会进 reply 消费方 | **已被否决过**：空 session 堆积 + slash 浮层双源改造后明确恢复延迟 create（`landing-precreate-session.test.ts` 头注释）；若用它，§2.4 的断点「消失」但引入 session 生命周期新问题（用户选目录不发送 → 僵尸 session） |

**推荐 A**。方案 C 是唯一让 §2.4 断点「自然消失」的方案，但它用错误的方式消解问题——历史已证明并回退；被否记录保留在 precreate 测试注释中。方案 B 的「省一个协议类型」买不回语义清晰度（reply 契约是长期面）。

**决策主体二：landing `$` 候选的拉取时机与缓存**

| | 方案 A（推荐）：open 边沿拉 + 1s 节流 | 方案 B：进 fileSearchStore 以 cwd 为键缓存 | 方案 C：Composer mount / cwd watch 预拉 |
|---|---|---|---|
| 做法 | 挂进 `useCommandPopoverOpenFetch` 的 file 路（landing 无 sid 时按 cwd 拉），节流窗口与现有 slash/subagent 路同款 | `useFileSearch` 扩展 cwd 键缓存 | 挂载即拉 / pendingCwd 变化即拉 |
| 合理性 | 对齐现有 open-fetch 模式（同一处代码表达「打开时保证新鲜」）；landing cwd 可能刚被用户改过，边沿拉保证最新 | 同 cwd 二次打开免递归 | 数据早于需求 |
| 成本 | 小（open-fetch 已有节流骨架） | 中（缓存失效信号 file_changes 是 per-session 订阅，landing 无 session **无失效信号 → 脏缓存风险**，需自造失效） | 小 |
| 风险 | 大 repo 首开有递归耗时（与 panel 首开同量级，可接受；panel 同样是边沿+缓存模式） | 脏缓存（用户在浮层外改了文件） | 用户不敲 `$` 也白拉全量递归（5000 节点上限，纯浪费） |

**推荐 A**。减法优先：landing 是瞬态场景（选中即流转 panel），不值得为它引入缓存失效机制。panel 路的 `useCommandPopoverFileCandidates`（session 键控 + store 缓存）**原样保留**，两条路互不干扰。

### 3.3 关键决策与权衡

**D1 `#` 候选：删 `buildSessionCandidates` 第三参，不做「landing 特判」**
- 选择：`buildSessionCandidates(sessions, query, now?)` —— 删 `hasSessionId` 参数，landing/panel 统一「有数据就列」。
- 被否：保留参数、调用点 landing 传 `true`——死参数（恒 true）是坏味道，且「landing 需要特殊门」这个前提已被产品决策推翻。
- 证据：数据源 `sessionStore.list` 启动即填充（`useSidebar.ts:356`）且广播维护，landing 无需拉取；`buildSubagentCandidates` 的 `hasSessionId` **保留**（`@` 维持 landing 空，G3）。
- 探针：✅已测（panel 态 `#` 候选现有测试覆盖纯函数行为，删参后同一批断言改签名即验）。

**D2 `$` 候选数据流：landing cwd 路与 panel session 路分流，落点在 open-fetch + CommandPopover**
- 选择：`CommandPopover` 新增 `cwd?: string | null` prop（Composer 从 `flow.currentCwd` 注入，该实例与 Landing 共享同一 flow 单例）；file 路派生改为「有 sessionId 走现有 hook（store 缓存），无 sessionId 且有 cwd 走 open-fetch 拉取的本地 ref」。
- 被否：把 cwd 拉取也塞进 `useCommandPopoverFileCandidates` 并在内部按有无 sessionId 分流——单 hook 承担两条生命周期不同的数据流（缓存 vs 边沿拉），职责混乱。
- 证据：open-fetch 文件头注释已声明「按 type 分路主动拉」的职责定位，file 路加入是自然延伸。

**D3 open-fetch 守卫改造：`if (!sid) return` 改为按 type 分路判定**
- 选择：slash/subagent 维持「无 sid 不拉」；file 路改为「无 sid 但有 cwd → cwd 拉；两者皆无 → 不拉」；session 路不需要 open 拉（常驻数据，D1）。
- 被否：全局删掉 sid 门——slash 的 `getCommands(sid)` 与 subagent 的 `loadSubagents(sid)` 在 landing 仍然没有合法调用形态（无 session 通道），全局放开会把 G3 的 `@` 也放进数据。
- 证据：`command-popover-open-fetch.ts` 现守卫注释「landing 态无数据源不拉」——该注释对 file 路已过时（landing 有 cwd 数据源了），对 slash/subagent 路仍准确。

**D4 file chip 相对路径语义维持不变**
- 选择：landing 选中文件后 chip 存 FileNode.path（相对 cwd），与 panel 完全一致；不做绝对路径转换。
- 被否：landing 特殊化存绝对路径——两套语义并存会让 segmentsToPrompt/chip 展示/测试全部双分支，且绝对路径在换工作区后失效（相对路径随 session.cwd 始终可解析）。
- 证据：pi 进程 cwd = session.cwd = pendingCwd（createSessionFlow 兑底链），相对路径在 pi 侧自解析（§2.6 锚点 1）。

**D5 换目录后的旧 chip：登记为已知边界，不做主动清理**
- 场景：用户选目录 A → `$` 插 chip → 又换到目录 B → 发送。session 建在 B，chip 的相对路径按 A 语义产生 → pi 在 B 下解析失败 → LLM 转述读不到。
- 选择：不处理（不在 selectWorkspace 时清 composer，不做 chip-cwd 归属校验）。
- 理由（减法优先）：发生率低（landing 换目录且已有 chip）；失败**可见可恢复**（LLM 明确报找不到，用户删 chip 重选，§3.1 失败路径第 4 行）；清理方案都有代价（清 composer 破坏草稿是更差体验）。
- ⛔实施期门：若实施中发现「换目录后 chip 无任何提示」引发用户困惑的实测反馈，再评估「换目录时对 file chip 加弱提示（如 chip 变灰）」——本期不做。

**D6 `file.search.cwd` 的准入边界：不做目录白名单**
- 攻击面分析：新消息让 renderer 可指定任意 cwd 列目录。但现状 `file.search`（session 路）已能列「session.cwd」= 用户经 OS 目录选择器选定的**任意**路径——session 实体不是安全边界，只是 cwd 载体。cwd 通道仅免去了「先建 session」前置，能力集合不变。
- 威胁模型：本地单用户桌面应用；WS 监听 localhost 且有 runtime token 准入（`XYZ_RUNTIME_TOKEN`）；renderer 是唯一合法客户端。
- 缓解：cwd 不存在/非目录 → FileService 结构化报错（FileError）→ 浮层空态 + console warn；扫描上限（深度 8 / 5000 截止 / ignore）与 session 路共用同一实现，无旁路。
- 被否：加「已注册 workspace 白名单」——landing 的 pendingCwd 本就来自目录选择器的任意路径，白名单要么形同虚设要么误伤（用户选新目录即被拒），且与 session 路形成双标。

**D7 `#` 候选的 landing 特殊性：不做任何过滤**
- 选择：landing 与 panel 列同一份跨 cwd 全量（hidden 排除口径不变）。
- 被否：「只列当前 cwd 的 session」——landing 的 pendingCwd 是**即将创建** session 的目录，用它过滤历史 session 会漏掉跨项目引用场景（G2 明确「跨 cwd 全量」是目标）；且 TUI 行为即全量。
- 证据：`buildSessionCandidates` 现有过滤逻辑（hidden 排除 + label/id 子串匹配 + lastActiveAt 降序）在 panel 态已验证，原样复用。

---

## 4. 验收

**验收原则**：以下场景全部在**真实 app**（`pnpm dev` 启动的 Electron + 真实 runtime + 真实 pi 进程）执行，不用 mock；每个场景标注回溯的 §1 目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| S1 | landing `$` 文件引用 | 启动 dev app → landing 点 directory chip 选一个真实项目目录 → 敲 `$` → 输入文件名前缀过滤 → 选中 `src/` 下任一 ts 文件 → 输入「分析这个文件的核心逻辑」→ ⏎ 发送 | ①敲 `$` 后浮层列出该目录文件（两行展示，node_modules/dist 等不出现）②选中后绿色 chip 插入 ③发送进入 panel 态，首条 user 消息可见 file badge ④LLM 回答内容与该文件实际内容一致（说明 pi 读到了文件） | G1 |
| S2 | landing `#` session 引用 | 确保 sidebar 有 ≥2 个不同 cwd 的历史 session（各含可识别的对话内容）→ 新建任务进 landing → 敲 `#` → 选中其中一个 → 输入「参考那个 session 里的结论，继续推进」→ 发送 | ①浮层跨 cwd 列出全量 session（主行 label、副行 `cwd · 时间`）②选中后金色 chip 显示 label 非 uuid ③发送后 turn 中可见 `session_read` 工具调用 ④LLM 回答能衔接被引 session 的内容（引用了其中的具体结论） | G2 |
| S3 | `@` 回归不变 | landing 敲 `@` + 任意文本 | 无浮层弹出，行为与改动前一致（A5 测试继续通过） | G3 |
| S4a | 预填目录直用（常态路径，前提：最近 session 目录仍存在） | 有历史 session 的正常数据目录下启动 → landing **不做任何目录操作**直接敲 `$` → 敲 `#` | ①启动预填生效（`initApp` 取最近 session 的 cwd `presetCwd`，`useSidebar.ts:358-366`）——`$` 浮层列出**预填目录**的文件候选（与最近 session 所在目录特征一致）②`#` 候选正常弹出且与目录无关（session 数据不依赖 cwd） | G1 G2 |
| S4b | 无 cwd 无数据空态（隔离构造） | 隔离数据目录启动 dev 实例（`XYZ_AGENT_DATA_DIR=$(mktemp -d)` pnpm dev，无历史 session、无 workspace 记录 → `pendingCwd=null`）→ 敲 `$` → 敲 `#` | `$` 无浮层无报错（无 cwd 无候选源）；`#` 同样无浮层（无 session 数据）——两者规格一致地「无数据源不弹」，不互斥；console 无 unhandled rejection | G1 G2 |
| S5 | 混合引用首发 | landing 依次插 `$` 文件 chip + `#` session chip + 描述文本，一次发送 | 两条 chip 都渲染在首条消息；LLM 同时拿到文件内容与 session 上下文（回答同时引用两者） | G1 G2 |
| S6 | live ≡ reload 一致性 | S2 发送完成后 → 左侧栏关闭该 session → 从 sidebar 重开 | 对话流与关闭前一致：session chip（金色 label）与 file badge 渲染不变形、不丢失 | G4 |
| S7 | panel 零回归 | 在任一已有 session 的 panel 态依次敲 `/` `$` `#` `@` 并各选一项发送 | 四路行为与改动前一致（浮层、chip、发送、LLM 消费全部不变）；`pnpm --filter @xyz-agent/frontend run test` 全绿（含 S4 翻转后的用例；A5 用例**保留不翻**——它是 `@` landing 不弹的回归护栏） | G4 |

**设计就绪门槛自查**：S1-S7（含 S4a/S4b）均 testable（步骤可执行、通过标准可观察）；S1/S2/S4a 是关键路径，S3/S7 是回归护栏，S4b/S5/S6 是边界与一致性。

---

## 5. 下一层拆分

**实施顺序即依赖顺序**：U1（协议）→ U2（runtime）→ U3（api）为一条纵向链（`$` 路数据通路），U4/U5 为前端消费，U6 测试随各单元同步写，U7 文档收尾。

| # | 单元 | 文件 | 改动要点 | 为什么独立成单元 |
|---|---|---|---|---|
| U1 | 协议类型 | `packages/shared/src/protocol.ts` | ClientMessageType 加 `'file.search.cwd'`；ClientMessageMap 加 `{ cwd: string }`；ServerMessageMap 加 `'file.search.cwd:result': { files: FileNode[] }`；reply 联合 + handler 映射处（照 protocol.ts `'file.search': ServerMessageMap['file.search:result']` 现位模式加 `'file.search.cwd': ServerMessageMap['file.search.cwd:result']`） | 协议是跨包契约 SSOT，单独提交可独立评审 |
| U2 | runtime 服务与路由 | `packages/runtime/src/transport/file-message-handler.ts` · `packages/runtime/src/services/file-service.ts` | FileService 把 `searchFiles(sessionId)` 的 `requireCwd` 之后全部逻辑搬入新核心 `searchFilesInCwd(cwd, showIgnored?)`，`searchFiles` 变 `requireCwd + 核心` 薄包装；handler `handles` 数组 + 新 case（调核心，reply `{ files }`；cwd 无效 → FileError 结构化失败） | runtime 是独立测试单元（vitest 子包），拆分后 session 路行为可独立回归 |
| U3 | renderer api | `packages/renderer/src/api/domains/composer.ts` | 加 `getFileCandidatesByCwd(cwd: string): Promise<FileNode[]>`（`command('file.search.cwd', { cwd })`，JSDoc 注明 landing 专用） | api 域是 WS 通道唯一封装点（§架构约定），不与 U4 混 |
| U4 | 候选派生与拉取 | `packages/renderer/src/components/panel/command-popover-symbols.ts` · `command-popover-open-fetch.ts` · `CommandPopover.vue` · `command-popover-file-candidates.ts` | symbols：`buildSessionCandidates` 删第三参（D1）；open-fetch：守卫按 type 分路 + file 路边沿拉（D2/D3，拉取结果存本地 ref 经 props/回传入 items——落点实施期定，验收标准不变）；CommandPopover：新 `cwd` prop + items 的 session 分支去 `!!props.sessionId`、file 分支 landing 走 cwd 数据 | 四文件同属「候选派生」职责簇，一起改才能保持 items 派生的单一出口；拆开提交会有中间态编译不过 |
| U5 | Composer 接线 | `packages/renderer/src/components/panel/Composer.vue` | `:cwd="flow.currentCwd"` 传 CommandPopover（landing 态有值、panel 态无消费方不受影响） | 一行接线，独立可评审 |
| U6 | 测试 | `__tests__/panel/composer-hash-trigger.test.ts`（S4 翻转为「landing 有候选」、A5 保留）、`__tests__/panel/command-popover-symbols*.test.ts`（删参签名）、`__tests__/panel/composer-file-popover.test.ts`（cwd 路新增）、runtime `file-service` 测试（拆分等价 + cwd 路新增）、协议一致性测试 | 见 TEST-STRATEGY 三视角：构建者（纯函数签名）+ 使用者（浮层 DOM 断言，landing mount 场景）+ 观察者（live≡reload） | 测试是各单元的验收载体，但汇总一个单元便于跑全量回归 |
| U7 | 文档回写 | `docs/architecture/composer-symbol-system.md` | §1 Out 清单第 5 条（landing 态 `@`/`#` 浮层）改为仅 `@` 并链接本文；§5 待验证清单第 4 条（landing 空态处理）同步修订；决策记录增补（landing `#`/`$` 通道设计，指向本文 D1-D7） | C-proc-10：设计决策变更同批回写登记 |

**待验证（设计阶段无法确定，诚实标注）**：

1. open-fetch 拉取结果注入 items 的具体形态（prop 下传 vs composable 返回 ref 直连）——实施期按 `CommandPopover.vue` 300 行 script 上限约束落点，不影响行为契约。
2. `file.search.cwd` 在 mock 模式（`VITE_MOCK=true`）的行为——现 mock 层对 `file.search` 无专属 mock（走 `composer-data.ts` 静态数据），实施时确认 cwd 路在 mock 下返回静态候选或空数组皆可（S1-S7 验收不依赖 mock）。

---

## 附：被否方案谱系（供后续轮次审查参考）

| 被否方案 | 击穿反例/理由 | 出处 |
|---|---|---|
| landing 预建 session（方案 C-1） | 选目录不发送 → 僵尸 session 堆积；历史上实施过并因 slash 双源改造回退 | `landing-precreate-session.test.ts` 头注释 |
| 扩展 `file.search` payload 双模（方案 B-1） | reply `{ sessionId }` 字段在 cwd 模式下语义污染；handler 二选一校验散落 | §3.2 决策主体一 |
| landing file 候选进 store 缓存（方案 B-2） | file_changes 失效信号是 per-session 订阅，landing 无 session 无失效 → 脏缓存 | §3.2 决策主体二 |
| `#` 保留 hasSessionId 参数传 true | 恒 true 死参数；「landing 特判」前提已被产品决策推翻 | D1 |
| file chip 存绝对路径（landing 特殊化） | 双语义并存全链路双分支；绝对路径换工作区失效，相对路径随 session.cwd 始终可解析 | D4 |
| `file.search.cwd` 加 workspace 白名单 | pendingCwd 本就来自任意路径选择，白名单形同虚设或误伤；与 session 路双标 | D6 |
| `#` 候选按 pendingCwd 过滤 | 漏掉跨项目引用（G2 明确全量）；TUI 即全量 | D7 |
| 验收场景「清空 workspace 记录不选目录」单场景验证 `$` 不弹 + `#` 正常弹（R1 原稿 S4） | 启动预填（`initApp` `presetCwd`）使命题不可构造：有历史 session 时预填生效 `$` 会弹；真造出 pendingCwd=null 则 sessions 必为空、`#` 也无数据——两通过标准互斥。拆为 S4a（预填常态）+ S4b（隔离数据目录构造 null 态，两符号一致不弹） | §4 S4（R1 审查 P0-13） |

---

## 修订历史

| 轮次 | 触发 | 修复内容 |
|---|---|---|
| R1 | 对抗式审查（`.review/design-review-landing-symbols-r1.md`，1 must-fix + 3 suggestions） | ①P0-13：S4 拆为 S4a/S4b（反例：initApp 预填使命题不可构造，两通过标准互斥）；②symbol-system.md 三处引用编号修正（Out 清单实为第 5 条、无 §4.4 小节、空态条目实为 §5 待验证清单第 4 条）；③S7 措辞修正（A5 保留不翻，与 U6/S3 对齐）；④U1/§2.7/§3.2 补 reply 消息名 `:result` 后缀（照 `file.search:result` 惯例） |
| R2 | 聚焦复审（新 agent 因原复审进程僵死换防，0 must-fix + 0 suggestion + 2 INFO，报告同文件追加第 2 轮节） | ①S4a 行号收紧 358-370→358-366；②S4a 步骤列补显式前提「最近 session 目录仍存在」。审查确认：S4b env 链无 dev 绕过（paths.ts:41 纯读 env / main.ts dev 兑底 `env ?? ~/.xyz-agent-dev` / process-control.ts:271 显式透传），交叉引用五处全对齐，**设计达到 DoR** |
