<script>
	import { untrack } from 'svelte';
	import { isCombatReadinessEnabled } from '../../settings/combatReadinessSettings.js';
	import {
		getCombatantPipActiveStates,
		getCombatantPipTypes,
	} from '../../documents/combat/combatantSystem.js';
	import { flattenEffectsTree } from '../../utils/treeManipulation/flattenEffectsTree.js';
	import localize from '../../utils/localize.js';
	import RollModeConfig from './components/RollModeConfig.svelte';
	const { skillCheckDialog } = CONFIG.NIMBLE;

	let { actor, dialog, item, ...data } = $props();
	let selectedRollMode = $state(untrack(() => Math.clamp(data.rollMode ?? 0, -6, 6)));
	let situationalModifiers = $state('');
	let primaryDieValue = $state();
	let primaryDieModifier = $state();
	let shouldRollBeHidden = $state(!!game.settings.get('nimble', 'hideRolls'));
	let useInspiredAction = $state(false);
	let useBaneAction = $state(false);

	// Detect available typed pips
	let availableTypedPips = $derived.by(() => {
		if (!isCombatReadinessEnabled())
			return { hasBane: false, hasInspired: false, hasStandard: true };

		const combat = game.combat;
		if (!combat?.started) return { hasBane: false, hasInspired: false, hasStandard: true };

		const combatant = combat.combatants.find((entry) => entry.actorId === actor.id);
		if (!combatant || combatant.type !== 'character')
			return { hasBane: false, hasInspired: false, hasStandard: true };

		const pipTypes = getCombatantPipTypes(combatant);
		const pipActiveStates = getCombatantPipActiveStates(combatant);

		return {
			hasBane: pipActiveStates.some((active, i) => active && pipTypes[i] === 'bane'),
			hasInspired: pipActiveStates.some((active, i) => active && pipTypes[i] === 'inspired'),
			hasStandard: pipActiveStates.some((active, i) => active && pipTypes[i] === 'standard'),
		};
	});

	let showBaneCheckbox = $derived(availableTypedPips.hasBane);
	let showInspiredCheckbox = $derived(availableTypedPips.hasInspired);
	let isForced = $derived(
		!availableTypedPips.hasStandard &&
			(availableTypedPips.hasBane || availableTypedPips.hasInspired),
	);

	// Auto-check when forced (no standard pips available)
	$effect(() => {
		if (!isForced) return;
		// If only one type available, auto-check it
		if (availableTypedPips.hasInspired && !availableTypedPips.hasBane) {
			useInspiredAction = true;
			useBaneAction = false;
		} else if (availableTypedPips.hasBane && !availableTypedPips.hasInspired) {
			useBaneAction = true;
			useInspiredAction = false;
		} else if (!useInspiredAction && !useBaneAction) {
			// Both available but neither checked — default to bane
			useBaneAction = true;
		}
	});

	// Ensure mutual exclusivity — can't use both bane and inspired
	function onBaneChange(checked) {
		if (checked) useInspiredAction = false;
		// When forced, prevent unchecking if it's the only option
		if (!checked && isForced && !useInspiredAction) useBaneAction = true;
	}
	function onInspiredChange(checked) {
		if (checked) useBaneAction = false;
		// When forced, prevent unchecking if it's the only option
		if (!checked && isForced && !useBaneAction) useInspiredAction = true;
	}

	let selectedActionType = $derived(
		useInspiredAction ? 'inspired' : useBaneAction ? 'bane' : 'standard',
	);

	// Track the user's manual roll mode separately from action type modifier
	let userRollMode = $state(untrack(() => Math.clamp(Number(data.rollMode ?? 0), -6, 6)));

	// When action type changes, update the slider to reflect the combined value
	$effect(() => {
		let modifier = 0;
		if (useInspiredAction) modifier = 1;
		else if (useBaneAction) modifier = -1;
		selectedRollMode = Math.clamp(userRollMode + modifier, -6, 6);
	});

	const { damageTypes, hitDice } = CONFIG.NIMBLE;

	// Get all damage effects from the item's activation effects
	// This searches recursively through the effects tree, including sharedRolls
	// Only include top-level damage effects (not nested ones like criticalHit, miss, etc.)
	let damageEffects = $derived.by(() => {
		const effects = item.system.activation?.effects ?? [];
		const allDamageEffects = [];

		// Flatten the tree to get all effects including those in sharedRolls
		const flattened = flattenEffectsTree(effects);
		for (const effect of flattened) {
			// Only include top-level damage effects or sharedRolls
			// Exclude conditional damage (criticalHit, miss, hit, failedSaveBy, etc.)
			const isConditional =
				(effect.parentContext && ['criticalHit', 'miss', 'hit'].includes(effect.parentContext)) ||
				effect.parentContext?.startsWith('failedSaveBy');

			if (effect.type === 'damage' && !isConditional) {
				allDamageEffects.push({
					formula: effect.formula || '0',
					damageType: effect.damageType,
				});
			}
		}

		// Also check sharedRolls directly (before flattening removes them)
		// This ensures we catch all damage effects in sharedRolls
		for (const effect of effects) {
			if (effect.type === 'savingThrow' && effect.sharedRolls) {
				for (const sharedRoll of effect.sharedRolls) {
					if (sharedRoll.type === 'damage') {
						// Check if we already have this damage effect
						const exists = allDamageEffects.some(
							(d) => d.formula === sharedRoll.formula && d.damageType === sharedRoll.damageType,
						);
						if (!exists) {
							allDamageEffects.push({
								formula: sharedRoll.formula || '0',
								damageType: sharedRoll.damageType,
							});
						}
					}
				}
			}
		}

		// If still no damage effects found, return a default one
		if (allDamageEffects.length === 0) {
			return [{ formula: '0' }];
		}

		return allDamageEffects;
	});

	// Get the first damage formula for backward compatibility (used in validation)
	let damageFormula = $derived(damageEffects[0]?.formula || '0');

	// Modify formulas by adding the situationalModifiers
	let modifiedFormulas = $derived.by(() => {
		return damageEffects.map((effect) => {
			let formula = effect.formula;
			if (situationalModifiers !== '') {
				formula += `+${situationalModifiers}`;
			}
			return {
				formula,
				damageType: effect.damageType,
			};
		});
	});
