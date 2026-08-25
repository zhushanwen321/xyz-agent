# Plan: 对话流视觉优化（chat-visual-font-optimize）

> lite 计划 · 2026-08-25 · 权威设计文档：`.tmp/xyz-agent-font-optimize-design.md`（对抗式审查 5M+6S 已修复 + 用户二轮确认）

## 业务目标

- G1 文字有「Mac 原生重量感」：删 font-smoothing 削薄，暗色下正文不再偏细发虚
- G2 中英混排均匀：系统字体栈（system-ui + 苹方/雅黑/Noto）替换 Inter，SF Pro + 苹方成对混排；含 tailwind-preset/mobile-renderer/v6 文档全量同步，消灭第二份硬编码栈
- G3 折叠头一眼读到命令主体：shortenForHeader 展示层截短（`…/末两段`），展开态/复制全量不变（信息零丢失）
- G4 非展开 block 是「活」的单行（用户明确期望）：thinking preview + tool 折叠头在 streaming/running 中双轴尾部追踪——行内文字左滑（横向）+ 换行平滑上滚（纵向），完成后回落静态摘要
- G5 表格与代码块容器语言一致：四角圆角化（--radius 档）
- G6 改动可回归：token SSOT 同步 + 单测 + 真实场景验收（Playwright）

## 技术改动点

1. **D1** 删 `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`（style.css:326-327）
2. **D2** `--font-sans` 改 `system-ui, 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`；删 `@fontsource-variable/inter`（import + 依赖 + lock）；tailwind-preset `fontFamily.sans` 改 `['var(--font-sans)']`；mobile-renderer tokens.css:66 字面同步；v6-master-spec §4.6 + v6-tokens.css:57 同步 + supersede ADR-0019 标注；ADR-0019 Inter 行括注；index.html :9/:20 注释更新；design-tokens.md 历史追溯同步
3. **D3** `format-utils.ts` 新增 `shortenForHeader`（①`$HOME` 前缀→`~` ②段数 ≥3 绝对路径→`…/末两段` ③其余不动）+ `tailLines`（尾部 N 行窗口）；`Block.vue:111` header span 接入（:131 展开态 / :305 copyContent 不动）
4. **D4** 新增 `composables/useTailScroll.ts` 双轴尾部追踪 composable（视口 1 行高 overflow hidden；内容尾部 3 行 nowrap 窗口；纵向 `translateY` 钉最新行 + `transition var(--duration-fast)`；横向 `scrollLeft = scrollWidth` rAF 即时钉右；reduced-motion 纵向自动降瞬移；降级开关纯尾行 slice）；Block.vue 双接入：:25 thinking preview（streaming 尾部行窗口 / 完成态头部 60 字符现状）+ :111 tool 折叠头（running 显输出尾行：bash 用 outputRaw 去 ANSI 尾行、其余 displayContent 尾行 / 完成态回落 shortenForHeader(argPath)；无流式输出工具退化静态 argPath）；顺带修正 :208 props docstring 与实现矛盾
5. **D5** MarkdownRenderer.vue:378-398 表格样式段：`.md-table-wrap` 加 `border: 1px solid var(--border)` + `border-radius: var(--radius)` + 保留 `overflow-x: auto`；`table` 改 `border-collapse: separate; border-spacing: 0`；th,td 只画内线（右+下），末列去右、`tbody tr:last-child` 去下

## Wave 拆分

