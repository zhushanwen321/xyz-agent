# P6 残留删除清单（residual-deletion inventory）

> 所属：`wave:renderer-rebuild-v2::p6-cleanup::residual-deletion::w1-inventory-and-marking`（w1：盘点 + 废弃标记模板）
> 状态：**盘点完成，物理清理待前置（P1-P5）就位**。本清单是 w2（物理清理）与 w3（AC1 判定）的交接契约。
> 依据：renderer-rebuild-architecture.md §10（旧层 → 新架构映射表）+ §11.4（验收基准）+ feature 层 clarify（FR1/AC1，取 (a)+(b) 合并决议）。
> 实测日期：2026-08-03（当前基线：P1-P5 全部未执行，旧 `packages/renderer` 单包是唯一活跃前端）。

## 摘要

- 5 类候选全部实测：**2 类活跃（observe）、3 类不存在（not-exist）、0 类孤儿（orphan）**
- 当前基线无物理孤儿可删：旧包全部文件仍被 dev 构建活跃使用（P1-P5 未执行）
- 废弃标记（C2 格式）当前降级为**模板**（见 §3），前置就位后由 w2 对真孤儿落地
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

1. 前置检查：新四包（core/ui/renderer/mobile-renderer）可 build、旧包无活跃引用；否则记 `blocked-pending-prereq` 上抛 epic（决策 D1/D4），禁止假验证
2. 按本清单逐类复查：本次盘点为 not-exist 的 3 类（stores/composables index、shim、sync 脚本）删除动作 no-op；api-wrapper 与 vite-main-entry 由 active 转判后按新状态处理
3. 对确认孤儿且零引用的文件：落地 §2.1 模板 → `rm` 前 grep 复核零引用（IF1/ES2）
4. 仍被过渡引用的文件：仅保留废弃标记不删除

### 3.2 w3：AC1 判定核对（dependsOn w2 + P1-P5）

- TC-3：grep 新四包（core/ui/mobile-renderer）零 import 旧 `packages/renderer/src` 路径
- TC-4：双端 `pnpm build` 无死代码/孤儿 import 警告
- 结果补记回本文档（AC1 pass/fail + 证据）；前置未就位记 `blocked-pending-prereq`，不做假验证（ES1）
