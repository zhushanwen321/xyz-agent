# 架构完整性加固：跨进程写治理、进程生命周期自愈与安全不变量机制化

> **一句话结论**：2026-08-20 六维架构审查发现的 10 个 major 的病根是两条元模式——「跨进程共享文件无锁双写」与「护栏只存在于注释/文档/本地 pre-commit」。本设计把 data-source-governance 的治理结构推广到这两个盲区：跨进程文件写收敛为「同一把锁 + 字段域 merge + 损坏隔离」协议（auth.json 是已验证范本），进程死亡收敛为「检测即销毁 + 孤儿收殓」自愈闭环，安全与打包不变量从纪律升级为「运行时守卫 + CI 机器检查」双层护栏。

> **层声明**：本文档是**技术方案设计**（当前层 = 10 个 major 的问题诊断 + 终态架构 + 接口级方案，下一层 = 可实施的分波计划 W0-W5）。层敏感准则 5/6/7（物理数据流 / 错误恢复 / 运行时断言探针）全适用。本设计不含实现编码。
>
> **溯源**：问题清单来自 2026-08-20 六维只读架构审查（配置数据真相 / 进程生命周期 / 持久化 / extension 层 / Electron 边界 / renderer 架构六个 subagent，全部 finding 带 file:line 证据）。本文引用的代码事实除标注 ⛔（实施期门，编码前必须先跑探针）外均已读源码核实。
>
> **与 data-source-governance 的关系**：续篇。前篇治理「GUI 数据多源」，确立了绝对写规则（xyz 永不写 pi 持有的 session JSONL）；本篇把同一条规则的精神推广到 session JSONL **之外**的跨进程共享文件，并补上前篇未覆盖的两个维度（进程生命周期收敛、Electron 安全不变量）。治理结构（登记表 + 双层护栏）复用前篇模式。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent 是三进程桌面 AI Agent 工作台：renderer（Vue3）↔ WebSocket ↔ runtime（Node，管理 pi 子进程生命周期）↔ stdio RPC ↔ pi 子进程（每 session 一个）。此外 Electron main 进程负责窗口/更新/runtime 监护。多个进程与多个 pi 扩展会读写**同一批磁盘文件**（settings.json、worktrees.json、扩展 config）。
- **C（冲突）**：2026-08-20 六维架构审查发现 10 个 major：`settings.json` 被 pi（持锁字段级写）与 xyz runtime（无锁全量覆盖写）双写，且 pi 侧写入非原子，两个方向都会静默丢配置；Electron 打包态 local-file:// 白名单塌缩为全盘、导航拦截/CSP/单实例锁缺失；pi「半死」后 session 陷入 60s 超时死循环；runtime 崩溃后孤儿 pi 进程无人回收；worktree 注册表跨进程丢条目且注释声称的对账兜底无代码；pi 死后挂起弹窗双端不清理。
- **Q（问题）**：如何全量修复这 10 个 major，并建立机制使同类问题（新的无锁双写文件、新的无收殓死亡路径、新的纯纪律护栏）不再出现？
- **A（答案）**：三支柱——① 跨进程文件写治理：凡多进程写的文件必须有登记在案的锁协议（与写方对齐同一把锁）+ 字段域 merge + 损坏隔离；② 生命周期自愈：凡「检测到进程死亡/卡死」的路径必须走到销毁与收敛（与 pi 崩溃路径同构），孤儿由新 runtime 启动收殓兜底；③ 护栏机制化：安全/打包不变量从注释与 pre-commit 单点升级为运行时守卫 + CI invariants 双层。

### 系统是什么（受众：会用 xyz-agent 但不熟内部的开发者）

xyz-agent 用户在 GUI 里与 LLM 对话（pi 子进程执行，每个 session 一个进程）；在 Settings 页管理 provider/model/扩展；可并发开多个 session（split pane），每个 session 可派 subagent（subagent 在独立 git worktree 里跑，由 `subagent-workflow` pi 扩展管理）。配置体系三块：

- `~/.xyz-agent/pi/agent/settings.json`（下称 **settings.json**）——pi 的全局设置：默认模型、enabledModels、skills 路径、已装扩展 `packages[]`。**pi 子进程运行期会写它**（用户在 GUI 切模型/切思考档位时，pi 经自身 SettingsManager 持 proper-lockfile 落盘）；**xyz runtime 也写它**（Settings 页改 provider/装扩展时，经 `pi-settings-store` 全量覆盖写）。这正是双写的两端。
- `~/.xyz-agent/pi/agent/models.json`——provider 定义，xyz 单写（pi 只读），健康。
- `<piAgentDir>/subagents/worktrees.json`——subagent worktree 注册表，**每个活跃 pi 进程一份扩展实例都可能写**（last-write-wins）。

死亡路径背景：pi 死（崩溃/被 kill）有五步收敛（exit → rejectAll → onSessionExit → 广播 session.exited → 清理）；但「pi 半死」（事件循环卡死、进程不退）只有 ping 检测 + abort 收口，**没有销毁**；「runtime 死」由 Electron supervisor 重启，但**不清理旧 runtime 留下的 pi 后代**。

### 关键术语（首次定义，全文通用）

- **跨进程共享文件**：≥2 个进程都会写的磁盘文件。本文的治理对象。判定与协议登记在「跨进程文件登记表」（§3.8，落位 `data-source-registry.md` 新增章节）。对照：`auth.json` 是**已修对的范本**——xyz 与 pi 共用同一把 proper-lockfile 锁（`packages/runtime/src/services/auth/auth-storage.ts:42-74`）。
- **字段域 merge**：锁内读最新文件 → 只修改调用方声明负责的字段域（如 model 域只动 `defaultModel`/`enabledModels`）→ 写回。与「全量覆盖」相对——全量覆盖会把锁内读到的其他进程旧值一并写回，丢掉并发方的修改。pi 侧 `SettingsManager.persistScopedSettings` 的 modifiedFields 语义即此（pi 源码 settings-manager.ts，enqueueWrite + withLock 只 merge 修改字段，✅审查期已读源核实）。
- **损坏隔离（quarantine）**：JSON 读取 parse 失败时，把损坏文件 rename 为 `<path>.corrupt-<ts>` 保留取证、以默认值继续，并落 error 级日志带恢复指引。与「静默回退默认值」相对——后者会让下一次写把「半截文件」合法化为「全空文件」。
- **收殓（reap）**：新 runtime 启动时扫描并清理**不属于自己**的残留 pi 进程。孤儿判据（终态，W3 定案）= argv 判据（`--mode rpc` + `--session-dir` 值精确等于本实例 sessions 目录）+ `ppid===1`（reparent 证据，原父 runtime 已死）。设计期原判据（进程 env 含本数据目录的 `PI_CODING_AGENT_DIR`）已被 W3 探针否决（macOS SIP 拿不到他进程 env），终态判据见 §3.4 D4a/D4b。
- **对账（reconcile）**：注册表与物理事实（git 分支、tmpdir 目录）双向 diff，清理注册表缺失但物理存在的孤儿资源。与「只信注册表」相对。
- **机制化护栏**：不变量由机器强制（运行时守卫代码 / CI 检查 / 单元级断言），违规在编码期或 CI 期被拦截。与「纪律护栏」（注释、文档、review checklist）相对。

### 设计目标（从使用者体验倒推）

- **G1（配置不丢）**：用户切模型、装扩展、改 provider 交叉进行后，重启 xyz-agent 一切配置仍在；即使 pi 崩溃在写 settings.json 的半路，用户配置也**可恢复**（.corrupt 副本 + 明确日志），而非静默清空。
- **G2（打包态安全不变量真实成立）**：打包版里 renderer 被注入恶意代码也无法读 `~/.ssh`、无法把主窗口导航到远程页面接管 electronAPI、无法与第二实例并发操作数据目录。
- **G3（pi 异常自动恢复）**：pi 崩溃或卡死后，用户最多重发一条消息即可继续（自动 restore），不需要删 session 或重启 app；绝不陷入「每次发消息等 60s 超时」的死循环。**例外边界（S5 真机实测发现，2026-08-20）**：全新 session 的首个 turn 进行中被冻结时，pi 尚未 flush session 文件（延迟写入规则），强杀后重发返回 SESSION_NOT_FOUND——「重发即可恢复」该边界不成立，需新建 session（见 D3a/S5 的边界登记）。
- **G4（无烧钱孤儿）**：runtime 崩溃重启后，旧 runtime 留下的 pi 进程在秒级被回收，不残留烧 token 的进程。
- **G5（无磁盘泄漏）**：多 session 并发跑 subagent 后，`git branch --list 'pi-sub-*'` 为空、tmpdir 无残留 checkout 目录；进程异常退出后泄漏在下一个 session_start 被对账清理。
- **G6（弹窗不撒谎）**：pi 死亡后，挂起的 ask-user/permission 弹窗不再重弹误导用户；若重弹，作答有明确反馈而非静默失效。
- **G7（护栏机制化）**：开发者改坏不变量（runtime 引入 import.meta.url、白名单放行全盘、新增跨进程文件不登记）会在 CI/测试期被拦；新 session 按文档索引能找到现行架构 SSOT，不被已废弃落位误导。

