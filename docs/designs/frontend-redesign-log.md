# Frontend Redesign Log: Unified Window + Sharp Style

Date: 2026-05-23
Branch: `feat-frontend-design`

## Design Direction

### Problem

Original UI had a "flat, not立体, uncomfortable" feel. Root cause diagnosis identified:

1. **Tone layering failure**: bg/surface lightness delta only 2% (both ~oklch(97%)), making surfaces indistinguishable
2. **No window unity**: Independent Header + Sidebar + Content created visual fragmentation
3. **Warm brown dark theme looked dirty**: User tested and rejected the brand's "warm soft" dark palette in favor of neutral gray

### Solution: Three Design Pillars

**Pillar 1: Unified Window (窗口一体感)**

- Remove independent Header/StatusBar
- Sidebar merges with window controls and brand identity
- Content fills remaining space, no chrome borders
- Reference: Codex, Cherry Studio

**Pillar 2: Neutral Gray Dark Theme**

- All neutrals at hue=0, chroma=0 (pure achromatic gray)
- Background layering via lightness only: bg(L=12%) < surface(L=16%) < hover-bg(L=19%)
- Accent: oklch(88% 0 0) — light gray, not colored
- Palette key: `neutral` (default changed from `warm-teal`)
- Rationale: Warm brown dark theme appeared "dirty" on screen; neutral gray is cleaner for extended use

**Pillar 3: Sharp Geometry**

- Near-zero border-radius (2-3px, not fully 0)
- Accent border-left as message role indicator
- No decorative rounded corners

## Architecture Changes

### Window Structure

