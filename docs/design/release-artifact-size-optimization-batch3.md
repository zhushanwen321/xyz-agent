# Release 附件体积优化（第三批）

> 2026-09-05。承接 [release-artifact-size-optimization.md](release-artifact-size-optimization.md)（第一二批，已落地：asar 155.9M→18M、extensions 15M→4.5M、locale 48M→1.1M、win zip 已删）。本文自包含：全部机制断言基于本仓实装源码（electron-builder/app-builder-lib 26.15.3、dmg-builder 26.15.3、shiki 4.3.1、node-pty 1.1.0）与本地产物实测，来源逐条标注；v0.9.13 附件大小来自 GitHub Release 实测（gh api）。

## 1 背景与目标

**SCQA**：第一二批落地后单发布仍为 6 附件形态（dmg / mac zip / exe / AppImage / deb / manifest）——mac dmg+zip 双发重复 ~120-190MB（zip 仅为自动更新链路消费）；deb 从未支持自动更新却占位 ~115-160MB；压缩格式保守（dmg UDZO-zlib / AppImage squashfs-gzip）；renderer 产物里 8.1MB 语言 chunk 中 ~7.5MB 是运行时永不加载的死重；node-pty 携带全平台 prebuilds。**目标：六项改造把发布收敛为 3 附件（dmg / exe / AppImage）+ manifest，总量预期压至 ~200-320MB**（基数含第一二批收益的推算，S6 CI 实证），全程不动功能语义、不动 Electron/pi 本体、不新增依赖包。

**产品拍板（2026-09-05 用户确认「AB 都要做」）**：批次 A（纯技术）+ 批次 B（含产品决策项）全部实施。批次 B 中「砍 deb 失去 apt 形态」「AppImage xz 首启变慢」「mac 存量版本断供自动更新」三个代价已在拍板时知情。

**In-scope**：① shiki 语言收敛（renderer）② node-pty prebuilds 平台裁剪 ③ AppImage 内部压缩 xz ④ dmg 格式 ULFO ⑤ 砍 deb 附件 ⑥ mac 自动更新从消费 zip 改为消费 dmg（含删 mac zip target）。

**Out-of-scope**（不立项，含理由）：Electron 本体 224M / pi binary 71M（上游禁改）；mermaid 图表按需注册（-2.5M 但砍可见功能）；差分更新 blockmap/latest.yml（自研 updater 整包链路，独立专题）；白名单包清理（asar 内白名单树实测仅 1.06M，-2MB/发布，收益不值得新增 preflight 检查项）；katex 字体三格式收敛（880K，收益过小）；universal 双架构 / minify（第一二批 §3.4 已锁定不做）。

## 2 现状与问题分析

### 2.1 附件形态与消费方（谁在用哪个附件）

| 附件 | v0.9.13 实测 | 程序化消费方 | 结论 |
|---|---|---|---|
| TaiJi-…-mac-arm64.dmg | 190.3MB | **无**（纯人工安装形态；更新链路不认 dmg） | ULFO 化只省下载流量 |
| TaiJi-…-mac-arm64.zip | 190.3MB | 自研 updater darwin 分支（pick-platform-asset.ts:20 取 `macArm64Zip`） | 与 dmg 内容 100% 重复 |
| TaiJi-…-setup-x64.exe | 168.5MB | 自研 updater win 分支（NSIS 静默重装） | 不动 |
| TaiJi-…-x86_64.AppImage | 211.3MB | 自研 updater linux 分支（整文件替换，压缩格式零感知） | xz 化透明 |
| TaiJi-…-amd64.deb | 161.5MB | **零**——更新链路三重拦截（orchestrator.ts:132-134 linux 非 APPIMAGE 即拒；updater 抛 `UpdateUnsupportedError('deb package does not support self-update')`） | 纯下载形态，可砍 |
| manifest.json | 988B | release-checker sha256 fallback（digest 缺失时才读） | 保留 |

### 2.2 mac 自动更新链路现状（改造对象）

```
renderer 触发 → IPC update:check → ReleaseChecker.checkForLatestRelease
  （GET /releases/latest，ASSET_PATTERNS 后缀匹配 4 类 asset，release-checker.ts:142-147）
→ pickPlatformAsset（darwin → assets.macArm64Zip，pick-platform-asset.ts:19-24）
→ orchestrator.downloadUpdate（流式下载 + sha256 校验）
→ MacUpdater 生成 bash 脚本 detached spawn
→ MAC_UPDATER_TEMPLATE（updater-script.ts:180-321）：
   S0a 从 /Volumes 运行拒 → S0b 等父退出 → S0c shasum 复验
   → S1 unzip -q -o "$ZIP" -d "$STAGING"（:268，唯一解包原语）
   → S2/S3/S4 mv 三步换装（失败回滚 .old）→ S5 xattr -cr 清隔离属性
→ open "$APP" 重启
```

