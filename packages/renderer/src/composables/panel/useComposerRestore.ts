/**
 * useComposerRestore —— renderer 兼容 shim（W2 迁移过渡期）。
 *
 * 真实实现已迁入 @xyz-agent/core/domain/composer/input/restore.ts。纯逻辑迁移（clearInput/
 * restoreInput/restoreSegments），无 deps 注入需求，直接 re-export。
 *
 * W4 壳接入时删除本 shim，Composer.vue 改为直接 import core。
 */
export { useComposerRestore } from '@xyz-agent/core/domain/composer/input'
