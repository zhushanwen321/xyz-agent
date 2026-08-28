# update-observability.md 对抗式审查报告

> 审查对象：`docs/design/update-observability.md`（升级链路可观测性与代理体验修复）
> 审查依据：`tech-design` skill `review/rubric-design-doc.md`（P0/P1 检查项）
> 审查方式：所有代码事实均亲自 read/grep 本仓源码核实，行号以当前 worktree（feat-upgrade-failed）为准。

## Summary

**6 must-fix, 9 suggestions.**

方案的总体方向（错误码收敛 + suggestion 透传 + toast + 落盘）成立，§2 诊断的五个断点中四个属实且定位精确。但存在六处必须修正的问题：一处关键机制描述与源码相反（toUserFriendly）、两处方案覆盖面遗漏（多段下载分类缺失、预下载失败不落盘）、一处运行时断言与启动时序事实矛盾且无降级路径（launchResult 竞态）、一处状态集合事实错误（rolled-back 不在 failed 分支）、一处 Wave 文件清单错漏（index.d.ts 无需改、真正要改的类型点漏列）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2.2 断点链 / §2.1 例 B | P0-11 事实 | toUserFriendly 机制描述与源码相反：映射命中的错误返回**映射表中文 message**（用户现状看到「网络连接失败」），不是文档声称的英文技术串 | 修正 §2.2 机制描述与例 B 症状；叙事改为「message 通用无 cause、suggestion 被类型丢弃」 |
| MUST_FIX | §3.3 D1 | P0-12 遗漏 | 多段下载 downloadPart 的 fetch（download-asset.ts:647）**无任何错误分类**，raw undici 错误直达 handler else 分支——D1「同一错误码在不同入口产生同一文案」的收敛声明不成立 | downloadPart/downloadMultiPart 失败路径也接入 net-errors 分类 |
| MUST_FIX | §3.3 D7 | P0-12 遗漏 | 落盘点枚举漏了后台预下载失败路径（preloadUpdateSilently catch 仅 console.warn）——在本设计针对的诊断环境里，这是每次 check 都会发生的第一失败现场，零落盘零事件 | D7 落盘点增加 `source: 'preload'` |
| MUST_FIX | §3.2 D4-A 行 / §3.3 D5 | P0-16 探针 | 「事件时序在 window ready 后，无竞态」断言与 main.ts:277-284 实序矛盾（cleanup 在窗口创建**之前**跑）；「沿用 update:progress 判活模式」是无效先例；checkpoint 2 无降级路径 | 给出构造性无丢失机制（见 M4 详述），删除「无竞态」断言 |
| MUST_FIX | §3.3 D5 / §5 W4 | P0-11 事实 | 「failed 分支覆盖 self-healer 回滚告知」不成立：回滚写 `status='rolled-back'`，不在 launchResult `{done\|failed}` 联合内，回滚场景依旧静默 | 状态联合扩为 done\|failed\|rolled-back，或删除该声明 |
| MUST_FIX | §5 W2 / 文件改动地图 | P0-12 遗漏 | W2 列入 `preload/index.d.ts` 是错的方向（它是 preload.ts 的 type-only re-export，自动跟随）；真正需同步的 renderer 侧类型点 `lib/ipc.ts:289/328` 与 `api/domains/settings.ts:177` 未入任何 Wave | 修正 W2 文件清单与改动地图 |
| SUGGESTION | §2.2 | P1-8 事实 | 「映射表 9 个错误码」实为 **8 个**（types.ts:55-105 逐一清点） | 改正计数 |
| SUGGESTION | §3.3 D5 | P1-8 事实 | 「现返回 boolean」错误：cleanupCompletedUpdate 现返回 `Promise<void>`（update-self-healer.ts:207）；返回 boolean 的是 maybeRollbackInterruptedUpdate | 修正现状描述 |
| SUGGESTION | §2.1 例 C / §3.3 D8 | P1-8 事实 | 行号偏移：UpdateButton hover 标题实为 :28（文档写 48）；确认安装 Dialog version 实为 :141-142（文档写 138）；UpdatePage testFailed 渲染实为 ~:136-140（文档写 155） | 按源码修正行号 |
| SUGGESTION | §4 A5 | P1-10 验收 | A5「dev mock release 或等待下一版本发布」与 §4 头部「全部真实环境、非单测非 mock」自相矛盾；「等待发布」使验收不可即时执行 | 固定走 dev mock 并明示该条为 UI 渲染层验收（网络真实性已由 A1-A4 覆盖） |
| SUGGESTION | §3.3 D2 | P1 边界 | isPrivateHost 判定面假阴性未声明：RFC1918 只覆盖 IPv4 字面量，IPv6 ULA（fc00::/7）/ hostname 形式（`nas.local`、ddns 域名解析到局域网 IP）的代理会落通用文案——与「误判率仅剩局域网代理但权限已开」的说法不符 | D2 至少声明该局限；或 hostname 先解析再判网段 |
| SUGGESTION | §3.1 场景 1 vs §3.3 D2 vs §4 A1 | P1-5 一致性 | 三处 message 模板不一致：场景 1 摘要含「(EHOSTUNREACH)」，D2 映射表 message 无 code，A1 通过标准要求摘要含 EHOSTUNREACH 字样——按 D2 文案实现则 A1 不过 | 映射表 message 模板统一带 `(EHOSTUNREACH)` 形态 |
| SUGGESTION | §3.3 D7 | P1 契约 | log entry 的 `rawCause` / `proxyUrl` 字段取得路径未定义：UpdateError 无 cause 字段（handler catch 只见 UpdateError）；download/install handler 现不持有 proxyConfig | 说明扩展 UpdateError（readonly rawCause）+ handler 侧 readProxyConfig() |
| SUGGESTION | §4 A6 | P1-10 验收 | 「nc -l 不适用」论断存疑：ProxyAgent 对 https 目标发 `CONNECT api.github.com:443`，本地 `nc -l` 即可收到 CONNECT 行，是比「与用户确认代理面板」更确定性的证据手段 | A6 补充本地监听 CONNECT 行作为兜底验证手段 |
| SUGGESTION | §3.3 D8 待验证检查点 1 | P1-8 事实 | 「renderer 获取 currentVersion 的既有通道」在设计期即可解答：`__APP_VERSION__`（vite.config.ts:23 注入，useAppUpdate.ts restorePreloadedUpdate 已在用），无需新 IPC，也无需「getPending 顺带带出」的猜测 | 检查点 1 直接改为「用现有 __APP_VERSION__」 |

