# 自动升级多源支持（AtomGit + GitHub 双源）

> **一句话结论**：把升级链路从 GitHub 单源硬编码改造为「源优先级 + 逐级降级」的双源架构——用户可在设置中选择来源偏好（自动 / GitHub / AtomGit），auto 模式启动时经网络探测决定优先源，检查与下载任一环节失败时自动降级到第二源，sha256 完整性校验保持全链路不变。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 桌面端（太极）内置自研自动升级系统：启动后定期调 GitHub `/releases/latest` 检查新版，下载安装包经 sha256 校验后由平台脚本替换安装。发布流程（merge skill 阶段 6.5）已把每个版本的完整产物同步到 AtomGit 平台仓库（`qq_18433817/xyz-agent`，域名 gitcode.com），README 安装指引同时提供「国内通道（AtomGit）」与「GitHub 通道」两条下载链接。
- **C（冲突）**：客户端升级链路完全不感知 AtomGit——检查、元数据解析、下载 URL、下载域白名单全部硬编码 GitHub。无代理或代理不稳的国内用户升级检查静默失败、下载失败率高的同时，AtomGit 上的完整产物处于闲置状态。
- **Q（问题）**：如何让升级链路利用已存在的双源产物，使用户可配置来源偏好、网络探测自动决策、单源故障自动降级，且不削弱既有安全模型（main 进程权威解析 + sha256 校验 + 下载域白名单）？
- **A（答案）**：在 main 进程升级子系统内引入「release 源适配层」（GitHub / AtomGit 各一个 fetch+normalize 适配器），`ReleaseChecker` 编排按优先级逐源尝试；`UpdateSettings` 新增 `updateSource` 偏好；auto 模式经域名探测 + 代理感知决定优先级；`downloadUpdate` 增加跨源降级重下。本文展开。

## 1. 背景：被设计的系统是什么

**本章结论：本次设计聚焦 main 进程升级子系统（Electron main）的检查与下载两段，安装段与自愈回滚不动。**

xyz-agent 的自动升级是自研实现（未用 electron-updater，调研与对抗式核实结论：electron-updater 无断点续传、无自愈回滚、单 provider、代理走隔离 session——全面替换属功能退化，维持自研）。现有链路分四段：

1. **检查**（`apps/electron/main/release-checker.ts`）：`ReleaseChecker.checkForLatestRelease()` 调 GitHub API `/releases/latest`，1h 正/负缓存，403/429 触发 2h 全局退避，三重 prerelease 防御（端点语义 / `prerelease`+`draft` 字段 / 严格 semver 正则），产出 `LatestReleaseInfo`（含按平台分流的 asset 列表与 sha256）。
2. **下载**（`apps/electron/main/update/orchestrator.ts` → `download-asset.ts`）：`resolveByVersion` 信任锚——renderer 只传版本号，release 数据由 main 权威解析（防伪造 payload）；`downloadAsset` 双引擎（undici→curl 降级）+ 多段并行 + 断点续传 + sha256/size 完整性校验。
3. **安装**（`platform-updater.ts` 三平台 detached 脚本）+ **自愈回滚**（`update-self-healer.ts` 的 `.old` 备份回滚）。
4. **前端**（`packages/renderer/src/composables/features/settings/useAppUpdate.ts` 9 状态机 + `UpdatePage.vue` 设置页）。

**发布侧双源现状**：merge skill 阶段 6.5 在每次发版后把 GitHub Release 全部资产（dmg/exe/AppImage/manifest.json）原样上传到 AtomGit 仓库 `qq_18433817/xyz-agent`（同一批文件、同名上传，`scripts/gitcode-release-sync.mjs` 幂等实现）。**两源的 tag 与资产文件名一致，文件内容逐字节一致**（同一份产物复制），这是本设计正确性的物理基础：同一 tag 在任一源下载的文件 hash 相同。

**命名约定（用户拍板）**：平台命名一律用 **AtomGit**（符合官方最新命名——GitCode 与 AtomGit 深度整合后定位为新一代 AtomGit 基础设施）；其 API/下载域名为客观事实保持 `api.gitcode.com` / `gitcode.com` / `file-cdn.gitcode.com` 不变。本设计范围内的客户端新代码（settings 值、模块名、UI 文案、i18n key）全部用 atomgit 命名。既有发布侧资产（`scripts/gitcode-release-sync.mjs`、其发布侧环境变量凭据、merge skill 文档）**不在本设计范围**，重命名牵动 CI secret 与发布流程文档，另行处理——文档中出现 `gitcode` 字样处均为域名或既有发布侧资产名。

**层声明**：当前层 = 技术方案（可实现的接口/数据模型/错误规格）；下一层 = 编码实现。本文不写实现代码。

## 2. 设计目标

**本章结论：三类使用者（国内无代理用户、代理用户、显式偏好者）都能以最小代价完成升级。**

1. **国内无代理用户**：启动后升级检查与下载自动落到 AtomGit（可达且快），GitHub 故障对其透明。
2. **代理用户**：行为与现状一致（GitHub 优先），不因双源改造引入额外延迟。
3. **显式偏好者**：在设置-更新中选择来源（自动 / GitHub / AtomGit），选择即优先级；任一环节失败仍能经另一源完成升级（降级是无条件的，不因显式选择而关闭）。
4. **安全不回退**：renderer 传意图、main 权威解析的信任锚（RC1）、sha256 完整性校验、下载域白名单防 SSRF——三条安全性质在双源下全部保持。

**In-scope**：main 进程 release-checker 多源化；下载降级；settings 扩展 + 设置页 UI；auto 模式源顺序探测；`validate-release` 白名单扩展；shared 类型扩展。
**Out-of-scope**：安装段（platform-updater / self-healer）；发布侧同步脚本及其命名；electron-updater 替换；三源以上扩展性预留；atomgit release 的写路径（客户端只读）。

## 3. 现状：使用者眼里是什么样的

**本章结论：单源硬编码使「换源」在三个独立位置各缺一块——检查入口、下载 URL、安全白名单，任何一块单独补都不成立。**

### 3.1 现状的真实样子

国内无代理用户（真实典型画像：代理未开/代理失效）在设置-更新页点「检查更新」，main 进程执行：

```
update:check → ReleaseChecker.checkForLatestRelease()
  → upgradeFetch('https://api.github.com/repos/zhushanwen321/xyz-agent/releases/latest')
  → 代理未配置 → 直连 → api.github.com 不可达（连接超时/重置）
  → 双引擎（undici→curl）均网络失败 → catch → return null
  → renderer 收到 { info: null, rateLimited: false } → UI 静默（无新版提示）
```

用户视角：**什么都没发生**。即使某用户手动从 AtomGit 网页下载了安装包放入手动通道目录（manual/ 认领链路），检查环节依然感知不到新版存在——检查与手动通道是两条独立通路。

成功检查后的下载同样单源：`LatestReleaseInfo.assets[].downloadUrl` 恒为 `https://github.com/.../releases/download/...`，下载器对该 URL 的可达性没有任何替代路径。

### 3.2 怎么出错

| # | 失败模式 | 触发条件 | 现状行为 |
|---|---------|---------|---------|
| F1 | 检查静默失败 | api.github.com 不可达（无代理国内常态） | null → UI 无提示，用户不知道有新版 |
| F2 | 下载失败 | 检查成功（代理瞬时可用）但下载时 github.com CDN 慢/断 | UPDATE_NETWORK_FAILED 报错，唯一出路是手动下载指引 |
| F3 | 限流退避放大 | 共享出口 IP 触发 GitHub 60 次/h 配额（403） | 2h 退避窗口内全部检查短路返回 null |
| F4 | 发布时间窗 | 新版已发 GitHub、阶段 6.5 尚未同步 AtomGit | 单源语义下不可见（单源没有「另一源」概念）。多源下检查侧残留 ≤1h 延迟：AtomGit 先返回「旧新版」时检查成功并写正缓存（1h TTL），GitHub 侧更新的版本最迟下个周期可见（§6.5 D5 取舍声明）。**注意同步是单向的**（发布脚本仅 GitHub→AtomGit），「AtomGit 先于 GitHub 有新版」无物理通道，仅存在于 release 删除/重发事故中 |
| F5 | 同步缺失（阶段 6.5 整体被跳过） | 发布流程中断 / 人工直接走 CI 发布等，阶段 6.5 未执行 | **本设计不可自动检测的失效形态**：AtomGit 恒旧版 → 该源「无新版」→ 试 GitHub → 无代理用户混合态静默 null（不劣于现状但永久无信号，可跨多版本持续）。与 F4「同步延迟 ≤1h」是两个失效等级。客户端侧的观测面 = `source-selection` 登记携带各源 latest tag（检查时顺带可见、零新增请求），发布侧检测依赖流程纪律（merge skill 阶段 7 门禁约束的是「已执行的阶段」，对「跳过」无约束——显式声明此盲区，见 §6.5） |

### 3.3 根因

不是「GitHub 不可用」（外部依赖故障是常态，架构须容忍），而是**升级子系统对「源」这一概念无抽象**：GitHub latest 端点 URL 与 manifest 下载 URL 是模块级硬编码常量（原 release-checker.ts:46-51，多源实施后已由适配层取代删除），`validate-release.ts` 的 `ALLOWED_DOWNLOAD_HOSTS` 白名单只登记 GitHub 域（原 validate-release.ts:26-29），`LatestReleaseInfo` 无来源字段。三个位置共享同一个隐含假设「源 = GitHub」，打破它必须在同一处引入源抽象，而非在三个位置各打一个补丁。

## 4. 根因 + 物理数据流

**本章结论：根因 = 源概念未抽象；改造即把「fetch + normalize」收敛为源适配层单点，数据流其余环节（校验/缓存/下载/安装）全部保持。**

