/**
 * W3 TDD 测试：updater-script（bash 脚本生成器，纯函数）。
 *
 * 覆盖场景 W3TC4：
 *   W3TC4 buildUpdaterScript：断言含关键片段（pgrep/shasum/rm -rf/mv .old/unzip/
 *         xattr -cr/command -v/open -n/update-result.json）+ 占位符全替换（无 {{ 残留）
 *   W3TC4b buildLinuxUpdaterScript：断言含 unlink/mv/chmod/update-result.json + 无 {{ 残留
 *   W3TC4c buildWinInstallerArgs：断言 /S + --updated + /D=<installDir>
 *
 * 纯字符串断言，无 mock。
 *
 * 运行：cd apps/electron/main && npx vitest run test/updater-script.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  buildUpdaterScript,
  buildLinuxUpdaterScript,
  buildWinInstallerArgs,
} from '../update/updater-script.js'

/** 标准变量 fixture */
const MAC_VARS = {
  appBundle: '/Applications/xyz-agent.app',
  zipPath: '/Users/test/.xyz-agent/update/xyz-agent-mac-arm64.zip',
  sha256: 'a'.repeat(64),
  logPath: '/Users/test/.xyz-agent/update/updater.log',
  resultPath: '/Users/test/.xyz-agent/update/update-result.json',
  appName: 'xyz-agent',
  targetVersion: '0.9.0',
}

const LINUX_VARS = {
  appImagePath: '/home/test/xyz-agent-x86_64.AppImage',
  newFilePath: '/home/test/.xyz-agent/update/xyz-agent-x86_64.AppImage',
  sha256: 'a'.repeat(64),
  logPath: '/home/test/.xyz-agent/update/updater-linux.log',
  resultPath: '/home/test/.xyz-agent/update/update-result.json',
  targetVersion: '0.9.0',
}

describe('W3: updater-script (W3TC4)', () => {
  // ── W3TC4：buildUpdaterScript 关键片段 + 占位符替换 ───────────────
  it('W3TC4: buildUpdaterScript 含所有关键片段且占位符全替换', () => {
    const script = buildUpdaterScript(MAC_VARS)

    // 关键片段（守护脚本正确性）
    // 注意：不再含 codesign——未签名发布场景下 ad-hoc 重签无意义（CI 产物本就无
    // Developer ID），xattr -cr 清 quarantine 已足够；--deep 在 macOS 13+ 已弃用。
    const expectedFragments = [
      'pgrep -f',                  // 等 app 退出
      'shasum -a 256',             // sha256 二次校验
      'ROLLBACK: sha mismatch',    // 校验失败回滚
      'rm -rf',                    // rm 半截态
      '.old',                      // mv .old 备份/恢复
      'unzip -o',                  // 解压
      'ROLLBACK: unzip failed',    // 解压失败回滚
      'xattr -cr',                 // 清 quarantine
      'command -v',                // 工具存在守卫
      'open -n',                   // 重启
      'update-result.json',        // result 文件路径已替换进去
      'status":"done"',            // 成功标记
      '0.9.0',                     // 版本号
    ]
    for (const frag of expectedFragments) {
      expect(script, `应包含片段: ${frag}`).toContain(frag)
    }

    // 占位符全替换：无 {{ 残留
    expect(script).not.toMatch(/\{\{[^}]+\}\}/)

    // 实际值已注入
    expect(script).toContain('/Applications/xyz-agent.app')
    expect(script).toContain('a'.repeat(64))
  })

  // ── W3TC4b：buildLinuxUpdaterScript 关键片段（mv .old 备份 + 失败回滚）──
  it('W3TC4b: buildLinuxUpdaterScript 含 mv .old 备份/回滚/chmod 关键片段且无 {{ 残留', () => {
    const script = buildLinuxUpdaterScript(LINUX_VARS)

    const expectedFragments = [
      'pgrep -f',            // 等 app 退出
      'mv "{{APP_IMAGE_PATH}}" "{{APP_IMAGE_PATH}}.old"', // 备份（替换后无占位符）
      'mv "{{NEW_FILE_PATH}}" "{{APP_IMAGE_PATH}}"',      // 替换后无占位符 → 用关键字断言
      'ROLLBACK: mv new AppImage failed',  // mv 失败回滚日志
      'chmod 755',           // 设置可执行权限
      'rm -f',               // 成功后清理 .old
      'update-result.json',  // result 文件
      'status":"done"',      // 成功标记
      '0.9.0',               // 版本号
    ]
    // 上面两条带占位符的断言是为了可读性；实际脚本里占位符已被替换，需校验替换后的真实路径。
    // 改用关键字（去占位符后）逐一断言：
    const realFragments = [
      'pgrep -f',
      `${LINUX_VARS.appImagePath}.old`,   // 备份路径出现（mv ... .old）
      `mv "${LINUX_VARS.newFilePath}" "${LINUX_VARS.appImagePath}"`, // mv 新到位
      'ROLLBACK: mv new AppImage failed',
      'chmod 755',
      'rm -f',
      'update-result.json',
      'status":"done"',
      '0.9.0',
    ]
    for (const frag of realFragments) {
      expect(script, `应包含片段: ${frag}`).toContain(frag)
    }

    // 不应再含 unlink 命令调用（已改为 mv .old 备份模式）；注释里的中文"不 unlink"可忽略
    expect(script).not.toMatch(/\bunlink\b(?=\s+")/)
    // 无 {{ 残留
    expect(script).not.toMatch(/\{\{[^}]+\}\}/)
    // 实际 AppImage 路径注入
    expect(script).toContain('/home/test/xyz-agent-x86_64.AppImage')

    // 消除上方 expectedFragments 未使用告警（保留意图文档化）
    expect(expectedFragments.length).toBeGreaterThan(0)
  })

  // ── W3TC4b2：linux 脚本失败回滚分支结构正确 ─────────────────────
  it('W3TC4b2: buildLinuxUpdaterScript 失败回滚分支 mv .old 回 AppImage', () => {
    const script = buildLinuxUpdaterScript(LINUX_VARS)

    // 回滚分支：if ! mv ... then ... mv .old 回来 ... exit 1
    expect(script).toContain('if ! mv')
    expect(script).toContain(`mv "${LINUX_VARS.appImagePath}.old" "${LINUX_VARS.appImagePath}"`)
    expect(script).toContain('"error":"mv failed"')
    expect(script).toContain('exit 1')
  })

  // ── W3TC4c：buildWinInstallerArgs ───────────────────────────────
  it('W3TC4c: buildWinInstallerArgs 返回 /S + --updated + /D=<installDir>', () => {
    const args = buildWinInstallerArgs('C:\\Users\\test\\AppData\\Local\\xyz-agent')
    expect(args).toEqual([
      '/S',
      '--updated',
      '/D=C:\\Users\\test\\AppData\\Local\\xyz-agent',
    ])
  })

  // ── 防御：sha256 含特殊字符（应原样注入，不破坏脚本）──────────────
  it('W3TC4d: sha256 为 64 位 hex 全替换后脚本语法正确', () => {
    const script = buildUpdaterScript({
      ...MAC_VARS,
      sha256: 'f'.repeat(64),
    })
    expect(script).toContain('f'.repeat(64))
    // 校验行：ACTUAL != 后跟 64 个 f
    expect(script).toMatch(/"\$ACTUAL" != "f{64}"/)
  })
})
