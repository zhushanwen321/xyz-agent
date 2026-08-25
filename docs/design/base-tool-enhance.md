# base-tool-enhance extension 技术设计

> 一句话结论：新增 `@zhushanwen/pi-base-tool-enhance` extension，同名 override pi 内置 bash 工具（前台行为委托 pi 官方工厂保持 100% 等价），增量实现 background 模式（强制白名单 + pending-notifications 完成通知 + 孤儿收殓兜底）与双模式可配置超时，随后整包废弃 unified-hooks。

- 层级声明：当前层 = extension 能力设计 → 下一层 = 可实现的接口 / 数据模型 / 技术方案（层敏感准则全适用）
- 状态：待评审
- 关联：废弃 [unified-hooks](../../../extensions/universal/unified-hooks/)；接入 [pending-notifications](../../../extensions/universal/pending-notifications/)

## 1. 背景目标

**S（情境）**：xyz-agent 的 AI agent 通过 pi 内置 bash 工具执行命令。该工具是同步语义：spawn 子进程，等命令退出才把输出返回给模型。

**C（冲突）**：vitest watch、dev server、全量测试这类长时命令会把整个 turn 卡死——模型在命令结束前什么都不能做；用户中断后工作全部作废。现有的 unified-hooks 扩展试图治理这个问题，但方式是「检测到网络/测试类命令且未设 timeout 时直接拒绝执行」，模型必须再花一轮往返补参数，而且两套正则和建议秒数全部硬编码，用户无法调整。

**Q（问题）**：长时命令为什么不能放到后台跑，让 agent 立即返回去干别的、完成后再收到通知？

**A（答案）**：新增 base-tool-enhance extension：bash 支持 background 模式、长时类命令走配置化白名单自动强制后台、前台/后台均可配置默认超时；unified-hooks 整包废弃，其拦截行为由新包以更优方式承接。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者可见标准 |
|---|------|--------------|
| G1 | 长时命令可后台化 | 模型发出长命令后**立即**收到 task_id 并能继续其他工作；任务完成后收到结果通知 |
| G2 | 长时命令无需模型自觉 | vitest 等白名单命令即使模型没主动要求后台，也自动进后台 |
| G3 | 超时可配置 | 前台/后台默认超时可通过配置文件调整；不填维持 pi 内置语义（不限时） |
| G4 | unified-hooks 退役 | 其网络/测试两类拦截行为由新包承接且可配置；无双重拦截 |
| G5 | 异常不泄漏进程 | pi 被强杀或崩溃后遗留的后台任务，在下次 session 启动时被自动收殓 |

### Scope

- **In**：bash 工具同名 override；background 生命周期（启动/查询/kill）；pending-notifications 接入；超时与白名单配置；孤儿 reap；unified-hooks 废弃迁移。
- **Out of scope**：read/write/edit/grep 等 override（包内留 per-tool 扩展位，本期不实现）；桌面端后台任务管理 UI；composer `!` 直执行 bash 管线改动（那是 runtime 侧另一条管线，与工具调用无关）；后台输出的实时流式 UI。

## 2. 现状与问题分析

### 2.1 pi 内置 bash 的真实行为（0.84.1 实装版核实）

内置 bash 工具入参 schema 只有两个字段：

```ts
{ command: string; timeout?: number }   // timeout 单位秒,可选,默认不限时,上限 int32 ms
```

执行链路（物理数据流，现状）：

```
LLM tool_call {command}
  │
  ├─ tool_call hooks（permission 审批、unified-hooks 拦截）──block 则终止,错误回灌 LLM
  ▼
bash.execute: spawn(sh -c "<command>", detached:true)   ← 子进程脱离父进程组
  │ stdout/stderr 经 pipe 回流 pi 进程内存累积
  ├─ LLM 未填 timeout → 无定时器,永远等
  ├─ LLM 填了 timeout → 到点 killProcessTree(pid) + 抛 "timeout:<n>"
  ├─ abort signal     → killProcessTree(pid)
  ▼
输出截断(末尾 2000 行 / 50KB),全量落 temp file,tool result 返回 LLM ← 同步阻塞到此结束
```