> **源适配器（release source adapter）** = 一个函数：输入源标识，输出该源「最新 release」的规范化结构（与现有 `GitHubRelease` 同形）。就是上面 §3.1 例子里「用硬编码的 GitHub latest 端点常量调 upgradeFetch」那一步的可替换化。

### 4.1 AtomGit 与 GitHub 的 API 事实基座（对抗式核实 + 发布脚本实测，2026-09）

| 事实 | GitHub | AtomGit | 对设计的影响 |
|------|--------|---------|-------------|
| 最新 release 端点 | `GET api.github.com/repos/{repo}/releases/latest`（匿名） | `GET api.gitcode.com/api/v5/repos/{repo}/releases/latest`（匿名，v0.9.14 实测 200） | 路径同构，仅域名+前缀差异 |
| 按 tag 查询 | `GET .../releases/tags/{tag}` | 同款端点（sync 脚本实测在用） | 下载降级按 tag 精确查备用源 |
| JSON 结构 | `tag_name`/`prerelease`/`draft`/`body`/`published_at`/`html_url`/`assets[]` | `tag_name`/`prerelease`/`release_status`/`body`/`created_at`/`assets[]`；**无 draft/published_at/html_url**；assets 有 `browser_download_url`/`id`/`name`/`type`，**无 size/digest** | normalize 层补缺（§6 D2） |
| 下载链路 | 302 两跳 → objects.githubusercontent.com 签名 URL | 302 → file-cdn.gitcode.com 签名 URL（**auth_key 有时效，链接不可缓存**） | 两引擎均已跟随 302（undici `redirect:'follow'` / curl `-L` 必带）；与现状同构 |
| Range 多段 | 支持 | 支持（sync 脚本 6.5.4 实测 302 → CDN → Range 206） | 多段并行下载主体无需改动；**唯一改造点是入口探测 `probeMultiPartSupport` 现为 HEAD 请求**（download-asset.ts:1051-1072）——GitCode 实测禁 HEAD，须改 GET `Range: bytes=0-0`（§6.4 D4 已验证形态），否则 AtomGit 源多段静默退化为单段（4 段→1 段，正确性无风险但国内主场景下载速度退化） |
| 限流 | 60 次/h 匿名配额 + `X-RateLimit-*` 头，403/429 可识别 | 无 `/rate_limit` 端点、无限流响应头；**发布脚本实测 8 并发即 429** | AtomGit 侧不可识别限流，一律按网络/HTTP 失败处理；客户端单用户低频访问，实际余量大 |
| manifest.json | release 资产之一（CI generate-manifest.sh 产物，含每资产 sha256+size） | 阶段 6.5 原样上传（v0.9.14 实测在） | AtomGit 路径 sha256 与 size 双双从 manifest 填充（§6 D2） |

### 4.2 改造后的物理数据流（检查 + 下载两条）

```
【检查流】renderer useAppUpdate.initAutoCheck / 手动检查
  → IPC update:check
  → ReleaseChecker.checkForLatestRelease(currentVersion)
      ① 缓存命中（1h 正/负缓存）→ 直接返回（不触发源选择）★现状不变
      ② 源顺序解析 SourceOrderResolver.resolve(settings)
           settings=github → [github, atomgit]
           settings=atomgit → [atomgit, github]
           settings=auto   → 有代理URL → [github, atomgit]（跳过探测）
                             无代理   → 并行 GET（Range: bytes=0-0）github.com 与
                                        gitcode.com（3s超时，禁 enginePreference 置位）
                                        → 「任何完成的 HTTP 响应=可达」（含非 2xx，
                                          对齐 testProxyConnection 准绳；GitCode 实测
                                          禁 HEAD 故用 GET Range）
                                        → 可达者优先，均可达 github 优先，均不可达 [github, atomgit]
      ③④ 按序逐源执行完整判定（fetch + normalize + 三重防御 + 版本比较 四步一体化）：
           源 i 在退避窗口内 → 短路跳过该源（零请求，现状单源退避语义的 per-source 化）
           源 i 的 fetch：网络失败 / 404 / 限流 / 形状坏 → 记该源失败 → 源 i+1
           源 i 的判定（现状三重防御逻辑移入循环内，per-source 生效）：
             prerelease / draft / 非 semver tag / 不比当前新
               → 记「该源无新版」→ 源 i+1（不写全局负缓存——
                 源 A 无新版 ≠ 全局无新版，次源可能有 stable 新版）
           首个「fetch 成功且判定有新版」的源胜出 → 进入⑤
      ⑤ manifest 填充（胜出源）：
           URL = 该源 release JSON assets 中 manifest.json 的 browser_download_url
           （by-tag 精确对齐本次 release，sync 脚本验证的直链形态；
             禁用 releases/latest/download/ 别名——无验证记录且有 latest 前移错位竞态）
           GitHub 路径：asset.digest 优先（现状），manifest 失败不阻塞
             （sha256 undefined → 下载侧 size 校验兜底，size 来自 API 恒有）★现状语义
           AtomGit 路径：sha256 与 size 唯一来源是 manifest → manifest fetch 失败
             （网络/404/缺失）计为「该源失败」→ 回到③试次源（manifest 是必经依赖，
             不得照搬 GitHub 的「失败不阻塞」——那会把网络问题变形为下载期
             BLOCKER 4 完整性错误，且 D8 禁二次降级）
      ⑥ 结果落位：
           有胜出源 → LatestReleaseInfo{ ...原字段, source } → 写正缓存
           所有源均「确认无新版」→ 写负缓存 info=null（全局语义才成立）
           混合态（部分源失败/退避中 + 其余源确认无新版）→ 返回 null 但
             **不写负缓存**（未确认源的失败可能是暂时的，下周期应重试；
             负缓存会把「未知」固化为「确认无」1h。请求量已入账：退避源正确
             短路时零请求，仅无新版源每周期 ≤2 次调用，见 D5）
           所有源均失败（网络/限流/manifest 必经失败）→ null 不缓存失败 ★现状不变
       单次检查最坏请求预算：探测×2（仅 auto 且 TTL 过期时）+ latest×2 +
       manifest×1 + （下载段另计）by-tag×1 = 检查段 ≤5 次，远低于 GitHub 匿名 60/h

【下载流】renderer performDownload(version)
  → IPC update:download
  → resolveByVersion（RC1 信任锚：main 权威解析，缓存/force check）★逻辑不变，
    其内部 check 走①-⑥多源链
  → downloadUpdate(release)
      ① pickPlatformAsset(release)（现状不变）
      ② downloadAsset(asset)（双引擎/多段/续传现状不变）
      ③ 网络类失败 且 release.source 有对侧源 →
           fetchReleaseByTag(对侧源, release.tagName)（by-tag 精确查 + 同款防御）
           → 对侧确认存在该 tag **且目标平台 asset（按 name 匹配）存在** →
             复用既有 temp + resume-state 以对侧 downloadUrl 续传
           （两源同名上传、逐字节一致，Range 偏移语义正确；进度不浪费。
             by-tag 404 = 发布时间窗；by-tag 200 但目标 asset 缺失 = 部分同步
             失败窗口——两者同语义：对侧不可用，保留本源 temp+state 不降级，
             原错误上抛，不误报为网络失败、不触发无意义续传）
           → sha256 校验兜底（两源同文件同 manifest；不符自动清 temp，
             下次重试从零，fail-fast 不装坏文件）
           （对侧也网络失败 → 原错误上抛）
      ④ UpdateIntegrityError（sha256/size 不符）→ 不跨源降级，fail-fast ★安全边界
  → writePreloadedUpdate（release 含 source 落盘，install 链路不读 source）
```

【安装流】不变：preloaded → validateRelease（白名单扩展后）→ 平台脚本替换 → 重启 → self-healer 兜底。

## 5. 终态：使用者眼里将是什么样的

**本章结论：检查与下载在单源故障时自动续接另一源，用户只在双源皆败时看到错误，且错误与现状同形。**

### 5.1 成功路径（国内无代理用户，auto 模式）

> 用户（无代理）打开设置-更新，来源保持默认「自动」。启动 30s 后后台检查：探测 github.com 不可达、gitcode.com 可达 → 源顺序 [atomgit, github] → AtomGit `/releases/latest` 返回 v0.9.15 → normalize + manifest 填充 sha256/size → UI 侧栏出现新版提示（与现状同形，无新增概念）。用户点「更新」→ resolveByVersion（AtomGit 缓存命中）→ 从 file-cdn.gitcode.com 多段下载 → sha256 与 manifest 一致 → 「下载完成，重启安装」→ 替换重启 → 启动 toast「已升级到 0.9.15」。全程无感换源。

### 5.2 失败路径（带恢复指引）

> 同一用户检查成功后下载到一半断网（AtomGit CDN 中断）。下载器网络失败 → 降级：按 tag `v0.9.15` 查 GitHub 侧 release → 确认存在 → 复用已下载的临时文件与断点状态，从断点以 GitHub 直链续传（两源同名上传、逐字节一致，Range 偏移语义正确）→ sha256 校验通过。用户感知：下载进度续走，其余无感。极端情况（对侧文件与断点状态不符，如 totalBytes 不一致）由既有续传守卫自动转全量重下；最终 sha256 兜底保证不会装坏文件。
>
> 双源皆败（真断网）：update:error 事件，错误码/结构/指引结构与现状一致（「网络连接失败」+ 检查网络/代理建议 + 手动下载目录指引）；唯一文案差异 = suggestion 去除「访问 GitHub」专名改为中性表述（双源皆败时用户可能恒走 AtomGit，§7.3 文案改写②）。恢复动作不变：恢复网络后重试，或将安装包手动放入手动通道目录（`update:openManualDir` 可直达）。
>
> sha256 不符（任一源下载产物与 manifest 不符）：**立即失败不降级**，错误提示「安装包校验失败」，临时文件自动清理。恢复动作：直接重试（重试经 main 权威缓存解析，恒从原胜出源从零开始——跨源降级不记忆历史，与 release.source 落盘语义一致）；若反复失败说明两源产物与发布清单出现发散（发布侧同步事故或 tag 重发残留），等待发布侧修复或下一版，手动下载**改走另一通道**（README 安装段双通道链接；发散嫌疑侧为当前胜出源，勿从嫌疑侧重下同一 URL）。校验失败意味着产物与发布清单不符，换源重试会把不可信产物装上机器——此路不通是有意设计。

