# Runtime 流级故障隔离与防复发护栏设计

> 一句话结论：runtime 中连接级流错误（EPIPE / ECONNRESET / readline 转发）存在多条逃逸为 uncaughtException 的路径，任一触发即整机 graceful shutdown、全部 session 中断；本设计以「源头修复 + 运行时分级 + 静态护栏」三层防护把流级故障隔离在连接级（L0），并保持逻辑级异常的整机快速恢复语义不变。

- 层级声明：当前层 = runtime 故障隔离机制设计 → 下一层 = 已实现的技术方案（层敏感准则全适用：运行时行为 / 数据流 / 错误处理全涉及）
- 状态：已实施（fix-runtime-restart 分支）；实施明细见 §5 状态表；S1 真机验收为发版后门（见 §4）
- 关联：[constraints.json](../constraints.json)（如需登记 C-runtime 级约束，见 §5 后续）；[troubleshooting.md](../troubleshooting.md)

## 1. 背景目标

**S（情境）**：xyz-agent 的 runtime 是单进程 Node.js 服务，托管全部 session 的 pi 子进程、subagent relay 子进程与 plugin worker，由 Electron 侧 supervisor（runtime-supervisor + restart-policy + health-checker）按退避策略自动重启。

**C（冲突）**：2026-09-04 12:04，一条 subagent relay 连接的对端（pi 侧代理进程）退出后，runtime 在 1 秒内整机崩溃重启——正在执行的多个 session 任务被 SIGTERM 打断，~16 秒后 Electron 拉起新 runtime 恢复会话。

**Q（问题）**：一条已死连接上的流写入，为什么会升级成整机故障？系统的健壮性与隔离性靠什么保证，如何防止同类问题再次引入？

**A（答案）**：流写逃逸有三条机制性路径（裸流写 / socket error 无 listener / readline 转发），全部堵在连接级；进程级兜底按「连接级噪声 vs 逻辑级崩溃」分级，未知流错误不再触发整机 shutdown；静态护栏在 pre-commit / CI 拦截新增裸写点。

### 设计目标（从使用者体验倒推）

使用者 = 在太极桌面端同时开多个 session 干活的开发者（用户），以及给 runtime 写代码的工程师（开发者）。

| # | 目标 | 使用者可见标准 |
|---|------|--------------|
| G1 | 已知流写逃逸路径全部堵在连接级 | 用户：某条 subagent 连接异常断开时，其他 session 的任务不中断、无「runtime 重启」提示 |
| G2 | 未知流级错误不再触发整机 shutdown | 用户：即使出现新的流错误形态，runtime 不重启，仅日志多一条 contained 记录 |
| G3 | 新增裸写点在提交前被拦截 | 开发者：写出无防护的 `conn.write` / 无 error listener 的 socket 接收 / 无吞咽的 readline 时，pre-commit 红 + 恢复指引 |
| G4 | 逻辑级异常维持整机快速恢复（既有能力，不回退） | 用户：runtime 真崩溃时仍自动重启并恢复 session 列表（既有 ~16s） |

### Scope

- **In**：runtime 内全部流路径（relay conn / pi stdin·stdout / usage 文件流 / readline）的逃逸点修复；uncaughtException 分级策略；静态护栏脚本 + pre-commit/CI 接入。
- **Out of scope**：per-session runtime 进程隔离（§3.2 方案 C，评估后否决）；Electron supervisor 重启策略改进（既有机制已满足 G4）；崩溃瞬间在途 turn 的数据保全（§5 残留观察项）；extension 侧（pi- 子进程内）的同类加固——那是另一进程边界，见 §5 后续。

## 2. 现状与问题分析

**本章结论：事故不是孤立 bug，而是三条机制性逃逸路径中第一条被触发；审计在 runtime 内共确认 5 处真实逃逸点、4 条已达标防线。**

### 2.1 事故时间线（取自 `~/.xyz-agent/logs/`，2026-09-04）

