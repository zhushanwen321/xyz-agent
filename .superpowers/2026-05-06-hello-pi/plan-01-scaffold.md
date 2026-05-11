# Plan 01: Project Scaffold

> Phase 1 rewrite — Task 1: Initialize Tauri v2 + Vue 3 + Node.js Sidecar project skeleton.
> After Task 0 cleanup, the repo contains only `.git/` and `.superpowers/`.

## Goal

Create a fully compilable and runnable project skeleton with:
- Root npm workspace (root + sidecar)
- Tauri v2 Rust shell (`src-tauri/`)
- Vue 3 + Vite + TypeScript frontend (`src/`)
- Node.js Sidecar skeleton (`sidecar/`)
- All config files (tsconfig, vite, tailwind)
- `npm run dev` launches Tauri dev server with a visible "Hello xyz-agent" page

## Verification Command

```bash
npm run dev  # Should open a Tauri window showing "Hello xyz-agent"
```

---

## Step 1: Root package.json + .gitignore

- [ ] Create root `package.json` with npm workspaces
  ```json
  {
    "name": "xyz-agent",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "workspaces": [
      "sidecar"
    ],
    "scripts": {
      "dev": "tauri dev",
      "build": "vue-tsc --noEmit && vite build && tauri build",
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
  ```

## Step 2: Tauri v2 Rust Shell

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
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  ```

- [ ] Create `src-tauri/build.rs`
  ```rust
  fn main() {
      tauri_build::build()
  }
  ```

- [ ] Create `src-tauri/src/lib.rs`
  ```rust
  #[cfg_attr(mobile, tauri::mobile_entry_point)]
  pub fn run() {
      tauri::Builder::default()
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
      ]
    }
  }
  ```
  > **Note:** `beforeDevCommand` and `beforeBuildCommand` reference scripts we'll add to root package.json. Alternatively, Tauri can auto-detect Vite. Adjust if needed.

- [ ] Create `src-tauri/icons/` directory (Tauri needs icon files)
  ```bash
  mkdir -p src-tauri/icons
  ```
  > Use `npx tauri icon` later to generate proper icons from a source image, or create placeholder PNGs. For now, a minimal 32x32 PNG placeholder is enough.

- [ ] Add dev helper scripts to root `package.json`
  ```json
  "dev:vite": "vite",
  "build:vite": "vue-tsc --noEmit && vite build"
  ```

## Step 3: Vue 3 + Vite + TypeScript Frontend

- [ ] Install frontend dependencies
  ```bash
  npm install vue @vueuse/core pinia pinia-plugin-persistedstate
  npm install radix-vue reka-ui class-variance-authority clsx tailwind-merge
  npm install lucide-vue-next markdown-it dompurify vue-sonner
  npm install vue-i18n @tauri-apps/api
  npm install -D @vitejs/plugin-vue vite
  npm install -D @types/markdown-it @types/dompurify
  ```

- [ ] Create `index.html` (Vite entry)
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

- [ ] Create `tsconfig.json`
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
        "@/*": ["./src/*"]
      }
    },
    "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"],
    "references": [{ "path": "./tsconfig.node.json" }]
  }
  ```

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

- [ ] Create `src/env.d.ts` (Vue + Tauri type shims)
  ```typescript
  /// <reference types="vite/client" />

  declare module "*.vue" {
    import type { DefineComponent } from "vue"
    const component: DefineComponent<object, object, unknown>
    export default component
  }
  ```

- [ ] Create `src/main.ts`
  ```typescript
  import { createApp } from "vue"
  import { createPinia } from "pinia"
  import App from "./App.vue"

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

## Step 4: Tailwind CSS v4 Setup

- [ ] Install Tailwind CSS v4
  ```bash
  npm install -D tailwindcss @tailwindcss/vite
  ```

- [ ] Update `vite.config.ts` — add Tailwind plugin
  ```typescript
  import tailwindcss from "@tailwindcss/vite"

  export default defineConfig({
    plugins: [vue(), tailwindcss()],
    // ... rest unchanged
  })
  ```

- [ ] Create `src/assets/main.css` (Tailwind v4 entry)
  ```css
  @import "tailwindcss";

  /* Design tokens will be added in Task 2 (Foundation) */
  /* For now, provide minimal custom properties so App.vue classes resolve */
  @theme {
    --color-base: #ffffff;
    --color-foreground: #1a1a1a;
  }

  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  }
  ```

- [ ] Import CSS in `src/main.ts` — add at top
  ```typescript
  import "./assets/main.css"
  ```

  > **Tailwind v4 Note:** v4 uses CSS-first config (`@import "tailwindcss"` + `@theme {}` block in CSS). No `tailwind.config.ts` file is needed. Full design tokens and `@theme` configuration will be added in Task 2.

## Step 5: Node.js Sidecar Skeleton

- [ ] Create `sidecar/package.json`
  ```json
  {
    "name": "xyz-agent-sidecar",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "tsx watch src/index.ts",
      "build": "tsc",
      "start": "node dist/index.js"
    },
    "dependencies": {
      "ws": "^8"
    },
    "devDependencies": {
      "@types/ws": "^8",
      "typescript": "^5.8",
      "tsx": "^4"
    }
  }
  ```
  > **Note:** `@mariozechner/pi-coding-agent` will be added in Task 4 (Communication Layer). For now, the sidecar is a standalone WS echo server skeleton.

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
      "declaration": true
    },
    "include": ["src"]
  }
  ```

