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
 * 凭据源 config（桌面端登录态，zsub V2_CONFIG_PATH 同构）。
 * 为什么不是 ~/.zcode/cli/config.json：本机实测（2026-08-25 验收前置门）该文件的
 * provider 可能指向局域网网关（不可达）；桌面端登录凭据落在 v2/config.json，
 * 是 zsub 生产验证过的凭据源。cli/config.json 仍作为第二来源参与 provider 合并
 * （它还携带 model.main 缺省主模型）。
 */
export const ZCODE_V2_CONFIG_PATH_SUFFIX = [".zcode", "v2", "config.json"] as const;

/** CLI 自身配置（第二凭据源 + model.main 缺省来源）。 */
export const ZCODE_CLI_CONFIG_PATH_SUFFIX = [".zcode", "cli", "config.json"] as const;

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
