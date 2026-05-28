import { createSubscriber } from 'svelte/reactivity';
import type { ActorRollOptions } from '#documents/actor/actorInterfaces.ts';
import type { NimbleCombatant } from '#documents/combatant/combatant.svelte.js';
import { SYSTEM_ID } from '#system';
import {
	getHeroicReactionUsageState,
	isSoftBlockedReason,
} from '#utils/getHeroicReactionUsageState.js';
import {
	canOwnerUseHeroicReaction,
	getHeroicReactionAvailability,
	getHeroicReactionAvailabilityUpdate,
	HEROIC_REACTIONS,
	type HeroicReactionKey,
} from '#utils/heroicActions.js';
import { initiativeRollLock } from '#utils/initiativeRollLock.js';
import { isCombatantDead } from '#utils/isCombatantDead.js';
import { getMinionGroupId, getMinionGroupSummaries } from '#utils/minionGrouping.js';
import { queueCombatantMutationWithFreshDocument } from '#utils/queueCombatantMutationWithFreshDocument.js';
import { findPipIndexToConsume } from '../../combat/actionType.js';
import { isBaneInspiredActionsEnabled } from '../../settings/combatReadinessSettings.js';
import {
	getCombatantBaseActionMax,
	getCombatantManualSortValue,
	getCombatantPipActiveStates,
	getCombatantPipTypes,
} from './combatantSystem.js';
import { getCombatantCurrentActions, logMinionGroupingCombat } from './combatCommon.js';
import { rollInitiativeForCombatant } from './combatInitiative.js';
import { performMinionGroupAttack } from './combatMinionAttacks.js';
import {
	assignNcsTemporaryGroupFromAttackMembers,
	assignPersistentTurnGroup,
	dissolveRoundBoundaryMinionGroups,
	removeCombatantFromTurnGroup,
} from './combatMinionGroups.js';
import {
	applyGmSort,
	applyOwnerSort,
	resolveDropContext,
	sortCombatants,
} from './combatSorting.js';
import { expandLegendaryTurns, normalizeMinionTurns } from './combatTurns.js';
import type {
	InitiativeRollOutcome,
	MinionGroupAttackParams,
	MinionGroupAttackResult,
	TurnIdentity,
} from './combatTypes.js';
import {
	buildExpandedTurnIdentityUpdate,
	getExpandedTurnIdentityHint,
	getPersistedExpandedTurnIdentity,
	setExpandedTurnIdentityHint,
} from './expandedTurnIdentityStore.js';
import {
	buildAppendTurnHistoryUpdate,
	buildClearTurnHistoryUpdate,
	buildMarkActedUpdates,
	buildMarkLastTurnUndoneForCombatantUpdate,
	buildPreviousTurnUnwindUpdate,
	buildResetAllActedUpdates,
	buildSoloOccurrencesSnapshotUpdate,
	buildUnmarkActedUpdates,
	buildZipperCombatFlagUpdate,
	canSelectCombatantForZipperTurn,
	getActedOccurrenceCount,
	getCombatantZipperSide,
	getNextUnactedOccurrence,
	getSoloOccurrencesPerRound,
	getTotalOccurrencesForCombatant,
	getTurnHistory,
	getUnactedCombatantsForSide,
	getZipperActCounter,
	getZipperCurrentSide,
	hasAllCombatantsActed,
	hasAnyOccurrenceUnacted,
	hasInProgressTurn,
	hasOccurrenceActed,
	isOccurrenceInProgress,
	isZipperAwaitingSelection,
	isZipperFirstSidePending,
	isZipperInitiativeActive,
	resolveNextSide,
	type TurnHistoryEntry,
} from './zipperTurnState.js';

const COMBATANT_FALLBACK_KEY = Symbol('nimbleCombatantFallback');

type CombatWithTurnIdentityHint = Combat & {
	_nimbleExpandedTurnIdentity?: TurnIdentity | null;
};

type ActorWithCurrentSceneTokens = Actor.Implementation & {
	getActiveTokens?: (linked?: boolean, document?: boolean) => TokenDocument[];
	isToken?: boolean;
	token?: TokenDocument | null;
};

function getCombatantSceneId(combatant: Combatant.Implementation): string | null {
	return combatant.sceneId ?? combatant.token?.parent?.id ?? null;
}

function isCombatantInScene(combatant: Combatant.Implementation, sceneId: string): boolean {
	return getCombatantSceneId(combatant) === sceneId;
}

function resolveInsertedCombatantSortValue(params: {
	nextCombatant?: Combatant.Implementation | null;
	previousCombatant?: Combatant.Implementation | null;
}): number {
	const previousCombatant = params.previousCombatant ?? null;
	const nextCombatant = params.nextCombatant ?? null;

	if (previousCombatant && nextCombatant) {
		const previousSort = getCombatantManualSortValue(previousCombatant);
		const nextSort = getCombatantManualSortValue(nextCombatant);
		if (previousSort === nextSort) {
			return previousSort + 0.5;
		}
		return previousSort + (nextSort - previousSort) / 2;
	}

	if (previousCombatant) {
		return getCombatantManualSortValue(previousCombatant) + 1;
	}

	if (nextCombatant) {
		return getCombatantManualSortValue(nextCombatant) - 1;
	}

	return 0;
}

interface LockedInitiativeRollOutcome {
	combatantId: string;
	requestId: string;
	outcome: InitiativeRollOutcome;
}

interface ResolvedInitiativeRollData {
	rollFormula: string;
	rollMode: number;
	visibilityMode?: string | undefined;
}

interface ActorWithInitiativeRollConfiguration extends Actor {
	resolveInitiativeRollData?: (
		options?: ActorRollOptions,
	) => Promise<ResolvedInitiativeRollData | null>;
}

class NimbleCombat extends Combat {
	#subscribe: ReturnType<typeof createSubscriber>;
	#expandedTurnIdentity: TurnIdentity | null = null;
	#pendingAtomicTurnIdentity: TurnIdentity | null = null;
	#didInterceptAtomicTurnStateUpdate = false;
	#initiativeRollRequests = new Map<string, Promise<LockedInitiativeRollOutcome | null>>();