**关键事实**：脚本对 zip 的唯一依赖是 S1 段的 `unzip`；下载与 sha256 校验对文件格式无感知（download-asset.ts:316-343 整文件校验）。即改造面收敛为「S1 解包原语替换」。

**sha256 双源时序**：主源 = GitHub API `asset.digest`（服务端对实际上传文件计算，v0.9.13 全部 7 附件实测有值）；fallback = manifest.json（build.yml:265-267 generate-manifest.sh 在构建**之后**读文件计算）。任何改变 dmg 字节内容的操作必须发生在 generate-manifest 之前——本文 §3.3.4 的原生 format 方案天然满足（builder 内部生成即终态）。

### 2.3 renderer 语言 chunk 死重根因

`markdown.ts:28` `import { createHighlighter } from 'shiki'`（full bundle）→ shiki full bundle 的 `langs-bundle-full` 模块内含 **235 个** `import("@shikijs/langs/<lang>")` 动态条目（node_modules/shiki/dist/langs-bundle-full-*.mjs 实测 grep 计数）→ rolldown 对每个动态入口产独立 chunk → 产物 `renderer/dist/assets/` 实测 **289 个语言 chunk 共 ~8.1MB**。而运行时只注册 13 语言（markdown.ts:55 SHIKI_LANGS），未注册语言一律回落 typescript（:122-134）——**~7.5MB 是模块图里存在、运行时永不加载的死重**。vite.config.ts:81 的 shiki 组 regex 已用负向前瞻排除 `@shikijs/langs/`，与死重成因无关，改造后无需同步（该文件 :66-67 关于「235 动态 chunk 按需分离」的注释随 full bundle 移除而失真，已在阶段 3 修复批次补 [HISTORICAL] 标注）。

### 2.4 node-pty 全平台 prebuilds

产物 app.asar.unpacked 内 `node_modules/node-pty/prebuilds/` 实测（mac-arm64 产物）：win32-x64 736K + win32-arm64 704K + darwin-x64 64K + darwin-arm64 136K（实际需要）= **~1.5M 跨平台死重**（.pdb/.dll/.exe 已被 appFileCopier 默认排除，剩余为 .node 载荷）。加载路径按 `process.platform + "-" + process.arch` 拼接（node-pty lib/utils.js:17-19），win32 目录在 mac 上永不命中——排除安全。

### 2.5 存量断供面（删 mac zip 的影响）

git 逐 tag 核实：**v0.8.44 ~ v0.9.13 全体 darwin 正式版的自动更新消费 `-mac-arm64.zip`**（v0.8.44 起改后缀匹配，ad0bcf86a；≤v0.8.43 精确名匹配时代已因 artifactName 改名断供）。删 zip 后这些版本 `pickAsset` 返回 undefined → `downloadUpdate` 抛 `UpdateError('no asset for platform darwin')`（orchestrator.ts:184-187）——**表现为升级报错而非 404**，下载不发起。用户出路：按 release 页 / README 手动下载 dmg 重装。版本号双序列（v0.9.x 与 v0.80-0.85.x 并存发版）中的 darwin 用户同受此影响。仓库内无用户量遥测，影响面无法量化（如实声明）。

## 3 方案

### 3.1 终态（使用者视角）

- **国内/海外用户下载**：release 页只剩 dmg / exe / AppImage 三个安装包 + manifest，页面体积减半以上；dmg 与 AppImage 下载流量再降（ULFO / xz）。
- **mac 自动更新（新版本起）**：检查更新 → 下载 dmg → 脚本挂载 dmg、ditto 拷出新 .app、原子换装、重启——用户视角与现在完全一致（进度条、重启提示、失败回滚）。存量 v0.8.44~v0.9.13 用户点「检查更新」会收到升级报错，错误信息引导到 release 页手动下载（§3.3.6-D）。
- **linux 用户**：AppImage 自动更新不变；首启解压稍慢（xz 换 gzip 的已知代价，产品已接受）；原 deb 用户本来就无自动更新，转手动下载 AppImage（无回归）。
- **代码高亮**：13 种语言（ts/js/vue/json/bash/shell/markdown/css/html/yaml/python/go/rust）高亮效果与现在逐字节一致（同一份 grammar JSON）；第 14 种语言起回落 typescript——与现状行为相同，无任何可见变化。

