# LLM 调用配置（重试/退避）GUI — 技术方案设计

> **一句话结论**：跟随 pi 原生 `settings.json` 的 `retry` schema，在 xyz-agent 设置 System 页新增「LLM 调用」分组，经 `PiSettingsStore` 新增 `retry` 字段域 + 一对 `config.get/setRetryConfig` RPC 暴露 GUI，零自建存储、零新持久化文件。
>
> **层声明**：本文档是技术方案设计层（下一层产物 = 可实现的接口 / 数据模型 / 错误规格 / 文件改动地图）。实现计划（任务级 TDD 拆分）是再下一层，不在本文展开。

---

## §1 背景目标

**SCQA**：

- **S（情境）**：xyz-agent 内嵌 pi coding agent 负责 LLM 调用。pi 内置两层自动重试（agent 层 turn 级重试 + provider 层单请求级重试），行为由 `settings.json` 的 `retry` 字段控制，且 pi CLI 没有任何 retry 相关启动 flag——配置只能写进 settings.json（已核实 0.84.4 实装 dist/bundle/cli.js 零 retry flag）。
- **C（冲突）**：xyz-agent 的设置 GUI 有 12 个分组（provider / appearance / skill / agent / extension / system-prompt / terminal / preset / worktree / update / system / usage），**没有任何 LLM 调用层配置**。用户当前只能手编 JSON 文件，且存在两个同名文件易混淆（见 §2）。
- **Q（问题）**：如何让用户在 GUI 里安全、可发现地调整 LLM 重试策略，同时不破坏 pi 读写同一文件的并发安全？
- **A（答案）**：复用 `PiSettingsStore` 既有跨进程锁与字段域机制，新增 `retry` scope + 一对 RPC + System 页一个分组（本文档 §3）。

**系统是什么**（给不了解内部的读者）：

- **pi**：上游 npm 包 `@earendil-works/pi-coding-agent@0.84.4`，xyz-agent 每个会话 spawn 一个 `--mode rpc` 的 pi 子进程（`packages/runtime/src/infra/pi/rpc-client.ts:190`）。pi 从自己的配置目录读 `settings.json`。
- **两个 settings.json**：独立 pi CLI 读 `~/.pi/agent/settings.json`；xyz-agent 桌面端因数据隔离（ADR-0009）读 **`~/.xyz-agent/pi/agent/settings.json`**。schema 相同、文件不同、互不影响。
- **PiSettingsStore**（`packages/runtime/src/infra/pi/pi-settings-store.ts`）：xyz-agent 侧对该文件的唯一读写层，带 proper-lockfile 跨进程锁（与 pi 同锁协议）和字段域 scope merge（现有 scope：`model` / `skills` / `extension` / `full`），保证 xyz 写入不覆盖 pi 并发写入的字段，反之亦然。

**设计目标**（从使用者体验倒推）：

- **G1 可发现、可修改**：不手编 JSON，在设置 GUI 中完成重试策略调整；表单值与 pi 真实生效语义一致（不出现「GUI 显示的值 pi 实际不这么读」）。
- **G2 写对地方、并发安全**：写入 xyz-agent 隔离目录的 settings.json；与 pi 子进程自身的 settings 落盘并发时互不覆盖。
- **G3 危险参数后果可见**：当前可配出「单次对话最长等待 85 分钟」的组合（见 §2 失败模式 B），GUI 必须把指数退避的后果显性化。
- **G4 生效时机可预期**：用户能预期配置改动的生效范围（新会话生效，运行中会话不变）。

**In scope**：

- xyz-agent 隔离目录 settings.json 的 `retry` 字段（agent 层 `enabled` / `maxRetries` / `baseDelayMs` + provider 层 `timeoutMs` / `maxRetries` / `maxRetryDelayMs`）的 GUI 读写。
- 写入期数值校验、缺省值展示（pi 默认语义）。

**Out of scope**（防 scope creep，每条附理由）：

- **per-provider / per-model 差异化重试**：pi 的 retry schema 是全局单份，无 per-provider 维度；做了 pi 也读不到。
- **运行中会话热生效**：pi SettingsManager 启动时加载、无 file watcher、rpc 模式无 reload 命令（已核实 dist 编译 JS）——pi 能力不具备，强行热生效需要重启会话编排，属另一层需求。
- **独立 pi CLI（`~/.pi/agent/`）的 GUI 管理**：那是 pi CLI 自有领域，xyz-agent 不触碰。
- **摘要路径（compaction / branch summary）单独配置**：pi 实装中摘要重试共享同一份 `settings.retry`（`agent-session.js:1451`、`:2545`），无独立字段可配。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

用户当前调整重试行为的唯一方式是手编两个 JSON 之一。以用户真实配置为例（2026-08-31 实测，两份文件里手工写入了同一份配置）：

```jsonc
// ~/.pi/agent/settings.json（独立 pi CLI 用）
// ~/.xyz-agent/pi/agent/settings.json（xyz-agent 桌面端用）
"retry": {
  "enabled": true,
  "maxRetries": 10,
  "baseDelayMs": 5000,
  "provider": { "maxRetryDelayMs": 1800000 }
}
```

这份配置没有任何 GUI 能看到或修改。更隐蔽的是它的实际后果（见 2.3 失败模式 B）。

### 2.2 配置的真实语义（实装 0.84.4 编译 JS 已核实，非 TS 参照推测）

`retry` 字段控制**两层独立重试**，GUI 设计必须区分，否则用户无法理解每个参数实际管什么：

**第 1 层：agent 层 turn 级自动重试**（`retry.{enabled, maxRetries, baseDelayMs}`）

