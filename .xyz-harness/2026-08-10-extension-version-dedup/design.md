# 内置扩展版本陈旧 + npm 安装重复修复设计

> **一句话结论**：内置扩展版本陈旧源于 dev 读 staged 快照却不自动刷新；npm 安装重复源于去重 key 用了一个 scoped/unscoped 不一致的中间函数。两处都按「数据身份唯一源」原则根治——dev 前置刷新 staged、去重 key 统一为 package.json.name + mandatory 包安装拦截。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 把 9 个 `@zhushanwen/pi-*` 扩展打包内置（staged 到 `apps/electron/resources/extensions/`），dev 与 packaged 都从这里发现；用户还能在 Settings → Extensions 用 `npm:@zhushanwen/pi-xxx` 自行安装扩展到 `~/.xyz-agent/npm/`。
- **C（冲突）**：现状两个问题——① dev 显示的内置扩展版本停留在上次手动跑 prepare 时的快照（实测 9 个包里 7 个比源码落后 1~5 个大版本）；② 用户 npm 安装一个已内置的 mandatory 包后，「已安装」列表立刻出现两个同名条目。
- **Q（问题）**：怎么让内置扩展版本始终与源码一致、且同一扩展在列表里只出现一份？
- **A（答案）**：① dev 启动前置 `prepare-builtin-extensions`（实测 1s）；② 去重 key 从 `normalizeExtName`（clever 中间层）改为 `package.json.name`（身份唯一源），并在安装入口拦截 mandatory 包。本文展开。

---

## 1. 背景：被设计的系统是什么

**扩展管理子系统负责发现、去重、安装、启停 pi 扩展，是 Settings → Extensions 页面与 pi `--extension` 注入的唯一数据源。**

扩展有三个互不重叠的概念层，本文反复引用，先定义：

- **内置扩展（builtin / mandatory）**：9 个 `@zhushanwen/pi-*` 包，打包进产物，不可卸载、不可禁用（infrastructure 级连禁用都不行）。SSOT 是 `packages/shared/src/mandatory-extensions.json`。运行时由 `scanBundledExtensions` 从 staged 目录发现。
- **用户安装扩展（user-installed）**：用户在 Settings 用 `npm:xxx` 安装到 `~/.xyz-agent/npm/node_modules/`，记录在 `settings.json` 的 `packages[]`。由 `scanSettingsExtensions` 发现。
- **其它源**：`XYZ_EXTENSION_PATHS`（dev-link 本地源码）、discovery 目录、第三方目录（local/git 安装）。本文问题不直接涉及。

发现流程：6 个源各自扫描磁盘 → `deduplicate()` 按优先级去重（npm > user > discovery > settings > third-party > bundled）→ `resolveExtensions()` 推导 tier/loadable → 前端展示 + pi 加载。

**本次设计 scope**：当前层 = 扩展发现/去重/安装子系统的两个缺陷；下一层 = 可实现的代码改动（去重 key 语义、dev 启动前置、安装拦截）。不跨到扩展加载机制重构或 preset 管控重构。

---

## 2. 设计目标

**改造后使用者（开发者跑 dev、用户装扩展）不再碰到版本欺骗和重复条目。**

1. **G1（版本一致）**：dev 模式下内置扩展显示的版本 = 源码 `extensions/<pkg>/package.json` 的版本，无需手动跑脚本。
2. **G2（无重复）**：同一扩展在「已安装」列表至多出现一份；用户尝试 npm 安装已内置的 mandatory 包时，被明确拒绝并给出原因，而不是装出一个重复副本。
3. **G3（历史自愈）**：已经误装出的重复条目（历史遗留）在重启后自动消失，无需用户手动清理。

**In-scope**：dev 启动流程、`deduplicate` 去重 key、`installExtension` 安装拦截、历史遗留迁移。
**Out-of-scope**：扩展加载机制（pi `--extension` 注入）、preset extensionMode 管控、recommend 机制、第三方/discovery 源的结构调整。

---

## 3. 现状：使用者眼里是什么样的

### 3.1 版本欺骗的真实样子

开发者改了 `extensions/ask-user/` 源码（package.json version 从 2.0.0 bump 到 7.0.2），`pnpm dev` 启动，打开 Settings → Extensions，看到：

```
pi-ask-user        版本 2.0.0     [内置]
```