### 3.2 批次 A：纯技术项

#### 3.2.1 shiki 语言收敛（markdown.ts 单文件）

| 候选 | 长期合理性 | 短期成本 | 风险 | 结论 |
|---|---|---|---|---|
| **A1 full bundle → core + 显式 13 grammar**（`createHighlighterCore` from `shiki/core` + 静态 import `@shikijs/langs/<id>` + `@shikijs/themes/min-dark|min-light`） | 死模块从模块图消失，235 chunk 构造性绝迹；依赖面从「全量 langs」收缩为「13 文件」 | 单文件 import 区 + 初始化调用改造 + 单测 | alias 桥接依赖 grammar 自带 aliases（见下方对账，r1 已证无显式配置需求） | **采用** |
| A2 保持 full bundle + `loadLanguage` 运行时按需加载 | 依赖面不变，模块图仍含全量动态入口，死 chunk 不消失 | — | 达不到目的 | 被否：不解决死重 |
| A3 vite manualChunks/rollup options 强制排除 langs chunk | 构建期黑名单，绕过模块图 | 配置魔改 | full bundle 运行时若真动态加载被排 chunk 会的加载失败；脆弱 | 被否：掩盖而非消除 |

**API 兼容性（实装 4.3.1 已核实）**：`HighlighterCore` 与 bundle 版 `Highlighter` 同源（`HighlighterGeneric`），`codeToHtml(code, { lang, themes: {dark, light}, defaultColor: false })` 与 `getLoadedLanguages()` 签名不变——markdown.ts 现有调用点 :123-129 零改动，仅类型标注 `Highlighter` → `HighlighterCore` 与 import 区替换。

**alias 对账（r1 审查修正）**：SHIKI_LANGS 里的 `'bash'`、`'shell'` 与 grammar 注册名 `shellscript` 的桥接**无需显式 `langAlias` 配置**——实装 @shikijs/langs 4.3.1 的 shellscript grammar JSON 自带 `"aliases":["bash","sh","shell","zsh"]`（langs/dist/shellscript.mjs 尾部原文），primitive 的 loadLanguage 自动把 `lang.aliases` 写入 alias 表（@shikijs/primitive/dist/index.mjs:285-287），`getLoadedLanguages()` 返回已注册键 + alias 键（:319-321）——即静态 import `@shikijs/langs/shellscript` 单文件即覆盖 SHIKI_LANGS 的 bash/shell 两项（bash.mjs/shell.mjs 只是 shellscript 的别名 re-export，不重复 import）。**无需 langAlias 配置**；S1 验收保留 bash/sh alias 高亮断言，防未来 shiki 升级时 grammar 丢失 aliases 的静默回归。typescript 语法自带 `["ts","cts","mts"]` alias 同理自动注册。

**vue 嵌入自包含性**：`@shikijs/langs/vue` 单模块默认导出含全部内嵌 grammar（vue + html-derivative + markdown-vue 等），跨语言嵌入（css/js/ts/json/html）由 13 语言全注册满足（缺失校验在 primitive :305-317，构建期即暴露）。

#### 3.2.2 node-pty prebuilds 平台裁剪（electron-builder.yml 平台段）

| 候选 | 结论 |
|---|---|
| **B1 平台段 files 排除**（`mac.files: ["!node_modules/node-pty/prebuilds/win32-*"]` 等） | **采用**：平台段与顶层 files 是**追加合并**语义（app-builder-lib fileMatcher.js:250-253 实测源码：顶层先 addPatterns，平台段再追加），排除模式追加即生效，零脚本 |
| B2 afterPack 钩子删目录 | 被否：需引入 JS 配置/钩子文件（现状纯 yml 无任何 hook，全仓 grep 零命中），为一个目录排除引入新机制 |
| B3 postinstall 源头 prune node_modules | 被否：污染开发环境 node_modules，影响本地 win 调试与重装 |

三个平台段各加一行：mac 排除 `win32-*` 与 `darwin-x64`；win 排除 `darwin-*`；linux 排除 `darwin-*` 与 `win32-*`（win 只打 x64，`win32-arm64` 一并自然消失）。产物预期：mac unpacked node-pty 2.15M → ~0.6M。

### 3.3 批次 B：附件形态与更新链路

#### 3.3.1 AppImage 内部压缩 xz（纯配置）

