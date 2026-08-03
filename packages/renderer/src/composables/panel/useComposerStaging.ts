/**
 * useComposerStaging —— re-export shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/dispatch/staging.ts（W3）。
 * staging 是纯 re-export（零跨域 dep，core 与 renderer 签名一致），
 * Composer.vue 等旧调用方 import 路径与签名零改动。
 *
 * 注意：从 dispatch barrel import（core exports 只暴露 ./domain/composer/dispatch
 * 子路径，不暴露单文件 staging 子路径）。
 *
 * W4 壳接入时删除本 shim。
 */
export * from '@xyz-agent/core/domain/composer/dispatch'