版本号是 **2.0.0**，不是源码的 7.0.2。开发者会误以为没改成功、或改错分支、或缓存没清——实际源码已经是 7.0.2，只是 dev 显示的是陈旧快照。

实测 9 个内置包源码版本 vs dev 显示版本（staged 快照）：

| 包 | 源码 | dev 显示 |
|---|---|---|
| ask-user | 7.0.2 | 2.0.0 |
| goal | 0.8.2 | 0.6.0 |
| todo | 0.7.1 | 0.5.0 |
| pending-notifications | 0.3.1 | 0.3.0 |
| subagent-workflow | 7.1.0 | 2.0.0 |
| structured-output | 5.0.1 | 2.0.0 |
| scheduler | 0.1.1 | 0.1.0 |
| permission | 1.0.0 | 1.0.0 |
| rename-session | 0.3.0 | 0.3.0 |

7/9 落后，最严重的 subagent-workflow / structured-output 落后 5 个大版本。

### 3.2 重复安装的真实样子

用户在 Settings → Extensions 的 npm 安装框输入 `npm:@zhushanwen/pi-ask-user`，点安装。「已安装」区域立刻出现：

```
pi-ask-user        版本 2.0.0     [内置]
pi-ask-user        版本 <npm上的版本>   [已安装]
```

两个同名条目。用户无法区分哪个是哪个，也无法理解为什么内置了还能再装一个。

### 3.3 怎么出错（失败模式）

- **FM1（版本欺骗）**：dev 显示的版本与磁盘源码不一致。触发条件：源码 version 变更后未重跑 `prepare-builtin-extensions.sh`。dev 脚本不含该步骤，故每次 dev 启动都可能显示陈旧版本。
- **FM2（重复条目）**：npm 安装一个已内置的包后，列表出现两份。触发条件：目标包同时命中 `bundled` 源（staged 目录）和 `settings` 源（packages[]）。
- **FM3（语义矛盾，潜藏）**：两份重复条目都被标成 `mandatory: true`（因为都按 package.json.name 匹配 mandatory SSOT），意味着用户装出的第二份「不可卸载、不可禁用」——但 `installExtension` 没做任何拦截，用户能不断装出第三、第四份。

---

## 4. 根因 + 物理数据流

**两个症状的共同根因：扩展的「身份」没有唯一权威源——版本从一个快照目录读，去重 key 从一个会丢失信息的中间函数算。**

### 4.1 FM1 根因：dev 读 staged 快照，staged 不随源码更新

> **staged 快照** = `apps/electron/resources/extensions/@zhushanwen/<pkg>/`，由 `prepare-builtin-extensions.sh` 用 `rsync` 从 `extensions/<pkg>/` 拷贝生成（含 package.json）。就是 §3.1 例子里 dev 读的那个目录。

物理数据流（版本号怎么从磁盘流到用户眼前）：

```
源码 extensions/ask-user/package.json   version = 7.0.2
        │ （仅当有人手动跑 prepare 时才同步；dev 脚本不跑）
        ▼  ← Aug 2 跑过一次 prepare，之后源码 bump 到 7.0.2 但没重跑
staged apps/electron/resources/extensions/@zhushanwen/pi-ask-user/package.json
        │   version = 2.0.0 （陈旧快照）
        ▼  dev 模式 scanBundledExtensions 读这里（resolver.ts:215）
assembleExtensionInfo → readPkgMeta(stagedDir).version = "2.0.0"
        ▼
前端扩展页显示「pi-ask-user  2.0.0」   ← FM1
```

关键事实（已实测，准则 7）：

| 探针 ID | 验证的行为 | 探针 | 结果 |
|---|---|---|---|
| P-src-ts | 源码入口是 TS，pi 直接加载（非编译产物） | `extensions/ask-user/package.json` 的 `main` | ✅ `"main": "index.ts"`，pi 支持 TS |
| P-staged-rsync | staged 是源码的 rsync 副本（无 build 步骤） | 读 prepare 脚本 | ✅ 全程 `rsync -a`，无 tsc/build |
| P-prepare-time | prepare 全量执行耗时 | `time bash scripts/prepare-builtin-extensions.sh` | ✅ **1.067s**（29.6M，SSD） |
| P-dev-no-prepare | dev 脚本不含 prepare | grep `apps/electron/package.json` dev | ✅ dev = electron-ensure + concurrently(vite, electron)，无 prepare |

