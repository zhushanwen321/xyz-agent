# 动画优化 6 plan 实现一致性审查报告

审查对象：`.xyz-harness/2026-08-09-animation-audit/` 01~06 plan vs 8 个实施 commit（59d633f36 … 0ed72ae66）
审查基线：git HEAD（工作区 31 个未提交 provider hardening 改动不涉及任何动画文件，已用 `git show HEAD:path` 隔离）
验证环境：packages/renderer，vitest 4.1.9

## 逐 plan 判定

### Plan 01 浮层/弹窗进出场过渡 — ✅ 一致（59d633f36 + bcb0fc40f）

spec 值逐项核对（plan target vs commit diff）：

| spec 项 | plan 期望值 | 实际落地 | 判定 |
|---|---|---|---|
| `.reka-popover-transition` | `transition: opacity var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease)` + `transform-origin: var(--reka-popper-transform-origin, center)` | style.css:434-436 逐字一致 | ✅ |
| popover open/closed | opacity 1/0, scale(1)/scale(0.96) | style.css:437-443 一致 | ✅ |
| popover @starting-style | open → opacity 0, scale(0.96) | style.css:444-448 一致 | ✅ |
| `.reka-dialog-transition` | `var(--duration)` 200ms + translate(-50%,-50%) 居中保留 | style.css:452-465 一致 | ✅ |
| `.reka-overlay-transition` | 纯 opacity `var(--duration)` | style.css:468-476 一致 | ✅ |
| 放置位置 | @keyframes 之后、reduced-motion 块之前 | style.css:426（紧接 `to { transform: rotate(360deg) }`）| ✅ |
| PopoverContent.vue:30 | 死类 → `reka-popover-transition` | 逐字一致，z-index/颜色等非动画 class 保留 | ✅ |
| SelectContent.vue:36 | 同上 | 一致 | ✅ |
| HoverCardContent.vue:28 | 同上 | 一致 | ✅ |
| DialogContent.vue:42 | 删 `-translate-x-1/2 -translate-y-1/2` + `duration-200` + 全部死类，加 `reka-dialog-transition` | 一致 | ✅ |
| DialogOverlay:36 | 死类 → `reka-overlay-transition` | 一致 | ✅ |
| 死类残留 | 仅 CollapsibleContent.vue 命中 | `git grep` HEAD 确认仅 CollapsibleContent.vue:12,24 | ✅ |
| 不装依赖/不改 tailwind.config | — | 均未动 | ✅ |

运行时前提核实（实测 reka-ui 2.10.1 源码）：`--reka-popper-transform-origin` 由 PopperContent 外层 wrapper 设置（PopperContent.cjs:254），定位 transform 与 `--reka-popper-transform-origin` 均在外层 `data-reka-popper-content-wrapper`，动画 scale 在内层 content 元素——两层分离，`transform: scale()` 不破坏定位，CSS 变量继承到内层使 `transform-origin` 跟随触发点。前提成立。

### Plan 02 Button 按下物理反馈 — ✅ 一致（738467d26）

button/index.ts base class 逐字一致：`transition-colors` → `transition-[background-color,color,border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease)] active:scale-[0.97]`。variants/size 未动，无 `transition-all`，focus-visible/disabled/svg 规则原样保留。

### Plan 03 Toast 进出场 — ✅ 一致（287960c3f）

ToastContainer.vue:73-74 逐字一致：enter `opacity var(--duration) var(--ease), transform var(--duration) var(--ease)`；leave `var(--duration-fast)`。`transition: all` 与 `ease-in` 已消除，硬编码 0.3s/0.2s 已消除。L75-76 `.toast-enter-from/.toast-leave-to` 未动（translateX(20px) 保留），无新增 keyframes，`name="toast"` 不变。

### Plan 04 删除常驻装饰动画 — ⚠️ 偏差（1 项，must-fix）