```
12:04:02.132  [ERROR] [runtime] *** UNCAUGHT EXCEPTION *** (attempting graceful shutdown):
              Error: This socket has been ended by the other party { code: 'EPIPE' }
              at Socket.writeAfterFIN [as write]
              at writeFrame (dist/runtime/index.cjs:67968)
              at Socket.<anonymous> (index.cjs:68159)     ← child.stdout 'data' 回调
12:04:02.4~0.7 所有 pi 子进程被 SIGTERM（code=143）· relay 子进程 kill-on-disconnect
              · plugin worker 退出 ← 用户「执行到一半」的任务在此被打断
12:04:18.817  Electron supervisor 自动重启 runtime（ensureActive: restoring 恢复 sessions）
```

### 2.2 根因机制：半关闭窗口的同步抛

物理数据流（relay 字节泵，事故点加粗）：

```
subagent 子进程 stdout ──'data' 事件──▶ runtime relay-registry
                                          │ **writeFrame(conn, up帧)**  ← 事故点
                                          ▼
                              unix domain socket（半关闭窗口）
                                          │ FIN 已达 / 本端未 destroy
                                          ▼
                              pi 侧代理进程（已退出）→ extension
```

时序（`(1) 对端进程退出 → (2) TCP FIN 到达 runtime 侧 conn → (3) Node 默认 allowHalfOpen=false，conn 自动 end()，writableEnded=true 但 destroyed=false → (4) 子进程 stdout 还有残留数据到达 → (5) 'data' 回调里 writeFrame 写 conn → writeAfterFIN 同步抛 EPIPE → (6) 回调内无捕获 → uncaughtException → 整机 shutdown`）。

关键事实（决定修复形态）：`conn.destroyed` guard 防不住这个窗口——FIN 后 destroyed 仍是 false；`conn.write()` 在 writableEnded 的 socket 上**同步抛**（不是异步 error 事件），try/catch 是唯一捕获点。

### 2.3 逃逸路径全景（审计结论）

三条机制性路径，审计覆盖 runtime 全部流操作点（socket / ws / stdio / 文件流）：

| 路径 | 机制 | 真实逃逸点（审计发现） | 已达标防线（审计确认无需改） |
|---|---|---|---|
| R1 裸流写 | 半关闭/destroyed 流上 `.write()`/`.end()` 同步抛 | ① relay-registry `writeFrame`（事故根因）② 7 处裸 `conn.end()` ③ relay child stdin write | rpc-client sendRaw/sendCommand（try 已包）；broker send/broadcast（readyState guard + per-client try）；ws.send 全链（connection-manager 挂了 ws error listener） |
| R2 socket error 无 listener | 对端 RST → 'error' 事件无 listener → EventEmitter emit 直接 throw | ④ relay-server `handleConnection(conn)` 未挂 `conn.on('error')` | relay probeStaleSocket 的 probe socket（once('error') 已挂）；wss/httpServer（error 已接） |
| R4 readline 转发 | readline 把 input 流 error **转发到 interface 实例 re-emit**，rl 无 listener 同样 throw | ⑤ relay-registry 的 rl（input=conn）⑥ rpc-client 的 rl（input=pi stdout，pi 崩溃时触发）⑦ usage-stats 的 rl（input=文件流，读失败时触发）+ 单文件失败会打断整个聚合 | ——（审计前无一处有防护） |

> R4 是实施期由回归测试实测抓出的：修复 R1/R2 后单测仍红，暴露 readline 转发是独立于 conn 层 listener 的第二条 throw 路径——conn 层挂 listener 挡不住它。

### 2.4 故障域分层（隔离性现状）

```
L0 单连接（relay conn / WS conn）  断连即杀 / 订阅清理        ← 审计前：错误可穿透到 L3（漏洞层）
L1 单 pi 会话进程                  rpc-client 捕获 + 会话内报错 ✅
L2 plugin worker                   Worker Thread + 宿主层第一道 ✅
L3 runtime 进程                    唯一整机故障域              ← 结构性现状（§3.2 方案 C 评估）
L4 Electron 容器                   supervisor 退避重启 ✅
```

## 3. 解决方案

