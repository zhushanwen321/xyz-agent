---
target: composer（Composer.vue + Landing.vue）
total_score: 26
p0_count: 0
p1_count: 3
timestamp: 2026-06-28T03-04-39Z
slug: lectron-renderer-src-components-panel-composer-vue
---
# Critique: Composer.vue + Landing.vue (panel ④ + new-task landing)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Model name never shown (empty selected) → user can't see which model will run |
| 2 | Match System / Real World | 3 | Placeholder + chips copy is natural |
| 3 | User Control and Freedom | 3 | Esc/cancel/steer/followUp present |
| 4 | Consistency and Standards | 2 | Placeholder token `--text-tertiary` is undefined; same dark color used for "too bright" placeholder AND "too dark" chips — token contract broken |
| 5 | Error Prevention | 3 | Draft restore on send fail; IME guard |
| 6 | Recognition Rather Than Recall | 2 | Directory/branch/model chips all under-visible; model invisible |
| 7 | Flexibility and Efficiency | 3 | ⏎/Alt+⏎/⇧⏎ accelerators, slash/mention chips |
| 8 | Aesthetic and Minimalist Design | 3 | Restrained, on-brand; but status affordances collapse into the dark |
| 9 | Error Recovery | 3 | Restore-on-fail works |
| 10 | Help and Documentation | 2 | Placeholder omits "@/#//  hint suffix" — discoverability hint deferred |
| **Total** | | **26/40** | **Acceptable — significant fixes needed before polish** |

## Anti-Patterns Verdict

**LLM assessment:** Not AI-slop. Composition is on-brand (dark cool-blue, restrained). The failures are contrast/visibility regressions, not aesthetic tells.

**Deterministic scan:** `detect.mjs --json` on 4 composer files → `[]` (exit 0, clean). No absolute-ban hits (no gradient text, side-stripe, glassmorphism, eyebrow scaffold, hero-metric, identical-card grid). Detector does not flag color contrast (its scope is structural slop); contrast failures below are manual.

**Visual overlays:** Skipped live browser injection (dev server not running; findings are deterministic from source tokens). No overlay to report.

## Overall Impression
The composer's bones are good: clean dark box, restrained accent, 3-state send button, proper IME handling. But three contrast/wiring regressions make it read as unfinished: a placeholder that's *brighter than the input text*, context chips that sink below readability, and a model selector that shows nothing at all. The single biggest opportunity is fixing the token contract — `--text-tertiary` resolves to nothing, so the placeholder silently inherits full foreground.