4 处删除全部落地：
- SegmentedTab.vue:25 静态 badge ✅（含 motion-reduce 守卫一并删，plan 要求）
- SessionItem.vue:68 静态指示条 ✅
- composer-shell.ts:285 删 `animate-steer-breathe`，静态 ring ✅
- sessionStatus.ts:49 waiting → `animation: ''` ✅
- SegmentedTab.spec.ts:79 断言 toContain → not.toContain ✅（plan 明确要求）
- keyframes pulse-dot/wiggle/steer-breathe 保留 ✅（plan Boundaries 要求）

**偏差（must-fix）**：`exclusive.includes('animate-steer-breathe')` 死条件遗留，见下方 F3。

### Plan 05 reduced-motion 细化 + TaijiLogo 守卫 — ⚠️ 偏差（2 项，must-fix）

字面落地部分：
- TaijiLogo.vue:29 `:class="spin ? \`animate-[taiji-spin_${duration}s_linear_infinite]\` : ''"` + `:style="{ transformOrigin: 'center' }"` ✅ 与 plan target 一致
- spin/duration 默认值（true/8）未动、SVG path 几何未动 ✅
- style.css reduced-motion 两段式规则（L484-501）与 plan target 逐字一致 ✅

**偏差 1（must-fix，功能性失效）**：TaijiLogo 旋转动画在构建产物中**不存在**——见 F1。
**偏差 2（must-fix，级联失效）**：reduced-motion 白名单机制无法达成「位移瞬切、opacity 保留」——见 F2。

### Plan 06 pending 死类修复 — ✅ 一致（e427cfd0a）

sessionStatus.ts:46 `animate-bounce-small` → `animate-pulse-strong` ✅。`animate-pulse-strong` 定义于 tailwind.config.ts:108 + style.css:387 ✅（复用既有动画，不新增 keyframes，plan 要求）。`bounce-small` 生产源码零残留（git grep HEAD 仅测试文件注释提及，plan Verification「0 命中」指 src/，实测 `git grep bounce-small HEAD -- packages/renderer/src/` 仅命中 `__tests__/animations/pending-status-class.test.ts` 的断言与注释——该测试断言 `not.toContain`，本身正确）。其他状态 animation 字段未动（TC3 边界测试覆盖）。

---

## must-fix 清单（3 项）

### F1 [major] TaijiLogo 旋转动画失效（Plan 05 核心回归）
- **位置**：packages/renderer/src/components/icons/TaijiLogo.vue:29
- **期望**：plan 05 Verification「默认（未开 reduced-motion）：logo 正常 8s 旋转——行为与改动前完全一致」（改动前内联 style `animation: taiji-spin 8s linear infinite` 确定生效）
- **实际**：`:class` 注入的 `animate-[taiji-spin_${duration}s_linear_infinite]` 是模板字面量，Tailwind JIT 构建时**不生成**对应 utility 类。实测（项目 tailwind.config.ts + style.css 全量构建到 /tmp/tw-probe/prod-out.css）：产物中只有 `.animate-\[taiji-spin_\.\.\.\] { animation: taiji-spin ...; }`（`${duration}` 被 Tailwind 替换为 `...` 占位符，值非法），**无** `.animate-\[taiji-spin_8s_linear_infinite\]`。运行时 class 不匹配任何规则 → 两个消费方（App.vue:9、Brand.vue:28 `:duration="8"`）的 logo 均不旋转。
- **附带影响**：`motion-reduce:animate-none` 守卫类存在于产物（L4844），但「reduce 下停转」的达成是因为动画本来就没生效——plan 的默认行为验收点实际失败。reduced-motion-guard.test.ts 只断言源码字符串（TC1 断言模板字面量存在），未验证 Tailwind 产物，测试全绿但功能失效。
- **修复建议**：改为静态类（`animate-[taiji-spin_8s_linear_infinite]`，duration 场景用 style 内 CSS 变量承载，如 `style="{ animationDuration: duration + 's' }"` 配静态 `animate-[taiji-spin_...]`——Tailwind 对 `animate-[taiji-spin_...]` 值含 `...` 生成 `animation: taiji-spin ...`？否，`...` 非法。正确做法：回退内联 style 保留 `animation` 键，或定义全局 `.taiji-spin` 类 + `animation-duration` 用 CSS 变量）——或直接保留内联 style 写法（motion-reduce:animate-none 覆盖内联 style 问题另解，但至少动画生效）。