**本章结论：三层防护（源头修复 / 运行时分级 / 静态护栏）组合使用——单层都不够；进程级隔离被否决。**

### 3.1 终态（使用者视角）

**用户侧**（G1/G2/G4）：

- subagent 代理进程崩溃 / 断网 / 被杀：该 subagent 报错终止，**其他 session 不受任何影响**，UI 无「runtime 重启」提示；
- runtime 日志（`<dataDir>/logs/runtime-<date>.log`）出现 `[relay] connection error, destroying: ...` 或 `[runtime] stream-level exception contained (no shutdown): ...`，进程存活；
- runtime 因逻辑级异常真崩溃：既有行为——整机重启 ~16s、session 列表恢复，与今天一致。

**开发者侧**（G3）：

```bash
$ git commit -m "feat: new relay handler"
[流写逃逸护栏]
✗ packages/runtime/src/infra/relay/new-handler.ts@42：流变量 `conn.write` 裸调用无 try 防护
  ——半关闭/destroyed 流上同步抛 EPIPE/ERR_STREAM_DESTROYED，事件回调中逃逸即
  uncaughtException → 整机 shutdown（2026-09-04 事故形态）。
  恢复动作：try-catch 包裹（参照 relay-registry writeFrame/endConn）；确属 best-effort
  误报形态则编辑 scripts/check-unsafe-stream-writes.allowlist.txt 登记
  `packages/runtime/src/infra/relay/new-handler.ts@42` 并随本次 commit 提交
```

失败路径与恢复指引（准则 6）：

| 场景 | 现象 | 恢复动作 |
|---|---|---|
| 分级白名单误豁免了真 bug（流错误码形态的逻辑异常被 log-continue 掩盖） | 某功能静默失效 + 日志有 `stream-level exception contained` 但行为异常 | grep `contained (no shutdown)` 定位来源 → 该异常本应在源头被 try 捕获并有处置，补源头修复 + 从源头调用点排除；**禁止**为掩盖问题把非流错误码加白名单（见 §3.3 D1 维护纪律） |
| 护栏误报（确属 best-effort 写形态） | pre-commit 红 | 编辑 [scripts/check-unsafe-stream-writes.allowlist.txt](../../scripts/check-unsafe-stream-writes.allowlist.txt) 登记 `路径@行号` 并随本次 commit 提交（唯一登记入口——pre-commit/CI 无参调用自动读取，CLI 传参不生效）。条目随代码行号漂移失效时对应违规重现，重新评估后更新行号或删除；失效/笔误条目由扫描末尾的 ⚠ 未命中告警暴露（提示清理，不改退出码） |
| rl 吞掉了本该处置的错误 | relay 数据转发静默断流 | relay 场景真处置在 conn 层（error listener 已 warn + destroy），rl 侧 no-op 只堵转发 throw；usage 场景真处置在聚合层（for-await catch → 空分片降级，见 D3）。排查看 `[relay] connection error` 日志行 |

### 3.2 多方案对比

| 维度 | A：仅源头修复（逐点 try） | B：三层防护（源头 + 分级 + 护栏）★推荐 | C：per-session 进程隔离 |
|---|---|---|---|
| 长期架构合理性 | 低——防护靠纪律，新增代码无约束，逃逸点会再长出来 | 高——源头消灭已知 + 兜底分级容忍未知 + 静态拦截新增，三层正交 | 中——隔离最彻底，但与「全部子进程同进程组、崩溃时整组收割」的进程安全设计冲突，状态共享（session service / message bus / plugin host）被迫拆分或跨进程化 |
| 短期实现成本 | 低（几处 try） | 中（5 处修复 + 1 模块 + 1 脚本 + 2 处接入，已实施） | 高（runtime 拆多进程 + IPC + Electron 侧多实例管理，量级是重写） |
| 风险 | 已知点修完仍防不住未知路径（R4 就是实施期才实测暴露的） | 分级白名单可能误豁免真 bug（论证见 D1 + 维护纪律兜底）；护栏启发式漏报（宁漏报不误报的取舍，见 D2） | 进程组收割主腿被拆散；16s 恢复换成更复杂的局部崩溃语义，引入新故障面 |

