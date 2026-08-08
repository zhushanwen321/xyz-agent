/**
 * AuthService — OAuth login 编排服务（slice design I1/T5）。
 *
 * 职责：
 * - login(providerId)：启动 OAuth flow（异步跑 runOAuthLogin），中间态经 broadcast
 *   推 auth.deviceCode / auth.authUrl，终态 auth.success / auth.error
 * - cancel(providerId)：abort 进行中的 flow（停轮询 / 关 callback server / 清 state）
 * - hasOAuth(providerId)：读 auth.json 是否有 oauth 凭据（provider 列表徽章数据源）
 * - both 清理②（I9）：login 成功后清 models.json apiKey——authMode='both' 的 provider
 *   切换认证方式时清另一种凭据，避免 pi 优先级困惑
 *
 * 装配对齐 HandoffService 先例：broadcast + nextPushId 由组合根注入（server/broker），
 * 不直接依赖 server；clearApiKey 是窄函数（组合根闭包包 pi-provider-store），避免
 * 与 configService 形成依赖环。
 *
 * 安全红线：auth.* 事件 payload 只含 providerId/url/userCode，token 永不出现在
 * 事件与日志中；错误消息只含 HTTP 状态/字段名，不含响应体。
 */
import type { BuiltinOAuthConfig, ServerMessage, ServerMessageMap } from '@xyz-agent/shared'
import type { IAuthService } from '../../interfaces.js'
import type { AuthStorage } from './auth-storage.js'
import { runOAuthLogin } from './oauth-flow.js'

export interface AuthServiceDeps {
  /** auth.json 存储（组合根按 getPiAgentDir()/auth.json 构造） */
  authStorage: Pick<AuthStorage, 'get' | 'getAll' | 'set' | 'remove' | 'hasOAuth'>
  /** 取 provider 的 oauthConfig（builtin-providers.json，无则返回 undefined） */
  getOAuthConfig(providerId: string): BuiltinOAuthConfig | undefined
  /** 推 server→client 事件（auth.* 系列） */
  broadcast(msg: ServerMessage): void
  /** 事件 id 生成（对齐 broker.nextPushId） */
  nextPushId(): string
  /** I9 清理②：OAuth 授权成功后清 models.json apiKey（幂等，无 apiKey 时 no-op） */
  clearApiKey(providerId: string): void
}

type AuthEventType = 'auth.deviceCode' | 'auth.authUrl' | 'auth.success' | 'auth.error'

export class AuthService implements IAuthService {
  /** 进行中的 flow：providerId → abort controller（并发多 provider 互不干扰） */
  private activeFlows = new Map<string, AbortController>()

  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * 启动 OAuth login（异步执行，立即返回 started 状态）。
   * 已有进行中 flow 或 provider 无 oauthConfig → 返回 started:false + error。
   */
  login(providerId: string): { started: boolean; error?: string } {
    const config = this.deps.getOAuthConfig(providerId)
    if (!config) {
      return { started: false, error: `provider "${providerId}" 不支持 OAuth` }
    }
    if (this.activeFlows.has(providerId)) {
      return { started: false, error: '已有进行中的 OAuth 授权流程' }
    }
    const controller = new AbortController()
    this.activeFlows.set(providerId, controller)
    void this.runFlow(providerId, config, controller.signal)
    return { started: true }
  }

  /**
   * 中止进行中的 OAuth flow。幂等：无进行中 flow 返回 cancelled:false（不报错）。
   * 同步清 activeFlows（不等 abort 异步链走完）——cancel 后立即重新 login 不被拒。
   * finally 的 delete 幂等兼容（Map.delete 不存在时 no-op）。
   */
  cancel(providerId: string): { cancelled: boolean } {
    const controller = this.activeFlows.get(providerId)
    if (!controller) return { cancelled: false }
    controller.abort()
    this.activeFlows.delete(providerId)
    return { cancelled: true }
  }

  /** 读 auth.json：该 provider 是否有 oauth 凭据（列表徽章 / OAuthDialog 已授权态） */
  async hasOAuth(providerId: string): Promise<boolean> {
    return this.deps.authStorage.hasOAuth(providerId)
  }

  private async runFlow(providerId: string, config: BuiltinOAuthConfig, signal: AbortSignal): Promise<void> {
    try {
      const credential = await runOAuthLogin(providerId, config, {
        onDeviceCode: (info) => this.broadcastAuth('auth.deviceCode', {
          providerId,
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          verificationUriComplete: info.verificationUriComplete,
          expiresIn: info.expiresIn,
          interval: info.interval,
        }),
        onAuthUrl: (info) => this.broadcastAuth('auth.authUrl', {
          providerId,
          url: info.url,
          callbackPort: info.callbackPort,
        }),
      }, signal)
      // S-7（R3 review）：cancel 落在「token 获取完成 → 写盘」窗口时，不落盘、不广播——
      // cancel() 已返回 {cancelled:true}，迟到 success 会让前端状态机 cancelled/authorized 并存。
      // abort 检查只在 catch 块不够：token 正常返回不代表用户没取消。
      if (signal.aborted) return
      // token 写 auth.json（0600 + per-file mutex + 原子写），pi 侧 resolveStoredOAuth 自动 refresh
      await this.deps.authStorage.set(providerId, credential)
      // S-8（R4 review）：S-7 早退只挡 set() 之前的窗口——cancel 落在 set() 的锁等待期间
      // （proper-lockfile，pi 侧 refresh 持锁时重试可达秒级）凭据已写盘，迟到的 auth.success
      // 仍会造成 cancelled/authorized 并存。broadcast 前再查一次 abort，且 best-effort 移除
      // 刚写入的凭据（用户已取消，不留盘）；失败仅 warn 不改变早退语义。
      if (signal.aborted) {
        try {
          await this.deps.authStorage.remove(providerId)
        } catch (error) {
          console.warn(`[auth-service] remove cancelled OAuth credential failed for ${providerId}:`, error)
        }
        return
      }
      // I9 清理②：OAuth 授权成功 → 清 models.json apiKey（both provider 切换凭据源，防冲突）。
      // 清理是次要副作用：失败降级为警告日志，不改变 auth.success（凭据已写入，pi 侧可正常使用）。
      try {
        this.deps.clearApiKey(providerId)
      } catch (error) {
        console.warn(`[auth-service] clearApiKey failed for ${providerId} (models.json apiKey 残留):`, error)
      }
      this.broadcastAuth('auth.success', { providerId })
    } catch (error) {
      if (signal.aborted) {
        // 用户取消：前端对话框已关闭，不发错误事件（cancel RPC 已确认）
        return
      }
      const message = error instanceof Error ? error.message : 'OAuth 授权失败'
      this.broadcastAuth('auth.error', { providerId, message })
    } finally {
      this.activeFlows.delete(providerId)
    }
  }

  private broadcastAuth<T extends AuthEventType>(type: T, payload: ServerMessageMap[T]): void {
    this.deps.broadcast({ type, id: this.deps.nextPushId(), payload })
  }
}
