import { describe, expect, it } from 'vitest';
import {
	buildAppendTurnHistoryUpdate,
	buildClearTurnHistoryUpdate,
	buildMarkLastTurnUndoneForCombatantUpdate,
	buildMarkLastTurnUndoneUpdate,
	buildPreviousTurnUnwindUpdate,
	buildSoloOccurrencesSnapshotUpdate,
	getActedOccurrenceCount,
	getAllUnactedCombatants,
	getNextUnactedOccurrence,
	getRemainingOccurrenceCountForSide,
	getSoloOccurrencesPerRound,
	getTotalOccurrencesForCombatant,
	getTurnHistory,
	getUnactedCombatantsForSide,
	hasAnyOccurrenceUnacted,
	hasInProgressTurn,
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
	defeated?: boolean;
	system?: { attributes?: { hp?: { value?: number; max?: number } } };
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
	combatants: {
		get: (id: string) => MinimalCombatantShape | undefined;
		contents: MinimalCombatantShape[];
	};
};

function makeCombat(
	opts: {
		turnHistory?: TurnHistoryEntry[];
		actCounter?: number;
		soloOccurrencesPerRound?: number;
		combatants?: MinimalCombatantShape[];
	} = {},
): MinimalCombatShape {
	const combatantList = opts.combatants ?? [];
	const combatantMap = new Map<string, MinimalCombatantShape>();
	for (const c of combatantList) combatantMap.set(c.id, c);
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
		combatants: {
			get: (id: string) => combatantMap.get(id),
			contents: combatantList,
		},
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

// ---------------------------------------------------------------------------
// Cycle 1 fixes — hasInProgressTurn + getRemainingOccurrenceCountForSide
// ---------------------------------------------------------------------------

describe('hasInProgressTurn', () => {
	it('returns false when history is empty', () => {
		const combat = makeCombat();
		expect(hasInProgressTurn(combat as never)).toBe(false);
	});

	it('returns true when the latest non-undone entry has actOrder > actCounter', () => {
		// selectZipperCombatant ran (history appended with actOrder=2) but
		// #zipperNextTurn hasn't bumped the counter yet.
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
			{ combatantId: 'b', side: 'gm', actOrder: 2, undone: false },
		];
		const combat = makeCombat({ actCounter: 1, turnHistory: history });
		expect(hasInProgressTurn(combat as never)).toBe(true);
	});

	it('returns false when the latest non-undone entry has actOrder == actCounter (committed)', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ actCounter: 1, turnHistory: history });
		expect(hasInProgressTurn(combat as never)).toBe(false);
	});

	it('walks past undone entries to find the latest committed/in-progress state', () => {
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
			{ combatantId: 'b', side: 'gm', actOrder: 2, undone: true }, // reverted
		];
		// Latest non-undone is A (actOrder=1, committed). actCounter was decremented
		// to 0 by the unwind of B. Now actCounter(0) < A.actOrder(1) → would imply
		// in-progress, but A is actually committed. The helper checks the LATEST
		// non-undone entry only, which is A — so it returns true. This is the
		// correct behavior for the bump-guard use case because if A is "in-progress"
		// after a re-select, #zipperNextTurn should bump (re-commit it).
		const combat = makeCombat({ actCounter: 0, turnHistory: history });
		expect(hasInProgressTurn(combat as never)).toBe(true);
	});

	it('returns true for solo turn 2 in-progress after turn 1 committed', () => {
		// After turn 1 ended: counter=1, boss has 1 acted entry.
		// After selectZipperCombatant for occurrence 1: history adds actOrder=2.
		// #zipperNextTurn must bump now — this is exactly the regression this fixes.
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 1, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 2, undone: false, occurrenceIndex: 1 },
		];
		const combat = makeCombat({ actCounter: 1, turnHistory: history });
		expect(hasInProgressTurn(combat as never)).toBe(true);
	});
});

