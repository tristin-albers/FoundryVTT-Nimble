# Zipper Initiative v2 — Turn Order UX Roadmap

## Overview

Evolve the existing Combat Readiness variant to use alternating side selection (Draw Steel / Codex style) instead of fixed linear turn order. Initiative rolls still determine readiness tiers and pip types. The turn order becomes: player side picks a hero -> GM side picks an enemy -> repeat until all have acted -> next round.

## Research References

- **Draw Steel (The Codex)**: Alternating hero/villain turns, each side picks who acts, no fixed order within a side. Visual tracking of acted/not-acted state.
- **Lancer Initiative (Foundry module)**: Activation buttons per combatant, color-coded by faction, greyed out when acted.
- **Just Popcorn Initiative (Foundry module)**: Selection window at turn end showing eligible next actors. Manipulates initiative values behind the scenes.
- **fvtt-zipper-initiative (Foundry module)**: Interleaves PCs/NPCs in initiative list by manipulating values.

## Current State (Combat Readiness v1)

- Players roll initiative -> determines readiness tier (vigilant/ready/hesitant) -> sets pip types (inspired/standard/bane)
- Turns advance linearly through a fixed sorted list
- Solo monsters get interleaved turns after each character (`expandLegendaryTurns`)
- GM manually drags cards to reorder between turns
- Minion groups collapse to leader card via `normalizeMinionTurns`, formed through NCS panel
- All gated on `isCombatReadinessEnabled()`

## What Changes

When Combat Readiness is enabled, the linear turn order is replaced by alternating side selection:

1. Combat starts -> initiative rolls happen (for readiness tiers) -> determine first side -> enter selection mode
2. **Player turn**: Friendly-disposition, un-acted tokens show green check overlay. Player clicks their token to start.
3. Player takes turn normally (uses pips, etc.), ends turn.
4. **GM turn**: Hostile/neutral un-acted tokens show overlays for GM. GM clicks a token to activate.
   - Minion groups act as one unit (all members marked acted together)
   - GM can ad-hoc group monsters via existing NCS flow for one shared GM turn
5. Repeat alternation until all have acted -> next round.
6. **Overflow**: When one side has more un-acted combatants, remaining side takes consecutive turns.
7. **Solo monsters**: Each expanded occurrence = one selectable GM activation.

---

## Phase 1: Data Foundation

### 1a. Combatant Acted State Fields

**File**: `src/models/combatant/combatantDataModels.ts`

Add to all combatant data models (character, npc, soloMonster):
- `system.zipperTurn.acted` (Boolean, default false) — has this combatant acted this round
- `system.zipperTurn.actOrder` (Number, default 0) — order in which they acted (for left-side card sorting)

### 1b. Zipper Turn State Helpers

**New file**: `src/documents/combat/zipperTurnState.ts`

Functions:
- `markCombatantActed(combat, combatantId)` — set acted=true, actOrder=next increment
- `markMinionGroupActed(combat, groupId)` — marks all alive group members acted with same actOrder
- `resetAllActedFlags(combat)` — clear for new round
- `getActedCombatants(combat)` / `getUnactedCombatants(combat, side)`
- `getCurrentSide(combat)` / `flipSide(combat)` — read/write combat flags (`flags.nimble.zipper.currentSide`)
- `getEligibleCombatants(combat, side)` — un-acted combatants on the given side
- `isOverflowPhase(combat)` — one side exhausted
- `toggleActedOverride(combat, combatantId, acted)` — GM manual mark/unmark (does NOT flip side)

Side mapping: `FRIENDLY` disposition -> player side; `HOSTILE`/`NEUTRAL` -> GM side.
For minion groups: leader represents the group for eligibility, but marking acted applies to all members.

---

## Phase 2: Combat Lifecycle Integration

**File**: `src/documents/combat/combat.svelte.ts`

All changes gated on `isCombatReadinessEnabled()`.

### 2a. `startCombat()` modifications
- Initiative rolls happen as normal (readiness tiers, pip types — unchanged)
- After rolls: determine first side, set combat flags `zipper.currentSide`, `zipper.roundStartSide`
- Set `zipper.awaitingSelection = true` — enter selection mode
- Reset all `zipperTurn.acted` flags

### 2b. New method: `selectZipperCombatant(combatantId)`
- Validates combatant is on correct side, not acted, not dead
- If combatant is in a minion group: auto-select the group leader as active turn
- Sets active turn via existing `#syncTurnToCombatant`
- Sets `awaitingSelection = false`
- Socket support: players emit request, GM processes (reuse `combatTurnActions.ts` pattern)

### 2c. `nextTurn()` modifications
- Mark current combatant acted (+ all group members if minion group)
- Flip side; handle overflow (if new side has nobody left, stay on same side)
- Set `awaitingSelection = true`
- If all combatants acted -> trigger `nextRound()` instead
- Existing action refill / reaction refresh still runs

### 2d. `nextRound()` modifications
- Reset all `zipperTurn.acted` and `actOrder`
- Dissolve temporary groups (existing behavior)
- Reset side to `roundStartSide`
- Set `awaitingSelection = true`
- Existing pip type reset / hesitant removal still runs

### 2e. `setupTurns()` modifications
- Sort: acted (by actOrder ascending) then un-acted (by existing manual sort)
- `normalizeMinionTurns` still applies (groups collapse to leader)
- `expandLegendaryTurns` still applies (solo monster occurrences)