**推荐 B 并已实施。若用 A**：§2.3 的 R4 三处（⑤⑥⑦）在审计时就被漏掉——A 的「修已知点」模式天然漏新形态；readline 转发这条路径在修复 R1/R2 之前根本不在认知里。**若用 C**：§2.4 的 L3 单进程设计是崩溃安全（进程组收割）的主腿，拆分换来的隔离收益在 B 已把连接级故障全拦后剩余价值很低。

### 3.3 关键决策与权衡

**D1：uncaughtException 分级白名单（采用）vs 维持「任何 uncaught 即 shutdown」（被否）**

- 采用：`SAFE_STREAM_ERROR_CODES = { EPIPE, ECONNRESET, ECONNABORTED, ERR_STREAM_DESTROYED, ERR_STREAM_WRITE_AFTER_END }` 内的错误码 → log-continue；其余 → 维持 graceful shutdown + exit(1)。
- 依据：这五个错误码语义上产自 IO/流/文件描述符层（socket、pipe、stdio，含 TCP/Unix socket 上下文——ECONNABORTED 的 POSIX 定义覆盖 socket 关闭）；诚实错误的抛出点在流事件回调链内，不触碰 runtime 数据结构——**据此推断 log-continue 后进程状态可信。这是启发式论证而非证明**，已知反例：① 同步 fs 写（`writeFileSync` / `fs.writeSync` 写断管道）可在任意调用上下文同步抛 EPIPE——若发生在业务状态变更中途，log-continue 保留的是半 mutated 状态；② 第三方库可包装或伪造携带这些 code 的非流错误。接受反例存在的原因：误豁免可观测（`grep 'contained (no shutdown)'` 日志定位来源）且可回退（§3.1 失败路径表：源头补处置 + 收紧白名单），风险敞口有界。未知错误码（TypeError 等逻辑异常）语义上进程一致性不可保证，维持退出。
- 被否谱系：`维持全部 shutdown`——每次连接级噪声都拿全部 session 陪葬（本次事故即形态）；`per-error-code 计数熔断`——过度设计，流错误无害性有 IO 来源论证，无需熔断。
- 维护纪律（新增错误码的门槛）：必须论证「唯一来源是 IO 且影响限于单连接/单流」，禁止把业务异常错误码当良性处理。
- 效果探针：✅已测——`uncaught-policy.test.ts` 4 用例（事故原始形态 EPIPE + 文案判定 contained；TypeError/ENOENT/非 Error 判定不 contained）。

**D2：静态护栏用启发式而非类型级分析（采用）vs AST/类型分析（被否）**

- 采用：`scripts/check-unsafe-stream-writes.mjs` 三条规则（R1 裸流写需 try 窗口 / R2 socket 接收入口需 error listener / R4 readline 需吞转发；编号沿用 §2.3 审计路径命名，无 R3），正则 + 行窗口启发式。
- 取舍依据：**宁漏报不误报**——误报会逼人加豁免，豁免泛滥即护栏失效；漏报方向（try 在窗口内但不包裹命中行）只是放过已部分防护的代码。类型级分析需引入 TS compiler API 依赖，成本与收益不成比例。
- 漏报面明示（reviewer 心中留数）：R1 的覆盖对象 = 流变量**命名约定**清单（conn / socket / sock / probe / stdin / stdout / stderr），命名 `ws` / `client` / `stream` 等的流变量不在覆盖内——护栏绿不代表该类变量已防护；R2/R4 按结构形态（入口定义 / createInterface）匹配，无此限制。
- 豁免机制（唯一登记入口，仅 R1 有豁免通道——R2/R4 违规须直接修复代码）：误报/确属 best-effort 形态时，编辑随 git 跟踪的 [scripts/check-unsafe-stream-writes.allowlist.txt](../../scripts/check-unsafe-stream-writes.allowlist.txt) 登记 `路径@行号` 并随 commit 提交；pre-commit / CI 均无参调用，脚本自动读取该文件。**刻意不设 CLI 传参入口**——「当次传参绿、忘写文件 → CI 永久红」的登记断裂正是初版设计的缺陷（2026-09-04 对抗审查 MUST_FIX），双入口必复发，故砍掉。条目生命周期观测（双路）：失效/笔误条目由扫描末尾 ⚠ 未命中告警暴露（提示清理，不改退出码）；漂移条目错误豁免同文件同行号新违规的窗口由「ℹ 豁免命中」提示行承载（命中提示出现时须核对命中处确属登记时的误报形态）——不存在「豁免错附从不留痕」的形态，但需读者留意两处输出。
- 效果探针：✅已测——三条规则各做过负向验证（故意破坏防护 → 脚本红；还原 → 绿）+ allowlist 端到端（探针裸写 → 红 → 文件登记 → 无参调用绿 + 豁免命中提示）+ 未命中告警（移除登记 → ⚠ 告警、退出码不变），见 §5 状态表。