| 字段 | pi 默认 | 读取点 |
|---|---|---|
| `enabled` | `true` | `settings-manager.js:581`（`?? true`） |
| `maxRetries` | `3` | `settings-manager.js:595`（`?? 3`） |
| `baseDelayMs` | `2000` | `settings-manager.js:596`（`?? 2000`） |

- 退避公式：`delayMs = baseDelayMs * 2^(attempt-1)`，**无上限、无 jitter**（`agent-session.js:2290`）。
- 触发条件：最后一条 assistant 消息 `stopReason === "error"` 且错误文案命中 `RETRYABLE_PROVIDER_ERROR_PATTERN`（429 / 500 / 502 / 503 / 504 / 524、网络错误、超时、流中断等宽匹配）；quota / billing / 配额耗尽类显式**不**重试（`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`）；context overflow 走 compaction 不走 retry（`pi-ai/dist/utils/retry.js:4-77`、`agent-session.js:2241-2246`）。
- 重试期间 pi 发 `auto_retry_start` / `auto_retry_end` 事件，sleep 可中断（`abortRetry()`）。

**第 2 层：provider 层单请求级重试**（`retry.provider.{timeoutMs, maxRetries, maxRetryDelayMs}`）

| 字段 | pi 默认 | 读取点 |
|---|---|---|
| `timeoutMs` | 未设 → 跟随 `httpIdleTimeoutMs` | `settings-manager.js:612`（未设即 undefined 透传）+ `sdk.js:186-192` 消费 |
| `maxRetries` | 未设 → `0`（**默认完全不重试**） | `settings-manager.js:613`（`??` 无兜底，`retryProviderRequest` 里 `?? 0`） |
| `maxRetryDelayMs` | `60000` | `settings-manager.js:614` |

- 退避：优先尊重服务器 `retry-after` / `retry-after-ms` 响应头；服务器要求的延迟超过 `maxRetryDelayMs` 时**直接抛错失败**（设 `0` = 不限制）；无服务器指示时 `min(0.5 * 2^retryIndex, 8) * 1000` 再乘 `(1 - random*0.25)` jitter（`pi-ai/dist/utils/provider-retry.js:29-44`）。
- 触发条件：HTTP 408 / 409 / 429 / 5xx、`x-should-retry` 头、无 status 的网络层错误（`provider-retry.js:9-21`）。
- **`timeoutMs` 的 0 陷阱**：「0 = 禁用超时」的 int32 映射（`sdk.js:188-190`）**只作用于全局 `httpIdleTimeoutMs`**；`provider.timeoutMs` 走 `??` 链原样透传（`sdk.js:191`），0 会被底层 SDK 解释为 0ms 立即超时（`anthropic-messages.js:379` 原样传入 `{ timeout }`）——「不超时」语义只能由全局 `httpIdleTimeoutMs: 0` 承担（D8 据此禁止该字段为 0）。
- 该层实装是对 OpenAI/Anthropic SDK 内置重试行为的复刻（SDK 以 `maxRetries: 0` 调用、外面包 `retryProviderRequest`，使退避 sleep 可被 AbortSignal 中断，`anthropic-messages.js:380-383`）。
- **pi rpc 面的落盘写点**（与 D6/S4 相关的实装事实）：rpc `set_model` / `set_thinking_level` 是会话级切换、**不落盘** settings.json（`rpc-mode.js:367-374` / `:390` 调 `setModel(model)` / `setThinkingLevel(level)` 均不传 options；落盘在两方法内是 `options.persist` 条件分支，`agent-session.js:1252-1261` / `:1358-1366`）；唯一无条件落盘的 rpc 写点是 `set_auto_retry`（`rpc-mode.js:430` → `agent-session.js:2342-2344` → `settingsManager.setRetryEnabled`，`settings-manager.js:584-590`）。

**两层叠加关系**：provider 层先耗尽自己的 `maxRetries`，仍失败则错误以 assistant 消息落到 agent 层，agent 层再按自己的预算重试。总尝试次数 ≈ `(1 + provider.maxRetries) × (1 + agent.maxRetries)`。

### 2.3 物理数据流（现状）

```
┌─ 用户手编 JSON ─┐
│ ~/.xyz-agent/pi/agent/settings.json 的 retry 字段
│        （xyz-agent 桌面端 pi 实际读取的文件）
└──────┬─────────┘
       │ pi 子进程启动时一次性加载（SettingsManager 构造；无 file watcher、rpc 无 reload）
       ▼
  pi 会话进程（--mode rpc，每会话一个）
       │ 请求失败：provider 层 retryProviderRequest（SDK 级）
       │ 仍失败 → agent 层 _prepareRetry（turn 级，发 auto_retry_* 事件）
       ▼
  runtime event-adapter → 协议 message.auto_retry_start/end（protocol.ts:1396-1397）
       ▼
  renderer chat store → Composer RetryIndicator（重试进度 UI，已上线）
```

**已就绪的部分**：重试的「运行时可见性」全链路已通——用户能在对话流里看到重试发生。**缺失的部分**：这条链路的「配置面」完全空白，且 `retry` 字段不在 `PiSettingsStore` 任何 scope 里（xyz 侧今天没有任何代码写它，它纯属手编值）。

### 2.4 失败模式（真实、当前存在）

