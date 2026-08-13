/**
 * Installer 域 ports —— npm 安装 + git clone + 扩展路径解析。
 *
 * 🔒 三层架构：services 定义 port，infra/installers/npm-git-installer.ts + extension-resolver.ts 实现。
 * ExtensionService 经此 port 执行安装/卸载/解析，不直接 spawn git 或调 npm-installer。
 */

/** npm/git 安装操作返回的错误（infra 的 NpmInstallError 实现此形状）。 */
export interface InstallerError {
  code: 'not_found' | 'network' | 'extract' | 'integrity'
  message: string
}

/** 扩展发现来源（按优先级降序） */
export type ExtensionSource = 'npm' | 'user' | 'discovery' | 'settings' | 'third-party' | 'bundled'

/** 发现的扩展目录 + 来源元数据 */
export interface DiscoveredExtension {
  /** 扩展目录绝对路径 */
  path: string
  /** 发现来源 */
  source: ExtensionSource
}

/** ExtensionResolver.resolve 返回的路径集合（全量发现，未做任何策略过滤）。 */
export interface ExtensionPaths {
  extensionDirs: DiscoveredExtension[]
}

/**
 * 安装器 port —— npm install/uninstall/installDeps + git clone。
 * 这些都是外部系统调用（npm registry HTTPS、git 子进程），归属 infra。
 */
export interface IInstaller {
  /** npm install 一个包到指定 node_modules 目录。失败抛 InstallerError 形状的错误。 */
  installNpm(pkgName: string, nodeModulesDir: string, opts?: { timeout?: number }): Promise<void>
  /** npm uninstall 一个包。 */
  uninstallNpm(name: string, nodeModulesDir: string): Promise<void>
  /** 在指定目录执行 npm install（装 dependencies，用于 git clone 后的仓库）。 */
  installDeps(dir: string): Promise<void>
  /** git clone --depth 1 一个仓库到目标目录。失败抛 Error。 */
  installGit(url: string, destDir: string, timeout?: number): Promise<void>
  /** 从 npm registry 获取包的 latest 版本号。失败抛 InstallerError 形状的错误。
   *  timeout：可选，未传时实现使用默认值（版本检查应比 install 更快失败）。 */
  getLatestVersion(pkgName: string, timeout?: number): Promise<string>
  /**
   * 执行包声明的配置迁移脚本（package.json `pi.migrate`）。安装/升级成功后由
   * ExtensionService 调用，完成历史配置文件的「安装时迁移」——extension 运行时只读
   * 新路径（<agentDir>/config/<简名>.json），不双读旧路径。
   *
   * 实现以子进程隔离执行（超时保护，脚本失败不污染宿主进程）；调用方按 best-effort
   * 处理（失败记日志，不阻断安装结果——脚本自身幂等，下次安装/升级重试）。
   *
   * @param scriptPath 迁移脚本绝对路径（.mjs）
   * @param agentDir   pi agent 目录（注入 PI_CODING_AGENT_DIR + argv[2]，供脚本解析）
   */
  runMigrateScript(scriptPath: string, agentDir: string): Promise<void>
}

/**
 * 扩展解析器 port —— 发现 + 校验。
 * ExtensionResolver（infra/installers/）实现。
 */
export interface IExtensionResolver {
  /**
   * 按优先级解析所有 extension 路径（bundled/third-party/settings/user/discovery/npm 去重）。
   * @param discoveryExtDirs 用户勾选的 discovery.json 额外扫描目录（复刻 pi collectAutoExtensionEntries）
   */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[], discoveryExtDirs?: string[]): ExtensionPaths
  /** 校验目录是否为有效的 pi extension。 */
  isValidPiExtension(pkgDir: string): boolean
}