与进程收殓相关的既有机制（本设计的地基）：

- 每次 spawn 都把 shell pid 登记进 pi 进程内的 tracked 集合（`trackDetachedChildPid`，bash.js:70）；
- pi 收到 SIGTERM/SIGHUP 时先 `killTrackedDetachedChildren()` 杀光所有登记过的子进程再退出（rpc-mode.js:282-292）；
- **缺口**：runtime 强杀链 SIGTERM→2s 宽限→SIGKILL（rpc-client.ts:94,743）、Electron 崩溃、断电——这些场景 pi 来不及跑清理代码，detached 子进程被 init 收养，永久存活（占端口/句柄）。runtime 自身的孤儿回收（reap-orphan-pi.ts）只认 pi 自己的 argv 特征，不会碰 bash 孤儿。

### 2.2 要废弃的 unified-hooks 现状

真实交互例子（现状的失败模式）：

```
LLM: bash {command:"pnpm test"}
  → [network/test guard] block："请设置 timeout 参数（推荐 60-120s）"
LLM: bash {command:"pnpm test", timeout:120}      ← 白花一轮往返
  → 命令同步跑 120 秒,期间 turn 完全卡死;若测试要跑 10 分钟则到点被杀,前功尽弃
```

机制细节：`tool_call` hook 只拦 bash，正则匹配（network-timeout-guard.ts:15-25、test-timeout-guard.ts:17-60），命中且 `timeout == null` 即 `{block:true}`。**零配置键**——正则表和建议秒数全部硬编码在源码里。另有 tool-error-handler（出错时 appendEntry 审计，无阻断）。不在 mandatory 清单中，靠用户级安装加载。

失败模式汇总：

| # | 失败模式 | 根因 |
|---|---------|------|
| F1 | 长命令卡死整个 turn | bash 同步语义，无 background |
| F2 | block 往返浪费一轮对话 | unified-hooks 只能拒绝，不能代为改写执行方式 |
| F3 | 无法并行（边跑测试边改代码） | 同 F1 |
| F4 | 强杀/崩溃后 bash 孤儿泄漏 | tracked-pid 收殓只在 graceful shutdown 生效 |
| F5 | 拦截策略不可调 | 正则硬编码，无配置文件 |

### 2.3 关键术语

- **task_id**：一次后台任务的标识，形如 `bg-<seq>`，用于查询与 kill。
- **pid 注册表**：「task_id → OS pid」的持久化 JSON 文件，是孤儿收殓的依据（区别于 pi 进程内的 tracked Set——后者随进程死亡消失）。
- **强制白名单（force patterns）**：正则列表，命中的命令无论模型是否要求都进后台。
- **同名 override**：extension 以 `registerTool({name:"bash"})` 注册工具，pi 的工具注册表按 name 后注册者覆盖内置定义（agent-session.js `_refreshToolRegistry`，1940-1966 行）。第三方 pi-hashline-edit 已用同机制替换 read/grep/edit，路线已被实践验证。

## 3. 解决方案

### 3.1 终态（使用者视角）

成功路径——模型视角的完整交互：

```
LLM: bash {command:"pnpm test"}
  → （命中白名单,自动转后台）result:
     "Command force-routed to background (matched pattern 'test').
      task_id: bg-1  pid: 12345
      Output file: <dataDir>/base-tool-enhance/<session>/bg-1.log
      Poll with bash_output {task_id:'bg-1'} or omit task_id to list all tasks."
LLM: （继续干别的:读代码、改文件……turn 不被占用）
  → 数分钟后新 turn 注入通知:
     "[background-bash] bg-1 finished (exit 0, 3m12s): pnpm test
      Last lines: ... Tests: 42 passed ...
      Full output: <path>; use bash_output for details."
LLM: （需要细节时）bash_output {task_id:"bg-1"}  → tail 输出 + 截断标记 + 全量文件路径
```

失败路径与恢复指引：

