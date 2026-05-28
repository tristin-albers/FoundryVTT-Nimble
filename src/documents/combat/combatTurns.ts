import {
	getEffectiveMinionGroupLeader,
	getMinionGroupId,
	getMinionGroupSummaries,
} from '../../utils/minionGrouping.js';

function collectAliveMinionLeaderIds(
	groupedSummaries: ReturnType<typeof getMinionGroupSummaries>,
): Set<string> {
	const leaderIds = new Set<string>();
	for (const summary of groupedSummaries.values()) {
		const leader = getEffectiveMinionGroupLeader(summary, { aliveOnly: true });
		if (leader?.id) leaderIds.add(leader.id);
	}
	return leaderIds;
}

export function normalizeMinionTurns(
	turns: Combatant.Implementation[],
): Combatant.Implementation[] {
	const groupedSummaries = getMinionGroupSummaries(turns);
	if (groupedSummaries.size === 0) return turns;

	const leaderIds = collectAliveMinionLeaderIds(groupedSummaries);
	return turns.filter((combatant) => {
		const groupId = getMinionGroupId(combatant);
		if (!groupId) return true;
		return leaderIds.has(combatant.id ?? '');
	});
}

/**
 * Interleave solo monster cards between character turns. A solo gets one card
 * per occurrence slot.
 *
 * @param turns - the alive, minion-normalized combatant list
 * @param soloOccurrenceCount - how many turns each solo gets this round. When
 *   omitted, defaults to `characters.length` for backwards compatibility (the
 *   pre-snapshot behavior). With the round-start snapshot in place, the caller
 *   should pass `getSoloOccurrencesPerRound(combat)` so the count stays locked
 *   even if heroes die mid-round.
 */
export function expandLegendaryTurns(
	turns: Combatant.Implementation[],
	soloOccurrenceCount?: number,
): Combatant.Implementation[] {
	const characters: Combatant.Implementation[] = [];
	const legendaryCombatants: Combatant.Implementation[] = [];
	const nonCharacterNonLegendary: Combatant.Implementation[] = [];

	for (const combatant of turns) {
		if (combatant.type === 'character') {
			characters.push(combatant);
			continue;
		}
		if (combatant.type === 'soloMonster') {
			legendaryCombatants.push(combatant);
			continue;
		}
		nonCharacterNonLegendary.push(combatant);
	}

	if (legendaryCombatants.length === 0) return turns;
	const occurrenceSlots = soloOccurrenceCount ?? characters.length;
	if (occurrenceSlots <= 0) return turns;

	// Solo monsters intentionally gain a turn after each character turn (or each
	// occurrence slot, if the count is snapshotted separately from current
	// character count). The first `min(characters, slots)` solo turns are
	// interleaved with characters; any remaining slots are appended at the end
	// so the solo still gets its full N turns even when heroes died this round.
	const expandedTurns: Combatant.Implementation[] = [];
	const interleaveCount = Math.min(characters.length, occurrenceSlots);
	for (let i = 0; i < interleaveCount; i++) {
		expandedTurns.push(characters[i]!, ...legendaryCombatants);
	}
	// Any characters beyond the slot count still get their turns (unusual case
	// where character count grew mid-round).
	for (let i = interleaveCount; i < characters.length; i++) {
		expandedTurns.push(characters[i]!);
	}
	// Any solo occurrences past the character count get appended (degenerate
	// case where characters died but solo's N stays locked).
	for (let i = interleaveCount; i < occurrenceSlots; i++) {
		expandedTurns.push(...legendaryCombatants);
	}
	expandedTurns.push(...nonCharacterNonLegendary);
	return expandedTurns;
}
