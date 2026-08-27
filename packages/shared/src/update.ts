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
  /** 文件名（如 'TaiJi-mac-arm64.zip'） */
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
  | 'downloaded'
  | 'replacing'
  | 'restarting'
  | 'error'
  | 'unsupported'

/**
 * 升级错误事件 payload（main → preload → renderer 全链路透传，D3）。
 *
 * preload.ts onUpdateError 和 renderer lib/ipc.ts 的类型签名必须与此一致。
 */
export interface UpdateErrorPayload {
  stage: string
  message: string
  errorCode?: string
  suggestion?: string
}

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

/**
 * 升级设置接口（main 进程持久化，前端经 IPC 读写）。
 *
 * 字段：
 * - preDownload：检测到新版时是否自动在后台预下载安装包。开启后点击更新跳过下载等待。
 *   默认 false（新用户不自动消耗流量/磁盘，需主动开启）。
 * - autoUpdate：启动时自动检查更新并提示下载（v6 demo 语义）。默认 false。
 *   可选字段：调用方可以只传部分字段做局部更新（setUpdateSettings 内部与现有值合并）。
 */
export interface UpdateSettings {
  /** 检测到新版时自动后台预下载 */
  preDownload: boolean
  /** 启动时自动检查更新并提示下载 */
  autoUpdate?: boolean
}

/**
 * 代理测试结果载荷（main → preload → renderer）。
 *
 * 失败时含错误码与建议，renderer 据此展示两段式测试结果。
 */
export interface ProxyTestResult {
  /** 测试是否成功 */
  success: boolean
  /** 错误码（失败时） */
  code?: string
  /** 错误摘要（失败时） */
  message?: string
  /** 解决建议（失败时） */
  suggestion?: string
}

/**
 * 启动结果终态状态值（D5 决策：升级成功/失败/回滚三态通知）。
 * cleanupCompletedUpdate 返回的 LaunchResult.status 仅限这三个值，
 * no-op（中断但无需回滚）不通知 renderer，返回 null。
 */
export const LAUNCH_RESULT_STATUSES = ['done', 'failed', 'rolled-back'] as const

/** 启动结果终态类型（三值联合） */
export type LaunchResultStatus = (typeof LAUNCH_RESULT_STATUSES)[number]

/** 启动结果信息（main → renderer 一次性通知） */
export interface LaunchResult {
  /** 终态类型 */
  status: LaunchResultStatus
  /** 版本号（升级成功=新版本，回滚=恢复到的旧版本） */
  version: string
}