- [ ] Create `sidecar/src/index.ts` (minimal WS server)
  ```typescript
  import { WebSocketServer } from "ws"

  const PORT = parseInt(process.env.SIDECAR_PORT || "9250", 10)

  const wss = new WebSocketServer({ port: PORT })

  wss.on("connection", (ws) => {
    console.log(`[sidecar] client connected`)

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString())
      console.log(`[sidecar] received:`, msg.type)

      // Echo back for now — real routing in Task 4
      ws.send(JSON.stringify({ type: "pong", id: msg.id }))
    })

    ws.on("close", () => {
      console.log(`[sidecar] client disconnected`)
    })
  })

  console.log(`[sidecar] WebSocket server listening on port ${PORT}`)
  ```

- [ ] Install sidecar dependencies
  ```bash
  npm install  # npm workspaces will install sidecar/ too
  ```

## Step 6: ESLint Flat Config Skeleton

- [ ] Install ESLint dev dependencies
  ```bash
  npm install -D eslint @eslint/js typescript-eslint eslint-plugin-vue
  ```

- [ ] Create `eslint.config.mjs` (minimal skeleton — taste-lint rules added in Task 2)
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
      ignores: ["dist/", "node_modules/", "target/", "sidecar/dist/"],
    }
  )
  ```

## Step 7: Install & Verify

- [ ] Install all dependencies
  ```bash
  npm install
  ```

- [ ] Verify TypeScript compilation
  ```bash
  npx vue-tsc --noEmit
  ```
  > Must pass with zero errors.

- [ ] Verify Vite build
  ```bash
  npx vite build
  ```
  > Should produce `dist/` with index.html and assets.

- [ ] Verify Rust compilation
  ```bash
  cd src-tauri && cargo check
  ```
  > Must pass. May need to run `cargo build` first to fetch dependencies.

- [ ] Verify Tauri dev launch
  ```bash
  npm run dev
  ```
  > Should open a desktop window displaying "Hello xyz-agent".

- [ ] Verify sidecar starts independently
  ```bash
  cd sidecar && npx tsx src/index.ts
  ```
  > Should log: `[sidecar] WebSocket server listening on port 9250`

## Step 8: Commit

- [ ] Stage all files
  ```bash
  git add -A
  ```

- [ ] Verify staged files
  ```bash
  git diff --cached --stat
  ```
  Expected new files:
  ```
  .gitignore
  eslint.config.mjs
  index.html
  package.json
  package-lock.json (or pnpm-lock.yaml)
  sidecar/package.json
  sidecar/src/index.ts
  sidecar/tsconfig.json
  src/App.vue
  src/assets/main.css
  src/env.d.ts
  src/main.ts
  src-tauri/Cargo.toml
  src-tauri/build.rs
  src-tauri/src/lib.rs
  src-tauri/src/main.rs
  src-tauri/tauri.conf.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  ```

- [ ] Commit
  ```bash
  git commit -m "feat(p1): scaffold Tauri v2 + Vue 3 + Node.js Sidecar project

- Root npm workspace (root + sidecar)
- Tauri v2 Rust shell with dev server config
- Vue 3 + Vite + TypeScript frontend skeleton
- Tailwind CSS v4 via @tailwindcss/vite plugin
- Node.js Sidecar with WebSocket echo server skeleton
- ESLint flat config skeleton
- npm run dev launches Tauri window with Hello xyz-agent"
  ```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `cargo check` fails: missing `tauri` crate | Run `cd src-tauri && cargo build` to fetch crates |
| `npm run dev` fails: `tauri` not found | Run `npm install` to get `@tauri-apps/cli` |
| Vite `@` alias not resolving | Check `tsconfig.json` paths and `vite.config.ts` alias match |
| Tailwind classes not applying | Ensure `@import "tailwindcss"` is in CSS and imported in `main.ts` |
| `vue-tsc` fails on `.vue` imports | Ensure `src/env.d.ts` exists with module declaration |
| Sidecar `tsx` not found | Run `npm install` from root (workspaces install sidecar deps) |

## What's Next

After this plan completes, the project has a runnable skeleton. Proceed to:
- **Plan 02**: Foundation layer — Design Tokens, Theme System, i18n, taste-lint rules, Git Hooks
