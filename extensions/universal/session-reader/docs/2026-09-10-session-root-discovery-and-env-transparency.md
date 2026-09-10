# session-reader 会话根发现与环境自识别

> **一句话结论**：`session_read` 在 xyz-agent/TaiJi 里看不到任何主 session，根因是会话根目录按 pi 的**默认**布局硬编码推导（`<agentDir>/sessions`），而 xyz-agent 用 `--session-dir` 把主 session 放到了**兄弟目录**（`<dataDir>/pi/sessions`）。本设计把根目录解析改为**权威信号优先 + 候选根探测 + 自诊断**，让全部「按 id 找 session」的 action（不只 `find`）在所有宿主下一次命中，并在输出里自报所处环境；同时用 pi 自带的 `SessionManager.listAll` 补上主 session 的**标题检索**。分两阶段交付：阶段一恢复正确性与可诊断性，阶段二补跨会话内容检索。

---

## 开篇（SCQA）

- **S（情境）**：`session-reader` 是 pi 的一个 extension，对外暴露 `session_read` 工具，提供 `find → outline → expand → detail` 的渐进式读取，让 LLM 用结构化语义（turn / entry）而不是裸字节去读 pi 的 session jsonl。它是**刻意设计的护栏**——存在的意义之一就是阻止 agent 直接 `find`/`grep`/`cat` 原始 jsonl。
- **C（冲突）**：在 xyz-agent（含打包版 TaiJi.app）里，`find` / `recent` 对**主 session 完全失明**。实测 `session_read{action:"find", query:"01a08a6e"}` 命中 0 条，而同一时刻 `outline` 传入该文件的绝对路径**一次成功**。agent 连续失败后转向 shell `find` 搜磁盘——护栏被绕过。
- **Q（问题）**：如何让 `session_read` 在任何宿主下都能一次命中，使绕行 shell 搜盘**没有收益**？
- **A（答案）**：把「主 session 根目录」从一条硬编码路径推导，改为「取权威信号（pi 的 `SessionManager` / `PI_CODING_AGENT_SESSION_DIR`）+ 探测候选根 + 给每个根标注来源与文件数」的自诊断发现层；**让 `family` 等按 id 解析的 action 复用同一份根列表**；新增 `doctor` action 把发现层内部状态直接暴露给 agent；元数据（标题/cwd/首消息）改用 pi 的 `SessionManager.listAll` 获取。分两阶段：阶段一恢复正确性，阶段二补检索力。

---

## 1. 背景：被设计的系统是什么

**本章结论**：`session-reader` 是一条通用读取引擎加一层发现层；本次设计聚焦发现层里「主 session 根目录怎么定」这一个决定，以及它导致的两条下游失败（`find` 类与 `family` 类）。**

`session_read` 内部是两层：

| 层 | 职责 | 代表文件 |
|---|---|---|
| **发现层（discovery）** | 决定「有哪些 session 文件、各自在哪、哪些匹配查询」 | `src/discovery/roots.ts`（扫盘）、`find.ts`（匹配）、`subagents.ts`（家族扫描 + subagent manifest） |
| **读取层（core + tool-handler）** | 解析 jsonl、重建 turn/entry 视图、渲染成 token 受控的文本 | `src/core/*`、`src/tool-handler.ts` |

关键性质：**读取层是干净的、来源无关的**——只要给它一个文件路径，它就能读。事故里「绝对路径一次成功」正是这一层的证据。

发现层的输入是一个参数 `agentDir`。它从 pi 的 `getAgentDir()` 取（`src/index.ts:189` 调用 `handleSessionRead(params, getAgentDir(), signal)`）。`getAgentDir()` 的语义是 pi 实装契约（`dist/config.js:420`）：

```js
// pi dist/config.js:420-426
export function getAgentDir() {
    const envDir = process.env[ENV_AGENT_DIR];   // ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR'
    if (envDir) return expandTildePath(envDir);
    return join(homedir(), CONFIG_DIR_NAME, "agent");  // ~/.pi/agent
}
```

发现层用它推导两个根：

```ts
// src/discovery/roots.ts:83-94
export async function listMainSessions(agentDir: string) {
  return scanJsonlRecursive(join(agentDir, 'sessions'), SKIP_DIRS_MAIN)   // ← 主 session
}
export async function listSubagentSessions(agentDir: string) {
  return scanJsonlRecursive(join(agentDir, 'subagents'), new Set())       // ← subagent
}
```

### 1.1 两个宿主，两种布局

`getAgentDir()` 在两种宿主下返回不同值，而 session 的**实际落盘位置只在一种宿主下等于 `<agentDir>/sessions`**：

| 宿主 | `agentDir` = `getAgentDir()` | pi 如何决定 session 目录 | 主 session 实际位置 |
|---|---|---|---|
| **纯 pi CLI** | `~/.pi/agent` | 未指定 → pi 默认：`<agentDir>/sessions/<encodeCwd(cwd)>/` | `<agentDir>/sessions/` ✅ 与推导一致 |
| **xyz-agent / TaiJi.app** | `~/.xyz-agent/pi/agent`（由 `PI_CODING_AGENT_DIR` 注入） | runtime 显式传 `--session-dir <dataDir>/pi/sessions` | **`<dataDir>/pi/sessions/`** ❌ 是 `agentDir` 的**兄弟**，不是子目录 |

pi 的 session 目录优先级（`dist/main.js:530-533`）：

```js
const envSessionDir = process.env[ENV_SESSION_DIR];   // 'PI_CODING_AGENT_SESSION_DIR'
const sessionDir = (parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
    (envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
    startupSettingsManager.getSessionDir();
```

即 **`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > settings.sessionDir > 默认 `<agentDir>/sessions/<encodeCwd>`**。

xyz-agent 走的是第一条：`packages/runtime/src/infra/pi/rpc-client.ts:289` 执行 `args.push('--session-dir', sessionDir)`，其中 `sessionDir = getSessionsDir()`。而 xyz-agent 自己的路径 SSOT 明确把 sessions 定义成 `pi/` 的子目录、`agent/` 的**兄弟**（`packages/runtime/src/infra/pi/pi-paths.ts:105`）：

```ts
/** xyz-pi root: ~/.xyz-agent/pi/ */
export function getPiRoot(): string { return join(getConfigDir(), 'pi') }
/** xyz-pi agent directory: ~/.xyz-agent/pi/agent/ */
export function getPiAgentDir(): string { return join(getPiRoot(), 'agent') }

export function getSessionsDir(): string {
  return join(getPiRoot(), 'sessions')     // ← ~/.xyz-agent/pi/sessions，不是 agentDir/sessions
}
```

> **`agentDir`** = pi 的 agent 配置目录，读 `PI_CODING_AGENT_DIR`，存放 `models.json` / `settings.json` / `auth.json`。
> **`sessionDir`** = session jsonl 的存放目录。二者在纯 pi 下是父子关系（`<agentDir>/sessions`），在 xyz-agent 下是**兄弟关系**（`<dataDir>/pi/sessions`）。工具把两者当成同一个推导式，这就是全部问题的根。

**subagent 不受影响**：xyz-agent 没有覆盖 subagent 目录，`subagent-workflow` 用 `getPiAgentDir()` 派生子路径，所以 `<agentDir>/subagents/` 在两个宿主下都成立。这解释了事故里最反直觉的现象——**subagent 查得到、主 session 查不到**。

### 1.2 受影响的 action 不止 `find`

发现层的根列表是**多个 action 的共享数据源**。除了 `find`，还有：

- `family` / `export{format:"family"}` → `tool-handler.ts:707,882` → `buildFamilyFromFs(sessionId, agentDir)` → `subagents.ts:99 collectMainSessions()` → **同一条 `listMainSessions(agentDir)`**。
- 其余按 id 解析的 action（`outline`/`expand`/`detail`/`search`/`export`/`extract`/`workflow`/`result`）走 `resolveSessionId` 的片段分支 → `findSessions`。

所以只修 `findSessions` 会制造一个**新的矛盾**：`find` 说这个 session 存在，`family` 紧接着说它不存在（§3.2 失败模式 C 的加强版）。本设计把根列表作为**单一数据源**供全部发现层消费者使用。

---

## 2. 设计目标

**本章结论**：改造后，agent 在任何宿主下都能用 `session_read` 完成「定位 → 阅读 → 检索」全流程，无需任何 shell 搜盘。**

1. **任何宿主下主 session 全 action 可见**：`find`（uuid / recent / 关键词三条匹配路径）以及 `family` / `export{format:"family"}` 等按 id 解析的 action，候选集必须包含当前宿主的全部主 session。
2. **失败时能自证，且不给出错误归因**：定位失败的错误信息必须携带「发现层内部状态」（每个候选根路径 + 文件数）+ 一条**确定能成功**的替代动作 + 明确的禁止项；**不得**在证据不足时断言「真的没有这个 session」。
3. **环境透明**：agent 能直接问出「我现在跑在纯 pi 还是 xyz-agent/TaiJi，数据目录在哪」，不必靠猜或探测。
4. **主 session 可按人话检索**（范围限定）：能用标题（如「福耀玻璃深度研究」）、cwd、时间检索**当前宿主会话根**内的主 session，不必记 uuid。**显式不覆盖**：纯 pi 的跨项目标题检索（pi 默认布局把各项目 session 放在 `<encodeCwd>/` 子目录，标题检索需逐目录全量解析，成本不可接受——§6.6 调用策略 2）。
5. **跨会话内容检索**（阶段二）：能回答「哪个 session 讨论过 X」，而不是只能按元数据匹配。

**In-scope**：`session-reader` extension 的发现层重构（根解析 / 环境识别 / `doctor` / 错误信息 / 检索维度）；`subagents.ts` 的家族扫描接入同一根列表；xyz-agent 侧为 session 目录增加一个自描述环境变量并完成 forward 登记。
**Out-of-scope**：
- 不改任何 session 文件的**写入**路径与格式（session-reader 纯读）。**边界声明**：本设计的宿主侧改动会新增一个 pi 可继承的 env 变量，它影响 pi 子孙进程「往哪个目录写新 session」——这是**宿主 spawn 配置**的变更，不是 session 文件格式的变更；该继承面的完整枚举与代价见 §6.5。
- 不改 pi 源码（[MANDATORY] 上游不改）。
- 不做 TUI 侧改动（`hash-provider` / `/session-pick` 数据源已是 `SessionManager.listAll` 且仅 TUI 注册，不受本 bug 影响）。
- 不在工具 description 里注入环境信息（理由见 §6.4）。
- 不引入持久化索引文件（阶段二先用「窄化后线性扫 + 字节上限」，是否需要索引见 §11）。

---

## 3. 现状：使用者眼里是什么样的

**本章结论**：agent 拿不到任何候选，工具把失败误报成「没有这个 session」，并在错误信息里把 agent 指向一个同样会失败的下一步；最后 agent 只能去 shell 搜盘。**

### 3.1 现状的真实输出

无匹配时，工具返回（`src/tool-handler.ts:384-391` 实装文案）：

```text
无匹配 session："01a08a6e"。最近 3 个 session：
  1. 01a08aac… 修复…
  2. 01a08aab… 红队证伪…
  3. 01a08aa7… 【任务】…
