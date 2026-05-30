---
review:
  type: plan_bl_review
  round: 1
  timestamp: "2026-05-30T23:30:00"
  target: "plan-backend.md, plan-frontend.md, plan-api-contract.md"
  verdict: pass
  must_fix: 0
  summary: "后端/前端对齐审查。plan-api-contract.md 定义了 WS 消息契约和 RPC 方法签名，plan-backend.md 和 plan-frontend.md 的接口调用与契约完全一致。无 MUST FIX。"

alignment_checks:
  - interface: "StatusBarItem (shared type)"
    backend: "plan-backend.md §1 — StatusBarItem 增加 scope, sessionId 字段"
    frontend: "plan-frontend.md §1 — PluginStatusItem 增加 scope, sessionId 字段"
    status: aligned

  - interface: "plugin:statusBarUpdate (WS message)"
    backend: "plan-backend.md §4 — plugin-service broadcasts items: StatusBarItem[]"
    frontend: "plan-frontend.md §1 — usePlugin handler receives items: PluginStatusItem[]"
    status: aligned

  - interface: "updateStatusBarItem RPC"
    backend: "plan-backend.md §4 — ui-api.ts accepts (pluginId, id, text, options?)"
    frontend: "plan-frontend.md N/A (frontend doesn't call this directly)"
    status: aligned

  - interface: "context.update (WS message)"
    backend: "plan-backend.md §4a — event-adapter emits { usagePercent, inputTokens, contextLimit }"
    frontend: "plan-frontend.md §2 — InputToolbar reads chatStore.contextUsagePercent (fed by context.update)"
    status: aligned

  - interface: "SessionStrip data source"
    backend: "plan-api-contract.md §6 — scope='per-session' items arrive via plugin:statusBarUpdate"
    frontend: "plan-frontend.md §3 — SessionStrip calls getSessionStatusBarItems(sessionId)"
    status: aligned

  - interface: "Global Statusbar data source"
    backend: "plan-api-contract.md §6 — scope='global' items arrive via plugin:statusBarUpdate"
    frontend: "plan-frontend.md §4 — AppStatusbar reads globalStatusBarItems computed"
    status: aligned
