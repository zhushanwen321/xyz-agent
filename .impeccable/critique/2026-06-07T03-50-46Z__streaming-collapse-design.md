---
timestamp: 2026-06-07T03-50-46Z
slug: streaming-collapse-design
---
# Design Critique: Streaming Collapse Mode

## Target
Streaming collapse design concept for xyz-agent chat area

## Anti-Patterns Verdict

**LLM Assessment**: Concept is not AI slop — streaming visual noise is a real pain point. However, extending collapse to completed messages is a common AI design reflex: over-generalizing from "reduce streaming noise" to "collapse everything." The concept has several warning signs: the single-line bubble + "click to expand" is a default AI pattern; the relationship with existing autoExpand settings is undefined; and the visual fragmentation of turn content (text here, bubble there) is a significant cognitive load concern.

**Deterministic Scan**: N/A — design concept, no code to scan.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Good during streaming; completed collapsed turns hide content |
| 2 | Match System & Real World | 2 | Collapsing multiple separate steps into "one bubble" is unnatural |
| 3 | User Control & Freedom | 3 | Click-to-expand works; no "expand all" bulk action |
| 4 | Consistency & Standards | 2 | New pattern doesn't match existing ThinkingBlock/ToolCallCard toggle style; streaming vs completed undifferentiated |
| 5 | Error Prevention | 3 | Low risk; worst case = missed information |
| 6 | Recognition Rather Than Recall | 2 | Completed collapsed turns require memory of content |
| 7 | Flexibility & Efficiency | 2 | No expand-all shortcut; no selective expansion |
| 8 | Aesthetic & Minimalist Design | 4 | The clear win — cleaner streaming experience |
| 9 | Error Recovery | 3 | Click restores full content |
| 10 | Help & Documentation | 2 | Needs clear setting description and bubble interaction hint |
| **Total** | | **26/40** | **Acceptable — significant improvements needed** |

## Cognitive Load Assessment

- Single focus: ⚠️ OK during streaming; fragmented during review
- Chunking: ❌ Turn content split across two visual locations (text + compact bubble)
- Grouping: ❌ Turn content groups broken
- Visual hierarchy: ⚠️ Streaming vs completed compact bubbles visually identical
- One thing at a time: ❌ Review requires processing multiple sources simultaneously
- Minimal choices: ⚠️ Per-turn expand decision needed
- Working memory: ❌ User must remember which turns were expanded
- Progressive disclosure: ⚠️ Key output (tool call results) hidden by default

**Score**: 5-6 failures → High cognitive load. Critical fix needed.

## Overall Impression

The feature's starting point is valid — streaming thinking/toolCall noise is a real problem. But extending collapse to completed messages introduces a fundamental tension: it tries to serve two different needs (reduce streaming distraction + enable quick review) with one mechanism. The best designs give different interaction modes to different phases.

## What's Working

1. **Text always visible** — baseline-correct decision. User's primary output is never hidden.
2. **contentBlocks-based state derivation** — engineering elegant, leverages existing data structures.
3. **Single-line bubble fits product language** — restrained, non-intrusive, aligns with Warm & Soft.

## Priority Issues

### [P1] Completed message collapse = Review friction × Session length
When compactStreaming=true, completed messages also collapse by default. In a 20+ turn session, users must click each turn to review tool call results. This contradicts the product principle "Status = Trust" — if users can't quickly scan what happened, trust erodes.
**Fix**: Differentiate streaming vs completed behavior. Streaming → compact; completed → auto-expand. Or add preview snippets + "expand all" batch action.

### [P1] Cognitive fragmentation of turn content
One assistant turn split across "text visibly rendered" + "compact bubble (everything else)". Users must look in two places to understand one response. Violates chunking principle.
**Fix**: Don't treat compact bubble as standalone element; make it an inline status bar above/below text. Or animate expansion in-place.

### [P2] Undifferentiated visual state
Streaming compact bubble vs completed compact bubble look identical. User can't tell "currently generating" from "done but collapsed."
**Fix**: Streaming bubble gets pulse animation; completed bubble is static with lower opacity or different border.

### [P2] No bulk expand/collapse
No way to expand all collapsed turns at once. Interaction cost scales linearly with session length.
**Fix**: Add "expand all" / "collapse all" button in chat header (when compactStreaming is active). Keyboard shortcut (Cmd+E).

### [P3] Post-expansion lifecycle
User clicks to expand during streaming — what happens when next toolCall arrives? Re-collapse? Keep expanded? Ambiguous.
**Fix**: Manual expansion persists for current message until streaming ends. Auto-fold not triggered by new content.

### [P3] Relationship with autoExpand settings
compactStreaming overlaps with autoExpandThinking/ToolCalls. Which wins? Confusing.
**Fix**: compactStreaming overrides autoExpand settings. On expansion, blocks default to expanded. Settings UI should link/disable related controls.

## Persona Red Flags

**Alex (Power User)**:
- ❌ Per-turn click tax in a 20-turn session = 20+ extra clicks
- ❌ No expand-all shortcut or bulk operation
- 🟢 Less visual noise appreciated, but friction cancels benefit

**Jordan (First-Timer)**:
- ❌ "Why is my message collapsed? Did something break?" — needs clear visual language
- ❌ Interaction affordance unclear ("Is this clickable?")
- 🟢 Text visible so basic communication works

**Sam (Accessibility)**:
- ❌ Focus management on expand/collapse unclear
- ❌ Screen reader needs clear ARIA labels ("Collapsed assistant reply with 2 tool calls, click to expand")
- ❌ Completed collapsed turns need differentiation from streaming

## Minor Observations

1. Bubble style: caution against visibility extremes — too prominent defeats purpose, too subtle prevents discovery
2. Multiple thinking blocks: compact bubble should show the LAST active one (most relevant context)
3. Error states: tool call errors must NOT be silently collapsed — need prominent visual
4. Empty text content: when there's no text, compact bubble is the only visible output — needs more emphasis

## Questions to Consider

1. Design principle #6 says "minimal by default, progressive reveal" — does streaming-collapse-then-completed-auto-expand better serve this than universal collapse?
2. If completed messages auto-expand, this becomes "hide streaming noise only" — a purer feature. Is this actually what users need more?
3. With autoExpandThinking=false, each thinking/toolCall is already a single-line toggle. Is compactStreaming's "merge everything into one bubble" sufficiently differentiated?
4. "Text unaffected" is reasonable but creates asymmetric visual rhythm — a compact bubble sandwiched between text blocks. Does this hurt readability?