👉 用 session_read { action:"find", query:"recent" } 看全量，或换片段重试。
```

`find` 命中时，每条候选只打印 **8 字符截断 id**（`src/tool-handler.ts:434`，`SESSION_ID_PREFIX_LEN = 8`）：

```text
1. 01a08aac… 2026-09-10 Stock
2. 01a08aab… 2026-09-10 Stock
```

工具自己声明的行为边界（`src/index.ts:152` description）：

> `Do NOT use for the current session (the host provides current-session access) …`
> `outline before detail. Never read raw .jsonl files—use this tool.`

### 3.2 怎么出错（实机复现）

在 xyz-agent 真实数据上跑发现层（探针命令见 §12.2）：

| # | agent 的调用 | 实测结果 | 期望 |
|---|---|---|---|
| 1 | `find{query:"01a08a6e"}` | 0 命中 | 命中主 session |
| 2 | `outline{session:"01a08a6e-74fc-78a4-9580-8539b40e0920"}` | 无匹配 | 返回 outline |
| 3 | `find{query:"01a08a"}` | 34 命中，**全是 subagent，主 session 0 条** | 含主 session |
| 4 | `find{query:"recent"}` | 同样 0 条主 session | 含主 session |
| 5 | `outline{session:"~/.xyz-agent/pi/sessions/2026-09-10T08-28-09-852Z_01a08a6e-….jsonl"}` | **成功** | 成功 |

失败模式归纳：

- **A（主 session 全盲）**：`find` / `recent` / `family` 的候选集里主 session 恒为 0。**这是唯一的根因性失败**，#1/#2/#3/#4 全部由它派生。
- **B（误导性恢复指引）**：错误信息推荐 `action:"find", query:"recent"`，而 `recent` 走的是**同一个**候选集 → 照做必然二次失败。
- **C（失败归因错误）**：工具把「根目录配错」表现为「没有这个 session」，agent 无法区分二者，于是怀疑是自己 uuid 记错，反复换片段重试。
- **D（输出不可复制）**：`find` 只给 8 字符截断 id，agent 无法把它粘回去做精确调用 → 被推向 shell `ls`。

### 3.3 对 handoff 报告的核对结论（重要）

原诊断把它拆成两个独立缺陷（P0-1 主 session 索引缺失 / P0-2 uuid→文件解析失效）。**核实结论：P0-2 不是一个独立缺陷，是 P0-1 的表现——但仅限 handoff 列举的输入形态。**

依据：`session` 参数的三种形态走三条**互不相交**的解析分支（`src/tool-handler.ts:266-288`）：

```ts
// ① 绝对路径或 ~ 前缀（Windows 盘符由 isAbsolute 处理）
if (isAbsolute(session) || session === '~' || session.startsWith('~/')) {
  return resolveBySessionPath(session)      // ← 直接 stat + 读首行，完全不经过发现层
}
// ② sa-id 前缀 → record manifest 精确反查
if (session.startsWith('sa-')) return resolveByRecordId(...)
// ③ 其余：findSessions 透传 source 沿用 F1/F2
return resolveByFragment(session, agentDir, source)   // ← 走发现层，撞的是同一个根
```

- 分支 ①（绝对路径）**从不查候选集**——它 `existsSync` + 读首行 header 就返回。所以 #5 成功只证明读取层没坏，不证明「uuid→文件解析链路」有任何独立问题。
- 分支 ③（片段）走 `findSessions`，命中条件是纯子串（`src/discovery/find.ts:375-377`）：

  ```ts
  const uuidHits = candidates.filter(
    (c) => c.ref.sessionId.includes(query) || c.meta.path.includes(query),
  )
  ```

  这条子串匹配**天然覆盖 handoff 列举的全部输入形态**。实测（用真实 14 个主 session 构造候选集）：

  | 传入形态 | 修复候选集后命中 |
  |---|---|
  | `01a08a6e`（8 位前缀） | 3 main ✓ |
  | `01a08a6e-74fc-78a4-9580-8539b40e0920`（完整 uuid） | 1 main ✓ |
  | `a08a6e-74fc`（任意位置子串） | 1 main ✓ |
  | 完整 basename（含时间戳前缀） | 1 main ✓ |
  | `#` + uuid | 由上游 `stripHash`（`tool-handler.ts:111-113`，调用点 `:269`）剥离，工具路径 OK ✓ |

  所以「uuid 解析」对 handoff 列举的形态**不需要新增能力，候选集修好即自动成立**。P0-2 的验收项（#1/#2 转 ✅）合并进 P0-1。

**但「自动全好」有边界——存在两个 handoff 未列举、修好候选集后仍 0 命中的形态**（实测同上）：

| 传入形态 | 修复候选集后命中 | 原因 |
|---|---|---|
| `01A08A6E-74FC-…`（**大写** uuid） | **0** | `String.includes` 大小写敏感 |
| `01a08a6e74fc78a495808539b40e0920`（**去连字符**） | **0** | 与带连字符 id 不构成子串 |

更糟的是这两个形态会被 `looksLikeUuidFragment`（`find.ts:156-158`，`/^[0-9a-f-]+$/i`，**大小写不敏感**）判为「像 uuid 片段」→ **跳过关键词回退** → 0 命中。若按 v1 设计直接把自检结论写成「根解析正常，这是真的没有这个 session」，对这两个输入就是**错误归因**——正是 §3.2 失败模式 C 的翻版。处理见 §6.7。

**handoff 另有两处事实需更正**：

- handoff §6 把 `…/2026-09-10T08-28-09-852Z_01a08a6e-74fc-….jsonl` 标注为「福耀玻璃深研」。该文件实际的标题是 **「太保寿险深度研究攻坚」**；「福耀玻璃深度研究」是同一分钟创建的另一个文件 `…_01a08a6e-0d26-….jsonl`。这本身无关紧要，但它说明**即使路径正确，靠文件也无法判断内容是哪个标的**——正好是 §2 目标 4（标题检索）要解决的问题。
- handoff §2 记录「`~/.xyz-agent/pi/sessions/` 47 个 jsonl」。本次实测为 **14** 个（环境随时间变化），不影响结论。

### 3.4 为什么第 3 条「34 命中全是 subagent」不是 bug

`find{query:"01a08a"}` 命中 34 条 subagent 是**正确行为**：pi 的 session id 是 uuidv7，v7 的前缀是毫秒时间戳，所以同一小时内创建的 session 天然共享 6–7 位前缀。实测命中项的 id 形如 `01a08aac-…` / `01a08aab-…`，确实都含 `01a08a`。

> **这条事实改变设计取向**：短 uuid 片段**在构造上就是弱检索键**（时间前缀碰撞）。把「一次命中」寄托在片段匹配上不可靠，必须补标题、cwd、时间这些**语义键**（§2 目标 4）。

---

## 4. 根因 + 物理数据流

**本章结论**：唯一的根因是 `listMainSessions` 把「pi 的默认 session 布局」当成「session 布局」，而 xyz-agent 用 CLI 参数覆盖了它；发现层没有任何机制把这个覆盖反馈给自己。**

### 4.1 根因

```ts
join(agentDir, 'sessions')   // src/discovery/roots.ts:84
```

这一行隐含了一个**未被声明、也未被校验的假设**：`sessionDir === <agentDir>/sessions`。该假设：

- 在**纯 pi** 下成立（pi 默认布局，`dist/core/session-manager.js:242-247` 的 `getDefaultSessionDirPath`）；
- 在 **xyz-agent / TaiJi.app** 下**不成立**，因为 runtime 用 `--session-dir` 显式覆盖成了 `<dataDir>/pi/sessions`。

发现层拿不到「sessionDir 被覆盖了」这个信息，因为它只接收 `agentDir` 一个参数。**信息不对称**，而非逻辑错误。

> 这是**猜测 vs 权威**的问题：工具在**猜** session 根在哪（按 pi 默认布局推），而宿主**知道**它在哪（`SessionManager` 已解析、`--session-dir` 在 argv 里）。修法是让工具从「猜」改成「问」。

### 4.2 实测的四个根目录（三宿主对照）

| 宿主 | `<agentDir>/sessions` | `<dirname(agentDir)>/sessions` | `<agentDir>/subagents` | 真值 |
|---|---|---|---|---|
| xyz-agent（TaiJi.app） | 2（另有 6 个在 `workflow-state/` 被有意跳过） | **14** | 1330 | 14 |
| xyz-agent-dev | 0 | **35** | 62 | 35 |
| 纯 pi | **4619** | 0（`~/.pi/sessions` 本机为空） | 2596 | 4619 |

注一：`<agentDir>/subagents` 一列三个宿主全部正确——再次印证 subagent 路径不受本 bug 影响。
注二：`~/.pi/sessions` 在**本机**为空是 pi 自己的 `migrations.js` 迁移结果；**不能当作通用前提**。注意有**两条互不相同的迁移链**会产生「legacy 非空」状态：① 纯 pi 侧——pi 的 `migrations.js` 把旧 `~/.pi/sessions` 迁入 `<agentDir>/sessions`，中断则前者残留；② xyz-agent 侧——`packages/runtime/src/infra/pi/pi-maintenance.ts:71,97` 把 `<configDir>/sessions`（即 `~/.xyz-agent/sessions`）迁入 `<configDir>/pi/sessions`，中断则前者残留——**注意 `~/.xyz-agent/sessions` 不在本设计任何候选根里**（候选根是 `dirname(agentDir)/sessions` = `~/.xyz-agent/pi/sessions`），若需覆盖属另一处缺口（§11.7）。本设计对 `[legacy]` 根采用「非空即纳入候选 + doctor 告警标注」而非「假定其为空」（§6.1）。

### 4.3 物理数据流（现状）

```text
磁盘                                                        发现层                         agent 眼前
────────────────────────────────────────────────────────────────────────────────────────────────────
~/.xyz-agent/pi/sessions/                    ┐
  2026-09-10T08-28-09-852Z_01a08a6e-74fc….jsonl │  ← 真值在这
  2026-09-10T08-27-43-270Z_01a08a6e-0d26….jsonl │
  （14 个）                                    ┘
                                                          listMainSessions(agentDir)
~/.xyz-agent/pi/agent/sessions/              ┐             = join(agentDir,'sessions')
  --Users-…-stock-dag-plugins-…--/            │  ← 扫的是这里
    （2 个迁移残留 session）                    │
~/.xyz-agent/pi/agent/subagents/             ┘
  --Users-zhushanwen-Stock--/sessions/          scanJsonlRecursive(…, 'subagents') ✅
    （1330 个 subagent session）              ─────────────────────────────────────→  34 条 subagent 候选
                                                                                        主 session: 0 条
                                                                                              ↓
                                                                                    F1「无匹配 session」
                                                                                    👉 提示去用 recent
                                                                                    （recent 走同一候选集）
```

### 4.4 环境识别现状：宿主身份是「可观测但未被观测」的

agent 与工具都不知道自己跑在哪个宿主。但环境里其实已有充分证据（以下均为**活体进程实测**，非推断）：

| 信号（`process.env`） | 纯 pi | xyz-agent dev | TaiJi.app | 单独使用的可靠性 |
|---|---|---|---|---|
| `XYZ_AGENT_EXT_LOG` | 无 | `1` | `1` | **中**——xyz-agent 无条件注入（`rpc-client.ts:195`，注释「托管语义恒为 `'1'`」），但 `ENV_WHITELIST_PREFIXES` 含裸 `XYZ_` 前缀（`packages/shared/src/constants.ts:74`），用户 shell 里的同名变量会透传进**任何**进程 |
| `PI_CODING_AGENT_DIR` | 无（除非用户自设） | `<dataDir>/pi/agent` | 同左 | 中——pi 原生变量，裸 pi 用户也可能设；但其**值**形态（`*/.xyz-agent*/pi/agent`）是 xyz-agent 专属约定 |
| `XYZ_AGENT_DATA_DIR` | 可能被用户 shell 设置 | `<dataDir>` | 同左 | **低**（单独用）——非 xyz-agent 专有 |
| `XYZ_AGENT_PACKAGED` | — | **已被剥除** | **已被剥除** | **不可用**——在 `SPAWN_ENV_OUTBOUND_DENY_LIST` 里（`packages/shared/src/spawn-env-contract.ts:30`） |
| `PI_CODING_AGENT_SESSION_DIR` | 无 | **当前未设**（本设计新增，§6.5） | 同左 | 高（一旦由 runtime 注入） |
| extension bundle 路径 | `~/.pi/agent/npm/node_modules/…` | 仓库路径或 npm 目录 | `….app/Contents/Resources/extensions/@zhushanwen/pi-session-reader/` | 高——bundle 为 ESM，`import.meta.url` 保留（`scripts/bundle-extensions.mjs:283`） |

