# D8+D10：启动编排（先 listen 后初始化）+ 日志异步化

> **一句话结论**：两个「可感知延迟」治理项。①启动：Electron 主进程靠 HTTP `/health` 判定 runtime 就绪（listen 即就绪），而 `index.ts` 在 `server.start()` 前串行跑了与监听无关的 `getPiVersion()` 子进程探测和两个磁盘迁移——定案「先 listen 后初始化」+ piVersion 惰性 + session 创建的迁移 gate（**后台初始化块内 migrateBuiltinExtensions 必须先于 checkAndAutoUpgrade 串行执行，保留既有硬约束**）。②日志：主日志 console patch 改 WriteStream 缓冲写 + 退出前 flush；**pi session log 单独处理丢尾容忍度**——它是「pi 卡死诊断的决定性证据」，缓冲写只与「优雅退出 await flush」配套、硬崩溃丢尾如实声明为取证能力削弱（审查修正：初稿以「session JSONL 不受影响」为由接受丢尾，该依据恰在 pi 卡死场景不成立——卡死时 session JSONL 同样缺位）。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的时序编排/写入模型）。涉及运行时行为，准则 5/7 适用。

---

## §1 背景目标

### SCQA

- **情境**：应用启动时，Electron 主进程 spawn runtime 子进程后轮询 `/health`（30 次 × 200ms，最长 6s）判定就绪。runtime 的 `index.ts` main 在 `server.start()`（listen，`/health` 自此返回 2xx）之前，串行跑了：三个同步迁移（必须）、`await migrateProviderConfig`、`await migrateBuiltinExtensions`、`await pm.getPiVersion()`（execSync 跑 pi 子进程拿版本号）。日志方面：pi stdout 每行事件经 `createPiSessionLog` 同步 `appendFileSync` 落盘；console 被 patch 为每条日志同步写盘。
- **冲突**：两个串行 await 迁移 + 一次子进程版本探测，全部排在「listen」之前——它们与「能否接受 WS 连接」毫无耦合，却直接拉长了主进程等待 runtime ready 的时间。pi session log 的同步写发生在**每事件热路径**（每 turn 数百~上千行 JSONL），每条日志一次 open+write+close。
- **问题**：**启动路径的无关串行等待 + 热路径上的同步日志写**。
- **答案**：listen 提前到初始化链最前（迁移/探测/插件初始化全部后置或 gate），piVersion 惰性推送；日志改缓冲写。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| /health | `connection-manager.ts:51-54` 注册的 HTTP 端点，返回 `{status:'ok', uptime}`。**listen 成功即可响应 2xx**——Electron 判定 runtime 就绪的唯一依据（`health-checker.ts` 轮询）。 |
| getPiVersion | `process-manager.ts` 的 `execSync('pi --version')`（timeout 5s，带缓存）。探明：结果**唯一消费者**是 `app.info` 广播里的版本号 → Sidebar 版本标签（`Sidebar.vue:247` 监听 `app.info` 事件，天然兼容后到广播）。 |
| 两个 await 迁移 | `migrateProviderConfig`（models.json apiKey 迁移，注释要求「首次 session spawn 前完成」）、`migrateBuiltinExtensions`（清理历史 npm 记录）。探明：输出均不被 `server.start()` 前代码消费，失败均不阻塞。 |
| pi session log | `logger.ts:241-266`：pi stdout 每行 tee 到 `pi-<date>-<sid>.jsonl`，同步 appendFileSync。用途注释：「pi 卡死诊断的决定性证据」。探明：**无任何自动化逻辑读取日志尾部**，仅人类诊断。 |
| console patch | `logger.ts:164-183`：patch 所有 console 方法，每条日志同步写 `runtime-<date>.log`（层级过滤后）。 |

### 设计目标

1. **启动更快**：从点图标到 runtime ready 的时间缩短（listen 前只保留必要的同步工作）。
2. **版本标签不空窗**：piVersion 异步到达后侧栏标签自动更新，不阻塞启动。
3. **streaming 无日志阻塞**：pi 事件流的日志落盘不再同步阻塞事件循环。
4. **迁移正确性不降级**：迁移的既有约束（首次 session spawn 前完成 provider 迁移）保持成立。

