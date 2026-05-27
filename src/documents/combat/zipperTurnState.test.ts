import { describe, expect, it } from 'vitest';
import {
	buildAppendTurnHistoryUpdate,
	buildClearTurnHistoryUpdate,
	buildMarkLastTurnUndoneUpdate,
	buildPreviousTurnUnwindUpdate,
	getActedOccurrenceCount,
	getNextUnactedOccurrence,
	getSoloOccurrencesPerRound,
	getTotalOccurrencesForCombatant,
	getTurnHistory,
	hasAnyOccurrenceUnacted,
	hasOccurrenceActed,
	type TurnHistoryEntry,
} from './zipperTurnState.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type MinimalCombatantShape = {
	id: string;
	type: 'character' | 'npc' | 'soloMonster';
	token?: { disposition?: number };
};

type MinimalCombatShape = {
	flags?: {
		nimble?: {
			zipper?: {
				turnHistory?: TurnHistoryEntry[];
				actCounter?: number;
				soloOccurrencesPerRound?: number;
			};
		};
	};
	combatants: { get: (id: string) => MinimalCombatantShape | undefined };
};

function makeCombat(
	opts: {
		turnHistory?: TurnHistoryEntry[];
		actCounter?: number;
		soloOccurrencesPerRound?: number;
		combatants?: MinimalCombatantShape[];
	} = {},
): MinimalCombatShape {
	const combatantMap = new Map<string, MinimalCombatantShape>();
	for (const c of opts.combatants ?? []) combatantMap.set(c.id, c);
	return {
		flags: {
			nimble: {
				zipper: {
					turnHistory: opts.turnHistory,
					actCounter: opts.actCounter,
					soloOccurrencesPerRound: opts.soloOccurrencesPerRound,
				},
			},
		},
		combatants: { get: (id: string) => combatantMap.get(id) },
	};
}

function makeCharacter(id: string): MinimalCombatantShape {
	return { id, type: 'character' };
}

function makeHostileNpc(id: string): MinimalCombatantShape {
	return { id, type: 'npc', token: { disposition: -1 } };
}

function makeSoloMonster(id: string): MinimalCombatantShape {
	return { id, type: 'soloMonster', token: { disposition: -1 } };
}

// ---------------------------------------------------------------------------
// Feature 4 — Turn history accessor
// ---------------------------------------------------------------------------