### Scope

- **In-scope**：10 个 major 的终态方案与接口级设计；同根因 minor 的搭车修复（ext-config 双写、segments.json 损坏固化、quota-cache 失效、ModelService 冗余写）；跨进程文件登记表 + CI invariants 的护栏机制。
- **Out-of-scope**：修改 pi 源码（铁律，pi 没有的能力由 xyz 自实现）；12 类 GUI 数据多源（前篇已闭环）；其余 ~25 个 minor（非同根因，另行 backlog，见附录 B）；实现编码（下一层 W0-W5）。

---

## §2 现状与问题分析

**结论：10 个 major 是症状，两条元模式是根因。逐个修 major 而不治元模式，同类问题会再长出来——正如 12 类 GUI 数据当年逐点修了 #12 的时序坑，#1-#11 又各自踩一遍（前篇 §2.4 的教训）。**

### 2.1 使用者视角的真实失败模式

**失败模式 A（静默丢配置，M1）**：用户流式对话中切思考档位，同时（或其后毫秒-秒级内）在 Settings 页保存 provider。pi 的写入走异步队列（事件循环忙时可延迟秒级），xyz 的写入是「invalidate → 读 → 全量覆盖」。两写交错时后写方基于旧快照覆盖 → pi 写入的 `defaultThinkingLevel` 或 xyz 写入的 `packages[]`/`enabledModels` 丢失。更糟的链路：pi 崩溃在 `writeFileSync` 半路（pi 原地写、非 tmp+rename）→ 磁盘留半截 settings.json → xyz 侧任意写操作 parse 失败拿默认值（`packages/runtime/src/utils/json-store.ts:117-122` 仅 console.warn）→ 写回 → **用户全部设置被静默清空且产物是合法 JSON**，重启后已装扩展消失，无任何报错。触发面：GUI 每次切模型都双写一次（`packages/runtime/src/services/model-service.ts:85-104`：先 `sessionService.switchModel`（pi 写）再 `configService.setDefaultModel`（xyz 写），✅已核实）。

**失败模式 B（打包态全盘可读，M2）**：macOS 打包版从 Finder/Dock 启动时进程 cwd 是 `/`。local-file:// 白名单含 `process.cwd()`（`apps/electron/main/main.ts:231-238`，✅已核实），前缀匹配 `resolved.startsWith('/')` 对任意绝对路径恒真——注释里「绝不放行 ~ 本身（含 ~/.ssh）」的 [HISTORICAL] 不变量被运行时环境击穿。renderer 一旦有 XSS，可探测任意文件存在性、加载任意图片。

**失败模式 C（一次性注入升级为持久接管，M3）**：全仓无 will-navigate 拦截、无 setWindowOpenHandler、无 CSP（审查期 rg 零命中）。XSS 执行 `window.location = 'https://evil.com'` → 主窗口整页导航 → preload 对新页面重新注入 electronAPI → 攻击页拿到 runtime token/port → 连本机 WS → 经 pi bash 执行任意命令并持久驻留。

**失败模式 D（双开卡死，M4）**：无 `requestSingleInstanceLock`（全仓零命中）。用户双击两次图标 → 两个实例并发 spawn runtime、并发读写同一 `~/.xyz-agent/` → 命中「session 文件 EEXIST 永久卡死」历史事故区（AGENTS.md 规则 6 [HISTORICAL]）。

**失败模式 E（半死死循环，M5）**：pi 事件循环卡死（native 模块/同步 IO）。180s 后 ping 3 连败、runtime 已**判定进程真死**（`packages/runtime/src/services/session/event-interpreter.ts` 注释自述判定语义），但处置只有 abort 收口（`message-dispatcher.ts:190-219`）——对卡死进程的 RPC 必然 60s 超时，catch 分支只置 isGenerating=false + 广播 error，**不销毁不重建**。processes Map 条目保留 → 用户每次再发消息都命中同一卡死 client → 60s 超时 → 报错 → 循环。唯一恢复 = 删 session（丢历史）或重启 app。

**失败模式 F（孤儿烧钱，M6）**：runtime 被 SIGKILL/OOM。supervisor 重启新 runtime（`apps/electron/main/supervisor/runtime-supervisor.ts:260-281`），但**不清理旧 runtime 的 pi 后代**——主动 stop 路径的进程树清理需要进程活着才能预记录后代 PID，崩溃场景天然失效。收敛唯一押注 pi 的 stdin-EOF 自杀链，而该链自身有两个挂起点：`runtimeHost.dispose()` 的 handler 串行 await 无超时（扩展异步落盘遇慢盘可挂）；stdin-EOF 路径的 `flushRawStdout` 遇 EPIPE 直接 throw 跳过后续 `process.exit`（pi 源码 rpc-mode.ts，✅审查期已读核实）。挂住的 pi 继续持有 API key、长 turn 继续烧 token，且重启 app 也不会清它。

**失败模式 G（worktree 永久泄漏，M7）**：两个 session 并发派 subagent。两份扩展实例对 `worktrees.json` 各自 load→改→save，交错时后写方覆盖前写方 → 条目丢失。丢失条目对应的 subagent 进程若再崩溃，reaper（只遍历注册表）**永远看不到它**——注释声称的「丢失条目靠 OS tmpdir + 分支对账兜底」（`extensions/subagent-workflow/src/execution/worktree-registry.ts:17`，✅已核实注释原文）在代码里不存在（全仓无 `branch --list`/tmpdir 对账）。孤儿 worktree 目录 + `pi-sub-*` 分支永久泄漏。

**失败模式 H（幽灵弹窗，M8）**：ask-user 弹窗挂起时 pi 崩溃。runtime 侧 `extensionTimeoutMgr.pendingRequests` 只在 session **删除**分支清理（`session-message-handler.ts` 仅有的调用点），pi 意外退出的收敛链不触碰它；renderer 侧 `session.exited` 也不清 extensionUIStore 分区。用户切走再切回（restore 起新 pi）→ 旧请求重弹 → 作答发给新进程 → `pendingExtensionRequests` 无此 id → **静默丢弃**，用户无任何反馈。

**失败模式 I（开发者被误导，M9/M10）**：AGENTS.md 文档索引把「七层目标架构」指向已被 `renderer-rebuild-architecture.md`（现行 SSOT，以包为层）取代的旧落位文档；新 session 按索引导航会把代码放错包、绕过五包链约束。仓库根 `chat-app/` 是未跟踪的 React 一次性原型（dummy echo、不可编译、2026-08-20 00:30 由并行会话产生），已是全仓 lint 唯一 error 源，且无任何定位声明——对后续 session 是「看起来像正式项目」的诱导。

### 2.2 十个 major 与两条元模式的映射

| # | major | 失败模式 | 元模式 |
|---|-------|---------|--------|
| M1 | settings.json 跨进程双写 + JsonStore 损坏固化 | A | ① 无锁双写 |
| M2 | local-file:// 白名单打包态塌缩全盘 | B | ② 注释不变量无运行时守卫 |
| M3 | will-navigate / setWindowOpenHandler / CSP 全缺 | C | ② 安全默认靠纪律 |
| M4 | 无单实例锁 | D | ② 平台契约靠假设 |
| M5 | pi 半死不销毁 | E | ② 检测≠收敛（处置半途） |
| M6 | runtime 崩溃孤儿 pi 无收殓 | F | ② 兜底靠对端自觉（自杀链） |
| M7 | worktree 注册表丢条目 + 对账缺失 | G | ① 无锁双写 + ② 注释声称无代码 |
| M8 | 挂起 UI 请求双端不清理 | H | ② 收敛点不汇聚 |
| M9 | chat-app 未声明孤岛 | I | ② 无声明无护栏 |
| M10 | 架构文档导航失真 | I | ② 文档护栏失效 |

### 2.3 根因分析

**元模式 ①「跨进程共享文件无锁双写」**：data-source-governance 的绝对写规则解决了最危险的一类（xyz 直写 pi 持有的 session JSONL），但规则边界停在 session JSONL。其余跨进程共享文件（settings.json、worktrees.json、ext-config.json 家族）没有登记、没有锁协议、没有「第二写入者出现时报警」的机制。讽刺的是仓库里已有修对范本：`auth-storage.ts` 文件头明言跨进程锁的必要性与参数对齐——这个知识没有泛化成规则。