## 6. 关键决策与权衡

**本章结论：8 个决策，共同把「源」从三处硬编码收敛为一个适配层单点。**

### 6.1 D1：多源抽象落在独立适配模块，checker 保持门面（采用）

- **采用**：新建 `apps/electron/main/update/release-sources.ts`——导出 `fetchLatestRelease(source)` 与 `fetchReleaseByTag(source, tag)`，内部按源分派（github / atomgit 两个私有实现），输出统一 normalize 后的 release 结构；`ReleaseChecker` 持有「按序尝试 + 缓存 + per-source 限流退避」编排，接口 `IReleaseChecker` 对 handler 层完全不变。
- **被否**：(a) 每源一个完整 Checker 类 + MultiSourceChecker 门面——缓存/负缓存/退避是进程级单例语义，拆到两个类要么状态重复要么整体上提，实际等于把编排逻辑换个地方写，类数量翻倍无收益；(b) provider registry 式彻底重写——两源同构度极高（§4.1），注册表机制的通用性没有第二个消费者，属推测性功能。
- **证据**：release-checker.ts 现有结构（缓存/退避/防御/组装四段清晰分层，唯 fetch 步是单源常量）；atomgit JSON 与 GitHub 同构（§4.1 实测）。
- **效果**：目标 1/2/3 成立的代码基础——新增一个源 = 新增一个 normalize 分支 + **4 处登记联动**（normalize 分支、validate-release 白名单域、source-resolver 探测域列表、UI 三选控件 + settings 枚举 + i18n），handler/renderer 的行为逻辑零改动（「零感知」仅指行为编排层；接入清单如前，防下次接入漏登记，normalize 表测顺带断言「全部产物 downloadUrl 的 hostname ⊆ ALLOWED_DOWNLOAD_HOSTS」——域常量由 release-sources 单一来源导出，validate-release 消费同源，防两处漂移）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| A：适配模块 + checker 编排（选） | 源概念单点化，第三源成本低 | 中（一个新模块 + checker 编排改造） | normalize 漏字段（探针+测试兜） | ✅ |
| B：每源一 Checker 类 | 类多态干净 | 高（缓存/退避状态上提重构） | 编排语义漂移 | ❌ |
| C：provider registry 重写 | 过度通用 | 最高 | 推测性功能 | ❌ |

### 6.2 D2：AtomGit 字段差异在 normalize 层补齐，sha256/size 双双取自 manifest（采用）

- **采用**：atomgit 适配器输出前做字段映射——`draft` → undefined（防御 b 的 `if (release.draft)` 对 undefined 自然放行，语义等价：AtomGit API 只返回已发布 release）；`prerelease` → **显式收窄为 `=== true` 才算 true**（GitCode API 同构性不可靠——本仓 sync 脚本 createRelease 实测 prerelease 以 `String(prerelease)` 字符串编码写入；若读路径返回 `"false"` 字符串，JS truthy 语义会把全部 stable 判为 prerelease 致 AtomGit 源检查全灭）；`published_at` → ''（`LatestReleaseInfo.publishedAt` 现有 `?? ''` 容错）；`html_url` → 拼 `https://gitcode.com/qq_18433817/xyz-agent/releases/{tag}`（手动下载指引链接，v0.9.14 页面格式实测）；`release_status` → 忽略（prerelease 防御不依赖它）；`size`/`digest` → undefined，由 manifest fallback 填充——**manifest URL 取自该源 release JSON assets 中 manifest.json 的 `browser_download_url`**（manifest 本身是 release 资产之一、§4.1 已实测在 assets 中；按 tag 精确对齐本次 release，sync 脚本验证的直链形态）。为此 manifest 解析从 `Map<name, sha256>` 扩展为 `Map<name, {sha256, size?}>`，`pickAsset` 的 size 取值变为 `API size ?? manifest size`（GitHub 路径 API size 恒存在，行为不变；AtomGit 路径 size 全靠 manifest）。
- **被否（v1 谱系）**：atomgit manifest URL 用 `releases/latest/download/manifest.json` 别名形态（v1 初稿，声称「sync 脚本验证的形态」）——**被审查击穿**：sync 脚本只验证过 by-tag 直链 `releases/download/{tag}/{file}`（脚本头注释:27、verifyAnonymousDownload:251、runSync:604），latest 别名全仓零验证记录；且别名与 latest 查询是两个请求，窗口内发布新版会拿到与本次 release 错位的 manifest（GitHub 路径有 digest 优先掩护，AtomGit 路径 manifest 必经使错位被放大）。改用 assets 内直链后两个问题同时消失。
- **被否**：为 AtomGit 单独放宽完整性规则（size 缺失时跳过校验）——破坏 BLOCKER 4（sha256 与 size 双缺拒绝）的保守方向，且 manifest 在 AtomGit 侧由发布流程保证存在（阶段 6.5 原样上传，v0.9.14 实测），放宽没有必要性。
- **证据**：§4.1 字段差异表（对抗式核实实测 v0.9.14 JSON）；manifest 结构 `{ assets: { "<file>": { sha256, size } } }`（release-checker.ts:466-468 注释）；sync 脚本 createRelease prerelease 字符串编码注释:151-153。
- **效果**：两源产物走同一条 sha256 校验路径——「同一批文件、同一份清单、同一套校验」，目标 4（安全不回退）的核心支撑。
- **manifest 失败的源归类**（AtomGit 与 GitHub 路径不同，检查流⑤分派）：GitHub 路径保持现状「manifest 失败不阻塞组装」（digest 优先掩护 + API size 恒在，下载侧 size 校验兜底，无完整性错误风险）；AtomGit 路径 manifest 是 sha256/size 唯一来源，**fetch 失败（网络/404/资产缺失）计为「该源失败」进入源降级**——不照搬「不阻塞」，否则网络问题变形为下载期 BLOCKER 4 完整性错误且 D8 禁二次降级，GitHub 明明可达却卡死。
- **边界（诚实声明）**：若某版本 AtomGit 侧 manifest.json 资产缺失（发布同步事故），该版本对 AtomGit 源不可下载（检查流⑤该源失败 → 自动降级 GitHub，用户无感；仅当 GitHub 也不可达时才暴露）——fail-safe 方向正确（拒绝未校验产物）。恢复动作 = 发布侧重跑阶段 6.5 同步。**重审触发条件**：连续 2 个版本出现 AtomGit manifest 缺失或阶段 6.5 同步事故率明显上升时，须在 merge skill 阶段 6.5 增加发布侧 manifest 存在性硬校验（推后验证已逐件比对大小，缺 manifest 属可检出异常）。

### 6.3 D3：settings 新增 `updateSource`，语义为「优先级」而非「独占」（采用）

- **采用**：`UpdateSettings.updateSource?: UpdateSourcePref`，`type UpdateSourcePref = 'auto' | 'github' | 'atomgit'`，缺省/非法值回退 `'auto'`（老 settings 文件无此字段 = auto，向后兼容）。显式选 github/atomgit = 该源优先，**降级到另一源的能力始终存在**（目标 3 的「失败仍能经另一源完成升级」）。读写链路三处同步：`update-settings.ts` 逐字段枚举校验（对齐现有 boolean 字段校验模式）、`update:setSettings` handler 入参校验（非三值之一抛错）、`UpdatePage.vue` 设置控件。
- **被否**：显式选择 = 独占单源（失败不降级）——违背目标 3 原文语义（「如果从某一处下载失败，自动降级到第二选择下载」无条件成立）；且独占模式让「用户忘了自己在独占 github」成为新的客服问题源。**生效时延声明**：偏好切换的实际生效以检查缓存 TTL（≤1h）为界——缓存窗口内的 release（含旧源 downloadUrl）继续命中；手动「检查更新」为 force 语义，立即按新序重查。
- **证据**：用户需求原文；update-settings.ts 现有逐字段校验先例。
- **效果**：目标 3 直接成立；设置语义一句话可解释（「优先从哪下载」）。

### 6.4 D4：auto 模式源顺序 = 代理感知短路 + 域名并行探测（采用）