结论：prepare 只 rsync 不 build，耗时 1s 级，但 dev 不自动跑，导致快照陈旧。

### 4.2 FM2 根因：去重 key 的 scoped/unscoped 不一致

> **去重 key** = `deduplicate()` 用来判断「这是不是同一个扩展」的字符串。同一扩展在多个源出现时，key 相同才能去重成功。

根因函数 `normalizeExtName`（`extension-resolver.ts:457`）：保留 scope、去掉 `pi-` 前缀。

```
"@zhushanwen/pi-ask-user" → "@zhushanwen/ask-user"   （scoped 包名，保留 scope）
"pi-ask-user"             → "ask-user"               （无 scope 目录名）
```

两个源用不同的输入算 key：

| 源 | 输入 | normalizeExtName 结果 | 出处 |
|---|---|---|---|
| **bundled** | `pi-ask-user`（staged 的 `@zhushanwen` 目录子项名，无 scope） | `ask-user` | `scanDirectory` → `normalizeExtName(entry)` |
| **settings** | `@zhushanwen/pi-ask-user`（packages[] 完整 scoped 包名） | `@zhushanwen/ask-user` | `scanSettingsExtensions` → `normalizeExtName(pkgName)` |

`ask-user` ≠ `@zhushanwen/ask-user` → `deduplicate` first-write-wins 不命中 → 两份都进列表。

物理数据流（重复怎么产生）：

```
用户 npm install "npm:@zhushanwen/pi-ask-user"
        │ installExtension
        ├─ npm 装到 ~/.xyz-agent/npm/node_modules/@zhushanwen/pi-ask-user/
        └─ settings.json packages[] += "npm:@zhushanwen/pi-ask-user"

刷新 scanExtensions → 6 源扫描 → deduplicate:
  bundled 源  entry="pi-ask-user"  → normalizeExtName → key = "ask-user"
  settings 源 pkg="@zhushanwen/pi-ask-user" → normalizeExtName → key = "@zhushanwen/ask-user"
        │ key 不等，去重失败
        ▼
ExtensionInfo[] 含两份 name="@zhushanwen/pi-ask-user"（两份的 name 都来自 package.json.name，相同）
        ▼
前端「已安装」显示两个同名 pi-ask-user   ← FM2
```

关键事实（已实测，准则 7）：

| 探针 ID | 验证的行为 | 探针 | 结果 |
|---|---|---|---|
| P-norm-callsites | normalizeExtName 仅作 deduplicate key，无外部依赖 | grep 全 runtime/src | ✅ 6 处调用全在 `extension-resolver.ts` 内部（scanNpm/scanSettings/scanBundled-via-scanDirectory/scanThirdParty/scanUser + 定义） |
| P-disabled-key | disabled key 早已用 package.json.name，不用 normalizeExtName | 读 `resolveExtension` | ✅ `disabledKey = npm:${meta.name}`，meta.name 来自 package.json |
| P-migrate-boot | 历史遗留清理在 boot 执行 | grep `migrateBuiltinExtensions` 调用点 | ✅ `index.ts:188` boot 时调用，清理 mandatory 包的 packages[]/disabled/autoUpgrade |

**P-disabled-key 是最重要的发现**：disabled key 和 ExtensionInfo.name 早已用 package.json.name，只有 deduplicate 用 normalizeExtName——去重层是唯一的不一致点。统一到 package.json.name 是让去重层对齐其余两层，而非另起炉灶。

> 补充：为什么 FM2 重启后会「自愈」？因为 `migrateBuiltinExtensions`（P-migrate-boot）在 boot 清理了 mandatory 包的 packages[] 记录，settings 源不再命中，只剩 bundled 一份。但用户看到的是「安装当下立即重复」，且重启后用户会困惑「我装的包去哪了」——靠 migrate 兜底是错的体验，正确做法是安装时就不让装。

---

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径

**场景 A（版本一致）**：开发者改 `extensions/ask-user/` bump 到 7.0.2，`pnpm dev` 启动（控制台多一行 `=== prepare-builtin-extensions ===`，约 1s），打开 Extensions：

```
pi-ask-user        版本 7.0.2     [内置]      ← 与源码一致
```

**场景 B（安装拦截）**：用户在 npm 安装框输入 `npm:@zhushanwen/pi-ask-user`，点安装，立即收到错误反馈（作为 assistant 消息插入，非顶部 banner，符合项目错误交互约定）：