describe('getTurnHistory', () => {
	it('returns an empty array when the flag is missing', () => {
		const combat = makeCombat();
		expect(getTurnHistory(combat as never)).toEqual([]);
	});

	it('returns the array from flags when present', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ turnHistory: history });
		expect(getTurnHistory(combat as never)).toEqual(history);
	});

	it('returns an empty array when the flag value is not an array', () => {
		const combat = {
			flags: { nimble: { zipper: { turnHistory: 'not-an-array' as unknown as never } } },
			combatants: { get: () => undefined },
		};
		expect(getTurnHistory(combat as never)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Feature 4 — Append history entry
// ---------------------------------------------------------------------------

describe('buildAppendTurnHistoryUpdate', () => {
	it('appends a new entry with undone: false', () => {
		const combat = makeCombat();
		const update = buildAppendTurnHistoryUpdate(combat as never, {
			combatantId: 'a',
			side: 'player',
			actOrder: 1,
		});
		expect(update).toEqual({
			'flags.nimble.zipper.turnHistory': [
				{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
			],
		});
	});

	it('preserves existing entries when appending', () => {
		const existing: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ turnHistory: existing });
		const update = buildAppendTurnHistoryUpdate(combat as never, {
			combatantId: 'b',
			side: 'gm',
			actOrder: 2,
		});
		expect(update).toEqual({
			'flags.nimble.zipper.turnHistory': [
				{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
				{ combatantId: 'b', side: 'gm', actOrder: 2, undone: false },
			],
		});
	});

	it('records group entries with isGroup and groupCombatantIds', () => {
		const combat = makeCombat();
		const update = buildAppendTurnHistoryUpdate(combat as never, {
			combatantId: 'leader',
			side: 'gm',
			actOrder: 3,
			isGroup: true,
			groupCombatantIds: ['leader', 'minion-1', 'minion-2'],
		});
		expect(update).toEqual({
			'flags.nimble.zipper.turnHistory': [
				{
					combatantId: 'leader',
					side: 'gm',
					actOrder: 3,
					undone: false,
					isGroup: true,
					groupCombatantIds: ['leader', 'minion-1', 'minion-2'],
				},
			],
		});
	});
});

// ---------------------------------------------------------------------------
// Feature 4 — Mark last turn undone
// ---------------------------------------------------------------------------

describe('buildMarkLastTurnUndoneUpdate', () => {
	it('returns null when history is empty', () => {
		const combat = makeCombat();
		expect(buildMarkLastTurnUndoneUpdate(combat as never)).toBeNull();
	});

	it('marks the last entry as undone (preserves all entries)', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
			{ combatantId: 'b', side: 'gm', actOrder: 2, undone: false },
		];
		const combat = makeCombat({ turnHistory: history });
		const update = buildMarkLastTurnUndoneUpdate(combat as never);
		expect(update).toEqual({
			'flags.nimble.zipper.turnHistory': [
				{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
				{ combatantId: 'b', side: 'gm', actOrder: 2, undone: true },
			],
		});
	});

	it('marks the last NOT-already-undone entry when trailing entries are undone', () => {
		// If user reverses twice in a row, the second reverse should mark the
		// second-to-last entry, not re-mark the already-undone last entry.
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
			{ combatantId: 'b', side: 'gm', actOrder: 2, undone: true },
		];
		const combat = makeCombat({ turnHistory: history });
		const update = buildMarkLastTurnUndoneUpdate(combat as never);
		expect(update).toEqual({
			'flags.nimble.zipper.turnHistory': [
				{ combatantId: 'a', side: 'player', actOrder: 1, undone: true },
				{ combatantId: 'b', side: 'gm', actOrder: 2, undone: true },
			],
		});
	});

	it('returns null when every entry is already undone', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: true },
		];
		const combat = makeCombat({ turnHistory: history });
		expect(buildMarkLastTurnUndoneUpdate(combat as never)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Feature 4 — Clear history at round end
// ---------------------------------------------------------------------------

describe('buildClearTurnHistoryUpdate', () => {
	it('returns an update that sets the history flag to an empty array', () => {
		expect(buildClearTurnHistoryUpdate()).toEqual({
			'flags.nimble.zipper.turnHistory': [],
		});
	});
});

// ---------------------------------------------------------------------------
// Bug 1 — Unwind previous turn (decrement counter, restore selection state)
//
// Updated signature: takes the TurnHistoryEntry (source of truth for what was
// done) plus a turnEnded flag distinguishing in-progress unwind from fully-
// ended unwind.
// ---------------------------------------------------------------------------

function singleEntry(
	combatantId: string,
	side: 'player' | 'gm',
	actOrder: number,
): TurnHistoryEntry {
	return { combatantId, side, actOrder, undone: false };
}

function groupEntry(
	leaderId: string,
	side: 'player' | 'gm',
	actOrder: number,
	memberIds: string[],
): TurnHistoryEntry {
	return {
		combatantId: leaderId,
		side,
		actOrder,
		undone: false,
		isGroup: true,
		groupCombatantIds: memberIds,
	};
}

describe('buildPreviousTurnUnwindUpdate — ended-turn unwind (turnEnded: true)', () => {
	it('decrements actCounter by 1 for a single-combatant entry', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 3, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 3), {
			turnEnded: true,
		});
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBe(2);
	});

	it('clamps actCounter at 0 (does not go negative)', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 0, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 1), {
			turnEnded: true,
		});
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBe(0);
	});

	it('sets awaitingSelection back to true', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 1, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 1), {
			turnEnded: true,
		});
		expect(result.combatFlags['flags.nimble.zipper.awaitingSelection']).toBe(true);
	});

	it("restores currentSide to the entry's side", () => {
		const npc = makeHostileNpc('npc1');
		const combat = makeCombat({ actCounter: 1, combatants: [npc] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('npc1', 'gm', 1), {
			turnEnded: true,
		});
		expect(result.combatFlags['flags.nimble.zipper.currentSide']).toBe('gm');
	});

	it('returns combatant updates that unmark the combatant as acted', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 1, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 1), {
			turnEnded: true,
		});
		expect(result.combatantUpdates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					_id: 'c1',
					'system.zipperTurn.acted': false,
					'system.zipperTurn.actOrder': 0,
				}),
			]),
		);
	});

	it('marks the last history entry as undone when history exists', () => {
		const character = makeCharacter('c1');
		const history: TurnHistoryEntry[] = [singleEntry('c1', 'player', 1)];
		const combat = makeCombat({ actCounter: 1, turnHistory: history, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 1), {
			turnEnded: true,
		});
		expect(result.combatFlags['flags.nimble.zipper.turnHistory']).toEqual([
			{ combatantId: 'c1', side: 'player', actOrder: 1, undone: true },
		]);
	});

	it('does not include a turnHistory update when history is empty', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 1, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 1), {
			turnEnded: true,
		});
		expect(result.combatFlags['flags.nimble.zipper.turnHistory']).toBeUndefined();
	});
});

