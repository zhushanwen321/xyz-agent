# Plan 01: Project Scaffold v2

> Phase 1 — Task 1: Initialize Tauri v2 + Vue 3 + Node.js Sidecar + Shared Types project skeleton.
> Based on spec-v2 corrections: Tailwind v3 (not v4), npm workspace shared types, sidecar subprocess RPC, dynamic WS port discovery.

## Goal

Create a fully compilable and runnable project skeleton with:
- Root npm workspace (`root` + `src` + `sidecar` + `shared`)
- Tauri v2 Rust shell (`src-tauri/`) with sidecar process management
- Vue 3 + Vite + TypeScript frontend (`src/`)
- Node.js Sidecar skeleton (`sidecar/`) — WS server + pi subprocess RPC manager
- Shared protocol types (`shared/`) — npm workspace package
- Tailwind CSS **v3** with `tailwind.config.ts` + `postcss.config.js`
- All config files (tsconfig, vite, tailwind, eslint)
- `npm run dev` launches Tauri dev server with a visible "Hello xyz-agent" page

## Verification Command

```bash
npm run dev  # Should open a Tauri window showing "Hello xyz-agent"
```

---

## Step 1: Root package.json + .gitignore + Shared Workspace Package

### 1.1 Root package.json

- [ ] Create root `package.json` with npm workspaces covering all three packages
  ```json
  {
    "name": "xyz-agent",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "workspaces": [
      "src",
      "sidecar",
      "shared"
    ],
    "scripts": {
      "dev": "tauri dev",
      "dev:vite": "vite",
      "build": "vue-tsc --noEmit && vite build && tauri build",
      "build:vite": "vue-tsc --noEmit && vite build",
      "preview": "vite preview",
      "tauri": "tauri",
      "lint": "eslint .",
      "typecheck": "vue-tsc --noEmit",
      "prepare": "cd .githooks && ./install-hooks.sh"
    },
    "devDependencies": {
      "@tauri-apps/cli": "^2",
      "typescript": "^5.8",
      "vite": "^6",
      "vue-tsc": "^2"
    }
  }
  ```
  > **Key change from v1**: `workspaces` now includes `"src"` and `"shared"` in addition to `"sidecar"`.

### 1.2 .gitignore

- [ ] Create `.gitignore`
  ```
  node_modules/
  dist/
  target/
  .DS_Store
  *.local
  *.log
  .env
  .env.*
  !.env.example
  src-tauri/binaries/
  ~/.xyz-agent/sidecar.port
  ```

### 1.3 Shared types package

- [ ] Create `shared/package.json`
  ```json
  {
    "name": "@xyz-agent/shared",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "src/index.ts",
    "types": "src/index.ts",
    "scripts": {
      "typecheck": "tsc --noEmit"
    },
    "devDependencies": {
      "typescript": "^5.8"
    }
  }
  ```

