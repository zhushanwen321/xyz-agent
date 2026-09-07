# 审查报告：release-artifact-size-optimization-batch3.md（r1 + r2 两轮记录）

> 2026-09-05。对抗式审查（tech-design-review agent），两轮循环收敛。r1 全文审查 + r2 聚焦复审（只验 r1 修复 + 点名攻击场景 + 交叉引用终检）。

## r1（全文审查）

**Summary**：2 must-fix, 2 suggestions, 1 info。六项方案机制事实绝大多数经实装源码逐行核实为真（含探针验证：平台段 files 追加语义、updateInfoBuilder 对 dmg-only 兼容、vue grammar 自包含、ULFO 创建/挂载/ditto 保权全链路）。

| 优先级 | 位置 | 描述（修复记录） |
|---|---|---|
| MUST_FIX | §3.3.3-B/S8 | `mktemp -d /Volumes/...` 在 root:wheel 755 的现代 macOS 上普通用户必失败（探针复现 Permission denied），dmg 更新第一步即 fail。→ 已修：mountpoint 改 `$TMPDIR` + 「独立于 STAGING_DIR」约束 + S8 断言同步；探针升 ✅（用户目录挂载全链路实测通过） |
| MUST_FIX | §3.3.3-A/u6 | 改动面清单遗漏 platform-updater.ts:104（MacUpdater 直读 macArm64Zip.sha256，不经 pickPlatformAsset）与 main/dev/mock-release-checker.ts:50（dev 桩）；测试同步实为 13 个文件而非 4 个。→ 已修：清单扩为 5 处源码 + 类型 + 13 测试文件（以 grep 为准），u6 领地同步 |
| SUGGESTION | §3.2.1 | langAlias 段前提为假：实装 shellscript grammar JSON 自带 aliases=[bash,sh,shell,zsh] 且 primitive loadLanguage:285-287 自动注册，不补 langAlias 也无降级回归。→ 已修：段重写为「alias 对账（r1 审查修正）」，无需 langAlias 配置；S1 措辞改 grammar aliases 回归防护；A1 表风险列同步 |
| SUGGESTION | §2.2/§3.3.3-A/§2.1 | 行号偏移两处：pick-platform-asset.ts :21→:20；release-checker :461→:458。→ 已修 |
| INFO | §4 S2/S10 | S2 阈值 1.0MB 余量紧（18 grammar 模块实测 812K+16K）→ 放宽 ≤1.2MB；S10 hosts 劫持有 TLS 障碍 → 明示 mock-release-checker 桩路线。→ 已修 |

r1 附带已验证为真的攻击面（不构成 finding）：S0c 校验链闭合（shasum 验 dmg，挂载内容由已验字节派生）；平台段排除按目录剪枝（minimatchAll 探针）；删 mac zip 无隐性耦合（无 electron-updater 依赖、updateInfoBuilder 逐 artifact 生成、release.yml 透传无 deb/zip 残留消费）；ULFO 兼容 minimumSystemVersion 12.0.0；AppImage xz FUSE2 路径属实 + `packager.compression: maximum` 副面警告两处证实；shiki vue embeddedLangs 全覆盖；Intel mac 已被 m8 门控与删 zip 无交互；UpdateError 确无 htmlUrl 字段（D 增强点真实）；砍 deb 后 `${arch}` 解析不受影响。

## r2（聚焦复审：r1 修复验证 + 点名攻击「重复更新×残留挂载」+ 交叉引用终检）

**Summary**：0 must-fix, 3 suggestions。

| 优先级 | 位置 | 描述（修复记录） |
|---|---|---|
| SUGGESTION | §3.3.3-B | 「防残留挂载干扰」表述过强——mktemp 随机性防的是路径冲突（实测成立）；真实边界是同 inode dmg 在残留挂载未 detach 时重挂载报「资源忙」exit 1（实测复现；触发需双重罕见失败叠加，正常路径三种均实测 exit 0 不受影响）。→ 已修：表述收敛 + 决策「不引入 stale 自动清理（触发面极窄不值得 hdiutil info 解析脆弱性）」+ 错误信息带恢复动作 + S9 补同文件双挂载用例 |
| SUGGESTION | §3.3.4 D5 + §5 u1 | langAlias 旧口径残留两处。→ 已修：D5 改「alias 靠 grammar 自带」；u1 改「12 个静态 grammar import 覆盖 13 项 SHIKI_LANGS」 |
| SUGGESTION | §2.1/§5/§3.3.4 | 四处计数/编号残留（:21 第二处漏改 / u6「8 文件」/ §5 残留④ / 探针② S6→S11）。→ 已修 |

r2 结论：两处 must-fix 修复均成立（$TMPDIR 全链路探针复测通过；改动面三处清单闭合）；新发现的同 inode 边界按 suggestion 处置完毕。

## 终态

- 收敛轨迹：r1（2 must-fix + 2 sug + 1 info）→ 全修 → r2（0 must-fix + 3 sug）→ 全修 → **设计就绪**。
- 被否谱系最终形态：/Volumes 挂载点（权限实测否）｜hook 转换 dmg（时序风险）｜UDBZ（弃用警告）｜外层 .xz 归档（exec 会炸）｜过渡双发（成本冲突）｜cp -R（丢签名）｜stale 挂载自动清理（触发面极窄 + 解析脆弱）｜显式 langAlias（grammar 自带 aliases，冗余）｜按需 loadLanguage / 构建期排除（不消除死重/脆弱）｜afterPack 删目录 / postinstall prune（新机制/污染环境）。
- 设计文档 commit：d3e42828c。
