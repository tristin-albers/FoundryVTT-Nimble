import type { ReactionPanelStateOptions } from '../../../../types/components/ReactionPanel.d.ts';
import { predictNextConsumedActionType } from '../../../combat/actionType.js';
import {
	getCombatantPipActiveStates,
	getCombatantPipTypes,
} from '../../../documents/combat/combatantSystem.js';
import { isCombatReadinessEnabled } from '../../../settings/combatReadinessSettings.js';
import localize from '../../../utils/localize.js';
import showReactionConfirmation from '../../../utils/showReactionConfirmation.js';
import { getTargetedTokens, getTargetName } from '../../../utils/targeting.js';
import handleInterposeAndDefend from './handleInterposeAndDefend.js';

export function createDefendPanelState(options: ReactionPanelStateOptions) {
	const {
		getActor,
		getReactionDisabled,
		getDefendSpent,
		getNoActions,
		getIsActiveTurn,
		getOnUseReaction,
	} = options;

	// Targeting state
	let targetingVersion = $state(0);

	const availableTargets = $derived.by(() => {
		void targetingVersion;
		return getTargetedTokens(getActor().id ?? '');
	});

	const selectedTarget = $derived(availableTargets.length === 1 ? availableTargets[0] : null);

	const armorValue = $derived(getActor().reactive.system.attributes.armor.value ?? 0);

	// Set up hook listener for target changes
	$effect(() => {
		const hookId = Hooks.on('targetToken', () => {
			targetingVersion++;
		});
		return () => Hooks.off('targetToken', hookId);
	});

	function getNextConsumedActionType(): 'standard' | 'bane' | 'inspired' {
		if (!isCombatReadinessEnabled()) return 'standard';

		const combat = game.combat;
		if (!combat?.started) return 'standard';

		const combatant = combat.combatants?.find(
			(entry: Combatant.Implementation) => entry.actorId === getActor().id,
		);
		if (!combatant || combatant.type !== 'character') return 'standard';

		return predictNextConsumedActionType(
			getCombatantPipTypes(combatant),
			getCombatantPipActiveStates(combatant),
		);
	}

	async function handleDefend(): Promise<void> {
		const isDisabled = getReactionDisabled();

		// Determine which action type will be consumed before using the reaction
		const consumedType = getNextConsumedActionType();

		if (isDisabled) {
			const defendSpent = getDefendSpent();
			const noActions = getNoActions();
			const isActiveTurn = getIsActiveTurn();
			const reactionName = localize('NIMBLE.ui.heroicActions.reactions.defend.label');

			const confirmed = await showReactionConfirmation({
				reactionName,
				spentReactionNames: reactionName,
				noActions,
				hasSpentReactions: defendSpent,
				isActiveTurn,
			});
			if (!confirmed) return;

			const reactionUsed = await getOnUseReaction()({ force: true });
			if (!reactionUsed) return;
		} else {
			const reactionUsed = await getOnUseReaction()();
			if (!reactionUsed) return;
		}

		const actor = getActor();
		const baseArmorValue = actor.reactive.system.attributes.armor.value ?? 0;
		const rollData =
			(actor as unknown as { getRollData?: () => Record<string, unknown> }).getRollData?.() ?? {};
		const keyAbilityMod = Number(rollData.key ?? 0);

		let armorModifier = 0;
		let actionTypeTag = '';
		if (consumedType === 'bane') {
			armorModifier = -keyAbilityMod;
			actionTypeTag = ' (B)';
		} else if (consumedType === 'inspired') {
			armorModifier = keyAbilityMod;
			actionTypeTag = ' (I)';
		}

		const effectiveArmor = Math.max(0, baseArmorValue + armorModifier);

		const chatData = {
			author: game.user?.id,
			speaker: ChatMessage.getSpeaker({ actor }),
			type: 'reaction',
			system: {
				actorName: actor.name,
				actorType: actor.type,
				image: actor.img,
				permissions: actor.permission,
				rollMode: 0,
				reactionType: 'defend',
				armorValue: effectiveArmor,
				armorModifier,
				actionTypeTag,
				targets: [],
			},
		};
		await ChatMessage.create(chatData as unknown as ChatMessage.CreateData);
	}

	return {
		get availableTargets() {
			return availableTargets;
		},
		get selectedTarget() {
			return selectedTarget;
		},
		get armorValue() {
			return armorValue;
		},
		getTargetName,
		handleDefend,
		handleInterposeAndDefend: () => handleInterposeAndDefend(options),
	};
}
