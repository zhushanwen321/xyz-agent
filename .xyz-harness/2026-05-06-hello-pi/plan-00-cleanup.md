# Plan 00: Cleanup Old Code

> Phase 1 rewrite — Task 0: Remove all old source code while preserving git history.

## Goal

Delete every file and directory except `.git/` and `.superpowers/`, then commit the empty state as the starting point for the Phase 1 rewrite.

## Safety Checkpoint

- [ ] Verify we are on the correct branch (create a cleanup branch if needed)
  ```bash
  git branch --show-current
  # Expected: main (or current working branch)
  ```
- [ ] Create a cleanup branch so `main` keeps a named reference to the old code
  ```bash
  git checkout -b phase1-cleanup
  ```
- [ ] Verify `.git/` exists and is healthy
  ```bash
  git status
  git log --oneline -5
  ```

## Pre-cleanup Inventory

- [ ] List all top-level files and directories to confirm what will be removed
  ```bash
  ls -1a
  ```
  Expected items to delete:
  - `src-tauri/` — Rust backend (Tauri v2)
  - `src/` — Vue 3 frontend
  - `node_modules/` — npm dependencies
  - `dist/` — Vite build output
  - `target/` — Rust build artifacts (if present)
  - `package.json`, `package-lock.json` — Node manifest
  - `tsconfig.json`, `tsconfig.node.json` — TypeScript config
  - `vite.config.ts` — Vite config
  - `tailwind.config.js` — Tailwind config
  - `postcss.config.js` — PostCSS config
  - `index.html` — Entry HTML
  - `.github/` — CI/CD workflows
  - `.vscode/` — Editor config (if present)
  - `.eslintrc*`, `.eslintignore` — ESLint config
  - `.prettierrc*` — Prettier config (if present)
  - `.taurignore` — Tauri ignore (if present)
  - `CLAUDE.md` — Old project instructions
  - `README.md` — Old readme
  - `LICENSE` — License file (keep if desired, otherwise delete)
  - Any other project files

## Execution

### Step 1: Remove Rust backend
- [ ] Delete `src-tauri/` directory
  ```bash
  rm -rf src-tauri/
  ```

### Step 2: Remove Vue frontend
- [ ] Delete `src/` directory
  ```bash
  rm -rf src/
  ```

### Step 3: Remove build artifacts and dependencies
- [ ] Delete `node_modules/`, `dist/`, `target/`
  ```bash
  rm -rf node_modules/ dist/ target/
  ```

### Step 4: Remove Node.js config files
- [ ] Delete package manifests and JS tooling config
  ```bash
  rm -f package.json package-lock.json pnpm-lock.yaml
  rm -f tsconfig.json tsconfig.node.json
  rm -f vite.config.ts tailwind.config.js postcss.config.js
  rm -f index.html
  rm -f .eslintrc* .eslintignore .prettierrc* .prettierignore
  rm -f components.json  # shadcn-vue config
  ```

### Step 5: Remove CI/CD and editor config
- [ ] Delete `.github/`, `.vscode/`, and other dot-dirs (except `.git` and `.superpowers`)
  ```bash
  rm -rf .github/ .vscode/
  ```

### Step 6: Remove project-level docs and metadata
- [ ] Delete old documentation and project files
  ```bash
  rm -f CLAUDE.md README.md LICENSE
  rm -rf docs/
  rm -f .taurignore .gitattributes
  ```

### Step 7: Remove any remaining files (except .git and .superpowers)
- [ ] List what remains and clean up stragglers
  ```bash
  # Show what's left (excluding .git and .superpowers)
  ls -1a | grep -v '^\.$' | grep -v '^\.\.$' | grep -v '^\.git$' | grep -v '^\.superpowers$'
  ```
- [ ] Delete any remaining files from the list above
  ```bash
  # For each remaining item:
  rm -rf <remaining-item>
  ```

## Verification

- [ ] Confirm only `.git/` and `.superpowers/` remain
  ```bash
  ls -1a
  # Expected output:
  # .
  # ..
  # .git
  # .superpowers
  ```
- [ ] Confirm git history is intact
  ```bash
  git log --oneline -10
  # Should show full history
  ```
- [ ] Confirm working tree is clean (everything removed is staged for commit)
  ```bash
  git status
  # Should show all old files as deleted
  ```

## Commit

- [ ] Stage all deletions
  ```bash
  git add -A
  ```
- [ ] Verify staged changes are all deletions
  ```bash
  git diff --cached --stat
  ```
- [ ] Commit
  ```bash
  git commit -m "chore: clean slate for phase 1 rewrite

Remove all old source code (Rust backend, Vue frontend, configs, docs).
Git history preserved. Only .git/ and .superpowers/ remain.
Old code available on main branch."
  ```

## Post-cleanup

- [ ] Verify clean state
  ```bash
  git status
  git log --oneline -3
  ls -1a
  ```
- [ ] (Optional) Merge cleanup branch back to main
  ```bash
  git checkout main
  git merge phase1-cleanup
  # Or: git merge --no-ff phase1-cleanup
  ```

## What's Next

After this plan completes, the repo is a blank slate with full git history. Proceed to:
- **Plan 01**: Initialize the new project structure