describe('buildPreviousTurnUnwindUpdate — in-progress unwind (turnEnded: false)', () => {
	it('does NOT decrement actCounter (it was never bumped for an in-progress turn)', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 3, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 4), {
			turnEnded: false,
		});
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBeUndefined();
	});

	it('does NOT flip currentSide (selectZipperCombatant never changed it)', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 3, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 4), {
			turnEnded: false,
		});
		expect(result.combatFlags['flags.nimble.zipper.currentSide']).toBeUndefined();
	});

	it('does NOT include combatant updates (combatant was never marked acted)', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 3, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 4), {
			turnEnded: false,
		});
		expect(result.combatantUpdates).toEqual([]);
	});

	it('still reverts awaitingSelection and marks history entry undone', () => {
		const character = makeCharacter('c1');
		const history: TurnHistoryEntry[] = [singleEntry('c1', 'player', 1)];
		const combat = makeCombat({ actCounter: 3, turnHistory: history, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, singleEntry('c1', 'player', 1), {
			turnEnded: false,
		});
		expect(result.combatFlags['flags.nimble.zipper.awaitingSelection']).toBe(true);
		expect(result.combatFlags['flags.nimble.zipper.turnHistory']).toEqual([
			{ combatantId: 'c1', side: 'player', actOrder: 1, undone: true },
		]);
	});
});