## Must-Fix 详述

### M1（P0-11）§2.2 断点链 / §2.1 例 B：toUserFriendly 机制描述与源码相反

- **位置**：§2.2「main catch → UpdateError.toUserFriendly()」段（「message 覆盖为英文技术串（toUserFriendly 返回 this.message，仅 suggestion 保留映射表的）」）及数据流图末行「用户眼前：'download failed: fetch failed'」；§2.1 例 B「浮层内容同样是 download failed: fetch failed（英文技术文案）」。
- **问题**：源码 `toUserFriendly()`（types.ts:161-186）在 errorCode 命中映射表时返回 `message: info.message`——即**映射表的中文文案**，不是 `this.message`。EHOSTUNREACH 落 UPDATE_NETWORK_FAILED（映射命中）后，用户 hover 实际看到的是中文「网络连接失败」+（类型上被丢弃的）suggestion，而非英文 'download failed: fetch failed'。英文串只存在于 errorCode 缺失/未映射的 else 分支。
- **证据**：`apps/electron/main/update/types.ts:161-186`（`return { code: this.errorCode, message: info.message, stage: this.stage, suggestion: info.suggestion }`）；update-handlers.ts 三个 handler catch 均调 `err.toUserFriendly()` 后取 `f.message`。
- **影响**：错误链路设计的叙事基础。若实施者按文档理解去「修 toUserFriendly 返回 this.message」，反而把已中文化的 message 打回英文。症状结论（用户看不到真实原因）仍成立，但缺失层是「cause 分类 + suggestion 透传」，不是「message 是英文」。
- **建议修法**：§2.2 修正为「分类命中时 message 是映射表通用中文（无 cause 信息、无权限场景），suggestion 因类型契约丢失」；例 B 的引用串改为「网络连接失败」。