**元模式 ②「护栏存在于注释/文档/纪律，而非运行时/CI」**：M2 的白名单不变量写在 [HISTORICAL] 注释里被 cwd 击穿；M7 的对账兜底写在注释里无代码；M3 的安全三件套从未存在；ENV 白名单/路径白名单/import.meta 禁令等检查单点挂在本地 pre-commit（ci.yml 无等价 job，`--no-verify` 或未装 hooks 即绕过）；M5/M6/M8 是「检测有了、收敛没走完」的半途处置。共同点：**正确性依赖每个参与者记得且愿意遵守，而机制不依赖记忆**。

### 2.4 物理数据流：settings.json 的双写窗口（磁盘级）

```
用户操作                进程内                         磁盘 (~/.xyz-agent/pi/agent/settings.json)
─────────────────────────────────────────────────────────────────────────────
GUI 切模型 ──RPC──▶ pi: setModel → SettingsManager
                      enqueueWrite(异步队列, 流式忙时可延迟秒级)     [文件不变]
                        └─flush 时: lockSync(锁) → 读 → merge 修改字段
                                     → writeFileSync 原地写(非原子!) ──▶ ✏️ 写入点 P1
Settings 页保存 ──WS──▶ xyz runtime: configService → pi-settings-store
                      updateSettingsSync:                    [文件不变]
                        invalidate → JSON.parse(read)   ←── ⚠️ 若 P1 半途崩溃: 半截文件
                        → mutator(全量 draft)
                        → atomicWrite(tmp+rename, 无锁)  ──▶ ✏️ 写入点 P2
pi 启动 ────────────▶ 读 settings.json: packages[] 决定加载哪些扩展
```

两个写入点互不相识（P1 持锁但写非原子；P2 原子但无锁且全量覆盖）。窗口 W1 = P2 的「读→写」之间夹入 P1 → P2 写回旧快照，丢 P1 字段；窗口 W2 = P1 锁内「读→写」之间 P2 的 rename 替换文件 → P1 写回旧 current，丢 P2 字段（rename 不受 P1 的锁约束）；窗口 W3 = P1 崩溃半写 + P2 parse 失败固化默认值（失败模式 A 的第二条链）。

### 2.5 物理数据流：runtime 崩溃后的孤儿链

```
Electron main ──spawn──▶ runtime(父) ──spawn──▶ pi×N(子, pipe=stdio)
    │                        │ SIGKILL/OOM(崩溃)
    │                        ✖
    └─supervisor 重启────────▶ runtime'(新, 与旧 pi 无父子关系)
                              旧 pi: 收 stdin EOF → dispose(handler 无超时, 可挂)
                                     → flushRawStdout(EPIPE 可 throw 跳过 exit)
                              结果: 0..N 个 pi 滞留(持有 API key, 或继续烧 token)
                              现状: 无任何组件扫描/回收它们（孤儿判据 argv 可识别
                                     —— --mode rpc + --session-dir 精确等值 + ppid=1
                                     ——却未利用；设计原稿的 env 判据已被 W3 探针
                                     否决，见 §3.4）
```

---

## §3 解决方案

**终态三原则（与前篇五原则同级，是本设计的「绝对写规则」）：**

- **原则 1（锁协议唯一）**：凡登记为「跨进程共享」的文件，全部写入方必须使用**同一把锁**（同一 lockfile 路径与参数语义）；锁内读-改-写，且只写调用方声明的字段域。无锁的第二写入者 = 契约违规，CI/审查拦截。
- **原则 2（检测即收敛）**：凡「判定进程死亡/不可用」的路径，必须走完与已知死亡路径（onSessionExit）同构的收敛（销毁进程 + 广播 + 清理 + 可自动恢复）；「只收口不销毁」的半途处置不允许存在。孤儿由独立的收殓机制兜底，不依赖对端自觉退出。
- **原则 3（护栏机制化）**：安全/打包/写协议不变量必须有运行时守卫或 CI 机器检查兜底；注释与文档只解释「为什么」，不再承担「保证」职能。

### 3.1 D1 跨进程文件写治理：settings.json 与 ext-config 家族（修 M1，G1）

**终态（使用者视角）**：用户在流式对话中切档位、同时在 Settings 页装扩展、另一个 session 里 pi 也在写 settings——三方并发写后，`jq` 校验 defaultModel / enabledModels / skills / packages 字段一个不丢。pi 崩溃在写入半路 → 下次启动看到 error 日志「settings.json 损坏已隔离至 .corrupt-<ts>，可用编辑器对比恢复」→ 扩展列表等配置从 .corrupt 副本可手工找回，而不是静默清空。

#### 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 共享锁 + 字段域 merge（对齐 auth-storage 范本） | 高：与 auth.json 同构，跨进程互斥从结构上成立；字段域 merge 消灭全量覆盖丢字段；登记表可推广 | 中：改 `pi-settings-store` 写路径 + 各调用方声明字段域；锁参数需与 pi 源码镜像对齐 | 锁竞争时 sync 重试最长秒级（settings 写是低频用户操作，可接受）；需确认 proper-lockfile 已在 runtime bundle（auth 已用，✅在） | ✅ |
| B. xyz 完全停写 settings.json，全部经 pi RPC | 表面优雅（单写入方） | 高且**不可行**：pi RPC 命令面是固定 switch，无 set_settings 命令；扩展也不能注册命令（前篇已核实）；扩展安装本身要先写 packages 再启动 pi——鸡生蛋死锁 | 绕不开「不改 pi」铁律就要造机制，复杂度爆炸 | ❌ |
| C. 损坏隔离单做（不动锁） | 低：只堵 W3 窗口，W1/W2 双写窗口原样存在 | 低 | 丢字段照旧，等于没修主链路 | ❌（作为 A 的组成部分采纳） |

**被否若用 B**：§2.4 的窗口 W1/W2 看似消失，但扩展安装/卸载永远无法实现（packages 字段必须在 pi 启动前写入，而唯一写方 pi 此时不存在）；用户在 pi 无 session 运行时改的默认模型无处落盘。**被否若用 C**：失败模式 A 的第一条链（交错丢字段）每次切模型都在开窗口，用户仍会丢 thinkingLevel/enabledModels。

#### 关键决策

- **D1a 锁协议**：`pi-settings-store.updateSettingsSync` 内部改为 `withSettingsLock(fn)`——proper-lockfile `lockSync(path, { realpath: false, stale: 30_000 })`（**无 retries：lockSync 与 retries 组合会抛 ESYNC，proper-lockfile adapter 明确禁止**——R2 审查核实；auth-storage 的 retries 是 async `lock()` 才有的能力），外层自实现 busy-wait 重试（对齐 pi `acquireLockSyncWithRetry` 的模式：ELOCKED → 同步等待 ~25ms → 重试，预算 ~1s），预算耗尽则 fail-fast 抛给调用方（与 pi 放弃保存的语义对齐）。锁内重读最新 → 应用 mutator（只动声明的字段域）→ atomicWrite 写回。
  **pi 侧锁的真实形态（设计期已 read pi 源码 `FileSettingsStorage` 核实，R1 审查纠正）**：`acquireLockSyncWithRetry` = `lockfile.lockSync(path, { realpath: false })`，遇 ELOCKED busy-wait 固定 20ms × 最多 10 次（总等待 ≤200ms）后**抛错放弃本次保存**；仅当文件存在才加锁；**未显式设 stale——proper-lockfile lockSync 默认 stale 10s 仍生效，但 pi 的 200ms 自旋窗口等不到夺取**——pi 崩溃持锁时锁残留，pi 自己不自愈。
  **不对称安全性论证（为何 xyz 设 stale、pi 无 stale，协议仍然正确且更优）**：① 互斥正确性只依赖「同一 lockfile 文件（`<settings.json>.lock`）+ 双方都先取锁再写」——retries/stale 差异不影响互斥，只影响等待策略与崩溃恢复；② stale 30s 的语义是「锁 mtime 超 30s 视为持锁者已死，可夺取」。两个临界区都是毫秒级同步读改写，30s ≫ 最坏持锁时长，stale 实际触发的唯一场景就是持锁者崩溃——正是要恢复的场景；③ pi 无 stale 的代价：残留锁下 pi 下次保存在 200ms 重试后抛错放弃（pi 现状行为，铁律下不可改）。xyz 的 stale 夺取会顺带清掉残留锁，此后 pi 写入恢复正常——xyz 的 stale 让**双方**都自愈；④ 双向等待预算对称成立：xyz 重试预算 ~1s ≫ pi 毫秒级临界区（pi 侧几乎不会因 xyz 而失败），pi 等待预算 200ms ≫ xyz 毫秒级临界区（反向同）。**契约：mutator 内禁止任何 I/O 与 await（纯内存改字段），持锁范围 = 读文件 + mutator + atomicWrite**。该不对称与理由登记进跨进程文件登记表。