</script>

<article class="nimble-sheet__body" style="--nimble-sheet-body-padding-block-start: 0.5rem">
	<RollModeConfig bind:selectedRollMode />

	{#if showInspiredCheckbox || showBaneCheckbox}
		<div class="nimble-roll-modifiers-container nimble-action-type-selector">
			{#if showInspiredCheckbox}
				<label class="nimble-action-type-checkbox nimble-action-type-checkbox--inspired">
					<input
						type="checkbox"
						bind:checked={useInspiredAction}
						onchange={() => onInspiredChange(useInspiredAction)}
					/>
					{localize('NIMBLE.ui.heroicActions.actionTypeChoice.useInspired')}
					{#if useInspiredAction}
						<span class="nimble-action-type-effect nimble-action-type-effect--inspired"
							>— Adv. on this attack</span
						>
					{/if}
				</label>
			{/if}
			{#if showBaneCheckbox}
				<label class="nimble-action-type-checkbox nimble-action-type-checkbox--bane">
					<input
						type="checkbox"
						bind:checked={useBaneAction}
						onchange={() => onBaneChange(useBaneAction)}
					/>
					{localize('NIMBLE.ui.heroicActions.actionTypeChoice.useBane')}
					{#if useBaneAction}
						<span class="nimble-action-type-effect nimble-action-type-effect--bane"
							>— Disadv. on this attack</span
						>
					{/if}
				</label>
			{/if}
			{#if isForced}
				<span class="nimble-action-type-forced">
					{localize('NIMBLE.ui.heroicActions.actionTypeChoice.forced')}
				</span>
			{/if}
		</div>
	{/if}

	<div class="nimble-roll-modifiers-container">
		<div class="nimble-roll-modifiers">
			<label>
				{hitDice.situationalModifiers}:
				<input type="string" bind:value={situationalModifiers} placeholder="0" />
			</label>
		</div>
	</div>
	<div class="nimble-roll-modifiers-container">
		<div class="nimble-roll-modifiers">
			<label>
				{hitDice.setPrimaryDie}:
				<input type="number" bind:value={primaryDieValue} placeholder="0" />
			</label>
		</div>

		<div class="nimble-roll-modifiers">
			<label>
				{hitDice.setPrimaryDieModifier}:
				<input type="number" bind:value={primaryDieModifier} placeholder="0" />
			</label>
		</div>
	</div>

	<div class="nimble-roll-formulas">
		{#each modifiedFormulas as damageEffect}
			<div class="nimble-roll-formula">
				{#if damageEffect.damageType}
					<span class="nimble-roll-formula__type">
						{game.i18n.localize(damageTypes[damageEffect.damageType] || damageEffect.damageType)}:
					</span>
				{/if}
				<span class="nimble-roll-formula__formula">
					{Roll.replaceFormulaData(damageEffect.formula, actor.getRollData(item))}
				</span>
			</div>
		{/each}
	</div>
	{#if game.user?.isGM}
		<div class="nimble-roll-modifiers-container">
			<label>
				{skillCheckDialog.hideRoll}
				<input type="checkbox" bind:checked={shouldRollBeHidden} class="modifier-item__checkbox" />
			</label>
		</div>
	{/if}
</article>

<footer class="nimble-sheet__footer">
	<button
		class="nimble-button"
		data-button-variant="basic"
		onclick={() => {
			if (situationalModifiers !== '') {
				const isValid = Roll.validate(situationalModifiers);
				if (!isValid) {
					ui.notifications?.warn('❌ Invalid dice formula in the situational modifiers!');
					return;
				}
			}
			if (primaryDieValue != null) {
				const roll = new Roll(damageFormula);
				const terms = roll.terms;
				const firstDieIndex = terms.findIndex((t) => t instanceof foundry.dice.terms.Die);
				if (primaryDieValue > terms[firstDieIndex].faces || primaryDieValue < 0) {
					ui.notifications?.warn('❌ Invalid value for primary die!');
					return;
				}
			}
			dialog.submitActivation({
				rollMode: selectedRollMode,
				rollFormula: modifiedFormulas[0]?.formula || '0',
				situationalModifiers,
				primaryDieValue: primaryDieValue,
				primaryDieModifier: primaryDieModifier,
				rollHidden: shouldRollBeHidden,
				actionTypeOverride: selectedActionType !== 'standard' ? selectedActionType : undefined,
			});
		}}
	>
		<i class="nimble-button__icon fa-solid fa-dice-d20"></i>
		Roll
	</button>
</footer>

<style lang="scss">
	[data-button-variant='basic'] {
		--nimble-button-padding: 0.5rem;
		--nimble-button-width: 100%;
	}

	.nimble-roll-modifiers-container {
		display: flex;
		gap: 1rem;
		margin-top: 1rem;
	}

	.nimble-roll-modifiers {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;

		label {
			display: flex;
			align-items: center;
			gap: 0.5rem;

			input {
				padding: 0.5rem;
				border: 1px solid var(--nimble-border-color);
				border-radius: var(--nimble-border-radius);
				flex: 1;
			}
		}
	}

	.nimble-action-type-selector {
		flex-direction: column;
		gap: 0.5rem;
	}

	.nimble-action-type-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.nimble-action-type-effect {
		font-size: 0.8rem;
		font-style: italic;

		&--inspired {
			color: hsl(210, 60%, 75%);
		}

		&--bane {
			color: hsl(280, 50%, 70%);
		}
	}

	.nimble-action-type-forced {
		font-size: 0.8rem;
		font-style: italic;
		color: hsl(45, 70%, 55%);
	}

	.nimble-roll-formulas {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.nimble-roll-formula {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		background: var(--nimble-background-color-secondary);
		border-radius: 9999px;
		white-space: nowrap;

		&__type {
			font-weight: 600;
			color: var(--nimble-text-color-primary);
		}

		&__formula {
			font-family: var(--nimble-font-family-mono);
			color: var(--nimble-text-color-secondary);
		}
	}
</style>