| 场景 | 模型看到 | 恢复动作 |
|------|---------|---------|
| 后台任务 exit ≠ 0 | 通知带 error 与末尾输出摘要 | `bash_output` 查看完整输出定位原因 |
| 任务挂死需人工终止 | —（用户侧诉求） | 让模型 `bash_kill {task_id}`，或用户删 `<dataDir>/base-tool-enhance/<session>/registry.json` 中条目后重启 session 触发 reap |
| 并发后台数达上限 | bash 返回错误"max N concurrent, oldest: bg-x" | `bash_kill` 旧任务后重试 |
| 配置 JSON 写坏 | 工具照常工作（内置默认值），debug 日志 warn | 修复 `config/base-tool-enhance-ext-config.json`，读时刷新自动恢复 |
| kill 一个已死任务 | `{killed:false, reason:"already exited (code 0)"}` | 无需处理，状态即终态 |

用户视角变化：桌面对话流中后台任务的启动/完成以 custom entry 形式出现（复用现有 custom_message 通道，subagent-bg-notify 先例）；其余 UI 不变。

### 3.2 方案对比：如何获得前台 bash 能力

override 后工具的全部行为归新包负责，「前台模式怎么实现」是第一分叉点：

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|------|--------------|---------|------|
| **A. 完全自研 execute**（自己 spawn/截断/env/收殓） | 差：复刻 builtin 约 300 行核心逻辑，pi 升级时双向漂移，三个月后必然想骂人 | 高 | 截断规则、shellPath 设置、PI_* env、stdin commandTransport 等细节遗漏即行为回归 |
| **B. 同名 override + 前台委托 pi 官方工厂 + background 自研**（推荐） | 好：前台语义永远跟随 pi 版本升级；自有代码只包含真正的增量（background） | 中：需验证工厂函数委托路径 | 委托路径下 tracked-pid 收殓是否继承需实施期探针确认（见 §3.4 探针 P2） |
| **C. 纯 hook 改写 input，不 override 工具** | 差：hook 不能改变「execute 同步等到退出」的语义，background 根本做不出来 | 低（但不可行） | — |

**推荐 B**。pi 主入口公开导出 `createBashToolDefinition(cwd, options)` / `createLocalBashOperations()`（dist/index.d.ts:24），前台分支直接调用官方工厂拿 execute 实现。若用它，§2.2 的往返例子变成：模型发 `pnpm test` → 直接后台启动返回 task_id，零往返、turn 不占死。

### 3.3 关键决策与权衡

已拍板决策（本轮评审确定）：

| # | 决策 | 内容 |
|---|------|------|
| D1 | tier=infrastructure | bash 是核心工具，增强层不可禁用；进 mandatory-extensions.json infrastructure 组（builtin_cannot_disable 守卫生效） |
| D2 | 工具名保持 `bash` | 桌面侧 TRUNCATE_TOOLS/useToolMeta/block-icon/preset BUILTIN_TOOLS/permission extractCommand 六处硬编码 key 在 `'bash'`，改名导致审批退化为逐次弹窗 + 渲染失配；只扩 schema 加 `background?: boolean` |
| D3 | 白名单命中无视 `background` 参数 | 即使模型显式 `background:false` 也强制后台，result 中注明原因（pattern 命中） |
| D4 | 前台不填 timeout 维持不限时 | 与 pi 内置语义一致；网络类挂死风险由 D3 强制后台承接（后台有独立查询/kill 手段） |
| D5 | 完成通知复用 pending-notifications | emit `pending:register/unregister`（type 新增 `"bash"`）+ `pi.sendMessage({deliverAs:"steer", triggerTurn:true})` 驱动新 turn（subagent-workflow notifier.ts:10 先例）；goal 的「活跃后台任务时不发 continuation」守卫免费生效 |
| D6 | 后台不设总寿命上限 | 结束手段 = 自然退出或 `bash_kill`；配套：pending TTL 按 type 分档，`"bash"` 类型豁免 1 小时 TTL（否则长任务被判 expired，D5 守卫失效） |

本文档补充决策：