	#findActorCombatantInScene(actorId: string, sceneId: string): Combatant.Implementation | null {
		return (
			this.combatants.find(
				(combatant) => combatant.actorId === actorId && isCombatantInScene(combatant, sceneId),
			) ?? null
		);
	}

	#resolveActorTokenForCurrentScene(
		actor: Actor.Implementation,
		sceneId: string,
	): TokenDocument | null {
		const actorWithTokens = actor as ActorWithCurrentSceneTokens;

		if (actorWithTokens.isToken && actorWithTokens.token?.parent?.id === sceneId) {
			return actorWithTokens.token;
		}

		const activeTokens =
			typeof actorWithTokens.getActiveTokens === 'function'
				? actorWithTokens.getActiveTokens(true, true)
				: [];
		return activeTokens.find((token) => token.parent?.id === sceneId) ?? null;
	}

	async #getSceneCombatantsWithNormalizedSorts(
		sceneId: string,
	): Promise<Combatant.Implementation[]> {
		const orderedCombatants = this.combatants.contents
			.filter((combatant) => isCombatantInScene(combatant, sceneId))
			.sort(sortCombatants);

		const updates = orderedCombatants.reduce<Record<string, unknown>[]>(
			(accumulator, combatant, index) => {
				const combatantId = combatant.id ?? combatant._id ?? null;
				if (!combatantId) return accumulator;

				const nextSort = index + 1;
				if (getCombatantManualSortValue(combatant) === nextSort) {
					return accumulator;
				}

				accumulator.push({
					_id: combatantId,
					'system.sort': nextSort,
				});
				return accumulator;
			},
			[],
		);

		if (updates.length > 0) {
			await this.updateEmbeddedDocuments('Combatant', updates);
		}

		return this.combatants.contents
			.filter((combatant) => isCombatantInScene(combatant, sceneId))
			.sort(sortCombatants);
	}

	#resolveLateJoinCharacterSortValue(sceneCombatants: Combatant.Implementation[]): number {
		let lastAliveCharacterIndex = -1;

		for (const [index, combatant] of sceneCombatants.entries()) {
			if (combatant.type === 'character' && !isCombatantDead(combatant)) {
				lastAliveCharacterIndex = index;
			}
		}

		if (lastAliveCharacterIndex < 0) {
			return resolveInsertedCombatantSortValue({
				nextCombatant: sceneCombatants.find((combatant) => !isCombatantDead(combatant)) ?? null,
			});
		}

		return resolveInsertedCombatantSortValue({
			previousCombatant: sceneCombatants[lastAliveCharacterIndex] ?? null,
			nextCombatant: sceneCombatants[lastAliveCharacterIndex + 1] ?? null,
		});
	}

	async ensureCharacterCombatantForActorInCurrentScene(
		actor: Actor.Implementation,
	): Promise<Combatant.Implementation | null> {
		const actorId = actor.id ?? actor._id ?? null;
		const sceneId = canvas.scene?.id ?? this.scene?.id ?? null;
		if (!actorId || !sceneId) return null;
		if (this.scene?.id && this.scene.id !== sceneId) return null;

		const existingCombatant = this.#findActorCombatantInScene(actorId, sceneId);
		if (existingCombatant) return existingCombatant;

		const sceneCombatants = await this.#getSceneCombatantsWithNormalizedSorts(sceneId);
		const token = this.#resolveActorTokenForCurrentScene(actor, sceneId);
		const createData: Record<string, unknown> = {
			type: 'character',
			actorId,
			tokenId: token?.id ?? '',
			sceneId,
			hidden: Boolean(token?.hidden),
			system: {
				sort: this.#resolveLateJoinCharacterSortValue(sceneCombatants),
			},
		};

		const createdCombatants = (await this.createEmbeddedDocuments('Combatant', [
			createData as unknown as foundry.abstract.Document.CreateDataForName<'Combatant'>,
		])) as Combatant.Implementation[] | undefined;

		return createdCombatants?.[0] ?? this.#findActorCombatantInScene(actorId, sceneId);
	}

	#readStoredExpandedTurnIdentity(): TurnIdentity | null {
		const persistedTurnIdentity = getPersistedExpandedTurnIdentity(this);
		if (persistedTurnIdentity) {
			this.#storeExpandedTurnIdentity(persistedTurnIdentity);
			return persistedTurnIdentity;
		}
		const hintedTurnIdentity = getExpandedTurnIdentityHint(this.id ?? null);
		if (hintedTurnIdentity) {
			this.#storeExpandedTurnIdentity(hintedTurnIdentity);
		}
		return hintedTurnIdentity;
	}

	#storeExpandedTurnIdentity(turnIdentity: TurnIdentity | null): void {
		this.#expandedTurnIdentity = turnIdentity;
		(this as CombatWithTurnIdentityHint)._nimbleExpandedTurnIdentity = turnIdentity;
		setExpandedTurnIdentityHint(this.id ?? null, turnIdentity);
	}

	#resolveTurnIdentityAtIndex(
		turns: Combatant.Implementation[],
		turnIndex: number | null,
	): TurnIdentity | null {
		if (
			!Number.isInteger(turnIndex) ||
			turnIndex == null ||
			turnIndex < 0 ||
			turnIndex >= turns.length
		) {
			return null;
		}
		const combatantId = turns[turnIndex]?.id ?? '';
		if (!combatantId) return null;
		return {
			combatantId,
			occurrence: this.#getCombatantOccurrenceAtIndex(turns, combatantId, turnIndex),
		};
	}

	#resolveCurrentTurnIdentity(
		turns: Combatant.Implementation[] = this.turns,
		fallbackCombatantId?: string | null,
	): TurnIdentity | null {
		const storedTurnIdentity = this.#readStoredExpandedTurnIdentity();
		if (storedTurnIdentity) return storedTurnIdentity;
		if (this.#expandedTurnIdentity) return this.#expandedTurnIdentity;

		const normalizedCurrentTurn =
			typeof this.turn === 'number' && this.turn >= 0 && this.turn < turns.length
				? this.turn
				: null;
		const indexedTurnIdentity = this.#resolveTurnIdentityAtIndex(turns, normalizedCurrentTurn);
		if (indexedTurnIdentity) return indexedTurnIdentity;

		const explicitCombatantId = fallbackCombatantId ?? this.combatant?.id ?? null;

		if (explicitCombatantId) {
			return { combatantId: explicitCombatantId, occurrence: null };
		}

		return null;
	}

	#resolveNextTurnIdentity(turns: Combatant.Implementation[] = this.turns): TurnIdentity | null {
		if (turns.length < 1) return null;
		const normalizedCurrentTurn =
			typeof this.turn === 'number' && this.turn >= 0 && this.turn < turns.length ? this.turn : 0;
		const nextTurnIndex = (normalizedCurrentTurn + 1) % turns.length;
		return this.#resolveTurnIdentityAtIndex(turns, nextTurnIndex);
	}

	#resolvePreviousTurnIdentity(
		turns: Combatant.Implementation[] = this.turns,
	): TurnIdentity | null {
		if (turns.length < 1) return null;
		const normalizedCurrentTurn =
			typeof this.turn === 'number' && this.turn >= 0 && this.turn < turns.length ? this.turn : 0;
		const previousTurnIndex = (normalizedCurrentTurn - 1 + turns.length) % turns.length;
		return this.#resolveTurnIdentityAtIndex(turns, previousTurnIndex);
	}

	#findTurnIndexByIdentity(
		turns: Combatant.Implementation[],
		turnIdentity: TurnIdentity | null,
	): number {
		if (!turnIdentity?.combatantId) return -1;
		return this.#findTurnIndexByOccurrence(
			turns,
			turnIdentity.combatantId,
			turnIdentity.occurrence,
		);
	}

	#buildAtomicTurnStateUpdate(updateData: Record<string, unknown> = {}): Record<string, unknown> {
		const shouldAugmentTurnState =
			this.#pendingAtomicTurnIdentity !== null || 'turn' in updateData || 'round' in updateData;
		if (!shouldAugmentTurnState) return { ...updateData };

		const nextUpdateData = { ...updateData };
		const normalizedTurns = this.setupTurns();

		if (normalizedTurns.length < 1) {
			nextUpdateData.turn = 0;
			Object.assign(nextUpdateData, buildExpandedTurnIdentityUpdate(null));
			this.#storeExpandedTurnIdentity(null);
			return nextUpdateData;
		}

		const requestedTurnIdentity =
			this.#pendingAtomicTurnIdentity &&
			this.#findTurnIndexByIdentity(normalizedTurns, this.#pendingAtomicTurnIdentity) >= 0
				? this.#pendingAtomicTurnIdentity
				: null;
		const fallbackTurn = Number.isInteger(nextUpdateData.turn)
			? Number(nextUpdateData.turn)
			: Number.isInteger(this.turn)
				? Number(this.turn)
				: 0;
		const fallbackTurnIndex = Math.min(Math.max(fallbackTurn, 0), normalizedTurns.length - 1);
		const targetTurnIndex =
			requestedTurnIdentity == null
				? fallbackTurnIndex
				: this.#findTurnIndexByIdentity(normalizedTurns, requestedTurnIdentity);
		const persistedTurnIdentity =
			this.#resolveTurnIdentityAtIndex(normalizedTurns, targetTurnIndex) ?? requestedTurnIdentity;

		nextUpdateData.turn = targetTurnIndex;
		Object.assign(nextUpdateData, buildExpandedTurnIdentityUpdate(persistedTurnIdentity));
		this.#storeExpandedTurnIdentity(persistedTurnIdentity);
		return nextUpdateData;
	}

	async #runAtomicTurnStateOperation<T>(
		preferredTurnIdentity: TurnIdentity | null,
		operation: () => Promise<T>,
	): Promise<{ intercepted: boolean; result: T }> {
		const previousPendingTurnIdentity = this.#pendingAtomicTurnIdentity;
		const previousInterceptedState = this.#didInterceptAtomicTurnStateUpdate;
		this.#pendingAtomicTurnIdentity = preferredTurnIdentity;
		this.#didInterceptAtomicTurnStateUpdate = false;
		try {
			const result = await operation();
			return {
				intercepted: this.#didInterceptAtomicTurnStateUpdate,
				result,
			};
		} finally {
			this.#pendingAtomicTurnIdentity = previousPendingTurnIdentity;
			this.#didInterceptAtomicTurnStateUpdate = previousInterceptedState;
		}
	}

	async #persistAtomicTurnState(updateData: Record<string, unknown> = {}): Promise<void> {
		const nextUpdateData = this.#buildAtomicTurnStateUpdate(updateData);
		if (Object.keys(nextUpdateData).length < 1) return;
		await this.update(nextUpdateData);
	}

	async #syncTurnToCombatant(
		combatantIdOrIdentity: string | TurnIdentity | null | undefined,
		options: { persist?: boolean } = {},
	): Promise<void> {
		const turnIdentity =
			typeof combatantIdOrIdentity === 'string'
				? { combatantId: combatantIdOrIdentity, occurrence: null }
				: (combatantIdOrIdentity ?? null);
		if (!turnIdentity?.combatantId) return;

		const nextTurnIndex = this.#findTurnIndexByIdentity(this.turns, turnIdentity);
		if (nextTurnIndex < 0) return;
		const normalizedCurrentTurn = Number.isInteger(this.turn) ? Number(this.turn) : 0;
		if (nextTurnIndex === normalizedCurrentTurn) return;

		// Keep local state consistent immediately; persist for GM-driven operations.
		this.turn = nextTurnIndex;
		this.#storeExpandedTurnIdentity(
			this.#resolveTurnIdentityAtIndex(this.turns, nextTurnIndex) ?? turnIdentity,
		);
		if (options.persist === false) return;
		await this.#persistAtomicTurnState({ turn: nextTurnIndex });
	}

	#getCombatantOccurrenceAtIndex(
		turns: Combatant.Implementation[],
		combatantId: string,
		inclusiveIndex: number,
	): number {
		let occurrence = -1;
		for (let index = 0; index <= inclusiveIndex && index < turns.length; index += 1) {
			if ((turns[index]?.id ?? '') === combatantId) occurrence += 1;
		}
		return occurrence;
	}

	#findTurnIndexByOccurrence(
		turns: Combatant.Implementation[],
		combatantId: string,
		desiredOccurrence: number | null,
	): number {
		let occurrence = -1;
		for (const [index, turnCombatant] of turns.entries()) {
			if ((turnCombatant?.id ?? '') !== combatantId) continue;
			occurrence += 1;
			if (desiredOccurrence === null || occurrence === desiredOccurrence) return index;
		}
		return -1;
	}

	#syncTurnIndexWithAliveTurns(options: { preferredTurnIdentity?: TurnIdentity | null } = {}) {
		const currentTurnIdentity =
			options.preferredTurnIdentity ?? this.#resolveCurrentTurnIdentity(this.turns);
		const aliveTurns = this.setupTurns();
		this.turns = aliveTurns;

		if (aliveTurns.length === 0) {
			this.turn = 0;
			this.#storeExpandedTurnIdentity(null);
			return;
		}

		if (currentTurnIdentity?.combatantId) {
			const matchedIndex = this.#findTurnIndexByIdentity(aliveTurns, currentTurnIdentity);
			if (matchedIndex >= 0) {
				this.turn = matchedIndex;
				this.#storeExpandedTurnIdentity(
					this.#resolveTurnIdentityAtIndex(aliveTurns, matchedIndex) ?? currentTurnIdentity,
				);
				return;
			}
		}

		const currentTurn = Number.isInteger(this.turn) ? Number(this.turn) : 0;
		this.turn = Math.min(Math.max(currentTurn, 0), aliveTurns.length - 1);
		this.#storeExpandedTurnIdentity(this.#resolveTurnIdentityAtIndex(aliveTurns, this.turn));
	}

	#getNonCharacterTurnResetTargets(
		combatant: Combatant.Implementation | null,
	): Combatant.Implementation[] {
		if (!combatant || combatant.type === 'character') return [];

		const groupId = getMinionGroupId(combatant);
		if (!groupId) return [combatant];

		const summary = getMinionGroupSummaries(this.combatants.contents).get(groupId);
		if (!summary?.aliveMembers.length) return [combatant];
		return summary.aliveMembers;
	}

	async #restoreNonCharacterTurnState(combatant: Combatant.Implementation | null): Promise<void> {
		const updates = this.#getNonCharacterTurnResetTargets(combatant).reduce<
			Record<string, unknown>[]
		>((accumulator, targetCombatant) => {
			const combatantId = targetCombatant.id ?? null;
			if (!combatantId) return accumulator;

			const nextActions = getCombatantBaseActionMax(targetCombatant);
			if (getCombatantCurrentActions(targetCombatant) === nextActions) return accumulator;

			accumulator.push({
				_id: combatantId,
				'system.actions.base.current': nextActions,
			});
			return accumulator;
		}, []);
		if (updates.length < 1) return;
		await this.updateEmbeddedDocuments('Combatant', updates);
	}

	async #resetCharacterPipTypesForNewRound(): Promise<void> {
		if (!isBaneInspiredActionsEnabled()) return;

		const updates: Record<string, unknown>[] = [];

		for (const combatant of this.combatants.contents) {
			if (combatant.type !== 'character') continue;
			const combatantId = combatant.id;
			if (!combatantId) continue;

			const pipTypes = getCombatantPipTypes(combatant);
			const pipActiveStates = getCombatantPipActiveStates(combatant);
			const update: Record<string, unknown> = { _id: combatantId };
			let activeCount = 0;
			let hasChanges = false;

			for (let i = 0; i < 3; i++) {
				const isActive = pipActiveStates[i] ?? false;
				const pipType = pipTypes[i] ?? 'standard';

				if (isActive && pipType !== 'standard') {
					activeCount++;
				} else {
					if (pipType !== 'standard') {
						update[`system.actions.base.pipType${i}`] = 'standard';
						hasChanges = true;
					}
					if (!isActive) {
						update[`system.actions.base.pipActive${i}`] = true;
						hasChanges = true;
					}
					activeCount++;
				}
			}

			const currentActions = getCombatantCurrentActions(combatant);
			if (currentActions !== activeCount) {
				update['system.actions.base.current'] = activeCount;
				hasChanges = true;
			}

			if (hasChanges) {
				updates.push(update);
			}
		}

		if (updates.length > 0) {
			await this.updateEmbeddedDocuments('Combatant', updates);
		}
	}

	async #removeHesitantConditionAfterRoundOne(): Promise<void> {
		if (!isBaneInspiredActionsEnabled()) return;
		if ((this.round ?? 1) <= 1) return;

		const removals: Promise<unknown>[] = [];
		for (const combatant of this.combatants.contents) {
			if (combatant.type !== 'character') continue;
			const actor = combatant.actor;
			if (!actor) continue;

			if (actor.statuses?.has('hesitant')) {
				removals.push(actor.toggleStatusEffect('hesitant', { active: false }));
			}
		}

		if (removals.length > 0) {
			await Promise.all(removals);
		}
	}

	#normalizeCombatantCreateData(entry: Record<string, unknown>): {
		normalizedEntry: Record<string, unknown>;
		normalizedMinionType: boolean;
	} {
		const normalizedEntry = { ...entry };
		const normalizedMinionType = normalizedEntry.type === 'minion';
		if (normalizedMinionType) {
			normalizedEntry.type = 'npc';
		}

		const currentActions = foundry.utils.getProperty(
			normalizedEntry,
			'system.actions.base.current',
		);
		if (currentActions !== undefined && currentActions !== null) {
			return { normalizedEntry, normalizedMinionType };
		}

		const explicitMaxActions = Number(
			foundry.utils.getProperty(normalizedEntry, 'system.actions.base.max') ?? Number.NaN,
		);
		const defaultActions = normalizedEntry.type === 'character' ? 3 : 1;
		const initialActions = Number.isFinite(explicitMaxActions)
			? Math.max(0, Math.trunc(explicitMaxActions))
			: defaultActions;
		foundry.utils.setProperty(normalizedEntry, 'system.actions.base.current', initialActions);
		return { normalizedEntry, normalizedMinionType };
	}

	constructor(
		data?: Combat.CreateData,
		context?: foundry.abstract.Document.ConstructionContext<Combat.Parent>,
	) {
		super(data, context);

		this.#subscribe = createSubscriber((update) => {
			const updateCombat = Hooks.on('updateCombat', (combat) => {
				if (combat.id === this.id) update();
			});

			const combatantHooks = ['create', 'delete', 'update'].reduce(
				(hooks, hookType) => {
					const hookName = `${hookType}Combatant` as
						| 'createCombatant'
						| 'deleteCombatant'
						| 'updateCombatant';
					hooks[hookType] = Hooks.on(hookName, (combatant, _, options) => {
						if ((options as { diff?: boolean }).diff === false) return;
						if (combatant.parent?.id === this.id) update();
					});

					return hooks;
				},
				{} as Record<string, number>,
			);

			return () => {
				Hooks.off('updateCombat', updateCombat);
				Hooks.off('createCombatant', combatantHooks.create);
				Hooks.off('deleteCombatant', combatantHooks.delete);
				Hooks.off('updateCombatant', combatantHooks.update);
			};
		});
	}

	get reactive() {
		this.#subscribe();

		return this;
	}

	/**
	 * During zipper selection mode, suppress the active combatant so Foundry
	 * does not draw the d20 turn indicator on any token. Once a combatant is
	 * selected the getter falls through to the base implementation.
	 *
	 * The setter stores a fallback for environments (e.g. test mocks) where the
	 * base Combat class assigns `combatant` as a plain property in its constructor
	 * before private fields are initialized. Uses a symbol-keyed property to avoid
	 * conflicts.
	 */
	override get combatant(): Combatant.Implementation | undefined {
		if (isZipperInitiativeActive() && isZipperAwaitingSelection(this)) {
			return undefined;
		}
		return (
			super.combatant ??
			((this as Record<symbol, unknown>)[COMBATANT_FALLBACK_KEY] as
				| Combatant.Implementation
				| undefined) ??
			undefined
		);
	}

	override set combatant(value: Combatant.Implementation | null | undefined) {
		(this as Record<symbol, unknown>)[COMBATANT_FALLBACK_KEY] = value;
	}

	async #applyNpcActionResetUpdates(): Promise<void> {
		const updates = this.combatants.contents
			.filter((combatant) => combatant.type !== 'character')
			.map((combatant) => {
				return {
					_id: combatant.id,
					'system.actions.base.current': getCombatantBaseActionMax(combatant),
				};
			});
		if (updates.length < 1) return;
		await this.updateEmbeddedDocuments('Combatant', updates);
	}

	#buildHeroicReactionAvailabilityUpdate(available: boolean): Record<string, unknown> {
		const update: Record<string, unknown> = {};
		for (const reactionKey of HEROIC_REACTIONS) {
			for (const [path, value] of Object.entries(
				getHeroicReactionAvailabilityUpdate(reactionKey, available),
			)) {
				update[path] = value;
			}
		}
		return update;
	}

	#resolveStartCombatTurnIndex(): number {
		return 0;
	}

	override async startCombat(): Promise<this> {
		this.turns = this.setupTurns();
		const preferredStartTurnIdentity = this.#resolveTurnIdentityAtIndex(
			this.turns,
			this.#resolveStartCombatTurnIndex(),
		);
		const { intercepted, result } = await this.#runAtomicTurnStateOperation(
			preferredStartTurnIdentity,
			async () => (await super.startCombat()) as this,
		);

		const sceneId = this.scene?.id;
		const unrolledCharacterIds =
			sceneId == null
				? []
				: this.combatants
						.filter(
							(combatant) =>
								combatant.initiative === null &&
								combatant.type === 'character' &&
								combatant.sceneId === sceneId,
						)
						.map((combatant) => combatant.id)
						.filter((combatantId): combatantId is string => combatantId != null);

		if (unrolledCharacterIds.length > 0) {
			await this.rollInitiative(unrolledCharacterIds, { updateTurn: false });
		}

		// Merge NPC action resets, character heroic-reaction refreshes, and the
		// zipper acted-flag reset into a single Combatant batch. Each separate
		// `updateEmbeddedDocuments` await fires `updateCombatant` and forces a
		// tracker re-render; the three calls overlapped on the same Combatants
		// (a character has both heroic reactions and an acted flag to reset),
		// so a Map merge by _id is needed before dispatch.
		const combatantUpdates = new Map<string, Record<string, unknown>>();
		const mergeCombatantUpdate = (update: Record<string, unknown>) => {
			const id = update._id as string | undefined;
			if (!id) return;
			const existing = combatantUpdates.get(id);
			combatantUpdates.set(id, existing ? { ...existing, ...update, _id: id } : update);
		};

		for (const combatant of this.combatants.contents) {
			if (combatant.type === 'character' || !combatant.id) continue;
			mergeCombatantUpdate({
				_id: combatant.id,
				'system.actions.base.current': getCombatantBaseActionMax(combatant),
			});
		}

		for (const combatant of this.combatants.contents) {
			if (combatant.type !== 'character' || !combatant.id) continue;
			const needsRefresh = HEROIC_REACTIONS.some(
				(reactionKey) => !getHeroicReactionAvailability(combatant, reactionKey),
			);
			if (!needsRefresh) continue;
			mergeCombatantUpdate({
				_id: combatant.id,
				...this.#buildHeroicReactionAvailabilityUpdate(true),
			});
		}

		if (isZipperInitiativeActive()) {
			for (const update of buildResetAllActedUpdates(this)) {
				mergeCombatantUpdate(update);
			}
		}

		if (combatantUpdates.size > 0) {
			await this.updateEmbeddedDocuments('Combatant', [...combatantUpdates.values()]);
		}

		// Zipper initiative: enter open-selection mode. Neither side is pre-chosen
		// as first; the player or the GM picks whoever takes the first turn, and
		// that side becomes the locked round-start side for the rest of combat
		// (handles GM-narrated ambushes where monsters go first regardless of
		// initiative). `firstSidePending` is cleared on the first select.
		if (isZipperInitiativeActive()) {
			await this.update({
				...buildZipperCombatFlagUpdate({
					awaitingSelection: true,
					firstSidePending: true,
					actCounter: 0,
				}),
				...buildClearTurnHistoryUpdate(),
				...buildSoloOccurrencesSnapshotUpdate(this.#countAliveHeroes()),
			} as Parameters<Combat['update']>[0]);
			// Rebuild turns now that soloOccurrencesPerRound is persisted —
			// otherwise the initial expansion (line ~752 above) used the default
			// of 1, interleaving only one solo card per character.
			this.turns = this.setupTurns();
		}

		if (preferredStartTurnIdentity) {
			this.#syncTurnIndexWithAliveTurns({ preferredTurnIdentity: preferredStartTurnIdentity });
		} else {
			this.#syncTurnIndexWithAliveTurns();
		}
		if (!intercepted && this.turns.length > 0) {
			await this.#persistAtomicTurnState({ turn: this.turn });
		}

		await this.#maybeAutoSelectSoleEligible();

		return result;
	}

	override async createEmbeddedDocuments<EmbeddedName extends Combat.Embedded.Name>(
		embeddedName: EmbeddedName,
		data: foundry.abstract.Document.CreateDataForName<EmbeddedName>[] | undefined,
		operation?: object,
	): Promise<foundry.abstract.Document.StoredForName<EmbeddedName>[] | undefined> {
		let normalizedData = data;

		if (embeddedName === 'Combatant' && Array.isArray(data)) {
			let normalizedCount = 0;
			normalizedData = data.map((entry) => {
				if (!entry || typeof entry !== 'object') return entry;
				const { normalizedEntry, normalizedMinionType } = this.#normalizeCombatantCreateData(
					entry as Record<string, unknown>,
				);
				if (normalizedMinionType) {
					normalizedCount += 1;
				}
				return normalizedEntry;
			}) as foundry.abstract.Document.CreateDataForName<EmbeddedName>[];

			if (normalizedCount > 0) {
				logMinionGroupingCombat('normalized invalid combatant create type from minion to npc', {
					combatId: this.id ?? null,
					normalizedCount,
				});
			}
		}

		return super.createEmbeddedDocuments(embeddedName, normalizedData, operation);
	}

	override async _onEndTurn(combatant: Combatant.Implementation, context: Combat.TurnEventContext) {
		// @ts-expect-error Custom hook
		Hooks.call('nimbleCombatTurnEnd', combatant);

		await super._onEndTurn(combatant, context);

		// In zipper mode, `#zipperNextTurn` already refills the outgoing combatant
		// explicitly. _onEndTurn fires whenever Foundry observes a turn-index change
		// in combat.update() — which happens on every selectZipperCombatant since
		// it writes `turn: targetIndex`. Foundry fires _onEndTurn for whatever
		// combatant was at the OLD turn index, which in zipper mode is unrelated to
		// "who actually just ended their turn." Running the refill here would
		// silently top off random characters who shouldn't be refilled (the bug:
		// "ending another player's turn gives back actions to people who already
		// spent them"). Skip the refill — #zipperNextTurn owns it.
		if (isZipperInitiativeActive()) return;

		if (combatant.type === 'character') {
			await combatant.update({
				'system.actions.base.current': getCombatantBaseActionMax(combatant),
				'system.actions.base.additional': 0,
				...this.#buildHeroicReactionAvailabilityUpdate(true),
			} as Record<string, unknown>);
		}
	}

	override async _onEndRound() {
		// Reset only non-character combatants' actions at end of round.
		await this.#applyNpcActionResetUpdates();

		await dissolveRoundBoundaryMinionGroups({
			combat: this,
			resolveCurrentTurnIdentity: () => this.#resolveCurrentTurnIdentity(),
			syncTurnToCombatant: (combatantIdOrIdentity, options) =>
				this.#syncTurnToCombatant(combatantIdOrIdentity, options),
		});
	}

	async updateCombatant(
		combatantID: string,
		updates: Record<string, any>,
	): Promise<NimbleCombatant | undefined> {
		const combatant = this.combatants.get(combatantID) as NimbleCombatant | null;

		if (!combatant) {
			console.error(
				`Attempted to update combatant with id ${combatantID}, but the combatant could not be found.`,
			);
			return undefined;
		}

		return combatant.update(updates);
	}

	async useHeroicReactions(
		combatantId: string,
		reactionKeys: HeroicReactionKey[],
		options?: {
			force?: boolean;
			preferredActionType?: import('../../combat/actionType.js').ActionType;
		},
	): Promise<boolean> {
		if (!combatantId || reactionKeys.length < 1) return false;

		const changed =
			(await queueCombatantMutationWithFreshDocument({
				combat: this,
				combatantId,
				mutation: async (combatant) => {
					if (combatant.parent?.id !== this.id) return false;
					if (combatant.type !== 'character') return false;

					const usageState = getHeroicReactionUsageState({
						combat: this,
						combatant,
						reactionKeys,
					});

					const canForceUsage =
						options?.force === true && isSoftBlockedReason(usageState.blockedReason);

					if (!usageState.canUse && !canForceUsage) {
						return false;
					}

					const reactionAvailabilityUpdate = {
						_id: combatantId,
					} as Record<string, unknown>;

					// Pip-aware action deduction for combat readiness
					if (isBaneInspiredActionsEnabled()) {
						const pipTypes = getCombatantPipTypes(combatant);
						const pipActiveStates = getCombatantPipActiveStates(combatant);
						const actionsToConsume = usageState.requiredActions;

						for (let c = 0; c < actionsToConsume; c++) {
							const pipIndex = findPipIndexToConsume(
								pipTypes,
								pipActiveStates,
								options?.preferredActionType,
							);
							if (pipIndex >= 0) {
								pipActiveStates[pipIndex] = false;
								reactionAvailabilityUpdate[`system.actions.base.pipActive${pipIndex}`] = false;
							}
						}

						const basePipActiveCount = pipActiveStates.filter(Boolean).length;
						const bonusActions = Math.max(
							0,
							usageState.currentActions -
								getCombatantPipActiveStates(combatant).filter(Boolean).length,
						);
						reactionAvailabilityUpdate['system.actions.base.current'] =
							basePipActiveCount + bonusActions;
					} else {
						reactionAvailabilityUpdate['system.actions.base.current'] = Math.max(
							0,
							usageState.currentActions - usageState.requiredActions,
						);
					}

					for (const reactionKey of usageState.reactionKeys) {
						Object.assign(
							reactionAvailabilityUpdate,
							getHeroicReactionAvailabilityUpdate(reactionKey, false),
						);
					}

					await this.updateEmbeddedDocuments('Combatant', [reactionAvailabilityUpdate]);
					return true;
				},
			})) ?? false;

		return changed;
	}

	async toggleHeroicReactionAvailability(
		combatantId: string,
		reactionKey: HeroicReactionKey,
	): Promise<boolean> {
		if (!combatantId) return false;

		const changed =
			(await queueCombatantMutationWithFreshDocument({
				combat: this,
				combatantId,
				mutation: async (combatant) => {
					if (combatant.parent?.id !== this.id) return false;
					if (combatant.type !== 'character') return false;
					if (isCombatantDead(combatant)) return false;

					const currentlyAvailable = getHeroicReactionAvailability(combatant, reactionKey);
					const canAdministerSpentReaction = Boolean(game.user?.isGM);
					const canSpendAvailableReaction = Boolean(
						game.user?.isGM || (canOwnerUseHeroicReaction(reactionKey) && combatant.actor?.isOwner),
					);
					if (!currentlyAvailable) {
						if (!canAdministerSpentReaction) return false;
						await this.updateEmbeddedDocuments('Combatant', [
							{
								_id: combatantId,
								...getHeroicReactionAvailabilityUpdate(reactionKey, true),
							},
						]);
						return true;
					}

					if (!canSpendAvailableReaction) return false;
					const currentActions = getCombatantCurrentActions(combatant);
					if (!game.user?.isGM) {
						if ((this.round ?? 0) < 1) return false;
						if ((this.combatant?.id ?? null) === combatantId) return false;
						if (currentActions < 1) return false;
					}

					const reactionAvailabilityUpdate = {
						_id: combatantId,
						...getHeroicReactionAvailabilityUpdate(reactionKey, false),
					} as Record<string, unknown>;
					if (!game.user?.isGM) {
						reactionAvailabilityUpdate['system.actions.base.current'] = Math.max(
							0,
							currentActions - 1,
						);
					}

					await this.updateEmbeddedDocuments('Combatant', [reactionAvailabilityUpdate]);
					return true;
				},
			})) ?? false;

		return changed;
	}

	async performMinionGroupAttack(
		params: MinionGroupAttackParams,
	): Promise<MinionGroupAttackResult> {
		return performMinionGroupAttack({
			combat: this,
			attackParams: params,
			assignNcsTemporaryGroupFromAttackMembers: (memberCombatantIds) =>
				assignNcsTemporaryGroupFromAttackMembers({
					combat: this,
					turns: this.turns,
					memberCombatantIds,
					resolveCurrentTurnIdentity: () => this.#resolveCurrentTurnIdentity(),
					syncTurnToCombatant: (combatantIdOrIdentity, options) =>
						this.#syncTurnToCombatant(combatantIdOrIdentity, options),
				}),
		});
	}

	async #acquireInitiativeRollLock(
		combatantId: string,
		lockData: ReturnType<typeof initiativeRollLock.create>,
	): Promise<boolean> {
		const combatant = this.combatants.get(combatantId);
		if (!combatant || combatant.initiative !== null) return false;

		const currentLock = initiativeRollLock.get(combatant);
		if (currentLock && !initiativeRollLock.isStale(currentLock)) return false;

		await this.updateEmbeddedDocuments('Combatant', [
			{
				_id: combatantId,
				[initiativeRollLock.path]: lockData,
			},
		]);

		const refreshedCombatant = this.combatants.get(combatantId);
		if (!refreshedCombatant || refreshedCombatant.initiative !== null) {
			await this.#releaseInitiativeRollLock(combatantId, lockData.requestId);
			return false;
		}

		return initiativeRollLock.matches(refreshedCombatant, lockData.requestId);
	}

	async #releaseInitiativeRollLock(combatantId: string, requestId: string): Promise<void> {
		const combatant = this.combatants.get(combatantId);
		if (!combatant || !initiativeRollLock.matches(combatant, requestId)) return;

		await this.updateEmbeddedDocuments('Combatant', [
			{
				_id: combatantId,
				[initiativeRollLock.path]: null,
			},
		]);
	}

	async #resolvePromptedInitiativeRollData(
		combatantId: string,
	): Promise<ResolvedInitiativeRollData | null | undefined> {
		const actor = this.combatants.get(combatantId)
			?.actor as ActorWithInitiativeRollConfiguration | null;
		if (typeof actor?.resolveInitiativeRollData !== 'function') return undefined;
		return actor.resolveInitiativeRollData();
	}

	async #performInitiativeRollForCombatant(params: {
		combatantId: string;
		formula: string | null;
		messageOptions: ChatMessage.CreateData;
		chatRollMode: string | null;
		rollIndex: number;
		combatManaUpdates: Promise<unknown>[];
		promptRollDialog: boolean;
	}): Promise<LockedInitiativeRollOutcome | null> {
		const combatant = this.combatants.get(params.combatantId);
		if (!combatant?.isOwner) return null;
		if (combatant.initiative !== null) return null;
		if (initiativeRollLock.hasActiveLock(combatant)) return null;

		const lockData = initiativeRollLock.create();
		const acquiredLock = await this.#acquireInitiativeRollLock(params.combatantId, lockData);
		if (!acquiredLock) return null;

		let shouldReleaseLock = true;
		try {
			const lockedCombatant = this.combatants.get(params.combatantId);
			if (!lockedCombatant?.isOwner) return null;
			if (lockedCombatant.initiative !== null) return null;
			if (!initiativeRollLock.matches(lockedCombatant, lockData.requestId)) return null;

			const promptedRollData = params.promptRollDialog
				? await this.#resolvePromptedInitiativeRollData(params.combatantId)
				: undefined;
			if (params.promptRollDialog && promptedRollData === null) return null;

			const resolvedMessageOptions = {
				...params.messageOptions,
			} as ChatMessage.CreateData & { rollMode?: string };
			if (promptedRollData?.visibilityMode) {
				resolvedMessageOptions.rollMode = promptedRollData.visibilityMode;
			}

			const rollOutcome = await rollInitiativeForCombatant({
				combat: this,
				combatantId: params.combatantId,
				formula: promptedRollData?.rollFormula ?? params.formula,
				messageOptions: resolvedMessageOptions,
				chatRollMode: params.chatRollMode,
				rollIndex: params.rollIndex,
				combatManaUpdates: params.combatManaUpdates,
			});
			if (!rollOutcome) return null;

			rollOutcome.combatantUpdate[initiativeRollLock.path] = null;
			shouldReleaseLock = false;

			return {
				combatantId: params.combatantId,
				requestId: lockData.requestId,
				outcome: rollOutcome,
			};
		} finally {
			if (shouldReleaseLock) {
				await this.#releaseInitiativeRollLock(params.combatantId, lockData.requestId);
			}
		}
	}

	async #rollInitiativeForCombatant(params: {
		combatantId: string;
		formula: string | null;
		messageOptions: ChatMessage.CreateData;
		chatRollMode: string | null;
		rollIndex: number;
		combatManaUpdates: Promise<unknown>[];
		promptRollDialog: boolean;
	}): Promise<LockedInitiativeRollOutcome | null> {
		const inFlightRequest = this.#initiativeRollRequests.get(params.combatantId);
		if (inFlightRequest) {
			await inFlightRequest;
			return null;
		}

		const request = this.#performInitiativeRollForCombatant(params);
		this.#initiativeRollRequests.set(params.combatantId, request);

		try {
			return await request;
		} finally {
			if (this.#initiativeRollRequests.get(params.combatantId) === request) {
				this.#initiativeRollRequests.delete(params.combatantId);
			}
		}
	}

	override async rollInitiative(
		ids: string | string[],
		options?: Combat.InitiativeOptions & {
			promptRollDialog?: boolean;
			rollOptions?: Record<string, unknown>;
		},
	): Promise<this> {
		const {
			formula = null,
			messageOptions = {},
			promptRollDialog = false,
			updateTurn = true,
		} = options ?? {};

		// Structure Input data
		const combatantIds = [...new Set((typeof ids === 'string' ? [ids] : ids).filter(Boolean))];
		const currentId = this.combatant?.id;
		const chatRollMode = game.settings.get('core', 'rollMode');
		const shouldPromptRollDialog = promptRollDialog && combatantIds.length === 1;

		// Iterate over Combatants, performing an initiative roll for each
		const updates: Record<string, unknown>[] = [];
		const combatManaUpdates: Promise<unknown>[] = [];
		const messages: ChatMessage.CreateData[] = [];
		const lockedRollOutcomes: LockedInitiativeRollOutcome[] = [];

		for (const id of combatantIds) {
			const rollOutcome = await this.#rollInitiativeForCombatant({
				combatantId: id,
				formula,
				messageOptions,
				chatRollMode,
				rollIndex: messages.length,
				combatManaUpdates,
				promptRollDialog: shouldPromptRollDialog,
			});
			if (!rollOutcome) continue;
			lockedRollOutcomes.push(rollOutcome);
			updates.push(rollOutcome.outcome.combatantUpdate);
			messages.push(rollOutcome.outcome.chatData);
		}

		try {
			if (updates.length > 0) {
				await this.updateEmbeddedDocuments('Combatant', updates);
			}
		} catch (error) {
			await Promise.allSettled(
				lockedRollOutcomes.map((rollOutcome) =>
					this.#releaseInitiativeRollLock(rollOutcome.combatantId, rollOutcome.requestId),
				),
			);
			throw error;
		}

		for (const rollOutcome of lockedRollOutcomes) {
			const combatant = this.combatants.get(rollOutcome.combatantId);
			const actor = combatant?.actor;
			if (!actor) continue;
			// @ts-expect-error - nimble.initiativeRolled is a custom Nimble hook consumed by ruleEventDispatch and chargePool/dicePool triggers
			Hooks.callAll('nimble.initiativeRolled', { actor, combatant });
		}

		if (combatManaUpdates.length > 0) {
			await Promise.all(combatManaUpdates);
		}

		// Ensure the turn order remains with the same combatant
		if (updateTurn && currentId && updates.length > 0) {
			await this.update({ turn: this.turns.findIndex((t) => t.id === currentId) });
		}

		// Create multiple chat messages
		if (messages.length > 0) {
			await ChatMessage.implementation.create(messages);
		}
		return this;
	}

	override setupTurns(): Combatant.Implementation[] {
		// super.setupTurns() does `this.round++` when this.turn exceeds combatants.size, which fires
		// spuriously once expandLegendaryTurns produces a turn list longer than the combatant count.
		const savedRound = this.round;
		const savedTurn = this.turn;
		const aliveTurns = super.setupTurns().filter((combatant) => !isCombatantDead(combatant));
		if (this.round !== savedRound) this.round = savedRound;
		if (this.turn !== savedTurn) this.turn = savedTurn;
		const minionNormalizedTurns = normalizeMinionTurns(aliveTurns);
		// Use the round-start snapshot for the solo's occurrence count so it
		// stays locked even if heroes die mid-round. Falls back to live count if
		// zipper isn't active (non-zipper combats use the legacy behavior).
		const soloCount = isZipperInitiativeActive() ? getSoloOccurrencesPerRound(this) : undefined;
		const expandedTurns = expandLegendaryTurns(minionNormalizedTurns, soloCount);

		if (!isZipperInitiativeActive()) return expandedTurns;

		// In zipper mode: acted combatants sorted by their per-occurrence actOrder
		// first, then un-acted in existing order. For solos with multiple cards in
		// expandedTurns, the SAME combatant reference appears N times — we have to
		// distinguish each card by its occurrence index (left-to-right position
		// among same-combatant cards) so per-card acted state is honored.
		const history = getTurnHistory(this);
		const actOrderByKey = new Map<string, number>();
		for (const entry of history) {
			if (entry.undone) continue;
			// Key includes occurrenceIndex (0 for single-occurrence) so multi-turn
			// solos get distinct actOrder lookups per card.
			const occurrence = entry.occurrenceIndex ?? 0;
			actOrderByKey.set(`${entry.combatantId}::${occurrence}`, entry.actOrder);
		}
		type ActedCard = { combatant: Combatant.Implementation; actOrder: number };
		const finished: ActedCard[] = [];
		const inProgress: Combatant.Implementation[] = [];
		const unacted: Combatant.Implementation[] = [];
		const occurrenceCounterById = new Map<string, number>();
		for (const combatant of expandedTurns) {
			const id = combatant.id ?? '';
			const occurrenceIndex = occurrenceCounterById.get(id) ?? 0;
			occurrenceCounterById.set(id, occurrenceIndex + 1);
			// Dead combatants always belong in the finished section regardless of
			// how many of their occurrences were consumed — a dead boss should
			// never linger as "eligible" cards 2..N in the upcoming section.
			if (isCombatantDead(combatant)) {
				const actOrder = actOrderByKey.get(`${id}::${occurrenceIndex}`) ?? 0;
				finished.push({ combatant, actOrder });
				continue;
			}
			// Three-zone layout: [finished | in-progress | pending]. The in-progress
			// zone is the active turn-taker — selected but not yet ended. Keeping
			// them visually distinct from finished prevents the "I just got selected
			// and my card is already dimmed in the acted section" UX issue.
			if (isOccurrenceInProgress(this, combatant, occurrenceIndex)) {
				inProgress.push(combatant);
				continue;
			}
			if (hasOccurrenceActed(this, combatant, occurrenceIndex)) {
				const actOrder = actOrderByKey.get(`${id}::${occurrenceIndex}`) ?? 0;
				finished.push({ combatant, actOrder });
				continue;
			}
			unacted.push(combatant);
		}
		finished.sort((a, b) => a.actOrder - b.actOrder);
		return [...finished.map((c) => c.combatant), ...inProgress, ...unacted];
	}

	override async nextTurn(): Promise<this> {
		// Zipper initiative: mark current combatant as acted, flip side, enter selection
		if (isZipperInitiativeActive()) {
			return this.#zipperNextTurn();
		}

		this.#syncTurnIndexWithAliveTurns();
		const preferredNextTurnIdentity = this.#resolveNextTurnIdentity();
		const { intercepted, result } = await this.#runAtomicTurnStateOperation(
			preferredNextTurnIdentity,
			async () => (await super.nextTurn()) as this,
		);
		this.#syncTurnIndexWithAliveTurns({ preferredTurnIdentity: preferredNextTurnIdentity });
		if (!intercepted) {
			await this.#persistAtomicTurnState({ turn: this.turn });
		}

		return result;
	}

	async #zipperNextTurn(): Promise<this> {
		const activeCombatant = this.combatant ?? null;
		const activeCombatantId = activeCombatant?.id ?? null;

		// Refill actions for the outgoing combatant (mirrors _onEndTurn behavior)
		if (activeCombatant && activeCombatant.type === 'character') {
			await activeCombatant.update({
				'system.actions.base.current': getCombatantBaseActionMax(activeCombatant),
				'system.actions.base.additional': 0,
				...this.#buildHeroicReactionAvailabilityUpdate(true),
			} as Record<string, unknown>);
		}

		// Mark the current combatant (and its minion group) as acted. Guard is
		// `hasInProgressTurn` (derived from history) rather than `!hasZipperActed`:
		// the per-combatant flag stays true after a solo's first turn, which would
		// silently skip counter bumps for its 2nd..Nth turns and corrupt history
		// actOrder / previousTurn / current-marker.
		const inProgress =
			activeCombatantId !== null && activeCombatant !== null && hasInProgressTurn(this);
		if (inProgress && activeCombatantId) {
			const actedUpdates = buildMarkActedUpdates(this, activeCombatantId);
			if (actedUpdates.length > 0) {
				await this.updateEmbeddedDocuments('Combatant', actedUpdates);
			}
		}

		// Check if all combatants have acted — if so, advance to next round
		if (hasAllCombatantsActed(this)) {
			return this.nextRound();
		}

		// Flip side, bump the act counter, persist the turn index — all in one
		// combat update. Each separate this.update() call fires updateCombat,
		// which forces the tracker to re-render and rebuilds token overlays.
		// Batching three writes into one cuts two of the three re-renders per
		// turn end, which is the main source of hitching mid-combat.
		const currentSide = getZipperCurrentSide(this);
		const nextSide = resolveNextSide(this, currentSide);

		// Rebuild turns so acted cards move left
		this.turns = this.setupTurns();
		this.#syncTurnIndexWithAliveTurns();

		const flagUpdate = buildZipperCombatFlagUpdate(
			inProgress
				? {
						actCounter: getZipperActCounter(this) + 1,
						currentSide: nextSide,
						awaitingSelection: true,
					}
				: {
						currentSide: nextSide,
						awaitingSelection: true,
					},
		);
		await this.#persistAtomicTurnState({ turn: this.turn, ...flagUpdate });

		await this.#maybeAutoSelectSoleEligible();

		return this as this;
	}

	override async nextRound(): Promise<this> {
		this.#syncTurnIndexWithAliveTurns();
		const preferredFirstTurnIdentity = this.#resolveTurnIdentityAtIndex(this.turns, 0);
		const { intercepted, result } = await this.#runAtomicTurnStateOperation(
			preferredFirstTurnIdentity,
			async () => (await super.nextRound()) as this,
		);
		this.#syncTurnIndexWithAliveTurns({ preferredTurnIdentity: preferredFirstTurnIdentity });
		if (!intercepted) {
			await this.#persistAtomicTurnState({ turn: this.turn });
		}

		// Combat Readiness: reset pip types to standard and clear hesitant condition
		await this.#resetCharacterPipTypesForNewRound();
		await this.#removeHesitantConditionAfterRoundOne();

		// Zipper initiative: reset all acted flags and re-enter selection mode
		if (isZipperInitiativeActive()) {
			const resetUpdates = buildResetAllActedUpdates(this);
			if (resetUpdates.length > 0) {
				await this.updateEmbeddedDocuments('Combatant', resetUpdates);
			}
			const { roundStartSide } = this.#readZipperFlags();
			await this.update({
				...buildZipperCombatFlagUpdate({
					currentSide: roundStartSide,
					awaitingSelection: true,
					actCounter: 0,
				}),
				...buildClearTurnHistoryUpdate(),
				...buildSoloOccurrencesSnapshotUpdate(this.#countAliveHeroes()),
			} as Parameters<Combat['update']>[0]);
			this.turns = this.setupTurns();
			this.#syncTurnIndexWithAliveTurns();
		}

		await this.#maybeAutoSelectSoleEligible();

		return result;
	}

	/**
	 * Count alive (non-dead, in-combat) character combatants. Used to snapshot
	 * how many turns each solo monster gets this round. The count is locked at
	 * round start; hero death mid-round does NOT reduce the boss's remaining
	 * turns (per design — they "earned" those turns by facing N heroes).
	 */
	#countAliveHeroes(): number {
		let count = 0;
		for (const combatant of this.combatants.contents) {
			if (combatant.type !== 'character') continue;
			if (isCombatantDead(combatant)) continue;
			count++;
		}
		return count;
	}

	#readZipperFlags(): {
		currentSide: import('./zipperTurnState.js').ZipperSide;
		roundStartSide: import('./zipperTurnState.js').ZipperSide;
	} {
		return {
			currentSide: getZipperCurrentSide(this),
			roundStartSide:
				foundry.utils.getProperty(this, `flags.${SYSTEM_ID}.zipper.roundStartSide`) === 'gm'
					? 'gm'
					: 'player',
		};
	}

	override async previousTurn(): Promise<this> {
		// Zipper initiative: unwind the active combatant's turn instead of the
		// standard previousTurn flow. After unwinding, the combatant is no
		// longer "acted" and the combat re-enters selection mode on their side.
		if (isZipperInitiativeActive()) {
			return this.#zipperPreviousTurn();
		}

		this.#syncTurnIndexWithAliveTurns();
		const preferredPreviousTurnIdentity = this.#resolvePreviousTurnIdentity();
		const { intercepted, result } = await this.#runAtomicTurnStateOperation(
			preferredPreviousTurnIdentity,
			async () => (await super.previousTurn()) as this,
		);
		this.#syncTurnIndexWithAliveTurns({
			preferredTurnIdentity: preferredPreviousTurnIdentity,
		});
		if (!intercepted) {
			await this.#persistAtomicTurnState({ turn: this.turn });
		}
		await this.#restoreNonCharacterTurnState(this.combatant ?? null);
		return result;
	}

	async #zipperPreviousTurn(): Promise<this> {
		// The turn history is the source of truth for "what was the last turn
		// taken?". Using this.combatant alone is unreliable because the active
		// combatant changes across selectZipperCombatant → _onEndTurn boundaries,
		// and GM shift-click group turns put the leader in this.combatant but
		// the followers need unwinding too.
		const history = getTurnHistory(this);
		let lastEntry: TurnHistoryEntry | null = null;
		for (let i = history.length - 1; i >= 0; i--) {
			if (!history[i].undone) {
				lastEntry = history[i];
				break;
			}
		}
		if (!lastEntry) return this as this;

		const entryCombatant = this.combatants.get(lastEntry.combatantId);
		if (!entryCombatant) return this as this;

		// Distinguish "selected but turn not yet ended" from "turn fully ended" by
		// comparing the live actCounter to the history entry's actOrder.
		// selectZipperCombatant records actOrder = counter+1 BUT doesn't bump the
		// counter — #zipperNextTurn does that on turn end. So:
		//   - actCounter < entry.actOrder → turn is in progress (counter not bumped)
		//   - actCounter ≥ entry.actOrder → turn ended (counter caught up)
		// This is correct for solos too (per-combatant `acted` flag is unreliable
		// when a combatant takes multiple turns per round) and for GM-shift-click
		// groups (the leader's actOrder accounts for the followers' bumps).
		const turnEnded = getZipperActCounter(this) >= lastEntry.actOrder;

		const { combatFlags, combatantUpdates } = buildPreviousTurnUnwindUpdate(this, lastEntry, {
			turnEnded,
		});
		if (combatantUpdates.length > 0) {
			await this.updateEmbeddedDocuments('Combatant', combatantUpdates);
		}
		await this.update(combatFlags as Parameters<Combat['update']>[0]);

		// Rebuild turns so the previously-acted combatant moves back to the
		// upcoming section.
		this.turns = this.setupTurns();
		this.#syncTurnIndexWithAliveTurns();

		return this as this;
	}

	override async previousRound(): Promise<this> {
		this.#syncTurnIndexWithAliveTurns();
		const preferredLastTurnIdentity = this.#resolveTurnIdentityAtIndex(
			this.turns,
			Math.max(this.turns.length - 1, 0),
		);
		const { intercepted, result } = await this.#runAtomicTurnStateOperation(
			preferredLastTurnIdentity,
			async () => (await super.previousRound()) as this,
		);
		this.#syncTurnIndexWithAliveTurns({ preferredTurnIdentity: preferredLastTurnIdentity });
		if (!intercepted) {
			await this.#persistAtomicTurnState({ turn: this.turn });
		}
		await this.#restoreNonCharacterTurnState(this.combatant ?? null);
		return result;
	}

	override update(...args: Parameters<Combat['update']>): Promise<this | undefined> {
		const [updateData, operation] = args;
		if (updateData == null || typeof updateData !== 'object' || Array.isArray(updateData)) {
			return super.update(...args) as Promise<this | undefined>;
		}

		const shouldAugmentTurnState =
			this.#pendingAtomicTurnIdentity !== null || 'turn' in updateData || 'round' in updateData;
		if (!shouldAugmentTurnState) {
			return super.update(...args) as Promise<this | undefined>;
		}

		this.#didInterceptAtomicTurnStateUpdate = true;
		const nextUpdateData = this.#buildAtomicTurnStateUpdate(
			updateData as Record<string, unknown>,
		) as Parameters<Combat['update']>[0];
		return super.update(nextUpdateData, operation) as Promise<this | undefined>;
	}

	override _sortCombatants(a: Combatant.Implementation, b: Combatant.Implementation): number {
		return sortCombatants(a, b);
	}

	/**
	 * Select a combatant to take their turn in zipper initiative mode.
	 * Called when a player clicks their token overlay or the GM selects an enemy.
	 *
	 * @param options.groupCombatantIds — pass when selecting a GM-shift-click group
	 *   so the turn history records one grouped entry (including the leader and
	 *   followers) instead of a single-combatant entry.
	 */
	async selectZipperCombatant(
		combatantId: string,
		options?: { groupCombatantIds?: string[] },
	): Promise<void> {
		if (!isZipperInitiativeActive()) return;

		const currentSide = getZipperCurrentSide(this);
		const validation = canSelectCombatantForZipperTurn(this, combatantId, currentSide);
		if (!validation.valid) return;

		const combatant = this.combatants.get(combatantId);
		if (!combatant) return;

		// First selection of combat locks roundStartSide. After Begin Combat both
		// sides are eligible (open selection); whichever side acts first becomes
		// the round-start side for the rest of combat.
		const firstSidePending = isZipperFirstSidePending(this);
		const selectedSide = firstSidePending ? getCombatantZipperSide(combatant) : currentSide;

		// Rebuild turns and find the target combatant's index.
		this.turns = this.setupTurns();
		const turnIdentity: TurnIdentity = { combatantId, occurrence: null };
		const targetIndex = this.#findTurnIndexByIdentity(this.turns, turnIdentity);
		if (targetIndex < 0) return;

		// Update local state immediately.
		this.turn = targetIndex;
		this.#storeExpandedTurnIdentity(
			this.#resolveTurnIdentityAtIndex(this.turns, targetIndex) ?? turnIdentity,
		);

		// Build the turn history entry. actOrder mirrors the value buildMarkActedUpdates
		// will assign at turn end — both are "next sequential position" relative to the
		// current actCounter.
		const groupIds = options?.groupCombatantIds;
		const isGroup = Array.isArray(groupIds) && groupIds.length > 1;
		// For solo monsters (multi-turn-per-round), record which occurrence this is
		// (0-based). Equals current acted-occurrence-count because the next unacted
		// slot is at index = count.
		const totalOccurrences = getTotalOccurrencesForCombatant(this, combatant);
		const occurrenceIndex =
			totalOccurrences > 1 ? Math.max(0, getNextUnactedOccurrence(this, combatant)) : undefined;
		const historyEntry = {
			combatantId,
			side: selectedSide,
			actOrder: getZipperActCounter(this) + 1,
			...(isGroup ? { isGroup: true, groupCombatantIds: groupIds } : {}),
			...(occurrenceIndex !== undefined ? { occurrenceIndex } : {}),
		};

		// Persist the turn index, awaitingSelection flag, turn identity, and history
		// entry in a single update. Bypass #runAtomicTurnStateOperation and the update
		// override by calling super.update directly — the values are already fully
		// resolved and the override's re-resolution can fight with our intent.
		await super.update({
			turn: targetIndex,
			...buildZipperCombatFlagUpdate(
				firstSidePending
					? {
							awaitingSelection: false,
							firstSidePending: false,
							currentSide: selectedSide,
							roundStartSide: selectedSide,
						}
					: { awaitingSelection: false },
			),
			...buildExpandedTurnIdentityUpdate(
				this.#resolveTurnIdentityAtIndex(this.turns, targetIndex) ?? turnIdentity,
			),
			...buildAppendTurnHistoryUpdate(this, historyEntry),
		} as Parameters<Combat['update']>[0]);

		// Solo monster action economy: per Nimble, a solo "acts after each hero"
		// with 1 action per turn (so total actions/round = N occurrences = hero
		// count). Without this, the boss spends from a shared pool refilled only
		// at end of round, effectively giving them ~1 useful turn per round.
		// Force current = 1 at the start of each solo's turn.
		if (combatant.type === 'soloMonster') {
			await combatant.update({
				'system.actions.base.current': 1,
			} as Record<string, unknown>);
		}
	}

	/**
	 * When entering selection mode, if the current side has exactly one eligible
	 * combatant (un-acted, alive, a minion group counted as one), select it
	 * automatically so there's no pointless click. Runs on the GM client only so
	 * the authoritative selection happens once; the result propagates to players.
	 *
	 * Returns true if a combatant was auto-selected.
	 */
	async #maybeAutoSelectSoleEligible(): Promise<boolean> {
		if (!isZipperInitiativeActive()) return false;
		if (!game.user?.isGM) return false;
		if (!isZipperAwaitingSelection(this)) return false;
		// During open first-side selection both sides are eligible — let the
		// human pick rather than auto-resolving (the whole point of the flow is
		// the GM/players choosing who acts first).
		if (isZipperFirstSidePending(this)) return false;

		const currentSide = getZipperCurrentSide(this);
		const eligible = getUnactedCombatantsForSide(this, currentSide);
		if (eligible.length !== 1) return false;

		const soleId = eligible[0]?.id;
		if (!soleId) return false;
		if (!canSelectCombatantForZipperTurn(this, soleId, currentSide).valid) return false;

		await this.selectZipperCombatant(soleId);
		return true;
	}

	/**
	 * Select multiple combatants to act together as one GM group turn in zipper
	 * initiative. The first combatant becomes the active turn; the remaining
	 * combatants are immediately marked as acted so they are consumed together.
	 *
	 * When the GM ends the leader's turn via `#zipperNextTurn`, the leader is
	 * also marked acted normally — so all group members end up in the acted
	 * section of the tracker.
	 */
	async selectZipperGroup(combatantIds: string[]): Promise<void> {
		if (!isZipperInitiativeActive()) return;
		if (!game.user?.isGM) return;

		// Deduplicate, validate, and exclude solo monsters. Solos take N turns
		// per round on their own; bundling them into a GM-shift-click group would
		// confuse the per-occurrence accounting (only the leader gets a history
		// entry but the per-combatant acted flag write would propagate to all of
		// the solo's cards). If the user included a solo, drop it and notify.
		const allInputs = [...new Set(combatantIds)].filter((id) => this.combatants.has(id));
		const droppedSoloIds: string[] = [];
		const uniqueIds = allInputs.filter((id) => {
			const c = this.combatants.get(id);
			if (c?.type === 'soloMonster') {
				droppedSoloIds.push(id);
				return false;
			}
			return true;
		});
		if (droppedSoloIds.length > 0) {
			ui.notifications?.warn(
				game.i18n?.localize?.('NIMBLE.zipperInitiative.soloCannotGroup') ??
					'Solo monsters take their own turns and cannot be added to a group selection.',
			);
		}
		if (uniqueIds.length < 2) {
			// Fall back to single select
			if (uniqueIds.length === 1) return this.selectZipperCombatant(uniqueIds[0]!);
			return;
		}

		const leaderId = uniqueIds[0]!;

		// Mark all non-leader members as acted immediately so they share this turn
		const followerIds = uniqueIds.slice(1);
		const allActedUpdates: Record<string, unknown>[] = [];
		for (const followerId of followerIds) {
			const updates = buildMarkActedUpdates(this, followerId);
			allActedUpdates.push(...updates);
		}
		if (allActedUpdates.length > 0) {
			await this.updateEmbeddedDocuments('Combatant', allActedUpdates);
		}

		// Bump the act counter to account for the followers we just marked
		const nextCounter = getZipperActCounter(this) + followerIds.length;
		await this.update(
			buildZipperCombatFlagUpdate({ actCounter: nextCounter }) as Parameters<Combat['update']>[0],
		);

		// Now select the leader as the active combatant for this turn, recording a
		// single grouped history entry that covers the leader and all followers.
		await this.selectZipperCombatant(leaderId, { groupCombatantIds: uniqueIds });
	}

	/**
	 * GM-only override to manually mark/unmark a combatant as acted.
	 * Does not flip side or trigger selection mode — pure bookkeeping correction.
	 *
	 * Must keep the turn-history in sync because the rest of the zipper code
	 * derives acted state from history (not the per-combatant flag). Without
	 * history writes, this button would silently no-op for all combatants in
	 * the refactored derive-from-history model.
	 */
	async toggleZipperActedState(combatantId: string, acted: boolean): Promise<void> {
		if (!isZipperInitiativeActive()) return;
		if (!game.user?.isGM) return;

		const combatant = this.combatants.get(combatantId);
		if (!combatant) return;

		if (acted) {
			// Skip if every occurrence is already acted (the toggle would over-fill).
			if (!hasAnyOccurrenceUnacted(this, combatant)) return;

			const totalOccurrences = getTotalOccurrencesForCombatant(this, combatant);
			const occurrenceIndex = getNextUnactedOccurrence(this, combatant);
			const actedUpdates = buildMarkActedUpdates(this, combatantId);
			if (actedUpdates.length > 0) {
				await this.updateEmbeddedDocuments('Combatant', actedUpdates);
			}
			const nextCounter = getZipperActCounter(this) + 1;
			await this.update({
				...buildZipperCombatFlagUpdate({ actCounter: nextCounter }),
				...buildAppendTurnHistoryUpdate(this, {
					combatantId,
					side: getCombatantZipperSide(combatant),
					actOrder: nextCounter,
					...(totalOccurrences > 1 ? { occurrenceIndex: Math.max(0, occurrenceIndex) } : {}),
				}),
			} as Parameters<Combat['update']>[0]);
		} else {
			// Skip if there's nothing to undo (no non-undone history entry for this combatant).
			const actedCount = combatantId ? getActedOccurrenceCount(this, combatantId) : 0;
			if (actedCount === 0) return;

			const unactedUpdates = buildUnmarkActedUpdates(this, combatantId);
			if (unactedUpdates.length > 0) {
				await this.updateEmbeddedDocuments('Combatant', unactedUpdates);
			}
			const undoneUpdate = buildMarkLastTurnUndoneForCombatantUpdate(this, combatantId);
			if (!undoneUpdate) return; // nothing to undo
			const nextCounter = Math.max(0, getZipperActCounter(this) - 1);
			await this.update({
				...buildZipperCombatFlagUpdate({ actCounter: nextCounter }),
				...undoneUpdate,
			} as Parameters<Combat['update']>[0]);
		}

		this.turns = this.setupTurns();
		this.#syncTurnIndexWithAliveTurns();
		await this.#persistAtomicTurnState({ turn: this.turn });
	}

	/**
	 * GM-only: assign combatants into a persistent turn group that acts together.
	 * The first combatant becomes the group leader.
	 *
	 * Solo monsters are excluded: they take N turns per round on their own and
	 * bundling them into a group would corrupt the per-occurrence accounting.
	 * Same guard as selectZipperGroup; defensive in case a GM tries it.
	 */
	async createPersistentTurnGroup(combatantIds: string[]): Promise<void> {
		const filteredIds: string[] = [];
		let droppedSolo = false;
		for (const id of combatantIds) {
			const c = this.combatants.get(id);
			if (c?.type === 'soloMonster') {
				droppedSolo = true;
				continue;
			}
			filteredIds.push(id);
		}
		if (droppedSolo) {
			ui.notifications?.warn(
				game.i18n?.localize?.('NIMBLE.zipperInitiative.soloCannotGroup') ??
					'Solo monsters take their own turns and cannot be added to a group selection.',
			);
		}
		if (filteredIds.length === 0) return;
		await assignPersistentTurnGroup({
			combat: this,
			memberCombatantIds: filteredIds,
			resolveCurrentTurnIdentity: () => this.#resolveCurrentTurnIdentity(),
			syncTurnToCombatant: (combatantIdOrIdentity, options) =>
				this.#syncTurnToCombatant(combatantIdOrIdentity, options),
		});
	}

	/**
	 * GM-only: remove a combatant from its persistent turn group.
	 */
	async removeFromTurnGroup(combatantId: string): Promise<void> {
		await removeCombatantFromTurnGroup({
			combat: this,
			combatantId,
			resolveCurrentTurnIdentity: () => this.#resolveCurrentTurnIdentity(),
			syncTurnToCombatant: (combatantIdOrIdentity, options) =>
				this.#syncTurnToCombatant(combatantIdOrIdentity, options),
		});
	}

	async _onDrop(event: DragEvent & { target: EventTarget & HTMLElement }) {
		event.preventDefault();

		const dropResolution = resolveDropContext({
			combat: this,
			turns: this.turns,
			event,
			previousActiveTurnIdentity: this.#resolveCurrentTurnIdentity(),
		});
		if (!dropResolution) return false;

		if (game.user?.isGM) {
			return applyGmSort({
				combat: this,
				dropResolution,
				syncTurnToCombatant: (combatantIdOrIdentity, options) =>
					this.#syncTurnToCombatant(combatantIdOrIdentity, options),
			});
		}

		return applyOwnerSort({
			combat: this,
			dropResolution,
			syncTurnToCombatant: (combatantIdOrIdentity, options) =>
				this.#syncTurnToCombatant(combatantIdOrIdentity, options),
		});
	}
}

export { NimbleCombat };
