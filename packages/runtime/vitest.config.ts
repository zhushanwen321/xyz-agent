import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // cw 验收标记行 reporter：e2e-mock 型验收（如 trace-runtime A31）要求 stdout 含
    // `<验收id> PASS|FAIL` 标记行；--reporter=json 时自静默（vitest 型验收 stdout 须纯 JSON）。
    reporters: ['default', './test/cw-acceptance-markers-reporter.ts'],
    // [HISTORICAL] globalSetup 在 vitest 启动最早期把 XYZ_AGENT_DATA_DIR 指向 tmp 目录，
    // 保证所有 store 的 eager 初始化（如 discovery-store.ts:33 `createDiscoveryStore(getDiscoveryPath())`）
    // 不指向用户真实数据目录 ~/.xyz-agent。
    //
    // 背景：2026-07-26 事故，pi-provider-store.test.ts beforeEach 漏调 setDiscoveryPath，
    // setSkillPaths 经模块级 discoveryStore 写真实路径 ~/.xyz-agent/pi/agent/discovery.json，
    // 写入的是 tmp 路径（测试结束 rm 后失效），用户重启 app 发现 skill 扫描路径「凭空消失」。
    // 此 globalSetup 是结构性兜底——下次有人漏调 set*Path 时，eager 初始化也不会污染用户数据。
    globalSetup: ['./test/global-setup.ts'],
  },
})