| # | 决策 | 选择 | 被否方案与理由 |
|---|------|------|--------------|
| D7 | 后台输出治理 | spawn 时 stdout/stderr 直接重定向到日志文件，查询时 tail 读文件 | 内存累积：长任务 OOM + pipe backpressure 会阻塞子进程写入；也不选「完成后一次性回传全量」——中间过程不可查 |
| D8 | 孤儿收殓 | pid 注册表持久化到 `<dataDir>/base-tool-enhance/<sessionId>/registry.json`，session 启动时 reaper 按 pid 死活判孤儿并补杀 | 仅靠 pi tracked Set：进程死亡即消失，兜不住 SIGKILL/崩溃；worktree-manager 已验证同范式（`.alive` 文件 + pid 死活 + SPAWN_GRACE 宽限防误杀），直接借鉴 |
| D9 | 查询/kill 接口形态 | 独立小工具 `bash_output`（task_id 可省略=list）与 `bash_kill`（必填 task_id） | 合并为单工具多 action：kill 与查询的权限语义不同，独立 schema 更清晰，LLM 误用率低；不复用 pending_notifications 工具——它是 infrastructure 通用设施，不应绑定 bash 输出语义 |
| D10 | 并发上限 | `maxConcurrentBackground` 默认 8，超出报错并列出最老任务 | 不设上限：模型失控循环开任务会耗尽资源 |
| D11 | unified-hooks 废弃方式 | 整包 deprecated（package.json deprecate + AGENTS.md 清单移除 + fixture 脚本弱引用清理），两个 guard 的正则迁入内置白名单，tool-error-handler 行为一并迁入 | 保留包只删 hook：残留安装会与新包双重拦截（两家都拦 bash），必须整包退场 |
| D12 | 后台任务生命周期出口 | **绑定 pi 进程，不绑定 session**：仅三个出口——自然退出 / `bash_kill` / pi 进程退出（dispose 或 SIGTERM graceful）；fork / switch / newSession 等 session 替换不影响任务运行 | 绑 session：pi 的 session_shutdown 在 fork/switch/new/reload 全部触发（agent-session-runtime.js:102-160 teardownCurrent 调用点），切一次 session 就误杀全部后台任务，直接推翻 G1，reaper 兜底也随之失去意义 |
| D13 | 强制后台时的 timeout 处置 | 命中白名单强转后台时**忽略 LLM 显式 timeout**，按「配置默认 → 不限」取值并在 result 注明 | 尊重显式值：模型在 unified-hooks 时代被训练出「跑测试带 timeout」习惯，`{pnpm test, timeout:120}` 会在 120s 被杀，精确复刻 §2.2 要解决的失败模式；白名单的存在意义正是「这类命令不该被时限约束」 |
| D14 | subagent 嵌套 | 子 agent 进程内本包**降级**：禁用强制白名单与 background 参数，保持内置同步语义；以 subagent 注入的环境标记识别（探针 P5） | 子 agent 内后台化会破坏 workflow 结构化输出契约（预算耗尽时测试未回）；且子进程死后其 registry 目录永远不会再有 session 启动，孤儿无人 reap |
| D15 | 用户中断与后台任务 | abort/interrupt 不传播到已提交的后台任务（execute 已立即返回，abort 仅作用于前台等待路径） | 有意为之；若联动取消，「提交后继续干别的」在中断场景全部作废，与 G1 矛盾 |

### 3.4 运行时断言与探针

涉及运行时行为的断言分三档：

**✅ 已核实（本设计的事实地基，实装版源码验证）**

| 断言 | 证据 |
|------|------|
| 同名 registerTool 覆盖内置工具 | agent-session.js `_refreshToolRegistry`:1940-1966，custom definition 后 set 覆盖 base |
| pi 导出前台工厂函数 | dist/index.d.ts:24 `createBashToolDefinition/createLocalBashOperations` 等 |
| 内置 timeout 单位秒、默认不限、超时 killProcessTree | bash.js:17-27、79-103 |
| detached spawn + SIGTERM 收殓 + SIGKILL 缺口 | bash.js:60,70、rpc-mode.js:279-293、rpc-client.ts:94,743 |
| pending TTL 硬编码 1h | state.ts:68 `PENDING_TTL_MS = 3_600_000` |
| sendMessage 驱动新 turn 先例 | notifier.ts:10 `deliverAs:"steer", triggerTurn:true` |