- **D1b 字段域 merge**：`updateSettingsSync(mutator)` 签名演进为 `updateSettingsFields(scope: SettingsFieldScope, mutator)`。写回时只覆盖 scope 声明的顶层 key，其余 key 取锁内最新读——进程内「分区靠调用方自觉」的现行注释约定升级为 API 强制。**字段域定义（覆盖 pi 实际写的全部字段，含 R1 审查指出的 `defaultProvider`——pi 的 setModel 落盘是 `defaultProvider` + `defaultModel` 两个独立字段，`packages/runtime/src/cli/commands.ts:88` 注释互证）**：

  | scope | 覆盖的顶层字段 | 说明 |
  |-------|--------------|------|
  | `model` | `defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `enabledModels` | pi 侧 setModel/setThinkingLevel/enabledModels 写的同一批字段 |
  | `skills` | `skills` | discovery 投影专写 |
  | `extension` | `packages`（含禁用/升级状态子结构） | extension-service 域 |
  | `full` | 全部 | **白名单仅一个调用点**：`pi-maintenance.ts:182` 启动迁移（无并发 pi 进程窗口）；review checklist 增「禁止新代码使用 full scope」，pr-cr-fix 按登记表审 |

  **现有全部 11 个调用点的 scope 映射（grep 实测清单，实施时逐一迁移）**：`pi-provider-store.ts` 5 处（:201 setDefaultModel 校验写、:251 removeProvider 清理 default*、:359 getDefaultModel auto-fix、:369 setDefaultModel、:380 setDefaultThinkingLevel）→ `model`；`pi-enabled-models.ts` 2 处（:18 写 enabledModels、:31 delete enabledModels）→ `model`；`pi-skill-paths.ts:34`（skills 投影）→ `skills`；`pi-extension-settings.ts` 2 处（:102/:112 packages 写）→ `extension`；`pi-maintenance.ts:182`（迁移）→ `full`。port 层 `services/ports/extension-settings.ts` 签名随动（async 壳不变）。
- **D1c 损坏隔离**：`JsonStore.readFromDisk` parse 失败分支改为：rename 损坏文件为 `<path>.corrupt-<ts>` → error 级日志（含恢复指引：文件路径 + 「对比 .corrupt 副本找回配置」）→ 返回默认值。EACCES 等读错误同样保留现场再降级。同模式顺手覆盖 `segments.json`（session-service parse 失败 reset 覆盖）与 quota-providers 日统计（minor 同族）。
- **D1d 触发器消除**：删除 `ModelService.switchModel` 第 2 步的 `configService.setDefaultModel` 双写（`model-service.ts:90-96`）——W1a 修复后 pi 的 `setModel` 已持久化 defaultModel（pi 源码 agent-session.ts setModel → settingsManager.setDefaultModelAndProvider，✅审查期已读核实），xyz 侧同值再写一次纯冗余且每次切模型都开窗口；`config.defaults` 广播（第 3 步）保留。崩溃窗口内默认值未落盘的语义 = 与 pi CLI 自身行为一致，可接受。
- **D1e ext-config 家族统一**：`<piAgentDir>/config/<pkg>-ext-config.json`（runtime 与 pi 扩展双写）与 auto-rename 标志文件纳入同一登记表条目，锁协议同 D1a（写方都在 xyz 生态内，参数可自定但必须登记）；auto-rename 标志文件语义为「存在/不存在」幂等，登记为豁免锁条目（无数据丢失面）。

### 3.2 D2 Electron 安全不变量（修 M2/M3/M4，G2）

**终态（使用者视角）**：打包版从 Finder 启动，XSS 注入的 `<img src="local-file:///~/.ssh/id_rsa">` 加载失败（403）；devtools 里 `window.location = 'https://evil.com'` 被拒、窗口纹丝不动；`window.open` 无新窗口弹出（外部链接走系统浏览器需经白名单）；双击第二个图标 → 第二实例退出、第一实例窗口被前置。

#### 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 三件套 + cwd 守卫 + 单实例锁，白名单计算提纯函数 | 高：Electron 官方推荐的安全基线一次补齐；纯函数化后可单测守护 | 低-中：每项 ≤30 行样板 | CSP 需兼顾 dev HMR（⛔实施期门：dev/prod 双态实测） | ✅ |
| B. 只修 cwd 塌缩（最痛的点） | 低：导航接管（M3）仍在，一次性 XSS 仍可持久化 | 最低 | 攻击面只缩小一点 | ❌ |
| C. 引入 sandbox:true 全隔离改造 | 过度：现有 preload 桥依赖（electronAPI）需要整体迁移，牵动全部 renderer | 高 | 大改动的回归面远超本设计收益 | ❌（登记为长期演进项） |

**被否若用 B**：失败模式 C 原样成立——攻击者仍可导航接管 electronAPI 拿 runtime token，M2 的修复失去意义（读文件的限制挡不住拿凭证执行命令）。**被否若用 C**：§3.2 的目标用 30 行样板即可达成，C 要动 renderer 全部 IPC 路径，属「用大手术治感冒」。

#### 关键决策

- **D2a cwd 守卫**：白名单构造提为纯函数 `computeLocalFilePrefixes({ isPackaged, cwd, appPath, dataDir, tmpdir, home })`——打包态（`app.isPackaged`）**剔除 `process.cwd()`**（打包态它不再等于用户项目目录，语义已失效）；dev 态保留（cwd=项目根是图片预览主场景）。函数级单测断言「打包态白名单不含文件系统根、不含 homedir 本身」。恢复指引不变量注释改为指向该测试（护栏从注释移到测试）。
- **D2b 导航拦截**：主窗口（window-factory 创建的全部 BrowserWindow）挂 `will-navigate`（拒绝非应用自身源，dev 放行 vite dev server）+ `webContents.setWindowOpenHandler`（默认 deny；http/https 经现有 openExternal 白名单转系统浏览器）。browser-view 管理器创建的嵌入 view 同样挂 setWindowOpenHandler（其导航已有三层 scheme 校验，补新窗口分支）。
- **D2c CSP**：renderer `index.html` 加 meta CSP。**定稿指令集（W2 dev 实测 + S3 打包态实测，2026-08-20）**：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: local-file:; font-src 'self' data:; connect-src 'self' ws://localhost:*`。与设计起点策略的三处实测修正：① runtime WS host 是 `localhost` 非 `127.0.0.1`（renderer 实际连 `ws://localhost:<port>`，`packages/renderer/src/api/transport.ts:35`）——按起点指令集抄会直接断掉 runtime WS 连接，且实测无 `http://127.0.0.1:*` 需求已删；② dev HMR 的同源 ws 走 CSP3 scheme-source 家族规则被 `'self'` 覆盖，无需显式指令；③ 打包态实测发现 `@fontsource` 字体以内联 `data:font/woff2` 形态加载被 `default-src` 兜底拦截（dev 态走 vite 字体 URL 未触发——⛔双态实测门的价值记录），补 `font-src 'self' data:` 后打包态零违规。**双态均零违规定稿**（dev 见 W2 门、打包态见 §4 验收执行记录 S3）。
- **D2d 单实例锁**：main 入口 `requestSingleInstanceLock()`，失败 `app.quit()` + `second-instance` 事件聚焦既有主窗口。样板代码，无副作用。

### 3.3 D3 pi 半死自愈：检测即收敛（修 M5，G3）

**终态（使用者视角）**：pi 卡死（事件循环冻结）后 ≤4 分钟，用户看到该 session 收到一条明确终止消息（含「重发即可恢复」指引），session 状态收敛为 stopped；重发消息自动 restore 新 pi 进程、历史完整。不再出现「每次发消息等 60s 超时」的循环。**例外边界（S5 真机实测）**：全新 session 首个 turn 冻结时 pi 未 flush session 文件，重发得 SESSION_NOT_FOUND——「重发即可恢复」该边界不成立，需新建 session（无已落盘历史可恢复，损害限于未完成 turn）；主路径（文件已存在）实测 restore 完整。

#### 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. onSilentAbort 判定超时 → 强杀 + message-dispatcher 内手动编排收敛（onSessionExit 同构链的第二份副本） | 高：与 pi 崩溃路径同构（原则 2）；ensureActive 自动 restore 已存在 | 低-中：改动集中在 message-dispatcher 的 abort catch 分支 + 错误判定 + 收敛编排。**W3 实施定案**：kill 路径 exit 事件被 rpc-client `_killing` 标志与 process-manager 先删 Map 双层守卫拦截，「靠 exit 事件触发、收敛零新发明」不成立，收敛须在强杀分支内手动编排并与 onSessionExit 同步维护（见 D3a） | 收敛链存在两份副本须同步维护（改 onSessionExit 收敛步骤时须同步手动编排）；误杀窗口：ping 判死但进程只是极慢 → 强杀后 restore 也无害（restore 语义已验证） | ✅ |
| B. 只改错误文案（提示用户手动删 session） | 低：把架构缺陷转嫁给用户 | 最低 | 死循环本体仍在 | ❌（作为 A 未实施前的止血可选） |
| C. 透明重启 + 未完成 turn 自动重放 | 过度：turn 语义不可重放（工具副作用），伪透明更危险 | 高 | 重放 = 副作用双执行 | ❌ |

