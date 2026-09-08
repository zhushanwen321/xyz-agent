// src/env.ts
//
// W12 领地占位（impl-plan §2 单元表 W12 行 + §2.12）：`buildEngineChildEnv(baseEnv,
// opts)` 三层 env 契约（L0 基础设施注入 / L1 deny+显式剥除 / L2 manifest 放行）落
// 本文件；基座常量（ENGINE_ENV_PREFIXES / ENGINE_ENV_DENY_LIST）由
// packages/shared/src/constants.ts SSOT 构建期生成。
//
// 本单元（W1）仅占位登记 tsup entry（§2.1 末行 entry 显式登记要求），不实现任何
// 逻辑——避免领地越界。W12 落地时同守卫核对 entry 登记。
export {};