### M2（P0-12）§3.3 D1：多段下载路径无分类，收敛声明不成立

- **位置**：D1「download-asset.ts 的内联分类与 testProxyConnection 都改为调用它」+ 效果声明「同一个错误码在不同入口（测试/下载/预下载）产生同一个用户文案」。
- **问题**：download-asset.ts 有三处 fetch——单段主 fetch（:311，有分类）、probeMultiPartSupport（:588，失败静默吞、回退单段，可接受）、**downloadPart（:647，无任何分类）**。downloadPart 的 fetch 抛错经 downloadMultiPart catch（清理后原样 re-throw）直达 update:download handler 的 else 分支：`errorCode: undefined, message: 'fetch failed', suggestion: '请重试或联系技术支持'`——正是 G1 要消灭的形态。186MB 产物 ≥ MIN_MULTI_PART_SIZE(10MB)，代理可用时默认走多段；probe 成功后 part 阶段代理挂掉/连接被拦（如权限中途被收回、代理进程崩溃）即命中此路径。
- **证据**：`download-asset.ts:640-660`（downloadPart try/catch 只清理重抛）、`:700-710`（downloadMultiPart catch 同样原样 re-throw）；update-handlers.ts update:download catch 的 else 分支。
- **建议修法**：D1 范围明确包含 downloadPart（catch 内经 extractNetErrorCode 分类为 UpdateError 再抛），或 downloadMultiPart 外层统一包装；A2 补一条多段路径的错误呈现验收（可用「下载中途停代理」触发）。

### M3（P0-12）§3.3 D7：落盘点漏后台预下载失败路径

- **位置**：D7 落盘点枚举「testProxyConnection 失败、三个 update:* handler 的 catch、launchResult failed」。
- **问题**：后台预下载 `preloadUpdateSilently` 的 catch 仅 `console.warn('[preload] background pre-download failed...')`（update-handlers.ts:152-165），无 update:error 事件（设计上静默）。在本设计针对的诊断环境（本地网络权限拦截）里，`update:check` 检测到新版且预下载开关开时，**每次 check 都先在这里静默失败一次**——这是失败的第一现场，零落盘。G6「下次排查不用复现」在该场景破洞：用户报「升级失败」时，日志里只有后续手动触发的 perform/download 记录，最频繁的失败源不可见。
- **证据**：`update-handlers.ts:143-166`（preloadUpdateSilently 全文）；`update:check` handler 中 `settings.preDownload` 触发链。
- **建议修法**：D7 落盘点增加 `source: 'preload'`（appendUpdateError 在 preloadUpdateSilently catch 调用）；§4 A7 的「任意失败后」明确包含预下载失败。

### M4（P0-16）§3.2 D4-A / §3.3 D5：launchResult「无竞态」断言与启动时序事实矛盾，且无降级路径

- **位置**：§3.2 D4 对比表 A 行风险列「低；事件时序在 window ready 后，无竞态」；D5 接管副作用枚举「沿用 update:progress 的 getMainWindow() 判活模式」；待验证检查点 2。
- **问题**（三点）：
  1. **事实矛盾**：main.ts 启动序列是 `maybeRollbackInterruptedUpdate() → cleanupCompletedUpdate() → bootstrapMainWindow()`（main.ts:277-284，注释明言自愈「必须在 bootstrapMainWindow 之前」）。cleanup 读到终态时窗口尚不存在，`win.webContents.send` 必然丢弃——「事件时序在 window ready 后」作为风险低论的依据不成立，事件必须缓存延后发。
  2. **先例无效**：update:progress/error 只在用户触发 update:download/install 之后发送，renderer 早已订阅，从不存在冷启动竞态；launchResult 是唯一的「启动即发」事件，「沿用判活模式」防的是窗口销毁，防不了 renderer 未订阅（订阅发生在 useAppUpdate 首个消费者 setup 时，与 did-finish-load 的先后无构造性保证）。
  3. **无降级路径**：检查点 2 只写「did-finish-load 后发送并验证冷启动场景」——若验证发现丢失，方案怎么调整没写（P0-16：⛔ 实施期门探针无降级路径 = 单点依赖）。且 G4/A3 的成败完全押在这个待验证时序上。
