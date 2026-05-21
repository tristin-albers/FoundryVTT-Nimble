import { untrack } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { NimbleCharacter } from '#documents/actor/character.js';
import {
	getCombatantAdditionalActions,
	getCombatantBaseActions,
	getCombatantBonusCurrent,
	getCombatantPipActiveStates,
	getCombatantPipTypes,
} from '#documents/combat/combatantSystem.js';
import type { PromptedInitiativeOptions } from '#types/combat.js';
import { getActiveCombatForCurrentScene, registerCombatStateHooks } from '#utils/combatState.js';
import { requestAdvanceCombatTurn } from '#utils/combatTurnActions.js';
import { getActiveCombatant } from '#utils/combatTurnSync.js';
import { initiativeRollLock } from '#utils/initiativeRollLock.js';
import localize from '#utils/localize.js';
import { queueCombatantMutationWithFreshDocument } from '#utils/queueCombatantMutationWithFreshDocument.js';
import type { ActionType } from '../../../combat/actionType.js';
import { isBaneInspiredActionsEnabled } from '../../../settings/combatReadinessSettings.js';

// ============================================================================
// Types
// ============================================================================

interface ActionsData {
	current: number;
	max: number;
	additional: number;
	bonusCurrent: number;
	effectiveMax: number;
	pipTypes: ActionType[];
	pipActiveStates: boolean[];
}

// ============================================================================
// Dice Icons
// ============================================================================

const DICE_ICONS = [
	'fa-dice-one',
	'fa-dice-two',
	'fa-dice-three',
	'fa-dice-four',
	'fa-dice-five',
	'fa-dice-six',
];

export function getDiceIcon(index: number): string | null {
	if (index < DICE_ICONS.length) {
		return DICE_ICONS[index];
	}
	return null;
}

// ============================================================================
// State Factory
// ============================================================================

