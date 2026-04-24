/**
 * Action types for the Combat Readiness variant rule.
 *
 * - `standard` — default action type (green pips)
 * - `bane` — penalized action granted to Hesitant heroes (purple pips)
 * - `inspired` — bonus action granted to Vigilant heroes (glowing white pips)
 */
export type ActionType = 'standard' | 'bane' | 'inspired';

export const ACTION_TYPE_STANDARD: ActionType = 'standard';
export const ACTION_TYPE_BANE: ActionType = 'bane';
export const ACTION_TYPE_INSPIRED: ActionType = 'inspired';

export type ReadinessTier = 'vigilant' | 'ready' | 'hesitant';

export function getReadinessTierFromRoll(rollTotal: number): ReadinessTier {
	if (rollTotal >= 20) return 'vigilant';
	if (rollTotal >= 10) return 'ready';
	return 'hesitant';
}

export function getPipTypesForReadiness(tier: ReadinessTier): ActionType[] {
	switch (tier) {
		case 'vigilant':
			return [ACTION_TYPE_INSPIRED, ACTION_TYPE_INSPIRED, ACTION_TYPE_STANDARD];
		case 'ready':
			return [ACTION_TYPE_STANDARD, ACTION_TYPE_STANDARD, ACTION_TYPE_STANDARD];
		case 'hesitant':
			return [ACTION_TYPE_BANE, ACTION_TYPE_BANE, ACTION_TYPE_STANDARD];
	}
}

export function getDefaultPipTypes(): ActionType[] {
	return [ACTION_TYPE_STANDARD, ACTION_TYPE_STANDARD, ACTION_TYPE_STANDARD];
}

export function isValidActionType(value: unknown): value is ActionType {
	return value === 'standard' || value === 'bane' || value === 'inspired';
}

/**
 * Find the best pip index to consume. Searches from highest index first.
 * Priority: preferred type (if given) > standard > bane > inspired.
 * Returns -1 if no active pip is available.
 */
export function findPipIndexToConsume(
	pipTypes: ActionType[],
	pipActiveStates: boolean[],
	preferredType?: ActionType,
): number {
	if (preferredType) {
		for (let i = 2; i >= 0; i--) {
			if (pipActiveStates[i] && pipTypes[i] === preferredType) return i;
		}
	}
	for (let i = 2; i >= 0; i--) {
		if (pipActiveStates[i] && pipTypes[i] === 'standard') return i;
	}
	for (let i = 2; i >= 0; i--) {
		if (pipActiveStates[i] && pipTypes[i] === 'bane') return i;
	}
	for (let i = 2; i >= 0; i--) {
		if (pipActiveStates[i] && pipTypes[i] === 'inspired') return i;
	}
	return -1;
}

/**
 * Predict which action type would be consumed next without modifying state.
 */
export function predictNextConsumedActionType(
	pipTypes: ActionType[],
	pipActiveStates: boolean[],
): ActionType {
	const index = findPipIndexToConsume(pipTypes, pipActiveStates);
	return index >= 0 ? pipTypes[index] : 'standard';
}
