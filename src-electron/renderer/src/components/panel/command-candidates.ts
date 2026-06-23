/**
 * @ 引用 / # 文件候选（搜索能力，后端从零，属后续第4项协议缺口）。
 *
 * 当前为静态 fixture：组件不再直接 import api/mock/composer-data，改从这里取常量。
 * 后端搜索能力就绪后，改为 api 调用（订阅/请求），届时本文件可移除。
 */

export interface MentionCandidate {
  id: string
  name: string
  kind: string
  icon: string
  path?: string
}

export interface FileCandidate {
  id: string
  name: string
  kind: string
  path?: string
}

export const MENTION_CANDIDATES: MentionCandidate[] = [
  { id: 'mention-auth-service', name: 'AuthService.ts', kind: '文件', icon: 'file', path: 'src/auth/AuthService.ts' },
  { id: 'mention-token-validator', name: 'TokenValidator', kind: '符号', icon: 'symbol' },
  { id: 'mention-form-validation', name: '表单校验规范', kind: '技能', icon: 'skill' },
  { id: 'mention-token-file', name: 'token.ts', kind: '文件', icon: 'file', path: 'src/auth/token.ts' },
]

export const FILE_CANDIDATES: FileCandidate[] = [
  { id: 'file-src-auth', name: 'src/auth/', kind: '目录', path: 'src/auth/' },
  { id: 'file-auth-service', name: 'AuthService.ts', kind: '文件', path: 'src/auth/AuthService.ts' },
  { id: 'file-token', name: 'token.ts', kind: '文件', path: 'src/auth/token.ts' },
]
