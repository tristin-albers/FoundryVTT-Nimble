import {
	getDefaultPipTypes,
	getPipTypesForReadiness,
	getReadinessTierFromRoll,
} from '../../combat/actionType.js';
import { isCombatReadinessEnabled } from '../../settings/combatReadinessSettings.js';
import type { InitiativeRollOutcome } from './combatTypes.js';
import { handleInitiativeRules } from './handleInitiativeRules.js';

function applyStandardInitiativeActions(
	combatantUpdates: Record<string, unknown>,
	rollTotal: number,
): void {
	const actionPath = 'system.actions.base.current';
	let actionCount: number;
	if (rollTotal >= 20) {
		actionCount = 3;
	} else if (rollTotal >= 10) {
		actionCount = 2;
	} else {
		actionCount = 1;
	}
	combatantUpdates[actionPath] = actionCount;

	// Set per-pip active states to match the action count
	combatantUpdates['system.actions.base.pipActive0'] = actionCount >= 1;
	combatantUpdates['system.actions.base.pipActive1'] = actionCount >= 2;
	combatantUpdates['system.actions.base.pipActive2'] = actionCount >= 3;
}

function applyCombatReadinessActions(
	combatantUpdates: Record<string, unknown>,
	rollTotal: number,
): void {
	const tier = getReadinessTierFromRoll(rollTotal);
	const pipTypes = getPipTypesForReadiness(tier);

	// All readiness tiers grant 3 actions
	combatantUpdates['system.actions.base.current'] = 3;
	combatantUpdates['system.actions.base.max'] = 3;

	// Set per-pip types and activate all
	combatantUpdates['system.actions.base.pipType0'] = pipTypes[0];
	combatantUpdates['system.actions.base.pipType1'] = pipTypes[1];
	combatantUpdates['system.actions.base.pipType2'] = pipTypes[2];
	combatantUpdates['system.actions.base.pipActive0'] = true;
	combatantUpdates['system.actions.base.pipActive1'] = true;
	combatantUpdates['system.actions.base.pipActive2'] = true;
}

export function applyCharacterInitiativeActionUpdate(
	combatant: Combatant.Implementation,
	combatantUpdates: Record<string, unknown>,
	rollTotal: number,
): void {
	if (combatant.type !== 'character') return;

	if (isCombatReadinessEnabled()) {
		applyCombatReadinessActions(combatantUpdates, rollTotal);
	} else {
		applyStandardInitiativeActions(combatantUpdates, rollTotal);
		// Reset pip types to standard when variant is off
		const defaultTypes = getDefaultPipTypes();
		combatantUpdates['system.actions.base.pipType0'] = defaultTypes[0];
		combatantUpdates['system.actions.base.pipType1'] = defaultTypes[1];
		combatantUpdates['system.actions.base.pipType2'] = defaultTypes[2];
	}
}

export async function applyHesitantCondition(
	combatant: Combatant.Implementation,
	rollTotal: number,
): Promise<void> {
	if (!isCombatReadinessEnabled()) return;
	if (combatant.type !== 'character') return;

	const actor = combatant.actor;
	if (!actor) return;

	const tier = getReadinessTierFromRoll(rollTotal);
	if (tier === 'hesitant') {
		await actor.toggleStatusEffect('hesitant', { active: true });
	}
}

export async function buildInitiativeChatData(params: {
	combatant: Combatant.Implementation;
	roll: Roll;
	messageOptions: ChatMessage.CreateData;
	chatRollMode: string | null;
	rollIndex: number;
}): Promise<ChatMessage.CreateData> {
	const messageData = foundry.utils.mergeObject(
		{
			speaker: ChatMessage.getSpeaker({
				actor: params.combatant.actor,
				token: params.combatant.token,
				alias: params.combatant.name ?? undefined,
			}),
			flavor: game.i18n.format('COMBAT.RollsInitiative', { name: params.combatant.name ?? '' }),
			flags: { 'core.initiativeRoll': true },
		},
		params.messageOptions,
	) as ChatMessage.CreateData;
	const chatData = (await params.roll.toMessage(messageData, {
		create: false,
	})) as ChatMessage.CreateData & { rollMode?: string | null; sound?: string | null };

	// If the combatant is hidden, use a private roll unless an alternative rollMode was requested.
	const msgOpts = params.messageOptions as ChatMessage.CreateData & { rollMode?: string };
	chatData.rollMode =
		'rollMode' in msgOpts
			? (msgOpts.rollMode ?? undefined)
			: params.combatant.hidden
				? CONST.DICE_ROLL_MODES.PRIVATE
				: params.chatRollMode;

	// Play 1 sound for the whole rolled set.
	if (params.rollIndex > 0) chatData.sound = null;
	return chatData;
}

export async function rollInitiativeForCombatant(params: {
	combat: Combat;
	combatantId: string;
	formula: string | null;
	messageOptions: ChatMessage.CreateData;
	chatRollMode: string | null;
	rollIndex: number;
	combatManaUpdates: Promise<unknown>[];
}): Promise<InitiativeRollOutcome | null> {
	const combatant = params.combat.combatants.get(params.combatantId);
	if (!combatant?.isOwner) return null;

	const combatantUpdates: Record<string, unknown> = { _id: params.combatantId };

	const roll = combatant.getInitiativeRoll(params.formula ?? undefined);
	await roll.evaluate();
	const rollTotal = roll.total ?? 0;
	combatantUpdates.initiative = rollTotal;
	applyCharacterInitiativeActionUpdate(combatant, combatantUpdates, rollTotal);

	// Apply Hesitant condition for combat readiness variant
	await applyHesitantCondition(combatant, rollTotal);

	await handleInitiativeRules({
		combatId: params.combat.id,
		combatManaUpdates: params.combatManaUpdates,
		combatant,
	});

	const chatData = await buildInitiativeChatData({
		combatant,
		roll,
		messageOptions: params.messageOptions,
		chatRollMode: params.chatRollMode,
		rollIndex: params.rollIndex,
	});

	return {
		combatantUpdate: combatantUpdates,
		chatData,
	};
}
