// src/constants.ts
//
// pi 引擎包的常量面（W7 迁移自 core engines/pi/pi-engine.ts / session-runner.ts，
// 逐值等价）。core 侧原件过渡期保留（W11 删），本包是引擎进程内的权威。

/** pi 引擎的 registry key（D9：缺省引擎 = 'pi'）。 */
export const PI_ENGINE_ID = "pi";

/** pi 适配器版本（handle.adapterVersion 数据源——golden 样本对齐排查锚点）。 */
export const PI_ADAPTER_VERSION = "1.0.0";

/** pi 无隔离池（PI_CODING_AGENT_DIR 全局一份，设计 §3.3.9），poolKey 恒 'shared'。 */
export const PI_POOL_KEY = "shared";

/** pi 域 schema env 名（core shared/schema-env.ts SSOT 的包内等值锚点——SDK 未
 *  导出该常量；structured-output 扩展读取它注册 tool）。 */
export const SCHEMA_ENV_VAR = "PI_WORKFLOW_SCHEMA";

/** schema env 上限的 KiB 数与每 KiB 字节数（E2BIG 防护，与 core SCHEMA_ENV_MAX_BYTES 等值）。 */
const SCHEMA_ENV_MAX_KIB = 256;
const BYTES_PER_KIB = 1024;

/** schema env 的 UTF-8 字节上限（256KiB）。 */
export const SCHEMA_ENV_MAX_BYTES = SCHEMA_ENV_MAX_KIB * BYTES_PER_KIB;
