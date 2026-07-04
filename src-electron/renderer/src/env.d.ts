/// <reference types="vite/client" />

/** vite define 注入的 xyz-agent 版本号（renderer/vite.config.ts，来自 package.json）。 */
declare const __APP_VERSION__: string

declare module "*.vue" {
  import type { DefineComponent } from "vue"
  const component: DefineComponent<object, object, unknown>
  export default component
}
