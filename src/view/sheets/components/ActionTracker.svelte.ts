import { untrack } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { NimbleCharacter } from '#documents/actor/character.js';
import {
	getCombatantBaseActions,
	getCombatantBonusActions,
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

// ============================================================================
// Types
// ============================================================================

interface ActionsData {
	current: number;
	max: number;
	bonus: number;
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
				bonus: 0,
				effectiveMax: 3,
				pipTypes: ['standard', 'standard', 'standard'],
				pipActiveStates: [false, false, false],
			};

		const actions = getCombatantBaseActions(combatant);
		const bonus = getCombatantBonusActions(combatant);
		const max = actions.max || 3;
		const pipTypes = getCombatantPipTypes(combatant);
		const pipActiveStates = getCombatantPipActiveStates(combatant);
		return {
			current: actions.current,
			max,
			bonus,
			effectiveMax: max + bonus,
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

	async function addBonusAction(): Promise<void> {
		const combat = getActiveCombatForCurrentScene();
		const combatantId = getCombatantInCombat()?.id ?? null;
		if (!combat || !combatantId) return;

		const maxBonusSlots = 10 - actionsData.max;
		if (actionsData.bonus >= maxBonusSlots) return;

		const newBonus = actionsData.bonus + 1;
		const newCurrent = actionsData.current + 1;

		await queueCombatantMutationWithFreshDocument({
			combat,
			combatantId,
			mutation: async (currentCombatant) => {
				await currentCombatant.update({
					'system.actions.base.bonus': newBonus,
					'system.actions.base.current': newCurrent,
				} as Record<string, unknown>);
			},
		});
	}

	async function endTurn(): Promise<void> {
		const combat = getActiveCombatForCurrentScene();
		if (!combat) return;

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

		const isBonus = index >= actionsData.max;

		// Bonus pips (index >= max) use simple current increment/decrement
		if (isBonus) {
			const isAvailable = index < actionsData.current;
			if (isAvailable) {
				const newCurrent = Math.max(actionsData.current - 1, 0);
				void updatePipState({
					'system.actions.base.current': newCurrent,
				} as Record<string, unknown>);
			} else {
				const newCurrent = Math.min(actionsData.current + 1, actionsData.effectiveMax);
				void updatePipState({
					'system.actions.base.current': newCurrent,
				} as Record<string, unknown>);
			}
			return;
		}

		// Ctrl+click: set pip to bane and activate it
		if (event?.ctrlKey || event?.metaKey) {
			const currentType = actionsData.pipTypes[index];
			const isActive = actionsData.pipActiveStates[index] ?? false;
			const newType: ActionType = currentType === 'bane' && isActive ? 'standard' : 'bane';
			const newActiveStates = [...actionsData.pipActiveStates];
			newActiveStates[index] = true;
			const newCurrent =
				newActiveStates.filter(Boolean).length +
				Math.max(0, actionsData.current - actionsData.pipActiveStates.filter(Boolean).length);
			void updatePipState({
				[`system.actions.base.pipType${index}`]: newType,
				[`system.actions.base.pipActive${index}`]: true,
				'system.actions.base.current': newCurrent,
			} as Record<string, unknown>);
			return;
		}

		// Shift+click: set pip to inspired and activate it
		if (event?.shiftKey) {
			const currentType = actionsData.pipTypes[index];
			const isActive = actionsData.pipActiveStates[index] ?? false;
			const newType: ActionType = currentType === 'inspired' && isActive ? 'standard' : 'inspired';
			const newActiveStates = [...actionsData.pipActiveStates];
			newActiveStates[index] = true;
			const newCurrent =
				newActiveStates.filter(Boolean).length +
				Math.max(0, actionsData.current - actionsData.pipActiveStates.filter(Boolean).length);
			void updatePipState({
				[`system.actions.base.pipType${index}`]: newType,
				[`system.actions.base.pipActive${index}`]: true,
				'system.actions.base.current': newCurrent,
			} as Record<string, unknown>);
			return;
		}

		// Normal click: toggle active state. When restoring, always set type to standard.
		const isActive = actionsData.pipActiveStates[index] ?? false;
		const newActiveStates = [...actionsData.pipActiveStates];
		newActiveStates[index] = !isActive;
		// Preserve bonus pip count in current
		const basePipActiveCount = newActiveStates.filter(Boolean).length;
		const bonusActive = Math.max(
			0,
			actionsData.current - actionsData.pipActiveStates.filter(Boolean).length,
		);
		const newCurrent = basePipActiveCount + bonusActive;

		const updates: Record<string, unknown> = {
			[`system.actions.base.pipActive${index}`]: !isActive,
			'system.actions.base.current': newCurrent,
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
		addBonusAction,
		handlePipClick,

		// Helpers
		getPipAriaLabel,
		getPipTypeLabel,
		getPipTooltip,
		setupPipAnimationEffect,
	};
}
