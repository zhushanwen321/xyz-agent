// src/execution/engine/engines/zcode/constants.ts
//
// ZcodeEngine 共享常量（P3）。独立成模块的原因：reader.ts 是双端复用的无状态模块
// （设计 §3.3.7：runtime 侧也会 import），它需要的常量不能连带 launcher/preparer
// 的模块级副作用（如 logger 初始化）一起加载——constants.ts 保持零 import 纯常量。

/** zcode 引擎的 registry key。 */
export const ZCODE_ENGINE_ID = "zcode";

/** zcode 适配器版本（handle.adapterVersion 数据源——golden 样本对齐排查锚点）。 */
export const ZCODE_ADAPTER_VERSION = "1.0.0";

/**
 * zcode CLI 缺省路径（12.4MB node bundle，不在 PATH——2026-08-25 实测）。
 * 组合根可用 deps.cliPath 覆盖（测试注入 / 未来安装形态变化）。
 */
export const ZCODE_CLI_DEFAULT_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

/**
 * 唯一凭据源 config（桌面端登录态，zsub V2_CONFIG_PATH 同构）。
 * 为什么绝不读 ~/.zcode/cli/config.json：它不在 ZCode GUI 管理面，可能残留历史
 * 验证配置（2026-08-25 事故：8/24 zsub 开发残留把默认模型劫持到失效 router 端点，
 * turn 0 即 401）；桌面端登录凭据落在 v2/config.json，是 zsub 生产验证过的凭据源。
 */
export const ZCODE_V2_CONFIG_PATH_SUFFIX = [".zcode", "v2", "config.json"] as const;

/** 池内 config.json 相对隔离 HOME 的位置（CLI 只读 $HOME/.zcode/cli/config.json）。 */
export const ZCODE_POOL_CONFIG_SUFFIX = [".zcode", "cli", "config.json"] as const;

/**
 * 池内 db.sqlite 相对隔离 HOME 的位置（handle.sessionRef.dbPath 的值——相对池目录
 * 自描述，read 时经 resolvePoolDir + 该相对路径重定位，设计 §3.3.6）。
 */
export const ZCODE_POOL_DB_RELATIVE_PATH = ".zcode/cli/db/db.sqlite";

/** zsub 同构的兜底缺省模型（v2 config 无 model.main 且 task 未指定时）。 */
export const ZCODE_FALLBACK_DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3";

/** 杀链 grace 窗口：SIGTERM 后等这么久再 SIGKILL（zsub 同构 5s；实测 SIGTERM→exit 仅 103ms）。 */
export const ZCODE_KILL_GRACE_MS = 5_000;

/** 错误信息里保留的 stdout 尾部长度（engine_run_failed 规格：够诊断、不刷屏）。 */
export const ZCODE_ERROR_TAIL_CHARS = 2000;

/**
 * [R2] app-server 控制面请求默认超时（ms）。依据：旧 zsw 实现 REQUEST_TIMEOUT_MS=15s
 * （60+ fake-server 用例 + 真机 e2e 验证值）；R5 probe 冒烟用独立更短预算，不走本值。
 */
export const ZCODE_APPSERVER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * [R2] 连接崩溃错误信息附带的 stderr 尾部长度（字符）。设计 zcode-engine-appserver-
 * resident.md §3.1 失败路径 2 / §3.3 错误规格表「进程意外退出」行：stderr 尾 400 字符。
 */
export const ZCODE_APPSERVER_STDERR_TAIL_CHARS = 400;

/**
 * [R2] stderr 滚动缓冲上限（字符）：只保最近内容供崩溃诊断。旧 zsw 实现同值 2048。
 */
export const ZCODE_APPSERVER_STDERR_TAIL_BUFFER_CHARS = 2048;

/**
 * [R3] 终态判定后 session/read 兜底拉取的超时（ms）。read 是全文权威来源（不变量 1
 * 的双来源之二），失败不抛——降级收尾帧/delta 聚合。旧 zsw 实现 READ_TIMEOUT_MS=5000。
 */
export const ZCODE_APPSERVER_TURN_READ_TIMEOUT_MS = 5_000;

/**
 * [R3] 任务收尾 session/close 的控制面超时（ms，best-effort——失败只 warn 不抛）。
 * 旧 zsw 实现 RELEASE_CLOSE_TIMEOUT_MS=1500（wave2 D2，同值同语义）。
 */
export const ZCODE_APPSERVER_TURN_CLOSE_TIMEOUT_MS = 1_500;

/**
 * [R3] 一轮终态等待的缺省预算（ms）。终态双保险（turn.terminal 权威 + 收尾帧宽松
 * 匹配防洪堤）之后的最后一道：全漂移/进程假死时不挂死任务。R4 接线后任务级
 * timeout / abort 链可显式传入更贴任务的值。
 */
export const ZCODE_APPSERVER_TURN_DEFAULT_TIMEOUT_MS = 300_000;