describe('getRemainingOccurrenceCountForSide', () => {
	it('returns 0 when no combatants on the side', () => {
		const combat = makeCombat({ combatants: [] });
		expect(getRemainingOccurrenceCountForSide(combat as never, 'gm')).toBe(0);
	});

	it('returns 1 for a single non-solo combatant who has not acted', () => {
		const npc = makeHostileNpc('npc1');
		const combat = makeCombat({ combatants: [npc] });
		expect(getRemainingOccurrenceCountForSide(combat as never, 'gm')).toBe(1);
	});

	it('returns N for a solo with N occurrences and zero acted', () => {
		const boss = makeSoloMonster('boss');
		const combat = makeCombat({ soloOccurrencesPerRound: 3, combatants: [boss] });
		expect(getRemainingOccurrenceCountForSide(combat as never, 'gm')).toBe(3);
	});

	it('returns remaining occurrences for a solo with some acted', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 1, undone: false, occurrenceIndex: 0 },
		];
		const combat = makeCombat({
			soloOccurrencesPerRound: 3,
			turnHistory: history,
			combatants: [boss],
		});
		expect(getRemainingOccurrenceCountForSide(combat as never, 'gm')).toBe(2);
	});

	it('sums remaining occurrences across multiple combatants on the side', () => {
		const boss = makeSoloMonster('boss');
		const npc1 = makeHostileNpc('npc1');
		const npc2 = makeHostileNpc('npc2');
		const combat = makeCombat({
			soloOccurrencesPerRound: 3,
			combatants: [boss, npc1, npc2],
		});
		// boss: 3 unacted + npc1: 1 + npc2: 1 = 5
		expect(getRemainingOccurrenceCountForSide(combat as never, 'gm')).toBe(5);
	});

	it('returns 1 when only the last solo occurrence remains (telegraph trigger)', () => {
		const boss = makeSoloMonster('boss');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 1, undone: false, occurrenceIndex: 0 },
			{ combatantId: 'boss', side: 'gm', actOrder: 3, undone: false, occurrenceIndex: 1 },
		];
		const combat = makeCombat({
			soloOccurrencesPerRound: 3,
			turnHistory: history,
			combatants: [boss],
		});
		// 3 - 2 = 1
		expect(getRemainingOccurrenceCountForSide(combat as never, 'gm')).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Lifecycle integration — simulates the full solo-turn flow without spinning
// up the heavyweight combat document. Each test threads the helpers in the
// order the combat document actually calls them (selectZipperCombatant →
// #zipperNextTurn → repeat), so a regression in the bump guard, history
// shape, or eligibility check shows up here even though we don't exercise
// the Foundry plumbing.
// ---------------------------------------------------------------------------

/**
 * Stand-in for the slice of combat state these tests care about. Mutates the
 * underlying object so successive calls observe each other's writes, matching
 * how the real combat document persists between #zipperNextTurn invocations.
 */
function applyFlagUpdate(combat: MinimalCombatShape, update: Record<string, unknown>): void {
	const zipper = combat.flags?.nimble?.zipper;
	if (!zipper) return;
	if ('flags.nimble.zipper.actCounter' in update) {
		zipper.actCounter = update['flags.nimble.zipper.actCounter'] as number;
	}
	if ('flags.nimble.zipper.turnHistory' in update) {
		zipper.turnHistory = update['flags.nimble.zipper.turnHistory'] as TurnHistoryEntry[];
	}
	if ('flags.nimble.zipper.soloOccurrencesPerRound' in update) {
		zipper.soloOccurrencesPerRound = update[
			'flags.nimble.zipper.soloOccurrencesPerRound'
		] as number;
	}
}

/**
 * Simulate selectZipperCombatant for one occurrence: append a history entry,
 * recording occurrenceIndex for solos. Does NOT bump actCounter — that mirrors
 * the real selectZipperCombatant, which only bumps in #zipperNextTurn.
 */
function simulateSelect(
	combat: MinimalCombatShape,
	combatant: MinimalCombatantShape,
	side: 'player' | 'gm',
): void {
	const totalOccurrences = getTotalOccurrencesForCombatant(combat as never, combatant as never);
	const occurrenceIndex =
		totalOccurrences > 1
			? Math.max(0, getNextUnactedOccurrence(combat as never, combatant as never))
			: undefined;
	const counter = combat.flags?.nimble?.zipper?.actCounter ?? 0;
	const entry: Omit<TurnHistoryEntry, 'undone'> = {
		combatantId: combatant.id,
		side,
		actOrder: counter + 1,
		...(occurrenceIndex !== undefined ? { occurrenceIndex } : {}),
	};
	const update = buildAppendTurnHistoryUpdate(combat as never, entry);
	applyFlagUpdate(combat, update);
}

/**
 * Simulate #zipperNextTurn end-of-turn: bump the counter (if hasInProgressTurn
 * reports a pending entry, matching the real guard).
 */