## What's Working
1. **State machine is solid.** S1→S2→S5→S6 with steer/followUp (⏎/Alt+⏎) and draft-restore-on-fail is genuinely thoughtful — user input is never silently lost.
2. **Restraint is on-brand.** One accent (#4f8ef7), no decorative motion, no glass. Matches the ADR-0018 cool-blue north star.
3. **Keyboard accelerators are real.** Enter/Shift+Enter/Alt+Enter, IME-composition guard, backspace-deletes-whole-chip — power-user path is honored.

## Priority Issues

### [P1] Placeholder "描述你想让 AI 做什么…" renders at full foreground, not muted
- **Why it matters**: ComposerInput.vue:332 `color: var(--text-tertiary)` — but `--text-tertiary` is **never defined** in style.css (the real token is `--subtle`). An undefined CSS var falls back to `inherit` → `--fg` (#f0f0f5). Result: placeholder at ~16.5:1 contrast, indistinguishable from typed text. Users can't tell the empty state from a prefilled value. This is the "太亮" symptom.
- **Fix**: Change ComposerInput.vue:332 to `color: var(--subtle)`. Verify contrast of `--subtle` #5a5a65 on `--bg-input` #101013 = ~3.0:1 — still below 4.5:1, so also bump toward muted (e.g. a `--placeholder` token at ~#71717d) to clear AA for placeholder text.
- **Suggested command**: /impeccable polish

### [P1] Model name is blank under the composer (issue #3)
- **Why it matters**: Composer.vue:135 `const currentModelId = ref('')` is initialized empty and **only ever written inside `onModelSelect`** (line 188, fires on user click). There is no subscription to `model.list`/`model.switched`, no read of session default model. So `currentName` (ModelSelectPopover.vue:131) falls back to `selected.value` = `''` → the trigger Button renders an empty `<span>` + a chevron. User cannot see, verify, or trust which model will run. Confirmed TODO in `.xyz-harness/2026-06-23-render-runtime-integration/gap-analysis.md:117` ("未接").
- **Fix**: On mount, subscribe to `modelApi.onModels` + read the active session's bound model (or `provider-store` defaultModel) to seed `currentModelId`; subscribe to `model.switched` to keep it in sync. The popover already subscribes to `onModels` for the list — Composer needs the *current* model from the same source.
- **Suggested command**: /impeccable polish

### [P1] Directory/branch chips in new-task landing are too dark (issue #2)
- **Why it matters**: Landing.vue:140 & :162 use `text-subtle` (#5a5a65) on `--bg-input` #101013 → ~3.0:1 contrast. Body text needs 4.5:1; these chips carry the directory + git context users *must* verify before sending ("am I about to run this in the right repo/branch?"). At 3.0:1 they read as disabled. This is the "太暗" symptom.
- **Fix**: Bump chip text to `text-muted` (#8a8a95, ~5.8:1) for the directory/branch labels; keep `--subtle` only for truly tertiary affordances. Note the inconsistency: the landing chips use `text-subtle` while the greeting (Landing.vue:113) uses `text-fg` — the hierarchy gap is too wide, collapsing chips into the background.
- **Suggested command**: /impeccable polish

### [P2] `--text-tertiary` / `text-tertiary` token is broken app-wide
- **Why it matters**: Same undefined-token bug also hits SearchModal.vue (5 usages of `text-tertiary` Tailwind class). The v3 token rename (ADR-0018) left `--text-tertiary` behind but never deleted its references. Anywhere it's used, color silently inherits foreground or collapses.
- **Fix**: Grep-and-replace `--text-tertiary`→`--subtle` and `text-tertiary`→`text-subtle` across src/; or alias `--text-tertiary: var(--subtle)` in style.css as a safety net. Recorded as known gap in `.v3-audit/results/wave-W12-composer.md:46`.
- **Suggested command**: /impeccable polish

### [P2] Placeholder hint suffix ("@ 引用、# 文件、/ 命令…") is deferred — discoverability gap
- **Why it matters**: The design draft (draft-landing.html:307) specifies `描述你想让 AI 做什么，或 @ 引用、# 文件、/ 命令…`. Impl omits the suffix (intentional DEFER per W12). Result: the @/#// affordance is invisible until the user discovers the `+` AddMenu. For a tool whose differentiator is context-attachment, this hides the key feature.
- **Fix**: Either ship the suffix now that AddMenu/CommandPopover exist, or surface the affordance via the `+` button having a more discoverable idle state (subtle label/tooltip "添加上下文").
- **Suggested command**: /impeccable onboard

### [P3] ThinkingLevelPopover: default level "max" = solid purple + glow
- **Why it matters**: A glowing purple button as the *default* idle state violates the "Heavy color or full-saturation accents on inactive states" product ban. "Max thinking" as default + glow reads as decoration, not state.
- **Fix**: Reconsider whether max should be default; if yes, drop the glow on inactive and reserve it for active/expensive confirmation.
- **Suggested command**: /impeccable quieter

## Persona Red Flags

**Alex (Power User)**: Send button title says "发送 · ⏎" but there's no visible keyboard-shortcut hint for steer (⏎) vs followUp (Alt+⏎) during streaming — Alex must read the streaming placeholder text to learn them. Model name blank means Alex can't trust the run.

**Jordan (First-Timer)**: Directory/branch chips at 3.0:1 contrast look disabled — Jordan may not realize they're clickable and won't verify the working directory before sending. The `+` add-context button's purpose is unclear without the placeholder hint suffix.

**Sam (Accessibility)**: Placeholder at 16.5:1 (fails by being *too* high-contrast — defeats the purpose of a placeholder). Chips at 3.0:1 fail WCAG AA 4.5:1 for body text. Model trigger is an empty button (no accessible name) → screen reader announces only "切换模型" title.

## Minor Observations
- ModelSelectPopover trigger uses `text-subtle/80` — another ~20% opacity hit on an already-low-contrast token; even after fixing the model-id wiring, the trigger label will still be hard to read.
- composer-bar `justify-end` + `gap-0.5` crowds the right cluster; the `+` (left) and capacity/model/thinking/send (right) have no breathing room.
- Send button disabled state stacks `disabled:opacity-50` on top of `disabled:text-[var(--subtle)]` — double-muting; combined ~1.5:1.
- Landing watermark at `opacity-[0.04]` is barely perceptible — likely intentional, but verify it's not meant to be more present.

## Questions to Consider
- Should the model chip show provider + model (e.g. "Sonnet 4.5 · Anthropic") instead of just the name, so users get cost/capability signal at a glance?
- Is "max thinking" really the right default, or is it aspirational? Most users on most tasks don't need max reasoning latency.
- The placeholder text differs between draft and impl — is the shortened version a deliberate copy decision or an unfinished DEFER?