- [ ] Create `shared/tsconfig.json`
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "declaration": true,
      "declarationMap": true,
      "sourceMap": true,
      "outDir": "dist",
      "rootDir": "src",
      "noEmit": true
    },
    "include": ["src"]
  }
  ```

- [ ] Create `shared/src/protocol.ts` — WS message protocol types
  ```typescript
  // ─── Client → Sidecar messages ───

  export interface ClientMessage {
    type: string
    id?: string
    payload?: unknown
  }

  // Session
  export interface SessionCreatePayload {
    cwd?: string
  }

  export interface SessionDeletePayload {
    sessionId: string
  }

  export interface SessionSwitchPayload {
    sessionId: string
  }

  export interface SessionHistoryPayload {
    sessionId: string
  }

  // Message
  export interface MessageSendPayload {
    sessionId: string
    content: string
  }

  export interface MessageAbortPayload {
    sessionId: string
  }

  // Config
  export interface SetProviderPayload {
    providerId: string
    apiKey?: string
    baseUrl?: string
  }

  export interface DeleteProviderPayload {
    providerId: string
  }

  // Model
  export interface ModelSwitchPayload {
    sessionId: string
    modelId: string
  }

  // ─── Sidecar → Client messages ───

  export interface ServerMessage {
    type: string
    id?: string
    payload?: unknown
  }

  // Session events
  export interface SessionCreatedPayload {
    sessionId: string
    label: string
    cwd: string
  }

  export interface SessionDeletedPayload {
    sessionId: string
  }

  export interface SessionListPayload {
    groups: Array<{
      cwd: string
      sessions: SessionSummary[]
    }>
  }

  // Re-export for convenience
  export type { SessionSummary } from './session'

  // Message events
  export interface TextDeltaPayload {
    sessionId: string
    delta: string
  }

  export interface ThinkingDeltaPayload {
    sessionId: string
    delta: string
  }

  export interface ToolCallStartPayload {
    sessionId: string
    toolCallId: string
    toolName: string
    input: string
  }

  export interface ToolCallEndPayload {
    sessionId: string
    toolCallId: string
    output: string
  }

  export interface MessageCompletePayload {
    sessionId: string
    stopReason: string
    usage?: Usage
  }

  export interface MessageErrorPayload {
    sessionId: string
    error: string
  }

  // Config events
  export interface ProvidersPayload {
    providers: import('./provider').ProviderInfo[]
  }

  // Model events
  export interface ModelListPayload {
    models: import('./provider').ModelInfo[]
  }

  export interface ModelSwitchedPayload {
    sessionId: string
    modelId: string
  }

  // Error
  export interface ErrorPayload {
    message: string
    code?: string
  }

  // Usage
  export interface Usage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  ```

- [ ] Create `shared/src/message.ts` — Message domain types
  ```typescript
  export interface Message {
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    toolCalls?: ToolCall[]
    thinking?: ThinkingBlock[]
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    }
    timestamp: number
  }

  export interface ToolCall {
    id: string
    toolName: string
    input: string
    output?: string
    status: 'running' | 'completed' | 'error'
  }

  export interface ThinkingBlock {
    id: string
    content: string
  }
  ```

- [ ] Create `shared/src/session.ts` — Session domain types
  ```typescript
  export interface SessionSummary {
    id: string
    label: string
    cwd: string
    lastActiveAt: number  // Unix timestamp (Date.now()), NOT ISO string
    status: 'active' | 'idle'
  }

  export interface SessionGroup {
    cwd: string
    sessions: SessionSummary[]
  }
  ```

- [ ] Create `shared/src/provider.ts` — Provider & Model domain types
  ```typescript
  export type ProviderStatus = 'connected' | 'not_configured' | 'error'

  export interface ProviderInfo {
    id: string
    name: string
    status: ProviderStatus  // NOT boolean connected
    models?: ModelInfo[]
  }

  export interface ModelInfo {
    id: string
    name: string
    providerId: string
    tier?: 'fast' | 'standard' | 'powerful'
  }
  ```

- [ ] Create `shared/src/index.ts` — barrel export
  ```typescript
  // Protocol types
  export type {
    ClientMessage,
    ServerMessage,
    SessionCreatePayload,
    SessionDeletePayload,
    SessionSwitchPayload,
    SessionHistoryPayload,
    MessageSendPayload,
    MessageAbortPayload,
    SetProviderPayload,
    DeleteProviderPayload,
    ModelSwitchPayload,
    SessionCreatedPayload,
    SessionDeletedPayload,
    SessionListPayload,
    TextDeltaPayload,
    ThinkingDeltaPayload,
    ToolCallStartPayload,
    ToolCallEndPayload,
    MessageCompletePayload,
    MessageErrorPayload,
    ProvidersPayload,
    ModelListPayload,
    ModelSwitchedPayload,
    ErrorPayload,
    Usage,
  } from './protocol'

  // Message domain types
  export type {
    Message,
    ToolCall,
    ThinkingBlock,
  } from './message'

  // Session domain types
  export type {
    SessionSummary,
    SessionGroup,
  } from './session'

  // Provider domain types
  export type {
    ProviderStatus,
    ProviderInfo,
    ModelInfo,
  } from './provider'

  // App error
  export interface AppError {
    message: string
    code?: 'CONNECTION_LOST' | 'PROVIDER_ERROR' | 'SESSION_NOT_FOUND' | 'PROCESS_CRASHED' | 'TIMEOUT'
    retryable?: boolean
  }
  ```

### 1.4 Commit

- [ ] Commit shared workspace scaffold
  ```bash
  git add -A
  git commit -m "feat(p1): root npm workspace + shared protocol types package

