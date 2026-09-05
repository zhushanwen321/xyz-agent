# 审查报告：release-artifact-size-optimization.md（阶段 0 预检门补审，r1）

> 2026-09-05。审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`。所有关键事实均经本地源码 / 新鲜构建产物（`apps/electron/dist/builder-output/mac-arm64/TaiJi.app`）实测复核，非推理断言。

## Summary

2 must-fix, 3 suggestions.

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 / §6 u4 | P0-11/P0-12 事实+副作用 | **node-pty 会随 @xyz-agent/runtime 迁出 production 依赖树而从产物消失**。证据链：① `apps/electron/package.json` dependencies 不含 node-pty，它是 `packages/runtime/package.json:25` 的直接依赖（传递进入收集树）；② electron-builder 的 node_modules 收集 = app 包 production 依赖树闭包（实装 `node_modules/app-builder-lib/out/util/appFileCopier.js:147-171` `computeNodeModuleFileSets` 仅遍历 collector 返回的 prod 依赖树；`collectNodeModulesWithLogging` 走 pnpm prod list），`files` 白名单里的 `node_modules/node-pty/**/*` 只能在**已收集**模块内做过滤，不能强制纳入未收集的包；③ 当前 asar 内 node-pty 仅经由 runtime 树进入。runtime 把 node-pty 标 external（`packages/runtime/tsup.config.ts` `external: ['node-pty']`），丢失即终端功能整体崩溃，且 `asarUnpack` 规则将静默无文件可解（同款历史事故见 electron-builder.yml:41-44 注释）。文档 §3.3 写「不动 node-pty（runtime external，真实运行时依赖）」——但 node-pty 不是 apps/electron 的直接依赖，「不动」在本方案下不成立 | u4 改为：`node-pty` 显式加入 `apps/electron/package.json` dependencies（版本对齐 runtime 的 `^1.0.0`），再执行 5 包迁移；§3.3/§6 同步修正表述 |
| MUST_FIX | §4.1 | P0-13/P0-14 验收 | **最大风险改动 u4（deps 迁移）没有任何「打包产物真实启动」验收场景**。S2 `validate-runtime-bundle.sh` 只验证 dist/runtime bundle 自包含（脚本头注释 1-11 行：tsup 产物存在/依赖打包/health check，不检查 .app/asar 内容）；S4 是 `pnpm dev` 源码模式，完全不经过 electron-builder 收集，u1-u4 四项改动一项都验不到；S1 只查体积断言，不启动应用。node-pty 丢失（上一条 must-fix 的故障形态）在 S1-S5 全部场景下都不会被发现，只有 S6 CI 端到端才可能暴露——而 S6 需用户授权、排独立步骤，等于把首发验证推到发布时刻 | 增加场景 S1.5：启动 build:dir 产物 .app（或 `open` + browser-automation 连 9222），执行至少：应用启动、终端会话建立（node-pty 路径）、聊天收发；或在 S1 补静态断言「asar 内与 app.asar.unpacked 内均存在 node-pty/.node」。此场景同时覆盖 electronLanguages 裁剪后 Electron 42 真实启动风险 |
| SUGGESTION | §3.3 / §6 | P1-8 事实细节 | 依赖数量表述不一致：§3.3 实列 5 个包（frontend/runtime/shared/undici/compare-versions），§3.3 内文还出现「四白名单包」指代不明（未定义哪四个），§6 u4 写「6 依赖」。修正为统一清单（若采纳 must-fix 1 则为 5 迁移 + 1 新增） | 统一计数并消掉「四白名单包」这类未定义指代 |
| SUGGESTION | §3.2/§3.3 | P1-4 决策 alternatives | asar 瘦身只给了 devDependencies 迁移一条路，未记录「为什么不走收紧 files/显式收集全部所需包」的对比（后者正是 electron-builder.yml:22-27 注释宣示的现行约定方向）。§3.4 不做清单部分弥补，但缺一句「迁移 vs 白名单全收集」的取舍理由（维护成本：files 白名单需随依赖手动同步 vs devDeps 迁移由收集器自动保证） | 补 2-3 句 alternatives 记录，说明 devDeps 迁移的长期合理性 |
| SUGGESTION | §3.1/§3.2 | P1-8 事实细节 | 行号小偏差（不影响决策）：`verify-ci-release.sh:130-132` 实际产物硬查在 131-133；`appFileCopier.js:131-137` 的 pdb 排除实际在 133-139（`getNodeModuleExcludedExts`，`includePdb !== true` 即排——结论本身核实无误）。§2「8.9MB .map/.md 垃圾」实测 .map 8.5M + md 零头，量级一致 | 顺手修正行号与数字 |

## 已核实通过的关键事实（对抗复核记录）

以下为文档声称、本次经实测/源码复核**成立**的项，列出让实施者不再重复怀疑：

1. **六包 require 零命中成立**：`dist/main/main.cjs`、`dist/preload/preload.cjs`、`dist/runtime/index.cjs` 对 `@xyz-agent/frontend|runtime|shared`、`undici`、`compare-versions` 的静态 require 全部 0 命中；main.cjs 非 node: 内建的外部 require 仅 `electron`；runtime/index.cjs 仅 `node-pty` 与 node 内建（ajv/dist/runtime/* 命中为 ajv 代码生成的字符串常量，模块本体已被 esbuild bundle 进 index.cjs，见 index.cjs:12642 的模块包裹注释）。
2. **win zip 无消费方成立**：全仓 grep `-setup-x64.zip` / win zip 引用（apps/electron/main、scripts/、.github/）零命中；`release-checker.ts:142-147` ASSET_PATTERNS 只认 exe/dmg/AppImage/deb/mac zip；`verify-ci-release.sh:131-133` 只硬查 dmg/exe/AppImage；`pick-platform-asset.ts` darwin 取 macArm64Zip（§4.1 S5 声明属实）。
3. **extensions filter 攻击面未发现新误伤**：staged extensions 实测 7 个 SKILL.md（与文档一致）；workflows/ 含 `chain.js/scatter-gather.js/parallel.js/review-fix-loop.js` + `_shared/` + `*.cjs` 工具 + README.md（文档性，无运行时消费），relay/ 仅 `relay.mjs`——`!**/*.map`、`!**/README.md`、`!**/ARCHITECTURE.md` 三条规则均不触碰上述运行时资源；扩展内真实 deps（ajv/croner/tree-sitter 等）的 package.json 保留，require 不受影响。
4. **体积数字成立**：app.asar 精确 155.2MB、unpacked 5.9MB、extensions 内 .map 合计 8.5M、asar 内 node_modules 顶层包 419 个（即 §2 所述 135MB 冗余的主体）。
5. **electron-builder 26.15.3**（lockfile `app-builder-lib@26.15.3`）、pdb 默认排除、win zip target 现状（electron-builder.yml:125-127）均与文档一致。
6. **electronLanguages**：electron-builder 原生字段，按 locale 删 .lproj/.pak；保留 en+zh-CN 后 mac 端 zh-CN → zh_CN.lproj 映射属 builder 内置行为，S1 断言「剩 en.lproj/zh_CN.lproj」方向正确——真实启动风险由 must-fix 2 的 S1.5 启动冒烟兜底，无需额外条目。

## 结论

must_fix: 2

两条 must-fix 修完（node-pty 显式入 dependencies + 补打包产物启动冒烟场景）后，方案的第一批/第二批可进入实施；其余事实底座经对抗复核扎实。
