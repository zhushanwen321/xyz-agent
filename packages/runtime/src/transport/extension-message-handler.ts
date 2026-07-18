/**
 * Extension message handler for extension.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { ISessionService, IExtensionService } from '../interfaces.js'
import type { ExtensionTimeoutManager } from '../services/extension-timeout-manager.js'
import { ExtensionInstallError } from '../services/extension-service.js'
import { toErrorMessage } from '../utils/errors.js'
import { sendHandlerError } from './handler-utils.js'
import type { MessageHandlerContext } from './message-context.js'

/** Interface for server methods needed by this handler */
export interface ExtensionHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  extensionService: IExtensionService | undefined
  extensionTimeoutMgr: ExtensionTimeoutManager
  /** 广播给所有连接（extension.ui_timeout 超时通知用）。 */
  broadcast(msg: import('@xyz-agent/shared').ServerMessage): void
  /** push 消息 id 生成器（extension.ui_timeout 广播 id）。 */
  nextPushId(): string
}

export class ExtensionMessageHandler {
  constructor(private ctx: ExtensionHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'extension.ui_response', 'extension.list', 'extension.toggle', 'extension.install', 'extension.uninstall',
    'extension.installDir', 'extension.installGit', 'extension.finishInstall', 'extension.cancelInstall',
    'extension.recommended',
    'extension.upgrade', 'extension.setAutoUpgrade',
  ]

  /**
   * D3: service-not-available 前置守卫（此前 7 处同形 inline）。
   * 返回窄化后的 IExtensionService；service 缺席时已发送 handler_error 并返回 undefined，
   * 调用方 `if (!svc) return` 即可。类型守卫必须留在调用方——TS 不收窄 `this.ctx.X`
   * 的属性访问，但能收窄函数返回值。
   */
  private requireExt(ws: WsType, id?: string): IExtensionService | undefined {
    if (!this.ctx.extensionService) {
      this.ctx.sendError(ws, 'handler_error', 'Extension service not available', id)
      return undefined
    }
    return this.ctx.extensionService
  }

  /**
   * 扩展 UI 请求超时后的响应编排：向 pi 进程发默认 extension_ui_response（confirm→false，
   * 其余→cancelled），并广播 extension.ui_timeout 通知前端。
   *
   * pi 的 extension_ui_response 期望按 method 分的 3 种格式（rpc-types.ts:255-258）：
   * - {id, value} 用于 select/input/editor
   * - {id, confirmed} 用于 confirm
   * - {id, cancelled:true} 用于取消
   * pi 用鸭子类型字段检测解析（rpc-mode.ts:136-149），发错字段静默返回默认值。
   *
   * 超时后标记 requestId 为已超时（extensionTimeoutMgr.markTimedOut），
   * 防止前端 race window 内迟到的 extension.ui_response 再发一次（双响应）。
   */
  handleExtensionTimeout(sessionId: string, requestId: string, method: string): void {
    this.ctx.extensionTimeoutMgr.markTimedOut(requestId)
    const client = this.ctx.sessionService.getRpcClient(sessionId)
    if (client) {
      client.sendExtensionUiResponse(requestId, method === 'confirm' ? false : null, method)
    }
    this.ctx.broadcast({
      type: 'extension.ui_timeout',
      id: this.ctx.nextPushId(),
      payload: { sessionId, requestId },
    })
  }

