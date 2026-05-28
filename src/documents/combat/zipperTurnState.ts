import { SYSTEM_ID } from '#system';
import {
	isBaneInspiredActionsEnabled,
	isCombatReadinessEnabled,
} from '../../settings/combatReadinessSettings.js';
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

const ZIPPER_FLAG_ROOT = `flags.${SYSTEM_ID}.zipper`;
const ZIPPER_CURRENT_SIDE_PATH = `${ZIPPER_FLAG_ROOT}.currentSide`;
const ZIPPER_ROUND_START_SIDE_PATH = `${ZIPPER_FLAG_ROOT}.roundStartSide`;
const ZIPPER_AWAITING_SELECTION_PATH = `${ZIPPER_FLAG_ROOT}.awaitingSelection`;
const ZIPPER_ACT_COUNTER_PATH = `${ZIPPER_FLAG_ROOT}.actCounter`;
const ZIPPER_TURN_HISTORY_PATH = `${ZIPPER_FLAG_ROOT}.turnHistory`;
const ZIPPER_SOLO_OCCURRENCES_PATH = `${ZIPPER_FLAG_ROOT}.soloOccurrencesPerRound`;

const ZIPPER_TURN_ACTED_PATH = 'system.zipperTurn.acted';
const ZIPPER_TURN_ACT_ORDER_PATH = 'system.zipperTurn.actOrder';

// ---------------------------------------------------------------------------
// Turn history entry shape
// ---------------------------------------------------------------------------

export type TurnHistoryEntry = {
	combatantId: string;
	side: ZipperSide;
	actOrder: number;
	undone: boolean;
	isGroup?: boolean;
	groupCombatantIds?: string[];
	/**
	 * For solo monsters that take N turns per round, this is the 0-based
	 * occurrence index for this specific turn. Omitted for single-occurrence
	 * combatants (heroes, regular NPCs, minions).
	 */
	occurrenceIndex?: number;
};

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
		if (!hasAnyOccurrenceUnacted(combat, combatant)) return false;
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
		(combatant) => !isCombatantDead(combatant) && hasAnyOccurrenceUnacted(combat, combatant),
	);
}

export function isOverflowPhase(combat: Combat): boolean {
	const playerRemaining = getUnactedCombatantsForSide(combat, 'player').length;
	const gmRemaining = getUnactedCombatantsForSide(combat, 'gm').length;
	return playerRemaining === 0 || gmRemaining === 0;
}

/**
 * Return the count of all alive combatants on a side, deduplicated by minion
 * group (one group counts as one combatant). Includes both acted and unacted.
 */
export function getAliveCountForSide(combat: Combat, side: ZipperSide): number {
	const groupSummaries = getMinionGroupSummaries(combat.combatants.contents);
	const seenGroupIds = new Set<string>();
	let count = 0;
	for (const combatant of combat.combatants.contents) {
		if (isCombatantDead(combatant)) continue;
		if (getCombatantZipperSide(combatant) !== side) continue;
		const groupId = getMinionGroupId(combatant);
		if (groupId) {
			if (seenGroupIds.has(groupId)) continue;
			seenGroupIds.add(groupId);
			const summary = groupSummaries.get(groupId);
			if (summary) {
				const leader = getEffectiveMinionGroupLeader(summary, { aliveOnly: true });
				if (leader && leader.id !== combatant.id) continue;
			}
		}
		count++;
	}
	return count;
}

/**
 * Side progress snapshot for Feature 6 (tracker indicator) and Feature 7
 * (end-of-side telegraph). Counts in OCCURRENCES (not combatants) so a solo
 * monster with N turns per round contributes N to the side's total. This is
 * what the user actually wants to see — "how many turns are left this round
 * on each side?" not "how many combatants are left."
 */
export function getZipperSideStats(combat: Combat): {
	player: { acted: number; total: number; unacted: number };
	gm: { acted: number; total: number; unacted: number };
} {
	return {
		player: getOccurrenceSideStats(combat, 'player'),
		gm: getOccurrenceSideStats(combat, 'gm'),
	};
}