describe('buildPreviousTurnUnwindUpdate — group in-progress unwind (turnEnded: false)', () => {
	it('decrements actCounter by followers.length only (leader was never bumped)', () => {
		// selectZipperGroup marked 2 followers acted (counter +2) before selectZipperCombatant
		// ran for the leader. Leader's turn is in progress (not yet ended).
		const leader = makeHostileNpc('npc-lead');
		const follower1 = makeHostileNpc('npc-f1');
		const follower2 = makeHostileNpc('npc-f2');
		const combat = makeCombat({
			actCounter: 2, // bumped by 2 followers
			combatants: [leader, follower1, follower2],
		});
		const entry = groupEntry('npc-lead', 'gm', 3, ['npc-lead', 'npc-f1', 'npc-f2']);
		const result = buildPreviousTurnUnwindUpdate(combat as never, entry, { turnEnded: false });
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBe(0);
	});

	it('unmarks ONLY the followers (leader was never marked acted in-progress)', () => {
		const leader = makeHostileNpc('npc-lead');
		const follower1 = makeHostileNpc('npc-f1');
		const follower2 = makeHostileNpc('npc-f2');
		const combat = makeCombat({ actCounter: 2, combatants: [leader, follower1, follower2] });
		const entry = groupEntry('npc-lead', 'gm', 3, ['npc-lead', 'npc-f1', 'npc-f2']);
		const result = buildPreviousTurnUnwindUpdate(combat as never, entry, { turnEnded: false });
		const ids = result.combatantUpdates.map((u) => u._id);
		expect(ids).toEqual(expect.arrayContaining(['npc-f1', 'npc-f2']));
		expect(ids).not.toContain('npc-lead');
	});

	it('does NOT flip currentSide (selectZipperCombatant never changed it)', () => {
		const leader = makeHostileNpc('npc-lead');
		const follower1 = makeHostileNpc('npc-f1');
		const combat = makeCombat({ actCounter: 1, combatants: [leader, follower1] });
		const entry = groupEntry('npc-lead', 'gm', 2, ['npc-lead', 'npc-f1']);
		const result = buildPreviousTurnUnwindUpdate(combat as never, entry, { turnEnded: false });
		expect(result.combatFlags['flags.nimble.zipper.currentSide']).toBeUndefined();
	});
});

describe('buildPreviousTurnUnwindUpdate — group unwind (ended turn)', () => {
	it('decrements actCounter by the group size, not by 1', () => {
		const leader = makeHostileNpc('npc-lead');
		const follower1 = makeHostileNpc('npc-f1');
		const follower2 = makeHostileNpc('npc-f2');
		const combat = makeCombat({
			actCounter: 5,
			combatants: [leader, follower1, follower2],
		});
		const entry = groupEntry('npc-lead', 'gm', 5, ['npc-lead', 'npc-f1', 'npc-f2']);
		const result = buildPreviousTurnUnwindUpdate(combat as never, entry, { turnEnded: true });
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBe(2);
	});

	it('unmarks every group member as acted', () => {
		const leader = makeHostileNpc('npc-lead');
		const follower1 = makeHostileNpc('npc-f1');
		const follower2 = makeHostileNpc('npc-f2');
		const combat = makeCombat({ actCounter: 3, combatants: [leader, follower1, follower2] });
		const entry = groupEntry('npc-lead', 'gm', 3, ['npc-lead', 'npc-f1', 'npc-f2']);
		const result = buildPreviousTurnUnwindUpdate(combat as never, entry, { turnEnded: true });
		const ids = result.combatantUpdates.map((u) => u._id);
		expect(ids).toEqual(expect.arrayContaining(['npc-lead', 'npc-f1', 'npc-f2']));
	});

	it('skips group members that no longer exist in combat (defensive)', () => {
		const leader = makeHostileNpc('npc-lead');
		const combat = makeCombat({ actCounter: 3, combatants: [leader] });
		// followers were removed/died; entry still references them
		const entry = groupEntry('npc-lead', 'gm', 3, ['npc-lead', 'npc-removed']);
		const result = buildPreviousTurnUnwindUpdate(combat as never, entry, { turnEnded: true });
		const ids = result.combatantUpdates.map((u) => u._id);
		expect(ids).toContain('npc-lead');
		expect(ids).not.toContain('npc-removed');
		// counter still decrements by group size — the entry recorded that footprint
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Solo-monster multi-turn — Feature: per-occurrence acted state
// ---------------------------------------------------------------------------
//
// Snapshot: when zipper combat starts (or a new round begins) we record how
// many turns each solo monster gets that round (= alive hero count). Acted
// state for solos is then derived from the turn history rather than the
// per-combatant `acted` flag, so each occurrence tracks independently.
//
// Non-solo combatants still behave as single-occurrence — the helpers below
// must collapse to the existing single-flag semantics for them.

describe('getSoloOccurrencesPerRound', () => {
	it('returns 1 when the flag is missing (defensive default)', () => {
		const combat = makeCombat();
		expect(getSoloOccurrencesPerRound(combat as never)).toBe(1);
	});

	it('returns the stored count when present', () => {
		const combat = makeCombat({ soloOccurrencesPerRound: 4 });
		expect(getSoloOccurrencesPerRound(combat as never)).toBe(4);
	});

	it('returns 1 when the stored value is 0 (degenerate; no heroes alive at snapshot)', () => {
		// A 0-occurrence solo would be unreachable in eligibility — clamp to 1
		// so combat doesn't softlock if the snapshot fires while no heroes are
		// alive (e.g. between rounds during a TPK recovery).
		const combat = makeCombat({ soloOccurrencesPerRound: 0 });
		expect(getSoloOccurrencesPerRound(combat as never)).toBe(1);
	});
});

describe('getActedOccurrenceCount', () => {
	it('returns 0 when history is empty', () => {
		const combat = makeCombat();
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(0);
	});

	it('returns 0 when history has no entries for the given combatantId', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'hero', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ turnHistory: history });
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(0);
	});

	it('returns 1 for a single non-undone entry matching combatantId', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
		];
		const combat = makeCombat({ turnHistory: history });
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(1);
	});

	it('counts multiple non-undone entries for the same combatantId', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'hero', side: 'player', actOrder: 3, undone: false },
			{ combatantId: 'boss', side: 'gm', actOrder: 4, undone: false, occurrenceIndex: 1 },
		];
		const combat = makeCombat({ turnHistory: history });
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(2);
	});

	it('ignores undone entries', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 4, undone: true, occurrenceIndex: 1 },
		];
		const combat = makeCombat({ turnHistory: history });
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(1);
	});
});