| Wave | 改动文件 | 依赖 | 并行组 |
|---|---|---|---|
| W1 | packages/renderer/src/style.css, packages/renderer/src/main.ts, packages/renderer/package.json, pnpm-lock.yaml, packages/shared/src/tailwind-preset.ts, packages/mobile-renderer/src/styles/tokens.css, docs/page-design/v6-master-spec.md, docs/page-design/v6-tokens.css, docs/adr/0019-visual-direction.md, packages/renderer/index.html, docs/page-design/design-tokens.md | — | g1（W1=设计文档 W1a 字体管线：删 smoothing + 系统栈 + Inter 移除 + 五载体同步 + ADR 留痕） |
| W2 | packages/ui/src/features/chat/MarkdownRenderer.vue | — | g2（W2=设计文档 W1b 表格圆角，独立 cosmetic） |
| W3 | packages/ui/src/features/chat/format-utils.ts, packages/ui/src/features/chat/__tests__/format-utils.test.ts, packages/ui/src/features/chat/Block.vue | — | g2（W3=设计文档 W2 展示层截短：shortenForHeader + tailLines + 单测 + :111 接入；与 W2 并行） |
| W4 | packages/ui/src/features/chat/composables/useTailScroll.ts, packages/ui/src/features/chat/Block.vue, packages/ui/src/features/chat/__tests__/Block.test.ts | W3 | g3（W4=设计文档 W3 双轴尾部追踪：composable + thinking/tool 双接入 + DOM 断言；依赖 W3 的纯函数） |
| W5 | （无代码文件；lint + pre-commit 全量 + Playwright V1-V4 验收 + 截图留存 .tmp/） | W1, W2, W3, W4 | g4（W5=设计文档 W4 验收门禁） |

执行序：W1 → (W2 ∥ W3) → W4 → W5。映射说明：CW Wave 编号 = 设计文档 wave 加一（W1a→W1、W1b→W2、W2→W3、W3→W4、W4→W5）。

## 实现步骤

1. W1（字体管线一提交）：style.css 删两行 smoothing + 改 :74 栈值 → main.ts 删 import → package.json 删依赖 + `pnpm install` 更新 lock → tailwind-preset fontFamily.sans 改变量引用 → mobile tokens.css 字面同步 → v6-master-spec §4.6/v6-tokens.css 同步值 + supersede 标注 → ADR-0019 三处括注 → index.html 注释更新 → design-tokens.md 同步 → git commit（feat: 字体渲染管线对齐 macOS 原生）
2. W2（表格圆角）：MarkdownRenderer.vue 样式段重写（wrapper 加框圆角 / table separate / 单元格内线化）→ 目检 dev app 宽窄表 → git commit
3. W3（截短函数）：format-utils.ts 新增 shortenForHeader + tailLines + 文件头声明扩展 → vitest 单测全绿 → Block.vue:111 接入 → Block.test.ts 既有回归全绿 → git commit
4. W4（双轴尾部追踪）：useTailScroll.ts composable → Block.vue :25 thinking preview 双态接入 → :111 tool 折叠头双态接入（running 输出尾行 / 完成 shortenForHeader(argPath)）→ :208 docstring 修正 → Block.test.ts 扩展 DOM 断言 + 行高恒定 → 全部测试全绿 → git commit
5. W5（验收门禁）：`pnpm run lint` + pre-commit 全量（检出问题正面修复）→ `pnpm dev` 起服务确认 :1420 归属 → Playwright 连 :9222 执行设计文档 §4 V1-V4（字体 A/B 双主题截图 + getComputedStyle 断言 + font-sans utility 同栈；V2 截短；V3 尾部追踪探针 scrollLeft 钉尾 + translateY 钉最新行；V4 表格圆角）→ 截图与探针结果留存 .tmp/

## 单测用例清单（AC 级）