### In / Out scope

- **In**：index.ts 启动链重排、piVersion 惰性、迁移 promise gate、日志写模型改造（pi log + 主日志）、轮转的字节计数适配。
- **Out**：Electron 主进程侧（runtime-supervisor/health-checker 已是「listen 即就绪」语义，无需改）；日志内容/级别策略；liveness 探针机制。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

**启动**：用户点开应用，主进程等 runtime ready——期间 runtime 正在跑「迁移 + pi 版本探测」这些用户无感的动作，然后才 listen。启动延迟 = 这些串行等待之和（getPiVersion 的 execSync 子进程 spawn 是其中最大单项）。

**streaming**：agent 输出时，每行 pi stdout 事件同步写盘一次（appendFileSync = open+write+close）。每 turn 数百~上千次同步 IO 夹在事件流处理中。dev 模式（默认 debug 级）下 console patch 放大。

### 2.2 探明事实

| 事实 | 证据 |
|---|---|
| 就绪判定 | `/health` 在 listen 即返回 2xx；轮询 30×200ms 上限 6s；liveness 探针 30s 一次（3 连败 ~90s 强制重启） |
| 启动串行瓶颈 | `pm.getPiVersion()`（`index.ts:454`）是唯一串行子进程 await；其输出仅消费于 `app.info`（`message-broker.ts:127-133`）；Sidebar 版本标签事件驱动（后到广播自动更新） |
| 迁移约束与耦合 | `migrateProviderConfig` 注释要求「首次 session spawn 前完成」；两个迁移输出不被 start 前代码消费；失败均不阻塞；三个同步迁移（migrateToPiSubdir 等）必须**首次配置读取前**完成（`index.ts:118-120` 注释） |
| 现状 listen 后 | `index.ts:518-558`：skill init / autoUpgrade / plugin init 已在 `server.start()` 之后（非阻塞 try/catch）——「先 listen 后初始化」已部分成立，缺的是把两个 await 迁移 + getPiVersion 也后置 |
| 日志消费者 | 仅人类诊断；全仓无自动化读日志尾部的代码；关键证据源是 session JSONL（pi 自己持久化），日志只是 tee 副本；cleanExpiredLogs 按 mtime 清 7 天前 |
| 同步写理由 | `logger.ts:84-85` 注释：同步写保证 statSync 读到真实 size、轮转判定准确——这是异步化的唯一既有理由 |

### 2.3 根因

1. **启动**：迁移/探测与 listen 无依赖，但被放在 listen 前（历史排布，非依赖要求）；piVersion 是「启动一次性数据」却阻塞了「端口可用」这一就绪信号。
2. **日志**：`appendFileSync` 每条 open+write+close；pi session log 在每事件路径上（rpc-client 每行 stdout 调用一次 write）。

### 2.4 物理数据流（现状）

```
启动：main() → 同步迁移×3 → await 迁移A → await 迁移B → 构造服务 → await getPiVersion（子进程）
      → setServices → server.start()【listen：/health 才就绪】
streaming：pi stdout 每行 → createPiSessionLog.write → appendFileSync（同步盘写，每事件一次）
```

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**启动**：点图标后 runtime 尽快 listen（/health 即就绪，主进程等待缩短到「三个同步迁移 + 服务构造」的量级）；迁移与版本探测在后台进行；侧栏版本标签先显示应用版本，pi 版本探测完成后自动补上（1-2 秒内）。

**streaming**：日志写入走缓冲（WriteStream），事件流处理不再被每条日志的同步盘写打断；进程正常退出时 flush 落盘；异常崩溃时最多丢缓冲窗口内的几行日志尾部（无自动化消费，可接受）。

**迁移正确性**：用户抢先在迁移完成前创建 session 时，session 创建路径等待「迁移完成 promise」（通常 < 100ms），行为与现状一致。

