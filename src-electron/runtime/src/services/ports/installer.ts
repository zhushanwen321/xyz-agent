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

/** ExtensionResolver.resolve 返回的路径集合。 */
export interface ExtensionPaths {
  extensionDirs: string[]
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
}

/**
 * 扩展解析器 port —— 发现 + 校验。
 * ExtensionResolver（infra/installers/）实现。
 */
export interface IExtensionResolver {
  /** 按优先级解析所有 extension 路径（bundled/third-party/settings/user/npm 去重）。 */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[]): ExtensionPaths
  /** 校验目录是否为有效的 pi extension。 */
  isValidPiExtension(pkgDir: string): boolean
}
