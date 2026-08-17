# 设计文档审查报告 — extension-version-dedup/design.md

> **审查方式说明**：本应派 `tech-design-review` subagent 做独立对抗式审查，但当前环境未暴露 subagent 派发工具（工具列表无 `subagent` 入口，虽 `available_subagents` 列出了该 agent）。按"失败要出声"原则如实记录，改为由主 agent 严格按 `review/rubric-design-doc.md` 对抗式自审：默认怀疑、主动找反例、核实关键事实（read 源码 + 实测）。审查与修复分离——本报告只给 must-fix/suggestion，不改 design.md。

## Summary

**2 must-fix, 4 suggestions.** 文档整体结构完整、方案对比充分、验收真实可测，P0 结构/可读性/主线/对比/探针/数据流/错误恢复项均通过。两个 must-fix 集中在**方案间的隐含依赖**和**实现边界遗漏**——都是对抗式审查逼出来的真实反例，非格式问题。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §6.2 / §9 | P0-10 对抗 / P0-12 副作用 | **决策二（去重 key 统一）对决策三（安装拦截）有隐含依赖，文档未明确**。已核实：`PRIORITY_ORDER` 中 `settings`(索引3) > `bundled`(索引5)，`deduplicate` first-write-wins。若只做决策二不做决策三，用户 npm 装 mandatory 包后，deduplicate 保留 settings 源、吞掉 bundled 源，`assembleExtensionInfo:339` 把 source 标为 `user-installed`——产生一个 **source=user-installed 但 tier=feature(mandatory) 的矛盾条目**（不可卸载却显示为用户安装），直到重启 migrate 清理 packages[] 才自愈。§9 实施顺序 M1(去重)先于 M2(拦截)，在两者之间的窗口期会暴露此矛盾 | 文档明确"决策三必须先于或与决策二同 commit"；调整 §9 顺序为 M2→M1 或合并为一个原子提交；在 §6.2 决策二说明里加一句"依赖决策三：拦截未生效时，去重会让 mandatory 包被 settings 源覆盖" |
| MUST_FIX | §7.2 | P0-12 副作用 | **去重 key 改为 package.json.name 时，name 缺失/非 string 的 fallback 未说明**。`resolveExtension`（extension-filter.ts）已有 `typeof meta.name === 'string' ? meta.name : basename(dir)` 守卫，但决策二改的是 `deduplicate` 层各 scan 方法的 key。若 scan 方法直接用 `meta.name` 不加守卫，畸形 package.json（name 缺失）会让 key=`undefined`，所有此类扩展共享一个 key 互相覆盖 | §7.2 明确"各 scan 方法复用 resolveExtension 的 typeof 守卫，name 缺失/非 string 时 fallback `basename(dir)`"，与 disabled key / ExtensionInfo.name 的推导保持一致 |
| SUGGESTION | §4.2 | P0-11 事实完整性 | 数据流只画了 bundled + settings 两源。开发模式 `scanNpmExtensions` 确实返回空（已核实 apps/electron/package.json 无 `@zhushanwen/pi-` 依赖），不画是对的，但未自证完整，reviewer 可能质疑"npm 源去哪了" | §4.2 数据流下补一句"npm 源开发模式为空（apps/electron 无 @zhushanwen/pi- 依赖），故仅画 bundled + settings 两源" |
| SUGGESTION | §7.1 / §11 | P0-12 副作用 | `prepare-builtin-extensions` script 实际是 `bash ../../scripts/prepare-builtin-extensions.sh`（已核实），dev 前置后 Windows 需 bash（git bash/WSL）。这是既有行为（build 脚本已用），非本次新引入风险，但文档未注明平台假设 | §7.1 或 §11 补一句平台假设"prepare 依赖 bash，Windows 需 git bash/WSL（与 build 流程一致）" |
| SUGGESTION | §7.2 | P0-12 副作用 | 打包模式 `scanNpmExtensions` 改 key 后，entry 的 key 从 `normalizeExtName('pi-ask-user')='ask-user'` 变为 `package.json.name='@zhushanwen/pi-ask-user'`。这是预期的行为变化，但需确认无其它代码依赖旧的 `'ask-user'` 形态 key | 实施期 grep 确认打包模式无硬编码 `'ask-user'` 等无 scope key 的消费方；文档 §11 待验证检查点补一条 |
| SUGGESTION | §7.2 | P0-12 副作用 | preset `extensionMode` 的 allowlist/denylist 用 `resolveExtension.name`（已是 package.json.name，P-disabled-key 确认）。决策二只改 deduplicate key、不改 resolveExtension.name，preset 不受影响——但文档未明确声明这点，reviewer 需自行推导 | §7.2 补一句"preset allowlist/denylist 匹配用的是 resolveExtension.name（已是 package.json.name），本次只改 deduplicate key，preset 管控不受影响" |

## 判定明细（P0 逐项）

| 准则 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | §1-2 背景/目标、§3-4 现状/根因、§5-7 解决方案、§8 验收、§9-10 拆分，五段俱全 |
| P0-2 无 delta 链 | 通过 | 正文无 vN/Rxx-finding 引用；变更历史降附录一句话 |
| P0-3 结论先行 | 通过 | 标题下结论 + SCQA 开篇；抽查 §4/§6/§7 首句均为该章结论 |
| P0-4 现状触根因 | 通过 | §3 现象 + §4 根因挖到 normalizeExtName / staged 不刷新，有真实版本表 |
| P0-5 使用者视角主线 | 通过 | §3 用开发者/用户视角；实现机制 §7 在使用者视角之后 |
| P0-6 术语锚定 | 通过 | staged 快照/去重 key/内置扩展均定义 + 绑例子 |
| P0-7 方案对比 ≥2 | 通过 | 三个决策各 ≥2 方案 |
| P0-8 长期+短期双维度 | 通过 | 每方案三栏（长期架构/短期成本/风险） |
| P0-9 明确推荐 | 通过 | 每决策 ✅ 选定 + 理由 + 被否方案影响 |
| P0-10 方案解决目标 | **部分不通过** | G2 因果链有隐含依赖（见 MUST_FIX 1）：决策二单独实施产生 source/tier 矛盾条目 |
| P0-11 关键事实正确 | 通过（含建议） | resolver.ts:215/457、index.ts:188、prepare 1.067s 均核实无误；npm 源空缺可补说明（SUGGESTION） |
| P0-12 副作用/遗漏 | **不通过** | 见 MUST_FIX 1（决策依赖）+ MUST_FIX 2（name fallback）+ 3 条 suggestion |
| P0-13 验收可测试 | 通过 | V1-V5 有明确通过标准、回溯目标、真实环境 |
| P0-14 非单测/mock | 通过 | 明确"不 mock"；V3 真实包待定已诚实标注 |
| P0-15 验收投入匹配 | 通过 | 中等改动 5 场景，充分 |
| P0-16 运行时断言探针 | 通过 | §4.1/§4.2 探针表，✅ 实测 + ⛔ 待验证齐备 |
| P0-17 物理数据流图 | 通过 | §4.1/§4.2 各一图，标路径 + 行号 |
| P0-18 错误恢复指引 | 通过 | §5.2 失败表每项配具体恢复命令 |

## 结论

文档设计质量良好，方案选型（减法优先废弃 normalizeExtName、dev 前置 prepare 保持同源、安装拦截 + migrate 兜底）长期架构合理。两个 must-fix 都是"方案正确但实施细节/依赖未交代清"，修复成本低（补说明 + 调实施顺序），不推翻方案。修完后可进入实施。