electron-builder 原生字段 `appImage.compression: "xz"`（linuxOptions.d.ts:177-198；消费逻辑 AppImageTarget.js:83-92：显式 xz 直接透传 mksquashfs `-comp xz -Xdict-size 100% -b 1048576`）。**[u4 实施修正] 配置位置是顶层 `appImage:` 段（驼峰 key，大写 I），不是 linux: 子段**——scheme.json 的 LinuxConfiguration 无 appimage 属性且 additionalProperties: false，放 linux 段会被 schema 校验拒绝（26.15.3 实测复现，与 u3 的 dmg 顶层段修正同型）。本项目未配置 `toolsets.appimage` → 走 legacy FUSE2 路径（xz 可用；static toolset 路径不支持 xz，AppImageTarget.js:111-121，不适用本仓）。

**收益实测（u4 双构建，实施期门②已解答——本地构建 linux AppImage 可行）**：gzip 基线 117,491,716 B vs xz 85,595,477 B（linux-arm64，mac 本地构建）= **-27.1%**，超出设计期预期 -15~20%。两产物 `file` 断言均为 ELF executable（语义锁定验证通过）。

**[语义锁定] 「xz 压缩」= AppImage 内部 squashfs 压缩算法换 xz，产物仍是可执行单文件 `TaiJi-*.AppImage`**。严禁理解为外层再包 `.xz` 归档——linux updater 脚本替换后直接 exec 该文件（updater-script.ts:425），外层归档会让更新后 app 无法启动且 self-healer 不回滚（脚本已写 done）。原生配置字段恰好杜绝了这种误实现。

**代价**：xz 解压慢于 gzip，AppImage 首次启动 / 更新后首次启动增加数秒（社区共识 + 产品拍板接受）。**收益未实测**：预期 -15~20%（gzip→xz 对已高度冗余的 Electron payload），⛔ 实施期以完整构建实测为准。

#### 3.3.2 dmg 格式 ULFO（纯配置，修正登记表「ULMO」措辞）

electron-builder 原生字段 `dmg.format: "ULFO"`（DmgOptions 类型 macOptions.d.ts:261 枚举 `"UDRW"|"UDRO"|"UDCO"|"UDZO"|"UDBZ"|"ULFO"`；未设置时按 compression 推导默认 UDZO，dmg.js:122-131）。**[u3 实施修正] 配置位置是顶层 `dmg:` 段（与 mac/win/nsis 同级），不是 mac: 子段**——dmg-builder 运行时直读 `packager.config.dmg`（node_modules/dmg-builder/out/dmg.js:19），app-builder-lib scheme.json 的 MacConfiguration 无 dmg 属性，放 mac 段会被 schema 校验拒绝（26.15.3 实测复现）。**第一二批 §5 登记表写的「ULMO」是 hdiutil 格式名（lzma），builder 类型面只暴露 ULFO（lzfse，macOS 10.11+）——本文按 builder 实际支持面修正为 ULFO**。

**收益实测（u3 双构建对比，实施期门①已解答）**：同 commit UDZO 111,226,141 B vs ULFO 109,260,933 B = **-1.77%**，远低于设计期预期 -10~15%——第一二批把 asar/locale/extensions 冗余清除后，dmg 内容以 Electron 本体二进制为主（zlib 已压得很紧），lzfse 增量空间有限。格式断言（imageinfo Format: ULFO / Compressed Ratio 0.42）、挂载透明、体积严格小于基线均成立；-2MB/发布的收益虽小但零风险零成本（纯配置）。

| 候选 | 压缩 | 挂载速度 | 结论 |
|---|---|---|---|
| UDZO（现状默认，zlib） | 基线 | 基线 | 被否：保持现状无收益 |
| **ULFO（lzfse）** | **实测 -1.77%（u3，见下）** | 与 UDZO 相当或更快 | **采用** |
| UDBZ（bzip2） | 最高 | 慢 + macOS 10.15 起弃用警告 | 被否 |
| afterAllArtifactBuild 钩子 hdiutil convert ULMO | 同类收益 | — | 被否：需把纯 yml 配置改成 JS hook 形态，且转换若插错时序（generate-manifest 前后）会让 manifest fallback sha 与 digest 主源不一致——该不一致 CI 不报错、只在用户机以「下载校验失败」暴露（§2.2）；原生 format 在 builder 内部生成即终态，时序风险构造性不存在 |

hdiutil attach 对 ULFO 完全透明（系统层解压），updater 脚本与人工挂载均无感知。