**结论**：**没有任何单一信号是充分判据**。环境判定必须用**多信号合取**（§6.2）：`XYZ_AGENT_EXT_LOG === '1'` **且** `PI_CODING_AGENT_DIR` 值匹配 xyz-agent 目录形态，二者同时成立才判「xyz-agent 托管」；包型（dev / packaged）用 extension 自身 bundle 路径判定。`XYZ_AGENT_PACKAGED` 明确不可用（这条要写进文档以免后人重蹈）。判定结果永远**附带 evidence 行**，让 agent 能看到「为什么这么判」并自行推翻。

---

## 5. 终态：使用者眼里将是什么样的

**本章结论**：agent 遇到原事故场景时一次命中；即便失败，错误信息也会直接告诉它根目录状态和一条确定可行的下一步，并明确封死 shell 搜盘。**

### 5.1 成功路径

原事故重演（xyz-agent 下，agent 想读那份福耀玻璃深研）。**以下为按实测数据与设计规则推演的期望输出形态，非逐字实测**（实测基线见 §8 V5）：

```text
agent → session_read { action:"find", query:"福耀玻璃" }

main（live 根 14 个 + `[default]` 迁移残留 2 个，合并后 1 条命中）：
  1. 01a08a6e-0d26-780c-9598-1d9dd65d6418 · 2026-09-10 · Stock · 福耀玻璃深度研究
     ↳ session_read { action:"outline", session:"01a08a6e-0d26-780c-9598-1d9dd65d6418" }

subagent（14 条命中，main 1 条 + subagent 14 条 = 15 ≤ 默认 limit 20，故全部列出）：
  2. 01a08a7c-… · 2026-09-10 · 【任务】福耀玻璃…
  …
```

三处变化：候选集含 main、打印**完整 id**、按 `source` 分组且 **main 段置顶**（subagent 噪声不淹没目标，见 §6.7）；标题来自 pi 的 `SessionManager.listAll`（§6.6），所以 agent 说人话就能找到。

agent 想知道自己在哪：

```text
agent → session_read { action:"doctor" }

环境判定：xyz-agent（托管）· 发行形态：packaged
依据：XYZ_AGENT_EXT_LOG=1 且 PI_CODING_AGENT_DIR 形态匹配 <dataDir>/pi/agent；
      bundle 位于 *.app/Contents/Resources/extensions/
数据目录：/Users/zhushanwen/.xyz-agent
agentDir：/Users/zhushanwen/.xyz-agent/pi/agent

会话根（按优先级）：
  1. [live]     /Users/zhushanwen/.xyz-agent/pi/sessions          ← SessionManager 当前值
                存在 · 14 文件 · 扫 12ms · main
  2. [env]      /Users/zhushanwen/.xyz-agent/pi/sessions          ← PI_CODING_AGENT_SESSION_DIR
                存在 · 14 文件 · 扫 12ms · main（与 1 同路径，已去重）
  3. [legacy]   /Users/zhushanwen/.xyz-agent/pi/sessions          ← dirname(agentDir)/sessions
                与 1 同路径，已去重
  4. [default]  /Users/zhushanwen/.xyz-agent/pi/agent/sessions    ← agentDir/sessions（pi 默认布局）
                存在 · 2 文件 · 扫 3ms · main（含子目录；非当前主根）
  5. [subagent] /Users/zhushanwen/.xyz-agent/pi/agent/subagents
                存在 · 1330 文件 · 扫 210ms · subagent

诊断：主 session 根解析正常（最高优先级 main 根 14 文件）。
（legacy 告警只在 legacy 根**非空**时出现——§6.1；本机该根与主根同路径，已去重，不告警。）
```

### 5.2 失败路径（带恢复指引）

传入一个真的不存在的 uuid：

```text
agent → session_read { action:"find", query:"01a08zzz" }

无匹配 session："01a08zzz"

自检（发现层，只陈述事实）：
  main 根        14 文件  /Users/zhushanwen/.xyz-agent/pi/sessions
  subagent 根    1330 文件 /Users/zhushanwen/.xyz-agent/pi/agent/subagents
  → 候选集非空，根解析正常
  → 查询已做 uuid 归一化匹配（小写 + 去连字符）后仍无命中

最接近的候选（编辑距离）：
  01a08aac-c612-7017-a0d6-1a1cf5f78c53  subagent  差异在第 5 位：zz → 8a
  01a08aa7-779f-7330-9b89-36a453b6381b  subagent  差异在第 5 位：zz → 8a

正确做法：
  - 改用标题/keyword：session_read { action:"find", query:"福耀玻璃" }
  - 已知文件路径时直接传绝对路径：session_read { action:"outline", session:"<绝对路径>.jsonl" }
  - 截断/过期 id 用更短前缀：session_read { action:"find", query:"01a08a" }
  - 想先看环境与根目录状态：session_read { action:"doctor" }

不要用 shell find/ls/rg 搜 session 目录，不要 cat/read 原始 .jsonl —— session_read 是唯一入口。
```

关键变化：**自检行只陈述事实**（「候选集非空」「已做归一化匹配」），**不断言**「真的没有这个 session」——v1 设计在这里犯的错（对大写/去连字符输入给出错误归因）已在 §6.7 修正；**候选行用编辑距离让 agent 一眼自纠**；**最后一行把绕行动作就地封死**。

---

## 6. 关键决策与权衡

**本章结论**：七个决策共同把「猜根目录、失败不可诊断、检索键弱、家族通路脱节」变成「问权威、失败自证、语义键可检索、全 action 同源」。**

### 6.1 会话根发现：权威优先 + 候选根探测（选定）

- **采用**：发现层改为 `resolveSessionRoots(signals)` 返回**带来源标签的根列表**，逐个扫描、按 realpath 去重、合并结果。信号按优先级：
  1. **`[live]`** `ctx.sessionManager.getSessionDir()`（规范化后的根，见下）——宿主已解析的**权威值**；
  2. **`[env]`** `process.env.PI_CODING_AGENT_SESSION_DIR`——pi 自己的 session 目录变量；
  3. **`[default]`** `<agentDir>/sessions`——pi 默认布局（纯 pi 的真根，xyz-agent 下的迁移残留）；
  4. **`[legacy]`** `<dirname(agentDir)>/sessions`——xyz-agent 兄弟布局的兜底。
  5. **`[subagent]`** `<agentDir>/subagents`——**常量推导，不来自任何信号**（xyz-agent 未覆盖该目录、subagent-workflow 用 `getPiAgentDir()` 派生，两宿主均正确，§1.1 末段），列入根列表仅为统一展示与 `doctor` 计数。
- **`[live]` 的规范化**：`getSessionDir()` 在纯 pi 返回**按 cwd 编码的子目录**（`<agentDir>/sessions/--Users-x--`），在 xyz-agent 返回**根本身**（`--session-dir` 覆盖时 pi 不追加 encodeCwd，见 `session-manager.js:1179-1180` `const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`）。判据：basename 匹配 encodeCwd 形态则取 `dirname`，否则取自身。
- **`[legacy]` 非空的处理**：不假定它为空。非空即纳入候选（历史 session 是真实数据），并在 `doctor` 里标注「legacy 根非空——若非预期请检查是否迁移完成」。
- **被否**：
  - **只加一条 `<dirname(agentDir)>/sessions`**（最小改动）——能把 xyz-agent 修好，但**没有任何自证能力**：下次宿主换个布局，同样静默失效，事故重演。且无法解释「为什么两个根都有文件」。记为「方案 A」。
  - **只信 `ctx.sessionManager.getSessionDir()`**——纯 pi 下它只指向**当前 cwd** 的子目录，跨项目检索（`find` 的核心价值之一）会丢一大片历史。记为「方案 C」。
- **证据**：`roots.ts:84`（现状）；`dist/main.js:530-533`（优先级链）；`session-manager.js:242-247,1179-1180`（默认 vs 覆盖两条路径）；`pi-paths.ts:105-107`（xyz-agent 侧 SSOT）；§4.2 三宿主实测表。
- **效果**：让 §2 目标 1 成立，并使 §5.2 的「自检行」有数据可打（没有候选根列表就没有自检）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **B：权威优先 + 候选根探测 + 来源标签** | 高——宿主换布局自动跟随，且失败可自证 | 中——新增 roots resolver + 触点接线 | 多扫 1–2 个目录（`[legacy]` 通常不存在，readdir 失败即空；量级探针见 §12.1 P-8） | ✅ |
| A：单点补 `<dirname(agentDir)>/sessions` | 低——同类失效会复发，无自证 | 极低（1 行） | 高——本次事故的全部不可诊断性原样保留 | ❌ |
| C：只信 `SessionManager.getSessionDir()` | 中——权威但视野窄 | 低 | 中——纯 pi 跨项目检索能力回退 | ❌ |

**被否若用**：若选 A，§5.2 那段错误信息只能退化成原文案换个词——因为没有候选根列表，打不出「自检」，「没有这条 session」和「根配错了」依旧无法区分，agent 仍会去 shell 搜盘。若选 C，纯 pi 用户把 `find{query:"某个别的项目的历史"}` 的命中率从「全库」降到「当前 cwd」。

### 6.2 环境判定：多信号合取 + evidence 附带

- **采用**：`detectEnvironment(signals)` 返回 `{ kind, distribution, dataDir, evidence[] }`。判定规则：
  - **托管（xyz-agent）** ⟺ `XYZ_AGENT_EXT_LOG === '1'` **且** `PI_CODING_AGENT_DIR` 的值匹配 `<*>/.xyz-agent*/pi/agent` 形态。**两信号同时成立才判托管**——前者单独会被用户 shell 透传污染（`ENV_WHITELIST_PREFIXES` 含裸 `XYZ_`），后者单独会被裸 pi 用户的自设值污染，合取后误判面显著收窄。
  - **发行形态**：bundle 路径（`import.meta.url`）位于 `*.app/Contents/Resources/extensions/`（macOS）或对应 Windows/Linux 应用资源目录 → `packaged`；否则 `dev`。无法判定时为 `null`，不猜。
  - **`evidence[]` 恒输出**：把每条命中的信号原样列出，让 agent（和排障的人）能核对判定依据。
- **被否**：
  - 单信号判定 `XYZ_AGENT_EXT_LOG === '1'`——被 shell 透传击穿（§4.4 表）。
  - 在 `description` 里静态写死「本工具运行于 TaiJi.app」——同一份 extension 要同时服务两种宿主，写死必然对另一边错误。
- **证据**：§4.4 实测表；`constants.ts:74`（`XYZ_` 前缀在入站白名单）；`bundle-extensions.mjs:283`。
- **效果**：让 §2 目标 3 成立，且判定**可被证据推翻**而非黑盒断言。

### 6.3 新增 `doctor` action

- **采用**：新增 action `doctor`，输出 §5.1 那张表：环境判定 + evidence + 每个候选根（来源 / 路径 / 是否存在 / 文件数 / 扫描耗时）+ 诊断结论 + legacy 告警。
- **成本控制**：`doctor` 默认**不扫 subagent 根**（只列路径与「是否可扫」，不产文件数）——subagent 根在纯 pi 下有 2596 个文件，agent 可能在一次会话里反复问 `doctor`，重复全量扫盘不可接受；需要时显式传 `includeSubagents:true`。同一 pi 进程内对已扫过的根做**进程内缓存**（keyed by root path；秒级 TTL 或目录 mtime 变化即失效，进程生命周期仅作兜底上限），重复调用不重扫。
- **被否**：把这些信息塞进现有 action 的错误信息里——只在失败时可见，且失败路径本就狭窄（§5.1 的常态查询看不到环境）。`doctor` 是**可主动询问**的。
- **证据**：现状 10 个 action（`index.ts:26-36`）无任何自检入口；事故中 agent 无法区分两类失败（§3.2 失败模式 C）。
- **效果**：让 §2 目标 3 成立；并给 §6.7 的「错误信息自检行」提供同一份数据的渲染源（**同一数据源两处渲染**，不重复实现探测）。

