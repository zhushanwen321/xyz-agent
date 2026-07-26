/**
 * validate-release 单元测试（防 SSRF / 路径遍历 / shell 注入）。
 *
 * 覆盖每个校验分支：
 *   - happy path：合法 payload 通过
 *   - version 非法（含特殊字符）
 *   - asset.name 含路径遍历（../）/ shell 元字符（; $ 空格）
 *   - downloadUrl 非 https（http/file）
 *   - downloadUrl 非白名单域名
 *   - downloadUrl 非法格式（无法 parse）
 *   - sha256 格式非法（非 64 位 hex）
 *   - 缺失的 asset 跳过（单平台 release 合法）
 *   - 4 段版本号合法
 *   - objects.githubusercontent.com 域名合法
 *
 * 运行：cd apps/electron/main && npx vitest run test/validate-release.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { LatestReleaseInfo } from '@xyz-agent/shared'
import { validateRelease } from '../update/validate-release.js'
import { UpdateError } from '../update/types.js'

/** 合法的 mac asset（GitHub 域名 + https + 64 位 hex sha256） */
const VALID_MAC = {
  name: 'xyz-agent-mac-arm64.zip',
  downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/xyz-agent-mac-arm64.zip',
  size: 1000,
  sha256: 'a'.repeat(64),
}

/** 构造一个合法的 base release（按需 override） */
function makeRelease(overrides: Partial<LatestReleaseInfo> = {}): LatestReleaseInfo {
  return {
    version: '0.9.0',
    tagName: 'v0.9.0',
    releaseNotes: '## changes',
    publishedAt: '2025-12-01T00:00:00Z',
    htmlUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
    assets: { macArm64Zip: { ...VALID_MAC } },
    ...overrides,
  }
}

/** 覆盖某个 asset */
function withAsset(
  key: 'macArm64Zip' | 'winX64Exe' | 'linuxX64AppImage' | 'linuxX64Deb',
  asset: LatestReleaseInfo['assets']['macArm64Zip'],
): LatestReleaseInfo {
  const release = makeRelease()
  release.assets = { [key]: asset } as LatestReleaseInfo['assets']
  return release
}