describe('getTotalOccurrencesForCombatant', () => {
	it('returns 1 for a character', () => {
		const hero = makeCharacter('h1');
		const combat = makeCombat({ soloOccurrencesPerRound: 4, combatants: [hero] });
		expect(getTotalOccurrencesForCombatant(combat as never, hero as never)).toBe(1);
	});

	it('returns 1 for a regular npc', () => {
		const npc = makeHostileNpc('npc1');
		const combat = makeCombat({ soloOccurrencesPerRound: 4, combatants: [npc] });
		expect(getTotalOccurrencesForCombatant(combat as never, npc as never)).toBe(1);
	});

	it('returns the stored count for a soloMonster', () => {
		const boss = makeSoloMonster('boss');
		const combat = makeCombat({ soloOccurrencesPerRound: 3, combatants: [boss] });
		expect(getTotalOccurrencesForCombatant(combat as never, boss as never)).toBe(3);
	});

	it('defaults to 1 for a soloMonster when no snapshot is stored', () => {
		const boss = makeSoloMonster('boss');
		const combat = makeCombat({ combatants: [boss] });
		expect(getTotalOccurrencesForCombatant(combat as never, boss as never)).toBe(1);
	});
});

describe('hasOccurrenceActed', () => {
	it('returns false for occurrence 0 when history is empty', () => {
		const hero = makeCharacter('h1');
		const combat = makeCombat({ combatants: [hero] });
		expect(hasOccurrenceActed(combat as never, hero as never, 0)).toBe(false);
	});

	it('returns true for occurrence 0 after one acted turn', () => {
		const hero = makeCharacter('h1');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'h1', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ turnHistory: history, combatants: [hero] });
		expect(hasOccurrenceActed(combat as never, hero as never, 0)).toBe(true);
	});

	it('returns false for occurrence 1 of a solo after only one acted turn', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
		];
		const combat = makeCombat({ turnHistory: history, combatants: [boss] });
		expect(hasOccurrenceActed(combat as never, boss as never, 0)).toBe(true);
		expect(hasOccurrenceActed(combat as never, boss as never, 1)).toBe(false);
	});

	it('returns true for occurrence 1 of a solo after two acted turns', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 4, undone: false, occurrenceIndex: 1 },
		];
		const combat = makeCombat({ turnHistory: history, combatants: [boss] });
		expect(hasOccurrenceActed(combat as never, boss as never, 1)).toBe(true);
	});

	it('after a turn is undone, the corresponding occurrence is no longer acted', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 4, undone: true, occurrenceIndex: 1 },
		];
		const combat = makeCombat({ turnHistory: history, combatants: [boss] });
		expect(hasOccurrenceActed(combat as never, boss as never, 0)).toBe(true);
		expect(hasOccurrenceActed(combat as never, boss as never, 1)).toBe(false);
	});
});

