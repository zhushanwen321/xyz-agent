/**
 * Unified Hooks Extension
 *
 * Collects scattered hooks in one place for easy maintenance.
 * Each hook is a self-contained module. All hooks are registered unconditionally;
 * a hook whose setup throws is marked disabled (reported via session_start).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";

// Re-export hook modules for easy access

import { setupNetworkTimeoutGuard } from "./hooks/network-timeout-guard";
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
  //
  // 行为收敛（非向后兼容）：旧实现每次 session_start 无条件 notify，现在改为
  // 「全成功仅 appendEntry，有失败才 notify disabled 列表」。`unified-hooks:loaded`
  // customEntry 仍每次写入（持久化面不变）。消费方若依赖「每 session 必发 notify」
  // 需改读 session.jsonl 中的 `unified-hooks:loaded` entry。
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
