import { isCombatReadinessEnabled } from '../../settings/combatReadinessSettings.js';
import { isCombatantDead } from '../../utils/isCombatantDead.js';
import {
	getEffectiveMinionGroupLeader,
	getMinionGroupId,
	getMinionGroupSummaries,
} from '../../utils/minionGrouping.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type ZipperSide = 'player' | 'gm';

const ZIPPER_FLAG_ROOT = 'flags.nimble.zipper';
const ZIPPER_CURRENT_SIDE_PATH = `${ZIPPER_FLAG_ROOT}.currentSide`;
const ZIPPER_ROUND_START_SIDE_PATH = `${ZIPPER_FLAG_ROOT}.roundStartSide`;
const ZIPPER_AWAITING_SELECTION_PATH = `${ZIPPER_FLAG_ROOT}.awaitingSelection`;
const ZIPPER_ACT_COUNTER_PATH = `${ZIPPER_FLAG_ROOT}.actCounter`;

const ZIPPER_TURN_ACTED_PATH = 'system.zipperTurn.acted';
const ZIPPER_TURN_ACT_ORDER_PATH = 'system.zipperTurn.actOrder';

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

export function isZipperInitiativeActive(): boolean {
	return isCombatReadinessEnabled();
}

// ---------------------------------------------------------------------------
// Read zipper flags from combat document
// ---------------------------------------------------------------------------

function getFlagValue(target: unknown, path: string): unknown {
	if (!target || typeof target !== 'object') return undefined;
	return foundry.utils.getProperty(target, path);
}

export function getZipperCurrentSide(combat: Combat): ZipperSide {
	const value = getFlagValue(combat, ZIPPER_CURRENT_SIDE_PATH);
	return value === 'gm' ? 'gm' : 'player';
}

export function getZipperRoundStartSide(combat: Combat): ZipperSide {
	const value = getFlagValue(combat, ZIPPER_ROUND_START_SIDE_PATH);
	return value === 'gm' ? 'gm' : 'player';
}

export function isZipperAwaitingSelection(combat: Combat): boolean {
	return getFlagValue(combat, ZIPPER_AWAITING_SELECTION_PATH) === true;
}