- **失败模式 A：配错文件**。用户改了 `~/.pi/agent/settings.json`（独立 CLI 的），桌面端行为纹丝不动——桌面端读隔离目录。本次会话中用户就先贴了独立 CLI 的文件。根因：两个同名文件 + 无任何 GUI 提示配置的真实读取位置。
- **失败模式 B：无上限指数退避不可见**。当前手工配置 `maxRetries=10, baseDelayMs=5000`：第 n 次重试前等待 `5000*2^(n-1)` ms，第 10 次单次等待 ≈ **42.7 分钟**，10 次总等待 ≈ **85.25 分钟**。期间 UI 只有 RetryIndicator 小组件，用户很可能不知道一次失败请求会让会话挂起一个多小时。根因：公式无 cap（pi 设计如此）+ 配置面不可见导致参数后果无人计算。
- **失败模式 C：手编破坏 schema**。如把 `retry` 写成字符串（`"retry": "abc"`）。pi 侧靠 `?.` + `??` 链容忍（回落默认值）；xyz 侧 `PiSettingsStore` 的 scope merge 只按顶层 key 覆盖，今天没有写入方，坏值会一直留存且无人发现。
- **失败模式 D：参数叠加爆炸**。provider 层 `maxRetries` 默认 0，用户若把它和 agent 层同时调大（如 3 × 10），总尝试 40 次，叠加两层退避后等待时间失控。两个层的参数在 JSON 里缩进相邻，手编时极易误解作用域。

### 2.5 根因

重试是 pi 的运行时行为，其配置面却停留在「pi CLI 时代的手编文件」形态；xyz-agent 收编了 pi 的其他配置域（model / skills / extension 都有 scope、有 GUI 或 runtime 管理方），唯独调用层策略被漏下。方案应当补齐这个域，而不是另起炉灶造第二份配置。

---

## §3 解决方案

### 3.1 终态（使用者视角）

用户打开 设置 → 系统，看到新增「LLM 调用」分组（置于 SystemSmartContextSection 之后）：

**成功路径——调整重试策略**：

> 用户最近遇到某服务商频繁 429，想把重试拉满。打开设置 → 系统 → 「LLM 调用」分组：打开「自动重试」开关（已开），「重试次数上限」从 3 改为 10，「基础等待」从 2 秒改为 5 秒。改完的瞬间，分组底部的灰色说明行实时更新：「按当前配置，单次失败请求最长重试 10 次、累计等待约 85 分钟；保存后对新会话生效」。用户觉得可接受，点「保存」。toast 提示「已保存，新会话生效」。之后新建会话发送消息，服务商持续 429 时，对话流里 RetryIndicator 依次显示第 1~10 次重试，间隔按 5s → 10s → … → 42.7min 递增。

**成功路径——关闭重试**：

> 用户批量跑任务，希望失败快速暴露而不是挂起。把「自动重试」开关关掉，点保存。新会话里请求一失败（网络断、429 等），错误直接作为 assistant 消息落进对话流，不再出现 RetryIndicator。

**失败路径——输入越界**：

> 用户在「基础等待」里输入 99999 秒（约 27.8 小时），点保存。输入框标红，toast 显示「baseDelayMs 超出范围（0-600000）：99999000」，配置不落盘。用户改回 5 秒，保存成功。（恢复指引 = 错误信息自带字段名 + 合法范围 + 当前值，改值重试即可。）

**失败路径——文件已损坏**：

> 用户之前手编时把 settings.json 的 `retry` 字段写坏（如写成字符串）。打开「LLM 调用」分组时表单显示 pi 默认值（开关开 / 3 次 / 2 秒）——不弹损坏横幅（D7：整文件级损坏由 `PiSettingsStore` schema guard 兜底 + warn 日志，GUI 无感知降级）；用户直接点一次「保存」即可用合法结构重写 `retry` 字段完成自愈。若整个文件坏到 store schema guard 兜底（回落空对象），表现相同：表单显示默认值，保存动作会重建 `retry` 域。

### 3.2 多方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A（选）：跟随 pi schema，写 `~/.xyz-agent/pi/agent/settings.json` 的 `retry` 字段**（PiSettingsStore 新增 `retry` scope + `config.get/setRetryConfig` RPC + System 页分组） | 与 model/skills/extension 域同构，pi 升级新增 retry 子字段时嵌套 merge 自动保留；单一数据源，无第二份配置可漂移 | 小：约 2 个新文件 + 6 处既有文件增量修改（见 §5 地图），全部有同构先例可抄 | 与 pi 子进程写并发——既有跨进程锁协议覆盖（`pi-settings-store.ts:16-36`，探针已验证） | ✅ |
| **B：xyz config.json 自建存储 + spawn 时透传给 pi** | 出现第二份真相源，与 pi settings.json 必然漂移 | 中：除 GUI 外还要做透传通道 | **不成立**：pi CLI 无任何 retry 启动 flag、无 env 覆盖（已 grep 实装 0.84.4 cli.js），透传通道根本不存在——造出来的会是一份 pi 读不到的假配置。若用它，§3.1 用户保存后新会话行为**毫无变化** | ❌ |
| **C：不建 GUI，设置页放「说明卡」引导用户手编 settings.json** | 零代码，但失败模式 A/C/D（配错文件、坏 schema、叠加爆炸）原样保留且永久化 | 极小 | G1/G3 两条目标直接不达成；用户本次诉求就是消除手编 | ❌ |
| **D：GUI 直连文件读写（renderer 经 Electron IPC 读写 JSON）** | 绕开 PiSettingsStore 唯一读写层（D17 收口），与 pi 子进程写回竞态重新裸奔；架构倒退 | 中：要新造一条 IPC 通道 | 违反项目既有收口决策；若用它，§2.3 数据流图里「唯一读写层」节点被旁路，§4 的并发场景（S4）无法保证 | ❌ |

**推荐 A**。核心理由：pi 只认 settings.json（B 不成立），而 settings.json 的跨进程写治理 xyz-agent 已经建成（D 不必要），剩下的工作只是把既有机制接到 GUI（C 是放弃治疗）。

### 3.3 关键决策与权衡

