---
wave: W02
phase: P0
cases: simple×3
deps: []
est: 8min
va_ref: VA-01 #6-13
---

# W02 · P0 radius / 字体 / 主题 / shadcn 装机

> 3 个简单 case：radius + 字体/暗色默认 + shadcn/lint。结构 + 配置核对，无视觉交互。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/design-tokens.md` | radius / 字体 SSOT（L45-47, L67） |
| `$ROOT/src-electron/renderer/tailwind.config.ts` | 待验：borderRadius / fontFamily 映射 |
| `$ROOT/src-electron/renderer/src/style.css` | 待验：radius 变量 + 暗色默认 |
| `$ROOT/src-electron/renderer/components.json` | 待验：shadcn-vue 配置（renderer workspace 根） |
| `$ROOT/src-electron/renderer/src/components/ui/` | 待验：shadcn 原子目录 |

## 前置

- 无（与 W01 同属 P0，可并行）。

## Cases

### Case 1（simple）· radius 三档 + tailwind 映射

**检查方法**：

a) DevTools Console：
```js
['--radius-sm','--radius','--radius-lg']
  .map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])
```
期望：`3px` / `8px` / `12px`（design-tokens.md L45-47 + ADR D5）。

b) `cat $ROOT/src-electron/renderer/tailwind.config.ts` 查 `borderRadius`：
期望 `sm: '3px'`（或 var 映射）、`DEFAULT: '8px'`、`lg: '12px'`。

**PASS**：CSS 变量 3 值 + tailwind 映射均匹配。

### Case 2（simple）· Inter 字体 + 暗色为真默认

**检查方法**：

a) DevTools Console：
```js
getComputedStyle(document.body).fontFamily
```
期望：含 `Inter`（首位）。

b) 暗色默认（ADR-0021）——**项目无主题切换层**（无 settingsStore / theme state / `data-theme` / class 切换），`:root` 在 style.css 硬编码暗色 CSS 变量。这是比 class 切换更彻底的暗色默认——**无亮色代码路径 = 物理不可能闪烁**。验证：
```js
JSON.stringify({
  bodyBg: getComputedStyle(document.body).backgroundColor,  // 期望 rgb(13,13,15) = #0d0d0f
  htmlClass: document.documentElement.className,             // 期望 "" （无主题 class）
  htmlDataTheme: document.documentElement.getAttribute('data-theme')  // 期望 null
})
```

c) 若怀疑闪烁：刷新窗口（⌘R）多次，观察首帧是否瞬现亮色（架构上不可能，因无亮色分支）。

**PASS**：Inter 应用 + body bg `#0d0d0f` + html 无主题 class/attr（证明暗色为硬编码真默认，非切换态）。

### Case 3（simple）· shadcn 装机 + 断链清理 + tsc/lint

**检查方法**（bash）：

```bash
# shadcn 配置 + 原子目录（components.json 在 renderer workspace 根）
ls $ROOT/src-electron/renderer/components.json $ROOT/src-electron/renderer/src/components/ui/

# 断链 symlink（预期空结果）
find $ROOT/src-electron/renderer/src/composables \( -name '*.test.ts' -o -type l \)

# typecheck：用项目标准命令（对齐 CI ci.yml + README + standards.md）
# renderer 是独立 workspace，vue-tsc 仅在此 workspace，不在 root
cd $ROOT && npm -w @xyz-agent/frontend run typecheck

# lint（root 聚合）
cd $ROOT && npm run lint
```

**期望**：
- `components.json` 存在（renderer workspace 根）；`components/ui/` 目录存在且非空（至少含 Button/Input 等基础原子）。
- find **无输出**（无断链 symlink；spec/plan 提到的旧 symlink 当前已不存在，若重现需删除）。
- typecheck + lint 零错（typecheck exit 0；lint exit 0）。

**注**：原 wave 写 `cd $ROOT && npx vue-tsc --noEmit` 有误——root 无 vue-tsc 依赖（workspace 隔离），正确命令是 `npm -w @xyz-agent/frontend run typecheck`（CI/README/standards 均如此）。

**PASS**：4 项全绿。

## 执行步骤

1. `cd $ROOT && npm run dev`，DevTools 验 Case 1a / 2a / 2b。
2. `cat tailwind.config.ts` 验 Case 1b。
3. bash 跑 Case 3 三组命令。

## FAIL 判定

- radius 非三档 / tailwind 映射错 = FAIL（ADR D5）。
- 暗色闪烁 = FAIL（ADR-0021）。
- `components.json` 或 `ui/` 缺失 = FAIL（shadcn 未装机，P0 未完成）。
- tsc / lint 任一报错 = FAIL（spec §6.5）。
- PASS 后进 W03 / W04（P1 Shell，可并行）。