### 6.4 环境信息放 `doctor` + 错误信息，**不放** 工具 description

- **采用**：环境判定结果只在 `doctor` 输出与失败错误信息中出现。工具的**模型可见契约**仍会变，但变化最小化：`action` enum 增加 `'doctor'` 一个值 + `description` 里 action 列表补一词 + `promptGuidelines` 加一句「不确定环境时用 doctor」。其余文本不动。
- **代价诚实声明**：上述三处都是模型可见面，会**一次性**使 provider 的前缀缓存失效（本仓 `cache-probe` 的指纹键含 `guidelines` / `toolsSent` / `toolsReg`，见 `extensions/universal/cache-probe/src/fingerprint.ts:20-28`，会记一条 change 事件）。增量量级：新增一个 enum 值（约 10 字节）+ description 一词 + guideline 一句（约 120 字节），**一次性**，此后前缀稳定。**不**把「数据目录路径」这类按宿主变化的值放进 description——那会造成跨宿主前缀不稳定。
- **被否**：在 `description` 里动态插入「当前环境：TaiJi.app / 数据目录：…」。
- **证据**：`fingerprint.ts:20-28`；工具 description 属于系统提示词前缀。
- **效果**：环境可见性（目标 3）由 `doctor` 满足，同时把缓存代价从「每次变化」压到「一次性、约 130 字节」。

### 6.5 xyz-agent 侧：用 pi 自己的变量让 session 目录自描述（含继承面枚举）

- **采用**：`packages/runtime/src/infra/pi/rpc-client.ts` 在 spawn pi 时，除现有 `--session-dir` 外**再注入 `PI_CODING_AGENT_SESSION_DIR = getSessionsDir()`**（经 `buildOutboundChildEnv` 的 `extras` 通道，遵守 C-proc-09 唯一构建点约束）。
- **为什么值得**：这是**在信息断点上修，而不是在消费端兜**。`--session-dir` 只存在于 pi 自己的 argv，env 才是**可被子进程继承**的自描述契约——任何未来的 pi-native 或第三方消费者（不只本 extension）都能直接读到。
- **forward 登记义务（C-proc-09 的另一半）**：`docs/design/env-propagation-boundary.md:215` 明确要求「pi 子树内的新 env 须在出站契约清单加 forward 条目并附消费锚点」。本设计必须同步改两处，缺一不可：
  1. `packages/shared/src/spawn-env-contract.ts` 的 `SPAWN_ENV_FORWARD_REFERENCE` 增一条（对齐既有 `PI_CODING_AGENT_DIR` 条目的写法，`spawn-env-contract.ts:150-158`）：`injectionPath` 写明 extras 通道，`piConsumerAnchors` 写 `dist/main.js:530-533` + 本 extension 的 `[env]` 信号。
  2. `docs/design/env-propagation-boundary.md` 的 B 组表同步。
  **为什么必须显式登记**：既有防线拦不住这个遗漏——`.githooks/check_spawn_env_boundary.py` 是**文件级**白名单（文件内出现构建器调用即整文件放行，`rpc-client.ts` 早已含 `buildOutboundChildEnv(`），`spawn-env-contract.test.ts` 只断言清单「含某几项」、无完整性断言。漏登记不会被任何机器拦截。
- **继承面枚举（此变量会传给谁、谁会受影响）**：

  | 继承者 | 是否自带 `--session-dir`（argv 优先，覆盖 env） | 影响 | 判定 |
  |---|---|---|---|
  | subagent-workflow 派生的 subagent pi | **是**（`packages/subagent-core/src/execution/engine/engines/pi/session-runner.ts:1149`） | 落盘位置不变。**该进程内 `[env]` 信号缺席**——subagent pi 的 env 是 runtime 进程 env 的整体继承（`session-runner.ts:1764` `{ ...process.env }`，subagent-core 是 runtime 的 workspace 依赖），U4 的 extras 只进主会话 pi 子进程、不进 runtime 自身 env → 主根在 subagent pi 内只会以 **`[legacy]`**（`dirname(agentDir)/sessions` = `<dataDir>/pi/sessions`）形态出现，`[live]` 指向 subagent 目录 | 可接受：`[legacy]` 恰好兜住主根（再次印证 §6.1 该信号的必要性）；`doctor` 按 kind 标注即可区分。**若要 subagent pi 也拿到 `[env]`，属 U4 范围扩展**（改 `session-runner.ts` 的 `buildChildEnv`），须另行登记并过 C-proc-09 评审——本设计默认不做 |
  | agent 通过 bash 工具派生的任意 `pi` 调用 | **否**（取决于用户命令） | 会把新 session 写进 `<dataDir>/pi/sessions`，**注入 TaiJi 的主 session 列表** | **已接受的代价**，见下 |
  | relay / 其他 runtime 派生链 | **是**（已核，第 2 轮复审补充证据：`session-runner.ts:1149` userArgs 恒带 → `relay.mjs:163` 握手帧 argv 原样透传 → `relay-registry.ts:374` 按帧 argv spawn） | 与第一行同分类：落盘位置不变，但该进程内 `[env]` 信号同样错位指向主根（握手帧 `env: {...process.env}` 原样上送，`buildOutboundChildEnv` 不剥此变量） | 可接受，同第一行 |

  **对 bash 派生类的量化与恢复通道**：AGENTS.md 规定的本地实测命令**总是带** `--session-dir`，故正常工作流不触发；触发面限定为「agent 自行发起的不带 `--session-dir` 的裸 pi 调用」。后果是**多出若干落错位置的 session 文件**（只增不删，无静默覆盖）。恢复通道 = 用 `session_read{action:"doctor"}` 发现多余根后**人工 `rm`**（doctor 的根文件列表即工作清单）。**没有机器兜底**：runtime 的 reap 只杀孤儿 pi **进程**、不处理 session **文件**（`reap-orphan-pi.ts:10-27`，判据是 argv 含 `--session-dir` + ppid=1），且 pi 侧无自动 GC（`docs/pi-semantics.json` PS-19 在案）。**重审触发条件**：若实施后发现该面被高频触发（`doctor` 显示 `<dataDir>/pi/sessions` 出现明显非 app 来源的 session），回改本决策，改为只在 env 里放一个**只读**的提示变量（如 `XYZ_PI_SESSION_DIR_HINT`），不占用 pi 的权威变量名。
- **被否**：只改 session-reader 探测（不做宿主侧声明）——能修好本次问题，但断点仍在，任何新消费者都要重走一遍猜测。
- **证据**：`dist/main.js:530-533`（pi 读取 `ENV_SESSION_DIR`，优先级仅次于 `--session-dir`）；`dist/config.js:406`（变量名）；`rpc-client.ts:200`（既有 `PI_CODING_AGENT_DIR` 注入先例）；`spawn-env-contract.ts:150-158`（forward 条目范式）；`env-propagation-boundary.md:215`（登记义务）。
- **效果**：让 §6.1 的 `[env]` 信号长期可靠；即使 session-reader 的 `[live]` 探针因 pi 升级失效，`[env]` 仍在。
- **验收**：活体 pi 进程 `ps eww` 能观测到该变量（§12.1 P-3）；subagent pi 内 `doctor` 的 `[env]`/`[live]` 两根被正确标注（§8 V7）。

### 6.6 主 session 元数据：`SessionManager.listAll`，但**惰性 + 窄化 + 缓存**（选定）

- **采用**：`find` 的元数据层（标题 `name` / cwd / 首消息预览）用 pi 的 `SessionManager.listAll(dir)`——它返回 `SessionInfo[]`，字段含 `path / id / cwd / name / parentSessionPath / created / modified / messageCount / firstMessage / allMessagesText`（`dist/core/session-manager.d.ts:125-138`），`name` 即 `session_info` entry 的用户标题。注入方式：`index.ts` 构造 `metadataProvider` 回调传入 handler，**发现层保持零 pi 依赖**（与 §6.2 信号包同一注入范式）。
- **必须先写清这个 API 的两条实装语义（本设计的选型前提即建立在其上）**：
  1. **`listAll(dir)` 只扫一层、不递归**——带 `dir` 的分支走 `listSessionsFromDir`（`dist/core/session-manager.js:550-556`），`readdir(dir)` 后直接 filter `.jsonl`。对照三宿主布局：xyz-agent 主根 14 文件**平铺** → 能全部拿到；纯 pi `[default]`/`[live]` 的 4619 文件全部在 `<encodeCwd>/` 子目录 → **`listAll(根)` 返回 0 条**。pi 自己的无参分支才是两层枚举（`session-manager.js:1306-1318`）。所以 `listAll(dir)` 的真实语义是「扫一个**平铺目录**」，不是「扫一个根」。
  2. **每次调用 = 全量解析该目录全部文件**——`buildSessionInfo`（`session-manager.js:443-511`）`for await` 读到 EOF、无 break，顺带收集 `allMessagesText` / `messageCount` / 时间戳。成本是 O(目录总字节) 而非 O(文件数)：本仓自有实测「全盘 3488 项 ≈ 8s」（`hash-provider.ts:161`）、单 cwd 目录 530 文件 667ms（`docs/2026-08-10-cwd-popup-redesign.md:190`）。**「19ms vs 1500ms」的既有记录（`index.ts:203`）语境是单个 per-cwd 小目录，不可外推到根目录。**
- **由此定调用策略（三条，缺一会退化成秒级卡顿）**：
  1. **惰性触发**：仅在「uuid 精确匹配 = 0 **且** uuid 归一化匹配 = 0 **且** query 非纯 hex（即 keyword 路径）」时才调 `listAll`。uuid / recent 路径不调（recent 只对 limit 截断后的少数候选补元数据）。
  2. **窄化目标**：只对**平铺目录**调用——即「未做 encodeCwd 剥层的 `liveSessionDir` 本身」（xyz-agent 下即主根，平铺；纯 pi 下即当前 cwd 的目录，小）+ 扫描结果**无子目录**的候选根。**含子目录的根跳过**并显式声明：纯 pi 跨项目标题检索本轮不覆盖（需枚举全部 encodeCwd 子目录 × 全量解析，成本不可接受）——§2 目标 4 的适用范围据此限定。
  3. **进程内 TTL 缓存**（keyed by 目录路径；秒级 TTL / 目录 mtime 失效）：标题数据变更低频，重复 keyword 查询不重复全量解析。
- **降级路径**：`metadataProvider` 注入失败 / 调用抛错（单目录 try/catch，记空并继续）→ 回退现有 `readFirstUserMessageText`（只读首条 user，命中即停），**标题字段留空**。降级只损失「标题检索」，不损失「能找到 session」。
- **为什么仍优于自写深读**：自写「顺带解析 `session_info`」同样必须读全文件才能证明不存在（实测某 23MB 主 session 中 `session_info` 在第 31 行；xyz-agent 14 个主 session 中 3 个无 `session_info`，须读到 EOF），纯 pi 全库最坏 ≈ 2.7GB（放大约 170 倍，P-9）。`listAll` 的全量解析是**同样的输入、但由 pi 维护且有并发封装**（`buildSessionInfosWithConcurrency`），且配合上面的惰性 + 窄化 + 缓存后，实际触发面被压到「小目录 + 低频」。
- **被否**：
  - 自写 `session_info` 深读——成本被实测否决（P-9），且重复实现 pi 已有的并发解析。
  - 只靠首条 user message 预览匹配——事故反例：`01a08a6e-0d26` 与 `01a08a6e-74fc` 的首条消息可能都是「帮我分析下这只股票」，无法区分标的；标题「福耀玻璃深度研究」/「太保寿险深度研究攻坚」可区分。
  - 「用 `listAll` 做全库标题索引」——被实装语义否决（平铺一层 + 全量解析），纯 pi 不可行。