function getOccurrenceSideStats(
	combat: Combat,
	side: ZipperSide,
): { acted: number; total: number; unacted: number } {
	const groupSummaries = getMinionGroupSummaries(combat.combatants.contents);
	const seenGroupIds = new Set<string>();
	let total = 0;
	let acted = 0;
	for (const combatant of combat.combatants.contents) {
		if (isCombatantDead(combatant)) continue;
		if (getCombatantZipperSide(combatant) !== side) continue;
		const groupId = getMinionGroupId(combatant);
		if (groupId) {
			if (seenGroupIds.has(groupId)) continue;
			seenGroupIds.add(groupId);
			const summary = groupSummaries.get(groupId);
			if (summary) {
				const leader = getEffectiveMinionGroupLeader(summary, { aliveOnly: true });
				if (leader && leader.id !== combatant.id) continue;
			}
		}
		const occurrences = getTotalOccurrencesForCombatant(combat, combatant);
		const id = combatant.id;
		const actedCount = id ? getActedOccurrenceCount(combat, id) : 0;
		total += occurrences;
		acted += Math.min(occurrences, actedCount);
	}
	return { acted, total, unacted: total - acted };
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
// Hesitant combatant helpers
// ---------------------------------------------------------------------------

export function isHesitantCombatant(combatant: Combatant.Implementation): boolean {
	const actor = combatant.actor as { statuses?: Set<string> } | null;
	return Boolean(actor?.statuses?.has('hesitant'));
}

/**
 * A hesitant combatant is blocked from acting while non-hesitant combatants
 * on the player side remain unacted. Only applies to player-side combatants.
 */
export function isHesitantBlocked(combat: Combat, combatantId: string): boolean {
	if (!isBaneInspiredActionsEnabled()) return false;
	const combatant = combat.combatants.get(combatantId);
	if (!combatant) return false;
	if (getCombatantZipperSide(combatant) !== 'player') return false;
	if (!isHesitantCombatant(combatant)) return false;

	const unactedPlayers = getUnactedCombatantsForSide(combat, 'player');
	return unactedPlayers.some((c) => c.id !== combatantId && !isHesitantCombatant(c));
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
	if (!hasAnyOccurrenceUnacted(combat, combatant)) return { valid: false, reason: 'alreadyActed' };
	if (getCombatantZipperSide(combatant) !== expectedSide) {
		return { valid: false, reason: 'wrongSide' };
	}
	if (isHesitantBlocked(combat, combatantId)) {
		return { valid: false, reason: 'hesitantBlocked' };
	}
	return { valid: true };
}

// ---------------------------------------------------------------------------
// Turn history (Feature 4)
// ---------------------------------------------------------------------------

export function getTurnHistory(combat: Combat): TurnHistoryEntry[] {
	const value = getFlagValue(combat, ZIPPER_TURN_HISTORY_PATH);
	return Array.isArray(value) ? (value as TurnHistoryEntry[]) : [];
}

export function buildAppendTurnHistoryUpdate(
	combat: Combat,
	entry: Omit<TurnHistoryEntry, 'undone'>,
): Record<string, unknown> {
	const existing = getTurnHistory(combat);
	const newEntry: TurnHistoryEntry = { ...entry, undone: false };
	return { [ZIPPER_TURN_HISTORY_PATH]: [...existing, newEntry] };
}

/**
 * Mark the latest non-undone history entry for a SPECIFIC combatant as undone.
 * Used by the GM toggle-acted button (unmark side) so we undo the right
 * combatant's most recent turn, not just the rightmost-overall entry.
 * Returns null if no matching non-undone entry exists.
 */
export function buildMarkLastTurnUndoneForCombatantUpdate(
	combat: Combat,
	combatantId: string,
): Record<string, unknown> | null {
	const existing = getTurnHistory(combat);
	let targetIndex = -1;
	for (let i = existing.length - 1; i >= 0; i--) {
		if (existing[i].combatantId === combatantId && !existing[i].undone) {
			targetIndex = i;
			break;
		}
	}
	if (targetIndex < 0) return null;
	const next = existing.map((entry, index) =>
		index === targetIndex ? { ...entry, undone: true } : entry,
	);
	return { [ZIPPER_TURN_HISTORY_PATH]: next };
}

/**
 * Mark the last NOT-already-undone entry as undone. Returns null if history is
 * empty or every entry is already undone (nothing to undo).
 */
export function buildMarkLastTurnUndoneUpdate(combat: Combat): Record<string, unknown> | null {
	const existing = getTurnHistory(combat);
	if (existing.length === 0) return null;

	// Find the rightmost not-undone entry.
	let targetIndex = -1;
	for (let i = existing.length - 1; i >= 0; i--) {
		if (!existing[i].undone) {
			targetIndex = i;
			break;
		}
	}
	if (targetIndex < 0) return null;

	const next = existing.map((entry, index) =>
		index === targetIndex ? { ...entry, undone: true } : entry,
	);
	return { [ZIPPER_TURN_HISTORY_PATH]: next };
}

export function buildClearTurnHistoryUpdate(): Record<string, unknown> {
	return { [ZIPPER_TURN_HISTORY_PATH]: [] };
}

// ---------------------------------------------------------------------------
// Previous-turn unwind (Bug 1)
// ---------------------------------------------------------------------------

/**
 * Build the updates needed to reverse one turn in zipper mode. Uses the
 * matching turn history entry as the source of truth (not `combat.combatant`)
 * so the unwind is correct even after the active combatant has changed.
 *
 * Two distinct cases:
 *
 * - **`turnEnded: true`** (the standard case — `_onEndTurn` already ran for
 *   the entry's combatant): decrement `actCounter` by the entry's footprint
 *   (1 for a single, `groupCombatantIds.length` for a GM-shift-click group),
 *   restore `currentSide` to the entry's side, unmark every member as acted,
 *   set `awaitingSelection: true`, and mark the entry undone.
 *
 * - **`turnEnded: false`** (in-progress case). Two sub-cases:
 *     - Single-combatant: selectZipperCombatant set `awaitingSelection: false`
 *       and appended history, but didn't bump `actCounter` or mark acted —
 *       only revert the selection signal.
 *     - Group: `selectZipperGroup` marks the FOLLOWERS acted and bumps the
 *       counter by `followers.length` BEFORE the leader's `selectZipperCombatant`
 *       runs, so the leader is in-progress but followers are already committed.
 *       Unwind reverses the follower commitments (unmarks them, decrements
 *       counter by `followers.length`) while leaving the leader untouched.
 *
 * Returns an object split into `combatFlags` (single update against the
 * combat) and `combatantUpdates` (array passed to
 * `updateEmbeddedDocuments('Combatant')`).
 */
export function buildPreviousTurnUnwindUpdate(
	combat: Combat,
	entry: TurnHistoryEntry,
	options: { turnEnded: boolean } = { turnEnded: true },
): {
	combatFlags: Record<string, unknown>;
	combatantUpdates: Record<string, unknown>[];
} {
	const combatFlags: Record<string, unknown> = {
		[ZIPPER_AWAITING_SELECTION_PATH]: true,
	};

	const historyUpdate = buildMarkLastTurnUndoneUpdate(combat);
	if (historyUpdate) Object.assign(combatFlags, historyUpdate);

	const isGroup =
		entry.isGroup && Array.isArray(entry.groupCombatantIds) && entry.groupCombatantIds.length > 0;
	const groupIds = isGroup ? (entry.groupCombatantIds as string[]) : [];

	if (!options.turnEnded) {
		if (isGroup && groupIds.length > 1) {
			// Group in-progress: followers were marked acted by selectZipperGroup and
			// the counter was bumped by followers.length. Reverse just those commitments.
			const followerIds = groupIds.slice(1);
			combatFlags[ZIPPER_ACT_COUNTER_PATH] = Math.max(
				0,
				getZipperActCounter(combat) - followerIds.length,
			);
			return {
				combatFlags,
				combatantUpdates: dedupeUnmarkActedUpdates(combat, followerIds),
			};
		}
		// Single in-progress: nothing else to reverse.
		return { combatFlags, combatantUpdates: [] };
	}

	// Ended turn: full unwind for the whole footprint (single or group).
	const memberIds = isGroup ? groupIds : [entry.combatantId];
	combatFlags[ZIPPER_ACT_COUNTER_PATH] = Math.max(
		0,
		getZipperActCounter(combat) - memberIds.length,
	);
	combatFlags[ZIPPER_CURRENT_SIDE_PATH] = entry.side;

	return {
		combatFlags,
		combatantUpdates: dedupeUnmarkActedUpdates(combat, memberIds),
	};
}

/**
 * Build unmark-acted updates for a list of combatant ids, deduplicated by `_id`.
 * `buildUnmarkActedUpdates` returns updates for the entire minion group of any
 * member it's called with, so calling it once per id in `ids` can produce N
 * copies of the same row when those ids share a minion group.
 */
function dedupeUnmarkActedUpdates(combat: Combat, ids: string[]): Record<string, unknown>[] {
	const seen = new Set<string>();
	const updates: Record<string, unknown>[] = [];
	for (const id of ids) {
		if (!combat.combatants.get(id)) continue;
		for (const update of buildUnmarkActedUpdates(combat, id)) {
			const targetId = update._id;
			if (typeof targetId === 'string' && !seen.has(targetId)) {
				seen.add(targetId);
				updates.push(update);
			}
		}
	}
	return updates;
}

// ---------------------------------------------------------------------------
// Solo-monster multi-turn support
//
// In zipper initiative, a solo monster acts after each hero — so it gets N
// turns per round where N = alive hero count at round start. We snapshot N
// at the start of every round and derive per-occurrence acted state from the
// turn history (instead of mutating per-combatant flags) so the existing undo
// flow naturally works at the occurrence granularity.
// ---------------------------------------------------------------------------

/**
 * Read the round-start snapshot of how many turns each solo monster gets this
 * round. Defaults to 1 if missing or 0 (degenerate case — clamping avoids a
 * softlock where the solo would otherwise never be eligible).
 */
export function getSoloOccurrencesPerRound(combat: Combat): number {
	const raw = getFlagValue(combat, ZIPPER_SOLO_OCCURRENCES_PATH);
	const value = Number(raw ?? 1);
	if (!Number.isFinite(value) || value < 1) return 1;
	return Math.trunc(value);
}

/**
 * Build an update that snapshots `soloOccurrencesPerRound` for the current
 * round. Caller is responsible for passing in the alive-hero count (we don't
 * count here so the function stays pure / testable).
 */
export function buildSoloOccurrencesSnapshotUpdate(
	aliveHeroCount: number,
): Record<string, unknown> {
	const safe =
		Number.isFinite(aliveHeroCount) && aliveHeroCount > 0 ? Math.trunc(aliveHeroCount) : 1;
	return { [ZIPPER_SOLO_OCCURRENCES_PATH]: safe };
}

/**
 * Count non-undone turn-history entries for a given combatantId. This is the
 * "how many of this combatant's occurrences have acted" derivation used by
 * `hasOccurrenceActed`, `hasAnyOccurrenceUnacted`, and `getNextUnactedOccurrence`.
 *
 * Memoized by (combat, history-array-reference). Foundry document updates
 * produce a new history array, so reference equality auto-invalidates the
 * cache as soon as a turn ends or is undone.
 */
const actedCountMemo = new WeakMap<
	Combat,
	{ history: TurnHistoryEntry[]; counts: Map<string, number> }
>();

export function getActedOccurrenceCount(combat: Combat, combatantId: string): number {
	const history = getTurnHistory(combat);
	let memo = actedCountMemo.get(combat);
	if (!memo || memo.history !== history) {
		const counts = new Map<string, number>();
		for (const entry of history) {
			if (entry.undone) continue;
			counts.set(entry.combatantId, (counts.get(entry.combatantId) ?? 0) + 1);
		}
		memo = { history, counts };
		actedCountMemo.set(combat, memo);
	}
	return memo.counts.get(combatantId) ?? 0;
}

/**
 * Total turns this combatant gets per round. Solos get N (the round-start
 * snapshot); every other combatant gets 1.
 */
export function getTotalOccurrencesForCombatant(
	combat: Combat,
	combatant: Combatant.Implementation,
): number {
	if (combatant.type === 'soloMonster') return getSoloOccurrencesPerRound(combat);
	return 1;
}

/**
 * Has this specific occurrence (0-based) of the combatant acted yet?
 * `count > index` because acted-count is 1-based but occurrence-index is 0-based.
 */
export function hasOccurrenceActed(
	combat: Combat,
	combatant: Combatant.Implementation,
	occurrenceIndex: number,
): boolean {
	const id = combatant.id;
	if (!id) return false;
	return getActedOccurrenceCount(combat, id) > occurrenceIndex;
}

/**
 * True when this specific (combatant, occurrence) is the currently-active turn —
 * i.e., the latest matching non-undone history entry has `actOrder > actCounter`,
 * which means `selectZipperCombatant` ran but `#zipperNextTurn` hasn't bumped
 * the counter yet. Used by the tracker to give the active card a "middle zone"
 * presentation instead of immediately dimming it as already-acted.
 */
export function isOccurrenceInProgress(
	combat: Combat,
	combatant: Combatant.Implementation,
	occurrenceIndex: number,
): boolean {
	const id = combatant.id;
	if (!id) return false;
	const history = getTurnHistory(combat);
	const actCounter = getZipperActCounter(combat);
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (entry.undone) continue;
		if (entry.combatantId !== id) continue;
		const entryOccurrence = entry.occurrenceIndex ?? 0;
		if (entryOccurrence !== occurrenceIndex) continue;
		return entry.actOrder > actCounter;
	}
	return false;
}