**被否若用 B**：失败模式 E 的循环只是多了句提示，G3 不达成。**被否若用 C**：subagent/bash 的副作用无法幂等重放，自动重试可能造成重复写盘/重复提交。

#### 关键决策

- **D3a 判定与处置**：`onSilentAbort` 的 abort RPC 若以超时类错误失败，则走强杀路径：`processManager.destroySession(sessionId)` + 强杀分支内手动编排收敛（广播 session.exited → removeSessionEntry → 写 stopped 终态；编排细节与「为何不能复用 exit 事件」见本条末尾的收敛编排段）。下次发消息 `ensureActive` 自动 restore（该机制已存在，`session-service.ts:724-728` ✅审查期核实）。**设计期已核实两个可行性前提（R1 审查 S1 建议的探读）**：① 超时判别——rpc-client 超时在单点 reject（`rpc-client.ts:418` `reject(new Error('RPC command "..." timed out after ...ms'))`，纯 message 字符串），定案为**引入 `RpcTimeoutError` 类型**（rpc-client 内定义，reject 处替换，`instanceof` 判别），扩展点存在、改动单点；② 冻结进程收敛——destroy 链 SIGTERM→2s→SIGKILL 且 kill() 保证 resolve（`process-manager.ts:306-316` 注释明示），SIGKILL 对 SIGSTOP 冻结进程有效，**必然收敛**；增补「SIGTERM 前发 SIGCONT」唤醒冻结进程，让优雅退出路径（扩展落盘）有机会执行（实测时序门已消解：S5 两轮真机 SIGSTOP 注入跑通全链，收敛 3m35.6s/3m53s）。**收敛编排（W3 实施定案，修正「复用 onSessionExit 同构收敛」的原文）**：kill 路径的 exit 事件被双层守卫拦截（rpc-client `_killing` 标志跳过 exitCallback、process-manager 先删 processes Map 拦截 exit 回调），收敛无法靠 exit 事件自动触发，在 message-dispatcher 强杀分支内**手动编排**：detach → destroySession → persistSessionOutcome('stopped') → publish session.exited（含重发恢复指引）→ removeSessionEntry——与 onSessionExit 收敛链构成**第二份副本，两处必须同步维护**（改 onSessionExit 收敛步骤时须同步此编排，否则两份收敛链漂移）。
- **D3b 并发防护**：强杀路径与用户并发 deleteSession 的竞态：destroy + 收敛均需幂等（processes Map 无条目则跳过；收敛广播带 sessionId，前端按分区忽略）。与既有 removeSessionEntry 的幂等语义对齐。

### 3.4 D4 孤儿 pi 收殓（修 M6，G4）

**终态（使用者视角）**：runtime 崩溃（或被 kill -9）后 supervisor 拉起新 runtime，新 runtime 启动后数秒内完成扫描：残留的旧 pi 进程被逐出（日志列出 reaped pid 清单），用户无感知，token 不再流失。

#### 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 新 runtime 启动收殓步（argv 特征扫描 + ppid===1 判定） | 高：兜底与「谁杀它」解耦，唯一不依赖父进程存活的机制；孤儿判据（`--mode rpc` + `--session-dir` 精确等值）天然隔离不同数据目录的实例（设计期 env 判据已被 W3 探针否决：macOS SIP 拿不到他进程 env，`ps eww` 与 `launchctl procinfo` 均不可用，Linux 才有 `/proc/*/environ`） | 中：一个启动步 + 三平台进程枚举 | 误杀风险须用「argv 精确匹配本数据目录 + ppid===1（reparent 证据）」双条件压零 | ✅ |
| B. spawn 时挂父死联动（Linux PDEATHSIG / 包装进程 watchdog） | 中：macOS 无 PDEATHSIG，需给每个 pi 加包装层 | 高且平台不一致 | 包装层改变 stdio 管道拓扑，影响 rpc-client 既有握手假设 | ❌ |
| C. 只修 pi 自杀链挂起点（给 handler 加超时） | 低：pi 源码不可改（铁律）；扩展侧 handler 可加超时但治标 | 中 | 挂起点不止扩展 handler 一处 | ❌（扩展侧 handler 超时作为附带加固登记） |

**被否若用 B**：三平台行为不一致 + 改 spawn 拓势殃及 rpc-client 握手与 stdout tee 证据链，风险收益倒挂。**被否若用 C**：铁律挡住主修复点，且 EPIPE 跳过 exit 在 pi 侧，xyz 无法修。

#### 关键决策

- **D4a 收殓步**：挂入 `startup-background-init`（既有「每步独立 catch」结构）：启动后延迟数秒（宽限值 5s——给 stdin-EOF 自杀链留优雅退出时间，S6 真机实测通过维持）→ 枚举进程（`ps -axo pid=,ppid=,command=`，macOS/Linux 通用）筛 argv 含 `--mode rpc` 且 `--session-dir` 值与本实例 sessions 目录**精确等值**的 pid，再要求 `ppid===1`（reparent 证据，原父 runtime 已死；替代设计期的「排除本 runtime 子进程表内 pid」）→ SIGTERM → 2s → SIGKILL → 逐条日志。**设计期 env 判据（枚举 env 含 `PI_CODING_AGENT_DIR == <本实例 piAgentDir>` 的 pid，macOS `ps eww` / Linux `/proc/*/environ`）被 W3 探针否决**：macOS SIP 拿不到他进程 env（`ps eww` 与 `launchctl procinfo` 均否决），env 枚举无法跨平台，argv 判据跨平台统一（**Windows 无 ps → 降级为仅日志告警**，登记为已知平台边界）。实现：`packages/runtime/src/services/reap-orphan-pi.ts`（头注释含判据与探针结论）。
- **D4b 误杀防线**：三重条件缺一不可——① `--session-dir` 值**精确等于**本实例 sessions 目录推导值（禁止子串/前缀匹配，防路径前缀混淆；dev 默认隔离数据目录 `~/.xyz-agent-dev`，dev/prod 互不误伤）；② `ppid===1`（reparent 证据——xyz 直接 spawn pi 无 wrapper，父 runtime 活着时 pi 的 ppid 恒等于该 runtime pid，reparent 到 init 即原父已死 = 真孤儿；替代设计期「不在本进程子代表」的排除法——该排除法无法覆盖「另一合法实例的活跃 pi」，ppid===1 可以：对方实例活着时其 pi 的 ppid=对方 runtime pid ≠ 1，天然不杀）；③ `--mode rpc` 必在 argv（防误杀用户终端手工跑的同目录交互式 pi）。单实例锁（D2d）**不承担**排除另一合法实例的职责——dev userData 自动隔离使 dev/prod 并存合法，跨实例安全由防线② ppid===1 承担（`reap-orphan-pi.ts` 头注释防线③明示）。收殓动作幂等、失败仅日志不阻塞启动。

### 3.5 D5 worktree 注册表：锁 + 对账（修 M7，G5）

**终态（使用者视角）**：两个 session 并发各跑 subagent 任务（如「重构 A 模块」「修 B 文档」），全部完成后仓库 `git branch --list 'pi-sub-*'` 输出为空、`$(TMPDIR)/pi-subagents` 目录为空；即使某 pi 中途被 kill -9，下一个 session 启动时 reaper 对账把它的 worktree 与分支清掉。注释里声称的兜底从「文字」变成「代码」。

#### 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 文件锁（写方全在 xyz 生态）+ reaper 对账兜底 | 高：锁消灭交错丢条目（主因）；对账补「条目丢失/文件损坏」的长尾并让注释成真；两层职责清晰 | 中：extension 引入 proper-lockfile（esbuild 可 bundle，纯 JS；⛔实施期门：bundle 验证）；对账 ~60 行 | 锁竞争极短（load-mutate-save 毫秒级） | ✅ |
| B. 只加对账（不动写路径） | 中：泄漏最终会被清，但条目仍会丢、依赖对账周期 | 低 | 「丢而复得」中间态会让 reaper 误判活 worktree（pid 还活着） | ❌ |
| C. 注册表改 append-only JSONL（op 日志） | 高（结构性消除 RMW） | 中-高：读侧折叠重放 + 压缩机制，改动面大于收益 | 复杂度换来了锁已解决的问题 | ❌ |

**被否若用 B**：交错丢条目是主因，对账是兜底——只用 B 时每次并发都可能先丢再等对账，且对账在「pid 活着但条目已丢」的中间态无法区分孤儿与活体。**被否若用 C**：锁（A）已把 RMW 交错消灭到零，C 的额外复杂度没有对应收益（违反减法原则）。

#### 关键决策