### 2f. New method: `toggleZipperActedState(combatantId, acted)` (GM only)
- Manual override: mark/unmark a combatant as acted
- If part of a minion group, applies to all group members
- Does NOT flip side or trigger `awaitingSelection` — pure bookkeeping correction
- Recalculates turn order via `setupTurns()`

---

## Phase 3: Token Overlay System

**New file**: `src/hooks/zipperTokenOverlay.ts`

### 3a. Selection Mode Overlays
- Hook into `updateCombat` and `canvasReady`
- When `awaitingSelection = true`:
  - Draw green checkmark PIXI overlay on eligible tokens (correct side, not acted, alive)
  - For minion groups: overlay only on the group leader token
  - Players: overlays on tokens they own. GM: overlays on all hostile/neutral.
  - Click handler calls `selectZipperCombatant()` (players via socket, GM direct)
- When selection made: remove all overlays
- Clean up on combat end/delete

### 3b. GM Multi-select (ad-hoc grouping)
- GM can shift-click multiple hostile tokens during selection to form temporary group
- Uses existing `assignNcsTemporaryGroupFromAttackMembers` pattern
- All selected creatures share one GM turn

---

## Phase 4: Combat Tracker Card Changes

### 4a. Types

**File**: `src/view/ui/ctTopTracker/types.ts`

- New `ZipperSeparatorTrackEntry`: `{ key: string; kind: 'zipper-separator' }`
- Add to `TrackEntry` union

### 4b. Entry Building

**File**: `src/view/ui/ctTopTracker/combat.utils.ts`

- `buildAliveEntries()` when combat readiness enabled:
  - Acted entries (sorted by actOrder ascending) -> `zipper-separator` -> un-acted entries (existing sort)
  - Monster stack collapse still applies within each section
  - Minion group cards show as single leader card (existing) — when group marked acted, card moves left

### 4c. Tracker Visual Updates

**File**: `src/view/ui/CtTopTracker.svelte`

- Render `zipper-separator` as a visual divider
- Acted cards: checkmark badge, slightly dimmed/muted styling
- Current-side eligible cards: subtle glow/border when `awaitingSelection`
- Selection banner: "Players: choose a hero" / "GM: choose an enemy"
- Token checkmark on turn end (in addition to card checkmark)

### 4d. State Derivations

**File**: `src/view/ui/CtTopTracker.state.svelte.ts`

- Derived state for `zipperCurrentSide`, `zipperAwaitingSelection` from combat flags
- Feed into entry building and card styling

### 4e. GM Context Menu Override

**File**: `src/view/ui/CtTopTracker.state.svelte.ts`

- `handleCombatantCardContextMenu` / `handleMonsterStackContextMenu`:
  - When combat readiness enabled and combat started (GM only):
    - "Mark as Acted" — on un-acted cards, moves to acted section
    - "Mark as Not Acted" — on acted cards, moves back to un-acted section
    - For monster stacks: applies to all combatants in the stack
  - Right-click still pings token (either as secondary behavior or separate menu item)

---

## Phase 5: Socket Communication

**File**: `src/utils/combatTurnActions.ts`

- New socket handler: `requestZipperCombatantSelection`
  - Players emit selection request with combatantId
  - GM-side handler validates and calls `selectZipperCombatant()`
  - Reuses existing `requestAdvanceCombatTurn` pattern

---

## Phase 6: Localization

**File**: `public/lang/en.json`

New strings under `NIMBLE.combat.zipper`:
- `selectHero`: "Players: choose a hero to act"
- `selectEnemy`: "GM: choose an enemy to act"
- `markActed`: "Mark as Acted"
- `markNotActed`: "Mark as Not Acted"
- `acted`: "Acted"
- `awaiting`: "Awaiting"
- `overflow`: "Overflow — {side} continues"
- `roundStart`: "Round {round} — {side} goes first"

---

## Edge Cases

- **Overflow**: One side exhausted -> other side takes consecutive turns until round ends
- **Minion group partial death**: Remaining alive members still act together; dead ones ignored
- **Late join**: New combatant enters as un-acted on their side
- **Death of active combatant**: Mark acted, flip side, enter selection
- **GM undo (previousTurn)**: Un-mark last acted combatant (+ group), flip side back
- **Solo monster**: Each expanded occurrence = one selectable GM activation, tracked via TurnIdentity

---

## Files Summary

### New (2)
1. `src/documents/combat/zipperTurnState.ts` — zipper state helpers
2. `src/hooks/zipperTokenOverlay.ts` — token overlay system

### Modified (~10)
3. `src/models/combatant/combatantDataModels.ts` — zipperTurn fields
4. `src/documents/combat/combat.svelte.ts` — lifecycle integration
5. `src/documents/combat/combatTurns.ts` — zipper-aware setupTurns
6. `src/view/ui/ctTopTracker/types.ts` — separator entry kind
7. `src/view/ui/ctTopTracker/combat.utils.ts` — acted/un-acted sorting
8. `src/view/ui/CtTopTracker.svelte` — card visuals, separator, banner
9. `src/view/ui/CtTopTracker.state.svelte.ts` — context menu + zipper derived state
10. `src/utils/combatTurnActions.ts` — socket handler for selection
11. `public/lang/en.json` — i18n strings

---

## Implementation Order

1. Phase 1 (data foundation) — must come first, everything depends on it
2. Phase 2 (combat lifecycle) — core logic
3. Phase 5 (socket communication) — needed for Phase 3 player interaction
4. Phase 3 (token overlays) — selection UX
5. Phase 4 (tracker cards) — visual polish
6. Phase 6 (localization) — can be done incrementally alongside each phase