**⛔ 实施期探针门（探针不过则对应设计点回炉，禁止跳过）**

| # | 待验证断言 | 探针方法 | 不过时的回退 |
|---|-----------|---------|------------|
| P1 | tool_call hook 执行顺序中 permission 能看到本包对 input 的 mutation（`background:true` 注入等） | 最小双扩展打日志：A 包 mutate input，B 包打印所见 input；对照 loader 加载顺序 | 若 permission 先于本包执行：强制后台的「改写」移到 execute 入口（permission 审的是原始 command 字符串，字段追加不影响其 AST 解析，风险可控但须记录差异） |
| P2 | 前台委托 `createBashToolDefinition` 时，tracked-pid 登记与 SIGTERM 收殓仍生效 | 本包注册的 bash 跑 `sleep 300`，SIGTERM 杀 pi，`pgrep -f sleep` 验证子进程消失 | 不生效则在 background/前台统一走自管 pid 表 + session_shutdown 收殓（D8 机制扩大到前台） |
| P3 | 在 child exit 回调中调 `pi.sendMessage` 能安全驱动新 turn（execute 已返回后的时机） | 后台任务结束时观察 RPC 流出现新 turn 且消息入列正确。注意：subagent-workflow 的先例经父进程 IPC 委托 session-delivery 内核投递（notifier.ts:10-13），与本包同进程 exit 回调时机不同构，不可因先例存在而跳过本探针 | 降级为「仅 emit unregister entry，不主动 triggerTurn」，模型靠 pending_notifications 轮询（体验降档，功能不缺失） |
| P5 | subagent 子进程存在可编程识别的环境标记（供 D14 降级判断） | 读 subagent-workflow spawn 时的 env 注入（argv-mirror.ts / session-runner.ts），最小扩展打印 process.env 对照 | 无现成标记则在 argv-mirror 补一个 env（改动点单一）；未落地前 M2 对子进程同样生效并在文档标注风险 |
| P4 | extension 侧获取 sessionId/dataDir 的 API 形态（注册表路径推导依据） | 读 types.d.ts ExtensionContext 字段 + 最小扩展打印 | 无 session 粒度 API 则注册表按「pi 进程实例」粒度存放于 dataDir 固定名目录 |

### 3.5 接口规格

**bash 工具（override 后）input schema**：

```ts
{
  command: string;
  timeout?: number;       // 秒;语义不变(显式填了永远尊重)
  background?: boolean;   // 新增;缺省 false
}
```

timeout 解析优先级：LLM 显式值 > 配置文件默认值 > 不限时（前台）/ 不限（后台）。注入只发生在「LLM 未填 && 配置了默认」时。**唯一例外（D13）**：命中白名单强制后台时忽略 LLM 显式 timeout，按「配置默认 → 不限」取值并在 result 中注明。

**工具 description 重写**：registerTool 的 definition 含 description 字段，官方工厂返回的文案（bash.js:233）不含 background 用法。override 时必须重写 description：说明 background 参数语义、task_id / bash_output / bash_kill 配合方式、白名单自动转发行为——否则 LLM 无法发现新参数，「模型主动要求后台」的路径不可达。

**配置文件** `<dataDir>/config/base-tool-enhance-ext-config.json`（llm-shared `loadConfig` 读时刷新热重载范式，同 smart-context/permission）：

```jsonc
{
  "forceBackgroundPatterns": ["string"],  // 追加到内置白名单之后,匹配整条 command
  "disableBuiltinForcePatterns": false,    // true = 关闭内置 force-test/force-longrun 两组,只用用户正则
  "foregroundTimeoutSeconds": null,        // null = 不注入(D4);数字 = 前台未填 timeout 时的默认
  "backgroundTimeoutSeconds": null,        // null = 不注入;数字 = 后台未填时的默认
  "maxConcurrentBackground": 8
}
```