- **D5a 锁**：`WorktreeRegistry` 的 add/updatePid/remove 全部包 `withLock(worktrees.json)`（proper-lockfile，参数登记：stale 30s 对齐 auth 惯例）。写方都是 xyz 生态扩展（无 pi 本体写方），锁协议自定即可，登记表备案。
- **D5b 对账**：reaper `scan()` 增加双向 diff——物理面 `git -C <repo> branch --list 'pi-sub-*'` + tmpdir `pi-subagents` 目录扫描，与注册表条目比对；物理存在但注册表缺失的分支，按既有 pid 死活 + SPAWN_GRACE 判据处置（死则清分支与目录，活则补写回注册表——自愈而非只删）。挂在既有 session_start reaper 周期，无新调度。
- **D5c 注释兑现**：worktree-registry.ts:17 的对账声明在 D5b 落地后保留并指向对账实现；若实现分层变化则更新注释——注释描述的运行时行为必须有代码对应（全局规则 13 的文档面）。

### 3.6 D6 挂起 UI 请求：收敛点汇聚（修 M8，G6）

**终态（使用者视角）**：ask-user 弹窗挂起时 pi 崩溃 → 弹窗随 session.exited 即时消失；切走再切回不重弹旧请求；若极端时序下仍有残留请求被拉起，作答返回明确错误（「会话已重启，请重发」），而非石沉大海。

#### 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 双端各补一个清理钩子（runtime 汇聚点 + renderer 分区清理） | 高：把清理挂到「所有销毁路径必经」的汇聚点，结构性覆盖未来新增的销毁路径 | 低：两处小改 | 需确认汇聚点回调机制（session-service 不直接 import transport） | ✅ |
| B. requestId 绑进程代（generation），跨代请求自动失效 | 高（更彻底） | 中-高：requestId 生成/校验/拉取协议三处改 | 对「单进程生命周期内」场景过度设计 | ❌（登记为 A 之后的演进项） |

**被否若用 B**：A 已把双端清理挂到汇聚点，幽灵弹窗的入口被关死；B 的进程代方案解决的是「跨代重放」这一 A 之后已不存在的残余场景（YAGNI）。

#### 关键决策

- **D6a runtime 侧**：**扩展点已存在（R1 审查 S1 建议的探读核实）**——`session-service.ts:210` 已有 `onSessionDestroyed` 回调槽（`:350` 注入函数，注释明示「触发点 removeSessionEntry（所有删除路径汇聚处）」，覆盖主动删 / 进程退出 / restore 清场三类路径）。实现 = 组合根在该回调（若单槽已被占用则升级为回调列表）里调用 `extensionTimeoutMgr.clearForSession(sid)` + `bridgeRequestIds` 清理；删除分支的既有直接调用点改由汇聚点统一触发（单一清理入口）。无新机制，降为实现细节。
- **D6b renderer 侧**：`session.exited` 事件处理补 `extensionUIStore.clearSession(sid)`（对齐 deleteSession 已有路径）。`sendExtensionUiResponse` 对「目标 session 无进程」的失败改走用户可见 error（现有「client 不存在回 error」路径已覆盖发送侧，补 renderer 展示）。

### 3.7 D7 现场治理：chat-app 处置与文档导航修正（修 M9/M10，G7）

**终态（开发者视角）**：仓库根不再有未声明的孤岛目录；全仓 lint 零 error 不再被非生产目录污染；新 session 读 AGENTS.md 文档索引，一跳到达现行 SSOT（renderer-rebuild-architecture.md），旧文档头部有 supersede 标注说明被取代关系。

#### 方案对比（chat-app 处置）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 删除 | 高：dummy echo 原型无保留资产；三端共享架构下 React 原型无归宿 | 最低 | 目录非本设计会话产物——**需用户授权后执行** | ✅（推荐，待授权） |
| B. gitignore 条目阻断误提交，目录保留本地 | 中：阻断 git 污染，但 lint 污染与「诱导后续 session」仍在 | 最低 | 无 | 备选（用户若确认保留价值） |
| C. 移入 docs/research/ 并加 README 声明定位 | 中：留档但持续付维护成本 | 低 | 无 | ❌（对 dummy demo 不值得） |

**关键决策**：推荐 A；在用户授权前先落 B（gitignore）作为零风险过渡——两者不冲突，B 是 A 的前置。文档导航修正（无争议，直接做）：AGENTS.md 文档索引行改为「七层目标概念（renderer-target，历史）· 终态包拓扑（renderer-rebuild-architecture，现行 SSOT）」；renderer-target-architecture.md 与 v6-architecture-refactor.md 头部加 supersede 标注（对齐 docs/architecture/README.md 的 supersede 纪律）；修正 `packages/core/src/index.ts` 注释里失效的文档相对路径。

### 3.8 D8 护栏机制化：登记表 + CI invariants（修元模式 ②，G7）

**终态（开发者视角）**：开发者要动任何跨进程共享文件，先在一张登记表查到它的锁协议与字段域归属（G2 式可查性）；PR 里 runtime 偷偷引入 `import.meta.url`、CI 直接红（不再依赖本地 hooks 是否安装）；「打包态白名单不含根路径」有单测守护。

#### 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 登记表（文档）+ CI invariants job（复用既有自包含脚本）+ 定点单测 | 高：机械可查的进机器，语义判断留 review（与前篇双层护栏同构）；脚本已自包含，CI 接入成本低 | 低-中 | CI 时长增加（分钟级） | ✅ |
| B. 全部规则化为 lint/AST 检查（如「跨进程文件写必须有锁」静态检测） | 低：锁协议正确性不可静态判定（需跨仓知识），强行做会产生高误报 | 高 | 误报噪音 → 规则被整体禁用（反模式） | ❌ |
| C. 只扩 review checklist（不动 CI） | 低：纯纪律，元模式 ② 原样 | 最低 | 护栏回到「靠记忆」 | ❌ |

**被否若用 B**：「settings.json 的写方必须持锁」这类约束跨 runtime/extension/pi 三个代码域，AST 无法可靠判定调用图终点，误报会把整个检查变成 SKIP 候选。**被否若用 C**：M2 的注释不变量就是 C 的活例子——被环境一击即穿。

#### 关键决策

- **D8a 跨进程文件登记表**：`docs/architecture/data-source-registry.md` 新增「跨进程共享文件登记表」章节（与 GUI 数据登记表并列，同一查询入口）。列：`文件 | 写入方（进程）| 锁协议 | 字段域归属 | 损坏隔离 | 状态`。首版条目：settings.json（D1 协议）、worktrees.json（D5）、ext-config 家族（D1e）、auth.json（范本，已达成）、auto-rename 标志（豁免锁，幂等语义）、plugin sessionData（单进程，非共享——对照组）。新文件入表 = pr-cr-fix review checklist 项（语义层，沿用前篇 G4 双层结构）。
- **D8b CI invariants job**：ci.yml 增 `invariants` job，直调既有自包含检查（ENV 白名单 SSOT 检查、路径白名单检查、runtime bundle 检查脚本中的 import.meta/noExternal 段），使本地 pre-commit 不再是唯一拦截点。`validate-runtime-bundle.sh` 的 grep 段补 `globalThis.__dirname` 禁令（现无静态检查）。**实施形态说明（W5）**：bundle 校验脚本两段无 preflight 直调模式，CI job 内为等效 grep/node 实现并注明同步维护义务——两处改动须同步，是已论证接受的长期双维护点。
- **D8c 定点守护测试**：`computeLocalFilePrefixes` 纯函数单测（D2a）；「打包态白名单不含文件系统根/homedir」断言进测试而非注释。
- **D8d 同族 minor 搭车**：quota-cache 在 provider 删除后清条目（write-after-invalidate 修复）；session-reader stats 输出补 `skippedLines`（有检测无报告）；resource-discovery 同名遮蔽补 warn。均 <20 行，挂对应 wave 顺手修。

---

## §4 验收（真实场景，非单测非 mock）

