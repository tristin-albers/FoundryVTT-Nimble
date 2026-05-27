import { describe, expect, it } from 'vitest';
import {
	buildAppendTurnHistoryUpdate,
	buildClearTurnHistoryUpdate,
	buildMarkLastTurnUndoneUpdate,
	buildPreviousTurnUnwindUpdate,
	getTurnHistory,
	type TurnHistoryEntry,
} from './zipperTurnState.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type MinimalCombatantShape = {
	id: string;
	type: 'character' | 'npc';
	token?: { disposition?: number };
};

type MinimalCombatShape = {
	flags?: { nimble?: { zipper?: { turnHistory?: TurnHistoryEntry[]; actCounter?: number } } };
	combatants: { get: (id: string) => MinimalCombatantShape | undefined };
};

function makeCombat(
	opts: {
		turnHistory?: TurnHistoryEntry[];
		actCounter?: number;
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
				},
			},
		},
		combatants: { get: (id: string) => combatantMap.get(id) },
	};
}

function makeCharacter(id: string): MinimalCombatantShape {
	return { id, type: 'character' };
}

function makeFriendlyNpc(id: string): MinimalCombatantShape {
	return { id, type: 'npc', token: { disposition: 1 } };
}

function makeHostileNpc(id: string): MinimalCombatantShape {
	return { id, type: 'npc', token: { disposition: -1 } };
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
// ---------------------------------------------------------------------------

describe('buildPreviousTurnUnwindUpdate', () => {
	it('decrements actCounter on the combat', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 3, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, character as never);
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBe(2);
	});

	it('clamps actCounter at 0 (does not go negative)', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 0, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, character as never);
		expect(result.combatFlags['flags.nimble.zipper.actCounter']).toBe(0);
	});

	it('sets awaitingSelection back to true', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 1, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, character as never);
		expect(result.combatFlags['flags.nimble.zipper.awaitingSelection']).toBe(true);
	});

	it('sets currentSide to the player side when the unwound combatant is a character', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 1, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, character as never);
		expect(result.combatFlags['flags.nimble.zipper.currentSide']).toBe('player');
	});

	it('sets currentSide to the gm side when the unwound combatant is a hostile NPC', () => {
		const npc = makeHostileNpc('npc1');
		const combat = makeCombat({ actCounter: 1, combatants: [npc] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, npc as never);
		expect(result.combatFlags['flags.nimble.zipper.currentSide']).toBe('gm');
	});

	it('sets currentSide to the player side when the unwound combatant is a friendly NPC', () => {
		const friendly = makeFriendlyNpc('npc1');
		const combat = makeCombat({ actCounter: 1, combatants: [friendly] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, friendly as never);
		expect(result.combatFlags['flags.nimble.zipper.currentSide']).toBe('player');
	});

	it('returns combatant updates that unmark the combatant as acted', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 1, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, character as never);
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
		const history: TurnHistoryEntry[] = [
			{ combatantId: 'c1', side: 'player', actOrder: 1, undone: false },
		];
		const combat = makeCombat({ actCounter: 1, turnHistory: history, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, character as never);
		expect(result.combatFlags['flags.nimble.zipper.turnHistory']).toEqual([
			{ combatantId: 'c1', side: 'player', actOrder: 1, undone: true },
		]);
	});

	it('does not include a turnHistory update when history is empty', () => {
		const character = makeCharacter('c1');
		const combat = makeCombat({ actCounter: 1, combatants: [character] });
		const result = buildPreviousTurnUnwindUpdate(combat as never, character as never);
		expect(result.combatFlags['flags.nimble.zipper.turnHistory']).toBeUndefined();
	});
});
