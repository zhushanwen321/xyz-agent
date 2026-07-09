/**
 * IInstaller 的 infra 实现 —— 封装 npm 安装（纯 Node.js，不依赖 npm CLI）+ git clone。
 *
 * 🔒 归属（R3c2，三层架构）：infra/installers/，实现 services/ports.ts 的 IInstaller。
 * npm registry HTTPS 调用 + git 子进程 spawn 是外部系统调用，归属 infra。
 * ExtensionService 经此 port 执行安装/卸载，不直接 spawn git 或调 npm-installer 函数。
 *
 * npm 部分委托给同目录的 npm-installer.ts 独立函数（installPackage/uninstallPackage/
 * installDependencies）；git clone 从 extension-service.ts 迁入（R3c2）。
 */
import { execFileSync } from 'node:child_process'
import type { IInstaller } from '../../services/ports/installer.js'
import {
  installPackage,
  uninstallPackage,
  installDependencies,
  fetchLatestVersion,
} from './npm-installer.js'

const GIT_CLONE_DEFAULT_TIMEOUT = 120_000

export class NpmGitInstaller implements IInstaller {
  async installNpm(pkgName: string, nodeModulesDir: string, opts?: { timeout?: number }): Promise<void> {
    // npm-installer 抛 NpmInstallError（含 code 字段）。service 经结构化类型读取 err.code，
    // 不 import NpmInstallError 具体类（依赖倒置）。
    await installPackage(pkgName, nodeModulesDir, opts ? { timeout: opts.timeout } : undefined)
  }

  async uninstallNpm(name: string, nodeModulesDir: string): Promise<void> {
    await uninstallPackage(name, nodeModulesDir)
  }

  async installDeps(dir: string): Promise<void> {
    await installDependencies(dir)
  }

  async installGit(url: string, destDir: string, timeout?: number): Promise<void> {
    // execFileSync prevents command injection (no shell). Throws on non-zero exit.
    execFileSync('git', ['clone', '--depth', '1', url, destDir], {
      stdio: 'pipe',
      timeout: timeout ?? GIT_CLONE_DEFAULT_TIMEOUT,
    })
  }

  async getLatestVersion(pkgName: string): Promise<string> {
    return fetchLatestVersion(pkgName)
  }
}