- Root package.json with workspaces: [src, sidecar, shared]
- @xyz-agent/shared: protocol.ts, message.ts, session.ts, provider.ts
- All P1 domain types defined: Message, ToolCall, Session, Provider, etc.
- Sidecar and frontend will import via @xyz-agent/shared"
  ```

---

## Step 2: Tauri v2 Rust Shell

### 2.1 Cargo config

- [ ] Create `src-tauri/Cargo.toml`
  ```toml
  [package]
  name = "xyz-agent"
  version = "0.1.0"
  edition = "2021"

  [lib]
  name = "xyz_agent_lib"
  crate-type = ["lib", "cdylib", "staticlib"]

  [build-dependencies]
  tauri-build = { version = "2", features = [] }

  [dependencies]
  tauri = { version = "2", features = [] }
  tauri-plugin-shell = "2"
  tauri-plugin-dialog = "2"
  tauri-plugin-global-shortcut = "2"
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  tokio = { version = "1", features = ["full"] }
  ```
  > **Key change**: Added `tauri-plugin-shell` (for sidecar), `tauri-plugin-dialog`, `tauri-plugin-global-shortcut`, and `tokio` for async health checks.

- [ ] Create `src-tauri/build.rs`
  ```rust
  fn main() {
      tauri_build::build()
  }
  ```

### 2.2 Rust source files

- [ ] Create `src-tauri/src/lib.rs`
  ```rust
  mod sidecar;

  #[cfg_attr(mobile, tauri::mobile_entry_point)]
  pub fn run() {
      tauri::Builder::default()
          .plugin(tauri_plugin_shell::init())
          .plugin(tauri_plugin_dialog::init())
          .plugin(tauri_plugin_global_shortcut::Builder::new().build())
          .setup(|app| {
              sidecar::start(app)?;
              Ok(())
          })
          .run(tauri::generate_context!())
          .expect("error while running tauri application");
  }
  ```

- [ ] Create `src-tauri/src/main.rs`
  ```rust
  #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

  fn main() {
      xyz_agent_lib::run()
  }
  ```

- [ ] Create `src-tauri/src/sidecar.rs` — sidecar lifecycle management
  ```rust
  use std::fs;
  use std::path::PathBuf;
  use tauri::Manager;
  use tauri_plugin_shell::ShellExt;

  const DEFAULT_PORT: u16 = 3210;
  const MAX_PORT_ATTEMPTS: u32 = 10;

  fn get_port_file_path() -> PathBuf {
      let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
      home.join(".xyz-agent").join("sidecar.port")
  }

  fn find_available_port() -> Option<u16> {
      // Try DEFAULT_PORT first, then increment up to MAX_PORT_ATTEMPTS
      for offset in 0..MAX_PORT_ATTEMPTS {
          let port = DEFAULT_PORT + offset as u16;
          // Basic check: try to bind to see if port is available
          if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
              return Some(port);
          }
      }
      None
  }

  pub fn start(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
      let port = find_available_port()
          .ok_or("No available port for sidecar")?;

      // Write port to temp file for frontend cold-start discovery
      let port_file = get_port_file_path();
      if let Some(parent) = port_file.parent() {
          fs::create_dir_all(parent)?;
      }
      fs::write(&port_file, port.to_string())?;

      // Emit port to frontend via Tauri event
      app.emit("sidecar-port", port)?;

      // Spawn sidecar process
      // In dev mode: node sidecar/dist/index.js --port <port>
      // In production: uses tauri sidecar binary
      #[cfg(debug_assertions)]
      {
          let sidecar_path = std::env::current_dir()?
              .join("sidecar")
              .join("dist")
              .join("index.js");
          let _child = app.shell().command("node")
              .args([sidecar_path.to_str().unwrap_or(""), "--port", &port.to_string()])
              .spawn()?;
      }

      #[cfg(not(debug_assertions))]
      {
          let _child = app.shell().sidecar("binaries/sidecar")
              .map_err(|e| format!("Failed to create sidecar: {}", e))?
              .args(["--port", &port.to_string()])
              .spawn()?;
      }

      Ok(())
  }
  ```
  > **Note**: The `dirs` crate needs to be added to Cargo.toml. Alternatively, use `std::env::var("HOME")` for a zero-dep approach. We'll use `std::env::var("HOME")` to avoid an extra dependency.

  Actually, let's avoid the `dirs` crate. Updated version:

  ```rust
  use std::fs;
  use std::path::PathBuf;
  use tauri::Manager;
  use tauri_plugin_shell::ShellExt;

  const DEFAULT_PORT: u16 = 3210;
  const MAX_PORT_ATTEMPTS: u32 = 10;

  fn get_port_file_path() -> PathBuf {
      let home = std::env::var("HOME")
          .or_else(|_| std::env::var("USERPROFILE"))
          .unwrap_or_else(|_| ".".to_string());
      PathBuf::from(home).join(".xyz-agent").join("sidecar.port")
  }

  fn find_available_port() -> Option<u16> {
      for offset in 0..MAX_PORT_ATTEMPTS {
          let port = DEFAULT_PORT + offset as u16;
          if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
              return Some(port);
          }
      }
      None
  }

  pub fn start(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
      let port = find_available_port()
          .ok_or("No available port for sidecar")?;

      // Write port to temp file
      let port_file = get_port_file_path();
      if let Some(parent) = port_file.parent() {
          fs::create_dir_all(parent)?;
      }
      fs::write(&port_file, port.to_string())?;

      // Emit port to frontend
      app.emit("sidecar-port", port)?;

      // Spawn sidecar
      #[cfg(debug_assertions)]
      {
          let sidecar_path = std::env::current_dir()?
              .join("sidecar")
              .join("dist")
              .join("index.js");
          app.shell().command("node")
              .args([sidecar_path.to_str().unwrap_or(""), "--port", &port.to_string()])
              .spawn()?;
      }

      #[cfg(not(debug_assertions))]
      {
          app.shell().sidecar("binaries/sidecar")
              .map_err(|e| format!("Failed to create sidecar: {}", e))?
              .args(["--port", &port.to_string()])
              .spawn()?;
      }

      Ok(())
  }
  ```

- [ ] Create `src-tauri/tauri.conf.json`
  ```jsonc
  {
    "$schema": "https://raw.githubusercontent.com/nicoverbruggen/tauri-v2-schema/main/schema.json",
    "productName": "xyz-agent",
    "version": "0.1.0",
    "identifier": "com.xyz-agent.app",
    "build": {
      "frontendDist": "../dist",
      "devUrl": "http://localhost:1420",
      "beforeDevCommand": "npm run dev:vite",
      "beforeBuildCommand": "npm run build:vite"
    },
    "app": {
      "withGlobalTauri": false,
      "windows": [
        {
          "title": "xyz-agent",
          "width": 1200,
          "height": 800,
          "minWidth": 800,
          "minHeight": 600,
          "resizable": true,
          "fullscreen": false
        }
      ],
      "security": {
        "csp": null
      }
    },
    "bundle": {
      "active": true,
      "targets": "all",
      "icon": [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico"
      ],
      "externalBin": ["binaries/sidecar"]
    },
    "plugins": {
      "shell": {
        "sidecar": true,
        "scope": [
          {
            "name": "binaries/sidecar",
            "sidecar": true
          }
        ]
      }
    }
  }
  ```
  > **Key change**: Added `bundle.externalBin` and `plugins.shell` config for sidecar management.

- [ ] Create `src-tauri/icons/` placeholder
  ```bash
  mkdir -p src-tauri/icons
  ```
  > Use `npx tauri icon` later to generate proper icons.

### 2.3 Commit

- [ ] Commit Tauri shell
  ```bash
  git add -A
  git commit -m "feat(p1): Tauri v2 Rust shell with sidecar lifecycle

