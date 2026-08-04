# P6 残留删除清单（residual-deletion inventory）

> 所属：`wave:renderer-rebuild-v2::p6-cleanup::residual-deletion::w1-inventory-and-marking`（w1：盘点 + 废弃标记模板）
> 状态：**w2 物理清理已执行（2026-08-04）**：5 个 discovered-orphans 已删 + 1 个测孤儿的残留测试随源码删；w1 的 5 类候选复核（api-wrapper/vite-main-entry 仍 active 不删，3 类 not-exist no-op）。剩余旧包大规模清理由后续 P1-P5 各域绞杀完成后统一处理。
> 依据：renderer-rebuild-architecture.md §10（旧层 → 新架构映射表）+ §11.4（验收基准）+ feature 层 clarify（FR1/AC1，取 (a)+(b) 合并决议）。
> 实测日期：2026-08-03（w1 盘点）/ 2026-08-04（w2 物理清理）。

## 摘要

- 5 类候选全部实测：**2 类活跃（observe）、3 类不存在（not-exist）、0 类孤儿（orphan）**
- w2（2026-08-04）basename 全量扫描 + 同名排查，新发现并删除 **5 个 discovered-orphans**（P1-P5 逐域绞杀迁移后的 composables 残留，详见 §1.2）
- 旧包核心仍活跃（api/index.ts 实测 32 引用、main.ts/App.vue dev 入口），剩余大规模清理由 P1-P5 各域绞杀完成后统一处理
- 废弃标记（C2 格式）当前降级为**模板**（见 §3），对剩余活跃文件不实际落地（避免噪音）
- AC1 判定（grep 零新 import + 双端 build 无警告）由 w3 执行，前置未就位时记 blocked-pending-prereq（ES1）

## 1. 清理清单（DM1 格式）

| category | path | refStatus | refCount | disposal | newHome（§10 映射） |
|---|---|---|---|---|---|
| `api-wrapper` | `packages/renderer/src/api/index.ts`（含 `api/` 目录：domains/events/mock/pending/request/transport） | active | 34 | observe | `core/transport/` 原样继承（§10.1：`api/transport.ts`/`pending.ts`/`events.ts`/`request.ts`/`domains/*`） |
| `stores-composables-index` | `packages/renderer/src/stores/index.ts` | not-exist | 0 | 记录即完 | `core/domain/*`（§10.2） |
| `stores-composables-index` | `packages/renderer/src/composables/index.ts` | not-exist | 0 | 记录即完 | `core/domain/*`（§10.2） |
| `vite-main-entry` | `packages/renderer/src/main.ts` + `packages/renderer/index.html` | active | —（dev 入口，IF1 不算孤儿） | observe | `renderer/src/`（桌面壳，§10.3） |
| `shim` | `*shim*` / `*.bak` / `*.old`（全仓库） | not-exist | 0 | 记录即完 | 无 |
| `sync-script` | `scripts/sync-mobile-from-renderer.sh` | not-exist | 0 | 记录即完（§10.3 删除项已不存在，w2 删除为 no-op） | 无（§11.4 验收基准已含「sync 脚本已删除」） |

**联动规则**（DM1 notes）：`active → observe`（P1-P5 后复查改判定）、`orphan → delete`、`not-exist → 记录即完`、`watch（P1-P5 后复查）→ deprecate 或 delete 待定`。

### 1.2 discovered-orphans（w2 新增，2026-08-04 实测删除）

w2 对 renderer/src 全量 basename 末段扫描（静态 import `from '.../<name>'` + 动态 import `import('.../<name>')` + 任意出现 grep 三重验证）+ 同名文件排查（renderer/src 重复 basename 均为不同功能文件，无同名孤儿漏报），定位 P1-P5 逐域绞杀迁移后产生的 5 个零引用孤儿。生产代码（renderer src，排除 __tests__）零引用，已迁移到新包对应物，w2 物理删除：

| path | refStatus | refCount（生产）| disposal | newHome（迁移对应物）| 删除结果 |
|---|---|---|---|---|---|
| `composables/panel/useTurnActions.ts`（128 行） | orphan | 0 | delete | Turn.vue fork/handoff handler，随 chat 组件迁移 ui/features/chat | ✅ 已删 |
| `composables/panel/staging-types.ts`（138 行） | orphan | 0 | delete | `core/domain/composer/types.ts`（注释逐字佐证） | ✅ 已删 |
| `composables/panel/useRunInTerminal.ts`（36 行） | orphan | 0 | delete | Block.vue bash 运行按钮，随 panel 组件迁移 | ✅ 已删 |
| `composables/new-task/useNewTaskBranch.ts`（153 行） | orphan | 0 | delete | `core/domain/new-task-search/branch.ts`（注释逐字佐证） | ✅ 已删 |
| `composables/new-task/useNewTaskDirSelect.ts`（160 行） | orphan | 0（生产）| delete | `core/domain/new-task-search/dir-select.ts`（逐字迁移 isBare 实现 + dir-select.test.ts 完整覆盖） | ✅ 已删 |

