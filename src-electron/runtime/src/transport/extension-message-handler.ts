/**
 * Extension message handler for extension.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { ISessionService, IExtensionService } from '../interfaces.js'
import type { ExtensionTimeoutManager } from '../services/extension-timeout-manager.js'
import { ExtensionInstallError } from '../services/extension-service.js'
import { toErrorMessage } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'

/** Interface for server methods needed by this handler */
export interface ExtensionHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  extensionService: IExtensionService | undefined
  extensionTimeoutMgr: ExtensionTimeoutManager
}

export class ExtensionMessageHandler {
  constructor(private ctx: ExtensionHandlerContext) {}

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

  async handleExtensionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'extension.ui_response': {
        const { sessionId: extSid, requestId, result: extResult } = msg.payload

        if (this.ctx.extensionTimeoutMgr.isBridgeRequest(requestId)) {
          this.ctx.extensionTimeoutMgr.removeBridgeRequest(requestId)
          return
        }

        const client = this.ctx.sessionService.getRpcClient(extSid)
        if (!client) {
          this.ctx.extensionTimeoutMgr.clearTimeout(requestId)
          return this.ctx.sendError(ws, 'handler_error', `No active session for extension response: ${extSid}`, msg.id, extSid)
        }
        await client.sendCommand('extension_ui_response', { id: requestId, response: extResult ?? null })
        this.ctx.extensionTimeoutMgr.clearTimeout(requestId)
        return
      }
      case 'extension.list': {
        if (!this.ctx.extensionService) {
          return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions: [] })
        }
        const extensions = await this.ctx.extensionService.scanExtensions()
        return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
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
          return this.ctx.reply(ws, msg.id, 'extension.installError', this.extractExtensionError(e))
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
          return this.ctx.reply(ws, msg.id, 'extension.installError', this.extractExtensionError(e))
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
          return this.ctx.reply(ws, msg.id, 'extension.installError', this.extractExtensionError(e))
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
          return this.ctx.reply(ws, msg.id, 'extension.installError', this.extractExtensionError(e))
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
          return this.ctx.reply(ws, msg.id, 'extension.installError', this.extractExtensionError(e))
        }
      }
    }
  }

  /**
   * Extract ExtensionInstallError fields from unknown catch value.
   * Primary: instanceof check. Fallback: branded property check (handles cross-bundle scenarios).
   */
  private extractExtensionError(e: unknown): { code: string; message: string; hint?: string } {
    if (e instanceof ExtensionInstallError) {
      return { code: e.code, message: e.message, hint: e.hint }
    }
    return { code: 'install_failed', message: toErrorMessage(e) }
  }
}
