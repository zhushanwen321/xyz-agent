/// <reference types="vite/client" />

/** vite define 注入的版本号（同 renderer，来自 apps/electron/package.json）。 */
declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
