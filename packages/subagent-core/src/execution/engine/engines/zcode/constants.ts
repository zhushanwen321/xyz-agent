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