**D1：数据权威源 = pi settings.json 的 `retry` 字段，xyz 零自建存储（选定）**
- **采用**：GUI 读写的唯一落点就是隔离目录 settings.json 的 `retry` 字段；pi 怎么读、xyz 就怎么写，schema 1:1。
- **被否**：方案 B（自建 + 透传，pi 无通道）、方案 D（IPC 直连绕开收口层）——见 3.2 表。
- **证据**：pi 读取点 `settings-manager.js:592-598` / `:610-615`；pi CLI 零 retry flag（dist/bundle/cli.js grep 为空）；`PiSettingsStore` 模块头「settings.json 是 pi 的配置文件，无法拆分成多个文件」。
- **效果**：G1 成立的前提（GUI 显示的值 = pi 真实读取的值）；失败模式 A 的 GUI 侧消解（配置永远写在桌面端实际读取的文件）。

**D2：写入通道 = `PiSettingsStore` 新增 `retry` 字段域 scope（选定）**
- **采用**：`SCOPE_FIELDS` 增加 `retry: ['retry']`；写入走既有 `updateSettingsFields('retry', mutator)`（锁内 RMW + 域外字段取锁内最新读）。
- **被否**：`full` scope——既有白名单仅 pi-maintenance 启动迁移一个调用点，模块注释明确「新代码禁止使用 full scope」；绕过锁直接 `writeSettings`——该函数注释明确「生产写路径必须走 updateSettingsFields」。
- **证据**：`pi-settings-store.ts:92-97`（SCOPE_FIELDS）、`:85-87`（full 禁令）、`:156-158`（writeSettings 禁令）。
- **效果**：G2 成立——pi 子进程经自身 SettingsManager 的落盘与 GUI 保存 retry 互不覆盖。pi 侧写回实装是「持锁 + 锁内重读文件 + 仅 patch modified 字段/嵌套键」（`persistScopedSettings`），即使双方同写 `retry` 域也是键级 merge（双向保护，见 §2.2 末条 rpc 写点事实与 S4 同域并发场景）；跨进程锁协议本身已有探针验证（`pi-settings-store.ts:16-36`，✅已测）。注：`pi-settings-store.ts:8` 模块头「用户 GUI 切模型/切思考档位时 pi 落盘」的说法与 0.84.4 rpc 实装不符（见 §2.2 末条），本设计不沿用；该注释修正已随 u2-runtime 实施批完成（2026-08-31）。

**D3：`retry` 域内做嵌套字段级 merge，只 patch xyz 已知的键（选定）**
- **采用**：mutator 里对 `retry` 对象做二级 merge——读取锁内最新 `retry` 对象，仅覆盖 `{enabled, maxRetries, baseDelayMs, provider.timeoutMs, provider.maxRetries, provider.maxRetryDelayMs}` 六个已知键，pi 未来新增的 retry 子字段原样保留。这是顶层字段域 merge（D1b）在嵌套层的复刻。**非 plain object 规则（任何层级统一）**：任意层级遇到非 plain object 值（string / number / boolean / array / null）时，该层不做 merge，直接以「仅含该层已知键的新对象」整体替换——禁止对非对象值做 spread（字符串会展开成 `{0:'a',1:'b',…}` 索引键垃圾结构；number/boolean 时 spread 虽侥幸产出空对象，但依赖 spread 语义细节的安全不是设计出来的安全）。覆盖两个层级：`retry` 本身非对象 → 整体换成六键新对象；`retry.provider` 非对象 → 换成 `{timeoutMs?, maxRetries?, maxRetryDelayMs?}` 三键新对象。
- **被否**：整个 `retry` 对象替换写——今天六键恰好覆盖 pi 全部字段，但 pi 升级加子字段时（例如未来的 jitter 开关）xyz 写一次就静默抹掉一个用户配置，且无报错。
- **证据**：顶层 merge 的设计动机原文「分区……升级为 API 强制」（`pi-settings-store.ts:38-39`）；pi 曾做过 `retry.maxDelayMs → retry.provider.maxRetryDelayMs` 迁移（`settings-manager.js:239-255`），证明该对象 schema 会演化。
- **效果**：长期架构合理性（方案 A 表格首栏）成立的具体机制；pi 升级兼容性不依赖「恰好没人加字段」的运气。

**D4：GUI 位置 = System 页新 Section，数据路径独立于 SystemSettings（选定）**
- **采用**：新组件 `SystemLlmRetrySection.vue` 挂在 `SystemPage.vue` 末位；组件自带加载/保存状态（同 `TerminalPage.vue` 范式），**不**接入 System 页现有的 `:system` + `@update` patch 流。
- **被否**：① 独立导航项——设置菜单 12→13 项，而内容只有一组配置，导航膨胀不划算；② Provider 页——provider 页职责是 per-provider CRUD（凭证/模型清单），retry 是全局调用策略，混入会让人误以为可以 per-provider 配置（而 pi schema 不支持，见 out-of-scope）。
- **证据**：System 偏好走 renderer 侧 KVStorage 抽象（介质 localStorage、不经 runtime；`packages/core/src/domain/settings/system-storage.ts:3-8`——getSystem/updateSystem 经 PlatformPort.storage，renderer 壳注入 LocalStorageAdapter），retry 属 runtime 持久域，两条数据通路物理不同；TerminalPage 已示范「页面内自带 RPC 数据路径」的先例（`TerminalPage.vue:4`「数据层：config.getTerminalConfig / setTerminalConfig」）。
- **效果**：G1（可发现：System 页是杂项聚合页，用户找「调用设置」的自然位置）；同时不破坏 System 页既有数据的同构性。