**改动规模声明：大**（跨 runtime/Electron/extension/CI 四个域的行为变更与新机制），验收按多场景投入。单测（D2a/D8c）只作为回归守护，**不作为验收**；以下场景全部在真实 app（dev 或打包版）+ 真实文件系统 + 真实进程上执行。故障注入（kill -9 / SIGSTOP / truncate 文件）是对真实崩溃路径的受控复现，不是 mock。

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|------|---------|-------------------|---------|
| S1 | 三方并发写 settings.json | G1 / §3.1 | **脚本化交错（主验收）**：真实 app（dev 或打包版）跑两个并发脚本各 ≥20 轮——脚本 A 经 WS 循环发 `config.setDefaultModel`（驱动 xyz 写路径），脚本 B 经 WS 循环发 `session.switchModel`（驱动 pi RPC setModel → pi 持锁写路径），两者并行制造真实跨进程 RMW 交错；结束后 `jq` 校验 `~/.xyz-agent/pi/agent/settings.json` 的 defaultProvider/defaultModel/enabledModels/skills/packages 全字段。**手工操作（冒烟）**：GUI 内切档位 + Settings 页保存 provider 交叉若干次 | 脚本轮全部通过：字段零丢失、文件始终为合法 JSON；手工冒烟同样通过；重启 app 后扩展列表与默认模型与最后操作一致 |
| S2 | pi 崩溃半写 → 损坏隔离 | G1 / D1c | 真机：手工把 settings.json 截断为前半截（复现 pi writeFileSync 半途崩溃的磁盘残留）→ 在 GUI 触发任一 settings 写（如切模型）| `<settings.json>.corrupt-<ts>` 副本存在且内容=截断原文；error 日志含恢复指引；新 settings.json 为合法 JSON；从 .corrupt 副本可人工找回原 packages 列表（对比确认未被静默清空） |
| S3 | 打包态白名单与导航拦截 | G2 / §3.2 | 打包 DMG 安装、Finder 启动（cwd=/）；devtools 执行：① 图片 src 指向 `local-file:///Users/<me>/.ssh/id_rsa` ② `window.location='https://example.com'` ③ `window.open('https://example.com')` | ① 加载失败（协议 handler 返回 403，无文件内容泄漏）；② 导航被拒、窗口仍停留应用页；③ 无新 BrowserWindow 弹出；对照组：`local-file://` 指向 ~/Downloads 图片正常加载 |
| S4 | 双开单实例 | G2 / D2d | 打包版运行中再次双击图标 | 第二实例自动退出；第一实例主窗口被前置聚焦；`~/.xyz-agent/` 全程只有一个 runtime 进程（ps 验证） |
| S5 | pi 半死自愈 | G3 / §3.3 | dev 版开一个 session 跑长回复（流式中），对 pi 进程 `kill -STOP <pid>`（冻结事件循环，进程不退）；等待并观察；随后重发一条消息 | ≤ ping 判定窗口 + 处置时间（约 4 分钟）内：session 收到终止消息且状态收敛（非悬挂）；重发消息自动 restore 新 pi、历史完整、新回复正常产生；全程无「等 60s 报错后必须删 session」的循环。**已知边界（两轮真机实测发现）**：全新 session 的首个 turn 冻结时 pi 尚未 flush session 文件（延迟写入规则），强杀后重发返回 SESSION_NOT_FOUND——该边界需新建 session（无已落盘历史可恢复，损害限于未完成 turn）；主路径（文件已存在）实测 restore 完整 |
| S6 | 孤儿收殓 | G4 / §3.4 | dev 版开 3 个 session（至少 1 个流式中），`kill -9 <runtime pid>`（绕过一切优雅退出）；等 supervisor 重启完成；`ps -axo pid=,ppid=,command=` 复查残留（argv + ppid 判据——设计原稿的 `ps eww` env 复查法在 macOS 因 SIP 不可执行，已废弃，见 D4a） | 新 runtime 启动数秒内日志列出 reaped pid 清单；复查无残留 pi 进程（argv 匹配本数据目录 session-dir）；3 个 session 重开后均可 restore，session 文件完好 |
| S7 | worktree 并发 + 对账 | G5 / §3.5 | 两个 session 并发各跑一个真实 subagent workflow（如「总结 README」「格式化某文件」）；全部完成后 `git branch --list 'pi-sub-*'` 与 `ls $TMPDIR/pi-subagents`；再跑一次并发并中途 `kill -9` 其中一个 pi，随后开新 session 触发 reaper | 两轮实验最终 `pi-sub-*` 分支为空、tmpdir 目录为空；kill 注入轮的泄漏在下一 session_start 的对账中被清理（日志可见 reconcile 记录） |
| S8 | 幽灵弹窗 | G6 / §3.6 | dev 版让 agent 调用 ask-user（弹窗挂起）→ `kill -9` 该 pi → 切到别的 session 再切回 | 弹窗在 session.exited 时即时消失；切回后不重弹旧请求；若构造出极端残留并作答，UI 显示「会话已重启」类错误反馈而非静默无响应 |
| S9 | CI 护栏 | G7 / §3.8 | 在测试分支故意提交两处违规：runtime 源码加 `import.meta.url`、注释掉 invariants job 中任一检查的调用（验证 job 真的在跑）；另在 MR 里新增一个跨进程共享文件但不登记 | 前两者 CI 红（invariants job 失败信息指向具体检查）；第三项被 pr-cr-fix review 按登记表 checklist 拦下（人工执行，记录在 PR review） |
| S10 | 文档导航 | G7 / §3.7 | 新开一个会话，仅按 AGENTS.md 文档索引找到「Renderer 七层/包拓扑」的现行 SSOT | 一跳到达 renderer-rebuild-architecture.md；renderer-target-architecture.md 头部可见 supersede 标注；仓库根无未声明孤岛目录、`pnpm run lint` 无 chat-app 来源的 error（处置授权后） |

场景与 10 个 major 的覆盖关系：M1→S1/S2，M2/M3/M4→S3/S4，M5→S5，M6→S6，M7→S7，M8→S8，M9/M10→S10（+S9 护栏），无遗漏。

### 验收执行记录（2026-08-20 实测）

真机环境：隔离数据目录 + 本地 mock LLM（127.0.0.1 SSE 流式）+ SIGSTOP/SIGKILL 故障注入。未列 PASS 的条目均非「已验收」，引用 G2/G5 等结论时以本表为准。

| # | 结果 | 说明 |
|---|------|------|
| S1 | **PASS** | 25+25 轮真机 WS 并发交错零丢失、pi 侧零放弃（另有 W1 锁探针 3×300 轮零丢失、xyz 临界区 p50=0ms/p99=1ms/max=2ms、崩溃 stale 夺取验证） |
| S2 | **PASS** | `.corrupt` 副本与截断原文 byte-identical、error 日志含恢复指引 |
| S3 | **PASS** | 打包态 7 断言全过（CDP 实测，cwd=/ 启动模拟 Finder 白名单塌缩场景）：白名单外 `local-file://`（~/.ih-accept-out、/etc/passwd）REJECTED / 白名单内（dataDir）LOADED 对照成立；`will-navigate` 拦截（location 不变）；`window.open` deny（返回 null）；CSP meta = 定稿指令集；零 CSP 违规。实测抓到 dev 态未暴露的 `data:font/woff2` 拦截 → 补 `font-src 'self' data:` 后 rebuild 复验全绿（见 D2c 修正③） |
| S4 | **PASS** | 双新 build 实例同 userData：第二实例 1.4s 内 exit 0、无窗口，第一实例独活；实测澄清：已装旧版（无 W0 锁代码）与新 build 并存不互斥——单实例锁需双方实现，升级部署暂态可接受 |
| S5 | **PASS（两轮）** | STOP→收敛 3m35.6s / 3m53s，SIGTERM 优雅退出码 143，restore 新 pid 正常回复、历史完整；边界见 G3/D3a/S5 登记 |
| S6 | **PASS** | 冻结孤儿 ppid=1 被 SIGKILL 收殓；TaiJi 打包版实例子代未受影响（跨实例零误杀，3 个活跃 pi ppid=40842 全保留）；supervisor liveness 探针路径完成重启 |
| S7 | 单测 + 集成测试通过 | 真机双 session 并发 deferred（锁与对账主链已由 W4 bundle/CLI 探针 + 单测覆盖） |
| S8 | 单测通过 | 真机 ask-user + kill -9 场景 deferred |
| S9 | 待 push 后 CI 验证 | invariants job 需远端实跑（本地等效检查全过） |
| S10 | 达成 | chat-app 已删（经授权提前至 W0 执行）、索引已改、supersede 已加、lint 无噪音源 |

---

## §5 下一层拆分（实施波次）

**迁移路径：先关高危廉价半边，再攻锁协议与自愈机制，最后立护栏。每个 wave 可独立验收（对应 §4 场景），失败可独立回滚。**

| Wave | 内容 | 交付终态的什么 | 验收场景 | justification |
|------|------|---------------|---------|---------------|
| W0 快赢（≤半天） | D7 文档导航修正 + chat-app gitignore（删除待用户授权）；D2a cwd 守卫 + 纯函数测试；D2d 单实例锁；D2b 导航拦截；D1d 移除 switchModel 冗余写；D1c JsonStore 损坏隔离；D6 双端清理钩子 | 关闭最高危安全洞的廉价项 + 数据丢失链的两端（触发器与固化）+ 文档误导 | S2/S3/S4/S8/S10 部分 | 全部低风险独立小改，先拿确定性收益；互相无依赖可并行 |
| W1 跨进程写治理 | D1a/D1b 共享锁 + 字段域 merge（含各调用方 scope 映射）；D1e ext-config 家族；D8a 登记表初版 | 元模式 ① 的结构性修复 | S1/S2 完整 | 锁协议是核心机制，先行独立验证；登记表随机制落地一起建 |
| W2 Electron 安全收尾 | D2c CSP（dev/prod 双态实测定稿）；S3 完整回归 | G2 收口 | S3 | CSP 有环境耦合的不确定性（⛔门），独立成波避免阻塞 W0 样板项 |
| W3 生命周期自愈 | D3 半死强杀收敛；D4 孤儿收殓步 | 元模式 ② 在进程域的修复 | S5/S6 | 两者共用「销毁 + 收敛」心智模型，实现上互不依赖但验收都涉及进程注入，合并测试 |
| W4 worktree 治理 | D5a 注册表锁；D5b reaper 对账 | G5 | S7 | 依赖 extension bundle 验证（⛔门），独立于 runtime 波次 |
| W5 护栏机制化 | D8b CI invariants job + __dirname 静态检查；D8d 同族 minor 搭车；chat-app 删除执行（若授权） | G7 收口 | S9 | 护栏放最后：先把不变量修对，再上机器检查（否则 CI 先红着没有意义） |