**D3：rl 层 no-op 吞转发（采用）vs rl 层完整处置（被否）**

- 采用：`rl.on('error', () => {})`，rl 侧只堵「转发 re-emit 无 listener → throw」这一条逃逸路径，**真实处置归各自的流/消费层**，三处归宿不同（勿一概而论）：⑤ relay——conn 层 error listener（destroy + warn）；⑥ rpc-client——input 是 pi stdout，pi 退出走 exit/kill 链路处置；⑦ usage-stats——input 是文件流，**没有 conn 层 listener**，真实处置 = for-await 的 try/catch → 单文件空分片降级（实现含 iterator rejection / 裸 emit 双保险，与 §2.3 ⑦「单文件失败会打断整个聚合」的修复前形态呼应）。
- 依据：readline 转发只是通知机制，同一个错误已由上述消费层处置，rl 侧再处置即重复；for-await 场景 iterator rejection 仍正常传播（多播不冲突）。
- 效果探针：✅已测——relay-registry.test.ts「RST 容错（单元级）」用例：`emit('error')` 在无 rl 吞咽时同步 throw（逃逸机制自证），有吞咽后 not.toThrow；usage 聚合的空分片降级回归在既有 usage 测试内（P5）。

**D4：writeFrame 双保险 guard + try（采用）vs 仅 guard（被否）**

- 采用：`if (conn.destroyed || conn.writableEnded) return` 之上再包 try。
- 依据：guard 覆盖半关闭（§2.2 机制），try 覆盖 destroy 竞态等未枚举形态——两者防御面不同。
- 效果探针：✅已测——「半关闭容错」集成用例：真 unix socket 对端 FIN + 假 pi 持续输出 500ms，修复前该场景即整机崩溃现场，修复后进程存活且新连接可握手。

### 3.4 探针清单

| # | 断言 | 探针 | 状态 |
|---|---|---|---|
| P1 | 对端 FIN 后子进程持续输出，runtime 不崩、注册表未坏 | relay-registry.test.ts「半关闭容错」（真 socket + 假 pi stream 模式，存活断言=新连接握手成功） | ✅已测 |
| P2 | conn 'error' 事件不逃逸（RST 场景） | relay-registry.test.ts「RST 容错（单元级）」（emit throw 机制自证 + not.toThrow） | ✅已测 |
| P3 | 分级策略三态判定（流码 contained / 逻辑码 shutdown / 非 Error 安全） | uncaught-policy.test.ts 4 用例 | ✅已测 |
| P4 | 护栏三条规则可拦截各自形态 | 负向验证（破坏 → 红 → 还原 → 绿，3 规则各一次） | ✅已测 |
| P5 | 单文件 usage 读取失败不打断聚合 | usage-stats 空分片降级路径（既有 usage 测试回归 76 绿内） | ✅已测 |
| P6 | 真机事故场景不复现（发版后） | §4 S1 | ⛔实施期门（降级路径：未发版时以 P1/P2 真 socket 集成证据 + dev 环境手工复现替代） |
| P7 | allowlist 豁免端到端可走通（G3 误报场景可达性）+ 条目生命周期观测 | 探针裸写文件 → 负向红 → allowlist.txt 登记 `路径@行号` → 无参调用（pre-commit/CI 同形态）绿 + 豁免命中提示输出；再移除命中（还原探针文件）→ ⚠ 未命中告警、退出码不变 | ✅已测（第 2 修复轮） |

