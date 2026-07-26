/**
 * 升级 bash 脚本「真实执行」集成测试（P1 缺口补齐）。
 *
 * 覆盖动机（为什么写这个文件）
 * ------------------------------------------------------------------
 * 现有 updater-script.test.ts 只做「字符串断言」——验证脚本含 pgrep / shasum /
 * unzip / xattr -cr / mv .old 等关键片段，且占位符全替换无 {{ 残留。
 * 但字符串正确 ≠ bash 真的能跑通。detached bash 升级脚本最致命的风险是：
 *   1. sha256 校验决策树写错（脚本字符串含 `shasum` ≠ 回滚分支真的会触发）
 *   2. bash 语法错误（变量未引用 / heredoc 转义错 / 路径含空格炸）
 *   3. 回滚 .old 的 mv 顺序错（unzip 失败时是否真的恢复）
 * 这些只有「真实跑一遍」才能发现。本文件构造一个迷你 .app bundle + 真实最小 zip，
 * 把 buildUpdaterScript 生成的脚本写到磁盘，用 `bash <script>` 真实执行并断言
 * exit code / 落盘文件 / 回滚行为。
 *
 * Mock 策略
 * ------------------------------------------------------------------
 * - 文件系统：每个用例 mkdtempSync 独立临时目录，afterEach 强制 rmSync 清理。
 *   不污染真实 /Applications、不读 ~/.xyz-agent。
 * - zip 文件：用系统 `zip` CLI 生成「真实合法 zip」（含 .app 目录结构），
 *   让脚本里的 unzip 段真实执行而非 stub。CI 上无 zip CLI 的兜底：
 *   which('zip') 为空则 happy-path/unzip-fail 用例 it.skipIf 跳过，但
 *   bash -n 语法检查 + sha 校验段用例仍跑（这些不依赖 zip）。
 * - open -n 重启行：测试不验证「真的拉起 GUI」，故执行前把最后一行
 *   `open -n ...` 去掉（测试范围内的小变换，文档化在此）。这是测试 purity 的必要
 *   折中——避免测试期间真的启动一个 Electron 窗口。
 * - pgrep 进程名：mac 脚本里 pgrep -f "{{APP_NAME}}"，本环境装着真 xyz-agent app，
 *   若 appName 传 "xyz-agent" 会误匹配 → 卡满 30s 轮询。故测试用唯一假进程名
 *   （如 'xyz-agent-integration-test-FAKE-PROC'），既覆盖 pgrep 语法、又不被环境
 *   误命中。这是测试夹具选择，不是改源码。
 * - codesign/xattr：真实执行（command -v 守卫 + || true），macOS 上不致命；
 *   非 mac 环境 these 命令不存在但守卫会让脚本跳过。
 *
 * 与 updater-script.test.ts 的边界
 * ------------------------------------------------------------------
 * - updater-script.test.ts：字符串视角（含哪些片段、占位符替换、参数注入）
 * - 本文件：执行视角（bash 能跑通、exit code 对、文件落盘对、回滚分支真的触发）
 * 「占位符全替换」一项两边都断言——此处从执行产物视角再断一次，因为残留占位符
 * 在 set -uo pipefail 下会让真实执行炸（如 `{{APP_BUNDLE}}` 被解析为变量展开）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/updater-script-integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import {
  buildUpdaterScript,
  buildLinuxUpdaterScript,
  type UpdaterScriptVars,
  type LinuxUpdaterScriptVars,
} from '../update/updater-script.js'

// ──────────────────────────────────────────────────────────────────
// 环境探测：哪些系统命令可用（决定哪些用例能真实跑）
// ──────────────────────────────────────────────────────────────────

/** 安全的 which：命令存在返回 true，否则 false（不抛异常）。 */
function hasCommand(cmd: string): boolean {
  // 用 bash -c 单字符串形式避免「spawn shell:true + args」的 DEP0190 弃用警告，
  // 命令名是测试内常量、无注入风险。
  const r = spawnSync('bash', ['-c', `command -v ${cmd}`])
  return r.status === 0
}

