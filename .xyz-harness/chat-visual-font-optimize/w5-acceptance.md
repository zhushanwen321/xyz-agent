# W5 验收记录（E1-E3）· chat-visual-font-optimize

> 日期：2026-08-26 · dev app（pnpm dev，renderer :1420 / CDP :9222，端口归属已确认）· Playwright 连 9222

## E1 · Block 非展开态双态语义组件测试（mock 层）

`cd packages/ui && npx vitest run src/features/chat/__tests__/ src/features/chat/composables/__tests__/`

**15 文件 195/195 全绿**（chat 全套回归含）：format-utils 9（U1-U7 + URL 口径）/ Block 26（19 既有回归 + U8-U10）/ useTailScroll 9（U11）。lint 修复后全量复跑通过。

## E2 · 工程门禁（real 层）

- `pnpm run lint` exit 0（1 error 已正面修复：useTailScroll contentRef 未消费 → API 移除该参数，调用面 7 处同步；399 warnings 为存量非本次引入，不挂门禁）
- W1-W4 各 commit 均过 pre-commit 全量 hooks（CSS tokens / ENV SSOT / 路径白名单 / R1 / CSP / 目录规范等全绿），无 --no-verify / SKIP_*

## E3 · dev app 真实会话验收 V1-V4（real 层，截图留存 .tmp/verify/）

### V1 字体双主题 + 同栈断言 ✅

- `getComputedStyle(body).fontFamily` 首项 `system-ui`（完整新栈：system-ui, PingFang SC, Helvetica Neue, Microsoft YaHei, Noto Sans CJK SC, sans-serif）
- body 与 html 的 `webkitFontSmoothing` 均回落 `auto`（antialiased 覆盖已删）
- **font-sans utility 同栈**：临时挂载 `.font-sans` 元素 computed fontFamily === body 字体串（tailwind-preset `var(--font-sans)` 引用生效，无混跑）
- `document.fonts` 无 Inter（bundle 移除生效）
- 暗色截图：v1-app-overview.png

### V2 长命令折叠头 ✅（真实会话：rg 命令）

- 折叠头（running 态 + 完成态）：`bash· cd …/xyz-agent-workspace/feat-font-optimize && rg -l -i font packages/renderer/src --type css | head -30`——`…/末两段` 截短生效，命令主体 `rg -l -i font` 进入头部可视区
- 展开态：`cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-font-optimize && rg …` 全量原始命令（信息零丢失）
- turn 完成后块收编为 TraceCompactorRow（既有窗口化行为），点 TurnMeta 展开可见折叠头截短形态
- 截图：v2-header-shortened.png（running）/ v2-expanded-full.png（展开全量）

### V3 流式 thinking + tool 尾部追踪 ✅（含一个实测发现）

- **thinking 流式（核心断言现场通过）**：深度思考任务 streaming 中 3 次采样，折叠 preview 尾部内容持续更新（`…feature branch in` → `…the user asks for…` → `…"Noto Sans CJK SC" on Linux`），`scrollLeft 钉右探针` 3/3 为 true（`scrollLeft >= scrollWidth - clientWidth - 1`）。截图：v3-thinking-tail-scroll.png
- **tool running 输出尾行：降级路径生效（实测确认设计 §6 限制 6 的预言）**：bash 流式命令（40 行 × 0.15s）running 中折叠头显示静态命令 argPath 而非输出尾行——实测 pi bash 的部分输出无流式增量广播到 renderer `outputRaw`（该字段完成后才有值），故按设计降级为静态 argPath（现状），非缺陷。thinking 链路不受影响。

### V4 表格圆角 ✅（真实 AI 输出 6 列 + 2 列表）

- `.md-table-wrap` computed：borderRadius `8px`（= var(--radius)）/ border `1px rgba(255,255,255,0.07)`
- `table`：`border-collapse: separate` + `border-spacing: 0px`；th 底色 `rgb(39,39,42)`（surface-2 保留）
- 截图：v4-table-radius.png / v4-full.png（v4-full 未单独落盘，v4-table-radius 元素截图 + v1 全景内可见）

## 结论

E1-E3 全部通过。V3 的 tool 接入点实测确认走降级路径（bash 无流式增量），thinking 接入点核心机制现场验证成立——与设计文档 §6 限制 6 的预案一致。
