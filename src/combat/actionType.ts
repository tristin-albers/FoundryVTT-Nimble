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
