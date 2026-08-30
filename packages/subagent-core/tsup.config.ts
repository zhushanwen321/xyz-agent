import { defineConfig } from 'tsup'

// D4（docs/design/subagent-core-package-extraction.md §3.3）：双形态构建——
// TS 源供 workspace 消费（main/exports 指向 src），dist 双格式供 npm 消费。
//
// entry 用对象形态保形输出：dist/<key>.js|cjs|d.ts|d.cts 与 src/ 目录结构一一对应
// （src/ 前缀替换为 dist/），package.json exports 的语义子入口按同形路径映射
// （./execution/relay-env -> dist/execution/relay-env.cjs 等）。
// 主入口 index 之外的四个 entry 恰好是 exports 的四个语义子入口（D5 公共面）：
// runtime 复用链（D8）与 zsw 复用链（D6）只允许经语义子入口消费这些模块，
// 语义子入口因此必须各自成为 bundle 入口——否则它们只存在于主入口 bundle 内部，
// 无法被独立加载（单一 bundle 不做 chunk 拆分，模块实例也会分裂成两份）。
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'execution/relay-env': 'src/execution/relay-env.ts',
    'execution/engine/paths': 'src/execution/engine/paths.ts',
    'execution/engine/engines/zcode/reader': 'src/execution/engine/engines/zcode/reader.ts',
    'execution/engine/engines/zcode/constants': 'src/execution/engine/engines/zcode/constants.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'node20',
  // D4 关键点：zsw 宿主是 CJS（node>=20），而 @xyz-agent/extension-protocol 的
  // npm dist 仅 ESM（.mjs），node 20 下 require() 加载 ESM 不可靠——
  // 运行时面仅常量的 protocol 必须 bundle 进产物（noExternal），
  // 不让它以外部 ESM 依赖形态出现在 CJS require 链上。
  // （一致性审查 r2 注记：当前 5 个 entry 闭包无 protocol 运行时引用——唯一 import
  // 点 engine-discovery.ts 仅 pi 壳深路径消费，dist 实测零常量命中；noExternal 为
  // 防御性边界，未来 entry 引入运行时引用时即生效 bundle。）
  // 降级路径（D4 既定）：bundle 边界出问题时改为全量 bundle 闭包内非 node 依赖。
  noExternal: ['@xyz-agent/extension-protocol'],
})