```
安装失败：该扩展已内置，无需单独安装（@zhushanwen/pi-ask-user）。
👉 它已随应用打包，版本随应用更新。如需最新版，更新应用即可。
```

「已安装」列表不增加任何条目。

**场景 C（普通扩展正常安装）**：用户输入一个非 mandatory 的包（如 `npm:some-other-pi-ext`），正常安装，「已安装」增加一份，无重复。

### 5.2 失败路径（带恢复指引）

| 失败 | 触发 | 恢复指引（错误消息内嵌） |
|---|---|---|
| prepare 执行失败 | rsync 权限/磁盘满 | dev 启动中断，控制台显示 prepare stderr；手动 `bash scripts/prepare-builtin-extensions.sh` 排查后重试 `pnpm dev` |
| 安装 mandatory 被拦截 | 用户装 `@zhushanwen/pi-*`（9 个之一） | 「已内置，更新应用获取最新版」（场景 B） |
| 网络错误安装普通包 | npm registry 不可达 | 复用现有 `ExtensionInstallError('network', ...)`，hint 指向检查包名/registry |

---

## 6. 关键决策与权衡

### 6.1 决策一：dev 如何让内置版本与源码一致

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. dev 前置 prepare**（选） | 保持 dev/packaged 同源（既有设计意图），prepare 是已有脚本直接复用 | 极小：`apps/electron/package.json` 的 `dev` 脚本前置 `pnpm run prepare-builtin-extensions` | dev 启动 +1s（P-prepare-time 实测）；prepare 失败会中断 dev 启动（有恢复指引） | ✅ |
| B. dev 直接读源码 `extensions/` 目录 | 破坏 dev/packaged 同源；源码 node_modules 是 pnpm symlink，pi 子进程加载 native addon（permission 的 tree-sitter）行为未验证 | 小：改 `scanBundledExtensions` dev 分支指向 `extensions/` | symlink/native addon 加载行为未知（⛔ P-symlink 未验证）；deps 集合差异（源码全量 vs staged 精选）可能掩盖打包 bug | ❌ |

**被否若用 B**：§5.1 场景 A 的版本会直接显示源码 7.0.0.2（零拷贝），但 permission 扩展可能因 tree-sitter native addon 的 pnpm symlink 解析失败而在 dev 下根本加载不了——这个风险没有探针验证就不该声称「能行」（准则 7）。A 用 1s 换确定性，值。

**选 A 的理由**：减法优先（准则 8）——A 不引入新机制（prepare 已存在、staged 加载路径已验证），只是把已有步骤挂进 dev 流程；B 引入新的运行时断言（symlink/native addon）需额外验证，是加法。

### 6.2 决策二：去重 key 用什么

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. deduplicate key = package.json.name，废弃 normalizeExtName**（选） | 去重 key = 扩展身份 = package.json.name，与 disabled key（P-disabled-key）、ExtensionInfo.name 全链路统一。by construction 正确（结构上不可能产生 scoped/unscoped 不一致） | 中：改 `ExtensionMap` 各 scan 方法的 key 来源（读 package.json.name）+ `deduplicate` 对齐；影响面集中在 `extension-resolver.ts`（P-norm-callsites 已确认无外部依赖） | 极小：normalizeExtName 移除后，disabled/preset 等不受影响（它们早已用 package.json.name） | ✅ |
| B. 保留 normalizeExtName，bundled 源拼接 scope 补丁 | 打补丁让 key 对齐，clever 中间层（normalizeExtName）继续存在，是未来 bug 源 | 极小：`scanDirectory` 给 entry 拼 `@zhushanwen/` 前缀 | normalizeExtName 继续在 user/discovery 源制造潜在不一致；硬编码 scope 前缀不通用 | ❌ |
| C. deduplicate 后在 assembleExtensionInfo 按 name 二次去重 | 两层去重（normalizeExtName + name），语义冗余混乱 | 小 | 两套 key 语义并存，维护噩梦 | ❌ |

**被否若用 B**：FM2 会被「修好」（bundled 拼 scope 后 key 对齐），但 `normalizeExtName` 这个 clever 中间层还在，未来 user 源（`XYZ_EXTENSION_PATHS` 指向无 scope 目录）或第三方源仍可能踩同样的 scoped/unscoped 坑。A 直接砍掉中间层，结构上消除整类问题（准则 8 by construction）。