**文件改动地图（接口级）**：`packages/runtime/src/infra/pi/pi-settings-store.ts`（锁 + scope API）；`packages/runtime/src/utils/json-store.ts`（损坏隔离）；`packages/runtime/src/services/model-service.ts`（删冗余写）；`apps/electron/main/main.ts` + `window/window-factory.ts` + `browser-view-manager.ts`（守卫/拦截/锁）；`packages/renderer/index.html`（CSP）；`packages/runtime/src/services/session/`（message-dispatcher 强杀分支 / session-service 销毁回调）；`packages/runtime/src/services/startup-background-init.ts`（收殓步）；`extensions/subagent-workflow/src/execution/worktree-registry.ts` + `worktree-manager.ts`（锁 + 对账）；transport 层 extension 清理注册点；`.github/workflows/ci.yml` + `scripts/validate-runtime-bundle.sh`（护栏）；`docs/architecture/data-source-registry.md`（登记表）；`AGENTS.md`（索引）。

---

## §6 待验证检查点

**设计期已消解（R1 审查推动的探读，结论已写进 §3 对应决策）**：

1. ~~pi settings 锁参数~~（D1a）：已 read pi `FileSettingsStorage` 源码——`lockSync(realpath:false)` + 20ms×10 busy-wait 后抛错、无 stale、仅文件存在才锁；不对称安全性论证见 D1a。编码时仅剩「把源码行号抄进对照注释」。
2. ~~rpc 超时判别方式~~（D3a）：单点 reject 于 `rpc-client.ts:418`，定案引入 `RpcTimeoutError` 类型。
3. ~~session-service 销毁回调挂法~~（D6a）：`onSessionDestroyed` 回调槽已存在（`session-service.ts:210/:350`），触发点即汇聚处。
4. ~~冻结进程必然收敛~~（D3a）：kill 链 SIGTERM→2s→SIGKILL 保证 resolve（`process-manager.ts:306-316`），SIGKILL 对 stopped 进程有效。

**实施期门（编码前必须先跑探针，均为运行时环境耦合项）——已全部执行，结论回写（2026-08-20 实施完成）**：

1. ~~并发锁交错探针~~（D1a）：**已消解，通过（W1 探针 + S1 真机）**——原探针目标：两进程（xyz 侧脚本 + 带锁的模拟 pi 写方）并发 RMW ≥100 轮，校验字段零丢失 + 临界区时长 + ELOCKED 预算内获取率。结论：3×300 轮真并发零丢失；xyz 临界区 p50=0ms / p99=1ms / max=2ms（≪200ms 契约成立）；预算内成功获取、崩溃 stale 夺取验证过（SIGKILL 持锁方后 xyz 夺取、pi 形态写方随后 1ms 内取锁）；S1 真机 25+25 轮 WS 并发交错零丢失、pi 侧零放弃。**通过，维持设计参数（stale 30s / busy-wait 25ms / 预算 1s）**。
2. ~~proper-lockfile 进 extension bundle~~（D5a）：**已消解，通过（W4 探针）**——esbuild bundle 内联 proper-lockfile 15-18 处、无外部依赖残留 + 本地 pi CLI 冒烟 exit 0。
3. ~~SIGSTOP 注入全链时序~~（D3a）：**已消解，通过（S5 真机覆盖）**——两轮全链实测：kill -STOP → onSilentAbort → SIGCONT/SIGTERM/SIGKILL → 收敛广播 → restore，收敛 3m35.6s / 3m53s，SIGTERM 优雅退出码 143，历史完整（见 §4 验收执行记录）。
4. ~~收殓的进程枚举与宽限值~~（D4a）：**已消解，但探针结论否决设计判据（W3 探针 + S6 真机）**——env 枚举否决：macOS `ps eww` 与 `launchctl procinfo` 均因 SIP 拿不到他进程 env（Linux 才有 `/proc/*/environ` 权限面），改 argv 判据（`ps -axo pid=,ppid=,command=` + `--mode rpc` + `--session-dir` 精确等值 + ppid===1，见 D4a/D4b 修正）；宽限值 5s 维持（S6 真机：冻结孤儿收殓成功 + 跨实例零误杀）。
5. **CSP 与 dev HMR/打包资源共存**（D2c）：**已消解（双态实测均零违规定稿）**——dev 态见 W2 门（round1 仅 ws://localhost:3310 一类）；打包态见 S3（round1 抓到 data:font/woff2 拦截，补 font-src 后复验零违规）。双态实测各抓到单态不可见的缺口，证明 ⛔门 5 的双态要求必要。

## 附录 A：与 10 个 major / 31 个 minor 的覆盖对照

- 10 个 major：M1→D1，M2/M3/M4→D2，M5→D3，M6→D4，M7→D5，M8→D6，M9→D7，M10→D7，元模式②横向→D8。
- 同根因搭车 minor（In-scope）：ext-config 双写（D1e）、segments.json 损坏固化（D1c）、quota-cache 失效（D8d）、ModelService 冗余写（D1d）、session-reader skippedLines 报告（D8d）、resource-discovery 遮蔽 warn（D8d）、worktree 注释兑现（D5c）。
- 其余 minor（Out-of-scope，backlog）：非原子写族（quota 日统计/.cancelled/.alive/fork 半截/quota secret/electron 更新元数据）、peerDependencies 语义矛盾、appendEntry 版本号、proxy 作用域、更新链路纵深（m5/m6/m7）、mock 签名漂移与域缺口、死暴露面窗口 IPC、扩展 tool_call handler 防御约定等——理由：各有自愈路径或低危害，与本设计根因不同轴，混入会稀释验收焦点。

## 附录 B：变更历史

- v1（2026-08-20）：初稿。基于六维架构审查报告成文。
- v2（2026-08-20）：R1 对抗式审查（2 must-fix / 2 suggestion）后修复——D1a 重写为 pi 锁真实形态（lockSync + 20ms×10 busy-wait 无 stale）+ 不对称安全性论证；D1b 补 11 调用点 scope 映射表与字段域定义（含 defaultProvider）；D3a/D6a 两个可行性前提设计期探读消解（RpcTimeoutError 定案、onSessionDestroyed 槽已存在、SIGKILL 覆盖冻结进程）；S1 改脚本化交错验收；§6 拆分「已消解/实施期门」。
- v3（2026-08-20，终版）：R2 复审 0 must-fix / 1 suggestion 后末轮修复——D1a 事实修正：lockSync 不支持 retries（ESYNC），API 形态定案 `lockSync(path, { realpath: false, stale: 30_000 })` + 自实现 busy-wait 重试（预算 ~1s，fail-fast 语义对齐 pi），论证第 ④ 点改写为双向等待预算对称。审查轨迹：`.review.md`（R1）/ `.review.r2.md`（R2）。
- v4（2026-08-20，实施完成 + 审查-修复循环）：六波实施落地——W0 `026734166`（D1c/D1d/D2a/D2b/D2d/D6/D7；**chat-app 删除经用户授权后提前至 W0 执行**，设计原排在 W5「若授权」）、W1 `e3263ba83`（D1a/D1b/D1e/D8a）、W2 `0308eb1a1`（D2c）、W3 `29a555815`（D3/D4）、W4 `797655021`（D5 + 扩展侧锁 + D8d 部分）、W5 `3d9f31186`（D8b/D8d 剩余）。实施一致性审查 `.impl.review.md`（8 must-fix / 6 suggestion / 5 info）**19 项 finding 全修**；探针修正三处回写本文档：收殓判据（env→argv+ppid=1，D4a/D4b/S6/门 4/§1/§2.5）、CSP 定稿指令集（D2c）、强杀收敛编排（D3a 手动编排非 exit 复用，两份副本同步维护义务）；S5 真机发现 G3 边界（全新 session 首 turn 冻结→SESSION_NOT_FOUND，需新建 session）登记进 G3/D3a/S5/§4。验收执行状态见 §4「验收执行记录」。