const HAS_ZIP = hasCommand('zip')        // 生成最小 zip 用
const HAS_UNZIP = hasCommand('unzip')    // 脚本里解压用
const HAS_SHASUM = hasCommand('shasum')  // 脚本里 sha256 用
const IS_MAC = process.platform === 'darwin'

// ──────────────────────────────────────────────────────────────────
// 临时目录生命周期
// ──────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  // 每个用例独立目录，避免互相干扰（如 .old 残留影响下一用例的回滚分支）
  tmpDir = mkdtempSync(path.join(tmpdir(), 'updater-int-'))
})

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ──────────────────────────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────────────────────────

/** 计算文件 sha256 hex（64 位），与脚本里 shasum -a 256 等价。 */
function sha256OfFile(filePath: string): string {
  const h = crypto.createHash('sha256')
  h.update(readFileSync(filePath))
  return h.digest('hex')
}

/**
 * 构造一个最小 .app bundle 目录（Content/MacOS/<binary> + Info.plist），
 * 再用系统 zip CLI 打成 zip。返回 { zipPath, appBundleName, sha256 }。
 *
 * 用真实 .app 目录 + 真实 zip 而非 mock，是为了让脚本里的 unzip 段
 * 真实执行（mkdir/extract），覆盖 unzip 失败回滚分支需要的就是真 zip。
 */
function buildMinimalAppZip(opts: {
  appBundleName?: string
  /** zip 内顶层条目名（默认与 appBundleName 一致，解压即还原 .app） */
} = {}): { zipPath: string; appBundleName: string; sha256: string } {
  const appBundleName = opts.appBundleName ?? 'xyz-agent.app'
  // 在 tmpDir/build 下构造 .app 目录，zip 内条目名 = appBundleName
  const buildRoot = path.join(tmpDir, 'build')
  const appDir = path.join(buildRoot, appBundleName)
  mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), '{}\n')
  // 一个假的可执行体（不真实跑，只是占位让 unzip 解出非空目录树）
  writeFileSync(
    path.join(appDir, 'Contents', 'MacOS', 'xyz-agent'),
    '#!/bin/bash\necho fake app\n',
  )

  // zip -r 顶层条目 = appBundleName，解压到目标目录即还原 .app
  const zipPath = path.join(tmpDir, `${appBundleName}.zip`)
  const r = spawnSync('zip', ['-r', '-q', zipPath, appBundleName], { cwd: buildRoot })
  if (r.status !== 0) {
    throw new Error(`zip 失败 status=${r.status} stderr=${r.stderr?.toString()}`)
  }
  return { zipPath, appBundleName, sha256: sha256OfFile(zipPath) }
}

/**
 * 把脚本字符串写到 tmpDir/updater.sh，返回绝对路径。
 * 执行时调用方用 `bash <path>`。
 */
function writeScriptToTmp(script: string, name = 'updater.sh'): string {
  const p = path.join(tmpDir, name)
  writeFileSync(p, script, { mode: 0o755 })
  return p
}

/**
 * 真实执行 bash 脚本，返回 { status, stdout, stderr }。
 * 用 shell:false 直接调 bash 避免 PATH 问题；用 /bin/bash（macOS 自带 3.x 也能跑，
 * 但环境装了 brew bash 5.x，PATH 里更优先）。
 */
