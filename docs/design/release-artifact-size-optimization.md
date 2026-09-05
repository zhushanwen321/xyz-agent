# Release 附件体积优化（第一批 + 第二批）

> 2026-09-05。来源：会话交接文档（/tmp/handoff-taiji-artifact-size-optimization.md，已归档要点并入本文）+ 当日对当前代码的新鲜构建实测修正。
> 本文为自包含文档：所有实测数字来自 dev-0.9.14 分支本地 `pnpm run build:dir` 新鲜产物（mac-arm64 unpacked，不含 pi binary——该链路不跑 prepare-pi-resources.sh，CI 才有），不影响 asar / extraResources 分析。

## 1 背景/目标

单次 GitHub Release 共 7 个附件约 **1.1GB**：dmg 181.5MB / mac zip 181.5MB（自动更新消费）/ win exe 160.7MB / win zip 221.5MB（无消费方）/ AppImage 201.5MB / deb 154MB / manifest KB 级。

目标：把单次发布总量压到约 **420-530MB（-52%~-62%）**，不动功能、不动 Electron/pi 本体。附带收益：GitCode 镜像同步上传时间（跨境 0.09-0.8MB/s，实测波动大，已驱动 GitCode 同步改并发上传）按比例下降。

范围：本文只实施第一批（纯配置）+ 第二批（asar 瘦身）。第三批为产品决策项，只登记不实施（§5）。

Out-of-scope：Electron 本体（icudtl.dat / Framework / SwiftShader）、pi binary（[MANDATORY] 上游禁改）、mac zip→dmg 更新链路改造、砍 deb、ULMO/AppImage xz、差分更新（blockmap/latest.yml）。全部登记 §5。

## 2 现状与根因（新鲜构建实测）

mac unpacked .app = 463MB，构成：

| 组成 | 实测 | 说明 |
|---|---|---|
| app.asar | **155.9MB** | 其中 node_modules ≈135MB 全部是被 vite/tsup bundle 过的冗余拷贝。大头：mermaid 27.2M（含单个 dist/mermaid.js 7.8M）、@shikijs 9.9M、cytoscape-fcose 8.6M + cytoscape 5.1M（经 mermaid 传递依赖回来）、@vue 7.0M、reka-ui 6.6M、@google 4.7M、@xyz-agent 4.2M、openai 3.0M/@smithy 1.4M/@aws-sdk 1.2M/@anthropic-ai 1.3M（经 pi-ai 依赖树混入） |
| extensions（extraResources） | 15MB | 其中 **约 8.7MB 是 .map/.md 垃圾**（.map 合计 8.5M + md 零头）：pi-subagent-workflow/index.js.map 单文件 5.1M（其 index.js 才 2.1M），其余各包 0.2-0.77M map + README |
| app.asar.unpacked | 5.9MB | node-pty 仅 2.4MB（.node 二进制），**无 .pdb**（见 §3 修正 1） |
| locale paks | 48MB | 约 200 个 .lproj 各 0.5-1.6MB；en.lproj 实测 560K |
| renderer/dist | 15.8MB（asar 内） | 16MB JS 中 339 个 shiki 语言/mermaid 子块 chunk 共 11MB（第四批候选，本次不做） |
| dist/main+preload+runtime | ~4.6MB | tsup/vite 已 bundle，minify:false（不改，线上栈可读性优先） |