**连带删除**：`__tests__/new-task/landing-isbare-pending-cwd.test.ts`（动态 import 被删的 useNewTaskDirSelect，测的 isBare 行为已由 core `dir-select.test.ts` TC-10g/h/i 完整覆盖，属测孤儿的旧域残留测试，随源码删，零覆盖损失）。

**剩余风险（w3 兜底）**：basename 静态/动态 import 扫描对「相对路径 re-export 经 index 桥接」与「字符串拼接路径」存在理论盲区，剩余不可见孤儿由 w3 AC1 双端 `pnpm build` 无死代码/孤儿 import 警告兜底（§11.4）。

### 1.1 实测证据（T0 复核命令）

```bash
# api/index.ts 引用计数（34 个文件直接 import，排除自身 + __tests__）
grep -rn "from ['\"].*api['\"]\|from ['\"].*api/index['\"]" packages/renderer/src --include="*.ts" --include="*.vue" \
  | grep -v "src/api/index.ts" | grep -v "__tests__" | awk -F: '{print $1}' | sort -u | wc -l   # → 34

# stores/composables 无 index.ts
ls packages/renderer/src/stores/index.ts packages/renderer/src/composables/index.ts   # → No such file or directory

# shim 零命中
find packages/renderer -iname "*shim*" -o -iname "*.bak" -o -iname "*.old"   # → 无输出

# sync 脚本不存在
find . -name "sync-mobile*" -not -path "*/node_modules/*"   # → 无输出（scripts/ 下确认无此文件）
```

## 2. 废弃标记模板（C2 格式）

当前基线（P1-P5 未执行）**不实际给活跃文件加注释**——旧包 699 文件仍被 dev 构建使用，加注释是噪音且违反「认知外改动零触碰」。前置就位后，w2 对确认的孤儿文件落地以下模板：

### 2.1 单文件头注释模板

```ts
// DEPRECATED: 旧 renderer 单包残留（见 docs/architecture/p6-residual-deletion-inventory.md；新归位见 renderer-rebuild-architecture.md §10 映射表）
```

- grep `DEPRECATED` 可命中（TC-2）
- 仅对 `refStatus=orphan` 且确认零引用的文件落地（IF1 双步判定：ls 存在 + grep 零 import，排除自身与 `__tests__`）
- 仍在过渡引用的文件（P5 双壳切换未完全完成）**只标记不删除**（ES2 / feature clarify #2 决议）

### 2.2 目录级 README 兜底模板

```markdown
# DEPRECATED: 本目录为旧 renderer 单包残留（见 docs/architecture/p6-residual-deletion-inventory.md）
# 新归位见 renderer-rebuild-architecture.md §10 映射表。物理清理待 P1-P5 就位后按清单执行。
```

## 3. 前置就位后的复查动作（w2/w3 交接契约）

### 3.1 w2：物理清理（dependsOn P1-P5 产物就位）

**执行结果（2026-08-04）**：

1. 前置检查结论：新四包（core/ui/renderer/mobile-renderer）src 均已就位（P1-P5 并行推进）；旧包核心仍活跃（api/index.ts 实测 32 引用、main.ts/App.vue dev 入口），前置「旧包无活跃引用」**部分满足**——不满足整包删除条件，但已产生 5 个零引用孤儿可安全删。未达 blocked-pending-prereq（有可安全删除的孤儿），按 §1.2 discovered-orphans 执行删除（ES1 不假删整包）
2. 按 w1 清单逐类复查：3 类 not-exist（stores/composables index、shim、sync 脚本）确认仍 not-exist，删除 no-op；api-wrapper（api/index.ts 32 引用）与 vite-main-entry（main.ts/App.vue）仍 active，disposal=observe 不删
3. discovered-orphans 5 项：basename 三重验证零引用 → git rm 前 grep 复核（含动态 import）零命中（IF1/ES2）→ 物理删除 → 全仓 grep 零残留确认
4. 仍被过渡引用的文件（api/index.ts 等 active 文件）：保留不删，disposal=observe 待 P1-P5 完全就位后由后续清理统一处理

**未删除项说明**：alias 路径零引用的 components/panel/* 等经核实为相对路径 import 误报（Panel.vue/Composer.vue 等活跃组件），非孤儿，不删（ES1）。

### 3.2 w3：AC1 判定核对（dependsOn w2 + P1-P5）

- TC-3：grep 新四包（core/ui/mobile-renderer）零 import 旧 `packages/renderer/src` 路径
- TC-4：双端 `pnpm build` 无死代码/孤儿 import 警告
- 结果补记回本文档（AC1 pass/fail + 证据）；前置未就位记 `blocked-pending-prereq`，不做假验证（ES1）