function simulateNextTurn(combat: MinimalCombatShape): void {
	if (!hasInProgressTurn(combat as never)) return;
	const counter = combat.flags?.nimble?.zipper?.actCounter ?? 0;
	applyFlagUpdate(combat, { 'flags.nimble.zipper.actCounter': counter + 1 });
}

describe('lifecycle: solo monster three-turn round', () => {
	it('boss takes 3 turns, counter bumps once per turn, history grows correctly', () => {
		const hero1 = makeCharacter('h1');
		const hero2 = makeCharacter('h2');
		const hero3 = makeCharacter('h3');
		const boss = makeSoloMonster('boss');
		const combat = makeCombat({
			actCounter: 0,
			soloOccurrencesPerRound: 3,
			combatants: [hero1, hero2, hero3, boss],
			turnHistory: [],
		});

		// Turn 1: hero1
		simulateSelect(combat, hero1, 'player');
		simulateNextTurn(combat);
		expect(combat.flags?.nimble?.zipper?.actCounter).toBe(1);

		// Turn 2: boss occurrence 0
		simulateSelect(combat, boss, 'gm');
		simulateNextTurn(combat);
		expect(combat.flags?.nimble?.zipper?.actCounter).toBe(2);
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(1);

		// Turn 3: hero2
		simulateSelect(combat, hero2, 'player');
		simulateNextTurn(combat);
		expect(combat.flags?.nimble?.zipper?.actCounter).toBe(3);

		// Turn 4: boss occurrence 1 — THIS is the regression case the cycle 1
		// fix addresses. Without hasInProgressTurn guard, the counter wouldn't
		// bump here because the per-combatant `acted` flag was set on turn 2.
		simulateSelect(combat, boss, 'gm');
		simulateNextTurn(combat);
		expect(combat.flags?.nimble?.zipper?.actCounter).toBe(4);
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(2);

		// Turn 5: hero3
		simulateSelect(combat, hero3, 'player');
		simulateNextTurn(combat);
		expect(combat.flags?.nimble?.zipper?.actCounter).toBe(5);

		// Turn 6: boss occurrence 2
		simulateSelect(combat, boss, 'gm');
		simulateNextTurn(combat);
		expect(combat.flags?.nimble?.zipper?.actCounter).toBe(6);
		expect(getActedOccurrenceCount(combat as never, 'boss')).toBe(3);

		// All occurrences used — boss no longer eligible
		expect(hasAnyOccurrenceUnacted(combat as never, boss as never)).toBe(false);
		expect(getNextUnactedOccurrence(combat as never, boss as never)).toBe(-1);

		// History has 6 entries (3 heroes + 3 boss occurrences) with unique actOrder
		const history = getTurnHistory(combat as never);
		expect(history).toHaveLength(6);
		const actOrders = history.map((h) => h.actOrder);
		expect(actOrders).toEqual([1, 2, 3, 4, 5, 6]);

		// Boss entries have occurrenceIndex 0, 1, 2
		const bossEntries = history.filter((h) => h.combatantId === 'boss');
		expect(bossEntries.map((e) => e.occurrenceIndex)).toEqual([0, 1, 2]);
	});

	it('after selectZipperCombatant for a solo, hasInProgressTurn returns true (turn not yet ended)', () => {
		const boss = makeSoloMonster('boss');
		const combat = makeCombat({
			actCounter: 0,
			soloOccurrencesPerRound: 3,
			combatants: [boss],
			turnHistory: [],
		});
		simulateSelect(combat, boss, 'gm');
		// Counter not bumped yet. History has one entry with actOrder = 1.
		expect(hasInProgressTurn(combat as never)).toBe(true);

		simulateNextTurn(combat);
		// After bump, counter == actOrder of latest entry → in-progress = false.
		expect(hasInProgressTurn(combat as never)).toBe(false);
	});
});