/**
 * True when this occurrence has acted AND the turn has ended (counter bumped
 * past the entry's actOrder). Distinct from `hasOccurrenceActed` which is true
 * during the in-progress window as well.
 */
export function hasFinishedOccurrence(
	combat: Combat,
	combatant: Combatant.Implementation,
	occurrenceIndex: number,
): boolean {
	if (!hasOccurrenceActed(combat, combatant, occurrenceIndex)) return false;
	return !isOccurrenceInProgress(combat, combatant, occurrenceIndex);
}

/**
 * Eligibility check used by `getUnactedCombatantsForSide`, token overlay
 * eligibility builder, and the GM's selection validators. Returns true while
 * the combatant has at least one occurrence left to act.
 *
 * For non-solos this collapses to `!hasZipperActed` (acted count 0 → true,
 * acted count 1 → false).
 */
export function hasAnyOccurrenceUnacted(
	combat: Combat,
	combatant: Combatant.Implementation,
): boolean {
	const total = getTotalOccurrencesForCombatant(combat, combatant);
	const id = combatant.id;
	if (!id) return false;
	return getActedOccurrenceCount(combat, id) < total;
}

/**
 * True if the latest non-undone history entry is "in progress" — i.e.,
 * selectZipperCombatant ran (appended the entry) but #zipperNextTurn hasn't
 * bumped actCounter yet. Used by #zipperNextTurn to decide whether to bump
 * (replaces the broken `!hasZipperActed` guard which silently skipped for
 * solo monsters past their first turn since the per-combatant flag was
 * permanently true).
 */
