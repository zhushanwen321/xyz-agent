/**
 * Unified Hooks Extension
 *
 * Collects scattered hooks in one place for easy maintenance.
 * Each hook is a self-contained module that can be enabled/disabled independently.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";

// Re-export hook modules for easy access

import { setupNetworkTimeoutGuard } from "./hooks/network-timeout-guard";
import { setupSubagentListInjector } from "./hooks/subagent-list-injector";
import { setupTestTimeoutGuard } from "./hooks/test-timeout-guard";
import { type HookContext, setupToolErrorHandler } from "./hooks/tool-error-handler";

// 模块级 logger（setPiHandle 注入后自动走 appendEntry）
const logger = getLogger("unified-hooks");

/**
 * Extension factory - registers all unified hooks
 */
export default function unifiedHooksExtension(pi: ExtensionAPI): void {
  // 注入 pi handle 给全局 extension-logger
  setPiHandle(pi);

  // Initialize hook registry
  const hooks: Array<{ name: string; enabled: boolean }> = [];

  // edit-stale-content-guard removed: pi-hashline-edit replaces built-in edit
  // with hash-anchor mode, making oldText-based guard unreachable
  const hookModules = [
    { name: "tool-error-handler", setup: setupToolErrorHandler },
    { name: "network-timeout-guard", setup: setupNetworkTimeoutGuard },
    { name: "test-timeout-guard", setup: setupTestTimeoutGuard },
    { name: "subagent-list-injector", setup: setupSubagentListInjector },
  ];

  for (const hook of hookModules) {
    try {
      hook.setup(pi);
      hooks.push({ name: hook.name, enabled: true });
    } catch (err) {
      logger.error(`[unified-hooks] Failed to setup ${hook.name}`, {
        reason: err instanceof Error ? err.message : String(err),
      });
      hooks.push({ name: hook.name, enabled: false });
    }
  }

  // Hook 状态：appendEntry 持久化（事后排查）。
  // notify 仅在有 disabled hook（setup 失败）时提醒用户——全成功时不刷屏。
  // 禁止用 console.warn（raw stderr 在 TUI alternate screen 下会越过渲染层污染 input 区）。
  pi.on("session_start", (_event: unknown, ctx: HookContext) => {
    const enabled = hooks.filter((h) => h.enabled).map((h) => h.name);
    const disabled = hooks.filter((h) => !h.enabled).map((h) => h.name);
    pi.appendEntry("unified-hooks:loaded", { enabled, disabled });
    if (disabled.length > 0) {
      ctx.ui?.notify(
        `[unified-hooks] Failed: ${disabled.join(", ")}`,
        "warning",
      );
    }
  });
}