**失败路径 + 恢复指引**：
- 迁移失败：与现状一致 best-effort（warn + 下次重试），不阻塞任何功能。
- piVersion 探测失败/超时（5s）：版本标签保持「unknown」/仅应用版本，不影响任何其他功能；下次启动重试。
- 日志写失败（磁盘满）：WriteStream error 事件捕获记 console.error，runtime 主流程不受影响（与现状 appendFileSync 的 try-catch 容错对齐）。

### 3.2 多方案对比（启动编排）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：先 listen + 惰性 piVersion + 迁移 gate（选）** | ✅ 就绪信号（listen）与业务初始化解耦，符合「/health = 端口可用」的既有契约；未来新增启动项自动有「放哪」的明确答案（放 listen 后） | 中：index.ts 重排 + gate promise | 低：迁移 gate 与 piVersion 惰性都有明确设计 | ✅ |
| B：保持串行 | ❌ 启动延迟持续；新增启动项会继续堆在 listen 前 | 零 | — | ❌ 若用它：§3.1 终态不成立，每次启动继续为无感动作付费 |
| C：listen 后全 fire-and-forget 迁移（无 gate） | ⚠️ 违反「首次 session spawn 前完成 provider 迁移」的既有约束，session 创建与迁移竞态 | 低 | 中：竞态窗口内 session 读到未迁移配置 | ❌ 若用它：用户秒开 session 时可能拿到迁移前的旧配置，出现「重启后首次进 session 配置错乱」的偶发问题 |

**推荐 A**。

### 3.3 关键决策与权衡

**D8-1：listen 提前的位置**。
- 选择：`initLogger → 三个同步迁移（必须在首次配置读取前）→ 全部服务构造 → setServices → server.start()` 保持紧密连续；随后进入后台初始化块：**`migrateBuiltinExtensions` 先于 `checkAndAutoUpgrade` 串行执行（既有硬约束，见下）**，`migrateProviderConfig`、`getPiVersion`、`skillRegistry.initGlobal`、`pluginService.initialize` 相互可并行。
- **次序硬约束（审查修正：初稿写「并发/串行」含糊，未保留既有先后依赖）**：`index.ts:190` 注释明确 `migrateBuiltinExtensions`「必须在 checkAndAutoUpgrade 前跑（否则 autoUpgrade 仍会尝试升级打包内置包）」，且 `extension-service.ts:670` 的 `checkAndAutoUpgrade` 读 `getAutoUpgrade()`——正是 `migrateBuiltinExtensions` 要清理的数据。若把两者放进同一「并发」块，会重演「autoUpgrade 升级打包内置包」回归。**定案：两者必须串行且迁移在前，文字写死；§5 待验证加「migrateBuiltinExtensions 先于 checkAndAutoUpgrade」门禁。**
- 证据：三个同步迁移必须在首次配置读取前（`index.ts:118-120` 注释——**该注释只针对 `migrateToPiSubdir`**；`cleanLeakedPackages`/`sanitizeInvalidProviders` 各有独立理由，至少 `migrateToPiSubdir` 有硬性次序要求）；服务构造依赖 configStore（依赖同步迁移）；setServices 依赖服务构造；listen 依赖 setServices（broker 装配）。其余全部无「listen 前」依赖（探明事实）。
- 被否：把同步迁移也后置——违反「首次配置读取前」的硬约束。

**D8-2：piVersion 惰性推送**。
- 选择：`appInfo.piVersion` 初始为 `'unknown'`（app.version 用同步的 `getAppVersion()`）；`getPiVersion()` 完成后更新 appInfo 并**补发一条 `app.info` 广播**（复用 `buildAppInfoMsg`）。
- 证据：唯一消费者 Sidebar 监听 `app.info` 事件（`Sidebar.vue:247`），后到广播自动更新标签；探明确认无其他消费者。
- 运行时断言（✅已探明）：`pm.getPiVersion()` 带缓存；`app.info` 推送路径 `sendInitialState` 首推 + 本次补发，前端行为无差。