**D5：字段暴露分级——基础三键 + 高级折叠区（选定）**
- **采用**：基础区暴露 `enabled`（开关）、`maxRetries`（数字，agent 层）、`baseDelayMs`（秒为单位的输入，内部存 ms）；高级折叠区默认收起，暴露 provider 层三键 `timeoutMs` / `maxRetries` / `maxRetryDelayMs`，并注明「与上层重试次数叠乘（总尝试 ≈ (1+本值)×(1+上层值)）」。`baseDelayMs` 的「预计最长等待」说明行随输入实时重算。
- **被否**：六键平铺一屏——provider 层三项默认值分别是「未设 / 0 / 60000」，普通用户既不需要也不该动（D 参数叠加爆炸）；全部藏进 JSON 文档——回到手编时代。
- **证据**：§2.4 失败模式 B/D；pi 默认值表（§2.2）。
- **效果**：G3 成立（后果可见 + 危险参数有认知门槛）；失败模式 D 的 GUI 侧缓解。

**D6：生效语义 = 静态提示「保存后对新会话生效」，不做热生效/重启编排（选定）**
- **采用**：保存成功 toast 与分组说明行固定标注生效范围；不做活跃会话清单比对，不做一键重启。
- **被否**：动态生效范围提示（列出哪些运行中会话仍用旧值）——需要 runtime 维护「会话 → settings 快照版本」映射，为一个提示引入跨模块状态；一键重启会话——侵入会话生命周期编排，属另一层需求。
- **已知能力登记（v1 不采用）**：pi rpc 暴露 `set_auto_retry` 命令（`rpc-mode.js:430-432` → `setAutoRetryEnabled` → pi 经自身 SettingsManager 把 `retry.enabled` 落盘，`settings-manager.js:584-590`），理论上可对运行中会话热切「自动重试」开关。v1 不采用的理由：仅覆盖 `enabled` 单字段（其余五键仍只有新会话生效，热切换造成「部分字段即时、部分字段新会话」的混合语义，比统一静态提示更难理解），且需要 runtime 维护「活跃会话 → rpc fan-out」编排。若未来要做热生效，应以此为基座整体设计，而非单点接入。
- **证据**：pi 每会话一进程（`rpc-client.ts:190`）+ SettingsManager 构造期加载、无 file watcher、rpc-entry 无 reload 命令（dist 编译 JS 已核实）；真实环境复核已完成——Gate B S6 探针 PASS，「运行中会话不受影响」成立（P1 消解，签收表见 impl-plan §7，commit 4de5a992c）。
- **效果**：G4 成立；守住减法原则（不造 pi 能力之外的机制）。

**D7：校验与容错——写入期范围校验 + 结构自愈，v1 不做 corrupted 横幅（选定）**
- **采用**：`setRetryConfig` 写入期校验（越界返回 `ok:false + error`，error 含字段名/合法范围/当前值，同 `setTerminalConfig` 错误信封范式）；`getRetryConfig` 把「字段缺省」合并为 pi 默认值后返回，并附 `configured` 标记供 GUI 区分「显式配置」与「未配置（显示默认）」——**`configured` 取值定义**：六个已知键中**任一**在文件 `retry` 域显式存在即为 `true`，全部缺省才为 `false`；**键存在但值不可用**（类型不符，如 `"maxRetries": "abc"`）仍计 `true`——`configured` 表达的是「文件里有显式配置意图」这一事实，坏值本身由 D3 替换规则与表单默认值显示承接（S7 含该状态断言：configured=true 且该键表单显示默认值，不构成「已配置徽标 + 全默认表单」的误导——徽标旁若该键为坏值合并，行内按存量超域值同款标注提示）。半配置状态——如本设计 motivation 里用户手工写入的仅 `provider.maxRetryDelayMs` 一键——按 `true` 处理，与其「文件里确实有显式配置」的事实一致。整文件级 JSON 损坏由 `PiSettingsStore` 既有 schema guard 兜底（回落 `{}` + warn 日志），GUI 侧不需要 terminal.json 那样的 corrupted 横幅。字段级坏值（如 `"retry": "abc"`、`"retry": {"provider": "abc"}`）被 D3 非 plain object 替换规则 + 保存自愈。
- **被否**：① GUI corrupted 横幅（terminal.json 有）——terminal.json 是 xyz 自有文件、损坏无人兜底所以需要横幅；settings.json 的损坏兜底已由 PiSettingsStore 承担，重复建设横幅需要给 store 加损坏探测 API，收益不抵改动面；② 读侧深度 schema 校验——pi 自己都用 `?.`/`??` 容忍坏值，xyz 读侧从严只会造出「pi 能跑但 GUI 报错」的新不一致。
- **证据**：`pi-settings-store.ts:114-119`（schema guard 回落 `{}`）；`terminal-config-helper.ts:41-77`（校验 + 错误信封范式）；pi 容错链 `settings-manager.js:581-596`。
- **效果**：§3.1 失败路径两条（越界、损坏自愈）成立。

**D8：数值合法域（设计期约定，实施期按此实现）**

| 字段 | 合法域 | 缺省显示值（pi 默认） | 理由 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | — |
| `maxRetries` | 整数 0–20 | `3` | 上限 20 挡手滑（100 次重试无意义），不挡真实需求 |
| `baseDelayMs` | 整数 0–600000 ms（GUI 输入单位秒，0–600） | `2000` | 单次退避上限 10 分钟；用户当前 5000 在域内 |
| `provider.timeoutMs` | 整数 1–600000 ms（GUI 输入单位秒，1–600）或未设 | 未设（跟随 httpIdleTimeoutMs） | **禁止 0**：「0 = 禁用超时」的 int32 映射只作用于全局 `httpIdleTimeoutMs`（`sdk.js:188-190`），本字段为 0 会原样透传成 0ms 立即超时（全部请求必失败）；「不超时」语义由全局 `httpIdleTimeoutMs: 0` 承担，不在本 GUI 范围 |
| `provider.maxRetries` | 整数 0–10 或未设（= 0） | `0` | 与 agent 层叠乘，上限收紧 |
| `provider.maxRetryDelayMs` | 整数 0（不限制）或 1000–3600000 | `60000` | 用户当前 1800000 在域内；下限 1000 防误输入 0（意为不限制）造成反直觉 |

