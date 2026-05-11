export type AppErrorCode =
  | 'CONNECTION_LOST'
  | 'PROVIDER_ERROR'
  | 'SESSION_NOT_FOUND'
  | 'PROCESS_CRASHED'
  | 'TIMEOUT'
  | 'CONTEXT_OVERFLOW'
  | 'AUTH_ERROR'
  | 'RATE_LIMIT'

export interface AppError {
  message: string
  code?: AppErrorCode
  retryable?: boolean
}