**选 A 的理由**：disabled key 和 ExtensionInfo.name 早已用 package.json.name，deduplicate 是唯一的不一致点。统一到 package.json.name 是消除不一致，而非引入新约定。

### 6.3 决策三：mandatory 包重复安装怎么防

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 安装入口拦截 + migrate 兜底历史**（选） | mandatory 语义完整闭环：不可卸载、不可禁用、**不可重复安装**。安装拦截是主动防御，migrate 是被动清理历史 | 小：`installExtension` 开头加 `isBuiltinExtension(pkgName)` 守卫抛 `ExtensionInstallError`；migrate 已存在（P-migrate-boot） | 无 | ✅ |
| B. 仅靠 migrate 重启清理 | 体验错（用户当下看到重复，重启后消失且困惑） | 零（现状） | 用户能不断装出重复副本，语义矛盾（FM3） | ❌ |

**选 A 的理由**：migrate 是给「旧版 npm 安装机制遗留」兜底的，不是给「当前安装流程」擦屁股的。安装拦截把问题挡在产生之前，migrate 继续负责历史遗留，两者职责清晰不重叠。

---

## 7. 实现机制（把终态落到代码层）

**三处改动，互相独立，可分别提交。**

### 7.1 改动一：dev 前置 prepare（对应决策一-A、G1）

`apps/electron/package.json` 的 `dev` 脚本前置 prepare：

```
"dev": "node scripts/electron-ensure.mjs && pnpm run prepare-builtin-extensions && concurrently \"pnpm run dev:vite\" \"pnpm run dev:electron\""
```

`prepare-builtin-extensions` script 已存在于 `apps/electron/package.json`（build 脚本已用），无需新增。prepare 产出目录 `apps/electron/resources/extensions/` 已被 `.gitignore` 忽略，不污染版本库。

### 7.2 改动二：去重 key 统一为 package.json.name（对应决策二-A、G2）

`extension-resolver.ts` 的改动：

1. **各 scan 方法的 key 来源**：从 `normalizeExtName(entry/pkgName/basename)` 改为读 `package.json.name`。
   - `scanNpmExtensions` / `scanSettingsExtensions`：pkgName 本就是预期 package.json.name，但严谨起见读实际 `package.json.name`（防 pkgName 与包内 name 不符）。
   - `scanBundledExtensions` / `scanThirdPartyExtensions`（经 `scanDirectory`）：遍历子目录时读子目录 `package.json.name`。
   - `scanUserExtensions`：读 `package.json.name`。
2. **`deduplicate`**：key 已是各源返回的 package.json.name，无需改算法（仍 first-write-wins by priority）。
3. **移除 `normalizeExtName`**：P-norm-callsites 确认仅 resolver 内部 6 处用，全替换后删除该函数。
4. **discovery 源不受影响**：`scanDiscoveryExtensions` 早已用 `canonicalizePath` 做 key（不用 normalizeExtName），与 package.json.name 是不同 key 空间，互不冲突。

> 边界：无 package.json 的扩展不存在于 npm/settings/bundled/third-party/user 源（`isValidPiExtension` 要求 package.json）。discovery 源支持无 package.json 的单文件入口，但它用 canonicalPath，不参与本次统一。故「读 package.json.name 做 key」对所有相关源安全。

### 7.3 改动三：mandatory 安装拦截（对应决策三-A、G2/G3）

`extension-service.ts` 的 `installExtension`，在 `isValidNpmPackageName` 校验之后、npm install 之前加守卫：

```ts
if (isBuiltinExtension(pkgName)) {
  throw new ExtensionInstallError(
    'builtin_already_installed',
    `Extension already built in: ${pkgName}`,
    '该扩展已随应用打包内置，无需单独安装。如需最新版，更新应用即可。',
  )
}
```

`isBuiltinExtension` 已从 `@xyz-agent/shared` 导入（`extension-service.ts` 已 import，`uninstallExtension` 用过）。

历史遗留（G3）由现有 `migrateBuiltinExtensions`（P-migrate-boot，boot 时执行）继续负责清理，无需新增迁移。

---

## 8. 验收（真实场景，非单测非 mock）

### 8.1 改动规模