  async handleExtensionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'extension.ui_response': {
        const { sessionId: extSid, requestId, method, result: extResult } = msg.payload

        if (this.ctx.extensionTimeoutMgr.isBridgeRequest(requestId)) {
          this.ctx.extensionTimeoutMgr.removeBridgeRequest(requestId)
          this.ctx.extensionTimeoutMgr.removePendingRequest(extSid, requestId)
          return
        }

        // P2-6：超时后的迟到响应直接丢弃。runtime 超时已向 pi 发默认响应，
        // 此处再发会导致 pi 双响应（pi 按 id 匹配第一个响应，第二个会被忽略——
        // 但 runtime 不应依赖 pi 的容错，在自身层拦截）。
        if (this.ctx.extensionTimeoutMgr.isTimedOut(requestId)) {
          this.ctx.extensionTimeoutMgr.clearTimedOut(requestId)
          this.ctx.extensionTimeoutMgr.clearTimeout(requestId)
          this.ctx.extensionTimeoutMgr.removePendingRequest(extSid, requestId)
          return
        }

        const client = this.ctx.sessionService.getRpcClient(extSid)
        if (!client) {
          this.ctx.extensionTimeoutMgr.clearTimeout(requestId)
          this.ctx.extensionTimeoutMgr.removePendingRequest(extSid, requestId)
          return this.ctx.sendError(ws, 'handler_error', `No active session for extension response: ${extSid}`, msg.id, { sessionId: extSid })
        }
        client.sendExtensionUiResponse(requestId, extResult ?? null, method)
        this.ctx.extensionTimeoutMgr.clearTimeout(requestId)
        this.ctx.extensionTimeoutMgr.removePendingRequest(extSid, requestId)
        return
      }
      case 'extension.list': {
        if (!this.ctx.extensionService) {
          return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions: [] })
        }
        const extensions = await this.ctx.extensionService.scanExtensions()
        return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
      }
      case 'extension.recommended': {
        if (!this.ctx.extensionService) {
          return this.ctx.reply(ws, msg.id, 'extension.recommended', { recommended: [] })
        }
        const recommended = await this.ctx.extensionService.getRecommendedExtensions()
        return this.ctx.reply(ws, msg.id, 'extension.recommended', { recommended })
      }
      case 'extension.toggle': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          await ext.toggleExtension(msg.payload.name, msg.payload.enabled)
          const extensions = await ext.scanExtensions()
          return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
        } catch (e) {
          return this.ctx.sendError(ws, 'toggle_failed', toErrorMessage(e), msg.id)
        }
      }
      case 'extension.install': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          await ext.installExtension(msg.payload.source)
        } catch (e) {
          return this.sendInstallError(ws, msg.id, e)
        }
        const installed = await ext.scanExtensions()
        return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions: installed })
      }
      case 'extension.uninstall': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          await ext.uninstallExtension(msg.payload.name)
        } catch (e) {
          const errMsg = toErrorMessage(e)
          return this.ctx.sendError(ws, 'uninstall_failed', errMsg, msg.id)
        }
        const uninstalled = await ext.scanExtensions()
        return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions: uninstalled })
      }
      // ── Local directory / Git / finish install ────────────────────
      case 'extension.installDir': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          const { path: sourcePath } = msg.payload as { path: string }
          if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.installDir requires a non-empty "path" string', msg.id)
          }
          const result = await ext.installLocalDirectory(sourcePath)
          return this.ctx.reply(ws, msg.id, 'extension.discovered', { tempDir: result.tempDir, candidates: result.candidates })
        } catch (e) {
          return this.sendInstallError(ws, msg.id, e)
        }
      }
      case 'extension.installGit': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          const { url } = msg.payload as { url: string }
          if (typeof url !== 'string' || url.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.installGit requires a non-empty "url" string', msg.id)
          }
          const result = await ext.installGitRepository(url)
          return this.ctx.reply(ws, msg.id, 'extension.discovered', { tempDir: result.tempDir, candidates: result.candidates })
        } catch (e) {
          return this.sendInstallError(ws, msg.id, e)
        }
      }
      case 'extension.finishInstall': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          const { tempDir, selected } = msg.payload as { tempDir: string; selected: string[] }
          if (typeof tempDir !== 'string' || !Array.isArray(selected)) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.finishInstall requires tempDir (string) and selected (string[])', msg.id)
          }
          await ext.finishInstall(tempDir, selected)
          const extensions = await ext.scanExtensions()
          return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
        } catch (e) {
          return this.sendInstallError(ws, msg.id, e)
        }
      }
      case 'extension.cancelInstall': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          const { tempDir } = msg.payload as { tempDir: string }
          if (typeof tempDir !== 'string' || tempDir.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.cancelInstall requires a non-empty "tempDir" string', msg.id)
          }
          await ext.cancelInstall(tempDir)
          return this.ctx.reply(ws, msg.id, 'extension.installCancelled', {})
        } catch (e) {
          return this.sendInstallError(ws, msg.id, e)
        }
      }
      case 'extension.upgrade': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          const { name } = msg.payload as { name: string }
          if (typeof name !== 'string' || name.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.upgrade requires a non-empty "name" string', msg.id)
          }
          const result = await ext.upgradeExtension(name)
          const extensions = await ext.scanExtensions()
          return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions, upgradeResult: result })
        } catch (e) {
          return this.sendInstallError(ws, msg.id, e)
        }
      }
      case 'extension.setAutoUpgrade': {
        const ext = this.requireExt(ws, msg.id)
        if (!ext) return
        try {
          const { name, autoUpgrade } = msg.payload as { name: string; autoUpgrade: boolean }
          if (typeof name !== 'string' || name.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.setAutoUpgrade requires a non-empty "name" string', msg.id)
          }
          if (typeof autoUpgrade !== 'boolean') {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.setAutoUpgrade requires "autoUpgrade" to be a boolean', msg.id)
          }
          await ext.setAutoUpgrade(name, autoUpgrade)
          const extensions = await ext.scanExtensions()
          return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
        } catch (e) {
          return this.ctx.sendError(ws, 'set_auto_upgrade_failed', toErrorMessage(e), msg.id)
        }
      }
      case 'extension.getPendingRequests': {
        const { sessionId } = msg.payload as { sessionId: string }
        if (!sessionId) {
          return this.ctx.sendError(ws, 'invalid_payload', 'extension.getPendingRequests requires "sessionId"', msg.id)
        }
        const pendingRequests = this.ctx.extensionTimeoutMgr.getAndClearPendingRequests(sessionId)
        return this.ctx.reply(ws, msg.id, 'extension.pendingRequests', { sessionId, requests: pendingRequests })
      }
    }
  }

  /**
   * install/Dir/Git/finish/cancel 失败的统一错误回复（D10/P0-B）。
   * 此前 5 处各自 reply('extension.installError', extractExtensionError(e))；
   * 现统一走 error envelope，hint 进 details.hint。
   * Primary: instanceof check. Fallback: branded property check (handles cross-bundle scenarios).
   */
  private sendInstallError(ws: WsType, id: string | undefined, e: unknown): void {
    // matched 分支透传 e.hint；fallback 分支不带 details（保持既有行为）。
    sendHandlerError(this.ctx, ws, ExtensionInstallError, 'install_failed', e, id, (matched) => matched.hint ? { hint: matched.hint } : undefined)
  }
}
