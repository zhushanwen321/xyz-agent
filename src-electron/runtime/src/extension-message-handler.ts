/**
 * Extension message handler for extension.* message types.
 * Extracted from SidecarServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService, IExtensionService } from './interfaces.js'
import type { ExtensionTimeoutManager } from './extension-timeout-manager.js'
import { ExtensionInstallError } from './extension-service.js'

/** Interface for server methods needed by this handler */
export interface ExtensionHandlerContext {
  sessionService: ISessionService
  extensionService: IExtensionService | undefined
  extensionTimeoutMgr: ExtensionTimeoutManager
  send(ws: WsType, msg: ServerMessage): void
  sendError(ws: WsType, code: string, message: string, id?: string, sessionId?: string): void
}

export class ExtensionMessageHandler {
  constructor(private ctx: ExtensionHandlerContext) {}

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
          return this.ctx.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions: [] } })
        }
        const extensions = await this.ctx.extensionService.scanExtensions()
        return this.ctx.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions } })
      }
      case 'extension.toggle': {
        if (!this.ctx.extensionService) {
          return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          await this.ctx.extensionService.toggleExtension(msg.payload.name, msg.payload.enabled)
          const extensions = await this.ctx.extensionService.scanExtensions()
          return this.ctx.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions } })
        } catch (e) {
          return this.ctx.sendError(ws, 'toggle_failed', e instanceof Error ? e.message : String(e), msg.id)
        }
      }
      case 'extension.install': {
        if (!this.ctx.extensionService) {
          return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          await this.ctx.extensionService.installExtension(msg.payload.source)
        } catch (e) {
          return this.ctx.send(ws, {
            type: 'extension.installError',
            id: msg.id,
            payload: this.extractExtensionError(e),
          })
        }
        const installed = await this.ctx.extensionService.scanExtensions()
        return this.ctx.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions: installed } })
      }
      case 'extension.uninstall': {
        if (!this.ctx.extensionService) {
          return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          await this.ctx.extensionService.uninstallExtension(msg.payload.name)
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          return this.ctx.sendError(ws, 'uninstall_failed', errMsg, msg.id)
        }
        const uninstalled = await this.ctx.extensionService.scanExtensions()
        return this.ctx.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions: uninstalled } })
      }
      // ── Local directory / Git / finish install ────────────────────
      case 'extension.installDir': {
        if (!this.ctx.extensionService) {
          return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          const { path: sourcePath } = msg.payload as { path: string }
          if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.installDir requires a non-empty "path" string', msg.id)
          }
          const result = await this.ctx.extensionService.installLocalDirectory(sourcePath)
          return this.ctx.send(ws, { type: 'extension.discovered', id: msg.id, payload: { tempDir: result.tempDir, candidates: result.candidates } })
        } catch (e) {
          return this.ctx.send(ws, { type: 'extension.installError', id: msg.id, payload: this.extractExtensionError(e) })
        }
      }
      case 'extension.installGit': {
        if (!this.ctx.extensionService) {
          return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          const { url } = msg.payload as { url: string }
          if (typeof url !== 'string' || url.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.installGit requires a non-empty "url" string', msg.id)
          }
          const result = await this.ctx.extensionService.installGitRepository(url)
          return this.ctx.send(ws, { type: 'extension.discovered', id: msg.id, payload: { tempDir: result.tempDir, candidates: result.candidates } })
        } catch (e) {
          return this.ctx.send(ws, { type: 'extension.installError', id: msg.id, payload: this.extractExtensionError(e) })
        }
      }
      case 'extension.finishInstall': {
        if (!this.ctx.extensionService) {
          return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          const { tempDir, selected } = msg.payload as { tempDir: string; selected: string[] }
          if (typeof tempDir !== 'string' || !Array.isArray(selected)) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.finishInstall requires tempDir (string) and selected (string[])', msg.id)
          }
          await this.ctx.extensionService.finishInstall(tempDir, selected)
          const extensions = await this.ctx.extensionService.scanExtensions()
          return this.ctx.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions } })
        } catch (e) {
          return this.ctx.send(ws, { type: 'extension.installError', id: msg.id, payload: this.extractExtensionError(e) })
        }
      }
      case 'extension.cancelInstall': {
        if (!this.ctx.extensionService) {
          return this.ctx.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          const { tempDir } = msg.payload as { tempDir: string }
          if (typeof tempDir !== 'string' || tempDir.length === 0) {
            return this.ctx.sendError(ws, 'invalid_payload', 'extension.cancelInstall requires a non-empty "tempDir" string', msg.id)
          }
          await this.ctx.extensionService.cancelInstall(tempDir)
          return this.ctx.send(ws, { type: 'extension.installCancelled', id: msg.id, payload: {} })
        } catch (e) {
          return this.ctx.send(ws, { type: 'extension.installError', id: msg.id, payload: this.extractExtensionError(e) })
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
    return { code: 'install_failed', message: e instanceof Error ? e.message : String(e) }
  }
}