// ============================================================
// [R4] app-server 常驻 HOME（D7）/ abort 链（D3）/ 孤儿自愈（D6③）
// ============================================================

/**
 * [R4 D7] 常驻 HOME 的池 key（固定名）。锚定不变量 poolDir == HOME == db 所在目录：
 * HOME = resolvePoolDir(engineDataDir, 'zcode', 'home-appserver')，SQLite 落
 * HOME/.zcode/cli/db/db.sqlite，journal 同落该池目录。锁被活宿主持有时派生
 * `home-appserver-2`… 后缀目录，handle.poolKey 记实际目录名。
 */
export const ZCODE_APPSERVER_POOL_KEY = "home-appserver";

/** [R4 D7] 目录锁文件名（HOME 内；O_EXCL 创建，内容 {pid}=持锁宿主进程 pid）。 */
export const ZCODE_APPSERVER_LOCKFILE_NAME = "lockfile";

/** [R4 D6③/D7] app-server 进程 pidfile 文件名（HOME 内；与 lockfile.pid 严格分离）。 */
export const ZCODE_APPSERVER_PIDFILE_NAME = "appserver.pid";

/** [R4 D7] 目录锁心跳间隔（ms）：仅刷新 lockfile mtime，不参与活持有否决。 */
export const ZCODE_APPSERVER_LOCK_HEARTBEAT_MS = 30_000;

/** [R4 D7] 派生目录后缀上限（home-appserver-2 … -N）——极端并发场景防无限循环。 */
export const ZCODE_APPSERVER_MAX_DERIVED_HOMES = 8;

/**
 * [R4 D3] abort 链第一级：session/stop 的控制面超时（ms）。stop 失败/超时即落
 * killChain（协议此时已不可信）。
 */
export const ZCODE_APPSERVER_STOP_TIMEOUT_MS = 3_000;

/**
 * [R4 D3] abort 链第二级：stop 送达后的终态确认 grace 窗口（ms）。窗口内终态
 * 到达 → 不杀共享进程；超时 → killChain 连坐。
 */
export const ZCODE_APPSERVER_ABORT_GRACE_MS = 3_000;

/** [R4 D6③] 孤儿回收的 SIGTERM→SIGKILL grace 窗口（ms）。 */
export const ZCODE_APPSERVER_PIDFILE_GRACE_MS = 2_000;

/**
 * [R4/R5] 执行模式定向 env（appserver | spawn）。定向时不探不降；缺省走 app-server
 * （R5 降级链在缺省路径插 probe 门控）。spawn 降级路径（D2 兜底）继续用
 * home-<provider>-<model> 池。
 */
export const ZCODE_MODE_ENV_VAR = "XYZ_ZCODE_MODE";

/**
 * [R4] app-server 内部错误码中「模型配置缺失」的归类判据（A.3：-32603 内部错误族，
 * 消息含 "Model config is missing"——错误规格表第 2 行：报 engine_credential_missing）。
 */
export const ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING = -32603;

// ============================================================
// [R5] 降级链（D2）/ probe 冒烟（D8）
// ============================================================

/**
 * [R5 D8] 协议冒烟探针的总预算（ms）：独立短命连接上 create 探针会话 → close →
 * shutdown 的全部时间窗。不发模型请求（无 session/send）、不产生费用。超预算按
 * 探针失败处理（错误规格表末行：结论 failed → 降级 spawn）。
 */
export const ZCODE_APPSERVER_PROBE_BUDGET_MS = 10_000;

/**
 * [R5 D2] 漂移类 RPC 错误码（错误规格表第 1 行：-32601 方法不存在 / -32602 参数
 * 变形）。运行中命中任一 → 归档 protocol-drift：首任务降级 spawn 重跑一次 + 后续
 * 任务直走 spawn（降级标志内存化，进程重启后重探重建）。-32004/-32010/-32603 不在
 * 此列（任务失败上报 / 凭据缺失归类，均不降级）。
 */
export const ZCODE_APPSERVER_DRIFT_RPC_CODES = [-32601, -32602] as const;

/**
 * [R5 D8] 探针连接的 env 标记：探针用独立短命连接（不污染主连接），但 env 与主连接
 * 同源（同一常驻 HOME）。此标记供 fake/诊断侧区分「探针进程」与「常驻进程」（测试
 * 断言探针帧序、故障注入只命中探针或只命中主连接的判据）。
 */
export const ZCODE_APPSERVER_PROBE_CONN_ENV = "ZCODE_APPSERVER_PROBE_CONN";

/**
 * [R5] 崩溃收割确认的兜底窗口（ms）：killChain 在 `exit` 事件 resolve，而连接
 * finalize（onClose → 在途 turn 崩溃收割）挂 `close` 事件——channel 退订前等 onClose
 * 触发，本窗口兜底防 `close` 永不到达时 dispose/teardown 挂死。
 */
export const ZCODE_APPSERVER_HARVEST_GRACE_MS = 1_000;
