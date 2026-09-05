# 审查报告：release-artifact-size-optimization.md（r2 定向复审）

> 2026-09-05。范围：只验证 r1 两条 must_fix 的修复是否成立 + 确认 3 条 suggestion 落实情况，不做全文重审。事实交叉验证：`apps/electron/package.json`（当前无 node-pty 直接依赖，与文档前提一致）、`packages/runtime/package.json:25`（`node-pty: ^1.0.0`，版本对齐声明属实）、`apps/electron/electron-builder.yml:32-34,56-59`（files 白名单 + asarUnpack node-pty 条目存在）、`node_modules/app-builder-lib`（26.15.3）。

## Summary

0 must-fix, 1 suggestion.

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | impl-plan §0:14 | P1-8 事实细节 | 章节映射「待验证检查点」仍写「S4 冒烟」，但设计 §4.1 已无 S4（pnpm dev 场景已删，改为 S1.5），悬空引用 | 改为「S1.5 冒烟」 |

## 逐条核验

### must_fix-1（node-pty 传递收集路径断裂）——PASS

- 设计 §3.3:52 **[r1 审查新增]** 段落完整成立：明确「node-pty 必须显式新增进 dependencies（`^1.0.0`，对齐 `packages/runtime/package.json`）」，且机制表述准确——「files 白名单只能在已收集模块内过滤、不能强制纳入未收集的包（实装 appFileCopier.js computeNodeModuleFileSets 仅遍历 prod 依赖树）」，与 r1 实测证据链一致。版本声明经核实：runtime `^1.0.0`（runtime/package.json:25），apps/electron 当前确无 node-pty 直接依赖（修复前提成立）。
- §6 u4:107 与 impl-plan §2 u4:33 同步含「新增 node-pty 显式依赖（^1.0.0，对齐 runtime）」，领地含 `apps/electron/package.json、pnpm-lock.yaml`；impl-plan §7 变更历史:87 亦登记该修复。u4 验收条款含「unpacked 存在 node-pty 的 pty.node/spawn-helper」静态断言，S1:73 亦有同款断言。
- 对抗复核：未发现残留的「不动 node-pty」旧表述（r1 指出的原句已替换）。

### must_fix-2（打包产物启动验收缺口）——PASS

- 设计 §4.1:74 新增 S1.5：build:dir 产物真实启动（`open ... --args --remote-debugging-port=9222` + browser-automation），通过标准覆盖启动不白屏 / 聊天收发 / pty 终端（node-pty 最敏感面）/ shiki 高亮 / mermaid 渲染，均为真实场景断言，非单测非 mock；还标注了打包版 3210 端口冲突的实操注意（`lsof -i :3210`）。
- 原 S4（pnpm dev）已从 §4.1 场景表**整体移除**（现表为 S1 / S1.5 / S2 / S3 / S5 / S6），pnpm dev 不再承担任何验收。
- impl-plan 同步：§2:35 冒烟条款（u4 committed 后主 agent 执行 S1.5，含全部五项检查点）、§3 DAG:46（u4 → smoke → review）、§4 测试策略:62（收尾全量含 S1.5）、§6 状态表:80（冒烟 S1.5 独立行）。职责归属明确（冒烟不属于开发单元，主 agent 执行）。

### suggestion 落实确认（3/3）

| r1 suggestion | 状态 | 证据 |
|---|---|---|
| 包数统一「5 迁移 + 1 新增」、消掉「四白名单包」 | 落实 | §3.3:54「本批 5 包迁移」；§6 u4:107「新增 node-pty + 5 依赖挪 devDependencies」；全文已无「四白名单包」指代 |
| alternatives 记录（devDeps 迁移 vs files 白名单全收集） | 落实 | §3.3:54 完整段落：维护成本对比（手动同步 vs 包管理器语义自动保证）+ 可独立回滚 + §5 后续项登记 |
| 行号与数字精确化（131-133 / 133-139 / 8.5M） | 落实 | §3.2:41 `verify-ci-release.sh:131-133`；§3.1:35 `appFileCopier.js:133-139`；§3.1:43 与 §2:23 均为「.map 合计 8.5M」 |

## 结论

must_fix: 0

两条 r1 must_fix 均已修复成立且文档/实施计划双向同步；唯一残留为 impl-plan 一处 S4 悬空标签（S1 建议，不阻断实施）。