**存量超域值语义（D8 补充）**：`getRetryConfig` 原样返回文件存量值（不静默改写为默认——那会掩盖「文件里生效的是 50 而非默认 3」的事实）；GUI 对超出上表的存量值在对应行标注「当前值 X 超出推荐范围，保存前需一并修正」；`setRetryConfig` 采用**全量校验**——合法域是 GUI 的写入契约，凡经 GUI 落盘的 retry 域永远在域内。用户只改一个字段但另一存量字段超域时，保存被拒且错误指向超域字段（错误信封含字段/范围/当前值，可操作）。

**全量校验的已知取舍（明示，不设条件豁免）**：`enabled=false` 时数值字段不参与运行时语义（pi `_prepareRetry` 先查 `enabled` 即返回，`agent-session.js`），此时「关开关」仍可能被无关的超域数值字段阻塞——这是本设计有意接受的摩擦，不做成「enabled=false 时数值校验降级为警示」：条件校验会产生「关开关能保存、开开关不能保存」的状态依赖行为，写入契约（凡 GUI 落盘永远域内）随之出现例外，契约解释成本高于省掉的一次改值。保留超域值的出口始终存在：**手编文件**——pi 域永远可手编且 pi 对域外值照常生效，GUI 不承载超域值，也不阻止用户手编。

**错误规格表**（runtime 侧统一回复，前端按信封展示）：

| 失败 | 触发条件 | 用户所见 | 恢复指引 |
|---|---|---|---|
| 校验失败 | setRetryConfig 入参越界（D8 表） | toast：`<字段名>超出范围(<min>-<max>)：<值>`，不落盘 | 按提示范围改值重存 |
| 锁超时 | updateSettingsFields 取锁 ~1s 预算耗尽（并发极值） | sendError `set_retry_config_failed` → toast「保存失败，请重试」 | 直接重试保存（锁预算远大于毫秒级临界区，重试即可） |
| 写盘失败 | 磁盘满 / 权限 | 同上 error envelope（含底层错误消息） | 检查磁盘/权限后重试 |
| 文件整体损坏 | settings.json 非 object | getRetryConfig 返回默认值合并结果（store warn 落日志），GUI 正常显示默认值 | 点一次保存即重写 retry 域（D7 自愈）；文件其他域损坏超本设计范围 |

### 3.4 接口与数据模型（下一层实现的直接依据）

**shared 类型**（`packages/shared`，与 `TerminalConfig` 同域）：

```ts
/** provider 层（单请求级）重试配置；undefined = 采纳 pi 默认语义 */
export interface LlmRetryProviderConfig {
  timeoutMs?: number         // 未设 = 跟随 httpIdleTimeoutMs
  maxRetries?: number        // 未设 = 0（不重试）
  maxRetryDelayMs?: number   // 未设 = 60000；0 = 不限制
}

export interface LlmRetryConfig {
  enabled: boolean
  maxRetries: number         // agent 层；pi 默认 3
  baseDelayMs: number        // pi 默认 2000
  provider?: LlmRetryProviderConfig
}
```

**WS RPC**（`settings-message-handler.ts`，照 `config.get/setTerminalConfig` 范式）：

| type | payload | reply / 副作用 |
|---|---|---|
| `config.getRetryConfig` | `{}` | reply `config.retryConfig` `{ config: LlmRetryConfig; configured: boolean }` |
| `config.setRetryConfig` | `{ config: LlmRetryConfig }` | 校验：失败 → `sendError set_retry_config_failed`；成功 → reply + broadcast `config.retryConfig`（多窗口同步，同 terminal 范式；payload 为请求 config 的回显——enabled 必落盘故 configured=true 恒准确，非文件重读快照） |

**runtime 内部分层**（D17 三层，services 不直接 import infra）：

- services 层新 port `ILlmRetrySettings`（`services/ports/` 下窄 port，同 `IExtensionSettings` 分域理由）：`getRetryConfig(): { config; configured }` / `setRetryConfig(config): { ok; error? }`。
- infra 层新模块 `infra/pi/pi-retry-settings.ts`：经 `pi-settings-store.updateSettingsFields('retry', …)` 实现读写 + D3 嵌套 merge + D8 校验（校验纯函数最终定在 shared `llm-retry.ts`，renderer 表单与 runtime 写侧共用同一域常量——U1 实施选型）。
- `ConfigService` 单行委托（同 terminal helper 挂载方式；新逻辑放独立 helper 文件，控 config-service max-lines 500）。

---

## §4 验收

> 全部场景使用真实依赖（真实 pi 子进程、真实 settings.json、真实网络错误），无 mock。每条标注回溯的 §1 目标。

**S1 调整退避参数并在真实失败中观察生效（G1/G2/G3，正向主路径）**
- 步骤：① 在 provider 页新建自定义 provider，baseUrl 指向本机已关闭端口（如 `http://127.0.0.1:9`，fetch 层网络错误，命中可重试模式）；② GUI 中设 `enabled=true, maxRetries=2, baseDelayMs=3000`，保存；③ 新建会话，把 model 切至步骤①创建的 provider，发送任意消息；④ 观察对话流与 `~/.xyz-agent/logs/pi-*.jsonl`。
- 通过标准：RetryIndicator 出现 2 轮，第 1 轮前等待 ≈3s、第 2 轮前 ≈6s（±1s 计时误差），随后错误落为 assistant 消息；`settings.json` 的 retry 字段为写入值。