- **证据**：`main.ts:273-284`；`useAppUpdate.ts` subscribeProgress（订阅时机 = 首个组件 setup）；preload.ts onUpdateError 注册机制（renderer 调用包装函数时才 ipcRenderer.on）。
- **建议修法**：改为构造性无丢失机制。最简：main 把终态缓存到变量，renderer 启动期**已有**的 invoke（initAutoCheck → getPendingUpdate/getPreloaded，useAppUpdate.ts:restorePendingUpdate 链）作为 flush 时机——main 收到该 invoke 时若缓存未消费则补发 launchResult（或直接在响应里带出）；或接受被否的方案 B 形态但补「consumed 一次性标志」解决其去重顾虑。同时删除 3.2 表中「无竞态」表述。

### M5（P0-11）§3.3 D5 / §5 W4：「failed 分支覆盖 self-healer 回滚告知」不成立

- **位置**：D5「failed → warning toast（『上次升级未完成，已恢复』——self-healer 回滚场景）」；W4 justification「failed 分支覆盖 self-healer 回滚告知」。
- **问题**：self-healer 回滚写的是 `status: 'rolled-back'`（update-self-healer.ts:96-99 corrupt-result 回滚、:145-152 正常回滚），`'failed'` 只由 updater.sh 替换脚本写入。launchResult payload 联合是 `{status:'done'|'failed'}`——按文档实现，回滚场景（升级中途断电/强杀后重启）不产生任何事件，用户回到旧版零反馈，恰是 D5 声称已覆盖的静默结局。
- **证据**：update-self-healer.ts 上述两处 `JSON.stringify({status:'rolled-back',...})`；updater-script.ts:162/187/233/255 才是 'failed' 写入点；types.ts UpdateResultStatus 五值联合。
- **建议修法**：launchResult status 联合扩为 `'done'|'failed'|'rolled-back'`（'no-op' 无需通知），rolled-back → warning toast；或若确认不做，删除两处「覆盖回滚告知」声明。

### M6（P0-12）§5 W2 / 文件改动地图：类型同步面错漏

- **位置**：W2 主要文件列 `preload/index.d.ts`；改动地图「shared 类型变更（UpdateErrorPayload）需同步 preload/index.d.ts 与 renderer lib/ipc.ts 两处消费点」。
- **问题**：
  1. `preload/index.d.ts` 全文 16 行，是 preload.ts ElectronAPI 的 **type-only re-export**（头注释明言「单一来源……改 ElectronAPI 只需改 preload.ts，此处自动跟随」）——列它为待改文件是误导（对比：W4 列 preload.ts 而没列 index.d.ts，自相矛盾地做对了）。
  2. 真正的重复类型点未入 Wave：renderer `lib/ipc.ts:289`（onUpdateError 包装签名 `{stage, message, errorCode?}`——**断点 2 的同款丢 suggestion 类型在 renderer 层还有一份**，只改 preload 不改它，suggestion 在 lib/ipc 层类型上仍被丢）、`lib/ipc.ts:328` 与 `api/domains/settings.ts:177`（testProxy 返回类型 `{success, message?}`——W2 把返回结构改为 `{success, code?, message?, suggestion?}` 后这两处消费点必须同步）。lib/ipc.ts 仅在改动地图的备注里被顺带提了一句，未落到任何 Wave 的文件列；api/domains/settings.ts 全文未提。
- **证据**：`apps/electron/preload/index.d.ts:1-16`；`packages/renderer/src/lib/ipc.ts:289,328`；`packages/renderer/src/api/domains/settings.ts:161-179`。
- **建议修法**：W2 文件列去掉 index.d.ts；W2（testProxy 契约）或 W3 增列 `packages/renderer/src/lib/ipc.ts` 与 `packages/renderer/src/api/domains/settings.ts`；改动地图的「两处消费点」改为「lib/ipc.ts + api/domains/settings.ts」。

## 核实通过的事实清单

以下引用均亲自 read/grep 源码核实属实（抽样列举关键项）：