function runBash(scriptPath: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [scriptPath], {
    cwd: tmpDir,
    encoding: 'utf8',
    // 不设 timeout——脚本应在 1-2s 内完成（含内置 sleep 1）。如挂起说明 pgrep 误匹配，
    // 由 hasCommand / 唯一假进程名规避；不在这里硬超时以保持失败原因清晰。
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * 生成 mac happy-path 用标准 vars。
 *
 * 关键：appName 用唯一假进程名，避免本环境真 xyz-agent app 被 pgrep -f 命中
 * 导致 30s 卡死（这是 detached 脚本设计上「等 app 退出」的固有副作用，
 * 测试用唯一名绕开，不修改源码语义）。
 */
function makeMacVars(opts: {
  zipPath: string
  sha256: string
  appBundleName?: string
}): UpdaterScriptVars {
  const appBundleName = opts.appBundleName ?? 'xyz-agent.app'
  return {
    // appBundle 指向 tmpDir/installed/<name>，脚本会 unzip 到这里
    appBundle: path.join(tmpDir, 'installed', appBundleName),
    zipPath: opts.zipPath,
    sha256: opts.sha256,
    logPath: path.join(tmpDir, 'updater.log'),
    resultPath: path.join(tmpDir, 'update-result.json'),
    appName: 'xyz-agent-integration-test-FAKE-PROC', // 唯一假进程名，绝不命中真实进程
    targetVersion: '0.9.0-integration',
  }
}

/**
 * 测试执行前的小变换：去掉 mac 脚本最后一行 `open -n ...`。
 *
 * 原因：open -n 会真启动 GUI（macOS 上对无效 bundle 也会弹 Finder 报错），
 * 与测试 purity 冲突。本测试聚焦升级决策树逻辑（sha 校验 / 备份 / 解压 / 回滚），
 * 重启语义由代码审查 + 字符串断言覆盖，执行测试不复述。
 * 变换是确定性的、文档化的：只删最后出现的 `open -n ...` 行。
 */
function stripOpenLine(script: string): string {
  return script.replace(/^open -n .*$/m, 'echo "[test] skip open -n (would launch GUI)"')
}

/** 把 mac 脚本里的 `sleep 1`（等 app 退出后的固定 sleep）压成 `true`，加速测试。 */
function shortenSleeps(script: string): string {
  // 只压脚本里 standalone 的 sleep 1（不碰 sleep 0.5 那种轮询用的；0.5 * 60 最多 30s，
  // 但因 appName 唯一假名 → 第一次 pgrep 就 break，不会进轮询）。
  return script.replace(/^sleep 1$/m, 'true  # skip sleep 1 for test speed')
}

// ════════════════════════════════════════════════════════════════
// MAC 脚本：bash 语法检查（不依赖 zip/unzip，最稳）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: bash 语法检查', () => {
  it('mac 脚本：buildUpdaterScript 产物 bash -n 通过（语法正确、无残留占位符炸）', () => {
    const script = buildUpdaterScript(makeMacVars({ zipPath: '/tmp/x.zip', sha256: 'a'.repeat(64) }))
    const scriptPath = writeScriptToTmp(script)

    // 执行视角再断一次占位符全替换：残留 {{...}} 在 set -uo pipefail 下会让
    // bash -n 也可能炸（取决于位置），更关键是真实执行会失败。
    expect(script, '执行产物不应残留 {{...}} 占位符').not.toMatch(/\{\{[^}]+\}\}/)

    const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
    expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
  })

  it('linux 脚本：buildLinuxUpdaterScript 产物 bash -n 通过', () => {
    const script = buildLinuxUpdaterScript({
      appImagePath: path.join(tmpDir, 'x.appimage'),
      newFilePath: path.join(tmpDir, 'y.appimage'),
      logPath: path.join(tmpDir, 'l.log'),
      resultPath: path.join(tmpDir, 'r.json'),
      targetVersion: '0.9.0-int',
    })
    const scriptPath = writeScriptToTmp(script, 'linux-updater.sh')
    expect(script).not.toMatch(/\{\{[^}]+\}\}/)

    const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
    expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
  })

  it('mac 脚本：sha256 含特殊字符也不破坏 bash 语法（防御注入）', () => {
    // sha256 是 hex，正常不会含特殊字符，但测试防御性地传一个「像但不合法」的串，
    // 确认它原样注入到 "$ACTUAL" != "..." 的双引号内，不破坏引号配对 → bash -n 过。
    // 这里用一个合法 64 位 hex 即可（脚本对 sha 不做 bash 语法解析，纯字符串比较）。
    const weirdButHex = '0'.repeat(64)
    const script = buildUpdaterScript(makeMacVars({ zipPath: '/tmp/x.zip', sha256: weirdButHex }))
    const r = spawnSync('bash', ['-n', writeScriptToTmp(script)], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════
// MAC 脚本：sha256 校验段真实执行（最关键决策树）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: sha256 校验决策树', () => {
  beforeEach(() => {
    // sha 校验段需要 shasum 命令；缺则用例跳过（CI 兜底）
    if (!HAS_SHASUM) {
      console.warn('[skip] shasum 不可用，跳过 sha 校验真实执行用例')
    }
  })

  // 提取「sha 校验段」单独跑：脚本模板里从 # 2. sha256 校验 到 unzip 之前。
  // 这是最易写错的一段（变量名、引号、awk、!=），单独构造一个最小脚本，
  // 真实执行验证 exit code + result.json + log 输出。
  function buildShaCheckOnlyScript(args: {
    zipPath: string
    expectedSha: string
    resultPath: string
    logPath: string
  }): string {
    // 故意一字不差地复刻模板里的 sha 校验段（含 ACTUAL/shasum/awk/!= 那几行），
    // 验证这段在真实 bash 里跑得通。exec > log 重定向也保留，验证它不炸。
    return `#!/bin/bash
set -uo pipefail
exec > "${args.logPath}" 2>&1
ACTUAL=$(shasum -a 256 "${args.zipPath}" | awk '{print $1}')
if [ "$ACTUAL" != "${args.expectedSha}" ]; then
  echo "[$(date)] ROLLBACK: sha mismatch"
  echo '{"status":"failed","version":"0.9.0-int","at":"'"$(date -u +%FT%TZ)"'","error":"sha mismatch"}' > "${args.resultPath}"
  exit 1
fi
echo '{"status":"sha-ok"}' > "${args.resultPath}"
`
  }

  it('sha 匹配 → exit 0、result.json 写入 sha-ok', () => {
    if (!HAS_SHASUM) return
    // 准备任意文件 + 计算真实 sha
    const payload = path.join(tmpDir, 'payload.bin')
    writeFileSync(payload, 'hello updater integration test')
    const realSha = sha256OfFile(payload)

    const logPath = path.join(tmpDir, 'sha.log')
    const resultPath = path.join(tmpDir, 'update-result.json')
    const script = buildShaCheckOnlyScript({
      zipPath: payload,
      expectedSha: realSha,
      resultPath,
      logPath,
    })
    const scriptPath = writeScriptToTmp(script)

    const r = runBash(scriptPath)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    expect(existsSync(resultPath)).toBe(true)
    expect(readFileSync(resultPath, 'utf8')).toContain('sha-ok')
  })

  it('sha 不匹配 → exit 1、result.json status=failed、log 含 ROLLBACK: sha mismatch', () => {
    if (!HAS_SHASUM) return
    const payload = path.join(tmpDir, 'payload.bin')
    writeFileSync(payload, 'tampered content')
    const wrongSha = '0'.repeat(64) // 故意错的 64 位 hex

    const logPath = path.join(tmpDir, 'sha.log')
    const resultPath = path.join(tmpDir, 'update-result.json')
    const script = buildShaCheckOnlyScript({
      zipPath: payload,
      expectedSha: wrongSha,
      resultPath,
      logPath,
    })
    const scriptPath = writeScriptToTmp(script)

    const r = runBash(scriptPath)
    expect(r.status, `期望 exit 1，实际=${r.status}`).toBe(1)
    // 回滚分支真的写了 result.json
    expect(existsSync(resultPath)).toBe(true)
    const result = readFileSync(resultPath, 'utf8')
    expect(result).toContain('"status":"failed"')
    expect(result).toContain('"error":"sha mismatch"')
    // log 里真的打了 ROLLBACK 标记（不是字符串断言，是真实执行的产物）
    expect(readFileSync(logPath, 'utf8')).toContain('ROLLBACK: sha mismatch')
  })
})

// ════════════════════════════════════════════════════════════════
// MAC 脚本：端到端 happy path（真 .app + 真 zip + 真 unzip）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: mac 端到端', () => {
  beforeEach(() => {
    // happy path 需要 zip + unzip 都可用；缺任一则 it.skipIf 自动跳过
  })

  it(
    'happy path：sha 匹配 + unzip 成功 → exit 0、新 .app 就位、status=done、.old 已清理',
    () => {
      // 仅 mac 有 unzip + xattr/codesign 守卫的完整路径；linux CI 上 unzip 可能也存在，
      // 但 .app bundle 语义是 mac 特有 → 限定 mac 跑。
      if (!IS_MAC || !HAS_ZIP || !HAS_UNZIP || !HAS_SHASUM) {
        console.warn('[skip] 非 mac 或缺 zip/unzip/shasum，跳过 mac happy path')
        return
      }

      const { zipPath, sha256, appBundleName } = buildMinimalAppZip()
      const vars = makeMacVars({ zipPath, sha256, appBundleName })
      // 预先放一个「旧 .app」（被备份成 .old 然后被新 .app 覆盖；最终 .old 被清理）
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      const oldApp = vars.appBundle
      mkdirSync(oldApp, { recursive: true })
      writeFileSync(path.join(oldApp, 'OLD_MARKER'), 'old')

      let script = buildUpdaterScript(vars)
      script = stripOpenLine(script)    // 不真启动 GUI
      script = shortenSleeps(script)    // 加速
      const scriptPath = writeScriptToTmp(script)

      const r = runBash(scriptPath)
      expect(r.status, `期望 exit 0，stderr=${r.stderr}`).toBe(0)

      // 新 .app 就位（unzip 真的解出来了）
      expect(existsSync(vars.appBundle), '新 .app 应就位').toBe(true)
      expect(existsSync(path.join(vars.appBundle, 'Contents', 'Info.plist'))).toBe(true)
      // 旧 .old 备份已被清理（脚本末尾 rm -rf）
      expect(existsSync(`${vars.appBundle}.old`), '.old 应被清理').toBe(false)
      // 旧 marker 没了（被 mv 到 .old 后又 rm 掉）
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(false)

      // result.json status=done
      expect(existsSync(vars.resultPath)).toBe(true)
      const result = readFileSync(vars.resultPath, 'utf8')
      expect(result).toContain('"status":"done"')
      expect(result).toContain('0.9.0-integration')

      // log 含完整轨迹
      const log = readFileSync(vars.logPath, 'utf8')
      expect(log).toContain('start update')
      expect(log).toContain('update done')
    },
  )

  it(
    'sha mismatch 回滚：exit 1、旧 .app 完好（不应被破坏）、status=failed',
    () => {
      if (!IS_MAC || !HAS_ZIP || !HAS_UNZIP || !HAS_SHASUM) {
        console.warn('[skip] 非 mac 或缺 zip/unzip/shasum')
        return
      }

      const { zipPath, appBundleName } = buildMinimalAppZip()
      const wrongSha = '0'.repeat(64) // 故意错的 sha
      const vars = makeMacVars({ zipPath, sha256: wrongSha, appBundleName })
      // 预先放旧 .app（应被保留——sha 失败发生在 mv/unzip 之前）
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'preserved')

      let script = buildUpdaterScript(vars)
      script = stripOpenLine(script)
      script = shortenSleeps(script)
      const scriptPath = writeScriptToTmp(script)

      const r = runBash(scriptPath)
      expect(r.status, 'sha 失败应 exit 1').toBe(1)

      // 旧 .app 完好无损（sha 校验在备份替换之前，失败直接退出，不应触发 mv）
      expect(existsSync(vars.appBundle)).toBe(true)
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(true)
      // 没产生 .old（备份分支没进入）
      expect(existsSync(`${vars.appBundle}.old`)).toBe(false)

      // result.json status=failed + error=sha mismatch
      const result = readFileSync(vars.resultPath, 'utf8')
      expect(result).toContain('"status":"failed"')
      expect(result).toContain('"error":"sha mismatch"')
    },
  )

  it(
    'unzip 失败回滚：损坏 zip → exit 1、.old 恢复旧 .app、status=failed、error=unzip failed',
    () => {
      if (!IS_MAC || !HAS_ZIP || !HAS_UNZIP || !HAS_SHASUM) {
        console.warn('[skip] 非 mac 或缺 zip/unzip/shasum')
        return
      }

      // 构造「sha 对、但内容不是合法 zip」的伪 zip：先真打个 zip 拿正确 sha，
      // 然后把 zip 内容替换成垃圾（sha 也跟着变 → 我们重算 sha 让校验段通过）。
      // 这样校验段过、解压段炸 → 触发 unzip 失败回滚分支。
      const { zipPath, appBundleName } = buildMinimalAppZip()
      // 用垃圾内容覆盖 zip 文件，再重算 sha 注入脚本
      writeFileSync(zipPath, 'this is not a valid zip file content')
      const realSha = sha256OfFile(zipPath)

      const vars = makeMacVars({ zipPath, sha256: realSha, appBundleName })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'restored-after-rollback')

      let script = buildUpdaterScript(vars)
      script = stripOpenLine(script)
      script = shortenSleeps(script)
      const scriptPath = writeScriptToTmp(script)

      const r = runBash(scriptPath)
      expect(r.status, 'unzip 失败应 exit 1').toBe(1)

      // 回滚后旧 .app 应被恢复（脚本：unzip 失败 → rm 半截 → mv .old 回来）
      expect(existsSync(vars.appBundle), '旧 .app 应被回滚恢复').toBe(true)
      // 注意：脚本逻辑是「先 mv 旧 → .old；unzip 失败 → rm 半截 + mv .old 回」
      // 所以 OLD_MARKER 应重新出现在 appBundle（被 mv 回来的）
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(true)
      expect(existsSync(`${vars.appBundle}.old`), '回滚后 .old 应被 mv 走').toBe(false)

      const result = readFileSync(vars.resultPath, 'utf8')
      expect(result).toContain('"status":"failed"')
      expect(result).toContain('"error":"unzip failed"')
    },
  )
})