平台二进制黑洞（@esbuild/* 全平台）：不存在，勿查。

## 3 方案（含对交接文档的三条实证修正）

### 3.1 修正记录（相对交接文档）

1. **「排除 node-pty .pdb」已失效，从计划划掉**。electron-builder 26.15.3 默认排除 `.pdb`（`node_modules/app-builder-lib/out/util/appFileCopier.js:130-132`，`includePdb !== true` 即排；非 Windows 平台还默认排 `.dll`/`.exe`）。新鲜构建 unpacked 内 node-pty 仅 2.4MB、零 pdb。
2. **「升级 electron-builder v27 解锁 ULMO/zstd」当前不可行**。npm dist-tags：`latest=26.15.3`、`v26=26.16.0`、`next=27.0.0-alpha.8`——v27 无稳定版。ULMO 若做只能走 `afterAllArtifactBuild` 钩子 + `hdiutil convert -format ULMO`（第三批再议）。
3. **asar 冗余比交接估算（102.2MB）大 32%**：实测 135MB。第二批收益相应上调。

### 3.2 第一批：纯配置（`apps/electron/electron-builder.yml`）

1. **删 win zip target**：`win.target` 移除 `zip`，只留 `nsis`。依据：`apps/electron/main/release-checker.ts` ASSET_PATTERNS 只认 `-setup-x64.exe`；`scripts/verify-ci-release.sh:130-132` 只硬查 dmg/exe/AppImage；全仓无 `-setup-x64.zip` 消费方。代价：失去 win 免安装绿色版形态（产品已确认接受，2026-09-05 会话）。
2. **语言裁剪**：三段各加 `electronLanguages`——mac 段 `["en", "zh_CN"]`（下划线），win/linux 段 `["en", "zh-CN"]`（连字符）。依据：§2 locale paks 实测 48MB/包，保留 en（回落必需，全删有启动风险）+ zh-CN。electron-builder 原生字段，构建时删除不匹配 lproj/pak。**平台格式差异（实施期 r1 轮构建断言实证）**：electron-builder 的语言对账规则是「目录/文件名去扩展名小写后，与配置项全等或被配置项前缀匹配」（`app-builder-lib/out/electron/ElectronFramework.js:79-89`）——mac lproj 目录名是下划线格式（zh_CN.lproj），连字符写法在 mac 永不匹配、会误删中文 locale；win/linux 的 pak 文件名则是连字符格式（zh-CN.pak）。副作用：mac 的 zh_CN 性别变体（FEMININE 等 3 个）被裁属预期，Chromium 回落标准 zh_CN。
3. **extensions filter 排垃圾**：extraResources 的 extensions filter 加 `!**/*.map`、`!**/README.md`、`!**/ARCHITECTURE.md`。依据：§2 实测 ~8.7MB/包垃圾（.map 合计 8.5M，md 仅零头），压缩态约 -2.5~3MB × 6 附件 ≈ -15~18MB/发布。现有 filter 已排 `.d.ts`/`*.test.*`/tree-sitter 源码，此处补齐同类。
   **禁止用 `!**/*.md` 通配**：staged extensions 内含 7 个 `skills/<name>/SKILL.md`（pi 内置 skills，运行时资源发现机制读取，实测产物清单），通配排除会造成内置 skills 静默消失的功能回归；故 md 只按精确文件名排（包根级文档实测仅 README.md / ARCHITECTURE.md 两种名字，workflows/README.md 为文档无运行时消费）。

### 3.3 第二批：asar 瘦身（`apps/electron/package.json`）

**做法：dependencies → devDependencies 迁移**（electron-builder 只收集 production 依赖树，迁移即豁免）：

- `@xyz-agent/frontend`、`@xyz-agent/runtime`、`@xyz-agent/shared`（workspace 包）：main 进程对三者零外部 require——vite（`vite.config.main.ts`，第三方包一律 bundle 进 main.cjs）与 tsup（`packages/runtime/tsup.config.ts` noExternal 含 `@xyz-agent/shared` 等）已完成打包。fresh build 的 `dist/main/main.cjs`/`dist/preload/*.cjs`/`dist/runtime/index.cjs` 对 `electron-store`/`is-glob`/`markdown-it-footnote`/`undici`/`compare-versions` 的 require 均 grep 零命中。
- `undici`、`compare-versions`：同样已被 bundle（undici ProxyAgent 用于 update 下载，见 `vite.config.main.ts` [HISTORICAL] 注释——历史教训是「标 external 导致运行时崩」，本次反向操作是「挪出 prod deps」，bundle 行为不变，不受该教训影响）。
- **[r1 审查新增] `node-pty` 必须显式新增进 dependencies（`^1.0.0`，对齐 `packages/runtime/package.json`）**：node-pty 当前不是 apps/electron 的直接依赖，是经 runtime 依赖树传递进入收集闭包；runtime 迁出 prod deps 后该传递路径断掉，而 electron-builder 的 files 白名单（`node_modules/node-pty/**/*`）只能在已收集模块内过滤、不能强制纳入未收集的包（实装 `app-builder-lib/out/util/appFileCopier.js` computeNodeModuleFileSets 仅遍历 prod 依赖树）。runtime tsup 将 node-pty 标 external（`packages/runtime/tsup.config.ts`），丢失即终端功能整体崩溃，且 asarUnpack 静默无文件可解（同款事故形态见 electron-builder.yml:41-44 注释）。显式声明后收集闭包恢复包含 node-pty。
- **不动**：`electron-store`/`is-glob`/`markdown-it-footnote`（files 白名单显式收集；一致性审查实测三包在构建产物中 require 零命中，白名单本身已过时，但其清理涉及 preflight-check.sh 现有检查项联动——preflight 现仅查 asarUnpack vs files 一致性（[7/10]）与 native module 探测（[4/10]），**无「files 白名单 ↔ package.json 依赖」对账逻辑，清理时需先新增该检查项**，收益 ~2-3MB 不值得本批冒险，登记 §5 后续项）。
- **alternatives 记录**：另一条路是反向收紧——`files` 加 `!node_modules/**/*` 后显式收齐全部所需包（electron-builder.yml:22-27 注释宣示的现行约定方向）。不选它做本批方案的原因：显式清单需随每次主进程依赖变更手动同步，漏一条即启动崩溃，维护成本在依赖最少的理想假设下也高于 devDeps 迁移（后者由包管理器语义自动保证「bundle 过的不进 asar」）；且本批 5 包迁移零 files 结构改动、可独立回滚。白名单全收集作为 §5 后续项，若未来主进程依赖增多再评估。

预期收益：asar 从 155.9MB 降至 ≤25MB（剩 node-pty 2.2M + 白名单包依赖树 + @types + dist），未压缩 -130MB，压缩态约 **-40MB/包**。

### 3.4 不做清单（防误伤）

- 不开 `compression: maximum`（对 NSIS 无效，源码级 normal/maximum 同映射 `-mx=9`）。
- 不上 universal 双架构（体积 ~2x）。
- 不删 SwiftShader（GPU 不可用环境渲染 fallback，白屏风险）。
- 不动 Electron 本体与 pi binary（上游禁改）。
- 不开 runtime/main minify（无 sourcemap，线上栈不可读）。
- deb 已是 xz 默认，无水分。

## 4 验收

### 4.1 验收场景表

| # | 真实场景 | 通过标准 |
|---|---|---|
| S1 | mac 本地 `pnpm run build:dir` | 构建成功；.app 内 .lproj 只剩 en.lproj/zh_CN.lproj（及 zh-CN 变体若有）；Resources/extensions 无 *.map、根级无 README.md/ARCHITECTURE.md、**skills/*/SKILL.md 全部保留**且 ≤6.5MB；app.asar ≤25MB；**静态断言：app.asar.unpacked 内存在 node_modules/node-pty/prebuilds/darwin-arm64/pty.node 与 spawn-helper** |
| S1.5 | **打包产物真实启动冒烟**（u4 核心验收；主 agent 执行：`open dist/builder-output/mac-arm64/TaiJi.app --args --remote-debugging-port=9222` + browser-automation 连 9222） | 应用启动不白屏；新建会话发一条消息收通（聊天链路）；打开终端面板建立 pty 会话（node-pty 路径，迁移最敏感面）；代码高亮渲染（shiki）；mermaid 渲染。注意：打包版可能与已开实例抢 3210 端口，先查 `lsof -i :3210` |
| S2 | `bash scripts/validate-runtime-bundle.sh` | exit 0（Gate 全过） |
| S3 | `bash scripts/preflight-check.sh --ci` | exit 0（10/10，含 [4/10] native external 探测与 [7/10] asarUnpack vs files 一致性） |
| S5 | 更新链路静态核对 | release-checker.ts ASSET_PATTERNS 与剩余附件形态一致（exe/AppImage/mac zip/deb 均在 pattern 内，dmg 为安装形态不参与更新 pattern，win zip 删除不影响）；pick-platform-asset.ts darwin 分支仍取 `-mac-arm64.zip` |
| S6 | CI 端到端 | 发 beta tag 后 prerelease 验证脚本 exit 0，附件数字符合预期（dmg ~120-130MB / exe ~110-120MB / AppImage ~160MB）——需用户授权 push，独立步骤 |

### 4.2 体积预期（压缩态，全发布）

| 批次 | 总量 | 减幅 |
|---|---|---|
| 现状 | ~1.1GB | — |
| 第一批后 | ~710-770MB | -330~390MB（zip -221.5 + locale -15~25×6 + extensions map/md -15~18） |
| 第二批后 | **~420-530MB** | 累计 -240~290MB（asar -130MB 未压缩 × 压缩比 0.30-0.36 × 6 附件口径） |

## 5 第三批登记（产品决策项，本文不实施）

| 项 | 收益 | 阻塞点 |
|---|---|---|
| 砍 deb | -154MB/发布 | Ubuntu 用户失去 apt 形态，产品决策 |
| dmg ULMO（afterAllArtifactBuild 钩子） | dmg -32%（181.5→~123MB） | 挂载慢 ~4s；v27 稳定版发布后可改原生配置 |
| AppImage 显式 xz | -20%（201.5→~161MB） | 运行时解压启动显著变慢（社区报告），需权衡 |
| mac zip→dmg 更新改造 | -181.5MB/发布 | 中风险改造（hdiutil attach 拷贝），需 tech-design + 更新用例回归 |
| renderer shiki 语言收敛（fine-grained 注册） | -7~9MB 未压缩/包 | 少见语言高亮降级，需产品定语言清单 |
| 白名单包清理（electron-store 等挪 dep + 删 files 白名单） | ~2-3MB/包 | preflight-check.sh 现无「files 白名单 ↔ package.json 依赖」对账检查（一致性审查核实，现有仅 [4/10] native 探测与 [7/10] asarUnpack 一致性），需先新增检查项再清理，单独小批做 |
| 差分更新（blockmap + latest.yml） | 用户侧增量 10-30MB/次 | updater 协议改造，独立专题 |

## 6 实施拆分（impl-plan 种子）

| Unit | 内容 | 领地 | 依赖 |
|---|---|---|---|
| u1 | 删 win zip target | electron-builder.yml `win.target` | 无 |
| u2 | electronLanguages ×3 段 | electron-builder.yml mac/win/linux 段 | 无（借 u1 验证构建） |
| u3 | extensions filter 加 3 条精确排除（.map / README.md / ARCHITECTURE.md） | electron-builder.yml extraResources extensions filter | 无 |
| u4 | 新增 node-pty 显式依赖（^1.0.0）+ 5 依赖挪 devDependencies（@xyz-agent/frontend、@xyz-agent/runtime、@xyz-agent/shared、undici、compare-versions）+ 重装刷新 lockfile | apps/electron/package.json、pnpm-lock.yaml | 无 |
| 冒烟 | S1.5 打包产物启动冒烟（主 agent 执行） | — | u4 |

规则 12（打包子系统改动逐个 commit 逐个验证）：u1-u4 串行，各自独立 commit；u1 的构建验证借 u2 的 build:dir（win zip 删除不影响 mac 产物，配置解析通过即证）。