中等（dev 启动流程 + 去重 key 语义 + 安装拦截三处独立改动，涉及运行时数据流）。验收投入：多场景。

### 8.2 验收场景

| 场景 | 回溯 §2 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| V1 版本一致 | G1 | 改 `extensions/ask-user/package.json` version 为一个明显标记值（如 9.9.9），`pnpm dev` 启动，看 Settings → Extensions 里 pi-ask-user 的版本 | 显示 9.9.9（=源码），不再是陈旧快照 |
| V2 mandatory 安装拦截 | G2 | dev 运行中，在 Extensions npm 安装框输入 `npm:@zhushanwen/pi-ask-user` 安装 | 立即报「已内置」错误（assistant 消息），「已安装」不增加条目 |
| V3 普通扩展正常安装 | G2（不误伤） | npm 安装一个非 mandatory 的真实 pi 扩展包 | 正常安装，「已安装」增加一份，无重复 |
| V4 去重 key 统一无副作用 | G2 | dev 启动后看「已安装」列表所有 builtin 包各只一份；禁用/启用一个 feature builtin（如 pi-goal），重启 dev 后禁用状态保持 | 每个包一份；禁用状态跨重启保持（验证 disabled key 仍用 package.json.name，未受去重改动影响） |
| V5 历史自愈 | G3 | 先人为在 `settings.json` packages[] 塞一条 `npm:@zhushanwen/pi-goal`（模拟历史遗留），重启 dev | 重启后该条目被 migrate 清理，「已安装」只剩内置一份 pi-goal |

> 验收用真实 dev 环境（`pnpm dev` + 真实 pi 子进程 + 真实 `~/.xyz-agent/` 数据目录），不 mock。V3 需要一个真实的非 mandatory pi 扩展包名（可用 npm registry 上任一 `keywords: ["pi-package"]` 的包，或 dev-link 一个本地扩展后用其包名）。
> 单元测试（deduplicate key 一致性、installExtension 拦截分支）作为回归辅助，不计入验收。

---

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | 改动二（去重 key 统一）+ 单测 | G2 的去重正确性（V4） |
| M2 | 改动三（安装拦截） | G2 的拦截（V2、V3） |
| M3 | 改动一（dev 前置 prepare） | G1（V1） |
| M4 | 验收 V1-V5 全过 | G1/G2/G3 整体验证 |

M1/M2/M3 互相独立，可并行开发、分别提交。M1 先行（去重正确是基础），M2 次之（拦截依赖 mandatory SSOT 已就位），M3 最后（dev 流程改动影响面最广）。

---

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| unit-1 deduplicate key 重构 | `extension-resolver.ts` 各 scan 方法 key 改 package.json.name + 删 normalizeExtName + deduplicate 对齐 | 去重正确性是 G2 的结构基础，独立可验（V4） |
| unit-2 installExtension 拦截 | `extension-service.ts` 加 isBuiltinExtension 守卫 + ExtensionInstallError | 防御层独立于去重，可单独验（V2、V3） |
| unit-3 dev 前置 prepare | `apps/electron/package.json` dev 脚本加一步 | dev 流程改动，影响所有 dev 启动，独立验证（V1） |

---

## 11. 待验证检查点

| ID | 待验证项 | 验证时机 | 当前状态 |
|---|---|---|---|
| ⛔ P-symlink | 决策一方案 B（dev 读源码）的 pnpm symlink + native addon 加载行为 | 已放弃方案 B，无需验证 | N/A（仅记录为何不选 B） |
| ⛔ V3-fixture | V3 验收需要一个真实非 mandatory pi 扩展包名 | 实施期确认 npm registry 上可用的候选 | 待定 |
| ✅ P-prepare-time | prepare 全量耗时 | 已实测 1.067s | 通过 |
| ✅ P-norm-callsites | normalizeExtName 影响面 | 已确认仅 resolver 内部 | 通过 |
| ✅ P-disabled-key | disabled key 语义 | 已确认用 package.json.name | 通过 |
| ✅ P-migrate-boot | migrate 调用时机 | 已确认 boot 调用 | 通过 |

---

## 附录：变更历史

- v1：首次创建。基于对 `extension-service.ts` / `extension-resolver.ts` / `prepare-builtin-extensions.sh` 的代码阅读 + 实测探针（版本对比、prepare 耗时、normalizeExtName 调用点、migrate 调用点）。