```
┌──────────────────────────────────────────────────┐
│ [●●●] [Grid] [Settings] [+ New]    xyz-agent    │  ← hiddenInset titleBarStyle
│                                                   │    traffic lights float over sidebar
│  Session Group                                    │
│    ├ Session 1                                    │
│    └ Session 2                                    │
│                                                   │
│                                                   │
│  User ● ws                                        │
├──────────────────────────────────────────────────┤
│ Breadcrumb / Panel Controls              [Close] │
│──────────────────────────────────────────────────│
│                                                   │
│  助手 12:30                                       │  ← role label outside bubble
│  ┌──────────────────────────────────────────┐    │
│  │ Text message content                     │▌   │  ← bg-surface + border-l-2 border-border
│  └──────────────────────────────────────────┘    │
│                                                   │
│  ┌─ Thinking ──────────────────────────────┐    │
│  │ ▌ thinking content...                   │    │  ← gradient header (accent-light → transparent)
│  └──────────────────────────────────────────┘    │
│                                                   │
│  ┌─ bash · ls -la ──────────────── 0.3s ──┐    │
│  │ ▌ tool output...                        │    │  ← gradient header (hover-bg → transparent)
│  └──────────────────────────────────────────┘    │
│                                                   │
│                         12:31 用户               │  ← timestamp left of role label
│                    ┌──────────────────────┐      │
│                    │ user message content │▌     │  ← bg-surface + border-l-2 border-accent
│                    └──────────────────────┘      │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │ Type a message...              [Model] [↑]│    │  ← borderless, focus → border-accent
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### Component Structure

#### AppSidebar.vue

- Removed fake traffic lights (Electron provides native ones via `titleBarStyle: 'hiddenInset'`)
- `padding-left: 72px` reserves space for native traffic lights
- Controls (Grid, Settings, +New) positioned to the right of traffic lights
- Brand "xyz-agent" below controls, "-agent" in accent color

#### MessageBubble.vue — Key Restructuring

**Assistant message**:
- Outer wrapper: no background, no border (invisible container)
- Role label ("助手" + timestamp): rendered outside any bubble
- ThinkingBlock: rendered outside bubble, standalone card
- ToolCallCard: rendered outside bubble, standalone card
- Text content: wrapped in `bg-surface border-l-2 border-border rounded-sm` bubble
- Rationale: Thinking/ToolUse are structural elements, not conversational text; only text deserves bubble treatment

**User message**:
- Role label ("timestamp + 用户"): rendered above bubble, right-aligned
- Timestamp placed LEFT of "用户" label (format: "12:31 用户")
- Bubble: `bg-surface border-l-2 border-accent rounded-sm`, max-width 75%

#### ThinkingBlock.vue

- Default expanded (always visible)
- Header gradient: `linear-gradient(to right, accent-light 40%, transparent 100%)`
- Title text: `text-accent` for color distinction
- Border-radius: 3px
- Background: `var(--bg)` (L=12%, darker than parent to create inset feel)

#### ToolCallCard.vue

- Default expanded
- Header gradient: `linear-gradient(to right, hover-bg 40%, transparent 100%)` (subtler than Thinking)
- Tool name: `text-accent`
- Border-radius: 3px
- Background: `var(--bg)`
- Running state: spinning border-accent indicator
- Elapsed timer with color-coded status (accent=running, success=done, danger=error)

#### ChatInput.vue

- **Borderless at rest**: `border-2 border-transparent` — invisible until focused
- **Focus state**: `border-accent` — sharp accent border appears
- Background: `bg-surface` always visible
- No top separator line between message area and input
- Model picker + send/stop button in bottom toolbar

#### ChatPanel.vue

- Message gap: `gap-[6px]` (was 14px, demo used 2px)
- Compact spacing for information density while maintaining message boundary readability

## CSS Variable Strategy

### Neutral Palette (dark)

```css
--bg: oklch(12% 0 0);        /* Deepest: panel background */
--surface: oklch(16% 0 0);   /* Cards, bubbles, input */
--hover-bg: oklch(19% 0 0);  /* Hover states */
--section-bg: oklch(20% 0 0); /* Code blocks, elevated surfaces */
--border: oklch(24% 0 0);    /* Borders, dividers */
--fg: oklch(95% 0 0);        /* Primary text */
--muted: oklch(55% 0 0);     /* Secondary text */
--accent: oklch(88% 0 0);    /* Actions, highlights — light gray */
--accent-light: oklch(28% 0 0); /* Accent backgrounds */
```

### Layering Logic

Depth is conveyed entirely through lightness (L%) differences:

| Layer | L% | Delta from below |
|-------|-----|-----------------|
| bg (deepest) | 12% | — |
| ThinkingBlock/ToolCallCard | 12% (bg) | 0 (uses border for separation) |
| surface (bubbles, input) | 16% | +4% |
| hover-bg | 19% | +3% |
| section-bg (code blocks) | 20% | +1% |
| border | 24% | +4% |
| accent | 88% | large jump for emphasis |

## Design Decisions Log

### Decided: Neutral gray over warm brown (dark theme)
- Brand PRODUCT.md specifies "温润" warm tones
- User tested warm brown dark theme and found it "显脏" (looks dirty)
- Neutral gray adopted for visual comfort during 6+ hour sessions
- Trade-off: deviates from brand identity in dark mode

### Decided: Role labels outside bubble
- "助手" and "用户" labels placed outside the message bubble
- Only conversational text gets bubble treatment
- ThinkingBlock and ToolCallCard are standalone elements, not bubble contents
- Makes the chat flow feel like: label → structural elements → text bubble

### Decided: Borderless input with focus reveal
- Previous approach: always-visible border caused visual alignment issues with message borders
- Solution: invisible border at rest, accent border on focus
- Creates a calmer resting state, draws attention to input only when actively typing

### Decided: Gradient headers for Thinking/ToolUse
- Solid accent-light backgrounds felt too heavy
- Gradient (left-heavy → transparent right) adds visual interest without overwhelming
- Thinking uses accent-light (stronger), ToolUse uses hover-bg (subtler)
- Creates hierarchy: Thinking > ToolUse in visual weight

### Decided: 2-3px border-radius (not 0, not 8px)
- 0px felt overly harsh, "unfinished"
- Standard 8px too round for the sharp aesthetic
- 2-3px adds just enough softness without breaking the geometric intent
- Consistent across all chat elements (bubbles, cards, input)

### Decided: Default palette changed from warm-teal to neutral
- `settings.ts` default: `themePreset = ref<ThemePreset>('neutral')`
- Existing users with localStorage cache need manual switch or cache clear
- New users get neutral by default

## Files Modified

| File | Change |
|------|--------|
| `src-electron/main/main.ts` | Added `titleBarStyle: 'hiddenInset'` |
| `src-electron/renderer/src/App.vue` | Grid layout: 220px sidebar + 1fr content |
| `src-electron/renderer/src/stores/settings.ts` | Default palette: `warm-teal` → `neutral` |
| `src-electron/renderer/src/style.css` | Neutral gray dark theme, 0px → 2-3px radius variables |
| `src-electron/renderer/src/components/layout/AppSidebar.vue` | Removed traffic lights, padding for hiddenInset, brand integration |
| `src-electron/renderer/src/components/panel/PanelBar.vue` | Breadcrumb-style panel bar |
| `src-electron/renderer/src/components/panel/SplitDivider.vue` | 1px divider |
| `src-electron/renderer/src/components/panel/PanelTreeRenderer.vue` | Removed pane top border |
| `src-electron/renderer/src/components/panel/ChatPanel.vue` | gap-[6px] compact spacing |
| `src-electron/renderer/src/components/chat/MessageBubble.vue` | Restructured: role labels outside, only text in bubble |
| `src-electron/renderer/src/components/chat/ThinkingBlock.vue` | Default expanded, gradient header, accent title |
| `src-electron/renderer/src/components/chat/ToolCallCard.vue` | Default expanded, gradient header |
| `src-electron/renderer/src/components/chat/ChatInput.vue` | Borderless → focus-reveal border |
| All ToolRenderers (6 files) | `rounded-sm/md` → `rounded-none` |
| `ApprovalCard.vue`, `SlashMenu.vue`, `SystemNotification.vue`, etc. | `rounded-sm` → `rounded-none` |