describe('hasAnyOccurrenceUnacted', () => {
	it('returns true for a character with no history (single occurrence)', () => {
		const hero = makeCharacter('h1');
		const combat = makeCombat({ combatants: [hero] });
		expect(hasAnyOccurrenceUnacted(combat as never, hero as never)).toBe(true);
	});

	it('returns false for a character after one acted turn (single occurrence consumed)', () => {
		const hero = makeCharacter('h1');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'h1', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ turnHistory: history, combatants: [hero] });
		expect(hasAnyOccurrenceUnacted(combat as never, hero as never)).toBe(false);
	});

	it('returns true for a solo with 1 acted turn out of 3', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
		];
		const combat = makeCombat({
			turnHistory: history,
			soloOccurrencesPerRound: 3,
			combatants: [boss],
		});
		expect(hasAnyOccurrenceUnacted(combat as never, boss as never)).toBe(true);
	});

	it('returns false for a solo with all 3 occurrences acted', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 4, undone: false, occurrenceIndex: 1 },
			{ combatantId: 'boss', side: 'gm', actOrder: 6, undone: false, occurrenceIndex: 2 },
		];
		const combat = makeCombat({
			turnHistory: history,
			soloOccurrencesPerRound: 3,
			combatants: [boss],
		});
		expect(hasAnyOccurrenceUnacted(combat as never, boss as never)).toBe(false);
	});

	it('returns true for a solo after the last entry is undone (re-eligible for that occurrence)', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 4, undone: false, occurrenceIndex: 1 },
			{ combatantId: 'boss', side: 'gm', actOrder: 6, undone: true, occurrenceIndex: 2 },
		];
		const combat = makeCombat({
			turnHistory: history,
			soloOccurrencesPerRound: 3,
			combatants: [boss],
		});
		expect(hasAnyOccurrenceUnacted(combat as never, boss as never)).toBe(true);
	});
});

describe('getNextUnactedOccurrence', () => {
	it('returns 0 for a combatant with no history', () => {
		const hero = makeCharacter('h1');
		const combat = makeCombat({ combatants: [hero] });
		expect(getNextUnactedOccurrence(combat as never, hero as never)).toBe(0);
	});

	it('returns 1 for a solo after one turn taken', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
		];
		const combat = makeCombat({
			turnHistory: history,
			soloOccurrencesPerRound: 3,
			combatants: [boss],
		});
		expect(getNextUnactedOccurrence(combat as never, boss as never)).toBe(1);
	});

	it('returns -1 when all N occurrences are used', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 4, undone: false, occurrenceIndex: 1 },
			{ combatantId: 'boss', side: 'gm', actOrder: 6, undone: false, occurrenceIndex: 2 },
		];
		const combat = makeCombat({
			turnHistory: history,
			soloOccurrencesPerRound: 3,
			combatants: [boss],
		});
		expect(getNextUnactedOccurrence(combat as never, boss as never)).toBe(-1);
	});

	it('returns -1 for a single-occurrence combatant who has already acted', () => {
		const hero = makeCharacter('h1');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'h1', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ turnHistory: history, combatants: [hero] });
		expect(getNextUnactedOccurrence(combat as never, hero as never)).toBe(-1);
	});
});