#### 3.3.2b 砍 deb（配置 + 消费方清理）

1. electron-builder.yml `linux.target` 删 `deb` 条目（+ 相邻注释同步）。
2. release-checker.ts `ASSET_PATTERNS.linuxX64Deb` 删除（含 shared 类型 packages/shared/src/update.ts:26 的 `linuxX64Deb` 字段——**删除而非保留 undefined**：保留 = 永远 undefined 的死字段 + validate-release 白名单校验空转）。
3. validate-release.ts:54 硬编码 key 列表删 `linuxX64Deb`。
4. scripts/generate-manifest.sh:83-86 的扩展名正则删 `deb`（留着无害——匹配不到文件——清理是防误导）。
5. build.yml:292 上传 glob 删 `*.deb` 行（同上：`if-no-files-found` 判定的是全部 glob 合计零文件，删行非阻塞，属语义清洁）。
6. verify-ci-release.sh **兼容性无需改动**（只硬查 dmg/exe/AppImage，:130-132；附件数断言 `≥3`，:106）——S11 要求的「无 zip/deb」负向断言（防 target 回潮）已在阶段 3 修复批次落地（04473fb64），非本单元范围。

#### 3.3.3 mac 自动更新改走 dmg（核心改造，u6）

**A. asset 定位链**（5 处源码 + 类型）：
- release-checker.ts：`ASSET_PATTERNS.macArm64Zip: endsWith('-mac-arm64.zip')` → `macArm64Dmg: endsWith('-mac-arm64.dmg')`；buildLatestReleaseInfo 组装字段同步（:446-449, :458）。
- pick-platform-asset.ts:20：darwin 分支 → `release.assets.macArm64Dmg`。
- **platform-updater.ts:104**：MacUpdater 直读 `release.assets.macArm64Zip?.sha256?.toLowerCase()` 拼 S0c 校验值——**不经 pickPlatformAsset**（r1 审查发现的遗漏直读点），同步改读 macArm64Dmg。
- main/update/dev/mock-release-checker.ts:50：dev 桩（main.ts dev 模式引入），同步字段名。
- packages/shared/src/update.ts：LatestReleaseInfo.assets 字段 `macArm64Zip` → `macArm64Dmg`。
- **[必须] validate-release.ts:54 key 列表同步**（`['macArm64Dmg','winX64Exe','linuxX64AppImage']`）——该列表是 asset URL 的 SSRF/白名单校验入口，漏同步 = dmg asset 跳过防御校验（调研发现的隐性耦合，纵深缺口）。
- preloaded-update.ts / manual-claim.ts 经 pickPlatformAsset 派生，自动跟随，零改动。
- **测试同步面以 grep 为准**：全仓 `macArm64Zip` 命中 13 个测试文件（validate-release / platform-updater / pending-update / update-handlers-orchestration / pick-platform-asset / release-checker / u5d-contract / orchestrator / manual-claim / preloaded-update / release-checker-upgrade-fetch / update-handlers / update-handlers-local 各 .test.ts），TS typecheck 兜底暴露，但实施时以 grep 清单逐一改而非依赖编译报错。

**[必须] mountpoint 选址约束（r1 审查探针实证）**：`/Volumes` 为 `root:wheel 755`，普通用户 `mktemp -d /Volumes/...` 直接 Permission denied——updater 脚本由 app 以登录用户身份 spawn，无 root，挂载点必须建在用户可写目录（`$TMPDIR`）。且 **mountpoint 必须独立于 `$STAGING_DIR`**：detach 失败不阻断的语义下挂载卷可能滞留，后续 staging 清理不得波及活跃挂载卷。✅已测（r1 探针全链路：用户目录 mountpoint + `hdiutil attach -readonly` ULFO dmg + `ls -d $MOUNT_DIR/*.app` 命中 + `ditto` 拷出 exec 位保留 + detach 成功）。

**B. updater 脚本解包原语替换**（MAC_UPDATER_TEMPLATE，updater-script.ts:180-321）——S1 段重写：

```bash
# 现：unzip -q -o "{{ZIP_PATH}}" -d "$STAGING_DIR"（:268）
# 改（伪码，实施期按模板变量风格落地）：
MOUNT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/taiji-dmg.XXXXXX") || fail "mktemp mountpoint failed"
hdiutil attach -nobrowse -readonly "{{DMG_PATH}}" -mountpoint "$MOUNT_DIR" \
  || { hdiutil detach "$MOUNT_DIR" 2>/dev/null; fail "dmg mount failed"; }
SRC_APP=$(ls -d "$MOUNT_DIR"/*.app 2>/dev/null | head -1) || { detach_and_fail "no .app in dmg"; }
ditto "$SRC_APP" "$STAGED_APP" || detach_and_fail "ditto copy failed"
hdiutil detach "$MOUNT_DIR" || hdiutil eject "$MOUNT_DIR" 2>/dev/null   # detach 失败不阻断
```