- **证据**：`session-manager.js:443-511,550-556,1292-1325`；`session-manager.d.ts:125-138,353-354`；本仓 `hash-provider.ts:2,139,157-159,161`（用法先例 + 空参灾难分支 + 两条实测耗时）+ `index.ts:203`（19ms 语境）；`docs/2026-08-10-cwd-popup-redesign.md:190`（667ms/530 文件）；标题覆盖率实测 10/14（P-4 注）。
- **效果**：让 §2 目标 4 在「当前宿主会话根」范围内成立（纯 pi 跨项目标题检索显式列为不覆盖，见调用策略 2）。

### 6.7 `find` 匹配与输出：归一化 + 分组 + 全 id

- **采用**，三个子决策：
  1. **uuid 归一化匹配（修 §3.3 的两个盲区）**：uuid 片段匹配改两级——第一级保持现状的精确子串（`sessionId.includes(query)`，命中排最前）；第二级对**归一化形态**再比一次：`norm(s) = s.toLowerCase().replace(/-/g, '')`，`norm(sessionId).includes(norm(query))`。`looksLikeUuidFragment` 同步用 `norm(query)` 判定。这样**大写 uuid、去连字符 uuid** 都能命中，且不会因为「像 uuid 片段」而错误跳过关键词回退。
  2. **结果按 `source` 分组，main 段置顶**：实测 `find{query:"福耀玻璃"}` 命中 **1 main + 14 subagent**，且 subagent 的 mtime 晚于主 session，按现有 mtime 倒序会把主 session 挤到后面。**精确规格**：
     - `limit` 作用于**分组后的合并列表**：main 段优先占满（上限 `limit`），剩余配额给 subagent 段；main 命中 > `limit` 时 subagent 段为 0 条、仅显示计数；
     - `truncated` 按**合并总量**（命中总数 vs 实际输出数）计算，不按单组；
     - subagent 段超出剩余配额时**折叠为计数行**并提示「加 source:"subagent" 查看」；
     - **解析路径不受分组影响**：`resolveByFragment`（outline/family 等全部按 id action 的入口）用独立的无分组查询，语义保持现状（mtime 排序 + limit 截断）——分组只是 `find` 的**展示层**规则，不是匹配层规则。
  3. **输出全 id + 可直接复制的调用串**：`find` / F1 候选行打印**完整 sessionId**，并附一条可直接复制执行的 `session_read{action:"outline", session:"<完整 id>"}`。
- **`SESSION_ID_PREFIX_LEN` 的改动范围声明**：该常量还被 `result` action 复用（`tool-handler.ts:1559` → `result-action.ts:46,238` 注入批量头行渲染），且测试 `execution-tree.test.ts:747` 对 8 字符截断有断言。本设计**只改 `formatFindContent` 与 `formatNoMatch` 两处渲染**，**不动** `result` 通路与常量本身——`result` 的批量输出里短 id 足够（每项已带完整正文指针）。
- **被否**：
  - 保持 8 字符截断「省 token」——事故反例：agent 拿到 `01a08aac…` 无法粘回做精确调用，只能改去 shell `ls`（§3.2 失败模式 D）。
  - 只加归一化不改分组——「说人话就能找到」会在 15 条 subagent 噪声里退化（实测 §12.1 P-4 注）。
- **证据**：`find.ts:156-158,375-377`（现状匹配）；`tool-handler.ts:379,434,386,1559`（截断常量与两处消费）；`result-action.ts:46,238`（`result` 通路的独立消费）。
- **效果**：让 §2 目标 1/2/4 成立；切断「输出不可复制 → 转向 shell」这条动机链。

### 6.8 `family` / `export{format:"family"}` 必须接入同一根列表（本设计新增的范围）

- **采用**：`subagents.ts:99 collectMainSessions(agentDir)` 改为从 `resolveSessionRoots(signals)` 取 main 文件列表（签名从 `agentDir: string` 换成 `signals`，与 §6.1 同一信号包）。`subagents.ts:55` 起的 not-found 错误文案同步改为列出**实际扫描过的候选根**，而不是写死 `<agentDir>/sessions`。
- **只改 main 腿，另两条腿明确不改**：`buildFamilyFromFs` 有三条数据腿——main（本决策改）、subagent identities（`subagents.ts:156 listSubagentSessions`）、record manifests（`listRecordManifests`）。后两条都从 `<agentDir>/subagents` 推导，**两宿主下均正确**（实测 1330 / 2596，§4.2），不修不坏，维持现状。
- **为什么必须在本次做**：不改的话，修复后链路是——`find{uuid}` 命中主 session（§5.1 的终态）→ agent 顺理成章追问家族关系 → `family{同一 uuid}` → `buildFamilyFromFs` 仍只索引 `<agentDir>/sessions`（xyz-agent 下仅 2 个迁移残留）→ `core/family.ts:263 resolveFamily` 抛 `session "…" not found under …/agent/sessions`。**实测已复现**（§12.1 P-2 注）。修前是「F1 无匹配 + 👉」，修后变成「无恢复指引的内部错误，且提示把 agent 推回明明能找到它的 `findSessions`」——**比修前更差**，且直接违反 §2 目标 1。
- **被否**：只修 `findSessions`、把 family 登记为已知限制——10 个 action 里 2 条路径（`family`、`export format=family`）对 xyz-agent 下 14/14 个当前主 session 全部不可达，这不是可接受的残留。
- **证据**：`subagents.ts:63-68,98-99`；`tool-handler.ts:707,882`；`core/family.ts:263`；§12.1 P-2。
- **效果**：让 §2 目标 1 的「全 action」成立；消除「find 说有、family 说没有」的自相矛盾。
- **注**：`recursive:true` 的执行树路径（`execution-tree.ts`）只需 `resolved.fileName` + manifest，不依赖 main 根扫描，**无需改**；若不改 `subagents.ts`，`family` 与 `family{recursive:true}` 会行为分裂（一个抛错一个可用），这也是必须改的理由之一。

### 6.9 双仓漂移：本设计只修本仓；漂移登记待办并附触发条件

**事实（本次已核实更正）**：

- 本仓 `extensions/universal/session-reader` = `@zhushanwen/pi-session-reader@0.4.0`，随 TaiJi.app 打包，是**权威源**。
- npm 上被纯 pi 安装的 `@zhushanwen/pi-session-reader@0.2.4` 是**本仓 extension 的历史发布快照**（`~/.pi/agent/settings.json` 的 `packages` 含 `npm:@zhushanwen/pi-session-reader`；安装副本含 `src/tui/`，`src/discovery/roots.ts:84` 与本仓逐字相同）。**它带同一个 bug**。
- `~/Code/pi-session-reader` 是**另一个独立仓**：包名 `@zhushanwen/pi-session-reader-cli@0.1.0` 且 `"private": true`（`package.json` 实测），**不可能**是 npm 0.2.4 的发布源；它是本仓 extension 的 CLI 派生仓（`LINEAGE.md §1`：基线 commit `135c1dbab`，2026-09-09 平移），同样带此 bug（`src/discovery/roots.ts:84` 逐字相同）。
- **消费方耦合**：全局 skill `~/.agents/skills/pi-session-reader` 是**symlink 指向 CLI 仓**（`…/pi-session-reader/skills/pi-session-reader`），其正文写死「**10 个 action**：find / family / … / result」并给出 `session_read{…} ≡ pi-session-reader <cmd>` 的一对一映射表（`SKILL.md:63-70`）。本设计新增 `doctor` 后：skill 的 action 计数错误、映射表缺一项，且该 CLI 无 `doctor` 子命令——非 pi agent 读到 `session_read{action:"doctor"}` 指针行将无法映射。

**处理**：

- 本设计只修本仓 extension（TaiJi.app 主路径）。
- **U13（登记，不在本次动手）**：① npm 重新发版（修 bug 的唯一路径是本仓发版，**不是**改 CLI 仓；npm 通道现成——`@zhushanwen/pi-session-reader` 已发布至 0.4.0，含 0.2.4/0.3.0/0.3.1/0.4.0）；② **发布后须触发纯 pi 侧包重装/更新**——`~/.pi/agent/settings.json` 的安装条目 `npm:@zhushanwen/pi-session-reader` **无版本约束**，pi 的包管理器不自动升级（装机实测停在 0.2.4），**只发版不动装机到不了纯 pi 用户**；③ CLI 仓是否跟进 `doctor` 子命令 / 是否废弃；④ skill 正文的 action 计数与映射表同步。**触发条件**：下次 `@zhushanwen/pi-session-reader` 发版时，或下次改动该 skill 时，二者先到先触发。**owner**：本仓维护者（用户裁决跨仓发布）。

---

## 7. 实现机制（把终态落到代码层）

**本章结论**：新增一个根解析器与一个环境探测器，两者都是纯函数 + 注入信号，可完全单测；`tool-handler` 消费它们渲染 `doctor` 与错误自检；元数据走注入的 pi `listAll` 回调。**

```text
src/index.ts（pi 依赖层，唯一触点）
  execute(_id, params, signal, _onUpdate, ctx)
    ├─ 采集信号包（全部可选链，见下） ─────────────────────────┐
    │   agentDir       = getAgentDir()                          │
    │   liveSessionDir = ctx?.sessionManager?.getSessionDir?.() │ ← ExtensionContext 基础字段，
    │   env            = process.env                           │    非 mode-gated（types.d.ts:209-219）
    │   bundleUrl      = import.meta.url                       │ ← ESM bundle 保留
    │   metadataProvider = async (root) => SessionManager.listAll(root) │ ← §6.6
    └───────────────────────────────────────────────────────────┘
                          ↓
src/tool-handler.ts（纯逻辑，零 pi 依赖）
  handleSessionRead(params, signals, signal)
    ├─ roots = resolveSessionRoots(signals)          ← 单一数据源，§6.1/§6.8
    ├─ action==='doctor' → renderDoctor(roots, detectEnvironment(signals))
    ├─ find → findSessions(roots, metadataProvider, …)
    ├─ family / export{format:'family'} → buildFamilyFromFs(roots, …)
    │     （仅 main 腿走 roots；subagent/manifest 腿维持 <agentDir>/subagents 推导，§6.8）
    └─ 其余 → resolveSessionId → …；失败 → F1 带自检行（复用同一 roots）
                          ↓
src/discovery/roots.ts
  resolveSessionRoots(signals) → SessionRoot[]
    SessionRoot = { id, kind: 'live'|'env'|'default'|'legacy'|'subagent',
                    path, source: 'main'|'subagent', exists, fileCount?, scanMs }
    · 规范化 [live]（encodeCwd 形态剥一层）
    · realpath 去重（同一路径多信号命中只扫一次，保留最高优先级 kind 作标签）
    · 逐个 scanJsonlRecursive（现有实现复用，含 workflow-state 跳过）
                          ↓
src/discovery/env.ts（新增）
  detectEnvironment(signals) → { kind, distribution, dataDir?, evidence[] }
```

要点：