## 4. 验收（真实场景）

**本章结论：核心验收是真机复现事故场景确认不再整机重启（S1，发版后门）；护栏与分级各有一个可在当前代码库直接执行的真实场景。**

### S1：真机事故复现 → runtime 不重启（回溯 G1/G2；探针 P6 ⛔ 发版后门）

- 场景：用户在打包版太极中同时跑主 session + subagent 任务（产生活跃 relay 连接）。
- 步骤：① 找到代理进程 `lsof <relay socket path>`（socket 路径见 `<dataDir>/relay-run/`，或日志 `[relay] server listening at ...`）；② `kill -9 <代理pid>`（对端异常退出=事故形态）；③ 观察 UI 与 `logs/runtime-<date>.log`。
- 通过标准：日志出现 `[relay] connection error` 或无异常静默清理；**无** `*** UNCAUGHT EXCEPTION ***`；**无** `ensureActive: restoring` 重启痕迹；其他 session 任务持续不中断。
- 当前状态：⛔ 需发版/打包后执行；降级路径——P1/P2 的真 unix socket + 真子进程集成测试已覆盖同一时序（半关闭 + 持续输出），dev 环境可按同步骤手工复现。

### S2：护栏拦截新增裸写点（回溯 G3；探针 P4 ✅ / P7 ✅）

- 场景：开发者新写一个 relay 连接处理器，裸调 `conn.write`。
- 步骤：① 在 `packages/runtime/src/infra/relay/` 任一文件加一行无 try 的 `conn.write('x')`；② `git add && git commit`。
- 通过标准：pre-commit 红在「流写逃逸护栏」段，输出含恢复指引；`node scripts/check-unsafe-stream-writes.mjs` 单独跑 exit 1；修复（加 try）后 commit 通过。
- 误报分支（G3 可达性关键）：确认属 best-effort 误报时，编辑 allowlist 文件登记条目并随 commit 提交 → pre-commit / CI（均无参调用，自动读文件）通过。**不允许存在「本地绿但 CI 红」的登记路径**。
- 已执行记录：✅ 负向验证三条规则均红、还原均绿（首轮实施实测）；allowlist 端到端（探针裸写 → 红 → 文件登记 → 无参调用绿 + 命中提示 → 还原）第 1 修复轮实测（P7）；未命中告警第 2 修复轮实测（见 P7 记录）。

### S3：分级策略对逃逸流错误 log-continue（回溯 G2；探针 P3 ✅ / 真机端到端随 S1）

- 场景：runtime 内出现一条未被源头拦截的流错误（模拟未来新增代码的漏网）。
- 步骤：① 判定逻辑：`cd packages/runtime && npx vitest run src/__tests__/infra/system/uncaught-policy.test.ts`（已锁三态判定）；② 真机端到端随 S1 同一场景观察日志。
- 通过标准：单测 4 用例绿；真机日志出现 `stream-level exception contained (no shutdown): Error... code EPIPE` 且 `/health` 端点 uptime 不归零（进程未重启）。

### S4：逻辑级异常整机恢复不回退（回溯 G4；既有能力回归）

- 场景：runtime 真崩溃（逻辑级异常）。
- 步骤：dev 运行中 `kill -9 <runtime pid>`。
- 通过标准：Electron 自动重启 runtime、session 列表恢复、UI 短暂「runtime 重启」后可用——与事故前既有行为一致（重启耗时 ≤ 既有 ~16s 量级）。

### 负面行为反向验证（必须有）

S1 的通过标准本身即含两条「不该发生的不发生」：无 UNCAUGHT EXCEPTION、无重启恢复痕迹；S2 验证「不该被提交的代码不被提交」。