决策：**ditto 而非 cp -R**（ditto 保留签名/xattr/权限，Electron app 换装的标准做法）；**detach 失败降级不阻断**（卷句柄滞留不影响已拷出的 .app，S2-S4 换装继续；孤儿挂载点由系统重启回收，不构成更新失败理由）；`-mountpoint` 显式挂载点 + `mktemp` 随机后缀防卷名冲突与路径残留（r2 审查实测：随机性结构性防住同路径冲突，但**同 inode dmg 在前次挂载未 detach 时重挂载会报「资源忙」exit 1**——触发需「前次 attach 后失败 且 detach_and_fail 的 detach 也失败」双重罕见叠加且复用同 inode 文件；正常路径——换版本 / 重下载换 inode（temp+rename，实测换 inode 后不受影响）/ 正常 detach 后重试——三种均实测 exit 0。处置：不引入 stale 挂载自动清理（触发面极窄不值得解析 `hdiutil info` 的脆弱性），`dmg mount failed` 错误信息带恢复动作「重启系统或手动 hdiutil detach 后重试」，S9 覆盖该边界用例）；S0a 既有「从 /Volumes 运行拒绝升级」守卫在 dmg 场景更重要（用户直接从挂载 dmg 里跑 app），保持不动；S0c shasum、S2-S5 换装/回滚/xattr 逻辑全部不动。

**C. 构建侧删 mac zip**：electron-builder.yml mac.target 删 `zip` 条目；artifactName 注释（:127-129「zip 和 dmg 共用此 pattern」）同步；build.yml:289 上传 glob 删 `*.zip` 行 + :273-276 签名注释（「zip 内的 .app 不可能被签上」段）同步清理。

**D. 存量断供处置**：接受断供（用户已拍板）。理由：①beta 阶段、无用户量遥测，损失上限是「存量 darwin 用户手动下载一次」；②同性质断供先例已有（v0.8.44 artifactName 改名对 ≤0.8.43 用户）；③过渡双发（zip 再保留 N 版）成本 120-190MB/版本，与目标直接冲突。**配套增强（可操作性）**：核实现有 `UpdateError('no asset for platform darwin')` 的 UI 展示是否携带 release 页链接（orchestrator.ts:186 抛错处），不带则把 `release.htmlUrl` 并入错误信息——存量用户报错时有一键出路，符合「错误信息必须可操作」底线。被否方案：过渡双发（成本冲突）；服务端按 UA 返回旧 zip（无此基建，过度设计）。

#### 3.3.4 关键决策汇总（选择 / 被否 / 证据锚点）

| # | 决策 | 被否 | 证据 |
|---|---|---|---|
| D1 | 断供接受 + 错误信息带 release 链接 | 过渡双发 / UA 适配 | §2.5 断供面；§3.3.3-D |
| D2 | dmg 用原生 `format: ULFO` | hook 转换 / UDBZ | §3.3.2 时序分析 |
| D3 | AppImage xz 限定 squashfs 内部压缩 | 外层 .xz 归档 | §3.3.1 语义锁定（exec 会炸） |
| D4 | updater 用 ditto 换装 | cp -R | §3.3.3-B |
| D5 | shiki 走 core + 显式 import（alias 桥接靠 grammar 自带 aliases，无需 langAlias 配置） | 按需 loadLanguage / 构建期排除 / 显式 langAlias 配置 | §3.2.1 对比表与 alias 对账段 |
| D6 | deb 字段整体删除（非留空） | 保留 undefined 死字段 | §3.3.2b-2 |
| D7 | prebuilds 用平台段 files | hook 删目录 / postinstall prune | §3.2.2 对比表 |

探针状态：✅已测（本文引用的 file:line 断言均经实装源码核实；mountpoint 选址 + ULFO 挂载 + ditto 保权全链路经 r1 审查探针实测，dmg 内 .app 以 `ls -d $MOUNT_DIR/*.app` 命中亦已实测；**①ULFO 收益已测——u3 双构建对比实测 -1.77%**，见 §3.3.2）；⛔实施期门——②本地 mac 构建 linux AppImage 的可行性（可行则本地验证 xz，否则降级 S11 CI 断言）③UpdateError UI 展示形态。