export function hasInProgressTurn(combat: Combat): boolean {
	const history = getTurnHistory(combat);
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].undone) continue;
		return getZipperActCounter(combat) < history[i].actOrder;
	}
	return false;
}

/**
 * Sum of remaining (unacted) occurrences across all alive combatants on a
 * side. Differs from `getUnactedCombatantsForSide(...).length` for solos —
 * a solo with 2/3 occurrences remaining contributes 2, not 1. Used for the
 * end-of-side telegraph so amber fires only when literally one turn remains
 * on the side, not when one combatant remains.
 */
export function getRemainingOccurrenceCountForSide(combat: Combat, side: ZipperSide): number {
	let total = 0;
	for (const combatant of getUnactedCombatantsForSide(combat, side)) {
		const id = combatant.id;
		if (!id) continue;
		const totalOccurrences = getTotalOccurrencesForCombatant(combat, combatant);
		const acted = getActedOccurrenceCount(combat, id);
		total += Math.max(0, totalOccurrences - acted);
	}
	return total;
}

/**
 * For solo selection: which occurrence (0-based) is up next. Equals the
 * acted-count (because the next unacted slot is at index = count). Returns
 * -1 when every occurrence has been used.
 */
export function getNextUnactedOccurrence(
	combat: Combat,
	combatant: Combatant.Implementation,
): number {
	const total = getTotalOccurrencesForCombatant(combat, combatant);
	const id = combatant.id;
	if (!id) return -1;
	const acted = getActedOccurrenceCount(combat, id);
	return acted < total ? acted : -1;
}