- **采用**：新建 `update/source-resolver.ts` 导出 `resolveSourceOrder()`：显式偏好直接映射；auto 时若解析出代理 URL（`readProxyConfig` + `resolveProxyUrl`，现有 SSOT）→ [github, atomgit]（能配代理 = github 可达概率高，跳过探测省一次网络往返）；无代理 → 并行探测 `https://github.com` 与 `https://gitcode.com`（GET + `Range: bytes=0-0`，3s 超时，走既有 upgradeFetch 通道），可达者排前、github tie-break、双败回退 [github, atomgit]（= 现状行为，不比现状差）。结果进程内缓存 TTL 1h（与检查缓存同量级），缓存 miss 才重新探测。
- **探测方法与判定语义（关键细节）**：不用 HEAD——本仓 sync 脚本实测记录「GitCode 禁 HEAD，用 GET Range 206」（gitcode-release-sync.mjs:263），HEAD 对 gitcode.com 可能 405/拒绝；改用 GET `Range: bytes=0-0`（sync 脚本已验证形态，两主域通用）。可达性判定 = **任何完成的 HTTP 响应即可达**（含非 2xx——探测目的是「链路通」而非「内容对」），对齐 testProxyConnection 的既有准绳（update-handlers.ts:129-145）及其 curl 引擎 `-f` 语义漂移处理：undici 引擎任何 resolve 即成功、curl 引擎携带 httpStatusCode 的 CurlFetchError 同样算可达，双引擎判定等价。探测调用必须传 `disableFlagPersistence: true`（对齐 testProxy D5 先例）——防止探测失败翻转进程级下载引擎偏好，污染后续真实下载编排。
- **被否**：(a) 每次检查都探测——60min 周期检查 × 每次双探测是无谓流量，且探测失败不该阻塞检查本身；(b) 探测真实 API 端点（releases/latest）——一次探测消耗 GitHub 匿名配额且响应体大，域名级小请求是零成本近似；(c) ping 结果持久化落盘——上次启动的网络环境对本次无参考价值，用户需求原文即「启动时」决定；(d) HEAD 探测（v1 初稿方案）——被「GitCode 禁 HEAD」本仓实测记录击穿，且判定标准（result.ok vs 任何响应）未定义即实施，405 会被误判不可达，国内 auto 用户被系统性误排序、目标 1 静默落空。
- **证据**：用户需求 2 原文（「做一次 ping github.com 来决定默认用哪个」——实现为 HTTP 探测比 ICMP ping 更贴近意图「判断哪个源可达」）；proxy-config.ts 现有 resolveProxyUrl；sync 脚本:263 禁 HEAD 实测；testProxyConnection 判定准绳先例。
- **效果**：目标 1（国内自动落 AtomGit）与目标 2（代理用户零额外延迟）同时成立的调度基础。
- **边界（诚实声明）**：域名可达 ≠ API 域名可达的极端网络环境（主域名通、API 域名被墙）会排序失误。失误代价有时间量级：首源不可达时现状检查链路最坏 4 试 × 10s 超时，双源下单次检查延迟最坏近似翻倍，且探测 TTL 1h 内重复付费；auto + 无代理用户在探测缓存过期后的每次手动检查固定多付 ≤3s（探测时长）。可自愈（降级兜底）、不阻塞，接受。**重审触发条件**：用户反馈或诊断日志显示「域名可达但 API 域名被墙」成为常态（表现为稳定的次源失败模式）时，域名级探测机制整体失效，须改 API 级轻量探测（如 releases 端点 HEAD 化或专用探针路径）。

### 6.5 D5：降级覆盖检查与下载两段，限流退避 per-source 化（采用）

- **采用（检查段）**：按序逐源执行「fetch + normalize + 三重防御 + 版本比较」完整判定（防御与比较在循环内 per-source 生效，见 §4.2③④）：某源网络失败/404/限流/形状坏 → 该源失败，试下一源；某源返回的 release 被防御拦截或「不比当前新」→ **该源「无新版」，同样试下一源，且不写全局负缓存**——源 A 无新版 ≠ 全局无新版（GitHub 端点排除 prerelease 的语义对 AtomGit 无佐证，sync 脚本会同步 beta tag；AtomGit 侧旧版也不代表 GitHub 侧无新版）。**全部源均确认无新版才写负缓存；混合态（部分失败/退避 + 其余无新版）返回 null 但不写负缓存**（未确认源下周期应重试）；有任一源胜出即正常返回。限流退避从单值 `rateLimitedUntil` 改为 per-source（`Map<UpdateSource, timestamp>`），**全部源都在退避窗口**才对 renderer 报 `rateLimited: true`（信号语义从「GitHub 限流中」泛化为「所有源均限流中」）。
- **采用（下载段）**：`downloadAsset` 网络类失败且当前 release 来自某源时，`fetchReleaseByTag` 对侧源按 tag 精确查询（同款三重防御 + 版本一致性校验）后**复用既有 temp 文件与 resume-state 以对侧 downloadUrl 续传**，sha256 兜底；对侧 by-tag 404（发布时间窗）不降级，保留本源断点状态原错误上抛；对侧也网络失败同样原错误上抛。
- **降级的触发集合与完整性基准（实施精确性）**：触发降级的错误集合 = `errorCode ∈ {UPDATE_NETWORK_FAILED, UPDATE_NETWORK_TIMEOUT, UPDATE_PROXY_ERROR, UPDATE_PROXY_UNREACHABLE}`（含「代理对当前源域不可用但对对侧可用」的真实场景）；显式排除 UPDATE_DISK_SPACE / UPDATE_FILE_RENAME_FAILED / UPDATE_PERMISSION_DENIED（换源无意义）与 UpdateIntegrityError（§6.8 安全边界）。**降级仅替换 downloadUrl，完整性基准（sha256/size）保持原胜出源 asset**——tag 重发发散窗口下对侧内容将因 sha256 不符 fail-fast，与 D8「产物与发布清单不符」语义一致。对侧 by-tag 返回的 downloadUrl 在进入续传前额外经 https+白名单域校验（防御纵深：该 URL 不经过 install 前 validateRelease 的直达路径）。
- **跨源续传的依赖声明**：temp 按 `asset.name` 键控（download-asset.ts:197 `<name>.downloading`）、网络失败默认保留 temp+state（[B-2]）——两源同名上传（§1）使跨源续传天然命中同一份断点状态。正确性依赖「两源逐字节一致」不变量（Range 偏移语义），三重防护托底：by-tag 确认对侧存在该 tag 且目标 asset 存在 → 既有 resume-state totalBytes 校验（不符自动转全量）→ sha256 最终校验（不符自动清 temp，下次重试从零且 fail-fast 不装坏文件）。**重试语义**：sha256 失败清 temp 后的重试经 `resolveByVersion` 走 main 权威缓存，恒从原胜出源从零开始、不记忆跨源降级历史（与 D7 source 字段落盘语义一致）；跨源续传与多段并行机制互斥（进多段的硬条件是 `!resumeState`，download-asset.ts:241），无「拼接 × 并发」叠加面。**不变量的发布侧保障与破坏通道**：保障 = sync 同名跳过纪律 + 推后验证大小门禁（verifyUploadedAssets 防同名旧件残留，大小不符 die 阻断发版）+「tag 内容不可变」操作纪律；残余破坏通道 = tag 重发且大小恰好相同（推后验证不可检出），客户端唯一信号 = source-failover 后 sha256 失败激增——挂接 D2 重审触发条件。**显式盲区声明**：以上保障全部是「脚本运行时」防护——阶段 6.5 整体被跳过时防护面为零，且客户端不可自动检测（F5 失效形态）；检测面 = source-selection 日志的各源 latest tag 对照 + 发布侧流程纪律。**被否**：跨源降级前清 temp+state（从零重下）——浪费已下载字节（最坏 ~170MB），且「换源」场景多发生在主源慢/断时，对侧高速下载使保进度收益真实存在；被否方案记入谱系供实施者查阅。
- **混合态请求量入账**：「部分源退避 + 其余无新版」不写负缓存的代价 = 每检查周期对退避源零请求（正确短路）+ 对无新版源 ≤2 次调用——无请求放大，退避语义不被混合态击穿。
- **后台预下载辐射面（显式判定）**：`preloadUpdateSilently`（update-handlers.ts:217-233）复用 `orchestrator.downloadUpdate`，降级链内嵌后**静默预下载自动获得跨源续传行为**。量级有界：preDownload 默认 false（opt-in）、检查周期 60min 节流、downloading 锁保证串行——每失败周期后台最多 2 次全量下载 + 1 次对侧 by-tag 调用；滞后收敛重下：滞后窗口内预下载的「旧新版」在下周期检查出新版后经 version-mismatch 链自动清除重下（增量 ≤1 次全量/窗口）。两者方向均对用户有利（最终拿到更新版），判定可接受。
- **被否（其他）**：(a) 下载降级直接拼对侧 URL 不查 API——发布时间窗（F4）内对侧可能没有该 tag，拼 URL 404 反而多一次失败；by-tag 一次调用换精确性，且 AtomGit by-tag 端点已被发布脚本实测验证。(b) sha256 校验失败也降级——见 §6.8，安全边界不降级。
- **证据**：download-asset.ts 失败分类（网络错误 vs UpdateIntegrityError 现已可区分）、temp 键控与 [B-2] 保留语义、totalBytes 续传守卫（:294-307）；gitcode-release-sync.mjs by-tag 实测；release-checker.ts 限流识别位（403/429 两引擎重建）。
- **效果**：F1/F2/F3/F4 四个失败模式全部有自动续接路径（§3.2 → §5 终态闭环）。**取舍声明**：AtomGit 同步滞后窗口内，排序 [atomgit, github] 的用户拿到「AtomGit 侧最新」（可能落后 GitHub 侧刚发的新版）——下个检查周期（≤1h）自然收敛，不做双源合并比较（两源 latest 双查 + 版本取大 = 请求面翻倍、实现复杂化，收益只是提前 ≤1h 拿到最新，不值）。

### 6.6 D6：`validate-release` 白名单加 AtomGit 下载域（采用，安全敏感）

- **采用**：`ALLOWED_DOWNLOAD_HOSTS` 增补 AtomGit 下载域名（`gitcode.com`；实际 `browser_download_url` 落域以实施期探针 P1 实测为准，若为 `raw.gitcode.com` 则一并登记）。字符集/协议/路径校验全部不动。
- **被否**：按 URL 前缀区分源分别校验（github release 走 GitHub 白名单、atomgit 走 atomgit 白名单）——`validateRelease` 是 install 前的统一防线，其输入 release 可能来自任一源，按源拆白名单需要同时传 source 上下文，增加耦合且无安全增益（两个域的信任级别本就相同）。
- **证据**：validate-release.ts:26-29 现白名单；AtomGit 仓库 `qq_18433817/xyz-agent` 与 GitHub 仓库同属项目方、内容由发布流程单向同步（§1），信任级等价——白名单扩展不放松防 SSRF 性质（file://、内网 IP、任意域仍被拒）。
- **效果**：AtomGit 下载的 release 能通过 install 前校验；非白名单域（含恶意构造 URL）依旧 fail-fast。