### 3.4 不做清单（防误伤，继承第一二批 §3.4 并追加）

不删 SwiftShader（GPU fallback 白屏风险）；不动 minify/compression 顶层字段（`packager.compression: maximum` 会让 AppImage 隐式变 xz + dmg 推导 UDBZ，副作用路径不可控，本文全部用显式字段）；不动 SHIKI_DARK/SHIKI_LIGHT 主题与 JS regex 引擎（CSP 事故教训，markdown.ts:81-86 注释）；不砍 mermaid 具名图表 chunk。

## 4 验收（真实场景）

| # | 场景 | 通过标准 |
|---|---|---|
| S1 shiki 单测 | vitest（renderer 包） | 13 语言逐个 codeToHtml 产出非空且含 `<span` 样式节点；`bash`/`sh`/`shell`/`zsh` 四 alias 均按 shellscript 高亮（grammar aliases 回归防护，见 §3.2.1）；未注册语言（如 `abap`）回落 typescript；双主题 CSS 变量输出（defaultColor:false 断言） |
| S2 shiki 产物断言 | `pnpm run build:dir` 后 renderer/dist/assets | 语言 chunk 文件数 ≤14（13 语言 + hash 变体容差）且合计 ≤1.2MB（r1 校准：13 语言静态 import 实际带入 18 个 grammar 模块——vue 内嵌等——raw 实测 812K + 主题 16K，minify 对 JSON 串几乎无收益；现状 289 个 / 8.1MB）；`grep -l abap` 类死语言 chunk 零命中；asar 总体积较基线再降 ≥5MB |
| S3 shiki 冒烟 | 打包产物启动 + 真实会话 | 发含 ```bash 与 ```python 代码块的消息，渲染出语法高亮（非纯文本、非误降级 typescript 样式）；mermaid 块渲染不受影响 |
| S4 pty 产物断言 | build:dir 后 app.asar.unpacked | mac 产物 prebuilds 仅 `darwin-arm64`；win32-*/darwin-x64 零命中；`darwin-arm64/pty.node + spawn-helper` 在位 |
| S5 pty 冒烟 | 打包产物终端面板 | 建立 pty 会话 `echo PTY_OK` 回显成功（平台裁剪最敏感面 = .node 加载路径） |
| S6 dmg ULFO | 本地完整 dmg 构建（build:dir 不产 dmg，用 `--mac dmg` 单 target 构建） | `hdiutil imageinfo <dmg>` Format 含 `ULFO`；体积 < UDZO 基线（同 commit 对比构建或引用上一版 dmg 数字）；`hdiutil attach` 后 .app 可见、ditto 拷出可启动（衔接 S10 脚本测试前置） |
| S7 AppImage xz | 本地构建 linux AppImage（⛔ 可行性门：mac 上 electron-builder 打 linux target；不可行则降级为 S11 CI 断言） | 产物存在且可执行位在（`file` 输出仍为 executable/AppImage 而非压缩归档）；体积 < gzip 基线预期 -15% 以上 |
| S8 更新改造单测 | vitest（main 包） | 模板生成断言：脚本含 hdiutil attach/ditto/detach 命令序列、mountpoint 在用户可写目录（`$TMPDIR` 下 mktemp）**且独立于 STAGING_DIR**、attach 失败走 fail 分支、detach 失败不阻断（无 fail 调用）、S2-S5 换装/回滚段未被改动；ASSET_PATTERNS 匹配 `TaiJi-x.y.z-mac-arm64.dmg` 且不匹配 `.zip`；pick-platform-asset darwin 分支返回 dmg；MacUpdater（platform-updater.ts:104）sha256 取自 macArm64Dmg 字段 |
| S9 更新改造半真实 | 本地：真实构建新旧两版 ULFO dmg + 直接执行生成的 updater 脚本（测试环境注入模板变量跑 bash，不经 app） | 脚本跑完 exit 0：目标位置 .app 被替换为新版（比对 Info.plist 版本号）；.old 清理；模拟 attach 失败（喂损坏 dmg）→ 走 fail 分支 exit 非 0 且原 .app 未动；同文件双挂载边界（同一 dmg 先挂载不 detach，再对其跑脚本）→ 走 fail 分支 exit 非 0、错误信息含恢复指引、原 .app 未动（§3.3.3-B r2 边界） |
| S10 更新冒烟（打包产物） | 打包产物内触发检查更新——**走 mock-release-checker 桩路线**（dev 桩返回本地 HTTP asset URL；hosts 劫持 GitHub API 的路线有 TLS 证书障碍不可行；downloadAsset 不做 host 白名单校验，白名单在 install 段 validateRelease——S10 恰到 install 前为止） | darwin 分支定位到 dmg asset、下载完成、弹出重启确认——install 段用 S9 已覆盖，此处到 install 前为止即 pass（install 真跑会换装测试机 app，S11 兜底） |
| S11 CI 端到端（S6 同款，blocked 待 push 授权） | 发 beta tag → prerelease 验证脚本 | 附件清单 = dmg/exe/AppImage/manifest 且无 zip/deb（verify-ci-release.sh 需同步加「**无** zip/deb」负向断言，防回潮）；数字符合预期（dmg Format=ULFO 且体积 ≤ UDZO 基线——收益已按 u3 实测校准为 -1.77%；AppImage -15%+；全发布 ~200-320MB）；GitCode 镜像同步成功 |