export function createActionTrackerState(getActor: () => NimbleCharacter) {
	// ============================================================================
	// Combat State Subscription
	// ============================================================================

	const subscribeCombatState = createSubscriber(registerCombatStateHooks);

	// ============================================================================
	// Combat Helper Functions
	// ============================================================================

	function getCombatantInCombat(): Combatant | null {
		const combat = getActiveCombatForCurrentScene();
		if (!combat) return null;
		return combat.combatants.find((entry) => entry.actorId === getActor().id) ?? null;
	}

	function hasRolledInitiative(): boolean {
		const combatant = getCombatantInCombat();
		if (!combatant) return false;
		return combatant.initiative !== null;
	}

	function needsToRollInitiative(): boolean {
		const combatant = getCombatantInCombat();
		if (!combatant) return false;
		if (initiativeRollLock.hasActiveLock(combatant)) return false;
		return combatant.initiative === null;
	}

	function isInitiativePending(): boolean {
		const combatant = getCombatantInCombat();
		if (!combatant) return false;
		return initiativeRollLock.hasActiveLock(combatant);
	}

	function getActionsData(): ActionsData {
		const combatant = getCombatantInCombat();
		if (!combatant)
			return {
				current: 0,
				max: 3,
				additional: 0,
				bonusCurrent: 0,
				effectiveMax: 3,
				pipTypes: ['standard', 'standard', 'standard'],
				pipActiveStates: [false, false, false],
			};

		const actions = getCombatantBaseActions(combatant);
		const additional = getCombatantAdditionalActions(combatant);
		const max = actions.max || 3;
		const effectiveMax = max + additional;

		// When the Bane/Inspired variant is off, the numeric `current` is the
		// single source of truth: it is the only field the rest of the system
		// (action spending, the combat tracker, turn refills) keeps up to date.
		// Derive pip availability from it so the sheet mirrors the tracker rather
		// than reading the per-pip booleans, which go stale in this mode.
		if (!isBaneInspiredActionsEnabled()) {
			const current = actions.current;
			const baseActive = Math.max(0, Math.min(current, max));
			return {
				current,
				max,
				additional,
				bonusCurrent: Math.max(0, Math.min(current - max, additional)),
				effectiveMax,
				pipTypes: ['standard', 'standard', 'standard'],
				pipActiveStates: [0, 1, 2].map((i) => i < baseActive),
			};
		}

		const bonusCurrent = getCombatantBonusCurrent(combatant);
		const pipTypes = getCombatantPipTypes(combatant);
		const pipActiveStates = getCombatantPipActiveStates(combatant);
		return {
			current: actions.current,
			max,
			additional,
			bonusCurrent,
			effectiveMax,
			pipTypes,
			pipActiveStates,
		};
	}

	function isCharactersTurn(): boolean {
		const combat = getActiveCombatForCurrentScene();
		if (!combat?.started) return false;

		const currentCombatant = getActiveCombatant(combat);
		if (!currentCombatant) return false;

		return currentCombatant.actorId === getActor().id;
	}

	// ============================================================================
	// Combat Actions
	// ============================================================================

	async function rollInitiative(): Promise<void> {
		const combat = getActiveCombatForCurrentScene();
		if (!combat) return;
		const combatant = combat.combatants.find((entry) => entry.actorId === getActor().id);
		if (!combatant?.id) return;
		if (initiativeRollLock.hasActiveLock(combatant)) return;

		try {
			await combat.rollInitiative([combatant.id], {
				promptRollDialog: true,
			} as PromptedInitiativeOptions);
		} catch (_error) {
			ui.notifications?.warn(localize('NIMBLE.ui.heroicActions.noPermissionRollInitiative'));
		}
	}

	async function addAdditionalAction(): Promise<void> {
		const combat = getActiveCombatForCurrentScene();
		const combatantId = getCombatantInCombat()?.id ?? null;
		if (!combat || !combatantId) return;

		const maxAdditionalSlots = 10 - actionsData.max;
		if (actionsData.additional >= maxAdditionalSlots) return;

		const newAdditional = actionsData.additional + 1;
		const newAdditionalCurrent = actionsData.bonusCurrent + 1;
		const newCurrent = actionsData.pipActiveStates.filter(Boolean).length + newAdditionalCurrent;

		await queueCombatantMutationWithFreshDocument({
			combat,
			combatantId,
			mutation: async (currentCombatant) => {
				await currentCombatant.update({
					'system.actions.base.additional': newAdditional,
					'system.actions.base.bonusCurrent': newAdditionalCurrent,
					'system.actions.base.current': newCurrent,
				} as Record<string, unknown>);
			},
		});
	}

	async function confirmEndTurnEarly(): Promise<boolean> {
		const dialogApi = foundry.applications?.api?.DialogV2;
		const title = localize('NIMBLE.ui.heroicActions.confirmEndTurnEarlyTitle');
		const prompt = localize('NIMBLE.ui.heroicActions.confirmEndTurnEarlyBody');

		if (!dialogApi?.wait) {
			return globalThis.confirm(prompt);
		}

		const result = await dialogApi.wait({
			window: { title },
			content: `<p>${prompt}</p>`,
			modal: true,
			rejectClose: false,
			buttons: [
				{
					action: 'no',
					icon: 'fa-solid fa-xmark',
					label: localize('No'),
				},
				{
					action: 'yes',
					icon: 'fa-solid fa-check',
					label: localize('Yes'),
					default: true,
				},
			],
		});

		return result === 'yes' || (result as unknown) === true;
	}

	async function endTurn(): Promise<void> {
		const combat = getActiveCombatForCurrentScene();
		if (!combat) return;

		if (actionsData.current > 0) {
			const confirmed = await confirmEndTurnEarly();
			if (!confirmed) return;
		}

		try {
			const advanced = await requestAdvanceCombatTurn({ combat });
			if (!advanced) {
				ui.notifications?.warn(localize('NIMBLE.ui.heroicActions.noPermissionEndTurn'));
			}
		} catch (_error) {
			ui.notifications?.warn(localize('NIMBLE.ui.heroicActions.noPermissionEndTurn'));
		}
	}

	// ============================================================================
	// Reactive Combat State
	// ============================================================================

	const needsInitiative = $derived.by(() => {
		subscribeCombatState();
		return needsToRollInitiative();
	});

	const hasInitiative = $derived.by(() => {
		subscribeCombatState();
		return hasRolledInitiative();
	});

	const initiativePending = $derived.by(() => {
		subscribeCombatState();
		return isInitiativePending();
	});

	const actionsData = $derived.by(() => {
		subscribeCombatState();
		return getActionsData();
	});

	const isMyTurn = $derived.by(() => {
		subscribeCombatState();
		return isCharactersTurn();
	});

	const showCombatBar = $derived(hasInitiative || needsInitiative || initiativePending);

	// ============================================================================
	// Pip Interaction
	// ============================================================================

	async function updatePipState(updates: Record<string, unknown>): Promise<void> {
		const combat = getActiveCombatForCurrentScene();
		const combatantId = getCombatantInCombat()?.id ?? null;
		if (!combat || !combatantId) return;

		await queueCombatantMutationWithFreshDocument({
			combat,
			combatantId,
			mutation: async (currentCombatant) => {
				await currentCombatant.update(updates);
			},
		});
	}

	function handlePipClick(index: number, event?: MouseEvent): void {
		if (!hasInitiative) return;

		// Bane/Inspired off: `current` is the single source of truth, so clicking a
		// pip sets the available-action count directly (spend down / restore up),
		// matching the combat tracker. Pip typing (ctrl/shift) is variant-only.
		if (!isBaneInspiredActionsEnabled()) {
			const isActive = index < actionsData.current;
			const newCurrent = Math.max(
				0,
				Math.min(isActive ? index : index + 1, actionsData.effectiveMax),
			);
			if (newCurrent === actionsData.current) return;
			void updatePipState({
				'system.actions.base.current': newCurrent,
			} as Record<string, unknown>);
			return;
		}

		const isBonus = index >= actionsData.max;

		// Bonus pips (index >= max) use their own bonusCurrent counter
		if (isBonus) {
			const bonusIndex = index - actionsData.max;
			const isAvailable = bonusIndex < actionsData.bonusCurrent;
			if (isAvailable) {
				const newAdditionalCurrent = Math.max(0, actionsData.bonusCurrent - 1);
				void updatePipState({
					'system.actions.base.bonusCurrent': newAdditionalCurrent,
					'system.actions.base.current':
						actionsData.pipActiveStates.filter(Boolean).length + newAdditionalCurrent,
				} as Record<string, unknown>);
			} else {
				const newAdditionalCurrent = Math.min(actionsData.bonusCurrent + 1, actionsData.additional);
				void updatePipState({
					'system.actions.base.bonusCurrent': newAdditionalCurrent,
					'system.actions.base.current':
						actionsData.pipActiveStates.filter(Boolean).length + newAdditionalCurrent,
				} as Record<string, unknown>);
			}
			return;
		}

		// For base pips: apply a delta to current (+1 or -1) rather than
		// recomputing from scratch. This avoids desync with bonus pips.
		const isActive = actionsData.pipActiveStates[index] ?? false;

		// Helper: compute current from base pip states + bonusCurrent
		function syncCurrent(newBaseStates: boolean[]): number {
			return newBaseStates.filter(Boolean).length + actionsData.bonusCurrent;
		}

		// Ctrl+click: set pip to bane and activate it
		if (event?.ctrlKey || event?.metaKey) {
			const currentType = actionsData.pipTypes[index];
			const newType: ActionType = currentType === 'bane' && isActive ? 'standard' : 'bane';
			const newStates = [...actionsData.pipActiveStates];
			newStates[index] = true;
			void updatePipState({
				[`system.actions.base.pipType${index}`]: newType,
				[`system.actions.base.pipActive${index}`]: true,
				'system.actions.base.current': syncCurrent(newStates),
			} as Record<string, unknown>);
			return;
		}

		// Shift+click: set pip to inspired and activate it
		if (event?.shiftKey) {
			const currentType = actionsData.pipTypes[index];
			const newType: ActionType = currentType === 'inspired' && isActive ? 'standard' : 'inspired';
			const newStates = [...actionsData.pipActiveStates];
			newStates[index] = true;
			void updatePipState({
				[`system.actions.base.pipType${index}`]: newType,
				[`system.actions.base.pipActive${index}`]: true,
				'system.actions.base.current': syncCurrent(newStates),
			} as Record<string, unknown>);
			return;
		}

		// Normal click: toggle active state
		const newStates = [...actionsData.pipActiveStates];
		newStates[index] = !isActive;

		const updates: Record<string, unknown> = {
			[`system.actions.base.pipActive${index}`]: !isActive,
			'system.actions.base.current': syncCurrent(newStates),
		};

		// Restoring (clicking empty pip) always sets type to standard
		if (!isActive) {
			updates[`system.actions.base.pipType${index}`] = 'standard';
		}

		void updatePipState(updates);
	}

	function getPipAriaLabel(index: number): string {
		const number = String(index + 1);
		const isActive = actionsData.pipActiveStates[index] ?? false;
		if (isActive) {
			return localize('NIMBLE.ui.heroicActions.pip.spendAction', { number });
		}
		return localize('NIMBLE.ui.heroicActions.pip.restoreAction', { number });
	}

	function getPipTypeLabel(index: number): string {
		const pipType = actionsData.pipTypes[index] ?? 'standard';
		switch (pipType) {
			case 'bane':
				return localize('NIMBLE.ui.heroicActions.pip.baneAction');
			case 'inspired':
				return localize('NIMBLE.ui.heroicActions.pip.inspiredAction');
			default:
				return localize('NIMBLE.ui.heroicActions.pip.standardAction');
		}
	}

	function getPipTooltip(index: number): string {
		if (!hasInitiative) {
			return localize('NIMBLE.ui.heroicActions.enterCombat');
		}

		const pipType = actionsData.pipTypes[index] ?? 'standard';
		const typeLabel = pipType !== 'standard' ? `${getPipTypeLabel(index)} — ` : '';
		const isActive = actionsData.pipActiveStates[index] ?? false;

		if (isActive) {
			return `${typeLabel}${localize('NIMBLE.ui.heroicActions.pip.clickToSpend')}`;
		}
		return `${typeLabel}${localize('NIMBLE.ui.heroicActions.pip.clickToRestore')}`;
	}

	// ============================================================================
	// Pip Spend Animation
	// ============================================================================

	let justSpentPips = $state(new Set<number>());
	let previousPipActiveStates = $state(untrack(() => [...actionsData.pipActiveStates]));

	function setupPipAnimationEffect(): void {
		$effect(() => {
			const currentStates = actionsData.pipActiveStates;
			const prevStates = untrack(() => previousPipActiveStates);
			const newlySpent = new Set<number>();

			for (let i = 0; i < currentStates.length; i++) {
				const wasActive = prevStates[i] ?? false;
				const isActive = currentStates[i] ?? false;
				if (wasActive && !isActive) {
					newlySpent.add(i);
				}
			}

			if (newlySpent.size > 0) {
				justSpentPips = newlySpent;
				setTimeout(() => {
					justSpentPips = new Set();
				}, 600);
			}

			previousPipActiveStates = [...currentStates];
		});
	}

	// ============================================================================
	// Return Public Interface
	// ============================================================================

	return {
		// Reactive state (getters)
		get needsInitiative() {
			return needsInitiative;
		},
		get hasInitiative() {
			return hasInitiative;
		},
		get initiativePending() {
			return initiativePending;
		},
		get actionsData() {
			return actionsData;
		},
		get isMyTurn() {
			return isMyTurn;
		},
		get showCombatBar() {
			return showCombatBar;
		},
		get justSpentPips() {
			return justSpentPips;
		},

		// Actions
		rollInitiative,
		endTurn,
		addAdditionalAction,
		handlePipClick,

		// Helpers
		getPipAriaLabel,
		getPipTypeLabel,
		getPipTooltip,
		setupPipAnimationEffect,
	};
}