### 6.7 D7：`LatestReleaseInfo` 增加可选 `source` 字段（采用）

- **采用**：`source?: UpdateSource`（`'github' | 'atomgit'`）。落盘面（pending-update.json / preloaded-update.json 全量 JSON 序列化）自然携带；旧文件无此字段读回 undefined（可选类型向后兼容）。消费点仅一个：下载降级时确定对侧源——**source 缺失（旧版落盘的 pending/preloaded 恢复）时不降级，维持现状单源行为（原错误上抛）**；install 链路与前端状态机不读它。
- **被否**：模块级「当前源」全局变量——preloaded 场景下载与安装跨生命周期，全局变量在重启后丢失；而 source 随 release 落盘天然持久。
- **证据**：preloaded-update.ts / pending-update.ts 均为 `JSON.stringify(整对象)` 全量序列化（§3 实读）；`LatestReleaseInfo` 为三方共享类型 SSOT（packages/shared/src/update.ts）。
- **效果**：下载降级有确定的对侧源依据；未来 UI 显示「来源：AtomGit」有数据可用（本期不做）。

### 6.8 D8：sha256 校验失败不降级（采用，安全边界）

- **采用**：`UpdateIntegrityError`（sha256/size 与 manifest 不符）在任何源上都 fail-fast，不触发跨源重下。理由：两源是同一批文件 + 同一份 manifest（§1），单源校验失败意味着「产物与发布清单不符」——可能是传输损坏（重试同源可解）或供应链异常（换源重下掩盖问题）。传输损坏与完整性异常的区分不在客户端的判定能力内，保守拒绝。
- **被否**：完整性失败也换源重试一次——把「产物不可信」的信号降格为「网络不佳」，违背目标 4（安全不回退）。
- **证据**：download-asset.ts BLOCKER 4 注释（「正常 release 必有 sha256 或非零 size，二者全缺视为可疑，拒绝」——既有保守方向先例）。
- **效果**：§5.2 第三条失败路径的用户预期与安全语义一致。

## 7. 实现机制

**本章结论：三层改动——shared 类型与 settings（数据模型）、main 进程源适配与编排（行为核心）、前端设置项（入口），改动地图共 11 个既有文件 + 2 个新模块。**

### 7.1 shared 类型（packages/shared/src/update.ts）

```text
type UpdateSource = 'github' | 'atomgit'
type UpdateSourcePref = 'auto' | UpdateSource

interface LatestReleaseInfo { ...现有字段, source?: UpdateSource }
interface ReleaseAsset      { ...现有字段, size?: number }  // AtomGit API 不返回 size，由 manifest fallback 填充（§6.2）
interface UpdateSettings    { ...现有字段, updateSource?: UpdateSourcePref }
```

main 侧内部类型（不进 shared，renderer 无消费）：`type SourceOrder = UpdateSource[]`（定义于 `update/source-resolver.ts` 并导出，供 release-checker 消费）。shared/update.ts 现有注释中一处「GitHub API 限额」表述随本批类型改动同批更新为中性「更新检查服务限流」（update.ts:69，实施核验仅此一处含 GitHub 专名）。

### 7.2 main 进程（apps/electron/main/）

| 文件 | 改动 |
|------|------|
| `update/release-sources.ts`（新） | `fetchLatestRelease(source)` / `fetchReleaseByTag(source, tag)`；github 分支迁移现有 `doFetchGitHubLatestRelease` 的 URL/headers/形状守卫；atomgit 分支（api.gitcode.com + normalize，§6.2，含 prerelease 显式布尔化；**同款形状守卫（tag_name string + assets array）+ asset 字段别名容错（对齐 sync 脚本 assetList 的 file_name/path/filename 族——GitCode 同构性不可靠有先例）+ 匿名 GET 无特殊 headers**）；两源共用 upgradeFetch 双引擎 + 代理通道参数。域常量（两源 API/下载域 + ALLOWED_DOWNLOAD_HOSTS）单一来源导出，validate-release 消费同源 |
| `release-checker.ts` | fetch+判定段替换为按 `SourceOrder` 逐源完整判定（三重防御/版本比较移入循环 + 退避源短路跳过，§6.5）；「全局负缓存」改为全部源确认无新版才写（混合态不写）；**AtomGit 路径 manifest fetch 失败计为该源失败进入降级（GitHub 路径保持不阻塞，§6.2 归类）**；`rateLimitedUntil` → `Map<UpdateSource, until>`；`getRateLimitedUntil()` **签名不变（仍返回 number epoch ms），语义 = 各源退避截止时刻的最大值（无任何退避记录返回 0）**——handler 判定式 `> Date.now()` 与既有 mock 形态全部不变，仅在多源退避时返回值天然为全源语义；manifest 解析扩展 size；manifest URL 改为从胜出源 release JSON assets 取 `manifest.json` 的 `browser_download_url`（弃用 GitHub 的 `releases/latest/download/` 常量——GitHub 路径同款改法，顺带消除两源的 latest 错位竞态）；**resolver 注入方式：构造注入 `new ReleaseChecker({ resolveSourceOrder })`**（测试可替换，对齐项目 DI 风格） |
| `update/source-resolver.ts`（新） | `resolveSourceOrder()`（§6.4）：settings 映射 / 代理短路 / 域名并行探测（GET Range 0-0 + 任何响应即可达 + `disableFlagPersistence: true`）/ 进程内 TTL 缓存 |
| `update/orchestrator.ts` | `downloadUpdate` 失败分类后接跨源续传降级（触发集合 = §6.5「降级的触发集合」：errorCode 四值，显式排除磁盘/重命名/权限/完整性；`release.source` 为 undefined（旧落盘文件）时不降级，§6.7；by-tag 确认含目标 asset 存在 → 复用 temp+state 续传 → sha256 兜底）；预下载（preloadUpdateSilently）经同一入口自动获得降级行为（辐射面声明见 §6.5）；需要 checker 按 tag 查询时经 `IReleaseChecker` 新方法（接口扩展，DI 注入不变） |
| `update/download-asset.ts` | **多段入口探测 `probeMultiPartSupport` 改造（download-asset.ts:1051-1072）：请求 HEAD → GET `Range: bytes=0-0`，判定条件同步迁移**——原判定 `result.ok && accept-ranges: bytes && content-length ≥ 阈值` 与返回值 `totalBytes = content-length` **不可照搬**：206 响应体仅 1 字节（content-length 恒 1，照搬则两源含 GitHub 多段静默全灭），且 RFC 7233 对 206 仅强制 Content-Range（accept-ranges 在该形态下不可依赖）。新判定：HTTP 206 + `Content-Range: bytes 0-0/{total}` 且 total ≥ `MIN_MULTI_PART_SIZE` → supported；totalBytes 改从 Content-Range 取。**边界出口（全形态归类）**：非 206（200/405 等，含服务器/代理剥 Range 的全量退化）→ 不支持，单段下载（合法出口，正确性无风险）；206 但 Content-Range 缺失、total 为 `*` 或单位非 bytes → 一律视同不支持（无 total 即无法切分多段，单段）。**响应体代价入账**：upgradeFetch 的 GET 语义无条件读全响应体（undici `res.text()` 入内存 / curl `-o` 落盘后整读，upgrade-fetch.ts:518/:430/:481）——正常态 206 响应体仅 1 字节，probe 代价 ≈ 现状 HEAD；200 全量退化态下 probe 自身将消耗一次全量传输（≤170MB）+ 最长 30s（默认超时兜底）才落单段出口——量级有界、出口正确，判定可接受；实施期如需消除，可选 stream 早退或显式缩短 probe timeoutMs |
| `update/validate-release.ts` | `ALLOWED_DOWNLOAD_HOSTS` 增补 AtomGit 域（§6.6）；域集合改为消费 release-sources 单一来源导出（§6.1 防漂移） |
| `update/update-settings.ts` | `updateSource` 逐字段枚举校验（§6.3） |
| `update/error-log.ts` | 诊断面扩展（验收 S1/S2/S3 的观测面依赖）：① `appendUpdateError` 增加 `releaseSource` 字段（对齐既有 engine 字段先例，失败归因到源）；② **新增成功路径登记（现状 error-log 仅有失败登记，成功登记全部为本次新增）**：source=`source-selection`（每轮检查的源顺序与胜出源 + auto 探测结果 + **各源 latest tag**（检查响应顺带携带，零新增请求——F5 同步缺失形态的唯一客户端观测面））、source=`source-failover`（跨源降级发生点 + from/to 源 + manifest 获取来源）、source=`download-success`（第三类：每次下载成功落一条，含 `multiPart` 布尔 = probe 判定结果 + `engine` 字段；写入量级每次下载 1 条，可忽略）——统一写入同一 JSONL（512KB×2 轮转通道复用）。**写放量级入账**：正常态 source-selection ~24 条/天 ≈ 7-10KB/天，1MB 总容量提供约 3 个月失败记录回溯（现状近乎永久，缩窗但排障窗口仍足够）；故障风暴态每次尝试 4-5 条，风暴前历史可被挤掉但风暴期内记录完整（~1500-2000 条容量），排障主窗口不受损——**判定可接受**；降频优化：source-selection 仅在排序/胜出源/探测结果/tags 任一变化时写（常态恒定，变化点才是排障信号；tags 纳入变化检测是 F5 同步缺失观测面在稳态下保持新鲜的必要条件）；下载成功登记的 multiPart 字段是 S1 多段生效断言的观测面（防 probe 改造回归静默退化单段） |
| `gateway/update-handlers.ts` | `update:setSettings` 增补枚举校验；`update:check` 的 `rateLimited` 判定改读 per-source 退避（调用形状不变） |
| `interfaces.ts` | `IReleaseChecker` 接口补 `fetchReleaseByTag(source: UpdateSource, tag: string): Promise<LatestReleaseInfo | null>`——**精确签名与职责归属**：透传式（方向①），对侧源推导在 orchestrator（从 `release.source` 取补集），checker 保持无状态透传，与 D1 门面定位一致；返回 normalize 后的 release 结构（含 assets），无该 tag 返回 null；mock 与单测的接口形状据此确定 |
| **存量测试迁移（改动地图组成部分，非新增测试）** | ① `release-checker.test.ts`：负缓存 describe 块（约 4 用例）按「全源确认才写负缓存」新循环出口语义**重写**（非回归修复）；fetch mock 序列（globalThis.fetch 按次序出队模式）须计入 auto 模式下的探测请求与两源顺序——推荐经构造注入 mock `resolveSourceOrder` 消除探测请求混入；② `download-asset.test.ts`：全部 `method === 'HEAD'` mock 分支（9+ 处）改写为 GET Range 0-0 + Content-Range 形态（probe 改造的必然联动，不改动则静默不命中走单段）；③ `update-handlers.test.ts`：getRateLimitedUntil mock 形态不变（方向 A 语义），补「全源退避才 rateLimited=true」用例 |