**S2 关闭重试后失败直达（G1，负面行为——「不该重试就不重试」）**
- 步骤：延续 S1 环境，仅关闭「自动重试」开关保存；**新建会话**重发消息。
- 通过标准：不出现 RetryIndicator，错误 immediately 落为 assistant 消息；provider 层默认 `maxRetries=0` 不引入隐藏重试。

**S3 不可重试错误不受重试配置影响（G3，负面对照）**
- 步骤：S1 配置保持（`enabled=true, maxRetries=2`），把 provider 换成错误 apiKey（401，不在可重试模式）；新会话发消息。
- 通过标准：无重试直接失败——证明 GUI 暴露的开关不会让用户误以为「开了重试，什么错误都重试」。

**S4 与 pi 子进程写回并发互不覆盖（G2，锁协议真实场景）**
- 执行方式：xyz runtime 对 pi 子进程的 rpc 面无透传通道（`sendCommand` 为 rpc-client 内部方法，`rpc-client.ts:457`，封装面无 set_auto_retry；transport/services 零透传 case），故由**验收脚本自行 spawn 一个独立 pi 进程**指向同一隔离目录：`PI_CODING_AGENT_DIR=~/.xyz-agent/pi/agent pi --mode rpc` + stdin JSONL 发报文（**平铺形态**，与 `rpc-client.ts:466` 构造一致）：`{"id":1,"type":"set_auto_retry","enabled":false}`，reply 按 `id` 从 stdout JSONL 匹配。禁止嵌套式 `{"type":"set_auto_retry","params":{…}}`——pi 读 `command.enabled` 为 undefined 后嵌套 patch 会把 `enabled` 键**静默写没**（undefined 被 JSON.stringify 丢弃，无报错），现象与 merge 抹键 bug 难以区分。——这正是 xyz 自己 spawn pi 的既有机制（`rpc-client.ts:172`）；独立进程与 xyz 会话进程读写同一文件、走同一把 proper-lockfile 锁与同一 `persistScopedSettings` 键级 patch，锁协议不区分进程身份，并发语义等价。
- 步骤（两个确定性编排，pi 侧落盘是异步队列写 `settings-manager.js:139/:356`，rpc success reply 时未 flush，每步写后必须轮询文件出现期望值再进行下一步——到达确认，消除「写未到达导致假通过」；**轮询统一带 10s 超时**，pi 侧写失败被 writeQueue 吞掉只 recordError 不报错（`settings-manager.js:363-366`），超时即判定该编排失败并指向 `~/.xyz-agent/logs/pi-*.jsonl` 排查）：
  - 编排 A（pi 先、GUI 后）：脚本进程发 `set_auto_retry {enabled:false}` → 轮询文件 `retry.enabled === false` 出现 → GUI 保存 `{enabled:true, maxRetries:2, baseDelayMs:3000}`（xyz 侧锁内同步写，reply 即落盘）→ 检查文件。
  - 编排 B（GUI 先、pi 后）：GUI 保存同上 → 确认落盘 → 脚本进程发 `set_auto_retry {enabled:false}` → 轮询 `retry.enabled === false` 出现 → 检查文件。
- 通过标准（可判定断言，last-write-wins 从描述升级为断言）：
  - 编排 A：`enabled === true`（后写方 GUI）、`maxRetries/baseDelayMs` 等于 GUI 值、无索引键垃圾。
  - 编排 B：`enabled === false`（后写方 pi）、`maxRetries/baseDelayMs` **仍为 GUI 值**（验证 pi `persistScopedSettings` 键级 patch 不回滚 xyz 写入的五键）、无垃圾键。
- 判定力声明（登记）：本场景的判定不依赖两写是否在时间上重叠——锁协议正确性条件是「后写者锁内重读必然看到先写者的值」，顺序交错即可完全验证；「尽快相继发起」可作为压力加成另行执行，但非判定前提。

**S5 隔离体系不受影响（G2，边界）**
- 步骤：记录 `~/.pi/agent/settings.json`（独立 CLI 文件）全文哈希 → 完成 S1 的 GUI 保存 → 重新计算哈希。
- 通过标准：哈希不变——GUI 只写隔离目录，独立 pi CLI 配置零触碰。

**S6 生效范围探针（G4，⛔实施期门——设计断言的实施期复核）**
- 步骤：① 会话 A 进行中，GUI 将 `maxRetries` 改为 0 并保存；② 会话 A 再触发一次可重试失败；③ 新建会话 B 触发同样失败。
- 通过标准：A 仍按旧值重试（若探针发现 A 也变为 0 次，说明 pi 存在未知的 settings 热加载路径，D6 的静态提示文案必须改为「即时生效」并回写本文档）；B 立即失败不重试。

**S7 损坏自愈（D7/D3，失败路径）**
- 步骤：手编 `settings.json` 为 `"retry": "abc"`（顶层坏值）→ 打开 GUI（应显示 pi 默认值 + configured=false）→ 直接点保存（写入合法结构）→ 新会话触发可重试失败。补充用例：手编 `"retry": {"provider": "abc"}`（嵌套层坏值）→ 打开 GUI（provider 三键应显示默认/未设，其余键正常）→ 保存 → 检查文件。再补用例：手编 `"maxRetries": "abc"`（键在值坏）→ 打开 GUI → 检查 configured 标记与表单显示。
- 通过标准：前两用例保存后文件中 `retry`（含 `provider` 子对象）均为合法对象、无索引键垃圾；新会话重试行为符合保存值。第三用例：configured=true（键显式存在）、maxRetries 表单显示默认值 3（D7 坏值承接语义）。

**简化验证**（一句话级）：i18n 双语键完整（切 en-US 无裸 key）；多窗口场景保存后另一窗口分组状态经 broadcast 同步。

---

## §5 下一层拆分

**实施路径**：两阶段，每阶段可独立验证、独立回滚。

