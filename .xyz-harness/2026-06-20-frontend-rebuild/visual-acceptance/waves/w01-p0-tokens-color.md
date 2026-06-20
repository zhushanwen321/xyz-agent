---
wave: W01
phase: P0
cases: simple×3
deps: []
est: 5min
va_ref: VA-01 #1-5
---

# W01 · P0 色值与文本色阶

> 3 个简单 case：DevTools computed style 核对色值。无需启动 mock。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/design-tokens.md` | **色值 SSOT**（L11-30 原子值表） |
| `$ROOT/src-electron/renderer/src/style.css` | 待验：CSS 变量落地 |

## 前置

- 无（P0 起点）。
- 启动：`cd $ROOT && npm run dev`（Electron 窗口）。

## Cases

### Case 1（simple）· 画布 + 主色 + accent 变体

**检查方法**：Electron DevTools Console 执行：
```js
['--bg','--accent','--accent-hover','--accent-soft','--accent-ring']
  .map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])
```

| 变量 | 期望（design-tokens.md SSOT） |
|------|------------------------------|
| `--bg` | `#0d0d0f` |
| `--accent` | `#4f8ef7` |
| `--accent-hover` | `#6ba3ff` |
| `--accent-soft` | `rgba(79, 142, 247, 0.12)` |
| `--accent-ring` | `rgba(79, 142, 247, 0.30)`（SSOT design-tokens.md，Card-Active 内描边色值；注意与 `--shadow-glow` 不同，后者是 box-shadow 整句 25%） |

**PASS**：5 值全部匹配。

### Case 2（simple）· 语义色 4 项

**检查方法**：Console：
```js
['--success','--warning','--danger','--info']
  .map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])
```

| 变量 | 期望 |
|------|------|
| `--success` | `#22c55e` |
| `--warning` | `#f5a524` |
| `--danger` | `#ef4444` |
| `--info` | `#38bdf8` |

**PASS**：4 值匹配。**注**：draft HTML 若用旧值（如 `#34d399`）不作基准（spec G-008），只以 design-tokens.md 为 SSOT。

### Case 3（simple）· 文本色阶 3 级

**检查方法**：Console：
```js
['--fg','--muted','--subtle']
  .map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])
```

**期望**（design-tokens.md + ADR-0018 归一裁决）：3 个变量全部存在且非空（`--fg` 最亮、`--subtle` 最暗，呈色阶递减）。**禁止旧名 `--text-primary`/`--text-secondary`/`--text-tertiary`**（ADR-0018 已归一为 `--fg`/`--muted`/`--subtle`）。

**PASS**：3 变量存在，`--fg` = `#f0f0f5`、`--muted` = `#8a8a95`、`--subtle` = `#5a5a65`。

**注**：原 wave 要求的 `--text-disabled` 已删除——SSOT 未定义、组件代码与 draft 均未使用（YAGNI）；如未来 disabled 语义有实际使用再补 SSOT。

## 执行步骤

1. `cd $ROOT && npm run dev`。
2. Electron 窗口开 DevTools（⌘⌥I）。
3. Console 依次跑 Case 1/2/3 的脚本，对照期望表。
4. 若变量缺失或值不符 → 在 `style.css` 查 token 定义。

## FAIL 判定

- 任一变量缺失 / 值不符 = FAIL。
- PASS 后可并行进 W02（同属 P0）。