1. **发现层保持零 pi 依赖**：`roots.ts` / `env.ts` / `find.ts` 只接受注入的 `signals` 与 `metadataProvider`，不 import pi（沿用 `roots.ts:8-11` 的既有分层声明）。pi 侧类型以 `import type` 进入，不产生运行时依赖。
2. **`ctx` 采集必须可降级**：`execute` 用可选链读取 `ctx?.sessionManager?.getSessionDir?.()`。**为什么**：现有测试 `index.test.ts:97` 以 `execute('tc-1', {action:'find'}, undefined, undefined, undefined)` 调用（第 5 参 `ctx` 为 `undefined`），无条件解引用会把这条断言 `👉` 错误文案的测试打成 `TypeError`。运行时同理——pi 升级若移除该字段，工具应降级而非抛内部错误。`liveSessionDir === undefined` 时走 §6.1 的三根降级（`[env]` + `[default]` + `[legacy]`），三个已知宿主的布局在这三根下均已完备。
3. **`[live]` 规范化**：`basename(liveSessionDir)` 匹配 encodeCwd 形态时取 `dirname`，否则取自身。该判据对应 pi 两条路径的差异（§6.1 证据）。
4. **去重按 realpath**，保留最高优先级标签；`doctor` 中把被去重的根以「与 N 同路径，已去重」注记显示。
5. **`doctor` 的诊断结论只陈述事实**：输出各根文件数与「最高优先级 main 根是否非空」，**不输出**「真的没有这个 session」这类归因断言（§5.2 / §3.3 教训）。subagent 根默认不扫（§6.3）。
6. **`scanJsonlRecursive` 复用**：`resolveSessionRoots` 内部仍调用它，不新写扫盘逻辑；仅把返回值聚合改为带 `kind` 标签。
7. **向后兼容**：`findSessions(query, agentDir, opts)` 与 `buildFamilyFromFs(sessionId, agentDir)` 的旧签名保留为薄包装（内部构造只含 `agentDir` 的信号包 → 退化为「`[default]` + `[legacy]`」两根），使存量单测与外部调用不破。**注意**：这只对测试与外部深 import 有意义——**工具运行路径必须走新签名**，否则 family 修复不生效（§6.8）。
8. **进程内缓存**：**仅 `doctor` 的重复调用**共享缓存（keyed by root path；秒级 TTL 或目录 mtime 变化即失效，进程生命周期仅作兜底上限）。**`find` 一律不读缓存**——F1 自检行的计数必须取自**本次 find 刚完成的实扫结果**（本就在返回值里，绕缓存取旧数没有任何收益）。原因：若把缓存计数写进「只陈述事实」的自检行，最坏形态是新数据目录上 doctor 首跑时主根 0 文件被缓存（PS-14：首条 assistant 消息前 jsonl 不落盘），pi 进程寿命小时级，此后每次 F1 都报「main 根 0 文件」，把「根解析正常」误报成「主 session 根全部为空」——正是 §2 目标 2 要消灭的错误归因。

---

## 8. 验收（真实场景，非单测非 mock）

**本章结论**：用 8 个真实场景覆盖全部 5 条目标，全部在真实宿主、真实数据上跑，不用 mock；含 2 条反向场景（防「修好 A 弄坏 B」）。**

### 8.1 改动规模

**大**：新增 action、变更发现层接口与数据源、跨包改动（runtime spawn env + forward 登记 + pi 语义登记）。按大改动标准做多场景验收。

### 8.2 验收场景

| 场景 | 回溯 §2 目标 | 真实流程 / 数据 / 路径 | 通过标准 |
|---|---|---|---|
| **V1 原事故复现（TaiJi.app）** | 目标 1 | 在 TaiJi.app（打包版）里新开 session，执行 `session_read{action:"find", query:"01a08a6e"}`，数据为 `~/.xyz-agent/pi/sessions/` 真实 14 个 session | 命中集含 `01a08a6e-0d26-…` / `-74fc-…` / `-b007-…` 三条 main，且 `source=main`，完整 id 可见 |
| **V2 纯 pi 不回退** | 目标 1 | **环境隔离后**启动纯 pi：`env -u PI_CODING_AGENT_DIR -u XYZ_AGENT_EXT_LOG -u XYZ_AGENT_DATA_DIR -u PI_CODING_AGENT_SESSION_DIR pi --mode rpc --session-dir <tmp> --extension <repo>/extensions/universal/session-reader`（AGENTS.md 实测命令 + 显式剥除托管信号，防 TaiJi 会话内执行时被继承 env 污染判定），对 `~/.pi/agent/sessions/` 真实 4619 个 session 执行 `find{query:"<某个已知 uuid 前缀>"}` | 命中该 session；`[default]` 根被标为真根；`[legacy]`（`~/.pi/sessions`）不产生候选也不报错；`doctor` 判 `standalone-pi` |
| **V3 doctor 自描述 + legacy 告警** | 目标 3 | 分别在 V1 与 V2 的环境里执行 `session_read{action:"doctor"}` | TaiJi 下：`xyz-agent · packaged`、数据目录 `~/.xyz-agent`、live 根 14 文件、`[legacy]` 与主根同路径（已去重）；纯 pi 下：`standalone-pi`、agentDir `~/.pi/agent`、`[default]` 根 4619 文件（与 `[live]` 同路径去重）、`[legacy]` = `~/.pi/sessions` 空。**legacy 告警判据统一为「非空才告警」（§6.1）**：上述两个环境均**不出现**告警、仅事实行；另构造一个 legacy 根非空的环境（或临时放入一个 .jsonl）验证告警出现。两者都打印各根文件数与 evidence 行 |
| **V4 失败自证 + 封死绕行** | 目标 2 | 在 TaiJi.app 里执行 `session_read{action:"find", query:"01a08zzz"}`（不存在的片段） | 输出含：① 事实型自检行（main 根 N 文件 / subagent 根 M 文件 / 「已做归一化匹配」）② 编辑距离最近候选 ③ 三条正确做法 ④ 一行明确的「不要用 shell find/ls/rg 搜 session」；**且不含**原「去用 recent」误导指引，**且不断言**「真的没有这个 session」 |
| **V5a 归一化 + 分组**（M3 交付） | 目标 1/4 | 在 TaiJi.app 里依次执行：`find{query:"01A08A6E-74FC-78A4-9580-8539B40E0920"}`（全大写）、`find{query:"01a08a6e74fc78a495808539b40e0920"}`（去连字符）、`find{query:"福耀玻璃"}` | 前两者（v1 设计下为 0 命中）各自命中 `01a08a6e-74fc-…`；第三者 main 段**置顶**且含 `01a08a6e-0d26-…`；所有输出完整 id（**标题字段可为空**——标题检索随 V5b/M4 生效） |
| **V5b 标题检索命中**（M4 交付） | 目标 4 | 在 TaiJi.app 里执行 `find{query:"福耀玻璃"}`、`find{query:"海康威视"}` | main 段置顶且含正确标题（「福耀玻璃深度研究」/「deep-research-分析海康威视」）；标题来自 `listAll` 的 `name` 字段 |
| **V6 family 全 action 一致** | 目标 1 | 在 TaiJi.app 里执行 `session_read{action:"family", session:"01a08a6e-74fc-78a4-9580-8539b40e0920"}`，再执行 `{action:"export", format:"family", session:<同 id>}` | 两者都正常返回（不抛 `not found under …/agent/sessions`），family 树 root 为该 id；`find` 与 `family` 对同一 id 的存在性判定**一致**；family 树含该 session 发起的 **subagent 节点（≥1，或与该 session 的 manifest 计数一致）**——防 subagent 腿被误改而测试仍绿 |
| **V7 env 注入反向面** | 目标 1 的副作用面 | 在 TaiJi.app 会话内通过 bash 执行 `env \| grep PI_CODING_AGENT_SESSION_DIR`（确认变量已注入，**可靠通道**）；随后执行**不带** `--session-dir` 的 `pi -p 'hi'`（`-p/--print` 存在于 `dist/cli/args.js:124`，print 模式本身无交互；裸 pi 读 `PI_CODING_AGENT_DIR` 下 models.json/auth 取模型，预期可用），落盘观察 = 执行前后 `ls <dataDir>/pi/sessions` 取差集 | ① 变量可见；② 落盘位置被**显式记录**为「进入 `<dataDir>/pi/sessions`」或「未进入」，与 §6.5 的已接受代价声明一致；③ subagent pi 内 `doctor` 的判定与 §6.5 表第一行一致：`[live]` 标注为 subagent 根、主根以 **`[legacy]`** 形态出现（`[env]` 在 subagent pi 内**缺席**，因 U4 不触及 session-runner），两者不被误标混淆。**收尾**：探针产生的 session 文件（无论落哪）人工 `rm` 清理，与 §6.5 恢复通道闭环 |
| **V8 跨会话内容检索**（阶段二） | 目标 5 | 先 `find{query:"<某 cwd 或时间范围>"}` 窄化，再对结果检索关键词（如某次讨论里出现过的 `adj_factor`） | 返回包含该关键词的 session 列表 + turn 索引 + 可直接执行的调用串；纯 pi 全库宽搜被**明确拒绝**并提示先窄化（不静默超时） |

**回归基线**（必须保持）：

- `find{query:"红队"}` 等 subagent 关键词检索行为不变（现网依赖）。
- 传入绝对路径 `outline{session:"<路径>.jsonl"}` 仍可用（防回退，`resolveBySessionPath` 不动）。
- `find{query:"01a08a", limit:100}` 的 subagent 段含 34 条（uuidv7 时间前缀碰撞属正确行为，§3.4；分组后 main 段 0 条 + subagent 段 34 条，合计不变）。
- `find{query:"recent"}` 的候选集含主 session（原失败模式 #4 的验收保护；预期 main 14 条 + subagent 淹没，**main 段置顶**后可辨识——若实现按 §6.7 分组，`recent` 亦同规则）。
- `result` action 的批量头行仍为 8 字符短 id（§6.7 范围声明；`execution-tree.test.ts:747` 断言不变）。
- `index.test.ts:97`（`ctx === undefined`）仍通过且断言的是 `👉` 错误文案（§7.2 降级）。

---

## 9. 实施

**本章结论**：分两阶段交付——阶段一恢复正确性与可诊断性（M0–M3），阶段二补检索力（M4）。**

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| **M0 根发现 + family 接入** | 新增 `resolveSessionRoots` + 信号包；`index.ts` 接线（含 `ctx` 可选链降级）；`subagents.ts` 家族扫描接入同一根列表；旧签名保留为薄包装 | §5.1 候选集含 main，且 `find`/`family` 一致（V1/V2/V6） |
| **M1 环境识别 + 宿主自描述** | 新增 `env.ts`（多信号合取）；runtime 侧注入 `PI_CODING_AGENT_SESSION_DIR` + forward 登记 + pi 语义登记 | §5.1 环境行（V3/V7） |
| **M2 doctor** | 新增 `doctor` action + 渲染（复用 M0/M1 数据；进程内缓存；subagent 根默认不扫） | §5.1 doctor 全表（V3） |
| **M3 错误信息与输出** | F1 重写（事实型自检 + 编辑距离候选 + 三条做法 + 禁止项）；uuid 归一化匹配；`find` 按 source 分组 + 全 id + 可复制调用串 | §5.2（V4/V5a） |
| **M4 检索力**（阶段二） | 元数据走 `SessionManager.listAll`（标题/cwd/首消息，惰性 + 窄化 + 缓存，§6.6）；跨会话内容检索（窄化前置 + 字节上限） | V5b/V8 |

M0–M3 是一个不可分割的正确性交付（M3 的自检行依赖 M0 的根列表；M0 不含 family 则制造 §6.8 的矛盾）；M4 可独立排期。

---

## 10. 下一层拆分

