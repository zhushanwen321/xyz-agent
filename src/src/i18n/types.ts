import zhCN from './locales/zh-CN'

export type MessageSchema = typeof zhCN

declare module 'vue-i18n' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation for vue-i18n locale type
  export interface DefineLocaleMessage extends MessageSchema {}
}