### F2 [major] reduced-motion 白名单级联失效，位移过渡不瞬切（Plan 05 验证目标未达成）
- **位置**：packages/renderer/src/style.css:495-498（第二段 `@media (prefers-reduced-motion: reduce)` 规则）
- **期望**（plan 05 Verification）：「触发弹层：位移类过渡瞬切（不缩放），但 opacity 仍淡入」；Done when「位移动画消失」
- **实际**（CSS 级联分析）：① 第二段 `transition-property` 白名单**无 `!important`**，特异性 (0,0,0) 低于任何类选择器——`.reka-popover-transition`（0,1,0）的 `transition-property: opacity, transform`、按钮的 `transition-[...,transform]`（0,1,0）均保留原值，transform 仍在过渡属性中；② 第二段 `transition-duration: var(--duration-fast) !important` 与第一段 `0.01ms !important` 同特异性，按源码顺序后者胜 → **所有**过渡（含 transform 位移）以 120ms 运行。净效果：reduce 模式下 popover 缩放、按钮按下 scale、toast 滑动仍以 120ms 动画；相对改动前（全部 0.01ms 瞬切），位移过渡时长反而**增加**。第一段的 0.01ms 实际从未生效。
- **附带**：无 transition 声明的元素被第二段强制 `transition-property` 白名单 + 120ms duration——原本瞬变的 hover 背景被强制 120ms 渐变（plan 意图之一，但实现方式连没有过渡的元素也覆盖，属过度）。
- **修复建议**：第二段 `transition-property` 加 `!important`（important 层内唯一声明生效，transform 被移出过渡属性 → 瞬切；duration 120ms 只作用于白名单属性）。注意：该缺陷源自 plan target 原文（实现忠实复制），plan 文档本身需同步修正。

### F3 [major] Composer.vue focus ring 排除条件死代码，steer 聚焦态行为回归（Plan 04 遗漏消费点）
- **位置**：packages/renderer/src/components/panel/Composer.vue:230
- **期望**：注释声明意图「staging/bash/steer 活跃时不叠加 focus ring（它们已含 accent border + ring）」；Plan 04 前该条件经 `exclusive.includes('animate-steer-breathe')` 命中 steer 态
- **实际**：Plan 04 删除 composer-shell.ts 的 `animate-steer-breathe` 后，boxClass 不再含该字符串，条件**永远 false**。steer 激活 + 聚焦时 focusRingClass 现在返回 `['!border-[var(--accent)] ![box-shadow:var(--shadow-glow)]']`，`![box-shadow:...]` 覆盖 steer 静态 ring `shadow-[0_0_0_3px_rgba(79,142,247,0.25)]`——聚焦 steer 态 composer 的 ring 视觉被替换（0.25 alpha → --shadow-glow）。Plan 04 只列了 4 个文件范围，未排查 `animate-steer-breathe` 的其他消费点（git grep 证实消费点共 2 处：composer-shell.ts + Composer.vue:230）。
- **修复建议**：排除条件改为检查 steer 视觉特征（`exclusive.includes('border-[var(--accent)]')` 或直接 `isActive`），或删除死条件后为 steer 态补等价排除。

## scope creep 清单