- Cargo.toml with shell/dialog/global-shortcut plugins
- sidecar.rs: dynamic port discovery, port file, sidecar spawn
- tauri.conf.json: externalBin + shell plugin config
- lib.rs: plugin registration + sidecar startup in setup()"
  ```

---

## Step 3: Vue 3 + Vite + TypeScript Frontend

### 3.1 Frontend package.json

- [ ] Create `src/package.json` (workspace member)
  ```json
  {
    "name": "@xyz-agent/frontend",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "vite",
      "build": "vue-tsc --noEmit && vite build",
      "typecheck": "vue-tsc --noEmit"
    }
  }
  ```
  > **Note**: Dependencies will be hoisted to root via npm workspaces. The `src/` package exists so it can import `@xyz-agent/shared` as a workspace dependency.

  Actually, since the root `package.json` already has `workspaces: ["src", "sidecar", "shared"]`, npm will hoist all deps. We install frontend deps at root level and they're available everywhere. The `src/package.json` doesn't need its own `dependencies` — they're resolved from root. But we do need to declare the dependency on shared:

  ```json
  {
    "name": "@xyz-agent/frontend",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "dependencies": {
      "@xyz-agent/shared": "workspace:*"
    },
    "scripts": {
      "dev": "vite",
      "build": "vue-tsc --noEmit && vite build",
      "typecheck": "vue-tsc --noEmit"
    }
  }
  ```

  > **Note**: `workspace:*` ensures npm links to the local shared package. All other dependencies (vue, pinia, etc.) are in root `devDependencies` for hoisting.

### 3.2 Install frontend dependencies

- [ ] Install all frontend deps at root level (npm workspaces hoists them)
  ```bash
  npm install vue @vueuse/core pinia pinia-plugin-persistedstate
  npm install radix-vue reka-ui class-variance-authority clsx tailwind-merge
  npm install lucide-vue-next markdown-it dompurify vue-sonner
  npm install vue-i18n @tanstack/vue-virtual @tauri-apps/api @tauri-apps/plugin-shell @tauri-apps/plugin-dialog @tauri-apps/plugin-global-shortcut
  npm install -D @vitejs/plugin-vue vite tailwindcss postcss autoprefixer
  npm install -D @types/markdown-it @types/dompurify
  ```

### 3.3 Config files

- [ ] Create `index.html`
  ```html
  <!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>xyz-agent</title>
    </head>
    <body>
      <div id="app"></div>
      <script type="module" src="/src/main.ts"></script>
    </body>
  </html>
  ```

- [ ] Create `vite.config.ts`
  ```typescript
  import { defineConfig } from "vite"
  import vue from "@vitejs/plugin-vue"
  import { resolve } from "path"

  const host = process.env.TAURI_DEV_HOST

  export default defineConfig({
    plugins: [vue()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: {
      target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
      minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
  })
  ```

- [ ] Create `tsconfig.json` (root — for frontend + shared)
  ```json
  {
    "compilerOptions": {
      "target": "ES2021",
      "useDefineForClassFields": true,
      "module": "ESNext",
      "lib": ["ES2021", "DOM", "DOM.Iterable"],
      "skipLibCheck": true,
      "moduleResolution": "bundler",
      "allowImportingTsExtensions": true,
      "isolatedModules": true,
      "moduleDetection": "force",
      "noEmit": true,
      "jsx": "preserve",
      "strict": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "noFallthroughCasesInSwitch": true,
      "noUncheckedIndexedAccess": true,
      "paths": {
        "@/*": ["./src/*"],
        "@xyz-agent/shared": ["./shared/src/index.ts"],
        "@xyz-agent/shared/*": ["./shared/src/*"]
      }
    },
    "include": [
      "src/**/*.ts",
      "src/**/*.d.ts",
      "src/**/*.vue",
      "shared/**/*.ts"
    ],
    "references": [{ "path": "./tsconfig.node.json" }]
  }
  ```
  > **Key change**: Added `@xyz-agent/shared` path alias pointing to `shared/src/index.ts`, and included `shared/**/*.ts` in compilation.

- [ ] Create `tsconfig.node.json`
  ```json
  {
    "compilerOptions": {
      "target": "ES2021",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "allowImportingTsExtensions": true,
      "composite": true,
      "skipLibCheck": true,
      "noEmit": true
    },
    "include": ["vite.config.ts"]
  }
  ```

### 3.4 Source files

- [ ] Create `src/env.d.ts`
  ```typescript
  /// <reference types="vite/client" />

  declare module "*.vue" {
    import type { DefineComponent } from "vue"
    const component: DefineComponent<object, object, unknown>
    export default component
  }
  ```

- [ ] Create `src/assets/main.css` — Tailwind v3 entry with CSS custom properties
  ```css
  @tailwind base;
  @tailwind components;
  @tailwind utilities;

  :root {
    /* Minimal tokens for scaffold — full set added in Plan 02 */
    --color-bg-base: #ffffff;
    --color-surface: #fafafa;
    --color-text-primary: #1a1a1a;
    --color-text-muted: #666666;
    --color-border: #e0e0e0;
    --color-accent: #b45309;
    --color-accent-light: #fef3c7;
  }

  .dark {
    --color-bg-base: #141414;
    --color-surface: #1a1a1a;
    --color-text-primary: #ebebeb;
    --color-text-muted: #888888;
    --color-border: #333333;
    --color-accent: #d97706;
    --color-accent-light: #292524;
  }

  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  }
  ```
  > **Key change**: Tailwind v3 uses `@tailwind base/components/utilities` directives, NOT `@import "tailwindcss"`. Full oklch tokens will be added in Plan 02 (Foundation).

- [ ] Create `src/main.ts`
  ```typescript
  import { createApp } from "vue"
  import { createPinia } from "pinia"
  import App from "./App.vue"
  import "./assets/main.css"

  const app = createApp(App)
  app.use(createPinia())
  app.mount("#app")
  ```

- [ ] Create `src/App.vue` (minimal skeleton)
  ```vue
  <script setup lang="ts">
  import { ref } from "vue"

  const greeting = ref("Hello xyz-agent")
  </script>

  <template>
    <div class="flex h-screen items-center justify-center bg-base text-foreground">
      <h1 class="text-2xl font-bold">{{ greeting }}</h1>
    </div>
  </template>
  ```

### 3.5 Commit

- [ ] Commit frontend scaffold
  ```bash
  git add -A
  git commit -m "feat(p1): Vue 3 + Vite + TypeScript frontend skeleton

- src/package.json as workspace member with @xyz-agent/shared dependency
- tsconfig.json with @xyz-agent/shared path alias
- Tailwind v3 entry CSS with minimal design tokens
- Vite config with Tauri dev server integration
- App.vue with Hello xyz-agent placeholder"
  ```

---

## Step 4: Tailwind CSS v3 Configuration

> **Critical**: This project uses Tailwind CSS **v3** (JS config), NOT v4 (CSS-first).

### 4.1 Config files

- [ ] Create `tailwind.config.ts`
  ```typescript
  import type { Config } from "tailwindcss"

  export default {
    darkMode: "class",
    content: ["./index.html", "./src/**/*.{vue,ts}"],
    theme: {
      extend: {
        colors: {
          // Design token colors → CSS variable references
          "bg-base": "var(--color-bg-base)",
          surface: "var(--color-surface)",
          "text-primary": "var(--color-text-primary)",
          "text-muted": "var(--color-text-muted)",
          border: "var(--color-border)",
          accent: {
            DEFAULT: "var(--color-accent)",
            light: "var(--color-accent-light)",
          },

          // shadcn-vue standard aliases
          primary: {
            DEFAULT: "var(--color-accent)",
            foreground: "var(--color-primary-foreground, #ffffff)",
          },
          destructive: {
            DEFAULT: "var(--color-danger, #ef4444)",
            foreground: "var(--color-destructive-foreground, #ffffff)",
          },
          muted: {
            DEFAULT: "var(--color-muted, #f5f5f5)",
            foreground: "var(--color-muted-foreground, #666666)",
          },
          background: "var(--color-bg-base)",
          foreground: "var(--color-text-primary)",
          ring: "var(--color-accent)",
          input: "var(--color-border)",
        },
        fontFamily: {
          display: "var(--font-display, Georgia, serif)",
          body: "var(--font-body, system-ui, sans-serif)",
          mono: "var(--font-mono, ui-monospace, monospace)",
        },
        borderRadius: {
          lg: "var(--radius-lg, 12px)",
          md: "var(--radius-md, 8px)",
          sm: "var(--radius-sm, 4px)",
        },
      },
    },
    plugins: [],
  } satisfies Config
  ```
  > **Key**: v3 uses `theme.extend.colors` to map CSS variables. This enables `bg-bg-base`, `text-text-primary`, `bg-primary`, etc. Full oklch values + shadcn-vue aliases in Plan 02.

- [ ] Create `postcss.config.js`
  ```javascript
  export default {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  }
  ```
  > **Tailwind v3 requires PostCSS**. This is the v3 way — v4 would use `@tailwindcss/vite` plugin instead.

### 4.2 Update vite.config.ts (no changes needed for v3)

Tailwind v3 processes CSS through PostCSS automatically. No Vite plugin needed (unlike v4 which uses `@tailwindcss/vite`). The `postcss.config.js` is picked up by Vite automatically.

- [ ] Verify `vite.config.ts` does NOT have `@tailwindcss/vite` import. If it does, remove it.

### 4.3 Commit

- [ ] Commit Tailwind v3 config
  ```bash
  git add -A
  git commit -m "feat(p1): Tailwind CSS v3 with JS config + PostCSS

- tailwind.config.ts: CSS variable color mappings + shadcn-vue aliases
- postcss.config.js: tailwindcss + autoprefixer plugins
- No @tailwindcss/vite — v3 uses PostCSS pipeline"
  ```

---

## Step 5: Node.js Sidecar Skeleton

### 5.1 Sidecar package

- [ ] Create `sidecar/package.json`
  ```json
  {
    "name": "xyz-agent-sidecar",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "dependencies": {
      "@xyz-agent/shared": "workspace:*",
      "ws": "^8"
    },
    "devDependencies": {
      "@types/ws": "^8",
      "@types/node": "^22",
      "typescript": "^5.8",
      "tsx": "^4"
    },
    "scripts": {
      "dev": "tsx watch src/index.ts",
      "build": "tsc",
      "start": "node dist/index.js"
    }
  }
  ```
  > **Key changes from v1**: Added `@xyz-agent/shared` dependency. `@mariozechner/pi-coding-agent` will be added in Plan 04 (Communication Layer) when we implement actual RPC.

- [ ] Create `sidecar/tsconfig.json`
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "outDir": "dist",
      "rootDir": "src",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "declaration": true,
      "paths": {
        "@xyz-agent/shared": ["../shared/src/index.ts"],
        "@xyz-agent/shared/*": ["../shared/src/*"]
      }
    },
    "include": ["src"]
  }
  ```
  > **Key**: Path alias for `@xyz-agent/shared` so TypeScript resolves it during development.

### 5.2 Sidecar source files

- [ ] Create `sidecar/src/index.ts` — Entry point: CLI arg parsing + WS server + HTTP health
  ```typescript
  import { createServer } from "http"
  import { WebSocketServer } from "ws"
  import { createSessionRouter } from "./server.js"

  // Parse --port from CLI args (provided by Tauri sidecar.rs)
  const args = process.argv.slice(2)
  let port = 3210
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10)
      i++
    }
  }

  // Create HTTP server for health checks + WS upgrade
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("ok")
    } else {
      res.writeHead(404).end()
    }
  })

  // Create WebSocket server on the same HTTP server
  const wss = new WebSocketServer({ server })

  // Wire up message routing
  const router = createSessionRouter()
  wss.on("connection", (ws) => {
    console.log("[sidecar] client connected")
    router.handleConnection(ws)

    ws.on("close", () => {
      console.log("[sidecar] client disconnected")
    })
  })

  server.listen(port, () => {
    console.log(`[sidecar] listening on port ${port} (WS + HTTP /health)`)
  })
  ```

- [ ] Create `sidecar/src/server.ts` — WS message routing
  ```typescript
  import type { WebSocket } from "ws"
  import type { ClientMessage, ServerMessage } from "@xyz-agent/shared"

  export function createSessionRouter() {
    function send(ws: WebSocket, msg: ServerMessage) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    }

    return {
      handleConnection(ws: WebSocket) {
        ws.on("message", (raw) => {
          const msg: ClientMessage = JSON.parse(raw.toString())
          console.log("[sidecar] received:", msg.type)

          switch (msg.type) {
            case "ping":
              send(ws, { type: "pong", id: msg.id })
              break
            case "session.list":
              // TODO (Plan 04): implement session pool
              send(ws, {
                type: "session.list",
                id: msg.id,
                payload: { groups: [] },
              })
              break
            case "model.list":
              // TODO (Plan 04): query pi subprocess
              send(ws, {
                type: "model.list",
                id: msg.id,
                payload: { models: [] },
              })
              break
            case "config.getProviders":
              // TODO (Plan 04): read provider store
              send(ws, {
                type: "config.providers",
                id: msg.id,
                payload: { providers: [] },
              })
              break
            default:
              console.log("[sidecar] unhandled message type:", msg.type)
              send(ws, {
                type: "error",
                id: msg.id,
                payload: { message: `Unknown type: ${msg.type}` },
              })
          }
        })
      },
    }
  }
  ```

- [ ] Create placeholder modules (stubs for Plan 04)
  ```typescript
  // sidecar/src/session-pool.ts
  // TODO (Plan 04): Map<sessionId, PiProcess> management
  export class SessionPool {
    // Will manage pi subprocess instances
  }
  ```

  ```typescript
  // sidecar/src/process-manager.ts
  // TODO (Plan 04): pi subprocess lifecycle (spawn/kill/restart)
  export class ProcessManager {
    // Will spawn pi --mode rpc and manage stdin/stdout JSONL
  }
  ```

  ```typescript
  // sidecar/src/rpc-client.ts
  // TODO (Plan 04): stdin/stdout JSONL RPC protocol client
  export class RpcClient {
    // Will wrap pi subprocess communication
  }
  ```

  ```typescript
  // sidecar/src/event-adapter.ts
  // TODO (Plan 04): pi RPC events → WS protocol events translation
  export function adaptPiEvent(rpcEvent: unknown): unknown {
    // Will map pi event names to WS protocol event names
    return rpcEvent
  }
  ```

  ```typescript
  // sidecar/src/config-store.ts
  // TODO (Plan 04): xyz-agent settings read/write (~/.xyz-agent/settings.json)
  ```

  ```typescript
  // sidecar/src/provider-store.ts
  // TODO (Plan 04): Provider API Key management + env var injection
  ```

### 5.3 Commit

- [ ] Commit sidecar skeleton
  ```bash
  git add -A
  git commit -m "feat(p1): Node.js Sidecar skeleton with WS server

- sidecar/package.json with @xyz-agent/shared workspace dependency
- index.ts: CLI --port parsing + HTTP /health + WS server
- server.ts: message routing with shared protocol types
- Stub modules for Plan 04: session-pool, process-manager, rpc-client, etc.
- Health endpoint for Tauri sidecar.rs to poll"
  ```

---

## Step 6: ESLint Flat Config Skeleton

### 6.1 ESLint setup

- [ ] Install ESLint dev dependencies at root
  ```bash
  npm install -D eslint @eslint/js typescript-eslint eslint-plugin-vue
  ```

- [ ] Create `eslint.config.mjs`
  ```javascript
  import eslint from "@eslint/js"
  import tseslint from "typescript-eslint"
  import pluginVue from "eslint-plugin-vue"

  export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    ...pluginVue.configs["flat/recommended"],
    {
      files: ["**/*.vue"],
      languageOptions: {
        parserOptions: {
          parser: tseslint.parser,
        },
      },
    },
    {
      rules: {
        "vue/multi-word-component-names": "off",
      },
    },
    {
      ignores: [
        "dist/",
        "node_modules/",
        "target/",
        "sidecar/dist/",
        "src-tauri/",
      ],
    }
  )
  ```
  > Taste-lint custom rules will be added in Plan 02 (Foundation).

### 6.2 Commit

- [ ] Commit ESLint config
  ```bash
  git add -A
  git commit -m "feat(p1): ESLint flat config skeleton

- Base: recommended + typescript-eslint + vue plugin
- Ignores: dist/, node_modules/, target/, sidecar/dist/, src-tauri/
- Custom taste-lint rules deferred to Plan 02"
  ```

---

## Step 7: Install, Build & Verify

### 7.1 Install all dependencies

- [ ] Run full install (npm workspaces resolves all packages)
  ```bash
  npm install
  ```

### 7.2 Build sidecar TypeScript

- [ ] Compile sidecar to dist/
  ```bash
  cd sidecar && npx tsx src/index.ts --port 3210 &
  # Ctrl+C after seeing "listening on port 3210"
  # Or build:
  cd sidecar && npx tsc
  ```

### 7.3 Verify TypeScript (frontend + shared)

- [ ] Type-check frontend
  ```bash
  npx vue-tsc --noEmit
  ```
  > Must pass with zero errors. Verify `@xyz-agent/shared` imports resolve correctly.

### 7.4 Verify Vite build

- [ ] Build frontend
  ```bash
  npx vite build
  ```
  > Should produce `dist/` with `index.html` and assets.

### 7.5 Verify Rust compilation

- [ ] Check Rust
  ```bash
  cd src-tauri && cargo check
  ```
  > Must pass. May need `cargo build` first to fetch crates.

### 7.6 Verify sidecar independently

- [ ] Start sidecar standalone
  ```bash
  cd sidecar && npx tsx src/index.ts --port 3210
  ```
  > Should log: `[sidecar] listening on port 3210 (WS + HTTP /health)`

- [ ] Test health endpoint
  ```bash
  curl http://localhost:3210/health
  ```
  > Should return: `ok`

### 7.7 Verify Tauri dev launch

- [ ] Launch full stack
  ```bash
  npm run dev
  ```
  > Should open a Tauri desktop window displaying "Hello xyz-agent".

### 7.8 Commit verification

- [ ] Commit any fixups from verification
  ```bash
  git add -A
  git commit -m "fix(p1): resolve scaffold verification issues" || echo "No changes needed"
  ```

---

## Step 8: Final File Tree Verification

- [ ] Verify the complete file tree
  ```bash
  find . -not -path '*/node_modules/*' -not -path '*/target/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.superpowers/*' -type f | sort
  ```

  Expected output:
  ```
  .gitignore
  .githooks/install-hooks.sh
  .githooks/vue_rules_checker.py
  eslint.config.mjs
  index.html
  package.json
  postcss.config.js
  shared/package.json
  shared/src/index.ts
  shared/src/message.ts
  shared/src/protocol.ts
  shared/src/provider.ts
  shared/src/session.ts
  shared/tsconfig.json
  sidecar/package.json
  sidecar/src/config-store.ts
  sidecar/src/event-adapter.ts
  sidecar/src/index.ts
  sidecar/src/process-manager.ts
  sidecar/src/provider-store.ts
  sidecar/src/rpc-client.ts
  sidecar/src/server.ts
  sidecar/src/session-pool.ts
  sidecar/tsconfig.json
  src/App.vue
  src/assets/main.css
  src/env.d.ts
  src/main.ts
  src/package.json
  src-tauri/Cargo.toml
  src-tauri/build.rs
  src-tauri/src/lib.rs
  src-tauri/src/main.rs
  src-tauri/src/sidecar.rs
  src-tauri/tauri.conf.json
  tailwind.config.ts
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  ```
  > `.githooks/` files may not exist yet — they're created in Plan 02.

---

## Summary of Key Differences from v1 Plan

| Aspect | v1 Plan (old) | v2 Plan (this) |
|--------|---------------|----------------|
| Tailwind CSS | v4 (`@import "tailwindcss"` + `@theme`) | **v3** (`tailwind.config.ts` + `postcss.config.js` + `@tailwind` directives) |
| Shared types | None (each package had own types) | **`shared/`** npm workspace package with `@xyz-agent/shared` |
| Root workspaces | `["sidecar"]` | **`["src", "sidecar", "shared"]`** |
| Sidecar architecture | WS echo server only | **WS server + HTTP /health + CLI --port + stub RPC modules** |
| Sidecar dependencies | `ws` only | `ws` + **`@xyz-agent/shared`** (pi SDK added in Plan 04) |
| WS port | Hardcoded `9250` | **Dynamic `3210+`** via Tauri `sidecar.rs` + `--port` CLI arg + port file |
| Tauri Rust | Minimal (no plugins) | **Shell + Dialog + GlobalShortcut plugins + sidecar.rs lifecycle** |
| Frontend package | No separate package.json | **`src/package.json`** with `@xyz-agent/shared` dependency |
| Frontend deps | `@tauri-apps/api` only | **+ plugin-shell, plugin-dialog, plugin-global-shortcut** |

---

## What's Next

After this plan completes, the project has a runnable skeleton with shared types. Proceed to:
- **Plan 02**: Foundation layer — Full Design Tokens (oklch), Theme System, i18n, taste-lint rules, Git Hooks
- **Plan 03**: UI Shell — Layout components, Sidebar, Header, Statusbar, view switching
- **Plan 04**: Communication Layer — WS client, sidecar RPC integration, event adapter, Pinia stores
