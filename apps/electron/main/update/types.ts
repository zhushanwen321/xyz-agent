/**
 * 自动升级后端类型与错误体系。
 *
 * 对应 slice auto-update-and-install w3：定义 UpdateScriptRef 联合类型
 * （platform-updater 返回值，告诉 orchestrator 如何触发替换）+ 升级错误类层级。
 *
 * [HISTORICAL] 设计要点：
 * - UpdateScriptRef 用可辨识联合（kind 区分），orchestrator switch 穷尽分支
 * - 错误类带 stage 字段（downloading/verifying/replacing/restarting），便于前端精确展示
 * - UpdateUnsupportedError 单独成类（带 fallbackUrl），前端走「跳转 release 页」降级而非 retry
 *
 * 依赖方向：types → @xyz-agent/shared（UpdateStage 类型）
 */
import type { UpdateStage } from '@xyz-agent/shared'

/**
 * 平台升级器返回的「替换动作描述」。
 *
 * orchestrator 根据 kind 决定如何触发替换：
 * - detached-script：mac/linux，prepareUpdate 内已 spawn detached bash，orchestrator 只需返回 triggerRestart
 * - spawn-installer：win，orchestrator 负责 spawn NSIS installer（/S 静默）
 * - unsupported：平台不支持自更新（如 deb），前端应跳 fallbackUrl
 */
export type UpdateScriptRef =
  | { kind: 'detached-script'; scriptPath: string }
  | { kind: 'spawn-installer'; installerPath: string; args: string[] }
  | { kind: 'unsupported'; reason: string; fallbackUrl: string }

/**
 * 升级流程错误基类。
 *
 * 携带 stage 字段标记错误发生的阶段（供前端展示「下载失败/校验失败/替换失败」等）。
 */
export class UpdateError extends Error {
  /** 错误发生的阶段 */
  readonly stage: UpdateStage
  /** 错误码（可选，供前端精确分支） */
  readonly errorCode: string | undefined

  constructor(message: string, stage: UpdateStage, errorCode?: string) {
    super(message)
    this.name = 'UpdateError'
    this.stage = stage
    this.errorCode = errorCode
  }
}

/**
 * 完整性校验失败（sha256 不匹配 / size 不匹配）。
 *
 * 前端应提示「安装包已损坏」并允许重新下载，而非 retry 同一 asset。
 */
export class UpdateIntegrityError extends UpdateError {
  constructor(message: string) {
    super(message, 'verifying', 'UPDATE_INTEGRITY_FAILED')
    this.name = 'UpdateIntegrityError'
  }
}

/**
 * 平台不支持自更新（如 deb 包 / dev 模式）。
 *
 * 携带 fallbackUrl，前端走「跳转 GitHub release 页手动下载」降级。
 */
export class UpdateUnsupportedError extends UpdateError {
  /** 备用跳转 URL（通常是 release 页面） */
  readonly fallbackUrl: string

  constructor(message: string, fallbackUrl: string) {
    super(message, 'replacing', 'UPDATE_UNSUPPORTED_PLATFORM')
    this.name = 'UpdateUnsupportedError'
    this.fallbackUrl = fallbackUrl
  }
}