每个场景回溯 §1 目标：S1-S5→批次 A「不动功能」与死重清除；S6-S7→压缩格式目标；S8-S10→更新链路改造「用户视角一致」；S11→总量目标与 3 附件形态。

## 5 下一层拆分（impl-plan 种子）

| Unit | 内容 | 领地 | 依赖 | 验收 |
|---|---|---|---|---|
| u1 | shiki fine-grained（core import + 12 个静态 grammar import 覆盖 13 项 SHIKI_LANGS——bash/shell 由 shellscript 自带 aliases 覆盖 + 2 theme + 类型标注）+ 单测 | packages/renderer/src/composables/logic/markdown.ts + 其测试 | 无 | S1+S2+S3 |
| u2 | node-pty prebuilds 平台裁剪（三平台段 files 各加排除行 + 注释） | apps/electron/electron-builder.yml | 无（与 u1 异文件可并行） | S4+S5 |
| u3 | dmg ULFO（**顶层 dmg 段**加 `format: ULFO`——u3 实施修正：非 mac 子段，dmg-builder 直读 packager.config.dmg，mac 段被 schema 拒绝 + 注释） | apps/electron/electron-builder.yml | u2（同文件串行） | S6 |
| u4 | AppImage xz（**顶层 appImage 段**加 `compression: xz`——u4 实施修正：非 linux 子段，schema 拒绝 + 注释） | apps/electron/electron-builder.yml | u3（同文件串行） | S7 |
| u5 | 砍 deb（yml linux.target + release-checker pattern + shared 类型 + validate-release key + generate-manifest 正则 + build.yml glob/注释） | electron-builder.yml / release-checker.ts / packages/shared/src/update.ts / update/validate-release.ts / scripts/generate-manifest.sh / .github/workflows/build.yml | u4（同文件串行；checker 链与 u6 同文件亦串行） | 单测 + S11 负向断言 |
| u6 | mac 更新走 dmg（A 定位链 5 处源码 + 类型 + B updater 脚本 S1 段 + C 删 zip target/build.yml 清理 + D 断供错误信息 + 测试同步：全仓 grep `macArm64Zip` 命中的 13 个测试文件逐一改） | release-checker.ts / pick-platform-asset.ts / update/platform-updater.ts / update/dev/mock-release-checker.ts / packages/shared/src/update.ts / updater-script.ts / validate-release.ts / electron-builder.yml / build.yml / orchestrator.ts（仅错误信息）+ 13 个测试文件 | u5（同文件串行、风险最后置） | S8+S9+S10 |

拆分理由：规则 12「打包子系统改动逐个 commit 逐个验证」；u1-u2 无依赖可并行；u2→u3→u4→u5 同文件（yml）严格串行且各自原子小改；u6 动面最大（10 个源码文件 + 13 个测试文件）且含行为变更，置于流水线末端独立验收。dmg/AppImage 的产物级验证（S6/S7）依赖 u3/u4 的完整构建，CI dir-only 模式（build.yml:140-142）不产压缩 target，故 S6 用本地单 target 构建、S11 用 release 完整构建兜底。

待验证检查点（实施期门，来自 §3.3.4 ⛔ 清单）：~~①ULFO 收益数字~~（u3 已解答：实测 -1.77%，远低于预期 -10~15%，原因与校准见 §3.3.2）~~②本地 linux AppImage 构建可行性~~（u4 已解答：可行，双构建实测 xz -27.1%，见 §3.3.1）③UpdateError UI 展示形态。