describe('lifecycle: GM toggle-acted history sync', () => {
	it('mark-acted appends a history entry; mark-unacted marks it undone', () => {
		const hero = makeCharacter('h1');
		const combat = makeCombat({
			actCounter: 0,
			combatants: [hero],
			turnHistory: [],
		});

		// Mark acted: simulate toggleZipperActedState's append + bump
		const counterBefore = combat.flags?.nimble?.zipper?.actCounter ?? 0;
		applyFlagUpdate(
			combat,
			buildAppendTurnHistoryUpdate(combat as never, {
				combatantId: 'h1',
				side: 'player',
				actOrder: counterBefore + 1,
			}),
		);
		applyFlagUpdate(combat, { 'flags.nimble.zipper.actCounter': counterBefore + 1 });

		expect(getActedOccurrenceCount(combat as never, 'h1')).toBe(1);
		expect(hasAnyOccurrenceUnacted(combat as never, hero as never)).toBe(false);

		// Mark unacted: simulate toggleZipperActedState's mark-undone + decrement
		const undoneUpdate = buildMarkLastTurnUndoneForCombatantUpdate(combat as never, 'h1');
		expect(undoneUpdate).not.toBeNull();
		applyFlagUpdate(combat, undoneUpdate!);
		applyFlagUpdate(combat, { 'flags.nimble.zipper.actCounter': counterBefore });

		expect(getActedOccurrenceCount(combat as never, 'h1')).toBe(0);
		expect(hasAnyOccurrenceUnacted(combat as never, hero as never)).toBe(true);
	});

	it('mark-unacted finds the latest non-undone entry for THIS combatant, not the rightmost overall', () => {
		const heroA = makeCharacter('a');
		const heroB = makeCharacter('b');
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'a', side: 'player', actOrder: 1, undone: false },
			{ combatantId: 'b', side: 'player', actOrder: 2, undone: false },
		];
		const combat = makeCombat({
			actCounter: 2,
			combatants: [heroA, heroB],
			turnHistory: history,
		});

		// Toggling A's acted state should undo A's entry, NOT B's (the rightmost).
		const update = buildMarkLastTurnUndoneForCombatantUpdate(combat as never, 'a');
		expect(update).not.toBeNull();
		const next = update!['flags.nimble.zipper.turnHistory'] as TurnHistoryEntry[];
		expect(next[0].undone).toBe(true);
		expect(next[1].undone).toBe(false);
	});

	it('mark-unacted returns null when the combatant has no non-undone entry', () => {
		const hero = makeCharacter('h1');
		const combat = makeCombat({ combatants: [hero], turnHistory: [] });
		expect(buildMarkLastTurnUndoneForCombatantUpdate(combat as never, 'h1')).toBeNull();
	});
});

describe('lifecycle: dead solo combatant', () => {
	it('a dead solo is excluded from getUnactedCombatantsForSide and getAllUnactedCombatants', () => {
		const boss = makeSoloMonster('boss');
		boss.defeated = true;
		boss.system = { attributes: { hp: { value: 0, max: 100 } } };
		const combat = makeCombat({
			soloOccurrencesPerRound: 3,
			combatants: [boss],
			turnHistory: [],
		});
		// Boss has 3 unacted occurrences in theory, but is dead → filtered out.
		expect(getUnactedCombatantsForSide(combat as never, 'gm')).toEqual([]);
		expect(getAllUnactedCombatants(combat as never)).toEqual([]);
	});

	it('a dead solo with some occurrences already acted still drops out of unacted lists', () => {
		const boss = makeSoloMonster('boss');
		boss.defeated = true;
		boss.system = { attributes: { hp: { value: 0, max: 100 } } };
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'boss', side: 'gm', actOrder: 1, undone: false, occurrenceIndex: 0 },
		];
		const combat = makeCombat({
			soloOccurrencesPerRound: 3,
			combatants: [boss],
			turnHistory: history,
		});
		expect(getUnactedCombatantsForSide(combat as never, 'gm')).toEqual([]);
	});
});

describe('lifecycle: snapshot persistence across round changes', () => {
	it('soloOccurrencesPerRound stays locked through history changes within a round', () => {
		const combat = makeCombat({ soloOccurrencesPerRound: 3 });
		expect(getSoloOccurrencesPerRound(combat as never)).toBe(3);
		// Simulate history changes (turns happening) — snapshot doesn't move.
		applyFlagUpdate(
			combat,
			buildAppendTurnHistoryUpdate(combat as never, {
				combatantId: 'boss',
				side: 'gm',
				actOrder: 1,
				occurrenceIndex: 0,
			}),
		);
		expect(getSoloOccurrencesPerRound(combat as never)).toBe(3);
	});

	it('new round writes a new snapshot (simulating nextRound called with 2 heroes alive)', () => {
		const combat = makeCombat({ soloOccurrencesPerRound: 3 });
		// Simulate end-of-round: history cleared, new snapshot written
		applyFlagUpdate(combat, buildClearTurnHistoryUpdate());
		applyFlagUpdate(combat, buildSoloOccurrencesSnapshotUpdate(2));
		expect(getSoloOccurrencesPerRound(combat as never)).toBe(2);
		expect(getTurnHistory(combat as never)).toEqual([]);
	});
});
