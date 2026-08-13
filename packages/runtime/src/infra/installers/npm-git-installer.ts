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
import { execFileSync, spawn } from 'node:child_process'
import type { IInstaller } from '../../services/ports/installer.js'
import {
  installPackage,
  uninstallPackage,
  installDependencies,
  fetchLatestVersion,
} from './npm-installer.js'

const GIT_CLONE_DEFAULT_TIMEOUT = 120_000

/** 版本检查默认超时 15s——比 install 的 60s 更快失败（轻量 metadata 查询不应长时间挂起）。 */
const VERSION_CHECK_DEFAULT_TIMEOUT = 15_000

/** 配置迁移脚本执行超时——迁移只是小文件操作，15s 足够；超时 kill 不阻断安装。 */
const MIGRATE_SCRIPT_TIMEOUT = 15_000

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

  async getLatestVersion(pkgName: string, timeout?: number): Promise<string> {
    return fetchLatestVersion(pkgName, timeout ?? VERSION_CHECK_DEFAULT_TIMEOUT)
  }

  async runMigrateScript(scriptPath: string, agentDir: string): Promise<void> {
    // 子进程隔离执行（超时保护，脚本挂起/崩溃不影响 runtime 进程）。
    // runtime 自身以 process.execPath + ELECTRON_RUN_AS_NODE=1 运行（见 runtime-supervisor），
    // 子进程沿用同一启动方式才是纯 Node；agentDir 经 argv[2] + PI_CODING_AGENT_DIR 双通道注入
    // （脚本优先 argv；npm postinstall 场景无 argv 时回退 env / 默认 ~/.pi/agent）。
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [scriptPath, agentDir], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: agentDir },
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: MIGRATE_SCRIPT_TIMEOUT,
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) {
          resolvePromise()
        } else {
          reject(new Error(`migrate script exited with code ${code ?? 'unknown'}`))
        }
      })
    })
  }
}