> 纯样式改动（style.css 字体/MarkdownRenderer.vue 表格样式段）无可单测逻辑，验收走 E3 的 V1/V4 断言；其余改动点每个正常/异常/边界齐备。测试框架：vitest（禁 node:test，从 packages/ui 目录运行）。

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | format-utils.ts:shortenForHeader | shortenForHeader('cd /Users/z/Code/repo-wt && rg -l -i "drawer" packages/renderer/src') | 输出串 'cd …/Code/repo-wt && rg -l -i "drawer" packages/renderer/src'（规则②段数≥3绝对路径→…/末两段） | 正常 |
| U2 | format-utils.ts:shortenForHeader | shortenForHeader('/Users/z/notes/a.md', { home: '/Users/z' }) | 输出串 '~/notes/a.md'（规则①home 前缀→波浪号，home 由调用方传入保持纯函数） | 正常 |
| U3 | format-utils.ts:shortenForHeader | shortenForHeader('packages/ui/src/chat/Block.vue')；shortenForHeader('/a/b.vue') | 两输入均原样返回（相对路径与段数<3 不动，规则③） | 边界 |
| U4 | format-utils.ts:shortenForHeader | shortenForHeader('')；shortenForHeader(null) | 均返回空串，不抛错 | 异常 |
| U5 | format-utils.ts:shortenForHeader | shortenForHeader('curl https://example.com/a/b/c/d.tar.gz') | 输出串 'curl https://example.com/a/b/c/d.tar.gz'（URL 整体保留不截短：预处理占位保护 scheme+host，避免 example.com 被当作路径段；URL 完整可读优于截短变形——实施期确认优于原设计口径） | 边界 |
| U6 | format-utils.ts:tailLines | tailLines('l1\nl2\nl3\nl4', 3) | 返回 ['l2','l3','l4'] | 正常 |
| U7 | format-utils.ts:tailLines | tailLines('l1\nl2', 3)；tailLines('', 3) | 分别返回 ['l1','l2'] 与 [] | 边界 |
| U8 | Block.vue:thinking 折叠预览双态 | mount Block(kind=thinking, working=true, content 为 200+ 字符多行)，读折叠预览容器文本；再置 working=false 读文本 | working=true 时含 content 末行文本；working=false 时含 content.slice(0,60) 的首行文本；两态容器 offsetHeight 相等 | 正常 |
| U9 | Block.vue:tool 折叠头双态 | mount Block(kind=tool, status=running, input.command='cd /a/b/c && rg x', outputRaw='line1\nANSI-line2')，读折叠头文本；再置 status=completed 读文本 | running 时含 'line2'（去 ANSI 末行）；completed 时含 '…/b/c'（shortenForHeader 形态）；展开态与 copyContent 仍为全量原文 | 正常 |
| U10 | Block.vue:tool 折叠头无流式输出 | mount Block(kind=tool, status=running, 无 outputRaw 且 displayContent 为空) | 折叠头文本等于 argPath 原文（静态不空不闪烁） | 边界 |
| U11 | useTailScroll.ts:双轴钉尾 | 挂载内容宽度 500px、视口 200px 的测试组件，mock scrollWidth/clientWidth 后触发 watch；再置内容宽度 100px | 第一次后 scrollLeft === scrollWidth - clientWidth（钉右）；变窄后 scrollLeft === 0；translateY 等于 -(N-1)*行高（钉最新行） | 正常 |

## E2E 用例清单

| 用例ID | 测试层 | 场景 | 步骤 | 通过标准 |
|--------|-----|------|------|---------|
| E1 | mock | Block 非展开态双态语义组件测试（vitest + @vue/test-utils，packages/ui 子包） | cd packages/ui && npx vitest run src/features/chat/__tests__/Block.test.ts | U8-U11 对应 DOM 断言全绿 + 既有回归全绿 |
| E2 | real | 工程门禁 | pnpm run lint && pre-commit hooks 全量（vue_rules_checker/taste-lint） | 全绿；检出问题全部正面修复，无 --no-verify |
| E3 | real | dev app 真实会话验收（V1-V4） | pnpm dev → 确认 :1420 归属 → Playwright 连 :9222 → 按设计文档 §4 执行：V1 双主题字体（前后截图 + getComputedStyle(body) 首项 system-ui + 无 smoothing 覆盖 + font-sans utility 消费点与 body 同栈 + 4 处 tabular-nums 目检）；V2 长命令折叠头（末两段 + read 文件名可见 + 展开/copy 全量）；V3 流式 thinking+tool（scrollLeft 钉尾探针 + translateY 钉最新行 + 完成态回落）；V4 表格圆角（宽窄表无双重线/缺角） | V1-V4 全部通过标准达成；截图与探针结果留存 .tmp/ |

## 覆盖率 gate

- 新增纯函数（shortenForHeader/tailLines）：分支全覆盖（规则①②③各正反例 + 边界输入）
- useTailScroll：DOM 行为断言（钉尾/回落/降级开关）+ 既有 Block 回归 100% 通过
- 覆盖率命令：`cd packages/ui && npx vitest run src/features/chat --coverage --coverage.thresholds.lines=60`（新增代码行覆盖率 gate ≥ 60%，不足则补用例后重跑）
- 工程门禁：`pnpm run lint` + pre-commit 全量正面修复（taste-lint / vue_rules_checker / vue 模板规则），禁 --no-verify
- E2E：V1-V4 全过 + 截图留存 .tmp/（lite test 用截图判分）