- §2.1 例 A：testProxy catch 只取外层 message（update-handlers.ts:105-108，`err instanceof Error ? err.message : String(err)`）；UpdatePage 单行 `testFailed: '代理连接失败: {msg}'`（zh-CN/settings.ts:751）。
- §2.2 断点 1：download-asset.ts:276 分类只 includes 匹配 `fetchErr.message`，五码列表无 EHOSTUNREACH，兜底 `download failed: ${fetchErr.message}`（:297-299）——行号 276 精确命中。
- §2.2 断点 2：preload.ts:290 onUpdateError 类型 `{stage, message, errorCode}` 无 suggestion——精确命中；且 main 侧 runtime **已经在发** suggestion（handler catch 的 errorPayload 含 suggestion，webContents.send 原样发），丢失发生在类型契约层（文档此点定性准确）。
- §2.2 断点 3/4：useAppUpdate 单例 reactive state 无 errorSuggestion（state 定义）；UpdateButton error 态 hover-only（:96-111），无 toast 接入。
- §2.2 断点 5：`~/.xyz-agent/logs/` 实测只有 runtime/pi 产物（electron-runtime-stderr.log + pi-*.jsonl），无主进程日志——「console.error 进虚空」属实。
- D1 证据：download-asset.ts:258-300 内联分类存在；proxy-config.ts 头注释 B-1 drift 教训存在（:5-7）。
- D4 证据：useAppUpdate 单例范式注释（文件头）；useToast 基建存在（useToast.ts + App.vue:31 ToastContainer），MAX_IN_FLIGHT/droppedCount 属实（useToast.ts:11-12,77,88）；toast 单次弹出由 refCount 单订阅构造性保证（subscribeProgress）——该决策经攻击后成立。
- D5 证据：main.ts:280 cleanupCompletedUpdate 位置、updater-script.ts:200 done 写入（精确行号命中）；update-result.json 含 `{status, version, at, error?}`——{status, version} payload 可行。
- D6 证据：release-checker.ts:184-204 fetchGitHubLatestRelease 全局 fetch 无 dispatcher（行号基本命中）；FETCH_TIMEOUT_MS=10_000（:48），双倍超时最坏 20s 已如实声明且与 A6 一致；resolveDispatcher（update-handlers.ts:46）确有同构实现可复用；resolveProxyUrl（proxy-config.ts:249-261）三种 mode 语义与 D6 前提一致。
- D8 证据：UpdateButton hover 标题只用固定文案 `sidebar.update.newVersion`（:28），确认 Dialog 已用 `state.latestRelease?.version`（:141-142）——现状描述属实。
- 常量与目录：UPDATE_DIR（constants.ts:21）存在，update-error.log 路径方案可行；轮转上限 512KB×2=1MB 与 A7 一致。
- 现有测试无全量 state 快照（useAppUpdate.test.ts / UpdateButton.test.ts 均为字段级断言）——state 加字段不破坏现有测试，此风险不存在。

## 攻击过但未攻破的角度

- **D2 条件判定主干**：macOS+EHOSTUNREACH+RFC1918 三条件对已诊断场景精确；被否方案（无条件提示/复用 PROXY_ERROR 407 语义）的反驳成立（UPDATER_PROXY_ERROR 现映射确为「代理配置错误」且仅 407 触发，混入可达性问题会污染指引）。残留弱点仅 S5/S6 所述边界与文案一致性。
- **D4 触发点选择**：组件层 toast 会多实例重复弹的担忧属实（UpdateButton 可在 Sidebar/设置页多挂载）；composable 单例 + refCount 单订阅是正确落点。
- **D6 降级直连**：纯代理方案「比现状倒退」与直连优先「先吃超时」的反驳均成立；EHOSTUNREACH 快速失败下降级延迟可忽略，慢失败 20s 上限已进验收。
- **G1-G6 因果链**：逐目标回溯，六个目标均有对应决策与验收（A1-A7）覆盖，无「方案解决的不是目标问题」的错位；M2/M3/M5 修复后链路闭合。
- **§1 问题定义**：SCQA 忠于真实问题（用户看不到原因），且识别了用户未表达的深层问题（取证缺失、成功无反馈、检查更新不走代理），无「复述用户给的方案」病症。