export function getZipperActCounter(combat: Combat): number {
	const value = Number(getFlagValue(combat, ZIPPER_ACT_COUNTER_PATH) ?? 0);
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

// ---------------------------------------------------------------------------
// Build update data for combat flags
// ---------------------------------------------------------------------------

export function buildZipperCombatFlagUpdate(params: {
	currentSide?: ZipperSide;
	roundStartSide?: ZipperSide;
	awaitingSelection?: boolean;
	actCounter?: number;
}): Record<string, unknown> {
	const update: Record<string, unknown> = {};
	if (params.currentSide !== undefined) update[ZIPPER_CURRENT_SIDE_PATH] = params.currentSide;
	if (params.roundStartSide !== undefined)
		update[ZIPPER_ROUND_START_SIDE_PATH] = params.roundStartSide;
	if (params.awaitingSelection !== undefined)
		update[ZIPPER_AWAITING_SELECTION_PATH] = params.awaitingSelection;
	if (params.actCounter !== undefined) update[ZIPPER_ACT_COUNTER_PATH] = params.actCounter;
	return update;
}

// ---------------------------------------------------------------------------
// Combatant acted state accessors
// ---------------------------------------------------------------------------

export function hasZipperActed(combatant: Combatant.Implementation): boolean {
	return foundry.utils.getProperty(combatant, ZIPPER_TURN_ACTED_PATH) === true;
}

export function getZipperActOrder(combatant: Combatant.Implementation): number {
	const value = Number(foundry.utils.getProperty(combatant, ZIPPER_TURN_ACT_ORDER_PATH) ?? 0);
	return Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Side determination from token disposition
// ---------------------------------------------------------------------------

export function getCombatantZipperSide(combatant: Combatant.Implementation): ZipperSide {
	if (combatant.type === 'character') return 'player';
	const tokenDisposition = Number(
		combatant.token?.disposition ?? combatant.token?.object?.document?.disposition ?? NaN,
	);
	if (tokenDisposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) return 'player';
	return 'gm';
}

// ---------------------------------------------------------------------------
// Eligible combatants for a given side
// ---------------------------------------------------------------------------

export function getUnactedCombatantsForSide(
	combat: Combat,
	side: ZipperSide,
): Combatant.Implementation[] {
	const groupSummaries = getMinionGroupSummaries(combat.combatants.contents);
	const seenGroupIds = new Set<string>();

	return combat.combatants.contents.filter((combatant) => {
		if (isCombatantDead(combatant)) return false;
		if (hasZipperActed(combatant)) return false;
		if (getCombatantZipperSide(combatant) !== side) return false;

		// For minion groups, only include the effective leader
		const groupId = getMinionGroupId(combatant);
		if (groupId) {
			if (seenGroupIds.has(groupId)) return false;
			seenGroupIds.add(groupId);
			const summary = groupSummaries.get(groupId);
			if (summary) {
				const leader = getEffectiveMinionGroupLeader(summary, { aliveOnly: true });
				if (leader && leader.id !== combatant.id) return false;
			}
		}

		return true;
	});
}

export function getAllUnactedCombatants(combat: Combat): Combatant.Implementation[] {
	return combat.combatants.contents.filter(
		(combatant) => !isCombatantDead(combatant) && !hasZipperActed(combatant),
	);
}

export function isOverflowPhase(combat: Combat): boolean {
	const playerRemaining = getUnactedCombatantsForSide(combat, 'player').length;
	const gmRemaining = getUnactedCombatantsForSide(combat, 'gm').length;
	return playerRemaining === 0 || gmRemaining === 0;
}

export function hasAllCombatantsActed(combat: Combat): boolean {
	return getAllUnactedCombatants(combat).length === 0;
}

// ---------------------------------------------------------------------------
// Resolve next side after a turn ends
// ---------------------------------------------------------------------------

export function resolveNextSide(combat: Combat, currentSide: ZipperSide): ZipperSide {
	const otherSide: ZipperSide = currentSide === 'player' ? 'gm' : 'player';
	const otherRemaining = getUnactedCombatantsForSide(combat, otherSide).length;
	if (otherRemaining > 0) return otherSide;

	// Overflow: other side has no one left, stay on current side
	const currentRemaining = getUnactedCombatantsForSide(combat, currentSide).length;
	if (currentRemaining > 0) return currentSide;

	// Everyone has acted — round should end
	return otherSide;
}

// ---------------------------------------------------------------------------
// Mark combatant(s) as acted
// ---------------------------------------------------------------------------

function buildActedUpdate(combatantId: string, actOrder: number): Record<string, unknown> {
	return {
		_id: combatantId,
		[ZIPPER_TURN_ACTED_PATH]: true,
		[ZIPPER_TURN_ACT_ORDER_PATH]: actOrder,
	};
}

function buildUnactedUpdate(combatantId: string): Record<string, unknown> {
	return {
		_id: combatantId,
		[ZIPPER_TURN_ACTED_PATH]: false,
		[ZIPPER_TURN_ACT_ORDER_PATH]: 0,
	};
}

/**
 * Build update data to mark a combatant (and its minion group members) as acted.
 * Returns the combatant updates array and the actOrder assigned.
 */
export function buildMarkActedUpdates(
	combat: Combat,
	combatantId: string,
): Record<string, unknown>[] {
	const combatant = combat.combatants.get(combatantId);
	if (!combatant) return [];

	const actOrder = getZipperActCounter(combat) + 1;
	const updates: Record<string, unknown>[] = [];

	const groupId = getMinionGroupId(combatant);
	if (groupId) {
		// Mark all alive group members as acted with the same actOrder
		const summaries = getMinionGroupSummaries(combat.combatants.contents);
		const summary = summaries.get(groupId);
		if (summary) {
			for (const member of summary.aliveMembers) {
				if (member.id) updates.push(buildActedUpdate(member.id, actOrder));
			}
		}
	}

	if (updates.length === 0) {
		updates.push(buildActedUpdate(combatantId, actOrder));
	}

	return updates;
}

/**
 * Build update data to un-mark a combatant (and its minion group) as acted.
 */
export function buildUnmarkActedUpdates(
	combat: Combat,
	combatantId: string,
): Record<string, unknown>[] {
	const combatant = combat.combatants.get(combatantId);
	if (!combatant) return [];

	const updates: Record<string, unknown>[] = [];

	const groupId = getMinionGroupId(combatant);
	if (groupId) {
		const summaries = getMinionGroupSummaries(combat.combatants.contents);
		const summary = summaries.get(groupId);
		if (summary) {
			for (const member of summary.members) {
				if (member.id) updates.push(buildUnactedUpdate(member.id));
			}
		}
	}

	if (updates.length === 0) {
		updates.push(buildUnactedUpdate(combatantId));
	}

	return updates;
}

/**
 * Build update data to reset all acted flags for a new round.
 */
export function buildResetAllActedUpdates(combat: Combat): Record<string, unknown>[] {
	return combat.combatants.contents.reduce<Record<string, unknown>[]>((acc, combatant) => {
		if (!combatant.id) return acc;
		if (!hasZipperActed(combatant) && getZipperActOrder(combatant) === 0) return acc;
		acc.push(buildUnactedUpdate(combatant.id));
		return acc;
	}, []);
}

// ---------------------------------------------------------------------------
// Determine first side at combat start
// ---------------------------------------------------------------------------

/**
 * Determine which side goes first based on the highest character initiative roll.
 * If any character rolled 10+, players go first; otherwise GM goes first.
 * This mirrors the Draw Steel "roll to determine first side" concept using existing
 * initiative data that was already rolled for readiness tiers.
 */
export function determineFirstSide(combat: Combat): ZipperSide {
	let highestCharacterInitiative = -Infinity;
	for (const combatant of combat.combatants.contents) {
		if (combatant.type !== 'character') continue;
		const initiative = Number(combatant.initiative ?? -Infinity);
		if (initiative > highestCharacterInitiative) highestCharacterInitiative = initiative;
	}
	return highestCharacterInitiative >= 10 ? 'player' : 'gm';
}

// ---------------------------------------------------------------------------
// Validation for combatant selection
// ---------------------------------------------------------------------------

export function canSelectCombatantForZipperTurn(
	combat: Combat,
	combatantId: string,
	expectedSide: ZipperSide,
): { valid: boolean; reason?: string } {
	const combatant = combat.combatants.get(combatantId);
	if (!combatant) return { valid: false, reason: 'notFound' };
	if (isCombatantDead(combatant)) return { valid: false, reason: 'dead' };
	if (hasZipperActed(combatant)) return { valid: false, reason: 'alreadyActed' };
	if (getCombatantZipperSide(combatant) !== expectedSide) {
		return { valid: false, reason: 'wrongSide' };
	}
	return { valid: true };
}
