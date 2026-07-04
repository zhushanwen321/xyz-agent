/**
 * E2E 测试 session 工具 —— 定位 mock 注入的 e2eTestSession。
 *
 * e2eTestSession 由 renderer mock 层注入（mock/data.ts，VITE_E2E=true 时 buildGroups 并入），
 * 其 id 固定为 'e2e-files'，cwd 指向 e2e/fixtures/sample-project（构建期由 Vite define 注入）。
 *
 * 本文件提供 E2E 用例定位/切换到该 session 的辅助函数。
 */

/** E2E 测试 session 的固定 id（与 mock/data.ts e2eTestSession.id 一致） */
export const E2E_TEST_SESSION_ID = 'e2e-files'

/** E2E 测试 session 的固定 label（用于侧边栏 DOM 定位） */
export const E2E_TEST_SESSION_LABEL = 'E2E 文件树测试'

/**
 * sample-project 顶层预期文件（用于断言文件树渲染）。
 * 这些是 e2e/fixtures/sample-project/ 下的真实文件，文件树首加载应渲染顶层节点。
 */
export const SAMPLE_PROJECT_TOP_LEVEL = ['src', 'tests', 'package.json', 'tsconfig.json', 'README.md'] as const

/** sample-project/src 下预期文件（展开 src 目录后应出现） */
export const SAMPLE_PROJECT_SRC_LEVEL = ['index.ts', 'utils'] as const
