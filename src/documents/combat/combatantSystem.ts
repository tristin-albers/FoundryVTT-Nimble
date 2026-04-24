import { type ActionType, isValidActionType } from '../../combat/actionType.js';
import type { CombatantBaseActions, NimbleCombatantSystem } from './combatTypes.js';

function getCombatantSystem(combatant: Combatant.Implementation): NimbleCombatantSystem | null {
	const system = combatant.system;
	if (!system || typeof system !== 'object') return null;
	return system as NimbleCombatantSystem;
}

function normalizeNonNegativeInteger(value: unknown): number {
	const normalized = Number(value ?? 0);
	if (!Number.isFinite(normalized)) return 0;
	return Math.max(0, Math.trunc(normalized));
}

export function getCombatantBaseActions(combatant: Combatant.Implementation): CombatantBaseActions {
	const actions = getCombatantSystem(combatant)?.actions?.base;
	return {
		current: normalizeNonNegativeInteger(actions?.current),
		max: normalizeNonNegativeInteger(actions?.max),
	};
}

export function getCombatantBonusActions(combatant: Combatant.Implementation): number {
	const actions = getCombatantSystem(combatant)?.actions?.base;
	return normalizeNonNegativeInteger((actions as { bonus?: unknown } | undefined)?.bonus);
}

export function getCombatantEffectiveMax(combatant: Combatant.Implementation): number {
	return getCombatantBaseActionMax(combatant) + getCombatantBonusActions(combatant);
}

export function getCombatantBaseActionCurrent(combatant: Combatant.Implementation): number {
	return getCombatantBaseActions(combatant).current;
}

export function getCombatantBaseActionMax(combatant: Combatant.Implementation): number {
	return getCombatantBaseActions(combatant).max;
}

export function getCombatantManualSortValue(combatant: Combatant.Implementation): number {
	return Number(getCombatantSystem(combatant)?.sort ?? 0);
}

export function getCombatantPipTypes(combatant: Combatant.Implementation): ActionType[] {
	const base = getCombatantSystem(combatant)?.actions?.base as
		| { pipType0?: unknown; pipType1?: unknown; pipType2?: unknown }
		| undefined;
	if (!base) return ['standard', 'standard', 'standard'];

	const raw0 = base.pipType0;
	const raw1 = base.pipType1;
	const raw2 = base.pipType2;

	return [
		isValidActionType(raw0) ? raw0 : 'standard',
		isValidActionType(raw1) ? raw1 : 'standard',
		isValidActionType(raw2) ? raw2 : 'standard',
	];
}