**D8-3：迁移 promise gate**。
- 选择：`migrationReady = migrateProviderConfig(...).catch(() => {})`（**审查修正：必须显式 catch——迁移失败时 caller 层 try/catch 的 reject 若不吞掉，`await migrationReady` 会 reject，「gate 恒 resolve」的承诺落空**）；`createSession`/`restoreSession` 路径在 spawn pi 前 `await migrationReady`。
- 证据：注释约束「首次 session spawn 前完成」；迁移通常 < 100ms，gate 等待不可感知；失败不阻塞的既有语义保持（gate 在失败路径仍 resolve）。
- **迁移窗口的瞬时陈旧（审查补充，显式声明）**：gate 只挡 session spawn，不挡 provider 查询——`config.providers`/`model.list`（`listProviders` 实时读文件，无内存缓存）在迁移完成前到达的 renderer 可能读到迁移前列表。窗口 < 100ms：声明「首连用户极小概率读到迁移前 provider 列表、随后重连/下次拉取即正确」为可接受；若实测不可接受，再加 provider 查询 gate（本设计默认不加）。
- 被否：gate 只挡 createSession 不挡 restore——两者都会 spawn pi 进程，都必须 gate。

**D10-1：日志写模型 = WriteStream 缓冲 + 退出 flush（两条日志的丢尾容忍度分开处理，审查修正）**。
- 选择：主日志与 pi session log 均改为 `createWriteStream(flags:'a')` 常驻写流（按日期惰性打开）；轮转判定改为「按写入字节计数」替代 statSync（消除同步写的唯一理由）。
- **丢尾容忍度分档（初稿把「纯人类诊断可丢尾」从主日志推广到 pi session log，已修正）**：
  - **主日志**：纯诊断，缓冲写 + 退出 flush，硬崩溃丢缓冲尾可接受。
  - **pi session log**：使命是「pi 卡死诊断的决定性证据」（logger.ts 第 4-7 行 [HISTORICAL]）——**pi 静默卡死时 session JSONL 并不持久化**（无 assistant 首条消息不 flush，规则 #6），tee 日志是唯一证据；丢尾部几行 = 丢掉「pi 挂在最后哪一步」的冒烟证据。定案：**缓冲写必须与「优雅退出 await flush」配套**——SIGINT/SIGTERM/pi 进程 exit 的 shutdown 链改为 `await piSessionLog.end()（及主日志 end）→ process.exit(0)`（现状 `closeLogger(); process.exit(0)` 同步链必须改等待）；**硬崩溃（SIGKILL/断电）丢尾如实声明为取证能力削弱**，且声明「卡死场景 session JSONL 同样缺位」——**不再以「session JSONL 不受影响」兜底**。
- **轮转的 rename-with-open-stream（审查补充）**：字节计数只解决「阈值判定」，不解决「rename 一个写流已打开的文件」——macOS 允许 rename 打开中文件，Windows 失败。定案：轮转时先 `await` 旧流 `end()/close` 再 rename（或轮转时重建流指向新 fd），并把该平台路径列入 §5 验证点。
- 证据：无自动化读取日志（探明）；`logger.ts:84-85` 的同步理由（size 读真）被字节计数方案替代。
- 被否：内存队列批量 flush——多一层缓冲与定时器，WriteStream 已内置缓冲，无增益。