- **Phase 1（runtime 链路）**：U1 + U2。完成后可不经 GUI，用 ws 调试脚本调 `config.get/setRetryConfig` 验证读写与校验（对应 S1 步骤④的文件检查、S7 前半）。
- **Phase 2（GUI + 收尾）**：U3 + U4。完成后跑 §4 全场景。

**拆分清单**：

| 单元 | 内容 | 拆分理由 |
|---|---|---|
| U1 | shared 类型 `LlmRetryConfig` / `LlmRetryProviderConfig` + 协议消息类型 + D8 校验纯函数（放 shared 或 runtime helper，实施期定） | 纯函数零依赖，可独立单测；GUI 与 runtime 共用同一校验定义，避免两端范围漂移 |
| U2 | `SCOPE_FIELDS` + `'retry'`；infra `pi-retry-settings.ts`（读写 + D3 嵌套 merge）；services port + ConfigService 委托 + handler 两个 case | runtime 域内垂直切片，全部有 IExtensionSettings / terminal 同构先例；单独可验（Phase 1 出口） |
| U3 | `SystemLlmRetrySection.vue`（基础三键 + 高级折叠 + 等待预览行 + 保存/toast）+ `SystemPage.vue` 挂载 + `api/domains/config.ts` 转发 + i18n 双语 | UI 垂直切片，依赖 U2 的 RPC 契约但不动 runtime；独立可视验收 |
| U4 | 测试补齐（helper 校验单测 / scope merge 单测 / handler case 测试 / Section smoke）+ `docs/architecture/data-source-registry.md` 登记新字段域 + `pi-settings-store.ts:8` 模块头失准说法修正（P3 遗留）+ 本文档探针结论回写（S6） | 测试与文档登记是交付门槛而非功能；登记是项目纪律（新 settings 字段域必须登记跨进程文件登记表） |

**文件改动地图**：

| 文件 | 动作 |
|---|---|
| `packages/shared/src/protocol.ts`（或同域类型文件） | 新增 `LlmRetryConfig` 类型 + 3 个消息类型 |
| `packages/runtime/src/infra/pi/pi-settings-store.ts` | `SCOPE_FIELDS` 加 `retry: ['retry']`；`PiSettings` 接口加 `retry?: unknown`（透传类型） |
| `packages/runtime/src/infra/pi/pi-retry-settings.ts` | **新增**：读写 + 嵌套 merge + 校验 |
| `packages/runtime/src/services/ports/llm-retry-settings.ts` | **新增**：`ILlmRetrySettings` 窄 port |
| `packages/runtime/src/services/config-service.ts`（+ `llm-retry-config-helper.ts` 新增） | 单行委托；helper 承载逻辑（控 max-lines 500，先例 `terminal-config-helper.ts`） |
| `packages/runtime/src/transport/settings-message-handler.ts` | +2 case（get/set） |
| `packages/runtime/src/index.ts` | port→infra 注装（同 IExtensionSettings 模式，`:222`） |
| `packages/renderer/src/api/domains/config.ts` | +2 转发函数（先例 `:326` getTerminalConfig） |
| `packages/renderer/src/components/settings/system/SystemLlmRetrySection.vue` | **新增** |
| `packages/renderer/src/components/settings/system/SystemPage.vue` | +1 行挂载 |
| `packages/renderer/src/i18n/locales/{zh-CN,en-US}/settings.ts` | 新增分组/字段/提示键 |
| `docs/architecture/data-source-registry.md` | 登记 `retry` 字段域（管理方 xyz runtime，读写经 PiSettingsStore） |

**待验证检查点**（设计期无法确定，诚实标注）：

- **P1**：pi 是否真无 settings 热加载旁路（如 extension 触发 reload）——S6 探针在真实环境复核，结论回写 D6。（实施记录：Gate B 探针已执行，S6 PASS——P1 消解：运行中会话不受影响、新会话即时生效，D6 静态提示语义成立；签收表见 impl-plan §7，commit 4de5a992c）
- **P2（已消解，实施期 u2）**：「写后立刻读」一致性已由单测覆盖（pi-retry-settings.test.ts，锁内 invalidate + 重读语义验证通过）。
- **P3（已消解——第 2 轮审查修正）**：S4 步骤① 的「pi 子进程必然落盘」动作已锚定 rpc `set_auto_retry`（三个候选中唯一无条件落盘，`rpc-mode.js:430` + `agent-session.js:2342-2344`）；原候选 `set_model` / `set_thinking_level` 经核实为会话级切换不落盘（`options.persist` 条件性且 rpc 入口不传，`rpc-mode.js:367-374` / `:390` + `agent-session.js:1252-1261` / `:1358-1366`），从候选移除。遗留随 U4：`pi-settings-store.ts:8` 模块头「用户 GUI 切模型/切思考档位时 pi 落盘」的说法与 0.84.4 rpc 实装不符，随实施批修正该注释。（实施记录：注释已随 u2-runtime commit 修正）

## 变更历史

- 2026-08-31 设计交付（4 轮对抗式审查收敛 0 must-fix，见 llm-retry-settings.review.md；commit db569f2ef）。
- 2026-08-31 实施完成：u1-foundation（b1263dd0c，shared 契约）、u2-runtime（37b124164，store scope/infra/port/helper/handler + P3 注释修正）、u3-gui（08b348c15，Section/i18n/api；3 轮 fix：fmtDur 10 倍 bug、魔法数字、类型安全）；u4 登记完成（data-source-registry.md retry 域）。S1-S7 真实场景验收在 Gate B 执行。
- 2026-08-31 Gate B 双绿：S1-S7 全 PASS（签收表见 impl-plan §7）；P1 消解——运行中会话不受影响、新会话即时生效，D6 静态提示语义成立（commit 4de5a992c）。