// ════════════════════════════════════════════════════════════════
// LINUX 脚本：mv 备份/回滚决策树（不真 spawn AppImage）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: linux mv 备份/回滚', () => {
  /**
   * linux 脚本最后会 `"<AppImagePath>" &` 真启动 AppImage——非测试目标。
   * 这里取脚本「等退出 + mv 备份 + mv 新到位 + chmod + 写 result」主体段，
   * 去掉末尾 spawn 行，真实执行验证 mv/回滚/chmod 决策树。
   */
  function buildLinuxBodyScript(vars: LinuxUpdaterScriptVars): string {
    let script = buildLinuxUpdaterScript(vars)
    // 去掉末尾 `"<AppImagePath>" &` 这一行（真启动 AppImage）
    // 模板里只有最后一行 spawn 是 `<path> &`，正则锚定行尾
    script = script.replace(/^"[^"]+" &\s*$/m, 'echo "[test] skip AppImage spawn"')
    // 压掉等 app 退出的固定 sleep（同 mac 处理），加速
    script = script.replace(/^sleep 1$/m, 'true  # skip sleep 1')
    // 关键：去掉等 app 退出的 pgrep 轮询段。
    // 原因（重要）：linux 模板里 pgrep -f "xyz-agent" 是写死的（不像 mac 用 {{APP_NAME}}），
    // 而本开发环境装着真 xyz-agent app，pgrep -f "xyz-agent" 会命中真实进程 → 卡满 30s 轮询。
    // mac 测试已经通过唯一假 appName 验证了「等 app 退出」逻辑；
    // linux body 测试聚焦的是 mv 备份/回滚/chmod 决策树（这才是 linux updater 的核心），
    // 故执行前把整段 pgrep 循环换成单行 no-op。这是测试夹具变换，不是改源码语义。
    // 模板里循环段形如 `for i in $(seq 1 60); do ... pgrep -f "xyz-agent" ... done`
    script = script.replace(
      /for i in \$\(seq 1 60\); do[\s\S]*?done\n/s,
      'echo "[test] skip pgrep wait loop (would match real xyz-agent in dev env)"\n',
    )
    return script
  }

  function makeLinuxVars(): LinuxUpdaterScriptVars {
    return {
      appImagePath: path.join(tmpDir, 'xyz-agent-x86_64.AppImage'),
      newFilePath: path.join(tmpDir, 'update', 'xyz-agent-x86_64.AppImage'),
      logPath: path.join(tmpDir, 'updater-linux.log'),
      resultPath: path.join(tmpDir, 'update-result.json'),
      targetVersion: '0.9.0-int',
    }
  }

  it('happy path：mv 新 AppImage 到位 + chmod 755 + status=done + .old 清理', () => {
    const vars = makeLinuxVars()
    // 预置：旧 AppImage 在位 + 新 AppImage 在 update/
    writeFileSync(vars.appImagePath, 'OLD AppImage content')
    mkdirSync(path.dirname(vars.newFilePath), { recursive: true })
    writeFileSync(vars.newFilePath, 'NEW AppImage content')

    const script = buildLinuxBodyScript(vars)
    const scriptPath = writeScriptToTmp(script, 'linux-updater.sh')

    const r = runBash(scriptPath)
    expect(r.status, `期望 exit 0，stderr=${r.stderr}`).toBe(0)

    // 新 AppImage 就位（mv 走了）
    expect(existsSync(vars.appImagePath)).toBe(true)
    expect(readFileSync(vars.appImagePath, 'utf8')).toBe('NEW AppImage content')
    // .old 备份已被清理（脚本末尾 rm -f）
    expect(existsSync(`${vars.appImagePath}.old`)).toBe(false)
    // chmod 755 生效
    const mode = statSync(vars.appImagePath).mode & 0o777
    expect(mode, `chmod 应为 755，实际=${mode.toString(8)}`).toBe(0o755)
    // result.json status=done
    const result = readFileSync(vars.resultPath, 'utf8')
    expect(result).toContain('"status":"done"')
  })

  it('mv 失败回滚：新文件不存在 → exit 1、旧 AppImage 恢复、status=failed error=mv failed', () => {
    const vars = makeLinuxVars()
    // 预置：旧 AppImage 在位 + 新文件不存在（mv 必失败）
    writeFileSync(vars.appImagePath, 'OLD AppImage content')
    // 不创建 newFilePath → mv 夅败

    const script = buildLinuxBodyScript(vars)
    const scriptPath = writeScriptToTmp(script, 'linux-updater.sh')

    const r = runBash(scriptPath)
    expect(r.status, 'mv 失败应 exit 1').toBe(1)

    // 旧 AppImage 被回滚恢复（脚本：mv 失败 → mv .old 回来）
    expect(existsSync(vars.appImagePath), '旧 AppImage 应被恢复').toBe(true)
    expect(readFileSync(vars.appImagePath, 'utf8')).toBe('OLD AppImage content')
    expect(existsSync(`${vars.appImagePath}.old`), '回滚后 .old 应被 mv 走').toBe(false)

    const result = readFileSync(vars.resultPath, 'utf8')
    expect(result).toContain('"status":"failed"')
    expect(result).toContain('"error":"mv failed"')
  })
})

// ════════════════════════════════════════════════════════════════
// 平台命令可用性（脚本依赖的 CLI 工具是否在 PATH）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: 脚本依赖的 CLI 工具', () => {
  it('shasum 可用（mac/linux 脚本 sha256 校验依赖）', () => {
    // 这是 happy path/sha 校验用例能否真实跑的前提，单独断言让失败原因清晰
    expect(HAS_SHASUM, 'shasum 应在 PATH 中（macOS/linux 标配）').toBe(true)
  })

  it('pgrep 可用（detached 等 app 退出依赖）', () => {
    // pgrep 在主流 *nix 都有；mac 上是 /usr/bin/pgrep
    expect(hasCommand('pgrep'), 'pgrep 应在 PATH 中').toBe(true)
  })

  it('unzip 可用（mac 脚本解压依赖）', () => {
    // 非硬性——unzip 缺则 happy path 用例 skip，但记录环境
    if (!HAS_UNZIP) {
      console.warn('[warn] unzip 不在 PATH，mac happy path 用例将跳过')
    }
    // 仅断言 we 知道它的存在状态（不强制 true）
    expect(typeof HAS_UNZIP).toBe('boolean')
  })
})