### 7.3 前端（packages/renderer/）

| 文件 | 改动 |
|------|------|
| `components/settings/update/UpdatePage.vue` | 「更新来源」三选控件（自动（推荐）/ GitHub / AtomGit），读写走现有 `getUpdateSettings`/`setUpdateSettings` IPC。**实施规格**：嵌入现有偏好卡（与 preDownload/autoUpdate 同卡或紧邻，不新增卡片）；testid 命名 `select-update-source`（对齐现有 switch-auto-update 命名族）；**沿用现有「切换即持久化 + 失败回滚 + toast」交互模式**（与现有两开关一致，无保存按钮）；切换后不自动触发 force 检查（偏好实际生效以缓存 TTL 为界，§6.3 已声明，不做「切换即重查」的额外行为） |
| `i18n/locales/{zh-CN,en-US}/settings.ts` + `i18n/locales/{zh-CN,en-US}/sidebar.ts` | **三处写死「GitHub」的文案改写（语义泛化后的事实错误修正）+ 来源选择新文案**：① `sidebar.update.rateLimited`（zh-CN:52 / en-US:53，注意该 key 在 sidebar.ts 而非 settings.ts）「检查更新接口已被 GitHub 限额」→ 中性「更新检查服务限流，约 2 小时内暂停自动检查」（信号语义已泛化为全源限流）；② `types.ts` 的 UPDATE_NETWORK_FAILED suggestion「确保可以访问 GitHub」→ 去 GitHub 专名（双源皆败时用户可能恒走 AtomGit，访问不了 GitHub 与其故障无关）；③ shared/update.ts:69 注释「GitHub API 限额」→ 中性表述（随 §7.1 同批）。新增：来源选择控件文案（zh-CN + en-US 双语） |
| `docs/testing/` testid 清单 | `select-update-source` 登记联动（M5 随控件落地） |
| `lib/ipc.ts` / preload | **零改动**——`setUpdateSettings(Partial<UpdateSettings>)` 泛型透传，类型随 shared 更新自动放行新字段 |

### 7.4 错误规格表（全失败路径）

| 失败点 | 条件 | 系统行为 | 用户可见 | 恢复指引 |
|--------|------|---------|---------|---------|
| 检查-主源 | 网络失败/404/形状坏/限流 | 静默试次源（`source-failover` 登记） | 无（次源成功时） | — |
| 检查-主源 | 返回 release 被防御拦截 / 不比当前新（「该源无新版」） | **不写全局负缓存**，静默试次源（§6.5） | 无（次源有新版时正常提示） | — |
| 检查-全源 | 双源网络失败 | null，不缓存失败（现状） | 无新版提示（现状语义） | 恢复网络后自动重试 |
| 检查-全源 | 双源均确认无新版 | 写负缓存 info=null（1h） | 无新版提示（现状语义） | 新版发布后下周期可见 |
| 检查-混合 | 一源失败/退避 + 另一源确认无新版 | 返回 null 但**不写负缓存**（未确认源下周期应重试，负缓存会把「未知」固化为「确认无」） | 无新版提示 | 恢复后下周期自动重查 |
| 检查-全源 | 双源均限流退避中 | null + `rateLimited: true` | 非侵入提示（现状语义） | 等待退避窗口（2h）过 |
| 检查-AtomGit | manifest fetch 失败/资产缺失（sha256/size 必经） | **计为该源失败** → 试次源（§6.2 源归类） | 无（GitHub 可达时） | GitHub 也不可达时同「检查-全源」行 |
| 下载-主源 | 网络类失败 | by-tag 查对侧 → 复用断点续传 → sha256 兜底（`source-failover` 登记） | 进度续走，无错误 | — |
| 下载-主源 | 网络类失败 + 对侧不可用（by-tag 404 发布时间窗 / by-tag 200 但目标 asset 缺失的部分同步失败窗口） | 不降级，保留本源断点，原错误上抛（不误报为网络失败、不触发无意义续传） | UPDATE_NETWORK_FAILED + 手动通道指引（现状） | 稍后重试 / 手动下载 |
| 下载-双源 | 对侧续传也网络失败 | 原错误上抛 | UPDATE_NETWORK_FAILED + 手动通道指引（现状） | 手动下载 / 恢复网络重试 |
| 下载-任一源 | sha256/size 与 manifest 不符 | **fail-fast 不跨源降级**（§6.8），自动清 temp | 「安装包校验失败」 | release 页手动下载 / 等下一版 |
| 下载-AtomGit | release 缺 manifest.json | 检查流⑤已拦（该源失败），不会进入下载；兜底仍存在（BLOCKER 4 双缺拒绝） | 完整性错误（理论不可达，防御纵深） | 发布侧重跑阶段 6.5 |
| resolveByVersion | 双源 check 失败 | UPDATE_NETWORK_FAILED（现状语义） | 同现状 | 同现状 |

### 7.5 运行时断言与探针

| 探针 | 断言 | 状态 |
|------|------|------|
| P1 | AtomGit `releases/latest` 返回的 `assets[].browser_download_url` 落域（决定 ALLOWED_DOWNLOAD_HOSTS 精确登记值；含 manifest.json 资产的 URL 落域是否一致） | ⛔ 实施期门——`curl -s --max-time 15 'https://api.gitcode.com/api/v5/repos/qq_18433817/xyz-agent/releases/latest'` 解析 assets 即得；失败则白名单暂登记 `gitcode.com` + `raw.gitcode.com` 双域 |
| P2 | AtomGit CDN 支持 Range 请求（多段下载 + 探测方法前提） | ✅ 已测——sync 脚本 6.5.4 实测 302 → CDN → Range 206 |
| P3 | AtomGit by-tag 端点可用（下载降级前提） | ✅ 已测——`GET /repos/{repo}/releases/tags/{tag}` 为 sync 脚本常规路径 |
| P4 | AtomGit release 含 manifest.json 且其 `browser_download_url` 匿名可下载（sha256/size 填充前提） | ✅ 部分已测——v0.9.14 assets 含 manifest.json（对抗式核实）+ by-tag 直链匿名下载成功（sync 脚本）；⛔ 实施期补一次「从 assets 直链下载 manifest.json」的完整链路确认 |
| P5 | 两主域对 GET `Range: bytes=0-0` 探测的响应形态与双引擎判定等价性（undici resolve / curl httpStatusCode 均按「任何响应即可达」归类；gitcode.com 对 GET 不 405） | ⛔ 实施期门——source-resolver 单测 + 一次真机冷启动日志核对；失败降级路径 = 双败回退 [github, atomgit]（现状行为） |
| P6 | AtomGit `releases/latest` 响应中 `prerelease` 字段类型与取值（boolean 还是字符串编码；`release_status` 实际取值集） | ⛔ 实施期门——P1 同一条 curl 的响应即可读取；normalize 的 `=== true` 收窄在该确认前即安全（最坏误判 stable 为 prerelease → 该源失败降级，不误装） |
| P7 | 多段探测改造的兼容性（两源同权，改造同样作用于 GitHub 域）：GET `Range: bytes=0-0` 返回 206 且 `Content-Range` 携带正确 total（≥ 安装包实际大小；content-length=1 为预期陷阱）+ 4 路并发 Range 206（客户端读路径并发无官方承诺，写路径 8 并发 429 不能直接外推） | ⛔ 实施期门——与 P1 同期对 GitHub 与 AtomGit 下载 URL 各实测一次；失败降级路径 = probe 判不支持 → 单段下载（正确性无风险，速度退化），探针结果决定是否需给 AtomGit 源加段数收敛 |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：6 个真实场景覆盖目标 1-4（含 1 个反向安全场景），核心场景全部在打包后的真实 app + 真实网络环境执行。**

### 8.1 改动规模

大改动（新功能 + 行为变更 + 接口调整 + 安全白名单扩展），按多场景投入。

### 8.2 验收场景

> 观测面前置声明（S1-S3 的断言依赖）：升级子系统现状唯一落盘诊断 update-error.log 只记失败、不含源维度——本设计随 M2/M3 落地「源选择/降级诊断落盘」（§7.2 error-log 行：`source-selection` / `source-failover` 登记 + `releaseSource` 字段）。以下场景的源判定断言均以该 JSONL 为准；打包 app 的 main 进程 console 不落盘，不作为观测面。

