/**
 * 自动升级相关共享类型（前端 + main + preload 三方共享）。
 * 定义来源：slice auto-update-and-install DM3。
 */

/**
 * 最新 Release 信息（已解析、按平台分流后的结构）。
 * 由 main 进程 ReleaseChecker.checkForLatestRelease 返回，preload 透传给 renderer。
 */
export interface LatestReleaseInfo {
  /** strip 前导 v 后的纯 3 位版本号（如 '0.9.0'） */
  version: string
  /** 原始 tag（如 'v0.9.0'） */
  tagName: string
  /** GitHub Release body 原文 markdown */
  releaseNotes: string
  /** 发布时间 ISO 8601 */
  publishedAt: string
  /** release 页面 URL（备用跳转） */
  htmlUrl: string
  /** 按平台分流的产物资产（缺失平台为 undefined） */
  assets: {
    macArm64Zip?: ReleaseAsset
    winX64Exe?: ReleaseAsset
    linuxX64AppImage?: ReleaseAsset
    linuxX64Deb?: ReleaseAsset
  }
}

/**
 * 单个 Release 资产。
 * sha256 来自 GitHub asset.digest strip 'sha256:' 前缀；缺失时为 undefined。
 */
export interface ReleaseAsset {
  /** 文件名（如 'xyz-agent-mac-arm64.zip'） */
  name: string
  /** 下载直链（browser_download_url） */
  downloadUrl: string
  /** 文件大小（字节） */
  size: number
  /** sha256 hex（缺失为 undefined） */
  sha256?: string
}

/** 升级流程的阶段（用于前端进度展示） */
export type UpdateStage = 'downloading' | 'verifying' | 'replacing' | 'restarting'

/** 升级流程的整体状态机 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'replacing'
  | 'restarting'
  | 'error'
  | 'unsupported'

/**
 * 代理配置接口。
 * 支持三种模式：
 * - system：自动检测系统代理
 * - manual：手动配置代理地址
 * - disabled：禁用代理
 */
export interface IProxyConfig {
  /** 代理模式 */
  mode: 'system' | 'manual' | 'disabled'
  /** 手动模式下的 HTTP 代理地址（如 http://127.0.0.1:7890） */
  httpProxy?: string
  /** 手动模式下的 HTTPS 代理地址（如 http://127.0.0.1:7890） */
  httpsProxy?: string
}