normalize 校验失败（类型错/负数）→ 该键回退默认 + logger.warn，**不整体拒载**（部分坏配置不拖垮可用性）。

**内置正则基线（三组，包内常量）**：

| 组 | 来源 | 示例 | 默认动作 |
|----|------|------|---------|
| force-test | 迁自 unified-hooks test-timeout-guard 正则（test-timeout-guard.ts:17-60） | npm/pnpm test、npx vitest/jest/playwright、pytest、go test、cargo test… | 强制后台（D3/D13） |
| force-longrun | 新增（unified-hooks 无此类） | dev server、`--watch`、`tail -f` 等长驻命令 | 强制后台 |
| suggest-timeout | 迁自 unified-hooks network-timeout-guard 正则（network-timeout-guard.ts:15-25） | install / curl / wget / git push / docker build… | 仅当配置了 foregroundTimeoutSeconds 时为未填 timeout 的命令注入推荐值；零配置不干预 |

配置开关 × 组的行为矩阵：

| 配置状态 | force-test | force-longrun | suggest-timeout |
|---------|-----------|---------------|-----------------|
| 零配置（默认） | 生效（强制后台） | 生效（强制后台） | 不干预（守 G3/D4：零配置 = 维持不限时） |
| `disableBuiltinForcePatterns: true` | 关闭 | 关闭 | 不受此开关影响（其动作只是替未填 timeout 补默认值，无强制语义；要彻底关闭则不配 foregroundTimeoutSeconds 即可） |
| 用户 `forceBackgroundPatterns` | 追加合并，匹配任一即强制后台 | 同左 | 不适用 |

**后台任务生命周期数据流**：

```
execute({command, background})
  │ ①白名单判定(命中 → 强制 background,D3)
  │ ②并发上限检查(满 → 报错返回最老 task_id)
  │ ③spawn sh -c cmd,detached,stdio→append 打开的 bg-<n>.log
  │ ④registry.json 写入 {task_id,pid,command,outputFile,startedAt,state:running}
  │ ⑤emit pending:register {id:task_id,type:"bash",name:command 前 80 字符}
  ▼ 立即 return(task_id/pid/log 路径/使用提示)
child exit(异步)
  │ ⑥组装 {exitCode,duration,tail 摘要}
  │ ⑦registry 终态(exited,保留供 bash_output 查询,LRU 上限 50 条)
  │ ⑧emit pending:unregister {id,result|error}
  │ ⑨pi.sendMessage({deliverAs:"steer",triggerTurn:true}, 完成通知文案)   ← 探针 P3
  ▼
pi 进程退出（dispose / SIGTERM graceful）→ 遍历 registry 活跃条目 killProcessTree
  （fork / switch / newSession 不触发收殓——D12：任务绑定进程，不随 session 替换终止）
pi 被强杀/崩溃 → 任意后续 session 启动时 reaper 扫 <dataDir>/base-tool-enhance/ 全部
  <sessionId>/ 目录（含 subagent 子进程残留），pid 死活判定 → 存活者补杀 + 标记 orphaned；
  多 pi 进程并发由 extensions/shared/file-lock 串行化
```

**pending-notifications 接入细则**（M3 实际改动面，较「TTL 小改」扩大——审查 MF-3）：

1. type 注册：`PendingType` 增加 `"bash"`（state.ts:18）；index.ts:282 的归一化逻辑（非 `"subagent"` 一律归 `"workflow"`）需为 `"bash"` 开直通行；查询工具 description（index.ts:244）同步提及 bash 类型。
2. TTL 豁免实现点：**写入侧**——register 时 `"bash"` 类型不计算 expiresAt；rebuildFromEntries 的过期判定（state.ts:229）对无 expiresAt 条目天然跳过，不改读取侧。
3. shutdown 语义：pending-notifications 在 session_shutdown 将 active 一律标 cancelled 并补 unregister entry（index.ts:226-237）。`"bash"` 类型**跳过该标注**（任务跨 session 替换继续运行，D12），否则 goal 守卫读到 cancelled entry 会误判「无活跃任务」。
4. 已知限制（诚实登记）：goal 的 continuation 守卫基于本 session 的 entries 差集（goal/src/adapters/event-handlers/agent-end.ts:177），后台任务跨 session 替换后新 session 的 goal 看不到它——守卫仅覆盖「同 session 内发起并等待」场景，跨 session 场景靠完成通知本身驱动。