| 场景 | 回溯目标 | 真实流程（谁、在哪、做什么、看到什么） | 通过标准 |
|------|---------|--------------------------------------|---------|
| S1 显式 AtomGit 全链路 | 目标 1、4 | 打包安装真实 app（macOS），设置-更新来源选「AtomGit」，重启后 force 检查更新至出现新版 → 点更新下载 → 安装重启 | 新版提示出现；update-error.log 可见 `source-selection: order=[atomgit,github] winner=atomgit` 且无 `source-failover` 记录；`download-success` 登记含 `multiPart: true`（多段生效，防 probe 改造回归静默退化单段。前提注记：该断言以本次下载 engine=undici 为前提——curl 引擎按既有 D7 语义放弃多段，multiPart=false 非回归，断言失败先核对 engine 字段）；升级后启动 toast 版本号正确；自愈回滚链路无触发 |
| S2 auto 模式探测决策 | 目标 1、2 | 同一打包 app 来源设「自动」：① 无代理冷启动 ② 开代理冷启动，各观察一次检查 | ① update-error.log 可见 `source-selection` 含探测结果（两域可达性）与排序，胜出源为实际可达者 ② 排序 [github, atomgit] 且日志无探测记录（代理短路）；两次均正常出检查结果 |
| S3 主源故障降级（真实故障注入） | 目标 3 | 来源设「GitHub」，`/etc/hosts` 把 `api.github.com` 与 `github.com` 指向 127.0.0.1（真实网络故障，非 mock），触发 force 检查与下载 | 检查自动落 AtomGit（log `source-failover: github→atomgit` + winner=atomgit）；下载自动落 AtomGit 完成 sha256 校验；移除 hosts 条目后 **force 检查**（绕开 1h 正缓存，否则观测不到）回到 GitHub 侧 winner |
| S4 双源皆败用户可见性 | 目标 3、4 | S3 基础上追加屏蔽 `api.gitcode.com`/`gitcode.com`，触发 force 检查 | UI 呈现现状语义的无新版/错误态（不崩溃、无悬空 loading），恢复网络后自愈 |
| S5 GitHub 路径回归 | 目标 2、4 | 来源设「GitHub」+ 代理正常环境，完整走检查→下载→安装（可用 dev 版本号差构造升级） | 与现状行为逐项一致：winner 恒 github、下载域名恒 github.com、UI 无新增元素；旧版本升上来后（settings 无 updateSource 字段）表现同 auto 默认 |
| S6 完整性失败不降级（反向安全验收） | 目标 4 | S3 降级链路中注入 sha256 不符产物（对 AtomGit CDN 响应做本地代理替换为同 size 异内容文件，或等效真实手段），触发下载校验 | 报「安装包校验失败」且 update-error.log **无第二次 `source-failover`**（证明未跨源重下）、temp 已清理；消除注入后重试可正常完成 |

单测分工（不替代上述场景）：release-sources normalize 字段映射表测（含 prerelease 字符串 `"false"` 不误判 case + **两源全部产物 downloadUrl hostname ⊆ ALLOWED_DOWNLOAD_HOSTS 防漂移断言**）、source-resolver 顺序决策表测（含探测「任何响应即可达」判定与 disableFlagPersistence）、downloadUpdate 降级分支测（mock 双引擎失败注入 + **UpdateIntegrityError 不触发降级** + **source undefined（旧落盘文件）不降级** 的反向断言 + 触发集合外 errorCode（DISK_SPACE 等）不降级 + 对侧 by-tag 404 / by-tag 200 但 asset 缺失两种形态均保留断点原错误上抛 + §11.4 的 totalBytes 三组合：一致续传 / 不一致转全量 / state 缺失从零）、probeMultiPartSupport 判定形态表测四出口（206 + Content-Range total 达标 → supported / 206 + total 低于阈值 → not / 206 但 Content-Range 缺失、total `*` 或单位非 bytes → not / 非 206（含 200 全量退化）→ not；断言 totalBytes 取自 Content-Range 而非恒 1 的 content-length）、validate-release 新域放行/非白名单域拒绝测、settings 枚举校验测、checker 循环出口语义测（主源「无新版」不写全局负缓存 + 混合态不写负缓存 + 次源新版可达 + **退避源短路零请求**断言 + **getRateLimitedUntil 返回各源最大截止时刻/无退避返回 0**）——vitest，配置在 apps/electron 既有测试体系。

## 9. 实施

**本章结论：5 个阶段按依赖排序，每阶段可独立验证。**

| 阶段 | 内容 | 交付终态的什么 | 验证 |
|------|------|---------------|------|
| M0 | 探针 P1/P4 剩余项/P5/P6/P7 执行（assets 落域 + assets 直链下载 manifest 完整链路 + 探测响应形态 + prerelease 类型 + 多段 probe 兼容性与并发 Range 读） | 白名单、normalize、探测与多段改造的精确输入 | 一条 curl 命令 + 小脚本并发 Range 实测 |
| M1 | shared 类型 + update-settings 读写校验 + setSettings handler 校验 | 数据模型与配置通路（编译期保证下游引用） | vitest + tsc |
| M2 | release-sources.ts + release-checker 多源编排 + manifest size 扩展 + per-source 退避 + error-log 扩展（releaseSource 字段 + source-selection/failover/download-success 登记 + 各源 latest tag，S1/S2 验收观测面先行落地）+ **DOC_MODULE_MAP 登记 `update-multi-source.md` → apps/electron/main/update + gateway/update-handlers.ts**（C-proc-10 硬要求，新符号落地后同批登记，pre-commit 按路径触发） | 检查段多源 + 诊断观测面（§4.2 检查流） | vitest（normalize/编排表测 + error-log 登记与轮转项） |
| M3 | 下载降级链 + download-asset 多段 probe GET Range 化 + validate-release 白名单 + **存量测试迁移（§7.2 测试迁移行：release-checker 负缓存块重写 / download-asset HEAD mock 族改写）** | 下载段多源（§4.2 下载流） | vitest（降级分支 + totalBytes 三组合 + 迁移后测试全绿） |
| M4 | source-resolver（ping + 代理短路） | auto 模式决策 | vitest（决策表测） |
| M5 | UpdatePage 设置项 + i18n 三处文案改写 + docs/testing testid 清单登记 | 用户入口 | 前端三视角测试 + S1-S6 真实验收 |

依赖：M1 → M2/M3/M4 → M5；M0 → M3（白名单域值）。M2/M3/M4 之间无相互依赖可并行。

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|------|------|------------------------------|
| unit-shared-types | UpdateSource/UpdateSourcePref/LatestReleaseInfo.source/UpdateSettings.updateSource | 一切消费方的编译期前置，独立 PR 可先行合入 |
| unit-release-sources | 两源 fetch+normalize+by-tag | 源适配单点（D1），可对两源真实 API 独立测试 |
| unit-checker-orchestration | 逐源尝试 + per-source 退避 + manifest size | 现状行为保持度最高的改造段，与适配层分离便于回归定位 |
| unit-download-failover | downloadUpdate 降级 + download-asset 多段 probe GET Range 化 + 白名单扩展 | 安全敏感段（D6/D8）独立成单元，审查与测试聚焦 |
| unit-source-resolver | ping/代理短路/TTL 缓存 | 纯决策逻辑零副作用，表驱动测试覆盖 |
| unit-source-diagnostics | error-log 扩展（releaseSource 字段 + source-selection/source-failover 登记） | S1-S3 验收的观测面依赖，独立成单元保证先行落地（M2 随 checker 落地） |
| unit-settings-ui | UpdatePage 控件 + i18n + 枚举校验链 | 纯入口层，唯一触达用户配置的单元 |

## 11. 待验证检查点（设计阶段无法确定，实施期诚实标注）

1. **P1 落域**：AtomGit `browser_download_url` 实际域名（gitcode.com vs raw.gitcode.com vs 其他）——M0 探针定。
2. **P5/P6/P7 探测与字段类型**：两主域对 GET Range 探测的响应形态与双引擎判定等价性；AtomGit `prerelease` 字段类型（boolean vs 字符串编码）与 `release_status` 取值集；多段 probe 改造后两源的 206 + Content-Range 形态——normalize 的 `=== true` 收窄与「任何响应即可达」判定在确认前即安全（最坏表现 = 该源失败降级，不误装、不误排序致死）；P7 失败的最坏表现 = 单段下载（慢但不坏）。
3. **atomgit API 匿名访问的稳定性**：对抗式核实时单次成功；其无限流响应头意味着客户端无法主动感知限流逼近，若实际使用中频繁 4xx/429，需要在 M2 观测（`source-selection` 日志）后决定是否给 atomgit 源加保守的请求间隔（发布脚本实测写路径 8 并发 429，读路径单客户端预计余量大，但无官方承诺）。
4. **跨源续传的既有守卫交互**：resume-state 的 totalBytes 校验、206/200 响应分类、state 清理点在「对侧 URL + 本源断点状态」组合下的行为（§6.5 依赖声明）——M3 实施期以单测覆盖三个组合：对侧 totalBytes 一致（续传）/ 不一致（转全量）/ state 缺失（从零）。
5. **Windows NSIS 安装包在 AtomGit 下载后的安装链路**：S1 场景以 macOS 为主验，win32 路径（-setup-x64.exe + updater.cmd）逻辑同构但未在本设计期内实测，M5 后补 S1 的 Windows 复验。

## 附录：变更历史与审查溯源