describe('validate-release', () => {
  // ── happy path ──────────────────────────────────────────────────
  it('合法 payload（GitHub https + 64 位 hex sha256）→ 不抛', () => {
    expect(() => validateRelease(makeRelease())).not.toThrow()
  })

  it('4 段版本号（0.9.0.1）合法 → 不抛', () => {
    expect(() => validateRelease(makeRelease({ version: '0.9.0.1' }))).not.toThrow()
  })

  it('objects.githubusercontent.com 域名合法 → 不抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.downloadUrl =
      'https://objects.githubusercontent.com/xyz/asset.zip?token=abc'
    expect(() => validateRelease(release)).not.toThrow()
  })

  it('sha256 缺失（undefined）合法 → 不抛（仅 size 校验时 size 不查格式）', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.sha256 = undefined
    expect(() => validateRelease(release)).not.toThrow()
  })

  it('所有 4 个 asset 都存在且合法 → 不抛', () => {
    const release = makeRelease()
    release.assets = {
      macArm64Zip: { ...VALID_MAC },
      winX64Exe: {
        name: 'xyz-agent-win-x64.exe',
        downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/xyz-agent-win-x64.exe',
        size: 2000,
        sha256: 'b'.repeat(64),
      },
      linuxX64AppImage: {
        name: 'xyz-agent-linux-x64.AppImage',
        downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/xyz-agent-linux-x64.AppImage',
        size: 3000,
      },
      linuxX64Deb: {
        name: 'xyz-agent-linux-x64.deb',
        downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/xyz-agent-linux-x64.deb',
        size: 4000,
      },
    }
    expect(() => validateRelease(release)).not.toThrow()
  })

  it('assets 全空对象（无任何平台 asset）合法 → 不抛', () => {
    expect(() => validateRelease(makeRelease({ assets: {} }))).not.toThrow()
  })

  // ── version 非法 ────────────────────────────────────────────────
  it('version 含前导 v → 抛 UpdateError(downloading)', () => {
    expect(() => validateRelease(makeRelease({ version: 'v0.9.0' }))).toThrow(UpdateError)
    expect(() => validateRelease(makeRelease({ version: 'v0.9.0' }))).toThrow(/invalid version/)
  })

  it('version 含特殊字符（0.9.0; rm -rf）→ 抛（防 shell 注入）', () => {
    expect(() => validateRelease(makeRelease({ version: '0.9.0;rm -rf' }))).toThrow(/invalid version/)
  })

  it('version 段数不足（0.9）→ 抛', () => {
    expect(() => validateRelease(makeRelease({ version: '0.9' }))).toThrow(/invalid version/)
  })

  it('version 非数字（x.y.z）→ 抛', () => {
    expect(() => validateRelease(makeRelease({ version: 'x.y.z' }))).toThrow(/invalid version/)
  })

  it('version 5 段（0.9.0.1.2）→ 抛', () => {
    expect(() => validateRelease(makeRelease({ version: '0.9.0.1.2' }))).toThrow(/invalid version/)
  })

  // ── asset.name 路径遍历 + shell 注入 ───────────────────────────
  it('name 含 ../（路径遍历）→ 抛', () => {
    const release = withAsset('macArm64Zip', {
      ...VALID_MAC,
      name: '../../etc/passwd',
    })
    expect(() => validateRelease(release)).toThrow(/invalid asset name/)
  })

  it('name 含分号（shell 元字符）→ 抛', () => {
    const release = withAsset('macArm64Zip', {
      ...VALID_MAC,
      name: 'evil;rm -rf.zip',
    })
    expect(() => validateRelease(release)).toThrow(/invalid asset name/)
  })

  it('name 含空格 → 抛', () => {
    const release = withAsset('macArm64Zip', {
      ...VALID_MAC,
      name: 'evil name.zip',
    })
    expect(() => validateRelease(release)).toThrow(/invalid asset name/)
  })

  it('name 含美元符号（$ 变量展开）→ 抛', () => {
    const release = withAsset('macArm64Zip', {
      ...VALID_MAC,
      name: 'evil$HOME.zip',
    })
    expect(() => validateRelease(release)).toThrow(/invalid asset name/)
  })

  it('name 含反引号（命令替换）→ 抛', () => {
    const release = withAsset('macArm64Zip', {
      ...VALID_MAC,
      name: 'evil`whoami`.zip',
    })
    expect(() => validateRelease(release)).toThrow(/invalid asset name/)
  })

  it('name 含斜杠（路径分隔符）→ 抛', () => {
    const release = withAsset('macArm64Zip', {
      ...VALID_MAC,
      name: 'sub/dir.zip',
    })
    expect(() => validateRelease(release)).toThrow(/invalid asset name/)
  })

  it('winX64Exe asset name 非法 → 抛（不只检查 macArm64Zip）', () => {
    const release = withAsset('winX64Exe', {
      ...VALID_MAC,
      name: '../evil.exe',
    })
    expect(() => validateRelease(release)).toThrow(/invalid asset name/)
  })

  // ── downloadUrl SSRF 防护 ───────────────────────────────────────
  it('downloadUrl 是 http://（非 https）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.downloadUrl =
      'http://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/mac.zip'
    expect(() => validateRelease(release)).toThrow(/must be https/)
  })

  it('downloadUrl 是 file://（本地文件读取 SSRF）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.downloadUrl = 'file:///etc/passwd'
    expect(() => validateRelease(release)).toThrow(/must be https/)
  })

  it('downloadUrl 非白名单域名（内网探测 SSRF）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.downloadUrl =
      'https://169.254.169.254/latest/meta-data/' // AWS metadata endpoint
    expect(() => validateRelease(release)).toThrow(/host not allowed/)
  })

  it('downloadUrl 非白名单域名（example.com）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.downloadUrl = 'https://example.com/mac.zip'
    expect(() => validateRelease(release)).toThrow(/host not allowed/)
  })

  it('downloadUrl localhost（内网探测）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.downloadUrl = 'https://localhost:8080/mac.zip'
    expect(() => validateRelease(release)).toThrow(/host not allowed/)
  })

  it('downloadUrl 非法格式（无法 parse）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.downloadUrl = 'not-a-url'
    expect(() => validateRelease(release)).toThrow(/invalid download url/)
  })

  // ── sha256 格式 ─────────────────────────────────────────────────
  it('sha256 非 64 位（太短 abc123）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.sha256 = 'abc123'
    expect(() => validateRelease(release)).toThrow(/invalid sha256 format/)
  })

  it('sha256 含非 hex 字符 → 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.sha256 = 'g'.repeat(64) // g 不是 hex
    expect(() => validateRelease(release)).toThrow(/invalid sha256 format/)
  })

  it('sha256 含分号（shell 注入到校验脚本）→ 抛', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.sha256 = 'a'.repeat(63) + ';' // 64 字符但含 ;
    expect(() => validateRelease(release)).toThrow(/invalid sha256 format/)
  })

  it('sha256 大写 hex 合法 → 不抛（大小写不敏感）', () => {
    const release = makeRelease()
    release.assets.macArm64Zip!.sha256 = 'A'.repeat(64)
    expect(() => validateRelease(release)).not.toThrow()
  })

  // ── 错误类型 ────────────────────────────────────────────────────
  it('所有校验失败都抛 UpdateError 且 stage=downloading', () => {
    try {
      validateRelease(makeRelease({ version: 'bad' }))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UpdateError)
      expect((err as UpdateError).stage).toBe('downloading')
    }
  })
})