**本章结论**：拆成 12 个可实施单元 + 1 个登记项（U13），M0–M3 为第一批，M4 为第二批。**

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| **U1** `discovery/roots.ts`：`resolveSessionRoots(signals)` | 信号 → 带 `kind` 标签的根列表；规范化 `[live]`；realpath 去重；复用 `scanJsonlRecursive` | 是 M0–M3 全部下游（含 family）的数据源，必须最先落地且可单测 |
| **U2** `discovery/env.ts`：`detectEnvironment(signals)` | 多信号合取判定 + `evidence[]` | 与 U1 无数据依赖，但 `doctor` 需两者齐备；独立成单元便于分别单测 |
| **U3** `index.ts` 信号采集接线 | `execute` 组装信号包（可选链 `ctx?.sessionManager` / `process.env` / `import.meta.url`）并传入 handler | 唯一的 pi 依赖触点；`ctx === undefined` 降级必须在此层兜住（现有测试即以五参 `undefined` 调用 `execute`，见 §7.2） |
| **U4** `runtime`：注入 `PI_CODING_AGENT_SESSION_DIR` | 经 `buildOutboundChildEnv` 的 `extras` | 跨包改动，需与 U1 的 `[env]` 信号分别验收（可独立回滚） |
| **U5** `shared` + `docs`：C-proc-09 forward 登记 | `spawn-env-contract.ts` 的 `SPAWN_ENV_FORWARD_REFERENCE` 增条目 + `env-propagation-boundary.md` B 组表 + `spawn-env-contract.test.ts` 增 `toContain` 断言 | 登记义务与 U4 绑定但落点不同包；无既有机器防线拦截（文件级白名单 + 测试无完整性断言），故须**自带补红**——同文件 `:42-45` 的 U0① 增补范式（`it('含 … XYZ_SUBAGENT_IDLE_TIMEOUT_MS')`）就是先例，加三行使「漏登记」从不会红变必红 |
| **U6** `docs/pi-semantics.json`：pi 私有语义登记 | 登记 5 条：① `ENV_SESSION_DIR` 变量名（`dist/config.js:406`）；② session 目录优先级链（`dist/main.js:530-533`）；③ `ctx.sessionManager` 非 mode-gated（`types.d.ts:209-219`）；④ `getSessionDir()` 双形态（cwd 编码子目录 vs 根本身，`session-manager.js:1179-1180`）；⑤ pi 默认布局构造式 `<agentDir>/sessions/<encodeCwd>`（`session-manager.js:242-247`）；各配 pi-anchor + 探针 | 这些是 `[live]`/`[env]` 的成立前提，pi 升级若漂移将**静默**失效（无任何运行时报错，只有行为变化）；按 C-proc-08 须登记使 `check-pi-semantics.mjs` 可拦截。⑤ 与 ④ 是两个不同事实（前者是 `getDefaultSessionDirPath` 的构造式，后者是 `create()` 的分支选择），与 §12.3 的登记去向列一一对应 |
| **U7** `discovery/subagents.ts`：家族扫描接入根列表 | `collectMainSessions` 改用 `resolveSessionRoots`；not-found 文案列实际候选根 | 消除「find 说有、family 说没有」（§6.8）；不改则修复后比修前更差 |
| **U8** `doctor` action | schema enum + handler 分支 + 文本渲染 + 进程内缓存 + subagent 根默认不扫 | 新增 action 需同步 description/guidelines/测试，独立成单元 |
| **U9** F1 错误信息重写 + uuid 归一化 | 事实型自检行 + 编辑距离 top-N + 三条做法 + 禁止项；两级归一化匹配 | 是「封死绕行」的唯一执行点，需单独的文案审查（面向 agent 的提示词）；归一化是 §3.3 盲区的唯一修复点 |
| **U10** `find` 输出增强 | 按 source 分组（main 置顶）+ 全 id + 可复制调用串；**不动** `SESSION_ID_PREFIX_LEN` 与 `result` 通路 | 纯渲染改动，与 U9 同源但可独立验收（成功路径 vs 失败路径）；范围声明防误伤 `result` |
| **U11**（M4）元数据走 `SessionManager.listAll` | `metadataProvider` 注入 + 三条调用策略（惰性触发 / 仅平铺目录 / TTL 缓存）+ 两条 guard（仅对存在根调用且永传非空串；单目录 try/catch 记空继续）+ 纯 TS 降级（首条 user，命中即停） | 解决「标题检索」；该 API 实装语义是「扫一层平铺目录 + 每文件全量解析」（§6.6 两条前提），不窄化即秒级卡顿；降级路径独立可测 |
| **U12**（M4）跨会话内容检索 | 窄化前置 + 字节上限 + 结果渲染 | 新增检索能力，需单独定义「宽搜拒绝」语义 |
| **U13**（登记，不在本次动手）双仓漂移 | npm 重发版 / **触发纯 pi 侧包重装**（settings 条目无版本约束、pi 不自动升级，装机停在 0.2.4）/ CLI 仓去留 / skill 映射表同步 | 属跨仓发布决策，需用户裁决；触发条件与 owner 见 §6.9 |

### 10.1 文件改动地图

| 文件 | 改动 |
|---|---|
| `extensions/universal/session-reader/src/discovery/roots.ts` | 新增 `resolveSessionRoots` / `SessionRoot` / `SessionRootSignals`；`listMainSessions`/`listSubagentSessions` 保留为旧签名薄包装（**工具路径不再直接消费它们**，见 §7.7） |
| `extensions/universal/session-reader/src/discovery/env.ts` | **新增** |
| `extensions/universal/session-reader/src/discovery/find.ts` | `collectCandidates` 改从 `resolveSessionRoots` 取文件列表；两级归一化匹配；`metadataProvider` 注入点 |
| `extensions/universal/session-reader/src/discovery/subagents.ts` | `collectMainSessions` 改用根列表；`:63-68` not-found 文案列实际候选根 |
| `extensions/universal/session-reader/src/tool-handler.ts` | `handleSessionRead` 签名加 `signals`/`metadataProvider`；新增 `doctor` 分支与 `renderDoctor`；改写 `formatNoMatch`；`formatFindContent` 分组 + 全 id；编辑距离工具。**不改** `SESSION_ID_PREFIX_LEN` 与 `result-action.ts` |
| `extensions/universal/session-reader/src/index.ts` | schema enum 加 `'doctor'`；description action 列表补一词；guidelines 加一句；`execute` 组装信号包（可选链）+ `metadataProvider` |
| `packages/runtime/src/infra/pi/rpc-client.ts` | `buildPiOutboundEnv` 的 `extras` 增 `PI_CODING_AGENT_SESSION_DIR` |
| `packages/shared/src/spawn-env-contract.ts` | `SPAWN_ENV_FORWARD_REFERENCE` 增条目（U5） |
| `docs/design/env-propagation-boundary.md` | B 组表同步（U5） |
| `docs/pi-semantics.json` | 登记 4 条 pi 私有语义（U6） |
| 测试 | `src/__tests__/roots.test.ts`（三宿主信号包 table-driven）、`env.test.ts`（新增，含透传污染反例）、`tool-handler.test.ts`（`doctor` + 新 F1 文案 + 分组 + 归一化 + family 一致性）、`index.test.ts`（`ctx === undefined` 与 `sessionManager` 缺方法两例） |

---

## 11. 待验证检查点

设计阶段无法确定、留给实施期验证的点（**不编造结论**）：

1. **`ctx.sessionManager.getSessionDir()` 在 RPC 模式的实际返回值**。类型上 `sessionManager` 是 `ExtensionContext` 的基础字段（`types.d.ts:209-219`，非 mode-gated），但需在 xyz-agent 的 RPC 子进程里实跑确认其返回 `<dataDir>/pi/sessions`（而非 cwd 编码子目录）。**失败降级**：`[live]` 信号不可用时，`[env]` + `[default]` + `[legacy]` 三根仍能覆盖三宿主（U1 的候选根设计已保证降级路径可用）。
2. **`[live]` 的 encodeCwd 判据**是否会误判（例如用户 cwd 路径恰以 `--` 结尾）。实施时用真实路径集合回归；若误判，改用「该目录的父目录名为 `sessions`」作判据。
3. **`SessionManager.listAll` 的实测成本与合并语义**。**已由源码核定**（第 3 轮修订）：只扫一层平铺目录、不递归（`session-manager.js:550-556`）；每文件全量解析、读到 EOF（`:443-511`）——§6.6 据此已定为惰性 + 窄化 + 缓存。**仍需实测**：(a) 真实目录上的单次耗时（对照先例 530 文件 667ms，`docs/2026-08-10-cwd-popup-redesign.md:190`）以校准 TTL 量级；(b) 多目录结果的重复 id 合并规则；(c) `name` 在旧 session 上的缺失率。**降级**：任一项不达预期即回退到纯 TS 首条 user 读取（U11 的降级路径），标题检索降级为不可用而非错误。
4. **`find` 扫多根的耗时**。纯 pi 下单根 4619 文件，`find` 已有全量首行扫描。新增 `[legacy]`（通常不存在）应 <1ms（§12.1 P-8 实测登记）；若 `find` P50 劣化超 20%，考虑首行扫描改并发（当前为串行 `for`）。
5. **uuid 归一化的误命中面**。`norm` 匹配（小写 + 去连字符）会把「8 位 hex 但语义是别的东西」的 query 也纳入 uuid 匹配。**对比基线写死**：与现状（精确子串 + `looksLikeUuidFragment` 无回退）对**同一组 query** 比命中数与召回类型，二者做差；增量仅限「大小写/连字符变体」（`looksLikeUuidFragment` 改用 `norm(query)` 是等价变换——`/i` 已忽略大小写，去连字符不扩字符类），预期无召回回归，实测确认。
6. **`PI_CODING_AGENT_SESSION_DIR` 注入后的实际效果与继承面**。活体 `ps eww` 确认可见（§12.1 P-3）；pi 未因 `--session-dir` 与 env 同时存在而行为异常（按 `main.js:530-533` 的 `??` 链 argv 优先，行为应不变——实跑确认）；V7 的 bash 派生类落盘位置与 §6.5 声明一致。
7. **legacy 根非空的机器**。§4.2 注二指出两条迁移链都可能产生「legacy 非空」：① 纯 pi 的 `~/.pi/sessions`（pi `migrations.js` 残留）——**在候选根内**；② xyz-agent 的 `~/.xyz-agent/sessions`（`pi-maintenance.ts` 残留）——**不在候选根内**（候选根是 `dirname(agentDir)/sessions` = `~/.xyz-agent/pi/sessions`）。需分别构造回归「非空即纳入候选 + doctor 告警」路径，并确认不会与 `[default]` 形成大量陈旧重复条目；对 ② 裁决「是否补第四候选根」或「显式声明不覆盖及原因」。
8. **relay / 其他 runtime 派生链是否带 `--session-dir`**——**已核**（第 2 轮复审补充实测）：relay 链带（`session-runner.ts:1149` → `relay.mjs:163` → `relay-registry.ts:374`），与 §6.5 表第一行同判定；本仓全部 `pi --mode rpc` spawn 点已穷举（`rpc-client.ts:289` / `session-runner.ts:1149` / relay 经帧 argv 透传），无遗漏。
9. **`doctor` 的 token 与墙钟成本**。输出含 4–5 个根；「扫描耗时」若使输出超预算则折叠为可选参数；墙钟上界受 §6.3 的 subagent 根默认不扫 + 进程内缓存约束，需实测确认。

---

## 12. 附录

### 12.1 探针清单（准则 7：运行时断言必须附探针）

| 编号 | 断言 | 探针 | 状态 |
|---|---|---|---|
| P-1 | `findSessions('01a08a6e', '~/.xyz-agent/pi/agent')` 返回 0 命中（现状根因复现） | `npx tsx ./probe-find.mts`（§12.2） | ✅ 已测（0 命中） |
| P-2 | 修复候选集后 `family` 仍抛 not-found（证 §6.8 必要性） | 对 `buildFamilyFromFs('01a08a6e-74fc-…', '~/.xyz-agent/pi/agent')` 探针 | ✅ 已测（THROW，文案见 §6.8） |
| P-3 | xyz-agent spawned pi 进程 env 含 `XYZ_AGENT_EXT_LOG=1` | 主探针 = **会话内 bash `env` 自读**（bash 工具读自身 env，不受 SIP 限制，恒可靠）；`ps eww -A \| grep -o '…'` 为 best-effort 旁证——本仓 `reap-orphan-pi.ts:12-14` 在案记录「macOS 上 `ps eww`/`launchctl procinfo` 因 SIP 拿不到他进程 env（探针否决）」，本机当前实测可见（6 进程 `=1`）属机器/权限差异，**不可作为依赖通道** | ✅ 已测（6 进程 `=1`） |
| P-4 | 四根文件数（xyz-agent prod / dev / 纯 pi）+ 主 session 标题覆盖率 | 见 §4.2 表；`grep -c '"type":"session_info"'` 逐文件 | ✅ 已测（14 文件中 10 个含 `name`） |
| P-5 | `PI_CODING_AGENT_SESSION_DIR` 被 pi 消费（优先级链） | 主探针 = P-3 同款**会话内 bash `env` 自读**（`ps eww` 仅 best-effort，见 P-3 的 SIP 在案否决） | ✅ 源码已核；⛔ 实施期用 env 自读确认 |
| P-6 | `ctx.sessionManager.getSessionDir()` 在 RPC 模式返回主 session 根 | 在 xyz-agent RPC 子进程内打印该值 | ⛔ 实施期门（§11.1） |
| P-7 | bundle 为 ESM 且保留 `import.meta.url` | `scripts/bundle-extensions.mjs:276(format:"esm"),283(注释)` | ✅ 源码已核；⛔ 实施期在打包产物内确认 |
| P-8 | uuid 归一化盲区（大写 / 去连字符 → 现状 0 命中）+ 多根扫描耗时增量 | 对真实 14 主 session 构造候选集跑 5 种 query 形态；`performance.now()` 包裹多根扫描 | ✅ 已测（大写 0、去连字符 0，见 §3.3 表）；⛔ 多根耗时实施期登记 |
| P-9 | 自写 `session_info` 深读的成本（证 §6.6 否决理由） | 抽样对比「读到首条 user」vs「读全文」的字节量 | ✅ 已测（~170x 放大，2.7GB 最坏量级） |

