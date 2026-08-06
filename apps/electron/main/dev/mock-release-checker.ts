/**
 * dev-only mock releaseChecker（自动升级 P2 半 E2E 验证用）。
 *
 * 通过 XYZ_DEV_MOCK_UPDATE=1 环境变量启用（main.ts 检测后注入）。
 * 返回伪造的 LatestReleaseInfo（version 999.999.999 永远比当前版本新），
 * 让前端 UpdateButton 显示「可升级」态，便于 Playwright 截图验证。
 *
 * 真实升级流程（performUpdate）仍会因 dev 模式被 MacUpdater 拒绝
 * （app.isPackaged=false 抛 UpdateError），这是有意为之——
 * P2 只验证「检测 → UI 显示」，不验证「真实替换」（P3 才做）。
 *
 * 安全说明：MockReleaseChecker 的代码会被 vite 打包进 prod bundle
 * （vite 不做条件编译），但 main.ts 用 `isDev && DEV_MOCK_UPDATE_ENABLED`
 * 双重保护，prod 构建即使环境变量被误设也永不实例化此类。
 */
import type { LatestReleaseInfo } from '@xyz-agent/shared'
import type { IReleaseChecker } from '../interfaces.js'

/** SHA-256 摘要的十六进制字符长度（mock 占位用 'a' 填充，长度必须合法否则下游校验报错）。 */
const SHA256_HEX_LENGTH = 64

/**
 * 伪造的 LatestReleaseInfo。
 *
 * version 设为 999.999.999：compare-versions 比较时恒大于任何真实版本，
 * 确保前端 UpdateButton 一定能进入 available 态。
 * releaseNotes 含 markdown 元素（标题、列表、代码块），用于验证
 * hover 浮层的 markdown-it + shiki 渲染（HTML 含 <h2>/<pre>/<code>）。
 */
const MOCK_RELEASE: LatestReleaseInfo = {
  version: '999.999.999',
  tagName: 'v999.999.999',
  releaseNotes: [
    '## 测试版本（dev mock）',
    '',
    '- P2 半 E2E 验证用的伪造 release',
    '- hover 此区域应渲染为 HTML（markdown-it + shiki）',
    '',
    '```ts',
    'const x = 42',
    '```',
  ].join('\n'),
  publishedAt: new Date().toISOString(),
  htmlUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/dev-mock',
  assets: {
    // macArm64Zip 是必须的（MacUpdater 走此 asset）；指向不存在的 URL，
    // performUpdate 下载时会失败——但 P2 不走到这步（只验证检测 + UI）。
    // downloadUrl 用合法的 GitHub URL（即使 404），以便通过 validateRelease
    // 白名单校验（update:perform handler 在 performUpdate 前会校验 payload）。
    macArm64Zip: {
      name: 'TaiJi-mac-arm64.zip',
      downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v999.999.999/TaiJi-mac-arm64.zip',
      size: 0,
      sha256: 'a'.repeat(SHA256_HEX_LENGTH),
    },
  },
}

/**
 * dev mock releaseChecker 实现。
 *
 * checkForLatestRelease 直接返回 MOCK_RELEASE，不做任何网络请求。
 * 忽略 currentVersion / force 参数（mock 永远返回「有新版」）。
 */
export class MockReleaseChecker implements IReleaseChecker {
  async checkForLatestRelease(
    _currentVersion: string,
    _opts?: { force?: boolean },
  ): Promise<LatestReleaseInfo | null> {
    return MOCK_RELEASE
  }
}

/**
 * dev mock 开关：XYZ_DEV_MOCK_UPDATE=1 启用。
 *
 * 单独导出（而非内联 process.env 读取）便于：
 * 1. main.ts 注入点清晰可读（isDev && DEV_MOCK_UPDATE_ENABLED）
 * 2. grep 跟踪环境变量的所有消费点
 */
export const DEV_MOCK_UPDATE_ENABLED = process.env.XYZ_DEV_MOCK_UPDATE === '1'