**D10-2：pi session log 的 end() 语义保持**。
- 选择：保留现有「end 后 write 为 no-op」接口形状（`PiSessionLog`），内部从 appendFileSync 换成写流引用；`end()` 关闭该 session 的写流。
- 证据：`rpc-client.ts:256` 的调用形状不变；多个 session 并发写独立文件（独立写流），无竞争。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 冷启动应用，测量到 runtime ready 的时长 | 计时（主进程日志的 waitForHealth 成功时刻，或直接观察 UI 出现时间） | ready 时长较改造前缩短（改造前基线 = 三个同步迁移 + 两个 await 迁移 + getPiVersion + 构造）；缩短量 ≈ 迁移与 piVersion 探测耗时之和 | 目标 1 |
| V2 | 启动后立即观察侧栏版本标签 | 看标签内容变化 | 先显示应用版本（pi 版本为 unknown），1-2 秒内自动变为完整版本串，无手动刷新 | 目标 2 |
| V3 | 启动后立刻（迁移完成前）创建 session | 抢在迁移窗口内发消息（**迁移窗口 <100ms 难以手动稳定复现——实施时注入临时延迟（如迁移前 sleep 1s 的调试开关）制造可控窗口，验收后移除**） | session 正常创建（gate 等待），配置正确（迁移已完成）；无竞态错误 | 目标 4 |
| V4 | streaming 全程监控事件循环阻塞 | agent 跑一轮多工具任务，探针记录阻塞（**具体化：event-loop lag 打点 + 每次 write 前打点对比改造前后 IO 次数；`pi-*.jsonl` 行级 diff 抽样验证内容一致**） | streaming 期间无每事件同步盘写（改造前基线对比）；`pi-*.jsonl` 日志内容与改造前一致（行级 diff 抽样） | 目标 3 |
| V5 | 正常退出应用后检查日志文件 | 退出后查看 `pi-*.jsonl` 尾部 | 尾部包含退出前最后的 pi 事件（flush 生效，无丢失窗口） | 目标 3 |
| V6 | 日志轮转：让日志文件跨天/超阈值 | 观察轮转行为 | 轮转按写入字节计数正确触发（异步化后不依赖 statSync） | 目标 3 |

---

## §5 下一层拆分

实施路径：启动编排与日志改造相互独立，可并行：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | index.ts 启动链重排（listen 提前 + 后台初始化块） | 收益主体，行为可逐项验证 | `index.ts` |
| U2 | piVersion 惰性 + app.info 补发 | 小改动，独立验证（V2） | `index.ts`、`message-broker.ts`（复用 buildAppInfoMsg） |
| U3 | 迁移 promise gate | 正确性保障（V3） | `index.ts`、`session-lifecycle.ts`（create/restore await gate） |
| U4 | 日志 WriteStream 化（pi log + 主日志）+ 字节计数轮转 + 退出 flush | 热路径 IO 治理 | `logger.ts`（writeLogEntry/createPiSessionLog/rotateIfNeeded/closeLogger） |

**待验证检查点**：
- **「启动延迟 = 串行等待之和」的实测分解探针（审查补充，⛔ 实施前）**：在 `main()` 内 listen 前各段打点（三个同步迁移 / await 迁移A / await 迁移B / getPiVersion 各自耗时），确认被后置项确为可感知主导项。若实测缩短量 < 100-200ms，重估 D8 是否值得其重排 + gate 注入的风险（迁移幂等快速常态 no-op 时 D8 收益可能仅为数百 ms）。
- `closeLogger` 的退出钩子覆盖：runtime 进程被 Electron supervisor kill 时是否走得到 flush（SIGTERM 处理）；**shutdown 链必须 `await` 写流 `end()` 后再 `process.exit(0)`（D10-1 分档承诺的配套）**；若 kill 是 SIGKILL，接受丢尾（已在风险声明，且 pi session log 的取证削弱已如实声明）。
- **「migrateBuiltinExtensions 先于 checkAndAutoUpgrade」门禁（⛔）**：实施 U1 时以代码注释 + 测试断言双重固定该串行次序，防止未来重排回归「autoUpgrade 升级打包内置包」。
- **轮转 rename-with-open-stream 平台路径（⛔）**：Windows 下 rename 打开中的文件失败——轮转实现必须先 end/close 旧流再 rename（或重建流），三平台各验一次。
- 迁移 gate 与 `restoreSession` 的启动时恢复路径的交互（启动时恢复的 session 是否也要等迁移——应一致 gate）。
- 写流按日期惰性打开的并发语义（多个 session 同日同文件？——pi session log 每 session 独立文件，主日志单文件，无并发冲突；跨天轮转的竞态以单写流串行处理）。