**P-6 失败的降级路径**：`[live]` 根被跳过，发现层退化为「`[env]` + `[default]` + `[legacy]`」三根并集——在三个已知宿主的实测布局下这三根已完备（§4.2），故 P-6 失败**不阻塞** M0 交付，只降低「跟随宿主」的长期健壮性。

### 12.2 复现探针（可重跑）

```bash
cd <repo>/extensions/universal/session-reader
cat > ./probe-find.mts <<'EOF'
import { findSessions } from './src/discovery/find.js'
import { listMainSessions, listSubagentSessions } from './src/discovery/roots.js'
const agentDir = '/Users/zhushanwen/.xyz-agent/pi/agent'
console.log('main:', (await listMainSessions(agentDir)).length,
            ' sub:', (await listSubagentSessions(agentDir)).length)
for (const q of ['01a08a6e', '01a08a']) {
  const r = await findSessions(q, agentDir, { limit: 100 })
  const by: Record<string, number> = {}
  for (const m of r.matches) by[m.source] = (by[m.source] ?? 0) + 1
  console.log(`find(${JSON.stringify(q)}) ->`, r.matches.length, by)
}
EOF
npx tsx ./probe-find.mts
# 实测输出：main: 2  sub: 1330
#          find("01a08a6e") -> 0 {}
#          find("01a08a")   -> 34 { subagent: 34 }
```

> 探针为临时诊断脚本，用完删除（不随 git 跟踪）。

### 12.3 关键事实核验表

| 事实 | 权威源 | 核验方式 | 登记去向 |
|---|---|---|---|
| 主 session 根 = `<agentDir>/sessions` | `src/discovery/roots.ts:84` | 读源码 | — |
| pi 默认布局 = `<agentDir>/sessions/<encodeCwd>` | `dist/core/session-manager.js:242-247` | 读源码 | U6 登记 |
| session 目录优先级 `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > settings | `dist/main.js:530-533` | 读源码 | U6 登记 |
| `ENV_SESSION_DIR` 变量名 = `PI_CODING_AGENT_SESSION_DIR` | `dist/config.js:406` | 读源码 | U6 登记 |
| xyz-agent 用 `--session-dir <dataDir>/pi/sessions` | `rpc-client.ts:289` + `pi-paths.ts:105-107` | 读源码 | — |
| `getAgentDir()` 读 `PI_CODING_AGENT_DIR` | `dist/config.js:420-426` | 读源码 + `node` 实测（无 env 时返回 `~/.pi/agent`） | — |
| `XYZ_AGENT_PACKAGED` 不可用（被剥） | `packages/shared/src/spawn-env-contract.ts:30` | 读源码 + 活体 ps（唯一持有者为 Electron 主进程，无 pi 子进程持有） | — |
| `XYZ_AGENT_EXT_LOG=1` 在 pi 进程 env，但可被 shell 透传污染 | 活体 `ps eww` 实测 + `constants.ts:74`（`XYZ_` 前缀在入站白名单） | 已测 + 读源码 | — |
| `ExtensionContext.sessionManager` 非 mode-gated | `dist/core/extensions/types.d.ts:209-219` | 读源码 | U6 登记 |
| `ReadonlySessionManager.getSessionDir()` 存在，且 `--session-dir` 覆盖时返回根本身 | `dist/core/session-manager.d.ts:140,205` + `session-manager.js:1179-1180` | 读源码 | U6 登记 |
| `SessionManager.listAll(dir)` 返回 `SessionInfo{name,cwd,firstMessage,…}`；**语义 = 扫一层平铺目录（不递归）+ 每文件全量解析（读到 EOF）** | `dist/core/session-manager.js:550-556`（`listSessionsFromDir` 单层 readdir）、`:443-511`（`buildSessionInfo` 全量）、`:1292-1325`（双分支）；`session-manager.d.ts:125-138,353-354`；本仓 `hash-provider.ts:2,139,157-159,161` | 读源码 | U6（成本形态随 ④/⑤ 一并登记） |
| 主 session 含 `session_info.name` 标题 | 真实 jsonl + `rename-session/src/index.ts:79`（`pi.setSessionName(title)`） | 已测（10/14 文件命中） | — |
| bundle 为 ESM，`import.meta.url` 保留 | `scripts/bundle-extensions.mjs:276,283` | 读源码 | — |
| 双仓事实：npm 0.2.4 = 本仓 extension 的发布快照；`~/Code/pi-session-reader` 是 private 的 `-cli@0.1.0` CLI 派生仓 | 两仓 `package.json` + `~/.pi/agent/settings.json` + 安装副本源码比对 | 已测 | §6.9 / U13 |
| skill 映射表写死 10 action，symlink 指向 CLI 仓 | `~/.agents/skills/pi-session-reader` → `…/pi-session-reader/skills/pi-session-reader`，`SKILL.md:63-70` | 读源码 | §6.9 / U13 |

### 12.4 变更历史

- v3（2026-09-10）：第 2 轮聚焦复审（影响面审 0 MF + 6 SG；主审 5 MF + 5 SG）全量修订：
  1. **§6.6 重写（主审 MF-A）**：`listAll(dir)` 两条实装语义核定——只扫一层平铺目录不递归（`session-manager.js:550-556`）、每文件全量解析读到 EOF（`:443-511`）；调用策略改为**惰性触发 + 窄化（仅平铺目录）+ TTL 缓存**；§2 目标 4 限定范围（纯 pi 跨项目标题检索显式不覆盖）；§11.3 的「是否递归」由待验证转为源码已核。
  2. **§6.5/V7③ 更正（主审 MF-B）**：subagent pi 的 env 是 runtime 进程 env 整体继承（`session-runner.ts:1764`），U4 的 extras 不进 runtime 自身 env → subagent pi 内 `[env]` **缺席**、主根以 `[legacy]` 出现；扩展注入属范围变更须另过 C-proc-09 评审，本设计默认不做。
  3. **legacy 告警判据统一（主审 MF-C）**：三处矛盾收敛为「非空才告警」；§5.1 TaiJi 示例更正（`[legacy]` 与主根同路径去重，删除错误的 `~/.pi/sessions` 告警行）；V3 改为正反向判定 + 构造非空环境。
  4. **分组 × limit × truncated 规格（主审 MF-D）**：limit 作用于分组后合并列表、truncated 按合并总量、解析路径不受分组影响；回归基线改可判定形式（`limit:100`）。
  5. **删除 delta 链引用（主审 MF-E）**：三处「（影响面 MF-x）」改为自包含描述。
  6. **family 三腿声明（主审 SG-1）**：§6.8 补「只改 main 腿」；§6.1 补 `[subagent]` 根来源（常量推导，非信号）；§7 数据流图加注；V6 补 subagent 节点判定。
  7. **V5 拆分（主审 SG-2）**：V5a（归一化 + 分组，M3）/ V5b（标题检索，M4），§9.1 同步。
  8. **归一化验证基线（主审 SG-3）**：§11.5 写死「与现状对同一组 query 做差」。
  9. **legacy 两链区分（主审 SG-5）**：§4.2 注二区分 pi 侧与 xyz-agent 侧迁移链；§11.7 补 `~/.xyz-agent/sessions` 不在候选根的缺口裁决。
  10. **影响面 SG-1~SG-6**：relay 链已核（带 `--session-dir`，`session-runner.ts:1149`→`relay.mjs:163`→`relay-registry.ts:374`）；doctor 缓存三处矛盾统一（`find` 永不读缓存、自检行取实扫计数）；恢复通道删「reap 兜底」事实错误（reap 只杀进程不处理文件）；P-3/P-5 主探针改为会话内 `env` 自读（`ps eww` 有 `reap-orphan-pi.ts:12-14` 在案的 SIP 否决记录，降为 best-effort）；V7 补落盘观察/清理/模型来源三细节；U5 补 `toContain` 补红断言（同文件 `:42-45` 范式）；U6 计数 4→5；U9' 编号统一为 U13 + 补「npm 无版本约束、须触发纯 pi 侧重装」。
  11. **勘误**：`hash-provider.ts:9`→`index.ts:203`（19ms 语境）；`subagents.ts:63-68`→`:55`；「亚 agent 根」→「subagent 根」；§5.1 样例数量口径；`\"` 转义残留。
- v2（2026-09-10）：按两份对抗式审查报告（主审 4 must-fix + 影响面审 6 must-fix，共 10 条去重后 8 条独立 + 12 条 suggestion）全量修订：
  1. **范围补全**：`family` / `export{format:"family"}` 接入同一根列表（新增 §6.8、U7、V6）——原设计保留 `listMainSessions` 旧路径会导致修复后 `find` 命中而 `family` 抛错（实测 P-2 复现）。
  2. **事实更正**：§6.9 双仓归属（npm 0.2.4 是本仓 extension 的发布快照，`~/Code/pi-session-reader` 是 private 的 `-cli@0.1.0`，不可能发布）+ 补 skill 映射表耦合。
  3. **归一化盲区**：新增两级 uuid 归一化匹配（§6.7），修掉「大写 / 去连字符 uuid → 0 命中且被错误归因」；自检改为**事实型**、不断言「真的没有」。
  4. **成本纠偏**：元数据改用 `SessionManager.listAll`（§6.6、U11），替换 v1 的自写 `session_info` 深读（实测 ~170x 放大、最坏 2.7GB，P-9）。
  5. **契约与登记**：补 C-proc-09 forward 登记（U5）、C-proc-08 pi 语义登记（U6）。
  6. **继承面枚举**：§6.5 补 env 继承者三分类、量化、恢复通道、重审触发条件；§8 增反向场景 V7。
  7. **降级与兼容**：`ctx` 可选链 + `index.test.ts:97` 入测试地图（§7.2）；`listAll` 降级路径（§11.3）。
  8. **验收补强**：V2 环境隔离命令、V3 legacy 告警正反向、V5 归一化用例、`recent` 回归基线、`result` 短 id 不动声明。
  9. **示例校真**：§5.1 改为按实测推演并显式标注非逐字实测；`find` 按 source 分组修「subagent 噪声淹没」。
  10. **行号勘误**：`spawn-env-contract.ts:30`（原写 31）、`rpc-client.ts:195`（原写 199）、`bundle-extensions.mjs:283`（`format:"esm"` 在 276）。
- v1（2026-09-10）：首版。基于 handoff `/tmp/handoff-session-reader-fixes.md` 的缺陷清单做核验后重写——撤销 P0-2（非独立缺陷，§3.3），补入 handoff 未覆盖的环境识别（§6.4/§6.5）与标题检索（§6.6），并新增物理数据流与探针清单。