**bash_output**：`{task_id?}` → 省略时 list 全部任务（含 running/exited/orphaned）；指定时返回 `{state, exitCode?, durationMs?, output(tail 2000 行/50KB 截断,同内置规则), outputFile, truncated}`。

**bash_kill**：`{task_id}` → `{killed:boolean, reason}`；实现 = killProcessTree（Windows 走 taskkill /F /T，与 pi 同款跨平台分支）。

### 3.6 错误规格

| 错误 | 触发 | 模型看到的恢复指引 |
|------|------|------------------|
| 并发上限满 | ② 检查 | 「oldest task bg-x (cmd…)，kill it or wait」 |
| spawn 失败（cwd 不存在/shell 缺失） | ③ | 沿用内置文案风格，指出 cwd 校验失败原因 |
| config 解析失败 | 任一次读取 | 工具按默认值继续工作；warn 落 debug 日志指向配置文件路径 |
| output 文件被外力删除后查询 | bash_output | 返回 `{output:"<lost>", state}` 不崩溃 |
| kill 目标不存在 | bash_kill | `{killed:false, reason:"no such task", hint:"use bash_output to list"}` |
| reaper 误判防御 | pid 被系统复用 | 判活时校验进程 start time（/proc 或 ps），不匹配视为已死不误杀无辜新进程；无法取 start time 的平台保守跳过（宁延迟勿误杀，同 worktree-manager 原则） |

## 4. 验收（真实场景）

实施完成后的真实验证，每场景标注回溯目标。环境基准：本地 pi CLI 实测（extension 改动的 MANDATORY 通道，非 xyz-agent 桌面直测）+ 桌面 dev 模式集成验证。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 测试命令自动后台 + 完成通知 | 在含 vitest 的项目装好扩展，prompt「跑一下这个项目的测试」，期间追问一个无关问题。**变体**：prompt 明确发 `pnpm test` 且自带 `timeout:120` → 应仍进后台且不被 120s 杀（D13） | ①首轮回立即含 task_id（未被测试占死）②追问正常回答 ③测试结束后新 turn 收到 exit code 与结果摘要 ④对话流重开后仍可见该通知 ⑤变体中任务跑过 120s 仍存活 | G1 G2 D13 |
| S2 | 后台 dev server 全生命周期 | prompt「后台起 dev server，然后告诉我端口通没通」 | ①curl 验证由模型在前台完成（证明并行）②`bash_output` 能看到持续输出 ③`bash_kill` 后 `lsof -i:<port>` 确认释放 | G1 |
| S3 | 超时配置双模式 | 配置 `foregroundTimeoutSeconds:10` 跑 `sleep 30`（前台）→ 10s 报 timeout；改配 `backgroundTimeoutSeconds:15` 跑后台 `sleep 60` → 15s 终止且通知注明；删掉两项配置重跑均不受限 | 各分支行为与 §3.5 优先级一致；热重载生效（不重启 session） | G3 |
| S4 | unified-hooks 平滑退役 | 卸载 unified-hooks、安装本包后重复 S1；另验 `disableBuiltinForcePatterns:true` + 用户自定义正则 `["sleep \\d+"]` → `sleep 999` 自动后台；触发一次工具报错看审计 entry | 行为等效且无双重拦截日志；配置正则即时生效；审计 entry 由新包产生（tool-error-handler 迁移到位） | G4 D11 |
| S5 | 孤儿收殓 | 起 background `sleep 3600` → `kill -9 <pi_pid>` → 确认 sleep 仍存活（复现缺口）→ 重启 session（桌面端用 new-session 形态，非 resume 同一 session） | reaper 扫描到孤儿目录并补杀；`pgrep -f "sleep 3600"` 为空 | G5 |
| S6 | infrastructure 打包集成 | xyz-agent `pnpm dev` 桌面端跑 S1 全流程；尝试禁用该 builtin | 对话流出现后台任务 entry；禁用请求被 `builtin_cannot_disable` 守卫拒绝 | D1 D2 |
| S7 | permission 协同 | strict/approve 模式下发后台危险命令 | 照常弹审批；批准后实际执行形态与审批内容一致（探针 P1 结论落地） | P1 |
| S8 | session 替换不误杀 | 起 background dev server → 桌面端新建 session / fork 当前 session → 在新 session 中 `bash_output` 查询 | 任务进程仍存活（端口仍在）；新 session 能列出并查询该任务（D12） | G1 D12 |
| S9 | subagent 嵌套降级 | 经 subagent-workflow 派子 agent 跑测试套件 | 子 agent 内 bash 保持同步语义（无强制后台）；主 agent 白名单照常生效（探针 P5 结论落地） | D14 |