## 5. 下一层拆分（实施状态）

**本章结论：全部拆分单元已实施并通过验证；两项残留观察项与一项后续登记。**

| 单元 | 内容 | why 这样拆 | 状态 |
|---|---|---|---|
| U1 源头修复 | relay-registry：writeFrame guard+try / endConn 替换 7 处裸 end / conn error listener / rl 吞转发 / child stdin write 防护 | 事故根因 + 同文件同族路径一次收口，P1/P2 探针同文件可测 | ✅ 实施完成 |
| U2 同族修复 | rpc-client rl 吞转发（pi stdout）；usage-stats rl 吞转发 + 单文件空分片降级 | R4 路径跨文件的两处实例，护栏 R4 规则倒逼收口 | ✅ 实施完成 |
| U3 运行时分级 | infra/system/uncaught-policy.ts + index.ts handler 接入 | 独立模块便于单测与复用（未来 main 进程如需同策略） | ✅ 实施完成 |
| U4 静态护栏 | scripts/check-unsafe-stream-writes.mjs（R1/R2/R4）+ 随 git 跟踪的 check-unsafe-stream-writes.allowlist.txt（唯一豁免登记入口，pre-commit/CI 无参自动读取）+ pre-commit 段 + ci.yml invariant | 脚本独立于被检代码；pre-commit 按 runtime 路径触发避免全量拖慢；allowlist 与代码同 commit 可审计 | ✅ 实施完成（修复轮 2026-09-04：allowlist 由 CLI 传参改为持久化文件——初版传参入口到不了无参调用的 pre-commit/CI，对抗审查 MUST_FIX） |
| U5 回归测试 | relay-registry.test.ts 2 个事故用例 + uncaught-policy.test.ts | 用例名标注事故日期与形态，防未来误删 | ✅ 实施完成 |

> **关于 pre-commit hook 位置**：本项目采用 bare repo + worktree 结构（见 [AGENTS.md](../../AGENTS.md)「目录结构」），全局 pre-commit hook 位于 `.bare/hooks/pre-commit`（worktree 外），由 git commondir 机制自动对所有 worktree 生效。本次修改的流写护栏段即在该文件中——所有 worktree（包括本 fix-runtime-restart worktree）共享同一份 hook。CI invariant 在 `.github/workflows/ci.yml` 中独立配置。

验证汇总：runtime 受影响面 vitest 76 passed（relay 25 / pi / usage / policy 4）；`tsc --noEmit` 通过；eslint `--max-warnings 0` 通过；护栏脚本 253 文件扫描绿。修复轮（2026-09-04 对抗审查后）复验：护栏正向绿 253 文件 / 负向红（探针裸写拦截）/ allowlist 端到端绿（P7 重演）；本轮仅动护栏脚本与文档，runtime 源码无改动，vitest/tsc/eslint 结论不受影响。

### 残留观察项（不阻塞，诚实登记）

1. **崩溃→恢复窗口丢在途 turn**：L3 真崩溃时正在生成的 turn 数据丢失（~16s 恢复期固有代价）。G2 落地后整机崩溃频率应大幅下降；若后续仍观察到流错误引发的 L3 故障，重新评估 turn 保全（属新设计，超出本层 scope）。
2. **extension 侧同族加固**：pi 子进程内（subagent-workflow 等 extension）的流错误处理是另一进程边界，其崩溃只影响单 session（L1 隔离成立），暂无整机风险——不纳入本期。

### 后续登记（建议）

- `SAFE_STREAM_ERROR_CODES` 白名单维护纪律（§3.3 D1）如需升级为机器强制，可登记 constraints.json 一条 C-runtime 级约束（执行方式=check 脚本 + review 检查项）；当前以文档纪律承载，暂不登记。
- contained 计数打点（D1 观测面增强）：对 `stream-level exception contained` 日志事件累计计数，异常高频（短窗口多次）时告警——把「误豁免掩盖真 bug」从人工 grep 升级为主动可观测。当前以日志 grep 承载（§3.1 失败路径表），无真实误豁免案例前不加机制。
