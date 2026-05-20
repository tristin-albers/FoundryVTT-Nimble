import { SYSTEM_ID } from '#system';

export const COMBAT_READINESS_ENABLED_SETTING_KEY = 'combatReadinessEnabled';
export const BANE_INSPIRED_ACTIONS_ENABLED_SETTING_KEY = 'baneInspiredActionsEnabled';

export function registerCombatReadinessSettings(): void {
	game.settings.register(
		SYSTEM_ID as 'core',
		COMBAT_READINESS_ENABLED_SETTING_KEY as 'rollMode',
		{
			name: 'NIMBLE.settings.combatReadiness.name',
			hint: 'NIMBLE.settings.combatReadiness.hint',
			scope: 'world',
			config: true,
			type: Boolean,
			default: false,
			requiresReload: true,
		} as unknown as Parameters<typeof game.settings.register>[2],
	);

	game.settings.register(
		SYSTEM_ID as 'core',
		BANE_INSPIRED_ACTIONS_ENABLED_SETTING_KEY as 'rollMode',
		{
			name: 'NIMBLE.settings.baneInspiredActions.name',
			hint: 'NIMBLE.settings.baneInspiredActions.hint',
			scope: 'world',
			config: true,
			type: Boolean,
			default: false,
			requiresReload: true,
		} as unknown as Parameters<typeof game.settings.register>[2],
	);
}

export function isCombatReadinessEnabled(): boolean {
	const settings = game.settings?.settings as { has: (key: string) => boolean } | undefined;
	if (!settings?.has(`${SYSTEM_ID}.${COMBAT_READINESS_ENABLED_SETTING_KEY}`)) return false;
	return Boolean(
		game.settings.get(SYSTEM_ID as 'core', COMBAT_READINESS_ENABLED_SETTING_KEY as 'rollMode'),
	);
}

export function isBaneInspiredActionsEnabled(): boolean {
	if (!isCombatReadinessEnabled()) return false;
	const settings = game.settings?.settings as { has: (key: string) => boolean } | undefined;
	if (!settings?.has(`${SYSTEM_ID}.${BANE_INSPIRED_ACTIONS_ENABLED_SETTING_KEY}`)) return false;
	return Boolean(
		game.settings.get(SYSTEM_ID as 'core', BANE_INSPIRED_ACTIONS_ENABLED_SETTING_KEY as 'rollMode'),
	);
}