- v1（2026-09-07）：初稿。基于对抗式核实报告（gitcode API 事实基座 + electron-updater 不替换结论）与全链路源码实读。
- v2（2026-09-07）：第 1 轮审查修复（主审 4 must-fix / 5 suggestion + 影响面审 6 must-fix / 4 suggestion，全修）。关键修订：
  - **检查流循环出口语义重做**（主审 MF1）：三重防御 + 版本比较移入逐源循环，「该源无新版」不再写全局负缓存，全部源确认无新版才写（否则 AtomGit prerelease / 旧版会吞掉 GitHub 侧新版，F1 在多源下复活）；顺带声明「AtomGit 滞后窗口 ≤1h」取舍（D5）。
  - **manifest URL 改从 release assets 取直链**（主审 MF2 + 影响面 MF2）：v1 的 `releases/latest/download/` 别名形态被击穿（sync 脚本仅验证过 by-tag 直链，声称不实），弃用别名并顺带消除 latest 前移错位竞态；GitHub 路径同款改法。记入被否谱系（D2）。
  - **auto 探测方法重做**（主审 MF3 + 影响 MF4/S2）：HEAD 改 GET Range 0-0（本仓实测「GitCode 禁 HEAD」），判定语义显式定义为「任何完成 HTTP 响应即可达」（对齐 testProxyConnection 准绳 + curl `-f` 两引擎等价），`disableFlagPersistence: true` 隔离 enginePreference；v1 HEAD 方案记入被否谱系（D4）。新增探针 P5/P6。
  - **manifest 失败源归类**（影响 MF1）：AtomGit 路径 manifest fetch 失败计为该源失败进降级；GitHub 路径保持现状不阻塞（digest 优先 + API size 兜底，无变形风险）（D2 + §7.4）。
  - **跨源降级 × 断点续传显式决策**（影响 MF3 + 主审 S3）：选「复用 temp+resume-state 跨源续传」（保进度 + 三重防护托底），「清状态从零重下」记入被否谱系；补依赖声明与待验证检查点 §11.4（D5）。
  - **后台预下载辐射面声明**（影响 MF5）：preloadUpdateSilently 自动获得跨源续传，量级有界（opt-in + 60min 节流 + 锁串行），判定可接受（D5）。
  - **代价四要素补齐**（影响 MF6）：D2/D4 边界补重审触发条件，D4 补失误时间量级（最坏单次检查延迟近似翻倍 + 探测 ≤3s 入账）。
  - **验收观测面落地**（主审 MF4 + 影响 S3）：改动地图新增 error-log 行（`releaseSource` 字段 + `source-selection`/`source-failover` 成功路径登记）；S1/S2/S3 通过标准绑定该 JSONL 观测面，S3 补 force 检查前置（绕开 1h 正缓存）。
  - **反向安全验收补场景 S6**（主审 S5）：注入 sha256 不符产物，断言不跨源降级 + temp 清理；单测分工补「UpdateIntegrityError 不触发降级」反向断言与 checker 循环出口语义测。
  - 细节修正：prerelease 显式 `=== true` 收窄（S1）、i18n 目录 en→en-US（S2）、§1 前端路径补全、per-check 请求预算入 §4.2、F4 行补 ≤1h 检查侧延迟。
- v3（2026-09-07）：第 2 轮聚焦复审修复（主审 0 must-fix / 2 suggestion + 影响面审 1 must-fix / 4 suggestion，全修）。关键修订：
  - **多段入口探测 HEAD 同族遗漏**（影响面 MF，第 3 个 HEAD 冲突点）：`probeMultiPartSupport` 的 HEAD 改为 GET `Range: bytes=0-0`（§4.1 表 / §7.2 新增 download-asset 行 / 探针 P7），否则 AtomGit 源多段静默退化为单段；4 路并发 Range 读并入 P7 实测（写路径 8 并发 429 不能外推读路径）。
  - **by-tag 200 但目标 asset 缺失**（影响面 S3）：下载降级 by-tag 确认扩展为「tag 存在且目标平台 asset 存在」，缺失与 404 同语义（§4.2③/§7.4）。
  - **重试语义与不变量破坏通道**（影响面 S1）：重试恒从原胜出源从零、降级不记忆历史；「两源逐字节一致」的发布侧保障三件套与残余破坏通道（tag 重发 × 同名跳过）登记，信号挂接 D2 重审条件（§5.2/§6.5）。
  - **error-log 写放入账**（影响面 S2）：正常态 ~10KB/天、风暴态 4-5 条/次、1MB ≈ 3 个月回溯，挤占判定可接受 + source-selection 变化时才写的降频优化（§7.2）。
  - **退避短路步骤与混合态请求量**（主审 S1）：§4.2③ 补「退避源短路跳过（零请求）」，混合态不写负缓存的请求量入账（§4.2⑥/§6.5）。
  - **联动同步终检**（主审 S2 + 影响 S4）：§8 场景计数 5→6、单测分工补 totalBytes 三组合与 by-tag 200 无 asset 形态、§9 M0 补 P4/P7、M2 补 error-log 挂点、M3 补 probe 改造、M5 补 S6、§10 同步。
- v4（2026-09-07）：第 3 轮聚焦复审修复（主审 0 must-fix / 3 suggestion + 影响面审 1 must-fix / 1 suggestion，全修）。关键修订：
  - **probe 判定条件迁移规格**（影响面 MF）：GET `Range: bytes=0-0` 的 206 响应 content-length 恒 1（响应体 1 字节）且 RFC 7233 仅强制 Content-Range——照搬原判定（content-length ≥ 阈值 / accept-ranges）会让**两源含 GitHub 的多段静默全灭**。§7.2 补完整判定规格：206 + Content-Range total ≥ 阈值，totalBytes 从 Content-Range 取；P7 改写为两源同权实测；单测补 probe 判定三出口表测；下载成功登记加 multiPart 字段 + S1 补多段生效断言（观测面闭环）。
  - **发散场景手动下载指引修正**（影响面 S）：sha256 发散嫌疑侧 = 当前胜出源，恢复指引从「GitHub 侧 release 页」改为「另一通道（README 双通道链接）」，避免指向发散源。
  - **观测面补强**（主审 S1/S2/S3）：单测分工补「退避源短路零请求」断言；§9 M2 验证列补 error-log vitest 项；§11 汇总补 P7。
- v5（2026-09-07）：第 4 轮终检微修（主审 0 must-fix / 0 suggestion / 1 INFO + 影响面审 0 must-fix / 3 suggestion，全修；双报告判定设计就绪）。修订：
  - **probe GET 响应体代价入账**（影响 S1）：upgradeFetch GET 语义无条件读全响应体（undici text() / curl -o 整读，源码行号核实）——正常态 206 仅 1 字节代价 ≈ 现状 HEAD；200 全量退化态 probe 自身消耗 ≤170MB 全量传输 + 最长 30s 才落单段出口，量级有界判定可接受，实施期可选 stream 早退/缩短 probe timeoutMs 消除；v4 的「AbortController 响应头即中止」表述不成立（upgradeFetch 无该能力），已更正。
  - **Content-Range 全形态出口归类**（影响 S2）：缺失 / total `*` / 单位非 bytes 一律视同不支持（单段），单测四出口覆盖。
  - **multiPart 挂点显式化**（影响 S3 + 主审 INFO）：新增第三类成功登记 source=`download-success`（每次下载 1 条，含 multiPart + engine），S1 断言补 engine=undici 前提注记（curl 引擎按既有 D7 语义放弃多段，multiPart=false 非回归）。
- v6（2026-09-07）：第 5 轮独立四维度深度审查修复（0 P0 / 7 P1 / 7 P2，全修；审查聚焦历史 4 轮的方法盲区：治本护栏 / UX 联动场景 / AI Agent 可实施性 / 副作用补漏）。关键修订：
  - **同步缺失失效形态显式化**（深度 F1，P1）：新增 §3.2 F5 行——阶段 6.5 整体被跳过时客户端不可自动检测（混合态静默、发布侧门禁只约束「已执行的阶段」），source-selection 登记补各源 latest tag 作为唯一客户端观测面；F4 的「反向同理」措辞修正（同步是单向的，反向仅存在于 release 删除/重发事故）；§6.5 补显式盲区声明。
  - **接口签名与语义留白补齐**（深度 F3/F5，P1；F12，P2）：`fetchReleaseByTag` 精确签名 + 透传式职责归属（对侧推导在 orchestrator）；`getRateLimitedUntil()` 显式选「返回各源最大截止时刻、签名不变」方向（handler 判定式与既有 mock 形态不变）；`SourceOrder` 类型定义归属 source-resolver；atomgit 分支形状守卫 + asset 字段别名容错细节。
  - **降级触发集合枚举**（深度 F4，P1）：errorCode 四值白名单 + 显式排除磁盘/重命名/权限/完整性；`source: undefined`（旧落盘文件）不降级（深度 F2，P1）；降级仅替换 downloadUrl、完整性基准保持原胜出源（深度 F11，P2）。
  - **存量测试迁移清单入改动地图**（深度 F6，P1）：release-checker.test.ts 负缓存块重写 + fetch mock 序列含探测请求（resolver 构造注入消除）、download-asset.test.ts HEAD mock 族改写、update-handlers.test.ts 全源退避用例；checker 构造注入 `resolveSourceOrder`。
  - **三处写死 GitHub 的文案/注释入改动地图**（深度 F7，P1）：sidebar.ts rateLimited toast（注意 key 在 sidebar.ts 非 settings.ts）、UPDATE_NETWORK_FAILED suggestion、shared/update.ts 注释，全部中性化；§5.2「文案与现状一致」表述同步修正。
  - **UX 量级与规格补全**（深度 F9/F10/F13，P2）：D3 补偏好切换缓存窗口生效时延；D5 预下载辐射面补滞后收敛重下量级；UpdatePage 控件实施规格（嵌入卡位 / testid `select-update-source` / 切换即持久化 / 不自动重查）+ docs/testing testid 清单联动入 M5。
  - **防复发护栏与流程登记**（深度 F8/F14，P2）：D1「零感知」修正为「行为零改动 + 4 处接入清单」，normalize 表测补 downloadUrl ⊆ ALLOWED_DOWNLOAD_HOSTS 防漂移断言（域常量单一来源导出）；§9 M2 补 DOC_MODULE_MAP 登记（C-proc-10）。