单测另按 TEST-STRATEGY 三视角编写（fake timers 测 timeout 分支、真实 spawn 测生命周期），但不替代上表。

## 5. 下一层拆分

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| M1 包骨架 + 前台等价 | 包结构（universal 组模板）、8 步登记清单（mandatory-extensions.json / extension-dependencies.json / AGENTS.md 列举等）、registerTool 同名覆盖跑通、前台委托官方工厂、description 重写（S-1） | 先证明「替换后一切照旧」是后续所有增量的安全网 | M1 后跑任意前台命令与 builtin 行为一致 + 探针 P2 |
| M2 background 核心 | spawn 落盘、registry.json、exit 监听、bash_output/bash_kill、并发上限、subagent 环境降级分支（D14，探针 P5） | 功能主体，不依赖通知即可独立工作（轮询可用） | S2 S9 |
| M3 通知接入 | pending-notifications 三项改动：type 注册 / TTL 写入侧豁免 / shutdown cancelled 豁免（见 §3.5 接入细则）+ emit register/unregister + sendMessage steer（探针 P3） | 依赖 M2 的生命周期事件；对 infrastructure 包的三处改动需独立评审 | S1 的 ③④ + 探针 P3 |
| M4 配置体系 | llm-shared 范式配置读写、normalize、三组白名单矩阵与 timeout 注入逻辑（§3.5）、热重载 | 纯增量策略层，接口稳定后可并行开发 | S3 S4 |
| M5 孤儿 reap | 注册表持久化完善、reaper 扫全目录 + file-lock 串行化、start-time 防误判 | 兜底机制，依赖 M2 的 registry 结构定稿；扫全目录覆盖 subagent 残留（MF-4/S-3） | S5 + 探针 P4 |
| M6 unified-hooks 废弃 | package deprecate、AGENTS.md/mandatory 相关文档清理、fixture 脚本弱引用清理、README 归档注记；确认 tool-error-handler 审计行为已由新包承接后才摘除旧包 | 必须最后做（M4 白名单上线后才可摘除旧拦截） | S4 |

待验证检查点（进入 M1 前允许未知，M1 期内必须关闭）：P1–P5。

## 附：本次分析的关键事实源

- pi 实装版：node_modules/@earendil-works/pi-coding-agent/dist/{core/tools/bash.js, core/extensions/types.d.ts, modes/rpc/rpc-mode.js, index.d.ts}
- unified-hooks：extensions/universal/unified-hooks/src/hooks/{network,test}-timeout-guard.ts
- pending-notifications：extensions/universal/pending-notifications/src/{index,state}.ts
- 通知先例：extensions/universal/subagent-workflow/src/execution/notifier.ts
- 收殓先例：extensions/universal/subagent-workflow/src/execution/worktree-manager.ts
- 桌面耦合：packages/runtime/src/infra/pi/{rpc-client,process-manager}.ts、packages/core/src/domain/chat/{truncate-tool-output,timers}.ts、packages/shared/src/pi-preset.ts