| commit | 改动 | 判定 |
|---|---|---|
| 59d633f36 | `.githooks/check_css_tokens.py` 新增 `ALLOWED_GLOBAL_ANIMATION_CLASSES` allowlist | 轻微 creep，但为让 pre-commit 通过 3 个新全局原语类（旧规则把含 `-` 的类选择器全判为组件级）的必要配套，带 [HISTORICAL] 注释 + 三特征判据，可接受 |
| 各 commit | 6 个新增回归测试（overlay-transitions / button / ToastContainer.transition / remove-persistent-decorations / pending-status-class / reduced-motion-guard） | 良性 creep：plan Verification 未要求自动化测试，但测试本身正确（唯 reduced-motion-guard 未验证 Tailwind 产物，见 F1） |
| c52d7ebe2 | 修复自身测试路径 `../..` → `../../..` | 非 creep，自修 bug |

无 plan 之外的业务代码改动（未提交的 provider hardening 改动确认与 8 个 commit 文件零交集）。

## 验证命令结果

- `cd packages/renderer && npx vue-tsc --noEmit` → **exit 0**，无类型错误
- `cd packages/renderer && npx vitest run` → **259 files：2253 passed / 12 failed / 3 skipped（3 files failed）**
  - 动画相关 6 个测试文件 **71 tests 全绿**（overlay-transitions 42 / button 5 / ToastContainer.transition 9 / remove-persistent-decorations 5 / pending-status-class 3 / reduced-motion-guard 4 + SegmentedTab.spec 静态 badge 断言）
  - 12 个失败全部与动画**无关**（预存失败）：
    - `useAppUpdate.pending.test.ts` 整个文件：`Failed to resolve import "@/composables/features/useAppUpdate"`——源文件在 commit 18c67d16f（早于动画 commits）已删除，测试残留
    - `ProviderPage.test.ts` U1/D14：provider hardening 相关，对应工作区未提交改动（ProviderPage.vue/useModel.ts 等），与动画 commits 无交集
    - `system-page-update.test.ts` TC2-TC8 等 10 项：UpdateCheckCard 渲染断言，最后修改 commit 1216fc779 早于动画 commits
- Tailwind 产物探针（`npx tailwindcss -c tailwind.config.ts -i src/style.css`）：产物含 `.animate-\[taiji-spin_\.\.\.\]`（值 `...`，无效）与 `.motion-reduce\:animate-none`，**无** `.animate-\[taiji-spin_8s_linear_infinite\]`——F1 证据

## 汇总

- Plan 01 / 02 / 03 / 06：✅ 与 spec 精确一致，无偏差
- Plan 04：4 处删除 + 测试翻转全落地，但遗漏 steer-breathe 的第二个消费点（F3）
- Plan 05：字面落地与 spec 一致，但存在 2 个功能性缺陷（F1 动画失效、F2 级联失效）——均为「实现忠实复制了 plan 的缺陷/未验证运行时行为」类问题
- must-fix 共 3 项（F1/F2/F3），均 major

---

## 修复记录（2026-08-10，主 agent 直接修复）

3 项 must-fix 已修复并验证，commit：
- **F1** `0d53bda69`：TaijiLogo 模板字面量 arbitrary 类 → config 注册静态 `animate-taiji-spin` + inline `animation-duration` 覆盖。Tailwind 产物探针实测 `.animate-taiji-spin { animation: taiji-spin 8s linear infinite; }` 生成，无效 `...` 占位类消失，motion-reduce 守卫仍在（name:none 不受 inline duration 影响）。
- **F2** `0d53bda69`：style.css reduced-motion 第二段 `transition-property` 加 `!important`。plan 05 文档 target CSS 同步修正 + [HISTORICAL] 注记。
- **F3** `a88df62f5`：Composer.vue focusRingClass 排除条件 `animate-steer-breathe` → steer/bash 共享视觉特征 `border-[var(--accent)]`。

测试更新：reduced-motion-guard TC1/TC2 断言静态类 + config 注册 + `!important` 白名单。验证：vue-tsc exit 0；动画相关 7 文件 76 tests 全绿；两次 commit 的 pre-commit 全量检查（ESLint/vue-tsc/规范/CSS tokens/依赖完整性）通过。
